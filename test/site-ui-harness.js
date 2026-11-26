/**
 * Browser checks for the two site-wide features and the PWA install fix.
 *
 * Run against a live server:
 *   DATA_DIR=/tmp/lbdata PORT=3101 node server.js &
 *   CHROME_PATH=... node test/site-ui-harness.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:3101';
const USER = process.env.LB_USER || 'tester1';
const PASS = process.env.LB_PASS || 'secret123';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  let pass = 0;
  let fail = 0;
  const ok = (n, c, extra) => { c ? (pass++, console.log('  \u2713 ' + n)) : (fail++, console.log('  \u2717 ' + n + (extra ? ' \u2192 ' + extra : ''))); };
  const section = (t) => console.log('\n' + t);

  const login = await ctx.request.post(BASE + '/api/auth/login', { data: { username: USER, password: PASS } });
  ok('api login', login.ok(), String(login.status()));

  /* ------------------------------------------------------------ activity */
  section('Activity timeline');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForSelector('#navActBell', { timeout: 15000 });
  ok('bell in the nav', await page.locator('#navActBell').count() === 1);
  ok('palette button in the nav', await page.locator('#navPalBtn').count() === 1);
  await page.waitForTimeout(400);
  ok('Activity link in the nav', await page.locator('#navLinks a[href="#/activity"]').count() >= 1);
  ok('bell links to the timeline', (await page.locator('#navActBell').getAttribute('href')) === '#/activity');

  // The nav is re-rendered on every route change, so let it settle before clicking.
  await page.waitForTimeout(900);
  await page.locator('#navActBell').click();
  await page.waitForFunction(() => location.hash.indexOf('#/activity') === 0, null, { timeout: 8000 }).catch(() => {});
  if (!(await page.locator('.act-item').count())) await page.goto(BASE + '/#/activity');
  await page.waitForSelector('.act-list .act-item', { timeout: 15000 });
  const items = await page.locator('.act-item').count();
  ok('activity entries render', items > 0, String(items));
  ok('stats row present', await page.locator('.stats-row .stat').count() === 3);
  ok('filter chips present', await page.locator('.act-chip[data-type]').count() >= 6);
  ok('day headings present', await page.locator('.act-day').count() >= 1);
  ok('entries show a category tag', await page.locator('.act-kind').count() > 0);

  // filter by Security (login events exist for sure)
  await page.locator('.act-chip[data-type="security"]').click();
  await page.waitForTimeout(700);
  const kinds = await page.locator('.act-kind').allInnerTexts();
  ok('security filter applied', kinds.length > 0 && kinds.every((k) => /security/i.test(k)), JSON.stringify(kinds.slice(0, 5)));
  ok('security chip is active', await page.locator('.act-chip[data-type="security"].on').count() === 1);
  ok('url carries the filter', page.url().includes('type=security'), page.url());

  // empty filter shows the empty state
  await page.locator('.act-chip[data-type="billing"]').click();
  await page.waitForTimeout(700);
  const hasBilling = await page.locator('.act-item').count();
  if (hasBilling === 0) ok('empty filter shows a friendly message', /No activity matches/.test(await page.locator('#actList').innerText()));
  else ok('billing filter only shows billing', (await page.locator('.act-kind').allInnerTexts()).every((k) => /billing/i.test(k)));

  // back to everything, then search
  await page.locator('.act-chip[data-type=""]').click();
  await page.waitForTimeout(700);
  const before = await page.locator('.act-item').count();
  await page.fill('#actQ', 'signed');
  await page.waitForTimeout(900);
  const after = await page.locator('.act-item').count();
  ok('search narrows the feed', after > 0 && after <= before, before + ' -> ' + after);
  ok('search box keeps its value', (await page.inputValue('#actQ')) === 'signed');

  await page.fill('#actQ', '');
  await page.waitForTimeout(800);
  ok('CSV export link is wired', /\/api\/activity\/export\.csv/.test(await page.locator('#actCsv').getAttribute('href')));

  // mark all read clears the bell
  await page.locator('#actMark').click();
  await page.waitForTimeout(1200);
  ok('mark all read clears the unread stat', /0/.test(await page.locator('.stats-row .stat').nth(1).innerText()));
  const bellHidden = await page.locator('#navActN').evaluate((el) => el.style.display === 'none');
  ok('bell badge hidden after reading', bellHidden);
  ok('no entry is left flagged new', await page.locator('.act-item.is-new').count() === 0);
  await page.screenshot({ path: '/workspace/outputs/ui-activity.png', fullPage: false });

  /* ------------------------------------------------------------ palette */
  section('Command palette');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForSelector('#navPalBtn', { timeout: 15000 });
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.pal-overlay.show', { timeout: 5000 });
  ok('Ctrl+K opens the palette', await page.locator('.pal-overlay.show').count() === 1);
  await page.waitForTimeout(350);
  ok('input is focused', await page.evaluate(() => document.activeElement && document.activeElement.id === 'palInput'));
  ok('default list shows pages', await page.locator('.pal-item').count() >= 5);
  ok('grouped headings', await page.locator('.pal-group').count() >= 1);

  await page.fill('#palInput', 'stor');
  await page.waitForTimeout(500);
  const firstLabel = await page.locator('.pal-item').first().innerText();
  ok('typing ranks Storage first', /storage/i.test(firstLabel), firstLabel.replace(/\n/g, ' | '));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  ok('Enter navigates to the page', page.url().includes('#/storage'), page.url());
  ok('palette closed after opening a page', await page.locator('.pal-overlay.show').count() === 0);

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  await page.fill('#palInput', 'activity');
  await page.waitForTimeout(500);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  ok('arrow keys move the selection', await page.locator('.pal-item.on').count() === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Escape closes the palette', await page.locator('.pal-overlay.show').count() === 0);

  // server-backed search
  const search = await ctx.request.get(BASE + '/api/search?q=alpha');
  ok('search API responds', search.ok(), String(search.status()));
  const sd = await search.json();
  ok('search API returns typed results', Array.isArray(sd.results) && sd.counts && typeof sd.counts.bot === 'number');

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  await page.fill('#palInput', 'test');
  await page.waitForTimeout(1500);
  const groups = await page.locator('.pal-group').allInnerTexts();
  ok('search merges server results', groups.some((g) => /bots|drive|activity/i.test(g)), JSON.stringify(groups));
  await page.screenshot({ path: '/workspace/outputs/ui-palette.png' });
  await page.keyboard.press('Escape');

  /* ------------------------------------------------------------ PWA */
  section('PWA / installed app');
  const sw = await ctx.request.get(BASE + '/sw.js');
  const swText = await sw.text();
  ok('sw.js is served', sw.ok(), String(sw.status()));
  ok('cache version bumped', /ladybug-v8/.test(swText));
  ok('precache is fault tolerant', /cache\.add\(/.test(swText) && !/addAll\(SHELL\)/.test(swText));
  for (const m of ['wa-groups', 'wa-undo', 'wa-radar', 'wa-pro', 'wa-digest', 'wa-crm', 'wa-translate', 'activity', 'palette']) {
    ok('shell precaches ' + m + '.js', swText.includes('/js/' + m + '.js'));
  }
  const man = await ctx.request.get(BASE + '/manifest.webmanifest');
  const manJson = await man.json();
  ok('manifest orientation is not locked to portrait', manJson.orientation !== 'portrait', manJson.orientation);
  ok('manifest keeps standalone display', manJson.display === 'standalone');
  for (const f of ['/js/activity.js', '/js/palette.js', '/js/wa-pro.js', '/js/wa-translate.js', '/js/wa-crm.js', '/js/wa-digest.js']) {
    const r = await ctx.request.get(BASE + f);
    ok('module loads: ' + f, r.ok(), String(r.status()));
  }

  // let the worker install, then inspect the cache it created
  await page.goto(BASE + '/#/dashboard');
  await page.waitForTimeout(3500);
  const cacheInfo = await page.evaluate(async () => {
    if (!('caches' in window)) return { keys: [], urls: [] };
    const keys = await caches.keys();
    const urls = [];
    for (const k of keys) {
      const c = await caches.open(k);
      for (const req of await c.keys()) urls.push(new URL(req.url).pathname);
    }
    return { keys, urls };
  });
  ok('service worker cache exists', cacheInfo.keys.some((k) => /ladybug-v8/.test(k)), JSON.stringify(cacheInfo.keys));
  for (const m of ['/js/wa-groups.js', '/js/wa-undo.js', '/js/wa-radar.js', '/js/wa-pro.js', '/js/wa-digest.js', '/js/wa-crm.js', '/js/wa-translate.js', '/js/activity.js', '/js/palette.js']) {
    ok('cached for offline: ' + m, cacheInfo.urls.includes(m), String(cacheInfo.urls.length) + ' urls cached');
  }

  section('Errors');
  ok('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
