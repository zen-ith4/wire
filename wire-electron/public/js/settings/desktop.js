import { escapeHtml, showToast } from '../core/utils.js';

/**
 * "Desktop App" settings section.
 *
 * Only ever rendered when running inside the Electron shell
 * (window.electronAPI is only present there — see
 * electron/preload/index.js). In a normal browser tab this whole
 * section is simply omitted, so the web deployment is completely
 * unaffected by this file.
 *
 * This talks to the *desktop client's* own configuration (which Wire
 * server to point the app at) via the narrow electronAPI IPC bridge —
 * never anything about the Wire account/session itself, which keeps
 * working exactly as it does in a browser.
 */

export function isElectron() {
  return typeof window !== 'undefined' && Boolean(window.electronAPI && window.electronAPI.isElectron);
}

export async function desktopSettingsSectionHtml() {
  if (!isElectron()) return '';

  let current = { url: null, rememberServer: true };
  let appVersion = '';

  try {
    current = await window.electronAPI.getServerUrl();
  } catch {
    /* fall back to defaults below */
  }

  try {
    appVersion = await window.electronAPI.getAppVersion();
  } catch {
    /* non-critical */
  }

  const currentUrl = current && current.url ? current.url : '';

  return `
        <!-- ================================================== -->
        <!-- Desktop App -->
        <!-- ================================================== -->

        <div class="settings-section">

          <div class="settings-section-title">
            Desktop App
          </div>

          <div class="settings-row" style="align-items:flex-start;">
            <div>
              <div class="settings-row-label">
                Wire server
              </div>
              <div class="settings-row-sublabel">
                The server this desktop app connects to.
              </div>
            </div>
          </div>

          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px;">
            <input
              type="text"
              id="desktop-server-url"
              class="text-input"
              placeholder="https://wire.example.com"
              value="${escapeHtml(currentUrl)}"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
            />

            <div id="desktop-server-status" class="settings-row-sublabel" style="min-height:16px;"></div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="btn btn-sm" id="desktop-test-server-btn">
                Test connection
              </button>
              <button type="button" class="btn btn-sm btn-primary" id="desktop-save-server-btn">
                Save &amp; reconnect
              </button>
            </div>

            <div class="settings-row-sublabel" style="line-height:1.5;">
              Switching servers does not delete anything. Your account,
              messages, and encryption keys are tied to the server you're
              signed in on \u2014 the old server's data stays exactly as it
              was, and this device will need to sign in (and set up
              encryption) again on the new one.
            </div>
          </div>

          ${appVersion ? `
          <div class="settings-row">
            <div>
              <div class="settings-row-label">Wire Desktop</div>
              <div class="settings-row-sublabel">Version ${escapeHtml(appVersion)}</div>
            </div>
          </div>
          ` : ''}

        </div>
  `;
}

export function wireDesktopSettingsSection() {
  if (!isElectron()) return;

  const urlInput = document.getElementById('desktop-server-url');
  const statusEl = document.getElementById('desktop-server-status');
  const testBtn = document.getElementById('desktop-test-server-btn');
  const saveBtn = document.getElementById('desktop-save-server-btn');

  if (!urlInput || !testBtn || !saveBtn) return;

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? 'rgb(198,120,120)' : '';
  }

  function describeStatus(result) {
    switch (result.status) {
      case 'connected':
        return { text: 'Connected.', isError: false };
      case 'access_denied':
        return {
          text: 'Server reachable but access was denied \u2014 check your VPN/network connection.',
          isError: true,
        };
      case 'invalid_url':
        return { text: result.message || 'Invalid server URL.', isError: true };
      case 'tls_error':
        return {
          text: 'Certificate could not be verified. Use the Welcome screen\u2019s certificate trust flow for self-signed servers.',
          isError: true,
        };
      case 'unreachable':
        return { text: 'Could not reach that server.', isError: true };
      default:
        return { text: result.message || 'Connection failed.', isError: true };
    }
  }

  testBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus('Enter a server URL first.', true);
      return;
    }

    testBtn.disabled = true;
    setStatus('Testing\u2026', false);

    try {
      const result = await window.electronAPI.testServerUrl(url);
      const { text, isError } = describeStatus(result);
      setStatus(text, isError);
    } catch (err) {
      setStatus(String((err && err.message) || err), true);
    } finally {
      testBtn.disabled = false;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus('Enter a server URL first.', true);
      return;
    }

    saveBtn.disabled = true;
    setStatus('Connecting\u2026', false);

    try {
      const result = await window.electronAPI.connectToServer(url);

      if (result.status === 'connected') {
        showToast('Reconnecting to new server\u2026');
        // The main process navigates the window to the new server's
        // origin itself once connected; nothing further to do here.
        return;
      }

      const { text, isError } = describeStatus(result);
      setStatus(text, isError);
    } catch (err) {
      setStatus(String((err && err.message) || err), true);
    } finally {
      saveBtn.disabled = false;
    }
  });
}
