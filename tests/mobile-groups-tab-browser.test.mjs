// tests/mobile-groups-tab-browser.test.mjs
//
// REAL server (node server.js) + REAL Chromium with a mobile viewport and touch input.
//
//   groups ON  : the bottom tab bar has 4 tabs, the 4th being Groups (the same `groups` view the
//                desktop sidebar item opens). A touch tap on it opens the group list, which shows a
//                group created through the official API (POST /api/groups).
//   groups OFF : 3 tabs, no Groups tab, no Groups sidebar link, no admin More button for a
//                non-admin (and the app has no /api/groups at all).
//   both       : at 320, 375 and 414 px no label is truncated and the page does not scroll sideways.
//   landscape  : a short landscape phone (max-height 480px, icon-beside-label bar) shows all tabs.
//
// Not covered here (cannot be): a real phone, notch / home-indicator insets (Chromium reports 0, so
// safe-area was evaluated from the CSS only), native WebView, Capacitor, APK.
//
// Set SHOTS_DIR=<dir> to also write screenshots (bar and full page per width, plus landscape).

import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    rand,
    sleep,
    waitFor,
    startRealServer,
    launchBrowser,
    registerUser,
    restLogin,
    loginUi,
    sessionFromPage,
} from './_acceptance-harness.mjs';

const WIDTHS = [320, 375, 414];
const SHOTS = process.env.SHOTS_DIR || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let browser = null;
const servers = [];
after(async () => {
    await browser?.close().catch(() => {});
    for (const s of servers) { await s.stop().catch(() => {}); fs.rmSync(s.work, { recursive: true, force: true }); }
});

const phone = (width, height = 700) => ({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

async function barState(page) {
    return page.evaluate(() => {
        const bar = document.getElementById('bottom-nav');
        const items = [...bar.querySelectorAll('.bottom-nav-item')];
        return {
            display: getComputedStyle(bar).display,
            tabs: items.map((i) => ({
                view: i.dataset.view,
                label: i.querySelector('.bottom-nav-label').textContent.trim(),
                truncated: i.querySelector('.bottom-nav-label').scrollWidth > i.querySelector('.bottom-nav-label').clientWidth,
                width: Math.round(i.getBoundingClientRect().width),
                insideViewport: i.getBoundingClientRect().right <= window.innerWidth + 0.5 && i.getBoundingClientRect().left >= -0.5,
            })),
            sidebarGroupsLink: !!document.querySelector('#nav-links .nav-link[data-view="groups"]'),
            moreButton: !!document.querySelector('.topbar-more-btn'),
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
    });
}

async function runMode(groupsEnabled) {
    const server = await startRealServer({ extraEnv: { GROUPS_ENABLED: groupsEnabled ? 'true' : 'false' } });
    servers.push(server);
    const n = rand();
    const user = `mo${n}`;
    await registerUser(server.origin, user);
    const out = { widths: {}, groupsEnabled };
    const newPage = async (viewport) => { const p = await browser.newPage(); p.setDefaultTimeout(30000); await p.setViewport(viewport); return p; };

    // sign in once at the first width so the identity key exists, then create the group over the official API
    let gid = null; let sess = null;
    for (const w of WIDTHS) {
        const page = await newPage(phone(w));
        await loginUi(page, server.origin, user);
        await page.waitForSelector('#bottom-nav .bottom-nav-item', { timeout: 30000 });
        await sleep(800);
        if (groupsEnabled && !gid) {
            sess = await sessionFromPage(page, server.origin, user);
            const g = await sess.api('/api/groups', { method: 'POST', body: JSON.stringify({ name: `mobile ${n}` }) });
            assert.equal(g.status, 201, JSON.stringify(g.body));
            gid = g.body.id;
        }
        const state = await barState(page);
        out.widths[w] = state;
        if (SHOTS) {
            const bb = await (await page.$('#bottom-nav')).boundingBox();
            const tag = groupsEnabled ? 'on' : 'off';
            await page.screenshot({ path: path.join(SHOTS, `groups-${tag}-${w}-full.png`) });
            await page.screenshot({ path: path.join(SHOTS, `groups-${tag}-${w}-bar.png`), clip: { x: 0, y: Math.max(0, bb.y - 6), width: w, height: bb.height + 6 } });
        }
        if (groupsEnabled && w === 375) {
            // a real touch tap on the Groups tab
            const tapError = await page.tap('#bottom-nav .bottom-nav-item[data-view="groups"]').then(() => null, (e) => e.message);
            out.tapped = {
                tapError,
                hash: await waitFor(async () => ((await page.evaluate(() => location.hash)) === '#groups' ? '#groups' : false), 10000, 150),
                list: !!(await page.waitForSelector('#group-list', { timeout: 15000 }).catch(() => null)),
                row: !!(await page.waitForSelector(`.group-row[data-group-id="${gid}"]`, { timeout: 15000 }).catch(() => null)),
                rowText: await page.$eval(`.group-row[data-group-id="${gid}"]`, (e) => e.innerText).catch(() => ''),
                activeView: await page.evaluate(() => document.querySelector('#bottom-nav .bottom-nav-item.active')?.dataset.view),
                name: `mobile ${n}`,
            };
        }
        await page.close();
    }

    if (groupsEnabled) {
        // landscape-short phone: max-height:480px switches the bar to icon-beside-label
        const page = await newPage({ width: 740, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
        await loginUi(page, server.origin, user);
        await page.waitForSelector('#bottom-nav .bottom-nav-item', { timeout: 30000 });
        await sleep(800);
        out.landscape = await page.evaluate(() => {
            const items = [...document.querySelectorAll('#bottom-nav .bottom-nav-item')];
            return {
                display: getComputedStyle(document.getElementById('bottom-nav')).display,
                direction: getComputedStyle(items[0]).flexDirection,
                labels: items.map((i) => i.querySelector('.bottom-nav-label').textContent.trim()),
                truncated: items.map((i) => i.querySelector('.bottom-nav-label').scrollWidth > i.querySelector('.bottom-nav-label').clientWidth),
                inside: items.every((i) => i.getBoundingClientRect().right <= window.innerWidth + 0.5),
                height: window.innerHeight,
            };
        });
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'groups-on-landscape-short-740x360.png') });
        await page.close();
    }
    return out;
}

let started = null;
async function ensureBrowser(t) {
    if (browser) return true;
    started ??= launchBrowser();
    const l = await started;
    if (!l.browser) { t.skip(`BLOCKED: no Chromium available (${l.reason})`); return false; }
    browser = l.browser;
    return true;
}

let onP = null; let offP = null;
const modeOn = () => (onP ??= runMode(true));
const modeOff = () => (offP ??= runMode(false));

test('groups ON: bottom bar has 4 tabs, Groups last, and nothing is truncated at 320 / 375 / 414 px', async (t) => {
    if (!(await ensureBrowser(t))) return;
    const r = await modeOn();
    for (const w of WIDTHS) {
        const s = r.widths[w];
        assert.equal(s.display, 'flex', `${w}px: the phone bar is visible`);
        assert.deepEqual(s.tabs.map((x) => x.view), ['files', 'messages', 'settings', 'groups'], `${w}px tab order`);
        assert.equal(s.tabs[3].label, 'Groups');
        assert.ok(s.sidebarGroupsLink, `${w}px: the desktop sidebar item that defines the route exists`);
        assert.deepEqual(s.tabs.filter((x) => x.truncated).map((x) => x.label), [], `${w}px: truncated labels`);
        assert.ok(s.tabs.every((x) => x.insideViewport), `${w}px: every tab inside the viewport`);
        assert.equal(s.overflowX, false, `${w}px: no horizontal page scroll`);
    }
});

test('groups ON: a touch tap on Groups opens the group list with the API-created group (same route as desktop)', async (t) => {
    if (!(await ensureBrowser(t))) return;
    const r = await modeOn();
    assert.equal(r.tapped.tapError, null, 'the Groups tab exists and can be tapped');
    assert.equal(r.tapped.hash, '#groups', 'tap navigated to #groups, the route the desktop Groups item uses');
    assert.ok(r.tapped.list, '#group-list rendered');
    assert.ok(r.tapped.row, 'the group created through POST /api/groups is listed');
    assert.ok(r.tapped.rowText.includes(r.tapped.name), `row text ${JSON.stringify(r.tapped.rowText)}`);
    assert.equal(r.tapped.activeView, 'groups', 'the Groups tab is highlighted by the existing router logic');
});

test('groups ON, short landscape phone (max-height 480px): all 4 tabs shown, icon beside label, none truncated', async (t) => {
    if (!(await ensureBrowser(t))) return;
    const r = (await modeOn()).landscape;
    assert.equal(r.display, 'flex');
    assert.ok(r.height <= 480, 'viewport is landscape-short');
    assert.equal(r.direction, 'row', 'compact icon-beside-label bar (responsive.css max-height:480px)');
    assert.deepEqual(r.labels, ['My Files', 'Messages', 'Settings', 'Groups']);
    assert.deepEqual(r.truncated, [false, false, false, false]);
    assert.ok(r.inside, 'all tabs inside the viewport');
});

test('groups OFF: 3 tabs, no Groups tab, no Groups sidebar link, no admin More button, no sideways scroll', async (t) => {
    if (!(await ensureBrowser(t))) return;
    const r = await modeOff();
    for (const w of WIDTHS) {
        const s = r.widths[w];
        assert.equal(s.display, 'flex');
        assert.deepEqual(s.tabs.map((x) => x.view), ['files', 'messages', 'settings'], `${w}px tabs`);
        assert.equal(s.sidebarGroupsLink, false, `${w}px: no Groups sidebar link`);
        assert.equal(s.moreButton, false, `${w}px: a non-admin has no More button`);
        assert.deepEqual(s.tabs.filter((x) => x.truncated), [], `${w}px: truncated labels`);
        assert.equal(s.overflowX, false);
    }
});
