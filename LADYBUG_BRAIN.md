# 🧠 Ladybug Brain — the built-in auto-responder

Ladybug Brain is the answer to a simple question: *what does the bot do when the owner has not set up a single keyword, flow or API key?*

Before this feature the answer was "nothing". The bot stayed silent unless the owner had already written rules, built a flow, or connected a paid AI provider. Most owners never get that far, so most bots sat idle while customers asked the same handful of questions over and over.

Ladybug Brain fills that gap. It is a small reasoning engine that runs **inside the bot process**, needs **no key, no account and no internet**, and answers customers from the owner's own business profile. It is on the moment the owner fills in the panel, and it hands anything it cannot answer to a human instead of inventing an answer.

---

## Why it is not a language model

Every other "AI auto-reply" on the market is a language model behind an API key. That model will happily invent a price, a delivery time, a refund window or a promise the business never made. For a shop answering a customer, a confident wrong answer is worse than no answer at all: it creates a dispute, and the owner never even knows it happened.

Ladybug Brain is deliberately **not** a model. It is a deterministic engine built from four honest parts:

1. **Understanding** — what is this person asking, and how do they feel about it?
2. **Retrieval** — has the owner written down an answer to this?
3. **Reasoning** — when two sources disagree or are equally likely, which one wins?
4. **Decision** — answer, ask a clarifying question, or hand off to a human.

Every reply is traceable. The console's "Try it" box shows the exact chain that produced it, so the owner can see *why* the bot said what it said. Nothing is generated from thin air; every sentence either comes from the owner's profile or is a fixed, safe phrase.

---

## The pipeline

```
message
   │
   ├─ understand ── tokens · entities · sentiment · urgency
   │
   ├─ classify ─── 22 intents, weighted cues + phrase patterns
   │
   ├─ retrieve ─── BM25-lite over the owner's FAQs and facts
   │
   ├─ reason ───── hard rules → slots → weigh intent vs knowledge base
   │
   └─ decide ───── answer · clarify · escalate · record a gap
```

### 1. Understanding

Text is lowercased, de-accented, contractions are expanded (`what's` → `what is`), punctuation is stripped and words are stemmed with a small English stemmer (`prices` → `price`, `deliveries` → `delivery`, `boxes` → `box`). Two views of the message are kept: `tokens()` drops stop-words for retrieval, while `words()` keeps them because cues like *hi*, *where* and *are* are exactly the words that matter for classification.

Entities are pulled out with tight regular expressions: email, URL, money (`$1,250.50`, `300 usd`), phone (nine digits minimum), order reference (`order number is AB-1234`), time (`3pm`, `14:30`) and date (`tomorrow`, `next week`, `Monday`).

Sentiment is a small lexicon plus two structural signals: **shouting** (more than 60% capitals across at least twelve letters) and **urgency** (`asap`, `urgent`, `now`, `!!`). Two negative words, or one negative plus shouting, tips the mood to `upset`, which changes the entire policy — see escalation below.

### 2. Intent classification

Twenty-two intents cover the questions a small business actually receives: greeting, goodbye, thanks, pricing, hours, location, contact, payment, delivery, refund, order status, booking, availability, catalog, support, complaint, discount, identity, capabilities, affirm, deny and language.

Each intent is a bag of **weighted cues** plus optional **phrase patterns**. A phrase pattern is worth four points, which is enough to beat a pile of weak single-word cues. `order_status` additionally declares a slot: if the customer asks "where is my order" without a reference number, the bot asks for one and remembers the question across turns.

The runner-up score is kept, because a near-tie is information: if the top two intents are within one point of each other, the bot asks which one the customer meant instead of guessing.

### 3. Retrieval

The owner's FAQs, about line, location, payment, delivery and refund notes, and the price list are indexed together. Scoring is BM25-lite: inverse document frequency, term-frequency saturation at `tf / (tf + 1.2)`, normalised by the square root of the query length so a long rambling message cannot win by accident.

Raw BM25 scores shrink as the corpus shrinks, so a one-FAQ profile could never reach a fixed cutoff. The decision therefore uses **term coverage** as well as the score: at least half of the question's terms must match, and the coverage divisor is never below two, so a single shared word cannot masquerade as a perfect hit.

### 4. Reasoning

This is where the engine earns the word "reasoning". The order of the rules is the design:

**Hard rules first.** If the customer asks for a human, or the message is angry, or the intent is a complaint, the bot stops trying to be clever. It apologises, names the person the owner nominated (`escalateTo`), offers the phone number if there is one, and says a human will reply here shortly. No FAQ is worth arguing with an upset customer.

**Slots second.** If a question is pending from the previous turn, the reply is treated as the missing slot value. A reference number is accepted either as a recognised entity or as a short alphanumeric token. If the reply is unusable, the bot re-asks rather than dropping the thread.

**Then the weigh step.** An intent answer and a knowledge-base hit can both exist. "Do you have a free trial?" is both an availability question and an exact FAQ. Rather than letting one silently win, the engine scores both and keeps the more confident answer, recording both confidences in the trace. This is the step that makes the bot feel considered rather than mechanical.

**Then honesty.** If the intent is recognised but the profile has no facts for it, the bot says so plainly — *"I do not have that detail to hand, and I would rather not guess"* — and records a **gap**. If the message is genuinely ambiguous, it asks a clarifying question. If nothing matches at all, it falls back to the same honest line, and on the second consecutive miss it adds that a human has been flagged.

### 5. Decision

Every call returns a reply, an intent, a confidence score, an action (`answer`, `clarify`, `slot`, `escalate`, `gap`, `ignore`), the updated session, a mood, an optional gap, and the trace.

---

## The business profile

The panel is organised the way an owner thinks about their business, not the way a database is structured.

| Section | What it feeds |
| --- | --- |
| **Your business** | name, about line, tone, currency |
| **Contact & location** | location, phone, email, website |
| **Opening hours** | days, open/close times, timezone offset |
| **How you work** | payments, delivery, refunds |
| **Prices** | up to 40 item / amount / note rows |
| **Questions & answers** | up to 60 FAQ rows, each with optional match keywords |
| **Hand-off** | who to escalate to, after how many misses, cooldown and hourly cap |

Opening hours are **time-aware**. The bot converts the current time into the owner's timezone and answers "we are open now, until 17:00" or "we are closed right now — we open again on Monday at 08:00". It knows the next open day, not just today's.

Every field is cleaned and capped on the way in: control characters and angle brackets are stripped, lengths are clamped, incomplete price and FAQ rows are dropped, invalid times fall back to 08:00–17:00, and a wild timezone is clamped to ±14 hours. Normalising junk never throws.

---

## Escalation and the gap log

Two things make the bot safe to leave running unattended.

**Escalation** is a policy, not a fallback. Complaints, anger and explicit requests for a human all route to the person named in the hand-off section, with the phone number appended when the owner has one. The reply is warm and specific, never a generic "please wait".

**The gap log** closes the loop. Whenever the bot cannot answer, it emits a `brain-gap` event over the existing bot→platform IPC channel. The platform persists it with `wa-book.addGap`, deduplicating case-insensitively and counting repeats, capped at 120 entries. The panel lists the gaps newest-first, and each one has a **Turn into a FAQ** button that pre-fills the question so the owner can paste an answer. That is the whole improvement loop: the bot gets smarter because the owner is told exactly what it did not know.

---

## Safety, limits and rate control

- **No key, no network.** The engine is dependency-free and makes no outbound calls. Nothing the customer types leaves the owner's server.
- **No invented facts.** Prices, hours, delivery and refund answers come from the profile verbatim. When the profile is silent, the bot says so.
- **Rate control per chat.** `maxPerHour` (default 15) caps replies in a rolling hour, and `cooldownSec` (default 30) spaces them out, so a spammer cannot turn the bot into a free chatbot.
- **Session hygiene.** Sessions expire after 30 minutes and the map is swept when it exceeds 800 chats, so a busy bot cannot leak memory.
- **Bounded input and output.** Incoming text is trimmed to 1,000 characters, replies to 900, the profile to 60 FAQs and 40 prices.
- **Groups are excluded.** The brain only answers one-to-one chats; it never interrupts a group conversation.
- **Opt-in, and refused when empty.** Turning the brain on without a name, an about line, opening hours or at least one FAQ is rejected with a clear message, because an empty brain would only produce hand-offs.

---

## Console panel

The 🧠 tile in the WhatsApp console (and the `brain` deep link) opens the panel:

- a master switch, saved with the rest of the automation settings;
- the full profile editor described above;
- a **Try it** box that runs a message through the engine with a throwaway session and shows the reply bubble, the intent, the confidence percentage, the action and the mood, plus a collapsible reasoning trace;
- the **What the bot could not answer** list, with per-gap *Turn into a FAQ* and a *Clear* action.

Settings live in `db.data.waBook[botId].auto.brain`, so they inherit the existing persistence, MongoDB sync, the `autoSet` push to the bot and the `LADYBUG_AUTO` boot seed for free.

---

## Files

| File | Role |
| --- | --- |
| `lib/bot-shims/ladybug-brain.js` | the engine (pure, dependency-free) |
| `lib/bot-shims/webBridge.js` | `maybeBrain()` runtime, `brain-gap` IPC, `autoGet` |
| `lib/wa-book.js` | `cleanBrain`, `addGap`, `gapsView`, `clearGaps` |
| `lib/bots.js` | persists `brain-gap` events |
| `lib/installer.js` | ships the engine next to the bridge |
| `lib/webconsole.js` | `brain`, `brainTest`, `brainGapsClear` handlers |
| `app.js` | `GET /api/bots/:id/web/brain`, `POST …/brain/test`, `POST …/brain/gaps/clear` |
| `public/js/wa-brain.js` | the console panel |
| `test/ladybug-brain.test.js` | 150 assertions over the engine and the gap log |

---

## Tests

```
node test/ladybug-brain.test.js
```

The suite covers text normalisation and stemming, entity extraction, sentiment including shouting and urgency, profile normalisation and caps, opening-hours state across open/closed/next-day/timezone, retrieval ranking and the tiny-corpus case, every intent, the weigh step, escalation for anger / human requests / complaints, slot filling across turns, gap emission and the second-miss escalation, ambiguity clarification, session TTL, `preview`, and the `wa-book` settings and gap log including the "brain on without a profile" rejection.

It runs with a throwaway `DATA_DIR` and touches no network and no real bot.
