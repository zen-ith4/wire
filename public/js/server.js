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
    app.use(ipRestrict);
    app.use(logger);
    app.use(express.static(path.join(__dirname, 'public')));

    // 5. API routes
    app.use('/api/auth', require('./routes/auth.routes'));
    app.use('/api/me', require('./routes/me.routes'));
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