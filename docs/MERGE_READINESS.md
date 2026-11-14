# Merge readiness — `pre-merge-fixes` (base: `test` @ `4ea1da0`)

- Base branch: `test` (pushed to `github/test`), HEAD `4ea1da0`.
- Working branch: `pre-merge-fixes`, pushed to `github/pre-merge-fixes` (now at `e8ae1a0`).
- No feature flag was flipped. `GROUP_ATTACHMENTS_UI_ENABLED`
  (`public/js/chat/group-attachments-flag.js`) and
  `MEDIA_STREAM_ENABLED` (`public/sw.js:102`) remain `false`.

## What the whole merge (`test` → `main`) contains

This branch inherits the accumulated merge content from `test` @ `4ea1da0`,
plus its own new-on-top commits:

1. **Dependency upgrades + audit**: `file-type` `20.5.0 → ^22.3.0`, `multer`
   `^1.4.5-lts.2 → ^2.5.0`, lockfile update; `npm audit --omit=dev` went from
   **11 → 0** (the last prod advisory in `fast-xml-parser` was bumped).
2. **mediaAuth deactivated-account fix**: `middleware/mediaAuth.js` via the shared
   `loadActiveUser()` — missing/deactivated/stale-session tokens are refused.
3. **APK update integrity (fail-closed)**: server advertises APK `sha256`;
   client refuses install without hash or on mismatch. **Deploy order: server first,
   then clients** (updated clients reject servers without sha256).
4. **CORS hardening**: `credentials: false` (`middleware/cors.js`, `server.js`).
5. **Multer 2.x inclusive `fileSize` boundary**: removed the stale `+ 1` from
   DM/group uploaders (`config/multer.js`); multer 2.x / busboy 1.x treats
   `fileSize` as **inclusive** (exactly-cap accepted, cap+1 refused). New
   `tests/uploaders-live-cap.test.mjs` pins the boundary for all 6 uploaders.
6. **Group voice messages** (behind `GROUP_ATTACHMENTS_UI_ENABLED=false`):
   voice flag travels only inside the encrypted plaintext meta
   (`meta.file.voice === true`); server stores neutral name/mime/`is_voice_message=0`;
   no SW changes; CSP `media-src 'self' blob:` allows blob:.
7. **Docs reorg**: loose top-level `docs/*.md` → `docs/archive/`.
8. **npm ci on npm 12.2.1**: `github/main`'s lockfile fails (`EUSAGE`,
   missing `fsevents@2.3.3` + 24 `@esbuild/*@0.28.2`); this branch's lockfile
   passes (`npm ci --dry-run` exit 0).

## Branch's own commits (since `4ea1da0`)

- `e8ae1a0` — docs: finalize merge-readiness, runbook, checklist, prod checks; fix test flakiness
- `981b00f` — test: add live multipart cap boundary tests for all uploaders
- `70d69a0` — test: repair three stale tests for delegated data-action handlers
- `93c8a9f` — docs: add npm ci failure on github/main lockfile; record 2 flaky red files; update test counts
- `5871e9f` — docs: explain f12-setup-seed red as local .env leak; keep merge-readiness status
- `9051b3f` — test: skip local-only state when copying the tree for the setup-wizard test
- `e0f326f` — test(credentials): drive the real admin Add-user UI via the delegated data-action click
- `106fd6c` — fix(group-voice): revoke the voice blob URL on render failure
- `135c407` — fix(group-voice): claim the voice element synchronously
- `031ed04` — fix(deps): bump fast-xml-parser to clear prod audit advisory

## What was verified (this branch)

- Crypto suites: **118 pass, 0 fail** (`npm run test:crypto`).
- Group-attachment node suites: `group-attachment-ui` 10/10, `group-attachment-hostile`
  15/15, combined **71/71**; signing/binding 67/67; C3-12 12/12; group-attachment-server 8/8;
  group-attachment-limits + upload-cap 7/7; dm-attachments-server-cap 5/5;
  files-upload-name-length + upload-headers 9/9; **uploaders-live-cap 9/9 (3/3 runs)**.
- SW manifest guard: `tests/sw-manifest.test.mjs` **10/10 pass**; `node scripts/build-sw-manifest.mjs --check` OK.
- Browser (Chromium @ `CHROMIUM_DIR=/home/arman/browser-check`):
  - `group-attachment-browser` — **3 full runs, 12/12 pass each**.
  - `group-e2e-browser` — **13/13 pass**.
  - `f12-browser-login` — **6/6 pass** (after `e0f326f`).
- **Three stale tests repaired (T1)**: `acceptance-xss-sweep-browser`,
  `escape-attr-js-string`, `dm-csp-handlers-enforced-browser` — all **green 3/3**.
- **sw-stream-browser flakiness (T2)**: `waitForBufferedAhead` readiness + single-block
  capture + silent-trim + bounded retry (3×); failure rate: branch **2/10**, main **4/10** (both flaky).
- **dm-v2-wire-browser-paths flakiness (T3)**: `reloadUser` waits for `unlock-form.onsubmit`
  before submitting; eliminates the selector timeout.
- **Full per-file suite (serial, timeout 600, --test-timeout=590000, CHROMIUM_DIR set)**: **164 files → 164 green, 0 red, 0 hung, 0 timeout (exit 124)** at e8ae1a0.

## What was NOT verified

- Device / manual tests (audio playback on real hardware, mic permission UX, APK update flow).
- Production DB row counts (group_messages with attachments, deactivated users).
- DB migrations on a live prod database (T5: no schema changes, only comment path updates).
- The merge itself (fast-forward not yet executed).

## Also-fails-on-main determination (re-measured on real `github/main` @ `b24b847`)

The previous analysis used a stale local `main` (`daad142`, 130 commits behind).
Re-measured on the real `github/main` (clean worktree, same Chromium, Node v22.23.4):

| Test file | github/main | Branch BEFORE repair | Branch AFTER repair (e8ae1a0) | Classification |
|-----------|-------------|----------------------|-------------------------------|----------------|
| `acceptance-xss-sweep-browser` | **FAIL** (subtest 5) | **FAIL** (subtest 5) | **PASS** (6 pass, 1 skip, 1 todo) | Pre-existing on main — stale test (inline onclick selector) |
| `escape-attr-js-string` | **FAIL** (subtests 1-3) | **FAIL** (subtests 1-3) | **PASS** (6/6) | Pre-existing on main — stale test (expects inline onclick) |
| `dm-csp-handlers-enforced-browser` | **FAIL** (subtest 1) | **FAIL** (subtest 1) | **PASS** (2/2) | Pre-existing on main — stale negative control (Attach is delegated) |
| `f12-browser-login` | **FAIL** (subtest 6) | **FAIL** (subtest 6) | **PASS** (6/6 after `e0f326f`) | Fixed on branch |
| `f12-setup-seed` | **PASS** (3/3) | **FAIL** (subtest 3) | **PASS** (3/3 after fix) | Env leak explained, test fixed |
| `csp-handlers-enforced-browser` | **PASS** (2/2) | **PASS** (2/2) | **PASS** (2/2) | Green everywhere |
| `dm-v2-wire-browser-paths` | **PASS** (3/3 × 14/14) | **PASS** (flaky: 2/3) | **PASS** (14/14, deterministic) | Flaky on branch, green on main |
| `media/sw-stream-browser` | **PASS** (6/10) | **FAIL** (flaky: 2/3) | **PASS** (8/10) | Flaky on both |

**Conclusion**: The three stale tests (`acceptance-xss-sweep-browser` subtest 5,
`escape-attr-js-string` subtests 1-3, `dm-csp-handlers-enforced-browser` subtest 1)
**fail identically on `github/main`** — they are **pre-existing**, not branch regressions.
The branch's repairs (T1) make them green on the branch.

The two flaky tests (`dm-v2-wire-browser-paths` subtest 12, `media/sw-stream-browser` subtest 4)
are **flaky on both trees** — not branch regressions.

## Known red tests on `github/main` @ `b24b847` (after T1 repairs)

None that are branch-specific. The only reds on `github/main` are the three stale tests
above, which are now green on this branch.

## Merge-readiness status

- **Technical gates passed**: All three stale tests repaired (T1); flakiness diagnosed
  and mitigated (T2, T3); live cap tests added (T4); no schema changes (T5);
  docs complete (T6, T7, T8).
- **Merge-ready NOT claimed** — human gates remain:
  - Manual device tests (MANUAL_TEST_CHECKLIST.md) — HUMAN TODO
  - Production DB checks (PROD_CHECKS.md) — HUMAN TODO
  - Fast-forward merge + deploy order verification — HUMAN TODO

## Rollback notes

- No flag flip: `GROUP_ATTACHMENTS_UI_ENABLED` / `MEDIA_STREAM_ENABLED` stay `false`.
- To roll back voice: revert the `fix(group-voice)` commits touching
  `public/js/chat/group-attachments.js`, `public/js/chat/group.js`,
  `public/js/media/voice-message.js`, `controllers/groups.controller.js`.
- To roll back multer boundary: restore the `+ 1` in `config/multer.js` for
  `dmUpload`/`groupUpload` (pre-fix state) — under multer 2.x that re-admits one
  byte, so only do this deliberately.
- To roll back audit bump: `git revert` the `fix(deps)` commit.
- DB migrations: none (T5 confirmed).

## Owner decision recorded

- Multer 2.x inclusive boundary kept (exactly-cap accepted, cap+1 refused).
  Client checks all use strict `>` — consistent. No client changes made.