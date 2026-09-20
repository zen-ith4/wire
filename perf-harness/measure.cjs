// Measures tab-switch behaviour of a Wire public/ tree against the stub backend.
// usage: node measure.cjs <publicDir> <latencyMs> <cpuRate> [label]
const { chromium } = require('playwright');
const { start } = require('./server.cjs');

const IDENTITY_STUB = `
export async function createIdentity(){ return {}; }
export async function restoreIdentity(){ return {}; }
export async function restoreIdentityWithUnlockKey(){ return {}; }
export async function reencryptIdentity(){ return {}; }
export async function initializeIdentity(){ return {}; }
export function getCurrentIdentity(){ return null; }
export function lockIdentity(){}
export function isIdentityUnlocked(){ return true; }
`;

const MARKERS = {
  files:    '#files-folder-list .dm-conv',
  chat:     '#chat-messages .chat-msg',
  messages: '#dm-conv-list .dm-conv[data-peer]',
  settings: '#sign-out-button',
};

const INIT = `
(() => {
  window.__reqs = [];
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const r = { url: url.replace(location.origin, ''), start: performance.now(), end: null, method: (init && init.method) || 'GET' };
    window.__reqs.push(r);
    return of.apply(this, arguments).finally(() => { r.end = performance.now(); });
  };
  const oo = XMLHttpRequest.prototype.open;
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('wire_animations', 'off');
})();
`;

async function run(publicDir, latencyMs, cpuRate, label) {
  const srv = await start({ root: require('path').resolve(publicDir), latencyMs: 0 });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await ctx.route('**/js/crypto/identity-service.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: IDENTITY_STUB }));
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  const cdp = await ctx.newCDPSession(page);
  if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });

  // boot with zero latency so we only measure navigations
  await page.goto(srv.url + '/');
  await page.waitForSelector(MARKERS.files, { timeout: 15000 });
  srv.latencyMs = latencyMs;                       // apply simulated RTT+server time from here on

  const seq = ['chat', 'messages', 'settings', 'files', 'chat', 'messages', 'settings', 'files'];
  const seen = new Set(['files']);
  const rows = [];
  for (const view of seq) {
    await page.waitForTimeout(150);
    const r = await page.evaluate(([view, marker]) => new Promise(resolve => {
      const content = document.getElementById('content-area');
      const t0 = performance.now();
      const reqStart = window.__reqs.length;
      let spinnerAt = null, spinnerGone = null;
      const check = () => {
        const sp = !!content.querySelector('.loading-state');
        if (sp && spinnerAt === null) spinnerAt = performance.now();
        if (!sp && spinnerAt !== null && spinnerGone === null) spinnerGone = performance.now();
      };
      const mo = new MutationObserver(check);
      mo.observe(content, { childList: true, subtree: true });
      document.querySelector('.nav-link[data-view="' + view + '"]').click();
      check();
      const tick = () => {
        check();
        const ready = !content.querySelector('.loading-state') && !!content.querySelector(marker);
        if (ready) {
          // wait 2 frames so we measure a painted state
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const tReady = performance.now();
            mo.disconnect();
            const reqs = window.__reqs.slice(reqStart).map(q => ({ url: q.url, start: q.start - t0, end: q.end === null ? null : q.end - t0 }));
            resolve({ view, ms: tReady - t0, spinner: spinnerAt !== null, spinnerMs: spinnerAt !== null ? (spinnerGone ?? tReady) - spinnerAt : 0, reqs });
          }));
        } else if (performance.now() - t0 > 20000) { mo.disconnect(); resolve({ view, ms: -1, spinner: spinnerAt !== null, reqs: [] }); }
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), [view, MARKERS[view]]);
    r.visit = seen.has(view) ? 'warm' : 'first';
    seen.add(view);
    rows.push(r);
  }
  await page.waitForTimeout(latencyMs * 3 + 300);
  await browser.close(); srv.server.close();
  return rows;
}

(async () => {
  const [dir, lat, cpu, label] = process.argv.slice(2);
  const rows = await run(dir, Number(lat), Number(cpu), label);
  const fmt = n => n.toFixed(0).padStart(5);
  console.log(`\n== ${label || dir}  latency=${lat}ms/request  cpu=${cpu}x ==`);
  console.log('tab        visit   time-to-content  spinner(ms)  api-calls  (blocking / background)');
  for (const r of rows) {
    const total = r.reqs.filter(q => q.url.startsWith('/api/') || q.url.includes('/api/'));
    const blocking = total.filter(q => q.end !== null && q.end <= r.ms + 1).length;
    console.log(`${r.view.padEnd(10)} ${r.visit.padEnd(6)} ${fmt(r.ms)} ms        ${r.spinner ? fmt(r.spinnerMs) : '    -'}      ${String(total.length).padStart(2)}         (${blocking} / ${total.length - blocking})`);
  }
  require('fs').writeFileSync(`' + __dirname + '/result-${(label||'x').replace(/\W+/g,'_')}-${lat}-${cpu}.json`, JSON.stringify(rows, null, 1));
})();
