/**
 * Browser checks for installed-app mode: the app must expose every feature and look
 * different from the website (app bar + bottom tabs + all-features sheet).
 *
 * Run against a live server:
 *   DATA_DIR=/tmp/lbdata PORT=3101 node server.js &
 *   CHROME_PATH=... node test/app-ui-harness.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:3101';
const USER = process.env.LB_USER || 'tester1';
const PASS = process.env.LB_PASS || 'secret123';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
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

  /* ------------------------------------------------------- website unchanged */
  section('Website (no app mode) keeps its own chrome');
  await page.goto(BASE + '/#/dashboard');
  await page.waitForSelector('#navActBell', { timeout: 15000 });
  await page.waitForTimeout(500);
  ok('website nav is visible', await page.locator('.nav').isVisible());
  ok('no app bar on the website', await page.locator('#appBar').count() === 0);
  ok('no tab bar on the website', await page.locator('#appTabs').count() === 0);
  ok('html is not marked as an app', (await page.getAttribute('html', 'data-app')) === null);
  ok('website nav still has the links', await page.locator('#navLinks a[href="#/dashboard"]').count() >= 1);

  /* ------------------------------------------------------------ app shell */
  section('Installed app shell');
  await page.goto(BASE + '/?app=1#/dashboard');
  await page.waitForSelector('#appBar', { timeout: 15000 });
  await page.waitForTimeout(700);
  ok('html is marked as an app', (await page.getAttribute('html', 'data-app')) === '1');
  ok('website nav is hidden', !(await page.locator('.nav').isVisible()));
  ok('app bar is visible', await page.locator('#appBar').isVisible());
  ok('app bar shows the page title', (await page.locator('#appBarTitle').innerText()).trim() === 'My bots');
  ok('app bar has search, bell and menu', await page.locator('#appSearch').count() === 1 && await page.locator('#appBell').count() === 1 && await page.locator('#appMenu').count() === 1);
  ok('tab bar is visible', await page.locator('#appTabs').isVisible());
  ok('tab bar has 5 tabs', await page.locator('#appTabs .apptab').count() === 5);
  ok('Home tab is active on the dashboard', await page.locator('.apptab[data-tab="home"].on').count() === 1);
  ok('body leaves room for bar and tabs', await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return parseInt(s.paddingTop, 10) >= 50 && parseInt(s.paddingBottom, 10) >= 70;
  }));
  const look = await page.evaluate(() => {
    const b = getComputedStyle(document.querySelector('#appBar'));
    const t = getComputedStyle(document.querySelector('#appTabs'));
    return { bar: b.backgroundImage, tabs: t.position, barPos: b.position };
  });
  ok('app bar is fixed with a gradient (different from the flat website nav)', look.barPos === 'fixed' && /gradient/.test(look.bar), JSON.stringify(look));

  /* -------------------------------------------------------- all features */
  section('All features sheet');
  await page.locator('#appMenu').click();
  await page.waitForTimeout(450);
  ok('sheet opens', await page.locator('#appSheet.show').count() === 1);
  ok('body locks scroll behind the sheet', await page.evaluate(() => document.body.classList.contains('appsheet-open')));
  const tools = await page.locator('#appSheet [data-tool]').count();
  ok('all 16 WhatsApp console tools are listed', tools === 16, String(tools));
  const pages = await page.locator('#appSheet [data-href]').count();
  ok('all 10 pages are listed', pages === 10, String(pages));
  ok('device actions are listed', await page.locator('#appSheet [data-act]').count() === 3);
  const groups = await page.locator('#appSheet .appsheet-group h3').allInnerTexts();
  ok('sheet is grouped', groups.length >= 4, JSON.stringify(groups));
  const labels = await page.locator('#appSheet [data-tool] b').allInnerTexts();
  ok('every console tool has a label', labels.length === 16 && labels.every((l) => l.trim().length > 2), JSON.stringify(labels));

  // open a page from the sheet
  await page.locator('#appSheet [data-href="#/storage"]').click();
  await page.waitForTimeout(900);
  ok('sheet closes after picking a page', await page.locator('#appSheet.show').count() === 0);
  ok('picking a page navigates', page.url().includes('#/storage'), page.url());
  ok('Drive tab becomes active', await page.locator('.apptab[data-tab="drive"].on').count() === 1);
  ok('title follows the page', (await page.locator('#appBarTitle').innerText()).trim() === 'Storage');

  // tab bar navigation
  await page.locator('.apptab[data-tab="activity"]').click();
  await page.waitForTimeout(900);
  ok('Activity tab navigates', page.url().includes('#/activity'), page.url());
  ok('Activity tab is active', await page.locator('.apptab[data-tab="activity"].on').count() === 1);

  /* --------------------------------------------------- tool deep links */
  section('Console tool deep links');
  const bots = await (await ctx.request.get(BASE + '/api/bots')).json();
  const botId = (bots.bots || [])[0] && bots.bots[0].id;
  ok('a bot exists for the deep link', !!botId);

  await page.goto(BASE + '/?app=1#/web?bot=' + encodeURIComponent(botId) + '&tool=digest');
  await page.waitForSelector('#waApp', { timeout: 20000 });
  await page.waitForTimeout(2500);
  ok('console opens from the deep link', await page.locator('#waApp').count() === 1);
  ok('the tool panel opens', await page.locator('#wadPick, .wa-dialog-back').count() >= 1);
  ok('the tool is stripped from the hash', !/[?&]tool=/.test(page.url()), page.url());
  ok('app bar steps aside in the console', !(await page.locator('#appBar').isVisible()));
  ok('tab bar steps aside in the console', !(await page.locator('#appTabs').isVisible()));

  await page.goto(BASE + '/?app=1#/web?bot=' + encodeURIComponent(botId) + '&tool=appearance');
  await page.waitForSelector('#waApp', { timeout: 20000 });
  await page.waitForTimeout(2500);
  ok('appearance tool opens too', await page.locator('.wa-dialog-back').count() >= 1);

  /* ------------------------------------------------------------ offline shell */
  section('Service worker shell');
  const sw = await (await ctx.request.get(BASE + '/sw.js')).text();
  ok('sw precaches the app shell module', /'\/js\/appmode\.js'/.test(sw));
  ok('sw version was bumped', /ladybug-v8/.test(sw));
  const html = await (await ctx.request.get(BASE + '/')).text();
  ok('index loads the app shell module', /\/js\/appmode\.js/.test(html));

  section('Console errors');
  ok('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
