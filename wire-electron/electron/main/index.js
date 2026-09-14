'use strict';

/**
 * Wire Desktop - Electron main process.
 *
 * Architecture summary (see project root README-ELECTRON.md for the
 * full writeup):
 *
 *   Electron BrowserWindow  --loadURL-->  <configured Wire server origin>
 *                            (HTTPS/WSS)
 *
 * This app does NOT bundle or start the Wire Node.js server
 * (server.js/controllers//database/...). It is a thin, hardened
 * client shell: on first launch it shows a local "Welcome" screen
 * (bundled with the app, loaded from disk) that asks for a server URL,
 * tests it for real, and - once connected - simply points the same
 * BrowserWindow at that server's origin. From that point on the
 * existing web app (public/) runs completely unmodified: its
 * same-origin-relative fetch()/socket.io/XHR calls work exactly
 * as they do in a normal browser tab, because the page really is
 * being served by, and running at, the origin of, that Wire server.
 */

const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');

const configStore = require('./config-store');
const { getSavedBounds, trackWindow } = require('./window-state');
const {
  hardenWebContents,
  registerCertificateErrorPolicy,
} = require('./security');
const { registerIpcHandlers } = require('./ipc-handlers');
const { buildMenu } = require('./menu');

const isDev = process.env.NODE_ENV === 'development';

// Single instance: a second launch focuses the existing window
// instead of opening a confusing second copy of the app.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();

    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  main();
}

let mainWindow = null;

function getMainWindow() {
  return mainWindow;
}

function welcomeFileUrl(query) {
  const filePath = path.join(
    __dirname,
    '..',
    'renderer',
    'welcome',
    'welcome.html'
  );

  const params = new URLSearchParams(query || {});
  const qs = params.toString();

  return `file://${filePath}${qs ? `?${qs}` : ''}`;
}

function getAllowedOrigin() {
  const url = configStore.get('serverUrl');

  if (!url) return null;

  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function navigateToWelcome(extraQuery) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.loadURL(welcomeFileUrl(extraQuery));
}

function navigateToServer(serverUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.loadURL(serverUrl);
}

function createMainWindow() {
  const { bounds, isMaximized } = getSavedBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#09090b',
    title: 'Wire',
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),

                                 webPreferences: {
                                   preload: path.join(__dirname, '..', 'preload', 'index.js'),
                                 contextIsolation: true,
                                 nodeIntegration: false,
                                 sandbox: true,
                                 webviewTag: false,
                                 spellcheck: true,

                                 // Keep DevTools enabled for debugging,
                                 // but do not open them automatically.
                                 devTools: true,
                                 },
  });

  trackWindow(mainWindow);

  hardenWebContents(
    mainWindow.webContents,
    getAllowedOrigin
  );

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    if (isMaximized) {
      mainWindow.maximize();
    }
  });

  // If the remote Wire server becomes unreachable mid-session (or the
  // very first connection attempt after a "Connect" click fails at
  // the navigation level rather than our own pre-flight health check),
  // fall back to the local welcome/error screen instead of leaving
  // Electron's own blank "can't reach this page" error page showing.
  mainWindow.webContents.on(
    'did-fail-load',
    (
      event,
     errorCode,
     errorDescription,
     validatedURL
    ) => {
      // -3 is ERR_ABORTED, which fires for normal redirects/cancellations
      // (e.g. we ourselves called loadURL again before this one finished)
      // and is not a real failure.
      if (errorCode === -3) return;

      let failedOrigin = null;

      try {
        failedOrigin = new URL(validatedURL).origin;
      } catch {
        /* ignore */
      }

      const currentServer = configStore.get('serverUrl');

      const isServerLoad =
      failedOrigin &&
      currentServer &&
      failedOrigin === new URL(currentServer).origin;

      if (isServerLoad) {
        navigateToWelcome({
          reconnect: '1',
          url: currentServer,
          reason: errorDescription || 'CONNECTION_FAILED',
        });
      }
    }
  );

  const menu = buildMenu({
    onChangeServer: () => {
      const currentServer = configStore.get('serverUrl');

      navigateToWelcome({
        settings: '1',
        url: currentServer || '',
      });
    },

    onReload: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    },
  });

  Menu.setApplicationMenu(menu);

  return mainWindow;
}

function startInitialView() {
  const serverUrl = configStore.get('serverUrl');
  const rememberServer =
  configStore.get('rememberServer') !== false;

  if (serverUrl && rememberServer) {
    // Show the welcome screen in its own "connecting..." state first
    // rather than calling loadURL(serverUrl) directly - this gives us
    // a consistent place to run the real health check and to land on
    // if it fails, instead of showing Chromium's default error page.
    navigateToWelcome({
      autoconnect: '1',
      url: serverUrl,
    });
  } else {
    navigateToWelcome({});
  }
}

function main() {
  app.whenReady().then(() => {
    registerCertificateErrorPolicy(app);

    // Defense in depth: even though this app only creates one
    // BrowserWindow, apply the same navigation/webview hardening to
    // any webContents Electron creates (e.g. devtools windows).
    app.on('web-contents-created', (event, contents) => {
      contents.on('will-attach-webview', (event) => {
        event.preventDefault();
      });
    });

    createMainWindow();

    registerIpcHandlers({
      getMainWindow,
      navigateToServer,
      navigateToWelcome,
    });

    startInitialView();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
        startInitialView();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Never let a renderer crash take the whole app down silently -
  // and never dump a raw stack trace into the UI (see welcome.js's
  // own crash-safe rendering for the user-facing side of this).
  app.on(
    'render-process-gone',
    (event, webContents, details) => {
      console.error(
        '[main] Renderer process gone:',
        details
      );
    }
  );

  app.on(
    'child-process-gone',
    (event, details) => {
      console.error(
        '[main] Child process gone:',
        details
      );
    }
  );
}
