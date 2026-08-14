import { initRouter, navigate } from './router.js';
import { initSocket } from './socket.js';
import {
  getToken,
  setCurrentUser,
  renderLogin,
  logout
} from './auth.js';

import { showToast } from './utils.js';
import { api } from './api.js';
import { applyAvatar } from './avatar.js';
import { ICONS } from './icons.js';
import { refreshUnreadBadge } from './dm.js';
import { startAutoEnhance } from './ui-enhance.js';
import { initDragDrop } from './dragdrop.js';
import {
  initAccent
} from './theme.js';

import './profile-card.js';
import './image-viewer.js';


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
    document.getElementById('nav-links');

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
      'profile-section'
    );

  if (nameEl) {
    nameEl.textContent =
      user.username;
  }

  if (initialsEl) {
    initialsEl.textContent =
      (user.username || '?')
        .charAt(0)
        .toUpperCase();

    applyAvatar(
      'profile-initials',
      user.id
    );
  }

  if (sectionEl) {
    sectionEl.title =
      user.username;
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


async function bootstrap() {

  // Apply local theme immediately so the UI
  // doesn't start completely unstyled.
  initAccent();

  const token =
    getToken();

  if (!token) {

    renderLogin();

    return;
  }


  try {

    // --------------------------------------------------------
    // Get authenticated user
    // --------------------------------------------------------

    const me =
      await api('/api/me');


    // --------------------------------------------------------
    // Restore current user state
    // --------------------------------------------------------

    setCurrentUser(me);


    // --------------------------------------------------------
    // IMPORTANT:
    // Database accent takes priority over localStorage.
    // This is what makes custom accent colors persistent
    // across browsers/devices/sessions.
    // --------------------------------------------------------

    initAccent(
      me.accent_color || null
    );


    // --------------------------------------------------------
    // Start application
    // --------------------------------------------------------

    showApp(me);

    initSocket(token);

    initRouter();

    startAutoEnhance();

    initDragDrop();

  } catch (err) {

    // api() handles 401 itself.

    if (
      err.message !== 'Session expired'
    ) {

      console.error(err);

      showToast(
        'Failed to start application',
        'error'
      );

      renderLogin();
    }
  }
}


bootstrap().catch(err => {

  console.error(err);

  showToast(
    'Failed to start application',
    'error'
  );
});


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