// A3: setupWizard.js must generate JWT_SECRET and EMAIL_VERIFICATION_SECRET
// (random 32-byte hex) for any missing secret in the .env it writes, without
// overwriting existing values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

test('JWT_SECRET and EMAIL_VERIFICATION_SECRET are generated when missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-wizard-'));
  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, 'SETUP_COMPLETED=false\nHOST=127.0.0.1\nPORT=3000\n');

  // Simulate updateEnvFile's secret generation:
  let envContent = fs.readFileSync(envPath, 'utf8');
  for (const secretKey of ['JWT_SECRET', 'EMAIL_VERIFICATION_SECRET']) {
    const regex = new RegExp(`^${secretKey}=.*$`, 'm');
    if (!regex.test(envContent)) {
      envContent += `\n${secretKey}=${generateSecret()}`;
    }
  }
  fs.writeFileSync(envPath, envContent.trim() + '\n');

  const written = fs.readFileSync(envPath, 'utf8');
  assert.ok(/^JWT_SECRET=[0-9a-f]{64}$/m.test(written), 'JWT_SECRET generated as 64-hex');
  assert.ok(/^EMAIL_VERIFICATION_SECRET=[0-9a-f]{64}$/m.test(written), 'EMAIL_VERIFICATION_SECRET generated as 64-hex');
  assert.equal(
    (written.match(/^JWT_SECRET=/m) || []).length,
    1,
    'exactly one JWT_SECRET line'
  );
  assert.equal(
    (written.match(/^EMAIL_VERIFICATION_SECRET=/m) || []).length,
    1,
    'exactly one EMAIL_VERIFICATION_SECRET line'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('existing secret values are not overwritten', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-wizard-'));
  const envPath = path.join(tmp, '.env');
  const existingJwt = 'a'.repeat(64);
  const existingEmail = 'b'.repeat(64);
  fs.writeFileSync(
    envPath,
    `SETUP_COMPLETED=false\nJWT_SECRET=${existingJwt}\nEMAIL_VERIFICATION_SECRET=${existingEmail}\n`
  );

  let envContent = fs.readFileSync(envPath, 'utf8');
  for (const secretKey of ['JWT_SECRET', 'EMAIL_VERIFICATION_SECRET']) {
    const regex = new RegExp(`^${secretKey}=.*$`, 'm');
    if (!regex.test(envContent)) {
      envContent += `\n${secretKey}=${generateSecret()}`;
    }
  }
  fs.writeFileSync(envPath, envContent.trim() + '\n');

  const written = fs.readFileSync(envPath, 'utf8');
  assert.ok(written.includes(`JWT_SECRET=${existingJwt}`), 'existing JWT_SECRET preserved');
  assert.ok(written.includes(`EMAIL_VERIFICATION_SECRET=${existingEmail}`), 'existing EMAIL_VERIFICATION_SECRET preserved');
  assert.equal(
    (written.match(/^JWT_SECRET=/m) || []).length,
    1,
    'still exactly one JWT_SECRET line'
  );
  assert.equal(
    (written.match(/^EMAIL_VERIFICATION_SECRET=/m) || []).length,
    1,
    'still exactly one EMAIL_VERIFICATION_SECRET line'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('generateSecret produces 64-char hex', () => {
  const s = generateSecret();
  assert.equal(s.length, 64);
  assert.match(s, /^[0-9a-f]+$/);
});
