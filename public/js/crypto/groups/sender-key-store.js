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
const DB_VERSION = 1;
const KEYS_STORE = 'sender-keys';
const COUNTERS_STORE = 'sender-key-counters';

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

    // Only keys generated by THIS code on THIS device may be used to
    // encrypt. Legacy rows (no `scheme`) could be a self-KDM copy of another
    // device's key (stored isMine=1 by the old owner-based rule) and must
    // never be encrypted with; they remain readable for decryption.
    rows = rows.filter((r) => r.scheme === 2);

    if (rows.length === 0) return null;

    // Defensive: should never happen (rotation.js always deletes the
    // previous "mine" row for a group before writing the new one),
    // but if it ever did, the highest epoch is the live one.
    return rows.reduce((a, b) => (b.epoch > a.epoch ? b : a));
}

export async function deleteSenderKeyRecord(senderKeyId) {
    const db = await openDatabase();
    const tx = db.transaction([KEYS_STORE, COUNTERS_STORE], 'readwrite');
    tx.objectStore(KEYS_STORE).delete(senderKeyId);
    tx.objectStore(COUNTERS_STORE).delete(senderKeyId);

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
    const tx = db.transaction([KEYS_STORE, COUNTERS_STORE], 'readwrite');
    const keysStore = tx.objectStore(KEYS_STORE);
    const countersStore = tx.objectStore(COUNTERS_STORE);

    for (const row of rows) {
        keysStore.delete(row.senderKeyId);
        countersStore.delete(row.senderKeyId);
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
