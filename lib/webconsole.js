/**
 * Web console: "WhatsApp Web" for a bot's own number, served from the dashboard and the API.
 * The bot (utils/webBridge.js) does the work; this module only forwards requests over IPC,
 * rate-limits sending, and relays live events as Server-Sent Events. No message is stored here.
 */
const bots = require('./bots');
const events = require('./events');

const SEND_PER_MINUTE = 20; // guardrail: a human-like pace keeps the number safe
const sends = new Map(); // botId -> [timestamps]
const typingAt = new Map(); // botId -> last 'typing' presence sent
const streams = new Map(); // `${userId}` -> open count
const MAX_STREAMS = 4;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sends) if (!v.some((t) => now - t < 60_000)) sends.delete(k);
}, 120_000).unref();

function fail(res, e) {
  const code = e && e.status ? e.status : 400;
  res.status(code).json({ error: e && e.message ? e.message : 'Request failed' });
}

const intQ = (v, d, min, max) => Math.min(max, Math.max(min, parseInt(v || String(d), 10) || d));


const mediaHits = new Map();
const statusPosts = new Map(); // botId -> [timestamps]
const STATUS_POSTS_PER_HOUR = 10;
const MEDIA_PER_MINUTE = 40;
const edits = new Map(); // botId -> [timestamps] of profile / privacy changes
const EDITS_PER_MINUTE = 8;
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; };
async function profileWrite(bot, res, method, params, timeout = 15000) {
  const now = Date.now();
  const arr = (edits.get(bot.id) || []).filter((t) => now - t < 60_000);
  if (arr.length >= EDITS_PER_MINUTE) return res.status(429).json({ error: 'Too many profile changes in a minute. Wait a bit: WhatsApp restricts accounts that change settings too fast.' });
  arr.push(now);
  edits.set(bot.id, arr);
  try { res.json(await bots.rpc(bot.id, method, params, timeout)); } catch (e) { fail(res, e); }
}

const handlers = {
  async chats(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'chats', { q: String(req.query.q || '').slice(0, 60), limit: intQ(req.query.limit, 100, 1, 300) })); }
    catch (e) { fail(res, e); }
  },
  async messages(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'messages', { jid: String(req.query.jid || ''), limit: intQ(req.query.limit, 50, 1, 200), before: intQ(req.query.before, 0, 0, 4e10) })); }
    catch (e) { fail(res, e); }
  },
  async send(bot, req, res) {
    const b = req.body || {};
    const now = Date.now();
    const arr = (sends.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= SEND_PER_MINUTE) {
      res.setHeader('Retry-After', String(Math.ceil((60_000 - (now - arr[0])) / 1000)));
      return res.status(429).json({ error: `Slow down: at most ${SEND_PER_MINUTE} messages per minute per bot. Sending too fast is a common reason WhatsApp restricts a number.`, guardrail: 'whatsapp-safety' });
    }
    arr.push(now);
    sends.set(bot.id, arr);
    try {
      res.json(await bots.rpc(bot.id, 'send', { jid: String(b.jid || ''), text: b.text, quotedId: b.quotedId, react: b.react, mentions: Array.isArray(b.mentions) ? b.mentions.slice(0, 30) : undefined }, 20000));
    } catch (e) { fail(res, e); }
  },
  async read(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'read', { jid: String((req.body || {}).jid || '') })); }
    catch (e) { fail(res, e); }
  },
  async lookup(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'lookup', { phone: (req.body || {}).phone }, 15000)); }
    catch (e) { fail(res, e); }
  },
  async presence(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'presence', { jid: String(req.query.jid || '') }, 15000)); }
    catch (e) { fail(res, e); }
  },
  async typing(bot, req, res) {
    const b = req.body || {};
    const now = Date.now();
    const last = typingAt.get(bot.id) || 0;
    if (b.on && now - last < 2000) return res.json({ ok: true, skipped: true }); // guardrail: at most one 'typing' per 2 s
    if (b.on) typingAt.set(bot.id, now);
    try { res.json(await bots.rpc(bot.id, 'typing', { jid: String(b.jid || ''), on: !!b.on, mode: b.mode === 'recording' ? 'recording' : undefined })); }
    catch (e) { fail(res, e); }
  },
  /* profile + privacy: reads are free, changes are limited to 8 a minute per bot */
  async profile(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'profileGet', {}, 15000)); } catch (e) { fail(res, e); }
  },
  async profileSet(bot, req, res) { return profileWrite(bot, res, 'profileSet', pick(req.body, ['name', 'about', 'picture', 'removePicture']), 30000); },
  async privacy(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'privacyGet', {}, 15000)); } catch (e) { fail(res, e); }
  },
  async privacySet(bot, req, res) { return profileWrite(bot, res, 'privacySet', pick(req.body, ['key', 'value'])); },
  async blocklist(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'blocklist', {}, 15000)); } catch (e) { fail(res, e); }
  },
  async block(bot, req, res) { return profileWrite(bot, res, 'block', pick(req.body, ['jid', 'block'])); },
  async disappearing(bot, req, res) { return profileWrite(bot, res, 'disappearing', pick(req.body, ['seconds'])); },
  async media(bot, req, res) {
    const now = Date.now();
    const arr = (mediaHits.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= MEDIA_PER_MINUTE) return res.status(429).json({ error: 'Opening files too fast. Try again in a few seconds.' });
    arr.push(now); mediaHits.set(bot.id, arr);
    try { res.json(await bots.rpc(bot.id, 'media', { jid: String(req.query.jid || ''), id: String(req.query.id || '') }, 45000)); } catch (e) { fail(res, e); }
  },
  /* Status viewer (stories). Reads are free; opening media and posting are rate limited. */
  async statuses(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'statuses', {}, 10000)); } catch (e) { fail(res, e); }
  },
  async statusMedia(bot, req, res) {
    const now = Date.now();
    const arr = (mediaHits.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= MEDIA_PER_MINUTE) return res.status(429).json({ error: 'Opening statuses too fast. Try again in a few seconds.' });
    arr.push(now); mediaHits.set(bot.id, arr);
    try { res.json(await bots.rpc(bot.id, 'statusMedia', { poster: String(req.query.poster || ''), id: String(req.query.id || '') }, 60000)); } catch (e) { fail(res, e); }
  },
  async statusSeen(bot, req, res) { return profileWrite(bot, res, 'statusSeen', pick(req.body, ['poster', 'id'])); },
  async statusPost(bot, req, res) {
    const now = Date.now();
    const arr = (statusPosts.get(bot.id) || []).filter((t) => now - t < 3_600_000);
    if (arr.length >= STATUS_POSTS_PER_HOUR) return res.status(429).json({ error: `At most ${STATUS_POSTS_PER_HOUR} status posts per hour, to keep the number safe.`, guardrail: 'whatsapp-safety' });
    arr.push(now); statusPosts.set(bot.id, arr);
    try { res.json(await bots.rpc(bot.id, 'statusPost', pick(req.body, ['text', 'data', 'caption', 'bg', 'font']), 120000)); } catch (e) { fail(res, e); }
  },
  async sendMedia(bot, req, res) {
    const b = req.body || {};
    const now = Date.now();
    const arr = (sends.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= SEND_PER_MINUTE) {
      res.setHeader('Retry-After', String(Math.ceil((60_000 - (now - arr[0])) / 1000)));
      return res.status(429).json({ error: `Slow down: at most ${SEND_PER_MINUTE} messages per minute per bot.`, guardrail: 'whatsapp-safety' });
    }
    arr.push(now); sends.set(bot.id, arr);
    try { res.json(await bots.rpc(bot.id, 'sendMedia', { jid: String(b.jid || ''), data: b.data, name: b.name, caption: b.caption }, 90000)); } catch (e) { fail(res, e); }
  },
  async sendVoice(bot, req, res) {
    const b = req.body || {};
    const now = Date.now();
    const arr = (sends.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= SEND_PER_MINUTE) {
      res.setHeader('Retry-After', String(Math.ceil((60_000 - (now - arr[0])) / 1000)));
      return res.status(429).json({ error: `Slow down: at most ${SEND_PER_MINUTE} messages per minute per bot.`, guardrail: 'whatsapp-safety' });
    }
    arr.push(now); sends.set(bot.id, arr);
    try { res.json(await bots.rpc(bot.id, 'sendVoice', { jid: String(b.jid || ''), data: b.data, mime: b.mime, seconds: b.seconds, quotedId: b.quotedId }, 60000)); } catch (e) { fail(res, e); }
  },
  async search(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'search', { q: String(req.query.q || '').slice(0, 80), limit: intQ(req.query.limit, 40, 1, 100) }, 10000)); } catch (e) { fail(res, e); }
  },
  async deleteMsg(bot, req, res) { return profileWrite(bot, res, 'deleteMsg', pick(req.body, ['jid', 'id'])); },
  async editMsg(bot, req, res) { return profileWrite(bot, res, 'editMsg', pick(req.body, ['jid', 'id', 'text'])); },
  async group(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'group', { jid: String(req.query.jid || '') }, 15000)); } catch (e) { fail(res, e); }
  },
  async avatar(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'avatar', { jid: String(req.query.jid || '') }, 12000)); }
    catch (e) { fail(res, e); }
  },
  async info(bot, req, res) {
    const st = bots.status(bot.id);
    const out = { running: st.running, status: st.status, wa: st.wa, conn: null, me: null };
    if (st.running) {
      try { Object.assign(out, await bots.rpc(bot.id, 'info', {}, 4000)); } catch (e) { /* bot still starting */ }
    }
    res.json(out);
  },
  stream(bot, req, res, userId) {
    const open = streams.get(userId) || 0;
    if (open >= MAX_STREAMS) return res.status(429).json({ error: `At most ${MAX_STREAMS} live consoles open at once.` });
    streams.set(userId, open + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (c) => { res.write(c); if (typeof res.flush === 'function') res.flush(); };
    write('retry: 4000\n\n');
    { const st = bots.status(bot.id); write(`event: hello\ndata: ${JSON.stringify({ running: st.running, status: st.status, wa: st.wa })}\n\n`); }
    const onWa = (e) => {
      if (e.botId !== bot.id) return;
      const { botId, event, ...data } = e;
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onBot = (e) => { if (e.botId === bot.id && ['started', 'stopped', 'crashed', 'online', 'logged_out', 'conflict'].includes(e.type)) write(`event: bot\ndata: ${JSON.stringify({ type: e.type, wa: bots.status(bot.id).wa })}\n\n`); };
    events.bus.on('wa', onWa);
    events.bus.on('bot', onBot);
    const beat = setInterval(() => write(': keep-alive\n\n'), 20_000);
    const maxAge = setTimeout(() => { write('event: end\ndata: {"reason":"max-duration"}\n\n'); res.end(); }, 60 * 60_000);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat); clearTimeout(maxAge);
      events.bus.off('wa', onWa); events.bus.off('bot', onBot);
      streams.set(userId, Math.max(0, (streams.get(userId) || 1) - 1));
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  },
};

module.exports = handlers;
