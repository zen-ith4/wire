#!/usr/bin/env node
// scripts/smoke.mjs - READ-ONLY post-deploy smoke test for a Wire server.
//
// Run it from the ROOT of the repo checkout that was deployed (it imports
// public/js/crypto/credentials.js to derive the login key the same way the
// browser does). Needs Node >= 20 (global fetch + WebCrypto).
//
//   WIRE_URL=https://your.server \
//   SMOKE_USER=someuser SMOKE_PASS='their password' \
//   EXPECT_APK=1 \
//   node scripts/smoke.mjs
//
// It never registers, writes, uploads or sends anything. Use an EXISTING,
// ordinary account (not an admin). Message sending and uploads are E2EE flows
// that need a real client: do those from docs/MANUAL_TEST_CHECKLIST.md.
//
// Environment:
//   WIRE_URL     required, no trailing slash needed
//   SMOKE_USER   optional; without it the login checks are SKIPPED (not passed)
//   SMOKE_PASS   required if SMOKE_USER is set
//   EXPECT_APK   "1" = the APK must be deployed (available:true, 64-hex sha256,
//                and /api/apk/download must hash to the advertised value)
//   INSECURE_TLS "1" = accept a self-signed certificate (sets
//                NODE_TLS_REJECT_UNAUTHORIZED=0 for this process only)
//
// Exit code: 0 = every check passed, 1 = at least one FAIL, 2 = bad usage.
// SKIP and WARN do not fail the run but are printed so nobody mistakes them for passes.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = (process.env.WIRE_URL || '').replace(/\/+$/, '');
const user = process.env.SMOKE_USER || '';
const pass = process.env.SMOKE_PASS || '';
const expectApk = process.env.EXPECT_APK === '1';

if (!base) {
  console.error('usage: WIRE_URL=https://server [SMOKE_USER=.. SMOKE_PASS=..] [EXPECT_APK=1] node scripts/smoke.mjs');
  process.exit(2);
}
if (user && !pass) {
  console.error('SMOKE_PASS is required when SMOKE_USER is set');
  process.exit(2);
}
if (process.env.INSECURE_TLS === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name });
  console.log(`${status.padEnd(4)}  ${name}${detail ? '  - ' + detail : ''}`);
}
const pass_ = (n, d) => record('PASS', n, d);
const fail_ = (n, d) => record('FAIL', n, d);
const skip_ = (n, d) => record('SKIP', n, d);
const warn_ = (n, d) => record('WARN', n, d);

async function http(p, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (raw) return res;
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function main() {
  console.log(`Wire smoke test -> ${base}\n`);

  // 1. server is up
  try {
    const r = await http('/api/version');
    if (r.status === 200) pass_('GET /api/version', JSON.stringify(r.json ?? r.text).slice(0, 80));
    else fail_('GET /api/version', `status ${r.status}`);
  } catch (e) {
    fail_('GET /api/version', `cannot reach server: ${e.message}`);
    return;
  }

  // 2. APK integrity metadata (fail-closed clients REQUIRE sha256)
  let advertised = null;
  try {
    const r = await http('/api/apk/info');
    if (r.status !== 200) {
      fail_('GET /api/apk/info', `status ${r.status}`);
    } else if (r.json?.available === true) {
      const h = r.json.sha256;
      if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) {
        advertised = h;
        pass_('/api/apk/info advertises available:true + 64-hex sha256', h.slice(0, 16) + '...');
      } else {
        fail_('/api/apk/info is available:true but sha256 is missing/invalid',
          'updated clients will REFUSE this server');
      }
    } else if (expectApk) {
      fail_('/api/apk/info available:false', 'EXPECT_APK=1 but no APK is deployed (check APK_PATH)');
    } else {
      warn_('/api/apk/info available:false', 'no APK deployed; fine only if you are not shipping a client update yet');
      if (r.json && 'sha256' in r.json) fail_('/api/apk/info must not carry sha256 when unavailable', JSON.stringify(r.json.sha256));
    }
  } catch (e) {
    fail_('GET /api/apk/info', e.message);
  }

  // 3. the served APK bytes hash to the advertised value
  if (advertised) {
    try {
      const res = await http('/api/apk/download', { raw: true });
      if (res.status !== 200) {
        fail_('GET /api/apk/download', `status ${res.status}`);
      } else {
        const h = createHash('sha256');
        let n = 0;
        for await (const chunk of res.body) { h.update(chunk); n += chunk.length; }
        const got = h.digest('hex');
        if (got === advertised) pass_('/api/apk/download bytes match the advertised sha256', `${n} bytes`);
        else fail_('/api/apk/download bytes do NOT match the advertised sha256', `got ${got.slice(0, 16)}...`);
      }
    } catch (e) {
      fail_('GET /api/apk/download', e.message);
    }
  } else if (expectApk) {
    skip_('/api/apk/download hash check', 'no advertised hash');
  }

  // 4. CORS: no credentialed CORS, ever
  try {
    const r = await http('/api/version', { headers: { Origin: 'https://evil.example' } });
    const acao = r.headers.get('access-control-allow-origin');
    const acac = r.headers.get('access-control-allow-credentials');
    if (acac && acac.toLowerCase() === 'true') fail_('CORS must not send Access-Control-Allow-Credentials: true', `ACAO=${acao}`);
    else pass_('CORS sends no Access-Control-Allow-Credentials: true', `ACAO=${acao ?? '(none)'}`);
  } catch (e) {
    fail_('CORS header check', e.message);
  }

  // 5. login (scheme-aware) and a couple of authenticated READ calls
  if (!user) {
    skip_('login + authenticated reads', 'SMOKE_USER not set (this is NOT a pass)');
    return;
  }

  let token = null;
  try {
    const kp = await http(`/api/auth/kdf-params?username=${encodeURIComponent(user)}`);
    if (kp.status !== 200) {
      fail_('GET /api/auth/kdf-params', `status ${kp.status}`);
    } else {
      let body;
      if (kp.json?.scheme === 2) {
        const modPath = path.resolve(process.cwd(), 'public/js/crypto/credentials.js');
        const { deriveCredentials } = await import(pathToFileURL(modPath).href);
        const derived = await deriveCredentials(pass, kp.json.salt, kp.json.iterations);
        body = { username: user, auth_key: derived.authKey };
      } else if (kp.json?.scheme === 1) {
        warn_('account is scheme 1 (raw password login)', 'not migrated yet: expected for old accounts only');
        body = { username: user, password: pass };
      } else {
        fail_('kdf-params answered with an unknown scheme', JSON.stringify(kp.json));
      }
      if (body) {
        const r = await http('/api/auth/login', { method: 'POST', body });
        if (r.status === 200 && typeof r.json?.token === 'string') {
          token = r.json.token;
          pass_('POST /api/auth/login', `scheme ${kp.json.scheme}, token received`);
        } else if (r.status === 200) {
          warn_('login returned 200 without a token', 'account may need email verification or 2FA: ' + Object.keys(r.json || {}).join(','));
        } else {
          fail_('POST /api/auth/login', `status ${r.status}`);
        }
      }
    }
  } catch (e) {
    fail_('login flow', e.message);
  }

  if (!token) {
    skip_('authenticated reads', 'no token');
    return;
  }

  const auth = { Authorization: `Bearer ${token}` };

  // The group API refuses clients that do not declare a new enough protocol
  // (426 + min_group_protocol). Start at 2 and follow the server's own minimum.
  let proto = '2';
  try {
    let r = await http('/api/groups/limits', { headers: { ...auth, 'X-Wire-Group-Proto': proto } });
    if (r.status === 426 && Number.isInteger(r.json?.min_group_protocol)) {
      proto = String(r.json.min_group_protocol);
      r = await http('/api/groups/limits', { headers: { ...auth, 'X-Wire-Group-Proto': proto } });
    }
    if (r.status === 200) pass_('GET /api/groups/limits (authenticated)', `proto ${proto}: ` + JSON.stringify(r.json).slice(0, 70));
    else fail_('GET /api/groups/limits (authenticated)', `status ${r.status}`);
  } catch (e) {
    fail_('GET /api/groups/limits', e.message);
  }

  try {
    const r = await http('/api/groups/limits', { headers: { 'X-Wire-Group-Proto': proto } });
    if (r.status === 401) pass_('the same call WITHOUT a token is refused (401)');
    else fail_('unauthenticated call was not refused', `status ${r.status}`);
  } catch (e) {
    fail_('unauthenticated refusal check', e.message);
  }
}

await main();

const failed = results.filter((r) => r.status === 'FAIL').length;
const passed = results.filter((r) => r.status === 'PASS').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const warned = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, ${warned} warnings`);
if (skipped) console.log('SKIPPED checks were NOT verified.');
process.exit(failed ? 1 : 0);
