# TEST ENGINE INVENTORY — Phase 0 of CROSS_PLATFORM_TEST_ROADMAP.md

Generated from `main` at `9b8cd09fecaac0599877fb55df543d67f3bc0b6c` on branch `test-engine-switch`.

## Summary

- Browser-launching test files found: **35**
- Agnostic (no Chromium-specific features): **30**
- Chromium-only (CDP or Chromium-only launch args): **5**
- Known env failure (AAC unsupported): `tests/dm-audio-attachment-browser.test.mjs` (counted among Chromium-only; expected to skip)

## Classification table

| File | Engine class | Reason | Evidence line(s) |
|---|---|---|---|
| tests/acceptance-no-plaintext.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `launchBrowser`, `newUserPage` from `./_acceptance-harness.mjs`; no `createCDPSession` |
| tests/acceptance-xss-sweep-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `launchBrowser`, `newUserPage`; no `createCDPSession` |
| tests/browser-launcher.test.mjs | agnostic | Unit-tests the launcher itself; no CDP | tests `launchBrowser()` opt-in behaviour |
| tests/crypto/sw-media-bundle-browser.test.mjs | agnostic | Uses only `launchBrowser()` / page API, no CDP | import `launchBrowser` from `../_acceptance-harness.mjs` |
| tests/csp-confirm-enforced-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/csp-handlers-enforced-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/dm-csp-handlers-enforced-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/dm-double-send-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-e2ee-default-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-key-trust-account-switch-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-key-trust-hostile-strings-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-own-messages-tab-switch-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-unencrypted-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-v2-attachments-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-v2-vanishing-row.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-v2-wire-browser-paths.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-v2-wire-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-verify-button.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-verify-ui-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/dm-voice-message-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/groups/group-confirm-in-dialog-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/groups/group-csp-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/groups/group-dialog-create-settled-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/groups/group-e2e-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/groups/group-hostile-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | defines local `launchBrowser()` wrapper; no `createCDPSession` |
| tests/groups/group-key-trust-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/identity-key-history-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/mobile-groups-tab-browser.test.mjs | agnostic | Uses only `launchBrowser()` / page API, no CDP | import `launchBrowser`; no `createCDPSession` |
| tests/peer-pin-upgrade-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/peer-trust-browser.test.mjs | agnostic | Uses only `newUserPage()` / page API, no CDP | import `newUserPage`; no `createCDPSession` |
| tests/_dm-ui-helpers.mjs | Chromium-only | `captureDownloads()` uses CDP `Browser.setDownloadBehavior` | line 266: `browser.target().createCDPSession()`; line 267: `cdp.send('Browser.setDownloadBehavior', ...)` |
| tests/dm-audio-attachment-browser.test.mjs | Chromium-only | Uses `captureDownloads()` which requires CDP | line 57 imports `captureDownloads`; line 277: `await captureDownloads(B.browser, downloads)`; known env failure (AAC unsupported) |
| tests/dm-verify-double-trigger-browser.test.mjs | Chromium-only | CDP `DOMDebugger.getEventListeners` for listener counting | line 203: `createCDPSession()`; lines 204-209: `Runtime.enable`, `Runtime.evaluate`, `DOMDebugger.getEventListeners` |
| tests/groups/group-attachment-browser.test.mjs | Chromium-only | Chromium-only launch args `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream` | line 645: `newUserPage({ extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })` |
| tests/media/sw-stream-browser.test.mjs | Chromium-only | CDP `Network.enable` and `ServiceWorker.enable`/`stopAllWorkers` | line 716: `createCDPSession()`; line 717: `cdp.send('Network.enable')`; lines 935-937: `ServiceWorker.enable`, `ServiceWorker.stopAllWorkers` |

## Helpers

| File | Engine class | Reason | Evidence line(s) |
|---|---|---|---|
| tests/_acceptance-harness.mjs | agnostic (launcher) | `launchBrowser()` is engine-neutral today (Chromium primary path); will be extended in Step 2 to support `WIRE_TEST_BROWSER` | line 323: `export async function launchBrowser(extraArgs = [])` |
| tests/_dm-ui-helpers.mjs | Chromium-only | `captureDownloads()` uses CDP; will get `skipUnlessChromium()` helper in Step 3 | line 266: `createCDPSession()` |

## Notes

- `tests/_dm-ui-helpers.mjs` exports `captureDownloads()` which is used by `tests/dm-audio-attachment-browser.test.mjs`. Both are Chromium-only due to CDP.
- `tests/dm-audio-attachment-browser.test.mjs` is a known env failure (AAC unsupported in @sparticuz/chromium); it is expected to be skipped regardless of engine.
- All 30 agnostic files use only `page.evaluate()`, `page.click()`, `page.type()`, `page.waitForSelector()`, etc. — all portable across engines.
- No file under `public/` or server code was inspected for changes (none are in scope for Step 1).
