# Installed app: every feature, its own style

## 1. Plan
- [x] The installed PWA must show every feature, not a subset
- [x] It must look different from the website (own shell, not the top nav)

## 2. App shell (public/js/appmode.js)
- [x] Detect app mode: ?app=1, localStorage, display-mode standalone/overlay/fullscreen, navigator.standalone
- [x] Build a gradient app bar (title, search, activity bell with badge, menu)
- [x] Build a bottom tab bar: Home, Chats, Drive, Activity, All
- [x] Build an "All features" sheet: 10 pages + 16 console tools + 3 device actions
- [x] Hide the chrome on #/web and when logged out; set data-app / data-app-chrome

## 3. Style
- [x] public/css/style.css: app bar, tab bar, sheet, tiles, safe-area insets
- [x] Replace the website nav in app mode instead of duplicating it
- [x] Inline SVG icons for the bar and tabs

## 4. Wiring
- [x] public/index.html: load appmode.js after app.js
- [x] public/sw.js: precache appmode.js, bump VERSION to ladybug-v8
- [x] public/js/app.js: #/web?bot=&tool= deep links dispatch to all 16 console tools

## 5. Verify
- [x] node --check on every changed file
- [x] test/app-shell.test.js: 19 static checks (no dead tiles, no missing handlers)
- [x] test/app-ui-harness.js: 40 Playwright checks (website unchanged, app shell, sheet, deep links)
- [x] Full suites green: 57 + 71 + 19 unit, 24 + 63 + 40 UI
- [x] Screenshots reviewed (app vs website)

## 6. Docs
- [x] INSTALLED_APP.md
- [x] commit, push to GitHub
