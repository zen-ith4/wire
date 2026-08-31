const { getDb } = require('../config/database');


function findFolderById(id) {
  return getDb()
    .prepare(
      'SELECT * FROM folders WHERE id = ?'
    )
    .get(id);
}


function findFolderByPath(folderPath) {
  return getDb()
    .prepare(
      'SELECT * FROM folders WHERE path = ?'
    )
    .get(folderPath);
}


function createFolder(folderPath, displayName, ownerId = null) {

  return getDb()
    .prepare(`
      INSERT INTO folders
      (
        path,
        display_name,
        owner_id
      )
      VALUES (?, ?, ?)
    `)
    .run(
      folderPath,
      displayName,
      ownerId
    );
}


function deleteFolder(id) {

  return getDb()
    .prepare(
      'DELETE FROM folders WHERE id = ?'
    )
    .run(id);

}


function listAllFolders() {

  return getDb()
    .prepare(`
      SELECT
        id,
        path,
        display_name,
        owner_id
      FROM folders
      ORDER BY display_name
    `)
    .all();

}


function listOwnedFolders(userId) {

  return getDb()
    .prepare(`
      SELECT
        id,
        path,
        display_name
      FROM folders
      WHERE owner_id = ?
      ORDER BY display_name
    `)
    .all(userId);

}


module.exports = {
  findFolderById,
  findFolderByPath,
  createFolder,
  deleteFolder,
  listAllFolders,
  listOwnedFolders,
};