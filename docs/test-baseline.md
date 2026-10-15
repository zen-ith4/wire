# Test baseline — `wire-final-12.zip`

Two numbers matter here, and they are from different trees. Keep them apart.

## 1. Linux-verified baseline (the real @sparticuz/chromium)

Measured on the Linux sandbox with the **real `@sparticuz/chromium`**, the
default `launchBrowser()` loads from `CHROMIUM_DIR=/tmp/browser-check`. That
package runs Chromium with `--single-process --no-zygote`; see
`BROWSER_TEST_ISOLATION.md` §1 for why that dictates how accounts are opened.

| tree | tests | pass | fail | skipped | todo |
|---|---|---|---|---|---|
| `wire-final-8` run 1 | 426 | 422 | **0** | 2 | 2 |
| `wire-final-8` run 2 | 426 | 422 | **0** | 2 | 2 |

Identical across both runs. This is the baseline any change is measured
against.

### The two skips

- **test 12** — "register rejected the hostile username". `/api/auth/register`
  now rejects the payload, so the rendering half of that check has nothing to
  render.
- **test 204** — "upgrade: DB created by the base code". `BASE_TAG` is not
  present in that checkout.

### The two todos

- **"B username (FINDING)"** — `registerUser()` still only checks non-empty;
  `isValidUsername()` runs in `createUser()` only. Deliberate, documented.
- **DM delete button under enforced CSP** — `dm.js` still uses an inline
  `onclick` there. Deliberate.

### Static checks at that tree

- `node scripts/build-sw-manifest.mjs --check` → `is current`
- `tests/sw-manifest.test.mjs` → 10/10
- `public/` text files containing CR → 0 of 158

## 2. Tests added since that baseline (not yet Linux-verified)

Everything below landed on `wire-final-8` after the 426/422/0 run above, so the
test count is now higher and the Linux numbers above do not yet include it.

| addition | tests |
|---|---|
| `tests/groups/group-kdm-recipient-scope.test.mjs` | 1 |
| `tests/port-hygiene.test.mjs` | 6 |

The suite is now **433 tests**. A Linux run is required before that is a
baseline.

### What this tree measures on Windows, and what that does NOT prove

`npm test`, Windows + real local Chrome 155, `CHROMIUM_DIR` pointing at a local
shim (no `--single-process`, so a full Chromium binary):

| | tests | pass | fail | skipped | todo |
|---|---|---|---|---|---|
| full suite | 433 | 424 | 1 | 7 | 1 |
| `tests/groups` | 175 | 174 | 1 | 0 | 0 |
| `tests/dm-attachments` | 60 | 60 | 0 | 0 | 0 |
| `tests/crypto` | 9 | 9 | 0 | 0 | 0 |
| `tests/credentials` | 87 | 87 | 0 | 0 | 0 |
| `tests/port-hygiene` | 6 | 6 | 0 | 0 | 0 |

The single failure is `group-e2e-browser` - see "Windows-only behaviour" below.

**The skip and todo counts differ from the Linux run for a reason:** on Windows
the `xss-sweep` guard skips its 7 tests wholesale, so one of the two todos
(the "B username (FINDING)" inside that file) never runs. That is 7 skipped /
1 todo here against 2 skipped / 2 todo on Linux, for the same tree.

## Windows-only behaviour — do not read these as product defects

- **`acceptance-xss-sweep-browser` is skipped wholesale on win32.** The hostile
  fixture file name contains `"`, `<` and `>`, which NTFS rejects, so
  `writeFileSync` fails with ENOENT before the application is involved. The
  hostile string is deliberately untouched. **Its coverage exists only on Linux
  and CI.**
- **`tests/groups/group-e2e-browser.test.mjs` passes on Linux and fails on
  Windows.** It hangs on a full Chrome 155 binary — the renderer of alice's
  first tab stops responding right after alice's second tab, from the same
  profile, sends a message. Last known step: `alice.click('#group-input')`.
  Root cause unknown.
- **`lockIdentity()` is a 25 ms timing flake on Windows.**
  `tests/groups/lock-identity-clears-group-keys.test.mjs:64` calls
  `lockIdentity()` twice and waits `settle()` = `setTimeout(25)` before
  asserting both caches were cleared twice. On Windows under load that is
  sometimes not enough; observed `actual: 0` and `actual: 1` against
  `expected: 2`. Passes alone.
- **`fetch` blocked ports.** `tests/_port.mjs` holds undici's `badPorts`, copied
  verbatim from `node_modules/undici/lib/web/fetch/constants.js` lines 14-21
  (undici 8.10.2) and cited there. `tests/port-hygiene.test.mjs` (8 tests) proves
  the copy is exact, that every entry an unprivileged process can bind really is
  refused by `fetch()`, that `pickFreePort()`'s own window contains only 5060 and
  5061, and that the retry actually skips a refused port. A server on one of
  those ports starts fine and then every `fetch()` fails with `bad port`.

## Archive

Built with `git add -A` → `git write-tree` → `git archive --format=zip
--prefix=<name>/` → `git restore --staged .`: no commit is created and the
working tree is left untouched. No `.git`, no `node_modules`, every text file
LF.

The size and sha256 are deliberately **not** recorded here — they live in the
committed tree, so writing them into this file would change them. Read them off
the published archive and check them against the release notes.

Content invariants that must hold for any archive of this tree:

- no `.git` entries, no `node_modules`
- no text file contains CR
- `node scripts/build-sw-manifest.mjs --check` reports `is current`