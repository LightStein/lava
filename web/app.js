// LAVA web app. Plain ES module, no dependencies, no build step. Reads /api/config and /api/board; every field is optional.
const API = '/api';
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');

// ---------- storage (every access guarded: private windows can throw) ----------
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('lava.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lava.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- state ----------
const state = {
  data: null, source: 'none', loadedAt: 0, loading: false, error: '',
  sent: store.get('sent', {}), // questionId -> [{kind,text,who,at}]
  server: {}, // questionId -> answers from the API
  open: new Set(), drafts: {}, busy: new Set(),
  boardTab: store.get('boardTab', 'in-dev'),
  installEvt: null, push: 'unknown',
};
const sampleMode = new URLSearchParams(location.search).has('sample');
// Test mode (?test=1): answers and subscriptions go to the data directory's test/ folder, as "Test".
const testMode = new URLSearchParams(location.search).get('test') === '1';
const T = testMode ? '?test=1' : '';

// ---------- config (GET /api/config; with ?sample, sample/config.json) ----------
let CFG = { appName: 'LAVA', people: [], links: [], theme: {} };
async function loadConfig() {
  const urls = sampleMode ? [API + '/config', '/sample/config.json'] : [API + '/config'];
  for (const u of urls) {
    try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) { CFG = { ...CFG, ...(await r.json()) }; break; } } catch { /* offline */ }
  }
  TITLES.home = CFG.appName || 'LAVA';
  const b = document.getElementById('page-title'); if (b) b.textContent = TITLES.home;
  const t = CFG.theme || {}, css = [];
  if (t.accentLight) css.push(':root{--accent:' + t.accentLight + ';--focus:' + t.accentLight + '}');
  if (t.accentDark) css.push(':root[data-theme="dark"]{--accent:' + t.accentDark + ';--focus:' + t.accentDark + '}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--accent:' + t.accentDark + ';--focus:' + t.accentDark + '}}');
  if (css.length) document.head.append(h('style', { text: css.join('\n') }));
}
const peopleNames = () => (Array.isArray(CFG.people) ? CFG.people : []).map((p) => p.name).filter(Boolean);

// ---------- small DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with static SVG strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', play: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  circle: '<circle cx="12" cy="12" r="8"/>', minus: '<path d="M6 12h12"/>', alert: '<path d="M12 4l9 16H3zM12 10v4m0 3v.5"/>',
  chev: '<path d="M9 6l6 6-6 6"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>', bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20h4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', down: '<path d="M12 4v12m-5-5l5 5 5-5M5 20h14"/>',
};
const icon = (n) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[n] || ''; return s; };

// ---------- formatting ----------
const STATUS = {
  pass: ['Passed', 'check'], done: ['Done', 'check'], fail: ['Failed', 'x'], failing: ['Failing', 'x'],
  running: ['Running', 'play'], 'in-progress': ['In progress', 'play'], 'in-dev': ['In dev', 'play'],
  pending: ['Not started', 'circle'], planned: ['Planned', 'circle'], draft: ['Draft', 'circle'], ready: ['Ready', 'circle'], approved: ['Approved', 'check'],
  skipped: ['Skipped', 'minus'], 'not-covered': ['Not covered', 'alert'], waiting: ['Waiting', 'clock'],
};
function badge(status, label) {
  const s = String(status || 'unknown').toLowerCase().replace(/\s+/g, '-');
  const [word, ic] = STATUS[s] || [status ? String(status) : 'Unknown', 'circle'];
  return h('span', { class: 'badge st-' + (STATUS[s] ? s : 'unknown') }, icon(ic), label || word);
}
function dur(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + ' s';
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' min';
  const hh = Math.floor(m / 60), mm = m % 60;
  return hh + ' h' + (mm ? ' ' + mm + ' min' : '');
}
function ago(iso) {
  const t = Date.parse(iso); if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago';
}
function when(iso) {
  const t = Date.parse(iso); if (!t) return '';
  return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function day(v) {
  const t = Date.parse(v); if (!t) return v || '–';
  return new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
const short = (b) => (b ? String(b).replace(/-dirty$/, '').slice(0, 12) : '–');
const usd = (n) => '$' + (Number(n) || 0).toFixed(2);
function tokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
  if (n >= 1e6) return Math.round(n / 1e6) + ' M';
  if (n >= 1e3) return Math.round(n / 1e3) + ' k';
  return String(n);
}
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
function barEl(p, cls = '') { const i = h('i'); i.style.width = p.toFixed(1) + '%'; return h('div', { class: 'bar ' + cls, role: 'presentation' }, i); }
const arr = (v) => (Array.isArray(v) ? v : []);

// ---------- toast ----------
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); }

// ---------- who is answering ----------
function who() { return store.get('who', null); }
async function setWho(w) {
  store.set('who', w);
  try { const c = await caches.open('lava-meta'); await c.put('/__meta/who', new Response(w)); } catch { /* ignore */ }
  if (state.push === 'on') subscribePush(true).catch(() => {});
}
function askWho() {
  return new Promise((resolve) => {
    const pick = (w) => async () => { await setWho(w); closeSheet(); resolve(w); };
    openSheet('Who is answering?', [
      h('p', { class: 'muted', text: 'Asked once. You can change it under More.' }),
      peopleNames().length ? h('div', { class: 'btns' }, peopleNames().map((n, i) =>
        h('button', { class: 'btn primary', type: 'button', 'data-testid': 'who-' + i, onclick: pick(n) }, n)))
        : h('p', { class: 'small', text: 'No people are configured yet (people in lava.config.json).' }),
    ], () => resolve(null));
  });
}
async function ensureWho() { return who() || (await askWho()); }

// ---------- sheet ----------
let sheetOnClose = null;
function openSheet(title, body, onClose) {
  const d = $('#sheet');
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(...[body].flat(Infinity).filter(Boolean));
  sheetOnClose = onClose || null;
  if (!d.open) d.showModal();
}
function closeSheet() { const d = $('#sheet'); if (d.open) d.close(); }
$('#sheet').addEventListener('close', () => {
  const cb = sheetOnClose; sheetOnClose = null; if (cb) cb();
  if (/^#board\//.test(location.hash)) history.replaceState(null, '', '#board');
});
$('#sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) closeSheet(); });

// ---------- data ----------
async function load(force) {
  if (state.loading) return;
  state.loading = true; renderFresh();
  let data = null, source = 'none', err = '';
  try {
    const r = await fetch(API + '/board' + T, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json(); source = r.headers.get('x-lava-cache') ? 'cache' : 'live';
  } catch (e) {
    err = String(e.message || e);
    if (sampleMode) {
      try { const r = await fetch('/sample/board.json', { cache: 'no-store' }); if (r.ok) { data = await r.json(); source = 'sample'; } } catch { /* ignore */ }
    }
  }
  const changed = force || !state.data || !data || data.generatedAt !== state.data.generatedAt || source !== state.source;
  if (data || !state.data) { state.data = data; state.source = source; }
  state.error = err; state.loading = false; state.loadedAt = Date.now();
  await loadAnswers();
  if (changed) render(); else renderFresh();
}
async function loadAnswers() {
  const items = arr(state.data?.needsYou);
  if (state.source === 'sample') return;
  await Promise.all(items.slice(0, 20).map(async (q) => {
    try {
      const r = await fetch(API + '/answers?questionId=' + encodeURIComponent(q.id) + (testMode ? '&test=1' : ''), { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); state.server[q.id] = Array.isArray(j) ? j : arr(j.answers); }
    } catch { /* offline: keep what we have */ }
  }));
}
function answersFor(id) {
  const local = arr(state.sent[id]);
  const server = arr(state.server[id]);
  const seen = new Set(server.map((a) => a.at + a.kind + a.text));
  return [...server, ...local.filter((a) => !seen.has(a.at + a.kind + a.text))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
const isSent = (q) => q.answeredLocally || answersFor(q.id).length > 0;

async function sendAnswer(q, kind, text) {
  const w = await ensureWho(); if (!w) return;
  if (kind === 'answer' && !text.trim()) { toast('Write an answer first.'); return; }
  state.busy.add(q.id); render();
  const body = { questionId: q.id, who: w, kind, text: kind === 'accept' ? (q.kind === 'review' ? 'APPROVED' : q.kind === 'go' ? 'START' : (q.suggestion || 'Accepted')) : text.trim().slice(0, 2000) };
  if (kind === 'answer' && q.kind === 'review' && !/^(NOT YET|COMMENT)/.test(body.text)) body.text = 'COMMENT: ' + body.text;
  try {
    if (state.source === 'sample') throw new Error('sample');
    const r = await fetch(API + '/answers' + T, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) throw new Error('Too many answers in a minute. Try again shortly.');
    if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch { /* ignore */ } throw new Error(m || 'The server refused it (' + r.status + ').'); }
    const rec = await r.json().catch(() => ({ ...body, at: new Date().toISOString() }));
    const list = arr(state.sent[q.id]); list.push({ kind: rec.kind || kind, text: rec.text ?? body.text, who: rec.who || w, at: rec.at || new Date().toISOString() });
    state.sent[q.id] = list; store.set('sent', state.sent);
    state.open.delete(q.id); delete state.drafts[q.id];
    toast('Sent. It will be recorded.');
  } catch (e) {
    toast(e.message === 'sample' ? 'Sample data: nothing was sent.' : navigator.onLine ? e.message : 'You are offline. Try again when connected.');
  } finally { state.busy.delete(q.id); render(); }
}

// ---------- views ----------
function waiting() {
  return h('div', { class: 'card empty', 'data-testid': 'waiting' }, icon('clock'),
    h('p', { class: 'h2', text: 'Waiting for data' }),
    h('p', { class: 'small', text: state.error ? 'The board is not available yet (' + state.error + '). It refreshes on its own.' : 'The board is not available yet. It refreshes on its own.' }));
}

function nowCard(d) {
  const n = d.now || {};
  return h('section', { class: 'card', 'data-testid': 'now-card', 'aria-labelledby': 'now-h' },
    h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', id: 'now-h', text: 'Now' })),
    h('div', { class: 'stack' },
      h('p', { class: 'title', text: n.title || n.increment || 'Now' }),
      n.theme ? h('p', { class: 'h2', text: n.theme }) : null,
      n.stepper ? null : h('p', { class: 'muted', text: n.status || 'Status not known yet' })),
    n.stepper ? stepper(n.stepper) : null,
    n.stepper ? nextLine(n.stepper) : null,
    h('dl', { class: 'kv' },
      h('dt', { text: 'ETA' }), h('dd', { text: n.eta ? day(n.eta) : '–' }),
      arr(n.environments).slice(0, 4).map((e) => [h('dt', { text: e.name || 'Environment' }),
        h('dd', {}, h('span', { class: 'mono', text: short(e.build) }), e.at ? h('div', { class: 'small muted', text: ago(e.at) }) : null)])),
    n.liveNow ? h('p', { class: 'small live-now', 'data-testid': 'live-now', text: 'Live now: ' + short(n.liveNow.build) + ' \u2014 ' + n.liveNow.what }) : null);
}

const PURPOSE = { nightly: 'Nightly full gate', 'release-gate': 'Release gate', 'qa-environment': 'QA environment', 'quick-check': 'Quick check', screenshots: 'Screenshots', beta: 'Beta', playground: 'Playground' };
const purposeTag = (p) => (p ? h('span', { class: 'tag tag-' + p, text: PURPOSE[p] || p }) : null);
// An optional tierLabel on a run (for example "Full gate" or "Affected gate, 12 of 80 specs")
const tierTag = (r) => (r && r.tierLabel ? h('span', { class: 'small muted', 'data-testid': 'gate-tier', text: ' \u00b7 ' + r.tierLabel }) : null);
// The optional nightly card: the last nightly run on the live build (pass, failed, not needed, skipped)
function nightlyCard(d) {
  const n = d.nightly; if (!n) return null;
  const st = n.result === 'pass' || n.result === 'not-needed' ? 'pass' : n.result === 'fail' ? 'fail' : 'skipped';
  const inner = [
    h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Nightly full gate' }), badge(st, n.result === 'not-needed' ? 'Not needed' : null)),
    h('p', {}, h('strong', { text: n.label || 'Nightly' }), h('span', { class: 'small muted', text: (n.build ? '  ·  ' + short(n.build) : '') + (n.at ? '  ·  ' + ago(n.at) : '') })),
    n.reason ? h('p', { class: 'small muted', text: n.reason }) : null,
    n.firstFailure ? h('p', { class: 'small owner', text: 'First failure: ' + n.firstFailure }) : null,
    n.blocked ? h('p', { class: 'small owner', 'data-testid': 'nightly-block', text: 'Promotion is blocked until a nightly run passes.' }) : null];
  return n.reportUrl && n.result !== 'not-needed'
    ? h('a', { class: 'card', href: n.reportUrl, 'data-testid': 'nightly-card', style: { textDecoration: 'none', color: 'inherit' } }, inner)
    : h('section', { class: 'card', 'data-testid': 'nightly-card' }, inner);
}
const clock = (iso) => { const t = Date.parse(iso); return t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''; };
function nextLine(sp) {
  const nx = sp && sp.next; if (!nx) return null;
  const eta = nx.etaAt ? 'about ' + clock(nx.etaAt) : nx.basis ? 'taking longer than usual' : 'no estimate yet';
  return h('p', { class: 'small next', 'data-testid': 'next-stage' }, h('strong', { text: 'Next: ' + nx.stage }), ' \u00b7 ' + eta + (nx.basis ? ' (' + nx.basis + ')' : ''));
}
function workingCard(d) {
  const list = arr(d.agents && d.agents.now);
  return h('section', { class: 'card', 'data-testid': 'now-working', 'aria-labelledby': 'nw-h' },
    h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', id: 'nw-h', text: 'Now working' }), h('span', { class: 'small muted', text: list.length ? list.length + ' agent' + (list.length > 1 ? 's' : '') : '' })),
    list.length ? h('ul', { class: 'plain' }, list.map((a) => h('li', { class: 'agentrow' },
      h('span', { class: 'stack' }, h('span', { class: 'mono', text: a.label }),
        h('span', { class: 'small muted', text: [a.role, a.workflow, 'since ' + clock(a.startedAt)].filter(Boolean).join(' \u00b7 ') })),
      badge(a.state === 'working' ? 'running' : 'waiting', a.state === 'working' ? 'Working' : 'Quiet'))))
      : h('p', { class: 'muted', text: 'No agent is working right now.' }));
}
function timelineCard(d) {
  const ev = arr(d.timeline); if (!ev.length) return null;
  return h('section', { class: 'card', 'data-testid': 'timeline', 'aria-labelledby': 'tl-h' },
    h('span', { class: 'eyebrow', id: 'tl-h', text: 'Today' }),
    h('ol', { class: 'plain timeline' }, ev.map((e) => h('li', {},
      h('span', { class: 'mono small tl-time', text: e.at ? clock(e.at) : 'today' }),
      h('span', { class: 'tl-text' + (e.status === 'fail' ? ' bad' : ''), text: e.text })))));
}
function quickCard(d) {
  const q = arr(d.quick); if (!q.length) return null;
  return h('section', { class: 'card', 'data-testid': 'quick-runs' },
    h('span', { class: 'eyebrow', text: 'Quick checks (not a gate)' }),
    h('div', {}, q.slice(0, 6).map((r) => h('div', { class: 'qrow' },
      h('div', { class: 'card-head' }, h('span', { class: 'small', text: when(r.startedAt) }), badge(r.result === 'aborted' ? 'skipped' : r.result, r.result === 'aborted' ? 'Stopped' : null)),
      h('div', { class: 'small' }, purposeTag('quick-check'), ' ', r.passed != null ? r.passed + ' passed \u00b7 ' + r.failed + ' failed' : 'no results', ' \u00b7 ' + dur(r.seconds)),
      r.firstFailure ? h('div', { class: 'small owner', text: 'First failure: ' + (r.firstFailure.tc ? r.firstFailure.tc + ' ' : '') + r.firstFailure.test }) : null))));
}
function runList(d) {
  return h('div', {}, arr(d.runs).slice(0, 10).map((r) => h('div', { class: 'runrow' },
    h('span', { class: 'mono', text: short(r.build) }), badge(r.result === 'aborted' ? 'skipped' : r.result, r.result === 'aborted' ? 'Stopped' : null),
    h('span', { class: 'small muted', text: (r.startedAt ? when(r.startedAt) : '') + ' · ' + dur(r.seconds) }),
    h('span', { class: 'small' }, purposeTag(r.purpose), tierTag(r), r.failedStage ? ' at ' + r.failedStage : ''))));
}

function stepper(sp) {
  return h('ol', { class: 'stepper', 'data-testid': 'stage-stepper', 'aria-label': 'Stage of the current increment' },
    arr(sp.stages).map((name, i) => {
      const st = i < sp.index ? 'done' : i === sp.index ? 'current' : 'todo';
      return h('li', { class: 'step ' + st, ...(st === 'current' ? { 'aria-current': 'step' } : {}) },
        h('span', { class: 'dot', 'aria-hidden': 'true', text: st === 'done' ? '\u2713' : String(i + 1) }),
        h('div', {}, h('span', { class: 'sname', text: name }), h('span', { class: 'sr-only', text: st === 'done' ? ' (done)' : st === 'current' ? ' (now)' : ' (later)' }),
          st === 'current' && sp.note ? h('div', { class: 'small muted', text: sp.note }) : null));
    }));
}

function pipelineSummary(d) {
  const p = d.pipeline;
  if (!p) return h('section', { class: 'card' }, h('span', { class: 'eyebrow', text: 'Pipeline' }), h('p', { class: 'muted', text: 'No run yet.' }));
  const stages = arr(p.stages);
  const running = stages.find((s) => s.status === 'running');
  const doneN = stages.filter((s) => s.status === 'pass').length;
  const total = p.etaS || stages.reduce((a, s) => a + (s.expectedS || s.seconds || 0), 0);
  const seg = h('div', { class: 'segbar', role: 'img', 'aria-label': doneN + ' of ' + stages.length + ' stages passed' }, stages.map((s) => h('i', { class: s.status || '', title: s.name })));
  const line = p.state === 'running'
    ? dur(p.elapsedS) + ' of about ' + dur(total) + (running ? ' · ' + running.name + ' running' : '')
    : (p.state === 'pass' ? 'Passed in ' : 'Stopped after ') + dur(p.elapsedS ?? stages.reduce((a, s) => a + (s.seconds || 0), 0));
  return h('a', { class: 'card', href: '#runs', 'data-testid': 'pipeline-card', style: { textDecoration: 'none', color: 'inherit' } },
    h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'Pipeline' }), badge(p.state)),
    h('p', {}, purposeTag(p.purpose), tierTag(p), ' ', h('span', { class: 'mono', text: short(p.build) }), h('span', { class: 'muted small', text: p.startedAt ? '  ·  started ' + ago(p.startedAt) : '' })),
    seg,
    p.live ? h('p', { class: 'small', text: p.live.passed + ' passed · ' + p.live.failed + ' failed so far' }) : null,
    p.state === 'running' ? barEl(pct(p.elapsedS, total)) : null,
    h('div', { class: 'card-head' }, h('p', { class: 'small', text: line }), icon('chev')),
    arr(p.failures).length ? h('p', { class: 'owner', text: arr(p.failures).length + ' failure' + (arr(p.failures).length > 1 ? 's' : '') + ' so far' }) : null);
}

function spendCard(d) {
  const g = d.spend; if (!g || !Number.isFinite(Number(g.amount))) return null;
  const unit = g.unit || '$', money = (n) => unit + (Number(n) || 0).toFixed(2), cap = Number(g.cap) || 0, p = pct(Number(g.amount), cap);
  return h('section', { class: 'card', 'data-testid': 'spend-card' },
    h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: (g.label || 'Spend') + (g.period ? ' · ' + g.period : '') }), cap ? h('span', { class: 'small muted', text: Math.round(p) + '% of cap' }) : null),
    h('p', {}, h('span', { class: 'stat', text: money(g.amount) }), cap ? h('span', { class: 'muted', text: ' of ' + money(cap) }) : null),
    cap ? barEl(p, Number(g.amount) >= cap ? 'over' : p >= 75 ? 'warn' : '') : null);
}

function home(d) {
  const open = arr(d.needsYou).filter((q) => !isSent(q));
  const needs = h('section', { class: 'card', 'data-testid': 'needs-summary' },
    h('div', { class: 'card-head' }, h('span', { class: 'eyebrow', text: 'For you' }), h('span', { class: 'badge ' + (open.length ? 'st-waiting' : 'st-pass') }, icon(open.length ? 'clock' : 'check'), open.length ? open.length + ' waiting' : 'All clear')),
    open.length ? h('div', {}, open.slice(0, 2).map((q) => h('a', { class: 'linkrow', href: '#needs/' + encodeURIComponent(q.id) },
      h('span', { class: 'stack' }, h('span', { text: q.title || q.question || q.id }), h('span', { class: 'small muted', text: (q.who ? 'For ' + q.who + ' · ' : '') + (q.blocks ? 'Blocks ' + q.blocks : q.id) })), icon('chev'))))
      : h('p', { class: 'muted', text: 'Nothing needs you right now.' }),
    open.length > 2 ? h('a', { class: 'btn block', href: '#needs' }, 'See all ' + open.length) : null);
  const installCard = state.installEvt && !standalone() ? h('section', { class: 'card' },
    h('p', { class: 'h2', text: 'Install the app' }), h('p', { class: 'muted small', text: 'Open it from your home screen and get notified when someone needs you.' }),
    h('button', { class: 'btn primary', type: 'button', onclick: install, 'data-testid': 'install-home' }, icon('down'), 'Install')) : null;
  return [nowCard(d), workingCard(d), needs, pipelineSummary(d), nightlyCard(d), timelineCard(d), spendCard(d), installCard];
}

function linksEl(q) {
  const ls = arr(q.links).filter((l) => l && l.href);
  if (!ls.length) return null;
  return h('div', { class: 'links', 'data-testid': 'links' }, ls.map((l) => h('a', { class: 'linkrow', href: l.href, target: '_blank', rel: 'noopener' }, h('span', { text: l.label || l.href }), icon('ext'))));
}

function questionCard(q, focusId) {
  const sent = answersFor(q.id), busy = state.busy.has(q.id), isOpen = state.open.has(q.id);
  const meta = h('dl', { class: 'q-meta' },
    q.why ? [h('dt', { text: 'Why it matters' }), h('dd', { text: q.why })] : null,
    q.blocks ? [h('dt', { text: 'What it blocks' }), h('dd', { text: q.blocks })] : null);
  const card = h('article', { class: 'card' + (focusId === q.id ? ' target' : ''), id: 'q-' + q.id, 'data-testid': 'question', 'aria-labelledby': 'qh-' + q.id },
    h('div', { class: 'card-head' }, h('span', { class: 'mono muted', text: (q.kind === 'review' ? 'Review · ' : q.kind === 'go' ? 'Go · ' : '') + q.id }), q.who ? h('span', { class: 'who', text: 'For ' + q.who }) : null),
    h('p', { class: 'q', id: 'qh-' + q.id, text: q.question || '' }), sent.length && !isOpen ? null : meta,
    linksEl(q), q.suggestion && q.kind !== 'review' && q.kind !== 'go' && !(sent.length && !isOpen) ? h('div', { class: 'suggest' }, h('div', { class: 'eyebrow', text: 'Suggestion' }), h('p', { text: q.suggestion })) : null);
  if (sent.length || q.answeredLocally) {
    const last = sent[0];
    card.append(h('div', { class: 'stack' },
      badge('waiting', 'Sent, waiting to be recorded'),
      last ? h('p', { class: 'small' }, h('b', { text: (last.who || '') + (last.kind === 'accept' ? (q.kind === 'review' ? ' approved' : q.kind === 'go' ? ' said start' : ' accepted the suggestion') : ' answered') }), h('span', { class: 'muted', text: ' · ' + ago(last.at) })) : null,
      last && last.kind !== 'accept' ? h('p', { class: 'small', text: '“' + last.text + '”' }) : null));
  }
  if (isOpen) {
    const ta = h('textarea', { id: 'ta-' + q.id, maxlength: '2000', 'data-testid': 'answer-text', oninput: (e) => { state.drafts[q.id] = e.target.value; cnt.textContent = e.target.value.length + ' / 2000'; } });
    ta.value = state.drafts[q.id] || '';
    const cnt = h('span', { class: 'small muted', text: ta.value.length + ' / 2000' });
    card.append(h('div', { class: 'stack' }, h('div', { class: 'card-head' }, h('label', { class: 'lbl', for: 'ta-' + q.id, text: q.kind === 'review' ? 'Your comment' : 'Your answer' }), cnt), ta,
      h('div', { class: 'btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => { state.open.delete(q.id); render(); } }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', disabled: busy, 'data-testid': 'answer-send', onclick: () => sendAnswer(q, 'answer', state.drafts[q.id] || '') }, icon('send'), busy ? 'Sending…' : 'Send'))));
    queueMicrotask(() => ta.focus());
  } else {
    const openBox = async () => { if (await ensureWho()) { state.open.add(q.id); render(); } };
    const btn = (cls, tid, fn, label) => h('button', { class: 'btn ' + cls, type: 'button', disabled: busy, 'data-testid': tid, onclick: fn }, busy && cls === 'primary' ? 'Sending…' : label);
    if (q.onlyWho && who() !== q.onlyWho && !testMode) card.append(h('p', { class: 'small muted', 'data-testid': 'only-who', text: 'Waiting for ' + q.onlyWho + ': only ' + q.onlyWho + ' can accept this.' }),
      h('div', { class: 'btns' }, btn('', 'comment', openBox, 'Comment')));
    else if (q.kind === 'review') card.append(h('div', { class: 'btns' }, btn('primary', 'approve', () => sendAnswer(q, 'accept', ''), 'Approve'), btn('', 'comment', openBox, 'Comment')));
    else if (q.kind === 'go') card.append(h('div', { class: 'btns' }, btn('primary', 'start', () => sendAnswer(q, 'accept', ''), 'Start'), btn('', 'notyet', () => sendAnswer(q, 'answer', 'NOT YET'), 'Not yet')));
    else card.append(h('div', { class: 'btns' },
      q.suggestion && sent[0]?.kind !== 'accept' ? h('button', { class: 'btn primary', type: 'button', disabled: busy, 'data-testid': 'accept', onclick: () => sendAnswer(q, 'accept', '') }, busy ? 'Sending…' : sent.length ? 'Accept instead' : 'Accept suggestion') : null,
      h('button', { class: 'btn', type: 'button', disabled: busy, 'data-testid': 'answer', onclick: openBox }, sent.length ? 'Answer again' : 'Answer')));
  }
  return card;
}

// ---------- For you: history of closed requests ----------
const KIND_LABEL = { review: 'Review', go: 'Go', question: 'Question' };
const histTitle = (e) => e.title || (e.question ? e.question.slice(0, 90) + (e.question.length > 90 ? '…' : '') : e.id);
function answerEl(a) {
  return h('li', { class: 'h-ans' },
    h('div', { class: 'small muted', text: (a.who || 'Someone') + ' · ' + (when(a.at) || '–') }),
    h('p', { class: 'h-text', text: a.text || '' }));
}
function outcomeEl(e) {
  if (!e.decision) return h('p', { class: 'small muted', text: 'Outcome: not recorded yet' + (e.resolvedAt ? ' (closed ' + when(e.resolvedAt) + ')' : '') });
  return h('p', { class: 'small' }, h('span', { class: 'muted', text: 'Outcome: ' }),
    e.decisionUrl ? h('a', { href: e.decisionUrl, target: '_blank', rel: 'noopener', 'data-testid': 'history-decision' }, e.decision) : h('b', { text: e.decision }),
    e.resolvedAt ? h('span', { class: 'muted', text: ' · ' + when(e.resolvedAt) }) : null);
}
function historyMeta(e) {
  return h('div', { class: 'row h-meta' },
    h('span', { class: 'who', text: KIND_LABEL[e.kind] || 'Question' }),
    e.who ? h('span', { class: 'who', text: 'For ' + e.who }) : null,
    h('span', { class: 'small muted', text: e.sentAt ? 'Sent ' + when(e.sentAt) : 'Sent: unknown' }));
}
function historySheet(e) {
  openSheet(histTitle(e), [
    historyMeta(e),
    h('p', { class: 'mono small muted', text: e.id }),
    e.question ? h('section', { class: 'stack' }, h('h3', { class: 'section-title', text: 'What we asked' }),
      h('p', { class: 'h-text', text: e.question + (e.questionFull ? '' : ' …') }),
      e.questionFull ? null : h('p', { class: 'small muted', text: 'Only the notification text survives for this request.' }))
      : h('p', { class: 'muted', text: 'The original question text is no longer available.' }),
    e.why || e.blocks ? h('dl', { class: 'q-meta' },
      e.why ? [h('dt', { text: 'Why it mattered' }), h('dd', { text: e.why })] : null,
      e.blocks ? [h('dt', { text: 'What it blocked' }), h('dd', { text: e.blocks })] : null) : null,
    linksEl(e),
    h('h3', { class: 'section-title', text: 'Answers (' + arr(e.answers).length + ')' }),
    arr(e.answers).length ? h('ul', { class: 'h-answers' }, arr(e.answers).map(answerEl)) : h('p', { class: 'small muted', text: 'No answer in the app.' }),
    outcomeEl(e),
  ], () => {});
}
function historyEntry(e) {
  const art = h('article', { class: 'card h-entry', 'data-testid': 'history-entry', 'data-id': e.id,
    onclick: (ev) => { if (!ev.target.closest('a, button')) historySheet(e); } },
    h('button', { class: 'h-title', type: 'button', 'data-testid': 'history-open', onclick: () => historySheet(e) },
      h('span', { text: histTitle(e) }), icon('chev')),
    historyMeta(e),
    arr(e.answers).length ? h('ul', { class: 'h-answers' }, arr(e.answers).map(answerEl)) : h('p', { class: 'small muted', text: 'No answer in the app.' }),
    outcomeEl(e));
  return art;
}
function historySection(d) {
  const all = arr(d.needsHistory);
  if (!all.length) return [];
  const n = state.histN || 20, shown = all.slice(0, n);
  return [h('h3', { class: 'section-title', 'data-testid': 'history-title', text: 'History (' + all.length + ')' }),
    h('div', { class: 'stack', 'data-testid': 'history' }, shown.map(historyEntry)),
    all.length > n ? h('button', { class: 'btn block', type: 'button', 'data-testid': 'history-more', onclick: () => { state.histN = n + 20; render(); } }, 'Show more (' + (all.length - n) + ' older)') : null];
}

function needsView(d, focusId) {
  const items = arr(d.needsYou);
  const open = items.filter((q) => !isSent(q)), sent = items.filter(isSent);
  const w = who();
  const out = [h('div', { class: 'card-head' }, h('h2', { class: 'title', text: 'For you' }),
    h('button', { class: 'btn ghost', type: 'button', onclick: askWho }, w ? 'Answering as ' + w : 'Who are you?'))];
  if (!items.length) out.push(h('div', { class: 'card empty' }, icon('check'), h('p', { class: 'h2', text: 'All caught up' }), h('p', { class: 'small', text: 'New questions and reviews will appear here and as a notification.' })));
  out.push(...open.map((q) => questionCard(q, focusId)));
  if (sent.length) out.push(h('h3', { class: 'section-title', text: 'Sent (' + sent.length + ')' }), ...sent.map((q) => questionCard(q, focusId)));
  out.push(...historySection(d));
  if (focusId) setTimeout(() => document.getElementById('q-' + focusId)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  return out;
}

const COLS = ['draft', 'ready', 'approved', 'next', 'in-dev', 'done'];
const COL_LABEL = { next: 'Next increment' };
const colName = (c) => COL_LABEL[c] || STATUS[c][0];
const colOf = (s) => s.column || s.status;
function storyButton(s) {
  return h('button', { class: 'story', type: 'button', 'data-testid': 'story-' + s.id, onclick: () => { location.hash = '#board/' + encodeURIComponent(s.id); } },
    h('span', { class: 'card-head' }, h('span', { class: 'story-id', text: s.id + (arr(s.reqs).length ? ' · ' + arr(s.reqs).join(', ') : '') }), badge(s.status)),
    h('span', { class: 'story-title', text: s.title || '' }),
    s.stepSummary?.total ? h('span', { class: 'small muted', 'data-testid': 'steps-summary', text: s.stepSummary.text }) : null);
}
const PLAN_COL = { now: 'in-dev', next: 'next', done: 'done', accepted: 'done' };
const techTasks = (plan) => plan.filter((i) => i.kind === 'technical').flatMap((i) => arr(i.tasks).map((t) => ({ ...t, inc: i, column: PLAN_COL[i.status] })));
function taskButton(t) {
  return h('button', { class: 'story', type: 'button', 'data-testid': 'task-' + t.id, onclick: () => { location.hash = '#board/' + encodeURIComponent(t.id); } },
    h('span', { class: 'card-head' }, h('span', { class: 'story-id', text: t.id }), h('span', { class: 'badge st-unknown', text: 'Technical' })),
    h('span', { class: 'story-title', text: t.title || '' }),
    h('span', { class: 'small muted', text: 'No approval needed' }));
}
function boardView(d) {
  const stories = arr(d.stories), plan = arr(d.plan), tasks = techTasks(plan);
  const tab = COLS.includes(state.boardTab) ? state.boardTab : 'in-dev';
  const inCol = (c) => [...stories.filter((s) => colOf(s) === c), ...tasks.filter((t) => t.column === c)];
  const tabs = h('div', { class: 'seg board-cols', role: 'tablist', 'aria-label': 'Story status' }, COLS.map((c) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(c === tab), 'data-testid': 'tab-' + c,
      onclick: () => { state.boardTab = c; store.set('boardTab', c); render(); } }, colName(c), h('span', { class: 'n', text: String(inCol(c).length) }))));
  const list = inCol(tab);
  const groups = [];
  if (tab === 'ready' || tab === 'approved' || tab === 'next') {
    for (const inc of plan) { const g = list.filter((s) => s.planned?.id === inc.id || (s.inc && s.inc.id === inc.id)); if (g.length) groups.push([inc.name, g]); }
    const un = list.filter((s) => !s.inc && (!s.planned || !plan.some((i) => i.id === s.planned.id))); if (un.length) groups.push(['Unplanned', un]);
  } else if (list.length) groups.push([null, list]);
  return [h('h2', { class: 'title', text: 'Board' }), tabs,
    !list.length ? h('div', { class: 'card empty' }, h('p', { text: 'No stories in ' + colName(tab).toLowerCase() + '.' })) : null,
    groups.map(([name, g]) => [name ? h('h3', { class: 'section-title', text: name }) : null, h('div', { class: 'stack', role: 'tabpanel' }, g.map((x) => x.inc ? taskButton(x) : storyButton(x)))])];
}
function taskSheet(d, id) {
  const t = techTasks(arr(d.plan)).find((x) => x.id === id); if (!t) return false;
  openSheet(t.id + ' ' + t.title, [
    h('div', { class: 'row' }, h('span', { class: 'badge st-unknown', text: 'Technical' }), h('span', { class: 'who', text: t.inc.name })),
    h('dl', { class: 'kv' },
      h('dt', { text: 'Increment' }), h('dd', { text: t.inc.name }),
      h('dt', { text: 'Stage' }), h('dd', { text: t.inc.stage || '–' }),
      h('dt', { text: 'Approval' }), h('dd', { text: t.inc.approval || 'No approval needed' }))]);
  return true;
}
function storySheet(d, id) {
  if (taskSheet(d, id)) return;
  const s = arr(d.stories).find((x) => x.id === id); if (!s) return;
  const journeys = arr(s.journey);
  openSheet(s.id + ' ' + (s.title || ''), [
    h('div', { class: 'row' }, badge(s.status), s.increment ? h('span', { class: 'who', text: s.increment }) : null, arr(s.reqs).map((r) => h('span', { class: 'who', text: r }))),
    journeys.length ? journeys.map((j) => h('section', { class: 'stack' },
      h('h3', { class: 'section-title', text: 'Journey steps' }),
      h('p', { class: 'small muted', text: (j.ad || '') + (j.title ? ' · ' + j.title : '') }),
      h('ol', { class: 'steps' }, arr(j.steps).map((st) => h('li', {}, h('span', { class: 'n', text: st.n || '' }), h('span', { text: st.text || '' }), badge(st.status))))))
      : h('p', { class: 'muted', text: 'No journey steps yet.' }),
    s.docsUrl ? h('a', { class: 'btn block', href: s.docsUrl, target: '_blank', rel: 'noopener' }, 'Open details', icon('ext')) : null,
  ]);
}

function runsView(d) {
  const p = d.pipeline;
  if (!p) return [h('h2', { class: 'title', text: 'Runs' }), h('div', { class: 'card empty' }, h('p', { text: 'No pipeline run yet.' })), quickCard(d)];
  const all = arr(p.stages), fails = arr(p.failures);
  const bg = all.find((s) => s.name === 'docs-pre');
  const stages = all.filter((s) => s.name !== 'docs-pre');
  const max = Math.max(1, ...stages.map((s) => Math.max(s.seconds || 0, s.expectedS || 0)));
  const names = new Set(all.map((s) => s.name));
  const total = stages.reduce((a, s) => a + (s.seconds || 0), 0);
  const head = h('section', { class: 'card', 'data-testid': 'run-head' },
    h('div', { class: 'card-head' }, h('span', { class: 'mono', text: short(p.build) }), badge(p.state)),
    h('p', {}, purposeTag(p.purpose), tierTag(p), p.increment ? h('span', { class: 'small muted', text: ' ' + p.increment }) : null),
    h('dl', { class: 'kv' },
      h('dt', { text: 'Started' }), h('dd', { text: p.startedAt ? when(p.startedAt) : '–' }),
      h('dt', { text: p.state === 'running' ? 'Running for' : 'Took' }), h('dd', { text: dur(p.elapsedS ?? total) }),
      p.state === 'running' && p.etaS ? [h('dt', { text: 'Left, about' }), h('dd', { text: dur(Math.max(0, p.etaS - (p.elapsedS || 0))) })] : null,
      h('dt', { text: 'Failures' }), h('dd', { text: String(fails.length) })),
    p.reportUrl ? h('a', { class: 'btn block', href: p.reportUrl, target: '_blank', rel: 'noopener' }, 'Gate report', icon('ext')) : null);
  const block = (s) => {
    const f = fails.filter((x) => x.stage === s.name || (s.name === 'qa' && bg && x.stage === 'docs-pre'));
    return h('section', { class: 'stage ' + (s.status || '') + (f.length ? ' wide' : ''), 'data-testid': 'stage-' + s.name },
      h('span', { class: 'stage-name', text: s.name }),
      h('div', { class: 'stage-top' }, h('span', { class: 'stage-time', text: s.status === 'pending' ? '–' : dur(s.seconds) }), badge(s.status)),
      barEl(s.status === 'pending' ? 0 : pct(s.seconds || 0, max), s.status === 'fail' ? 'over' : ''),
      s.expectedS ? h('span', { class: 'small muted', text: 'usually ' + dur(s.expectedS) }) : null,
      s.name === 'qa' && bg ? h('div', { class: 'bgstage', 'data-testid': 'stage-docs-pre' },
        barEl(bg.status === 'pending' ? 0 : pct(Math.min(bg.seconds || 0, s.seconds || bg.seconds || 0), Math.max(1, s.seconds || bg.seconds || 1)), bg.status === 'fail' ? 'over' : ''),
        h('span', { class: 'small muted', text: 'docs-pre ran alongside QA' + (bg.status === 'pending' ? '' : ' (' + dur(bg.seconds) + ')') + (bg.status === 'fail' ? ', failed' : '') })) : null,
      s.name === 'qa' && p.live ? h('div', { class: 'live', 'data-testid': 'qa-live', 'aria-live': 'polite' },
        h('p', { class: 'small' }, h('strong', { text: String(p.live.passed) }), ' passed · ', h('strong', { class: p.live.failed ? 'bad' : '', text: String(p.live.failed) }), ' failed so far'),
        p.live.firstFailure ? h('p', { class: 'small owner', text: 'First failure: ' + (p.live.firstFailure.tc ? p.live.firstFailure.tc + ' ' : '') + '[' + p.live.firstFailure.project + '] ' + p.live.firstFailure.test }) : null) : null,
      f.length ? failList(f) : null);
  };
  const orphan = fails.filter((x) => !names.has(x.stage));
  return [h('h2', { class: 'title', text: 'Runs' }), head,
    h('h3', { class: 'section-title', text: 'Stages' }),
    h('div', { class: 'stages' }, stages.map(block),
      orphan.length ? h('section', { class: 'stage fail wide' }, h('span', { class: 'stage-name', text: 'Other failures' }), failList(orphan)) : null),
    quickCard(d),
    h('section', { class: 'card', 'data-testid': 'recent-runs' }, h('span', { class: 'eyebrow', text: 'Recent runs' }), arr(d.runs).length ? runList(d) : h('p', { class: 'muted', text: 'No runs yet.' }))];
}
function failList(f) {
  return h('ul', { class: 'fails', 'aria-label': 'Failures' }, f.map((x) => h('li', {},
    h('span', { class: 'owner', text: 'Owner: ' + (x.owner || 'unknown') + (x.id || x.tc ? ' · ' + (x.id || x.tc) : '') }),
    h('span', { text: x.test || 'Failure' }),
    x.reason ? h('span', { class: 'small muted', text: x.reason }) : null)));
}

function moreView(d, sub) {
  const u = d.usage || {};
  const roles = Object.entries(u.byRole || {}).sort((a, b) => b[1] - a[1]);
  const top = roles.length ? roles[0][1] : 1;
  const usage = h('section', { class: 'card', 'data-testid': 'usage-card' },
    h('span', { class: 'eyebrow', text: 'Time and tokens' }),
    h('p', {}, h('span', { class: 'stat', text: u.tokensTotal ? tokens(u.tokensTotal) : '–' }), h('span', { class: 'muted', text: ' tokens in all' })),
    roles.length ? h('div', { class: 'stack' }, roles.map(([r, n]) => h('div', { class: 'rolebar' }, h('span', { text: r }), barEl(pct(n, top)), h('span', { text: tokens(n) })))) : null,
    arr(u.byPeriod).length ? h('div', {}, arr(u.byPeriod).map((i) => h('div', { class: 'runrow' },
      h('span', { class: 'h2', text: i.name }), h('span', { class: 'mono', text: tokens(i.tokens) }),
      h('span', { class: 'small muted', text: (i.days != null ? i.days + ' days' : '') + (i.pipelineHours != null ? ' · ' + i.pipelineHours + ' h of pipeline' : '') }), h('span')))) : null);
  const runs = h('section', { class: 'card', id: 'runs-list', 'data-testid': 'last-runs' },
    h('span', { class: 'eyebrow', text: 'Last 10 runs' }),
    arr(d.runs).length ? runList(d) : h('p', { class: 'muted', text: 'No runs yet.' }));
  const w = who();
  const seg = (items, cur, onpick, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label }, items.map(([v, t]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === cur), onclick: () => onpick(v) }, t)));
  const theme = store.get('theme', 'system');
  const settings = h('section', { class: 'card' },
    h('span', { class: 'eyebrow', text: 'Settings' }),
    h('div', { class: 'stack' }, h('span', { class: 'lbl', text: 'Notifications' }), pushControl()),
    state.installEvt && !standalone() ? h('button', { class: 'btn block', type: 'button', onclick: install, 'data-testid': 'install' }, icon('down'), 'Install the app') : null,
    h('div', { class: 'stack' }, h('span', { class: 'lbl', text: 'You are' }), seg(peopleNames().map((n) => [n, n]), w, async (v) => { await setWho(v); render(); }, 'You are')),
    h('div', { class: 'stack' }, h('span', { class: 'lbl', text: 'Font' }), seg([['grotesk', 'Bold grotesk'], ['caps', 'Wide caps'], ['slab', 'Strong slab']], store.get('font', 'caps'), (v) => { store.set('font', v); applyFont(); render(); }, 'Font')),
    h('div', { class: 'stack' }, h('span', { class: 'lbl', text: 'Theme' }), seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], theme, (v) => { store.set('theme', v); applyTheme(); render(); }, 'Theme')));
  const links = h('section', { class: 'card' },
    arr(CFG.links).map((l) => h('a', { class: 'linkrow', href: l.href, target: '_blank', rel: 'noopener' }, h('span', { text: l.label }), icon('ext'))),
    h('div', { class: 'small muted' }, 'Data from ' + (d.generatedAt ? when(d.generatedAt) : '–') + (state.source === 'sample' ? ' (sample)' : state.source === 'cache' ? ' (offline copy)' : '')),
    arr(d.errors).length ? h('div', { class: 'notice' }, 'Collector notes: ' + arr(d.errors).map(String).join('; ')) : null);
  if (sub === 'runs') setTimeout(() => $('#runs-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  return [h('h2', { class: 'title', text: 'More' }), spendCard(d), usage, runs, settings, links];
}

// ---------- push ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function pushControl() {
  if (!pushSupported()) return h('p', { class: 'small muted', text: 'This browser cannot show notifications. Install the app from Chrome or Samsung Internet.' });
  if (Notification.permission === 'denied') return h('p', { class: 'small muted', text: 'Notifications are blocked. Allow them in the site settings of your browser.' });
  const on = state.push === 'on';
  return h('div', { class: 'stack' },
    h('button', { class: 'btn block' + (on ? '' : ' primary'), type: 'button', 'data-testid': 'push-toggle', 'aria-pressed': String(on),
      onclick: async (e) => { e.currentTarget.disabled = true; try { on ? await unsubscribePush() : await subscribePush(); } catch (err) { toast(String(err.message || err)); } render(); } },
    icon('bell'), on ? 'Turn notifications off' : 'Turn notifications on'),
    h('p', { class: 'small muted', text: on ? 'On for this device. You can accept a suggestion straight from a notification.' : 'Get a notification when someone needs you or a run ends.' }));
}
function b64u(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function subscribePush(resend) {
  const w = await ensureWho(); if (!w) throw new Error('Choose who you are first.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (resend) return;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.');
    const r = await fetch(API + '/vapid', { cache: 'no-store' });
    if (!r.ok) throw new Error('Notifications are not set up on the server yet.');
    const txt = (await r.text()).trim();
    let key = txt; try { const j = JSON.parse(txt); key = typeof j === 'string' ? j : j.publicKey || j.key; } catch { /* plain text */ }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
  }
  const j = sub.toJSON();
  const r = await fetch(API + '/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, who: w }) });
  if (!r.ok) { if (!resend) await sub.unsubscribe(); throw new Error('The server did not accept this device (' + r.status + ').'); }
  state.push = 'on'; if (!resend) toast('Notifications are on.');
}
async function unsubscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch(API + '/subscriptions', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe();
  }
  state.push = 'off'; toast('Notifications are off.');
}
async function checkPush() {
  if (!pushSupported()) { state.push = 'unsupported'; return; }
  try { const reg = await navigator.serviceWorker.ready; state.push = (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'on' : 'off'; } catch { state.push = 'off'; }
}

// ---------- install ----------
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function install() {
  const e = state.installEvt; if (!e) return;
  e.prompt(); const c = await e.userChoice.catch(() => null);
  state.installEvt = null; if (c?.outcome === 'accepted') toast('Installed.'); render();
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; render(); });
addEventListener('appinstalled', () => { state.installEvt = null; render(); });

// ---------- font ----------
function applyFont() {
  const f = store.get('font', 'caps');
  if (f === 'grotesk' || f === 'slab') document.documentElement.setAttribute('data-font', f); else document.documentElement.removeAttribute('data-font');
}

// ---------- theme ----------
function applyTheme() {
  const t = store.get('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = dark ? '#0B0B0A' : '#FAFAF8'; m.removeAttribute('media'); });
}

// ---------- router and render ----------
const TITLES = { home: 'LAVA', needs: 'For you', board: 'Board', runs: 'Runs', more: 'More' };
function route() {
  const [tab, arg] = location.hash.replace(/^#/, '').split('/');
  return { tab: TITLES[tab] ? tab : 'home', arg: arg ? decodeURIComponent(arg) : '' };
}
function renderFresh() {
  const d = state.data, t = $('#fresh-text');
  if (state.loading && !d) t.textContent = 'Loading…';
  else if (!d) t.textContent = 'No data yet';
  else t.textContent = (d.preview ? 'Preview data · ' : '') + (state.source === 'sample' ? 'Sample · ' : state.source === 'cache' ? 'Offline · ' : '') + 'Updated ' + (ago(d.generatedAt) || '–');
  const n = arr(d?.needsYou).filter((q) => !isSent(q)).length, c = $('#needs-count');
  c.hidden = !n; c.textContent = String(n);
  c.setAttribute('aria-label', n + ' waiting');
}
let lastTab = '';
function render() {
  const a = document.activeElement;
  if (a && a.tagName === 'TEXTAREA' && main.contains(a) && state._renderGuard) return;
  const { tab, arg } = route();
  document.querySelectorAll('.tabs a').forEach((el) => (el.dataset.tab === tab ? el.setAttribute('aria-current', 'page') : el.removeAttribute('aria-current')));
  document.title = (tab === 'home' ? '' : TITLES[tab] + ' · ') + (CFG.appName || 'LAVA');
  renderFresh();
  const d = state.data;
  let view;
  if (!d && !state.loadedAt) view = [h('h2', { class: 'title', text: TITLES[tab] }), h('p', { class: 'muted', text: 'Loading…' })];
  else if (!d) view = [h('h2', { class: 'title', text: TITLES[tab] }), waiting(), tab === 'more' ? moreView({}, arg).slice(4) : null];
  else if (tab === 'needs') view = needsView(d, arg);
  else if (tab === 'board') view = boardView(d);
  else if (tab === 'runs') view = runsView(d);
  else if (tab === 'more') view = moreView(d, arg);
  else view = home(d);
  const y = scrollY;
  main.replaceChildren(...[view].flat(Infinity).filter(Boolean));
  if (tab !== lastTab) { scrollTo(0, 0); lastTab = tab; } else scrollTo(0, y);
  if (tab === 'board' && arg && d) storySheet(d, arg); else if (tab !== 'board' && $('#sheet').open && !sheetOnClose) closeSheet();
}

addEventListener('hashchange', render);
$('#fresh').addEventListener('click', () => load(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - state.loadedAt > 10000) load(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
setInterval(() => { if (!document.hidden) { state._renderGuard = true; load().finally(() => (state._renderGuard = false)); } }, 30000);
setInterval(renderFresh, 15000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'answered' && e.data.questionId) {
      const list = arr(state.sent[e.data.questionId]); list.push(e.data.record || { kind: 'accept', text: '', who: who(), at: new Date().toISOString() });
      state.sent[e.data.questionId] = list; store.set('sent', state.sent); render();
    }
  });
}
applyTheme();
applyFont();
if (who()) setWho(who());
render();
checkPush().then(render);
const splashStart = performance.now();
const splashEl = $('#splash');
const minShow = matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 900;
function endSplash() {
  if (!splashEl || splashEl.dataset.done) return; splashEl.dataset.done = '1';
  splashEl.classList.add('out');
  setTimeout(() => splashEl.remove(), 350);
}
const ready = loadConfig().then(() => load(true)).catch(() => {});
if (splashEl) {
  Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]).then(() => setTimeout(endSplash, Math.max(0, minShow - (performance.now() - splashStart))));
  setTimeout(endSplash, 1500);
}
