# Two site-wide features — and the PWA fix

This change adds two features that work on **every page** of Ladybug Cloud, not just the
WhatsApp console, and fixes the bug where the installed app did not show all features.

---

## 1. Activity Timeline

**What it is.** One feed that answers "what happened on my account?" — bot lifecycle, billing,
storage, security and account changes — instead of making you open five different pages.

**Where it lives.**

| Piece | File |
| --- | --- |
| Storage + querying + CSV | `lib/activity.js` |
| API | `app.js` — `/api/activity`, `/api/activity/seen`, `/api/activity/clear`, `/api/activity/export.csv` |
| UI | `public/js/activity.js` (`window.LBACT`) |
| Route | `#/activity` |
| Styles | `.act-*` in `public/css/style.css` |

**How it works.**

- Entries live in `db.data.activity[userId]`, so the feed follows the account across browsers
  and, with `MONGODB_URI` set, across redeploys. Capped at 400 entries per user — this is a
  convenience feed, not a compliance archive.
- `activity.log(userId, { type, title, detail, meta, botId })` is called at the places that
  already change account state: sign-up, sign-in, password change, crash-alert webhook save,
  payment submitted / approved / rejected, and every bot lifecycle event.
- Bot events need no changes in `lib/bots.js`: `activity.ensureAttached()` subscribes to the
  existing event bus (`events.bus.on('bot', …)`) that already feeds webhooks, and mirrors each
  event into the owner's timeline with a human title ("Bot crashed", "Bot connected to
  WhatsApp", …).
- Everything is scoped to `req.user.id`, so one account can never read another's feed.
- Titles and details are truncated (140 / 300 chars) and stripped of `<`, `>` and control
  characters before storage, so the feed is safe to render and cannot be used to smuggle HTML.
- Timestamps are **strictly increasing per feed**. They double as the pagination cursor, and
  two events in the same millisecond would otherwise make "load older" skip a row.

**In the UI.**

- A 🔔 bell in the nav bar shows the unread count and links to `#/activity`.
- The page shows totals (entries / unread / showing), category chips (Everything, Bots,
  Billing, Storage, Security, Account), a search box, day headings, per-entry category tags and
  metadata, and a "Load older" button that pages with an opaque cursor.
- Filters and the search term are written into the URL (`#/activity?type=billing&q=coins`), so
  a filtered view can be bookmarked or shared with yourself.
- "Mark all read" clears the bell; "Export CSV" downloads the current filter as RFC-4180 CSV
  with proper quoting of commas and quotes.

---

## 2. Command Palette (Ctrl / ⌘ + K)

**What it is.** A jump box over any page: type a few letters and go straight to a page, an
action, a bot, a file in your drive, or a past activity entry.

**Where it lives.**

| Piece | File |
| --- | --- |
| Search backend | `lib/site-search.js` |
| API | `app.js` — `/api/search?q=` (rate limited to 120/min) |
| UI | `public/js/palette.js` (`window.LBPAL`) |
| Styles | `.pal-*` in `public/css/style.css` |

**How it works.**

- `Ctrl+K` (or `⌘K`) toggles the overlay from anywhere; `/` also opens it when you are not
  already typing in a field. `Esc` closes, `↑`/`↓` move, `Enter` opens the highlighted result.
- The first results are instant and local: every page in the app plus five actions — claim
  daily coins, upload a file, create a bot, mark activity as read, log out.
- Typing two or more characters also asks `/api/search`, which merges in bots, drive files and
  activity entries. Results are grouped (Go to / Actions / Bots / Drive / Activity) and each
  row shows what it is.
- Relevance is a small, explicit score: exact match 100, prefix 80, word-prefix 60, substring
  30. Bots and files are matched on name and id; activity is matched on title, detail and meta.
- Search is scoped to the signed-in user. The drive walk is capped (400 entries, depth 6) so a
  huge drive cannot stall a keystroke, and dotfiles are skipped.
- Keystrokes are debounced (180 ms) and every response carries a sequence number, so a slow
  reply for an older query can never overwrite the results for what you are typing now.
- A 🔍 button in the nav bar opens the same palette for people who prefer clicking.

---

## 3. The installed app now shows every feature

**The bug.** Installing the app (PWA) gave you a version with missing features. Two causes:

1. `public/sw.js` precached a **stale list** of modules. `wa-groups.js`, `wa-undo.js`,
   `wa-radar.js`, `wa-pro.js`, and the three newest modules (`wa-digest.js`, `wa-crm.js`,
   `wa-translate.js`) were never precached.
2. The install step used `cache.addAll(SHELL)`, which is **all-or-nothing**: a single missing or
   renamed file rejected the whole promise, so the service worker never finished installing and
   the app fell back to a partial, network-dependent cache.

**The fix.**

- The shell list now includes **every** module in `public/js` (and the two new ones), plus the
  icons and manifest. `VERSION` is bumped to `ladybug-v7` so existing installs discard the old,
  incomplete cache on activate.
- Precaching is **per URL** (`cache.add` in a `Promise.all` with a `.catch` per entry). One bad
  URL now logs a warning instead of breaking the install; the runtime handler fills the gap on
  first use.
- `manifest.webmanifest` no longer locks `"orientation": "portrait"`. It is now `"any"`, with
  `display_override` for window-controls-overlay on desktop, so the wide WhatsApp console is
  usable in the installed window.
- `public/js/pwa.js` now offers an **update prompt**: when a new worker is installed it shows a
  "Reload" toast, and it checks for a new build whenever the app regains focus (installed apps
  rarely reload on their own). After the new worker takes control the page reloads once, so
  every module comes from the new cache.
- The floating "Install app" button is hidden when the app is already running standalone, and
  the install/update prompts are styled with the rest of the site instead of inline CSS.

---

## 4. Plans, usage meters & invoices

Billing used to be coins-or-subscription. It is now a four-plan ladder — **Free**, **Starter**
($3), **Pro** ($8) and **Studio** ($20) — layered on top so every existing check keeps working:
`plans.grantPlan()` writes `planKey`/`planUntil` and mirrors `subscriptionUntil` and `botLimit`,
which is exactly what `billing.runsFree()`, `billing.botLimitFor()` and `createBotFor()` already
read. Extra $1 slots still stack on top of a plan.

`#/plans` shows this month's message and AI meters, a six-month trend, the plan cards and the
invoice table. The dashboard carries a compact strip with the same numbers. Meters warn at 80%
and turn red when a cap is passed, but limits stay **soft** — nothing is dropped silently.

`lib/usage.js` keeps per-user, per-month counters (`usage["<userId>:<YYYY-MM>"]`) for messages,
AI replies, commands, bot starts and coin claims, and prunes anything older than six months.
`record()` is wrapped in try/catch at every call site, so bookkeeping can never break a
WhatsApp send. Every payment — approved, pending or rejected — becomes a receipt with a stable
number (`LB-202603-4F2A`) and a printable sheet.

When a plan lapses the bots keep running for a `GRACE_DAYS` (2) window while the UI asks for a
renewal; after that the normal coin billing takes over.

## 5. Console UX: saved replies, bulk actions, command builder

The WhatsApp console gained a ⚡ button that opens a searchable library of saved replies.
Replies belong to the account rather than the number, so the same answers follow an owner
between bots; inserting one fills `{name}`, `{first}`, `{group}`, `{bot}`, `{me}`, `{date}` and
`{time}` from the chat on screen. A new account is offered six starter replies.

The dashboard can now act on several bots at once: each card has a checkbox and the bulk bar
sends `POST /api/bots/bulk` with up to 25 ids, reporting partial success per bot.

Custom `!commands` are buildable without an API key. **Commands** on a bot card opens a form for
text, image and webhook commands with aliases, access (`everyone`/`admins`/`owner`), scope
(`any`/`group`/`private`) and a cooldown; webhook secrets are displayed exactly once. The same
`lib/customcommands.js` backs the public API, so both stay in step.

## Tests

`test/plans-usage.test.js` covers the whole new surface without a server: plan resolution
(free/trial/subscription/expired/admin), grant stacking vs. switching, extra slots raising the
bot cap, grace windows, usage recording and caps, month maths and pruning, invoice numbering,
totals and per-user scoping, and snippet CRUD, validation, the per-user cap, rendering and
search. It runs as part of `npm test`.

```bash
npm test        # unit: 57 WhatsApp assertions + 71 site-wide assertions
npm run test:ui # browser: 24 WhatsApp checks + 63 site-wide / PWA checks
```

`test/site-features.test.js` covers the activity log (ordering, filters, search, pagination,
read state, CSV quoting, truncation, HTML stripping, meta caps, the bot-event bridge, and
per-user isolation) and site search (scoring, user scoping, drive walking, dotfile skipping,
result caps and ordering).

`test/site-ui-harness.js` drives a real Chromium against a running server and checks the bell,
the activity page (filters, search, mark-all-read, CSV link), the palette (Ctrl+K, focus,
ranking, Enter navigation, arrow keys, Escape, merged server results), and the PWA fix — it
asserts that `sw.js` precaches all nine previously missing modules, that the manifest is no
longer portrait-only, and that the `ladybug-v7` cache actually contains every module after the
worker installs.

The UI harness needs a running server and a Chromium binary:

```bash
DATA_DIR=/tmp/lbdata PORT=3101 node server.js &
CHROME_PATH=/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome node test/site-ui-harness.js
```
