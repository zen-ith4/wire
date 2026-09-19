import { api } from './api.js';

import {
  getServerEndpoint,
  setServerEndpoint,
  isNativeApp
} from './server.js';

import {
  createIdentity,
  restoreIdentity,
  restoreIdentityWithUnlockKey
} from '../crypto/identity-service.js';

import {
  idbStoreUnlockKey,
  idbGetUnlockKey,
  idbClearUnlockKey
} from '../crypto/keys/unlock-key-store.js';

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
   * cached unlock key (OS-secured via safeStorage in Electron,
   * IndexedDB in the browser) so the next launch goes through the
   * normal password flow, exactly like a fresh device.
   *
   * Fire-and-forget: logout() has always been synchronous and
   * existing callers (api.js on a real 401, the Settings sign-out
   * button before window.location.reload()) call it without
   * awaiting.
   */
  clearPersistedUnlockKey(signedOutUser).catch(err => {
    console.error(
      '[Identity] Failed to clear unlock key on logout:',
      err
    );
  });
}

/* =========================================================
 * Server switching
 * ========================================================= */

async function changeNativeServer(rawAddress, errorElement = null) {
  if (!isNativeApp()) {
    return;
  }

  try {
    /*
     * Validate and normalize before changing anything.
     */
    const newEndpoint =
      setServerEndpoint(rawAddress);

    /*
     * The unlock key belongs to the old server origin.
     * Remove it before switching origins.
     */
    if (currentUser) {
      await clearPersistedUnlockKey(currentUser);
    }

    /*
     * Never send the old server's JWT to the new server.
     */
    setToken(null);
    currentUser = null;
    pendingVerification = null;

    /*
     * The endpoint is already stored by setServerEndpoint().
     * Reload so every module starts from the new server.
     */
    window.location.reload();

    return newEndpoint;

  } catch (error) {

    console.error(
      '[Server] Failed to change server:',
      error
    );

    if (errorElement) {
      errorElement.textContent =
        error?.message ||
        'Failed to change server';
    }

    throw error;
  }
}

/* =========================================================
 * Auto-unlock ("Remember me on this device")
 *
 * The E2EE identity's derived unlock key (see identity.js /
 * identity-service.js) can be cached locally so a valid,
 * already-authenticated session can restore the identity on
 * the next launch without a password prompt.
 *
 * This is never the password itself and never the raw private key.
 *
 * Two backends, chosen automatically:
 * - Electron: OS-level secure storage
 * - Browser: IndexedDB, scoped by the server origin.
 * - Capacitor Android: IndexedDB, scoped by the selected server
 *   endpoint rather than capacitor://localhost.
 *
 * Both are opt-in: nothing is cached unless the user checks
 * "Remember me on this device" at login/unlock time.
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

/*
 * Returns the identity storage scope.
 *
 * Browser:
 * window.location.origin
 *
 * Electron:
 * The remote server's origin, which is also
 * window.location.origin.
 *
 * Capacitor:
 * The actual selected backend server.
 */
function getIdentityStorageOrigin() {
  return getServerEndpoint();
}

async function persistUnlockKey(
  unlockKey,
  user
) {
  if (
    !unlockKey ||
    !user
  ) {
    return;
  }

  try {

    const storageOrigin =
      getIdentityStorageOrigin();

    if (isElectron()) {

      await window.electronAPI.storeIdentityUnlockKey(
        storageOrigin,
        user.id,
        unlockKey
      );

    } else {

      await idbStoreUnlockKey(
        storageOrigin,
        user.id,
        unlockKey
      );
    }

  } catch (err) {

    console.error(
      '[Identity] Failed to persist unlock key:',
      err
    );

  }
}

export async function clearPersistedUnlockKey(user) {
  if (!user) {
    return;
  }

  try {

    const storageOrigin =
      getIdentityStorageOrigin();

    if (isElectron()) {

      await window.electronAPI.clearIdentityUnlockKey(
        storageOrigin,
        user.id
      );

    } else {

      await idbClearUnlockKey(
        storageOrigin,
        user.id
      );
    }

  } catch (err) {

    console.error(
      '[Identity] Failed to clear unlock key:',
      err
    );

  }
}

/*
 * Attempts to unlock the E2EE identity using material cached from
 * a previous successful login on this device.
 */
export async function attemptAutoUnlock(
  user,
  currentToken
) {
  if (
    !user ||
    !currentToken
  ) {
    return false;
  }

  let cached;

  try {

    const storageOrigin =
      getIdentityStorageOrigin();

    cached =
      isElectron()
        ? await window.electronAPI.getIdentityUnlockKey(
            storageOrigin,
            user.id
          )
        : await idbGetUnlockKey(
            storageOrigin,
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
  onSuccess = null,
  { rememberMe = undefined } = {}
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

  if (rememberMe === true) {

    await persistUnlockKey(
      result?.unlockKey,
      currentUser
    );

  } else if (rememberMe === false) {

    await clearPersistedUnlockKey(
      currentUser
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

  if (
    data.requiresEmailVerification === true ||
    (
      data.email &&
      data.email_verified === false
    )
  ) {
    return data;
  }

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

        await verifyEmail(
          verification.userId,
          code
        );

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

        await initializeIdentity(
          password
        );

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

        setTimeout(() => {
          resendButton.disabled = false;
        }, 1000);
      }
    };
  }

  if (backButton) {

    backButton.onclick = () => {

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

  if (backButton) {

    backButton.onclick = () => {

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

  const nativeApp =
    isNativeApp();

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

    ${
      !isRegister
        ? `
          <label class="auth-remember-me">
            <input
              type="checkbox"
              id="auth-remember-me"
            >
            Remember me on this device
          </label>
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

  ${
    nativeApp
      ? `
        <div
          class="auth-server-row"
          id="auth-server-row"
          style="
            margin-top:16px;
            display:flex;
            flex-direction:column;
            gap:8px;
          "
        >

          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:10px;
            "
          >
            <span>Server</span>

            <button
              type="button"
              id="auth-server-change"
              class="auth-server-change-btn"
            >
              Change
            </button>
          </div>

          <span
            class="auth-server-value"
            id="auth-server-value"
            style="
              overflow:hidden;
              text-overflow:ellipsis;
              white-space:nowrap;
              opacity:.75;
              font-size:.9em;
            "
          >${escapeHtml(getServerEndpoint())}</span>

          <div
            id="auth-server-editor"
            style="display:none;"
          >
            <input
              type="text"
              id="auth-server-input"
              placeholder="https://example.com"
              autocomplete="url"
              autocapitalize="none"
              spellcheck="false"
              value="${escapeHtml(getServerEndpoint())}"
            >

            <div
              style="
                display:flex;
                gap:8px;
                margin-top:8px;
              "
            >
              <button
                type="button"
                id="auth-server-connect"
                class="btn btn-primary"
                style="flex:1;"
              >
                Connect
              </button>

              <button
                type="button"
                id="auth-server-cancel"
                class="btn btn-ghost"
                style="flex:1;"
              >
                Cancel
              </button>
            </div>

            <div
              id="auth-server-error"
              class="field-error"
              style="margin-top:8px;"
            ></div>
          </div>

        </div>
      `
      : ''
  }

  ${
    !isRegister && isElectron()
      ? `
        <div class="auth-server-row" id="auth-server-row">
          <span>Server:</span>

          <span class="auth-server-value">
            ${escapeHtml(window.location.host)}
          </span>

          <button
            type="button"
            id="auth-server-change"
            class="auth-server-change-btn"
          >
            Change
          </button>
        </div>
      `
      : ''
  }

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

  if (switchButton) {

    switchButton.onclick = () => {

      if (isRegister) {
        renderLogin(onSuccess);
      } else {
        renderRegister(onSuccess);
      }
    };
  }

  /* ---------------------------------------------------------
   * Native Android server selector
   * --------------------------------------------------------- */

  if (nativeApp) {

    const changeButton =
      document.getElementById(
        'auth-server-change'
      );

    const editor =
      document.getElementById(
        'auth-server-editor'
      );

    const input =
      document.getElementById(
        'auth-server-input'
      );

    const connectButton =
      document.getElementById(
        'auth-server-connect'
      );

    const cancelButton =
      document.getElementById(
        'auth-server-cancel'
      );

    const errorEl =
      document.getElementById(
        'auth-server-error'
      );

    if (changeButton) {

      changeButton.onclick = () => {

        if (editor) {
          editor.style.display = 'block';
        }

        if (changeButton) {
          changeButton.style.display = 'none';
        }

        input?.focus();
        input?.select();
      };
    }

    if (cancelButton) {

      cancelButton.onclick = () => {

        if (editor) {
          editor.style.display = 'none';
        }

        if (changeButton) {
          changeButton.style.display = '';
        }

        if (input) {
          input.value =
            getServerEndpoint();
        }

        if (errorEl) {
          errorEl.textContent = '';
        }
      };
    }

    if (connectButton) {

      connectButton.onclick = async () => {

        if (errorEl) {
          errorEl.textContent = '';
        }

        if (input) {
          input.disabled = true;
        }

        connectButton.disabled = true;

        try {

          await changeNativeServer(
            input?.value || '',
            errorEl
          );

        } catch {

          if (input) {
            input.disabled = false;
          }

          connectButton.disabled = false;
        }
      };
    }
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

        const registerData =
          await register(
            username,
            email,
            password
          );

        if (
          registerData.requiresEmailVerification === true
        ) {

          renderVerification(
            pendingVerification,
            onSuccess
          );

          return;
        }

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

        pendingVerification = {
          userId: data.id,
          username: data.username,
          email: data.email,
          password
        };

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

      const rememberMeInput =
        document.getElementById(
          'auth-remember-me'
        );

      await initializeIdentity(
        password,
        async () => {

          if (
            typeof onSuccess === 'function'
          ) {
            await onSuccess();
          }
        },
        {
          rememberMe: Boolean(
            rememberMeInput?.checked
          )
        }
      );

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

  const nativeApp =
    isNativeApp();

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

    <label class="auth-remember-me">
      <input
        type="checkbox"
        id="unlock-remember-me"
      >
      Remember me on this device
    </label>

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

  ${
    nativeApp
      ? `
        <div
          class="auth-server-row"
          id="unlock-server-row"
          style="
            margin-top:16px;
            display:flex;
            flex-direction:column;
            gap:8px;
          "
        >

          <div
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:10px;
            "
          >
            <span>Server</span>

            <button
              type="button"
              id="unlock-server-change"
              class="auth-server-change-btn"
            >
              Change
            </button>
          </div>

          <span
            id="unlock-server-value"
            style="
              overflow:hidden;
              text-overflow:ellipsis;
              white-space:nowrap;
              opacity:.75;
              font-size:.9em;
            "
          >${escapeHtml(getServerEndpoint())}</span>

          <div
            id="unlock-server-editor"
            style="display:none;"
          >

            <input
              type="text"
              id="unlock-server-input"
              placeholder="https://example.com"
              autocomplete="url"
              autocapitalize="none"
              spellcheck="false"
              value="${escapeHtml(getServerEndpoint())}"
            >

            <div
              style="
                display:flex;
                gap:8px;
                margin-top:8px;
              "
            >

              <button
                type="button"
                id="unlock-server-connect"
                class="btn btn-primary"
                style="flex:1;"
              >
                Connect
              </button>

              <button
                type="button"
                id="unlock-server-cancel"
                class="btn btn-ghost"
                style="flex:1;"
              >
                Cancel
              </button>

            </div>

            <div
              id="unlock-server-error"
              class="field-error"
              style="margin-top:8px;"
            ></div>

          </div>

        </div>
      `
      : ''
  }

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

  /* ---------------------------------------------------------
   * Native Android server selector
   * --------------------------------------------------------- */

  if (nativeApp) {

    const changeButton =
      document.getElementById(
        'unlock-server-change'
      );

    const editor =
      document.getElementById(
        'unlock-server-editor'
      );

    const input =
      document.getElementById(
        'unlock-server-input'
      );

    const connectButton =
      document.getElementById(
        'unlock-server-connect'
      );

    const cancelButton =
      document.getElementById(
        'unlock-server-cancel'
      );

    const serverError =
      document.getElementById(
        'unlock-server-error'
      );

    if (changeButton) {

      changeButton.onclick = () => {

        if (editor) {
          editor.style.display = 'block';
        }

        changeButton.style.display = 'none';

        input?.focus();
        input?.select();
      };
    }

    if (cancelButton) {

      cancelButton.onclick = () => {

        if (editor) {
          editor.style.display = 'none';
        }

        changeButton.style.display = '';

        if (input) {
          input.value =
            getServerEndpoint();
        }

        if (serverError) {
          serverError.textContent = '';
        }
      };
    }

    if (connectButton) {

      connectButton.onclick = async () => {

        if (serverError) {
          serverError.textContent = '';
        }

        if (input) {
          input.disabled = true;
        }

        connectButton.disabled = true;

        try {

          await changeNativeServer(
            input?.value || '',
            serverError
          );

        } catch {

          if (input) {
            input.disabled = false;
          }

          connectButton.disabled = false;
        }
      };
    }
  }

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

        const rememberMeInput =
          document.getElementById(
            'unlock-remember-me'
          );

        await initializeIdentity(
          password,
          onSuccess,
          {
            rememberMe: Boolean(
              rememberMeInput?.checked
            )
          }
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