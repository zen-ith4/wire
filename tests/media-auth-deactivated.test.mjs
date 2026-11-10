// tests/media-auth-deactivated.test.mjs
//
// mediaAuth (the guard on GET /api/dm/attachments/:messageId and
// GET /api/groups/:groupId/attachments/:messageId) and avatarMediaAuth
// (GET /api/me/avatar/:userId) must refuse a deactivated account
// (users.is_active = 0) on BOTH authentication paths — the Authorization:
// Bearer session-token path and the short-lived ?token= media-token path —
// while an active account behaves exactly as before.
//
// The bug: loadUserAndContinue() only checked that the user row existed and
// that the session token's version matched; it never read is_active, so a
// deactivated account could still stream its DM/group attachment and avatar.
// authenticate.js already refused them on the normal API routes, and
// folderFileMediaAuth / shareLinkMediaAuth already used loadActiveUser(),
// which checks is_active. The fix makes loadUserAndContinue() delegate to that
// single loadActiveUser() implementation (middleware/mediaAuth.js).
//
// Runs against the REAL server process (like tests/groups/group-media-token-
// protocol.test.mjs) and hits the real endpoints directly. A fixed JWT secret
// is shared with the server so this test can mint media/avatar tokens that it
// will accept, exactly as utils/jwt.js's signMediaToken/signPushAvatarToken
// would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { startRealServer, registerUser, restLogin } from './_acceptance-harness.mjs';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

// Shared with the server via startRealServer({ extraEnv: { JWT_SECRET } }) so
// the tokens minted below verify against it.
const JWT_SECRET = 'media-auth-deactivated-test-secret';

// A large message id that no real attachment ever has, so an active account
// that passes mediaAuth reaches the controller and gets a non-401 result
// (404 "Attachment not found"), proving the is_active gate did not block it.
const MESSAGE_ID = 999999;

let server;
let owner; // the account under test (registered, logged in, then deactivated)
let ownerId;
let groupId;

before(async () => {
    server = await startRealServer({ extraEnv: { JWT_SECRET } });

    await registerUser(server.origin, 'mediaowner');
    owner = await restLogin(server.origin, 'mediaowner');
    ownerId = owner.id;

    // A group the owner owns, so an active owner passes membership and reaches
    // the attachment controller (404 for the missing attachment).
    const created = await owner.api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'media auth deactivated' }),
    });
    assert.equal(created.status, 201, `create group: ${created.status} ${JSON.stringify(created.body)}`);
    groupId = created.body.id;
});

after(async () => {
    if (server) await server.stop();
});

// is_active = 0. The server holds the DB open in WAL mode, so this writer is
// visible to the next request the server makes — loadUserAndContinue()
// re-reads the users row on every request, same as authenticate.js does.
function setActive(userId, active) {
    const db = new Database(server.dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, userId);
    db.close();
}

// Mirrors utils/jwt.js signMediaToken exactly (typ 'media', resType, resId) so
// verifyMediaToken() accepts it. TTL is short but positive.
function mediaToken(sub, resType, resId) {
    return jwt.sign(
        { sub, typ: 'media', resType, resId },
        JWT_SECRET,
        { expiresIn: 60 }
    );
}

// One assertion matrix per endpoint: deactivated -> 401 on BOTH paths; the
// same account reactivated -> not 401 on BOTH paths. Self-contained so the
// deactivate/reactivate toggle never leaks between tests.
async function runMatrix(name, spec) {
    test(name, async () => {
        // Deactivated: both paths must be refused with 401.
        setActive(ownerId, false);

        const bearerDeact = await fetch(spec.deactivatedBearerUrl(), {
            headers: spec.bearerHeaders ? { Authorization: `Bearer ${owner.token}` } : undefined,
        });
        assert.equal(bearerDeact.status, 401, `${name} deactivated Bearer: ${bearerDeact.status}`);

        const mediaDeact = await fetch(spec.deactivatedMediaUrl());
        assert.equal(mediaDeact.status, 401, `${name} deactivated media-token: ${mediaDeact.status}`);

        // Active (same account): auth must let it through to the controller.
        setActive(ownerId, true);

        const bearerActive = await fetch(spec.activeBearerUrl(), {
            headers: spec.bearerHeaders ? { Authorization: `Bearer ${owner.token}` } : undefined,
        });
        assert.notEqual(bearerActive.status, 401, `${name} active Bearer should not be auth-blocked: ${bearerActive.status}`);

        const mediaActive = await fetch(spec.activeMediaUrl());
        assert.notEqual(mediaActive.status, 401, `${name} active media-token should not be auth-blocked: ${mediaActive.status}`);
    });
}

// ---- DM attachment: GET /api/dm/attachments/:messageId (guard: mediaAuth) --
runMatrix('DM attachment refuses a deactivated account on both paths', {
    bearerHeaders: true,
    deactivatedBearerUrl: () => `${server.origin}/api/dm/attachments/${MESSAGE_ID}`,
    deactivatedMediaUrl: () => `${server.origin}/api/dm/attachments/${MESSAGE_ID}?token=${mediaToken(ownerId, 'dm', MESSAGE_ID)}`,
    activeBearerUrl: () => `${server.origin}/api/dm/attachments/${MESSAGE_ID}`,
    activeMediaUrl: () => `${server.origin}/api/dm/attachments/${MESSAGE_ID}?token=${mediaToken(ownerId, 'dm', MESSAGE_ID)}`,
});

// ---- Group attachment: GET /api/groups/:groupId/attachments/:messageId -----
// (guard: mediaAuth). groupId is a group the owner owns.
runMatrix('Group attachment refuses a deactivated account on both paths', {
    bearerHeaders: true,
    deactivatedBearerUrl: () => `${server.origin}/api/groups/${groupId}/attachments/${MESSAGE_ID}`,
    deactivatedMediaUrl: () => `${server.origin}/api/groups/${groupId}/attachments/${MESSAGE_ID}?token=${mediaToken(ownerId, 'group', MESSAGE_ID)}`,
    activeBearerUrl: () => `${server.origin}/api/groups/${groupId}/attachments/${MESSAGE_ID}`,
    activeMediaUrl: () => `${server.origin}/api/groups/${groupId}/attachments/${MESSAGE_ID}?token=${mediaToken(ownerId, 'group', MESSAGE_ID)}`,
});

// ---- Avatar: GET /api/me/avatar/:userId (guard: avatarMediaAuth) -----------
runMatrix('Avatar refuses a deactivated account on both paths', {
    bearerHeaders: true,
    deactivatedBearerUrl: () => `${server.origin}/api/me/avatar/${ownerId}`,
    deactivatedMediaUrl: () => `${server.origin}/api/me/avatar/${ownerId}?token=${mediaToken(ownerId, 'avatar', ownerId)}`,
    activeBearerUrl: () => `${server.origin}/api/me/avatar/${ownerId}`,
    activeMediaUrl: () => `${server.origin}/api/me/avatar/${ownerId}?token=${mediaToken(ownerId, 'avatar', ownerId)}`,
});
