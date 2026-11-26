# Two new site-wide features + PWA fix

## 1. Plan
- [x] Survey the site (routes, pages, modules) to avoid duplicating existing features
- [x] Pick two features that apply to the whole site, not just the WhatsApp console
  - Activity Timeline: account-wide audit trail + notification bell (bots, billing, storage, security, account)
  - Command Palette: Ctrl/Cmd+K quick switcher for pages, actions, bots, drive files and activity

## 2. Backend
- [x] lib/activity.js: per-user capped log, filters, unseen count, CSV, bot-event bridge
- [x] lib/site-search.js: cross-entity search (bots, drive files, activity)
- [x] app.js: /api/activity, /api/activity/seen, /api/activity/export.csv, /api/search
- [x] app.js: record activity on login, register, password, bot lifecycle, payments, storage, keys, webhooks

## 3. Frontend
- [x] public/js/activity.js: nav bell + #/activity page with filters, search, load more, CSV
- [x] public/js/palette.js: Ctrl+K overlay with keyboard navigation and quick actions
- [x] public/css/style.css: styles for the bell, timeline and palette
- [x] public/index.html + app.js: load modules, register route, wire nav

## 4. PWA fix (installed app was missing features)
- [x] sw.js: precache every module, per-URL caching, bump VERSION to ladybug-v7
- [x] manifest.webmanifest: orientation any + display_override
- [x] pwa.js: update-available prompt, focus re-check, hide install button when standalone

## 5. Verify
- [x] node --check on every changed file
- [x] unit tests: activity log, site search (71 assertions)
- [x] Playwright: bell renders, activity page filters/search work, Ctrl+K opens and navigates, cache contains every module (63 checks)
- [x] commit, push to GitHub

## 6. Docs
- [x] FEATURES_SITE_WIDE.md
