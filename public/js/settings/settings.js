import { api } from '../core/api.js';
import { ICONS } from '../icons.js';

import {
  showToast,
  loadingState,
  emptyState,
  escapeHtml
} from '../core/utils.js';

import {
  progressBarHtml,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress,
  xhrUpload
} from '../files/upload.js';

import {
  getCurrentUser,
  setCurrentUser,
  logout
} from '../core/auth.js';

import {
  applyAvatar,
  bannerHtml,
  refreshAvatarEverywhere,
  refreshBannerEverywhere
} from '../ui/avatar.js';

import { showConfirm } from '../ui/confirm.js';
import { repaintAllMessageAccents } from '../chat/message-accent.js';

import {
  ACCENT_PRESETS,
  applyAccent,
  applyAccentPreset,
  getCurrentAccentName,
  getCurrentAccentHex,
  AMBIENT_LEVELS,
  applyAmbientLevel,
  getCurrentAmbientLevel,
  getCurrentTheme,
  applyTheme,
  getUseAccentForBubbles,
  applyUseAccentForBubbles,
  BACKGROUND_PRESETS,
  applyBackgroundTheme,
  getCurrentBackgroundTheme,
  getBackgroundPreviewCss
} from './theme.js';

import {
  reencryptIdentity
} from '../crypto/identity-service.js';


// ============================================================
// Image validation
// ============================================================

const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
];

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const BANNER_MAX_BYTES = 8 * 1024 * 1024;


function validateImageFile(file, maxBytes) {
  if (!IMAGE_TYPES.includes(file.type)) {
    return 'Please choose a JPG, PNG, WEBP, or GIF image.';
  }

  if (file.size > maxBytes) {
    return `Image is too large (max ${Math.round(
      maxBytes / (1024 * 1024)
    )}MB).`;
  }

  return null;
}


// ============================================================
// Security settings
// ============================================================

async function loadSecuritySettings() {
  return api('/api/settings/security');
}


// ============================================================
// Render settings
// ============================================================

export async function renderSettings() {
  const main = document.getElementById('content-area');

  if (!main) return;

  main.innerHTML = `
    <div class="card">
      ${loadingState()}
    </div>
  `;

  try {
    const me = await api('/api/me');
    const security = await loadSecuritySettings();

    const email2FAEnabled =
      Boolean(security.email_2fa_enabled);

    /*
     * The backend-provided feature state is authoritative.
     * The entire Email 2FA section is omitted from the
     * rendered DOM whenever email is disabled server-side —
     * this is not just a disabled toggle.
     */
    const emailFeatureEnabled =
      Boolean(security.email_enabled);


    // ========================================================
    // Accent presets
    // ========================================================

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


    // ========================================================
    // Ambient
    // ========================================================

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


    // ========================================================
    // Theme
    // ========================================================

    const currentTheme =
      getCurrentTheme();


    // ========================================================
    // Background theme
    // ========================================================

    const currentBackgroundId =
      getCurrentBackgroundTheme();

    const backgroundSwatchesHtml =
      BACKGROUND_PRESETS
        .map(p => `
          <button
            type="button"
            class="bg-swatch${
              p.id === currentBackgroundId
                ? ' selected'
                : ''
            }"
            data-id="${escapeHtml(p.id)}"
            title="${escapeHtml(p.name)}"
            aria-pressed="${p.id === currentBackgroundId}"
            aria-label="Use ${escapeHtml(p.name)} background">

            <span
              class="bg-swatch-preview"
              style="background:${
                getBackgroundPreviewCss(
                  p.id,
                  { dark: currentTheme === 'dark' }
                )
              };">
              <span class="bg-swatch-check">${ICONS.check || ''}</span>
            </span>

            <span class="bg-swatch-name">
              ${escapeHtml(p.name)}
            </span>

          </button>
        `)
        .join('');


    // ========================================================
    // Use accent color for chat bubbles
    // ========================================================

    const useAccentForBubbles =
      getUseAccentForBubbles();


    // ========================================================
    // Settings HTML
    // ========================================================

    main.innerHTML = `
      <div class="settings-layout">

        <!-- ================================================== -->
        <!-- Appearance -->
        <!-- ================================================== -->

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


          <!-- Accent presets -->

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


          <!-- Custom color -->

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


          <!-- Background theme -->

          <div class="settings-row settings-row-column">

            <div>
              <div class="settings-row-label">
                Background
              </div>

              <div class="settings-row-sublabel">
                Choose the atmosphere behind the interface
              </div>
            </div>

            <div
              class="bg-swatches"
              id="bg-swatches">

              ${backgroundSwatchesHtml}

            </div>

          </div>


          <!-- Use accent color for chat bubbles -->

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

        </div>


        <!-- ================================================== -->
        <!-- Banner -->
        <!-- ================================================== -->

        <div
          class="profile-banner-wrap profile-banner-settings-wrap"
          id="profile-banner-wrap">

          ${bannerHtml(me.id, 'profile-banner')}

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


        ${progressBarHtml('banner-upload-progress')}


        <!-- ================================================== -->
        <!-- Profile -->
        <!-- ================================================== -->

        <div class="settings-section">

          <div class="settings-section-title">
            Profile
          </div>


          <!-- Profile identity -->

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
                  (me.username || '?')
                    .charAt(0)
                    .toUpperCase()
                )}

              </div>


              <div>

                <div class="settings-row-label">
                  ${escapeHtml(me.username)}
                </div>

                <div class="settings-row-sublabel">
                  ${me.is_admin ? 'Administrator' : 'Member'}
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


          ${progressBarHtml('avatar-upload-progress')}


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
              maxlength="300">${escapeHtml(me.bio || '')}</textarea>

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

                ${(me.bio || '').length}/300

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


        <!-- ================================================== -->
        <!-- Security -->
        <!-- ================================================== -->

        <div class="settings-section">

          <div class="settings-section-title">
            Security
          </div>


          <!-- Change password -->

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


          <!-- Email 2FA -->
          <!--
            The entire section is omitted from the DOM (not just
            hidden/disabled) when the backend reports the email
            feature as disabled.
          -->
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


            <!-- ============================================== -->
            <!-- Inline enable panel -->
            <!-- ============================================== -->

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


            <!-- ============================================== -->
            <!-- Inline disable panel -->
            <!-- ============================================== -->

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


        <!-- ================================================== -->
        <!-- Account -->
        <!-- ================================================== -->

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

      </div>
    `;


    // ==========================================================
    // Initial avatar
    // ==========================================================

    applyAvatar(
      'settings-avatar',
      me.id
    );


    // ==========================================================
    // Sign out
    // ==========================================================

    const signOutButton =
      document.getElementById(
        'sign-out-button'
      );

    signOutButton?.addEventListener(
      'click',
      () => {
        logout();
        window.location.reload();
      }
    );


    // ==========================================================
    // Accent preset picker
    // ==========================================================

    const accentSwatches =
      document.getElementById(
        'accent-swatches'
      );

    accentSwatches?.addEventListener(
      'click',
      async (e) => {

        const swatch =
          e.target.closest(
            '.accent-swatch'
          );

        if (!swatch) return;

        const preset =
          ACCENT_PRESETS.find(
            p => p.name === swatch.dataset.name
          );

        if (!preset) return;


        // Apply immediately for instant feedback.
        applyAccentPreset(preset);


        document
          .querySelectorAll(
            '#accent-swatches .accent-swatch'
          )
          .forEach(button => {
            button.classList.remove(
              'selected'
            );
          });

        swatch.classList.add(
          'selected'
        );


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

          setCurrentUser(
            updatedMe
          );

          repaintAllMessageAccents();


          showToast(
            'Accent color updated',
            'success'
          );

        } catch (e) {

          showToast(
            e.message,
            'error'
          );

        }

      }
    );


    // ==========================================================
    // Custom color picker
    // ==========================================================

    const customColor =
      document.getElementById(
        'custom-accent-color'
      );

    const customHex =
      document.getElementById(
        'custom-accent-hex'
      );

    const saveCustomAccent =
      document.getElementById(
        'save-custom-accent'
      );


    // Color picker -> HEX input

    customColor?.addEventListener(
      'input',
      () => {

        if (customHex) {
          customHex.value =
            customColor.value.toUpperCase();
        }


        applyAccent(
          customColor.value
        );


        document
          .querySelectorAll(
            '#accent-swatches .accent-swatch'
          )
          .forEach(button => {
            button.classList.remove(
              'selected'
            );
          });

      }
    );


    // HEX input -> live preview

    customHex?.addEventListener(
      'input',
      () => {

        const value =
          customHex.value.trim();


        if (
          /^#[0-9a-fA-F]{6}$/.test(value)
        ) {

          const normalized =
            value.toUpperCase();


          if (customColor) {
            customColor.value =
              normalized;
          }


          applyAccent(
            normalized
          );


          document
            .querySelectorAll(
              '#accent-swatches .accent-swatch'
            )
            .forEach(button => {
              button.classList.remove(
                'selected'
              );
            });

        }

      }
    );


    // Save custom color to database.

    saveCustomAccent?.addEventListener(
      'click',
      async () => {

        const value =
          customHex?.value
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


        applyAccent(
          value
        );


        saveCustomAccent.disabled =
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

          setCurrentUser(
            updatedMe
          );

          repaintAllMessageAccents();


          if (customColor) {
            customColor.value =
              data.accent_color;
          }

          if (customHex) {
            customHex.value =
              data.accent_color;
          }


          showToast(
            'Custom accent saved',
            'success'
          );

        } catch (e) {

          showToast(
            e.message,
            'error'
          );

        } finally {

          saveCustomAccent.disabled =
            false;

        }

      }
    );


    // ==========================================================
    // Theme toggle
    // ==========================================================

    const themeToggle =
      document.getElementById(
        'theme-toggle'
      );

    themeToggle?.addEventListener(
      'click',
      (e) => {

        const button =
          e.target.closest(
            '.theme-toggle-btn'
          );

        if (!button) return;


        const theme =
          button.dataset.theme;


        applyTheme(
          theme
        );


        document
          .querySelectorAll(
            '#theme-toggle .theme-toggle-btn'
          )
          .forEach(b => {
            b.classList.remove(
              'selected'
            );
          });


        button.classList.add(
          'selected'
        );

      }
    );


    // ==========================================================
    // Use accent color for chat bubbles
    // ==========================================================

    const bubbleAccentToggle =
      document.getElementById(
        'bubble-accent-toggle'
      );

    bubbleAccentToggle?.addEventListener(
      'click',
      () => {

        const next =
          !bubbleAccentToggle.classList.contains(
            'on'
          );


        applyUseAccentForBubbles(
          next
        );


        bubbleAccentToggle.classList.toggle(
          'on',
          next
        );


        bubbleAccentToggle.setAttribute(
          'aria-checked',
          String(next)
        );


        repaintAllMessageAccents();

      }
    );


    // ==========================================================
    // Ambient intensity
    // ==========================================================

    const ambientLevels =
      document.getElementById(
        'ambient-levels'
      );

    ambientLevels?.addEventListener(
      'click',
      (e) => {

        const button =
          e.target.closest(
            '.ambient-level-btn'
          );

        if (!button) return;


        const level =
          Number(
            button.dataset.level
          );


        applyAmbientLevel(
          level
        );


        document
          .querySelectorAll(
            '#ambient-levels .ambient-level-btn'
          )
          .forEach(b => {
            b.classList.remove(
              'selected'
            );
          });


        button.classList.add(
          'selected'
        );

      }
    );


    // ==========================================================
    // Background theme picker
    // ==========================================================

    const bgSwatches =
      document.getElementById(
        'bg-swatches'
      );

    bgSwatches?.addEventListener(
      'click',
      (e) => {

        const swatch =
          e.target.closest(
            '.bg-swatch'
          );

        if (!swatch) return;

        const id =
          swatch.dataset.id;


        applyBackgroundTheme(
          id
        );


        document
          .querySelectorAll(
            '#bg-swatches .bg-swatch'
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

        swatch.classList.add(
          'selected'
        );

        swatch.setAttribute(
          'aria-pressed',
          'true'
        );

      }
    );


    // ==========================================================
    // Bio counter
    // ==========================================================

    const bio =
      document.getElementById(
        'settings-bio'
      );

    const bioCounter =
      document.getElementById(
        'bio-counter'
      );


    bio?.addEventListener(
      'input',
      (e) => {

        if (bioCounter) {
          bioCounter.textContent =
            `${e.target.value.length}/300`;
        }

      }
    );


    // ==========================================================
    // Email 2FA
    // ==========================================================

    const email2FAToggle =
      document.getElementById(
        'email-2fa-toggle'
      );

    const email2FASetup =
      document.getElementById(
        'email-2fa-setup'
      );

    const email2FADisable =
      document.getElementById(
        'email-2fa-disable'
      );

    const email2FACurrentPassword =
      document.getElementById(
        'email-2fa-current-password'
      );

    const email2FASendCode =
      document.getElementById(
        'email-2fa-send-code'
      );

    const email2FACodeSection =
      document.getElementById(
        'email-2fa-code-section'
      );

    const email2FACodeMessage =
      document.getElementById(
        'email-2fa-code-message'
      );

    const email2FACode =
      document.getElementById(
        'email-2fa-code'
      );

    const email2FAVerify =
      document.getElementById(
        'email-2fa-verify'
      );

    const email2FADisablePassword =
      document.getElementById(
        'email-2fa-disable-password'
      );

    const email2FAConfirmDisable =
      document.getElementById(
        'email-2fa-confirm-disable'
      );

    const email2FAError =
      document.getElementById(
        'email-2fa-error'
      );


    let email2FAChallengeId =
      null;


    // ----------------------------------------------------------
    // Email 2FA helpers
    // ----------------------------------------------------------

    function setEmail2FAError(
      message = ''
    ) {

      if (email2FAError) {
        email2FAError.textContent =
          message;
      }

    }

    function closeEmail2FAPanels() {

      if (email2FASetup) {
        email2FASetup.style.display =
          'none';
      }


      if (email2FADisable) {
        email2FADisable.style.display =
          'none';
      }


      if (email2FACodeSection) {
        email2FACodeSection.style.display =
          'none';
      }


      email2FAChallengeId =
        null;


      if (email2FACurrentPassword) {
        email2FACurrentPassword.value =
          '';
      }


      if (email2FACode) {
        email2FACode.value =
          '';
      }


      if (email2FADisablePassword) {
        email2FADisablePassword.value =
          '';
      }


      if (email2FASendCode) {
        email2FASendCode.style.display =
          '';
      }

    }


    // ----------------------------------------------------------
    // Email 2FA toggle
    // ----------------------------------------------------------

    email2FAToggle?.addEventListener(
      'click',
      () => {

        const currentlyEnabled =
          email2FAToggle.classList.contains(
            'on'
          );


        setEmail2FAError(
          ''
        );


        if (currentlyEnabled) {

          /*
           * User is requesting to disable
           * Email 2FA.
           *
           * IMPORTANT:
           * The switch remains ON until
           * the server confirms success.
           */

          closeEmail2FAPanels();


          if (email2FADisable) {
            email2FADisable.style.display =
              'flex';
          }


          email2FADisablePassword?.focus();

          return;
        }


        /*
         * User is requesting to enable
         * Email 2FA.
         *
         * IMPORTANT:
         * The switch remains OFF until
         * the server confirms success.
         */

        closeEmail2FAPanels();


        if (email2FASetup) {
          email2FASetup.style.display =
            'flex';
        }


        email2FACurrentPassword?.focus();

      }
    );


    // ----------------------------------------------------------
    // Send verification code
    // ----------------------------------------------------------

    email2FASendCode?.addEventListener(
      'click',
      async () => {

        setEmail2FAError(
          ''
        );


        const currentPassword =
          email2FACurrentPassword?.value || '';


        if (!currentPassword) {

          setEmail2FAError(
            'Current password is required'
          );


          email2FACurrentPassword?.focus();

          return;
        }


        email2FASendCode.disabled =
          true;


        try {

          const data =
            await api(
              '/api/settings/2fa/email/enable',
              {
                method: 'POST',

                headers: {
                  'Content-Type':
                    'application/json'
                },

                body: JSON.stringify({
                  current_password:
                    currentPassword
                })
              }
            );


          if (
            !data ||
            !data.challengeId
          ) {

            throw new Error(
              'Invalid two-factor setup response'
            );

          }


          email2FAChallengeId =
            data.challengeId;


          if (email2FACodeSection) {
            email2FACodeSection.style.display =
              'flex';
          }


          if (email2FACodeMessage) {

            email2FACodeMessage.textContent =
              `A verification code has been sent to ${
                data.email || 'your email'
              }.`;

          }


          email2FASendCode.style.display =
            'none';


          if (email2FACode) {

            email2FACode.value =
              '';

            email2FACode.focus();

          }

        } catch (e) {

          setEmail2FAError(
            e.message ||
            'Failed to send verification code'
          );

        } finally {

          email2FASendCode.disabled =
            false;

        }

      }
    );


    // ----------------------------------------------------------
    // Verify code and enable
    // ----------------------------------------------------------

    email2FAVerify?.addEventListener(
      'click',
      async () => {

        setEmail2FAError(
          ''
        );


        const code =
          email2FACode?.value.trim() || '';


        if (!email2FAChallengeId) {

          setEmail2FAError(
            'Verification session is missing'
          );

          return;
        }


        if (!/^\d{6}$/.test(code)) {

          setEmail2FAError(
            'Enter the 6-digit verification code'
          );


          email2FACode?.focus();

          return;
        }


        email2FAVerify.disabled =
          true;


        try {

          await api(
            '/api/settings/2fa/email/verify',
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/json'
              },

              body: JSON.stringify({
                challengeId:
                  email2FAChallengeId,

                code
              })
            }
          );


          showToast(
            'Email 2FA enabled',
            'success'
          );


          /*
           * Do not manually switch the UI.
           *
           * renderSettings() fetches the actual
           * server state and renders the switch
           * from that state.
           */

          closeEmail2FAPanels();

          await renderSettings();

        } catch (e) {

          setEmail2FAError(
            e.message ||
            'Invalid verification code'
          );

        } finally {

          email2FAVerify.disabled =
            false;

        }

      }
    );


    // ----------------------------------------------------------
    // Disable Email 2FA
    // ----------------------------------------------------------

    email2FAConfirmDisable?.addEventListener(
      'click',
      async () => {

        setEmail2FAError(
          ''
        );


        const currentPassword =
          email2FADisablePassword?.value || '';


        if (!currentPassword) {

          setEmail2FAError(
            'Current password is required'
          );


          email2FADisablePassword?.focus();

          return;
        }


        email2FAConfirmDisable.disabled =
          true;


        try {

          await api(
            '/api/settings/2fa/email/disable',
            {
              method: 'POST',

              headers: {
                'Content-Type':
                  'application/json'
              },

              body: JSON.stringify({
                current_password:
                  currentPassword
              })
            }
          );


          showToast(
            'Email 2FA disabled',
            'success'
          );


          /*
           * Again, do not manually switch
           * the toggle.
           *
           * The server is the source of truth.
           */

          closeEmail2FAPanels();

          await renderSettings();

        } catch (e) {

          setEmail2FAError(
            e.message ||
            'Failed to disable Email 2FA'
          );

        } finally {

          email2FAConfirmDisable.disabled =
            false;

        }

      }
    );


    // ==========================================================
    // Save bio
    // ==========================================================

    window.saveBio = async function () {

      const textarea =
        document.getElementById(
          'settings-bio'
        );


      if (!textarea) return;


      const bio =
        textarea.value;


      try {

        await api(
          '/api/me',
          {
            method: 'PUT',

            headers: {
              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({
              bio
            })
          }
        );


        const me =
          await api('/api/me');


        setCurrentUser(
          me
        );


        showToast(
          'Bio saved',
          'success'
        );

      } catch (e) {

        showToast(
          e.message,
          'error'
        );

      }

    };


    // ==========================================================
    // Change password
    // ==========================================================

    window.changePassword = async function () {

      const currentInput =
        document.getElementById(
          'pw-current'
        );

      const newInput =
        document.getElementById(
          'pw-new'
        );

      const confirmInput =
        document.getElementById(
          'pw-confirm'
        );

      const errEl =
        document.getElementById(
          'pw-error'
        );


      if (
        !currentInput ||
        !newInput ||
        !confirmInput ||
        !errEl
      ) {
        return;
      }


      const current_password =
        currentInput.value;

      const new_password =
        newInput.value;

      const confirm =
        confirmInput.value;


      errEl.textContent =
        '';


      if (!current_password) {

        errEl.textContent =
          'Current password is required';

        return;
      }


      if (!new_password) {

        errEl.textContent =
          'New password is required';

        return;
      }


      if (new_password.length < 6) {

        errEl.textContent =
          'New password must be at least 6 characters';

        return;
      }


      if (new_password !== confirm) {

        errEl.textContent =
          "New passwords don't match";

        return;
      }


      const button =
        document.querySelector(
          '[onclick="window.changePassword()"]'
        );


      if (button) {
        button.disabled =
          true;
      }


      try {

        /*
         * Re-encrypt the SAME identity private key
         * with the new password.
         *
         * This happens entirely in the browser.
         *
         * If the user has no identity yet,
         * reencryptIdentity() returns null.
         */

        const encryptedIdentity =
          await reencryptIdentity(
            current_password,
            new_password,
            localStorage.getItem(
              'token'
            )
          );


        /*
         * The backend verifies the old account
         * password and atomically updates:
         *
         *   users.password_hash
         *   identity_keys encrypted metadata
         */

        await api(
          '/api/me/password',
          {
            method: 'PUT',

            headers: {
              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({
              current_password,
              new_password,

              identity:
                encryptedIdentity
            })
          }
        );


        /*
         * The private CryptoKey currently in RAM
         * is still the exact same key.
         *
         * Nothing needs to be regenerated or
         * re-unlocked during the current session.
         */

        currentInput.value =
          '';

        newInput.value =
          '';

        confirmInput.value =
          '';


        showToast(
          'Password updated',
          'success'
        );

      } catch (e) {

        console.error(
          '[Settings] Password change failed:',
          e
        );


        errEl.textContent =
          e.message ||
          'Failed to update password';

      } finally {

        if (button) {
          button.disabled =
            false;
        }

      }

    };


    // ==========================================================
    // Upload avatar
    // ==========================================================

    window.uploadAvatar = async function () {

      const input =
        document.getElementById(
          'avatar-input'
        );


      if (!input) return;


      const file =
        input.files?.[0];


      if (!file) return;


      const validationError =
        validateImageFile(
          file,
          AVATAR_MAX_BYTES
        );


      if (validationError) {

        showToast(
          validationError,
          'error'
        );


        input.value =
          '';


        return;
      }


      const previewUrl =
        URL.createObjectURL(
          file
        );


      const avatarEl =
        document.getElementById(
          'settings-avatar'
        );


      if (avatarEl) {

        avatarEl.style.backgroundImage =
          `url("${previewUrl}")`;

        avatarEl.style.backgroundSize =
          'cover';

        avatarEl.style.backgroundPosition =
          'center';

      }


      const form =
        new FormData();


      form.append(
        'file',
        file
      );


      showUploadProgress(
        'avatar-upload-progress',
        file.name
      );


      try {

        await xhrUpload(
          '/api/me/avatar',
          form,
          pct => {

            updateUploadProgress(
              'avatar-upload-progress',
              pct
            );

          }
        );


        const user =
          getCurrentUser();


        if (user?.id) {

          refreshAvatarEverywhere(
            user.id
          );

        }


        input.value =
          '';


        await renderSettings();


        showToast(
          'Photo updated',
          'success'
        );

      } catch (e) {

        showToast(
          e.message,
          'error'
        );

      } finally {

        hideUploadProgress(
          'avatar-upload-progress'
        );


        URL.revokeObjectURL(
          previewUrl
        );

      }

    };


    // ==========================================================
    // Remove avatar
    // ==========================================================

    window.removeAvatar = async function () {

      const confirmed =
        await showConfirm(
          'Remove your profile photo?',
          {
            title:
              'Remove photo'
          }
        );


      if (!confirmed) return;


      try {

        await api(
          '/api/me/avatar',
          {
            method:
              'DELETE'
          }
        );


        const user =
          getCurrentUser();


        if (user?.id) {

          refreshAvatarEverywhere(
            user.id
          );

        }


        await renderSettings();


        showToast(
          'Photo removed',
          'success'
        );

      } catch (e) {

        showToast(
          e.message,
          'error'
        );

      }

    };


    // ==========================================================
    // Upload banner
    // ==========================================================

    window.uploadBanner = async function () {

      const input =
        document.getElementById(
          'banner-input'
        );


      if (!input) return;


      const file =
        input.files?.[0];


      if (!file) return;


      const validationError =
        validateImageFile(
          file,
          BANNER_MAX_BYTES
        );


      if (validationError) {

        showToast(
          validationError,
          'error'
        );


        input.value =
          '';


        return;
      }


      const previewUrl =
        URL.createObjectURL(
          file
        );


      const bannerWrap =
        document.getElementById(
          'profile-banner-wrap'
        );


      const bannerEl =
        bannerWrap?.querySelector(
          '.profile-banner'
        );


      if (bannerEl) {

        bannerEl.style.backgroundImage =
          `url("${previewUrl}")`;

        bannerEl.classList.add(
          'has-banner'
        );

      }


      const form =
        new FormData();


      form.append(
        'file',
        file
      );


      showUploadProgress(
        'banner-upload-progress',
        file.name
      );


      try {

        await xhrUpload(
          '/api/me/banner',
          form,
          pct => {

            updateUploadProgress(
              'banner-upload-progress',
              pct
            );

          }
        );


        const user =
          getCurrentUser();


        if (user?.id) {

          refreshBannerEverywhere(
            user.id
          );

        }


        input.value =
          '';


        await renderSettings();


        showToast(
          'Banner updated',
          'success'
        );

      } catch (e) {

        showToast(
          e.message,
          'error'
        );

      } finally {

        hideUploadProgress(
          'banner-upload-progress'
        );


        URL.revokeObjectURL(
          previewUrl
        );

      }

    };


    // ==========================================================
    // Remove banner
    // ==========================================================

    window.removeBanner = async function () {

      const confirmed =
        await showConfirm(
          'Remove your profile banner?',
          {
            title:
              'Remove banner'
          }
        );


      if (!confirmed) return;


      try {

        await api(
          '/api/me/banner',
          {
            method:
              'DELETE'
          }
        );


        const user =
          getCurrentUser();


        if (user?.id) {

          refreshBannerEverywhere(
            user.id
          );

        }


        await renderSettings();


        showToast(
          'Banner removed',
          'success'
        );

      } catch (e) {

        showToast(
          e.message,
          'error'
        );

      }

    };

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