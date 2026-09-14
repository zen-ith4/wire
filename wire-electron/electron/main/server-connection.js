'use strict';

/**
 * Validates, normalizes, and health-checks a candidate Wire server URL.
 *
 * TLS verification is ALWAYS on by default (Node's normal certificate
 * validation, using the system/bundled CA store). It is never
 * disabled globally. The one exception is a narrow, explicit,
 * per-origin certificate *pin*: if the user has previously chosen (via
 * the Welcome/Settings "trust this certificate" flow - see
 * ipc-handlers.js) to accept one specific self-signed certificate for
 * one specific origin, we verify the live certificate's SHA-256
 * fingerprint against the pinned one instead of against a CA chain.
 * A different certificate later presented for that same origin (e.g.
 * a MITM swap) still fails closed.
 */

const https = require('https');
const http = require('http');
const configStore = require('./config-store');
const { fingerprintFromDer } = require('./cert-utils');

const HEALTH_PATH = '/api/health';
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Normalizes a user-entered server URL. Returns
 * { ok: true, url, origin } or { ok: false, reason }.
 */
function normalizeServerUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, reason: 'Enter a server URL.' };
  }

  let candidate = input.trim();

  // Only add a scheme when none was given at all - an explicit
  // "http://..." from the user is respected, never silently upgraded
  // or downgraded.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'That doesn\u2019t look like a valid URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Server URL must start with http:// or https://.' };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'Enter a valid host name or IP address.' };
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url: origin, origin };
}

function requestOnce(targetUrl, { allowPinnedFingerprint } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      resolve({ status: 'invalid_url', message: err.message });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const pinned =
      parsed.protocol === 'https:'
        ? (configStore.get('trustedCertificates') || {})[parsed.origin]
        : null;

    const options = {
      method: 'GET',
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': 'Wire-Desktop-Client' },
    };

    if (parsed.protocol === 'https:' && pinned && allowPinnedFingerprint) {
      // Verify against the pinned fingerprint ourselves instead of the
      // CA chain. Node still performs the full handshake; we just
      // decide whether to abort based on an exact fingerprint match.
      options.rejectUnauthorized = false;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = client.request(targetUrl, options, (res) => {
      if (parsed.protocol === 'https:' && pinned && allowPinnedFingerprint) {
        const cert = res.socket.getPeerCertificate();
        const fingerprint = cert && cert.raw ? fingerprintFromDer(cert.raw) : null;

        if (!fingerprint || fingerprint !== pinned) {
          req.destroy();
          finish({
            status: 'tls_error',
            message:
              'The server\u2019s certificate does not match the one you previously trusted. Refusing to connect.',
          });
          return;
        }
      }

      res.on('data', () => {});
      res.on('end', () => {
        const httpStatus = res.statusCode;

        if (httpStatus === 403) {
          finish({
            status: 'access_denied',
            httpStatus,
            message:
              'The server refused the connection (access denied). If this server restricts access to a VPN/WireGuard subnet, make sure you\u2019re connected to it.',
          });
          return;
        }

        if (httpStatus >= 200 && httpStatus < 500) {
          finish({ status: 'connected', httpStatus });
          return;
        }

        finish({
          status: 'server_error',
          httpStatus,
          message: `Server responded with an error (HTTP ${httpStatus}).`,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ status: 'unreachable', message: 'The server did not respond in time.' });
    });

    req.on('error', (err) => {
      const message = String((err && err.message) || err);

      if (/CERT|SSL|certificate|self.signed|unable to verify/i.test(message)) {
        finish({ status: 'tls_error', message });
        return;
      }

      finish({ status: 'unreachable', message });
    });

    req.end();
  });
}

/**
 * Performs a real connection test. Prefers GET /api/health; falls
 * back to a bare GET / if the server is reachable but predates that
 * endpoint (404), so existing deployments aren't blocked.
 */
async function testServerConnection(rawUrl, options = {}) {
  const normalized = normalizeServerUrl(rawUrl);

  if (!normalized.ok) {
    return { status: 'invalid_url', message: normalized.reason };
  }

  const primary = await requestOnce(`${normalized.origin}${HEALTH_PATH}`, options);

  if (primary.status === 'connected' || primary.status === 'access_denied') {
    return { ...primary, url: normalized.url };
  }

  if (primary.status === 'server_error' && primary.httpStatus === 404) {
    const fallback = await requestOnce(normalized.origin, options);
    if (fallback.status === 'connected' || fallback.status === 'access_denied') {
      return { status: 'connected', url: normalized.url };
    }
    return { ...fallback, url: normalized.url };
  }

  return { ...primary, url: normalized.url };
}

/**
 * Fetches the live certificate for an https origin so the user can be
 * shown its fingerprint before deciding whether to pin it. Does NOT
 * mark anything as trusted - it only inspects.
 */
function fetchCertificateInfo(rawUrl) {
  return new Promise((resolve, reject) => {
    const normalized = normalizeServerUrl(rawUrl);
    if (!normalized.ok) {
      reject(new Error(normalized.reason));
      return;
    }

    if (!normalized.origin.startsWith('https:')) {
      reject(new Error('Certificate pinning only applies to https:// servers.'));
      return;
    }

    const req = https.request(
      normalized.origin,
      { method: 'GET', rejectUnauthorized: false, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const cert = res.socket.getPeerCertificate();
        res.destroy();

        if (!cert || !cert.raw) {
          reject(new Error('Could not read the server certificate.'));
          return;
        }

        resolve({
          origin: normalized.origin,
          fingerprint256: fingerprintFromDer(cert.raw),
          issuer: cert.issuer && cert.issuer.O,
          subject: cert.subject && cert.subject.CN,
          validTo: cert.valid_to,
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timed out reading the server certificate.'));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  normalizeServerUrl,
  testServerConnection,
  fetchCertificateInfo,
  HEALTH_PATH,
};
