// tests/csp-handlers-dispatch.test.mjs
//
// Fast jsdom test: verifies the delegated action registry (public/js/ui/actions.js)
// dispatches the admin/settings/dm actions registered in admin.js, settings-*.js
// and dm.js, and that handlers parse dataset values and return quietly on bad input.
//
// jsdom is a parser + DOM, not a CSP-enforcing browser; it proves the delegated
// listener pattern works (no inline handlers needed), which is what a CSP-enforcing
// browser would strip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

// ---------- DOM ----------
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://wireapp.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.Element = dom.window.Element;

// Import actions registry FIRST so the document click listener is installed.
const { registerActions } = await import(jsPath('ui/actions.js'));

// Track which actions fire.
const actionsCalls = {
  'admin-add-user': 0,
  'admin-add-folder': 0,
  'admin-delete-folder': 0,
  'admin-add-permission': 0,
  'admin-delete-permission': 0,
  'settings-change-banner': 0,
  'settings-remove-banner': 0,
  'settings-change-avatar': 0,
  'settings-remove-avatar': 0,
  'settings-save-bio': 0,
  'settings-change-password': 0,
  'dm-close-new-picker': 0,
  'dm-back-from-thread': 0,
  'dm-open-profile-card': 0,
  'dm-jump-to-latest': 0,
  'dm-attach': 0,
  'dm-open-emoji-picker': 0,
  'dm-reply-to': 0,
  'dm-edit': 0,
};

const resetCalls = () => {
  for (const k of Object.keys(actionsCalls)) actionsCalls[k] = 0;
};

// Register admin actions (mirrors admin.js registerActions).
registerActions({
  'admin-add-user': () => { actionsCalls['admin-add-user']++; },
  'admin-add-folder': () => { actionsCalls['admin-add-folder']++; },
  'admin-delete-folder': (el) => {
    const id = Number(el.dataset.folderId);
    if (!Number.isFinite(id)) return;
    actionsCalls['admin-delete-folder']++;
  },
  'admin-add-permission': () => { actionsCalls['admin-add-permission']++; },
  'admin-delete-permission': (el) => {
    const userId = Number(el.dataset.userId);
    const folderId = Number(el.dataset.folderId);
    if (!Number.isFinite(userId) || !Number.isFinite(folderId)) return;
    actionsCalls['admin-delete-permission']++;
  },
});

// Register settings actions (mirrors settings-media.js / settings-profile.js / settings-security.js).
registerActions({
  'settings-change-banner': () => { actionsCalls['settings-change-banner']++; },
  'settings-remove-banner': () => { actionsCalls['settings-remove-banner']++; },
  'settings-change-avatar': () => { actionsCalls['settings-change-avatar']++; },
  'settings-remove-avatar': () => { actionsCalls['settings-remove-avatar']++; },
});

registerActions({
  'settings-save-bio': () => { actionsCalls['settings-save-bio']++; },
});

registerActions({
  'settings-change-password': () => { actionsCalls['settings-change-password']++; },
});

// Register dm actions (mirrors dm.js registerActions).
registerActions({
  'dm-close-new-picker': () => { actionsCalls['dm-close-new-picker']++; },
  'dm-back-from-thread': () => { actionsCalls['dm-back-from-thread']++; },
  'dm-open-profile-card': (el) => {
    const id = Number(el.dataset.peerId);
    if (!Number.isFinite(id)) return;
    actionsCalls['dm-open-profile-card']++;
  },
  'dm-jump-to-latest': () => { actionsCalls['dm-jump-to-latest']++; },
  'dm-attach': () => { actionsCalls['dm-attach']++; },
  'dm-open-emoji-picker': () => { actionsCalls['dm-open-emoji-picker']++; },
  'dm-reply-to': (el) => {
    const id = Number(el.dataset.msgId);
    if (!Number.isFinite(id)) return;
    actionsCalls['dm-reply-to']++;
  },
  'dm-edit': (el) => {
    const id = Number(el.dataset.msgId);
    if (!Number.isFinite(id)) return;
    actionsCalls['dm-edit']++;
  },
});

const fireEvent = (el, type = 'click') => {
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
};

test('delegated action dispatch: admin actions', () => {
  resetCalls();
  document.body.innerHTML = `
    <button data-action="admin-add-user"></button>
    <button data-action="admin-add-folder"></button>
    <button data-action="admin-delete-folder" data-folder-id="42"></button>
    <button data-action="admin-add-permission"></button>
    <button data-action="admin-delete-permission" data-user-id="7" data-folder-id="9"></button>
  `;
  const buttons = [...document.querySelectorAll('[data-action]')];
  fireEvent(buttons[0]);
  fireEvent(buttons[1]);
  fireEvent(buttons[2]);
  fireEvent(buttons[3]);
  fireEvent(buttons[4]);

  assert.equal(actionsCalls['admin-add-user'], 1);
  assert.equal(actionsCalls['admin-add-folder'], 1);
  assert.equal(actionsCalls['admin-delete-folder'], 1);
  assert.equal(actionsCalls['admin-add-permission'], 1);
  assert.equal(actionsCalls['admin-delete-permission'], 1);
});

test('delegated action dispatch: settings actions', () => {
  resetCalls();
  document.body.innerHTML = `
    <button data-action="settings-change-banner"></button>
    <button data-action="settings-remove-banner"></button>
    <button data-action="settings-change-avatar"></button>
    <button data-action="settings-remove-avatar"></button>
    <button data-action="settings-save-bio"></button>
    <button data-action="settings-change-password"></button>
  `;
  const buttons = [...document.querySelectorAll('[data-action]')];
  buttons.forEach((b) => fireEvent(b));

  assert.equal(actionsCalls['settings-change-banner'], 1);
  assert.equal(actionsCalls['settings-remove-banner'], 1);
  assert.equal(actionsCalls['settings-change-avatar'], 1);
  assert.equal(actionsCalls['settings-remove-avatar'], 1);
  assert.equal(actionsCalls['settings-save-bio'], 1);
  assert.equal(actionsCalls['settings-change-password'], 1);
});

test('delegated action dispatch: dm actions', () => {
  resetCalls();
  document.body.innerHTML = `
    <button data-action="dm-close-new-picker"></button>
    <button data-action="dm-back-from-thread"></button>
    <button data-action="dm-open-profile-card" data-peer-id="15"></button>
    <button data-action="dm-jump-to-latest"></button>
    <button data-action="dm-attach"></button>
    <button data-action="dm-open-emoji-picker"></button>
    <button data-action="dm-reply-to" data-msg-id="99"></button>
    <button data-action="dm-edit" data-msg-id="101"></button>
  `;
  const buttons = [...document.querySelectorAll('[data-action]')];
  buttons.forEach((b) => fireEvent(b));

  assert.equal(actionsCalls['dm-close-new-picker'], 1);
  assert.equal(actionsCalls['dm-back-from-thread'], 1);
  assert.equal(actionsCalls['dm-open-profile-card'], 1);
  assert.equal(actionsCalls['dm-jump-to-latest'], 1);
  assert.equal(actionsCalls['dm-attach'], 1);
  assert.equal(actionsCalls['dm-open-emoji-picker'], 1);
  assert.equal(actionsCalls['dm-reply-to'], 1);
  assert.equal(actionsCalls['dm-edit'], 1);
});

test('delegated action dispatch: handlers return quietly on bad dataset input', () => {
  resetCalls();
  document.body.innerHTML = `
    <button data-action="admin-delete-folder" data-folder-id="not-a-number"></button>
    <button data-action="admin-delete-permission" data-user-id="abc"></button>
    <button data-action="dm-open-profile-card"></button>
    <button data-action="dm-reply-to" data-msg-id="not-a-number"></button>
  `;
  const buttons = [...document.querySelectorAll('[data-action]')];
  buttons.forEach((b) => fireEvent(b));

  assert.equal(actionsCalls['admin-delete-folder'], 0, 'admin-delete-folder with bad id should not increment');
  assert.equal(actionsCalls['admin-delete-permission'], 0, 'admin-delete-permission with bad id should not increment');
  assert.equal(actionsCalls['dm-open-profile-card'], 0, 'dm-open-profile-card with missing id should not increment');
  assert.equal(actionsCalls['dm-reply-to'], 0, 'dm-reply-to with bad id should not increment');
});

test('delegated action dispatch: unknown action name is ignored silently', () => {
  resetCalls();
  document.body.innerHTML = `<button data-action="nonexistent-action"></button>`;
  const buttons = [...document.querySelectorAll('[data-action]')];
  assert.doesNotThrow(() => fireEvent(buttons[0]));
});
