const STORAGE_KEY = 'wire_identity_key';


function isValidIdentityData(data) {
    return (
        data &&
        typeof data === 'object' &&
        typeof data.publicKey === 'string' &&
        typeof data.privateKey === 'string'
    );
}


/**
 * Store an exported identity keypair locally.
 *
 * @param {object} keyData
 */
export function saveIdentityKey(
    keyData
) {
    if (!isValidIdentityData(keyData)) {
        throw new Error(
            'Invalid identity key data'
        );
    }

    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(keyData)
    );
}


/**
 * Load the locally stored identity keypair.
 *
 * @returns {object|null}
 */
export function loadIdentityKey() {
    const stored =
        localStorage.getItem(
            STORAGE_KEY
        );

    if (!stored) {
        return null;
    }

    try {
        const data =
            JSON.parse(stored);

        if (!isValidIdentityData(data)) {
            localStorage.removeItem(
                STORAGE_KEY
            );

            return null;
        }

        return data;

    } catch {
        localStorage.removeItem(
            STORAGE_KEY
        );

        return null;
    }
}


/**
 * Remove the locally stored identity keypair.
 */
export function clearIdentityKey() {
    localStorage.removeItem(
        STORAGE_KEY
    );
}