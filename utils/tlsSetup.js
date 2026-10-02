'use strict';

/*
 * Generates what's needed for HTTPS in either of the two deployment
 * modes the setup wizard offers:
 *
 *  - "domain": a real hostname with a certificate issued by a public
 *    CA (Let's Encrypt via Caddy's automatic HTTPS - zero manual
 *    certificate handling on the operator's side).
 *
 *  - "wireguard": no public domain at all - just the private
 *    WireGuard IP. There's no CA that will issue a certificate for
 *    a private IP, so we generate a self-signed one ourselves. This
 *    is still real TLS (Web Crypto's secure-context check only
 *    cares about the scheme being https:, not about the certificate
 *    being CA-trusted) - end users either click through their
 *    browser's one-time warning, or the Electron client pins the
 *    certificate's fingerprint on first connect (see main.js) so
 *    nobody has to install anything into their OS trust store.
 *
 * Either way we write out a Caddyfile; the operator still needs
 * Caddy itself installed and running (documented in GUIDE.md) -
 * this module never shells out to install system packages.
 */

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const TLS_DIR = path.join(__dirname, '..', 'tls');
const CADDYFILE_PATH = path.join(__dirname, '..', 'Caddyfile');

function ensureTlsDir() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
}

/**
 * Generates a self-signed certificate for the given IP (and
 * localhost, so local testing keeps working), valid for 10 years.
 * Pure JS (the `selfsigned` package) - no dependency on an mkcert
 * binary being installed on the host.
 *
 * Returns { certPath, keyPath, fingerprint } - fingerprint is the
 * SHA-256 of the DER-encoded certificate, hex-encoded with colons,
 * in the same format Electron's certificate-error event gives us,
 * so main.js can pin against it directly (see GUIDE.md).
 */
async function generateSelfSignedCert(ip) {
  ensureTlsDir();

  const attrs = [{ name: 'commonName', value: ip }];

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: 'sha256', // the library's default is sha1 - too weak, modern browsers warn/reject it
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip }, // IP SAN - required, browsers ignore CN-only certs
          { type: 7, ip: '127.0.0.1' },
          { type: 2, value: 'localhost' }, // DNS SAN
        ],
      },
    ],
  });

  const certPath = path.join(TLS_DIR, 'cert.pem');
  const keyPath = path.join(TLS_DIR, 'key.pem');

  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });

  // NOTE: pems.fingerprint (from the `selfsigned` package itself) is
  // SHA-1 and is NOT what we use here - see certFingerprint() below.
  // We compute our own SHA-256 fingerprint instead, because the
  // Electron client (main.js) needs to recompute the exact same
  // value from the raw certificate bytes it receives at connection
  // time in order to pin it (TOFU). Keeping one shared, explicit
  // algorithm here (rather than trusting a library default, or
  // trying to reverse-engineer Electron's internal fingerprint
  // string format) means both sides are guaranteed to agree.
  const fingerprint = certFingerprint(pems.cert);

  return { certPath, keyPath, fingerprint };
}

/**
 * SHA-256 fingerprint of a PEM certificate, formatted as
 * "AA:BB:CC:..." (uppercase, colon-separated) - verified to match
 * `openssl x509 -noout -fingerprint -sha256` exactly. main.js
 * computes this same way from the PEM data Electron hands it in
 * the certificate-error event, so the two can be compared directly
 * without depending on Electron's own internal fingerprint format.
 */
function certFingerprint(pemCert) {
  const crypto = require('crypto');

  const der = Buffer.from(
    pemCert
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, ''),
    'base64'
  );

  return crypto
    .createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');
}

function writeCaddyfileForDomain(domain, upstreamPort) {
  const content =
    `${domain} {\n` +
    `\treverse_proxy localhost:${upstreamPort}\n` +
    `}\n`;

  fs.writeFileSync(CADDYFILE_PATH, content);

  return CADDYFILE_PATH;
}

function writeCaddyfileForSelfSigned(ip, upstreamPort, certPath, keyPath) {
  const content =
    `https://${ip} {\n` +
    `\ttls ${certPath} ${keyPath}\n` +
    `\treverse_proxy localhost:${upstreamPort}\n` +
    `}\n`;

  fs.writeFileSync(CADDYFILE_PATH, content);

  return CADDYFILE_PATH;
}

module.exports = {
  generateSelfSignedCert,
  certFingerprint,
  writeCaddyfileForDomain,
  writeCaddyfileForSelfSigned,
};
