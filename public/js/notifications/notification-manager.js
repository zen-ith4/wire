// ============================================================
// DM notification manager
// ------------------------------------------------------------
// This is the one place that decides whether a new DM should
// produce a system notification.
//
// Platform behavior:
//
//   Android / Capacitor
//     - Foreground: NO system notification.
//       The message is already visible inside the app.
//     - Background: FCM is responsible for the system notification.
//       This module never creates a Local Notification.
//     - Killed: FCM/Android is responsible for the system notification.
//
//   Electron
//     - Uses the native Electron notification bridge.
//
//   Browser / PWA
//     - Uses the Web Notification API.
//
// Android intentionally does NOT use LocalNotifications for incoming
// DMs. FCM owns background/killed delivery, while Socket.IO owns
// real-time foreground delivery.
//
// Called from chat/dm.js's addDmMessage(), which is already the
// single choke point every incoming/outgoing DM passes through.
// ============================================================

import { getCurrentUser } from '../core/auth.js';
import { isNativeApp } from '../core/server.js';
import { navigate } from '../core/router.js';
import { isVoiceMessage } from '../media/voice-message.js';
import { getAvatarUrl } from '../ui/avatar.js';
import {
  isWebNotificationSupported,
  showWebNotification,
} from './web-notifications.js';

const SETTING_STORAGE_KEY = 'wire-dm-notifications';

function notifWarn(...args) {
  console.warn('[Wire][Notifications]', ...args);
}

// ------------------------------------------------------------
// Capacitor plugin helper
// ------------------------------------------------------------
//
// IMPORTANT:
// push-registration.js has its own private getCapacitorPlugin()
// helper because ES modules do not share private functions between
// files.
//
// This module needs its own helper for notification click routing.
// Never assume a function declared in another module is globally
// available.
// ------------------------------------------------------------

function getCapacitorPlugin(name) {
  try {
    if (
      typeof window === 'undefined' ||
      !window.Capacitor
    ) {
      return null;
    }

    const plugins = window.Capacitor.Plugins;

    if (!plugins) {
      return null;
    }

    return plugins[name] || null;
  } catch (e) {
    notifWarn(
      `Failed to access Capacitor plugin "${name}":`,
      e
    );

    return null;
  }
}

// ------------------------------------------------------------
// Setting
// ------------------------------------------------------------

export function getDmNotificationsEnabled() {
  try {
    // Default ON.
    return localStorage.getItem(SETTING_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setDmNotificationsEnabled(enabled) {
  const value = enabled === true;

  try {
    localStorage.setItem(
      SETTING_STORAGE_KEY,
      value ? 'on' : 'off'
    );
  } catch {
    // Non-fatal. The setting simply won't survive a reload.
  }

  return value;
}

// ------------------------------------------------------------
// Lightweight, bounded de-duplication.
//
// addDmMessage() already deduplicates messages at the conversation
// level. This is a second independent guard specifically for
// notifications.
//
// The set is bounded so a long-running session cannot accumulate
// message IDs forever.
// ------------------------------------------------------------

const notifiedMessageIds = new Set();
const MAX_TRACKED_IDS = 200;

function alreadyNotified(messageId) {
  return notifiedMessageIds.has(messageId);
}

function markNotified(messageId) {
  if (notifiedMessageIds.size >= MAX_TRACKED_IDS) {
    const oldest = Array.from(notifiedMessageIds).slice(
      0,
      MAX_TRACKED_IDS / 2
    );

    oldest.forEach((id) =>
      notifiedMessageIds.delete(id)
    );
  }

  notifiedMessageIds.add(messageId);
}

// ------------------------------------------------------------
// Foreground detection
// ------------------------------------------------------------

function isAppForeground() {
  return (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  );
}

// ------------------------------------------------------------
// The notification decision.
//
// Android-specific rule:
//
// If the Capacitor Android app is currently foregrounded, NEVER
// create a system notification.
//
// This is deliberately broader than "active conversation":
//
//   - DM currently open       -> no notification
//   - Different DM open       -> no notification
//   - Settings open           -> no notification
//   - Files/settings/profile  -> no notification
//
// The user is already inside the app, so Socket.IO/UI delivery is
// sufficient.
//
// When Android is backgrounded, this function may still return true
// because Socket.IO can remain alive briefly. dispatchToPlatform()
// deliberately does nothing for Capacitor Android. FCM owns the
// actual background/killed system notification.
//
// Electron and browser keep their previous behavior.
// ------------------------------------------------------------

export function shouldNotifyDM(
  message,
  isActiveConversation
) {
  const currentUser = getCurrentUser();

  if (!currentUser || !message) {
    return false;
  }

  // Never notify about our own messages.
  if (
    Number(message.sender_id) ===
    Number(currentUser.id)
  ) {
    return false;
  }

  if (!getDmNotificationsEnabled()) {
    return false;
  }

  if (alreadyNotified(message.id)) {
    return false;
  }

  // ----------------------------------------------------------
  // Capacitor Android
  // ----------------------------------------------------------
  //
  // If the app is visible, there must be NO system notification
  // anywhere in the Android app, regardless of which screen/DM
  // is currently open.
  //
  // Background/killed notification delivery belongs to FCM.
  // ----------------------------------------------------------

  if (
    isNativeApp() &&
    isAppForeground()
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // Other platforms
  // ----------------------------------------------------------
  //
  // Keep the original behavior:
  // if the exact conversation is already open and the app is
  // foregrounded, stay silent.
  //
  // Backgrounded/unfocused or another conversation -> notify.
  // ----------------------------------------------------------

  if (
    isActiveConversation &&
    isAppForeground()
  ) {
    return false;
  }

  return true;
}

// ------------------------------------------------------------
// Notification preview text
// ------------------------------------------------------------

const MAX_PREVIEW_LENGTH = 120;

function buildPreview(message) {
  if (isVoiceMessage(message)) {
    return '🎤 Voice message';
  }

  if (message.has_attachment) {
    const mime =
      message.attachment_mime || '';

    if (mime.startsWith('image/')) {
      return '📷 Photo';
    }

    if (mime.startsWith('video/')) {
      return '🎞️ Video';
    }

    if (mime.startsWith('audio/')) {
      return '🎤 Voice message';
    }

    return '📎 File';
  }

  const text =
    typeof message.content === 'string'
      ? message.content
      : '';

  const trimmed = text.trim();

  if (!trimmed) {
    return '';
  }

  return trimmed.length > MAX_PREVIEW_LENGTH
    ? `${trimmed.slice(
        0,
        MAX_PREVIEW_LENGTH - 1
      )}…`
    : trimmed;
}

// ------------------------------------------------------------
// Entry point
//
// Called from addDmMessage() for every message after it has been
// decrypted and deduplicated.
//
// Android foreground messages return before this function is
// reached because shouldNotifyDM() returns false.
//
// Android background messages can reach here if Socket.IO is still
// alive, but dispatchToPlatform() intentionally does not create a
// notification. FCM handles the system notification.
// ------------------------------------------------------------

export function maybeNotifyDM(
  message,
  isActiveConversation
) {
  if (
    !shouldNotifyDM(
      message,
      isActiveConversation
    )
  ) {
    return;
  }

  markNotified(message.id);

  // Only the minimum metadata required for notification rendering
  // and click routing.
  //
  // Never include:
  //   - raw message object
  //   - encryption/session state
  //   - access tokens
  //   - private keys

  const payload = {
    conversationId: Number(message.sender_id),
    messageId: message.id,
    senderId: Number(message.sender_id),
    senderName:
      message.sender_username ||
      'New message',
    preview: buildPreview(message),
  };

  dispatchToPlatform(payload);
}

// ------------------------------------------------------------
// Platform dispatch
// ------------------------------------------------------------

function dispatchToPlatform(payload) {
  // ----------------------------------------------------------
  // Capacitor Android
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  //
  // Do NOT call LocalNotifications here.
  //
  // Android foreground:
  //   Socket.IO -> UI
  //   no system notification
  //
  // Android background/killed:
  //   FCM -> Android OS notification
  //
  // The server's FCM notification payload is responsible for the
  // background/killed system notification.
  // ----------------------------------------------------------

  if (isNativeApp()) {
    return;
  }

  // ----------------------------------------------------------
  // Electron
  // ----------------------------------------------------------

  if (
    window.electronAPI &&
    window.electronAPI.isElectron
  ) {
    dispatchToElectron(payload);
    return;
  }

  // ----------------------------------------------------------
  // Plain browser / installed PWA
  // ----------------------------------------------------------
  //
  // getAvatarUrl() is the same cached, already-authenticated
  // blob-URL fetch every avatar <img> in the app already uses (see
  // public/js/ui/avatar.js) — nothing new is added to the auth
  // path, and the resulting blob: URL never carries any token, so
  // there is nothing sensitive in the Notification's `icon` value
  // itself. Resolves to `null` for a user with no avatar, which
  // showWebNotification() already treats as "use the default icon".

  if (isWebNotificationSupported()) {
    getAvatarUrl(payload.senderId)
      .then((icon) =>
        showWebNotification({ ...payload, icon })
      )
      .catch((e) => {
        notifWarn(
          'getAvatarUrl() failed, showing notification without an avatar:',
          e
        );
        showWebNotification(payload);
      });
  }
}

function dispatchToElectron(payload) {
  if (
    typeof window.electronAPI
      .showDmNotification !== 'function'
  ) {
    notifWarn(
      'window.electronAPI.showDmNotification is not implemented ' +
      'in this Electron build — see notifications/PLATFORM-NOTES.md.'
    );

    return;
  }

  try {
    window.electronAPI.showDmNotification(
      payload
    );
  } catch (e) {
    notifWarn(
      'Electron notification bridge threw:',
      e
    );
  }
}

// ------------------------------------------------------------
// Android notification ID helper
// ------------------------------------------------------------
//
// Kept as an exported utility in case other Android notification
// code needs a stable signed 32-bit identifier.
//
// IMPORTANT:
// This module no longer schedules Local Notifications for DMs.
// FCM background/killed notifications are therefore not assigned
// an ID by this JavaScript function.
// ------------------------------------------------------------

export function androidNotificationIdForMessage(
  messageId
) {
  return Math.abs(
    Number(messageId) % 2147483647
  );
}

// ------------------------------------------------------------
// Notification click routing
//
// Handles:
//
//   Electron:
//     window.electronAPI.onDmNotificationClicked()
//
//   Capacitor Local Notifications:
//     localNotificationActionPerformed
//
//   Capacitor FCM:
//     pushNotificationActionPerformed
//
// For Android DM notifications, the actual system notification is
// created by FCM when the app is backgrounded/killed. Tapping it
// reaches pushNotificationActionPerformed and routes to the DM.
//
// Cold-start notifications are buffered until the authenticated
// application shell has mounted and the router is ready.
// ------------------------------------------------------------

let appReadyForNavigation = false;
let pendingNotificationTarget = null;

function routeNotificationClick(target) {
  if (
    !target ||
    target.conversationId == null
  ) {
    return;
  }

  const resolved = {
    id: Number(target.conversationId),
    username:
      target.senderName || undefined,
  };

  if (!Number.isInteger(resolved.id)) {
    return;
  }

  if (appReadyForNavigation) {
    navigate('messages', resolved);
  } else {
    pendingNotificationTarget =
      resolved;
  }
}

export function markAppReadyForNotificationNavigation() {
  appReadyForNavigation = true;

  if (pendingNotificationTarget) {
    const target =
      pendingNotificationTarget;

    pendingNotificationTarget = null;

    navigate(
      'messages',
      target
    );
  }
}

// ------------------------------------------------------------
// Register notification click listeners exactly once.
//
// Electron:
//   native notification click -> renderer
//
// Capacitor:
//   LocalNotifications click listener is retained for compatibility
//   with any other local notifications the application may use.
//
//   PushNotifications click listener handles FCM notifications,
//   including Android background/killed DM notifications.
// ------------------------------------------------------------

let notificationClickRoutingInitialized =
  false;

export function initNotificationClickRouting() {
  if (
    notificationClickRoutingInitialized
  ) {
    return;
  }

  notificationClickRoutingInitialized =
    true;

  // ----------------------------------------------------------
  // Electron
  // ----------------------------------------------------------

  if (
    window.electronAPI &&
    typeof window.electronAPI
      .onDmNotificationClicked ===
      'function'
  ) {
    window.electronAPI
      .onDmNotificationClicked((data) =>
        routeNotificationClick(data)
      );
  }

  // ----------------------------------------------------------
  // Capacitor Local Notifications
  //
  // Kept because LocalNotifications may still be used by other
  // parts of the Android app. DM notifications themselves are
  // no longer scheduled here.
  // ----------------------------------------------------------

  const LocalNotifications =
    getCapacitorPlugin(
      'LocalNotifications'
    );

  if (LocalNotifications) {
    LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action) =>
        routeNotificationClick(
          action?.notification?.extra
        )
    );
  }

  // ----------------------------------------------------------
  // Capacitor Push Notifications / FCM
  //
  // This is the important Android background/killed path.
  // ----------------------------------------------------------

  const PushNotifications =
    getCapacitorPlugin(
      'PushNotifications'
    );

  if (PushNotifications) {
    PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action) =>
        routeNotificationClick(
          action?.notification?.data
        )
    );
  }
}

// ------------------------------------------------------------
// Logout cleanup
//
// A pending notification target from one account must never be
// reused after another account logs into the same device.
// ------------------------------------------------------------

window.addEventListener(
  'wire:logout',
  () => {
    appReadyForNavigation = false;
    pendingNotificationTarget = null;
  }
);