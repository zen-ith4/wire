// C3: encodeRfc5987 must be used instead of encodeURIComponent in
// Content-Disposition filename*= headers. encodeRfc5987 additionally
// encodes ' ( ) * which encodeURIComponent leaves alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRfc5987 } from '../utils/mediaKind.js';
import { startRealServer, registerUser, restLogin } from './_acceptance-harness.mjs';

test('encodeRfc5987 encodes apostrophe, parens, asterisk', () => {
  const name = "it's (1).jpg";
  const encoded = encodeRfc5987(name);
  // encodeURIComponent leaves ' ( ) * unencoded; encodeRfc5987 encodes them.
  assert.equal(
    encoded,
    "it%27s%20%281%29.jpg",
    'RFC 5987 must encode apostrophe and parens'
  );
  assert.notEqual(
    encoded,
    encodeURIComponent(name),
    'encodeRfc5987 differs from encodeURIComponent'
  );
});

test('encodeRfc5987 handles normal filenames', () => {
  assert.equal(encodeRfc5987('document.pdf'), 'document.pdf');
  assert.equal(encodeRfc5987('photo.jpg'), 'photo.jpg');
});

// C3: previewFile must emit RFC 5987 filename* encoding in
// Content-Disposition, so a name like "it's (1).jpg" is emitted as
// filename*=UTF-8''it%27s%20%281%29.jpg rather than being truncated
// at the apostrophe/parens. Runs against the real server so the real
// previewFile handler (auth, folder access, file resolution, mime
// sniffing, header setting) is exercised end to end.

const OWNER = 'rfc5987-owner';
const FOLDER = 'Rfc5987Folder';
const BYTES = Buffer.from('not an image, just bytes', 'utf8'); // not inline-safe -> attachment branch
const FILENAME = "it's (1).jpg";

let server;
let owner;
let folderId;

before(async () => {
    server = await startRealServer();
    await registerUser(server.origin, OWNER);
    owner = await restLogin(server.origin, OWNER);

    const created = await owner.api('/api/share/folders', {
        method: 'POST',
        body: JSON.stringify({ name: FOLDER }),
    });
    assert.equal(created.status, 200, `create folder: ${created.status} ${JSON.stringify(created.body)}`);
    folderId = created.body.id;
});

after(async () => {
    if (server) await server.stop();
});

test('previewFile sets Content-Disposition with RFC 5987 filename*', async () => {
    // Upload a real file named "it's (1).jpg" into the folder.
    const form = new FormData();
    form.set('subpath', '');
    form.set('file', new Blob([BYTES]), FILENAME);
    const up = await fetch(`${server.origin}/api/files/upload/${folderId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}` },
        body: form,
    });
    assert.equal(up.status, 200, `upload: ${up.status} ${await up.text()}`);

    // Call the real preview handler via HTTP and inspect the header.
    const res = await fetch(
        `${server.origin}/api/files/preview/${folderId}?file=${encodeURIComponent(FILENAME)}`,
        { headers: { Authorization: `Bearer ${owner.token}` } }
    );
    assert.equal(res.status, 200, `preview: ${res.status} ${await res.text()}`);

    const cd = res.headers.get('content-disposition');
    assert.ok(cd, 'Content-Disposition header must be set');
    assert.ok(
        cd.includes(`filename*=UTF-8''it%27s%20%281%29.jpg`),
        `Expected RFC 5987 encoding filename*=UTF-8''it%27s%20%281%29.jpg, got: ${cd}`
    );
});
