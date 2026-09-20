// Stub backend for measuring the Wire frontend.
//  - serves a public/ tree with Express-static-like headers (ETag, Last-Modified, Cache-Control: public, max-age=0)
//  - mocks the /api/* endpoints the four main tabs use, with configurable per-request latency
//  - records every request (method, path, status) so tests can assert on network behaviour
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.jpg':'image/jpeg', '.ico':'image/x-icon', '.json':'application/json', '.png':'image/png', '.woff2':'font/woff2' };

function start({ root, port = 0, latencyMs = 0, staticLatencyMs = 0 }) {
  const state = { latencyMs, staticLatencyMs, log: [], root };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const me = { id: 1, username: 'alice', email: 'alice@example.com', is_admin: false, accent_color: '#6366f1', bio: 'hello', has_avatar: false, has_banner: false };
  const folders = [1,2,3].map(i => ({ id: i, display_name: 'Folder ' + i, can_write: true }));
  const entries = Array.from({ length: 30 }, (_, i) => ({ name: 'file-' + i + '.txt', type: i % 7 === 0 ? 'dir' : 'file', size: 1000 * i, modified: new Date(1.7e12 + i * 1e6).toISOString() }));
  const chat = state.chat = Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i, user_id: i % 2 ? 1 : 2, username: i % 2 ? 'alice' : 'bob',
    content: 'message number ' + i, timestamp: new Date(1.7e12 + i * 60000).toISOString(), has_attachment: false, reactions: [] }));
  const convs = [2,3,4].map(p => ({ peer_id: p, username: 'user' + p, last_message: 'hey from ' + p, last_timestamp: new Date(1.7e12).toISOString(), unread_count: 0 }));
  const dmMsgs = p => Array.from({ length: 20 }, (_, i) => ({ id: p * 100 + i, sender_id: i % 2 ? 1 : p, recipient_id: i % 2 ? p : 1, content: 'dm ' + i, timestamp: new Date(1.7e12 + i * 60000).toISOString(), reactions: [] }));

  state.data = { me, folders, entries, chat, convs };

  function api(req, u) {
    const p = u.pathname;
    if (p === '/api/me') return me;
    if (p === '/api/files/folders') return folders;
    if (p === '/api/share/mine') return { folders: [{ id: 1, shared_with_count: 1 }] };
    if (p.startsWith('/api/files/list/')) return { entries, can_write: true };
    if (p === '/api/chat/messages/recent') return state.chat;
    if (p === '/api/dm/conversations') return convs;
    if (p === '/api/dm/unread-count') return { count: 0 };
    if (/^\/api\/dm\/messages\/\d+\/recent$/.test(p)) return dmMsgs(Number(p.split('/')[4]));
    if (/^\/api\/dm\/messages\/\d+\/since$/.test(p)) return [];
    if (p === '/api/settings/security') return { email_2fa_enabled: false, email_enabled: false };
    if (p === '/api/share/users') return [];
    return undefined;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: u.pathname + u.search, t: Date.now(), status: 0, range: !!req.headers.range };
    state.log.push(entry);
    const done = (status) => { entry.status = status; };

    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/socket.io/')) {
      const body = u.pathname.startsWith('/api/') ? api(req, u) : undefined;
      const respond = () => {
        if (u.pathname.startsWith('/api/me/avatar') || u.pathname.startsWith('/api/me/banner')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"none"}'); return done(404); }
        if (body === undefined) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not mocked"}'); return done(404); }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body)); done(200);
      };
      return setTimeout(respond, state.latencyMs);
    }

    // static, Express-like
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(state.root, rel);
    if (!file.startsWith(state.root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nf'); return done(404);
    }
    const st = fs.statSync(file);
    if (state.staticLatencyMs && !u.pathname.endsWith('sw.js') && !u.pathname.endsWith('sw-manifest.js')) { return setTimeout(() => serveStatic(), state.staticLatencyMs); }
    return serveStatic();
    function serveStatic() {
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'etag': etag,
      'last-modified': st.mtime.toUTCString(), 'cache-control': 'public, max-age=0' };
    if (path.basename(file) === 'sw.js') headers['service-worker-allowed'] = '/';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return done(304); }
    res.writeHead(200, headers); fs.createReadStream(file).pipe(res); done(200);
    }
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    state.port = server.address().port; state.server = server; state.url = 'http://127.0.0.1:' + state.port;
    resolve(state);
  }));
}
module.exports = { start };
