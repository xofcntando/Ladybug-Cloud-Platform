# Advanced WhatsApp Web features (beyond stock WhatsApp)

## 1. Bot bridge (lib/bot-shims/webBridge.js)
- [x] Anti-delete archive: capture original text/media on revoke before clearing
- [x] `deletedList` / `deletedClear` handlers
- [x] `analytics` handler (volume, hour heatmap, weekday, top chats, media mix, response time)

## 2. Platform API
- [x] lib/webconsole.js: deleted, deletedClear, analytics, translate methods
- [x] app.js: routes for deleted / deleted/clear / analytics / translate
- [x] translate provider ladder (gtx -> dict-chrome-ex -> MyMemory) + 1h cache
- [x] fix: `statusPosts` declaration was swallowed by a comment (status rate-limit was broken)

## 3. Frontend (public/js/wa-pro.js)
- [x] Recovered-messages panel (anti-delete)
- [x] Analytics dashboard with heatmap
- [x] Broadcast dialog with throttling, progress and cancel
- [x] Undo-send window on the composer
- [x] Inline translate action on incoming messages
- [x] Wire into index.html + app.js init
- [x] single-panel guard so advanced dialogs do not stack

## 4. Verify
- [x] node --check all changed files
- [x] live API tests against running server (deleted, deleted/clear, analytics, translate, cache hit)
- [x] UI smoke test via browser: 3 rail buttons render, all panels open, form hook + WAX hooks chained, no console errors
- [ ] commit + push
