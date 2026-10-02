// tests/groups/thread-blob-cleanup.test.mjs
//
// NEW test written for the X port (not from the source tree).
//
// chat/thread.js revokes blob: URLs on <audio>/<video> when a message is
// removed and when the thread is destroyed, through a helper that is LOCAL
// to thread.js in this tree (X's media/attachments.js is intentionally
// untouched and has no such export). tests/blob-url-cleanup.test.mjs used to
// cover this but it drives the source tree's decrypted-attachment pipeline
// (mediaToken.resolveMediaSrc), which X does not have, so it is excluded
// (tests/EXCLUDED_NOT_APPLICABLE.json). This test keeps the group-related
// part covered without that pipeline: it stamps data-blob-url by hand, exactly
// as the players would, and checks the REAL thread.js revokes them.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const jsPath = (rel) => new URL(`../../public/js/${rel}`, import.meta.url).pathname;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://wireapp.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };

const revokedUrls = [];
URL.revokeObjectURL = mock.fn((url) => { revokedUrls.push(url); });

mock.module(jsPath('core/auth.js'), {
    namedExports: { getToken: () => 't', logout: () => {}, getCurrentUser: () => ({ id: 1, username: 'alice' }) },
});
mock.module(jsPath('ui/avatar.js'), { namedExports: { avatarHtml: () => '<div class="avatar-stub"></div>' } });
mock.module(jsPath('ui/confirm.js'), { namedExports: { showConfirm: async () => true } });
mock.module(jsPath('chat/reactions.js'), {
    namedExports: { renderReactionsRow: () => '', updateMessageReactions: () => {}, onReactionsUpdated: () => {} },
});
mock.module(jsPath('chat/reply.js'), {
    namedExports: { buildReplyQuoteHtml: () => '', buildReplyPreview: (m) => ({ id: m.id }) },
});
mock.module(jsPath('chat/message-accent.js'), {
    namedExports: { setMessageAccent: () => {}, repaintAllMessageAccents: () => {} },
});
// Not under test here: image/attachment rendering. Stubbed so the real
// media pipeline (and its native-platform imports) is not loaded at all.
mock.module(jsPath('media/attachments.js'), {
    namedExports: {
        renderAttachment: () => '',
        loadChatImage: () => {},
        mountAttachmentMedia: () => {},
        cleanupImageUrls: () => {},
        revokeAttachmentImage: () => {},
        imageDownloadButtonHtml: () => '',
    },
});

const { createMessageThread } = await import(jsPath('chat/thread.js'));

function freshThread(id) {
    document.querySelectorAll(`#${id}`).forEach((n) => n.remove());
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    const thread = createMessageThread({
        scope: 'group',
        containerId: id,
        emptyStateConfig: { icon: '', title: '', subtitle: '' },
        fetchRecent: async () => [],
        fetchBefore: async () => [],
        canDelete: () => true,
        deleteMessage: async () => {},
    });
    return { thread, el };
}

function msgEl(id, inner) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.dataset.msgId = String(id);
    div.innerHTML = `<div class="chat-msg-content">${inner}</div>`;
    return div;
}

test('thread.js removeMessage(): revokes the blob URLs of its audio AND video, leaves images alone', () => {
    revokedUrls.length = 0;
    const { thread, el } = freshThread('tb-1');
    const node = msgEl(501, '<audio data-blob-url="blob:a1"></audio><video data-blob-url="blob:v1"></video><img data-blob-url="blob:img1">');
    const other = msgEl(502, '<audio data-blob-url="blob:other"></audio>');
    el.append(node, other);

    thread.removeMessage(501);

    assert.deepEqual(revokedUrls.sort(), ['blob:a1', 'blob:v1'], 'only 501\'s audio+video revoked');
    assert.equal(el.querySelector('.chat-msg[data-msg-id="501"]'), null, 'message node removed');
    assert.ok(el.querySelector('.chat-msg[data-msg-id="502"]'), 'other message untouched');
    assert.equal(other.querySelector('audio').dataset.blobUrl, 'blob:other', 'other message keeps its URL');
});

test('thread.js destroy(): revokes every still-mounted audio/video blob URL in the container', () => {
    revokedUrls.length = 0;
    const { thread, el } = freshThread('tb-2');
    el.append(
        msgEl(601, '<audio data-blob-url="blob:a2"></audio>'),
        msgEl(602, '<video data-blob-url="blob:v2"></video><img data-blob-url="blob:img2">'),
    );

    thread.destroy();

    assert.deepEqual(revokedUrls.sort(), ['blob:a2', 'blob:v2']);
    assert.equal(el.querySelector('audio').dataset.blobUrl, undefined, 'marker cleared so it cannot be revoked twice');
});

test('thread.js removeMessage()/destroy() tolerate media without a blob URL and a missing container', () => {
    revokedUrls.length = 0;
    const { thread, el } = freshThread('tb-3');
    el.append(msgEl(701, '<audio src="/api/groups/1/attachments/9"></audio>'));
    assert.doesNotThrow(() => thread.removeMessage(701));
    assert.doesNotThrow(() => thread.removeMessage(99999));   // unknown id
    el.remove();
    assert.doesNotThrow(() => thread.destroy());              // container gone
    assert.deepEqual(revokedUrls, []);
});
