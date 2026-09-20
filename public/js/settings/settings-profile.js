import { api } from '../core/api.js';

import {
  showToast
} from '../core/utils.js';

import {
  getCurrentUser,
  setCurrentUser
} from '../core/auth.js';

import {
  applyAvatar
} from '../ui/avatar.js';


// ============================================================
// Profile
// ============================================================

function bindBio() {
  const bio =
    document.getElementById(
      'settings-bio'
    );

  const counter =
    document.getElementById(
      'bio-counter'
    );

  if (!bio) return;

  bio.addEventListener(
    'input',
    () => {
      if (counter) {
        counter.textContent =
          `${bio.value.length}/300`;
      }
    }
  );
}


// ============================================================
// Save bio
// ============================================================

async function saveBio() {
  const textarea =
    document.getElementById(
      'settings-bio'
    );

  if (!textarea) return;

  try {
    // This write makes the cached settings data stale (see settings.js).
    window.dispatchEvent(new Event('wire:settings-stale'));
    await api(
      '/api/me',
      {
        method: 'PUT',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          bio:
            textarea.value
        })
      }
    );

    const me =
      await api('/api/me');

    setCurrentUser(me);

    showToast(
      'Bio saved',
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

export function bindProfileSettings({
  me
}) {
  const avatar =
    document.getElementById(
      'settings-avatar'
    );

  if (avatar) {
    applyAvatar(
      'settings-avatar',
      me.id
    );
  }

  bindBio();

  /*
   * Keep the existing inline HTML API intact.
   * This means existing markup does not need to be rewritten
   * during this refactor.
   */
  window.saveBio =
    saveBio;
}