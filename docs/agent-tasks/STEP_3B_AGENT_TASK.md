# STEP 3B - Group attachments: bind file bytes into the signature (crypto layer + tests, UI stays disabled)

Put this file at `docs/agent-tasks/STEP_3B_AGENT_TASK.md`.
Base: `wire-final-34` (SHA256 `7471dedd62a958edd48bf69bb67e71c6faa3b99c926726cc55fe20d107b66d00`, 524 entries, 466 files, HEAD `8ffb945`).
Output zip: `wire-final-35`.

Rules for this step:
- One commit per item. Report each item in at most 5 lines.
- Do not write down a number you did not run. Do not mark anything "Verified" that you did not see. Paste raw output for every check.
- Read the code before you change it. Cite `file:line` for every claim about current behaviour.
- Do not weaken or delete any assert to keep a suite green. The only test you may edit on purpose is `C3-12` (item 6), and only as described there.
- If you think a change outside the allowed paths is needed, STOP and report why. Do not make it.

Allowed to change:
- `public/js/crypto/groups/signing.js`, `public/js/crypto/groups/message-crypto.js`, `public/js/crypto/messages/attachment-crypto.js`
- `public/sw-manifest.js` (regenerated, never hand-edited)
- `tests/` (new and the one `C3-12` edit)
- `docs/`

Not allowed to change: `routes/`, `controllers/`, `services/`, `database/`, `config/`, `public/js/chat/group.js` (the group composer stays "group attachments aren't supported"), and no new client module may call `encryptAttachmentForGroup` from the UI.

---

## 1. Goal in one paragraph

Implement the design in `docs/GROUP_ATTACHMENTS_E2EE.md` at the crypto layer only. After this step a signed group message can carry an attachment whose `iv`, ciphertext hash and plaintext length are covered by the existing ECDSA signature, and the receive side refuses a file whose bytes do not match what the sender signed. Group attachment sending is still **not reachable from any UI path**. Wiring the composer, the upload call and the thread rendering is a later step (3C).

---

## 2. Read first

1. `docs/GROUP_ATTACHMENTS_E2EE.md` (the whole file) and `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` sections 6 and 7.
2. `public/js/crypto/groups/signing.js` (`encodeSignedBytes`, the `attachment` slot), `public/js/crypto/groups/message-crypto.js` (`encryptGroupMessage`, `decryptGroupMessageDetailed`, `UNBOUND_ENVELOPE_KEYS`, `UnverifiedMessageError`), `public/js/crypto/messages/attachment-crypto.js` (group half), `public/js/crypto/groups/nonce-lock.js`.
3. `tests/groups/group-signing-messages.test.mjs` (`C3-4`, `C3-12`), `tests/groups/group-keys-contract.test.mjs` (`K-2`), `tests/groups/group-hardening-f4-replay.test.mjs`, `tests/attachment-crypto.test.mjs`, and the helpers `tests/groups/_roundtrip-helpers.mjs`, `_scenario.mjs`.
4. `controllers/groups.controller.js` `sendMessageWithAttachmentHandler` and `config/multer.js` `groupUpload` (read only).

---

## 3. Corrections to the 3A design (apply these; they override the doc where they differ)

The 3A document is right about the current code. A review found five places where the design is incomplete or worded in a misleading way. Fix them in the document (item 1) and implement the corrected version.

**C1. `verifyMessage` cannot see the file.** The signature is verified on the message envelope, and the file ciphertext is downloaded separately. So the signature only proves what the sender *committed to* (`att_iv`, `att_ct_hash`, `att_len`). A tampered or swapped file is caught by a **second, explicit step on the downloaded bytes**: recompute `SHA-256(iv || ciphertext)`, compare with the signed `att_ct_hash`, check the length, and only then call AES-GCM decrypt. The 3A text that says the file hash is "re-computed inside `verifyMessage`" and that a swapped file fails with `bad-signature` is wrong. Use a **separate** failure reason for a file-bytes mismatch: `attachment-mismatch` (fixed enum, never message content). `bad-signature` stays for a bad signature only.

**C2. The server column `attachment_iv` is not trusted.** `groups.controller.js` stores `attachment_iv` from the multipart body, unsigned. The **signed `att_iv` in the envelope is the only authority**. The receiver must use the envelope's `att_iv`, and must treat a row whose `attachment_iv` column differs from the signed `att_iv` as `attachment-mismatch`.

**C3. All-or-none fields.** An envelope has either all of `att_iv`, `att_ct_hash`, `att_len` or none of them. One or two of them present, wrong base64, wrong lengths (`att_iv` must decode to exactly 12 bytes, `att_ct_hash` to exactly 32 bytes), or `att_len` that is not a canonical non-negative decimal integer -> structurally malformed -> plain `Error`, dropped per message exactly like today (`K-2` contract). The legacy keys `att`, `attachment`, `attachments` stay refused with `attachment-not-bound`.

**C4. The length field is not a second security layer.** The hash over `iv || ciphertext` already fixes the ciphertext length. Keep `att_len` anyway as a cheap early reject, and require `ciphertextLength === att_len + 16` (GCM tag) before hashing. Do not describe it as the thing that prevents truncation. The doc must say so.

**C5. Attack 2 (splice) and attack 4 (swap) are the same check from the receiver's side.** The attacker cannot edit a signed envelope. What they can do is serve file A's bytes under message B. The defence is C1 (message B's signed `att_ct_hash` does not match file A). Rewrite the two test descriptions in 3.6 accordingly. Also remove the rambling "keys are per group" sentence from attack 3.

Also record in 3.8 (open questions) two facts the 3A doc got wrong or missed:
- A group upload cap **already exists**: `GROUP_UPLOAD_MAX_MB` (default 50) in `config/constants.js:144`, used by `config/multer.js` `groupUpload`. Unlike DM it adds no ciphertext-overhead allowance (`dmCiphertextOverheadBytes`). The real owner question is whether the cap is meant for plaintext (then a file exactly at the cap is rejected because ciphertext is 16 bytes longer) or ciphertext. **Report it. Do not change `config/` in this step.**
- Group files are one single AES-GCM operation held fully in memory (no streaming). Note the memory cost at the cap.

---

## 4. Items

### Item 1. Docs first: correct `docs/GROUP_ATTACHMENTS_E2EE.md` (docs only, one commit)
Apply C1-C5 and the 3.8 additions. Change the status line from "design only" to "design reviewed; crypto layer implemented in STEP 3B, UI still disabled" only **after** items 2-6 pass (do that edit last, in item 7). Keep every `file:line` citation true: after your code changes the line numbers move, so re-check every citation and update it.

### Item 2. Slot builder in `signing.js`
- Add `buildAttachmentSlot({ iv, ciphertext, plaintextLength })` returning exactly 40 bytes: `SHA-256(iv || ciphertext)` (32 bytes) followed by `plaintextLength` as 8-byte big-endian.
- Validate: `iv` is a 12-byte `Uint8Array`, `ciphertext` is a `Uint8Array` with length >= 16, `plaintextLength` is a safe non-negative integer, and `ciphertext.length === plaintextLength + 16`. Throw `SigningFormatError` otherwise.
- Do **not** change `encodeSignedBytes`. Text-only messages must keep **byte-identical** signed bytes. Add a test that pins this with a fixed known-answer vector (hex) for a text-only message, computed from the code **before** your change.
- Add a known-answer vector for the 40-byte slot too.

### Item 3. Send side in `message-crypto.js`
- `encryptGroupMessage` gets an optional argument carrying the already-encrypted file: `{ ivBase64, ciphertext, plaintextLength }`.
- When present: compute the slot with `buildAttachmentSlot`, pass it as `attachment` to `signMessage`, and add `att_iv`, `att_ct_hash` (base64 of the 32-byte digest) and `att_len` (canonical decimal string) to the envelope. Keep `v: 2`.
- When absent: behaviour and output bytes are unchanged (`attachment: new Uint8Array(0)`, no `att_*` keys).
- The file's counter must come from `reserveNextCounter` (it already does in `encryptAttachmentForGroup`). Do not add any new nonce path.

### Item 4. Receive side in `message-crypto.js` and `attachment-crypto.js`
- `decryptGroupMessageDetailed`: parse `att_*` per C3. Build the slot from the envelope fields (no file needed at this point), pass it to `verifyMessage`, and expose the verified binding on the result as `attachmentBinding: { iv, ctHash, len } | null`. A text-only message returns `null` and verifies exactly as today.
- `attachment-crypto.js`: change the group decrypt path so it **requires** the verified binding. Order is fixed: (1) check the `attachment_iv` column equals the signed iv (C2), (2) check `ciphertext.byteLength === len + 16`, (3) recompute `SHA-256(iv || ciphertext)` and compare with `ctHash` using a constant-time compare, (4) AES-GCM decrypt with `attachmentAad`, (5) only after a successful decrypt claim `att:${ref}`. Any failure in (1)-(3) throws `UnverifiedMessageError('attachment-mismatch')` **before** decrypt and **before** the nonce is claimed.
- A call without a binding must throw. Do not keep an unbound fallback path. Fail closed.
- Make sure a missing Sender Key still raises `MissingSenderKeyError` (self-heal contract is unchanged).

### Item 5. Tests (new file `tests/groups/group-attachment-binding.test.mjs`, node, real modules, no mocks of crypto)
Map one test to each row. Every negative test has a positive control and a **mutation check**: temporarily remove the check it targets, confirm the test fails, restore, confirm it passes. Paste the raw output of each mutation run.

| Test | What it proves |
|---|---|
| `valid file accepted` | honest send+receive: signature true, hash matches, plaintext recovered, nonce claimed once, no placeholder |
| `forgery rejected` | Mallory encrypts a file under Alice's Sender Key and signs with Mallory's key -> `bad-signature`, nonce unclaimed |
| `splice/swap rejected` | file A's bytes served under message B -> `attachment-mismatch`, before decrypt, nonce unclaimed |
| `attachment_iv column mismatch rejected` | row `attachment_iv` differs from signed `att_iv` -> `attachment-mismatch` |
| `length mismatch rejected` | truncated/appended ciphertext -> `attachment-mismatch` at the length check, before hashing |
| `signed field tamper rejected` | change `att_ct_hash`, `att_iv` or `att_len` in the envelope -> `bad-signature` |
| `att fields stripped or added rejected` | remove `att_*` from a signed attachment message, or add them to a text-only message -> `bad-signature` |
| `all-or-none` | 1 or 2 of the 3 fields, bad base64, wrong byte lengths, non-canonical `att_len` -> dropped as malformed (plain `Error`, `K-2` style), never rendered |
| `legacy keys still refused` | `att`/`attachment`/`attachments` -> `attachment-not-bound` (C3-4 still passes unchanged) |
| `cross-group replay rejected` | same envelope in another group -> signature false (signed `groupId`) |
| `same-group file replay rejected` | second accept of the same file ref -> `ReplayedMessageError` |
| `bit flip rejected` | one flipped ciphertext bit with a recomputed matching hash is impossible without the key; with the old hash -> `attachment-mismatch` |
| `nonce: no reuse` | two files + one text under one Sender Key -> three distinct counters |
| `text-only bytes unchanged` | the known-answer vector from item 2 |
| `per-row isolation` | a thread with one bad-attachment row and good rows: good rows render, the bad row is a placeholder, nothing throws out of the batch |

Also add a **real server** test in the style of `tests/acceptance-no-plaintext.test.mjs`: upload a group file produced by the real encrypt path through `POST /groups/:groupId/upload`, then read the stored blob from `GROUP_UPLOAD_DIR` and assert it contains no plaintext substring and is `plaintext length + 16` bytes. Do not change the server to make this pass.

### Item 6. `C3-12`: update deliberately, do not delete
- Keep the walk over `public/js` and the "no `uploadUrl`" / "group attachments aren't supported" asserts on `chat/group.js`.
- Change only the allowed-callers list: `crypto/messages/attachment-crypto.js` (definition). Nothing else is allowed to call `encryptAttachmentForGroup` yet, because there is still no UI path. Your new code reaches it only from tests.
- Rewrite the failure message so it says the signature binding now exists and that wiring the composer requires step 3C and an update of this test.
- Add one extra assert: the slot builder is actually used on the send path (grep that `buildAttachmentSlot` is referenced from `message-crypto.js`). A future edit that removes the binding must fail this test.
- Show in the report that `C3-12` fails if you temporarily add a call to `encryptAttachmentForGroup` in `public/js/chat/group.js`, then revert.

### Item 7. Manifest, docs status, zip
- Public files changed, so run `node scripts/build-sw-manifest.mjs` and commit the regenerated `public/sw-manifest.js`. Then `--check` must say current.
- Re-check every `file:line` citation in `docs/GROUP_ATTACHMENTS_E2EE.md` and in the doc-consistency edits.
- Update status in `docs/GROUP_ATTACHMENTS_E2EE.md`, `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` (6.7 item 5 and proposal 23) and `docs/e2ee-dm-hardening.md` section 3.5 to: "crypto layer implemented (STEP 3B); UI disabled; composer wiring is STEP 3C".
- Build `wire-final-35` the same way as last time (hash, entry count, clean-unzip `manifest --check`, CR check, copy and verify).

---

## 5. Acceptance checklist (paste raw output for each)

- [ ] `node --check` on every JS file you touched -> rc=0
- [ ] New test file: raw `# tests / # pass / # fail / # cancelled / # skipped / # todo`, all pass
- [ ] Mutation run for each negative test (item 5): raw output showing fail-without-check, pass-with-check
- [ ] Known-answer vector for text-only signed bytes was computed **before** the code change and still matches after
- [ ] `C3-4`, `K-2`, F4 replay tests, `tests/attachment-crypto.test.mjs`: unchanged and green
- [ ] Full non-browser suite in both modes (with and without `--env-file=tests/test.env`). Expected: previous baseline `637 / 634 / 0 / 0 / 3 / 0` plus exactly the number of new tests, with 0 fail and the same 3 skipped
- [ ] `node scripts/build-sw-manifest.mjs --check` -> current
- [ ] CR check on `public/` (use a method that really detects `\r`, for example `python3` or `grep -P '\r'`; plain `grep $'\r'` in `sh` gives false hits) -> 0 files
- [ ] `git diff --name-only 8ffb945..HEAD`: only the allowed paths
- [ ] `routes/ controllers/ services/ database/ config/ public/js/chat/group.js`: zero diff (paste `git diff --stat`)
- [ ] Grep proving no UI module calls `encryptAttachmentForGroup` (paste it)
- [ ] Spot-check five `file:line` citations with `sed -n`
- [ ] New zip block: NAME, SHA256, BYTES, ENTRIES, files, HEAD, branch, tree state, copied and hash-verified

## 6. Report format

1. Zip block.
2. Per item: at most 5 lines, with commit hash.
3. The two owner questions from section 3 (size cap meaning, memory at the cap), restated, **not decided**.
4. Raw acceptance output.
5. **Verified / Unverified.** Verified = you ran it and saw it. Browser tests (Chromium unavailable on Windows), non-Chromium browsers, Linux and the voice recorder stay Unverified unless someone ran them.

## 7. Do not

- Do not wire any UI, composer, upload call or rendering for group attachments. No change to `public/js/chat/group.js`.
- Do not change the server, routes, controllers or `config/`. If the cap mismatch needs a fix, report it.
- Do not introduce `v: 3`, a per-file key, streaming for groups, or forward secrecy.
- Do not keep an unbound decrypt path "for compatibility". There is no released group protocol.
- Do not weaken or delete a test. Only `C3-12` changes, as described in item 6.

## STOP
After the zip and the report, stop. Step 3C (composer, upload, thread rendering) starts only after this is reviewed.
