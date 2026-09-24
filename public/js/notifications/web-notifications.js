// ============================================================
// Web Notification API adapter.
// ------------------------------------------------------------
// Pure display + click-routing. Whether to notify at all is
// decided in notification-manager.js before this module is ever
// called — this file never re-checks the active conversation, the
// setting, or dedup.
// ============================================================

import { navigate } from '../core/router.js';

export function isWebNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getWebNotificationPermission() {
  return isWebNotificationSupported() ? Notification.permission : 'unsupported';
}

// Only ever called from an explicit user action (turning the
// Settings toggle on) — never from an incoming-message code path.
// Notification.permission already remembers a previous "denied"
// answer for us; requestPermission() itself is a no-op prompt-wise
// once the user has answered, but we still guard on `=== 'default'`
// so this function is never the thing that decides to re-prompt.
export async function requestWebNotificationPermission() {
  if (!isWebNotificationSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;

  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showWebNotification({
  conversationId,
  messageId,
  senderId,
  senderName,
  preview,
  icon,
}) {
  if (!isWebNotificationSupported()) return;
  if (Notification.permission !== 'granted') return;

  let notification;
  try {
    notification = new Notification(senderName, {
      body: preview,
      // Falls back to the existing default app icon whenever no
      // avatar was available (or couldn't be loaded) — see
      // notification-manager.js's maybeNotifyDM(), which is the only
      // caller and the only place that decides what `icon` is.
      icon: icon || '/img/logo.jpg',
      // One notification per peer, not one per message — a second
      // DM from the same person while the first is still showing
      // replaces it instead of stacking.
      tag: `wire-dm-${conversationId}`,
      renotify: true,
      data: { conversationId, messageId, senderId },
    });
  } catch (e) {
    console.warn('[Wire][Notifications] Failed to show notification:', e);
    return;
  }

  notification.onclick = () => {
    window.focus();
    navigate('messages', { id: conversationId, username: senderName });
    notification.close();
  };
}
