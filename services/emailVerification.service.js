const crypto = require('crypto');

const { getDb } = require('../config/database');
const { sendEmail } = require('./email.service');

const CODE_EXPIRY_MS = 10 * 60 * 1000;      // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;       // 1 minute
const MAX_ATTEMPTS = 5;


/**
 * Create a deterministic HMAC of the verification code.
 *
 * The raw OTP is never stored in the database.
 */
function hashCode(code) {
  const secret = process.env.EMAIL_VERIFICATION_SECRET;

  if (!secret) {
    throw new Error(
      'EMAIL_VERIFICATION_SECRET is not configured'
    );
  }

  return crypto
    .createHmac('sha256', secret)
    .update(code)
    .digest('hex');
}


/**
 * Generate a cryptographically secure 6-digit code.
 */
function generateCode() {
  return crypto
    .randomInt(100000, 1000000)
    .toString();
}


/**
 * Create a new verification code and send it by email.
 */
async function createAndSendVerificationCode(user) {
  if (!user || !user.id || !user.email) {
    throw new Error('Invalid user');
  }

  const db = getDb();
  const now = Date.now();

  /*
   * Prevent repeated email sends within the cooldown period.
   */
  const existing = db.prepare(`
    SELECT created_at
    FROM email_verification_codes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(user.id);

  if (
    existing &&
    now - existing.created_at < RESEND_COOLDOWN_MS
  ) {
    const error = new Error(
      'Please wait before requesting another code'
    );

    error.code = 'RESEND_COOLDOWN';

    throw error;
  }

  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = now + CODE_EXPIRY_MS;

  /*
   * Only one active verification code exists per user.
   */
  db.transaction(() => {
    db.prepare(`
      DELETE FROM email_verification_codes
      WHERE user_id = ?
    `).run(user.id);

    db.prepare(`
      INSERT INTO email_verification_codes (
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
  })();

  try {
    await sendEmail({
      to: user.email,

      subject: 'Verify your Wire email',

      text:
        `Your Wire verification code is: ${code}\n\n` +
        `This code expires in 10 minutes.`,

      html: `
        <div style="
          font-family: Arial, sans-serif;
          max-width: 480px;
          margin: 0 auto;
          padding: 32px 20px;
          color: #222;
        ">
          <h2>Verify your Wire email</h2>

          <p>
            Enter the following code in Wire to verify your email address:
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
            If you did not create a Wire account, you can ignore this email.
          </p>
        </div>
      `
    });
  } catch (error) {
    /*
     * Do not leave a valid code in the database if
     * the email could not be sent.
     */
    db.prepare(`
      DELETE FROM email_verification_codes
      WHERE user_id = ?
    `).run(user.id);

    throw error;
  }

  return {
    expiresAt
  };
}


/**
 * Verify a submitted 6-digit code.
 */
async function verifyEmailCode(userId, code) {
  if (!Number.isInteger(userId)) {
    return {
      success: false,
      reason: 'INVALID_USER'
    };
  }

  if (!/^\d{6}$/.test(code || '')) {
    return {
      success: false,
      reason: 'INVALID_CODE'
    };
  }

  const db = getDb();

  const record = db.prepare(`
    SELECT
      id,
      code_hash,
      expires_at,
      attempts
    FROM email_verification_codes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId);

  if (!record) {
    return {
      success: false,
      reason: 'INVALID_CODE'
    };
  }

  /*
   * Expired codes are removed immediately.
   */
  if (Date.now() > record.expires_at) {
    db.prepare(`
      DELETE FROM email_verification_codes
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
  if (record.attempts >= MAX_ATTEMPTS) {
    db.prepare(`
      DELETE FROM email_verification_codes
      WHERE id = ?
    `).run(record.id);

    return {
      success: false,
      reason: 'TOO_MANY_ATTEMPTS'
    };
  }

  /*
   * Count the attempt before comparing the code.
   */
  db.prepare(`
    UPDATE email_verification_codes
    SET attempts = attempts + 1
    WHERE id = ?
  `).run(record.id);

  const submittedHash = hashCode(code);

  const expected = Buffer.from(
    record.code_hash,
    'hex'
  );

  const submitted = Buffer.from(
    submittedHash,
    'hex'
  );

  const valid =
    expected.length === submitted.length &&
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
   * Verification and code deletion happen atomically.
   */
  db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET email_verified = 1
      WHERE id = ?
    `).run(userId);

    db.prepare(`
      DELETE FROM email_verification_codes
      WHERE user_id = ?
    `).run(userId);
  })();

  return {
    success: true
  };
}


module.exports = {
  createAndSendVerificationCode,
  verifyEmailCode
};