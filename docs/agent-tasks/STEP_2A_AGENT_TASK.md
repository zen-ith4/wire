# STEP 2A - DM attachments get the v2 envelope (AAD), plus a replay-key fix found on the way

Put this file at `docs/agent-tasks/STEP_2A_AGENT_TASK.md`.
Base: wire-final-30 (sha256 41f90f97...31b1, HEAD b777db4). Output zip: `wire-final-31`.
Authoritative design: `docs/e2ee-dm-hardening.md` section 3.3 (the `dmAttachmentAad` sketch at lines ~207-210),
section 4.3, 5.4, 5.5 and 10.1. If anything in it contradicts the code, STOP and say so; do not deviate.

This step DELIBERATELY changes DM attachment encryption. The earlier "do not touch attachments" rule is lifted
only for the files listed in section 2. Everything else stays frozen.

## How to work (your budget has run out several times)

Sub-steps 2A.0 ... 2A.6 below. After EACH one: `git add -A && git commit -m "2A.N <what>"`, check
`git status --short` and CR=0 on touched files, and report in 5 lines or fewer (command, output, verdict).
Stop at the first sub-step you cannot finish and report; never leave a half-done change uncommitted.
Rules that came out of earlier incidents:
- Seam test FIRST. Two real v2 bugs (empty `content`, flat-vs-nested envelope) were mismatches between
  callers and callees that every mocked test missed. For each new function, write a node test that calls the
  REAL caller and callee with no mocks and asserts the return shape, before writing the glue.
- Positive control in every tamper test: first the untouched row decrypts to the exact plaintext, then tamper,
  then assert the failure is the AEAD/binding error (not "no key", "bad JSON", "unsupported version").
- DB tamper helper: `SELECT id, ...` then `UPDATE ... WHERE id = ?` and ASSERT `.run().changes === 1` and read it
  back. (1G's "3 bubbles" scare was `SELECT content` without `id`.)
- Tests that call `window.replyToDmMessage` / `editDmMessage` must `openDmUi` + `waitDecrypted` first.
- Plants with Python (real newlines, LF), never PowerShell `-replace`; after each restore `git diff --stat` is
  empty and CR=0. Run `node -e "require('better-sqlite3')(':memory:')"` before runs; `npm rebuild better-sqlite3`
  if it throws and say so.
- Verify the ZIP from a clean directory, not the working tree. Counts in the baseline format.

## 0. What the reviewer verified by reading wire-final-30 (verify yourself, do not trust)

1. Actual DM attachment path (NOT the older `attachment-crypto.js` one): `public/js/media/attachment-e2ee.js`
   `prepareDmAttachmentUpload()` encrypts the file with the STREAM format (`attachment-stream.js`, random 256-bit
   key per file, header = AAD for chunks), puts `{key, baseIv, name, mime, size, isVoice, width, height}` in
   `attachment_meta`, and encrypts that meta and the optional caption with `encryptOutgoingMessage()`
   (~lines 341 and 349) = the v1 envelope: static-static key, no AAD, same key in both directions.
   Receive: `decryptAttachmentMetaEnvelope()` (~line 105-115) uses `decryptIncomingMessage()`.
2. So a malicious server can, on attachment messages today: reflect alice's meta as bob's, relabel
   `senderId`/`recipientId`/`reply_to_id`, and move a (meta, blob) pair onto another row, all undetected.
   That is exactly the defect v2 fixed for text (design 10.1 item 1).
3. After 1B/1C, attachments are NOT covered by the v2 protections: `prepareDmAttachmentUpload` never reads
   `getPeerDmMinVersion`, never checks the pin, and the server's `dmV2RuleViolation()` (`dm.controller.js:83`) is
   not applied on the upload route. Also `isEncryptedEnvelopeShape()` (`dm.controller.js:188-202`) requires
   `enc.version === 1`, so a v2 meta or caption would be REJECTED today.
4. `encryptAttachmentForDm` / `decryptAttachmentForDm` in `public/js/crypto/messages/attachment-crypto.js` have no
   importers (grep) and no AAD. They are dead code.
5. `composer.js` calls `prepareUpload({file, caption, isVoice})` at ~2503 (file/caption) and ~3294 (voice) WITHOUT
   the reply target, though `reply_to_id` is appended to the form right after (~2539, ~3329). So the meta
   envelope cannot bind `replyToId` unless the composer passes it.
6. **Replay check is bypassable by the server (new finding, reproduced by the reviewer in node):**
   `msgId` is NOT in the v2 AAD (`dm-v2.js:313-315`), and the replay store is keyed by `msgId`
   (`classifyDmV2MsgId`, `dm-v2-wire.js:283-312`). Test: encrypt a v2 message, change `envelope.msgId` to another
   16-hex string, `decryptDmV2` still succeeds ("hello"). So a server that copies a row to a new row id AND changes
   the clear `msgId` is not detected as a replay. Only a lazy copy (same msgId) is caught. The `iv` IS bound in
   the AAD (a changed iv fails to decrypt) and is random per message, so it is the right replay key.
   This affects text v2 as well as the new attachment envelopes.

## 1. Decisions (reviewer's; flag a contradiction instead of deviating)

- D1 Scope: the `attachment_meta` envelope and the caption envelope of DM attachment messages, for peers with
  `dm_e2ee_min_version >= 2`. The STREAM file format, `attachment-stream.js`, `config/dm-stream.js` and the
  blob storage are unchanged. Group attachments are out of scope (disabled).
- D2 AAD labels: meta uses the label `'dm-att-v2'` (design 3.3: "a file can never be replayed as a message").
  Field order = the text AAD with only the label changed:
  `encodeFields('dm-att-v2', version, fromUserId, toUserId, senderKeyFp(32), direction, iv(12), replyToId or 0)`.
  The sketch's `attachmentId` is DROPPED: it predates the STREAM format (the per-file key inside the meta already
  binds the blob) and an unauthenticated id would repeat the msgId problem. State this in the docs.
  The caption is text: it uses the existing `'dm-msg-v2'` label and the existing text functions.
  `dmMessageAad` and the 1A known-answer tests stay byte-identical.
- D3 Replay key: replay detection keys on the AAD-bound `iv` (base64 of the 12 bytes), not on `msgId`. `msgId`
  stays in the envelope (format unchanged, no wire change, existing v2 rows stay readable). The per-conversation
  store keeps its size caps; same row twice is still NOT a replay; same iv on a different row id IS. Rename the
  localStorage store key (version it) so old msgId entries are not misread. Applies to text and attachments
  (meta and caption each have their own iv, both map to the same row id).
- D4 Composer: pass `replyToId` into `prepareUpload({...})` at both call sites (additive; the groups composer's
  hook ignores extra arguments). If the reply target is not in scope at those sites, STOP and report; do not
  restructure the composer.
- D5 Version choice and pin for attachments = the text rules: peer min version 1 -> v1 exactly as today; >= 2 ->
  v2 for meta and caption; sending v1 to a peer pinned >= 2 -> `DowngradeRefusedError`, visible warning, no
  silent fallback. Do the version/pin check BEFORE reading or encrypting the file, so nothing is uploaded after a
  refusal. The upload-size pre-check order stays: size gate first.
- D6 Server: accept the v2 shape (version 2, `senderFp`, `msgId`, 12-byte iv, ciphertext) for `attachment_meta` and
  the caption; refuse to STORE a v2 meta or caption for a recipient with `dm_e2ee_min_version < 2` (same rule and
  message as text, applied to BOTH fields); v1 stays accepted for everyone; the server never rewrites or adds a
  field. The 2000-char caption cap and the 8 KB meta cap stay. A v2 caption must not exceed the cap: the client
  refuses (`assertDmV2ContentFits`) like text.
- D7 Receive: v2 meta/caption are opened with row context (`rowId`, `replyToId` from the stored row;
  for the reply-quote path the quoted row's own `reply_to_id` from 1B's `attachDmReplyToIds`). `decryptIncomingMessage`
  must still THROW on a v2 payload without context (1B rule). A meta that fails to open becomes the existing
  "Attachment unavailable" placeholder (never throws, never leaks key material); with the Part B per-row
  isolation the other rows still render.
- D8 `attachment-crypto.js` DM functions: do not wire, do not delete. Add a static test that no source file
  imports them, and report the delete option (they are dead and weaker than the live path).
- D9 Legacy: v1 attachment rows (and the flag-OFF plaintext path) stay readable exactly as today.

## 2. Files

MAY CHANGE: `public/js/crypto/messages/dm-v2.js` (ADD only), `dm-v2-wire.js`, `message-crypto.js` (ADD functions),
`payload.js` (only if the v2 validator needs a purpose argument), `public/js/media/attachment-e2ee.js`,
`public/js/chat/dm.js` (only the attachment call sites and the replay call), `public/js/chat/composer.js`
(only the two `prepareUpload` calls, D4), `controllers/dm.controller.js` (only `isEncryptedEnvelopeShape`,
`validateEncryptedUpload`, the rule call on the upload route), `public/sw-manifest.js` (regenerate), docs.
NEW: `tests/dm-v2-attachments.test.mjs` (node), `tests/dm-v2-attachments-server.test.mjs` (real server),
`tests/dm-v2-attachments-browser.test.mjs` (real browsers), `scripts` none.
MUST NOT TOUCH: `dmMessageAad` and its 1A KATs, the v1 files (`encrypt.js`, `decrypt.js`, `key-derivation.js`,
`session.js`), `attachment-stream.js`, `config/dm-stream.js`, all of `services/` and `database/`, `tests/fixtures/*`,
`groups/*`, `scripts/run-tests.mjs`, `_acceptance-harness.mjs`, existing `tests/dm-attachments/*` (they must keep
passing UNEDITED under env=1 and default; if one fails, report it, do not edit it).

## 2A.0 Prove the replay bypass on the CURRENT tree (tests only)

In `tests/dm-v2-wire.test.mjs`-style node test (or a new node file): with the real `dm-v2.js` + the real replay
store, show: row R1 with msgId M accepted; the "server copies the row to R2 and changes msgId to M2" is classified
`new` (not `replay`) today. Paste the red/green evidence (assert the CURRENT behaviour, mark it as the known bug,
flip the expectation in 2A.1). Same-row twice and lazy copy (same msgId) behave as documented.

## 2A.1 Replay key fix (production: `dm-v2-wire.js` only, plus the call site)

Implement D3. Seam test first. Then: the 0 test flips to "dropped"; same row twice fine; edit (new iv, same row)
fine; iv altered by the server -> decrypt fails (not a replay, an AEAD failure); FIFO eviction and per-account
isolation tests still pass; the store key is versioned. Plants: key back to msgId -> the new test goes red.
Update the docs sentence "msgId is a replay hint" to say what the replay key is now and the remaining honest
limit (per-device, windowed, same-row rollback not covered).

## 2A.2 Crypto module (production: ADD to `dm-v2.js`)

`dmAttachmentAad(...)`, and encrypt/decrypt for the meta using it (reuse the text AES-GCM/HKDF code; no new key
derivation). Node tests: known-answer vectors computed by an INDEPENDENT implementation (node:crypto +
hand-built AAD bytes, as in 1A); one test per AAD field (relabel from/to, version, senderKeyFp, iv, replyToId,
direction -> fails); a text envelope does NOT open as attachment meta and the reverse; the two labels are
distinct and neither is a prefix of the other (extend the 1A "info strings" style assertion to AAD labels); a
KAT proving `dmMessageAad` output is unchanged. For EVERY test group plant a violation (drop replyToId, swap field
order, use the text label for meta) and show it red.

## 2A.3 Server

Implement D6. Real-server tests: v2 meta + v2 caption stored verbatim for a min-2 recipient; v2 meta for a min-1
recipient refused (status asserted, nothing stored, upload file removed); v2 caption only (v1 meta) for min-1
refused; v1 meta + v1 caption accepted for everyone (existing behaviour); malformed v2 shapes (bad iv length,
missing senderFp, missing msgId, version 3) refused; the server never changes a stored byte. Existing
`tests/dm-attachments/*` stay green and unedited. Plants: accept v2 for min-1 -> red; keep `version === 1` only
-> red.

## 2A.4 Client send and receive

`prepareDmAttachmentUpload`: version choice + pin per D5 before any file work, v2 meta + v2 caption with the
`replyToId` passed by the composer (D4). `decryptAttachmentMetaEnvelope` / `applyAttachmentMeta` /
`applyReplyAttachmentMeta`: v2 path per D7. Seam test first, no mocks: the real prepare function against the real
server returns fields the server accepts; the real receive path opens them. Node tests: version selection (min 1
-> v1 envelopes byte-shape unchanged, min 2 -> v2); pin refusal happens before the file is read (spy on
`file.arrayBuffer/slice`); caption over the cap refused client-side; `decryptIncomingMessage` still throws on v2
without context; static test that nothing imports `encryptAttachmentForDm` / `decryptAttachmentForDm`.

## 2A.5 Real-browser tests (`tests/dm-v2-attachments-browser.test.mjs`)

One process per account, reload + re-login, exact-postcondition polls, fresh `newUserPage`, `sendOnce`-style
helpers (no double send). Each has a positive control. Scenarios:
a. image + caption to a v2 peer: bob sees the decrypted image and caption; stored `attachment_meta` and `content`
   are version 2; the blob on disk is not plaintext.
b. voice note to a v2 peer plays after the first play (lazy decrypt unchanged).
c. an attachment that is itself a reply to a text message, and a reply to an attachment message (quote shows the
   attachment label): replyToId binding works both ways.
d. recipient created at default 1: attachment stays v1 (stored version 1), no notice.
e. history: a v1 attachment row from a peer pinned at 2 still opens; the downgrade notice appears once per load.
f. tamper through the test's own DB connection, one test each: strip meta `version` 2->1; rewrite `senderId`;
   rewrite `recipientId`; change `reply_to_id`; swap `attachment_meta` between two attachment rows; put a TEXT v2
   envelope into the `attachment_meta` slot (type confusion); put an attachment-meta envelope into `content`.
   Expect "Attachment unavailable" for that row only, other rows rendered, no key material in `document.body`.
g. replay: copy an attachment row (meta + path) to a new row id, with and without changing `msgId` (iv unchanged):
   the second is unavailable in both cases.
Plants (red, restore, green, pasted): label swapped to the text label for meta; replyToId not passed by the
composer; pin check skipped; replay keyed by msgId again; server accepts v2 for min-1; the v2 branch ignored in
`decryptAttachmentMetaEnvelope`.
Regression, your own runs pasted: `tests/dm-attachments/*` (all, env=1 and default), `peer-trust-browser`,
`dm-v2-wire-browser`, `dm-v2-wire-browser-paths`, `dm-csp-handlers-enforced-browser`,
`acceptance-xss-sweep-browser`, `dm-blob-url-cleanup`.

## 2A.6 Docs, then ship

- `docs/DM_ATTACHMENTS_E2EE.md`: replace "an envelope encrypted with the existing DM session key (...no forward
  secrecy...)" with the real description (v1 for v1 peers, v2 with AAD for v2 peers, labels, replay key), keep the
  "not covered" list honest.
- `docs/e2ee-dm-hardening.md`: update the 3.5 status (attachments v2 shipped; `attachmentId` dropped and why;
  replay key is the iv; what is still NOT done: group attachments disabled, Phase 3, no real Safari/Firefox/phone
  run, per-device replay window, the dead DM functions in `attachment-crypto.js`).
- `docs/DM_V2_WIRE.md`: Observed on Linux section stays reviewer-owned; add yours separately.
- Rebuild the manifest if `public/` changed and explain why. Suite three ways on the 72-file non-browser set (+ new
  node/server files): (i) wire-final-30 baseline, (ii) `DM_E2EE_DEFAULT_MIN_VERSION=1`, (iii) default; (ii) and
  (iii) 0 fail, 0 cancelled. Say which browser files you ran separately and their counts.
- Verify the ZIP from a clean directory (manifest `--check`, `grep -rlc $'\r'` on text files in public/, sw-manifest
  test, the new test files). `git diff --name-only b777db4..HEAD` must list only the allowed files; paste it.
- Zip `wire-final-31`: sha256, bytes, entries, `unzip -l | grep` for every new file.

## Report format, then STOP

1. Contradictions found (with file:line). 2. Per sub-step: change, tests, red/green plant output. 3. The replay
bypass before/after. 4. Suite counts and the browser runs. 5. Every bug a new test found: root cause, the one-line
fix or STOP. 6. Changed files + `git diff --name-only` proof. 7. Verified-by-me vs not run. 8. Zip block.
If a sub-step needs a change outside section 2, STOP and ask. Phase 3 is NOT part of this task.
