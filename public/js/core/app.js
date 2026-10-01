import { initRouter, navigate, resetRouter } from './router.js';

import { initSocket, disconnectSocket } from './socket.js';

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

import { initKeyboardShortcuts } from './shortcuts.js';

import {
  initAccent,
  initTheme,
  initBackgroundTheme,
  initAnimations,
  initAnimationScale,
  initFontFamily,
  initMessageBubbleStyle,
  initOwnBubbleGradient,
  initUIDensity,
  initFontSize
} from '../settings/theme.js';

import { initSurfaces } from '../settings/appearance-surfaces.js';

import { initCustomBackground } from '../settings/custom-background.js';

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

import {
  registerServiceWorker,
  updateServiceWorker
} from './pwa.js';

import { initAndroidUpdateCheck } from './appUpdate.js';

import { showConfirm } from '../ui/confirm.js';

import {
  initNotificationClickRouting,
  markAppReadyForNotificationNavigation
} from '../notifications/notification-manager.js';

import { initPushRegistration } from '../notifications/push-registration.js';


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


// Not in NAV_ITEMS itself (that array is a static constant): this entry
// only appears once the server's GROUPS_ENABLED flag comes back true on
// /api/me (controllers/me.controller.js). Merged in by buildNav() below,
// the same way ADMIN_NAV_ITEMS is conditionally merged by user.is_admin.
// Desktop sidebar only for now: the phone tab bar / "More" menu
// (ui/mobile-shell.js) are left untouched.
const GROUPS_NAV_ITEM = {
  view: 'groups',
  label: 'Groups',
  icon: ICONS.users
};


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


  // The one admin permission check for navigation:
  // feeds the desktop sidebar AND the phone "more" menu.
  const adminItems =
    user.is_admin
      ? ADMIN_NAV_ITEMS
      : [];


  const groupsItems =
    user.groups_enabled
      ? [GROUPS_NAV_ITEM]
      : [];


  const items =
    [
      ...NAV_ITEMS,
      ...groupsItems,
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
   * Phones: bottom tab bar + admin "more" menu,
   * built from the same lists and driven by
   * the same navigate().
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


/*
 * Symmetric inverse of showApp().
 *
 * Used whenever startApplication() has to be aborted after showApp()
 * already ran (a later step — router, socket, etc. — threw) and the
 * UI is falling back to the login/unlock screen.
 *
 * Safe to call even if showApp()/startApplication() never ran, or
 * only partially ran.
 */
function hideApp() {

  const loginWrap =
    document.getElementById(
      'login-wrap'
    );


  const app =
    document.getElementById(
      'app'
    );


  if (app) {

    app.style.display =
      'none';
  }


  if (loginWrap) {

    loginWrap.style.display =
      'flex';
  }


  // Close any socket connection opened by startApplication().
  disconnectSocket();

  // Allow initRouter() to run again from scratch.
  resetRouter();


  const navContainer =
    document.getElementById(
      'nav-links'
    );


  if (navContainer) {

    navContainer.innerHTML =
      '';
  }
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

  /*
   * Accent must already have been initialized from
   * user.accent_color before this function is called.
   *
   * This keeps the server-side account accent as the
   * source of truth across browser, Electron and
   * Capacitor Android.
   */

  showApp(user);


  /*
   * Each step below is independent. A single non-critical
   * step failing must not abort the whole startup.
   *
   * initRouter() is the one genuinely fatal step.
   */

  try {
    initSocket(token);
  } catch (err) {
    console.error(
      '[startApplication] initSocket failed (non-fatal):',
      err
    );
  }


  try {
    initRouter();
  } catch (err) {
    console.error(
      '[startApplication] initRouter failed (fatal):',
      err
    );

    throw err;
  }


  try {
    /*
     * Routing is only safe once the app shell above is mounted.
     *
     * A notification tapped from a cold start is held by
     * notification-manager.js until this exact point.
     */
    markAppReadyForNotificationNavigation();
  } catch (err) {
    console.error(
      '[startApplication] markAppReadyForNotificationNavigation failed (non-fatal):',
      err
    );
  }


  try {
    initPushRegistration();
  } catch (err) {
    console.error(
      '[startApplication] initPushRegistration failed (non-fatal):',
      err
    );
  }


  try {
    startAutoEnhance();
  } catch (err) {
    console.error(
      '[startApplication] startAutoEnhance failed (non-fatal):',
      err
    );
  }


  try {
    initDragDrop();
  } catch (err) {
    console.error(
      '[startApplication] initDragDrop failed (non-fatal):',
      err
    );
  }


  try {
    initKeyboardShortcuts();
  } catch (err) {
    console.error(
      '[startApplication] initKeyboardShortcuts failed (non-fatal):',
      err
    );
  }
}


/*
 * Wraps startApplication() so that any FATAL failure
 * tears #app back down via hideApp() before the error
 * is re-thrown to the caller.
 */
async function startApplicationSafely(
  user,
  token
) {

  try {

    await startApplication(
      user,
      token
    );

  } catch (err) {

    hideApp();

    throw err;
  }
}


/* =========================================================
 * Bootstrap
 * ========================================================= */

async function bootstrap() {

  /*
   * Apply only local/device appearance settings
   * immediately.
   *
   * Accent is intentionally NOT initialized here.
   * It belongs to the authenticated account and must
   * come from /api/me or the freshly authenticated user.
   */

  initTheme();

  initBackgroundTheme();

  initAnimations();
  initAnimationScale();

  initFontFamily();

  initUIDensity();
  initFontSize();

  initMessageBubbleStyle();
  initOwnBubbleGradient();


  /*
   * Advanced appearance overrides and the local
   * custom background.
   */

  initSurfaces();

  initCustomBackground();


  /*
   * Restore sidebar width and initialize
   * the resize handle.
   */

  initSidebarResize();


  /*
   * Phone layout: keyboard awareness + the admin
   * menu's global listeners.
   */

  initMobileShell();


  /*
   * Check current authentication state.
   */

  const token =
    getToken();


  /*
   * No account session.
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
         * Apply the authenticated user's accent
         * before creating the application UI.
         */

        initAccent(
          user.accent_color || null
        );


        await startApplicationSafely(
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


    /*
     * Database accent is the account-level source of truth.
     */

    initAccent(
      me.accent_color || null
    );


    /* ------------------------------------------------------
     * Identity state
     * ------------------------------------------------------ */

    if (!isIdentityUnlocked()) {

      /*
       * Try silently using cached unlock material.
       */

      const autoUnlocked =
        await attemptAutoUnlock(
          me,
          token
        );


      if (autoUnlocked) {

        await startApplicationSafely(
          me,
          token
        );

        return;
      }


      /*
       * No cached unlock material.
       * Fall back to the password-only unlock step.
       */

      renderUnlock(
        me,
        async () => {

          await startApplicationSafely(
            me,
            token
          );
        }
      );

      return;
    }


    /* ------------------------------------------------------
     * Identity is already unlocked.
     * ------------------------------------------------------ */

    await startApplicationSafely(
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


      /*
       * Tear #app down before showing the login screen.
       */

      hideApp();


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
           * Apply the server-side accent before
           * initializing the application UI.
           */

          initAccent(
            user.accent_color || null
          );


          await startApplicationSafely(
            user,
            currentToken
          );
        }
      );
    }
  }
}


/*
 * Browser/PWA only (no-op in the native app):
 * keep the app shell available locally.
 */

registerServiceWorker();


/*
 * Android (Capacitor) only:
 * checks the currently selected server for a newer APK.
 *
 * This is separate from the Service Worker and Electron
 * update mechanisms.
 */

initAndroidUpdateCheck();


/*
 * Registered exactly once per page load, regardless of
 * login state.
 */

initNotificationClickRouting();


/*
 * Electron update notifications.
 */

if (window.electronAPI?.isElectron) {

  let pendingUpdateVersion = null;

  window.electronAPI.onUpdateAvailable(
    ({ currentVersion, serverVersion }) => {

      console.log(
        `New version available: ${serverVersion} (current: ${currentVersion})`
      );


      if (pendingUpdateVersion === serverVersion) {
        return;
      }


      pendingUpdateVersion = serverVersion;


      showConfirm(
        `Current version: ${currentVersion}. Available version: ` +
          `${serverVersion}. Update the cached application now?`,
        {
          title: `New version ${serverVersion} is available`,
          confirmText: 'Update',
          cancelText: 'Not now',
          danger: false
        }
      ).then((updateConfirmed) => {

        pendingUpdateVersion = null;


        if (updateConfirmed) {
          updateServiceWorker();
        }
      });
    }
  );
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
