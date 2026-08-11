const { getDb } = require('../config/database');
const { hashPassword } = require('../utils/password');

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
function createUser(username, password, isAdmin = false) {

  username = normalizeUsername(username);

  const hash = hashPassword(password);

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
function createAdmin(username, password) {

  username = normalizeUsername(username);

  const hash = hashPassword(password);

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
// Reuses columns that already exist for the download/preview
// features — no new tables, no new tracking needed.
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


function updatePassword(userId, newPassword) {

  const hash = hashPassword(newPassword);

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


function deleteUser(userId) {

  return getDb()
    .prepare(`
      DELETE FROM users
      WHERE id = ?
    `)
    .run(userId);
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
  updateAvatar,
  updateBanner,
  updatePassword,

  getStorageUsage,

  deleteUser,

  listUsers,
  listUsersExcept
};