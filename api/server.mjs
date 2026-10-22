// LAVA API and static web server. No npm dependencies.
//
//   GET    /api/health                  "ok"
//   GET    /api/config                  the public part of lava.config.json (app name, people, links, theme)
//   GET    /api/board                   <data>/board.json as written by the collector; {"waiting":true} until then
//   POST   /api/answers                 {questionId, who, kind: accept|answer, text} -> 201 record (appended to answers.jsonl)
//   GET    /api/answers?questionId=     the answers already sent (all, when no questionId)
//   GET    /api/vapid                   {publicKey}
//   POST   /api/subscriptions           {endpoint, keys{p256dh,auth}, who} (keyed by endpoint: every device kept)
//   DELETE /api/subscriptions           {endpoint} (or ?endpoint=)
//   Any route with ?test=1 (or LAVA_TEST=1) uses <data>/test/ and the identity "Test".
//   Everything else: the static app in web/.
//
// There is NO sign-in. "who" is chosen by the person in the app and only checked against the configured
// names. Put LAVA behind an access layer (Cloudflare Access, an SSO proxy, or at least basic auth).
//
// Every 10 s the outbox <data>/push-outbox.jsonl is read from <data>/push-outbox.offset and each new
// line is sent to every subscription.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, publicConfig } from './config.mjs';
import { file, dir, readJson, writeJsonAtomic, loadSubs, saveSubs, sendToAll, MAX_SUBS, DATA, ENV_TEST } from './store.mjs';
import { vapidFromEnv } from './push.mjs';

const PREFIX = '/api/';
const MAX_BODY = 8 * 1024;
const MAX_TEXT = 2000;
const POSTS_PER_MIN = 30;
const WHO = new Set(config.people.map((p) => p.name));
const KINDS = new Set(['accept', 'answer']);
const WEB = path.resolve(config.webDir);

const isTest = (url) => ENV_TEST || url.searchParams.get('test') === '1';
const log = (...a) => console.log(new Date().toISOString(), ...a);

function send(res, status, body, extra = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Content-Length': Buffer.byteLength(data),
    ...extra,
  });
  res.end(data);
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('body is not JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// One shared window: at most 30 writes a minute in all (answers and subscriptions).
let posts = [];
function rateLimited() {
  const now = Date.now();
  posts = posts.filter((t) => now - t < 60_000);
  if (posts.length >= POSTS_PER_MIN) return true;
  posts.push(now);
  return false;
}

// answers.jsonl is append-only: nothing in this code rewrites, truncates or deletes it.
function readAnswers(test) {
  let text = '';
  try { text = fs.readFileSync(file('answers.jsonl', test), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return out;
}

function openItems() {
  const b = readJson('board.json', {}, false);
  return new Map((Array.isArray(b.needsYou) ? b.needsYou : []).filter((q) => q && q.id).map((q) => [String(q.id), q]));
}

async function postAnswer(req, res, test) {
  const b = await readBody(req);
  const questionId = typeof b.questionId === 'string' ? b.questionId.trim() : '';
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const item = questionId ? openItems().get(questionId) : null;
  if (!item) return send(res, 422, { error: 'unknown questionId' });
  if (test) b.who = 'Test';
  else if (!WHO.has(b.who)) return send(res, 422, { error: 'who must be one of the configured people' });
  if (!KINDS.has(b.kind)) return send(res, 422, { error: 'kind must be accept or answer' });
  // An item may name the only person who can accept it (for example a go for a risky change).
  if (!test && item.onlyWho && b.kind === 'accept' && b.who !== item.onlyWho) return send(res, 422, { error: `only ${item.onlyWho} can accept this` });
  if (b.kind === 'answer' && !text) return send(res, 422, { error: 'an answer needs text' });
  if (text.length > MAX_TEXT) return send(res, 422, { error: `text over ${MAX_TEXT} characters` });
  const rec = { id: `ans-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, questionId, who: b.who, kind: b.kind, text, at: new Date().toISOString() };
  fs.mkdirSync(dir(test), { recursive: true });
  fs.appendFileSync(file('answers.jsonl', test), JSON.stringify(rec) + '\n', { mode: 0o600 });
  log(`answer ${rec.id} to ${questionId} by ${rec.who} (${rec.kind})`);
  return send(res, 201, rec);
}

function validSubscription(b, test) {
  if (!b || typeof b.endpoint !== 'string' || b.endpoint.length > 1024) return null;
  let u;
  try { u = new URL(b.endpoint); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const k = b.keys || {};
  const ok = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(s) && s.length >= min && s.length <= max;
  if (!ok(k.p256dh, 80, 100) || !ok(k.auth, 16, 32)) return null;
  return { endpoint: b.endpoint, keys: { p256dh: k.p256dh.replace(/=+$/, ''), auth: k.auth.replace(/=+$/, '') }, who: test ? 'Test' : (WHO.has(b.who) ? b.who : null), at: new Date().toISOString() };
}

async function postSubscription(req, res, test) {
  const sub = validSubscription(await readBody(req), test);
  if (!sub) return send(res, 422, { error: 'endpoint must be https and keys must hold p256dh and auth' });
  let subs = loadSubs(test).filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  if (subs.length > MAX_SUBS) subs = subs.slice(-MAX_SUBS); // the oldest goes
  saveSubs(subs, test);
  log(`subscription added for ${sub.who || 'unknown'} (${new URL(sub.endpoint).host}); ${subs.length} in all`);
  return send(res, 201, { ok: true, count: subs.length });
}

async function deleteSubscription(req, res, url, test) {
  const b = await readBody(req).catch(() => ({}));
  const endpoint = (b && b.endpoint) || url.searchParams.get('endpoint');
  if (!endpoint) return send(res, 422, { error: 'endpoint required' });
  const subs = loadSubs(test);
  const left = subs.filter((s) => s.endpoint !== endpoint);
  if (left.length === subs.length) return send(res, 404, { error: 'not subscribed' });
  saveSubs(left, test);
  return send(res, 200, { ok: true, count: left.length });
}

// ---- static app --------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad path' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(WEB, '.' + rel);
  if (abs !== WEB && !abs.startsWith(WEB + path.sep)) return send(res, 404, 'not found\n');
  let st;
  try { st = fs.statSync(abs); } catch { return send(res, 404, 'not found\n'); }
  if (!st.isFile()) return send(res, 404, 'not found\n');
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  // The shell and the service worker must be revalidated, or a release is held back on phones.
  const cache = ['.html', '.js', '.css', '.json', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=604800';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, ...SECURITY,
    ...(base === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

const ROUTES = ['health', 'config', 'board', 'answers', 'subscriptions', 'vapid'];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://lava');
    if (!url.pathname.startsWith(PREFIX)) return serveStatic(req, res, url);
    const route = url.pathname.slice(PREFIX.length).replace(/\/$/, '');
    const m = req.method;
    if (route === 'health' && m === 'GET') return send(res, 200, 'ok\n');
    if (route === 'config' && m === 'GET') return send(res, 200, publicConfig());
    if (route === 'board' && m === 'GET') {
      let text;
      try { text = fs.readFileSync(file('board.json', false), 'utf8'); } catch { return send(res, 200, { waiting: true }); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform' });
      return res.end(text);
    }
    if (route === 'vapid' && m === 'GET') {
      const v = vapidFromEnv();
      return v ? send(res, 200, { publicKey: v.publicKey }) : send(res, 503, { error: 'push is not set up (LAVA_VAPID_PUBLIC/PRIVATE)' });
    }
    if (route === 'answers' && m === 'GET') {
      const q = url.searchParams.get('questionId');
      const all = readAnswers(isTest(url));
      return send(res, 200, q ? all.filter((a) => a.questionId === q) : all);
    }
    if ((route === 'answers' || route === 'subscriptions') && (m === 'POST' || m === 'DELETE')) {
      if (rateLimited()) return send(res, 429, { error: 'too many posts; try again in a minute' }, { 'Retry-After': '60' });
      if (route === 'answers' && m === 'POST') return await postAnswer(req, res, isTest(url));
      if (route === 'subscriptions' && m === 'POST') return await postSubscription(req, res, isTest(url));
      if (route === 'subscriptions' && m === 'DELETE') return await deleteSubscription(req, res, url, isTest(url));
    }
    return send(res, ROUTES.includes(route) ? 405 : 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    if (!e.status) log('error:', e.stack || e.message);
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.listen(config.port, '0.0.0.0', () => log(`${config.appName} on :${config.port}, data in ${DATA}, ${config.people.length} people, push ${vapidFromEnv() ? 'on' : 'off (no VAPID keys)'}`));

// ---- push outbox ----------------------------------------------------------------------
let busy = false;
async function drainOutbox() {
  if (busy) return;
  busy = true;
  try {
    let size;
    try { size = fs.statSync(file('push-outbox.jsonl')).size; } catch { return; }
    let offset = Number(readJson('push-outbox.offset', 0)) || 0;
    if (offset > size) offset = 0; // the outbox was truncated or replaced
    if (offset === size) return;
    const fd = fs.openSync(file('push-outbox.jsonl'), 'r');
    const len = Math.min(size - offset, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    const end = buf.lastIndexOf(0x0a); // only whole lines
    if (end < 0) return;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('outbox: skipped a line that is not JSON'); continue; }
      const r = await sendToAll(msg, log);
      log(`outbox: "${String(msg.title || '').slice(0, 60)}" sent ${r.sent}, failed ${r.failed}, dropped ${r.dropped}`);
    }
    writeJsonAtomic('push-outbox.offset', offset + end + 1);
  } catch (e) {
    log('outbox error:', e.message);
  } finally {
    busy = false;
  }
}
setInterval(drainOutbox, 10_000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
