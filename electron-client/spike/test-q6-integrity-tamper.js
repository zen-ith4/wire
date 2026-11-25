/**
 * Q6 spike (THROWAWAY, never imported by the product): integrity manifest + tamper tests.
 *
 * Safety: works on a TEMP COPY of public/. It never writes into public/ or into the repo.
 * Run:  xvfb-run -a node_modules/.bin/electron --no-sandbox --disable-gpu spike/test-q6-integrity-tamper.js
 * (--no-sandbox only because the CI container runs as root; spike only, never in the product.)
 * Exit code is 0 only if every expectation holds.
 */
'use strict';
const { app, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wire-bundled',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function buildManifest(rootDir) {
  const files = {};
  (function walk(dir, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.isFile() && !e.name.endsWith('.map')) files[rel] = sha256(fs.readFileSync(path.join(dir, e.name)));
    }
  })(rootDir, '');
  return files;
}

// Pure request handler: returns {status, body}. Manifest acts as an allowlist.
function resolveRequest(rootDir, manifest, rawPathname) {
  let p;
  try { p = decodeURIComponent(rawPathname); } catch { return { status: 400, body: 'bad encoding' }; }
  if (p.includes('\0') || p.includes('\\')) return { status: 403, body: 'forbidden characters' };
  const rel = path.posix.normalize(p.replace(/^\/+/, '') || 'index.html');
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return { status: 403, body: 'path traversal blocked' };
  const expected = manifest[rel];
  if (!expected) return { status: 404, body: 'not in manifest' };
  const full = path.join(rootDir, rel);
  if (!path.resolve(full).startsWith(path.resolve(rootDir) + path.sep)) return { status: 403, body: 'path traversal blocked' };
  let content;
  try { content = fs.readFileSync(full); } catch { return { status: 404, body: 'not found' }; }
  if (sha256(content) !== expected) return { status: 500, body: 'integrity check failed' };
  return { status: 200, body: content, type: MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream' };
}

app.whenReady().then(async () => {
  const src = path.resolve(__dirname, '..', '..', 'public');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-q6-'));
  const root = path.join(tmp, 'public');
  fs.cpSync(src, root, { recursive: true });
  const manifest = buildManifest(root);
  console.log(`[q6] temp copy: ${root}`);
  console.log(`[q6] manifest files: ${Object.keys(manifest).length}`);

  protocol.handle('wire-bundled', (req) => {
    const r = resolveRequest(root, manifest, new URL(req.url).pathname);
    return new Response(r.body, { status: r.status, headers: r.type ? { 'content-type': r.type } : {} });
  });

  const results = [];
  const check = async (name, url, expectStatus) => {
    let status, text = '';
    try { const r = await net.fetch(url); status = r.status; text = (await r.text()).slice(0, 40).replace(/\s+/g, ' '); }
    catch (e) { status = 'EXC ' + e.message; }
    const ok = Array.isArray(expectStatus) ? expectStatus.includes(status) : status === expectStatus;
    results.push({ name, url, status, expected: expectStatus, ok });
    console.log(`[q6] ${ok ? 'PASS' : 'FAIL'} ${name}  ${url}  -> ${status}  ${status === 200 ? '' : '"' + text + '"'}`);
  };

  const O = 'wire-bundled://app/';
  await check('valid file', O + 'index.html', [200, 404]); // 404 only if public/index.html is absent
  const target = fs.existsSync(path.join(root, 'js/core/api.js')) ? 'js/core/api.js' : Object.keys(manifest).find((k) => k.endsWith('.js'));
  await check('valid js before tamper', O + target, 200);
  const f = path.join(root, target); const buf = fs.readFileSync(f); buf[0] ^= 0xff; fs.writeFileSync(f, buf);
  await check('tampered file (1 byte flipped)', O + target, 500);
  fs.writeFileSync(path.join(root, 'injected.js'), 'alert(1)');
  await check('new file not in manifest', O + 'injected.js', 404);
  await check('nonexistent file', O + 'nonexistent.js', 404);
  const trav = ['../etc/passwd', '..%2fetc%2fpasswd', '%2e%2e/%2e%2e/etc/passwd', '..%252fetc%252fpasswd',
    '..\\..\\windows\\system32', '/etc/passwd', 'js/..%2f..%2fetc%2fpasswd', 'index.html%00.js', '%00'];
  for (const t of trav) await check('traversal ' + t, O + t, [400, 403, 404]);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`[q6] SUMMARY total=${results.length} failed=${failed}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
