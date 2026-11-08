const fs = require('fs');
const path = require('path');

const constants = require('../config/constants');
const { getDb } = require('../config/database');
const {
  getIdentityKeyHistory: readIdentityKeyHistory,
  canViewIdentityKeyHistory
} = require('../services/identityKeyHistory.service');

const {
  findUserById,
  findUserWithPassword,
  updateBio: updateUserBio,
  updateAccentColor: updateUserAccentColor,
  updateAvatar: updateUserAvatar,
  updateBanner: updateUserBanner,
  updatePassword: updateUserPassword,
  changeCredentialsV2,
  getStorageUsage,
  isShowLastSeenEnabled,
} = require('../services/user.service');
const { isOnline } = require('../services/presence.service');

const { comparePassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');
const {
  isValidAuthKey,
  isValidKdfSalt,
  isValidIterations,
  validateIdentityV2
} = require('../utils/credentials');
const { AVATAR_MIME_MAP } = require('../config/multer');
const {
  emitProfileAvatarUpdate,
  emitProfileBannerUpdate,
} = require('../services/socket.service');
const {
  upsertPushToken,
  deletePushToken,
} = require('../services/pushToken.service');


// GET /me
function getMe(req, res) {
  const user = findUserById(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  res.json({
    id: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    bio: user.bio || '',
    has_avatar: !!user.avatar_path,
    has_banner: !!user.banner_path,
    accent_color: user.accent_color || null,
    created_at: user.created_at,
    groups_enabled: !!constants.GROUPS_ENABLED
  });
}


// PUT /me/accent
function updateAccentColor(req, res) {
  const accentColor =
    typeof req.body?.accent_color === 'string'
      ? req.body.accent_color.trim()
      : '';

  if (!/^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    return res.status(400).json({
      error: 'Invalid accent color'
    });
  }

  const normalizedColor = accentColor.toUpperCase();

  updateUserAccentColor(
    req.user.id,
    normalizedColor
  );

  res.json({
    success: true,
    accent_color: normalizedColor
  });
}


// PUT /me
function updateBio(req, res) {
  const bio =
    typeof req.body?.bio === 'string'
      ? req.body.bio.trim().slice(0, 300)
      : '';

  updateUserBio(
    req.user.id,
    bio
  );

  res.json({
    success: true,
    bio
  });
}


// GET /me/kdf-params  -  the caller's own account KDF parameters. The browser
// needs them to derive the current authKey for "confirm your password" steps
// and the wrapKey for identity creation. {scheme:1} while not yet migrated.
function getOwnKdfParams(req, res) {
  const user =
    findUserWithPassword(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  if (user.auth_scheme !== 2) {
    return res.json({ scheme: 1 });
  }

  return res.json({
    scheme: 2,
    salt: user.kdf_salt,
    iterations: user.kdf_iterations
  });
}


// PUT /me/password
//
// F12: no raw password ever reaches the server. The browser derives, from the
// old and the new password, two authKeys (and wrapKeys); it decrypts the identity
// with the old wrapKey, re-encrypts it with the new wrapKey under a FRESH salt,
// and sends:
//   current_auth_key   proves knowledge of the old password
//   new_auth_key       becomes the new bcrypt'd credential
//   new_kdf_salt / new_kdf_iterations   parameters of the new derivation
//   identity           the identity private key re-encrypted client-side
//                      (required when the account has an identity)
// Accounts still on the legacy scheme must migrate first (log in again).
async function changePassword(req, res) {
  const body = req.body || {};

  if (
    'current_password' in body ||
    'new_password' in body ||
    'password' in body
  ) {
    return res.status(400).json({
      error: 'Raw passwords are not accepted. Update the app.',
      code: 'raw_password_rejected'
    });
  }

  const {
    current_auth_key,
    new_auth_key,
    new_kdf_salt,
    new_kdf_iterations,
    identity
  } = body;

  if (
    !isValidAuthKey(current_auth_key) ||
    !isValidAuthKey(new_auth_key) ||
    !isValidKdfSalt(new_kdf_salt) ||
    !isValidIterations(new_kdf_iterations)
  ) {
    return res.status(400).json({
      error: 'Invalid credential data'
    });
  }

  const user =
    findUserWithPassword(
      req.user.id
    );

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  if (user.auth_scheme !== 2) {
    return res.status(409).json({
      error: 'Log in again to upgrade this account before changing the password',
      code: 'migrate_first'
    });
  }

  if (new_kdf_salt === user.kdf_salt) {
    return res.status(400).json({
      error: 'A fresh salt is required',
      code: 'salt_reuse'
    });
  }

  const valid =
    await comparePassword(
      current_auth_key,
      user.password_hash
    );

  if (!valid) {
    return res.status(401).json({
      error: 'Current password is incorrect'
    });
  }

  const db = getDb();

  const existingIdentity =
    db.prepare(`
      SELECT id
      FROM identity_keys
      WHERE user_id = ?
    `).get(req.user.id);

  // An account with an identity MUST send it re-wrapped (otherwise the new
  // password could never decrypt it). An account without one must not invent
  // one here: creating it is the write-once PUT /me/identity-key.
  let validatedIdentity = null;

  if (existingIdentity) {
    const check =
      validateIdentityV2(
        identity,
        new_kdf_salt,
        new_kdf_iterations
      );

    if (!check.ok) {
      return res.status(400).json({
        error: check.error
      });
    }

    validatedIdentity = check.value;

  } else if (identity != null) {
    return res.status(400).json({
      error: 'Identity key does not exist'
    });
  }

  let result;

  try {
    result =
      await changeCredentialsV2(
        req.user.id,
        {
          currentHash: user.password_hash,
          newAuthKey: new_auth_key,
          kdfSalt: new_kdf_salt,
          kdfIterations: new_kdf_iterations,
          identity: validatedIdentity
        }
      );
  } catch (err) {
    console.error(
      'Password change failed:',
      err.message
    );

    return res.status(500).json({
      error: 'Password change failed'
    });
  }

  if (!result.ok) {
    return res.status(409).json({
      error: 'Password was changed concurrently, try again',
      code: 'conflict'
    });
  }

  // The change revoked every existing session, this device's included.
  // Hand back a token for the new version so this device stays signed in.
  // A password-change token is never upgraded to a session here: that
  // account still signs in normally after the forced change.
  if (req.viaPasswordChangeToken) {
    return res.json({
      success: true
    });
  }

  return res.json({
    success: true,
    token: signToken({
      id: req.user.id,
      username: req.user.username,
      is_admin: req.user.is_admin,
      token_version: result.tokenVersion
    })
  });
}


// POST /me/avatar
function uploadAvatar(req, res) {
  if (!req.file) {
    return res.status(400).json({
      error: 'No image uploaded'
    });
  }

  const user = findUserById(req.user.id);

  if (user?.avatar_path) {
    const oldPath = path.join(
      constants.AVATAR_DIR,
      user.avatar_path
    );

    if (fs.existsSync(oldPath)) {
      fs.unlink(oldPath, err => {
        if (err) {
          console.error(
            'Avatar delete failed:',
            err.message
          );
        }
      });
    }
  }

  updateUserAvatar(
    req.user.id,
    req.file.filename
  );

  emitProfileAvatarUpdate(req.user.id);

  res.json({
    success: true
  });
}


// DELETE /me/avatar
function removeAvatar(req, res) {
  const user = findUserById(req.user.id);

  if (user?.avatar_path) {
    const filePath = path.join(
      constants.AVATAR_DIR,
      user.avatar_path
    );

    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, err => {
        if (err) {
          console.error(
            'Avatar delete failed:',
            err.message
          );
        }
      });
    }
  }

  updateUserAvatar(
    req.user.id,
    null
  );

  emitProfileAvatarUpdate(req.user.id);

  res.json({
    success: true
  });
}


// GET /avatar/:userId
function getAvatar(req, res) {
  const user = findUserById(
    req.params.userId
  );

  if (!user || !user.avatar_path) {
    return res.status(404).json({
      error: 'No avatar'
    });
  }

  const filePath = path.join(
    constants.AVATAR_DIR,
    user.avatar_path
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Avatar file not found'
    });
  }

  const ext = path.extname(
    user.avatar_path
  ).toLowerCase();

  const mime =
    AVATAR_MIME_MAP[ext] ||
    'application/octet-stream';

  res.setHeader(
    'Content-Type',
    mime
  );

  res.setHeader(
    'Cache-Control',
    'no-cache'
  );

  const avatarStream = fs.createReadStream(filePath);
  // Same reasoning as chat.controller.js/dm.controller.js's
  // getAttachment: without this, a client that navigates away
  // mid-load leaves the server still reading the file for no one.
  // Avatars are small, so the impact here is minor, but the fix is
  // free and keeps this endpoint consistent with the others.
  req.on('close', () => {
    if (!avatarStream.destroyed) avatarStream.destroy();
  });
  avatarStream.pipe(res);
}


// POST /me/banner
function uploadBanner(req, res) {
  if (!req.file) {
    return res.status(400).json({
      error: 'No image uploaded'
    });
  }

  const user = findUserById(req.user.id);

  if (user?.banner_path) {
    const oldPath = path.join(
      constants.BANNER_DIR,
      user.banner_path
    );

    if (fs.existsSync(oldPath)) {
      fs.unlink(oldPath, err => {
        if (err) {
          console.error(
            'Banner delete failed:',
            err.message
          );
        }
      });
    }
  }

  updateUserBanner(
    req.user.id,
    req.file.filename
  );

  emitProfileBannerUpdate(req.user.id);

  res.json({
    success: true
  });
}


// DELETE /me/banner
function removeBanner(req, res) {
  const user = findUserById(req.user.id);

  if (user?.banner_path) {
    const filePath = path.join(
      constants.BANNER_DIR,
      user.banner_path
    );

    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, err => {
        if (err) {
          console.error(
            'Banner delete failed:',
            err.message
          );
        }
      });
    }
  }

  updateUserBanner(
    req.user.id,
    null
  );

  emitProfileBannerUpdate(req.user.id);

  res.json({
    success: true
  });
}


// GET /banner/:userId
function getBanner(req, res) {
  const user = findUserById(
    req.params.userId
  );

  if (!user || !user.banner_path) {
    return res.status(404).json({
      error: 'No banner'
    });
  }

  const filePath = path.join(
    constants.BANNER_DIR,
    user.banner_path
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Banner file not found'
    });
  }

  const ext = path.extname(
    user.banner_path
  ).toLowerCase();

  const mime =
    AVATAR_MIME_MAP[ext] ||
    'application/octet-stream';

  res.setHeader(
    'Content-Type',
    mime
  );

  res.setHeader(
    'Cache-Control',
    'no-cache'
  );

  const bannerStream = fs.createReadStream(filePath);
  req.on('close', () => {
    if (!bannerStream.destroyed) bannerStream.destroy();
  });
  bannerStream.pipe(res);
}


// GET /me/:userId
function getUserProfile(req, res) {
  const userId = parseInt(
    req.params.userId,
    10
  );

  if (!Number.isInteger(userId)) {
    return res.status(400).json({
      error: 'Invalid user id'
    });
  }

  const user = findUserById(userId);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  // Presence is only ever visible to the user themselves, or to
  // others when this user has "Show Last Seen & Online Status"
  // enabled — never through this endpoint, or any other, when it's
  // off. See services/user.service.js / config/socket.js for the
  // same rule applied to the live socket events.
  const isSelf = Number(user.id) === Number(req.user.id);
  const presenceVisible = isSelf || isShowLastSeenEnabled(user.id);

  res.json({
    id: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    bio: user.bio || '',
    has_avatar: !!user.avatar_path,
    has_banner: !!user.banner_path,
    accent_color: user.accent_color || null,
    created_at: user.created_at,
    online: presenceVisible ? isOnline(user.id) : false,
    last_seen_at: presenceVisible ? (user.last_seen_at || null) : null,
    storage_used: getStorageUsage(user.id)
  });
}

async function updatePublicKey(req, res) {

  const publicKey =
    req.body?.publicKey;


  if (
    typeof publicKey !== 'string' ||
    !publicKey.trim()
  ) {
    return res.status(400).json({
      error: 'Public key required'
    });
  }


  const key = publicKey.trim();


  // X25519 raw public key = 32 bytes = 43/44 chars in Base64
  if (
    key.length < 40 ||
    key.length > 100
  ) {
    return res.status(400).json({
      error: 'Invalid public key'
    });
  }


  try {

    const decoded = Buffer.from(key, 'base64');

    if (decoded.length !== 32) {
      return res.status(400).json({
        error: 'Invalid X25519 public key'
      });
    }

  } catch (e) {

    return res.status(400).json({
      error: 'Invalid public key'
    });

  }


  const db = getDb();


  const result = db.prepare(`
    UPDATE users
    SET public_key = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    key,
    req.user.id
  );


  if (result.changes === 0) {
    return res.status(404).json({
      error: 'User not found'
    });
  }


  return res.json({
    success: true
  });
}

function getIdentityKey(req, res) {
    const db = getDb();

    const identity = db.prepare(`
        SELECT
            public_key,
            encrypted_private_key,
            kdf,
            kdf_params,
            salt,
            iv,
            version,
            updated_at
        FROM identity_keys
        WHERE user_id = ?
    `).get(req.user.id);

    if (!identity) {
        return res.json({
            exists: false
        });
    }

    return res.json({
        exists: true,
        publicKey: identity.public_key,
        encryptedPrivateKey: identity.encrypted_private_key,
        kdf: identity.kdf,
        kdfParams: JSON.parse(identity.kdf_params),
        salt: identity.salt,
        iv: identity.iv,
        version: identity.version,
        updatedAt: identity.updated_at
    });
}

// PUT /me/identity-key  -  WRITE-ONCE.
//
// The identity public key is what other users pin and what group key
// distribution is addressed to, so it must never be silently replaced:
//   - no identity yet  -> created here (this is the only way to create one
//                         outside the migration ticket)
//   - identity exists  -> 409 identity_exists, nothing changes
// Deliberate replacement is POST /me/identity-key/rotate.
// A scheme-2 account must send a v2 wrapper bound to its account KDF
// parameters; a scheme-1 account a v1 wrapper (it moves to v2 at migration).
function saveIdentityKey(req, res) {
  const {
    publicKey,
    encryptedPrivateKey,
    kdf,
    kdfParams,
    salt,
    iv,
    version = 1
  } = req.body || {};

  if (
    typeof publicKey !== 'string' ||
    typeof encryptedPrivateKey !== 'string' ||
    typeof kdf !== 'string' ||
    !kdfParams ||
    typeof kdfParams !== 'object' ||
    Array.isArray(kdfParams) ||
    typeof salt !== 'string' ||
    typeof iv !== 'string'
  ) {
    return res.status(400).json({
      error: 'Invalid identity key data'
    });
  }

  if (
    !Number.isInteger(version) ||
    version < 1
  ) {
    return res.status(400).json({
      error: 'Invalid identity key version'
    });
  }

  const publicKeyBuffer = Buffer.from(
    publicKey,
    'base64'
  );

  if (publicKeyBuffer.length !== 32) {
    return res.status(400).json({
      error: 'Invalid X25519 public key'
    });
  }

  const db = getDb();

  const user =
    findUserWithPassword(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  let stored;

  if (user.auth_scheme === 2) {
    const check =
      validateIdentityV2(
        req.body,
        user.kdf_salt,
        user.kdf_iterations
      );

    if (!check.ok) {
      return res.status(400).json({
        error: check.error
      });
    }

    stored = check.value;

  } else {
    // legacy account: only the v1 wrapper is a legal state
    if (version !== 1) {
      return res.status(400).json({
        error: 'Invalid identity key version'
      });
    }

    stored = {
      encryptedPrivateKey: encryptedPrivateKey.trim(),
      kdf: kdf.trim(),
      kdfParams,
      salt: salt.trim(),
      iv: iv.trim(),
      version
    };
  }

  const result = db.prepare(`
    INSERT INTO identity_keys (
      user_id,
      public_key,
      encrypted_private_key,
      kdf,
      kdf_params,
      salt,
      iv,
      version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(
    req.user.id,
    publicKey.trim(),
    stored.encryptedPrivateKey,
    stored.kdf,
    JSON.stringify(stored.kdfParams),
    stored.salt,
    stored.iv,
    stored.version
  );

  if (result.changes === 0) {
    return res.status(409).json({
      error: 'Identity key already exists',
      code: 'identity_exists'
    });
  }

  return res.json({
    success: true
  });
}

// POST /me/identity-key/rotate  -  explicit, authenticated replacement of the
// identity KEY PAIR (there is no UI for it; it exists so a compromised or lost
// key is recoverable without editing the database). Requires:
//   current_auth_key       proves the password (a stolen JWT is not enough)
//   expected_public_key    }  compare-and-set against what the caller saw, so a
//   expected_updated_at    }  concurrent change makes this fail with 409
//   identity               new v2 wrapper including the NEW publicKey
// Every rotation is logged in identity_key_rotations.
async function rotateIdentityKey(req, res) {
  const {
    current_auth_key,
    expected_public_key,
    expected_updated_at,
    identity
  } = req.body || {};

  if (
    !isValidAuthKey(current_auth_key) ||
    typeof expected_public_key !== 'string' ||
    typeof expected_updated_at !== 'string' ||
    !identity ||
    typeof identity !== 'object' ||
    typeof identity.publicKey !== 'string' ||
    Buffer.from(identity.publicKey, 'base64').length !== 32
  ) {
    return res.status(400).json({
      error: 'Invalid rotation request'
    });
  }

  const user =
    findUserWithPassword(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  if (user.auth_scheme !== 2) {
    return res.status(409).json({
      error: 'Log in again to upgrade this account first',
      code: 'migrate_first'
    });
  }

  const valid =
    await comparePassword(
      current_auth_key,
      user.password_hash
    );

  if (!valid) {
    return res.status(401).json({
      error: 'Current password is incorrect'
    });
  }

  const check =
    validateIdentityV2(
      identity,
      user.kdf_salt,
      user.kdf_iterations
    );

  if (!check.ok) {
    return res.status(400).json({
      error: check.error
    });
  }

  const newPublicKey =
    identity.publicKey.trim();

  if (newPublicKey === expected_public_key) {
    return res.status(400).json({
      error: 'The new public key must differ from the current one'
    });
  }

  const db = getDb();

  const run = db.transaction(() => {
    const r = db.prepare(`
      UPDATE identity_keys
      SET
        public_key = ?,
        encrypted_private_key = ?,
        kdf = ?,
        kdf_params = ?,
        salt = ?,
        iv = ?,
        version = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND public_key = ?
        AND updated_at = ?
    `).run(
      newPublicKey,
      check.value.encryptedPrivateKey,
      check.value.kdf,
      JSON.stringify(check.value.kdfParams),
      check.value.salt,
      check.value.iv,
      check.value.version,
      req.user.id,
      expected_public_key,
      expected_updated_at
    );

    if (r.changes !== 1) {
      return false;
    }

    db.prepare(`
      INSERT INTO identity_key_rotations (
        user_id, old_public_key, new_public_key
      )
      VALUES (?, ?, ?)
    `).run(
      req.user.id,
      expected_public_key,
      newPublicKey
    );

    return true;
  });

  if (!run()) {
    const exists =
      db.prepare(
        'SELECT 1 AS x FROM identity_keys WHERE user_id = ?'
      ).get(req.user.id);

    return res.status(exists ? 409 : 404).json({
      error: exists
        ? 'Identity key changed, reload and retry'
        : 'Identity key does not exist',
      code: exists ? 'conflict' : 'no_identity'
    });
  }

  return res.json({
    success: true
  });
}

function getUserIdentityPublicKey(req, res) {
    const db = getDb();

    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({
            error: 'Invalid user ID'
        });
    }

    const identity = db.prepare(`
        SELECT public_key
        FROM identity_keys
        WHERE user_id = ?
    `).get(userId);

    if (!identity) {
        return res.status(404).json({
            error: 'Identity key not found'
        });
    }

    // STEP 1B: the peer's DM E2EE floor. Additive - the existing
    // {publicKey} shape is unchanged. Missing/NULL/non-integer => 1, so a
    // row that predates the column behaves exactly as an unupgraded peer.
    const userRow = db.prepare('SELECT dm_e2ee_min_version FROM users WHERE id = ?').get(userId);
    const raw = userRow ? userRow.dm_e2ee_min_version : null;
    const dmE2eeMinVersion = Number.isInteger(raw) && raw >= 1 ? raw : 1;

    return res.json({
        publicKey: identity.public_key,
        dmE2eeMinVersion
    });
}

// GET /me/identity-key-history/:userId
//
// The read side of the identity-key archive (identityKeyHistory.service.js).
// Rotation has always preserved the outgoing public key — identity_key_rotations
// is written in the same transaction as the UPDATE that replaces it — but
// nothing ever read it, so a client whose peer had rotated had no way to reach
// the key its old messages were actually encrypted to. This endpoint is that way
// in.
//
// AUTHORIZATION, AND WHAT IT DOES NOT LEAK
// Only for a user who shares a direct message or a group with the peer: those are
// the relationships over which the caller already receives ciphertext, so the
// keys behind that ciphertext are not a new disclosure. See
// canViewIdentityKeyHistory().
//
// Every failure below returns the SAME 404 body. "Not your contact", "no such
// user" and "that user has no identity key" are deliberately indistinguishable,
// because a caller able to tell them apart learns whether an account exists and
// whether it has set up E2EE — neither of which this endpoint has any business
// revealing to a stranger. A 403 would leak exactly the same thing, more
// politely.
//
// Fingerprints are SHA-256 over the raw public key bytes. The server can compute
// them because it holds the keys; that is a hash of a value the caller is
// already entitled to, not extra information about anyone.
function getIdentityKeyHistory(req, res) {
    const peerId = Number(req.params.userId);

    if (!Number.isInteger(peerId) || peerId <= 0) {
        return res.status(400).json({
            error: 'Invalid user ID'
        });
    }

    if (!canViewIdentityKeyHistory(req.user.id, peerId)) {
        return res.status(404).json({
            error: 'Not found'
        });
    }

    const history = readIdentityKeyHistory(peerId);

    if (!history) {
        return res.status(404).json({
            error: 'Not found'
        });
    }

    res.set('Cache-Control', 'private, no-store');
    res.json(history);
}

// POST /me/push-token
function registerPushToken(req, res) {
  const { token } = req.body || {};

  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({
      error: 'Push token required'
    });
  }

  const trimmedToken = token.trim();

  // FCM registration tokens are long opaque strings (typically
  // 140-200+ chars); these bounds just reject obvious garbage, not
  // any specific token format.
  if (trimmedToken.length < 32 || trimmedToken.length > 4096) {
    return res.status(400).json({
      error: 'Invalid push token'
    });
  }

  // Only Android ships push in this project right now (see
  // notifications/PLATFORM-NOTES.md) — Electron uses its own native
  // Notification API directly, with no token/backend involvement, so
  // there's nothing else this column could legitimately hold yet.
  const normalizedPlatform = 'android';

  upsertPushToken(
    req.user.id,
    trimmedToken,
    normalizedPlatform
  );

  res.json({
    success: true
  });
}


// DELETE /me/push-token
function deregisterPushToken(req, res) {
  const { token } = req.body || {};

  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({
      error: 'Push token required'
    });
  }

  // Scoped to req.user.id inside the service — this can never delete
  // another user's token, even if a stale/reused token value were
  // passed in.
  deletePushToken(
    req.user.id,
    token.trim()
  );

  res.json({
    success: true
  });
}


module.exports = {
  getMe,
  updateBio,
  updateAccentColor,
  changePassword,
  getOwnKdfParams,
  uploadAvatar,
  removeAvatar,
  getAvatar,
  uploadBanner,
  removeBanner,
  getBanner,
  getUserProfile,
  updatePublicKey,
  getIdentityKey,
  saveIdentityKey,
  rotateIdentityKey,
  getUserIdentityPublicKey,
  getIdentityKeyHistory,
  registerPushToken,
  deregisterPushToken
};