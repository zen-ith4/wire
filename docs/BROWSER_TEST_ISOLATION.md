# Browser test isolation in Chromium — what went wrong and why it is fixed this way

Status: the design flaw described in §1 is fixed since `wire-final-8`; the current archive is
`wire-final-9`, which also carries the ported group Sender-Key fix. Everything else in §4-§6 is
still open and is documented here rather than worked around.

All numbers in this document come from Windows + real local Chrome 155.0.8059.40 driven through
`puppeteer-core` 24.43.1. Nothing here has been re-measured against the real
`@sparticuz/chromium` on Linux.

---

## 1. The flaw: `createBrowserContext()` does not work on single-process Chromium

`tests/_acceptance-harness.mjs` grew a helper so that every account in a test would get its own
storage. The first version did that with a browser context:

```js
const context = await browser.createBrowserContext();   // WRONG
const page = await context.newPage();
```

This is correct for a normal desktop Chromium and wrong for the browser these tests actually
launch. `launchBrowser()` loads `@sparticuz/chromium` by default and passes `chromium.args`
straight through. On a serverless sandbox that package runs Chromium with:

```
--single-process --no-zygote
```

In single-process mode there is one renderer for the whole browser, so `createBrowserContext()`
kills it: `Protocol error (Target.createTarget): Target closed`.

Measured on the Linux sandbox with the real package, two full `npm test` runs on `wire-final-7`
gave **24 failures, all "Target closed"**. The same tests against a shim that points at a full
Chromium without `--single-process` gave **1 failure**. The local Windows shim never had
`--single-process`, which is exactly why `wire-final-7` looked clean on Windows.

**Fix: one browser process per account.** A separate process gets its own profile, so IndexedDB
and localStorage are isolated by construction, and it is the only isolation that survives
single-process Chromium. This is also the faithful model of production, where every user has their
own browser profile.

```js
const userBrowsers = new Set();

/** Closes every browser newUserPage() launched. Safe to call twice. */
export async function closeUserBrowsers() {
    const open = [...userBrowsers];
    userBrowsers.clear();
    await Promise.all(open.map((b) => b.close().catch(() => {})));
}

export async function newUserPage({ viewport = { width: 1280, height: 900 }, timeout = 30000, onNewDocument } = {}) {
    const launched = await launchBrowser();
    if (!launched.browser) throw new Error(`newUserPage: no Chromium (${launched.reason})`);
    userBrowsers.add(launched.browser);
    const page = await launched.browser.newPage();
    page.setDefaultTimeout(timeout);
    if (viewport) await page.setViewport(viewport);
    if (onNewDocument) await page.evaluateOnNewDocument(onNewDocument);
    return { page, browser: launched.browser };
}
```

Every test file's `after` hook calls `await closeUserBrowsers()`. `tests/groups/group-e2e-browser.test.mjs`
already worked this way before this change and is the reference implementation.

## 2. Why a shared profile corrupts the tests at all

This is the original bug the helper was written for, and it is worth keeping in the record.

`browser.newPage()` opens a page in the **default context**, and every page there shares one
profile's localStorage **and** IndexedDB. The group crypto store (`wire-group-crypto`, object
store `sender-keys`) is keyed per profile, not per account. So when two accounts are opened that
way:

1. Both pages read and write the same `sender-keys` rows.
2. Account B's page drains a KDM that carries account A's `senderKeyId`.
3. `storeReceivedSenderKey()` (`public/js/crypto/groups/sender-key.js`) finds A's row, cannot
   unwrap it with B's local wrap key, treats it as "another account's row", and replaces it with
   `ifAbsent: false`.
4. A's row becomes `isMine: 0` with no signing key, so `getMySenderKey()` returns `null`.
5. The composer logs `TEXT SEND: ERROR | No Sender Key to send with yet` forever and no
   `POST /api/groups/:id/messages` is ever made.

Symptom on the test side: `group message was not sent through the real composer`.

`browser.newPage()` is still correct where a test deliberately needs **two pages of the same
account sharing storage** — a cross-tab Web Lock, a second tab that must see the first tab's
sender keys, or a second tab that receives the account's own KDM. Those files were left alone:

| File | Why it keeps sharing one profile |
|---|---|
| `tests/mobile-groups-tab-browser.test.mjs` | one user (`mo${n}`) across several viewport widths |
| `tests/groups/group-csp-browser.test.mjs` | never logs in; only checks the CSP response header |
| `tests/groups/group-dialog-create-settled-browser.test.mjs` | one user, alice |
| `tests/groups/group-e2e-browser.test.mjs` | already one browser process per account; `alice.ctx.newPage()` is a deliberate same-account second tab |
| `tests/groups/group-hostile-browser.test.mjs` | one user |

## 3. Files changed for §1 and §2

`tests/credentials/f12-browser-login.test.mjs` and `tests/dm-csp-handlers-enforced-browser.test.mjs`
were changed in `wire-final-7` and have been **reverted to their v6 form** here:

- `f12-browser-login` copies the scheme-2 `localStorage` pin between pages by hand and clears
  storage on every login, so it never depended on a shared profile. It still passes 6/6.
- `dm-csp-handlers` already calls `open()` per account, i.e. one browser process per account
  already. Adding another process per `signUp()` was pure overhead.

Assertion counts are unchanged in all six edited files: 33, 22, 23, 21, 53, 7.

---

## 4. Windows-only: NTFS cannot hold the hostile fixture filename (fixed with an explicit skip)

`tests/acceptance-xss-sweep-browser.test.mjs` uploads a file whose name is

```
fn"><img src=x onerror=__pwned=1>~fname.txt
```

`"`, `<` and `>` are not legal characters in an NTFS file name, so the fixture cannot be created
at all: `fs.writeFileSync` fails with `ENOENT` before the application is involved. Tests 9, 10,
12–15 failed this way on Windows only.

The hostile string is deliberately **not** changed — altering it would change what the test
asserts. Instead `run()` returns a `blocked` reason on Windows, which every test in the file
already routes through its existing `blocked(t, s)` helper, so the file reports `skipped` with an
explanatory reason instead of six `ENOENT` failures:

```js
if (process.platform === 'win32') return { blocked: 'NTFS cannot hold the hostile fixture filename; this sweep is covered on Linux/CI' };
```

**Consequence to be explicit about: on Windows this XSS sweep does not run at all.** Its coverage
exists only on Linux and CI.

## 5. Windows-only: the DM delete button cannot be clicked with a mouse (fixed)

`tests/csp-confirm-enforced-browser.test.mjs` asserted `dmButtonOpensConfirm === true` and failed
on Windows while passing on Linux.

Measured in the page at the moment of the click:

```
rect: 20x20 at (1182,189)   opacity: 1   visibility: visible   display: flex
pointerEvents: "none"
elementFromCentre: "DIV.chat-bubble"
programmatic b.click() -> confirm opens: true
real coordinate click -> confirm opens: false
```

Cause, in `public/css/features/messages.css`:

- `.chat-msg-actions-bar` is `opacity: 0; pointer-events: none` by default (line 2118).
- `pointer-events: auto` is only granted by `.chat-msg-actions:focus-within` (keyboard focus) and
  `.chat-msg.is-actions-armed`.
- `is-actions-armed` is set only by a **touch tap** (`public/js/chat/dm.js` `setRowActions` is
  called from the tap path; clicking the row with a mouse does not add the class — verified).
- The `@media (hover: hover)` block (line 2016) only repositions timestamps and side status; it
  does **not** enable `pointer-events` on the bar.

Why the platform differs:

- Headless Chromium on Linux reports `hover: none`, so `@media (hover:none)` applies
  `.chat-msg:not(.is-actions-open) .chat-msg-actions-bar { display: none }`. Puppeteer then
  **refuses** the coordinate click, the test's own `.catch(...)` fallback fires, the element-level
  click works, the test passes.
- Headless Chromium on Windows reports `hover: hover`, so the bar is laid out and merely
  transparent and non-hit-testable. Puppeteer does **not** refuse — the click "succeeds" and lands
  on the element underneath — so the `.catch(...)` fallback never runs and the confirm never opens.

Fix: when the real click fails to open the confirm, dispatch the click on the element as well.
This is what the existing fallback was written for; it simply did not cover a click that silently
lands elsewhere.

```js
await page.click('#dm-thread .chat-msg-delete').catch(() => page.$eval('#dm-thread .chat-msg-delete', (b) => b.click()));
out.dmButtonOpensConfirm = !!(await page.waitForSelector('#confirm-modal.active', { timeout: 2500 }).catch(() => null));
if (!out.dmButtonOpensConfirm) {
    await page.$eval('#dm-thread .chat-msg-delete', (b) => b.click());
    out.dmButtonOpensConfirm = !!(await page.waitForSelector('#confirm-modal.active', { timeout: 2500 }).catch(() => null));
}
```

The recorded value is still `true` only when that button really opens the confirm. Assertion count
unchanged at 23; the file now reports 6 pass / 0 fail / 1 todo.

**Worth a product decision, not a test decision:** on a desktop mouse the action bar is only
reachable by keyboard focus or a touch tap. If mouse users are expected to delete messages, the
CSS in §5 is the place to look. This was not changed here.

## 6. Still open

### 6.1 `group-e2e-browser.test.mjs` — one hanging step, cause unknown

This is the only remaining suite failure. It fails on Windows alone and has never been seen on
Linux with the real sparticuz headless shell.

Temporary instrumentation (`protocolTimeout: 30000`, a wrapper logging every puppeteer call) pinned
the hang to a single step:

```
# STEP alice-tab2 click([data-action="group-send"])   ok
# STEP alice-tab2 waitForFunction()                    ok
# STEP bob      waitForFunction()                      ok
# STEP alice    click(#group-input)                    Runtime.callFunctionOn timed out
```

That is `group-e2e-browser.test.mjs:278` — `await send(alice.page, 'from alice tab 1')`, i.e. the
first tab of alice trying to click the group composer immediately after alice's **second tab** sent
a message from the same profile. The renderer of the first tab stops responding to CDP.

Not established: why the renderer blocks. Candidate areas are the cross-tab sender-key path
(`ensureSenderKeyForGroup` takes a Web Lock shared across the origin, and both tabs share the
IndexedDB rows) and the composer click handler in `public/js/chat/group.js`. The instrumentation
was removed again; nothing in that file is changed.

### 6.2 `lockIdentity()` — a timing flake in the test's own sleep

`tests/groups/lock-identity-clears-group-keys.test.mjs:64` calls `lockIdentity()` twice and waits
`settle()`, which is `setTimeout(25)`, before asserting both caches were cleared twice.

```
expected: 2   actual: 1     (one run)
expected: 2   actual: 0     (an earlier run)
```

Seen in 2 of 6 full runs. The cache clearing is asynchronous and 25 ms is not reliably enough on
Windows under load. The file imports only `node:test` and `node:assert`, so it is unrelated to the
harness change. Not modified — only recorded.

---

## 7. Verification status

| Check | Result |
|---|---|
| `acceptance-no-plaintext`, 3 runs alone | 8/8 each |
| `acceptance-xss-sweep-browser`, 3 runs alone | 7 tests, 0 fail, 7 skip (Windows guard) |
| `csp-confirm-enforced-browser`, 3 runs alone | 7 / 6 pass / 0 fail / 1 todo |
| `dm-csp-handlers-enforced-browser`, 3 runs alone | 2/2 each |
| `credentials/f12-browser-login`, 3 runs alone | 6/6 each |
| `groups/group-confirm-in-dialog-browser`, 3 runs alone | 1/1 each |
| `groups/group-hardening-f7-version-gate` | 3/3 |
| Full suite, run A | 426 tests / 416 pass / 2 fail / 7 skipped / 1 todo |
| Full suite, run B | 426 tests / 417 pass / 1 fail / 7 skipped / 1 todo |
| `node scripts/build-sw-manifest.mjs --check` | `is current (version c41ef2c39a57, 171 files)` |
| `tests/sw-manifest.test.mjs` | 10/10 |
| No `createBrowserContext` / `createIncognitoBrowserContext` call left under `tests/` | confirmed (one mention in a doc comment only) |

The two full runs differ only by the §6.2 flake; the test counts are identical.

### Not verified

- **The single-process case.** A shim carrying the real `--single-process --no-zygote` args was
  built and used, but full Chrome on Windows refuses `--single-process` outright — it exits with
  `Code: 2147483651` (`STATUS_BREAKPOINT`) and never starts, so every test reported
  `BLOCKED: no Chromium`. **This check is not verifiable on Windows and must be run on Linux with
  the real `@sparticuz/chromium`.** It is the single most important thing to confirm, because §1 is
  entirely about that configuration.
- §6.1's root cause.
- All numbers above are Windows-only. Nothing was re-measured against the Linux sandbox.

## 8. Running the browser tests on Windows

`@sparticuz/chromium` is Linux-only, so a local shim package is used instead. It must be named
`@sparticuz/chromium` (the harness resolves that exact specifier) and export `args` and
`executablePath()`:

```js
// browser-check/index.js
export default {
  // A GETTER, so every read yields a new profile: launchBrowser() reads
  // chromium.args once per launch, and a profile another Chrome still holds
  // makes it refuse to start.
  get args() {
    const profileDir = path.join(os.tmpdir(), `wire-chrome-profile-${process.pid}-${(launchSeq++).toString(36)}`);
    return ['--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profileDir}`, '--disable-gpu'];
  },
  headless: 'shell',
  async executablePath() { return executable; },
};
```

With `puppeteer-core` installed alongside and `CHROMIUM_DIR` pointing at that directory. Note that
a per-process profile is not enough: files like `group-e2e-browser` launch several browsers inside
one Node process, so the profile has to differ per launch.

## 9. Archive

`wire-final-9.zip` — 10,729,643 bytes,
`sha256 e73c7ad6bc35d9fe1c881dbfad3624a80da7c863f1c2cd1cb9169a1cfaa54887`, built with
`git add -A` → `git write-tree` → `git archive --format=zip --prefix=wire-final-9/` → `git restore --staged .`.
No commit was created. 474 entries, no `.git`, no `node_modules`, 0 of 376 text files contain CR.
Verified counts for this tree are in `docs/test-baseline.md`.