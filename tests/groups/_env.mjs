// tests/groups/_env.mjs
//
// Must be the FIRST import in any test file that uses _test-server.mjs
// — ES module imports are evaluated before the importing file's own
// top-level statements run, so setting process.env.* after importing
// _test-server.mjs would be too late (config/constants.js reads these
// once, at its own first require).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-group-roundtrip-do-not-use-in-prod';
process.env.GROUPS_ENABLED = 'true';
process.env.EMAIL_ENABLED = 'false'; // no SMTP in this sandbox; skip email verification
process.env.DB_PATH = ':memory:';
