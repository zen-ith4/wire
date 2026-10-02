// tests/groups/_scenario.mjs
//
// Shared plumbing for the Group/E2EE audit tests added in this pass
// (group-multidevice / group-kdm-mailbox / group-membership /
// group-socket-delivery / group-ui-security). Same real harness as
// group-roundtrip.test.mjs: real Express + Socket.IO + SQLite server,
// real auth + identity, each actor running its OWN unmodified copy of
// public/js in jsdom. Nothing about application logic is mocked.
//
// Import ./_env.mjs FIRST in the test file (it sets process.env before
// config/constants.js is first required).

import assert from 'node:assert/strict';

import { startTestServer } from './_test-server.mjs';
import { createBrowserActor } from './_browser-actor.mjs';
import { sleep, waitForConnect, signUpAndUnlock, apiCall } from './_roundtrip-helpers.mjs';

export { sleep, apiCall, assert };

// Captured before any actor overwrites globalThis.fetch.
globalThis.__nodeFetch = globalThis.__nodeFetch || globalThis.fetch;

let seq = 0;

export async function createScenario(names) {
    const cleanups = [];
    const server = await startTestServer();
    cleanups.push(() => server.stop());

    const users = {};
    const extras = [];
    for (const name of names) {
        const n = `${name}${seq++}`;
        const actor = createBrowserActor(n, server.origin);
        cleanups.push(() => actor.window.close());
        const password = `pw-${n}-long-enough-passphrase`;
        const ident = await signUpAndUnlock(actor, { username: n, email: `${n}@example.test`, password });
        ident.password = password;
        users[name] = { actor, ident, n, name, devices: [] };
    }

    const S = {
        server,
        users,
        cleanups,

        /**
         * Disconnects every extra device/tab created since the last call, so
         * tests sharing one scenario don't see each other's devices react to
         * membership events (every connected device of a member rotates).
         */
        retireExtras() {
            for (const d of extras.splice(0)) {
                try { d.socketMod?.getSocket()?.disconnect(); } catch { /* ignore */ }
            }
        },

        async stop() {
            for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } }
        },

        /** Real REST call as `u` (test setup plumbing, like the UI's own dialogs). */
        api(u, path, options) {
            return apiCall(server.origin, u.ident.token, path, options);
        },

        createGroup(owner, name) {
            return S.api(owner, '/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
        },

        addMember(owner, groupId, member) {
            return S.api(owner, `/api/groups/${groupId}/members`, {
                method: 'POST', body: JSON.stringify({ user_id: member.ident.id }),
            });
        },

        removeMember(owner, groupId, member) {
            return S.api(owner, `/api/groups/${groupId}/members/${member.ident.id}`, { method: 'DELETE' });
        },

        /** Imports the real group.js / socket.js for this actor and connects the real socket. */
        async mount(u) {
            if (u.mounted) return u;
            u.mounted = true;
            u.actor.use();
            u.group = await u.actor.importModule('chat/group.js');
            u.socketMod = await u.actor.importModule('core/socket.js');
            u.socketMod.initSocket(u.ident.token);
            cleanups.push(() => u.socketMod.getSocket()?.disconnect());
            await waitForConnect(u.socketMod.getSocket(), u.n);
            await u.group.loadGroupsList();
            await u.group.showGroups();
            return u;
        },

        /** Same as the real UI: refresh the list, then open the group. */
        async open(u, groupId) {
            u.actor.use();
            await u.group.loadGroupsList();
            await u.group.openGroup(groupId);
        },

        /** Types into the real composer and triggers the real send path. */
        async send(u, text) {
            u.actor.use();
            const input = u.actor.window.document.getElementById('group-input');
            assert.ok(input, `${u.n}: composer input not rendered`);
            input.value = text;
            await u.actor.window.sendGroupMessage();
            return input.value === ''; // composer only clears on success
        },

        async waitFor(u, fn, ms = 6000) {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                u.actor.use();
                const v = fn(u.actor.window.document);
                if (v) return v;
                await sleep(40);
            }
            return null;
        },

        bubbles(u) {
            u.actor.use();
            return [...u.actor.window.document.querySelectorAll('#group-messages .chat-bubble')]
                .map((e) => e.textContent);
        },

        /**
         * A second browser (fresh profile, fresh IndexedDB) signed into the
         * SAME account. Identity is restored from the server exactly as a
         * real second device would.
         */
        async addDevice(u, label = 'dev2') {
            const n = `${u.n}-${label}-${seq++}`;
            const actor = createBrowserActor(n, server.origin);
            cleanups.push(() => actor.window.close());
            actor.use();
            const auth = await actor.importModule('core/auth.js');
            await auth.login(u.n, u.ident.password);
            await auth.initializeIdentity(u.ident.password);
            const dev = {
                actor,
                n,
                name: `${u.name}:${label}`,
                ident: { id: u.ident.id, token: auth.getToken(), password: u.ident.password },
                account: u,
            };
            u.devices.push(dev);
            extras.push(dev);
            await S.mount(dev);
            return dev;
        },

        /**
         * A second TAB of the same browser profile: own JS heap and module
         * graph, but SHARED IndexedDB / localStorage / Web Locks with `u`.
         */
        async addTab(u, label = 'tab2') {
            const n = `${u.n}-${label}-${seq++}`;
            const actor = createBrowserActor(n, server.origin, { profileOf: u.actor });
            cleanups.push(() => actor.window.close());
            actor.use();
            const auth = await actor.importModule('core/auth.js');
            await auth.login(u.n, u.ident.password);
            await auth.initializeIdentity(u.ident.password);
            const tab = {
                actor,
                n,
                name: `${u.name}:${label}`,
                ident: { id: u.ident.id, token: auth.getToken(), password: u.ident.password },
                account: u,
            };
            extras.push(tab);
            await S.mount(tab);
            return tab;
        },

        /** Every group_messages envelope for a group, parsed. */
        envelopes(groupId) {
            return server.db
                .prepare('SELECT id, sender_id, content FROM group_messages WHERE group_id = ? ORDER BY id')
                .all(groupId)
                .map((r) => ({ id: r.id, sender_id: r.sender_id, raw: r.content, env: JSON.parse(r.content) }));
        },
    };

    return S;
}
