# Installed app: every feature, its own style

When Ladybug Cloud is installed (Add to Home Screen / Install app), it no longer looks or
behaves like the website. The installed app gets its own shell — a gradient app bar, a
bottom tab bar, and an **All features** sheet that reaches every page and every WhatsApp
console tool in one tap. The website keeps its normal top navigation, untouched.

Nothing is hidden behind a "more" menu that only lists a handful of links: the sheet is
generated from one list, and a unit test fails the build if a tile points at a page or a
tool that does not exist.

## How the app knows it is installed

`public/js/appmode.js` detects app mode from any of:

| Signal | Why |
| --- | --- |
| `?app=1` in the URL | lets you preview the app shell in a normal browser tab |
| `localStorage.lb_app_mode === '1'` | lets you force the shell on for testing |
| `matchMedia('(display-mode: standalone)')` | Android / desktop install |
| `matchMedia('(display-mode: window-controls-overlay)')` | desktop PWA with the title bar overlay |
| `matchMedia('(display-mode: fullscreen)')` | some launchers |
| `navigator.standalone === true` | iOS home-screen app |

`?app=0` forces the website shell even when installed, which is handy for support calls.

When app mode is on, `document.documentElement` gets `data-app="1"`, and while the chrome
is showing it also gets `data-app-chrome="1"` (that is what adds the body padding so the
bar and tabs never cover content).

## What the app looks like

The website uses a flat, sticky top nav with text links and chips. The app uses:

- **App bar** — fixed, blurred, with a blue-to-mint gradient wordmark, the current page
  name, a search button (opens the Command Palette), an activity bell with a dot badge,
  and a menu button that opens the sheet.
- **Tab bar** — fixed at the bottom, five tabs: Home, Chats, Drive, Activity, All. The
  active tab gets a gradient pill and a gradient underline.
- **All features sheet** — a bottom sheet on phones, a centred card on tablets and
  desktops, grouped into Workspace, Account, WhatsApp console tools, and This device.

Both bars respect `env(safe-area-inset-*)`, so they clear the notch and the iOS home
indicator.

## Everything in the sheet

**Workspace** — My bots, WhatsApp, Storage, Activity.
**Account** — Pay, Settings, Developers, Status, Contact admin, Terms.
**WhatsApp console tools** — Chat Digest, Notes & follow-ups, Auto-translate, Response
Radar, Deleted messages, Analytics, Broadcast, Labels, Gallery, Contacts, New group,
Status & stories, Channels, Automation, Appearance, Linked numbers.
**This device** — Search, Check for update, Log out.

That is 10 pages and 16 console tools, all reachable in at most two taps from anywhere in
the app.

## Console tools open directly

Picking a tool navigates to `#/web?bot=<id>&tool=<name>`. `renderWebConsole()` reads the
`tool` parameter, strips it from the hash with `history.replaceState` (so a reload does
not reopen the panel), and after the chat list has loaded it calls the right module:

| Tool | Call |
| --- | --- |
| digest | `WADIG.open()` |
| notes | `WACRM.open()` |
| translate | `WATR.open()` |
| radar | `WRADAR.open()` |
| deleted | `WAPRO.openDeleted()` |
| analytics | `WAPRO.openAnalytics()` |
| broadcast | `WAPRO.openBroadcast()` |
| labels | `WALBL.manage()` |
| gallery | `WAGAL.open(jid)` (asks you to pick a chat if none is open) |
| contacts | `WACON.open()` |
| groups | `WAGRP.openCreate()` |
| stories | `WASTAT.open()` |
| channels | `WACHAN.open()` |
| auto | `WAAUTO.open()` |
| appearance | `WAX.openAppearance()` |
| accounts | `WAACC.open()` |

The WhatsApp console itself is full-bleed, so the app bar and tab bar step aside on
`#/web` — the console keeps its own rail and header.

## Offline

`public/sw.js` precaches `/js/appmode.js` along with every other module, one URL at a
time, so a single renamed file can never abort the install. The cache version is
`ladybug-v8`; the update prompt in `pwa.js` offers a one-tap reload when a new build
lands.

## Tests

- `test/app-shell.test.js` — 19 static checks. Confirms the module is loaded and
  precached, that all 10 pages are real routes, that all 16 tools have a deep-link
  handler and that each handler calls a function that exists, that the website nav is
  replaced rather than duplicated, and that the app styles are present.
- `test/app-ui-harness.js` — 40 Playwright checks at a 430×880 phone viewport. Confirms
  the website is unchanged without app mode, the bar/tabs/sheet render and are styled
  differently, the sheet lists 10 pages + 16 tools + 3 device actions, tab and sheet
  navigation work, and two real deep links (digest, appearance) open their panels.

Run them with:

```bash
npm test                       # unit suites, including app-shell
npm run test:ui                # browser suites, including app-ui
```

`?app=1` is the quickest way to see the app shell without installing anything.
