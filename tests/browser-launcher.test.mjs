// tests/browser-launcher.test.mjs
//
// STEP 3D item 4: the browser launcher's opt-in logic.
//
// STEP 3C added a fallback to a locally installed Chrome/Edge when
// @sparticuz/chromium cannot run (it ships a LINUX binary). The review
// found that this made the browser results ambiguous: the same test file
// could pass on the project's own Chromium or on a local Chrome, and the
// report could hide which one ran.
//
// The fallback is now OPT-IN: it only runs when WIRE_TEST_ALLOW_SYSTEM_BROWSER=1
// is set, and the run prints which engine it used into the TAP output.
//
// The decision is a pure function, so it is unit-tested here - no browser
// needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserFallbackDecision, systemBrowserAllowed, browserEngineTapLine } from './_acceptance-harness.mjs';

test('without the opt-in the system browser is NOT used (the old behaviour: BLOCKED with the reason)', () => {
    const decision = browserFallbackDecision({
        chromiumError: '@sparticuz/chromium cannot run here',
        allowSystemBrowser: false,
        systemPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    assert.equal(decision.use, false);
    assert.equal(decision.path, null);
    assert.equal(decision.reason, '@sparticuz/chromium cannot run here', 'the reason must survive');
});

test('with the opt-in and a local browser, the fallback is used', () => {
    const decision = browserFallbackDecision({
        chromiumError: 'boom',
        allowSystemBrowser: true,
        systemPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    assert.equal(decision.use, true);
    assert.equal(decision.path, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.equal(decision.reason, null);
});

test('with the opt-in but NO local browser the run is still blocked', () => {
    const decision = browserFallbackDecision({
        chromiumError: 'boom',
        allowSystemBrowser: true,
        systemPath: null,
    });
    assert.equal(decision.use, false);
    assert.equal(decision.reason, 'boom');
});

test('the opt-in is exactly WIRE_TEST_ALLOW_SYSTEM_BROWSER=1', () => {
    const before = process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER;
    try {
        delete process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER;
        assert.equal(systemBrowserAllowed(), false);
        process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER = '0';
        assert.equal(systemBrowserAllowed(), false, '"0" is not the opt-in');
        process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER = 'true';
        assert.equal(systemBrowserAllowed(), false, 'only "1" is the opt-in');
        process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER = '1';
        assert.equal(systemBrowserAllowed(), true);
    } finally {
        if (before === undefined) delete process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER;
        else process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER = before;
    }
});

test('the TAP line names the engine (a comment line)', () => {
    const line = browserEngineTapLine({ engine: 'system browser C:\\chrome.exe Chrome/140.0.1' });
    assert.ok(line.startsWith('# browser: '), `the line must be a TAP comment: ${line}`);
    assert.match(line, /system browser/);
    assert.match(line, /Chrome\/140\.0\.1/);

    // A blocked run says so, with the reason.
    const blocked = browserEngineTapLine({ engine: 'none', reason: 'no chromium here' });
    assert.ok(blocked.startsWith('# browser: '));
    assert.match(blocked, /no chromium here/);
});
