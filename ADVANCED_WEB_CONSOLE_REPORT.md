# Advanced WhatsApp Web console — what shipped

Commit `2818d81` on `xofcntando/Ladybug-Cloud-Platform` (main).
9 files, +419 / −5.

The dashboard's WhatsApp console already behaved like WhatsApp Web. These five
features are things stock WhatsApp Web does **not** do.

---

## 1. Anti-delete (recovered messages)

Stock WhatsApp removes a message the instant someone taps *delete for everyone* —
the text is gone for good. The bot now keeps a copy **before** the protocol
handler clears it.

`lib/bot-shims/webBridge.js`:

```js
if (pm.type === 0) {
  const c = chats.get(jid);
  const item = { jid, id: e.id, text: ..., type, fromMe, sender, senderName,
                 ts, deletedAt, chatName, isGroup, media, quoted };
  deletedLog.push(item);                    // newest last, capped at 300
  e.deleted = true; e.text = ''; e.media = null; raw.delete(e.id);
  emit('deleted', { jid, id: e.id, item });
}
```

Each entry keeps the text (up to the normal text cap), the sender and their
push name, the chat name, whether it was a group, a summary of the media
(mime / filename / duration) and the quoted message if there was one.

- `deletedList({ limit, jid })` → `{ items, total }`, newest first
- `deletedClear({ jid })` → `{ ok, total }`

Storage is memory only and dies with the bot process — nothing hits disk, so a
restart or a session move cannot leak it.

UI: shield button in the left rail. Rows are clickable and jump straight to the
chat. The panel subscribes to the console's SSE stream and refreshes itself the
moment a new deletion arrives, so you can watch it happen live.

## 2. Analytics

`analytics({ days })` walks the messages the bot already holds in memory and
returns:

| field | meaning |
|---|---|
| `total`, `incoming`, `outgoing` | volume in the window |
| `chats`, `groups` | distinct conversations |
| `timeline[]` | `{ day, in, out, total }` per calendar day |
| `hours[24]` | local-time distribution |
| `weekdays[7]` | Sunday-first distribution |
| `media{}` | image / video / audio / voice / document / sticker / other |
| `top[10]` | busiest chats with counts |
| `peakHour`, `busiestDay` | derived |
| `avgReplySec`, `replies` | average gap between an incoming message and your next reply |

Reaction-only entries are skipped so they don't inflate the counts. Everything
is computed inside the bot process — no data leaves the machine.

UI: chart button → 7 / 30 / 90 day tabs, KPI row, a sent-vs-received bar chart,
a 24-cell hour heatmap tinted with the console's green, a weekday table, a media
mix breakdown and a most-active-chats list.

## 3. Broadcast

Send one message to many chats without getting the number restricted. The
dialog gives you a searchable chat list with checkboxes, the message body, and
a gap selector of **4 s (safest) / 8 s / 15 s**. Sends run strictly one at a
time with a progress bar, a running `n of m` counter, a per-target failure
count and a stop button that halts after the in-flight message.

This is the same shape as the `broadcast` bot command, but driven from the
browser with live feedback.

## 4. Undo send

The composer is re-hooked so it can see the message id the send call returns.
For seven seconds a small bar floats above the composer offering **Undo**; it
posts `/web/delete` and removes the bubble from the thread immediately. After
the window closes the bar disappears on its own.

## 5. Inline translate

Every incoming text bubble gets a small `A文` button. It opens a panel showing
the original, a language picker, and the translation with a copy button.

Translation runs on the **platform**, not the bot, so the bot's number never
talks to a third party. Because Google's free endpoint throttles unknown
callers, `lib/webconsole.js` walks a ladder and takes the first answer:

1. `translate.googleapis.com` with `client=gtx`
2. `translate.googleapis.com` with `client=dict-chrome-ex`
3. `api.mymemory.translated.net` (`Autodetect|xx` for auto)

Results are cached for an hour (max 500 entries), keyed on
`from|to|text`. Response includes which provider answered (`via`) and whether
it was a cache hit.

---

## Bug found and fixed along the way

`lib/webconsole.js` line 31 had lost a newline, so the declaration of
`statusPosts` was sitting inside a `//` comment:

```js
const trCache = new Map(); // ... translatorconst statusPosts = new Map();
```

`statusPosts` was therefore `undefined`, and the status-post rate limiter
(`10 per hour`) threw a `ReferenceError` on every status post. Split back into
two lines.

## Files

| file | change |
|---|---|
| `lib/bot-shims/webBridge.js` | anti-delete archive, `deletedList`, `deletedClear`, `analytics` |
| `bots/ladybug/utils/webBridge.js` | installed copy, kept in sync |
| `lib/webconsole.js` | `deleted`, `deletedClear`, `analytics`, `translate` + provider ladder, `statusPosts` fix |
| `app.js` | 4 routes |
| `public/js/wa-pro.js` | new — all five panels |
| `public/css/style.css` | +66 lines for the new panels |
| `public/index.html` | script tag |
| `public/js/app.js` | `WAPRO` in the module init loop, extra ctx fields |

## Verification

- `node --check` clean on every changed file.
- Live server, logged in as admin, bot process running:
  - `GET /web/deleted` → `{"items":[],"total":0}`
  - `POST /web/deleted/clear` → `{"ok":true,"total":0}`
  - `GET /web/analytics?days=7` → full payload, 7 timeline entries, 24 hour buckets
  - `POST /web/translate` `{text, to:"zu"}` → `Sawubona, unjani namuhla? Ngihlola ikhonsoli entsha.` via `dict-chrome-ex`
  - repeat call → `"cached":true`
  - `fr` and `en` round-trips correct
- Browser smoke test on `#/web?bot=…`:
  - all three rail buttons present and laid out (44 × 33 px)
  - analytics, deleted and broadcast panels each render their full content
  - broadcast panel 720 px wide, chat picker wired
  - `#waForm` carries `data-wap-hook`, `WAX.afterPaint` and `WAX.beforeOpen` both still functions (chained, not replaced)
  - no console errors

## Note on the token

The GitHub token used to push is a classic PAT with repo scope. Revoke it at
<https://github.com/settings/tokens> once you're done — it has been pasted into
chat and should be considered burned.
