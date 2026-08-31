export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function escapeAttr(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ');
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function emptyState(icon, title, sub) {
  return `<div class="empty-state">
    ${icon}
    <div class="title">${title}</div>
    <div class="sub">${sub || ''}</div>
  </div>`;
}

export function loadingState() {
  return `<div class="loading-state"><div class="spin"></div> Loading…</div>`;
}

/**
 * Inserts `text` at the current cursor position (or replaces the
 * current selection) inside a text input, then restores focus and
 * places the cursor right after what was just inserted. Generic —
 * used by the emoji picker's composer integration, but not specific
 * to emoji.
 */
export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;

  input.value = input.value.slice(0, start) + text + input.value.slice(end);

  const pos = start + text.length;
  input.focus();
  input.setSelectionRange(pos, pos);
}

export function showToast(msg, type = 'info') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const div = document.createElement('div');
  div.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}