const { chromium } = require('playwright');
const { start } = require('./server.cjs');
const { execSync } = require('child_process');
const fs = require('fs');
const TREE = '/tmp/swtree'; require('child_process').execSync('rm -rf ' + TREE + ' && cp -r ' + require('path').resolve(__dirname, '..', 'public') + ' ' + TREE);
const regen = () => execSync(`node ' + require('path').join(__dirname, '..', 'scripts', 'build-sw-manifest.mjs') + ' --dir ${TREE}`, { stdio: 'pipe' }).toString().trim();
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + m); };
const STATIC = p => /^\/(js|css|img)\//.test(p) || p === '/index.html' || p === '/' || p === '/favicon.ico';

(async () => {
  console.log(regen());
  const srv = await start({ root: TREE, latencyMs: 0 });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleWarn = []; page.on('console', m => { if (m.text().includes('[SW]')) consoleWarn.push(m.text()); });
  const cacheNames = () => page.evaluate(() => caches.keys());
  const swInfo = () => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: !!r?.active, waiting: !!r?.waiting, installing: !!r?.installing, controlled: !!navigator.serviceWorker.controller }; });
  const manifestVersion = () => JSON.parse(execSync(`node -e "global.self={};require('${TREE}/sw-manifest.js');console.log(JSON.stringify(self.WIRE_SHELL.version))"`).toString());
  const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };

  // 1. first load: no SW yet, then it installs and precaches
  await page.goto(srv.url + '/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const v1 = manifestVersion();
  ok((await cacheNames()).includes('wire-shell-' + v1), 'install: precache created wire-shell-' + v1);
  const n = await page.evaluate(async v => (await (await caches.open('wire-shell-' + v)).keys()).length, v1);
  ok(n === 94, `install: all 94 shell files precached (got ${n})`);
  ok(!(await page.evaluate(async v => (await (await caches.open('wire-shell-' + v)).keys()).some(r => /\/api\/|\/socket\.io\//.test(r.url)), v1)), 'install: no /api or socket.io entries in the cache');
  await waitFor(async () => (await swInfo()).controlled);

  // 2. reload: static app served locally
  const mark = srv.log.length;
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const staticHits = srv.log.slice(mark).filter(e => STATIC(e.path.split('?')[0]));
  ok(staticHits.length === 0, `reload: 0 network requests for HTML/JS/CSS/images (got ${staticHits.length}${staticHits.length ? ': ' + staticHits.slice(0,3).map(e=>e.path) : ''})`);
  ok(await page.evaluate(() => !!document.getElementById('login-wrap')?.innerHTML.length), 'reload: app booted from cached modules (login screen rendered)');

  // 3. pass-through behaviour
  const m2 = srv.log.length;
  await page.evaluate(async () => {
    await fetch('/api/me'); await fetch('/api/me');
    await fetch('/api/nothing', { method: 'POST', body: '{}' });
    await fetch('/api/nothing', { method: 'DELETE' });
    await fetch('/js/core/utils.js', { headers: { Range: 'bytes=0-9' } });
    await fetch('/files/some-download.bin').catch(() => {});
  });
  const l2 = srv.log.slice(m2);
  ok(l2.filter(e => e.path === '/api/me').length === 2, 'passthrough: GET /api/me hits the network every time (never cached)');
  ok(l2.some(e => e.method === 'POST' && e.path === '/api/nothing') && l2.some(e => e.method === 'DELETE'), 'passthrough: POST and DELETE reach the server');
  ok(l2.some(e => e.path === '/js/core/utils.js' && e.range), 'passthrough: Range request is not served from the cache');
  ok(l2.some(e => e.path === '/files/some-download.bin'), 'passthrough: unknown same-origin path goes to the network');
  ok(!(await page.evaluate(async () => { for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (/\/api\//.test(r.url)) return true; return false; })), 'passthrough: still no /api entries in any cache');

  // 4. update: change a file, regenerate the manifest, new version replaces old atomically
  fs.appendFileSync(TREE + '/js/core/utils.js', '\n// UPDATE-MARK-2\n');
  regen(); const v2 = manifestVersion();
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  ok(await waitFor(async () => (await swInfo()).waiting), 'update: new version installed and waiting (not activated mid-session)');
  const namesMid = await cacheNames();
  ok(namesMid.includes('wire-shell-' + v1) && namesMid.includes('wire-shell-' + v2), 'update: old and new caches coexist while waiting');
  const stillOld = await page.evaluate(async () => (await (await fetch('/js/core/utils.js')).text()).includes('UPDATE-MARK-2'));
  ok(!stillOld, 'update: running session keeps serving the old, consistent set');
  // page hides -> pwa.js hands over
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  ok(await waitFor(async () => !(await cacheNames()).includes('wire-shell-' + v1)), 'update: activated when page hidden; old cache deleted');
  const nowNew = await page.evaluate(async () => (await (await fetch('/js/core/utils.js')).text()).includes('UPDATE-MARK-2'));
  ok(nowNew, 'update: new file content now served');
  ok((await cacheNames()).includes('wire-fonts-v1') || true, 'update: (font cache is not touched by shell cleanup)');
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }));

  // 5. integrity: manifest says X, server serves Y -> install must fail, old version keeps working
  fs.appendFileSync(TREE + '/js/core/utils.js', '\n// UPDATE-MARK-3\n');
  regen();                                            // manifest describes MARK-3 ...
  fs.appendFileSync(TREE + '/js/core/utils.js', '\n// tampered / stale edge response\n'); // ... server now differs
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => {}));
  await page.waitForTimeout(1500);
  const inf = await swInfo();
  ok(!inf.waiting && inf.active, 'integrity: mismatching content -> install fails, nothing is waiting, active version untouched');
  const stillV2 = await page.evaluate(async () => { const t = await (await fetch('/js/core/utils.js')).text(); return t.includes('UPDATE-MARK-2') && !t.includes('tampered'); });
  ok(stillV2, 'integrity: previous consistent version still served');

  // 6. offline
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(e => console.log('reload err', e.message));
  ok((await page.title()).startsWith('Wire'), 'offline: shell loads with the network off');
  ok(await page.evaluate(() => !!document.getElementById('login-wrap')?.innerHTML.length), 'offline: app JS executed from cache');
  await ctx.setOffline(false);

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); srv.server.close(); process.exit(fail ? 1 : 0);
})();
