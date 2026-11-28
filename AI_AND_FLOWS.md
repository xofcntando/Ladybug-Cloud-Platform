# ✨ AI Assistant & 🧭 Chatbot Flow Builder

Two new tools in the Ladybug WhatsApp Web console. Both live in the left rail of
`#/wa` (and in the installed app's features sheet), and both are opt-in — nothing
runs, and no message leaves your server, until you turn them on.

---

## 1. AI assistant (bring your own key)

**Rail button:** ✨ · **Deep link:** `#/wa?tool=ai` · **Module:** `public/js/wa-ai.js`

The console's promise is that message content stays on your own server. Shipping a
platform-wide AI key would break that promise, so this feature only ever runs
against a provider **you** choose, with a key **you** paste in. If no provider is
configured the endpoints answer `409` and the panel shows a setup form instead of
buttons that would fail.

### What it does

| Action | Where | What happens |
| --- | --- | --- |
| **Suggest replies** | AI panel, current chat | Reads the last ~30 messages, asks the model for three short, ready-to-send replies, shows them as chips. Tapping one puts it in the composer — nothing is sent for you. |
| **Summarise** | AI panel, current chat | Returns a fixed-shape summary: `Summary`, `Open questions`, `Promises or deadlines`, `Next step`. Good for catching up on a long thread or a group. |
| **Rewrite / change tone** | AI panel, current chat | Rewrites whatever is already in the composer. Tones: shorter, friendlier, more formal, more apologetic, more confident. |
| **Transcribe voice note** | Any incoming voice bubble | A small **AI text** pill appears under the player; one tap turns the audio into text in a dialog you can copy. |

### Provider setup

Any OpenAI-compatible API works — OpenAI, Groq, Together, OpenRouter, Fireworks,
DeepInfra, vLLM, LM Studio, Ollama's OpenAI shim, or your own gateway:

```
POST {baseUrl}/chat/completions      { model, messages, temperature, max_tokens }
POST {baseUrl}/audio/transcriptions  multipart: file + model
```

Enter the base URL (e.g. `https://api.openai.com/v1`), the model name (e.g.
`gpt-4o-mini`) and the key. The key is stored server-side and only ever returned
**masked** (`sk-…abcd`); the browser never receives it again. Leaving the key field
blank on a later save keeps the stored key; **Remove provider** deletes it entirely.

### Security

- `baseUrl` must be `https://`. Plain `http://` is allowed only for `localhost`,
  `127.0.0.1` and `::1`, so a model running on the same box can be used.
- The hostname is resolved and private, loopback, link-local, CGNAT, multicast and
  cloud-metadata addresses are refused — a user cannot point the platform at its own
  internal network (SSRF).
- Requests time out after 45 s; provider error bodies are truncated and mapped to
  readable messages (`401/403` → "the provider rejected the API key", `429` → rate
  limited).
- The endpoint is rate limited to **20 AI calls per minute per bot**.
- Only the text needed for the action is sent: the recent transcript for replies and
  summaries, the composer text for rewrites, the audio bytes for transcription.

### Storage

`db.data.ai[userId] = { baseUrl, model, apiKey, updatedAt }` — one provider per
account, shared by all of that account's bots, backed up with the rest of the
database and wiped when the account is deleted.

### Auto-respond (new)

**AI panel → Auto-respond** switch, per bot. When it is on, the AI model answers new customer
messages by itself instead of only suggesting replies.

- Direct chats only, never groups, never your own outgoing messages.
- The AI chats **as Ladybug** 🐞 (Ladybug Mini by Ntandomods): warm, short WhatsApp-style messages, honest that it is an AI if asked, replies in the customer's language (Shona and Ndebele included). It can make small talk and answer general questions, but business facts come only from your instructions.
- Order: flows, then keyword rules, then **AI**, then the built-in brain, then the away message.
  If the AI errors or times out, the brain / away message answers instead, so nobody is left in silence.
- It replies to **everything** in a direct chat: questions, small talk, complaints, emojis, and voice notes, photos, files or stickers (it says it can't hear or see them and asks for text). Angry customers get a calm apology and a promise the owner will follow up; it never promises refunds or outcomes. Replies that arrive while it is writing are answered next, so no message is skipped.
- **Personalities:** pick who Ladybug is in the AI panel (Personality), optionally rename her. Nine are built in: **Ladybug** (default),
  **Girlfriend**, **Boyfriend**, **Bestie**, **Sales assistant**, **Support agent**, **Study tutor**, **Life coach**, **Comedian** and
  **Professional** (formal, no emoji). Definitions live in `lib/wa-personas.js`. The persona changes the voice only; the core rules
  (no invented business facts, honest about being an AI, calm with upset people, always replies) apply to all of them.
  Girlfriend and Boyfriend are adults-only, PG companions with guard rails enforced in code: they stay a friendly chat until the
  person has said they are 18 or older (the bot asks their age, and an unknown, declined or under-18 age keeps it friendly), they never
  go sexual, never claim to be human, never guilt-trip or cut people off from real relationships, and drop the flirting if someone seems
  to be struggling. They do not ask the student/business question. If you switch off the get-to-know questions, romance cannot turn on.
- **Getting to know new people (fun):** the first time someone writes, Ladybug greets them, introduces herself and answers what they said,
  then asks ONE playful question per message: their name, then what describes them (student, business owner, customer, other;
  editable), then their age ("guess my age"-style, fine to skip), then city or country. It is always optional: if someone dodges or
  declines, Ladybug laughs it off and never asks that again, and nothing is asked more than twice. Facts they volunteer early are
  picked up automatically and not asked again. Answers are remembered per chat, so later replies use their name now and then and are
  pitched at who they are (under-18s get age-appropriate replies). The panel has a tick box for each question, shows role and
  place counts, average age and the latest people, and **Forget these answers** resets everyone. A chat that is already ongoing (you wrote
  in it, or it has more than two messages) is never quizzed. Stored in `waBook[botId].aiPeople`.
  Privacy: this stores personal details (name, age, place) on your platform; tell customers if your local law needs it, and use the
  **Forget these answers** button to delete them.
- Nothing is required: switching it on is enough. Owner instructions (optional, up to 1,500 characters: prices, hours, delivery, tone) are sent with every request. Without them Ladybug chats naturally and says it will pass specifics on to the owner.
- If you reply in a chat yourself, or pause it, the AI stands down there.
- Limits: no cooldown; a loop guard of 60 AI replies per chat per hour and 300 per bot per hour. Groups are still skipped (answering every group message would be spam).
- The provider key never reaches the bot process: the bot sends the last 14 messages to the platform over IPC
  (`ai-request` / `ai-response`) and receives one reply.
- Storage: `db.data.waBook[botId].auto.aiReply = { enabled, instructions, cooldownSec, maxPerHour }`.

---

## 2. Chatbot flow builder

**Rail button:** 🧭 · **Deep link:** `#/wa?tool=flows` · **Modules:** `public/js/wa-flows.js`, `lib/bot-shims/flow-engine.js`

Keyword auto-replies send one fixed message. Flows send a **conversation**: a
message with numbered options, then a different message per choice, up to eight
steps deep, with loops back to the menu.

### Building a flow

- **Name** — for your own reference.
- **Trigger keyword** — matched anywhere in an incoming message, case-insensitive.
  Tick **exact** to require the whole message to be the keyword.
- **Any message** — fires when nothing else matched. Useful for a welcome menu.
  A keyword flow always wins over an "any message" flow.
- **Cooldown** — minutes before the same flow can start again in the same chat, so a
  menu doesn't spam a chatty customer.
- **Steps** — up to 8. Each step is a message plus up to 6 options. Every option has
  a label and a target: **next step**, **a specific step** (menus, "back to menu"),
  or **end**. A step with no options ends the flow after sending.
- **Preview** — shows exactly what the customer receives, numbered options included.

Limits: 20 flows per bot, 8 steps per flow, 6 options per step, 500 characters per
message, 40 per option label, 80 per keyword.

### How a conversation runs

1. An incoming direct message matches a flow → the first step is sent and a session
   opens for that chat (30-minute TTL).
2. The next message is matched against that step's options — `2`, `2)` or the option
   label both work. A match advances the flow; anything else is left to the keyword
   rules and away message, and the session stays open.
3. The flow ends when an option points at `end`, when the target step has no options,
   or when the session expires.

Flows only run in **direct chats** (never groups or status), never on your own
outgoing messages, and they run **before** keyword rules and the away message.

### Storage & sync

Flows are part of the existing automation settings, so they inherit everything that
already worked there:

```
db.data.waBook[botId].auto.flows = [ { id, name, match, exact, any, enabled, cooldownMin, steps: [...] } ]
```

They are validated on the platform (`lib/wa-book.js` → `cleanFlows`), pushed to the
running bot with the same `autoSet` RPC as the other automation switches, and seeded
at boot through the `LADYBUG_AUTO` env JSON. The engine itself
(`lib/bot-shims/flow-engine.js`) is dependency-free and is copied next to
`webBridge.js` in the bot directory by the installer, so it runs inside the bot
process with no extra packages.

---

## Tests

`test/wa-ai-flows.test.js` — 75 assertions covering flow normalisation, triggers,
rendering, stepping, stale sessions, storage caps and validation, key masking, the
SSRF guards, and full AI round-trips against a local HTTP stub provider (including
`401` handling and key removal). It uses a throwaway `DATA_DIR` and makes no real
network call.

```
npm test    # includes the new suite
```
