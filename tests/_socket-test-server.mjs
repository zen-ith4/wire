import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('STARTING SERVER SCRIPT');
console.log('CHILD JWT_SECRET:', process.env.JWT_SECRET);

// Mock setupDmSocket to throw SYNCHRONOUSLY
const dmSocketPath = path.join(ROOT, 'sockets', 'dm.socket');
const resolvedDmSocket = require.resolve(dmSocketPath);
console.log('RESOLVED_DM_SOCKET:', resolvedDmSocket);
require.cache[resolvedDmSocket] = {
  id: resolvedDmSocket,
  filename: resolvedDmSocket,
  loaded: true,
  exports: {
    setupDmSocket: (io, socket) => {
      const listenerCount = socket.listenerCount('disconnect');
      console.log(`DISCONNECT_LISTENER_COUNT:${listenerCount}`);
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

process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT_EXCEPTION:', err.message);
  if (err instanceof Error && err.message.includes('setupDmSocket threw')) {
    console.log('CAUGHT_EXPECTED_ERROR');
    process.exit(0);
  }
  console.error('UNEXPECTED_UNCAUGHT_EXCEPTION:', err.message);
  process.exit(1);
});

try {
  // Mock verifySessionToken BEFORE requiring config/socket.js
  const jwtModule = require(path.join(ROOT, 'utils', 'jwt.js'));
  jwtModule.verifySessionToken = function(token) {
    console.log('MOCK verifySessionToken called with token:', token ? 'present' : 'missing');
    return { id: 7, username: 'alice', is_admin: false, tv: 0 };
  };
  
  // Mock the database to return a user
  const dbModule = require(path.join(ROOT, 'config', 'database.js'));
  const mockDb = {
    prepare: (sql) => {
      if (sql.includes('SELECT id, is_active, token_version FROM users WHERE id = ?')) {
        return {
          get: (id) => {
            console.log('MOCK DB query for user:', id);
            return { id: 7, is_active: 1, token_version: 0 };
          }
        };
      }
      return { get: () => null, run: () => ({}), all: () => [] };
    },
    pragma: (key, value) => { console.log('PRAGMA:', key, value); },
    close: () => {},
    transaction: (fn) => fn(),
    exec: () => {},
  };
  
  // Replace the getDb function
  dbModule.getDb = () => mockDb;
  
  // Also mock the constants
  const constants = require(path.join(ROOT, 'config', 'constants'));
  console.log('CHILD CONSTANTS JWT_SECRET:', constants.JWT_SECRET ? 'SET (length: ' + constants.JWT_SECRET.length + ')' : 'NOT SET');
  
  const socketModule = require(path.join(ROOT, 'config', 'socket.js'));
  console.log('SETUP_SOCKET_IO_LOADED');

  const server = http.createServer();
  const io = require(path.join(ROOT, 'config', 'socket.js')).setupSocketIO(server);
  console.log('SOCKET_IO_SETUP_COMPLETE');

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    console.log(`SERVER_PORT:${port}`);
    server.on('close', () => process.exit(0));
  });
} catch (err) {
  console.log('CAUGHT_SYNC_ERROR:', err.message);
  if (err instanceof Error && err.message.includes('setupDmSocket threw')) {
    console.log('CAUGHT_EXPECTED_ERROR_IN_TRY_CATCH');
    process.exit(0);
  }
  console.error('UNEXPECTED_SYNC_ERROR:', err.message);
  process.exit(1);
}

setTimeout(() => {
  console.log('FORCE_EXIT_TIMEOUT');
  process.exit(1);
}, 15000);