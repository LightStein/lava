// Draws the app icons as PNGs with node:zlib only (no dependencies).
// Run: node scripts/make-icons.mjs  (writes web/icons/*.png, no dependencies)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to a rounded box centred at (cx, cy), half sizes hw, hh, radius r (unit coords).
const sdBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const cov = (d, px) => Math.min(1, Math.max(0, 0.5 - d / px));

const BG = [11, 11, 10], FG = [242, 241, 238], ACCENT = [143, 166, 255];

// The glyph: three board rows of decreasing length and a blue "live" dot; fits the maskable safe zone (radius 0.4).
function glyph(u, v, s) {
  const bars = [[0.5, 0.36, 0.2], [0.46, 0.5, 0.16], [0.42, 0.64, 0.12]];
  let a = 0;
  for (const [cx, cy, hw] of bars) a = Math.max(a, cov(sdBox(u, v, cx - 0.04, cy, hw, 0.035, 0.035), s));
  const dot = cov(sdCircle(u, v, 0.66, 0.64, 0.05), s);
  return { a, dot };
}

function draw(size, { maskable = false, badge = false } = {}) {
  const s = 1 / size;
  return png(size, (x, y) => {
    const u = x / size, v = y / size;
    const { a, dot } = glyph(maskable ? 0.5 + (u - 0.5) * 1.15 : u, maskable ? 0.5 + (v - 0.5) * 1.15 : v, s * (maskable ? 1.15 : 1));
    if (badge) {
      const al = Math.max(a, dot);
      return [255, 255, 255, Math.round(al * 255)];
    }
    const shape = maskable ? 1 : cov(sdBox(u, v, 0.5, 0.5, 0.5, 0.5, 0.2), s);
    let c = BG.slice();
    c = c.map((ch, i) => ch + (FG[i] - ch) * a);
    c = c.map((ch, i) => ch + (ACCENT[i] - ch) * dot);
    return [...c.map(Math.round), Math.round(shape * 255)];
  });
}

const files = {
  'icon-192.png': draw(192),
  'icon-512.png': draw(512),
  'maskable-512.png': draw(512, { maskable: true }),
  'maskable-192.png': draw(192, { maskable: true }),
  'apple-touch-180.png': draw(180, { maskable: true }),
  'badge-96.png': draw(96, { badge: true }),
};
for (const [n, b] of Object.entries(files)) writeFileSync(join(out, n), b);
console.log('icons:', Object.keys(files).join(', '));
