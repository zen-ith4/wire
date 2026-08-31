import { api } from '../core/api.js';
import { ICONS } from '../icons.js';
import { showToast, emptyState, loadingState, escapeHtml } from '../core/utils.js';
import { getCurrentUser } from '../core/auth.js';   // to protect self-deletion
import { showConfirm } from '../ui/confirm.js';
import { avatarHtml } from '../ui/avatar.js';

/* ==================== USERS ==================== */
export async function renderAdminUsers() {
  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const users = await api('/api/admin/users');
    let rows = users.map(u => `
      <tr class="file-row">
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            ${avatarHtml(u.id, u.username, 'chat-avatar', true)}
            <span>${escapeHtml(u.username)}</span>
          </div>
        </td>
        <td>${u.is_admin ? '<span class="badge badge-green"><span class="badge-dot"></span>Admin</span>' : '<span class="text-muted">User</span>'}</td>
        <td class="col-right">
          <button class="btn btn-danger btn-sm" onclick="window.deleteUser(${u.id})">Delete</button>
        </td>
      </tr>
    `).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head"><div class="card-title">${ICONS.users} Users</div></div>
      <div class="toolbar">
        <input type="text" id="new-username" placeholder="Username">
        <input type="password" id="new-password" placeholder="Password">
        <label class="check"><input type="checkbox" id="new-admin"> Admin</label>
        <button class="btn btn-primary btn-sm" onclick="window.addUser()">+ Add user</button>
      </div>
      <div id="admin-user-error" class="field-error"></div>
      <table class="file-table">
        <thead><tr><th>Username</th><th>Role</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">${emptyState(ICONS.users, 'No users yet')}</td></tr>`}</tbody>
      </table>
    </div>`;
  } catch (e) {
    main.innerHTML = `<div class="card">${emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message))}</div>`;
  }
}

window.addUser = async function() {
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value;   // we keep password as is (could be spaces allowed)
  const is_admin = document.getElementById('new-admin').checked;
  const errEl = document.getElementById('admin-user-error');
  errEl.textContent = '';

  try {
    await api('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, is_admin }),
    });
    // Clear inputs
    document.getElementById('new-username').value = '';
    document.getElementById('new-password').value = '';
    await renderAdminUsers();
    showToast('User created', 'success');
  } catch (e) {
    errEl.textContent = e.message;
  }
};

window.deleteUser = async function(id) {
  const currentUser = getCurrentUser();
  if (currentUser && id === currentUser.id) {
    showToast('You cannot delete yourself', 'error');
    return;
  }

  if (!await showConfirm('Delete this user? This cannot be undone.', { title: 'Delete user' })) return;

  try {
    await api(`/api/admin/users/${id}`, { method: 'DELETE' });
    await renderAdminUsers();
    showToast('User deleted', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

/* ==================== FOLDERS ==================== */
export async function renderAdminFolders() {
  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const folders = await api('/api/admin/folders');
    let rows = folders.map(f => `
      <tr class="file-row">
        <td>${escapeHtml(f.display_name)}</td>
        <td class="text-muted">${escapeHtml(f.path)}</td>
        <td class="col-right">
          <button class="btn btn-danger btn-sm" onclick="window.deleteFolder(${f.id})">Delete</button>
        </td>
      </tr>
    `).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head"><div class="card-title">${ICONS.folders} Shared Folders</div></div>
      <div class="toolbar">
        <input type="text" id="new-folder-path" placeholder="/srv/media/Movies" style="min-width:220px;">
        <input type="text" id="new-folder-name" placeholder="Display name">
        <button class="btn btn-primary btn-sm" onclick="window.addFolder()">+ Add folder</button>
      </div>
      <div id="admin-folder-error" class="field-error"></div>
      <table class="file-table">
        <thead><tr><th>Display name</th><th>Path</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">${emptyState(ICONS.folders, 'No shared folders yet')}</td></tr>`}</tbody>
      </table>
    </div>`;
  } catch (e) {
    main.innerHTML = `<div class="card">${emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message))}</div>`;
  }
}

window.addFolder = async function() {
  const path = document.getElementById('new-folder-path').value.trim();
  const name = document.getElementById('new-folder-name').value.trim();
  const errEl = document.getElementById('admin-folder-error');
  errEl.textContent = '';

  try {
    await api('/api/admin/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, display_name: name || path }),
    });
    // Clear inputs
    document.getElementById('new-folder-path').value = '';
    document.getElementById('new-folder-name').value = '';
    await renderAdminFolders();
    showToast('Folder added', 'success');
  } catch (e) {
    errEl.textContent = e.message;
  }
};

window.deleteFolder = async function(id) {
  if (!await showConfirm('Remove this shared folder? Files on disk are not deleted.', { title: 'Remove folder' })) return;

  try {
    await api(`/api/admin/folders/${id}`, { method: 'DELETE' });
    await renderAdminFolders();
    showToast('Folder removed', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

/* ==================== PERMISSIONS ==================== */
export async function renderAdminPermissions() {
  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const [users, folders, perms] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/folders'),
      api('/api/admin/permissions'),
    ]);

    // Guard: no users or folders yet
    if (users.length === 0 || folders.length === 0) {
      main.innerHTML = `<div class="card">
        <div class="card-head"><div class="card-title">${ICONS.key} Permissions</div></div>
        ${emptyState(ICONS.key, 'Create users and folders first', 'You can then grant permissions.')}
      </div>`;
      return;
    }

    let rows = perms.map(p => `
      <tr class="file-row">
        <td>${escapeHtml(p.username)}</td>
        <td>${escapeHtml(p.display_name)}</td>
        <td>${p.can_write ? '<span class="badge badge-green"><span class="badge-dot"></span>Write</span>' : '<span class="text-muted">Read-only</span>'}</td>
        <td class="col-right">
          <button class="btn btn-danger btn-sm" onclick="window.deletePermission(${p.user_id},${p.folder_id})">Remove</button>
        </td>
      </tr>
    `).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head"><div class="card-title">${ICONS.key} Permissions</div></div>
      <div class="toolbar">
        <select id="perm-user">${users.map(u => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join('')}</select>
        <select id="perm-folder">${folders.map(f => `<option value="${f.id}">${escapeHtml(f.display_name)}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" id="perm-write"> Allow write</label>
        <button class="btn btn-primary btn-sm" onclick="window.addPermission()">+ Grant</button>
      </div>
      <div id="admin-permission-error" class="field-error"></div>
      <table class="file-table">
        <thead><tr><th>User</th><th>Folder</th><th>Access</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">${emptyState(ICONS.key, 'No permissions granted yet')}</td></tr>`}</tbody>
      </table>
    </div>`;
  } catch (e) {
    main.innerHTML = `<div class="card">${emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message))}</div>`;
  }
}

window.addPermission = async function() {
  const user_id = document.getElementById('perm-user').value;
  const folder_id = document.getElementById('perm-folder').value;
  const can_write = document.getElementById('perm-write').checked;
  const errEl = document.getElementById('admin-permission-error');
  errEl.textContent = '';

  try {
    await api('/api/admin/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, folder_id, can_write }),
    });
    await renderAdminPermissions();
    showToast('Permission granted', 'success');
  } catch (e) {
    errEl.textContent = e.message;
  }
};

window.deletePermission = async function(user_id, folder_id) {
  try {
    await api('/api/admin/permissions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, folder_id }),
    });
    await renderAdminPermissions();
    showToast('Permission removed', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};