const fs = require('fs');
const path = require('path');

const { getDb } = require('../config/database');
const { hashPassword } = require('../utils/password');
const constants = require('../config/constants');


function normalizeUsername(username) {
  return username.trim().toLowerCase();
}


function findUserByUsername(username) {
  username = normalizeUsername(username);

  return getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);
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
        is_admin
      FROM users
      WHERE id = ?
    `)
    .get(id);
}


// ساخت کاربر معمولی (یا ادمین، اگر isAdmin=true باشد)
async function createUser(username, password, isAdmin = false) {

  username = normalizeUsername(username);

  const hash = await hashPassword(password);

  return getDb()
    .prepare(`
      INSERT INTO users
      (
        username,
        password_hash,
        is_admin
      )
      VALUES (?, ?, ?)
    `)
    .run(
      username,
      hash,
      isAdmin ? 1 : 0
    );
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
        is_admin
      )
      VALUES (?, ?, 1)
    `)
    .run(
      username,
      hash
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
      SET password_hash = ?
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
async function changePasswordWithIdentity(
  userId,
  newPassword,
  identity
) {

  const db = getDb();

  const hash =
    await hashPassword(
      newPassword
    );


  const transaction =
    db.transaction(() => {

      /*
       * Update the normal account password.
       */
      const passwordResult =
        db.prepare(`
          UPDATE users
          SET password_hash = ?
          WHERE id = ?
        `).run(
          hash,
          userId
        );


      if (passwordResult.changes !== 1) {
        throw new Error(
          'Failed to update password'
        );
      }


      /*
       * If there is no identity payload,
       * only change the account password.
       *
       * This keeps password changing possible
       * for accounts that do not have an identity
       * key yet.
       */
      if (!identity) {
        return;
      }


      /*
       * Update ONLY the encrypted identity data.
       *
       * public_key is intentionally absent here.
       *
       * Therefore:
       *
       *     old public key === new public key
       *
       * and the X25519 identity itself never changes.
       */
      const identityResult =
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


      if (identityResult.changes !== 1) {
        throw new Error(
          'Failed to update identity encryption'
        );
      }
    });


  /*
   * better-sqlite3 transactions are synchronous,
   * so the callback itself is synchronous.
   *
   * The password hash was already generated
   * before entering the transaction.
   */
  transaction();


  return {
    success: true
  };
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
        is_admin
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
  findUserWithPassword,

  createUser,
  createAdmin,

  updateBio,
  updateAccentColor,
  updateAvatar,
  updateBanner,
  updatePassword,
  changePasswordWithIdentity,

  getStorageUsage,

  deleteUser,

  listUsers,
  listUsersExcept
};