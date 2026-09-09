import {
    createEncryptedIdentity,
    restoreIdentityFromServer,
} from "./identity.js";


const IDENTITY_ENDPOINT = "/api/me/identity-key";


let currentIdentity = null;


/* =========================================================
 * Internal helpers
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


async function fetchIdentity(token) {

    requireToken(token);

    const response = await fetch(
        IDENTITY_ENDPOINT,
        {
            method: "GET",

            headers: {
                "Authorization": `Bearer ${token}`
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
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
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
                message = data.error;
            }

        } catch {
            // Ignore invalid error responses.
        }


        throw new Error(message);
    }


    const data =
        await response.json();


    if (data?.success !== true) {

        throw new Error(
            "Server did not confirm identity save"
        );
    }
}


/* =========================================================
 * Create new identity
 * ========================================================= */

export async function createIdentity(
    passphrase,
    token
) {

    requireToken(token);


    if (
        typeof passphrase !== "string" ||
        passphrase.length === 0
    ) {
        throw new Error(
            "Identity passphrase is required"
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
            passphrase
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


    return {
        publicKey:
            currentIdentity.publicKey
    };
}


/* =========================================================
 * Restore existing identity
 * ========================================================= */

export async function restoreIdentity(
    passphrase,
    token
) {

    requireToken(token);


    if (
        typeof passphrase !== "string" ||
        passphrase.length === 0
    ) {
        throw new Error(
            "Identity passphrase is required"
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
            passphrase
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


    return {
        publicKey:
            currentIdentity.publicKey
    };
}


/* =========================================================
 * Initialize identity
 * ========================================================= */

export async function initializeIdentity(
    passphrase,
    token
) {

    requireToken(token);


    const identity =
        await fetchIdentity(token);


    if (identity.exists) {

        return restoreIdentity(
            passphrase,
            token
        );
    }


    return createIdentity(
        passphrase,
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


/* =========================================================
 * Lock identity
 * ========================================================= */

export function lockIdentity() {

    currentIdentity = null;
}


/* =========================================================
 * State
 * ========================================================= */

export function isIdentityUnlocked() {

    return currentIdentity !== null;
}