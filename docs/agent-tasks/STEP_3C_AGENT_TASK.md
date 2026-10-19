# STEP 3C - Group attachments: composer, upload, thread rendering (behind a flag, default OFF)

Put this file at `docs/agent-tasks/STEP_3C_AGENT_TASK.md`.
Base: `wire-final-35` (SHA256 `a0aa991e09cd0de2dd9dc77e6cc7e576c751a18fe7af8e86516ee06c9254f467`, 526 entries, 468 files, HEAD `d6a4234`).
Output zip: `wire-final-36`.

Rules for this step:
- One commit per item. Report each item in at most 5 lines.
- Do not write down a number you did not run. Do not mark anything "Verified" that you did not see. Paste raw output for every check.
- Read the code before you change it. Cite `file:line` for every claim about current behaviour.
- Do not weaken or delete a test to keep a suite green. Tests that must change (items 0 and 6) are listed; change only what is described.
- A browser test that did not run is **BLOCKED**, never "passed" and never "skipped silently".
- If you think a change outside the allowed paths is needed, STOP and report why.

Allowed to change: `public/` (group chat, media, crypto/messages, `sw-manifest.js` regenerated), `controllers/groups.controller.js`, `config/multer.js`, `config/constants.js` (only if item 2 needs it), `tests/`, `docs/`.
Not allowed: `database/` schema, `routes/` (unless the route needs a new middleware, then STOP and report), DM code paths, anything about forward secrecy, a `v:3` envelope.

---

## 0. Decisions for this step (the owner approved these defaults by running this prompt)

Edit this list before running if you disagree. If you change one, tell the agent.

1. **Size cap = plaintext.** `GROUP_UPLOAD_MAX_MB` (default 50) limits the plaintext file. The multer limit gets the 16-byte GCM tag plus 1 on top, the same way DM does (`config/multer.js` `dmUpload`, `extraBytes`).
2. **Voice messages are NOT in this step.** Images and ordinary files only. The `is_voice_message` field is sent as false.
3. **Protocol stays `v:2`** (design doc). No per-file key, no streaming.
4. **Feature flag.** One constant `GROUP_ATTACHMENTS_UI_ENABLED` in one small module. It ships as `false`. With `false` the composer shows no attach button, paste/drop of files does nothing, and the group page behaves exactly like `wire-final-35`. Flipping it to `true` is a separate owner step after the browser tests have run on Linux.

---

## 1. Read first

1. `docs/GROUP_ATTACHMENTS_E2EE.md` (post-3B version), `docs/DM_ATTACHMENTS_E2EE.md` (how DM hides file name, mime, size class), `docs/BROWSER_TEST_ISOLATION.md`.
2. 3B code: `signing.js` `buildAttachmentSlot`, `message-crypto.js` (`encryptGroupMessage` with the attachment argument, `decryptGroupMessageDetailed` and `attachmentBinding`), `attachment-crypto.js` group half.
3. Composer and thread: `public/js/chat/group.js`, `thread.js`, `composer.js`, `reply.js`, `public/js/media/attachments.js`, `attachment-e2ee.js`, `lazy-e2ee-media.js`, `mediaToken.js`. Find out how the DM path sends a file, shows progress and renders it, and mirror it. Cite what you read.
4. Server: `routes/groups.routes.js` upload route, `controllers/groups.controller.js` `sendMessageWithAttachmentHandler` and `getAttachmentHandler`, `config/multer.js` `groupUpload` and `createUploader` (`opaqueNames`, `extraBytes`, the mkdir list).
5. Tests: `tests/groups/group-attachment-binding.test.mjs`, `group-signing-messages.test.mjs` (`C3-12`), `tests/dm-v2-attachments-browser.test.mjs` (the DM browser test is the model for the group one).

---

## 2. Items

### Item 0. Close three leftovers from 3B (production code in `public/` and tests)
The 3B task said "a call without a binding must throw; no unbound fallback". The shipped code does not do that.
- `decryptAttachmentForGroup` in `public/js/crypto/messages/attachment-crypto.js` still has a legacy 5-argument path that decrypts with the row's iv and no binding, selected by `arguments.length`. **Remove it.** Make the signature an object: `decryptAttachmentForGroup({ groupId, ciphertext, rowIvBase64, binding, senderKeyId, ref })`. Missing or malformed `binding` -> throw.
- Update every caller in tests (`tests/attachment-crypto.test.mjs`, `tests/groups/group-hardening-f4-replay.test.mjs`, `tests/groups/group-senderkeyid.test.mjs`, the 3B binding test) to produce a real signed binding through `encryptGroupMessage` and `decryptGroupMessageDetailed`. Do not delete assertions; keep what each test proves.
- Compare the row iv with the signed iv as **decoded bytes**, not as base64 strings (two spellings of the same bytes must not cause a false mismatch, and a different value must still fail).
- 3B reported that its mutation test M2 (length check removed) was not detected. Make it detectable: add a test that wraps `crypto.subtle.digest` and asserts it is **not called** when the ciphertext length is wrong. Then run the mutation (remove the length check, test must fail, restore).
- Grep proof: no unbound decrypt path remains.

### Item 1. Design note, then stop-check (docs only)
Add section "3C: file metadata and what the server sees" to `docs/GROUP_ATTACHMENTS_E2EE.md`. Today the group upload stores the client's file name, mime, width, height and voice flag in clear (`controllers/groups.controller.js` around `sendMessageWithAttachmentHandler`), and `groupUpload` does not use `opaqueNames`, unlike `dmUpload`. Specify:
- **What the server sees after 3C:** opaque stored name, `attachment_name = 'encrypted-attachment'`, `mime = 'application/octet-stream'`, width/height null, voice false, ciphertext size, `attachment_iv`. Nothing else.
- **Where the real metadata lives:** inside the **encrypted message plaintext**. Discriminator: if the verified envelope has `att_*` fields (signed), the plaintext is a JSON object `{"v":1,"text":"<caption>","file":{"name":...,"mime":...,"w":...,"h":...}}`; if it has no `att_*` fields the plaintext is the plain text exactly as today. This needs no ambiguity rule because the discriminator is signed. State the limits: name <= 255 chars, mime <= 127, w/h positive integers <= 20000 or absent, reject unknown `v`, reject extra keys that are not in the list.
- **Receiver sanitising rules** (write them as testable statements): the file name is shown with `textContent` only, path separators and control/bidi characters are stripped, empty result becomes `file`; inline rendering only for `image/png|jpeg|gif|webp` after the **decrypted bytes** are sniffed to match (never trust `mime` alone), everything else is a download with `application/octet-stream`; SVG is never rendered inline.
- The caption limit and the 90,000-char server limit still apply to the envelope (check the arithmetic: the JSON wrapper plus base64 must fit; give the maximum caption length you enforce on the client).
Commit, then continue (this note is part of the deliverable, not a stop point).

### Item 2. Server: opaque storage and the cap (production code, minimal)
- `groupUpload`: `opaqueNames: true`, `extraBytes` = 16 + 1 (per decision 1), and make sure `GROUP_UPLOAD_DIR` is created (3B found that a first-ever group upload into a fresh tree returns 500 because the dir is not in the mkdir list at `config/multer.js:96`). Fix that properly, not in the test.
- `sendMessageWithAttachmentHandler`: ignore client-supplied `name`, `mime`, `width`, `height`, `is_voice_message` for groups and store the neutral values from item 1. Keep `attachment_iv` validation. Do not touch the DM controller.
- `getAttachmentHandler` keeps `application/octet-stream`, `nosniff`, range support and membership check.
- Tests (node, real server): (a) first-ever upload into a fresh `GROUP_UPLOAD_DIR` works; (b) a file of exactly `GROUP_UPLOAD_MAX_MB` plaintext + 16 bytes of ciphertext is accepted, one byte more is rejected; (c) the stored row has the neutral values even if the client sends real ones; (d) the stored on-disk name does not contain the client's name; (e) the `acceptance-no-plaintext` style check from 3B still passes; (f) non-member and removed member cannot download.

### Item 3. Client: the flag, send path, composer
- New small module for the flag (decision 4). Default `false`. Expose a test-only setter that is not reachable from page code in production (document how you guarantee that, for example by gating on a test hook that `server.js` never sets).
- With the flag off the group page is byte-for-byte the old behaviour. Prove it with a test that loads the group page code with the flag off and asserts no attach control, no file input, no paste/drop handler for files, and that `group.js` still contains the existing "group attachments aren't supported" behaviour path for that case.
- With the flag on: attach button, file input, paste image, drop. Client-side checks before encrypting: size <= cap (clear user message), non-empty file, name/mime limits from item 1.
- Send order is fixed: (1) `ensureSenderKeyForGroup`, (2) read file bytes, (3) `encryptAttachmentForGroup` (fresh counter), (4) build the plaintext JSON from item 1, (5) `encryptGroupMessage(..., attachment: {ivBase64, ciphertext, plaintextLength})` (signs the slot), (6) multipart `POST /groups/:id/upload` with the ciphertext as `file`, the envelope as `content`, `attachment_iv`, `reply_to_id`, and only neutral values for the other fields.
- Failure handling: if the upload fails after the counter was reserved, the counter stays burned (never reuse it) and the user sees a retry that **re-encrypts with a new counter**. Never resend the same iv+ciphertext under a second message. Show progress and a cancel. Memory: one file in memory at a time; release buffers after upload.
- `C3-12` and the "no `uploadUrl`" assert: see item 6.

### Item 4. Client: receive and render
- After `decryptGroupMessageDetailed` verifies the envelope, parse the plaintext per item 1 using the signed `att_*` discriminator. A malformed meta object -> per-row placeholder, never a thrown error out of the thread.
- Lazy download of the blob (media token, as DM does), then `decryptAttachmentForGroup` with the verified binding and the **signed** iv. Order is already fixed in 3B: row-iv check, length, hash, decrypt, claim nonce.
- Outcomes: `attachment-mismatch` -> the row shows "Attachment unavailable" (same wording as DM), other rows unaffected, no retry loop; `MissingSenderKeyError` -> existing self-heal (drain KDM, retry); network error -> retry button.
- Images: inline only after the sniff rule from item 1; use a blob URL and revoke it when the row is removed. Other files: a download action with the sanitised name. Dimensions come from the decrypted meta, used to reserve layout space.
- Replies and quotes: a quote of a caption-less attachment message shows the decrypted file name (as DM test `c2b` does), never the opaque placeholder and never any key, iv, hash or ciphertext in the DOM. Reply preview for a verified-but-undecryptable parent degrades to a neutral label.
- Do not add a new decrypt path that bypasses the binding.

### Item 5. Tests
Node level (real modules):
- plaintext meta: encode/decode, unknown `v`, extra keys, oversize name/mime, bad w/h, bidi/control characters in name, discriminator edge cases (text that looks like JSON in a text-only message stays text).
- sniffing: PNG/JPEG/GIF/WEBP accepted; a file whose declared mime is `image/png` but bytes are HTML/SVG -> download only, never inline.
- send-path ordering and the retry-with-new-counter rule (two attempts -> two different counters, no duplicate iv).
- per-row isolation with one bad attachment among good rows.

Real Chromium (write them now, mirror `tests/dm-v2-attachments-browser.test.mjs`; they are **BLOCKED** if Chromium is unavailable, and the report must say BLOCKED):
- honest send and receive between two users, image inline and a PDF as download;
- hostile relay: swap the stored blob -> "Attachment unavailable", other rows fine;
- hostile relay: serve file A under message B -> same;
- no key/iv/hash/ciphertext material in the DOM, including in a quote;
- flag off -> no attach control.

Chromium note: the helper imports `@sparticuz/chromium` (with a **z**). The 3A report wrote `@sparticux` (with an x), which does not exist, so the "registry 404" claim there was probably a typo. Try `npm view @sparticuz/chromium` and paste the raw output. `@sparticuz/chromium` ships a Linux binary, so on Windows it will not run even when installed: use WSL or Docker if available (see `docs/BROWSER_TEST_ISOLATION.md` for `CHROMIUM_DIR`), otherwise report BLOCKED with the exact reason. Do not mark a browser test as passed from reading it.

### Item 6. `C3-12` and the composer guard: update deliberately
- `C3-12` currently says no module except `attachment-crypto.js` may call `encryptAttachmentForGroup`. Change the allowed list to exactly one new send module (name it in the test), keep the walk over `public/js`, and keep the assertion that `buildAttachmentSlot` is referenced from `message-crypto.js`.
- The two asserts on `chat/group.js` ("no `uploadUrl`", "group attachments aren't supported") must be replaced, not deleted: assert that the flag module exists, defaults to `false`, and that with the flag off the old behaviour is intact (item 3 test).
- Show in the report that `C3-12` still fails when you temporarily add a call to `encryptAttachmentForGroup` from a **second** module (plant, run, revert).

### Item 7. Manifest, docs, zip
- Regenerate `public/sw-manifest.js` (`node scripts/build-sw-manifest.mjs`), `--check` must say current. CR check with a method that really detects `\r` (python), not `grep $'\r'` in `sh`.
- Update `docs/GROUP_ATTACHMENTS_E2EE.md`, `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` (6.7 item 5, proposal 23) and `docs/e2ee-dm-hardening.md` 3.5 to: "implemented behind `GROUP_ATTACHMENTS_UI_ENABLED=false`; browser tests BLOCKED/passed on <platform>". Re-check every `file:line` citation.
- Build `wire-final-36` the same way as before.

---

## 3. Acceptance checklist (paste raw output)

- [ ] `node --check` on every touched JS file -> rc=0
- [ ] Item 0: grep proving no unbound decrypt path; the new digest-not-called test; mutation run for the length check (fail without, pass with)
- [ ] Item 2 server tests (a)-(f): raw `# tests / # pass / # fail`
- [ ] Item 5 node tests: raw summary
- [ ] Browser tests: raw output if run on Linux/WSL, otherwise the exact BLOCKED reason per test
- [ ] Full non-browser suite in both modes (with and without `--env-file=tests/test.env`): previous baseline `656 / 653 / 0 / 0 / 3 / 0` plus exactly the number of new tests, 0 fail, same 3 skipped
- [ ] `C3-12` plant with a second module: raw failing output, then green after revert
- [ ] Flag-off equivalence: test output proving the group page is unchanged
- [ ] `node scripts/build-sw-manifest.mjs --check` -> current; CR files in `public/` -> 0 (python)
- [ ] `git diff --name-only d6a4234..HEAD`: only the allowed paths; `database/`, `routes/`, DM files: zero diff (paste `git diff --stat`)
- [ ] Spot-check five `file:line` citations with `sed -n`
- [ ] New zip block: NAME, SHA256, BYTES, ENTRIES, files, HEAD, branch, tree state, copied and hash-verified

## 4. Report format

1. Zip block.
2. Per item, at most 5 lines, with commit hash.
3. What the server sees for a group file now (one table: field -> value).
4. Raw acceptance output.
5. **Verified / Unverified / BLOCKED.** Verified = you ran it and saw it. Anything you only read is Unverified. Browser tests that could not run are BLOCKED with the reason.
6. Things found and not hidden (including any place where this task did not match the code).

## 5. Do not

- Do not ship with the flag `true`.
- Do not add a code path that decrypts a group attachment without the verified binding.
- Do not store or send the real file name, mime, dimensions or voice flag to the server.
- Do not render SVG or any non-image type inline.
- Do not touch DM code, the DB schema, or start forward secrecy.
- Do not weaken or delete a test; item 0 and item 6 changes are the only edits to existing tests, and each must keep what the test proves.

## STOP
After the zip and the report, stop. Flipping the flag to `true` (and any voice-message work) happens only after the browser tests have run on Linux and the result is reviewed.
