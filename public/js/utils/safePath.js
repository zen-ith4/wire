const path = require('path');

function safeSubPath(basePath, subPath = '') {
  const base = path.resolve(basePath);
  const target = path.resolve(base, subPath);

  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }

  return target;
}

module.exports = {
  safeSubPath,
};