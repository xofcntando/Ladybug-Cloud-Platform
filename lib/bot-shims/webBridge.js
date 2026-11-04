/**
 * Ladybug Cloud - Web console bridge (bot side)
 *
 * Lets the dashboard behave like WhatsApp Web for this bot's number: list chats, read a
 * conversation, send text, reply, react, mark as read. Talks to the platform over the
 * child-process IPC channel, so nothing is exposed on the network. Messages are kept in
 * memory only (a small ring per chat) and are never written to disk.
 *
 * This file is copied into bots/ladybug/utils/ by the platform. Edit lib/bot-shims/webBridge.js
 * in the platform repo instead.
 */
const MAX_CHATS = 300;
const MAX_PER_CHAT = 200;
const MAX_TEXT = 4096;

const enabled = typeof process.send === 'function' && process.env.LADYBUG_WEB === '1';

const chats = new Map(); // jid -> chat
const msgs = new Map(); //  jid -> [message]
const contacts = new Map(); // jid -> name
let sock = null;
let wired = false;

const isGroup = (jid) => String(jid).endsWith('@g.us');
const okJid = (jid) => /^[0-9A-Za-z._:-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(String(jid || ''));
const num = (jid) => String(jid || '').split('@')[0].split(':')[0];
const tsOf = (t) => (t && typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t) || 0);

function unwrap(m) {
  let x = m || {};
  for (let i = 0; i < 4; i++) {
    x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message ||
      x.documentWithCaptionMessage?.message || x.editedMessage?.message?.protocolMessage?.editedMessage || x;
  }
  return x;
}

function describe(message) {
  const m = unwrap(message);
  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { type: 'image', text: m.imageMessage.caption || '' };
  if (m.videoMessage) return { type: 'video', text: m.videoMessage.caption || '' };
  if (m.audioMessage) return { type: m.audioMessage.ptt ? 'voice' : 'audio', text: '' };
  if (m.documentMessage) return { type: 'document', text: m.documentMessage.fileName || m.documentMessage.caption || '' };
  if (m.stickerMessage) return { type: 'sticker', text: '' };
  if (m.contactMessage) return { type: 'contact', text: m.contactMessage.displayName || '' };
  if (m.locationMessage) return { type: 'location', text: m.locationMessage.name || '' };
  if (m.reactionMessage) return { type: 'reaction', text: m.reactionMessage.text || '' };
  if (m.pollCreationMessage || m.pollCreationMessageV3) return { type: 'poll', text: (m.pollCreationMessage || m.pollCreationMessageV3).name || '' };
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null;
  return { type: 'other', text: '' };
}

function label(d) {
  if (!d) return '';
  const t = { image: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', document: 'Document', sticker: 'Sticker', contact: 'Contact', location: 'Location', poll: 'Poll', other: 'Message' }[d.type];
  return t ? (d.text ? `${t}: ${d.text}` : t) : d.text;
}

function chatView(c) {
  return { jid: c.jid, name: c.name || contacts.get(c.jid) || (isGroup(c.jid) ? 'Group' : '+' + num(c.jid)), isGroup: isGroup(c.jid), unread: c.unread || 0, lastTs: c.lastTs || 0, lastText: c.lastText || '', lastFromMe: !!c.lastFromMe };
}

function ensureChat(jid) {
  let c = chats.get(jid);
  if (!c) {
    c = { jid, name: contacts.get(jid) || null, unread: 0, lastTs: 0, lastText: '', lastFromMe: false };
    chats.set(jid, c);
    if (chats.size > MAX_CHATS) {
      const oldest = [...chats.values()].sort((a, b) => a.lastTs - b.lastTs)[0];
      if (oldest) { chats.delete(oldest.jid); msgs.delete(oldest.jid); }
    }
  }
  return c;
}

function ingest(m, live) {
  try {
    const jid = m.key && m.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return null;
    const d = describe(m.message);
    if (!d) return null;
    const list = msgs.get(jid) || [];
    if (list.some((x) => x.id === m.key.id)) return null;
    const fromMe = !!m.key.fromMe;
    const entry = {
      id: m.key.id, fromMe, ts: tsOf(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      type: d.type, text: String(d.text || '').slice(0, MAX_TEXT),
      sender: fromMe ? 'me' : num(m.key.participant || jid), senderName: fromMe ? null : m.pushName || null,
      status: fromMe ? 'sent' : null,
    };
    list.push(entry);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
    msgs.set(jid, list);
    const c = ensureChat(jid);
    if (!fromMe && m.pushName && !isGroup(jid)) { contacts.set(jid, m.pushName); if (!c.name) c.name = m.pushName; }
    if (entry.ts >= c.lastTs) { c.lastTs = entry.ts; c.lastText = label(d).slice(0, 120); c.lastFromMe = fromMe; }
    if (live && !fromMe && d.type !== 'reaction') c.unread = (c.unread || 0) + 1;
    return { jid, entry, chat: chatView(c) };
  } catch (e) { return null; }
}

function emit(event, data) { try { process.send({ type: 'wa', event, ...data }); } catch (e) { /* parent gone */ } }

function wire(s) {
  s.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages || []) {
      const r = ingest(m, type === 'notify');
      if (r) emit('message', r);
    }
  });
  s.ev.on('messaging-history.set', ({ chats: cs, contacts: ct, messages: ms }) => {
    for (const c of ct || []) if (c.id && (c.name || c.notify)) contacts.set(c.id, c.name || c.notify);
    for (const c of cs || []) if (c.id && !c.id.endsWith('@broadcast')) { const x = ensureChat(c.id); if (c.name) x.name = c.name; x.unread = c.unreadCount || 0; }
    for (const m of ms || []) ingest(m, false);
  });
  s.ev.on('chats.upsert', (cs) => { for (const c of cs || []) if (c.id && !c.id.endsWith('@broadcast')) { const x = ensureChat(c.id); if (c.name) x.name = c.name; } });
  s.ev.on('chats.update', (cs) => { for (const c of cs || []) { const x = chats.get(c.id); if (x && typeof c.unreadCount === 'number') x.unread = Math.max(0, c.unreadCount); } });
  s.ev.on('contacts.upsert', (ct) => { for (const c of ct || []) if (c.id && (c.name || c.notify)) { contacts.set(c.id, c.name || c.notify); const x = chats.get(c.id); if (x && !x.name) x.name = c.name || c.notify; } });
  s.ev.on('groups.upsert', (gs) => { for (const g of gs || []) if (g.id && g.subject) { const x = ensureChat(g.id); x.name = g.subject; } });
  s.ev.on('groups.update', (gs) => { for (const g of gs || []) { const x = chats.get(g.id); if (x && g.subject) x.name = g.subject; } });
  s.ev.on('messages.update', (ups) => {
    for (const u of ups || []) {
      const jid = u.key && u.key.remoteJid;
      const e = (msgs.get(jid) || []).find((x) => x.id === u.key.id);
      const st = u.update && u.update.status;
      if (e && e.fromMe && st) {
        e.status = st >= 4 ? 'read' : st === 3 ? 'delivered' : 'sent';
        emit('status', { jid, id: e.id, status: e.status });
      }
    }
  });
}

/** Called every time the bot (re)creates its socket. */
function attach(newSock, store) {
  if (!enabled) return;
  sock = newSock;
  try {
    // seed from the bot's own in-memory store so history from before the dashboard opened shows up
    if (store && store.messages && !wired) for (const [, byId] of store.messages) for (const m of byId.values()) ingest(m, false);
  } catch (e) { /* optional */ }
  wired = true;
  wire(newSock);
}

const handlers = {
  chats({ limit = 100, q = '' } = {}) {
    const needle = String(q || '').toLowerCase();
    let list = [...chats.values()].filter((c) => c.lastTs || msgs.has(c.jid)).map(chatView);
    if (needle) list = list.filter((c) => c.name.toLowerCase().includes(needle) || num(c.jid).includes(needle));
    list.sort((a, b) => b.lastTs - a.lastTs);
    return { chats: list.slice(0, Math.min(300, Math.max(1, limit))), me: sock && sock.user ? { id: sock.user.id, name: sock.user.name || null } : null };
  },
  messages({ jid, limit = 50, before = 0 } = {}) {
    if (!okJid(jid)) throw new Error('Invalid chat id');
    let list = msgs.get(jid) || [];
    if (before) list = list.filter((m) => m.ts < before);
    const c = chats.get(jid);
    return { chat: c ? chatView(c) : { jid, name: contacts.get(jid) || '+' + num(jid), isGroup: isGroup(jid), unread: 0 }, messages: list.slice(-Math.min(200, Math.max(1, limit))), hasMore: list.length > limit };
  },
  async send({ jid, text, quotedId, react } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const list = msgs.get(jid) || [];
    if (react !== undefined) {
      const target = list.find((m) => m.id === quotedId);
      if (!target) throw new Error('Message to react to was not found');
      await sock.sendMessage(jid, { react: { text: String(react).slice(0, 8), key: { remoteJid: jid, id: target.id, fromMe: target.fromMe, participant: isGroup(jid) && !target.fromMe ? target.sender + '@s.whatsapp.net' : undefined } } });
      return { ok: true };
    }
    const body = String(text || '').trim();
    if (!body) throw new Error('Message is empty');
    if (body.length > MAX_TEXT) throw new Error(`Message is too long (max ${MAX_TEXT} characters)`);
    const opts = {};
    if (quotedId) {
      const q = list.find((m) => m.id === quotedId);
      if (q) opts.quoted = { key: { remoteJid: jid, id: q.id, fromMe: q.fromMe, participant: isGroup(jid) && !q.fromMe ? q.sender + '@s.whatsapp.net' : undefined }, message: { conversation: q.text || ' ' } };
    }
    const sent = await sock.sendMessage(jid, { text: body }, opts);
    const r = ingest(sent, false);
    if (r) emit('message', r);
    return { ok: true, id: sent && sent.key && sent.key.id, message: r ? r.entry : null };
  },
  async read({ jid } = {}) {
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const c = chats.get(jid);
    if (c) c.unread = 0;
    const last = [...(msgs.get(jid) || [])].reverse().find((m) => !m.fromMe);
    if (sock && last) { try { await sock.readMessages([{ remoteJid: jid, id: last.id, fromMe: false, participant: isGroup(jid) ? last.sender + '@s.whatsapp.net' : undefined }]); } catch (e) { /* best effort */ } }
    return { ok: true };
  },
  async lookup({ phone } = {}) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) throw new Error('Enter a phone number with country code');
    if (!sock) throw new Error('Bot is not connected');
    const r = await sock.onWhatsApp(digits);
    const hit = Array.isArray(r) ? r.find((x) => x.exists) : null;
    if (!hit) return { exists: false };
    ensureChat(hit.jid);
    return { exists: true, jid: hit.jid };
  },
  me() { return { me: sock && sock.user ? sock.user : null }; },
};

if (enabled) {
  process.on('message', async (req) => {
    if (!req || req.type !== 'rpc' || !req.id) return;
    try {
      const fn = handlers[req.method];
      if (!fn) throw new Error('Unknown method');
      const result = await fn(req.params || {});
      process.send({ type: 'rpc', id: req.id, result });
    } catch (e) {
      process.send({ type: 'rpc', id: req.id, error: e && e.message ? e.message : String(e) });
    }
  });
}

module.exports = { attach, enabled };
