import {
  showToast
} from '../core/utils.js';

import {
  getCurrentUser
} from '../core/auth.js';

import {
  refreshAvatarEverywhere,
  refreshBannerEverywhere
} from '../ui/avatar.js';

import {
  showConfirm
} from '../ui/confirm.js';

import {
  xhrUpload,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress
} from '../files/upload.js';


// ============================================================
// Image validation
// ============================================================

const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
];

const AVATAR_MAX_BYTES =
  5 * 1024 * 1024;

const BANNER_MAX_BYTES =
  8 * 1024 * 1024;


function validateImageFile(
  file,
  maxBytes
) {
  if (
    !IMAGE_TYPES.includes(
      file.type
    )
  ) {
    return (
      'Please choose a JPG, PNG, WEBP, or GIF image.'
    );
  }

  if (file.size > maxBytes) {
    return `Image is too large (max ${Math.round(
      maxBytes /
      (1024 * 1024)
    )}MB).`;
  }

  return null;
}


// ============================================================
// Avatar upload
// ============================================================

async function uploadAvatar() {
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
    URL.createObjectURL(file);

  const avatar =
    document.getElementById(
      'settings-avatar'
    );

  if (avatar) {
    avatar.style.backgroundImage =
      `url("${previewUrl}")`;

    avatar.style.backgroundSize =
      'cover';

    avatar.style.backgroundPosition =
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
    // This write makes the cached settings data stale (see settings.js).
    window.dispatchEvent(new Event('wire:settings-stale'));
    await xhrUpload(
      '/api/me/avatar',
      form,
      percentage => {
        updateUploadProgress(
          'avatar-upload-progress',
          percentage
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

    /*
     * Keep renderSettings lazy-loaded to avoid introducing a
     * circular dependency at module evaluation time.
     */
    const {
      renderSettings
    } = await import(
      './settings.js'
    );

    await renderSettings();

    showToast(
      'Photo updated',
      'success'
    );

  } catch (error) {
    showToast(
      error.message,
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
}


// ============================================================
// Remove avatar
// ============================================================

async function removeAvatar() {
  const confirmed =
    await showConfirm(
      'Remove your profile photo?',
      {
        title:
          'Remove photo'
      }
    );

  if (!confirmed) {
    return;
  }

  try {
    const {
      api
    } = await import(
      '../core/api.js'
    );

    // This write makes the cached settings data stale (see settings.js).
    window.dispatchEvent(new Event('wire:settings-stale'));
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

    const {
      renderSettings
    } = await import(
      './settings.js'
    );

    await renderSettings();

    showToast(
      'Photo removed',
      'success'
    );

  } catch (error) {
    showToast(
      error.message,
      'error'
    );
  }
}


// ============================================================
// Banner upload
// ============================================================

async function uploadBanner() {
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
    URL.createObjectURL(file);

  const bannerWrap =
    document.getElementById(
      'profile-banner-wrap'
    );

  const banner =
    bannerWrap?.querySelector(
      '.profile-banner'
    );

  if (banner) {
    banner.style.backgroundImage =
      `url("${previewUrl}")`;

    banner.classList.add(
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
    // This write makes the cached settings data stale (see settings.js).
    window.dispatchEvent(new Event('wire:settings-stale'));
    await xhrUpload(
      '/api/me/banner',
      form,
      percentage => {
        updateUploadProgress(
          'banner-upload-progress',
          percentage
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

    const {
      renderSettings
    } = await import(
      './settings.js'
    );

    await renderSettings();

    showToast(
      'Banner updated',
      'success'
    );

  } catch (error) {
    showToast(
      error.message,
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
}


// ============================================================
// Remove banner
// ============================================================

async function removeBanner() {
  const confirmed =
    await showConfirm(
      'Remove your profile banner?',
      {
        title:
          'Remove banner'
      }
    );

  if (!confirmed) {
    return;
  }

  try {
    const {
      api
    } = await import(
      '../core/api.js'
    );

    // This write makes the cached settings data stale (see settings.js).
    window.dispatchEvent(new Event('wire:settings-stale'));
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

    const {
      renderSettings
    } = await import(
      './settings.js'
    );

    await renderSettings();

    showToast(
      'Banner removed',
      'success'
    );

  } catch (error) {
    showToast(
      error.message,
      'error'
    );
  }
}


// ============================================================
// Public binder
// ============================================================

export function bindMediaSettings() {
  /*
   * The existing settings markup still uses:
   *
   *   onchange="window.uploadAvatar()"
   *   onclick="window.removeAvatar()"
   *
   * Keep these globals during the refactor so we do not have to
   * change unrelated markup at the same time.
   */
  window.uploadAvatar =
    uploadAvatar;

  window.removeAvatar =
    removeAvatar;

  window.uploadBanner =
    uploadBanner;

  window.removeBanner =
    removeBanner;
}