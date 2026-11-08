#!/usr/bin/env node
// Server-side admin commands (recovery and setup). Run on the server shell,
// with the same .env and DB as the app:
//
//   npm run admin -- list-users
//   npm run admin -- set-admin <username>          (recovery: no login needed)
//   npm run admin -- create-user <username> --email <email>
//   npm run admin -- delete-user <username>
//   npm run admin -- add-folder <path> [--name <display name>]
//
// Anyone who can run this already controls the server, so these commands
// take no web password. Every change is recorded in admin_audit_log with
// admin_id = NULL and details.source = "cli".
//
// The CLI calls the same service functions as the API. It contains no SQL
// of its own, and it never prints password hashes.

import { createRequire } from 'node:module';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import path from 'node:path';

const require = createRequire(import.meta.url);

require('dotenv').config({ path: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.env') });

const { initDatabase, getDb } = require('../config/database');
const { KDF_ITERATIONS, newKdfSalt, deriveCredentialsNode } = require('../utils/credentials');
const { hashPassword } = require('../utils/password');
const { validateNewFolderPath } = require('../utils/folderPolicy');
const { recordAdminAction } = require('../services/adminAudit.service');
const userService = require('../services/user.service');
const fileService = require('../services/file.service');

const MIN_PASSWORD_LENGTH = 12;
const CLI_SOURCE = { source: 'cli' };

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// One shared line reader for all prompts. Works in a terminal (input is not
// echoed) and with piped input. Lines that arrive before they are asked for
// are queued, so two prompts can be answered from one pipe. If input ends
// before an answer, the prompt resolves to '' (and the caller fails).
const lineQueue = [];
const lineWaiters = [];
let inputRl = null;
let inputEnded = false;

function ensureInput() {
  if (inputRl) return;

  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  inputRl = readline.createInterface({
    input: process.stdin,
    output: process.stdin.isTTY ? muted : undefined,
    terminal: !!process.stdin.isTTY,
  });

  inputRl.on('line', (line) => {
    if (lineWaiters.length) lineWaiters.shift()(line);
    else lineQueue.push(line);
  });

  inputRl.on('close', () => {
    inputEnded = true;
    while (lineWaiters.length) lineWaiters.shift()('');
  });
}

function askHidden(question) {
  ensureInput();
  process.stdout.write(question);

  return new Promise((resolve) => {
    const done = (value) => {
      process.stdout.write('\n');
      resolve(value);
    };

    if (lineQueue.length) done(lineQueue.shift());
    else if (inputEnded) done('');
    else lineWaiters.push(done);
  });
}

function closeInput() {
  if (inputRl) inputRl.close();
  inputRl = null;
}

function findUserByName(username) {
  const user = userService.findUserByUsername(username);
  if (!user) fail(`No user named "${username}".`);
  return user;
}

function currentAdmin() {
  return getDb()
    .prepare('SELECT id, username FROM users WHERE is_admin = 1')
    .get() || null;
}

function cmdListUsers() {
  const rows = getDb()
    .prepare(`
      SELECT id, username, email, is_admin, is_active, auth_scheme, created_at
      FROM users
      ORDER BY id
    `)
    .all();

  console.log('id\tusername\temail\tadmin\tactive\tscheme\tcreated_at');
  for (const r of rows) {
    console.log([
      r.id,
      r.username,
      r.email || '-',
      r.is_admin ? 'yes' : 'no',
      r.is_active ? 'yes' : 'no',
      r.auth_scheme,
      r.created_at,
    ].join('\t'));
  }
}

function cmdSetAdmin(username) {
  const target = findUserByName(username);

  if (!target.is_active) {
    fail(`"${target.username}" is inactive. Activate the account first.`);
  }

  const previous = currentAdmin();

  if (previous && previous.id === target.id) {
    console.log(`"${target.username}" is already the admin. Nothing changed.`);
    return;
  }

  getDb().transaction(() => {
    if (previous) {
      userService.transferAdmin(previous.id, target.id);
    } else {
      // No admin at all (for example after a manual DB edit): just promote.
      getDb()
        .prepare('UPDATE users SET is_admin = 1 WHERE id = ? AND is_active = 1')
        .run(target.id);
    }

    recordAdminAction({
      adminId: null,
      action: 'transfer_admin',
      targetType: 'user',
      targetId: target.id,
      details: { ...CLI_SOURCE, from: previous ? previous.username : null, to: target.username },
    });
  })();

  console.log(previous
    ? `Admin role moved from "${previous.username}" (now a normal user) to "${target.username}".`
    : `"${target.username}" is now the admin.`);
}

async function cmdCreateUser(username, email) {
  if (!email) fail('create-user needs --email <address>.');

  const password = await askHidden('Temporary password: ');
  const confirm = await askHidden('Repeat temporary password: ');
  closeInput();

  if (!password || !confirm) fail('Input ended before the password was entered twice.');
  if (password !== confirm) fail('Passwords do not match.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // Same derivation the browser does for normal accounts (PBKDF2 + HKDF), so
  // the new account logs in like any other. It must change the password first.
  const kdfSalt = newKdfSalt();
  const { authKey } = deriveCredentialsNode(password, kdfSalt, KDF_ITERATIONS);

  try {
    const user = await userService.createUser(
      username,
      email,
      { authKey, kdfSalt, kdfIterations: KDF_ITERATIONS },
      false
    );

    recordAdminAction({
      adminId: null,
      action: 'create_user',
      targetType: 'user',
      targetId: user.id,
      details: { ...CLI_SOURCE, username: user.username },
    });

    console.log(`Created user "${user.username}" (id ${user.id}). They must change the password at first login.`);
  } catch (err) {
    fail(err.message);
  }
}

function cmdDeleteUser(username) {
  const target = findUserByName(username);

  if (target.is_admin) {
    fail(`"${target.username}" is the admin. Run "set-admin <another user>" first.`);
  }

  const { groupChanges } = getDb().transaction(() => {
    const result = userService.deleteUser(target.id);
    recordAdminAction({
      adminId: null,
      action: 'delete_user',
      targetType: 'user',
      targetId: target.id,
      details: {
        ...CLI_SOURCE,
        username: target.username,
        groups_changed: result.groupChanges.map(g => ({
          group_id: g.groupId,
          group_deleted: g.groupDeleted,
          successor_id: g.successorId,
        })),
      },
    });
    return result;
  })();

  console.log(`Deleted "${target.username}".${groupChanges.length ? ` Changed ${groupChanges.length} group(s).` : ''}`);
}

function cmdAddFolder(folderPath, displayName) {
  const checked = validateNewFolderPath(folderPath);
  if (!checked.ok) fail(checked.message);

  const name = displayName || path.basename(checked.realPath);

  try {
    getDb().transaction(() => {
      const info = fileService.createFolder(checked.realPath, name, null);
      recordAdminAction({
        adminId: null,
        action: 'create_folder',
        targetType: 'folder',
        targetId: Number(info.lastInsertRowid),
        details: { ...CLI_SOURCE, path: checked.realPath, display_name: name },
      });
    })();
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      fail('That folder is already shared.');
    }
    throw err;
  }

  console.log(`Shared "${checked.realPath}" as "${name}".`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, arg] = positional;

  if (!command || command === 'help') {
    console.log(`Usage: npm run admin -- <command>

  list-users
  set-admin <username>
  create-user <username> --email <address>
  delete-user <username>
  add-folder <path> [--name <display name>]`);
    return;
  }

  initDatabase();

  switch (command) {
    case 'list-users':
      return cmdListUsers();
    case 'set-admin':
      if (!arg) fail('set-admin needs a username.');
      return cmdSetAdmin(arg);
    case 'create-user':
      if (!arg) fail('create-user needs a username.');
      return cmdCreateUser(arg, flags.email);
    case 'delete-user':
      if (!arg) fail('delete-user needs a username.');
      return cmdDeleteUser(arg);
    case 'add-folder':
      if (!arg) fail('add-folder needs a path.');
      return cmdAddFolder(arg, typeof flags.name === 'string' ? flags.name : null);
    default:
      fail(`Unknown command "${command}". Run "npm run admin -- help".`);
  }
}

main().catch((err) => fail(err.message || String(err)));
