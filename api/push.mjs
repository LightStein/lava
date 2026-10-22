// Web Push without dependencies.
//   VAPID (RFC 8292): an ES256 JWT signed with the application server key.
//   Message encryption (RFC 8291) with the aes128gcm content coding (RFC 8188), one record.
import crypto from 'node:crypto';
import { config } from './config.mjs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// Keys as base64url: public = 65-byte uncompressed point, private = 32-byte scalar d.
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidKeyObject(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('LAVA_VAPID_PUBLIC is not an uncompressed P-256 point');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

export function vapidHeader(endpoint, { publicKey, privateKey, subject }) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const input = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: vapidKeyObject(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

export function encrypt(payload, keys) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one message. Returns { status } (404/410 mean: drop the subscription).
export async function sendPush(sub, message, vapid, { ttl = 86400, topic } = {}) {
  let payload = typeof message === 'string' ? message : JSON.stringify(message);
  if (Buffer.byteLength(payload) > 3000) throw new Error('push payload over 3000 bytes');
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: 'normal',
    Authorization: vapidHeader(sub.endpoint, vapid),
  };
  if (topic) {
    const t = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    if (t) headers.Topic = t;
  }
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body: encrypt(payload, sub.keys), signal: AbortSignal.timeout(10000) });
  await res.arrayBuffer().catch(() => {});
  return { status: res.status };
}

export function vapidFromEnv(env = process.env) {
  const publicKey = env.LAVA_VAPID_PUBLIC || '';
  const privateKey = env.LAVA_VAPID_PRIVATE || '';
  const subject = env.LAVA_VAPID_SUBJECT || config.vapid.subject;
  return publicKey && privateKey ? { publicKey, privateKey, subject } : null;
}
