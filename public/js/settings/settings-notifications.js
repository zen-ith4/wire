// ============================================================
// Settings > Notifications
// ------------------------------------------------------------
// Binds the "DM Notifications" and "Message sounds" toggles. Both
// follow the same pattern as bindAnimations() in
// settings-appearance.js/theme.js: a plain on/off switch backed by
// localStorage, initialized from the real persisted state and never
// from whatever class happens to be in the freshly-rendered DOM.
// ============================================================

import { showToast } from '../core/utils.js';
import { isNativeApp } from '../core/server.js';
import {
  getDmNotificationsEnabled,
  setDmNotificationsEnabled,
} from '../notifications/notification-manager.js';
import { messageSoundManager } from '../notifications/message-sounds.js';
import {
  isWebNotificationSupported,
  requestWebNotificationPermission,
} from '../notifications/web-notifications.js';
import {
  requestPushPermissionAndRegister,
  deregisterPushNotifications,
} from '../notifications/push-registration.js';

function isElectronApp() {
  return Boolean(window.electronAPI && window.electronAPI.isElectron);
}

function bindMessageSoundsToggle() {
  const toggle = document.getElementById('message-sounds-toggle');
  if (!toggle) return;

  const paint = (enabled) => {
    toggle.classList.toggle('on', enabled);
    toggle.setAttribute('aria-checked', String(enabled));
  };

  paint(messageSoundManager.isEnabled());

  toggle.addEventListener('click', () => {
    const next = !messageSoundManager.isEnabled();
    const applied = messageSoundManager.setEnabled(next);
    paint(applied);

    // Turning sounds on plays a preview. The click is also the user
    // gesture browsers need before they will let the page play audio.
    if (applied) messageSoundManager.playReceived();
  });
}

export function bindNotificationSettings() {
  bindMessageSoundsToggle();

  const toggle = document.getElementById('dm-notifications-toggle');
  if (!toggle) return;

  const paint = (enabled) => {
    toggle.classList.toggle('on', enabled);
    toggle.setAttribute('aria-checked', String(enabled));
  };

  paint(getDmNotificationsEnabled());

  toggle.addEventListener('click', async () => {
    const next = !getDmNotificationsEnabled();

    if (next) {
      if (isNativeApp()) {
        // Covers both the "app alive" Local Notification path and
        // the FCM device-token registration for backgrounded/killed
        // delivery — see notification-manager.js's dispatchToCapacitor()
        // and push-registration.js. One explicit prompt for both.
        const permission = await requestPushPermissionAndRegister();

        if (permission === 'denied') {
          showToast(
            'Notifications are blocked for Wire in Android system settings',
            'error'
          );
          // The in-app preference still turns on below — this app
          // never tries to bypass an OS-level notification block.
        }
      } else if (!isElectronApp() && isWebNotificationSupported()) {
        const permission = await requestWebNotificationPermission();

        if (permission === 'denied') {
          showToast(
            'Notifications are blocked for Wire in your browser settings',
            'error'
          );
        }
      }
      // Electron needs no explicit permission step here — it uses
      // Electron's native Notification API directly (see
      // notification-manager.js's dispatchToElectron()).
    } else if (isNativeApp()) {
      // Turning DM Notifications off also stops FCM pushes from
      // reaching this device, not just the in-app Local Notification
      // path — deregister the token rather than leaving a live
      // registration the setting no longer reflects.
      await deregisterPushNotifications();
    }

    const applied = setDmNotificationsEnabled(next);
    paint(applied);
  });
}
