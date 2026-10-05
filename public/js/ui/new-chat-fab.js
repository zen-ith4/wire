// Floating "+" button with a small popup menu ("New message" / "New
// group"), shown at the bottom of the Messages and Groups conversation
// lists. Event handling is attached with addEventListener (no inline
// handlers) so it also works under the enforced CSP.

import { ICONS } from '../icons.js';
import { getCurrentUser } from '../core/auth.js';

export function newChatFabHtml() {
  const groupsOn = !!getCurrentUser()?.groups_enabled;
  return `
    <div class="new-chat-fab-wrap">
      <div class="new-chat-menu" id="new-chat-menu" role="menu" hidden>
        <button type="button" class="new-chat-menu-item" role="menuitem" data-fab-action="message">
          <span class="new-chat-menu-icon">${ICONS.mail}</span>
          <span class="new-chat-menu-text">
            <span class="new-chat-menu-title">New message</span>
            <span class="new-chat-menu-sub">Private chat with one person</span>
          </span>
        </button>
        ${groupsOn ? `
        <button type="button" class="new-chat-menu-item" role="menuitem" data-fab-action="group">
          <span class="new-chat-menu-icon">${ICONS.users}</span>
          <span class="new-chat-menu-text">
            <span class="new-chat-menu-title">New group</span>
            <span class="new-chat-menu-sub">Encrypted chat with several people</span>
          </span>
        </button>` : ''}
      </div>
      <button type="button" class="new-chat-fab" id="new-chat-fab" aria-label="New chat" aria-haspopup="menu" aria-expanded="false" title="New chat">${ICONS.plus}</button>
    </div>
  `;
}

export function bindNewChatFab(root, { onMessage, onGroup }) {
  const fab = root.querySelector('#new-chat-fab');
  const menu = root.querySelector('#new-chat-menu');
  if (!fab || !menu) return;

  const setOpen = (open) => {
    menu.hidden = !open;
    fab.classList.toggle('open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-fab-action]');
    if (!item) return;
    setOpen(false);
    if (item.dataset.fabAction === 'message') onMessage?.();
    else if (item.dataset.fabAction === 'group') onGroup?.();
  });

  const onDocClick = (e) => {
    if (!fab.isConnected) {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (!menu.hidden && !menu.contains(e.target)) setOpen(false);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !menu.hidden) setOpen(false);
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
}
