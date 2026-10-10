// Read-only: lists stored usernames that break the rules for NEW accounts and
// names that collide case-insensitively. Changes nothing (the database is opened read-only).
//
//   node scripts/audit-usernames.mjs [path/to/data.db]     (default: $DB_PATH or ./data.db)

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const { auditUsernames } = require(path.join(ROOT, 'services', 'usernameAudit.service.js'));

const dbPath = path.resolve(process.argv[2] || process.env.DB_PATH || path.join(ROOT, 'data.db'));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
    const a = auditUsernames(db);
    console.log(`${dbPath}: ${a.total} account(s), ${a.invalid_count} not meeting the current rules, ${a.case_collisions.length} case collision(s)`);
    for (const u of a.invalid) console.log(`  id ${u.id}  ${JSON.stringify(u.username)}  ${u.problems.join(', ')}${u.is_active ? '' : '  (inactive)'}`);
    for (const g of a.case_collisions) console.log(`  COLLISION  ${g.map((x) => `${x.id}:${JSON.stringify(x.username)}`).join('  vs  ')}`);
} finally {
    db.close();
}
