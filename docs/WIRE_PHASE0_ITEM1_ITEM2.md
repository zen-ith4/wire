# Wire E2EE roadmap: Phase 0 notes for Item 1 and Item 2 (read-only)

**Status: STOP after Phase 0.** No production code was written. Items 3 to 6 were not started (they need `START ITEM N`). Item 1 needs your answers to 4.3.4 and 4.3.5 plus `GO`; Item 2 needs the answers in section 4.

## 0. Environment and evidence

| Field | Value |
|---|---|
| OS | Linux vm 6.18.44 x86_64 |
| Node | v22.22.2 |
| Browser build | none installed or run |
| Linux browser evidence | **none** (no browser test was run) |
| Tree | `wire-final-40.zip` extracted to a scratch copy; **no repo file was modified**. No `.git` in the zip, so `247ce8f` / `225f011` cannot be verified. |
| Tests run | **none** (Phase 0 is read-only; counts below are "not run") |
| One measurement | A scratch script outside the tree built real DM v2 envelopes with `encryptDmV2` to measure size (see 3.2). |

Every line number below was re-read from the tree unless marked "from the prompt".

## 1. Contradictions found (prompt / docs / tests vs code)

| # | Where | What |
|---|---|---|
| C1 | Prompt header, section 10 | `wire-final-40-REPORT.md` is named as the report format model, but it is **not in the zip**. I used the format described in section 10. |
| C2 | Prompt section 2, "peer-trust ... wired into `dm-v2-wire.js` and `session.js`" | Only partly true. Those two files call **only** `mayTryRetiredKey` (`session.js:293`, `dm-v2-wire.js:450`). `evaluatePeerKey` / `pinOnFirstUse` / `acceptPeerKey` are called **only** from `public/js/chat/dm-key-trust.js` (`:102`, `:204`). The DM pin is enforced in the **chat layer**, not in the crypto layer. |
| C3 | Prompt 4.1 / triage R1 | R1 is described for **peers**. The same code path also covers the **sender's own account** (self-KDM): see 2.8 item S. This is a stronger variant that the prompt does not mention. |
| C4 | Prompt 5.2 "client pre-checks before sending ... to add" | A client check **already exists** for v2 text: `DM_V2_MAX_CONTENT_CHARS = 2000` (`dm-v2-wire.js:74`), `assertDmV2ContentFits` (`:80`), used at `:513`. What is missing: a shared constant, a v1 pre-check, and the server 413. |
| C5 | Prompt 5.2 "about 1328 plaintext bytes" | Measured: **1331** bytes max for 1-digit user ids (1328 gives 1996 chars, 1331 gives 2000, 1332 gives 2004). The envelope also contains `senderId` and `recipientId` (`dm-v2.js:383-415`), so the true limit **depends on the digit count of the user ids**. It is not a constant. |
| C6 | Prompt 5.2 sites `:454`, `:547`, `:928` | Confirmed (`.slice(0, 2000)`). But `controllers/dm.controller.js:269` **already rejects** an over-2000 caption on the encrypted upload path (HTTP 400, message `Caption must be end-to-end encrypted`). So only the legacy plaintext path (`:547`, reachable only when `DM_E2EE_ATTACHMENTS_ENFORCED=false`) truncates a caption. |
| C7 | Prompt 5.3 "four INSERTs" | `services/user.service.js:91` is inside `createAdmin` (`:83`), which has **no caller** (only exported at `:904`). Three live paths plus one dead one. That INSERT also sets no `auth_scheme` / KDM columns. |
| C8 | Prompt 5.3 APK failure mode ("DMs to that account are refused") | I found **no server code that refuses v1 sent to a min-2 account**. `dmV2RuleViolation` (`dm.controller.js:85-103`) refuses only **v2 sent to a recipient with min < 2**. See 3.3. |
| C9 | Prompt 5.1 / triage R3 | `lockIdentity()` (`identity-service.js:851`) **does** clear the group wrap-key and Sender Key caches (`:861-862`), but via un-awaited dynamic imports. What it does **not** clear: the derived-key caches in `session.js` (`sessionKeys`, `kdmKeys`, `archivedSessionKeys`). `clearSessionKeys()` (`session.js:187`) has no caller in `public/js`. |
| C10 | Header of `public/js/crypto/messages/dm-v2.js` | Says "NEW AND UNWIRED - nothing imports this module yet". Stale: `dm-v2-wire.js` imports it. (Reported, not changed.) |

## 2. ITEM 1 (R1): pin the group KDM key

### 2.1 Where the group path obtains a peer identity key

There is exactly **one** funnel: `getOrCreateGroupKdmKey(userId)` (`session.js:398`) calls `createGroupKdmKey` (`:380`), which calls `getPeerPublicKey(id)` (`:387`, defined `peer-keys.js:88`, a plain `GET /api/me/identity-key/:id`). Result is cached forever in `kdmKeys` (`session.js:24`, set at `:394`).

**Send path** (wrap to member x device):
`ensureSenderKeyReady` (`group.js:556`) -> `loadMembers` (`group.js:523`, server member list) -> `ensureSenderKeyForGroup` (`group-message-crypto.js` about `:126`; early return `if mine.epoch === epoch`) -> `rotateSenderKey` (`rotation.js:37`, about `:142` at the caller) -> `distributeSenderKey` (`kdm.js:129`) -> `wrapSenderKeyForRecipient` (`kdm.js:80`, key at `:95`) -> `POST /api/groups/:id/kdms` (about `:145`). The sender includes itself (self-KDM).

**Receive path** (unwrap a sender's KDM):
`drainGroupKdms` (`group-message-crypto.js:188`) -> `receiveKdm` (`kdm.js:233`) -> `unwrapKdmDetailed` (`kdm.js:168`, key at `:184` for `context.fromUserId`) -> `storeReceivedSenderKey`. Failures stay **unacked** and are retried on the next drain (about `:206`).

### 2.2 How `peer-trust.js` decides (names I would call)

Store: IndexedDB `wire-peer-trust`, record key `origin::ownUserId::peerId` (`peer-trust.js:225`). Functions:
- `evaluatePeerKey` (`:288`): `first-contact` (no pin), `ok` (matches `current`), `reknown` (in `accepted`), `changed` (alarm; returns `pending`).
- `pinOnFirstUse` (`:335`): no-op if a pin exists; records server-reported retired keys as accepted.
- `acceptPeerKey` (`:376`): makes the key current, archives the old one, sets `verifiedAt`.
- `markPeerVerified` (`:400`), `clearPeerPin` (`:409`), `mayTryRetiredKey` (`:452`).

One pin per **peer user id** is correct for groups **today**, because all devices of an account share one X25519 key (`UNIQUE(user_id)`). Item 4 option B would invalidate this (pin per device).

### 2.3 DM wiring and UI reuse

- Gate: `resolveTrust` (`dm-key-trust.js:102`), `assertCanSendTo` (`:184`, throws `SendBlockedError`), `shouldHoldMessage` (`:146`), held rows in an in-memory map keyed by peer id (`:150-165`), `acceptNewKey` (`:204`), banner `renderKeyTrustBanner` (`:232`), release `bindKeyTrustRelease` (`:287`). Call sites in `dm.js`: `:386-388`, `:608`, `:1786-1787`, `:1807`.
- **Reusable as is:** `evaluatePeerKey` / `acceptNewKey` logic, the held-state per peer id (so one alarm is shared by the DM and group views), the CSS classes `dm-key-trust*`, `renderVerifyView` (safety number).
- **Needs a new surface:** the banner is single-peer with fixed element ids (`KEY_TRUST_IDS`) and its host exists only in the DM markup (`dm.js:1651`). Smallest group UI: one banner in the group thread listing the affected members ("Member X's key changed. X is not receiving this group's new messages until you verify or accept."), one button per member calling `acceptNewKey`, and a link to `renderVerifyView`. Built with `createElement` + `textContent` + delegated `data-action` (rule 9).
- **Layering problem:** `session.js` / `kdm.js` (crypto layer) must not import `public/js/chat/`. Recommend a new, additive module in `public/js/crypto/keys/` (working name `peer-key-gate.js`) that owns the context (origin + own id) and calls the pure `peer-trust.js` functions; `dm-key-trust.js` stays as the UI.

### 2.4 Send-side policy on mismatch (OWNER DECIDES)

Facts that shape the choice:
- The server accepts a **partial** recipient list: `submitKdmBatchChecked` (`groupKdm.service.js:45-83`) checks only that the sender is a member, the epoch matches, and each listed recipient is a current member. There is no completeness check, so (b) needs **no server change**.
- `ensureSenderKeyForGroup` returns early when `mine.epoch === epoch`, so a member excluded by (b) would **never be re-sent the key** after you accept. (b) therefore needs a "re-wrap to member X after accept" step (or a forced rotation). This is real design work, not a one-liner.

| Option | Effect | Cost |
|---|---|---|
| (a) refuse whole send | Safe, simple. A server that swaps one key **freezes the group for every sender**. Also blocks the removal-rotation (F5) path. | Low code, bad availability. |
| (b) deliver to all except the mismatched member, mark "not receiving" | Group keeps working. The removal rotation is never blocked. Each sender decides on its own pin, so recipient sets can differ per sender. Needs the re-wrap-after-accept path. | Medium. |
| (c) hold the send until resolved | Same freeze as (a) plus a retry/hold queue that interacts with the F5 retry logic. | Highest. |

**Recommendation: (b)**, with (i) a visible per-member "not receiving" state, (ii) re-wrap to that member on accept, (iii) the gate always runs **before** `wrapSenderKeyForRecipient` so no KDM is ever produced for a mismatched key, (iv) never blocks a rotation triggered by a removal.

### 2.5 Receive-side policy on mismatch (OWNER DECIDES)

KDM says `from = X`, but the pin says X's key differs. Options: reject (drop the row), hold, quarantine.

**Recommendation: hold = leave the row unacked** (the existing drain already keeps failures unacked), do **not** store a Sender Key, claim no nonce, decrypt nothing, show the 2.3 banner. After accept, the next drain consumes it. Messages under that Sender Key stay "waiting for key" because the key was never stored. Caveat: if X really rotated, KDMs wrapped before the rotation were wrapped to X's **old** key and the current group unwrap path does not try retired keys, so they fail forever (existing limitation, reported not changed).

### 2.6 First contact

Same rule as DMs: pin on first use, no alarm (`pinOnFirstUse`). Residual limitation, to be written plainly in the docs: the first key the server hands over is trusted; an active server at that moment wins; only an out-of-band safety-number comparison closes it. A member you have already pinned (and verified) in a DM is protected in groups for free because the pin is shared.

### 2.7 Rotation sequence (one alarm, one accept, clean re-wrap)

1. X rotates; server now serves K2 and lists K1 as retired.
2. My device (pin `current = K1`) evaluates K2 as `changed`: **one** alarm (shared slot per peer id, so DM and group show the same alarm).
3. I accept: `acceptPeerKey` sets `current = K2`, `accepted = [K1, K2]`.
4. Next wrap to X uses K2 (the cache must be keyed by key fingerprint, see 2.8 item K). X's post-rotation KDMs unwrap under K2.

### 2.8 Everything else in the group path that trusts a server-supplied value (report only, nothing fixed beyond R1)

- **S. Self-KDM (stronger than R1).** `recipientUserIds` must include the sender (`rotation.js:38-42`), so the sender wraps to **its own** id and `getPeerPublicKey(ownId)` fetches **my own public key from the server**. A server that substitutes my own key with one it holds can derive the same shared secret (it knows the substitute private key and my real public key) and read my Sender Key, i.e. all my group messages. Same on the unwrap side for self-KDMs. Fix is small (for `id === own id` use the local `identity.publicKey`) but it is **in addition** to R1. **Decision D3.**
- **K. Cache with no invalidation.** `kdmKeys` is filled once per page lifetime and never re-validated, so a pin check done only at cache fill is bypassed afterwards, and a legitimate rotation by a member is not noticed until reload. The gate must re-fetch and compare at each KDM distribution round (not each message), and cache by fingerprint.
- **T. Check-then-use race (this one is in the existing DM code, report only).** `assertCanSendTo` fetches the key (`dm-key-trust.js:81` and `:85`, two requests), then `buildDmV2Content` fetches it **again** (`dm-v2-wire.js:498`). A server can answer different keys to different requests, so the key that was checked is not necessarily the key that is used. The new group gate must derive from the **same bytes** it evaluated (one fetch, then evaluate, then derive).
- **M. Member list.** `loadMembers` (`group.js:523`) and `key_epoch` come from the server unauthenticated; the server can add a member and receive a wrap. Out of scope for R1.
- **Signing public keys** travel inside the KDM, authenticated by the pairwise key, so they are protected once the pairwise key is pinned.
- **Not checked:** group message `sender_id` handling beyond the tests' `expectedSenderId`, and anything under `public/js/crypto/groups/` other than `kdm.js` and `rotation.js`.

### 2.9 Existing tests that touch this path (by grep and name only; **assertions not read**)

Importing `session.js` / the KDM path: `group-crypto`, `group-hardening-wire`, `group-signing-adversarial` (C4-3 "swapped KDM rows"), `group-signing-ensure`, `group-signing-keys`, `group-attachment-*`. Named in the prompt but not opened: `group-kdm-recipient-scope`, `group-multidevice`, `group-hardening-f5-removal-race`, `group-keys-contract`, `group-audit`.

**Main compatibility risk:** `peer-trust.js` needs IndexedDB and an `{origin, ownUserId}` context. In plain Node tests neither exists, and today `session.js` skips the check when the context is null (`trustCtx`, `session.js:320-336`) and `mayTryRetiredKey` **fails open** when storage is missing (`peer-trust.js` about `:463`). That conflicts with rule 11 (fail closed). A fail-closed group gate will break every existing group test that uses the real `session.js` unless those harnesses supply a context and a store. **Decision D5.**

### 2.10 Item 1 plan after GO (unchanged from the prompt)

Commits: send-side gate, receive-side gate, UI, docs; each with tests; no wire change; pin namespace unchanged. Mutation plants as listed in prompt 4.5. Docs: `SECURITY_CLAIMS.md` ("Group key distribution is not pinned", lines 51-54), `E2EE_TRIAGE_3I.md` R1, `GROUP_E2EE_MULTIDEVICE_DESIGN.md` 6.7.

## 3. ITEM 2: R3, R2, R5 (order R3, R2, R5)

### 3.1 R3: logout must lock the identity

**Logout paths found (verified in code):** `logout()` (`auth.js:98`) called from the two 401 handlers in `api.js` (`:112` and `:221`, both guarded by `isHandlingUnauthorized`) and the sign-out button on the unlock screen (`auth.js:2850`). The Settings sign-out is described in a comment as `logout()` + reload (`auth.js:119-121`). **Not enumerated (open):** cross-tab logout, Electron, setup/lock flows.

**What `lockIdentity()` clears today:** `currentIdentity`; group local wrap key; group Sender Key cache (`identity-service.js:851-863`, via un-awaited `import().then`).
**Not cleared:** `session.js` `sessionKeys`, `kdmKeys`, `archivedSessionKeys` (and their pending maps); plaintext held in DOM/thread caches is only dropped by the `wire:logout` listeners (they exist in `dm.js:130`, `group.js:130`, `files.js:106`, `presence.js:33` and others, but I did not audit what each drops). Group signing key handling: not checked.

**Existing test:** `tests/groups/lock-identity-clears-group-keys.test.mjs` mocks the group modules and asserts that `lockIdentity()` calls the two clear functions. Adding calls inside `lockIdentity()` must not break that spy test; `session.js` imports `identity-service.js`, so a static import back would be circular (use the same dynamic-import pattern or call from `auth.js`).

**Recommendation:** `logout()` calls `lockIdentity()` and `clearSessionKeys()` synchronously (no un-awaited promise in the critical path), clears in-memory only, touches no persisted store (rule 10). Fail-closed check: every key-using entry point throws a "locked" error after logout. Cover 401-logout and button-logout separately.

### 3.2 R2: DM content truncated at 2000 characters

**Sites (verified):** `dm.controller.js:454` (send), `:547` (legacy attachment caption), `:928` (edit); `:269` already rejects over-length encrypted captions (C6).

**Overhead (measured):** text envelope with 1-digit ids: 1328 B -> 1996 chars, 1329-1331 B -> 2000, 1332 B -> 2004. `replyToId` is not in the JSON (AAD only). Because `senderId`/`recipientId` are in the JSON, the limit moves by a few bytes with id length. So the **user-facing plaintext limit should be derived from the real envelope length** (what `assertDmV2ContentFits` already does after encrypting), not from a fixed number. Message length in JS is UTF-16 units; the envelope is ASCII, so server and client count the same.

**Another effect of truncation:** a truncated v2 envelope no longer parses as JSON, so `dmV2RuleViolation` (`dm.controller.js:85`) returns `null` and the cut row is stored anyway, even for a min-2 recipient. A 413 **before** that rule closes this.

**Shared constant (existing mechanisms):** (1) `config/dm-stream.js` is a server CJS module; the browser cannot require it, so `tests/dm-attachments/dm-stream-constants.test.mjs` asserts browser and server values are equal and statically forbids hand-copied literals in the controller and `multer.js`. (2) `GET /api/dm/limits` exposes the runtime upload limit. Today the limit exists as **one client constant** (`dm-v2-wire.js:74`) and **four hand-typed `2000` literals on the server**, with no test linking them.

**Proposal:** add the constant to `config/dm-stream.js` (same mechanism, no second one), replace the four server literals, return 413 with a machine-readable code (for example `DM_CONTENT_TOO_LONG`) **before** `dmV2RuleViolation`, and add a **new** static test block asserting client equals server and no literal `2000` remains. Keep the `:269` branch unchanged and add a separate over-length 413 check before it, because `tests/dm-v2-attachments-server.test.mjs:185` pins that branch's 400 message for a different case (rule 4).

**Open items:** v1 messages still have no client pre-check (comment at `dm-v2-wire.js:62-72` says so); I did not check whether any caller relies on truncation (none found by grep of `tests/`, callers not audited); `express.json()` has the default body limit (`server.js:71`), so raising the limit instead is feasible (owner decides, not done).

### 3.3 R5: admin-created, seeded and first-admin accounts default to DM v2

**Sites:** `database/seed.js:55`, `utils/setupWizard.js:632`, `services/user.service.js:290` (live: admin controller creation), `services/user.service.js:91` (**dead**, C7). Registration already passes the constant (`auth.service.js:405`, `constants.DM_E2EE_DEFAULT_MIN_VERSION`, `config/constants.js:72`). A recursive grep found no other `INSERT INTO users` outside tests. Column `DEFAULT 1` (`migrations.js:41`) and the triggers (`:127-140`, only ever raise) stay untouched.

**Existing rows:** the triggers only raise, and nothing here would raise existing admin/seed rows. Whether to add an idempotent admin script is an owner decision (D11). Since you said there are no real users, I recommend **no script**, but I cannot confirm "no users" from the tree. **Please confirm (D14).**

**APK / old client, what the code actually says (C8):** `dm_e2ee_min_version` is read in only two places: `me.controller.js:1016-1022` (served to senders) and `dm.controller.js:96` (refuse v2 sent to a recipient with min < 2). Nothing refuses v1 to a min-2 recipient. So the likely effect of raising an account to 2 is on the **receiving** side: new clients send v2 to it (`message-crypto.js:148`, `:245` read the peer floor), and a v1-only client cannot decrypt v2. **This is a hypothesis from reading code, not tested.** The phase-1 test must pin the real behaviour before any operator note is written.

**Tests that create accounts through these paths (not yet read):** `tests/credentials/f12-admin-create.test.mjs`, `f12-admin-legacy-tools`, `f12-usernames`, `f12-browser-login`, `tests/dm-e2ee-default.test.mjs`. Assumptions to be checked in the continuation of Phase 0.

## 4. Decisions needed from the owner

| # | Question | My recommendation |
|---|---|---|
| D1 | Send-side policy on mismatch (2.4) | (b): skip the mismatched member, show "not receiving", re-wrap on accept |
| D2 | Receive-side policy (2.5) | Hold (leave unacked), no key stored, banner |
| D3 | Include the self-KDM fix (use local `identity.publicKey` for own id) in R1? (2.8 S) | Yes, same function, same threat |
| D4 | New additive module `crypto/keys/peer-key-gate.js` for context + gate, UI stays in `chat/` | Yes |
| D5 | Missing IndexedDB / no context: fail closed in the group gate (rule 11), and give existing group test harnesses a context and store? Report the DM `mayTryRetiredKey` fail-open as "Found, not changed" | Fail closed; harness change needed |
| D6 | UI: one multi-member banner in the group thread (2.3) | Yes |
| D7 | DM check-then-use race (2.8 T): report only, or fix in the same item? | Report only for now |
| D8 | R3: sync lock + `clearSessionKeys()` from `logout()` (3.1) | Yes |
| D9 | R2: constant in `config/dm-stream.js`, 413 before the v2 rule, plaintext limit derived from real envelope length (3.2) | Yes |
| D10 | R2: keep `:269` as is and add a separate 413 before it | Yes |
| D11 | R5: script to raise existing admin/seed rows? | No (no real users), but confirm D14 |
| D12 | R5: patch the dead `createAdmin` INSERT too, or leave it / delete it? | Patch it for consistency, test by direct call |
| D13 | R5: accept that the APK effect is a hypothesis until a test shows it | Yes |
| D14 | Confirm: there are no real users, so no migration is needed | Please confirm |

## 5. Verified / Unverified / Not run

- **Verified (read in code):** all line numbers above except those marked "about"; the funnel in 2.1; the server accepting partial KDM recipient lists; the three live R5 INSERTs and the dead one; the 413 candidate sites; the envelope size numbers (measured, scratch script).
- **Unverified:** the test-suite counts from the prompt (713/725 etc.); assertions of the group tests in 2.9; `docs/E2EE_TRIAGE_3I.md` section 2; `services/dm.service.js:270-277`; the Settings sign-out, cross-tab and Electron logout paths; group signing-key handling on lock; what each `wire:logout` listener clears; APK behaviour.
- **Not run:** full non-browser suite, any single test file, any browser test, differential runs (`DM_E2EE_DEFAULT_MIN_VERSION=1`, `GROUPS_ENABLED=false`), `npm audit`.
- **Linux evidence:** none yet.

**STOP.** Waiting for D1 to D14 and the word `GO` for Item 1 (and for each Item 2 commit). Items 3 to 6 are not started.
