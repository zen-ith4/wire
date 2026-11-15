# Deploy commands: tag, merge, deploy, smoke test, rollback

Copy-paste commands for the merge of `pre-merge-fixes` into `main`.
Run them in order. **Stop at the first command whose output differs from the
"expected" line.**

What was actually executed while writing this: the `git merge-base` /
`rev-list` checks, `npm ci` (npm 10.9.9) and `npx npm@12.2.1 ci --dry-run`, and
`scripts/smoke.mjs` against a real local server (3 scenarios, plus a mutation
that proves the CORS check can fail). **Not executed anywhere:** the tag, the
merge, the push, your deploy and restart steps, the rollback, and anything on a
real device. Those are marked `[NOT RUN]`.

I do not know how your server is started (systemd, pm2, docker, ...), so the
restart step is a placeholder.

---

## 0. Variables

```bash
# the git remote that points at github.com/zen-ith4/wire.
# On the developer machine it is `github`; elsewhere it is often `origin`.
git remote -v
export REMOTE=github

export TAG=pre-merge-2026-11
export BRANCH=pre-merge-fixes
```

## 1. Pre-flight (read-only)

```bash
git fetch "$REMOTE"

git rev-parse --short "$REMOTE/main"        # expected: b24b847
git rev-parse --short "$REMOTE/$BRANCH"     # write this down; it is what you are merging

# main must be an ancestor of the branch (this is what makes --ff-only work)
git merge-base --is-ancestor "$REMOTE/main" "$REMOTE/$BRANCH" && echo "OK: fast-forward possible"

# "<behind> <ahead>" of main vs branch. Expected: 0 followed by the commit count (28 at 1ee68d8)
git rev-list --left-right --count "$REMOTE/main...$REMOTE/$BRANCH"
```

If `behind` is not `0`, someone pushed to `main`: stop and ask.

Optional: confirm what `main` gets:

```bash
git diff --stat "$REMOTE/main" "$REMOTE/$BRANCH" | tail -1
git diff "$REMOTE/main" "$REMOTE/$BRANCH" -- .env.example
git diff "$REMOTE/main" "$REMOTE/$BRANCH" --stat -- database/    # expected: only 2 comment lines in database/migrations.js
```

## 2. Tag the current `main` (rollback point) `[NOT RUN]`

Tag the commit explicitly. Use an **annotated** tag (`-a`). A signed tag (`-s`)
needs a GPG key and fails without one.

```bash
git tag -a "$TAG" "$REMOTE/main" -m "main before merging $BRANCH"
git rev-parse --short "$TAG^{commit}"       # expected: b24b847
git push "$REMOTE" "$TAG"
```

## 3. Merge (fast-forward only) `[NOT RUN]`

```bash
git switch main
git merge --ff-only "$REMOTE/$BRANCH"       # fails loudly instead of creating a merge commit
git log --oneline -1
git push "$REMOTE" main
```

A fast-forward creates **no merge commit**. This matters for rollback
(section 8). If `main` is branch-protected and the push is refused, merge through
a pull request instead and use "Rebase and merge" or "Create a merge commit"
as your policy requires; the rollback commands in section 8 still work.

## 4. Build on the server `[NOT RUN]`

```bash
cd /path/to/wire            # your deployment checkout
git fetch "$REMOTE"
git checkout main
git pull --ff-only "$REMOTE" main

node -v                      # tests were run on Node 22
npm ci --no-audit --no-fund
npm audit --omit=dev         # expected: found 0 vulnerabilities
```

`npm ci` was verified with npm 10.9.9. `npx npm@12.2.1 ci --dry-run` also
passes on this branch, whereas it **fails on the old `main`** (EUSAGE, lockfile
out of sync). So do not "fix" this by deleting the lockfile.

Environment: `.env.example` changed only in comments and the `APK_PATH`
example (checked: no variable was added or removed between `main` and the
branch). Compare your production `.env` with the template anyway.

```bash
bash -c "diff <(grep -oE '^[A-Z][A-Z0-9_]+=' .env.example | tr -d = | sort -u) \
               <(grep -oE '^[A-Z][A-Z0-9_]+=' .env         | tr -d = | sort -u)"
# '<' = in the template but not in your .env (usually optional); commented-out
# variables are not compared.
```

## 5. APK artifact (only if you ship a client update) `[NOT RUN]`

`app-debug.apk` is no longer tracked in git. The server looks for it at
`APK_PATH` (default `./app-debug.apk`, falling back to the old name
`./apk-debug.apk`).

```bash
ls -l "${APK_PATH:-./app-debug.apk}"
sha256sum "${APK_PATH:-./app-debug.apk}"     # you will compare this with /api/apk/info below
```

Also set `APK_VERSION_NAME` and `APK_VERSION_CODE` in `.env` for the update
check.

## 6. Restart the server `[NOT RUN]`

```bash
# YOUR restart command, for example one of:
#   sudo systemctl restart wire
#   pm2 restart wire
#   docker compose up -d --build
```

## 7. Smoke test (read-only) `[NOT RUN on your server]`

`scripts/smoke.mjs` never writes, registers, uploads or sends anything. Use an
**existing, ordinary account** (not an admin). Run it from the repo root:

```bash
WIRE_URL=https://YOUR_SERVER \
SMOKE_USER=someuser SMOKE_PASS='their password' \
EXPECT_APK=1 \
node scripts/smoke.mjs
```

- Leave `EXPECT_APK=1` out if you are not shipping a client update yet; a
  missing APK is then only a WARN.
- Self-signed certificate: add `INSECURE_TLS=1`.
- Without `SMOKE_USER` the login checks are **SKIPPED**, and the script says so
  at the end. A skip is not a pass.
- Exit code `0` = everything that ran passed, `1` = at least one FAIL.

It checks: server up (`/api/version`), `/api/apk/info` advertises
`available:true` and a 64-hex `sha256`, the bytes at `/api/apk/download` hash to
that value, no `Access-Control-Allow-Credentials: true`, login (it derives the
login key the same way the browser does, so it works for the new account
scheme), an authenticated read (`/api/groups/limits`), and that the same call
without a token gets 401.

Tested against a real local server in three scenarios (all as expected):

| scenario | result |
|---|---|
| valid account and APK | 7 passed, exit 0 |
| no APK deployed, `EXPECT_APK` unset | 5 passed, 1 WARN, exit 0 |
| wrong password | login FAIL, authenticated reads SKIPPED, exit 1 |

It also failed correctly when I temporarily changed the server to send
`credentials: true` in CORS (then restored it).

**Not covered by the script; do these by hand** (`docs/MANUAL_TEST_CHECKLIST.md`):
sending a DM and a group message (E2EE: it needs a real client), uploads, a
deactivated account getting 401 on media, group voice (UI is flagged off), the
real APK update on a device (matching and mismatching hash), Capacitor and
Electron origins.

## 8. Only after the smoke test passes: ship the clients

Deploy order is **server first, then APK/Electron**. An updated client refuses
an update from a server that does not advertise `sha256`. Do not distribute the
new APK until step 7 passed with `EXPECT_APK=1`.

## 9. Rollback `[NOT RUN]`

`git revert -m 1 <sha>` is **invalid** after a fast-forward merge: there is no
merge commit. Use one of these:

**A. Redeploy the tagged commit (fastest, does not touch `main`):**

```bash
cd /path/to/wire
git fetch "$REMOTE" --tags
git checkout "$TAG"
npm ci --no-audit --no-fund
# YOUR restart command
curl -fsS https://YOUR_SERVER/api/version
```

The old commit has no `scripts/smoke.mjs`, and an old server does not advertise
`sha256`, so the APK check of the new smoke script would (correctly) FAIL there.

**B. Undo on `main` without rewriting history:**

```bash
git switch main
git revert --no-commit "$TAG..main"      # creates one working-tree revert of every commit
git commit -m "Revert $BRANCH merge"     # resolve conflicts first if git stops
git push "$REMOTE" main
```

Never force-push `main`.

Database: no schema change in this branch (only 2 comment lines in
`database/migrations.js`), so there is nothing to migrate back.
`[NOT VERIFIED]` what an already-updated client does if you roll the server back
to a version that does not advertise `sha256`. Reading the code, the check only
gates installing an update, not using the app, but this was never tested on a
device.

## 10. Production data checks (read-only)

Run `docs/PROD_CHECKS.md` before the merge if you have not yet (counts of group
attachments, deactivated users, and so on). Nobody has run it on production.
