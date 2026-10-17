# STEP 1D - close the verification gap: protocol-level E2E without a browser (+ 1C cleanups)

Put this file at `docs/agent-tasks/STEP_1D_AGENT_TASK.md`.
Base tree: `wire-final-23` (fb240ed). Output zip: `wire-final-24`.
Why: no browser test of DM v2 has ever run on this machine (Windows renderer freeze, no Linux). Six
1B scenarios are `NOT COVERED` and the three 1C browser scenarios were never written. Most of what they
check is PROTOCOL behaviour (server rewrites, replay, version strip), not UI. This step proves that part
with a real server and the real client crypto modules, in plain node. UI rendering stays
Unverified-until-Linux and is not claimed.

Rule for every item: paste the real command and real output. "Verified" without output = not done.
Do not touch: `tests/fixtures/*`, attachments, groups, `PORT_NOTES.md`, `scripts/run-tests.mjs`, v1 files,
the wire format. Production code changes are NOT part of this step except where item 1 says; if a test
needs a production change, STOP and report.

## 0. Decisions recorded by me (the reviewer) - copy into `docs/DM_V2_WIRE.md` under "Decisions"

1. `services/auth.service.js`: the extra `const constants = require('../config/constants')` line is
   ACCEPTED (option a). It is the smallest way to keep the default in one place. Nothing else in that file.
2. `tests/dm-blob-url-cleanup.test.mjs`: the two-line mock completion (`encryptDmTextV2`, `decryptDmTextV2`)
   is ACCEPTED. It fixes a 1B regression; no assertion changed.
3. A fifth `INSERT INTO users` site exists that earlier reports missed: `utils/setupWizard.js:632`
   (first-admin wizard). Full list that stays at DEFAULT 1: `database/seed.js:55`,
   `utils/setupWizard.js:632`, `services/user.service.js:91`, `services/user.service.js:290`.
   Say it once in the doc: "default 2 applies to self-registration only".

## 1. 1C test hygiene (the only allowed edits to existing 1C files)

1. Under `DM_E2EE_DEFAULT_MIN_VERSION=1` the suite had 1 new fail: the test
   `new account (env default 2) gets dm_e2ee_min_version = 2` reads the ambient env. Make it pin its own
   env (spawn with `serverEnv({ DM_E2EE_DEFAULT_MIN_VERSION: '2' })` or whatever `serverEnv()` accepts),
   so it holds under any outer env. Do the same for every other test in
   `tests/dm-e2ee-default.test.mjs` that assumes a specific default. Do not touch any other test file.
2. Re-run (i) wire-final-22 non-browser set, (ii) env=1, (iii) default, on the SAME 70-file list as last
   time plus the new files. Required: (ii) = 0 fail, 0 cancelled. Report counts in the baseline format.
3. Plant #9 of the last report ("boot validator accepts the empty string") made 7 tests fail. A change that
   only accepts `""` should break only the `""` case. Redo it with the MINIMAL plant (accept `""` and
   nothing else), paste which tests fail, and say why 7 was too many (a broader plant, or tests that
   share state). If tests share state, report it; do not rewrite them.
4. Plant #7 ("opt-in script allowed to lower") was answered with "covered by trigger tests". Spec item
   3(b) asks for a test that the ADMIN SCRIPT refuses to lower. Show the exact test that exercises the
   script against a user already at 2 (and against a lower target if the script has such an argument),
   then plant a lowering path in the script and show the script test (not the trigger test) go red.
   If the script has no lowering input at all, write the test so that it proves the row is unchanged
   after running the script on a 2 user, and plant by removing the `WHERE dm_e2ee_min_version < 2`
   guard together with the trigger to show the test catches it.

## 2. New file: `tests/dm-v2-protocol-e2e.test.mjs` (node, real server, real client crypto, no browser)

Setup: spawn the real `server.js` through `serverEnv()` on a temp DB (same pattern as
`tests/credentials/_server.mjs`). Register users through the REAL registration API, not by INSERT, except
where a test needs a v1 account: start a second server process with `DM_E2EE_DEFAULT_MIN_VERSION=1`
(or INSERT 1 directly) and say which you used. Run the client side with the REAL modules
`public/js/crypto/messages/{message-crypto,payload,dm-v2,dm-v2-wire}.js` and
`public/js/crypto/keys/*`.

These modules were written for a browser. If they need `indexedDB`, `localStorage`, `sessionStorage`,
`fetch` base URL or `window`, a TEST-ONLY shim inside the test file is allowed (in-memory
`localStorage`/`sessionStorage`, a `fetch` wrapper pointing at the spawned server). Do not edit any file
under `public/` to make this work. If a module cannot run under node even with such shims, say exactly
which API is missing and which scenarios that blocks; do not invent a fake of the crypto itself.

Each scenario is its own test. Poll on exact postconditions (HTTP status, row content), no fixed sleeps.
The server is untrusted, so the "malicious server" tests edit rows in the DB file directly, then read
them back through the real read API and decrypt with the real client code.

1. New account is 2: `GET /api/me/identity-key/:userId` returns `dmE2eeMinVersion: 2` for a freshly
   registered user; for the v1-created user it returns 1.
2. v2 end to end: alice sends v2 to bob through the real send route; bob reads the row from the real read
   route and `decryptDmTextV2` returns the plaintext, passing the server's row id and `reply_to_id`.
   Also bob replies; alice decrypts.
3. replyToId stability: a v2 reply sent through the real send path decrypts after re-read; the value known
   at encrypt time equals the stored `reply_to_id`.
4. v1-created recipient: v2 send is refused by the server (status asserted); a v1 send is accepted and
   decrypts; the server stores nothing for the refused v2.
5. Server strips version 2 -> 1 in the stored content: decryption FAILS (assert it throws; a silent
   success is the bug).
6. Server rewrites `senderId` in the stored content: fails. 7. Rewrites `recipientId`: fails.
8. Server changes `reply_to_id` of the row: fails.
9. Replay: the stored content of one row copied into a second row (new row id): the second is dropped as
   a replay by the real replay check; reading the FIRST row twice is NOT a replay.
10. Edit: a v2 edit produces a new `msgId`, same `replyToId`, decrypts, and is refused for a min-1 recipient.
11. Downgrade pin: after a v2 exchange, a v1 send to that peer throws `DmDowngradeRefusedError`; a stored
    v1 row from that peer still decrypts (history).
12. Size guard: a v2 message whose envelope exceeds 2000 chars is refused client-side and never sent.
13. Key rotation between a v2 send and the read: implement only if the key archive and
    `mayTryRetiredKey` run under node with the shims. Otherwise list it as NOT COVERED with the reason.

Planted violations (RED then restored, per test, paste output): drop replyToId from the AAD (2, 3),
make the client ignore `version` when picking the path (5), skip the senderId binding (6, 7), ignore the
row's `reply_to_id` (8), treat same-row as replay and, separately, never detect replay (9), let the server
rule accept v2 for min-1 (4), make the pin fall back silently (11).

## 3. CI recipe (documentation only, not activated)

Write `docs/ci/linux-tests.yml`: a GitHub Actions workflow for `ubuntu-latest` that installs deps, sets
`CHROMIUM_DIR`, runs `node scripts/build-sw-manifest.mjs --check`, then the full suite with
`--test-timeout=60000`. Do NOT put it under `.github/`. State which command inside it you could not
test here. Add one paragraph to `docs/DM_V2_WIRE.md`: "browser tests for DM v2 are
Unverified-until-Linux; run this workflow before relying on the UI path".

## 4. Report, then STOP

1. Item 1: the three suite runs with counts; the minimal plant result; the admin-script test and its red.
2. Item 2: a table (scenario | test name | executed here | planted-red output | result). Scenarios that
   could not run: the exact blocker.
3. A short "what is still NOT proven": list the scenarios that remain browser-only (UI rendering of
   held messages, banner, notice, previews).
4. Changed/new files, MUST-NOT-TOUCH proof (`git diff --name-only fb240ed..HEAD`), `public/` untouched.
5. Zip `wire-final-24`: sha256, bytes, entries, `unzip -l | grep` of new files. STOP. No Phase 3.
