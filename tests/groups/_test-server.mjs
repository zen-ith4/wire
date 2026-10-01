// tests/groups/_test-server.mjs
//
// Boots a *real* instance of the app's HTTP + Socket.IO server for
// integration testing: real Express routes, real controllers, real
// services, real better-sqlite3 database (schema + migrations run
// for real), real JWT auth middleware, real config/socket.js. The
// only thing this harness skips vs. server.js is production-only
// bootstrap concerns that have nothing to do with the group
// round-trip being tested: ipRestrict, the interactive setup wizard,
// and static asset hosting.
//
// Must be imported AFTER the caller has set process.env.JWT_SECRET,
// process.env.GROUPS_ENABLED = 'true', and process.env.DB_PATH,
// since config/constants.js reads these once at require-time and
// every controller/service/middleware below transitively requires
// it.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const express = require('express');
const http = require('node:http');

const { initDatabase, getDb } = require('../../config/database');
const { setupSocketIO } = require('../../config/socket');
const { errorHandler } = require('../../middleware/errorHandler');

export async function startTestServer() {
    initDatabase();

    const app = express();
    app.use(express.json({ limit: '10mb' }));

    app.use('/api/auth', require('../../routes/auth.routes'));
    app.use('/api/me', require('../../routes/me.routes'));
    app.use('/api/groups', require('../../routes/groups.routes'));

    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorHandler);

    const server = http.createServer(app);
    const io = setupSocketIO(server);

    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });

    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;

    return {
        origin,
        db: getDb(),
        async stop() {
            await new Promise((resolve) => io.close(() => resolve()));
        },
    };
}
