// LAVA collector: reads the configured input files, writes <data>/board.json (what the app shows) and appends
// notifications to <data>/push-outbox.jsonl (the API sends them). No dependencies, no network.
//
//   node collector/collect.mjs          one run
//   node collector/collect.mjs --loop   a run every collector.intervalS seconds (default 60)
//
// Inputs (all optional; formats in docs/how-it-works.md and docs/schemas/):
//   sources.needsYou   JSON   the open requests for the people (questions, reviews, go/no-go) and the closed history
//   sources.status     JSON   the "now" card, stories, plan, agents, timeline, spend ... (passed through after checks)
//   sources.pipeline   JSON   the current pipeline run and the recent runs
//   sources.tokens     JSONL  a token journal: one {at, role, tokens, period?} per line
//   <data>/answers.jsonl      written by the API, read here only to show the history (never changed)
import fs from 'node:fs';
import { config } from '../api/config.mjs';
import { file, readJson, writeJsonAtomic, DATA } from '../api/store.mjs';

const MAX_HISTORY = 500;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const KINDS = new Set(['question', 'review', 'go']);
const log = (...a) => console.log(new Date().toISOString(), 'collector:', ...a);

const str = (v, max = 600) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);
const safeHref = (h) => (typeof h === 'string' && /^(https?:\/\/|\/|#)/.test(h) ? h.slice(0, 500) : undefined);
const links = (v) => arr(v).map((l) => obj(l) && safeHref(l.href) ? { label: str(l.label, 80) || l.href, href: safeHref(l.href) } : null).filter(Boolean).slice(0, 8);

function readInput(path, kind, errors) {
  if (!path) return undefined;
  let text;
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') errors.push(`${kind}: ${e.code || e.message}`); return undefined; }
  if (kind === 'tokens') return text;
  try { return JSON.parse(text); } catch { errors.push(`${kind}: not valid JSON`); return undefined; }
}

// One request item, checked and trimmed. Unknown fields are dropped.
function item(q, errors) {
  if (!obj(q)) return null;
  const id = typeof q.id === 'string' ? q.id.trim() : '';
  if (!ID.test(id)) { errors.push(`needsYou: an item without a valid id (${String(q.id).slice(0, 20)})`); return null; }
  const people = new Set(config.people.map((p) => p.name));
  const who = str(q.who, 40);
  const onlyWho = str(q.onlyWho, 40);
  return {
    id,
    kind: KINDS.has(q.kind) ? q.kind : 'question',
    who: who && (people.has(who) || !people.size) ? who : undefined,
    onlyWho: onlyWho && people.has(onlyWho) ? onlyWho : undefined,
    title: str(q.title, 120),
    question: str(q.question, 2000) || str(q.title, 2000) || id,
    why: str(q.why, 600),
    blocks: str(q.blocks, 200),
    suggestion: str(q.suggestion, 1500),
    links: links(q.links),
    sentAt: iso(q.sentAt),
  };
}

function readAnswers() {
  let text = '';
  try { text = fs.readFileSync(file('answers.jsonl', false), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const a = JSON.parse(line); if (a && a.who !== 'Test') out.push(a); } catch { /* torn line */ }
  }
  return out;
}

function pipelineFrom(p) {
  if (!obj(p)) return {};
  const run = obj(p.pipeline) || (Array.isArray(p.stages) ? p : undefined);
  const stage = (s) => obj(s) && str(s.name, 40) ? { name: str(s.name, 40), status: str(s.status, 20) || 'pending', seconds: Number.isFinite(s.seconds) ? s.seconds : undefined, expectedS: Number.isFinite(s.expectedS) ? s.expectedS : undefined } : null;
  const fail = (f) => obj(f) ? { stage: str(f.stage, 40), owner: str(f.owner, 40), test: str(f.test, 300), id: str(f.id, 40), reason: str(f.reason, 400) } : null;
  const pipeline = run ? {
    runId: str(run.runId, 80), build: str(run.build, 40), state: ['running', 'pass', 'fail', 'aborted'].includes(run.state) ? run.state : 'running',
    purpose: str(run.purpose, 40), startedAt: iso(run.startedAt),
    elapsedS: Number.isFinite(run.elapsedS) ? run.elapsedS : (iso(run.startedAt) && run.state === 'running' ? Math.round((Date.now() - Date.parse(run.startedAt)) / 1000) : undefined),
    etaS: Number.isFinite(run.etaS) ? run.etaS : undefined,
    stages: arr(run.stages).map(stage).filter(Boolean).slice(0, 30),
    failures: arr(run.failures).map(fail).filter(Boolean).slice(0, 50),
    live: obj(run.live) ? { passed: Number(run.live.passed) || 0, failed: Number(run.live.failed) || 0 } : undefined,
    reportUrl: safeHref(run.reportUrl),
  } : undefined;
  const runs = arr(p.runs).map((r) => obj(r) ? { runId: str(r.runId, 80), build: str(r.build, 40), result: str(r.result, 20), seconds: Number(r.seconds) || 0, failedStage: str(r.failedStage, 40) || '', startedAt: iso(r.startedAt), purpose: str(r.purpose, 40), reportUrl: safeHref(r.reportUrl) } : null).filter(Boolean).slice(0, 10);
  return { pipeline, runs };
}

function usageFrom(text) {
  if (!text) return undefined;
  const byRole = {}, byPeriod = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const n = Number(e && e.tokens); if (!Number.isFinite(n) || n < 0) continue;
    total += n;
    const role = str(e.role, 40) || 'Other';
    byRole[role] = (byRole[role] || 0) + n;
    const period = str(e.period, 60);
    if (period) byPeriod.set(period, (byPeriod.get(period) || 0) + n);
  }
  return { tokensTotal: total, byRole, byPeriod: [...byPeriod].map(([name, tokens]) => ({ name, tokens })) };
}

export function collect() {
  const errors = [];
  const now = new Date().toISOString();
  const state = readJson('collector-state.json', null, false);
  const first = !state;
  const st = state || { seen: {}, closed: {}, pipelineState: null, envBuild: null };
  const outbox = [];

  // ---- needs you
  const nyRaw = readInput(config.sources.needsYou, 'needsYou', errors);
  const ny = Array.isArray(nyRaw) ? { items: nyRaw } : obj(nyRaw) || {};
  const ids = new Set();
  const needsYou = [];
  for (const q of arr(ny.items)) {
    const it = item(q, errors);
    if (!it || ids.has(it.id)) continue;
    ids.add(it.id);
    const seen = st.seen[it.id];
    it.sentAt = it.sentAt || seen?.firstSeen || now;
    needsYou.push(it);
    if (!seen) {
      st.seen[it.id] = { firstSeen: it.sentAt, title: it.title, who: it.who, kind: it.kind, question: it.question, why: it.why, blocks: it.blocks, links: it.links };
      delete st.closed[it.id];
      if (!first) outbox.push(pushFor(it));
    }
  }
  // closed: seen before, not open any more
  for (const id of Object.keys(st.seen)) if (!ids.has(id) && !st.closed[id]) st.closed[id] = now;

  // ---- history (closed requests), with the answers from the append-only log
  const answers = readAnswers();
  const byQ = new Map();
  for (const a of answers) { if (!byQ.has(a.questionId)) byQ.set(a.questionId, []); byQ.get(a.questionId).push({ who: a.who, kind: a.kind, text: a.text, at: a.at }); }
  const hist = new Map();
  for (const [id, resolvedAt] of Object.entries(st.closed)) {
    const s = st.seen[id] || {};
    hist.set(id, { id, kind: s.kind || 'question', title: s.title, who: s.who, question: s.question, questionFull: true, why: s.why, blocks: s.blocks, links: s.links || [], sentAt: s.firstSeen, resolvedAt });
  }
  for (const h of arr(ny.history)) { // the owner's own record wins
    const it = item(h, errors); if (!it) continue;
    hist.set(it.id, { ...hist.get(it.id), ...it, questionFull: true, resolvedAt: iso(h.resolvedAt) || hist.get(it.id)?.resolvedAt, decision: str(h.decision, 200), decisionUrl: safeHref(h.decisionUrl) });
  }
  const needsHistory = [...hist.values()]
    .filter((e) => !ids.has(e.id))
    .map((e) => ({ ...e, answers: (byQ.get(e.id) || []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }))
    .sort((a, b) => Date.parse(b.resolvedAt || b.sentAt || 0) - Date.parse(a.resolvedAt || a.sentAt || 0))
    .slice(0, MAX_HISTORY);

  // ---- status, pipeline, tokens
  const status = obj(readInput(config.sources.status, 'status', errors)) || {};
  const { pipeline, runs } = pipelineFrom(readInput(config.sources.pipeline, 'pipeline', errors));
  const usage = usageFrom(readInput(config.sources.tokens, 'tokens', errors)) || obj(status.usage);
  const nowCard = { ...(obj(status.now) || {}), ...(obj(ny.now) || {}) };

  if (pipeline) {
    if (!first && st.pipelineState === 'running' && (pipeline.state === 'pass' || pipeline.state === 'fail')) {
      const failed = pipeline.stages.find((s) => s.status === 'fail');
      const owners = [...new Set(pipeline.failures.map((f) => f.owner).filter(Boolean))];
      outbox.push({ title: pipeline.state === 'pass' ? `Run passed: ${pipeline.build || ''}`.trim() : `Run failed${failed ? ' at ' + failed.name : ''}`,
        body: pipeline.state === 'pass' ? 'All stages passed.' : `${pipeline.failures.length} failure(s)${owners.length ? '; owners: ' + owners.join(', ') : ''}.`, url: '/#runs', tag: 'run' });
    }
    st.pipelineState = pipeline.state;
  }
  const env0 = arr(nowCard.environments)[0];
  if (obj(env0) && env0.build) {
    if (!first && st.envBuild && st.envBuild !== env0.build) outbox.push({ title: `New build on ${env0.name || 'the environment'}`, body: String(env0.build), url: '/#home', tag: 'env' });
    st.envBuild = env0.build;
  }

  const board = {
    generatedAt: now,
    now: nowCard,
    needsYou,
    needsHistory,
    pipeline,
    runs,
    stories: arr(status.stories).slice(0, 500),
    plan: arr(status.plan).slice(0, 50),
    agents: obj(status.agents),
    timeline: arr(status.timeline).slice(0, 15),
    quick: arr(status.quick).slice(0, 6),
    nightly: obj(status.nightly),
    spend: obj(status.spend),
    usage,
    errors,
  };
  writeJsonAtomic('board.json', board, false);
  if (outbox.length) {
    fs.appendFileSync(file('push-outbox.jsonl', false), outbox.map((m) => JSON.stringify({ ...m, at: now })).join('\n') + '\n', { mode: 0o600 });
  }
  writeJsonAtomic('collector-state.json', st, false);
  log(`${needsYou.length} open, ${needsHistory.length} closed, ${outbox.length} push(es)${first ? ' (first run: no pushes)' : ''}${errors.length ? ', notes: ' + errors.join('; ') : ''}`);
  return board;
}

function pushFor(it) {
  const label = it.kind === 'review' ? 'Review' : it.kind === 'go' ? 'Go' : 'Question';
  const actions = it.kind === 'review' ? [{ action: 'accept', title: 'Approve' }, { action: 'open', title: 'Comment' }]
    : it.kind === 'go' ? [{ action: 'accept', title: 'Start' }, { action: 'notyet', title: 'Not yet' }]
      : it.suggestion ? [{ action: 'accept', title: 'Accept suggestion' }, { action: 'open', title: 'Answer' }] : [{ action: 'open', title: 'Answer' }];
  return { title: `${label}${it.who ? ' for ' + it.who : ''}: ${it.title || it.id}`.slice(0, 120), body: it.question.slice(0, 600), url: '/#needs/' + encodeURIComponent(it.id),
    tag: it.id, questionId: it.id, kind: it.kind, suggestion: it.suggestion, actions: it.onlyWho ? [{ action: 'open', title: 'Open' }] : actions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.mkdirSync(DATA, { recursive: true });
  const once = () => { try { collect(); } catch (e) { log('error:', e.stack || e.message); } };
  once();
  if (process.argv.includes('--loop')) {
    const t = setInterval(once, config.collectorIntervalS * 1000);
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { clearInterval(t); process.exit(0); });
  }
}
