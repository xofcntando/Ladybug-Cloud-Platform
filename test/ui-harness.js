const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:3101';
const BOT = '554b0a3438271b43f0';
const JID = '2348012345678@s.whatsapp.net';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (extra ? ' → ' + extra : ''))); };

  const login = await ctx.request.post(BASE + '/api/auth/login', { data: { username: 'tester1', password: 'secret123' } });
  ok('api login', login.ok(), String(login.status()));

  await page.goto(BASE + '/#/web?bot=' + BOT);
  await page.waitForSelector('#waApp', { timeout: 15000 });
  await page.waitForTimeout(1500);

  console.log('\nRail buttons');
  for (const [id, label] of [['wadBtn', 'Chat Digest'], ['wacBtn', 'Notes & follow-ups'], ['watBtn', 'Auto-translate']]) {
    ok(label + ' rail button present', await page.locator('#' + id).count() === 1);
  }

  console.log('\nOpen the seeded chat');
  await page.locator('.wa-chat[data-jid="' + JID + '"]').first().click();
  await page.waitForTimeout(1200);
  ok('thread rendered', await page.locator('.wa-msg').count() > 0, String(await page.locator('.wa-msg').count()));

  console.log('\nChat Digest');
  await page.locator('#wadBtn').click();
  await page.waitForTimeout(1800);
  ok('digest dialog opened', await page.locator('.wa-dialog.wad-wide').count() === 1);
  const digestText = await page.locator('.wa-dialog.wad-wide').innerText().catch(() => '');
  ok('digest shows message count', /12\s*\n?\s*messages/i.test(digestText) || digestText.includes('12'), digestText.slice(0, 120).replace(/\n/g, ' | '));
  ok('digest has topics', digestText.toLowerCase().includes('topics'));
  ok('digest has requests section', /requests and deadlines/i.test(digestText));
  ok('digest has decisions section', /decisions and commitments/i.test(digestText));
  ok('digest has activity chart', await page.locator('.wad-hour').count() === 24);
  ok('digest has offline note', digestText.includes('saved chat archive'));
  await page.selectOption('#wadDays', '30');
  await page.waitForTimeout(1500);
  ok('30-day switch reloads', (await page.locator('.wa-dialog.wad-wide').innerText()).includes('30 day'));
  await page.screenshot({ path: '/workspace/outputs/ui-digest.png' });
  await page.locator('.wa-dialog.wad-wide [data-x]').first().click();
  await page.waitForTimeout(400);

  console.log('\nNotes & follow-ups');
  const FU = 'UI follow-up ' + Date.now();
  const made = await ctx.request.post(BASE + '/api/bots/' + BOT + '/web/followups', {
    data: { jid: JID, text: FU, dueAt: Date.now() + 3 * 3600_000, chatName: 'Ada Mokoena' },
  });
  ok('follow-up created via API', made.ok(), String(made.status()));
  await page.locator('#wacBtn').click();
  await page.waitForTimeout(1200);
  ok('crm dialog opened', await page.locator('.wa-dialog.wac-wide').count() === 1);
  const crmText = await page.locator('.wa-dialog.wac-wide').innerText();
  ok('new follow-up listed', crmText.includes(FU));
  ok('follow-ups tab active by default', await page.locator('.wac-tabs button.on').count() === 1);
  // mark done
  const doneBtn = page.locator('.wac-row', { hasText: FU }).locator('button', { hasText: /done/i }).first();
  await doneBtn.click();
  await page.waitForTimeout(1200);
  ok('follow-up marked done', (await page.locator('.wa-dialog.wac-wide').innerText()).includes('Reopen'));
  // notes tab
  await page.locator('.wac-tabs button', { hasText: /notes/i }).first().click();
  await page.waitForTimeout(500);
  ok('notes tab shows note', (await page.locator('.wa-dialog.wac-wide').innerText()).includes('Prefers WhatsApp voice notes'));
  await page.screenshot({ path: '/workspace/outputs/ui-crm.png' });
  await page.locator('.wa-dialog.wac-wide [data-x]').first().click();
  await page.waitForTimeout(400);

  console.log('\nAuto-translate');
  await page.locator('#watBtn').click();
  await page.waitForTimeout(1200);
  ok('translate dialog opened', await page.locator('.wa-dialog.wat-wide').count() === 1);
  const trText = await page.locator('.wa-dialog.wat-wide').innerText();
  ok('language picker present', await page.locator('.wa-dialog.wat-wide select').count() >= 1);
  ok('auto toggle present', await page.locator('.wat-switch input').count() >= 1);
  ok('explains local caching', /server|never leaves|cache/i.test(trText));
  await page.screenshot({ path: '/workspace/outputs/ui-translate.png' });

  console.log('\nPage errors');
  // The console probes status/avatar/presence/media on a stopped bot and those answer 409;
  // that is existing behaviour, so only count real script errors here.
  const real = errors.filter((e) => !/Failed to load resource/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
