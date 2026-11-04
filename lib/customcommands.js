/**
 * Custom bot commands, managed through the public API.
 *
 * Source of truth: bot.customCommands inside db.json. After every change (and every bot
 * start) the enabled commands are written to  <BOT_DIR>/data/custom-commands/<botId>.json.
 * The bot reads that file through utils/customCommands.js and picks up edits live, so
 * nothing needs a restart.
 *
 * Command types:
 *   text     reply with a message (supports {name} {sender} {args} {arg1}..{arg9} {group} {botname} {date} {time})
 *   image    send an image from a public URL with an optional caption
 *   webhook  call your HTTPS endpoint (signed with the command secret) and relay its reply
 *
 * Available to accounts with an active API Pass, like the other write features.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const BOT_DIR = process.env.BOT_DIR || path.join(__dirname, '..', 'bots', 'ladybug');
const DIR = path.join(BOT_DIR, 'data', 'custom-commands');

const TYPES = ['text', 'image', 'webhook'];
const ACCESS = ['everyone', 'admins', 'owner'];
const SCOPES = ['any', 'group', 'private'];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_ALIASES = 5;
const MAX_TEXT = 2000;

const limitFor = (limits) => (limits && limits.pro ? 50 : 0);

function filePath(botId) {
  return path.join(DIR, `${String(botId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function view(c) {
  const { secret, ...rest } = c;
  return { ...rest, hasSecret: !!secret };
}

function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIPv6(h.replace(/^\[|\]$/g, ''));
}

function cleanUrl(value, label, { httpsOnly }) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch (e) { return { error: `${label} must be a valid URL.` }; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !httpsOnly)) {
    return { error: `${label} must start with ${httpsOnly ? 'https://' : 'http:// or https://'}.` };
  }
  if (u.username || u.password) return { error: `${label} must not contain credentials.` };
  if (isPrivateHost(u.hostname)) return { error: `${label} cannot point to a private or internal address.` };
  return { url: u.toString() };
}

/**
 * Validate input for create (full) or update (partial, `existing` given).
 * Returns { value } or { error }.
 */
function validate(input, existing, others) {
  const body = input || {};
  const out = existing ? { ...existing } : {};
  const has = (k) => body[k] !== undefined;

  if (!existing || has('name')) {
    const name = String(body.name || '').trim().toLowerCase().replace(/^[./#!]+/, '');
    if (!NAME_RE.test(name)) return { error: 'name must be 1-32 characters: a-z, 0-9, "-" or "_" (no prefix, no spaces).' };
    out.name = name;
  }
  if (!existing || has('aliases')) {
    const arr = body.aliases == null ? [] : Array.isArray(body.aliases) ? body.aliases : String(body.aliases).split(/[\s,]+/);
    const aliases = [...new Set(arr.map((a) => String(a).trim().toLowerCase().replace(/^[./#!]+/, '')).filter(Boolean))];
    if (aliases.length > MAX_ALIASES) return { error: `At most ${MAX_ALIASES} aliases.` };
    const bad = aliases.find((a) => !NAME_RE.test(a));
    if (bad) return { error: `Alias "${bad}" is not valid (a-z, 0-9, "-" or "_").` };
    out.aliases = aliases;
  }
  if (!existing || has('type')) {
    const type = String(body.type || 'text').toLowerCase();
    if (!TYPES.includes(type)) return { error: `type must be one of: ${TYPES.join(', ')}.` };
    out.type = type;
  }
  if (!existing || has('description')) out.description = String(body.description || '').trim().slice(0, 120);
  if (!existing || has('access')) {
    const access = String(body.access || 'everyone').toLowerCase();
    if (!ACCESS.includes(access)) return { error: `access must be one of: ${ACCESS.join(', ')}.` };
    out.access = access;
  }
  if (!existing || has('scope')) {
    const scope = String(body.scope || 'any').toLowerCase();
    if (!SCOPES.includes(scope)) return { error: `scope must be one of: ${SCOPES.join(', ')}.` };
    out.scope = scope;
  }
  if (!existing || has('cooldownSeconds')) {
    const n = body.cooldownSeconds == null || body.cooldownSeconds === '' ? 0 : Number(body.cooldownSeconds);
    if (!Number.isInteger(n) || n < 0 || n > 3600) return { error: 'cooldownSeconds must be a whole number from 0 to 3600.' };
    out.cooldownSeconds = n;
  }
  if (!existing || has('enabled')) out.enabled = body.enabled === undefined ? true : !!body.enabled;
  if (has('response') || !existing) out.response = String(body.response == null ? (existing ? out.response || '' : '') : body.response).slice(0, MAX_TEXT);

  // type specific requirements
  if (out.type === 'text' && !String(out.response || '').trim()) return { error: 'A text command needs a "response".' };
  if (out.type === 'image') {
    if (!existing || has('imageUrl')) {
      const r = cleanUrl(body.imageUrl, 'imageUrl', { httpsOnly: false });
      if (r.error) return r;
      out.imageUrl = r.url;
    }
  } else delete out.imageUrl;
  if (out.type === 'webhook') {
    if (!existing || has('url')) {
      const r = cleanUrl(body.url, 'url', { httpsOnly: true });
      if (r.error) return r;
      out.url = r.url;
    }
    if (!existing || has('method')) {
      const method = String(body.method || 'POST').toUpperCase();
      if (!['GET', 'POST'].includes(method)) return { error: 'method must be GET or POST.' };
      out.method = method;
    }
    delete out.response;
  } else { delete out.url; delete out.method; }

  // names and aliases must be unique across this bot's commands
  const taken = new Set();
  for (const c of others) { taken.add(c.name); (c.aliases || []).forEach((a) => taken.add(a)); }
  for (const n of [out.name, ...(out.aliases || [])]) {
    if (taken.has(n)) return { code: 409, error: `"${n}" is already used by another custom command on this bot.` };
  }
  if ((out.aliases || []).includes(out.name)) return { error: 'An alias cannot equal the command name.' };
  return { value: out };
}

function list(bot) { return (bot.customCommands || []).map(view); }

function find(bot, idOrName) {
  const key = String(idOrName).toLowerCase();
  return (bot.customCommands || []).find((c) => c.id === idOrName || c.name === key);
}

/** Write the file the bot reads. Only an active API Pass keeps commands live. */
function sync(bot, active) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const commands = active ? (bot.customCommands || []).filter((c) => c.enabled !== false) : [];
    const tmp = `${filePath(bot.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), commands }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath(bot.id));
    return true;
  } catch (e) {
    return false;
  }
}

function purge(botId) {
  try { fs.unlinkSync(filePath(botId)); } catch (e) { /* nothing to remove */ }
}

/** Create / update / delete operate on the bot record and persist through `db`. */
function create(db, bot, limits, input) {
  const max = limitFor(limits);
  if (!max) return { code: 402, error: 'Custom commands need the API Pass.' };
  const existing = bot.customCommands || [];
  if (existing.length >= max) return { code: 400, error: `At most ${max} custom commands per bot.` };
  const v = validate(input, null, existing);
  if (v.error) return v;
  const rec = { id: crypto.randomBytes(5).toString('hex'), ...v.value, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let secret = null;
  if (rec.type === 'webhook') { secret = 'lbc_' + crypto.randomBytes(20).toString('hex'); rec.secret = secret; }
  db.updateBot(bot.id, { customCommands: [...existing, rec] });
  return { command: view(rec), secret };
}

function update(db, bot, idOrName, input) {
  const cur = find(bot, idOrName);
  if (!cur) return { code: 404, error: 'Command not found' };
  const v = validate(input, cur, (bot.customCommands || []).filter((c) => c.id !== cur.id));
  if (v.error) return v;
  const rec = { ...v.value, updatedAt: new Date().toISOString() };
  db.updateBot(bot.id, { customCommands: bot.customCommands.map((c) => (c.id === cur.id ? rec : c)) });
  return { command: view(rec) };
}

function remove(db, bot, idOrName) {
  const cur = find(bot, idOrName);
  if (!cur) return false;
  db.updateBot(bot.id, { customCommands: bot.customCommands.filter((c) => c.id !== cur.id) });
  return true;
}

function rotateSecret(db, bot, idOrName) {
  const cur = find(bot, idOrName);
  if (!cur) return { code: 404, error: 'Command not found' };
  if (cur.type !== 'webhook') return { error: 'Only webhook commands have a signing secret.' };
  const secret = 'lbc_' + crypto.randomBytes(20).toString('hex');
  db.updateBot(bot.id, { customCommands: bot.customCommands.map((c) => (c.id === cur.id ? { ...c, secret } : c)) });
  return { secret };
}

module.exports = { list, find, create, update, remove, rotateSecret, sync, purge, view, filePath, DIR, TYPES, ACCESS, SCOPES, limitFor };
