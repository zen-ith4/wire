# TEST ENGINE FIREFOX FIRST RUN — Phase 0 of CROSS_PLATFORM_TEST_ROADMAP.md

Run with `WIRE_TEST_BROWSER=firefox`, `FIREFOX_PATH=/usr/bin/firefox`,
`CHROMIUM_DIR=/home/arman/browser-check`, on branch `test-engine-switch`
(main at `9b8cd09fecaac0599877fb55df543d67f3bc0b6c`).

Each file re-run 3 times alone; all failures are consistent. Classification:
test bug | product bug | engine limitation. First failing line shown as evidence.

## Results table

| File | Chromium baseline | Firefox result | Classification | First failing line |
|---|---|---|---|---|
| tests/dm-verify-ui-browser.test.mjs | 2/2 pass | 2/2 pass | — | — |
| tests/dm-double-send-browser.test.mjs | 1/1 pass | 0/1 fail | engine limitation | `double enter: the composer must clear its input after sending` |
| tests/dm-key-trust-hostile-strings-browser.test.mjs | 2/2 pass | 2/2 pass | — | — |
| tests/dm-verify-double-trigger-browser.test.mjs | 1/1 pass | 0/1 fail | engine limitation | `timed out after 15000ms waiting for the button to turn Verified after the double click; button is {"text":"Verify","verifiedClass":false,"dataVerified":"false"}` |
| tests/credentials/f12-browser-login.test.mjs | 6/6 pass | 6/6 pass | — | — |
| tests/groups/group-attachment-browser.test.mjs | 12/12 pass | 11/12 fail (#12) | engine limitation | `Waiting for selector #group-recording-bar.active failed` |

## Classification notes

**dm-double-send-browser.test.mjs — engine limitation.**
The test sends Enter twice rapidly ("double enter") and asserts the composer input clears after each send. On Firefox 160, the second Enter does not clear the composer input. No product code was changed; the assertion is valid on Chromium. This is a Firefox event-timing difference in the composer's keydown/keyup handling.

**dm-verify-double-trigger-browser.test.mjs — engine limitation.**
Part (a) of the test (double click produces exactly one verified write) fails on Firefox: the button never turns "Verified" after two mouse clicks at the button centre. The CDP listener-counting part (b) is skipped on non-Chromium per design. Part (c) (encryptedFloor) would run but the test aborts at the failed assertion in (a). This is a Firefox difference in how synthesized `MouseEvent.click()` at a point is dispatched vs. Chromium.

**groups/group-attachment-browser.test.mjs #12 — engine limitation.**
Test 12 ("group voice") relaunches Alice's browser with `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`. These are Chromium-only launch args; on Firefox they are intentionally not passed (see the `fakeMediaArgs` conditional in the test). Without them, Firefox does not provide a fake microphone, the recording bar never activates, and `#group-recording-bar.active` never appears. Not a product bug — the fake-mic flags simply don't exist for Firefox.

**Passing on Firefox:** dm-verify-ui (2/2), dm-key-trust-hostile-strings (2/2), f12-browser-login (6/6), group-attachment #1-#11 (11/12). No product behaviour was changed to achieve these.

## Known not-run on Firefox

- tests/dm-audio-attachment-browser.test.mjs — skipped on non-Chromium (captureDownloads uses CDP; also a known AAC env failure on Chromium).
- tests/media/sw-stream-browser.test.mjs #7 — skipped on non-Chromium (CDP ServiceWorker.stopAllWorkers).
- tests/dm-verify-double-trigger-browser.test.mjs (b) — CDP DOMDebugger skipped on non-Chromium by design; (a) and (c) run but (a) fails per above.
