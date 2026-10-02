// ============================================================
// Folder sharing (who can open / edit a folder you own) and the
// create / delete folder actions.
//
// Permission semantics are unchanged and enforced by the backend
// (routes/share.routes.js): the owner grants access per user with
// can_write true ("Can edit": may upload into the folder) or false
// ("View only"). Changing a person's level is the same POST
// /api/share/access call — the server upserts.
//
// UI: one native modal <dialog> (centred card on desktop, bottom sheet
// on phones — see sharing.css). Removing someone is a two-step inline
// confirmation rather than a second dialog.
//
// No window.* globals: files.js wires everything through delegated
// listeners, so nothing here is reachable from inline HTML attributes.
// ============================================================

import { api } from '../core/api.js';
import { esc } from './html.js';
import { ICONS } from '../icons.js';
import { showToast } from '../core/utils.js';
import { showConfirm } from '../ui/confirm.js';
import { openDialog } from './dialog.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Mirrors utils/validator.js isValidFolderName (the server is the
// authority; this only gives instant feedback).
const FOLDER_NAME_PATTERN = /^[a-zA-Z0-9 _.-]+$/;

export function validateFolderName(raw) {
  const name = String(raw ?? '').trim();

  if (!name) return 'Enter a folder name.';
  if (name.length > 60) return 'Folder names can be up to 60 characters.';
  if (name === '.' || name === '..' || !FOLDER_NAME_PATTERN.test(name)) {
    return 'Use letters, numbers, spaces, dots, dashes and underscores.';
  }

  return '';
}

export async function createShareFolder(rawName) {
  const name = String(rawName).trim();

  await api('/api/share/folders', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

/** Returns true when the folder was deleted. */
export async function deleteShareFolder(id, name) {
  const confirmed = await showConfirm(
    `Delete "${name}"? This removes it from Wire for everyone.`,
    { title: 'Delete folder' }
  );

  if (!confirmed) return false;

  try {
    await api(`/api/share/folders/${id}`, { method: 'DELETE' });
    showToast('Folder removed', 'success');
    return true;
  } catch (error) {
    showToast(error.message, 'error');
    return false;
  }
}

// ---------------------------------------------------------------
// Share dialog
// ---------------------------------------------------------------

function initialOf(name) {
  return esc(String(name || '?').charAt(0).toUpperCase());
}

/**
 * @param {object} opts
 * @param {number} opts.folderId
 * @param {string} opts.folderName
 * @param {(count:number) => void} [opts.onChanged] called with the new
 *        number of people with access whenever it changes
 */
export function openShareDialog({ folderId, folderName, onChanged }) {
  let alive = true;
  let access = [];
  let users = [];
  let pendingRemove = null; // user_id awaiting inline confirmation
  let busy = false;

  const { panel, close, dialog } = openDialog({
    variant: 'modal',
    className: 'files-sharedlg',
    onClose: () => { alive = false; },
  });

  dialog.setAttribute('aria-labelledby', 'fs-title');

  panel.innerHTML = `
    <div class="fd-head">
      <div class="files-tile files-tile--folder" aria-hidden="true">${ICONS.folder}</div>
      <div class="fd-titles">
        <h2 class="fd-title" id="fs-title">Share “${esc(folderName)}”</h2>
        <p class="fd-sub fs-summary">Loading…</p>
      </div>
      <button type="button" class="fd-close" aria-label="Close" data-act="close" autofocus>${ICONS.close}</button>
    </div>

    <div class="fd-body fs-body" aria-live="polite">
      <div class="fd-loading"><span class="spin" aria-hidden="true"></span> Loading…</div>
    </div>

    <div class="fd-foot">
      <button type="button" class="btn fd-btn" data-act="close">Done</button>
    </div>
  `;

  const body = panel.querySelector('.fs-body');
  const summary = panel.querySelector('.fs-summary');

  function render() {
    const count = access.length;
    summary.textContent =
      count === 0
        ? 'Only you can see this folder'
        : `Shared with ${count} ${count === 1 ? 'person' : 'people'}`;

    const alreadyShared = new Set(access.map((a) => a.user_id));
    const available = users.filter((u) => !alreadyShared.has(u.id));

    const rows = access.map((a) => {
      const confirming = pendingRemove === a.user_id;
      const name = esc(a.username);

      return `
        <li class="fs-row${confirming ? ' is-confirming' : ''}" data-user="${a.user_id}">
          <div class="fs-avatar" aria-hidden="true">${initialOf(a.username)}</div>
          <div class="fs-person">
            <div class="fs-name">${name}</div>
            <div class="fs-role">${a.can_write ? 'Can view and upload' : 'Can view only'}</div>
          </div>
          ${confirming ? `
            <div class="fs-confirm" role="group" aria-label="Confirm removing ${name}">
              <span class="fs-confirm-text">Remove ${name}’s access?</span>
              <button type="button" class="btn fd-btn" data-act="remove-cancel">Cancel</button>
              <button type="button" class="btn btn-danger fd-btn" data-act="remove-confirm" data-user="${a.user_id}">Remove</button>
            </div>
          ` : `
            <div class="fs-controls">
              <select class="fd-select fs-perm" data-user="${a.user_id}" aria-label="Permission for ${name}">
                <option value="1"${a.can_write ? ' selected' : ''}>Can edit</option>
                <option value="0"${a.can_write ? '' : ' selected'}>View only</option>
              </select>
              <button type="button" class="btn btn-danger-ghost fd-btn fs-remove" data-act="remove" data-user="${a.user_id}" aria-label="Remove ${name}">
                ${ICONS.trash}<span>Remove</span>
              </button>
            </div>
          `}
        </li>
      `;
    }).join('');

    body.innerHTML = `
      <section class="fd-section-block">
        <h3 class="fd-section">People with access</h3>
        <ul class="fs-list">
          <li class="fs-row fs-row--owner">
            <div class="fs-avatar fs-avatar--owner" aria-hidden="true">${ICONS.user}</div>
            <div class="fs-person">
              <div class="fs-name">You</div>
              <div class="fs-role">Owner · full access</div>
            </div>
            <span class="fs-owner-badge">Owner</span>
          </li>
          ${rows}
        </ul>
        ${count === 0 ? '<p class="fd-hint">Not shared with anyone yet.</p>' : ''}
      </section>

      <section class="fd-section-block">
        <h3 class="fd-section">Add someone</h3>
        ${available.length ? `
          <div class="fs-add">
            <div class="fs-field">
              <label class="fd-label" for="fs-user">Person</label>
              <select id="fs-user" class="fd-select fs-add-user">
                ${available.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('')}
              </select>
            </div>
            <div class="fs-field">
              <label class="fd-label" for="fs-can-write">Permission</label>
              <select id="fs-can-write" class="fd-select">
                <option value="0" selected>View only</option>
                <option value="1">Can edit</option>
              </select>
            </div>
            <button type="button" class="btn btn-primary fd-btn fs-add-btn" data-act="add">
              ${ICONS.userPlus}<span>Add</span>
            </button>
          </div>
        ` : `<p class="fd-hint">Everyone on Wire already has access, or there is nobody else to add.</p>`}
        <p class="fd-hint">
          <strong>Can edit</strong> lets someone upload files into this folder.
          Only you can manage sharing or delete the folder.
        </p>
      </section>
    `;
  }

  async function load() {
    try {
      const [accessRes, usersRes] = await Promise.all([
        api(`/api/share/access/${folderId}`),
        api('/api/share/users'),
      ]);

      if (!alive) return;

      access = Array.isArray(accessRes) ? accessRes : [];
      users = Array.isArray(usersRes) ? usersRes : [];
      render();

    } catch (error) {
      if (!alive) return;

      body.innerHTML = `
        <div class="fd-error" role="alert">
          <p>${esc(error.message || 'Couldn’t load sharing settings.')}</p>
          <button type="button" class="btn fd-btn" data-act="retry">Try again</button>
        </div>
      `;
      summary.textContent = '';
    }
  }

  async function mutate(request, successMessage) {
    if (busy) return false;
    busy = true;
    panel.classList.add('is-busy');

    try {
      await request();
      if (!alive) return false;

      const accessRes = await api(`/api/share/access/${folderId}`);
      if (!alive) return false;

      access = Array.isArray(accessRes) ? accessRes : [];
      pendingRemove = null;
      render();

      onChanged?.(access.length);
      if (successMessage) showToast(successMessage, 'success');
      return true;

    } catch (error) {
      if (alive) showToast(error.message, 'error');
      // Re-render so a select that was changed optimistically snaps back.
      if (alive) render();
      return false;

    } finally {
      busy = false;
      panel.classList.remove('is-busy');
    }
  }

  const grant = (userId, canWrite) =>
    api('/api/share/access', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        folder_id: folderId,
        target_user_id: userId,
        can_write: canWrite,
      }),
    });

  panel.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;

    const userId = Number(btn.dataset.user);

    switch (btn.dataset.act) {
      case 'close': close(); break;
      case 'retry': load(); break;

      case 'add': {
        const target = Number(panel.querySelector('#fs-user')?.value);
        const canWrite = panel.querySelector('#fs-can-write')?.value === '1';

        if (target) {
          await mutate(() => grant(target, canWrite), 'Access granted');
        }
        break;
      }

      case 'remove':
        pendingRemove = userId;
        render();
        panel.querySelector('[data-act="remove-cancel"]')?.focus({ preventScroll: true });
        break;

      case 'remove-cancel': {
        const prev = pendingRemove;
        pendingRemove = null;
        render();
        panel.querySelector(`[data-act="remove"][data-user="${prev}"]`)?.focus({ preventScroll: true });
        break;
      }

      case 'remove-confirm':
        await mutate(
          () => api('/api/share/access', {
            method: 'DELETE',
            headers: JSON_HEADERS,
            body: JSON.stringify({ folder_id: folderId, target_user_id: userId }),
          }),
          'Access removed'
        );
        break;

      default: break;
    }
  });

  panel.addEventListener('change', (event) => {
    const select = event.target.closest('.fs-perm');
    if (!select || !select.dataset.user) return;

    mutate(
      () => grant(Number(select.dataset.user), select.value === '1'),
      'Permission updated'
    );
  });

  load();

  return { close };
}
