// tests/groups/_roundtrip-helpers.mjs
//
// Shared setup plumbing for the real-wired-path group tests
// (group-roundtrip.test.mjs, group-senderkeyid.test.mjs). Must be
// imported AFTER ./_env.mjs, and the importing test must set
// globalThis.__nodeFetch before use (see those files).

import assert from 'node:assert/strict';

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForConnect(socket, label, timeoutMs = 8000) {
    if (!socket) throw new Error(`${label}: getSocket() returned null`);
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    socket.on('connect_error', (e) => { lastErr = e; });
    while (Date.now() < deadline) {
        if (socket.connected) return;
        await sleep(25);
    }
    throw new Error(
        `${label}: socket did not connect within ${timeoutMs}ms ` +
        `(connected=${socket.connected}, lastErr=${lastErr?.message || 'none'})`
    );
}

/**
 * Registers a real user through the real HTTP endpoint, then
 * creates their real E2EE identity through the real endpoint too.
 * Runs entirely under `actor`'s own globals/module graph.
 */
export async function signUpAndUnlock(actor, { username, email, password }) {
    actor.use();
    const auth = await actor.importModule('core/auth.js');

    const data = await auth.register(username, email, password);
    assert.ok(
        !data.requiresEmailVerification,
        `${username}: registration unexpectedly required email verification`
    );
    assert.ok(auth.getToken(), `${username}: no session token after register`);
    assert.ok(auth.getCurrentUser()?.id, `${username}: no current user after register`);

    // core/auth.js's own register() already calls initializeIdentity()
    // internally? No — it does NOT (see auth.js: register() only sets
    // token/currentUser). The identity is created explicitly, same as
    // the real login form does right after a successful register.
    await auth.initializeIdentity(password);

    return { auth, id: auth.getCurrentUser().id, username, token: auth.getToken() };
}

/**
 * Real REST call (not through any actor's module graph — this is
 * just test setup plumbing equivalent to what group.js's own
 * "create group" / "add member" dialogs do) to stand the group up.
 */
export async function apiCall(origin, token, path, options = {}) {
    const res = await globalThis.__nodeFetch(`${origin}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
        throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${text}`);
    }
    return body;
}

