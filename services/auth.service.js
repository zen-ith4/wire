const { getDb } = require('../config/database');

const {
  hashPassword,
  comparePassword
} = require('../utils/password');

const { signToken } = require('../utils/jwt');

const {
  isValidAuthKey,
  isValidKdfSalt,
  isValidIterations
} = require('../utils/credentials');

// ======================================================
// TIMING SIDE-CHANNEL MITIGATION
//
// A nonexistent username used to make authenticateUser() return
// immediately, while a valid username with a wrong password had to
// wait for bcrypt.compare() to finish. That timing difference lets
// an attacker enumerate valid usernames purely by measuring response
// time, even though both cases return an identical error message.
//
// The fix: whenever we're about to return null without ever calling
// comparePassword() against a real stored hash, run one against a
// fixed dummy hash instead, so both paths pay the same bcrypt cost.
// The dummy hash is generated (once, lazily) via the same
// hashPassword()/BCRYPT_ROUNDS config as real user passwords, so its
// cost tracks whatever cost factor is actually configured rather
// than a hardcoded guess.
// ======================================================

let dummyHashPromise = null;

function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(
      'wire-timing-mitigation-dummy-password'
    );
  }

  return dummyHashPromise;
}

async function compareAgainstDummyHash(password) {
  try {
    await comparePassword(
      password,
      await getDummyHash()
    );
  } catch (err) {
    // Never let a failure here (or a slow first-call hash
    // generation) turn into an unhandled rejection / crash — the
    // caller is returning null regardless.
  }
}

const {
  createAndSendVerificationCode
} = require('./emailVerification.service');

const {
  createAndSendTwoFactorCode
} = require('./email2fa.service');

const {
  isEmailEnabled
} = require('./email.service');


// F12: `password` here is the client-derived authKey, never the real password.
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
      is_active,
      accent_color
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    // No such user — still pay the bcrypt cost of a real comparison
    // so this doesn't return measurably faster than a wrong password
    // for a real username (see the timing side-channel note above).
    await compareAgainstDummyHash(password);
    return null;
  }

  if (user.is_active === 0) {
    // Same reasoning: a deactivated account shouldn't be
    // distinguishable from a wrong password by response timing
    // either.
    await compareAgainstDummyHash(password);
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
   * When the email subsystem is disabled, authentication must
   * have no dependency on email state at all. A stale
   * "email_verified = 0" or "email_2fa_enabled = 1" left over
   * from when email was enabled must never block or challenge
   * login — the user goes straight to a normal JWT below.
   */
  if (isEmailEnabled()) {

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
        accent_color: user.accent_color || null,
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
        accent_color: user.accent_color || null,

        requiresTwoFactor: true,
        twoFactorMethod: 'email',
        challengeId: challenge.challengeId,

        token: null
      };
    }
  }

  /*
   * Either email is disabled (authentication never depends on
   * email state), or email is enabled and the account is
   * verified with Email 2FA disabled. Either way, issue the
   * normal authentication JWT.
   */
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: isEmailEnabled()
      ? true
      : Boolean(user.email_verified),
    is_admin: Boolean(user.is_admin),
    accent_color: user.accent_color || null,

    token: signToken({
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    })
  };
}


// F12: `password` is the client-derived authKey; kdfSalt/kdfIterations are the
// parameters the browser used to derive it (needed again at every login).
async function registerUser(username, email, password, kdfSalt, kdfIterations) {
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

  if (
    !isValidAuthKey(password) ||
    !isValidKdfSalt(kdfSalt) ||
    !isValidIterations(kdfIterations)
  ) {
    const error = new Error(
      'Invalid credentials payload'
    );

    error.code = 'INVALID_CREDENTIALS';

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

  /*
   * When email is disabled there is no verification mechanism
   * available, so newly created users are considered verified
   * immediately. The email address may still be stored as
   * account metadata, but no email-dependent flow is triggered.
   */
  const emailEnabled = isEmailEnabled();
  const initialEmailVerified = emailEnabled ? 0 : 1;


  let userId;

  try {
    const result = db.prepare(`
      INSERT INTO users (
        username,
        email,
        password_hash,
        kdf_salt,
        kdf_iterations,
        email_verified
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      username,
      email,
      passwordHash,
      kdfSalt,
      kdfIterations,
      initialEmailVerified
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
        is_active,
        accent_color
      FROM users
      WHERE id = ?
    `).get(userId);


  if (!emailEnabled) {
    /*
     * No verification mechanism is available. The account is
     * already fully usable, so issue the normal authentication
     * JWT immediately instead of requiring a separate login.
     */
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      email_verified: true,
      is_admin: Boolean(user.is_admin),
      accent_color: user.accent_color || null,
      requiresEmailVerification: false,

      token: signToken({
        id: user.id,
        username: user.username,
        is_admin: Boolean(user.is_admin)
      })
    };
  }


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