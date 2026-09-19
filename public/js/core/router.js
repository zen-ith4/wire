import { getCurrentUser } from './auth.js';

import { renderFiles } from '../files/files.js';
import { renderChat, destroyChatComposer } from '../chat/chat.js';
import { renderDm, destroyDmComposer } from '../chat/dm.js';
import { renderSettings } from '../settings/settings.js';

import {
  renderAdminUsers,
  renderAdminFolders,
  renderAdminPermissions,
} from '../settings/admin.js';

import { renderWireguard } from '../wireguard/wireguard.js';

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

  // Release any in-progress voice recording before switching views —
  // see destroyChatComposer()/destroyDmComposer() for why this can't
  // just be left to the next renderChat()/renderDm() call. Cheap
  // no-ops when nothing is currently recording (or that view was
  // never mounted in the first place).
  destroyChatComposer();
  destroyDmComposer();

  // One pass marks the active item in every navigation surface: the
  // desktop sidebar (.nav-link), the phone bottom tabs and the phone
  // admin menu (see ui/mobile-shell.js) — they all read the same route.
  document
    .querySelectorAll('.nav-link, .bottom-nav-item, .more-menu-item')
    .forEach((link) => {
      const isActive = link.dataset.view === view;

      link.classList.toggle('active', isActive);

      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
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

  // Page/view transition (new, toggle-gated — see core/motion.css /
  // .view-enter). #content-area is a single persistent DOM node that
  // each route.render() just refills, so simply adding the class
  // wouldn't replay the animation on the 2nd+ navigation; removing it
  // and forcing a reflow before re-adding does. No-op when Animations
  // is off (var(--motion-base) is 0ms), and this only animates the
  // outer wrapper's opacity/transform, never the flush chat/DM
  // views' own internal scroll regions.
  if (content) {
    content.classList.remove('view-enter');
    void content.offsetWidth;
    content.classList.add('view-enter');
  }

  if (window.location.hash !== `#${view}`) {
    window.location.hash = view;
  }
}