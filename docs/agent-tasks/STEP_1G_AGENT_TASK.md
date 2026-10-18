# STEP 1G - the "vanishing row" finding: prove the root cause, then (only on GO) fix it; finish 1F

Put this file at `docs/agent-tasks/STEP_1G_AGENT_TASK.md`.
Base: your working tree after 1F (4 red tests e1-e4 in `tests/dm-v2-wire-browser-paths.test.mjs`).
Output zip: `wire-final-26`.
Reviewer decision on your question: option (b) for Part A, and option (c) is PRE-APPROVED only as the
design in Part B, which you may start ONLY after the reviewer writes "GO B" in a later message.

## Reviewer's reading of the code (wire-final-25, unchanged by you) - verify, do not trust

1. The history paths (`dm.js` 1965 `syncDmMessagesSince`, 2027 `loadDm...recent`, 2112 older page) all call
   `decryptDmMessages()` (`dm.js:547`), which is `Promise.all(messages.map(decryptDmMessage))`.
   `decryptDmMessage` THROWS on a bad envelope (AEAD/binding failure, unsupported format), and the callers
   wrap the whole thing in one `try/catch` that only logs. So ONE undecryptable row rejects the whole batch
   and NOTHING of that batch renders: not a placeholder, and the good rows around it vanish too.
2. The "Unable to decrypt" placeholder exists only in `addDmMessage` (`dm.js:2505-2535`, live path), and
   only `if (isActiveConversation)`. So the history view and the live view behave differently.
3. `decryptDmMessage` returns `null` for a held row (Phase 2). The three batch sites then use the array
   as if every entry were a message: `syncDmMessagesSince` does `decryptedMessages.filter(m => !ids.has(m.id))`
   (a `null` makes that throw inside the try and drops the whole sync), and the older-page path reads
   `decryptedMessages[0].timestamp`. Reviewer READ this; it has not been run.
4. This is probably PRE-EXISTING (v1 rows go through the same code), not a v2 regression. Part A proves or
   disproves that.
What the observed result does show: no plaintext and no ciphertext reached the DOM in e1-e4. The failure is
availability and visibility: a hostile or buggy server can blank a conversation with one corrupted row, and
the user is told nothing.

## Part A - evidence only. NO production change. Do all of it before reporting.

A1. Parity on v1. In the same browser harness, create a conversation that uses v1 (recipient created with
    default 1), flip one byte of the stored v1 `ciphertext` in the DB (test owns the DB file), reload and
    open the DM. Report `placeholders / decrypted / rows` exactly as in e1-e4. If it renders nothing too, the
    behaviour is pre-existing: say so.
A2. Blast radius. Conversation with THREE rows: good, tampered v2, good. Reload, open the DM. Report how many
    bubbles render and whether the two good rows are shown. Do the same with the tampered row last (live
    path via the socket: send a new row, then tamper before bob opens it) and report placeholder yes/no.
A3. Which of the three suspects (throw in `Promise.all`, `null` from hold, `isActiveConversation` gating) is
    the cause in e1-e4? Prove it with a `console.error` capture from the page (the page logs
    `Failed to process DM` / `Failed to sync DM messages`), pasted as output. No production edit; capture
    through `page.on('console')` in the test.
A4. Held-row path (null). With a key change active, hold a row, then trigger each batch path (open DM,
    scroll to load older, `syncDmMessagesSince`). Report for each: does it throw, is the good history still
    shown. Observation only.
A5. Report: a table (scenario | v1 or v2 | rendered bubbles | placeholder | console error text | verdict:
    pre-existing or v2-specific). Do not fix anything in Part A.

## Part A bis - finish 1F where it does not depend on e

The 1F report skipped the browser plants because "e is red". That only holds for e. For the GREEN groups
do the plants NOW (script with real newlines and LF; after each restore `git diff --stat` empty and CR=0):
- (b) `buildTextBody` stops sending `replyToId` -> test b red.
- (c) preview guard at `dm.js` ~611 goes back to rejecting version 2 -> test c red.
- (d) `buildEditBody` stops sending `replyToId` -> test d red.
- (f) version choice always v2 -> test f red.
- (g) downgrade notice fires on every render -> test g red.
- (a) own-message decrypt uses the wrong peer key -> test a red.
- (h) rotation: make `mayTryRetiredKey` always return false -> test h red.
Paste RED then GREEN for each. A plant that stays green means the test is not testing it: say so.
Also: update the three skip markers in `tests/dm-v2-protocol-e2e.test.mjs` so each points at the browser
test now covering it (2/3 -> b, 10 -> d, 13 -> h).

## Part A ter - make the zip shippable without hiding the gap

Mark e1-e4 with the node test option `{ todo: 'KNOWN GAP: vanishing row, see STEP_1G Part B' }` (they still
run and still report, but do not fail the suite). Do not weaken any assertion. Run the suite three ways
((i) wire-final-25 baseline on your 72-file set, (ii) env=1, (iii) default) with the new file included;
(ii) and (iii) must be 0 fail. Then verify the ZIP (clean directory, unzip, `build-sw-manifest --check`,
`grep -rlc $'\r' public/`, `tests/sw-manifest.test.mjs`, the new browser file). Zip `wire-final-26`:
sha256, bytes, entries, `unzip -l | grep` new files. REPORT and STOP. Do not start Part B.

## Part B - design for the fix (do NOT start until the reviewer writes "GO B")

Goal: an undecryptable or held row never blanks other rows, never shows plaintext or ciphertext, and shows a
clear placeholder. Applies to v1 and v2 (same code), so say so in the report.
1. `decryptDmMessages`: decrypt rows independently (`Promise.allSettled` or per-row try/catch).
   - fulfilled string/object -> as today.
   - fulfilled `null` (held) -> excluded from the result (Phase 2 behaviour unchanged; the held row is
     already kept in `dm-key-trust.js` and released on accept).
   - rejected -> a placeholder message object: same `id`, `sender_id`, `recipient_id`, `created_at`, content
     the fixed string `Unable to decrypt`, plus a flag such as `undecryptable: true`. It must NEVER carry the
     original `content` (ciphertext), `reply_to` content or attachment data. `buildDmMessageEl` renders it as a
     plain non-interactive bubble: no copy, no reply, no edit, no reactions, no link or media handling.
2. The three batch call sites must tolerate an empty result and a result whose first element is a
   placeholder (`decryptedMessages[0].timestamp`, `entry.oldest`, `hasMore` use real timestamps from the
   ROW, not from decrypted content).
3. `addDmMessage` / the other live path (~2710): placeholder shown regardless of
   `isActiveConversation` is NOT required; keep today's live behaviour. Only make history consistent.
4. Preview/conversation list: already returns `Unable to decrypt` (`dm.js` 623/637/677); leave it.
5. Tests: e1-e4 lose their `todo` and must pass: positive control first, then after tamper exactly one
   placeholder in place of that row, the good rows still shown, no plaintext, no ciphertext in the DOM
   (assert `document.body.innerHTML` does not contain the envelope's `ciphertext` string). Add: three-row case
   (good / tampered / good), a v1 parity case, a held-row case (history load while a key change is active:
   good rows shown, no throw). Plant for each: revert to `Promise.all` -> red; let a rejected row carry
   `content` -> red; return `null` rows unfiltered -> red.
6. This changes behaviour in a security-adjacent area. One production file only (`public/js/chat/dm.js`,
   plus `dm-layout.js` only if the placeholder needs it). If it needs more, STOP. Rebuild the manifest.
   `peer-trust-browser` (3 tests) and the whole browser set must still pass: run them and paste.

## Report format (Part A + A bis + A ter, then STOP)

1. A5 table and the console-error captures. 2. Plant table (RED/GREEN output). 3. Suite counts. 4. ZIP
verification output. 5. Side findings from 1F that stay as notes: the harness `sendDmTextUi` can send twice
when the input clears slowly (`sendOnce` in the new file works around it; harness untouched), the harness
`startRealServer` takes a new port each start, the server `slice(0, 2000)` vs the client 2000 guard.
6. Still not proven. STOP.
