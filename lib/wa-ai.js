/* Ladybug Chat - AI assistant (bring your own key).
   --------------------------------------------------
   The console promises that message content stays on the user's own server. An AI feature
   would break that promise if it shipped with a platform key, so this module only ever runs
   with a key the user pastes in themselves, against a provider they choose. If no key is
   configured the endpoints answer 409 and the UI shows a "set up your provider" panel.

   Provider shape: any OpenAI-compatible API.
     POST {baseUrl}/chat/completions      { model, messages, temperature, max_tokens }
     POST {baseUrl}/audio/transcriptions  multipart, file + model

   That covers OpenAI, Groq, Together, OpenRouter, Fireworks, DeepInfra, vLLM, LM Studio,
   Ollama's OpenAI shim and most self-hosted gateways. Nothing is hard-coded to a vendor.

   Security:
   - the key is stored server-side and only ever returned masked (last 4 characters);
   - baseUrl must be https, except http on loopback so a local model can be used;
   - the hostname is resolved and private / link-local / metadata addresses are refused,
     so a user cannot point the platform at its own internal network (SSRF);
   - requests time out, and error bodies are truncated before they reach the browser.
*/
'use strict';

const dns = require('dns').promises;
const net = require('net');
const db = require('./store');

const MAX_KEY = 400;
const MAX_MODEL = 80;
const MAX_URL = 300;
const TIMEOUT_MS = 45_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_CHARS = 24_000;

function store(create) {
  const d = db.data;
  if (!d.ai || typeof d.ai !== 'object') {
    if (!create) return null;
    d.ai = {};
  }
  return d.ai;
}

function cfgFor(userId) {
  const s = store(false);
  return (s && s[String(userId)]) || null;
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 3) + '…' + k.slice(-4);
}

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function privateIp(ip) {
  const v = String(ip || '');
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;           // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // carrier-grade NAT
    if (p[0] >= 224) return true;                            // multicast / reserved
    return false;
  }
  if (net.isIPv6(v)) {
    const low = v.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return privateIp(mapped[1]);
    return false;
  }
  return true; // not an address we understand: refuse it
}

/** Validates a provider base URL and proves the host is not internal. */
async function assertProvider(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw bad('That provider URL is not a valid address'); }
  const loop = isLoopback(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) {
    throw bad('The provider URL must start with https:// (http is only allowed for a local model)');
  }
  if (u.username || u.password) throw bad('Do not put credentials in the URL - use the API key field');
  if (loop) return u;
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); }
  catch (e) { throw bad('Could not resolve that provider host'); }
  if (!addrs.length) throw bad('Could not resolve that provider host');
  for (const a of addrs) {
    if (privateIp(a.address)) throw bad('That provider address is on a private network, which is not allowed');
  }
  return u;
}

function bad(msg, status) {
  return Object.assign(new Error(msg), { status: status || 400 });
}

function settings(userId) {
  const c = cfgFor(userId);
  if (!c || !c.apiKey) return { configured: false, baseUrl: '', model: '', keyMask: '', updatedAt: null };
  return {
    configured: true,
    baseUrl: c.baseUrl,
    model: c.model,
    keyMask: maskKey(c.apiKey),
    updatedAt: c.updatedAt || null,
  };
}

async function save(userId, body) {
  const b = body || {};
  if (b.clear === true) {
    const s = store(true);
    delete s[String(userId)];
    db.save();
    return settings(userId);
  }
  const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(b.model || '').trim().slice(0, MAX_MODEL);
  let apiKey = String(b.apiKey || '').trim().slice(0, MAX_KEY);
  if (!baseUrl) throw bad('Enter the provider base URL, for example https://api.openai.com/v1');
  if (!model) throw bad('Enter the model name, for example gpt-4o-mini');
  const existing = cfgFor(userId);
  if (!apiKey) {
    if (existing && existing.apiKey) apiKey = existing.apiKey; // keep the saved key when the field is left blank
    else throw bad('Paste your API key');
  }
  if (apiKey.length < 8) throw bad('That API key looks too short');
  await assertProvider(baseUrl);
  const s = store(true);
  s[String(userId)] = { baseUrl, model, apiKey, updatedAt: Date.now() };
  db.save();
  return settings(userId);
}

function requireCfg(userId) {
  const c = cfgFor(userId);
  if (!c || !c.apiKey) throw bad('Add your AI provider first (AI button in the WhatsApp console).', 409);
  return c;
}

async function withTimeout(fn, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fn(ctl.signal); }
  catch (e) {
    if (e && e.name === 'AbortError') throw bad('The AI provider took too long to answer', 504);
    throw e;
  } finally { clearTimeout(timer); }
}

async function readError(r) {
  let text = '';
  try { text = await r.text(); } catch (e) { text = ''; }
  let msg = '';
  try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { msg = text; }
  msg = String(msg || '').replace(/\s+/g, ' ').slice(0, 240);
  if (r.status === 401 || r.status === 403) return bad('The provider rejected the API key' + (msg ? ': ' + msg : ''), 401);
  if (r.status === 429) return bad('The provider is rate limiting this key. Try again shortly.', 429);
  return bad('The provider answered HTTP ' + r.status + (msg ? ': ' + msg : ''), 502);
}

async function chat(userId, messages, opts) {
  const c = requireCfg(userId);
  const o = opts || {};
  const body = {
    model: c.model,
    messages,
    temperature: typeof o.temperature === 'number' ? o.temperature : 0.4,
  };
  if (o.maxTokens) body.max_tokens = Math.min(2000, Math.max(32, o.maxTokens));
  const r = await withTimeout((signal) => fetch(c.baseUrl + '/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify(body),
  }), TIMEOUT_MS);
  if (!r.ok) throw await readError(r);
  let j;
  try { j = await r.json(); } catch (e) { throw bad('The provider sent a response this app could not read', 502); }
  const choice = j && j.choices && j.choices[0];
  const text = choice && choice.message && String(choice.message.content || '').trim();
  if (!text) throw bad('The provider returned an empty answer', 502);
  const usage = j.usage || {};
  return {
    text: text.slice(0, 12_000),
    model: j.model || c.model,
    tokens: { in: usage.prompt_tokens || null, out: usage.completion_tokens || null },
  };
}

async function transcribe(userId, body) {
  const c = requireCfg(userId);
  const b = body || {};
  const data = String(b.data || '');
  if (!data) throw bad('No audio was sent');
  let buf;
  try { buf = Buffer.from(data, 'base64'); } catch (e) { throw bad('The audio could not be decoded'); }
  if (!buf.length) throw bad('The audio is empty');
  if (buf.length > MAX_AUDIO_BYTES) throw bad('That voice note is too large to transcribe (8 MB limit)', 413);
  const mime = String(b.mime || 'audio/ogg').slice(0, 60);
  const name = String(b.name || 'voice.ogg').replace(/[^\w.\-]/g, '').slice(0, 40) || 'voice.ogg';

  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), name);
  form.append('model', c.model);

  const r = await withTimeout((signal) => fetch(c.baseUrl + '/audio/transcriptions', {
    method: 'POST',
    signal,
    headers: { Authorization: 'Bearer ' + c.apiKey },
    body: form,
  }), TIMEOUT_MS);
  if (!r.ok) throw await readError(r);
  let j;
  try { j = await r.json(); } catch (e) { throw bad('The provider sent a response this app could not read', 502); }
  const text = String((j && j.text) || '').trim();
  if (!text) throw bad('No speech was recognised in that voice note', 502);
  return { text: text.slice(0, 8000), model: c.model };
}

/* ------------------------------------------------------------------ prompts
 * Built here rather than in the browser so the wording is consistent and the transcript
 * length is capped before it is sent anywhere. */

function transcript(messages, limit) {
  const list = Array.isArray(messages) ? messages.slice(-(limit || 80)) : [];
  const lines = [];
  for (const m of list) {
    if (!m) continue;
    const who = m.fromMe ? 'Me' : (m.senderName || m.name || 'Them');
    let body = String(m.text || '').trim();
    if (!body && m.type) body = `[${m.type}${m.media && m.media.mime ? ' ' + m.media.mime : ''}]`;
    if (!body) continue;
    lines.push(`${who}: ${body}`);
  }
  return lines.join('\n').slice(-MAX_INPUT_CHARS);
}

const SYSTEM = 'You are a careful assistant inside a WhatsApp web client. You write short, natural, '
  + 'human messages. Never invent facts, prices, dates or promises that are not in the conversation. '
  + 'Never mention that you are an AI. Match the language the people are already using.';

async function suggestReplies(userId, messages, count) {
  const t = transcript(messages, 40);
  if (!t) throw bad('There is nothing to reply to in this chat yet');
  const n = Math.min(4, Math.max(1, Number(count) || 3));
  const out = await chat(userId, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Conversation so far:\n\n${t}\n\nWrite ${n} different replies I could send next. Each must be one short message, under 220 characters, ready to send as-is. Number them 1. 2. 3. with no other text.` },
  ], { maxTokens: 400, temperature: 0.7 });
  const replies = out.text.split('\n')
    .map((l) => l.replace(/^\s*\d+[).:\-]\s*/, '').trim())
    .filter((l) => l && l.length <= 400)
    .slice(0, n);
  return { replies: replies.length ? replies : [out.text], model: out.model };
}

async function summarize(userId, messages) {
  const t = transcript(messages, 120);
  if (!t) throw bad('There is nothing to summarise in this chat yet');
  const out = await chat(userId, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Summarise this WhatsApp conversation for someone catching up. Use this shape:\n\nSummary: two or three sentences.\nOpen questions: bullet list, or "none".\nPromises or deadlines: bullet list, or "none".\nNext step: one sentence.\n\nConversation:\n\n${t}` },
  ], { maxTokens: 600, temperature: 0.2 });
  return { text: out.text, model: out.model };
}

const TONES = ['shorter', 'friendlier', 'more formal', 'more apologetic', 'more confident'];

async function rewrite(userId, text, tone) {
  const body = String(text || '').trim();
  if (!body) throw bad('Write something first, then ask for a rewrite');
  if (body.length > 4000) throw bad('That message is too long to rewrite');
  const t = TONES.includes(String(tone)) ? String(tone) : 'shorter';
  const out = await chat(userId, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Rewrite the message below so it is ${t}. Keep the meaning and any facts. Reply with the rewritten message only, no quotes, no explanation.\n\n${body}` },
  ], { maxTokens: 500, temperature: 0.5 });
  return { text: out.text.replace(/^["']|["']$/g, '').trim(), tone: t, model: out.model };
}

/* ------------------------------------------------------------------ auto-respond
 * Used by the bot itself (not the console buttons): when the owner turns "AI auto-respond"
 * on, the bot asks the platform for a reply to each incoming direct message. The key never
 * leaves the platform. The model may answer HANDOFF_TOKEN when it cannot answer safely, in
 * which case the bot falls back to the built-in brain / away message and a human takes over. */

const HANDOFF_TOKEN = '[[HANDOFF]]';
const AUTO_SYSTEM = 'You are replying to customers on WhatsApp on behalf of the owner of this account. '
  + 'Write short, warm, natural messages (normally 1-3 sentences, never more than 600 characters). '
  + 'Match the language the customer is writing in. Never say you are an AI unless asked directly, and then be honest. '
  + 'Only state facts, prices, dates, availability or policies that appear in the owner instructions or earlier '
  + 'messages of this conversation - never invent them. '
  + 'If the customer asks for a human, is angry, wants a refund or cancellation, needs something you cannot know, '
  + 'or you are not sure how to answer safely, reply with exactly ' + HANDOFF_TOKEN + ' and nothing else. '
  + 'Do not use markdown headings. Do not repeat the customer\'s message back.';

/** history: [{ fromMe, text, ts }], oldest first, the newest customer message last. */
async function autoReply(userId, history, instructions) {
  const t = transcript(history, 14);
  if (!t) throw bad('There is nothing to reply to');
  const owner = String(instructions || '').trim().slice(0, 1500);
  const out = await chat(userId, [
    { role: 'system', content: AUTO_SYSTEM + (owner ? '\n\nOwner instructions and business facts:\n' + owner : '\n\nThe owner has not written any business facts, so only help with general courtesy and hand off anything specific.') },
    { role: 'user', content: `Conversation so far (Me = the business, Them = the customer):\n\n${t}\n\nWrite the next reply from the business. Output only the message text, or ${HANDOFF_TOKEN}.` },
  ], { temperature: 0.3, maxTokens: 300 });
  let text = out.text.replace(/^["'\s]+|["'\s]+$/g, '').replace(/^Me:\s*/i, '').trim();
  if (!text || text.includes(HANDOFF_TOKEN)) return { handoff: true, model: out.model };
  return { handoff: false, text: text.slice(0, 600), model: out.model };
}

function isConfigured(userId) {
  const c = cfgFor(userId);
  return !!(c && c.apiKey);
}

module.exports = {
  settings, save, chat, transcribe, suggestReplies, summarize, rewrite, autoReply, isConfigured, HANDOFF_TOKEN,
  assertProvider, privateIp, maskKey, TONES, MAX_AUDIO_BYTES,
};
