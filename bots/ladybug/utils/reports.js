/**
 * Ladybug Cloud — bug reports and feature requests from inside WhatsApp.
 *
 * Two destinations, deliberately:
 *
 *   1. A local file in the bot's own data folder, so `.reports` works even when
 *      the platform is not running the bot (self-hosted, bare `node index.js`).
 *   2. An IPC event to the platform, which copies it into the owner's Activity
 *      feed so it shows up in the web console without any extra UI.
 *
 * Reports are capped and trimmed: a bot in a busy group must not be able to
 * fill the disk by being spammed with `.bug`.
 *
 * This file is copied into bots/ladybug/utils/ by the platform installer.
 * Edit lib/bot-shims/reports.js in the platform repo instead.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['bug', 'feature', 'feedback'];
const MAX_STORED = 200;
const MAX_TEXT = 1200;
const MAX_META = 400;

function dataDir() {
  return process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'database');
}

function file() {
  return path.join(dataDir(), 'reports.json');
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** "BUG-4F2A" — short enough to quote, random enough not to collide. */
function makeId(kind) {
  const tag = kind === 'feature' ? 'REQ' : kind === 'feedback' ? 'FBK' : 'BUG';
  return `${tag}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function read() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function write(list) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(list.slice(0, MAX_STORED), null, 2));
    return true;
  } catch (e) {
    console.error('[reports] could not save:', e.message);
    return false;
  }
}

function normaliseKind(kind) {
  const k = clean(kind, 20).toLowerCase();
  return KINDS.includes(k) ? k : 'bug';
}

/**
 * Record one report.
 * @param {{kind?:string, text:string, from?:string, sender?:string, name?:string, group?:string}} input
 * @returns {{id:string, kind:string, text:string, at:number, saved:boolean, sent:boolean}}
 */
function add(input) {
  const kind = normaliseKind(input && input.kind);
  const text = clean(input && input.text, MAX_TEXT);
  if (!text) throw new Error('A report needs some words in it.');

  const entry = {
    id: makeId(kind),
    kind,
    text,
    at: Date.now(),
    from: clean(input.from, 80),
    sender: clean(input.sender, 80),
    name: clean(input.name, 60),
    group: clean(input.group, 80),
    meta: clean(input.meta, MAX_META),
  };

  const list = read();
  list.unshift(entry);
  const saved = write(list);

  // Tell the platform, so it lands in the owner's Activity feed. Harmless when
  // the bot is running standalone: process.send simply does not exist.
  let sent = false;
  try {
    if (typeof process.send === 'function') {
      process.send({
        type: 'wa',
        event: 'report',
        reportId: entry.id,
        kind: entry.kind,
        text: entry.text,
        jid: entry.from,
        sender: entry.sender,
        name: entry.name,
        group: entry.group,
      });
      sent = true;
    }
  } catch (e) { /* parent gone */ }

  return { id: entry.id, kind: entry.kind, text: entry.text, at: entry.at, saved, sent };
}

/** Newest first, optionally filtered by kind. */
function list(opts = {}) {
  const kind = opts.kind ? normaliseKind(opts.kind) : '';
  const limit = Math.max(1, Math.min(MAX_STORED, parseInt(opts.limit, 10) || 20));
  const all = read();
  const rows = kind ? all.filter((r) => r && r.kind === kind) : all;
  return rows.slice(0, limit);
}

function counts() {
  const out = { bug: 0, feature: 0, feedback: 0, total: 0 };
  for (const r of read()) {
    if (!r || !KINDS.includes(r.kind)) continue;
    out[r.kind] += 1;
    out.total += 1;
  }
  return out;
}

function clear(kind) {
  if (!kind) {
    write([]);
    return 0;
  }
  const k = normaliseKind(kind);
  const before = read();
  const kept = before.filter((r) => !r || r.kind !== k);
  write(kept);
  return before.length - kept.length;
}

module.exports = { add, list, counts, clear, read, file, KINDS, MAX_STORED, MAX_TEXT, makeId, clean };
