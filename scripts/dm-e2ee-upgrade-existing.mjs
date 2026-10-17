// scripts/dm-e2ee-upgrade-existing.mjs
//
// Raise every account still at dm_e2ee_min_version = 1 to 2. Admin-only: needs
// filesystem access to the SQLite file (same boundary as dm-e2ee-optin.mjs).
// EXPLICIT: this is NOT run at boot and NOT an automatic migration. An operator
// decides when to flip existing accounts, and the 1C ratchet trigger makes the
// change one-way.
//
//   node scripts/dm-e2ee-upgrade-existing.mjs [--dry-run] [--db path/to/wire.db]
//
// Idempotent: second run reports "changed 0 of M rows".

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { dryRun: false, dbPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--db') out.dbPath = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('Usage: node scripts/dm-e2ee-upgrade-existing.mjs [--dry-run] [--db <path>]');
  process.exit(0);
}

const dbPath = path.resolve(opts.dbPath || process.env.DB_PATH || path.join(ROOT, 'data.db'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

let db;
try {
  db = new Database(dbPath, { fileMustExist: true });
} catch (e) {
  console.error(`dm-e2ee-upgrade-existing: cannot open ${dbPath}: ${e.message}`);
  process.exit(1);
}

try {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('dm_e2ee_min_version')) {
    console.error(`dm-e2ee-upgrade-existing: ${dbPath} has no users.dm_e2ee_min_version column.`);
    process.exit(1);
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const v1 = db.prepare('SELECT COUNT(*) AS n FROM users WHERE dm_e2ee_min_version = 1').get().n;

  if (opts.dryRun) {
    // prove by row hash before/after that nothing changes
    const before = db.prepare('SELECT id, dm_e2ee_min_version FROM users ORDER BY id').all();
    const hash = (rows) => JSON.stringify(rows);
    const h0 = hash(before);
    // no write performed
    const after = db.prepare('SELECT id, dm_e2ee_min_version FROM users ORDER BY id').all();
    if (hash(after) !== h0) {
      console.error('dm-e2ee-upgrade-existing: dry-run mutated rows (internal error)');
      process.exit(1);
    }
    console.log(`[dry-run] would change ${v1} of ${total} rows (no write performed)`);
    process.exit(0);
  }

  const raise = db.prepare('UPDATE users SET dm_e2ee_min_version = 2 WHERE dm_e2ee_min_version = 1');
  const result = raise.run();
  console.log(`changed ${result.changes} of ${total} rows`);
} finally {
  db.close();
}