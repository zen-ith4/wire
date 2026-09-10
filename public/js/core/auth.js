import { api } from './api.js';

import {
  createIdentity,
  restoreIdentity
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
  setToken(null);
  currentUser = null;
  pendingVerification = null;
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


  if (!identity.exists) {

    console.log(
      '[Identity] Creating identity...'
    );

    await createIdentity(
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

    await restoreIdentity(
      password,
      token
    );

    console.log(
      '[Identity] Identity restored successfully'
    );
  }


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
    !data.username ||
    !data.email ||
    data.requiresEmailVerification !== true
  ) {
    throw new Error(
      'Invalid registration response'
    );
  }


  /*
   * Registration does not authenticate the user.
   *
   * Keep the password only in memory so that the
   * E2EE identity can be initialized immediately
   * after successful email verification.
   */
  pendingVerification = {
    userId: data.id,
    username: data.username,
    email: data.email,
    password
  };


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
         * Creates the account and sends the
         * verification code.
         *
         * No JWT is returned.
         */
        await register(
          username,
          email,
          password
        );


        /*
         * Move directly to verification.
         */
        renderVerification(
          pendingVerification,
          onSuccess
        );


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