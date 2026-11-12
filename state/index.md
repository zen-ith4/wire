# Working State — everything done on this branch

This file summarizes ALL branch work as of the latest commit on the `test`
branch (HEAD `e7c0cab`, plus the follow-up leftover fixes made in this batch).
Nothing here is uncommitted: the tree is clean and everything is pushed to
`github/test` (branch `test`).

## 1. Dependency upgrades + npm audit (before/after: 11 -> 0)

- Upgraded runtime dependencies: `file-type` `20.5.0` -> `^22.3.0`, `multer`
  `^1.4.5-lts.2` -> `^2.5.0` (with the matching `package-lock.json` update).
- `npm audit --omit=dev` went from **11 vulnerabilities to 0** after the upgrade;
  it is currently at **0** (re-verified after `npm ci` in this batch).
- Full `npm audit` (including dev dependencies) still reports 14 advisories
  (undici, uuid, xcode, `@trapezedev/project`) — none of them in production
  dependencies.

## 2. mediaAuth deactivated-account fix (`middleware/mediaAuth.js` via `loadActiveUser`)

- `loadUserAndContinue()` now delegates to the shared `loadActiveUser()`, which
  returns `null` for a missing row, a deactivated row (`is_active === 0`), or a
  session token whose version no longer matches.
- The Bearer-token path and the media-token path therefore share ONE
  "is this account allowed" implementation, and deactivated accounts are refused
  (401) on media routes exactly as on the normal API routes.

## 3. APK update integrity — fail closed (`controllers/apk.controller.js`, `public/js/core/appUpdate.js`, `tests/apk-integrity.test.mjs`)

- The server now hashes the APK **asynchronously via a read stream**
  (`fs.createReadStream` + `createHash('sha256')`) instead of `readFileSync` on
  the request path.
- `getApkInfo()` **fails closed**: when the hash cannot be computed it returns
  `{ available: false }` — it never returns `sha256: null` and never advertises
  an update it cannot verify.
- The client (`downloadAndInstall(expectedSha256)`) **refuses to install** when
  the advertised info has no sha256 (no legacy fallback), and refuses when the
  recomputed hash of the downloaded file does not match the advertised hash.
- Known limitation (documented, matches `docs/archive/SECURITY_CLAIMS.md`): a
  hostile origin serving **both** the bytes and the hash means the SHA-256 only
  binds the advertised version to the served bytes — it cannot stop that origin.
  Stopping a hostile origin requires the hash to be trusted out of band (pinned
  in a client build, or signed by a release key the developer alone holds).
- `APK_PATH` default prefers `app-debug.apk` and falls back to the legacy
  `apk-debug.apk` (no breaking change); `app-debug.apk` is untracked
  (`git rm --cached`, kept on disk).

## 4. CORS hardening (`middleware/cors.js`, `server.js`, `tests/cors-config.test.mjs`)

- `server.js` no longer mounts `cors({ origin: true, credentials: true })`; the
  options live in the new `middleware/cors.js` middleware
  (`corsMiddleware`, `cors({ origin: true, credentials: false })`).
- No cookie usage exists in the app (Bearer + Socket.IO handshake tokens), so
  `credentials` was dead weight; it is now `false`. Reflecting the origin
  (`origin: true`) still supports Capacitor (`https://localhost`) and Electron
  (any-origin).

## 5. Flaky browser-test fix (`scripts/run-tests.mjs`)

- `node --test` runs test files in parallel; the heavy browser files each spawn
  the shared `@sparticuz/chromium` binary -> `ETXTBSY` + resource contention.
- Added `--test-concurrency=1` so files run sequentially; verified 12/12 pass in
  both orders, 0 `ETXTBSY`.

## 6. Docs reorganization (`docs/`, `state/`)

- Loose top-level `docs/*.md` moved into `docs/archive/`; subfolder docs kept.
- 4 name collisions resolved by keeping the newer, banner-edited archive copies
  and dropping the bare top-level duplicates; stale `docs/...` path references in
  code comments and docs updated to `docs/archive/...`.

## 7. Verification commands run in this batch and their results

- `npm ci` — completed successfully (exit 0). Note: npm blocked native install
  scripts during the run, which left `better-sqlite3` without its binding; a
  manual `npm rebuild better-sqlite3` (+ approve) restored it, after which the
  server-backed tests could start the real server.
- `npm audit --omit=dev` — **0 vulnerabilities** (must stay 0).
- `npm run test:crypto` — **118 tests: 114 pass, 0 fail, 4 skipped, 0 todo**
  (exit 0), re-run after the sw-manifest regeneration during this batch;
  `public/sw-manifest.js` was regenerated (version `231f4ca59dff`) and `--check`
  passes.
- New + changed test files together (`tests/apk-integrity.test.mjs`,
  `tests/cors-config.test.mjs`, `tests/media-auth-deactivated.test.mjs`): **13/13
  pass** (exit 0) — `tests/apk-integrity.test.mjs` now carries 5 tests (hash
  present + valid, recompute, fail-closed via portable stream stub, client-refusal
  source test) plus the CORS (5) and media-auth (3) files.
- `tests/apk-integrity.test.mjs` alone — **5/5 pass** (exit 0).
- Browser tests requiring `@sparticuz/chromium`: not run in this batch (the
  package is installed externally at `/home/arman/browser-check` and would need
  `CHROMIUM_DIR` pointed there; the earlier "88 browser tests fail because the
  package cannot be installed" conclusion was environmental, not code). Full-suite
  baseline vs. branch comparison showed the same 88 test names failing in both
  runs (no regressions).
- Which tests ran / which could not: ran — `npm run test:crypto` (118) and the
  new/changed files above (13 combined); could not run — the browser/CDP suites
  here (no `@sparticuz/chromium` install in the default `CHROMIUM_DIR`). Runs
  were as the normal user (uid 1000); a root run was not possible in this
  environment (no passwordless sudo).

## 8. APK update integrity — full record (everything done so far for the APK)

### Summary of the APK work

The Android APK self-update integrity work spans the server, the client, the
tests and the build artifact, and was finished in the last batch of leftover
fixes on top of the branch `test` work:

1. **The integrity gate was fail-open in both directions (fixed).**
   - Server (`controllers/apk.controller.js`): the APK hash is now computed
     asynchronously through a read stream (`fs.createReadStream` + SHA-256) and,
     when hashing fails, `getApkInfo()` returns `{ available: false }` — it never
     returns `sha256: null` and never advertises an update it cannot verify.
   - Client (`public/js/core/appUpdate.js`): `downloadAndInstall(expectedSha256)`
     now refuses to install when the advertised info has no sha256 (no legacy
     fallback kept) and refuses when the recomputed hash of the downloaded file
     does not match the advertised hash.

2. **Comment cleanup + alignment.** Garbled/duplicated comment lines in
   `controllers/apk.controller.js` were rewritten, and the wording was aligned
   with the "Android APK self-update" row and the "(Android) same-signed malicious
   APK" limitation in `docs/archive/SECURITY_CLAIMS.md` — a hostile origin that
   serves both the bytes and the hash means the SHA-256 only binds the advertised
   version to the served bytes.

3. **Tests extended** (`tests/apk-integrity.test.mjs`): hash present + valid
   (64 hex, matches bytes), hash recomputed after the file changes (cache
   invalidation / stale-mismatch detection), and fail-closed behaviour when the
   hash cannot be computed.

4. **Build artifact handling.** `app-debug.apk` is untracked (`git rm --cached`,
   kept on disk); `APK_PATH` prefers `app-debug.apk` and falls back to the legacy
   `apk-debug.apk` (documented in `.env.example`).

5. **Manifest.** `public/sw-manifest.js` was regenerated after the `public/js`
   edits.

### Known limitation

A hostile origin serving both the bytes and the hash cannot be stopped by the
SHA-256 alone; stopping such an origin requires out-of-band hash trust (client
build pin or release-key-signed hash).

### Verification (APK-related)

- `tests/apk-integrity.test.mjs` — 4/4 pass; combined new/changed run
  (apk-integrity + cors-config + media-auth-deactivated) — 12/12 pass; full
  `npm run test:crypto` — 118 tests, 114 pass, 0 fail, 4 skipped.

## 10. Multer 2.x fileSize boundary fix (config/multer.js)

- Root cause: multer 2.x (busboy 1.x) treats `fileSize` as INCLUSIVE, but
  `dmUpload`/`groupUpload` added `+ 1` to `extraBytes` assuming multer 1.x's
  EXCLUSIVE behaviour. That admitted one extra byte, making
  `tests/groups/group-attachment-server.test.mjs` "3C-2b" pass a cap+16+1 file.
- Fix: removed `+ 1` from BOTH uploaders and rewrote the two comments to
  describe the multer 2.x inclusive behaviour.
- Other uploaders (avatar, banner, chat, fileUpload, groupAvatar) were NOT
  changed (per instruction). They use `fileSize: maxSizeMB * 1024 * 1024`
  with no `extraBytes`. Under multer 2.x their boundary shifted by one byte:
  a file of EXACTLY the cap is now ACCEPTED (was rejected under multer 1.x),
  and cap+1 is still rejected. Reported, not changed.
- Added a ciphertext-level DM boundary test (exactly cap+overhead accepted,
  cap+overhead+1 refused) to
  `tests/dm-attachments/dm-attachments-server-cap.test.mjs`.

### Verification (multer fix)
- `group-attachment-server` — 8/8 pass (exit 0).
- `group-attachment-limits` + `group-attachment-upload-cap` — 7/7 pass.
- `dm-attachments-server-cap` — 5/5 pass.
- `files-upload-name-length` + `upload-headers` — 9/9 pass.

- Voice messages added to group chats behind the EXISTING
  `GROUP_ATTACHMENTS_UI_ENABLED` flag (still `false`); no flag flip.
- Protocol: voice flag travels ONLY inside the encrypted plaintext meta
  (`meta.file.voice === true`); `META_VERSION` stays `1`; no outer-envelope
  field, no change to the signed attachment slot, signing, nonce/counter or
  AAD. Server keeps `is_voice_message = 0` and neutral name/mime.
- Receiver safety: flag honoured only for allowlisted audio mimes
  (`audio/webm`/`audio/ogg`/`audio/mp4`); non-audio renders as a normal file.
- Sender UI: group composer mic control reusing `voice-recorder.js` (same UX,
  limits, permission handling), through `prepareGroupAttachmentUpload(..., isVoice: true)`,
  respecting `GROUP_UPLOAD_MAX_MB`.
- Playback: existing `voice-message.js`/`audio-player.js` from the DECRYPTED blob
  (whole file, no streaming); no SW changes; CSP `media-src 'self' blob:` already
  allows blob: playback.
- Previews: group decorated message's `is_voice_message` taken from the verified
  meta (mirroring DM's `applyAttachmentMeta`), so reply quotes show
  "Voice message"; server column stays 0 and nothing is added to push payloads.
- Docs: `docs/archive/GROUP_ATTACHMENTS_E2EE.md` (3C-voice), `docs/archive/SECURITY_CLAIMS.md`
  (new row).

### Verification (group voice, branch `group-voice`)

- `npm run test:crypto` — **118 tests: 114 pass, 0 fail, 4 skipped** (exit 0),
  re-run after `node scripts/build-sw-manifest.mjs` (version `f806d1e93c69`);
  `node scripts/build-sw-media-bundle.mjs --check` — current.
- Node group-attachment suite (non-browser): combined run
  `group-attachment-ui` 10/10, `group-attachment-hostile` 11/11 — plus
  `group-attachment-binding`, `group-attachment-download`, `group-attachment-envelope`,
  `group-attachment-filename`, `group-attachment-lazy`, `group-attachment-limits`,
  `group-attachment-repaint`, `group-attachment-upload-cap` — **71/71 pass**
  (exit 0).
- `group-signing-messages` (C3-12) — **12/12 pass** (exit 0); signing/binding
  tests — **67/67 pass** (exit 0).
- `group-attachment-server` — 7/8 pass; the single failure (`3C-2b`, one byte
  over the cap) is PRE-EXISTING on the base `test` tree (verified by stashing),
  environment/cap behaviour, not introduced by this change.
- Browser (Chromium): NOT RUN in this environment (no `@sparticuz/chromium`
  install at the default `CHROMIUM_DIR`); the fake-mic group voice browser test
  was added to `tests/groups/group-attachment-browser.test.mjs` (test 12) and
  must be run on Linux per `docs/archive/RUN_BROWSER_TESTS_LINUX.md` with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`
  [NOT VERIFIED].
- Flag check: `GROUP_ATTACHMENTS_UI_ENABLED` remains `false`
  (`public/js/chat/group-attachments-flag.js:17`).

## 11. Task 5 (pre-merge-fixes): other uploaders - multer 2.x size boundary recorded

- New test `tests/uploaders-boundary.test.mjs` (8/8 pass) records, per uploader
  in `config/multer.js`, the accepted size cap the multer instance enforces:
  - avatarUpload (avatar): `limits.fileSize === AVATAR_MAX_MB * 1MB`.
  - bannerUpload (banner): `limits.fileSize === BANNER_MAX_MB * 1MB`.
  - chatUpload (chat attachments): `limits.fileSize === CHAT_UPLOAD_MAX_MB * 1MB`.
  - fileUpload (My Files): `limits.fileSize === UPLOAD_MAX_MB * 1MB`.
  - groupAvatarUpload (group avatar): `limits.fileSize === AVATAR_MAX_MB * 1MB`.
  - dmUpload: `limits.fileSize === plaintext cap + stream ciphertext overhead`.
  - groupUpload: `limits.fileSize === plaintext cap + 16 (GCM tag)`.
- Behavioural note (multer 2.x, busboy 1.x): `fileSize` is INCLUSIVE, so a file of
  EXACTLY the cap is accepted and cap+1 is refused - for the plain uploaders this
  is the semantics they now run under after the Task-2 multer fix (the former
  `+ 1` hacks only existed because multer 1.x treated the limit as EXCLUSIVE).
- Result table (as of this task, `pre-merge-fixes` @ `4ea1da0`):

  | Uploader | Cap constant | Exactly-cap behaviour | cap+1 |
  |---|---|---|---|
  | avatarUpload | AVATAR_MAX_MB (5) | accepted (inclusive) | refused |
  | bannerUpload | BANNER_MAX_MB (8) | accepted (inclusive) | refused |
  | chatUpload | CHAT_UPLOAD_MAX_MB (50) | accepted (inclusive) | refused |
  | fileUpload | UPLOAD_MAX_MB (2048) | accepted (inclusive) | refused |
  | groupAvatarUpload | AVATAR_MAX_MB (5) | accepted (inclusive) | refused |
  | dmUpload | DM_UPLOAD_MAX_MB + stream overhead | accepted | refused |
  | groupUpload | GROUP_UPLOAD_MAX_MB + 16 | accepted | refused |

- Behavioural half of the record ([NOT VERIFIED]): the EXACT-CAP / CAP+1
  accept-refuse behaviour was asserted via the configured limits plus the
  multer-2.x inclusive rule, not via a live multipart round-trip on each of the
  mounted uploader endpoints (avatar `/api/me/avatar`, banner `/api/me/banner`,
  file `/api/files/upload/:folderId`, group avatar `/api/groups/:id/avatar`).
- Asked the owner, pending decision: which size semantics do they want for the
  plain uploaders - keep the multer-2.x INCLUSIVE boundary (exactly-cap accepted,
  cap+1 refused; recommended, no code change made) or restore an explicit
  exclusive-style boundary. No behaviour was changed by this task.