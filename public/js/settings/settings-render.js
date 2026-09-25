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
  getBackgroundPreviewCss,
  DENSITY_OPTIONS,
  getUIDensity,
  FONT_SIZE_OPTIONS,
  getFontSize
} from './theme.js';

import {
  renderCustomBackgroundSection,
  renderAdvancedAppearanceSection,
  renderResetAllRow
} from './settings-appearance-custom.js';

import {
  renderOwnBubbleGradientSection
} from './settings-bubble-gradient.js';

import {
  getDmNotificationsEnabled
} from '../notifications/notification-manager.js';
import { renderMessageSounds } from './settings-message-sounds.js';


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

  const currentDensity =
    getUIDensity();

  const densityLabels = {
    compact: 'Compact',
    default: 'Default',
    comfortable: 'Comfortable'
  };

  const densityToggleHtml =
    Object.keys(DENSITY_OPTIONS)
      .map(id => `
        <button
          type="button"
          class="theme-toggle-btn${
            id === currentDensity
              ? ' selected'
              : ''
          }"
          data-density="${id}"
          aria-pressed="${
            id === currentDensity
          }">
          <span>${
            densityLabels[id] || id
          }</span>
        </button>
      `)
      .join('');

  const currentFontSize =
    getFontSize();

  const fontSizeLabels = {
    small: 'Small',
    default: 'Default',
    large: 'Large',
    'extra-large': 'Extra Large'
  };

  const fontSizeToggleHtml =
    Object.keys(FONT_SIZE_OPTIONS)
      .map(id => `
        <button
          type="button"
          class="theme-toggle-btn${
            id === currentFontSize
              ? ' selected'
              : ''
          }"
          data-font-size="${id}"
          aria-pressed="${
            id === currentFontSize
          }">
          <span>${
            fontSizeLabels[id] || id
          }</span>
        </button>
      `)
      .join('');

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


      <!-- UI Density -->

      <div class="settings-row settings-row-column">

        <div>
          <div class="settings-row-label">
            UI density
          </div>

          <div class="settings-row-sublabel">
            Adjust spacing throughout the app without
            changing the visual design
          </div>
        </div>

        <div
          class="theme-toggle"
          id="density-toggle">

          ${densityToggleHtml}

        </div>

      </div>


      <!-- Font size -->

      <div class="settings-row settings-row-column">

        <div>
          <div class="settings-row-label">
            Font size
          </div>

          <div class="settings-row-sublabel">
            Adjust the size of text throughout the app
          </div>
        </div>

        <div
          class="theme-toggle"
          id="font-size-toggle">

          ${fontSizeToggleHtml}

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


      <!-- Custom background (local image) -->

      ${renderCustomBackgroundSection()}


      <!-- Message bubble style -->

      <div
        class="settings-row settings-row-column">

        <div>
          <div class="settings-row-label">
            Message bubbles
          </div>

          <div class="settings-row-sublabel">
            Choose how chat messages are displayed
          </div>
        </div>

        <div
          class="bubble-style-options"
          id="message-bubble-style">

          <!-- Filled -->

          <button
            type="button"
            class="bubble-style-option"
            data-style="filled"
            aria-pressed="false">

            <span
              class="bubble-style-preview bubble-style-preview-filled">

              <span class="bubble-style-preview-bubble">
                Hello
              </span>

            </span>

            <span class="bubble-style-option-label">
              Filled
            </span>

          </button>


          <!-- Soft -->

          <button
            type="button"
            class="bubble-style-option"
            data-style="soft"
            aria-pressed="false">

            <span
              class="bubble-style-preview bubble-style-preview-soft">

              <span class="bubble-style-preview-bubble">
                Hello
              </span>

            </span>

            <span class="bubble-style-option-label">
              Soft
            </span>

          </button>


          <!-- Outline -->

          <button
            type="button"
            class="bubble-style-option"
            data-style="outline"
            aria-pressed="false">

            <span
              class="bubble-style-preview bubble-style-preview-outline">

              <span class="bubble-style-preview-bubble">
                Hello
              </span>

            </span>

            <span class="bubble-style-option-label">
              Outline
            </span>

          </button>


          <!-- Clean -->

          <button
            type="button"
            class="bubble-style-option"
            data-style="clean"
            aria-pressed="false">

            <span
              class="bubble-style-preview bubble-style-preview-clean">

              <span class="bubble-style-preview-bubble">
                Hello
              </span>

            </span>

            <span class="bubble-style-option-label">
              Clean
            </span>

          </button>

        </div>

      </div>


      <!-- My message colors (own-bubble gradient) -->

      ${renderOwnBubbleGradientSection()}


      <!-- Interface font -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Interface font
          </div>

          <div class="settings-row-sublabel">
            Choose the font used throughout Wire
          </div>
        </div>

        <select
          id="font-family-select"
          aria-label="Interface font">

          <option value="system">
            System
          </option>

          <option value="inter">
            Inter
          </option>

          <option value="anthropic-sans">
            Anthropic Sans
          </option>

          <option value="noto-sans">
            Noto Sans
          </option>

          <option value="vazirmatn">
            Vazirmatn
          </option>

          <option value="roboto">
            Roboto
          </option>

          <option value="open-sans">
            Open Sans
          </option>

          <option value="poppins">
            Poppins
          </option>

          <option value="monospace">
            Monospace
          </option>

        </select>

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


      <!-- Advanced (transparency / blur) -->

      ${renderAdvancedAppearanceSection()}


      <!-- Reset -->

      ${renderResetAllRow()}

    </div>
  `;
}


// ============================================================
// Notifications
// ============================================================

function renderNotifications() {
  const dmNotificationsEnabled =
    getDmNotificationsEnabled();

  return `
    <div class="settings-section">

      <div class="settings-section-title">
        Notifications
      </div>


      <!-- DM notifications -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            DM Notifications
          </div>

          <div class="settings-row-sublabel">
            Get notified about new direct messages when
            you're not already looking at that conversation
          </div>
        </div>

        <button
          type="button"
          class="switch${
            dmNotificationsEnabled
              ? ' on'
              : ''
          }"
          id="dm-notifications-toggle"
          role="switch"
          aria-checked="${dmNotificationsEnabled}"
          aria-label="DM Notifications">

          <span class="switch-thumb"></span>

        </button>

      </div>

    </div>
  `;
}


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

function renderSecurity(security, privacy) {
  const emailFeatureEnabled =
    Boolean(
      security?.email_enabled
    );

  const email2FAEnabled =
    Boolean(
      security?.email_2fa_enabled
    );

  const showLastSeenEnabled =
    privacy?.show_last_seen !== false;

  const sendReadReceiptsEnabled =
    privacy?.send_read_receipts !== false;

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


    <!-- ============================================================
         Privacy
         ============================================================ -->

    <div class="settings-section">

      <div class="settings-section-title">
        Privacy
      </div>

      <!-- Show Last Seen & Online Status -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Show Last Seen &amp; Online Status
          </div>

          <div class="settings-row-sublabel">
            When off, other people can't see when you're online or your last seen time
          </div>
        </div>

        <button
          type="button"
          class="switch${
            showLastSeenEnabled
              ? ' on'
              : ''
          }"
          id="show-last-seen-toggle"
          role="switch"
          aria-checked="${showLastSeenEnabled}"
          aria-label="Show Last Seen &amp; Online Status">

          <span class="switch-thumb"></span>

        </button>

      </div>

      <!-- Send Read Receipts -->

      <div class="settings-row">

        <div>
          <div class="settings-row-label">
            Send Read Receipts
          </div>

          <div class="settings-row-sublabel">
            When off, other people won't see a "read" tick on messages you've read
          </div>
        </div>

        <button
          type="button"
          class="switch${
            sendReadReceiptsEnabled
              ? ' on'
              : ''
          }"
          id="send-read-receipts-toggle"
          role="switch"
          aria-checked="${sendReadReceiptsEnabled}"
          aria-label="Send Read Receipts">

          <span class="switch-thumb"></span>

        </button>

      </div>

      <div
        id="privacy-settings-error"
        class="field-error">
      </div>

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
// Category navigation
// ------------------------------------------------------------
// Settings is a category list (this file's SETTINGS_CATEGORIES)
// that drills into one dedicated page per category, instead of
// one long page with every section stacked. Each category still
// renders through the exact same render*() functions above —
// this section only decides *which* one(s) belong to which
// category and wraps them in the list/detail shell. Behavior
// (opening/closing a category, Back, animation) lives in
// settings-nav.js; this file stays templates-only, same as
// before the redesign.
//
// Do NOT list a category here that has no real settings behind
// it — every id below maps to an existing render function.
// ============================================================

export const SETTINGS_CATEGORIES = [
  {
    id: 'appearance',
    label: 'Appearance',
    sublabel: 'Theme, accent, background, fonts, animations',
    icon: ICONS.palette || ''
  },
  {
    id: 'profile',
    label: 'Profile',
    sublabel: 'Photo, banner and bio',
    icon: ICONS.user || ''
  },
  {
    id: 'notifications',
    label: 'Notifications',
    sublabel: 'Direct message notifications',
    icon: ICONS.mail || ''
  },
  {
    id: 'message-sounds',
    label: 'Message sounds',
    sublabel: 'Sounds, volume and custom files',
    icon: ICONS.volume || ''
  },
  {
    id: 'security',
    label: 'Security & Privacy',
    sublabel: 'Password, two-factor authentication, and privacy',
    icon: ICONS.shield || ''
  },
  {
    id: 'account',
    label: 'Account',
    sublabel: 'Sign out of this device',
    icon: ICONS.logout || ''
  }
];

function findCategory(categoryId) {
  return SETTINGS_CATEGORIES.find(
    c => c.id === categoryId
  ) || null;
}


// ============================================================
// Category list (the main Settings screen)
// ============================================================

function renderCategoryListHtml() {
  const rowsHtml =
    SETTINGS_CATEGORIES
      .map(cat => `
        <button
          type="button"
          class="settings-category-row"
          id="settings-category-row-${escapeHtml(cat.id)}"
          data-category="${escapeHtml(cat.id)}"
          role="listitem"
          aria-label="${escapeHtml(cat.label)}: ${escapeHtml(cat.sublabel)}">

          <span
            class="settings-category-row-icon"
            aria-hidden="true">

            ${cat.icon}

          </span>

          <span class="settings-category-row-text">

            <span class="settings-category-row-label">
              ${escapeHtml(cat.label)}
            </span>

            <span class="settings-category-row-sublabel">
              ${escapeHtml(cat.sublabel)}
            </span>

          </span>

          <span
            class="settings-category-row-chevron"
            aria-hidden="true">

            ${ICONS.chevronRight || ''}

          </span>

        </button>
      `)
      .join('');

  return `
    <div class="card settings-category-card">
      <div
        class="settings-category-list"
        id="settings-category-list"
        role="list">

        ${rowsHtml}

      </div>
    </div>
  `;
}


// ============================================================
// Category detail body — the content of one opened category.
//
// Every existing render*() function above is reused as-is; this
// only picks the right one(s) for the given category id. Kept as
// its own export so settings-nav.js can call it again when the
// user opens a *different* category without needing a full-page
// re-render (see openSettingsCategory()).
// ============================================================

export function renderCategoryBodyHtml(
  categoryId,
  {
    me,
    security,
    privacy,
    hardwareAccelerationEnabled
  }
) {
  const isElectronApp =
    Boolean(
      window.electronAPI &&
      window.electronAPI.isElectron
    );

  const resolvedHardwareAcceleration =
    hardwareAccelerationEnabled ??
    true;

  switch (categoryId) {
    case 'appearance':
      return renderAppearance({
        me,
        isElectronApp,
        hardwareAccelerationEnabled:
          resolvedHardwareAcceleration
      });

    case 'profile':
      return (
        renderBanner(me) +
        renderProfile(me)
      );

    case 'notifications':
      return renderNotifications();

    case 'message-sounds':
      return renderMessageSounds();

    case 'security':
      return renderSecurity(security, privacy);

    case 'account':
      return renderAccount();

    default:
      return '';
  }
}


// ============================================================
// Full page
//
// A grid-stacked shell: the category list and the opened
// category's detail pane occupy the same grid cell (see
// .settings-shell in settings.css) so the container's height is
// always the taller of the two and swapping between them never
// jumps. Only ONE of them is ever interactive at a time — see
// .category-open in settings.css and settings-nav.js.
//
// activeCategoryId is supplied by settings.js (from
// settings-nav.js's module state) so a re-render triggered from
// *inside* an open category (password change, avatar upload,
// email 2FA, etc. — see settings-security.js/settings-media.js)
// redraws that same category's fresh data instead of bouncing
// back to the category list.
// ============================================================

export function renderSettingsHtml({
  me,
  security,
  privacy,
  hardwareAccelerationEnabled,
  activeCategoryId
}) {
  const activeCategory =
    activeCategoryId
      ? findCategory(activeCategoryId)
      : null;

  const bodyHtml =
    activeCategory
      ? renderCategoryBodyHtml(
          activeCategory.id,
          {
            me,
            security,
            privacy,
            hardwareAccelerationEnabled
          }
        )
      : '';

  return `
    <div
      class="settings-shell${
        activeCategory
          ? ' category-open'
          : ''
      }"
      id="settings-shell">

      <div class="settings-pane settings-pane-list">

        ${renderCategoryListHtml()}

      </div>

      <div
        class="settings-pane settings-pane-detail"
        id="settings-category-detail">

        <div class="settings-category-header">

          <button
            type="button"
            class="settings-category-back"
            id="settings-category-back"
            aria-label="Back to Settings">

            ${ICONS.arrowLeft || ''}
            <span>Settings</span>

          </button>

          <div
            class="settings-category-header-title"
            id="settings-category-title">

            ${
              activeCategory
                ? escapeHtml(activeCategory.label)
                : ''
            }

          </div>

        </div>

        <div
          class="settings-category-body"
          id="settings-category-body">

          ${bodyHtml}

        </div>

      </div>

    </div>
  `;
}