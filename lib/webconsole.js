/**
 * Web console: "WhatsApp Web" for a bot's own number, served from the dashboard and the API.
 * The bot (utils/webBridge.js) does the work; this module only forwards requests over IPC,
 * rate-limits sending, and relays live events as Server-Sent Events. No message is stored here.
 */
const bots = require('./bots');
const events = require('./events');

const SEND_PER_MINUTE = 20; // guardrail: a human-like pace keeps the number safe
const sends = new Map(); // botId -> [timestamps]
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
      res.json(await bots.rpc(bot.id, 'send', { jid: String(b.jid || ''), text: b.text, quotedId: b.quotedId, react: b.react }, 20000));
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
  stream(bot, req, res, userId) {
    const open = streams.get(userId) || 0;
    if (open >= MAX_STREAMS) return res.status(429).json({ error: `At most ${MAX_STREAMS} live consoles open at once.` });
    streams.set(userId, open + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (c) => { res.write(c); if (typeof res.flush === 'function') res.flush(); };
    write('retry: 4000\n\n');
    write(`event: hello\ndata: ${JSON.stringify({ running: bots.status(bot.id).running })}\n\n`);
    const onWa = (e) => {
      if (e.botId !== bot.id) return;
      const { botId, event, ...data } = e;
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onBot = (e) => { if (e.botId === bot.id && ['started', 'stopped', 'crashed', 'online', 'logged_out'].includes(e.type)) write(`event: bot\ndata: ${JSON.stringify({ type: e.type })}\n\n`); };
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
