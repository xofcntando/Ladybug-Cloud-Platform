const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('./ffmpeg').getFfmpegPath() || 'ffmpeg';
const APIs = require('./api');
const { getTempDir, deleteTempFile } = require('./tempManager');
const jidHelper = require('./jidHelper');
const { isNiceName, lookupName, rememberName, rememberFromMessage } = require('./nameCache');

function toMention(candidates) {
  if (typeof jidHelper.lidToMention === 'function') {
    return jidHelper.lidToMention(candidates);
  }
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  for (const jid of list) {
    const raw = String(jid);
    const normalized = typeof jidHelper.normalizeJidWithLid === 'function'
      ? jidHelper.normalizeJidWithLid(raw)
      : raw;
    const user = String(normalized || raw).split('@')[0].split(':')[0];
    const mappedIsPhone = /^\d{8,15}$/.test(user) && !/@lid\b/i.test(String(normalized || ''));
    if (mappedIsPhone) {
      const phoneJid = `${user}@s.whatsapp.net`;
      return { jid: phoneJid, number: user, isLid: false, text: `@${user}`, mentions: [phoneJid] };
    }
  }
  const first = String(list[0] || '');
  const user = first.split('@')[0].split(':')[0];
  return {
    jid: first || null,
    number: /^\d{8,15}$/.test(user) ? user : null,
    isLid: /@lid\b/i.test(first),
    text: user ? `@${user}` : '',
    mentions: first ? [first] : [],
  };
}

function participantName(p) {
  if (!p) return '';
  return [p.notify, p.name, p.verifiedName, p.pushName, p.pushname].find(isNiceName) || '';
}

function comparableUsers(jids) {
  const ids = new Set();
  for (const jid of (jids || []).filter(Boolean)) {
    ids.add(String(jid));
    ids.add(String(jid).split('@')[0].split(':')[0]);
    if (typeof jidHelper.buildComparableIds === 'function') {
      for (const id of jidHelper.buildComparableIds(jid) || []) {
        ids.add(String(id));
        ids.add(String(id).split('@')[0].split(':')[0]);
      }
    }
  }
  return ids;
}

function lookupParticipant(extra, jids) {
  const parts = extra?.groupMetadata?.participants || [];
  if (typeof jidHelper.findParticipant === 'function') {
    const found = jidHelper.findParticipant(parts, jids);
    if (found) return found;
  }
  const ids = comparableUsers(jids);
  return parts.find((p) => {
    const keys = [p.id, p.lid, p.jid, p.phoneNumber, p.participant, p.userJid].filter(Boolean);
    return keys.some((k) => ids.has(String(k)) || ids.has(String(k).split('@')[0].split(':')[0]));
  }) || null;
}

function nameFromContacts(sock, jids) {
  const store = sock?.store?.contacts || {};
  for (const jid of (jids || []).filter(Boolean)) {
    const user = String(jid).split('@')[0].split(':')[0];
    const keys = [
      jid,
      String(jid).split(':')[0],
      `${user}@s.whatsapp.net`,
      `${user}@lid`,
      `${user}@hosted.lid`,
    ];
    for (const key of keys) {
      const c = store[key];
      const n = participantName(c);
      if (n) return n;
    }
  }
  return lookupName(jids);
}

function nameFromRecentMessages(sock, extra, jids) {
  const ids = comparableUsers(jids);
  const chats = [];
  const current = extra?.from || extra?.groupMetadata?.id;
  if (current && sock?.store?.messages?.get?.(current)) chats.push(sock.store.messages.get(current));
  if (sock?.store?.messages) chats.push(...sock.store.messages.values());
  if (sock?.store?.byId) chats.push(sock.store.byId);
  for (const chatMsgs of chats) {
    if (!chatMsgs || typeof chatMsgs.values !== 'function') continue;
    const recent = [...chatMsgs.values()].reverse();
    for (const m of recent) {
      const keys = [
        m.key?.participant,
        m.key?.participantAlt,
        m.key?.senderPn,
        m.key?.senderLid,
        !String(m.key?.remoteJid || '').endsWith('@g.us') ? m.key?.remoteJid : null,
      ];
      const hit = keys.some((k) => k && (ids.has(String(k)) || ids.has(String(k).split('@')[0].split(':')[0])));
      if (hit && isNiceName(m.pushName)) {
        rememberName(keys[0], m.pushName);
        return m.pushName.trim();
      }
    }
  }
  return '';
}

async function nameFromQuoted(sock, msg, ctx) {
  const id = ctx?.stanzaId || ctx?.quotedMessage?.key?.id;
  if (!id) return '';
  let quoted = null;
  try {
    if (sock?.store?.loadMessage) {
      quoted = await sock.store.loadMessage(msg?.key?.remoteJid, id);
    }
  } catch {}
  if (!quoted && sock?.store?.byId?.get) {
    quoted = sock.store.byId.get(id) || null;
  }
  if (!quoted && sock?.store?.messages) {
    for (const chatMsgs of sock.store.messages.values()) {
      if (chatMsgs.has?.(id)) {
        quoted = chatMsgs.get(id);
        break;
      }
    }
  }
  if (isNiceName(quoted?.pushName)) {
    rememberName(ctx.participant, quoted.pushName);
    rememberName(ctx.participantAlt, quoted.pushName);
    rememberName(quoted.key?.participant, quoted.pushName);
    rememberName(quoted.key?.participantAlt, quoted.pushName);
    return quoted.pushName.trim();
  }
  return '';
}

function cardDisplayName(candidates) {
  for (const value of candidates) {
    if (isNiceName(value)) return String(value).trim();
  }
  return '';
}

function tag(jid) {
  return `@${(jid || '').split('@')[0]}`;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function percentFromId(id, salt = 0) {
  const base = String(id).split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return ((base + salt * 13) % 101 + Math.floor(Math.random() * 5)) % 101;
}

function percentFromPair(a, b, salt = 0) {
  const seed = (String(a) + String(b)).split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return Math.abs(((seed * 7 + salt * 17) % 101));
}

function getTargetUser(msg, extra) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
  const mentioned = ctx.mentionedJid || [];
  let jid = mentioned[0] || ctx.participant || extra.sender;
  return { jid, tag: tag(jid) };
}

function findParticipant(jid, extra) {
  const participants = extra.groupMetadata?.participants || [];
  if (!jid || !participants.length) return null;
  const userPart = jid.split('@')[0].split(':')[0];
  return participants.find((p) => {
    const idUser = (p.id || '').split('@')[0].split(':')[0];
    const lidUser = (p.lid || '').split('@')[0].split(':')[0];
    const phoneUser = (p.phoneNumber || '').split('@')[0].split(':')[0];
    return p.id === jid || idUser === userPart || lidUser === userPart || phoneUser === userPart;
  }) || null;
}

function getUserName(jid, extra, msg) {
  const participant = findParticipant(jid, extra);
  const notify = (participant?.notify || participant?.name || '').trim();
  if (notify && !/^\d+$/.test(notify) && !notify.startsWith('+')) return notify;

  const ctx = msg?.message?.extendedTextMessage?.contextInfo;
  if (ctx?.participant === jid && ctx?.pushName?.trim()) return ctx.pushName.trim();

  if (participant?.phoneNumber?.includes('@s.whatsapp.net')) {
    return participant.phoneNumber.split('@')[0].split(':')[0];
  }
  if (jid.endsWith('@s.whatsapp.net')) {
    return jid.split('@')[0].split(':')[0];
  }

  const fromArgs = (msg?.message?.extendedTextMessage?.text || msg?.message?.conversation || '')
    .replace(/^[^\s]+\s*/, '')
    .trim();
  if (fromArgs && !fromArgs.includes('@') && !/^\d+$/.test(fromArgs)) return fromArgs;

  return 'this person';
}

function nameFromMentionText(msg) {
  const text = msg?.message?.extendedTextMessage?.text || msg?.message?.conversation || '';
  for (const m of text.matchAll(/@([^\s@]+)/g)) {
    const candidate = (m[1] || '').trim();
    if (candidate && !/^\d{5,}$/.test(candidate)) return candidate;
  }
  return null;
}

async function getUserPicUrl(sock, jid) {
  const socketOpen = !!(sock?.ws?.isOpen || sock?.ws?.readyState === 1);
  if (socketOpen && jid) {
    try {
      const url = await Promise.race([
        sock.profilePictureUrl(jid, 'image'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      if (url) return url;
    } catch {}
  }
  return `https://i.pravatar.cc/400?u=${encodeURIComponent(String(jid || 'user').split('@')[0])}`;
}

async function resolveCardPerson(sock, extra, targetJids, extras = {}) {
  const list = (targetJids || []).filter(Boolean);
  const rawJid = list[0] || extras.fallbackJid || extra?.sender;
  const who = toMention(list.length ? list : [rawJid]);
  const row = lookupParticipant(extra, [...list, who.jid, rawJid]) || extras.row || null;
  const jids = [
    ...list,
    who.jid,
    rawJid,
    row?.id,
    row?.lid,
    row?.jid,
    row?.phoneNumber,
    row?.userJid,
  ].filter(Boolean);

  const display = cardDisplayName([
    ...(extras.names || []),
    participantName(row),
    nameFromContacts(sock, jids),
    lookupName(jids),
    nameFromRecentMessages(sock, extra, jids),
  ]);
  if (isNiceName(display)) {
    for (const jid of jids) rememberName(jid, display);
  }

  let pic = who.jid ? await getUserPicUrl(sock, who.jid) : '';
  if ((!pic || pic.includes('pravatar')) && rawJid && rawJid !== who.jid) {
    const other = await getUserPicUrl(sock, rawJid);
    if (other) pic = other;
  }

  return {
    who,
    jid: who.jid || rawJid,
    name: display || (who.number ? `+${who.number}` : 'Unknown'),
    mentions: who.mentions.length ? who.mentions : [rawJid].filter(Boolean),
    mentionText: who.text || `@${String(rawJid || '').split('@')[0]}`,
    pic,
  };
}

function unwrapMessageContent(msg) {
  let m = msg?.message || {};
  if (m.ephemeralMessage) m = m.ephemeralMessage.message || {};
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || {};
  if (m.viewOnceMessage) m = m.viewOnceMessage.message || {};
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || {};
  return m;
}

function getContextInfo(msg) {
  const m = unwrapMessageContent(msg);
  return m.extendedTextMessage?.contextInfo
    || m.imageMessage?.contextInfo
    || m.videoMessage?.contextInfo
    || m.documentMessage?.contextInfo
    || m.stickerMessage?.contextInfo
    || {};
}

async function getCardTarget(sock, msg, extra) {
  rememberFromMessage(msg);
  const ctx = getContextInfo(msg);
  const mentioned = (ctx.mentionedJid || []).filter(Boolean);
  const repliedJid = ctx.participant || ctx.participantPn || ctx.remoteJid;
  const hasMention = mentioned.length > 0;
  const hasReply = !!(ctx.stanzaId && repliedJid) || !!ctx.participant;
  const targetingSelf = !hasMention && !hasReply;

  const targetJids = targetingSelf
    ? [
        extra.senderPn,
        extra.senderAlt,
        msg.key.participantAlt,
        extra.sender,
        msg.key.participant,
      ]
    : hasMention
      ? [
          mentioned[0],
          ctx.mentionedJid?.[0],
        ]
      : [
          ctx.participantAlt,
          ctx.participantPn,
          ctx.participant,
          ctx.remoteJid,
        ];

  if (targetingSelf) {
    rememberName(extra.sender, msg.pushName || extra.pushName);
  }

  const quotedName = hasReply ? await nameFromQuoted(sock, msg, ctx) : '';
  const person = await resolveCardPerson(sock, extra, targetJids, {
    fallbackJid: extra.sender,
    names: [
      quotedName,
      hasMention ? nameFromMentionText(msg) : '',
      targetingSelf ? msg.pushName : '',
      targetingSelf ? extra.pushName : '',
    ],
  });

  return {
    jid: person.jid,
    name: person.name,
    mentions: person.mentions,
    mentionText: person.mentionText,
    pic: person.pic,
  };
}

async function resolveJoinLeaveTarget(sock, participant, participantJid, groupMetadata) {
  const p = participant && typeof participant === 'object' ? participant : {};
  const extra = { groupMetadata, from: groupMetadata?.id };
  const person = await resolveCardPerson(
    sock,
    extra,
    [p.phoneNumber, p.jid, p.id, p.lid, participantJid],
    {
      fallbackJid: participantJid,
      row: p,
      names: [p.notify, p.name, p.verifiedName, p.pushName, p.pushname],
    }
  );

  return {
    displayName: person.name,
    mentionText: person.mentionText,
    mentions: person.mentions,
    profilePicUrl: person.pic,
  };
}

function getMentionTarget(msg, extra) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
  const mentioned = ctx.mentionedJid || [];
  let jid = null;
  if (mentioned.length) jid = mentioned[0];
  else if (ctx.participant) jid = ctx.participant;
  else jid = extra.sender;

  let name = nameFromMentionText(msg);
  if (!name) {
    const participant = findParticipant(jid, extra);
    name = (participant?.notify || participant?.name || '').trim();
  }
  if ((!name || /^\d+$/.test(name)) && ctx?.participant === jid && ctx?.pushName?.trim()) {
    name = ctx.pushName.trim();
  }
  if (!name || /^\d+$/.test(name)) {
    const fallback = getUserName(jid, extra, msg);
    if (fallback !== 'this person') name = fallback;
  }

  return { jid, name, atTag: `@${name || jid.split('@')[0]}` };
}

function getTwoUsers(msg, extra, sock) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
  const mentioned = ctx.mentionedJid || [];
  let a = null;
  let b = null;

  if (mentioned.length >= 2) {
    a = mentioned[0];
    b = mentioned[1];
  } else if (mentioned.length === 1) {
    a = mentioned[0];
    b = extra.sender;
  } else if (ctx.participant) {
    a = ctx.participant;
    b = extra.sender;
  } else if (extra.isGroup && extra.groupMetadata?.participants?.length >= 2) {
    const pool = extra.groupMetadata.participants
      .map((p) => p.id)
      .filter((id) => id !== sock.user?.id);
    if (pool.length < 2) return { error: '❌ Not enough members!' };
    const shuffled = pool.sort(() => Math.random() - 0.5);
    a = shuffled[0];
    b = shuffled[1];
  } else {
    return { error: '❌ Use in a group or mention/reply to users!' };
  }

  return { a, b };
}

function parseAiText(data) {
  const raw = data?.result || data?.msg || data?.response || data?.data?.msg;
  if (typeof raw === 'string') {
    return raw.replace(/\*([^*]+)\*/g, '$1').trim().slice(0, 4000);
  }
  if (raw && typeof raw === 'object' && raw.text) {
    return String(raw.text).trim().slice(0, 4000);
  }
  return '';
}

async function askPrinceAi(prompt) {
  const res = await axios.get('https://api.princetechn.com/api/ai/chat', {
    params: { apikey: 'prince', q: prompt },
    timeout: 30000,
  });
  const text = parseAiText(res.data);
  if (!text) throw new Error('Empty prince response');
  return text;
}

async function askFunAi(prompt) {
  try {
    return await askPrinceAi(prompt);
  } catch (e) {
    console.error('[funAi] prince failed:', e.message);
  }

  try {
    const res = await APIs.chatAI(prompt);
    const text = parseAiText(res);
    if (text) return text;
    throw new Error('Empty shizo response');
  } catch (e) {
    console.error('[funAi] shizo failed:', e.message);
    throw new Error('AI unavailable');
  }
}

async function sendMention(sock, from, msg, text, jids) {
  const unique = [...new Set((jids || []).filter(Boolean))];
  await sock.sendMessage(from, { text, mentions: unique }, { quoted: msg });
}

function resolvePairText(opts, a, b) {
  if (typeof opts.text === 'function') {
    const result = opts.text(tag(a), tag(b), a, b);
    return Array.isArray(result) ? pick(result) : result;
  }
  return pick(opts.text);
}

function createRateCommand(name, aliases, opts) {
  return {
    name,
    aliases,
    category: 'fun',
    description: opts.description,
    usage: opts.usage,
    groupOnly: opts.groupOnly || false,
    async execute(sock, msg, args, extra) {
      try {
        const { jid, tag: t } = getTargetUser(msg, extra);
        const pct = percentFromId(jid, opts.salt || 0);
        const line = pick(opts.lines(pct, t));
        await sendMention(sock, extra.from, msg, line, [jid]);
      } catch (e) {
        console.error(`[${name}]`, e.message);
        await extra.reply('❌ Something went wrong.');
      }
    },
  };
}

function createPairRateCommand(name, aliases, opts) {
  return {
    name,
    aliases,
    category: 'fun',
    description: opts.description,
    usage: opts.usage,
    groupOnly: true,
    async execute(sock, msg, args, extra) {
      try {
        const pair = getTwoUsers(msg, extra, sock);
        if (pair.error) return extra.reply(pair.error);
        const { a, b } = pair;
        const pct = percentFromPair(a, b, opts.salt || 0);
        const line = pick(opts.lines(pct, tag(a), tag(b)));
        await sendMention(sock, extra.from, msg, line, [a, b]);
      } catch (e) {
        console.error(`[${name}]`, e.message);
        await extra.reply('❌ Something went wrong.');
      }
    },
  };
}

function createPairCommand(name, aliases, opts) {
  return {
    name,
    aliases,
    category: 'fun',
    description: opts.description,
    usage: opts.usage,
    groupOnly: true,
    async execute(sock, msg, args, extra) {
      try {
        const pair = getTwoUsers(msg, extra, sock);
        if (pair.error) return extra.reply(pair.error);
        const { a, b } = pair;
        const line = resolvePairText(opts, a, b);
        await sendMention(sock, extra.from, msg, line, [a, b]);
      } catch (e) {
        console.error(`[${name}]`, e.message);
        await extra.reply('❌ Something went wrong.');
      }
    },
  };
}

function createRandomCommand(name, aliases, opts) {
  return {
    name,
    aliases,
    category: 'fun',
    description: opts.description,
    usage: opts.usage,
    groupOnly: opts.groupOnly || false,
    async execute(sock, msg, args, extra) {
      try {
        let text;
        if (opts.build) {
          text = opts.build(args, extra, msg);
        } else if (opts.pool) {
          text = pick(opts.pool);
        }
        if (!text) return extra.reply(opts.empty || '❌ Provide input.');
        const { jid } = opts.mentionTarget ? getTargetUser(msg, extra) : {};
        if (opts.mentionTarget && jid) {
          await sendMention(sock, extra.from, msg, text.replace('{tag}', tag(jid)), [jid]);
        } else {
          await extra.reply(text);
        }
      } catch (e) {
        console.error(`[${name}]`, e.message);
        await extra.reply('❌ Something went wrong.');
      }
    },
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 12 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve();
    });
  });
}

/** Download reaction GIF and compress to small MP4 (WhatsApp gifPlayback). */
async function reactionGifToMp4(gifUrl) {
  const res = await axios.get(gifUrl, {
    responseType: 'arraybuffer',
    timeout: 25000,
    maxContentLength: 25 * 1024 * 1024,
    headers: { 'User-Agent': 'Ladybug-Mini', Accept: 'image/gif,image/*,*/*' },
  });
  const buf = Buffer.from(res.data || []);
  if (!buf.length) throw new Error('Empty gif download');

  const tempDir = getTempDir();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const gifPath = path.join(tempDir, `react_${stamp}.gif`);
  const mp4Path = path.join(tempDir, `react_${stamp}.mp4`);

  try {
    fs.writeFileSync(gifPath, buf);
    // Small square-ish clip — WA greys out huge remote GIF URLs
    await runFfmpeg([
      '-y',
      '-i', gifPath,
      '-vf', 'fps=12,scale=320:-2:flags=lanczos',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '28',
      '-movflags', '+faststart',
      '-an',
      '-t', '6',
      mp4Path,
    ]);
    if (!fs.existsSync(mp4Path)) throw new Error('mp4 missing');
    const mp4 = fs.readFileSync(mp4Path);
    if (!mp4.length) throw new Error('empty mp4');
    if (mp4.length > 8 * 1024 * 1024) throw new Error('mp4 still too large');
    return mp4;
  } finally {
    deleteTempFile(gifPath);
    deleteTempFile(mp4Path);
  }
}

async function sendActionGif(sock, from, msg, { url, caption, mentions }) {
  const unique = [...new Set((mentions || []).filter(Boolean))];
  const payload = { caption, mentions: unique };

  try {
    const mp4 = await reactionGifToMp4(url);
    await sock.sendMessage(
      from,
      {
        video: mp4,
        mimetype: 'video/mp4',
        gifPlayback: true,
        ...payload,
      },
      { quoted: msg }
    );
    return;
  } catch (err) {
    console.warn('[action-gif] convert failed:', err.message);
  }

  // Last resort: caption only (avoid grey blank media)
  await sock.sendMessage(from, { text: caption, mentions: unique }, { quoted: msg });
}

/**
 * Action cmd: tag @user OR reply to a message.
 * GIF from LadybugAPI /api/gif/:type (same type as command name).
 */
function createActionCommand(name, aliases, verb, emoji, gifType) {
  const type = String(gifType || name).trim().toLowerCase();
  return {
    name,
    aliases,
    category: 'fun',
    description: `${verb} a user (GIF)`,
    usage: `.${name} @user`,
    async execute(sock, msg, args, extra) {
      try {
        // mentionedJid OR reply (contextInfo.participant)
        const { jid, tag: t } = getTargetUser(msg, extra);
        const fromTag = tag(extra.sender);
        const caption = `${emoji} ${fromTag} ${verb} ${t}!`;
        const mentions = [extra.sender, jid];

        let gif;
        try {
          gif = await APIs.getReactionGif(type);
        } catch (err) {
          console.error(`[${name}] gif:`, err.message);
          await sendMention(sock, extra.from, msg, caption, mentions);
          return;
        }

        await sendActionGif(sock, extra.from, msg, {
          url: gif.url,
          caption,
          mentions,
        });
      } catch (e) {
        console.error(`[${name}]`, e.message);
        await extra.reply('❌ Something went wrong.');
      }
    },
  };
}

module.exports = {
  tag,
  pick,
  percentFromId,
  percentFromPair,
  getTargetUser,
  getTwoUsers,
  getUserName,
  getMentionTarget,
  getUserPicUrl,
  getCardTarget,
  resolveJoinLeaveTarget,
  resolveCardPerson,
  toMention,
  findParticipant,
  askFunAi,
  sendMention,
  createRateCommand,
  createPairRateCommand,
  createPairCommand,
  createRandomCommand,
  createActionCommand,
};
