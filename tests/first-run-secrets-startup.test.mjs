// First-run startup: the real server.js must reach the setup wizard when the
// secrets in .env are missing, empty, quoted-empty, too short or the shipped
// CHANGE_ME/example values - in development AND production. After setup the
// existing fatal checks must stay in force.
//
// Every case runs the REAL server.js in a throw-away copy of the tree, because
// the failure happened before the wizard existed: config/constants.js called
// process.exit(1) at module load. The copy never reads the repository's real
// .env: only the tracked .env.example is used, and env files are written by the
// test itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, makeServerDirs, pickFreePort, serverEnv } from './_acceptance-harness.mjs';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const cred = require(path.join(ROOT, 'utils', 'credentials.js'));

const SECRET_KEYS = ['JWT_SECRET', 'EMAIL_VERIFICATION_SECRET'];
const HEX64 = /^[0-9a-f]{64}$/;
const GOOD_PW = 'first run admin password';

const SKIPPED_DIRS = new Set([
    'node_modules', '.git', 'tests', 'electron-client',
    'data.db', 'data', 'user-data', 'chat-uploads', 'dm-uploads',
    'group-uploads', 'avatars', 'banners', 'logs', 'uploads',
]);

const tmpDirs = [];

function tmpDir(prefix = 'wire-first-run-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

process.on('exit', () => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// A source copy that can boot standalone: node_modules is symlinked, and every
// runtime directory / database / env file is left behind so the run cannot
// touch or leak operator state.
function copyTree() {
    const dir = tmpDir();
    const tree = path.join(dir, 'app');
    fs.mkdirSync(tree);

    for (const entry of fs.readdirSync(ROOT)) {
        if (
            entry === '.env' ||
            (entry.startsWith('.env.') && entry !== '.env.example') ||
            SKIPPED_DIRS.has(entry) ||
            entry.endsWith('.db') ||
            entry.endsWith('.apk')
        ) {
            continue;
        }

        fs.cpSync(path.join(ROOT, entry), path.join(tree, entry), { recursive: true });
    }

    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'));
    return { dir, tree };
}

function buildEnv({ dir, port, nodeEnv }) {
    const dirs = makeServerDirs(dir);
    const env = serverEnv({
        dirs,
        port,
        nodeEnv,
        csp: 'false',
        extraEnv: {
            BCRYPT_ROUNDS: '4',
            ALLOWED_SUBNET: '127.0.0.0/8',
        },
    });

    // The point of the test is the values IN .env, so the parent test process
    // must not supply usable secrets or a completed-setup flag.
    delete env.JWT_SECRET;
    delete env.EMAIL_VERIFICATION_SECRET;
    delete env.SETUP_COMPLETED;

    env.EMAIL_ENABLED = 'false';
    return env;
}

// One copy + one spawn site for both flows, so the spawn-isolation guard sees
// exactly one serverEnv() per server.js spawn.
async function startChild({ envContent, nodeEnv, stdin }) {
    const { dir, tree } = copyTree();

    if (envContent !== null) {
        fs.writeFileSync(path.join(tree, '.env'), envContent);
    }

    const port = await pickFreePort();
    const env = buildEnv({ dir, port, nodeEnv });
    const child = spawn(process.execPath, ['server.js'], {
        cwd: tree,
        env,
        stdio: [stdin, 'pipe', 'pipe'],
    });

    return { tree, port, child, dbPath: env.DB_PATH };
}

const ansi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// Prompt -> answer, in the order the wizard asks them.
function wizardSteps(port) {
    return [
        [/Choice \[1\/2\]: $/, '2'],
        [/WireGuard IP Address \[[^\]]*\]: $/, '127.0.0.1'],
        [/Port \[[^\]]*\]: $/, String(port)],
        [/Enable HTTPS\? \[Y\/n\]: $/, 'n'],
        [/Admin username: $/, 'WizAdmin'],
        [/Admin email: $/, 'wiz@x.invalid'],
        [/Admin password: $/, GOOD_PW],
        [/Confirm admin password: $/, GOOD_PW],
        [/Apply configuration and continue\? \[y\/N\]: $/, 'y'],
    ];
}

// Starts server.js and drives the wizard to completion. Resolves once the
// server is listening.
async function runFirstRun({ envContent, nodeEnv, label }) {
    const { tree, port, child, dbPath } = await startChild({
        envContent,
        nodeEnv,
        stdin: 'pipe',
    });

    let out = '';
    let step = 0;
    const steps = wizardSteps(port);

    const onData = (chunk) => {
        out += chunk.toString();
        const tail = ansi(out).slice(-600);

        while (step < steps.length && steps[step][0].test(tail)) {
            child.stdin.write(steps[step][1] + '\n');
            step++;
        }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const stop = async () => {
        if (child.exitCode !== null) return;

        child.kill('SIGTERM');

        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 8000);

            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    };

    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`${label}: server did not finish starting:\n${ansi(out).slice(-2000)}`));
            }, 120000);

            const poll = setInterval(() => {
                if (ansi(out).includes('started successfully')) {
                    clearTimeout(timer);
                    clearInterval(poll);
                    resolve();
                }
            }, 100);

            child.once('exit', () => {
                if (!ansi(out).includes('started successfully')) {
                    clearTimeout(timer);
                    clearInterval(poll);
                    reject(new Error(`${label}: exited before the wizard finished:\n${ansi(out).slice(-2000)}`));
                }
            });
        });
    } catch (error) {
        await stop();
        throw error;
    }

    return {
        tree,
        port,
        dbPath,
        output: () => ansi(out),
        envFile: () => fs.readFileSync(path.join(tree, '.env'), 'utf8'),
        stop,
    };
}

// Proves the process that is listening uses the exact JWT_SECRET written to
// .env: log in with the wizard's admin and verify the issued token with the
// file's secret. A process still holding the pre-setup value fails here.
async function assertRunningProcessUsesFileSecret(run) {
    const fileEnv = dotenv.parse(run.envFile());
    const db = new Database(run.dbPath, { readonly: true });

    let user;
    try {
        user = db.prepare(
            "SELECT username, kdf_salt, kdf_iterations FROM users WHERE lower(username) = 'wizadmin'"
        ).get();
    } finally {
        db.close();
    }

    assert.ok(user, 'the wizard created the admin user');

    const { authKey } = cred.deriveCredentialsNode(GOOD_PW, user.kdf_salt, user.kdf_iterations);
    const response = await fetch(`http://127.0.0.1:${run.port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user.username, auth_key: authKey }),
    });

    assert.equal(response.status, 200, 'login succeeds against the running server');

    const body = await response.json();
    assert.ok(body.token, 'login returned a JWT');

    const decoded = jwt.verify(body.token, fileEnv.JWT_SECRET);
    assert.equal(decoded.username, user.username);

    // The old/placeholder value must not verify the token: this is the state a
    // process would be in if the wizard changed .env but not process.env.
    assert.throws(() => jwt.verify(body.token, 'x'.repeat(64)));
    return fileEnv;
}

function assertUsableSecrets(env, message) {
    for (const key of SECRET_KEYS) {
        assert.match(env[key] ?? '', HEX64, `${message}: ${key} is usable`);
    }

    assert.notEqual(env.JWT_SECRET, env.EMAIL_VERIFICATION_SECRET, `${message}: secrets differ`);
}

async function assertFirstRunSucceeds({ envContent, nodeEnv, label }) {
    const run = await runFirstRun({ envContent, nodeEnv, label });

    try {
        const fileEnv = dotenv.parse(run.envFile());

        assert.equal(fileEnv.SETUP_COMPLETED, 'true', `${label}: wizard completed`);
        assertUsableSecrets(fileEnv, label);

        for (const key of SECRET_KEYS) {
            const occurrences = run.envFile()
                .split('\n')
                .filter((line) => line.startsWith(`${key}=`)).length;
            assert.equal(occurrences, 1, `${label}: ${key} appears once`);
        }

        const runningEnv = await assertRunningProcessUsesFileSecret(run);
        assert.equal(runningEnv.JWT_SECRET, fileEnv.JWT_SECRET);
        assert.equal(runningEnv.EMAIL_VERIFICATION_SECRET, fileEnv.EMAIL_VERIFICATION_SECRET);
        return run;
    } finally {
        await run.stop();
    }
}

// Runs server.js with a completed setup and expects the fatal secret check to
// run before anything else (no wizard, no listener).
async function runCompletedSetup({ envContent, label }) {
    const { child } = await startChild({
        envContent,
        nodeEnv: 'development',
        stdin: 'ignore',
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${label}: server neither exited nor started:\n${ansi(out).slice(-2000)}`));
        }, 30000);

        child.once('exit', (exitCode) => {
            clearTimeout(timer);
            resolve(exitCode);
        });
    });

    return { code, output: ansi(out) };
}

test('copied .env.example: development first run reaches the wizard and replaces CHANGE_ME', async () => {
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert.match(example, /^JWT_SECRET=CHANGE_ME$/m);
    assert.match(example, /^EMAIL_VERIFICATION_SECRET=CHANGE_ME$/m);

    const run = await assertFirstRunSucceeds({
        envContent: example,
        nodeEnv: 'development',
        label: '.env.example',
    });

    const env = dotenv.parse(run.envFile());
    assert.notEqual(env.JWT_SECRET, 'CHANGE_ME');
    assert.notEqual(env.EMAIL_VERIFICATION_SECRET, 'CHANGE_ME');
    assert.match(run.output(), /Wire First-Run Setup/);
});

test('empty values: too-short secret and quoted-empty secret are replaced, not fatal', async () => {
    const envContent = [
        'NODE_ENV=development',
        'SETUP_COMPLETED=false',
        'HOST=127.0.0.1',
        'PORT=3002',
        'ALLOWED_SUBNET=127.0.0.0/8',
        'EMAIL_ENABLED=false',
        'JWT_SECRET=too-short',
        'EMAIL_VERIFICATION_SECRET=""',
        '',
    ].join('\n');

    const run = await assertFirstRunSucceeds({
        envContent,
        nodeEnv: 'development',
        label: 'empty values',
    });

    const env = dotenv.parse(run.envFile());
    assert.notEqual(env.JWT_SECRET, 'too-short');
    assert.notEqual(env.EMAIL_VERIFICATION_SECRET, '""');
});

test('production first run: .env.example secrets are replaced and the wizard completes', async () => {
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    // .env.example ships a wildcard subnet, which has its own (unchanged)
    // production check. This test isolates the secret behaviour.
    const envContent = example.replace(/^ALLOWED_SUBNET=.*$/m, 'ALLOWED_SUBNET=127.0.0.0/8');

    await assertFirstRunSucceeds({
        envContent,
        nodeEnv: 'production',
        label: 'production first run',
    });
});

test('completed setup with the example/placeholder secrets stays fatal (JWT)', async () => {
    const run = await runCompletedSetup({
        label: 'completed setup, bad JWT',
        envContent: [
            'NODE_ENV=development',
            'SETUP_COMPLETED=true',
            'HOST=127.0.0.1',
            'PORT=3002',
            'ALLOWED_SUBNET=127.0.0.0/8',
            'EMAIL_ENABLED=false',
            'JWT_SECRET=CHANGE_ME',
            'EMAIL_VERIFICATION_SECRET=' + 'e'.repeat(48),
            '',
        ].join('\n'),
    });

    assert.equal(run.code, 1);
    assert.match(run.output, /FATAL: JWT_SECRET is unsafe/);
    assert.doesNotMatch(run.output, /Wire First-Run Setup/);
});

test('completed setup with the example/placeholder secrets stays fatal (EMAIL)', async () => {
    const run = await runCompletedSetup({
        label: 'completed setup, bad EMAIL',
        envContent: [
            'NODE_ENV=development',
            'SETUP_COMPLETED=true',
            'HOST=127.0.0.1',
            'PORT=3002',
            'ALLOWED_SUBNET=127.0.0.0/8',
            'EMAIL_ENABLED=true',
            'JWT_SECRET=' + 'j'.repeat(48),
            'EMAIL_VERIFICATION_SECRET="CHANGE_ME"',
            '',
        ].join('\n'),
    });

    assert.equal(run.code, 1);
    assert.match(run.output, /FATAL: EMAIL_VERIFICATION_SECRET is unsafe/);
    assert.doesNotMatch(run.output, /Wire First-Run Setup/);
});
