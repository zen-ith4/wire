const { getDb } = require('../config/database');

// نکته: جدول wireguard_peers ستونی به نام "username" ندارد؛
// رابطه با کاربر از طریق ستون user_id (FK به users.id) برقرار می‌شود.
// این سرویس همیشه با JOIN به جدول users، یوزرنیم را برمی‌گرداند.

function getMappedPeer(publicKey) {

  const db = getDb();

  return db.prepare(`
    SELECT
      wp.public_key,
      wp.user_id,
      u.username
    FROM wireguard_peers wp
    JOIN users u ON u.id = wp.user_id
    WHERE wp.public_key = ?
  `).get(publicKey);

}



function mapPeer(publicKey, userId) {

  const db = getDb();


  return db.prepare(`
    INSERT INTO wireguard_peers
    (
      public_key,
      user_id
    )
    VALUES (?, ?)
  `).run(
    publicKey,
    userId
  );

}



function unmapPeer(publicKey) {

  const db = getDb();


  return db.prepare(`
    DELETE FROM wireguard_peers
    WHERE public_key = ?
  `).run(publicKey);

}



function listMappedPeers() {

  const db = getDb();


  return db.prepare(`
    SELECT
      wp.public_key,
      wp.user_id,
      u.username
    FROM wireguard_peers wp
    JOIN users u ON u.id = wp.user_id
    ORDER BY u.username
  `).all();

}



module.exports = {
  getMappedPeer,
  mapPeer,
  unmapPeer,
  listMappedPeers
};
