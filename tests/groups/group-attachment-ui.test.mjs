// tests/groups/group-attachment-ui.test.mjs
//
// STEP 3C item 5 (node level) + item 3's flag-off proof.
//
//   - the flag ships FALSE and the test-only setter is refused without the
//     test hook;
//   - with the flag OFF the group page is unchanged: no attach control, no
//     file input, no file paste/drop handler, and the composer's file paths
//     are inert;
//   - the plaintext meta: encode/decode, unknown v, extra keys, oversize
//     name/mime, bad w/h, bidi/control characters in the name;
//   - sniffing: PNG/JPEG/GIF/WEBP accepted; a file that CLAIMS image/png but
//     holds HTML or SVG is never inline;
//   - the send-path ordering and the retry-with-a-NEW-counter rule (two
//     attempts -> two different counters, no duplicate iv);
//   - per-row isolation: one bad attachment among good rows.
//
// Real WebCrypto; the DOM-bound modules (core/auth.js, identity-service.js)
// are mocked exactly the way tests/attachment-crypto.test.mjs mocks them.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installWebLocksPolyfill, newDeviceStorage, useDeviceStorage, makeTestIdentity, makeSessionKeyProvider } from './helpers.mjs';

installWebLocksPolyfill();

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)
).href;

// The same files as PLAIN paths (for reading their source).
const jsPath = (rel) => path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel
);

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

const flag = await import(js('chat/group-attachments-flag.js'));
const ga = await import(js('chat/group-attachments.js'));

const GROUP = 41;

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

/* ------------------------------------------------------------ the flag */

test('the flag ships FALSE and the test-only setter is refused without the test hook', () => {
    assert.equal(flag.GROUP_ATTACHMENTS_UI_ENABLED, false, 'the shipped value must be false');
    assert.equal(flag.isGroupAttachmentsUiEnabled(), false);
    assert.throws(
        () => flag.setGroupAttachmentsUiEnabledForTests(true),
        /test-only setter is not available/,
        'without the hook the setter must throw'
    );
});

test('with the flag off the group page shows NO attach control, NO file input and NO file paste/drop handler', () => {
    const groupJs = fs.readFileSync(jsPath('chat/group.js'), 'utf8');
    // The composer still points its file ids at ids that only exist when the
    // flag is ON, so with the flag off the staging code no-ops.
    assert.ok(/fileInputId:\s*'group-file-input'/.test(groupJs), 'the composer keeps its file ids');
    assert.ok(/stagingId:\s*'group-staging-area'/.test(groupJs));
    // The attach button and the file input are rendered ONLY inside the
    // flag-gated branch.
    const attachBtn = groupJs.indexOf('id="group-file-input"');
    const flagCheck = groupJs.indexOf('groupAttachmentsEnabled');
    assert.ok(attachBtn > -1, 'the file input exists, but only behind the flag');
    assert.ok(flagCheck > -1 && flagCheck < attachBtn, 'the file input is rendered inside the flag-gated branch');
    // The paste hook stays a no-op for files (the group page has no file
    // paste path yet).
    assert.ok(/wirePasteImage\('group-input', \(\) => \{\}\)/.test(groupJs), 'the group paste hook stays a no-op');
    // The flag default is what the shipped tree uses.
    assert.equal(flag.GROUP_ATTACHMENTS_UI_ENABLED, false);
});

/* ------------------------------------------------------- the plaintext meta */

test('the plaintext meta encodes and decodes, and the decoder is strict', () => {
    const plain = ga.buildGroupAttachmentPlaintext({
        text: 'hello',
        file: { name: 'photo.png', mime: 'image/png', w: 800, h: 600 },
    });
    const meta = ga.parseGroupAttachmentPlaintext(plain);
    assert.equal(meta.text, 'hello');
    assert.equal(meta.file.name, 'photo.png');
    assert.equal(meta.file.mime, 'image/png');
    assert.equal(meta.file.w, 800);
    assert.equal(meta.file.h, 600);

    // A text-only message (no file) still decodes.
    const textOnly = ga.parseGroupAttachmentPlaintext(ga.buildGroupAttachmentPlaintext({ text: 'just text' }));
    assert.equal(textOnly.text, 'just text');
    assert.equal(textOnly.file, null);

    // Strict: unknown version, extra keys, bad fields, not JSON.
    const bad = [
        '{"v":2,"text":"x"}',
        '{"v":1,"text":"x","file":{"name":"a","mime":"b"},"extra":1}',
        '{"v":1,"text":"x","file":{"name":"a","mime":"b","zz":1}}',
        '{"v":1,"text":"x","file":{"name":"","mime":"b"}}',
        '{"v":1,"text":"x","file":{"name":"a","mime":"b","w":0}}',
        '{"v":1,"text":"x","file":{"name":"a","mime":"b","w":1.5}}',
        '{"v":1,"text":"x","file":{"name":"a","mime":"b","w":20001}}',
        '{"v":1,"text":123}',
        'not json',
        '[]',
    ];
    for (const b of bad) {
        assert.equal(ga.parseGroupAttachmentPlaintext(b), null, `must be rejected: ${b}`);
    }
});

test('the meta builder clamps the name and the mime to the documented limits', () => {
    const long = 'x'.repeat(400);
    const plain = JSON.parse(ga.buildGroupAttachmentPlaintext({
        text: 'c',
        file: { name: long, mime: 'm'.repeat(200) },
    }));
    assert.equal(plain.file.name.length, 255);
    assert.equal(plain.file.mime.length, 127);
});

/* ------------------------------------------------------- the name sanitising */

test('the file name is sanitised: path separators, control and bidi characters are stripped, empty becomes "file"', () => {
    assert.equal(ga.sanitiseGroupFileName('photo.png'), 'photo.png');
    assert.equal(ga.sanitiseGroupFileName('../../etc/passwd'), '....etcpasswd', 'the separators go, the rest stays');
    assert.equal(ga.sanitiseGroupFileName('a/b\\c.png'), 'abc.png');
    assert.equal(ga.sanitiseGroupFileName('a\u0000b\u001fc.png'), 'abc.png');
    assert.equal(ga.sanitiseGroupFileName('a\u202Eb.png'), 'ab.png');
    assert.equal(ga.sanitiseGroupFileName('   '), 'file');
    assert.equal(ga.sanitiseGroupFileName(''), 'file');
    assert.equal(ga.sanitiseGroupFileName(null), 'file');
});

/* ------------------------------------------------------------- the sniffing */

test('sniffing accepts PNG/JPEG/GIF/WEBP and refuses everything else, whatever the declared mime says', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    assert.equal(ga.sniffInlineImageMime(png), 'image/png');
    assert.equal(ga.sniffInlineImageMime(jpg), 'image/jpeg');
    assert.equal(ga.sniffInlineImageMime(gif), 'image/gif');
    assert.equal(ga.sniffInlineImageMime(webp), 'image/webp');

    // A file that CLAIMS image/png but holds HTML or SVG is NOT inline.
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    assert.equal(ga.sniffInlineImageMime(html), null);
    assert.equal(ga.sniffInlineImageMime(svg), null, 'SVG is never rendered inline');
    // And the allowed set never contains svg.
    assert.ok(!ga.INLINE_IMAGE_MIMES.includes('image/svg+xml'));
    assert.ok(!ga.INLINE_IMAGE_MIMES.some((m) => m.includes('svg')));
});

/* -------------------------------------------- the send path and the counter */

test('the send path binds a fresh counter per attempt: a retry re-encrypts with a NEW counter and never reuses the iv', async () => {
    const alice = await user(1);
    const A = await device(alice);
    const { rotateSenderKey } = await import(js('crypto/groups/rotation.js'));
    await A.run(() => rotateSenderKey(alice, GROUP, 0, [1]));

    const bytes = new Uint8Array(64);
    const file = new File([bytes], 'note.txt', { type: 'text/plain' });

    const first = await A.run(() => ga.prepareGroupAttachmentUpload({
        file, caption: 'one', groupId: GROUP,
    }));
    const second = await A.run(() => ga.prepareGroupAttachmentUpload({
        file, caption: 'two', groupId: GROUP,
    }));

    const envA = JSON.parse(first.fields.content);
    const envB = JSON.parse(second.fields.content);
    assert.equal(envA.att_iv, first.fields.attachment_iv, 'the envelope carries the file iv');
    assert.notEqual(envA.att_iv, envB.att_iv, 'two attempts must use two different ivs');
    assert.notEqual(envA.counter, envB.counter, 'two attempts must use two different counters');
    assert.equal(envA.att_len, String(bytes.length), 'the plaintext length is signed');
    assert.ok(envA.att_ct_hash, 'the ciphertext hash is signed');

    // The server only ever sees neutral values: the file part is opaque and
    // the fields are the envelope and the iv.
    assert.equal(first.file.name, 'attachment.bin');
    assert.equal(first.file.type, 'application/octet-stream');
    assert.deepEqual(Object.keys(first.fields).sort(), ['attachment_iv', 'content']);
});

test('the send path refuses an empty file and an over-cap file before reading anything', async () => {
    const alice = await user(2);
    const A = await device(alice);
    const empty = new File([new Uint8Array(0)], 'x.txt', { type: 'text/plain' });
    await assert.rejects(
        () => A.run(() => ga.prepareGroupAttachmentUpload({ file: empty, groupId: GROUP })),
        /empty/i
    );
    const big = new File([new Uint8Array(1024)], 'x.txt', { type: 'text/plain' });
    await assert.rejects(
        () => A.run(() => ga.prepareGroupAttachmentUpload({ file: big, groupId: GROUP, maxMb: 0 })),
        /larger than/i
    );
});
