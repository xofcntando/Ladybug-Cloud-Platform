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
const RAW_MAX = 600;

/* ---- Anti-delete: WhatsApp throws the message away when someone taps "delete for everyone".
   We keep a copy of what it said, so the dashboard can still show it. Memory only. ---- */
const deletedLog = []; // newest last
const DELETED_MAX = 300;
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const quietLog = { level: 'silent', info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return quietLog; } };
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

const VOICE_MAX_BYTES = 4 * 1024 * 1024;
let ffmpegBin = null;
function ffmpegPath() {
  if (ffmpegBin) return ffmpegBin;
  try { const p = require('ffmpeg-static'); if (p) return (ffmpegBin = p); } catch (e) { /* not installed, try the system one */ }
  return (ffmpegBin = 'ffmpeg');
}
/** Convert any browser recording (webm / mp4 / ogg / wav) to mono 48 kHz OGG/Opus, which WhatsApp plays as a voice note. */
function toOggOpus(input) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'];
    let p;
    try { p = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return reject(new Error('Voice notes need ffmpeg on the server')); }
    const out = []; let err = ''; let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } finish(reject, new Error('Voice conversion timed out')); }, 30000);
    p.on('error', () => finish(reject, new Error('Voice notes need ffmpeg on the server. Run Admin > Installer > Install Dependencies.')));
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { if (err.length < 500) err += d; });
    p.on('close', (code) => {
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 200) finish(resolve, buf);
      else finish(reject, new Error('Could not process that recording' + (err ? ': ' + err.trim().split('\n').pop().slice(0, 120) : '')));
    });
    p.stdin.on('error', () => { /* ffmpeg closed early, the close handler reports it */ });
    p.stdin.end(input);
  });
}

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
  if (m.liveLocationMessage) return { type: 'location', text: m.liveLocationMessage.caption || 'Live location' };
  if (m.contactsArrayMessage) return { type: 'contact', text: m.contactsArrayMessage.displayName || 'Contacts' };
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

/* ---- rich message data: reply context, polls, locations, contact cards, link previews, reactions ---- */
function ctxInfo(mm) {
  for (const k of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage', 'contactMessage', 'pollCreationMessage', 'pollCreationMessageV3']) {
    if (mm[k] && mm[k].contextInfo) return mm[k].contextInfo;
  }
  return null;
}
function parseVcard(v) {
  const phones = [];
  let name = '';
  for (const line of String(v || '').split(/\r?\n/)) {
    if (/^FN[:;]/i.test(line)) name = line.slice(line.indexOf(':') + 1).trim();
    const w = /waid=(\d{5,20})/i.exec(line);
    if (/^(item\d+\.)?TEL/i.test(line)) {
      const val = line.slice(line.lastIndexOf(':') + 1).trim();
      const digits = (w && w[1]) || val.replace(/[^\d+]/g, '');
      if (digits) phones.push(digits.startsWith('+') || w ? (digits.startsWith('+') ? digits : '+' + digits) : digits);
    }
  }
  return { name, phones: [...new Set(phones)].slice(0, 5) };
}
const b64 = (th) => { try { const x = typeof th === 'string' ? th : Buffer.from(th).toString('base64'); return x.length > 20 && x.length < 40000 ? `data:image/jpeg;base64,${x}` : null; } catch (e) { return null; } };

function enrich(entry, mm, jid, fromMe, m) {
  try {
    const ci = ctxInfo(mm);
    if (ci && ci.quotedMessage && ci.stanzaId) {
      const qd = describe(ci.quotedMessage) || { type: 'other', text: '' };
      entry.quoted = { id: ci.stanzaId, sender: num(ci.participant || ''), mine: !!(ci.participant && sock && sock.user && num(ci.participant) === num(sock.user.id)), type: qd.type, text: String(qd.text || '').slice(0, 160) };
    }
    if (ci && ci.isForwarded) entry.forwarded = true;
    if (mm.locationMessage) {
      const l = mm.locationMessage;
      entry.location = { lat: Number(l.degreesLatitude) || 0, lng: Number(l.degreesLongitude) || 0, name: l.name || null, address: l.address || null, live: false };
    }
    if (mm.liveLocationMessage) {
      const l = mm.liveLocationMessage;
      entry.type = 'location'; entry.text = entry.text || 'Live location';
      entry.location = { lat: Number(l.degreesLatitude) || 0, lng: Number(l.degreesLongitude) || 0, name: l.caption || null, address: null, live: true };
    }
    if (mm.contactMessage) entry.contact = Object.assign({ display: mm.contactMessage.displayName || '' }, parseVcard(mm.contactMessage.vcard));
    if (mm.contactsArrayMessage) {
      const cs = (mm.contactsArrayMessage.contacts || []).slice(0, 5).map((c) => Object.assign({ display: c.displayName || '' }, parseVcard(c.vcard)));
      if (cs.length) { entry.type = 'contact'; entry.text = entry.text || mm.contactsArrayMessage.displayName || cs[0].display; entry.contact = cs[0]; entry.contacts = cs; }
    }
    const poll = mm.pollCreationMessage || mm.pollCreationMessageV3;
    if (poll) entry.poll = { name: poll.name || '', options: (poll.options || []).map((o) => String(o.optionName || '')).slice(0, 12), multi: Number(poll.selectableOptionsCount) !== 1 };
    const et = mm.extendedTextMessage;
    if (et && (et.matchedText || et.canonicalUrl) && (et.title || et.description)) {
      entry.link = { url: String(et.canonicalUrl || et.matchedText).slice(0, 500), title: String(et.title || '').slice(0, 160), desc: String(et.description || '').slice(0, 240), thumb: et.jpegThumbnail ? b64(et.jpegThumbnail) : null };
    }
    if (mm.reactionMessage && mm.reactionMessage.key && mm.reactionMessage.key.id) {
      entry.reactTo = mm.reactionMessage.key.id;
      applyReaction(jid, entry.reactTo, fromMe ? 'me' : num(m.key.participant || jid), mm.reactionMessage.text || '');
    }
  } catch (e) { /* enrichment is best effort */ }
}

function applyReaction(jid, targetId, who, emoji) {
  const list = msgs.get(jid) || [];
  const t = list.find((x) => x.id === targetId);
  if (!t) return;
  t.reactions = t.reactions || {};
  if (emoji) t.reactions[who] = String(emoji).slice(0, 8); else delete t.reactions[who];
  emit('reactions', { jid, id: targetId, reactions: t.reactions });
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
      const th = mediaNode.jpegThumbnail || mediaNode.pngThumbnail;
      if (th && (mm.imageMessage || mm.videoMessage || mm.stickerMessage)) {
        try { const b64 = typeof th === 'string' ? th : Buffer.from(th).toString('base64'); if (b64.length > 20 && b64.length < 40000) entry.thumb = `data:image/${mediaNode.pngThumbnail && !mediaNode.jpegThumbnail ? 'png' : 'jpeg'};base64,${b64}`; } catch (e) { /* no preview */ }
      }
      raw.set(m.key.id, m);
      if (raw.size > RAW_MAX) raw.delete(raw.keys().next().value);
    }
    enrich(entry, mm, jid, fromMe, m);
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
    if (pm.type === 0) {
      // Keep what it said before WhatsApp forgets it. This is the "anti-delete" feature.
      const c = chats.get(jid);
      const item = {
        jid, id: e.id, text: String(e.text || '').slice(0, MAX_TEXT), type: e.type || 'text',
        fromMe: !!e.fromMe, sender: e.sender || (e.fromMe ? 'me' : num(jid)),
        senderName: e.senderName || null, ts: e.ts || Math.floor(Date.now() / 1000),
        deletedAt: Math.floor(Date.now() / 1000),
        chatName: (c && c.name) || contacts.get(jid) || num(jid),
        isGroup: isGroup(jid),
        media: e.media ? { mime: e.media.mime || null, name: e.media.name || null, seconds: e.media.seconds || null } : null,
        quoted: e.quoted ? { text: String(e.quoted.text || '').slice(0, 160), sender: e.quoted.sender || null } : null,
      };
      deletedLog.push(item);
      if (deletedLog.length > DELETED_MAX) deletedLog.splice(0, deletedLog.length - DELETED_MAX);
      e.deleted = true; e.text = ''; e.media = null; raw.delete(e.id);
      emit('deleted', { jid, id: e.id, item });
    }
    else if (pm.type === 14 && pm.editedMessage) {
      const d = describe(pm.editedMessage);
      if (d) { e.text = String(d.text || '').slice(0, MAX_TEXT); e.edited = true; emit('edited', { jid, id: e.id, text: e.text }); }
    }
    return true;
  } catch (err) { return false; }
}

function emit(event, data) { if (event !== 'presence' && event !== 'connection' && event !== 'avatar' && event !== 'typing') persistDirty = true; try { process.send({ type: 'wa', event, ...data }); } catch (e) { /* parent gone */ } }

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

/* ---- Status (stories): other people's 24 h updates plus our own. Kept in memory only, like messages. ---- */
const STATUS_JID = 'status@broadcast';
const STATUS_TTL = 24 * 3600; // seconds
const STATUS_MAX = 400;
const statuses = new Map(); // message id -> entry
const statusRaw = new Map(); // message id -> raw message (media only)
const statusSeen = new Set(); // ids we marked as viewed
const saved = new Map(); // jid -> name saved in the phone's address book (or added here)

const argbHex = (n) => { try { const v = (Number(n) >>> 0) & 0xffffff; return '#' + v.toString(16).padStart(6, '0'); } catch (e) { return null; } };
const hexArgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); return m ? parseInt('ff' + m[1], 16) >>> 0 : null; };
const FONTS = [0, 1, 2, 6, 7, 8, 9, 10]; // ExtendedTextMessage.FontType values WhatsApp accepts for text statuses

function pruneStatuses() {
  const cutoff = Math.floor(Date.now() / 1000) - STATUS_TTL;
  for (const [id, e] of statuses) if (e.ts < cutoff) { statuses.delete(id); statusRaw.delete(id); statusSeen.delete(id); }
  if (statuses.size > STATUS_MAX) {
    const old = [...statuses.values()].sort((a, b) => a.ts - b.ts).slice(0, statuses.size - STATUS_MAX);
    for (const e of old) { statuses.delete(e.id); statusRaw.delete(e.id); }
  }
}

function ingestStatus(m) {
  try {
    if (!m || !m.key || m.key.remoteJid !== STATUS_JID) return null;
    // a deleted status arrives as a protocol message
    const pm = m.message && m.message.protocolMessage;
    if (pm && pm.key && pm.type === 0) {
      const gone = statuses.get(pm.key.id);
      if (gone) { statuses.delete(gone.id); statusRaw.delete(gone.id); emit('statusDeleted', { id: gone.id }); }
      return null;
    }
    const d = describe(m.message);
    if (!d || !['text', 'image', 'video', 'audio', 'voice'].includes(d.type)) return null;
    if (statuses.has(m.key.id)) return null;
    const ts = tsOf(m.messageTimestamp) || Math.floor(Date.now() / 1000);
    if (ts < Math.floor(Date.now() / 1000) - STATUS_TTL) return null;
    const fromMe = !!m.key.fromMe;
    const posterJid = fromMe ? selfJid() : (m.key.participantPn || m.key.participantAlt || m.key.participant || m.participant || '');
    if (!posterJid) return null;
    const mm = unwrap(m.message);
    const e = {
      id: m.key.id, fromMe, poster: fromMe ? 'me' : num(posterJid), posterJid, name: fromMe ? null : (m.pushName || null),
      ts, type: d.type === 'voice' ? 'audio' : d.type, text: String(d.text || '').slice(0, 700),
    };
    const et = mm.extendedTextMessage;
    if (d.type === 'text' && et) {
      e.bg = et.backgroundArgb != null ? argbHex(et.backgroundArgb) : null;
      e.font = et.font != null ? Number(et.font) || 0 : 0;
    }
    const node = mm.imageMessage || mm.videoMessage || mm.audioMessage;
    if (node) {
      e.media = { mime: node.mimetype || null, seconds: node.seconds || null, size: Number(node.fileLength && node.fileLength.toNumber ? node.fileLength.toNumber() : node.fileLength) || null };
      const th = node.jpegThumbnail;
      if (th) e.thumb = b64(th);
      statusRaw.set(e.id, m);
    }
    statuses.set(e.id, e);
    if (!fromMe && m.pushName) { contacts.set(posterJid, contacts.get(posterJid) || m.pushName); }
    pruneStatuses();
    return e;
  } catch (err) { return null; }
}

const statusView = (e) => ({
  id: e.id, ts: e.ts, type: e.type, text: e.text, bg: e.bg || null, font: e.font || 0, thumb: e.thumb || null,
  media: e.media || null, fromMe: e.fromMe, seen: e.fromMe || statusSeen.has(e.id),
});

function statusGroups() {
  pruneStatuses();
  const by = new Map();
  for (const e of statuses.values()) {
    let g = by.get(e.poster);
    if (!g) {
      const jid = e.fromMe ? selfJid() : e.posterJid;
      g = { poster: e.poster, jid, mine: e.fromMe, name: e.fromMe ? 'My status' : (saved.get(jid) || contacts.get(jid) || e.name || '+' + e.poster), items: [] };
      by.set(e.poster, g);
    }
    if (!g.name || g.name.startsWith('+')) g.name = saved.get(e.posterJid) || contacts.get(e.posterJid) || e.name || g.name;
    g.items.push(statusView(e));
  }
  const out = [...by.values()];
  for (const g of out) {
    g.items.sort((a, b) => a.ts - b.ts);
    g.latest = g.items[g.items.length - 1].ts;
    g.unseen = g.items.filter((i) => !i.seen).length;
    g.avatar = (avatars.get(g.jid) || {}).url || null;
  }
  out.sort((a, b) => (b.mine - a.mine) || ((b.unseen > 0) - (a.unseen > 0)) || (b.latest - a.latest));
  return out;
}

/** Tell WhatsApp we viewed these statuses (the poster sees it only if our read-receipts privacy setting allows). */
async function markViewed(ids) {
  const keys = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 30)) {
    const e = statuses.get(String(id));
    if (!e || e.fromMe || statusSeen.has(e.id)) continue;
    statusSeen.add(e.id);
    keys.push({ remoteJid: STATUS_JID, id: e.id, participant: e.posterJid, fromMe: false });
  }
  if (keys.length) {
    try { await sock.readMessages(keys); } catch (err) { for (const k of keys) statusSeen.delete(k.id); throw new Error('Could not mark as viewed'); }
  }
  return { ok: true, marked: keys.length };
}

/** Everyone who should see a status we post: known saved contacts and recent one-to-one chats, plus ourselves. */
function statusAudience(only) {
  const set = new Set([selfJid()]);
  const ok = (j) => /@s\.whatsapp\.net$/.test(j);
  if (Array.isArray(only) && only.length) { for (const j of only.slice(0, 1000)) if (ok(String(j))) set.add(String(j)); return [...set]; }
  for (const j of saved.keys()) if (ok(j)) set.add(j);
  for (const c of chats.values()) if (ok(c.jid)) set.add(c.jid);
  for (const j of contacts.keys()) if (ok(j)) set.add(j);
  return [...set].slice(0, 1000);
}

/* ---- Automation: always online, auto-view status, auto-save status.
   Settings come from the platform (env LADYBUG_AUTO at start, 'autoSet' RPC afterwards). A key is null until the user
   sets it, so a setting made through a bot command (e.g. .savestatus on) is never overridden by a default. ---- */
const auto = { online: null, viewStatus: null, saveStatus: null, readReceipts: null, rejectCalls: null, away: null, rules: null };
function readAuto(o) {
  for (const k of ['online', 'viewStatus', 'saveStatus', 'readReceipts', 'rejectCalls']) if (o && typeof o[k] === 'boolean') auto[k] = o[k];
  if (o && o.away && typeof o.away === 'object') auto.away = o.away;
  if (o && Array.isArray(o.rules)) auto.rules = o.rules;
}
try { readAuto(JSON.parse(process.env.LADYBUG_AUTO || '{}')); } catch (e) { /* bad env, ignore */ }

let onlineTimer = null;
function pushOnline() {
  if (!sock || !auto.online || conn.state !== 'open') return;
  try { Promise.resolve(sock.sendPresenceUpdate('available')).catch(() => {}); } catch (e) { /* socket closing */ }
}
function applyOnline() {
  clearInterval(onlineTimer); onlineTimer = null;
  if (auto.online) {
    pushOnline();
    onlineTimer = setInterval(pushOnline, 25000);
    if (onlineTimer.unref) onlineTimer.unref();
  } else if (auto.online === false && sock && conn.state === 'open') {
    try { Promise.resolve(sock.sendPresenceUpdate('unavailable')).catch(() => {}); } catch (e) { /* ignore */ }
  }
}
/** Auto-save is done by the bot's own savestatus module (it forwards every new status to the owner chat). */
function saveModule() { try { return require('./savestatus'); } catch (e) { return null; } }
function applySave() {
  if (auto.saveStatus === null) return true;
  const m = saveModule();
  if (!m || typeof m.setEnabled !== 'function') return false;
  m.setEnabled(auto.saveStatus);
  return true;
}

/* ---- Auto-reply engine: away message + keyword rules.
   Rules run first (they are explicit), then the away message for direct chats. Both are rate limited per
   chat so a chatty contact cannot turn the bot into a spam cannon. ---- */
const awaySent = new Map();  // jid -> last away reply ts
const ruleSent = new Map();  // jid|ruleId -> last reply ts
const RULE_COOLDOWN = 5 * 60_000;

function pushAuto(jid, text) {
  if (!sock || !jid || !text) return;
  try { Promise.resolve(sock.sendMessage(jid, { text: String(text) })).catch(() => {}); } catch (e) { /* socket closing */ }
}

function maybeAutoReply(m, r) {
  if (!sock || !r || !m.key || m.key.fromMe) return;
  const jid = r.jid;
  const entry = r.entry || r;
  if (!jid || jid === STATUS_JID || jid === selfJid()) return;
  if (entry.fromMe) return;
  const group = isGroup(jid);
  const body = String(entry.text || '').trim();
  if (!body) return;

  if (Array.isArray(auto.rules) && auto.rules.length) {
    const low = body.toLowerCase();
    for (const rule of auto.rules) {
      if (!rule || rule.enabled === false || !rule.match || !rule.reply) continue;
      const needle = String(rule.match).toLowerCase();
      const hit = rule.exact ? low === needle : low.includes(needle);
      if (!hit) continue;
      const key = jid + '|' + rule.id;
      const last = ruleSent.get(key) || 0;
      if (Date.now() - last < RULE_COOLDOWN) continue;
      ruleSent.set(key, Date.now());
      pushAuto(jid, rule.reply);
      return;
    }
  }

  if (auto.away && auto.away.enabled && !group && auto.away.text) {
    const cd = Math.max(0, Number(auto.away.cooldownMin) || 0) * 60_000;
    const last = awaySent.get(jid) || 0;
    if (Date.now() - last >= cd) { awaySent.set(jid, Date.now()); pushAuto(jid, auto.away.text); }
  }
}

const viewQueue = [];
let viewTimer = null;
function queueView(id) {
  if (!auto.viewStatus || viewQueue.length > 60 || viewQueue.includes(id)) return;
  viewQueue.push(id);
  if (viewTimer) return;
  const next = () => {
    viewTimer = null;
    const nid = viewQueue.shift();
    if (!nid) return;
    if (auto.viewStatus) markViewed([nid]).catch(() => {});
    if (viewQueue.length) { viewTimer = setTimeout(next, 1500 + Math.floor(Math.random() * 2500)); if (viewTimer.unref) viewTimer.unref(); }
  };
  viewTimer = setTimeout(next, 2000 + Math.floor(Math.random() * 5000)); // a human-like pause before "seeing" it
  if (viewTimer.unref) viewTimer.unref();
}

function wire(s) {
  subscribed.clear();
  s.ev.on('connection.update', ({ connection }) => {
    if (s !== sock) return;
    if (connection === 'open') {
      setConn({ state: 'open', since: Date.now(), number: s.user ? num(s.user.id) : null, name: s.user ? s.user.name || null : null });
      setTimeout(subscribeRecent, 4000);
      setTimeout(applyOnline, 2500);
    } else if (connection === 'connecting') setConn({ state: 'connecting', since: Date.now() });
    else if (connection === 'close') { setConn({ state: 'closed', since: Date.now() }); clearInterval(onlineTimer); onlineTimer = null; }
  });
  s.ev.on('call', (calls) => {
    if (s !== sock || !auto.rejectCalls) return;
    for (const c of calls || []) {
      if (!c || c.status !== 'offer') continue;
      try { Promise.resolve(sock.rejectCall(c.id, c.from)).catch(() => {}); } catch (e) { /* older baileys */ }
      emit('call', { from: num(c.from), id: c.id, rejected: true });
    }
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
      if (m.key && m.key.remoteJid === STATUS_JID) {
        const e = ingestStatus(m);
        if (e && !e.fromMe) {
          emit('statusNew', { group: e.poster, item: statusView(e), name: saved.get(e.posterJid) || contacts.get(e.posterJid) || e.name || '+' + e.poster });
          if (type === 'notify' && Math.floor(Date.now() / 1000) - e.ts < 600) queueView(e.id);
        }
        continue;
      }
      if (applyProtocol(m)) continue;
      const r = ingest(m, type === 'notify');
      if (r) {
        emit('message', r);
        if (type === 'notify' && !m.key.fromMe) {
          if (auto.readReceipts) { try { Promise.resolve(sock.readMessages([m.key])).catch(() => {}); } catch (e) { /* ignore */ } }
          try { maybeAutoReply(m, r); } catch (e) { /* never break the message loop */ }
        }
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
    for (const c of ct || []) if (c.id && (c.name || c.notify)) { contacts.set(c.id, c.name || c.notify); if (c.name) saved.set(c.id, c.name); }
    for (const c of cs || []) if (c.id && !c.id.endsWith('@broadcast')) { const x = ensureChat(c.id); if (c.name) x.name = c.name; x.unread = c.unreadCount || 0; }
    for (const m of ms || []) { if (m.key && m.key.remoteJid === STATUS_JID) ingestStatus(m); else ingest(m, false); }
  });
  s.ev.on('chats.upsert', (cs) => { for (const c of cs || []) if (c.id && !c.id.endsWith('@broadcast')) { const x = ensureChat(c.id); if (c.name) x.name = c.name; } });
  s.ev.on('chats.update', (cs) => { for (const c of cs || []) { const x = chats.get(c.id); if (x && typeof c.unreadCount === 'number') x.unread = Math.max(0, c.unreadCount); } });
  s.ev.on('contacts.upsert', (ct) => { for (const c of ct || []) if (c.id && (c.name || c.notify)) { contacts.set(c.id, c.name || c.notify); if (c.name) saved.set(c.id, c.name); const x = chats.get(c.id); if (x && !x.name) x.name = c.name || c.notify; } });
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

/* ---------------------------------------------------------------------------------------------
   Persistence: the chat list and message history survive restarts, redeploys and "closing the app".
   Snapshot -> $BOT_DATA_DIR/webchat.json (atomic write). The platform mirrors that file to MongoDB
   (when MONGODB_URI is set) and can serve it while the bot is offline. Media bytes are NOT stored
   (only captions, metadata and small previews), so old media cannot be re-downloaded after a restart.
--------------------------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const PERSIST_FILE = path.join(process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'database'), 'webchat.json');
const PERSIST_PER_CHAT = 150; // newest messages kept per chat on disk
const PERSIST_THUMBS = 20; // previews kept for the newest N messages of a chat
const PERSIST_MAX_BYTES = 12 * 1024 * 1024; // keeps the MongoDB mirror well under its 16 MB document limit (gzip shrinks it further)
const PERSIST_EVERY_MS = 8000;
let persistDirty = false;
let persistBusy = false;
let persistSig = '';
let lastSaveAt = 0;

function markDirty() { persistDirty = true; }

function snapshotSig() {
  let n = 0, last = 0, unread = 0;
  for (const l of msgs.values()) n += l.length;
  for (const c of chats.values()) { last += c.lastTs || 0; unread += c.unread || 0; }
  return [chats.size, n, last, unread, contacts.size, saved.size, deletedLog.length].join('|');
}

function buildSnapshot() {
  const out = {};
  for (const [jid, list] of msgs) {
    const keep = list.slice(-PERSIST_PER_CHAT);
    out[jid] = keep.map((m, i) => {
      if (m.thumb && i < keep.length - PERSIST_THUMBS) { const { thumb, ...rest } = m; return rest; }
      return m;
    });
  }
  let snap = { v: 1, savedAt: Date.now(), chats: [...chats.values()], msgs: out, contacts: Object.fromEntries(contacts), saved: Object.fromEntries(saved), deleted: deletedLog.slice(-DELETED_MAX) };
  let json = JSON.stringify(snap);
  if (json.length > PERSIST_MAX_BYTES) { // too big: drop previews first, then the oldest chats' history
    for (const l of Object.values(out)) for (const m of l) delete m.thumb;
    json = JSON.stringify(snap);
    const order = [...chats.values()].sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
    for (const c of order) {
      if (json.length <= PERSIST_MAX_BYTES) break;
      delete out[c.jid];
      json = JSON.stringify(snap);
    }
  }
  return json;
}

function writeSnapshotSync(json) {
  fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
  const tmp = PERSIST_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, PERSIST_FILE);
}

function saveNow(sync) {
  if (!enabled || (!persistDirty && !sync) || persistBusy) return;
  try {
    persistBusy = true;
    const json = buildSnapshot();
    persistDirty = false;
    if (sync) { writeSnapshotSync(json); persistBusy = false; lastSaveAt = Date.now(); return; }
    fs.mkdir(path.dirname(PERSIST_FILE), { recursive: true }, () => {
      const tmp = PERSIST_FILE + '.tmp';
      fs.writeFile(tmp, json, (err) => {
        if (err) { persistDirty = true; persistBusy = false; return; }
        fs.rename(tmp, PERSIST_FILE, (err2) => {
          persistBusy = false;
          if (err2) { persistDirty = true; return; }
          lastSaveAt = Date.now();
          try { process.send({ type: 'wa-saved', at: lastSaveAt }); } catch (e) { /* parent gone */ }
        });
      });
    });
  } catch (e) { persistBusy = false; persistDirty = true; }
}

/** Merge a snapshot into memory. Messages are matched by id, so loading twice (disk + MongoDB) is harmless. */
function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return 0;
  let added = 0;
  for (const [id, name] of Object.entries(snap.contacts || {})) if (okJid(id) && name && !contacts.has(id)) contacts.set(id, String(name).slice(0, 80));
  for (const [id, name] of Object.entries(snap.saved || {})) if (okJid(id) && name && !saved.has(id)) saved.set(id, String(name).slice(0, 80));
  for (const c of snap.chats || []) {
    if (!c || !okJid(c.jid)) continue;
    const x = chats.get(c.jid);
    if (!x) chats.set(c.jid, { jid: c.jid, name: c.name || null, unread: c.unread || 0, lastTs: c.lastTs || 0, lastText: c.lastText || '', lastFromMe: !!c.lastFromMe });
    else {
      if (!x.name && c.name) x.name = c.name;
      if ((c.lastTs || 0) > (x.lastTs || 0)) { x.lastTs = c.lastTs; x.lastText = c.lastText || ''; x.lastFromMe = !!c.lastFromMe; }
    }
  }
  for (const [jid, list] of Object.entries(snap.msgs || {})) {
    if (!okJid(jid) || !Array.isArray(list)) continue;
    const have = msgs.get(jid) || [];
    const ids = new Set(have.map((m) => m.id));
    for (const m of list) { if (m && m.id && !ids.has(m.id)) { have.push(m); ids.add(m.id); added++; } }
    have.sort((a, b) => a.ts - b.ts);
    if (have.length > MAX_PER_CHAT) have.splice(0, have.length - MAX_PER_CHAT);
    if (have.length) msgs.set(jid, have);
    if (!chats.has(jid)) { const l = have[have.length - 1]; chats.set(jid, { jid, name: contacts.get(jid) || null, unread: 0, lastTs: l ? l.ts : 0, lastText: l ? String(l.text || l.type || '').slice(0, 120) : '', lastFromMe: l ? !!l.fromMe : false }); }
  }
  const seen = new Set(deletedLog.map((d) => d.jid + ':' + d.id));
  for (const d of snap.deleted || []) if (d && d.id && !seen.has(d.jid + ':' + d.id)) deletedLog.push(d);
  deletedLog.sort((a, b) => (a.deletedAt || 0) - (b.deletedAt || 0));
  if (deletedLog.length > DELETED_MAX) deletedLog.splice(0, deletedLog.length - DELETED_MAX);
  while (chats.size > MAX_CHATS) {
    const oldest = [...chats.values()].sort((a, b) => a.lastTs - b.lastTs)[0];
    chats.delete(oldest.jid); msgs.delete(oldest.jid);
  }
  return added;
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return 0;
    return applySnapshot(JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')));
  } catch (e) {
    console.error('[web-bridge] could not read saved chats:', e.message);
    try { fs.renameSync(PERSIST_FILE, PERSIST_FILE + '.corrupt'); } catch (e2) { /* ignore */ }
    return 0;
  }
}

let persistStarted = false;
function startPersistence() {
  if (!enabled || persistStarted) return;
  persistStarted = true;
  const n = loadFromDisk();
  if (n) console.log(`[web-bridge] restored ${n} saved message(s) from disk`);
  persistSig = snapshotSig();
  const t = setInterval(() => {
    const sig = snapshotSig();
    if (sig !== persistSig) { persistSig = sig; persistDirty = true; }
    if (persistDirty && Date.now() - lastSaveAt >= PERSIST_EVERY_MS) saveNow(false);
  }, 3000);
  if (t.unref) t.unref();
  const flushNow = () => { try { if (persistDirty || persistSig !== snapshotSig()) saveNow(true); } catch (e) { /* best effort */ } };
  process.on('exit', flushNow);
  process.on('SIGTERM', () => { flushNow(); });
  process.on('SIGINT', () => { flushNow(); });
  process.on('beforeExit', flushNow);
}

/** Called every time the bot (re)creates its socket. */
function attach(newSock, store) {
  if (!enabled) return;
  startPersistence();
  sock = newSock;
  try {
    // seed from the bot's own in-memory store so history from before the dashboard opened shows up
    if (store && store.messages && !wired) for (const [, byId] of store.messages) for (const m of byId.values()) { if (m.key && m.key.remoteJid === STATUS_JID) ingestStatus(m); else ingest(m, false); }
  } catch (e) { /* optional */ }
  wired = true;
  wire(newSock);
  try { applySave(); } catch (e) { /* savestatus module missing in this bot version */ }
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
  async typing({ jid, on, mode } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    await sock.sendPresenceUpdate(on ? (mode === 'recording' ? 'recording' : 'composing') : 'paused', jid);
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
  async send({ jid, text, quotedId, react, mentions } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const list = msgs.get(jid) || [];
    if (react !== undefined) {
      const target = list.find((m) => m.id === quotedId);
      if (!target) throw new Error('Message to react to was not found');
      await sock.sendMessage(jid, { react: { text: String(react).slice(0, 8), key: { remoteJid: jid, id: target.id, fromMe: target.fromMe, participant: isGroup(jid) && !target.fromMe ? target.sender + '@s.whatsapp.net' : undefined } } });
      applyReaction(jid, target.id, 'me', String(react).slice(0, 8));
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
    const content = { text: body };
    if (Array.isArray(mentions) && isGroup(jid)) {
      const ids = [...new Set(mentions.map(String))].filter((x) => /^\d{5,20}$/.test(x) && body.includes('@' + x)).slice(0, 30);
      if (ids.length) content.mentions = ids.map((x) => x + '@s.whatsapp.net');
    }
    const sent = await sock.sendMessage(jid, content, opts);
    const r = ingest(sent, false);
    if (r) emit('message', r);
    return { ok: true, id: sent && sent.key && sent.key.id, message: r ? r.entry : null };
  },
  /** Poll: 2-12 options, single or multiple choice. */
  async sendPoll({ jid, name, options, multi } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const q = String(name || '').trim().slice(0, 200);
    const opts = [...new Set((Array.isArray(options) ? options : []).map((o) => String(o || '').trim().slice(0, 100)).filter(Boolean))].slice(0, 12);
    if (!q) throw new Error('Write a question for the poll');
    if (opts.length < 2) throw new Error('A poll needs at least 2 different options');
    const sent = await sock.sendMessage(jid, { poll: { name: q, values: opts, selectableCount: multi ? opts.length : 1 } });
    const r = ingest(sent, false);
    if (r) emit('message', r);
    return { ok: true, id: sent && sent.key && sent.key.id, message: r ? r.entry : null };
  },
  /** Location pin from the browser's coordinates. */
  async sendLocation({ jid, lat, lng, name } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const la = Number(lat), lo = Number(lng);
    if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) throw new Error('Invalid coordinates');
    const sent = await sock.sendMessage(jid, { location: { degreesLatitude: la, degreesLongitude: lo, name: name ? String(name).slice(0, 100) : undefined } });
    const r = ingest(sent, false);
    if (r) emit('message', r);
    return { ok: true, id: sent && sent.key && sent.key.id, message: r ? r.entry : null };
  },
  /** Contact card (vCard) for one person. */
  async sendContact({ jid, name, phone } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const nm = String(name || '').replace(/[\r\n;]/g, ' ').trim().slice(0, 60);
    const digits = String(phone || '').replace(/\D/g, '');
    if (!nm) throw new Error('Contact name is required');
    if (digits.length < 7 || digits.length > 15) throw new Error('Enter the number with country code');
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${nm}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
    const sent = await sock.sendMessage(jid, { contacts: { displayName: nm, contacts: [{ displayName: nm, vcard }] } });
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
    let buf;
    try {
      // logger is required by Baileys on its retry path: without it an expired-media (404) error turns into a TypeError and the file can never be re-requested
      buf = await downloadMediaMessage(m, 'buffer', {}, { logger: quietLog, reuploadRequest: sock.updateMediaMessage });
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      console.error('[web-bridge] media download failed:', e.type, why);
      throw new Error(/404|410|gone|not found|expired/i.test(why) ? 'WhatsApp no longer has this file (it expired). Ask the sender to send it again.' : 'Could not download this file: ' + why);
    }
    if (!buf || !buf.length) throw new Error('Could not download this file');
    if (buf.length > MEDIA_MAX_BYTES) throw new Error('File is too large to preview here (limit 8 MB)');
    const fallback = { image: 'image/jpeg', sticker: 'image/webp', video: 'video/mp4', voice: 'audio/ogg', audio: 'audio/mpeg' }[e.type] || 'application/octet-stream';
    let mime = e.media.mime || fallback;
    if (/^image\//.test(fallback) && !/^image\//.test(mime)) mime = fallback;
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
  /**
   * Send a voice note recorded in the browser. Browsers record WebM/Opus or MP4/AAC, but WhatsApp only plays
   * a push-to-talk note properly as OGG/Opus, so it is converted with ffmpeg first.
   */
  async sendVoice({ jid, data, mime, seconds, quotedId } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid chat id');
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('Invalid recording');
    const input = Buffer.from(data, 'base64');
    if (!input.length) throw new Error('Recording is empty');
    if (input.length > VOICE_MAX_BYTES) throw new Error('Voice note is too large (limit 4 MB)');
    const secs = Math.max(1, Math.min(900, Math.round(Number(seconds) || 1)));
    const ogg = await toOggOpus(input, String(mime || ''));
    const opts = {};
    const list = msgs.get(jid) || [];
    if (quotedId) {
      const q = list.find((m) => m.id === quotedId);
      if (q) opts.quoted = { key: { remoteJid: jid, id: q.id, fromMe: q.fromMe, participant: isGroup(jid) && !q.fromMe ? q.sender + '@s.whatsapp.net' : undefined }, message: { conversation: q.text || '' } };
    }
    const sent = await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: secs }, opts);
    const r = ingest(sent, false);
    if (r) emit('message', r);
    return { ok: true, id: sent && sent.key && sent.key.id, message: r ? r.entry : null };
  },
  /** Search message text across every chat kept in memory (newest first). */
  search({ q, limit = 40 } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2) return { results: [] };
    const out = [];
    for (const [jid, list] of msgs) {
      const c = chats.get(jid);
      for (let i = list.length - 1; i >= 0 && out.length < 400; i--) {
        const m = list[i];
        if (m.deleted || !m.text || !m.text.toLowerCase().includes(needle)) continue;
        out.push({ jid, chat: c ? c.name : contacts.get(jid) || '+' + num(jid), isGroup: isGroup(jid), id: m.id, ts: m.ts, fromMe: m.fromMe, sender: m.senderName || null, text: m.text.slice(0, 220) });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return { results: out.slice(0, Math.min(100, Math.max(1, Number(limit) || 40))), total: out.length };
  },
  /* ---------------------------------------------------------------- Anti-delete */

  /** Messages other people deleted for everyone, with the original text kept. */
  deletedList({ limit = 200, jid = '' } = {}) {
    let items = deletedLog;
    if (jid) items = items.filter((x) => x.jid === String(jid));
    const total = items.length;
    const max = Math.min(300, Math.max(1, Number(limit) || 200));
    return { items: items.slice(-max).reverse(), total };
  },
  deletedClear({ jid = '' } = {}) {
    if (jid) {
      for (let i = deletedLog.length - 1; i >= 0; i--) if (deletedLog[i].jid === String(jid)) deletedLog.splice(i, 1);
    } else deletedLog.length = 0;
    return { ok: true, total: deletedLog.length };
  },

  /* ---------------------------------------------------------------- Analytics */

  /**
   * Conversation statistics for this number, computed from the in-memory ring.
   * Everything is derived locally: no message ever leaves the process.
   */
  analytics({ days = 7 } = {}) {
    const span = Math.min(90, Math.max(1, Number(days) || 7));
    const now = Math.floor(Date.now() / 1000);
    const from = now - span * 86400;
    const hours = new Array(24).fill(0);
    const weekdays = new Array(7).fill(0);
    const byDay = new Map(); // YYYY-MM-DD -> { in, out }
    const media = { image: 0, video: 0, audio: 0, voice: 0, document: 0, sticker: 0, other: 0 };
    const perChat = new Map(); // jid -> { in, out, total, name, isGroup }
    let total = 0, incoming = 0, outgoing = 0, deletedCount = 0;

    for (const [jid, list] of msgs) {
      const c = chats.get(jid);
      const name = (c && c.name) || contacts.get(jid) || '+' + num(jid);
      const rec = { in: 0, out: 0, total: 0, name, isGroup: isGroup(jid), lastTs: 0 };
      for (const m of list) {
        if (!m.ts || m.ts < from) continue;
        if (m.type === 'reaction') continue;
        total++;
        if (m.fromMe) { outgoing++; rec.out++; } else { incoming++; rec.in++; }
        rec.total++;
        if (m.ts > rec.lastTs) rec.lastTs = m.ts;
        const d = new Date(m.ts * 1000);
        hours[d.getHours()]++;
        weekdays[d.getDay()]++;
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const day = byDay.get(key) || { in: 0, out: 0 };
        if (m.fromMe) day.out++; else day.in++;
        byDay.set(key, day);
        if (m.deleted) deletedCount++;
        const t = m.type;
        if (t === 'image' || t === 'video' || t === 'audio' || t === 'voice' || t === 'document' || t === 'sticker') media[t]++;
        else if (t !== 'text') media.other++;
      }
      if (rec.total) perChat.set(jid, rec);
    }

    // Average time to answer: for each incoming message, the gap to our next reply in that chat.
    let gaps = 0, gapSum = 0;
    for (const [, list] of msgs) {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.fromMe || !m.ts || m.ts < from || m.type === 'reaction') continue;
        for (let j = i + 1; j < list.length; j++) {
          const n = list[j];
          if (!n.fromMe || n.type === 'reaction') continue;
          const g = n.ts - m.ts;
          if (g >= 0 && g < 86400) { gaps++; gapSum += g; }
          break;
        }
      }
    }

    const top = [...perChat.values()].sort((a, b) => b.total - a.total).slice(0, 10)
      .map((r) => ({ name: r.name, isGroup: r.isGroup, total: r.total, in: r.in, out: r.out, lastTs: r.lastTs }));

    const timeline = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date((now - i * 86400) * 1000);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const v = byDay.get(key) || { in: 0, out: 0 };
      timeline.push({ day: key, in: v.in, out: v.out, total: v.in + v.out });
    }

    const peakHour = hours.indexOf(Math.max(...hours));
    return {
      span, total, incoming, outgoing, deletedCount,
      chats: perChat.size,
      groups: [...perChat.values()].filter((r) => r.isGroup).length,
      hours, weekdays, timeline, media, top,
      peakHour: total ? peakHour : null,
      avgReplySec: gaps ? Math.round(gapSum / gaps) : null,
      replies: gaps,
      busiestDay: timeline.slice().sort((a, b) => b.total - a.total)[0] || null,
    };
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
  /* ------------------------------------------------------------------ Automation */
  autoGet() {
    const m = saveModule();
    return {
      online: auto.online === true,
      viewStatus: auto.viewStatus === true,
      saveStatus: m && typeof m.isEnabled === 'function' ? !!m.isEnabled() : auto.saveStatus === true,
      readReceipts: auto.readReceipts === true,
      rejectCalls: auto.rejectCalls === true,
      away: auto.away || null,
      rules: Array.isArray(auto.rules) ? auto.rules : [],
      saveSupported: !!(m && typeof m.setEnabled === 'function'),
      connected: conn.state === 'open',
    };
  },
  autoSet(patch) {
    readAuto(patch || {});
    applyOnline();
    const saveOk = applySave();
    return Object.assign(handlers.autoGet(), { saveSupported: saveOk && handlers.autoGet().saveSupported });
  },

  /* ------------------------------------------------------------------ Status (stories) */
  statusList() {
    return { groups: statusGroups(), audience: statusAudience().length - 1 };
  },
  async statusMedia({ id } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    const m = statusRaw.get(String(id));
    const e = statuses.get(String(id));
    if (!m || !e || !e.media) throw new Error('This status is no longer available.');
    if (e.media.size && e.media.size > MEDIA_MAX_BYTES * 2) throw new Error('This status video is too large to play here');
    const { downloadMediaMessage } = baileys();
    let buf;
    try { buf = await downloadMediaMessage(m, 'buffer', {}, { logger: quietLog, reuploadRequest: sock.updateMediaMessage }); }
    catch (err) {
      const why = err && err.message ? err.message : String(err);
      throw new Error(/404|410|gone|not found|expired/i.test(why) ? 'WhatsApp no longer has this status (it expired).' : 'Could not download this status: ' + why);
    }
    if (!buf || !buf.length) throw new Error('Could not download this status');
    const mime = e.media.mime || (e.type === 'video' ? 'video/mp4' : e.type === 'audio' ? 'audio/ogg' : 'image/jpeg');
    return { mime, data: `data:${mime};base64,${buf.toString('base64')}` };
  },
  /** Mark statuses as viewed. The poster sees the view only if our own read-receipt privacy setting allows it. */
  async statusSeen({ ids } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    return markViewed(ids);
  },
  async statusPost({ kind, text, bg, font, data, name, caption, audience } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    const list = statusAudience(audience);
    if (list.length < 2) throw new Error('No contacts to share with yet. Chat with someone or add a contact first.');
    let sent;
    if (kind === 'text') {
      const t = String(text || '').trim();
      if (!t) throw new Error('Write something first');
      if (t.length > 700) throw new Error('Text statuses are limited to 700 characters');
      const opts = { statusJidList: list, backgroundColor: hexArgb(bg) || 0xff1f7a5c, font: FONTS.includes(Number(font)) ? Number(font) : 0 };
      sent = await sock.sendMessage(STATUS_JID, { text: t }, opts);
    } else if (kind === 'media') {
      const mt = /^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
      if (!mt) throw new Error('Invalid file');
      const mime = mt[1];
      const buf = Buffer.from(mt[2], 'base64');
      if (!buf.length) throw new Error('File is empty');
      if (buf.length > MEDIA_MAX_BYTES) throw new Error('File is too large (limit 8 MB)');
      const cap = caption ? String(caption).slice(0, 700) : undefined;
      let content;
      if (/^image\/(jpeg|png|webp)$/.test(mime)) content = { image: buf, caption: cap };
      else if (/^video\/(mp4|3gpp|quicktime)$/.test(mime)) content = { video: buf, caption: cap };
      else throw new Error('Statuses can be a photo, a short video or text');
      sent = await sock.sendMessage(STATUS_JID, content, { statusJidList: list });
    } else throw new Error('Unknown status type');
    const e = ingestStatus(sent);
    if (e) emit('statusNew', { group: 'me', item: statusView(e) });
    return { ok: true, id: sent && sent.key && sent.key.id, sharedWith: list.length - 1, item: e ? statusView(e) : null };
  },
  async statusDelete({ id } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    const e = statuses.get(String(id));
    if (!e || !e.fromMe) throw new Error('You can only delete your own statuses');
    await sock.sendMessage(STATUS_JID, { delete: { remoteJid: STATUS_JID, id: e.id, fromMe: true } }, { statusJidList: statusAudience() });
    statuses.delete(e.id); statusRaw.delete(e.id);
    emit('statusDeleted', { id: e.id });
    return { ok: true };
  },

  /* ------------------------------------------------------------------ Media, docs and links gallery */
  gallery({ jid, kind = 'media', limit = 120 } = {}) {
    if (!okJid(jid)) throw new Error('Invalid chat id');
    const list = (msgs.get(jid) || []).filter((m) => !m.deleted);
    const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
    const isMedia = (m) => m.type === 'image' || m.type === 'video' || m.type === 'sticker';
    const isDoc = (m) => m.type === 'document' || m.type === 'audio' || m.type === 'voice';
    const linksOf = (m) => {
      const urls = [];
      if (m.link && m.link.url) urls.push(m.link.url);
      for (const u of String(m.text || '').match(URL_RE) || []) { const c = u.replace(/[).,;!?]+$/, ''); if (!urls.includes(c)) urls.push(c); }
      return urls.slice(0, 3).map((url) => ({ id: m.id, ts: m.ts, fromMe: m.fromMe, sender: m.sender, url: url.slice(0, 500), title: m.link && m.link.url === url ? m.link.title : '', desc: m.link && m.link.url === url ? m.link.desc : '', thumb: m.link && m.link.url === url ? m.link.thumb : null }));
    };
    const counts = { media: 0, docs: 0, links: 0 };
    const media = [], docs = [], links = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (isMedia(m)) { counts.media++; media.push(m); }
      else if (isDoc(m)) { counts.docs++; docs.push(m); }
      const l = linksOf(m);
      if (l.length) { counts.links += l.length; links.push(...l); }
    }
    const cap = Math.min(300, Math.max(1, Number(limit) || 120));
    const slim = (m) => ({ id: m.id, ts: m.ts, type: m.type, text: m.text, fromMe: m.fromMe, sender: m.sender, thumb: m.thumb || null, media: m.media || null });
    const items = (kind === 'docs' ? docs : kind === 'links' ? links : media).slice(0, cap);
    return { kind, counts, items: kind === 'links' ? items : items.map(slim), window: list.length };
  },

  /* ------------------------------------------------------------------ Contacts (address book) */
  contactsList() {
    const out = [];
    for (const [jid, name] of saved) if (/@s\.whatsapp\.net$/.test(jid)) out.push({ jid, name, phone: num(jid), saved: true });
    return { contacts: out.sort((a, b) => a.name.localeCompare(b.name)) };
  },
  async contactAdd({ phone, name } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    const digits = String(phone || '').replace(/\D/g, '');
    const label = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    if (!label) throw new Error('Enter a name for this contact');
    if (digits.length < 7 || digits.length > 15) throw new Error('Enter the phone number with country code, e.g. 27821234567');
    const r = await sock.onWhatsApp(digits);
    const hit = Array.isArray(r) ? r.find((x) => x.exists) : null;
    if (!hit) return { ok: false, exists: false, error: 'That number is not on WhatsApp' };
    const jid = hit.jid;
    saved.set(jid, label); contacts.set(jid, label);
    const c = ensureChat(jid); c.name = label;
    let synced = false;
    try {
      if (typeof sock.addOrEditContact === 'function') {
        await sock.addOrEditContact(jid, { fullName: label, firstName: label.split(' ')[0], saveOnPrimaryAddressbook: true });
        synced = true;
      }
    } catch (err) { synced = false; }
    emit('contact', { jid, name: label, chat: chatView(c) });
    return { ok: true, exists: true, jid, name: label, synced };
  },
  async contactRemove({ jid } = {}) {
    if (!sock) throw new Error('Bot is not connected');
    if (!okJid(jid)) throw new Error('Invalid contact');
    let synced = false;
    try { if (typeof sock.removeContact === 'function') { await sock.removeContact(jid); synced = true; } } catch (err) { synced = false; }
    saved.delete(jid);
    const c = chats.get(jid);
    if (c) { c.name = null; contacts.delete(jid); }
    return { ok: true, synced };
  },
};

if (enabled) {
  process.on('message', async (req) => {
    if (req && req.type === 'chatstore' && typeof req.json === 'string') { // platform hands back the MongoDB copy
      try { const n = applySnapshot(JSON.parse(req.json)); if (n) { persistDirty = true; console.log(`[web-bridge] restored ${n} message(s) from the cloud backup`); } } catch (e) { /* bad backup, ignore */ }
      return;
    }
    if (!req || req.type !== 'rpc' || !req.id) return;
    try {
      const fn = handlers[req.method];
      if (!fn) throw new Error('Unknown method');
      const result = await fn(req.params || {});
      persistDirty = true;
      process.send({ type: 'rpc', id: req.id, result });
    } catch (e) {
      process.send({ type: 'rpc', id: req.id, error: e && e.message ? e.message : String(e) });
    }
  });
}

module.exports = { attach, enabled };
