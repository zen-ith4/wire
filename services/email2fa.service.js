const crypto = require('crypto');

const { getDb } = require('../config/database');
const { sendEmail } = require('./email.service');


const CODE_EXPIRY_MS =
  10 * 60 * 1000; // 10 minutes

const RESEND_COOLDOWN_MS =
  60 * 1000; // 1 minute

const MAX_ATTEMPTS =
  5;


/**
 * Create a deterministic HMAC of the 2FA code.
 *
 * The raw OTP is never stored in the database.
 *
 * A separate secret is used from email verification so
 * the two authentication mechanisms remain independent.
 */
function hashCode(code) {
  const secret =
    process.env.EMAIL_2FA_SECRET;

  if (!secret) {
    throw new Error(
      'EMAIL_2FA_SECRET is not configured'
    );
  }

  return crypto
    .createHmac(
      'sha256',
      secret
    )
    .update(code)
    .digest('hex');
}


/**
 * Generate a cryptographically secure 6-digit code.
 */
function generateCode() {
  return crypto
    .randomInt(
      100000,
      1000000
    )
    .toString();
}


/**
 * Create a new 2FA challenge and send the OTP
 * to the user's verified email address.
 */
async function createAndSendTwoFactorCode(user) {
  if (
    !user ||
    !user.id ||
    !user.email
  ) {
    throw new Error(
      'Invalid user'
    );
  }

  const db = getDb();
  const now = Date.now();


  /*
   * Prevent repeated email sends within the
   * cooldown period.
   */
  const existing =
    db.prepare(`
      SELECT
        id,
        created_at
      FROM email_2fa_codes
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(user.id);


  if (
    existing &&
    now - existing.created_at <
      RESEND_COOLDOWN_MS
  ) {
    const error =
      new Error(
        'Please wait before requesting another code'
      );

    error.code =
      'RESEND_COOLDOWN';

    throw error;
  }


  const code =
    generateCode();

  const codeHash =
    hashCode(code);

  const expiresAt =
    now + CODE_EXPIRY_MS;


  /*
   * Only one active 2FA challenge exists
   * per user.
   */
  let challengeId;

  db.transaction(() => {

    db.prepare(`
      DELETE FROM email_2fa_codes
      WHERE user_id = ?
    `).run(user.id);


    const result =
      db.prepare(`
        INSERT INTO email_2fa_codes (
          user_id,
          code_hash,
          expires_at,
          attempts,
          created_at
        )
        VALUES (?, ?, ?, 0, ?)
      `).run(
        user.id,
        codeHash,
        expiresAt,
        now
      );


    challengeId =
      Number(
        result.lastInsertRowid
      );
  })();


  try {

    await sendEmail({
      to: user.email,

      subject:
        'Your Wire sign-in verification code',

      text:
        `Your Wire sign-in verification code is: ${code}\n\n` +
        `This code expires in 10 minutes.\n\n` +
        `If you did not try to sign in to Wire, you can ignore this email.`,

      html: `
        <div style="
          font-family: Arial, sans-serif;
          max-width: 480px;
          margin: 0 auto;
          padding: 32px 20px;
          color: #222;
        ">
          <h2>
            Wire sign-in verification
          </h2>

          <p>
            Enter the following code in Wire
            to complete your sign-in:
          </p>

          <div style="
            margin: 24px 0;
            padding: 18px;
            text-align: center;
            font-size: 32px;
            font-weight: 700;
            letter-spacing: 8px;
            border: 1px solid #ddd;
            border-radius: 10px;
          ">
            ${code}
          </div>

          <p>
            This code expires in 10 minutes.
          </p>

          <p style="
            color: #777;
            font-size: 13px;
          ">
            If you did not try to sign in to Wire,
            you can safely ignore this email.
          </p>
        </div>
      `
    });

  } catch (error) {

    /*
     * Do not leave a valid challenge in the
     * database if the email could not be sent.
     */
    db.prepare(`
      DELETE FROM email_2fa_codes
      WHERE id = ?
    `).run(challengeId);

    throw error;
  }


  return {
    challengeId,
    expiresAt
  };
}


/**
 * Verify a submitted Email 2FA code.
 *
 * This function only verifies the challenge.
 * It does NOT issue a JWT.
 *
 * The controller/auth service should issue the
 * final authentication token only after success.
 */
async function verifyTwoFactorCode(
  userId,
  challengeId,
  code
) {

  if (
    !Number.isInteger(userId)
  ) {
    return {
      success: false,
      reason: 'INVALID_USER'
    };
  }


  const numericChallengeId =
    Number(challengeId);


  if (
    !Number.isSafeInteger(
      numericChallengeId
    ) ||
    numericChallengeId <= 0
  ) {
    return {
      success: false,
      reason: 'INVALID_CHALLENGE'
    };
  }


  if (
    !/^\d{6}$/.test(
      code || ''
    )
  ) {
    return {
      success: false,
      reason: 'INVALID_CODE'
    };
  }


  const db = getDb();


  const record =
    db.prepare(`
      SELECT
        id,
        user_id,
        code_hash,
        expires_at,
        attempts
      FROM email_2fa_codes
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).get(
      numericChallengeId,
      userId
    );


  if (!record) {
    return {
      success: false,
      reason: 'INVALID_CHALLENGE'
    };
  }


  /*
   * Expired challenges are removed immediately.
   */
  if (
    Date.now() >
    record.expires_at
  ) {

    db.prepare(`
      DELETE FROM email_2fa_codes
      WHERE id = ?
    `).run(record.id);


    return {
      success: false,
      reason: 'EXPIRED'
    };
  }


  /*
   * Do not allow unlimited guesses.
   */
  if (
    record.attempts >=
    MAX_ATTEMPTS
  ) {

    db.prepare(`
      DELETE FROM email_2fa_codes
      WHERE id = ?
    `).run(record.id);


    return {
      success: false,
      reason: 'TOO_MANY_ATTEMPTS'
    };
  }


  /*
   * Count the attempt before comparing
   * the submitted code.
   */
  db.prepare(`
    UPDATE email_2fa_codes
    SET attempts = attempts + 1
    WHERE id = ?
  `).run(record.id);


  const submittedHash =
    hashCode(code);


  const expected =
    Buffer.from(
      record.code_hash,
      'hex'
    );

  const submitted =
    Buffer.from(
      submittedHash,
      'hex'
    );


  const valid =
    expected.length ===
      submitted.length &&
    crypto.timingSafeEqual(
      expected,
      submitted
    );


  if (!valid) {
    return {
      success: false,
      reason: 'INVALID_CODE'
    };
  }


  /*
   * Successful verification consumes
   * the challenge immediately.
   */
  db.prepare(`
    DELETE FROM email_2fa_codes
    WHERE id = ?
  `).run(record.id);


  return {
    success: true
  };
}


module.exports = {
  createAndSendTwoFactorCode,
  verifyTwoFactorCode
};