/**
 * Crash alerts (paid feature). Sends a small JSON message to a webhook the user
 * provides (Discord, Slack or any HTTPS endpoint) when their bot crashes or
 * comes back online.
 *
 * The webhook URL is user-supplied, so every request is guarded against SSRF:
 * HTTPS only, standard port, no credentials in the URL, every resolved address
 * must be public, redirects are never followed, and requests time out.
 */
const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 60 * 1000; // at most one alert per bot per minute
const lastSent = new Map(); // botId -> timestamp

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]);
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  return true;
}

/** Throws if the URL is not an acceptable public HTTPS webhook. Returns the parsed URL. */
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('That is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new Error('The webhook URL must start with https://');
  if (u.username || u.password) throw new Error('Remove the username/password from the URL.');
  if (u.port && u.port !== '443') throw new Error('Only the standard HTTPS port is allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is not allowed.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address is not allowed.');
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error('Could not find that host.'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not allowed.');
  return u;
}

async function post(url, payload) {
  const u = await assertSafeUrl(url);
  const res = await fetch(u, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'LadybugCloud-Alerts/1.0' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300) throw new Error(`The webhook answered with HTTP ${res.status}.`);
  return true;
}

function build(event, bot, detail) {
  const icon = event === 'crashed' ? '\u{1F534}' : event === 'online' ? '\u{1F7E2}' : '\u{1F514}';
  const text =
    event === 'crashed' ? `${icon} Your bot "${bot.name}" went down${detail ? `: ${detail}` : '.'}`
    : event === 'online' ? `${icon} Your bot "${bot.name}" is back online.`
    : `${icon} ${detail || 'Test alert from Ladybug Cloud. Your webhook works!'}`;
  // "content" = Discord, "text" = Slack and most others; the rest is for custom receivers.
  return { content: text, text, event, bot: bot.name, detail: detail || null, at: new Date().toISOString() };
}

/** Fire-and-forget alert for a bot event. Never throws. */
async function notify(user, bot, event, detail) {
  try {
    const billing = require('./billing');
    if (!user || !user.alertWebhook || !billing.featureActive(user, 'alerts')) return;
    const now = Date.now();
    const k = `${bot.id}:${event}`;
    if (now - (lastSent.get(k) || 0) < MIN_GAP_MS) return;
    lastSent.set(k, now);
    await post(user.alertWebhook, build(event, bot, detail));
  } catch (e) {
    console.error('[alerts] could not deliver alert:', e.message);
  }
}

async function sendTest(url) {
  await post(url, build('test', { name: 'Test bot' }, null));
}

module.exports = { notify, sendTest, assertSafeUrl, isPrivateIp };
