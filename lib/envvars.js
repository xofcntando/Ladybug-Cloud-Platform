/**
 * Custom environment variables for a bot (paid feature "Custom bot settings").
 * Users can set things like PREFIX or OWNER_NUMBER without touching bot code.
 * Keys that could change how the host or Node itself behaves are refused.
 */
const MAX_VARS = 20;
const MAX_VALUE = 500;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,39}$/;

const BLOCKED_EXACT = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR', 'TMP', 'TEMP', 'PORT', 'HOSTNAME',
  'DATA_DIR', 'BOT_DIR', 'RENDER_EXTERNAL_URL', 'KEEP_ALIVE',
]);
const BLOCKED_PREFIX = [
  'NODE_', 'NPM_', 'LD_', 'DYLD_', 'SESSION_', 'ADMIN_', 'MONGO', 'PAYMENT_', 'RENDER_', 'BOT_NAME',
];

function isBlocked(key) {
  return BLOCKED_EXACT.has(key) || BLOCKED_PREFIX.some((p) => key.startsWith(p));
}

/**
 * Validate and normalise a { KEY: value } object.
 * @returns {{ ok: true, env: object } | { ok: false, error: string }}
 */
function sanitize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Send the variables as an object of KEY: value pairs.' };
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_VARS) return { ok: false, error: `You can set at most ${MAX_VARS} variables.` };
  const env = {};
  for (const [rawKey, rawVal] of entries) {
    const key = String(rawKey).trim().toUpperCase();
    if (!KEY_RE.test(key)) {
      return { ok: false, error: `"${rawKey}" is not a valid name. Use capital letters, numbers and _ (max 40 characters, must start with a letter).` };
    }
    if (isBlocked(key)) return { ok: false, error: `${key} is reserved by the platform and cannot be changed.` };
    if (typeof rawVal !== 'string' && typeof rawVal !== 'number' && typeof rawVal !== 'boolean') {
      return { ok: false, error: `${key} must be text.` };
    }
    const val = String(rawVal);
    if (val.length > MAX_VALUE) return { ok: false, error: `${key} is too long (max ${MAX_VALUE} characters).` };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(val)) return { ok: false, error: `${key} contains invalid characters.` };
    if (key in env) return { ok: false, error: `${key} is listed twice.` };
    env[key] = val;
  }
  return { ok: true, env };
}

module.exports = { sanitize, isBlocked, MAX_VARS, MAX_VALUE };
