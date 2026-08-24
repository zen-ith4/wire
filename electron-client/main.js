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

const { app, BrowserWindow, ipcMain, net, shell, Menu } = require('electron');
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
