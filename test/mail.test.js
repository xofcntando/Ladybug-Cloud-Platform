/**
 * Transactional email — the mail engine, the token store and the templates.
 *
 * These tests run with no provider key, which is exactly the state a fresh
 * clone is in. The point is that every flow still works: mail lands in the file
 * outbox, tokens are single use and expire, and the templates render real HTML
 * with the right links.
 *
 *   1. provider auto-detection and the outbox fallback
 *   2. address validation
 *   3. send() never throws and always reports what happened
 *   4. the outbox stores an envelope plus an HTML render, and prunes
 *   5. verify tokens: single use, kind-scoped, expired, newest wins
 *   6. reset tokens: same rules, separate namespace
 *   7. every template renders a link to the right page
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-mail-'));
process.env.DATA_DIR = dir;
delete process.env.MAIL_PROVIDER;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.MAILGUN_API_KEY;
delete process.env.POSTMARK_TOKEN;

const db = require('../lib/store');
const mailer = require('../lib/mailer');
const authmail = require('../lib/authmail');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

console.log('\nmail engine');

ok('no key means the outbox, and nothing is live', () => {
  assert.strictEqual(mailer.provider(), 'outbox');
  assert.strictEqual(mailer.enabled(), false);
  const st = mailer.status();
  assert.strictEqual(st.live, false);
  assert.ok(st.hint && /outbox/i.test(st.hint));
});

ok('status never leaks a key', () => {
  const json = JSON.stringify(mailer.status());
  assert.ok(!/sk_|SG\.|key-/i.test(json));
});

ok('address validation rejects the obvious junk and accepts real shapes', () => {
  const good = ['a@b.co', 'first.last+tag@sub.example.com', 'x_y@example.io'];
  const bad = ['', 'plain', 'a@b', 'a b@c.com', 'a@b..com', '@b.com', 'a@.com', 'a@b.com ', 'a@b.com\nbcc:x@y.z', 'a@b.c', null, 42];
  for (const g of good) assert.ok(mailer.validEmail(g), `should accept ${g}`);
  for (const b of bad) assert.ok(!mailer.validEmail(b), `should reject ${JSON.stringify(b)}`);
});

ok('escapeHtml neutralises every dangerous character', () => {
  const out = mailer.escapeHtml('<script>"x"&\'y\'</script>');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('>'));
  assert.ok(out.includes('&amp;'));
  assert.ok(out.includes('&quot;'));
});

ok('layout produces a complete document with the brand and no <style> block', () => {
  const html = mailer.layout({ title: 'Hi', body: '<p>body</p>', cta: { label: 'Go', url: 'https://x.test/a' } });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Ladybug Cloud'));
  assert.ok(html.includes('https://x.test/a'));
  assert.ok(!/<style/i.test(html), 'mail clients strip <style>, so styles must be inline');
  assert.ok(html.includes('</html>'));
});

console.log('\nsending');

(async () => {
  await okAsync('send() writes an envelope and an HTML render to the outbox', async () => {
    const r = await mailer.send({ to: 'one@example.com', subject: 'Hello there', html: '<p>hi</p>', text: 'hi' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.provider, 'outbox');
    assert.strictEqual(r.logged, true);
    assert.ok(r.id);
    const env = JSON.parse(fs.readFileSync(path.join(mailer.OUTBOX, r.id + '.json'), 'utf8'));
    assert.strictEqual(env.to, 'one@example.com');
    assert.strictEqual(env.subject, 'Hello there');
    assert.ok(env.at);
  });

  await okAsync('a bad recipient is refused, not thrown', async () => {
    const r = await mailer.send({ to: 'nope', subject: 'x' });
    assert.strictEqual(r.ok, false);
    assert.ok(/valid recipient/i.test(r.error));
  });

  await okAsync('a missing subject is refused', async () => {
    const r = await mailer.send({ to: 'ok@example.com' });
    assert.strictEqual(r.ok, false);
    assert.ok(/subject/i.test(r.error));
  });

  await okAsync('send() builds an HTML body when only text is given', async () => {
    const r = await mailer.send({ to: 'text@example.com', subject: 'Text only', text: 'plain <body>' });
    assert.strictEqual(r.ok, true);
    const html = fs.readFileSync(path.join(mailer.OUTBOX, r.id + '.html'), 'utf8');
    assert.ok(html.includes('&lt;body&gt;'), 'text must be escaped into the HTML part');
  });

  await okAsync('outbox() lists newest first and outboxMessage() reads one', async () => {
    const list = mailer.outbox(10);
    assert.ok(list.length >= 2);
    const times = list.map((m) => m.at);
    assert.deepStrictEqual(times, times.slice().sort().reverse());
    const one = mailer.outboxMessage(list[0].file);
    assert.ok(one && one.envelope && typeof one.html === 'string');
  });

  await okAsync('outboxMessage refuses path traversal', async () => {
    assert.strictEqual(mailer.outboxMessage('../../db'), null);
    assert.strictEqual(mailer.outboxMessage(''), null);
    assert.strictEqual(mailer.outboxMessage(null), null);
  });

  await okAsync('the outbox is capped at 200 messages', async () => {
    for (let i = 0; i < 210; i++) {
      await mailer.send({ to: `bulk${i}@example.com`, subject: 'Bulk ' + i, html: '<p>x</p>' });
    }
    const n = fs.readdirSync(mailer.OUTBOX).filter((f) => f.endsWith('.json')).length;
    assert.ok(n <= 200, `outbox should be capped, found ${n}`);
    assert.ok(n >= 190, `outbox should keep recent mail, found ${n}`);
  });

  console.log('\ntemplates');

  for (const name of ['verify', 'reset', 'invite', 'receipt', 'alert']) {
    ok(`template "${name}" renders a subject, HTML and text`, () => {
      const t = mailer.TEMPLATES[name]({
        username: 'ada', token: 'tok123', email: 'ada@example.com', botName: 'Shop line',
        inviter: 'grace', roleLabel: 'Agent', roleBlurb: 'You can send.', item: 'Starter',
        amount: 'USD 5', reference: 'REF1', botId: 'b1', state: 'down', detail: 'socket closed',
      });
      assert.ok(t.subject && t.subject.length > 5);
      assert.ok(t.html.includes('<!doctype html>'));
      assert.ok(t.text && t.text.length > 10);
      assert.ok(t.html.includes('Ladybug Cloud'));
    });
  }

  ok('verify and reset links point at their own pages with the token', () => {
    const v = mailer.TEMPLATES.verify({ username: 'a', token: 'abc' });
    const r = mailer.TEMPLATES.reset({ username: 'a', token: 'abc' });
    assert.ok(v.html.includes('/#/verify?token=abc'));
    assert.ok(r.html.includes('/#/reset?token=abc'));
    assert.ok(v.html.includes('24 hours'));
    assert.ok(r.html.includes('1 hour'));
  });

  ok('invite link goes to the join page and names the role', () => {
    const i = mailer.TEMPLATES.invite({ token: 'zzz', botName: 'Shop line', inviter: 'grace', roleLabel: 'Agent', roleBlurb: 'You can send.' });
    assert.ok(i.html.includes('/#/join?invite=zzz'));
    assert.ok(i.subject.includes('Shop line'));
    assert.ok(i.subject.includes('grace'));
    assert.ok(i.html.includes('Agent'));
  });

  ok('a template escapes user-supplied names', () => {
    const i = mailer.TEMPLATES.invite({ token: 't', botName: '<img src=x onerror=alert(1)>', inviter: '<b>x</b>', roleLabel: 'Viewer', roleBlurb: 'read' });
    assert.ok(!i.html.includes('<img src=x'));
    assert.ok(i.html.includes('&lt;img'));
  });

  console.log('\ntokens');

  const user = { id: 'u1', username: 'ada', email: 'ada@example.com' };

  ok('a verify token is issued, peeked and consumed once', () => {
    const rec = authmail.issue(user.id, 'verify');
    assert.ok(rec.token && rec.token.length === 64);
    assert.ok(rec.expiresAt > Date.now());
    assert.strictEqual(authmail.peek(rec.token, 'verify').token, rec.token);
    const c = authmail.consume(rec.token, 'verify');
    assert.strictEqual(c.ok, true);
    assert.strictEqual(c.userId, user.id);
    authmail.burn(c.rec);
    assert.strictEqual(authmail.consume(rec.token, 'verify').ok, false);
    assert.ok(/already been used/i.test(authmail.consume(rec.token, 'verify').error));
  });

  ok('a verify token cannot be used as a reset token', () => {
    const rec = authmail.issue(user.id, 'verify');
    assert.strictEqual(authmail.consume(rec.token, 'reset').ok, false);
    assert.strictEqual(authmail.peek(rec.token, 'reset'), null);
  });

  ok('issuing a new token of the same kind kills the previous one', () => {
    const a = authmail.issue(user.id, 'reset');
    const b = authmail.issue(user.id, 'reset');
    assert.notStrictEqual(a.token, b.token);
    assert.strictEqual(authmail.consume(a.token, 'reset').ok, false);
    assert.strictEqual(authmail.consume(b.token, 'reset').ok, true);
  });

  ok('an expired token is refused with a clear message', () => {
    const rec = authmail.issue(user.id, 'reset');
    rec.expiresAt = Date.now() - 1000;
    const r = authmail.consume(rec.token, 'reset');
    assert.strictEqual(r.ok, false);
    assert.ok(/expired/i.test(r.error));
  });

  ok('an unknown token is refused', () => {
    assert.strictEqual(authmail.consume('deadbeef', 'verify').ok, false);
    assert.strictEqual(authmail.consume('', 'verify').ok, false);
    assert.strictEqual(authmail.consume(null, 'verify').ok, false);
  });

  ok('sweep() drops long-dead tokens and keeps live ones', () => {
    const live = authmail.issue(user.id, 'verify');
    const dead = authmail.issue(user.id, 'verify');
    dead.expiresAt = Date.now() - 48 * 60 * 60 * 1000;
    dead.usedAt = null;
    authmail.sweep();
    const all = db.data.emailTokens;
    assert.ok(all.some((t) => t.token === live.token));
    assert.ok(!all.some((t) => t.token === dead.token));
  });

  await okAsync('an account with no email cannot be sent a link', async () => {
    const r = await authmail.sendVerify({ id: 'u2', username: 'nomail', email: null });
    assert.strictEqual(r.ok, false);
    assert.ok(/no usable email/i.test(r.error));
  });

  await okAsync('sendVerify and sendReset put a real message in the outbox', async () => {
    const v = await authmail.sendVerify(user);
    assert.strictEqual(v.ok, true);
    assert.ok(v.token);
    const r = await authmail.sendReset(user);
    assert.strictEqual(r.ok, true);
    const list = mailer.outbox(200);
    assert.ok(list.some((m) => m.template === 'verify' && m.to === 'ada@example.com'));
    assert.ok(list.some((m) => m.template === 'reset' && m.to === 'ada@example.com'));
  });

  await okAsync('sendInvite renders the role and the bot name', async () => {
    const r = await authmail.sendInvite({
      invite: { email: 'new@example.com', token: 'inv1', role: 'agent' },
      bot: { name: 'Shop line' },
      inviter: { username: 'grace' },
    });
    assert.strictEqual(r.ok, true);
    const m = mailer.outbox(5).find((x) => x.template === 'invite');
    assert.ok(m && m.subject.includes('Shop line'));
  });

  await okAsync('sendInvite refuses an invite with no address', async () => {
    const r = await authmail.sendInvite({ invite: { email: '' }, bot: { name: 'x' }, inviter: { username: 'y' } });
    assert.strictEqual(r.ok, false);
  });

  console.log('\nwiring');

  ok('app.js mounts every mail and auth-by-email route', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const routes = [
      "app.post('/api/auth/verify/resend'",
      "app.get('/api/auth/verify/:token'",
      "app.post('/api/auth/verify'",
      "app.post('/api/auth/forgot'",
      "app.get('/api/auth/reset/:token'",
      "app.post('/api/auth/reset'",
      "app.get('/api/mail/status'",
      "app.get('/api/mail/outbox'",
      "app.get('/api/mail/outbox/:file'",
      "app.post('/api/mail/test'",
    ];
    for (const r of routes) assert.ok(src.includes(r), `missing route ${r}`);
  });

  ok('registration sends a verification email and approval sends a receipt', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(/authmail\.sendVerify\(user/.test(src));
    assert.ok(/sendTemplate\('receipt'/.test(src));
  });

  ok('the invite route emails the invite but still returns the link on failure', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(/authmail\.sendInvite\(/.test(src));
    assert.ok(/emailed: !!sent\.ok/.test(src));
    assert.ok(/emailError: sent\.ok \? null/.test(src));
  });

  ok('the frontend has Mail, Verify and Reset pages wired into the router', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    assert.ok(js.includes("'/mail': renderMail"));
    assert.ok(js.includes("'/verify': renderVerify"));
    assert.ok(js.includes("'/reset': renderReset"));
    assert.ok(/async function renderMail\(\)/.test(js));
    assert.ok(/Forgot your password\?/.test(js));
  });

  console.log('\n  ' + pass + ' checks passed\n');
  fs.rmSync(dir, { recursive: true, force: true });
})();
