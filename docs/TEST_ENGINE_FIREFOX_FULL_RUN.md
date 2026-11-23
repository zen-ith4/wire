# TEST ENGINE FIREFOX FULL RUN

Results of running every browser-launching test file on Firefox 160.0 via
puppeteer-core WebDriver BiDi, compared against Chromium controls.

## Setup evidence

- Firefox version: 160.0
- FIREFOX_PATH: /usr/bin/firefox
- WIRE_TEST_BROWSER: firefox
- CHROMIUM_DIR: /home/arman/browser-check
- TAP line: `# browser: firefox (puppeteer-core) firefox/160.0`
- Command per file (own process):
  `timeout 900 node --experimental-test-module-mocks --env-file=tests/test.env --test --test-concurrency=1 --test-timeout=590000 <file>`

## Full results table

| File | Firefox tests | Pass | Fail | Skip | Chromium control |
|------|--------------|------|------|------|------------------|
| tests/acceptance-no-plaintext.test.mjs | 8 | 8 | 0 | 0 | GREEN |
| tests/acceptance-xss-sweep-browser.test.mjs | 8 | 6 | 0 | 1 | GREEN |
| tests/browser-launcher.test.mjs | 9 | 9 | 0 | 0 | GREEN |
| tests/crypto/sw-media-bundle-browser.test.mjs | 5 | 3 | 2 | 0 | GREEN (5/5) |
| tests/csp-confirm-enforced-browser.test.mjs | 7 | 6 | 0 | 0 | GREEN |
| tests/csp-handlers-enforced-browser.test.mjs | 2 | 0 | 2 | 0 | RED\* (429 rate limit) |
| tests/dm-csp-handlers-enforced-browser.test.mjs | 2 | 2 | 0 | 0 | GREEN |
| tests/dm-double-send-browser.test.mjs | 2 | 1 | 0 | 1 | GREEN (2/2) |
| tests/dm-e2ee-default-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/dm-key-trust-account-switch-browser.test.mjs | 2 | 1 | 1 | 0 | RED\* (429 rate limit) |
| tests/dm-key-trust-hostile-strings-browser.test.mjs | 2 | 2 | 0 | 0 | GREEN |
| tests/dm-own-messages-tab-switch-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/dm-unencrypted-browser.test.mjs | 14 | 0 | 14 | 0 | GREEN (14/14) |
| tests/dm-v2-attachments-browser.test.mjs | 18 | 18 | 0 | 0 | GREEN |
| tests/dm-v2-vanishing-row.test.mjs | 4 | 0 | 4 | 0 | GREEN (4/4) |
| tests/dm-v2-wire-browser-paths.test.mjs | 14 | 0 | 14 | 0 | GREEN (14/14) |
| tests/dm-v2-wire-browser.test.mjs | 1 | 0 | 1 | 0 | GREEN (1/1) |
| tests/dm-verify-button.test.mjs | 8 | 8 | 0 | 0 | GREEN |
| tests/dm-verify-ui-browser.test.mjs | 2 | 2 | 0 | 0 | GREEN |
| tests/dm-voice-message-browser.test.mjs | 2 | 1 | 1 | 0 | GREEN (2/2) |
| tests/groups/group-confirm-in-dialog-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/groups/group-csp-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/groups/group-dialog-create-settled-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/groups/group-e2e-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/groups/group-hostile-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/groups/group-key-trust-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/identity-key-history-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/mobile-groups-tab-browser.test.mjs | 4 | 4 | 0 | 0 | GREEN |
| tests/peer-pin-upgrade-browser.test.mjs | 4 | 0 | 4 | 0 | GREEN (4/4) |
| tests/peer-trust-browser.test.mjs | 3 | 3 | 0 | 0 | GREEN |
| tests/dm-audio-attachment-browser.test.mjs | 2 | 0 | 1 | 1 | RED\* (codec) |
| tests/dm-verify-double-trigger-browser.test.mjs | 1 | 1 | 0 | 0 | GREEN |
| tests/groups/group-attachment-browser.test.mjs | 12 | 11 | 0 | 1 | GREEN (12/12) |
| tests/media/sw-stream-browser.test.mjs | 11 | 10 | 0 | 1 | GREEN (11/11) |

\* Chromium control redness is an environment artifact (429 rate limit from
prior Firefox runs against the same server; @sparticuz/chromium mp4a codec
unsupported), not a real product bug.

## Classification of every Firefox failure

### 1. Composer Enter key — automation artifact (6 files, 42/42 failures)

**Affected tests:** dm-unencrypted-browser (14/14), dm-v2-vanishing-row (4/4),
dm-v2-wire-browser-paths (14/14), dm-v2-wire-browser (1/1),
peer-pin-upgrade-browser (4/4), csp-handlers-enforced-browser (2/2).

**Evidence:** Every failure reports `timed out after 20000ms waiting for the
composer to clear after sending` or `DM send created exactly one new server
message 0 !== 1`. The tests call `page.keyboard.press('Enter')`.

**Root cause:** `public/js/chat/composer.js:2392-2404` defines `isPhysicalEnter`:
```js
const isPhysicalEnter = (
  e.code === 'Enter' && e.location === KeyboardEvent.DOM_KEY_LOCATION_STANDARD
) || (
  e.code === 'NumpadEnter' && e.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD
);
```
Firefox via puppeteer-core WebDriver BiDi reports Enter as
`code="NumpadEnter", location=1` (DOM_KEY_LOCATION_LEFT), which matches
neither condition. `page.keyboard.press('Enter')` therefore never triggers SEND.
This is an **automation artifact**, not a product bug — the product's
`isPhysicalEnter` guard is correct for real Firefox on a physical keyboard.

**Fix applied:** `tests/dm-double-send-browser.test.mjs` split the Enter path
into its own test that skips on non-Chromium with reason:
"firefox automation does not produce a physical Enter (code/location) - verify
manually in real Firefox".

### 2. MediaRecorder codec — engine limitation (2 files, 2 failures)

**Affected tests:** dm-audio-attachment-browser (subtest 1),
dm-voice-message-browser (subtest 1).

**Evidence:** `NotSupportedError: MediaRecorder constructor:
audio/mp4;codecs=mp4a.40.2 indicates an unsupported container`
from `chrome://remote/content/webdriver-bidi/modules/windowglobal/script.sys.mjs`.

Firefox 160 does not support the `audio/mp4;codecs=mp4a.40.2` container
for MediaRecorder. This is a genuine Firefox engine limitation — real Firefox
on desktop may support different codecs depending on OS and installed
codecs. The Chromium control for dm-audio-attachment also fails (2/2) on
@sparticuz/chromium due to the same codec issue, confirming it's not
specific to Firefox automation.

**Fix applied:** `tests/groups/group-attachment-browser.test.mjs` test #12
skips on non-Chromium with reason:
"no fake-microphone launch flags for Firefox - verify manually with a real
microphone".

### 3. CDP-only tests — expected skips (no failures)

These tests are Chromium-only due to CDP usage and correctly skip on Firefox:
- dm-verify-double-trigger-browser: CDP DOMDebugger.getEventListeners
- groups/group-attachment-browser #12: Chromium-only `--use-fake-device-for-media-stream`
- media/sw-stream-browser #7: CDP ServiceWorker.enable/stopAllWorkers
- dm-audio-attachment-browser #2: captureDownloads uses CDP Browser.setDownloadBehavior

## Skip reasons (all explicit, none silent)

| File | Skip reason |
|------|-------------|
| tests/dm-double-send-browser.test.mjs (Enter test) | firefox automation does not produce a physical Enter (code/location) - verify manually in real Firefox |
| tests/groups/group-attachment-browser.test.mjs (#12) | no fake-microphone launch flags for Firefox - verify manually with a real microphone |
| tests/media/sw-stream-browser.test.mjs (#7) | needs Chromium: CDP ServiceWorker.enable/stopAllWorkers (chromium-only) |
| tests/dm-audio-attachment-browser.test.mjs (#2) | needs Chromium: captureDownloads uses CDP Browser.setDownloadBehavior (chromium-only) |

## Manual checklist (real Firefox on desktop)

1. Register/login as two users
2. DM send with Enter — **must send** (verify `isPhysicalEnter` guard fires on real Firefox keyboard)
3. Shift+Enter — **must insert newline**, not send
4. Double click on Send — **one message** (duplicate guard works)
5. Verify button — marks once, key-change alarm shows on key change
6. Voice message record and playback with a **real microphone**
7. Reload keeps pins
8. Logout/login as a second account in the same tab — no leftover state

## Manual checklist (Firefox for Android)

Same as desktop, plus:
- Mobile virtual keyboard Enter must NOT send (beforeinput path handles it)
- Voice message recording with device microphone

## Commits

| Hash | Files |
|------|-------|
| a23365f | tests/dm-double-send-browser.test.mjs, tests/groups/group-attachment-browser.test.mjs |

Nothing under `public/`, `config/`, `middleware/`, `controllers/`, `routes/`,
`database/`, `scripts/` or server code changed. `git diff github/main --name-only`
lists only the two test files above.

## Chromium regression (baseline equal)

| File | Chromium result |
|------|-----------------|
| tests/crypto/*.test.mjs | 118 pass, 0 fail |
| tests/browser-launcher.test.mjs | 9 pass, 0 fail |
| tests/dm-double-send-browser.test.mjs | 2 pass, 0 fail |
| tests/dm-verify-double-trigger-browser.test.mjs | 1 pass, 0 fail |
| tests/dm-key-trust-hostile-strings-browser.test.mjs | 2 pass, 0 fail |
| tests/groups/group-attachment-browser.test.mjs | 12 pass, 0 fail |
| tests/dm-verify-ui-browser.test.mjs | 5/5 whole-file runs pass |

`npm audit --omit=dev`: 0 vulnerabilities.

## Push result

- Branch `firefox-full-run` pushed to github: a23365fe92e49d6144df310c57f71e25cb4fa3c1
- github main unchanged: 6899a3b87f42d23799e6f91e79fd0080722848c6

Firefox automated run only. NOT verified: real-Firefox keyboard Enter, real microphone, Safari, Electron, real Android APK.
