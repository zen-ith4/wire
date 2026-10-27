const fs = require('fs');
const path = require('path');

const { getDb } = require('../config/database');
const { hashPassword } = require('../utils/password');
const {
  isValidPassword,
} = require('../utils/validator');
const { validateNewUsername } = require('../utils/username');
const { isEmailEnabled } = require('./email.service');
const {
  isValidAuthKey,
  isValidKdfSalt,
  isValidIterations,
} = require('../utils/credentials');
const constants = require('../config/constants');

// Same pattern registerUser() (auth.service.js) and the setup wizard
// use to accept an email address.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


function normalizeUsername(username) {
  return username.trim().toLowerCase();
}


// Intentionally selects only non-credential columns: this row is handed to
// callers that must never see password_hash, kdf_salt, token_version, etc.
function findUserByUsername(username) {
  username = normalizeUsername(username);

  return getDb()
    .prepare(`
      SELECT id, username, is_admin, is_active FROM users
      WHERE username = ? COLLATE NOCASE
      ORDER BY (username = ?) DESC, id
      LIMIT 1
    `)
    .get(username, username);
}


// Used to decide whether a user may RECEIVE new content. Deactivated accounts
// (is_active = 0) cannot log in, so they must not be sent messages either.
// Selects only id so is_active never leaks through profile endpoints.
function findActiveUserById(id) {
  return getDb()
    .prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
    .get(id);
}

function findUserById(id) {
  return getDb()
    .prepare(`
      SELECT 
        id,
        username,
        is_admin,
        bio,
        avatar_path,
        banner_path,
        accent_color,
        show_last_seen,
        last_seen_at,
        created_at
      FROM users
      WHERE id = ?
    `)
    .get(id);
}


function findUserWithPassword(id) {
  return getDb()
    .prepare(`
      SELECT
        id,
        username,
        password_hash,
        is_admin,
        auth_scheme,
        kdf_salt,
        kdf_iterations
      FROM users
      WHERE id = ?
    `)
    .get(id);
}


// ساخت ادمین
// فقط از admin controller استفاده شود
async function createAdmin(username, password) {

  username = normalizeUsername(username);

  const hash = await hashPassword(password);

  return getDb()
    .prepare(`
      INSERT INTO users
      (
        username,
        password_hash,
        is_admin,
        dm_e2ee_min_version
      )
      VALUES (?, ?, 1, ?)
    `)
    .run(
      username,
      hash,
      constants.DM_E2EE_DEFAULT_MIN_VERSION
    );
}


// Errors thrown by createUser() carry the same `code`s that
// registerUser() (auth.service.js) uses, so callers can map them to
// HTTP statuses the same way auth.controller.js does.
function createUserError(code, message) {

  const error = new Error(message);

  error.code = code;

  return error;
}


function requireString(value, label, code) {

  if (value === undefined || value === null) {
    throw createUserError(
      code,
      `${label} is required`
    );
  }

  if (typeof value !== 'string') {
    throw createUserError(
      code,
      `${label} must be a string`
    );
  }

  return value;
}


function findDuplicateUserError(db, username, email) {

  if (
    db.prepare(`
      SELECT id
      FROM users
      WHERE username = ? COLLATE NOCASE
      LIMIT 1
    `).get(username)
  ) {
    return createUserError(
      'USERNAME_EXISTS',
      'Username already exists'
    );
  }

  if (
    db.prepare(`
      SELECT id
      FROM users
      WHERE email = ?
      LIMIT 1
    `).get(email)
  ) {
    return createUserError(
      'EMAIL_EXISTS',
      'Email already exists'
    );
  }

  return null;
}


// Creates a user on behalf of an admin (POST /api/admin/users).
// Authorization is the caller's job (authenticate + adminOnly on the
// admin router). Unlike registerUser() this issues no JWT and sends
// no verification email — the account belongs to someone else.
//
// Resolves to the created user's safe fields (never password_hash).
// F12: the admin's browser derives the NEW account's credentials from the
// temporary password it was given (fresh salt, PBKDF2+HKDF) and sends only
//   creds = { authKey, kdfSalt, kdfIterations }
// so the server never sees the temporary password. The account is created on
// scheme 2 with must_change_password = 1: the first login yields only the
// restricted password-change token until the user picks their own password.
async function createUser(username, email, creds, isAdmin) {

  const db = getDb();

  username = normalizeUsername(
    requireString(
      username,
      'Username',
      'INVALID_USERNAME'
    )
  );

  if (!username) {
    throw createUserError(
      'INVALID_USERNAME',
      'Username is required'
    );
  }

  // trim + lowercase (done above) and then the rules for new accounts
  const usernameCheck =
    validateNewUsername(username);

  if (!usernameCheck.ok) {
    throw createUserError(
      'INVALID_USERNAME',
      usernameCheck.message
    );
  }

  username = usernameCheck.username;

  email = requireString(
    email,
    'Email',
    'INVALID_EMAIL'
  )
    .trim()
    .toLowerCase();

  if (!email) {
    throw createUserError(
      'INVALID_EMAIL',
      'Email is required'
    );
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw createUserError(
      'INVALID_EMAIL',
      'Invalid email address'
    );
  }

  if (
    !creds ||
    typeof creds !== 'object' ||
    !isValidAuthKey(creds.authKey) ||
    !isValidKdfSalt(creds.kdfSalt) ||
    !isValidIterations(creds.kdfIterations)
  ) {
    throw createUserError(
      'INVALID_CREDENTIALS',
      'Invalid credentials'
    );
  }

  // Strictly a boolean: "true", 1, null, undefined, etc. are rejected
  // so a malformed caller can never grant admin rights by accident.
  if (typeof isAdmin !== 'boolean') {
    throw createUserError(
      'INVALID_IS_ADMIN',
      'is_admin must be a boolean'
    );
  }


  // Cheap duplicate check first, so an obvious duplicate doesn't pay
  // for a bcrypt hash.
  const duplicate =
    findDuplicateUserError(
      db,
      username,
      email
    );

  if (duplicate) {
    throw duplicate;
  }


  const passwordHash =
    await hashPassword(creds.authKey);

  // Same rule as registerUser(): with the email subsystem disabled
  // nothing could ever verify the address, so the account counts as
  // verified; otherwise the user verifies at first login.
  const emailVerified =
    isEmailEnabled() ? 0 : 1;

  let userId;

  try {

    const result = db.prepare(`
      INSERT INTO users (
        username,
        email,
        password_hash,
        email_verified,
        is_admin,
        auth_scheme,
        kdf_salt,
        kdf_iterations,
        must_change_password,
        dm_e2ee_min_version
      )
      VALUES (?, ?, ?, ?, ?, 2, ?, ?, 1, ?)
    `).run(
      username,
      email,
      passwordHash,
      emailVerified,
      isAdmin ? 1 : 0,
      creds.kdfSalt,
      creds.kdfIterations,
      constants.DM_E2EE_DEFAULT_MIN_VERSION
    );

    userId =
      Number(result.lastInsertRowid);

  } catch (error) {

    // hashPassword() yields to the event loop, so a concurrent request
    // can win the race after the check above; the UNIQUE constraints
    // are the real guarantee.
    if (
      error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      error.code === 'SQLITE_CONSTRAINT'
    ) {

      const duplicateError =
        findDuplicateUserError(
          db,
          username,
          email
        );

      if (duplicateError) {
        throw duplicateError;
      }
    }

    throw error;
  }


  const user = db.prepare(`
    SELECT
      id,
      username,
      email,
      email_verified,
      is_admin,
      created_at
    FROM users
    WHERE id = ?
  `).get(userId);

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: Boolean(user.email_verified),
    is_admin: Boolean(user.is_admin),
    created_at: user.created_at,
    must_change_password: true,
  };
}


// Changes ONLY the is_admin flag of one user. Callers are responsible
// for authorization and for validating that isAdmin is a boolean.
function setUserAdmin(userId, isAdmin) {

  return getDb()
    .prepare(`
      UPDATE users
      SET is_admin = ?
      WHERE id = ?
    `)
    .run(
      isAdmin ? 1 : 0,
      userId
    );
}


function updateBio(userId, bio) {

  bio = bio
    ? bio.trim().slice(0, 500)
    : '';

  return getDb()
    .prepare(`
      UPDATE users
      SET bio = ?
      WHERE id = ?
    `)
    .run(
      bio,
      userId
    );
}


function updateAccentColor(userId, accentColor) {

  return getDb()
    .prepare(`
      UPDATE users
      SET accent_color = ?
      WHERE id = ?
    `)
    .run(
      accentColor,
      userId
    );
}


// ============================================================
// Presence & read-receipt privacy
//
// show_last_seen / send_read_receipts are independent booleans (see
// migrations.js). All reads below default to `true` when the row is
// somehow missing (e.g. a race with account deletion) rather than
// silently leaking nothing or throwing mid-request.
// ============================================================

function getPrivacySettings(userId) {
  const row = getDb()
    .prepare(`
      SELECT show_last_seen, send_read_receipts
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!row) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  return {
    show_last_seen: row.show_last_seen !== 0,
    send_read_receipts: row.send_read_receipts !== 0,
  };
}


function updatePrivacySettings(userId, { show_last_seen, send_read_receipts } = {}) {
  const current = getPrivacySettings(userId);

  const next = {
    show_last_seen:
      typeof show_last_seen === 'boolean'
        ? show_last_seen
        : current.show_last_seen,
    send_read_receipts:
      typeof send_read_receipts === 'boolean'
        ? send_read_receipts
        : current.send_read_receipts,
  };

  getDb()
    .prepare(`
      UPDATE users
      SET show_last_seen = ?, send_read_receipts = ?
      WHERE id = ?
    `)
    .run(
      next.show_last_seen ? 1 : 0,
      next.send_read_receipts ? 1 : 0,
      userId
    );

  return next;
}


function isShowLastSeenEnabled(userId) {
  const row = getDb()
    .prepare('SELECT show_last_seen FROM users WHERE id = ?')
    .get(userId);

  return !row || row.show_last_seen !== 0;
}


function isSendReadReceiptsEnabled(userId) {
  const row = getDb()
    .prepare('SELECT send_read_receipts FROM users WHERE id = ?')
    .get(userId);

  return !row || row.send_read_receipts !== 0;
}


// Given a list of currently-online user ids, returns only the ones
// who allow their presence to be seen — used to build the
// 'presence:snapshot' a newly-connected socket receives (see
// config/socket.js). Keeps the "never leak through an alternative
// event/endpoint" rule in one place instead of re-checking per id.
function filterVisiblePresenceIds(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }

  const placeholders = userIds.map(() => '?').join(',');

  return getDb()
    .prepare(`
      SELECT id FROM users
      WHERE id IN (${placeholders}) AND show_last_seen != 0
    `)
    .all(...userIds)
    .map(row => row.id);
}


// Called once a user's *last* socket disconnects (see
// services/presence.service.js's markOffline / config/socket.js).
// Always recorded regardless of the privacy setting — hiding it from
// other users happens at read time (getLastSeenIfVisible below), not
// by refusing to store it, so re-enabling the setting later shows an
// accurate value immediately instead of "never".
function recordLastSeen(userId) {
  const now = new Date().toISOString();

  getDb()
    .prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
    .run(now, userId);

  return now;
}


// The one place that decides whether `viewerId` may see `userId`'s
// last-seen timestamp: always visible to the user themselves, only
// visible to anyone else when show_last_seen is enabled.
function getLastSeenIfVisible(userId, viewerId) {
  const row = getDb()
    .prepare('SELECT last_seen_at, show_last_seen FROM users WHERE id = ?')
    .get(userId);

  if (!row) return null;
  if (Number(userId) === Number(viewerId)) return row.last_seen_at || null;
  if (row.show_last_seen === 0) return null;

  return row.last_seen_at || null;
}


function updateAvatar(userId, avatarPath) {

  return getDb()
    .prepare(`
      UPDATE users
      SET avatar_path = ?
      WHERE id = ?
    `)
    .run(
      avatarPath,
      userId
    );
}


function updateBanner(userId, bannerPath) {

  return getDb()
    .prepare(`
      UPDATE users
      SET banner_path = ?
      WHERE id = ?
    `)
    .run(
      bannerPath,
      userId
    );
}


// Sums attachment_size across chat + DM messages this user has sent.
function getStorageUsage(userId) {

  const chatTotal = getDb()
    .prepare(`
      SELECT COALESCE(SUM(attachment_size), 0) AS total
      FROM messages
      WHERE user_id = ? AND attachment_path IS NOT NULL
    `)
    .get(userId).total;

  const dmTotal = getDb()
    .prepare(`
      SELECT COALESCE(SUM(attachment_size), 0) AS total
      FROM direct_messages
      WHERE sender_id = ? AND attachment_path IS NOT NULL
    `)
    .get(userId).total;

  return chatTotal + dmTotal;
}


async function updatePassword(userId, newPassword) {

  const hash = await hashPassword(newPassword);

  return getDb()
    .prepare(`
      UPDATE users
      SET password_hash = ?,
          token_version = token_version + 1
      WHERE id = ?
    `)
    .run(
      hash,
      userId
    );
}


/*
 * Change the account password and re-encrypt the
 * existing E2EE identity atomically.
 *
 * The browser decrypts the existing private key and
 * re-encrypts it with the new password before calling
 * this function.
 *
 * The server only receives:
 *
 *   encryptedPrivateKey
 *   kdf
 *   kdfParams
 *   salt
 *   iv
 *   version
 *
 * The plaintext private key never reaches the server.
 *
 * IMPORTANT:
 * The existing public key is deliberately NOT updated.
 * Password changes must never create or replace an
 * E2EE identity.
 */
// F12: change of the account credentials (scheme 2 only). The new authKey is
// bcrypt'd, the account salt is replaced by a FRESH one, and the identity is
// re-wrapped in the browser under the new wrap key. Password and identity are
// committed in one transaction; the public key is never part of the update.
// Compare-and-set on the old hash makes two concurrent changes mutually
// exclusive instead of last-writer-wins.
async function changeCredentialsV2(
  userId,
  {
    currentHash,
    newAuthKey,
    kdfSalt,
    kdfIterations,
    identity
  }
) {

  const db = getDb();

  const hash =
    await hashPassword(
      newAuthKey
    );

  const transaction =
    db.transaction(() => {

      const r =
        db.prepare(`
          UPDATE users
          SET
            password_hash = ?,
            kdf_salt = ?,
            kdf_iterations = ?,
            must_change_password = 0,
            token_version = token_version + 1
          WHERE id = ?
            AND auth_scheme = 2
            AND password_hash = ?
        `).run(
          hash,
          kdfSalt,
          kdfIterations,
          userId,
          currentHash
        );

      if (r.changes !== 1) {
        return { ok: false, reason: 'conflict' };
      }

      // Every session token minted before this change is now revoked
      // (see users.token_version). The caller gets the new value so it can
      // hand the current device a fresh token.
      const { token_version: tokenVersion } =
        db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId);

      if (!identity) {
        return { ok: true, tokenVersion };
      }

      const i =
        db.prepare(`
          UPDATE identity_keys
          SET
            encrypted_private_key = ?,
            kdf = ?,
            kdf_params = ?,
            salt = ?,
            iv = ?,
            version = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).run(
          identity.encryptedPrivateKey,
          identity.kdf,
          JSON.stringify(
            identity.kdfParams
          ),
          identity.salt,
          identity.iv,
          identity.version,
          userId
        );

      if (i.changes !== 1) {
        // rolls the password change back as well
        throw new Error(
          'Failed to update identity encryption'
        );
      }

      return { ok: true, tokenVersion };
    });

  return transaction();
}


// Best-effort disk cleanup helper — mirrors the fire-and-forget
// fs.unlink(path, err => {...}) pattern already used elsewhere in
// this codebase (e.g. me.controller.js's old-avatar/banner cleanup)
// for exactly the same reason: a missing/already-gone file, or a
// permissions hiccup, shouldn't fail the request that triggered it.
function unlinkQuietly(filePath) {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(
        'Failed to remove file during user deletion:',
        filePath,
        err.message
      );
    }
  });
}


// Deleting a user cascades (ON DELETE CASCADE, see database/schema)
// to remove their row in `messages`/`direct_messages`/etc., but a
// DB cascade only ever removes *rows* — it has no idea their
// avatar_path/banner_path/attachment_path columns pointed at real
// files on disk in AVATAR_DIR/BANNER_DIR/CHAT_UPLOAD_DIR/
// DM_UPLOAD_DIR. Without collecting and removing those first, every
// deleted user permanently orphans their avatar, banner, and every
// attachment they ever posted to Chat or a DM — the DB record of
// them is gone, but the files themselves sit on disk forever with
// nothing left to reference or clean them up.
//
// The paths have to be read out *before* the DELETE below runs —
// once it does, the cascade removes the very rows that told us
// where those files were.
function collectUserOwnedFiles(userId) {
  const db = getDb();

  const user = db
    .prepare(
      'SELECT avatar_path, banner_path FROM users WHERE id = ?'
    )
    .get(userId);

  const chatAttachments = db
    .prepare(`
      SELECT attachment_path FROM messages
      WHERE user_id = ? AND attachment_path IS NOT NULL
    `)
    .all(userId);

  const dmAttachments = db
    .prepare(`
      SELECT attachment_path FROM direct_messages
      WHERE sender_id = ? AND attachment_path IS NOT NULL
    `)
    .all(userId);

  const files = [];

  if (user && user.avatar_path) {
    files.push(
      path.join(
        constants.AVATAR_DIR,
        user.avatar_path
      )
    );
  }

  if (user && user.banner_path) {
    files.push(
      path.join(
        constants.BANNER_DIR,
        user.banner_path
      )
    );
  }

  for (const row of chatAttachments) {
    files.push(
      path.join(
        constants.CHAT_UPLOAD_DIR,
        row.attachment_path
      )
    );
  }

  for (const row of dmAttachments) {
    files.push(
      path.join(
        constants.DM_UPLOAD_DIR,
        row.attachment_path
      )
    );
  }

  return files;
}


function deleteUser(userId) {

  // Read out every file this user owns before the cascade delete
  // below removes the rows that record where they are.
  const filesToRemove =
    collectUserOwnedFiles(
      userId
    );

  const result =
    getDb()
      .prepare(`
        DELETE FROM users
        WHERE id = ?
      `)
      .run(userId);

  // Only clean up files once the row (and its cascade) actually
  // went through — if the DELETE affected nothing (e.g. a
  // already-deleted/nonexistent id slipped through), there's nothing
  // to remove and no cascade to have orphaned anything.
  if (result.changes > 0) {
    filesToRemove.forEach(
      unlinkQuietly
    );
  }

  return result;
}


function listUsers() {

  return getDb()
    .prepare(`
      SELECT
        id,
        username,
        email,
        is_admin,
        auth_scheme,
        must_change_password,
        legacy_login_closed,
        legacy_last_login_at
      FROM users
      ORDER BY username
    `)
    .all();
}


function listUsersExcept(userId) {

  return getDb()
    .prepare(`
      SELECT
        id,
        username
      FROM users
      WHERE id != ?
      ORDER BY username
    `)
    .all(userId);
}


module.exports = {
  findUserByUsername,
  findUserById,
  findActiveUserById,
  findUserWithPassword,

  createAdmin,
  createUser,

  setUserAdmin,
  updateBio,
  updateAccentColor,

  getPrivacySettings,
  updatePrivacySettings,
  isShowLastSeenEnabled,
  isSendReadReceiptsEnabled,
  filterVisiblePresenceIds,
  recordLastSeen,
  getLastSeenIfVisible,

  updateAvatar,
  updateBanner,
  updatePassword,
  changeCredentialsV2,

  getStorageUsage,

  deleteUser,

  listUsers,
  listUsersExcept
};