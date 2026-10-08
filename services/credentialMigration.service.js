// F12 credential migration (legacy raw-password login -> authKey login).
//
// A legacy login that succeeds with the raw password may hand out a single-use
// ticket (valid 10 minutes, only its SHA-256 is stored). The browser then derives
// the new credentials locally and calls POST /api/auth/migrate-credentials with
// the ticket. Password and identity are written in ONE SQLite transaction, so the
// only reachable states are (scheme 1, no identity), (scheme 1, v1 identity),
// (scheme 2, no identity) and (scheme 2, v2 identity).

const crypto = require('crypto');
const { getDb } = require('../config/database');
const { hashPassword } = require('../utils/password');
const {
  isValidAuthKey,
  isValidKdfSalt,
  isValidIterations,
  validateIdentityV2
} = require('../utils/credentials');

const TICKET_TTL_MS = 10 * 60 * 1000;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function issueTicket(userId) {
  const ticket = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO auth_migration_tickets (user_id, ticket_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      ticket_hash = excluded.ticket_hash,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(userId, sha256Hex(ticket), now + TICKET_TTL_MS, now);
  return { ticket, expires_in_ms: TICKET_TTL_MS };
}

function fail(status, error, code) {
  return { ok: false, status, error, code };
}

// Returns {ok:true} or {ok:false,status,error,code}.
async function migrateCredentials(userId, body) {
  const { ticket, auth_key, kdf_salt, kdf_iterations, identity } = body || {};

  if (
    typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 100 ||
    !isValidAuthKey(auth_key) ||
    !isValidKdfSalt(kdf_salt) ||
    !isValidIterations(kdf_iterations)
  ) {
    return fail(400, 'Invalid migration request', 'invalid_request');
  }

  const db = getDb();
  const user = db.prepare('SELECT id, auth_scheme FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!user) return fail(401, 'Account is not available', 'unavailable');
  if (user.auth_scheme !== 1) {
    return fail(409, 'Account already uses the new login scheme', 'already_migrated');
  }

  const existing = db.prepare('SELECT public_key FROM identity_keys WHERE user_id = ?').get(userId);
  let idv = null;
  if (existing) {
    // v1 identity present: the re-wrapped v2 identity is mandatory, so the account
    // can never end up (scheme 2, v1 identity) and the key stays the same.
    const check = validateIdentityV2(identity, kdf_salt, kdf_iterations);
    if (!check.ok) return fail(400, check.error, 'invalid_identity');
    if (identity.publicKey !== existing.public_key) {
      return fail(409, 'Identity public key must not change', 'public_key_mismatch');
    }
    idv = check.value;
  } else if (identity != null) {
    // no identity yet: creating one during migration is allowed (write-once)
    const check = validateIdentityV2(identity, kdf_salt, kdf_iterations);
    if (!check.ok) return fail(400, check.error, 'invalid_identity');
    if (
      typeof identity.publicKey !== 'string' ||
      Buffer.from(identity.publicKey, 'base64').length !== 32
    ) {
      return fail(400, 'Invalid X25519 public key', 'invalid_identity');
    }
    idv = check.value;
  }

  const hash = await hashPassword(auth_key); // slow part outside the transaction

  const run = db.transaction(() => {
    // single-use ticket: claim it (delete) inside the same transaction
    const row = db.prepare('SELECT ticket_hash, expires_at FROM auth_migration_tickets WHERE user_id = ?').get(userId);
    if (!row) return fail(401, 'Migration ticket invalid or expired', 'ticket_invalid');
    const a = Buffer.from(row.ticket_hash, 'hex');
    const b = Buffer.from(sha256Hex(ticket), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || row.expires_at < Date.now()) {
      return fail(401, 'Migration ticket invalid or expired', 'ticket_invalid');
    }
    db.prepare('DELETE FROM auth_migration_tickets WHERE user_id = ?').run(userId);

    const cur = db.prepare('SELECT auth_scheme FROM users WHERE id = ?').get(userId);
    if (!cur || cur.auth_scheme !== 1) return fail(409, 'Account already uses the new login scheme', 'already_migrated');

    if (idv) {
      if (existing) {
        const r = db.prepare(`
          UPDATE identity_keys SET encrypted_private_key = ?, kdf = ?, kdf_params = ?, salt = ?, iv = ?,
            version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND public_key = ? AND version = 1
        `).run(idv.encryptedPrivateKey, idv.kdf, JSON.stringify(idv.kdfParams), idv.salt, idv.iv,
          idv.version, userId, existing.public_key);
        if (r.changes !== 1) return fail(409, 'Identity changed concurrently', 'identity_conflict');
      } else {
        db.prepare(`
          INSERT INTO identity_keys (user_id, public_key, encrypted_private_key, kdf, kdf_params, salt, iv, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, identity.publicKey.trim(), idv.encryptedPrivateKey, idv.kdf,
          JSON.stringify(idv.kdfParams), idv.salt, idv.iv, idv.version);
      }
    }

    db.prepare(`
      UPDATE users SET
        password_hash = ?, auth_scheme = 2, kdf_salt = ?, kdf_iterations = ?,
        scheme_migrated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND auth_scheme = 1
    `).run(hash, kdf_salt, kdf_iterations, userId);
    return { ok: true };
  });

  return run();
}

module.exports = { issueTicket, migrateCredentials, TICKET_TTL_MS };
