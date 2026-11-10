# Working State — summary of work done

This file consolidates everything completed across this session. Nothing here is
committed or pushed yet — it's all uncommitted working-tree changes.

## 1. CORS hardening (server.js + middleware/cors.js)

**Problem.** `server.js` mounted `cors({ origin: true, credentials: true })`, but
the app has **no cookie usage anywhere**: HTTP auth is purely the
`Authorization: Bearer <session token>` header (`middleware/authenticate.js`), and
Socket.IO authenticates on the handshake via `socket.handshake.auth.token`
(`config/socket.js`). No route sends `Set-Cookie`; there is no `cookie-parser` or
`express-session` dependency. So `credentials: true` was dead weight and let
credentialed requests through even though no cookies are ever set.

**Change.** Extracted the CORS options into a single source of truth and dropped
credentials:

- `middleware/cors.js` (new): exports `corsMiddleware = cors({ origin: true, credentials: false })`, documented in-file.
- `server.js`: imports and applies `corsMiddleware` instead of the inline `cors({...})`. No other logic changed.

**Why reflect (`origin: true`) rather than an allowlist.** Reflecting is correct
for both supported clients without a fixed allowlist: Capacitor uses a fixed
origin (`https://localhost`), and Electron loads the page from whatever server the
user chose (`electron-client/main.js`), so its Origin can be any host:port — a
static allowlist couldn't cover it anyway.

**Verification.** `tests/cors-config.test.mjs` (5 tests, all pass): Capacitor +
arbitrary-Electron origins each return the reflected `Access-Control-Allow-Origin`
on normal and preflight (`OPTIONS`) requests, and neither emits an
`Access-Control-Allow-Credentials` header. The full suite was compared baseline vs.
branch: fail count identical (88 vs 88, same test names). Those 88 are all
browser/CDP tests requiring `@sparticuz/chromium` (not installed here — a
pre-existing environmental limitation). Zero regressions.

## 2. Flaky browser-test fix (scripts/run-tests.mjs)

**Problem.** `tests/groups/group-attachment-browser.test.mjs` test 3 ("a hostile
relay serves file A under message B", line 276) passed alone (~48s) but failed
when run together with `tests/groups/group-e2e-browser.test.mjs`.

**Root cause.** `node --test` runs each **test file in its own child process, and
those processes run in parallel** (confirmed: a 4s + 6s two-file run finished in
~6.1s wall time, not 10s). Both heavy browser-test files launch the project's
single `@sparticuz/chromium` binary, so running them together spawns that shared
binary simultaneously → races with `ETXTBSY` ("executable file busy"), and their
combined Chromium load exhausts memory/CPU. The victim is timing-dependent — in my
reproduction test 1 failed with `newUserPage: no Chromium (spawn ETXTBSY)`; the
user saw test 3 fail. Either way it's the same root cause, and it has nothing to do
with the assertions inside test 3 (which are correct and pass on their own).

**Change.** Added `--test-concurrency=1` to the `node --test` invocation in
`scripts/run-tests.mjs` so test files run **sequentially**. Non-browser tests are
far faster than a browser launch, so serializing costs little.

**Verification.** Parallel run before: ETXTBSY races + a flaky failure. After:
sequential runs (both orders) pass 12/12 with 0 ETXTBSY. No assertion weakened —
only run ordering changed; test 3 passes in both orders.

## 3. Docs reorganization (partial — awaiting one decision)

**Goal.** Move every loose `.md` directly under `docs/` into `docs/archive/`, while
leaving `.md` files already inside subfolders where they are.

**Done.** Moved 24 non-colliding top-level `.md` files into `docs/archive/` (via
`git mv` for tracked files; the new summary file via plain `mv`). All `.md` files
already in subfolders (`docs/agent-tasks/` ×14, `docs/ci/`, `docs/plans/`,
`docs/for later/`) were left untouched. Non-`.md` entries and folders are untouched.

**Open decision — 4 name collisions.** Four top-level `.md` files share a basename
with an existing file in `docs/archive/`. The archive copies are **newer** (updated
2026-11-10) and each has an added `"ARCHIVED - historical record"` banner plus audit
notes (a superset of the bare top-level originals):

| Top-level (bare original) | Archive copy (newer, banner-edited) |
|---|---|
| `csp-and-dm-work-notes.md` (9,965 B) | `csp-and-dm-work-notes.md` (10,455 B) |
| `PHASE_B_PLAN.md` (39,686 B) | `PHASE_B_PLAN.md` (40,362 B) |
| `WIRE_PHASE0_ITEM1_ITEM2.md` (22,554 B) | `WIRE_PHASE0_ITEM1_ITEM2.md` (22,889 B) |
| `WIRE_PHASE0_OWNER_REVIEW.md` (13,455 B) | `WIRE_PHASE0_OWNER_REVIEW.md` (13,790 B) |

Moving a top-level file into `docs/archive/` would overwrite its newer,
banner-edited counterpart and lose that content. **Pending your decision** on how
to handle these 4 (keep the archive version and drop the bare duplicate; rename to
preserve both; or overwrite).
