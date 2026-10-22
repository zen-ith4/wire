# MEDIA_STREAMING_RFC — Progressive encrypted DM audio/video via Service Worker + HTTP Range

Status: Phase 0, RFC v2 (docs-only revision). No production, test, config, dependency or `public/sw-manifest.js` change is included in this commit.

## 0. Environment and evidence

### 0.1 Workstation and repository

| Item | Value |
|---|---|
| OS | Microsoft Windows 11 Enterprise 10.0.26300 |
| Node | v22.23.1 |
| Git branch | `security-hardening` |
| Git HEAD at RFC v2 | `0e614302fec22a3b2322226405ad5a34e870832e` (`docs: add media streaming RFC (Item 3 Phase 0)`) |
| Working tree at start | clean (`git status --short` empty) |
| `public/sw-manifest.js` | not edited; `node scripts/build-sw-manifest.mjs --check` exits 0, version `e08eca9a87c6`, 179 files |

### 0.2 Evidence actually used

- Source reading in the current tree; all line numbers below are from `HEAD` above.
- Existing non-browser Range coverage: `tests/dm-attachments/dm-attachments-e2ee.test.mjs:298-312`.
- Existing STREAM format coverage: `tests/dm-attachments/attachment-stream.test.mjs` and `tests/dm-attachments/dm-stream-constants.test.mjs`.
- Existing service-worker manifest coverage: `tests/sw-manifest.test.mjs:59-146`.
- Group browser test (unrelated feature, cited only as platform evidence for the Linux Chromium recipe): `tests/groups/group-key-trust-browser.test.mjs`, full recipe `1 tests, 1 pass`, TAP engine line `# \# browser: chromium (@sparticuz/chromium) HeadlessChrome/153.0.8010.0`.

### 0.3 What was not run

- No media-streaming implementation exists yet, so no playback/seek test was run for this RFC.
- No Safari, Firefox, iOS, Android-device, Electron-runtime or old-APK runtime test was run.
- No mutation plant was run against this RFC; mutation checks apply to later code phases (P1–P5).

## 1. Contradictions with the prompt

These are cases where the roadmap memory or prompt line numbers did not match the current tree.

| # | Where | What contradicts the prompt |
|---|---|---|
| 1 | `controllers/dm.controller.js:723-746` | The `?download=1` branch (the one E2EE clients actually use, `attachment-e2ee.js:209,235`) returns 200 with `Content-Length` and no `Accept-Ranges`. The Range support at `:748-895` is only reached when `?download` is absent. |
| 2 | `public/sw.js:307-309` | The existing worker returns early for any request with a `Range` header before it looks at the URL. A streaming handler must be inserted before that early return. |
| 3 | `scripts/build-sw-manifest.mjs:27-28` | `public/sw.js` and `public/sw-manifest.js` are both in `EXCLUDE`. Editing `public/sw.js` alone does not change `sw-manifest.js`; only listed assets do. |
| 4 | `public/js/media/voice-message.js:2433-2455` | Voice notes are not lazy. They call `resolveMediaSrc()` eagerly during render and decrypt into a Blob before playback, unlike video/audio. |
| 5 | `public/js/core/pwa.js:111-119` | Service-worker registration requires `http:`/`https:` and is skipped for native apps. Electron (`app://`) and the Capacitor APK therefore never register a worker, even though `isNativeApp()` is false in Electron. |
| 6 | `public/js/media/attachment-e2ee.js:45` | The decrypted-blob cache cap is 64 MiB (`DECRYPTED_CACHE_MAX_BYTES`). A 50 MB plaintext attachment is below that cap, so it can be cached after decryption. The v1 sentence claiming it could not be cached was wrong. |

### 1.1 Found, not changed

These are code findings, not contradictions with the prompt. They are listed so they are not lost.

| # | Where | Finding |
|---|---|---|
| 1 | `config/dm-stream.js:12-15` and `public/js/crypto/messages/attachment-stream.js:43-50` | Chunk size is 64 KiB (`1 << 16`), tag 16 bytes, header 8 bytes. The fixed-offset formula `8 + i × 65552` is true for full chunks `0..N-2` and for the start of chunk `N-1`; the last chunk's length varies (`plaintextRemainder + 16`). |
| 2 | `controllers/dm.controller.js:780-782` | The Range regex is `/bytes=(\d*)-(\d*)/` and is not anchored. It silently accepts trailing garbage and, for `bytes=0-1,5-6`, matches only the first range. Multi-range is not implemented. |
| 3 | `controllers/dm.controller.js:784-792` and `:820-832` | 416 responses do not set `Accept-Ranges`. `Accept-Ranges: bytes` appears only in the no-Range branch (`:762-764`) and the 206 branch (`:848-851`). |
| 4 | `public/js/media/video-player.js:291-314` | There is no spinner CSS for `.video-player.is-loading`; the class only disables the play button. |
| 5 | `public/js/chat/group-attachments-flag.js:17` | `GROUP_ATTACHMENTS_UI_ENABLED` is `false`, but it is a client-side constant, not a server config value. |
| 6 | `public/js/media/attachment-e2ee.js:45` | The decrypted-blob cache cap is 64 MiB (`DECRYPTED_CACHE_MAX_BYTES`), while the DM upload cap is 50 MB plaintext (`config/constants.js:107`). |

## 2. Answers to the fourteen questions

### Q1. Current client path

Trace (DM, encrypted attachment):

1. `public/js/chat/dm.js:2289` `buildDmMessageEl(msg, currentUser)` builds the message element.
2. `public/js/chat/dm.js:2367` queues `loadChatImage(msg.id, 'dm')` for images.
3. `public/js/chat/dm.js:2370` calls `mountAttachmentMedia(msg, div, 'dm')`.
4. `public/js/media/attachments.js:801-865` `mountAttachmentMedia()` dispatches voice/audio/video.
5. Encrypted audio/video render with no `src` and `preload="none"`:
   - `public/js/media/video-player.js:116,118`
   - `public/js/media/audio-player.js` lazy path
6. `public/js/media/lazy-e2ee-media.js:54-89` `installLazySource()` wraps `play()`; the first play calls `ensureSource()` (`:58-84`), which calls `resolveMediaSrc(msg, scope)` (`:64`).
7. `public/js/media/mediaToken.js:86-95` `resolveMediaSrc()` sees a registered secret and calls `fetchDecryptedAttachment(scope, id)` (`:90`), then `URL.createObjectURL(blob)` (`:91`).
8. `public/js/media/attachment-e2ee.js:217-264` `fetchDecryptedAttachment()` authenticates with `Authorization: Bearer <session JWT>` (`:235-239`), streams `response.body` (`:249-251`) through `decryptAttachmentStream()` (`:253`), and caches the Blob (`:254`).
9. `public/js/crypto/messages/attachment-stream.js:223-284` `decryptAttachmentStream()` authenticates every chunk and returns `new Blob(out, { type: mimeType })` at `:284`.

What stays on the Blob path (no streaming):

- Images: `public/js/media/attachments.js:1098-1122` (`fetchDecryptedAttachment` → `URL.createObjectURL`).
- Voice notes: `public/js/media/voice-message.js:2433-2455` (eager `resolveMediaSrc` during render, then `audio.src = resolvedUrl` at `:2502`).
- Explicit downloads: `public/js/media/attachments.js:2008-2030` (`fetchDecryptedAttachment` → `URL.createObjectURL` at `:2027`).
- Legacy (non-E2EE) media: token URL path, unchanged.

What the user sees today for a large encrypted video:

- Before play: poster-less black `<video>` with `aria-label="Encrypted video - press play to load"` (`video-player.js:279-282`).
- On first play: the play button is disabled and `.is-loading` is toggled (`video-player.js:291-297`), but there is no spinner CSS for `.video-player.is-loading`. Audio players dim to 0.7 opacity and disable pointer events (`audio-player.css:529-532`).
- After the whole file downloads and decrypts, `src` is assigned and playback starts. There is no byte progress indicator.
- On failure: video shows a `.video-error-note` with text `Video could not be decrypted` (`video-player.js:298-310`); audio shows its error box.

Proposed threshold: **8 MiB of plaintext** (128 × 64 KiB chunks) for encrypted `video/*` and `audio/*` only. Reason: below 8 MiB the existing full-download path finishes quickly enough that SW Range complexity, postMessage handshakes and per-stream state are not worth the risk; above it, time-to-first-frame and peak memory dominate. Images and voice notes stay on the Blob path regardless of size.

Threshold vs. upload cap (D1):

- The DM upload cap is configurable through the `DM_UPLOAD_MAX_MB` environment variable (`config/constants.js:107`). Default: 50. Server code applies no clamp, min or max beyond reading the number (`config/constants.js:107`); a non-positive or non-finite value is not clamped on the server. The client falls back to 50 MB when `/api/dm/limits` returns a non-positive or non-finite value (`attachment-e2ee.js:288-303`). The server exposes the effective cap through `GET /api/dm/limits` (`controllers/dm.controller.js:337-339`), which requires authentication.
- Single source of truth: the server. The client caches the first successful `/api/dm/limits` response in `uploadLimitPromise` (`attachment-e2ee.js:282-303`) and resets it on `resetUploadLimitCache()`. Tests: `tests/dm-attachments/dm-attachments-server-cap.test.mjs` and `tests/dm-attachments/dm-attachments-size-precheck.test.mjs`. The upload-cap is not part of `dm-stream-constants.test.mjs`, which only pins container-format constants.
- The 8 MiB threshold affects only attachments from **8 MiB up to the configured cap**. At the default 50 MB cap that is a 42 MB window. If the cap is below 8 MiB, no DM attachment takes the new path.

| Configured cap | Blob path (≤ 8 MiB) | New streaming path (8 MiB < size ≤ cap) |
|---|---|---|
| 10 MB | ≤ 8 MiB | 8 MiB – 10 MB |
| 25 MB | ≤ 8 MiB | 8 MiB – 25 MB |
| 50 MB (default) | ≤ 8 MiB | 8 MiB – 50 MB |
| 100 MB (env-raised) | ≤ 8 MiB | 8 MiB – 100 MB |
| Below 8 MiB | all attachments | none |

- The 8 MiB threshold should be a **client-side named constant**, not a shared server/client constant, because the server is path-agnostic and never needs to know which path the client chose. If web and native clients share code, put it in their shared module and cover it with a unit test.

### Q2. Server Range behaviour

Controller: `controllers/dm.controller.js:637-895` `getAttachment()`.

| Claim | Verified? | Evidence |
|---|---|---|
| Authentication enforced on every request | Yes | Route `routes/dm.routes.js:116-120` (`mediaAuth`); controller access check `controllers/dm.controller.js:654-662` (sender or recipient only). `mediaAuth` (`middleware/mediaAuth.js:119-154`) accepts either a session Bearer JWT or a scoped `?token=` media token, but the controller re-checks membership either way. |
| `Accept-Ranges: bytes` | Partial | Set in no-Range branch `:762-764` and 206 branch `:848-851`. Not set in `?download` branch `:723-746` or on 416 responses `:784-792,820-832`. |
| `Content-Range` | Yes on 206 | `:843-846` (`bytes start-end/fileSize`). Also on 416 (`:787-789,826-829` as `bytes */fileSize`). |
| `Content-Length` | Yes | No-Range `:757-758`; `?download` `:725-726`; 206 `:853-855` (chunk size). |
| HEAD | No explicit handler | No `req.method === 'HEAD'` anywhere in `getAttachment` (`:637-895`). Route is GET-only (`routes/dm.routes.js:116-120`). Express may answer HEAD generically, but Range semantics for HEAD are UNVERIFIED. |
| Open-ended range `bytes=a-` | Yes | `end` defaults to `fileSize - 1` (`:798-800`); `:794-800`. |
| Suffix range `bytes=-n` | Yes | Handled `:802-814` (`start = max(fileSize - n, 0)`, `end = fileSize - 1`). |
| Multi-range `bytes=a-b,c-d` | No | Regex `:780-782` matches only the first range; the comma and second range are ignored. Not supported. |
| 416 behaviour | Yes | No regex match `:784-792`; invalid `start/end` `:820-832` (`start < 0`, `end >= fileSize`, `start > end`). Response `bytes */fileSize`. |
| 206 vs 200 when range is the whole file | 206 | No special case; `bytes=0-(fileSize-1)` passes validation and returns 206 (`:841-856`). |
| ETag / If-Range / Last-Modified | Absent | No ETag, If-Range or Last-Modified handling anywhere in `getAttachment` (grep of `:637-895`). `res.sendFile`-style conditional responses are not used. |
| Existing test coverage | Yes | `tests/dm-attachments/dm-attachments-e2ee.test.mjs:298-312` checks 206 slicing, `Content-Range`, and 416 for a DM attachment Range request. |

Additional notes: `?download=1` is a full-body path with no Range and no `Accept-Ranges`; the streaming design must either stop using `?download=1` for large media or add Range support to that branch. The safer change is to use the normal attachment URL (no `?download`) for streamed ranges, because that branch already implements Range.

### Q3. Authorization from the Service Worker

Today:

- Page session token is in `localStorage` (`public/js/core/auth.js:41,63-75`) and is sent as `Authorization: Bearer` (`attachment-e2ee.js:237`).
- Media elements cannot send headers, so `mediaToken.js` mints a short-lived attachment-scoped token (`TOKEN_CACHE_TTL_MS = 60_000` client cache at `mediaToken.js:22`; server TTL 90 s at `utils/jwt.js:118`) and puts it in the URL (`mediaToken.js:59-70`). `mediaAuth` (`middleware/mediaAuth.js:119-154`) verifies it against `(resType, resId)`.
- The Service Worker cannot read `localStorage` (correct; it has no access to the page's storage in this design).

Options:

| Option | What an XSS in the page can do | What a compromised SW can do | Token lifetime | Widens token exposure? |
|---|---|---|---|---|
| (a) Page passes a short-lived, per-stream, per-attachment token through `postMessage` | Same as today: the page already holds the session JWT and can mint media tokens. No new capability. | Can fetch ciphertext for the streams it has been given until expiry; cannot mint new tokens or read other attachments. | 90 s (existing media token) or a new stream TTL chosen by us | No, if the token is the existing media token. A longer-lived stream token would widen replay. |
| (b) Cookie | Ambient authority: any same-origin request, including from injected script, carries it automatically. Worse than today. | Can fetch anything the cookie authorizes, including non-media endpoints. | Session cookie lifetime | Yes — introduces ambient authority and CSRF surface that does not exist today. |
| (c) Existing `mediaToken.js` mechanism | Same as (a); this is the concrete implementation of (a) available today. | Same as (a). | 90 s server / 60 s client cache | No new widening beyond the existing media-token URL, which already appears in browser history/Referer. |

Recommendation: use (c)/(a) — the page calls `.../media-token`, receives the existing 90 s media token, and posts it to the SW together with the 128-bit stream id. The SW fetches ciphertext with `?token=<mediaToken>` (the only form `mediaAuth` accepts for media tokens; the Bearer path requires a session JWT, `middleware/mediaAuth.js:123-132`). The page refreshes the token before expiry and posts an `UPDATE_TOKEN` message. Do not introduce a cookie. A new server-signed stream token is not needed for Phase 1; if added later, bind it to `(user, attachment, streamId)` and keep TTL ≤ 90 s so it does not widen replay.

Token refresh (pull model, per D3):

- The SW must not rely on a page timer. It treats the token as opaque and tracks only an `expiresAt` value supplied by the page (or derived from the JWT payload's `exp` if the SW decodes it without verifying).
- When a ciphertext fetch needs a token and none is present or `Date.now() >= expiresAt`, the SW posts `TOKEN_NEEDED { streamId }` to the registering client and holds the fetch request pending for up to 5 s.
- If `UPDATE_TOKEN` arrives within 5 s, the SW uses it and completes the fetch. If not, the SW returns 401 for that request and moves the stream to `DEAD` only if playback cannot continue; the player's error path then retries.
- Background tab: the browser may throttle the page, but the SW is still running. The page handles `TOKEN_NEEDED` when it is next scheduled. If the page is frozen, the SW's 5 s timeout fires and returns 401; playback pauses/buffers. When the page thaws, it checks token expiry and posts `UPDATE_TOKEN` before retrying.
- The page also posts a proactive `UPDATE_TOKEN` on `visibilitychange` when `document.visibilityState === 'visible'` and the token expires within 10 s, so a tab returning to the foreground does not hit the 5 s timeout.
- bfcache: on `pagehide`, if `event.persisted` is true, the page does **not** send `PURGE_CLIENT`. The SW keeps the stream under its idle TTL so a restored page can reattach. On `pageshow` with `persisted === true`, the page re-registers only if the SW reports the stream is gone.
- Page frozen (Page Lifecycle `freeze`): the page cannot mint tokens. The SW's 5 s timeout fires and returns 401; playback pauses/buffers. When the page resumes, it checks expiry and posts `UPDATE_TOKEN` before retrying.
- Page gone (tab closed or discarded): no purge message may arrive. The SW drops the stream after the 10-minute idle TTL. If the SW is terminated first, the stream is already gone and the page re-handshakes on restore.
- The SW never mints or verifies tokens; it only forwards them.

### Q4. Key handling

- Keys live only in SW memory. They are handed over by `postMessage`, keyed by an unguessable 128-bit random stream id, and released when the media element is removed or the page unloads.
- Page-side source of truth remains `secrets` in `attachment-e2ee.js:39,55-61`; the page can re-handshake because it still holds the key.

Proposed message schema (page ↔ SW):

- Page → SW `REGISTER_STREAM`: `{ type, streamId, attachmentId, scope, keyB64 (32 bytes), baseIvB64 (12 bytes), mime, plainSize, clientId }`
- Page → SW `UNREGISTER_STREAM`: `{ type, streamId }`
- Page → SW `UPDATE_TOKEN`: `{ type, streamId, token, expiresAt }`
- Page → SW `TOKEN_NEEDED` is SW → page: `{ type, streamId }`
- Page → SW `PURGE_CLIENT`: `{ type, clientId }`
- SW → page `STREAM_DEAD`: `{ type, streamId, reason }`
- SW → page `KEY_NEEDED`: `{ type, streamId }`

Sender authentication:

- The SW checks `event.origin === self.location.origin` (`public/sw.js` is same-origin, `pwa.js:129-132`).
- The SW records the `client.id` from `event.source` at registration and only accepts later messages for that stream from the same client id (verified via `self.clients.get(id)`).
- The SW has no cryptographic way to authenticate the page beyond origin; the 128-bit stream id is the unguessable capability. This is acceptable because the page already holds the key.

Client binding for stream fetches:

- The SW stores `clientId` in the stream entry and serves a fetch only when `event.clientId` (or `event.resultingClientId`) equals that value.
- If `event.clientId` is empty in a target browser, the SW fails closed (404) rather than serving the stream, to avoid cross-tab or cross-origin leakage. Browser behaviour for media-element `clientId` is UNVERIFIED; P5 must record which browsers populate it.
- `request.destination` is the canonical request destination in the Fetch standard and is preferred over parsing the `Sec-Fetch-Dest` header. Older Safari support for `request.destination` inside a fetch event is UNVERIFIED in this repository.

Persistence:

- Plaintext and keys must never enter Cache Storage, IndexedDB, or any persisted store.
- The SW must not call `caches.put` for stream responses; stream state is a `Map` in worker memory only.
- Assertion in tests: enumerate `caches.keys()` and every cache entry after playback and assert that no cached response URL or body contains the plaintext marker or key material; also assert `Cache-Control: no-store` on every stream response (`utils/streamMedia.js:28` is the existing precedent).

### Q5. Final-chunk flag, truncation and response policy

Where the size comes from:

- The authoritative plaintext size is `meta.size` from the decrypted attachment metadata (`attachment-stream.js:307`, `buildAttachmentMeta` at `:299-312`). The sender controls it, but it is inside the authenticated envelope.
- The SW computes the expected ciphertext size with the existing `encryptedSizeFor(plainSize)` arithmetic (`attachment-stream.js:123-126`): `8 + plainSize + chunks × 16`, `chunks = max(1, ceil(plainSize / 65536))`.
- On the first ranged response, the SW reads `Content-Range: bytes …/total` (or `Content-Length` on 200) and requires it to equal the computed expected ciphertext size. If the server reports a different total, the SW fails closed (no streaming for that stream) and surfaces an error. The Blob fallback still verifies the whole file.

Byte arithmetic:

- `STREAM_HEADER_BYTES = 8` (`attachment-stream.js:45`, `config/dm-stream.js:25`)
- `STREAM_CHUNK_SIZE = 65536` (`attachment-stream.js:43`, `config/dm-stream.js:13`)
- `STREAM_TAG_BYTES = 16` (`attachment-stream.js:44`, `config/dm-stream.js:14`)
- `CT_CHUNK = 65552` (`attachment-stream.js:50`) for buffering in the full-stream decryptor
- Chunk `i` (for `i < chunks - 1`) is exactly 65536 plaintext bytes + 16 tag = 65552 ciphertext bytes.
- Chunk `i` starts at ciphertext offset `8 + i × 65552`.
- The last chunk starts at `8 + (chunks - 1) × 65552` and has length `(plainSize mod 65536 || 65536) + 16`.
- Total ciphertext size = `8 + plainSize + chunks × 16`.

Mapping a plaintext byte range to chunks:

- The media element issues Range requests over the decrypted plaintext resource, whose total length is `plainSize` (`meta.size`). The SW maps that to ciphertext chunks.
- For a plaintext range `[a, b]` (inclusive, 0-based):
  - first chunk index = `floor(a / 65536)`
  - last chunk index = `floor(b / 65536)`
  - SW fetches ciphertext bytes from `8 + firstChunk × 65552` to the end of the last chunk, clamped to the file.
  - After decrypting each full chunk, the SW trims the decrypted plaintext to `[a mod 65536, …]` for the first chunk and the corresponding tail for the last chunk, then returns exactly `b - a + 1` bytes.
- Partial first/last chunk handling is therefore "fetch the whole containing chunk, decrypt it, slice the plaintext", never "decrypt a partial chunk" (GCM cannot authenticate a partial chunk).

Final-chunk flag:

- Chunk `i` is final iff `i === chunks - 1`. The SW knows `chunks` from `plainSize`, so it sets the per-chunk nonce's final flag (`attachment-stream.js:100-106`) correctly before calling `subtle().decrypt` with that chunk's bytes.
- The server cannot be trusted to mark finality; the SW decides from the size it already validated.

Truncation, reordering, duplication, tampering:

- Each chunk is AES-256-GCM with per-chunk nonce `prefix(7) || index(4, big-endian) || final(1)` and AAD = the 8 header bytes (`attachment-stream.js:15-22,100-106,164,248`). Reordering changes `index`; truncation leaves a chunk shorter than its tag; duplication repeats an index; tampering fails the tag. All are detected per chunk (`attachment-stream.js:253-255` throws `AttachmentDecryptError`).
- In streaming mode, a bad chunk fails only the ranges that touch it: ranges wholly contained in already-verified chunks can still be served from the SW's in-memory plaintext cache; a range that includes the bad chunk returns an error response and surfaces a player error. No partial plaintext is returned for that range.
- An appended trailing chunk is not requested if the size check passed; if the size check failed, streaming is disabled for that stream.

Response policy for Range requests:

- The SW caps each 206 response to `maxResponseChunks` plaintext chunks (recommended 16, i.e. 1 MiB) even when the browser requests an open-ended or very large range. The served range becomes `start` through `min(start + maxResponseBytes - 1, plainSize - 1)`, with a matching `Content-Range: bytes start-end/plainSize`.
- Open-ended `Range: bytes=a-` is treated as `bytes=a-(a+maxResponseBytes-1)`, clamped to the file size.
- If the origin returns 200 to a ranged ciphertext fetch (no `Content-Range`/`Content-Length` usable for the expected total), the SW fails closed for that stream and surfaces an error. It must not guess the total from the response body.
- Safari/iOS may probe with `Range: bytes=0-1`. The SW answers a correct 206 with exactly 2 plaintext bytes and `Content-Range: bytes 0-1/plainSize`, provided the first chunk decrypts successfully.
- HEAD: the SW answers headers only (`Content-Length: plainSize`, `Accept-Ranges: bytes`, MIME, `Cache-Control: no-store`) without a body. It does not decrypt.
- API impact: `rangeToChunks(range, totalSize)` becomes `rangeToChunks(range, totalSize, { maxResponseChunks })` and returns the bounded served range plus the chunk indices needed. `decryptChunkRange(...)` takes the same option and returns the trimmed plaintext for exactly that served range. This prevents unbounded memory use and unbounded response sizes.

### Q6. The Service Worker as a new attack surface

Required controls and what they do/do not block:

| Control | Blocks | Does not block |
|---|---|---|
| Serve only registered stream ids (in-memory `Map` in the SW) | Arbitrary URL guessing / scanning of stream endpoints | A page that already knows a stream id (it created it) |
| MIME allowlist to `video/*` and `audio/*`, additionally requiring `isInlineSafeMime` (`utils/inlineSafeMime.js:16-55`) | `text/html`, SVG, XML, PDF and other active/document types becoming an XSS vector via a mislabelled response | A hostile sender who claims `video/mp4` for bytes that are not actually video — playback simply fails |
| Refuse requests whose destination is not `video` or `audio` (using `request.destination`, with `Sec-Fetch-Dest` only as a secondary signal) | Direct `fetch()`/navigation/script reads of decrypted bytes; reduces exfiltration paths | A compromised renderer that instantiates a real `<video>`/`<audio>` element |
| `X-Content-Type-Options: nosniff` | Browser MIME sniffing turning an octet stream into HTML | A response whose declared MIME is itself dangerous (hence the allowlist above) |
| `Cache-Control: no-store` | HTTP cache / Cache Storage persistence of plaintext | In-memory buffers in the SW or page if we implement caching carelessly |
| `Content-Security-Policy: sandbox` on the response | Script execution even if a dangerous MIME slips through | Media rendering itself; must be verified in P5 |

MIME source: the encrypted metadata's `mime` field (`attachment-stream.js:306`), which the sender controls. `parseAttachmentMeta` (`attachment-stream.js:338-340`) only checks the regex shape and lowercases it; it does not restrict to safe types. Therefore the SW must enforce the allowlist at serve time, and the client must not trust `msg.attachment_mime` for stream serving. A hostile sender claiming `text/html` is rejected by the SW allowlist; if the client still tried to use it, the player would not receive a playable response.

Hostile server: controls ciphertext, sizes and status codes. It can truncate or lie, but cannot bypass AES-GCM or the size check; it cannot execute script because of the MIME allowlist, `nosniff` and `sandbox`. It can cause denial of service (refuse to serve), which is acceptable and surfaces as a player error.

Hostile sender: controls plaintext, name and MIME. It can send arbitrary bytes, but they are encrypted to the recipient; it cannot force script execution in the recipient's origin because the served MIME is restricted to media types and the response is sandboxed. It can send oversized files, but the 50 MB upload cap (`config/constants.js:107`) and client pre-check (`attachment-e2ee.js:326-329`) bound that.

Existing SW conflict check (`public/sw.js`):

- Scope is `/` (`pwa.js:129-132`); it precaches only manifest-listed shell files (`public/sw.js:345-352`).
- It does not special-case `/api/`; it simply does not match shell files and returns to the network for same-origin paths (`:354-357`). But the Range early return at `:307-309` happens before URL parsing, so any Range request bypasses the worker today.
- A streaming handler must be inserted before `:307-309`, scoped to a dedicated path (proposed: `/__wire_media_stream/<streamId>`), and call `event.respondWith()`. It must not touch the shell-cache path or the font path.
- No conflict with precache/activation logic: stream responses are never cached.

CSP analysis correction (per D4):

- A media element loading `/__wire_media_stream/<id>` is governed by the page's `media-src` (and `default-src` fallback), not `connect-src`. The current policy already allows `media-src 'self' blob:` (`middleware/csp.js:44`), so no CSP change is needed for the stream URL itself.
- The Service Worker script is loaded under `worker-src 'self'` (and `default-src 'self'`) in the page's CSP (`middleware/csp.js:46`). The stream response's own `Content-Security-Policy: sandbox` is an additional response-level defence, not the mechanism that permits playback.

### Q7. Platform matrix

| Platform | SW support | Range / 206 semantics needed | Fallback to Blob path and how the client detects the need |
|---|---|---|---|
| Chrome / Edge (desktop) | Supported in secure context | Media element requests byte ranges; expects 206 + `Content-Range` + `Content-Length`; 416 on bad range | Fallback if `!('serviceWorker' in navigator)`, registration rejects, `navigator.serviceWorker.controller === null`, SW killed, or a stream request returns an unsupported status. Detection: try registration; listen for `controllerchange`; on player `error`, fall back. |
| Firefox | Supported in secure context | Same as above | Same detection as Chrome. |
| Safari (macOS) | UNVERIFIED in this repo; Service Workers require a secure context | UNVERIFIED; assumed to need 206 + `Content-Range` | Treat as supported-with-fallback. Detection: registration failure or `controller === null`. Mark any Safari-specific claim UNVERIFIED until a WebKit run exists. |
| Safari (iOS) | UNVERIFIED in this repo | UNVERIFIED; iOS media elements are stricter about Range and may require the first request to be `bytes=0-` | Same fallback detection; strongly recommend a real-device test in P5 before enabling. |
| Chrome (Android) | Supported in secure context (HTTPS) | Same as desktop Chrome | Same detection. |
| Electron (`app://`) | Not available | N/A — no SW controls the page | Always Blob path. Detection: `pwa.js:111-119` rejects registration because `location.protocol` is not `http:`/`https:`; `isElectron` (`public/js/core/auth.js:223-228`) can also be used. |
| Old APK (bundled `public/`) | Not available | N/A | Always Blob path. Detection: `isNativeApp()` true (`public/js/core/server.js:33-35`) causes `pwa.js:116` to skip registration. |
| PWA install | Supported after first controlled load | Same as browser | First load before the SW controls the page uses Blob path; detection: `navigator.serviceWorker.controller === null` before `controllerchange`. |

HTTPS-only note: Service Workers are unavailable on insecure origins, so the streaming feature is HTTPS-only (or `http://localhost` for development). Self-hosted deployments without HTTPS keep the Blob path; media still plays, but without Range streaming. The app itself continues to work over HTTP.

### Q8. `public/sw-manifest.js`

What it is: a generated list of every application-shell file under `public/` (except `sw.js` and itself) with its SHA-256 content hash, plus a `version` that is the first 12 hex chars of `sha256(url:rev\n…)` (`scripts/build-sw-manifest.mjs:27-60`). `public/sw.js` imports it (`public/sw.js:49`) and precaches/verifies every listed file before activating.

What changes when `public/sw.js` or any listed asset changes:

- Editing `public/sw.js` alone changes no manifest entry, because `sw.js` is in `EXCLUDE` (`build-sw-manifest.mjs:28`). The browser still reinstalls the worker because `registration.update()` fetches `sw.js` with `updateViaCache: 'none'` (`pwa.js:129-132`).
- Editing any listed asset (including client wiring files that Item 3 will touch, or a new module added under `public/`) changes that file's `rev` and therefore the `version`.
- Current version: `e08eca9a87c6` (`public/sw-manifest.js:4`); `node scripts/build-sw-manifest.mjs --check` currently exits 0.

`sw.js` is excluded from the manifest and will now hold keys. The manifest therefore does not integrity-pin the worker script itself. `SECURITY_CLAIMS.md` must state: a server that serves JavaScript can serve a modified service worker, so HTTPS and server trust are part of this feature's security boundary.

Diff we would make (not applied in this commit): none yet, because no implementation file has changed. The exact hunk is produced by `node scripts/build-sw-manifest.mjs` after P3/P4 changes. The expected effect is a new `version` string and updated `rev` entries for every changed listed file. The exact new version is UNVERIFIED until those changes exist; do not fabricate it.

Relationship to commit `59df178` (`chore: refresh service-worker manifest`):

- `59df178` changed only `public/sw-manifest.js` (21 insertions, 13 deletions) to bring it current with an earlier asset change.
- Item 3 will regenerate the same file on top of whatever HEAD is at implementation time. If `59df178` is accepted, Item 3's manifest diff is computed from `e08eca9a87c6`; if it is rejected, recompute from the prior version. There is no expected textual conflict because Item 3 does not hand-edit the manifest; it regenerates it. The manifest hunk must still be shown to the owner and approved before it is committed (P3).

Proposed `public/sw.js` insertion point (code block only, not applied):

```js
// In public/sw.js, after parsing the request URL and before the Range early-return:
const url = new URL(request.url);
if (url.origin !== self.location.origin) return;
if (request.method !== 'GET' && request.method !== 'HEAD') return;

if (url.pathname.startsWith('/__wire_media_stream/')) {
  const streamId = url.pathname.split('/')[2];
  event.respondWith(handleWireMediaStream(request, streamId));
  return;
}
```

### Q9. Memory bounds

Proposed numbers (to be validated in P5):

- Read-ahead window: **8 chunks** (512 KiB plaintext) ahead of the playhead.
- In-memory plaintext cache per stream: **16 chunks** (1 MiB) LRU.
- Concurrent streams: **2**; a third request waits or is rejected with 503 and the player retries.
- In-flight ciphertext fetches per stream: **2**.
- Abort: every fetch uses `request.signal`; on element removal, navigation or logout the AbortController fires and the stream is unregistered.
- Fast seeking: cancel in-flight fetches, drop cached chunks outside the new position, fetch the window at the new position. Do not retain chunks from the old position.
- Two videos at once: allowed (up to the 2-stream limit); each keeps its own 1 MiB cache. Peak ~2 MiB of plaintext plus ciphertext fetch buffers, not the file size.
- Worst case for a DM attachment: the configured upload cap (default 50 MB plaintext) is the largest possible attachment. Memory stays O(window) because the SW never downloads the whole file; it fetches only the chunks for the current and read-ahead ranges. The size check uses metadata, not a full download. If the configured cap is raised later, the same windowed behaviour applies.

Read-ahead worked example (D5):

- 64 KiB chunks (`STREAM_CHUNK_SIZE = 65536`, `attachment-stream.js:43`).
- 1080p at a typical 4 Mbps = 500 KiB/s. Chunks per second = 500 / 64 = 7.81. An 8-chunk (512 KiB) read-ahead is therefore 512 / 500 = 1.02 s of playback. A 720p stream at 2.5 Mbps = 312.5 KiB/s is 1.64 s.
- 128 kbps audio = 16 KiB/s. Chunks per second = 16 / 64 = 0.25. The same 8-chunk read-ahead is 32 s of audio.
- Memory: 8 chunks read-ahead + 16 chunks cached = 1 MiB per stream. For 2 concurrent streams the hard cap is 2 MiB of plaintext cache, plus ciphertext fetch buffers.
- Hard cap: **2 concurrent streams**, **16 cached chunks (1 MiB) per stream**, and **16 chunks (1 MiB) per 206 response** (`maxResponseChunks`). A third stream is rejected with 503 until one completes.

Justification: the format is deliberately 64 KiB chunks so tampering is detected within one chunk and memory stays flat (`attachment-stream.js:33-39`). 1 MiB per stream is small compared with the 64 MiB decrypted-blob cache already tolerated for the Blob path (`attachment-e2ee.js:45`), while giving the media element enough buffered data for smooth playback.

### Q10. Interaction with lazy loading and out-of-scope items

- The click/intent gate stays: encrypted audio/video render with no `src` and `preload="none"` (`video-player.js:62-91`, `audio-player.js` lazy path, `lazy-e2ee-media.js:54-89`). The new path changes only what happens after the first `play()` for media above the threshold.
- Group attachments are out of scope: `GROUP_ATTACHMENTS_UI_ENABLED` is `false` (`public/js/chat/group-attachments-flag.js:17`) and the group binding differs. Do not touch group attachment code in Item 3.
- Voice notes: out of the streaming path for the initial rollout (D2). They are short, are eagerly decrypted into a Blob during render (`voice-message.js:2433-2455`), and streaming would add latency and state for little gain. Revisit only if telemetry shows long voice notes.
- Blob-URL cleanup: `revokeMediaPlayerBlobUrls()` (`attachments.js:1312-1341`) revokes `data-blob-url` on removal/teardown and is covered by `tests/blob-url-cleanup.test.mjs` and `tests/dm-blob-url-cleanup.test.mjs`. The stream path has no blob URL; instead it must call `UNREGISTER_STREAM` on element removal. New tests must cover stream release separately.
- Logout and per-client purge:
  - `public/js/core/auth.js:103-121` locks identity and clears session keys, then dispatches `wire:logout`.
  - `public/js/chat/dm.js:129-140` clears DM caches.
  - Item 3 must additionally call `clearAllAttachmentSecrets()` (`attachment-e2ee.js:83-89`) and `clearMediaTokenCache()` (`mediaToken.js:97-99`).
  - The page sends `PURGE_CLIENT { clientId }` to the SW on logout and on `pagehide`/`beforeunload`. A tab closing must purge only streams registered by that client; it must not kill another tab's playback.
  - The SW also applies an idle TTL (recommended 10 minutes) to orphaned streams in case a tab closes without sending the purge message.
- In-flight stream on logout: the page aborts its `AbortController`s; the SW stops fetching and returns an aborted response; the player is removed. No plaintext persists. After logout the page must not re-register streams, because `clearAllAttachmentSecrets()` removed the keys.

### Q11. Check-then-use

| Place | Risk | Binding in the design |
|---|---|---|
| Plaintext size (`meta.size`) vs server-reported total | Server could lie about length; final chunk could be misidentified | Compute expected ciphertext size from `meta.size`; require `Content-Range`/`Content-Length` total to match; fail closed otherwise |
| MIME (`meta.mime`) vs served `Content-Type` | Sender-controlled MIME could become active content | SW allowlists to `video/*`/`audio/*` + `isInlineSafeMime` at serve time; page derives `attachment_mime` from decrypted meta but does not control the SW allowlist |
| Key vs stream id | A stream could be served with the wrong key | `REGISTER_STREAM` binds `streamId ↔ attachmentId ↔ key`; SW keeps one entry per stream id; `UNREGISTER_STREAM` removes it |
| Token vs attachment | A token for attachment A could be replayed for B | Existing media token is scoped to `(resType, resId)` (`utils/jwt.js:136-147`); SW uses one token per stream and refreshes via `UPDATE_TOKEN` |
| Total ciphertext size vs range fetch | A range could be fetched against a stale/wrong total | Total is captured once per stream from the first response and reused for all ranges; mismatch aborts the stream |
| Stream id in URL vs postMessage | A guessed URL could bypass registration | SW checks the in-memory `Map` before serving; unknown id returns 404 |
| Client binding vs fetch origin | A fetch from another tab/origin could read a stream | SW compares `event.clientId`/`resultingClientId` to the registering client; mismatch returns 404 |

### Q12. Fail-closed table

| Structural check that can fail | User sees |
|---|---|
| Unknown / unregistered stream id | 404 from SW; player error; fallback to Blob path only if the page still holds the key |
| Missing total size (no `Content-Range`/`Content-Length`) | Streaming disabled for that stream; player error; fallback to Blob path |
| Size mismatch (server total ≠ computed expected) | Stream aborted; player error; no silent fallback to an unverified path. Fallback to Blob is allowed because the Blob path runs the same full AEAD verification, but it will fail if the ciphertext is actually truncated |
| Authentication failure (401/403) | "Session expired" or access-denied message; no retry with a stale token; 401 triggers logout |
| Bad or unsatisfiable Range (416) | Player error; no hang (the existing controller already returns `bytes */fileSize` at `controllers/dm.controller.js:825-831`) |
| Tampered chunk (GCM failure) | Only ranges touching that chunk fail; player shows "Media could not be decrypted"; other ranges already verified remain usable |
| MIME not in allowlist | SW returns 415/403; player error |
| Invalid destination | SW returns 403 |
| SW killed mid-playback | Buffering, then re-handshake; if that fails, player error + Blob fallback |
| No controller / registration failure / first load before control | Blob path from the start; no error shown |
| Logout | Stream aborted and purged for that client; player removed; no fallback |

### Q13. Wire format

Nothing changes. The stored ciphertext format (`WAT1` header, 64 KiB chunks, 16-byte GCM tag, per-chunk nonce with final flag, header AAD), the `attachment_meta` envelope, the AAD, HKDF infos and the database schema are untouched. Item 3 is transport-layer only: the SW issues Range requests against the existing ciphertext file and maps plaintext byte ranges to existing chunks. `meta.size` already carries the plaintext size (`attachment-stream.js:307`). No new field is added to the envelope. If any later phase concludes that a field is needed, that phase must stop and write a separate proposal listing every field and byte before changing anything.

### Q14. New dependency

No. The design uses APIs already available in the target browsers and in the existing stack: Service Worker (`fetch`, `postMessage`, `clients`), Web Crypto (`subtle.decrypt`, already used by `attachment-stream.js`), `ReadableStream`, `AbortController`, and Express/Node streams (already used by `controllers/dm.controller.js`). No npm package is added. If a future phase believes one is needed, it must name the package, version, audit status and stop for approval.

## 3. Proposed design

### 3.1 Data flow

1. Message renders; `mountAttachmentMedia()` renders the player with no `src` (`video-player.js:116`, `audio-player.js` lazy path).
2. User presses play; `installLazySource()` calls `resolveMediaSrc()` (`lazy-e2ee-media.js:64`).
3. For attachments above the threshold, instead of `fetchDecryptedAttachment()` (full download), the client registers a stream:
   - generate `streamId = crypto.randomUUID()` (128 bits);
   - read the secret from `attachment-e2ee.js`;
   - post `REGISTER_STREAM` to the SW with key, base IV, MIME, `plainSize`, `clientId`;
   - the SW posts `TOKEN_NEEDED` when it needs a token; the page mints a media token and posts `UPDATE_TOKEN`;
   - set `media.src = /__wire_media_stream/<streamId>`.
4. The browser's media engine issues Range requests against that URL.
5. The SW validates the stream id, client binding, MIME, destination, size and token, maps the bounded plaintext range to ciphertext chunks, fetches them from the origin (with `?token=`), decrypts each chunk, trims to the requested range, and returns 206 with `Content-Range` over `plainSize`.
6. On element removal, `UNREGISTER_STREAM` is posted and the SW drops the key and aborts in-flight fetches.
7. Attachments at or below the threshold keep the existing Blob path unchanged.

### 3.2 Message protocol (page ↔ SW)

See Q4 for the schema. Additional rules:

- The SW never accepts a message whose `event.origin !== self.location.origin`.
- Registration is idempotent by `streamId`: re-registering replaces the entry (used for re-handshake after SW restart).
- Token refresh must arrive before the current token's 90 s expiry; otherwise the SW returns 401 and the page re-mints.
- `PURGE_CLIENT` is fire-and-forget and idempotent.
- The SW applies a 10-minute idle TTL to orphaned streams.

### 3.3 State machine (per stream, in SW memory)

States: `REGISTERED` → `FETCHING` → `SERVING` → `DEAD` (also `PURGED`).

- `REGISTERED`: key and size present; no fetch in flight.
- `FETCHING`: at least one ciphertext Range fetch in flight.
- `SERVING`: a verified plaintext response has been returned.
- `DEAD`: an unrecoverable error (size mismatch, tampered chunk that blocks playback, auth failure) occurred; further requests return the stored error status until `UNREGISTER_STREAM`.
- `PURGED`: key dropped; any request returns 404.

Transitions:

- `REGISTER_STREAM` → `REGISTERED`.
- First Range request → `FETCHING`.
- Successful verified response → `SERVING`.
- Size mismatch / tampered chunk / auth failure → `DEAD`.
- `UNREGISTER_STREAM` or `PURGE_CLIENT` → `PURGED`.
- SW termination → all streams lost; page re-registers into `REGISTERED`.

### 3.4 Proposed phases (plan only; not started)

- **P1** Pure functions `rangeToChunks(range, totalSize, { maxResponseChunks })` and `decryptChunkRange(...)` with no SW and no DOM. Tests: property test against a full-decrypt oracle; boundaries (0, last byte, chunk boundary, one byte over, empty file, one chunk, partial final chunk); tamper (flip one bit in chunk k: only requests touching k fail); reorder; truncate; duplicate; wrong key; bounded response size.
- **P2** Server tests for Range on DM attachments (new file), including auth, HEAD, suffix, open-ended and 416.
- **P3** SW module and registration behind a flag defaulting OFF; fallback always works; show the `sw-manifest` hunk first and wait for OK.
- **P4** Client wiring for video and audio above the threshold only.
- **P5** Browser tests on Linux with the project Chromium recipe: playback starts before full download; seek works; tampered chunk shows a clear error and does not break the page; removing the element releases the stream; logout purges; no plaintext in Cache Storage.
- **P6** Docs: `SECURITY_CLAIMS.md` (new surface, what the SW can and cannot protect), manifest rebuild noted, every sentence cited.

For each phase: one commit per concern, test-first, mutation plants with exact failing output line, full non-browser suite counts at the end (tests / pass / fail / cancelled / skipped / todo, base vs new, same test set, same exclusions), differential runs where relevant, and `git diff --stat` for `database/`, `routes/` and wire-format modules showing empty where applicable.

## 4. Failure and fallback matrix

See Q12. Summary: every structural failure fails closed (error surfaced, no silent unverified path). The Blob fallback is permitted only because it performs the same full download and the same AEAD verification; it is used when the SW is unavailable or killed, not when verification fails.

## 5. Test plan (for P1–P5)

- P1 property tests for `rangeToChunks` and `decryptChunkRange` against the existing full-stream decryptor oracle (`attachment-stream.js:223-284`).
- P2 new server test file for DM Range (extend the pattern at `tests/dm-attachments/dm-attachments-e2ee.test.mjs:298-312`); include auth, HEAD, suffix, open-ended, multi-range rejection, and 416.
- P3 SW install tests reusing `tests/_sw-install-harness.mjs` and `tests/sw-manifest.test.mjs` patterns; assert no stream URL enters any cache.
- P4 unit tests for stream registration, client binding, token refresh and unregister on removal.
- P5 browser tests on Linux with the full recipe (`--experimental-test-module-mocks --env-file=tests/test.env --test-timeout=900000`), printing the exact TAP engine line. Include: playback starts before full download; seek works; tampered chunk shows a clear error; element removal releases the stream; logout purges; no plaintext in Cache Storage; `request.destination` behaviour by browser.
- Mutation plants for each new gate, with exact failing output lines, per the Batch A evidence rules.

## 6. Decisions needed from the owner

1. **D1 — Threshold.** Accept 8 MiB of plaintext for encrypted video/audio only. The DM upload cap is configurable (`DM_UPLOAD_MAX_MB`, default 50 MB), so the threshold affects attachments from 8 MiB up to the configured cap.
2. **D2 — Voice notes.** Out of the streaming path initially.
3. **D3 — Token.** Reuse the existing 90 s media token, but the SW pulls it on demand via `TOKEN_NEEDED` (no page timer). Background-tab and frozen-page behaviour are specified in Q3.
4. **D4 — URL shape.** Accept `/__wire_media_stream/<id>`. CSP correction is in Q6: `media-src`/`default-src`, not `connect-src`.
5. **D5 — Memory.** Provisional. Read-ahead is 8 chunks (~512 KiB), about 1.0 s at 4 Mbps. Response sizes are capped by `maxResponseChunks`.
6. **D6 — Safari/iOS.** Supported-with-fallback, flag default OFF, enable only for browsers with a verified run.
7. **D7 — Manifest.** No edit now. Commit `59df178` is OK if `--check` passes at HEAD (it does as of this RFC: version `e08eca9a87c6`, 179 files).
8. **D8 — CSP sandbox.** Accept; verify in P5.
9. **D9 — Fallback.** Accept.

## 7. Verified / unverified / not run

### Verified by reading source in this tree

- All `file:line` citations in sections 1–6.
- Current Range implementation behaviour in `controllers/dm.controller.js:637-895`.
- Existing SW behaviour and scope in `public/sw.js:294-389` and `pwa.js:111-132`.
- Manifest generation and current version via `node scripts/build-sw-manifest.mjs --check` (exit 0, version `e08eca9a87c6`, 179 files).
- Existing Range test at `tests/dm-attachments/dm-attachments-e2ee.test.mjs:298-312`.
- Existing STREAM format tests and constants test (`tests/dm-attachments/attachment-stream.test.mjs`, `tests/dm-attachments/dm-stream-constants.test.mjs`).

### Unverified (marked UNVERIFIED in the text)

- HEAD handling for DM attachments (no explicit branch; Express generic behaviour not tested).
- Multi-range, ETag and If-Range behaviour (not implemented; inferred from absence).
- Safari macOS/iOS Service Worker support and media Range semantics.
- Electron and old-APK runtime behaviour (inferred from registration guards, not run).
- Exact new `sw-manifest.js` version after implementation (cannot compute without the changed files).
- Whether `Content-Security-Policy: sandbox` breaks media playback in any browser.
- Whether `event.clientId` is populated for media-element requests in each target browser.
- Whether `request.destination` is available in older Safari inside a fetch event.

### Not run

- No media-streaming code or tests exist yet; no playback, seek, tamper, logout or Cache-Storage assertion was run for this RFC.
- No mutation plant was run against this RFC (it is documentation only).

---

## 8. 3B pre-implementation notes (owner decisions + measured SW update behaviour)

This section supersedes section 6 for the decisions listed in 8.1. Docs-only: no code, no tests, no config, no `public/sw-manifest.js` change.

### 8.1 Owner decisions (accepted)

- **3B/3C direction: option (ii)** — the classic `public/sw.js` stays the ONE service worker and gains a single `importScripts()` of a generated esbuild bundle. M2 (bundle outside the manifest) and M3 (fail-soft precache) are **rejected**.
- **M1: the bundle is INSIDE the manifest** — it is hashed by `scripts/build-sw-manifest.mjs` and precached + hash-verified by the worker at install time.
- **History: no rewrite.** `6f2aa98` (the 3A export) is the only red commit on the branch: `SW-1`, `SW-2a` and `SW-4a` fail there because the manifest did not match the changed hashed asset. `git bisect` **must skip `6f2aa98`**; every other commit on `security-hardening` is green.

### 8.2 Measured: when does a service worker actually update?

All measurements were run in **headless Chromium 153.0.8010.0** (`@sparticuz/chromium` 153.0.0, `puppeteer-core` 25.14.0) against **throwaway workers outside the repository** (a scratch directory under the OS temp dir; nothing was written into the repository or into the WSL clone of it). Registration used `updateViaCache: 'none'`, matching the application (`public/js/core/pwa.js:129-132`).

**Correction to the previous revision of this section.** The first version of this note concluded that "only the main script's bytes drive an update" and imposed the constraint that every bundle change must also change `public/sw.js`. **That conclusion was wrong.** The first measurement changed the imported bundle but left the manifest stale, so the new worker's `precache()` failed its hash check and the install was rejected — exactly as in the mismatch measurement. The "transient installing worker" was the browser detecting the change and starting an update, not an anomaly. The measurements below separate the two effects.

#### Environment of every measurement in this section

```
ENGINE
  os.platform      : linux
  os.release       : 6.18.54.1-microsoft-standard-WSL2
  os-release       : PRETTY_NAME="Ubuntu 26.04.1 LTS"
  kernel           : Linux version 6.18.54.1-microsoft-standard-WSL2 (root@9b80f41eb17c) (gcc (GCC) 13.2.0, GNU ld (GNU Binutils) 2.41)
  node             : v22.23.2   (/home/home/node-v22.23.2-linux-x64/bin/node)
  chromium package : 153.0.0  (/home/home/browser-check/node_modules/@sparticuz/chromium)
  puppeteer-core   : 25.14.0
  chromium exe     : /tmp/chromium
  CHROMIUM_DIR     : /home/home/browser-check
  LD_LIBRARY_PATH  : /home/home/chromium-libs/usr/lib/x86_64-linux-gnu
  script path      : /mnt/c/Users/HOME/AppData/Local/Temp/wire-work/sw-update-measure.mjs
  command          : /home/home/node-v22.23.2-linux-x64/bin/node /mnt/c/Users/HOME/AppData/Local/Temp/wire-work/sw-update-measure.mjs /mnt/c/Users/HOME/AppData/Local/Temp/wire-work
CHROMIUM=HeadlessChrome/153.0.8010.0
```

The measurement scripts are **stored** on a Windows path (`C:\Users\HOME\AppData\Local\Temp\wire-work`, mounted into WSL2 as `/mnt/c/...`) but they **ran inside WSL2 Ubuntu**: `os.platform` is `linux`, the kernel is `6.18.54.1-microsoft-standard-WSL2`, the userland is `Ubuntu 26.04.1 LTS` and the Node binary is `/home/home/node-v22.23.2-linux-x64/bin/node`. The browser is the project's pinned pair taken from `CHROMIUM_DIR` (`@sparticuz/chromium` 153.0.0 with `puppeteer-core` 25.14.0) and reports `HeadlessChrome/153.0.8010.0`. **No measurement in this section was produced on Windows, and none used a Chromium other than the project's.**

Both measurement commands were launched from Windows as:

```
wsl.exe -d Ubuntu -- env PATH=/home/home/node-v22.23.2-linux-x64/bin:/usr/local/bin:/usr/bin:/bin \
  CHROMIUM_DIR=/home/home/browser-check LD_LIBRARY_PATH=/home/home/chromium-libs/usr/lib/x86_64-linux-gnu \
  /home/home/node-v22.23.2-linux-x64/bin/node /mnt/c/Users/HOME/AppData/Local/Temp/wire-work/<script>
```

The full output of both runs is kept outside the repository (`sw-update-measure.out.txt`, `sw-global-collision.out.txt`).

#### Scenario matrix

| # | Worker | Hash check | What changed | `updatefound` | New worker activated | Result |
|---|---|---|---|---|---|---|
| A | throwaway | yes | bundle **and** manifest regenerated | 1 | **yes** | new worker active, `marker="v2"`, second versioned cache |
| B | throwaway | **no** | bundle **and** manifest regenerated | 1 | **yes** | `marker="v2"`, second versioned cache |
| C | throwaway | **no** | bundle only (manifest stale) | 1 | **yes** | `marker="v2"`, same cache (manifest version unchanged) |
| D | throwaway | yes | bundle only (manifest stale) — *the original, confounded measurement* | 1 | **no** | install rejected by the hash check; old worker stays, `marker="v1"` |
| E1 | **the real `public/sw.js`** | yes | shell asset **and** manifest regenerated, `sw.js` untouched | 1 | **yes** | cache `wire-shell-b43145dc40b5` -> `wire-shell-8301e62c9115`; the served `index.html` contains the change |
| E2 | **the real `public/sw.js`** | yes | shell asset only (manifest stale) | **0** | no | no update attempted at all; old cache, old `index.html` |

#### A — hash check on, bundle changed, manifest regenerated consistently

```
BEFORE
  active            : activated   http://127.0.0.1:39411/sw.js
  controller        : http://127.0.0.1:39411/sw.js
  caches            : ["wire-shell-122598f09289"]
  marker            : "v1"
UPDATE
  update() error    : null
  updatefound count : 1
  active changed    : true
  timeline          : 0-0ms  installing||activated|true
  timeline          : 101-1005ms  ||activating|false
  timeline          : 1105-7920ms  ||activated|false
AFTER
  active            : activated   http://127.0.0.1:39411/sw.js
  controller        : http://127.0.0.1:39411/sw.js
  caches            : ["wire-shell-122598f09289","wire-shell-638e0491521f"]
  marker            : "v2"      <-- the NEW bundle is in use
```

#### C — hash check OFF, bundle changed only (`sw.js` byte-identical, manifest stale)

```
BEFORE
  caches            : ["wire-shell-122598f09289"]
  marker            : "v1"
UPDATE
  updatefound count : 1
  active changed    : true
AFTER
  caches            : ["wire-shell-122598f09289"]
  marker            : "v2"      <-- the NEW import was fetched and is in use
```

#### D — hash check on, bundle changed only (the original, confounded measurement)

```
BEFORE
  caches            : ["wire-shell-122598f09289"]
  marker            : "v1"
UPDATE
  updatefound count : 1           <-- the browser DID detect the change
  active changed    : false       <-- but the install was rejected
  timeline          : 0-0ms  installing||activated|true
  timeline          : 100-7918ms  ||activated|true
AFTER
  caches            : ["wire-shell-122598f09289"]
  marker            : "v1"       <-- the OLD bundle, because the install never completed
```

#### E1 — the real project flow: shell asset changed, manifest regenerated, `sw.js` untouched

```
BEFORE
  caches            : ["wire-shell-b43145dc40b5"]
  index has marker  : false
UPDATE
  updatefound count : 1
  active changed    : true
  timeline          : 0-1002ms  installing||activated|true
  timeline          : 1102-2004ms  ||activating|false
  timeline          : 2104-11930ms  ||activated|false
AFTER
  caches            : ["wire-shell-8301e62c9115"]   <-- old cache deleted by the activate handler
  index has marker  : true                          <-- the NEW shell is being served
```

#### E2 — control: shell asset changed, manifest NOT regenerated

```
BEFORE
  caches            : ["wire-shell-b43145dc40b5"]
UPDATE
  updatefound count : 0            <-- no update was even started
  active changed    : false
AFTER
  caches            : ["wire-shell-b43145dc40b5"]
  index has marker  : false
```

#### Global-name collision (same Linux environment, same engine line)

A classic worker and an `importScripts()`'d classic script share one global scope. The generated bundle publishes itself with `var WireMedia = …`, so a worker that declares a **top-level `let`/`const` named `WireMedia`** collides with it:

```
A) worker declares `let WireMedia = null;` (top level) + bundle declares `var WireMedia`
  {"ok":false,"error":"TypeError: Failed to register a ServiceWorker for scope ('http://127.0.0.1:40035/') with script ('http://127.0.0.1:40035/sw.js'): ServiceWorker script evaluation failed"}
B) worker declares `let MEDIA_BUNDLE = null;` (top level) + bundle declares `var WireMedia`
  {"ok":true,"body":"bundle-loaded","state":"activated"}
```

Consequence for 3B: `public/sw.js` must **not** declare a top-level binding named `WireMedia`; it reads the bundle through `self.WireMedia` instead. The whole worker script failing to evaluate would otherwise break the worker and not only the media route.

#### Measured (Chromium 153, this environment)

1. **A changed imported script starts an update even when `sw.js` is byte-identical.** The browser fetched the imports, found different bytes, created a new worker (`updatefound` fired) and installed it (C, D).
2. **With the manifest regenerated consistently, the new worker activates, takes control and uses the new import** (`marker="v2"`, a second versioned cache) — measured in A and B.
3. **With a stale manifest, the install is rejected by the hash check** (`public/sw.js:125-131`); the old worker stays active and keeps serving the old shell and the old bundle (D).
4. **The real project flow already rolls out today.** A shell asset change plus a regenerated manifest plus an unchanged `public/sw.js` produced a new worker that installed, activated, took control and served the new shell (E1); the previous versioned cache was deleted by the activate handler (`public/sw.js:171-199`).
5. **Without the manifest regeneration, no update is started at all** (E2: `updatefound` = 0). An asset change is invisible to the worker because the imported `public/sw-manifest.js` did not change.

#### Inferred (not measured here)

- That the browser compares the **imported** scripts byte-for-byte inside its update check is consistent with all six measurements, but the mechanism was not traced inside the browser; only Chromium 153 was tested. MDN documents that the update-check HTTP-cache policy covers "the service worker script and any scripts imported via `importScripts()`" (`ServiceWorkerRegistration.updateViaCache`), which is why the application registers with `updateViaCache: 'none'` (`public/js/core/pwa.js:129-132`); with the default `imports` policy the HTTP cache is consulted for imports.
- Firefox, Safari, iOS and Electron behaviour is **not** measured.

#### Consequence for 3B (corrected)

The rollout trigger is the **imported `public/sw-manifest.js`**, not the bytes of `public/sw.js`. With M1 the bundle is a manifest entry, so a bundle change changes the manifest (`scripts/build-sw-manifest.mjs:43-50`, version at `:57-60`), the imported `sw-manifest.js` changes, the browser starts an update, the new worker precaches and verifies the new bundle hash, and it activates with the new bundle. **No generated line inside `public/sw.js` is needed, and `public/sw.js` does not have to change for a bundle change to roll out.** The one deployment rule is the one the project already follows — regenerate the manifest whenever a shipped file changes ("Run it on every deploy", `scripts/build-sw-manifest.mjs:11`). If the manifest is not regenerated, the update is either never started (E2) or is rejected at install (D), and users keep the previous bundle.

### 8.3 Bundle failure modes under M1 — the dependency is **not** soft

**Corrected claim.** With M1 the bundle is a manifest entry, so it is **not** a soft dependency of the worker:

- A **missing** bundle makes `precache()` fail: the fetch returns 404 and the worker throws `Wire SW: precache /sw-media-bundle.js: HTTP 404` (`public/sw.js:108-120`). The install is **rejected** and the previously active worker keeps serving.
- A **mismatching** bundle makes the hash check fail: `Wire SW: precache /sw-media-bundle.js: content does not match manifest` (`public/sw.js:125-131`). The install is **rejected** and the previously active worker keeps serving.
- The `try`/`catch` around `importScripts()` therefore covers exactly **one** case: the bundle **exists**, **matches its manifest hash**, and **throws while it is evaluated**. Then the worker script still evaluates, the precache succeeds, and the worker activates **without** the media bundle.

| # | Bundle state | `importScripts()` | `precache()` | Install | Active worker | What the user sees |
|---|---|---|---|---|---|---|
| 1 | present, hash matches, evaluates | ok | ok | succeeds | the new worker, with the media route | the new app; media streaming works |
| 2 | present, hash matches, throws at evaluation | throws, caught | ok | **succeeds** | the new worker **without** the media bundle | the new app; the media route is absent, so the client falls back to the Blob path (degraded, not broken) |
| 3 | present, hash mismatch (tampered / partial deploy) | the served bytes may execute — they are verified only afterwards | **throws** (hash) | **rejected** | the old worker | the old app (old shell, old bundle); the old worker's behaviour applies |
| 4 | missing (404) | throws, caught | **throws** (HTTP 404) | **rejected** | the old worker | the old app; no media route until the bundle is deployed |

Rows 3 and 4 are the integrity guarantee M1 buys. Row 2 is the only case the `try`/`catch` in `public/sw.js` actually covers.

The comment in `public/sw.js` must say the same thing — here is the corrected wording for the 3B hunk:

```js
/*
 * Media bundle (Item 3, phase 3B).
 *
 * The bundle is generated by scripts/build-sw-media-bundle.mjs and is listed in
 * sw-manifest.js, so it is NOT a soft dependency: a missing or altered bundle
 * makes precache() fail, this worker's install is rejected, and the previously
 * active worker keeps serving (see precache()).
 *
 * The try/catch below covers exactly one case: the bundle exists, matches its
 * manifest hash and throws while it is evaluated. Then this worker activates
 * without a media bundle and the client falls back to the Blob path.
 *
 * The generated bundle publishes itself as the global `WireMedia`. This script
 * must therefore never declare a top-level `let`/`const` named `WireMedia`:
 * that would collide with the bundle's `var WireMedia` and the whole worker
 * script would fail to evaluate (measured, 8.2).
 */
```

### 8.4 Where the manifest build runs (deploy / CI inventory)

E2 shows the failure mode this inventory has to prevent: a shell file (or, with M1, the bundle) changes, the manifest is **not** regenerated, and the rollout stops **silently** — the browser does not even start an update (`updatefound` = 0, E2), so the old shell keeps being served.

| Where | What it does | Live? |
|---|---|---|
| `scripts/build-sw-manifest.mjs:11` | the instruction "Run it on every deploy (before the files are uploaded/served)" | a comment. There is **no deploy script in this repository** (no Dockerfile, no deploy script, no workflow) — the deploy is manual |
| `tests/sw-manifest.test.mjs:59-62` (SW-1) | runs `node scripts/build-sw-manifest.mjs --check` against `public/` and fails the suite when it is out of date | **live** — `scripts/run-tests.mjs:39-55` runs every `tests/**/*.test.mjs`, so any `npm test` fails on a stale manifest |
| `tests/sw-manifest.test.mjs:65-96` (SW-2a-d) | `--check` really fails when a file changes, when line endings flip, and when the manifest is stale or missing | live |
| `docs/ci/linux-tests.yml:65-66` | CI step "sw-manifest must be current": `node scripts/build-sw-manifest.mjs --check` | **not live** — the file states at `:3-7` that it is documentation only, is not under `.github/`, is not activated and has never executed; the repository contains **no `.github/` directory** |
| `docs/ci/RUN_ON_LINUX.md:78`, `:97` | the same `--check`, as the first command of the manual Linux recipe and as step 3 of the documented workflow | manual recipe, run by hand |

**Answer: does a missing rebuild fail CI?** There is **no activated CI** in this repository (no `.github/` directory; `docs/ci/linux-tests.yml` is documentation that has never run on a runner). The only automatic enforcement is the **test suite**: SW-1 (`tests/sw-manifest.test.mjs:59-62`) fails on a stale manifest, and the manual Linux recipe starts with the same `--check` (`docs/ci/RUN_ON_LINUX.md:78`). A rebuild that is forgotten **and** never reaches a test run reaches production silently, and then E2 applies: no update is started, the old shell keeps being served, and nothing complains. 3B therefore also ships a test that asserts the bundle is listed in `public/sw-manifest.js` with the SHA-256 of its bytes, so the manifest cannot drift away from the bundle unnoticed.

### 8.5 P-test plan (Linux browser test; no code yet)

File: a new `tests/*-sw-media-bundle-browser.test.mjs` (name decided when P5 starts), run with the project recipe (`CHROMIUM_DIR`, `unset WIRE_TEST_ALLOW_SYSTEM_BROWSER`, `node --experimental-test-module-mocks --env-file=tests/test.env --test --test-timeout=900000`).

1. **Install with a matching bundle.** Serve a real `public/sw.js` + `public/sw-manifest.js` + a bundle whose bytes hash to the manifest entry. Register, wait for `ready`. Assert: `registration.active.state === 'activated'`, `navigator.serviceWorker.controller` is set, and a shell asset (e.g. `/index.html`) is served **from the SW cache** (the SW answers it, not the network).
2. **Break the bundle (M1 mismatch).** Re-serve the bundle with one byte changed, keeping `sw.js` and the manifest identical. Call `registration.update()`. Assert:
   - the **old** worker is still `active` and is still the controller (same `scriptURL`);
   - the shell asset is still served from the old worker's cache (old bytes);
   - no new worker reaches `activated` (no `waiting` worker afterwards);
   - the media route is NOT available (the old worker has no media bundle) -> the client falls back to the Blob path.
3. **Restore the bundle and update again.** Assert the new worker installs and activates, and that the shell cache is refreshed to the new manifest version.
4. **Roll-out (the positive counterpart of 2).** Change the bundle **and** regenerate `public/sw-manifest.js` consistently (the manifest lists the new hash and a new version), leave `public/sw.js` untouched, then call `registration.update()`. Assert: a new worker is created (`updatefound` fires), it reaches `activated`, it becomes the controller, the new versioned cache exists, and the active worker now uses the **new** bundle (the media route answers with the new bundle's behaviour). This is the property measured in A and E1 (8.2).
5. **Integrity assertion.** Assert the bundle is listed in `public/sw-manifest.js` with a `rev` equal to the SHA-256 of its bytes, and that `node scripts/build-sw-manifest.mjs --check` passes.

### 8.6 Exact claim for `docs/SECURITY_CLAIMS.md`

> **Service worker integrity.** The application shell is integrity-pinned by `public/sw-manifest.js`: `scripts/build-sw-manifest.mjs` hashes every shipped file under `public/` (`:43-50`) and derives a version from that list (`:57-60`), and the worker verifies each file's SHA-256 before storing it, refusing to install on any mismatch (`public/sw.js:88-137`, the throw at `:125-131`). This protects against **corruption** and **partial deployments** (assets and manifest out of step). It does **not** protect against a **malicious server**: the same server serves `public/sw.js` (excluded from the manifest, `scripts/build-sw-manifest.mjs:28`), `public/sw-manifest.js` (also excluded, `:28`) and every hashed asset, so a server that can serve JavaScript can serve a modified worker, a modified manifest and a modified asset consistently. A server that can serve JavaScript can serve a modified service worker. The service worker (and, with M1, the media bundle it imports) is therefore part of the trusted computing base, and the application must only be served over HTTPS from a server the user trusts.

Supporting notes for that paragraph:

- With M1 the **media bundle is inside the manifest**: it is hashed by `scripts/build-sw-manifest.mjs:43-50` and verified by the worker before it is stored (`public/sw.js:88-137`). The bundle is therefore *more* protected than `public/sw.js` itself, which is excluded from the manifest (`scripts/build-sw-manifest.mjs:28`).
- The bundle is **executed before the precache hash verification** (`importScripts()` runs at worker evaluation time; the verification happens in the `install` handler). Why that is harmless: (a) at that moment the worker **holds no keys** — keys are only handed over by the page over `postMessage` after the worker is activated (RFC Q4), and a worker that never activates is never the page's controller, so it never receives those messages; (b) the worker that failed the verification is discarded and the previous worker keeps serving; (c) the only code that ran is the bundle itself, which the same server could have tampered with inside `public/sw.js` anyway — so M1 does not widen the trust boundary beyond the existing "the server serves JS" assumption, it only adds a *corruption/partial-deploy* check. A passive corruption normally fails to parse (nothing runs); a targeted corruption could execute briefly inside a worker that controls nothing and holds no keys.
- **UNVERIFIED** (must be settled in P5 or stated as a limitation): (1) whether a non-activated worker can receive a `postMessage` from a page (not tested); (2) the browser's exact wording and delivery of the install-failure error (the page console was empty in the probe); (3) the update behaviour in browsers other than Chromium 153 (Firefox, Safari, Electron) was **not** measured — the measurements in 8.2 are Chromium-only.

### 8.7 Rate-limiter inventory (read-only; no env file changed)

Grep of `tests/` for `rateLimit|RateLimit|429|Too many requests|LOADTEST_DISABLE_RATE_LIMITS`:

| File:line | What it depends on |
|---|---|
| `tests/groups/group-hardening-f6-device-id.test.mjs:63-89` | **Asserts limiter behaviour**: a flood of new device ids must produce a 429 with `Retry-After` (`:84-85`). It therefore **requires the limiter to be ACTIVE** — it would fail if `LOADTEST_DISABLE_RATE_LIMITS=true` were set for `tests/groups/`. |
| `tests/dm-v2-wire-browser-paths.test.mjs:19-30` | Documents (and depends on) the registration limiter's 5-attempts-per-15-minutes budget per process. |
| `tests/dm-v2-wire-browser-paths.test.mjs:547-557` | `apiPoll()` uses a 500 ms step precisely so the poll "trips the app's own rate limiter" less often (comment: a 50 ms poll over 30 s is ~600 requests -> "Too many requests"). |
| `tests/files-path-traversal.test.mjs:418`, `:467` | Documents the 10-request budget of the section and that exceeding it yields 429. |

Env state: `tests/dm-attachments/_env.mjs` sets `LOADTEST_DISABLE_RATE_LIMITS = 'true'`; **`tests/groups/_env.mjs` and `tests/groups/_env-3c.mjs` do not**. No env file was changed by this note.

### 8.8 Labelling convention for the two `dm-v2-wire-browser-paths` failures

`e3. a stored row with recipientId rewritten is not readable` and `e4. changing the row reply_to_id breaks the AAD binding, so the row is not readable`:

> **fail deterministically when `dm-v2-wire-browser-paths` runs alone in WSL2 (5/5, base and HEAD); pass in the full-suite run; depends on shared limiter budget**

The mechanism is the test's own polling tripping the app's general API limiter (`middleware/rateLimiter.js:402-415`, 300 requests / 60 s per user or IP): in an isolated run the file's requests exhaust the shared budget, in a full-suite run the budget is spread differently and both tests pass (observed: `ok 382` and `ok 383` in the full Linux suite of phase 3B). They are **not** described as flaky. They **passed on the Ubuntu 24.04 machine** used earlier in Batch A.

---

## 9. Phase 3C design note (docs only - no code, no client change)

Phase 3C adds the **Service Worker media route**. This section is the implementation-level design: where the code goes, what each guard does, what fails closed and what is still unknown. It follows the decisions of sections 2-6 (Q3 token, Q4 keys, Q5 response policy, Q6 attack surface, Q12 fail-closed table) and adds the specifics. **Nothing here is implemented**: no fetch handler, no client change, no rate-limiter change.

### 9.1 What 3C is, and what it is not

| In 3C | Not in 3C |
|---|---|
| the SW media route in `public/sw.js` | any change to `controllers/dm.controller.js` (its Range behaviour is pinned by `tests/dm-attachments/dm-attachments-range-current.test.mjs`, commit `05e81fb`) |
| the feature flag (default OFF) | enabling the flag in a shipped build |
| the SW-side guards (destination, client binding, MIME, token, TTL) | the client-side player wiring (phase 4/P4) |
| the failure table and the UNVERIFIED list | the browser end-to-end tests (P5) |

### 9.2 The fetch handler: the media branch comes BEFORE the Range early return

`public/sw.js:294-311` today:

```js
self.addEventListener('fetch', (event) => {
  const request = event.request;

  /*
   * Only plain GET requests belong to this worker.
   */
  if (request.method !== 'GET') {
    return;
  }

  /*
   * Range requests are deliberately never intercepted.
   */
  if (request.headers.has('range')) {
    return;
  }

  const url = new URL(request.url);
```

The media route **must** be evaluated before that early return, because the media route answers `Range` requests itself (it decrypts exactly the requested byte range) and would otherwise never be reached. Draft hunk (not applied):

```js
self.addEventListener('fetch', (event) => {
  const request = event.request;

  /*
   * Only plain GET requests belong to this worker.
   */
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  /*
   * MEDIA STREAM ROUTE (Item 3, phase 3C).
   *
   * This branch is deliberately BEFORE the "Range requests are never
   * intercepted" rule below: the media route answers Range requests
   * itself, so the general rule would skip it.
   *
   * The route is off unless MEDIA_STREAM_ENABLED says otherwise, so the
   * default behaviour of this worker is unchanged.
   */
  if (
    url.origin === self.location.origin &&
    MEDIA_STREAM_PATH.test(url.pathname)
  ) {
    if (!MEDIA_STREAM_ENABLED) {
      return;
    }

    event.respondWith(mediaStreamResponse(event, url));
    return;
  }

  /*
   * Range requests are deliberately never intercepted.
   */
  if (request.headers.has('range')) {
    return;
  }
```

The `const url = new URL(request.url);` line moves up by six lines; the rest of the handler is untouched. Everything else the media route needs (the token, the key, the stream registry) lives behind `mediaStreamResponse()`.

### 9.3 The feature flag: default OFF, in `public/sw.js`

The flag is a **top-level constant in `public/sw.js`** (not in the bundle, not on the server):

```js
/*
 * MEDIA STREAM ROUTE (Item 3, phase 3C).
 *
 * OFF by default. Flipping this constant is the ONLY way to enable the
 * route, and it is a one-line change in a tracked file: the feature can
 * never be turned on by a server response, a query parameter or a stale
 * bundle. public/sw.js is excluded from the manifest
 * (scripts/build-sw-manifest.mjs:28), so flipping it does NOT invalidate
 * the shell cache - only the worker itself is replaced.
 */
const MEDIA_STREAM_ENABLED = false;
```

Why not a server flag: the server cannot reach into the worker, and a runtime flag would have to be delivered through a response the worker reads at startup. A build-time constant is auditable, revertible in one commit, and cannot be flipped by a compromised server.

How the page detects it (the page never guesses):

1. The page asks the controlling worker: `postMessage({ type: 'MEDIA_STREAM_STATUS' }, controllerOrigin)` over a `MessageChannel`.
2. The worker answers `{ type: 'MEDIA_STREAM_STATUS', enabled: MEDIA_STREAM_ENABLED, maxResponseChunks, readAheadChunks }`.
3. The page waits at most **1000 ms** for the answer. No answer, no controller, or `enabled === false` -> the page uses the **existing Blob path** (no behaviour change at all).
4. The answer is cached for the lifetime of the page. The page re-asks after a `controllerchange` (a new worker may have a different flag), and never on every media element.

If the worker is replaced while a stream is playing, the old worker's `controllerchange` fires (`public/js/core/pwa.js:41-74`); the page drops its stream registrations and falls back to the Blob path.

### 9.4 The stream URL shape, and `Sec-Fetch-Dest` vs `request.destination`

The URL (D4): `/__wire_media_stream/<streamId>` - same origin, path prefix that no server route owns.

- `<streamId>` is the 128-bit random id from Q4. It is the capability: an id that the SW does not know is answered **404**.
- **No token in the URL.** The media token lives in the worker's memory for that stream and is refreshed on demand (9.7). A token in the URL would end up in the DOM, in the element's `src`, and in the `Referer` of any sub-request. The server's media token is still used - just not through the URL: the worker fetches the ciphertext with `?token=<mediaToken>`, which is the only form `mediaAuth` accepts for media tokens (`middleware/mediaAuth.js:134-144`).
- The page sets `video.src = '/__wire_media_stream/' + streamId` after `REGISTER_STREAM` succeeded.

Destination checks (two signals, in this order):

1. **`request.destination`** - the canonical Fetch-standard value. For a `<video>`/`<audio>` element it is `video`/`audio`. The worker accepts only `video` and `audio`; anything else (`empty` for `fetch()`, `document`, `iframe`, ...) is refused with 404. This blocks a script from reading the decrypted bytes with `fetch()`.
2. **`Sec-Fetch-Dest`** - a secondary signal only. The header is not settable by page script, so it is a useful cross-check, but it is a header and the worker must not depend on it alone (and must not trust it over `request.destination`).

Both are checked; a mismatch is a 404. The worker does **not** parse the `Range` header of a non-media request (that stays untouched, `public/sw.js:307-309`).

### 9.5 Client binding (`clientId`)

- The worker records the client id from **`event.source.id`** at `REGISTER_STREAM` time - not from a page-supplied field. The page cannot choose its own client id that way; the browser tells the worker who is talking.
- The stream entry keeps that `clientId`. A later fetch for that stream is served only when `event.clientId` (or `event.resultingClientId`) equals the stored value.
- If `event.clientId` is empty, the worker **fails closed** with 404 rather than serving the stream. Rationale: an empty client id cannot be compared, and serving anyway would let a request that the browser could not attribute to a client read the plaintext.
- **UNVERIFIED:** whether Chromium populates `event.clientId` for a media-element request. This is the single riskiest unknown in 3C: if it is empty, the route can never serve anything and the feature is unusable in that browser. It must be measured first (a P5 browser test that reads `event.clientId` in a fetch handler), and the fallback (the Blob path) must be the answer for every browser where it is empty.

### 9.6 Per-client purge, not a global purge

- `PURGE_CLIENT { clientId }` from the page -> the worker deletes **only** the streams whose stored `clientId` matches. There is deliberately **no `PURGE_ALL`**: a global purge would kill playback in every other tab of the same user, and a tab closing must never stop another tab's stream.
- The page sends `PURGE_CLIENT` on logout and on `pagehide`/`beforeunload`.
- bfcache: on `pagehide` with `event.persisted === true` the page does **not** purge - the stream stays under its idle TTL so a restored page can reattach (Q3).
- The worker's idle TTL (10 minutes, Q9) is the backstop for a tab that dies without sending anything.
- The worker also purges a stream when the client is gone (`clients.get(id)` no longer resolves) **and** the idle TTL has passed - never before, so a bfcache-restored tab still finds its stream.

### 9.7 On-demand token refresh (pull model, no page timer)

Per Q3/D3 the worker never mints a token and never runs a timer for one:

1. The worker needs the ciphertext -> it looks up the stream's token and its `expiresAt`.
2. No token, or `Date.now() >= expiresAt` -> the worker posts `TOKEN_NEEDED { streamId }` to the registering client and **holds the fetch pending for up to 5 s**.
3. The page answers with `UPDATE_TOKEN { streamId, token, expiresAt }` (it mints it through the existing `.../media-token` route, `controllers/dm.controller.js:598-635`).
4. The token arrives within 5 s -> the fetch continues. It does not -> the request ends with **401** and the stream moves to `DEAD`; the player's error path falls back to the Blob path.
5. The page also sends a proactive `UPDATE_TOKEN` on `visibilitychange` when it becomes visible and the token expires within 10 s, so a returning tab does not hit the 5 s timeout.

The worker treats the token as opaque: it stores it and the `expiresAt` the page supplies; it never verifies it. The 90 s server TTL (`utils/jwt.js:118`) is unchanged.

### 9.8 Response policy for open-ended and very large ranges

The range module caps a response (`public/js/crypto/messages/attachment-range.js`): `ATTACHMENT_RANGE_MAX_RESPONSE_CHUNKS = 16` and `ATTACHMENT_RANGE_READ_AHEAD_CHUNKS = 8`.

- **A Range larger than the cap** (or an open-ended `bytes=N-`): the worker answers a **partial 206** - `Content-Range: bytes <served-start>-<served-end>/<total>` covers only the bytes it actually sent, and `Content-Length` is the served length. The media element asks for the rest. The worker never buffers the whole file.
- **The ciphertext is fetched with a Range request**, not in full: the plaintext chunk *k* lives at the ciphertext offset `8 + k * (65536 + 16)` (8 header bytes, then 64 KiB + a 16-byte tag per chunk, `public/js/crypto/messages/attachment-stream.js:43-52`). The worker maps the plaintext range to the ciphertext range, asks the server for exactly that, and decrypts only the chunks it needs. This is why the server's Range support matters, and why it is now pinned by tests (`tests/dm-attachments/dm-attachments-range-current.test.mjs`).
- **Backpressure**: the worker decrypts on demand, keeps at most the read-ahead (8 chunks ~ 512 KiB) in memory per stream, and never calls `caches.put` for a stream response. Plaintext never enters Cache Storage, IndexedDB or any persisted store (Q4).
- **Status codes**: 206 for a served range, 200 only when the request had no `Range` header at all, 404 for an unknown stream / wrong client / wrong destination, 401 for a missing or expired token, 416 for a range the worker cannot satisfy (with `Content-Range: bytes * /<total>`).

### 9.9 MIME allowlist, `nosniff`, sandbox

The MIME comes from the encrypted metadata, which the **sender** controls (`public/js/crypto/messages/attachment-stream.js:306`); nothing else validates it. The worker therefore enforces it at serve time:

- Serve the declared MIME only when it is `video/*` or `audio/*` **and** `isInlineSafeMime(mime)` is true (`utils/inlineSafeMime.js:16-55`). Otherwise serve `application/octet-stream`.
- Always send `X-Content-Type-Options: nosniff`.
- Always send `Content-Security-Policy: sandbox` on the media response, so even a mislabelled response cannot execute script.
- Always send `Cache-Control: no-store`.

### 9.10 CSP: the page's policy and the worker's own policy

The page's policy (`middleware/csp.js:38-52`) is `default-src 'self'; ...; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; ...`.

- The media element loads a **same-origin** URL, so `media-src 'self'` already allows it. **No CSP change is needed for the stream route.** (This is the correction D4 refers to: the directive that matters is `media-src`, not `connect-src`.)
- `blob:` stays in `media-src` for the existing Blob path.
- The **worker's own CSP** is the header on the `public/sw.js` response - the same policy, because `csp()` runs on every response. It governs the worker:
  - `script-src 'self'` allows the worker's `importScripts('/sw-media-bundle.js')` (same origin) - the bundle stays loadable.
  - `connect-src 'self'` allows the worker's ciphertext `fetch()` (same origin) and **forbids** it from fetching anything cross-origin - the worker has no use for that.
  - `worker-src 'self'` allows the registration (`public/js/core/pwa.js:129-132`).
  - No CSP change is required for 3C.
- **UNVERIFIED:** whether `Content-Security-Policy: sandbox` on a media response breaks playback in any browser (D8). It must be measured in P5; if it breaks playback, the alternative is to drop `sandbox` and rely on the MIME allowlist plus `nosniff` - a decision that needs the owner.

### 9.11 The plan for the `public/sw.js` header comment

The header (`public/sw.js:1-47`) currently states that the worker handles the shell and that it deliberately leaves untouched `/api/`, `uploads/downloads/media`, **all requests with a Range header** and everything else. In 3C exactly one of those statements becomes false, so the header must be updated **in the same commit as the fetch handler**:

1. "Handles" gains a bullet: the encrypted DM media stream route (`/__wire_media_stream/<id>`), only for `video/*` and `audio/*`, only for streams the worker knows, only for the client that registered it.
2. "Deliberately untouched" keeps `/api/`, `uploads/downloads/media` and the general Range rule, but the Range line gets the exception: "all requests with a Range header **except** the media stream route".
3. The header must keep saying that the worker never stores user data - with the addition that the media route holds plaintext **only in worker memory**, never in Cache Storage or IndexedDB (Q4, Q9).
4. The version paragraph gains: the media bundle is generated by `scripts/build-sw-media-bundle.mjs`, listed in `sw-manifest.js` and hash-verified at install time; the route is off unless `MEDIA_STREAM_ENABLED` says otherwise.

### 9.12 Failure table (3C)

| # | Situation | Worker | Client sees | Fallback |
|---|---|---|---|---|
| 1 | the flag is OFF (default) | the route is not installed; the request goes to the network and 404s at the server | the page never uses the stream URL (it asked, the answer was "off") | the Blob path (no change) |
| 2 | no controller / the worker is gone | nothing answers | the status query times out after 1000 ms | the Blob path |
| 3 | the worker was replaced (`controllerchange`) | the new worker has an empty stream registry | the page drops the registration and re-asks | the Blob path |
| 4 | unknown stream id | 404 | the player errors | the Blob path |
| 5 | the client id does not match (another tab, or an unattributable request) | 404 | the player errors | the Blob path |
| 6 | `request.destination` is not `video`/`audio` | 404 | a `fetch()` of the stream URL gets nothing | not applicable (a script must not read it) |
| 7 | the token is missing or expired and the page does not answer within 5 s | 401 | the player errors | the Blob path |
| 8 | the ciphertext fetch fails (server error, truncated file) | 500, or 401 if the size check fails | the player errors | the Blob path, which verifies the whole file |
| 9 | a chunk fails to authenticate (tampered ciphertext) | `AttachmentDecryptError` -> 500 | the player errors; **nothing is ever served unverified** | the Blob path (it verifies the whole file and fails too) |
| 10 | the requested range is not satisfiable | 416 with `Content-Range: bytes */<total>` | the player errors | the Blob path |
| 11 | the requested range is larger than the cap | a partial 206 with the served part only | the element asks for the rest | none needed |
| 12 | the MIME is not in the allowlist | 200/206 with `application/octet-stream`, `nosniff`, `sandbox` | playback fails (it is not a media type) | the Blob path |
| 13 | the worker is terminated by the browser | the stream is gone; the page re-registers on the next attempt | the player errors once | the Blob path |

### 9.13 UNVERIFIED for 3C

1. Whether Chromium populates `event.clientId` for a **media-element** request (the whole route depends on it; 9.5).
2. Whether `request.destination` is `video`/`audio` inside a fetch event in each target browser, and what `Sec-Fetch-Dest` carries there (9.4).
3. Whether `Content-Security-Policy: sandbox` on a media response breaks playback (9.10, D8).
4. Whether a media element accepts a **partial 206** (a `Content-Range` that covers less than the requested range) and then asks for the rest, in each browser (9.8). If a browser does not, the fallback is to answer the full range in several 206s, which needs a decision.
5. How a `<video>` element reacts to a `401` mid-stream (does it retry, or does it stop?) in each browser.
6. Safari/iOS: whether a service worker may serve a media element at all, and whether the media stack bypasses the service worker (Q7, D6).
7. The behaviour of the browser's media cache with `Cache-Control: no-store` on a 206 response.
8. Whether the browser keeps the connection open for a long 206 (the worker streams the decrypted bytes; a proxy timeout could cut it).
9. Nothing in this section was measured: **no 3C code exists**, no browser run was made for any of the statements above.