# Working State — `pre-merge-fixes` branch (HEAD `981b00f`)

Everything here is committed and pushed to `github/pre-merge-fixes`.
Base: `test` @ `4ea1da0`. Target: `github/main` @ `b24b847`.

## 1. Dependency upgrades + npm audit

- `file-type` `20.5.0 → ^22.3.0`, `multer` `^1.4.5-lts.2 → ^2.5.0`.
- `npm audit --omit=dev`: **11 → 0** (prod advisory in `fast-xml-parser` bumped).
- This branch's lockfile passes `npm ci --dry-run` on npm 12.2.1; `github/main`'s fails.

## 2. mediaAuth deactivated-account fix

- `middleware/mediaAuth.js` → shared `loadActiveUser()` (missing/deactivated/stale-token = 401).
- Bearer and media-token paths now share one "is this account allowed" check.

## 3. APK update integrity (fail-closed)

- Server hashes APK asynchronously (stream + SHA-256); `getApkInfo()` returns `{available:false}` on failure.
- Client `downloadAndInstall(expectedSha256)` refuses install without hash or on mismatch.
- **Deploy order: server first, then clients** (updated clients reject servers without sha256).
- `APK_PATH` default `./app-debug.apk`, falls back to `./apk-debug.apk`; artifact untracked.

## 4. CORS hardening

- `middleware/cors.js`: `cors({origin:true, credentials:false})` (no cookies in app).
- `server.js` mounts the new middleware.

## 5. Multer 2.x inclusive `fileSize` boundary

- Removed stale `+1` from `dmUpload`/`groupUpload` `extraBytes` (multer 2.x/busboy 1.x is inclusive).
- Owner decision: **keep inclusive** (exactly-cap accepted, cap+1 refused); client checks use strict `>`.
- New `tests/uploaders-live-cap.test.mjs` proves the boundary for all 6 uploaders with real multipart.

## 6. Group voice messages (behind `GROUP_ATTACHMENTS_UI_ENABLED=false`)

- Voice flag only in encrypted plaintext meta (`meta.file.voice === true`).
- Server stores neutral name/mime/`is_voice_message=0`.
- No SW changes; CSP `media-src 'self' blob:` allows blob: playback.

## 7. Docs reorganisation

- Loose top-level `docs/*.md` → `docs/archive/`; ~200 internal links not rewritten (note in `docs/archive/README.md`).

## 8. Three stale tests repaired (T1)

| Test file | Fix |
|-----------|-----|
| `acceptance-xss-sweep-browser` | `clickDownloads()` selector → `[data-action="attachment-download"]`; subtest renamed; hostile payloads + `clicked ≥ 2` + `__pwned===false` kept |
| `escape-attr-js-string` | Subtests 1-3 rewritten: assert no inline `on*` attributes; `data-*` round-trip filename/mime exactly (HTML5 CR→LF normalization) |
| `dm-csp-handlers-enforced-browser` | Negative control replaced: injected inline `onclick` probe, asserts `script-src-attr` violation + non-execution under `CSP_ENFORCE=true` |

**All three: green 3/3 runs.**

## 9. sw-stream-browser flakiness (T2)

- Test 4 ("seek: Range request...") failed intermittently: captured PCM hash mismatch.
- Root cause: capture timing — Web Audio ScriptProcessor can drop/duplicate a 128-sample render quantum when the element is not fully buffered.
- Fix in `tests/media/sw-stream-browser.test.mjs`:
  - Added `waitForBufferedAhead(seconds)` readiness helper (buffered range must cover capture window).
  - Capture uses single 16384-block ScriptProcessor; trims leading silence; bounded retry (3×) with same assertions.
- **Before**: branch 2/3 fail, main 1/4 fail (flaky).
- **After**: branch 8/10 pass, main 6/10 pass — flaky on both, not a branch regression.

## 10. dm-v2-wire-browser-paths flakiness (T3)

- Subtest 12 ("three rows") timed out waiting for `.nav-link[data-view="messages"]` after reload.
- Root cause: test clicked unlock button before `unlock-form.onsubmit` was attached (native form submit navigates, leaving app locked).
- Fix in `tests/dm-v2-wire-browser-paths.test.mjs`:
  - `reloadUser()` waits for `unlock-form.onsubmit` function before `requestSubmit()`.
  - Better diagnostic on shell-render failure.
- **Before**: 1/3 fail on branch (timeout); **after**: deterministic.

## 11. Live multipart cap tests for all uploaders (T4)

- `tests/uploaders-live-cap.test.mjs`: 9 tests, 3/3 runs green.
- Covers: avatar, banner, My Files, group avatar, DM attachment, group attachment.
- Caps lowered to 1 MiB via env; exact cap → 200, cap+1 → 400 `{error:"Upload failed"}`; refusal cleans up orphan file.
- `services/drive.service.js`: `createUserDrive()` accepts `userDataRootOverride` for test isolation.

## 12. Database schema / migration check (T5)

- `git diff github/main...HEAD -- database/`: only 2 comment lines in `migrations.js` (`docs/… → docs/archive/…`).
- **No schema changes** — production DB only needs to satisfy `github/main`'s schema (already there).

## 13. Release runbook (T6)

- `docs/RELEASE_RUNBOOK.md`: tag, fast-forward merge, deploy order, env diff, APK location, npm notes, smoke tests, rollback.

## 14. Manual test checklist (T7)

- `docs/MANUAL_TEST_CHECKLIST.md`: step-by-step for Chrome, Firefox, Safari, APK, Electron.

## 15. Docs hygiene (T8)

- `docs/MERGE_READINESS.md` rewritten: accurate, non-redundant, links to runbook/checklist/prod checks.
- `docs/archive/README.md`: note about pre-reorganisation paths.
- `state/index.md` updated with real results.

## 16. Verification summary (this session)

| Suite | Result |
|-------|--------|
| `npm run test:crypto` | 118 pass, 0 fail |
| `npm audit --omit=dev` | 0 |
| `npm ci` (npm 10) | pass |
| `npx npm@12.2.1 ci --dry-run` (branch) | pass |
| `npx npm@12.2.1 ci --dry-run` (github/main) | **fail (EUSAGE)** |
| `node scripts/build-sw-manifest.mjs --check` | pass |
| `GROUP_ATTACHMENTS_UI_ENABLED` | `false` |
| `MEDIA_STREAM_ENABLED` | `false` |
| T1 repaired tests (3 files) | 3/3 runs green each |
| T2 sw-stream-browser | branch 8/10, main 6/10 (flaky both) |
| T3 dm-v2-wire-browser-paths | deterministic |
| T4 uploaders-live-cap | 9/9 pass, 3/3 runs |
| Full per-file suite (163 files) | 158 green, 5 red, 0 hung |

**Red files (all classified):**
- `acceptance-xss-sweep-browser` subtest 5 — **pre-existing on github/main** (stale test)
- `escape-attr-js-string` subtests 1-3 — **pre-existing on github/main** (stale test)
- `dm-csp-handlers-enforced-browser` subtest 1 — **pre-existing on github/main** (stale negative control)
- `dm-v2-wire-browser-paths` subtest 12 — **flaky on branch, green on main**
- `media/sw-stream-browser` subtest 4 — **flaky on both**

## 17. Human gates remaining (NOT VERIFIED / NOT RUN)

- **Manual device tests**: `docs/MANUAL_TEST_CHECKLIST.md` — Chrome, Firefox, Safari, APK, Electron.
- **Production DB checks**: `docs/PROD_CHECKS.md` — row counts, deactivated users, schema readiness, APK hash.
- **Fast-forward merge + deploy**: `docs/RELEASE_RUNBOOK.md` steps 1–3, 7–8 — NOT RUN.
- **Rollback rehearsal**: NOT RUN.
- **Device audio/mic UX**: NOT VERIFIED.
- **Real APK update flow (matching + mismatched hash)**: NOT VERIFIED.
- **CORS from Capacitor/Electron origins**: NOT VERIFIED.
- **Group voice recording/playback (flag-on dev copy)**: NOT VERIFIED.