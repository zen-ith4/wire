# What Wire's end-to-end encryption claims - and what it does not

Every sentence here is meant to be checkable: it cites a file:line or a test by
name. Tree: `wire-final-39` plus Item 3 (progressive DM media, commits C2a to
C5d, flag OFF) and the P0 series (commits P0-1 to P0-5), branch
`security-hardening` at `9918b14`. If code and this page disagree, the code is
right and this page is a bug. Sections 2 and 3 are unchanged except for the rows
and bullets marked **(Item 3)** and **(P0)**; the old Windows-only rows in
section 4 are kept, and the new Linux results are added next to them.

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
| **Progressive DM audio/video (Item 3, flag OFF)** | the same properties as DM attachments (file bytes stay ciphertext on the server and on the wire); additionally: no key or plaintext in Cache Storage, IndexedDB, localStorage or sessionStorage after playback and after logout; a tampered ciphertext chunk is rejected by AES-GCM and the stream is dead; a stream dies on logout and cannot be read by another client | Service Worker route `/__wire_media_stream/<id>` (`public/sw.js:102` flag, `public/js/sw-media/stream-registry.js`, `media-ciphertext.js`); key and base IV live in worker memory only; per-client binding by `event.clientId`; `PURGE_CLIENT` on logout and on a real `pagehide` (`public/js/core/auth.js:122`, `public/js/media/lazy-e2ee-media.js:70`); only encrypted DM audio/video strictly larger than 8 MiB (`public/js/media/sw-stream-client.js:20`) | `tests/media/sw-stream-browser.test.mjs` tests 2, 5, 6, 8, 11 (flag-ON copy via `tests/helpers/sw-flag-on-copy.mjs`); the mutation checks in section 4; `tests/sw-flag-guard.test.mjs` fails if the flag is committed ON |
| **Sessions after a password change (P0)** | an old session token stops working when the password changes (HTTP 401; socket handshake refused) | `users.token_version` bumped on every password change; the token carries `tv`; checked in `middleware/authenticate.js:62` and `:127`, `middleware/mediaAuth.js:62` and `:207`, `config/socket.js:72`; tokens minted before the column existed count as version 0 (`utils/jwt.js:18`) | `tests/token-version.test.mjs`; live check in section 4 |
| **Example secrets (P0)** | a deployment still using a secret that is public (the values that shipped in `.env.example`) | the server exits at start when `JWT_SECRET` or `EMAIL_VERIFICATION_SECRET` is an example value or shorter than 32 characters; `EMAIL_VERIFICATION_SECRET` is mandatory in production (`config/constants.js:28`, `:33`, `:81`) | `tests/secrets-config.test.mjs`; live check in section 4 |
| **Client address and `ALLOWED_SUBNET` (P0)** | a client-supplied `X-Forwarded-For` choosing its own address; the Socket.IO handshake bypassing the subnet rule | `X-Forwarded-For` is trusted only when Express binds to `127.0.0.1` (`middleware/ipRestrict.js:95`, `server.js:56`); the same rule is applied to the socket handshake (`config/socket.js:41`, `middleware/ipRestrict.js:63`); generated Caddyfiles overwrite the header (`utils/tlsSetup.js:127`, `:142`) | `tests/ip-trust-proxy.test.mjs`, `tests/socket-subnet.test.mjs` |

**Feature state:** group attachment SENDING is off
(`GROUP_ATTACHMENTS_UI_ENABLED = false`,
`public/js/chat/group-attachments-flag.js:17`); receiving is on. Self-registered, admin-created, seeded and first-admin accounts all start at the
shared default `DM_E2EE_DEFAULT_MIN_VERSION` (default 2; env may set 1)
(`config/constants.js:7-18`, used at `services/auth.service.js:405`,
`database/seed.js:55`, `utils/setupWizard.js:632`,
`services/user.service.js:91`, `:290`); the column `DEFAULT 1`
(`database/migrations.js:41`) and the triggers (`database/migrations.js:127-140`)
are unchanged, and existing rows are not migrated (triggers only raise; no
backfill) - see `docs/E2EE_TRIAGE_3I.md` R5. First contact remains TOFU
regardless of the floor, and the APK shipping an old `public/` is only a
hypothesis (D13).

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
- **(Item 3) Progressive media is OFF.** `MEDIA_STREAM_ENABLED = false` in
  `public/sw.js:102`; nothing above about streaming applies to a deployment until
  the owner flips it, and flipping it also requires rebuilding
  `public/sw-manifest.js`. While a stream is playing, the key sits in Service
  Worker memory and decrypted audio/video is handed to the browser's media
  pipeline: a compromised endpoint reads it, as with any playback.
- **(Item 3) A 5 s token wait ends a stream for good** (`public/sw.js:103`); the
  page falls back once to the Blob path. A negative probe (worker did not answer
  within 1000 ms, `sw-stream-client.js:27`) is cached until `controllerchange`.
  Both are documented behaviour, not fixed. A concurrent-401 token race and a
  proactive token refresh on `visibilitychange` (RFC 9.7 item 5) are not
  implemented.
- **(P0) Already-connected sockets.** A password change refuses new handshakes
  and HTTP requests with the old token (`config/socket.js:72` runs at connect
  time); a socket that is already connected is not disconnected.
- **(P0) Secrets already in git history.** `.env` was committed in the past and
  the repository is public: refusing the example values stops a deployment from
  using them, it does not make them secret again. Rotating `JWT_SECRET` and
  `EMAIL_VERIFICATION_SECRET`, and restricting the Firebase key that ships in
  `app-debug.apk`, is operational work this repository cannot do. An existing
  Caddyfile is not rewritten; add `header_up X-Forwarded-For {remote_host}` by
  hand.
- **Deniability, traffic analysis, an attacker holding the database file** (the
  `dm_e2ee_min_version` ratchet triggers in `database/migrations.js:127` stop
  the app from lowering the floor, not someone editing the file).

## 4. Verification status

| what | ran on Linux with `@sparticuz/chromium` | ran only on Windows | never |
|---|---|---|---|
| Group attachment browser tests 1-10 | reviewer, wire-final-39: 1,2,4,5,6,7,8,9,10 pass, 3 flaky (fixed in 3.A, not yet re-run on Linux) | 1-11 green, `chrome-headless-shell` 155 (STEP 3F follow-up) | - |
| Group attachment browser test 11 (repaint) | - | green; RED with the pre-fix `group.js` | - |
| DM attachment browser file (18 tests) | reviewer: `c1` flaky (fixed in 3.B, not yet re-run on Linux) | 18/18 green, `chrome-headless-shell` 155 | - |
| Non-browser suite | not re-run on wire-final-39 by the reviewer | see the follow-up report for counts | - |
| **Item 3 and P0 (this tree, `9918b14`)** | owner's WSL2, Node 22.23.2, `@sparticuz/chromium` 153 (`HeadlessChrome/153.0.8010.0`): non-browser suite 996 tests, 980 pass, 0 fail, 3 skipped, 13 todo; browser suite in two halves, the only failures are the two known pre-existing tests `e3` and `e4` in `tests/dm-v2-wire-browser-paths.test.mjs`; `tests/media/sw-stream-browser.test.mjs` 11/11 in five solo runs; group attachment browser file 11/11 in ten runs (five on this tree, five on the tree before the C5d test files); `sw-manifest.js` version `a771fa2fb50e` and `sw-media-bundle.js` current; live server: example secret refused, old token 401 and new token 200 after a password change | - | - |
| Item 3 mutation checks (flag-ON temp copy, never the repository) | cloud container, Chromium 153, `cloud-logs/` of the C5d deliverable: skipping the GCM tag check is caught by test 5, logout without purge by test 6, Content-Range from ciphertext size by tests 3, 4 and 7, decrypted chunks cached by test 8, a registry that ignores the client binding by test 6 | - | not re-run on the owner's WSL |
| Firefox, Safari, Android WebView, iOS | - | - | **never** |
| Electron client end to end | - | - | **never** (it loads the server, `electron-client/main.js:380`) |
| The APK (`app-debug.apk`) | - | - | **never** (it bundles an old `public/`) |
| Progressive media with the flag ON in a real deployment | - | - | **never** (only the flag-ON temp copy in tests; no Safari, no Firefox, no Android WebView) |
| Server restart under a live stream, many concurrent streams, long media (> 12 MiB) | - | - | **never** (test files are about 10 MiB; the 16-chunk (1 MiB) cap is not exercised by the browser tests) |
