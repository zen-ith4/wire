// public/js/crypto/groups/sender-key-store.js
//
// Two IndexedDB object stores, deliberately kept separate:
//
// - "sender-keys": one row per Sender Key this device knows about
//   (its own, and every other member's it has received a KDM for).
//   The key material itself (`wrappedKey`) is always AES-GCM
//   ciphertext under the local wrap key (local-wrap-key.js) — see
//   plan_prompt.md 2.3. Everything else on the row (ids, groupId,
//   epoch, ownerUserId, isMine) is metadata, not secret, and is
//   needed in the clear to look rows up at all.
//
// - "sender-key-counters": the per-Sender-Key send counter used to
//   derive AES-GCM nonces (2.2). This is NOT secret — it's a plain
//   monotonic integer — so it's stored unencrypted in its own store,
//   separate from the wrapped key material, so incrementing it on
//   every send never has to touch (and re-encrypt) the key blob.

const DB_NAME = 'wire-group-crypto';
const DB_VERSION = 3;
const KEYS_STORE = 'sender-keys';
const COUNTERS_STORE = 'sender-key-counters';
const META_STORE = 'meta';
// F4 replay protection: one row per (senderKeyId, nonce) this device has
// ACCEPTED (i.e. that passed AES-GCM authentication). Keyed by the full nonce.
const SEEN_STORE = 'seen-counters';

let dbPromise = null;

function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains(KEYS_STORE)) {
                const store = db.createObjectStore(KEYS_STORE, { keyPath: 'senderKeyId' });
                store.createIndex('by_group', 'groupId', { unique: false });
                store.createIndex('by_group_mine', ['groupId', 'isMine'], { unique: false });
            }

            if (!db.objectStoreNames.contains(COUNTERS_STORE)) {
                db.createObjectStore(COUNTERS_STORE, { keyPath: 'senderKeyId' });
            }

            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'key' });
            }

            if (!db.objectStoreNames.contains(SEEN_STORE)) {
                const seen = db.createObjectStore(SEEN_STORE, { keyPath: 'id' });
                seen.createIndex('bySenderKey', 'senderKeyId', { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return dbPromise;
}

function runRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @param {object} record {senderKeyId, groupId, ownerUserId, epoch,
 *   isMine, wrappedKey: {iv, ciphertext}, createdAt}
 */
export async function putSenderKeyRecord(record) {
    const db = await openDatabase();
    const tx = db.transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).put(record);

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Atomic insert-if-absent (get + put inside ONE readwrite transaction).
 * Used for keys received via KDM so that a self-KDM landing on this device
 * can never overwrite (and thereby demote to decrypt-only) the sending key
 * this device just generated and committed under the same id (F1).
 * @returns {Promise<boolean>} true if written, false if a row already existed
 */
export async function putSenderKeyRecordIfAbsent(record) {
    const db = await openDatabase();
    const tx = db.transaction(KEYS_STORE, 'readwrite');
    const store = tx.objectStore(KEYS_STORE);
    let written = false;

    const getReq = store.get(record.senderKeyId);
    getReq.onsuccess = () => {
        if (!getReq.result) {
            store.put(record);
            written = true;
        }
    };

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(written);
        tx.onerror = () => reject(tx.error);
    });
}

export async function getSenderKeyRecord(senderKeyId) {
    const db = await openDatabase();
    const tx = db.transaction(KEYS_STORE, 'readonly');
    const result = await runRequest(tx.objectStore(KEYS_STORE).get(senderKeyId));
    return result || null;
}

export async function getAllSenderKeysForGroup(groupId) {
    const db = await openDatabase();
    const tx = db.transaction(KEYS_STORE, 'readonly');
    const index = tx.objectStore(KEYS_STORE).index('by_group');
    return runRequest(index.getAll(IDBKeyRange.only(groupId)));
}

/**
 * The Sender Key *this device* currently uses for outgoing messages
 * in a group, if it has generated one — a group can only ever have
 * one "mine" row per device at a time (rotation replaces it; see
 * rotation.js), so the first match is authoritative.
 */
export async function getMySenderKeyForGroup(groupId, ownerUserId = null) {
    const db = await openDatabase();
    const tx = db.transaction(KEYS_STORE, 'readonly');
    const index = tx.objectStore(KEYS_STORE).index('by_group_mine');
    let rows = await runRequest(index.getAll(IDBKeyRange.only([groupId, 1])));

    // This IndexedDB is per browser profile, not per account. If another
    // user signed in here earlier, their "mine" rows are still on disk
    // and are wrapped under THEIR local key, so selecting one would fail
    // (or worse, be used). Only rows owned by the requesting user count.
    if (ownerUserId != null) {
        rows = rows.filter((r) => Number(r.ownerUserId) === Number(ownerUserId));
    }

    if (rows.length === 0) return null;

    // Defensive: should never happen (rotation.js always deletes the
    // previous "mine" row for a group before writing the new one),
    // but if it ever did, the highest epoch is the live one.
    return rows.reduce((a, b) => (b.epoch > a.epoch ? b : a));
}

/**
 * This browser profile's mailbox cursor (server: group_kdm_receipts). Kept in
 * the SAME IndexedDB as the keys on purpose: if the keys are wiped the device
 * id is wiped with them, so the server re-delivers every KDM; a device id that
 * outlived its keys would leave this device unable to ever re-obtain them.
 * get-or-create runs in ONE readwrite transaction, so tabs agree on one id.
 */
export async function getOrCreateDeviceId() {
    const db = await openDatabase();
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    let id = null;

    const getReq = store.get('device-id');
    getReq.onsuccess = () => {
        if (getReq.result?.value) {
            id = getReq.result.value;
            return;
        }
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        store.put({ key: 'device-id', value: id });
    };

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(id);
        tx.onerror = () => reject(tx.error);
    });
}

export async function deleteSenderKeyRecord(senderKeyId) {
    const db = await openDatabase();
    const tx = db.transaction([KEYS_STORE, COUNTERS_STORE, SEEN_STORE], 'readwrite');
    tx.objectStore(KEYS_STORE).delete(senderKeyId);
    tx.objectStore(COUNTERS_STORE).delete(senderKeyId);
    deleteSeenInTx(tx.objectStore(SEEN_STORE), senderKeyId);

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Everything about a group this device knows locally — called when
 * leaving/being removed from a group, or on account logout for that
 * group's rows, so no stale key material sits in IndexedDB for a
 * group this device no longer belongs to.
 */
export async function deleteAllSenderKeysForGroup(groupId) {
    const rows = await getAllSenderKeysForGroup(groupId);

    const db = await openDatabase();
    const tx = db.transaction([KEYS_STORE, COUNTERS_STORE, SEEN_STORE], 'readwrite');
    const keysStore = tx.objectStore(KEYS_STORE);
    const countersStore = tx.objectStore(COUNTERS_STORE);
    const seenStore = tx.objectStore(SEEN_STORE);

    for (const row of rows) {
        keysStore.delete(row.senderKeyId);
        countersStore.delete(row.senderKeyId);
        deleteSeenInTx(seenStore, row.senderKeyId);
    }

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/* =========================================================
 * Counters — see nonce-lock.js for the Web-Locks-guarded read/
 * increment/persist cycle that wraps these. These two functions are
 * intentionally "dumb": they don't take a lock themselves, so
 * nonce-lock.js can hold exactly one lock around both calls without
 * this module trying to also serialize them.
 * ========================================================= */

// ---------------------------------------------------------------------------
// Replay protection (F4)
// ---------------------------------------------------------------------------

// Cleanup policy: seen rows live exactly as long as the key they belong to
// (deleteSenderKeyRecord / deleteAllSenderKeysForGroup remove them, e.g. when the
// user leaves or is removed from a group). Rotation does NOT remove them: an old
// key keeps decrypting history, so it must keep rejecting replays. A hard cap per
// key bounds growth; evicting the OLDEST rows only ever weakens replay protection
// for ancient messages, it can never reject a legitimate one.
export const SEEN_CAP_PER_KEY = 100000;

function deleteSeenInTx(seenStore, senderKeyId) {
    const req = seenStore.index('bySenderKey').openKeyCursor(IDBKeyRange.only(senderKeyId));
    req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        seenStore.delete(cursor.primaryKey);
        cursor.continue();
    };
}

/**
 * Atomically claims (senderKeyId, nonce) for `ref` (the server message id, or an
 * attachment reference). Call ONLY after AES-GCM authentication succeeded, so a
 * corrupt message can never burn a nonce.
 *
 * The identity of a message is its full 12-byte nonce (4-byte random per-process
 * prefix || 8-byte counter), NOT the counter alone: after a restored/cloned
 * profile rolled its counter back (F10), fresh messages legitimately reuse old
 * COUNTER values under a new prefix and must not be mistaken for replays.
 * A replay is the same ciphertext, i.e. the same nonce, under a new message id.
 *
 *   'new'      first time this nonce is accepted: recorded.
 *   'same'     the SAME ref again (socket + syncSince after a reconnect,
 *              re-decrypting history after a reload, a quoted reply preview,
 *              another tab): idempotent, accepted, nothing changes.
 *   'conflict' the nonce was already accepted for a DIFFERENT ref: a replay (a
 *              hostile relay re-posting stored ciphertext under a fresh id), or
 *              a sender that reused a nonce.
 *
 * get + put run in ONE readwrite transaction, so two tabs racing on the same
 * IndexedDB are serialised by the browser: exactly one of two competing refs wins.
 */
export async function claimNonce({ senderKeyId, nonceHex, counter, ref }) {
    const db = await openDatabase();
    const tx = db.transaction(SEEN_STORE, 'readwrite');
    const store = tx.objectStore(SEEN_STORE);
    const id = `${senderKeyId}:${nonceHex}`;
    let status = 'new';

    const getReq = store.get(id);
    getReq.onsuccess = () => {
        const existing = getReq.result;

        if (!existing) {
            store.put({ id, senderKeyId, counter, ref, at: Date.now() });
            return;
        }

        status = existing.ref === ref ? 'same' : 'conflict';
    };

    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('claimNonce aborted'));
    });

    if (status === 'new' && Math.random() < 1 / 64) {
        await pruneSeen(senderKeyId).catch(() => {});
    }

    return status;
}

export async function countSeen(senderKeyId) {
    const db = await openDatabase();
    const tx = db.transaction(SEEN_STORE, 'readonly');
    const req = tx.objectStore(SEEN_STORE).index('bySenderKey').count(IDBKeyRange.only(senderKeyId));
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Drops the oldest ~10% of a key's seen rows when it holds more than `cap`. */
export async function pruneSeen(senderKeyId, cap = SEEN_CAP_PER_KEY) {
    if ((await countSeen(senderKeyId)) <= cap) return 0;

    const db = await openDatabase();
    const tx = db.transaction(SEEN_STORE, 'readwrite');
    const store = tx.objectStore(SEEN_STORE);
    const rows = [];

    const req = store.index('bySenderKey').openCursor(IDBKeyRange.only(senderKeyId));
    req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
            rows.push({ id: cursor.value.id, at: cursor.value.at });
            cursor.continue();
            return;
        }
        rows.sort((a, b) => a.at - b.at);
        const drop = Math.max(rows.length - cap, 0) + Math.ceil(cap / 10);
        for (const r of rows.slice(0, drop)) store.delete(r.id);
    };

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function readCounter(senderKeyId) {
    const db = await openDatabase();
    const tx = db.transaction(COUNTERS_STORE, 'readonly');
    const row = await runRequest(tx.objectStore(COUNTERS_STORE).get(senderKeyId));
    return row ? row.counter : 0;
}

export async function writeCounter(senderKeyId, counter) {
    const db = await openDatabase();
    const tx = db.transaction(COUNTERS_STORE, 'readwrite');
    tx.objectStore(COUNTERS_STORE).put({ senderKeyId, counter });

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Test-only escape hatch: lets tests reset IndexedDB connection
// state between fake-indexeddb resets without reloading the module.
export function __resetForTests() {
    dbPromise = null;
}
