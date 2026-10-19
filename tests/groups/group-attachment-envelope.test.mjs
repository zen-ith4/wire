// tests/groups/group-attachment-envelope.test.mjs
//
// STEP 3D item 0: the caption cap can produce an envelope the server rejects.
//
// The client capped the caption at 60,000 CHARACTERS, but the caption is
// JSON-escaped, then UTF-8 encoded, then base64 encoded: 60,000 characters
// of newline are 160,000 envelope characters, 60,000 accents the same, and
// 60,000 NULs are 480,000 - far over the server's 90,000-character limit on
// `content`. The client now measures the ENVELOPE and refuses BEFORE the
// upload, so no counter is burned and no file is left on disk.
//
//   - the estimate is an upper bound of a REAL envelope;
//   - the worst-case captions are refused before any counter is reserved
//     (the nonce counter is asserted to be unchanged);
//   - the final guard measures the real envelope;
//   - the error tells the user how many characters are allowed.
//
// Real WebCrypto; the DOM-bound modules (core/auth.js, identity-service.js)
// are mocked exactly the way tests/groups/group-attachment-ui.test.mjs mocks
// them.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installWebLocksPolyfill, newDeviceStorage, useDeviceStorage, makeTestIdentity, makeSessionKeyProvider } from './helpers.mjs';

installWebLocksPolyfill();

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)
).href;

const identitiesByUserId = new Map();
let currentActorId = null;

mock.module(js('crypto/identity-service.js'), {
    namedExports: {
        getCurrentIdentity: () => {
            const id = identitiesByUserId.get(currentActorId);
            return id ? { privateKey: id.privateKey, publicKey: id.publicKey } : null;
        },
    },
});
mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => (currentActorId ? { id: currentActorId } : null),
        getToken: () => 'fake-token',
        logout: () => {},
    },
});

const identities = new Map();
const sessionProvider = makeSessionKeyProvider(identities);
mock.module(js('crypto/keys/session.js'), {
    namedExports: {
        getOrCreateSessionKey: (id) => sessionProvider.getOrCreateSessionKey(id),
        getOrCreateGroupKdmKey: (id) => sessionProvider.getOrCreateGroupKdmKey(id),
    },
});

const ga = await import(js('chat/group-attachments.js'));
const senderKey = await import(js('crypto/groups/sender-key.js'));
const keyStore = await import(js('crypto/groups/sender-key-store.js'));
const { rotateSenderKey } = await import(js('crypto/groups/rotation.js'));

const GROUP = 77;
const LIMIT = ga.MAX_GROUP_ATTACHMENT_ENVELOPE_CHARS;

async function user(id) {
    if (!identities.has(id)) identities.set(id, await makeTestIdentity(id));
    identitiesByUserId.set(id, identities.get(id));
    return identities.get(id);
}

async function device(identity) {
    const storage = newDeviceStorage();
    return {
        identity,
        async run(fn) {
            useDeviceStorage(storage);
            sessionProvider.setCurrentActor(identity.userId);
            currentActorId = identity.userId;
            return fn();
        },
    };
}

/** The six worst-case captions the task names. */
const WORST_CAPTIONS = [
    { label: '60,000 newlines', text: '\n'.repeat(60000) },
    { label: '60,000 double quotes', text: '"'.repeat(60000) },
    { label: '60,000 NUL', text: '\u0000'.repeat(60000) },
    { label: '60,000 accents (e-acute)', text: 'é'.repeat(60000) },
    { label: '60,000 emoji', text: '\u{1F600}'.repeat(60000) },
    { label: '60,000 ASCII', text: 'a'.repeat(60000) },
];

test('the envelope estimate is an upper bound of a REAL envelope', async () => {
    const alice = await user(1);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [1]));

    for (const caption of ['hello', 'x'.repeat(5000), 'é'.repeat(2000), '\n'.repeat(2000)]) {
        const file = new File([new Uint8Array(64)], 'note.txt', { type: 'text/plain' });
        const prepared = await A.run(() => ga.prepareGroupAttachmentUpload({ file, caption, groupId: GROUP }));
        const envelope = prepared.fields.content;
        const plaintext = ga.buildGroupAttachmentPlaintext({
            text: caption,
            file: { name: 'note.txt', mime: 'text/plain' },
        });
        const estimate = ga.estimateEnvelopeChars(plaintext);
        assert.ok(
            estimate >= envelope.length,
            `the estimate (${estimate}) must be >= the real envelope (${envelope.length}) for a caption of ${caption.length} chars`
        );
        // The bound is pessimistic, but not wildly so: the safety margin is
        // 2,000 characters.
        assert.ok(
            estimate - envelope.length <= ga.GROUP_ATTACHMENT_ENVELOPE_MARGIN,
            `the estimate must not exceed the real envelope by more than the margin (${estimate - envelope.length})`
        );
    }
});

test('the worst-case captions are refused BEFORE any counter is reserved', async () => {
    const alice = await user(2);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [alice.userId]));
    const mine = await A.run(() => senderKey.getMySenderKey(alice, GROUP));
    assert.ok(mine?.senderKeyId, 'Alice must have a Sender Key');

    const file = new File([new Uint8Array(64)], 'note.txt', { type: 'text/plain' });

    for (const { label, text } of WORST_CAPTIONS) {
        const before = await A.run(() => keyStore.readCounter(mine.senderKeyId));

        let refused = false;
        let typed = false;
        let measured = null;
        try {
            const prepared = await A.run(() => ga.prepareGroupAttachmentUpload({ file, caption: text, groupId: GROUP }));
            // Not refused: then the envelope must be within the limit.
            assert.ok(
                prepared.fields.content.length <= LIMIT,
                `${label}: the envelope (${prepared.fields.content.length}) must be <= the limit (${LIMIT})`
            );
        } catch (e) {
            refused = true;
            if (e instanceof ga.GroupAttachmentEnvelopeTooLargeError) {
                typed = true;
                measured = e.measured;
                assert.ok(e.measured > LIMIT, `${label}: the measured length must be over the limit`);
                assert.ok(typeof e.maxCaptionChars === 'number' && e.maxCaptionChars > 0, `${label}: the error must say how many characters are allowed`);
            } else {
                // The plain character cap fired first (an emoji is two UTF-16
                // code units, so 60,000 emoji are 120,000 code units).
                assert.match(
                    String(e?.message || ''),
                    /caption is longer than/i,
                    `${label}: a refusal must be the typed error or the character cap, got ${e?.name}: ${e?.message}`
                );
            }
        }

        const after = await A.run(() => keyStore.readCounter(mine.senderKeyId));
        if (refused) {
            assert.equal(after, before, `${label}: a refused caption must not move the nonce counter`);
        }
        if (measured !== null) {
            // The bound is what the user is told about.
            assert.ok(measured > LIMIT);
        }
    }
});

test('a caption that fits the CHARACTER cap but not the ENVELOPE cap is refused with the typed error', async () => {
    const alice = await user(4);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [alice.userId]));
    const mine = await A.run(() => senderKey.getMySenderKey(alice, GROUP));
    const file = new File([new Uint8Array(64)], 'note.txt', { type: 'text/plain' });

    // Each of these is 60,000 UTF-16 code units (so the character cap does
    // not fire) but far more than 60,000 bytes once escaped and encoded.
    // (60,000 ASCII DOES fit - 80,000 envelope characters - and 60,000 emoji
    // are 120,000 code units, so the character cap fires for them.)
    const fitsNeither = WORST_CAPTIONS.filter(
        (c) => c.label !== '60,000 emoji' && c.label !== '60,000 ASCII'
    );
    for (const { label, text } of fitsNeither) {
        const before = await A.run(() => keyStore.readCounter(mine.senderKeyId));
        let err = null;
        try {
            await A.run(() => ga.prepareGroupAttachmentUpload({ file, caption: text, groupId: GROUP }));
        } catch (e) {
            err = e;
        }
        assert.ok(err, `${label}: must be refused`);
        assert.ok(
            err instanceof ga.GroupAttachmentEnvelopeTooLargeError,
            `${label}: must be the typed envelope error, got ${err?.name}: ${err?.message}`
        );
        assert.ok(err.measured > LIMIT, `${label}: the measured length must be over the limit`);
        const after = await A.run(() => keyStore.readCounter(mine.senderKeyId));
        assert.equal(after, before, `${label}: the counter must not move`);
    }
});

test('the ASCII caption at the cap still fits, and the server would accept it', async () => {
    const alice = await user(3);
    const A = await device(alice);
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [alice.userId]));

    const file = new File([new Uint8Array(64)], 'note.txt', { type: 'text/plain' });
    const prepared = await A.run(() => ga.prepareGroupAttachmentUpload({
        file, caption: 'a'.repeat(60000), groupId: GROUP,
    }));
    assert.ok(
        prepared.fields.content.length <= LIMIT,
        `the 60,000-character ASCII caption must fit: ${prepared.fields.content.length} > ${LIMIT}`
    );
    assert.ok(
        prepared.fields.content.length <= ga.SERVER_MAX_CONTENT_CHARS,
        'the server must accept it'
    );
});

test('the final guard measures the REAL envelope', () => {
    const tooLong = 'x'.repeat(LIMIT + 1);
    assert.throws(
        () => ga.assertEnvelopeWithinLimit(tooLong, 0),
        (e) => e instanceof ga.GroupAttachmentEnvelopeTooLargeError && e.measured === LIMIT + 1,
        'an over-long envelope must be refused'
    );
    // Exactly at the limit is fine.
    assert.equal(ga.assertEnvelopeWithinLimit('x'.repeat(LIMIT), 0).length, LIMIT);
});

test('the refusal names the limit and the number of characters that are allowed', () => {
    let err = null;
    try {
        ga.assertCaptionFitsEnvelope('é'.repeat(60000), 120);
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'the check must refuse');
    assert.match(err.message, /too long/i);
    assert.match(err.message, new RegExp(String(LIMIT)));
    // The number it reports is the plain-ASCII maximum - which is ABOVE the
    // 60,000-character caption cap, so for plain ASCII the caption cap is the
    // binding rule and for everything else the envelope rule is.
    assert.ok(err.maxCaptionChars > 0, `maxCaptionChars=${err.maxCaptionChars}`);
    assert.ok(err.maxCaptionChars >= 60000, `the ASCII maximum must be at least the caption cap: ${err.maxCaptionChars}`);
});
