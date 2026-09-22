// ============================================================
// DM notification manager
// ------------------------------------------------------------
// This is the one place that decides *whether* a new DM should
// produce a system notification. Platform adapters (web, Electron,
// Capacitor Android) only ever handle *displaying* one — they never
// re-derive this decision themselves.
//
// Called from chat/dm.js's addDmMessage(), which is already the
// single choke point every incoming/outgoing DM passes through
// (socket messages and the composer's own optimistic add both end
// up there), and which has already decrypted the message and
// deduped it against its per-conversation cache (entry.ids) before
// we ever see it. That means:
//   - we only ever see legitimate plaintext (never ciphertext),
//   - we never get called twice for a message already in that
//     conversation's cache,
//   - no new Socket.IO listener was needed to wire this up.
// ============================================================

import { getCurrentUser } from '../core/auth.js';
import { isNativeApp } from '../core/server.js';
import { navigate } from '../core/router.js';
import { isVoiceMessage } from '../media/voice-message.js';
import {
  isWebNotificationSupported,
  showWebNotification,
} from './web-notifications.js';

const SETTING_STORAGE_KEY = 'wire-dm-notifications';

function notifWarn(...args) {
  console.warn('[Wire][Notifications]', ...args);
}

// ------------------------------------------------------------
// Setting (same on/off-via-localStorage pattern as the
// "Animations" toggle in settings/theme.js — no server round trip,
// nothing new added to the settings API).
// ------------------------------------------------------------

export function getDmNotificationsEnabled() {
  try {
    // Default ON — a fresh install/existing user gets DM
    // notifications without an extra step; the Settings toggle
    // lets anyone turn them back off.
    return localStorage.getItem(SETTING_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setDmNotificationsEnabled(enabled) {
  const value = enabled === true;
  try {
    localStorage.setItem(SETTING_STORAGE_KEY, value ? 'on' : 'off');
  } catch {
    // Non-fatal — the toggle just won't survive a reload.
  }
  return value;
}

// ------------------------------------------------------------
// Lightweight, bounded de-duplication.
//
// addDmMessage()'s own entry.ids cache is the primary guard
// against processing the same message twice. This is a second,
// independent guard scoped just to notifications, covering the
// case the spec calls out explicitly: reconnects, connection-state
// recovery, or any future code path that could hand us the same
// message id again. A plain ever-growing Set would leak for the
// life of a long session, so this caps out and evicts the oldest
// half instead of growing forever.
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
    oldest.forEach((id) => notifiedMessageIds.delete(id));
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
// The decision itself.
//
// `message` must already be decrypted (see chat/dm.js
// decryptDmMessage) — never pass raw ciphertext in here.
// `isActiveConversation` is whatever chat/dm.js already computed
// (dmActivePeer matching this message's peer).
// ------------------------------------------------------------

export function shouldNotifyDM(message, isActiveConversation) {
  const currentUser = getCurrentUser();
  if (!currentUser || !message) return false;

  // Only ever notify about messages from someone else.
  if (Number(message.sender_id) === Number(currentUser.id)) {
    return false;
  }

  if (!getDmNotificationsEnabled()) return false;

  if (alreadyNotified(message.id)) return false;

  // The one case that should stay silent: this exact conversation
  // is open *and* the app is actually in the foreground right now.
  // Being backgrounded/minimized/unfocused always notifies, even if
  // this was the last conversation the user had open.
  if (isActiveConversation && isAppForeground()) return false;

  return true;
}

// ------------------------------------------------------------
// Notification preview text — see chat/dm.js buildDmMessageEl /
// media/attachments.js for the same attachment-kind conventions.
// ------------------------------------------------------------

const MAX_PREVIEW_LENGTH = 120;

function buildPreview(message) {
  if (isVoiceMessage(message)) return '🎤 Voice message';

  if (message.has_attachment) {
    const mime = message.attachment_mime || '';
    if (mime.startsWith('image/')) return '📷 Photo';
    if (mime.startsWith('video/')) return '🎞️ Video';
    if (mime.startsWith('audio/')) return '🎤 Voice message';
    return '📎 File';
  }

  const text = typeof message.content === 'string' ? message.content : '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  return trimmed.length > MAX_PREVIEW_LENGTH
    ? `${trimmed.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
    : trimmed;
}

// ------------------------------------------------------------
// Entry point — call this from addDmMessage() for every message
// (own or peer's) once it's decrypted and in the cache. Everything
// above filters it down to "should this actually notify?".
// ------------------------------------------------------------

export function maybeNotifyDM(message, isActiveConversation) {
  if (!shouldNotifyDM(message, isActiveConversation)) return;

  markNotified(message.id);

  // Only the minimum needed to render a notification and route a
  // click back to the right conversation. Never the raw message
  // object, a token, or any encryption/session state.
  const payload = {
    conversationId: Number(message.sender_id),
    messageId: message.id,
    senderId: Number(message.sender_id),
    senderName: message.sender_username || 'New message',
    preview: buildPreview(message),
  };

  dispatchToPlatform(payload);
}

function dispatchToPlatform(payload) {
  // Capacitor Android build: must use real native OS notifications,
  // never the Web Notification API.
  if (isNativeApp()) {
    dispatchToCapacitor(payload);
    return;
  }

  // Electron build: native OS notification via the main process,
  // through the same window.electronAPI bridge auth.js/settings.js
  // already use for identity-key storage and hardware acceleration.
  if (window.electronAPI && window.electronAPI.isElectron) {
    dispatchToElectron(payload);
    return;
  }

  // Plain browser / installed PWA.
  if (isWebNotificationSupported()) {
    showWebNotification(payload);
  }
}

function dispatchToElectron(payload) {
  if (typeof window.electronAPI.showDmNotification !== 'function') {
    notifWarn(
      'window.electronAPI.showDmNotification is not implemented in this ' +
        'Electron build — see notifications/PLATFORM-NOTES.md.'
    );
    return;
  }

  try {
    window.electronAPI.showDmNotification(payload);
  } catch (e) {
    notifWarn('Electron notification bridge threw:', e);
  }
}

// ------------------------------------------------------------
// Capacitor Android — "app alive" path only.
//
// This project has no JS bundler (index.html loads core/app.js
// directly as a native <script type="module">, and Capacitor's
// webDir is the same plain `public` folder — see core/server.js's
// isCapacitor(), which already reads window.Capacitor the same way
// rather than importing @capacitor/core). So Capacitor plugins are
// consumed the same way core/server.js already detects the platform:
// via the window.Capacitor.Plugins global the native runtime injects,
// never via `import ... from '@capacitor/...'`.
//
// The fully-backgrounded/killed case is handled entirely differently
// — by Android auto-displaying the FCM push's own "notification"
// block, with no app code involved at all. See push-registration.js
// and PLATFORM-NOTES.md.
// ------------------------------------------------------------

function getCapacitorPlugin(name) {
  return (
    window.Capacitor &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins[name]
  );
}

// Local Notification ids must fit a signed 32-bit int. This is also
// used server-side (conceptually — see PLATFORM-NOTES.md) to pick the
// same Android notification tag for the FCM-displayed version of the
// same message, so if both a Local Notification (this path) and an
// FCM auto-notification ever end up posted for the same message,
// Android's own NotificationManager replaces one with the other
// instead of showing two.
export function androidNotificationIdForMessage(messageId) {
  return Math.abs(Number(messageId) % 2147483647);
}

async function dispatchToCapacitor(payload) {
  // The moment Android actually backgrounds the app,
  // document.visibilityState flips to 'hidden' almost immediately —
  // well before the OS ever gets around to suspending or killing the
  // WebView's JS. From that point on this path deliberately does
  // nothing, and the FCM push (see push-registration.js /
  // PLATFORM-NOTES.md) is the only thing that can display a
  // notification. That split is what keeps the two delivery
  // mechanisms from racing to show the same message twice: while
  // genuinely foregrounded, Android never auto-displays an FCM
  // "notification" payload at all (that's standard FCM/Android
  // behavior, not something this app controls), so only this path can
  // fire; the instant the app is backgrounded, only FCM can.
  if (
    typeof document !== 'undefined' &&
    document.visibilityState !== 'visible'
  ) {
    return;
  }

  const LocalNotifications = getCapacitorPlugin('LocalNotifications');

  if (!LocalNotifications) {
    notifWarn(
      '@capacitor/local-notifications is not installed/synced yet — ' +
        'see notifications/PLATFORM-NOTES.md.'
    );
    return;
  }

  try {
    // Permission is requested once, from the Settings "DM
    // Notifications" toggle (settings-notifications.js) — never from
    // here, and never repeated on every message.
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') return;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: androidNotificationIdForMessage(payload.messageId),
          title: payload.senderName,
          body: payload.preview,
          channelId: 'wire-dm',
          extra: {
            conversationId: payload.conversationId,
            senderName: payload.senderName,
          },
        },
      ],
    });
  } catch (e) {
    notifWarn('Local notification failed:', e);
  }
}

// ------------------------------------------------------------
// Notification click routing (Electron + Capacitor).
//
// navigate('messages', { id, username }) — see core/router.js and
// ui/profile-card.js for the same call shape — only works once the
// app shell is actually mounted (a logged-in session with initRouter()
// already called, from core/app.js's startApplication()). A
// notification tapped from a cold start reaches this listener before
// that's true, so the target is held here and delivered once
// markAppReadyForNotificationNavigation() is called.
// ------------------------------------------------------------

let appReadyForNavigation = false;
let pendingNotificationTarget = null;

function routeNotificationClick(target) {
  if (!target || target.conversationId == null) return;

  const resolved = {
    id: Number(target.conversationId),
    username: target.senderName || undefined,
  };

  if (!Number.isInteger(resolved.id)) return;

  if (appReadyForNavigation) {
    navigate('messages', resolved);
  } else {
    pendingNotificationTarget = resolved;
  }
}

export function markAppReadyForNotificationNavigation() {
  appReadyForNavigation = true;

  if (pendingNotificationTarget) {
    const target = pendingNotificationTarget;
    pendingNotificationTarget = null;
    navigate('messages', target);
  }
}

// Registered exactly once, at module load (see core/app.js, which
// calls this once at true top-level script scope — never inside
// startApplication/login) — window.electronAPI.onDmNotificationClicked
// and Capacitor's addListener() both already guard against
// accumulating duplicate handlers on their own side (see preload.js
// and, for Capacitor, its documented listener-buffering behavior), so
// this only ever needs to run once per page load.
export function initNotificationClickRouting() {
  if (
    window.electronAPI &&
    typeof window.electronAPI.onDmNotificationClicked === 'function'
  ) {
    window.electronAPI.onDmNotificationClicked((data) =>
      routeNotificationClick(data)
    );
  }

  const LocalNotifications = getCapacitorPlugin('LocalNotifications');
  if (LocalNotifications) {
    LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action) => routeNotificationClick(action?.notification?.extra)
    );
  }

  const PushNotifications = getCapacitorPlugin('PushNotifications');
  if (PushNotifications) {
    PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action) => routeNotificationClick(action?.notification?.data)
    );
  }
}

// A notification tapped for one account shouldn't navigate into a
// session that's no longer active once someone logs out (and,
// symmetrically, a stale pending target from before login shouldn't
// survive into a *different* account signing in on the same device).
window.addEventListener('wire:logout', () => {
  appReadyForNavigation = false;
  pendingNotificationTarget = null;
});
