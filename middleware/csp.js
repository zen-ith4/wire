const crypto = require('crypto');

// Strict Content-Security-Policy.
//
// CSP_ENFORCE (env var, read per request): only the exact string 'true'
// sends the policy as an enforced `Content-Security-Policy` header.
// Anything else (default) sends the SAME policy as
// `Content-Security-Policy-Report-Only`: the browser logs violations to
// the console but blocks nothing. That is the safe default while parts of
// the legacy UI still use inline handlers / style="" attributes (see
// docs/CSP_TODO.md). The policy itself is never weakened -- no
// 'unsafe-inline' / 'unsafe-eval' in either mode.
//
// No 'unsafe-inline' and no 'unsafe-eval' anywhere in this policy.
// The app's own <script> tags are all external module scripts loaded
// from same-origin paths (see public/index.html), so script-src 'self'
// covers them without a nonce. res.locals.cspNonce is still generated
// and attached to every response in case a future template needs a
// one-off inline <script>, but nothing in the current app consumes it.
//
// style-src allows Google Fonts' stylesheet host because public/index.html
// links https://fonts.googleapis.com directly; font-src allows the actual
// font file host, https://fonts.gstatic.com. Everything else is locked to
// 'self'.
//
// connect-src 'self' covers same-origin fetch() and the same-origin
// socket.io WebSocket upgrade (public/js/core/socket.js connects to
// window.location.origin in the browser/PWA case that this Express
// server actually renders for). It does NOT cover the Capacitor build,
// which can point at an arbitrary user-configured WireGuard host --
// that webview loads its bundled assets from a capacitor:// origin, not
// from this server, so this header never reaches it either way.
function csp(req, res, next) {
  const enforce = process.env.CSP_ENFORCE === 'true';
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  const directives = [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    `img-src 'self' data: blob:`,
    `media-src 'self' blob:`,
    `connect-src 'self'`,
    `worker-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `manifest-src 'self'`
  ];

  // upgrade-insecure-requests is ignored (and logs a console warning) in
  // a Report-Only policy, so it is only added when enforcing.
  if (enforce) directives.push(`upgrade-insecure-requests`);

  res.setHeader(
    enforce
      ? 'Content-Security-Policy'
      : 'Content-Security-Policy-Report-Only',
    directives.join('; ')
  );
  next();
}

module.exports = { csp };
