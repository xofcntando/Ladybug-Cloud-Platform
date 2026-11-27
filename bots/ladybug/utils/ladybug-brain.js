/* Ladybug Brain - the built-in auto-responder.
   -------------------------------------------
   Every other auto-reply on the platform needs something from the owner: a keyword rule, a
   flow, or an API key. This one needs nothing. It is a small reasoning engine that runs
   inside the bot process, reads the message, works out what the person actually wants, and
   answers from the owner's own business profile - or asks a sensible follow-up question.

   It is deliberately NOT a language model. A model that invents a price, a delivery time or
   a promise is worse than no bot at all, so the design is:

       understand  ->  retrieve  ->  reason  ->  decide  ->  answer
       (intent +       (owner's      (rules over   (answer /    (grounded text,
        entities +      FAQs and      the facts)    clarify /    or an honest
        sentiment)      profile)                    escalate)    hand-off)

   Every answer carries a `trace` explaining why it was chosen, a confidence score, and -
   when it cannot help - a `gap` the owner can turn into a FAQ with one tap.

   Pure and dependency-free on purpose: the same file runs in the bot process (copied next to
   webBridge.js by the installer), in the platform for the console's "try it" box, and in the
   test suite.
*/
'use strict';

const MAX_FAQS = 60;
const MAX_PRICES = 40;
const MAX_REPLY = 900;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 800;

/* ------------------------------------------------------------------ text utils */

const STOP = new Set(('a an the and or but if then than that this these those is are was were be been being am ' +
  'do does did doing have has had having i you he she it we they me him her us them my your his its our their ' +
  'of to in on at for with about from by as so such no not yes ok okay just very really can could would should ' +
  'will shall may might must please pls plz thanks thank hi hello hey there what whats which who whom whose when ' +
  'where why how any some all more most much many few lot also too only own same other another get got getting ' +
  'want need like know tell say said ask give make made go going come came').split(' '));

const CONTRACTIONS = [
  [/what's/g, 'what is'], [/whats/g, 'what is'], [/where's/g, 'where is'], [/who's/g, 'who is'],
  [/how's/g, 'how is'], [/that's/g, 'that is'], [/it's/g, 'it is'], [/i'm/g, 'i am'], [/we're/g, 'we are'],
  [/they're/g, 'they are'], [/you're/g, 'you are'], [/don't/g, 'do not'], [/doesn't/g, 'does not'],
  [/didn't/g, 'did not'], [/can't/g, 'can not'], [/cannot/g, 'can not'], [/won't/g, 'will not'],
  [/isn't/g, 'is not'], [/aren't/g, 'are not'], [/i'd/g, 'i would'], [/i'll/g, 'i will'],
  [/we'll/g, 'we will'], [/i've/g, 'i have'], [/we've/g, 'we have'], [/let's/g, 'let us'],
];

/** Lowercase, de-accent, expand contractions, drop punctuation. Keeps digits. */
function norm(s) {
  let t = String(s == null ? '' : s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old node */ }
  for (const pair of CONTRACTIONS) t = t.replace(pair[0], pair[1]);
  t = t.replace(/[\u2019']/g, '').replace(/[^a-z0-9@.+:\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

/** Crude but predictable English stemmer: enough to match "prices" with "price". */
function stem(w) {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ing$/.test(w) && w.length > 5) return w.slice(0, -3);
  if (/edly$/.test(w)) return w.slice(0, -5);
  if (/ed$/.test(w) && w.length > 4) return w.slice(0, -2);
  // "boxes" -> "box" and "addresses" -> "address", but "prices" -> "price" (not "pric")
  if (/(ches|shes|xes|zes|ses)$/.test(w)) return w.slice(0, -2);
  if (/es$/.test(w) && w.length > 4) return w.slice(0, -1);
  if (/s$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

function words(s) {
  return norm(s).split(' ').map(stem).filter(Boolean);
}
function tokens(s) {
  return words(s).filter((w) => !STOP.has(w));
}

/* ------------------------------------------------------------------ entities */

const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const RE_URL = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
const RE_MONEY = /(?:usd|us\$|\$|zig|zwg|eur|\u00a3)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:usd|dollars?|zig|rand|bucks)/i;
const RE_PHONE = /(\+?\d[\d\s\-()]{7,}\d)/;
const RE_ORDER = /\b(?:order|invoice|receipt|ref|reference|ticket|booking)\s*(?:number|no|num|id|#)?\s*[:#]?\s*(?:is\s+)?([a-z]{0,4}[-\s]?\d{3,12})\b/i;
const RE_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;
const RE_DATE = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b/i;

function entities(text) {
  const raw = String(text || '');
  const out = {};
  const em = RE_EMAIL.exec(raw); if (em) out.email = em[0];
  const url = RE_URL.exec(raw); if (url) out.url = url[0];
  const mny = RE_MONEY.exec(raw); if (mny) out.amount = (mny[1] || mny[2]).replace(/,/g, '');
  const order = RE_ORDER.exec(raw); if (order) out.order = order[1].replace(/\s+/g, '').toUpperCase();
  const time = RE_TIME.exec(raw); if (time) out.time = time[0].toLowerCase();
  const date = RE_DATE.exec(raw); if (date) out.date = date[1].toLowerCase();
  const phone = RE_PHONE.exec(raw.replace(RE_MONEY, ' '));
  if (phone && phone[1].replace(/\D/g, '').length >= 9) out.phone = phone[1].trim();
  return out;
}

/* ------------------------------------------------------------------ sentiment */

// Lexicons are stemmed the same way the message is, so "waiting" matches "wait" and
// "delayed" matches "delay". Without this the stemmer silently defeated the sentiment pass.
const lex = (str) => new Set(str.split(' ').filter(Boolean).map(stem));
const NEG = lex('angry furious annoyed terrible awful bad worst useless broken scam fake rubbish ' +
  'disappointed frustrated unacceptable ridiculous pathetic disgusting hate upset ' +
  'wrong failed failing fail error problem issue complaint complain refund cancel late delayed delay ' +
  'still waiting wait ignore ignored nobody');
const URGENT = lex('urgent urgently asap immediately now emergency quickly hurry today tonight');
const POS = lex('great good nice perfect excellent amazing love happy satisfied wonderful brilliant thanks');

function sentiment(text) {
  const t = tokens(text);
  const raw = String(text || '');
  let neg = 0, pos = 0, urg = 0;
  for (const w of t) {
    if (NEG.has(w)) neg++;
    if (POS.has(w)) pos++;
    if (URGENT.has(w)) urg++;
  }
  const letters = raw.replace(/[^a-z]/gi, '');
  const caps = raw.replace(/[^A-Z]/g, '').length;
  const shouting = letters.length >= 12 && caps / letters.length > 0.6;
  const bangs = (raw.match(/!/g) || []).length;
  const score = neg - pos + (shouting ? 2 : 0) + (bangs >= 3 ? 1 : 0);
  return {
    score,
    negative: score >= 2,
    urgent: urg > 0 || /!!/.test(raw),
    shouting,
    mood: score >= 2 ? 'upset' : score <= -1 ? 'happy' : 'neutral',
  };
}

/* ------------------------------------------------------------------ intents
   Each intent is a bag of weighted cues plus optional phrase patterns. Cues are matched on
   stemmed tokens, so "prices", "pricing" and "price" all land on the same intent. */

const INTENTS = [
  { id: 'greeting', cues: { hi: 3, hello: 3, hey: 3, morning: 2, afternoon: 2, evening: 2, howzit: 3, hallo: 3, yo: 2, mhoro: 3, sawubona: 3 }, patterns: [/^(hi|hello|hey|howzit|yo|hallo|mhoro|sawubona)\b/] },
  { id: 'goodbye', cues: { bye: 3, goodbye: 3, later: 2, cheers: 2, chao: 3, salani: 3, sara: 2 }, patterns: [/^(bye|goodbye|cheers|later)\b/] },
  { id: 'thanks', cues: { thank: 3, thanks: 3, appreciated: 3, grateful: 3, tino: 2, ndatenda: 3 }, patterns: [/\b(thank you|thanks|thx|ty)\b/] },
  { id: 'pricing', cues: { price: 4, pricing: 4, cost: 4, much: 2, charge: 3, fee: 3, rate: 3, quote: 3, expensive: 2, cheap: 2, pay: 1, subscription: 3, plan: 2, package: 2 }, patterns: [/\bhow much\b/, /\bprice(s|d|ing)?\b/, /\bcost(s|ing)?\b/] },
  { id: 'hours', cues: { hour: 4, open: 3, close: 3, closed: 3, opening: 3, time: 2, weekend: 2, sunday: 2, saturday: 2, holiday: 2, available: 1 }, patterns: [/\b(what|which) time\b/, /\bare you open\b/, /\bopening hours\b/, /\bclose(d)? (today|now)\b/] },
  { id: 'location', cues: { where: 3, location: 4, address: 4, situated: 3, based: 3, office: 3, shop: 3, branch: 3, directions: 3, map: 2, city: 2, town: 2 }, patterns: [/\bwhere (are|is|do)\b/, /\byour (address|location|office|shop)\b/] },
  { id: 'contact', cues: { contact: 3, phone: 3, number: 3, call: 3, whatsapp: 2, email: 3, reach: 3, speak: 2, talk: 2, human: 3, agent: 3, person: 2, someone: 2, staff: 2 }, patterns: [/\b(speak|talk) to (a )?(human|person|agent|someone|staff)\b/, /\breal (person|human)\b/] },
  { id: 'payment', cues: { pay: 3, payment: 4, ecocash: 4, paynow: 4, bank: 3, transfer: 3, card: 3, visa: 2, cash: 3, invoice: 2, account: 2, deposit: 3 }, patterns: [/\bhow (do|can) i pay\b/, /\bpayment (method|option)s?\b/, /\becocash|paynow|bank transfer\b/] },
  { id: 'delivery', cues: { deliver: 4, delivery: 4, ship: 3, shipping: 4, courier: 4, post: 2, send: 2, collect: 3, pickup: 4, drop: 2, transport: 3, arrive: 2 }, patterns: [/\bdo you deliver\b/, /\bdelivery (fee|time|cost|option)\b/, /\bhow long.*(deliver|ship)\b/] },
  { id: 'refund', cues: { refund: 5, return: 4, exchange: 4, money: 2, back: 2, warranty: 3, guarantee: 3, broken: 2, faulty: 3 }, patterns: [/\brefund\b/, /\breturn (policy|item|it)\b/, /\bmoney back\b/] },
  { id: 'order_status', cues: { order: 4, status: 3, track: 4, tracking: 4, where: 2, arrived: 3, ready: 2, shipped: 3, invoice: 2, receipt: 2 }, patterns: [/\b(order|tracking) (status|number|no)\b/, /\bwhere is my order\b/, /\btrack my\b/], slot: 'order', ask: 'Sure - what is your order or reference number? I will check it for you.' },
  { id: 'booking', cues: { book: 4, booking: 4, appointment: 4, reserve: 4, schedule: 3, slot: 3, meeting: 3, session: 2, visit: 2 }, patterns: [/\b(book|make) an? appointment\b/, /\bcan i book\b/, /\breserve\b/] },
  { id: 'availability', cues: { available: 3, stock: 4, instock: 4, sell: 2, supply: 3, product: 2, item: 2, size: 2, colour: 2, color: 2 }, patterns: [/\bdo you have\b/, /\bin stock\b/, /\bis .* available\b/] },
  { id: 'catalog', cues: { catalog: 4, catalogue: 4, product: 3, products: 3, service: 3, services: 3, menu: 2, list: 2, offer: 2, sell: 3 }, patterns: [/\bwhat (do|does) you (sell|offer|do)\b/, /\byour (products|services|catalog)\b/] },
  { id: 'support', cues: { help: 3, support: 4, problem: 3, issue: 3, error: 3, working: 2, broken: 3, stuck: 3, fix: 3, assist: 3 }, patterns: [/\bneed help\b/, /\bcan you help\b/, /\bnot working\b/] },
  { id: 'complaint', cues: { complaint: 5, complain: 5, terrible: 3, awful: 3, worst: 4, unacceptable: 4, disgusted: 4, scam: 4, fake: 4, angry: 3, furious: 4, disappointed: 3, rubbish: 4, useless: 4 }, patterns: [/\b(complain|complaint)\b/, /\bthis is (bad|terrible|unacceptable)\b/] },
  { id: 'discount', cues: { discount: 5, cheaper: 3, negotiate: 4, bargain: 4, promo: 4, coupon: 4, deal: 3, bulk: 3, wholesale: 4, reduce: 3 }, patterns: [/\bany (discount|deal|promo)\b/, /\bcan you (reduce|lower)\b/] },
  { id: 'who', cues: { who: 3, company: 3, business: 3, about: 3, name: 2, brand: 3 }, patterns: [/\bwho are you\b/, /\bwhat is this\b/, /\babout (you|your (company|business))\b/] },
  { id: 'capabilities', cues: { able: 2, answer: 2, questions: 2, bot: 3, robot: 3, ai: 3, human: 2 }, patterns: [/\bare you (a )?(bot|robot|ai|human)\b/, /\bwhat can you do\b/] },
  { id: 'affirm', cues: { yes: 3, yeah: 3, yep: 3, sure: 2, correct: 3, right: 2, ok: 2, okay: 2, fine: 2 }, patterns: [/^(yes|yeah|yep|sure|correct|ok|okay|fine|please)\b/] },
  { id: 'deny', cues: { no: 3, nope: 3, never: 2 }, patterns: [/^(no|nope|nah)\b/] },
  { id: 'language', cues: { shona: 4, ndebele: 4, english: 3, translate: 4, language: 4 }, patterns: [/\b(speak|talk) (shona|ndebele|english)\b/] },
];

/* ------------------------------------------------------------------ knowledge base */

function cleanStr(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanMultiline(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_WORDS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** Which weekday the customer is asking about, if they named one. */
function dayAsked(text) {
  for (const w of words(text)) if (DAY_WORDS[w] != null) return DAY_WORDS[w];
  return null;
}

/** Validate/normalise the owner-supplied profile. Never throws on junk: drops it. */
function normalizeProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = {
    name: cleanStr(p.name, 60),
    about: cleanMultiline(p.about, 400),
    tone: ['friendly', 'professional', 'concise'].includes(p.tone) ? p.tone : 'friendly',
    currency: cleanStr(p.currency, 8) || 'USD',
    location: cleanStr(p.location, 120),
    phone: cleanStr(p.phone, 40),
    email: cleanStr(p.email, 80),
    website: cleanStr(p.website, 120),
    payments: cleanMultiline(p.payments, 300),
    delivery: cleanMultiline(p.delivery, 300),
    refunds: cleanMultiline(p.refunds, 300),
    escalateTo: cleanStr(p.escalateTo, 40),
    hours: null,
    prices: [],
    faqs: [],
  };

  const h = p.hours;
  if (h && typeof h === 'object') {
    const days = Array.isArray(h.days) ? h.days.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
    const open = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(h.open || '')) ? String(h.open) : '08:00';
    const close = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(h.close || '')) ? String(h.close) : '17:00';
    out.hours = { days: [...new Set(days)].sort(), open, close, tzOffsetMin: Math.max(-840, Math.min(840, Math.round(Number(h.tzOffsetMin) || 0))) };
  }

  if (Array.isArray(p.prices)) {
    for (const row of p.prices.slice(0, MAX_PRICES)) {
      if (!row || typeof row !== 'object') continue;
      const item = cleanStr(row.item, 60);
      const amount = cleanStr(row.amount, 20);
      if (!item || !amount) continue;
      out.prices.push({ item, amount, note: cleanStr(row.note, 60) });
    }
  }

  if (Array.isArray(p.faqs)) {
    for (const row of p.faqs.slice(0, MAX_FAQS)) {
      if (!row || typeof row !== 'object') continue;
      const q = cleanStr(row.q, 140);
      const a = cleanMultiline(row.a, 600);
      if (!q || !a) continue;
      out.faqs.push({ id: cleanStr(row.id, 24) || 'f' + out.faqs.length, q, a, keys: cleanStr(row.keys, 120) });
    }
  }
  return out;
}

/** True when the profile has enough to be useful. */
function ready(profile) {
  const p = profile || {};
  return !!(p.name || p.about || (p.faqs && p.faqs.length) || (p.prices && p.prices.length) || p.hours || p.location);
}

/* ------------------------------------------------------------------ retrieval (BM25-lite) */

function buildIndex(profile) {
  const docs = [];
  for (const f of profile.faqs || []) {
    docs.push({ kind: 'faq', id: f.id, text: f.q + ' ' + f.keys + ' ' + f.a, toks: tokens(f.q + ' ' + f.keys), ref: f });
  }
  const facts = [
    ['about', profile.about],
    ['location', profile.location],
    ['payments', profile.payments],
    ['delivery', profile.delivery],
    ['refunds', profile.refunds],
    ['prices', (profile.prices || []).map((r) => r.item + ' ' + r.amount + ' ' + r.note).join(' ')],
  ];
  for (const pair of facts) {
    const kind = pair[0], text = pair[1];
    if (!text) continue;
    docs.push({ kind, text: String(text), toks: tokens(text), ref: null });
  }
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  return { docs, df, n: docs.length || 1 };
}

function retrieve(index, query) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !index.docs.length) return { best: null, score: 0, coverage: 0, ranked: [] };
  const ranked = [];
  for (const d of index.docs) {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0, matched = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      matched++;
      const df = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      score += (f / (f + 1.2)) * idf;
    }
    score = score / Math.sqrt(q.length); // long questions must not win by accident
    // Divide by at least two so a one-word question cannot look like a perfect match.
    if (score > 0) ranked.push({ doc: d, score, coverage: matched / Math.max(q.length, 2) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0] || null;
  return { best: top ? top.doc : null, score: top ? top.score : 0, coverage: top ? top.coverage : 0, ranked: ranked.slice(0, 3) };
}

/* ------------------------------------------------------------------ time */

function localNow(tzOffsetMin, now) {
  const t = new Date((now || Date.now()) + (Number(tzOffsetMin) || 0) * 60_000);
  return { day: t.getUTCDay(), hhmm: String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0') };
}

function hoursState(hours, now) {
  if (!hours) return null;
  const local = localNow(hours.tzOffsetMin, now);
  const day = local.day, hhmm = local.hhmm;
  const openDay = hours.days.includes(day);
  const inWindow = openDay && hhmm >= hours.open && hhmm < hours.close;
  let nextDay = null;
  if (!inWindow) {
    for (let i = 0; i < 7; i++) {
      const d = (day + i) % 7;
      if (!hours.days.includes(d)) continue;
      if (i === 0 && hhmm >= hours.close) continue;
      nextDay = d; break;
    }
  }
  return { open: inWindow, day, hhmm, nextDay, today: DAY_NAMES[day] };
}

/* ------------------------------------------------------------------ phrasing */

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h); }
function choose(list, seed) { return list[hash(String(seed || '')) % list.length]; }

function money(profile, amount) {
  const cur = profile.currency || 'USD';
  const a = String(amount || '').trim();
  if (/^[a-z]{2,4}\s?\d/i.test(a) || /[$£€]/.test(a)) return a;
  return cur + ' ' + a;
}

function priceList(profile) {
  const rows = (profile.prices || []).slice(0, 12);
  if (!rows.length) return '';
  return rows.map((r) => '\u2022 ' + r.item + ' \u2014 ' + money(profile, r.amount) + (r.note ? ' (' + r.note + ')' : '')).join('\n');
}

/* ------------------------------------------------------------------ the engine */

function newSession(now) { return { turns: 0, slots: {}, asked: [], lastIntent: null, streak: 0, at: now || Date.now() }; }

function fresh(session, now) {
  return !!(session && (now || Date.now()) - session.at < SESSION_TTL_MS);
}

/**
 * Think about one incoming message.
 *
 * @param {object} profile  business profile (normalizeProfile output, or raw - it is normalised here)
 * @param {string} text     the incoming message
 * @param {object} session  previous session for this chat, or null
 * @param {object} opts     { now, jid, history, isGroup }
 * @returns {{reply:string, intent:string, confidence:number, action:string,
 *            session:object, escalate:boolean, gap:object|null, trace:Array, mood:string}}
 */
function think(profile, text, session, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const p = profile && profile.faqs ? profile : normalizeProfile(profile);
  const body = String(text == null ? '' : text).trim().slice(0, 1000);
  const trace = [];
  const prev = fresh(session, now) ? session : newSession(now);
  const s = {
    turns: (prev.turns || 0) + 1,
    slots: Object.assign({}, prev.slots),
    asked: (prev.asked || []).slice(-6),
    lastIntent: prev.lastIntent || null,
    streak: prev.streak || 0,
    pending: prev.pending || null,
    at: now,
  };
  const seed = (o.jid || '') + '|' + s.turns + '|' + body.length;

  const done = (reply, intent, confidence, action, extra) => {
    const x = extra || {};
    const out = {
      reply: String(reply || '').slice(0, MAX_REPLY),
      intent: intent || 'unknown',
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      action: action || 'answer',
      session: s,
      escalate: !!x.escalate,
      gap: x.gap || null,
      mood: x.mood || 'neutral',
      trace,
    };
    s.lastIntent = out.intent;
    s.at = now;
    return out;
  };

  if (!body) return done('', 'empty', 0, 'ignore');

  /* 1. understand ------------------------------------------------------- */
  const t = tokens(body);
  const w = words(body); // cue matching keeps stop-words: "hi", "where are you" are all cues
  const e = entities(body);
  const mood = sentiment(body);
  trace.push({ step: 'understand', tokens: t.length, entities: Object.keys(e), mood: mood.mood, urgent: mood.urgent });

  const scored = [];
  for (const intent of INTENTS) {
    let score = 0;
    const hits = [];
    for (const word of w) if (intent.cues[word] != null) { score += intent.cues[word]; hits.push(word); }
    if (intent.patterns) for (const re of intent.patterns) if (re.test(norm(body))) { score += 4; hits.push('phrase'); }
    if (score > 0) scored.push({ id: intent.id, score, hits, intent });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0] || null;
  const second = scored[1] || null;
  trace.push({ step: 'intent', top: top ? top.id : null, score: top ? top.score : 0, runnerUp: second ? second.id : null });

  /* 2. retrieve --------------------------------------------------------- */
  const index = buildIndex(p);
  const hit = retrieve(index, body);
  trace.push({ step: 'retrieve', best: hit.best ? hit.best.kind + (hit.best.ref ? ':' + hit.best.ref.id : '') : null, score: Number(hit.score.toFixed(3)), coverage: Number(hit.coverage.toFixed(2)) });

  const hs = hoursState(p.hours, now);
  const openNow = hs ? hs.open : null;
  const askedDay = dayAsked(body);

  /* 3. hard rules first: safety, escalation, hand-off ------------------- */
  const wantsHuman = /\b(human|real person|agent|someone|manager|staff)\b/.test(norm(body)) && top && (top.id === 'contact' || top.id === 'complaint');
  if (wantsHuman || mood.negative || (top && top.id === 'complaint')) {
    trace.push({ step: 'policy', rule: wantsHuman ? 'asked-for-human' : 'upset-customer', action: 'escalate' });
    const who = p.escalateTo ? ' I am passing this to ' + p.escalateTo + ' now.' : ' I am passing this to the team now.';
    const lead = mood.negative ? 'I am sorry about that - that is not the experience we want you to have.' : 'Of course.';
    const contact = p.phone ? ' You can also call us on ' + p.phone + '.' : '';
    return done(lead + who + contact + ' Someone will reply here shortly.', top ? top.id : 'complaint', 0.9, 'escalate', { escalate: true, mood: mood.mood });
  }

  /* 4. slot filling: keep a pending question across turns -------------- */
  if (s.pending && s.pending.slot) {
    const val = e[s.pending.slot] || (/^[A-Za-z0-9-]{3,20}$/.test(body) ? body.replace(/\s+/g, '').toUpperCase() : null);
    if (val) {
      s.slots[s.pending.slot] = val;
      trace.push({ step: 'slot', filled: s.pending.slot, value: val });
      const intent = INTENTS.find((i) => i.id === s.pending.intent);
      const answer = answerFor(intent, p, { entities: Object.assign({}, e, s.slots), mood, openNow, hs, seed, body, slots: s.slots });
      s.pending = null;
      if (answer) return done(answer.text, intent.id, 0.85, 'answer', { escalate: !!answer.escalate, mood: mood.mood });
      return done('Thanks - I have noted ' + val + '. A team member will confirm the details shortly.', intent ? intent.id : 'order_status', 0.7, 'answer', { escalate: true, mood: mood.mood });
    }
    trace.push({ step: 'slot', missing: s.pending.slot });
    return done(s.pending.ask, s.pending.intent, 0.5, 'slot', { mood: mood.mood });
  }

  /* 5. weigh the two evidence sources ----------------------------------
     An intent answer and a knowledge-base hit can both exist ("do you have a free trial" is
     both an availability question and an exact FAQ). Rather than let one silently win, score
     both and keep the more confident answer - that is the whole point of a reasoning step. */
  const ctx = { entities: e, mood, openNow, hs, seed, body, slots: s.slots, profile: p, askedDay };
  let intentAnswer = null;
  if (top && top.score >= 4) {
    const intent = top.intent;
    if (intent.slot && !e[intent.slot] && !s.slots[intent.slot]) {
      s.pending = { slot: intent.slot, intent: intent.id, ask: intent.ask, at: now };
      trace.push({ step: 'policy', rule: 'missing-slot', slot: intent.slot, action: 'ask' });
      return done(intent.ask, intent.id, 0.6, 'slot', { mood: mood.mood });
    }
    const answer = answerFor(intent, p, ctx);
    if (answer) intentAnswer = { text: answer.text, intent: intent.id, confidence: answer.confidence, escalate: !!answer.escalate };
  }

  let kbAnswer = null;
  // A hit needs both a real term overlap and a decent share of the question, otherwise a
  // single shared word ("do you deliver" vs "we deliver in Harare") would hijack the answer.
  if (hit.best && hit.coverage >= 0.5 && hit.score >= 0.15) {
    const d = hit.best;
    kbAnswer = {
      text: d.kind === 'faq' ? d.ref.a : String(d.text),
      intent: d.kind === 'faq' ? 'faq' : 'fact:' + d.kind,
      confidence: Math.min(0.95, 0.45 + 0.4 * hit.coverage + Math.min(0.15, hit.score / 3)),
      escalate: false,
    };
  }

  if (intentAnswer && kbAnswer) {
    const pickKb = kbAnswer.confidence > intentAnswer.confidence;
    trace.push({ step: 'policy', rule: 'weigh', intent: Number(intentAnswer.confidence.toFixed(2)), kb: Number(kbAnswer.confidence.toFixed(2)), chose: pickKb ? 'kb' : 'intent', action: 'answer' });
    const win = pickKb ? kbAnswer : intentAnswer;
    return done(win.text, win.intent, win.confidence, 'answer', { escalate: win.escalate, mood: mood.mood });
  }
  if (intentAnswer) {
    trace.push({ step: 'policy', rule: 'intent-answer', action: intentAnswer.escalate ? 'answer+escalate' : 'answer' });
    return done(intentAnswer.text, intentAnswer.intent, intentAnswer.confidence, 'answer', { escalate: intentAnswer.escalate, mood: mood.mood });
  }
  if (kbAnswer) {
    trace.push({ step: 'policy', rule: 'kb-hit', action: 'answer' });
    return done(kbAnswer.text, kbAnswer.intent, kbAnswer.confidence, 'answer', { mood: mood.mood });
  }

  /* 6. clarify when the message is genuinely ambiguous ------------------
     Two readings that are within one point of each other are not worth guessing between:
     asking a short question is cheaper than logging a gap or answering the wrong thing. */
  if (top && second && top.score >= 3 && top.score - second.score <= 1) {
    trace.push({ step: 'policy', rule: 'ambiguous', options: [top.intent.id, second.intent.id], action: 'clarify' });
    return done('I want to get this right - are you asking about ' + label(top.intent.id) + ', or about ' + label(second.intent.id) + '?', top.intent.id, 0.4, 'clarify', { mood: mood.mood });
  }

  /* 7. recognised, but the profile has no facts for it ------------------ */
  if (top && top.score >= 4) {
    trace.push({ step: 'policy', rule: 'intent-without-facts', action: 'gap' });
    return done(unknownReply(p, seed, top.intent), top.intent.id, 0.35, 'gap', {
      gap: { question: body, intent: top.intent.id, reason: 'profile-missing-' + top.intent.id },
      mood: mood.mood,
    });
  }

  /* 8. honest fallback, and record the gap ------------------------------ */
  s.streak = (prev.lastIntent === 'unknown' ? prev.streak : 0) + 1;
  trace.push({ step: 'policy', rule: 'no-match', streak: s.streak, action: 'gap' });
  const escalate = s.streak >= 2;
  return done(unknownReply(p, seed, null) + (escalate ? '\n\nI have flagged this for a human so you are not left waiting.' : ''),
    'unknown', 0.2, 'gap', { escalate, gap: { question: body, intent: 'unknown', reason: 'no-match' }, mood: mood.mood });
}

function label(id) {
  return ({
    pricing: 'pricing', hours: 'opening hours', location: 'where we are', contact: 'contacting us',
    payment: 'payment methods', delivery: 'delivery', refund: 'refunds and returns',
    order_status: 'an order', booking: 'booking', availability: 'stock', catalog: 'what we offer',
    support: 'a problem', discount: 'a discount',
  })[id] || id;
}

/** Compose the answer for a recognised intent, or null when the profile cannot support it. */
function answerFor(intent, p, ctx) {
  if (!intent) return null;
  const e = ctx.entities || {};
  const seed = ctx.seed;
  const name = p.name || 'us';
  switch (intent.id) {
    case 'greeting': {
      const hour = ctx.hs ? Number(ctx.hs.hhmm.slice(0, 2)) : new Date().getHours();
      const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      const open = ctx.openNow === true ? ' We are open right now.' : ctx.openNow === false ? ' We are closed at the moment, but I can still help.' : '';
      return { text: choose([part + '! Welcome to ' + name + '.' + open + ' How can I help?', 'Hi there! You have reached ' + name + '.' + open + ' What can I do for you?'], seed), confidence: 0.9 };
    }
    case 'goodbye':
      return { text: choose(['Thank you for reaching out to ' + name + '. Have a great day!', 'Goodbye - we are here whenever you need us.'], seed), confidence: 0.9 };
    case 'thanks':
      return { text: choose(['You are very welcome!', 'Any time - glad I could help.'], seed), confidence: 0.9 };
    case 'pricing': {
      const list = priceList(p);
      if (list) return { text: 'Here is what we charge:\n' + list + (p.payments ? '\n\n' + p.payments : ''), confidence: 0.9 };
      if (e.amount) return { text: 'Thanks - I have noted ' + money(p, e.amount) + '. A team member will confirm the exact total for you.', confidence: 0.6, escalate: true };
      return null;
    }
    case 'hours': {
      if (!p.hours) return null;
      const hs = ctx.hs;
      const days = p.hours.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ');
      const window2 = p.hours.open + '-' + p.hours.close;
      // A named day ("are you open on Saturday?") must be answered for that day, not for today.
      if (ctx.askedDay != null) {
        const name = DAY_NAMES[ctx.askedDay];
        const today = hs.day === ctx.askedDay;
        if (!p.hours.days.includes(ctx.askedDay)) {
          return { text: 'We are closed on ' + name + 's. Our hours are ' + window2 + ' (' + days + ').', confidence: 0.95 };
        }
        if (today && !hs.open) {
          return { text: 'We are closed right now, but yes - we are open today (' + name + ') ' + window2 + '.', confidence: 0.95 };
        }
        return { text: 'Yes - we are open on ' + name + (today ? ' (today)' : '') + ', ' + window2 + '.', confidence: 0.95 };
      }
      if (hs.open) return { text: 'We are open now, until ' + p.hours.close + '. Our hours are ' + window2 + ' (' + days + ').', confidence: 0.95 };
      const next = hs.nextDay != null ? DAY_NAMES[hs.nextDay] : null;
      return { text: 'We are closed right now. Our hours are ' + p.hours.open + '-' + p.hours.close + ' (' + days + ')' + (next ? ' - we open again on ' + next + ' at ' + p.hours.open + '.' : '.'), confidence: 0.95 };
    }
    case 'location':
      return p.location ? { text: 'You can find us at ' + p.location + (p.website ? '. Directions and more: ' + p.website : '.'), confidence: 0.9 } : null;
    case 'contact': {
      const bits = [];
      if (p.phone) bits.push('call or WhatsApp ' + p.phone);
      if (p.email) bits.push('email ' + p.email);
      if (p.website) bits.push('visit ' + p.website);
      if (!bits.length) return null;
      return { text: 'You can reach ' + name + ' by ' + bits.join(', ') + '.', confidence: 0.9 };
    }
    case 'payment':
      return p.payments ? { text: p.payments, confidence: 0.9 } : null;
    case 'delivery':
      return p.delivery ? { text: p.delivery, confidence: 0.9 } : null;
    case 'refund':
      return p.refunds ? { text: p.refunds, confidence: 0.9 } : null;
    case 'order_status': {
      const ref = e.order || ctx.slots.order;
      if (!ref) return null;
      return { text: 'Thanks - I have your reference ' + ref + '. I am checking it now and will come back to you here shortly.', confidence: 0.8, escalate: true };
    }
    case 'booking': {
      const when = e.date || e.time;
      return { text: 'I can help with that' + (when ? ' for ' + when : '') + '. Please send your name and the best number to reach you, and the team will confirm the slot.', confidence: 0.7, escalate: true };
    }
    case 'availability': {
      const q = (p.faqs || []).find((f) => /stock|available|size|colour|color/i.test(f.q + ' ' + f.keys));
      if (q) return { text: q.a, confidence: 0.8 };
      return { text: 'Let me check that for you - which item are you asking about?', confidence: 0.5 };
    }
    case 'catalog': {
      const list = priceList(p);
      if (list) return { text: 'Here is what we offer:\n' + list, confidence: 0.9 };
      if (p.about) return { text: p.about, confidence: 0.8 };
      return null;
    }
    case 'support':
      return { text: 'I am sorry you are having trouble. Tell me what happened and I will either fix it or bring in a human straight away.', confidence: 0.6 };
    case 'discount':
      return p.prices && p.prices.length
        ? { text: 'Our listed prices are already our best rates, but send me the quantity you have in mind and the team will see what they can do.', confidence: 0.6, escalate: true }
        : null;
    case 'who':
      return p.about ? { text: p.about, confidence: 0.9 } : p.name ? { text: 'This is ' + p.name + '\'s WhatsApp line. How can I help?', confidence: 0.7 } : null;
    case 'capabilities':
      return { text: 'I am ' + (p.name ? p.name + '\'s' : 'the') + ' assistant. I can answer questions about pricing, hours, delivery, payments and anything the team has written down. If I do not know, I will say so and bring in a human.', confidence: 0.85 };
    case 'affirm':
      return { text: 'Great - what would you like to do next?', confidence: 0.5 };
    case 'deny':
      return { text: 'No problem. Is there anything else I can help with?', confidence: 0.5 };
    case 'language':
      return { text: 'I can reply in English, and the team can help in Shona and Ndebele as well.', confidence: 0.7 };
    default:
      return null;
  }
}

function unknownReply(p, seed, intent) {
  const who = p.escalateTo || 'the team';
  const lead = intent
    ? 'I do not have that detail to hand, and I would rather not guess.'
    : choose(['I am not sure I understood that one.', 'I want to make sure I answer the right question.'], seed);
  return lead + ' I have passed it to ' + who + ', who will reply here shortly.';
}

/* ------------------------------------------------------------------ preview helper */

/** Console "try it" box: run a message through the engine with a throwaway session. */
function preview(profile, text, opts) {
  return think(profile, text, null, opts || {});
}

module.exports = {
  MAX_FAQS, MAX_PRICES, MAX_REPLY, SESSION_TTL_MS, MAX_SESSIONS,
  normalizeProfile, ready, think, preview, fresh, newSession,
  norm, tokens, words, stem, entities, sentiment, retrieve, buildIndex, hoursState, INTENTS,
};
