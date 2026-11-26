# Team Access

Share a WhatsApp bot with other people without handing over your password.

Before this, a bot belonged to exactly one account (`bot.userId`). The only way to
let someone else work the chats was to give them your login. Team Access adds a
small role system on top of the existing ownership model, so a shop owner can let
staff answer messages while keeping control of the session and the settings.

## Roles

| Role | Can do | Cannot do |
| --- | --- | --- |
| **Owner** | Everything: settings, session, start/stop, delete, team management | — |
| **Agent** | Read chats, send messages and media, labels, notes, follow-ups, scheduled sends, translate, groups | Change bot settings, edit the session, block/privacy, delete the bot, manage the team |
| **Viewer** | Read chats, contacts, media, analytics, digest | Send anything, or change any state |

The creator of a bot is the owner. Admins are treated as owners so support can
still get in.

Roles rank `viewer (1) < agent (2) < owner (3)`, and every route declares the
minimum it needs:

```js
ownBot(req, res, 'owner')   // settings, session, delete, team
ownBot(req, res, 'agent')   // send, read receipts, notes, labels
ownBot(req, res)            // viewer: reading chats, media, analytics
```

`ownBot()` resolves the caller's role, returns `403` with `{ role, need }` when it
is too low, and leaves the resolved role on `req.botRole`.

## Inviting someone

1. Open a bot card on the dashboard and press **Team**.
2. Enter their email and pick **Agent** or **Viewer**.
3. Copy the invite link and send it to them yourself. We do not send email.

The invite is a one-time token stored in `db.data.invites`:

- **Bound to one address.** A forwarded link is refused with "This invite was sent
  to …" — only an account with that email can redeem it.
- **Single use.** Redeeming sets `acceptedAt`; a second attempt is a `404`.
- **Expires after 7 days.**
- **Re-inviting the same email refreshes** the existing invite instead of piling up
  duplicates, so a lost link is easy to replace.

The invitee opens `/#/join?invite=<token>`. That page works signed out — it shows
the bot name, who invited them, the role and the expiry before asking them to sign
in, so the link is not a mystery.

## Managing a bot

Owners can, from the Team panel:

- change someone between Agent and Viewer
- **Make owner** — transfers the bot; the previous owner stays on as an Agent so
  they do not lose access by accident
- remove someone, which takes their access away immediately
- cancel a pending invite

Agents and viewers see the member list read-only. A shared bot shows a role chip
and a "N people" chip on the dashboard card, and non-owners get a **Leave** button
instead of Edit/Delete.

## API

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/api/bots/:id/team` | viewer |
| `POST` | `/api/bots/:id/team/invite` | owner |
| `DELETE` | `/api/bots/:id/team/invite/:inviteId` | owner |
| `PATCH` | `/api/bots/:id/team/:userId` | owner |
| `DELETE` | `/api/bots/:id/team/:userId` | owner |
| `POST` | `/api/bots/:id/team/transfer` | owner |
| `POST` | `/api/bots/:id/team/leave` | any member |
| `GET` | `/api/team/invites` | signed in |
| `POST` | `/api/team/accept` | signed in |
| `GET` | `/api/team/invite/:token` | public |

`GET /api/bots` now returns bots you own **and** bots shared with you, each with a
`role` and a `team` summary (`canSend`, `canManage`, `count`, `pending`), plus a
top-level `sharedCount`.

## Storage

- `bot.members[]` — `{ userId, role, addedAt, addedBy }`
- `db.data.invites[]` — `{ id, token, botId, email, role, invitedBy, createdAt, expiresAt, acceptedAt, acceptedBy, revokedAt }`

Both live in the existing JSON store, so they are mirrored to MongoDB by
`lib/mongo-sync.js` along with everything else. Deleting an account calls
`team.purgeUser()` so no dangling member rows are left behind.

## Activity

Every join, role change, removal and transfer writes to the existing Activity
Timeline under the `security` type — for both the owner and the affected person.

## Tests

`test/team.test.js` — 30 checks: role ranking, invite binding/single-use/expiry,
shared-bot visibility, promotion and demotion, ownership transfer, removal,
account cleanup, and that every route declares the right minimum role.

Run with `npm test`.
