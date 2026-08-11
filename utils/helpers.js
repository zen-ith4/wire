function clampLimit(value, defaultValue = 50, max = 100) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number) || number <= 0) {
    return defaultValue;
  }

  return Math.min(number, max);
}

function withAttachmentFlag(rows) {
  return rows.map(row => ({
    ...row,
    has_attachment: Boolean(row.attachment_name),
  }));
}

// چون دقیقاً همون کارو می‌کنه
const withDmFlags = withAttachmentFlag;

function withReactions(rows, reactionsByMessageId) {
  return rows.map(row => ({
    ...row,
    reactions: reactionsByMessageId[row.id] || [],
  }));
}

function formatBytes(bytes) {
  if (!bytes) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));

  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

function formatDate(iso) {
  if (!iso) {
    return '';
  }

  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value = '') {
  return escapeHtml(value).replace(/\r?\n/g, ' ');
}

module.exports = {
  clampLimit,
  withAttachmentFlag,
  withDmFlags,
  withReactions,
  formatBytes,
  formatDate,
  escapeHtml,
  escapeAttr,
};