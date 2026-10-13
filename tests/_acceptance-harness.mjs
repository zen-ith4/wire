// tests/_acceptance-harness.mjs  (helper, not a test)
//
// Phase 2 acceptance checks run against the REAL server process (node server.js), not an
// in-process express app: that is the only way to inspect what it really writes to the
// SQLite files (.db / -wal / -shm), to its upload directories and to its stdout/stderr.
//
// Isolation: every run gets its own work dir; DB_PATH, USER_DATA_ROOT and TMPDIR (multer's
// temp upload dir is os.tmpdir()/wire-uploads) all live inside it, so scanning `work` is
// scanning everything the server could have persisted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const PASSWORD = 'Passw0rd!x';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = () => crypto.randomBytes(5).toString('hex');

export async function waitFor(fn, ms, step = 250) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return false;
        await sleep(step);
    }
}

// ---------------------------------------------------------------- server
export async function startRealServer({ csp = 'false', extraEnv = {} } = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-accept-'));
    // The app's DEFAULT upload dirs live in the repo root (dm-uploads/, group-uploads/, ...). A scan of
    // `work` would silently miss them, so every one of them is redirected into `work`.
    const dirs = {
        db: path.join(work, 'db'), ud: path.join(work, 'userdata'), tmp: path.join(work, 'tmp'),
        chat: path.join(work, 'chat-uploads'), dm: path.join(work, 'dm-uploads'), group: path.join(work, 'group-uploads'),
        avatars: path.join(work, 'avatars'), banners: path.join(work, 'banners'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const rootBefore = new Set(fs.readdirSync(ROOT));
    const port = 4600 + Math.floor(Math.random() * 900);
    const env = {
        ...process.env, // includes tests/test.env; overridden below where it matters
        NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1',
        SETUP_COMPLETED: 'true', GROUPS_ENABLED: 'true', EMAIL_ENABLED: 'false',
        CSP_ENFORCE: csp, ALLOWED_SUBNET: '0.0.0.0/0',
        DB_PATH: path.join(dirs.db, 'wire.db'), USER_DATA_ROOT: dirs.ud, TMPDIR: dirs.tmp,
        CHAT_UPLOAD_DIR: dirs.chat, DM_UPLOAD_DIR: dirs.dm, GROUP_UPLOAD_DIR: dirs.group, AVATAR_DIR: dirs.avatars, BANNER_DIR: dirs.banners,
        JWT_SECRET: crypto.randomBytes(32).toString('hex'),
        EMAIL_VERIFICATION_SECRET: crypto.randomBytes(32).toString('hex'),
        ...extraEnv,
    };
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const origin = `http://127.0.0.1:${port}`;
    const up = await waitFor(async () => { try { return (await fetch(`${origin}/api/version`)).ok; } catch { return false; } }, 30000, 300);
    if (!up) { child.kill(); throw new Error(`server did not start:\n${log.slice(-800)}`); }
    return {
        origin, work, dirs, dbPath: env.DB_PATH, child,
        logs: () => log,
        /** New entries in the repo root since start = an upload dir the harness did not redirect. */
        strayRootEntries: () => fs.readdirSync(ROOT).filter((e) => !rootBefore.has(e)),
        stop: async () => {
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                await waitFor(() => child.exitCode !== null, 8000, 100);
                if (child.exitCode === null) child.kill('SIGKILL');
            }
        },
    };
}

export const jsonClient = (origin, token) => async (p, opts = {}) => {
    const res = await fetch(`${origin}${p}`, {
        ...opts,
        headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
};

// ---------------------------------------------------------------- scanning
/** Every regular file below `dir` (also dot files, -wal, -shm). */
export function walkFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(p, out);
        else if (e.isFile()) out.push(p);
    }
    return out;
}

/** Files under `dir` whose raw bytes contain `needle` (utf8, utf16le and base64 spellings). */
export function filesContaining(dir, needle) {
    const forms = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le'), Buffer.from(Buffer.from(needle).toString('base64'))];
    const hits = [];
    for (const f of walkFiles(dir)) {
        const buf = fs.readFileSync(f);
        if (forms.some((b) => buf.includes(b))) hits.push(path.relative(dir, f));
    }
    return hits;
}

export const textContains = (text, needle) =>
    text.includes(needle) || text.includes(Buffer.from(needle).toString('base64'));

// ---------------------------------------------------------------- browser
export async function launchBrowser() {
    const dir = process.env.CHROMIUM_DIR || '/tmp/browser-check';
    try {
        const req = createRequire(path.join(dir, 'noop.js'));
        const chromium = (await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href)).default;
        const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
        const browser = await puppeteer.launch({ args: [...chromium.args, '--no-sandbox'], executablePath: await chromium.executablePath(), headless: 'shell', protocolTimeout: 90000 });
        return { browser, reason: null };
    } catch (e) {
        return { browser: null, reason: e.message };
    }
}

export async function registerUser(origin, username) {
    const r = await jsonClient(origin)('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email: `${username}@example.com`, password: PASSWORD }) });
    if (r.status !== 201) throw new Error(`register ${username}: ${r.status} ${JSON.stringify(r.body)}`);
}

/**
 * A REST session for an account that has NOT been through the browser, so it is
 * still on login scheme 1 and a raw password is accepted.
 *
 * After a browser login this is no longer usable: the UI login migrates the
 * account to scheme 2 (services/credentialMigration.service.js), and the only
 * credential that can ever be produced for it is an authKey that exists solely
 * inside that browser page and never leaves it. A second raw-password login is
 * refused by the anti-downgrade rule in services/auth.service.js. Use
 * sessionFromPage() after loginUi(); use this for a browser-less client, which
 * must therefore be a different, never-UI-logged-in account.
 */
export async function restLogin(origin, username) {
    const r = await jsonClient(origin)('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password: PASSWORD }) });
    if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
    const token = r.body.token || r.body.accessToken || r.body.access_token;
    return { token, id: (r.body.user || r.body).id, api: jsonClient(origin, token), raw: r.body };
}

/**
 * The REST session the browser already holds after loginUi(), read out of the
 * page. Same shape as restLogin(), same Bearer token the REST routes accept
 * (setToken() writes exactly this JWT into localStorage.token, and
 * middleware/authenticate.js reads it back as `Authorization: Bearer`).
 *
 * This is the only way to get a REST client for an account that has been
 * through the UI login, because after that login no raw password is accepted
 * and no other credential can be obtained from outside the page.
 */
export async function sessionFromPage(page, origin, username) {
    // Read the token from this page's LIVE module graph, not from localStorage.
    // Several pages share one origin in these tests, so localStorage is shared:
    // loginUi() for the next user clears it and overwrites it, and reading it
    // later would hand back the WRONG user's token and id. getToken() is the
    // module-level variable in public/js/core/auth.js, so it is per page. This
    // is the same technique socketConnected() uses for the socket.
    const token = await page.evaluate(async () => (await import('/js/core/auth.js')).getToken());
    if (!token) throw new Error(`no session token in this page after UI login for ${username}`);
    const api = jsonClient(origin, token);
    const me = await api('/api/me/');
    if (me.status !== 200) throw new Error(`/api/me/ for ${username}: ${me.status} ${JSON.stringify(me.body)}`);
    const id = (me.body.user || me.body).id;
    if (!id) throw new Error(`/api/me/ returned no id for ${username}: ${JSON.stringify(me.body)}`);
    const meUser = me.body.user || me.body;
    if (meUser.username && meUser.username !== username) {
        throw new Error(`page session is ${meUser.username}, expected ${username}`);
    }
    return { token, id, api, raw: me.body };
}

/**
 * Real login form. The first browser login also creates the user's identity keys
 * and performs the one-time credential migration.
 *
 * Completion is an OBSERVED condition, not a sleep. Order in the client is:
 *   renderAuthCard -> await initializeIdentity(password, onSuccess)
 *     -> await migrateLegacyAccount(...)      (auth.js:418)
 *     -> await onSuccess()                    (auth.js:505, renders the app)
 * so `.nav-link` cannot appear before the migration has settled. The token is
 * checked too, because everything below depends on it.
 */
export async function loginUi(page, origin, username) {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-username');
    await page.type('#auth-username', username);
    await page.type('#auth-password', PASSWORD);
    await page.click('#auth-form button');
    await page.waitForSelector('.nav-link', { timeout: 30000 });
    await waitFor(() => page.evaluate(() => !!localStorage.getItem('token')), 15000, 50);
}

export async function socketConnected(page) {
    return waitFor(() => page.evaluate(async () => (await import('/js/core/socket.js')).getSocket()?.connected === true), 20000, 300);
}

/** Open a group with a real click on its list row (stable hook: group.js `.group-row[data-group-id]`). */
export async function openGroupUi(page, gid) {
    await page.click('.nav-link[data-view="groups"]');
    await page.waitForSelector(`.group-row[data-group-id="${gid}"]`, { timeout: 20000 });
    await page.click(`.group-row[data-group-id="${gid}"]`);
    await page.waitForSelector('#group-input', { timeout: 20000 });
}

/**
 * Type `text` in the group composer and press the real Send button until a message bubble
 * appears. A group created over REST has no Sender Key on alice's device yet, so the app's own
 * (idempotent) ensureSenderKeyForGroup() is called with the server's epoch, exactly what
 * openGroup() does. Crypto itself is not under test here.
 */
export async function sendGroupTextUi(page, api, gid, memberIds, text) {
    const before = await page.$$eval('.chat-msg', (e) => e.length);
    const ok = await waitFor(async () => {
        if ((await page.$$eval('.chat-msg', (e) => e.length)) > before) return true;
        const epoch = (await api('/api/groups')).body.find((x) => x.id === gid)?.key_epoch;
        await page.evaluate(async (g, ids, ep) => {
            const m = await import('/js/crypto/messages/group-message-crypto.js');
            await m.ensureSenderKeyForGroup(g, ids, ep);
        }, gid, memberIds, epoch).catch(() => {});
        if (!(await page.$eval('#group-input', (e) => e.value))) await page.type('#group-input', text);
        await page.click('[data-action="group-send"]');
        await sleep(1500);
        return (await page.$$eval('.chat-msg', (e) => e.length)) > before;
    }, 45000, 100);
    if (!ok) throw new Error('group message was not sent through the real composer');
}

/** Open the DM thread through the app's own function (what the DM list row calls). */
export async function openDmUi(page, peerId, peerName) {
    await page.click('.nav-link[data-view="messages"]');
    // wait for the Messages view to be mounted before calling the app's own opener (it dereferences its layout)
    await page.waitForSelector('.dm-layout #dm-conv-list', { timeout: 20000 });
    await sleep(600);
    const open = () => page.evaluate((id, name) => window.openDmConversation(id, name, { fromNav: true }), peerId, peerName);
    try { await open(); } catch { await sleep(1500); await open(); }
    await page.waitForSelector('#dm-input', { timeout: 20000 });
}

/** Type in the DM composer and send (Enter; if the text is still there, what the Send button calls). */
export async function sendDmTextUi(page, text) {
    const before = await page.$$eval('#dm-thread .chat-msg', (e) => e.length);
    await page.type('#dm-input', text);
    await page.keyboard.press('Enter');
    if (await waitFor(async () => (await page.$eval('#dm-input', (e) => e.value)) !== '', 1500, 150)) await page.evaluate(() => window.sendDm());
    const ok = await waitFor(async () => (await page.$$eval('#dm-thread .chat-msg', (e) => e.length)) > before, 20000, 200);
    if (!ok) throw new Error('DM text did not render after sending');
}
