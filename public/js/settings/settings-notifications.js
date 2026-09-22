// ============================================================
// Settings > Notifications
// ------------------------------------------------------------
// Binds the "DM Notifications" toggle. Follows the same pattern
// as bindAnimations() in settings-appearance.js/theme.js: a plain
// on/off switch backed by localStorage, initialized from the real
// persisted state and never from whatever class happens to be in
// the freshly-rendered DOM.
// ============================================================

import { showToast } from '../core/utils.js';
import { isNativeApp } from '../core/server.js';
import {
  getDmNotificationsEnabled,
  setDmNotificationsEnabled,
} from '../notifications/notification-manager.js';
import {
  isWebNotificationSupported,
  requestWebNotificationPermission,
} from '../notifications/web-notifications.js';

function isElectronApp() {
  return Boolean(window.electronAPI && window.electronAPI.isElectron);
}

export function bindNotificationSettings() {
  const toggle = document.getElementById('dm-notifications-toggle');
  if (!toggle) return;

  const paint = (enabled) => {
    toggle.classList.toggle('on', enabled);
    toggle.setAttribute('aria-checked', String(enabled));
  };

  paint(getDmNotificationsEnabled());

  toggle.addEventListener('click', async () => {
    const next = !getDmNotificationsEnabled();

    // Only the plain browser/PWA path needs an explicit permission
    // prompt, and only when turning notifications on. Electron and
    // Capacitor Android handle OS-level permission through their
    // own native APIs, not this one.
    if (
      next &&
      !isNativeApp() &&
      !isElectronApp() &&
      isWebNotificationSupported()
    ) {
      const permission = await requestWebNotificationPermission();

      if (permission === 'denied') {
        showToast(
          'Notifications are blocked for Wire in your browser settings',
          'error'
        );
        // The in-app preference still turns on below — the OS/
        // browser-level block is the user's own separate setting
        // and we never try to work around it.
      }
    }

    const applied = setDmNotificationsEnabled(next);
    paint(applied);
  });
}
