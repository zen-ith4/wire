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
import { isVoiceMessage } from '../media/voice-message.js';
import {
  isWebNotificationSupported,
  showWebNotification,
} from './web-notifications.js';

const SETTING_STORAGE_KEY = 'wire-dm-notifications';

function notifLog(...args) {
  console.log('[Wire][Notifications]', ...args);
}

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

function dispatchToCapacitor(payload) {
  // No native Android notification plugin is wired up yet — see
  // notifications/PLATFORM-NOTES.md for exactly what's needed
  // (channel, POST_NOTIFICATIONS permission, click → deep link).
  // Deliberately not falling back to the Web Notification API here:
  // it would either silently no-op or, worse, look like it worked.
  notifLog(
    'Native Android notification skipped (not implemented yet):',
    payload
  );
}
