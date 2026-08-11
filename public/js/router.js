import { getCurrentUser } from './auth.js';

import { renderFiles } from './files.js';
import { renderChat } from './chat.js';
import { renderDm } from './dm.js';
import { renderSettings } from './settings.js';

import {
  renderAdminUsers,
  renderAdminFolders,
  renderAdminPermissions,
} from './admin.js';

import { renderWireguard } from './wireguard.js';

const routes = {
  files: {
    title: 'My Files',
    render: renderFiles,
    flush: true,
  },

  chat: {
    title: 'Chat',
    render: renderChat,
    flush: true,
  },

  messages: {
    title: 'Messages',
    render: renderDm,
    flush: true,
  },

  settings: {
    title: 'Settings',
    render: renderSettings,
  },

  'admin-users': {
    title: 'Users',
    render: renderAdminUsers,
  },

  'admin-folders': {
    title: 'Shared Folders',
    render: renderAdminFolders,
  },

  'admin-permissions': {
    title: 'Permissions',
    render: renderAdminPermissions,
  },

  'admin-wireguard': {
    title: 'WireGuard',
    render: renderWireguard,
  },
};

export function initRouter() {
  navigate(window.location.hash.slice(1) || 'files');

  window.addEventListener('hashchange', () => {
    navigate(window.location.hash.slice(1) || 'files');
  });
}

export function navigate(view, params) {
  const user = getCurrentUser();

  if (!user) {
    return;
  }

  const route = routes[view] || routes.files;

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle(
      'active',
      link.dataset.view === view
    );
  });

  const title = document.getElementById('topbar-title');

  if (title) {
    title.textContent = route.title;
  }

  // "flush" routes (Chat, Messages) manage their own internal
  // scroll regions and need the outer .content wrapper to have zero
  // padding/scroll of its own — otherwise the messaging UI ends up
  // boxed inside a padded, independently-scrolling container instead
  // of filling the window the way a desktop chat app would.
  const content = document.getElementById('content-area');
  if (content) {
    content.classList.toggle('content--flush', !!route.flush);
  }

  route.render(params);

  if (window.location.hash !== `#${view}`) {
    window.location.hash = view;
  }
}