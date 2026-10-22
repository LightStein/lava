// Files in the data directory (LAVA_DATA), shared by the server, the outbox sender, send.mjs and the collector.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sendPush, vapidFromEnv } from './push.mjs';
import { config } from './config.mjs';

export const DATA = config.dataDir;
export const TEST_DIR = path.join(DATA, 'test');   // test mode (LAVA_TEST=1 or ?test=1): separate files, identity "Test"
export const ENV_TEST = config.test;
export const dir = (test = ENV_TEST) => (test ? TEST_DIR : DATA);
export const file = (name, test = ENV_TEST) => path.join(dir(test), name);
export const MAX_SUBS = 200; // keyed by endpoint: every device is kept; only the same endpoint is replaced

export function readJson(name, fallback, test) {
  try { return JSON.parse(fs.readFileSync(file(name, test), 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(name, value, test) {
  fs.mkdirSync(dir(test), { recursive: true });
  const tmp = file(`.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`, test);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file(name, test));
}

// Shape is a flat array of {endpoint, keys, who, at}; identity is per endpoint, never per person.
export const loadSubs = (test) => {
  const s = readJson('subscriptions.json', [], test);
  return Array.isArray(s) ? s.filter((x) => x && typeof x.endpoint === 'string') : [];
};
export const saveSubs = (subs, test) => writeJsonAtomic('subscriptions.json', subs, test);

// Sends one message to every subscription; drops the ones the push service says are gone.
export async function sendToAll(msg, log = console.log, test) {
  const vapid = vapidFromEnv();
  if (!vapid) { log('push: no VAPID keys (LAVA_VAPID_PUBLIC/PRIVATE); nothing sent'); return { sent: 0, failed: 0, dropped: 0 }; }
  const subs = loadSubs(test);
  const gone = new Set();
  let sent = 0, failed = 0;
  const payload = {
    title: String(msg.title || config.appName).slice(0, 120),
    body: String(msg.body || '').slice(0, 600),
    url: typeof msg.url === 'string' && msg.url.startsWith('/') ? msg.url : '/',
    tag: msg.tag ? String(msg.tag).slice(0, 64) : undefined,
    actions: Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : undefined,
    questionId: msg.questionId ? String(msg.questionId).slice(0, 64) : undefined,
    kind: ['review', 'go', 'question'].includes(msg.kind) ? msg.kind : undefined,
    suggestion: msg.suggestion ? String(msg.suggestion).slice(0, 1500) : undefined,
  };
  for (const sub of subs) {
    try {
      const { status } = await sendPush(sub, payload, vapid, { topic: payload.tag });
      if (status === 404 || status === 410) gone.add(sub.endpoint);
      else if (status >= 200 && status < 300) sent++;
      else { failed++; log(`push: ${new URL(sub.endpoint).host} answered ${status}`); }
    } catch (e) {
      failed++;
      log(`push: ${safeHost(sub.endpoint)} failed: ${e.message}`);
    }
  }
  if (gone.size) saveSubs(loadSubs(test).filter((s) => !gone.has(s.endpoint)), test);
  return { sent, failed, dropped: gone.size };
}

const safeHost = (u) => { try { return new URL(u).host; } catch { return '?'; } };
