function isValidFolderName(name) {
  if (typeof name !== 'string') {
    return false;
  }

  const value = name.trim();

  return (
    value.length > 0 &&
    value.length <= 60 &&
    /^[a-zA-Z0-9 _.-]+$/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function isValidUsername(username) {
  if (typeof username !== 'string') {
    return false;
  }

  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function isValidPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= 6 &&
    password.length <= 128
  );
}

module.exports = {
  isValidFolderName,
  isValidUsername,
  isValidPassword,
};