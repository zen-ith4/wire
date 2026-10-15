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
| `tests/port-hygiene.test.mjs` | 8 |
| `tests/files-path-traversal.test.mjs` | 50 |
| `tests/safe-path-vectors.test.mjs` | 24 |
| `tests/identity-key-history.test.mjs` | 5 |
| `tests/identity-key-history-browser.test.mjs` | 1 |
| `tests/peer-trust.test.mjs` | 21 |
| `tests/peer-trust-browser.test.mjs` | 2 |
| `tests/acceptance-xss-sweep-browser.test.mjs` | +1 (case K) |

The suite is now **539 tests**. A Linux run is required before that is a
baseline.

### Peer key trust (Phase 2)

`public/js/crypto/keys/peer-trust.js` and `public/js/chat/dm-key-trust.js`:
TOFU pin, order-independent safety number, per-peer key-change alarm. Changes no
wire format — no HKDF info, no AAD, no envelope field. Signed pre-keys / XEdDSA
are explicitly NOT in this step; they need server storage and their own design
review, and §8.0 of `docs/e2ee-dm-hardening.md` records that.

The alarm blocks sending and **holds** messages rather than decrypting them
under the unrecognised key; accepting releases every held row through the normal
decrypt path, so accepting cannot lose a message. A retired key from the STEP A
archive is only tried if its fingerprint was already accepted on this device, or
if no pin exists yet (first contact).

**Two refinements the suite forced, both about the retired-key rule.** Neither
was reasoned out in advance; the v15 history test went red and said why
(`acceptedCount: 0`, `verdict: not-previously-accepted`):

1. **The pinned `current` key must stay usable.** A user who pinned Bob's key
   and only later saw him rotate has a pin whose `current` is exactly the key
   their history was sealed to. A rule consulting only `accepted` refuses the one
   key that can decrypt.
2. **First contact seeds the pin with the peer's DISCLOSED retired keys**,
   otherwise a user meeting a peer for the first time *after* a rotation is
   locked out of the history the archive exists to preserve.

Neither weakens the property the rule exists for: keys that appear **later**, out
of band of the pin — including a retired key arriving after an alarm — are still
refused.

Case K in the XSS sweep is **Linux-only**: the whole sweep file is blocked on
win32 (the hostile fixture filename cannot exist on NTFS), so that case has not
been executed here. The same hostile-username check IS executed, in
`tests/peer-trust-browser.test.mjs`.

### Identity-key archive (STEP A)

Rotation was never destroying the outgoing public key:
`identity_key_rotations` (`database/credentialSchema.js`) is written by
`me.controller.js` in the same transaction as the UPDATE that replaces
`identity_keys.public_key`, and it is append-only. What was missing is a read
path — the table had exactly two references in the repo, the `CREATE TABLE` and
the `INSERT`.

`services/identityKeyHistory.service.js` +
`GET /api/me/identity-key-history/:userId` are that read path. There is
deliberately **no** `identity_key_history` table: `fingerprint` is
`SHA-256(public_key)`, `created_at` is the `at` of the rotation that produced the
key and `retired_at` is the `at` of the one that retired it, so a second table
would be a second source of truth that can disagree with the first. The current
key stays where it is; history rows are never deleted while the account exists
(account deletion cascades — a privacy decision, not a storage one).

On the client, `messages/decrypt.js` retries a failed decrypt against the peer's
retired keys. It does not change what is encrypted or decrypted: the same AES-GCM
call, the same iv and ciphertext, the same `deriveSessionKeyFromPeer`, the same
`Wire-E2EE-v1` HKDF info. Only the choice of key widens, and only after the
current key has already failed, so the ordinary read path makes no extra request.

**What it cannot do, stated plainly:** it recovers history when the *peer*
rotated and you did not. It cannot recover history when *you* rotated —
`keys/key-storage.js` keeps exactly one keypair under `wire_identity_key` and
`saveIdentityKey()` overwrites it, so your pre-rotation private key is gone.
Keeping it would be key escrow, which is explicitly out of scope.

### What this tree measures on Windows, and what that does NOT prove

`npm test`, Windows + real local Chrome 155, `CHROMIUM_DIR` pointing at a local
shim (no `--single-process`, so a full Chromium binary):

| | tests | pass | fail | skipped | todo |
|---|---|---|---|---|---|
| full suite, via `npm test` | 539 | 529 | 1 | 8 | 1 |
| every file on its own, run 1 of 2 | 509 | 500 | 1 | 7 | 1 |
| every file on its own, run 2 of 2 | 509 | 500 | 1 | 7 | 1 |
| `tests/groups` | 175 | 174 | 1 | 0 | 0 |
| `tests/credentials` | 87 | 87 | 0 | 0 | 0 |
| `tests/dm-attachments` | 60 | 60 | 0 | 0 | 0 |
| `tests/files-path-traversal` | 50 | 50 | 0 | 0 | 0 |
| `tests/safe-path-vectors` | 24 | 24 | 0 | 0 | 0 |
| `tests/crypto` | 9 | 9 | 0 | 0 | 0 |
| `tests/port-hygiene` | 8 | 8 | 0 | 0 | 0 |
| `tests/identity-key-history` | 5 | 5 | 0 | 0 | 0 |
| `tests/identity-key-history-browser` | 1 | 1 | 0 | 0 | 0 |

The two `npm test` rows above describe different trees: the per-file numbers
were measured before STEP A, the full-suite number after STEP A and Phase 2. The
per-file split was not re-run for STEP A or Phase 2; the files added by those two
steps were each run on their own instead.

The skip count moved from 7 to 8 because Phase 2 added a case to the XSS sweep,
which is blocked wholesale on win32 — so a test that passes on Linux and is
skipped here added a skip. That is the correct direction, not a regression.

All 74 files were run individually as well as through the runner, twice each:
**every one of the 74 produced byte-identical counts on both runs.** Summing the
per-file runs gives the same total as `npm test`, which is expected —
`node --test` already isolates each file in its own process — and is the
cross-check that the split-out numbers are the suite's numbers.

The single failure is `group-e2e-browser` - see "Windows-only behaviour" below.

### One environment fact this table depends on

`node_modules/better-sqlite3` had **no compiled binding** on the machine these
numbers came from: no `better_sqlite3.node` anywhere and no C++ toolchain, so
`config/database.js` threw on require, `startRealServer()` could not start, and
every server-backed test either failed or quietly self-skipped through its
`BLOCKED:` path. `npm rebuild better-sqlite3` fetched the prebuilt binary
(`prebuild-install`) and that is what made a real server start. **If a run
reports a suspiciously clean pass rate, check that the binding exists before
believing the number.**

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
  The page lifecycle is `frozen`; the application is not looping. Measured:

  | evidence | result |
  |---|---|
  | `Runtime.evaluate` (both `awaitPromise` settings) | times out |
  | `Debugger.paused` | never fires — the renderer is not blocked on JS |
  | Tracing | zero main-thread events |
  | `Page.setWebLifecycleState {state:"active"}` | the same evaluate returns immediately |
  | a second tab in the same profile | stays responsive |
  | the same test on `@sparticuz/chromium` | passes |

  Chrome is freezing the page; the app is not hanging. Disabling that does
  **not** help: `--disable-features=FreezeEnabledTime,FreezeLazyLoading,FreezeAllExceptActive`
  plus `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`
  and `--disable-backgrounding-occluded-windows` still failed after 200 s with
  `Runtime.callFunctionOn timed out`. The flags were verified to reach the
  binary — Puppeteer folds the three `Freeze*` names into its own
  `--disable-features` list, and `chrome://version` shows all four switches — so
  the negative result is a real one. Those flags are **not** in the tree: a
  guess that does not fix the thing is worse than the failure it hides.
- **`lockIdentity()` no longer sleeps.** It used to assert after a fixed
  `setTimeout(25)`, which was a guess about machine speed and produced
  `actual: 0`/`1` against `expected: 2` on Windows under load. It now polls the
  postcondition with a 5 s bound. 30 runs idle: 30 pass. 30 runs with 8 busy
  loops saturating every logical CPU: 30 pass. The bound still fails when the
  condition is unreachable.
- **`lockIdentity()` no longer sleeps** — see the entry above.
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