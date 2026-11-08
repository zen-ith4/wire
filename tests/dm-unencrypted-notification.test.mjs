// tests/dm-unencrypted-notification.test.mjs
//
// A system notification has nowhere to put the "Not encrypted" mark the thread shows,
// so a marked row must not put its words or its file details in one.
//
// Real: notifications/notification-manager.js. The platform calls are replaced, to read
// what would have been shown.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;

const shown = [];

globalThis.window = { addEventListener: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

mock.module(js('core/auth.js'), {
    namedExports: { getCurrentUser: () => ({ id: 1 }) },
});

mock.module(js('core/server.js'), {
    namedExports: { isNativeApp: () => false },
});

mock.module(js('core/router.js'), {
    namedExports: { navigate: () => {} },
});

mock.module(js('media/voice-message.js'), {
    namedExports: { isVoiceMessage: (message) => !!message.is_voice_message },
});

mock.module(js('ui/avatar.js'), {
    namedExports: { getAvatarUrl: async () => null },
});

mock.module(js('notifications/web-notifications.js'), {
    namedExports: {
        isWebNotificationSupported: () => true,
        showWebNotification: (payload) => { shown.push(payload); },
    },
});

const { maybeNotifyDM } = await import(js('notifications/notification-manager.js'));

let nextId = 1;

async function previewOf(fields) {
    shown.length = 0;

    maybeNotifyDM({ id: nextId++, sender_id: 2, sender_username: 'bob', ...fields }, false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(shown.length, 1, 'a notification must have been shown');
    return shown[0].preview;
}

beforeEach(() => {
    shown.length = 0;
});

test('control: a row that opened shows its text', async () => {
    assert.equal(await previewOf({ content: 'see you at noon' }), 'see you at noon');
});

test('a marked row shows a fixed text, not its words', async () => {
    assert.equal(
        await previewOf({ not_encrypted: true, content: 'send the money to account 666' }),
        'Not encrypted message'
    );
});

test('a marked row does not say what kind of file it claims to carry', async () => {
    assert.equal(
        await previewOf({ not_encrypted: true, content: '', has_attachment: true, attachment_mime: 'image/png' }),
        'Not encrypted message'
    );
    assert.equal(
        await previewOf({ not_encrypted: true, content: '', is_voice_message: true }),
        'Not encrypted message'
    );
});
