// tests/dm-blob-url-cleanup.test.mjs
//
// dm.js is the module that ACTUALLY runs for DM conversations today
// (chat/thread.js is a newer generic module currently only wired up
// to group.js). This exercises the real removeDmMessage() and
// destroyDmComposer() against a jsdom DOM and a real render pass
// through media/attachments.js + audio-player.js/video-player.js,
// with URL.createObjectURL/revokeObjectURL spied on.
//
// Only dm.js's genuinely unrelated dependencies are mocked (socket,
// composer, typing, view-session, emoji-picker, message/attachment
// crypto, auth/api/server plumbing) — dm.js itself, media/
// attachments.js, audio-player.js and video-player.js all run for
// real.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

// ---------- DOM ----------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://wireapp.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
}));
globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));

// ---------- Spy on URL.createObjectURL/revokeObjectURL ----------
let blobSeq = 0;
const revokedUrls = [];
URL.createObjectURL = mock.fn(() => `blob:wire-test-${++blobSeq}`);
URL.revokeObjectURL = mock.fn((url) => revokedUrls.push(url));
function resetBlobSpies() {
    URL.createObjectURL.mock.resetCalls();
    URL.revokeObjectURL.mock.resetCalls();
    revokedUrls.length = 0;
}

// ---------- Mock dm.js's genuinely-unrelated dependencies ----------

mock.module(jsPath('core/auth.js'), {
    namedExports: { attemptAutoUnlock: () => {}, renderLogin: () => {}, renderUnlock: () => {}, setCurrentUser: () => {},
        getToken: () => 'test-token',
        logout: () => {},
        getCurrentUser: () => ({ id: 1, username: 'alice' }),
        // Phase B (B4) made settings-security.js import this from core/auth.js.
        // Without it here the module link fails before any assertion runs.
        clearPersistedUnlockKey: async () => {},
    },
});
mock.module(jsPath('core/api.js'), {
    namedExports: {
        api: async () => ({}),
        fetchBlob: async () => new Blob(['fake-image-bytes'], { type: 'image/png' }),
    },
});
mock.module(jsPath('core/server.js'), {
    namedExports: {
        resolveServerUrl: (u) => u,
        getServerEndpoint: () => 'https://wireapp.test',
        setServerEndpoint: () => {},
        isNativeApp: () => false,
    },
});
mock.module(jsPath('crypto/messages/attachment-crypto.js'), {
    namedExports: {
        decryptAttachmentForDm: async (peerId, buf) => new Uint8Array(buf),
        encryptAttachmentForDm: async () => ({}),
        computeImageDimensions: async () => null,
        // STEP 3C: chat/group-attachments.js imports the group half.
        encryptAttachmentForGroup: async () => ({ ivBase64: 'AAAAAAAAAAAAAAAA', ciphertext: new Uint8Array(16) }),
        decryptAttachmentForGroup: async () => new Uint8Array(16),
    },
});
mock.module(jsPath('vendor/capacitor.js'), {
    namedExports: {
        Capacitor: { isNativePlatform: () => false },
        FileTransfer: {},
        Directory: {},
        Filesystem: {},
    },
});
let mediaSrcQueue = [];
mock.module(jsPath('media/mediaToken.js'), {
    namedExports: {
        getMediaSrcUrl: async () => '/api/dm/attachments/1',
        refreshMediaSrcUrl: async () => '/api/dm/attachments/1',
        clearMediaTokenCache: () => {},
        resolveMediaSrc: async () => {
            const next = mediaSrcQueue.shift();
            if (next) return next;
            return { src: URL.createObjectURL(new Blob(['x'])), isBlob: true };
        },
    },
});
mock.module(jsPath('ui/avatar.js'), {
    namedExports: { applyAvatar: () => {}, bannerHtml: () => {}, getAvatarUrl: () => {}, refreshAvatarEverywhere: () => {}, refreshBannerEverywhere: () => {}, avatarHtml: () => '<div class="avatar-stub"></div>' },
});
mock.module(jsPath('ui/confirm.js'), {
    namedExports: { showConfirm: async () => true },
});
mock.module(jsPath('ui/emoji-picker.js'), {
    namedExports: { isEmojiPickerOpen: () => {}, openEmojiPicker: () => {} },
});
mock.module(jsPath('chat/reactions.js'), {
    namedExports: { renderReactionsRow: () => '', onReactionsUpdated: () => {}, updateMessageReactions: () => {}, reactButtonHtml: () => '', setActiveGroupIdGetter: () => {}, reactionEndpoint: () => '' },
});
mock.module(jsPath('chat/reply.js'), {
    namedExports: { buildReplyQuoteHtml: () => '', buildReplyPreview: (msg) => ({ id: msg.id }) },
});
mock.module(jsPath('chat/typing.js'), {
    namedExports: {
        createTypingEmitter: () => ({ start() {}, stop() {} }),
        createTypingIndicator: () => ({ render() {}, clear() {} }),
        wireTypingInput: () => {},
    },
});
mock.module(jsPath('core/socket.js'), {
    namedExports: { disconnectSocket: () => {}, initSocket: () => {}, getSocket: () => null },
});
mock.module(jsPath('chat/composer.js'), {
    namedExports: {
        createComposer: () => ({
            destroy: () => {},
            send: async () => {},
            setReplyTo: () => {},
            focus: () => {},
        }),
    },
});
mock.module(jsPath('chat/message-accent.js'), {
    namedExports: { setMessageAccent: () => {}, repaintAllMessageAccents: () => {} },
});
mock.module(jsPath('crypto/messages/message-crypto.js'), {
    namedExports: {
        encryptOutgoingMessage: async () => ({}),
        decryptIncomingMessage: async () => ({}),
        encryptDmTextV2: async () => ({ version: 1, content: '{}', msgId: null, peerMinVersion: 1 }),
        decryptDmTextV2: async () => 'decrypted',
        // STEP 2A: dm.js loads media/attachment-e2ee.js for real, and that module
        // now imports these from message-crypto.js. A mock that does not provide
        // them makes the module LINK fail ("does not provide an export named
        // ...") before a single assertion runs - which is what happened. Additive
        // only: no assertion and no production line changed.
        resolveDmAttachmentVersion: async () => ({ version: 1, peerMinVersion: 1 }),
        encryptDmAttachmentMetaV2: async () => ({ version: 2, content: '{}', msgId: null }),
        decryptDmAttachmentMetaV2: async () => '{}',
    },
});
mock.module(jsPath('core/view-session.js'), {
    namedExports: { claimRender: () => true, enterView: () => {}, isUserTypingIn: () => false },
});

// ---------- Real modules under test ----------
const { removeDmMessage, destroyDmComposer } = await import(jsPath('chat/dm.js'));
const { mountAttachmentMedia } = await import(jsPath('media/attachments.js'));

// ---------- Helpers ----------

function freshDmMessagesContainer() {
    document.querySelectorAll('#dm-messages').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.id = 'dm-messages';
    document.body.appendChild(el);
    return el;
}

function makeMsgEl(id) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.dataset.msgId = String(id);
    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    div.appendChild(content);
    return div;
}

async function waitForMicrotasks(n = 10) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

// =====================================================================

test('dm.js removeDmMessage(): deleting a real DM message revokes its audio blob URL', async () => {
    resetBlobSpies();
    mediaSrcQueue = [{ src: 'blob:wire-dm-audio-1', isBlob: true }];

    const container = freshDmMessagesContainer();
    const msg = { id: 9001, has_attachment: true, attachment_mime: 'audio/mpeg', attachment_name: 'note.mp3' };
    const el = makeMsgEl(msg.id);
    container.appendChild(el);

    mountAttachmentMedia(msg, el, 'dm');
    await waitForMicrotasks();

    const mounted = el.querySelector('audio[data-blob-url]');
    assert.ok(mounted, 'precondition: the real audio player should have mounted with data-blob-url');
    assert.equal(mounted.dataset.blobUrl, 'blob:wire-dm-audio-1');
    assert.equal(revokedUrls.length, 0, 'precondition: nothing revoked yet');

    removeDmMessage(msg.id);

    assert.deepEqual(revokedUrls, ['blob:wire-dm-audio-1'], 'removeDmMessage() must revoke the audio blob URL');
    assert.equal(container.querySelector('.chat-msg'), null, 'message node must be removed from the DOM');
});

test('dm.js destroyDmComposer(): navigating away revokes any still-mounted audio blob URLs in #dm-messages', async () => {
    resetBlobSpies();
    mediaSrcQueue = [{ src: 'blob:wire-dm-audio-2', isBlob: true }];

    const container = freshDmMessagesContainer();
    const msg = { id: 9002, has_attachment: true, attachment_mime: 'audio/mpeg', attachment_name: 'note2.mp3' };
    const el = makeMsgEl(msg.id);
    container.appendChild(el);

    mountAttachmentMedia(msg, el, 'dm');
    await waitForMicrotasks();

    assert.ok(el.querySelector('audio[data-blob-url]'), 'precondition: audio should have mounted');
    assert.equal(revokedUrls.length, 0);

    // This is what router.js's navigate() calls on every navigation,
    // including leaving the Messages tab for a different one — the
    // exact scenario where the old code silently leaked the blob.
    destroyDmComposer();

    assert.deepEqual(revokedUrls, ['blob:wire-dm-audio-2'], 'destroyDmComposer() must revoke the mounted audio blob URL');
});
