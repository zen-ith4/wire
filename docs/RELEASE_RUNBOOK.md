# Release Runbook (Wire)

> Every command marked **[NOT RUN]** was not executed by the agent — the human
> operator must run and verify it. Commands without that marker were actually
> run and their output recorded in this file.

---

## 1. Tag `github/main` before merging

```bash
git fetch github
git checkout main
git tag -a pre-merge-2026-11 github/main -m "Pre-merge baseline before test->main"   # -a, not -s: a signed tag needs a GPG key
git push github pre-merge-2026-11
```
**[NOT RUN]** — run on deploy machine after verifying `main` is at `b24b847`.

---

## 2. Merge command (fast-forward)

The branch `pre-merge-fixes` is **0 commits behind** `github/main` — the merge base is
`b24b847` — so a fast-forward merge works:

```bash
# Verify ancestry first
git merge-base --is-ancestor github/main HEAD && echo "OK: HEAD descends from github/main"
# If that succeeds:
git checkout main
git merge --ff-only pre-merge-fixes
git push github main
```
**[NOT RUN]** — run on deploy machine.

---

## 3. Deploy order: **SERVER FIRST, THEN APK/CLIENTS**

**Reason:** Updated clients (APK/Electron) refuse to install an update from a
server that does NOT advertise its APK `sha256` via `/api/apk/info`. This
fail-closed behaviour was added in `config/apk.js` and
`public/js/settings/update-check.js`. If clients are updated before the server,
the update check will 404 or lack a hash and the client will refuse to install.

1. Deploy the server (with this branch's code + lockfile).
2. Verify `/api/apk/info` returns `available: true` and a valid `sha256`.
3. **Then** distribute the new APK/Electron builds.

---

## 4. Environment changes (`.env.example` diff)

```bash
git diff github/main...HEAD -- .env.example
```

Key changes (from the diff):
- `APK_PATH` default updated from `./apk-debug.apk` to `./app-debug.apk`
  (falls back to the legacy name if the new one is absent).
- Comment clarifies the fail-closed update behaviour.
- `CSP_ENFORCE` doc path updated: `docs/CSP_TODO.md` → `docs/archive/CSP_TODO.md`.

No **new required** variables — all are optional with documented defaults.

---

## 5. APK artifact location

The built APK is **not tracked in git**. The server expects it at `APK_PATH`
(env var, default `./app-debug.apk` with fallback to `./apk-debug.apk`).

```bash
# On the build machine (after gradle assembleDebug):
ls -l app/build/outputs/apk/debug/app-debug.apk
# Copy/rename to the server's working directory as ./app-debug.apk
# or set APK_PATH=/full/path/to/app-debug.apk in .env
```

---

## 6. npm notes

| npm version | `npm ci` on `github/main` | `npm ci` on `pre-merge-fixes` |
|-------------|---------------------------|-------------------------------|
| 10.x        | pass                      | pass                          |
| 12.2.1      | **FAIL** (EUSAGE, missing `fsevents@2.3.3` + 24 `@esbuild/*@0.28.2` entries) | pass |

**Verification (run both):**
```bash
# On github/main worktree (e.g. /tmp/wt-main)
npx npm@12.2.1 ci --dry-run   # expect exit 1, EUSAGE

# On pre-merge-fixes worktree
npx npm@12.2.1 ci --dry-run   # expect exit 0
```
**[NOT RUN]** — run on deploy machine before deploy.

---

## 7. Post-deploy smoke tests

Use `scripts/smoke.mjs` (read-only; see `docs/DEPLOY_COMMANDS.md` section 7):

```bash
WIRE_URL=https://YOUR_SERVER SMOKE_USER=someuser SMOKE_PASS='...' EXPECT_APK=1 \
  node scripts/smoke.mjs
```

It was tested against a real local server (valid account and APK: 7 passed;
no APK: 5 passed + 1 WARN; wrong password: login FAIL, exit 1).

**Corrections to the earlier version of this section** (the old curl examples
did not match the code):

- Group endpoints require `X-Wire-Group-Proto: 2` or newer (`GROUP_PROTOCOL_MIN`
  in `middleware/groupProtocol.js`); the old text said `1`, which answers 426.
- `POST /api/auth/login` with a raw `password` only works for scheme-1
  accounts. Scheme-2 accounts need an `auth_key` derived with the client KDF, so a
  plain curl login cannot work for them; the script derives it.
- DM and group messages are end-to-end encrypted; a plaintext `curl` POST is
  not a meaningful test. Sending messages and uploads must be tested with a real
  client (`docs/MANUAL_TEST_CHECKLIST.md`).
- A deactivated-user media check is manual (`docs/MANUAL_TEST_CHECKLIST.md`).

---

## 8. Rollback

A fast-forward merge creates **no merge commit**, so `git revert -m 1` does
not work. Use `docs/DEPLOY_COMMANDS.md` section 9:

```bash
# A. redeploy the tag on the server
git fetch github --tags && git checkout pre-merge-2026-11 && npm ci   # + your restart command

# B. undo on main without rewriting history (never force-push main)
git switch main
git revert --no-commit pre-merge-2026-11..main
git commit -m "Revert pre-merge-fixes merge"
git push github main
```

**Database migrations:** none; only comment paths changed in
`database/migrations.js`.

**[NOT RUN]** — never executed. **[NOT VERIFIED]** what an already-updated
client does after a rollback to a server that does not advertise `sha256`.

---

## 9. What to watch after deploy

- `/api/apk/info` must continue to return the same `sha256` as the file on disk.
- Deactivated accounts (if any) now get `401` on media URLs — confirm they
  cannot stream attachments.
- Group attachments UI stays hidden (`GROUP_ATTACHMENTS_UI_ENABLED=false` in
  `public/js/chat/group-attachments-flag.js`).
- Error logs for `script-src-attr` CSP violations (should be zero if front-end
  is CSP-clean).
- Upload refusals: multer 2.x returns 400 `{error:"Upload failed"}` for
  cap+1 — verify no 500s or orphan files.

---

## Appendix: Commit list on this branch (since `4ea1da0`)

```bash
git log --oneline github/main..HEAD
```

- `70d69a0` test: repair three stale tests for delegated data-action handlers
- `981b00f` test: add live multipart cap boundary tests for all uploaders
- `93c8a9f` docs: add npm ci failure on github/main lockfile; record 2 flaky red files; update test counts
- `5871e9f` docs: explain f12-setup-seed red as local .env leak; keep merge-readiness status
- `9051b3f` test: skip local-only state when copying the tree for the setup-wizard test
- `e0f326f` test(credentials): drive the real admin Add-user UI via the delegated data-action click
- `42b2ab0` test: correct also-fails-on-main classification for three stale tests