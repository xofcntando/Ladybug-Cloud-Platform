/**
 * Cross-entity search for the command palette.
 *
 * The palette is a jump box: it should find a bot, a file in the drive, or a past event
 * without the user remembering which page it lives on. Everything here is scoped to one
 * user, so the search can never leak another account's bots or files.
 *
 * Kept deliberately simple: substring matching with a small relevance score. There is no
 * index to keep in sync, which matters because the underlying data is plain JSON and a
 * filesystem tree that changes on every upload.
 */
const fs = require('fs');
const path = require('path');
const db = require('./store');
const storage = require('./storage');
const activity = require('./activity');

const MAX_Q = 60;
const MAX_FILES = 400; // filesystem walk cap, so a huge drive cannot stall a keystroke
const MAX_DEPTH = 6;

function norm(v) { return String(v == null ? '' : v).toLowerCase(); }

/** Higher is better. Prefix matches beat word-prefix beats substring. */
function score(hay, needle) {
  const h = norm(hay);
  const n = norm(needle);
  if (!n) return 0;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  const at = h.indexOf(n);
  if (at < 0) return 0;
  if (at === 0 || /[\s\-_/.]/.test(h[at - 1])) return 60;
  return 30;
}

function botResults(user, needle) {
  const out = [];
  for (const b of db.botsForUser(user.id)) {
    const s = Math.max(score(b.name, needle), score(b.id, needle) * 0.4);
    if (!s) continue;
    out.push({
      kind: 'bot',
      id: b.id,
      title: b.name,
      sub: (b.status || 'stopped') + (b.hasSession ? ' · linked number' : ' · no session'),
      href: '#/web?bot=' + encodeURIComponent(b.id),
      score: s,
    });
  }
  return out;
}

function fileResults(user, needle) {
  const out = [];
  let seen = 0;
  let root;
  try { root = storage.userRoot ? storage.userRoot(user.id) : storage.resolveIn(user.id, '').base; } catch (e) { return out; }
  (function walk(dir, rel, depth) {
    if (seen >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (seen >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      seen++;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const s = score(e.name, needle);
      if (s) {
        out.push({
          kind: 'file',
          id: childRel,
          title: e.name,
          sub: (e.isDirectory() ? 'folder · ' : 'file · ') + (rel || 'My drive'),
          href: '#/storage?p=' + encodeURIComponent(e.isDirectory() ? childRel : rel),
          score: s - (e.isDirectory() ? 0 : 2),
        });
      }
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel, depth + 1);
    }
  })(root, '', 0);
  return out;
}

function activityResults(user, needle) {
  const out = [];
  const r = activity.list(user.id, { limit: 100, q: needle });
  for (const i of r.items.slice(0, 8)) {
    out.push({
      kind: 'activity',
      id: i.id,
      title: i.title,
      sub: i.type + (i.detail ? ' · ' + i.detail : ''),
      href: '#/activity?q=' + encodeURIComponent(i.title.slice(0, 40)),
      score: Math.max(20, score(i.title, needle)),
    });
  }
  return out;
}

/**
 * @param {object} user  the authenticated user
 * @param {string} q     the typed query
 * @returns {{query:string, results:Array, counts:object}}
 */
function search(user, q) {
  const needle = String(q || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_Q);
  if (!needle) return { query: '', results: [], counts: { bot: 0, file: 0, activity: 0 } };
  const all = [...botResults(user, needle), ...fileResults(user, needle), ...activityResults(user, needle)]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 24);
  const counts = { bot: 0, file: 0, activity: 0 };
  for (const r of all) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return { query: needle, results: all, counts };
}

module.exports = { search, score };
