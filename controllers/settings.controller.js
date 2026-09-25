const {
  getSecuritySettings,
  beginEnableEmail2FA,
  confirmEnableEmail2FA,
  disableEmail2FA: disableEmail2FAService
} = require('../services/settings.service');

const {
  getPrivacySettings,
  updatePrivacySettings
} = require('../services/user.service');

const { isOnline } = require('../services/presence.service');
const { emit } = require('../services/socket.service');


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

    if (error.code === 'EMAIL_DISABLED') {
      return res.status(409).json({
        error: 'Email 2FA is unavailable because the email feature is disabled'
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

    if (error.code === 'EMAIL_DISABLED') {
      return res.status(409).json({
        error: 'Email 2FA is unavailable because the email feature is disabled'
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


// GET /api/settings/privacy
async function getPrivacy(req, res) {
  const settings = getPrivacySettings(req.user.id);
  return res.json(settings);
}


// PUT /api/settings/privacy
//
// Each field is independent (see updatePrivacySettings): sending only
// one of them leaves the other untouched, so disabling "Send Read
// Receipts" can never accidentally disable "Show Last Seen" or vice
// versa.
async function updatePrivacy(req, res) {
  const body = req.body || {};

  const updates = {};
  if (typeof body.show_last_seen === 'boolean') {
    updates.show_last_seen = body.show_last_seen;
  }
  if (typeof body.send_read_receipts === 'boolean') {
    updates.send_read_receipts = body.send_read_receipts;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      error: 'No valid privacy settings provided'
    });
  }

  const result = updatePrivacySettings(req.user.id, updates);

  // If Show Last Seen changed while the user is currently online,
  // reflect that immediately rather than waiting for their next
  // connect/disconnect — other connected clients should stop (or
  // start) seeing this user's presence in real time, same as any
  // other presence event (see config/socket.js).
  if ('show_last_seen' in updates && isOnline(req.user.id)) {
    if (result.show_last_seen) {
      emit('chat', 'presence:online', { user_id: req.user.id });
    } else {
      // No last_seen_at here: hiding presence must not hand out a
      // timestamp in the same event that's supposed to hide them.
      emit('chat', 'presence:offline', { user_id: req.user.id, last_seen_at: null });
    }
  }

  return res.json(result);
}


module.exports = {
  getSecurity,
  enableEmail2FA,
  verifyEmail2FA,
  disableEmail2FA,
  getPrivacy,
  updatePrivacy
};