const { getDb } = require('../config/database');

const {
  hashPassword,
  comparePassword
} = require('../utils/password');

const { signToken } = require('../utils/jwt');

const {
  createAndSendVerificationCode
} = require('./emailVerification.service');

const {
  createAndSendTwoFactorCode
} = require('./email2fa.service');


async function authenticateUser(username, password) {
  const db = getDb();

  username = String(username || '')
    .trim()
    .toLowerCase();

  const user = db.prepare(`
    SELECT
      id,
      username,
      email,
      email_verified,
      email_2fa_enabled,
      password_hash,
      is_admin,
      is_active
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    return null;
  }

  if (user.is_active === 0) {
    return null;
  }

  const passwordValid =
    await comparePassword(
      password,
      user.password_hash
    );

  if (!passwordValid) {
    return null;
  }

  /*
   * Password is correct, but the account is not
   * allowed to receive a normal authentication token
   * until the email has been verified.
   */
  if (user.email_verified === 0) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: false,
      is_admin: Boolean(user.is_admin),
      requiresEmailVerification: true,
      token: null
    };
  }

  /*
   * Email is verified.
   *
   * If Email 2FA is enabled, do NOT issue the
   * normal JWT yet. Create a temporary 2FA challenge
   * and require the email OTP first.
   */
  if (user.email_2fa_enabled === 1) {

    const challenge =
      await createAndSendTwoFactorCode(user);

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: true,
      is_admin: Boolean(user.is_admin),

      requiresTwoFactor: true,
      twoFactorMethod: 'email',
      challengeId: challenge.challengeId,

      token: null
    };
  }

  /*
   * Verified account with Email 2FA disabled.
   * Issue the normal authentication JWT.
   */
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: true,
    is_admin: Boolean(user.is_admin),

    token: signToken({
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    })
  };
}


async function registerUser(username, email, password) {
  const db = getDb();

  username = String(username || '')
    .trim()
    .toLowerCase();

  email = String(email || '')
    .trim()
    .toLowerCase();

  if (!username) {
    const error = new Error(
      'Username is required'
    );

    error.code = 'INVALID_USERNAME';

    throw error;
  }

  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    const error = new Error(
      'Invalid email address'
    );

    error.code = 'INVALID_EMAIL';

    throw error;
  }

  if (!password || password.length < 6) {
    const error = new Error(
      'Password must be at least 6 characters'
    );

    error.code = 'INVALID_PASSWORD';

    throw error;
  }


  const existingUsername = db.prepare(`
    SELECT id
    FROM users
    WHERE username = ?
    LIMIT 1
  `).get(username);

  if (existingUsername) {
    const error = new Error(
      'Username already exists'
    );

    error.code = 'USERNAME_EXISTS';

    throw error;
  }


  const existingEmail = db.prepare(`
    SELECT id
    FROM users
    WHERE email = ?
    LIMIT 1
  `).get(email);

  if (existingEmail) {
    const error = new Error(
      'Email already exists'
    );

    error.code = 'EMAIL_EXISTS';

    throw error;
  }


  const passwordHash =
    await hashPassword(password);


  let userId;

  try {
    const result = db.prepare(`
      INSERT INTO users (
        username,
        email,
        password_hash,
        email_verified
      )
      VALUES (?, ?, ?, 0)
    `).run(
      username,
      email,
      passwordHash
    );

    userId =
      Number(result.lastInsertRowid);

  } catch (error) {

    if (
      error.code ===
        'SQLITE_CONSTRAINT_UNIQUE' ||
      error.code ===
        'SQLITE_CONSTRAINT'
    ) {

      const duplicateUsername =
        db.prepare(`
          SELECT id
          FROM users
          WHERE username = ?
          LIMIT 1
        `).get(username);

      if (duplicateUsername) {
        const duplicateError =
          new Error(
            'Username already exists'
          );

        duplicateError.code =
          'USERNAME_EXISTS';

        throw duplicateError;
      }


      const duplicateEmail =
        db.prepare(`
          SELECT id
          FROM users
          WHERE email = ?
          LIMIT 1
        `).get(email);

      if (duplicateEmail) {
        const duplicateError =
          new Error(
            'Email already exists'
          );

        duplicateError.code =
          'EMAIL_EXISTS';

        throw duplicateError;
      }
    }

    throw error;
  }


  const user =
    db.prepare(`
      SELECT
        id,
        username,
        email,
        email_verified,
        is_admin,
        is_active
      FROM users
      WHERE id = ?
    `).get(userId);


  await createAndSendVerificationCode(
    user
  );


  return {
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: false,
    requiresEmailVerification: true
  };
}


module.exports = {
  authenticateUser,
  registerUser
};