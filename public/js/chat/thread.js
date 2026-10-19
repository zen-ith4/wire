// public/js/chat/thread.js
//
// Shared message-thread logic extracted from chat.js and dm.js
// (plan_prompt.md Phase 3), verified line-by-line against both
// sources rather than assumed — see the per-function notes below for
// exactly what was identical, what diverged and became a config
// option, and what was deliberately NOT extracted.
//
// One thread instance = one paginated message list backed by one
// cache entry. A consumer with multiple simultaneous lists (dm.js's
// per-peer conversations; group.js's per-group threads) creates one
// instance per key and swaps which one is "active"/mounted itself —
// this module only knows about rendering whichever single cache it's
// given into whichever single container id it's given.
//
// NOT extracted (deliberately, not an oversight):
// - chat.js's reconcileChat(): a full gap/deletion/reaction-diff
//   reconciliation against a freshly-fetched window. dm.js's
//   syncDmMessagesSince() is a materially simpler "fetch anything
//   newer, append it" strategy — these are different algorithms, not
//   a cosmetic difference. This module implements only the simpler
//   (DM-style) one as `syncSince`; a thread that wants chat.js's
//   fuller reconciliation still needs its own logic for that, same
//   as chat.js has today.

import { getCurrentUser } from '../core/auth.js';
import {
    escapeHtml,
    escapeHtmlAttr,
    linkifyHtml,
    emptyState,
    showToast,
    animateRemoval,
    formatDate,
} from '../core/utils.js';
import { ICONS } from '../icons.js';
import { avatarHtml } from '../ui/avatar.js';
import { showConfirm } from '../ui/confirm.js';
import { renderReactionsRow, updateMessageReactions } from './reactions.js';
import { buildReplyQuoteHtml, buildReplyPreview } from './reply.js';
import { setMessageAccent } from './message-accent.js';
import {
    cleanupImageUrls,
    revokeAttachmentImage,
} from '../media/attachments.js';

// Group attachments are not wired in the client in this port (see
// docs/PORT_NOTES.md): the composer has no file input here and
// media/attachments.js -- left untouched, it serves chat/DM -- has no 'group'
// branch. Its shared card (renderAttachment) carries an inline onclick=""
// download handler, which a strict CSP drops, and would try to fetch an
// encrypted group body as a plain file. So a group message that somehow
// carries an attachment (server rows are always ciphertext; a modified client
// could still post one) is shown as an inert, non-interactive note, and the
// filename -- uploader-controlled -- is escaped as text.
function unsupportedAttachmentHtml(msg) {
    const name = msg.attachment_name ? escapeHtml(String(msg.attachment_name)) : 'attachment';
    return `<div class="chat-attachment chat-attachment-unsupported">
        <span class="chat-attachment-name">${name}</span>
        <em>(attachments aren't available in groups yet)</em>
    </div>`;
}

// Local copy of Y's media/attachments.js helper. This X tree's
// attachments.js has no such export and is intentionally left untouched
// (DM attachment path stays exactly as X ships it). Same behaviour: revoke
// the blob: URL recorded on any <audio>/<video> under `root`. Group
// attachments are not wired in the UI yet, so today this finds nothing.
function revokeMediaPlayerBlobUrls(root) {
    if (!root) {
        return;
    }

    const selector = 'audio[data-blob-url], video[data-blob-url]';

    const els = [
        ...(root.matches?.(selector) ? [root] : []),
        ...root.querySelectorAll(selector),
    ];

    for (const el of els) {
        const url = el.dataset.blobUrl;

        if (!url) {
            continue;
        }

        URL.revokeObjectURL(url);
        delete el.dataset.blobUrl;
    }
}

// scope -> thread instance, so the single set of window.thread*
// delegate handlers below can dispatch to whichever thread a click
// came from (replaces chat.js's window.replyToChatMessage/
// deleteChatMessage and dm.js's window.replyToDmMessage/
// deleteDmMessage with one shared pair instead of a third copy for
// group.js).
const registry = new Map();

/**
 * @param {object} config
 * @param {string} config.scope 'chat' | 'dm' | 'group' — passed
 *   straight through to reactions.js/reply.js/media/attachments.js,
 *   which already key their own container-id maps and (for
 *   attachments) URL construction by this same string. See
 *   reactions.js's setActiveGroupIdGetter for why 'group' needs one
 *   extra piece of wiring those other two scopes don't.
 * @param {string} config.containerId DOM id of the scrollable list
 * @param {{icon: string, title: string, subtitle: string}|() => object} config.emptyStateConfig
 * @param {(limit: number) => Promise<object[]>} config.fetchRecent
 * @param {(before: string, limit: number) => Promise<object[]>} config.fetchBefore
 * @param {(since: string, limit: number) => Promise<object[]>} [config.fetchSince]
 *   omit to skip reconciliation entirely (caller re-fetches instead)
 * @param {(raw: object[]) => Promise<object[]>} [config.decorate]
 *   identity by default. For DM/group this is where decryption
 *   happens; may reject (see onDecorateError for the live-arrival
 *   path — a batch-level failure here just toasts and returns []).
 * @param {(error: Error, raw: object) => {html: string}|null} [config.onDecorateError]
 *   called when decorating ONE live-arriving message fails (e.g. a
 *   group message whose Sender Key hasn't been received yet). Return
 *   {html} to render a placeholder bubble, or null/omit to silently
 *   drop the message — matches dm.js's current "never let ciphertext
 *   reach the DOM" behavior.
 * @param {(msg: object) => number} [config.getSenderId] default: msg.sender_id
 * @param {(msg: object) => string} [config.getSenderName] default: msg.sender_username
 * @param {(msg: object, currentUser: object) => boolean} config.canDelete
 *   REQUIRED, not defaulted — chat.js and dm.js happen to agree
 *   (own || currentUser.is_admin) but a group's real rule also
 *   depends on group role, a dimension neither of those has, so
 *   there is no safe shared default to fall back to.
 * @param {(id: number) => Promise<void>} config.deleteMessage DELETE call
 * @param {() => object|null} [config.getComposer] returns the
 *   createComposer() instance, for setReplyTo wiring
 * @param {() => boolean} [config.isMounted] is THIS thread the one
 *   currently shown in `containerId`? Several threads share one
 *   container id (one per group), so anything that draws into the DOM
 *   must check it, or a message for group A gets painted into group
 *   B's visible list (audit F-E). Defaults to true (chat/dm style
 *   single-thread consumers). Cache updates happen either way.
 */
export function createMessageThread(config) {
    const {
        scope,
        containerId,
        emptyStateConfig,
        fetchRecent,
        fetchBefore,
        fetchSince,
        decorate = async (raw) => raw,
        onDecorateError = null,
        getSenderId = (m) => m.sender_id,
        getSenderName = (m) => m.sender_username,
        canDelete,
        deleteMessage: deleteMessageApi,
        getComposer = () => null,
        isMounted = () => true,
    } = config;

    if (!scope || !containerId || !fetchRecent || !fetchBefore || !deleteMessageApi || !canDelete) {
        throw new Error('createMessageThread: missing required config');
    }

    // Same shape dm.js already keeps per peer in dmCache — lifted out
    // so chat's single global cache and group's per-group caches are
    // the same code path instead of hand-maintained copies. Includes
    // dm.js's loadingOlder reentrancy guard and atBottom/scrollTop
    // position memory, which chat.js's equivalent lacked — chat.js
    // degenerates to the same visible behavior either way (it's
    // always freshly loaded, so always "at bottom"), so adopting
    // DM's more careful version isn't a behavior change for chat.
    const cache = {
        messages: [],
        byId: new Map(),
        ids: new Set(),
        hasMore: true,
        oldest: null,
        // Newest server timestamp this thread has SEEN, whether or not the
        // message was decryptable/visible. It is the reconnect-sync cursor.
        // (Deriving it from visible messages meant an empty thread, or one
        // whose latest rows were undecryptable, never caught up: audit R-6.)
        newest: null,
        atBottom: true,
        scrollTop: 0,
        loadingOlder: false,
        initialized: false, // has this thread ever been loaded before
    };

    function container() {
        return document.getElementById(containerId);
    }

    const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

    // Advance the reconnect-sync cursor. ISO-8601 timestamps of one format
    // order lexicographically, so string comparison is enough.
    function noteSeen(ts) {
        if (typeof ts === 'string' && ts && (!cache.newest || ts > cache.newest)) cache.newest = ts;
    }

    // ---------- Rendering ----------
    // Verified line-by-line against chat.js's buildChatMessageEl and
    // dm.js's buildDmMessageEl, which are identical apart from field
    // names (user_id/username vs sender_id/sender_username, handled
    // by getSenderId/getSenderName) and the canDelete rule (handled
    // by the required config.canDelete).

    function buildMessageEl(msg) {
        // A message we could not decrypt yet must NEVER fall through to
        // the normal path below: msg.content is still the raw ciphertext
        // envelope, and paintFromCache()/loadOlder() re-render cached
        // messages (audit F-D).
        if (msg.__placeholder) return placeholderEl(msg.id, msg.__placeholderHtml);

        const currentUser = getCurrentUser();
        const senderId = getSenderId(msg);
        const senderName = getSenderName(msg);
        const own = currentUser && Number(senderId) === Number(currentUser.id);
        const allowDelete = canDelete(msg, currentUser);

        const div = document.createElement('div');
        div.className = `chat-msg${own ? ' own' : ''}`;
        div.dataset.msgId = msg.id;

        // Every bubble uses the CURRENT VIEWER's own accent color,
        // not the sender's — see message-accent.js's doc comment.
        setMessageAccent(div);

        const messageText = msg.content == null ? '' : String(msg.content);

        div.innerHTML = `
            ${avatarHtml(senderId, senderName, 'chat-avatar', false, true)}
            <div class="chat-msg-content">
                <div class="chat-meta">
                    <span class="chat-sender">${escapeHtml(senderName || '')}</span>
                    <span class="chat-time">${formatDate(msg.timestamp)}</span>
                    ${getComposer() ? `<button type="button" class="chat-msg-reply" title="Reply" data-action="thread-reply" data-scope="${escapeHtmlAttr(scope)}" data-msg-id="${Number(msg.id)}">${ICONS.reply}</button>` : ''}
                    ${allowDelete ? `<button type="button" class="chat-msg-delete" title="Delete message" data-action="thread-delete" data-scope="${escapeHtmlAttr(scope)}" data-msg-id="${Number(msg.id)}">${ICONS.trash}</button>` : ''}
                </div>
                ${buildReplyQuoteHtml(msg, scope)}
                ${messageText ? `<div class="chat-bubble">${linkifyHtml(messageText)}</div>` : ''}
                ${msg.has_attachment ? (msg.__groupAttachmentHtml || unsupportedAttachmentHtml(msg)) : ''}
                ${renderReactionsRow(msg, scope)}
            </div>
        `;

        return div;
    }

    function buildLoadMoreEl(onClick) {
        const row = document.createElement('div');
        row.className = 'load-more-row';
        row.id = 'chat-load-more-row'; // literal, shared id — only one thread is ever mounted at a time, same as chat.js/dm.js today
        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.textContent = 'Load older messages';
        btn.onclick = onClick;
        row.appendChild(btn);
        return row;
    }

    function renderEmptyState() {
        const el = container();
        if (!el) return;
        const cfg = typeof emptyStateConfig === 'function' ? emptyStateConfig() : emptyStateConfig;
        const { icon = ICONS.chat, title = 'No messages yet', subtitle = '' } = cfg || {};
        el.innerHTML = emptyState(icon, title, subtitle);
    }

    function paintFromCache() {
        const el = container();
        if (!el || !isMounted()) return;

        cleanupImageUrls(el, scope);

        if (cache.messages.length === 0) {
            renderEmptyState();
            // A full page may still have had nothing we could decrypt;
            // keep offering older history instead of dead-ending.
            if (cache.hasMore && cache.oldest) el.insertBefore(buildLoadMoreEl(loadOlder), el.firstChild);
            else cache.hasMore = false;
            return;
        }

        const frag = document.createDocumentFragment();

        if (cache.hasMore) {
            frag.appendChild(buildLoadMoreEl(loadOlder));
        }

        for (const msg of cache.messages) {
            frag.appendChild(buildMessageEl(msg));
        }

        el.innerHTML = '';
        el.appendChild(frag);

        el.scrollTop = cache.atBottom ? el.scrollHeight : cache.scrollTop;
    }

    // ---------- Fetch / decorate ----------

    async function safeDecorate(raw) {
        try {
            return await decorate(raw);
        } catch (e) {
            console.error(`[thread:${scope}] failed to decorate message batch:`, e);
            showToast('Some messages could not be decrypted', 'error');
            return [];
        }
    }

    async function loadRecent() {
        const el = container();

        try {
            const raw = await fetchRecent(50);
            const decorated = await safeDecorate(raw);

            cache.messages = [];
            cache.byId.clear();
            cache.ids.clear();
            cache.initialized = true;

            for (const msg of decorated) {
                cache.ids.add(msg.id);
                cache.byId.set(msg.id, msg);
                cache.messages.push(msg);
            }

            // Pagination is about what the SERVER returned, not what we
            // managed to decrypt: messages dropped as undecryptable must
            // not shrink the page count (that silently disabled "load
            // older") or move the cursor past history (audit F-C).
            if (raw.length > 0) {
                cache.oldest = raw[0].timestamp;
                cache.hasMore = raw.length >= 50;
                noteSeen(raw[raw.length - 1].timestamp);
            } else {
                cache.hasMore = false;
                // Loaded empty: everything that exists from now on is new.
                noteSeen(EPOCH_ISO);
            }

            cache.atBottom = true;
            paintFromCache();

            // Live messages that arrived while this first load was in
            // flight were parked (see addLiveMessage); replay them now.
            for (const m of earlyLive.splice(0)) await addLiveMessage(m);
        } catch (e) {
            if (el && isMounted()) el.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
        }
    }

    async function loadOlder() {
        if (cache.loadingOlder || !cache.hasMore || !cache.oldest) return;

        const el = container();
        const btnRow = document.getElementById('chat-load-more-row');
        if (btnRow) btnRow.querySelector('.load-more-btn').textContent = 'Loading…';

        cache.loadingOlder = true;

        try {
            const raw = await fetchBefore(cache.oldest, 50);
            cache.loadingOlder = false;

            // The load-more row has ONE shared literal id (only one thread is
            // mounted at a time), so it belongs to whichever thread is on
            // screen NOW. If the user switched threads while this request was
            // in flight, that row is someone else's: leave it alone and just
            // keep the fetched page in THIS thread's cache (audit R-2).
            const mountedNow = isMounted();
            const btnRow2 = mountedNow ? document.getElementById('chat-load-more-row') : null;
            if (mountedNow && !btnRow2) return; // stale: thread was repainted meanwhile
            btnRow2?.remove();

            if (raw.length === 0) {
                cache.hasMore = false;
                return;
            }

            const decorated = await safeDecorate(raw);
            const fresh = decorated.filter((m) => !cache.ids.has(m.id));

            cache.oldest = raw[0].timestamp;
            cache.hasMore = raw.length >= 50;

            const oldTop = el ? el.scrollTop : 0;
            const prevHeight = el ? el.scrollHeight : 0;

            const frag = document.createDocumentFragment();
            if (cache.hasMore) frag.appendChild(buildLoadMoreEl(loadOlder));

            for (const msg of fresh) {
                cache.ids.add(msg.id);
                cache.byId.set(msg.id, msg);
                frag.appendChild(buildMessageEl(msg));
            }

            cache.messages = [...fresh, ...cache.messages];

            if (el && isMounted()) {
                if (fresh.length > 0) el.querySelector('.empty-state')?.remove();
                el.insertBefore(frag, el.firstChild);
                el.scrollTop = oldTop + (el.scrollHeight - prevHeight);
            }
        } catch (e) {
            cache.loadingOlder = false;
            const btnRow3 = isMounted() ? document.getElementById('chat-load-more-row') : null;
            if (btnRow3) btnRow3.querySelector('.load-more-btn').textContent = 'Load older messages';
            showToast(e.message, 'error');
        }
    }

    /**
     * Reconciliation for reconnect/re-open — pulls anything newer
     * than the latest cached message and appends it. This is dm.js's
     * syncDmMessagesSince() strategy specifically (see this file's
     * top-of-file note on why chat.js's fuller reconcileChat() isn't
     * extracted here).
     */
    async function syncSince() {
        // Not loaded yet -> nothing to catch up on (the first load fetches it all).
        if (!fetchSince || !cache.initialized) return;

        const lastVisible = cache.messages.length
            ? cache.messages[cache.messages.length - 1].timestamp
            : null;
        const latest = [lastVisible, cache.newest, EPOCH_ISO]
            .filter(Boolean)
            .reduce((a, b) => (a > b ? a : b));

        try {
            const raw = await fetchSince(latest, 100);
            if (raw.length === 0) return;

            for (const rawMsg of raw) {
                await addLiveMessage(rawMsg);
            }
        } catch (e) {
            console.error(`[thread:${scope}] sync failed:`, e);
        }
    }

    // ---------- Live message arrival (socket) ----------

    function placeholderEl(id, html) {
        const div = document.createElement('div');
        div.className = 'chat-msg';
        div.dataset.msgId = id;
        div.innerHTML = `<div class="chat-msg-content"><div class="chat-bubble">${html}</div></div>`;
        return div;
    }

    // Ids currently being decrypted, so the same message arriving twice
    // at once (socket event + syncSince after a reconnect) is rendered
    // once. cache.ids is only updated AFTER the async decrypt, so it
    // alone cannot guard that window.
    const inflight = new Set();
    // Live messages that arrive before the first loadRecent() finished.
    const earlyLive = [];

    async function addLiveMessage(rawMsg) {
        if (cache.ids.has(rawMsg.id) || inflight.has(rawMsg.id)) return;
        noteSeen(rawMsg.timestamp);

        if (!cache.initialized) {
            earlyLive.push(rawMsg);
            return;
        }

        inflight.add(rawMsg.id);
        try {
            await addLiveMessageInner(rawMsg);
        } finally {
            inflight.delete(rawMsg.id);
        }
    }

    async function addLiveMessageInner(rawMsg) {
        let decorated = null;
        let placeholder = null;

        try {
            // {live:true}: a decrypt failure must REJECT here so
            // onDecorateError can turn it into a placeholder. The bulk
            // path swallows per-message failures instead (see group.js).
            [decorated] = await decorate([rawMsg], { live: true });
            if (!decorated) return;
        } catch (e) {
            if (onDecorateError) placeholder = onDecorateError(e, rawMsg);

            if (!placeholder) {
                console.error(`[thread:${scope}] dropped undecodable message ${rawMsg.id}:`, e);
                return;
            }
        }

        const finalMsg = decorated || {
            ...rawMsg,
            __placeholder: true,
            __placeholderHtml: placeholder.html,
            __permanent: placeholder.permanent === true,
            __raw: rawMsg,
        };

        cache.ids.add(rawMsg.id);
        cache.byId.set(rawMsg.id, finalMsg);
        cache.messages.push(finalMsg);

        // Only draw if this thread is the one on screen; otherwise it is
        // repainted from cache when the user opens it (audit F-E).
        if (!isMounted()) return;

        const el = container();
        if (!el) return;

        const emptyEl = el.querySelector('.empty-state');
        if (emptyEl) el.innerHTML = '';

        const node = buildMessageEl(finalMsg);
        node.classList.add('msg-enter');
        el.appendChild(node);

        const currentUser = getCurrentUser();
        const isOwn = decorated && Number(getSenderId(decorated)) === Number(currentUser?.id);

        if (cache.atBottom || isOwn) {
            el.scrollTop = el.scrollHeight;
            cache.atBottom = true;
        }
    }

    /**
     * Re-attempts decryption of messages that were shown as "waiting
     * for key" placeholders — call after a key delivery lands. Before
     * this existed a placeholder was permanent (its id was already in
     * cache.ids, so syncSince/reconnect skipped it). Replaces the
     * cached entry and, if drawn, the DOM node in place.
     */
    async function retryPlaceholders() {
        // A PERMANENT placeholder (e.g. "could not be verified") is never retried: only
        // "key not arrived" is.
        const pending = cache.messages.filter((m) => m.__placeholder && !m.__permanent);
        let resolved = 0;

        for (const ph of pending) {
            let decorated = null;
            try {
                [decorated] = await decorate([ph.__raw], { live: true });
            } catch (e) {
                // The key arrived but turned out to be unusable for verification: the
                // message becomes a permanent unverified placeholder instead of waiting
                // for a key forever.
                if (e?.permanent === true && onDecorateError) {
                    const permanent = onDecorateError(e, ph.__raw);
                    if (permanent?.permanent) {
                        const idx = cache.messages.findIndex((m) => m.id === ph.id);
                        if (idx !== -1) {
                            const next = { ...ph, __placeholderHtml: permanent.html, __permanent: true };
                            cache.messages[idx] = next;
                            cache.byId.set(ph.id, next);
                            const el = container();
                            if (el && isMounted()) {
                                const old = el.querySelector(`.chat-msg[data-msg-id="${Number(ph.id)}"]`);
                                if (old) old.replaceWith(buildMessageEl(next));
                            }
                        }
                    }
                }
                continue; // still no key (or unreadable) — keep the placeholder
            }
            if (!decorated) continue;

            const idx = cache.messages.findIndex((m) => m.id === ph.id);
            if (idx === -1) continue;

            cache.messages[idx] = decorated;
            cache.byId.set(ph.id, decorated);
            resolved++;

            const el = container();
            if (el && isMounted()) {
                const old = el.querySelector(`.chat-msg[data-msg-id="${Number(ph.id)}"]`);
                if (old) old.replaceWith(buildMessageEl(decorated));
            }
        }

        return resolved;
    }

    function removeMessage(id) {
        cache.ids.delete(id);
        cache.byId.delete(id);
        cache.messages = cache.messages.filter((m) => m.id !== id);

        const el = container();
        if (!el) {
            revokeAttachmentImage(id, scope);
            return;
        }

        const node = el.querySelector(`.chat-msg[data-msg-id="${id}"]`);
        if (!node) return;

        cleanupImageUrls(node, scope);
        revokeAttachmentImage(id, scope);
        revokeMediaPlayerBlobUrls(node);
        animateRemoval(node, () => {
            if (!el.querySelector('.chat-msg')) renderEmptyState();
        });
    }

    // ---------- Public instance ----------

    const instance = {
        scope,
        cache,
        loadRecent,
        loadOlder,
        syncSince,
        paintFromCache,
        addLiveMessage,
        retryPlaceholders,
        removeMessage,
        getMessageById: (id) => cache.byId.get(id),

        // Called by the socket handler for 'chat-reaction-update' /
        // 'dm-reaction-update' / 'group-reaction-update' —
        // updateMessageReactions() already knows how to find and
        // patch the right DOM node for `scope`, so this just keeps
        // the cached copy in sync too.
        applyReactionUpdate(messageId, reactions) {
            const msg = cache.byId.get(messageId);
            if (msg) msg.reactions = reactions;
            updateMessageReactions(scope, messageId, reactions);
        },

        setScrollState(atBottom, scrollTop) {
            cache.atBottom = atBottom;
            cache.scrollTop = scrollTop;
        },

        replyTo(id) {
            const msg = cache.byId.get(id);
            const composer = getComposer();
            if (!msg || !composer) return;
            composer.setReplyTo(buildReplyPreview(msg));
        },

        async deleteMessage(id) {
            const confirmed = await showConfirm(
                'Delete this message? This cannot be undone.',
                { title: 'Delete message' }
            );
            if (!confirmed) return;

            try {
                await deleteMessageApi(id);
                removeMessage(id);
            } catch (e) {
                showToast(e.message, 'error');
            }
        },

        // The registry has ONE slot per scope, but group.js keeps one
        // thread per group for the whole session. Creating a second
        // group's thread overwrites the first's slot, so without this
        // a cached, previously-visited group would have its Reply /
        // Delete buttons dispatched to whichever thread was created
        // LAST (Delete would hit the wrong group's endpoint). Call this
        // whenever this thread becomes the visible one.
        activate() {
            registry.set(scope, instance);
        },

        destroy() {
            // Audio/video/voice players have no cross-render cache
            // (unlike images — see revokeMediaPlayerBlobUrls's doc
            // comment in media/attachments.js), so anything still
            // mounted right now needs its blob: URL revoked before
            // this thread's DOM goes away for good.
            revokeMediaPlayerBlobUrls(container());
            if (registry.get(scope) === instance) registry.delete(scope);
        },
    };

    registry.set(scope, instance);
    return instance;
}

// ---------- Shared window-level delegates ----------
// One pair of globals regardless of how many scopes are registered,
// dispatching by the scope baked into the onclick string — replaces
// chat.js's window.replyToChatMessage/deleteChatMessage and dm.js's
// window.replyToDmMessage/deleteDmMessage, so group.js doesn't need
// a third pair.

window.threadReply = function (scope, id) {
    registry.get(scope)?.replyTo(id);
};

window.threadDelete = function (scope, id) {
    registry.get(scope)?.deleteMessage(id);
};

// The app's CSP has no 'unsafe-inline' in script-src, which silently
// drops inline onclick="" attributes — the reply/delete buttons used to
// be inert in a real browser (audit CSP finding). Delegated instead,
// like dm.js/reactions.js/reply.js.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="thread-reply"], [data-action="thread-delete"]');
    if (!btn) return;
    const { action, scope, msgId } = btn.dataset;
    if (action === 'thread-reply') window.threadReply(scope, Number(msgId));
    else window.threadDelete(scope, Number(msgId));
});

/**
 * Byte-identical in chat.js and dm.js today — lifted out so group.js
 * doesn't need a third copy. Attaches a paste listener to a text
 * input; hands any pasted image file to `addFn` (a composer's
 * addFiles-style callback).
 */
export function wirePasteImage(inputId, addFn) {
    const input = document.getElementById(inputId);
    if (!input) return;

    input.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (!blob) continue;
                const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type });
                addFn(file);
                return;
            }
        }
    });
}
