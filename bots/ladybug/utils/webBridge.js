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
const raw = new Map(); // message id -> raw WhatsApp message, only for media we may be asked to download
const RAW_MAX = 250;
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
let baileysLib = null;
function baileys() {
  if (!baileysLib) { try { baileysLib = require('@whiskeysockets/baileys'); } catch (e) { baileysLib = require('baileys'); } }
  return baileysLib;
}

// ---- presence ("who is online"): live state per chat, WhatsApp-Web style
const presences = new Map(); // key -> { state, lastSeen, ts }
const subscribed = new Set(); // chats we asked WhatsApp to tell us about, per socket
const avatars = new Map(); // jid -> { url, ts }
const conn = { state: 'connecting', since: Date.now(), number: null, name: null };
const PRESENCE_TTL = 3 * 60 * 1000; // 'available' with no news for 3 minutes is shown as stale
const TYPING_TTL = 12 * 1000; // WhatsApp sends 'paused' unreliably, so typing expires by itself

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

const presKey = (jid) => num(jid);
function presenceOf(jid) {
  const p = presences.get(presKey(jid));
  if (!p) return null;
  const age = Date.now() - p.ts;
  let state = p.state;
  if ((state === 'composing' || state === 'recording') && age > TYPING_TTL) state = 'available';
  if (state === 'available' && age > PRESENCE_TTL) state = 'unknown';
  return { state, lastSeen: p.lastSeen || null, who: p.who || null };
}

function chatView(c) {
  return { presence: isGroup(c.jid) ? null : presenceOf(c.jid), avatar: (avatars.get(c.jid) || {}).url || null, jid: c.jid, name: c.name || contacts.get(c.jid) || (isGroup(c.jid) ? 'Group' : '+' + num(c.jid)), isGroup: isGroup(c.jid), unread: c.unread || 0, lastTs: c.lastTs || 0, lastText: c.lastText || '', lastFromMe: !!c.lastFromMe };
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
    const mm = unwrap(m.message);
    const mediaNode = mm.imageMessage || mm.videoMessage || mm.audioMessage || mm.documentMessage || mm.stickerMessage;
    if (mediaNode) {
      entry.media = { mime: mediaNode.mimetype || null, size: Number(mediaNode.fileLength && mediaNode.fileLength.toNumber ? mediaNode.fileLength.toNumber() : mediaNode.fileLength) || null, seconds: mediaNode.seconds || null, name: mediaNode.fileName || null };
      raw.set(m.key.id, m);
      if (raw.size > RAW_MAX) raw.delete(raw.keys().next().value);
    }
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


/** "Delete for everyone" and "edit" arrive as protocol messages. Update our copy and tell the dashboard. */
function applyProtocol(m) {
  try {
    const pm = m.message && (m.message.protocolMessage || (m.message.ephemeralMessage && m.message.ephemeralMessage.message && m.message.ephemeralMessage.message.protocolMessage));
    if (!pm || !pm.key) return false;
    const jid = m.key.remoteJid;
    const e = (msgs.get(jid) || []).find((x) => x.id === pm.key.id);
    if (!e) return true;
    if (pm.type === 0) { e.deleted = true; e.text = ''; e.media = null; raw.delete(e.id); emit('deleted', { jid, id: e.id }); }
    else if (pm.type === 14 && pm.editedMessage) {
      const d = describe(pm.editedMessage);
      if (d) { e.text = String(d.text || '').slice(0, MAX_TEXT); e.edited = true; emit('edited', { jid, id: e.id, text: e.text }); }
    }
    return true;
  } catch (err) { return false; }
}

function emit(event, data) { try { process.send({ type: 'wa', event, ...data }); } catch (e) { /* parent gone */ } }

function setConn(patch) {
  Object.assign(conn, patch);
  emit('connection', { ...conn, me: sock && sock.user ? { id: sock.user.id, name: sock.user.name || null } : null });
}

/** Ask WhatsApp to push presence for a chat. Same call WhatsApp Web makes when you open a chat. */
async function subscribe(jid) {
  if (!sock || !okJid(jid) || subscribed.has(jid) || isGroup(jid)) return;
  subscribed.add(jid);
  try { await sock.presenceSubscribe(jid); } catch (e) { subscribed.delete(jid); }
}

// Gentle background subscription for the most recent DMs: one per 1.5 s, never more than 40.
let subTimer = null;
function subscribeRecent() {
  clearInterval(subTimer);
  const queue = [...chats.values()].filter((c) => !isGroup(c.jid)).sort((a, b) => b.lastTs - a.lastTs).slice(0, 40).map((c) => c.jid);
  subTimer = setInterval(() => {
    const jid = queue.shift();
    if (!jid) return clearInterval(subTimer);
    subscribe(jid);
  }, 1500);
  if (subTimer.unref) subTimer.unref();
}

function wire(s) {
  subscribed.clear();
  s.ev.on('connection.update', ({ connection }) => {
    if (s !== sock) return;
    if (connection === 'open') {
      setConn({ state: 'open', since: Date.now(), number: s.user ? num(s.user.id) : null, name: s.user ? s.user.name || null : null });
      setTimeout(subscribeRecent, 4000);
    } else if (connection === 'connecting') setConn({ state: 'connecting', since: Date.now() });
    else if (connection === 'close') setConn({ state: 'closed', since: Date.now() });
  });
  s.ev.on('presence.update', ({ id, presences: map }) => {
    for (const [who, p] of Object.entries(map || {})) {
      const state = p.lastKnownPresence || 'unavailable';
      const lastSeen = p.lastSeen ? tsOf(p.lastSeen) : null;
      if (isGroup(id)) {
        emit('presence', { jid: id, group: true, who: num(who), state });
        continue;
      }
      const prev = presences.get(presKey(id));
      presences.set(presKey(id), { state, lastSeen: lastSeen || (state === 'unavailable' ? Math.floor(Date.now() / 1000) : prev && prev.lastSeen) || null, ts: Date.now() });
      emit('presence', { jid: id, presence: presenceOf(id) });
    }
  });
  s.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages || []) {
      if (applyProtocol(m)) continue;
      const r = ingest(m, type === 'notify');
      if (r) {
        emit('message', r);
        if (type === 'notify' && !m.key.fromMe && !isGroup(r.jid)) {
          // they just wrote to us, so they are online right now; also start following their presence
          const prev = presences.get(presKey(r.jid));
          if (!prev || (prev.state !== 'composing' && prev.state !== 'recording')) presences.set(presKey(r.jid), { state: 'available', lastSeen: prev && prev.lastSeen, ts: Date.now() });
          emit('presence', { jid: r.jid, presence: presenceOf(r.jid) });
          subscribe(r.jid);
        }
      }
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

const selfJid = () => String((sock && sock.user && sock.user.id) || '').split(':')[0].split('@')[0] + '@s.whatsapp.net';

const handlers = {
  chats({ limit = 100, q = '' } = {}) {
    const needle = String(q || '').toLowerCase();
    let list = [...chats.values()].filter((c) => c.lastTs || msgs.has(c.jid)).map(chatView);
    if (needle) list = list.filter((c) => c.name.toLowerCase().includes(needle) || num(c.jid).includes(needle));
    list.sort((a, b) => b.lastTs - a.lastTs);
    const online = list.filter((c) => c.presence && (c.presence.state === 'available' || c.presence.state === 'composing' || c.presence.state === 'recording')).length;
    return { chats: list.slice(0, Math.min(300, Math.max(1, limit))), online, conn: { ...conn }, me: sock && sock.user ? { id: sock.user.id, name: sock.user.name || null } : null };
  },
  /** Connection + identity of the linked number, for the status bar. */
  info() {
    return { conn: { ...conn }, me: sock && sock.user ? { id: sock.user.id, name: sock.user.name || null } : null };
  },
  /** Subscribe to a chat's presence and return what we know right now. */
  async presence({ jid } = {}) {
    if (!okJid(jid)) throw new Error('Invalid chat id');
    await subscribe(jid);
    if (isGroup(jid)) {
      let size = null;
      try { const md = sock && (await sock.groupMetadata(jid)); size = md && md.participants ? md.participants.length : null; } catch (e) { /* optional */ }
      return { group: true, size };
    }
    return { presence: presenceOf(jid) };
  },
  /** "typing..." indicator while the operator writes a reply. */
  async typing({ jid, on } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    await sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    return { ok: true };
  },
  /** Profile picture URL (cached for 30 minutes; WhatsApp only returns it if the contact allows it). */
  async avatar({ jid } = {}) {
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const hit = avatars.get(jid);
    if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return { url: hit.url };
    let url = null;
    try { url = sock ? (await sock.profilePictureUrl(jid, 'preview')) || null : null; } catch (e) { url = null; }
    avatars.set(jid, { url, ts: Date.now() });
    const c = chats.get(jid);
    if (c && url) emit('avatar', { jid, url });
    return { url };
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
  /** Download an incoming (or our own) photo / video / audio / document so the browser can show it. */
  async media({ jid, id } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const m = raw.get(String(id));
    const e = (msgs.get(jid) || []).find((x) => x.id === String(id));
    if (!m || !e || !e.media) throw new Error('This file is no longer available. Only recent media can be opened.');
    if (e.media.size && e.media.size > MEDIA_MAX_BYTES) throw new Error(`File is too large to preview here (${Math.round(e.media.size / 1048576)} MB, limit 8 MB)`);
    const { downloadMediaMessage } = baileys();
    const buf = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    if (!buf || !buf.length) throw new Error('Could not download this file');
    if (buf.length > MEDIA_MAX_BYTES) throw new Error('File is too large to preview here (limit 8 MB)');
    const mime = e.media.mime || 'application/octet-stream';
    return { mime, name: e.media.name || null, data: `data:${mime};base64,${buf.toString('base64')}` };
  },
  /** Send a photo, video, audio file or document picked in the browser. */
  async sendMedia({ jid, data, name, caption } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const mt = /^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!mt) throw new Error('Invalid file');
    const mime = mt[1];
    const buf = Buffer.from(mt[2], 'base64');
    if (!buf.length) throw new Error('File is empty');
    if (buf.length > MEDIA_MAX_BYTES) throw new Error('File is too large (limit 8 MB)');
    const cap = caption ? String(caption).slice(0, 1000) : undefined;
    const fileName = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
    let content;
    if (/^image\/(jpeg|png|webp)$/.test(mime)) content = { image: buf, caption: cap };
    else if (/^video\/(mp4|3gpp|quicktime)$/.test(mime)) content = { video: buf, caption: cap };
    else if (/^audio\//.test(mime)) content = { audio: buf, mimetype: mime, ptt: false };
    else content = { document: buf, mimetype: mime || 'application/octet-stream', fileName, caption: cap };
    const sent = await sock.sendMessage(jid, content);
    const r = ingest(sent, false);
    if (r) emit('message', r);
    return { ok: true, id: sent && sent.key && sent.key.id, message: r ? r.entry : null };
  },
  /** Delete one of OUR messages for everyone. */
  async deleteMsg({ jid, id } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const e = (msgs.get(jid) || []).find((x) => x.id === String(id));
    if (!e) throw new Error('Message not found');
    if (!e.fromMe) throw new Error('You can only delete your own messages for everyone');
    await sock.sendMessage(jid, { delete: { remoteJid: jid, id: e.id, fromMe: true, participant: isGroup(jid) ? selfJid() : undefined } });
    e.deleted = true; e.text = ''; e.media = null; raw.delete(e.id);
    emit('deleted', { jid, id: e.id });
    return { ok: true };
  },
  /** Edit one of our text messages (WhatsApp allows this for 15 minutes). */
  async editMsg({ jid, id, text } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const e = (msgs.get(jid) || []).find((x) => x.id === String(id));
    if (!e || !e.fromMe) throw new Error('You can only edit your own messages');
    if (e.type !== 'text') throw new Error('Only text messages can be edited');
    if (Date.now() / 1000 - e.ts > 15 * 60) throw new Error('WhatsApp only allows editing within 15 minutes');
    const body = String(text || '').trim();
    if (!body) throw new Error('Message is empty');
    if (body.length > MAX_TEXT) throw new Error(`Message is too long (max ${MAX_TEXT} characters)`);
    await sock.sendMessage(jid, { text: body, edit: { remoteJid: jid, id: e.id, fromMe: true, participant: isGroup(jid) ? selfJid() : undefined } });
    e.text = body; e.edited = true;
    emit('edited', { jid, id: e.id, text: body });
    return { ok: true };
  },
  /** Group name, description and members for the info drawer. */
  async group({ jid } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid) || !isGroup(jid)) throw new Error('Not a group');
    const md = await sock.groupMetadata(jid);
    const me = num(selfJid());
    return {
      subject: md.subject || 'Group', desc: md.desc || '', created: md.creation || null, size: (md.participants || []).length,
      participants: (md.participants || []).map((p) => {
        const pn = p.phoneNumber || p.jid || p.id;
        return { id: p.id, phone: num(pn), name: contacts.get(p.id) || contacts.get(pn) || null, admin: p.admin || null, me: num(pn) === me };
      }).slice(0, 1024),
    };
  },
  me() { return { me: sock && sock.user ? sock.user : null }; },

  /* ------------------------------------------------------------------ profile + privacy */
  /** Current name, About text, photo and phone number of the linked account. */
  async profileGet() {
    if (!sock || !sock.user) throw new Error('Bot is not connected');
    const jid = selfJid();
    let about = null, aboutAt = null, picture = null;
    try { const st = await sock.fetchStatus(jid); const r = Array.isArray(st) ? st[0] : st; about = (r && (r.status && r.status.status !== undefined ? r.status.status : r.status)) || null; aboutAt = r && r.status && r.status.setAt ? r.status.setAt : null; } catch (e) { /* hidden or unavailable */ }
    try { picture = (await sock.profilePictureUrl(jid, 'image')) || null; } catch (e) { picture = null; }
    return { jid, phone: num(jid), name: sock.user.name || null, about: typeof about === 'string' ? about : null, aboutAt, picture };
  },
  async profileSet({ name, about, picture, removePicture } = {}) {
    if (!sock || !sock.user) throw new Error('Bot is not connected');
    const jid = selfJid();
    const done = [];
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw new Error('Name cannot be empty');
      if (n.length > 25) throw new Error('Name can be at most 25 characters');
      await sock.updateProfileName(n);
      sock.user.name = n;
      done.push('name');
    }
    if (about !== undefined) {
      const a = String(about).trim();
      if (a.length > 139) throw new Error('About can be at most 139 characters');
      await sock.updateProfileStatus(a);
      done.push('about');
    }
    if (removePicture) {
      await sock.removeProfilePicture(jid);
      avatars.delete(jid);
      done.push('picture-removed');
    } else if (picture) {
      const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(picture));
      if (!m) throw new Error('Photo must be a JPEG, PNG or WebP image');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 500 || buf.length > 1.5 * 1024 * 1024) throw new Error('Photo is too small or too large (max 1.5 MB)');
      await sock.updateProfilePicture(jid, buf);
      avatars.delete(jid);
      done.push('picture');
    }
    if (!done.length) throw new Error('Nothing to change');
    return { ok: true, done };
  },
  /** Who can see your last seen / photo / about / online, read receipts, group adds, calls. */
  async privacyGet() {
    if (!sock) throw new Error('Bot is not connected');
    let p = {};
    try { p = (await sock.fetchPrivacySettings(true)) || {}; } catch (e) { throw new Error('Could not load privacy settings: ' + (e && e.message ? e.message : e)); }
    return { settings: p };
  },
  async privacySet({ key, value } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    const map = {
      last: ['updateLastSeenPrivacy', ['all', 'contacts', 'contact_blacklist', 'none']],
      online: ['updateOnlinePrivacy', ['all', 'match_last_seen']],
      profile: ['updateProfilePicturePrivacy', ['all', 'contacts', 'contact_blacklist', 'none']],
      status: ['updateStatusPrivacy', ['all', 'contacts', 'contact_blacklist', 'none']],
      readreceipts: ['updateReadReceiptsPrivacy', ['all', 'none']],
      groupadd: ['updateGroupsAddPrivacy', ['all', 'contacts', 'contact_blacklist']],
      calladd: ['updateCallPrivacy', ['all', 'known']],
    };
    const def = map[key];
    if (!def) throw new Error('Unknown privacy setting');
    if (!def[1].includes(value)) throw new Error('Invalid value for this setting');
    if (typeof sock[def[0]] !== 'function') throw new Error('This setting is not supported by the installed WhatsApp library');
    await sock[def[0]](value);
    return { ok: true };
  },
  async blocklist() {
    if (!sock) throw new Error('Bot is not connected');
    let list = [];
    try { list = (await sock.fetchBlocklist()) || []; } catch (e) { throw new Error('Could not load blocked contacts'); }
    return { blocked: list.filter(Boolean).map((jid) => ({ jid, name: contacts.get(jid) || '+' + num(jid) })) };
  },
  async block({ jid, block } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid) || isGroup(jid)) throw new Error('Only people can be blocked');
    if (jid === selfJid()) throw new Error('You cannot block yourself');
    await sock.updateBlockStatus(jid, block ? 'block' : 'unblock');
    return { ok: true, blocked: !!block };
  },
  /** Default disappearing-messages timer for new chats: 0 (off), 86400, 604800, 7776000 seconds. */
  async disappearing({ seconds } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    const v = Number(seconds);
    if (![0, 86400, 604800, 7776000].includes(v)) throw new Error('Choose off, 24 hours, 7 days or 90 days');
    await sock.updateDefaultDisappearingMode(v);
    return { ok: true };
  },
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
