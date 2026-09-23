// ============================================================
// FCM push sending for backgrounded/killed Android devices.
// ------------------------------------------------------------
// This is entirely optional and entirely separate from Socket.IO
// delivery. If Firebase Admin isn't installed or configured, every
// function here silently no-ops — nothing about the existing Socket.IO
// DM path (services/socket.service.js's emitNewDirectMessage) changes,
// and no fake/placeholder credentials are ever used.
//
// ------------------------------------------------------------
// Data-only payload (no top-level `notification` block)
// ------------------------------------------------------------
// This used to send a `notification` block and let Android's OS
// auto-display it. That's no longer enough: the app needs to show
// the sender's avatar as a large icon, use its own monochrome status
// -bar icon, group multiple DMs, and skip showing anything at all
// while the app is foregrounded (a data-only message is delivered to
// onMessageReceived() in every app state, unlike a `notification`
// -block message, which the OS intercepts and auto-displays without
// running any app code — exactly the behavior that made avatars/
// grouping impossible before). All of that now happens in the native
// android/.../WireFirebaseMessagingService, not here. See that file
// and notifications/PLATFORM-NOTES.md for the full picture, including
// why native E2EE decryption of the message text is NOT implemented
// (the identity keypair lives in the WebView's IndexedDB —
// public/js/crypto/storage.js — which a killed app's native code
// cannot reach).
//
// See notifications/PLATFORM-NOTES.md (public/js/notifications/) for
// the exact Firebase Console + environment setup this needs.
// ============================================================

const {
  getApps,
  getApp,
  initializeApp,
  applicationDefault,
} = require('firebase-admin/app');

const { getMessaging } = require('firebase-admin/messaging');

const {
  getPushTokensForUser,
  deletePushTokenByValue,
} = require('./pushToken.service');

const { signPushAvatarToken } = require('../utils/jwt');
const constants = require('../config/constants');

let firebaseApp = null;
let initAttempted = false;

function tryInitFirebase() {
  if (initAttempted) return firebaseApp;
  initAttempted = true;

  // firebase-admin's applicationDefault() uses
  // GOOGLE_APPLICATION_CREDENTIALS when it is set to the path of a
  // service-account JSON file.
  //
  // Nothing here invents, generates, or commits any credential.
  // If it is unset, push is simply disabled.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn(
      '[Push] GOOGLE_APPLICATION_CREDENTIALS is not set — FCM push notifications ' +
        'are disabled. DMs still deliver normally over Socket.IO to any connected ' +
        'client. See notifications/PLATFORM-NOTES.md to enable push for ' +
        'backgrounded/killed Android devices.'
    );

    return null;
  }

  try {
    // Firebase Admin SDK v14 uses modular entry points.
    //
    // Do not use the removed legacy namespace API:
    //   require('firebase-admin')
    //   admin.apps
    //   admin.credential
    //   admin.messaging()
    //
    // applicationDefault() reads GOOGLE_APPLICATION_CREDENTIALS and
    // authenticates using the service-account JSON file.
    firebaseApp = getApps().length
      ? getApp()
      : initializeApp({
          credential: applicationDefault(),
        });

    console.log(
      '[Push] Firebase Admin initialized — FCM push notifications enabled.'
    );
  } catch (e) {
    console.error(
      '[Push] Failed to initialize Firebase Admin:',
      {
        name: e?.name || 'Error',
        code: e?.code || 'unknown',
        message: e?.message || 'Unknown error',
      }
    );

    firebaseApp = null;
  }

  return firebaseApp;
}

// Every field here is either already public within the conversation
// (sender id/name, the fact that *a* message exists) or a
// non-sensitive category derived from plaintext DB columns
// (has_attachment / attachment_mime / is_voice_message — never
// decrypted). Text message content is end-to-end encrypted (see
// dm.controller.js's sendMessage — `content` stored there is the
// client's ciphertext); the server cannot read it and must not guess
// at it, so a plain text message gets a generic preview here. This is
// the one place the push preview differs from the rich, real preview
// notification-manager.js's buildPreview() shows for a live,
// already-decrypted app — see PLATFORM-NOTES.md for this tradeoff.
//
// "category" is a coarse machine-readable hint (for the native side
// to pick an icon/behavior) alongside the same human-readable string.
function buildSafePushPreview(message) {
  if (message.is_voice_message) {
    return { preview: '🎤 Voice message', category: 'voice' };
  }

  if (message.has_attachment) {
    const mime = message.attachment_mime || '';

    if (mime.startsWith('image/')) return { preview: '📷 Photo', category: 'photo' };
    if (mime.startsWith('video/')) return { preview: '🎞️ Video', category: 'video' };
    if (mime.startsWith('audio/')) return { preview: '🎤 Voice message', category: 'voice' };

    return { preview: '📎 File', category: 'file' };
  }

  return { preview: 'Sent you a message', category: 'text' };
}

// Grouping/tag key: one per CONVERSATION (not per message), so the
// native side can bundle multiple DMs from the same sender under one
// Android notification group instead of stacking a separate one per
// message. See notification-manager.js's androidNotificationIdForMessage()
// for the (unrelated) per-message id still used by Local Notifications
// elsewhere in the app — this is deliberately a different, coarser key.
function androidNotificationTag(conversationId) {
  return `wire-dm-${Math.abs(Number(conversationId) % 2147483647)}`;
}

// Builds an absolute, short-lived, single-user-scoped avatar URL for
// the FCM payload — or null if either there's nothing to point at
// (no avatar) or nowhere externally-reachable to point it at
// (PUBLIC_BASE_URL unset). Never the raw avatar_path, and never any
// form of the sender's long-lived session token — see
// middleware/mediaAuth.js's avatarMediaAuth and utils/jwt.js's
// signPushAvatarToken for the scope this token is limited to.
function buildAvatarUrl(message) {
  if (!constants.PUBLIC_BASE_URL) return null;
  if (!message.sender_avatar_path) return null;

  const token = signPushAvatarToken(message.sender_id);

  return `${constants.PUBLIC_BASE_URL}/api/me/avatar/${message.sender_id}?token=${encodeURIComponent(token)}`;
}

// Called from services/socket.service.js's emitNewDirectMessage() —
// the one existing choke point for every outgoing DM — right
// alongside the existing Socket.IO emit, never instead of it. Never
// awaited by the caller (fire-and-forget): a slow or failing push
// must never delay or break real-time delivery to a connected client.
async function sendDmPush(message) {
  const app = tryInitFirebase();
  if (!app) return;

  let tokens;

  try {
    tokens = getPushTokensForUser(message.recipient_id);
  } catch (e) {
    console.error('[Push] Failed to load push tokens:', e.message);
    return;
  }

  if (!tokens.length) return;

  const { preview, category } = buildSafePushPreview(message);
  const tag = androidNotificationTag(message.sender_id);
  const avatarUrl = buildAvatarUrl(message);
  const messaging = getMessaging(app);

  // Deliberately data-only — no top-level `notification` block. See
  // the header comment above for why: avatar/grouping/icon/
  // foreground-suppression all need the native
  // WireFirebaseMessagingService to run its own code for every
  // message, which a `notification`-block push would skip whenever
  // the OS auto-displays it.
  //
  // Every field here is either already public within the
  // conversation, or (avatarUrl) scoped and short-lived enough that
  // a leak only exposes one user's profile picture for a few hours.
  // Deliberately absent: plaintext content, ciphertext, access
  // tokens, private keys, session/identity key state.
  const dataPayload = {
    conversationId: String(message.sender_id),
    senderId: String(message.sender_id),
    senderName: message.sender_username || '',
    messageId: String(message.id),
    preview,
    category,
    tag,
  };

  if (avatarUrl) {
    dataPayload.avatarUrl = avatarUrl;
  }

  const results = await Promise.allSettled(
    tokens.map(({ token }) =>
      messaging.send({
        token,
        data: dataPayload,

        android: {
          priority: 'high',
          // No `android.notification` block either — that would
          // also trigger OS auto-display for a message that, per
          // the FCM spec, already carries a `data` payload. Keeping
          // this purely data-only is what guarantees exactly one
          // code path (the native service) ever decides whether/how
          // to show something.
        },
      })
    )
  );

  results.forEach((result, i) => {
    if (result.status !== 'rejected') return;

    // Never log the token itself — only the SDK's error code.
    const code =
      result.reason &&
      result.reason.errorInfo &&
      result.reason.errorInfo.code;

    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      deletePushTokenByValue(tokens[i].token);
    } else {
      console.error(
        '[Push] Send failed:',
        code || 'unknown_error'
      );
    }
  });
}

module.exports = {
  sendDmPush,
};
