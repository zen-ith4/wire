// ============================================================
// Delete a file or folder from My Files.
//
// Only the confirmation + the request live here (same shape as
// deleteShareFolder() in share.js: ask, call the API, toast, report the
// outcome). What the LIST does about it — busy row, removing it from
// the view, closing a viewer — is files.js's job, because that is the
// module that owns the view state.
//
// The server is the authority: DELETE /api/files/item/:folderId removes
// the entry from storage (recursively for a folder), cleans up its
// share links, and only lets the folder owner do it. Nothing here
// removes anything from the DOM on its own.
// ============================================================

import { api } from '../core/api.js';
import { showToast } from '../core/utils.js';
import { showConfirm } from '../ui/confirm.js';

function confirmCopy({ name, type }) {
  if (type === 'dir') {
    return {
      title: 'Delete folder',
      message:
        `Delete the folder "${name}"? Everything inside it, including all files and subfolders, ` +
        'will be permanently deleted. This can’t be undone.',
    };
  }

  return {
    title: 'Delete file',
    message:
      `Delete "${name}"? It will be permanently deleted and any share links to it will stop working. ` +
      'This can’t be undone.',
  };
}

/**
 * @param {{ folderId: number, subpath: string, name: string, type: 'file'|'dir' }} target
 * @param {{ onStart?: () => void }} [hooks]
 *        onStart runs right after the user confirms, before the request
 *        is sent (the caller shows its in-progress state there).
 * @returns {Promise<{ status: 'cancelled'|'deleted'|'failed', error?: Error }>}
 */
export async function deleteEntry(target, { onStart } = {}) {
  const { title, message } = confirmCopy(target);

  const confirmed = await showConfirm(message, {
    title,
    confirmText: 'Delete',
  });

  if (!confirmed) return { status: 'cancelled' };

  onStart?.();

  const query =
    `subpath=${encodeURIComponent(target.subpath)}&file=${encodeURIComponent(target.name)}`;

  try {
    await api(`/api/files/item/${target.folderId}?${query}`, { method: 'DELETE' });

    showToast(target.type === 'dir' ? 'Folder deleted' : 'File deleted', 'success');
    return { status: 'deleted' };

  } catch (error) {
    showToast(error.message, 'error');
    return { status: 'failed', error };
  }
}
