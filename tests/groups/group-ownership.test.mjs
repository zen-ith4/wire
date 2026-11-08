// Group ownership & roles: kick rules, owner-only role endpoints, ownership
// transfer, auto-succession (leave / account deletion), group delete, and the
// groups.created_by migration. Real temp SQLite database, real controllers and
// services, real Socket.IO server (its emits are recorded, not delivered).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-group-owner-'));
const GROUP_DIR = path.join(tmp, 'group');
fs.mkdirSync(GROUP_DIR, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  GROUPS_ENABLED: 'true',
  DB_PATH: path.join(tmp, 'test.db'),
  USER_DATA_ROOT: path.join(tmp, 'user-data'),
  CHAT_UPLOAD_DIR: path.join(tmp, 'chat'),
  DM_UPLOAD_DIR: path.join(tmp, 'dm'),
  AVATAR_DIR: path.join(tmp, 'avatars'),
  BANNER_DIR: path.join(tmp, 'banners'),
  GROUP_UPLOAD_DIR: GROUP_DIR,
});
delete process.env.JWT_SECRET;

const { initDatabase, getDb } = require(path.join(ROOT, 'config', 'database.js'));
const { setupSocketIO } = require(path.join(ROOT, 'config', 'socket.js'));
const groupsController = require(path.join(ROOT, 'controllers', 'groups.controller.js'));
const adminController = require(path.join(ROOT, 'controllers', 'admin.controller.js'));
const { ensureSchema } = require(path.join(ROOT, 'database', 'schema.js'));
const { hashPassword } = require(path.join(ROOT, 'utils', 'password.js'));
const { deriveCredentialsNode, newKdfSalt, KDF_ITERATIONS } = require(path.join(ROOT, 'utils', 'credentials.js'));

const {
  removeMemberHandler,
  leaveGroupHandler,
  promoteAdminHandler,
  demoteAdminHandler,
  transferOwnershipHandler,
  deleteGroupHandler,
} = groupsController;

const HASH = 'x'.repeat(60);
const KDF_SALT = Buffer.alloc(16, 1).toString('base64');

let httpServer;
let io;
let emitted = [];
let userCounter = 0;
// The site has exactly ONE admin (unique index idx_users_one_admin), so it is
// created once here. Admin-only endpoints that need a password get a real one.
let siteAdmin;
let siteAdminAuthKey;

before(async () => {
  initDatabase();

  const adminSalt = newKdfSalt();
  siteAdminAuthKey = deriveCredentialsNode('site-admin-password-1', adminSalt, KDF_ITERATIONS).authKey;
  siteAdmin = Number(getDb().prepare(`
    INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, email_verified)
    VALUES ('own_site_admin', 'own_site_admin@example.test', ?, 2, ?, ?, 1, 1, 1)
  `).run(await hashPassword(siteAdminAuthKey), adminSalt, KDF_ITERATIONS).lastInsertRowid);

  httpServer = http.createServer();
  io = setupSocketIO(httpServer);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  // Record what would be emitted to which user room instead of delivering it.
  io.to = (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) });
});

after(async () => {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- helpers ----------

function makeUser(isAdmin = 0) {
  const n = ++userCounter;
  return Number(getDb().prepare(`
    INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, email_verified)
    VALUES (?, ?, ?, 2, ?, 600000, ?, 1, 1)
  `).run(`own_u${n}`, `own_u${n}@example.test`, HASH, KDF_SALT, isAdmin).lastInsertRowid);
}

// members: [{ id, role, joined, changed? }] — timestamps are explicit so the
// "oldest" ordering is deterministic (CURRENT_TIMESTAMP only has 1s resolution).
function makeGroup(members, createdBy = members[0].id) {
  const db = getDb();
  const groupId = Number(db.prepare(`
    INSERT INTO groups (name, created_by) VALUES ('own group', ?)
  `).run(createdBy).lastInsertRowid);

  for (const m of members) {
    db.prepare(`
      INSERT INTO group_members (group_id, user_id, role, joined_at, role_changed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(groupId, m.id, m.role, m.joined, m.changed ?? null);
  }
  return groupId;
}

function roles(groupId) {
  return Object.fromEntries(
    getDb().prepare('SELECT user_id, role FROM group_members WHERE group_id = ?')
      .all(groupId).map((r) => [r.user_id, r.role])
  );
}

function ownerCount(groupId) {
  return getDb().prepare(
    `SELECT COUNT(*) c FROM group_members WHERE group_id = ? AND role = 'owner'`
  ).get(groupId).c;
}

function epochs(groupId) {
  return getDb().prepare('SELECT key_epoch FROM group_members WHERE group_id = ?')
    .all(groupId).map((r) => r.key_epoch);
}

function groupExists(groupId) {
  return !!getDb().prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId);
}

function call(handler, { as, params = {}, body = {} }) {
  let status = 200;
  let payload;
  const res = {
    status(code) { status = code; return this; },
    json(p) { payload = p; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  handler({ user: { id: as, is_admin: 0 }, params, body }, res);
  return { status, body: payload };
}

const T = (n) => `2024-01-0${n} 00:00:00`;

// ---------- kick rules ----------

test('admin cannot kick another admin or the owner; can kick a member', () => {
  const owner = makeUser(), admin1 = makeUser(), admin2 = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin1, role: 'admin', joined: T(2) },
    { id: admin2, role: 'admin', joined: T(3) },
    { id: member, role: 'member', joined: T(4) },
  ]);

  const kickAdmin = call(removeMemberHandler, { as: admin1, params: { groupId: String(g), userId: String(admin2) } });
  assert.equal(kickAdmin.status, 403);

  const kickOwner = call(removeMemberHandler, { as: admin1, params: { groupId: String(g), userId: String(owner) } });
  assert.equal(kickOwner.status, 403);
  assert.deepEqual(roles(g), { [owner]: 'owner', [admin1]: 'admin', [admin2]: 'admin', [member]: 'member' });

  const kickMember = call(removeMemberHandler, { as: admin1, params: { groupId: String(g), userId: String(member) } });
  assert.equal(kickMember.status, 200);
  assert.equal(roles(g)[member], undefined);
});

test('plain member cannot kick anyone; owner can kick an admin', () => {
  const owner = makeUser(), admin = makeUser(), m1 = makeUser(), m2 = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin, role: 'admin', joined: T(2) },
    { id: m1, role: 'member', joined: T(3) },
    { id: m2, role: 'member', joined: T(4) },
  ]);

  assert.equal(call(removeMemberHandler, { as: m1, params: { groupId: String(g), userId: String(m2) } }).status, 403);
  assert.equal(call(removeMemberHandler, { as: owner, params: { groupId: String(g), userId: String(admin) } }).status, 200);
  assert.equal(roles(g)[admin], undefined);
  assert.equal(ownerCount(g), 1);
});

test('kicking bumps the epoch for the remaining members', () => {
  const owner = makeUser(), m1 = makeUser(), m2 = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: m1, role: 'member', joined: T(2) },
    { id: m2, role: 'member', joined: T(3) },
  ]);
  assert.deepEqual(epochs(g), [0, 0, 0]);
  call(removeMemberHandler, { as: owner, params: { groupId: String(g), userId: String(m2) } });
  assert.deepEqual(epochs(g), [1, 1]);
});

// ---------- promote / demote ----------

test('promote/demote admins: owner only, with clear errors', () => {
  const owner = makeUser(), admin = makeUser(), member = makeUser(), outsider = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin, role: 'admin', joined: T(2) },
    { id: member, role: 'member', joined: T(3) },
  ]);
  const p = (as, userId) => call(promoteAdminHandler, { as, params: { groupId: String(g), userId: String(userId) } });
  const d = (as, userId) => call(demoteAdminHandler, { as, params: { groupId: String(g), userId: String(userId) } });

  assert.equal(p(admin, member).status, 403, 'admin cannot promote');
  assert.equal(p(member, member).status, 403, 'member cannot promote');
  assert.equal(d(admin, admin).status, 403, 'admin cannot demote');
  assert.equal(p(outsider, member).status, 403, 'non-member is refused');

  assert.equal(p(owner, outsider).status, 404, 'target must be a member');
  assert.equal(p(owner, admin).status, 400, 'target must currently be a member');
  assert.equal(p(owner, owner).status, 400, 'owner is not promotable');
  assert.equal(d(owner, member).status, 400, 'target must currently be an admin');
  assert.equal(d(owner, outsider).status, 404);
  assert.equal(call(promoteAdminHandler, { as: owner, params: { groupId: String(g), userId: 'abc' } }).status, 400);

  const before = epochs(g);
  assert.equal(p(owner, member).status, 200);
  assert.equal(roles(g)[member], 'admin');
  const row = getDb().prepare('SELECT role_changed_at FROM group_members WHERE group_id = ? AND user_id = ?').get(g, member);
  assert.ok(row.role_changed_at, 'role_changed_at is set on a role change');

  assert.equal(d(owner, member).status, 200);
  assert.equal(roles(g)[member], 'member');
  assert.deepEqual(epochs(g), before, 'role changes do not bump key_epoch');
  assert.equal(ownerCount(g), 1);
});

test('role changes emit group:membership-changed to every member', () => {
  const owner = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: member, role: 'member', joined: T(2) },
  ]);
  emitted = [];
  call(promoteAdminHandler, { as: owner, params: { groupId: String(g), userId: String(member) } });
  const rooms = emitted.filter((e) => e.event === 'group:membership-changed' && e.payload.type === 'admin_promoted');
  assert.deepEqual(rooms.map((e) => e.room).sort(), [`user:${owner}`, `user:${member}`].sort());
  assert.equal(rooms[0].payload.user_id, member);
});

// ---------- transfer ownership ----------

test('transfer: old owner becomes admin, new is owner, exactly one owner', () => {
  const owner = makeUser(), admin = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin, role: 'admin', joined: T(2) },
    { id: member, role: 'member', joined: T(3) },
  ]);
  const before = epochs(g);
  const r = call(transferOwnershipHandler, { as: owner, params: { groupId: String(g) }, body: { userId: member } });
  assert.equal(r.status, 200);
  assert.deepEqual(roles(g), { [owner]: 'admin', [admin]: 'admin', [member]: 'owner' });
  assert.equal(ownerCount(g), 1);
  assert.deepEqual(epochs(g), before, 'no epoch bump on transfer');
});

test('transfer: only the owner, only to a current member, not to self', () => {
  const owner = makeUser(), admin = makeUser(), member = makeUser(), outsider = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin, role: 'admin', joined: T(2) },
    { id: member, role: 'member', joined: T(3) },
  ]);
  const t = (as, userId) => call(transferOwnershipHandler, { as, params: { groupId: String(g) }, body: { userId } });

  assert.equal(t(admin, member).status, 403);
  assert.equal(t(member, member).status, 403);
  assert.equal(t(owner, outsider).status, 404);
  assert.equal(t(owner, owner).status, 400);
  assert.equal(t(owner, undefined).status, 400);
  assert.equal(t(owner, 'x').status, 400);
  assert.deepEqual(roles(g), { [owner]: 'owner', [admin]: 'admin', [member]: 'member' });
});

test('database refuses a second owner in one group', () => {
  const a = makeUser(), b = makeUser();
  const g = makeGroup([{ id: a, role: 'owner', joined: T(1) }]);
  assert.throws(
    () => getDb().prepare(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')`).run(g, b),
    /UNIQUE/
  );
});

// ---------- leave + auto-succession ----------

test('owner leaves with admins present -> oldest admin (by role_changed_at) becomes owner', () => {
  const owner = makeUser(), memberOld = makeUser(), adminLate = makeUser(), adminEarly = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    // joined first, but became admin LAST
    { id: adminLate, role: 'admin', joined: T(2), changed: T(8) },
    // joined later, became admin EARLIER -> wins on COALESCE(role_changed_at, joined_at)
    { id: adminEarly, role: 'admin', joined: T(5), changed: T(6) },
    { id: memberOld, role: 'member', joined: T(1) },
  ]);

  emitted = [];
  const r = call(leaveGroupHandler, { as: owner, params: { groupId: String(g) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.new_owner_id, adminEarly);
  assert.deepEqual(roles(g), { [adminLate]: 'admin', [adminEarly]: 'owner', [memberOld]: 'member' });
  assert.equal(ownerCount(g), 1);
  assert.deepEqual(epochs(g), [1, 1, 1]);

  const types = emitted.map((e) => e.payload.type);
  assert.ok(types.includes('removed'));
  assert.ok(types.includes('ownership_transferred'));
  const transfer = emitted.find((e) => e.payload.type === 'ownership_transferred').payload;
  assert.equal(transfer.new_owner_id, adminEarly);
  assert.equal(transfer.old_owner_id, owner);
});

test('admin with no role_changed_at ranks by joined_at', () => {
  const owner = makeUser(), a1 = makeUser(), a2 = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: a1, role: 'admin', joined: T(4) },
    { id: a2, role: 'admin', joined: T(3) },
  ]);
  call(leaveGroupHandler, { as: owner, params: { groupId: String(g) } });
  assert.equal(roles(g)[a2], 'owner');
});

test('owner leaves with only members -> oldest member becomes owner', () => {
  const owner = makeUser(), mNew = makeUser(), mOld = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: mNew, role: 'member', joined: T(5) },
    { id: mOld, role: 'member', joined: T(2) },
  ]);
  const r = call(leaveGroupHandler, { as: owner, params: { groupId: String(g) } });
  assert.equal(r.status, 200);
  assert.deepEqual(roles(g), { [mNew]: 'member', [mOld]: 'owner' });
  assert.equal(ownerCount(g), 1);
});

test('owner leaves alone -> group deleted along with its rows, files and reactions', () => {
  const owner = makeUser();
  const g = makeGroup([{ id: owner, role: 'owner', joined: T(1) }]);
  const db = getDb();

  fs.writeFileSync(path.join(GROUP_DIR, 'solo.bin'), 'x');
  const msgId = Number(db.prepare(`
    INSERT INTO group_messages (group_id, sender_id, content, attachment_path)
    VALUES (?, ?, 'c', 'solo.bin')
  `).run(g, owner).lastInsertRowid);
  db.prepare(`INSERT INTO message_reactions (message_type, message_id, user_id, emoji) VALUES ('group', ?, ?, '👍')`)
    .run(msgId, owner);

  const r = call(leaveGroupHandler, { as: owner, params: { groupId: String(g) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.group_deleted, true);
  assert.equal(groupExists(g), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_messages WHERE group_id = ?').get(g).c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM message_reactions WHERE message_type='group' AND message_id = ?`).get(msgId).c, 0);
  assert.equal(fs.existsSync(path.join(GROUP_DIR, 'solo.bin')), false);
});

test('admin and member can still leave on their own', () => {
  const owner = makeUser(), admin = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin, role: 'admin', joined: T(2) },
    { id: member, role: 'member', joined: T(3) },
  ]);
  assert.equal(call(leaveGroupHandler, { as: admin, params: { groupId: String(g) } }).status, 200);
  assert.equal(call(leaveGroupHandler, { as: member, params: { groupId: String(g) } }).status, 200);
  assert.deepEqual(roles(g), { [owner]: 'owner' });
});

// ---------- delete group ----------

test('delete group: owner only; removes dependent rows and tells every member', () => {
  const owner = makeUser(), admin = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: admin, role: 'admin', joined: T(2) },
    { id: member, role: 'member', joined: T(3) },
  ]);
  const db = getDb();
  db.prepare(`INSERT INTO group_messages (group_id, sender_id, content) VALUES (?, ?, 'c')`).run(g, member);
  db.prepare(`INSERT INTO group_key_distributions (group_id, from_user_id, to_user_id, wrapped_key, epoch) VALUES (?, ?, ?, 'w', 0)`)
    .run(g, owner, member);

  assert.equal(call(deleteGroupHandler, { as: admin, params: { groupId: String(g) } }).status, 403);
  assert.equal(call(deleteGroupHandler, { as: member, params: { groupId: String(g) } }).status, 403);
  assert.equal(groupExists(g), true);

  emitted = [];
  const r = call(deleteGroupHandler, { as: owner, params: { groupId: String(g) } });
  assert.equal(r.status, 200);
  assert.equal(groupExists(g), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(g).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_messages WHERE group_id = ?').get(g).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ?').get(g).c, 0);

  const removedFor = emitted
    .filter((e) => e.event === 'group:membership-changed' && e.payload.type === 'removed' && e.payload.group_deleted)
    .map((e) => e.payload.user_id).sort();
  assert.deepEqual(removedFor, [owner, admin, member].sort());

  // already gone: the owner-role check can no longer pass
  assert.equal(call(deleteGroupHandler, { as: owner, params: { groupId: String(g) } }).status, 403);
});

// ---------- account deletion ----------

// DELETE /admin/users/:id is async and needs the admin's password proof
// (current_auth_key). Resolves with the HTTP status once the handler answers.
function adminDeleteUser(adminId, userId, { authKey = siteAdminAuthKey } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(c) { status = c; return this; },
      json() { resolve(status); return this; },
    };
    adminController.deleteUser(
      { user: { id: adminId }, params: { id: String(userId) }, body: { current_auth_key: authKey } },
      res,
      reject
    );
  });
}

test('deleting an owner account hands the group on (oldest admin, else oldest member)', async () => {
  const owner = makeUser(), admin = makeUser(), member = makeUser();
  const withAdmin = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: member, role: 'member', joined: T(2) },
    { id: admin, role: 'admin', joined: T(3) },
  ]);
  const other = makeUser(), other2 = makeUser();
  const onlyMembers = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: other2, role: 'member', joined: T(6) },
    { id: other, role: 'member', joined: T(4) },
  ]);
  const solo = makeGroup([{ id: owner, role: 'owner', joined: T(1) }]);

  emitted = [];
  assert.equal(await adminDeleteUser(siteAdmin, owner), 200);

  assert.equal(groupExists(withAdmin), true);
  assert.deepEqual(roles(withAdmin), { [member]: 'member', [admin]: 'owner' });
  assert.equal(ownerCount(withAdmin), 1);
  assert.deepEqual(epochs(withAdmin), [1, 1]);

  assert.equal(groupExists(onlyMembers), true);
  assert.deepEqual(roles(onlyMembers), { [other2]: 'member', [other]: 'owner' });

  assert.equal(groupExists(solo), false, 'sole-member group is deleted');

  const transfers = emitted.filter((e) => e.payload?.type === 'ownership_transferred');
  assert.ok(transfers.some((e) => e.payload.group_id === withAdmin && e.payload.new_owner_id === admin));
});

test("deleting the original creator's account keeps groups they no longer own", async () => {
  const creator = makeUser(), newOwner = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: creator, role: 'owner', joined: T(1) },
    { id: newOwner, role: 'member', joined: T(2) },
    { id: member, role: 'member', joined: T(3) },
  ], creator);

  const t = call(transferOwnershipHandler, { as: creator, params: { groupId: String(g) }, body: { userId: newOwner } });
  assert.equal(t.status, 200);

  assert.equal(await adminDeleteUser(siteAdmin, creator), 200);

  assert.equal(groupExists(g), true, 'group survives its creator');
  assert.deepEqual(roles(g), { [newOwner]: 'owner', [member]: 'member' });
  assert.equal(getDb().prepare('SELECT created_by FROM groups WHERE id = ?').get(g).created_by, null);
});

test("deleting a plain member's account bumps key_epoch for the remaining members and emits removed", async () => {
  const owner = makeUser(), member = makeUser(), other = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: member, role: 'member', joined: T(2) },
    { id: other, role: 'member', joined: T(3) },
  ]);

  assert.deepEqual(epochs(g), [0, 0, 0]);

  emitted = [];
  assert.equal(await adminDeleteUser(siteAdmin, member), 200);

  assert.equal(groupExists(g), true, 'group survives the member deletion');
  assert.deepEqual(roles(g), { [owner]: 'owner', [other]: 'member' });
  assert.deepEqual(epochs(g), [1, 1], 'key_epoch bumped for remaining members');
  assert.equal(ownerCount(g), 1);

  const removed = emitted.filter((e) => e.event === 'group:membership-changed' && e.payload.type === 'removed');
  assert.ok(removed.length >= 1, 'a removed event is emitted');
  assert.ok(removed.some((e) => e.payload.user_id === member), 'removed names the deleted member');
});

test('admin delete with a wrong password is refused and removes nothing', async () => {
  const owner = makeUser(), member = makeUser();
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: member, role: 'member', joined: T(2) },
  ]);
  const wrong = deriveCredentialsNode('not-the-password', newKdfSalt(), KDF_ITERATIONS).authKey;

  assert.equal(await adminDeleteUser(siteAdmin, member, { authKey: wrong }), 403);
  assert.ok(getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(member), 'account must still exist');
  assert.deepEqual(roles(g), { [owner]: 'owner', [member]: 'member' });
});

test('permissions never read groups.created_by', () => {
  const creator = makeUser(), owner = makeUser(), member = makeUser();
  // creator created it but is NOT the owner; owner row is someone else
  const g = makeGroup([
    { id: owner, role: 'owner', joined: T(1) },
    { id: member, role: 'member', joined: T(2) },
  ], creator);
  assert.equal(call(deleteGroupHandler, { as: member, params: { groupId: String(g) } }).status, 403);
  assert.equal(call(promoteAdminHandler, { as: owner, params: { groupId: String(g), userId: String(member) } }).status, 200);
});

// ---------- migration of an existing database ----------

test('migration rebuilds legacy groups (NOT NULL + CASCADE) without losing data', () => {
  const Database = require('better-sqlite3');
  const file = path.join(tmp, 'legacy.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');

  // 1. current schema, then downgrade `groups` to its legacy shape.
  ensureSchema(db);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE groups_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(name) > 0 AND length(name) <= 100),
      avatar_path TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );
    DROP TABLE groups;
    ALTER TABLE groups_old RENAME TO groups;
  `);
  db.pragma('foreign_keys = ON');

  const mkUser = (n) => Number(db.prepare(`
    INSERT INTO users (username, email, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, email_verified)
    VALUES (?, ?, ?, 2, ?, 600000, 0, 1, 1)
  `).run(`leg_${n}`, `leg_${n}@example.test`, HASH, KDF_SALT).lastInsertRowid);
  const u1 = mkUser(1), u2 = mkUser(2);

  // burn an id so AUTOINCREMENT's counter is ahead of MAX(id)
  const burned = Number(db.prepare(`INSERT INTO groups (name, created_by) VALUES ('burn', ?)`).run(u1).lastInsertRowid);
  db.prepare('DELETE FROM groups WHERE id = ?').run(burned);

  const gid = Number(db.prepare(`INSERT INTO groups (name, created_by) VALUES ('legacy', ?)`).run(u1).lastInsertRowid);
  db.prepare(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')`).run(gid, u1);
  db.prepare(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`).run(gid, u2);
  db.prepare(`INSERT INTO group_messages (group_id, sender_id, content) VALUES (?, ?, 'hello')`).run(gid, u2);
  db.prepare(`INSERT INTO group_key_distributions (group_id, from_user_id, to_user_id, wrapped_key) VALUES (?, ?, ?, 'w')`).run(gid, u1, u2);

  const legacyCol = db.prepare(`PRAGMA table_info(groups)`).all().find((c) => c.name === 'created_by');
  assert.equal(legacyCol.notnull, 1, 'precondition: legacy shape');

  // 2. the migration
  ensureSchema(db);

  const col = db.prepare(`PRAGMA table_info(groups)`).all().find((c) => c.name === 'created_by');
  assert.equal(col.notnull, 0, 'created_by is nullable now');
  assert.equal(db.prepare(`PRAGMA foreign_key_list(groups)`).all()[0].on_delete, 'SET NULL');

  // nothing was wiped by the table rebuild
  assert.equal(db.prepare('SELECT COUNT(*) c FROM groups WHERE id = ?').get(gid).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?').get(gid).c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_messages WHERE group_id = ?').get(gid).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM group_key_distributions WHERE group_id = ?').get(gid).c, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys restored to ON');

  // AUTOINCREMENT does not reuse the burned id
  const next = Number(db.prepare(`INSERT INTO groups (name, created_by) VALUES ('next', ?)`).run(u1).lastInsertRowid);
  assert.ok(next > burned, `new id ${next} must be greater than the burned id ${burned}`);

  // deleting the creator no longer deletes the group
  db.prepare('DELETE FROM users WHERE id = ?').run(u1);
  const survivor = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(gid);
  assert.ok(survivor, 'group survives the creator being deleted');
  assert.equal(survivor.created_by, null);

  // idempotent
  ensureSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM groups WHERE id = ?').get(gid).c, 1);

  db.close();
});
