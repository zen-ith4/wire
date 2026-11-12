# Merge readiness — `pre-merge-fixes` (base: `test` @ `4ea1da0`)

- Base branch: `test` (pushed to `github/test`), HEAD `4ea1da0`
  (`fix(sw): regenerate sw-manifest.js after c0e30f1 changed public/js`).
- Working branch: `pre-merge-fixes`, created from that base, pushed to
  `github/pre-merge-fixes` (now at `135c407`).
- No feature flag was flipped by this branch. `GROUP_ATTACHMENTS_UI_ENABLED`
  (`public/js/chat/group-attachments-flag.js`) and
  `MEDIA_STREAM_ENABLED` (`public/sw.js:102`) remain `false`.

## What the whole merge (`test` -> `main`) contains

This branch inherits (from the base `test` @ `4ea1da0`) the accumulated merge
content, plus its own new-on-top commits:

1. **Dependency upgrades + audit**: `file-type` `20.5.0 -> ^22.3.0`, `multer`
   `^1.4.5-lts.2 -> ^2.5.0`, lockfile update; `npm audit --omit=dev` went from **11
   vulnerabilities to 0**. This branch's own addition in that area: the last
   production advisory (`fast-xml-parser <=5.11.2`, GHSA-474x-hrwr-fgx4, transitive
   via `firebase-admin -> @google-cloud/storage`) was bumped, so the audit is now
   **0** (`npm audit --omit=dev`).
2. **mediaAuth deactivated-account fix**: `middleware/mediaAuth.js` via the shared
   `loadActiveUser()` (missing row / deactivated row / stale session token version
   are all refused) — the Bearer-token and media-token paths share one
   "is this account allowed" implementation.
3. **APK update integrity (fail-closed)**: server hashes the APK asynchronously
   (read stream + SHA-256) and `getApkInfo()` fails closed (`available: false`);
   client (`downloadAndInstall(expectedSha256)`) refuses to install without an
   advertised sha256 and refuses on hash mismatch. **Compatibility note**: updated
   clients refuse servers that do not advertise an sha256 — therefore the server
   must be deployed first, then the clients.
4. **CORS hardening**: `credentials: false` (`middleware/cors.js`, `server.js`).
5. **Multer 2.x fileSize boundary fix**: removed the stale `+ 1` from the DM and
   group uploaders (`config/multer.js`); multer 2.x / busboy 1.x treats `fileSize`
   as **inclusive**. The boundary decision is now **made and recorded as
   inclusive** (exactly-cap accepted, cap+1 refused), with new
   `tests/uploaders-boundary.test.mjs` pinning the caps of the other uploaders.
6. **Group voice messages** (behind the existing `GROUP_ATTACHMENTS_UI_ENABLED`,
   still `false`): voice flag travels only inside the encrypted plaintext meta
   (`meta.file.voice === true`); `META_VERSION` stays `1`; server keeps
   `is_voice_message = 0` + neutral name/mime; receiver honours the flag only for
   allowlisted audio mimes; sender uses the shared recorder; playback reuses the
   existing voice player from the decrypted blob; no SW changes; CSP `media-src
   'self' blob:` allows blob:.
7. **Docs reorg**: loose top-level `docs/*.md` moved into `docs/archive/`.

## What is NEW on top of `4ea1da0` (this branch's own commits)

- `106fd6c` — `fix(group-voice): revoke the voice blob URL on render failure and
  make voice rows render once` (public/js/chat/group-attachments.js, sw-manifest.js,
  tests/groups/group-attachment-hostile.test.mjs).
- `135c407` — `fix(group-voice): claim the voice element synchronously so
  concurrent renders build one player; keep the player import inside try`
  (public/js/chat/group-attachments.js, sw-manifest.js regenerated → version
  `597688d15b41`, tests/groups/group-attachment-hostile.test.mjs).
- `031ed04` — `fix(deps): bump fast-xml-parser to clear the prod audit advisory
  (GHSA-474x-hrwr-fgx4)` (package-lock.json).
- `bdfe2ed` — `test(uploaders): record the multer 2.x inclusive size boundary per
  uploader` (tests/uploaders-boundary.test.mjs, state/index.md).
- `e2a5e36` — `docs: add MERGE_READINESS.md for the pre-merge-fixes branch` (docs).

## What was verified (this branch)

- `npm run test:crypto` (with the Chromium install used in this session): **118
  tests, 118 pass, 0 fail, 0 skipped, 0 todo** (exit 0).
- Group-attachment node suites: `group-attachment-ui` 10/10, `group-attachment-hostile`
  **15/15** (incl. the new concurrent-render test), combined group-attachment run
  **71/71** pass; signing/binding 67/67; C3-12 12/12; group-attachment-server 8/8;
  group-attachment-limits + upload-cap 7/7; dm-attachments-server-cap 5/5;
  files-upload-name-length + upload-headers 9/9; uploaders-boundary 8/8.
- `fix(sw)` guard: `tests/sw-manifest.test.mjs` (SW-1…SW-4) **10/10 pass**; runs
  `node scripts/build-sw-manifest.mjs --check`; CI step exists in
  `docs/ci/linux-tests.yml`.
- Browser (Chromium): group-attachment-browser file — **3 full runs, 12/12 pass
  each**; pair with `group-e2e-browser.test.mjs` — **13/13 pass**.

## What was NOT verified (this branch)

- Files from the per-file full-suite run that **failed or hung** (step 1): recorded
  below / to be recorded from `/tmp/suite/summary.txt`.
- Device / manual tests (audio playback on real hardware, mic permission UX).
- Real group attachment row count in production (E2EE bookkeeping).
- DB migrations.
- Live multipart uploads at the exact cap for **every** uploader (avatar, banner,
  chat, My Files / fileUpload, groupAvatar, DM, group).

## Rollback notes

- No flag flip: flipping `GROUP_ATTACHMENTS_UI_ENABLED` to `true` is the owner's
  decision and is NOT done here.
- To roll back the voice change: revert the commits touching
  `public/js/chat/group-attachments.js`, `public/js/chat/group.js`,
  `public/js/media/voice-message.js`, `controllers/groups.controller.js` and the
  `fix(group-voice)` commits.
- To roll back the multer fix: restore the `+ 1` in `config/multer.js` for
  `dmUpload`/`groupUpload` (pre-fix state) — but under multer 2.x that re-admits one
  byte, so it should only be done deliberately.
- To roll back the audit bump: `git revert` the `fix(deps)` commit.

## Owner decision pending

- Which size semantics for the plain uploaders (inclusive vs exclusive) should
  ship — decided in this session: **keep inclusive**; client checks all use strict
  `>` (consistent); no client changes made.
