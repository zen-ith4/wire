const { chromium } = require('playwright');
const { start } = require('./server.cjs');
const { execSync } = require('child_process');
const fs = require('fs');
(async () => {
  const lat = Number(process.argv[3] || 100);
  const tree = '/tmp/launchtree'; fs.rmSync(tree, { recursive: true, force: true }); execSync(`cp -r ${process.argv[2]} ${tree}`);
  execSync(`node ' + require('path').join(__dirname, '..', 'scripts', 'build-sw-manifest.mjs') + ' --dir ${tree}`);
  const srv = await start({ root: tree, latencyMs: 0, staticLatencyMs: 0 });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  async function timeReload(useSW) {
    const ctx = await browser.newContext({ serviceWorkers: useSW ? 'allow' : 'block' });
    const page = await ctx.newPage();
    srv.staticLatencyMs = 0;
    await page.goto(srv.url + '/');
    if (useSW) { await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForTimeout(500); }
    else await page.waitForTimeout(500);
    srv.staticLatencyMs = lat;               // from now on every static file costs one simulated round trip
    const mark = srv.log.length;
    const t0 = Date.now();
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => document.getElementById('login-wrap')?.innerHTML.length > 0, null, { timeout: 30000 });
    const ms = Date.now() - t0;
    const reqs = srv.log.slice(mark).filter(e => !e.path.startsWith('/api/')).length;
    await ctx.close();
    return { ms, reqs };
  }
  const a = await timeReload(false), b = await timeReload(true);
  console.log(`static latency ${lat}ms/file`);
  console.log(`  reload without Service Worker: app running after ${a.ms} ms, ${a.reqs} static requests`);
  console.log(`  reload with Service Worker:    app running after ${b.ms} ms, ${b.reqs} static requests`);
  await browser.close(); srv.server.close();
})();
