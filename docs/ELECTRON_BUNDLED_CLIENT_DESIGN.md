# Electron Bundled Client — Design Document

**Branch:** `electron-bundled-spike`  
**Base:** main at `998fa50a6476693a6b7b7646424d7ccfeb8aabad`  
**Phase:** 1 (Feasibility + Design) — NOT implementation  
**Spike Results:** `docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`  
**Security audit of the current app:** `docs/ELECTRON_SECURITY_AUDIT.md` (read-only; diffs are PROPOSED, not applied)

> **Status legend used throughout**
>
> - **Verified (code)** — read from this tree at this commit; file:line cited.
> - **Verified (experiment)** — measured in the spike, not in this repo's product code.
> - **Planned** — a decision for a later phase; nothing implements it today.
> - **Not verified** — stated as a requirement but not proven, or not testable in this environment.
> - **Dropped** — a claim from an earlier draft that the code or a later decision contradicts; it is not restored.

The existing `electron-client/` is **not** the bundled client. It is a thin shell that loads
the chosen server's own web UI (`electron-client/main.js:380`). Everything below about
`wire-bundled://app`, app-enforced CSP, partitions and permission handlers is therefore
**Planned** unless marked otherwise.

Phase numbers are used throughout this document:

| Phase | Meaning |
|-------|---------|
| 2 | Harden the current server-loaded app (IPC, openExternal, navigation, CORS, permissions) |
| 3 | Prepare `public/` for a separate server origin (injectable server base, absolute URLs) |
| 4 | Build the bundled client (protocol handler, integrity manifest, CSP injection) |
| 5 | Server changes (Socket.IO CORS for bundled origin, version endpoint behaviour) |
| 6 | User migration (log in again, restore identity from server) |
| 7 | Release (code signing, packaging, update notices) |

---

## 1. Locked decisions

These are accepted; later phases implement them. They are not options in the table any more.

| # | Decision | Phase | Notes |
|---|----------|-------|-------|
| D1 | The bundled client connects to the server **directly**, restricted by an app-enforced CSP. | 4 | No main-process network bridge in Phase 2. The Q2 experiment showed direct `fetch()` and WebSocket work from the bundled scheme. The CSP is the control that limits where the page may connect. |
| D2 | **HTTPS only**, and `wss://` for sockets. | 4 | Plain HTTP/WS is allowed **only** in unpackaged development/test builds (`app.isPackaged === false`), and only to `localhost`, `127.0.0.1` or `[::1]`. No user setting and no environment variable may enable HTTP in a packaged build. Saved addresses and redirects are covered. Certificate validation is never disabled globally. |
| D3 | One **persistent session partition per server**. | 4 | Protocol handler, CSP header injection and permission handlers are registered on every partition, not just the default one. |
| D4 | Existing users **log in again** and restore their identity from the server, and are **told** that this happens. | 6 | Conditional on the Phase 6 inventory of device-only data (peer pins, verified state, old DM keys, group sender keys, KDF pin). Do **not** claim nothing is lost. |
| D5 | Updates are a **notification only**, with a fixed link inside the app. App code is **never** downloaded from the server. | 7 | The server's version endpoint may only cause a notice. |
| D6 | Permissions: **microphone only**, and only for the allowed app origin; notifications through the main process; **screen sharing and everything else denied**. | 4 | Enforced in both `setPermissionRequestHandler` and `setPermissionCheckHandler` per partition. |
| D7 | **Code signing: still open.** | 7 | No signing/notarization decision is made by this document. |

---

## 2. What exists today (verified)

| Area | Reality in this tree | Status |
|------|----------------------|--------|
| Bundled UI | `electron-client/package.json:25-32` packages only `main.js`, `preload.js`, `renderer/**/*`, an icon and `package.json`. **`public/` is not included.** | Not bundled |
| Page origin | The window loads the remote server (`electron-client/main.js:380`). | Server-loaded UI |
| Custom protocol | Only in `electron-client/spike/`; `main.js` has no `protocol.registerSchemesAsPrivileged` / `protocol.handle`. | Spike only |
| App CSP | `main.js` has no `webRequest.onHeadersReceived`; the page receives the **server's** CSP. | Not implemented |
| Session partition | `BrowserWindow` is created without `partition` (`electron-client/main.js:314-321`), so every server uses the default session. | Not implemented |
| Permission handler | No `setPermissionRequestHandler` anywhere in `electron-client/`. | Not implemented |
| Update flow | `checkServerVersion()` calls `/api/version` (`main.js:201-263`), then emits `app-update:available` (`main.js:382-397`). No download link, no installer execution. | Partial (notice only) |
| Code signing | No build/signing configuration in the repo. | Open |
| HTTPS enforcement | `normalizeServerAddress()` accepts `http:` and `https:` in both packaged and unpackaged builds (`main.js:141`). | Not implemented |

---

## 3. Threat model

Only protections that are actually implemented and tested are marked **Implemented**.
Everything that depends on the bundled client is **Planned** until Phase 4 ships and tests it.

### 3.1 Current state (server-loaded UI, what ships today)

| Capability of a malicious/compromised server | Current state | Evidence |
|---|---|---|
| Replace client code | Can serve any JS. | `main.js:380` loads the server URL. |
| Weaken CSP | It sends the CSP the page obeys. | `middleware/csp.js` runs on the server; the client does not override it. |
| Serve different code per user | Possible (server-side). | Same. |
| Trigger a fake update notice | Possible: it controls `/api/version`. | `main.js:201-263`, `382-397`. |
| Read traffic | It terminates TLS. | Deployment-dependent. |
| Read the encrypted identity blob | The server stores it. | `controllers/me.controller.js:619,639,756`; `public/js/crypto/identity-service.js:106`. |
| Read message plaintext | No, for E2EE content; metadata is visible. | Existing E2EE design, unchanged. |

### 3.2 After bundling (target)

| Capability | Mitigation | Phase | Status |
|---|---|---|---|
| Replace client code | UI files ship in `app.asar`; the protocol handler serves only those files. | 4 | **Planned.** `public/` is not in the package today (`package.json:25-32`), and `main.js` has no handler. |
| Serve different code per user | One identical bundle for all users. | 4 | **Planned.** |
| Weaken CSP | The app sets its own CSP on every document response, regardless of server headers. `'self'` is `wire-bundled://app`, not the server. | 4 | **Planned.** No CSP injection exists in `main.js`. |
| Reach arbitrary hosts | App-enforced `connect-src` limited to the chosen server; HTTPS/wss gate. | 4 | **Planned.** Q2 only proved fetch/WS are *possible*; it did not test a restrictive CSP. |
| Push executable updates | Notification only; fixed in-app link; no server-supplied code or installer. | 7 | **Planned.** Today the server already supplies the whole UI. |
| Read message plaintext | E2EE stays end-to-end; server sees ciphertext and metadata. | — | **Implemented** in the existing protocol, unchanged by bundling. |
| Read the raw private key | The server holds only an encrypted blob; decryption happens in the renderer. | — | **Implemented**, with the caveat that the blob and KDF parameters are server-supplied. Do **not** claim "keys never leave the renderer". |
| Read the session token | The renderer stores it in `localStorage` (`public/js/core/auth.js:51,81`); a malicious server can read it. | — | **Not protected** by bundling. Token theft is outside this design's scope. |
| Read renderer storage from server code | **Impossible:** bundled server code runs in Node on the server; renderer `localStorage`/`IndexedDB` live in the Electron renderer process and are never exposed to the server. | 4 | **By architecture.** The bundled server code cannot read renderer storage; the server still receives the tokens it issues over the network (the `Authorization: Bearer` header on every API call), which is unavoidable and expected. |

---

## 4. Architecture (direct connection, no bridge)

```
┌──────────────────────────────────────────────────────────────────┐
│                        ELECTRON MAIN PROCESS                     │
│                                                                  │
│  wire-bundled:// handler        CSP injection (per partition)    │
│  (per-session protocol.handle)  permission handlers (per part.)  │
│                                                                  │
│  safeStorage: encrypts the *derived unlock key* only             │
│  (not the identity private key — that lives in the renderer)     │
│                                                                  │
│  one persistent partition per server: persist:server:<hash>      │
└───────────────┬──────────────────────────────────────────────────┘
                │ loads wire-bundled://app/index.html
                ▼
┌──────────────────────────────────────────────────────────────────┐
│                 RENDERER  (wire-bundled://app)                   │
│  • bundled HTML/JS/CSS from app.asar                             │
│  • crypto.subtle — E2EE key operations                           │
│  • IndexedDB — pins, sender keys, unlock-key cache               │
│  • localStorage — session token, UI preferences                  │
│  • fetch() ───────────────────────────────────────► server HTTPS │
│  • Socket.IO WebSocket ───────────────────────────► server WSS   │
│  • IPC → main: notifications, safeStorage, connect screen        │
└──────────────────────────────────────────────────────────────────┘
```

**There is no network bridge.** The earlier revision's diagram showed a main-process
"fetch + WS proxy" next to the protocol handler, which contradicted the Q2 result and D1.
The bridge is not part of Phase 2. IPC is used only for OS integration (notifications,
safeStorage, the connect screen, settings), never to proxy HTTP or WebSocket traffic.

### Data flow

1. Connect screen: user enters a server address → main validates it (D2) → saves it.
2. Main creates/selects the persistent partition for that server and registers the
   protocol, CSP and permission handlers on it (D3).
3. Main loads `wire-bundled://app/index.html` in that partition.
4. The renderer receives the server endpoint over IPC and sets the client's base URL.
5. API calls and Socket.IO connect **directly** to the server, allowed by `connect-src`.
6. Identity unlock key (remember-me) may be stored via main-process `safeStorage`; the
   encrypted identity blob itself comes from the server, as today.

---

## 5. Origin, URLs and storage — corrections checked against the code

### 5.1 Changing `getServerEndpoint()` alone is not enough

**Verified (code).** `getServerEndpoint()` returns `window.location.origin` outside
Capacitor (`public/js/core/server.js:73-76`). But `resolveServerUrl()` returns the input
unchanged when not Capacitor (`public/js/core/server.js:104-111`):

```js
if (!isCapacitor()) {
  return url;      // stays relative
}
```

So with the bundled origin, a relative `/api/...` would be resolved by the renderer against
`wire-bundled://app`, not against the server. Both functions must change together (or
`resolveServerUrl()` must always join against the injected endpoint). The design previously
listed only the `getServerEndpoint()` change.

### 5.2 `URL.origin` is `"null"` for `wire-bundled://app` in Node — do not compare it

**Verified (code/Node).**

```
new URL('wire-bundled://app/index.html').origin === 'null'
```

The spike observed the renderer origin as `wire-bundled://app` (Q1), so the two sides
disagree about `.origin`. The main process must compare a normalized
`scheme://host` string (e.g. `url.protocol + '//' + url.host`), not `url.origin`.

This matters in existing code:

- `unlockKeyStoreOrigin()` returns `new URL(event.sender.getURL()).origin`
  (`electron-client/main.js:456`). For the bundled scheme that is `"null"`.
- The remember-me IPC handlers then compare it with the renderer-supplied
  `claimedOrigin` and reject on mismatch (`main.js:481-486`, `515-519`, `542-546`).
- The renderer's claimed origin comes from `getIdentityStorageOrigin()`, which returns
  `getServerEndpoint()` (`public/js/core/auth.js:282-284`) — the **server** origin, not the
  page origin.

**Not verified inside Electron:** the exact string `event.sender.getURL()` returns for the
custom scheme in this Electron version, and whether `claimedOrigin === serverOrigin` is the
right pairing. The design requirement is: derive the server origin from the app's own
per-partition mapping, normalize both sides identically, and add a test for the custom
scheme. Until that test exists, remember-me under `wire-bundled://` must be treated as
**broken/planned**, not as working.

### 5.3 All servers share one bundled origin → shared storage

**Verified (code).** `wire-bundled://app` is one origin regardless of which server is
selected. Therefore `localStorage` and IndexedDB are shared unless the app separates them.
Some stores are namespaced by server endpoint:

- peer pins: `public/js/crypto/keys/peer-key-gate.js:143-151` + `peer-trust.js:191-193,225-229`
- scheme-2 KDF pins: `public/js/crypto/account-kdf.js:28-35`
- DM replay/pin scope: `public/js/crypto/messages/dm-v2-wire.js:157-165`

Others are not, e.g. the session token key `'token'` (`public/js/core/auth.js:51,81`) and
UI preferences (`theme.js`, `emoji-picker.js`, `message-sounds.js`). D3 (one persistent
partition per server) is what isolates them; the endpoint-prefixed keys are defence in
depth inside a partition, not a substitute for it.

### 5.4 Data under the old server origin is invisible to the bundled origin

**Verified (code/browser model).** Browser storage is origin-scoped. IndexedDB databases
such as `wire-peer-trust`, `wire-e2ee-store` and the unlock-key store
(`public/js/crypto/keys/unlock-key-store.js:19,41`) opened by the old server-origin page
cannot be read from `wire-bundled://app`. The executable's `safeStorage` file
(`electron-client/main.js:452-480`) is outside the browser store, so it **can** survive —
but its record key currently depends on the broken `.origin` comparison above.

Consequence for D4: users must log in again against the server and restore the identity
from the encrypted blob. Peer pins, verified marks, old DM keys, group sender keys and the
KDF pin may be lost unless Phase 6 finds and migrates them. The UI must say so; the design
must not promise "nothing is lost".

---

## 6. Network policy enforcement (D2)

| Situation | Allowed |
|---|---|
| Packaged build (`app.isPackaged === true`) | `https://` for HTTP APIs; `wss://` for Socket.IO. No `http:`/`ws:` at all. |
| Unpackaged dev/test (`app.isPackaged === false`) | `http:`/`ws:` only when the host is exactly `localhost`, `127.0.0.1` or `[::1]`. |
| Any user setting / environment variable | Cannot relax the above. Not read for this decision. |

Enforcement points (all **Planned**):

1. Address validation at connect time and again when a saved address is loaded. The current
   validator accepts HTTP unconditionally (`electron-client/main.js:115-150`, especially
   line 141) and must gain the packaged/unpackaged branch.
2. Redirects: validate `will-redirect` / `did-redirect-navigation` targets with the same
   rule; a redirect to a disallowed scheme/host is cancelled, never followed and then
   blocked only by CSP. See section 11.
3. The renderer's own Socket.IO/API URLs come from the injected endpoint; they are validated
   by the same function rather than trusted because the user typed them once.
4. `connect-src` in the app CSP is built from the validated server origin only.

Why the app must enforce it: `wire-bundled` is registered `secure: true`, so the page is a
secure context and Web Crypto is available even when it talks to plain HTTP. The spike's Q2
experiment confirmed Chromium does **not** block `http://`/`ws://` from this scheme.
Therefore HTTPS-only is an application policy, not something the platform enforces.

Certificate validation is never disabled globally: no `--ignore-certificate-errors`, no
`certificate-error` handler that returns `callback(true)` for arbitrary certificates.

---

## 7. Session partitions (D3)

**Verified (code, as a gap):** `electron-client/main.js:314-321` sets no `partition`, so
all windows/servers share `session.defaultSession`.

**Planned:** for each server origin:

- `const partition = 'persist:server:' + sha256(origin)` (one stable partition per server).
- Pass it as `webPreferences.partition`.
- On that session, register:
  - `protocol.handle('wire-bundled', ...)` (protocol handlers are per-session),
  - `webRequest.onHeadersReceived` that sets the CSP,
  - `setPermissionRequestHandler` and `setPermissionCheckHandler`.
- `protocol.registerSchemesAsPrivileged` stays a one-time, app-level call before `ready`;
  the scheme privileges are global, the handlers are per partition.
- Switching servers switches partitions; clearing a server can clear only its partition.

This is also what prevents server A's IndexedDB (`token`, pins, caches) from being visible
to server B on the same machine.

---

## 8. CSP applied by the app (requirement a)

### 8.1 `'self'` is `wire-bundled://app`, not the server

**Verified (code/spike).** The Q1/Q2 experiments showed the renderer on the bundled scheme
has origin `wire-bundled://app` (`docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`, Q1). In the CSP
header, `'self'` therefore resolves to `wire-bundled://app` — **not** to the configured
server origin. The server origin must be listed explicitly as a separate origin in
`connect-src` (and `wss://` separately, since `https://host` does **not** authorize
`wss://host`).

### 8.2 Every client load of server resources, traced with file:line

The bundled client fetches these resource classes from the server. Each is resolved through
`resolveServerUrl()` → `getServerEndpoint()` → the injected server base, so each counts
against `connect-src` (for fetch/XHR/WebSocket) or `img-src`/`media-src` (for elements):

| Resource class | Example endpoint | file:line | CSP directive |
|---|---|---|---|
| API fetch (JSON) | `/api/version`, `/api/auth/...` | `public/js/core/api.js:84`, `:204` | `connect-src` |
| Blob fetch (avatars, attachments) | `/api/me/avatar/${userId}` | `public/js/ui/avatar.js:146` | `connect-src` + `img-src` |
| Banner fetch | `/api/me/banner/${userId}` | `public/js/ui/avatar.js:180` | `connect-src` + `img-src` |
| Audio playback | `/audio/message-sent.wav` | `public/js/notifications/message-sounds.js:64` | `media-src` |
| Video playback | attachment media URL | `public/js/files/viewer.js:249` | `media-src` |
| Media streams | `sw-stream-client.js` (SW, not registered on bundled origin) | `public/js/media/sw-stream-client.js` | `media-src` (SW not used) |
| File downloads | `/api/dm/attachments/<id>?download=1` | `public/js/files/download.js:88`, `:145` | `connect-src` |
| Socket.IO WebSocket | `/socket.io/?EIO=4&transport=websocket` | `public/js/core/socket.js:110` (`transports`) | `connect-src` (`wss://`) |
| Socket.IO polling fallback | `/socket.io/?EIO=4&transport=polling` | `public/js/core/socket.js:110` | `connect-src` (`https://`) |
| Share links | built from server origin | `public/js/files/links.js:41` | `connect-src` (when fetched) |

### 8.3 Directive table — exactly the required origins, no wildcards

`middleware/csp.js:38-52` is the server's policy that the app must mirror **plus** the
bundled client's cross-origin needs. `'self'` = `wire-bundled://app`; the server origin is
added explicitly per directive:

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Baseline; `'self'` is `wire-bundled://app`. |
| `script-src` | `'self'` | Bundled module scripts only; no inline/eval. |
| `style-src` | `'self' https://fonts.googleapis.com` | `public/index.html` links Google Fonts (`middleware/csp.js:21-24,41`). No `'unsafe-inline'`. |
| `font-src` | `'self' https://fonts.gstatic.com` | Actual font files (`middleware/csp.js:42`). |
| `img-src` | `'self' data: blob:` | Avatars, images and decrypted blob URLs. |
| `media-src` | `'self' blob:` | Audio/video playback and voice messages (`middleware/csp.js:44`). |
| `connect-src` | `'self' https://<server> wss://<server>` (+ loopback `http://`/`ws://` only in unpackaged dev) | Both HTTPS and WSS origins are required; `https://host` does **not** authorize `wss://host`. Socket.IO starts with `websocket` and may fall back to `polling` (`public/js/core/socket.js:110`), so both the HTTP(S) and WS(S) origins of the server are needed. |
| `worker-src` | `'self' blob:` | Any worker/blob worker. The service worker is separate (Q5). |
| `object-src` | `'none'` | Missing from the old draft, present on the server (`middleware/csp.js:47`). |
| `base-uri` | `'self'` | As on the server. |
| `form-action` | `'self'` | As on the server. |
| `frame-ancestors` | `'none'` | As on the server. |
| `manifest-src` | `'self'` | Missing from the old draft, present on the server (`middleware/csp.js:51`). |

No directive uses `*`. `upgrade-insecure-requests` is only meaningful in an enforcing policy
and should not be used as a substitute for the HTTPS gate in section 6 (it does not fix
WebSocket or saved addresses). **Status: Planned.** The Q2 experiment did not test CSP
enforcement; it only proved the connections are mechanically possible.

### 8.4 Q5 status (service workers)

The spike's Q5 is **analysis only, not verified by experiment** (see
`docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`). Decision: the bundled client does **not** register
a service worker. The existing guard already skips non-HTTP(S) pages:

```js
!/^https?:$/.test(location.protocol)   // public/js/core/pwa.js:112-118
```

so `wire-bundled:` returns before `navigator.serviceWorker.register('/sw.js', ...)`.
Consequence: service-worker media streaming (`public/js/media/sw-stream-client.js`) is not
available; `MEDIA_STREAM_ENABLED` stays false. This is a stated limitation, not a claim that
service workers are impossible on the scheme.

---

## 9. Permissions (requirement b, D6)

**Verified (code, as a gap):** no permission handlers exist in `electron-client/`.

**Planned**, per persistent partition:

- `media`: allow only `audio` (`microphone`), **only when the requesting frame's origin is
  exactly `wire-bundled://app`** — the bundled app origin, not the server origin. Camera
  and all other media types are denied. The comparison uses the frame's normalized
  `protocol + '//' + host`, **not** `URL.origin` (which is `"null"` for `wire-bundled://`
  — see section 5.2).
- `notifications`: **deny** in the renderer. Notifications go through the main process
  (`dm-notification:show`, already validated in `electron-client/main.js:621-656`). The web
  path currently calls `Notification.requestPermission()` / `new Notification()`
  (`public/js/notifications/web-notifications.js:31,50`); in the bundled client that path
  must be routed to the main process.
- `display-capture` (screen sharing): **deny**.
- Everything else: deny by default.

Both `setPermissionRequestHandler` and `setPermissionCheckHandler` must implement the same
table; a request handler alone can be bypassed by permission checks. This follows the
owner decision; the Electron-45 screen-sharing note is a rationale, not a tested claim here.
Per the Electron 45 blog, a handler that grants `media` and denies everything else also
blocks `display-capture` (screen sharing); allowing it is an owner decision.

---

## 10. IPC hardening, openExternal, navigation (requirement c)

**Verified (code, as a gap):** the security audit (`docs/ELECTRON_SECURITY_AUDIT.md`)
documents the following gaps in the current `electron-client/` — none are fixed yet, all
are Planned for Phase 2:

- No `event.senderFrame` check on any IPC handler (`main.js:481,515,542,571,575,583,598,621,662,667,672`).
- `setWindowOpenHandler` passes **any** URL to `shell.openExternal(url)` (`main.js:329-332`).
- `will-navigate` passes every non-`file:`, non-server-origin target to `shell.openExternal(targetUrl)` with no scheme check (`main.js:338-347`); `new URL(targetUrl)` is not wrapped in try/catch.
- `app:relaunch`, `app:hardware-acceleration:set` and other handlers have no origin check at all.

### 10.1 IPC hardening with `senderFrame` checks

Every `ipcMain.handle`/`ipcMain.on` must validate the caller's frame before acting:

```js
function senderIsTrusted(event) {
  const f = event.senderFrame;
  if (!f || f !== event.sender.mainFrame) return false;   // top frame only
  try {
    return new URL(f.url).origin === TRUSTED_ORIGIN();     // bundled origin
  } catch { return false; }
}
```

`TRUSTED_ORIGIN()` is `wire-bundled://app` once the bundled client ships; during Phase 2
(hardening the current server-loaded app) it is the server origin the main process
connected to (`currentServerOrigin`). For identity storage, drop the renderer-supplied
`claimedOrigin` and derive the bucket from the server origin the main process connected to
plus the bundled origin — `claimedOrigin` adds nothing because the main process already
knows the real origin (`docs/ELECTRON_SECURITY_AUDIT.md`, section b).

Apply the same first line to every handler: `identity:store-unlock-key` (`main.js:481`),
`identity:get-unlock-key` (`:515`), `identity:clear-unlock-key` (`:542`),
`app:hardware-acceleration:get/set` (`:571,575`), `app:relaunch` (`:583`),
`server:show-connect-screen` (`:598`), `dm-notification:show` (`:621`),
`server:get-saved` (`:662`), `server:forget` (`:667`), `server:connect` (`:672`).

### 10.2 `openExternal` allowlist

Only `http:` and `https:` may be handed to the OS; every other scheme is denied:

```js
function openExternalSafely(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return; }
  if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
}
```

Used by both `setWindowOpenHandler` and the `will-navigate` fallback. `shell.openExternal(url)`
with an arbitrary scheme (`file:`, `smb:`, `ms-*`, custom app protocols, etc.) is **not**
allowed.

### 10.3 Navigation lock / window open handler

```js
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  openExternalSafely(url);
  return { action: 'deny' };
});

mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
  let target;
  try { target = new URL(targetUrl); } catch { event.preventDefault(); return; }
  const isLocalConnectScreen = target.protocol === 'file:';
  const isCurrentServer = currentServerOrigin && target.origin === currentServerOrigin;
  if (!isLocalConnectScreen && !isCurrentServer) {
    event.preventDefault();
    openExternalSafely(targetUrl);
  }
});
```

### 10.4 Protocol path safety + build-time integrity manifest (spike Q6)

**Verified (experiment, spike Q6).** `docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`, Q6:
14/14 manifest, tamper and traversal checks pass on a temp copy of `public/`.

Handler rules:
- URL-decode; reject undecodable input, NUL and backslash (403 "forbidden characters").
- `path.posix.normalize`; reject `..` segments or absolute paths (403 "path traversal blocked").
- Look the file up in the integrity manifest — the manifest is an **allowlist**: anything not listed is 404 "not in manifest".
- Re-check the resolved path stays under the root.
- Hash the file on every read and compare to the manifest (SHA-256); mismatch → 500 "integrity check failed".

The manifest is generated **at build time** (electron-builder `afterPack` or a dedicated
build step) and covers every file under `public/` that the protocol handler may serve,
including `public/audio/*.wav`, `public/img/logo.jpg`, `public/fonts/*` and all of
`public/js/**`. Limits: the manifest is regenerated on every build; a one-byte flip to any
listed file causes a 500; any file not in the manifest (including an attacker-injected
`injected.js`) returns 404.

Note on ASAR: ASAR gives **no** integrity or tamper detection by itself. ASAR integrity
checking is disabled by default and is enabled at package time with the
`EnableEmbeddedAsarIntegrityValidation` fuse; the docs list support for macOS
(electron >= 16) and Windows (electron >= 30) and do not list Linux; you typically also
enable `OnlyLoadAppFromAsar`. Whether electron-builder 26.18.0 provides the header hash and
flips these fuses is **[NOT VERIFIED]**. On Linux there is, per those docs, no built-in
ASAR integrity check, so the per-read manifest check would be the only runtime integrity
check there. Limit: an attacker who can modify the installed app files can also modify the
manifest and handler code, so the manifest detects corruption and partial tampering of
`public/`; its strength against a local attacker depends on OS code signing and the fuses.
It does not address a malicious SERVER, which never touches these files; that protection
comes from bundling the client at all.

### 10.5 Socket.IO CORS allowance for bundled origin only

**Verified (experiment, Q3).** `docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`, Q3: Electron sends
`Origin: wire-bundled://app` from the bundled page.

- `middleware/cors.js:26-29`: `cors({ origin: true, credentials: false })`. `origin: true`
  reflects the request Origin; `credentials:false` means no
  `Access-Control-Allow-Credentials` is ever sent. This already works for the bundled
  origin — **no server change is needed** for the HTTP middleware.
- `config/socket.js:19-21`: Socket.IO uses `origin: process.env.CLIENT_URL || false`. With
  `CLIENT_URL` unset (`false`), the polling fallback has no CORS headers. For the bundled
  origin, either set `CLIENT_URL` to the bundled origin or configure Socket.IO CORS to
  allow `wire-bundled://app` only — **not** `origin: true` (which would reflect any origin).

---

## 11. Redirects (requirement e)

Redirects can reach the bundled client through four paths. Each is listed below with the
control that applies and its verification status.

### 11.1 Navigation (`will-navigate`)

The main-process `will-navigate` handler (section 10.3) validates the target URL's scheme
and origin before allowing it. A disallowed target is **cancelled** (`event.preventDefault()`)
and optionally opened externally via `openExternalSafely` — it is never followed in-process.

### 11.2 Renderer `fetch()` / XHR / WebSocket

The renderer's `fetch()` calls go through `resolveServerUrl()` → injected server base
(`public/js/core/api.js:84`, `:204`). Socket.IO uses `transports: ['websocket','polling']`
(`public/js/core/socket.js:110`). All of these are governed by the app CSP `connect-src`
(section 8): a redirect to a host not in `connect-src` is blocked by the browser's CSP
enforcement. There is **no** main-process interception of renderer-level redirects — the
CSP is the control.

### 11.3 Main-process `net.request`

`checkServerVersion()` (`main.js:201-263`) and `testServerReachable()` (`main.js:128-164`)
use `net.request({ url: serverUrl + '/...' })`. A redirect from `/api/version` to another
host is followed by Chromium's network stack automatically; Electron's `net` module does
not expose a per-redirect blocking hook in this usage. The response is read only for the
version string, and a failed version check is non-fatal (`main.js:268-289` — resolve(null)
and continue). There is **no** redirect allowlist on `net.request` in the current code.

### 11.4 Official Electron 45 docs citation and untested behavior

Electron 45 documentation (https://www.electronjs.org/docs/latest/api/web-contents) describes
`will-navigate`, `did-start-navigation`, `did-redirect-navigation` and `did-navigate` as
**events that fire after the navigation decision has begun**; `did-redirect-navigation` in
particular fires **after** a redirect has been followed, so it is **not a blocking control** —
it observes, it does not prevent. `will-navigate` is the blocking event (`event.preventDefault()`
cancels the navigation). The claim that `did-redirect-navigation` can block a redirect is
**false** and is **not** restored here.

**Not verified inside Electron:** exact redirect behaviour for `wire-bundled://` pages,
behaviour of the CSP on that scheme, per-partition protocol handlers, and any
Windows/macOS build. These are Phase 4 tests, not claims.

---

## 12. Updates (D5) — version compatibility, upgrade and rollback tests

**Verified (code):** the main process calls `GET /api/version`
(`electron-client/main.js:201-263`), compares versions (`main.js:265-289`), and sends
`app-update:available` to the renderer (`main.js:382-397`). It never downloads or executes an
installer.

**Planned:** keep the check, show a notification plus a **fixed link** that is compiled into
the app (project site / release page), and never load app code from the server. No
auto-download, no server-provided installer URL, no update of the bundle over HTTP. Code
signing remains open (D7), so no signed-update claim is made.

**Version compatibility:** `isNewerVersion()` (`main.js:265-289`) parses `X.Y.Z` and compares
component-wise; prerelease suffixes are accepted but ignored in comparison. A test must
cover: equal version → no notice; server newer → notice; server older → no notice; malformed
version → no notice, no crash.

**Upgrade test:** install old version → connect → configure server → upgrade to bundled
version → verify the app starts and shows the connect screen (or migrates per D4).

**Rollback test:** uninstall bundled version → reinstall old version → verify config files
(`server-config.json`, `app-settings.json`) are still readable and the old app connects.

---

## 13. Self-signed and private-CA servers — open question

`utils/tlsSetup.js` offers a "wireguard" mode that generates a **self-signed** certificate
for a private IP (`utils/tlsSetup.js:9-20,38-50`). Its comment says the Electron client
"pins the certificate's fingerprint on first connect (see main.js)"
(`utils/tlsSetup.js:17-18`).

**Verified false today:** `electron-client/main.js` contains no `certificate-error` handler,
no `setCertificateVerifyProc`, and no fingerprint storage. Pinning exists only in the spike
(`electron-client/spike/test-q2-options.js:329-351`). A packaged client pointed at a
self-signed/private-CA server would therefore fail the TLS connection with a certificate
error; there is no user path today.

Options for the owner (none implemented):

1. **Public CA only (recommended).** Domain mode with Caddy/Let's Encrypt. Private-IP users
   are out of scope for the packaged client.
2. **Operator installs a private CA** into the OS trust store. The client keeps normal
   certificate validation; no bypass code. LAN operators can do this with their own CA.
3. **Exact-certificate pinning at first connect.** Store the SHA-256 fingerprint per
   server; on mismatch, hard-fail; check hostname and validity dates too. This replaces CA
   chain validation with exact-certificate equality for that host. It is a deliberate,
   reviewed exception — not "disable certificate validation" — and needs explicit owner
   approval plus its own tests.
4. **Unpackaged dev only:** loopback HTTP (section 6). This does not solve self-signed LAN
   production servers.

Recommendation: option 1, with option 2 for operators who control their own CA. Option 3
only if the owner accepts the trade-off. The client must never ship an accept-all
certificate handler.

---

## 14. Document-vs-code verification table

| Claim checked | Result | Evidence |
|---|---|---|
| `resolveServerUrl()` returns relative URLs outside Capacitor, so changing only `getServerEndpoint()` is insufficient | **True** | `public/js/core/server.js:73-76` and `:104-111` |
| `URL.origin` for `wire-bundled://app` is `"null"` in Node | **True** | `node -e` against WHATWG URL; renderer origin is `wire-bundled://app` per spike Q1 |
| Origin checks (including remember-me) must not compare `.origin` | **True / planned fix** | `electron-client/main.js:456,481-486`; `public/js/core/auth.js:282-284` |
| All servers would share storage under one bundled origin | **True** | one scheme origin; global `token` key `public/js/core/auth.js:51,81`; endpoint-prefixed stores are defence in depth only |
| Browser data under the old server origin is not visible to the new origin | **True** | origin-scoped IndexedDB `public/js/crypto/keys/unlock-key-store.js:19,41`; `peer-trust.js:191-193` |
| `config/socket.js` CORS uses `CLIENT_URL` or `false`, not `origin: true` | **True** | `config/socket.js:19-21`. The HTTP middleware does use `origin: true` (`middleware/cors.js:26-29`); do not conflate them. With `origin:false`, WebSocket transport is unaffected but the polling fallback has no CORS headers — relevant because the client lists `['websocket','polling']` (`public/js/core/socket.js:110`). |
| The proposed CSP missed directives the server policy needs | **True** | old draft missed `media-src`, `object-src`, `manifest-src`, Google Fonts hosts, and explicit `wss:`/dev `ws:`; compare `middleware/csp.js:38-52` |
| `electron-client/package.json` `build.files` does not include `public/` | **True** | `electron-client/package.json:25-32` |
| Service worker (Q5) | **Analysis only, not experimentally verified**; decision: no SW in bundled client | `public/js/core/pwa.js:112-118`; spike Q5 |
| `utils/tlsSetup.js` says `main.js` pins the certificate | **False today** | no cert handler in `electron-client/main.js`; pinning only in `spike/test-q2-options.js:329-351` |

**Not verified inside Electron:** the exact origin string in `event.sender.getURL()` for
`wire-bundled://`, behavior of the CSP on that scheme, per-partition protocol handlers,
permission handler results, redirect handling, and any Windows/macOS build. These are Phase 4
tests, not claims.

---

## 15. Phase 2 test plan (planned; nothing here is implemented)

| Test | Phase | What it must prove |
|---|---|---|
| Origin normalization | 2 | `wire-bundled://app` compares equal across main and renderer without using `.origin`; IPC rejects a different host/port. |
| HTTPS gate | 2 | Packaged: `http://` and `ws://` are rejected for connect, saved address and redirect. Unpackaged: only loopback allowed. No env/setting override. |
| Partition isolation | 4 | Two servers get different `persist:server:*` partitions; the second cannot read the first's token/pins. |
| CSP | 4 | Injected on every document response; `connect-src` includes exactly the chosen HTTPS/WSS origins; violation for another host is blocked. `'self'` resolves to `wire-bundled://app`. |
| Permissions | 4 | Microphone allowed only for `wire-bundled://app` main frame (protocol+host, not `.origin`); camera, notifications in renderer, display-capture and unknown permissions denied; check handler agrees with request handler. |
| Protocol handler | 4 | Traversal (`../`), absolute paths and files outside `public/` rejected; packaged files come from `app.asar`. Integrity manifest: tampered file → 500, unknown file → 404. |
| IPC senderFrame | 2 | Every handler rejects a non-top-frame or wrong-origin caller. |
| openExternal allowlist | 2 | Only `http:`/`https:` handed to the OS; `file:`, `smb:`, custom schemes denied. |
| Navigation lock | 2 | `will-navigate` cancels disallowed targets; `window.open` is denied and opened externally only for allowed schemes. |
| Socket.IO CORS | 5 | `wire-bundled://app` allowed; arbitrary origins rejected; `CLIENT_URL` or explicit allowlist, not blanket `origin: true`. |
| Update notice | 7 | A newer `/api/version` produces only a notice; no fetch of app code/installer from the server. |
| Migration | 6 | Old server-origin storage is not assumed; user is told to log in and restore; Phase 6 inventory drives the exact message. |
| Certificate strategy | 11 | Whatever the owner picks in section 13 is tested: self-signed fails closed by default; a pinned cert only matches the stored fingerprint. |

---

## 16. Old-document section mapping

The previous revision of this document (`git show 93f44ae:docs/ELECTRON_BUNDLED_CLIENT_DESIGN.md`)
had the sections below. Each is mapped to its new location, or explained why it was dropped.

| Old section | New location / disposition |
|---|---|
| 1. Threat Model | §3 Threat model (rewritten: token row added, server-storage claim corrected, status labels added) |
| 2. Recommended Architecture | §4 Architecture (direct connection; bridge diagram removed — contradicted by Q2 and D1) |
| 3. IPC Hardening Plan | §10 IPC hardening, openExternal, navigation (restored with `senderFrame` checks, updated to accepted decisions D1-D6) |
| 4. openExternal Allowlist | §10.2 (restored, merged into IPC/navigation hardening) |
| 5. Navigation Lock | §10.3 (restored, merged; `try/catch` added around `new URL`) |
| 6. CSP Applied by App | §8 (rewritten: `'self'` = `wire-bundled://app`, resource trace table added, directive table with exact origins, no wildcards) |
| 7. Client Changes Needed | §5 Origin, URLs and storage (rewritten: `resolveServerUrl()` must change too; injectable server endpoint) |
| 8. Update Strategy | §12 Updates (rewritten: notification only, version compatibility, upgrade/rollback tests) |
| 9. Server-Side Changes (PROPOSED DIFFS) | §10.5 Socket.IO CORS (CORS allowance for bundled origin only); version endpoint unchanged (§12) |
| 10. Client Changes in public/ (PROPOSED DIFFS) | §5.1 `getServerEndpoint()` + `resolveServerUrl()` must change together; `public/js/files/links.js:41` diff noted as NOT applied |
| 11. Test Plan | §15 Phase 2 test plan (rewritten with phase numbers) |
| 12. Risks & Open Questions | §13 Self-signed/private-CA (kept); other risks folded into §1-§4 |
| 13. Decisions the Owner Must Make Before Phase 2 | §1 Locked decisions (D1-D7); remaining open questions in §14 open questions |

Claims from the old draft that are **contradicted by code or decisions and therefore not restored**:
- "WebSocket is blocked from the bundled origin; a bridge is required" — **false** (Q2 verified: fetch and WebSocket both work; D1).
- "ASAR provides filesystem-level integrity (tampering breaks the archive)" — **false** (ASAR gives no integrity by default; manifest check added in §10.4).
- "CSP `connect-src 'self'` covers the server" — **false** (`'self'` is `wire-bundled://app`, not the server; server origin must be listed explicitly, §8.1).
- "Microphone allowed for the server origin" — **false** (microphone allowed for `wire-bundled://app` main frame only, §9).
- "Origin compared with `URL.origin`" — **false** (`URL.origin` is `"null"` for `wire-bundled://`; compare protocol+host, §5.2 and §9).
- "`did-redirect-navigation` is a blocking control" — **false** (it fires after the redirect; `will-navigate` is the blocking event, §11.4).

---

## 17. Open questions

1. **Code signing** (D7): EV certificate (Windows), Apple Developer Program/notarization
   (macOS), GPG (Linux) — budget and timeline.
2. **Self-signed/private-CA strategy** (§13): public CA only, private CA in the OS
   trust store, or exact-certificate pinning. No bypass is implemented either way.
3. **Network model detail** (D1): whether an optional main-process bridge is ever added
   for tighter destination control is a security-versus-complexity choice, not a
   technical necessity — direct connection works per Q2.
4. **Web Notifications** (§9): decide whether the renderer's `Notification.requestPermission()`
   path is allowed for `wire-bundled://app` or relies only on the main-process path
   (`electronAPI.showDmNotification`).

---

*Phase 1 only. No Electron implementation, no packaging change and no server change is made
by this document. Windows/macOS builds, a real microphone in Electron, CSP enforcement on the
custom scheme and permission-handler behaviour remain unverified.*
