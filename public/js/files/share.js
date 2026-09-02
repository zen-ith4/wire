import { api } from '../core/api.js';
import { ICONS } from '../icons.js';
import { showToast, emptyState, loadingState, escapeHtml, escapeAttr } from '../core/utils.js';
import { showConfirm } from '../ui/confirm.js';
import { renderFiles } from './files.js';

// Helper: escape a string for safe embedding inside a single-quoted JavaScript string
export function escapeJsString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

window.addMyShareFolder = async function() {
  const input = document.getElementById('new-folder-name');
  const name = input.value.trim();
  if (!name) return;

  if (name.length > 100) {
    showToast('Folder name too long (max 100 characters)', 'error');
    return;
  }

  try {
    await api('/api/share/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    input.value = '';
    await renderFiles();
    showToast('Folder created', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.deleteMyShareFolder = async function(id, name) {
  if (!await showConfirm(`Delete "${name}"? This removes it from Wire for everyone.`, { title: 'Delete folder' })) return;

  try {
    await api(`/api/share/folders/${id}`, { method: 'DELETE' });
    await renderFiles();
    showToast('Folder removed', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ---------- Share Modal ----------
let shareModalFolderId = null;
let shareModalFolderName = null;   // ✅ store name instead of scraping title

window.openShareModal = async function(folderId, folderName) {
  shareModalFolderId = folderId;
  shareModalFolderName = folderName;
  const modal = document.getElementById('share-modal');
  const body = document.getElementById('share-modal-body');

  document.getElementById('share-modal-title').textContent = `Share "${folderName}"`;
  modal.classList.add('active');
  body.innerHTML = loadingState();

  try {
    const [accessRes, usersRes] = await Promise.all([
      api(`/api/share/access/${folderId}`),
      api('/api/share/users'),
    ]);

    const safeAccess = Array.isArray(accessRes) ? accessRes : [];
    const safeUsers = Array.isArray(usersRes) ? usersRes : [];

    const alreadyShared = new Set(safeAccess.map(a => a.user_id));
    const available = safeUsers.filter(u => !alreadyShared.has(u.id));

    let list = safeAccess.map(a => `
      <div class="share-row">
        <div class="chat-avatar" style="width:26px;height:26px;font-size:10.5px;">${escapeHtml(a.username.charAt(0).toUpperCase())}</div>
        <span style="flex:1;font-size:13.5px;">${escapeHtml(a.username)}</span>
        <span class="badge ${a.can_write ? 'badge-green' : ''}" style="background:${a.can_write ? '' : 'rgba(255,255,255,.08)'};color:${a.can_write ? '' : 'var(--muted)'};">${a.can_write ? 'Can edit' : 'Read only'}</span>
        <button class="icon-btn" title="Remove" onclick="window.revokeShareAccess(${a.user_id})">${ICONS.trash}</button>
      </div>
    `).join('') || `<div class="text-muted" style="font-size:13px;padding:8px 0;">Not shared with anyone yet.</div>`;

    const options = available.map(u => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join('');

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px;">${list}</div>
      ${available.length ? `
        <div class="toolbar" style="margin-bottom:0;">
          <select id="share-target-user">${options}</select>
          <label class="check"><input type="checkbox" id="share-can-write"> Allow edit</label>
          <button class="btn btn-primary btn-sm" onclick="window.grantShareAccess()">${ICONS.userPlus} Share</button>
        </div>` : `<div class="text-muted" style="font-size:12.5px;">Everyone already has access, or no other friends registered.</div>`}
    `;
  } catch (e) {
    body.innerHTML = emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message));
  }
};

window.closeShareModal = function() {
  document.getElementById('share-modal').classList.remove('active');
  shareModalFolderId = null;
  shareModalFolderName = null;
};

window.grantShareAccess = async function() {
  const select = document.getElementById('share-target-user');
  if (!select) return;   // ❗ guard against missing select

  const target_user_id = select.value;
  const can_write = document.getElementById('share-can-write').checked;

  try {
    await api('/api/share/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: shareModalFolderId, target_user_id, can_write }),
    });
    // Refresh modal and list using stored name
    await openShareModal(shareModalFolderId, shareModalFolderName);
    await renderFiles();
    showToast('Shared', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.revokeShareAccess = async function(target_user_id) {
  try {
    await api('/api/share/access', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: shareModalFolderId, target_user_id }),
    });
    await openShareModal(shareModalFolderId, shareModalFolderName);
    await renderFiles();
    showToast('Access revoked', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};