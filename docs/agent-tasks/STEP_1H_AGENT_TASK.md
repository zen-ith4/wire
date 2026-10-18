# STEP 1H - settle A2/A3 against independent evidence, fix the flaky test, ship wire-final-26

Put this file at `docs/agent-tasks/STEP_1H_AGENT_TASK.md` and the reference file at
`tests/_reference/probe-tamper-rows.mjs` (a plain copy; it is NOT part of the suite unless you rename it).
Base: your working tree after 1G (no production change). Output zip: `wire-final-26`.
Your budget is limited, so the order below is the priority order. Stop at the first item you cannot finish
and report what is done; do not start the next one half-way. No production change in this step.

## 0. Independent evidence from the reviewer (Linux, wire-final-25 unmodified, real Chromium)

The reviewer wrote a probe (`reference/probe-tamper-rows.mjs`: alice sends 3 v2 messages, the test
mutates ONE stored row in the SQLite file with the test's own connection, bob re-logs in and opens the DM).
Result for each of three mutations, UPDATE reported `changes=1`, read-back confirmed the change:

| mutation of one stored row | `changes` | bob's thread after re-login |
|---|---|---|
| ciphertext: one character flipped | 1 | 0 bubbles, text "Failed to load" |
| `encryption.version` 2 -> 1 | 1 | 0 bubbles, text "Failed to load Message authentication failed" |
| `reply_to_id` NULL -> 1 (content untouched) | 1 | 0 bubbles, text "Failed to load" |

Conclusions the reviewer draws (verify them, do not just accept them):
1. Tamper in a multi-row conversation IS detected, for all three bound fields. The binding works.
2. Blast radius is the WHOLE conversation: the good rows (including the legacy fixture row 1) are not shown
   either. The history loader fails as one unit (`Promise.all` in `decryptDmMessages`, `dm.js:547`).
3. It is not "silent": the thread shows a generic "Failed to load" text, which is the error state of the
   history loader, not a per-row placeholder.
4. Your A2/A3 ("3 bubbles, plaintext of the tampered row shown") therefore contradicts this. The most likely
   explanation is that the mutation in your A2/A3 did not take effect. Item 1 settles it.
(Note: the probe mutates `rows[1]`, the first message of the three, because row 1 is the fixture row. Item 1
covers all three positions.)

## 1. Settle A2/A3 (do this first)

1. Take your A2 test. Right after the mutation print: `UPDATE ... .run().changes` (must be 1), the row read
   back from the same connection (content hash, `reply_to_id`), and the row as returned by bob's real API
   (`GET /api/dm/messages/:peerId/recent`, through the page's own authenticated fetch). If the API row differs
   from the DB row, say so: that is a server-side cache or a different column.
2. Print which mutation function and which row position A2/A3 used, and confirm it is the SAME helper
   e1-e4 use (e1-e4 did show the effect). If A2/A3 used a different helper, switch to the e1-e4 helper.
3. Run A2 for the tampered row in each of the three positions (first, middle, last) and for each of the
   three mutations. Table: position | mutation | changes | API row changed | bubbles | visible text |
   console errors (page.on('console') text, not truncated to the first one).
4. Compare with section 0. If your machine now matches (0 bubbles, "Failed to load"), A2/A3 is closed as
   "was a harness error" and the 1G A5 table must be corrected. If it still shows 3 bubbles with
   plaintext, that is a P0 finding: stop, report the exact reproduction, and do not touch anything else.
5. Also correct A1: the console line you quoted (`Failed to decrypt conversation preview`) is the preview
   path; capture the history-loader error too and paste both.

## 2. Flaky test (d)

In the last 1G run test d went red on the clean tree after being green. A flaky test must not ship.
1. Run `tests/dm-v2-wire-browser-paths.test.mjs` test d ALONE 10 times (same command each time). Table:
   run | pass/fail | failure line | elapsed. 
2. Find the cause from the failing runs (wait that is not a postcondition poll, the harness double-send,
   an `id` assumption, reliance on the 1500 ms composer-clear window). Fix it in the TEST ONLY: poll on the
   exact postcondition (stored envelope's `msgId` differs from the original AND the same row id, bob's bubble
   text equals the new text), never a fixed sleep. Re-run 10 times; all must pass.
3. If the cause is in production code, STOP and report; do not fix it.

## 3. Make (g) really pin the once-per-load rule (small, node-only)

Plant g stayed green because the browser test cannot call the notice twice. Add a node test in
`tests/dm-v2-wire.test.mjs` that calls `takeDmDowngradeNotice(peerId)` twice for the same peer and asserts
true then false, a different peer gets its own true, and a fresh page load (reset of module state or a new
store) gives true again. Plant: make it always return true -> RED. Then restore.

## 4. Part A ter (now justified)

e1-e4 are reproduced independently on Linux (section 0), so marking them is honest.
1. Add `{ todo: 'KNOWN GAP: whole-conversation history load fails on one undecryptable row, see STEP_1G Part B' }`
   to e1-e4 only. No assertion weakened. They must still run and still report.
2. Suite three ways on the same 72-file set + the new files: (i) wire-final-25 baseline, (ii) env=1,
   (iii) default. (ii) and (iii) must be 0 fail, 0 cancelled; todo tests count as todo.
3. Verify the ZIP, not the tree: `git archive`, unzip in a clean directory, there run
   `node scripts/build-sw-manifest.mjs --check`, `grep -rlc $'\r' public/` (expected empty),
   `node --test tests/sw-manifest.test.mjs`, the new browser file, and `tests/dm-v2-wire.test.mjs`.
4. Zip `wire-final-26`: sha256, bytes, entries, `unzip -l | grep` for the new test files, the docs and the
   `tests/_reference/` file.

## 5. Report, then STOP

1. Item 1 tables and the verdict on A2/A3. 2. Item 2 ten-run tables before/after. 3. Item 3 red/green.
4. Item 4 counts and zip verification. 5. Everything not done, with the reason.
6. Part B stays locked until the reviewer writes "GO B". STOP.

Notes carried over (unchanged): PowerShell variable names are case-insensitive (`$R` and `$r` collide);
do plants with Python and LF and verify the restore with `git diff --stat` and CR=0.
