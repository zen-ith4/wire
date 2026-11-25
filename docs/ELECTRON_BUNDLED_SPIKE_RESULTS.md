# Electron Bundled Client — Spike Results

**Branch:** `electron-bundled-spike` (base: main at `998fa50a6476693a6b7b7646424d7ccfeb8aabad`)
**Electron:** 45.4.1 (Chromium 156, Node 24.22.0 as reported by the Electron build used)
**electron-builder:** 26.18.0

---

## Executive Summary

> **ERRATA (this revision).** An earlier revision claimed that WebSocket to an HTTP server is BLOCKED by mixed-content policy from the bundled origin and that a main-process bridge is therefore required. **That claim was wrong.** It came from a test server (`http.createServer`) that cannot answer a WebSocket upgrade, with no control experiment. Q2, Q3 and Q6 below were re-run against the real server and real Electron, with raw output. Q1, Q4 and Q5 were NOT re-run in this revision and are marked accordingly.

**Q2 answer (one sentence):** In Electron 45.4.1, a page on the privileged scheme `wire-bundled://app` (secure context, `crypto.subtle` available) can `fetch()` and open a `WebSocket` to the real server at a non-loopback `http://`/`ws://` address; neither was blocked, so a main-process bridge is NOT technically required (it remains an optional hardening choice for the owner).

---

## Q1: Custom Protocol Handler — Secure Context Features


### Results (Run 1)

| Feature | Result | Notes |
|---------|--------|-------|
| `isSecureContext` | ✅ `true` | Custom protocol with `secure: true` provides secure context |
| `crypto.subtle` | ✅ `true` | Available |
| `crypto.subtle.generateKey()` | ✅ Works | AES-GCM 256-bit key generation successful |
| `IndexedDB` | ✅ Available | API present |
| `localStorage` | ✅ Works | Read/write successful |
| `sessionStorage` | ✅ Works | Read/write successful |
| `fetch` | ✅ Available | API present |
| `WebSocket` | ✅ Available | API present |
| Origin | `wire-bundled://app` | Custom protocol origin |

### Results (Run 2 — app restart, same userData dir)

| Feature | Result | Notes |
|---------|--------|-------|
| `indexedDBItems` | **2** | **Proves persistence** — item from run 1 + new item from run 2 |
| `indexedDBReadback` | ✅ `true` | Data survives app restart |
| `localStorageWorks` | ✅ `true` | Persists across restarts |

### Protocol Handler Implementation

```javascript
protocol.registerSchemesAsPrivileged([{
  scheme: 'wire-bundled',
  privileges: {
    standard: true,
    secure: true,           // Required for isSecureContext
    supportFetchAPI: true,  // Enable fetch API
    corsEnabled: true,      // Enable CORS
  },
}]);

protocol.handle('wire-bundled', async (request) => {
  const url = new URL(request.url);
  const normalizedPath = path.normalize(url.pathname.slice(1));
  
  // Path traversal protection
  if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
    return new Response('Path traversal blocked', { status: 403 });
  }
  
  // Integrity verification
  const expected = manifest.files[normalizedPath];
  if (!expected) return new Response('File not in manifest', { status: 404 });
  
  const content = fs.readFileSync(fullPath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  if (hash !== expected.rawHash) {
    return new Response('Integrity check failed', { status: 500 });
  }
  
  return new Response(content, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
  });
});
```

**Path traversal protection:** Implemented via `path.normalize()` + `path.resolve()` + `startsWith(publicDir)` check.

> Revision note: this section was not re-run here; its "Test file/Command" lines below named an unrelated test and are not evidence. Persistence and localStorage claims are [NOT RE-VERIFIED].

---

## Q2: Mixed Content / Reach to a Non-Loopback HTTP Server

**Status: verified by experiment (re-run). Supersedes the earlier "WebSocket BLOCKED" text.**

Setup (all observed, nothing assumed):
- Real server: `node server.js` from the repo root, `HOST=0.0.0.0`, `PORT=4777`, temp DB (runner: `electron-client/spike/run-q2-real-server.sh`).
- Non-loopback address from `hostname -I`: `192.0.2.2`.
- Electron 45.4.1 under `xvfb-run`. `--no-sandbox --disable-gpu` are used by the spike runner ONLY because the container runs as root; the windows use `contextIsolation:true, nodeIntegration:false, sandbox:true` and no insecure-content or webSecurity flags.
- Page A: `wire-bundled://app/index.html` (scheme registered with `standard, secure, supportFetchAPI, corsEnabled`).
- Control page B: plain `http://192.0.2.2:4777/login.html` (non-secure origin).
- The WebSocket target is the real engine.io endpoint `/socket.io/?EIO=4&transport=websocket`.

| Test | Page A (bundled secure origin) | Page B (control, http origin) |
|---|---|---|
| `isSecureContext` / `crypto.subtle` | true / true | false / false |
| fetch to `http://192.0.2.2:4777` | OK (200) | OK |
| WebSocket to `ws://192.0.2.2:4777` | open | open |
| fetch to `http://127.0.0.1:4777` | OK | OK |
| WebSocket to `ws://127.0.0.1:4777` | open | open |

Origin header actually sent by Electron for page A: `Origin=wire-bundled://app` (logged with `webRequest.onBeforeSendHeaders`).

Not covered: the test proves the WebSocket handshake opens against the real engine.io endpoint; it does not run a full authenticated Socket.IO session. Options (i) main-process bridge, (ii) HTTPS with pinned self-signed certificate, (iii) non-secure custom scheme, (iv) Chromium switches were NOT tested, because the blocking they would work around did not occur: they remain [NOT VERIFIED]. The result is specific to Electron 45.4.1 / Chromium 156 and the scheme privileges above; re-run `run-q2-real-server.sh` on every Electron upgrade, because mixed-content handling for custom schemes is Chromium behaviour that can change.

Raw output (command: `cd electron-client && bash spike/run-q2-real-server.sh`):

```
non-loopback IP: 192.0.2.2 (from: hostname -I)  port: 4777
server: {"version":"1.3.6"}
[origin-sent:BUNDLED(wire-bundled://app)] http://192.0.2.2:4777/api/version Origin=wire-bundled://app
[origin-sent:BUNDLED(wire-bundled://app)] http://127.0.0.1:4777/api/version Origin=wire-bundled://app
RESULT BUNDLED(wire-bundled://app) {
 "origin": "wire-bundled://app",
 "isSecureContext": true,
 "subtle": true,
 "tests": [
  {
   "name": "fetch non-loopback",
   "url": "http://192.0.2.2:4777/api/version",
   "ok": true,
   "status": 200
  },
  {
   "name": "ws non-loopback",
   "url": "ws://192.0.2.2:4777/socket.io/?EIO=4&transport=websocket",
   "ok": true,
   "event": "open"
  },
  {
   "name": "fetch loopback",
   "url": "http://127.0.0.1:4777/api/version",
   "ok": true,
   "status": 200
  },
  {
   "name": "ws loopback",
   "url": "ws://127.0.0.1:4777/socket.io/?EIO=4&transport=websocket",
   "ok": true,
   "event": "open"
  }
 ]
}
[origin-sent:CONTROL(http-nonloopback-origin)] http://192.0.2.2:4777/api/version Origin=(none)
[origin-sent:CONTROL(http-nonloopback-origin)] http://127.0.0.1:4777/api/version Origin=http://192.0.2.2:4777
RESULT CONTROL(http-nonloopback-origin) {
 "origin": "http://192.0.2.2:4777",
 "isSecureContext": false,
 "subtle": false,
 "tests": [
  {
   "name": "fetch non-loopback",
   "url": "http://192.0.2.2:4777/api/version",
   "ok": true,
   "status": 200
  },
  {
   "name": "ws non-loopback",
   "url": "ws://192.0.2.2:4777/socket.io/?EIO=4&transport=websocket",
   "ok": true,
   "event": "open"
  },
  {
   "name": "fetch loopback",
   "url": "http://127.0.0.1:4777/api/version",
   "ok": true,
   "status": 200
  },
  {
   "name": "ws loopback",
   "url": "ws://127.0.0.1:4777/socket.io/?EIO=4&transport=websocket",
   "ok": true,
   "event": "open"
  }
 ]
}
```

---

## Q3: CORS: Origin Header

**Status: verified by experiment (re-run).**

- Electron really sends `Origin: wire-bundled://app` from page A (see the `[origin-sent:...]` lines in the Q2 raw output).
- `middleware/cors.js:26-29`: `cors({ origin: true, credentials: false })`. `origin: true` reflects the request Origin; `credentials:false` means no `Access-Control-Allow-Credentials` is ever sent. The comment at `middleware/cors.js:7-18` says this is deliberate (header-based auth, Electron may load from any server).
- Server-side change needed for the bundled origin: none. Credentials must stay false.

Raw output (command: `bash electron-client/spike/run-q3-cors-check.sh`; curl with an explicit Origin header against the real server, so this shows the server side only; the Electron-sent header is in Q2):

```
$ GET with Origin: wire-bundled://app
HTTP/1.1 200 OK
Access-Control-Allow-Origin: wire-bundled://app
Vary: Origin
{"version":"1.3.6"}
$ OPTIONS preflight
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: wire-bundled://app
Vary: Origin, Access-Control-Request-Headers
Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
Access-Control-Allow-Headers: content-type,authorization
$ GET without Origin
HTTP/1.1 200 OK
```

---

## Q4: API Base Resolution & Capacitor Mechanism


### Current Client Behavior (`public/js/core/server.js`)

```javascript
// public/js/core/server.js:74-90
export function getServerEndpoint() {
  if (!isCapacitor()) {
    return window.location.origin;  // ← Problem: returns wire-bundled://app
  }
  // Capacitor path: reads from localStorage
}

export function resolveServerUrl(url) {
  if (!isCapacitor()) {
    return url;  // Relative URLs used as-is
  }
  // Capacitor: resolves against saved server endpoint
}
```

### Current Behavior in Bundled Context

| URL Pattern | Resolved To | Works? |
|-------------|-------------|--------|
| `/api/version` | `wire-bundled://app/api/version` | ❌ 404 |
| `http://<server-ip>:<port>/api/version` | `http://<server-ip>:<port>/api/version` | ✅ Works (fetch not blocked) |
| `https://example.com/api/version` | `https://example.com/api/version` | ✅ If CORS allows |

### Capacitor Mechanism (Reference)

The Capacitor app (`isNativeApp() === true`):
1. Stores server URL in `localStorage` (`wire_server_endpoint`)
2. `getServerEndpoint()` reads from `localStorage`
3. `resolveServerUrl('/api/test')` → `https://user-server.com/api/test`

### Required Client Changes for Bundled Electron

The bundled client needs an **absolute server base** configured at connect time, similar to Capacitor but without Capacitor APIs.

**Proposed mechanism:**
1. At connect screen, user enters server address
2. Main process validates and saves server origin to config
3. Renderer receives server origin via IPC (`server:get-saved`)
4. Client-side `getServerEndpoint()` returns the configured server origin (not `window.location.origin`)
5. `resolveServerUrl()` prepends server origin for relative URLs

**Proposed diff for `public/js/core/server.js`:**
```diff
+let injectedServerEndpoint = null;
+
export function getServerEndpoint() {
+  if (injectedServerEndpoint) return injectedServerEndpoint;
   if (!isCapacitor()) {
     return window.location.origin;
   }
   // ... existing Capacitor logic
 }
+
+// Called by preload.js via IPC on app startup
+export function __setServerEndpoint(endpoint) {
+  injectedServerEndpoint = endpoint;
+}
```

> Revision note: code-reading analysis, not re-checked in this revision.

---

## Q5: Service Worker Behavior


### Results

| Property | Value |
|----------|-------|
| `serviceWorker` supported | ✅ `true` |
| `controller` | `none` (not registered) |
| `isNativeApp()` | `false` (Capacitor not detected) |
| `isSecureContext` | `true` |
| `location.protocol` | `wire-bundled:` |

### `pwa.js` Behavior (`public/js/core/pwa.js:116-119`)

```javascript
if (
  !('serviceWorker' in navigator) ||
  !window.isSecureContext ||
  !/^https?:$/.test(location.protocol) ||  // ← Fails: protocol is wire-bundled:
  isNativeApp()
) {
  return;  // SW registration skipped
}
```

**Result:** Service Worker registration is **skipped** because:
1. `location.protocol` is `wire-bundled:` (not `http:` or `https:`)
2. `isNativeApp()` returns `false` (no Capacitor)

**Conclusion:** SW registration is correctly skipped. The bundled client doesn't need a SW since all assets are local (in `app.asar`). `MEDIA_STREAM_ENABLED` stays `false` in `public/sw.js` as required.

> Revision note: analysis only; no experiment was run: [NOT VERIFIED by experiment].

---

## Q6: Integrity Manifest and Tamper Tests

**Status: verified by experiment (re-run with a rewritten, runnable test).** The earlier `test-q6-integrity-tamper.js` could not run (it called `protocol.handle` before `app` was ready, used `ipcMain.handle` as if it invoked a handler, referenced an undefined variable inside page code, and modified `public/` in place). It was rewritten: it works on a temp copy of `public/`, builds the manifest from the copy, serves it through `protocol.handle('wire-bundled', ...)`, and exits non-zero on any failed expectation.

Handler rules: URL-decode (reject undecodable input, NUL and backslash), `path.posix.normalize`, reject `..` or absolute paths, look the file up in the manifest (the manifest is an allowlist), re-check the resolved path stays under the root, hash the file on every read and compare to the manifest.

Note on traversal: for a standard scheme the URL parser collapses plain `../` before the handler runs, so some probes are refused as "not in manifest" (404) instead of by the traversal check (403). Both are refusals; percent-encoded probes reach the decoder and are refused with 403.

Raw output (command: `cd electron-client && xvfb-run -a node_modules/electron/dist/electron --no-sandbox --disable-gpu spike/test-q6-integrity-tamper.js`; `--no-sandbox` only because the container runs as root):

```
[q6] temp copy: /tmp/wire-q6-Ud8MXo/public
[q6] manifest files: 206
[q6] PASS valid file  wire-bundled://app/index.html  -> 200  
[q6] PASS valid js before tamper  wire-bundled://app/js/core/api.js  -> 200  
[q6] PASS tampered file (1 byte flipped)  wire-bundled://app/js/core/api.js  -> 500  "integrity check failed"
[q6] PASS new file not in manifest  wire-bundled://app/injected.js  -> 404  "not in manifest"
[q6] PASS nonexistent file  wire-bundled://app/nonexistent.js  -> 404  "not in manifest"
[q6] PASS traversal ../etc/passwd  wire-bundled://app/../etc/passwd  -> 404  "not in manifest"
[q6] PASS traversal ..%2fetc%2fpasswd  wire-bundled://app/..%2fetc%2fpasswd  -> 403  "path traversal blocked"
[q6] PASS traversal %2e%2e/%2e%2e/etc/passwd  wire-bundled://app/%2e%2e/%2e%2e/etc/passwd  -> 404  "not in manifest"
[q6] PASS traversal ..%252fetc%252fpasswd  wire-bundled://app/..%252fetc%252fpasswd  -> 403  "path traversal blocked"
[q6] PASS traversal ..\..\windows\system32  wire-bundled://app/..\..\windows\system32  -> 404  "not in manifest"
[q6] PASS traversal /etc/passwd  wire-bundled://app//etc/passwd  -> 404  "not in manifest"
[q6] PASS traversal js/..%2f..%2fetc%2fpasswd  wire-bundled://app/js/..%2f..%2fetc%2fpasswd  -> 403  "path traversal blocked"
[q6] PASS traversal index.html%00.js  wire-bundled://app/index.html%00.js  -> 403  "forbidden characters"
[q6] PASS traversal %00  wire-bundled://app/%00  -> 403  "forbidden characters"
[q6] SUMMARY total=14 failed=0
```

**What ASAR does and does not do, and what the manifest adds.** ASAR is an archive format; by itself it gives no integrity or tamper detection. The earlier sentence "ASAR provides filesystem-level integrity (tampering breaks the archive)" was wrong and is removed. From the Electron documentation read in this session (https://electronjs.org/docs/latest/tutorial/asar-integrity and https://electronjs.org/docs/latest/tutorial/fuses): ASAR integrity checking is disabled by default and is enabled at package time with the `EnableEmbeddedAsarIntegrityValidation` fuse; the docs list support for macOS (electron >= 16) and Windows (electron >= 30) and do not list Linux; the docs say you typically also enable `OnlyLoadAppFromAsar`, because otherwise the check can be bypassed through the app code search path. Whether electron-builder 26.18.0 provides the header hash and flips these fuses is [NOT VERIFIED]. On Linux there is, per those docs, no built-in ASAR integrity check, so the per-read manifest check would be the only runtime integrity check there. Limit: an attacker who can modify the installed app files can also modify the manifest and handler code, so the manifest detects corruption and partial tampering of `public/`; its strength against a local attacker depends on OS code signing and the fuses. It does not address a malicious SERVER, which never touches these files; that protection comes from bundling the client at all.

---

## Summary of Spike Answers

| Question | Answer | Status |
|---|---|---|
| Q1 | Custom scheme gives secure context and `crypto.subtle` (re-confirmed in the Q2 raw output); IndexedDB persistence across restarts | `isSecureContext`/`subtle` re-verified; persistence and localStorage [NOT RE-VERIFIED in this revision] |
| Q2 | fetch and WebSocket from the bundled origin to a non-loopback http/ws server both work in Electron 45.4.1; no bridge required | verified (real server, controls) |
| Q3 | Electron sends `Origin: wire-bundled://app`; `middleware/cors.js:26-29` reflects it; no server change needed | verified |
| Q4 | Client assumes same-origin; an absolute server base is needed | code-reading analysis, [NOT RE-VERIFIED] |
| Q5 | Service worker not registered for the bundled origin | analysis only, [NOT VERIFIED by experiment] |
| Q6 | 14/14 manifest, tamper and traversal checks pass on a temp copy of `public/` | verified |

---

## Next Steps for Phase 2 (Implementation)

1. Owner decision on the network model: direct renderer connection (works per Q2) with an app-applied `connect-src` CSP restricted to the chosen server origin, or an optional main-process bridge for tighter destination control.
2. Permission handler: microphone only, only for the bundled origin; everything else denied (screen sharing is an owner decision, not pre-approved).
3. Migrate `safeStorage` calls to the async API (maintenance item; see `docs/ELECTRON_SECURITY_AUDIT.md`).
4. Accept an absolute server base in the client (proposed diffs in the design doc).
5. Generate the integrity manifest at build time and verify on every read; where supported, flip the ASAR-integrity and OnlyLoadAppFromAsar fuses and verify they take effect.
6. Apply the IPC, openExternal and navigation hardening from the audit.

---

*All spike code under `electron-client/spike/` is throwaway and not imported by the product.*
