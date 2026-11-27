/**
 * Screenshots for human takeover + media replies.
 *   node test/capture-takeover.js
 * Env: CAP_BASE, CAP_BOT, CAP_USER, CAP_PASS, CAP_OUT
 */
const { chromium } = require('playwright');

const BASE = process.env.CAP_BASE || 'http://127.0.0.1:4600';
const BOT = process.env.CAP_BOT || 'bf23734caa6cd6ecfa';
const USER = process.env.CAP_USER || 'demoowner';
const PASS = process.env.CAP_PASS || 'Passw0rd!23';
const OUT = process.env.CAP_OUT || '/workspace/screenshots';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ([u, p]) => {
    await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
  }, [USER, PASS]);
  await page.goto(BASE + '/#/web?bot=' + BOT, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.WAPAUSE && window.WABRAIN);
  await page.waitForTimeout(1200);

  const shot = (f) => page.screenshot({ path: OUT + '/' + f });

  /* 1. the takeover panel */
  await page.evaluate(() => window.WAPAUSE.open());
  await page.waitForSelector('.wa-pause');
  await page.waitForTimeout(500);
  await shot('12-takeover-panel.png');
  const rows = await page.evaluate(() => document.querySelectorAll('.wa-pause-row').length);
  console.log('paused rows in panel:', rows);

  /* 2. media replies in the brain's try-it box */
  await page.evaluate(() => {
    const back = document.querySelector('#waApp > .wa-dialog-back');
    if (back) back.remove();
  });
  await page.evaluate(() => window.WABRAIN.open());
  await page.waitForSelector('.wa-brain');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.wa-brain-card')].find((c) => /try it/i.test(c.textContent));
    const sc = document.querySelector('.wa-brain-scroll');
    if (card && sc) sc.scrollTop = card.offsetTop - 12;
  });
  await page.click('[data-media="voice"]');
  await page.waitForSelector('#bTestOut .wa-brain-bubble');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.wa-brain-card')].find((c) => /try it/i.test(c.textContent));
    const sc = document.querySelector('.wa-brain-scroll');
    if (card && sc) sc.scrollTop = card.offsetTop - 12;
  });
  await shot('13-voice-note.png');
  const voice = await page.evaluate(() => document.querySelector('#bTestOut').innerText);
  console.log('voice reply:', voice.replace(/\n/g, ' | '));

  await page.click('[data-media="image"]');
  await page.waitForTimeout(900);
  await shot('14-photo.png');
  const photo = await page.evaluate(() => document.querySelector('#bTestOut').innerText);
  console.log('photo reply:', photo.replace(/\n/g, ' | '));

  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
