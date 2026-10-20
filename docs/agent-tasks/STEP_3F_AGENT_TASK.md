# STEP 3F - Group attachments: Linux findings (test 6, flaky 2/3, DM c1), then a real Linux run (flag stays OFF)

Put this file at `docs/agent-tasks/STEP_3F_AGENT_TASK.md`.
Base: `wire-final-38` (SHA256 `02086b0cce504139c35467ec7883039e62c26e8b7eeb8d9a1f442b9d97bcaee2`, 545 entries, 487 files, HEAD `a142008`).
Output zip: `wire-final-39` (a NEW name; never re-emit the base name).

Rules for this step:
- One commit per item. Report each item in at most 5 lines.
- Do not write down a number you did not run. Do not mark anything "Verified" that you did not see. Paste raw output for every check.
- Read the code before you change it. Cite `file:line` for every claim about current behaviour.
- Do not weaken or delete a test to make it green. If a test is wrong, say why with evidence and fix what it proves.
- A test that did not run is **BLOCKED**, never "passed".
- If a change outside the allowed paths is needed, STOP and report why.

Allowed to change: `public/js/chat/` (group files only), `public/js/files/upload.js` and `composer.js` only if item 0 proves the bug is there, `tests/`, `tests/_acceptance-harness.mjs` (item 1 only), `scripts/`, `docs/`, `public/sw-manifest.js` (regenerated).
Not allowed: `database/`, DM code (item 2 may only TRIAGE DM; any DM fix is a STOP and a report), routes, flipping `GROUP_ATTACHMENTS_UI_ENABLED`, voice code.

---

## 1. Why this step exists

The 3E result was re-run by the reviewer on **Linux** with the project's own browser (`@sparticuz/chromium` 153.0.0, `puppeteer-core` 25.14.0, engine line `HeadlessChrome/153.0.8010.0`). Findings:

1. `tests/groups/group-attachment-browser.test.mjs` test **6** ("the sanitised name is used for BOTH ...") **fails deterministically on Linux**: `Waiting for selector '#group-staging-area .attach-chip' failed` (about 29 s). With a plain name (`plain-name.pdf`) the staging step works, so the failure is specific to the hostile name `.bashrc\u202Egnp.pdf` (leading dot + U+202E). It passed on Windows with system Chrome, so that pass may have been **vacuous** (the OS or the browser may have altered the name, so the bidi path never ran there).
2. In one sequential full run, tests **2** and **3** failed (`Node is detached from document`; "the row whose file was swapped must show the placeholder") and the rest were cancelled by a 280 s timeout. Run **alone**, tests 2, 3, 7, 8, 9, 10 all passed (each takes 26-38 s). So the failures are either flakiness under load or a real race.
3. In a full-suite run on Linux, `tests/dm-v2-attachments-browser.test.mjs` test `c1` ("an attachment sent AS a reply to a text message: stored reply_to_id equals the parent, bob sees the quote") failed with `0 !== 2`. That is DM code, not group code. Unknown whether it is old, environmental, or caused by 3C-3E.

The Windows results of 3C-3E remain "system Chrome, Windows". Nothing about them is wrong, but they are not enough to flip the flag.

---

## 2. Items

### Item 0. Test 6: find out why the chip does not appear with the hostile name (Linux)
Do not change the test first. Find the cause, with evidence:
- Reproduce on Linux (or say you cannot and use item 3's recipe). Print what the page sees: `input.files[0].name` (as JS strings with code points, e.g. `[...name].map(c => c.codePointAt(0).toString(16))`), whether the `change` event fired, whether `composer.js` staged anything, and any console/page errors.
- Decide which of these it is and prove it: (a) Chromium on Linux drops or rejects the file in the input; (b) the file was never written with that name by `fixture()` on Linux; (c) the composer's staging code rejects the name or the file (cite the line); (d) a different error is swallowed. Check the Windows case the same way: did the name keep U+202E when system Chrome read it? Print the code points there too if you can run it.
- Outcome rules:
  - If the app rejects or breaks on a name that a real user can legitimately have, that is a **product bug**: fix it in the group path only, with a regression test. Sender-side the name is metadata; a name with bidi characters must still send (the receiver sanitises it, 3D item 1).
  - If the OS or browser cannot carry that name through a file input, the test setup is wrong: keep **both** halves of the property but make them honest: (1) a browser test that sends a **plain** file but injects the hostile name through the **signed meta** (build the group message with the real send path with a controlled `file.name`, for example by constructing a `File` object with that name in the page via `DataTransfer`), and (2) the existing node-level sanitiser tests. State in the report which half exercised the real bidi path.
- The final test must fail if the receiver stops stripping U+202E (mutation run: remove U+202E from `STRIP_RE`, the test must fail, restore).

### Item 1. Tests 2 and 3 and the sequential run: flaky or real race?
- Run the full group browser file **three times in a row on Linux** with a timeout large enough for 10 tests (set `--test-timeout` to at least 600000 and the runner timeout accordingly; each test needs about 40 s on a slow machine). Record per-test pass/fail for each run in a table.
- For any test that fails once and passes later, capture the page state at failure (screenshot to a temp path, the DOM of `#group-messages`, console errors, and the fetch log if the test has one) and find the cause. `Node is detached from document` means the test held an element handle across a re-render: the thread repaint (3D item 2) rebuilds rows. Fix the **test** by re-querying after the repaint settles (wait for a stable state, not a `sleep`), unless you find the app removes the row at a wrong time; then it is a product bug (say so).
- Test 3's failure ("the row ... must show the placeholder") may be a race between the lazy loader and the assertion. Prove which: wait on an observable end state (the row has a terminal status attribute) rather than a time.
- Isolation: check whether each test really gets a fresh browser context and a fresh server data dir; if tests share state or leak processes (pages, servers), fix the harness (`tests/_acceptance-harness.mjs`) so a failure cannot cascade. Report the number of Chromium processes alive after the file ends (`pgrep`-style) and fix leaks.
- Acceptance: three consecutive green runs of the whole file on Linux (10/10 each), raw TAP shown, with the engine line.

### Item 2. Triage DM `c1` (read and measure; do not fix DM in this step)
- Run `tests/dm-v2-attachments-browser.test.mjs` test `c1` alone on Linux three times, and on the **3D base** (`wire-final-37`, HEAD `2f2bceb`) and the **3C base** (`wire-final-36`, HEAD `ed585ee`) trees if you can extract them from git (`git worktree` or `git archive`), and the 3A base if needed, to find the first commit where it fails, or show it fails at all of them. Use `git bisect run` if the range is small.
- Answer: old (failed before STEP 3C), caused by 3C-3E (name the commit and file), or environmental (Linux only; say what differs from Windows). Quote the assertion and the line.
- If the cause is in files this step touched (`composer.js`, `upload.js`, the 3C `extraHeaders` / `uploadHeaders` hooks), that is a regression: fix it in item 2 with a test. If it is DM-only or environmental, STOP and report with the evidence; do not touch DM.

### Item 3. Run the Linux recipe for real, or say it was not run
- `docs/RUN_BROWSER_TESTS_LINUX.md` and `scripts/run-browser-tests-linux.sh` were written in 3E and never executed. If this environment has Linux (WSL, Docker or a native host), run them and fix whatever breaks: exact errors, exact fixes. Known risk: the script mounts a named volume (`-v "$WORK:/work"` with `WORK=wire-browser-tests`), starts with `rm -rf /work/tree`, and on Windows Git Bash the path conversion of `$TREE` can break the bind mount; recommend WSL2 explicitly in the doc.
- If you ran it: paste the first 20 lines and the last 30 lines of the raw output. If you did not, say **NOT RUN** and why. Do not edit the doc to claim it works.
- Add to the doc the exact versions that are known to work together on Linux: `puppeteer-core@25.14.0` and `@sparticuz/chromium@153.0.0` (the reviewer installed this pair and it launched), and the observed engine line.
- Run the full non-browser suite on Linux (`node scripts/run-tests.mjs`) to the end, in both modes (with and without `--env-file=tests/test.env`) and paste the summary lines. Note that the runner picks up the browser tests automatically when `/tmp/browser-check` exists; say which mode you ran. The previous Windows baseline is `721 / 718 / 0 / 0 / 3 / 0`; explain any difference on Linux.

### Item 4. The client hard ceiling (50 MB): present the options, do not decide
3E clamps the server's cap to a client ceiling of 50 MB, so a server configured above 50 MB produces files that the server accepts and receivers refuse. Write a short section in `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md`: (a) keep 50 MB and refuse above it at the server too (cap `GROUP_UPLOAD_MAX_MB` at the ceiling in `config/`; show the one-line change but do not make it), (b) raise the ceiling to a named number with the memory cost at that number (the loader holds ciphertext and plaintext, about 2x; say the peak for 50, 100 and 200 MB), (c) make receivers stream-decrypt in chunks (a protocol change, out of scope). Give a recommendation in one line. Do not change code.

### Item 5. Manifest, docs, zip
- If `public/` changed, regenerate `public/sw-manifest.js`; `--check` must say current. CR check with python (not `grep $'\r'` in `sh`).
- Update status lines and re-check every `file:line` citation in the group-attachment docs.
- Build `wire-final-39` as before (hash, entry count, clean-unzip `manifest --check`, copy, verify).

---

## 3. Acceptance checklist (paste raw output)

- [ ] `node --check` on every touched JS file -> rc=0
- [ ] Item 0: the code-point printout from the page (Linux), the stated cause with a cited line, the fix or the honest test, the mutation run (fail without U+202E stripping, pass with)
- [ ] Item 1: the 3-run table (10 tests x 3 runs), the cause of every failure seen, the leaked-process count before and after
- [ ] Item 2: the c1 results per tree/commit, the bisect or the per-tree table, the stated cause
- [ ] Item 3: raw output of the recipe run, or NOT RUN with the reason; the Linux full-suite summary in both modes
- [ ] Browser tests: raw TAP with the `# browser:` line naming `chromium (@sparticuz/chromium)` (Linux). Results from system Chrome do not count for this checklist
- [ ] DM and Drive test files still green (paste the counts), `C3-12` green
- [ ] `node scripts/build-sw-manifest.mjs --check` -> current; CR files in `public/` -> 0
- [ ] `git diff --name-only a142008..HEAD`: only allowed paths; `database/`, `routes/`, DM files zero diff (paste `git diff --stat`)
- [ ] `GROUP_ATTACHMENTS_UI_ENABLED` is still `false` (paste the line)
- [ ] Spot-check five `file:line` citations with `sed -n`
- [ ] New zip block: NAME, SHA256, BYTES, ENTRIES, files, HEAD, branch, tree state, copied and hash-verified

## 4. Report format

1. Zip block.
2. Per item, at most 5 lines, with commit hash.
3. The 3-run table and the c1 table.
4. Raw acceptance output.
5. **Verified / Unverified / BLOCKED**, with engine and OS for every browser result. A test that passed only on Windows system Chrome is labelled as such.
6. Things found and not hidden, including any case where an earlier "Verified" claim turned out to be vacuous.

## 5. Do not

- Do not flip the flag. Do not add voice code.
- Do not weaken, delete or skip a test to get a green run; do not raise timeouts as the only "fix" for a race.
- Do not claim the Linux recipe works unless it ran.
- Do not touch DM code, the DB schema or routes.
- Do not change the 50 MB ceiling or `config/` in this step (item 4 is a recommendation only).

## STOP
After the zip and the report, stop. The flag may be flipped only when the checklist in `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md` is ticked: three green Linux runs (item 1), `c1` explained (item 2), the Linux suite summary (item 3), and the owner's decision on item 4.
