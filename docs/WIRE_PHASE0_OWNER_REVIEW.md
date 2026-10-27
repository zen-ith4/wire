# Wire Phase 0 — owner-review report (Items 1 and 2: R3/R2/R5)

Status: **local only**. Branch `security-hardening`; nothing pushed; no history rewritten.

- Base for the Item 1/Item 2 work: `a2c58f2`
- Item 1/Item 2 commits: `c7b8fa4`, `b6c6f6b`, `f7c1555`, `56403d7`, `e25f89c`
- Owner-review follow-up code HEAD: `59df178`
- This report is a docs-only commit on top of that HEAD.

Scope: Items 1 and 2 only (`R3`, `R2`, `R5`). Items 3 through 6 were not started.
Browser tests are **not evidence** in this report: `@sparticuz/chromium` is not available
in this environment. Every browser-dependent test file was excluded from the final suite,
except the pure unit test `tests/browser-launcher.test.mjs`, which does not launch a browser.

## 1. Independent gap audit

Each reported gap was checked against the code and its tests. A false positive was not
changed merely to make the report look complete.

| Gap | Independent verdict | Action |
|---|---|---|
| D3 — self-KDM must never trust a server-supplied key for the sender's own id | **Real test gap.** The production branch was already correct in `c7b8fa4`, but no test proved it against a hostile server. | Added `ea4b3ec`; hostile-server test fails when the branch is disabled. |
| D4 — static import cycle through `session.js` / `peer-key-gate.js` / `peer-keys.js` / `api.js` / `auth.js` | **Real.** The new gate added a cycle that did not exist at base. | `c067b99`. The final static SCC set matches base. |
| D5 — group gate must fail closed without context/storage; harness helper | **Functional requirement already met.** The group gate throws on missing context, missing peer key, missing pin storage, and storage errors. No existing real-session group harness needed a shared helper; the only real-session harness is the hostile-server test, which creates its own context/store. Adding a helper solely to match the wording would be an unused abstraction. | No code change. DM-only `mayTryRetiredKey` fail-open is listed under “Found, not changed”. |
| D6 — group banner actions used direct listeners; no group safety-number view | **Real.** Rebuilding the group shell silently discarded the old handlers, and there was no group-specific safety-number panel. | `23857d9`: delegated `[data-action]` handling, one accept button and one safety-number link per changed member, plus a group panel that reuses `renderVerifyView()` with group-specific ids. |
| D8 — group caches must clear synchronously on lock; fetchBlob 401 path untested | **Real.** `lockIdentity()` used `import().then()`; the cache could still be populated when `wire:logout` was dispatched. The auth wiring from `b6c6f6b` was correct, but the second 401 path was not pinned. | `70c59fb` makes both clears synchronous; `2fea123` adds the `fetchBlob()` 401 test. |
| D9 — hard-coded `2000` in the controller | **False positive.** The only `2000` definitions are the shared client/server constants. The controller uses `dmStream.DM_MAX_CONTENT_CHARS`; the existing test asserts that and forbids a literal. | No code change. See `tests/dm-attachments/dm-stream-constants.test.mjs:58-68`. |
| D13 — v1-only APK sending to a min-2 recipient is not pinned | **Real test gap.** The server intentionally accepts a v1 envelope even when the recipient's floor is 2; only v2 is rejected. No production change was needed. | `6cbcd43` pins 200 + verbatim storage. A planted rejection makes it fail with 400. |
| D7 — DM check-then-use race | **Report only**, as previously decided. | No change; listed under “Found, not changed”. |

## 2. Changes in the owner-review commits

| Commit | Change |
|---|---|
| `70c59fb` | `public/js/crypto/identity-service.js`: static imports of `clearLocalWrapKeyCache` / `clearSenderKeyCache`; synchronous clears at lines 873-874. `tests/groups/lock-identity-clears-group-keys.test.mjs` now asserts the caches are empty immediately after `lockIdentity()`. |
| `c067b99` | `public/js/crypto/keys/session.js`: awaits `identity-service.js` and `peer-key-gate.js` at the point of use (lines 90, 273, 289, 382, 402), and `peer-keys.js` at lines 107 and 282. This removes the new static cycle while preserving the same key-derivation order. |
| `23857d9` | `public/js/chat/group-key-trust.js`: `acceptGroupPeerKey()` and `renderGroupVerifyView()` exports; `data-action` on the accept and verify controls. `public/js/chat/group.js`: group safety-number panel at line 748; delegated handler cases at lines 1064 and 1083. `public/js/chat/dm-key-trust.js`: parameterizable ids for `renderVerifyView()`. New `tests/groups/group-key-trust-ui.test.mjs`. |
| `ea4b3ec` | `tests/groups/group-kdm-key-pinning.test.mjs:196`: a hostile server publishes a different key for the sender's own id; the wrap must still use the local identity key. |
| `6cbcd43` | `tests/dm-v2-wire-server.test.mjs:155`: a v1 envelope to a min-2 recipient is accepted with 200 and stored verbatim. |
| `2fea123` | `tests/logout-locks-identity.test.mjs:116`: a 401 from `fetchBlob()` also locks and clears synchronously. |
| `59df178` | Regenerated `public/sw-manifest.js` after the public-file changes. |

The self-KDM production branch is `public/js/crypto/keys/peer-key-gate.js:148-156`: it returns
the local `ownPublicKey` and never calls the server for the sender's own id.

## 3. Mutation evidence

Every planted bug was restored after its test run. The working tree was clean before the
follow-up commits were made.

| Plant | Test command (target) | Observed failure | Log |
|---|---|---|---|
| D8: restore `identity-service.js` to `e25f89c` (async `import().then()` clears) | `node --experimental-test-module-mocks --env-file=tests/test.env --test tests/groups/lock-identity-clears-group-keys.test.mjs` | test 1 `expected: 1, actual: 0`; test 2 `expected: 2, actual: 0` | `%TEMP%\wire-mutation-d8-lock.log` |
| D8: restore `public/js/core/auth.js` to base `a2c58f2` (no lock/clear in logout) | `node --experimental-test-module-mocks --env-file=tests/test.env --test tests/logout-locks-identity.test.mjs` | all three wiring tests fail: `expected: true, actual: false` | `%TEMP%\wire-mutation-d8-auth.log` |
| D3: disable the self branch with `if (false && ownUserId != null && ...)` | `node ... --test --test-name-pattern="self-KDM ignores" tests/groups/group-kdm-key-pinning.test.mjs` | resolved key is the hostile server key, not the local key | `%TEMP%\wire-mutation-d3-self.log` |
| D6 banner: restore `group-key-trust.js` to `e25f89c` (direct listener, no `data-action`) | `node ... --test tests/groups/group-key-trust-ui.test.mjs` | test 1 `expected: 2, actual: 0`; later tests also lack the new exports | `%TEMP%\wire-mutation-d6-banner.log` |
| D6 shell: restore `group.js` to `e25f89c` (no delegated action cases) | same UI test | test 4 fails: the group shell is not wired to the actions | `%TEMP%\wire-mutation-d6-shell.log` |
| D13: make the server reject v1 for the min-2 recipient | `node ... --test --test-name-pattern="v1-only" tests/dm-v2-wire-server.test.mjs` | `expected: 200, actual: 400` | `%TEMP%\wire-mutation-d13-v1min2.log` |

The D8 auth plant deliberately used base `a2c58f2`, not `e25f89c`, because `e25f89c`
already contains the R3 fix.

## 4. Import-cycle evidence

A Tarjan SCC scan of static imports under `public/js` (same scanner for all three trees):

- Base `a2c58f2`: 3 cyclic SCCs; crypto SCC is `account-kdf / identity-service / api / auth`.
- Pre-fix `e25f89c`: 3 cyclic SCCs; the crypto SCC additionally contains
  `peer-key-gate / peer-keys / session`, i.e. the gate cycle.
- Final `59df178`: 3 cyclic SCCs; crypto SCC matches base exactly
  (`account-kdf / identity-service / api / auth`), with no gate and no session member.

Logs: `%TEMP%\wire-cycles-base-a2c58f2.log`, `%TEMP%\wire-cycles-premutation.log`,
`%TEMP%\wire-cycles-current.log`.

## 5. Full non-browser suite

Exclusions, applied identically to base and final:

- every test filename containing `browser`, except the pure unit test
  `tests/browser-launcher.test.mjs`, which does not launch Chromium;
- `tests/dm-v2-vanishing-row.test.mjs` (launches Chromium);
- `tests/acceptance-no-plaintext.test.mjs` (launches Chromium).

Command:

```powershell
$files = Get-ChildItem tests -Recurse -Filter *.test.mjs |
  Where-Object {
    ($_.Name -notmatch 'browser' -or $_.Name -eq 'browser-launcher.test.mjs') -and
    $_.Name -ne 'dm-v2-vanishing-row.test.mjs' -and
    $_.Name -ne 'acceptance-no-plaintext.test.mjs'
  } | ForEach-Object { $_.FullName }
node --experimental-test-module-mocks --env-file=tests/test.env --test @files
```

| Tree | Tests | Pass | Fail | Skipped | Log |
|---|---:|---:|---:|---:|---|
| Base `a2c58f2` | 725 | 721 | 1 | 3 | `%TEMP%\wire-full-nonbrowser-base-a2c58f2.log` |
| Final `59df178` | 751 | 748 | 0 | 3 | `%TEMP%\wire-full-nonbrowser-new4.log` |

The base failure was `E-4 (B)` in `tests/groups/group-signing-ensure.test.mjs:185`, a
process-killed-mid-POST timing test. It passed when rerun alone on the same base tree
(`%TEMP%\wire-base-e4-rerun.log`), so it is reported as a base flake, not as a regression
covered up by the new tree.

The three skips are the same on base and final and are explicitly labelled
“SUPERSEDED BY THE BROWSER” (DM v2 end-to-end, edit, and rotation). They are not counted
as browser evidence.

A discarded earlier run included `dm-v2-vanishing-row.test.mjs` and produced four
browser-only failures because Chromium is unavailable. It is not used as evidence.

## 6. Differential runs

A single temporary Node script booted the real `server.js` three times against a copy of
the fixture DB, called `GET /api/groups` without a token, registered one account, and read
the stored `dm_e2ee_min_version`:

```json
{"label":"default","env":{},"groups_status":401,"register_status":201,"dm_e2ee_min_version":2}
{"label":"env1","env":{"DM_E2EE_DEFAULT_MIN_VERSION":"1"},"groups_status":401,"register_status":201,"dm_e2ee_min_version":1}
{"label":"groups_off","env":{"GROUPS_ENABLED":"false"},"groups_status":404,"register_status":201,"dm_e2ee_min_version":2}
```

Log: `%TEMP%\wire-differential.log`.

This confirms the three modes independently: default registration floor is 2; the override
lowers new accounts to 1; `GROUPS_ENABLED=false` removes the group route (404) without
changing the DM registration floor.

## 7. Diff stats and wire format

From base `a2c58f2` to final code HEAD `59df178`:

- `database/`: one file, `database/seed.js` (+5/−3). No schema, migration, column default,
  or trigger change. No backfill was run; no real-user data was inspected or modified.
- `routes/`: **empty**.
- Wire-format modules (`config/dm-stream.js`, `public/js/crypto/messages/*`,
  `public/js/crypto/keys/key-derivation.js`): 4 files, +43/−19. The changes add the shared
  content cap, rejection-before-truncation checks, and the v2 envelope-size guard. No
  envelope field was added, removed, renamed, or re-encoded; the stored wire bytes are
  unchanged.

Full stat file: `%TEMP%\wire-diff-stats.txt`.

## 8. Browser-test status

Browser tests are **NOT evidence** for this work. `@sparticuz/chromium` is unavailable, so
none of the following was run to completion or used as proof:

- `*browser*.test.mjs` files (including DM v2 wire, CSP, group E2EE, and the XSS sweep);
- `tests/dm-v2-vanishing-row.test.mjs`;
- `tests/acceptance-no-plaintext.test.mjs`.

The non-browser jsdom tests (for example `tests/csp-xss-render.test.mjs`) are parser/DOM
tests only, not proof that a browser enforced CSP or completed a flow.

## 9. Found, not changed

| Location | Finding | Why not changed |
|---|---|---|
| `public/js/crypto/keys/peer-trust.js:460-463` | `mayTryRetiredKey()` returns `{ allowed: true }` when pin storage is unavailable. This is a DM retired-key fail-open. | Previously reported as D5 report-only. The new group gate fails closed at `peer-key-gate.js` before this path; changing DM behavior was outside this item and was not requested. |
| `public/js/chat/dm-key-trust.js:86-96` and `:121` | `currentPeerKey()` fetches the peer key, then `evaluatePeerKey()` evaluates a key fetched separately; a key change between those two awaits is a check-then-use race. | D7 is report-only. The group path resolves and pins in one gate call; the DM UI race remains a known follow-up. |
| `public/js/crypto/identity-service.js:873-874` | Group cache clears are synchronous, but the persisted unlock-key clear in `auth.js:140` remains fire-and-forget by design. | Pre-existing logout behavior; the sign-out button reloads the page, and changing the persistence path was not part of R3. |
| `c7b8fa4` | Item 1 is one commit and was not split into the smaller commits described by the owner. | Splitting it requires rewriting local history. No explicit permission to rewrite was given, so it was left intact. |

## 10. Reproducibility notes

- All test commands used `node --experimental-test-module-mocks --env-file=tests/test.env`.
- The base worktree is a detached worktree at `a2c58f2` with `node_modules` junctioned to
  the main worktree; it was used only for the base suite and isolated E-4 rerun.
- Mutation plants were made with exact text replacement or by copying the old file from
  git, then restored with `Copy-Item`; `git status` was clean before committing.
- Patch-series application and the final zip/SHA-256 are produced from the final commit;
  see the artifact directory (`%TEMP%\wire-owner-review\`) and `SHA256SUMS.txt`.
