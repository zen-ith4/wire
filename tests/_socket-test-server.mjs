// Child-process fixture for tests/socket-disconnect-order.test.mjs.
//
// Boots the REAL Socket.IO server (real database, real JWT verification) with
// only sockets/dm.socket.js mocked so setupDmSocket() throws SYNCHRONOUSLY on
// connect. That lets the parent drive a real client connection and observe
// whether the server's disconnect handler was registered before the throw.
//
// The uncaughtException handler then runs the listeners the server actually
// registered for 'disconnect' (exactly what Socket.IO would do on a real
// disconnect) and reports the CLEANUP effect: the user must be offline again
// and last_seen_at must have been written to the real database.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dmSocketPath = path.join(ROOT, 'sockets', 'dm.socket');
const resolvedDmSocket = require.resolve(dmSocketPath);

let capturedSocket = null;
let throwCount = 0;

require.cache[resolvedDmSocket] = {
  id: resolvedDmSocket,
  filename: resolvedDmSocket,
  loaded: true,
  exports: {
    setupDmSocket: (io, socket) => {
      capturedSocket = socket;
      throwCount++;
      throw new Error('setupDmSocket threw synchronously');
    },
    setupGroupSocket: () => {},
  }
};

const groupSocketPath = path.join(ROOT, 'sockets', 'group.socket');
const resolvedGroupSocket = require.resolve(groupSocketPath);
require.cache[resolvedGroupSocket] = {
  id: resolvedGroupSocket,
  filename: resolvedGroupSocket,
  loaded: true,
  exports: { setupGroupSocket: () => {} }
};

const { isOnline } = require(path.join(ROOT, 'services', 'presence.service.js'));
const { getDb } = require(path.join(ROOT, 'config', 'database.js'));

process.on('uncaughtException', (err) => {
  if (!(err instanceof Error) || !err.message.includes('setupDmSocket threw')) {
    console.error('UNEXPECTED_UNCAUGHT_EXCEPTION:', err && err.message);
    process.exit(1);
  }

  const userId = capturedSocket?.user?.id;
  const listeners = capturedSocket ? capturedSocket.listeners('disconnect') : [];

  console.log(`DISCONNECT_LISTENER_COUNT:${listeners.length}`);

  // Run exactly the handlers the server registered, as a real disconnect would.
  for (const fn of listeners) {
    try {
      fn('forced close');
    } catch (listenerErr) {
      console.error('DISCONNECT_HANDLER_THREW:', listenerErr && listenerErr.message);
      process.exit(1);
    }
  }

  const offline = userId != null ? !isOnline(userId) : false;
  const row = userId != null
    ? getDb().prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId)
    : null;

  console.log(`CLEANUP_OFFLINE:${offline}`);
  console.log(`CLEANUP_LAST_SEEN:${Boolean(row && row.last_seen_at)}`);
  console.log(`THROW_COUNT:${throwCount}`);

  process.exit(offline && row && row.last_seen_at ? 0 : 2);
});

try {
  const { initDatabase } = require(path.join(ROOT, 'config', 'database.js'));
  initDatabase();

  const server = http.createServer();
  require(path.join(ROOT, 'config', 'socket.js')).setupSocketIO(server);

  server.listen(0, '127.0.0.1', () => {
    console.log(`SERVER_PORT:${server.address().port}`);
  });
} catch (err) {
  console.log('CAUGHT_SYNC_ERROR:', err.message);
  process.exit(1);
}

setTimeout(() => {
  console.log('FORCE_EXIT_TIMEOUT');
  process.exit(1);
}, 15000);
