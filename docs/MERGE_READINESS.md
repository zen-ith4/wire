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
8. **Dependency lockfile (npm ci on `npm@12.2.1`)**: `github/main`'s
   `package-lock.json` fails `npm ci` under npm 12.2.1 — `EUSAGE`: "can only install
   packages when your package.json and package-lock.json are in sync", and
   `Missing: fsevents@2.3.3 from lock file` + `Missing: @esbuild/*@0.28.2 from lock
   file` (all 24 platform packages). This branch's `package-lock.json` passes
   (`npm ci --dry-run` exit 0). Reproduced with `npx npm@12.2.1 ci --dry-run` in a
   clean `github/main` worktree (`/tmp/wt-main` @ `b24b847`). No `package-lock.json`
   change was made; the branch's lockfile is in sync with its `package.json`.

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
    error: `a short password is refused by the wizard`. **Now explained**: the failure
    was environmental, not a branch regression — the local, gitignored `.env`
    (`SETUP_COMPLETED=true`) leaked into the wizard's throwaway copy (server.js does
    `require('dotenv').config()`, which loads the copy's `.env`, skipping the wizard).
    Re-measured: real `.env` present -> fail (subtest 3); clean worktree (no `.env`) ->
    3/3 pass. Fixed in the test by skipping local-only entries in the copy
    (`.env`/`.env.*` except `.env.example`, runtime dirs, `*.apk`).
  - `tests/csp-handlers-enforced-browser.test.mjs` — previously listed as failing
    subtests **1** and **2** ("dm-send click created exactly one server message",
    actual **2 !== 1**; "emoji picker rendered at least one emoji"); **re-verified in
    this session: it PASSES 2/2 on both `github/main` and the branch** (exit 0, both
    subtests `ok`). It no longer belongs to the failing list; see
    "Known red tests on main".
  - `tests/dm-csp-handlers-enforced-browser.test.mjs` — failing subtest **1** "CSP_ENFORCE
    =true: DM Send and Delete work with real clicks; Attach is still blocked": error
    `Attach (still an inline onclick) is blocked: expected script-src-attr violation`.
  - `tests/escape-attr-js-string.test.mjs` — failing subtests **1–3**: `renderAttachment`
    / `imageDownloadButtonHtml` — error `element has an onclick attribute` (the test
    expects inline onclick markup; the delegated-handler migration made these data-action).
  - `tests/dm-v2-wire-browser-paths.test.mjs` — failing subtest **12** "i. three rows
    (good, tampered, good): 2 good bubbles + 1 placeholder in order"; error:
    `Waiting for selector '.nav-link[data-view="messages"]' failed` (puppeteer
    `waitForSelector` timeout). **Flaky, not a deterministic regression**: 3× on
    `github/main` @ `b24b847` → **3/3 pass** (14/14 each); on the branch → **2/3**
    (run2 failed subtest 12). Green on main, intermittently red on the branch.
  - `tests/media/sw-stream-browser.test.mjs` — failing subtest **4** "seek: Range
    request at the seek position, correct time, correct decoded bytes"; error:
    `decoded PCM must equal the plaintext PCM` (hash mismatch on captured PCM).
    **Flaky on both sides**: 3× on `github/main` → **2/3** (run3 failed subtest 4);
    on the branch → **2/3**. Both sides show intermittent red, so this is flakiness,
    not a branch regression.
  - No file **hung** in the per-file run (no `timeout 600` exit 124).
- Device / manual tests (audio playback on real hardware, mic permission UX).
- Real group attachment row count in production (E2EE bookkeeping).
- DB migrations.
- Live multipart uploads at the exact cap for **every** uploader (avatar, banner,
  chat, My Files / fileUpload, groupAvatar, DM, group).

## Also-fails-on-main determination (re-measured on the real `github/main` @ `b24b847`)

The previous version of this section was written against a **local `main` that is
not `github/main`**: the local branch `main` here points at `daad142` ("3.L: fix
the Linux CI recipe"), an ancestor that is **130 commits behind `github/main`** @
`b24b847`. Every "passes on `main`" number in the previous version came from that
stale local `main`, which is why the conclusion did not survive re-measurement on
the real `github/main`.

Re-measured on the real `github/main` (clean worktree: `git worktree add
/tmp/wt-main github/main` @ `b24b847`), same Chromium as before
(`CHROMIUM_DIR=/home/arman/browser-check`, `@sparticuz/chromium` resolved through
that dir -> `HeadlessChrome/153.0.8010.0`, puppeteer-core, Node v22.23.4, uid 1000,
`--test-concurrency=1`, `--env-file=tests/test.env`):

- `tests/acceptance-xss-sweep-browser.test.mjs` — **FAILS on `github/main`** (exit 1;
  subtest 5, error: `alice: DM thread attachments: both hostile attachments were
  clicked (0)`). The test file and the code it exercises (`public/js/chat/dm.js`,
  `public/js/media/attachments.js`) are **identical** on `github/main` and on the
  branch -> **pre-existing on `github/main`**, not branch-specific.
- `tests/credentials/f12-setup-seed.test.mjs` — **PASSES on `github/main`** (exit 0;
  3/3 pass across runs); **FAILS on the branch** (subtest 3: `a short password is
  refused by the wizard`). Now explained: the branch-side red was environmental (local
  `.env` with `SETUP_COMPLETED=true` leaking into the copied tree), not a branch
  regression; clean worktree -> 3/3 pass, real `.env` present -> fail. Fixed in the
  test (skip local-only entries in the copy).
- `tests/csp-handlers-enforced-browser.test.mjs` — **EXISTS on `github/main`** and
  **PASSES there** (exit 0; 2/2 pass) as well as on the branch (2/2, exit 0). It is
  green; it is not one of the failing files.
- `tests/dm-csp-handlers-enforced-browser.test.mjs` — **FAILS on `github/main`** (exit 1;
  subtest 1, error: `Attach (still an inline onclick) is blocked: expected
  script-src-attr violation`; subtest 2 passes). The test file and the code it
  exercises (`public/js/chat/dm.js`, `public/js/chat/composer.js`) are **identical**
  on `github/main` and on the branch -> **pre-existing on `github/main`**.
- `tests/escape-attr-js-string.test.mjs` — **FAILS on `github/main`** (exit 1; subtests
  1-3, error: `element has an onclick attribute` at `tests/escape-attr-js-string.test.mjs:68`).
  The test requires an inline `onclick` attribute; the product
  (`public/js/media/attachments.js`) now emits delegated `data-action` handlers
  (identical on `main` and the branch) -> **stale test**, **pre-existing on `github/main`**.

Plus `tests/credentials/f12-browser-login.test.mjs` (not among the 5, but decisive):
**FAILS on `github/main`** (subtest 6, `window.addUser is not a function`, exit 1);
**PASSES on the branch** after `e0f326f` (delegated `[data-action="admin-add-user"]`
click). The failure therefore exists on `github/main` as well; `e0f326f` fixes a
main-present failure.

**Determination (re-measured): the failures are NOT all branch-specific.** The
`acceptance-xss-sweep-browser`, `escape-attr-js-string` and
`tests/dm-csp-handlers-enforced-browser` failures **also fail on the real
`github/main`**, so they are **pre-existing on `github/main`** rather than
branch-specific regressions introduced by the CSP stage 2 content (`a34efa5` and
siblings).

## Known red tests on main (@ `b24b847`) — re-measured 2026-11-13

Red tests that reproduce on **`github/main`** itself, with cause:

- `tests/acceptance-xss-sweep-browser.test.mjs` — subtest 5 red (exit 1). Cause: the
  hostile entity-encoded filename must not break out of the inline onclick JS string;
  the click-driven assertion got `both hostile attachments were clicked (0)`.
  Pre-existing on `github/main`; the exercised code is identical on main and branch.
- `tests/escape-attr-js-string.test.mjs` — subtests 1-3 red (exit 1). Cause: stale test —
  it requires an inline `onclick` attribute, while the product now renders delegated
  `data-action` handlers (`public/js/media/attachments.js`). Pre-existing on `github/main`.
- `tests/dm-csp-handlers-enforced-browser.test.mjs` — subtest 1 red (exit 1; negative
  control: Attach must still be an inline onclick). Cause: stale negative control —
  Attach is now delegated, so no `script-src-attr` violation is raised. Pre-existing
  on `github/main`.
- `tests/credentials/f12-browser-login.test.mjs` — subtest 6 red on main: `window.addUser
  is not a function`. Stale test (app uses delegated `[data-action="admin-add-user"]`);
  **fixed on the branch by `e0f326f`**.

`tests/csp-handlers-enforced-browser.test.mjs` **passes on `github/main`** (2/2, exit 0)
and on the branch (2/2, exit 0) in this session — it is green, not red.

Explained: `tests/credentials/f12-setup-seed.test.mjs` — red on the branch (subtest 3),
green on `github/main` (3/3); the wizard source and the test file are identical on both
trees, so the split was environmental (local `.env` with `SETUP_COMPLETED=true` leaking
into the copied tree). Fixed in the test by skipping local-only entries in the copy;
re-verified: with the real `.env` present -> 3/3 pass after the fix.

## Merge-readiness status

- **Merge-ready was NOT claimed.** The full suite (`npm run test`) was killed
  mid-run on request (`FULL_SUITE_EXIT=143`); the per-file run (step 1) finished:
  **163 files → 158 green, 5 red, 0 hung** (serial, `timeout 600` per file, no
  timeout/exit-124). Red: `acceptance-xss-sweep-browser` (subtest 5), `dm-csp-handlers-enforced-browser`
  (subtest 1), `escape-attr-js-string` (subtests 1–3), `dm-v2-wire-browser-paths`
  (subtest 12), `media/sw-stream-browser` (subtest 4).
- After `e0f326f` (f12 admin-UI fix), **5 files remained failing**
  (acceptance-xss-sweep-browser, f12-setup-seed,
  csp-handlers-enforced-browser, dm-csp-handlers-enforced-browser,
  escape-attr-js-string) with the exact subtests above; the f12 admin-UI failure was
  fixed in `e0f326f` and is now green (6/6 alone). NOTE: `csp-handlers-enforced-browser`
  was re-verified in this session and **passes 2/2**, so it no longer belongs to the
  failing list (see "Known red tests on main").
- **Main-worktree check (re-measured on the real `github/main` @ `b24b847`):**
  - `acceptance-xss-sweep-browser`, `escape-attr-js-string` and
    `dm-csp-handlers-enforced-browser` **fail on `github/main` too** -> they are
    **pre-existing** on `main`, not branch-specific regressions; the branch did not
    change the code they exercise (verified: `git diff github/main test` shows no
    change to `public/js/chat/dm.js`, `public/js/chat/composer.js`,
    `public/js/media/attachments.js`, `public/js/settings/admin.js`).
  - `csp-handlers-enforced-browser` **passes on `github/main`** (2/2).
  - `f12-setup-seed` **passes on `github/main`** (3/3).
  - `f12-browser-login` **fails on `github/main`** (subtest 6, `window.addUser is
    not a function`) and is fixed on the branch by `e0f326f`.
- Until the remaining failures are fixed and re-verified, the branch is **not**
  merge-ready. (The earlier "none of the 5 also fails on `main`" statement was wrong.)

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
