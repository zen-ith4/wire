import { api } from '../core/api.js';
import {
  emptyState,
  loadingState
} from '../core/utils.js';

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
// Render settings
// ============================================================

export async function renderSettings() {
  const main =
    document.getElementById('content-area');

  if (!main) {
    return;
  }

  main.innerHTML = `
    <div class="card">
      ${loadingState()}
    </div>
  `;

  try {
    /*
     * These requests are independent, so run them in parallel.
     */
    const [me, security] =
      await Promise.all([
        api('/api/me'),
        api('/api/settings/security')
      ]);

    main.innerHTML =
      renderSettingsHtml({
        me,
        security
      });

    /*
     * Bind each feature area independently.
     *
     * The DOM has already been rendered at this point, so all
     * modules can safely query their own controls.
     */
    await bindAppearanceSettings({
      me,
      security
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