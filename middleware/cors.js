// middleware/cors.js
//
// HTTP CORS for the browser-based (PWA), Electron, and Capacitor clients.
// Imported by server.js and exercised by tests/cors-config.test.mjs, so the
// options here are the single source of truth — change it in one place.
//
//   origin: true   Reflects the requesting Origin instead of a fixed allowlist.
//                  This is deliberate. Auth is entirely header-based (the
//                  `Authorization: Bearer <session token>` header; see
//                  middleware/authenticate.js) and Socket.IO handshake tokens
//                  (config/socket.js) — nothing here reads or writes cookies,
//                  so credentials are unnecessary. Reflecting also keeps both
//                  supported client types working without special cases:
//                    - Electron loads the page straight from whichever server
//                      the user chose (electron-client/main.js), so its Origin
//                      can be any host/port — a fixed allowlist would have to
//                      reflect that anyway.
//                    - Capacitor's https://localhost origin reflects too.
//
//   credentials:false No cookies are used anywhere in this app, so the
//                  response never needs Access-Control-Allow-Credentials and
//                  never sends one. Dropping it also means a spoofed Origin
//                  cannot piggyback on credentialed (cookie) requests.
const cors = require('cors');

const corsMiddleware = cors({
  origin: true,
  credentials: false,
});

module.exports = { corsMiddleware };
