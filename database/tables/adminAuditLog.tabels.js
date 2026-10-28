// Audit trail for destructive or privileged admin actions (create/delete
// user, transfer admin role, create/delete folder, grant/revoke permission).
//
// SECURITY NOTES
//   - details_json never holds passwords, tokens, auth keys, hashes or salts.
//     services/adminAudit.service.js strips such keys before writing.
//   - admin_id is NULL for actions done from the server shell (CLI recovery).
//   - Rows are append-only from the application's point of view (there is
//     no update or delete route).
module.exports = `
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  admin_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details_json TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (admin_id)
    REFERENCES users(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
ON admin_audit_log(created_at, id);
`;
