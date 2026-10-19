# Group attachments: the flag-flip checklist

`GROUP_ATTACHMENTS_UI_ENABLED` (`public/js/chat/group-attachments-flag.js:17`) ships
as **false**. This page is the checklist to tick **before** anyone flips it to
`true`. Nothing here is code: flipping the constant is a one-line change in
`public/js/chat/group-attachments-flag.js:17`, plus a rebuilt service-worker
manifest (item 7 of STEP 3D).

---

## 1. What the flag actually gates

The flag is read in **exactly one place**: `renderActiveGroupShell`
(`public/js/chat/group.js:683`).

| Gated by the flag | Not gated by the flag |
|---|---|
| the attach button and the file input in the group composer (`group.js:699-701`) | the RECEIVE path: a received group attachment is decrypted and rendered whatever the flag says (`group.js:309`, `if (attachmentBinding)`) |
| the composer's `uploadUrl` / `prepareUpload` (`group.js:734`) | the crypto, the server, the stored rows |

So the flag is a **sending** switch, not a reading switch. That is what makes
the rollback in section 6 harmless.

---

## 2. Checklist

### 2.1 The browser tests pass on Linux with the project's own Chromium

The project's browser is `@sparticuz/chromium` (a **Linux** binary). The
STEP 3D browser results were produced on **Windows with the system Chrome**,
because the Linux binary cannot run here - and since STEP 3D item 4 that
fallback is **opt-in** and the run says which engine it used.

On the Linux runner:

```sh
cd /path/to/the/tree
node --experimental-test-module-mocks --env-file=tests/test.env \
     --test --test-timeout=900000 tests/groups/group-attachment-browser.test.mjs
```

Expected (the TAP line must name the project's own Chromium):

```
# # browser: chromium (@sparticuz/chromium) HeadlessChrome/...
ok 1 - 1 honest send and receive: an image renders inline, a PDF is a download
ok 2 - 2 a hostile relay swaps the stored blob: that row shows "Attachment unavailable", the others still render
ok 3 - 3 a hostile relay serves file A under message B: "Attachment unavailable"
ok 4 - 4 no key / iv / hash / ciphertext material reaches the DOM, incl. in a quote
ok 5 - 5 with the flag OFF the group composer has NO attach control and NO file input
ok 6 - 6 the sanitised name is used for BOTH the visible text and the download attribute
ok 7 - 7 the file is NOT fetched while the thread is decorated
ok 8 - 8 the download queue never has more than 2 downloads in flight
ok 9 - 9 a file over the auto-load limit waits for an explicit click
# tests 9
# pass 9
# fail 0
```

- [ ] the run above is green **on Linux** and the `# browser:` line says
      `chromium (@sparticuz/chromium)`
- [ ] the full non-browser suite is green in both modes
      (`--env-file=tests/test.env` and without it)
- [ ] `node scripts/build-sw-manifest.mjs --check` says "current"

### 2.2 The open items of STEP 3D

- [ ] **item 0** (the envelope limit) - done in STEP 3D
      (`public/js/chat/group-attachments.js`, `assertCaptionFitsEnvelope` /
      `assertEnvelopeWithinLimit`; the tests are in
      `tests/groups/group-attachment-envelope.test.mjs`)
- [ ] **item 2** (the lazy receive path) - done in STEP 3D
      (`public/js/chat/group-attachments.js`: the placeholder, the
      IntersectionObserver, the 2-download queue, the abort, the blob-URL
      revocation)
- [ ] **item 3** (the client upload cap) - **OPEN, a documented STOP**: the
      client cannot learn `GROUP_UPLOAD_MAX_MB`, because the only mechanism
      the project has is `GET /api/dm/limits`
      (`public/js/media/attachment-e2ee.js:288-303`) and there is **no group
      equivalent** (`routes/groups.routes.js` has no `/limits` route, and
      `routes/` is out of scope for STEP 3D). The client therefore uses
      `DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB` (50) and the SERVER stays the
      authority. **The owner has to decide** whether to add
      `GET /api/groups/limits` in a later step.

### 2.3 The clients that load `public/`

| Client | How it gets `public/` | What it needs |
|---|---|---|
| The web client (any browser) | from the server, cached by the service worker | the **service-worker manifest** must be regenerated (`node scripts/build-sw-manifest.mjs`) and the service worker must update its cache - a new module (`group-attachments.js`) is a new file, and the old one is never fetched from a stale cache |
| `electron-client/` | it loads the **server** (`electron-client/main.js:380`, `mainWindow.loadURL(serverUrl)`) - it bundles no copy of `public/` | **nothing** - it picks the new code up with the server |
| `app-debug.apk` (in the repo root) | it **bundles its own copy** of `public/` (the APK contains `assets/public/...`, 711 entries) | a **rebuild**: the APK in the repo has no `assets/public/js/chat/group-attachments.js` and an old `assets/public/sw-manifest.js` |

- [ ] the service-worker manifest is regenerated and `--check` says "current"
- [ ] the Android APK is rebuilt (or the owner accepts that the APK stays on
      the old client behaviour of section 2.4)

### 2.4 What a user on an OLD client sees

The signature format changed in STEP 3B: the file's bytes are bound into the
signature through the attachment slot, the last signed field
(`public/js/crypto/groups/signing.js:93-104`, the slot itself is built by
`buildAttachmentSlot`). An old client encodes that field as EMPTY, so the
canonical bytes differ and **the signature does not verify**.

An old client therefore shows the group message as an **unverified
placeholder** - the neutral, static text "Message could not be verified"
(`public/js/chat/group.js:238`, `UNVERIFIED_HTML`, and `group.js:369`,
`out.push(unverifiedPlaceholder(raw))`). It is not retried and nothing
crashes; the message is simply not readable on that client.

A client that has the group-attachment code but an **old server** is a
different case and is not affected: the attachment is only ever offered to
the client that can decrypt it.

- [ ] the owner accepts the old-client behaviour ("unverified placeholder",
      no file, no crash)

### 2.5 The manual test script (two real devices)

1. Both devices log in, both join the same group, both open it.
2. Device A: attach a small PNG (< 5 MB) with a caption, send.
   Device B must show the image **inline** and the caption.
3. Device A: attach a PDF, send. Device B must show a **"Download (12 KB)"**
   button - the file is **not** fetched automatically. Tap it: the download
   starts, and the name on the button and in the download are the sanitised
   name.
4. Device A: attach a file over 5 MB, send. Device B must show a
   **"Download (6.0 MB)"** button and must **not** load it by itself
   (no network activity until the button is tapped).
5. Device B: scroll a long thread with many attachments - the files are
   fetched only as their rows become visible, and never more than two at a
   time.
6. Device A: send a message with a caption and **no** file, and a reply to
   the file message. Device B must show the caption and a quote with the
   file name (no key material, no ciphertext).
7. Device B: leave the group and re-open it. The already sent files must
   still be readable (they are fetched again when their rows become
   visible).
8. Device A: send a file, then flip the flag back to `false` (see section 6)
   and reload. Device B must still be able to read the file.

### 2.6 The rollback

Flipping `GROUP_ATTACHMENTS_UI_ENABLED` back to `false` and reloading the
client:

- the attach button, the file input and the staging area are gone
  (`group.js:699-701`) - sending is off again;
- **the already stored attachment messages stay readable**: the receive path
  is not behind the flag (`group.js:309`), so the rows are still decrypted
  and rendered;
- the rows that were already downloaded keep their blob URLs only until the
  thread is torn down or the group is left
  (`revokeAllGroupAttachments`), after which they are fetched again - no
  data is lost, because the bytes are on the server.

So the rollback is **safe and non-destructive**: nothing on the server is
touched, and the flag is the only thing that changes.

- [ ] the owner has read section 2.6 and accepts it

---

## 3. Voice messages: what would change (design only, no code)

Voice is out of scope for STEP 3C (`is_voice_message` is always false on the
server, `controllers/groups.controller.js`). If it is ever added, the change
is small and stays inside the same envelope:

- the **recorder output** goes through exactly the same path as a file: the
  bytes are encrypted with `encryptAttachmentForGroup` and the file's iv,
  ciphertext hash and plaintext length are signed into the same
  `att_iv` / `att_ct_hash` / `att_len` fields. The voice flag is **not** a
  new signed field and **not** a server column: the server keeps storing the
  neutral `is_voice_message = 0` (`controllers/groups.controller.js`), exactly
  as it does for the name, the mime and the dimensions.
- the **duration and the waveform** belong in the encrypted meta object - the
  same JSON the caption lives in (`{"v":1,"text":"…","file":{…}}`), so the
  server never learns them. The meta version would have to grow (or a new
  optional key would have to be added) - the meta parser is strict, so an
  unknown key is a malformed meta and the row shows "Attachment unavailable".
- the **player** is a render detail: a sniffed audio type would need its own
  inline rule (the current inline list is images only), and the lazy
  download rule would have to exempt small voice clips (they are small and
  the user expects them to play).
- the **trust** rules do not change: the bytes are bound into the signature,
  the receiver refuses a file whose bytes do not match what the sender
  signed, and the nonce is claimed only after a successful decrypt.

Nothing in this section is implemented, and nothing may be implemented before
the checklist above is ticked.
