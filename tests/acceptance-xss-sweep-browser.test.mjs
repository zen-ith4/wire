// tests/acceptance-xss-sweep-browser.test.mjs
//
// REAL Chromium against the REAL server (node server.js), Report-Only CSP (the default), so an
// injected inline handler WOULD execute: that is the strongest signal. Hostile strings go in only
// through official routes or the real composer, then are rendered by both the sender (alice) and
// the receiver (bob). The page flag window.__pwned is defined false on every document; each
// payload tries to set it.
//
// Render paths covered (A..I). "display name": this app has NO display-name field (users have a
// username and a free-text `bio`), so the profile `bio` shown by the profile card is covered
// instead and the gap is stated, not hidden.
//   A group name (create + rename)      B username (server must reject; cannot be rendered)
//   C profile bio                        D DM text            E group text
//   F link text (markdown + raw html + javascript: URLs, DM and group)
//   G reply quote (DM and group)         H reaction emoji (DM and group, via the official route)
//   I attachment filename (DM)           J member role (no route lets a user set it; hostile
//                                          `role` in add-member must be ignored and members render)
//
// Assertions on every view of every page:
//   * window.__pwned stays false after the view AND after hover/focus events on every element;
//   * no on* attribute carrying the payload, no javascript: href, no <img src=x>, no payload <script>;
//   * control: each path's text really was rendered (visible as inert text) in at least one view,
//     otherwise a "clean" result could just mean the path was never exercised.
//
// Stable hooks (update here if the UI changes; none of data-action="group-new", .conv-name,
// dm-conv-name or the header markup is used):
//   .group-row[data-group-id] (group.js:339) · [data-action="group-send"] (group.js:498) ·
//   [data-action="group-settings"] (group.js:489) · .chat-msg / .chat-msg-reply[data-action="thread-reply"]
//   (thread.js:237) · #dm-input / #dm-file-input / #dm-thread · openProfileCard() exported by
//   js/ui/profile-card.js · window.openDmConversation / window.sendDm (dm.js).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    rand,
    sleep,
    waitFor,
    startRealServer,
    jsonClient,
    launchBrowser,
    registerUser,
    restLogin,
    loginUi,
    socketConnected,
    openGroupUi,
    sendGroupTextUi,
    openDmUi,
    sendDmTextUi,
    sessionFromPage,
    newUserPage,
    closeUserBrowsers,
} from './_acceptance-harness.mjs';

let server = null; let fixtureDir = null;
after(async () => {
    await closeUserBrowsers();
    await server?.stop().catch(() => {});
    for (const d of [server?.work, fixtureDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

// every payload tries to flip window.__pwned; tags make each path's text unique and findable
const P = (tag) => `"'><img src=x onerror=__pwned=1><svg onload=__pwned=1>${tag}`;
const EMOJI = '"><img src=x onerror=__pwned=1>'; // <= 32 chars (server limit)
const HUSER = '"><img src=x onerror=__pwned=1>~uname'; // the register route does not validate usernames (finding)
const LINKS = (tag) => `[click](javascript:__pwned=1) <a href="javascript:__pwned=1" onclick="__pwned=1">raw</a> http://e.test/"onmouseover="__pwned=1 javascript:__pwned=1 <script>__pwned=1</script>${tag}`;

/** Inspect the current DOM, fire hover/focus on everything, return findings + visible text. */
async function sweep(page, label) {
    await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
            for (const type of ['mouseover', 'mouseenter', 'focusin', 'focus']) el.dispatchEvent(new Event(type, { bubbles: true }));
        }
    });
    await sleep(150);
    const r = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('*')) {
            const tag = el.tagName.toLowerCase();
            // handlers that only an injection can create (X's own markup uses onclick/onchange/...; those
            // may legitimately CONTAIN an escaped filename, so execution is judged by __pwned instead)
            for (const a of el.attributes) if (/^on(error|load|mouseover|mouseenter|focus|focusin|toggle|animationstart)$/i.test(a.name)) bad.push(`<${tag}> carries injected ${a.name}="${a.value.slice(0, 40)}"`);
            if (tag === 'a' && /^\s*javascript:/i.test(el.getAttribute('href') || '')) bad.push('<a href="javascript:...">');
            if (tag === 'img' && el.getAttribute('src') === 'x') bad.push('<img src="x"> injected');
            if (tag === 'script' && /__pwned/.test(el.textContent)) bad.push('<script> with payload injected');
            if (tag === 'svg' && el.hasAttribute('onload')) bad.push('<svg onload> injected');
        }
        return { pwned: window.__pwned, bad, text: document.body.innerText };
    });
    return { label, ...r };
}

/** Real click on every attachment control whose inline onclick embeds the filename; report __pwned afterwards. */
async function clickDownloads(page, label) {
    const n = await page.evaluate(() => { const els = [...document.querySelectorAll('[onclick*="downloadAttachment"]')]; els.forEach((e) => e.click()); return els.length; });
    await sleep(1200);
    return { label, clicked: n, pwned: await page.evaluate(() => window.__pwned) };
}

let scenarioPromise = null;
const scenario = () => (scenarioPromise ??= run());

async function run() {
    // The hostile fixture file name further down (test "I filename") contains
    // `"`, `<` and `>`, none of which NTFS accepts in a file name, so
    // fs.writeFileSync would fail with ENOENT before the app is ever involved.
    // The hostile string itself is deliberately left untouched; on Linux and CI
    // the sweep runs in full. One guard, so every test in this file reports
    // `skipped` with the reason instead of six ENOENT failures.
    if (process.platform === 'win32') return { blocked: 'NTFS cannot hold the hostile fixture filename; this sweep is covered on Linux/CI' };
    const launched = await launchBrowser();
    if (!launched.browser) return { blocked: `no Chromium available (${launched.reason})` };
    // Only a probe: every account gets its own process via newUserPage(), which
    // registers it with closeUserBrowsers() for the after() hook.
    await launched.browser.close().catch(() => {});
    server = await startRealServer({ csp: 'false' });
    const { origin } = server;
    const n = rand();
    const names = { alice: `al${n}`, bob: `bo${n}` };
    for (const u of Object.values(names)) await registerUser(origin, u);
    // user with a hostile username (only possible because /api/auth/register skips isValidUsername)
    const hReg = await jsonClient(origin)('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: HUSER, email: `h${n}@example.com`, password: 'Passw0rd!x' }) });
    const hostileUserExists = hReg.status === 201;

    const out = { views: [], rest: {}, controls: {} };

    // B: hostile usernames must be rejected by the official register route
    out.rest.usernames = [];
    for (const bad of [`"><img src=x onerror=__pwned=1>`, `a<svg onload=__pwned=1>`, `x' onmouseover='__pwned=1`, `javascript:__pwned=1`]) {
        const r = await jsonClient(origin)('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: bad, email: `h${rand()}@example.com`, password: 'Passw0rd!x' }) });
        out.rest.usernames.push({ bad, status: r.status });
    }

    const mkPage = async () => (await newUserPage({
        onNewDocument: () => { window.__pwned = false; },
    })).page;
    const bobPage = await mkPage();
    await loginUi(bobPage, origin, names.bob); // creates bob's identity key
    const hPage = await mkPage();
    if (hostileUserExists) await loginUi(hPage, origin, HUSER); // creates the hostile user's identity key
    const page = await mkPage();
    await loginUi(page, origin, names.alice);
    assert.ok(await socketConnected(page), 'alice socket connected');
    await sleep(800);
    // All three of these accounts have been through the UI login, so they
    // are on login scheme 2 and a second raw-password login is refused by
    // the anti-downgrade rule. Reuse each browser session instead.
    const sess = {
        alice: await sessionFromPage(page, origin, names.alice),
        bob: await sessionFromPage(bobPage, origin, names.bob),
    };
    if (hostileUserExists) sess.h = await sessionFromPage(hPage, origin, HUSER);
    out.hostileUserExists = hostileUserExists;
    const A = sess.alice.api;

    // C bio (official route) and A group name (create + rename) and J role
    out.rest.bio = (await A('/api/me', { method: 'PUT', body: JSON.stringify({ bio: P('~bio') }) })).status;
    const g = await A('/api/groups', { method: 'POST', body: JSON.stringify({ name: P('~gname') }) });
    out.rest.createGroup = g.status;
    const gid = g.body.id;
    out.rest.renameGroup = (await A(`/api/groups/${gid}`, { method: 'PATCH', body: JSON.stringify({ name: P('~gname2') }) })).status;
    out.rest.addMember = (await A(`/api/groups/${gid}/members`, { method: 'POST', body: JSON.stringify({ user_id: sess.bob.id, role: P('~role') }) })).status;
    if (hostileUserExists) out.rest.addHostile = (await A(`/api/groups/${gid}/members`, { method: 'POST', body: JSON.stringify({ user_id: sess.h.id }) })).status;
    out.rest.roles = (await A(`/api/groups/${gid}/members`)).body.map((m) => m.role);

    // E, F, G (group): through the real composer
    await openGroupUi(page, gid);
    const ids = [sess.alice.id, sess.bob.id, ...(hostileUserExists ? [sess.h.id] : [])];
    await sendGroupTextUi(page, A, gid, ids, P('~gtext'));
    await sendGroupTextUi(page, A, gid, ids, LINKS('~glink'));
    await page.$eval('.chat-msg-reply', (b) => b.click()); // reply to the hostile message
    await sendGroupTextUi(page, A, gid, ids, 'replying ~greply');

    // D, F, G, I (DM)
    await openDmUi(page, sess.bob.id, names.bob);
    await sendDmTextUi(page, P('~dtext'));
    await sendDmTextUi(page, LINKS('~dlink'));
    await page.$eval('#dm-thread .chat-msg-reply', (b) => b.click());
    await sendDmTextUi(page, 'replying ~dreply');
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-xss-fixture-'));
    const hostileName = `fn"><img src=x onerror=__pwned=1>~fname.txt`;
    const fixture = path.join(fixtureDir, hostileName);
    fs.writeFileSync(fixture, 'harmless body\n');
    const before = await page.$$eval('#dm-thread .chat-msg', (e) => e.length);
    await (await page.$('#dm-file-input')).uploadFile(fixture);
    await page.waitForSelector('#dm-attach-staging .attach-chip', { timeout: 10000 });
    await page.evaluate(() => window.sendDm());
    out.controls.attachmentSent = await waitFor(async () => (await page.$$eval('#dm-thread .chat-msg', (e) => e.length)) > before, 25000, 250);
    // second filename: before the fix escapeAttr() (public/js/core/utils.js) escaped \\ ' " and newlines but NOT '&', and the
    // result sits inside a single-quoted JS string in an inline onclick="...". The HTML parser decodes
    // &#39; BEFORE the JS parser runs, so this name would close the string if '&' is left alone.
    const breakName = `x&#39;);__pwned=1;(&#39;~fname2.txt`; // a filename cannot contain '/', so close the call and reopen a parenthesis instead of using //
    const fixture2 = path.join(fixtureDir, breakName);
    fs.writeFileSync(fixture2, 'harmless body\n');
    const before2 = await page.$$eval('#dm-thread .chat-msg', (e) => e.length);
    await (await page.$('#dm-file-input')).uploadFile(fixture2);
    await page.waitForSelector('#dm-attach-staging .attach-chip', { timeout: 10000 });
    await page.evaluate(() => window.sendDm());
    out.controls.attachment2Sent = await waitFor(async () => (await page.$$eval('#dm-thread .chat-msg', (e) => e.length)) > before2, 25000, 250);

    // H reaction emoji: official routes, on a group message and a DM message
    const grp = (await A(`/api/groups/${gid}/messages/recent`)).body;
    const gmsgs = Array.isArray(grp) ? grp : grp.messages || [];
    out.rest.groupReaction = (await A(`/api/groups/${gid}/messages/${gmsgs[0].id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: EMOJI }) })).status;
    const dm = (await A(`/api/dm/messages/${sess.bob.id}/recent?limit=50`)).body;
    const dmsgs = Array.isArray(dm) ? dm : dm.messages || [];
    out.rest.dmReaction = (await A(`/api/dm/messages/${dmsgs[0].id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: EMOJI }) })).status;

    const views = out.views;
    const viewAll = async (pg, who, peerId, peerName, otherId, extraPeer = null) => {
        await openDmUi(pg, peerId, peerName);
        await sleep(1500);
        views.push(await sweep(pg, `${who}: DM thread`));
        await openGroupUi(pg, gid);
        await sleep(1500);
        views.push(await sweep(pg, `${who}: group thread + list`));
        await pg.click('[data-action="group-settings"]');
        await sleep(1200);
        views.push(await sweep(pg, `${who}: group settings (members + roles)`));
        await pg.evaluate(() => document.querySelector('dialog[open]')?.close());
        await pg.evaluate(async (id) => { const m = await import('/js/ui/profile-card.js'); await m.openProfileCard(id); }, otherId);
        await sleep(1200);
        views.push(await sweep(pg, `${who}: profile card (bio)`));
        await pg.keyboard.press('Escape'); // profile-card.js closes on Escape; an open card would swallow the next nav click
        await sleep(400);
        if (extraPeer) {
            await openDmUi(pg, extraPeer.id, extraPeer.name);
            await sleep(1500);
            views.push(await sweep(pg, `${who}: DM thread with the hostile-username user`));
        }
    };
    await viewAll(page, 'alice', sess.bob.id, names.bob, sess.alice.id);
    await openDmUi(page, sess.bob.id, names.bob);
    await sleep(1500);
    out.clicks = [await clickDownloads(page, 'alice: DM thread attachments')];

    // the hostile-username user posts too (author name is rendered in the thread of the receiver)
    if (hostileUserExists) {
        await loginUi(hPage, origin, HUSER);
        assert.ok(await socketConnected(hPage), 'hostile user socket connected');
        await sleep(2500);
        await openGroupUi(hPage, gid);
        await sendGroupTextUi(hPage, sess.h.api, gid, ids, 'hello from the hostile username ~hgroup');
        await openDmUi(hPage, sess.bob.id, names.bob);
        await sendDmTextUi(hPage, 'dm from the hostile username ~hdm');
    }

    // the receiver: bob signs in last (a login clears the shared localStorage, so the others are done)
    await loginUi(bobPage, origin, names.bob);
    assert.ok(await socketConnected(bobPage), 'bob socket connected');
    await sleep(2500); // pending group key distributions
    await viewAll(bobPage, 'bob', sess.alice.id, names.alice, sess.alice.id, hostileUserExists ? { id: sess.h.id, name: HUSER } : null);
    await openDmUi(bobPage, sess.alice.id, names.alice);
    await sleep(1500);
    out.clicks.push(await clickDownloads(bobPage, 'bob: DM thread attachments'));

    out.roleAfter = (await A(`/api/groups/${gid}/members`)).body.map((m) => m.role);
    out.logs = server.logs();
    return out;
}

const blocked = (t, s) => { if (s.blocked) { t.skip(`BLOCKED: ${s.blocked}`); return true; } return false; };
const allText = (s) => s.views.map((v) => v.text).join('\n');

test('xss sweep: nothing executes and nothing is injected in any view of any page', async (t) => {
    const s = await scenario(); if (blocked(t, s)) return;
    assert.ok(s.views.length >= 8, `expected 8 views (4 per user), got ${s.views.length}`);
    for (const v of s.views) {
        assert.equal(v.pwned, false, `${v.label}: a payload executed (window.__pwned)`);
        assert.deepEqual(v.bad, [], `${v.label}: injected markup`);
    }
});

test('control: each render path was really exercised (payload text visible, inert, in a rendered view)', async (t) => {
    const s = await scenario(); if (blocked(t, s)) return;
    const text = allText(s);
    const missing = [];
    const must = { 'A group name (create)': '~gname', 'A group name (rename)': '~gname2', 'C profile bio': '~bio', 'D DM text': '~dtext', 'E group text': '~gtext',
        'F link text (DM)': '~dlink', 'F link text (group)': '~glink', 'G reply quote (DM)': '__pwned=1>~dtext', 'G reply quote (group)': '__pwned=1>~gtext', 'I filename': '~fname.txt', 'I filename (entity breakout)': '~fname2.txt' };
    for (const [name, tag] of Object.entries(must)) if (!text.includes(tag)) missing.push(`${name} (${tag})`);
    assert.deepEqual(missing, [], 'these paths never rendered, so a clean sweep proves nothing for them');
    // sender AND receiver both rendered the received hostile content
    for (const who of ['alice', 'bob']) {
        const mine = s.views.filter((v) => v.label.startsWith(who)).map((v) => v.text).join('\n');
        assert.ok(mine.includes('~dtext') && mine.includes('~gname'), `${who} rendered DM text and group name`);
    }
    assert.ok(s.controls.attachmentSent, 'hostile-filename attachment was sent');
});

test('B username (FINDING): /api/auth/register must reject usernames outside [a-zA-Z0-9_]{3,20}',
    { todo: 'FINDING: services/auth.service.js registerUser() only checks "non-empty"; isValidUsername() runs in createUser() only. Needs a fix in agent A\'s auth area.' },
    async (t) => {
        const s = await scenario(); if (blocked(t, s)) return;
        for (const { bad, status } of s.rest.usernames) assert.ok(status >= 400 && status < 500, `register accepted username ${JSON.stringify(bad)} => ${status}`);
    });

test('B username (rendering): a user whose username is markup renders as inert text everywhere (member list, thread author, DM list/thread)', async (t) => {
    const s = await scenario(); if (blocked(t, s)) return;
    if (!s.hostileUserExists) { t.skip('register rejected the hostile username (the finding above is fixed): nothing to render'); return; }
    const text = allText(s);
    assert.ok(text.includes('~uname'), 'the hostile username was rendered (visible as text) in at least one view');
    const bobView = s.views.filter((v) => v.label.startsWith('bob')).map((v) => v.text).join('\n');
    assert.ok(bobView.includes('~hgroup'), 'bob rendered the hostile-username user\'s group message');
    assert.ok(bobView.includes('~hdm'), 'bob rendered the hostile-username user\'s DM');
});

test('I filename: an entity-encoded quote in a filename cannot break out of the inline onclick JS string (real click)',
    // Was a confirmed stored XSS (escapeAttr did not escape '&'); fixed in public/js/core/utils.js. Unit-level
    // coverage of the same contract lives in tests/escape-attr-js-string.test.mjs.
    async (t) => {
        const s = await scenario(); if (blocked(t, s)) return;
        assert.ok(s.controls.attachment2Sent, 'control: the breakout-filename attachment was sent');
        console.log(`# click results: ${JSON.stringify(s.clicks)}`);
        for (const c of s.clicks) assert.ok(c.clicked >= 2, `${c.label}: both hostile attachments were clicked (${c.clicked})`);
        for (const c of s.clicks) assert.equal(c.pwned, false, `${c.label}: clicking the attachment executed the filename payload (window.__pwned)`);
    });

test('J role: a hostile `role` in add-member is ignored; members list only ever holds known roles', async (t) => {
    const s = await scenario(); if (blocked(t, s)) return;
    assert.equal(s.rest.addMember, 200);
    for (const roles of [s.rest.roles, s.roleAfter]) {
        assert.ok(roles.length >= 2, 'members listed');
        assert.deepEqual(roles.filter((r) => !['owner', 'admin', 'member'].includes(r)), [], `unknown role in ${JSON.stringify(roles)}`);
        assert.equal(roles.filter((r) => r === 'owner').length, 1, 'exactly one owner');
    }
});

test('H reaction emoji: the official routes either reject the payload or it renders as inert text', async (t) => {
    const s = await scenario(); if (blocked(t, s)) return;
    for (const k of ['groupReaction', 'dmReaction']) assert.ok(s.rest[k] === 200 || (s.rest[k] >= 400 && s.rest[k] < 500), `${k} => ${s.rest[k]}`);
    if (s.rest.groupReaction === 200 && s.rest.dmReaction === 200) {
        assert.ok(allText(s).includes('onerror=__pwned=1>'), 'accepted emoji payload is visible as text somewhere (rendered, inert)');
    }
});
