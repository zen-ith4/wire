// Unit tests for electron-client/security-policy.js
//
// Pure decision logic — no Electron import, runs in plain Node.
// Covers accepted and rejected cases for every security rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalScheme,
  originKey,
  isAllowedAddress,
  normalizeServerAddress,
  buildRequestOptions,
  onRedirect,
  connectScreenPathname,
  isConnectScreenUrl,
  senderIsTrusted,
  isPermissionAllowed,
} from '../security-policy.js';

const { pathToFileURL } = await import('node:url');
const CONNECT_PATH = '/home/operator/wire/electron-client/renderer/connect.html';
const CONNECT_PATHNAME = pathToFileURL(CONNECT_PATH).pathname;

// A WebFrameMain has `url` (and no `.protocol`); WebContents has `mainFrame`.
// Keep the fake to exactly those properties so the tests cannot pass on a
// shape real Electron never provides.
function senderEvent(frameUrl, isMainFrame = true) {
  const frame = frameUrl ? { url: frameUrl } : null;
  return {
    senderFrame: frame,
    sender: { mainFrame: isMainFrame ? frame : { url: 'about:blank' } },
  };
}

// ---------------------------------------------------------------------------
// isAllowedExternalScheme
// ---------------------------------------------------------------------------

test('isAllowedExternalScheme allows http: and https:', () => {
  assert.equal(isAllowedExternalScheme('http://example.com'), true);
  assert.equal(isAllowedExternalScheme('https://example.com'), true);
});

test('isAllowedExternalScheme denies file:, smb:, custom schemes', () => {
  assert.equal(isAllowedExternalScheme('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalScheme('smb://server/share'), false);
  assert.equal(isAllowedExternalScheme('ms-appx:///x'), false);
  assert.equal(isAllowedExternalScheme('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalScheme('data:text/html,<x>'), false);
  assert.equal(isAllowedExternalScheme('blob:https://example.com/x'), false);
  assert.equal(isAllowedExternalScheme('custom://app'), false);
  assert.equal(isAllowedExternalScheme('not-a-url'), false);
});

// ---------------------------------------------------------------------------
// originKey
// ---------------------------------------------------------------------------

test('originKey returns protocol + // + host, not URL.origin', () => {
  // URL.origin is 'null' for wire-bundled:// — originKey must not use it.
  assert.equal(originKey('wire-bundled://app/index.html'), 'wire-bundled://app');
  assert.equal(originKey('https://example.com:8443/path'), 'https://example.com:8443');
  assert.equal(originKey('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(originKey('file:///home/user/x.html'), 'file://');
  assert.equal(new URL('wire-bundled://app/index.html').origin, 'null');
});

// ---------------------------------------------------------------------------
// isAllowedAddress
// ---------------------------------------------------------------------------

test('isAllowedAddress packaged: https only, no http', () => {
  assert.equal(isAllowedAddress(new URL('https://example.com'), true), true);
  assert.equal(isAllowedAddress(new URL('http://localhost'), true), false);
  assert.equal(isAllowedAddress(new URL('http://127.0.0.1'), true), false);
  assert.equal(isAllowedAddress(new URL('http://[::1]'), true), false);
  assert.equal(isAllowedAddress(new URL('ftp://example.com'), true), false);
});

test('isAllowedAddress unpackaged: http only on loopback, https always', () => {
  assert.equal(isAllowedAddress(new URL('http://localhost'), false), true);
  assert.equal(isAllowedAddress(new URL('http://127.0.0.1'), false), true);
  assert.equal(isAllowedAddress(new URL('http://[::1]'), false), true);
  assert.equal(isAllowedAddress(new URL('http://192.168.1.100'), false), false);
  assert.equal(isAllowedAddress(new URL('http://example.com'), false), false);
  assert.equal(isAllowedAddress(new URL('https://example.com'), false), true);
});

// ---------------------------------------------------------------------------
// normalizeServerAddress
// ---------------------------------------------------------------------------

test('normalizeServerAddress packaged: accepts https, rejects http', () => {
  assert.equal(normalizeServerAddress('https://example.com', true), 'https://example.com');
  assert.equal(normalizeServerAddress('https://192.168.1.100:3000', true), 'https://192.168.1.100:3000');
  assert.throws(() => normalizeServerAddress('http://localhost', true), /Packaged builds/);
  assert.throws(() => normalizeServerAddress('http://127.0.0.1', true), /Packaged builds/);
});

test('normalizeServerAddress unpackaged: http only on loopback', () => {
  assert.equal(normalizeServerAddress('http://localhost', false), 'http://localhost');
  assert.equal(normalizeServerAddress('http://127.0.0.1:3000', false), 'http://127.0.0.1:3000');
  assert.equal(normalizeServerAddress('http://[::1]', false), 'http://[::1]');
  assert.equal(normalizeServerAddress('https://example.com', false), 'https://example.com');
  assert.throws(() => normalizeServerAddress('http://192.168.1.100', false), /unpackaged/);
});

test('normalizeServerAddress rejects invalid input', () => {
  assert.throws(() => normalizeServerAddress('', true), /Please enter/);
  assert.throws(() => normalizeServerAddress(null, true), /Please enter/);
  assert.throws(() => normalizeServerAddress('ftp://example.com', true), /Packaged builds/);
  // No host / spaces cause URL parse failure
  assert.throws(() => normalizeServerAddress('http://', true), /doesn't look/);
  assert.throws(() => normalizeServerAddress('http://ex ample.com', true), /doesn't look/);
});

// ---------------------------------------------------------------------------
// buildRequestOptions
// ---------------------------------------------------------------------------

test('buildRequestOptions sets redirect: manual', () => {
  const opts = buildRequestOptions('https://example.com', '/api/version');
  assert.equal(opts.redirect, 'manual');
  assert.equal(opts.method, 'GET');
  assert.equal(opts.url, 'https://example.com/api/version');
});

// ---------------------------------------------------------------------------
// onRedirect
// ---------------------------------------------------------------------------

test('onRedirect follows same-origin https redirect', () => {
  const decision = onRedirect('https://example.com/api/version', 'https://example.com', true);
  assert.equal(decision.follow, true);
  assert.equal(decision.reason, null);
});

test('onRedirect aborts cross-origin redirect', () => {
  const decision = onRedirect('https://evil.com/', 'https://example.com', true);
  assert.equal(decision.follow, false);
  assert.equal(decision.reason, 'redirects to a different origin');
});

test('onRedirect aborts http redirect in packaged build (different origin)', () => {
  // http://example.com and https://example.com are different origins;
  // the origin check fires first. Both result in abort.
  const decision = onRedirect('http://example.com/', 'https://example.com', true);
  assert.equal(decision.follow, false);
});

test('onRedirect aborts cross-origin redirect in unpackaged build', () => {
  const decision = onRedirect('http://evil.com/', 'http://localhost:3000', false);
  assert.equal(decision.follow, false);
  assert.equal(decision.reason, 'redirects to a different origin');
});

test('onRedirect allows http loopback redirect in unpackaged build', () => {
  const decision = onRedirect('http://localhost:3000/', 'http://localhost:3000', false);
  assert.equal(decision.follow, true);
});

test('onRedirect aborts invalid URL', () => {
  const decision = onRedirect('not-a-url', 'https://example.com', true);
  assert.equal(decision.follow, false);
});

// ---------------------------------------------------------------------------
// connectScreenPathname / isConnectScreenUrl
// ---------------------------------------------------------------------------

test('connectScreenPathname returns the file URL pathname', () => {
  const pn = connectScreenPathname(CONNECT_PATH);
  assert.equal(pn, CONNECT_PATHNAME);
  assert.ok(pn.startsWith('/'));
});

test('isConnectScreenUrl matches exact pathname, ignores query/hash', () => {
  assert.equal(isConnectScreenUrl('file://' + CONNECT_PATH + '?auto=1', CONNECT_PATHNAME), true);
  assert.equal(isConnectScreenUrl('file://' + CONNECT_PATH + '#section', CONNECT_PATHNAME), true);
  assert.equal(isConnectScreenUrl('file://' + CONNECT_PATH, CONNECT_PATHNAME), true);
  // Different file, same origin file:// — must NOT match
  assert.equal(isConnectScreenUrl('file:///etc/passwd', CONNECT_PATHNAME), false);
  assert.equal(isConnectScreenUrl('file:///home/operator/other.html', CONNECT_PATHNAME), false);
  // Spaces in path: pathToFileURL percent-encodes, pathname compare still works
  const spaced = '/home/operator/my app/connect.html';
  const spacedPn = pathToFileURL(spaced).pathname;
  assert.equal(isConnectScreenUrl('file://' + spaced + '?x=1', spacedPn), true);
  // Not file: at all
  assert.equal(isConnectScreenUrl('https://example.com/', CONNECT_PATHNAME), false);
});

// ---------------------------------------------------------------------------
// senderIsTrusted
// ---------------------------------------------------------------------------

test('senderIsTrusted rejects non-top frames (subframes)', () => {
  const event = senderEvent('https://example.com/', false);
  // sender.mainFrame !== sender → not trusted
  assert.equal(senderIsTrusted(event, ['https://example.com'], CONNECT_PATHNAME), false);
});

test('senderIsTrusted accepts server origin main frame', () => {
  const event = senderEvent('https://example.com/', true);
  assert.equal(senderIsTrusted(event, ['https://example.com'], CONNECT_PATHNAME), true);
});

test('senderIsTrusted rejects different origin', () => {
  const event = senderEvent('https://evil.com/', true);
  assert.equal(senderIsTrusted(event, ['https://example.com'], CONNECT_PATHNAME), false);
});

test('senderIsTrusted accepts connect screen by exact file path (spaces OK)', () => {
  const spaced = '/home/operator/my app/connect.html';
  const spacedPn = pathToFileURL(spaced).pathname;
  const event = senderEvent('file://' + spaced, true);
  assert.equal(senderIsTrusted(event, [], spacedPn), true);
  // Other local file must NOT match even though originKey is file:// for both
  const otherEvent = senderEvent('file:///etc/passwd', true);
  assert.equal(senderIsTrusted(otherEvent, [], spacedPn), false);
});

test('senderIsTrusted rejects invalid frame URL', () => {
  const frame = { url: 'not-a-url' };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  assert.equal(senderIsTrusted(event, ['https://example.com'], CONNECT_PATHNAME), false);
});

// ---------------------------------------------------------------------------
// isPermissionAllowed
// ---------------------------------------------------------------------------

test('isPermissionAllowed allows media/audio for server origin', () => {
  assert.equal(isPermissionAllowed('media', { requestingUrl: 'https://example.com/', mediaTypes: ['audio'] }, 'https://example.com'), true);
});

test('isPermissionAllowed denies camera', () => {
  assert.equal(isPermissionAllowed('media', { requestingUrl: 'https://example.com/', mediaTypes: ['video'] }, 'https://example.com'), false);
});

test('isPermissionAllowed denies different origin', () => {
  assert.equal(isPermissionAllowed('media', { requestingUrl: 'https://evil.com/', mediaTypes: ['audio'] }, 'https://example.com'), false);
});

test('isPermissionAllowed denies non-media permissions', () => {
  assert.equal(isPermissionAllowed('notifications', { requestingUrl: 'https://example.com/' }, 'https://example.com'), false);
  assert.equal(isPermissionAllowed('display-capture', { requestingUrl: 'https://example.com/' }, 'https://example.com'), false);
  assert.equal(isPermissionAllowed('geolocation', { requestingUrl: 'https://example.com/' }, 'https://example.com'), false);
});

test('isPermissionAllowed denies missing requestingUrl', () => {
  assert.equal(isPermissionAllowed('media', {}, 'https://example.com'), false);
  assert.equal(isPermissionAllowed('media', null, 'https://example.com'), false);
});

test('isPermissionAllowed allows clipboard-write for server origin main frame', () => {
  assert.equal(
    isPermissionAllowed('clipboard-write', { requestingUrl: 'https://example.com/', isMainFrame: true }, 'https://example.com'),
    true
  );
});

test('isPermissionAllowed allows clipboard-sanitized-write (Chromium 130+/Electron 45 name)', () => {
  assert.equal(
    isPermissionAllowed('clipboard-sanitized-write', { requestingUrl: 'https://example.com/', isMainFrame: true }, 'https://example.com'),
    true
  );
});

test('isPermissionAllowed allows fullscreen for server origin main frame', () => {
  assert.equal(
    isPermissionAllowed('fullscreen', { requestingUrl: 'https://example.com/', isMainFrame: true }, 'https://example.com'),
    true
  );
});

test('isPermissionAllowed denies clipboard/fullscreen from a sub frame', () => {
  assert.equal(
    isPermissionAllowed('clipboard-sanitized-write', { requestingUrl: 'https://example.com/', isMainFrame: false }, 'https://example.com'),
    false
  );
  assert.equal(
    isPermissionAllowed('fullscreen', { requestingUrl: 'https://example.com/', isMainFrame: false }, 'https://example.com'),
    false
  );
  assert.equal(
    isPermissionAllowed('media', { requestingUrl: 'https://example.com/', isMainFrame: false, mediaTypes: ['audio'] }, 'https://example.com'),
    false
  );
});

test('isPermissionAllowed denies media when video is mixed with audio', () => {
  assert.equal(
    isPermissionAllowed('media', { requestingUrl: 'https://example.com/', isMainFrame: true, mediaTypes: ['audio', 'video'] }, 'https://example.com'),
    false
  );
});
