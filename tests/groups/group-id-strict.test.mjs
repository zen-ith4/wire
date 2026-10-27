// parseGroupId used Number.parseInt, which accepts a prefix: "1abc" became 1
// and "1.5" became 1. Malformed ids reached the database as real ids. The
// strict parser accepts only canonical positive integers. These tests hit real
// routes over HTTP and check that malformed ids get 400 and canonical ids
// still work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startRealServer, registerUser, restLogin } from '../_acceptance-harness.mjs';

const OWNER = 'idstrict-owner';
let server;
let owner;
let groupId;

before(async () => {
    server = await startRealServer();
    await registerUser(server.origin, OWNER);
    owner = await restLogin(server.origin, OWNER);

    const created = await owner.api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'strict ids' }),
    });
    assert.equal(created.status, 201, `create group: ${created.status} ${JSON.stringify(created.body)}`);
    groupId = created.body.id;
});

after(async () => {
    if (server) await server.stop();
});

const MALFORMED = ['1abc', '1.5', '0', '-1', '01', '99999999999999999999', '%20', 'abc'];

test('malformed group ids are rejected with 400 on the members route', async () => {
    for (const bad of MALFORMED) {
        const res = await owner.api(`/api/groups/${encodeURIComponent(bad)}/members`);
        assert.equal(res.status, 400, `groupId "${bad}" must be 400, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, 'Invalid group id');
    }
});

test('a canonical group id still works', async () => {
    const res = await owner.api(`/api/groups/${groupId}/members`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('malformed message ids are rejected with 400 on the delete-message route', async () => {
    for (const bad of ['1abc', '1.5', '0', '01', '-1']) {
        const res = await owner.api(`/api/groups/${groupId}/messages/${encodeURIComponent(bad)}`, {
            method: 'DELETE',
        });
        assert.equal(res.status, 400, `messageId "${bad}" must be 400, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, 'Invalid group or message id');
    }
});

test('malformed user ids are rejected with 400 on the remove-member route', async () => {
    for (const bad of ['1abc', '1.5', '0', '01']) {
        const res = await owner.api(`/api/groups/${groupId}/members/${encodeURIComponent(bad)}`, {
            method: 'DELETE',
        });
        assert.equal(res.status, 400, `userId "${bad}" must be 400, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, 'Invalid group or user id');
    }
});

test('a canonical but unknown message id is still a 404 (valid id, not malformed)', async () => {
    const res = await owner.api(`/api/groups/${groupId}/messages/999999`, { method: 'DELETE' });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error, 'Message not found');
});

test('malformed message ids are rejected with 400 on the reactions route', async () => {
    for (const bad of ['1abc', '1.5', '0', '01', '-1']) {
        const res = await owner.api(`/api/groups/${groupId}/messages/${encodeURIComponent(bad)}/reactions`, {
            method: 'POST',
            body: JSON.stringify({ emoji: '👍' }),
        });
        assert.equal(res.status, 400, `messageId "${bad}" must be 400, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, 'Invalid group or message id');
    }
});
