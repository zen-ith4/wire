// DM attachment E2EE, end to end: REAL Express + Socket.IO + SQLite
// server (file-backed DB) and REAL client code (jsdom actors running
// the unmodified public/js modules, real session crypto).
import { TEST_ROOT } from './_env.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDmServer, createUser, prepareAsClient, postUpload, authGet, capturedLogs } from './_harness.mjs';

const DM_DIR = process.env.DM_UPLOAD_DIR;
let server;
let alice;
let bob;
let carol;

const CS = 64 * 1024;
const TAG = 16;
const HDR = 8;

function bytesPattern(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >>> 16; }
  return out;
}

function pngBytes() {
  return Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
}

before(async () => {
  server = await startDmServer();
  alice = await createUser(server, 'alice');
  bob = await createUser(server, 'bob');
  carol = await createUser(server, 'carol');
});

after(async () => {
  await server.stop();
  delete process.env.DM_E2EE_ATTACHMENTS_ENFORCED;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

async function send(sender, peer, opts) {
  const prepared = await prepareAsClient(sender, peer, opts);
  const res = await postUpload(server, sender, peer.id, prepared);
  return { prepared, ...res };
}

async function history(user, peer) {
  const res = await authGet(server, user, `/api/dm/messages/${peer.id}/recent`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return Array.isArray(body) ? body : body.messages;
}

// Runs the REAL recipient-side client code on a history row.
async function receive(recipient, sender, row, { download = true } = {}) {
  recipient.actor.use();
  const e2ee = await recipient.actor.importModule('media/attachment-e2ee.js');
  const stream = await recipient.actor.importModule('crypto/messages/attachment-stream.js');
  const msg = await e2ee.applyAttachmentMeta(row, sender.id, 'dm');
  let blob = null;
  let error = null;
  if (download && !msg.attachment_unreadable) {
    const res = await authGet(server, recipient, `/api/dm/attachments/${row.id}?download=1`);
    const secret = e2ee.getAttachmentSecret('dm', row.id);
    try {
      blob = await stream.decryptAttachmentStream(new Uint8Array(await res.arrayBuffer()), secret.rawKey, secret.baseIv, msg.attachment_mime);
    } catch (e) { error = e; }
  }
  return { msg, blob, error, e2ee, stream };
}

const TYPES = [
  { kind: 'image', name: 'photo.png', mime: 'image/png', bytes: () => pngBytes(), isVoice: false },
  { kind: 'audio', name: 'song.mp3', mime: 'audio/mpeg', bytes: () => bytesPattern(CS * 2 + 3, 2), isVoice: false },
  { kind: 'video', name: 'clip.mp4', mime: 'video/mp4', bytes: () => bytesPattern(CS * 3, 3), isVoice: false },
  { kind: 'voice', name: 'voice-message.webm', mime: 'audio/webm', bytes: () => bytesPattern(5000, 4), isVoice: true },
  { kind: 'file', name: 'report.pdf', mime: 'application/pdf', bytes: () => bytesPattern(777, 5), isVoice: false },
  { kind: 'empty file', name: 'empty.txt', mime: 'text/plain', bytes: () => new Uint8Array(0), isVoice: false },
];

for (const t of TYPES) {
  test(`round trip (${t.kind}): server stores opaque ciphertext, recipient restores everything`, async () => {
    const bytes = t.bytes();
    const caption = `caption for ${t.kind}`;
    const sent = await send(alice, bob, { bytes, name: t.name, mime: t.mime, caption, isVoice: t.isVoice });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    // What the server returned/stored is neutral.
    assert.equal(sent.body.attachment_mime, 'application/octet-stream');
    assert.equal(sent.body.attachment_name, 'encrypted-attachment');
    assert.equal(sent.body.attachment_width, null);
    assert.equal(sent.body.attachment_height, null);
    assert.equal(Boolean(sent.body.is_voice_message), false);
    assert.equal(sent.body.has_attachment, true);
    assert.ok(!sent.body.content.includes(caption), 'caption is not plaintext');
    assert.ok(typeof sent.body.attachment_meta === 'string' && !sent.body.attachment_meta.includes(t.name));

    const row = (await history(bob, alice)).find((m) => m.id === sent.body.id);
    const { msg, blob, error } = await receive(bob, alice, row);
    assert.equal(error, null);
    assert.equal(msg.attachment_name, t.name);
    assert.equal(msg.attachment_mime, t.mime);
    assert.equal(msg.is_voice_message, t.isVoice);
    assert.equal(msg.attachment_e2ee, true);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
    assert.equal(blob.type, t.mime);
  });
}

test('sender can also read their own sent attachment back (history for sender)', async () => {
  const bytes = bytesPattern(CS + 9, 77);
  const sent = await send(alice, bob, { bytes, name: 'mine.bin', mime: 'application/zip' });
  const row = (await history(alice, bob)).find((m) => m.id === sent.body.id);
  const { msg, blob, error } = await receive(alice, bob, row);
  assert.equal(error, null);
  assert.equal(msg.attachment_name, 'mine.bin');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test('PNG dimensions are carried inside the encrypted meta, not in server columns', async () => {
  const sent = await send(alice, bob, { bytes: pngBytes(), name: 'dim.png', mime: 'image/png' });
  const row = server.db.prepare('SELECT attachment_width, attachment_height FROM direct_messages WHERE id = ?').get(sent.body.id);
  assert.equal(row.attachment_width, null);
  assert.equal(row.attachment_height, null);
});

// ---------------------------------------------------------------- plaintext

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

function grepAll(needle, extraFiles = []) {
  const buf = Buffer.from(needle);
  const hits = [];
  for (const f of [...walk(DM_DIR), ...extraFiles]) {
    if (fs.existsSync(f) && fs.readFileSync(f).includes(buf)) hits.push(f);
  }
  return hits;
}

test('plaintext check: a unique marker never reaches uploads, SQLite files or logs', async () => {
  const MARKER = `UNIQ-MARKER-${Date.now()}-c0ffee-PLAINTEXT`;
  const NAME_MARKER = `NAME-${MARKER}.png`;
  const bytes = new Uint8Array(CS + 500);
  bytes.set(new TextEncoder().encode(MARKER), 10);
  bytes.set(new TextEncoder().encode(MARKER), CS + 100);

  const sent = await send(alice, bob, { bytes, name: NAME_MARKER, mime: 'image/png', caption: `cap ${MARKER}` });
  assert.equal(sent.status, 200);
  await send(alice, bob, { bytes, name: NAME_MARKER, mime: 'audio/webm', isVoice: true });

  try { server.db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* not WAL */ }
  const dbFiles = ['', '-wal', '-shm'].map((s) => process.env.DB_PATH + s);

  // Positive control: the grep really finds a planted marker.
  const control = path.join(TEST_ROOT, 'control.bin');
  fs.writeFileSync(control, Buffer.from(`xx${MARKER}xx`));
  assert.deepEqual(grepAll(MARKER, [control]), [control], 'grep control must find a plaintext marker');

  assert.deepEqual(grepAll(MARKER, dbFiles), [], 'marker found on disk');
  assert.deepEqual(grepAll(NAME_MARKER, dbFiles), [], 'file name found on disk');
  assert.ok(!capturedLogs.some((l) => l.includes(MARKER)), 'marker found in logs');
  assert.ok(!capturedLogs.some((l) => l.includes(NAME_MARKER)), 'file name found in logs');

  // Row-level: nothing descriptive in any column.
  const rows = server.db.prepare('SELECT * FROM direct_messages WHERE id = ?').all(sent.body.id);
  assert.ok(!JSON.stringify(rows).includes(MARKER));
  assert.ok(!JSON.stringify(rows).includes('.png'));
});

test('on-disk file name is a bare uuid: no extension, no original name', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(50), name: 'secret-plans.docx', mime: 'application/msword' });
  const stored = server.db.prepare('SELECT attachment_path FROM direct_messages WHERE id = ?').get(sent.body.id).attachment_path;
  assert.match(stored, /^[0-9a-f-]{36}$/);
  assert.ok(fs.existsSync(path.join(DM_DIR, stored)));
});

test('keys never appear in the server database or logs', async () => {
  const prepared = await prepareAsClient(alice, bob, { bytes: bytesPattern(300, 9), name: 'k.bin' });
  const res = await postUpload(server, alice, bob.id, prepared);
  assert.equal(res.status, 200);
  alice.actor.use();
  const e2ee = await alice.actor.importModule('media/attachment-e2ee.js');
  const stream = await alice.actor.importModule('crypto/messages/attachment-stream.js');
  const row = (await history(alice, bob)).find((m) => m.id === res.body.id);
  await e2ee.applyAttachmentMeta(row, bob.id, 'dm');
  const secret = e2ee.getAttachmentSecret('dm', res.body.id);
  const keyB64 = stream.streamBytesToBase64(secret.rawKey);
  assert.deepEqual(grepAll(keyB64, ['', '-wal', '-shm'].map((s) => process.env.DB_PATH + s)), []);
  assert.ok(!capturedLogs.some((l) => l.includes(keyB64)));
});

// ------------------------------------------------------- enforcement / shape

function rawForm(fields, fileBytes, fileName = 'x.bin', fileType = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new File([fileBytes], fileName, { type: fileType }), fileName);
  form.append('recipient_id', String(bob.id));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

async function rawPost(form, user = alice) {
  const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function countFiles() { return walk(DM_DIR).length; }

// The server unlinks a rejected upload right AFTER it has answered, so the
// file may still exist for a few milliseconds. Wait for it to settle; a
// real leak never settles and still fails here.
async function assertFileCountSettles(expected, label) {
  const deadline = Date.now() + 3000;
  while (countFiles() !== expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(countFiles(), expected, label);
}

test('enforced: plaintext uploads are rejected and leave no file behind', async () => {
  const before = countFiles();
  const plainPng = pngBytes();
  for (const [label, fields, file, type] of [
    ['no meta, plaintext png', {}, plainPng, 'image/png'],
    ['no meta + plaintext caption', { content: 'hello' }, plainPng, 'image/png'],
    ['voice flag, no meta', { is_voice_message: '1' }, bytesPattern(500), 'audio/webm'],
  ]) {
    const r = await rawPost(rawForm(fields, file, 'a.png', type));
    assert.equal(r.status, 400, label);
  }
  await assertFileCountSettles(before, 'rejected uploads must be unlinked');
});

test('enforced: malformed encrypted-shape uploads are rejected', async () => {
  const good = await prepareAsClient(alice, bob, { bytes: bytesPattern(100), name: 'g.bin' });
  const goodBytes = new Uint8Array(await good.file.arrayBuffer());
  const f = good.fields;
  const before = countFiles();

  const cases = [
    ['plaintext body with valid-looking meta', f, bytesPattern(200)],
    ['truncated below header+tag', f, goodBytes.slice(0, 10)],
    ['length not on a chunk boundary shape', f, new Uint8Array([...goodBytes, ...new Uint8Array(CS + TAG + 3)].slice(0, HDR + CS + TAG + 3))],
    ['bad iv', { ...f, attachment_iv: 'AAAA' }, goodBytes],
    ['missing iv', { attachment_meta: f.attachment_meta }, goodBytes],
    ['meta not an envelope', { ...f, attachment_meta: JSON.stringify({ hello: 'world' }) }, goodBytes],
    ['meta not JSON', { ...f, attachment_meta: 'plain text' }, goodBytes],
    ['meta too large', { ...f, attachment_meta: JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(9000) } }) }, goodBytes],
    ['plaintext caption', { ...f, content: 'hello in the clear' }, goodBytes],
  ];
  for (const [label, fields, bytes] of cases) {
    const r = await rawPost(rawForm(fields, bytes));
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
  }
  await assertFileCountSettles(before, 'malformed uploads must be unlinked');
  // and the well-formed one still passes
  assert.equal((await rawPost(rawForm(f, goodBytes))).status, 200);
});

test('the server never trusts file content or the claimed type', async () => {
  // HTML/SVG/script bait inside a perfectly valid encrypted container.
  const bait = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  const sent = await send(alice, bob, { bytes: bait, name: 'evil.html', mime: 'text/html' });
  assert.equal(sent.status, 200);

  const res = await authGet(server, bob, `/api/dm/attachments/${sent.body.id}`);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-disposition') || '', /^attachment;/);
  assert.match(res.headers.get('content-disposition') || '', /attachment\.bin/);
  assert.ok(!(await res.text()).includes('<script>'));
});

test('served opaque even if the stored mime column were poisoned (row decides, not client)', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(40), name: 'p.png', mime: 'image/png' });
  // image/png is on the legacy inline-safe list, so a mutant that serves
  // by the stored mime (instead of by the attachment_meta row) is caught.
  server.db.prepare("UPDATE direct_messages SET attachment_mime = 'image/png' WHERE id = ?").run(sent.body.id);
  const res = await authGet(server, bob, `/api/dm/attachments/${sent.body.id}`);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition') || '', /^attachment;/);
});

test('Range requests on ciphertext: 206 slices, 416 out of range, full body otherwise', async () => {
  const bytes = bytesPattern(CS * 2 + 100, 31);
  const sent = await send(alice, bob, { bytes, name: 'r.mp4', mime: 'video/mp4' });
  const full = new Uint8Array(await (await authGet(server, bob, `/api/dm/attachments/${sent.body.id}?download=1`)).arrayBuffer());
  assert.equal(full.length, HDR + bytes.length + 3 * TAG);

  const part = await authGet(server, bob, `/api/dm/attachments/${sent.body.id}`, { Range: 'bytes=10-99' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-99/${full.length}`);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), full.slice(10, 100));
  assert.equal(part.headers.get('content-type'), 'application/octet-stream');

  const bad = await authGet(server, bob, `/api/dm/attachments/${sent.body.id}`, { Range: `bytes=${full.length + 5}-` });
  assert.equal(bad.status, 416);
});

test('only the two participants can fetch an attachment', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(30), name: 'p.bin' });
  for (const [u, expected] of [[alice, 200], [bob, 200]]) {
    assert.equal((await authGet(server, u, `/api/dm/attachments/${sent.body.id}?download=1`)).status, expected);
  }
  const res = await authGet(server, carol, `/api/dm/attachments/${sent.body.id}?download=1`);
  assert.ok([403, 404].includes(res.status), `carol got ${res.status}`);
  const unauth = await globalThis.__nodeFetch(`${server.origin}/api/dm/attachments/${sent.body.id}?download=1`);
  assert.equal(unauth.status, 401);
});

test('deleting the message removes the ciphertext file from disk', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(64), name: 'del.bin' });
  const stored = server.db.prepare('SELECT attachment_path FROM direct_messages WHERE id = ?').get(sent.body.id).attachment_path;
  assert.ok(fs.existsSync(path.join(DM_DIR, stored)));
  const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages/${sent.body.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(DM_DIR, stored)), false);
});

// ------------------------------------------------------------------ tamper

test('tampered ciphertext on the server: decryption fails, nothing is returned', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(CS * 2, 41), name: 't.mp4', mime: 'video/mp4' });
  const stored = server.db.prepare('SELECT attachment_path FROM direct_messages WHERE id = ?').get(sent.body.id).attachment_path;
  const file = path.join(DM_DIR, stored);
  const data = fs.readFileSync(file);
  data[HDR + CS + TAG + 20] ^= 0x01;
  fs.writeFileSync(file, data);

  const row = (await history(bob, alice)).find((m) => m.id === sent.body.id);
  const { blob, error, stream } = await receive(bob, alice, row);
  assert.equal(blob, null);
  assert.ok(error && error.name === 'AttachmentDecryptError', String(error));
  void stream;
});

test('server cannot swap the IV: receiver uses the IV inside the encrypted meta', async () => {
  const bytes = bytesPattern(CS + 7, 51);
  const sent = await send(alice, bob, { bytes, name: 'iv.bin' });
  server.db.prepare("UPDATE direct_messages SET attachment_iv = 'AAAAAAAAAAAAAAAA' WHERE id = ?").run(sent.body.id);
  const row = (await history(bob, alice)).find((m) => m.id === sent.body.id);
  const { blob, error } = await receive(bob, alice, row);
  assert.equal(error, null);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test('tampered or foreign meta envelope: safe placeholder, never a crash', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(80), name: 'm.bin' });
  const row = (await history(bob, alice)).find((m) => m.id === sent.body.id);

  const env = JSON.parse(row.attachment_meta);
  const ct = Buffer.from(env.encryption.ciphertext, 'base64');
  ct[0] ^= 1;
  env.encryption.ciphertext = ct.toString('base64');

  const variants = [
    { ...row, attachment_meta: JSON.stringify(env) },
    { ...row, attachment_meta: 'not json at all' },
    { ...row, attachment_meta: JSON.stringify({ encryption: { version: 1 } }) },
  ];
  for (const v of variants) {
    const { msg, blob } = await receive(bob, alice, v);
    assert.equal(msg.attachment_unreadable, true);
    assert.equal(msg.attachment_name, 'Attachment unavailable');
    assert.equal(msg.attachment_mime, 'application/octet-stream');
    assert.equal(msg.is_voice_message, false);
    assert.equal(blob, null);
  }
});

test('UI: renderAttachment shows a safe placeholder for an unreadable attachment', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(80), name: 'ui.png', mime: 'image/png' });
  const row = (await history(bob, alice)).find((m) => m.id === sent.body.id);
  const broken = { ...row, attachment_meta: 'garbage' };
  const { msg, e2ee } = await receive(bob, alice, broken);
  bob.actor.use();
  const att = await bob.actor.importModule('media/attachments.js');
  let html;
  assert.doesNotThrow(() => { html = att.renderAttachment(msg, 'dm'); });
  assert.ok(html.includes('Attachment unavailable'));
  assert.ok(!html.includes('<img'), 'no image element for an unreadable attachment');
  assert.equal(e2ee.isAttachmentUnreadable('dm', row.id), true);
});

test('UI: reply preview of an encrypted attachment is decrypted for display', async () => {
  const sent = await send(alice, bob, { bytes: bytesPattern(90), name: 'reply-me.pdf', mime: 'application/pdf' });
  const replyRes = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages/${bob.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: alice.id, content: JSON.stringify({ encryption: { version: 1, algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' } }), reply_to_id: sent.body.id }),
  }).catch(() => null);
  void replyRes; // endpoint shape is not part of this test's contract

  const rows = await history(alice, bob);
  const row = rows.find((m) => m.id === sent.body.id);
  assert.ok(row.attachment_meta, 'history rows expose the opaque envelope');
  alice.actor.use();
  const e2ee = await alice.actor.importModule('media/attachment-e2ee.js');
  const preview = await e2ee.applyReplyAttachmentMeta({ id: row.id, attachment_name: 'encrypted-attachment', attachment_mime: 'application/octet-stream', attachment_meta: row.attachment_meta }, bob.id);
  assert.equal(preview.attachment_name, 'reply-me.pdf');
  assert.equal(preview.attachment_mime, 'application/pdf');
  assert.equal('attachment_meta' in preview, false);
  assert.equal(e2ee.getAttachmentSecret('dm', row.id), null, 'reply previews never register a key');
});

// ------------------------------------------------------------- rollback flag

test('flag OFF (rollback): legacy plaintext uploads work again; encrypted uploads still encrypted', async () => {
  process.env.DM_E2EE_ATTACHMENTS_ENFORCED = 'false';
  try {
    const legacy = await rawPost(rawForm({}, pngBytes(), 'legacy.png', 'image/png'));
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.attachment_mime, 'image/png');

    const sent = await send(alice, bob, { bytes: bytesPattern(60), name: 'enc.bin' });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.attachment_mime, 'application/octet-stream');

    // legacy row is still served by the legacy path (inline-safe image)
    const res = await authGet(server, bob, `/api/dm/attachments/${legacy.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  } finally {
    delete process.env.DM_E2EE_ATTACHMENTS_ENFORCED;
  }
  assert.equal((await rawPost(rawForm({}, pngBytes(), 'legacy.png', 'image/png'))).status, 400);
});

// ------------------------------------------- non-attachment regression tour

test('regression: DM text, reply (incl. reply to an attachment), reactions, conversation list', async () => {
  const enc = async (sender, peer, text) => {
    sender.actor.use();
    const mod = await sender.actor.importModule('crypto/messages/message-crypto.js');
    return JSON.stringify(await mod.encryptOutgoingMessage(text, sender.id, peer.id));
  };
  const post = async (user, body) => {
    const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const dec = async (user, peer, row) => {
    user.actor.use();
    const mod = await user.actor.importModule('crypto/messages/message-crypto.js');
    return mod.decryptIncomingMessage(JSON.parse(row.content), peer.id);
  };

  // plain text DM, both directions
  const t1 = await post(alice, { recipient_id: bob.id, content: await enc(alice, bob, 'hello bob') });
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  assert.equal(t1.body.has_attachment, false);
  assert.equal(t1.body.attachment_meta ?? null, null);
  assert.equal(await dec(bob, alice, t1.body), 'hello bob');

  // reply to the text message
  const t2 = await post(bob, { recipient_id: alice.id, content: await enc(bob, alice, 'hi alice'), reply_to_id: t1.body.id });
  assert.equal(t2.status, 200);
  assert.equal(t2.body.reply_to?.id, t1.body.id);
  assert.equal(t2.body.reply_to.attachment_meta ?? null, null);

  // reply to an ATTACHMENT message: preview carries only the opaque envelope
  const att = await send(alice, bob, { bytes: bytesPattern(50), name: 'reply-target.pdf', mime: 'application/pdf' });
  const t3 = await post(bob, { recipient_id: alice.id, content: await enc(bob, alice, 'nice file'), reply_to_id: att.body.id });
  assert.equal(t3.status, 200);
  assert.equal(t3.body.reply_to.id, att.body.id);
  assert.equal(t3.body.reply_to.attachment_name, 'encrypted-attachment');
  assert.equal(t3.body.reply_to.attachment_mime, 'application/octet-stream');
  assert.ok(typeof t3.body.reply_to.attachment_meta === 'string');
  assert.ok(!JSON.stringify(t3.body.reply_to).includes('reply-target.pdf'));

  // an attachment sent as a reply
  const prepared = await prepareAsClient(bob, alice, { bytes: bytesPattern(20), name: 'r.bin', caption: 'caption reply' });
  const rr = await postUpload(server, bob, alice.id, prepared, { reply_to_id: String(t1.body.id) });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.equal(rr.body.reply_to.id, t1.body.id);

  // reactions on text and on an attachment message
  for (const id of [t1.body.id, att.body.id]) {
    const res = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages/${id}/reactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    });
    assert.equal(res.status, 200);
  }

  // conversation list shows a generic label for the attachment, never a name
  const convRes = await authGet(server, alice, '/api/dm/conversations');
  assert.equal(convRes.status, 200);
  const convs = await convRes.json();
  const list = Array.isArray(convs) ? convs : convs.conversations;
  assert.ok(list.length >= 1);
  assert.ok(!JSON.stringify(list).includes('reply-target.pdf'));
});

test('regression: text-only DM edits and deletes still work', async () => {
  alice.actor.use();
  const mod = await alice.actor.importModule('crypto/messages/message-crypto.js');
  const enc = async (text) => JSON.stringify(await mod.encryptOutgoingMessage(text, alice.id, bob.id));
  const sent = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: bob.id, content: await enc('first') }),
  }).then((r) => r.json());
  const edited = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages/${sent.id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: await enc('second') }),
  });
  assert.equal(edited.status, 200);
  const del = await globalThis.__nodeFetch(`${server.origin}/api/dm/messages/${sent.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.equal(del.status, 200);
});
