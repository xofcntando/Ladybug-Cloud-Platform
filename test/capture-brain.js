/**
 * Capture screenshots of the Ladybug Brain panel for documentation.
 * Requires the platform running on PORT (default 4600) with a seeded demo bot.
 *
 *   node test/capture-brain.js
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.CAP_BASE || 'http://127.0.0.1:4600';
const BOT = process.env.CAP_BOT || 'bf23734caa6cd6ecfa';
const USER = process.env.CAP_USER || 'demoowner';
const PASS = process.env.CAP_PASS || 'Passw0rd!23';
const OUT = process.env.CAP_OUT || '/workspace/screenshots';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(async ({ u, p }) => {
    await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
  }, { u: USER, p: PASS });
  await page.goto(BASE + '/#/web?bot=' + BOT, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.WABRAIN.open());
  await page.waitForSelector('.wa-brain', { timeout: 15000 });
  await page.waitForTimeout(900);

  const scroll = (y) => page.evaluate((top) => {
    const sc = document.querySelector('.wa-brain-scroll');
    if (sc) sc.scrollTop = top;
  }, y);

  const shot = async (file) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: OUT + '/' + file });
    console.log('shot ' + file);
  };

  await shot('01-console-overview.png');

  await scroll(0);
  await shot('02-panel-business.png');

  await scroll(430);
  await shot('03-panel-hours.png');

  await scroll(880);
  await shot('04-panel-prices-faqs.png');

  await scroll(1330);
  await shot('05-panel-handoff.png');

  async function ask(text, file) {
    await page.fill('#bTest', text);
    await page.click('#bTestGo');
    await page.waitForFunction(() => {
      const o = document.querySelector('#bTestOut');
      return o && o.textContent.trim().length > 10;
    }, { timeout: 20000 });
    await page.evaluate(() => {
      const card = document.querySelector('#bTestOut').closest('.wa-brain-card');
      const sc = document.querySelector('.wa-brain-scroll');
      if (card && sc) sc.scrollTop = card.offsetTop - 12;
    });
    await shot(file);
    const out = await page.evaluate(() => document.querySelector('#bTestOut').innerText);
    console.log('  Q: ' + text + '\n  A: ' + out.replace(/\n/g, ' | ') + '\n');
  }

  await ask('how much is a website?', '06-answer-pricing.png');
  await ask('are you open on Saturday?', '07-answer-hours.png');
  await ask('do you have a free trial?', '08-answer-faq.png');
  await ask('this is terrible, I have been waiting 3 days and nobody replies', '09-escalation.png');
  await ask('do you do SEO for Shopify stores?', '10-honest-gap.png');

  await page.evaluate(() => {
    const h = [...document.querySelectorAll('.wa-brain-card-head')].find((n) => /could not answer/i.test(n.textContent));
    const sc = document.querySelector('.wa-brain-scroll');
    if (h && sc) sc.scrollTop = h.closest('.wa-brain-card').offsetTop - 12;
  });
  await shot('11-gap-list.png');

  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
