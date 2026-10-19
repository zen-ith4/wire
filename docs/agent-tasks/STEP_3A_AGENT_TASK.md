# STEP 3A - Group attachments: design first, no production change

Put this file at `docs/agent-tasks/STEP_3A_AGENT_TASK.md`.
Base: `wire-final-33` (SHA256 `e4ebd72dc036af14e060327423d12f133d126f7f0824b123ff0ab94d27147243`, 522 entries, 464 files).
Output zip: `wire-final-34`.

Rules for this step:
- One commit per item. Report each item in at most 5 lines.
- **No production change.** `public/`, `routes/`, `controllers/`, `services/`, `database/` stay untouched. If you believe a production change is needed, STOP and report why. Do not make it.
- Do not enable group attachments. They stay disabled.
- Only tests (item 0) and docs (items 1-3) change.
- Do not write down a number you did not run, and do not mark anything "Verified" that you did not see. Paste raw output for every check.
- Read the code before you describe it. Cite `file:line` for every claim about current behaviour. Do not guess from the docs.

---

## 0. Small leftover fix from the last round (tests only)

File: `tests/dm-v2-attachments-browser.test.mjs`, test `c2b`.

The title says the quote "falls back to the parent attachment label". The asserts (and your own report) say something different: the quote shows the parent's real decrypted file name, and does NOT show the opaque `encrypted-attachment` placeholder.

- Change only the title, for example:
  `c2b. a text reply to a CAPTION-LESS attachment: the quote shows the parent's decrypted file name (not the opaque placeholder), and no key/iv/ciphertext material reaches the DOM`
- Do not touch the asserts.
- Run only that test: `node --experimental-test-module-mocks --env-file=tests/test.env --test --test-name-pattern="^c2b\." tests/dm-v2-attachments-browser.test.mjs` and paste the raw result.
- Run `node --check` on the file and `node scripts/build-sw-manifest.mjs --check`. Paste both.

---

## 1. Why this step exists

`docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` section 6.7, limitation 5, says:

> Group attachments are disabled and must bind their bytes into the signature before they are ever enabled. The envelope has a reserved, empty attachment slot in the signed bytes; an envelope carrying attachment fields is refused; the attachment bytes themselves are only AEAD-protected under the Sender Key, so any member could forge a file "from" the key's owner.

The same document lists "Before group attachments are ever enabled, bind their bytes into the signature" as a proposal (item 23 in the list near line 389), and the test `C3-12` in `tests/groups/group-signing-messages.test.mjs` fails if any client module starts calling `encryptAttachmentForGroup`.

The reason in one sentence: AES-GCM under a Sender Key is symmetric, so every member who holds Alice's Sender Key could encrypt a file that decrypts fine "as Alice". Phase C fixed that for message text by signing every message with the Sender Key's own ECDSA P-256 key. Files are not covered yet.

This step produces the design. Implementation is a later step (3B), after the design is reviewed.

---

## 2. Read first (do not skip, and cite what you read)

1. `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` sections 6 and 7 (signing format, the 8 signed fields, where the "attachment slot" sits, the limitations list).
2. `tests/groups/group-signing-messages.test.mjs`, especially `C3-12`.
3. The client crypto for groups: `public/js/crypto/groups/message-crypto.js`, `groups/codec.js`, and the group half of `public/js/crypto/messages/attachment-crypto.js` (`encryptAttachmentForGroup`, `decryptAttachmentForGroup`, `attachmentAad`). Find the exact line numbers yourself.
4. How DM attachments work today, because the file bytes use a streaming format: `docs/DM_ATTACHMENTS_E2EE.md`, `attachment-stream.js`, `config/dm-stream.js`, and the DM upload/download server paths.
5. The server side for group file upload (routes/controllers for group messages and uploads): what is stored, what the server validates, what `attachment_iv` means there (the existing server test says uploads without a valid `attachment_iv` are rejected).
6. `docs/DM_ATTACHMENTS_E2EE.md` as the model for how to write the document.

---

## 3. Deliverable: `docs/GROUP_ATTACHMENTS_E2EE.md`

Write it in plain English, facts only, no marketing. It must contain these sections in this order.

### 3.1 Current state (with file:line citations)
- What the signed message bytes are today (label, group, senderKeyId, counter, iv, decoded ciphertext, reply target, attachment slot) and exactly where the empty attachment slot is.
- What `encryptAttachmentForGroup` / `decryptAttachmentForGroup` do today, what AAD they use, and why they are weaker than the DM path.
- What the server stores for a group file, what it checks, and what it cannot check (it is zero-knowledge for content).
- What `C3-12` asserts and how it detects a call.
- Whether any client module imports the group attachment helpers today (expected: none; verify by grep and paste the grep).

### 3.2 The threat, stated concretely
Write each attack as: attacker, what they can do, what they gain, what happens today. At minimum:
1. A group member forges a file "from" another member (shares the Sender Key).
2. A member or the server moves a valid file from message A to message B (splice).
3. Replay of a valid file/message into another group or another row.
4. The server swaps the stored file bytes (ciphertext substitution) while leaving the message untouched.
5. The server truncates or reorders chunks of a streamed file.
6. Nonce/counter reuse: the file encryption reuses a (key, nonce) pair that message encryption already used (Sender Key counters are per device, nonce is 4 zero bytes + 8-byte counter). This is the multi-device failure the group design already had once; make sure files cannot recreate it.

### 3.3 Proposed design
Be specific. Give byte layouts, not prose.
- What goes into the signature for a file: for example a domain-separated digest of the encrypted file bytes (or of the stream header + final MAC/tag), plus the plaintext length, plus the file meta. State exactly which one, and why.
- File key: derived from the Sender Key per file, or a fresh random per-file key carried inside the signed envelope? Compare the two (key-per-file avoids counter coupling; derived-from-sender-key couples files to message counters). Pick one and justify it.
- The envelope change: which fields are added, which already-reserved slot is used, and what stays byte-identical so existing message rows stay readable. State whether the group protocol version changes. (Phase C changed it in place because the group protocol is unreleased; say whether that still holds here and what the evidence is.)
- How the streaming format (`attachment-stream`) fits: where the digest is computed, whether the receiver can verify before rendering/downloading everything, and what happens on a partial or interrupted download.
- Size and cost: how many extra bytes per message, extra work per send and per receive. Use measured numbers if you can run them; otherwise say "estimate".
- Interaction with key rotation and membership: a file sent under a superseded Sender Key, a member who joins later, a removed member. Say what is readable and by whom.

### 3.4 Alternatives considered
At least two real alternatives (for example "sign the whole encrypted file" versus "sign a digest", or "per-file random key" versus "derived key") with a short table: what it costs, what it protects, why you did or did not choose it.

### 3.5 Failure behaviour
- What the user sees when signature or digest verification fails: a per-row placeholder (like the DM "Attachment unavailable"), never a crash, never a thrown error that blocks the thread.
- Other rows in the same thread must still render.
- A malformed envelope that carries attachment fields today is dropped per message (see `K-2` in `tests/groups/group-keys-contract.test.mjs`). Say how that contract changes, if at all.

### 3.6 Test plan (written now, implemented in 3B)
A table: attack from 3.2 -> test name -> layer (node / real server / real Chromium) -> exact expected outcome. Every attack in 3.2 must map to at least one test. Include:
- a positive control for each negative test,
- a test that proves `C3-12` is updated deliberately (it must still fail if anything calls the helpers outside the new, signed path),
- a "no plaintext on disk" check in the same style as `tests/acceptance-no-plaintext.test.mjs`, now for group files.

### 3.7 What this does NOT give you
Be explicit. Examples that probably apply: no forward secrecy; a malicious server on first contact for identity keys is still out of scope; a member can still leak a file they legitimately received; metadata (size, time, who) is visible to the server. Do not claim more than the design delivers.

### 3.8 Open questions for the owner
List decisions only the owner can make (size cap, whether voice messages are included, whether old test groups must be recreated, whether the version label changes). Do not decide these yourself.

---

## 4. Doc consistency edits (docs only)

- `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md`: in section 6.7 item 5 and in the proposals list, add one line pointing to `docs/GROUP_ATTACHMENTS_E2EE.md`. Do not rewrite anything else.
- `docs/e2ee-dm-hardening.md` section 3.5: change the "NOT done" line about group attachments to point to the new doc and say "design written, not implemented".

---

## 5. Acceptance checklist (paste raw output for each)

- [ ] `node --check tests/dm-v2-attachments-browser.test.mjs` -> rc=0
- [ ] `c2b` alone passes with the new title (raw `# tests / # pass / # fail`)
- [ ] `node scripts/build-sw-manifest.mjs --check` -> current
- [ ] `grep -rIl $'\r' public` -> empty
- [ ] `git diff --name-only <base>..HEAD` raw: only `tests/dm-v2-attachments-browser.test.mjs` and files under `docs/` (plus the new zip)
- [ ] `public/`, `routes/`, `controllers/`, `services/`, `database/` have zero diff (paste `git diff --stat` for those paths; it must be empty)
- [ ] Every claim in section 3.1 has a `file:line` citation, and each cited line exists in the zip (spot-check five of them with `sed -n`)
- [ ] Every attack in 3.2 appears in the 3.6 test table
- [ ] The non-browser suite is unchanged: run it in both modes (with and without `--env-file=tests/test.env`) and paste `# tests / # pass / # fail / # cancelled / # skipped / # todo`. The numbers should equal the previous round (637 / 634 / 0 / 0 / 3 / 0 on your Windows run). If they differ, say why.
- [ ] New zip block: NAME, SHA256, BYTES, ENTRIES, files, HEAD, branch, tree state, copied and hash-verified.

## 6. Report format

1. Zip block.
2. Item 0 result (c2b).
3. Link/summary of `docs/GROUP_ATTACHMENTS_E2EE.md`: the chosen design in five lines, and the open questions for the owner.
4. Raw acceptance output.
5. **Verified / Unverified.** Verified means you ran it and saw it. Anything you only read, estimated or inferred goes under Unverified (Linux, non-Chromium and the voice recorder stay unverified unless someone ran them).

## 7. Do not

- Do not implement, enable or stub group attachments, and do not change `C3-12`.
- Do not change `public/` just to make a design look easier. If the design needs a code change, describe it in the document and stop.
- Do not start forward secrecy (Phase 3 in `docs/e2ee-dm-hardening.md`). That is a separate owner decision; the document's own recommendation is to keep static-static for now.
- Do not weaken any assert or delete a test to keep the suite green.

## STOP
After the zip and the report, stop. Step 3B (implementation) starts only after the design is reviewed.
