import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// reactions.js assigns window.toggleMessageReaction/openReactionPicker
// at module top-level — give it something to assign to.
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

// reactions.js also imports core/api.js, core/auth.js and
// ui/emoji-picker.js — none of which reactionEndpoint() itself uses,
// but ES modules evaluate every import at load time, so these need
// stubs to load the file at all in Node. icons.js is pure data (no
// DOM), so it's left real.
mock.module('/home/claude/wire/public/js/core/api.js', {
    namedExports: { api: async () => ({}) },
});
mock.module('/home/claude/wire/public/js/core/auth.js', {
    namedExports: { getCurrentUser: () => null },
});
mock.module('/home/claude/wire/public/js/ui/emoji-picker.js', {
    namedExports: { openEmojiPicker: () => {} },
});

const { reactionEndpoint, setActiveGroupIdGetter } = await import(
    '/home/claude/wire/public/js/chat/reactions.js'
);

// Independent reference: the exact pre-change line, reconstructed
// fresh here rather than derived from the current reactionEndpoint —
// this is literally what the ternary said before setActiveGroupIdGetter
// and the 'group' branch were added.
function oldReactionEndpoint(scope, messageId) {
    return scope === 'dm'
        ? `/api/dm/messages/${messageId}/reactions`
        : `/api/chat/messages/${messageId}/reactions`;
}

test('reactionEndpoint("dm", id) is byte-identical to the pre-change ternary', () => {
    for (const id of [1, 42, 999999]) {
        const before = oldReactionEndpoint('dm', id);
        const after = reactionEndpoint('dm', id);
        assert.equal(after, before, `mismatch for dm id=${id}`);
        console.log(`dm    id=${id}: before="${before}" after="${after}"`);
    }
});

test('the removed "chat" scope (and any unknown scope) now throws instead of building a dead /api/chat URL', () => {
    assert.throws(() => reactionEndpoint('chat', 7), /Unknown reaction scope/);
    assert.throws(() => reactionEndpoint('anything-else', 7), /Unknown reaction scope/);
});

test('new: scope "group" builds a groupId-scoped URL via the registered getter (did not exist before)', () => {
    setActiveGroupIdGetter(() => 42);
    assert.equal(reactionEndpoint('group', 7), '/api/groups/42/messages/7/reactions');
});

test('new: scope "group" with no active group throws instead of silently building a broken URL', () => {
    setActiveGroupIdGetter(() => null);
    assert.throws(() => reactionEndpoint('group', 7), /No active group/);
});
