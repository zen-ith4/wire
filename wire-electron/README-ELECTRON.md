# Wire Desktop (Electron)

This adds a hardened Electron desktop client on top of the existing Wire
server + web app. It does **not** change how Wire is deployed as a website,
and it does **not** bundle the Node/Express server or the database into the
desktop app.

## Architecture

```
Electron BrowserWindow  --loadURL-->  https://<your-wire-server>
                          (HTTPS/WSS)
```

On first launch, Electron shows a small **local** Welcome screen
(`electron/renderer/welcome/`) that asks for your Wire server's URL, tests
it for real, and — once connected — simply points the *same*
`BrowserWindow` at that server's origin with `loadURL()`.

From that moment on, the window is running the existing `public/` web app
exactly as a browser tab would, served by your Wire server. Nothing in
`public/js/` had to be taught about a "configured base URL": every
existing call in `core/api.js`, `core/socket.js`, `files/upload.js`, etc.
already uses same-origin-relative URLs (`/api/...`, `/socket.io/...`), so
once `window.location.origin` really is your Wire server, everything just
works unmodified — REST calls, Socket.IO, uploads, avatars/banners,
attachments, voice messages, E2EE key storage (IndexedDB), auth token
(localStorage) — all of it.

This is why the client is intentionally *not* a rewrite: it's a thin,
security-hardened shell around the existing frontend, not a second
implementation of it.

## Files created

```
electron/
  main/
    index.js               # app lifecycle, window creation, menu, IPC wiring
    config-store.js         # persistent per-user JSON config (userData dir)
    server-connection.js    # URL normalize/validate + real connection test
    cert-utils.js            # shared certificate-fingerprint helper
    security.js              # navigation lock-down, window.open policy, cert pinning
    ipc-handlers.js          # the entire validated IPC surface
    window-state.js          # remembers window size/position/maximized
    menu.js                  # application menu (Server Settings, Reload, etc.)
  preload/
    index.js                 # contextBridge — the ONLY thing exposed to the renderer
  renderer/
    welcome/
      welcome.html
      welcome.css
      welcome.js              # first-run / reconnect / change-server / cert-trust UI
  build/
    icons/                    # icon.png (1024), icon.ico, and a full Linux icon set,
                               # generated from public/img/logo.jpg
public/js/settings/
  desktop.js                  # NEW — "Desktop App" settings section (Electron-only)
```

## Files modified

- **`server.js`** — added one small, unauthenticated `GET /api/health`
  route (still subject to the existing `ipRestrict` WireGuard-subnet gate,
  like every other route) so the desktop client has a cheap way to tell
  "reachable Wire server" apart from "wrong URL" / "blocked by the IP
  gate" / "not a Wire server at all". No existing endpoint did this.
- **`public/js/settings/settings.js`** — added an import and two call
  sites (one `await` for the new section's HTML, one function call to
  wire up its listeners) to render a "Desktop App" section. This section
  renders to an empty string and does nothing when running in a normal
  browser tab (`window.electronAPI` doesn't exist there), so the web
  deployment is unaffected.
- **`package.json`** — `main` now points at `electron/main/index.js`
  (only relevant to `electron .` / electron-builder — `npm start` still
  runs `node server.js` exactly as before via its own script). Added
  `electron`, `electron-builder`, `cross-env` devDependencies, new
  scripts, and an electron-builder `build` config.
- **`.gitignore`** — added `release/` (electron-builder's output dir).

## Server URL configuration

- **First launch**: no `serverUrl` in config → Welcome screen with an
  empty form.
- **Validation** (`electron/main/server-connection.js`): accepts
  `https://host`, `http://host:port`, IPs, `localhost`; requires
  `http`/`https`; normalizes to a bare origin (no trailing slash, no
  path); never rewrites `http` → `https` or vice versa; rejects anything
  that doesn't parse as a URL.
- **Connection test**: a real `GET /api/health` request from the main
  process (Node's `https`/`http`, not a fake success). Falls back to a
  bare `GET /` if `/api/health` 404s, so older/pre-existing deployments
  aren't blocked. Distinguishes `connected` / `invalid_url` /
  `unreachable` / `tls_error` / `access_denied` (server up but the
  WireGuard IP gate rejected it) / `server_error`.
- **Persistence**: `app.getPath('userData')/wire-config.json` — a
  per-user OS directory (e.g. `~/.config/Wire/` on Linux), never the
  project directory, never `.env`, written atomically (temp file +
  rename).
- **Changing it later**: Settings → **Desktop App** section (only visible
  in the Electron app), or the **File → Server Settings…** menu item /
  `Cmd+,` — both go through the same test-then-connect flow. Switching
  servers never deletes anything: browser storage (localStorage,
  IndexedDB — where the auth token and E2EE identity keys live) is
  partitioned by origin, so the previous server's data is simply not
  visible from the new origin; it isn't touched, let alone deleted.

## Electron security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webviewTag: false` on the only `BrowserWindow` the app creates.
- **Preload** (`electron/preload/index.js`) exposes exactly one object,
  `window.electronAPI`, with named methods (`getServerUrl`,
  `connectToServer`, `testServerUrl`, `forgetServer`,
  `getCertificateInfo`, `trustCertificate`, `getAppVersion`,
  `getPlatform`, `reload`, `openExternal`, `onConnectionStatus`) — no
  `require`, `ipcRenderer`, `fs`, or `process` ever reaches the page.
- **IPC arguments are validated in the main process**
  (`ipc-handlers.js`), not trusted from the renderer.
- **Navigation policy** (`security.js`): the window may only ever
  navigate its main frame to the local welcome files or the currently
  configured server's origin; anything else (including `window.open`)
  is handed off to the OS default browser instead of hijacking the app
  window.
- **TLS**: verification is always on. The only exception is a narrow,
  explicit, per-origin **certificate pin**: if a self-signed cert can't
  be verified automatically, the user can view its fingerprint/issuer and
  choose to trust *that exact certificate* for *that exact origin*. A
  different certificate later presented for the same origin (e.g. a
  MITM swap) is still rejected. TLS verification is never disabled
  globally, and HTTPS is never silently downgraded to HTTP.
- Microphone access (for voice messages) is only granted to the
  currently configured server's origin; everything else is denied by
  default via `setPermissionRequestHandler`.

## Development

```bash
npm install                 # once network/npm access is available

npm run server               # or: npm start  — run the Wire server standalone (unchanged)
npm run electron:dev         # run the Electron shell in development mode
```

`electron:dev` sets `NODE_ENV=development`, which enables the DevTools
menu item (hidden in production builds).

## Production build

```bash
npm run build            # electron-builder, all configured targets
npm run build:linux      # AppImage
npm run build:win        # NSIS installer
npm run build:mac        # DMG (Intel + Apple Silicon)
```

Artifacts land in `release/` (gitignored). `package.json`'s `build.files`
only includes `electron/**` — the server (`server.js`, `controllers/`,
`routes/`, `services/`, `database/`, `sockets/`, `middleware/`,
`config/`, `utils/`, `public/`, uploads, `data.db`) is **not** packaged
into the desktop app at all, since the app never serves `public/` itself
— it always loads it from your actual Wire server over HTTPS.

## Known limitations

1. **Not yet runtime-tested.** This sandbox has no network access (so
   `npm install` for `electron`/`electron-builder` couldn't be run) and
   no display server to launch a real Electron window. Every new file
   passed `node --check` (syntax) and the modified files were reviewed
   line-by-line against the existing call sites, but the actual
   click-through flow (first launch → connect → restart → Settings →
   change server → reconnect) has not been exercised end-to-end. Please
   run through the checklist below on your machine after `npm install`.
2. **macOS `.icns` generation**: the icon is supplied as a 1024×1024 PNG
   plus a Windows `.ico`; electron-builder will generate the `.icns` at
   build time (it bundles its own converter), but this hasn't been
   verified on an actual macOS build machine.
3. **Certificate pinning** protects against the certificate changing
   later, but pinning itself (the "Trust this certificate" click) is a
   deliberate trust-on-first-use decision the user makes — exactly the
   same trade-off a browser's "proceed anyway" warning makes for a
   self-signed cert. It is not a substitute for a properly-issued
   certificate on a public deployment.
4. No auto-update mechanism is configured (electron-builder supports one,
   but it wasn't in scope here and needs a release/distribution channel
   to point at).

## Manual test checklist

1. First launch, no config → Welcome screen, empty form.
2. Enter an invalid string ("not a url") → inline validation error, no
   IPC round-trip needed for the obviously-empty case, a real one for
   malformed URLs.
3. Enter an unreachable host → "Server unavailable" banner, form
   re-enabled.
4. Enter a valid, reachable Wire server URL → "Connecting…" → app loads.
5. Quit and relaunch → app goes straight back to that server (no
   Welcome screen), confirming `wire-config.json` persisted.
6. Settings → Desktop App → change the URL → Save & reconnect → app
   reloads pointed at the new origin.
7. Relaunch again → confirms the *new* URL persisted.
8. Confirm REST calls, Socket.IO, uploads, avatars/banners, and
   attachments all work against the configured server (they all ride on
   `window.location.origin`, so this is really "confirm the app loaded
   from the right origin").
9. Log out / log in again.
10. Create/verify an E2EE identity on server A, switch to server B, come
    back to server A — confirm the identity on A is intact (never
    touched by the switch).
11. Click an external link inside the app → opens in the OS default
    browser, not a second Electron window.
12. Try `window.open()`-style flows in the app (e.g. a share link) →
    same: OS browser, not the app window.
13. Point the app at a self-signed HTTPS server → "TLS/certificate
    error" → View certificate details → Trust this certificate & connect
    → succeeds; relaunch → still trusted (pin persisted).
14. Run a full production build (`npm run build:linux` or your platform)
    and repeat steps 1–4 against the packaged app, not just `electron
    .`.
