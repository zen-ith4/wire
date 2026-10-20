# `sleep()` used as synchronisation in the tests: inventory

Generated from the tree at `b87c0fb` by a script (STEP 3F follow-up 3.B). The **class** column is a HEURISTIC from the surrounding lines, not a reviewed verdict: treat "SYNC" as "read this site and replace the sleep with a poll on the exact postcondition (rule: never sleep to wait for state)".

Fixed in 3.B (their remaining sleeps are listed below with the reason they stay):

- `tests/dm-v2-attachments-browser.test.mjs`: every reply call goes through `replyTo()` (retried until `#dm-reply-preview.active .reply-preview-body` exists); every DB read after a send polls `newRow()` for a row newer than the id captured before the send (the fixture DB is not empty, so a `.chat-msg >= 1` wait was already true); every post-open `sleep(2500/3000)` is `threadSettled()` on the exact end state. 43 -> 7 sleeps.
- `tests/dm-v2-wire-browser-paths.test.mjs`: both `replyToDmMessage` calls go through `enterReplyMode()` (same postcondition). The `editDmMessage` site already asserts `is-editing`.
- `tests/groups/group-attachment-browser.test.mjs`: test 3 polls `groupAttachmentRowState()` instead of `sleep(2500)` + a group re-open (3.A); test 4 used `window.replyToGroupMessage`, which does not exist (so no quote was ever made) - it now uses `window.threadReply` polled until the reply preview is up and asserts on `.reply-quote`; test 2's text send and test 9's click poll their end state.

Every `replyToDmMessage` / `editDmMessage` call in `tests/` and what precedes it:

| site | precedes it | postcondition checked |
|---|---|---|
| dm-v2-attachments-browser `replyTo()` (c1, c2, c2b, e4) | `newRow()` (parent stored) | reply preview active (polled) |
| dm-v2-wire-browser-paths (b) | `openDmUi` + `waitDecrypted(1)` | reply preview active (polled) |
| dm-v2-wire-browser-paths (d) reply | `openDmUi` + `waitDecrypted(1)` | reply preview active (polled) |
| dm-v2-wire-browser-paths (d) edit | `waitDecrypted(2)` | `is-editing` asserted once (a miss fails loudly) |
| dm-v2-protocol-e2e test 10 | - | skipped (superseded by the browser test) |

## Counts by class

| class | sites |
|---|---|
| SYNC - should poll an exact postcondition | 125 |
| negative wait (absence over a window) | 9 |
| teardown pause | 6 |
| poll primitive | 3 |
| definition | 1 |
| **total** | **144** |

## Every site

| file:line | class | the line before | the sleep |
|---|---|---|---|
| `tests/_acceptance-harness.mjs:34` | poll primitive | `if (Date.now() > end) return false;` | `await sleep(step);` |
| `tests/_acceptance-harness.mjs:545` | SYNC - should poll an exact postcondition | `await page.click('[data-action="group-send"]');` | `await sleep(1500);` |
| `tests/_acceptance-harness.mjs:556` | SYNC - should poll an exact postcondition | `await page.waitForSelector('.dm-layout #dm-conv-list', { timeout: 20000 });` | `await sleep(600);` |
| `tests/_acceptance-harness.mjs:558` | SYNC - should poll an exact postcondition | `const open = () => page.evaluate((id, name) => window.openDmConversation(id, name, { fromN` | `try { await open(); } catch { await sleep(1500); await open(); }` |
| `tests/_reference/probe-attachment-v2.mjs:19` | SYNC - should poll an exact postcondition | `await page.click('#auth-form button');` | `await page.waitForSelector('.nav-link', { timeout: 60000 }); await sleep(500);` |
| `tests/_reference/probe-attachment-v2.mjs:43` | negative wait (absence over a window) | `await a.page.waitForFunction((n) => document.querySelectorAll('#dm-thread .chat-msg').leng` | `await sleep(800);` |
| `tests/_reference/probe-attachment-v2.mjs:55` | SYNC - should poll an exact postcondition | `await openDmUi(b.page, 2, 'alice');` | `await sleep(2500);` |
| `tests/_reference/probe-tamper-rows.mjs:17` | SYNC - should poll an exact postcondition | `await page.waitForSelector('.nav-link', { timeout: 60000 });` | `await sleep(500);` |
| `tests/_reference/probe-tamper-rows.mjs:24` | SYNC - should poll an exact postcondition | `await page.waitForFunction(() => document.getElementById('dm-input').value === '', { timeo` | `await sleep(300);` |
| `tests/_reference/probe-tamper-rows.mjs:62` | SYNC - should poll an exact postcondition | `await openDmUi(b.page, 2, 'alice');` | `await sleep(3000);` |
| `tests/acceptance-no-plaintext.test.mjs:109` | SYNC - should poll an exact postcondition | `assert.ok(await socketConnected(page), 'alice socket connected');` | `await sleep(800);` |
| `tests/acceptance-no-plaintext.test.mjs:152` | SYNC - should poll an exact postcondition | `const grpMsgs = Array.isArray(grpRecent.body) ? grpRecent.body : grpRecent.body?.messages ` | `await sleep(1200); // let the server flush` |
| `tests/acceptance-no-plaintext.test.mjs:169` | SYNC - should poll an exact postcondition | `reject.nonMember = await upload(sess.carol.token, { attachment_iv: 'AAAAAAAAAAAAAAAA' });` | `await sleep(500);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:77` | SYNC - should poll an exact postcondition | `});` | `await sleep(150);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:98` | SYNC - should poll an exact postcondition | `const n = await page.evaluate(() => { const els = [...document.querySelectorAll('[onclick*` | `await sleep(1200);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:146` | SYNC - should poll an exact postcondition | `assert.ok(await socketConnected(page), 'alice socket connected');` | `await sleep(800);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:214` | SYNC - should poll an exact postcondition | `await openDmUi(pg, peerId, peerName);` | `await sleep(1500);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:217` | SYNC - should poll an exact postcondition | `await openGroupUi(pg, gid);` | `await sleep(1500);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:220` | SYNC - should poll an exact postcondition | `await pg.click('[data-action="group-settings"]');` | `await sleep(1200);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:224` | SYNC - should poll an exact postcondition | `await pg.evaluate(async (id) => { const m = await import('/js/ui/profile-card.js'); await ` | `await sleep(1200);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:227` | SYNC - should poll an exact postcondition | `await pg.keyboard.press('Escape'); // profile-card.js closes on Escape; an open card would` | `await sleep(400);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:230` | SYNC - should poll an exact postcondition | `await openDmUi(pg, extraPeer.id, extraPeer.name);` | `await sleep(1500);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:236` | SYNC - should poll an exact postcondition | `await openDmUi(page, sess.bob.id, names.bob);` | `await sleep(1500);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:243` | SYNC - should poll an exact postcondition | `assert.ok(await socketConnected(hPage), 'hostile user socket connected');` | `await sleep(2500);` |
| `tests/acceptance-xss-sweep-browser.test.mjs:253` | SYNC - should poll an exact postcondition | `assert.ok(await socketConnected(bobPage), 'bob socket connected');` | `await sleep(2500); // pending group key distributions` |
| `tests/acceptance-xss-sweep-browser.test.mjs:256` | SYNC - should poll an exact postcondition | `await openDmUi(bobPage, sess.alice.id, names.alice);` | `await sleep(1500);` |
| `tests/credentials/f12-browser-login.test.mjs:69` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { ti` | `await sleep(500);` |
| `tests/credentials/f12-browser-login.test.mjs:88` | negative wait (absence over a window) | `await page.waitForFunction(() => true);` | `for (let i = 0; i < 40 && bodies(log, '/api/auth/migrate-credentials').length === 0; i++) ` |
| `tests/credentials/f12-browser-login.test.mjs:135` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { ti` | `await sleep(500);` |
| `tests/credentials/f12-browser-login.test.mjs:215` | SYNC - should poll an exact postcondition | `assert.ok(!log.some((r) => r.body.includes(longPw)));` | `await sleep(500);` |
| `tests/credentials/f12-browser-login.test.mjs:313` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#forced-change-form button'), page.waitForSelector('.nav-li` | `await sleep(600);` |
| `tests/credentials/f12-browser-login.test.mjs:348` | SYNC - should poll an exact postcondition | `await page.evaluate(() => window.addUser());` | `for (let i = 0; i < 60 && !row("SELECT 1 AS x FROM users WHERE username = 'uihire'"); i++)` |
| `tests/csp-confirm-enforced-browser.test.mjs:132` | poll primitive | `if (Date.now() > end) return false;` | `await sleep(step);` |
| `tests/csp-confirm-enforced-browser.test.mjs:189` | SYNC - should poll an exact postcondition | `assert.ok(await waitFor(() => page.evaluate(async () => (await import('/js/core/socket.js'` | `await sleep(1000);` |
| `tests/csp-confirm-enforced-browser.test.mjs:202` | negative wait (absence over a window) | `await page.waitForSelector('#confirm-modal.active', { timeout: 8000 });` | `await sleep(250);` |
| `tests/csp-confirm-enforced-browser.test.mjs:216` | SYNC - should poll an exact postcondition | `await page.click('.nav-link[data-view="messages"]');` | `await sleep(600);` |
| `tests/csp-confirm-enforced-browser.test.mjs:234` | SYNC - should poll an exact postcondition | `await page.hover('#dm-thread .chat-msg').catch(() => {});` | `await sleep(300);` |
| `tests/csp-confirm-enforced-browser.test.mjs:285` | SYNC - should poll an exact postcondition | `await page.click('[data-action="group-send"]'); // delegated listener, group.js:498 / :739` | `await sleep(1500);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:105` | SYNC - should poll an exact postcondition | `} catch { /* not up yet */ }` | `await sleep(500);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:131` | SYNC - should poll an exact postcondition | `if (Date.now() > end) assert.fail('timed out waiting for: ${label}');` | `await sleep(150);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:154` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#auth-username', { timeout: 20000 });` | `if (!(await page.$('#auth-password-confirm'))) { await page.click('#switch-auth'); await s` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:162` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#nav-links > *', { timeout: 40000 });` | `await sleep(2000);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:181` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#dm-input', { timeout: 15000 });` | `await sleep(800);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:239` | SYNC - should poll an exact postcondition | `await waitFor(() => dmRows(bId).length >= 1, 'a DM row for B after clicking Send');` | `await sleep(800);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:247` | SYNC - should poll an exact postcondition | `await waitFor(() => dmRows(cId).length >= 1, 'a DM row for C');` | `await sleep(800);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:254` | SYNC - should poll an exact postcondition | `await waitFor(() => dmRows(bId).length >= 2, 'the second DM row for B');` | `await sleep(800);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:282` | negative wait (absence over a window) | `await page.evaluate(() => window.__confirmModalCancel());` | `await sleep(500);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:314` | SYNC - should poll an exact postcondition | `await page.click('#confirm-modal-ok');` | `await sleep(400);` |
| `tests/dm-csp-handlers-enforced-browser.test.mjs:326` | SYNC - should poll an exact postcondition | `await page.click('#dm-input-area button[title="Attach"]');` | `await sleep(500);` |
| `tests/dm-v2-attachments-browser.test.mjs:36` (3.B file) | SYNC - should poll an exact postcondition | `await page.waitForSelector('.nav-link', { timeout: 60000 });` | `await sleep(500);` |
| `tests/dm-v2-attachments-browser.test.mjs:86` (3.B file) | poll primitive | `if (v \|\| Date.now() > end) return v;` | `await sleep(step);` |
| `tests/dm-v2-attachments-browser.test.mjs:269` (3.B file) | SYNC - should poll an exact postcondition | `// whether that 404 landed inside the window depended on timing (the old` | `// sleep(300) above hid it). Network idle (one request may stay open:` |
| `tests/dm-v2-attachments-browser.test.mjs:348` (3.B file) | SYNC - should poll an exact postcondition | `// whether that 404 landed inside the window depended on timing (the old` | `// sleep(300) above hid it). Network idle (one request may stay open:` |
| `tests/dm-v2-attachments-browser.test.mjs:436` (3.B file) | SYNC - should poll an exact postcondition | `await openDmUi(b.page, 2, 'alice');` | `await sleep(1500);` |
| `tests/dm-v2-attachments-browser.test.mjs:802` (3.B file) | teardown pause | `} finally {` | `await closeUserBrowsers(); await server.stop(); await sleep(800); try { cleanupTmp(); fs.r` |
| `tests/dm-v2-attachments-browser.test.mjs:858` (3.B file) | teardown pause | `} finally {` | `await closeUserBrowsers(); await server.stop(); await sleep(800); try { cleanupTmp(); fs.r` |
| `tests/dm-v2-attachments-browser.test.mjs:903` (3.B file) | teardown pause | `} finally {` | `await closeUserBrowsers(); await server.stop(); await sleep(800); try { cleanupTmp(); fs.r` |
| `tests/dm-v2-attachments-browser.test.mjs:963` (3.B file) | teardown pause | `} finally {` | `await closeUserBrowsers(); await server.stop(); await sleep(800); try { cleanupTmp(); fs.r` |
| `tests/groups/_roundtrip-helpers.mjs:10` | definition | `import assert from 'node:assert/strict';` | `export function sleep(ms) {` |
| `tests/groups/_roundtrip-helpers.mjs:21` | SYNC - should poll an exact postcondition | `if (socket.connected) return;` | `await sleep(25);` |
| `tests/groups/_scenario.mjs:120` | SYNC - should poll an exact postcondition | `if (v) return v;` | `await sleep(40);` |
| `tests/groups/group-attachment-browser.test.mjs:60` (3.B file) | teardown pause | `if (s) {` | `await Promise.race([s.stop().catch(() => {}), sleep(8000)]);` |
| `tests/groups/group-attachment-browser.test.mjs:69` (3.B file) | teardown pause | `// while to die, and the file-level test would wait for it.` | `await Promise.race([server?.stop().catch(() => {}), sleep(8000)]);` |
| `tests/groups/group-attachment-browser.test.mjs:138` (3.B file) | SYNC - should poll an exact postcondition | `await page.waitForFunction((n0) => document.querySelectorAll('#group-messages .chat-msg').` | `await sleep(500);` |
| `tests/groups/group-attachment-browser.test.mjs:162` (3.B file) | SYNC - should poll an exact postcondition | `await page.waitForFunction((n0) => document.querySelectorAll('#group-messages .chat-msg').` | `await sleep(500);` |
| `tests/groups/group-attachment-browser.test.mjs:522` (3.B file) | negative wait (absence over a window) | `// It must NOT have been auto-loaded.` | `await sleep(1500);` |
| `tests/groups/group-audit.test.mjs:88` | SYNC - should poll an exact postcondition | `if (v) return v;` | `await sleep(50);` |
| `tests/groups/group-audit.test.mjs:116` | SYNC - should poll an exact postcondition | `});` | `await sleep(800); // let Alice's client react to the real 'added' socket event` |
| `tests/groups/group-audit.test.mjs:210` | negative wait (absence over a window) | `await send(alice, secret);` | `await sleep(1200);` |
| `tests/groups/group-audit.test.mjs:239` | negative wait (absence over a window) | `await openG(alice, group.id); // KDMs for Bob now sit in the mailbox` | `await sleep(600); // Bob's client auto-drains on the real kdm-delivered event` |
| `tests/groups/group-audit.test.mjs:310` | SYNC - should poll an exact postcondition | `});` | `await sleep(600);` |
| `tests/groups/group-audit.test.mjs:401` | SYNC - should poll an exact postcondition | `await openG(a2, group.id); // no local key -> mints ANOTHER key with the same senderKeyId` | `await sleep(800);` |
| `tests/groups/group-audit.test.mjs:439` | SYNC - should poll an exact postcondition | `await openG(a2, group.id);` | `await sleep(800); // device one adopts device two's key via the shared mailbox` |
| `tests/groups/group-audit.test.mjs:568` | SYNC - should poll an exact postcondition | `sock.disconnect(); // hard disconnect: no connection-state recovery for a manual disconnec` | `await sleep(300);` |
| `tests/groups/group-audit.test.mjs:571` | negative wait (absence over a window) | `await send(alice, 'sent while bob was offline');` | `await sleep(300);` |
| `tests/groups/group-confirm-in-dialog-browser.test.mjs:111` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { ti` | `await sleep(800);` |
| `tests/groups/group-confirm-in-dialog-browser.test.mjs:144` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#confirm-modal.active');` | `await sleep(300);` |
| `tests/groups/group-csp-browser.test.mjs:96` | SYNC - should poll an exact postcondition | `await S.send(alice, 'markup for the browser');` | `await sleep(300);` |
| `tests/groups/group-csp-browser.test.mjs:99` | SYNC - should poll an exact postcondition | `d.querySelector('[data-action="group-settings"]').dispatchEvent(new w.MouseEvent('click', ` | `await sleep(600);` |
| `tests/groups/group-csp-browser.test.mjs:102` | SYNC - should poll an exact postcondition | `d.querySelector('[data-fab-action="group"]').dispatchEvent(new w.MouseEvent('click', { bub` | `await sleep(300);` |
| `tests/groups/group-csp-browser.test.mjs:140` | SYNC - should poll an exact postcondition | `});` | `await sleep(200);` |
| `tests/groups/group-csp-browser.test.mjs:156` | SYNC - should poll an exact postcondition | `}, markup);` | `await sleep(400);` |
| `tests/groups/group-dialog-create-settled-browser.test.mjs:115` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { ti` | `await sleep(800);` |
| `tests/groups/group-dialog-create-settled-browser.test.mjs:133` | SYNC - should poll an exact postcondition | `await page.mouse.click(box.x, box.y); // a click on the disabled button does nothing` | `await sleep(100);` |
| `tests/groups/group-e2e-browser.test.mjs:124` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { ti` | `await sleep(800);` |
| `tests/groups/group-e2e-browser.test.mjs:173` | SYNC - should poll an exact postcondition | `await page.click('#group-settings-close');` | `await sleep(300);` |
| `tests/groups/group-e2e-browser.test.mjs:180` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#confirm-modal.active');` | `await sleep(300);` |
| `tests/groups/group-e2e-browser.test.mjs:184` | SYNC - should poll an exact postcondition | `await page.click('#group-settings-close');` | `await sleep(300);` |
| `tests/groups/group-e2e-browser.test.mjs:223` | SYNC - should poll an exact postcondition | `await bob.page.waitForSelector('#confirm-modal.active');` | `await sleep(300);` |
| `tests/groups/group-e2e-browser.test.mjs:253` | SYNC - should poll an exact postcondition | `}` | `await sleep(800);` |
| `tests/groups/group-e2e-browser.test.mjs:288` | SYNC - should poll an exact postcondition | `}` | `await sleep(800);` |
| `tests/groups/group-first-send.test.mjs:112` | SYNC - should poll an exact postcondition | `assert.ok(await S.send(alice, 'one'), 'first send');` | `await sleep(200);` |
| `tests/groups/group-hardening-f1-crash.test.mjs:45` | SYNC - should poll an exact postcondition | `await S.addMember(alice, group.id, bob);` | `await sleep(600);` |
| `tests/groups/group-hardening-f1-crash.test.mjs:73` | SYNC - should poll an exact postcondition | `await S.addMember(alice, group.id, bob);` | `await sleep(600);` |
| `tests/groups/group-hardening-f4-replay.test.mjs:274` | SYNC - should poll an exact postcondition | `await st.claimNonce({ senderKeyId: 'cap-key', nonceHex: 'n${String(i).padStart(3, '0')}', ` | `await sleep(1);` |
| `tests/groups/group-hardening-f5-removal-race.test.mjs:118` | SYNC - should poll an exact postcondition | `await S.open(carol, g.id);` | `await sleep(300);` |
| `tests/groups/group-hardening-f5-removal-race.test.mjs:125` | SYNC - should poll an exact postcondition | `await S.removeMember(alice, g.id, carol);` | `await sleep(200);` |
| `tests/groups/group-hardening-f9-web-locks.test.mjs:65` | SYNC - should poll an exact postcondition | `await S.open(tab2, g.id);` | `await sleep(300);` |
| `tests/groups/group-hostile-browser.test.mjs:122` | SYNC - should poll an exact postcondition | `await Promise.all([page.click('#auth-form button'), page.waitForSelector('.nav-link', { ti` | `await sleep(800);` |
| `tests/groups/group-hostile-browser.test.mjs:132` | SYNC - should poll an exact postcondition | `}` | `await sleep(800);` |
| `tests/groups/group-hostile-browser.test.mjs:171` | SYNC - should poll an exact postcondition | `await alice.page.click('#group-settings-close');` | `await sleep(300);` |
| `tests/groups/group-hostile-browser.test.mjs:240` | SYNC - should poll an exact postcondition | `await page.waitForSelector('.grp-member-row', { timeout: 20000 });` | `await sleep(300);` |
| `tests/groups/group-kdm-recipient-scope.test.mjs:131` | SYNC - should poll an exact postcondition | `await openG(alice, groupA.id);` | `await sleep(400);` |
| `tests/groups/group-kdm-recipient-scope.test.mjs:137` | SYNC - should poll an exact postcondition | `await alice.group.handleGroupSocketConnected();` | `await sleep(600);` |
| `tests/groups/group-kdm-recipient-scope.test.mjs:143` | SYNC - should poll an exact postcondition | `await send(alice, marker);` | `await sleep(900);` |
| `tests/groups/group-kdm-recipient-scope.test.mjs:171` | SYNC - should poll an exact postcondition | `if (texts.some((t) => t.includes(marker))) { delivered = true; break; }` | `await sleep(150);` |
| `tests/groups/group-keys-contract.test.mjs:33` | SYNC - should poll an exact postcondition | `await s.mount(bob); await s.open(bob, group.id);` | `await sleep(300);` |
| `tests/groups/group-keys-contract.test.mjs:55` | SYNC - should poll an exact postcondition | `await s.addMember(alice, group.id, carol);` | `await sleep(800);` |
| `tests/groups/group-keys-contract.test.mjs:169` | SYNC - should poll an exact postcondition | `await s.open(carol, group.id);` | `await sleep(800);                       // existing members rotate and distribute to Carol` |
| `tests/groups/group-keys-contract.test.mjs:180` | SYNC - should poll an exact postcondition | `await s.removeMember(alice, group.id, carol);` | `await sleep(800);` |
| `tests/groups/group-keys-contract.test.mjs:184` | negative wait (absence over a window) | `assert.ok(await s.waitFor(bob, () => s.bubbles(bob).includes('secret after removal')), 're` | `await sleep(600);` |
| `tests/groups/group-multidevice.test.mjs:84` | SYNC - should poll an exact postcondition | `await S.open(dev2, group.id);` | `await sleep(600); // Bob reacts to device two's KDM fan-out over the real socket` |
| `tests/groups/group-multidevice.test.mjs:109` | SYNC - should poll an exact postcondition | `await S.open(dev2, group.id);` | `await sleep(600);` |
| `tests/groups/group-multidevice.test.mjs:187` | SYNC - should poll an exact postcondition | `await Promise.all([S.open(dana, group.id), S.open(tab2, group.id)]);` | `await sleep(500);` |
| `tests/groups/group-multidevice.test.mjs:222` | SYNC - should poll an exact postcondition | `await S.open(alice, group.id);` | `await sleep(500);` |
| `tests/groups/group-robustness.test.mjs:121` | SYNC - should poll an exact postcondition | `'control: group B shows its own "Load older" button');` | `await sleep(1200); // A's delayed response lands now, while B is on screen` |
| `tests/groups/group-robustness.test.mjs:147` | SYNC - should poll an exact postcondition | `await S.removeMember(alice, group.id, bob);` | `await sleep(400);` |
| `tests/groups/group-robustness.test.mjs:151` | SYNC - should poll an exact postcondition | `alice.socketMod.getSocket().emit('group:typing', { group_id: group.id });` | `await sleep(700);` |
| `tests/groups/group-robustness.test.mjs:163` | SYNC - should poll an exact postcondition | `await S.open(alice, group.id);          // Alice distributes a key to Bob and Carol` | `await sleep(400);` |
| `tests/groups/group-robustness.test.mjs:223` | SYNC - should poll an exact postcondition | `await S.mount(carol);` | `await sleep(300);` |
| `tests/groups/group-robustness.test.mjs:229` | SYNC - should poll an exact postcondition | `bob.socketMod.getSocket().disconnect();` | `await sleep(200);` |
| `tests/groups/group-robustness.test.mjs:232` | SYNC - should poll an exact postcondition | `await S.open(carol, group.id);` | `await sleep(800);` |
| `tests/groups/group-roundtrip.test.mjs:166` | SYNC - should poll an exact postcondition | `}` | `await sleep(50);` |
| `tests/groups/group-senderkeyid.test.mjs:99` | SYNC - should poll an exact postcondition | `let raw = null;` | `for (const deadline = Date.now() + 5000; Date.now() < deadline; await sleep(50)) {` |
| `tests/groups/group-signing-adversarial-ui.test.mjs:24` | SYNC - should poll an exact postcondition | `if (withCarol) await S.addMember(alice, g.id, carol);` | `await sleep(900);` |
| `tests/groups/group-signing-adversarial-ui.test.mjs:26` | SYNC - should poll an exact postcondition | `await S.open(alice, g.id);` | `await sleep(300);` |
| `tests/groups/group-signing-adversarial-ui.test.mjs:40` | SYNC - should poll an exact postcondition | `await S.open(S.users.bob, g.id);` | `await sleep(350);` |
| `tests/groups/group-signing-adversarial-ui.test.mjs:115` | SYNC - should poll an exact postcondition | `await S.open(alice, g.id);` | `await sleep(200);` |
| `tests/groups/group-signing-adversarial-ui.test.mjs:158` | SYNC - should poll an exact postcondition | `await S.open(carol, g.id);` | `await sleep(500);` |
| `tests/groups/group-signing-ui.test.mjs:25` | SYNC - should poll an exact postcondition | `await S.addMember(alice, g.id, mallory);` | `await sleep(900);` |
| `tests/groups/group-signing-ui.test.mjs:27` | SYNC - should poll an exact postcondition | `await S.open(alice, g.id);` | `await sleep(300);` |
| `tests/groups/group-signing-ui.test.mjs:46` | SYNC - should poll an exact postcondition | `await S.open(S.users.bob, g.id);` | `await sleep(200);` |
| `tests/groups/group-signing-ui.test.mjs:135` | SYNC - should poll an exact postcondition | `await S.open(bob, g.id);` | `await sleep(300);` |
| `tests/groups/group-signing-ui.test.mjs:163` | SYNC - should poll an exact postcondition | `await S.open(bob, g.id);` | `await sleep(300);` |
| `tests/groups/group-signing-ui.test.mjs:205` | SYNC - should poll an exact postcondition | `await bob.group.handleGroupKdmDelivered({ group_id: g.id });` | `await sleep(300);` |
| `tests/groups/group-signing-ui.test.mjs:232` | SYNC - should poll an exact postcondition | `await S.open(bob, g.id);` | `await sleep(150);` |
| `tests/groups/group-ui-security.test.mjs:79` | SYNC - should poll an exact postcondition | `await s.open(mallory, group.id);` | `await sleep(500);` |
| `tests/groups/group-ui-security.test.mjs:113` | SYNC - should poll an exact postcondition | `}` | `await sleep(500);` |
| `tests/groups/group-ui-security.test.mjs:225` | SYNC - should poll an exact postcondition | `await s.send(alice, 'hello csp');` | `await sleep(300);` |
| `tests/groups/group-ui-security.test.mjs:230` | SYNC - should poll an exact postcondition | `d.querySelector('[data-action="group-settings"]').dispatchEvent(new w.MouseEvent('click', ` | `await sleep(600);` |
| `tests/groups/group-ui-security.test.mjs:237` | SYNC - should poll an exact postcondition | `createBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));` | `await sleep(300);` |
| `tests/mobile-groups-tab-browser.test.mjs:82` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#bottom-nav .bottom-nav-item', { timeout: 30000 });` | `await sleep(800);` |
| `tests/mobile-groups-tab-browser.test.mjs:118` | SYNC - should poll an exact postcondition | `await page.waitForSelector('#bottom-nav .bottom-nav-item', { timeout: 30000 });` | `await sleep(800);` |
| `tests/port-hygiene.test.mjs:81` | SYNC - should poll an exact postcondition | `if (e?.code !== 'EADDRINUSE' \|\| i === tries - 1) throw e;` | `await sleep(120);` |
