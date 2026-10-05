import {
    createEncryptedIdentity,
    restoreIdentityFromServer,
    decryptIdentityPrivateKey,
    decryptIdentityPkcs8,
    encryptIdentityPkcs8,
    encryptIdentityPrivateKey,
    deriveIdentityUnlockKey,
    decryptIdentityPrivateKeyWithDerivedKey
} from "./identity.js";

import {
    resolveServerUrl
} from "../core/server.js";

import {
    fetchOwnKdfParams
} from "./account-kdf.js";

import {
    deriveCredentials,
    generateKdfSalt,
    KDF_ITERATIONS,
    KDF_NAME,
    IDENTITY_VERSION
} from "./credentials.js";

const IDENTITY_ENDPOINT =
    "/api/me/identity-key";

let currentIdentity = null;

/* =========================================================
 * Validation
 * ========================================================= */

function requireToken(token) {
    if (
        typeof token !== "string" ||
        !token.trim()
    ) {
        throw new Error(
            "Authentication token is required"
        );
    }
}

/* =========================================================
 * Fetch identity
 * ========================================================= */

async function fetchIdentity(token) {
    requireToken(token);

    const response =
        await fetch(
            resolveServerUrl(
                IDENTITY_ENDPOINT
            ),
            {
                method: "GET",

                headers: {
                    "Authorization":
                        `Bearer ${token}`
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            `Failed to fetch identity (${response.status})`
        );
    }

    const data =
        await response.json();

    if (
        !data ||
        typeof data.exists !== "boolean"
    ) {
        throw new Error(
            "Invalid identity response"
        );
    }

    return data;
}

/* =========================================================
 * Upload identity
 * ========================================================= */

async function uploadIdentity(
    identity,
    token
) {
    requireToken(token);

    if (
        !identity ||
        typeof identity !== "object"
    ) {
        throw new Error(
            "Invalid identity"
        );
    }

    if (
        !identity.publicKey ||
        !identity.encryptedPrivateKey ||
        !identity.kdf ||
        !identity.kdfParams ||
        !identity.salt ||
        !identity.iv ||
        identity.version == null
    ) {
        throw new Error(
            "Incomplete encrypted identity"
        );
    }

    const response =
        await fetch(
            resolveServerUrl(
                IDENTITY_ENDPOINT
            ),
            {
                method: "PUT",

                headers: {
                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Bearer ${token}`
                },

                body: JSON.stringify({
                    publicKey:
                        identity.publicKey,

                    encryptedPrivateKey:
                        identity.encryptedPrivateKey,

                    kdf:
                        identity.kdf,

                    kdfParams:
                        identity.kdfParams,

                    salt:
                        identity.salt,

                    iv:
                        identity.iv,

                    version:
                        identity.version
                })
            }
        );

    /*
     * Normal successful response.
     */
    if (response.ok) {
        let data = null;

        try {
            data =
                await response.json();
        } catch {
            throw new Error(
                "Server returned an invalid identity save response"
            );
        }

        if (
            data?.success === true
        ) {
            return;
        }

        /*
         * The server responded successfully but did not explicitly
         * confirm the save. Verify the actual state before failing.
         */
        try {
            const verifyResponse =
                await fetch(
                    resolveServerUrl(
                        IDENTITY_ENDPOINT
                    ),
                    {
                        method: "GET",

                        headers: {
                            "Authorization":
                                `Bearer ${token}`
                        }
                    }
                );

            if (verifyResponse.ok) {
                const verifyData =
                    await verifyResponse.json();

                if (
                    verifyData?.exists === true
                ) {
                    console.warn(
                        "[IdentityService] Identity exists on server " +
                        "despite missing success confirmation."
                    );

                    return;
                }
            }
        } catch (verifyError) {
            console.warn(
                "[IdentityService] Failed to verify identity:",
                verifyError
            );
        }

        throw new Error(
            "Server did not confirm identity save"
        );
    }

    /*
     * Error response.
     */
    let message =
        `Failed to save identity (${response.status})`;

    try {
        const data =
            await response.json();

        if (data?.error) {
            message =
                data.error;
        }
    } catch {
        // Ignore invalid error responses.
    }

    /*
     * IMPORTANT:
     *
     * "User already exists" is NOT automatically treated as success.
     *
     * Verify the actual identity state first.
     */
    if (
        typeof message === "string" &&
        message.toLowerCase().includes(
            "user already exists"
        )
    ) {
        console.warn(
            "[IdentityService] PUT returned 'User already exists'. " +
            "Checking whether the identity was actually saved..."
        );

        try {
            const verifyResponse =
                await fetch(
                    resolveServerUrl(
                        IDENTITY_ENDPOINT
                    ),
                    {
                        method: "GET",

                        headers: {
                            "Authorization":
                                `Bearer ${token}`
                        }
                    }
                );

            if (verifyResponse.ok) {
                const verifyData =
                    await verifyResponse.json();

                if (
                    verifyData?.exists === true
                ) {
                    console.warn(
                        "[IdentityService] Identity exists despite " +
                        "the PUT error. Treating save as successful."
                    );

                    return;
                }
            }
        } catch (verifyError) {
            console.warn(
                "[IdentityService] Failed to verify identity after " +
                "the PUT error:",
                verifyError
            );
        }
    }

    throw new Error(message);
}

/* =========================================================
 * Create identity
 * ========================================================= */

export async function createIdentity(
    password,
    token
) {
    requireToken(token);

    if (
        typeof password !== "string" ||
        password.length === 0
    ) {
        throw new Error(
            "Password is required"
        );
    }

    if (currentIdentity) {
        throw new Error(
            "Identity is already unlocked"
        );
    }

    console.log(
        "[IdentityService] Generating encrypted identity..."
    );

    // The identity is wrapped under THIS account's KDF parameters (the server
    // refuses anything else), so any device can re-derive the wrapKey from the
    // password alone (F12).
    const kdf =
        await fetchOwnKdfParams(
            token
        );

    const identity =
        await createEncryptedIdentity(
            password,
            kdf
        );

    console.log(
        "[IdentityService] Encrypted identity generated"
    );

    await uploadIdentity(
        identity,
        token
    );

    console.log(
        "[IdentityService] Identity uploaded"
    );

    if (
        !identity.keyPair ||
        !identity.keyPair.privateKey ||
        !identity.publicKey
    ) {
        throw new Error(
            "Generated identity is incomplete"
        );
    }

    currentIdentity = {
        privateKey:
            identity.keyPair.privateKey,

        publicKey:
            identity.publicKey
    };

    /*
     * Return derived unlock material for optional
     * remember-me / auto-unlock storage.
     */
    const unlockKey =
        await deriveIdentityUnlockKey(
            password,
            identity.salt,
            identity.kdfParams
        );

    return {
        publicKey:
            currentIdentity.publicKey,

        unlockKey
    };
}

/* =========================================================
 * Restore identity with password
 * ========================================================= */

export async function restoreIdentity(
    password,
    token
) {
    requireToken(token);

    if (
        typeof password !== "string" ||
        password.length === 0
    ) {
        throw new Error(
            "Password is required"
        );
    }

    if (currentIdentity) {
        throw new Error(
            "Identity is already unlocked"
        );
    }

    const identity =
        await fetchIdentity(token);

    if (!identity.exists) {
        throw new Error(
            "Identity does not exist"
        );
    }

    console.log(
        "[IdentityService] Restoring encrypted identity..."
    );

    const restored =
        await restoreIdentityFromServer(
            identity,
            password
        );

    if (
        !restored ||
        !restored.privateKey ||
        !restored.publicKey
    ) {
        throw new Error(
            "Restored identity is incomplete"
        );
    }

    currentIdentity = {
        privateKey:
            restored.privateKey,

        publicKey:
            restored.publicKey
    };

    console.log(
        "[IdentityService] Identity restored"
    );

    const unlockKey =
        await deriveIdentityUnlockKey(
            password,
            identity.salt,
            identity.kdfParams
        );

    return {
        publicKey:
            currentIdentity.publicKey,

        unlockKey
    };
}

/* =========================================================
 * Restore identity with cached unlock key
 * ========================================================= */

/*
 * Unlocks the identity using previously cached unlock material
 * instead of a password.
 *
 * This never accepts or derives from a password.
 */

export async function restoreIdentityWithUnlockKey(
    unlockKey,
    token
) {
    requireToken(token);

    if (
        typeof unlockKey !== "string" ||
        !unlockKey
    ) {
        throw new Error(
            "Unlock key is required"
        );
    }

    if (currentIdentity) {
        throw new Error(
            "Identity is already unlocked"
        );
    }

    const identity =
        await fetchIdentity(token);

    if (!identity.exists) {
        throw new Error(
            "Identity does not exist"
        );
    }

    if (
        identity.version !== IDENTITY_VERSION
    ) {
        throw new Error(
            "Unsupported identity version"
        );
    }

    if (
        identity.kdf !== KDF_NAME
    ) {
        throw new Error(
            "Unsupported identity KDF"
        );
    }

    console.log(
        "[IdentityService] Auto-unlocking identity..."
    );

    const privateKey =
        await decryptIdentityPrivateKeyWithDerivedKey(
            identity.encryptedPrivateKey,
            unlockKey,
            identity.iv
        );

    currentIdentity = {
        privateKey,

        publicKey:
            identity.publicKey
    };

    console.log(
        "[IdentityService] Identity auto-unlocked"
    );

    return {
        publicKey:
            currentIdentity.publicKey
    };
}

/* =========================================================
 * Change password (client side of PUT /api/me/password)
 * ========================================================= */

/*
 * F12: prepares EVERYTHING the server needs to change the password without it
 * ever seeing a password:
 *
 *   - current_auth_key: derived from the current password (proves knowledge),
 *   - a fresh salt, and new_auth_key / wrapKey derived from the new password,
 *   - the existing identity private key, decrypted with the OLD wrapKey and
 *     re-encrypted with the NEW wrapKey.
 *
 * Does NOT generate a new X25519 key pair. Does NOT upload anything.
 * The public key remains unchanged.
 */
export async function prepareCredentialChange(
    currentPassword,
    newPassword,
    token
) {
    requireToken(token);

    if (
        typeof currentPassword !== "string" ||
        currentPassword.length === 0
    ) {
        throw new Error(
            "Current password is required"
        );
    }

    if (
        typeof newPassword !== "string" ||
        newPassword.length === 0
    ) {
        throw new Error(
            "New password is required"
        );
    }

    const oldKdf =
        await fetchOwnKdfParams(
            token
        );

    const old =
        await deriveCredentials(
            currentPassword,
            oldKdf.salt,
            oldKdf.iterations
        );

    old.wrapKeyBytes.fill(0);

    const newSalt =
        generateKdfSalt();

    const next =
        await deriveCredentials(
            newPassword,
            newSalt,
            KDF_ITERATIONS
        );

    next.wrapKeyBytes.fill(0);

    const result = {
        current_auth_key:
            old.authKey,

        new_auth_key:
            next.authKey,

        new_kdf_salt:
            newSalt,

        new_kdf_iterations:
            KDF_ITERATIONS,

        identity:
            null
    };

    const identity =
        await fetchIdentity(token);

    if (!identity.exists) {
        return result;
    }

    console.log(
        "[IdentityService] Decrypting existing identity..."
    );

    const pkcs8 =
        await decryptIdentityPkcs8(
            identity.encryptedPrivateKey,
            currentPassword,
            identity.salt,
            identity.iv,
            identity.kdfParams
        );

    console.log(
        "[IdentityService] Re-encrypting identity with new password..."
    );

    let encrypted;

    try {
        encrypted =
            await encryptIdentityPkcs8(
                pkcs8,
                newPassword,
                {
                    salt: newSalt,
                    iterations: KDF_ITERATIONS
                }
            );
    } finally {
        new Uint8Array(pkcs8).fill(0);
    }

    result.identity = {
        encryptedPrivateKey:
            encrypted.encryptedPrivateKey,
        kdf:
            encrypted.kdf,
        kdfParams:
            encrypted.kdfParams,
        salt:
            encrypted.salt,
        iv:
            encrypted.iv,
        version:
            encrypted.version
    };

    return result;
}

/* =========================================================
 * Initialize identity
 * ========================================================= */

export async function initializeIdentity(
    password,
    token
) {
    requireToken(token);

    const identity =
        await fetchIdentity(token);

    if (identity.exists) {
        return restoreIdentity(
            password,
            token
        );
    }

    return createIdentity(
        password,
        token
    );
}

/* =========================================================
 * Current identity
 * ========================================================= */

export function getCurrentIdentity() {
    if (!currentIdentity) {
        return null;
    }

    return {
        privateKey:
            currentIdentity.privateKey,

        publicKey:
            currentIdentity.publicKey
    };
}

export function lockIdentity() {
    currentIdentity = null;

    // Group Sender Keys (public/js/crypto/groups/*) cache a local
    // at-rest wrapping key and unwrapped Sender Key CryptoKeys in
    // memory, both derived from this identity (groups/local-wrap-key.js,
    // groups/sender-key.js). Clear them here rather than leaving them
    // reachable after the identity they were derived from is gone.
    // Dynamic import: no static dependency from this DM/identity module
    // onto the group crypto module when groups are never used.
    import('./groups/local-wrap-key.js').then((m) => m.clearLocalWrapKeyCache());
    import('./groups/sender-key.js').then((m) => m.clearSenderKeyCache());
}

export function isIdentityUnlocked() {
    return currentIdentity !== null;
}
