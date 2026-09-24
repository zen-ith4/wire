import { api } from '../core/api.js';

import {
  showToast
} from '../core/utils.js';

import {
  ACCENT_PRESETS,
  applyAccent,
  applyAccentPreset,
  getCurrentAccentHex,
  applyAmbientLevel,
  getCurrentAmbientLevel,
  getCurrentTheme,
  applyTheme,
  getUseAccentForBubbles,
  applyUseAccentForBubbles,
  getAnimationsEnabled,
  applyAnimationsEnabled,
  applyBackgroundTheme,
  getFontFamily,
  applyFontFamily,
  BUBBLE_STYLES,
  getMessageBubbleStyle,
  applyMessageBubbleStyle
} from './theme.js';

import {
  setCurrentUser
} from '../core/auth.js';

import {
  repaintAllMessageAccents
} from '../chat/message-accent.js';

import {
  showConfirm
} from '../ui/confirm.js';

import {
  bindCustomAppearance
} from './settings-appearance-custom.js';

// ============================================================
// Message bubble style
//
// The state itself (storage key, allowed values, get/apply/init)
// lives in theme.js next to every other appearance setting and
// is applied at startup from app.js. This section is only the
// Settings-screen control: it reflects the current value and
// changes it on click.
// ============================================================

function syncBubbleStyleButtons(
  container,
  currentStyle
) {
  container
    .querySelectorAll(
      '.bubble-style-option'
    )
    .forEach(button => {
      const selected =
        button.dataset.style ===
        currentStyle;

      button.classList.toggle(
        'selected',
        selected
      );

      button.setAttribute(
        'aria-pressed',
        String(selected)
      );
    });
}

function bindMessageBubbleStyle() {
  const container =
    document.getElementById(
      'message-bubble-style'
    );

  if (!container) return;

  syncBubbleStyleButtons(
    container,
    getMessageBubbleStyle()
  );

  container.addEventListener(
    'click',
    event => {
      const button =
        event.target.closest(
          '.bubble-style-option'
        );

      if (!button) return;

      const style =
        button.dataset.style;

      if (
        !BUBBLE_STYLES.includes(style)
      ) {
        return;
      }

      const applied =
        applyMessageBubbleStyle(
          style
        );

      syncBubbleStyleButtons(
        container,
        applied
      );
    }
  );
}

// ============================================================
// Font
// ============================================================

function bindFont() {
  const select =
    document.getElementById(
      'font-family-select'
    );

  if (!select) return;

  select.value = getFontFamily();

  select.addEventListener(
    'change',
    () => {
      applyFontFamily(
        select.value
      );
    }
  );
}

// ============================================================
// Accent helpers
// ============================================================

function syncAccentControls(hex) {
  if (
    typeof hex !== 'string' ||
    !/^#[0-9a-fA-F]{6}$/.test(hex)
  ) {
    return;
  }

  const normalized =
    hex.toUpperCase();

  const colorInput =
    document.getElementById(
      'custom-accent-color'
    );

  const hexInput =
    document.getElementById(
      'custom-accent-hex'
    );

  if (colorInput) {
    colorInput.value =
      normalized;
  }

  if (hexInput) {
    hexInput.value =
      normalized;
  }

  const preset =
    ACCENT_PRESETS.find(
      item =>
        item.hex.toUpperCase() ===
        normalized
    );

  document
    .querySelectorAll(
      '#accent-swatches .accent-swatch'
    )
    .forEach(button => {
      const selected =
        Boolean(
          preset &&
          button.dataset.name ===
            preset.name
        );

      button.classList.toggle(
        'selected',
        selected
      );

      button.setAttribute(
        'aria-pressed',
        String(selected)
      );
    });
}

function syncAccentFromServer(updatedMe) {
  const serverAccent =
    updatedMe?.accent_color;

  if (
    typeof serverAccent === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(
      serverAccent
    )
  ) {
    const normalized =
      serverAccent.toUpperCase();

    applyAccent(normalized);
    syncAccentControls(normalized);
  }

  setCurrentUser(updatedMe);
  repaintAllMessageAccents();
}

// ============================================================
// Accent preset
// ============================================================

function bindAccentPresets() {
  const container =
    document.getElementById(
      'accent-swatches'
    );

  if (!container) return;

  /*
   * The server-backed accent has already been applied during
   * application startup. This only synchronizes the controls
   * with the current runtime value.
   */
  syncAccentControls(
    getCurrentAccentHex()
  );

  container.addEventListener(
    'click',
    async event => {
      const swatch =
        event.target.closest(
          '.accent-swatch'
        );

      if (!swatch) return;

      const preset =
        ACCENT_PRESETS.find(
          p =>
            p.name ===
            swatch.dataset.name
        );

      if (!preset) return;

      const previousAccent =
        getCurrentAccentHex();

      const nextAccent =
        preset.hex.toUpperCase();

      applyAccentPreset(preset);
      syncAccentControls(nextAccent);

      try {
        await api(
          '/api/me/accent-color',
          {
            method: 'PUT',
            headers: {
              'Content-Type':
                'application/json'
            },
            body: JSON.stringify({
              accent_color:
                nextAccent
            })
          }
        );

        const updatedMe =
          await api('/api/me');

        syncAccentFromServer(
          updatedMe
        );

        /*
         * The cached settings data is now stale.
         * Accent itself is NOT stored in localStorage.
         */
        window.dispatchEvent(
          new Event('wire:settings-stale')
        );

        showToast(
          'Accent color updated',
          'success'
        );

      } catch (error) {
        /*
         * The server rejected the change.
         * Restore the previous account/runtime value.
         */
        applyAccent(previousAccent);
        syncAccentControls(
          previousAccent
        );
        repaintAllMessageAccents();

        showToast(
          error.message,
          'error'
        );
      }
    }
  );
}

// ============================================================
// Custom accent
// ============================================================

function bindCustomAccent() {
  const colorInput =
    document.getElementById(
      'custom-accent-color'
    );

  const hexInput =
    document.getElementById(
      'custom-accent-hex'
    );

  const saveButton =
    document.getElementById(
      'save-custom-accent'
    );

  const clearPresetSelection = () => {
    document
      .querySelectorAll(
        '#accent-swatches .accent-swatch'
      )
      .forEach(button => {
        button.classList.remove(
          'selected'
        );

        button.setAttribute(
          'aria-pressed',
          'false'
        );
      });
  };

  /*
   * Color picker changes are intentionally only runtime/preview
   * changes. Nothing is persisted until the user clicks Save.
   */
  colorInput?.addEventListener(
    'input',
    () => {
      if (hexInput) {
        hexInput.value =
          colorInput.value.toUpperCase();
      }

      applyAccent(
        colorInput.value
      );

      clearPresetSelection();
      repaintAllMessageAccents();
    }
  );

  /*
   * Same behavior for manually typed HEX values:
   * preview immediately, persist only on Save.
   */
  hexInput?.addEventListener(
    'input',
    () => {
      const value =
        hexInput.value.trim();

      if (
        !/^#[0-9a-fA-F]{6}$/.test(value)
      ) {
        return;
      }

      const normalized =
        value.toUpperCase();

      if (colorInput) {
        colorInput.value =
          normalized;
      }

      applyAccent(normalized);

      clearPresetSelection();
      repaintAllMessageAccents();
    }
  );

  saveButton?.addEventListener(
    'click',
    async () => {
      const value =
        hexInput?.value
          .trim()
          .toUpperCase();

      if (
        !/^#[0-9A-F]{6}$/.test(
          value || ''
        )
      ) {
        showToast(
          'Invalid HEX color. Example: #5F84AD',
          'error'
        );

        return;
      }

      const previousAccent =
        getCurrentAccentHex();

      /*
       * Optimistic preview.
       * The server remains the source of truth.
       */
      applyAccent(value);
      syncAccentControls(value);
      repaintAllMessageAccents();

      saveButton.disabled =
        true;

      try {
        const data =
          await api(
            '/api/me/accent-color',
            {
              method: 'PUT',
              headers: {
                'Content-Type':
                  'application/json'
              },
              body: JSON.stringify({
                accent_color:
                  value
              })
            }
          );

        const updatedMe =
          await api('/api/me');

        /*
         * Always reapply the value returned by the server.
         * This prevents the client from assuming its requested
         * value was accepted if the backend normalized it.
         */
        syncAccentFromServer(
          updatedMe
        );

        window.dispatchEvent(
          new Event('wire:settings-stale')
        );

        const savedAccent =
          data?.accent_color ||
          updatedMe?.accent_color ||
          value;

        syncAccentControls(
          savedAccent
        );

        showToast(
          'Custom accent saved',
          'success'
        );

      } catch (error) {
        /*
         * Never leave the renderer showing an unsaved account
         * color after a failed request.
         */
        applyAccent(previousAccent);
        syncAccentControls(
          previousAccent
        );
        repaintAllMessageAccents();

        showToast(
          error.message,
          'error'
        );

      } finally {
        saveButton.disabled =
          false;
      }
    }
  );
}

// ============================================================
// Theme
// ============================================================

function bindTheme() {
  const container =
    document.getElementById(
      'theme-toggle'
    );

  if (!container) return;

  container.addEventListener(
    'click',
    event => {
      const button =
        event.target.closest(
          '.theme-toggle-btn'
        );

      if (!button) return;

      const theme =
        button.dataset.theme;

      if (!theme) return;

      applyTheme(theme);

      container
        .querySelectorAll(
          '.theme-toggle-btn'
        )
        .forEach(other => {
          other.classList.toggle(
            'selected',
            other === button
          );
        });
    }
  );
}

// ============================================================
// Bubble accent
// ============================================================

function bindBubbleAccent() {
  const toggle =
    document.getElementById(
      'bubble-accent-toggle'
    );

  if (!toggle) return;

  toggle.addEventListener(
    'click',
    () => {
      const next =
        !toggle.classList.contains(
          'on'
        );

      applyUseAccentForBubbles(
        next
      );

      toggle.classList.toggle(
        'on',
        next
      );

      toggle.setAttribute(
        'aria-checked',
        String(next)
      );

      repaintAllMessageAccents();
    }
  );
}

// ============================================================
// Animations
// ============================================================

function bindAnimations() {
  const toggle =
    document.getElementById(
      'animations-toggle'
    );

  if (!toggle) return;

  const enabled =
    getAnimationsEnabled();

  toggle.classList.toggle(
    'on',
    enabled
  );

  toggle.setAttribute(
    'aria-checked',
    String(enabled)
  );

  toggle.addEventListener(
    'click',
    () => {
      const next =
        !getAnimationsEnabled();

      const applied =
        applyAnimationsEnabled(
          next
        );

      toggle.classList.toggle(
        'on',
        applied
      );

      toggle.setAttribute(
        'aria-checked',
        String(applied)
      );
    }
  );
}

// ============================================================
// Hardware acceleration
// ============================================================

async function bindHardwareAcceleration(
  initialValue
) {
  const toggle =
    document.getElementById(
      'hardware-acceleration-toggle'
    );

  if (!toggle) return;

  toggle.classList.toggle(
    'on',
    Boolean(initialValue)
  );

  toggle.setAttribute(
    'aria-checked',
    String(Boolean(initialValue))
  );

  toggle.addEventListener(
    'click',
    async () => {
      const next =
        !toggle.classList.contains(
          'on'
        );

      toggle.classList.toggle(
        'on',
        next
      );

      toggle.setAttribute(
        'aria-checked',
        String(next)
      );

      try {
        await window.electronAPI
          .setHardwareAcceleration(
            next
          );

      } catch (error) {
        showToast(
          'Could not save that setting.',
          'error'
        );

        toggle.classList.toggle(
          'on',
          !next
        );

        toggle.setAttribute(
          'aria-checked',
          String(!next)
        );

        return;
      }

      const shouldRestart =
        await showConfirm(
          `Hardware acceleration is now ${
            next ? 'on' : 'off'
          }. Restart Wire now to apply this change?`,
          {
            title:
              'Restart required',

            confirmText:
              'Restart now',

            cancelText:
              'Later',

            danger:
              false
          }
        );

      if (shouldRestart) {
        window.electronAPI
          .relaunchApp();

      } else {
        showToast(
          'Setting saved — will apply next time Wire starts.'
        );
      }
    }
  );
}

// ============================================================
// Ambient
// ============================================================

function bindAmbient() {
  const container =
    document.getElementById(
      'ambient-levels'
    );

  if (!container) return;

  container.addEventListener(
    'click',
    event => {
      const button =
        event.target.closest(
          '.ambient-level-btn'
        );

      if (!button) return;

      const level =
        Number(
          button.dataset.level
        );

      if (!Number.isFinite(level)) {
        return;
      }

      applyAmbientLevel(level);

      container
        .querySelectorAll(
          '.ambient-level-btn'
        )
        .forEach(other => {
          other.classList.toggle(
            'selected',
            other === button
          );
        });
    }
  );
}

// ============================================================
// Background
// ============================================================

function bindBackgrounds() {
  const featured =
    document.getElementById(
      'bg-swatches-featured'
    );

  const more =
    document.getElementById(
      'bg-swatches-more'
    );

  const moreContainer =
    more;

  const moreToggle =
    document.getElementById(
      'bg-more-toggle'
    );

  const setMoreOpen = open => {
    if (
      !moreContainer ||
      !moreToggle
    ) {
      return;
    }

    moreContainer.classList.toggle(
      'is-open',
      open
    );

    moreToggle.classList.toggle(
      'is-open',
      open
    );

    moreToggle.setAttribute(
      'aria-expanded',
      String(open)
    );

    const label =
      moreToggle.querySelector(
        '.bg-more-toggle-label'
      );

    if (label) {
      label.textContent =
        open
          ? 'Show less'
          : 'Show more';
    }
  };

  moreToggle?.addEventListener(
    'click',
    () => {
      if (!moreContainer) return;

      setMoreOpen(
        !moreContainer.classList.contains(
          'is-open'
        )
      );
    }
  );

  const handleClick = event => {
    const swatch =
      event.target.closest(
        '.bg-swatch'
      );

    if (!swatch) return;

    const id =
      swatch.dataset.id;

    if (!id) return;

    applyBackgroundTheme(id);

    document
      .querySelectorAll(
        '.bg-swatch'
      )
      .forEach(button => {
        const selected =
          button.dataset.id === id;

        button.classList.toggle(
          'selected',
          selected
        );

        button.setAttribute(
          'aria-pressed',
          String(selected)
        );
      });

    if (
      !featured?.contains(swatch)
    ) {
      setMoreOpen(true);
    }
  };

  featured?.addEventListener(
    'click',
    handleClick
  );

  more?.addEventListener(
    'click',
    handleClick
  );
}

// ============================================================
// Public binder
// ============================================================

export async function bindAppearanceSettings({
  hardwareAccelerationEnabled
}) {
  bindTheme();
  bindAccentPresets();
  bindCustomAccent();
  bindAmbient();
  bindBackgrounds();

  bindMessageBubbleStyle();
  bindFont();

  bindBubbleAccent();
  bindAnimations();
  bindCustomAppearance();

  if (
    window.electronAPI?.isElectron
  ) {
    await bindHardwareAcceleration(
      hardwareAccelerationEnabled
    );
  }
}