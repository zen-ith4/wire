import { api } from '../core/api.js';
import {
  emptyState,
  loadingState
} from '../core/utils.js';

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

  // Not awaited: the paint happens synchronously inside the call.
  void renderSettings({
    data: snap
  });

  const isCurrent =
    claimRender('settings');

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
// ============================================================

export async function renderSettings(opts) {
  /*
   * #content-area is shared by every view: only write to it while
   * this render still owns it (see core/view-session.js).
   */
  const isCurrent =
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
