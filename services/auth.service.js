const { getDb } = require('../config/database');

const {
  hashPassword,
  comparePassword
} = require('../utils/password');

const { signToken } = require('../utils/jwt');

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

const { isValidAuthKey, isValidKdfSalt, isValidIterations } = require('../utils/credentials');
const { issueTicket } = require('./credentialMigration.service');


// F12: `credentials` is either
//   { password }  - legacy raw-password login (scheme 1 accounts only), or
//   { authKey }   - browser-derived key (scheme 2 accounts only).
// A bare string is treated as { password } for older callers.
// Any mismatch (wrong form for the account's scheme, closed legacy login,
// unknown/inactive user) costs the same bcrypt comparison and returns null.
async function authenticateUser(username, credentials) {
  const db = getDb();

  const creds =
    typeof credentials === 'string'
      ? { password: credentials }
      : (credentials || {});

  const useAuthKey = typeof creds.authKey === 'string';
  const secret = useAuthKey ? creds.authKey : creds.password;

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
      accent_color,
      auth_scheme,
      legacy_login_closed
    FROM users
    WHERE username = ?
  `).get(username);

  if (!user) {
    // No such user — still pay the bcrypt cost of a real comparison
    // so this doesn't return measurably faster than a wrong password
    // for a real username (see the timing side-channel note above).
    await compareAgainstDummyHash(secret);
    return null;
  }

  if (user.is_active === 0) {
    // Same reasoning: a deactivated account shouldn't be
    // distinguishable from a wrong password by response timing
    // either.
    await compareAgainstDummyHash(secret);
    return null;
  }

  const isLegacy = user.auth_scheme === 1;

  // Anti-downgrade: a migrated account never accepts a raw password, and an
  // unmigrated one never accepts an authKey. A closed legacy login behaves
  // exactly like a wrong password.
  const formAllowed =
    useAuthKey
      ? (!isLegacy && isValidAuthKey(secret))
      : (isLegacy && !user.legacy_login_closed && typeof secret === 'string' && secret.length > 0);

  if (!formAllowed) {
    await compareAgainstDummyHash(secret);
    return null;
  }

  const passwordValid =
    await comparePassword(
      secret,
      user.password_hash
    );

  if (!passwordValid) {
    return null;
  }

  if (isLegacy) {
    db.prepare(
      'UPDATE users SET legacy_last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(user.id);
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
    auth_scheme: user.auth_scheme,

    token: signToken({
      id: user.id,
      username: user.username,
      is_admin: Boolean(user.is_admin)
    }),

    ...(isLegacy
      ? { credential_migration: issueTicket(user.id) }
      : {})
  };
}


// `password` is either a raw string (legacy clients; the account starts on
// scheme 1 and migrates at its first login) or
// { authKey, kdfSalt, kdfIterations } (scheme 2, the server never sees the
// password).
async function registerUser(username, email, password) {
  const db = getDb();

  const v2 =
    password && typeof password === 'object'
      ? password
      : null;

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
    v2 &&
    (
      !isValidAuthKey(v2.authKey) ||
      !isValidKdfSalt(v2.kdfSalt) ||
      !isValidIterations(v2.kdfIterations)
    )
  ) {
    const error = new Error('Invalid credentials');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  if (!v2 && (!password || password.length < 6)) {
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
    await hashPassword(v2 ? v2.authKey : password);

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
        email_verified,
        auth_scheme,
        kdf_salt,
        kdf_iterations
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      username,
      email,
      passwordHash,
      initialEmailVerified,
      v2 ? 2 : 1,
      v2 ? v2.kdfSalt : null,
      v2 ? v2.kdfIterations : null
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