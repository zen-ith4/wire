'use strict';

/*
 * IndexedDB-backed cache for the derived E2EE "unlock key" (see
 * identity.js / auth.js) on the plain browser build.
 *
 * This is the browser-side counterpart to Electron's safeStorage-based
 * IPC store (see main.js). It stores only the base64-encoded, already
 * PBKDF2-derived AES key material - never the account password, never
 * the raw X25519 private key.
 *
 * Isolation model: IndexedDB is already same-origin-isolated by the
 * browser, which is the same boundary every other piece of this
 * site's local data (the auth token in localStorage, etc.) relies on.
 * Records are additionally keyed by (origin, userId) so multiple
 * accounts on the same origin never collide.
 */

const DB_NAME = 'wire-e2ee-store';
const DB_VERSION = 1;
const STORE_NAME = 'unlock-keys';

let dbPromise = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    if (
      typeof indexedDB === 'undefined'
    ) {
      reject(
        new Error('IndexedDB is not available in this browser')
      );
      return;
    }

    const request =
      indexedDB.open(DB_NAME, DB_VERSION);

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

function recordKey(origin, userId) {
  if (
    typeof origin !== 'string' ||
    !origin
  ) {
    throw new Error('Invalid origin');
  }

  return `${origin}::${userId}`;
}

export async function idbStoreUnlockKey(
  origin,
  userId,
  unlockKey
) {
  if (
    typeof unlockKey !== 'string' ||
    !unlockKey
  ) {
    throw new Error('Invalid unlock key');
  }

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx =
      db.transaction(STORE_NAME, 'readwrite');

    tx.objectStore(STORE_NAME).put(
      unlockKey,
      recordKey(origin, userId)
    );

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGetUnlockKey(
  origin,
  userId
) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx =
      db.transaction(STORE_NAME, 'readonly');

    const request =
      tx.objectStore(STORE_NAME).get(
        recordKey(origin, userId)
      );

    request.onsuccess = () => {
      resolve(
        request.result
          ? { unlockKey: request.result }
          : null
      );
    };

    request.onerror = () => reject(request.error);
  });
}

export async function idbClearUnlockKey(
  origin,
  userId
) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx =
      db.transaction(STORE_NAME, 'readwrite');

    tx.objectStore(STORE_NAME).delete(
      recordKey(origin, userId)
    );

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
