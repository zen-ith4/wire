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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FETCH_BLOCKED_PORTS } from './_port.mjs';

const require = createRequire(import.meta.url);

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
// The refused-port list lives in tests/_port.mjs, shared with every other test
// helper that binds a port, and is re-derived behaviourally by
// tests/port-hygiene.test.mjs.
const BLOCKED_PORTS = FETCH_BLOCKED_PORTS;

/**
 * A port for the real server child process.
 *
 * The server reads PORT from the environment and calls server.listen(PORT), so
 * it cannot be given 0 to let the OS choose; the port has to be picked here.
 * A blind `4600 + random(900)` was wrong twice over: it could land on a
 * refused port (5060/5061 are inside that range, and then the readiness fetch
 * below throws "bad port" and the harness reports "server did not start" even
 * though the server printed "started successfully"), and it could collide with
 * a port another run already holds.
 *
 * So: skip the refused ports, then actually confirm the candidate is bindable
 * before handing it over, and retry rather than fail. There is an unavoidable
 * gap between closing the probe and the child binding, which is why the caller
 * also retries on EADDRINUSE.
 */
export async function pickFreePort({ random = Math.random } = {}) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const candidate = 4600 + Math.floor(random() * 900);
        // The check the whole module exists for. Exported and injected-random so
        // tests/port-hygiene.test.mjs can drive this deterministically: with a
        // random source, a mutation that deletes this line would pass ~99.8% of
        // the time, because only 5060 and 5061 of the 900 candidates are blocked.
        if (BLOCKED_PORTS.has(candidate)) continue;
        const bindable = await new Promise((resolve) => {
            const probe = net.createServer();
            probe.once('error', () => resolve(false));
            probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
        });
        if (bindable) return candidate;
    }
    throw new Error('could not find a bindable, non-refused port for the test server');
}

/**
 * Every environment variable that must point INSIDE the work dir.
 *
 * The app's DEFAULT upload dirs live in the repo root (avatars/, banners/,
 * chat-uploads/, dm-uploads/, group-uploads/) and its default user data root is
 * ./user-data. A server booted without these redirected creates empty
 * directories in the repo root, which then breaks
 * tests/acceptance-no-plaintext.test.mjs - it scans the work dir to prove the
 * server persisted nothing readable, and a run that leaves dirs in the repo root
 * is exactly the condition that control exists to catch.
 *
 * Six files used to spawn server.js and each remembered a different subset of
 * these. The list is exported so tests/server-spawn-isolation.test.mjs can
 * assert nothing spawns without all of them.
 */
export const SERVER_DIR_VARS = Object.freeze([
    'DB_PATH',
    'USER_DATA_ROOT',
    'TMPDIR',
    'CHAT_UPLOAD_DIR',
    'DM_UPLOAD_DIR',
    'GROUP_UPLOAD_DIR',
    'AVATAR_DIR',
    'BANNER_DIR',
]);

/**
 * Create and return the per-run directory map. `work` is normally a fresh
 * mkdtemp dir, but any directory works - a test that already has one passes it.
 */
export function makeServerDirs(work) {
    const dirs = {
        root: work,
        db: path.join(work, 'db'),
        ud: path.join(work, 'user-data'),
        tmp: path.join(work, 'tmp'),
        chat: path.join(work, 'chat-uploads'),
        dm: path.join(work, 'dm-uploads'),
        group: path.join(work, 'group-uploads'),
        avatars: path.join(work, 'avatars'),
        banners: path.join(work, 'banners'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    return dirs;
}

/**
 * Build a server environment that cannot write into the repo root.
 *
 * The eight SERVER_DIR_VARS are computed HERE from `dirs`, not accepted from the
 * caller, so a spawn site cannot forget one. `extraEnv` is spread last and can
 * still override them - which is deliberate, and is what tests/server-spawn-
 * isolation.test.mjs exists to police.
 */
export function serverEnv({
    dirs,
    port,
    csp = 'false',
    nodeEnv = 'development',
    host = '127.0.0.1',
    jwtSecret,
    emailSecret,
    dmE2eeDefaultMinVersion,
    extraEnv = {},
    base = process.env,
} = {}) {
    if (!dirs) throw new Error('serverEnv: dirs is required');
    if (port === undefined || port === null) throw new Error('serverEnv: port is required');

    return {
        ...base, // includes tests/test.env; overridden below where it matters
        NODE_ENV: nodeEnv,
        PORT: String(port),
        HOST: host,
        SETUP_COMPLETED: 'true',
        GROUPS_ENABLED: 'true',
        EMAIL_ENABLED: 'false',
        CSP_ENFORCE: csp,
        ALLOWED_SUBNET: '0.0.0.0/0',
        // --- the eight, always, from `dirs`
        DB_PATH: path.join(dirs.db, 'wire.db'),
        USER_DATA_ROOT: dirs.ud,
        TMPDIR: dirs.tmp,
        CHAT_UPLOAD_DIR: dirs.chat,
        DM_UPLOAD_DIR: dirs.dm,
        GROUP_UPLOAD_DIR: dirs.group,
        AVATAR_DIR: dirs.avatars,
        BANNER_DIR: dirs.banners,
        // ---
        JWT_SECRET: jwtSecret ?? crypto.randomBytes(32).toString('hex'),
        EMAIL_VERIFICATION_SECRET: emailSecret ?? crypto.randomBytes(32).toString('hex'),
        // Forward the DM E2EE default floor (STEP 1C). Explicit so a test can
        // override via extraEnv or the param; falls back to the parent env.
        ...(function () {
            const v = dmE2eeDefaultMinVersion !== undefined
                ? dmE2eeDefaultMinVersion
                : base.DM_E2EE_DEFAULT_MIN_VERSION;
            return v === undefined ? {} : { DM_E2EE_DEFAULT_MIN_VERSION: String(v) };
        })(),
        ...extraEnv,
    };
}

export async function startRealServer({ csp = 'false', extraEnv = {}, work = null } = {}) {
    const runWork = work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wire-accept-'));
    const dirs = makeServerDirs(runWork);
    const rootBefore = new Set(fs.readdirSync(ROOT));
    const port = await pickFreePort();
    const env = serverEnv({ dirs, port, csp, extraEnv });
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const origin = `http://127.0.0.1:${port}`;
    const up = await waitFor(async () => { try { return (await fetch(`${origin}/api/version`)).ok; } catch { return false; } }, 30000, 300);
    if (!up) { child.kill(); throw new Error(`server did not start:\n${log.slice(-800)}`); }
    return {
        origin, work: runWork, dirs, dbPath: env.DB_PATH, child,
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

/**
 * F7: the group endpoints are gated by requireGroupProtocol and answer 426
 * unless the request declares X-Wire-Group-Proto. The real client sends this
 * (public/js/core/api.js); this helper did not, so every group call a test made
 * directly came back 426 and the test then failed on an empty result.
 *
 * The value is read from the middleware rather than hardcoded, so bumping
 * GROUP_PROTOCOL_MIN cannot silently break the tests again. Only /api/groups
 * is gated. An explicit header in opts still wins, so a test that deliberately
 * sends a stale value (group-hardening-f7-version-gate) keeps working.
 */
export function groupProtocolHeaders(pathname, explicit = {}) {
    const { GROUP_PROTOCOL_MIN } = require(path.join(ROOT, 'middleware', 'groupProtocol.js'));
    if (typeof pathname !== 'string' || !pathname.startsWith('/api/groups')) return explicit;
    if (explicit['X-Wire-Group-Proto'] != null || explicit['x-wire-group-proto'] != null) return explicit;
    return { ...explicit, 'X-Wire-Group-Proto': String(GROUP_PROTOCOL_MIN) };
}

export const jsonClient = (origin, token) => async (p, opts = {}) => {
    const res = await fetch(`${origin}${p}`, {
        ...opts,
        headers: {
            ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...groupProtocolHeaders(p, opts.headers || {}),
        },
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

/**
 * The OPT-IN for the system-browser fallback (STEP 3D item 4).
 *
 * The project normally runs the browser tests with @sparticuz/chromium,
 * which ships a LINUX binary. On a machine without it the tests are BLOCKED
 * with the reason - that is the behaviour without this variable. A locally
 * installed Chrome/Edge is used ONLY when the run explicitly asks for it:
 *
 *     WIRE_TEST_ALLOW_SYSTEM_BROWSER=1 node --test ...
 *
 * The decision is a pure function so it can be unit-tested without a
 * browser.
 *
 * @param {object} o
 * @param {string|null} o.chromiumError why the primary path failed
 * @param {boolean} o.allowSystemBrowser the opt-in
 * @param {string|null} o.systemPath a locally installed browser, if there is one
 * @returns {{use: boolean, path: string|null, reason: string|null}}
 */
export function browserFallbackDecision({ chromiumError = null, allowSystemBrowser = false, systemPath = null } = {}) {
    if (!allowSystemBrowser) {
        return { use: false, path: null, reason: chromiumError };
    }
    if (!systemPath) {
        return { use: false, path: null, reason: chromiumError || 'no local browser found' };
    }
    return { use: true, path: systemPath, reason: null };
}

/** Is the system-browser fallback allowed in this run? */
export function systemBrowserAllowed() {
    return process.env.WIRE_TEST_ALLOW_SYSTEM_BROWSER === '1';
}

/**
 * The line the browser tests print into their TAP output, so a report can
 * never hide which engine ran.
 * @param {{engine?: string, reason?: string|null}} launched
 */
export function browserEngineTapLine(launched) {
    const engine = launched?.engine || 'unknown';
    const reason = launched?.reason ? ` (${launched.reason})` : '';
    return `# browser: ${engine}${reason}`;
}

/**
 * Launches the browser.
 *
 * The primary path is @sparticuz/chromium (the project's own). When it
 * cannot be used AND the run opted into the system-browser fallback, a
 * locally installed Chrome/Edge is used instead - and the run says so, in
 * the console and (through browserEngineTapLine) in the TAP output.
 *
 * @returns {Promise<{browser: object|null, reason: string|null, engine: string}>}
 */
export async function launchBrowser() {
    const dir = process.env.CHROMIUM_DIR || '/tmp/browser-check';
    try {
        const req = createRequire(path.join(dir, 'noop.js'));
        const chromium = (await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href)).default;
        const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
        const browser = await puppeteer.launch({ args: [...chromium.args, '--no-sandbox'], executablePath: await chromium.executablePath(), headless: 'shell', protocolTimeout: 90000 });
        const engine = `chromium (@sparticuz/chromium) ${await browser.version()}`;
        console.log(browserEngineTapLine({ engine }));
        return { browser, reason: null, engine };
    } catch (e) {
        const decision = browserFallbackDecision({
            chromiumError: e.message,
            allowSystemBrowser: systemBrowserAllowed(),
            systemPath: systemBrowserPath(),
        });
        if (!decision.use) {
            console.log(browserEngineTapLine({ engine: 'none', reason: decision.reason }));
            return { browser: null, reason: decision.reason, engine: 'none' };
        }
        try {
            const req = createRequire(path.join(dir, 'noop.js'));
            const chromium = (await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href)).default;
            const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
            // The Linux-only flags of @sparticuz/chromium mean nothing to a
            // Windows Chrome and some of them break it.
            const LINUX_ONLY = /--single-process|--no-zygote|--in-process-gpu|--use-gl=angle|--use-angle=swiftshader|--disable-setuid-sandbox/;
            const args = chromium.args.filter((a) => !LINUX_ONLY.test(a));
            const browser = await puppeteer.launch({
                args: [...args, '--no-sandbox', '--headless=new', '--disable-gpu'],
                executablePath: decision.path,
                headless: 'shell',
                protocolTimeout: 90000,
            });
            const engine = `system browser ${decision.path} ${await browser.version()}`;
            console.log(browserEngineTapLine({ engine }));
            return { browser, reason: null, engine };
        } catch (e2) {
            const reason = `${e.message} | system browser failed: ${e2.message}`;
            console.log(browserEngineTapLine({ engine: 'none', reason }));
            return { browser: null, reason, engine: 'none' };
        }
    }
}

/** A locally installed Chrome/Edge, if there is one (Windows fallback). */
export function systemBrowserPath() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch { /* ignore */ }
    }
    return null;
}

/**
 * A page for ONE account, in a browser PROCESS (and therefore a profile) of its
 * own. Returns `{ page, browser }`; close the browser through
 * closeUserBrowsers(), which the test file's `after` hook must call.
 *
 * Why a whole process and not browser.createBrowserContext():
 *
 *  - Storage. browser.newPage() opens a page in the DEFAULT context, and every
 *    page there shares one profile's localStorage AND IndexedDB. The group
 *    crypto store ("wire-group-crypto", object store "sender-keys") is keyed per
 *    profile, not per account, so two accounts opened that way see each other's
 *    rows. When the second account's page drains a KDM carrying the first
 *    account's senderKeyId, storeReceivedSenderKey() cannot unwrap that row with
 *    its own local wrap key, treats it as "another account's row" and REPLACES
 *    it (ifAbsent: false). The first account's row becomes isMine:0 with no
 *    signing key, getMySenderKey() returns null, and the composer reports
 *    "No Sender Key to send with yet" for the rest of the run.
 *  - Chromium in single-process mode. @sparticuz/chromium - what launchBrowser()
 *    loads by default - runs Chromium with --single-process --no-zygote. In
 *    that mode creating a second browser context kills the browser outright
 *    ("Protocol error (Target.createTarget): Target closed"). A second PROCESS
 *    is the only isolation that works there.
 *
 * Real users are separate browser profiles, so one process per account is also
 * the faithful model. tests/groups/group-e2e-browser.test.mjs uses the same
 * approach and keeps its browsers in an array for its `after` hook.
 *
 * Keep using browser.newPage() where a test deliberately needs two pages of the
 * SAME account sharing storage - a cross-tab Web Lock, a second tab that must
 * see the first tab's sender keys, or a second tab that receives the account's
 * own KDM.
 */
const userBrowsers = new Set();

/** Closes every browser newUserPage() launched. Safe to call twice. */
export async function closeUserBrowsers() {
    const open = [...userBrowsers];
    userBrowsers.clear();
    await Promise.all(open.map((b) => b.close().catch(() => {})));
}

export async function newUserPage({ viewport = { width: 1280, height: 900 }, timeout = 30000, onNewDocument } = {}) {
    const launched = await launchBrowser();
    if (!launched.browser) throw new Error(`newUserPage: no Chromium (${launched.reason})`);
    userBrowsers.add(launched.browser);
    const page = await launched.browser.newPage();
    page.setDefaultTimeout(timeout);
    if (viewport) await page.setViewport(viewport);
    if (onNewDocument) await page.evaluateOnNewDocument(onNewDocument);
    return { page, browser: launched.browser };
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
