import { api } from '../../core/api.js';


const X25519_PUBLIC_KEY_LENGTH = 32;


/* =========================================================
 * Base64
 * ========================================================= */

function base64ToArrayBuffer(base64) {

    if (
        typeof base64 !== 'string' ||
        base64.length === 0
    ) {
        throw new Error(
            'Invalid public key'
        );
    }


    let binary;

    try {
        binary = atob(base64);
    } catch {
        throw new Error(
            'Invalid Base64 public key'
        );
    }


    const bytes =
        new Uint8Array(binary.length);


    for (
        let i = 0;
        i < binary.length;
        i++
    ) {
        bytes[i] =
            binary.charCodeAt(i);
    }


    return bytes;
}


/* =========================================================
 * Import X25519 public key
 * ========================================================= */

async function importPeerPublicKey(publicKey) {

    const keyBytes =
        base64ToArrayBuffer(publicKey);


    if (
        keyBytes.length !==
        X25519_PUBLIC_KEY_LENGTH
    ) {
        throw new Error(
            'Invalid X25519 public key length'
        );
    }


    return crypto.subtle.importKey(
        'raw',
        keyBytes,
        {
            name: 'X25519'
        },
        false,
        []
    );
}


/* =========================================================
 * Fetch peer public key
 * ========================================================= */

export async function getPeerPublicKey(
    userId
) {

    if (
        !Number.isInteger(Number(userId)) ||
        Number(userId) <= 0
    ) {
        throw new Error(
            'Invalid user ID'
        );
    }


    const data = await api(
        `/api/me/identity-key/${Number(userId)}`,
        {
            method: 'GET'
        }
    );


    if (
        !data ||
        typeof data.publicKey !== 'string'
    ) {
        throw new Error(
            'Invalid identity public key response'
        );
    }


    return importPeerPublicKey(
        data.publicKey
    );
}