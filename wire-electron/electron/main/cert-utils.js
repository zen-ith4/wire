'use strict';

/**
 * A single canonical way to fingerprint a certificate (SHA-256 of the
 * raw DER bytes, lowercase hex, no separators), used everywhere we
 * pin a certificate so the value stored in config and the value
 * checked later always come from the same computation - regardless of
 * whether the cert came from Node's `tls` (Buffer DER via
 * getPeerCertificate().raw) or from Electron's `certificate-error`
 * event (PEM string via certificate.data).
 */

const crypto = require('crypto');

function fingerprintFromDer(derBuffer) {
  return crypto.createHash('sha256').update(derBuffer).digest('hex');
}

function fingerprintFromPem(pem) {
  const der = Buffer.from(
    pem.replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, ''),
    'base64'
  );
  return fingerprintFromDer(der);
}

module.exports = { fingerprintFromDer, fingerprintFromPem };
