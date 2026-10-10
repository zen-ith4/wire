// Username rules for NEW accounts (registration and admin creation), plus the
// classifier the audit uses on EXISTING accounts.
//
// Rules for a new account (after trim + lowercase):
//   - 3 to 32 characters from [a-z0-9._-]
//   - starts and ends with a letter or digit
//   - no "..", "__" or "--"
//   - not in the reserved list
//
// Existing accounts are never changed or locked out by these rules: login looks
// the name up case-insensitively, so an account stored as "Admin" keeps working.

const MIN_LENGTH = 3;
const MAX_LENGTH = 32;

const RESERVED = Object.freeze([
  'admin',
  'root',
  'system',
  'support',
  'wire',
  'null',
  'undefined',
]);

function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

// Reasons a (already normalized or stored) name breaks the rules for new accounts.
// `uppercase` is only reported for stored names; new input is lowercased first.
function usernameProblems(name) {
  const problems = [];

  if (typeof name !== 'string' || name.length < MIN_LENGTH) problems.push('too_short');
  if (typeof name === 'string' && name.length > MAX_LENGTH) problems.push('too_long');
  if (typeof name !== 'string') return problems;

  if (/[A-Z]/.test(name)) problems.push('uppercase');
  if (/[^A-Za-z0-9._-]/.test(name)) problems.push('bad_characters');
  if (!/^[A-Za-z0-9]/.test(name) || !/[A-Za-z0-9]$/.test(name)) problems.push('bad_edge');
  if (/\.\.|__|--/.test(name)) problems.push('repeated_separator');
  if (RESERVED.includes(name.toLowerCase())) problems.push('reserved');

  return problems;
}

const MESSAGES = {
  too_short: `Username must be at least ${MIN_LENGTH} characters`,
  too_long: `Username must be at most ${MAX_LENGTH} characters`,
  bad_characters: 'Username may only contain letters, numbers, dots, underscores and hyphens',
  bad_edge: 'Username must start and end with a letter or number',
  repeated_separator: 'Username cannot contain "..", "__" or "--"',
  reserved: 'This username is reserved',
};

// -> { ok: true, username } | { ok: false, message, problems }
function validateNewUsername(raw) {
  const username = normalizeUsername(raw);
  const problems = usernameProblems(username);

  if (problems.length > 0) {
    return { ok: false, message: MESSAGES[problems[0]], problems };
  }

  return { ok: true, username };
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  RESERVED,
  normalizeUsername,
  usernameProblems,
  validateNewUsername,
};
