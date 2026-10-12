// ============================================================
// Mobile shell — bottom tab bar, admin "more" menu and keyboard
// awareness for phones.
//
// Everything here is inert on desktop: the markup is always built,
// but only *shown* below the breakpoint defined in responsive.css,
// where the sidebar is hidden instead. This file owns no navigation
// state — tabs call the same navigate() the sidebar uses (passed in
// from core/app.js) and router.js marks whichever item is active, so
// there is still exactly one source of truth for "where am I".
// ============================================================

import { ICONS } from '../icons.js';

/**
 * Unread-badge markup shared by the sidebar and the bottom bar.
 * dm.js refreshUnreadBadge() updates every [data-badge="dm"] element,
 * so both navs stay in sync without any extra wiring.
 */
export function navBadgeHtml(item) {
  return item.badge
    ? `<span class="nav-badge hidden" data-badge="${item.badge}">0</span>`
    : '';
}

let moreBtn = null;
let moreMenu = null;

function setMoreMenuOpen(open) {
  if (!moreBtn || !moreMenu) return;
  moreMenu.classList.toggle('open', open);
  moreBtn.setAttribute('aria-expanded', String(open));
}

function closeMoreMenu() {
  setMoreMenuOpen(false);
}

/**
 * Admin destinations, tucked behind a ⋮ button in the top bar so they
 * never take a slot in the primary tabs. `adminItems` is the
 * already-permission-filtered list from buildNav() (core/app.js) — the
 * same `user.is_admin` check that populates the desktop sidebar. For a
 * non-admin the list is empty, so no button and no menu are created at
 * all (nothing is merely hidden). Rebuilding also clears any button
 * left over from a previous session.
 */
function renderMoreMenu(adminItems, navigate) {
  moreBtn?.remove();
  moreMenu?.remove();
  moreBtn = null;
  moreMenu = null;

  const topbar = document.querySelector('.topbar');
  const main = document.querySelector('.main');
  if (!adminItems.length || !topbar || !main) return;

  moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'icon-btn topbar-more-btn';
  moreBtn.setAttribute('aria-label', 'More');
  moreBtn.setAttribute('aria-haspopup', 'true');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.innerHTML = ICONS.more;
  moreBtn.addEventListener('click', () => {
    setMoreMenuOpen(!moreMenu.classList.contains('open'));
  });

  // Group logically (item.group), keeping the list's own order.
  const groups = new Map();
  adminItems.forEach((item) => {
    const key = item.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  const panel = document.createElement('div');
  panel.className = 'more-menu-panel';
  panel.setAttribute('aria-label', 'Administration');

  groups.forEach((items, name) => {
    const section = document.createElement('div');
    section.setAttribute('role', 'group');

    if (name) {
      const label = document.createElement('div');
      label.className = 'more-menu-label';
      label.textContent = name;
      section.setAttribute('aria-label', name);
      section.appendChild(label);
    }

    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'more-menu-item';
      btn.dataset.view = item.view;
      btn.innerHTML = item.icon || '';

      const text = document.createElement('span');
      text.textContent = item.label;
      btn.appendChild(text);

      btn.addEventListener('click', () => {
        closeMoreMenu();
        navigate(item.view);
      });
      section.appendChild(btn);
    });

    panel.appendChild(section);
  });

  moreMenu = document.createElement('div');
  moreMenu.className = 'more-menu';
  moreMenu.appendChild(panel);
  // Tap anywhere outside the panel to dismiss.
  moreMenu.addEventListener('click', (e) => {
    if (e.target === moreMenu) closeMoreMenu();
  });

  topbar.appendChild(moreBtn);
  main.appendChild(moreMenu);
}

/**
 * Build the bottom tab bar (+ admin menu). `tabs` is the same list
 * that builds the sidebar, so the two can never drift apart.
 * `groupsTab` is the Groups nav item (the very object the desktop
 * sidebar uses) or null; core/app.js passes it only when the server
 * reports groups_enabled, and it is appended after the primary tabs.
 */
export function renderMobileNav({ tabs, groupsTab = null, adminItems, navigate }) {
  const bar = document.getElementById('bottom-nav');

  if (bar) {
    bar.innerHTML = '';

    (groupsTab ? [...tabs, groupsTab] : tabs).forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bottom-nav-item';
      btn.dataset.view = item.view;
      btn.innerHTML = `
        <span class="bottom-nav-icon">${item.icon || ''}${navBadgeHtml(item)}</span>
        <span class="bottom-nav-label">${item.label}</span>
      `;
      btn.addEventListener('click', () => navigate(item.view));
      bar.appendChild(btn);
    });
  }

  renderMoreMenu(adminItems, navigate);
}

// ---------- Keyboard awareness ----------

// Elements that bring up the on-screen keyboard.
const TEXT_ENTRY =
  'textarea, input:not([type]), input[type="text"], input[type="password"], ' +
  'input[type="email"], input[type="search"], input[type="tel"], ' +
  'input[type="url"], input[type="number"], ' +
  '[contenteditable=""], [contenteditable="true"]';

function isTextEntry(el) {
  return !!(el && el.matches && el.matches(TEXT_ENTRY));
}

/**
 * The keyboard shrinks the viewport, so the newest messages would
 * slide out of view under it. If the reader was already at the bottom
 * of the list, keep them there while the viewport settles (the
 * keyboard animates in over a few hundred ms, in several resize steps).
 */
function keepMessagesPinned(input) {
  const list = input
    .closest('.chat-panel, .dm-thread')
    ?.querySelector('.chat-messages');
  if (!list) return;
  if (list.scrollHeight - list.scrollTop - list.clientHeight > 120) return;

  const vv = window.visualViewport;
  const pin = () => {
    list.scrollTop = list.scrollHeight;
  };

  window.addEventListener('resize', pin);
  if (vv) vv.addEventListener('resize', pin);

  setTimeout(() => {
    window.removeEventListener('resize', pin);
    if (vv) vv.removeEventListener('resize', pin);
  }, 800);
}

function initKeyboardAwareness() {
  const root = document.documentElement;
  let blurTimer = 0;

  // A class on <html> (rather than measuring the viewport) works the
  // same in browsers, Android WebView and Capacitor, whichever way the
  // platform resizes for the keyboard. The bottom bar hides while it's
  // set (responsive.css) so the composer sits right on top of the
  // keyboard instead of a nav bar wasting space above it.
  document.addEventListener('focusin', (e) => {
    if (!isTextEntry(e.target)) return;
    clearTimeout(blurTimer);
    root.classList.add('kb-open');
    keepMessagesPinned(e.target);
  });

  document.addEventListener('focusout', () => {
    clearTimeout(blurTimer);
    // Delayed so focus hopping between fields — or the composer's send
    // button re-focusing the input — doesn't flicker the bar.
    blurTimer = setTimeout(() => {
      if (!isTextEntry(document.activeElement)) {
        root.classList.remove('kb-open');
      }
    }, 150);
  });
}

let initialized = false;

/** Call once at startup (idempotent). */
export function initMobileShell() {
  if (initialized) return;
  initialized = true;

  initKeyboardAwareness();

  window.addEventListener('hashchange', closeMoreMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMoreMenu();
  });

  // Rotation / crossing the phone-vs-desktop breakpoint: drop an open
  // menu. Width only — a keyboard opening changes height, and must not
  // dismiss a menu the user just opened.
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    closeMoreMenu();
  });
}
