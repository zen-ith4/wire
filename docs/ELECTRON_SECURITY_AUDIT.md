# Electron Client: Security Audit of the CURRENT App (read-only)

**Branch:** `electron-bundled-spike`, base main `998fa50a6476693a6b7b7646424d7ccfeb8aabad`.
**Scope:** `electron-client/main.js` (718 lines), `electron-client/preload.js` (119 lines), and `public/js/core/app.js:848-890` for the update notice. Nothing was changed; every diff below is PROPOSED, NOT APPLIED.
**Method:** code reading. Items marked [NOT VERIFIED] were not confirmed by an experiment or by reading documentation in this session.
**Severity** reflects what a malicious or compromised SERVER can do, not API deprecations.

## a) Trust model today

`main.js:380` loads the whole UI from the server (`mainWindow.loadURL(serverUrl)`), and `main.js:375` loads the local connect screen via `loadFile`. So all JavaScript that touches the E2EE identity is served by the server. A server (or anyone controlling it) can: read and write anything the page can; call every method that `preload.js` exposes to non-`file:` pages (`preload.js:15-` `electronAPI`: `isElectron`, `storeIdentityUnlockKey`, `getIdentityUnlockKey`, `clearIdentityUnlockKey`, `getHardwareAcceleration`, `setHardwareAcceleration`, `relaunchApp`, `showConnectScreen`, `onUpdateAvailable`, `showDmNotification`, `onDmNotificationClicked`); trigger `shell.openExternal` through navigation or `window.open`; and replace the client code at any time. The connect-screen API (`wireClient`) is exposed only when `window.location.protocol === 'file:'` (`preload.js:10-14`).

## b) IPC handlers

| Channel | main.js | Check performed | Notes |
|---|---|---|---|
| `identity:store-unlock-key` | 481 | `event.sender.getURL()` origin (`:454-460`) must equal the renderer-supplied `claimedOrigin` (`:483-486`) | claimedOrigin adds nothing: the origin comes from the main process; the renderer string is only compared to it |
| `identity:get-unlock-key` | 515 | same | returns the decrypted unlock key to the calling page (`:534`) |
| `identity:clear-unlock-key` | 542 | same | |
| `app:hardware-acceleration:get/set` | 571, 575 | none | any page can write `app-settings.json` |
| `app:relaunch` | 583 | none | any page can relaunch the app |
| `server:show-connect-screen` | 598 | none | |
| `dm-notification:show` | 621 | `event.sender === mainWindow.webContents`; field types checked | no `senderFrame` check |
| `server:get-saved`, `server:forget`, `server:connect` | 662, 667, 672 | none (rely on the preload gate: exposed only on `file:`) | `server:connect` validates the address (http/https only, `normalizeServerAddress`) |

No handler checks `event.senderFrame`. The identity store is the file `identity-unlock-keys.json` in `userData` (`main.js:452`); values are encrypted with `safeStorage.encryptString` and base64-encoded (`:505-506`), but the JSON keys are `<origin>::<userId>` in plaintext (`:462-464`, `:506`). `nodeIntegrationInSubFrames` is not set (grep: no match), so by Electron default the preload is not expected to run in subframes [NOT VERIFIED by experiment].

What a malicious server page can read or overwrite: read the decrypted unlock key for its own origin and user (`:515-540`; this is the intended "remember me" feature and is the core reason the client must not come from the server), overwrite or delete that entry, change the hardware-acceleration setting, relaunch the app repeatedly.

## c) `shell.openExternal` and window open

- `main.js:329-332`: `setWindowOpenHandler` passes ANY url to `shell.openExternal(url)` and denies the window.
- `main.js:338-347`: `will-navigate` passes every navigation target that is not `file:` and not the server origin to `shell.openExternal(targetUrl)`, again with no scheme check. `new URL(targetUrl)` is also not wrapped in try/catch (`:339`).
- Reachable schemes: everything the OS has a handler for (`file:`, `smb:`, `ms-*`, `search-ms:`, custom app protocols, etc.). Only the server address typed at the connect screen is restricted to http/https (`normalizeServerAddress`).

## d) Permissions

`grep` finds no `setPermissionRequestHandler` or `setPermissionCheckHandler` in `main.js`. Electron's documented default, when no handler is set, is to grant requests; this was NOT re-read or tested here [NOT VERIFIED]. If correct, a server page gets microphone, camera, geolocation and similar with no app-level control.

## e) Update flow

`checkServerVersion` (`main.js:201-`) does `GET <server>/api/version` and parses a version string. `loadRemoteServer` (`:378-399`) sends `app-update:available` with two version strings to the page. The main process downloads and opens nothing. The page then shows a confirm dialog and calls `updateServiceWorker()` (`public/js/core/app.js:855-890`), which makes the app fetch new client code FROM THE SERVER. So today "update" means "the server replaces the client", the opposite of the project goal. No installer, signature or hash is involved; a hash fetched from the same server would prove nothing against that server. A malicious server can also trigger the dialog at will (fake update prompts) by reporting a higher version.

## f) CSP

The app sets no CSP (grep: no `onHeadersReceived`). CSP exists only if the server sends it (`CSP_ENFORCE`). If the server stops sending it, nothing in the app limits the page.

## g) Already secure (keep) and findings

Keep: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webviewTag:false` (`main.js:314-320`); no-new-window (action `deny`, `:331`); connect-time scheme limit to http/https; `file:` gate on the connect API (`preload.js:10-14`); `contextBridge` instead of exposing `ipcRenderer`; `dm-notification:show` validates sender and payload types.

| # | Severity | file:line | What a malicious server can do | Proposed diff (NOT applied) |
|---|---|---|---|---|
| 1 | HIGH | `main.js:329-332`, `main.js:338-347` | Make the app hand arbitrary URLs (any scheme) to the OS: `window.open('smb://...')`, `location = 'file:///...'` or a custom-protocol URL | allowlist http/https via parsed URL (diff A) |
| 2 | HIGH | no handler anywhere (grep) | Use microphone/camera/etc. without an app-level gate if Electron's default is to grant [NOT VERIFIED] | permission handlers (diff B) |
| 3 | HIGH (design) | `main.js:380`, `:515-540`, `public/js/core/app.js:855-890` | Serve any client code, read the stored unlock key for its origin, push the "update" | the bundled-client design (see design doc); after bundling, bind storage to the origin the MAIN process connected to, include the server origin in the key, remove `updateServiceWorker` for Electron |
| 4 | MEDIUM | `main.js:481,515,542,571,575,583,598,621,662,667,672` | No `senderFrame` check on any handler | check frame URL on every handler (diff C) |
| 5 | MEDIUM | `main.js:575-586` | Relaunch loop (availability), change hardware-acceleration setting | restrict to the bundled settings page or require user gesture; at least apply diff C |
| 6 | MEDIUM | `main.js:338-347` | `new URL(targetUrl)` can throw on a malformed target inside the event handler | try/catch (included in diff A) |
| 7 | LOW | no `onHeadersReceived` | If the server stops sending CSP, no protection | app-applied CSP (design doc section 6) |
| 8 | LOW | `main.js:452-506` | `identity-unlock-keys.json` reveals which servers and user ids exist; strength of `safeStorage` depends on the OS backend (on Linux possibly a weak backend) [NOT VERIFIED] | hash the record id; document the Linux backend behaviour |
| 9 | MEDIUM (maintenance blocker, not exploitable) | `main.js:505,534` | none directly. The Electron 45 release notes (https://newreleases.io/project/npm/electron/release/45.0.0, read in this session) say the synchronous `safeStorage` methods are deprecated and will be removed in Electron 46, so staying on the synchronous calls blocks the next major upgrade | migrate to the async `safeStorage` methods before Electron 46 (check the 45/46 API docs for exact names) |

### Diff A: openExternal allowlist and navigation (NOT applied)

```diff
+function openExternalSafely(rawUrl) {
+  let u;
+  try { u = new URL(rawUrl); } catch { return; }
+  if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
+}
@@
   mainWindow.webContents.setWindowOpenHandler(({ url }) => {
-    shell.openExternal(url);
+    openExternalSafely(url);
     return { action: 'deny' };
   });
@@
   mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
-    const target = new URL(targetUrl);
+    let target;
+    try { target = new URL(targetUrl); } catch { event.preventDefault(); return; }
     const isLocalConnectScreen = target.protocol === 'file:';
     const isCurrentServer = currentServerOrigin && target.origin === currentServerOrigin;
     if (!isLocalConnectScreen && !isCurrentServer) {
       event.preventDefault();
-      shell.openExternal(targetUrl);
+      openExternalSafely(targetUrl);
     }
   });
```

### Diff B: permissions, microphone only (NOT applied; today's origin is the server origin, after bundling it is the bundled origin)

```diff
+const ALLOWED_ORIGIN = () => currentServerOrigin; // bundled design: 'wire-bundled://app'
+app.whenReady().then(() => {
+  const ses = session.defaultSession;
+  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
+    const ok = permission === 'media' && details.requestingUrl && new URL(details.requestingUrl).origin === ALLOWED_ORIGIN()
+      && (details.mediaTypes || []).every((t) => t === 'audio');
+    cb(Boolean(ok));
+  });
+  ses.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && origin === ALLOWED_ORIGIN());
+});
```

(`session` must be added to the `require('electron')` on `main.js:16`. Screen sharing is deliberately not allowed here. Per the Electron 45 blog, a handler that grants `media` and denies everything else also blocks `display-capture` (screen sharing); allowing it is an owner decision.)

### Diff C: sender frame check on every handler (NOT applied)

```diff
+function senderIsTrusted(event) {
+  const f = event.senderFrame;
+  if (!f || f !== event.sender.mainFrame) return false;      // top frame only
+  try { return new URL(f.url).origin === TRUSTED_ORIGIN(); } catch { return false; }
+}
 ipcMain.handle('app:relaunch', (event) => {
+  if (!senderIsTrusted(event)) return false;
   app.relaunch();
   app.exit(0);
 });
```

Apply the same first line to every `ipcMain.handle`/`ipcMain.on` listed in section b. For identity storage, drop the renderer-supplied `claimedOrigin` and derive the bucket from the server origin the main process connected to (`currentServerOrigin`) plus the bundled origin.
