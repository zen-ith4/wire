/**
 * Spike test: Integrity manifest generation and verification
 * Sketches a build step that produces SHA-256 hashes of every bundled file
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'spike');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'integrity-manifest.json');

function generateIntegrityManifest() {
  console.log('[spike] Generating integrity manifest...');
  
  const manifest = {
    version: '1.0',
    generated: new Date().toISOString(),
    algorithm: 'SHA-256',
    files: {},
  };
  
  function walkDir(dir, basePath = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
      
      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        // Skip source maps and other build artifacts
        if (entry.name.endsWith('.map')) continue;
        
        const content = fs.readFileSync(path.join(dir, entry.name));
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        
        manifest.files[relativePath] = {
          hash: `sha256-${hash}`,
          size: entry.size,
          // Also store raw hash for compatibility
          rawHash: hash,
        };
      }
    }
  }
  
  walkDir(PUBLIC_DIR);
  
  // Add sw-manifest.js reference if it exists
  const swManifestPath = path.join(PUBLIC_DIR, 'sw-manifest.js');
  if (fs.existsSync(swManifestPath)) {
    const content = fs.readFileSync(swManifestPath, 'utf8');
    // Extract version from sw-manifest.js
    const versionMatch = content.match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
    if (versionMatch) {
      manifest.swManifestVersion = versionMatch[1];
    }
  }
  
  // Write manifest
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  
  console.log('[spike] Integrity manifest generated:', MANIFEST_PATH);
  console.log('[spike] Files hashed:', Object.keys(manifest.files).length);
  
  return manifest;
}

function verifyIntegrity(manifestPath = MANIFEST_PATH) {
  console.log('[spike] Verifying integrity...');
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let passed = 0;
  let failed = 0;
  const failures = [];
  
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    const fullPath = path.join(PUBLIC_DIR, relativePath);
    
    try {
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      
      if (hash === expected.rawHash) {
        passed++;
      } else {
        failed++;
        failures.push({
          file: relativePath,
          expected: expected.rawHash,
          actual: hash,
        });
      }
    } catch (e) {
      failed++;
      failures.push({
        file: relativePath,
        error: e.message,
      });
    }
  }
  
  console.log('[spike] Integrity verification:', passed, 'passed,', failed, 'failed');
  
  if (failed > 0) {
    console.log('[spike] Failures:', JSON.stringify(failures, null, 2));
  }
  
  return { passed, failed, failures };
}

// Protocol handler verification sketch
function protocolHandlerWithIntegrity() {
  return `
// In main.js protocol handler:

const INTEGRITY_MANIFEST = require('./integrity-manifest.json');

protocol.handle('wire-bundled', async (request) => {
  const url = new URL(request.url);
  const filePath = url.pathname.slice(1);
  const normalizedPath = path.normalize(filePath);
  
  // Path traversal protection
  if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
    return new Response('Path traversal blocked', { status: 403 });
  }
  
  // Check integrity manifest
  const expected = INTEGRITY_MANIFEST.files[normalizedPath];
  if (!expected) {
    return new Response('File not in manifest', { status: 404 });
  }
  
  const fullPath = path.join(__dirname, '..', 'public', normalizedPath);
  
  try {
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      return new Response('Not found', { status: 404 });
    }
    
    const publicDir = path.resolve(__dirname, '..', 'public');
    const resolvedPath = path.resolve(fullPath);
    if (!resolvedPath.startsWith(publicDir)) {
      return new Response('Path traversal blocked', { status: 403 });
    }
    
    // VERIFY INTEGRITY
    const content = fs.readFileSync(fullPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    
    if (hash !== INTEGRITY_MANIFEST.files[normalizedPath].rawHash) {
      console.error('INTEGRITY MISMATCH:', normalizedPath);
      return new Response('Integrity check failed', { status: 500 });
    }
    
    // ... serve file
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
});
  `;
}

// Run generation and verification
console.log('[spike] Starting integrity manifest generation...');
const manifest = generateIntegrityManifest();
const verification = verifyIntegrity();

// Write protocol handler sketch
const sketchPath = path.join(OUTPUT_DIR, 'protocol-handler-with-integrity.js');
fs.writeFileSync(path.join(OUTPUT_DIR, 'protocol-handler-with-integrity.js'), protocolHandlerWithIntegrity());

console.log('[spike] Done. Manifest:', path.join(__dirname, 'integrity-manifest.json'));
console.log('[spike] Protocol handler sketch:', path.join(OUTPUT_DIR, 'protocol-handler-with-integrity.js'));