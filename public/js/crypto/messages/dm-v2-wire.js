// public/js/crypto/messages/dm-v2-wire.js
//
// STEP 1B glue for DM text envelope v2. Everything CRYPTOGRAPHIC lives in
// dm-v2.js (1A) and is called from here unmodified. What is here is POLICY and
// STORAGE, which the design doc deliberately keeps out of the crypto module:
//
//   - version selection per peer        doc 5.4  (the sender picks, per peer)
//   - the layer-2 client pin            doc 5.2  (localStorage, refuses v1 to a pinned peer)
//   - the iv replay store               doc 4.3  (bounded, per conversation)
//   - the one-time "downgraded" notice  doc 5.2
//
// The three layers in doc 5, and which of them this file is:
//
//   5.1 server-authoritative floor   -> the users.dm_e2ee_min_version column (server)
//   5.2 client pin                  -> HERE
//   5.3 key separation + AAD        -> dm-v2.js (already true in 1A, nothing to add)
//
// Layer 3 is the one that actually makes a downgrade fail, and it needs nothing
// from the server. Layer 2 is the only thing that catches a FIRST-CONTACT
// downgrade, and only if this browser has seen the conversation before - doc 5.3
// and doc 7.1 say that plainly and so do we; see docs/DM_V2_WIRE.md.

import { getServerEndpoint } from '../../core/server.js';
import { getCurrentUser } from '../../core/auth.js';
import { getCurrentIdentity } from '../identity-service.js';
import { getPeerPublicKey, getPeerKeyCandidates, getPeerDmMinVersion } from '../keys/peer-keys.js';
import { mayTryRetiredKey, bytesToBase64, base64ToBytes } from '../keys/peer-trust.js';
import {
    DM_V2_VERSION,
    DM_V2_IV_LENGTH,
    deriveDmV2Key,
    senderKeyFingerprint,
    encryptDmV2,
    decryptDmV2,
    validateDmV2Envelope
} from './dm-v2.js';

/* =========================================================
 * Tunables (doc DM_V2_WIRE.md "Replay store sizing")
 * ========================================================= */

/**
 * Most msgIds remembered per conversation.
 *
 * One entry is `{"0123456789abcdef":1234}` = 16 (msgId) + ~8 (row id) + the JSON
 * quotes and colon = ~50 bytes of JSON string. 2000 of those is ~100 KB, or
 * ~200 KB if the browser counts localStorage in UTF-16 code units, against a
 * ~5 MB per-origin budget that also holds the pins and everything else in the
 * app. FIFO eviction, so an old message falls out of the window rather than the
 * store growing without bound - the server chooses how many messages arrive, so
 * an unbounded store would be an attacker-controlled memory leak.
 */
export const DM_V2_REPLAY_PER_CONV_MAX = 2000;

/**
 * Most conversations with a replay store at once. Above this the oldest
 * conversation's entries are dropped wholesale.
 */
export const DM_V2_REPLAY_MAX_CONVERSATIONS = 50;

/**
 * The server truncates DM `content` to this many characters
 * (controllers/dm.controller.js sendMessage/editMessage: content.trim().slice(0, 2000)).
 *
 * A v2 envelope is bigger than a v1 one (senderFp 44 base64 chars + msgId 16 +
 * two key names), so the plaintext budget is correspondingly smaller. Sending an
 * envelope that the server will truncate produces a row that cannot be decrypted
 * by anyone, ever - so the client refuses instead of sending one. This is a v1
 * bug too (a v1 message above ~1391 plaintext bytes already breaks); 1B does not
 * fix v1, it only stops v2 from creating a new instance of it.
 */
export const DM_V2_MAX_CONTENT_CHARS = 2000;

/**
 * Pure guard used by buildDmV2Content. Throws DmV2TooLargeError when the
 * serialised envelope would exceed the server's content cap.
 */
export function assertDmV2ContentFits(contentChars) {
    if (!Number.isInteger(Number(contentChars)) || Number(contentChars) < 0) {
        throw new DmV2TooLargeError(contentChars);
    }
    if (Number(contentChars) > DM_V2_MAX_CONTENT_CHARS) {
        throw new DmV2TooLargeError(contentChars);
    }
    return Number(contentChars);
}

const PIN_STORAGE_KEY = 'wire.dm.v2.pins';
// v2 = keyed by the AAD-bound iv. The old `wire.dm.v2.replay` key holds
// msgId -> row entries and must never be misread as iv -> row entries.
const REPLAY_STORAGE_KEY = 'wire.dm.v2.replay.v2';

/* =========================================================
 * Errors
 * ========================================================= */

/**
 * Sending v1 to a peer this browser has already exchanged v2 with (doc 5.2).
 *
 * Deliberately NOT a silent fallback: the caller shows this to the user. Layer 3
 * would make the downgrade fail anyway; refusing here means the user is told
 * instead of watching their message disappear.
 */
export class DmDowngradeRefusedError extends Error {
    constructor(peerId, pinned) {
        super(
            'Refusing to send a legacy-encrypted message to this conversation: ' +
            'this browser has already exchanged DM v2 here, and a server that ' +
            'asked for the old format is treated as a downgrade attempt.'
        );
        this.name = 'DmDowngradeRefusedError';
        this.code = 'DM_DOWNGRADE_REFUSED';
        this.peerId = Number(peerId);
        this.pinned = Number(pinned);
    }
}

/** The envelope would exceed the server's content cap, so it would arrive truncated. */
export class DmV2TooLargeError extends Error {
    constructor(length) {
        super(
            `Message is too long for DM v2: the encrypted envelope is ${length} ` +
            `characters and the server stores at most ${DM_V2_MAX_CONTENT_CHARS}. ` +
            'Shorten the message.'
        );
        this.name = 'DmV2TooLargeError';
        this.code = 'DM_V2_TOO_LARGE';
        this.length = Number(length);
    }
}

/* =========================================================
 * Storage keying
 *
 * `${serverEndpoint}|${localUserId}|${peerUserId}` - the same shape
 * account-kdf.js keys its scheme-2 pins with, so two accounts in one browser,
 * or one account against two servers, cannot see each other's state.
 * ========================================================= */

/**
 * The storage key for one conversation's pin and replay store.
 *
 * Pure, and exported so the collision property can be asserted directly rather
 * than inferred: two accounts on one server, or one account on two servers, must
 * never share a store.
 */
export function dmScopeKey(endpoint, ownUserId, peerId) {
    return `${String(endpoint ?? '')}|${String(Number(ownUserId) || '')}|${String(Number(peerId))}`;
}

function scopeKey(peerId) {
    let endpoint = '';
    try { endpoint = String(getServerEndpoint() || ''); } catch { /* not configured */ }
    let own = null;
    try { own = Number(getCurrentUser()?.id); } catch { /* not logged in */ }
    if (!Number.isInteger(own) || own <= 0) own = null;
    return dmScopeKey(endpoint, own, peerId);
}

function readJsonStore(key) {
    try {
        const raw = localStorage.getItem(key);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
        return {};
    }
}

/**
 * Write, and never throw into the UI.
 *
 * A full localStorage (QuotaExceededError) must not turn a message that was
 * perfectly encryptable into a send failure, so the write is best-effort: the
 * caller loses the pin/replay record, not the message.
 */
function writeJsonStore(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

/* =========================================================
 * Layer 2 - the client pin (doc 5.2)
 * ========================================================= */

function normaliseVersion(value) {
    const n = Number(value);
    // Anything missing, non-numeric, or below 1 is treated as "1": the pin is
    // hardening, and a corrupt pin must never make v2 unreachable.
    if (!Number.isInteger(n) || n < 1) return 1;
    return n > DM_V2_VERSION ? DM_V2_VERSION : n;
}

/**
 * The highest envelope version this browser has ever sent to or received from
 * `peerId`, or 1 when there is nothing recorded.
 *
 * Storage unavailable is a no-op that reports 1, which is the safe direction:
 * a pin we cannot read cannot block a send, and layer 3 still holds.
 */
export function readDmV2Pin(peerId) {
    try {
        return normaliseVersion(readJsonStore(PIN_STORAGE_KEY)[scopeKey(peerId)]);
    } catch {
        return 1;
    }
}

/** Record the highest version seen for a peer. Never lowers an existing pin. */
export function noteDmV2Version(peerId, version) {
    const v = normaliseVersion(version);
    if (v < DM_V2_VERSION) return readDmV2Pin(peerId);
    try {
        const pins = readJsonStore(PIN_STORAGE_KEY);
        const k = scopeKey(peerId);
        if (normaliseVersion(pins[k]) >= v) return normaliseVersion(pins[k]);
        pins[k] = v;
        writeJsonStore(PIN_STORAGE_KEY, pins);
    } catch {
        /* storage unavailable: the pin is hardening, not a requirement */
    }
    return v;
}

/**
 * Which version to SEND to this peer right now (doc 5.4).
 *
 * The sender picks, from local state plus the server's floor. No negotiation and
 * no capability exchange: the envelope is self-describing.
 *
 * @param {number} peerId
 * @param {number} peerMinVersion the peer's server-side dm_e2ee_min_version
 * @returns {number} 1 or 2
 */
export function chooseDmVersion(peerId, peerMinVersion) {
    if (readDmV2Pin(peerId) >= DM_V2_VERSION) {
        return DM_V2_VERSION;
    }
    return normaliseVersion(peerMinVersion) >= DM_V2_VERSION ? DM_V2_VERSION : 1;
}

/**
 * The send-side gate. Throws rather than falling back (doc 5.2).
 *
 * Called on the path where the caller has already decided to emit v1 - i.e. it is
 * the last line of defence, not the version chooser.
 */
export function assertDmVersionAllowed(peerId, version) {
    const pinned = readDmV2Pin(peerId);
    if (normaliseVersion(version) < DM_V2_VERSION && pinned >= DM_V2_VERSION) {
        throw new DmDowngradeRefusedError(peerId, pinned);
    }
}

/* =========================================================
 * iv replay store (doc 4.3; STEP 2A D3)
 *
 * A replay is the same iv on a DIFFERENT server row id. The iv is random per
 * message AND bound into the AAD, so unlike msgId the server cannot change it
 * without breaking decryption - that is what makes it the right replay key.
 * msgId stays in the envelope (format unchanged, existing rows stay readable)
 * but is no longer used for replay accounting: it is not in the AAD and the
 * server can swap it freely.
 *
 * The same row opened again - a reload, a scroll back, a held row released
 * after accepting a changed key, or an edit re-render (which carries a NEW iv,
 * so it is simply new) - is NOT a replay, and treating it as one is the bug
 * this shape exists to avoid.
 * ========================================================= */

export const DM_V2_IV_NEW = 'new';
export const DM_V2_IV_SAME_ROW = 'same-row';
export const DM_V2_IV_REPLAY = 'replay';

function normaliseRowId(rowId) {
    const n = Number(rowId);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

/**
 * The canonical base64 spelling of a 12-byte iv, or null when `iv` cannot be
 * one. Canonical so two spellings of the same nonce cannot occupy two entries.
 */
function canonicalIvBase64(iv) {
    if (typeof iv !== 'string' || !iv.length) return null;
    let bytes;
    try {
        bytes = base64ToBytes(iv);
    } catch {
        return null;
    }
    if (bytes.length !== DM_V2_IV_LENGTH) return null;
    return bytesToBase64(bytes);
}

/**
 * Classify an incoming (iv, rowId) pair and record it.
 *
 * Runs BEFORE any key is derived (doc 4.3 step 1), so a replayed message costs
 * no key derivation and cannot be opened even if every key is available.
 *
 * @param {number} peerId
 * @param {string} iv base64 of the 12-byte AAD-bound nonce
 * @param {number} rowId the stored row's id
 * @returns {'new'|'same-row'|'replay'}
 */
export function classifyDmV2Iv(peerId, iv, rowId) {
    const row = normaliseRowId(rowId);
    const nonce = canonicalIvBase64(iv);

    // No usable nonce or row id means the caller cannot distinguish a replay
    // from a re-read (a conversation-list preview has no row id of its own).
    // Refusing to account for it is the honest choice; the thread view, which
    // does have both, is where the check actually runs.
    if (!nonce || row === null) {
        return DM_V2_IV_NEW;
    }

    const storeKey = REPLAY_STORAGE_KEY;
    let store;
    try {
        store = readJsonStore(storeKey);
    } catch {
        return DM_V2_IV_NEW;
    }

    const k = scopeKey(peerId);
    let entries = store[k] && typeof store[k] === 'object' && !Array.isArray(store[k]) ? store[k] : null;
    if (!entries) {
        entries = {};
        store[k] = entries;
    }

    const known = entries[nonce];
    if (known !== undefined && known !== null) {
        return Number(known) === row ? DM_V2_IV_SAME_ROW : DM_V2_IV_REPLAY;
    }

    // Record, newest last so eviction is insertion-ordered FIFO.
    delete entries[nonce];
    entries[nonce] = row;

    const names = Object.keys(entries);
    while (names.length > DM_V2_REPLAY_PER_CONV_MAX) {
        delete entries[names.shift()];
    }

    // Bound the number of conversations too. Object key order is insertion order
    // for string keys, which is what makes this the oldest-conversation-first.
    const scopes = Object.keys(store);
    while (scopes.length > DM_V2_REPLAY_MAX_CONVERSATIONS) {
        const oldest = scopes.shift();
        if (oldest !== k) delete store[oldest];
        else break;
    }

    writeJsonStore(storeKey, store);
    return DM_V2_IV_NEW;
}

/* =========================================================
 * Downgrade notice (doc 5.2)
 *
 * A v1 envelope from a peer this browser is pinned at >= 2 with is still
 * decrypted - history is not the attack - but the user is told ONCE per
 * conversation per page load.
 * ========================================================= */

const noticedDowngrades = new Set();

/** @returns {boolean} true the first time for this conversation in this page load. */
export function takeDmDowngradeNotice(peerId) {
    const k = scopeKey(peerId);
    if (noticedDowngrades.has(k)) return false;
    noticedDowngrades.add(k);
    return true;
}

/** Test seam: forget which conversations have already been flagged. */
export function resetDmDowngradeNotices() {
    noticedDowngrades.clear();
}

/* =========================================================
 * Key selection for receive
 * ========================================================= */

async function importX25519(publicKeyB64) {
    return crypto.subtle.importKey(
        'raw',
        base64ToBytes(publicKeyB64),
        { name: 'X25519' },
        false,
        []
    );
}

/**
 * Which of the sender's keys opens this envelope, and the fingerprint it had.
 *
 * For a peer's message: the current key if its fingerprint matches, otherwise an
 * ARCHIVED key whose fingerprint matches AND which this device is allowed to try
 * (mayTryRetiredKey - the Phase 2 rule, unchanged).
 *
 * For our OWN message: our own CURRENT key. An own rotation therefore makes our
 * older v2 rows unreadable - doc 4.4, and docs/test-baseline.md, say so, and
 * adding escrow for it is out of scope.
 */
async function selectSenderKey(payload, peerId, ownUserId) {
    const identity = getCurrentIdentity();
    if (!identity || !identity.privateKey) {
        throw new Error('Identity is not unlocked');
    }

    const wantFp = payload.senderFp;

    if (Number(payload.senderId) === Number(ownUserId)) {
        const ownBytes = base64ToBytes(identity.publicKey);
        return {
            rawPublicKey: identity.publicKey,
            fingerprint: bytesToBase64(await senderKeyFingerprint(ownBytes)),
            imported: await importX25519(identity.publicKey)
        };
    }

    const candidates = await getPeerKeyCandidates(peerId);
    const ordered = [candidates.current, ...candidates.history].filter(
        (k) => typeof k === 'string' && k.length > 0
    );

    for (const publicKey of ordered) {
        const fp = bytesToBase64(await senderKeyFingerprint(base64ToBytes(publicKey)));
        if (fp !== wantFp) continue;

        if (publicKey !== candidates.current) {
            // An archived key is only tried when this device previously accepted
            // it, or has no pin at all. Unchanged Phase 2 rule.
            let allowed = true;
            try {
                const { getServerEndpoint: endpointOf } = await import('../../core/server.js');
                const origin = endpointOf();
                if (origin && Number.isInteger(Number(ownUserId)) && Number(ownUserId) > 0) {
                    const verdict = await mayTryRetiredKey(peerId, publicKey, {
                        origin: String(origin),
                        ownUserId: Number(ownUserId)
                    });
                    allowed = !!verdict.allowed;
                }
            } catch {
                allowed = true;
            }
            if (!allowed) continue;
        }

        return {
            rawPublicKey: publicKey,
            fingerprint: fp,
            imported: await importX25519(publicKey)
        };
    }

    const err = new Error(
        'No usable sender key for this message: the key it was encrypted to is ' +
        'not the peer\'s current key and is not one this device may try.'
    );
    err.code = 'DM_V2_NO_SENDER_KEY';
    throw err;
}

/* =========================================================
 * Send
 * ========================================================= */

/**
 * Encrypt one DM text message as a v2 envelope, ready for `content`.
 *
 * @param {object} o
 * @param {string} o.plaintext
 * @param {number} o.senderId
 * @param {number} o.recipientId
 * @param {number} [o.replyToId] 0 when absent; MUST be the value the server will keep
 * @returns {Promise<{envelope: object, msgId: string, contentChars: number}>}
 */
export async function buildDmV2Content({ plaintext, senderId, recipientId, replyToId = 0 } = {}) {
    const identity = getCurrentIdentity();
    if (!identity || !identity.privateKey) {
        throw new Error('Identity is not unlocked');
    }

    const senderFp = await senderKeyFingerprint(base64ToBytes(identity.publicKey));
    const peerPublicKey = await getPeerPublicKey(recipientId);
    const key = await deriveDmV2Key(senderId, recipientId, identity.privateKey, peerPublicKey);

    const { envelope, msgId } = await encryptDmV2({
        plaintext,
        fromUserId: senderId,
        toUserId: recipientId,
        senderKeyFp: senderFp,
        key,
        replyToId
    });

    const content = JSON.stringify(envelope);
    // Refuse rather than send something the server will truncate: a truncated
    // envelope is undecryptable by anyone, forever.
    assertDmV2ContentFits(content.length);

    return { envelope, msgId, content, contentChars: content.length };
}

/* =========================================================
 * Receive
 * ========================================================= */

/**
 * Open a received v2 envelope.
 *
 * Order matters and follows doc 4.3: the msgId replay check happens BEFORE any
 * key is derived. Everything after that is the ordinary try-the-key path.
 *
 * @param {object} o
 * @param {object} o.payload the envelope as received
 * @param {number} o.peerId
 * @param {number} o.ownUserId
 * @param {number} [o.replyToId] the STORED row's reply_to_id, 0 when absent
 * @param {number} [o.rowId] the stored row's id, for replay accounting
 * @returns {Promise<{plaintext: string, msgId: string, replay: string}>}
 */
export async function openDmV2Envelope({ payload, peerId, ownUserId, replyToId = 0, rowId = null } = {}) {
    const validated = validateDmV2Envelope(payload);

    // 1. replay check, before any key derivation. The key is the AAD-bound iv,
    //    not the msgId: the server controls msgId (it is not in the AAD) and can
    //    swap it freely, while changing the iv breaks decryption outright.
    const verdict = classifyDmV2Iv(peerId, validated.iv, rowId);
    if (verdict === DM_V2_IV_REPLAY) {
        const err = new Error(
            'Dropped as a replay: this iv already arrived on a different message.'
        );
        err.code = 'DM_V2_REPLAY';
        err.iv = validated.iv;
        throw err;
    }

    // 2. pick the sender key whose fingerprint the envelope names.
    const sender = await selectSenderKey(validated, peerId, ownUserId);

    // 3. derive the directional key for THIS direction and open it.
    const peerPublicKey = Number(validated.senderId) === Number(ownUserId)
        ? await getPeerPublicKey(peerId)
        : sender.imported;

    const key = await deriveDmV2Key(
        validated.senderId,
        validated.recipientId,
        getCurrentIdentity().privateKey,
        peerPublicKey
    );

    // decryptDmV2() re-validates and expects the WIRE shape
    // ({encryption:{...}, senderId, recipientId}). `validated` is the
    // NORMALISED shape validateDmV2Envelope RETURNS, which is FLAT
    // ({version, iv, ciphertext, senderFp, msgId, senderId, recipientId}) and has
    // no `encryption` key - so passing it back in made the second validation
    // throw "Missing encryption payload" and EVERY real v2 decrypt failed.
    // Hand decryptDmV2 the ORIGINAL envelope and let it do its own check.
    const plaintext = await decryptDmV2({
        envelope: payload,
        senderKeyFp: base64ToBytes(sender.fingerprint),
        key,
        replyToId
    });

    return { plaintext, msgId: validated.msgId, replay: verdict };
}

/* =========================================================
 * Introspection helpers used by the UI and the tests
 * ========================================================= */

export function envelopeVersion(payload) {
    const v = Number(payload?.encryption?.version);
    return Number.isInteger(v) ? v : null;
}

export function isDmV2Envelope(payload) {
    return envelopeVersion(payload) === DM_V2_VERSION;
}

export { getPeerDmMinVersion };