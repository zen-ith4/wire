// services/adminAudit.service.js
//
// Writes and reads the admin audit trail (admin_audit_log table).
// Callers pass plain details; secret-looking keys are removed here, so no
// caller can store a password, token, auth key, hash or salt by mistake.

const { getDb } = require('../config/database');

const SECRET_KEY = /pass|token|auth[_-]?key|hash|salt|secret|cookie/i;

// Recursively drops secret-looking keys from a details object.
function sanitize(value) {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === 'object') {
    const out = {};

    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = sanitize(inner);
    }

    return out;
  }

  return value;
}

// adminId: the acting admin's user id, or null for CLI actions.
// Must run inside the same transaction as the change it records, so the
// action and its log row commit (or fail) together.
function recordAdminAction({
  adminId = null,
  action,
  targetType = null,
  targetId = null,
  details = null,
}) {
  getDb()
    .prepare(`
      INSERT INTO admin_audit_log
        (admin_id, action, target_type, target_id, details_json)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      adminId,
      action,
      targetType,
      targetId,
      details === null ? null : JSON.stringify(sanitize(details))
    );
}

// Newest first. `beforeId` pages backwards from an id (exclusive).
function listAdminAudit({ limit = 50, beforeId = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const rows = beforeId
    ? getDb()
        .prepare(`
          SELECT l.id, l.admin_id, u.username AS admin_username,
                 l.action, l.target_type, l.target_id,
                 l.details_json, l.created_at
          FROM admin_audit_log l
          LEFT JOIN users u ON u.id = l.admin_id
          WHERE l.id < ?
          ORDER BY l.id DESC
          LIMIT ?
        `)
        .all(beforeId, safeLimit)
    : getDb()
        .prepare(`
          SELECT l.id, l.admin_id, u.username AS admin_username,
                 l.action, l.target_type, l.target_id,
                 l.details_json, l.created_at
          FROM admin_audit_log l
          LEFT JOIN users u ON u.id = l.admin_id
          ORDER BY l.id DESC
          LIMIT ?
        `)
        .all(safeLimit);

  return rows.map(row => ({
    id: row.id,
    admin_id: row.admin_id,
    admin_username: row.admin_username || (row.admin_id === null ? 'server (CLI)' : null),
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    details: row.details_json ? JSON.parse(row.details_json) : null,
    created_at: row.created_at,
  }));
}

module.exports = {
  recordAdminAction,
  listAdminAudit,
  sanitize,
};
