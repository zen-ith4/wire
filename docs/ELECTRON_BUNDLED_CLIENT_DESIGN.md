# Electron Bundled Client — Design Document

**Branch:** `electron-bundled-spike`  
**Base:** main at `998fa50a6476693a6b7b7646424d7ccfeb8aabad`  
**Phase:** 1 (Feasibility + Design) — NOT implementation  
**Spike Results:** `docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`

---

## 1. Threat Model

### What a Malicious/Compromised Server Can Do TODAY (Server-Loaded UI)

| Capability | Current State |
|------------|---------------|
| Replace client code | ✅ Can serve any JS — steal keys, disable E2EE, exfiltrate data |
| Inject malicious CSP | ✅ Can weaken/remove CSP headers |
| Serve different code per user | ✅ Targeted attacks possible |
| Push malicious update | ✅ Controls `/api/version` and update flow |
| Read all traffic | ✅ Terminates TLS, sees all plaintext |
| Modify message content | ✅ Can inject/alter messages before encryption |
| Exfiltrate keys | ✅ Can serve code that exports `crypto.subtle` keys |

### What a Malicious/Compromised Server CANNOT Do AFTER Bundled Client

| Capability | Mitigation |
|------------|------------|
| Replace client code | ❌ Code is bundled in `app.asar`, integrity-verified on every load |
| Inject malicious CSP | ❌ CSP injected by app (`connect-src` restricted to server origin) |
| Serve different code per user | ❌ All users get identical `app.asar` |
| Push malicious update | ⚠️ Notice only; installer verified against pinned hash |
| Read all traffic | ❌ E2EE keys never leave renderer; server only sees ciphertext |
| Modify message content | ❌ Messages encrypted before leaving renderer |
| Exfiltrate keys | ❌ Keys never leave renderer; `safeStorage` in main process |

### What Remains Possible Even After Bundling

| Risk | Mitigation |
|-------|------------|
| Metadata leakage | Server sees who talks to whom, when, how much |
| Availability | Server can go offline, block connections |
| Fake update prompt | Server can trigger `app-update:available`; user must manually verify |
| Availability of new features | Server controls feature flags |
| APK hash served by same server | Does NOT protect against that server — same trust boundary |

---

## 2. Recommended Architecture

### Central Decision: Q2 Answer Drives Everything

**Q2 Answer (verified against the real server, see `docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`, Q2):** In Electron 45.4.1, from the bundled secure origin `wire-bundled://app`, both `fetch()` and `WebSocket` to a non-loopback `http://`/`ws://` server succeed. (An earlier revision of this document said WebSocket was blocked and a bridge was required; that was wrong, it came from a test server that could not answer a WebSocket upgrade.)

**Architectural Consequence:** The renderer can talk to the server directly. A main-process network bridge is NOT technically required. It stays an OPTIONAL hardening choice (owner decision): the bridge would let the main process pin the destination server and refuse any other, instead of relying only on the CSP `connect-src` that the app applies to the page. Without a bridge, the app-applied CSP (section 6) is the control that stops the bundled client from sending data anywhere except the chosen server, so it becomes mandatory, not optional. The result is specific to Electron 45.4.1 / Chromium 156 and must be re-run on every Electron upgrade (`electron-client/spike/run-q2-real-server.sh`).

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                         │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Protocol    │  │  Network Bridge  │  │  SafeStorage     │  │
│  │  Handler     │  │  (fetch + WS     │  │  (identity keys) │  │
│  │  (wire-      │  │   proxy via IPC) │  │                  │  │
│  │   bundled)   │  │                  │  │                  │  │
│  └──────┬───────┘  └──────┬───────────┘  └──────────────────┘  │
│         │                 │                                       │
│         ▼                 ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │             RENDERER PROCESS (wire-bundled://app)            │ │
│  │  • Bundled HTML/JS/CSS (in app.asar)                          │ │
│  • crypto.subtle — E2EE key operations                            │ │
│  • IndexedDB — verification pins                                  │ │
│  • localStorage — session state                                   │ │
│  • fetch() → server (direct, allowed)                             │ │
│  • IPC → main → WebSocket → server (proxy)                        │ │
│  • IPC → main → identity keys (safeStorage)                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                      SERVER (HTTP/WS)                         │ │
│  │  • HTTP API endpoints                                         │ │
│  • WebSocket for real-time DM                                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Connect:** User enters server address → main process validates → saves to config → loads `wire-bundled://app/index.html`
2. **API calls:** Renderer → `fetch()` directly to the server (verified allowed, Q2) → Server → Renderer
3. **WebSocket:** Renderer → `WebSocket`/Socket.IO directly to the server (verified allowed, Q2). Optional hardening variant: Renderer → IPC → Main process socket → Server.
4. **E2EE keys:** Renderer → IPC `identity:store-unlock-key` → Main process `safeStorage.encryptString()` → disk
5. **DM notifications:** Server → WebSocket → Main process → IPC → Renderer

---

## 3. IPC Hardening Plan

### Current IPC Handlers (main.js)

| Handler | Current Validation | Hardened Validation |
|---------|-------------------|---------------------|
| `identity:store-unlock-key` | `event.sender.getURL()` vs `claimedOrigin` | ✅ Already validates origin |
| `identity:get-unlock-key` | `event.sender.getURL()` vs `claimedOrigin` | ✅ Already validates origin |
| `identity:clear-unlock-key` | `event.sender.getURL()` vs `claimedOrigin` | ✅ Already validates origin |
| `networkBridge:fetch` | **OPTIONAL, only if the owner chooses the bridge** | Validate `event.senderFrame.url === BUNDLED_ORIGIN`; allowlist target URL |
| `networkBridge:ws-connect` | **OPTIONAL, only if the owner chooses the bridge** | Validate `event.senderFrame.url === BUNDLED_ORIGIN`; allowlist target URL |
| `networkBridge:ws-send` | **OPTIONAL, only if the owner chooses the bridge** | Validate `event.senderFrame.url === BUNDLED_ORIGIN`; WS must be open |
| `server:connect` | Validates address format | ✅ Already validates |
| `server:get-saved` | Only from connect screen | ✅ Only exposed on `file:` protocol |
| `server:forget` | Only from connect screen | ✅ Only exposed on `file:` protocol |
| `server:show-connect-screen` | No origin check | Add `event.senderFrame.url === BUNDLED_ORIGIN` |
| `app:hardware-acceleration:*` | No origin check | Low risk (local pref); add origin check for consistency |
| `app:relaunch` | No origin check | Add origin check |
| `dm-notification:show` | Checks `event.sender === mainWindow.webContents` | ✅ Good |
| `dm-notification:clicked` | Main → renderer | ✅ One-way |

### Key Hardening Principle

> **Every `ipcMain.handle` must validate `event.senderFrame.url === BUNDLED_ORIGIN` (or `file:` for connect screen). Never trust a renderer-supplied origin string.**

### Identity Storage Binding

- **Current:** Keys stored per `(origin, userId)` where origin comes from `event.sender.getURL()`
- **Hardened:** Keys bound to the **origin the MAIN PROCESS connected to** (stored in config), not a renderer-supplied string
- **Migration:** Existing keys remain accessible; new keys bound to config origin

---

## 4. openExternal Allowlist

### Current Behavior (main.js:329-331)

```javascript
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url);
  return { action: 'deny' };
});
```

### Hardened Allowlist

```javascript
const ALLOWED_EXTERNAL_SCHEMES = ['http:', 'https:'];

mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_EXTERNAL_SCHEMES.includes(parsed.protocol)) {
      return { action: 'deny' };
    }
    shell.openExternal(url);
  } catch {
    // Invalid URL
  }
  return { action: 'deny' };
});
```

**Forbidden:** `file:`, `mailto:`, `tel:`, `sms:`, custom protocols, `javascript:`, `data:`, `blob:`, `filesystem:`, `chrome:`, `chrome-extension:`.

---

## 5. Navigation Lock

### Current (main.js:338-347)

```javascript
mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
  const target = new URL(targetUrl);
  const isLocalConnectScreen = target.protocol === 'file:';
  const isCurrentServer = currentServerOrigin && target.origin === currentServerOrigin;
  if (!isLocalConnectScreen && !isCurrentServer) {
    event.preventDefault();
    shell.openExternal(targetUrl);
  }
});
```

### Hardened Lock

```javascript
mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
  try {
    const target = new URL(targetUrl);
    const allowed =
      target.protocol === 'file:' ||
      target.origin === BUNDLED_ORIGIN ||
      (currentServerOrigin && target.origin === currentServerOrigin);
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  } catch {
    event.preventDefault();
  }
});
```

**Also block:** `<meta http-equiv="refresh">`, `window.location = ...`, `history.pushState` to disallowed origins via `did-start-navigation` and `did-redirect-navigation`.

---

## 6. CSP Applied by App

### Current: Server sends CSP headers

### App-Enforced CSP (Protocol Handler)

```javascript
protocol.handle('wire-bundled', async (request) => {
  // ... file serving logic ...
  
  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' " + currentServerOrigin,
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    },
  });
});
```

### `connect-src` Allowlist

```javascript
const ALLOWED_CONNECT_ORIGINS = [
  BUNDLED_ORIGIN,           // Self (wire-bundled://app)
  currentServerOrigin,      // Configured server (<server-ip>:<port>)
];
```

**Rationale:** The app enforces its own CSP regardless of server headers. The server cannot weaken it.

---

## Client Changes Needed

- At connect screen, user enters server address
- Main process validates and saves server origin to config
- Renderer receives server origin via IPC (`server:get-saved`)
- Client-side `getServerEndpoint()` returns the configured server origin (not `window.location.origin`)
- `resolveServerUrl()` prepends server origin for relative URLs
- Install absolute server base in client (proposed diff in design doc)

## 7. Update Strategy

### Current Flow (main.js:201, 382)

```javascript
// checkServerVersion() calls /api/version
// If newer, emits 'app-update:available' to renderer
// Renderer shows notification
```

### Hardened Strategy

| Aspect | Current | Hardened |
|--------|---------|----------|
| Version check | `GET /api/version` | Same, but via main-process bridge |
| Notification | Renderer shows toast | Same |
| Download | Server provides download URL | **NEVER download from server URL** |
| Installation | User manually downloads | **Show notice only**; user downloads from trusted source |
| Verification | None | **Pinned SHA-256 hash** (out-of-band) |
| Code signing | Not mentioned | **macOS: notarized; Windows: EV cert; Linux: GPG-signed** |

### Update Flow (Hardened)

1. Main process checks `/api/version` via `net.fetch` (via bridge)
2. If newer, emits `app-update:available` with `serverVersion`
3. Renderer shows: "Wire v{X.Y.Z} available. Download from [official site / GitHub releases]."
4. **No auto-download, no installer execution from server-provided URL**
5. User manually downloads, verifies hash/signature, installs

**Code-signing status:**
- macOS: Notarized `.dmg` / `.app` (requires Apple Developer Program)
- Windows: EV code-signed NSIS installer (requires EV certificate)
- Linux: GPG-signed `.AppImage` and `.deb` (detached signature published)

**Out-of-band hash:** Published on project website, GitHub releases, and optionally via DNS TXT record.

---

## 8. Server-Side Changes (PROPOSED DIFFS)

### 1. CORS Allowance for Bundled Origin

**File:** `middleware/cors.js`

```diff
 const corsMiddleware = cors({
   origin: true,  // Already reflects request Origin — works for wire-bundled://app
   credentials: false,
 });
```

**No change needed** — `origin: true` already reflects the request's `Origin` header.

### 2. Version Endpoint (unchanged)

**File:** `routes/version.routes.js` — No changes needed.

### 3. Socket.IO CORS (if needed)

**File:** `config/socket.js` (or wherever Socket.IO is configured)

```diff
 const io = new Server(httpServer, {
   cors: {
-    origin: true,
+    origin: (origin, callback) => {
+      if (origin === 'wire-bundled://app' || allowedOrigins.includes(origin)) {
+        callback(null, true);
+      } else {
+        callback(new Error('CORS not allowed'));
+      }
+    },
     credentials: false,
   },
 });
```

### 4. APK Info Endpoint (for manual download link)

**File:** `controllers/apk.controller.js` — Ensure returns `version`, `sha256`, `signature`, `downloadUrl` (pointing to GitHub releases, not server).

---

## 9. Client Changes in public/ (PROPOSED DIFFS)

### 1. `public/js/core/server.js` — Accept Absolute Server Base

```diff
-export function getServerEndpoint() {
-  if (!isCapacitor()) {
-    return window.location.origin;
-  }
-  // ... Capacitor logic
-}
+let injectedServerEndpoint = null;
+
+export function getServerEndpoint() {
+  if (injectedServerEndpoint) return injectedServerEndpoint;
+  if (isCapacitor()) {
+    // ... existing Capacitor logic
+  }
+  return window.location.origin;  // Fallback for browser
+}
+
+// Called by preload.js via IPC on app startup
+export function __setServerEndpoint(endpoint) {
+  injectedServerEndpoint = endpoint;
+}
```

### 2. `public/js/core/api.js` — Use Absolute Base

```diff
-const response = await fetch(resolveServerUrl(url), { ... });
+const base = getServerEndpoint();
+const fullUrl = url.startsWith('/') ? base + url : url;
+const response = await fetch(fullUrl, { ... });
```

### 3. `public/js/core/socket.js` — Use Absolute Server Base

```diff
-const serverEndpoint = getServerEndpoint();
-socket = io(serverEndpoint, { ... });
+const serverEndpoint = getServerEndpoint();
+socket = io(serverEndpoint, { ... });
```

### 4. `public/js/media/*.js` — Use Absolute Base

All `resolveServerUrl()` calls already use `getServerEndpoint()` internally — no change needed if `getServerEndpoint()` returns the injected server origin.

### 5. `public/js/core/pwa.js` — Skip SW for Bundled

```diff
export function registerServiceWorker() {
  if (
    !('serviceWorker' in navigator) ||
    !window.isSecureContext ||
    !/^https?:$/.test(location.protocol) ||
    isNativeApp() ||
+    location.protocol === 'wire-bundled:'  // Explicit check
  ) {
    return;
  }
  // ...
}
```

---

## 10. Test Plan

### Unit Tests (Node.js)

| Test | Description |
|------|-------------|
| Protocol handler path traversal | `../etc/passwd` → 403 |
| Protocol handler integrity mismatch | Modified file → 500 |
| IPC sender validation | Wrong origin → rejected |
| URL allowlist | Non-allowed URL → rejected |
| safeStorage async migration | Encrypt/decrypt round-trip |
| Integrity manifest generation | All files hashed, manifest valid |

### Electron Smoke Tests (CI)

| Test | Command |
|------|---------|
| App starts, shows connect screen | `npm start` → wait for connect.html |
| Connect to test server | Enter address → load real UI |
| DM send/receive | Send message → verify received |
| Verify button | Compare numbers → mark → reload → stays verified |
| Voice message | Record → send → receive → play |
| Hardware acceleration toggle | Toggle → relaunch → persists |
| DM notification click | Click notification → opens conversation |
| Update notice | Mock server v2.0.0 → notice appears |

### Non-Loopback IP Test (Critical for Q2)

```bash
# Implemented as electron-client/spike/run-q2-real-server.sh:
# Start the real server (node server.js) on 0.0.0.0, take the IP from `hostname -I`
# Verify from the bundled origin: fetch to http://<non-loopback-ip>:<port> works
# Verify from the bundled origin: WebSocket to ws://<non-loopback-ip>:<port> opens
# Controls: the same from an http:// origin page, and against loopback
# Re-run on every Electron upgrade (Chromium mixed-content behaviour can change)
```

### Migration Test

1. Install old version (server-loaded)
2. Configure server, verify identity
3. Upgrade to bundled version
4. Verify: identity unlock keys still work
5. Verify: server config preserved
6. Verify: hardware acceleration setting preserved

**Rollback:** User can uninstall new version, reinstall old — config files compatible.

---

## 11. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| IPC bridge performance (only if the bridge is adopted) | Medium | Latency on every API call | Batch requests; WebSocket for real-time |
| Main process bottleneck (only if the bridge is adopted) | Low | Single-threaded Node.js | Offload crypto to renderer; main only proxies |
| ASAR integrity bypass | Low | Modified app.asar | OS code signing + integrity manifest |
| User ignores update notice | High | Stale client | Clear messaging; optional forced update after N versions |
| Certificate pinning complexity | Medium | User friction | Optional fingerprint verification; document clearly |

### Open Questions for Owner

1. **Update mechanism:** Accept "notice only" or require auto-update with signed installers?
2. **Network model:** Direct renderer connection with app-applied CSP `connect-src` (works per Q2), or a main-process bridge that pins the destination? Require HTTPS for all servers or allow HTTP (WireGuard)?
3. **Certificate pinning:** Mandatory fingerprint verification at connect screen, or optional?
4. **Code signing:** Budget for EV cert (Windows) and Apple Developer Program (macOS)?
5. **Linux distribution:** AppImage + deb sufficient, or need Flatpak/Snap?
6. **Auto-update check frequency:** Hourly, daily, on startup?
7. **Telemetry:** Any crash/error reporting (opt-in)?

---

## 12. Decisions the Owner Must Make Before Phase 2

| Decision | Options | Recommendation |
|----------|---------|----------------|
| **Network model / HTTPS** | Direct connection + CSP / bridge that pins the server; require HTTPS / allow HTTP | Owner decision. Direct connection works per Q2; whether the bridge is worth its cost is a security-versus-complexity choice, not a technical necessity |
| **Certificate pinning** | Mandatory / Optional / None | **Optional** — user verifies fingerprint at connect |
| **Update delivery** | Notice only / Auto-download verified / Auto-install | **Notice only** (Phase 2); auto-download later |
| **Code signing** | EV cert (Windows) + Notarization (macOS) + GPG (Linux) | **Required for production** |
| **Linux packaging** | AppImage + deb / Flatpak / Snap | **AppImage + deb** (Phase 2) |
| **Telemetry** | None / Opt-in crashes / Opt-in usage | **Opt-in crashes only** |

---

*Phase 1 complete. Phase 2 implementation begins after owner decisions.*

---

**Phase 1 only. NOT verified: Windows build and install, real microphone in Electron, Safari, real Android APK, any server change.**