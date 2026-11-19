// tests/apk-integrity.test.mjs
//
// /api/apk/info must return a SHA-256 of the exact bytes /api/apk/download
// streams, and that hash must track the file on disk. The Android client
// (public/js/core/appUpdate.js) re-hashes what it downloads and refuses to
// install unless it matches — so this is the server half of that contract:
// a stale env var or a hot-swapped build must not advertise a hash that no
// longer matches the served bytes.
//
// Fail-closed contract under test:
//   - when the APK is present and versioned, the response MUST carry a real
//     SHA-256 (64 hex chars, matching the file bytes) — never sha256: null and
//     never a missing key;
//   - when the bytes cannot be hashed, the response MUST be { available: false }
//     — the server never advertises an update it cannot verify.
//
// controllers/apk.controller.js touches only fs + config/constants (never the
// database), so this drives the controller directly with a fake res instead of
// booting a whole server. env is set BEFORE requiring the module, because
// config/constants.js reads APK_PATH/APK_VERSION_NAME at import time and the
// controller caches the hash at module scope.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-integrity-'));
const apkPath = path.join(tmp, 'app-debug.apk');

const FIXTURE_A = Buffer.from('AAAAA', 'ascii'); // 5 bytes
const FIXTURE_B = Buffer.from('BBBBBBBBB', 'ascii'); // 9 bytes — different size,
// so the (size, mtimeMs) cache key is guaranteed stale and the hash is
// recomputed deterministically regardless of clock resolution.

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function makeRes() {
    const res = { body: undefined, statusValue: 200 };
    res.status = function () { this.statusValue = 200; return this; };
    res.json = function (body) { this.body = body; return this; };
    return res;
}

function requireFreshController(apkPathOverride) {
    delete process.env.APK_PATH;
    delete process.env.APK_VERSION_NAME;
    delete process.env.APK_VERSION_CODE;
    process.env.APK_PATH = apkPathOverride ?? apkPath;
    process.env.APK_VERSION_NAME = '1.2.3';
    process.env.APK_VERSION_CODE = 123;

    // config/constants.js reads the APK_* env at import time and caches it, so
    // both the controller AND constants must be re-required to pick up the new
    // values. require.resolve gives the string cache key (require() itself
    // returns exports, which is the wrong key here).
    for (const key of [
        require.resolve('../controllers/apk.controller.js'),
        require.resolve('../config/constants.js'),
    ]) {
        delete require.cache[key];
    }

    return require(require.resolve('../controllers/apk.controller.js'));
}

test('getApkInfo reports a SHA-256 that matches the served bytes when the file is present', async () => {
    fs.writeFileSync(apkPath, FIXTURE_A);
    const { getApkInfo } = requireFreshController();

    const res = makeRes();
    await getApkInfo({}, res);

    assert.equal(res.body.available, true);
    assert.equal(res.body.versionName, '1.2.3');
    assert.equal(res.body.size, FIXTURE_A.length);
    // The advertised hash must be present and real — never missing, never null.
    assert.equal(typeof res.body.sha256, 'string');
    assert.match(res.body.sha256, /^[a-f0-9]{64}$/);
    assert.equal(res.body.sha256, sha256(FIXTURE_A));
});

test('the advertised hash tracks a changed build (mtime/size cache invalidates)', async () => {
    // First call hashes FIXTURE_A and caches it.
    fs.writeFileSync(apkPath, FIXTURE_A);
    const { getApkInfo } = requireFreshController();
    const resA = makeRes();
    await getApkInfo({}, resA);
    assert.equal(resA.body.sha256, sha256(FIXTURE_A));

    // Same file again: the cache must still serve the same hash.
    const resAagain = makeRes();
    await getApkInfo({}, resAagain);
    assert.equal(resAagain.body.sha256, sha256(FIXTURE_A));

    // A different build (different size -> stale cache) must be re-hashed and
    // the ADVERTISED hash must be the new bytes' hash (a stale/mismatching hash
    // is exactly the bug the client-side comparison guards against).
    fs.writeFileSync(apkPath, FIXTURE_B);
    const resB = makeRes();
    await getApkInfo({}, resB);
    assert.equal(resB.body.sha256, sha256(FIXTURE_B));
    assert.notEqual(resB.body.sha256, sha256(FIXTURE_A));
});

test('with no APK file advertised as unavailable and no hash', async () => {
    const missing = path.join(tmp, 'does-not-exist.apk');
    const { getApkInfo } = requireFreshController(missing);

    const res = makeRes();
    await getApkInfo({}, res);
    assert.equal(res.body.available, false);
    assert.equal(res.body.sha256, undefined);
});

test('getApkInfo fails closed to available:false (never sha256:null) when the hash cannot be computed', async (t) => {
    fs.writeFileSync(apkPath, FIXTURE_A);
    const { getApkInfo } = requireFreshController();

    // Keep the file PRESENT on disk (so apkExists() is true) but force the
    // async hash to fail: stub fs.createReadStream to hand back a stream that
    // emits an error. (A chmod-based failure is POSIX non-root only and does not
    // work on Windows, so the stub is the portable way to reach the hash-failure
    // branch.)
    const fakeStream = new EventEmitter();
    mock.method(fs, 'createReadStream', () => fakeStream);
    t.after(() => mock.restoreAll());
    process.nextTick(() => fakeStream.emit('error', new Error('stubbed createReadStream failure')));

    const res = makeRes();
    await getApkInfo({}, res);

    assert.equal(res.body.available, false);
    assert.notEqual(res.body.sha256, null);
    assert.equal(res.body.sha256, undefined);
});

test("the client's downloadAndInstall() refuses to install when no SHA-256 was advertised", () => {
    // public/js/core/appUpdate.js is an ES module written for the browser WebView
    // (it imports the Capacitor vendor shims and uses window/document), so it
    // cannot be imported under node:test. Assert on the fail-closed guard source
    // instead: downloadAndInstall must REFUSE (return before download/install) when
    // the advertised hash is missing, and must not skip the check via a null check.
    const src = fs.readFileSync(path.join(ROOT, 'public/js/core/appUpdate.js'), 'utf8');
    assert.match(
        src,
        /if \(!expectedSha256\) \{/,
        'client must refuse to install when the advertised SHA-256 is missing'
    );
    assert.doesNotMatch(
        src,
        /expectedSha256 != null &&/,
        'client must not skip the integrity check when the advertised hash is missing'
    );
});
