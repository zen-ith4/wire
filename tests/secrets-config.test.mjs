// P0-2: the server must refuse to start with the example secrets from
// .env.example, with secrets shorter than 32 characters, or with a missing
// EMAIL_VERIFICATION_SECRET in production. Each case runs config/constants.js
// in a fresh child process with a clean environment, because the check is
// a process-level fatal exit at module load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTANTS = path.join(ROOT, 'config', 'constants.js');

const OLD_JWT_EXAMPLE = 'a7f3c9e2d1b80456fe2a8c91d4b673e5f01a9c8d7e3b2456a0c7d8e9f1b2c3d4';
const OLD_EMAIL_EXAMPLE = 'z6cfcf37ecf2f3956197d01ef9cb1138f020af4b8760f959ddd310df5d0529be7';
const GOOD_JWT = 'j'.repeat(40);
const GOOD_EMAIL = 'e'.repeat(40);

function load(env) {
  const clean = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' };
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONSTANTS)})`], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}

test('example JWT_SECRET is refused in development', () => {
  const r = load({ NODE_ENV: 'development', JWT_SECRET: OLD_JWT_EXAMPLE });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /JWT_SECRET is unsafe: it is the example value/);
});

test('example JWT_SECRET is refused in production', () => {
  const r = load({
    NODE_ENV: 'production', SETUP_COMPLETED: 'true', ALLOWED_SUBNET: '10.10.0.0/24',
    JWT_SECRET: OLD_JWT_EXAMPLE, EMAIL_VERIFICATION_SECRET: GOOD_EMAIL,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /example value/);
});

test('JWT_SECRET shorter than 32 characters is refused in any environment', () => {
  for (const NODE_ENV of ['development', 'production']) {
    const r = load({
      NODE_ENV, SETUP_COMPLETED: 'true', ALLOWED_SUBNET: '10.10.0.0/24',
      JWT_SECRET: 'CHANGE_ME', EMAIL_VERIFICATION_SECRET: GOOD_EMAIL,
    });
    assert.equal(r.status, 1, `${NODE_ENV}: ${r.stderr}`);
    assert.match(r.stderr, /at least 32 characters/);
  }
});

test('example EMAIL_VERIFICATION_SECRET is refused in any environment', () => {
  const r = load({ NODE_ENV: 'development', JWT_SECRET: GOOD_JWT, EMAIL_VERIFICATION_SECRET: OLD_EMAIL_EXAMPLE });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /EMAIL_VERIFICATION_SECRET is unsafe/);
});

test('short EMAIL_VERIFICATION_SECRET is refused in development', () => {
  const r = load({ NODE_ENV: 'development', JWT_SECRET: GOOD_JWT, EMAIL_VERIFICATION_SECRET: 'CHANGE_ME' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /EMAIL_VERIFICATION_SECRET is unsafe: it must be at least 32/);
});

test('missing EMAIL_VERIFICATION_SECRET is refused in production', () => {
  const r = load({
    NODE_ENV: 'production', SETUP_COMPLETED: 'true', ALLOWED_SUBNET: '10.10.0.0/24',
    JWT_SECRET: GOOD_JWT,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /EMAIL_VERIFICATION_SECRET is required in production/);
});

test('missing EMAIL_VERIFICATION_SECRET is still allowed in development', () => {
  const r = load({ NODE_ENV: 'development', JWT_SECRET: GOOD_JWT });
  assert.equal(r.status, 0, r.stderr);
});

test('a production config with strong secrets starts', () => {
  const r = load({
    NODE_ENV: 'production', SETUP_COMPLETED: 'true', ALLOWED_SUBNET: '10.10.0.0/24',
    JWT_SECRET: GOOD_JWT, EMAIL_VERIFICATION_SECRET: GOOD_EMAIL,
  });
  assert.equal(r.status, 0, r.stderr);
});

test('.env.example ships no real or example secret values', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const value = (name) => {
    const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  for (const name of ['JWT_SECRET', 'EMAIL_VERIFICATION_SECRET']) {
    const v = value(name);
    assert.notEqual(v, undefined, `${name} missing from .env.example`);
    assert.notEqual(v, OLD_JWT_EXAMPLE);
    assert.notEqual(v, OLD_EMAIL_EXAMPLE);
    assert.equal(v, 'CHANGE_ME', `${name} should be a CHANGE_ME placeholder`);
  }
});
