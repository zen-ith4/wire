# STEP 1E - prove the v2 happy path, then audit the seams

Put this file at `docs/agent-tasks/STEP_1E_AGENT_TASK.md`.
Base tree: `wire-final-24`. Output zip: `wire-final-25` (only if something changes).
Why: 1D found that `buildDmV2Content()` did not return `content`, so every real v2 send had an empty
body. Every 1B test missed it because they asserted on `contentChars` or called helpers directly.
Consequences that drive this step:
- The happy path (send -> store -> read -> decrypt) is still NOT covered (scenarios 2, 3, 10, 13 skipped).
- Tamper tests 5-8 pass, but a tamper test is only meaningful if the UNTOUCHED row decrypts.
- The `v2 text end to end` browser test failed on Windows and was blamed on "renderer freeze". It may
  have been this bug. "Windows-only" attributions are not evidence until re-checked.
- dm.js -> message-crypto.js -> dm-v2-wire.js -> dm-v2.js is a chain of seams that were only ever tested
  with mocks (`dm-blob-url-cleanup` mocks `encryptDmTextV2`). More mismatches of the same kind may exist.

Rules: paste real command + real output for every claim. No edits to `tests/fixtures/*`, attachments,
groups, `PORT_NOTES.md`, `scripts/run-tests.mjs`, v1 files, `services/`, or the wire format. Production
changes only where item 4 allows (minimal, one finding at a time, each reported). Do not start Phase 3.

## 1. Re-check the "Windows freeze" attributions (cheap, do first)

1. With the `content` fix in place, run each ALONE 3 times with `--test-timeout=60000`:
   `tests/dm-v2-wire-browser.test.mjs`, `tests/dm-e2ee-default-browser.test.mjs`,
   `tests/peer-trust-browser.test.mjs`, `tests/mobile-groups-tab-browser.test.mjs`.
   Table: file | run 1/2/3 | first error line.
2. If `dm-v2-wire-browser` now passes on this machine, say so: the earlier "renderer freeze" label was
   wrong for it. Then `grep -rn -i "windows" docs/test-baseline.md docs/*.md` and list every claim of the
   form "Windows-only freeze" with the evidence given for it. Mark each as `claim, not re-verified` unless
   you re-verify it. Do not edit those docs; report.

## 2. Unblock identity restore under node (the 1D blocker)

Blocker as reported: `GET /api/me/identity-key` sits behind `authenticatePasswordChange`; a plain login
token gets 401 for a scheme-1 fixture user.
- Option A (preferred): register a NEW scheme-2 account through the real registration API, driving it
  with the real client modules (`public/js/crypto/account-kdf.js`, the registration/identity creation code)
  under node, then log in normally and call `restoreIdentity`. No fixture user, no migration chain.
- Option B (fallback, label it clearly in the test): mint a password-change token in the test using the
  JWT secret from `tests/test.env` for the server you spawned. Test-only helper inside the test file;
  no change to `authenticatePasswordChange` or any server file.
Use A if it works with reasonable effort; else B. State which and why. If neither works, give the exact
failing call and STOP that item.

## 3. Cover the skipped scenarios (un-skip the 3 markers in `tests/dm-v2-protocol-e2e.test.mjs`)

2. v2 end to end through the REAL functions: alice calls the real `encryptDmTextV2`, the body goes through
   the real send route, bob reads the row from the real read route and `decryptDmTextV2` returns the exact
   plaintext (pass the server row id and `reply_to_id`). Bob replies; alice decrypts.
3. replyToId stability: the value at encrypt time equals the stored `reply_to_id` and the value re-read.
10. Edit: new `msgId`, same `replyToId`, decrypts; refused for a min-1 recipient.
13. Key rotation between a v2 send and the read (with the retired-key rule), if it runs under node; else
    NOT COVERED with the exact blocker.
Then run the plant you could not run before: PLANT 4 (client ignores the row's `reply_to_id`) -> RED.
Plant also: `buildDmV2Content` stops returning `content` again -> scenario 2 must go RED (this is the
regression test for the bug 1D found).

## 4. Positive controls for tamper tests 5-8, and the contract audit

1. For each tamper test (version strip, senderId, recipientId, reply_to_id): in the SAME test, first
   assert the untouched row decrypts to the exact plaintext, then tamper and assert the failure, and assert
   the failure is the authentication/binding error, not "no key", "bad JSON" or "unsupported version".
   Say how the envelopes in tests 5-8 were produced today (real `encryptDmTextV2` + real send route, or
   `dm-v2.js` primitives). If primitives, replace with the real path now that item 2 unblocks it.
2. Seam audit. Table of every cross-module call in the v2 path, both ends with file:line:
   `dm.js` (`encryptForActivePeer`, `buildTextBody`, `buildEditBody`, the three version guards, preview,
   reply preview) -> `message-crypto.js` (`encryptDmTextV2`, `decryptDmTextV2`) -> `dm-v2-wire.js`
   (`buildDmV2Content`, `openDmV2Envelope`, `classifyDmV2MsgId`, `assertDmVersionAllowed`,
   `assertDmV2ContentFits`) -> `dm-v2.js`; plus `peer-keys.js` (`getPeerDmMinVersion`) and the server
   handlers (`sendMessage`, `editMessage`, `getConversationsHandler`, `getUserIdentityPublicKey`).
   Columns: caller file:line | what it destructures/reads | callee file:line | what it returns/sends |
   match yes/no.
3. For every `no`: report it first. If the fix is one line, fix it and add a node test that calls the real
   functions with NO mocks and asserts the shape (non-empty `content`, parseable to a v2 envelope, accepted
   by the real server). If more than three mismatches, or any needs more than a one-line change, STOP and
   report instead of fixing.
4. `dm.js` glue: check whether `encryptForActivePeer`/`buildTextBody`/`buildEditBody` can be imported under
   node. If yes, test them unmocked. If they are DOM-bound, say so and list them as browser-only. In either
   case, add a check that the v2 path produces a non-empty `content` and a body field set that the real
   server route accepts.

## 5. Linux procedure (documentation, no code)

Write `docs/ci/RUN_ON_LINUX.md`: a copy-paste procedure for (a) WSL2 Ubuntu on Windows
(`wsl --install -d Ubuntu`, node 22, `npm ci`, `CHROMIUM_DIR=/tmp/browser-check`, the exact commands for
the four browser files and the full suite with `--test-timeout=60000`), and (b) GitHub Codespaces or the
existing `docs/ci/linux-tests.yml`. Mark every step you could not run here.

## 6. Report, then STOP

1. Item 1 table and the claims list.
2. Item 2: option used and why.
3. Item 3 table (scenario | test | executed | planted-red output | result), including the new
   "content not returned" plant.
4. Item 4: positive-control proof per test, the seam table, every mismatch found and what was done.
5. Three suite runs on the same 70-file set plus new files: (i) wire-final-24, (ii) env=1, (iii) default,
   in the baseline format, (ii) with 0 fail.
6. Changed/new files, `git diff --name-only fb240ed..HEAD`-style proof that MUST-NOT-TOUCH is untouched,
   manifest rebuilt if `public/` changed.
7. Still NOT proven (browser UI, held messages, banner, previews rendering).
8. Zip `wire-final-25`: sha256, bytes, entries, `unzip -l | grep` new files. STOP.
