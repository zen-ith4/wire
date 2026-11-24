
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
  