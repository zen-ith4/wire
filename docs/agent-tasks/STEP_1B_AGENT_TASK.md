# STEP 1B - wire DM v2 for TEXT messages (opt-in per peer, with downgrade defences)

Put this file at `docs/agent-tasks/STEP_1B_AGENT_TASK.md` in the repo (docs only; it does not
touch `public/`, so it does not affect the manifest).

Base tree: the uploaded `wire_test.zip` = STEP 1A state (new `public/js/crypto/messages/dm-v2.js`
and `tests/dm-v2.test.mjs` exist; nothing else of DM v2 exists). Output zip: `wire-final-21`.
Authoritative design: `docs/e2ee-dm-hardening.md` sections 3, 4, 5 (read them first, follow them
exactly). If anything in it contradicts the code, STOP and say so instead of deviating.

---------------------------------------------------------------------------------------------

## 0. What I (the reviewer) verified on the uploaded tree

- `tests/dm-v2.test.mjs`: 21 tests, 21 pass, on node v22.22.2 (no browser needed).
- `node scripts/build-sw-manifest.mjs --check`: current (version a35a13b85a5a, 174 files).
- `grep -rn dm_e2ee_min_version` finds it ONLY in `docs/e2ee-dm-hardening.md`. There is no column,
  no server rule, no client switch. So 1B has not been started in this tree.
- Not verified by me: any browser test, the full suite (no `node_modules`, no Chromium here).

## 1. READ-FIRST contradictions (report these at the top of your report; do not silently "fix")

1. **DM attachment E2EE IS wired in this tree.** The task text and `docs/PORT_NOTES.md` say it is
   not. The code says otherwise:
   - `controllers/dm.controller.js:112` `e2eeAttachmentsEnforced()` defaults to `true`
     (`DM_E2EE_ATTACHMENTS_ENFORCED`), `sendEncryptedAttachment()` is the default path.
   - `public/js/media/attachment-e2ee.js:341,349` calls `encryptOutgoingMessage()` for the
     attachment meta and the caption; `:110` calls `decryptIncomingMessage()`.
   - `docs/DM_ATTACHMENTS_E2EE.md` and `tests/dm-attachments/*` (60 tests) exist.
   `docs/PORT_NOTES.md` is therefore stale. Do NOT edit it. Report the contradiction.
   **Consequence for you:** `encryptOutgoingMessage` and `decryptIncomingMessage` in
   `public/js/crypto/messages/message-crypto.js` are shared with attachments. Their v1 behaviour
   must stay byte-identical. v2 text goes through NEW functions (section 4.3), never through a
   changed `encryptOutgoingMessage`. Attachment encryption is not enabled, disabled or modified
   (same rule as before: do not touch it; only note it in the report).
2. **Server truncates `content` to 2000 characters** (`dm.controller.js:324` in `sendMessage`,
   `:794` in `editMessage`, `.trim().slice(0, 2000)`). Measured by me with a synthetic envelope:
   a v1 text message already breaks (JSON cut mid-string, undecryptable) above ~1391 plaintext
   bytes; a v2 envelope is ~63 bytes bigger (`senderFp` 44 + `msgId` 16 + key names), so the
   limit drops to ~1328. This is a latent v1 bug, not yours. Do NOT change the 2000 cap. Do:
   (a) in the v2 send path only, refuse to send when `JSON.stringify(envelope).length > 2000`
   with a visible error (never send a truncated v2 envelope); (b) a test pinning the boundary;
   (c) report it as a finding for me.
3. **Four code paths INSERT into `users`** (matters for 1C, noted here so 1B does not hide it):
   `services/auth.service.js:385` (registration), `services/user.service.js:91`,
   `services/user.service.js:290` (admin create), `database/seed.js:55` (seed admin).
   1B must not change any of them. Just list them in your report.

## 2. Paths

READ before coding:
- `docs/e2ee-dm-hardening.md` sections 3.3, 4.2, 4.3, 5.1-5.6, 8 (Phase 2)
- `docs/BROWSER_TEST_ISOLATION.md` (one process per account; why)
- `public/js/crypto/messages/dm-v2.js` (the module you will call; 711 lines, exports listed in 4.3)
- `public/js/crypto/messages/{payload,message-crypto,encrypt,decrypt}.js`
- `public/js/crypto/keys/{peer-keys,peer-trust,session}.js`, `public/js/chat/dm-key-trust.js`
- `public/js/crypto/account-kdf.js` (the pin pattern to mirror: `isScheme2Pinned`, `DowngradeRefusedError`)
- `database/migrations.js`, `database/tables/users.tabels.js`, `controllers/dm.controller.js`,
  `controllers/me.controller.js` (`getIdentityKey`, line ~668), `routes/me.routes.js`
- `tests/_acceptance-harness.mjs`, `tests/credentials/_server.mjs`, `tests/peer-trust-browser.test.mjs`

MAY CHANGE (and only these):
- `database/migrations.js` (add the column to `VALID_COLUMNS.users`, same pattern as `auth_scheme`)
- `controllers/dm.controller.js` (server rule in `sendMessage` and `editMessage` only)
- `controllers/me.controller.js` (expose `dmE2eeMinVersion` in `getIdentityKey` response, additive field)
- `public/js/crypto/messages/payload.js` (becomes a switch), `message-crypto.js` (ADD functions,
  existing two stay byte-identical for v1), `public/js/crypto/keys/peer-keys.js` (ADD a function)
- `public/js/chat/dm.js` (send path, the three `version !== 1` guards, preview, edit path)
- `public/sw-manifest.js` (regenerate with `node scripts/build-sw-manifest.mjs`, explain why)
NEW files:
- `public/js/crypto/messages/dm-v2-wire.js` (version selection, pin, replay store, send/receive glue)
- `scripts/dm-e2ee-optin.mjs` (admin opt-in script)
- `tests/dm-v2-wire.test.mjs` (node-runnable units)
- `tests/dm-v2-wire-server.test.mjs` (real server, no browser)
- `tests/dm-v2-wire-browser.test.mjs` (real browsers)
- `docs/DM_V2_WIRE.md` (opt-in procedure, replay-store sizing, honest limits)

MUST NOT TOUCH: `public/js/crypto/messages/{encrypt,decrypt}.js` and
`public/js/crypto/keys/{key-derivation,session}.js` (v1, byte-identical), all of `services/`
(including `auth.service.js`), `database/seed.js`,
`tests/fixtures/*` (copy `legacy-x.db` to a temp dir, never edit it),
`public/js/media/*`, `public/js/crypto/groups/*`, `controllers/groups.controller.js`,
`public/js/crypto/messages/attachment-*.js`, `docs/PORT_NOTES.md`, `scripts/run-tests.mjs`.

## 3. Step 0 - baseline, BEFORE the first edit

1. Run `node scripts/build-sw-manifest.mjs --check` and the full suite on the untouched tree and
   record `N tests / pass / fail / skip / todo`. My expectation (unverified): the Linux baseline
   of wire-final-19 was 551/547/0/2/2, plus 21 `dm-v2` tests from 1A = 572. Measure; do not assume.
2. The suite has hung before (CPU 0, no output for 45 min, in the group attachment crypto tests).
   Do not just lower concurrency and retry. Diagnose first:
   - Do not edit `scripts/run-tests.mjs`. Invoke node directly:
     `node --experimental-test-module-mocks --env-file=tests/test.env --test --test-timeout=60000 <files>`
   - Run the hanging file ALONE, 5 times. Report: reproduces every time (deterministic), sometimes
     (environment/order), never (concurrency/resource). Name the test it stops at.
   - Run the rest with `--test-timeout=60000`. If a file still hangs on the UNTOUCHED base, record the
     baseline as `N pass, hang in <file>` and mark it partial. Do not edit, skip or "fix" any
     existing test. Anything that only your sandbox produces stays "Unverified-until-Linux".
3. Report these numbers before writing code. If the baseline is partial, say so in the final report.

## 4. Work items

### 4.1 Server (1B.1)
1. `database/migrations.js` `VALID_COLUMNS.users`:
   `dm_e2ee_min_version: "dm_e2ee_min_version INTEGER NOT NULL DEFAULT 1"`. Idempotent. Test on a COPY of
   `tests/fixtures/legacy-x.db`: migrate twice, column exists, every existing row = 1, nothing else changed.
2. `GET /api/me/identity-key/:userId` (`me.controller.js getIdentityKey`): add `dmE2eeMinVersion`
   (the peer's value). Additive; the existing `publicKey` field and shape stay as they are.
3. Rule with teeth (doc 5.5): in `sendMessage` AND `editMessage`, after `trim()`, try `JSON.parse`.
   If `encryption.version === 2` and the RECIPIENT's `dm_e2ee_min_version < 2`, refuse to store
   (4xx, clear message). For `editMessage` the recipient is `msg.recipient_id` of the stored row.
   Unparseable content, v1, or anything else: behaviour exactly as today. The server never rewrites
   `version`, `senderId`, `recipientId`, `reply_to_id`, `senderFp`, `msgId`; it adds no new field to
   the stored content. Do not apply this rule to the attachment route (`sendEncryptedAttachment`,
   whose `isEncryptedEnvelopeShape` requires version 1 and stays that way).
4. Opt-in, admin-only, not a UI: `scripts/dm-e2ee-optin.mjs <username|id>... [--dry-run]`.
   Needs filesystem access to the DB (that is the admin boundary; say so in `docs/DM_V2_WIRE.md`).
   Idempotent, logs each change, prints `changed N of M rows`, ONLY raises (1 -> 2): implement as
   `UPDATE users SET dm_e2ee_min_version = 2 WHERE id = ? AND dm_e2ee_min_version < 2`. Do not add
   a "lower" option (1C makes this a hard ratchet; do not build anything that has to be removed).
5. Default stays 1, so with no opt-in the system behaves EXACTLY as today. Prove it: the whole
   existing suite gives the same counts as the Step 0 baseline (plus your new tests, zero new failures).

### 4.2 Client send (1B.2)
- `getPeerDmMinVersion(peerId)` in `peer-keys.js`: reads `dmE2eeMinVersion` from the same
  `/api/me/identity-key/:id` response. `getPeerPublicKey()` keeps returning exactly what it returns now.
  Treat a missing/invalid field as 1.
- Version choice per peer: peer min 1 -> emit v1 via the unchanged `encryptOutgoingMessage`,
  byte-identical to today. Peer >= 2 -> v2.
- Layer-2 pin in `localStorage`, key `${serverEndpoint}|${localUserId}|${peerUserId}` (take the
  endpoint from the same source `account-kdf.js` uses), value = highest version sent or received.
  Sending v1 to a peer pinned >= 2 -> throw `DowngradeRefusedError` (mirror `account-kdf.js`), show a
  visible warning in the chat, NEVER fall back silently. Storage unavailable (throws / null) -> the
  pin is a no-op and the code proceeds. Wrap every read/write in try/catch.
- `assertCanSendTo` (Phase 2 key-change alarm) still runs first, unchanged.

### 4.3 Client receive and payload switch (1B.3) - exact API of dm-v2.js
Exports you will use: `DM_V2_VERSION`, `deriveDmV2Key(from,to,priv,peerPub)`,
`senderKeyFingerprint(rawPub)`, `newDmV2MsgId()`, `encryptDmV2({plaintext,fromUserId,toUserId,
senderKeyFp,key,replyToId})`, `decryptDmV2({envelope,senderKeyFp,key,replyToId})`,
`buildDmV2Envelope`, `validateDmV2Envelope`, `IvReplayGuard`, `DmV2ValidationError`.
- `payload.js`: `validateEncryptedMessagePayload` becomes a switch on `encryption.version`:
  `1` -> the existing code path untouched, `2` -> `validateDmV2Envelope`, else throw
  `'Unsupported encryption version'`. `createEncryptedMessagePayload` stays v1-only.
- New in `message-crypto.js` (names are suggestions, keep them distinct from the v1 two):
  `encryptDmTextV2(plaintext, senderId, recipientId, replyToId)` and
  `decryptDmTextV2(payload, peerId, {replyToId, rowId})`.
  `decryptIncomingMessage` on a v2 payload WITHOUT that context must throw, never decrypt: the
  attachment code path calls it and must not be able to open or mint v2.
- v2 receive: read the clear `senderFp`, pick the sender key (current, or an archived one from
  `getPeerKeyCandidates`) whose fingerprint matches. The Phase-2 rule `mayTryRetiredKey()` still
  decides whether an archived key may be tried. Own sent messages: the "sender key" is your own
  CURRENT key (an own rotation makes older own v2 rows unreadable; doc 4.4 / test-baseline.md say
  this is known and out of scope - do not add escrow).
- A v1 envelope from a peer pinned >= 2 is still decrypted (history), plus a one-time
  "conversation was downgraded" notice per conversation per page load.
- `public/js/chat/dm.js` has THREE guards that reject anything but version 1 and would show
  "Unable to decrypt" for every v2 message: lines ~394 (message), ~445 (reply preview),
  ~557 (conversation list preview). All three must accept 2.
  The preview and reply_to paths need the AAD `replyToId` of THAT row. Check what
  `getConversationsHandler` (`dm.controller.js:235`) and the `reply_to` object actually carry. If
  `reply_to_id` of the previewed/replied row is missing, add it as an ADDITIVE field and report it;
  do not show "Unable to decrypt" for a healthy v2 message.
- The edit path (`dm.js` ~2146-2700, `editMessage` on the server) re-encrypts: the new envelope gets
  a NEW `msgId`, the same `replyToId` as the stored row, and obeys the same version rules.

### 4.4 msgId replay check - the TRAP (1B.4)
- A replay = the same `msgId` on a DIFFERENT server row id. The SAME row decrypted again (reload,
  scroll, held-message release after accepting a changed key, an edit re-render) is NOT a replay.
- Store: per conversation, `msgId -> serverRowId`, bounded, FIFO eviction, keyed
  `${serverEndpoint}|${localUserId}|${peerUserId}` so accounts and origins cannot collide.
- Proposed numbers (justify or change them in `docs/DM_V2_WIRE.md`, as named constants):
  `DM_V2_REPLAY_PER_CONV_MAX = 2000`, `DM_V2_REPLAY_MAX_CONVERSATIONS = 50`. One entry is about
  16 + ~8 + JSON overhead = ~50 bytes, so 2000 entries is ~100 KB per conversation (~200 KB if
  the browser counts UTF-16), and localStorage is ~5 MB per origin shared with pins and everything
  else. Quote-exceeded on write -> evict and continue, never throw into the UI.
- State the honest limit: a replay older than the window is not detected; this is per-device
  history protection, not a global anti-replay (doc 4.3, 7).
- The check runs BEFORE any key is derived (doc 4.3 step 1). An edit gives the row a new `msgId`;
  the old one for that row may stay in the store (note in docs that a same-row rollback to an old
  version is NOT covered).

### 4.5 replyToId in the AAD (1B.5)
Prove it is stable across the REAL send path in `chat/dm.js`: the value known at encrypt time
equals what the server stored (`reply_to_id`) and what is re-read on reload. `normalizeDmReplyToId`
(`dm.controller.js:46`) can turn a bad id into `null`: show what happens when the client sent an id
the server then nulls (the row would stop decrypting). Make the client send exactly what the server
will keep, or fail loudly. Test it through the real send function, not a copy of its logic.

### 4.6 Phase 2 interaction (1B.6)
Key-change hold / alarm / banner, held-message release and the retired-key rule must work unchanged
for v2. Browser test: a rotation between a v2 send and the read.

## 5. Tests (every new test: plant the violation, show it RED, restore, show GREEN)

`tests/dm-v2-wire.test.mjs` (node, no browser): version selection per peer; pin set/read; v1 to a
pinned-2 peer -> `DowngradeRefusedError`; storage unavailable -> no-op; payload switch (1 / 2 / 3 /
missing); `decryptIncomingMessage` on a v2 payload without context throws; replay store: same row
twice = fine, same msgId on a second row = dropped, size cap evicts FIFO, key does not collide across
accounts/origins; the 2000-char boundary (v2 refused client-side above it).

`tests/dm-v2-wire-server.test.mjs` (real server): migration on a COPY of `legacy-x.db` (idempotent,
rows = 1); `dmE2eeMinVersion` in the identity-key response; v2 for a min-1 recipient is rejected (send
AND edit); v2 for a min-2 recipient is stored verbatim; v1 for anyone is untouched; the server does
not alter a stored v2 content byte; opt-in script (real run, dry-run changes nothing, second run =
0 changed, never lowers).

`tests/dm-v2-wire-browser.test.mjs` (real browsers via `newUserPage`, ONE PROCESS PER ACCOUNT,
reload + re-login between steps, poll on exact postconditions, no fixed sleeps): v2 end to end;
a v1-only peer unaffected; a malicious server strips `version` 2 -> 1 -> decryption FAILS (not silently
succeeds); the server rewrites `senderId` / `recipientId` / `reply_to_id` -> fails; the same stored row
decrypted twice is fine; rotation between a v2 send and the read; opt-in through the admin script.
Planted violations to use: drop `replyToId` from the AAD, swap field order, reuse the v1 HKDF info,
treat same-row as replay, let the server accept v2 for a min-1 recipient, make the pin fall back silently.

## 6. Done = report, then STOP

1. Contradictions found (section 1) with file:line.
2. Baseline numbers (Step 0), including the hang diagnosis result and whether the baseline is partial.
3. Changed files + reason, one line each. New files likewise. Confirm the MUST-NOT-TOUCH list is untouched
   (`git diff --stat` or a `diff -rq` against the base zip, pasted).
4. After-change suite counts in the baseline format; zero new failures against baseline.
5. Replay-store numbers and the honest limits (docs/DM_V2_WIRE.md).
6. Verified-by-me (what you executed, with output) vs Unverified-until-Linux (what you could not run).
7. Manifest rebuilt: why, `--check` output.
8. Zip `wire-final-21`: sha256, bytes, entries, and `unzip -l | grep` of every new file.
9. Do not start 1C. STOP.

---------------------------------------------------------------------------------------------

## Appendix - notes for 1C (do not act on them in 1B)

- Four `INSERT INTO users` sites (section 1.3). The 1C text allows editing only `auth.service.js`.
  Accounts created by `user.service.js:290` (admin create) and `database/seed.js:55` would stay at 1
  and never get v2 by default. Decide explicitly in 1C whether they are in or out.
- 1B's opt-in script already only raises, so it is compatible with the 1C ratchet trigger.
