'use strict';

/**
 * Wire Desktop Client — Electron main process.
 *
 * This process contains NO backend/server logic. It is a thin, secure
 * shell that:
 *   1. Shows a "choose your server" screen on first launch.
 *   2. Remembers the chosen server address for next time.
 *   3. Loads the existing website straight from that remote server.
 *
 * The backend (server.js, Express, Socket.IO, the database, etc.) is
 * never bundled, imported, or started here.
 */

const { app, BrowserWindow, ipcMain, net, shell, Menu, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Persisted config (just the server address — nothing else)
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(app.getPath('userData'), 'server-config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed.serverUrl === 'string' ? parsed : { serverUrl: null };
  } catch (e) {
    return { serverUrl: null };
  }
}

function saveConfig(serverUrl) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ serverUrl }, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save server config:', e);
  }
}

function clearConfig() {
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
  } catch (e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Persisted app settings (device-level, not tied to any server/account —
// currently just the Hardware Acceleration preference). Kept in a separate
// file from server-config.json since it's conceptually unrelated (a chosen
// server vs. a local rendering preference) and read very early, before
// `app.whenReady()`.
// ---------------------------------------------------------------------------

const APP_SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json');

const DEFAULT_APP_SETTINGS = { hardwareAccelerationEnabled: true };

function loadAppSettings() {
  try {
    const raw = fs.readFileSync(APP_SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      hardwareAccelerationEnabled:
        typeof parsed.hardwareAccelerationEnabled === 'boolean'
          ? parsed.hardwareAccelerationEnabled
          : DEFAULT_APP_SETTINGS.hardwareAccelerationEnabled,
    };
  } catch (e) {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function saveAppSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(APP_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(APP_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save app settings:', e);
  }
}

// Hardware acceleration can only be toggled by calling
// app.disableHardwareAcceleration() before the app is ready — it cannot be
// changed at runtime on a window that's already open. So: read the saved
// preference now, at module load (well before app.whenReady() below), and
// apply it immediately. A change made later from the renderer (see the
// 'app:hardware-acceleration:set' handler further down) is written to disk
// right away but only takes effect the *next* time the app launches, which
// is why that handler also offers to relaunch the app immediately.
const initialAppSettings = loadAppSettings();
if (!initialAppSettings.hardwareAccelerationEnabled) {
  app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------------------
// Address normalization / validation
// ---------------------------------------------------------------------------

/**
 * Accepts things like:
 *   192.168.1.100:3000
 *   http://192.168.1.100:3000
 *   https://example.com
 *   example.com
 * Returns a clean origin string, e.g. "http://192.168.1.100:3000".
 * Throws with a user-friendly message if the input is invalid.
 */
function normalizeServerAddress(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('Please enter a server address.');
  }

  let input = rawInput.trim();

  if (!input) {
    throw new Error('Please enter a server address.');
  }

  // Default to http:// if no scheme was given (LAN servers are usually
  // plain HTTP; users can type https:// explicitly when needed).
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    input = 'http://' + input;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch (e) {
    throw new Error(
      "That doesn't look like a valid address. Try formats like 192.168.1.100:3000 or https://example.com"
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// servers are supported.');
  }

  if (!parsed.hostname) {
    throw new Error('Please include a host or IP address.');
  }

  // origin = protocol + host + port, with no trailing slash, path, or query.
  return parsed.origin;
}

/**
 * Confirms there is a live HTTP server at `serverUrl`. Resolves on any
 * HTTP response (even 401/403/404 — that still proves a server is
 * there); rejects on network failure or timeout.
 */
function testServerReachable(serverUrl, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const request = net.request({
      method: 'GET',
      url: serverUrl + '/',
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(new Error('Connection timed out. Check the address and that the server is running.'));
    }, timeoutMs);

    request.on('response', (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drain the response body; we don't need it.
      response.on('data', () => {});
      response.on('end', () => resolve(true));
      response.on('error', () => resolve(true)); // headers arrived, good enough
    });

    request.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Could not reach that server. Check the address and your network connection.'));
    });

    request.end();
  });
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

let mainWindow = null;

// Explicit window icon so the app never falls back to the default
// Electron icon — matters most on Linux (taskbar/alt-tab) and in
// `npm start` dev mode on any platform, since packaged Windows/Linux
// builds also get their icon "baked in" separately via the
// build.win.icon / build.linux.icon settings in package.json.
const APP_ICON_PATH = path.join(__dirname, 'build', 'icon.png');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#060608',
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    webPreferences: {
      // --- Secure Electron settings ---
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Any content trying to open a new window/tab (target=_blank, window.open,
  // OAuth-style popups, etc.) is sent to the user's normal OS browser
  // instead of spawning a new uncontrolled Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-app navigation to a different origin than the connected
  // server (protects against link-jacking to arbitrary sites); the
  // local connect screen (file://) and the chosen server's own origin
  // remain allowed.
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const target = new URL(targetUrl);
    const isLocalConnectScreen = target.protocol === 'file:';
    const isCurrentServer = currentServerOrigin && target.origin === currentServerOrigin;

    if (!isLocalConnectScreen && !isCurrentServer) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  // If the remote site fails to load (server went down, wrong address,
  // network dropped, etc.) bounce back to the connect screen with an
  // explanation instead of showing Chromium's raw error page.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED — usually just a cancelled/redirected nav, ignore
    if (validatedURL.startsWith('file://')) return; // failure loading the connect screen itself

    showConnectScreen({
      autoAttempt: false,
      errorMessage: 'Lost connection to the server. Please check the address and try again.',
    });
  });

  showConnectScreen({ autoAttempt: true });

  buildAppMenu();
}

let currentServerOrigin = null;

function showConnectScreen({ autoAttempt, errorMessage } = {}) {
  const query = {};
  if (autoAttempt) query.auto = '1';
  if (errorMessage) query.error = errorMessage;

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'connect.html'), { query });
}

function loadRemoteServer(serverUrl) {
  currentServerOrigin = serverUrl;
  mainWindow.loadURL(serverUrl);
}

function buildAppMenu() {
  const template = [
    {
      label: 'Server',
      submenu: [
        {
          label: 'Change Server…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => showConnectScreen({ autoAttempt: false }),
        },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.reload(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// E2EE "Remember me on this device" — cached unlock key
//
// Stores only the PBKDF2-derived AES unlock key (base64), never the
// account password and never the raw private key (see the website's
// identity.js). Encrypted at rest with Electron's safeStorage, which
// defers to the OS's own secret storage (Keychain on macOS, DPAPI on
// Windows, libsecret/kwallet on Linux). Scoped per (origin, userId)
// so multiple accounts/servers on this install never collide.
//
// Every handler independently re-derives the calling page's real
// origin from the WebContents that sent the IPC message (never trusts
// a caller-supplied origin string alone), so a compromised or
// malicious page can only ever read/write the cache entry for the
// server it is actually currently loaded from.
// ---------------------------------------------------------------------------

const UNLOCK_KEYS_PATH = path.join(app.getPath('userData'), 'identity-unlock-keys.json');

function unlockKeyStoreOrigin(event) {
  try {
    return new URL(event.sender.getURL()).origin;
  } catch (e) {
    return null;
  }
}

function unlockKeyRecordId(origin, userId) {
  return `${origin}::${userId}`;
}

function loadUnlockKeyStore() {
  try {
    const raw = fs.readFileSync(UNLOCK_KEYS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveUnlockKeyStore(store) {
  fs.mkdirSync(path.dirname(UNLOCK_KEYS_PATH), { recursive: true });
  fs.writeFileSync(UNLOCK_KEYS_PATH, JSON.stringify(store), 'utf-8');
}

ipcMain.handle('identity:store-unlock-key', (event, claimedOrigin, userId, unlockKey) => {
  const realOrigin = unlockKeyStoreOrigin(event);

  if (!realOrigin || realOrigin !== claimedOrigin) {
    return { success: false, error: 'Origin mismatch' };
  }

  if (typeof unlockKey !== 'string' || !unlockKey) {
    return { success: false, error: 'Invalid unlock key' };
  }

  if (userId == null) {
    return { success: false, error: 'Invalid user id' };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return {
      success: false,
      error: 'OS-level secure storage is not available on this system.',
    };
  }

  try {
    const store = loadUnlockKeyStore();
    const encrypted = safeStorage.encryptString(unlockKey);
    store[unlockKeyRecordId(realOrigin, userId)] = encrypted.toString('base64');
    saveUnlockKeyStore(store);
    return { success: true };
  } catch (err) {
    console.error('Failed to persist identity unlock key:', err);
    return { success: false, error: 'Failed to persist unlock key' };
  }
});

ipcMain.handle('identity:get-unlock-key', (event, claimedOrigin, userId) => {
  const realOrigin = unlockKeyStoreOrigin(event);

  if (!realOrigin || realOrigin !== claimedOrigin) {
    return null;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }

  const store = loadUnlockKeyStore();
  const record = store[unlockKeyRecordId(realOrigin, userId)];

  if (!record) {
    return null;
  }

  try {
    const unlockKey = safeStorage.decryptString(Buffer.from(record, 'base64'));
    return { unlockKey };
  } catch (err) {
    console.error('Failed to decrypt identity unlock key:', err);
    return null;
  }
});

ipcMain.handle('identity:clear-unlock-key', (event, claimedOrigin, userId) => {
  const realOrigin = unlockKeyStoreOrigin(event);

  if (!realOrigin || realOrigin !== claimedOrigin) {
    return false;
  }

  try {
    const store = loadUnlockKeyStore();
    delete store[unlockKeyRecordId(realOrigin, userId)];
    saveUnlockKeyStore(store);
    return true;
  } catch (err) {
    console.error('Failed to clear identity unlock key:', err);
    return false;
  }
});


// ---------------------------------------------------------------------------
// IPC — Hardware Acceleration setting
//
// Exposed to the remote site's Settings page (see preload.js's
// `electronAPI` branch), same as the identity-unlock-key handlers above.
// Not security-sensitive (it's a local rendering preference, not
// per-account data), so unlike those handlers this doesn't need to verify
// the caller's origin.
// ---------------------------------------------------------------------------

ipcMain.handle('app:hardware-acceleration:get', () => {
  return loadAppSettings().hardwareAccelerationEnabled;
});

ipcMain.handle('app:hardware-acceleration:set', (event, enabled) => {
  const value = enabled !== false;
  saveAppSettings({ hardwareAccelerationEnabled: value });
  // Takes effect on next launch (see the disableHardwareAcceleration() call
  // above) — the renderer prompts the user to relaunch now.
  return { success: true, enabled: value };
});

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// ---------------------------------------------------------------------------
// IPC — "Change server" from the remote site's Login screen
//
// Hands off to the existing connect screen/flow (address entry,
// validation, persistence, auto-reconnect) rather than duplicating any
// of that here. Exposed to the remote site (see preload.js's
// `electronAPI` branch) alongside the other non-sensitive app controls
// above.
// ---------------------------------------------------------------------------

ipcMain.handle('server:show-connect-screen', () => {
  showConnectScreen({ autoAttempt: false });
  return true;
});

// ---------------------------------------------------------------------------
// IPC — DM notifications
//
// Renderer → main: 'dm-notification:show'. The renderer (the remote
// Wire site's own notifications/notification-manager.js) has already
// decided this DM should notify — see that file's shouldNotifyDM() —
// this handler only ever displays what it's told and reports a click
// back. Registered once here at module load, not per-window/per-load,
// so a renderer reload can never register a second listener.
//
// Main → renderer: 'dm-notification:clicked', delivered only to the
// window whose notification was actually clicked.
// ---------------------------------------------------------------------------

function isPlainString(value) {
  return typeof value === 'string' && value.length > 0;
}

ipcMain.on('dm-notification:show', (event, payload) => {
  // Only the app's one real window can trigger a notification — this
  // channel carries no secrets, but validating the sender and the
  // payload shape keeps a malformed or unexpected call from ever
  // reaching Electron's native Notification API.
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (!payload || typeof payload !== 'object') return;
  if (!Notification.isSupported()) return;

  const { conversationId, senderName, preview } = payload;

  if (!Number.isInteger(conversationId)) return;

  const notification = new Notification({
    title: isPlainString(senderName) ? senderName : 'New message',
    body: isPlainString(preview) ? preview : '',
    icon: APP_ICON_PATH,
    silent: false,
  });

  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();

    // Only enough to route the click — see notifications/web-
    // notifications.js's navigate('messages', { id, username }) for
    // the same shape on the web side.
    mainWindow.webContents.send('dm-notification:clicked', {
      conversationId,
      senderName: isPlainString(senderName) ? senderName : undefined,
    });
  });

  notification.show();
});

// ---------------------------------------------------------------------------
// IPC — only reachable from the local connect.html screen (see preload.js)
// ---------------------------------------------------------------------------

ipcMain.handle('server:get-saved', () => {
  const { serverUrl } = loadConfig();
  return serverUrl;
});

ipcMain.handle('server:forget', () => {
  clearConfig();
  return true;
});

ipcMain.handle('server:connect', async (event, rawAddress) => {
  let normalized;
  try {
    normalized = normalizeServerAddress(rawAddress);
  } catch (err) {
    return { success: false, error: err.message };
  }

  try {
    await testServerReachable(normalized);
  } catch (err) {
    return { success: false, error: err.message };
  }

  saveConfig(normalized);
  loadRemoteServer(normalized);
  return { success: true, url: normalized };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
