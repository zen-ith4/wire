// public/js/crypto/account-kdf.js
//
// Fetches the (non-secret) KDF parameters the browser needs BEFORE it can derive
// anything from the password (F12), and pins "this account uses the new login
// scheme" in this browser so a hostile server cannot talk it back into sending a
// raw password. The derivation itself lives in credentials.js.

import { api } from '../core/api.js';
import { getServerEndpoint } from '../core/server.js';
import { deriveCredentials, KDF_ITERATIONS } from './credentials.js';

// Client-side policy (the server cannot enforce it: it never sees a password).
export const MIN_PASSWORD_LENGTH = 12;

export class DowngradeRefusedError extends Error {
    constructor() {
        super(
            'This account was upgraded, but the server is asking for a raw password. ' +
            'Refusing to send it (possible downgrade attack).'
        );
        this.name = 'DowngradeRefusedError';
        this.code = 'DOWNGRADE_REFUSED';
    }
}

/* ---------- scheme-2 pin (per server endpoint + username) ---------- */

const PIN_STORAGE_KEY = 'wire.auth.scheme2.pins';

function pinKey(username) {
    let endpoint = '';
    try { endpoint = String(getServerEndpoint() || ''); } catch { /* not configured */ }
    return `${endpoint}|${String(username || '').trim().toLowerCase()}`;
}

function readPins() {
    try {
        const raw = localStorage.getItem(PIN_STORAGE_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
        return {};
    }
}

export function isScheme2Pinned(username) {
    return readPins()[pinKey(username)] === 1;
}

export function pinScheme2(username) {
    try {
        const pins = readPins();
        pins[pinKey(username)] = 1;
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pins));
    } catch {
        // storage unavailable: the pin is a hardening, not a requirement
    }
}

/* ---------- parameter fetching ---------- */

function check(p) {
    if (p && p.scheme === 1) {
        return { scheme: 1 };
    }
    if (!p || p.scheme !== 2 || typeof p.salt !== 'string' || !Number.isInteger(p.iterations)) {
        throw new Error('Invalid KDF parameters from server');
    }
    // The server cannot talk the client into a cheaper KDF (credentials.js
    // enforces the same floor again at derivation time).
    if (p.iterations < KDF_ITERATIONS) {
        throw new Error('Server proposed a KDF weaker than the client minimum');
    }
    return { scheme: 2, salt: p.salt, iterations: p.iterations };
}

/**
 * Before login: unauthenticated.
 *   { scheme: 1 }                        account not upgraded yet (legacy raw login)
 *   { scheme: 2, salt, iterations }      upgraded; unknown names get a fake salt
 * Throws DowngradeRefusedError if this browser has seen the account upgraded.
 */
export async function fetchPublicKdfParams(username) {
    const params = check(await api(`/api/auth/kdf-params?username=${encodeURIComponent(String(username || '').trim())}`));

    if (params.scheme === 1 && isScheme2Pinned(username)) {
        throw new DowngradeRefusedError();
    }

    return params;
}

/** Signed in: the caller's own account parameters ({scheme:1} while not upgraded). */
export async function fetchOwnKdfParams() {
    return check(await api('/api/me/kdf-params'));
}

/** authKey for a password the user just typed, with their own account salt. */
export async function deriveOwnAuthKey(password) {
    const kdf = await fetchOwnKdfParams();

    if (kdf.scheme !== 2) {
        const err = new Error('Log in again to upgrade this account first');
        err.code = 'migrate_first';
        throw err;
    }

    const { authKey, wrapKeyBytes } = await deriveCredentials(password, kdf.salt, kdf.iterations);
    wrapKeyBytes.fill(0);
    return authKey;
}
