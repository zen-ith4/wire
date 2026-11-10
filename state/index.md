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
