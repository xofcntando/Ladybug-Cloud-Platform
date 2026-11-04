/**
 * Personal API keys.
 *
 * Keys look like  lbk_<48 hex chars>  and are shown to the user exactly once.
 * Only a SHA-256 hash is stored (inside the user record in db.json), so a leaked
 * database never reveals a usable key.
 *
 * Scopes:
 *   read   - view account, bots, logs and billing
 *   write  - everything in "read" plus control/modify bots (needs the API Pass)
 *
 * API Pass extras: up to 5 keys, key expiry, IP allowlist, 600 req/min, usage stats.
 */
const crypto = require('crypto');
const net = require('net');
const db = require('./store');
const billing = require('./billing');

const PREFIX = 'lbk_';
const SCOPES = ['read', 'write'];
const USAGE_DAYS = 30;
const MAX_IPS = 10;

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');
const dayKey = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

function usageTotals(k) {
  const u = k.usage || {};
  const today = dayKey();
  const week = dayKey(Date.now() - 6 * 86400000);
  let d7 = 0;
  let d30 = 0;
  for (const [d, n] of Object.entries(u)) {
    d30 += n;
    if (d >= week) d7 += n;
  }
  return { today: u[today] || 0, last7d: d7, last30d: d30 };
}

function view(k) {
  return {
    id: k.id,
    name: k.name,
    scope: k.scope,
    preview: k.preview,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || null,
    expiresAt: k.expiresAt || null,
    allowedIps: k.allowedIps || [],
    usage: usageTotals(k),
  };
}

function list(user) {
  return (user.apiKeys || []).map(view);
}

function cleanIps(input) {
  if (input == null || input === '') return { ips: [] };
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const ips = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
  if (ips.length > MAX_IPS) return { error: `At most ${MAX_IPS} allowed IP addresses.` };
  const bad = ips.find((ip) => !net.isIP(ip));
  if (bad) return { error: `"${bad}" is not a valid IP address.` };
  return { ips };
}

function create(user, { name, scope, expiresInDays, allowedIps }) {
  const limits = billing.apiLimits(user);
  user.apiKeys = user.apiKeys || [];
  if (user.apiKeys.length >= limits.maxKeys) {
    return {
      code: limits.pro ? 400 : 402,
      error: limits.pro
        ? `You can have at most ${limits.maxKeys} API keys. Revoke one first.`
        : `The free plan includes ${limits.maxKeys} API key. Get the API Pass to create up to 5.`,
    };
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) return { error: 'Give the key a name' };
  if (!SCOPES.includes(scope)) return { error: 'Scope must be "read" or "write"' };
  if (scope === 'write' && !limits.canWrite) {
    return { code: 402, error: 'Write keys (start/stop/provision bots) need the API Pass.' };
  }

  let expiresAt = null;
  if (expiresInDays != null && expiresInDays !== '') {
    if (!limits.pro) return { code: 402, error: 'Key expiry needs the API Pass.' };
    const d = Number(expiresInDays);
    if (!Number.isFinite(d) || d < 1 || d > 365) return { error: 'Expiry must be between 1 and 365 days.' };
    expiresAt = new Date(Date.now() + d * 86400000).toISOString();
  }
  const ipRes = cleanIps(allowedIps);
  if (ipRes.error) return { error: ipRes.error };
  if (ipRes.ips.length && !limits.pro) return { code: 402, error: 'IP allowlists need the API Pass.' };

  const secret = PREFIX + crypto.randomBytes(24).toString('hex');
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    name: cleanName,
    scope,
    hash: hash(secret),
    preview: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt,
    allowedIps: ipRes.ips,
    usage: {},
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

let lastUsageSave = 0;

/** Count one call. Persisted at most every 30s so busy keys don't thrash the disk. */
function recordUse(k) {
  const now = Date.now();
  const d = dayKey(now);
  k.usage = k.usage || {};
  k.usage[d] = (k.usage[d] || 0) + 1;
  const cutoff = dayKey(now - USAGE_DAYS * 86400000);
  for (const key of Object.keys(k.usage)) if (key < cutoff) delete k.usage[key];
  k.lastUsedAt = new Date(now).toISOString();
  if (now - lastUsageSave > 30_000) {
    lastUsageSave = now;
    db.save();
  }
}

/**
 * Resolve a raw key to { user, key } or { error, code }.
 * Checks expiry and the IP allowlist.
 */
function authenticate(raw, ip) {
  if (!raw || !raw.startsWith(PREFIX) || raw.length > 100) return { code: 401, error: 'Invalid or revoked API key' };
  const h = Buffer.from(hash(raw));
  for (const user of db.data.users) {
    for (const k of user.apiKeys || []) {
      const kh = Buffer.from(k.hash);
      if (kh.length !== h.length || !crypto.timingSafeEqual(kh, h)) continue;
      if (k.expiresAt && Date.parse(k.expiresAt) <= Date.now()) {
        return { code: 401, error: 'This API key has expired. Create a new one.' };
      }
      if (k.allowedIps && k.allowedIps.length) {
        const clean = String(ip || '').replace(/^::ffff:/, '');
        if (!k.allowedIps.includes(clean)) {
          return { code: 403, error: `Requests from ${clean || 'this address'} are not allowed for this key.` };
        }
      }
      return { user, key: k };
    }
  }
  return { code: 401, error: 'Invalid or revoked API key' };
}

module.exports = { list, create, revoke, authenticate, recordUse, usageTotals, SCOPES };
