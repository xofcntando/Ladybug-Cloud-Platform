/**
 * Personal API keys.
 *
 * Keys look like  lbk_<48 hex chars>  and are shown to the user exactly once.
 * Only a SHA-256 hash is stored (inside the user record in db.json), so a leaked
 * database never reveals a usable key.
 *
 * Scopes:
 *   read   - view account, bots, logs and billing
 *   write  - everything in "read" plus start / stop / restart bots
 */
const crypto = require('crypto');
const db = require('./store');

const PREFIX = 'lbk_';
const MAX_KEYS = 5;
const SCOPES = ['read', 'write'];

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

function view(k) {
  return {
    id: k.id,
    name: k.name,
    scope: k.scope,
    preview: k.preview,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || null,
  };
}

function list(user) {
  return (user.apiKeys || []).map(view);
}

function create(user, { name, scope }) {
  user.apiKeys = user.apiKeys || [];
  if (user.apiKeys.length >= MAX_KEYS) {
    return { error: `You can have at most ${MAX_KEYS} API keys. Revoke one first.` };
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) return { error: 'Give the key a name' };
  if (!SCOPES.includes(scope)) return { error: 'Scope must be "read" or "write"' };

  const secret = PREFIX + crypto.randomBytes(24).toString('hex');
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    name: cleanName,
    scope,
    hash: hash(secret),
    preview: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  user.apiKeys.push(rec);
  db.save();
  return { key: secret, record: view(rec) };
}

function revoke(user, id) {
  const before = (user.apiKeys || []).length;
  user.apiKeys = (user.apiKeys || []).filter((k) => k.id !== id);
  if (user.apiKeys.length === before) return false;
  db.save();
  return true;
}

/** Resolve a raw key to { user, key } or null. */
function authenticate(raw) {
  if (!raw || !raw.startsWith(PREFIX) || raw.length > 100) return null;
  const h = Buffer.from(hash(raw));
  for (const user of db.data.users) {
    for (const k of user.apiKeys || []) {
      const kh = Buffer.from(k.hash);
      if (kh.length === h.length && crypto.timingSafeEqual(kh, h)) {
        // touch lastUsedAt at most once a minute so we don't write to disk on every call
        if (!k.lastUsedAt || Date.now() - Date.parse(k.lastUsedAt) > 60_000) {
          k.lastUsedAt = new Date().toISOString();
          db.save();
        }
        return { user, key: k };
      }
    }
  }
  return null;
}

module.exports = { list, create, revoke, authenticate, MAX_KEYS, SCOPES };
