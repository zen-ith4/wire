// tests/dm-text-e2ee-server.test.mjs
//
// Real server, no browser. The server refuses DM text that is not an encrypted
// envelope, for the same reason it refuses a plaintext upload: an old or broken
// client should get an error, not store plaintext. It also lets the client treat a
// new unencrypted row as something no honest server stored
// (public/js/chat/dm-unencrypted.js).
//
// This is not what stops a hostile server, which can write any row it likes. The
// client rule is, and tests/dm-unencrypted-browser.test.mjs is where that is tested.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Database, assertFixtureUntouched, cleanupTmp, tmpDir, FIXTURE_DB } from './credentials/_fixture.mjs';
import { bootServer } from './credentials/_server.mjs';
import { PASSWORD } from './_acceptance-harness.mjs';

const { runMigrations } = await import('../database/migrations.js');

const NOT_ENCRYPTED = 'DM_NOT_ENCRYPTED';

function v1Envelope(from, to) {
    return JSON.stringify({
        encryption: {
            version: 1,
            algorithm: 'AES-GCM',
            iv: Buffer.alloc(12).toString('base64'),
            ciphertext: Buffer.from('aabbcc', 'hex').toString('base64'),
        },
        senderId: from,
        recipientId: to,
    });
}

function v2Envelope(from, to) {
    return JSON.stringify({
        encryption: {
            version: 2,
            algorithm: 'AES-GCM',
            iv: Buffer.alloc(12).toString('base64'),
            ciphertext: Buffer.from('aabbcc', 'hex').toString('base64'),
            senderFp: Buffer.alloc(32).toString('base64'),
            msgId: '0123456789abcdef',
        },
        senderId: from,
        recipientId: to,
    });
}

// Everything here reaches the rule: none of it is empty or over the length cap.
const NOT_ENVELOPES = [
    ['plain text', 'hello bob'],
    ['JSON that is no envelope', '{"hello":"bob"}'],
    ['a JSON array', '[1,2,3]'],
    ['encryption is not an object', '{"encryption":"yes"}'],
    ['a version that does not exist', JSON.stringify({ encryption: { version: 3, algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'qrvM' } })],
    ['the wrong algorithm', JSON.stringify({ encryption: { version: 1, algorithm: 'none', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'qrvM' } })],
    ['no ciphertext', JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA' } })],
    ['an iv of the wrong size', JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: 'AAAA', ciphertext: 'qrvM' } })],
];

async function registered(srv, username) {
    const reg = await srv.call('POST', '/api/auth/register', {
        body: { username, email: `${username}@x.invalid`, password: PASSWORD },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const login = await srv.call('POST', '/api/auth/login', { body: { username, password: PASSWORD } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const { token } = login.body;
    return { token, id: JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).id };
}

async function serverOn(name, extraEnv = {}) {
    const dir = tmpDir();
    const dbPath = path.join(dir, `${name}.db`);
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const db = new Database(dbPath, { readonly: false });
    runMigrations(db);
    db.close();

    const srv = await bootServer(dbPath, dir, extraEnv);
    const rowCount = () => {
        const reader = new Database(dbPath, { readonly: true });
        try {
            return reader.prepare('SELECT COUNT(*) AS n FROM direct_messages').get().n;
        } finally {
            reader.close();
        }
    };
    const rowContent = (id) => {
        const reader = new Database(dbPath, { readonly: true });
        try {
            return reader.prepare('SELECT content FROM direct_messages WHERE id = ?').get(id).content;
        } finally {
            reader.close();
        }
    };
    return { srv, rowCount, rowContent };
}

let main;
let alice;
let bob;

before(async () => {
    main = await serverOn('enforced');
    alice = await registered(main.srv, 'textrulea');
    bob = await registered(main.srv, 'textruleb');
});

after(async () => {
    await main?.srv.stop();
    cleanupTmp();
    assertFixtureUntouched();
});

const send = (srv, from, to, content) => srv.call('POST', '/api/dm/messages', {
    token: from.token,
    body: { recipient_id: to.id, content },
});

test('a real envelope is stored as it came, v1 and v2', async () => {
    const v1 = v1Envelope(alice.id, bob.id);
    const sentV1 = await send(main.srv, alice, bob, v1);
    assert.equal(sentV1.status, 200, JSON.stringify(sentV1.body));
    assert.equal(main.rowContent(sentV1.body.id), v1);

    const v2 = v2Envelope(alice.id, bob.id);
    const sentV2 = await send(main.srv, alice, bob, v2);
    assert.equal(sentV2.status, 200, JSON.stringify(sentV2.body));
    assert.equal(main.rowContent(sentV2.body.id), v2);
});

for (const [label, content] of NOT_ENVELOPES) {
    test(`send: ${label} is refused and nothing is stored`, async () => {
        const before = main.rowCount();

        const res = await send(main.srv, alice, bob, content);

        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.code, NOT_ENCRYPTED);
        assert.equal(main.rowCount(), before);
    });

    test(`edit: ${label} is refused and the row is left as it was`, async () => {
        const original = v1Envelope(alice.id, bob.id);
        const sent = await send(main.srv, alice, bob, original);
        assert.equal(sent.status, 200, JSON.stringify(sent.body));

        const res = await main.srv.call('PATCH', `/api/dm/messages/${sent.body.id}`, {
            token: alice.token,
            body: { content },
        });

        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.code, NOT_ENCRYPTED);
        assert.equal(main.rowContent(sent.body.id), original);
    });
}

test('an edit with a real envelope still works', async () => {
    const sent = await send(main.srv, alice, bob, v1Envelope(alice.id, bob.id));
    const next = JSON.stringify({ ...JSON.parse(v1Envelope(alice.id, bob.id)), edited: true });

    const res = await main.srv.call('PATCH', `/api/dm/messages/${sent.body.id}`, {
        token: alice.token,
        body: { content: next },
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(main.rowContent(sent.body.id), next);
});

test('over the length cap is still the length error, not this one', async () => {
    const res = await send(main.srv, alice, bob, 'x'.repeat(2001));

    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'DM_CONTENT_TOO_LONG');
});

test('DM_E2EE_TEXT_ENFORCED=false rolls the rule back, and only then', async () => {
    const off = await serverOn('rollback', { DM_E2EE_TEXT_ENFORCED: 'false' });

    try {
        const a = await registered(off.srv, 'textrollba');
        const b = await registered(off.srv, 'textrollbb');

        const sent = await send(off.srv, a, b, 'hello bob');
        assert.equal(sent.status, 200, JSON.stringify(sent.body));
        assert.equal(off.rowContent(sent.body.id), 'hello bob');

        const edited = await off.srv.call('PATCH', `/api/dm/messages/${sent.body.id}`, {
            token: a.token,
            body: { content: 'hello again' },
        });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal(off.rowContent(sent.body.id), 'hello again');
    } finally {
        await off.srv.stop();
    }
});
