// Read-only audit of stored usernames against the rules for new accounts.
// Existing accounts are only REPORTED, never changed. Takes the db handle so the
// same code serves the server, the admin endpoint and scripts/audit-usernames.mjs.

const { usernameProblems } = require('../utils/username');

function auditUsernames(db) {
  const rows = db.prepare('SELECT id, username, is_active FROM users ORDER BY id').all();

  const invalid = [];
  const byLower = new Map();

  for (const row of rows) {
    const problems = usernameProblems(row.username);

    if (problems.length > 0) {
      invalid.push({ id: row.id, username: row.username, is_active: row.is_active, problems });
    }

    const key = String(row.username).toLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key).push({ id: row.id, username: row.username });
  }

  // Two accounts differing only by case: login resolves to the exact lowercase one
  // when it exists, otherwise to the lowest id; the other one needs an admin's attention.
  const caseCollisions = [...byLower.values()].filter((g) => g.length > 1);

  return {
    total: rows.length,
    invalid_count: invalid.length,
    invalid,
    case_collisions: caseCollisions,
  };
}

function logUsernameAuditWarning(db, log = console.warn) {
  const a = auditUsernames(db);

  if (a.invalid_count > 0 || a.case_collisions.length > 0) {
    log(
      `[usernames] ${a.invalid_count} existing account(s) do not meet the current username rules` +
      (a.case_collisions.length ? ` and ${a.case_collisions.length} name(s) collide when compared case-insensitively` : '') +
      '. They keep working and are not changed. Details: GET /api/admin/usernames/audit or `node scripts/audit-usernames.mjs`.'
    );
  }

  return a;
}

module.exports = { auditUsernames, logUsernameAuditWarning };
