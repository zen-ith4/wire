const fs = require('fs');
const path = require('path');

const constants = require('../config/constants');
const { getDb } = require('../config/database');

const {
  findUserById,
  findUserWithPassword,
  updateBio: updateUserBio,
  updateAccentColor: updateUserAccentColor,
  updateAvatar: updateUserAvatar,
  updateBanner: updateUserBanner,
  changePasswordWithIdentity,
  getStorageUsage,
  isShowLastSeenEnabled,
} = require('../services/user.service');
const { isOnline } = require('../services/presence.service');

const { comparePassword } = require('../utils/password');
const {
  isValidAuthKey,
  isValidKdfSalt,
  isValidIterations,
  IDENTITY_KDF_NAME,
  IDENTITY_VERSION
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


// PUT /me/password
//
// F12: no raw password ever reaches the server. The browser derives, from the
// old and the new password, two authKeys (and wrapKeys); it decrypts the identity
// with the old wrapKey, re-encrypts it with the new wrapKey under a FRESH salt,
// and sends:
//   current_auth_key   proves knowledge of the old password
//   new_auth_key       becomes the new bcrypt'd credential
//   new_kdf_salt/new_kdf_iterations   parameters of the new derivation
//   identity           the identity private key re-encrypted client-side
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
      error: 'Invalid credentials payload'
    });
  }

  const user = findUserWithPassword(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
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

  /*
   * If the user has an E2EE identity, the browser must provide its NEW
   * encrypted-at-rest representation. The server does not decrypt it, and it
   * only accepts it if it was wrapped under the new salt it is also storing.
   */
  let validatedIdentity = null;

  if (identity != null) {
    const check = validateIdentityPayload(identity, new_kdf_salt, new_kdf_iterations);

    if (!check.ok) {
      return res.status(400).json({
        error: check.error
      });
    }

    const existingIdentity =
      getDb().prepare(`
        SELECT id FROM identity_keys WHERE user_id = ?
      `).get(req.user.id);

    if (!existingIdentity) {
      return res.status(400).json({
        error: 'Identity key does not exist'
      });
    }

    validatedIdentity = check.value;
  }

  await changePasswordWithIdentity(
    req.user.id,
    new_auth_key,
    validatedIdentity,
    new_kdf_salt,
    new_kdf_iterations
  );

  return res.json({
    success: true
  });
}


// Shared by PUT /me/identity-key and PUT /me/password. Only ONE format exists:
// version 2, PBKDF2-SHA-256 (>= 600,000) + HKDF, wrapped under the account's salt.
function validateIdentityPayload(identity, accountSalt, accountIterations) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { ok: false, error: 'Invalid identity data' };
  }

  const {
    encryptedPrivateKey,
    kdf,
    kdfParams,
    salt,
    iv,
    version
  } = identity;

  if (
    typeof encryptedPrivateKey !== 'string' ||
    !encryptedPrivateKey.trim() ||
    kdf !== IDENTITY_KDF_NAME ||
    !kdfParams ||
    typeof kdfParams !== 'object' ||
    Array.isArray(kdfParams) ||
    !isValidIterations(kdfParams.iterations) ||
    kdfParams.hash !== 'SHA-256' ||
    typeof iv !== 'string' ||
    !iv.trim() ||
    version !== IDENTITY_VERSION
  ) {
    return { ok: false, error: 'Invalid encrypted identity data' };
  }

  if (salt !== accountSalt || kdfParams.iterations !== accountIterations) {
    return { ok: false, error: 'Identity must be wrapped with the account KDF parameters' };
  }

  return {
    ok: true,
    value: {
      encryptedPrivateKey: encryptedPrivateKey.trim(),
      kdf,
      kdfParams: { iterations: kdfParams.iterations, hash: kdfParams.hash },
      salt,
      iv: iv.trim(),
      version
    }
  };
}


// GET /me/kdf-params : the caller's own account salt (needed to derive the
// wrapKey on a device that has no identity record yet, i.e. first login).
function getOwnKdfParams(req, res) {
  const row =
    getDb().prepare(`
      SELECT kdf_salt, kdf_iterations FROM users WHERE id = ?
    `).get(req.user.id);

  if (!row?.kdf_salt || !row?.kdf_iterations) {
    return res.status(404).json({
      error: 'No KDF parameters for this account'
    });
  }

  return res.json({
    salt: row.kdf_salt,
    iterations: row.kdf_iterations
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
            version
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
        version: identity.version
    });
}

function saveIdentityKey(req, res) {
  const { publicKey } = req.body || {};

  if (typeof publicKey !== 'string') {
    return res.status(400).json({
      error: 'Invalid identity key data'
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

  const account =
    db.prepare(`
      SELECT kdf_salt, kdf_iterations FROM users WHERE id = ?
    `).get(req.user.id);

  if (!account?.kdf_salt) {
    return res.status(400).json({
      error: 'Account has no KDF parameters'
    });
  }

  // Only one format exists (version 2) and it must be wrapped under THIS
  // account's salt/iterations, so the wrapKey is reproducible from the password
  // alone on any device.
  const check = validateIdentityPayload(
    req.body,
    account.kdf_salt,
    account.kdf_iterations
  );

  if (!check.ok) {
    return res.status(400).json({
      error: check.error
    });
  }

  const v = check.value;

  db.prepare(`
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
    ON CONFLICT(user_id) DO UPDATE SET
      public_key = excluded.public_key,
      encrypted_private_key = excluded.encrypted_private_key,
      kdf = excluded.kdf,
      kdf_params = excluded.kdf_params,
      salt = excluded.salt,
      iv = excluded.iv,
      version = excluded.version,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    req.user.id,
    publicKey.trim(),
    v.encryptedPrivateKey,
    v.kdf,
    JSON.stringify(v.kdfParams),
    v.salt,
    v.iv,
    v.version
  );

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

    return res.json({
        publicKey: identity.public_key
    });
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
  getUserIdentityPublicKey,
  registerPushToken,
  deregisterPushToken
};