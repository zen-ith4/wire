# STEP 3E - Group attachments: bounded download, a limits endpoint, hostile-server tests, a Linux run recipe (flag stays OFF)

Put this file at `docs/agent-tasks/STEP_3E_AGENT_TASK.md`.
Base: `wire-final-37` (SHA256 `f72b0f9e7e234b7f1b39ef7692c5f80b5a19a0eaf6f48a1c1fabde2e995253fd`, 539 entries, 481 files, HEAD `2f2bceb`).
Output zip: `wire-final-38` (a NEW name; never re-emit the base name).

Rules for this step:
- One commit per item. Report each item in at most 5 lines.
- Do not write down a number you did not run. Do not mark anything "Verified" that you did not see. Paste raw output for every check.
- Read the code before you change it. Cite `file:line` for every claim about current behaviour.
- Do not weaken or delete a test. If an existing test must change, say which and why, and keep what it proves.
- A test that did not run is **BLOCKED**, never "passed".
- If a change outside the allowed paths is needed, STOP and report why.

Allowed to change: `public/js/chat/group-attachments.js`, `group.js`, `thread.js`, `public/js/media/` (only if item 1 needs it), `routes/groups.routes.js` and `controllers/groups.controller.js` (item 1 only), `config/constants.js` (read-only use; no new env var), `tests/`, `docs/`, `scripts/` (item 4 only), `public/sw-manifest.js` (regenerated).
Not allowed: `database/`, DM code and DM routes, a `v:3` envelope, flipping `GROUP_ATTACHMENTS_UI_ENABLED` to `true`, voice-message code.

---

## 1. Why this step exists

The 3D result was reviewed against the zip. Crypto, flag, lazy loading, envelope measurement and tests are sound. The review found one real gap in the receive path and one decision that 3D correctly stopped on. This step closes both and adds the tests that prove the receive path survives a hostile server.

---

## 2. Items

### Item 0. BUG: the ciphertext download is unbounded (memory exhaustion before any check)
Facts (re-verify with commands and paste them):
- `fetchGroupAttachmentCiphertext` in `public/js/chat/group-attachments.js` (around line 524) ends with `return new Uint8Array(await res.arrayBuffer())`. It reads the **whole body into memory first**. The hash/length checks of `decryptAttachmentForGroup` run only afterwards.
- The signed `att_len` is known **before** the download (it is in the verified binding and the placeholder already shows it). The expected ciphertext length is exactly `att_len + 16`.
- The threat model includes a hostile or compromised server, and a malicious group member can also sign a huge `att_len`. Today a server can answer with an endless or multi-GB body, or a lying `Content-Length`, and the client buffers it all before rejecting it. The auto-load limit (5 MB) is applied from the signed size, but nothing enforces that the server really sends that many bytes.
What to do:
- Before any fetch: refuse when the signed `att_len` is larger than a named client maximum (`MAX_GROUP_ATTACHMENT_PLAINTEXT_BYTES`, default from the client cap used for upload, i.e. `DEFAULT_GROUP_ATTACHMENT_UPLOAD_MAX_MB * 1024 * 1024`) -> per-row "Attachment unavailable" (reason `attachment-mismatch`), no request sent.
- After the response headers: if `Content-Length` is present and is not exactly `att_len + 16` -> abort the request, do not read the body, same placeholder.
- While reading: read with `res.body.getReader()` into a preallocated buffer of exactly `att_len + 16` bytes; if the stream delivers more than that, **abort immediately** (`reader.cancel()` / the `AbortController`), if it delivers fewer at the end, treat as mismatch. If `res.body` is not available in an environment, fall back to a bounded path and say which environments hit it (cite where `Response.body` is unavailable, or say none).
- Everything else is unchanged: row iv vs signed iv (bytes), length, hash, decrypt, claim the nonce only after a successful decrypt. An aborted download must not claim the nonce and must revoke nothing it did not create.
- Tests (real modules, a hostile fetch stub, no browser needed): (a) endless stream -> aborted after `att_len + 16` bytes, the stub confirms it stopped being read; (b) lying `Content-Length` (too big, too small) -> aborted before reading the body; (c) body too short -> mismatch; (d) `att_len` above the client maximum -> no request at all (assert the stub was never called); (e) honest body -> plaintext recovered; (f) the nonce is unclaimed in every failure case. Mutation: remove the bound, the test must fail, restore.
- Add one browser scenario (system Chrome is acceptable, print the engine line): hostile relay answers with a 100 MB body for a 1 KB file -> "Attachment unavailable" and the page's memory/`performance` does not balloon (assert on bytes actually read inside the page, as 3D did for the queue).

### Item 1. The limits endpoint for groups (3D stopped here; the owner decision is made: option (a))
Decision: add `GET /api/groups/limits` returning `{ upload_max_mb }`, mirroring DM (`routes/dm.routes.js:31`, `controllers/dm.controller.js:326`, client side `public/js/media/attachment-e2ee.js:288-303`).
- Read those three places first and mirror their behaviour: authentication, the group protocol gate (`X-Wire-Group-Proto`), response shape, caching headers. The value is `constants.GROUP_UPLOAD_MAX_MB`. No new env var, no schema change.
- Does it need group membership? It does not depend on a group, so mirror DM (user-level, authenticated). Say what you chose and cite why.
- Client: fetch it once per session (memoised, same pattern as DM), use it for the upload pre-check (`prepareGroupAttachmentUpload` `maxMb`) and for the item 0 maximum. If the request fails, fall back to the named default **and** let the server stay the authority (it will reject anyway). Never trust a value above the compiled-in hard ceiling you define (a hostile server must not be able to raise the client's own memory bound beyond it; name the constant and test it).
- Tests: a real-server test of the endpoint (auth required, shape, value follows `GROUP_UPLOAD_MAX_MB`); client tests: a smaller server cap makes the client refuse before encrypting (assert the counter did not move), a failing endpoint falls back, a value above the hard ceiling is clamped.
- `routes/` diff must be only the one route line; show `git diff` for it.

### Item 2. Hostile-server tests for the whole receive path (tests only, no new behaviour unless a test finds a bug)
Write `tests/groups/group-attachment-hostile.test.mjs`. Each row is a test; every negative test has a positive control and a mutation run (remove the check, the test fails, restore). Report which rows already passed without any code change and which found a bug.

| Scenario | Expected |
|---|---|
| the server returns 404 / 500 for the blob | per-row retry affordance, other rows unaffected, nonce unclaimed |
| the server serves a truncated blob | "Attachment unavailable", no retry loop |
| the server serves the blob of an **older** message under a newer one (same group, same sender) | "Attachment unavailable" |
| the server re-serves the same blob under a **fresh message id** (replay) | rejected by the nonce set; the original row stays |
| the member who signed the message was removed and the Sender Key rotated while the row is still loading | outcome stated in the test (renders from the old key or placeholder), never a crash, never a wrong-key decrypt |
| the thread is closed while a download is in flight | request aborted, blob URL not created, queue slot released |
| the same message is delivered twice (live + history) | one row, one download |
| `att_*` present but the row has no file / the file exists but the envelope has no `att_*` | placeholder, no throw |
| an image whose bytes sniff as PNG but whose signed meta says `application/pdf` | decided and tested: render by sniffed type, say so in the doc; and the reverse (meta says PNG, bytes are HTML) -> download only |
| 50 attachment messages arrive in one history page | at most 2 downloads in flight; a total **auto-load byte budget** per thread view (name a constant, for example 20 MB) stops further auto-loads and leaves the rest as "Download (X MB)" clicks |

The last row is a small behaviour change allowed in this item: implement the per-thread auto-load budget in the loader, test it, and document it. A flooding group member must not be able to make every other member's client download 5 MB for each of hundreds of messages.

### Item 3. Doc corrections from the 3D review
- `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md`: tick the two items that 3E closes (limits endpoint, bounded download) and keep the Linux browser run as the open item.
- State in the flip doc, in plain words, that the **receive path is not behind the flag**: a group member on a flagged-off build can still make receivers download small images (that is why item 2 bounds auto-load). Cite `group.js:309`.
- Re-check every `file:line` citation in the three docs that mention group attachments; update the ones that moved.

### Item 4. A Linux browser-run recipe for a Windows owner (docs + one script; cannot be verified here)
The owner has Windows only, so the project's Chromium (`@sparticuz/chromium`, a Linux binary) has never run. Write `docs/RUN_BROWSER_TESTS_LINUX.md` with two routes, each a copy-paste command list:
1. **WSL2 (Ubuntu)**: install Node 22, clone/copy the tree to the Linux filesystem (not `/mnt/c`), `npm ci`, run the nine+ group browser tests with the exact command from the flip doc, and what the first TAP lines must say (`# browser: chromium (@sparticuz/chromium) ...`).
2. **Docker**: a `docker run` one-liner (official `node:22` image, bind-mount the tree read-only to a copy, `npm ci`, run the tests) and the system libraries the Chromium binary needs on a slim image if any (check `docs/BROWSER_TEST_ISOLATION.md` and the harness for what it already assumes; cite it).
Add `scripts/run-browser-tests-linux.sh` that does the Docker route in one command and exits non-zero on any failure. The script and the doc are **Unverified** in your report unless you actually ran them on Linux; say so. Do not claim they work.

### Item 5. Manifest, docs, zip
- Regenerate `public/sw-manifest.js`; `--check` must say current. CR check with python (not `grep $'\r'` in `sh`).
- Build `wire-final-38` as before (hash, entry count, clean-unzip `manifest --check`, copy, verify).

---

## 3. Acceptance checklist (paste raw output)

- [ ] `node --check` on every touched JS file -> rc=0
- [ ] Item 0: the six test results, the mutation run (fail without, pass with), the browser scenario with the engine line
- [ ] Item 1: the one-line `routes/` diff, the real-server endpoint test, the client tests (clamp, fallback, counter did not move)
- [ ] Item 2: the table above filled in with PASS-without-change / BUG-FOUND-AND-FIXED per row, the mutation outputs, the auto-load budget test
- [ ] Browser tests: raw output with the `# browser:` line, or BLOCKED with the exact reason
- [ ] Full non-browser suite in both modes (with and without `--env-file=tests/test.env`): previous baseline `698 / 695 / 0 / 0 / 3 / 0` plus exactly the number of new tests, 0 fail, same 3 skipped
- [ ] DM and Drive test files still green (paste the counts)
- [ ] `C3-12` still green; paste its result
- [ ] `node scripts/build-sw-manifest.mjs --check` -> current; CR files in `public/` -> 0
- [ ] `git diff --name-only 2f2bceb..HEAD`: only allowed paths; `database/`, DM files, `config/` (except read-only use) zero diff (paste `git diff --stat`)
- [ ] `GROUP_ATTACHMENTS_UI_ENABLED` is still `false` (paste the line)
- [ ] Spot-check five `file:line` citations with `sed -n`
- [ ] New zip block: NAME, SHA256, BYTES, ENTRIES, files, HEAD, branch, tree state, copied and hash-verified

## 4. Report format

1. Zip block.
2. Per item, at most 5 lines, with commit hash.
3. The item 2 table, filled in.
4. Raw acceptance output.
5. **Verified / Unverified / BLOCKED**, and for browser results the engine and OS that ran them. The Linux recipe is Unverified unless it ran on Linux.
6. Things found and not hidden.

## 5. Do not

- Do not flip the flag. Do not add voice code.
- Do not buffer a response body without a bound.
- Do not raise any limit because a server value says so; the client has its own hard ceiling.
- Do not add a decrypt path that bypasses the verified binding.
- Do not touch DM code, the DB schema or other routes.
- Do not weaken or delete a test.

## STOP
After the zip and the report, stop. Flipping the flag happens only after the checklist in `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md` is ticked, including the Linux browser run (see `docs/RUN_BROWSER_TESTS_LINUX.md`).
