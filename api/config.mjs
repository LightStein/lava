// LAVA configuration: lava.config.json (path in LAVA_CONFIG) plus LAVA_* environment variables.
// Shared by the API, the collector and the helper scripts. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const CONFIG_PATH = env.LAVA_CONFIG || path.resolve(process.cwd(), 'lava.config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error(`lava: cannot read ${CONFIG_PATH}: ${e.message}`);
    return {};
  }
}

const raw = readConfig();
const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const people = (Array.isArray(raw.people) ? raw.people : [])
  .filter((p) => p && typeof p.name === 'string' && p.name.trim())
  .map((p) => ({ name: p.name.trim().slice(0, 40), role: str(p.role).slice(0, 60) }))
  .slice(0, 20);
const links = (Array.isArray(raw.links) ? raw.links : [])
  .filter((l) => l && typeof l.href === 'string' && /^(https?:\/\/|\/)/.test(l.href))
  .map((l) => ({ label: str(l.label, l.href).slice(0, 60), href: l.href }))
  .slice(0, 10);
const theme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
const sources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};

export const config = {
  path: CONFIG_PATH,
  appName: str(raw.appName, 'LAVA').slice(0, 30),
  description: str(raw.description, 'What the team is doing, what it needs from you, and how the pipeline is doing.').slice(0, 200),
  people,
  links,
  timeZone: str(raw.timeZone) || undefined,
  theme: { accentLight: hex(theme.accentLight), accentDark: hex(theme.accentDark) },
  dataDir: env.LAVA_DATA || str(raw.dataDir, '/data'),
  webDir: env.LAVA_WEB || str(raw.webDir, path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'web')),
  port: Number(env.LAVA_PORT) || Number(raw.port) || 8080,
  test: env.LAVA_TEST === '1',
  sources: {
    needsYou: env.LAVA_SOURCE_NEEDS_YOU || str(sources.needsYou),
    status: env.LAVA_SOURCE_STATUS || str(sources.status),
    pipeline: env.LAVA_SOURCE_PIPELINE || str(sources.pipeline),
    tokens: env.LAVA_SOURCE_TOKENS || str(sources.tokens),
  },
  collectorIntervalS: Number(env.LAVA_COLLECT_INTERVAL_S) || Number(raw.collector?.intervalS) || 60,
  vapid: {
    publicKey: env.LAVA_VAPID_PUBLIC || '',
    privateKey: env.LAVA_VAPID_PRIVATE || '',
    subject: env.LAVA_VAPID_SUBJECT || str(raw.push?.subject, 'mailto:admin@example.com'),
  },
};

// What the browser may see (GET /api/config). Never paths, never keys.
export const publicConfig = () => ({
  appName: config.appName,
  description: config.description,
  people: config.people,
  links: config.links,
  timeZone: config.timeZone,
  theme: config.theme,
});
