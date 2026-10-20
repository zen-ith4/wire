# E2EE triage (STEP 3F follow-up 3.I): ranked risks and open items

**Read-and-report only.** Nothing in the risk list below was changed in code;
each entry waits for the owner to pick it. Every entry cites the line it was
read from (tree after `wire-final-39`). Ranking = impact x likelihood under the
project's threat model (the server is an active adversary; metadata, a
compromised endpoint and a hostile browser are out of scope).

## 1. Ranked risks

| # | Risk | Impact | Likelihood | Evidence | Proposed fix | Effort |
|---|---|---|---|---|---|---|
| R1 | **Group key distribution ignores the peer-trust pin.** The KDM wrap key is derived from the server-supplied identity key with no TOFU/pin check, so a malicious server that substitutes a member's identity key receives every Sender Key wrapped "to" that member and reads the group - with NO key-change alarm, even when the users verified each other in DMs. **Status: fixed in Item 1 (`security-hardening`).** | High (confidentiality of a whole group) | High for an active server (no user action needed) | Before: `public/js/crypto/keys/session.js:387` (`getPeerPublicKey(id)` then derive); DM path checks trust: `public/js/chat/dm-key-trust.js`, `public/js/crypto/keys/peer-trust.js`. Now: `public/js/crypto/keys/peer-key-gate.js` (called from `session.js`) evaluates the same pin on every KDM round; `groups/kdm.js` skips only a changed recipient; `chat/group-key-trust.js` shows "not receiving"; accept forces a re-wrap. Tests: `tests/groups/group-kdm-key-pinning.test.mjs`, `group-signing-ensure.test.mjs` E-1b. | Implemented by consulting the same pin in `createGroupKdmKey`: a key the device has not accepted for that peer is neither wrapped nor unwrapped, the DM-style alarm is raised, and a group accept forces one re-wrap. Still TOFU at first contact. | Done |
| R2 | **Server truncates DM `content` at 2000 characters** - a long v1/v2 message (or an edit) is stored as a cut envelope that can never decrypt ("Unable to decrypt"), silently. | Medium (silent data loss, integrity) | Medium (any long message) | `controllers/dm.controller.js:454` (send), `:547` (legacy attachment caption), `:928` (edit): `.slice(0, 2000)`; client cap `public/js/crypto/messages/dm-v2-wire.js:74` | Reject oversize with 413 and a clear error, never truncate; one shared constant for client and server; boundary tests (3.F.2). | S-M |
| R3 | **Logout does not lock the identity.** `lockIdentity()` has no caller; `logout()` clears the persisted unlock key but leaves the in-memory identity private key and the group wrap-key / Sender Key caches alive until the page reloads (a 401-triggered logout does not reload). | Medium (shared/kiosk computer) | Low-Medium | `public/js/crypto/identity-service.js:851` (no caller in `public/js`); `public/js/core/auth.js:98-128` | Call `lockIdentity()` from `logout()`; node test that `isIdentityUnlocked()` is false after `logout()`. One line + test. | S |
| R4 | **Own-key rotation loses own history.** v2 rows the user SENT are sealed to the old own key; rotation archives only the old PUBLIC key, so the user's own older v2 rows become unreadable (no escrow). | Medium (data loss) | Low (rotation is rare, manual) | `services/identityKeyHistory.service.js:5-9` (public keys only); `docs/e2ee-dm-hardening.md` 3.5 | Archive own retired PRIVATE keys wrapped under the account wrap key, tried via the existing `mayTryRetiredKey` rule (3.F.1). Needs a design note. | M |
| R5 | **Admin-created / seeded / first-admin accounts stay at `dm_e2ee_min_version = 1`**, so their DMs may be v1 (no AAD: reflectable, relabelable). | Medium | Medium (every admin-made account) | `database/seed.js:55`, `utils/setupWizard.js:632`, `services/user.service.js:91`, `:290` (no `dm_e2ee_min_version` in the INSERTs; column `DEFAULT 1`, `database/migrations.js:41`) | Default 2 at those four sites (3.F.3); test per site. | S |
| R6 | **Push notifications send metadata to Google FCM**: sender username, sender id, message id and the attachment class (photo/video/file/voice). No content. | Medium (metadata to a third party) | Certain when FCM is configured | `services/push.service.js:179-193`, `:102-116` | Data-only push carrying only an opaque id; the device fetches and renders locally. | M |
| R7 | **A stolen browser profile of a "remember me" session reads all history**: the auth token is in localStorage, the unlock key in IndexedDB `wire-e2ee-store`; together they unwrap the identity key the server stores. | High | Low (needs the profile) - endpoint compromise is out of scope by design, but the opt-in should say so | `public/js/core/auth.js:66`, `:492`; `public/js/crypto/keys/unlock-key-store.js:19`; `database/tables/identity_keys.tabels.js:5-10` | UI text on "remember me": "anyone with this browser profile can read your messages". No code change to crypto. | S |
| R8 | **Legacy plaintext DM attachment path** still exists; reached only when the client sends no `attachment_meta` AND the operator set `DM_E2EE_ATTACHMENTS_ENFORCED=false`. | Low (current clients always encrypt) | Low | `controllers/dm.controller.js:175-179`, `:497-505` | Delete the path (and the env switch) once no pre-2A client remains. | S |
| R9 | **Group: a removed member's own old key is still accepted** (attributed to her, never to others). | Low-Medium | Low | `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` 6.7 item 2; tests C4-5, C4-7 | Epoch cut-off on receive (design 7.2). | M |
| R10 | **Replay windows are per device and FIFO** (DM: 2000 ivs x 50 conversations; group: soft cap ~90,000 per key). An attacker can push an entry out and replay once. | Low | Low | `public/js/crypto/messages/dm-v2-wire.js:55`, `:61`; group design 5 / 6.7 item 1 | Per-conversation high-water mark (design 5). | M |
| R11 | `msgId` is carried in the v2 envelope but unauthenticated (unused for replay). | Low | - | `docs/e2ee-dm-hardening.md` 3.5 | Drop it in a versioned way or bind it (wire change: owner GO). Until then the docs say so (3.F.4). | - |
| R12 | Dead DM functions with no AAD (`encryptAttachmentForDm` / `decryptAttachmentForDm`). | Low (no caller; a static test keeps it so) | - | `public/js/crypto/messages/attachment-crypto.js`; static guard in `tests/dm-v2-attachments.test.mjs` | Delete them (group functions in the same file stay) (3.F.6). | S |

**What the server stores about attachments (for the record):** encrypted DM
attachments: opaque name, `application/octet-stream`, `is_voice_message = 0`,
the CIPHERTEXT size, timestamps, sender/recipient, reply id
(`services/dm.service.js:270-277`). Sizes and timing are visible by design.

## 2. Stale or false statements found (and what was done)

| where | statement | status |
|---|---|---|
| `docs/PORT_NOTES.md:6-22` | "DM attachment encryption is NOT part of this port"; "group client not wired" | **Corrected** (note with evidence, commit `844e4a8`) |
| `docs/e2ee-dm-hardening.md:3-5` | "design only. Nothing in this document has been implemented" | **Corrected** |
| `docs/e2ee-dm-hardening.md:224-225` | "DM attachments are still v1 with no AAD" | **Corrected** |
| `docs/e2ee-dm-hardening.md` 7 (table) | replay "msgId is per-device"; Phase 2 "signed prekeys" | **Corrected** (iv-keyed; no signed pre-keys) |
| `docs/e2ee-dm-hardening.md` 8 / 9(b) | X3DH / Double Ratchet attributed to "Pohlig-Hellman et al."; "(Sign, 1)", "(PuTTY, 2021)" | **Corrected** (Marlinspike & Perrin 2016; Cohn-Gordon et al. 2017) |
| `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` 6.7 items 3 and 5 | "no pinning anywhere"; attachment slot "reserved, empty", bytes "only AEAD-protected" | **Corrected** (pin exists for DMs only; bytes bound since 3B) |
| the 3F follow-up task, 3.F.2 | server cut at `dm.controller.js ~324/~794` | the cuts are at `:454`, `:547`, `:928` |
| `tests/dm-v2-attachments-browser.test.mjs` header | "no fixed sleeps" (it had 43) | **Corrected** in 3.B |
| `tests/dm-v2-attachments-browser.test.mjs` test `d` | title "downgrade notice once per load", but nothing about a notice is asserted and its second open asserts nothing | **Reported, not changed** (rule 8) |
| `tests/dm-v2-attachments-browser.test.mjs` `tamperScenario` (e1-e3) | tampers the NEWEST row (`good-last`), not the file named `to-tamper` | **Reported, not changed**; assertions still meaningful |
| `tests/groups/group-attachment-browser.test.mjs` test 4 | called `window.replyToGroupMessage`, which does not exist: no quote was ever made | **Fixed** in 3.B (`window.threadReply`, asserts on `.reply-quote`) |

Not read in depth this round: `docs/CSP_TODO.md`, `docs/PHASE_B_PLAN.md`,
`docs/test-baseline.md` (its numbers predate 3C-3F; the current counts are in the
follow-up report).

## 3. 3.C items that need the owner

- **(b) `EADDRINUSE` in `tests/groups/group-hardening-f6-server-pruner.test.mjs`.**
  Cause: `:71` picks `39000 + random(900)` with no bind check and no retry, so
  concurrent files (or any local service) collide. The harness's
  `pickFreePort()` (`tests/_acceptance-harness.mjs:60`) probes but has a
  check-then-use gap (the probe closes, the child binds later). Proposal:
  (1) f6 uses `pickFreePort()` (test file only); (2) harness: start the server
  with `PORT=0` and read the bound port from the child's stdout - no gap at all
  (needs `server.js` to log the actual port; harness change = owner OK).
- **(c) "runner hung on `tests/browser-launcher.test.mjs`"** - NOT reproduced:
  alone, 5 runs, `--test-timeout=60000`: 5/5 pass, 225-248 ms each (Windows,
  Node 22.23.2). The file tests pure functions only. The runner prints the last
  file it started, so the hang was most likely another file of the same run.
- **(d) `tests/dm-blob-url-cleanup.test.mjs` mocks `message-crypto.js` by hand**
  (7 names) and already misses the 8th export (`DmDowngradeRefusedError`,
  `message-crypto.js:293`). Proposal: generate the stub set from the module's
  own export list and override only what the test needs:

  ```js
  const src = fs.readFileSync(path.join(ROOT, 'public/js/crypto/messages/message-crypto.js'), 'utf8');
  const names = [...src.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1])
      .concat([...src.matchAll(/^export \{([^}]+)\}/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())));
  const unmocked = Object.fromEntries(names.map((n) => [n, () => { throw new Error(`unmocked ${n}`); }]));
  mock.module(jsPath('crypto/messages/message-crypto.js'), { namedExports: { ...unmocked, ...overrides } });
  ```

  A new export can no longer break the link step, and calling an export the
  test did not expect fails loudly. (Importing the real module and re-exporting
  it was rejected: it pulls IndexedDB/crypto side effects into the node test.)

## 4. 3.D - text reply to an attachment message

Not reproduced as a product bug. With the reply call retried until the reply
preview is active (3.B), c2 and c2b store `reply_to_id` = the attachment id and
render the quote: c2 and c2b 3/3 each, and the whole DM attachment file 18/18
(Windows, `chrome-headless-shell` 155 - NOT the Linux evidence the checklist
asks for). The earlier c2 symptom matches the 3.B race (`replyToDmMessage`
returns silently while the parent is not in `dmEntry.byId`, `dm.js:2922`). A
second, separate race was found in c2/c2b and fixed in the test: the
"no console errors" window opened while bob's page load was still fetching
`/api/me/avatar/2` (404, alice has no avatar).
