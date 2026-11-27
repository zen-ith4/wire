# Electron Bundled Client — Design Decisions

**Branch:** `electron-bundled-spike`  
**Base:** `998fa50a6476693a6b7b7646424d7ccfeb8aabad` (main)  
**Phase:** 1 — decisions locked, **no Electron implementation in this phase**  
**Spike evidence:** `docs/ELECTRON_BUNDLED_SPIKE_RESULTS.md`

> **Status legend used throughout**
>
> - **Verified (code)** — read from this tree at this commit; file:line cited.
> - **Verified (experiment)** — measured in the spike, not in this repo's product code.
> - **Planned** — a decision for Phase 2; nothing implements it today.
> - **Not verified** — stated as a requirement but not proven, or not testable in this environment.

The existing `electron-client/` is **not** the bundled client. It is a thin shell that loads
the chosen server's own web UI (`electron-client/main.js:380`). Everything below about
`wire-bundled://app`, app-enforced CSP, partitions and permission handlers is therefore
**Planned** unless marked otherwise.

---

## 1. Locked decisions

These are accepted; Phase 2 implements them. They are not options in the table any more.

| # | Decision | Notes |
|---|----------|-------|
| D1 | The bundled client connects to the server **directly**, restricted by an app-enforced CSP. | No main-process network bridge in Phase 2. The Q2 experiment showed direct `fetch()` and WebSocket work from the bundled scheme. The CSP is the control that limits where the page may connect. |
| D2 | **HTTPS only**, and `wss://` for sockets. | Plain HTTP/WS is allowed **only** in unpackaged development/test builds (`app.isPackaged === false`), and only to `localhost`, `127.0.0.1` or `[::1]`. No user setting and no environment variable may enable HTTP in a packaged build. Saved addresses and redirects are covered. Certificate validation is never disabled globally. |
| D3 | One **persistent session partition per server**. | Protocol handler, CSP header injection and permission handlers are registered on every partition, not just the default one. |
| D4 | Existing users **log in again** and restore their identity from the server, and are **told** that this happens. | Conditional on the Phase 6 inventory of device-only data (peer pins, verified state, old DM keys, group sender keys, KDF pin). Do **not** claim nothing is lost. |
| D5 | Updates are a **notification only**, with a fixed link inside the app. App code is **never** downloaded from the server. | The server's version endpoint may only cause a notice. |
| D6 | Permissions: **microphone only**, and only for the allowed app origin; notifications through the main process; **screen sharing and everything else denied**. | Enforced in both `setPermissionRequestHandler` and `setPermissionCheckHandler` per partition. |
| D7 | **Code signing: still open.** | No signing/notarization decision is made by this document. |

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
Everything that depends on the bundled client is **Planned** until Phase 2 ships and tests it.

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

| Capability | Mitigation | Status |
|---|---|---|
| Replace client code | UI files ship in `app.asar`; the protocol handler serves only those files. | **Planned.** `public/` is not in the package today (`package.json:25-32`), and `main.js` has no handler. |
| Serve different code per user | One identical bundle for all users. | **Planned.** |
| Weaken CSP | The app sets its own CSP on every document response, regardless of server headers. | **Planned.** No CSP injection exists in `main.js`. |
| Reach arbitrary hosts | App-enforced `connect-src` limited to the chosen server; HTTPS/wss gate. | **Planned.** Q2 only proved fetch/WS are *possible*; it did not test a restrictive CSP. |
| Push executable updates | Notification only; fixed in-app link; no server-supplied code or installer. | **Planned.** Today the server already supplies the whole UI. |
| Read message plaintext | E2EE stays end-to-end; server sees ciphertext and metadata. | **Implemented** in the existing protocol, unchanged by bundling. |
| Read the raw private key | The server holds only an encrypted blob; decryption happens in the renderer. | **Implemented**, with the caveat that the blob and KDF parameters are server-supplied. Do **not** claim "keys never leave the renderer". |
| Read the session token | The renderer stores it in `localStorage` (`public/js/core/auth.js:51,81`); a malicious server can read it. | **Not protected** by bundling. Token theft is outside this design's scope. |

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
   blocked only by CSP.
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

## 8. CSP applied by the app (corrected)

The previous draft's policy was incomplete. `middleware/csp.js:38-52` is the server's
policy that the app must mirror **plus** the bundled client's cross-origin needs:

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Baseline. |
| `script-src` | `'self'` | Bundled module scripts only; no inline/eval. |
| `style-src` | `'self' https://fonts.googleapis.com` | `public/index.html` links Google Fonts (`middleware/csp.js:21-24,41`). **No `'unsafe-inline'`**, matching the server policy. Inline `style=""`/handlers are why the server runs this Report-Only; enforcing it in the bundled client requires removing them first. |
| `font-src` | `'self' https://fonts.gstatic.com` | Actual font files (`middleware/csp.js:42`). |
| `img-src` | `'self' data: blob:` | Avatars/images and decrypted blobs. |
| `media-src` | `'self' blob:` | **Missing from the old draft.** Audio/video playback and voice messages need it (`middleware/csp.js:44`). |
| `connect-src` | `'self' https://<server> wss://<server>` (+ loopback `http://`/`ws://` only in unpackaged dev) | `https://host` does **not** authorize `wss://host`; both are required. Socket.IO starts with `websocket` and may fall back to `polling` (`public/js/core/socket.js:110`), so both the HTTP(S) and WS(S) origins of the server are needed. |
| `worker-src` | `'self' blob:` | Any worker/blob worker. The service worker is separate (Q5). |
| `object-src` | `'none'` | **Missing from the old draft**, present on the server (`middleware/csp.js:47`). |
| `base-uri` | `'self'` | As on the server. |
| `form-action` | `'self'` | As on the server. |
| `frame-ancestors` | `'none'` | As on the server. |
| `manifest-src` | `'self'` | **Missing from the old draft**, present on the server (`middleware/csp.js:51`). |

`upgrade-insecure-requests` is only meaningful in an enforcing policy and should not be
used as a substitute for the HTTPS gate in section 6 (it does not fix WebSocket or saved
addresses). **Status: Planned.** The Q2 experiment did not test CSP enforcement; it only
proved the connections are mechanically possible.

### Q5 status (service workers)

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

## 9. Permissions (D6)

**Verified (code, as a gap):** no permission handlers exist in `electron-client/`.

**Planned**, per persistent partition:

- `media`: allow only `audio` (`microphone`), only when the requesting origin is exactly the
  validated server origin. Camera and all other media types are denied.
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

---

## 10. Updates (D5)

**Verified (code):** the main process calls `GET /api/version`
(`electron-client/main.js:201-263`), compares versions (`main.js:265-289`), and sends
`app-update:available` to the renderer (`main.js:382-397`). It never downloads or executes an
installer.

**Planned:** keep the check, show a notification plus a **fixed link** that is compiled into
the app (project site / release page), and never load app code from the server. No
auto-download, no server-provided installer URL, no update of the bundle over HTTP. Code
signing remains open (D7), so no signed-update claim is made.

---

## 11. Self-signed and private-CA servers — open question

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

## 12. Document-vs-code verification table

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
permission handler results, redirect handling, and any Windows/macOS build. These are Phase 2
tests, not claims.

---

## 13. Phase 2 test plan (planned; nothing here is implemented)

| Test | What it must prove |
|---|---|
| Origin normalization | `wire-bundled://app` compares equal across main and renderer without using `.origin`; IPC rejects a different host/port. |
| HTTPS gate | Packaged: `http://` and `ws://` are rejected for connect, saved address and redirect. Unpackaged: only loopback allowed. No env/setting override. |
| Partition isolation | Two servers get different `persist:server:*` partitions; the second cannot read the first's token/pins. |
| CSP | Injected on every document response; `connect-src` includes exactly the chosen HTTPS/WSS origins; violation for another host is blocked. |
| Permissions | Microphone allowed only for the server origin; camera, notifications in renderer, display-capture and unknown permissions denied; check handler agrees with request handler. |
| Protocol handler | Traversal (`../`), absolute paths and files outside `public/` rejected; packaged files come from `app.asar`. |
| Update notice | A newer `/api/version` produces only a notice; no fetch of app code/installer from the server. |
| Migration | Old server-origin storage is not assumed; user is told to log in and restore; Phase 6 inventory drives the exact message. |
| Certificate strategy | Whatever the owner picks in section 11 is tested: self-signed fails closed by default; a pinned cert only matches the stored fingerprint. |

---

## 14. Open questions

1. **Code signing** (D7): EV certificate (Windows), Apple Developer Program/notarization
   (macOS), GPG (Linux) — budget and timeline.
2. **Self-signed/private-CA strategy** (section 11): public CA only, private CA in the OS
   trust store, or exact-certificate pinning. No bypass is implemented either way.

Everything else that used to be an open question is now a locked decision in section 1.

---

*Phase 1 only. No Electron implementation, no packaging change and no server change is made
by this document. Windows/macOS builds, a real microphone in Electron, CSP enforcement on the
custom scheme and permission-handler behaviour remain unverified.*
