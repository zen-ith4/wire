// Share links: opaque, revocable, optionally expiring links to ONE file
// inside a folder the creator owns.
//
// SECURITY NOTES
//   - The raw token is never stored. `token_hash` is the SHA-256 of a
//     256-bit random token (see services/shareLink.service.js), so a
//     leaked database does not leak usable links.
//   - The row identifies the target by (folder_id, rel_path) only. No
//     absolute filesystem path is stored, so nothing here can point
//     outside the folder root, and it is re-validated on every request.
//   - Both foreign keys cascade: deleting the folder or the creator
//     deletes every link that depended on them.
module.exports = `
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  token_hash TEXT NOT NULL UNIQUE,

  folder_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  file_name TEXT NOT NULL,

  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,

  FOREIGN KEY (folder_id)
    REFERENCES folders(id)
    ON DELETE CASCADE,

  FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_links_file
ON share_links(folder_id, rel_path);

CREATE INDEX IF NOT EXISTS idx_share_links_creator
ON share_links(created_by);
`;
