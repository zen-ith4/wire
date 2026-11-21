// tests/dm-own-messages-tab-switch-browser.test.mjs
//
// Regression (Bug 3): the current user's own DM messages showed up twice after
// leaving the conversation for another tab and coming back. A hard refresh
// showed them correctly; the server never stored them twice.
//
// Root cause, in the thread cache of public/js/chat/dm.js (the live DOM had a
// guard, the cache did not, so the duplicate only appeared when the thread was
// re-rendered FROM the cache - i.e. on returning to the conversation):
//   1. Every own send reaches addDmMessage() twice: the composer's HTTP
//      response AND the socket echo (emitNewDirectMessage fans out to the
//      sender's room too). Both passed the "already cached?" check before the
//      decrypt await, and both appended.
//   2. A message that arrived live before the thread was first opened was
//      cached, and the first history page then appended it again.
//
// Everything below goes through the real UI - the composer's Send button, the
// nav links and the conversation row - and the assertion is the strongest one
// available: the thread shows EXACTLY the server's rows, in order, each once.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startRealServer,
  registerUser,
  newUserPage,
  closeUserBrowsers,
  loginUi,
  sessionFromPage,
  socketConnected,
  openDmUi,
} from './_acceptance-harness.mjs';
import {
  pollUntil,
  cspProbe,
  watchPage,
  cspViolations,
  clickReal,
  renderedRowIds,
  serverRowIds,
  openThreadByRow,
  leaveAndReturn,
  sendTextViaComposer,
} from './_dm-ui-helpers.mjs';

let server = null;

after(async () => {
  await closeUserBrowsers();
  if (server) await server.stop().catch(() => {});
});

/** The thread must show exactly the server's rows (ids, order, once each). */
async function assertThreadMatchesServer(page, api, peerId, when) {
  const expected = await serverRowIds(api, peerId);
  const rendered = await pollUntil(
    async () => {
      const ids = await renderedRowIds(page);
      return ids.length >= expected.length ? ids : null;
    },
    {
      what: `${when}: the thread to render the server's ${expected.length} rows`,
      describe: async () => `rendered ${JSON.stringify(await renderedRowIds(page))}, server ${JSON.stringify(expected)}`,
    }
  );

  assert.deepEqual(
    rendered,
    expected,
    `${when}: the thread must show exactly the server's rows, once each, in order ` +
      `(rendered ${JSON.stringify(rendered)}, server ${JSON.stringify(expected)})`
  );

  // No two rows may carry the same message id.
  assert.equal(new Set(rendered).size, rendered.length, `${when}: a message id is rendered twice`);
  return expected;
}

async function bubbleTextOf(page, id) {
  return page.$eval(`#dm-messages > .chat-msg[data-msg-id="${id}"] .chat-bubble`, (b) => b.textContent.trim());
}

async function rowsWithId(page, id) {
  return page.$$eval(`#dm-messages > .chat-msg[data-msg-id="${id}"]`, (rows) => rows.length);
}

test('own DM messages appear exactly once after switching tabs, repeatedly; the peer\'s messages are neither lost nor merged', async () => {
  server = await startRealServer({ csp: 'true' });
  await registerUser(server.origin, 'dup-alice');
  await registerUser(server.origin, 'dup-bob');

  const A = await newUserPage({ onNewDocument: cspProbe });
  const B = await newUserPage({ onNewDocument: cspProbe });
  const pageErrors = watchPage(A.page);

  await loginUi(A.page, server.origin, 'dup-alice');
  await loginUi(B.page, server.origin, 'dup-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'dup-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'dup-bob');
  assert.ok(await socketConnected(A.page), 'alice must be connected live');
  assert.ok(await socketConnected(B.page), 'bob must be connected live');

  // Alice sits on the Messages tab with the conversation NOT open.
  await clickReal(A.page, '.nav-link[data-view="messages"]');
  await A.page.waitForSelector('#dm-conv-list');

  // Bob writes first: two messages with IDENTICAL text. They reach Alice live,
  // before her first history load of this thread (root cause 2). Identical on
  // purpose: identity is the row id, and two equal messages are two messages.
  await openDmUi(B.page, alice.id, 'dup-alice');
  const twin1 = await sendTextViaComposer(B.page, bob.api, alice.id, 'same words twice');
  const twin2 = await sendTextViaComposer(B.page, bob.api, alice.id, 'same words twice');
  assert.notEqual(twin1, twin2, 'two sends are two server rows');

  // Alice's list learns about them live (handleDirectMessage refreshes it after
  // caching the row): only then is "arrived before the thread opened" true.
  await pollUntil(
    () => A.page.$(`.dm-conv[data-peer="${bob.id}"]`),
    { what: "Bob's conversation to appear live in Alice's list" }
  );

  // 1. Alice opens the conversation (real click on its row).
  await openThreadByRow(A.page, bob.id);
  await assertThreadMatchesServer(A.page, alice.api, bob.id, 'first open');

  // 2. Alice sends as herself through the real composer (root cause 1).
  const own1 = await sendTextViaComposer(A.page, alice.api, bob.id, 'my own message');
  assert.equal(await rowsWithId(A.page, own1), 1, 'the live thread draws the sent message once');
  await assertThreadMatchesServer(A.page, alice.api, bob.id, 'right after sending');

  // 3 + 4. Another tab and back - then again, several times, to catch listener
  // accumulation or repeated insertion that only grows with each round.
  const ownIds = [own1];
  const peerWhileAway = [];

  for (let round = 1; round <= 3; round++) {
    await clickReal(A.page, '.nav-link[data-view="files"]');
    await pollUntil(() => A.page.evaluate(() => !document.getElementById('dm-messages')), {
      what: `round ${round}: the thread to be torn down by the tab switch`,
    });

    // While Alice is away, Bob sends one (a live arrival into a closed thread).
    peerWhileAway.push(await sendTextViaComposer(B.page, bob.api, alice.id, `bob while away ${round}`));

    await openThreadByRow(A.page, bob.id);
    const rows = await assertThreadMatchesServer(A.page, alice.api, bob.id, `round ${round}, after returning`);

    // 5. Every own message exactly once, with its own text.
    for (const id of ownIds) {
      assert.equal(await rowsWithId(A.page, id), 1, `round ${round}: own message ${id} must appear exactly once`);
    }
    assert.equal(await bubbleTextOf(A.page, own1), 'my own message');

    // The other participant's messages are neither removed nor merged: both
    // identical twins are still there, and so is what arrived while away.
    assert.equal(await rowsWithId(A.page, twin1), 1, 'first twin must still be shown');
    assert.equal(await rowsWithId(A.page, twin2), 1, 'second twin (same text, different message) must still be shown');
    assert.equal(await bubbleTextOf(A.page, twin1), 'same words twice');
    assert.equal(await bubbleTextOf(A.page, twin2), 'same words twice');
    for (const id of peerWhileAway) {
      assert.ok(rows.includes(id), `round ${round}: Bob's message ${id} sent while away must be shown`);
      assert.equal(await rowsWithId(A.page, id), 1, `round ${round}: Bob's message ${id} must appear exactly once`);
    }

    // And send again, so the next round has a fresh own message to duplicate.
    ownIds.push(await sendTextViaComposer(A.page, alice.api, bob.id, `my own message ${round + 1}`));
  }

  // A final round trip after the last send.
  await leaveAndReturn(A.page, bob.id);
  await assertThreadMatchesServer(A.page, alice.api, bob.id, 'final return');
  for (const id of ownIds) {
    assert.equal(await rowsWithId(A.page, id), 1, `final: own message ${id} must appear exactly once`);
  }

  // The sender's side of Bob's own messages is held to the same rule.
  await leaveAndReturn(B.page, alice.id);
  await assertThreadMatchesServer(B.page, bob.api, alice.id, "Bob's view after his own tab switch");

  assert.deepEqual(await cspViolations(A.page), [], 'no CSP violation on the way');
  assert.deepEqual(pageErrors.filter((e) => /pageerror/.test(e)), [], `uncaught page errors: ${pageErrors.join(' | ')}`);
});
