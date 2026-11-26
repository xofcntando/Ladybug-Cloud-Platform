/**
 * Team access — sharing a bot with other accounts.
 *
 * The point of this feature is that a bot can be used by more than the person
 * who created it, without handing over a password. These tests prove the parts
 * that matter:
 *
 *   1. an invite is bound to one email and cannot be redeemed by anyone else
 *   2. an invite is single use and expires
 *   3. roles rank correctly (viewer < agent < owner)
 *   4. a shared bot shows up in the member's bot list, and only for them
 *   5. the owner cannot be removed, and ownership can be transferred
 *   6. removing someone actually takes their access away
 *   7. a deleted account leaves no dangling member rows
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---- isolated data dir, set before the store loads ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-team-'));
process.env.DATA_DIR = dir;

const db = require('../lib/store');
const team = require('../lib/team');

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

/* ---- fixtures ---- */
const owner = { id: 'u_owner', username: 'ada', email: 'ada@example.com', passwordHash: 'x', plan: 'pro' };
const mate = { id: 'u_mate', username: 'grace', email: 'grace@example.com', passwordHash: 'x' };
const other = { id: 'u_other', username: 'linus', email: 'linus@example.com', passwordHash: 'x' };
const admin = { id: 'u_admin', username: 'root', email: 'root@example.com', passwordHash: 'x', isAdmin: true };
[owner, mate, other, admin].forEach((u) => db.addUser(u));

const bot = db.addBot({ id: 'b_1', userId: owner.id, name: 'Shop line', createdAt: new Date().toISOString() });

console.log('\nteam access');

/* 1. roles rank */
ok('roles rank viewer < agent < owner', () => {
  assert.ok(team.rank('viewer') < team.rank('agent'));
  assert.ok(team.rank('agent') < team.rank('owner'));
  assert.strictEqual(team.rank('nonsense'), 0);
});

ok('the creator is the owner and a stranger has no access', () => {
  assert.strictEqual(team.roleFor(bot, owner), 'owner');
  assert.strictEqual(team.roleFor(bot, mate), null);
  assert.strictEqual(team.can(bot, mate, 'viewer'), false);
});

ok('an admin can reach any bot', () => {
  assert.strictEqual(team.roleFor(bot, admin), 'owner');
});

/* 2. invites */
let inviteToken;
ok('an invite is created for an email and a role', () => {
  const r = team.invite(bot, owner, { email: 'Grace@Example.com', role: 'agent' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.invite.email, 'grace@example.com', 'email is normalised');
  assert.strictEqual(r.body.invite.role, 'agent');
  assert.ok(/^[a-f0-9]{36}$/.test(r.body.invite.link.split('invite=')[1]));
  inviteToken = r.body.invite.link.split('invite=')[1];
});

ok('a bad email is rejected', () => {
  assert.strictEqual(team.invite(bot, owner, { email: 'nope', role: 'agent' }).code, 400);
});

ok('you cannot invite someone as owner', () => {
  assert.strictEqual(team.invite(bot, owner, { email: 'x@y.com', role: 'owner' }).code, 400);
});

ok('inviting the owner is rejected', () => {
  assert.strictEqual(team.invite(bot, owner, { email: 'ada@example.com', role: 'agent' }).code, 400);
});

ok('re-inviting the same email refreshes instead of duplicating', () => {
  const before = team.listInvites(bot.id).length;
  const r = team.invite(bot, owner, { email: 'grace@example.com', role: 'viewer' });
  assert.strictEqual(r.body.refreshed, true);
  assert.strictEqual(team.listInvites(bot.id).length, before, 'no new row');
  assert.strictEqual(r.body.invite.role, 'viewer');
  // put it back to agent for the accept test
  inviteToken = r.body.invite.link.split('invite=')[1];
});

ok('a forwarded invite cannot be used by the wrong account', () => {
  const r = team.accept(other, inviteToken);
  assert.strictEqual(r.code, 403);
  assert.ok(/grace@example.com/.test(r.body.error));
  assert.strictEqual(team.roleFor(bot, other), null, 'and no access was granted');
});

ok('the right account can accept, and gets the invited role', () => {
  const r = team.accept(mate, inviteToken);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.role, 'viewer');
  assert.strictEqual(team.roleFor(bot, mate), 'viewer');
});

ok('an invite is single use', () => {
  const again = team.accept(mate, inviteToken);
  assert.strictEqual(again.code, 404);
});

ok('an expired invite is refused', () => {
  const r = team.invite(bot, owner, { email: 'linus@example.com', role: 'agent' });
  const tok = r.body.invite.link.split('invite=')[1];
  const rec = db.data.invites.find((i) => i.token === tok);
  rec.expiresAt = Date.now() - 1000;
  assert.strictEqual(team.accept(other, tok).code, 404);
});

/* 3. listing */
ok('a shared bot appears in the member list and nowhere else', () => {
  assert.deepStrictEqual(team.botsForUser(mate).map((b) => b.id), ['b_1']);
  assert.deepStrictEqual(team.botsForUser(other).map((b) => b.id), []);
  assert.deepStrictEqual(team.botsForUser(owner).map((b) => b.id), ['b_1']);
});

ok('the member list names the owner first', () => {
  const list = team.listMembers(bot);
  assert.strictEqual(list[0].userId, owner.id);
  assert.strictEqual(list[0].role, 'owner');
  assert.strictEqual(list[1].userId, mate.id);
  assert.ok(!('passwordHash' in list[0]), 'never leaks the hash');
});

ok('the summary tells the UI what to show', () => {
  const s = team.summary(bot, mate);
  assert.strictEqual(s.role, 'viewer');
  assert.strictEqual(s.canSend, false);
  assert.strictEqual(s.canManage, false);
  assert.strictEqual(s.isShared, true);
  assert.strictEqual(team.summary(bot, owner).canManage, true);
});

/* 4. role changes */
ok('the owner can promote a viewer to agent', () => {
  const r = team.setRole(bot, owner, mate.id, 'agent');
  assert.strictEqual(r.code, 200);
  assert.strictEqual(team.roleFor(bot, mate), 'agent');
  assert.strictEqual(team.can(bot, mate, 'agent'), true);
  assert.strictEqual(team.can(bot, mate, 'owner'), false);
});

ok('the owner role cannot be granted with setRole', () => {
  assert.strictEqual(team.setRole(bot, owner, mate.id, 'owner').code, 400);
});

ok('the owner cannot be demoted', () => {
  assert.strictEqual(team.setRole(bot, owner, owner.id, 'viewer').code, 400);
});

/* 5. transfer */
ok('ownership can be transferred and the old owner stays as an agent', () => {
  const r = team.transfer(bot, owner, mate.id);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(bot.userId, mate.id);
  assert.strictEqual(team.roleFor(bot, mate), 'owner');
  assert.strictEqual(team.roleFor(bot, owner), 'agent');
});

ok('transferring back works too', () => {
  assert.strictEqual(team.transfer(bot, mate, owner.id).code, 200);
  assert.strictEqual(bot.userId, owner.id);
  assert.strictEqual(team.roleFor(bot, mate), 'agent');
});

/* 6. removal */
ok('removing someone takes their access away immediately', () => {
  const r = team.remove(bot, owner, mate.id);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(team.roleFor(bot, mate), null);
  assert.deepStrictEqual(team.botsForUser(mate).map((b) => b.id), []);
});

ok('the owner cannot be removed', () => {
  assert.strictEqual(team.remove(bot, owner, owner.id).code, 400);
});

ok('removing someone who is not a member is a 404', () => {
  assert.strictEqual(team.remove(bot, owner, other.id).code, 404);
});

/* 7. cleanup */
ok('deleting an account leaves no dangling members', () => {
  const r = team.invite(bot, owner, { email: 'linus@example.com', role: 'agent' });
  const tok = r.body.invite.link.split('invite=')[1];
  assert.strictEqual(team.accept(other, tok).code, 200);
  assert.strictEqual(team.roleFor(bot, other), 'agent');
  team.purgeUser(other.id);
  assert.strictEqual(team.roleFor(bot, other), null);
  assert.ok(!db.data.invites.some((i) => i.acceptedBy === other.id));
});

ok('a revoked invite cannot be accepted', () => {
  const r = team.invite(bot, owner, { email: 'linus@example.com', role: 'viewer' });
  assert.strictEqual(team.revokeInvite(bot, r.body.invite.id).code, 200);
  const tok = r.body.invite.link.split('invite=')[1];
  assert.strictEqual(team.accept(other, tok).code, 404);
});

/* ---- route wiring, read straight from app.js ---- */
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

ok('every team route exists', () => {
  [
    "app.get('/api/bots/:id/team'",
    "app.post('/api/bots/:id/team/invite'",
    "app.delete('/api/bots/:id/team/invite/:inviteId'",
    "app.patch('/api/bots/:id/team/:userId'",
    "app.delete('/api/bots/:id/team/:userId'",
    "app.post('/api/bots/:id/team/transfer'",
    "app.post('/api/bots/:id/team/leave'",
    "app.get('/api/team/invites'",
    "app.post('/api/team/accept'",
    "app.get('/api/team/invite/:token'",
  ].forEach((r) => assert.ok(appSrc.includes(r), 'missing ' + r));
});

ok('ownBot understands roles and rejects below the required rank', () => {
  assert.ok(/function ownBot\(req, res, need\)/.test(appSrc));
  assert.ok(/team\.roleFor\(bot, req\.user\)/.test(appSrc));
  assert.ok(/team\.rank\(role\) < team\.rank\(want\)/.test(appSrc));
  assert.ok(/req\.botRole = role/.test(appSrc));
});

ok('sending requires agent and settings require owner', () => {
  // The handler body may sit on the next line, so match across newlines.
  const route = (method, path) =>
    new RegExp("app\\." + method + "\\('" + path.replace(/[/:]/g, '\\$&') + "'[\\s\\S]{0,400}?ownBot\\(req, res([^)]*)\\)");
  const send = route('post', '/api/bots/:id/web/send').exec(appSrc);
  const del = route('delete', '/api/bots/:id').exec(appSrc);
  const read = route('get', '/api/bots/:id/web/chats').exec(appSrc);
  assert.ok(send && /'agent'/.test(send[1]), 'send should need agent');
  assert.ok(del && /'owner'/.test(del[1]), 'delete should need owner');
  assert.ok(read && !/'(agent|owner)'/.test(read[1]), 'reading chats should only need viewer');
});

ok('the bot list uses team.botsForUser so shared bots show up', () => {
  assert.ok(/team\.botsForUser\(req\.user\)\.map\(\(b\) => botView\(b, req\.user\)\)/.test(appSrc));
});

ok('the frontend has the team panel and the join page', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(/async function openTeam\(bot\)/.test(js));
  assert.ok(/async function renderJoin\(\)/.test(js));
  assert.ok(js.includes("'/join': renderJoin"));
  assert.ok(/data-act="team"/.test(js));
  assert.ok(/data-act="leave"/.test(js));
});

console.log('\n  ' + pass + ' checks passed\n');
fs.rmSync(dir, { recursive: true, force: true });
