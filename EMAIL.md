# Email on Ladybug Cloud

Two separate things live under "email" here, and they are wired differently:

1. **Transactional email** — the product sending *out*: sign-up confirmation,
   password resets, team invites, payment receipts, crash alerts. This is built
   into the app (`lib/mailer.js`, `lib/authmail.js`) and needs one API key.
2. **Real mailboxes** — `you@lbcloud.remotewire.net` addresses that people can
   log into and read. That is a mail *host*, not app code. This document gives
   the exact DNS records and the hosting options.

---

## 1. Transactional email

### How it behaves today

With no configuration at all, every message is written to a **file outbox** at
`DATA_DIR/outbox` (a `.json` envelope plus a `.html` render, newest 200 kept).
Nothing is delivered, but every flow works end to end — registration, resets,
invites and receipts all produce a real message you can open from the Mail page.
That is deliberate: a fresh clone should not need a mail account to be testable.

Set one key and delivery goes live. No code change.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIL_PROVIDER` | auto | `resend`, `sendgrid`, `mailgun`, `postmark`, or `outbox` to force the file outbox |
| `MAIL_FROM` | `Ladybug Cloud <no-reply@lbcloud.remotewire.net>` | The From header. Must be on a domain you have verified with the provider |
| `MAIL_REPLY_TO` | unset | Where replies go, e.g. `support@lbcloud.remotewire.net` |
| `MAIL_DOMAIN` | `lbcloud.remotewire.net` | Used for Mailgun and for the footer |
| `APP_URL` | `https://lbcloud.remotewire.net` | Base for every link in every email |
| `RESEND_API_KEY` | unset | Resend |
| `SENDGRID_API_KEY` | unset | SendGrid |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` | unset | Mailgun |
| `POSTMARK_TOKEN` | unset | Postmark |
| `MAIL_TIMEOUT_MS` | `10000` | Per-request timeout |

If `MAIL_PROVIDER` is unset the first provider with a key wins, in the order
Resend → SendGrid → Mailgun → Postmark. If none has a key, the outbox is used.

### Going live with Resend (shortest path)

1. Create a Resend account and add `remotewire.net` as a domain.
2. Resend shows you DNS records. Add them at whoever runs `remotewire.net`
   (Cloudflare, in this setup) — see the DNS section below, the records are the
   same shape for every provider.
3. Wait for Resend to show the domain as **Verified**.
4. In Render → your service → Environment, add:
   - `RESEND_API_KEY` = `re_...`
   - `MAIL_FROM` = `Ladybug Cloud <no-reply@lbcloud.remotewire.net>`
   - `MAIL_REPLY_TO` = `support@lbcloud.remotewire.net`
   - `APP_URL` = `https://lbcloud.remotewire.net`
5. Redeploy. Open **Mail** in the app: Delivery should read `resend`, not
   "Local outbox". Press **Send me a test**.

Mailgun and Postmark differ only in which variables you set; SendGrid the same.

### What sends what

| Trigger | Template | Where |
| --- | --- | --- |
| Sign-up with an email address | `verify` (24h link) | `POST /api/auth/register` |
| "Confirm my email" on the Mail page | `verify` | `POST /api/auth/verify/resend` |
| "Forgot your password?" on the login page | `reset` (1h link, single use) | `POST /api/auth/forgot` |
| Owner invites someone to a bot | `invite` (7 days, bound to that address) | `POST /api/bots/:id/team/invite` |
| Admin approves a payment | `receipt` | `POST /api/admin/payment-requests/:id/approve` |
| Bot crashes or comes back online | `alert` | `lib/alerts.js` → `notify()` |

Crash alerts go out by email to any account with a **verified** address, in
addition to the webhook (the webhook is the paid Alerts feature; email is free so
people without a Discord server still hear about a crash). Both paths are rate
limited to one alert per bot per event per minute.

### Routes

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/verify/resend` | signed in, 8 per 15 min |
| `GET` | `/api/auth/verify/:token` | preview, does not consume |
| `POST` | `/api/auth/verify` | consumes the token, sets `emailVerifiedAt` |
| `POST` | `/api/auth/forgot` | always answers the same, whether or not the address exists |
| `GET` | `/api/auth/reset/:token` | preview |
| `POST` | `/api/auth/reset` | sets the new password, burns the token |
| `GET` | `/api/mail/status` | provider, From, your verification state |
| `GET` | `/api/mail/outbox` | your own messages (admins see all) |
| `GET` | `/api/mail/outbox/:file` | one message, ownership checked |
| `POST` | `/api/mail/test` | send yourself a test; non-admins can only target their own address |

### Security notes

- Tokens are 32 random bytes, single use, scoped to `verify` or `reset` so a
  verification link can never be replayed as a password reset, and minting a new
  token invalidates the previous one of the same kind.
- `/api/auth/forgot` returns an identical response for unknown addresses, so it
  cannot be used to enumerate accounts.
- `/api/auth/reset` burns the token only after the new password is accepted, so a
  too-short password does not force a new link.
- Every template escapes user-supplied values (bot names, usernames) before they
  reach the HTML part.
- `send()` never throws; it resolves `{ ok, id, provider, error, logged }`. A
  failed live send is still archived to the outbox so nothing is silently lost.
- The outbox filename is sanitised and `outboxMessage()` strips path characters,
  so `../` cannot escape the directory.

---

## 2. Real mailboxes (`@lbcloud.remotewire.net`)

Transactional email is one-way. If you want actual inboxes — people signing in
to read mail at `name@lbcloud.remotewire.net` — you need a mail host. The app
does not store mailboxes; it links out to whichever host you pick.

### Pick a host

| Host | Free tier | Per mailbox | Notes |
| --- | --- | --- | --- |
| **Zoho Mail** | 5 users, 5 GB each, custom domain | paid beyond 5 | Easiest free option, web + IMAP + SMTP |
| **Migadu** | no free tier | ~$19/yr for unlimited mailboxes on one domain | Cheapest if you want many addresses |
| **Google Workspace** | none | ~$7/user/mo | Best calendar/drive integration |
| **Microsoft 365** | none | ~$6/user/mo | If you live in Outlook |
| **Mailcow / Mailu** (self-hosted) | free software | VPS cost | Full control, you own deliverability |

For a small team, Zoho's free tier is the pragmatic answer. For a lot of
addresses on a small budget, Migadu.

### DNS records — `remotewire.net` at Cloudflare

Your transactional provider and your mailbox host both want DNS records on the
same domain. They do not conflict as long as the **MX** points at the mailbox
host and the **SPF** record includes both senders.

**MX** (receives mail for the mailboxes) — set these to whatever your host
prints, e.g. Zoho:

| Type | Name | Priority | Value |
| --- | --- | --- | --- |
| MX | `@` | 10 | `mx.zoho.com` |
| MX | `@` | 20 | `mx2.zoho.com` |
| MX | `@` | 50 | `mx3.zoho.com` |

**SPF** — one record only, and it must list every service that sends as you:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `@` | `v=spf1 include:zoho.com include:_spf.resend.com ~all` |

Swap `_spf.resend.com` for your transactional provider (`sendgrid.net`,
`mailgun.org`, `spf.mtasv.net` for Postmark). Two SPF records on one name is a
hard fail — merge them into one.

**DKIM** — one CNAME/TXT per sender, values come from the provider dashboard:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `zoho._domainkey` | (from Zoho) |
| TXT | `resend._domainkey` | (from Resend) |

**DMARC** — start in monitor mode, tighten later:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@lbcloud.remotewire.net; adkim=r; aspf=r` |

Once a week of reports shows clean traffic, move to `p=quarantine`, then
`p=reject`.

**Cloudflare specifics**

- Set the MX records to **DNS only** (grey cloud). Cloudflare cannot proxy MX.
- If you add a `mail` hostname for webmail, also grey-cloud it, or use the
  host's own webmail URL.
- Do not add a wildcard MX.

### Subdomain option (cleaner separation)

If you would rather keep product mail and human mail apart:

- `no-reply@mail.remotewire.net` for transactional (verify the `mail` subdomain
  with Resend), and
- `you@remotewire.net` for real inboxes.

Then set `MAIL_FROM="Ladybug Cloud <no-reply@mail.remotewire.net>"` and add the
`mail` subdomain's SPF/DKIM separately. This keeps a mailbox host migration from
touching your product mail.

### Linking it from the app

Once a host is live, point people at it from the Mail page or a support page.
There is nothing to configure in code — the Mail page describes outbound
delivery, and the host's own URL is where people read mail.

---

## 3. Tests

`test/mail.test.js` (34 checks) runs with **no provider key**, which is the
state of a fresh clone:

- provider auto-detection and the outbox fallback
- address validation (rejects `a@b..com`, header injection, trailing spaces)
- `send()` never throws; bad recipient and missing subject are refused cleanly
- the outbox writes an envelope plus an HTML render, lists newest first, refuses
  path traversal, and is capped at 200 messages
- all five templates render a subject, HTML and text, with links to the right
  page, and escape user-supplied names
- verify/reset tokens: single use, kind-scoped, expired, newest-wins, swept
- the app mounts every route and the frontend has the Mail, Verify and Reset
  pages wired into the router

Run it with `node test/mail.test.js`, or the whole suite with `npm test`.
