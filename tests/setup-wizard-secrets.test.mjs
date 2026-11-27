// A3: the setup wizard's real updateEnvFile() must leave the .env with one
// usable value per secret:
//   - a missing, empty or CHANGE_ME line is replaced with a fresh 32-byte hex
//     secret;
//   - a valid existing value is never overwritten;
//   - the key is never duplicated in the file.
//
// The method is called on a temp .env (never the repo's), via the exported
// class without constructing its readline interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SetupWizard } = require(path.join(ROOT, 'utils', 'setupWizard.js'));

const CONFIG = {
  expressHost: '127.0.0.1',
  publicHost: '127.0.0.1',
  port: '3000',
  httpsMode: 'none',
  domain: '',
  tlsFingerprint: '',
};

const SECRET_LINE = (key, value) => new RegExp(`^${key}=${value}$`, 'm');
const HEX64 = '[0-9a-f]{64}';
const SECRET_KEYS = ['JWT_SECRET', 'EMAIL_VERIFICATION_SECRET'];

// The test runner itself is started with tests/test.env, which sets
// JWT_SECRET. updateEnvFile() deliberately reuses a usable process.env value
// so the file and the running process cannot disagree, so these cases must
// clear it to exercise "nothing configured anywhere" and restore afterwards.
function withoutProcessSecrets(fn) {
  const saved = SECRET_KEYS.map((key) => [key, process.env[key]]);

  for (const key of SECRET_KEYS) delete process.env[key];

  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withTempEnv(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-wizard-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, contents);
  // Neither the constructor nor run() is used: only the real method.
  const wizard = Object.create(SetupWizard.prototype);
  try {
    return withoutProcessSecrets(() => fn({ dir, envFile, wizard }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const countLines = (text, key) =>
  (text.match(new RegExp(`^${key}=`, 'gm')) || []).length;

test('missing secrets: both are generated once as 64-char hex', () => {
  withTempEnv('SETUP_COMPLETED=false\nHOST=127.0.0.1\nPORT=3000\n', ({ envFile, wizard }) => {
    wizard.updateEnvFile(CONFIG, envFile);

    const written = fs.readFileSync(envFile, 'utf8');
    assert.match(written, SECRET_LINE('JWT_SECRET', HEX64));
    assert.match(written, SECRET_LINE('EMAIL_VERIFICATION_SECRET', HEX64));
    assert.equal(countLines(written, 'JWT_SECRET'), 1);
    assert.equal(countLines(written, 'EMAIL_VERIFICATION_SECRET'), 1);
  });
});

test('empty and CHANGE_ME values are replaced with random secrets', () => {
  withTempEnv(
    'SETUP_COMPLETED=false\nJWT_SECRET=\nEMAIL_VERIFICATION_SECRET=CHANGE_ME\n',
    ({ envFile, wizard }) => {
      wizard.updateEnvFile(CONFIG, envFile);

      const written = fs.readFileSync(envFile, 'utf8');
      assert.doesNotMatch(written, /^JWT_SECRET=\s*$/m, 'empty JWT_SECRET was replaced');
      assert.doesNotMatch(written, /^EMAIL_VERIFICATION_SECRET=CHANGE_ME$/m, 'placeholder was replaced');
      assert.match(written, SECRET_LINE('JWT_SECRET', HEX64));
      assert.match(written, SECRET_LINE('EMAIL_VERIFICATION_SECRET', HEX64));
      assert.equal(countLines(written, 'JWT_SECRET'), 1);
      assert.equal(countLines(written, 'EMAIL_VERIFICATION_SECRET'), 1);
    }
  );
});

test('a usable secret already in process.env is written to the file, not replaced', () => {
  const runningJwt = 'd'.repeat(64);

  withTempEnv(
    'SETUP_COMPLETED=false\nJWT_SECRET=CHANGE_ME\nEMAIL_VERIFICATION_SECRET=\n',
    ({ envFile, wizard }) => {
      process.env.JWT_SECRET = runningJwt;
      wizard.updateEnvFile(CONFIG, envFile);

      const written = fs.readFileSync(envFile, 'utf8');
      assert.match(written, SECRET_LINE('JWT_SECRET', runningJwt),
        'the running process keeps its value and the file matches it');
      assert.equal(process.env.JWT_SECRET, runningJwt);
      assert.match(written, SECRET_LINE('EMAIL_VERIFICATION_SECRET', HEX64),
        'the secret with no usable value anywhere is still generated');
      assert.match(process.env.EMAIL_VERIFICATION_SECRET, new RegExp(`^${HEX64}$`));
    }
  );
});

test('quoted values are read the way dotenv reads them', () => {
  const jwt = 'f'.repeat(64);

  withTempEnv(
    `export JWT_SECRET="${jwt}" # kept\nEMAIL_VERIFICATION_SECRET="CHANGE_ME"\n`,
    ({ envFile, wizard }) => {
      wizard.updateEnvFile(CONFIG, envFile);

      const written = fs.readFileSync(envFile, 'utf8');
      assert.match(written, new RegExp(`^export JWT_SECRET="${jwt}" # kept$`, 'm'),
        'a usable double-quoted value (with export and comment) is untouched');
      assert.doesNotMatch(written, /^EMAIL_VERIFICATION_SECRET="CHANGE_ME"$/m,
        'a quoted placeholder is replaced');
      assert.match(written, SECRET_LINE('EMAIL_VERIFICATION_SECRET', HEX64));
    }
  );
});

test('valid existing secrets are preserved byte for byte', () => {
  const jwt = 'a'.repeat(64);
  const email = 'b'.repeat(64);

  withTempEnv(
    `SETUP_COMPLETED=false\nJWT_SECRET=${jwt}\nEMAIL_VERIFICATION_SECRET=${email}\n`,
    ({ envFile, wizard }) => {
      wizard.updateEnvFile(CONFIG, envFile);

      const written = fs.readFileSync(envFile, 'utf8');
      assert.match(written, SECRET_LINE('JWT_SECRET', jwt));
      assert.match(written, SECRET_LINE('EMAIL_VERIFICATION_SECRET', email));
      assert.equal(countLines(written, 'JWT_SECRET'), 1);
      assert.equal(countLines(written, 'EMAIL_VERIFICATION_SECRET'), 1);
    }
  );
});

test('duplicate secret lines collapse to one, keeping the first valid value', () => {
  const jwt = 'c'.repeat(64);

  withTempEnv(
    `JWT_SECRET=${jwt}\nJWT_SECRET=CHANGE_ME\nEMAIL_VERIFICATION_SECRET=\nEMAIL_VERIFICATION_SECRET=CHANGE_ME\n`,
    ({ envFile, wizard }) => {
      wizard.updateEnvFile(CONFIG, envFile);

      const written = fs.readFileSync(envFile, 'utf8');
      assert.equal(countLines(written, 'JWT_SECRET'), 1, 'no duplicate JWT_SECRET');
      assert.equal(countLines(written, 'EMAIL_VERIFICATION_SECRET'), 1, 'no duplicate EMAIL_VERIFICATION_SECRET');
      assert.match(written, SECRET_LINE('JWT_SECRET', jwt), 'the valid value wins');
      assert.match(written, SECRET_LINE('EMAIL_VERIFICATION_SECRET', HEX64));
    }
  );
});
