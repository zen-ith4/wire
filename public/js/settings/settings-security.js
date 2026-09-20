import { api } from '../core/api.js';

import {
  showToast
} from '../core/utils.js';

import {
  reencryptIdentity
} from '../crypto/identity-service.js';

import {
  renderSettings
} from './settings.js';


// ============================================================
// Password
// ============================================================

async function changePassword() {
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

  const errorElement =
    document.getElementById(
      'pw-error'
    );

  if (
    !currentInput ||
    !newInput ||
    !confirmInput ||
    !errorElement
  ) {
    return;
  }

  const currentPassword =
    currentInput.value;

  const newPassword =
    newInput.value;

  const confirmation =
    confirmInput.value;

  errorElement.textContent =
    '';

  if (!currentPassword) {
    errorElement.textContent =
      'Current password is required';

    return;
  }

  if (!newPassword) {
    errorElement.textContent =
      'New password is required';

    return;
  }

  if (newPassword.length < 6) {
    errorElement.textContent =
      'New password must be at least 6 characters';

    return;
  }

  if (newPassword !== confirmation) {
    errorElement.textContent =
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
     * The encrypted identity must be re-encrypted with the new
     * password before the backend accepts the password change.
     */
    const encryptedIdentity =
      await reencryptIdentity(
        currentPassword,
        newPassword,
        localStorage.getItem('token')
      );

    await api(
      '/api/me/password',
      {
        method: 'PUT',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          current_password:
            currentPassword,

          new_password:
            newPassword,

          identity:
            encryptedIdentity
        })
      }
    );

    currentInput.value = '';
    newInput.value = '';
    confirmInput.value = '';

    showToast(
      'Password updated',
      'success'
    );

  } catch (error) {
    console.error(
      '[Settings] Password change failed:',
      error
    );

    errorElement.textContent =
      error.message ||
      'Failed to update password';

  } finally {
    if (button) {
      button.disabled =
        false;
    }
  }
}


// ============================================================
// Email 2FA state
// ============================================================

function createEmail2FAController() {
  const toggle =
    document.getElementById(
      'email-2fa-toggle'
    );

  if (!toggle) {
    return null;
  }

  const setup =
    document.getElementById(
      'email-2fa-setup'
    );

  const disable =
    document.getElementById(
      'email-2fa-disable'
    );

  const currentPassword =
    document.getElementById(
      'email-2fa-current-password'
    );

  const sendCode =
    document.getElementById(
      'email-2fa-send-code'
    );

  const codeSection =
    document.getElementById(
      'email-2fa-code-section'
    );

  const codeMessage =
    document.getElementById(
      'email-2fa-code-message'
    );

  const codeInput =
    document.getElementById(
      'email-2fa-code'
    );

  const verify =
    document.getElementById(
      'email-2fa-verify'
    );

  const disablePassword =
    document.getElementById(
      'email-2fa-disable-password'
    );

  const confirmDisable =
    document.getElementById(
      'email-2fa-confirm-disable'
    );

  const errorElement =
    document.getElementById(
      'email-2fa-error'
    );

  let challengeId =
    null;


  // ----------------------------------------------------------
  // Error
  // ----------------------------------------------------------

  function setError(message = '') {
    if (errorElement) {
      errorElement.textContent =
        message;
    }
  }


  // ----------------------------------------------------------
  // Close panels
  // ----------------------------------------------------------

  function closePanels() {
    if (setup) {
      setup.style.display =
        'none';
    }

    if (disable) {
      disable.style.display =
        'none';
    }

    if (codeSection) {
      codeSection.style.display =
        'none';
    }

    challengeId =
      null;

    if (currentPassword) {
      currentPassword.value =
        '';
    }

    if (codeInput) {
      codeInput.value =
        '';
    }

    if (disablePassword) {
      disablePassword.value =
        '';
    }

    if (sendCode) {
      sendCode.style.display =
        '';
    }
  }


  // ----------------------------------------------------------
  // Toggle
  // ----------------------------------------------------------

  toggle.addEventListener(
    'click',
    () => {
      const currentlyEnabled =
        toggle.classList.contains(
          'on'
        );

      setError('');

      if (currentlyEnabled) {
        closePanels();

        if (disable) {
          disable.style.display =
            'flex';
        }

        disablePassword?.focus();

        return;
      }

      closePanels();

      if (setup) {
        setup.style.display =
          'flex';
      }

      currentPassword?.focus();
    }
  );


  // ----------------------------------------------------------
  // Send verification code
  // ----------------------------------------------------------

  sendCode?.addEventListener(
    'click',
    async () => {
      setError('');

      const password =
        currentPassword?.value ||
        '';

      if (!password) {
        setError(
          'Current password is required'
        );

        currentPassword?.focus();

        return;
      }

      sendCode.disabled =
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
                  password
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

        challengeId =
          data.challengeId;

        if (codeSection) {
          codeSection.style.display =
            'flex';
        }

        if (codeMessage) {
          codeMessage.textContent =
            `A verification code has been sent to ${
              data.email ||
              'your email'
            }.`;
        }

        sendCode.style.display =
          'none';

        if (codeInput) {
          codeInput.value =
            '';

          codeInput.focus();
        }

      } catch (error) {
        setError(
          error.message ||
          'Failed to send verification code'
        );

      } finally {
        sendCode.disabled =
          false;
      }
    }
  );


  // ----------------------------------------------------------
  // Verify
  // ----------------------------------------------------------

  verify?.addEventListener(
    'click',
    async () => {
      setError('');

      const code =
        codeInput?.value.trim() ||
        '';

      if (!challengeId) {
        setError(
          'Verification session is missing'
        );

        return;
      }

      if (!/^\d{6}$/.test(code)) {
        setError(
          'Enter the 6-digit verification code'
        );

        codeInput?.focus();

        return;
      }

      verify.disabled =
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
              challengeId,
              code
            })
          }
        );

        showToast(
          'Email 2FA enabled',
          'success'
        );

        closePanels();

        await renderSettings();

      } catch (error) {
        setError(
          error.message ||
          'Invalid verification code'
        );

      } finally {
        verify.disabled =
          false;
      }
    }
  );


  // ----------------------------------------------------------
  // Disable
  // ----------------------------------------------------------

  confirmDisable?.addEventListener(
    'click',
    async () => {
      setError('');

      const password =
        disablePassword?.value ||
        '';

      if (!password) {
        setError(
          'Current password is required'
        );

        disablePassword?.focus();

        return;
      }

      confirmDisable.disabled =
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
                password
            })
          }
        );

        showToast(
          'Email 2FA disabled',
          'success'
        );

        closePanels();

        await renderSettings();

      } catch (error) {
        setError(
          error.message ||
          'Failed to disable Email 2FA'
        );

      } finally {
        confirmDisable.disabled =
          false;
      }
    }
  );

  return {
    closePanels
  };
}


// ============================================================
// Public binder
// ============================================================

export function bindSecuritySettings() {
  window.changePassword =
    changePassword;

  createEmail2FAController();
}