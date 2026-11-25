// C5: config/constants.js validates every *_MAX_MB as a finite positive number,
// else uses the default. Same style as getDmE2eeDefaultMinVersion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTANTS = path.join(ROOT, 'config', 'constants.js');

function load(env) {
  const clean = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' };
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONSTANTS)})`], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}

function maxMB(env, name) {
  const r = load({ ...env, NODE_ENV: 'development' });
  assert.equal(r.status, 0, `constants should load: ${r.stderr}`);
  // Evaluate the module and access the named export via a wrapper
  const wrapper = `
    const c = require(${JSON.stringify(CONSTANTS)});
    console.log(JSON.stringify({ value: c.${name} }));
  `;
  const cleanEnv = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemPath || '' };
  const wr = spawnSync(process.execPath, ['-e', wrapper], {
    env: { ...cleanEnv, ...env },
    encoding: 'utf8',
  });
  assert.equal(wr.status, 0, `wrapper should run: ${wr.stderr}`);
  return JSON.parse(wr.stdout).value;
}

test('UPLOAD_MAX_MB: valid positive number', () => {
  assert.equal(maxMB({ UPLOAD_MAX_MB: '1024' }, 'UPLOAD_MAX_MB'), 1024);
});

test('UPLOAD_MAX_MB: -1 uses default', () => {
  assert.equal(maxMB({ UPLOAD_MAX_MB: '-1' }, 'UPLOAD_MAX_MB'), 2048);
});

test('UPLOAD_MAX_MB: 0 uses default', () => {
  assert.equal(maxMB({ UPLOAD_MAX_MB: '0' }, 'UPLOAD_MAX_MB'), 2048);
});

test('UPLOAD_MAX_MB: Infinity uses default', () => {
  assert.equal(maxMB({ UPLOAD_MAX_MB: 'Infinity' }, 'UPLOAD_MAX_MB'), 2048);
});

test('UPLOAD_MAX_MB: abc uses default', () => {
  assert.equal(maxMB({ UPLOAD_MAX_MB: 'abc' }, 'UPLOAD_MAX_MB'), 2048);
});

test('UPLOAD_MAX_MB: unset uses default', () => {
  assert.equal(maxMB({}, 'UPLOAD_MAX_MB'), 2048);
});

test('CHAT_UPLOAD_MAX_MB: valid positive number', () => {
  assert.equal(maxMB({ CHAT_UPLOAD_MAX_MB: '25' }, 'CHAT_UPLOAD_MAX_MB'), 25);
});

test('DM_UPLOAD_MAX_MB: valid positive number', () => {
  assert.equal(maxMB({ DM_UPLOAD_MAX_MB: '100' }, 'DM_UPLOAD_MAX_MB'), 100);
});

test('AVATAR_MAX_MB: valid positive number', () => {
  assert.equal(maxMB({ AVATAR_MAX_MB: '10' }, 'AVATAR_MAX_MB'), 10);
});

test('BANNER_MAX_MB: valid positive number', () => {
  assert.equal(maxMB({ BANNER_MAX_MB: '20' }, 'BANNER_MAX_MB'), 20);
});

test('GROUP_UPLOAD_MAX_MB: valid positive number', () => {
  assert.equal(maxMB({ GROUP_UPLOAD_MAX_MB: '75' }, 'GROUP_UPLOAD_MAX_MB'), 75);
});
