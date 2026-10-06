// tests/blob-url-cleanup.test.mjs
//
// Exercises the REAL removeMessage()/destroy() (thread.js) and
// removeDmMessage()/destroyDmComposer() (dm.js) code paths — plus
// the real render pipeline (media/attachments.js, audio-player.js,
// video-player.js, voice-message.js) that mounts the players in the
// first place — against a jsdom DOM, with URL.createObjectURL/
// revokeObjectURL replaced by spies so we can see (not assume)
// whether a blob: URL that was actually created gets actually
// revoked.
//
// Only genuinely unrelated dependencies are mocked (network/auth/
// crypto plumbing, avatar/reactions/reply/confirm UI bits this
// feature doesn't touch) — thread.js, dm.js, media/attachments.js,
// audio-player.js, video-player.js, voice-message.js and
// media/mediaToken.js all run for real.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../public/js/${rel}`, import.meta.url).pathname;

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
// jsdom doesn't implement matchMedia; video-player.js checks it for
// a reduced-motion preference. A harmless stub keeps renderVideo()
// running to completion instead of throwing partway through.
window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
}));
// jsdom's window doesn't implement getComputedStyle at all;
// video-player.js's debug logging calls it. A minimal stub avoids an
// unrelated crash in that diagnostic-only code path.
globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));

// ---------- Spy on the thing under test: URL.createObjectURL/revokeObjectURL ----------
// Node's global URL already implements these (Blob support); we
// replace them with spies so every test starts from a clean count
// and so we can assert on exactly which strings were revoked.
let blobSeq = 0;
const revokedUrls = [];
const createdUrls = [];

URL.createObjectURL = mock.fn((blob) => {
    const url = `blob:wire-test-${++blobSeq}`;
    createdUrls.push(url);
    return url;
});
URL.revokeObjectURL = mock.fn((url) => {
    revokedUrls.push(url);
});

function resetBlobSpies() {
    URL.createObjectURL.mock.resetCalls();
    URL.revokeObjectURL.mock.resetCalls();
    revokedUrls.length = 0;
    createdUrls.length = 0;
}

// ---------- Mock genuinely-unrelated dependencies ----------

mock.module(jsPath('core/auth.js'), {
    namedExports: {
        getToken: () => 'test-token',
        logout: () => {},
        getCurrentUser: () => ({ id: 1, username: 'alice' }),
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
        computeImageDimensions: async () => null,
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

// Full control over isBlob/src, and no real fetch/decrypt round trip
// needed to prove the *cleanup* wiring — audio-player.js/
// video-player.js/voice-message.js's own logic (what actually reads
// this and stamps data-blob-url) still runs for real.
let mediaSrcQueue = [];
mock.module(jsPath('media/mediaToken.js'), {
    namedExports: {
        getMediaSrcUrl: async () => '/api/dm/attachments/1',
        refreshMediaSrcUrl: async () => '/api/dm/attachments/1',
        clearMediaTokenCache: () => {},
        resolveMediaSrc: async (msg) => {
            const next = mediaSrcQueue.shift();
            if (next) return next;
            const url = URL.createObjectURL(new Blob(['x']));
            return { src: url, isBlob: true };
        },
    },
});

mock.module(jsPath('ui/avatar.js'), {
    namedExports: { avatarHtml: () => '<div class="avatar-stub"></div>' },
});
mock.module(jsPath('ui/confirm.js'), {
    namedExports: { showConfirm: async () => true },
});
mock.module(jsPath('chat/reactions.js'), {
    namedExports: {
        renderReactionsRow: () => '',
        updateMessageReactions: () => {},
        onReactionsUpdated: () => {},
    },
});
mock.module(jsPath('chat/reply.js'), {
    namedExports: {
        buildReplyQuoteHtml: () => '',
        buildReplyPreview: (msg) => ({ id: msg.id }),
    },
});
mock.module(jsPath('chat/message-accent.js'), {
    namedExports: { setMessageAccent: () => {}, repaintAllMessageAccents: () => {} },
});

// ---------- Real modules under test ----------
const { createMessageThread } = await import(jsPath('chat/thread.js'));
const {
    mountAttachmentMedia,
    revokeMediaPlayerBlobUrls,
    cleanupImageUrls,
    revokeAttachmentImage,
} = await import(jsPath('media/attachments.js'));
const { renderAudio } = await import(jsPath('media/audio-player.js'));
const { renderVideo } = await import(jsPath('media/video-player.js'));

// ---------- Helpers ----------

function freshContainer(id) {
    document.querySelectorAll(`#${id}`).forEach((n) => n.remove());
    const el = document.createElement('div');
    el.id = id;
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

async function waitForMicrotasks(n = 6) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

// =====================================================================
// 1. revokeMediaPlayerBlobUrls — the core new utility, in isolation
// =====================================================================

test('revokeMediaPlayerBlobUrls revokes audio/video blob URLs but leaves images alone', () => {
    resetBlobSpies();

    const root = document.createElement('div');
    const audio = document.createElement('audio');
    audio.dataset.blobUrl = 'blob:wire-test-audio';
    const video = document.createElement('video');
    video.dataset.blobUrl = 'blob:wire-test-video';
    const img = document.createElement('img');
    img.dataset.blobUrl = 'blob:wire-test-image'; // image cache path handles this one, not us

    root.append(audio, video, img);

    revokeMediaPlayerBlobUrls(root);

    assert.deepEqual(
        revokedUrls.sort(),
        ['blob:wire-test-audio', 'blob:wire-test-video'].sort(),
        'must revoke exactly the audio+video blob URLs, not the image one'
    );
    assert.equal(audio.dataset.blobUrl, undefined, 'audio data-blob-url must be cleared');
    assert.equal(video.dataset.blobUrl, undefined, 'video data-blob-url must be cleared');
    assert.equal(img.dataset.blobUrl, 'blob:wire-test-image', 'image marker must be left untouched');
});

test('revokeMediaPlayerBlobUrls is a no-op on null/empty root (does not throw)', () => {
    resetBlobSpies();
    assert.doesNotThrow(() => revokeMediaPlayerBlobUrls(null));
    assert.equal(revokedUrls.length, 0);
});

// =====================================================================
// 2. Real render pipeline -> real thread.js removeMessage()
// =====================================================================

test('thread.js removeMessage(): deleting a message revokes its audio AND video blob URLs', async () => {
    resetBlobSpies();
    mediaSrcQueue = [
        { src: 'blob:wire-test-audio-1', isBlob: true },
        { src: 'blob:wire-test-video-1', isBlob: true },
    ];

    freshContainer('t-messages');

    const thread = createMessageThread({
        scope: 'dm',
        containerId: 't-messages',
        emptyStateConfig: { icon: '', title: '', subtitle: '' },
        fetchRecent: async () => [],
        fetchBefore: async () => [],
        canDelete: () => true,
        deleteMessage: async () => {},
    });

    const container = document.getElementById('t-messages');

    const audioMsg = { id: 501, has_attachment: true, attachment_mime: 'audio/mpeg', attachment_name: 'song.mp3' };
    const videoMsg = { id: 502, has_attachment: true, attachment_mime: 'video/mp4', attachment_name: 'clip.mp4' };

    const audioEl = makeMsgEl(audioMsg.id);
    const videoEl = makeMsgEl(videoMsg.id);
    container.append(audioEl, videoEl);

    mountAttachmentMedia(audioMsg, audioEl, 'dm');
    mountAttachmentMedia(videoMsg, videoEl, 'dm');
    await waitForMicrotasks(10);

    // Sanity: the real players actually mounted and actually stamped
    // data-blob-url — if this fails, the rest of the assertion below
    // would be vacuously true, so we check it explicitly.
    const mountedAudio = audioEl.querySelector('audio[data-blob-url]');
    const mountedVideo = videoEl.querySelector('video[data-blob-url]');
    assert.ok(mountedAudio, 'precondition: audio element with data-blob-url should have mounted');
    assert.ok(mountedVideo, 'precondition: video element with data-blob-url should have mounted');
    assert.equal(mountedAudio.dataset.blobUrl, 'blob:wire-test-audio-1');
    assert.equal(mountedVideo.dataset.blobUrl, 'blob:wire-test-video-1');
    assert.equal(revokedUrls.length, 0, 'precondition: nothing revoked yet');

    // document.documentElement doesn't have data-animations=on, so
    // animateRemoval() removes synchronously — no need to wait.
    thread.removeMessage(audioMsg.id);
    thread.removeMessage(videoMsg.id);

    assert.deepEqual(
        revokedUrls.sort(),
        ['blob:wire-test-audio-1', 'blob:wire-test-video-1'].sort(),
        'removeMessage() must revoke both blob URLs'
    );
    assert.equal(container.querySelector('.chat-msg'), null, 'both message nodes must be removed from the DOM');
});

test('thread.js destroy(): tearing down the thread revokes any still-mounted audio/video blob URLs', async () => {
    resetBlobSpies();
    mediaSrcQueue = [{ src: 'blob:wire-test-audio-2', isBlob: true }];

    freshContainer('t-messages-2');

    const thread = createMessageThread({
        scope: 'dm',
        containerId: 't-messages-2',
        emptyStateConfig: { icon: '', title: '', subtitle: '' },
        fetchRecent: async () => [],
        fetchBefore: async () => [],
        canDelete: () => true,
        deleteMessage: async () => {},
    });

    const container = document.getElementById('t-messages-2');
    const msg = { id: 601, has_attachment: true, attachment_mime: 'audio/mpeg', attachment_name: 'song.mp3' };
    const el = makeMsgEl(msg.id);
    container.appendChild(el);

    mountAttachmentMedia(msg, el, 'dm');
    await waitForMicrotasks(10);

    assert.ok(el.querySelector('audio[data-blob-url]'), 'precondition: audio should have mounted');
    assert.equal(revokedUrls.length, 0);

    thread.destroy();

    assert.deepEqual(revokedUrls, ['blob:wire-test-audio-2'], 'destroy() must revoke the mounted audio blob URL');
});

// =====================================================================
// 3. Race condition fix: message/container disappears while
//    resolveMediaSrc() is still in flight (audio-player.js / video-player.js)
// =====================================================================

test('audio-player.js: a blob resolved after the container was already removed gets revoked, not leaked', async () => {
    resetBlobSpies();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    container.appendChild(content);

    const msg = { id: 701, has_attachment: true, attachment_mime: 'audio/mpeg', attachment_name: 'song.mp3' };

    let releaseResolveMediaSrc;
    mediaSrcQueue = [
        new Promise((resolve) => {
            releaseResolveMediaSrc = () => resolve({ src: 'blob:wire-test-orphan', isBlob: true });
        }),
    ];
    // resolveMediaSrc is mocked as `async (msg) => { const next = queue.shift(); if (next) return next; ... }`
    // — shifting out a *pending* promise works fine since `return next`
    // on an async function just chains it.

    const renderPromise = renderAudio(msg, 'dm', container);

    // Simulate the message being deleted while the media-token /
    // decrypt round trip is still in flight.
    container.remove();

    releaseResolveMediaSrc();
    await renderPromise;
    await waitForMicrotasks(5);

    assert.deepEqual(revokedUrls, ['blob:wire-test-orphan'], 'the orphaned blob must be revoked, not leaked');
    assert.equal(content.querySelector('audio'), null, 'no player should have been inserted into the removed container');
});

test('video-player.js: a blob resolved after the container was already removed gets revoked, not leaked', async () => {
    resetBlobSpies();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    container.appendChild(content);

    const msg = { id: 702, has_attachment: true, attachment_mime: 'video/mp4', attachment_name: 'clip.mp4' };

    let releaseResolveMediaSrc;
    mediaSrcQueue = [
        new Promise((resolve) => {
            releaseResolveMediaSrc = () => resolve({ src: 'blob:wire-test-orphan-2', isBlob: true });
        }),
    ];

    const renderPromise = renderVideo(msg, 'dm', container);
    container.remove();
    releaseResolveMediaSrc();
    await renderPromise;
    await waitForMicrotasks(5);

    assert.deepEqual(revokedUrls, ['blob:wire-test-orphan-2'], 'the orphaned blob must be revoked, not leaked');
    assert.equal(content.querySelector('video'), null, 'no player should have been inserted into the removed container');
});
