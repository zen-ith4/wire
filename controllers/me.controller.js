const fs = require('fs');
const path = require('path');

const constants = require('../config/constants');

const {
  findUserById,
  findUserWithPassword,
  updateBio: updateUserBio,
  updateAccentColor: updateUserAccentColor,
  updateAvatar: updateUserAvatar,
  updateBanner: updateUserBanner,
  updatePassword: updateUserPassword,
  getStorageUsage,
} = require('../services/user.service');

const { comparePassword } = require('../utils/password');
const { AVATAR_MIME_MAP } = require('../config/multer');
const {
  emitProfileAvatarUpdate,
  emitProfileBannerUpdate,
} = require('../services/socket.service');


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
    created_at: user.created_at
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
function changePassword(req, res) {
  const {
    current_password,
    new_password
  } = req.body || {};

  if (!current_password || !new_password) {
    return res.status(400).json({
      error: 'Current and new password required'
    });
  }

  if (new_password.length < 6) {
    return res.status(400).json({
      error: 'New password must be at least 6 characters'
    });
  }

  const user = findUserWithPassword(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  if (!comparePassword(current_password, user.password_hash)) {
    return res.status(401).json({
      error: 'Current password is incorrect'
    });
  }

  updateUserPassword(
    req.user.id,
    new_password
  );

  res.json({
    success: true
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

  fs.createReadStream(filePath)
    .pipe(res);
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

  fs.createReadStream(filePath)
    .pipe(res);
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

  res.json({
    id: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    bio: user.bio || '',
    has_avatar: !!user.avatar_path,
    has_banner: !!user.banner_path,
    accent_color: user.accent_color || null,
    created_at: user.created_at,
    storage_used: getStorageUsage(user.id)
  });
}


module.exports = {
  getMe,
  updateBio,
  updateAccentColor,
  changePassword,
  uploadAvatar,
  removeAvatar,
  getAvatar,
  uploadBanner,
  removeBanner,
  getBanner,
  getUserProfile
};