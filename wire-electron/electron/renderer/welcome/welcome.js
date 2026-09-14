'use strict';

/**
 * This file runs in the renderer of the local (file://) welcome
 * screen only - never inside the loaded Wire server page. It only
 * ever talks to Node/Electron through window.electronAPI (see
 * electron/preload/index.js); it has no direct Node access.
 */

(function () {
  const params = new URLSearchParams(window.location.search);

  const els = {
    headline: document.getElementById('headline'),
    subtext: document.getElementById('subtext'),
    errorBanner: document.getElementById('error-banner'),
    errorTitle: document.getElementById('error-title'),
    errorBody: document.getElementById('error-body'),
    connectingState: document.getElementById('connecting-state'),
    connectingText: document.getElementById('connecting-text'),
    certPanel: document.getElementById('cert-panel'),
    certDetails: document.getElementById('cert-details'),
    viewCertBtn: document.getElementById('view-cert-btn'),
    trustCertBtn: document.getElementById('trust-cert-btn'),
    form: document.getElementById('setup-form'),
    urlInput: document.getElementById('server-url'),
    fieldError: document.getElementById('field-error'),
    rememberCheckbox: document.getElementById('remember-server'),
    cancelBtn: document.getElementById('cancel-btn'),
    connectBtn: document.getElementById('connect-btn'),
    statusLine: document.getElementById('status-line'),
    appVersion: document.getElementById('app-version'),
  };

  let lastTestedUrl = null; // the URL a cert panel is currently showing details for
  let previousServerUrl = null; // for "Cancel" in change-server mode

  function show(el) {
    el.hidden = false;
  }
  function hide(el) {
    el.hidden = true;
  }

  function setForm(disabled) {
    els.urlInput.disabled = disabled;
    els.connectBtn.disabled = disabled;
    els.rememberCheckbox.disabled = disabled;
  }

  function resetTransientUI() {
    hide(els.errorBanner);
    hide(els.certPanel);
    hide(els.certDetails);
    hide(els.trustCertBtn);
    els.fieldError.textContent = '';
    els.urlInput.classList.remove('invalid');
    els.statusLine.textContent = '';
  }

  function friendlyReason(status, message) {
    switch (status) {
      case 'invalid_url':
        return { title: 'Invalid server URL', body: message || 'Please check the address and try again.' };
      case 'unreachable':
        return {
          title: 'Server unavailable',
          body: 'Could not reach that server. It may be offline, or the address may be wrong.',
        };
      case 'access_denied':
        return {
          title: 'Access denied',
          body:
            message ||
            'The server is reachable but refused the connection. If it restricts access to a VPN, make sure you\u2019re connected to it.',
        };
      case 'server_error':
        return { title: 'Server error', body: message || 'The server responded with an unexpected error.' };
      case 'tls_error':
        return { title: 'TLS/certificate error', body: 'The server\u2019s certificate could not be verified.' };
      default:
        return { title: 'Connection failed', body: message || 'Something went wrong.' };
    }
  }

  function showError(status, message) {
    const { title, body } = friendlyReason(status, message);
    els.errorTitle.textContent = title;
    els.errorBody.textContent = body;
    show(els.errorBanner);
  }

  async function attemptConnect(url, { silent } = {}) {
    resetTransientUI();
    setForm(true);
    show(els.connectingState);
    els.connectingText.textContent = `Connecting to ${url}\u2026`;

    let result;
    try {
      result = await window.electronAPI.connectToServer(url, {
        remember: els.rememberCheckbox.checked,
      });
    } catch (err) {
      result = { status: 'unreachable', message: String((err && err.message) || err) };
    }

    hide(els.connectingState);
    setForm(false);

    if (result.status === 'connected') {
      els.statusLine.textContent = 'Connected. Loading Wire\u2026';
      // Main process is navigating the window away now; nothing else to do.
      return;
    }

    lastTestedUrl = url;

    if (result.status === 'tls_error') {
      show(els.certPanel);
    }

    if (!silent) {
      showError(result.status, result.message);
    }
  }

  async function handleViewCertificate() {
    const url = lastTestedUrl || els.urlInput.value;
    els.viewCertBtn.disabled = true;

    try {
      const info = await window.electronAPI.getCertificateInfo(url);
      els.certDetails.innerHTML = `
        <div><strong>Host:</strong> ${escapeHtml(new URL(info.origin).host)}</div>
        <div><strong>Issued to:</strong> ${escapeHtml(info.subject || 'Unknown')}</div>
        <div><strong>Issuer:</strong> ${escapeHtml(info.issuer || 'Unknown')}</div>
        <div><strong>Valid until:</strong> ${escapeHtml(info.validTo || 'Unknown')}</div>
        <div><strong>SHA-256 fingerprint:</strong><br />${escapeHtml(formatFingerprint(info.fingerprint256))}</div>
      `;
      els.certDetails.dataset.fingerprint = info.fingerprint256;
      els.certDetails.dataset.url = info.origin;
      show(els.certDetails);
      show(els.trustCertBtn);
    } catch (err) {
      els.certDetails.textContent = `Could not read certificate: ${String((err && err.message) || err)}`;
      show(els.certDetails);
    } finally {
      els.viewCertBtn.disabled = false;
    }
  }

  async function handleTrustCertificate() {
    const url = els.certDetails.dataset.url;
    const fingerprint = els.certDetails.dataset.fingerprint;
    if (!url || !fingerprint) return;

    els.trustCertBtn.disabled = true;
    els.trustCertBtn.textContent = 'Trusting\u2026';

    const result = await window.electronAPI.trustCertificate(url, fingerprint);

    els.trustCertBtn.disabled = false;
    els.trustCertBtn.textContent = 'Trust this certificate & connect';

    if (!result.ok) {
      showError('tls_error', result.message);
      return;
    }

    await attemptConnect(els.urlInput.value.trim() || url);
  }

  function formatFingerprint(hex) {
    if (!hex) return '';
    return (hex.match(/.{1,4}/g) || []).join(' ').toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = els.urlInput.value.trim();

    if (!raw) {
      els.urlInput.classList.add('invalid');
      els.fieldError.textContent = 'Enter a server URL.';
      return;
    }

    attemptConnect(raw);
  });

  els.viewCertBtn.addEventListener('click', handleViewCertificate);
  els.trustCertBtn.addEventListener('click', handleTrustCertificate);

  els.cancelBtn.addEventListener('click', async () => {
    if (previousServerUrl) {
      attemptConnect(previousServerUrl, { silent: false });
    }
  });

  async function init() {
    try {
      const version = await window.electronAPI.getAppVersion();
      els.appVersion.textContent = `Wire Desktop v${version}`;
    } catch {
      /* non-critical */
    }

    const reconnect = params.get('reconnect') === '1';
    const settingsMode = params.get('settings') === '1';
    const autoconnect = params.get('autoconnect') === '1';
    const queryUrl = params.get('url') || '';

    if (settingsMode) {
      els.headline.textContent = 'Server Settings';
      els.subtext.textContent = 'Change the Wire server this app connects to.';
      els.urlInput.value = queryUrl;
      previousServerUrl = queryUrl || null;
      if (previousServerUrl) show(els.cancelBtn);
      return;
    }

    if (reconnect) {
      els.headline.textContent = 'Unable to Connect';
      els.subtext.textContent = 'Wire couldn\u2019t reach your server.';
      els.urlInput.value = queryUrl;
      showError('unreachable', 'The connection to your Wire server was lost or could not be established.');
      return;
    }

    if (autoconnect && queryUrl) {
      els.urlInput.value = queryUrl;
      await attemptConnect(queryUrl);
      return;
    }

    // Plain first-run: nothing to prefill.
  }

  init();
})();
