// ============================================================
// FCM device-token registration (Capacitor Android only).
// ------------------------------------------------------------
// This module only ever talks to the backend about *which device*
// exists — it never decides whether to show a notification (that's
// still entirely notification-manager.js's job) and never touches
// message content.
//
// Same no-bundler constraint as notification-manager.js's Capacitor
// section: @capacitor/push-notifications is consumed via the
// window.Capacitor.Plugins global, not an ES import.
// ============================================================

import { api } from '../core/api.js';
import { isNativeApp } from '../core/server.js';
import { getDmNotificationsEnabled } from './notification-manager.js';

function getCapacitorPlugin(name) {
  return (
    window.Capacitor &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins[name]
  );
}

function pushWarn(...args) {
  console.warn('[Wire][Push]', ...args);
}

let channelEnsured = false;

// Android 8+ requires a notification channel to exist before any
// notification on it can show. LocalNotifications.createChannel()
// creates a real OS-level NotificationChannel, not something scoped
// to the plugin, so this is enough to cover any Local Notification
// this app schedules on "wire-dm" elsewhere. It is NOT the only
// place this channel gets created, though: background/killed DM
// notifications are now built by the native
// WireFirebaseMessagingService (see PLATFORM-NOTES.md), which cannot
// rely on this JS having ever run first (a fresh install's first
// message can arrive before the app has ever been opened), so that
// native code also idempotently creates the same "wire-dm" channel
// itself as a safety net. Both are harmless to call more than once
// or in either order — NotificationManager.createNotificationChannel
// is a no-op if the channel already exists with the same id.
async function ensureNotificationChannel() {
  if (channelEnsured) return;

  const LocalNotifications = getCapacitorPlugin('LocalNotifications');
  if (!LocalNotifications) return;

  try {
    await LocalNotifications.createChannel({
      id: 'wire-dm',
      name: 'Direct Messages',
      description: 'Notifications for new Wire direct messages',
      importance: 4, // IMPORTANCE_HIGH — heads-up notification
      visibility: 1, // VISIBILITY_PRIVATE
    });
    channelEnsured = true;
  } catch (e) {
    pushWarn('Failed to create notification channel:', e);
  }
}

let listenersBound = false;
let currentToken = null;

// PushNotifications.addListener() is additive like every Capacitor
// listener, so this guard is what actually prevents a second
// registerForPushNotifications()/requestPushPermissionAndRegister()
// call (e.g. the Settings toggle being flipped twice in one session)
// from accumulating a second 'registration' handler.
function bindListenersOnce(PushNotifications) {
  if (listenersBound) return;
  listenersBound = true;

  PushNotifications.addListener('registration', (token) => {
    const value = token && token.value;
    if (!value) return;
    currentToken = value;
    sendTokenToBackend(value);
  });

  PushNotifications.addListener('registrationError', (err) => {
    pushWarn('Registration failed:', err);
  });
}

async function sendTokenToBackend(token) {
  try {
    await api('/api/me/push-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, platform: 'android' }),
    });
  } catch (e) {
    pushWarn('Failed to register token with backend:', e);
  }
}

async function deregisterTokenFromBackend(token) {
  try {
    await api('/api/me/push-token', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    pushWarn('Failed to deregister token:', e);
  }
}

// Only ever registers if permission is *already* granted — never
// prompts. Safe to call on every app startup (see core/app.js).
export async function registerForPushNotifications() {
  if (!isNativeApp()) return;

  const PushNotifications = getCapacitorPlugin('PushNotifications');
  if (!PushNotifications) {
    pushWarn(
      '@capacitor/push-notifications is not installed/synced yet — see ' +
        'notifications/PLATFORM-NOTES.md.'
    );
    return;
  }

  bindListenersOnce(PushNotifications);
  await ensureNotificationChannel();

  try {
    const { receive } = await PushNotifications.checkPermissions();
    if (receive !== 'granted') return;
    await PushNotifications.register();
  } catch (e) {
    pushWarn('registerForPushNotifications failed:', e);
  }
}

// The one path that's allowed to prompt — called from the Settings
// "DM Notifications" toggle (settings-notifications.js) when the user
// explicitly turns notifications on, same rule as the web permission
// request in web-notifications.js.
export async function requestPushPermissionAndRegister() {
  if (!isNativeApp()) return 'unsupported';

  const PushNotifications = getCapacitorPlugin('PushNotifications');
  if (!PushNotifications) return 'unsupported';

  bindListenersOnce(PushNotifications);
  await ensureNotificationChannel();

  try {
    let { receive } = await PushNotifications.checkPermissions();

    if (receive === 'prompt' || receive === 'prompt-with-rationale') {
      ({ receive } = await PushNotifications.requestPermissions());
    }

    if (receive === 'granted') {
      await PushNotifications.register();
    }

    return receive;
  } catch (e) {
    pushWarn('requestPushPermissionAndRegister failed:', e);
    return 'denied';
  }
}

export async function deregisterPushNotifications() {
  if (!isNativeApp() || !currentToken) return;
  const token = currentToken;
  currentToken = null;
  await deregisterTokenFromBackend(token);
}

// Called once per app startup (core/app.js's startApplication(), right
// after login/session restore — the endpoint this hits requires
// authenticate). Re-registers silently if the user already granted
// permission in an earlier session, so a token refresh or a
// reinstalled app keeps the backend's record current without ever
// prompting on its own.
export function initPushRegistration() {
  if (!isNativeApp()) return;

  ensureNotificationChannel();

  if (!getDmNotificationsEnabled()) return;

  registerForPushNotifications();
}

// A token left registered after logout would let a push for this
// account keep arriving (and, if someone else logs into the same
// device next, keep being sent to the previous account's backend
// record until the new login re-registers it) — deregister eagerly.
// Best-effort: if this fails (offline, etc.) the token will simply
// be re-owned by whichever account next calls register() from this
// device (see pushToken.service.js's upsert-by-token).
window.addEventListener('wire:logout', () => {
  deregisterPushNotifications();
});
