// Native bcrypt's async hash/compare (utils/password.js) runs on
// libuv's threadpool rather than the main JS thread — that's the
// whole point of the CRITICAL fix in this codebase (see
// utils/password.js). Node's threadpool defaults to only 4 threads,
// which on a multi-core production host means at most 4 password
// hashes/compares can genuinely run in parallel; on a single-core
// box it doesn't add real parallelism (all threads still contend
// for the one core) but it costs nothing there either. This must be
// set before any module touches the threadpool (the first async
// fs/crypto/bcrypt call), so it has to be the very first thing in
// the entry file, before any `require`. 8 is a modest bump from the
// default 4 — enough headroom for concurrent auth traffic on a
// real multi-core deployment without over-subscribing a small host.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');

const constants = require('./config/constants');
const { initDatabase } = require('./config/database');
const { setupSocketIO } = require('./config/socket');
const ensureDirectories = require('./utils/ensureDirectories');
const runSetupWizard = require('./utils/setupWizard');

const { ipRestrict } = require('./middleware/ipRestrict');
const { logger } = require('./middleware/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

async function startServer() {
  try {
    // 1. Ensure required directories & initialise database FIRST
    // The database tables must exist before the setup wizard can insert the admin user.
    ensureDirectories();
    initDatabase();

    // 2. Run setup wizard (only if SETUP_COMPLETED is not 'true')
    await runSetupWizard();

    // 3. Create HTTP server and attach WebSocket support
    const server = http.createServer(app);
    setupSocketIO(server);

    // 4. Express configuration
    app.set('trust proxy', false);
    app.use(express.json());

    // IP restriction runs first and applies to *every* request,
    // static assets included — this is the WireGuard/network access
    // model and must not be weakened or bypassed for any route.
    app.use(ipRestrict);

    // Static assets are served right after the IP gate, before the
    // request logger. They're still fully subject to ipRestrict
    // above (an out-of-subnet request never reaches express.static
    // at all), so nothing about *who* can reach static files
    // changes. What changes is that a successfully-served static
    // asset (css/js/images/fonts on every page load) no longer pays
    // for the logger's per-request bookkeeping (Date.now(), a
    // 'finish' listener, a console.log line) — that instrumentation
    // is genuinely only useful for API calls, and previously ran
    // unconditionally on every single asset request too. Requests
    // that don't match a static file (including all /api/* calls)
    // fall through to logger exactly as before.
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(logger);

    // General-purpose API rate limiting. Everything under /api was
    // previously unprotected except /api/auth/login — this is a
    // generous, IP-keyed backstop against runaway/abusive clients;
    // per-endpoint limiters below add tighter budgets on the
    // specific expensive write operations.
    app.use('/api', apiLimiter);

    // 5. API routes
    app.use('/api/auth', require('./routes/auth.routes'));
    app.use('/api/me', require('./routes/me.routes'));
    app.use(
      '/api/settings',
      require('./routes/settings.routes')
    );
    app.use('/api/files', require('./routes/files.routes'));
    app.use('/api/chat', require('./routes/chat.routes'));
    app.use('/api/dm', require('./routes/dm.routes'));
    app.use('/api/share', require('./routes/share.routes'));
    app.use('/api/admin', require('./routes/admin.routes'));
    app.use('/api/admin/wireguard', require('./routes/wireguard.routes'));

    // 6. 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // 7. Global error handler
    app.use(errorHandler);

    // 8. Start listening on the WireGuard IP (strict binding)
    const PORT = process.env.PORT || constants.PORT || 3000;
    const HOST = process.env.HOST || '127.0.0.1';

    server.listen(PORT, HOST, () => {
      console.log(`
=================================================
      wire started successfully

Address : http://${HOST}:${PORT}
Subnet  : ${constants.ALLOWED_SUBNET}
WG IF   : ${constants.WG_INTERFACE}
Mode    : ${process.env.NODE_ENV}
=================================================
`);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Process-level error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Launch the server
startServer();