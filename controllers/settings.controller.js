const {
  getSecuritySettings,
  beginEnableEmail2FA,
  confirmEnableEmail2FA,
  disableEmail2FA: disableEmail2FAService
} = require('../services/settings.service');


async function getSecurity(req, res) {
  const userId = req.user.id;

  const settings =
    await getSecuritySettings(userId);

  return res.json(settings);
}


async function enableEmail2FA(req, res) {
  const userId = req.user.id;

  const currentPassword =
    typeof req.body?.current_password === 'string'
      ? req.body.current_password
      : '';

  if (!currentPassword) {
    return res.status(400).json({
      error: 'Current password is required'
    });
  }

  try {
    const result =
      await beginEnableEmail2FA(
        userId,
        currentPassword
      );

    return res.json(result);

  } catch (error) {
    if (error.code === 'INVALID_PASSWORD') {
      return res.status(401).json({
        error: 'Current password is incorrect'
      });
    }

    if (error.code === 'EMAIL_NOT_VERIFIED') {
      return res.status(400).json({
        error: 'Your email must be verified before enabling Email 2FA'
      });
    }

    if (error.code === 'ALREADY_ENABLED') {
      return res.status(400).json({
        error: 'Email 2FA is already enabled'
      });
    }

    if (error.code === 'RESEND_COOLDOWN') {
      return res.status(429).json({
        error: 'Please wait before requesting another code'
      });
    }

    throw error;
  }
}


async function verifyEmail2FA(req, res) {
  const userId = req.user.id;

  const challengeId =
    req.body?.challengeId;

  const code =
    typeof req.body?.code === 'string'
      ? req.body.code.trim()
      : '';

  if (!challengeId) {
    return res.status(400).json({
      error: 'Verification session is required'
    });
  }

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({
      error: 'Enter the 6-digit verification code'
    });
  }

  try {
    const result =
      await confirmEnableEmail2FA(
        userId,
        challengeId,
        code
      );

    return res.json(result);

  } catch (error) {
    if (error.code === 'INVALID_CODE') {
      return res.status(400).json({
        error: 'Incorrect verification code'
      });
    }

    if (error.code === 'EXPIRED') {
      return res.status(400).json({
        error: 'This verification code has expired'
      });
    }

    if (error.code === 'TOO_MANY_ATTEMPTS') {
      return res.status(429).json({
        error: 'Too many incorrect attempts. Please request a new code'
      });
    }

    if (error.code === 'INVALID_CHALLENGE') {
      return res.status(400).json({
        error: 'This verification session is no longer valid'
      });
    }

    throw error;
  }
}


async function disableEmail2FA(req, res) {
  const userId = req.user.id;

  const currentPassword =
    typeof req.body?.current_password === 'string'
      ? req.body.current_password
      : '';

  if (!currentPassword) {
    return res.status(400).json({
      error: 'Current password is required'
    });
  }

  try {
    const result =
      await disableEmail2FAService(
        userId,
        currentPassword
      );

    return res.json(result);

  } catch (error) {
    if (error.code === 'INVALID_PASSWORD') {
      return res.status(401).json({
        error: 'Current password is incorrect'
      });
    }

    if (error.code === 'NOT_ENABLED') {
      return res.status(400).json({
        error: 'Email 2FA is not enabled'
      });
    }

    throw error;
  }
}


module.exports = {
  getSecurity,
  enableEmail2FA,
  verifyEmail2FA,
  disableEmail2FA
};