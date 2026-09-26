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

import {
  initAccent,
  initTheme,
  initBackgroundTheme,
  initAnimations,
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
import { registerServiceWorker, updateServiceWorker } from './pwa.js';
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
 * already ran (a later step — router, socket, etc. — threw) and the UI
 * is falling back to the login/unlock screen. Without this, #app is
 * left visible but half-initialized (no working router/socket/nav),
 * overlapping the re-shown login card until the user manually
 * refreshes the page.
 *
 * Safe to call even if showApp()/startApplication() never ran, or only
 * partially ran: every step it undoes is itself a no-op when there is
 * nothing to undo (no socket open, router never initialized, etc.).
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


  // Close any socket connection opened by startApplication() and let
  // initSocket() create a fresh one next time instead of silently
  // no-op'ing on its singleton guard.
  disconnectSocket();

  // Let initRouter() run again from scratch instead of being ignored
  // by its own "already initialized" guard.
  resetRouter();

  // Nav is rebuilt from scratch by buildNav() on the next showApp(),
  // but clear it now so nothing stale is visible if #app is ever
  // shown again before that happens.
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
   * Each step below is independent. A single non-critical step
   * failing (e.g. push registration on a browser without permission,
   * or a transient socket connect error) must not abort the whole
   * startup and leave the user stuck on a half-initialized #app — so
   * each gets its own try/catch, logs, and continues.
   *
   * initRouter() is the one genuinely fatal step: without a working
   * router nothing in #app can be navigated to, so its failure is
   * re-thrown, which aborts startApplication() and lets the caller
   * (startApplicationSafely()) tear #app back down and fall back to
   * the login/unlock screen.
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
}


/*
 * Wraps startApplication() so that any FATAL failure (currently, only
 * initRouter() throwing) tears #app back down via hideApp() before the
 * error is re-thrown to the caller.
 *
 * This matters because several callers of startApplication() are
 * onSuccess callbacks handed to renderLogin()/renderUnlock() that run
 * later, driven by auth.js's own form submit handlers — not by
 * bootstrap()'s try/catch below. Without this wrapper, a failure there
 * would leave #app visible and half-initialized while auth.js's catch
 * writes an error message into the (now hidden) login/unlock card.
 * hideApp() re-shows that card, so the error becomes visible again
 * instead of the user seeing a stale/broken screen.
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

  initFontFamily();

  initUIDensity();
  initFontSize();

  initMessageBubbleStyle();
  initOwnBubbleGradient();

  /*
   * Advanced appearance overrides (CSS variables only) and the
   * local custom background. Both are device-local, so they are
   * applied here with the other local appearance settings — before
   * login and independent of the Settings screen. The background
   * touches IndexedDB only if it is enabled and has an image.
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
         * The authenticated user's accent is now
         * available from the server/login response.
         *
         * Apply it BEFORE creating the application UI.
         *
         * No localStorage fallback is used for accent.
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
     *
     * IMPORTANT:
     * This happens before showApp(), initRouter(),
     * socket initialization and any authenticated UI.
     */

    initAccent(
      me.accent_color || null
    );


    /* ------------------------------------------------------
     * Identity state
     *
     * The identity is intentionally kept only in memory.
     * ------------------------------------------------------ */

    if (!isIdentityUnlocked()) {

      /*
       * We already have a valid token AND /api/me has
       * confirmed the account. We only need to unlock
       * the local E2EE identity.
       *
       * First try silently using cached unlock material.
       */

      const autoUnlocked =
        await attemptAutoUnlock(
          me,
          token
        );


      if (autoUnlocked) {

        /*
         * Accent was already initialized from `me`
         * before attempting the identity unlock.
         *
         * No second accent initialization is necessary.
         */

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

          /*
           * Unlock has completed.
           * The user/token were already valid.
           *
           * The account accent was already applied
           * before the unlock screen appeared.
           */

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
       * showApp() may already have run (e.g. startApplication()
       * reached showApp() and initSocket() before initRouter()
       * threw). Tear #app back down before showing the login
       * screen so it isn't left visible but half-initialized
       * behind/alongside the re-shown login card.
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
           * Login has restored the authenticated user.
           * Apply the server-side accent before the
           * application UI is initialized.
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
 * Registered exactly once per page load, regardless of
 * login state.
 *
 * Capacitor's plugin bridge and window.electronAPI buffer/
 * replay events fired before a listener existed, so this
 * must be initialized immediately rather than after login.
 */

initNotificationClickRouting();

/*
 * Electron update notifications.
 *
 * This listener must be registered immediately on page load,
 * before bootstrap/login initialization, so the Electron main
 * process cannot send the event before the renderer is ready.
 *
 * 'app-update:available' only means the remote server is running a
 * newer Wire version than what's currently cached — it is NOT a
 * signal to update the cached Service Worker right away. The user
 * must explicitly confirm; only then is updateServiceWorker()
 * (core/pwa.js) called. If they decline, the current cached version
 * keeps being used and nothing happens.
 */

if (window.electronAPI?.isElectron) {

  /*
   * Tracks the server version a confirmation is currently open for,
   * so a repeated event for that same version (the main process may
   * re-check and re-send) doesn't stack a second dialog on top.
   */
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
