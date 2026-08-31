const { getDb } = require('../config/database');


function getUserFolders(userId) {

  return getDb()
    .prepare(`
      SELECT
        f.id,
        f.path,
        f.display_name,
        uf.can_write
      FROM user_folders uf
      JOIN folders f
        ON f.id = uf.folder_id
      WHERE uf.user_id = ?
      ORDER BY f.display_name
    `)
    .all(userId);

}



function getFolderAccess(userId, folderId) {

  return getDb()
    .prepare(`
      SELECT
        user_id,
        folder_id,
        can_write
      FROM user_folders
      WHERE user_id = ?
      AND folder_id = ?
    `)
    .get(
      userId,
      folderId
    );

}



function grantPermission(
  userId,
  folderId,
  canWrite = false
) {

  return getDb()
    .prepare(`
      INSERT INTO user_folders
      (
        user_id,
        folder_id,
        can_write
      )
      VALUES (?, ?, ?)

      ON CONFLICT(user_id, folder_id)
      DO UPDATE SET
        can_write = excluded.can_write
    `)
    .run(
      userId,
      folderId,
      canWrite ? 1 : 0
    );

}



function revokePermission(
  userId,
  folderId
) {

  return getDb()
    .prepare(`
      DELETE FROM user_folders
      WHERE user_id = ?
      AND folder_id = ?
    `)
    .run(
      userId,
      folderId
    );

}



function getSharedCount(
  folderId,
  excludeUserId = -1
) {

  return getDb()
    .prepare(`
      SELECT COUNT(*) AS count
      FROM user_folders
      WHERE folder_id = ?
      AND user_id != ?
    `)
    .get(
      folderId,
      excludeUserId
    )
    .count;

}



function getFolderPermissions(
  folderId,
  excludeUserId = -1
) {

  return getDb()
    .prepare(`
      SELECT
        uf.user_id,
        uf.can_write,
        u.username
      FROM user_folders uf
      JOIN users u
        ON u.id = uf.user_id
      WHERE uf.folder_id = ?
      AND uf.user_id != ?
      ORDER BY u.username
    `)
    .all(
      folderId,
      excludeUserId
    );

}



function listAllPermissions() {

  return getDb()
    .prepare(`
      SELECT
        uf.user_id,
        uf.folder_id,
        uf.can_write,
        u.username,
        f.display_name
      FROM user_folders uf
      JOIN users u
        ON u.id = uf.user_id
      JOIN folders f
        ON f.id = uf.folder_id
      ORDER BY f.display_name, u.username
    `)
    .all();

}



module.exports = {
  getUserFolders,
  getFolderAccess,
  grantPermission,
  revokePermission,
  getSharedCount,
  getFolderPermissions,
  listAllPermissions,
};