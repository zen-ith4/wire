import {
    createEncryptedIdentity,
    restoreIdentityFromServer,
    decryptIdentityPrivateKey,
    encryptIdentityPrivateKey,
    deriveIdentityUnlockKey,
    decryptIdentityPrivateKeyWithDerivedKey
} from "./identity.js";


const IDENTITY_ENDPOINT =
    "/api/me/identity-key";


let currentIdentity = null;


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


async function fetchIdentity(token) {
    requireToken(token);

    const response =
        await fetch(
            IDENTITY_ENDPOINT,
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
            IDENTITY_ENDPOINT,
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

    if (!response.ok) {
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

        throw new Error(message);
    }

    const data =
        await response.json();

    if (
        data?.success !== true
    ) {
        throw new Error(
            "Server did not confirm identity save"
        );
    }
}


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

    const identity =
        await createEncryptedIdentity(
            password
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
     * Also hand back the derived unlock key (see identity.js) so
     * callers on Electron can cache it for auto-unlock on the next
     * launch. Browser callers can simply ignore this field - it is
     * meaningless without the OS-level secure storage Electron
     * provides.
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

    /*
     * See createIdentity() above - same reasoning.
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


/*
 * Unlocks the identity using previously-cached unlock material
 * (see deriveIdentityUnlockKey in identity.js) instead of a
 * password. Used exclusively by the Electron auto-unlock path.
 *
 * This never accepts, derives from, or has access to a password -
 * only the already-derived key bytes a prior successful
 * createIdentity()/restoreIdentity() call produced.
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
        identity.version !== 1
    ) {
        throw new Error(
            "Unsupported identity version"
        );
    }

    if (
        identity.kdf !== "PBKDF2-SHA-256"
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


/*
 * Re-encrypt the existing identity private key
 * with a new account password.
 *
 * IMPORTANT:
 * - Does NOT generate a new X25519 key pair.
 * - Does NOT upload anything.
 * - Public key remains unchanged.
 * - Returns only encrypted-at-rest metadata.
 */
export async function reencryptIdentity(
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

    const identity =
        await fetchIdentity(token);

    if (!identity.exists) {
        return null;
    }

    if (
        identity.version !== 1
    ) {
        throw new Error(
            "Unsupported identity version"
        );
    }

    if (
        identity.kdf !== "PBKDF2-SHA-256"
    ) {
        throw new Error(
            "Unsupported identity KDF"
        );
    }

    console.log(
        "[IdentityService] Decrypting existing identity..."
    );

    const privateKey =
        await decryptIdentityPrivateKey(
            identity.encryptedPrivateKey,
            currentPassword,
            identity.salt,
            identity.iv,
            identity.kdfParams
        );

    console.log(
        "[IdentityService] Re-encrypting identity with new password..."
    );

    const encrypted =
        await encryptIdentityPrivateKey(
            privateKey,
            newPassword
        );

    return {
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
}


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
}


export function isIdentityUnlocked() {
    return currentIdentity !== null;
}