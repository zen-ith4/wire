# What Wire's end-to-end encryption claims - and what it does not

Every sentence here is meant to be checkable: it cites a file:line or a test by
name. Tree: after `wire-final-39` (STEP 3F follow-up). If code and this page
disagree, the code is right and this page is a bug.

## 1. Threat model in one paragraph

The server is a blind relay that is assumed to be an **active adversary**
against message confidentiality and integrity: it stores ciphertext, public
keys and a bcrypt hash of the auth key, and it can rewrite, replay, reorder,
drop and relabel anything it stores or relays. **Out of scope by design:**
metadata privacy, a compromised endpoint (device, browser profile, OS), a
hostile browser, and - fundamentally - **a server that serves modified client
JavaScript** (`docs/e2ee-dm-hardening.md` 7.1): the web client is code the
server delivers, so nothing below holds against a server that changes it.

## 2. What is protected, per feature

| feature | protected against the server | how | tests |
|---|---|---|---|
| **DM text, v2** (peer at `dm_e2ee_min_version` >= 2) | confidentiality; reflection (a2b vs b2a); relabelling sender/recipient; re-pointing a reply; replay of a stored row under a new id (per device, windowed) | X25519 + HKDF-SHA-256 per direction (`public/js/crypto/messages/dm-v2.js:52-54`, `:231`), AES-256-GCM with AAD `dm-msg-v2` binding version, from, to, senderKeyFp, direction, iv, replyToId (`dm-v2.js:324`); replay store keyed on the iv (`dm-v2-wire.js:55`, `:61`) | `tests/dm-v2.test.mjs` "KAT: a2b AAD, key and ciphertext ...", "direction: a2b and b2a keys differ ...", "bound field: replyToId is bound ...", "rejected: a replayed IV is refused ..." |
| **DM text, v1** (peer at 1) | confidentiality only | one direction-blind key, **no AAD** (`docs/e2ee-dm-hardening.md` 1) | - |
| **DM attachments** | file bytes: confidentiality (STREAM format); meta (name, mime, per-file key) and caption: v2 envelope with AAD label `dm-att-v2` for a peer at >= 2 | `public/js/crypto/messages/attachment-stream.js`; `dm-v2.js:715`; the server stores an opaque name, `application/octet-stream`, voice flag 0 and the ciphertext size (`services/dm.service.js:270-277`) | `tests/dm-v2-attachments-browser.test.mjs` a, e1-e7, e4b, f1, f1b, f2, f2b; `tests/acceptance-no-plaintext.test.mjs` |
| **DM key continuity** | a key substituted AFTER first contact is detected and HELD (no silent decrypt under the new key); safety number to compare out of band | TOFU pin + archive per device (`public/js/crypto/keys/peer-trust.js:30`); key-change alarm (`public/js/chat/dm-key-trust.js`) | `tests/peer-trust.test.mjs`, `tests/peer-trust-browser.test.mjs` |
| **Group messages** | confidentiality (Sender Keys); per-message sender authentication (signature over group, senderKeyId, counter, iv, ciphertext, replyToId, attachment slot); KDM AAD binds group/from/to/epoch/version | `public/js/crypto/groups/signing.js:93-104`; `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` 6 | `tests/groups/group-signing-adversarial.test.mjs` C4-1, C4-3, C4-4, C4-8 |
| **Group KDM key continuity** | a group member's identity key substituted after first contact is detected: the KDM is neither produced nor unwrapped under the new key, and the member is shown as "not receiving" until accepted | the group path consults the SAME TOFU pin as DMs (`public/js/crypto/keys/peer-key-gate.js` called from `keys/session.js`); self-KDMs use the local identity key, never a server fetch; distributions skip only a changed member and are re-wrapped after accept | `tests/groups/group-kdm-key-pinning.test.mjs`, `tests/groups/group-signing-ensure.test.mjs` E-1b |
| **Group attachments** | file bytes bound into the signature (iv, ciphertext hash, plaintext length); lazy download bounded by the SIGNED size; 20 MB auto-load budget per view; 2 concurrent downloads | `docs/GROUP_ATTACHMENTS_E2EE.md`; `public/js/chat/group-attachments.js:609`, `:669`, `:758` | `tests/groups/group-attachment-browser.test.mjs` 1-11 |

**Feature state:** group attachment SENDING is off
(`GROUP_ATTACHMENTS_UI_ENABLED = false`,
`public/js/chat/group-attachments-flag.js:17`); receiving is on. Self-registered
accounts start at DM v2 unless the operator sets `DM_E2EE_DEFAULT_MIN_VERSION=1`
(`config/constants.js:7-18`, used at `services/auth.service.js:405`); admin-created, seeded and first-admin accounts start at
v1 (`database/migrations.js:41` `DEFAULT 1`; the four INSERTs at
`database/seed.js:55`, `utils/setupWizard.js:632`, `services/user.service.js:91`,
`:290` do not set it) - see `docs/E2EE_TRIAGE_3I.md` R5.

## 3. What is NOT protected

- **Metadata.** Who talks to whom and when, message and file sizes, reply
  structure, group membership, timestamps, IP addresses - all visible to the
  server (`docs/e2ee-dm-hardening.md` 7.1). Push notifications additionally send
  the sender's username, the message id and the attachment class to Google FCM
  when push is configured (`services/push.service.js:179-193`).
- **Forward secrecy and post-compromise security.** DMs are static-static; one
  compromised identity private key reads every DM of that account, past and
  future, until rotation (`docs/PHASE3_RFC.md`). Group Sender Keys give no PCS
  and no per-message FS (`docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` 6).
- **First contact (TOFU).** The first key a client learns comes from the
  server; only an out-of-band safety-number comparison closes that.
- **Key change before the user acts on the alarm.** A changed group member's
  KDM is skipped/held and the member is shown as "not receiving", but a server
  can still withhold the alarm itself, and first contact remains TOFU.
- **Deletion, omission, reordering, availability.** The server can drop or
  withhold any message; there is no gap detection.
- **Replay beyond the window.** Per device and FIFO: DM 2000 ivs per
  conversation x 50 conversations (`dm-v2-wire.js:55`, `:61`); group soft cap
  about 90,000 per Sender Key (`tests/groups/group-signing-adversarial.test.mjs`
  C4-2, "KNOWN, ACCEPTED LIMITATION"). Same-row rollback is not covered.
- **The account password.** The identity private key is stored on the server
  wrapped under a password-derived key (`database/tables/identity_keys.tabels.js:5-10`):
  password + that row = the identity.
- **A stolen browser profile with "remember me".** The auth token is in
  localStorage (`public/js/core/auth.js:66`) and the unlock key in IndexedDB
  (`public/js/crypto/keys/unlock-key-store.js:19`, written only when
  `rememberMe === true`, `auth.js:492`).
- **Deniability, traffic analysis, an attacker holding the database file** (the
  `dm_e2ee_min_version` ratchet triggers in `database/migrations.js:127` stop
  the app from lowering the floor, not someone editing the file).
- **Long DMs.** The server cuts `content` at 2000 characters
  (`controllers/dm.controller.js:454`, `:928`), which corrupts a long envelope
  instead of refusing it (`docs/E2EE_TRIAGE_3I.md` R2).

## 4. Verification status

| what | ran on Linux with `@sparticuz/chromium` | ran only on Windows | never |
|---|---|---|---|
| Group attachment browser tests 1-10 | reviewer, wire-final-39: 1,2,4,5,6,7,8,9,10 pass, 3 flaky (fixed in 3.A, not yet re-run on Linux) | 1-11 green, `chrome-headless-shell` 155 (STEP 3F follow-up) | - |
| Group attachment browser test 11 (repaint) | - | green; RED with the pre-fix `group.js` | - |
| DM attachment browser file (18 tests) | reviewer: `c1` flaky (fixed in 3.B, not yet re-run on Linux) | 18/18 green, `chrome-headless-shell` 155 | - |
| Non-browser suite | not re-run on wire-final-39 by the reviewer | see the follow-up report for counts | - |
| Firefox, Safari, Android WebView, iOS | - | - | **never** |
| Electron client end to end | - | - | **never** (it loads the server, `electron-client/main.js:380`) |
| The APK (`app-debug.apk`) | - | - | **never** (it bundles an old `public/`) |
