/**
 * Ladybug Cloud - custom commands (bot side)
 *
 * Commands are created through the Ladybug Cloud API (POST /api/v1/bots/:id/commands).
 * The platform writes them to the JSON file named by CUSTOM_COMMANDS_FILE; this module
 * reads that file (re-read automatically when it changes, no bot restart needed) and
 * exposes each entry as a normal command object that handler.js can run through its
 * usual permission checks.
 *
 * This file is copied into bots/ladybug/utils/ by the platform. Do not edit it there;
 * edit lib/bot-shims/customCommands.js in the platform repo instead.
 */
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const FILE = process.env.CUSTOM_COMMANDS_FILE || '';
const MAX_REPLY = 2000;
const MAX_BODY = 5 * 1024 * 1024; // 5 MB for images, text replies are cut much earlier
const HTTP_TIMEOUT_MS = 5000;

let cache = { mtime: 0, map: new Map() };
const lastUsed = new Map(); // `${cmdId}:${sender}` -> timestamp

function load() {
  if (!FILE) return cache.map;
  let st;
  try { st = fs.statSync(FILE); } catch (e) {
    if (cache.map.size) cache = { mtime: 0, map: new Map() };
    return cache.map;
  }
  if (st.mtimeMs === cache.mtime) return cache.map;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const map = new Map();
    for (const c of Array.isArray(data.commands) ? data.commands : []) {
      if (!c || !c.name || c.enabled === false) continue;
      map.set(String(c.name).toLowerCase(), c);
      for (const a of c.aliases || []) map.set(String(a).toLowerCase(), c);
    }
    cache = { mtime: st.mtimeMs, map };
  } catch (e) {
    console.error('[custom-commands] could not read commands file:', e.message);
  }
  return cache.map;
}

// ---- outbound HTTP, with a guard that refuses private / internal addresses ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
      v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  }
  return true;
}

// The check runs on the address actually connected to, which defeats DNS rebinding.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return cb(new Error('Blocked: URL points to a private or internal address'));
    }
    if (options && options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function request(rawUrl, { method = 'GET', headers = {}, body = null, maxBytes = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(new Error('Invalid URL')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Only http(s) URLs are allowed'));
    if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) return reject(new Error('Blocked: private address'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, lookup: safeLookup, timeout: HTTP_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('Response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function render(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)).slice(0, MAX_REPLY);
}

function buildVars(ctx, args, cmd) {
  const vars = {
    name: ctx.pushName || 'there',
    sender: String(ctx.sender || '').split('@')[0].split(':')[0],
    args: args.join(' '),
    command: cmd.name,
    prefix: ctx.prefix || '',
    botname: ctx.botName || '',
    group: (ctx.groupMetadata && ctx.groupMetadata.subject) || '',
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString().slice(11, 16) + ' UTC',
  };
  args.slice(0, 9).forEach((a, i) => { vars[`arg${i + 1}`] = a; });
  return vars;
}

async function runWebhook(cmd, ctx, args) {
  const payload = JSON.stringify({
    command: cmd.name,
    args,
    text: args.join(' '),
    sender: String(ctx.sender || '').split('@')[0].split(':')[0],
    pushName: ctx.pushName || null,
    isGroup: !!ctx.isGroup,
    group: ctx.isGroup ? { id: ctx.from, name: (ctx.groupMetadata && ctx.groupMetadata.subject) || null } : null,
    isOwner: !!ctx.isOwner,
    isAdmin: !!ctx.isAdmin,
    botId: process.env.LADYBUG_BOT_ID || null,
    sentAt: new Date().toISOString(),
  });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'LadybugCloud-Command/1', 'X-Ladybug-Command': cmd.name };
  if (cmd.secret) headers['X-Ladybug-Signature'] = 'sha256=' + crypto.createHmac('sha256', cmd.secret).update(payload).digest('hex');
  const isPost = cmd.method !== 'GET';
  let url = cmd.url;
  if (!isPost) {
    const u = new URL(url);
    u.searchParams.set('command', cmd.name);
    u.searchParams.set('text', args.join(' '));
    u.searchParams.set('sender', String(ctx.sender || '').split('@')[0].split(':')[0]);
    url = u.toString();
  }
  const r = await request(url, { method: isPost ? 'POST' : 'GET', headers, body: isPost ? payload : null });
  if (r.status < 200 || r.status >= 300) throw new Error(`Webhook answered HTTP ${r.status}`);
  const text = r.body.toString('utf8').trim();
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      return { reply: j.reply != null ? String(j.reply) : (j.text != null ? String(j.text) : ''), image: j.image || null, caption: j.caption || '' };
    }
  } catch (e) { /* plain text reply */ }
  return { reply: text, image: null, caption: '' };
}

async function sendImage(sock, msg, from, url, caption) {
  const r = await request(url, { maxBytes: MAX_BODY });
  if (r.status < 200 || r.status >= 300) throw new Error(`Image URL answered HTTP ${r.status}`);
  const type = String(r.headers['content-type'] || '');
  if (!type.startsWith('image/')) throw new Error('URL did not return an image');
  return sock.sendMessage(from, { image: r.body, caption: caption || undefined }, { quoted: msg });
}

/** Turn a stored record into a command object handler.js understands. */
function toCommand(c) {
  return {
    name: c.name,
    aliases: c.aliases || [],
    description: c.description || '',
    custom: true,
    ownerOnly: c.access === 'owner',
    adminOnly: c.access === 'admins',
    groupOnly: c.scope === 'group',
    privateOnly: c.scope === 'private',
    async execute(sock, msg, args, ctx) {
      if (c.cooldownSeconds > 0 && !ctx.isOwner) {
        const key = `${c.id}:${ctx.sender}`;
        const now = Date.now();
        const last = lastUsed.get(key) || 0;
        if (now - last < c.cooldownSeconds * 1000) {
          const wait = Math.ceil((c.cooldownSeconds * 1000 - (now - last)) / 1000);
          return sock.sendMessage(ctx.from, { text: `Please wait ${wait}s before using *${c.name}* again.` }, { quoted: msg });
        }
        lastUsed.set(key, now);
        if (lastUsed.size > 5000) for (const k of lastUsed.keys()) { lastUsed.delete(k); if (lastUsed.size < 2500) break; }
      }
      const vars = buildVars({ ...ctx, botName: process.env.BOT_NAME, prefix: process.env.PREFIX || '.' }, args, c);
      try {
        if (c.type === 'image') {
          await sendImage(sock, msg, ctx.from, c.imageUrl, render(c.response, vars));
        } else if (c.type === 'webhook') {
          const out = await runWebhook(c, ctx, args);
          if (out.image) await sendImage(sock, msg, ctx.from, out.image, String(out.caption || out.reply || '').slice(0, MAX_REPLY));
          else if (out.reply) await sock.sendMessage(ctx.from, { text: out.reply.slice(0, MAX_REPLY) }, { quoted: msg });
        } else {
          await sock.sendMessage(ctx.from, { text: render(c.response, vars) }, { quoted: msg });
        }
      } catch (e) {
        console.error(`[custom-commands] "${c.name}" failed: ${e.message}`);
        await sock.sendMessage(ctx.from, { text: `Sorry, *${c.name}* could not be completed right now.` }, { quoted: msg }).catch(() => {});
      }
    },
  };
}

const built = new WeakMap();
/** Returns a command object for a custom command, or null. Never throws. */
function find(commandName) {
  try {
    const c = load().get(String(commandName || '').toLowerCase());
    if (!c) return null;
    if (!built.has(c)) built.set(c, toCommand(c));
    return built.get(c);
  } catch (e) {
    return null;
  }
}

module.exports = { find, isPrivateIp, render };
