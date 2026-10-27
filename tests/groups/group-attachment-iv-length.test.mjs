// The group attachment upload accepted any base64 string up to 64 characters
// as attachment_iv. The client always sends a 12-byte AES-GCM IV, which is 16
// base64 characters with no padding. The server now requires exactly that.
// These tests send real multipart uploads: 12 bytes is accepted, and 11, 13
// and 48 bytes (and a padded/short string) get the same 400 as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startRealServer, registerUser, restLogin } from '../_acceptance-harness.mjs';

const OWNER = 'ivlen-owner';
let server;
let owner;
let groupId;

before(async () => {
    server = await startRealServer();
    await registerUser(server.origin, OWNER);
    owner = await restLogin(server.origin, OWNER);

    const created = await owner.api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'iv length' }),
    });
    assert.equal(created.status, 201, `create group: ${created.status} ${JSON.stringify(created.body)}`);
    groupId = created.body.id;
});

after(async () => {
    if (server) await server.stop();
});

function uploadWithIv(ivBase64) {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('ciphertext-bytes')]), 'iv-test.bin');
    if (ivBase64 !== undefined) form.set('attachment_iv', ivBase64);
    return fetch(`${server.origin}/api/groups/${groupId}/upload`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${owner.token}`,
            'X-Wire-Group-Proto': '2',
        },
        body: form,
    });
}

const IV_ERROR = 'attachment_iv (base64) is required';

test('a 12-byte IV (16 base64 chars) is accepted', async () => {
    const iv = Buffer.alloc(12, 7).toString('base64');
    assert.equal(iv.length, 16);

    const res = await uploadWithIv(iv);
    const body = await res.json().catch(() => null);

    assert.ok(res.status >= 200 && res.status < 300, `expected success, got ${res.status} ${JSON.stringify(body)}`);
});

test('IVs of the wrong size are rejected with the existing 400', async () => {
    for (const bytes of [11, 13, 48]) {
        const iv = Buffer.alloc(bytes, 9).toString('base64');
        const res = await uploadWithIv(iv);
        const body = await res.json().catch(() => null);

        assert.equal(res.status, 400, `${bytes}-byte IV must be rejected, got ${res.status} ${JSON.stringify(body)}`);
        assert.equal(body?.error, IV_ERROR);
    }
});

test('a 16-character string that is not valid base64 IV data is rejected', async () => {
    // Right length, but contains a character outside the base64 alphabet.
    const res = await uploadWithIv('AAAA*AAAAAAAAAAA');
    const body = await res.json().catch(() => null);

    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body?.error, IV_ERROR);
});

test('a missing IV is still rejected', async () => {
    const res = await uploadWithIv(undefined);
    const body = await res.json().catch(() => null);

    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body?.error, IV_ERROR);
});
