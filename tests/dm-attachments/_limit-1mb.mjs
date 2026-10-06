// Import this FIRST (before _env.mjs and anything that loads
// config/constants.js): ES imports are hoisted, so a plain assignment at
// the top of a test file runs too late. Sets a 1 MB DM attachment limit so
// limit tests are fast.
process.env.DM_UPLOAD_MAX_MB = '1';
