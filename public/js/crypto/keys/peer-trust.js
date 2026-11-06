// public/js/crypto/keys/peer-trust.js
//
// TOFU pinning, safety numbers and the key-change alarm for 1:1 DMs.
//
// Phase 2 of docs/e2ee-dm-hardening.md. Deliberately ships BEFORE Phase 1
// (envelope v2 / directional keys / AAD) because it changes no wire format: no
// HKDF info, no AAD, no envelope field. A DM written before this file existed
// decrypts exactly as it did, and one written after is byte-identical to one
// written before.
//
// WHAT IT IS, AND WHAT IT IS NOT
// It is trust-on-first-use for peer identity keys, plus a human-comparable
// fingerprint so two users can detect a man-in-the-middle without trusting the
// server's word for it.
//
// It is NOT signed pre-keys, NOT XEdDSA, NOT a pre-key batch. Those all need
// server storage and a design review of their own (doc §8), and none of them is
// here. The limits below are stated rather than papered over:
//
//   - TOFU defeats an active server ONLY once the two users have compared safety
//     numbers over a channel the server does not control. Until they do, first
//     contact is still whatever the server handed over.
//   - The server still holds every CURRENT public key, so it can still withhold,
//     replay or delay a rotation. It can no longer be silently substituted
//     without raising the alarm on every device that has a pin.

const DOMAIN = 'wire-safety-number-v1';

const X25519_PUBLIC_KEY_BYTES = 32;
const DB_NAME = 'wire-peer-trust';
const DB_VERSION = 1;
const STORE_NAME = 'peer-pins';

/* =========================================================
 * base64 <-> bytes
 * ========================================================= */

export function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function base64ToBytes(base64) {
    if (typeof base64 !== 'string' || !base64.length) {
        throw new Error('Invalid Base64 data');
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function assertPublicKey(publicKeyB64, what) {
    const bytes = base64ToBytes(publicKeyB64);
    if (bytes.length !== X25519_PUBLIC_KEY_BYTES) {
        throw new Error(`${what} must be a 32-byte X25519 public key`);
    }
    return bytes;
}

/** Byte-wise ascending, NOT base64-string order. */
function compareBytes(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

/* =========================================================
 * Safety number
 * ========================================================= */

/**
 * The exact input to the safety-number hash.
 *
 *   'wire-safety-number-v1'
 *   | u32be(len(keyA)) | keyA
 *   | u32be(len(keyB)) | keyB
 *
 * where keyA is the SMALLER of the two RAW 32-byte keys and keyB the larger.
 * Length prefixes are mandatory: without them a key whose bytes happen to start
 * with another's tail could produce the same concatenation. The label is a
 * domain separator so this hash can never be confused with any other digest in
 * the codebase.
 *
 * Exported so a test can assert the layout, not just the output.
 *
 * @param {Uint8Array} rawA
 * @param {Uint8Array} rawB
 * @returns {Uint8Array}
 */
export function safetyNumberPreimage(rawA, rawB) {
    const [keyA, keyB] = compareBytes(rawA, rawB) <= 0 ? [rawA, rawB] : [rawB, rawA];

    const label = new TextEncoder().encode(DOMAIN);
    const total = label.length + 4 + keyA.length + 4 + keyB.length;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let offset = 0;

    out.set(label, offset);
    offset += label.length;

    view.setUint32(offset, keyA.length);
    offset += 4;
    out.set(keyA, offset);
    offset += keyA.length;

    view.setUint32(offset, keyB.length);
    offset += 4;
    out.set(keyB, offset);

    return out;
}

/**
 * SHA-256 of the preimage, base64. This is the value shown to the user as the
 * safety number AND the value stored in the pin record — one function, so the
 * two can never disagree.
 *
 * @param {string} myPublicKeyB64
 * @param {string} theirPublicKeyB64
 * @returns {Promise<string>} base64 SHA-256 (32 bytes)
 */
export async function computeSafetyFingerprint(myPublicKeyB64, theirPublicKeyB64) {
    const mine = assertPublicKey(myPublicKeyB64, 'Your public key');
    const theirs = assertPublicKey(theirPublicKeyB64, "Their public key");

    const digest = await crypto.subtle.digest('SHA-256', safetyNumberPreimage(mine, theirs));
    return bytesToBase64(new Uint8Array(digest));
}

/**
 * The same digest as 60 decimal digits in 12 groups of 5.
 *
 * 60 digits is the width Signal uses, so the number is long enough that a
 * mistyped comparison is implausible and short enough to read aloud or read off
 * a screen. Leading zeros are preserved (fixed-width groups), because a safety
 * number that prints differently from its own bytes is worse than useless.
 *
 * @param {Uint8Array} digest32
 * @returns {string} e.g. "12345 67890 34567 ..."
 */
export function formatSafetyNumber(digest32) {
    if (!(digest32 instanceof Uint8Array) || digest32.length !== 32) {
        throw new Error('Safety number digest must be 32 bytes');
    }

    let value = 0n;
    for (const byte of digest32) {
        value = (value << 8n) | BigInt(byte);
    }

    // 2^256 is ~1.157e77, so 60 decimal digits is the largest fixed width that
    // never overflows; pad rather than truncate so every number is the same
    // number of characters.
    const decimal = value.toString(10).padStart(60, '0');

    const groups = [];
    for (let i = 0; i < 60; i += 5) {
        groups.push(decimal.slice(i, i + 5));
    }

    return groups.join(' ');
}

/**
 * Convenience: the fingerprint AND its display form in one pass.
 *
 * @param {string} myPublicKeyB64
 * @param {string} theirPublicKeyB64
 * @returns {Promise<{fingerprint: string, number: string}>}
 */
export async function computeSafetyNumber(myPublicKeyB64, theirPublicKeyB64) {
    const fingerprint = await computeSafetyFingerprint(myPublicKeyB64, theirPublicKeyB64);
    return {
        fingerprint,
        number: formatSafetyNumber(base64ToBytes(fingerprint)),
    };
}

/* =========================================================
 * Storage
 *
 * IndexedDB, keyed by (origin, own user id, peer id) so two accounts on one
 * origin never see each other's pins, and never confused with another origin's.
 * NOTHING here is ever sent to the server: the pin is this device's memory of
 * who the peer was, and a server that learns it learns nothing useful that it
 * does not already hold.
 * ========================================================= */

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is not available in this browser'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return dbPromise;
}

function recordKey(origin, ownUserId, peerId) {
    if (typeof origin !== 'string' || !origin) {
        throw new Error('Invalid origin');
    }
    return `${origin}::${ownUserId}::${peerId}`;
}

async function readRecord(origin, ownUserId, peerId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(recordKey(origin, ownUserId, peerId));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    });
}

async function writeRecord(origin, ownUserId, peerId, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, recordKey(origin, ownUserId, peerId));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Store `value` unless a record already exists, in ONE transaction, and resolve
 * to whichever record ended up stored.
 *
 * A read followed by a separate write is not enough here: a thread opening fires
 * one trust check per row, and two first contacts that both read "no pin" would
 * let the later write replace a pin the earlier caller has already acted on.
 */
async function writeRecordIfAbsent(origin, ownUserId, peerId, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const key = recordKey(origin, ownUserId, peerId);
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const existing = store.get(key);
        let stored = value;

        existing.onsuccess = () => {
            if (existing.result) {
                stored = existing.result;
            } else {
                store.put(value, key);
            }
        };

        tx.oncomplete = () => resolve(stored);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Replace an existing record with `change(record)`, in ONE transaction. No record,
 * or a falsy answer from `change`, writes nothing.
 */
async function updateRecord(origin, ownUserId, peerId, change) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const key = recordKey(origin, ownUserId, peerId);
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const existing = store.get(key);

        existing.onsuccess = () => {
            const next = existing.result ? change(existing.result) : null;
            if (next) store.put(next, key);
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/* =========================================================
 * States
 *
 *   first-contact  no pin yet. Trust on first use: pin it and carry on.
 *   ok             the current key is the pinned one.
 *   reknown        the current key is one this device has already held or the
 *                  user has already accepted (they rotated away and back). Not
 *                  an alarm, but only on a contact nobody has verified.
 *   changed        the current key is one this device has never accepted, or
 *                  any key other than the one the user verified. The alarm.
 * ========================================================= */

export async function getPeerPin(peerId, { origin, ownUserId }) {
    if (!Number.isInteger(Number(peerId)) || Number(peerId) <= 0) {
        throw new Error('Invalid peer id');
    }
    if (!Number.isInteger(Number(ownUserId)) || Number(ownUserId) <= 0) {
        throw new Error('Invalid own user id');
    }
    return readRecord(origin, ownUserId, Number(peerId));
}

function normaliseAccepted(pin) {
    return Array.isArray(pin?.accepted) ? pin.accepted : [];
}

/**
 * Every key in a pin that may open a message, `current` first.
 *
 * This list is what the DM decrypt paths choose from, and it comes from this
 * device alone: the server has no way to add to it after the pin exists.
 *
 * @param {object|null} pin
 * @returns {Array<{fingerprint: string, publicKey: string}>}
 */
export function pinnedPeerKeys(pin) {
    const keys = [];
    const seen = new Set();

    for (const key of [pin?.current, ...normaliseAccepted(pin)]) {
        if (!key?.fingerprint || !key.publicKey || seen.has(key.fingerprint)) continue;
        seen.add(key.fingerprint);
        keys.push({ fingerprint: key.fingerprint, publicKey: key.publicKey });
    }

    return keys;
}

/**
 * Classify the peer's CURRENT public key against what this device has pinned.
 *
 * Never writes. A caller decides whether first contact should pin.
 *
 * @param {number} peerId
 * @param {string} currentPublicKeyB64
 * @param {{origin: string, ownUserId: number}} ctx
 * @returns {Promise<{state: string, pin: object|null, pending: object|null, fingerprint: string}>}
 */
export async function evaluatePeerKey(peerId, currentPublicKeyB64, ctx) {
    const bytes = assertPublicKey(currentPublicKeyB64, 'Peer public key');
    const fingerprint = bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    const pin = await getPeerPin(peerId, ctx);

    if (!pin) {
        return { state: 'first-contact', pin: null, pending: null, fingerprint };
    }

    if (pin.current?.fingerprint === fingerprint) {
        return { state: 'ok', pin, pending: null, fingerprint };
    }

    // Only a key this device really held may come back quietly, and only on a
    // contact nobody has verified:
    //
    //   - a key the server merely LISTED at first contact (viaFirstContact) was
    //     never compared or accepted by anyone. Calling it known would let the
    //     server plant a key of its own in that list and switch to it later with
    //     no alarm, including after the users compared safety numbers.
    //   - "verified" covers exactly one key. Once the user has compared numbers
    //     for pin.current, any other key needs them to look again.
    const known = normaliseAccepted(pin).find((k) => k.fingerprint === fingerprint);

    if (known && !known.viaFirstContact && !pin.verifiedAt) {
        return { state: 'reknown', pin, pending: null, fingerprint };
    }

    return {
        state: 'changed',
        pin,
        pending: { fingerprint, publicKey: currentPublicKeyB64 },
        fingerprint,
    };
}

/**
 * TOFU: remember the key we are about to trust for the first time.
 *
 * Idempotent, and deliberately a no-op when a pin already exists — the first
 * contact must never be able to overwrite an earlier one.
 *
 * `retiredKeys` is the peer's key history as the SERVER reported it in the same
 * exchange. They are recorded alongside the current key so old history stays
 * readable, flagged viaFirstContact because nobody has checked them. Omitting them
 * caused a real regression: a user whose FIRST contact happened after their peer
 * had rotated would pin the new key only, and could then never read the
 * pre-rotation history that the v15 archive exists to preserve.
 *
 * That is all the flag allows. Such a key can never become current without the
 * alarm (evaluatePeerKey), and verifying the contact drops it (markPeerVerified),
 * so a key the server planted here cannot outlive the safety-number comparison.
 *
 * @param {number} peerId
 * @param {string} currentPublicKeyB64
 * @param {{origin: string, ownUserId: number}} ctx
 * @param {string[]} [retiredKeys] base64 public keys the server listed as retired
 * @returns {Promise<object>} the stored pin
 */
export async function pinOnFirstUse(peerId, currentPublicKeyB64, ctx, retiredKeys = []) {
    const existing = await getPeerPin(peerId, ctx);
    if (existing) return existing;

    const evaluated = await evaluatePeerKey(peerId, currentPublicKeyB64, ctx);

    const accepted = [];

    for (const key of retiredKeys) {
        if (typeof key !== 'string' || key === currentPublicKeyB64) continue;
        try {
            const bytes = assertPublicKey(key, 'Retired public key');
            const fingerprint = bytesToBase64(
                new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
            );
            if (fingerprint === evaluated.fingerprint) continue;
            accepted.push({ fingerprint, publicKey: key, at: Date.now(), viaFirstContact: true });
        } catch {
            // A malformed key from the server is simply not recorded; the current
            // key is what matters for the pin itself.
        }
    }

    const pin = {
        peerId: Number(peerId),
        current: { fingerprint: evaluated.fingerprint, publicKey: currentPublicKeyB64, at: Date.now() },
        accepted,
        verifiedAt: null,
    };

    return writeRecordIfAbsent(ctx.origin, ctx.ownUserId, Number(peerId), pin);
}

/**
 * The user's explicit "accept this new key" action.
 *
 * Adds the new key to `accepted` AND makes it current, so the same key is
 * recognised on every later visit and a second rotation back to it is not an
 * alarm.
 *
 * Accepting is NOT verifying, and it clears `verifiedAt` even when the previous
 * key was verified: the user may simply want to read their messages, and nobody
 * has compared the new key yet. markPeerVerified() is the only thing that sets it.
 */
export async function acceptPeerKey(peerId, newPublicKeyB64, ctx) {
    const evaluated = await evaluatePeerKey(peerId, newPublicKeyB64, ctx);

    const previous = await getPeerPin(peerId, ctx);
    const accepted = normaliseAccepted(previous).filter((k) => k.fingerprint !== evaluated.fingerprint);

    if (previous?.current && previous.current.fingerprint !== evaluated.fingerprint) {
        accepted.push({ ...previous.current, retiredAt: Date.now() });
    }

    accepted.push({ fingerprint: evaluated.fingerprint, publicKey: newPublicKeyB64, at: Date.now() });

    const pin = {
        peerId: Number(peerId),
        current: { fingerprint: evaluated.fingerprint, publicKey: newPublicKeyB64, at: Date.now() },
        accepted,
        verifiedAt: null,
        encryptedFloor: previous?.encryptedFloor ?? null,
    };

    await writeRecord(ctx.origin, ctx.ownUserId, Number(peerId), pin);
    return pin;
}

/**
 * Mark the current key as human-verified (does not change which key is current).
 *
 * `expectedFingerprint` is the key whose digits the user was shown. When it is no
 * longer the pinned key nothing is marked, because the user never compared the one
 * that is pinned now.
 *
 * Verifying also drops every key the server merely listed at first contact. They
 * were only ever taken on the server's word, and the user has just established a
 * key that does not depend on it. The cost is deliberate: a message sealed to one
 * of those keys stops opening on this device. Rotation is rare, and the alternative
 * is a retired key the server chose being able to forge messages on a contact the
 * user believes is verified.
 *
 * @returns {Promise<object|null>} the updated pin, or null when nothing was marked
 */
export async function markPeerVerified(peerId, ctx, expectedFingerprint = null) {
    const pin = await getPeerPin(peerId, ctx);
    if (!pin) return null;
    if (expectedFingerprint !== null && pin.current?.fingerprint !== expectedFingerprint) {
        return null;
    }
    const next = {
        ...pin,
        accepted: normaliseAccepted(pin).filter((k) => !k.viaFirstContact),
        verifiedAt: Date.now(),
    };
    await writeRecord(ctx.origin, ctx.ownUserId, Number(peerId), next);
    return next;
}

/**
 * Remember that a DM row of this conversation opened under a pinned key.
 *
 * `encryptedFloor` is the lowest such row id this device has seen. It only ever moves
 * down, and a whole page of rows opening at once must leave the lowest, so this is
 * one transaction. It is what chat/dm-unencrypted.js judges a row with nothing sealed
 * in it by, and it lives on the pin because only a row that opened under the pin can
 * move it: the server's word never does.
 *
 * No pin means no row can have opened, so there is nothing to record.
 *
 * @param {number} peerId
 * @param {number} rowId
 * @param {{origin: string, ownUserId: number}} ctx
 */
export async function noteEncryptedRow(peerId, rowId, ctx) {
    return updateRecord(ctx.origin, ctx.ownUserId, Number(peerId), (pin) => {
        if (Number.isInteger(pin.encryptedFloor) && pin.encryptedFloor <= rowId) return null;
        return { ...pin, encryptedFloor: rowId };
    });
}

/** Forget a peer entirely — the "untrust this conversation" reset. */
export async function clearPeerPin(peerId, ctx) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(recordKey(ctx.origin, ctx.ownUserId, Number(peerId)));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/* =========================================================
 * Retired keys (the v15 key-archive fallback)
 * ========================================================= */

/**
 * May a RETIRED peer key from GET /api/me/identity-key-history be tried when
 * decrypting?
 *
 * The rule, in full:
 *
 *   ALLOWED when this device has a pin for that peer and that retired key's
 *   fingerprint is the PINNED CURRENT key or is already in `accepted` — the
 *   user demonstrably had this exact key, so trying it can only open history
 *   they already had.
 *
 *   ALLOWED when this device has NO pin at all — first contact. There is nothing
 *   to check against, and this is exactly the v15 behaviour, unchanged.
 *
 *   REFUSED otherwise. This is the branch that matters: after a key-change alarm
 *   the attacker's substituted key is current and must not be used, and an
 *   UNKNOWN retired key arriving alongside it must not become a second way in.
 *
 * The pinned CURRENT key being allowed is not a special case bolted on: it is the
 * ordinary situation. A user who pinned Bob's key and only later saw him rotate
 * has a pin whose `current` is exactly the key their history was sealed to. The
 * v15 history test caught this - it pinned on first contact, Bob rotated, and the
 * fallback refused the one key that could actually decrypt.
 *
 * @param {number} peerId
 * @param {string} retiredPublicKeyB64
 * @param {{origin: string, ownUserId: number}} ctx
 * @returns {Promise<{allowed: boolean, reason: string, fingerprint: string}>}
 */
export async function mayTryRetiredKey(peerId, retiredPublicKeyB64, ctx) {
    const bytes = assertPublicKey(retiredPublicKeyB64, 'Retired public key');
    const fingerprint = bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

    let pin = null;
    try {
        pin = await getPeerPin(peerId, ctx);
    } catch {
        // No storage available: refuse. Treating this as "no pin" would hand the
        // choice of key to the server exactly when the pin cannot be consulted, and
        // it would not save anything: a browser that refuses IndexedDB already
        // cannot pass the trust check that runs before a DM is decrypted.
        return { allowed: false, reason: 'no-pin-storage', fingerprint };
    }

    if (!pin) {
        return { allowed: true, reason: 'first-contact', fingerprint };
    }

    if (pin.current?.fingerprint === fingerprint) {
        return { allowed: true, reason: 'pinned-current', fingerprint };
    }

    if (normaliseAccepted(pin).some((k) => k.fingerprint === fingerprint)) {
        return { allowed: true, reason: 'previously-accepted', fingerprint };
    }

    return { allowed: false, reason: 'not-previously-accepted', fingerprint };
}