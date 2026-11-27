/**
 * Saved replies ("snippets") for the web console.
 *
 * A snippet is a shortcut plus a body: type /price in the console and the whole
 * paragraph appears in the composer. They belong to the *user*, not to a single
 * bot, so the same answers follow you across every number you host.
 *
 * Bodies support the same placeholders as custom commands:
 *   {name} {first} {group} {bot} {me} {date} {time}
 *
 * Stored in db.snippets. Limits are per user so one account cannot fill the
 * database with drafts.
 */
const db = require('./store');

const MAX_PER_USER = Number(process.env.SNIPPET_LIMIT) || 60;
const MAX_TITLE = 80;
const MAX_BODY = 2000;
const MAX_TAGS = 5;
const SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

const VARS = ['name', 'first', 'group', 'bot', 'me', 'date', 'time'];

/** Ready-made replies offered to a brand new account (not stored until saved). */
const SUGGESTIONS = [
  { shortcut: 'price', title: 'Price list', tags: ['sales'], body: 'Hi {first}! Hosting is $3/month for one number, or 20 free coins a day. Reply *price* any time and I will resend this. 🐞' },
  { shortcut: 'hours', title: 'Opening hours', tags: ['general'], body: 'We are open Monday to Saturday, 8am to 6pm. Messages after hours are answered first thing the next morning.' },
  { shortcut: 'pay', title: 'How to pay', tags: ['sales'], body: 'You can pay in USD or ZiG. Open the dashboard, tap *Pay*, then send the reference here. Your plan switches on as soon as we confirm it.' },
  { shortcut: 'thanks', title: 'Thank you', tags: ['support'], body: 'Thank you {name}! If anything else comes up, just reply here — a real person reads every message.' },
  { shortcut: 'wait', title: 'Please hold', tags: ['support'], body: 'Thanks for the message. I am checking this now and will come back to you within the hour.' },
  { shortcut: 'group', title: 'Group rules', tags: ['groups'], body: 'Welcome to {group}! Please keep it kind, no spam links, and ask an admin before posting adverts. 🐞' },
];

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);

function normaliseShortcut(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/^[./#!]+/, '');
}

function view(s) {
  return {
    id: s.id,
    shortcut: s.shortcut,
    title: s.title,
    body: s.body,
    tags: s.tags || [],
    uses: s.uses || 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Newest-used first, then most used, then alphabetical. */
function list(userId) {
  return db.snippetsForUser(userId)
    .slice()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || (b.uses || 0) - (a.uses || 0) || a.title.localeCompare(b.title))
    .map(view);
}

function find(userId, idOrShortcut) {
  const key = String(idOrShortcut || '');
  return db.snippetsForUser(userId).find((s) => s.id === key || s.shortcut === normaliseShortcut(key)) || null;
}

function search(userId, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return list(userId);
  return list(userId).filter((s) =>
    s.shortcut.includes(needle) ||
    s.title.toLowerCase().includes(needle) ||
    s.body.toLowerCase().includes(needle) ||
    (s.tags || []).some((t) => t.toLowerCase().includes(needle))
  );
}

/** Validate create (no `existing`) or a partial update. Returns { value } | { error, code }. */
function validate(input, existing, others) {
  const body = input || {};
  const out = existing ? { ...existing } : {};
  const has = (k) => body[k] !== undefined;

  if (!existing || has('shortcut')) {
    const shortcut = normaliseShortcut(body.shortcut);
    if (!SHORTCUT_RE.test(shortcut)) {
      return { code: 400, error: 'Shortcut must be 1-24 characters: a-z, 0-9, "-" or "_" (no spaces, no slash).' };
    }
    if ((others || []).some((s) => s.shortcut === shortcut)) {
      return { code: 409, error: `You already have a snippet called /${shortcut}.` };
    }
    out.shortcut = shortcut;
  }
  if (!existing || has('title')) {
    const title = clean(body.title, MAX_TITLE);
    if (!title) return { code: 400, error: 'Give the snippet a title so you can find it later.' };
    out.title = title;
  }
  if (!existing || has('body')) {
    const text = clean(body.body, MAX_BODY);
    if (!text) return { code: 400, error: 'The snippet body cannot be empty.' };
    out.body = text;
  }
  if (!existing || has('tags')) {
    const raw = body.tags == null ? [] : Array.isArray(body.tags) ? body.tags : String(body.tags).split(/[,\s]+/);
    out.tags = [...new Set(raw.map((t) => clean(t, 20).toLowerCase()).filter(Boolean))].slice(0, MAX_TAGS);
  }
  return { value: out };
}

let counter = 0;
function newId() {
  counter = (counter + 1) % 1e6;
  return `sn_${Date.now().toString(36)}${counter.toString(36)}`;
}

function create(userId, input) {
  const mine = db.snippetsForUser(userId);
  if (mine.length >= MAX_PER_USER) {
    return { code: 400, error: `You can keep ${MAX_PER_USER} saved replies. Delete one to make room.` };
  }
  const v = validate(input, null, mine);
  if (v.error) return v;
  const at = Date.now();
  const rec = { id: newId(), userId, ...v.value, uses: 0, createdAt: at, updatedAt: at, lastUsedAt: null };
  db.addSnippet(rec);
  return { snippet: view(rec) };
}

function update(userId, idOrShortcut, input) {
  const cur = find(userId, idOrShortcut);
  if (!cur) return { code: 404, error: 'Snippet not found.' };
  const others = db.snippetsForUser(userId).filter((s) => s.id !== cur.id);
  const v = validate(input, cur, others);
  if (v.error) return v;
  const rec = db.updateSnippet(cur.id, { ...v.value, updatedAt: Date.now() });
  return { snippet: view(rec) };
}

function remove(userId, idOrShortcut) {
  const cur = find(userId, idOrShortcut);
  if (!cur) return false;
  return db.deleteSnippet(cur.id);
}

/** Count a use (called when the console inserts it) and return the filled text. */
function use(userId, idOrShortcut, ctx) {
  const cur = find(userId, idOrShortcut);
  if (!cur) return null;
  const at = Date.now();
  const uses = (cur.uses || 0) + 1;
  db.updateSnippet(cur.id, { uses, lastUsedAt: at });
  return { snippet: view({ ...cur, uses, lastUsedAt: at }), text: render(cur.body, ctx) };
}

/** Fill {name} {first} {group} {bot} {me} {date} {time} and leave unknown braces alone. */
function render(text, ctx) {
  const c = ctx || {};
  const now = new Date();
  const values = {
    name: c.name || c.pushName || 'there',
    first: String(c.name || c.pushName || 'there').split(/\s+/)[0],
    group: c.group || 'the group',
    bot: c.bot || 'Ladybug',
    me: c.me || c.bot || 'Ladybug',
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16),
  };
  return String(text || '').replace(/\{(name|first|group|bot|me|date|time)\}/g, (m, k) => values[k]);
}

/** Snippets for a user, with suggestions mixed in when the list is still empty. */
function view2(userId) {
  const items = list(userId);
  const taken = new Set(items.map((s) => s.shortcut));
  return {
    snippets: items,
    total: items.length,
    max: MAX_PER_USER,
    variables: VARS,
    suggestions: items.length ? [] : SUGGESTIONS.filter((s) => !taken.has(s.shortcut)),
  };
}

module.exports = {
  MAX_PER_USER,
  MAX_TITLE,
  MAX_BODY,
  MAX_TAGS,
  VARS,
  SUGGESTIONS,
  list,
  find,
  search,
  view,
  view2,
  create,
  update,
  remove,
  use,
  render,
  validate,
  normaliseShortcut,
};
