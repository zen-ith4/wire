# TEST ENGINE FIREFOX FIRST RUN — Phase 0 of CROSS_PLATFORM_TEST_ROADMAP.md

Run with `WIRE_TEST_BROWSER=firefox`, `FIREFOX_PATH=/usr/bin/firefox`,
`CHROMIUM_DIR=/home/arman/browser-check`, on branch `test-engine-switch`
(main at `9b8cd09fecaac0599877fb55df543d67f3bc0b6c`).

Each file re-run 3 times alone; all results consistent. Classification:
test bug | product bug | engine limitation | test automation artifact.

## Results table

| File | Chromium baseline | Firefox result | Classification | First line / note |
|---|---|---|---|---|
| tests/dm-verify-ui-browser.test.mjs | 2/2 pass | 2/2 pass | — | — |
| tests/dm-double-send-browser.test.mjs | 1/1 pass | skipped | test automation artifact | `# SKIP firefox automation does not produce a physical Enter (code/location) - verify manually in real Firefox` |
| tests/dm-key-trust-hostile-strings-browser.test.mjs | 2/2 pass | 2/2 pass | — | — |
| tests/dm-verify-double-trigger-browser.test.mjs | 1/1 pass | 1/1 pass | — | (panel opened before part (a) on every engine) |
| tests/credentials/f12-browser-login.test.mjs | 6/6 pass | 6/6 pass | — | — |
| tests/groups/group-attachment-browser.test.mjs | 12/12 pass | 11/12 fail (#12) | engine limitation | `Waiting for selector #group-recording-bar.active failed` |

## Classification notes

**tests/dm-double-send-browser.test.mjs — test automation artifact (UNVERIFIED on a real keyboard).**
Firefox automation (puppeteer-core BiDi) reports Enter as `code="NumpadEnter"`,
`location=1` — never `code="Enter"`, `location=0` (raw event table captured
during investigation). The product's `isPhysicalEnter` guard in
`public/js/chat/composer.js` (lines 2392-2404) therefore never fires and Enter
never sends. The Enter part of this test is skipped on non-chromium engines
with an explicit `# SKIP` reason. The click-path assertions (single click,
double click, later send, same text twice) run and pass on Firefox.
Manual check owed: press Enter in the composer in a real Firefox on desktop;
expect the message to send. Press Enter on a mobile virtual keyboard; expect a
newline (current intended behaviour).

**tests/dm-verify-double-trigger-browser.test.mjs — passing on Firefox.**
Fixed by opening the Verify panel before part (a) on every engine (the panel
was closed on Firefox because the chromium-only CDP part (b) was skipped).
Part (a) double-click and part (c) encryptedFloor both run and pass on
Firefox. Part (b) CDP listener-counting remains chromium-only (skipped on
non-chromium by design).

**tests/groups/group-attachment-browser.test.mjs #12 — engine limitation.**
Test 12 ("group voice") relaunches Alice's browser with
`--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`. These
are Chromium-only launch args; on Firefox they are intentionally not passed
(see the `fakeMediaArgs` conditional in the test). Without them, Firefox does
not provide a fake microphone, the recording bar never activates, and
`#group-recording-bar.active` never appears. Not a product bug — the fake-mic
flags simply don't exist for Firefox.

**Passing on Firefox:** dm-verify-ui (2/2), dm-key-trust-hostile-strings (2/2),
f12-browser-login (6/6), group-attachment #1-#11 (11/12),
dm-verify-double-trigger (1/1), dm-double-send (click path, Enter skipped).
No product behaviour was changed to achieve these.

## Known not-run on Firefox

- tests/dm-audio-attachment-browser.test.mjs — skipped on non-Chromium (captureDownloads uses CDP; also a known AAC env failure on Chromium).
- tests/media/sw-stream-browser.test.mjs #7 — skipped on non-Chromium (CDP ServiceWorker.stopAllWorkers).
- tests/dm-verify-double-trigger-browser.test.mjs (b) — CDP DOMDebugger skipped on non-Chromium by design; (a) and (c) run and pass.

## Manual check still owed

Press Enter in the composer in a real Firefox on desktop; expect the message
to send. Press Enter on a mobile virtual keyboard; expect a newline (current
intended behaviour — the `isPhysicalEnter` guard deliberately excludes mobile
virtual-keyboard Enter).
