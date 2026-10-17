// scripts/dm-e2ee-optin.mjs
//
// Opt accounts in to DM envelope v2 by raising users.dm_e2ee_min_version from 1
// to 2 (docs/e2ee-dm-hardening.md section 5.1). The sender reads this value as
// the peer's floor: a peer at 2 gets v2, a peer at 1 keeps receiving exactly the
// v1 envelope it gets today.
//
//   node scripts/dm-e2ee-optin.mjs alice bob         raise both to 2
//   node scripts/dm-e2ee-optin.mjs --dry-run 12alice see what would change
//   node scripts/dm-e2ee-optin.mjs --db path/to.db alice
//
// WHY THIS IS A SCRIPT AND NOT AN ADMIN ENDPOINT
// Turning encryption up is not something a web request should be able to do: it
// needs filesystem access to the SQLite file, which is the admin boundary in
// this codebase. Whoever can read the DB file can already read every ciphertext
// and every password hash in it, so this grants nothing they did not have - but
// it does mean the switch is deliberately OFFLINE, auditable, and impossible to
// reach from a browser.
//
// THIS ONLY RAISES. There is deliberately no "lower" option: once an account is
// at 2 its users must keep receiving v2, and an operator who needs it back should
// stop upgrading rather than be able to walk every conversation backwards. STEP
// 1C turns the column into a hard ratchet enforced by SQLite triggers, so
// anything this script could later have to remove is better absent now.
//
// IDEMPOTENT. Running it twice changes nothing the second time and reports
// "changed 0 of M rows".

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { dryRun: false, dbPath: null, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--db') out.dbPath = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else out.targets.push(arg);
  }
  return out;
}

function usage() {
  console.log(
    'Usage: node scripts/dm-e2ee-optin.mjs [--dry-run] [--db <path>] <username|id>...\n' +
    '  Raises users.dm_e2ee_min_version to 2 for each named account. Never lowers.'
  );
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { usage(); process.exit(0); }

if (!opts.targets.length) {
  console.error('dm-e2ee-optin: give at least one username or user id.');
  usage();
  process.exit(2);
}

const dbPath = path.resolve(opts.dbPath || process.env.DB_PATH || path.join(ROOT, 'data.db'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

let db;
try {
  db = new Database(dbPath, { fileMustExist: true });
} catch (e) {
  console.error(`dm-e2ee-optin: cannot open ${dbPath}: ${e.message}`);
  process.exit(1);
}

try {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('dm_e2ee_min_version')) {
    console.error(
      `dm-e2ee-optin: ${dbPath} has no users.dm_e2ee_min_version column.\n` +
      '  Start the server once so database/migrations.js adds it, then re-run.'
    );
    process.exit(1);
  }

  const findById = db.prepare('SELECT id, username, dm_e2ee_min_version FROM users WHERE id = ?');
  const findByName = db.prepare('SELECT id, username, dm_e2ee_min_version FROM users WHERE username = ?');
  // The ONLY statement this script issues. `dm_e2ee_min_version < 2` is what makes
  // it idempotent and what makes lowering impossible.
  const raise = db.prepare('UPDATE users SET dm_e2ee_min_version = 2 WHERE id = ? AND dm_e2ee_min_version < 2');

  const rows = [];
  const unresolved = [];
  for (const target of opts.targets) {
    const asId = /^\d+$/.test(target) ? Number(target) : null;
    const row = asId !== null ? findById.get(asId) : findByName.get(target);
    if (!row) unresolved.push(target);
    else rows.push(row);
  }

  if (unresolved.length) {
    console.error(`dm-e2ee-optin: no such account: ${unresolved.join(', ')}`);
    process.exitCode = 1;
  }

  let changed = 0;
  for (const row of rows) {
    if (Number(row.dm_e2ee_min_version) >= 2) {
      console.log(`  ${row.username} (id ${row.id}): already at ${row.dm_e2ee_min_version}, unchanged`);
      continue;
    }
    if (opts.dryRun) {
      console.log(`  ${row.username} (id ${row.id}): would go ${row.dm_e2ee_min_version} -> 2`);
      changed++;
      continue;
    }
    const result = raise.run(row.id);
    if (result.changes === 1) {
      console.log(`  ${row.username} (id ${row.id}): ${row.dm_e2ee_min_version} -> 2`);
      changed++;
    } else {
      console.log(`  ${row.username} (id ${row.id}): unchanged`);
    }
  }

  const verb = opts.dryRun ? 'would change' : 'changed';
  console.log(`${opts.dryRun ? '[dry-run] ' : ''}${verb} ${changed} of ${rows.length} rows`);
  if (unresolved.length) process.exitCode = 1;
} finally {
  db.close();
}