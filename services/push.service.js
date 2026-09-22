// ============================================================
// FCM push sending for backgrounded/killed Android devices.
// ------------------------------------------------------------
// This is entirely optional and entirely separate from Socket.IO
// delivery. If Firebase Admin isn't installed or configured, every
// function here silently no-ops — nothing about the existing Socket.IO
// DM path (services/socket.service.js's emitNewDirectMessage) changes,
// and no fake/placeholder credentials are ever used.
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
function buildSafePushPreview(message) {
  if (message.is_voice_message) return '🎤 Voice message';

  if (message.has_attachment) {
    const mime = message.attachment_mime || '';

    if (mime.startsWith('image/')) return '📷 Photo';
    if (mime.startsWith('video/')) return '🎞️ Video';
    if (mime.startsWith('audio/')) return '🎤 Voice message';

    return '📎 File';
  }

  return 'Sent you a message';
}

// Same derivation as the frontend's
// notifications/notification-manager.js:androidNotificationIdForMessage() —
// kept as a small best-effort measure so a Local Notification and an
// FCM-displayed notification for the same message share an
// identifier, but see that function's own comment and
// PLATFORM-NOTES.md: whether Android's notification manager actually
// collapses these into one hasn't been verified on a real device, and
// the visibility-based guard in dispatchToCapacitor() is the
// mechanism this design actually relies on to avoid double-notifying.
function androidNotificationTag(messageId) {
  return `wire-dm-${Math.abs(Number(messageId) % 2147483647)}`;
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

  const preview = buildSafePushPreview(message);
  const tag = androidNotificationTag(message.id);
  const messaging = getMessaging(app);

  const results = await Promise.allSettled(
    tokens.map(({ token }) =>
      messaging.send({
        token,

        notification: {
          title: message.sender_username || 'New message',
          body: preview,
        },

        // Everything Android needs to route a tap to the right DM.
        // Deliberately no ciphertext, tokens, or identity/session data.
        data: {
          conversationId: String(message.sender_id),
          senderId: String(message.sender_id),
          senderName: message.sender_username || '',
          messageId: String(message.id),
          preview,
        },

        android: {
          priority: 'high',

          notification: {
            channelId: 'wire-dm',
            tag,
          },
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