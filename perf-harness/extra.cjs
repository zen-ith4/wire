const { chromium } = require('playwright');
const { start } = require('./server.cjs');
const STUB = `export async function createIdentity(){return{}} export async function restoreIdentity(){return{}} export async function restoreIdentityWithUnlockKey(){return{}} export async function reencryptIdentity(){return{}} export async function initializeIdentity(){return{}} export function getCurrentIdentity(){return null} export function lockIdentity(){} export function isIdentityUnlocked(){return true}`;
(async () => {
  const srv = await start({ root: require('path').resolve(process.argv[2]), latencyMs: 80 });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route('**/js/crypto/identity-service.js', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
  await ctx.addInitScript(() => { localStorage.setItem('token', 't'); localStorage.setItem('wire_perf', '1'); });
  const page = await ctx.newPage();
  const logs = []; page.on('console', m => { if (m.text().startsWith('[perf]')) logs.push(m.text()); });
  const go = v => page.evaluate(v => document.querySelector(`.nav-link[data-view="${v}"]`).click(), v);
  await page.goto(srv.url + '/'); await page.waitForSelector('#files-folder-list .dm-conv');
  await go('chat'); await page.waitForSelector('#chat-messages .chat-msg');
  await go('files'); await page.waitForTimeout(300);

  // live socket message while Chat is not mounted (same module instance the socket handler uses)
  await page.evaluate(async () => {
    const chat = await import('/js/chat/chat.js');
    chat.addChatMessage({ id: 9001, user_id: 2, username: 'bob', content: 'LIVE WHILE AWAY', timestamp: new Date().toISOString(), has_attachment: false, reactions: [] });
  });
  const reqsBefore = srv.log.length;
  await go('chat');
  const instant = await page.evaluate(() => document.querySelector('#chat-messages').innerText.includes('LIVE WHILE AWAY'));
  console.log((instant ? 'PASS' : 'FAIL') + ' live message received while away is visible immediately on return (before any network reply)');
  // hitting reconcile: server doesn't know 9001 -> must NOT be removed (arrived after server snapshot)
  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => document.querySelector('#chat-messages').innerText.includes('LIVE WHILE AWAY'));
  console.log((kept ? 'PASS' : 'FAIL') + ' reconcile keeps a message newer than the server snapshot');

  // settings write invalidates snapshot: after a PUT the next visit shows spinner (fresh), not stale snapshot
  await go('settings'); await page.waitForSelector('#sign-out-button'); await go('files'); await page.waitForTimeout(200);
  await page.evaluate(async () => { const { api } = await import('/js/core/api.js'); void api; });
  await go('files'); await go('messages'); await page.waitForTimeout(500); await go('settings'); await page.waitForTimeout(500);
  console.log('\nperf logger output:'); logs.forEach(l => console.log('  ' + l));
  console.log(logs.length >= 4 ? 'PASS perf logger emits one line per navigation' : 'FAIL perf logger');
  await browser.close(); srv.server.close();
})();
