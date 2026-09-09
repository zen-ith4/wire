import { initRouter, navigate } from './router.js';

import { initSocket } from './socket.js';

import {
  getToken,
  getCurrentUser,
  setCurrentUser,
  renderLogin,
  renderIdentityStep,
  logout
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


  const token =
    getToken();


  /*
   * No account session.
   */

if (!token) {
  renderLogin(async () => {
    const user = getCurrentUser();
    const currentToken = getToken();

    if (!user || !currentToken) {
      throw new Error(
        'Authentication state is unavailable'
      );
    }

    await startApplication(
      user,
      currentToken
    );
  });

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
     * Identity gate
     *
     * The app must not start until the E2EE identity
     * has been unlocked.
     * ------------------------------------------------------ */

    if (!isIdentityUnlocked()) {

      await renderIdentityStep(
        async () => {

          /*
           * Identity has now been successfully
           * created/restored in memory.
           *
           * Start the application directly.
           */

          await startApplication(
            me,
            token
          );

        }
      );

      return;
    }


    /* ------------------------------------------------------
     * Identity already unlocked.
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


      renderLogin();
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