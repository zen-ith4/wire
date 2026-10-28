import { api } from '../core/api.js';
import { ICONS } from '../icons.js';
import { showToast, emptyState, loadingState, escapeHtml } from '../core/utils.js';
import { getCurrentUser } from '../core/auth.js';   // to protect self-deletion
import { showConfirm } from '../ui/confirm.js';
import { avatarHtml } from '../ui/avatar.js';
import { claimRender } from '../core/view-session.js';
import { deriveCredentials, generateKdfSalt, KDF_ITERATIONS } from '../crypto/credentials.js';
import { MIN_PASSWORD_LENGTH, deriveOwnAuthKey } from '../crypto/account-kdf.js';

/* ==================== USERS ==================== */
export async function renderAdminUsers() {
  const isCurrent = claimRender('admin-users');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const users = await api('/api/admin/users');
    if (!isCurrent()) return;

    // Usernames stay out of HTML attributes (CSP/escape rules): look them up by id.
    const usernameById = new Map(users.map((u) => [Number(u.id), u.username]));

    const currentUser = getCurrentUser();

    let rows = users.map(u => {
      const isSelf = !!currentUser && Number(u.id) === Number(currentUser.id);

      // The signed-in admin can neither delete nor demote themselves.
      // (The backend enforces this too; this just avoids offering it.)
      // Only one admin exists, so the role moves by transfer: the current
      // admin hands it to another user and becomes a normal user.
      const actions = isSelf
        ? '<span class="text-muted">You (admin)</span>'
        : `<div style="display:inline-flex;gap:8px;">
            <button class="btn btn-sm" data-transfer-admin="${Number(u.id)}">Transfer admin role</button>
            <button class="btn btn-danger btn-sm" data-delete-user="${Number(u.id)}">Delete</button>
          </div>`;

      // F12: where this account is in the credential migration.
      let signIn;
      if (Number(u.auth_scheme) === 2) {
        signIn = u.must_change_password
          ? '<span class="badge"><span class="badge-dot"></span>Must change password</span>'
          : '<span class="badge badge-green"><span class="badge-dot"></span>Upgraded</span>';
      } else if (u.legacy_login_closed) {
        signIn = '<span class="badge"><span class="badge-dot"></span>Legacy login closed</span>';
      } else {
        signIn = '<span class="badge"><span class="badge-dot"></span>Not upgraded yet</span>';
      }

      let legacyAction = '';
      if (!isSelf && Number(u.auth_scheme) !== 2) {
        legacyAction = u.legacy_login_closed
          ? `<button class="btn btn-sm" data-legacy-toggle="${Number(u.id)}" data-legacy-close="0">Reopen legacy login</button>`
          : `<button class="btn btn-sm" data-legacy-toggle="${Number(u.id)}" data-legacy-close="1">Close legacy login</button>`;
      }

      return `
      <tr class="file-row">
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            ${avatarHtml(u.id, u.username, 'chat-avatar')}
            <span>${escapeHtml(u.username)}</span>
          </div>
        </td>
        <td>${u.email ? escapeHtml(u.email) : '<span class="text-muted">—</span>'}</td>
        <td>${u.is_admin ? '<span class="badge badge-green"><span class="badge-dot"></span>Admin</span>' : '<span class="text-muted">User</span>'}</td>
        <td>${signIn} ${legacyAction}</td>
        <td class="col-right">${actions}</td>
      </tr>
    `;
    }).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head"><div class="card-title">${ICONS.users} Users</div></div>

      <div class="toolbar">
        <input
          type="text"
          id="new-username"
          placeholder="Username"
          autocomplete="username"
        >

        <input
          type="email"
          id="new-email"
          placeholder="Email"
          autocomplete="email"
        >

        <input
          type="password"
          id="new-password"
          placeholder="Temporary password (user must change it)"
          autocomplete="new-password"
        >

        <button
          class="btn btn-primary btn-sm"
          onclick="window.addUser()"
        >
          + Add user
        </button>
      </div>

      <div id="admin-user-error" class="field-error"></div>

      <div class="table-scroll">
        <table class="file-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Sign-in</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${
              rows ||
              `<tr>
                <td colspan="5">
                  ${emptyState(ICONS.users, 'No users yet')}
                </td>
              </tr>`
            }
          </tbody>
        </table>
      </div>

      <div class="toolbar">
        <button class="btn btn-sm" id="close-inactive-legacy">
          Close inactive legacy logins…
        </button>
      </div>
    </div>`;

    // No inline handlers (CSP): wire the F12 migration controls here.
    main.querySelectorAll('[data-legacy-toggle]').forEach((btn) => {
      btn.addEventListener('click', () =>
        setLegacyLogin(
          Number(btn.dataset.legacyToggle),
          btn.dataset.legacyClose === '1',
          btn
        )
      );
    });

    document
      .getElementById('close-inactive-legacy')
      ?.addEventListener('click', closeInactiveLegacyLogins);

    main.querySelectorAll('[data-transfer-admin]').forEach((btn) => {
      btn.addEventListener('click', () =>
        transferAdminFlow(Number(btn.dataset.transferAdmin), usernameById.get(Number(btn.dataset.transferAdmin)))
      );
    });

    main.querySelectorAll('[data-delete-user]').forEach((btn) => {
      btn.addEventListener('click', () =>
        deleteUserFlow(Number(btn.dataset.deleteUser), usernameById.get(Number(btn.dataset.deleteUser)))
      );
    });
  } catch (e) {
    if (!isCurrent()) return;

    main.innerHTML = `<div class="card">
      ${emptyState(
        ICONS.empty,
        'Failed to load',
        escapeHtml(e.message)
      )}
    </div>`;
  }
}

async function setLegacyLogin(id, closed, btn) {
  if (
    closed &&
    !await showConfirm(
      'This account has not signed in with the upgraded login yet. Closing the legacy login means the user cannot sign in until you reopen it. Continue?',
      { title: 'Close legacy login', confirmText: 'Close' }
    )
  ) {
    return;
  }

  if (btn) btn.disabled = true;

  try {
    await api(`/api/admin/users/${id}/legacy-login`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closed }),
    });

    await renderAdminUsers();

    showToast(closed ? 'Legacy login closed' : 'Legacy login reopened', 'success');
  } catch (e) {
    if (btn) btn.disabled = false;
    showToast(e.message, 'error');
  }
}

async function closeInactiveLegacyLogins() {
  const days = 90;

  try {
    const preview = await api(
      `/api/admin/credentials/legacy-login/inactive?days=${days}`
    );

    if (preview.count === 0) {
      showToast(`No inactive unupgraded accounts (over ${days} days)`, 'success');
      return;
    }

    const names = preview.users.map(u => u.username).join(', ');

    if (
      !await showConfirm(
        `Close the legacy login for ${preview.count} account(s) not upgraded and inactive for over ${days} days? ${names}`,
        { title: 'Close inactive legacy logins', confirmText: 'Close them' }
      )
    ) {
      return;
    }

    const result = await api(
      '/api/admin/credentials/legacy-login/close-inactive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, confirm_count: preview.count }),
      }
    );

    await renderAdminUsers();

    showToast(`Closed ${result.closed} account(s)`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

window.addUser = async function() {
  const username =
    document.getElementById('new-username').value.trim();

  const email =
    document.getElementById('new-email').value.trim();

  // Keep password exactly as entered.
  const password =
    document.getElementById('new-password').value;

  const errEl =
    document.getElementById('admin-user-error');

  errEl.textContent = '';

  try {
    // Client-side policy: the server never sees the temporary password.
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters`
      );
    }

    // F12: derive the new account's credentials here (fresh salt); only the
    // authKey and the salt are sent. The user must replace the password at
    // their first login.
    const kdfSalt = generateKdfSalt();

    const { authKey, wrapKeyBytes } =
      await deriveCredentials(
        password,
        kdfSalt,
        KDF_ITERATIONS
      );

    wrapKeyBytes.fill(0);

    await api('/api/admin/users', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        username,
        email,
        auth_key: authKey,
        kdf_salt: kdfSalt,
        kdf_iterations: KDF_ITERATIONS,
      }),
    });

    document.getElementById('new-username').value = '';
    document.getElementById('new-email').value = '';
    document.getElementById('new-password').value = '';

    await renderAdminUsers();

    showToast('User created', 'success');

  } catch (e) {
    errEl.textContent = e.message;
  }
};

// Password prompt for dangerous admin actions. Reuses the confirm modal's
// styling. Resolves with the typed password, or null if cancelled.
function askPassword({ title, message, confirmText }) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal active';

    const box = document.createElement('div');
    box.className = 'modal-content confirm-modal-content';

    const h3 = document.createElement('h3');
    h3.textContent = title;

    const p = document.createElement('p');
    p.textContent = message;

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'Your admin password';
    input.className = 'confirm-modal-input';

    const actions = document.createElement('div');
    actions.className = 'confirm-modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = 'Cancel';

    const ok = document.createElement('button');
    ok.className = 'btn btn-danger btn-sm';
    ok.textContent = confirmText;

    actions.append(cancel, ok);
    box.append(h3, p, input, actions);
    modal.append(box);
    document.body.append(modal);

    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      modal.remove();
      resolve(value);
    };

    const submit = () => {
      if (!input.value) {
        input.focus();
        return;
      }
      finish(input.value);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter') submit();
    };

    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', submit);
    document.addEventListener('keydown', onKey);
    input.focus();
  });
}

async function transferAdminFlow(id, username) {
  const confirmed = await showConfirm(
    `Make "${username}" the admin? You will become a normal user and lose admin rights immediately. There is always exactly one admin.`,
    { title: 'Transfer admin role', confirmText: 'Transfer', danger: true }
  );

  if (!confirmed) return;

  const password = await askPassword({
    title: 'Confirm with your password',
    message: `Enter your password to transfer the admin role to "${username}".`,
    confirmText: 'Transfer admin role',
  });

  if (password === null) return;

  try {
    const current_auth_key = await deriveOwnAuthKey(password);

    await api('/api/admin/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: id, current_auth_key }),
    });

    showToast(`Admin role transferred to ${username}`, 'success');

    // This account is no longer an admin: reload so the admin navigation
    // and every cached admin view go away.
    window.location.reload();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function deleteUserFlow(id, username) {
  const confirmed = await showConfirm(
    `Delete "${username}"? This cannot be undone.`,
    { title: 'Delete user' }
  );

  if (!confirmed) return;

  const password = await askPassword({
    title: 'Confirm with your password',
    message: `Enter your password to delete "${username}".`,
    confirmText: 'Delete user',
  });

  if (password === null) return;

  try {
    const current_auth_key = await deriveOwnAuthKey(password);

    await api(`/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_auth_key }),
    });

    await renderAdminUsers();

    showToast('User deleted', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

/* ==================== FOLDERS ==================== */
export async function renderAdminFolders() {
  const isCurrent = claimRender('admin-folders');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const folders = await api('/api/admin/folders');
    if (!isCurrent()) return;

    let rows = folders.map(f => `
      <tr class="file-row">
        <td>${escapeHtml(f.display_name)}</td>
        <td class="text-muted">${escapeHtml(f.path)}</td>
        <td class="col-right">
          <button
            class="btn btn-danger btn-sm"
            onclick="window.deleteFolder(${f.id})"
          >
            Delete
          </button>
        </td>
      </tr>
    `).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head">
        <div class="card-title">
          ${ICONS.folders} Shared Folders
        </div>
      </div>

      <div class="toolbar">
        <input
          type="text"
          id="new-folder-path"
          placeholder="/srv/media/Movies"
          style="min-width:220px;"
        >

        <input
          type="text"
          id="new-folder-name"
          placeholder="Display name"
        >

        <button
          class="btn btn-primary btn-sm"
          onclick="window.addFolder()"
        >
          + Add folder
        </button>
      </div>

      <div id="admin-folder-error" class="field-error"></div>

      <div class="table-scroll">
        <table class="file-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Path</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${
              rows ||
              `<tr>
                <td colspan="3">
                  ${emptyState(
                    ICONS.folders,
                    'No shared folders yet'
                  )}
                </td>
              </tr>`
            }
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    if (!isCurrent()) return;

    main.innerHTML = `<div class="card">
      ${emptyState(
        ICONS.empty,
        'Failed to load',
        escapeHtml(e.message)
      )}
    </div>`;
  }
}

window.addFolder = async function() {
  const path =
    document.getElementById('new-folder-path').value.trim();

  const name =
    document.getElementById('new-folder-name').value.trim();

  const errEl =
    document.getElementById('admin-folder-error');

  errEl.textContent = '';

  try {
    await api('/api/admin/folders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path,
        display_name: name || path
      }),
    });

    document.getElementById('new-folder-path').value = '';
    document.getElementById('new-folder-name').value = '';

    await renderAdminFolders();

    showToast('Folder added', 'success');

  } catch (e) {
    errEl.textContent = e.message;
  }
};

window.deleteFolder = async function(id) {
  if (
    !await showConfirm(
      'Remove this shared folder? Files on disk are not deleted.',
      { title: 'Remove folder' }
    )
  ) {
    return;
  }

  try {
    await api(`/api/admin/folders/${id}`, {
      method: 'DELETE'
    });

    await renderAdminFolders();

    showToast('Folder removed', 'success');

  } catch (e) {
    showToast(e.message, 'error');
  }
};

/* ==================== PERMISSIONS ==================== */
export async function renderAdminPermissions() {
  const isCurrent = claimRender('admin-permissions');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const [users, folders, perms] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/folders'),
      api('/api/admin/permissions'),
    ]);

    if (!isCurrent()) return;

    // Guard: no users or folders yet
    if (users.length === 0 || folders.length === 0) {
      main.innerHTML = `<div class="card">
        <div class="card-head">
          <div class="card-title">
            ${ICONS.key} Permissions
          </div>
        </div>

        ${emptyState(
          ICONS.key,
          'Create users and folders first',
          'You can then grant permissions.'
        )}
      </div>`;

      return;
    }

    let rows = perms.map(p => `
      <tr class="file-row">
        <td>${escapeHtml(p.username)}</td>
        <td>${escapeHtml(p.display_name)}</td>
        <td>
          ${
            p.can_write
              ? '<span class="badge badge-green"><span class="badge-dot"></span>Write</span>'
              : '<span class="text-muted">Read-only</span>'
          }
        </td>
        <td class="col-right">
          <button
            class="btn btn-danger btn-sm"
            onclick="window.deletePermission(${p.user_id},${p.folder_id})"
          >
            Remove
          </button>
        </td>
      </tr>
    `).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head">
        <div class="card-title">
          ${ICONS.key} Permissions
        </div>
      </div>

      <div class="toolbar">
        <select id="perm-user">
          ${
            users.map(u =>
              `<option value="${u.id}">
                ${escapeHtml(u.username)}
              </option>`
            ).join('')
          }
        </select>

        <select id="perm-folder">
          ${
            folders.map(f =>
              `<option value="${f.id}">
                ${escapeHtml(f.display_name)}
              </option>`
            ).join('')
          }
        </select>

        <label class="check">
          <input type="checkbox" id="perm-write">
          Allow write
        </label>

        <button
          class="btn btn-primary btn-sm"
          onclick="window.addPermission()"
        >
          + Grant
        </button>
      </div>

      <div
        id="admin-permission-error"
        class="field-error"
      ></div>

      <div class="table-scroll">
        <table class="file-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Folder</th>
              <th>Access</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${
              rows ||
              `<tr>
                <td colspan="4">
                  ${emptyState(
                    ICONS.key,
                    'No permissions granted yet'
                  )}
                </td>
              </tr>`
            }
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    if (!isCurrent()) return;

    main.innerHTML = `<div class="card">
      ${emptyState(
        ICONS.empty,
        'Failed to load',
        escapeHtml(e.message)
      )}
    </div>`;
  }
}

window.addPermission = async function() {
  const user_id =
    document.getElementById('perm-user').value;

  const folder_id =
    document.getElementById('perm-folder').value;

  const can_write =
    document.getElementById('perm-write').checked;

  const errEl =
    document.getElementById('admin-permission-error');

  errEl.textContent = '';

  try {
    await api('/api/admin/permissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id,
        folder_id,
        can_write
      }),
    });

    await renderAdminPermissions();

    showToast('Permission granted', 'success');

  } catch (e) {
    errEl.textContent = e.message;
  }
};

window.deletePermission = async function(
  user_id,
  folder_id
) {
  try {
    await api('/api/admin/permissions', {
      method: 'DELETE',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        user_id,
        folder_id
      }),
    });

    await renderAdminPermissions();

    showToast('Permission removed', 'success');

  } catch (e) {
    showToast(e.message, 'error');
  }
};

/* ==================== AUDIT LOG (read-only) ==================== */
const AUDIT_ACTION_LABELS = {
  create_user: 'Created user',
  delete_user: 'Deleted user',
  transfer_admin: 'Transferred admin role',
  create_folder: 'Added folder',
  delete_folder: 'Removed folder',
  grant_permission: 'Granted permission',
  revoke_permission: 'Revoked permission',
};

function auditDetailsText(details) {
  if (!details || typeof details !== 'object') return '';

  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' · ');
}

export async function renderAdminAudit() {
  const isCurrent = claimRender('admin-audit');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const entries = await api('/api/admin/audit?limit=100');
    if (!isCurrent()) return;

    const rows = entries.map((e) => {
      const label = AUDIT_ACTION_LABELS[e.action] || e.action;
      const who = e.admin_username ? escapeHtml(e.admin_username) : '<span class="text-muted">server (CLI)</span>';
      const target = e.target_type
        ? `${escapeHtml(e.target_type)} #${Number(e.target_id) || 0}`
        : '<span class="text-muted">—</span>';

      return `
        <tr class="file-row">
          <td class="text-muted">${escapeHtml(e.created_at)}</td>
          <td>${who}</td>
          <td>${escapeHtml(label)}</td>
          <td>${target}</td>
          <td class="text-muted">${escapeHtml(auditDetailsText(e.details))}</td>
        </tr>`;
    }).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head"><div class="card-title">${ICONS.key} Audit log</div></div>
      <p class="text-muted">Admin actions, newest first. Message content is never logged.</p>
      <div class="table-scroll">
        <table class="file-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="5">${emptyState(ICONS.key, 'No admin actions yet')}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    if (!isCurrent()) return;

    main.innerHTML = `<div class="card">
      ${emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message))}
    </div>`;
  }
}
