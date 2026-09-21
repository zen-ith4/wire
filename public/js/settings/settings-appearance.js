import { api } from '../core/api.js';

import {
  showToast
} from '../core/utils.js';

import {
  ACCENT_PRESETS,
  applyAccent,
  applyAccentPreset,
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
  applyFontFamily
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

// ============================================================
// Appearance customization
// ============================================================

const BUBBLE_STYLE_STORAGE_KEY =
  'wire-message-bubble-style';

const BUBBLE_STYLES = [
  'filled',
  'soft',
  'outline',
  'clean'
];

// ============================================================
// Safe localStorage helpers
// ============================================================

function safeGetStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

// ============================================================
// Message bubble style
// ============================================================

function getMessageBubbleStyle() {
  const stored =
    safeGetStorage(
      BUBBLE_STYLE_STORAGE_KEY
    );

  return BUBBLE_STYLES.includes(stored)
    ? stored
    : 'filled';
}

function applyMessageBubbleStyle(style) {
  const normalized =
    BUBBLE_STYLES.includes(style)
      ? style
      : 'filled';

  document.documentElement.dataset
    .bubbleStyle = normalized;

  safeSetStorage(
    BUBBLE_STYLE_STORAGE_KEY,
    normalized
  );

  return normalized;
}

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

  const currentStyle =
    applyMessageBubbleStyle(
      getMessageBubbleStyle()
    );

  syncBubbleStyleButtons(
    container,
    currentStyle
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

  // The font itself was already applied at startup
  // (initFontFamily in app.js); this only syncs the control.
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
// Accent preset
// ============================================================

function bindAccentPresets() {
  const container =
    document.getElementById(
      'accent-swatches'
    );

  if (!container) return;

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

      applyAccentPreset(preset);

      container
        .querySelectorAll('.accent-swatch')
        .forEach(button => {
          button.classList.toggle(
            'selected',
            button === swatch
          );
        });

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
          preset.hex;
      }

      if (hexInput) {
        hexInput.value =
          preset.hex;
      }

      try {
        // This write makes the cached settings data stale (see settings.js).
        window.dispatchEvent(
          new Event('wire:settings-stale')
        );

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
                preset.hex
            })
          }
        );

        const updatedMe =
          await api('/api/me');

        setCurrentUser(updatedMe);

        repaintAllMessageAccents();

        showToast(
          'Accent color updated',
          'success'
        );

      } catch (error) {
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
      });
  };

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
    }
  );

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

      applyAccent(value);

      saveButton.disabled =
        true;

      try {
        // This write makes the cached settings data stale (see settings.js).
        window.dispatchEvent(
          new Event('wire:settings-stale')
        );

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

        setCurrentUser(updatedMe);

        repaintAllMessageAccents();

        if (colorInput) {
          colorInput.value =
            data.accent_color;
        }

        if (hexInput) {
          hexInput.value =
            data.accent_color;
        }

        showToast(
          'Custom accent saved',
          'success'
        );

      } catch (error) {
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

  // Always initialize the control from the actual
  // localStorage-backed state.
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
      // Read the real persisted state instead of
      // trusting whatever class the DOM currently has.
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

  /*
   * The renderer already received the current value, so there is
   * no second IPC read here.
   */
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

    /*
     * Any background outside the featured list lives inside
     * the "More" section. Keep it open after selection.
     */
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

  if (
    window.electronAPI?.isElectron
  ) {
    await bindHardwareAcceleration(
      hardwareAccelerationEnabled
    );
  }
}