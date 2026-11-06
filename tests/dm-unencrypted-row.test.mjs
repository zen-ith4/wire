// tests/dm-unencrypted-row.test.mjs
//
// The rule for a DM row with nothing sealed in it, against a server that picks the
// row's text, its id and where it sits in a page.
//
// Real: chat/dm-unencrypted.js, keys/peer-key-gate.js, keys/peer-trust.js and real
// fake-indexeddb. The whole path through the thread, the list and the composer runs
// in tests/dm-unencrypted-browser.test.mjs.
//
// Every "hidden" assertion has a "shown" case beside it, so a refusal cannot pass
// because the fixture was simply broken.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

globalThis.indexedDB = new IDBFactory();

const ALICE = 1;
const ORIGIN = 'https://wire.test';
const CTX = { origin: ORIGIN, ownUserId: ALICE };

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function publicKey() {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
}

let currentUser = { id: ALICE };

mock.module(js('core/auth.js'), {
    namedExports: { getCurrentUser: () => currentUser },
});

mock.module(js('core/server.js'), {
    namedExports: { getServerEndpoint: () => ORIGIN },
});

mock.module(js('core/api.js'), {
    namedExports: {
        api: async (url) => {
            throw new Error(`unexpected api call: ${url}`);
        },
    },
});

const trust = await import(js('crypto/keys/peer-trust.js'));
const rows = await import(js('chat/dm-unencrypted.js'));

const {
    HIDDEN_UNENCRYPTED_TEXT,
    isUnencryptedDmRow,
    firstSealedRowIndex,
    noteOpenedDmRow,
    mayShowUnencryptedRow,
    judgeQuotedRow,
    unencryptedPreview,
} = rows;

/* ---------------------------------------------------------------- helpers */
const V1 = JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: 'AA==', ciphertext: 'AA==' } });
const V2 = JSON.stringify({ encryption: { version: 2, algorithm: 'AES-GCM', iv: 'AA==', ciphertext: 'AA==' } });

let nextPeer = 100;

/** A contact this device has pinned, with no row opened yet. */
async function pinnedPeer() {
    const id = nextPeer++;
    await trust.pinOnFirstUse(id, await publicKey(), CTX);
    return id;
}

/** A contact whose row `floor` has opened on this device. */
async function peerWithFloor(floor) {
    const id = await pinnedPeer();
    await noteOpenedDmRow(id, { id: floor });
    return id;
}

const floorOf = async (peerId, ctx = CTX) => (await trust.getPeerPin(peerId, ctx))?.encryptedFloor;

beforeEach(() => {
    currentUser = { id: ALICE };
});

/* ---------------------------------------------------------------- what counts */

test('a row with its text or its file sealed is not an unencrypted row', () => {
    const sealed = [
        { content: V1 },
        { content: V2 },
        { content: '', has_attachment: true, attachment_name: 'encrypted-attachment', attachment_meta: V2 },
        { content: V2, has_attachment: true, attachment_name: 'encrypted-attachment', attachment_meta: V2 },
        // A version nothing supports is still an envelope: it goes to the crypto
        // path and fails there, it never renders as text.
        { content: JSON.stringify({ encryption: { version: 9 } }) },
        // Nothing here to show, and nothing to judge.
        { content: '' },
        { content: null },
    ];

    for (const row of sealed) {
        assert.equal(isUnencryptedDmRow(row), false, JSON.stringify(row));
    }
});

test('a row whose text is no envelope, or whose file has no sealed metadata, is one', () => {
    const unsealed = [
        { content: 'hello' },
        { content: '{"not":"an envelope"}' },
        { content: '[1,2,3]' },
        { content: '{"encryption":"nope"}' },
        { content: 'null' },
        { content: 123 },
        { content: 0 },
        { content: false },
        { content: '   ' },
        // The server pairing a real envelope with a file of its own.
        { content: V2, has_attachment: true, attachment_name: 'invoice.pdf' },
        { content: V2, attachment_name: 'invoice.pdf' },
        { content: '', has_attachment: true },
        { content: '', has_attachment: true, attachment_name: 'invoice.pdf', attachment_meta: null },
        { content: '', has_attachment: true, attachment_name: 'invoice.pdf', attachment_meta: '' },
        { content: '', has_attachment: true, attachment_name: 'invoice.pdf', attachment_meta: { version: 2 } },
    ];

    for (const row of unsealed) {
        assert.equal(isUnencryptedDmRow(row), true, JSON.stringify(row));
    }
});

/* ---------------------------------------------------------------- show or hide */

test('a contact with no opened row yet: shown, because nothing says it was ever encrypted', async () => {
    const peer = await pinnedPeer();

    assert.equal(await mayShowUnencryptedRow(peer, 500), true);
    assert.equal(await mayShowUnencryptedRow(peer, 500, { arrivedNow: true }), true);
    assert.equal(await mayShowUnencryptedRow(peer, null), true);
});

test('older than the oldest opened row may be history; anything else is not', async () => {
    const peer = await peerWithFloor(500);

    assert.equal(await mayShowUnencryptedRow(peer, 499), true, 'one below the line is history');
    assert.equal(await mayShowUnencryptedRow(peer, 1), true);
    assert.equal(await mayShowUnencryptedRow(peer, 500), false, 'the line itself is not');
    assert.equal(await mayShowUnencryptedRow(peer, 501), false);
    assert.equal(await mayShowUnencryptedRow(peer, 999999), false);
});

test('a row that arrives now is not history, whatever id it claims', async () => {
    const peer = await peerWithFloor(500);

    assert.equal(await mayShowUnencryptedRow(peer, 1), true, 'control: the same id as history');
    assert.equal(await mayShowUnencryptedRow(peer, 1, { arrivedNow: true }), false);
});

test('an id the server made up is not history', async () => {
    const peer = await peerWithFloor(500);

    for (const id of [null, undefined, '', 0, -1, 1.5, 'x', NaN, {}]) {
        assert.equal(await mayShowUnencryptedRow(peer, id), false, `id ${String(id)}`);
    }
});

test('nobody signed in: hidden', async () => {
    const peer = await pinnedPeer();
    assert.equal(await mayShowUnencryptedRow(peer, 1), true, 'control: signed in');

    currentUser = null;
    assert.equal(await mayShowUnencryptedRow(peer, 1), false);
});

test('the pin store failing: hidden, and an opened row still does not throw', async () => {
    const peer = await peerWithFloor(500);
    assert.equal(await mayShowUnencryptedRow(peer, 1), true, 'control: storage works');

    const real = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = () => { throw new Error('storage is gone'); };

    try {
        assert.equal(await mayShowUnencryptedRow(peer, 1), false);
        await noteOpenedDmRow(peer, { id: 10 });
    } finally {
        IDBDatabase.prototype.transaction = real;
    }

    assert.equal(await floorOf(peer), 500, 'nothing was written while storage was down');
});

/* ---------------------------------------------------------------- the line */

test('the line only moves down', async () => {
    const peer = await peerWithFloor(500);

    await noteOpenedDmRow(peer, { id: 800 });
    assert.equal(await floorOf(peer), 500, 'a newer row must not raise it');

    await noteOpenedDmRow(peer, { id: 300 });
    assert.equal(await floorOf(peer), 300);
});

test('a whole page opening at once leaves the lowest id, whatever order they finish in', async () => {
    const peer = await pinnedPeer();
    const ids = [905, 901, 909, 903, 900, 907, 902, 908, 904, 906];

    await Promise.all(ids.map((id) => noteOpenedDmRow(peer, { id })));

    assert.equal(await floorOf(peer), 900);
});

test('an edited row does not move the line: an edit re-seals an old row', async () => {
    const peer = await peerWithFloor(500);

    await noteOpenedDmRow(peer, { id: 5, edited_at: '2026-01-01T00:00:00.000Z' });
    assert.equal(await floorOf(peer), 500);
    assert.equal(await mayShowUnencryptedRow(peer, 6), true, 'the history above that edit must stay readable');
});

test('a made-up id does not move the line', async () => {
    const peer = await peerWithFloor(500);

    for (const id of [null, undefined, 0, -1, 1.5, 'x']) {
        await noteOpenedDmRow(peer, { id });
    }

    assert.equal(await floorOf(peer), 500);
});

test('noting a row for a contact with no pin creates nothing', async () => {
    const peer = nextPeer++;

    await noteOpenedDmRow(peer, { id: 500 });

    assert.equal(await trust.getPeerPin(peer, CTX), null);
});

test('accepting a new key and verifying a contact both keep the line', async () => {
    const peer = await peerWithFloor(500);

    const next = await publicKey();
    await trust.acceptPeerKey(peer, next, CTX);
    assert.equal(await floorOf(peer), 500, 'after accept');

    const pin = await trust.getPeerPin(peer, CTX);
    await trust.markPeerVerified(peer, CTX, pin.current.fingerprint);
    assert.equal(await floorOf(peer), 500, 'after verify');

    assert.equal(await mayShowUnencryptedRow(peer, 600), false, 'a row above it is still hidden');
});

test("one account's line is not another's", async () => {
    const peer = await peerWithFloor(500);
    assert.equal(await mayShowUnencryptedRow(peer, 600), false, 'control: the account that opened a row');

    currentUser = { id: 2 };
    await trust.pinOnFirstUse(peer, await publicKey(), { origin: ORIGIN, ownUserId: 2 });

    assert.equal(await mayShowUnencryptedRow(peer, 600), true);
});

/* ---------------------------------------------------------------- page order */

test('the first sealed row in a page: what comes after it cannot be history', () => {
    const plain = { id: 1, content: 'old' };
    const sealed = { id: 2, content: V2 };

    assert.equal(firstSealedRowIndex([plain, plain, sealed, plain]), 2);
    assert.equal(firstSealedRowIndex([sealed, plain]), 0);
    assert.equal(firstSealedRowIndex([plain, plain]), -1);
    assert.equal(firstSealedRowIndex([]), -1);

    // A sealed file counts as much as sealed text.
    assert.equal(firstSealedRowIndex([plain, { id: 3, content: '', has_attachment: true, attachment_meta: V2 }]), 1);
});

test('an edited row counts: edited_at is the server\'s to set, so it must not switch this off', () => {
    const plain = { id: 7, content: 'old' };
    const edited = { id: 5, content: V2, edited_at: '2026-01-01T00:00:00.000Z' };

    assert.equal(firstSealedRowIndex([edited, plain]), 0);
});

test('an empty row in a page says nothing about what follows it', () => {
    const plain = { id: 7, content: 'old' };
    const empty = { id: 6, content: '' };

    assert.equal(firstSealedRowIndex([empty, plain]), -1);
    assert.equal(firstSealedRowIndex([empty, plain, { id: 8, content: V2 }]), 2);
});

/* ---------------------------------------------------------------- quotes */

test('a sealed quote is left for the crypto path', async () => {
    const peer = await peerWithFloor(500);
    const quote = { id: 600, username: 'bob', content: V2, has_attachment: false };

    assert.equal(await judgeQuotedRow(peer, { reply_to_id: 600, reply_to: quote }), quote);
});

test('a plaintext quote on a contact with no opened row: shown, marked in its own text', async () => {
    const peer = await pinnedPeer();

    const out = await judgeQuotedRow(peer, {
        reply_to_id: 600,
        reply_to: { id: 600, username: 'bob', content: 'old words', has_attachment: false },
    });

    assert.equal(out.content, 'Not encrypted: old words');
    assert.equal(out.id, 600);
    assert.equal(out.username, 'bob');
});

test('a plaintext quote of real history: shown, marked', async () => {
    const peer = await peerWithFloor(500);

    const out = await judgeQuotedRow(peer, {
        reply_to_id: 400,
        reply_to: { id: 400, username: 'bob', content: 'old words', has_attachment: false },
    });

    assert.equal(out.content, 'Not encrypted: old words');
});

test('a plaintext quote above the line: hidden, none of it carried', async () => {
    const peer = await peerWithFloor(500);

    const out = await judgeQuotedRow(peer, {
        reply_to_id: 600,
        reply_to: {
            id: 600,
            username: 'bob',
            content: 'I agree to pay you',
            has_attachment: true,
            attachment_name: 'proof.pdf',
            attachment_mime: 'application/pdf',
            attachment_meta: null,
        },
    });

    assert.equal(out.content, HIDDEN_UNENCRYPTED_TEXT);
    assert.equal(out.has_attachment, false);
    assert.ok(!JSON.stringify(out).includes('I agree to pay you'));
    assert.ok(!JSON.stringify(out).includes('proof.pdf'));
});

test('a quote claiming a low id the row itself does not point at: hidden', async () => {
    const peer = await peerWithFloor(500);

    // On a v2 row reply_to_id is sealed, so this is the server swapping the quote
    // under a real message, and giving the swap an id old enough to pass as history.
    const out = await judgeQuotedRow(peer, {
        reply_to_id: 600,
        reply_to: { id: 1, username: 'bob', content: 'I agree to pay you', has_attachment: false },
    });

    assert.equal(out.content, HIDDEN_UNENCRYPTED_TEXT);
});

test('a real envelope quoted beside an unsealed file: the envelope never reaches the screen', async () => {
    const peer = await peerWithFloor(500);

    const out = await judgeQuotedRow(peer, {
        reply_to_id: 400,
        reply_to: { id: 400, username: 'bob', content: V2, has_attachment: true, attachment_name: 'x.pdf', attachment_meta: null },
    });

    assert.equal(out.content, 'Not encrypted: file');
});

test("a quoted file with no sealed metadata does not show the server's file name", async () => {
    const peer = await peerWithFloor(500);

    const out = await judgeQuotedRow(peer, {
        reply_to_id: 400,
        reply_to: {
            id: 400,
            username: 'bob',
            content: '',
            has_attachment: true,
            attachment_name: 'pay-this-account.pdf',
            attachment_mime: 'application/pdf',
            attachment_meta: null,
        },
    });

    assert.equal(out.content, 'Not encrypted: file');
    assert.equal(out.has_attachment, false);
    assert.ok(!JSON.stringify(out).includes('pay-this-account'));
});

/* ---------------------------------------------------------------- previews */

test('list preview: marked on a contact with no opened row', async () => {
    const peer = await pinnedPeer();

    assert.equal(await unencryptedPreview(peer, 'hello'), 'Not encrypted: hello');
});

test('list preview: hidden once a row has opened, because the preview is the newest row', async () => {
    const peer = await peerWithFloor(500);

    assert.equal(await unencryptedPreview(peer, 'send me the code'), HIDDEN_UNENCRYPTED_TEXT);
});

test('list preview: the labels the server writes for a file with no caption pass through', async () => {
    const peer = await peerWithFloor(500);

    // Fixed strings from getConversationsHandler, not a message anyone wrote. Marking
    // them would put "Not encrypted" on every encrypted file.
    assert.equal(await unencryptedPreview(peer, '🎤 Voice message'), '🎤 Voice message');
    assert.equal(await unencryptedPreview(peer, '📎 Attachment'), '📎 Attachment');
    assert.equal(await unencryptedPreview(peer, '📎 Attachment!'), HIDDEN_UNENCRYPTED_TEXT, 'an exact match only');
});

test('list preview: nobody signed in means hidden', async () => {
    const peer = await pinnedPeer();
    currentUser = null;

    assert.equal(await unencryptedPreview(peer, 'hello'), HIDDEN_UNENCRYPTED_TEXT);
});

/* ---------------------------------------------------------------- wiring */

const dmSource = fs.readFileSync(new URL('../public/js/chat/dm.js', import.meta.url), 'utf8');

function functionBody(name) {
    const start = dmSource.search(new RegExp(`(?:export )?async function ${name}\\(`));
    assert.ok(start >= 0, `${name} not found in dm.js`);
    const next = dmSource.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
    return dmSource.slice(start, start + 1 + next);
}

test('wiring: a thread row is judged before any of it is used, and the result is marked', () => {
    const body = functionBody('decryptDmMessage');

    const judged = body.indexOf('mayShowUnencryptedRow');
    assert.ok(judged >= 0, 'decryptDmMessage must judge the row');
    assert.ok(judged < body.indexOf('decryptedContent ='), 'before any text is taken from it');
    assert.match(body, /throw new DmRowNotEncryptedError/);
    assert.match(body, /not_encrypted:/);
    assert.match(body, /noteOpenedDmRow/);
    assert.match(body, /judgeQuotedRow/);
});

test('wiring: rows that arrive now say so', () => {
    assert.match(functionBody('decryptLiveDmMessage'), /arrivedNow: true/);
    assert.match(functionBody('addDmMessage'), /decryptLiveDmMessage\(msg\)/);
    assert.match(functionBody('syncDmMessagesSince'), /decryptDmMessages\(messages, \{ arrivedNow: true \}\)/);
});

test('wiring: a page judges its unsealed rows after the rest, and by their place in it', () => {
    const body = functionBody('decryptDmMessages');

    assert.match(body, /firstSealedRowIndex/);
    assert.ok(body.indexOf('firstSealedRowIndex') > body.indexOf('allSettled'),
        'the rows that open are the evidence, so they go first');
});

test('wiring: an unencrypted edit is dropped, not rendered', () => {
    const body = functionBody('updateDmMessage');
    const refused = body.indexOf('isUnencryptedDmRow(msg)');

    assert.ok(refused >= 0);
    assert.ok(refused < body.indexOf('decryptDmMessage('), 'before anything else looks at it');
});

test('wiring: the list has no path that shows a row as it came', () => {
    const body = functionBody('decryptConversationPreview');

    assert.match(body, /unencryptedPreview\(/);
    assert.doesNotMatch(body, /String\(lastMessage\)/);
});

test('wiring: a hidden row announces nothing', () => {
    const body = functionBody('addDmMessage');
    const guard = body.indexOf('decrypted.undecryptable');

    assert.ok(guard >= 0);
    assert.ok(guard < body.indexOf('maybeNotifyDM('));
    assert.ok(guard < body.indexOf('messageSoundManager.playReceived('));
});
