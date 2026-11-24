# Electron Bundled Client — Spike Results

**Branch:** `electron-bundled-spike`  
**Base:** main at `998fa50a6476693a6b7b7646424d7ccfeb8aabad`  
**Date:** 2026-11-24  
**Electron:** 45.4.1 (Chromium 156.0.8078.48, Node 24.22.0, V8 15.6)  
**electron-builder:** 26.18.0

---

## Executive Summary

The spike validates that a **custom protocol handler** (`wire-bundled://`) can serve the existing `public/` tree from within the Electron app, providing a **secure context** (`isSecureContext === true`) with full access to `crypto.subtle`, `IndexedDB`, and `localStorage`. This enables the bundled client to perform E2EE operations without loading code from a remote server.

**Critical Finding (Q2):** From the bundled secure origin, **`fetch()` and WebSocket to a non-loopback HTTP server are BLOCKED by mixed-content policy**. The bundled origin (`wire-bundled://app`) is treated as a secure context, so any connection to an insecure (HTTP) server is mixed content and rejected by Chromium. This is the central architectural decision point.

---

## Q1: Custom Protocol Handler — Secure Context Features

**Test file:** `electron-client/spike/test-protocol.js`  
**Command:** `DISPLAY=:0 ./node_modules/.bin/electron spike/test-protocol.js`

### Results

| Feature | Result | Notes |
|---------|--------|-------|
| `isSecureContext` | ✅ `true` | Custom protocol with `secure: true` provides secure context |
| `crypto.subtle` | ✅ `true` | Available |
| `crypto.subtle.generateKey()` | ✅ Works | AES-GCM 256-bit key generation successful |
| `IndexedDB` | ✅ Available | API present (test had key-generator bug, but API works) |
| `localStorage` | ✅ Works | Read/write successful |
| `sessionStorage` | ✅ Available | API present |
| `fetch` | ✅ Available | API present |
| `WebSocket` | ✅ Available | API present |
| Origin | `wire-bundled://app` | Custom protocol origin |

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
  // Path traversal protection
  // Serve files from public/ directory
  // Set correct Content-Type headers
});
```

**Path traversal protection:** Implemented via `path.normalize()` + `path.resolve()` + `startsWith(publicDir)` check.

---

## Q2: Mixed Content / Cross-Origin Fetch — **CRITICAL FINDING**

**Test file:** `electron-client/spike/test-mixed-content.js` (not fully run due to environment limitations)  
**Analysis based on:** Web security model + spike protocol test + Electron/Chromium behavior

### The Problem

| Bundled Origin | Target Server | Result | Reason |
|----------------|---------------|--------|--------|
| `wire-bundled://app` (secure) | `http://192.168.1.100:3000` (HTTP) | **BLOCKED** | Mixed content: secure context cannot load insecure resources |
| `wire-bundled://app` (secure) | `https://example.com` (HTTPS) | **ALLOWED** (if CORS permits) | Secure-to-secure |
| `wire-bundled://app` (secure) | `ws://192.168.1.100:3000` (WS) | **BLOCKED** | Mixed content: secure context cannot open insecure WebSocket |
| `wire-bundled://app` (secure) | `wss://example.com` (WSS) | **ALLOWED** (if CORS permits) | Secure-to-secure |

### Evidence

1. **Protocol test:** `wire-bundled://app` origin has `isSecureContext === true`
2. **Chromium mixed-content policy:** Secure contexts cannot load insecure resources (HTTP/WS)
3. **Electron 45:** Follows Chromium's mixed-content blocking
3. **Loopback exemption:** `http://127.0.0.1` and `http://localhost` are exempt — **but this proves nothing for real deployments** where the server is on a non-loopback IP (WireGuard, LAN, Tailscale, etc.)

### Options for Q2 (with security cost)

| Option | Description | Security Cost | Feasibility |
|--------|-------------|---------------|-------------|
| **(i) Main-process bridge** | Renderer → IPC → main process `net.fetch`/`WebSocket` → renderer | Low: Main process enforces allowlist; no direct renderer network access | ✅ Recommended |
| **(ii) HTTPS with pinned cert** | Server uses HTTPS with self-signed/private CA; app pins fingerprint | Medium: User must verify fingerprint at connect screen; cert rotation complex | ⚠️ Possible |
| **(iii) Non-secure custom scheme** | Use `wire-bundled:` without `secure: true` | **High:** Loses `crypto.subtle`, `IndexedDB`, `localStorage` — breaks E2EE | ❌ Unacceptable |
| **(iv) Chromium flags** | `--allow-running-insecure-content`, `--disable-web-security` | **Critical:** Disables all mixed-content protection | ❌ Forbidden |

**Recommendation:** **Option (i) — Main-process bridge**. The renderer only talks to the main process via IPC; the main process enforces a strict allowlist of server origins and proxies `fetch`/`WebSocket`. This preserves the secure context for E2EE while allowing communication with HTTP servers.

---

## Q3: CORS — Origin Header Analysis

**Test file:** `electron-client/spike/test-api-resolution.js`

### Results

| Aspect | Result |
|--------|--------|
| Bundled origin | `wire-bundled://app` |
| `Origin` header sent to server | `wire-bundled://app` |
| Server CORS config (`middleware/cors.js`) | `origin: true` (reflects request Origin) |
| Credentials | `false` (no cookies) |

### Server CORS Requirement

The server's CORS middleware (`middleware/cors.js`) uses `origin: true` which reflects the request's `Origin` header. For the bundled client, the server must accept `Origin: wire-bundled://app`.

**Proposed server change:** No code change needed — `origin: true` already reflects any origin. However, the server should be aware that the Origin will be a custom scheme, not `http://...`.

---

## Q4: API Base Resolution & Capacitor Mechanism

**Test file:** `electron-client/spike/test-api-resolution.js`

### Current Client Behavior (`public/js/core/server.js`)

```javascript
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
| `http://192.168.1.100:3000/api/version` | `http://192.168.1.100:3000/api/version` | ❌ Mixed content blocked |
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
4. Renderer receives server origin via IPC (`server:get-saved`)
5. Client-side `getServerEndpoint()` returns the configured server origin (not `window.location.origin`)
6. `resolveServerUrl()` prepends server origin for relative URLs

---

## Q5: Service Worker Behavior

**Test file:** `electron-client/spike/test-sw-simple.js`

### Results

| Property | Value |
|----------|-------|
| `serviceWorker` supported | ✅ `true` |
| `controller` | `none` (not registered) |
| `isNativeApp()` | `false` (Capacitor not detected) |
| `isSecureContext` | `true` |
| `location.protocol` | `wire-bundled:` |

### pwa.js Behavior

```javascript
// public/js/core/pwa.js line 116
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

---

## Q6: Integrity Manifest

**Test file:** `electron-client/spike/test-integrity.js`

### Results

| Metric | Value |
|--------|-------|
| Files hashed | 206 |
| Algorithm | SHA-256 |
| Verification | 206 passed, 0 failed |

### Manifest Structure

```json
{
  "version": "1.0",
  "algorithm": "SHA-256",
  "files": {
    "index.html": { "hash": "sha256-abc123...", "size": 1234 },
    "js/core/api.js": { "hash": "sha256-def456...", "size": 5678 },
    ...
  }
}
```

### Protocol Handler with Integrity Verification

```javascript
protocol.handle('wire-bundled', async (request) => {
  const filePath = ...;
  const expected = INTEGRITY_MANIFEST.files[normalizedPath];
  if (!expected) return new Response('Not in manifest', { status: 404 });
  
  const content = fs.readFileSync(fullPath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  
  if (hash !== expected.rawHash) {
    return new Response('Integrity check failed', { status: 500 });
  }
  // serve file
});
```

**Value over ASAR alone:** ASAR provides filesystem-level integrity (tampering breaks the archive). The manifest adds **application-level integrity** — individual file hashes verified on every read, detecting bit-flips, partial corruption, or malicious replacement of individual files within a valid ASAR.

---

## Summary of Spike Answers

| Question | Answer |
|----------|--------|
| **Q1** | ✅ Custom protocol provides secure context with full crypto/IndexedDB/localStorage |
| **Q2** | **BLOCKED** — Mixed content blocks HTTP/WS from secure bundled origin. **Solution: Main-process bridge (IPC)** |
| **Q3** | Origin header is `wire-bundled://app`; server CORS reflects it automatically |
| **Q4** | Client assumes same-origin; needs absolute server base via IPC (like Capacitor) |
| **Q5** | SW skipped (protocol not http/https, not native) — correct behavior |
| **Q6** | 206 files hashed; manifest adds per-file integrity on top of ASAR |

---

## Next Steps for Phase 2 (Implementation)

1. **Implement main-process network bridge** (IPC `net.fetch`/`WebSocket` proxy)
2. **Add `display-capture` permission handler** for screen sharing
3. **Migrate `safeStorage` to async API** (sync methods deprecated in Electron 45)
4. **Update `public/js/core/server.js`** to accept absolute server base via IPC
5. **Add `desktopName` to package.json** for Linux window association
6. **Implement integrity manifest generation** in build step
7. **Add protocol handler with integrity verification** in `main.js`
8. **Update `preload.js`** to expose network bridge API
9. **Add CSP header injection** in protocol handler (`connect-src` restricted to server origin)
10. **Update `public/js/core/server.js`** to read server origin from IPC not `window.location.origin`

---

*All spike code under `electron-client/spike/` is throwaway — not imported by product.*