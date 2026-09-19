import { initRouter, navigate } from './router.js';

import { initSocket } from './socket.js';

import {
  getToken,
  getCurrentUser,
  setCurrentUser,
  renderLogin,
  logout,
  renderUnlock,
  attemptAutoUnlock
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
  initTheme,
  initBackgroundTheme,
  initAnimations
} from '../settings/theme.js';

import { initSidebarResize } from '../ui/sidebar-resize.js';

import {
  initMobileShell,
  navBadgeHtml,
  renderMobileNav
} from '../ui/mobile-shell.js';

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
    badge: 'dm'
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
    icon: ICONS.users,
    group: 'People & access'
  },

  {
    view: 'admin-folders',
    label: 'Shared Folders',
    icon: ICONS.folders,
    group: 'Server'
  },

  {
    view: 'admin-permissions',
    label: 'Permissions',
    icon: ICONS.key,
    group: 'People & access'
  },

  {
    view: 'admin-wireguard',
    label: 'WireGuard',
    icon: ICONS.shield,
    group: 'Server'
  }
];


function buildNav(user) {

  const container =
    document.getElementById(
      'nav-links'
    );


  if (!container) return;


  container.innerHTML = '';


  // The one admin permission check for navigation: feeds the desktop
  // sidebar below AND the phone "more" menu (ui/mobile-shell.js).
  const adminItems =
    user.is_admin
      ? ADMIN_NAV_ITEMS
      : [];


  const items =
    [
      ...NAV_ITEMS,
      ...adminItems
    ];


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
      ${navBadgeHtml(item)}
    `;


    el.addEventListener(
      'click',
      () => {

        navigate(item.view);
      }
    );


    container.appendChild(el);
  });


  /*
   * Phones: bottom tab bar + admin "more" menu, built from the
   * same lists and driven by the same navigate().
   */
  renderMobileNav({
    tabs: NAV_ITEMS,
    adminItems,
    navigate
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
 * Bootstrap
 * ========================================================= */

async function bootstrap() {

  /*
   * Apply local theme immediately.
   */

  initTheme();

  initAccent();

  initBackgroundTheme();

  initAnimations();


  /*
   * Restore sidebar width and initialize
   * the resize handle.
   */

  initSidebarResize();


  /*
   * Phone layout: keyboard awareness + the admin menu's
   * global listeners (bottom bar itself is built in buildNav).
   */

  initMobileShell();


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
       * We already have a valid token AND /api/me has
       * already confirmed the account - the session itself
       * is fine. We only need to unlock the local E2EE
       * identity.
       *
       * First try silently, using unlock material cached on
       * this device from a previous login where the user opted
       * in via "Remember me on this device" (see auth.js - works
       * in both the Electron app and the plain browser). If that
       * succeeds, the app opens directly with no prompt at all.
       */

      const autoUnlocked =
        await attemptAutoUnlock(
          me,
          token
        );


      if (autoUnlocked) {

        initAccent(
          me.accent_color || null
        );


        await startApplication(
          me,
          token
        );

        return;
      }


      /*
       * No cached unlock material (browser, first login on
       * this device, explicit sign-out since, or the cached
       * material failed an integrity/decryption check). Fall
       * back to a password-only "unlock" step - not a login:
       * it never calls /api/auth/login and never touches the
       * token. Using the full login form here (as before this
       * fix) made a perfectly valid session look logged-out
       * on every restart.
       */

      renderUnlock(
        me,
        async () => {

          /*
           * Unlock has completed. The user/token were
           * already valid before this step ran.
           */
          initAccent(
            me.accent_color || null
          );


          await startApplication(
            me,
            token
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