// Test that the REAL identity.js and identity-service.js can be imported without mocks
// This verifies the duplicate export fix (Step 1)
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal globals for crypto (Node 22 has crypto.subtle)
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

// Mock localStorage for identity-service.js which imports auth.js
const ls = new Map();
globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
    clear: () => { ls.clear(); },
};

test('REAL identity.js imports without duplicate export error', async () => {
    // This will throw SyntaxError if duplicate export exists
    const identity = await import('../public/js/crypto/identity.js');
    
    // Verify key exports exist
    assert.ok(typeof identity.importPrivateKey === 'function', 'importPrivateKey should be exported');
    assert.ok(typeof identity.generateIdentityKeyPair === 'function', 'generateIdentityKeyPair should be exported');
    assert.ok(typeof identity.exportPublicKey === 'function', 'exportPublicKey should be exported');
    assert.ok(typeof identity.exportPrivateKey === 'function', 'exportPrivateKey should be exported');
    assert.ok(typeof identity.encryptIdentityPrivateKey === 'function', 'encryptIdentityPrivateKey should be exported');
    assert.ok(typeof identity.decryptIdentityPrivateKey === 'function', 'decryptIdentityPrivateKey should be exported');
    assert.ok(typeof identity.createEncryptedIdentity === 'function', 'createEncryptedIdentity should be exported');
    assert.ok(typeof identity.arrayBufferToBase64 === 'function', 'arrayBufferToBase64 should be exported');
    assert.ok(typeof identity.base64ToArrayBuffer === 'function', 'base64ToArrayBuffer should be exported');
});

test('REAL identity-service.js imports without error', async () => {
    // This imports identity.js internally, so it would fail if identity.js has duplicate export
    const identityService = await import('../public/js/crypto/identity-service.js');
    
    assert.ok(typeof identityService.createIdentity === 'function', 'createIdentity should be exported');
    assert.ok(typeof identityService.restoreIdentity === 'function', 'restoreIdentity should be exported');
    assert.ok(typeof identityService.restoreIdentityWithUnlockKey === 'function', 'restoreIdentityWithUnlockKey should be exported');
    assert.ok(typeof identityService.migrateLegacyAccount === 'function', 'migrateLegacyAccount should be exported');
    assert.ok(typeof identityService.prepareCredentialChange === 'function', 'prepareCredentialChange should be exported');
    assert.ok(typeof identityService.initializeIdentity === 'function', 'initializeIdentity should be exported');
    assert.ok(typeof identityService.getCurrentIdentity === 'function', 'getCurrentIdentity should be exported');
    assert.ok(typeof identityService.lockIdentity === 'function', 'lockIdentity should be exported');
    assert.ok(typeof identityService.isIdentityUnlocked === 'function', 'isIdentityUnlocked should be exported');
});