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

/* =========================================================
 * States
 *
 *   first-contact  no pin yet. Trust on first use: pin it and carry on.
 *   ok             the current key is the pinned one.
 *   reknown        the current key is one the user has already accepted
 *                  before (they rotated away and back, or restored a backup).
 *                  Not an alarm.
 *   changed        the current key is one this device has never accepted.
 *                  The alarm.
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

    if (normaliseAccepted(pin).some((k) => k.fingerprint === fingerprint)) {
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
 * exchange. They are recorded as accepted alongside the current key, and that is
 * not a loophole — it is what TOFU means. At first contact there is nothing to
 * compare against, so everything the server hands over in one response is taken
 * as that peer's key set. Omitting them caused a real regression: a user whose
 * FIRST contact happened after their peer had rotated would pin the new key
 * only, and could then never read the pre-rotation history that the v15 archive
 * exists to preserve. The security property this file needs is about keys that
 * appear LATER, out of band of the pin, not about the pin's own first response.
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

    await writeRecord(ctx.origin, ctx.ownUserId, Number(peerId), pin);
    return pin;
}

/**
 * The user's explicit "I verified this" action.
 *
 * Adds the new key to `accepted` AND makes it current, so the same key is
 * recognised on every later visit and a second rotation back to it is not an
 * alarm.
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
        verifiedAt: Date.now(),
    };

    await writeRecord(ctx.origin, ctx.ownUserId, Number(peerId), pin);
    return pin;
}

/** Mark the current key as human-verified (does not change which key is current). */
export async function markPeerVerified(peerId, ctx) {
    const pin = await getPeerPin(peerId, ctx);
    if (!pin) return null;
    const next = { ...pin, verifiedAt: Date.now() };
    await writeRecord(ctx.origin, ctx.ownUserId, Number(peerId), next);
    return next;
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
        // No storage available: treat as no pin, which is the first-contact
        // branch. Failing closed here would break decryption for a browser that
        // refuses IndexedDB, and the pin is hardening rather than the only gate.
        return { allowed: true, reason: 'no-pin-storage', fingerprint };
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