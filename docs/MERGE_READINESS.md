# Merge readiness — `pre-merge-fixes` (base: `github/test` @ `4ea1da0`)

- Base branch: `test` (pushed to `github/test`), HEAD `4ea1da0`
  (`fix(sw): regenerate sw-manifest.js after c0e30f1 changed public/js`).
- Working branch: `pre-merge-fixes`, created from that base, pushed to
  `github/pre-merge-fixes`.
- No feature flag was flipped by this branch. `GROUP_ATTACHMENTS_UI_ENABLED`
  (`public/js/chat/group-attachments-flag.js`) and
  `MEDIA_STREAM_ENABLED` (`public/js/...`) remain `false`.

## What is on this branch relative to the base `test`

1. **Group voice messages** (behind the existing `GROUP_ATTACHMENTS_UI_ENABLED`,
   still `false`):
   `public/js/chat/group-attachments.js` (voice helpers, optional strictly
   validated `file.voice` in the encrypted plaintext meta, `prepareGroupAttachmentUpload`
   `isVoice`, auto-load, `renderGroupVoice` from the decrypted blob);
   `public/js/chat/group.js` (mic + recording bar, reply-preview/decorate from
   verified meta);
   `public/js/media/voice-message.js` (`renderVoiceMessage` pre-resolved blob);
   `controllers/groups.controller.js` (`is_voice_message = 0`, neutral name/mime).
   `META_VERSION` stays `1`; no outer-envelope field; signed slot / signing /
   nonce-counter / AAD untouched; server never sees the flag.
2. **Voice blob-leak hardening** (this branch): `renderGroupVoice` revokes the
   blob URL it minted when the player render throws or the row goes away
   mid-render, and is idempotent per row element (no second blob URL / player).
   Tests added in `tests/groups/group-attachment-hostile.test.mjs`.
3. **Multer 2.x fileSize boundary fix** (on top of the base): removed the
   `+ 1` from the DM and group uploaders in `config/multer.js` (multer 2.x /
   busboy 1.x treats `fileSize` as INCLUSIVE); added a ciphertext-level DM
   boundary test; new `tests/uploaders-boundary.test.mjs` records the caps of
   the other uploaders (avatar, banner, chat, fileUpload, groupAvatar).
4. **Dependency/audit**: `fast-xml-parser` bumped (transitive via
   firebase-admin -> @google-cloud/storage) to clear the last production
   advisory (GHSA-474x-hrwr-fgx4).

## What was verified (this branch)

- `npm run test:crypto` (with `CHROMIUM_DIR=/home/arman/browser-check`): **118
  tests, 118 pass, 0 fail, 0 skipped, 0 todo** (exit 0). Re-run after regenerating
  `public/sw-manifest.js` (version `814854d084e6` after the voice fix; `--check`
  current; `build-sw-media-bundle.mjs --check` current).
- Group-attachment node suites: `group-attachment-ui` 10/10, `group-attachment-hostile`
  14/14 (incl. the three new Task-1 voice tests), combined group-attachment run
  71/71 pass; signing/binding 67/67; C3-12 12/12; group-attachment-server 8/8;
  group-attachment-limits + upload-cap 7/7; dm-attachments-server-cap 5/5;
  files-upload-name-length + upload-headers 9/9; uploaders-boundary 8/8.
- `fix(sw)` guard: `tests/sw-manifest.test.mjs` (SW-1 … SW-4) passes — it runs
  `node scripts/build-sw-manifest.mjs --check` and fails when the manifest is
  stale. A CI step with the same check exists in `docs/ci/linux-tests.yml`
  ("sw-manifest must be current").
- Browser (Chromium): group-attachment-browser file — 3 full runs, **12/12 pass
  each** (exit 0), serial (`--test-concurrency=1`); the pair with
  `group-e2e-browser.test.mjs` also 13/13 pass (12 + 1).
- Voice blob-leak tests: hostile suite 14/14 pass.

## What was NOT verified (this branch)

- Device / manual tests (audio playback on real hardware, mic permission UX).
- Database row counts for group attachments / group messages (E2EE bookkeeping).
- Migrations / schema changes (none made on this branch).
- Behavioural accept/refuse of live multipart uploads at the exact cap for
  every mounted uploader endpoint (avatar, banner, My Files, group avatar) —
  recorded via configured limits + multer-2.x inclusive rule; live round-trips
  not run ([NOT VERIFIED]).

## Rollback notes

- No flag flip: flipping `GROUP_ATTACHMENTS_UI_ENABLED` to `true` is the owner's
  decision and is NOT done here.
- To roll back the voice change: revert the commits touching
  `public/js/chat/group-attachments.js`, `public/js/chat/group.js`,
  `public/js/media/voice-message.js`, `controllers/groups.controller.js`
  (group-voice feature commits) and the `fix(group-voice)` blob-leak commit.
- To roll back the multer fix: restore the `+ 1` in `config/multer.js` for
  `dmUpload`/`groupUpload` (the pre-fix state) — but note that under multer 2.x
  that re-admits one byte, so it should only be done deliberately.
- To roll back the audit bump: `git revert` the `fix(deps)` commit.

## Owner decision pending

- Which size semantics for the plain uploaders (inclusive vs exclusive) should
  ship — asked after Task 5; nothing changed yet.
