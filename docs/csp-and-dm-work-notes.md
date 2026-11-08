# CSP and DM work notes for later

## 1. What was done

### DM fixes

Three DM key-gate fixes were made:

1. Closed ways a hostile server could swap keys or bypass the saved-key check.
2. Prevented unencrypted DM rows from appearing as ordinary messages; rows are hidden or labelled according to the device's history. The server rejects unencrypted DM text and edits by default.
3. Applied the key and verification rules to keys and verification marks saved by older client versions.

### CSP work

CSP Stage 2 and Stage 3 work was merged. Stage 2 included browser tests using real clicks and changes to click handling. Stage 3 removed inline style attributes and `cssText` writes from the listed client files, replacing them with classes or validated `data-*` values applied through CSSOM. The work also removed inline `onclick` handlers covered by the CSP changes. `middleware/csp.js` was not changed in the CSP summary.

The DM and CSP work was merged into `merged-final`. Two test fixes were included:

- The CSP test clicks the last reply button because the first row is a stale row for a message the test deletes.
- `dm-unencrypted-browser.test.mjs` waits for the conversation-list preview before its first-load check.

Commit subjects in `git log --oneline 07c6651..merged-final` after the identity rewrite:

- test: wait for the list preview before the first-load check
- csp test: click the last reply button (first row is a stale deleted message)
- Merge branch 'csp-work'
- fix: read saved keys by today's rules (older pins)
- fix: stop unencrypted DM rows passing as real messages
- fix: close the DM key-check bypasses
- csp docs: CSP-clean status, rules for new code, known gaps
- csp stage 3: enforced browser test sweeps every top-level view and asserts zero violations including style-src
- csp stage 3: remove LEGACY_CAPS; every static CSP count is asserted to be zero
- csp stage 3: attachments.js: download-progress cssText (4) -> classes; aspect-ratio via data-aspect. dynamic-vars.js observer installed at boot (app.js) so every inserted node gets data-* values
- csp stage 3: settings-appearance-custom.js slider fill via data-sound-volume; display:block spans -> u-block
- csp stage 3: composer.js upload progress width via data-progress + applyDynamicVars on render (later updates were already CSSOM)
- csp stage 3: settings-message-sounds.js --sound-volume via data-sound-volume + applyDynamicVars
- csp stage 3: settings-bubble-gradient.js --sound-volume via data-sound-volume + applyDynamicVars
- csp stage 3: emoji-picker.js skin swatch --swatch via data-swatch + CSSOM; add ui/dynamic-vars.js helper (validated sound-volume/swatch/progress/aspect)
- csp stage 3: dm.js inline style= (3) -> utility classes; copy-helper textarea uses class instead of style.cssText
- csp stage 3: wireguard.js inline style= (1) -> u-min-w-260
- csp stage 3: profile-card.js inline style= (1) -> u-pc-pad
- csp stage 3: audio-player.js display:none (1) -> js-hidden
- csp stage 3: voice-message.js display:none (2) -> js-hidden (JS keeps toggling via style.display)
- csp stage 3: video-player.js display:none (2) -> js-hidden; video-time shows as 'block' (same as '' for a div with no display rule)
- csp stage 3: admin.js inline style= (3) -> utility classes in utilities.css
- csp stage 3: settings-render.js inline style= (16) -> classes; bg preview and accent swatch via data-* + CSSOM (dynamic-style.js, validated hex)
- csp stage 3: auth.js inline style= (21) -> classes in pages/login.css; same declarations, JS toggles still via CSSOM
- csp stage 2: real-click tests for composer, dm-send, picker close, profile-card message, dm back, settings avatar/banner (with confirm), files new-folder
- csp docs: Stage 2 handler status, actions.js unknown-name behaviour documented
- csp stage 2: image-viewer.js remove duplicate dragstart preventDefault listener
- csp stage 2: browser test for avatar click inside DM picker row (profile opens, DM does not)
- csp stage 2: avatar.js click listener in capture phase so ancestors do not double-fire

## 2. Open items for later

### Intermittent browser boot stall

- **Status:** Open; cause unknown.
- **Evidence:** About 5% of observed `dm-unencrypted-browser.test.mjs` runs stall after `page.reload()`. The page is blank, there is no console output, no pending request, the service worker is ready, and the server is alive. It has been seen on `dm-fix` and `merged` on CachyOS and WSL. This was not measured on baseline `07c6651`.
- **Next check:** Run a reload-stress script on baseline `07c6651`, `dm-fix`, and `merged` with the same browser setup and record rates and diagnostics. The cause remains unknown.

### Tests and reviews not run or incomplete

- `tests/groups/group-csp-browser.test.mjs` did not complete successfully in the documented WSL run; it reported `socket did not connect`. The test's `startStaticApp` serves static files without Socket.IO, and that run reported no CSP refusal. The baseline was also reported to fail in that sandbox. CachyOS status: unverified.
- The Settings-page screenshot comparison before and after the CSP class change was not done.
- A manual run with `CSP_ENFORCE=true npm start` and a browser review of the affected screens was not done.
- A human review of the DM security code is still needed.
- Real multi-device use has not been checked.
- Firefox, Safari, Android, and Electron have not been checked for these changes.
- The CSP summary also records these as not run: `npm run test:groups`, `dm-csp-handlers-enforced-browser`, `csp-confirm-enforced-browser`, and the service-worker manifest check. A definitive test for `open-image-viewer` and attachment download was not written.

### Known failing tests reported by the summaries

The DM summary says these failures also occur without the DM changes. Their current Linux status is **unverified**; the Linux runs recorded for this work exercised the DM browser test and do not establish the status of these failures:

- `admin-single-root` (whole file); reason unknown.
- `f12-setup-seed`; Windows refused to create a symlink.
- `sw-media-bundle` (2 tests); bundle build failed in the reported setup.
- `escape-attr-js-string` (3 tests); the tests look for an `onclick` attribute, possibly outdated.
- `f12-browser-login`, “Add user”; reason unknown.
- `dm-csp-handlers-enforced-browser`, Attach control; the test expected an inline `onclick`, possibly outdated.

The CSP summary reports that `csp-static.test.mjs` passed 9/10 and `CSP header: strict script-src` failed on the original code as well. Whether that still fails on CachyOS is **unverified**. It also reports the group CSP browser test's WSL failure above.

### Other known gaps and decisions

- The Android `app-debug.apk` bundles an old client and does not include these DM fixes. The APK rebuild and its behavior are unverified.
- Items noted in the DM summary and left alone:
  - `dm.js` inserts the server's message ID into HTML without escaping in five places.
  - One `null` row can blank the whole thread.
  - `package-lock.json` is out of sync with `package.json`; `npm ci` fails.
  - `docs/WIRE_PHASE0_OWNER_REVIEW.md` and `docs/PHASE3_RFC.md` are outdated.
  - `transition:width:.15s ease` and `transition:opacity:.15s ease` are invalid CSS values retained from before this work.
  - Other reported DM rough edges include held old plaintext staying hidden until reload, a conversation-list/thread mismatch for old plaintext, and a forged row label remaining until reload.
- An install report listed 21 known vulnerabilities in existing dependencies, including `multer` 1.x, `tar` 6, `glob` 9/10, and `uuid` 7/9. This was not rechecked for this note and was not addressed. Do not run `npm audit fix --force`.
- Design decisions still needing the owner's agreement:
  - Verifying a contact drops keys the server listed at first contact. Old messages encrypted to those keys can stop opening on that device.
  - The one-second rule treats a “verified” mark saved within one second of the key as an old, untrusted mark. A genuine mark inside that interval could be cleared and need to be made again.
  - The server refusing non-encrypted DM text is an added behavior. `DM_E2EE_TEXT_ENFORCED=false` rolls it back.
- Roadmap items remain untouched or incomplete, including message padding, replay hardening, signed group membership, forward secrecy, CSP enforcement by default, and dropped-message detection. Other gaps in the DM summary include metadata protection, client/storage hardening, and key-change transparency.

## 3. How the tests were run

The Linux runs for this work used CachyOS, Node 22.23.x through `fnm`, and `@sparticuz/chromium` 153 from `~/browser-check`. The DM browser test was run separately with process isolation:

```sh
CHROMIUM_DIR=~/browser-check node --experimental-test-module-mocks --env-file=tests/test.env --experimental-test-isolation=process --test tests/dm-unencrypted-browser.test.mjs
```

The CSP summary's WSL instructions recorded these commands:

```sh
node --test tests/csp-static.test.mjs
node --test tests/csp-handlers-enforced-browser.test.mjs
node --test tests/groups/group-csp-browser.test.mjs
```

Run the CSP browser test and DM browser test in separate Node processes with `--experimental-test-isolation=process`; running them together in one process makes them interfere. Earlier WSL runs are recorded in the DM and CSP summaries. Exact Node and Chromium versions for every earlier WSL run: **unverified**.

## 4. Branch map

- `dm-fix`: DM fixes.
- `csp-work`: CSP Stage 2 and Stage 3 work.
- `merged-final`: the combined history, including the merge commit and the two test fixes.
- `backup/dm-fix-before-rewrite`, `backup/csp-work-before-rewrite`, and `backup/merged-final-before-rewrite`: local backups from before the identity rewrite; keep these branches.
- Base: `07c6651`. Commits at or before it were left unchanged.
- Nothing was pushed. No remote was touched.
