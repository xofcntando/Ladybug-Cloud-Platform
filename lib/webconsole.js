/**
 * Web console: "WhatsApp Web" for a bot's own number, served from the dashboard and the API.
 * The bot (utils/webBridge.js) does the work; this module only forwards requests over IPC,
 * rate-limits sending, and relays live events as Server-Sent Events. No message is stored here.
 */
const bots = require('./bots');
const events = require('./events');
const book = require('./wa-book');

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
const MEDIA_PER_MINUTE = 40;
const trCache = new Map(); // "from|to|text" -> { text, at } for the translator
const statusPosts = new Map(); // botId -> [timestamps] of status updates
const STATUS_PER_HOUR = 10;
const edits = new Map(); // botId -> [timestamps] of profile / privacy changes
const EDITS_PER_MINUTE = 8;
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; };

/* ---------------------------------------------------------------- Translation helpers
 * Google's free endpoint is the best quality but it throttles unknown callers, so we walk a
 * short ladder of providers and use the first one that answers. Everything stays server-side:
 * the bot's number never talks to a translation service. */
async function fetchJson(url, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) LadybugCloud/1.0' } });
    if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function googleTranslate(text, from, to, client) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=' + client +
    '&sl=' + encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) +
    '&dt=t&q=' + encodeURIComponent(text);
  const data = await fetchJson(url);
  const segs = (data && data[0]) || [];
  const out = segs.map((seg) => (seg && seg[0]) || '').join('').trim();
  if (!out) throw new Error('empty');
  return { text: out, detected: (data && data[2]) || null, via: client };
}

async function myMemoryTranslate(text, from, to) {
  const pair = encodeURIComponent((from === 'auto' ? 'Autodetect' : from) + '|' + to);
  const data = await fetchJson('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + pair, 12000);
  const out = data && data.responseData && data.responseData.translatedText;
  if (!out || /MYMEMORY WARNING|INVALID SOURCE LANGUAGE/i.test(out)) throw new Error('empty');
  return { text: String(out).trim(), detected: (data.responseData.detectedLanguage) || null, via: 'mymemory' };
}

async function translateText(text, from, to) {
  const ladder = [
    () => googleTranslate(text, from, to, 'gtx'),
    () => googleTranslate(text, from, to, 'dict-chrome-ex'),
    () => myMemoryTranslate(text, from, to),
  ];
  let last = null;
  for (const step of ladder) {
    try {
      const out = await step();
      if (out && out.text) return out;
    } catch (e) { last = e; }
  }
  throw new Error((last && last.message) || 'no provider answered');
}
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
    try {
      const r = await bots.rpc(bot.id, 'chats', { q: String(req.query.q || '').slice(0, 60), limit: intQ(req.query.limit, 100, 1, 300) });
      // names saved from the console win over WhatsApp push names
      const names = book.contacts(bot.id);
      for (const c of r.chats || []) if (!c.isGroup && names[c.jid]) c.name = names[c.jid];
      res.json(r);
    }
    catch (e) { fail(res, e); }
  },
  async messages(bot, req, res) {
    try {
      const r = await bots.rpc(bot.id, 'messages', { jid: String(req.query.jid || ''), limit: intQ(req.query.limit, 50, 1, 200), before: intQ(req.query.before, 0, 0, 4e10) });
      const saved = book.contacts(bot.id)[String(req.query.jid || '')];
      if (saved && r && r.chat && !r.chat.isGroup) r.chat.name = saved;
      res.json(r);
    }
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
  /** Poll / location / contact: same 20-a-minute guardrail as normal messages. */
  rich(method, pickKeys) {
    return async (bot, req, res) => {
      const b = req.body || {};
      const now = Date.now();
      const arr = (sends.get(bot.id) || []).filter((t) => now - t < 60_000);
      if (arr.length >= SEND_PER_MINUTE) {
        res.setHeader('Retry-After', String(Math.ceil((60_000 - (now - arr[0])) / 1000)));
        return res.status(429).json({ error: `Slow down: at most ${SEND_PER_MINUTE} messages per minute per bot.`, guardrail: 'whatsapp-safety' });
      }
      arr.push(now); sends.set(bot.id, arr);
      const params = {};
      for (const k of pickKeys) params[k] = b[k];
      try { res.json(await bots.rpc(bot.id, method, params, 30000)); } catch (e) { fail(res, e); }
    };
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

  /* ---------------------------------------------------------------- Anti-delete */
  /** Messages other people deleted for everyone, with the original text preserved by the bot. */
  async deleted(bot, req, res) {
    try {
      const r = await bots.rpc(bot.id, 'deletedList', {
        jid: String(req.query.jid || '').slice(0, 80),
        limit: intQ(req.query.limit, 200, 1, 300),
      }, 10000);
      res.json(r);
    } catch (e) { fail(res, e); }
  },
  async deletedClear(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'deletedClear', { jid: String((req.body || {}).jid || '').slice(0, 80) }, 10000)); }
    catch (e) { fail(res, e); }
  },

  /* ---------------------------------------------------------------- Analytics */
  async analytics(bot, req, res) {
    try { res.json(await bots.rpc(bot.id, 'analytics', { days: intQ(req.query.days, 7, 1, 90) }, 20000)); }
    catch (e) { fail(res, e); }
  },

  /* ---------------------------------------------------------------- Translation */
  /**
   * Translate a message. Runs on the platform (not the bot) so the phone's number never
   * talks to a third party. Results are cached for an hour; failures degrade to the original.
   */
  async translate(bot, req, res) {
    const text = String((req.body || {}).text || '').slice(0, 4000).trim();
    const to = String((req.body || {}).to || 'en').slice(0, 8).toLowerCase();
    const from = String((req.body || {}).from || 'auto').slice(0, 8).toLowerCase();
    if (!text) return res.status(400).json({ error: 'Nothing to translate' });
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$|^auto$/.test(to) || !/^[a-z]{2,3}(-[a-z]{2,4})?$|^auto$/.test(from)) {
      return res.status(400).json({ error: 'Unsupported language code' });
    }
    const key = from + '|' + to + '|' + text;
    const hit = trCache.get(key);
    if (hit && Date.now() - hit.at < 3600_000) return res.json({ text: hit.text, to, from, cached: true });
    try {
      const out = await translateText(text, from, to);
      trCache.set(key, { text: out.text, at: Date.now() });
      if (trCache.size > 500) trCache.delete(trCache.keys().next().value);
      res.json({ text: out.text, to, from, detected: out.detected || null, via: out.via, cached: false });
    } catch (e) {
      res.status(502).json({ error: 'Translation is unavailable right now. ' + (e && e.message ? e.message : '') });
    }
  },
  async deleteMsg(bot, req, res) { return profileWrite(bot, res, 'deleteMsg', pick(req.body, ['jid', 'id'])); },
  async editMsg(bot, req, res) { return profileWrite(bot, res, 'editMsg', pick(req.body, ['jid', 'id', 'text'])); },
  /* ---------------------------------------------------------------- Status (stories) */
  async statusList(bot, req, res) {
    try {
      const r = await bots.rpc(bot.id, 'statusList', {}, 15000);
      const names = book.contacts(bot.id);
      for (const g of r.groups || []) if (!g.mine && names[g.jid]) g.name = names[g.jid];
      res.json(r);
    } catch (e) { fail(res, e); }
  },
  async statusMedia(bot, req, res) {
    const now = Date.now();
    const arr = (mediaHits.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= MEDIA_PER_MINUTE) return res.status(429).json({ error: 'Opening statuses too fast. Try again in a few seconds.' });
    arr.push(now); mediaHits.set(bot.id, arr);
    try { res.json(await bots.rpc(bot.id, 'statusMedia', { id: String(req.query.id || '') }, 60000)); } catch (e) { fail(res, e); }
  },
  async statusSeen(bot, req, res) {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String).slice(0, 30) : [];
    try { res.json(await bots.rpc(bot.id, 'statusSeen', { ids }, 20000)); } catch (e) { fail(res, e); }
  },
  /** Posting a status reaches every contact at once, so it is held to 10 an hour per bot. */
  async statusPost(bot, req, res) {
    const b = req.body || {};
    const now = Date.now();
    const arr = (statusPosts.get(bot.id) || []).filter((t) => now - t < 3_600_000);
    if (arr.length >= STATUS_PER_HOUR) {
      res.setHeader('Retry-After', String(Math.ceil((3_600_000 - (now - arr[0])) / 1000)));
      return res.status(429).json({ error: `At most ${STATUS_PER_HOUR} status updates an hour per number. Posting more is a quick way to get a number restricted.`, guardrail: 'whatsapp-safety' });
    }
    arr.push(now); statusPosts.set(bot.id, arr);
    try {
      res.json(await bots.rpc(bot.id, 'statusPost', {
        kind: b.kind === 'media' ? 'media' : 'text', text: b.text, bg: b.bg, font: b.font, data: b.data, name: b.name, caption: b.caption,
        audience: Array.isArray(b.audience) ? b.audience.map(String).slice(0, 1000) : undefined,
      }, 90000));
    } catch (e) { arr.pop(); fail(res, e); }
  },
  async statusDelete(bot, req, res) { return profileWrite(bot, res, 'statusDelete', pick(req.body, ['id']), 30000); },

  /* ---------------------------------------------------------------- Media, docs and links gallery */
  async gallery(bot, req, res) {
    const kind = ['media', 'docs', 'links'].includes(String(req.query.kind)) ? String(req.query.kind) : 'media';
    try { res.json(await bots.rpc(bot.id, 'gallery', { jid: String(req.query.jid || ''), kind, limit: intQ(req.query.limit, 120, 1, 300) }, 10000)); } catch (e) { fail(res, e); }
  },

  /* ---------------------------------------------------------------- Contacts */
  async contacts(bot, req, res) {
    const saved = book.contacts(bot.id);
    let list = [];
    try { list = (await bots.rpc(bot.id, 'contactsList', {}, 10000)).contacts || []; } catch (e) { /* bot offline: show what we stored */ }
    const seen = new Set(list.map((c) => c.jid));
    for (const [jid, name] of Object.entries(saved)) {
      if (seen.has(jid)) { const c = list.find((x) => x.jid === jid); c.name = name; c.mine = true; }
      else list.push({ jid, name, phone: jid.split('@')[0].split(':')[0], saved: true, mine: true });
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ contacts: list });
  },
  async contactAdd(bot, req, res) {
    const now = Date.now();
    const arr = (edits.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= EDITS_PER_MINUTE) return res.status(429).json({ error: 'Adding contacts too fast. Wait a minute and try again.' });
    arr.push(now); edits.set(bot.id, arr);
    const b = req.body || {};
    try {
      const r = await bots.rpc(bot.id, 'contactAdd', { phone: b.phone, name: b.name }, 25000);
      if (r && r.ok) book.saveContact(bot.id, r.jid, r.name);
      res.status(r && r.ok ? 200 : 404).json(r);
    } catch (e) { fail(res, e); }
  },
  async contactRemove(bot, req, res) {
    const jid = String((req.body || {}).jid || '');
    try {
      let r = { ok: true, synced: false };
      try { r = await bots.rpc(bot.id, 'contactRemove', { jid }, 20000); } catch (e) { if (!/not running|not connected/i.test(e.message || '')) throw e; }
      book.forgetContact(bot.id, jid);
      res.json(r);
    } catch (e) { fail(res, e); }
  },

  /* ---------------------------------------------------------------- Automation: always online, auto-view / auto-save status */
  async automation(bot, req, res) {
    const saved = book.autoFor(bot.id);
    let live = null;
    try { live = await bots.rpc(bot.id, 'autoGet', {}, 6000); } catch (e) { /* bot offline: show what is saved */ }
    res.json({
      running: !!live, saved,
      online: live ? live.online : saved.online === true,
      viewStatus: live ? live.viewStatus : saved.viewStatus === true,
      saveStatus: live ? live.saveStatus : saved.saveStatus === true,
      readReceipts: live ? live.readReceipts : saved.readReceipts === true,
      rejectCalls: live ? live.rejectCalls : saved.rejectCalls === true,
      away: live ? live.away : (saved.away || null),
      rules: live ? (live.rules || []) : (saved.rules || []),
      saveSupported: live ? live.saveSupported : true,
      connected: live ? live.connected : false,
    });
  },
  async automationSet(bot, req, res) {
    const now = Date.now();
    const arr = (edits.get(bot.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= EDITS_PER_MINUTE) return res.status(429).json({ error: 'Changing settings too fast. Wait a minute and try again.' });
    arr.push(now); edits.set(bot.id, arr);
    try {
      const { saved, changed } = book.setAuto(bot.id, pick(req.body, ['online', 'viewStatus', 'saveStatus', 'readReceipts', 'rejectCalls', 'away', 'rules']));
      let live = null;
      try { live = await bots.rpc(bot.id, 'autoSet', changed, 10000); } catch (e) { /* bot offline: applied on next start */ }
      res.json({ ok: true, saved, applied: !!live, saveSupported: live ? live.saveSupported : true });
    } catch (e) { fail(res, e); }
  },

  /* ---------------------------------------------------------------- Chat labels (platform side, work offline) */
  labels(bot, req, res) { res.json(book.labelsView(bot.id)); },
  labelCreate(bot, req, res) { try { res.json(book.createLabel(bot.id, req.body)); } catch (e) { fail(res, e); } },
  labelUpdate(bot, req, res) { try { res.json(book.updateLabel(bot.id, String(req.params.labelId), req.body)); } catch (e) { fail(res, e); } },
  labelDelete(bot, req, res) { try { res.json(book.deleteLabel(bot.id, String(req.params.labelId))); } catch (e) { fail(res, e); } },
  labelAssign(bot, req, res) { try { res.json(book.assign(bot.id, req.body)); } catch (e) { fail(res, e); } },
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
