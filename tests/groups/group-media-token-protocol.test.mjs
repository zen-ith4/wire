// GET /api/groups/:groupId/attachments/:messageId/media-token must be gated by
// requireGroupProtocol like the other group routes that carry ciphertext. A
// stale client (no or old X-Wire-Group-Proto) gets the explicit 426
// update_required body. A current client passes the gate and reaches the
// handler (here a 404 because the message has no attachment, which proves the
// gate did not block it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startRealServer, registerUser, restLogin } from '../_acceptance-harness.mjs';

const OWNER = 'mtoken-owner';
let server;
let owner;
let groupId;

before(async () => {
    server = await startRealServer();
    await registerUser(server.origin, OWNER);
    owner = await restLogin(server.origin, OWNER);

    const created = await owner.api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'media token gate' }),
    });
    assert.equal(created.status, 201, `create group: ${created.status} ${JSON.stringify(created.body)}`);
    groupId = created.body.id;
});

after(async () => {
    if (server) await server.stop();
});

function mediaToken(headers) {
    return fetch(`${server.origin}/api/groups/${groupId}/attachments/1/media-token`, {
        headers: { Authorization: `Bearer ${owner.token}`, ...headers },
    });
}

test('a stale client without the protocol header gets 426 update_required', async () => {
    const res = await mediaToken({});
    const body = await res.json();

    assert.equal(res.status, 426, JSON.stringify(body));
    assert.equal(body.code, 'update_required');
    assert.equal(body.min_group_protocol, 2);
});

test('a client declaring an old protocol gets 426 update_required', async () => {
    const res = await mediaToken({ 'X-Wire-Group-Proto': '1' });
    const body = await res.json();

    assert.equal(res.status, 426, JSON.stringify(body));
    assert.equal(body.code, 'update_required');
});

test('a current client passes the gate and reaches the handler', async () => {
    const res = await mediaToken({ 'X-Wire-Group-Proto': '2' });
    const body = await res.json();

    assert.notEqual(res.status, 426, 'current protocol must not be refused by the gate');
    assert.equal(res.status, 404);
    assert.equal(body.error, 'Attachment not found');
});
