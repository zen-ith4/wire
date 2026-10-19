# STEP 2B - the real-browser attachment tests that 2A could not finish (tests and docs only)

Put this file at `docs/agent-tasks/STEP_2B_AGENT_TASK.md` and the reference file at
`tests/_reference/probe-attachment-v2.mjs` (it has no `.test.` in the name, so `scripts/run-tests.mjs` ignores it).
Base: wire-final-31 (sha256 62a326f6...ddfd8, HEAD dbd2fd5). Output zip: `wire-final-32`.
NO production change. If a test needs one, STOP and report. One commit per item, 5-line report per item.

## 0. What the reviewer verified on Linux (copy into docs/DM_V2_WIRE.md "Observed on Linux")

wire-final-31, real Chromium, node v22.22.2:
- non-browser set (74 files): 636 tests, 631 pass, 1 fail, 4 skipped. The 1 fail is the known pre-existing race
  `deleting the message removes the ciphertext file from disk` (fire-and-forget `fs.unlink` before the response,
  `dm.controller.js` ~931; passes alone; same code in wire-final-25). Not caused by 2A.
- browser regression, all pass: dm-v2-wire-browser, dm-e2ee-default-browser, peer-trust-browser (3),
  dm-csp-handlers-enforced-browser (2), acceptance-xss-sweep-browser (8, 1 skip), paths tests a-d.
- reviewer probe (`reference/probe-attachment-v2.mjs`), alice uploads a file with a caption through the real
  composer to bob: bob opted in to v2 -> stored `attachment_meta` v2 and caption v2, bob sees the caption and the
  file name; bob at default 1 -> both stored v1, same result. With the v2 meta mutated in the DB (`version` 2->1;
  one ciphertext character flipped; `changes=1`): bob's row shows "Attachment unavailable", the caption is still
  shown, other rows still render.
So the happy path and two tampers are proven by hand. What is NOT committed as a test is what you do now.

## 1. `tests/dm-v2-attachments-browser.test.mjs` (real browsers)

Base it on the reference probe: upload with `(await page.$('#dm-file-input')).uploadFile(file)`, wait for
`#dm-attach-staging .attach-chip`, type the caption, `window.sendDm()`, then wait on the exact postcondition
(row count, not sleeps). One process per account, reload + re-login, `waitDecrypted` before any
`replyToDmMessage`. Each test: positive control first, `SELECT id ...` + `UPDATE ... WHERE id = ?` with
`changes === 1` asserted and read back, failure expected only on the tampered row.
a. file + caption to a v2 peer: stored `attachment_meta` and `content` are version 2; bob sees the caption and the
   file name; the blob on disk does not contain the plaintext bytes.
b. recipient at default 1: stored meta and caption are version 1; bob reads both.
c. reply binding: an attachment sent AS a reply to a text message (stored `reply_to_id` equals the parent row id,
   bob sees the quote), and a text reply to an attachment message (the quote shows the attachment label).
d. history: a v1 attachment row from a peer pinned at 2 (insert through the test's DB connection) still opens,
   and the downgrade notice appears once per page load.
e. tamper, ONE TEST EACH, expectation "Attachment unavailable" on that row only, caption of the same row shown,
   the other rows rendered, no key/iv/`senderFp` material in `document.body.innerHTML`:
   1 meta `version` 2->1; 2 meta `senderId` rewritten; 3 meta `recipientId` rewritten; 4 row `reply_to_id` changed;
   5 `attachment_meta` swapped between two attachment rows; 6 a TEXT v2 envelope (copied from a text row) put in the
   `attachment_meta` slot (type confusion); 7 the attachment meta envelope put into the `content` slot.
f. replay: copy an attachment row (meta + `attachment_path`) to a NEW row id (insert), once with the envelope
   untouched and once with the clear `msgId` changed (iv untouched): the second row is "Attachment unavailable" in
   both cases, the first row stays fine, and reading the first row twice is not a replay.
g. voice: the voice path needs the recorder; do NOT fake it in the browser. Cover `isVoice: true` in the node
   test of `prepareDmAttachmentUpload` (real server) and say plainly in the report that the recorder UI is not run.
Plants (red, restore, green, pasted; Python edits with real newlines and LF; after each restore `git diff --stat`
is empty and CR=0): label for meta set to the text label; composer stops passing `replyToId` (c); decrypt keeps
reading `msgId` for replay accounting (f); server accepts v2 for a min-1 recipient (b/a); the v2 branch in
`decryptAttachmentMetaEnvelope` ignored (a, e). A plant that stays green means the test does not test it:
say so, do not claim coverage.

## 2. Hygiene (no behaviour change)

1. `dm-v2.js` ~315: the doc-comment on `dmMessageAad` still says msgId is a replay hint. A COMMENT-ONLY edit is
   allowed (the code and the 1A known-answer tests must stay byte-identical: show `git diff -U0` containing only
   comment lines) so it says the replay key is now the iv.
2. `docs/DM_ATTACHMENTS_E2EE.md`: it says the server's `isEncryptedEnvelopeShape` accepts the v2 meta "unchanged".
   It was changed in 2A (`dm.controller.js` ~188-221). Correct the sentence.
3. Update the 3.5 status and `DM_ATTACHMENTS_E2EE.md`: the browser scenarios now exist (or list which ones still
   do not and why). Keep the honest-limits list.
4. `tests/dm-blob-url-cleanup.test.mjs` had its `message-crypto.js` mock completed again in 2A (4 names). Do not
   touch it further; report in one line that this mock is a recurring cost and ask the reviewer if it should be made
   robust (decision for the reviewer, not yours).

## 3. Verify and ship

Run your own: the new browser file, `tests/dm-v2-wire-browser-paths.test.mjs`, `peer-trust-browser`,
`dm-v2-wire-browser`, `dm-attachments/*`, `dm-csp-handlers-enforced-browser`, `acceptance-xss-sweep-browser`.
Suite three ways on the 74-file non-browser set (+ the new browser file counted separately): (i) wire-final-31,
(ii) `DM_E2EE_DEFAULT_MIN_VERSION=1`, (iii) default; list the pre-existing flaky test by name if it fails
and show it passing alone. `public/` must not change, so `build-sw-manifest --check` stays 4550bf574878.
Verify the ZIP from a clean directory. `git diff --name-only dbd2fd5..HEAD` lists only tests and docs (+ the
comment-only `dm-v2.js` line). Zip `wire-final-32`: sha256, bytes, entries, `unzip -l | grep` new files. Report
every bug a new test found (root cause; one-line fix or STOP). Then STOP. Phase 3 and group attachments are not
part of this task.
