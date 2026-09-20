import { ICONS } from '../icons.js';

import { escapeHtml } from '../core/utils.js';

import { bannerHtml } from '../ui/avatar.js';

import {
  progressBarHtml
} from '../files/upload.js';

import {
  ACCENT_PRESETS,
  AMBIENT_LEVELS,
  BACKGROUND_PRESETS,
  getCurrentAccentName,
  getCurrentAccentHex,
  getCurrentAmbientLevel,
  getCurrentTheme,
  getUseAccentForBubbles,
  getAnimationsEnabled,
  getCurrentBackgroundTheme,
  getBackgroundPreviewCss
} from './theme.js';

// ============================================================
// Background configuration
// ============================================================

const FEATURED_BACKGROUND_IDS = [
  'void',
  'aurora',
  'ocean',
  'midnight',
  'glass',
  'accent-flow',
  'accent-orbit',
  'nebula',
  'accent-glow',
  'accent-mesh'
];


// ============================================================
// Background helpers
// ============================================================

function splitBackgroundPresets() {
  const featured = [];
  const more = [];

  for (const preset of BACKGROUND_PRESETS) {
    if (
      FEATURED_BACKGROUND_IDS.includes(
        preset.id
      )
    ) {
      featured.push(preset);
    } else {
      more.push(preset);
    }
  }

  featured.sort(
    (a, b) =>
      FEATURED_BACKGROUND_IDS.indexOf(a.id) -
      FEATURED_BACKGROUND_IDS.indexOf(b.id)
  );

  return {
    featured,
    more
  };
}

function renderBackgroundPreset(
  preset,
  currentBackgroundId,
  currentTheme
) {
  const selected =
    preset.id === currentBackgroundId;

  const previewCss =
    getBackgroundPreviewCss(
      preset.id,
      {
        dark:
          currentTheme === 'dark'
      }
    );

  return `
    <button
      type="button"
      class="bg-swatch${selected ? ' selected' : ''}"
      data-id="${escapeHtml(preset.id)}"
      title="${escapeHtml(preset.name)}"
      aria-pressed="${selected}"
      aria-label="Use ${escapeHtml(preset.name)} background">

      <span
        class="bg-swatch-preview"
        style="background:${previewCss};">

        <span class="bg-swatch-check">
          ${ICONS.check || ''}
        </span>

      </span>

      <span class="bg-swatch-name">
        ${escapeHtml(preset.name)}
      </span>

    </button>
  `;
}


// ============================================================
// Appearance
// ============================================================

function renderAppearance({
  me,
  isElectronApp,
  hardwareAccelerationEnabled
}) {
  const currentAccentName =
    getCurrentAccentName();

  const currentAccentHex =
    me.accent_color ||
    getCurrentAccentHex();

  const swatchesHtml =
    ACCENT_PRESETS
      .map(p => `
        <button
          type="button"
          class="accent-swatch${
            p.name === currentAccentName
              ? ' selected'
              : ''
          }"
          data-name="${escapeHtml(p.name)}"
          title="${escapeHtml(p.name)}"
          style="--swatch-color:${p.hex};"
          aria-label="Select ${escapeHtml(p.name)} accent color">
        </button>
      `)
      .join('');

  const currentAmbientLevel =
    getCurrentAmbientLevel();

  const ambientLevelsHtml =
    AMBIENT_LEVELS
      .map((_, i) => `
        <button
          type="button"
          class="ambient-level-btn${
            i === currentAmbientLevel
              ? ' selected'
              : ''
          }"
          data-level="${i}"
          title="Level ${i + 1}"
          aria-label="Set ambient background intensity to level ${
            i + 1
          } of ${AMBIENT_LEVELS.length}">
          ${i + 1}
        </button>
      `)
      .join('');

  const currentTheme =
    getCurrentTheme();

  const currentBackgroundId =
    getCurrentBackgroundTheme();

  const {
    featured: featuredBackgrounds,
    more: moreBackgrounds
  } = splitBackgroundPresets();

  const currentBackgroundIsFeatured =
    featuredBackgrounds.some(
      preset =>
        preset.id === currentBackgroundId
    );

  const moreBackgroundsOpen =
    !currentBackgroundIsFeatured;

  const featuredBackgroundsHtml =
    featuredBackgrounds
      .map(preset =>
        renderBackgroundPreset(
          preset,
          currentBackgroundId,
          currentTheme
        )
      )
      .join('');

  const moreBackgroundsHtml =
    moreBackgrounds
      .map(preset =>
        renderBackgroundPreset(
          preset,
          currentBackgroundId,
          currentTheme
        )
      )
      .join('');

  const hasMoreBackgrounds =
    moreBackgrounds.length > 0;

  const useAccentForBubbles =
    getUseAccentForBubbles();

  const animationsEnabled =
    getAnimationsEnabled();

  return `
    <div class="settings-section">

      <div class="settings-section-title">
        Appearance
      </div>


      <!-- Theme -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Theme
          </div>

          <div class="settings-row-sublabel">
            Switch between dark and light
          </div>
        </div>

        <div
          class="theme-toggle"
          id="theme-toggle">

          <button
            type="button"
            class="theme-toggle-btn${
              currentTheme === 'dark'
                ? ' selected'
                : ''
            }"
            data-theme="dark">

            ${ICONS.moon || ''}
            <span>Dark</span>

          </button>

          <button
            type="button"
            class="theme-toggle-btn${
              currentTheme === 'light'
                ? ' selected'
                : ''
            }"
            data-theme="light">

            ${ICONS.sun || ''}
            <span>Light</span>

          </button>

        </div>

      </div>


      <!-- Accent -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Accent color
          </div>

          <div class="settings-row-sublabel">
            Choose a preset or pick any custom color
          </div>
        </div>

        <div
          class="accent-swatches"
          id="accent-swatches">

          ${swatchesHtml}

        </div>

      </div>


      <!-- Custom accent -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Custom accent
          </div>

          <div class="settings-row-sublabel">
            Pick any HEX color you want
          </div>
        </div>

        <div class="custom-accent-control">

          <span
            class="custom-accent-swatch-wrap"
            title="Choose custom accent color">

            <input
              type="color"
              id="custom-accent-color"
              value="${escapeHtml(currentAccentHex)}"
              title="Choose custom accent color"
            />

          </span>

          <input
            type="text"
            id="custom-accent-hex"
            class="custom-accent-hex-input"
            value="${escapeHtml(currentAccentHex)}"
            maxlength="7"
            placeholder="#5F84AD"
            spellcheck="false"
          />

          <button
            type="button"
            class="btn btn-sm btn-primary"
            id="save-custom-accent">

            Apply

          </button>

        </div>

      </div>


      <!-- Ambient -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Background intensity
          </div>

          <div class="settings-row-sublabel">
            How strong the ambient glow behind the app is
          </div>
        </div>

        <div
          class="ambient-levels"
          id="ambient-levels">

          ${ambientLevelsHtml}

        </div>

      </div>


      <!-- Background -->

      <div
        class="settings-row settings-row-column">

        <div>
          <div class="settings-row-label">
            Background
          </div>

          <div class="settings-row-sublabel">
            Choose the atmosphere behind the interface
          </div>
        </div>


        <div
          class="bg-swatches bg-swatches-featured"
          id="bg-swatches-featured">

          ${featuredBackgroundsHtml}

        </div>


        ${
          hasMoreBackgrounds
            ? `
              <div
                class="bg-more-wrap"
                id="bg-more-wrap">

                <button
                  type="button"
                  class="bg-more-toggle${
                    moreBackgroundsOpen
                      ? ' is-open'
                      : ''
                  }"
                  id="bg-more-toggle"
                  aria-expanded="${moreBackgroundsOpen}"
                  aria-controls="bg-swatches-more">

                  <span class="bg-more-toggle-label">
                    ${
                      moreBackgroundsOpen
                        ? 'Show less'
                        : 'Show more'
                    }
                  </span>

                  <span
                    class="bg-more-toggle-icon"
                    aria-hidden="true">

                    ${
                      ICONS.chevronDown ||
                      '⌄'
                    }

                  </span>

                </button>


                <div
                  class="bg-swatches bg-swatches-more${
                    moreBackgroundsOpen
                      ? ' is-open'
                      : ''
                  }"
                  id="bg-swatches-more">

                  ${moreBackgroundsHtml}

                </div>

              </div>
            `
            : ''
        }

      </div>


      <!-- Bubble accent -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Use accent color for chat bubbles
          </div>

          <div class="settings-row-sublabel">
            When off, message bubbles use the app's normal colors
          </div>
        </div>

        <button
          type="button"
          class="switch${
            useAccentForBubbles
              ? ' on'
              : ''
          }"
          id="bubble-accent-toggle"
          role="switch"
          aria-checked="${useAccentForBubbles}"
          aria-label="Use accent color for chat bubbles">

          <span class="switch-thumb"></span>

        </button>

      </div>


      <!-- Animations -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Animations
          </div>

          <div class="settings-row-sublabel">
            Subtle motion for page transitions, messages,
            modals and more throughout Wire
          </div>
        </div>

        <button
          type="button"
          class="switch${
            animationsEnabled
              ? ' on'
              : ''
          }"
          id="animations-toggle"
          role="switch"
          aria-checked="${animationsEnabled}"
          aria-label="Animations">

          <span class="switch-thumb"></span>

        </button>

      </div>


      <!-- Hardware acceleration -->

      ${
        isElectronApp
          ? `
            <div class="settings-row">

              <div>
                <div class="settings-row-label">
                  Hardware acceleration
                </div>

                <div class="settings-row-sublabel">
                  Use your GPU to render the app.
                  Turning this off can help with graphics
                  issues; takes effect after restarting Wire.
                </div>
              </div>

              <button
                type="button"
                class="switch${
                  hardwareAccelerationEnabled
                    ? ' on'
                    : ''
                }"
                id="hardware-acceleration-toggle"
                role="switch"
                aria-checked="${hardwareAccelerationEnabled}"
                aria-label="Hardware acceleration">

                <span class="switch-thumb"></span>

              </button>

            </div>
          `
          : ''
      }

    </div>
  `;
}


// ============================================================
// Banner
// ============================================================

function renderBanner(me) {
  return `
    <div
      class="profile-banner-wrap profile-banner-settings-wrap"
      id="profile-banner-wrap">

      ${bannerHtml(
        me.id,
        'profile-banner'
      )}

      <div class="profile-banner-actions">

        <input
          type="file"
          id="banner-input"
          class="hidden"
          accept="image/*"
          onchange="window.uploadBanner()"
        />

        <button
          type="button"
          class="btn btn-sm btn-glass"
          onclick="document.getElementById('banner-input').click()">

          ${ICONS.camera}
          Change banner

        </button>

        ${
          me.has_banner
            ? `
              <button
                type="button"
                class="btn btn-sm btn-glass btn-danger"
                onclick="window.removeBanner()">

                Remove

              </button>
            `
            : ''
        }

      </div>

    </div>

    ${progressBarHtml(
      'banner-upload-progress'
    )}
  `;
}


// ============================================================
// Profile
// ============================================================

function renderProfile(me) {
  const username =
    me.username || '?';

  const bio =
    me.bio || '';

  return `
    <div class="settings-section">

      <div class="settings-section-title">
        Profile
      </div>


      <div class="settings-row">

        <div
          style="
            display:flex;
            align-items:center;
            gap:16px;
          ">

          <div
            class="settings-avatar-big"
            id="settings-avatar"
            data-avatar-user="${Number(me.id)}">

            ${escapeHtml(
              username
                .charAt(0)
                .toUpperCase()
            )}

          </div>

          <div>

            <div class="settings-row-label">
              ${escapeHtml(username)}
            </div>

            <div class="settings-row-sublabel">
              ${
                me.is_admin
                  ? 'Administrator'
                  : 'Member'
              }
            </div>

          </div>

        </div>


        <div class="settings-avatar-actions">

          <input
            type="file"
            id="avatar-input"
            class="hidden"
            accept="image/*"
            onchange="window.uploadAvatar()"
          />

          <button
            type="button"
            class="btn btn-sm"
            onclick="document.getElementById('avatar-input').click()">

            ${ICONS.camera}
            Change photo

          </button>

          ${
            me.has_avatar
              ? `
                <button
                  type="button"
                  class="btn btn-sm btn-danger"
                  onclick="window.removeAvatar()">

                  Remove

                </button>
              `
              : ''
          }

        </div>

      </div>


      ${progressBarHtml(
        'avatar-upload-progress'
      )}


      <!-- Bio -->

      <div
        class="settings-row"
        style="
          flex-direction:column;
          align-items:stretch;
          gap:10px;
        ">

        <label
          class="settings-label"
          for="settings-bio">

          About me

        </label>

        <textarea
          id="settings-bio"
          rows="3"
          maxlength="300">${escapeHtml(
            bio
          )}</textarea>

        <div
          style="
            display:flex;
            justify-content:space-between;
            align-items:center;
          ">

          <span
            class="text-muted"
            id="bio-counter"
            style="font-size:11.5px;">

            ${bio.length}/300

          </span>

          <button
            type="button"
            class="btn btn-primary btn-sm"
            onclick="window.saveBio()">

            Save bio

          </button>

        </div>

      </div>

    </div>
  `;
}


// ============================================================
// Security
// ============================================================

function renderSecurity(security) {
  const emailFeatureEnabled =
    Boolean(
      security?.email_enabled
    );

  const email2FAEnabled =
    Boolean(
      security?.email_2fa_enabled
    );

  return `
    <div class="settings-section">

      <div class="settings-section-title">
        Security
      </div>


      <!-- Password -->

      <div
        class="settings-row"
        style="
          flex-direction:column;
          align-items:stretch;
          gap:10px;
        ">

        <label
          class="settings-label"
          for="pw-current">

          Change password

        </label>

        <input
          type="password"
          id="pw-current"
          placeholder="Current password"
          autocomplete="current-password"
        />

        <input
          type="password"
          id="pw-new"
          placeholder="New password"
          autocomplete="new-password"
        />

        <input
          type="password"
          id="pw-confirm"
          placeholder="Confirm new password"
          autocomplete="new-password"
        />

        <div
          id="pw-error"
          class="field-error">
        </div>

        <button
          type="button"
          class="btn btn-primary btn-sm"
          onclick="window.changePassword()"
          style="align-self:flex-start;">

          Update password

        </button>

      </div>


      ${
        emailFeatureEnabled
          ? `
            <div
              class="settings-row"
              style="
                flex-direction:column;
                align-items:stretch;
                gap:10px;
              ">

              <div
                style="
                  display:flex;
                  align-items:center;
                  justify-content:space-between;
                  gap:16px;
                ">

                <div>

                  <div class="settings-row-label">
                    Email 2FA
                  </div>

                  <div
                    class="settings-row-sublabel"
                    id="email-2fa-description">

                    Require a verification code from your email when signing in

                  </div>

                </div>


                <button
                  type="button"
                  class="switch${
                    email2FAEnabled
                      ? ' on'
                      : ''
                  }"
                  id="email-2fa-toggle"
                  role="switch"
                  aria-checked="${email2FAEnabled}"
                  aria-label="Enable or disable Email 2FA">

                  <span class="switch-thumb"></span>

                </button>

              </div>


              <!-- Enable -->

              <div
                id="email-2fa-setup"
                style="
                  display:none;
                  flex-direction:column;
                  gap:10px;
                  margin-top:4px;
                ">

                <input
                  type="password"
                  id="email-2fa-current-password"
                  placeholder="Current password"
                  autocomplete="current-password"
                />

                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  id="email-2fa-send-code"
                  style="align-self:flex-start;">

                  Send verification code

                </button>


                <div
                  id="email-2fa-code-section"
                  style="
                    display:none;
                    flex-direction:column;
                    gap:10px;
                  ">

                  <div
                    class="settings-row-sublabel"
                    id="email-2fa-code-message">

                    A verification code has been sent to your email.

                  </div>

                  <input
                    type="text"
                    id="email-2fa-code"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="6"
                    pattern="[0-9]{6}"
                    placeholder="6-digit verification code"
                  />

                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    id="email-2fa-verify"
                    style="align-self:flex-start;">

                    Verify and enable

                  </button>

                </div>

              </div>


              <!-- Disable -->

              <div
                id="email-2fa-disable"
                style="
                  display:none;
                  flex-direction:column;
                  gap:10px;
                  margin-top:4px;
                ">

                <div class="settings-row-sublabel">

                  Enter your current password to disable Email 2FA.

                </div>

                <input
                  type="password"
                  id="email-2fa-disable-password"
                  placeholder="Current password"
                  autocomplete="current-password"
                />

                <button
                  type="button"
                  class="btn btn-sm btn-danger"
                  id="email-2fa-confirm-disable"
                  style="align-self:flex-start;">

                  Disable Email 2FA

                </button>

              </div>


              <div
                id="email-2fa-error"
                class="field-error">
              </div>

            </div>
          `
          : ''
      }

    </div>
  `;
}


// ============================================================
// Account
// ============================================================

function renderAccount() {
  return `
    <div class="settings-section">

      <div class="settings-section-title">
        Account
      </div>

      <div class="settings-row">

        <div>

          <div class="settings-row-label">
            Sign out
          </div>

          <div class="settings-row-sublabel">
            End your session on this device
          </div>

        </div>

        <button
          type="button"
          class="btn btn-sm btn-danger"
          id="sign-out-button">

          Sign out

        </button>

      </div>

    </div>
  `;
}


// ============================================================
// Full page
// ============================================================

export function renderSettingsHtml({
  me,
  security
}) {
  const isElectronApp =
    Boolean(
      window.electronAPI &&
      window.electronAPI.isElectron
    );

  /*
   * Hardware acceleration is supplied asynchronously by the
   * caller, so the default here is only used as a fallback.
   */
  const hardwareAccelerationEnabled =
    arguments[0]
      ?.hardwareAccelerationEnabled ??
    true;

  return `
    <div class="settings-layout">

      ${renderAppearance({
        me,
        isElectronApp,
        hardwareAccelerationEnabled
      })}

      ${renderBanner(me)}

      ${renderProfile(me)}

      ${renderSecurity(security)}

      ${renderAccount()}

    </div>
  `;
}