const fs = require('fs');
const path = require('path');
const constants = require('../config/constants');


function createUserDrive(db, user) {

  const existing = db.prepare(`
    SELECT id
    FROM folders
    WHERE owner_id = ?
  `).get(user.id);


  if (existing) {
    return existing.id;
  }


  const userDataRoot = path.join(
    constants.USER_DATA_ROOT,
    String(user.id)
  );


  const driveDir = path.join(
    userDataRoot,
    'Drive'
  );


  fs.mkdirSync(driveDir, {
    recursive: true
  });


  const info = db.prepare(`
    INSERT INTO folders
    (
      path,
      display_name,
      owner_id
    )
    VALUES (?, ?, ?)
  `).run(
    driveDir,
    `${user.username} Drive`,
    user.id
  );


  db.prepare(`
    INSERT INTO user_folders
    (
      user_id,
      folder_id,
      can_write
    )
    VALUES (?, ?, 1)
  `).run(
    user.id,
    info.lastInsertRowid
  );


  return info.lastInsertRowid;
}



function createMissingDrives(db) {

  const users = db.prepare(`
    SELECT id, username
    FROM users
    WHERE NOT EXISTS (
      SELECT 1
      FROM folders
      WHERE folders.owner_id = users.id
    )
  `).all();


  users.forEach(user => {
    createUserDrive(db, user);
  });


  return users.length;
}



module.exports = {
  createUserDrive,
  createMissingDrives
};