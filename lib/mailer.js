/**
 * Transactional email engine.
 *
 * One `send()` call, four HTTP providers behind it (Resend, SendGrid, Mailgun,
 * Postmark) and a file outbox so the whole product works — and is testable —
 * before anyone sets an API key.
 *
 * Configuration is entirely environmental, so nothing secret lives in the repo:
 *
 *   MAIL_PROVIDER   resend | sendgrid | mailgun | postmark | outbox
 *   MAIL_FROM       "Ladybug Cloud <no-reply@lbcloud.remotewire.net>"
 *   MAIL_REPLY_TO   support@lbcloud.remotewire.net
 *   MAIL_DOMAIN     lbcloud.remotewire.net
 *   APP_URL         https://lbcloud.remotewire.net
 *   RESEND_API_KEY / SENDGRID_API_KEY / MAILGUN_API_KEY + MAILGUN_DOMAIN / POSTMARK_TOKEN
 *   MAIL_TIMEOUT_MS 10000
 *
 * If MAIL_PROVIDER is unset we pick the first provider whose key exists. If no
 * key exists at all we fall back to the outbox, which writes each message to
 * DATA_DIR/outbox as a .json envelope plus a .html render. That keeps signup
 * verification, password resets, team invites and receipts fully exercisable in
 * development and in CI without a mail account.
 *
 * `send()` never throws. It resolves { ok, id, provider, error, logged } so
 * callers can fire-and-forget without wrapping everything in try/catch.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OUTBOX = path.join(DATA_DIR, 'outbox');
const MAX_OUTBOX = 200;

const cfg = {
  provider: (process.env.MAIL_PROVIDER || '').trim().toLowerCase(),
  from: process.env.MAIL_FROM || 'Ladybug Cloud <no-reply@lbcloud.remotewire.net>',
  replyTo: process.env.MAIL_REPLY_TO || '',
  domain: process.env.MAIL_DOMAIN || 'lbcloud.remotewire.net',
  appUrl: (process.env.APP_URL || 'https://lbcloud.remotewire.net').replace(/\/+$/, ''),
  timeout: Number(process.env.MAIL_TIMEOUT_MS || 10000),
  keys: {
    resend: process.env.RESEND_API_KEY || '',
    sendgrid: process.env.SENDGRID_API_KEY || '',
    mailgun: process.env.MAILGUN_API_KEY || '',
    postmark: process.env.POSTMARK_TOKEN || '',
  },
  mailgunDomain: process.env.MAILGUN_DOMAIN || '',
};

const PROVIDERS = ['resend', 'sendgrid', 'mailgun', 'postmark'];

/** Which provider will actually be used. Always returns a name. */
function provider() {
  if (cfg.provider === 'outbox') return 'outbox';
  if (PROVIDERS.includes(cfg.provider) && cfg.keys[cfg.provider]) return cfg.provider;
  const auto = PROVIDERS.find((p) => cfg.keys[p]);
  return auto || 'outbox';
}

/** True when real mail will leave the building. */
function enabled() {
  return provider() !== 'outbox';
}

/** Safe-to-expose description of the current mail setup. */
function status() {
  const p = provider();
  return {
    provider: p,
    live: p !== 'outbox',
    from: cfg.from,
    replyTo: cfg.replyTo || null,
    domain: cfg.domain,
    appUrl: cfg.appUrl,
    configured: PROVIDERS.filter((x) => !!cfg.keys[x]),
    hint: p === 'outbox'
      ? 'No provider key is set, so mail is written to the local outbox instead of being delivered. Set RESEND_API_KEY (or SENDGRID_API_KEY / MAILGUN_API_KEY / POSTMARK_TOKEN) to go live.'
      : null,
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shared shell every message uses: dark, branded, inline styles only (mail
 * clients strip <style> blocks), 600px wide, readable on a phone.
 */
function layout({ title, preheader, body, cta, footer }) {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title || 'Ladybug Cloud')}</title></head>
<body style="margin:0;padding:0;background:#0b0f14;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
<div style="background:#0b0f14;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#121821;border:1px solid #1f2937;border-radius:14px;overflow:hidden;">
    <div style="padding:22px 28px;border-bottom:1px solid #1f2937;">
      <span style="display:inline-block;width:26px;height:26px;border-radius:8px;background:#f97316;vertical-align:middle;"></span>
      <span style="color:#f8fafc;font-size:17px;font-weight:700;letter-spacing:-.2px;vertical-align:middle;margin-left:10px;">Ladybug Cloud</span>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 16px;color:#f8fafc;font-size:21px;line-height:1.3;font-weight:700;">${escapeHtml(title || '')}</h1>
      <div style="color:#cbd5e1;font-size:15px;line-height:1.65;">${body || ''}</div>
      ${cta ? `<div style="margin:26px 0 6px;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#f97316;color:#0b0f14;font-weight:700;font-size:15px;text-decoration:none;padding:13px 22px;border-radius:10px;">${escapeHtml(cta.label)}</a></div>
      <div style="color:#64748b;font-size:12px;line-height:1.6;word-break:break-all;margin-top:14px;">If the button does not work, paste this link into your browser:<br>${escapeHtml(cta.url)}</div>` : ''}
    </div>
    <div style="padding:18px 28px;border-top:1px solid #1f2937;color:#64748b;font-size:12px;line-height:1.6;">
      ${footer ? escapeHtml(footer) + '<br>' : ''}
      Ladybug Cloud &middot; ${escapeHtml(cfg.domain)} &middot; &copy; ${year}
    </div>
  </div>
  <div style="max-width:600px;margin:14px auto 0;text-align:center;color:#475569;font-size:11px;">
    You are receiving this because you have a Ladybug Cloud account.
  </div>
</div></body></html>`;
}

const p = (t) => `<p style="margin:0 0 14px;">${t}</p>`;
const btn = (label, url) => ({ label, url });

/**
 * Every message the product sends. Each entry returns { subject, html, text }.
 * Keeping them here means copy changes never touch route code.
 */
const TEMPLATES = {
  verify: (d) => ({
    subject: 'Confirm your email for Ladybug Cloud',
    html: layout({
      title: 'Confirm your email',
      preheader: 'One click and your Ladybug Cloud account is ready.',
      body: p(`Hi ${escapeHtml(d.username || 'there')},`) +
        p('Welcome to Ladybug Cloud. Confirm this address so we can send you receipts, crash alerts and team invites.') +
        p('<span style="color:#94a3b8;font-size:13px;">This link expires in 24 hours.</span>'),
      cta: btn('Confirm email', `${cfg.appUrl}/#/verify?token=${encodeURIComponent(d.token || '')}`),
      footer: 'If you did not create an account, you can ignore this message.',
    }),
    text: `Hi ${d.username || 'there'},\n\nConfirm your email for Ladybug Cloud (expires in 24 hours):\n${cfg.appUrl}/#/verify?token=${encodeURIComponent(d.token || '')}\n\nIf you did not create an account, ignore this message.`,
  }),

  reset: (d) => ({
    subject: 'Reset your Ladybug Cloud password',
    html: layout({
      title: 'Reset your password',
      preheader: 'Choose a new password for your account.',
      body: p(`Hi ${escapeHtml(d.username || 'there')},`) +
        p('Someone asked to reset the password on your Ladybug Cloud account. If that was you, use the button below.') +
        p('<span style="color:#94a3b8;font-size:13px;">This link expires in 1 hour and can only be used once. Your current password keeps working until you set a new one.</span>'),
      cta: btn('Choose a new password', `${cfg.appUrl}/#/reset?token=${encodeURIComponent(d.token || '')}`),
      footer: 'Did not request this? Your account is safe — just ignore this email.',
    }),
    text: `Hi ${d.username || 'there'},\n\nReset your Ladybug Cloud password (expires in 1 hour, single use):\n${cfg.appUrl}/#/reset?token=${encodeURIComponent(d.token || '')}\n\nDid not request this? Ignore this email.`,
  }),

  invite: (d) => {
    const roleLabel = d.roleLabel || 'Viewer';
    const blurb = d.roleBlurb || 'You can read chats and see the dashboard.';
    return {
      subject: `${d.inviter || 'Someone'} invited you to ${d.botName || 'a WhatsApp bot'} on Ladybug Cloud`,
      html: layout({
        title: `You have been invited to ${d.botName || 'a bot'}`,
        preheader: `${d.inviter || 'A teammate'} gave you ${roleLabel} access.`,
        body: p(`<strong style="color:#f8fafc;">${escapeHtml(d.inviter || 'A teammate')}</strong> invited you to help run <strong style="color:#f8fafc;">${escapeHtml(d.botName || 'a WhatsApp bot')}</strong> on Ladybug Cloud.`) +
          `<div style="background:#0b0f14;border:1px solid #1f2937;border-radius:10px;padding:16px;margin:0 0 16px;">
             <div style="color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Your access</div>
             <div style="color:#f8fafc;font-size:16px;font-weight:700;margin-bottom:4px;">${escapeHtml(roleLabel)}</div>
             <div style="color:#cbd5e1;font-size:14px;">${escapeHtml(blurb)}</div>
           </div>` +
          p('<span style="color:#94a3b8;font-size:13px;">This invite expires in 7 days and only works for this email address.</span>'),
        cta: btn('Accept invite', `${cfg.appUrl}/#/join?invite=${encodeURIComponent(d.token || '')}`),
        footer: `Sent to ${d.email || 'you'}. If this was not meant for you, ignore it.`,
      }),
      text: `${d.inviter || 'A teammate'} invited you to ${d.botName || 'a bot'} on Ladybug Cloud as ${roleLabel}.\n${blurb}\n\nAccept (expires in 7 days, this email only):\n${cfg.appUrl}/#/join?invite=${encodeURIComponent(d.token || '')}`,
    };
  },

  receipt: (d) => ({
    subject: `Your Ladybug Cloud receipt — ${d.amount || ''}`,
    html: layout({
      title: 'Payment received',
      preheader: `${d.amount || ''} for ${d.item || 'your order'}.`,
      body: p(`Thanks ${escapeHtml(d.username || '')} — your payment went through.`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#0b0f14;border:1px solid #1f2937;border-radius:10px;margin:0 0 16px;">
          <tr><td style="padding:14px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #1f2937;">Item</td><td style="padding:14px 16px;color:#f8fafc;font-size:14px;text-align:right;border-bottom:1px solid #1f2937;">${escapeHtml(d.item || '')}</td></tr>
          <tr><td style="padding:14px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #1f2937;">Amount</td><td style="padding:14px 16px;color:#f8fafc;font-size:14px;text-align:right;border-bottom:1px solid #1f2937;">${escapeHtml(d.amount || '')}</td></tr>
          <tr><td style="padding:14px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #1f2937;">Reference</td><td style="padding:14px 16px;color:#cbd5e1;font-size:13px;text-align:right;border-bottom:1px solid #1f2937;">${escapeHtml(d.reference || '')}</td></tr>
          <tr><td style="padding:14px 16px;color:#94a3b8;font-size:13px;">Date</td><td style="padding:14px 16px;color:#cbd5e1;font-size:13px;text-align:right;">${escapeHtml(d.date || new Date().toISOString().slice(0, 10))}</td></tr>
        </table>` +
        p('Your balance and invoices are always available under Billing.'),
      cta: btn('Open billing', `${cfg.appUrl}/#/billing`),
      footer: 'Keep this email for your records.',
    }),
    text: `Payment received\n\nItem: ${d.item || ''}\nAmount: ${d.amount || ''}\nReference: ${d.reference || ''}\nDate: ${d.date || new Date().toISOString().slice(0, 10)}\n\nBilling: ${cfg.appUrl}/#/billing`,
  }),

  alert: (d) => ({
    subject: `${d.botName || 'Your bot'} ${d.state === 'down' ? 'went offline' : 'is back online'}`,
    html: layout({
      title: d.state === 'down' ? 'Your bot went offline' : 'Your bot is back online',
      preheader: d.detail || '',
      body: p(`<strong style="color:#f8fafc;">${escapeHtml(d.botName || 'Your bot')}</strong> ${d.state === 'down' ? 'stopped responding' : 'reconnected successfully'}.`) +
        (d.detail ? `<div style="background:#0b0f14;border:1px solid #1f2937;border-left:3px solid ${d.state === 'down' ? '#ef4444' : '#22c55e'};border-radius:8px;padding:14px 16px;color:#cbd5e1;font-size:14px;margin:0 0 16px;">${escapeHtml(d.detail)}</div>` : '') +
        p('<span style="color:#94a3b8;font-size:13px;">Alerts are rate limited to one per bot per minute.</span>'),
      cta: btn('Open dashboard', `${cfg.appUrl}/#/bots/${encodeURIComponent(d.botId || '')}`),
      footer: 'Turn these off any time in the bot’s Alerts settings.',
    }),
    text: `${d.botName || 'Your bot'} ${d.state === 'down' ? 'went offline' : 'is back online'}.\n${d.detail || ''}\n\n${cfg.appUrl}/#/bots/${d.botId || ''}`,
  }),
};

function validEmail(addr) {
  if (typeof addr !== 'string') return false;
  const s = addr.trim();
  if (s.length < 6 || s.length > 254) return false;
  if (s !== addr || /\s/.test(s)) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!/^[A-Za-z]{2,}$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => l.length > 0 && l.length <= 63 && /^[A-Za-z0-9-]+$/.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  if (m && validEmail(m[2])) return { name: m[1].replace(/^"|"$/g, ''), email: m[2].trim() };
  return { name: '', email: String(from || '').trim() };
}

async function postJson(url, headers, payload) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.timeout);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 400) }; }
    if (!r.ok) {
      const msg = (body && (body.message || body.error || (body.errors && body.errors[0] && body.errors[0].message))) || `HTTP ${r.status}`;
      return { ok: false, error: String(msg).slice(0, 300), body };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Timed out after ${cfg.timeout}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Deliver through one provider. Returns { ok, id?, error? }. */
async function deliver(prov, msg) {
  const from = parseFrom(msg.from || cfg.from);
  const replyTo = msg.replyTo || cfg.replyTo || undefined;

  if (prov === 'resend') {
    const r = await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${cfg.keys.resend}` }, {
      from: msg.from || cfg.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    return r.ok ? { ok: true, id: r.body && r.body.id } : { ok: false, error: r.error };
  }

  if (prov === 'sendgrid') {
    const r = await postJson('https://api.sendgrid.com/v3/mail/send', { Authorization: `Bearer ${cfg.keys.sendgrid}` }, {
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      subject: msg.subject,
      content: [
        { type: 'text/plain', value: msg.text || '' },
        { type: 'text/html', value: msg.html || '' },
      ],
    });
    return r.ok ? { ok: true, id: (r.body && r.body.id) || null } : { ok: false, error: r.error };
  }

  if (prov === 'mailgun') {
    const domain = cfg.mailgunDomain || cfg.domain;
    const auth = Buffer.from(`api:${cfg.keys.mailgun}`).toString('base64');
    const r = await postJson(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, { Authorization: `Basic ${auth}` }, {
      from: msg.from || cfg.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(replyTo ? { 'h:Reply-To': replyTo } : {}),
    });
    return r.ok ? { ok: true, id: (r.body && r.body.id) || null } : { ok: false, error: r.error };
  }

  if (prov === 'postmark') {
    const r = await postJson('https://api.postmarkapp.com/email', {
      'X-Postmark-Server-Token': cfg.keys.postmark,
      Accept: 'application/json',
    }, {
      From: msg.from || cfg.from,
      To: msg.to,
      Subject: msg.subject,
      HtmlBody: msg.html,
      TextBody: msg.text,
      ...(replyTo ? { ReplyTo: replyTo } : {}),
      MessageStream: 'outbound',
    });
    return r.ok ? { ok: true, id: (r.body && r.body.MessageID) || null } : { ok: false, error: r.error };
  }

  return { ok: false, error: `Unknown provider ${prov}` };
}

/** Write a message to DATA_DIR/outbox and prune old ones. */
function writeOutbox(msg) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // A short random suffix keeps two messages to the same address in the same
  // millisecond from overwriting each other.
  const uniq = require('crypto').randomBytes(3).toString('hex');
  const base = `${stamp}-${String(msg.to).replace(/[^a-z0-9]/gi, '_').slice(0, 40)}-${uniq}`;
  const envelope = {
    to: msg.to,
    from: msg.from || cfg.from,
    subject: msg.subject,
    template: msg.template || null,
    at: new Date().toISOString(),
    text: msg.text || '',
  };
  fs.writeFileSync(path.join(OUTBOX, `${base}.json`), JSON.stringify(envelope, null, 2));
  fs.writeFileSync(path.join(OUTBOX, `${base}.html`), msg.html || '');
  pruneOutbox();
  return base;
}

function pruneOutbox() {
  try {
    const files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).sort();
    const extra = files.length - MAX_OUTBOX;
    if (extra <= 0) return;
    for (const f of files.slice(0, extra)) {
      const base = f.replace(/\.json$/, '');
      for (const ext of ['.json', '.html']) {
        try { fs.unlinkSync(path.join(OUTBOX, base + ext)); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Most recent outbox messages, newest first. */
function outbox(limit) {
  const n = Math.max(1, Math.min(Number(limit) || 25, MAX_OUTBOX));
  try {
    return fs.readdirSync(OUTBOX)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, n)
      .map((f) => {
        const base = f.replace(/\.json$/, '');
        try {
          const env = JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8'));
          env.file = base;
          env.hasHtml = fs.existsSync(path.join(OUTBOX, base + '.html'));
          return env;
        } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function outboxMessage(base) {
  const safe = String(base || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) return null;
  const j = path.join(OUTBOX, `${safe}.json`);
  const h = path.join(OUTBOX, `${safe}.html`);
  if (!fs.existsSync(j)) return null;
  try {
    return { envelope: JSON.parse(fs.readFileSync(j, 'utf8')), html: fs.existsSync(h) ? fs.readFileSync(h, 'utf8') : '' };
  } catch (_) {
    return null;
  }
}

/**
 * Send one message. Never throws.
 * @returns {Promise<{ok:boolean,id?:string,provider:string,error?:string,logged?:boolean}>}
 */
async function send(msg) {
  const prov = provider();
  const to = String((msg && msg.to) || '').trim();
  if (!validEmail(to)) return { ok: false, provider: prov, error: 'A valid recipient address is required' };
  if (!msg.subject) return { ok: false, provider: prov, error: 'A subject is required' };

  const full = {
    to,
    from: msg.from || cfg.from,
    replyTo: msg.replyTo || cfg.replyTo,
    subject: String(msg.subject).slice(0, 240),
    html: msg.html || layout({ title: msg.subject, body: `<p>${escapeHtml(msg.text || '')}</p>` }),
    text: msg.text || '',
    template: msg.template || null,
  };

  if (prov === 'outbox') {
    try {
      const base = writeOutbox(full);
      return { ok: true, provider: 'outbox', id: base, logged: true };
    } catch (e) {
      return { ok: false, provider: 'outbox', error: e.message };
    }
  }

  const r = await deliver(prov, full);
  if (r.ok) return { ok: true, provider: prov, id: r.id || null };
  // A failed live send still gets archived so the message is not lost.
  let logged = false;
  try { writeOutbox(Object.assign({}, full, { failed: r.error })); logged = true; } catch (_) {}
  return { ok: false, provider: prov, error: r.error, logged };
}

/** Render a named template and send it. Never throws. */
async function sendTemplate(name, to, data) {
  const tpl = TEMPLATES[name];
  if (!tpl) return { ok: false, provider: provider(), error: `Unknown template "${name}"` };
  const built = tpl(data || {});
  return send(Object.assign({ to, template: name }, built));
}

module.exports = {
  cfg,
  enabled,
  provider,
  status,
  send,
  sendTemplate,
  outbox,
  outboxMessage,
  layout,
  escapeHtml,
  validEmail,
  TEMPLATES,
  OUTBOX,
};
