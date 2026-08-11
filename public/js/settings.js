import { api } from './api.js';
import { ICONS } from './icons.js';
import { showToast, loadingState, emptyState, escapeHtml } from './utils.js';
import {
  progressBarHtml,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress,
  xhrUpload                          // ✅ added
} from './upload.js';
import { getCurrentUser, setCurrentUser } from './auth.js';
import { applyAvatar, invalidateAvatar, bannerHtml, invalidateBanner } from './avatar.js';
import { showConfirm } from './confirm.js';
import { ACCENT_PRESETS, applyAccentPreset, getCurrentAccentName, AMBIENT_LEVELS, applyAmbientLevel, getCurrentAmbientLevel } from './theme.js';

// Mirrors the server's defaults (config/constants.js AVATAR_MAX_MB /
// BANNER_MAX_MB, config/multer.js AVATAR_MIME_MAP) so invalid files
// get an instant, friendly message instead of waiting on a round
// trip to the server just to be rejected. The server remains the
// real source of truth/enforcement either way.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const BANNER_MAX_BYTES = 8 * 1024 * 1024;

function validateImageFile(file, maxBytes) {
  if (!IMAGE_TYPES.includes(file.type)) {
    return 'Please choose a JPG, PNG, WEBP, or GIF image.';
  }
  if (file.size > maxBytes) {
    return `Image is too large (max ${Math.round(maxBytes / (1024 * 1024))}MB).`;
  }
  return null;
}

export async function renderSettings() {
  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const me = await api('/api/me');
    const currentAccentName = getCurrentAccentName();
    const swatchesHtml = ACCENT_PRESETS.map(p => `
      <button
        class="accent-swatch${p.name === currentAccentName ? ' selected' : ''}"
        data-name="${p.name}"
        title="${p.name}"
        style="--swatch-color:${p.hex};"
        aria-label="Select ${p.name} accent color">
      </button>
    `).join('');

    const currentAmbientLevel = getCurrentAmbientLevel();
    const ambientLevelsHtml = AMBIENT_LEVELS.map((_, i) => `
      <button
        type="button"
        class="ambient-level-btn${i === currentAmbientLevel ? ' selected' : ''}"
        data-level="${i}"
        title="Level ${i + 1}"
        aria-label="Set ambient background intensity to level ${i + 1} of ${AMBIENT_LEVELS.length}">
        ${i + 1}
      </button>
    `).join('');

    main.innerHTML = `
      <div class="settings-layout">
        <div class="settings-section">
          <div class="settings-section-title">Appearance</div>
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Accent color</div>
              <div class="settings-row-sublabel">Applied sparingly to interactive elements and the background glow</div>
            </div>
            <div class="accent-swatches" id="accent-swatches">${swatchesHtml}</div>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Background intensity</div>
              <div class="settings-row-sublabel">How strong the ambient glow behind the app is</div>
            </div>
            <div class="ambient-levels" id="ambient-levels">${ambientLevelsHtml}</div>
          </div>
        </div>

        <div class="profile-banner-wrap profile-banner-settings-wrap" id="profile-banner-wrap">
          ${bannerHtml(me.id, 'profile-banner')}
          <div class="profile-banner-actions">
            <input type="file" id="banner-input" class="hidden" accept="image/*" onchange="window.uploadBanner()">
            <button class="btn btn-sm btn-glass" onclick="document.getElementById('banner-input').click()">${ICONS.camera} Change banner</button>
            ${me.has_banner ? `<button class="btn btn-sm btn-glass btn-danger" onclick="window.removeBanner()">Remove</button>` : ''}
          </div>
        </div>
        ${progressBarHtml('banner-upload-progress')}

        <div class="settings-section">
          <div class="settings-section-title">Profile</div>
          <div class="settings-row">
            <div style="display:flex;align-items:center;gap:16px;">
              <div class="settings-avatar-big" id="settings-avatar">${escapeHtml(me.username.charAt(0).toUpperCase())}</div>
              <div>
                <div class="settings-row-label">${escapeHtml(me.username)}</div>
                <div class="settings-row-sublabel">${me.is_admin ? 'Administrator' : 'Member'}</div>
              </div>
            </div>
            <div class="settings-avatar-actions">
              <input type="file" id="avatar-input" class="hidden" accept="image/*" onchange="window.uploadAvatar()">
              <button class="btn btn-sm" onclick="document.getElementById('avatar-input').click()">${ICONS.camera} Change photo</button>
              ${me.has_avatar ? `<button class="btn btn-sm btn-danger" onclick="window.removeAvatar()">Remove</button>` : ''}
            </div>
          </div>
          ${progressBarHtml('avatar-upload-progress')}
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px;">
            <label class="settings-label">About me</label>
            <textarea id="settings-bio" rows="3" maxlength="300">${escapeHtml(me.bio || '')}</textarea>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="text-muted" id="bio-counter" style="font-size:11.5px;">${(me.bio||'').length}/300</span>
              <button class="btn btn-primary btn-sm" onclick="window.saveBio()">Save bio</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Security</div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px;">
            <label class="settings-label">Change password</label>
            <input type="password" id="pw-current" placeholder="Current password">
            <input type="password" id="pw-new" placeholder="New password">
            <input type="password" id="pw-confirm" placeholder="Confirm new password">
            <div id="pw-error" class="field-error"></div>
            <button class="btn btn-primary btn-sm" onclick="window.changePassword()" style="align-self:flex-start;">Update password</button>
          </div>
        </div>
      </div>
    `;

    applyAvatar('settings-avatar', getCurrentUser()?.id);

    document.getElementById('accent-swatches').addEventListener('click', (e) => {
      const swatch = e.target.closest('.accent-swatch');
      if (!swatch) return;
      const preset = ACCENT_PRESETS.find(p => p.name === swatch.dataset.name);
      if (!preset) return;

      applyAccentPreset(preset);
      document.querySelectorAll('#accent-swatches .accent-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
    });

    document.getElementById('ambient-levels').addEventListener('click', (e) => {
      const btn = e.target.closest('.ambient-level-btn');
      if (!btn) return;
      const level = Number(btn.dataset.level);

      applyAmbientLevel(level);
      document.querySelectorAll('#ambient-levels .ambient-level-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });

    document.getElementById('settings-bio').addEventListener('input', (e) => {
      document.getElementById('bio-counter').textContent = `${e.target.value.length}/300`;
    });
  } catch (e) {
    main.innerHTML = `<div class="card">${emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message))}</div>`;
  }
}

window.saveBio = async function() {
  const bio = document.getElementById('settings-bio').value;
  try {
    await api('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio }),
    });
    // ✅ Update current user data
    const me = await api('/api/me');
    setCurrentUser(me);
    showToast('Bio saved', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.changePassword = async function() {
  const current_password = document.getElementById('pw-current').value;
  const new_password = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  const errEl = document.getElementById('pw-error');

  errEl.textContent = '';

  if (new_password !== confirm) {
    errEl.textContent = "New passwords don't match";
    return;
  }

  try {
    await api('/api/me/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    });

    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    showToast('Password updated', 'success');
  } catch (e) {
    errEl.textContent = e.message;
  }
};

window.uploadAvatar = async function() {
  const input = document.getElementById('avatar-input');
  const file = input.files[0];
  if (!file) return;

  const validationError = validateImageFile(file, AVATAR_MAX_BYTES);
  if (validationError) {
    showToast(validationError, 'error');
    input.value = '';
    return;
  }

  // Instant local preview — shows the picked image immediately,
  // before the upload even starts, using the same background-image
  // approach applyAvatar() uses so it looks identical either way.
  const previewUrl = URL.createObjectURL(file);
  const avatarEl = document.getElementById('settings-avatar');
  if (avatarEl) {
    avatarEl.style.backgroundImage = `url("${previewUrl}")`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  }

  const form = new FormData();
  form.append('file', file);

  showUploadProgress('avatar-upload-progress', file.name);

  try {
    await xhrUpload('/api/me/avatar', form, (pct) => updateUploadProgress('avatar-upload-progress', pct));
    invalidateAvatar(getCurrentUser()?.id);
    input.value = '';                     // ✅ clear input to allow re-upload of same file
    // ✅ await the async re-render
    await renderSettings();
    applyAvatar('profile-initials', getCurrentUser()?.id); // به‌روزرسانی آواتار بالای صفحه هم
    showToast('Photo updated', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    hideUploadProgress('avatar-upload-progress');  // ✅ always hide progress
    URL.revokeObjectURL(previewUrl);
  }
};

window.removeAvatar = async function() {
  if (!await showConfirm('Remove your profile photo?', { title: 'Remove photo' })) return;

  try {
    await api('/api/me/avatar', { method: 'DELETE' });
    invalidateAvatar(getCurrentUser()?.id);
    await renderSettings();
    applyAvatar('profile-initials', getCurrentUser()?.id);
    showToast('Photo removed', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.uploadBanner = async function() {
  const input = document.getElementById('banner-input');
  const file = input.files[0];
  if (!file) return;

  const validationError = validateImageFile(file, BANNER_MAX_BYTES);
  if (validationError) {
    showToast(validationError, 'error');
    input.value = '';
    return;
  }

  // Same instant-preview approach as the avatar, applied to whichever
  // banner element applyBanner() is currently managing.
  const previewUrl = URL.createObjectURL(file);
  const bannerWrap = document.getElementById('profile-banner-wrap');
  const bannerEl = bannerWrap ? bannerWrap.querySelector('.profile-banner') : null;
  if (bannerEl) {
    bannerEl.style.backgroundImage = `url("${previewUrl}")`;
    bannerEl.classList.add('has-banner');
  }

  const form = new FormData();
  form.append('file', file);

  showUploadProgress('banner-upload-progress', file.name);

  try {
    await xhrUpload('/api/me/banner', form, (pct) => updateUploadProgress('banner-upload-progress', pct));
    invalidateBanner(getCurrentUser()?.id);
    input.value = '';
    await renderSettings();
    showToast('Banner updated', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    hideUploadProgress('banner-upload-progress');
    URL.revokeObjectURL(previewUrl);
  }
};

window.removeBanner = async function() {
  if (!await showConfirm('Remove your profile banner?', { title: 'Remove banner' })) return;

  try {
    await api('/api/me/banner', { method: 'DELETE' });
    invalidateBanner(getCurrentUser()?.id);
    await renderSettings();
    showToast('Banner removed', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};