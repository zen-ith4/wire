// tests/apk-integrity.test.mjs
//
// /api/apk/info must return a SHA-256 of the exact bytes /api/apk/download
// streams, and that hash must track the file on disk. The Android client
// (public/js/core/appUpdate.js) re-hashes what it downloads and refuses to
// install unless it matches — so this is the server half of that contract:
// a stale env var or a hot-swapped build must not advertise a hash that no
// longer matches the served bytes.
//
// controllers/apk.controller.js touches only fs + config/constants (never the
// database), so this drives the controller directly with a fake res instead of
// booting a whole server. env is set BEFORE requiring the module, because
// config/constants.js reads APK_PATH/APK_VERSION_NAME at import time and the
// controller caches the hash at module scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-integrity-'));
const apkPath = path.join(tmp, 'apk-debug.apk');

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

test('reports a SHA-256 that matches the served bytes when the file is present', () => {
    fs.writeFileSync(apkPath, FIXTURE_A);
    const { getApkInfo } = requireFreshController();

    const res = makeRes();
    getApkInfo({}, res);

    assert.equal(res.body.available, true);
    assert.equal(res.body.versionName, '1.2.3');
    assert.equal(res.body.size, FIXTURE_A.length);
    assert.equal(res.body.sha256, sha256(FIXTURE_A));
});

test('the advertised hash tracks a changed build (mtime/size cache invalidates)', () => {
    // First call hashes FIXTURE_A and caches it.
    fs.writeFileSync(apkPath, FIXTURE_A);
    const { getApkInfo } = requireFreshController();
    const resA = makeRes();
    getApkInfo({}, resA);
    assert.equal(resA.body.sha256, sha256(FIXTURE_A));

    // Same file again: the cache must still serve the same hash.
    const resAagain = makeRes();
    getApkInfo({}, resAagain);
    assert.equal(resAagain.body.sha256, sha256(FIXTURE_A));

    // A different build (different size -> stale cache) must be re-hashed.
    fs.writeFileSync(apkPath, FIXTURE_B);
    const resB = makeRes();
    getApkInfo({}, resB);
    assert.equal(resB.body.sha256, sha256(FIXTURE_B));
});

test('with no APK file advertised as unavailable and no hash', () => {
    const missing = path.join(tmp, 'does-not-exist.apk');
    const { getApkInfo } = requireFreshController(missing);

    const res = makeRes();
    getApkInfo({}, res);
    assert.equal(res.body.available, false);
    assert.equal(res.body.sha256, undefined);
});
