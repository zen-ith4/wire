const { getDb } = require('../config/database');
const { comparePassword } = require('../utils/password');
const {
  createAndSendTwoFactorCode,
  verifyTwoFactorCode
} = require('./email2fa.service');

async function getSecuritySettings(userId) {
  const user = getDb()
    .prepare(`
      SELECT
        email_verified,
        email_2fa_enabled
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  return {
    email_verified: Boolean(user.email_verified),
    email_2fa_enabled: Boolean(user.email_2fa_enabled)
  };
}


async function beginEnableEmail2FA(userId, currentPassword) {
  if (!currentPassword) {
    const error = new Error('Current password is required');
    error.code = 'PASSWORD_REQUIRED';
    throw error;
  }

  const db = getDb();

  const user = db
    .prepare(`
      SELECT
        id,
        username,
        email,
        password_hash,
        email_verified,
        email_2fa_enabled
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  if (!user.email_verified) {
    const error = new Error(
      'Your email address must be verified before enabling Email 2FA'
    );
    error.code = 'EMAIL_NOT_VERIFIED';
    throw error;
  }

  if (user.email_2fa_enabled) {
    const error = new Error('Email 2FA is already enabled');
    error.code = 'ALREADY_ENABLED';
    throw error;
  }

  const validPassword =
    await comparePassword(
      currentPassword,
      user.password_hash
    );

  if (!validPassword) {
    const error = new Error('Current password is incorrect');
    error.code = 'INVALID_PASSWORD';
    throw error;
  }

  const result =
    await createAndSendTwoFactorCode(user);

  return {
    challengeId: result.challengeId,
    expiresAt: result.expiresAt,
    email: user.email
  };
}


async function confirmEnableEmail2FA(
  userId,
  challengeId,
  code
) {
  const result =
    await verifyTwoFactorCode(
      userId,
      challengeId,
      code
    );

  if (!result.success) {
    const errorMap = {
      INVALID_USER: 'Invalid user',
      INVALID_CHALLENGE: 'Invalid or expired verification request',
      INVALID_CODE: 'Invalid verification code',
      EXPIRED: 'Verification code has expired',
      TOO_MANY_ATTEMPTS:
        'Too many verification attempts'
    };

    const error = new Error(
      errorMap[result.reason] ||
      'Failed to verify two-factor code'
    );

    error.code = result.reason;

    throw error;
  }

  const db = getDb();

  const transaction =
    db.transaction(() => {

      const update =
        db.prepare(`
          UPDATE users
          SET email_2fa_enabled = 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND email_verified = 1
            AND email_2fa_enabled = 0
        `).run(userId);

      if (update.changes !== 1) {
        throw new Error(
          'Failed to enable Email 2FA'
        );
      }
    });

  transaction();

  return {
    success: true
  };
}


async function disableEmail2FA(
  userId,
  currentPassword
) {
  if (!currentPassword) {
    const error = new Error('Current password is required');
    error.code = 'PASSWORD_REQUIRED';
    throw error;
  }

  const db = getDb();

  const user = db
    .prepare(`
      SELECT
        id,
        password_hash,
        email_2fa_enabled
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  const validPassword =
    await comparePassword(
      currentPassword,
      user.password_hash
    );

  if (!validPassword) {
    const error = new Error('Current password is incorrect');
    error.code = 'INVALID_PASSWORD';
    throw error;
  }

  const transaction =
    db.transaction(() => {

      db.prepare(`
        DELETE FROM email_2fa_codes
        WHERE user_id = ?
      `).run(userId);

      const update =
        db.prepare(`
          UPDATE users
          SET email_2fa_enabled = 0,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(userId);

      if (update.changes !== 1) {
        throw new Error(
          'Failed to disable Email 2FA'
        );
      }
    });

  transaction();

  return {
    success: true
  };
}


module.exports = {
  getSecuritySettings,
  beginEnableEmail2FA,
  confirmEnableEmail2FA,
  disableEmail2FA
};