// tests/dm-attachments/_harness.mjs
//
// Real Express + Socket.IO + SQLite server WITH the /api/dm routes
// mounted (tests/groups/_test-server.mjs does not mount them), plus real
// jsdom client actors that run the unmodified public/js code (the same
// actor harness the group tests use). Import ./_env.mjs FIRST.
import { createRequire } from 'node:module';
import { createBrowserActor } from '../groups/_browser-actor.mjs';
import { signUpAndUnlock } from '../groups/_roundtrip-helpers.mjs';

const require = createRequire(import.meta.url);

globalThis.__nodeFetch = globalThis.__nodeFetch || globalThis.fetch;

// Every console line the server (and test process) prints while a test
// runs, so a test can prove a marker never reaches the logs.
export const capturedLogs = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        try {
            capturedLogs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' '));
        } catch { /* unserialisable */ }
        original(...args);
    };
}

export async function startDmServer() {
    const express = require('express');
    const http = require('node:http');
    const { initDatabase, getDb } = require('../../config/database');
    const { setupSocketIO } = require('../../config/socket');
    const { errorHandler } = require('../../middleware/errorHandler');

    initDatabase();

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', require('../../routes/auth.routes'));
    app.use('/api/me', require('../../routes/me.routes'));
    app.use('/api/dm', require('../../routes/dm.routes'));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorHandler);

    const server = http.createServer(app);
    const io = setupSocketIO(server);
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (e) => (e ? reject(e) : resolve())));

    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        origin,
        db: getDb(),
        async stop() {
            await new Promise((resolve) => io.close(() => resolve()));
        },
    };
}

let seq = 0;

export async function createUser(server, name) {
    const n = `${name}${seq++}`;
    const actor = createBrowserActor(n, server.origin);
    const password = `pw-${n}-long-enough-passphrase`;
    const ident = await signUpAndUnlock(actor, { username: n, email: `${n}@example.test`, password });
    return { name, n, actor, ident, id: ident.id, token: ident.token };
}

/** Runs the real client upload preparation as `sender` (their own module graph). */
export async function prepareAsClient(sender, peer, { bytes, name = 'file.bin', mime = 'application/octet-stream', caption = '', isVoice = false }) {
    sender.actor.use();
    const mod = await sender.actor.importModule('media/attachment-e2ee.js');
    const file = new File([bytes], name, { type: mime });
    return mod.prepareDmAttachmentUpload({
        file,
        caption,
        isVoice,
        senderId: sender.id,
        recipientId: peer.id,
    });
}

/** Posts a prepared upload exactly like the browser's xhrUpload would. */
export async function postUpload(server, user, peerId, prepared, extra = {}) {
    const form = new FormData();
    form.append('file', prepared.file, prepared.file.name);
    form.append('recipient_id', String(peerId));
    for (const [k, v] of Object.entries({ ...prepared.fields, ...extra })) {
        if (v !== undefined && v !== null) form.append(k, v);
    }
    const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: form,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
}

export function authGet(server, user, path, headers = {}) {
    return globalThis.__nodeFetch(`${server.origin}${path}`, {
        headers: { Authorization: `Bearer ${user.token}`, ...headers },
    });
}
