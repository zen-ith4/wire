import { initRouter, navigate } from './router.js';

import { initSocket } from './socket.js';

import {
  getToken,
  getCurrentUser,
  setCurrentUser,
  renderLogin,
  logout,
  initializeIdentity
} from './auth.js';

import { showToast } from './utils.js';

import { api } from './api.js';

import { applyAvatar } from '../ui/avatar.js';

import { ICONS } from '../icons.js';

import { refreshUnreadBadge } from '../chat/dm.js';

import { startAutoEnhance } from '../ui/ui-enhance.js';

import { initDragDrop } from '../files/dragdrop.js';

import {
  initAccent,
  initTheme
} from '../settings/theme.js';

import { initSidebarResize } from '../ui/sidebar-resize.js';

import {
  isIdentityUnlocked
} from '../crypto/identity-service.js';

import '../ui/profile-card.js';
import '../media/image-viewer.js';


const NAV_ITEMS = [
  {
    view: 'files',
    label: 'My Files',
    icon: ICONS.folders
  },

  {
    view: 'chat',
    label: 'Chat',
    icon: ICONS.chat
  },

  {
    view: 'messages',
    label: 'Messages',
    icon: ICONS.mail,
    badgeId: 'dm-nav-badge'
  },

  {
    view: 'settings',
    label: 'Settings',
    icon: ICONS.settings
  }
];


const ADMIN_NAV_ITEMS = [
  {
    view: 'admin-users',
    label: 'Users',
    icon: ICONS.users
  },

  {
    view: 'admin-folders',
    label: 'Shared Folders',
    icon: ICONS.folders
  },

  {
    view: 'admin-permissions',
    label: 'Permissions',
    icon: ICONS.key
  },

  {
    view: 'admin-wireguard',
    label: 'WireGuard',
    icon: ICONS.shield
  }
];


function buildNav(user) {

  const container =
    document.getElementById(
      'nav-links'
    );


  if (!container) return;


  container.innerHTML = '';


  const items =
    user.is_admin
      ? [
          ...NAV_ITEMS,
          ...ADMIN_NAV_ITEMS
        ]
      : NAV_ITEMS;


  items.forEach(item => {

    const el =
      document.createElement('div');


    el.className =
      'nav-link';


    el.dataset.view =
      item.view;


    el.innerHTML = `
      ${item.icon || ''}
      <span>${item.label}</span>
      ${
        item.badgeId
          ? `
            <span
              class="nav-badge hidden"
              id="${item.badgeId}">
              0
            </span>
          `
          : ''
      }
    `;


    el.addEventListener(
      'click',
      () => {

        navigate(item.view);

        window.closeMobileSidebar();
      }
    );


    container.appendChild(el);
  });
}


function fillProfile(user) {

  const nameEl =
    document.getElementById(
      'profile-username'
    );


  const initialsEl =
    document.getElementById(
      'profile-initials'
    );


  const sectionEl =
    document.getElementById(
      'sidebar-profile-section'
    );


  if (nameEl) {

    nameEl.textContent =
      user.username;
  }


  if (initialsEl) {

    const initialsSpan =
      initialsEl.querySelector(
        '.avatar-initials'
      );


    const initialsText =
      (user.username || '?')
        .charAt(0)
        .toUpperCase();


    if (initialsSpan) {

      initialsSpan.textContent =
        initialsText;

    } else {

      initialsEl.textContent =
        initialsText;
    }


    initialsEl.dataset.avatarUser =
      user.id;


    applyAvatar(
      'profile-initials',
      user.id
    );
  }


  if (sectionEl) {

    sectionEl.title =
      `View ${user.username}'s profile`;


    sectionEl.onclick = () => {

      window.openProfileCard?.(
        user.id
      );

    };
  }
}


function showApp(user) {

  const loginWrap =
    document.getElementById(
      'login-wrap'
    );


  const app =
    document.getElementById(
      'app'
    );


  if (loginWrap) {

    loginWrap.style.display =
      'none';
  }


  if (app) {

    app.style.display =
      'flex';
  }


  buildNav(user);

  fillProfile(user);

  refreshUnreadBadge();
}


/* =========================================================
 * Global helpers
 * ========================================================= */

window.logout =
  logout;


window.openMobileSidebar =
  function () {

    document
      .getElementById('sidebar')
      ?.classList.add('open');


    document
      .getElementById('sidebar-backdrop')
      ?.classList.add('active');
  };


window.closeMobileSidebar =
  function () {

    document
      .getElementById('sidebar')
      ?.classList.remove('open');


    document
      .getElementById('sidebar-backdrop')
      ?.classList.remove('active');
  };


/* =========================================================
 * Application startup
 * ========================================================= */

async function startApplication(
  user,
  token
) {

  showApp(user);

  initSocket(token);

  initRouter();

  startAutoEnhance();

  initDragDrop();
}


/* =========================================================
 * Desktop-only silent identity unlock
 *
 * Only runs inside the Electron app (window.wireDesktop), and only
 * when the user previously opted in via "Remember me on this
 * device" at login. The plain website always falls through to the
 * normal password prompt, exactly as before.
 * ========================================================= */

async function tryAutoUnlockIdentity(user, token) {

  if (!window.wireDesktop?.isElectron) {
    return false;
  }

  let stored = null;

  try {
    stored = await window.wireDesktop.getCredentials();
  } catch (err) {
    console.error('Failed to read remembered credentials:', err);
    return false;
  }

  if (
    !stored ||
    stored.username !== user.username
  ) {
    return false;
  }

  try {

    await initializeIdentity(
      stored.password,
      async () => {

        initAccent(
          user.accent_color || null
        );

        await startApplication(
          user,
          token
        );
      }
    );

    return true;

  } catch (err) {

    /*
     * Most likely the account password was changed
     * elsewhere since credentials were remembered. Drop
     * the stale blob and fall back to the normal login
     * form instead of failing silently forever.
     */
    console.error('Silent identity unlock failed:', err);

    try {
      await window.wireDesktop.clearCredentials();
    } catch {
      // ignore
    }

    return false;
  }
}


/* =========================================================
 * Bootstrap
 * ========================================================= */

async function bootstrap() {

  /*
   * Apply local theme immediately.
   */

  initTheme();

  initAccent();


  /*
   * Restore sidebar width and initialize
   * the resize handle.
   */

  initSidebarResize();


  /*
   * Check current authentication state.
   */

  const token =
    getToken();


  /*
   * No account session.
   *
   * Login will authenticate the account and,
   * inside auth.js, initialize the E2EE identity
   * using the SAME account password.
   */

  if (!token) {

    renderLogin(
      async () => {

        const user =
          getCurrentUser();

        const currentToken =
          getToken();


        if (
          !user ||
          !currentToken
        ) {
          throw new Error(
            'Authentication state is unavailable'
          );
        }


        /*
         * The freshly authenticated user is now
         * available in auth.js. Apply the server-side
         * accent immediately so it takes priority over
         * the login-time localStorage accent.
         */
        initAccent(
          user.accent_color || null
        );


        await startApplication(
          user,
          currentToken
        );
      }
    );

    return;
  }


  try {

    /* ------------------------------------------------------
     * Get authenticated user
     * ------------------------------------------------------ */

    const me =
      await api('/api/me');


    /* ------------------------------------------------------
     * Restore current user state
     * ------------------------------------------------------ */

    setCurrentUser(me);


    /* ------------------------------------------------------
     * Database accent takes priority over localStorage.
     * ------------------------------------------------------ */

    initAccent(
      me.accent_color || null
    );


    /* ------------------------------------------------------
     * Identity state
     *
     * The identity is intentionally kept only in memory.
     *
     * If the page was reloaded, the password is no longer
     * available and the encrypted identity cannot be
     * silently unlocked.
     *
     * Therefore the user must authenticate again through
     * the login flow, which will use the same password to
     * restore the E2EE identity.
     * ------------------------------------------------------ */

    if (!isIdentityUnlocked()) {

      /*
       * We already have a valid token, but we cannot
       * decrypt the private identity key without the
       * user's password.
       *
       * Desktop app: if the user opted in to "Remember me
       * on this device", try silently supplying the stored
       * password before ever showing a login form.
       */

      if (await tryAutoUnlockIdentity(me, token)) {
        return;
      }

      /*
       * Render the normal login form again so the
       * password can be supplied to the identity layer.
       */

      renderLogin(
        async () => {

          const user =
            getCurrentUser();

          const currentToken =
            getToken();


          if (
            !user ||
            !currentToken
          ) {
            throw new Error(
              'Authentication state is unavailable'
            );
          }


          /*
           * Login has restored the authenticated user.
           * Re-apply the database accent before showing
           * the application.
           */
          initAccent(
            user.accent_color || null
          );


          await startApplication(
            user,
            currentToken
          );
        }
      );

      return;
    }


    /* ------------------------------------------------------
     * Identity is already unlocked.
     *
     * This can happen when bootstrap is called again
     * during the same page lifetime.
     * ------------------------------------------------------ */

    await startApplication(
      me,
      token
    );

  } catch (err) {

    /*
     * api() handles 401 itself.
     */

    if (
      err.message !== 'Session expired'
    ) {

      console.error(
        err
      );


      showToast(
        'Failed to start application',
        'error'
      );


      renderLogin(
        async () => {

          const user =
            getCurrentUser();

          const currentToken =
            getToken();


          if (
            !user ||
            !currentToken
          ) {
            throw new Error(
              'Authentication state is unavailable'
            );
          }


          /*
           * Login has restored the authenticated user.
           * Apply the server-side accent before the
           * application UI is initialized.
           */
          initAccent(
            user.accent_color || null
          );


          await startApplication(
            user,
            currentToken
          );
        }
      );
    }
  }
}


bootstrap().catch(err => {

  console.error(
    err
  );


  showToast(
    'Failed to start application',
    'error'
  );
});


/* =========================================================
 * Global error handling
 * ========================================================= */

window.addEventListener(
  'unhandledrejection',
  event => {

    console.error(
      'Unhandled promise rejection:',
      event.reason
    );


    showToast(
      'An unexpected error occurred',
      'error'
    );
  }
);


window.addEventListener(
  'error',
  event => {

    console.error(
      'Unhandled error:',
      event.error || event.message
    );


    showToast(
      'An unexpected error occurred',
      'error'
    );
  }
);