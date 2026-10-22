// A push by hand to every subscribed device:
//   docker compose exec api node api/send.mjs "title" "body" [url]
import { sendToAll } from './store.mjs';

const [title, body = '', url = '/'] = process.argv.slice(2);
if (!title) {
  console.error('usage: node api/send.mjs "title" "body" [url]');
  process.exit(2);
}
const r = await sendToAll({ title, body, url, tag: 'manual' });
console.log(`push: sent ${r.sent}, failed ${r.failed}, dropped ${r.dropped} expired subscription(s)`);
process.exit(r.failed && !r.sent ? 1 : 0);
