import { api } from '../core/api.js';
import {
  emptyState,
  loadingState
} from '../core/utils.js';

import {
  getCurrentUser,
  setCurrentUser
} from '../core/auth.js';

import {
  claimRender,
  isUserTypingIn
} from '../core/view-session.js';

import {
  renderSettingsHtml
} from './settings-render.js';

import {
  bindAppearanceSettings
} from './settings-appearance.js';

import {
  bindProfileSettings
} from './settings-profile.js';

import {
  bindSecuritySettings
} from './settings-security.js';

import {
  bindMediaSettings
} from './settings-media.js';

import {
  bindAccountSettings
} from './settings-account.js';

import {
  bindNotificationSettings
} from './settings-notifications.js';

import {
  initAccent
} from './theme.js';


// ============================================================
// Snapshot (stale-while-revalidate)
//
// The last { me, security } this screen was painted with. A tab
// switch paints from it immediately and revalidates in the
// background (see showSettings). In memory only.
//
// It is dropped when:
//   - the user signs out ("wire:logout", dispatched by core/auth.js)
//   - anything on this screen writes to the server
//     ("wire:settings-stale", dispatched by the profile, appearance,
//     security and media modules right before each write), so the
//     next visit fetches fresh data instead of briefly painting the
//     old values first.
// ============================================================

let settingsSnapshot = null;

function dropSettingsSnapshot() {
  settingsSnapshot = null;
}

window.addEventListener(
  'wire:logout',
  dropSettingsSnapshot
);

window.addEventListener(
  'wire:settings-stale',
  dropSettingsSnapshot
);


// ============================================================
// Data
// ============================================================

/*
 * These requests are independent, so run them in parallel.
 */
async function fetchSettingsData() {
  const [me, security] =
    await Promise.all([
      api('/api/me'),
      api('/api/settings/security')
    ]);

  return {
    me,
    security,
    sig: JSON.stringify([
      me,
      security
    ])
  };
}


// ============================================================
// Account-scoped appearance
//
// Accent Color is different from the rest of Appearance.
//
// Other appearance settings are device/local settings.
// Accent Color belongs to the authenticated account and therefore
// must always come from /api/me.
//
// This function deliberately does NOT write anything to storage.
// It only applies the server value to the current runtime theme.
// ============================================================

function applyAccountAccent(me) {
  initAccent(
    me?.accent_color || null
  );
}


// ============================================================
// Tab-switch entry point
//
// First visit (or after a change made on this screen) is a normal
// fresh render; otherwise paint locally, then refresh in the
// background and repaint only if the server data differs.
// ============================================================

export async function showSettings() {
  const snap =
    settingsSnapshot;

  if (!snap) {
    return renderSettings();
  }

  // One claim covers both the local paint and the background refresh
  // below. It must be taken here and handed to renderSettings(): if the
  // paint took its own claim and this function then took another, the
  // second would supersede the first (latest wins, see
  // core/view-session.js) and the paint would be discarded whenever it
  // has to await before writing — as it does in Electron, where the
  // hardware-acceleration setting is read over IPC first.
  const isCurrent =
    claimRender('settings');

  // Not awaited: the refresh below must not wait for the paint.
  void renderSettings({
    data: snap,
    isCurrent
  });

  const main =
    document.getElementById('content-area');

  try {
    const fresh =
      await fetchSettingsData();

    if (
      !isCurrent() ||
      fresh.sig === snap.sig ||
      isUserTypingIn(main)
    ) {
      return;
    }

    void renderSettings({
      data: fresh
    });

  } catch (e) {
    console.warn(
      '[Settings] Background refresh failed:',
      e
    );
  }
}


// ============================================================
// Render settings
//
// opts.data: paint from data we already have (no spinner, no
// network). Without it, fetch fresh data first.
// opts.isCurrent: a claim the caller already took for this render
// (see showSettings). Without it, this render takes its own.
// ============================================================

export async function renderSettings(opts) {
  /*
   * #content-area is shared by every view: only write to it while
   * this render still owns it (see core/view-session.js).
   */
  const isCurrent =
    (opts && opts.isCurrent) ||
    claimRender('settings');

  const main =
    document.getElementById('content-area');

  if (!main) {
    return;
  }

  let data =
    (opts && opts.data) ||
    null;

  if (!data) {
    main.innerHTML = `
      <div class="card">
        ${loadingState()}
      </div>
    `;
  }

  try {
    if (!data) {
      data =
        await fetchSettingsData();

      if (!isCurrent()) {
        return;
      }
    }

    settingsSnapshot =
      data;

    const {
      me,
      security
    } = data;

    /*
     * Accent Color is account-scoped.
     *
     * The server value returned by /api/me is the source of truth.
     * Unlike the other appearance settings, Accent Color must not
     * be restored from localStorage.
     *
     * This also fixes the case where the theme was still using an
     * old local accent until the Settings screen was opened.
     */
    applyAccountAccent(me);

    /*
     * Electron only: the current hardware-acceleration setting is
     * read from the main process and handed to the renderer and
     * the appearance binder, which do not read it themselves.
     */
    const isElectronApp =
      Boolean(
        window.electronAPI &&
        window.electronAPI.isElectron
      );

    const hardwareAccelerationEnabled =
      isElectronApp
        ? await window.electronAPI
            .getHardwareAcceleration()
        : true;

    if (!isCurrent()) {
      return;
    }

    main.innerHTML =
      renderSettingsHtml({
        me,
        security,
        hardwareAccelerationEnabled
      });

    /*
     * Bind each feature area independently.
     *
     * The DOM has already been rendered at this point, so all
     * modules can safely query their own controls.
     */
    await bindAppearanceSettings({
      me,
      security,
      hardwareAccelerationEnabled
    });

    bindProfileSettings({
      me
    });

    bindSecuritySettings({
      me,
      security
    });

    bindMediaSettings({
      me
    });

    bindNotificationSettings();

    bindAccountSettings();

  } catch (e) {
    if (!isCurrent()) {
      return;
    }

    console.error(
      '[Settings] Failed to render settings:',
      e
    );

    main.innerHTML = `
      <div class="card">
        ${emptyState(
          e.message ||
          'Failed to load settings'
        )}
      </div>
    `;
  }
}