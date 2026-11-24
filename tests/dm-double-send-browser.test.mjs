// tests/dm-double-send-browser.test.mjs
//
// Regression: two rapid clicks on the Send button posted the same message twice.
//
// Root cause (public/js/chat/composer.js): the only duplicate guard,
// `sendInProgress`, lives in beginSendFromInput(), i.e. on the Enter path. The
// Send button calls window.sendDm() -> composer.send() directly, and send()
// clears the input only AFTER it has sealed and posted the message, so a second
// trigger inside that window re-read the same text and posted it again.
//
// Everything goes through the real UI (the composer's Send button and Enter
// key). The assertion is on the SERVER's rows, not on what the DOM shows.

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
import { currentEngine } from './_dm-ui-helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];

after(async () => {
  await closeUserBrowsers();
  for (const s of servers) {
    await s.stop().catch(() => {});
  }
});

test('one send per trigger: rapid double click, later legitimate send', async (t) => {
  const server = await startRealServer({ csp: 'true' });
  servers.push(server);
  await registerUser(server.origin, 'ds-alice');
  await registerUser(server.origin, 'ds-bob');

  const A = await newUserPage({});
  const B = await newUserPage({});
  await loginUi(A.page, server.origin, 'ds-alice');
  await loginUi(B.page, server.origin, 'ds-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'ds-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'ds-bob');
  assert.ok(await socketConnected(A.page), 'alice must be connected live');

  await openDmUi(A.page, bob.id, 'ds-bob');

  const serverIds = async () =>
    (await alice.api(`/api/dm/messages/${bob.id}/recent`)).body.map((m) => m.id);

  const sendCenter = () =>
    A.page.$eval('[data-action="dm-send"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

  /** Type a message, fire `trigger`, and return how many NEW server rows appeared. */
  async function newRowsAfter(label, trigger, exactText = null) {
    const before = new Set(await serverIds());
    await A.page.click('#dm-input');
    await A.page.type('#dm-input', exactText ?? `${label} ${Date.now()}`);
    await trigger();
    // Wait until the send has surely finished (the input is cleared after the
    // post) and any second send would have reached the server.
    let cleared = false;
    for (let i = 0; i < 40 && !cleared; i++) {
      await sleep(250);
      cleared = await A.page.$eval('#dm-input', (el) => el.value === '');
    }
    assert.ok(cleared, `${label}: the composer must clear its input after sending`);
    await sleep(1500);
    const after = await serverIds();
    return after.filter((id) => !before.has(id)).length;
  }

  // Baseline: one click, one message.
  const single = await newRowsAfter('single click', async () => {
    const c = await sendCenter();
    await A.page.mouse.click(c.x, c.y);
  });
  assert.equal(single, 1, 'a single click on Send posts exactly one message');

  // The bug: two clicks in quick succession.
  for (let round = 1; round <= 3; round++) {
    const rows = await newRowsAfter(`double click ${round}`, async () => {
      const c = await sendCenter();
      await A.page.mouse.click(c.x, c.y);
      await A.page.mouse.click(c.x, c.y);
    });
    assert.equal(rows, 1, `round ${round}: two rapid clicks on Send must post ONE message, got ${rows}`);
  }

  // The guard must release: a later, separate send still works.
  const later = await newRowsAfter('later send', async () => {
    const c = await sendCenter();
    await A.page.mouse.click(c.x, c.y);
  });
  assert.equal(later, 1, 'after the first send finished, the next send is not blocked');

  // People really do send the same words twice ("ok", "ok"). The guard is only
  // about a send that is STILL IN FLIGHT; once the first one has finished, the
  // identical text must go out again as a second, separate message.
  const click = async () => {
    const c = await sendCenter();
    await A.page.mouse.click(c.x, c.y);
  };
  const first = await newRowsAfter('same text, first', click, 'ok');
  const second = await newRowsAfter('same text, second', click, 'ok');
  assert.equal(first, 1, 'the first "ok" is sent once');
  assert.equal(second, 1, 'the same text sent again AFTER the first finished is a new message');
});

test('one send per trigger: double Enter (chromium only)', async (t) => {
  // Firefox automation (puppeteer-core BiDi) reports Enter as
  // code="NumpadEnter", location=1 — not code="Enter", location=0 — so the
  // product's isPhysicalEnter guard (public/js/chat/composer.js) never fires
  // and Enter never sends. Skip the Enter part on non-chromium engines and
  // verify manually in real Firefox.
  if (currentEngine() !== 'chromium') {
    t.skip('firefox automation does not produce a physical Enter (code/location) - verify manually in real Firefox');
    return;
  }

  const server = await startRealServer({ csp: 'true' });
  servers.push(server);
  await registerUser(server.origin, 'ds-alice');
  await registerUser(server.origin, 'ds-bob');

  const A = await newUserPage({});
  const B = await newUserPage({});
  await loginUi(A.page, server.origin, 'ds-alice');
  await loginUi(B.page, server.origin, 'ds-bob');
  const alice = await sessionFromPage(A.page, server.origin, 'ds-alice');
  const bob = await sessionFromPage(B.page, server.origin, 'ds-bob');
  assert.ok(await socketConnected(A.page), 'alice must be connected live');

  await openDmUi(A.page, bob.id, 'ds-bob');

  const serverIds = async () =>
    (await alice.api(`/api/dm/messages/${bob.id}/recent`)).body.map((m) => m.id);

  const sendCenter = () =>
    A.page.$eval('[data-action="dm-send"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

  /** Type a message, fire `trigger`, and return how many NEW server rows appeared. */
  async function newRowsAfter(label, trigger, exactText = null) {
    const before = new Set(await serverIds());
    await A.page.click('#dm-input');
    await A.page.type('#dm-input', exactText ?? `${label} ${Date.now()}`);
    await trigger();
    let cleared = false;
    for (let i = 0; i < 40 && !cleared; i++) {
      await sleep(250);
      cleared = await A.page.$eval('#dm-input', (el) => el.value === '');
    }
    assert.ok(cleared, `${label}: the composer must clear its input after sending`);
    await sleep(1500);
    const after = await serverIds();
    return after.filter((id) => !before.has(id)).length;
  }

  const enter = await newRowsAfter('double enter', async () => {
    await A.page.keyboard.press('Enter');
    await A.page.keyboard.press('Enter');
  });
  assert.equal(enter, 1, 'two rapid Enter presses post exactly one message');
});