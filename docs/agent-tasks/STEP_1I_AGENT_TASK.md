# STEP 1I - finish what 1H could not (flaky test, notice test, todo markers, suite, zip)

Put this file at `docs/agent-tasks/STEP_1I_AGENT_TASK.md`.
Base: your working tree after 1H. Output zip: `wire-final-26`. No production change in this step.

## How to work (your budget ran out twice)

Do the items in order. After EACH item: `git add -A && git commit -m "1I.N <what>"` with a clean tree check
(`git status --short` shows only what the item touched, CR=0 in every touched file), then paste the
evidence. If the budget ends mid-item, the previous items are already committed and reported. Report after
each item in 5 lines or fewer (command, output, verdict). Do not re-open anything listed in "Closed".
Before any run: `node -e "require('better-sqlite3')(':memory:')"` must print nothing; if it throws
"Could not locate the bindings file", run `npm rebuild better-sqlite3` and note it as infrastructure (it
recurred in 1H).

## Closed by the reviewer (do not redo; copy into `docs/DM_V2_WIRE.md` under "Observed on Linux")

Reviewer probe on Linux, wire-final-25, real Chromium, one stored row mutated through the test's own SQLite
connection (`changes=1`, read-back confirmed), bob re-login, open DM. Row position among the 3 v2 messages:

| mutation | first | middle | last |
|---|---|---|---|
| ciphertext char flipped | 0 bubbles, "Failed to load" | same | same (+ preview errors in console) |
| `version` 2 -> 1 | 0 bubbles, "Failed to load" + "Message authentication failed" | not run | same as first |
| `reply_to_id` NULL -> 1 | 0 bubbles, "Failed to load" | not run | not run |

6 of 9 cells were run, all consistent: the binding detects every tampered field, and one bad row makes the
whole history fail to load. The visible text is the error state of `loadDmMessages` (`dm.js:2077`,
`emptyState(..., 'Failed to load', e.message)`); for an AEAD failure the DOMException message is empty, so
only the title shows. The history-loader error is not logged to the console with its own prefix; only the
conversation-preview path logs `Failed to decrypt conversation preview`. That closes 1H items 1.3 and 1.5.
(Also record: A2/A3 in 1G were a harness bug, `SELECT content` without `id`, as you reported.)

## 1I.1 Flaky test (d) - the one that can break the zip

1. Run test d of `tests/dm-v2-wire-browser-paths.test.mjs` ALONE 10 times on the clean tree (same command each
   time, `--test-timeout=120000`). Table: run | pass/fail | first failure line | seconds.
2. Find the cause from the failing runs. Typical suspects: a wait that is not a postcondition poll, the harness
   `sendDmTextUi` double send (`dm.js` composer clear window 1500 ms; use your `sendOnce`), an assumption about
   row ids, reading the stored envelope before the edit request has finished.
3. Fix it in the TEST ONLY. Poll on exact postconditions: the stored row (same row id) has a `msgId` different
   from the original AND a new ciphertext, `reply_to_id` unchanged, and bob's bubble text equals the new text.
   No fixed sleeps. Run 10 times again; all 10 must pass. Paste both tables.
4. If the cause is in production code: STOP, report the evidence, do not fix it, and mark d with
   `{ todo: '<reason>' }` only if the reviewer agrees later.

## 1I.2 Pin the once-per-load notice (node, small)

In `tests/dm-v2-wire.test.mjs`: call `takeDmDowngradeNotice(peerId)` twice for the same peer -> `true`, `false`;
a different peer -> its own `true`; after a module-state reset (fresh store / re-import) -> `true` again.
Plant: make it always return true -> RED. Restore, GREEN. (The browser plant g could not pin this.)

## 1I.3 Mark the known gap honestly, then run everything

1. Add `{ todo: 'KNOWN GAP: one undecryptable row fails the whole history load, see STEP_1J Part B' }` to e1-e4 only
   in `tests/dm-v2-wire-browser-paths.test.mjs`. They still run and report; no assertion changes. Also add the
   same marker to any assertion-free vanishing-row test in `tests/dm-v2-vanishing-row.test.mjs` only if it would
   otherwise fail the suite; it is evidence, keep it green as written.
2. Suite three ways on the 72-file non-browser set + the new files: (i) wire-final-25 baseline, (ii)
   `DM_E2EE_DEFAULT_MIN_VERSION=1`, (iii) default. (ii) and (iii): 0 fail, 0 cancelled, todo counted as todo.
   Also run the whole new browser file once: all green except the todo items, and (d) from 1I.1 included.
3. Verify the ZIP, not the tree: `git archive --format=zip -o wire-final-26.zip HEAD`, unzip in a clean
   directory, there run `node scripts/build-sw-manifest.mjs --check`, `grep -rlc $'\r' public/` (expected
   empty), `node --test tests/sw-manifest.test.mjs tests/dm-v2-wire.test.mjs`, and the new browser file.
4. Report: sha256, bytes, entries, `unzip -l | grep` for `tests/dm-v2-wire-browser-paths.test.mjs`,
   `tests/dm-v2-vanishing-row.test.mjs`, `tests/_reference/`, `docs/agent-tasks/`.

## 1I.4 Report, then STOP

Items done / not done with the reason, the zip block, and the still-open list: Part B (STEP_1J, locked until the
reviewer writes "GO B"), UI on non-Chromium browsers and phones, anything not run on Linux by the reviewer.
