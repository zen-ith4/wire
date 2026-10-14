# Test baseline — wire-final-9

The numbers any change should be measured against. If a run does not reproduce
them, the difference is the finding, not the noise.

## Verified environment

Linux sandbox, 2 cores, **the real `@sparticuz/chromium`** — the default that
`tests/_acceptance-harness.mjs` `launchBrowser()` loads from
`CHROMIUM_DIR=/tmp/browser-check`. That package runs Chromium with
`--single-process --no-zygote`, which is the configuration the harness is built
for; see `BROWSER_TEST_ISOLATION.md` §1.

## Full suite

| | tests | pass | fail | skipped | todo |
|---|---|---|---|---|---|
| run 1 | 426 | 422 | **0** | 2 | 2 |
| run 2 | 426 | 422 | **0** | 2 | 2 |

Identical across both runs.

## The two skips and the two todos

- **skip** — "register rejected the hostile username": `/api/auth/register` now
  rejects it, so the rendering half of that check has nothing to render.
- **skip** — `upgrade: DB created by the base code`: `BASE_TAG` is not present
  in that checkout.
- **todo** — `B username (FINDING)`: `registerUser()` still only checks
  non-empty; `isValidUsername()` runs in `createUser()` only. Deliberate.
- **todo** — the DM delete button under enforced CSP: `dm.js` still uses an
  inline `onclick` there.

## Files run alone, 0 failures each

`acceptance-no-plaintext` 8/8 · `acceptance-xss-sweep-browser` 5 pass, 1 skip,
1 todo · `csp-confirm-enforced-browser` 6 pass, 1 todo ·
`dm-csp-handlers-enforced-browser` · `credentials/f12-browser-login` ·
`groups/group-confirm-in-dialog-browser` · `groups/group-e2e-browser` 1/1 ·
`groups/group-signing-ensure` 6/6 · `groups/group-signing-keys` 24/24 ·
`groups/group-hardening-f7-version-gate` 3/3.

## Static checks

- `node scripts/build-sw-manifest.mjs --check` → `sw-manifest.js is current
  (version e7aa8fa0e153, 171 files)`
- `tests/sw-manifest.test.mjs` → 10/10
- `public/` text files with CR → 0 of 158

The counts above were measured on a tree whose manifest was `e49d5776c950`. The
only source change since then is a comment in `public/js/chat/group.js`, which
still rehashes the manifest. Re-run to confirm the counts; nothing else moved.

## Archive

`wire-final-10.zip` — 10,735,903 bytes,
`sha256 b3636b85455f25b9c7e7abb12b842ca5698c0a2ee0e250e2e7a32f010b5a61c3`.

## Not covered by this baseline

**`tests/groups/group-e2e-browser.test.mjs` passes here and fails on Windows.**
It hangs on a full Chrome 155 binary — the renderer of alice's first tab stops
responding right after alice's second tab, from the same profile, sends a
message. Last known step: `alice.click('#group-input')`. Root cause unknown.
Do not read that Windows failure as a product defect until it reproduces
somewhere other than a full-Chromium build.

The `acceptance-xss-sweep-browser` file is skipped wholesale on Windows by an
explicit `process.platform === 'win32'` guard: the hostile fixture file name
contains `"`, `<` and `>`, which NTFS rejects. Its coverage exists only on Linux
and CI.