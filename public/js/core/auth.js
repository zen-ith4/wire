import { api } from './api.js';

import {
  createIdentity,
  restoreIdentity,
  restoreIdentityWithUnlockKey
} from '../crypto/identity-service.js';


let currentUser = null;
let token = localStorage.getItem('token');

/*
 * Password is kept only in memory while the user
 * is completing email verification or 2FA.
 *
 * Never store this in localStorage/sessionStorage.
 */
let pendingVerification = null;


/* =========================================================
 * Token / User
 * ========================================================= */

export function getToken() {
  return token;
}


export function setToken(newToken) {
  token = newToken;

  if (newToken) {
    localStorage.setItem('token', newToken);
  } else {
    localStorage.removeItem('token');
  }
}


export function getCurrentUser() {
  return currentUser;
}


export function setCurrentUser(user) {
  currentUser = user;
}


export function logout() {
  const signedOutUser = currentUser;

  setToken(null);
  currentUser = null;
  pendingVerification = null;

  /*
   * Explicit sign-out must also invalidate auto-unlock: clear the
   * OS-secured unlock key (Electron only) so the next launch goes
   * through the normal password flow, exactly like a fresh device.
   *
   * Fire-and-forget: logout() has always been synchronous and
   * existing callers (api.js on a real 401, the Settings sign-out
   * button before window.location.reload()) call it without
   * awaiting. The clear is a local IPC round-trip to the already-
   * running main process, which completes independently of this
   * renderer reloading.
   */
  clearPersistedUnlockKey(signedOutUser).catch(err => {
    console.error(
      '[Identity] Failed to clear unlock key on logout:',
      err
    );
  });
}


/* =========================================================
 * Auto-unlock (Electron only)
 *
 * The E2EE identity's derived unlock key (see identity.js /
 * identity-service.js) can be cached in OS-level secure storage
 * (Electron's safeStorage) so a valid, already-authenticated
 * session can restore the identity on the next launch without a
 * password prompt. None of this exists in the browser build -
 * every function here is a no-op there.
 * ========================================================= */

function isElectron() {
  return (
    typeof window !== 'undefined' &&
    Boolean(
      window.electronAPI &&
      window.electronAPI.isElectron
    )
  );
}


async function persistUnlockKey(
  unlockKey,
  user
) {
  if (
    !isElectron() ||
    !unlockKey ||
    !user
  ) {
    return;
  }

  try {

    await window.electronAPI.storeIdentityUnlockKey(
      window.location.origin,
      user.id,
      unlockKey
    );

  } catch (err) {

    // Non-fatal: auto-unlock simply won't be available next
    // launch. The normal password flow is unaffected.
    console.error(
      '[Identity] Failed to persist unlock key:',
      err
    );
  }
}


export async function clearPersistedUnlockKey(user) {
  if (
    !isElectron() ||
    !user
  ) {
    return;
  }

  try {

    await window.electronAPI.clearIdentityUnlockKey(
      window.location.origin,
      user.id
    );

  } catch (err) {

    console.error(
      '[Identity] Failed to clear unlock key:',
      err
    );
  }
}


/*
 * Attempts to unlock the E2EE identity using material cached from
 * a previous successful login on this device - no password
 * prompt. Returns true if the identity is now unlocked, false if
 * auto-unlock isn't available/applicable (browser, first login on
 * this device, or the cached material is missing/stale) - callers
 * should fall back to the normal password unlock (renderUnlock)
 * in that case.
 */
export async function attemptAutoUnlock(
  user,
  currentToken
) {
  if (
    !isElectron() ||
    !user ||
    !currentToken
  ) {
    return false;
  }

  let cached;

  try {

    cached =
      await window.electronAPI.getIdentityUnlockKey(
        window.location.origin,
        user.id
      );

  } catch (err) {

    console.error(
      '[Identity] Failed to read unlock key:',
      err
    );

    return false;
  }

  const unlockKey =
    cached && cached.unlockKey;

  if (!unlockKey) {
    return false;
  }

  try {

    await restoreIdentityWithUnlockKey(
      unlockKey,
      currentToken
    );

    return true;

  } catch (err) {

    /*
     * The cached material is missing, stale (e.g. the account
     * password was changed elsewhere), or otherwise fails to
     * decrypt. Treat this exactly like "not available": clear it
     * so we don't keep retrying a dead key on every future
     * launch, and let the caller fall back to the password
     * prompt.
     */
    console.warn(
      '[Identity] Auto-unlock failed, falling back to password:',
      err
    );

    await clearPersistedUnlockKey(user);

    return false;
  }
}


/* =========================================================
 * Identity
 * ========================================================= */

export async function initializeIdentity(
  password,
  onSuccess = null
) {

  if (!token) {
    throw new Error(
      'Authentication token not found'
    );
  }

  if (
    typeof password !== 'string' ||
    password.length === 0
  ) {
    throw new Error(
      'Password is required'
    );
  }


  const identity =
    await api(
      '/api/me/identity-key',
      {
        method: 'GET',

        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );


  if (
    !identity ||
    typeof identity.exists !== 'boolean'
  ) {
    throw new Error(
      'Invalid identity response'
    );
  }


  let result;

  if (!identity.exists) {

    console.log(
      '[Identity] Creating identity...'
    );

    result = await createIdentity(
      password,
      token
    );

    console.log(
      '[Identity] Identity created successfully'
    );

  } else {

    console.log(
      '[Identity] Restoring identity...'
    );

    result = await restoreIdentity(
      password,
      token
    );

    console.log(
      '[Identity] Identity restored successfully'
    );
  }


  /*
   * Cache the derived unlock key (Electron only) so the NEXT
   * launch can restore this identity automatically, without a
   * password prompt. This is never the password itself and never
   * the raw private key - only the PBKDF2-derived AES key that
   * already exists transiently in memory during every normal
   * unlock (see identity.js).
   */
  await persistUnlockKey(
    result?.unlockKey,
    currentUser
  );


  if (
    typeof onSuccess === 'function'
  ) {
    await onSuccess();
  }
}


/* =========================================================
 * Login
 * ========================================================= */

export async function login(
  username,
  password
) {

  const data =
    await api(
      '/api/auth/login',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          username,
          password
        })
      }
    );


  if (
    !data ||
    data.id == null ||
    !data.username
  ) {
    throw new Error(
      'Invalid login response'
    );
  }


  /*
   * The password is correct, but the account
   * still requires email verification.
   *
   * The backend intentionally does not issue
   * a normal JWT in this state.
   */
  if (
    data.requiresEmailVerification === true ||
    (
      data.email &&
      data.email_verified === false
    )
  ) {
    return data;
  }


  /*
   * The password is correct and the account
   * requires email 2FA.
   *
   * No JWT exists yet.
   */
  if (
    data.requiresTwoFactor === true
  ) {
    if (
      !data.challengeId
    ) {
      throw new Error(
        'Invalid two-factor authentication response'
      );
    }

    return data;
  }


  /*
   * A fully authenticated account must receive
   * a valid JWT.
   */
  if (!data.token) {
    throw new Error(
      'Invalid login response'
    );
  }


  setToken(data.token);


  setCurrentUser({
    id: data.id,
    username: data.username,
    email: data.email ?? null,
    email_verified: Boolean(
      data.email_verified
    ),
    is_admin: Boolean(
      data.is_admin
    ),
    email_2fa_enabled: Boolean(
      data.email_2fa_enabled
    ),
    accent_color: data.accent_color ?? null
  });


  return data;
}


/* =========================================================
 * Verify Email 2FA
 * ========================================================= */

export async function verifyTwoFactor(
  userId,
  challengeId,
  code
) {

  const data =
    await api(
      '/api/auth/verify-2fa',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          userId,
          challengeId,
          code
        })
      }
    );


  if (
    !data ||
    !data.token ||
    data.id == null ||
    !data.username
  ) {
    throw new Error(
      'Invalid two-factor authentication response'
    );
  }


  setToken(data.token);


  setCurrentUser({
    id: data.id,
    username: data.username,
    email: data.email ?? null,
    email_verified: Boolean(
      data.email_verified
    ),
    is_admin: Boolean(
      data.is_admin
    ),
    email_2fa_enabled: Boolean(
      data.email_2fa_enabled
    ),
    accent_color: data.accent_color ?? null
  });


  return data;
}


/* =========================================================
 * Register
 * ========================================================= */

export async function register(
  username,
  email,
  password
) {

  const data =
    await api(
      '/api/auth/register',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          username,
          email,
          password
        })
      }
    );


  if (
    !data ||
    data.id == null ||
    !data.username
  ) {
    throw new Error(
      'Invalid registration response'
    );
  }


  /*
   * Email is enabled: registration does not authenticate the
   * user yet. Keep the password only in memory so that the
   * E2EE identity can be initialized immediately after
   * successful email verification.
   */
  if (data.requiresEmailVerification === true) {

    if (!data.email) {
      throw new Error(
        'Invalid registration response'
      );
    }

    pendingVerification = {
      userId: data.id,
      username: data.username,
      email: data.email,
      password
    };

    return data;
  }


  /*
   * Email is disabled: there is no verification step, so the
   * server considers the account immediately usable and returns
   * a normal authentication token right away.
   */
  if (!data.token) {
    throw new Error(
      'Invalid registration response'
    );
  }

  setToken(data.token);

  setCurrentUser({
    id: data.id,
    username: data.username,
    email: data.email ?? null,
    email_verified: true,
    is_admin: Boolean(
      data.is_admin
    ),
    email_2fa_enabled: Boolean(
      data.email_2fa_enabled
    ),
    accent_color: data.accent_color ?? null
  });

  return data;
}


/* =========================================================
 * Email Verification
 * ========================================================= */

export async function verifyEmail(
  userId,
  code
) {

  const data =
    await api(
      '/api/auth/verify-email',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          userId,
          code
        })
      }
    );


  if (
    !data ||
    !data.token ||
    data.id == null ||
    !data.username
  ) {
    throw new Error(
      'Invalid email verification response'
    );
  }


  setToken(data.token);


  setCurrentUser({
    id: data.id,
    username: data.username,
    email: data.email ?? null,
    email_verified: true,
    is_admin: Boolean(
      data.is_admin
    ),
    email_2fa_enabled: Boolean(
      data.email_2fa_enabled
    ),
    accent_color: data.accent_color ?? null
  });


  return data;
}


export async function resendVerification(
  userId
) {

  const data =
    await api(
      '/api/auth/resend-verification',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          userId
        })
      }
    );


  if (
    !data ||
    data.success !== true
  ) {
    throw new Error(
      'Failed to resend verification code'
    );
  }


  return data;
}


/* =========================================================
 * Email Verification UI
 * ========================================================= */

function renderVerification(
  verification,
  onSuccess
) {

  const wrap =
    document.getElementById(
      'login-wrap'
    );


  if (!wrap) {

    console.error(
      'Login container not found'
    );

    return;
  }


  wrap.style.display = 'flex';


  wrap.innerHTML = `
    <div class="card login-card">

      <div class="login-mark">
        <img
          src="/img/logo.jpg"
          alt="Wire"
        />
      </div>

      <h1>
        Verify your email
      </h1>

      <p class="hint">
        We sent a 6-digit verification code to
        <strong>${escapeHtml(verification.email)}</strong>
      </p>

      <form id="verification-form">

        <input
          type="text"
          id="verification-code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          pattern="[0-9]{6}"
          placeholder="Verification code"
          required
        >

        <button
          type="submit"
          class="btn btn-primary"
        >
          Verify email
        </button>

      </form>

      <div
        id="verification-error"
        class="field-error"
      ></div>

      <div class="auth-switch">
        Didn't receive the code?

        <button
          type="button"
          id="resend-verification"
          class="btn btn-ghost btn-sm"
          style="margin-left:4px;"
        >
          Resend
        </button>
      </div>

      <div class="auth-switch">
        <button
          type="button"
          id="back-to-login"
          class="btn btn-ghost btn-sm"
        >
          Back to login
        </button>
      </div>

    </div>
  `;


  const form =
    document.getElementById(
      'verification-form'
    );

  const codeInput =
    document.getElementById(
      'verification-code'
    );

  const errorEl =
    document.getElementById(
      'verification-error'
    );

  const resendButton =
    document.getElementById(
      'resend-verification'
    );

  const backButton =
    document.getElementById(
      'back-to-login'
    );


  /* ---------------------------------------------------------
   * Verify code
   * --------------------------------------------------------- */

  if (form) {

    form.onsubmit = async (event) => {

      event.preventDefault();


      const code =
        codeInput?.value.trim() || '';


      if (!/^\d{6}$/.test(code)) {

        if (errorEl) {
          errorEl.textContent =
            'Enter the 6-digit verification code';
        }

        codeInput?.focus();

        return;
      }


      const button =
        form.querySelector(
          'button[type="submit"]'
        );


      if (button) {
        button.disabled = true;
      }

      if (errorEl) {
        errorEl.textContent = '';
      }


      try {

        /*
         * Backend verifies the code and returns
         * the normal authentication JWT.
         */
        await verifyEmail(
          verification.userId,
          code
        );


        /*
         * The password exists only in memory.
         */
        const password =
          verification.password;


        if (
          typeof password !== 'string' ||
          password.length === 0
        ) {
          throw new Error(
            'Registration password is no longer available'
          );
        }


        /*
         * Initialize the E2EE identity using the
         * registration password.
         */
        await initializeIdentity(
          password
        );


        /*
         * Destroy the temporary password reference.
         */
        pendingVerification = null;


        if (
          typeof onSuccess === 'function'
        ) {
          await onSuccess();
        }

      } catch (error) {

        console.error(
          'Email verification failed:',
          error
        );


        if (errorEl) {
          errorEl.textContent =
            error?.message ||
            'Email verification failed';
        }


        if (button) {
          button.disabled = false;
        }


        if (codeInput) {
          codeInput.value = '';
          codeInput.focus();
        }
      }
    };
  }


  /* ---------------------------------------------------------
   * Resend code
   * --------------------------------------------------------- */

  if (resendButton) {

    resendButton.onclick = async () => {

      resendButton.disabled = true;


      if (errorEl) {
        errorEl.textContent = '';
      }


      try {

        await resendVerification(
          verification.userId
        );


        if (errorEl) {
          errorEl.textContent =
            'A new verification code has been sent.';
        }

      } catch (error) {

        console.error(
          'Failed to resend verification code:',
          error
        );


        if (errorEl) {
          errorEl.textContent =
            error?.message ||
            'Failed to resend verification code';
        }

      } finally {

        /*
         * This is only UI protection.
         * The real cooldown is enforced by the backend.
         */
        setTimeout(() => {
          resendButton.disabled = false;
        }, 1000);
      }
    };
  }


  /* ---------------------------------------------------------
   * Back to login
   * --------------------------------------------------------- */

  if (backButton) {

    backButton.onclick = () => {

      /*
       * Destroy the temporary password.
       */
      pendingVerification = null;

      renderLogin(onSuccess);
    };
  }


  codeInput?.focus();
}


/* =========================================================
 * Two-Factor Authentication UI
 * ========================================================= */

function renderTwoFactor(
  twoFactor,
  password,
  onSuccess
) {

  const wrap =
    document.getElementById(
      'login-wrap'
    );


  if (!wrap) {

    console.error(
      'Login container not found'
    );

    return;
  }


  wrap.style.display = 'flex';


  wrap.innerHTML = `
    <div class="card login-card">

      <div class="login-mark">
        <img
          src="/img/logo.jpg"
          alt="Wire"
        />
      </div>

      <h1>
        Two-factor authentication
      </h1>

      <p class="hint">
        We sent a 6-digit verification code to
        <strong>${escapeHtml(twoFactor.email || 'your email')}</strong>
      </p>

      <form id="two-factor-form">

        <input
          type="text"
          id="two-factor-code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          pattern="[0-9]{6}"
          placeholder="Verification code"
          required
        >

        <button
          type="submit"
          class="btn btn-primary"
        >
          Verify
        </button>

      </form>

      <div
        id="two-factor-error"
        class="field-error"
      ></div>

      <div class="auth-switch">
        <button
          type="button"
          id="two-factor-back"
          class="btn btn-ghost btn-sm"
        >
          Back to login
        </button>
      </div>

    </div>
  `;


  const form =
    document.getElementById(
      'two-factor-form'
    );

  const codeInput =
    document.getElementById(
      'two-factor-code'
    );

  const errorEl =
    document.getElementById(
      'two-factor-error'
    );

  const backButton =
    document.getElementById(
      'two-factor-back'
    );


  /* ---------------------------------------------------------
   * Verify 2FA code
   * --------------------------------------------------------- */

  if (form) {

    form.onsubmit = async (event) => {

      event.preventDefault();


      const code =
        codeInput?.value.trim() || '';


      if (!/^\d{6}$/.test(code)) {

        if (errorEl) {
          errorEl.textContent =
            'Enter the 6-digit verification code';
        }

        codeInput?.focus();

        return;
      }


      const button =
        form.querySelector(
          'button[type="submit"]'
        );


      if (button) {
        button.disabled = true;
      }

      if (errorEl) {
        errorEl.textContent = '';
      }


      try {

        await verifyTwoFactor(
          twoFactor.id,
          twoFactor.challengeId,
          code
        );


        /*
         * Only after successful 2FA verification
         * does a JWT exist.
         *
         * The password is still only in memory and
         * is immediately used for E2EE identity
         * restoration/creation.
         */
        await initializeIdentity(
          password,
          async () => {

            if (
              typeof onSuccess === 'function'
            ) {
              await onSuccess();
            }

          }
        );


        /*
         * Destroy the temporary password reference.
         */
        pendingVerification = null;


      } catch (error) {

        console.error(
          'Two-factor authentication failed:',
          error
        );


        if (errorEl) {
          errorEl.textContent =
            error?.message ||
            'Two-factor authentication failed';
        }


        if (button) {
          button.disabled = false;
        }


        if (codeInput) {
          codeInput.value = '';
          codeInput.focus();
        }
      }
    };
  }


  /* ---------------------------------------------------------
   * Back to login
   * --------------------------------------------------------- */

  if (backButton) {

    backButton.onclick = () => {

      /*
       * Do not retain the password if the user
       * abandons the authentication flow.
       */
      pendingVerification = null;

      renderLogin(onSuccess);
    };
  }


  codeInput?.focus();
}


/* =========================================================
 * Auth UI
 * ========================================================= */

function renderAuthCard(
  mode,
  onSuccess
) {

  const wrap =
    document.getElementById(
      'login-wrap'
    );


  if (!wrap) {

    console.error(
      'Login container not found'
    );

    return;
  }


  wrap.style.display = 'flex';


  const isRegister =
    mode === 'register';


  wrap.innerHTML = `
    <div class="card login-card">

      <div class="login-mark">
        <img
          src="/img/logo.jpg"
          alt="Wire"
        />
      </div>

      <h1>
        ${
          isRegister
            ? 'Create your Wire account'
            : 'Sign in to Wire'
        }
      </h1>

      <p class="hint">
        Your private drive over WireGuard
      </p>

      <form id="auth-form">

        <input
          type="text"
          id="auth-username"
          placeholder="Username"
          autocomplete="username"
          required
        >

        ${
          isRegister
            ? `
              <input
                type="email"
                id="auth-email"
                placeholder="Email"
                autocomplete="email"
                required
              >
            `
            : ''
        }

        <input
          type="password"
          id="auth-password"
          placeholder="Password"
          autocomplete="${
            isRegister
              ? 'new-password'
              : 'current-password'
          }"
          required
        >

        ${
          isRegister
            ? `
              <input
                type="password"
                id="auth-password-confirm"
                placeholder="Confirm password"
                autocomplete="new-password"
                required
              >
            `
            : ''
        }

        <button
          type="submit"
          class="btn btn-primary"
        >
          ${
            isRegister
              ? 'Create account'
              : 'Sign in'
          }
        </button>

      </form>

      <div
        id="auth-error"
        class="field-error"
      ></div>

      <div class="auth-switch">

        ${
          isRegister
            ? `
              Already have an account?

              <button
                type="button"
                id="switch-auth"
                class="btn btn-ghost btn-sm"
                style="margin-left:4px;"
              >
                Sign in
              </button>
            `
            : `
              Don't have an account?

              <button
                type="button"
                id="switch-auth"
                class="btn btn-ghost btn-sm"
                style="margin-left:4px;"
              >
                Create account
              </button>
            `
        }

      </div>

    </div>
  `;


  const form =
    document.getElementById(
      'auth-form'
    );

  const switchButton =
    document.getElementById(
      'switch-auth'
    );


  /* ---------------------------------------------------------
   * Login / register switch
   * --------------------------------------------------------- */

  if (switchButton) {

    switchButton.onclick = () => {

      if (isRegister) {
        renderLogin(onSuccess);
      } else {
        renderRegister(onSuccess);
      }

    };
  }


  if (!form) {
    return;
  }


  /* ---------------------------------------------------------
   * Submit
   * --------------------------------------------------------- */

  form.onsubmit = async (event) => {

    event.preventDefault();


    const usernameInput =
      document.getElementById(
        'auth-username'
      );

    const emailInput =
      document.getElementById(
        'auth-email'
      );

    const passwordInput =
      document.getElementById(
        'auth-password'
      );

    const confirmInput =
      document.getElementById(
        'auth-password-confirm'
      );

    const button =
      form.querySelector(
        'button[type="submit"]'
      );

    const errorEl =
      document.getElementById(
        'auth-error'
      );


    const username =
      usernameInput?.value || '';

    const email =
      emailInput?.value || '';

    const password =
      passwordInput?.value || '';

    const confirmPassword =
      confirmInput?.value || '';


    if (button) {
      button.disabled = true;
    }

    if (errorEl) {
      errorEl.textContent = '';
    }


    try {

      /* -----------------------------------------------------
       * Registration
       * ----------------------------------------------------- */

      if (isRegister) {

        if (
          password !== confirmPassword
        ) {
          throw new Error(
            'Passwords do not match'
          );
        }


        /*
         * When email is enabled, this creates the account and
         * sends the verification code (no JWT is returned yet).
         *
         * When email is disabled, the server has no verification
         * mechanism, so the account comes back already usable
         * with a normal JWT.
         */
        const registerData =
          await register(
            username,
            email,
            password
          );


        if (
          registerData.requiresEmailVerification === true
        ) {

          /*
           * Move directly to verification.
           */
          renderVerification(
            pendingVerification,
            onSuccess
          );

          return;
        }


        /*
         * Email is disabled: proceed straight to identity
         * initialization, exactly like a normal login.
         */
        await initializeIdentity(
          password,
          async () => {

            if (
              typeof onSuccess === 'function'
            ) {
              await onSuccess();
            }

          }
        );

        if (passwordInput) {
          passwordInput.value = '';
        }

        if (confirmInput) {
          confirmInput.value = '';
        }

        return;
      }


      /* -----------------------------------------------------
       * Login
       * ----------------------------------------------------- */

      const data =
        await login(
          username,
          password
        );


      /*
       * Existing account with an email that has not
       * been verified yet.
       */
      if (
        data.email &&
        !data.email_verified
      ) {

        pendingVerification = {
          userId: data.id,
          username: data.username,
          email: data.email,
          password
        };


        /*
         * Do not keep the normal JWT while waiting
         * for email verification.
         */
        setToken(null);
        currentUser = null;


        renderVerification(
          pendingVerification,
          onSuccess
        );


        return;
      }


      /* -----------------------------------------------------
       * Email 2FA
       * ----------------------------------------------------- */

      if (
        data.requiresTwoFactor === true
      ) {

        /*
         * The password is retained only in memory
         * until the OTP is successfully verified.
         */
        pendingVerification = {
          userId: data.id,
          username: data.username,
          email: data.email,
          password
        };


        /*
         * There should be no authentication token
         * before successful 2FA verification.
         */
        setToken(null);
        currentUser = null;


        renderTwoFactor(
          data,
          password,
          onSuccess
        );


        return;
      }


      /* -----------------------------------------------------
       * Identity initialization
       * ----------------------------------------------------- */

      await initializeIdentity(
        password,
        async () => {

          if (
            typeof onSuccess === 'function'
          ) {
            await onSuccess();
          }

        }
      );


      /*
       * Remove credentials from the DOM after
       * successful initialization.
       */
      if (passwordInput) {
        passwordInput.value = '';
      }

      if (confirmInput) {
        confirmInput.value = '';
      }

    } catch (error) {

      console.error(
        isRegister
          ? 'Registration failed:'
          : 'Login / identity initialization failed:',
        error
      );


      if (errorEl) {

        errorEl.textContent =
          error?.message ||
          (
            isRegister
              ? 'Registration failed'
              : 'Login failed'
          );
      }


      if (button) {
        button.disabled = false;
      }


      /*
       * Never leave passwords in the DOM after
       * a failed operation.
       */
      if (passwordInput) {
        passwordInput.value = '';
      }

      if (confirmInput) {
        confirmInput.value = '';
      }


      passwordInput?.focus();
    }
  };
}


/* =========================================================
 * HTML escaping
 * ========================================================= */

function escapeHtml(value) {

  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}


/* =========================================================
 * Login UI
 * ========================================================= */

export function renderLogin(
  onSuccess = null
) {

  renderAuthCard(
    'login',
    onSuccess
  );
}


/* =========================================================
 * Unlock UI
 *
 * Used when a valid account session already exists (a
 * verified token + /api/me succeeded) but the E2EE identity
 * key is not currently unlocked in memory - e.g. right after
 * a full app restart, since the password is intentionally
 * never persisted anywhere.
 *
 * This is NOT a login form: it never touches
 * /api/auth/login, never requests a username, and never
 * issues or replaces the auth token. It only collects the
 * password needed to unlock (or, on first run for this
 * account, create) the local encrypted identity, via the
 * exact same initializeIdentity() path renderAuthCard()
 * already uses after a real login.
 * ========================================================= */

export function renderUnlock(
  user,
  onSuccess = null
) {

  const wrap =
    document.getElementById(
      'login-wrap'
    );


  if (!wrap) {

    console.error(
      'Login container not found'
    );

    return;
  }


  wrap.style.display = 'flex';


  wrap.innerHTML = `
    <div class="card login-card">

      <div class="login-mark">
        <img
          src="/img/logo.jpg"
          alt="Wire"
        />
      </div>

      <h1>
        Welcome back, ${escapeHtml(user?.username || '')}
      </h1>

      <p class="hint">
        Enter your password to unlock your encrypted messages
        on this device.
      </p>

      <form id="unlock-form">

        <input
          type="password"
          id="unlock-password"
          placeholder="Password"
          autocomplete="current-password"
          required
        >

        <button
          type="submit"
          class="btn btn-primary"
        >
          Unlock
        </button>

      </form>

      <div
        id="unlock-error"
        class="field-error"
      ></div>

      <div class="auth-switch">
        <button
          type="button"
          id="unlock-sign-out"
          class="btn btn-ghost btn-sm"
        >
          Not you? Sign out
        </button>
      </div>

    </div>
  `;


  const form =
    document.getElementById(
      'unlock-form'
    );

  const passwordInput =
    document.getElementById(
      'unlock-password'
    );

  const errorEl =
    document.getElementById(
      'unlock-error'
    );

  const signOutButton =
    document.getElementById(
      'unlock-sign-out'
    );


  if (form) {

    form.onsubmit = async (event) => {

      event.preventDefault();


      const password =
        passwordInput?.value || '';


      if (!password) {

        if (errorEl) {
          errorEl.textContent =
            'Enter your password';
        }

        return;
      }


      const button =
        form.querySelector(
          'button[type="submit"]'
        );


      if (button) {
        button.disabled = true;
      }

      if (errorEl) {
        errorEl.textContent = '';
      }


      try {

        /*
         * The account is already authenticated - a valid
         * token exists and the server has already confirmed
         * the current user via /api/me. This call only
         * unlocks (or creates) the local E2EE identity; it
         * does not call /api/auth/login and does not touch
         * the account session at all.
         */
        await initializeIdentity(
          password,
          onSuccess
        );

      } catch (error) {

        console.error(
          'Identity unlock failed:',
          error
        );


        if (errorEl) {
          errorEl.textContent =
            error?.message ||
            'Incorrect password';
        }


        if (button) {
          button.disabled = false;
        }


        if (passwordInput) {
          passwordInput.value = '';
          passwordInput.focus();
        }
      }
    };
  }


  if (signOutButton) {

    signOutButton.onclick = () => {

      /*
       * The person at the keyboard isn't the signed-in
       * user (or doesn't remember the password) - a real
       * logout is the correct, explicit way out of this
       * screen. This clears the token, so the next launch
       * goes through the normal login flow again.
       */
      logout();

      renderLogin(onSuccess);
    };
  }


  passwordInput?.focus();
}


/* =========================================================
 * Register UI
 * ========================================================= */

export function renderRegister(
  onSuccess = null
) {

  renderAuthCard(
    'register',
    onSuccess
  );
}