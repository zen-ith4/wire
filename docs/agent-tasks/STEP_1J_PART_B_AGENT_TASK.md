# STEP 1J - Part B: one undecryptable row must not blank the whole conversation

Put this file at `docs/agent-tasks/STEP_1J_PART_B_AGENT_TASK.md`.

## GATE - read first

Do NOT start this until the reviewer's message contains the exact words "GO B". Without it, stop after
reading and reply "waiting for GO B". 1I and its fix-up are finished (reviewer verified wire-final-27 on Linux: tests b and d pass 2/2 each).
Base: wire-final-27 (sha256 01920e07...f74c, HEAD 6409d23). Output zip: `wire-final-28`.

## Why (evidence, all reproduced, v1 and v2)

- One stored row that fails to decrypt (tampered ciphertext, `version` rewritten, `reply_to_id` rewritten,
  or any corrupt envelope) makes the WHOLE history fail: bubbles=0, the thread shows `Failed to load`
  (`dm.js:2077`), the good rows and the legacy rows disappear too. Reproduced by the reviewer on Linux and by
  you in 1H (A1 for v1, A2/A3 for v2). It is PRE-EXISTING (v1 takes the same path), not a v2 regression.
- Cause: `decryptDmMessages()` (`dm.js:547`) is `Promise.all(messages.map(decryptDmMessage))`; one rejection
  rejects the batch; the caller's single `catch` replaces the thread with `emptyState('Failed to load', e.message)`.
- A held row (`decryptDmMessage` returns `null`, Phase 2) is mishandled by the same callers: they treat the
  array as if every entry were a message (`decryptedMessages[0].timestamp`, `.filter(m => !ids.has(m.id))`).
- What is NOT broken and must stay true: no plaintext of a tampered row and no ciphertext ever reaches the DOM.

## Goal

An undecryptable row shows as ONE placeholder in its place; every other row renders; a held row is simply
not rendered (Phase 2 behaviour unchanged). Applies to v1 and v2 (shared code); say so in the report.

## Change (one production file: `public/js/chat/dm.js`; `dm-layout.js` only if the placeholder needs it)

1. `decryptDmMessages(messages)`: decrypt every row independently (`Promise.allSettled` or per-row try/catch).
   - resolved object -> as today.
   - resolved `null` (held) -> left out of the returned array.
   - rejected -> a placeholder message object: same `id`, `sender_id`, `recipient_id`, `created_at`/timestamp,
     `reply_to_id` as the row, `content` set to the fixed string `Unable to decrypt`, and `undecryptable: true`.
     It must NEVER carry the original `content`, `reply_to` content, attachment or media data, or the error text.
     Log `console.error('Failed to process DM <id>:', e)` as `addDmMessage` does today.
2. Rendering: `buildDmMessageEl` (`dm.js:2228`) draws an `undecryptable` message as a plain, non-interactive
   bubble: no copy, no reply, no edit, no react, no link or media handling, no quote. Use the same text and class
   as the live-path placeholder (`dm.js` ~2528) so both look alike.
3. The three batch sites (`syncDmMessagesSince` ~1965, the recent-history loader ~2027, `loadOlderDm` ~2112) must
   work with an empty result and with a placeholder first element. `entry.oldest`, `hasMore` and the unread
   marker must come from the ROW timestamps, not from decrypted content. Do not change pagination semantics
   (`hasMore = rows.length >= 50` must count rows, not rendered messages: a page with held or placeholder rows must
   not end pagination early).
4. Do NOT change: `addDmMessage` live behaviour, the preview text paths (they already return `Unable to decrypt`),
   `dm-key-trust.js`, any crypto module, the server, any test fixture. If the fix needs more than `dm.js`
   (+ `dm-layout.js`), STOP and report.
5. Rebuild the manifest (`node scripts/build-sw-manifest.mjs`), check it.

## Tests (real browsers, one process per account, reload + re-login, exact-postcondition polls)

Edit `tests/dm-v2-wire-browser-paths.test.mjs`: REMOVE the `todo` from e1-e4. They must now pass with this meaning:
positive control first (the untouched row shows its plaintext), then after the mutation exactly ONE placeholder
`Unable to decrypt` in that row's place, the other rows still shown, the tampered row's plaintext absent, and
`document.body.innerHTML` does not contain the row's `ciphertext` string.
Add, in the same file (or `tests/dm-v2-wire-browser-gap.test.mjs`):
- three rows (good, tampered, good), tamper in each of the three positions: 2 good bubbles + 1 placeholder in the
  right order, for at least `ciphertext flipped` and `version stripped`; the third mutation (`reply_to_id`) for one position.
- v1 parity: a v1 conversation with one flipped ciphertext byte: same result (placeholder + good rows).
- held row: with a peer key change active and history already stored, open the DM, scroll to load older, and trigger
  `syncDmMessagesSince`: no exception, the good rows render, the held row is not rendered, then after accepting
  the key change the held row is released and shown (Phase 2 release path unchanged).
- pagination: a thread of 51+ rows where one is tampered still offers "load older" and loads the rest.
Planted violations (RED, restore, GREEN, paste both; script with real newlines, LF, `git diff --stat` empty and CR=0
after each restore):
1. revert to `Promise.all` -> the tamper tests go red.
2. let the placeholder carry the original `content` -> the "no ciphertext in the DOM" assertion goes red.
3. stop filtering `null` -> the held-row test goes red.
4. compute `hasMore` from rendered messages instead of rows -> the pagination test goes red.
5. render the placeholder with the normal interactive bubble (copy/reply buttons) -> the placeholder test goes red.
Regression: run `tests/peer-trust-browser.test.mjs`, `tests/dm-v2-wire-browser.test.mjs`,
`tests/dm-e2ee-default-browser.test.mjs`, `tests/dm-blob-url-cleanup.test.mjs` (mocks `dm.js` imports; check it
still passes), and the whole new browser files. Paste the output.

## Close-out

Suite three ways on the 72-file set + new files, (ii) and (iii) 0 fail 0 cancelled, no `todo` left on e1-e4.
Verify the ZIP from a clean directory (manifest `--check`, `grep -rlc $'\r' public/` empty, sw-manifest test, the
new browser file). Report: the exact `git diff` of `dm.js`, changed files, `public/` diff names, planted-violation
output, suite counts, zip sha256/bytes/entries. Note the behaviour change plainly in `docs/DM_V2_WIRE.md`:
"an undecryptable row shows a placeholder; previously the whole history failed to load". STOP. No Phase 3.

Work in committed steps (commit after the change, after the tests, after the plants) so a budget stop never leaves
the tree half-done; report after each step in 5 lines.
