// utils/envSecrets.js
//
// One definition of "is this secret usable", shared by the startup
// pre-flight, the setup wizard and config/constants.js. Kept dependency-free
// (fs/path/crypto only) so server.js can use it BEFORE config/constants.js
// runs its fatal checks: a first run must be able to replace .env.example's
// CHANGE_ME values and reach the wizard, instead of exiting first.
//
// Values are parsed the way dotenv v16 parses them (the loader server.js
// uses): optional `export`, optional spaces, and surrounding single, double
// or backtick quotes are removed. Only a double-quoted value expands \n/\r.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

const SECRET_KEYS = ['JWT_SECRET', 'EMAIL_VERIFICATION_SECRET'];

const PLACEHOLDER_SECRETS = new Set(['', 'CHANGE_ME']);

// Example secrets that shipped in .env.example. They are public (they are in
// the repository history), so a deployment that still uses one is not secret.
const EXAMPLE_SECRETS = new Set([
  'a7f3c9e2d1b80456fe2a8c91d4b673e5f01a9c8d7e3b2456a0c7d8e9f1b2c3d4',
  'z6cfcf37ecf2f3956197d01ef9cb1138f020af4b8760f959ddd310df5d0529be7',
]);

const MIN_SECRET_LENGTH = 32;

// Set by prepareFirstRunSecrets() while server.js is between "pre-flight
// replaced the secrets" and "the wizard finished". config/constants.js uses
// it to allow one production first run to reach the wizard. It is a module
// flag, not an environment variable, so it cannot be set from outside.
let firstRunSetupInProgress = false;

function isPlaceholderSecret(value) {
  if (typeof value !== 'string') {
    return true;
  }

  return PLACEHOLDER_SECRETS.has(value.trim().toUpperCase());
}

// Returns why a configured secret is unusable, or null if it is acceptable.
function secretProblem(value) {
  if (typeof value !== 'string') {
    return 'it is missing';
  }

  if (EXAMPLE_SECRETS.has(value)) {
    return 'it is the example value from .env.example';
  }

  if (value.length < MIN_SECRET_LENGTH) {
    return `it must be at least ${MIN_SECRET_LENGTH} characters`;
  }

  return null;
}

function isUsableSecret(value) {
  return typeof value === 'string'
    && !isPlaceholderSecret(value)
    && secretProblem(value) === null;
}

// dotenv v16 (node_modules/dotenv/lib/main.js:12-47).
function parseEnvValue(raw) {
  const value = String(raw ?? '').trim();

  if (value === '') {
    return '';
  }

  const quote = value[0];

  if (quote === '"' || quote === "'" || quote === '`') {
    // Find the closing quote the way dotenv's LINE regex does: an escaped
    // quote does not close the value, and anything after it (a comment) is
    // not part of the value.
    let end = -1;

    for (let i = 1; i < value.length; i++) {
      if (value[i] === '\\') {
        i++;
        continue;
      }

      if (value[i] === quote) {
        end = i;
        break;
      }
    }

    if (end === -1) {
      return value;
    }

    let inner = value.slice(1, end);

    if (quote === '"') {
      inner = inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    }

    return inner;
  }

  const hash = value.indexOf('#');

  if (hash !== -1) {
    return value.slice(0, hash).trim();
  }

  return value;
}

function secretLinePattern(secretKey) {
  return new RegExp(`^\\s*(?:export\\s+)?${secretKey}\\s*=\\s*(.*)$`);
}

// Rewrites envContent so each secret appears exactly once with a usable
// value. An existing usable value is kept exactly as written (quotes
// included); empty/CHANGE_ME/too-short/example values are replaced with
// `fallbacks[key]` when that is usable, otherwise with a fresh 32-byte hex
// secret. Returns the new content and the value chosen for each key, so the
// caller can put the SAME bytes into process.env without a restart.
function ensureSecretEnvLines(envContent, { fallbacks = {} } = {}) {
  const lines = envContent.split('\n');
  const values = {};

  for (const secretKey of SECRET_KEYS) {
    const pattern = secretLinePattern(secretKey);
    const indexes = [];
    let fileValue = null;

    lines.forEach((line, index) => {
      const match = line.match(pattern);

      if (!match) {
        return;
      }

      indexes.push(index);

      if (fileValue === null) {
        const parsed = parseEnvValue(match[1]);

        if (isUsableSecret(parsed)) {
          fileValue = parsed;
        }
      }
    });

    let value = fileValue;

    if (value === null && isUsableSecret(fallbacks[secretKey])) {
      value = fallbacks[secretKey];
    }

    if (value === null) {
      value = crypto.randomBytes(32).toString('hex');
    }

    values[secretKey] = value;

    if (indexes.length === 0) {
      lines.push(`${secretKey}=${value}`);
      continue;
    }

    const first = indexes[0];
    const firstMatch = lines[first].match(pattern);

    if (parseEnvValue(firstMatch[1]) !== value) {
      lines[first] = `${secretKey}=${value}`;
    }

    for (let i = indexes.length - 1; i >= 1; i--) {
      lines.splice(indexes[i], 1);
    }
  }

  return { content: lines.join('\n'), values };
}

// Runs in server.js BEFORE config/constants.js. On a first run
// (SETUP_COMPLETED is not "true") it makes an existing .env contain usable
// secrets and updates process.env to the values it just wrote, so the rest of
// the process uses them without a restart. A missing .env is not created here:
// the values are only needed in process.env before the checks, and the wizard
// writes the file (reusing those values) when setup completes. On a completed
// setup it does nothing: the existing fatal checks stay in force.
function prepareFirstRunSecrets({ envPath = ENV_PATH, env = process.env } = {}) {
  if (env.SETUP_COMPLETED === 'true') {
    firstRunSetupInProgress = false;
    return { firstRun: false, changed: false, values: {} };
  }

  firstRunSetupInProgress = true;

  let content = null;

  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const fallbacks = {};

  for (const key of SECRET_KEYS) {
    if (isUsableSecret(env[key])) {
      fallbacks[key] = env[key];
    }
  }

  const { content: next, values } = ensureSecretEnvLines(content ?? '', { fallbacks });
  let changed = false;

  if (content !== null && next !== content) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, next.trim() + '\n');
    changed = true;
  }

  for (const key of SECRET_KEYS) {
    if (!isUsableSecret(env[key])) {
      env[key] = values[key];
    }
  }

  return { firstRun: true, changed, values };
}

// The pre-flight flag only relaxes the production SETUP_COMPLETED check until
// the wizard has had its chance to run. Call this after runSetupWizard().
function completeFirstRunSetup() {
  firstRunSetupInProgress = false;
}

function isFirstRunSetupInProgress() {
  return firstRunSetupInProgress;
}

module.exports = {
  SECRET_KEYS,
  ENV_PATH,
  MIN_SECRET_LENGTH,
  isPlaceholderSecret,
  secretProblem,
  isUsableSecret,
  parseEnvValue,
  ensureSecretEnvLines,
  prepareFirstRunSecrets,
  completeFirstRunSetup,
  isFirstRunSetupInProgress,
};
