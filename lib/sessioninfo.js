/**
 * Read the WhatsApp number out of a `Ladybug!<base64-gzip>` session ID.
 * The session is a gzipped creds.json whose `me.id` looks like
 * "2637XXXXXXXX:12@s.whatsapp.net". Nothing is sent anywhere - it is decoded locally.
 * Admin-only: callers must never expose the result to other users.
 */
const zlib = require('zlib');

const cache = new Map(); // sessionId -> info

function decode(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (cache.has(sessionId)) return cache.get(sessionId);
  let info = null;
  try {
    const b64 = sessionId.replace(/^Ladybug!/, '').trim();
    // the session ID is user supplied, so cap the output size (zip-bomb guard)
    const json = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8'));
    const jid = (json.me && json.me.id) || null;
    const number = jid ? String(jid).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
    info = {
      number: number || null,
      name: (json.me && json.me.name) || null,
      registered: json.registered === true,
    };
  } catch (e) {
    info = null;
  }
  if (cache.size > 500) cache.clear();
  cache.set(sessionId, info);
  return info;
}

module.exports = { decode };
