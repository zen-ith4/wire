// ============================================================
// Profile card
//
// Opens when any user's avatar is clicked (wired globally in
// avatar.js's avatarHtml() — see the .clickable-avatar class) and
// shows their full bio, avatar, and live online/offline status.
// Read-only: editing your own bio stays in Settings, which already
// has that flow (settings.js -> window.saveBio).
// ============================================================

import { api } from '../core/api.js';
import { escapeHtml, escapeAttr, loadingState, formatBytes } from '../core/utils.js';
import { registerActions } from './actions.js';
import { avatarHtml, bannerHtml } from './avatar.js';
import { isUserOnline, setUserOnline, setLastSeenAt, onPresenceChange, getPresenceStatusText } from '../chat/presence.js';
import { getCurrentUser } from '../core/auth.js';
import { navigate } from '../core/router.js';
import { pushOverlay, closeOverlay } from '../core/navigation.js';

let openProfileId = null; // which user the open card belongs to, or null if closed

function formatJoinDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
  });
}

export async function openProfileCard(userId) {
  const modal = document.getElementById('profile-card-modal');
  const body = document.getElementById('profile-card-body');
  if (!modal || !body) return;

  const id = Number(userId);
  openProfileId = id;

  // Hide the online dots on the DM sidebar / other avatars while the card
  // is open — the card shows the person's status as a text label instead.
  document.querySelectorAll('.presence-dot').forEach(dot => dot.classList.add('hidden'));

  body.innerHTML = loadingState();
  modal.classList.add('active');

  // Android Back should close the card and reveal whatever it was
  // opened over (Files, a DM thread, ...) untouched — it never routes
  // anywhere, so there's nothing else for Back to restore.
  pushOverlay('profile-card', window.closeProfileCard);

  try {
    const profile = await api(`/api/me/${id}`);
    // The person may have clicked a different avatar (or closed the
    // card) before this resolved — don't overwrite with stale data.
    if (openProfileId !== id) return;

    // The server-side fetch is more authoritative than whatever
    // presence.js's local Set/Map happened to already know (it only
    // reflects live socket events seen so far this session) — sync it
    // in so the live listener below repaints correctly afterwards too.
    if (profile.online) {
      setUserOnline(profile.id);
    } else {
      setLastSeenAt(profile.id, profile.last_seen_at || null);
    }

    renderProfileCard(profile);
  } catch (e) {
    if (openProfileId !== id) return;
    body.innerHTML = `<div class="text-muted" style="padding:24px 4px;text-align:center;">${escapeHtml(e.message)}</div>`;
  }
}

function renderProfileCard(profile) {
  const body = document.getElementById('profile-card-body');
  if (!body) return;

  const isSelf = getCurrentUser()?.id === profile.id;

  body.innerHTML = `
    <div class="profile-card-banner-wrap">
      ${bannerHtml(profile.id, 'profile-banner')}
    </div>
    <div class="profile-card-header">
      ${avatarHtml(profile.id, profile.username, 'settings-avatar-big')}
      <div>
        <div class="profile-card-name">${escapeHtml(profile.username)}</div>
        <div class="profile-card-status${isUserOnline(profile.id) ? ' online' : ''}" data-presence-user="${profile.id}">
          ${getPresenceStatusText(profile.id)}
        </div>
        ${profile.is_admin ? `<span class="profile-card-badge">Administrator</span>` : ''}
      </div>
    </div>
    <div class="profile-card-bio-label">Bio</div>
    <div class="profile-card-bio">${
      profile.bio
        ? escapeHtml(profile.bio)
        : '<span class="text-muted">No bio yet.</span>'
    }</div>
    <div class="profile-card-meta">
      ${profile.created_at ? `
        <div class="profile-card-meta-item">
          <span class="profile-card-meta-label">Joined</span>
          <span>${escapeHtml(formatJoinDate(profile.created_at))}</span>
        </div>
      ` : ''}
      ${typeof profile.storage_used === 'number' ? `
        <div class="profile-card-meta-item">
          <span class="profile-card-meta-label">Storage used</span>
          <span>${escapeHtml(formatBytes(profile.storage_used))}</span>
        </div>
      ` : ''}
    </div>
    ${!isSelf ? `
      <button class="btn btn-primary btn-sm profile-card-message-btn"
        data-user-id="${profile.id}"
        data-username="${escapeAttr(profile.username)}"
        onclick="window.messageFromProfileCard(this)">
        Send Message
      </button>
    ` : ''}
  `;
}

window.messageFromProfileCard = function(btnEl) {
  const userId = Number(btnEl.dataset.userId);
  const username = btnEl.dataset.username;
  window.closeProfileCard();
  // Pass the username along, not just the id — the DM view has no
  // way to know a brand-new peer's display name on its own (there's
  // no existing conversation row to read it from), and previously
  // fell back to a placeholder like "User 7" until the thread loaded.
  navigate('messages', { id: userId, username });
};

window.closeProfileCard = function() {
  document.getElementById('profile-card-modal')?.classList.remove('active');
  openProfileId = null;
  // Re-show the online dots now that the card is gone.
  document.querySelectorAll('.presence-dot').forEach(dot => dot.classList.remove('hidden'));
};

window.openProfileCard = openProfileCard;

// Markup in index.html carries data-action names (see ui/actions.js).
// Backdrop closes unless the click is inside [data-stop] (the card itself).
// Same as the image viewer: clicks on the card content stop here.
document.querySelectorAll('#profile-card-modal [data-stop]').forEach((el) => {
  el.addEventListener('click', (e) => e.stopPropagation());
});

registerActions({
  'profile-card-close': () => window.closeProfileCard(),
  'profile-card-backdrop': (el, e) => {
    if (!e.target.closest('[data-stop]')) window.closeProfileCard();
  },
});

// Escape-to-close. Registered once (not per-open) and simply checks
// whether the modal is currently active, same pattern used for the
// presence subscription below — avoids adding/removing a listener
// every time the card opens and closes.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('profile-card-modal');
  if (modal && modal.classList.contains('active')) {
    window.closeProfileCard();
  }
});

// The DM sidebar avatars show an online dot, which is hidden while this
// card is open; this subscription just keeps the "Online"/"Offline" text
// label live while the card is open, since that's specific to this view.
onPresenceChange((changedUserId) => {
  if (openProfileId === null) return;
  if (changedUserId !== null && changedUserId !== openProfileId) return;

  const statusEl = document.querySelector(`.profile-card-status[data-presence-user="${openProfileId}"]`);
  if (statusEl) {
    statusEl.textContent = getPresenceStatusText(openProfileId);
    statusEl.classList.toggle('online', isUserOnline(openProfileId));
  }
});
