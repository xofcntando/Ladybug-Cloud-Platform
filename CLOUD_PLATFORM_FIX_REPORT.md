# Ladybug Cloud Platform — Host & Bot Fix Report

**Repository:** `https://github.com/xofcntando/Ladybug-Cloud-Platform`
**Scope:** Fix the hosting platform (the "host"), the bot installed by the admin installer, and per-bot independence (isolation between tenants).

---

## 1. Executive Summary

The platform booted, but the admin "Install from GitHub" flow was broken end-to-end and, once the bot finally installed, it could not start reliably. Three classes of defects were found and fixed:

1. **Installer was pointing at a dead repository URL** — every install attempt failed with a 404 before a single file was written.
2. **npm 12 blocked native build scripts** — `canvas`, `ffmpeg-static`, `sharp` and Baileys' `preinstall` were silently skipped, so the bot crashed at runtime on `require('canvas')` and `ffmpeg-static`.
3. **Bots were not independent** — all bots shared one `database/`, one `config.js`, one economy file and one session namespace, so one tenant's prefix, mode, warnings or economy balance leaked into another's.

A fourth, subtler defect was found in the process manager: the `stop()` routine armed an unconditional 8-second `SIGKILL` timer that killed a bot *after* it had already been restarted, producing the "bot dies ~8 s after restart" symptom.

All four are fixed, verified live with two concurrent bots, and the installer is now idempotent and self-healing.

---

## 2. Defects and Fixes

### 2.1 Dead installer source URL (blocking)

`lib/installer.js` defaulted to `https://github.com/kids-codentando/Ladybug-Mini/...`, which returns **404**. The admin installer therefore could never fetch bot source.

**Fix:**
- Default changed to the live repository:
  `https://github.com/xofcntando/Ladybug-Mini/archive/refs/heads/main.zip`
- Added a **fallback list** (`REPO_ZIP_FALLBACKS`) covering `main`, `master`, and the legacy org.
- Added `downloadFirstAvailable(urls, dest)` which tries each candidate in order, aggregates errors, and throws a readable message:
  `Could not download bot source. Tried: <url> -> <error>; ...`
- `installFromGitHub()` now returns the URL actually used in `source`, so the admin UI can show provenance.
- `.env.example` updated to the working `BOT_ZIP_URL`.

**Verification:** `POST /api/admin/installer/github` → `{"ok":true,"files":193,...,"source":"https://github.com/xofcntando/Ladybug-Mini/archive/refs/heads/main.zip"}`.

---

### 2.2 npm 12 script policy broke native modules (blocking)

npm 12 blocks lifecycle scripts by default. The install log showed six blocked scripts:

| package | blocked script | consequence |
|---|---|---|
| `baileys` | `preinstall` | engine check skipped |
| `sharp` | `install` | no prebuilt binary |
| `canvas` | `install` | `Cannot find module '../build/Release/canvas.node'` |
| `ffmpeg-static` | `install` | binary never downloaded |
| `puppeteer` | `install` | Chromium download |
| `protobufjs` | `postinstall` | codegen skipped |

**Fix (three layers):**

1. **Environment** — `NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS=true` is set for every `npm install` / `npm rebuild` spawned by the installer (already present in `render.yaml`; now also enforced in code).
2. **Self-heal** — new `nativeStatus()` reports `{ ok, issues, ffmpegOk, canvasBinding, napiCanvas, sharpOk }`. After a successful `npm install`, if `nativeStatus().ok === false`, the installer runs `npm rebuild <issues...>` automatically with the same env, streaming output to the admin console.
3. **Runtime hardening (bot side)** — new `lib/bot-shims/ffmpeg.js` is copied into the bot as `utils/ffmpeg.js` and **all 15 bot files** that did `require('ffmpeg-static')` are rewritten to:

   ```js
   require('../../utils/ffmpeg').getFfmpegPath() || 'ffmpeg'
   ```

   The resolver tries `FFMPEG_PATH` → the real `ffmpeg-static` binary → system `ffmpeg` (validated with `spawnSync(bin, ['-version'])`). Canvas imports are wrapped in try/catch with an `@napi-rs/canvas` fallback.

**Verification:** `nativeStatus()` now returns `{"ok":true,"issues":[],"ffmpegOk":true,"canvasBinding":true,"napiCanvas":true,"sharpOk":true}`.

---

### 2.3 Bots were not independent (the "independences" request)

Previously every bot process ran with the same `cwd` and no data-dir override, so `database.js`, `config.js`, `economy.json`, and session folders were **shared** across tenants. Changing one bot's prefix changed all of them; one user's warnings/economy were visible to another.

**Fix — per-bot state plumbing:**

- `lib/bots.js` now creates, per bot:
  - `bots/ladybug/data_<botId>/` — private data directory
  - `bots/ladybug/session_<botId>/` — private session directory
  - `TMPDIR=/tmp/ladybug_<botId>` — private temp space

  and injects into the child env:
  ```
  SESSION_NAME=session_<botId>
  BOT_DATA_DIR=<abs path>/data_<botId>
  LADYBUG_BOT_ID=<botId>
  TMPDIR=/tmp/ladybug_<botId>
  ```

- New `lib/bot-shims/runtimeConfig.js` (copied to `bots/ladybug/utils/runtimeConfig.js`) stores per-bot overrides in `$BOT_DATA_DIR/config.json` with `load()/set()/get()`.

- New `ensurePerBotState()` (run by the installer on every install) rewrites the bot so it respects `BOT_DATA_DIR`:
  - `database.js`: `const DB_PATH = process.env.BOT_DATA_DIR || path.join(__dirname, 'database');`
  - `commands/fun/bomb.js`: economy DB path uses `process.env.BOT_DATA_DIR`.
  - `config.js`: appended override loader that merges `utils/runtimeConfig.load()` over the exported defaults.
  - Five owner commands (`setprefix`, `setbotname`, `setnewsletter`, `anticall`, `mode`) now persist via `require('../../utils/runtimeConfig').set(...)` instead of mutating the shared `config.js`.

**Verification (live, two bots):**

| bot | pid | SESSION_NAME | BOT_DATA_DIR | TMPDIR |
|---|---|---|---|---|
| TestBot `04ca6941…` | 17888 | `session_04ca6941…` | `data_04ca6941…` | `/tmp/ladybug_04ca6941…` |
| SecondBot `393bb270…` | 17988 | `session_393bb270…` | `data_393bb270…` | `/tmp/ladybug_393bb270…` |

Both report `running=true`, `restarts=0`, distinct PIDs, and each has its own `groups.json`, `users.json`, `warnings.json`, `mods.json`, `sudo.json`.

Config isolation test — wrote `prefix=#`, `mode=private` into **A only**:

```
[data_04ca6941…] prefix=# mode=private
[data_393bb270…] prefix=. mode=undefined   ← untouched default
```

---

### 2.4 Restart SIGKILL race (bot died ~8 s after restart)

`lib/bots.js` `stop()` armed `setTimeout(() => proc.kill('SIGKILL'), 8000)` unconditionally. When a restart happened inside that window, the timer fired on the *new* process and killed it, producing `Exited with code null (SIGKILL)` and an endless crash/revive loop.

**Fix:**
- `stop()` captures `const target = rt.proc;` and stores `rt.killTimer`; the callback only kills **if `rt.proc === target`**, then `.unref()`.
- `start()` clears any stale `rt.killTimer` before spawning.
- `proc.on('exit')` clears `rt.killTimer`.

**Verification:** after `POST /api/bots/:id/restart`, the bot remains `running=True pid=17888 restarts=0 err=None` well past the 8-second window.

---

### 2.5 Installer idempotency & protected files

Re-running the installer over an already-installed bot keeps premium/protected files intact and re-applies every hardening step:

```
{"ok":true,"files":193,
 "skipped":["commands/owner/premium.js","commands/premium/","commands/premium/codec.js",
            "commands/premium/fast.js","commands/premium/fastdl.js","commands/premium/showcase.js",
            "utils/fastFetch.js","utils/premium.js"],
 "gate":"present","customCmds":"reapplied",
 "hardening":"ffmpeg:present,patched:15,runtimeConfig:present,config:perbot,database:perbot,
              economy:perbot,setprefix.js:patched,setbotname.js:patched,setnewsletter.js:patched,
              anticall.js:patched,mode.js:patched,ownerCmds:5"}
```

Because the shims live in `lib/bot-shims/` and are re-copied on every install, an upstream `git pull` of the bot source cannot undo the platform fixes.

---

## 3. Verification Matrix

| Check | Result |
|---|---|
| Platform syntax (`node --check`, all non-vendor `.js`) | **0 failures** |
| Bot syntax (`node --check`, all bot `.js`) | **0 failures** |
| Command registry load | **719 commands, 0 missing `execute`** |
| `/healthz` | `{"ok":true,...}` |
| Admin login + `/api/status` | OK |
| Installer from GitHub | `ok:true, files:193` |
| Native modules | `ok:true` (ffmpeg, canvas, napi-canvas, sharp) |
| Two bots concurrent | both `running`, distinct PIDs, `restarts=0` |
| Per-bot data dirs | separate `data_<id>/` with own JSON stores |
| Per-bot config | A=`#`/private, B=`.`/undefined |
| Per-bot session dirs | separate `session_<id>/` |
| Restart stability | survives past 8 s, no SIGKILL |
| Cross-tenant auth | new user sees `{"bots":[],"limit":1}`; cannot read admin bot (`"Not your bot"`) |
| Duplicate session | rejected |

---

## 4. Files Changed

**Platform:**
- `lib/installer.js` — +287/−12: fallback download, `ensureBotHardening()`, `ensurePerBotState()`, `nativeStatus()`, npm rebuild self-heal.
- `lib/bots.js` — +19: per-bot `BOT_DATA_DIR`/`TMPDIR`/session dir, SIGKILL race fix.
- `lib/bot-shims/ffmpeg.js` — **new** resilient ffmpeg resolver.
- `lib/bot-shims/runtimeConfig.js` — **new** per-bot config store.
- `.env.example` — corrected `BOT_ZIP_URL`.

**Bot (applied by installer):**
- `utils/ffmpeg.js`, `utils/runtimeConfig.js` — **new shims**.
- `database.js`, `config.js`, `commands/fun/bomb.js` — per-bot paths.
- 15 files — ffmpeg require rewritten.
- `commands/owner/{setprefix,setbotname,setnewsletter,anticall,mode}.js` — per-bot persistence.
- `utils/tgsToWebp.js` — `@napi-rs/canvas` fallback.

---

## 5. Deployment Notes

`render.yaml` already carries the required env:

```yaml
NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: "true"
PUPPETEER_SKIP_DOWNLOAD: "true"
DATA_DIR: /opt/render/project/src/data
BOT_DIR:  /opt/render/project/src/bots/ladybug
```

Build: `npm install && npm --prefix bots/ladybug install --omit=dev --no-audit --no-fund`

On a fresh deploy the admin should open **Admin → Bot Installer → Install from GitHub** once; the installer will fetch the bot, install deps, self-heal native modules, and apply all per-bot hardening automatically.

---

## 6. Known Limitations / Follow-ups

1. **No `GET /api/bots/:id` route** — only the list endpoint plus sub-routes exist. The SPA does not call it, but an API consumer might expect it. Low priority.
2. **Free-plan ephemeral storage** — Render free instances lose `data_<id>/` and `session_<id>/` on redeploy unless a persistent disk is mounted at `DATA_DIR`. Mongo sync restores bot records, but session folders must be re-seeded.
3. **Real WhatsApp session required** — the test bots used a synthetic `Ladybug!…` payload, so the socket reports `incorrect data check`. This is expected; a genuine paired session connects normally.
4. **`canvas` vs `@napi-rs/canvas`** — both are supported; `@napi-rs/canvas` is preferred on hosts without a C++ toolchain.
