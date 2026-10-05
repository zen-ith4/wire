// public/js/chat/group.js
//
// E2EE group chat (plan_prompt.md Phase 3). Structurally mirrors
// dm.js's "one active thread among several, switchable" model far
// more than chat.js's "one single always-mounted room" model — a
// group behaves like a DM conversation (restricted membership, many
// simultaneous threads) not like the old open chat room — which is
// exactly why thread.js's syncSince (DM-style reconciliation) is
// what this uses, not chat.js's fuller reconcileChat.
//
// Deliberately simplified vs. dm.js in this pass, not silently
// missing: no mobile swipe-back gesture (dm.js's
// bindDmMobileSwipeBack), no live-filtered picker search animation —
// group creation/add-member reuse the same /api/share/users list
// dm.js's picker already fetches, just without the extra polish.
// Attachments are not wired at all (composer has no file input) —
// see controllers/groups.controller.js's Phase-1 note and
// media/attachments.js's Phase-4 TODOs; group messages never have
// has_attachment=true yet, so thread.js's attachment code paths stay
// correctly inert here.

import { api } from '../core/api.js';
import { getCurrentUser } from '../core/auth.js';
import {
    escapeHtml,
    escapeHtmlAttr,
    emptyState,
    loadingState,
    showToast,
} from '../core/utils.js';
import { ICONS } from '../icons.js';
import { avatarHtml } from '../ui/avatar.js';
import { showConfirm } from '../ui/confirm.js';

// showConfirm() renders #confirm-modal, a plain element in the page. Group
// settings live in a native modal <dialog> (files/dialog.js -> showModal()),
// which puts everything outside it -- #confirm-modal included -- inert and
// UNDER the dialog's top layer. Called from inside that dialog, the
// confirmation is therefore invisible and unclickable, its promise never
// settles, and "Remove member" / "Leave group" silently do nothing. A child of
// the open <dialog> is in the top layer too, so move the confirm modal into it
// for the duration of the question and put it back afterwards. Outside a
// dialog this is exactly showConfirm().
async function confirmInDialog(panel, message, opts) {
    const dialog = panel?.closest?.('dialog');
    const modal = document.getElementById('confirm-modal');

    if (!dialog || !modal) {
        return showConfirm(message, opts);
    }

    const home = modal.parentNode;
    const next = modal.nextSibling;
    dialog.appendChild(modal);

    try {
        return await showConfirm(message, opts);
    } finally {
        home.insertBefore(modal, next);
    }
}
import { openDialog } from '../files/dialog.js';
import { newChatFabHtml, bindNewChatFab } from '../ui/new-chat-fab.js';
import { isUserOnline } from './presence.js';
import { createTypingEmitter, createTypingIndicator, wireTypingInput } from './typing.js';
import { getSocket } from '../core/socket.js';
import { createComposer } from './composer.js';
import { createMessageThread, wirePasteImage } from './thread.js';
import { setActiveGroupIdGetter } from './reactions.js';

import {
    encryptOutgoingGroupMessage,
    decryptIncomingGroupMessageDetailed,
    ensureSenderKeyForGroup,
    drainGroupKdms,
    forgetGroupKeys,
    MissingSenderKeyError,
} from '../crypto/messages/group-message-crypto.js';

// ---------- Module state ----------

let groupsList = []; // [{id, name, avatar_path, role, key_epoch, ...}]
let groupsLoaded = false;
let activeGroupId = null;
let activeGroupMembers = []; // members of the currently-open group
let groupComposer = null;

// One thread.js instance per group, created lazily and kept for the
// session so switching back to a group already visited this session
// repaints from cache instantly (same reasoning as dm.js's dmCache).
const groupThreads = new Map();

// role/membership per group, refreshed whenever that group's member
// list is fetched — canDelete and the member-management UI both
// need "what's MY role in THIS group", not just "am I a member".
const membershipByGroupId = new Map();

window.addEventListener('wire:logout', () => {
    groupsList = [];
    groupsLoaded = false;
    activeGroupId = null;
    activeGroupMembers = [];
    groupThreads.clear();
    membershipByGroupId.clear();
    groupTypingIndicator.clearAll();
});

setActiveGroupIdGetter(() => activeGroupId);

// ---------- Typing indicator ----------

function renderGroupTyping(usernames) {
    const el = document.getElementById('group-typing-indicator');
    if (!el) return;
    if (usernames.length === 0) {
        el.textContent = '';
        el.classList.remove('active');
        return;
    }
    const text = usernames.length === 1
        ? `${usernames[0]} is typing…`
        : usernames.length === 2
            ? `${usernames[0]} and ${usernames[1]} are typing…`
            : `${usernames.length} people are typing…`;
    el.textContent = text;
    el.classList.add('active');
}

const groupTypingIndicator = createTypingIndicator(renderGroupTyping);
const groupTypingEmitter = createTypingEmitter(
    getSocket,
    'group:typing',
    'group:stop-typing',
    () => (activeGroupId ? { group_id: activeGroupId } : null)
);

export function showGroupTyping(groupId, userId, username) {
    if (groupId !== activeGroupId) return;
    groupTypingIndicator.set(userId, username);
}

export function hideGroupTyping(groupId, userId) {
    if (groupId !== activeGroupId) return;
    groupTypingIndicator.clear(userId);
}

export function clearAllGroupTyping() {
    groupTypingIndicator.clearAll();
}

export function destroyGroupComposer() {
    if (groupComposer) groupComposer.destroy();
}

export function getActiveGroupId() {
    return activeGroupId;
}

// ---------- Membership / role helpers ----------

function groupAvatarHtml(group, className = 'conv-avatar') {
    const name = group?.name || 'Group';
    const initial = name.charAt(0).toUpperCase();
    return `
        <div class="${className} group-avatar-badge" title="${escapeHtmlAttr(name)}">
            <span class="avatar-initials">${escapeHtml(initial)}</span>
        </div>
    `;
}
function myMembership(groupId) {
    return membershipByGroupId.get(groupId) || null;
}

function isElevated(role) {
    return role === 'owner' || role === 'admin';
}

function canDeleteGroupMessage(msg, currentUser) {
    if (!currentUser) return false;
    if (Number(msg.sender_id) === Number(currentUser.id)) return true;
    if (currentUser.is_admin) return true;
    const membership = myMembership(activeGroupId);
    return !!membership && isElevated(membership.role);
}

// ---------- Crypto glue (thread.js's decorate/onDecorateError hooks) ----------

// Exported (rather than module-private) so tests can drive the REAL
// decorate callback directly. Attaches `senderKeyId` (string) to every
// successfully decrypted message: the Sender Key that encrypted the
// message envelope, which is also the key any attachment on that same
// message was encrypted under. Later media code reads `msg.senderKeyId`
// and passes it to decryptAttachmentForGroup(). Placeholder / dropped
// messages (see onGroupDecorateError) never carry it.
// The server only ever stores ciphertext, so the quoted message a reply
// points at (reply_to.content) is an envelope too. It must be decrypted
// like any other message or the quote renders raw JSON. A quote that cannot
// be decrypted (keyless, corrupt, older epoch) degrades to a neutral label
// and never affects the reply itself; the envelope is never shown.
async function decryptReplyPreview(groupId, replyTo) {
    if (!replyTo || typeof replyTo.content !== 'string' || replyTo.content === '') {
        return replyTo;
    }
    try {
        const { plaintext } = await decryptIncomingGroupMessageDetailed(groupId, replyTo.content);
        return { ...replyTo, content: plaintext };
    } catch {
        return { ...replyTo, content: '🔒 Encrypted message' };
    }
}

export async function decorateGroupMessages(groupId, rawMessages, { live = false } = {}) {
    const out = [];
    for (const raw of rawMessages) {
        try {
            // senderKeyId comes back from the SAME lookup that selected the
            // key which authenticated this envelope (not a second parse).
            const { plaintext, senderKeyId } = await decryptIncomingGroupMessageDetailed(groupId, raw.content);
            out.push({
                ...raw,
                content: plaintext,
                senderKeyId,
                reply_to: await decryptReplyPreview(groupId, raw.reply_to),
            });
        } catch (e) {
            // Live arrival: let thread.js see the error so it can show a
            // "waiting for key" placeholder (MissingSenderKeyError) or drop
            // the message (anything else). Swallowing it here — as this
            // function used to — made the placeholder path dead code and
            // lost the message entirely.
            if (live) throw e;

            // Bulk history fetch: isolate failures PER MESSAGE. Any member
            // can POST arbitrary text as "ciphertext" (the server cannot
            // check it), and a rotation this device hasn't caught up on
            // leaves some messages keyless. Rethrowing here used to make
            // one bad row discard the whole 50-message batch for everyone
            // (audit F-C).
            const why = e instanceof MissingSenderKeyError ? 'no Sender Key yet' : e.message;
            console.warn(`[group] skipping undecryptable message ${raw.id} (${why})`);
        }
    }
    return out;
}

// Drain the KDM mailbox and, if that delivered anything, re-attempt the
// messages that were waiting for it (they would otherwise stay
// placeholders until a page reload).
async function drainAndRetry(groupId) {
    const consumed = await drainGroupKdms(groupId);
    if (consumed > 0) await groupThreads.get(groupId)?.retryPlaceholders();
    return consumed;
}

function onGroupDecorateError(error, rawMsg) {
    if (!(error instanceof MissingSenderKeyError)) return null;

    // Self-heal (plan_prompt.md's acceptance checklist: "losing one
    // member's KDM doesn't corrupt the group for everyone else").
    // Fire a drain in the background; if it lands the key, the next
    // syncSince()/reconnect naturally picks the message up for real.
    // We don't retry-render THIS placeholder in place — keeping that
    // simple is worth a "reload to see it" edge case for a message
    // that arrives faster than its KDM, which should be rare in
    // practice (KDMs are submitted before/alongside the message).
    drainAndRetry(rawMsg.group_id).catch((e) => {
        console.error('[group] background KDM drain failed:', e);
    });

    return { html: '<span class="text-muted">🔒 Waiting for encryption key…</span>' };
}

// ---------- Thread instances ----------

function getOrCreateThread(groupId) {
    let thread = groupThreads.get(groupId);
    if (thread) return thread;

    thread = createMessageThread({
        scope: 'group',
        containerId: 'group-messages',
        emptyStateConfig: () => ({
            icon: ICONS.chat,
            title: 'No messages yet',
            subtitle: 'Say hello 👋',
        }),
        fetchRecent: (limit) => api(`/api/groups/${groupId}/messages/recent?limit=${limit}`),
        fetchBefore: (before, limit) =>
            api(`/api/groups/${groupId}/messages/before?before=${encodeURIComponent(before)}&limit=${limit}`),
        fetchSince: (since, limit) =>
            api(`/api/groups/${groupId}/messages/since?since=${encodeURIComponent(since)}&limit=${limit}`),
        decorate: (raw, opts) => decorateGroupMessages(groupId, raw, opts),
        isMounted: () => activeGroupId === groupId,
        onDecorateError: onGroupDecorateError,
        canDelete: canDeleteGroupMessage,
        deleteMessage: (id) => api(`/api/groups/${groupId}/messages/${id}`, { method: 'DELETE' }),
        getComposer: () => groupComposer,
    });

    groupThreads.set(groupId, thread);
    return thread;
}

// ---------- Group list ----------

export async function loadGroupsList() {
    try {
        groupsList = await api('/api/groups');
        groupsLoaded = true;
    } catch (e) {
        console.error('[group] failed to load group list:', e);
    }
    paintGroupList();
}

function paintGroupList() {
    const list = document.getElementById('group-list');
    if (!list) return;

    if (groupsList.length === 0) {
        list.innerHTML = emptyState(
            ICONS.users || ICONS.chat,
            'No groups yet',
            'Create a group to start an encrypted conversation.'
        );
        return;
    }

    const q = (document.getElementById('group-conv-search')?.value || '').trim().toLowerCase();
    const shown = q ? groupsList.filter((g) => String(g.name || '').toLowerCase().includes(q)) : groupsList;

    if (shown.length === 0) {
        list.innerHTML = emptyState(ICONS.search, 'No matches', `No group found for “${escapeHtml(q)}”`);
        return;
    }

    list.innerHTML = shown
        .map((g) => `
            <div class="dm-conv group-row${g.id === activeGroupId ? ' active' : ''}" data-group-id="${Number(g.id)}" role="option" tabindex="0">
                ${groupAvatarHtml(g, 'conv-avatar')}
                <div class="conv-info">
                    <div class="dm-conv-name">${escapeHtml(g.name)}</div>
                    <div class="dm-conv-preview">${g.role === 'owner' ? 'Owner' : g.role === 'admin' ? 'Admin' : 'Member'}</div>
                </div>
            </div>
        `)
        .join('');

    list.querySelectorAll('.group-row').forEach((row) => {
        row.addEventListener('click', () => openGroup(Number(row.dataset.groupId)));
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openGroup(Number(row.dataset.groupId));
            }
        });
    });
}

// ---------- Opening a group ----------

async function loadMembers(groupId) {
    const members = await api(`/api/groups/${groupId}/members`);
    // Only the OPEN group's list feeds the member bar / key fan-out. A
    // membership event for some other group must not overwrite it.
    if (groupId === activeGroupId) activeGroupMembers = members;

    const currentUser = getCurrentUser();
    const mine = members.find((m) => Number(m.user_id) === Number(currentUser?.id));
    if (mine) membershipByGroupId.set(groupId, mine);

    return members;
}

// One rotation at a time per group: two concurrent "no key yet" checks
// would each mint a key under the SAME senderKeyId and the second would
// overwrite the first after recipients already stored it.
const keyEnsureInflight = new Map();

function ensureSenderKeyReady(groupId, members = activeGroupMembers, { quiet = false } = {}) {
    const existing = keyEnsureInflight.get(groupId);
    if (existing) return existing;

    const run = (async () => {
        const membership = myMembership(groupId);
        if (!membership) return;

        const memberUserIds = members.map((m) => m.user_id);

        try {
            await ensureSenderKeyForGroup(groupId, memberUserIds, membership.key_epoch);
        } catch (e) {
            console.error('[group] failed to ensure Sender Key:', e);
            if (!quiet) showToast('Could not set up encryption for this group', 'error');
        }
    })().finally(() => keyEnsureInflight.delete(groupId));

    keyEnsureInflight.set(groupId, run);
    return run;
}

export async function openGroup(groupId) {
    if (!Number.isInteger(groupId) || groupId <= 0) return;

    // Typing indicators are broadcast to the socket room
    // `group:<id>` (see sockets/group.socket.js) — join the new
    // group's room and leave the previous one, mirroring how DM
    // switches which peer's live events are relevant. The other
    // group events (new message, membership change, KDM, etc.) are
    // delivered to this user's `user:<id>` room regardless of which
    // group is open, so they don't need this.
    const socket = getSocket();
    if (socket) {
        if (activeGroupId && activeGroupId !== groupId) {
            socket.emit('group:leave-room', { group_id: activeGroupId });
        }
        socket.emit('group:join', { group_id: groupId });
    }

    activeGroupId = groupId;
    groupTypingIndicator.clearAll();
    paintGroupList(); // update the "active" highlight
    document.querySelector('.dm-layout')?.classList.add('showing-thread');

    const panel = document.getElementById('group-active-panel');
    if (!panel) return;

    const group = groupsList.find((g) => g.id === groupId);

    renderActiveGroupShell(group);

    // Make THIS group's thread the target of the delegated Reply/Delete
    // buttons (see thread.js activate()); must happen before any await
    // so a click during load can't reach a previously-opened group.
    getOrCreateThread(groupId).activate();

    let members;
    try {
        members = await loadMembers(groupId);
    } catch (e) {
        console.error('[group] failed to load members:', e);
        showToast('Failed to load group members', 'error');
        return;
    }

    // The user may have switched groups while we awaited; every step
    // below paints into the shared #group-* containers, so bail out
    // rather than draw group A over group B.
    if (activeGroupId !== groupId) return;

    renderMemberBar();

    await ensureSenderKeyReady(groupId, members);
    if (activeGroupId !== groupId) return;

    // Drain first so any messages this thread is about to render can
    // actually be decrypted, rather than racing the fetch below.
    try {
        await drainGroupKdms(groupId);
    } catch (e) {
        console.error('[group] KDM drain failed:', e);
    }
    if (activeGroupId !== groupId) return;

    const thread = getOrCreateThread(groupId);

    if (thread.cache.initialized) {
        await thread.retryPlaceholders();
        if (activeGroupId !== groupId) return;
        thread.paintFromCache();
        void thread.syncSince();
    } else {
        await thread.loadRecent();
    }
}

function renderActiveGroupShell(group) {
    const panel = document.getElementById('group-active-panel');
    if (!panel) return;

    panel.innerHTML = `
        <div class="chat-top-bar">
            <button type="button" class="icon-btn dm-back-btn" title="Back" aria-label="Back" data-action="group-back">${ICONS.arrowLeft}</button>
            ${groupAvatarHtml(group, 'chat-top-avatar')}
            <div class="grp-top-main">
                <div class="chat-top-name">${escapeHtml(group?.name || 'Group')}</div>
                <div class="chat-top-status" id="group-member-bar"></div>
            </div>
            <button type="button" class="btn btn-ghost btn-icon" title="Manage group" data-action="group-settings" data-group-id="${Number(group?.id)}">${ICONS.settings || '⚙'}</button>
        </div>
        <div class="chat-messages" id="group-messages">${loadingState()}</div>
        <div class="typing-indicator" id="group-typing-indicator"></div>
        <div class="composer-wrapper">
            <div class="reply-preview-bar" id="group-reply-preview"></div>
            <div class="chat-input-area" id="group-input-area">
                <button class="btn btn-ghost btn-icon emoji-trigger" title="Emoji" data-action="group-emoji">${ICONS.emoji}</button>
                <textarea id="group-input" rows="1" placeholder="Message ${escapeHtmlAttr(group?.name || 'group')}…"></textarea>
                <button type="button" data-action="group-send" class="btn-send" title="Send message (Enter) — Shift+Enter for a new line">${ICONS.send}</button>
            </div>
        </div>
    `;

    if (groupComposer) groupComposer.destroy();

    groupComposer = createComposer({
        inputId: 'group-input',
        // fileInputId/stagingId point at ids that don't exist in the
        // rendered markup above — group attachments aren't supported
        // yet (see this file's top-of-file note). composer.js's
        // file-staging code all gracefully no-ops when these ids
        // don't resolve to any element; passing concrete strings
        // here (rather than leaving them undefined) just avoids the
        // literal string "undefined" ending up in the global
        // function names composer.js builds from stagingId.
        fileInputId: 'group-file-input',
        stagingId: 'group-staging-area',
        replyPreviewId: 'group-reply-preview',
        sendTextUrl: `/api/groups/${group?.id}/messages`,
        buildTextBody: async (content) => ({
            content: await encryptOutgoingGroupMessage(group.id, content),
        }),
        onMessage: () => {}, // the message comes back over the socket (new-group-message) and lands via addGroupMessage; avoids double-adding it here
        typingEmitter: groupTypingEmitter,
        inputAreaId: 'group-input-area',
    });

    wirePasteImage('group-input', () => {}); // no-op: pasted images aren't supported without an upload path yet
    wireTypingInput('group-input', groupTypingEmitter);

    window.sendGroupMessage = () => groupComposer?.send();
    window.openGroupEmojiPicker = (triggerEl) => {
        import('../ui/emoji-picker.js').then(({ openEmojiPicker }) => {
            openEmojiPicker({
                anchorEl: triggerEl,
                onSelect: (char) => {
                    const input = document.getElementById('group-input');
                    if (input) {
                        input.value += char;
                        input.dispatchEvent(new Event('input'));
                        input.focus();
                    }
                },
            });
        });
    };
}

function renderMemberBar() {
    const bar = document.getElementById('group-member-bar');
    if (!bar) return;

    const onlineCount = activeGroupMembers.filter((m) => isUserOnline(m.user_id)).length;
    bar.textContent = `${activeGroupMembers.length} member${activeGroupMembers.length === 1 ? '' : 's'} · ${onlineCount} online`;
}

// ---------- Top-level view entry ----------

export async function showGroups() {
    const main = document.getElementById('content-area');
    if (!main) return;

    main.innerHTML = `
        <div class="dm-layout">
            <div class="dm-sidebar">
                <div class="conv-header">
                    <div class="conv-header-row">
                        <span class="conv-header-label">Groups</span>
                    </div>
                    <div class="conv-search-wrap">
                        <span class="conv-search-icon">${ICONS.search}</span>
                        <input type="text" class="conv-search-input" id="group-conv-search" placeholder="Search groups…" autocomplete="off">
                    </div>
                </div>
                <div class="dm-conv-list" id="group-list">${groupsLoaded ? '' : loadingState()}</div>
                ${newChatFabHtml()}
            </div>
            <div class="dm-thread" id="group-active-panel">
                ${emptyState(ICONS.users, 'Select a group', 'Choose a group from the list, or create a new one with the + button.')}
            </div>
        </div>
    `;

    bindNewChatFab(main, {
        onMessage: async () => {
            const { navigate } = await import('../core/router.js');
            await navigate('messages');
            window.openNewDmPicker?.();
        },
        onGroup: () => window.openCreateGroupDialog(),
    });

    document.getElementById('group-conv-search').addEventListener('input', paintGroupList);

    if (groupsLoaded) {
        paintGroupList();
    } else {
        await loadGroupsList();
    }

    // On phones the list is the landing screen; only auto-open the last
    // group on wide layouts where the thread sits beside the list.
    const wide = window.matchMedia ? window.matchMedia('(min-width: 761px)').matches : true;
    if (wide && activeGroupId && groupsList.some((g) => g.id === activeGroupId)) {
        await openGroup(activeGroupId);
    }
}

// ---------- Create group ----------

window.openCreateGroupDialog = async function () {
    const { panel, close } = openDialog({ label: 'Create group' });
    const selected = new Set();
    let users = [];

    panel.innerHTML = `
        <h3>New group</h3>
        <input type="text" id="new-group-name" placeholder="Group name" maxlength="100" class="input grp-name-input" autocomplete="off">
        <div class="grp-picker-label">Add people <span class="grp-picker-count" id="new-group-count"></span></div>
        <div class="conv-search-wrap grp-picker-search">
            <span class="conv-search-icon">${ICONS.search}</span>
            <input type="text" class="conv-search-input" id="new-group-search" placeholder="Search people…" autocomplete="off">
        </div>
        <div class="grp-picker-list" id="new-group-list">${loadingState()}</div>
        <div class="grp-dialog-actions">
            <button type="button" class="btn btn-ghost" id="new-group-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="new-group-create">Create</button>
        </div>
    `;

    const listEl = panel.querySelector('#new-group-list');
    const countEl = panel.querySelector('#new-group-count');
    const searchEl = panel.querySelector('#new-group-search');
    const meId = Number(getCurrentUser()?.id);

    function paintPeople() {
        const q = searchEl.value.trim().toLowerCase();
        const rows = users.filter((u) => !q || String(u.username || '').toLowerCase().includes(q));
        countEl.textContent = selected.size ? `· ${selected.size} selected` : '';
        if (rows.length === 0) {
            listEl.innerHTML = emptyState(ICONS.users, q ? 'No matches' : 'No one to add yet', q ? '' : 'You can add people later from group settings.');
            return;
        }
        listEl.innerHTML = rows
            .map((u) => `
                <div class="dm-picker-row grp-picker-row${selected.has(Number(u.id)) ? ' selected' : ''}" role="option" tabindex="0" aria-selected="${selected.has(Number(u.id))}" data-user-id="${Number(u.id)}">
                    ${avatarHtml(u.id, u.username, 'conv-avatar dm-picker-avatar')}
                    <div class="dm-picker-info"><div class="dm-picker-name">${escapeHtml(u.username)}</div></div>
                    <span class="grp-picker-check">${ICONS.check || '✓'}</span>
                </div>
            `)
            .join('');
    }

    function toggleRow(row) {
        const id = Number(row.dataset.userId);
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        paintPeople();
    }

    listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.grp-picker-row');
        if (row) toggleRow(row);
    });
    listEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.grp-picker-row');
        if (row) { e.preventDefault(); toggleRow(row); const again = listEl.querySelector(`[data-user-id="${row.dataset.userId}"]`); again?.focus(); }
    });
    searchEl.addEventListener('input', paintPeople);

    panel.querySelector('#new-group-cancel').addEventListener('click', close);

    const createBtn = panel.querySelector('#new-group-create');
    createBtn.addEventListener('click', async () => {
        const name = panel.querySelector('#new-group-name').value.trim();
        if (!name) {
            showToast('Group name is required', 'error');
            return;
        }

        createBtn.disabled = true;
        try {
            const group = await api('/api/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });

            const failed = [];
            for (const userId of selected) {
                try {
                    await api(`/api/groups/${group.id}/members`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: userId }),
                    });
                } catch {
                    failed.push(userId);
                }
            }
            if (failed.length) showToast(`Couldn't add ${failed.length} ${failed.length === 1 ? 'person' : 'people'}`, 'error');

            close();
            await loadGroupsList();
            await openGroup(group.id);
        } catch (e) {
            createBtn.disabled = false;
            showToast(e.message, 'error');
        }
    });

    panel.querySelector('#new-group-name').focus();

    try {
        const all = await api('/api/share/users');
        users = all.filter((u) => Number(u.id) !== meId);
    } catch (e) {
        listEl.innerHTML = emptyState(ICONS.empty, 'Couldn’t load people', escapeHtml(e.message));
        return;
    }
    paintPeople();
};

// The app's CSP has no 'unsafe-inline' in script-src, so inline
// onclick="" attributes are silently dropped by the browser: "+ New",
// Send, Emoji and Manage-group were all dead in a real browser (audit
// CSP finding). Delegated instead, same as dm.js.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action^="group-"]');
    if (!btn) return;

    switch (btn.dataset.action) {
        case 'group-new':
            window.openCreateGroupDialog();
            break;
        case 'group-back':
            document.querySelector('.dm-layout')?.classList.remove('showing-thread');
            break;
        case 'group-send':
            window.sendGroupMessage();
            break;
        case 'group-emoji':
            window.openGroupEmojiPicker(btn);
            break;
        case 'group-settings':
            window.openGroupSettings(Number(btn.dataset.groupId));
            break;
    }
});

// ---------- Group settings / members ----------

window.openGroupSettings = async function (groupId) {
    if (!groupId) return;

    let allUsers = null;
    try {
        allUsers = await api('/api/share/users');
    } catch {
        allUsers = [];
    }

    const membership = myMembership(groupId);
    const canManage = membership && isElevated(membership.role);

    const { panel, close } = openDialog({ label: 'Group settings' });

    function renderPanel() {
        const memberIds = new Set(activeGroupMembers.map((m) => Number(m.user_id)));
        const addable = allUsers.filter((u) => !memberIds.has(Number(u.id)));

        panel.innerHTML = `
            <h3>Group members</h3>
            <div class="member-list grp-member-list">
                ${activeGroupMembers
                    .map((m) => `
                        <div class="member-row grp-member-row">
                            ${avatarHtml(m.user_id, m.username, 'conv-avatar', false, true)}
                            <div class="grp-member-main">
                                <div>${escapeHtml(m.username)}</div>
                                <div class="text-muted grp-member-role">${escapeHtml(m.role)}</div>
                            </div>
                            ${canManage && m.role !== 'owner'
                                ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-user="${Number(m.user_id)}">Remove</button>`
                                : ''}
                        </div>
                    `)
                    .join('')}
            </div>
            ${canManage
                ? `
                    <h4>Add member</h4>
                    <select id="add-member-select" class="input grp-add-select">
                        <option value="">Choose someone…</option>
                        ${addable.map((u) => `<option value="${Number(u.id)}">${escapeHtml(u.username)}</option>`).join('')}
                    </select>
                    <button type="button" class="btn btn-primary btn-sm" id="add-member-btn">Add</button>
                `
                : ''}
            <div class="grp-settings-footer">
                <button type="button" class="btn btn-ghost" id="leave-group-btn">Leave group</button>
                <button type="button" class="btn btn-ghost" id="group-settings-close">Close</button>
            </div>
        `;

        panel.querySelector('#group-settings-close').addEventListener('click', close);

        panel.querySelectorAll('[data-remove-user]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const userId = btn.dataset.removeUser;
                const confirmed = await confirmInDialog(panel, 'Remove this member from the group?', { title: 'Remove member' });
                if (!confirmed) return;
                try {
                    await api(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
                    await loadMembers(groupId);
                    renderMemberBar();
                    renderPanel();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        });

        const addBtn = panel.querySelector('#add-member-btn');
        if (addBtn) {
            addBtn.addEventListener('click', async () => {
                const select = panel.querySelector('#add-member-select');
                const userId = Number(select.value);
                if (!Number.isInteger(userId) || userId <= 0) return;
                try {
                    await api(`/api/groups/${groupId}/members`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: userId }),
                    });
                    await loadMembers(groupId);
                    renderMemberBar();
                    renderPanel();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        }

        const leaveBtn = panel.querySelector('#leave-group-btn');
        leaveBtn.addEventListener('click', async () => {
            const confirmed = await confirmInDialog(panel, 'Leave this group?', { title: 'Leave group', confirmText: 'Leave' });
            if (!confirmed) return;
            try {
                await api(`/api/groups/${groupId}/leave`, { method: 'POST' });
                close();
                await forgetGroupKeys(groupId);
                groupThreads.delete(groupId);
                membershipByGroupId.delete(groupId);
                if (activeGroupId === groupId) activeGroupId = null;
                await loadGroupsList();
                await showGroups();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    }

    renderPanel();
};

// ---------- Socket-driven handlers (wired from core/socket.js) ----------

export function addGroupMessage(msg) {
    const thread = groupThreads.get(msg.group_id);
    if (!thread) return; // haven't opened this group this session — nothing to render into
    void thread.addLiveMessage(msg);
}

export function removeGroupMessage(groupId, id) {
    const thread = groupThreads.get(groupId);
    if (!thread) return;
    thread.removeMessage(id);
}

export function applyGroupReactionUpdate(groupId, messageId, reactions) {
    const thread = groupThreads.get(groupId);
    if (!thread) return;
    thread.applyReactionUpdate(messageId, reactions);
}

/**
 * A membership change landed for a group (someone added/removed, or
 * this device itself was removed/left). See rotation.js and
 * group-message-crypto.js's ensureSenderKeyForGroup: the *server*
 * side of rotation (bumping key_epoch) already happened; this is
 * where the *client* side (generating+distributing a fresh Sender
 * Key, if I'm still a remaining member) actually runs.
 */
export async function handleGroupMembershipChanged(payload) {
    const { group_id, type, user_id, user_ids } = payload || {};
    if (!group_id) return;

    const currentUser = getCurrentUser();
    const iWasRemoved = type === 'removed' && Number(user_id) === Number(currentUser?.id);

    if (iWasRemoved) {
        await forgetGroupKeys(group_id);
        groupThreads.delete(group_id);
        membershipByGroupId.delete(group_id);
        if (activeGroupId === group_id) {
            activeGroupId = null;
            showToast("You're no longer a member of this group", 'info');
        }
        await loadGroupsList();
        if (document.getElementById('group-list')) await showGroups();
        return;
    }

    // I was just added: the group is not in my list yet (it was fetched
    // before), so refresh it or the user has to reload the page to see it.
    const iWasAdded = type === 'added'
        && Array.isArray(user_ids)
        && user_ids.some((id) => Number(id) === Number(currentUser?.id));
    if (iWasAdded) await loadGroupsList();

    let members;
    try {
        members = await loadMembers(group_id);
    } catch (e) {
        console.error('[group] failed to refresh membership after change:', e);
        return;
    }

    if (group_id === activeGroupId) renderMemberBar();

    // Any membership change bumps the group's key epoch on the server
    // (add AND remove). Rotate + redistribute to the CURRENT member list
    // so a newcomer gets a key they can use and a removed member does
    // not. ensureSenderKeyForGroup is a no-op if we're already current.
    if (type === 'removed' || type === 'added') {
        await ensureSenderKeyReady(group_id, members, { quiet: true });
    }
}

export async function handleGroupKdmDelivered(payload) {
    const groupId = payload?.group_id;
    if (!groupId) return;
    try {
        await drainAndRetry(groupId);
    } catch (e) {
        console.error('[group] KDM drain (on notify) failed:', e);
    }
}

/**
 * Socket (re)connected. Live events are not replayed after a gap longer
 * than the server's recovery window (or a server restart), so pull what
 * was missed: any undelivered KDMs, then messages newer than what the
 * open thread has. Before this, a dropped connection silently lost
 * messages until the user re-opened the group.
 */
export async function handleGroupSocketConnected() {
    if (!groupsLoaded) return;
    try {
        await drainGroupKdms();

        // Membership changes are only announced over the socket, so any that
        // happened while we were offline were missed. Each one bumped the
        // group's key epoch and every remaining member is expected to rotate
        // and redistribute; if this device never learns of it, the member who
        // joined while we were away can never read anything we send (they
        // just see "Waiting for encryption key"). Refresh my membership rows
        // (they carry key_epoch) and re-run the same check the live
        // membership handler does, for every group opened this session.
        try { await loadGroupsList(); } catch (e) { console.error('[group] refresh after reconnect failed:', e); }

        for (const [gid, thread] of groupThreads) {
            if (!myMembership(gid)) continue; // no longer a member
            try {
                const members = await loadMembers(gid);
                await ensureSenderKeyReady(gid, members, { quiet: true });
            } catch (e) {
                console.error('[group] key check after reconnect failed:', e);
            }
            await thread.retryPlaceholders();
            if (gid === activeGroupId) await thread.syncSince();
        }
    } catch (e) {
        console.error('[group] resync after (re)connect failed:', e);
    }
}

export function handleGroupUpdated(payload) {
    const group = groupsList.find((g) => g.id === payload?.group_id);
    if (group) {
        if (payload.name) group.name = payload.name;
        if (payload.avatar_path) group.avatar_path = payload.avatar_path;
        paintGroupList();
    }
    if (payload?.group_id === activeGroupId) {
        // Rebuilding the shell replaces the whole panel, including the
        // message list and composer; put the thread back afterwards.
        renderActiveGroupShell(group);
        renderMemberBar();
        groupThreads.get(activeGroupId)?.paintFromCache();
    }
}
