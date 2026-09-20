const { chromium } = require('playwright');
const { start } = require('./server.cjs');
const IDENTITY_STUB = `export async function createIdentity(){return{}} export async function restoreIdentity(){return{}} export async function restoreIdentityWithUnlockKey(){return{}} export async function reencryptIdentity(){return{}} export async function initializeIdentity(){return{}} export function getCurrentIdentity(){return null} export function lockIdentity(){} export function isIdentityUnlocked(){return true}`;
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + m); };

(async () => {
  const srv = await start({ root: require('path').resolve(process.argv[2]), latencyMs: 60 });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await ctx.route('**/js/crypto/identity-service.js', r => r.fulfill({ contentType: 'text/javascript', body: IDENTITY_STUB }));
  await ctx.addInitScript(() => localStorage.setItem('token', 't'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const go = async (view) => { await page.evaluate(v => document.querySelector(`.nav-link[data-view="${v}"]`).click(), view); };
  const spinner = () => page.evaluate(() => !!document.querySelector('#content-area .loading-state'));
  const settle = () => page.waitForTimeout(400);
  const D = srv.data;

  await page.goto(srv.url + '/');
  await page.waitForSelector('#files-folder-list .dm-conv');

  // ---- CHAT ----
  await go('chat'); await page.waitForSelector('#chat-messages .chat-msg');
  ok((await page.locator('#chat-messages .chat-msg').count()) === 50, 'chat: first visit renders 50 messages');
  await go('files'); await settle();
  // server-side changes while away: 1 new message, 1 deleted, 1 reaction change
  D.chat.push({ id: 2000, user_id: 2, username: 'bob', content: 'NEW WHILE AWAY', timestamp: new Date().toISOString(), has_attachment: false, reactions: [] });
  const deleted = D.chat.splice(10, 1)[0];
  D.chat[20].reactions = [{ emoji: '👍', count: 1, user_ids: [2], usernames: ['bob'] }];
  await go('chat');
  ok(!(await spinner()), 'chat: return shows no spinner');
  ok((await page.locator('#chat-messages .chat-msg').count()) === 50, 'chat: instant paint from cache shows cached 50 (stale data first)');
  await page.evaluate(() => { document.querySelector('#chat-messages .chat-msg').dataset.survivor = '1'; });
  await settle();
  ok(await page.locator('#chat-messages', { hasText: 'NEW WHILE AWAY' }).count() === 1, 'chat: message that arrived while away appears after reconcile');
  ok(await page.locator(`#chat-messages .chat-msg[data-msg-id="${deleted.id}"]`).count() === 0, 'chat: message deleted while away is removed');
  ok(await page.locator(`#chat-messages .chat-msg[data-msg-id="${D.chat[20].id}"] .reaction-pill`).count() === 1, 'chat: reaction change applied in place');
  ok(await page.evaluate(() => !!document.querySelector('#chat-messages .chat-msg[data-survivor="1"]')), 'chat: reconcile did not rebuild the list (no flicker)');

  // ---- FILES ----
  await go('files'); await settle(); await go('chat'); await settle();
  D.entries.push({ name: 'brand-new.txt', type: 'file', size: 5, modified: new Date().toISOString() });
  await go('files');
  ok(!(await spinner()), 'files: return shows no spinner');
  await settle();
  ok(await page.locator('.file-table', { hasText: 'brand-new.txt' }).count() === 1, 'files: change made server-side appears after background refresh');

  // ---- FILES: remembered folder deleted server-side (speculative request must fall back cleanly) ----
  await page.evaluate(() => window.changeFolder(3)); await settle();
  ok(await page.locator('#files-folder-list .dm-conv.active').getAttribute('data-folder') === '3', 'files: switched to folder 3');
  await go('chat'); await settle();
  D.folders.splice(2, 1);                       // folder 3 disappears
  const before = srv.log.length;
  await go('files'); await settle(); await settle();
  ok(await page.locator('#files-folder-list .dm-conv').count() === 2, 'files: deleted folder removed from list');
  ok(await page.locator('#files-folder-list .dm-conv.active').getAttribute('data-folder') === '1', 'files: falls back to first folder');
  ok(!(await page.evaluate(() => document.body.innerText.includes('unexpected error'))), 'files: no "unexpected error" toast from the discarded speculative request');

  // ---- SETTINGS ----
  await go('settings'); await page.waitForSelector('#sign-out-button');
  await go('files'); await settle();
  D.me.bio = 'changed elsewhere';
  await go('settings');
  ok(!(await spinner()), 'settings: return shows no spinner');
  await settle();
  const bio = await page.evaluate(() => (document.querySelector('#content-area textarea') || {}).value);
  ok(bio === 'changed elsewhere', 'settings: profile change made elsewhere shows after refresh (bio=' + bio + ')');

  // ---- MESSAGES ----
  await go('messages'); await page.waitForSelector('#dm-conv-list .dm-conv[data-peer]');
  await go('files'); await settle();
  D.convs[0].last_message = 'brand new preview'; D.convs[0].unread_count = 2;
  await go('messages');
  ok(!(await spinner()), 'messages: return shows no spinner');
  ok(await page.locator('#dm-conv-list .dm-conv').count() === 3, 'messages: conversation list painted instantly from cache');
  await settle();
  ok(await page.locator('#dm-conv-list', { hasText: 'brand new preview' }).count() === 1, 'messages: preview refreshed in background');
  ok(await page.locator('#dm-conv-list .dm-unread-badge').count() === 1, 'messages: unread badge refreshed');
  await page.locator('#dm-conv-list .dm-conv').first().click();
  await page.waitForSelector('#dm-messages .chat-msg');
  ok((await page.locator('#dm-messages .chat-msg').count()) === 20, 'messages: opening a conversation still works');

  // ---- LOGOUT clears caches ----
  await go('files'); await settle();
  await page.evaluate(() => window.dispatchEvent(new Event('wire:logout')));
  await go('chat');
  ok(await spinner(), 'logout: chat cache dropped (next visit shows loading state, not old messages)');
  ok(await page.locator('#chat-messages .chat-msg').count() === 0, 'logout: no cached messages painted');
  await settle();
  await go('messages');
  ok(await spinner(), 'logout: DM list cache dropped');
  await settle();

  ok(errors.length === 0, 'no uncaught page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); srv.server.close();
  process.exit(fail ? 1 : 0);
})();
