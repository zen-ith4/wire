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
  setCurrentUser
} from '../core/auth.js';

import {
  applyAvatar,
  bannerHtml,
  refreshAvatarEverywhere,
  refreshBannerEverywhere
} from '../ui/avatar.js';

import { showConfirm } from '../ui/confirm.js';

import {
  ACCENT_PRESETS,
  applyAccent,
  applyAccentPreset,
  getCurrentAccentName,
  getCurrentAccentHex,
  AMBIENT_LEVELS,
  applyAmbientLevel,
  getCurrentAmbientLevel
} from './theme.js';


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


          <!-- Presets -->

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
              onclick="window.logout()">
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
    // Accent preset picker
    // ==========================================================

    const accentSwatches =
      document.getElementById('accent-swatches');

    accentSwatches?.addEventListener('click', async (e) => {

      const swatch =
        e.target.closest('.accent-swatch');

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
          button.classList.remove('selected');
        });

      swatch.classList.add('selected');

      const colorInput =
        document.getElementById('custom-accent-color');

      const hexInput =
        document.getElementById('custom-accent-hex');

      if (colorInput) {
        colorInput.value =
          preset.hex;
      }

      if (hexInput) {
        hexInput.value =
          preset.hex;
      }

      try {

        await api('/api/me/accent-color', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            accent_color: preset.hex
          })
        });

        const me =
          await api('/api/me');

        setCurrentUser(me);

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
    });


    // ==========================================================
    // Custom color picker
    // ==========================================================

    const customColor =
      document.getElementById('custom-accent-color');

    const customHex =
      document.getElementById('custom-accent-hex');

    const saveCustomAccent =
      document.getElementById('save-custom-accent');


    // Color picker -> HEX input
    customColor?.addEventListener('input', () => {

      if (customHex) {
        customHex.value =
          customColor.value.toUpperCase();
      }

      // Live preview.
      applyAccent(
        customColor.value
      );

      document
        .querySelectorAll(
          '#accent-swatches .accent-swatch'
        )
        .forEach(button => {
          button.classList.remove('selected');
        });
    });


    // HEX input -> live preview
    customHex?.addEventListener('input', () => {

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
            button.classList.remove('selected');
          });
      }
    });


    // Save custom color to database.
    saveCustomAccent?.addEventListener(
      'click',
      async () => {

        const value =
          customHex?.value.trim().toUpperCase();

        if (
          !/^#[0-9A-F]{6}$/.test(value || '')
        ) {
          showToast(
            'Invalid HEX color. Example: #5F84AD',
            'error'
          );
          return;
        }

        applyAccent(value);

        saveCustomAccent.disabled = true;

        try {

          const data =
            await api('/api/me/accent-color', {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                accent_color: value
              })
            });

          const me =
            await api('/api/me');

          setCurrentUser(me);

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

          saveCustomAccent.disabled = false;
        }
      }
    );


    // ==========================================================
    // Ambient intensity
    // ==========================================================

    const ambientLevels =
      document.getElementById('ambient-levels');

    ambientLevels?.addEventListener('click', (e) => {

      const button =
        e.target.closest('.ambient-level-btn');

      if (!button) return;

      const level =
        Number(button.dataset.level);

      applyAmbientLevel(level);

      document
        .querySelectorAll(
          '#ambient-levels .ambient-level-btn'
        )
        .forEach(b => {
          b.classList.remove('selected');
        });

      button.classList.add('selected');
    });


    // ==========================================================
    // Bio counter
    // ==========================================================

    const bio =
      document.getElementById('settings-bio');

    const bioCounter =
      document.getElementById('bio-counter');

    bio?.addEventListener('input', (e) => {

      if (bioCounter) {
        bioCounter.textContent =
          `${e.target.value.length}/300`;
      }

    });

  } catch (e) {

    main.innerHTML = `
      <div class="card">
        ${emptyState(
          ICONS.empty,
          'Failed to load',
          escapeHtml(e.message)
        )}
      </div>
    `;
  }
}


// ============================================================
// Save bio
// ============================================================

window.saveBio = async function () {

  const textarea =
    document.getElementById('settings-bio');

  if (!textarea) return;

  const bio =
    textarea.value;

  try {

    await api('/api/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bio
      })
    });

    const me =
      await api('/api/me');

    setCurrentUser(me);

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


// ============================================================
// Change password
// ============================================================

window.changePassword = async function () {

  const currentInput =
    document.getElementById('pw-current');

  const newInput =
    document.getElementById('pw-new');

  const confirmInput =
    document.getElementById('pw-confirm');

  const errEl =
    document.getElementById('pw-error');

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

  errEl.textContent = '';

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

  try {

    await api('/api/me/password', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        current_password,
        new_password
      })
    });

    currentInput.value = '';
    newInput.value = '';
    confirmInput.value = '';

    showToast(
      'Password updated',
      'success'
    );

  } catch (e) {

    errEl.textContent =
      e.message;
  }
};


// ============================================================
// Upload avatar
// ============================================================

window.uploadAvatar = async function () {

  const input =
    document.getElementById('avatar-input');

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

    input.value = '';

    return;
  }

  const previewUrl =
    URL.createObjectURL(file);

  const avatarEl =
    document.getElementById('settings-avatar');

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
      refreshAvatarEverywhere(user.id);
    }

    input.value = '';

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


// ============================================================
// Remove avatar
// ============================================================

window.removeAvatar = async function () {

  const confirmed =
    await showConfirm(
      'Remove your profile photo?',
      {
        title: 'Remove photo'
      }
    );

  if (!confirmed) return;

  try {

    await api(
      '/api/me/avatar',
      {
        method: 'DELETE'
      }
    );

    const user =
      getCurrentUser();

    if (user?.id) {
      refreshAvatarEverywhere(user.id);
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


// ============================================================
// Upload banner
// ============================================================

window.uploadBanner = async function () {

  const input =
    document.getElementById('banner-input');

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

    input.value = '';

    return;
  }

  const previewUrl =
    URL.createObjectURL(file);

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
      refreshBannerEverywhere(user.id);
    }

    input.value = '';

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


// ============================================================
// Remove banner
// ============================================================

window.removeBanner = async function () {

  const confirmed =
    await showConfirm(
      'Remove your profile banner?',
      {
        title: 'Remove banner'
      }
    );

  if (!confirmed) return;

  try {

    await api(
      '/api/me/banner',
      {
        method: 'DELETE'
      }
    );

    const user =
      getCurrentUser();

    if (user?.id) {
      refreshBannerEverywhere(user.id);
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