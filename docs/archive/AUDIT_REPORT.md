# Docs audit report (2026-11-09)

Scope: every Markdown file in the repository that documents the project: `README.md`, `GUIDE.md`, every file under `docs/`, `electron-client/README.md`, `public/js/notifications/PLATFORM-NOTES.md`, plus `.env.example`. Total before: 8,364 lines of Markdown. Total after: 9,034 lines (including 3 new files). **No existing document was shortened or summarised**: edits are insertions, corrected statements, corrected line numbers and moves.

## 1. Method, and what it can and cannot prove

1. **File references.** Every path ending in `.js/.mjs/.cjs/.json/.md/.html/.css/.yml/.sh` in every doc was resolved against the checkout (exact path, or unique suffix for paths written relative to `public/js/`).
2. **Line references.** All `file:line` and `file:a-b` references were extracted and checked. For the five maintained docs (table in section 4) each reference was inspected against the code at that line; the ones that no longer pointed at the described construct were corrected by hand with the evidence recorded in section 5. An automatic re-anchoring pass was tried first and **discarded**: in cells that make several claims it moved correct references to wrong lines (it would have broken `public/sw.js:102`, `peer-trust.js:30`, `attachment-crypto.js:122`, `signing.js:93-104`). Nothing was changed on heuristic evidence alone.
3. **Environment variables, npm scripts, script files, test files and test names** named in docs were looked up in `package.json`, `scripts/`, `tests/` and the code.
4. **Status statements** ("not implemented", "design only", "not merged", "UNVERIFIED", "default is 1", "possibly outdated") were each checked against the tree; section 3 lists every one that was wrong.
5. **Tests were run**: the whole non-browser suite (1193 tests, 359 s) and the DM/peer/identity suites before that. Results in section 6.

**Limits, stated plainly.** (a) This checkout has one commit, so branch names and commit hashes quoted in docs (`13b27e2`, `a20d2ec`, `merged-final`, ...) cannot be verified and were left as written. (b) No Chromium was available, so browser tests were not run. (c) A file:line check proves the line still contains the described construct, not that the surrounding prose is still true; prose was checked only for the status claims in section 3. (d) Design records pinned to older commits (section 4) keep their original line numbers on purpose; a banner at the top of each says so.

## 2. Result at a glance

- File and path references: **1747** path mentions in the new tree; the few that do not resolve are listed in section 7 (external tools, deleted tests, pre-fix names).
- Links from docs to other docs: **0** broken after the moves (checked). Links from code, scripts and tests to docs: **0** broken.
- Wrong or missing statements corrected: **15** (section 3).
- Line references corrected by hand: **48** occurrences in 36 edits (section 5).
- Tests: 1193 run, 1162 pass, **7 fail** (4 need Chromium, 3 are a stale test that was never fixed).
- Files moved to `docs/archive/` or `docs/plans/`: 19; exact duplicates removed: 1.

## 3. Statements that were wrong, and what replaced them

| doc | what it said | what the tree shows | fix |
|---|---|---|---|
| `DM_V2_WIRE.md` | "Default is 1 ... behaves EXACTLY as before"; four INSERT sites stay at 1; "Default 2 applies to self-registration only" | `constants.DM_E2EE_DEFAULT_MIN_VERSION` (default 2) is passed at every `INSERT INTO users`; tests `dm-e2ee-default`, `dm-e2ee-admin-inserts` pin it | status paragraph and decision 3 rewritten; old wording kept as quoted history |
| `e2ee-dm-hardening.md` | same "four sites that stay at 1" | same as above | sentence corrected with an audit note |
| `DM_V2_WIRE.md` | (silent) | 7 server/client rules existed only in code and tests: text enforcement, attachment enforcement, 2000-char cap, ciphertext pre-check, inactive-recipient 404, key gate, seam | new section with a rule / location / test table |
| `MEDIA_STREAMING_RFC.md` | "fetch handler, stream registry and client wiring are not implemented"; section 10.3 "C2+ not done" | `stream-registry.js`, the fetch branch in `sw.js`, `sw-stream-client.js`, `lazy-e2ee-media.js` exist; flag still `false` (`sw.js:102`); `handler-core.js` hash unchanged | status line fixed; new section 10.4 with sizes and SHA-256 of 7 files, manifest check, test list |
| `PHASE_B_PLAN.md` (now archived) | "DESIGN ONLY. Nothing here is implemented." | F12 is implemented: `services/credentialMigration.service.js`, `utils/credentials.js`, 15 `tests/credentials/f12-*` files | status line replaced; rest of the plan not re-audited |
| `GROUP_E2EE_MULTIDEVICE_DESIGN.md` | "implemented on branch `fix/group-e2ee-hardening` (not merged)" | the code and its tests are in the checkout | status corrected (branch state not checkable: single-commit history) |
| `RUN_BROWSER_TESTS_LINUX.md` | nothing was run on Linux | `test-baseline.md` section 0 records Linux browser runs (made with a different procedure) | audit note added; the recipe itself stays UNVERIFIED |
| `BROWSER_TEST_ISOLATION.md` | nothing re-measured on Linux | same as above | audit note added |
| `.env.example` | "Do not enforce [CSP] until the legacy inline handlers are removed (see docs/CSP_TODO.md)" | `CSP_TODO.md` says the front-end is CSP-clean and the tests run with `CSP_ENFORCE=true` | comment rewritten (file included in the zip) |
| `.env.example` | (silent) | 16 variables the code reads were never listed (incl. `DM_E2EE_DEFAULT_MIN_VERSION`) | added as commented lines, no invented values |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | limits endpoint at `routes/groups.routes.js:68`, `groups.controller.js:126` | route at :72, handler at :148 | corrected |
| `PHASE3_RFC.md` | "the 2000-character cut at `dm.controller.js:454`" | the cut is gone; the server returns 413 `DM_CONTENT_TOO_LONG` | marked as pre-fix with a pointer |
| `PORT_NOTES.md`, `archive/csp-and-dm-work-notes.md` | escape-attr test "possibly outdated" / "no browser needed" | confirmed outdated: 3 tests fail on `onclick` | audit notes added |
| `docs/for later/` and `docs/` | two identical copies of `csp-and-dm-work-notes.md` | byte-identical (checked) | one copy kept (archive), one removed |
| `plans/BACKEND_IMPROVEMENT_PLAN.md` | reads as a pure to-do list | items 4 and 12 are done, 2/3/6/7/17 partly done, 5/8/9/10/13/14/15/16/18 open | status line under each of the 18 items |

## 4. Every document, and how it was treated

| doc | `file:line` refs | treatment |
|---|---:|---|
| `GUIDE.md` | 0 | checked, no stale reference found |
| `README.md` | 0 | checked, no stale reference found |
| `docs/BROWSER_TEST_ISOLATION.md` | 2 | checked |
| `docs/CSP_TODO.md` | 0 | checked, no stale reference found |
| `docs/DM_ATTACHMENTS_E2EE.md` | 0 | checked, no stale reference found |
| `docs/DM_V2_WIRE.md` | 5 | line refs inspected one by one; stale ones fixed (section 5) |
| `docs/E2EE_TRIAGE_3I.md` | 20 | pinned to the commits it names; banner added; line numbers intentionally kept |
| `docs/GROUP_ATTACHMENTS_E2EE.md` | 53 | line refs inspected one by one; stale ones fixed (section 5) |
| `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md` | 24 | line refs inspected one by one; stale ones fixed (section 5) |
| `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` | 0 | checked, no stale reference found |
| `docs/MEDIA_STREAMING_RFC.md` | 144 | pinned to the commits it names; banner added; line numbers intentionally kept |
| `docs/PHASE3_RFC.md` | 11 | line refs inspected one by one; stale ones fixed (section 5) |
| `docs/PORT_NOTES.md` | 7 | pinned to the commits it names; banner added; line numbers intentionally kept |
| `docs/README.md` | 0 | new |
| `docs/REFERENCE.md` | 55 | new |
| `docs/RUN_BROWSER_TESTS_LINUX.md` | 1 | checked |
| `docs/SECURITY_CLAIMS.md` | 42 | line refs inspected one by one; stale ones fixed (section 5) |
| `docs/SLEEP_SYNC_AUDIT.md` | 145 | all 144 entries re-checked mechanically (still point at `sleep(`); note added |
| `docs/archive/PHASE_B_PLAN.md` | 9 | archived with banner; content unchanged except the audit note |
| `docs/archive/WIRE_PHASE0_ITEM1_ITEM2.md` | 54 | archived with banner; content unchanged |
| `docs/archive/WIRE_PHASE0_OWNER_REVIEW.md` | 10 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1B_AGENT_TASK.md` | 11 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1D_AGENT_TASK.md` | 5 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1E_AGENT_TASK.md` | 0 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1G_AGENT_TASK.md` | 2 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1H_AGENT_TASK.md` | 1 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1I_AGENT_TASK.md` | 1 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_1J_PART_B_AGENT_TASK.md` | 3 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_2A_AGENT_TASK.md` | 4 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_2B_AGENT_TASK.md` | 0 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_3A_AGENT_TASK.md` | 0 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_3B_AGENT_TASK.md` | 1 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_3C_AGENT_TASK.md` | 1 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_3E_AGENT_TASK.md` | 4 | archived with banner; content unchanged |
| `docs/archive/agent-tasks/STEP_3F_AGENT_TASK.md` | 0 | archived with banner; content unchanged |
| `docs/archive/csp-and-dm-work-notes.md` | 0 | archived with banner; content unchanged except the audit note |
| `docs/ci/RUN_ON_LINUX.md` | 0 | checked, no stale reference found |
| `docs/e2ee-dm-hardening.md` | 23 | pinned to the commits it names; banner added; line numbers intentionally kept |
| `docs/plans/BACKEND_IMPROVEMENT_PLAN.md` | 0 | status per item added |
| `docs/test-baseline.md` | 0 | new section 0a (fresh run) |
| `electron-client/README.md` | 0 | checked, no stale reference found |
| `public/js/notifications/PLATFORM-NOTES.md` | 0 | checked, no stale reference found |

Changed files (lines removed / added, compared with the original; moved files are compared with their old path):

| file | removed | added | kind |
|---|---:|---:|---|
| `docs/BROWSER_TEST_ISOLATION.md` | 0 | 2 | edited |
| `docs/DM_V2_WIRE.md` | 7 | 38 | edited |
| `docs/E2EE_TRIAGE_3I.md` | 1 | 3 | edited |
| `docs/GROUP_ATTACHMENTS_E2EE.md` | 16 | 16 | edited |
| `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md` | 10 | 10 | edited |
| `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md` | 1 | 1 | edited |
| `docs/MEDIA_STREAMING_RFC.md` | 0 | 33 | edited |
| `docs/PHASE3_RFC.md` | 5 | 5 | edited |
| `docs/PORT_NOTES.md` | 3 | 5 | edited |
| `docs/README.md` | 0 | 56 | new file |
| `docs/REFERENCE.md` | 0 | 130 | new file |
| `docs/RUN_BROWSER_TESTS_LINUX.md` | 0 | 2 | edited |
| `docs/SECURITY_CLAIMS.md` | 9 | 9 | edited |
| `docs/SLEEP_SYNC_AUDIT.md` | 0 | 2 | edited |
| `docs/archive/PHASE_B_PLAN.md` | 1 | 3 | moved + edited |
| `docs/archive/WIRE_PHASE0_ITEM1_ITEM2.md` | 0 | 2 | moved + edited |
| `docs/archive/WIRE_PHASE0_OWNER_REVIEW.md` | 0 | 2 | moved + edited |
| `docs/archive/agent-tasks/STEP_1B_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_1D_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_1E_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_1G_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_1H_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_1I_AGENT_TASK.md` | 2 | 4 | moved + edited |
| `docs/archive/agent-tasks/STEP_1J_PART_B_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_2A_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_2B_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_3A_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_3B_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_3C_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_3E_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/agent-tasks/STEP_3F_AGENT_TASK.md` | 1 | 3 | moved + edited |
| `docs/archive/csp-and-dm-work-notes.md` | 2 | 4 | moved + edited |
| `docs/e2ee-dm-hardening.md` | 3 | 3 | edited |
| `docs/plans/BACKEND_IMPROVEMENT_PLAN.md` | 0 | 38 | moved + edited |
| `docs/test-baseline.md` | 0 | 24 | edited |

Unchanged: 8 files.

## 5. Line references corrected by hand

Each row was checked by reading the code at the new line; `old` is the text as it stood in the doc, `n` how many times it occurred.

| doc | old | new | evidence | n |
|---|---|---|---|---:|
| `SECURITY_CLAIMS.md` | `dm-v2.js:324` | `dm-v2.js:326` | dmMessageAad is at dm-v2.js:326 | 1 |
| `SECURITY_CLAIMS.md` | `dm-v2.js:715` | `dm-v2.js:725` | dmAttachmentAad is at dm-v2.js:725 | 1 |
| `SECURITY_CLAIMS.md` | `dm-v2.js:52-54` | `dm-v2.js:54-56` | DM_V2_INFO_A2B/B2A are at dm-v2.js:54 and :56 | 1 |
| `PHASE3_RFC.md` | `dm-v2.js:324` | `dm-v2.js:326` | dmMessageAad is at dm-v2.js:326 | 1 |
| `PHASE3_RFC.md` | `dm-v2.js:715` | `dm-v2.js:725` | dmAttachmentAad is at dm-v2.js:725 | 1 |
| `PHASE3_RFC.md` | `dm-v2.js:52-54` | `dm-v2.js:54-56` | DM_V2_INFO_A2B/B2A are at dm-v2.js:54 and :56 | 1 |
| `PHASE3_RFC.md` | ``:190`, `:231`` | ``:192`, `:233`` | directionLabel :192, deriveDmV2Key :233 | 1 |
| `SECURITY_CLAIMS.md` | `dm-v2.js:54-56`, `:231`` | `dm-v2.js:54-56`, `:233`` | deriveDmV2Key :233 | 1 |
| `SECURITY_CLAIMS.md` | `services/auth.service.js:405` | `services/auth.service.js:408` | constants.DM_E2EE_DEFAULT_MIN_VERSION is passed there | 1 |
| `SECURITY_CLAIMS.md` | `database/seed.js:55` | `database/seed.js:78` | same | 1 |
| `SECURITY_CLAIMS.md` | `utils/setupWizard.js:632` | `utils/setupWizard.js:673` | same | 1 |
| `SECURITY_CLAIMS.md` | `services/user.service.js:91`, `:290`` | `services/user.service.js:118`, `:322`` | same (two INSERT sites) | 1 |
| `SECURITY_CLAIMS.md` | `database/migrations.js:41`` | `database/migrations.js:42`` | column definition with DEFAULT 1 | 1 |
| `SECURITY_CLAIMS.md` | `database/migrations.js:127-140` | `database/migrations.js:169-182` | the two dm_e2ee_min_version triggers | 1 |
| `SECURITY_CLAIMS.md` | `database/migrations.js:127`` | `database/migrations.js:169`` | ratchet trigger | 1 |
| `SECURITY_CLAIMS.md` | `public/js/core/auth.js:66` | `public/js/core/auth.js:81` | localStorage.setItem(token) is there | 1 |
| `SECURITY_CLAIMS.md` | `auth.js:492` | `auth.js:546` | if (rememberMe === true) is there | 1 |
| `PHASE3_RFC.md` | `public/js/core/auth.js:492` | `public/js/core/auth.js:546` | if (rememberMe === true) is there | 1 |
| `PHASE3_RFC.md` | `the 2000-character cut at `controllers/dm.controller.js:454`` | `the 2000-character limit (at the time of writing a silent cut at `c...` | server rejects instead of cutting; line was pre-fix | 1 |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | `public/js/chat/group.js:684` | `public/js/chat/group.js:726` | renderActiveGroupShell definition | 1 |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | `group.js:700-702` | `group.js:762-764` | staging area and file input are rendered only when the flag is on | 2 |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | `public/js/chat/group.js:239` | `public/js/chat/group.js:247` | UNVERIFIED_HTML definition | 1 |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | `group.js:370` | `group.js:413` | return { html: UNVERIFIED_HTML, permanent: true } | 1 |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | `group.js:739-743` | `group.js:804-808` | uploadUrl / prepareUpload block | 1 |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | `config/constants.js:144` | `config/constants.js:213` | GROUP_UPLOAD_MAX_MB | 2 |
| `GROUP_ATTACHMENTS_E2EE.md` | `routes/groups.routes.js:68` | `routes/groups.routes.js:72` | GET /limits route | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `config/constants.js:144` | `config/constants.js:213` | GROUP_UPLOAD_MAX_MB | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `groups.controller.js:608-687` | `groups.controller.js:827-906` | sendMessageWithAttachmentHandler (same length as the old range) | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `groups.controller.js:640-645` | `groups.controller.js:853-858` | attachment_iv read from the multipart body | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `groups.controller.js:245` | `groups.controller.js:221` | comment: every remaining member must rotate | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `attachment-crypto.js:223` | `attachment-crypto.js:129` | additionalData: attachmentAad(...) | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `signing.js:158-159` | `signing.js:81-95` | groupId is destructured and signed in encodeSignedBytes | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `config/multer.js:305-307` | `config/multer.js:314-316` | groupUpload maxSizeMB | 1 |
| `GROUP_ATTACHMENTS_E2EE.md` | `(?<![\w/.\-])message-crypto\.js:(\d)` | `public/js/crypto/groups/message-crypto.js:\1` | bare name matched two files; lines 72/111/159/185/324/400/407 were verified in groups/message-crypto.js | 11 |
| `PORT_NOTES.md` | `- `escapeAttr()` JS-string contract: `tests/escape-attr-js-string.t...` | `- `escapeAttr()` JS-string contract: `tests/escape-attr-js-string.t...` | test fails 3/3 against current markup | 1 |
| `csp-and-dm-work-notes.md` | `- `escape-attr-js-string` (3 tests); the tests look for an `onclick...` | `- `escape-attr-js-string` (3 tests); the tests look for an `onclick...` | confirmed by running the test | 1 |

Also corrected by edit (not in the table because they were part of rewritten statements): `DM_V2_WIRE.md` decision 3 now cites the current lines of the four INSERT sites; `GROUP_ATTACHMENTS_FLAG_FLIP.md` route/handler lines.

Inspected and **left as they were** because the line still holds the described construct (examples): `public/sw.js:102` (the flag), `public/sw.js:103`, `peer-trust.js:30`, `attachment-crypto.js:122`, `signing.js:93-104`, `signing.js:103`, `group-attachments.js:62/70/97/609/669/758`, `group.js:310`, `config/socket.js:72`, `middleware/authenticate.js:62`, `middleware/ipRestrict.js:63/95`, `utils/tlsSetup.js:127`.

## 6. Test run

Whole non-browser suite in this checkout: **1193 tests, 1162 pass, 7 fail, 11 skipped, 13 todo**, 359 s, 135 of 159 files (Node v22.23.4, no Chromium). Details and the cause of each failure: `docs/test-baseline.md` section 0a.

The first run covered `tests/dm-*.test.mjs`, `tests/peer-*.test.mjs`, `tests/identity-key-history.test.mjs`: the only failures there were the Chromium ones.

## 7. Still open (needs the owner, not fixable from the code alone)

**Code problems found while checking docs**

- `tests/escape-attr-js-string.test.mjs`: 3 failing tests; rewrite for `data-action` markup or list in `tests/EXCLUDED_NOT_APPLICABLE.json` (currently empty).
- `tests/dm-v2-vanishing-row.test.mjs`: needs Chromium but is not named like a browser test, so a name-based split mis-files it.
- `controllers/groups.controller.js` comment above `getUploadLimitsHandler` says `controllers/dm.controller.js:326`; the DM handler is at `controllers/dm.controller.js:356`.
- `.env.example` is in the zip (fixed there); `scripts/run-browser-tests-linux.sh` header still says UNVERIFIED (still true for that script).

**Path mentions that do not resolve (all in design records or archived files, left as written)**

- `docs/BROWSER_TEST_ISOLATION.md`: `browser-check/index.js`
- `docs/PORT_NOTES.md`: `chat.js`
- `docs/archive/agent-tasks/STEP_1H_AGENT_TASK.md`: `reference/probe-tamper-rows.mjs`
- `docs/archive/agent-tasks/STEP_1J_PART_B_AGENT_TASK.md`: `tests/dm-v2-wire-browser-gap.test.mjs`
- `docs/archive/agent-tasks/STEP_2B_AGENT_TASK.md`: `reference/probe-attachment-v2.mjs`
- `docs/e2ee-dm-hardening.md`: `groups/session.js`

**Not verifiable here**

- Branch names, commit hashes, "owner decided on <date>" statements and measurements taken on other machines (Windows/Chrome numbers in `BROWSER_TEST_ISOLATION.md`, `MEDIA_STREAMING_RFC.md` section 8, the `wire-final-N` tables in `test-baseline.md`).
- Prose in design records beyond their status lines. They describe decisions at a point in time; only the parts that claim to describe the current tree were checked.
- `file:line` references in pinned design records: 194 in total, not re-anchored by design.

## 8. Files in this zip

Unzip over the repository root: paths are repository-relative. `.env.example` replaces the old one. The old `docs/agent-tasks/`, `docs/for later/`, `docs/WIRE_PHASE0_*`, `docs/PHASE_B_PLAN.md` and `docs/csp-and-dm-work-notes.md` should be deleted after unzipping (they now live under `docs/archive/` and `docs/plans/`); `docs/AUDIT_MOVES.txt` lists the exact `git mv` commands.
