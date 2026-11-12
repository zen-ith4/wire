# Merge readiness — `pre-merge-fixes` (base: `test` @ `4ea1da0`)

- Base branch: `test` (pushed to `github/test`), HEAD `4ea1da0`
  (`fix(sw): regenerate sw-manifest.js after c0e30f1 changed public/js`).
- Working branch: `pre-merge-fixes`, created from that base, pushed to
  `github/pre-merge-fixes` (now at `e0f326f` — `135c407` -> `e0f326f` the f12 fix).
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

- `e0f326f` — `test(credentials): drive the real admin Add-user UI via the delegated data-action click` (tests/credentials/f12-browser-login.test.mjs).
- `106fd6c` — `fix(group-voice): revoke the voice blob URL on render failure and make voice rows render once` (public/js/chat/group-attachments.js, sw-manifest.js, tests/groups/group-attachment-hostile.test.mjs).
- `135c407` — `fix(group-voice): claim the voice element synchronously so concurrent renders build one player; keep the player import inside try` (public/js/chat/group-attachments.js, sw-manifest.js regenerated → version `597688d15b41`, tests/groups/group-attachment-hostile.test.mjs).
- `031ed04` — `fix(deps): bump fast-xml-parser to clear the prod audit advisory (GHSA-474x-hrwr-fgx4)` (package-lock.json).
- `bdfe2ed` — `test(uploaders): record the multer 2.x inclusive size boundary per uploader` (tests/uploaders-boundary.test.mjs, state/index.md).
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
  `node scripts/build-sw-manifest.mjs --check` (current: version `597688d15b41`,
  190 files); CI step exists in `docs/ci/linux-tests.yml`.
- Browser (Chromium): group-attachment-browser file — **3 full runs, 12/12 pass
  each**; pair with `group-e2e-browser.test.mjs` — **13/13 pass**.
- Credentials admin UI: `tests/credentials/f12-browser-login.test.mjs` — **6/6
  pass** when run alone after `e0f326f` (the admin Add-user test now drives the real
  delegated `[data-action="admin-add-user"]` button instead of the removed
  `window.addUser()`).

## What was NOT verified (this branch)

- Files from the per-file full-suite run (step 1) that **failed or hung**:
  - `tests/acceptance-xss-sweep-browser.test.mjs` — failing subtest: **5** "I filename:
    an entity-encoded quote in a filename cannot break out of the inline onclick JS
    string (real click)"; error: `alice: DM thread attachments: both hostile
    attachments were clicked (0)`.
  - `tests/credentials/f12-browser-login.test.mjs` — failing subtest **6** "admin UI
    \"Add user\"…": error `window.addUser is not a function`. **FIXED in `e0f326f`**;
    now green (6/6 alone).
  - `tests/credentials/f12-setup-seed.test.mjs` — failing subtest **3** "setup wizard
    (real prompts, copied tree): creates a scheme-2 admin; refuses < 12 characters";
    error: `a short password is refused by the wizard`.
  - `tests/csp-handlers-enforced-browser.test.mjs` — failing subtests **1** ("dm-send
    click created exactly one server message", actual **2 !== 1**) and **2** (emoji
    picker rendered at least one emoji).
  - `tests/dm-csp-handlers-enforced-browser.test.mjs` — failing subtest **1** "CSP_ENFORCE
    =true: DM Send and Delete work with real clicks; Attach is still blocked": error
    `Attach (still an inline onclick) is blocked: expected script-src-attr violation`.
  - `tests/escape-attr-js-string.test.mjs` — failing subtests **1–3**: `renderAttachment`
    / `imageDownloadButtonHtml` — error `element has an onclick attribute` (the test
    expects inline onclick markup; the delegated-handler migration made these data-action).
  - No file **hung** in the per-file run (no `timeout 600` exit 124).
- Device / manual tests (audio playback on real hardware, mic permission UX).
- Real group attachment row count in production (E2EE bookkeeping).
- DB migrations.
- Live multipart uploads at the exact cap for **every** uploader (avatar, banner,
  chat, My Files / fileUpload, groupAvatar, DM, group).

## Also-fails-on-main determination (git worktree on `main`)

Each of the 5 remaining failing files was re-run in a git worktree checked out to
`main` (same test file as it exists on `main`, `main` code), with
`CHROMIUM_DIR=/home/arman/browser-check`:

- `tests/acceptance-xss-sweep-browser.test.mjs` — **PASSES on `main`** (exit 0; 6
  pass, 1 skip, 1 todo). The test file is **identical** on `main` and the branch;
  the branch changed the code it exercises (`public/js/chat/dm.js`,
  `public/js/media/attachments.js`), so this failure is branch-specific.
- `tests/credentials/f12-setup-seed.test.mjs` — **PASSES on `main`** (exit 0;
  3/3 pass). The test file differs slightly (9 lines) between `main` and the branch;
  the failure is branch-specific.
- `tests/csp-handlers-enforced-browser.test.mjs` — **does not exist on `main`**
  (exit 1, `Could not find`); it is a **new test added by the branch** (CSP stage
  2, `a34efa5`). It cannot fail on `main` by definition.
- `tests/dm-csp-handlers-enforced-browser.test.mjs` — **PASSES on `main`** (exit
  0; 2/2 pass). The test file is **identical** on `main` and the branch; the branch
  changed the code it exercises (`public/js/chat/dm.js`,
  `public/js/chat/composer.js`), so this failure is branch-specific.
- `tests/escape-attr-js-string.test.mjs` — **PASSES on `main`** (exit 0; 6/6
  pass). The test file is **identical** on `main` and the branch; the branch changed
  the code it exercises (`public/js/media/attachments.js`: inline `onclick` →
  `data-action`), but the test still asserts the inline `onclick` attribute, so this
  failure is a branch-specific regression (code changed, test not updated).

**Determination: none of the 5 remaining failing files also fails on `main`.** All
4 that exist on `main` pass there; the 1 that does not exist on `main`
(`csp-handlers-enforced-browser`) is a new test added by the branch. All 5 failures
are branch-specific, caused by the CSP stage 2 (`a34efa5` and siblings) content.

## Merge-readiness status

- **Merge-ready was NOT claimed.** The full suite (`npm run test`) was killed
  mid-run on request (`FULL_SUITE_EXIT=143`); the per-file run (step 1) finished:
  **163 files → 157 green, 6 red, 0 hung**.
- After `e0f326f` (f12 admin-UI fix), **5 files remain failing**
  (acceptance-xss-sweep-browser, f12-setup-seed,
  csp-handlers-enforced-browser, dm-csp-handlers-enforced-browser,
  escape-attr-js-string) with the exact subtests above; the f12 admin-UI failure was
  fixed in `e0f326f` and is now green (6/6 alone).
- **Main-worktree check:** none of the 5 remaining failures also fails on `main`
  (4 of them pass on `main`; 1 is a new test added by the branch). So all 5 are
  **branch-specific regressions** introduced by the CSP stage 2 content
  (`a34efa5` and siblings) — they must be fixed (code or test) before merge.
- Until the remaining failures are fixed and re-verified, the branch is **not**
  merge-ready.

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
