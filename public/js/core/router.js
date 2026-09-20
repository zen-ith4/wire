import { getCurrentUser } from './auth.js';
import { enterView } from './view-session.js';
import { perfNavStart } from './perf.js';

// The four primary tabs use their cache-first entry points (show*): a
// view that has been loaded before paints from memory immediately and
// revalidates in the background; the first visit loads normally.
import { showFiles } from '../files/files.js';
import { showChat, destroyChatComposer } from '../chat/chat.js';
import { showDm, destroyDmComposer } from '../chat/dm.js';
import { showSettings } from '../settings/settings.js';

import {
  renderAdminUsers,
  renderAdminFolders,
  renderAdminPermissions,
} from '../settings/admin.js';

import { renderWireguard } from '../wireguard/wireguard.js';

const routes = {
  files: {
    title: 'My Files',
    render: showFiles,
    flush: true,
  },

  chat: {
    title: 'Chat',
    render: showChat,
    flush: true,
  },

  messages: {
    title: 'Messages',
    render: showDm,
    flush: true,
  },

  settings: {
    title: 'Settings',
    render: showSettings,
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

// The view navigate() last mounted (the raw name it was called with).
let currentView = null;
let hashListenerAttached = false;

export function initRouter() {
  navigate(window.location.hash.slice(1) || 'files');

  // initRouter() can run again if startup is re-entered (e.g. login after
  // a failed boot); one listener is all the URL ever needs.
  if (hashListenerAttached) return;
  hashListenerAttached = true;

  window.addEventListener('hashchange', () => {
    const view = window.location.hash.slice(1) || 'files';

    // navigate() writes location.hash itself to keep the URL in sync, and
    // that write fires a hashchange too. That event is just the echo of a
    // navigation that has already been rendered — running it again would
    // render every click twice (two sets of API calls racing each other,
    // and params such as navigate('messages', { id }) dropped by the second
    // pass). Only a hash that differs from what is mounted — Back/Forward,
    // a typed URL — is a new navigation. Clicks never come through here:
    // they call navigate() directly, so re-tapping the active tab still
    // re-renders it.
    if (view === currentView) return;

    navigate(view);
  });
}

export function navigate(view, params) {
  const user = getCurrentUser();

  if (!user) {
    return;
  }

  perfNavStart(view);

  const route = routes[view] || routes.files;

  // Record what is being mounted and tell the view-ownership tracker
  // (core/view-session.js) BEFORE rendering, so that renders still in
  // flight for the previously mounted view know they are stale and stop
  // writing into #content-area.
  currentView = view;
  enterView(routes[view] ? view : 'files');

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