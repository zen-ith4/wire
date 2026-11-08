// public/js/chat/dm-unencrypted.js
//
// What happens to a DM row with nothing sealed in it.
//
// Every other row proves something: it opens under a key in this device's pin, or it
// fails. A row whose text is not an envelope, or whose file has no encrypted
// metadata, opens under nothing, so it is whatever the server says it is, "from your
// verified contact" included. The key gate cannot reach it, because there is no key
// to check.
//
// Honestly, such a row can only be history from before end-to-end encryption: the
// composer seals everything, and the server refuses text that is not sealed
// (controllers/dm.controller.js). So:
//
//   - A contact this device has never seen a row open from: shown, always marked.
//     Nothing says this conversation was ever encrypted.
//   - Older than the oldest row this device has seen open (the pin's encryptedFloor):
//     it may be that history. Shown, always marked.
//   - Anything else is not history. Hidden, with none of it rendered.
//
// The server also picks row ids and page order, so an id alone cannot make a row
// history. A row that arrives live, or sits after a sealed row in its page, is new
// whatever id it claims. What that leaves a server is a row claiming to be older than
// everything loaded, shown at the top of the page and marked. docs/SECURITY_CLAIMS.md
// states that limit, and the price of the rule: an honest plaintext row newer than
// the line, which only a client from before encryption could have written, is hidden.

import { getPeerTrustContext } from '../crypto/keys/peer-key-gate.js';
import { getPeerPin, noteEncryptedRow } from '../crypto/keys/peer-trust.js';

export const HIDDEN_UNENCRYPTED_TEXT = 'Message hidden: it was not encrypted';

const NOT_ENCRYPTED_LABEL = 'Not encrypted';

// A line of its own under the message. A joined row hides its meta line, and the first
// row of a short thread starts under the floating header, and a server can arrange
// both. So the mark goes in neither place.
export const NOT_ENCRYPTED_MARK_HTML = `<div class="dm-not-encrypted" title="This message has no encryption, so Wire can't confirm who wrote it.">${NOT_ENCRYPTED_LABEL}</div>`;

// The server writes these itself for a row with a file and no caption
// (getConversationsHandler). No one authored them, and marking them would put
// "Not encrypted" on every encrypted file in the list.
const SERVER_FILE_PREVIEWS = new Set(['🎤 Voice message', '📎 Attachment']);

/** This row is not being shown, and none of it may be. Nothing else went wrong. */
export class DmRowNotEncryptedError extends Error {
  constructor(rowId) {
    super(`DM ${rowId} is not encrypted and cannot be old history`);
    this.name = 'DmRowNotEncryptedError';
    this.code = 'DM_ROW_NOT_ENCRYPTED';
  }
}

export function parseDmPayload(content) {
  if (typeof content !== 'string') {
    return null;
  }

  try {
    const payload = JSON.parse(content);

    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      payload.encryption &&
      typeof payload.encryption === 'object'
    ) {
      return payload;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Is there anything in this row, or this reply_to, that is not sealed?
 *
 * One unsealed part makes it the whole row's answer: a real envelope with a file of
 * the server's own beside it is still a row the server wrote part of.
 */
export function isUnencryptedDmRow(row) {
  if (!row) return false;

  // Not just "truthy": the thread renders String(content), so a 0 or a false from the
  // server would show as text too.
  const hasText = row.content !== null && row.content !== undefined && row.content !== '';
  const textUnsealed = hasText && !parseDmPayload(row.content);
  const hasFile = !!(row.has_attachment || row.attachment_name);
  const fileSealed = typeof row.attachment_meta === 'string' && !!row.attachment_meta;

  return textUnsealed || (hasFile && !fileSealed);
}

/**
 * Where a page stops being able to hold old history: the first row with something
 * sealed in it, or -1. An edited row counts like any other, because `edited_at` is the
 * server's to set, and leaving those rows out would be a way to switch this off. The
 * cost is that real old rows after someone's edit of an older one, in the same page,
 * are hidden.
 */
export function firstSealedRowIndex(rows) {
  return rows.findIndex(
    (row) =>
      !!row &&
      !isUnencryptedDmRow(row) &&
      !!(row.content || row.attachment_meta)
  );
}

/**
 * A row just opened under a pinned key, so this conversation was encrypted at least
 * this far back. Never throws: a row that opened still has to show, and with nothing
 * recorded the worst case is a forged row being marked rather than hidden.
 */
export async function noteOpenedDmRow(peerId, row) {
  // An edit re-seals an old row, so its id does not say when this conversation became
  // encrypted, and counting it would hide all the real history newer than it. A server
  // that marks rows edited to keep them from counting only withholds evidence, which
  // it can do by withholding the rows.
  if (row.edited_at) return;

  const rowId = Number(row.id);
  if (!Number.isInteger(rowId) || rowId <= 0) return;

  try {
    const context = await getPeerTrustContext();
    if (context) await noteEncryptedRow(peerId, rowId, context);
  } catch (e) {
    console.warn('Could not record an opened DM row:', e);
  }
}

/**
 * May this unsealed row be shown (marked), or must it be hidden?
 *
 * `arrivedNow` is for a row that cannot be history whatever id it claims: delivered
 * live, or found after a sealed row in its page. Fails closed: with no way to read the
 * pin there is no way to say this conversation was never encrypted.
 */
export async function mayShowUnencryptedRow(peerId, rowId, { arrivedNow = false } = {}) {
  let floor;

  try {
    const context = await getPeerTrustContext();
    if (!context) return false;
    floor = (await getPeerPin(peerId, context))?.encryptedFloor;
  } catch {
    return false;
  }

  if (!Number.isInteger(floor)) return true;
  if (arrivedNow) return false;

  const id = typeof rowId === 'number' ? rowId : NaN;
  return Number.isInteger(id) && id > 0 && id < floor;
}

/**
 * The reply_to a thread row may render, for a quote with nothing sealed in it.
 *
 * A quote is a way to put words in a real message's mouth: a sealed "yes, I agree"
 * under a quote the server wrote. It is judged by the id the row itself points at,
 * which on a v2 row is sealed, so the server cannot give a swapped quote an old id.
 * Only fixed fields are kept, and the mark goes in the text, so a file name the
 * server chose never reaches the screen.
 */
export async function judgeQuotedRow(peerId, msg) {
  const quote = msg.reply_to;

  if (!isUnencryptedDmRow(quote)) {
    return quote;
  }

  const rowId = Number(quote.id) === Number(msg.reply_to_id) ? Number(quote.id) : null;
  // A real envelope beside an unsealed file gets the same text as a bare file: the raw
  // envelope must never reach the screen.
  const text = quote.content && !parseDmPayload(quote.content) ? quote.content : 'file';
  const content = (await mayShowUnencryptedRow(peerId, rowId))
    ? `${NOT_ENCRYPTED_LABEL}: ${text}`
    : HIDDEN_UNENCRYPTED_TEXT;

  return { id: quote.id, username: quote.username, content, has_attachment: false };
}

/**
 * The conversation list's text for a last message that is not an envelope.
 *
 * The preview is the newest row, so it can never be old history, and no id it claims
 * is asked for.
 */
export async function unencryptedPreview(peerId, text) {
  if (SERVER_FILE_PREVIEWS.has(text)) {
    return text;
  }

  return (await mayShowUnencryptedRow(peerId, null))
    ? `${NOT_ENCRYPTED_LABEL}: ${text}`
    : HIDDEN_UNENCRYPTED_TEXT;
}
