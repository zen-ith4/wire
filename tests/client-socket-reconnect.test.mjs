// Behavioural test for "reconnect after a password change" using the REAL
// client modules:
//   - public/js/settings/settings-security.js (the handler that calls
//     reconnectSocket after the server hands back a new token)
//   - public/js/core/socket.js (initSocket / reconnectSocket / disconnectSocket)
//
// Everything heavy those modules pull in (chat views, avatar refreshers, the
// API layer, the identity/KDF helpers) is mocked; the socket layer and the
// settings wiring are real. A real Socket.IO server + real SQLite DB enforce
// token_version, so "reconnected with the NEW token" is not taken on trust:
// the reconnected client is sent an event through the authenticated user's
// room and must receive it exactly once, while another session on the old
// token stays disconnected.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- isolate every on-disk location before any app module loads ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-client-reconnect-'));
process.env.NODE_ENV = 'development';
process.env.HOST = '127.0.0.1';
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'e'.repeat(48);
process.env.USER_DATA_ROOT = path.join(tmp, 'user-data');
process.env.CHAT_UPLOAD_DIR = path.join(tmp, 'chat');
process.env.DM_UPLOAD_DIR = path.join(tmp, 'dm');
process.env.GROUP_UPLOAD_DIR = path.join(tmp, 'group');
process.env.AVATAR_DIR = path.join(tmp, 'avatars');
process.env.BANNER_DIR = path.join(tmp, 'banners');

// ---- browser globals the real client modules read at import/call time ----
const dom = new JSDOM(`<!doctype html><html><body>
  <input id="pw-current"><input id="pw-new"><input id="pw-confirm">
  <div id="pw-error"></div>
  <button data-action="settings-change-password"></button>
</body></html>`, { url: 'http://localhost/' });
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', dom.window);
define('document', dom.window.document);
define('localStorage', dom.window.localStorage);
define('Element', dom.window.Element);
define('Event', dom.window.Event);
define('MouseEvent', dom.window.MouseEvent);

const constants = require(path.join(ROOT, 'config/constants.js'));
const { initDatabase, getDb } = require(path.join(ROOT, 'config/database.js'));
const { signToken } = require(path.join(ROOT, 'utils/jwt.js'));
const { setupSocketIO } = require(path.join(ROOT, 'config/socket.js'));
const { disconnectUserSockets } = require(path.join(ROOT, 'services/socket.service.js'));
const { io: ioClient } = require(path.join(ROOT, 'node_modules/socket.io-client'));

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

// ---- mutable client state the mocks read ---------------------------------
let clientToken = null;
let serverUrl = null;
let issuedToken = null;
let apiCalls = 0;

mock.module(jsPath('vendor/socket.io-client.js'), {
    namedExports: { io: ioClient },
});
mock.module(jsPath('core/auth.js'), {
    namedExports: {
        getToken: () => clientToken,
        setToken: (t) => { clientToken = t; if (t) localStorage.setItem('token', t); else localStorage.removeItem('token'); },
        getCurrentUser: () => ({ id: 1, username: 'alice' }),
        clearPersistedUnlockKey: async () => {},
    },
});
mock.module(jsPath('core/server.js'), {
    namedExports: { getServerEndpoint: () => serverUrl },
});
mock.module(jsPath('core/api.js'), {
    namedExports: {
        api: async () => { apiCalls++; return { token: issuedToken }; },
    },
});
mock.module(jsPath('core/utils.js'), {
    namedExports: { showToast: () => {} },
});
mock.module(jsPath('crypto/identity-service.js'), {
    namedExports: { prepareCredentialChange: async () => ({ body: {} }) },
});
mock.module(jsPath('crypto/account-kdf.js'), {
    namedExports: { MIN_PASSWORD_LENGTH: 12, deriveOwnAuthKey: async () => 'auth-key' },
});
mock.module(jsPath('settings/settings.js'), {
    namedExports: { renderSettings: () => {} },
});
mock.module(jsPath('chat/dm.js'), {
    namedExports: {
        addDmMessage: () => {}, updateDmMessage: () => {}, removeDmMessage: () => {},
        loadDmConversations: () => {}, refreshUnreadBadge: () => {},
        getDmActivePeer: () => null, showDmTyping: () => {}, hideDmTyping: () => {},
        clearAllDmTyping: () => {}, markDmMessagesSeen: () => {},
    },
});
mock.module(jsPath('chat/group.js'), {
    namedExports: {
        addGroupMessage: () => {}, removeGroupMessage: () => {}, showGroupTyping: () => {},
        hideGroupTyping: () => {}, clearAllGroupTyping: () => {},
        applyGroupReactionUpdate: () => {}, handleGroupMembershipChanged: () => {},
        handleGroupKdmDelivered: () => {}, handleGroupUpdated: () => {},
        handleGroupSocketConnected: () => {}, getActiveGroupId: () => null,
    },
});
mock.module(jsPath('chat/presence.js'), {
    namedExports: { setOnlineSnapshot: () => {}, setUserOnline: () => {}, setUserOffline: () => {} },
});
mock.module(jsPath('chat/reactions.js'), {
    namedExports: { updateMessageReactions: () => {} },
});
mock.module(jsPath('ui/avatar.js'), {
    namedExports: { refreshAvatarEverywhere: () => {}, refreshBannerEverywhere: () => {} },
});

// The REAL modules under test.
const socketModule = await import(jsPath('core/socket.js'));
await import(jsPath('settings/settings-security.js'));

// ---- real server + user ---------------------------------------------------
let userId;
let httpServer;
let io;
const VERSION = 0;

before(async () => {
    initDatabase();
    const db = getDb();
    userId = Number(db.prepare(`
        INSERT INTO users (username, password_hash, auth_scheme, kdf_salt, kdf_iterations, is_admin, is_active, token_version)
        VALUES ('alice', 'hash', 2, 'salt', 600000, 0, 1, ${VERSION})
    `).run().lastInsertRowid);

    httpServer = http.createServer();
    io = setupSocketIO(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
    try { socketModule.disconnectSocket(); } catch { /* already down */ }
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
    getDb().close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 50) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return false;
        await sleep(step);
    }
}

function openRawSocket(token) {
    return new Promise((resolve, reject) => {
        const s = ioClient(serverUrl, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
        });
        let settled = false;
        s.on('connect', () => { if (!settled) { settled = true; resolve(s); } });
        s.on('connect_error', (err) => { if (!settled) { settled = true; reject(err); } });
        setTimeout(() => { if (!settled) { settled = true; reject(new Error('raw socket connect timeout')); } }, 5000);
    });
}

test('password change: real client reconnects with the new token and receives an event once; other session stays down', async () => {
    const oldToken = signToken({ id: userId, username: 'alice', is_admin: false, token_version: VERSION });
    clientToken = oldToken;
    localStorage.setItem('token', oldToken);

    // Current device (real client module) + another session on the old token.
    const current = socketModule.initSocket();
    assert.ok(current, 'initSocket returned a socket');
    assert.ok(await waitFor(() => current.connected), 'current client connected with the old token');

    const other = await openRawSocket(oldToken);
    assert.ok(other.connected, 'second session connected with the old token');
    assert.equal((await io.in(`user:${userId}`).fetchSockets()).length, 2, 'two live sockets');

    // The server-side password change: token_version bumps and every old
    // socket is force-disconnected (same sequence the controller performs).
    const newVersion = VERSION + 1;
    getDb().prepare('UPDATE users SET token_version = ? WHERE id = ?').run(newVersion, userId);
    const newToken = signToken({ id: userId, username: 'alice', is_admin: false, token_version: newVersion });
    issuedToken = newToken;
    disconnectUserSockets(userId);

    assert.ok(await waitFor(() => !current.connected), 'current client disconnected by the server');
    assert.ok(await waitFor(() => !other.connected), 'other session disconnected by the server');

    // A reconnect with the OLD token is refused (token_version no longer matches).
    assert.equal(await openRawSocket(oldToken).then(() => true, () => false), false, 'old token refused');

    // Drive the REAL settings handler: fill the form and click the button.
    // It calls api() -> setToken(newToken) -> reconnectSocket().
    document.getElementById('pw-current').value = 'old-password';
    document.getElementById('pw-new').value = 'new-password-123';
    document.getElementById('pw-confirm').value = 'new-password-123';
    document.querySelector('[data-action="settings-change-password"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const reconnected = await waitFor(() => {
        const s = socketModule.getSocket();
        return s && s.connected ? s : false;
    });
    assert.ok(reconnected, 'current client reconnected after the password change');
    assert.equal(apiCalls, 1, 'the settings handler called the password endpoint');
    assert.equal(clientToken, newToken, 'client now holds the new token');

    // Exactly one authenticated connection for this user after the reconnect.
    const live = await io.in(`user:${userId}`).fetchSockets();
    assert.equal(live.length, 1, 'exactly one live socket for the user after reconnect');

    // The server can reach the reconnected client through the user's
    // authenticated room. Delivered exactly once (no duplicate listeners).
    let received = 0;
    reconnected.on('probe', () => { received++; });
    io.to(`user:${userId}`).emit('probe', { ok: true });
    assert.ok(await waitFor(() => received >= 1), 'reconnected client received the probe');
    await sleep(300);
    assert.equal(received, 1, 'probe delivered exactly once');

    // The other session never came back on its own, and an old-token
    // reconnect is still refused.
    assert.equal(other.connected, false, 'other session stays disconnected');
    assert.equal(await openRawSocket(oldToken).then(() => true, () => false), false, 'old token still refused');
});
