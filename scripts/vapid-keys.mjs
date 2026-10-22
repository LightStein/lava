// Prints a new VAPID key pair as .env lines. Run once, put the lines in .env (never commit it):
//   node scripts/vapid-keys.mjs >> .env
//   (no Node on the host?)  docker compose run --rm --no-deps api node scripts/vapid-keys.mjs >> .env
import { generateVapidKeys } from '../api/push.mjs';
const k = generateVapidKeys();
console.log(`LAVA_VAPID_PUBLIC=${k.publicKey}`);
console.log(`LAVA_VAPID_PRIVATE=${k.privateKey}`);
console.log('LAVA_VAPID_SUBJECT=mailto:admin@example.com');
