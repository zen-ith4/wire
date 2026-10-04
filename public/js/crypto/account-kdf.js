// public/js/crypto/account-kdf.js
//
// Fetches the (non-secret) KDF parameters the browser needs BEFORE it can
// derive anything from the password (F12). Pure network helpers; the
// derivation itself lives in credentials.js.

import { api } from '../core/api.js';
import { deriveCredentials, KDF_ITERATIONS } from './credentials.js';

function check(p) {
    if (!p || typeof p.salt !== 'string' || !Number.isInteger(p.iterations)) {
        throw new Error('Invalid KDF parameters from server');
    }
    // The server cannot talk the client into a cheaper KDF (credentials.js
    // enforces the same floor again at derivation time).
    if (p.iterations < KDF_ITERATIONS) {
        throw new Error('Server proposed a KDF weaker than the client minimum');
    }
    return { salt: p.salt, iterations: p.iterations };
}

/** Before login: unauthenticated. Unknown usernames get a deterministic fake salt. */
export async function fetchPublicKdfParams(username) {
    return check(await api(`/api/auth/kdf-params?username=${encodeURIComponent(username)}`));
}

/** Signed in: the caller's own account parameters. */
export async function fetchOwnKdfParams(token) {
    return check(await api('/api/me/kdf-params', { headers: { Authorization: `Bearer ${token}` } }));
}

/** authKey for a password the user just typed, with their own account salt. */
export async function deriveOwnAuthKey(password, token) {
    const kdf = await fetchOwnKdfParams(token);
    const { authKey, wrapKeyBytes } = await deriveCredentials(password, kdf.salt, kdf.iterations);
    wrapKeyBytes.fill(0);
    return authKey;
}
