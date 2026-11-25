/**
 * Smoke test (THROWAWAY): the local connect screen loads from file:// and ends in renderer/connect.html.
 * Run: xvfb-run -a node_modules/electron/dist/electron --no-sandbox --disable-gpu spike/smoke-connect-screen.js
 * (--no-sandbox only for the root CI container.) Exit code 0 only on success.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, '..', 'preload.js') } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'connect.html'));
  const url = win.webContents.getURL();
  const hasApi = await win.webContents.executeJavaScript("typeof window.wireClient === 'object' && typeof window.wireClient.connect === 'function'");
  const ok = url.endsWith('renderer/connect.html') && hasApi;
  console.log('[smoke] URL:', url);
  console.log('[smoke] wireClient exposed on file:// :', hasApi);
  console.log('[smoke] PASS:', ok);
  app.exit(ok ? 0 : 1);
});
