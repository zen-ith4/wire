import {
  logout
} from '../core/auth.js';


// ============================================================
// Account
// ============================================================

export function bindAccountSettings() {
  const button =
    document.getElementById(
      'sign-out-button'
    );

  if (!button) {
    return;
  }

  button.addEventListener(
    'click',
    () => {
      logout();
      window.location.reload();
    }
  );
}