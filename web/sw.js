// LAVA service worker. Scope "/". The shell is cache-first; /api/ and everything else pass through;
// /api/board is network-first with the last copy as the offline fallback.
const VERSION = 'lava-v1';
const SHELL = [
  '/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/badge-96.png',
  '/fonts/geist-mono-latin-wght-normal.woff2',
  '/fonts/unbounded/unbounded-latin-wght-normal.woff2', '/fonts/unbounded/manrope-latin-wght-normal.woff2',
  '/fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2',
  '/fonts/zilla-slab/zilla-slab-latin-600-normal.woff2', '/fonts/zilla-slab/zilla-slab-latin-700-normal.woff2',
  '/fonts/zilla-slab/ibm-plex-sans-latin-400-normal.woff2', '/fonts/zilla-slab/ibm-plex-sans-latin-500-normal.woff2', '/fonts/zilla-slab/ibm-plex-sans-latin-600-normal.woff2',
];
const DATA = 'lava-data';
const BOARD = '/api/board';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('lava-v') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === BOARD) { e.respondWith(boardFirst(req)); return; }
  if (url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Only "/" (with any hash or query) is the app.
    if (url.pathname === '/' || url.pathname === '/index.html') e.respondWith(shell('/', req));
    return;
  }
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) e.respondWith(shell(url.pathname, req));
});

async function shell(key, req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(key);
  // A proxy may add a browser max-age to .js/.css; revalidate so a release is not held back.
  const net = fetch(req, { cache: 'no-cache' }).then((r) => { if (r.ok && r.type === 'basic') c.put(key, r.clone()); return r; }).catch(() => null);
  if (hit) { net.catch(() => {}); return hit; } // cache-first, refreshed in the background
  return (await net) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
}

async function boardFirst(req) {
  const c = await caches.open(DATA);
  try {
    const r = await fetch(req, { cache: 'no-store' });
    if (r.ok && !new URL(req.url).searchParams.has('test')) c.put(BOARD, r.clone()); // test-mode previews are never cached
    return r;
  } catch {
    const hit = await c.match(BOARD);
    if (!hit) return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const h = new Headers(hit.headers); h.set('x-lava-cache', '1');
    return new Response(await hit.blob(), { status: 200, headers: h });
  }
}

// ---------- push ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const url = d.url || (d.questionId ? '/#needs/' + encodeURIComponent(d.questionId) : '/');
  const actions = Array.isArray(d.actions) ? d.actions.slice(0, 2)
    : d.questionId ? [{ action: 'accept', title: 'Accept suggestion' }, { action: 'open', title: 'Answer' }] : [];
  e.waitUntil(self.registration.showNotification(d.title || 'LAVA', {
    body: d.body || '', tag: d.tag || d.questionId || undefined, renotify: !!d.tag,
    icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
    data: { url, questionId: d.questionId || null, suggestion: d.suggestion || '', kind: d.kind || 'question' },
    actions,
  }));
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification; const data = n.data || {};
  n.close();
  if ((e.action === 'accept' || e.action === 'notyet') && data.questionId) { e.waitUntil(acceptFromNotification(data, e.action === 'notyet')); return; }
  e.waitUntil(openApp(data.url || '/'));
});

async function who() {
  try { const r = await (await caches.open('lava-meta')).match('/__meta/who'); return r ? (await r.text()) : null; } catch { return null; }
}
async function acceptFromNotification(data, notYet) {
  const w = await who();
  if (!w) return openApp('/#needs/' + encodeURIComponent(data.questionId)); // the app asks who is answering
  const body = notYet ? { questionId: data.questionId, who: w, kind: 'answer', text: 'NOT YET' } : { questionId: data.questionId, who: w, kind: 'accept', text: data.suggestion || 'Accepted' };
  let ok = false, rec = null;
  try {
    const r = await fetch('/api/answers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    ok = r.ok; rec = ok ? await r.json().catch(() => null) : null;
  } catch { ok = false; }
  if (ok) {
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'answered', questionId: data.questionId, record: rec || { ...body, at: new Date().toISOString() } });
    return self.registration.showNotification('Sent', { body: w + ' sent ' + (notYet ? 'NOT YET' : data.kind === 'review' ? 'APPROVED' : data.kind === 'go' ? 'START' : 'an acceptance') + ' for ' + data.questionId + '. It will be recorded.',
      tag: 'sent-' + data.questionId, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: '/#needs/' + encodeURIComponent(data.questionId) } });
  }
  return self.registration.showNotification('Not sent', { body: 'Could not send your answer to ' + data.questionId + '. Tap to try in the app.',
    tag: 'fail-' + data.questionId, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: '/#needs/' + encodeURIComponent(data.questionId) } });
}
async function openApp(url) {
  const target = new URL(url, location.origin).href;
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    if (new URL(c.url).origin === location.origin && 'focus' in c) { await c.focus(); if ('navigate' in c) return c.navigate(target).catch(() => c); return c; }
  }
  return self.clients.openWindow(target);
}
