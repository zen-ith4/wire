import { api } from './api.js';

import {
  createIdentity,
  restoreIdentity,
  lockIdentity
} from '../crypto/identity-service.js';

import {
  clearSessionKeys
} from '../crypto/keys/session.js';


let currentUser = null;
let token = localStorage.getItem('token');


export function getToken() {
  return token;
}


export function setToken(newToken) {
  token = newToken;
  localStorage.setItem('token', newToken);
}


export function getCurrentUser() {
  return currentUser;
}


export function setCurrentUser(user) {
  currentUser = user;
}


/* =========================================================
 * Identity step
 * ========================================================= */

export async function renderIdentityStep(onSuccess = null) {

  if (!token) {
    throw new Error(
      'Authentication token not found'
    );
  }


  const identity = await api(
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


  const isNewIdentity =
    !identity.exists;


  const wrap =
    document.getElementById(
      'login-wrap'
    );


  if (!wrap) {
    throw new Error(
      'Login container not found'
    );
  }


  wrap.style.display = 'flex';


  wrap.innerHTML = `
    <div class="card login-card">

      <div class="login-mark">
        <img src="/img/logo.jpg" alt="Wire" />
      </div>

      <h1>
        ${
          isNewIdentity
            ? 'Create your Identity'
            : 'Unlock your Identity'
        }
      </h1>

      <p class="hint">
        ${
          isNewIdentity
            ? 'Create an Identity Passphrase to protect your encrypted identity key.'
            : 'Enter your Identity Passphrase to unlock your encrypted identity key.'
        }
      </p>

      <form id="identity-form">

        <input
          type="password"
          id="identity-passphrase"
          placeholder="Identity Passphrase"
          autocomplete="off"
          spellcheck="false"
          required
        >

        ${
          isNewIdentity
            ? `
              <input
                type="password"
                id="identity-passphrase-confirm"
                placeholder="Confirm Identity Passphrase"
                autocomplete="off"
                spellcheck="false"
                required
              >
            `
            : ''
        }

        <button
          type="submit"
          class="btn btn-primary"
        >
          ${isNewIdentity ? 'Create' : 'Enter'}
        </button>

      </form>

      <div
        id="identity-error"
        class="field-error"
      ></div>

    </div>
  `;


  const form =
    document.getElementById(
      'identity-form'
    );


  const passphraseInput =
    document.getElementById(
      'identity-passphrase'
    );


  const confirmInput =
    document.getElementById(
      'identity-passphrase-confirm'
    );


  if (
    !form ||
    !passphraseInput
  ) {
    throw new Error(
      'Identity form could not be initialized'
    );
  }


  const button =
    form.querySelector('button');


  const errorEl =
    document.getElementById(
      'identity-error'
    );


  passphraseInput.focus();


  form.onsubmit = async (e) => {

    e.preventDefault();


    if (button) {
      button.disabled = true;
    }


    if (errorEl) {
      errorEl.textContent = '';
    }


    const passphrase =
      passphraseInput.value;


    if (!passphrase) {

      if (errorEl) {
        errorEl.textContent =
          'Identity Passphrase is required.';
      }

      if (button) {
        button.disabled = false;
      }

      passphraseInput.focus();

      return;
    }


    if (
      isNewIdentity &&
      confirmInput &&
      passphrase !== confirmInput.value
    ) {

      if (errorEl) {
        errorEl.textContent =
          'Passphrases do not match.';
      }

      if (button) {
        button.disabled = false;
      }

      confirmInput.focus();

      return;
    }


    try {

      /*
       * Create or restore Identity.
       */

      if (isNewIdentity) {

        console.log(
          '[Identity] Creating identity...'
        );

        await createIdentity(
          passphrase,
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
          passphrase,
          token
        );

        console.log(
          '[Identity] Identity restored successfully'
        );
      }


      /*
       * Clear passphrases from the DOM.
       */

      passphraseInput.value = '';

      if (confirmInput) {
        confirmInput.value = '';
      }


      /*
       * Start the application.
       */

      if (typeof onSuccess === 'function') {

        console.log(
          '[Identity] Starting application...'
        );

        await onSuccess();
      }

    } catch (error) {

      console.error(
        'Identity initialization failed:',
        error
      );


      if (isNewIdentity) {

        if (errorEl) {
          errorEl.textContent =
            error?.message ||
            'Failed to create identity.';
        }

      } else {

        if (errorEl) {
          errorEl.textContent =
            'Incorrect Identity Passphrase.';
        }
      }


      if (button) {
        button.disabled = false;
      }


      passphraseInput.value = '';
      passphraseInput.focus();

    }
  };
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
    !data.token ||
    data.id == null ||
    !data.username
  ) {
    throw new Error(
      'Invalid login response'
    );
  }


  setToken(data.token);


  setCurrentUser({
    id: data.id,
    username: data.username,
    is_admin: data.is_admin,
  });


  return data;
}


/* =========================================================
 * Logout
 * ========================================================= */

export function logout() {

  try {

    lockIdentity();

  } catch (error) {

    console.error(
      'Failed to lock identity:',
      error
    );
  }


  try {

    clearSessionKeys();

  } catch (error) {

    console.error(
      'Failed to clear session keys:',
      error
    );
  }


  localStorage.removeItem(
    'token'
  );


  token = null;
  currentUser = null;


  window.location.reload();
}


/* =========================================================
 * Login UI
 * ========================================================= */

export function renderLogin(
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
        <img src="/img/logo.jpg" alt="Wire" />
      </div>

      <h1>Sign in to Wire</h1>

      <p class="hint">
        Your private drive over WireGuard
      </p>

      <form id="login-form">

        <input
          type="text"
          id="login-username"
          placeholder="Username"
          autocomplete="username"
          required
        >

        <input
          type="password"
          id="login-password"
          placeholder="Password"
          autocomplete="current-password"
          required
        >

        <button
          type="submit"
          class="btn btn-primary"
        >
          Sign in
        </button>

      </form>

      <div
        id="login-error"
        class="field-error"
      ></div>

    </div>
  `;


  const form =
    document.getElementById(
      'login-form'
    );


  if (!form) {
    return;
  }


  form.onsubmit = async (e) => {

    e.preventDefault();


    const username =
      document.getElementById(
        'login-username'
      ).value;


    const passwordInput =
      document.getElementById(
        'login-password'
      );


    const password =
      passwordInput.value;


    const btn =
      form.querySelector('button');


    const errorEl =
      document.getElementById(
        'login-error'
      );


    if (btn) {
      btn.disabled = true;
    }


    if (errorEl) {
      errorEl.textContent = '';
    }


    try {

      await login(
        username,
        password
      );


      passwordInput.value = '';


      /*
       * After account login, the user must
       * create or unlock the E2EE identity.
       *
       * This callback is important because this
       * path does not go through bootstrap again.
       */

      await renderIdentityStep(
        async () => {

          if (typeof onSuccess === 'function') {
            await onSuccess();
          }

        }
      );

    } catch (error) {

      console.error(
        'Login failed:',
        error
      );


      const currentLoginError =
        document.getElementById(
          'login-error'
        );


      if (currentLoginError) {

        currentLoginError.textContent =
          error?.message ||
          'Login failed';

      }


      if (btn) {
        btn.disabled = false;
      }

    }
  };
}