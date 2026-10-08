// public/js/crypto/credential-migration.js
//
// F12 migration of an account from the legacy login (raw password, identity
// wrapped with PBKDF2(password, identity salt)) to the new one (authKey, identity
// wrapped with the wrapKey). Pure crypto, no network: identity-service.js sends
// the result to POST /api/auth/migrate-credentials.
//
// Safety rules, all enforced here BEFORE anything is sent:
//   - the identity must decrypt with the typed password (otherwise the account
//     stays legacy: migrating would lock the user out of their own history);
//   - the decrypted key must belong to the stored public key;
//   - the public key itself is echoed unchanged (the server refuses a different one).

import { deriveCredentials, generateKdfSalt, KDF_ITERATIONS, bytesToB64 } from './credentials.js';
import { decryptIdentityPkcs8, encryptIdentityPkcs8 } from './identity.js';

/** X25519 public key (standard base64, 32 bytes) belonging to a PKCS#8 private key. */
export async function publicKeyFromPkcs8(pkcs8) {
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const x = String(jwk.x || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(x + '='.repeat((4 - (x.length % 4)) % 4));
    return bytesToB64(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * @param {{password: string, ticket: string, identity: object}} input
 *   identity = the GET /api/me/identity-key response ({exists:false} or the v1 record)
 * @returns {Promise<{body: object, salt: string, iterations: number}>}
 */
export async function buildMigrationPayload({ password, ticket, identity }) {
    if (typeof password !== 'string' || !password) throw new Error('Password is required');
    if (typeof ticket !== 'string' || !ticket) throw new Error('Migration ticket is required');

    const salt = generateKdfSalt();
    const iterations = KDF_ITERATIONS;

    const { authKey, wrapKeyBytes } = await deriveCredentials(password, salt, iterations);
    wrapKeyBytes.fill(0);

    const body = { ticket, auth_key: authKey, kdf_salt: salt, kdf_iterations: iterations };

    if (identity?.exists) {
        if (identity.version !== 1) {
            throw new Error('Unexpected identity version on a legacy account');
        }

        const pkcs8 = await decryptIdentityPkcs8(
            identity.encryptedPrivateKey,
            password,
            identity.salt,
            identity.iv,
            identity.kdfParams,
            identity.version
        );

        try {
            if ((await publicKeyFromPkcs8(pkcs8)) !== identity.publicKey) {
                throw new Error('Stored identity does not match its public key');
            }

            const wrapped = await encryptIdentityPkcs8(pkcs8, password, { salt, iterations });

            body.identity = { publicKey: identity.publicKey, ...wrapped };
        } finally {
            new Uint8Array(pkcs8).fill(0);
        }
    }

    return { body, salt, iterations };
}
