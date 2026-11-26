/**
 * Chat Digest — a local, dependency-free summary of a conversation.
 *
 * Everything runs on the platform: the messages are already in the bot's in-memory
 * snapshot (or in the saved chat archive while the bot is offline), and nothing is sent
 * to an AI provider. That keeps the promise the console makes to users ("messages never
 * leave the server") and means the feature works with no API keys and no extra cost.
 *
 * The output is intentionally factual: counts, participants, topics, open questions,
 * requests, decisions, links and activity. It is a reading aid, not a chatbot.
 */

const STOPWORDS = new Set((
  'the a an and or but if then than that this these those there here ' +
  'i you he she it we they me him her us them my your his its our their ' +
  'is are was were be been being am do does did doing have has had having ' +
  'will would shall should can could may might must ' +
  'to of in on at by for with about into from up down out over under again ' +
  'not no yes ok okay just so very too also as well what which who whom whose when where why how ' +
  'all any both each few more most other some such only own same s t don now ' +
  'im ive id ill youre hes shes weve theyre cant wont didnt doesnt isnt arent wasnt ' +
  'u ur pls plz thx thanks thank hi hello hey dear please kindly really much many ' +
  'get got make made go going gone come came want need know think see look say said tell told ' +
  'like still even ever never always already yet maybe perhaps'
).split(/\s+/).filter(Boolean));

const MAX_TEXT = 4000;

const clean = (v, max = MAX_TEXT) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const isText = (m) => m && !m.deleted && m.type !== 'reaction' && typeof m.text === 'string' && m.text.trim();

/** The bridge stores timestamps in seconds; accept milliseconds too so imported archives
 *  and hand-built payloads can never shift the whole window into the wrong century. */
function secs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}
/** Media kind: the bridge sets `type`, older archives may only carry `media`. */
function mediaKind(m) {
  const t = m.type && m.type !== 'text' ? m.type : (typeof m.media === 'string' ? m.media : null);
  return t && t !== 'text' ? t : null;
}

function tokens(text) {
  const out = [];
  const src = String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/@\d{5,20}/g, ' ');
  const re = /[A-Za-z][A-Za-z'’-]{2,}/g;
  let m;
  while ((m = re.exec(src))) {
    const w = m[0].toLowerCase().replace(/['’]s$/, '');
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

const QUESTION_RE = /\?/;
const REQUEST_RE = /\b(please|kindly|can you|could you|would you|need you to|i need|we need|don'?t forget|remember to|make sure|send me|share|let me know|confirm|deadline|by (today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|asap|urgent|to-?do|follow up|waiting for)\b/i;
const DECISION_RE = /\b(we agreed|agreed|decided|decision|confirmed|final|approved|let'?s do|we will|we'?ll|going with|i will|i'?ll|deal|done deal|settled)\b/i;
const LINK_RE = /https?:\/\/[^\s<>"')]+/gi;

function participantName(m) {
  if (m.fromMe) return 'You';
  return clean(m.senderName || m.participantName || (m.sender && m.sender !== 'me' ? '+' + String(m.sender).replace(/\D/g, '') : '') || 'Unknown', 40) || 'Unknown';
}

function hourOf(ts) { return new Date(ts * 1000).getHours(); }
function dayKey(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * @param {Array} messages  bridge message entries: { id, ts, fromMe, sender, senderName, text, type, deleted }
 * @param {Object} opts     { days = 7, now = seconds, maxItems = 8 }
 */
function summarize(messages, opts = {}) {
  const now = Number(opts.now) || Math.floor(Date.now() / 1000);
  const days = Math.min(90, Math.max(1, Number(opts.days) || 7));
  const from = now - days * 86400;
  const maxItems = Math.min(20, Math.max(3, Number(opts.maxItems) || 8));

  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === 'object' && m.type !== 'reaction' && secs(m.ts) > 0)
    .map((m) => (secs(m.ts) === Number(m.ts) ? m : { ...m, ts: secs(m.ts) }))
    .filter((m) => Number(m.ts) >= from)
    .sort((a, b) => a.ts - b.ts);

  const totals = { messages: list.length, incoming: 0, outgoing: 0, deleted: 0, media: 0, text: 0 };
  const people = new Map();
  const words = new Map();
  const links = new Map();
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const perDay = new Map();
  const media = { image: 0, video: 0, audio: 0, voice: 0, document: 0, sticker: 0, other: 0 };
  const questions = [];
  const requests = [];
  const decisions = [];
  const highlights = [];

  for (const m of list) {
    const ts = Number(m.ts);
    // A deleted message still counts in the totals, but it has no author or content left
    // to attribute, so it must not create a phantom participant.
    if (m.deleted) { totals.deleted++; continue; }
    const name = participantName(m);
    const p = people.get(name) || { name, total: 0, incoming: 0, outgoing: 0, firstTs: ts, lastTs: ts };
    p.total++;
    p.lastTs = ts;
    if (m.fromMe) { totals.outgoing++; p.outgoing++; } else { totals.incoming++; p.incoming++; }
    people.set(name, p);

    hours[hourOf(ts)]++;
    weekdays[new Date(ts * 1000).getDay()]++;
    const dk = dayKey(ts);
    perDay.set(dk, (perDay.get(dk) || 0) + 1);

    const kind = mediaKind(m);
    if (kind) {
      totals.media++;
      if (media[kind] != null) media[kind]++; else media.other++;
    } else {
      totals.text++;
    }

    if (!isText(m)) continue;
    const text = clean(m.text, 1200);
    if (!text) continue;

    for (const w of tokens(text)) words.set(w, (words.get(w) || 0) + 1);

    let lm;
    LINK_RE.lastIndex = 0;
    while ((lm = LINK_RE.exec(text))) {
      const url = lm[0].replace(/[.,;:!?]+$/, '');
      const rec = links.get(url) || { url, count: 0, ts };
      rec.count++;
      if (ts > rec.ts) rec.ts = ts;
      links.set(url, rec);
    }

    const item = { id: m.id || 'm' + ts, text: text.slice(0, 400), ts, fromMe: !!m.fromMe, who: name };
    if (!m.fromMe && QUESTION_RE.test(text)) questions.push(item);
    if (REQUEST_RE.test(text)) requests.push({ ...item, owner: m.fromMe ? 'you' : 'them' });
    if (DECISION_RE.test(text)) decisions.push(item);

    // Highlights: substantive messages, not one-word replies.
    if (text.length >= 60) highlights.push({ ...item, score: Math.min(400, text.length) + (REQUEST_RE.test(text) ? 120 : 0) + (DECISION_RE.test(text) ? 100 : 0) });
  }

  // A question counts as answered when we sent anything afterwards.
  const answered = new Set();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!isText(m) || m.fromMe || !QUESTION_RE.test(m.text)) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].fromMe && isText(list[j])) { answered.add(m.id || 'm' + m.ts); break; }
    }
  }
  const openQuestions = questions.filter((q) => !answered.has(q.id));

  const topWords = [...words.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([word, count]) => ({ word, count }));

  const topLinks = [...links.values()].sort((a, b) => b.count - a.count || b.ts - a.ts).slice(0, 10);
  const topPeople = [...people.values()].sort((a, b) => b.total - a.total).slice(0, 8);
  const bestHighlights = highlights.sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, 3)
    .map(({ score, ...h }) => h);

  const busiestHour = totals.messages ? hours.indexOf(Math.max(...hours)) : null;
  const busiestDay = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const first = list[0] || null;
  const last = list[list.length - 1] || null;

  const summary = [];
  if (!totals.messages) {
    summary.push(`No messages in this chat in the last ${days} day${days === 1 ? '' : 's'}.`);
  } else {
    const who = topPeople.filter((p) => p.name !== 'You').slice(0, 2).map((p) => p.name).join(' and ');
    summary.push(`${totals.messages} message${totals.messages === 1 ? '' : 's'} in the last ${days} day${days === 1 ? '' : 's'}` +
      (who ? `, mostly with ${who}` : '') + ` (${totals.incoming} in, ${totals.outgoing} out).`);
    if (topWords.length) summary.push(`Main topics: ${topWords.slice(0, 6).map((w) => w.word).join(', ')}.`);
    if (openQuestions.length) summary.push(`${openQuestions.length} question${openQuestions.length === 1 ? '' : 's'} from them ${openQuestions.length === 1 ? 'is' : 'are'} still waiting for a reply.`);
    else if (questions.length) summary.push('Every question in this window has been answered.');
    if (requests.length) summary.push(`${requests.length} request${requests.length === 1 ? '' : 's'} or deadline${requests.length === 1 ? '' : 's'} mentioned.`);
    if (decisions.length) summary.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} or commitment${decisions.length === 1 ? '' : 's'} recorded.`);
    if (busiestHour != null) summary.push(`Busiest hour: ${String(busiestHour).padStart(2, '0')}:00.`);
  }

  return {
    ok: true,
    span: { days, from, to: now, firstTs: first ? first.ts : null, lastTs: last ? last.ts : null },
    totals,
    people: topPeople,
    keywords: topWords,
    links: topLinks,
    questions: openQuestions.slice(-maxItems).reverse(),
    answeredQuestions: Math.max(0, questions.length - openQuestions.length),
    requests: requests.slice(-maxItems).reverse(),
    decisions: decisions.slice(-maxItems).reverse(),
    highlights: bestHighlights,
    activity: { hours, weekdays, busiestHour, busiestDay: busiestDay ? { day: busiestDay[0], count: busiestDay[1] } : null, perDay: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, count]) => ({ day, count })) },
    media,
    summary,
  };
}

module.exports = { summarize, tokens, STOPWORDS };
