# 🐞 Ladybug Cloud — Multi-Tenant WhatsApp Bot Hosting

A free, self-hostable platform for running **Ladybug Mini** WhatsApp bots. Users sign up for free, paste their session ID, and get their own isolated bot process. An admin panel lets you install/update the bot code and manage every user and bot.

Built by **Ntandomods** · Deployable on **Render** in one click.

---

## ✨ Features

| Area | What you get |
| --- | --- |
| **Free accounts** | Public registration with bcrypt-hashed passwords and persistent, never-expiring login sessions (stored on disk, survive restarts) |
| **Session IDs** | Each user pastes their own `Ladybug!...` session; stored per-user and injected as `SESSION_ID` |
| **⚡ In-browser pairing** | Users generate a session themselves: enter a phone number, get an 8-digit WhatsApp pairing code, session is built automatically — no local setup |
| **📊 Public status page** | `/status` shows live platform health, running bots, uptime and per-bot status (session IDs never exposed) |
| **Isolation** | One `node index.js` process per bot, separate `session_<botId>` folder, separate temp dir |
| **Control** | Start / stop / restart, auto-restart with backoff (5 attempts), live status badges |
| **Logs** | 600-line ring buffer per bot, streamed to a live console in the dashboard, with a free **Download .txt** button (timestamps added, session IDs and custom setting values scrubbed) |
| **Admin panel** | Stats, user management (plan/limit/ban/delete), all bots, one-click installer |
| **Installer** | Install Ladybug Mini from GitHub, upload a ZIP, or re-run `npm install` for the bot |
| **Free tier limit** | 1 bot per free user, 10 for pro, unlimited for admin — all configurable |

---

## 💰 Pricing, trial & coins

- **Free trial:** every new account gets `TRIAL_DAYS` (default **7**) of free hosting for 1 bot. Existing accounts get a fresh trial on first boot after this update.
- **Daily coins:** each user can claim `CLAIM_COINS` (default **20**) free coins every `CLAIM_COOLDOWN_HOURS` (default 24), capped at `MAX_COINS` (140).
- **Coin plan:** after the trial a bot costs `BOT_COIN_COST` coins (default **20**) per `BOT_COIN_PERIOD_DAYS` (default **1** day). It renews automatically every minute-check; if the owner can't pay the bot is paused and shows a banner. Claiming daily keeps one bot online for free.
- **Subscription:** `$3/month` (`SUBSCRIPTION_PRICE_USD`) = unlimited runtime with no coins. Set `PAYMENT_URL` to a payment link (e.g. Stripe Payment Link); the dashboard button appends `client_reference_id=<username>`. After payment the admin presses **+30d sub** on the user in **Admin → Users**.

---

## 🏦 Payments, ZiG prices & contact admin

- **Pay page (`#/pay`)**: signed-in users see the admin's **NSB** bank accounts (ZiG `3251650604001`, USD `3251650604451`), their username as the payment reference, and a USD + ZiG price table.
- **ZiG prices**: ZiG = USD price x `zigPerUsd`. Default rate `26.57` (RBZ interbank, 27 Oct 2026); change it any time in **Admin -> Payments** or with `ZIG_PER_USD`. ZiG prices also appear on the public pricing section.
- **Admin -> Payments**: edit bank name, account holder name, accounts, exchange rate and instructions (stored in the database, backed up with everything else). Env overrides for first boot: `PAYMENT_BANK`, `PAYMENT_ACCOUNT_NAME`, `PAYMENT_ZIG_ACCOUNT`, `PAYMENT_USD_ACCOUNT`, `PAYMENT_INSTRUCTIONS`.
- **Contact admin (`#/support`)**: every user has a private thread with the admin (2000 chars/message, 5 messages/minute). Unread badge in the nav. The admin answers from **Admin -> Inbox**.
- **Coin packs**: one-off top-ups (default 100 coins = $1, 300 coins = $2.50; override with `PACK_SMALL_COINS/USD`, `PACK_LARGE_COINS/USD`). Users submit "I have paid" on the Pay page, the admin approves in **Admin -> Payments**, and the coins land in `bonusCoins` (never capped by `MAX_COINS`, never expire, spent after the free daily coins).
- **Referrals**: each user has a link `#/register?ref=<username>` on the dashboard (copy + WhatsApp share). The friend gets `REFERRAL_FRIEND_COINS` (20) bonus coins at signup; the referrer gets `REFERRAL_REFERRER_COINS` (40) once the friend's bot has been online `REFERRAL_MIN_UPTIME_MIN` (10) minutes. Cap `REFERRAL_MONTHLY_CAP` (10) rewards per referrer per 30 days. Blocked: self-referral, same-network signups, same WhatsApp session as the referrer, more than 3 welcome bonuses per IP. **Admin -> Referrals** lists everything.
- **Bots survive restarts**: bots that were running are resumed on boot (after `BOOT_RESUME_DELAY_SEC`, default 20s, so an overlapping old instance can release the WhatsApp session first). A **watchdog** checks every minute and restarts any bot that should be running but is down (with back-off), even after auto-restart gave up. On Render a **keep-alive** ping (`RENDER_EXTERNAL_URL`, disable with `KEEP_ALIVE=false`) stops the free plan from sleeping and taking all bots offline. Set `MONGODB_URI` or all users and bots are lost on every restart.

## 🆕 New: Settings, Custom bot settings & Crash alerts

| Feature | Plan | What it does |
| --- | --- | --- |
| **Change password** (`#/settings`) | Free | Users change their own password. All their other logged-in devices are signed out. Wrong-password attempts are rate limited. |
| **Custom bot settings** | Paid, `$1/month` (`ENVVARS_PRICE_USD`, `ENVVARS_DAYS`) | Per-bot environment variables (e.g. `PREFIX`, `OWNER_NUMBER`) set from the **Settings** button on a bot card. Up to 20 per bot. Platform-reserved names (`SESSION_*`, `PATH`, `NODE_*`, ...) are refused. Values are only injected while the pass is active; saved values are kept if it lapses. |
| **Crash alerts** | Paid, `$1/month` (`ALERTS_PRICE_USD`, `ALERTS_DAYS`) | A webhook (Discord, Slack or any HTTPS endpoint) is told when a bot goes down and when it has been back online for 30 seconds. Includes a **Send test alert** button. Webhooks are SSRF-guarded: HTTPS only, public addresses only, no redirects. |
| **Uptime history** | Free 24h, paid 30 days (`$1/month`, `UPTIME_PRICE_USD`, `UPTIME_DAYS`) | The **Uptime** button on a bot card shows uptime %, a bar chart and recent starts/stops/crashes. Everyone gets the last 24 hours; the paid pass adds 30 days of history, 7/30-day uptime and the full event list. Recording runs for everyone, so history is already there when a user upgrades. Data is stored in hourly buckets (a few KB per bot) and included in the MongoDB backup. |

The paid features are sold like the other add-ons: users pick them on **Pay** (`#/pay?buy=envvars` / `#/pay?buy=alerts`), the admin approves the payment and the pass switches on automatically. The admin can also grant 30 days with the **+env vars** / **+alerts** / **+uptime** buttons in **Admin -> Users**. Admins always have every feature.

- **Admin -> Bots: WhatsApp numbers.** Each bot row shows the WhatsApp number it is linked to (read from the session ID, then confirmed by the number the bot reports when it connects), its name, a live connection state (Connected / Connecting / Reconnecting / Session conflict / Logged out / Offline), how long ago the last log line came in, and **Copy** / **Test** buttons (Test opens `wa.me/<number>` so you can message the bot and check it answers). The top of the tab shows "X of Y bots connected". Numbers are admin-only and never returned by user-facing endpoints.

## 🗄️ MongoDB backup (keeps data on Render free)

Set one environment variable and the platform backs itself up:

1. Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) (M0, free).
2. **Database Access** → add a user with a password. **Network Access** → allow `0.0.0.0/0` (Render's IPs change).
3. **Connect → Drivers** → copy the connection string, e.g. `mongodb+srv://user:pass@cluster0.xxxx.mongodb.net/`.
4. In Render → your service → **Environment** → add `MONGODB_URI` with that string and redeploy.

What happens: users, bots, coins, subscriptions and login sessions are mirrored to MongoDB ~2 seconds after every change, and restored automatically on boot whenever the local disk is empty (redeploy / wake from sleep). Bot WhatsApp session IDs live in the database, so bots come back too. If MongoDB can't be reached at boot the site still starts and backups pause for that run (it never overwrites the backup with an empty database). **Admin → Overview** shows backup status. Optional: `MONGODB_DB` (default `ladybug_cloud`).

---

## 🚀 Deploy on Render

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml`.
3. Set `ADMIN_PASSWORD` (defaults to `mods`) and click **Apply**.
4. Wait for the first deploy, open the URL, log in as **Ntando / mods**.
5. Go to **Admin → Installer → Install from GitHub**. Done.

### Self-healing bot dependencies

The bot source is installed without its `node_modules` (they are gitignored), and on an
ephemeral filesystem they vanish on every redeploy. The platform now repairs itself:

- Installing the bot (GitHub or ZIP) automatically starts `npm install` in `bots/ladybug`.
- Starting a bot checks `node_modules` first; if anything is missing it installs the
  dependencies, streams the output into the bot log as `[deps] ...`, then starts the bot.
- On boot, any bot that was running is only resumed after dependencies are verified.
- If a crash is caused by `Cannot find module`, the host stops the restart loop and tells
  you to run **Admin → Bot Installer → Install Dependencies** instead of retrying 5 times.
- Lifecycle scripts are allowed during install (`NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS`),
  otherwise npm 11.6+/12 skips them and native modules such as `sharp`, `canvas` and
  `ffmpeg-static` end up broken.

> **Free vs persistent data:** Render's free plan has **no persistent disk**, so accounts, bots and session folders live on the ephemeral filesystem and reset whenever the service redeploys or wakes from sleep. That is fine for trying it out. For permanent storage, switch the service to `plan: starter`, uncomment the `disk:` block in `render.yaml`, and set `DATA_DIR=/var/data` and `BOT_DIR=/var/data/bots/ladybug`.

### Option B — Manual Web Service

- **Environment:** Node
- **Build:** `npm install`
- **Start:** `node server.js`
- **Disk:** optional — add a 1 GB disk at `/var/data` only if you use a paid instance (free plans can't mount disks)
- **Env vars:**

```
ADMIN_USERNAME=Ntando
ADMIN_PASSWORD=mods
SESSION_SECRET=<random long string>
DATA_DIR=/var/data          # or ./data on the free plan
BOT_DIR=/var/data/bots/ladybug
NODE_ENV=production
```

Health check path: `/healthz`

---

## 🧑‍💻 Local development

```bash
npm install
cp .env.example .env      # edit if you like
npm start
# open http://localhost:3000
```

Default admin: **Ntando / mods**.

After logging in as admin, install the bot code:

```bash
curl -b cookies.txt -X POST localhost:3000/api/admin/installer/github \
  -H 'Content-Type: application/json' -d '{}'
curl -b cookies.txt -X POST localhost:3000/api/admin/installer/deps
```

---

## 🔑 Getting a session ID

Users don't need to run anything locally. In **Dashboard → New Bot** they enter their phone number with country code and click **Get code**. The platform asks WhatsApp for a pairing code, shows it in the browser, and once the user enters it under *WhatsApp → Linked devices → Link with phone number*, the session is generated and filled in automatically.

A session ID looks like:

```
Ladybug!H4sIAAAAAAAA...   (base64 of gzipped creds.json)
```

It can also be pasted manually if the user already has one. The host only ever shows a masked preview afterwards.

---

## 🗂️ Project layout

```
server.js            Express app + all routes
lib/store.js         JSON datastore (atomic writes, debounced)
lib/bots.js          Process manager (spawn/stop/restart, logs, auto-restart)
lib/installer.js     GitHub/ZIP installer + npm dependency runner
lib/sessiongen.js    Pairing job manager (in-browser session generation)
lib/sessiongen-worker.js  Baileys worker that requests the pairing code
public/              Vanilla JS SPA (landing, auth, dashboard, admin)
bots/ladybug/        Installed bot code (gitignored, runtime)
data/                db.json (gitignored, runtime)
render.yaml          Render blueprint
```

---

## 🔌 API overview

**Auth** `POST /api/auth/register|login|logout`, `GET /api/auth/me`
**Bots** `GET|POST /api/bots`, `PATCH|DELETE /api/bots/:id`, `POST /api/bots/:id/start|stop|restart`, `GET|DELETE /api/bots/:id/logs`, `GET /api/bots/:id/logs/download`
**Sessions** `POST /api/session/pair` (body `{phone}`), `GET|DELETE /api/session/pair/:id`
**Public** `GET /api/status`, `GET /healthz`
**Admin** `GET /api/admin/stats|users|bots|installer`, `PATCH|DELETE /api/admin/users/:id`, `DELETE /api/admin/bots/:id`, `POST /api/admin/installer/github|upload|deps`

---

## ⚠️ Notes

- Render's free tier spins down idle services; bots stop when the instance sleeps. Use a paid instance or an uptime pinger for 24/7 bots.
- Session IDs are secrets. They are stored in `db.json` on the persistent disk — restrict access to the disk and rotate `SESSION_SECRET` if leaked.
- Change the default admin password before exposing the service publicly.

---

Made with 🐞 by **Ntandomods**.


## 🗂️ Ladybug Drive: 1 TB storage on Render

A visual file manager (`#/storage`): drag-and-drop upload with progress, folders, rename, download, delete, a colour-coded usage bar per file type and a platform capacity card.

- **Capacity:** `STORAGE_TOTAL_GB` (default `1024` = 1 TB) for the whole platform, `STORAGE_USER_GB` (default `5`) per user, `STORAGE_MAX_FILE_MB` (default `2048`) per file. Capacity shown is always clamped to the real disk size, so the UI never promises space that does not exist.
- **Where files live:** `STORAGE_DIR` (default `$DATA_DIR/storage`). Each user is jailed to their own folder (path traversal is blocked) and files are deleted with the account.
- **Deploy with 1 TB on Render:** use `render.storage.yaml` (Starter plan + `sizeGB: 1024` disk mounted at `/var/data`). Persistent disks cost about $0.25/GB/month on Render, so ~$256/month for 1 TB plus the instance. Render does not publish a maximum disk size: if 1024 is rejected, lower `sizeGB` or contact Render support. Disks can grow but not shrink.
- The free plan has no persistent disk, so files there are lost on redeploy. Use the storage blueprint for anything real.

## 🛡️ Service hardening

Security headers on every response, gzip compression, per-IP rate limits (sign-in, sign-up, API, drive), live per-bot memory/CPU on the dashboard, and a richer `/healthz` (memory, load, bots running). Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` yourself - the server warns at boot if the old default is still in use.

## Public API (v1)

> APIs powered by **Ntandomods Developers**. Every response carries `X-API-Provider: Ntandomods Developers`.

Control your bots from scripts, CI or your own dashboard. Log in, open **API** in the top bar, create a key, and send it as a bearer token to `/api/v1`:

```bash
curl https://YOUR-SITE/api/v1/bots -H "Authorization: Bearer lbk_your_key"
```

Full reference in the dashboard (API page) and machine-readable at `/api/v1/openapi.json`.

### Free vs API Pass ($5 / 30 days)

| | Free | API Pass |
| --- | --- | --- |
| Read endpoints (`me`, `billing`, `usage`, `bots`, `logs`, `uptime` 24h) | yes | yes |
| Keys | 1 read-only | 5, read or write, optional expiry + IP allowlist |
| Rate limit | 30 / min | 600 / min |
| Start / stop / restart bots | no | yes |
| Create, rename, delete bots (`POST /bots`, `PATCH`, `DELETE`) | no | yes |
| WhatsApp pairing for customers (`/session/pair`) | no | yes |
| Env vars over the API (`/bots/{id}/env`) | no | yes |
| Signed webhooks (`/webhooks`) | no | yes |
| Live log stream (`/bots/{id}/logs/stream`, SSE) | no | yes |
| 30-day uptime, 7-day resource history | no | yes |
| Crash alerts, custom bot settings, uptime history passes | separate | included |

The pass is bought on the Pay page (`item: api`, price `API_PRICE_USD`, length `API_DAYS`) and approved by the admin like the other passes, or granted from the admin user list (**+API**).

### Webhook events

`bot.started`, `bot.stopped`, `bot.crashed`, `bot.online`, `bot.logged_out`, `bot.conflict` (plus `webhook.test`). Each request is signed:

```
X-Ladybug-Timestamp: <unix seconds>
X-Ladybug-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret>
```

Reject timestamps older than 5 minutes. Failed deliveries are retried at 0s, 5s and 30s; an endpoint that fails 20 deliveries in a row is paused.

### Security

Keys and webhook URLs are checked server-side: keys are stored as SHA-256 hashes and see only the owner's bots; webhook URLs must be public HTTPS (private ranges blocked); log output hides session IDs and env values; API keys cannot touch passwords, payments or the file drive.

### WhatsApp-safety guardrails

Automation that reconnects or re-pairs in a loop is a classic way to get numbers restricted, so the API enforces limits on top of the usual rate limit (HTTP 429 with `Retry-After` and `"guardrail":"whatsapp-safety"`):

- Start / restart: 1 per 30 s and 6 per hour, per bot (stop is never limited).
- Pairing: 5 per account and 2 per phone number, per hour.

The Developers page (`#/developers`) has the full guide, including a "Avoid WhatsApp bans" checklist. Nothing can guarantee a number is never restricted; Ladybug is not an official WhatsApp product.


---

## API v1.3 (Ntandomods Developers)

- **Keys end with `_ntandomods`**: new keys look like `lbk_<48 hex>_ntandomods`. Keys issued before this change keep working.
- **Custom commands**: `POST /api/v1/bots/:id/commands` creates a command the bot answers in WhatsApp (types `text`, `image`, `webhook`; access `everyone|admins|owner`; scope `any|group|private`; per-user cooldown). Also `GET/PATCH/DELETE /bots/:id/commands/:cid`, `POST .../enable|disable`, `POST .../rotate-secret`, `POST /bots/:id/commands/bulk` (up to 25, all or nothing) and `GET /commands/meta`. Needs an API Pass and a write key. Commands are stored on the bot, written to `data/custom-commands/<botId>.json` and hot-reloaded by the bot, so no restart is needed. Custom commands take priority over built-ins with the same name.
- **Webhook commands** are POSTed JSON, signed with `X-Ladybug-Signature: sha256=<hmac>`, 5 s timeout, HTTPS only, private/internal addresses blocked (including after DNS resolution).
- **Advanced behaviour**: `X-Request-Id` on every response, uniform errors `{error, code, requestId}`, `Idempotency-Key` on POST (10 min replay), pagination/filtering on `GET /bots` (`status`, `q`, `limit`, `offset`), log filters (`since`, `stream`, `q`) with a `cursor`, and batch control `POST /bots/actions`.
- The installer re-applies the one-line `handler.js` hook and copies `lib/bot-shims/customCommands.js` after any bot update, like the premium gate.
