// tests/groups/group-attachment-filename.test.mjs
//
// STEP 3D item 1: the receiver-side file-name sanitiser.
//
// The 3C sanitiser only stripped path separators, C0 controls and the bidi
// override range. It now also strips the zero-width and formatting
// characters (and their supplementary-plane cousins), refuses a name that is
// only dots or spaces, strips the trailing dots and spaces, collapses the
// leading dots (so the download is not a hidden file) and caps the DISPLAYED
// length to 120 characters with the extension kept - while the signed meta
// still allows 255.
//
// The DOM half of this (the visible text and the `download` attribute are
// identical, and the raw name never reaches the DOM) is proved with a real
// browser in tests/groups/group-attachment-browser.test.mjs.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const js = (rel) => pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', rel)
).href;

// The DOM-bound modules are mocked exactly the way
// tests/groups/group-attachment-ui.test.mjs mocks them (the sanitiser
// itself needs neither, but the module imports them).
mock.module(js('core/auth.js'), {
    namedExports: {
        getCurrentUser: () => null,
        getToken: () => 'fake-token',
        logout: () => {},
    },
});

const ga = await import(js('chat/group-attachments.js'));

/** The table the report quotes: input name -> displayed name. */
const TABLE = [
    ['photo.png', 'photo.png'],
    ['../../etc/passwd', 'etcpasswd'],
    ['a/b\\c.png', 'abc.png'],
    ['a\u0000b\u001fc.png', 'abc.png'],
    ['a\u202Eb.png', 'ab.png'],
    ['a\u061Cb.png', 'ab.png'],
    ['a\u200Bb.png', 'ab.png'],
    ['a\u200Cb.png', 'ab.png'],
    ['a\u200Db.png', 'ab.png'],
    ['a\u200Eb.png', 'ab.png'],
    ['a\u200Fb.png', 'ab.png'],
    ['a\u2028b.png', 'ab.png'],
    ['a\u2029b.png', 'ab.png'],
    ['a\u2060b.png', 'ab.png'],
    ['a\u2061b.png', 'ab.png'],
    ['a\u2062b.png', 'ab.png'],
    ['a\u2063b.png', 'ab.png'],
    ['a\u2064b.png', 'ab.png'],
    ['a\uFEFFb.png', 'ab.png'],
    ['a\uFE0Fb.png', 'ab.png'],
    ['a\u{E0061}b.png', 'ab.png'],
    ['a\u{E0101}b.png', 'ab.png'],
    ['.bashrc', 'bashrc'],
    ['..', 'file'],
    ['.', 'file'],
    ['...', 'file'],
    ['   ', 'file'],
    ['', 'file'],
    [null, 'file'],
    [undefined, 'file'],
    ['photo.png. ', 'photo.png'],
    ['photo.png...', 'photo.png'],
    ['  photo.png', 'photo.png'],
];

test('the sanitiser: input name -> displayed name', () => {
    for (const [input, expected] of TABLE) {
        assert.equal(
            ga.sanitiseGroupFileName(input),
            expected,
            `input ${JSON.stringify(input)} must display as ${JSON.stringify(expected)}`
        );
    }
});

test('the displayed name is capped at 120 characters and keeps the extension', () => {
    const long = `${'x'.repeat(200)}.png`;
    const shown = ga.sanitiseGroupFileName(long);
    assert.equal(shown.length, 120);
    assert.ok(shown.endsWith('.png'), `the extension must be kept: ${shown.slice(-10)}`);

    // A name whose "extension" is really part of the name: nothing is kept.
    const noExt = 'y'.repeat(200);
    assert.equal(ga.sanitiseGroupFileName(noExt).length, 120);
    assert.ok(!ga.sanitiseGroupFileName(noExt).includes('.'));

    // A long extension is not kept either.
    const longExt = `z${'.'}${'q'.repeat(40)}`;
    assert.ok(ga.sanitiseGroupFileName(longExt).length <= 120);
});

test('the signed meta limit stays 255 - the display cap does not change the wire format', () => {
    const name = 'n'.repeat(255);
    const plain = ga.buildGroupAttachmentPlaintext({ text: '', file: { name, mime: 'text/plain' } });
    const meta = ga.parseGroupAttachmentPlaintext(plain);
    assert.equal(meta.file.name.length, 255, 'the signed meta keeps the full 255 characters');
    // ... and the receiver still shows at most 120.
    assert.equal(ga.sanitiseGroupFileName(meta.file.name).length, 120);

    // The builder cuts a longer name to the limit (the pre-3D behaviour).
    const cut = ga.buildGroupAttachmentPlaintext({ text: '', file: { name: 'n'.repeat(256), mime: 'text/plain' } });
    assert.equal(JSON.parse(cut).file.name.length, 255);

    // A name OVER the limit on the wire is refused by the parser.
    const overTheWire = JSON.stringify({ v: 1, text: '', file: { name: 'n'.repeat(256), mime: 'text/plain' } });
    assert.equal(ga.parseGroupAttachmentPlaintext(overTheWire), null);
});

test('the sanitiser never returns an empty name and never a hidden one', () => {
    for (const input of TABLE.map(([i]) => i)) {
        const shown = ga.sanitiseGroupFileName(input);
        assert.ok(shown.length > 0, `the name must never be empty (input ${JSON.stringify(input)})`);
        assert.ok(!shown.startsWith('.'), `the name must not be hidden (input ${JSON.stringify(input)} -> ${shown})`);
        assert.ok(!shown.endsWith('.'), `the name must not end in a dot (input ${JSON.stringify(input)} -> ${shown})`);
        assert.ok(!shown.endsWith(' '), `the name must not end in a space (input ${JSON.stringify(input)} -> ${shown})`);
    }
});
