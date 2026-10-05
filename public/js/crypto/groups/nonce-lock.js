// public/js/crypto/groups/nonce-lock.js
//
// plan_prompt.md 2.2: per-Sender-Key message counters must never be
// reused, and the realistic failure mode is two tabs on the same
// account/device racing to send at the same time. The lock name is
// derived from the Sender Key's own id, so a freshly rotated key
// (new id) automatically starts under its own lock with no
// continuity to the old key's counter/lock.
//
// Lock scope is deliberately narrow: read current counter -> persist
// current+1 -> release. Encryption happens *after* this resolves,
// using the value this function reserved — a slow encrypt never
// blocks another tab's send, and two tabs can never be handed the
// same counter value, because the value is durably persisted before
// the lock is released, not after encryption finishes.

import { readCounter, writeCounter } from './sender-key-store.js';

// F10: the 4-byte nonce prefix is random and lives in MEMORY ONLY. It is drawn
// lazily on first use in every JS process (page load, tab, app start) and
// redrawn after every identity lock/unlock (sender-key.js clearSenderKeyCache
// calls resetNoncePrefix). It is deliberately NOT stored with the key: a
// restored or cloned profile has the same key and possibly an older counter,
// and a stored prefix would reproduce the exact same nonces. With a fresh
// prefix per process a rolled-back counter still yields different nonces,
// except with probability 2^-32 per pair of processes that reuse a counter
// value (see the design doc).
let noncePrefix = null;

export function getNoncePrefix() {
    if (!noncePrefix) {
        noncePrefix = crypto.getRandomValues(new Uint8Array(4));
    }
    return noncePrefix;
}

export function resetNoncePrefix() {
    noncePrefix = null;
}

function lockName(senderKeyId) {
    return `sender-key:${senderKeyId}`;
}

function ensureWebLocks() {
    if (!globalThis.navigator?.locks?.request) {
        throw new Error(
            'Web Locks API is not available — required for safe Sender Key nonce handling'
        );
    }
}

/**
 * Reserves and durably persists the next counter value for a Sender
 * Key, as a single critical section. Returns the value the caller
 * should use to derive this message's AES-GCM nonce — nothing else
 * will ever be handed this same value for this senderKeyId again.
 *
 * @param {string} senderKeyId
 * @returns {Promise<number>}
 */
export async function reserveNextCounter(senderKeyId) {
    if (typeof senderKeyId !== 'string' || !senderKeyId) {
        throw new Error('Invalid senderKeyId');
    }

    ensureWebLocks();

    return navigator.locks.request(lockName(senderKeyId), async () => {
        const current = await readCounter(senderKeyId);
        const next = current + 1;

        // Durably written before this function (and therefore the
        // lock) returns — the whole point of holding the lock only
        // this long.
        await writeCounter(senderKeyId, next);

        return current;
    });
}
