const {
  authenticateUser,
  registerUser
} = require('../services/auth.service');

const {
  verifyEmailCode,
  createAndSendVerificationCode
} = require('../services/emailVerification.service');

const {
  verifyTwoFactorCode
} = require('../services/email2fa.service');

const {
  getDb
} = require('../config/database');

const {
  signToken
} = require('../utils/jwt');

const {
  clearLoginAttempts
} = require('../middleware/rateLimiter');

const {
  isEmailEnabled
} = require('../services/email.service');

const {
  fakeKdfSalt,
  KDF_ITERATIONS
} = require('../utils/credentials');


/* =========================================================
 * F12 helpers
 * ========================================================= */

// Any body that still carries a raw password field is refused outright, so a
// stale or hostile client can never make the server see a password.
function rejectRawPassword(req, res) {
  const b = req.body || {};

  if (
    'password' in b ||
    'current_password' in b ||
    'new_password' in b
  ) {
    res.status(400).json({
      error:
        'Raw passwords are not accepted. Update the app.',
      code: 'raw_password_rejected'
    });

    return true;
  }

  return false;
}

// GET /api/auth/kdf-params?username=...  (public, rate limited)
// The browser needs the account salt BEFORE it can derive the authKey. Unknown
// usernames get a deterministic fake salt so this cannot be used to enumerate
// accounts.
function getKdfParams(req, res) {
  const username =
    String(req.query?.username || '')
      .trim()
      .toLowerCase();

  if (!username || username.length > 64) {
    return res.status(400).json({
      error: 'username required'
    });
  }

  const row =
    getDb().prepare(`
      SELECT kdf_salt, kdf_iterations
      FROM users
      WHERE username = ?
    `).get(username);

  if (row?.kdf_salt && row?.kdf_iterations) {
    return res.json({
      salt: row.kdf_salt,
      iterations: row.kdf_iterations
    });
  }

  return res.json({
    salt: fakeKdfSalt(username),
    iterations: KDF_ITERATIONS
  });
}


/* =========================================================
 * Login
 * ========================================================= */

async function login(req, res) {
  const username =
    req.body?.username?.trim();

  // F12: the raw password is never accepted. `auth_key` is derived in the
  // browser (PBKDF2 + HKDF) and is useless for decrypting anything.
  if (rejectRawPassword(req, res)) return;

  const password =
    req.body?.auth_key;

  if (!username || !password) {
    return res.status(400).json({
      error:
        'Username and auth_key required'
    });
  }


  const result =
    await authenticateUser(
      username,
      password
    );


  if (!result) {
    return res.status(401).json({
      error:
        'Invalid credentials'
    });
  }


  clearLoginAttempts(
    req.ip,
    username
  );


  return res.json(result);
}


/* =========================================================
 * Register
 * ========================================================= */

async function register(req, res) {
  const username =
    req.body?.username?.trim();

  const email =
    req.body?.email?.trim();

  if (rejectRawPassword(req, res)) return;

  const password =
    req.body?.auth_key;

  if (!username || !email || !password) {
    return res.status(400).json({
      error:
        'Username, email and auth_key required'
    });
  }

  try {

    const result =
      await registerUser(
        username,
        email,
        password,
        req.body?.kdf_salt,
        req.body?.kdf_iterations
      );

    return res.status(201).json(result);

  } catch (error) {

    if (
      error.code === 'USERNAME_EXISTS' ||
      error.message ===
        'Username already exists'
    ) {
      return res.status(409).json({
        error:
          'Username already exists'
      });
    }

    if (
      error.code === 'EMAIL_EXISTS' ||
      error.message ===
        'Email already exists'
    ) {
      return res.status(409).json({
        error:
          'Email already exists'
      });
    }

    if (
      error.code === 'INVALID_USERNAME' ||
      error.message ===
        'Username is required'
    ) {
      return res.status(400).json({
        error:
          'Username is required'
      });
    }

    if (
      error.code === 'INVALID_EMAIL' ||
      error.message ===
        'Invalid email address'
    ) {
      return res.status(400).json({
        error:
          'Invalid email address'
      });
    }

    if (error.code === 'INVALID_CREDENTIALS') {
      return res.status(400).json({
        error:
          'Invalid credentials payload'
      });
    }

    if (
      error.code === 'RESEND_COOLDOWN'
    ) {
      return res.status(429).json({
        error:
          'Please wait before requesting another code'
      });
    }

    throw error;
  }
}


/* =========================================================
 * Verify Email
 * ========================================================= */

async function verifyEmail(req, res) {
  if (!isEmailEnabled()) {
    return res.status(400).json({
      error:
        'Email feature disabled'
    });
  }

  const userId =
    req.body?.userId;

  const code =
    req.body?.code?.trim();

  if (
    !Number.isInteger(userId) ||
    !/^\d{6}$/.test(code || '')
  ) {
    return res.status(400).json({
      error:
        'Invalid verification code'
    });
  }


  const result =
    await verifyEmailCode(
      userId,
      code
    );


  if (!result.success) {

    switch (result.reason) {

      case 'TOO_MANY_ATTEMPTS':
        return res.status(429).json({
          error:
            'Too many verification attempts'
        });

      case 'EXPIRED':
        return res.status(400).json({
          error:
            'Verification code expired'
        });

      case 'INVALID_USER':
      case 'INVALID_CODE':
      default:
        return res.status(400).json({
          error:
            'Invalid verification code'
        });
    }
  }


  /*
   * Email has now been successfully verified.
   *
   * Issue the normal authentication token only
   * after successful verification.
   */
  const db =
    getDb();


  const user =
    db.prepare(`
      SELECT
        id,
        username,
        email,
        email_verified,
        is_admin,
        is_active,
        accent_color
      FROM users
      WHERE id = ?
    `).get(userId);


  if (
    !user ||
    user.is_active === 0
  ) {
    return res.status(401).json({
      error:
        'Account is not available'
    });
  }


  const token =
    signToken({
      id: user.id,
      username: user.username,
      is_admin: Boolean(
        user.is_admin
      )
    });


  return res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: true,
    is_admin: Boolean(
      user.is_admin
    ),
    accent_color: user.accent_color || null,
    token
  });
}


/* =========================================================
 * Resend Verification
 * ========================================================= */

async function resendVerification(req, res) {
  if (!isEmailEnabled()) {
    return res.status(400).json({
      error:
        'Email feature disabled'
    });
  }

  const userId =
    req.body?.userId;

  if (!Number.isInteger(userId)) {
    return res.status(400).json({
      error:
        'Invalid user ID'
    });
  }


  const db =
    getDb();


  const user =
    db.prepare(`
      SELECT
        id,
        username,
        email,
        email_verified,
        is_active
      FROM users
      WHERE id = ?
    `).get(userId);


  if (
    !user ||
    user.is_active === 0
  ) {
    return res.status(404).json({
      error:
        'User not found'
    });
  }


  if (user.email_verified) {
    return res.status(400).json({
      error:
        'Email already verified'
    });
  }


  try {

    await createAndSendVerificationCode(
      user
    );


    return res.json({
      success: true
    });

  } catch (error) {

    if (
      error.code === 'RESEND_COOLDOWN'
    ) {
      return res.status(429).json({
        error:
          'Please wait before requesting another code'
      });
    }

    throw error;
  }
}


/* =========================================================
 * Verify Email 2FA
 * ========================================================= */

async function verifyTwoFactor(req, res) {
  if (!isEmailEnabled()) {
    return res.status(400).json({
      error:
        'Email feature disabled'
    });
  }

  const userId =
    req.body?.userId;

  const challengeId =
    req.body?.challengeId;

  const code =
    req.body?.code?.trim();


  if (
    !Number.isInteger(userId) ||
    !/^\d{6}$/.test(code || '')
  ) {
    return res.status(400).json({
      error:
        'Invalid verification code'
    });
  }


  const result =
    await verifyTwoFactorCode(
      userId,
      challengeId,
      code
    );


  if (!result.success) {

    switch (result.reason) {

      case 'TOO_MANY_ATTEMPTS':
        return res.status(429).json({
          error:
            'Too many verification attempts'
        });

      case 'EXPIRED':
        return res.status(400).json({
          error:
            'Verification code expired'
        });

      case 'INVALID_CHALLENGE':
      case 'INVALID_USER':
      case 'INVALID_CODE':
      default:
        return res.status(400).json({
          error:
            'Invalid verification code'
        });
    }
  }


  /*
   * The 2FA challenge has now been successfully
   * verified. Only now is the final JWT issued.
   */
  const db =
    getDb();


  const user =
    db.prepare(`
      SELECT
        id,
        username,
        email,
        email_verified,
        email_2fa_enabled,
        is_admin,
        is_active,
        accent_color
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(userId);


  if (
    !user ||
    user.is_active === 0 ||
    user.email_verified === 0
  ) {
    return res.status(401).json({
      error:
        'Account is not available'
    });
  }


  /*
   * Prevent a stale or otherwise invalidated
   * 2FA challenge from being used to obtain
   * a token if 2FA is no longer enabled.
   */
  if (
    user.email_2fa_enabled !== 1
  ) {
    return res.status(401).json({
      error:
        'Two-factor authentication is not enabled'
    });
  }


  const token =
    signToken({
      id: user.id,
      username: user.username,
      is_admin: Boolean(
        user.is_admin
      )
    });


  return res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: true,
    is_admin: Boolean(
      user.is_admin
    ),
    accent_color: user.accent_color || null,
    email_2fa_enabled: true,
    token
  });
}


module.exports = {
  getKdfParams,
  login,
  register,
  verifyEmail,
  resendVerification,
  verifyTwoFactor
};