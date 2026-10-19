# Group attachments: E2EE design (STEP 3A) + crypto layer (STEP 3B)

Status: **design reviewed; crypto layer implemented in STEP 3B; the composer,
the upload and the thread rendering are implemented in STEP 3C, but the whole
UI stays behind `GROUP_ATTACHMENTS_UI_ENABLED`, which ships as FALSE.**

What is in place: the file bytes (iv, ciphertext hash, plaintext length) are
bound into the per-message ECDSA signature; the receive side refuses a file whose
bytes do not match what the sender signed; the server stores an opaque name and
neutral metadata; the composer can encrypt and sign a file and the thread can
render the decrypted bytes (an image inline, anything else as a download).

What is NOT in place: the feature flag is FALSE, so the group page shows no
attach button, no file input and no file paste/drop path. Flipping the flag to
true is an owner step, and it happens only after these browser tests have been
reviewed. The browser tests (tests/groups/group-attachment-browser.test.mjs)
PASSED on Windows with the system Chrome (the Linux Chromium package ships a
Linux binary and cannot run on Windows).

Base tree: `wire-final-33` (design), `wire-final-34` (STEP 3B implementation).
Every claim about current behaviour carries a `file:line` citation, re-checked
after the STEP 3B code changes.

## 3.1 Current state (with file:line citations)

### Signed message bytes today

The group message envelope (JSON string stored in `group_messages.content`,
opaque to the server) is:

| Field | Value | Source |
|---|---|---|
| `v` | `2` | `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md:134-136` |
| `alg` | `"AES-GCM"` | ibid |
| `senderKeyId` | 64 lowercase hex | ibid `:138` |
| `counter` | non-negative integer; equals last 8 bytes of the nonce | ibid `:139` |
| `iv` | base64 of 12-byte nonce (4 random prefix bytes + 8-byte big-endian counter) | ibid `:140`; `public/js/crypto/groups/message-crypto.js:33-50`; `public/js/crypto/groups/nonce-lock.js:19-35` |
| `ciphertext` | base64 of AES-256-GCM output (ciphertext + 16-byte tag) | design doc `:141` |
| `reply_to_id` | positive integer or `null`; **signed** | design doc `:142` |
| `sig` | base64 of raw 64-byte IEEE P1363 ECDSA signature | design doc `:143` |

Any envelope key named `att`, `attachment` or `attachments` is **refused** (treated
as unverified): group attachments are disabled and their bytes are not bound into
the signature (design doc `:145`; `public/js/crypto/groups/message-crypto.js:201,324-328`).

The **signed bytes** (`public/js/crypto/groups/signing.js:78-105`,
`encodeSignedBytes`), in order:

| # | Field | Encoding |
|---|---|---|
| 1 | label | text `"wire-group-msg-sig/v1"` |
| 2 | `groupId` | decimal text (group the message ARRIVED in) |
| 3 | `senderKeyId` | text |
| 4 | `counter` | decimal text |
| 5 | `iv` | raw bytes, exactly 12 |
| 6 | `ciphertext` | raw decoded bytes (never the base64 text, which is not canonical) |
| 7 | `reply_to_id` | decimal text, or a raw empty field for `null` |
| 8 | attachment slot | raw bytes, **empty today** (reserved) |

The signature is over the ciphertext: **encrypt, then sign**, verified **before**
anything is decrypted (design doc `:167`; `message-crypto.js:400-412`).

**AAD** (`message-crypto.js:72-79`):
- `messageAad(groupId, senderKeyId, counter, iv)` = `encodeFields("group-msg-v2", ...)` — binds the message text to group, key, counter, nonce.
- `attachmentAad(groupId, senderKeyId, counter, iv)` = `encodeFields("group-att-v2", ...)` — **distinct label**, so a message can never pass as a file or vice versa.

### What `encryptAttachmentForGroup` / `decryptAttachmentForGroup` do today

`public/js/crypto/messages/attachment-crypto.js:109-136`
`encryptAttachmentForGroup(groupId, fileBytes)`:
- Gets this device's own Sender Key for the group (`getMySenderKey`, line 81). Throws if none (line 83-85).
- Reserves the **next counter from the SAME per-Sender-Key sequence message text uses** (`reserveNextCounter`, line 92) — messages and attachments share one counter/nonce space per key.
- Derives the nonce via `nonceFromCounter(counter, getNoncePrefix())` (line 122): 4 random prefix bytes + 8-byte counter (the prefix is random per JS process, redrawn on lock/unlock — `nonce-lock.js:19-35`).
- Encrypts with AES-256-GCM under `mine.cryptoKey` (the Sender Key itself), with `additionalData: attachmentAad(...)` (line 99).
- Returns `{ivBase64, ciphertext}` — no per-file key, no key delivery, nothing bound into any signature.

`decryptAttachmentForGroup(groupId, ciphertext, ivBase64, senderKeyId, ref)` (lines 122-160):
- Reads the counter back out of the iv (`readNonce`, line 137), verifies `attachmentAad`, decrypts, then claims the nonce as `att:${ref}` (line 157). Missing key → `MissingSenderKeyError` (self-heal contract: background KDM drain + retry).

**Why weaker than the DM path:**
- DM attachments use a **random per-file key** generated per file (`public/js/crypto/messages/attachment-stream.js:93-98`, `generateAttachmentKeyMaterial`), delivered only inside the E2EE `attachment_meta` envelope; the server never sees it.
- Group attachments encrypt under the **shared Sender Key** with **no per-file key** and **no signature binding**. As design doc section 6.7 item 5 states (lines 277-281): "the attachment bytes themselves are only AEAD-protected under the Sender Key, so any member could forge a file 'from' the key's owner." That is the gap this design closes.

### What the server stores for a group file

`routes/groups.routes.js:81-88`: `POST /:groupId/upload` (authenticated, `requireGroupProtocol`, `uploadLimiter`, `groupUpload.single('file')`, then `sendMessageWithAttachmentHandler`).

`controllers/groups.controller.js:609-688` `sendMessageWithAttachmentHandler`:
- Requires `attachment_iv` (base64, validated line 642-645) — stored but **not** bound into anything signed.
- Stores `req.file.filename` (random server-generated name), `originalName` (client's, via `path.basename`), `req.file.size`, `mime` (client-supplied, default `application/octet-stream`), `replyToId`, `isVoiceMessage`, `width`, `height`, `attachmentIv` via `insertGroupMessageWithAttachment` (line 665-679).
- The uploaded bytes **are** the Sender-Key-encrypted ciphertext; mime/dimensions/voice flag come from the sender's client only, never sniffed server-side (line 637-638).
- `content` (caption) is limited to 90,000 chars (line 656); longer → 400.

`getAttachmentHandler` (lines 717-779): serves `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, range requests, membership-authorized (`requireMembership`, line 728).

**What the server cannot check:** it is zero-knowledge for content. It cannot prove the stored bytes are ciphertext, cannot read the plaintext, and `attachment_iv` is not bound into the signature or the message AAD — a stored `attachment_iv` alone authenticates nothing.

### What `C3-12` asserts and how it detects a call

`tests/groups/group-signing-messages.test.mjs:378-410`:
- Walks every file under `public/js`, reads its text, and records any file (other than `crypto/messages/attachment-crypto.js` itself) whose text matches `/encryptAttachmentForGroup/`.
- Asserts the hits list is empty: *"A client path now calls encryptAttachmentForGroup. Before group attachment SENDING is enabled, the attachment bytes (iv + ciphertext hash) MUST be bound into the message signature ... Do that first, then update this test."*
- Separately asserts `public/js/chat/group.js` has no `uploadUrl` and contains "group attachments aren't supported" (lines 397-399).
- It fails the moment any client module starts calling `encryptAttachmentForGroup` outside the signing-binding change.

### Whether any client module imports the group attachment helpers today

Grep of the repo confirms: in `public/js`, `encryptAttachmentForGroup` is **defined only in**
`public/js/crypto/messages/attachment-crypto.js:109`. No other `public/js` module imports or calls it. The only other references are in `tests/` (`tests/attachment-crypto.test.mjs:84,156,175,190`,
`tests/groups/group-hardening-f4-replay.test.mjs:209`, `tests/groups/group-senderkeyid.test.mjs:17,124`) and `docs/PORT_NOTES.md:13` — tests and docs, not client send paths. `C3-12` currently passes (zero hits in `public/js`).

## 3.2 The threat, stated concretely

For each attack: attacker, what they can do, what they gain, what happens today.

1. **A group member forges a file "from" another member.**
   Attacker: any group member holding Alice's Sender Key (KDMs are fan-out to all current members, design doc 3.3/6.2). They can produce AES-GCM ciphertext under Alice's key that authenticates as Alice's key — the encryption is symmetric. Today they can already forge message text as Alice (design doc 6.1); for files the same applies because `encryptAttachmentForGroup` uses the shared Sender Key with no signature over the file bytes (attachment-crypto.js:109-136). Gain: a file appears to originate from Alice.

2. **A member or the server serves file A's bytes under message B (splice).**
   Attacker: any member (holds the group Sender Key) or the server (stores rows). They take the attachment ciphertext/iv from row A and serve it as the file for message B. The attacker cannot edit message B's signed envelope, so message B's signed `att_ct_hash` is still the hash of file B's bytes. When the receiver downloads file A's bytes for message B and recomputes `SHA-256(iv || ciphertext)`, it does not match message B's signed `att_ct_hash` → `attachment-mismatch`, before any decryption and before any nonce is claimed. Gain: a file is attributed to a different message/sender.

3. **Replay of a valid file/message into another group or another row.**
   Attacker: member or server re-posts a stored encrypted attachment under a new message id, in the same group or a different one. Today: cross-group replay is blocked for message text because `groupId` is signed (signing.js:158-159). A file replayed into another group would fail signature verification because `groupId` is in the signed bytes; a file replayed into another row in the same group is caught by that row's signed `att_ct_hash` (attack 2). Gain: a file is duplicated or attributed where it was never sent.

4. **The server swaps the stored file bytes (ciphertext substitution) while leaving the message untouched.**
   Attacker: the server (or anyone with write access to `GROUP_UPLOAD_DIR`). It replaces the stored ciphertext blob for message B with different bytes of its choosing, leaving message B's envelope intact. The attacker cannot edit message B's signed envelope, so message B's signed `att_ct_hash` is still the hash of file B's bytes. When the receiver downloads the swapped bytes for message B and recomputes `SHA-256(iv || ciphertext)`, it does not match → `attachment-mismatch`, before any decryption and before any nonce is claimed. AES-GCM would also fail on the swapped bytes unless the attacker re-encrypted under the same Sender Key (which any member can do), so the signature-bound hash check is the real defence. Gain: file content is substituted while still attributed to the original sender.

5. **The server truncates or reorders chunks of a streamed file.**
   Today this attack **does not apply to groups as implemented**: group attachments use a **single** AES-256-GCM encryption over the whole file (attachment-crypto.js:125-133), not the DM stream container (`attachment-stream.js:43-45`, `WAT1` header + 64 KiB chunks). The GCM tag authenticates the entire ciphertext at once, so any truncation, reorder or bit-flip fails authentication — no chunk-level stream exists to attack. Note for STEP 3B: if groups later adopt the stream format, the stream's per-chunk authenticated index/final flag (attachment-stream.js:15-24) already covers this.

6. **Nonce/counter reuse: file encryption reuses a (key, nonce) pair that message encryption already used.**
   Today it **does not**: `encryptAttachmentForGroup` calls `reserveNextCounter(mine.senderKeyId)` (attachment-crypto.js:122), the **same monotonically increasing, durably-persisted-per-use counter sequence** that `encryptGroupMessage` uses (`message-crypto.js:111`). Every encryption under a given Sender Key — message text or attachment — gets a fresh counter, so each `(key, nonce)` pair is used once (nonce-lock.js:62-80: counter is read, persisted as `current+1`, and the lock released before encryption; nothing is ever handed the same value twice for a senderKeyId). The nonce itself is `4 random prefix bytes || 8-byte counter` (message-crypto.js:33-50, nonce-lock.js:19-27) — **not** "4 zero bytes"; the random prefix protects against counter rollback on a restored/cloned profile (nonce-lock.js:19-27). The design in 3.3 preserves this: one fresh counter per file, bound into the signature.

## 3.3 Proposed design

### What goes into the signature for a file

The reserved attachment slot (#8 in `encodeSignedBytes`, signing.js:103, today `new Uint8Array(0)` at message-crypto.js:159) is populated with a **domain-separated binding of the file bytes** (built by `buildAttachmentSlot`, `signing.js:138-148`):

```
attachment slot = SHA-256(iv || ciphertext)  ||  plaintext length (8-byte big-endian)
```

- `iv`: the 12-byte nonce used to encrypt the file (base64-decoded, canonical bytes).
- `ciphertext`: the raw AES-256-GCM output (ciphertext + 16-byte tag), decoded — never base64 text, matching rule #6 (signed bytes use decoded ciphertext, design doc :163).
- plaintext length: 8-byte big-endian.

**Important scope limit (C1):** the signature is verified on the message envelope, while the file ciphertext is downloaded separately. So the signature only proves what the sender *committed to* (`att_iv`, `att_ct_hash`, `att_len`) — it cannot by itself detect a tampered or swapped file. A swapped file is caught by a **second, explicit step on the downloaded bytes**: recompute `SHA-256(iv || ciphertext)` from the downloaded `iv` and `ciphertext`, compare it with the signed `att_ct_hash`, check the length, and only then call AES-GCM decrypt. That second step uses a **separate failure reason**: `attachment-mismatch` (fixed enum, never message content). `bad-signature` stays for a bad signature only.

Rationale: this is constant-size (40 bytes) regardless of file size, so the signed bytes stay bounded even for multi-megabyte files. Binding the **iv** prevents an attacker from presenting the same ciphertext under a different iv; binding the **ciphertext hash** prevents ciphertext substitution without the signing key; binding the **length** prevents truncation/append attacks. All are covered by the ECDSA signature, so only the device holding the Sender Key's signing private key can produce or alter them.

Alternative considered and rejected: signing the whole ciphertext. Rejected because the signed bytes would grow linearly with file size (a 50 MB file → 50 MB of signed bytes, re-hashed/re-signed on every send and re-verified on every receive). A digest is constant-cost.

### File key

**Keep the Sender Key as the file encryption key** (as `encryptAttachmentForGroup` already does, attachment-crypto.js:111-115), with the existing fresh per-file counter/nonce (line 92-93). Do **not** introduce a fresh random per-file key carried inside the envelope.

Comparison:
| Option | Cost | Protects | Chosen? |
|---|---|---|---|
| Per-file random key delivered inside the signed envelope | New key-generation, key-wrapping and envelope-delivery code path; a lost key = lost file with no recovery path (groups have no key backfill, design doc 5 / K-2/M-1) | Limits blast radius of one leaked Sender Key to one file | No — disproportionate for Phase C's threat model (Sender Key compromise is already accepted; see design doc 6.5) |
| Sender Key (existing), fresh per-file nonce | Zero new key machinery; reuses `reserveNextCounter` and `attachmentAad` already in place | Every `(key, nonce)` used once; no reuse between message text and attachments | **Yes** |

The Sender Key compromise is already an accepted limit of the group design (design doc 6.5: "Sender Keys still give no post-compromise security"); files inherit the same bound, which is honest rather than pretending a per-file key would restore forward secrecy it cannot provide.

### The envelope change

Fields **added** to a group message envelope when an attachment is present (all base64 except raw-binary-slot fields noted):
- `att_iv`: base64 of the 12-byte file nonce (canonical bytes; **the signed `att_iv` is the only authority** — the server-stored `attachment_iv` column is unsigned and is *not* trusted).
- `att_ct_hash`: base64 of `SHA-256(iv || ciphertext)` (decoded bytes).
- `att_len`: plaintext length as canonical decimal text.

**C2 - `attachment_iv` column is not trusted:** `groups.controller.js` stores `attachment_iv` from the multipart body, unsigned (`controllers/groups.controller.js:640-645`). The receiver must use the envelope's signed `att_iv`, and must treat a row whose `attachment_iv` column differs from the signed `att_iv` as `attachment-mismatch` (checked before decryption, before the nonce is claimed).

The **attachment slot** in `encodeSignedBytes` (signing.js:78-105, currently empty) becomes `SHA-256(iv || ciphertext) || length-BE-8` (raw bytes, ~40 bytes). `message-crypto.js:159` changes from `attachment: new Uint8Array(0)` to the computed slot; `decryptGroupMessageDetailed` verification (`message-crypto.js:407`) passes the same slot so a tampered file fails `verifyMessage` **before** decryption (message-crypto.js:400-412).

The envelope keeps `v: 2` (design doc :136). **The group protocol version does NOT change** — v2 was changed in place and is unreleased (design doc :115-117: "the group protocol version is still `v:2`. It was changed in place: the group protocol is unreleased, there is no v3 and no compatibility layer. Test groups created before Phase C must be recreated"). Evidence that in-place change still holds: sections 6.1, 6.8 (:290-292 "there is no migration code; test groups created before Phase C must be recreated") and 7.1 are all proposals/not-implemented; nothing in the tree introduces v3. So this design adds fields inside the existing v2 envelope, byte-identical for messages without attachments (attachment slot empty → same signed bytes as today for text-only messages; existing message rows stay readable).

### How the streaming format (`attachment-stream`) fits

It **does not** — group attachments do not use `attachment-stream.js` today (single AES-GCM, attachment-crypto.js:125-133). The file digest is computed over the **whole ciphertext** after encryption completes:
1. Sender encrypts file → `{iv, ciphertext}` (attachment-crypto.js:125-133).
2. Sender computes `SHA-256(iv || ciphertext)` and plaintext length.
3. Sender signs message with attachment slot = digest || length (encrypt, then sign — signing happens before decrypt on receive, design doc :167).
4. Receiver verifies signature first (before decrypting), then decrypts the file under `attachmentAad` and claims `att:${ref}` nonce (attachment-crypto.js:223).

A partial/interrupted download: the receiver holds incomplete ciphertext, GCM tag verification fails when it tries to decrypt, nothing is rendered — the row shows the per-row placeholder (3.5). No partial plaintext is ever returned (attachment-stream.js:220-221 philosophy; groups don't stream but the same fail-closed principle applies).

### Size and cost (estimate)

| Item | Estimate |
|---|---|
| Extra signed bytes per message with attachment | 40 bytes (32-byte SHA-256 + 8-byte length) |
| Extra bytes on the wire per file message | `att_iv` (~24 chars base64) + `att_ct_hash` (~44 chars) + `att_len` (~1-11 chars) ≈ 70-80 chars |
| Extra CPU per send | one SHA-256 over `iv || ciphertext` (~0.05 ms desktop for a 50 MB file, streaming) + the existing ECDSA sign (0.10 ms, design doc 7.1) |
| Extra CPU per receive | one ECDSA verify (0.19 ms) before decrypt; the SHA-256 is re-computed over the downloaded file bytes (not inside `verifyMessage`, which only sees the signed slot) |
| Extra storage per message row | none new (the ciphertext blob already stored; `att_*` fields ride in the JSON `content` envelope) |

**C4 - length field is not a second security layer.** The hash over `iv || ciphertext` already fixes the ciphertext length. `att_len` is kept only as a cheap early reject: before hashing, require `ciphertextLength === att_len + 16` (GCM tag). Do not describe `att_len` as the thing that prevents truncation — the digest does that.

These are estimates from primitive sizes (design doc 7.1 gives sign 0.10 ms / verify 0.19 ms); not measured on a phone.

### Interaction with key rotation and membership

- **File sent under a superseded Sender Key:** the old key row is retained (its root and `signPub` stay so history decrypts and verifies, design doc 6.3 rotation). A file sent under key K1 stays decryptable by anyone who holds K1's plaintext key material — which, for groups, is every current member at the time (KDM fan-out). A removed member no longer receives new KDMs (M-1, group-keys-contract.test.mjs:158-200) but can still decrypt files they already received (they hold the key) — accepted, same as message text.
- **Member who joins later:** no history backfill (by design, design doc 5 / K-2/M-1). They cannot decrypt files sent before they joined because they never received the Sender Key KDM for that epoch.
- **Removed member:** cannot drain new KDMs for the group (M-1 test, lines 194-199); remaining members rotate on removal (design doc 3.3/4, groups.controller.js:245), so future files are encrypted under a key the removed member does not hold.

## 3.4 Alternatives considered

| Alternative | What it costs | What it protects | Chosen? | Why / why not |
|---|---|---|---|---|
| Sign the **whole encrypted file** instead of a digest | Signed bytes grow with file size; re-sign/re-verify on every send/receive | Same as digest for integrity | **No** | Constant-size digest is strictly better for large files; security identical (hash is collision-resistant, and the hash input is the canonical decoded ciphertext) |
| **Per-file random key** carried inside the signed envelope | New key generation, wrapping, envelope delivery; lost key = lost file (no group key backfill) | Blast radius of a Sender Key compromise limited to one file | **No** | Sender Key compromise is already an accepted design limit (design doc 6.5); this adds machinery without restoring forward secrecy |
| Bind **only the ciphertext hash** (no iv, no length) | Smaller slot (32 bytes) | Ciphertext substitution | **No** | Without the iv, an attacker can re-present the same ciphertext under a different iv; without length, truncation/append is only caught at GCM-decrypt time, not at signature time |
| Bind **iv + hash + length** (chosen) | 40 bytes | Substitution, iv swap, truncation/append, all at signature time | **Yes** | Best cost/protection trade-off; constant size |

## 3.5 Failure behaviour

## 3.5 Failure behaviour

- **Signature verification fails** (`bad-signature`): the row renders a per-row placeholder (the same `content = 'Unable to decrypt'` pattern used for unverified messages today, design doc 6.5 and message-crypto.js:185-192 `UnverifiedMessageError`), **never a crash, never a thrown error that blocks the thread**. The signature is verified over the envelope **before** anything is decrypted and **before** the nonce is claimed (message-crypto.js:400-412), so a bad signature cannot burn a nonce or break rendering of the thread. `bad-signature` is for a bad signature only — it is **not** used for a file-bytes mismatch.
- **File-bytes mismatch** (`attachment-mismatch`, fixed enum, never message content): after the signature verifies, the receiver downloads the file and runs, in order: (1) check the row's `attachment_iv` column equals the signed `att_iv` (C2 — the server-stored column is unsigned and not trusted), (2) check `ciphertext.byteLength === att_len + 16` (GCM tag), (3) recompute `SHA-256(iv || ciphertext)` and compare with the signed `att_ct_hash` using a constant-time compare (C1). Any failure in (1)-(3) throws `UnverifiedMessageError('attachment-mismatch')` **before** decrypt and **before** the nonce is claimed. Only after all three pass does AES-GCM decrypt with `attachmentAad` happen, followed by claiming `att:${ref}`.
- **Other rows in the same thread:** still render. Each message is verified independently (K-2, group-keys-contract.test.mjs:88-156: unknown/missing/malformed senderKeyId handled per message; well-formed-but-unknown-key envelopes become placeholders, structurally invalid ones dropped). Attachment failures follow the same per-row contract.
- **Malformed envelope carrying attachment fields today:** `UnverifiedMessageError('attachment-not-bound')` (message-crypto.js:324-328), dropped per message; C3-4 (group-signing-messages.test.mjs:202-231) covers `att`, `attachment`, `attachments` fields. **The contract does not change**: C3 all-or-none fields (one or two of `att_iv`/`att_ct_hash`/`att_len` present, wrong base64, wrong byte lengths, or non-canonical `att_len`) are structurally malformed → plain `Error`, dropped per message exactly as today.

## 3.6 Test plan (written now, implemented in 3B)

| # | Attack (from 3.2) | Test name (suggested) | Layer | Exact expected outcome |
|---|---|---|---|---|
| 1 | Member forges file "from" another member | `group-attach-sign: forgery rejected` | node (real modules) | Mallory encrypts a file under Alice's Sender Key with Mallory's signing key; Bob's client rejects with `bad-signature` before decrypting; nonce unclaimed |
| 2 | Serve file A's bytes under message B (splice) | `group-attach-sign: splice rejected` | node | Message B's signed `att_ct_hash` is file B's hash; downloaded file A's bytes hash to a different value → `attachment-mismatch`, before decryption, nonce unclaimed |
| 3 | Replay file into another group / row | `group-attach-sign: cross-group replay rejected` | node | Signed `groupId` differs → `verifyMessage` false; same-group row replay caught by `att:${ref}` nonce seen-set (`ReplayedMessageError`) |
| 4 | Server swaps stored file bytes under message B (swap) | `group-attach-sign: ciphertext substitution rejected` | node | Stored ciphertext replaced; downloaded bytes hash does not match message B's signed `att_ct_hash` → `attachment-mismatch`, before decryption, nonce unclaimed |
| 5 | Truncate/reorder chunks | `group-attach-single-gcm: corruption rejected` | node (groups don't stream) | Single AES-GCM tag fails on any bit change; no partial plaintext (if groups later adopt `attachment-stream.js`, per-chunk index/final-flag already authenticated) |
| 6 | Nonce/counter reuse message↔attachment | `group-attach-nonce: no reuse` | node | Two files + one text under the same Sender Key → three distinct counters; `reserveNextCounter` never repeats (nonce-lock.js:62-80) |
| — | Positive control for each negative | `group-attach-sign: valid file accepted` | node | Honest send + receive: `verifyMessage` true, plaintext recovered, nonce claimed once, placeholder never shown |
| — | `C3-12` deliberately updated | `group-signing-messages: C3-12 still guards` | node (test file) | `C3-12` fails if any `public/js` client module calls `encryptAttachmentForGroup` outside `attachment-crypto.js`; passes after the signing-binding change is implemented and this test's exclusion list is updated deliberately |
| — | No plaintext on disk | `acceptance-no-plaintext.group-files` | real server | After a group file send, the file on disk under `GROUP_UPLOAD_DIR` contains only ciphertext (no plaintext substring), in the style of `tests/acceptance-no-plaintext.test.mjs` |

Every attack in 3.2 maps to at least one test above; each negative test has a positive control (the honest send/receive case).

## 3.7 What this does NOT give you

- **No forward secrecy:** Sender Keys are static-static; a leaked Sender Key decrypts all past and future files it encrypted (design doc 6.5). Files inherit this limit.
- **No first-contact identity pinning:** identity public keys come from the server with no pinning (design doc 6.7 item 3); a malicious server can substitute them at the account level. Signatures do not change that.
- **A member can still leak a file they legitimately received:** once decrypted, the file is under the member's control; the design authenticates origin, it does not enforce recipient behaviour (DRM is not possible client-side).
- **Metadata visible to the server:** who sent what, when, file size, ciphertext size, group membership, timestamps, message ids, ordering — all server-controlled or server-visible (design doc 6.5).
- **No availability protection:** the server can refuse service, drop KDMs, or delete messages (design doc 6.5).
- **No protection against a removed member decrypting files they already received:** they hold the key; rotation only protects *future* files.

## 3.8 Open questions for the owner

Decisions only the owner can make (do not decide here):
- **Size cap:** group file upload limit (DM uses `DM_UPLOAD_MAX_MB` default 50 MB; groups need their own cap, checked where? client `prepareUpload`, server multer, or both). A group upload cap **already exists**: `GROUP_UPLOAD_MAX_MB` (default 50) in `config/constants.js:144`, used by `config/multer.js` `groupUpload` (`config/multer.js:305-307`). Unlike DM (`config/multer.js:270-279` adds `dmCiphertextOverheadBytes`), the group cap adds no ciphertext-overhead allowance. The real owner question: is the cap meant for plaintext (then a file exactly at the cap is rejected, because ciphertext is 16 bytes longer) or for ciphertext? Report it; do not change `config/` in this step.
- **Voice messages included?** `is_voice_message` already exists in the group attachment controller (groups.controller.js:662); decide whether voice recordings flow through the same attachment path.
- **Group files are one single AES-GCM operation held fully in memory (no streaming).** There is no chunked stream for groups (see 3.2 attack 5), so a file at the cap is held entirely in memory at decrypt time — roughly twice its size in peak memory (the GCM plaintext buffer plus the output). Note the memory cost at the cap.
- **Old test groups recreated?** The group protocol v2 was changed in place (design doc :115-117); pre-Phase-C test groups must be recreated — confirm this is acceptable for the test suite.
- **Version label change?** The design keeps `v: 2` (changed in place, unreleased). Confirm the owner does not want a `v: 3` for the attachment binding (would break all unreleased v2 clients and require a compatibility layer).
- **Voice-file size/duration limits:** no maximum voice-recording duration exists today for DMs (DM_ATTACHMENTS_E2EE.md:76); decide if groups need one.

## 3C: file metadata and what the server sees

STEP 3C wires the composer, the upload and the thread rendering. The group
protocol stays `v:2`; the file bytes are bound into the signature exactly as in
3B. What changes is WHERE the file's metadata lives.

### What the server sees for a group file

| Server field | Value |
|---|---|
| `attachment_path` (on disk) | an opaque random name (no extension) |
| `attachment_name` (the row) | the constant `encrypted-attachment` |
| `attachment_mime` (the row) | the constant `application/octet-stream` |
| `attachment_width` / `attachment_height` | `NULL` |
| `is_voice_message` | `0` (voice is out of scope in 3C) |
| `attachment_size` | the CIPHERTEXT size (plaintext + 16-byte GCM tag) |
| `attachment_iv` | the file nonce, base64 (and it is UNSIGNED server-side: the signed `att_iv` in the envelope is the authority, see C2) |
| `content` | the signed `v:2` envelope (opaque) |

Nothing else. The client's real file name, mime type, dimensions and voice
flag are **never** sent to the server.

### Where the real metadata lives

Inside the **encrypted message plaintext**. The discriminator is the SIGNED
envelope, so there is no ambiguity to resolve:

- The verified envelope HAS `att_iv` / `att_ct_hash` / `att_len` (they are in
  the signed slot) -> the plaintext is a JSON object:

  ```json
  {"v":1,"text":"<caption>","file":{"name":"photo.png","mime":"image/png","w":800,"h":600}}
  ```

- The verified envelope has NO `att_*` fields -> the plaintext is the plain
  text, exactly as today. A text message that merely *looks* like JSON stays
  text: without the signed `att_*` fields the receiver never tries to parse it.

Limits the client enforces and the receiver re-checks:
- `v` must be exactly `1`; an unknown `v` is rejected.
- `name` at most 255 characters, `mime` at most 127 characters.
- `w` / `h` are positive integers at most 20000, or absent.
- No key other than `v`, `text` and `file` is allowed; a key inside `file`
  other than `name`, `mime`, `w`, `h` is rejected. An unknown key is a
  malformed meta object, not something to ignore.

### Receiver sanitising rules (testable statements)

1. The file name is only ever written with `textContent` (never `innerHTML`).
2. Path separators (`/`, `\`) and control characters (U+0000-U+001F,
   U+007F) and bidi/override characters (U+202A-U+202E, U+2066-U+2069) are
   stripped from the name.
3. If the sanitised name is empty, it becomes the literal `file`.
4. Inline rendering is allowed ONLY for `image/png`, `image/jpeg`, `image/gif`
   and `image/webp` - and only after the **decrypted bytes** were sniffed to
   match that type. The declared `mime` alone is never enough.
5. Everything else is a download served as `application/octet-stream`, with the
   sanitised name.
6. SVG is NEVER rendered inline (it can carry script), whatever the mime says.

### The caption limit and the 90,000-character server limit

The server still refuses a `content` longer than 90,000 characters
(`controllers/groups.controller.js`, `sendMessageWithAttachmentHandler`), and
the envelope is a JSON string whose `ciphertext` is the base64 of
`plaintext bytes + 16` bytes of GCM tag, so it is about `4/3` of the plaintext
plus a fixed envelope overhead (~250 characters).

- The plaintext JSON wrapper (version, caption, name, mime, width, height)
  costs about 440 bytes with the maximum name and mime.
- `4/3 x (plaintext + 16) + 250 <= 90000` leaves about 67,300 plaintext bytes.

The client therefore enforces a caption of at most **60,000 characters**
(`MAX_GROUP_ATTACHMENT_CAPTION`), which leaves a wide margin
(`4/3 x 60,440 + 250 = 80,836` characters, well under 90,000).

---

## Doc consistency

- `docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md`: section 6.7 item 5 and proposal 23 each gained one sentence pointing to `docs/GROUP_ATTACHMENTS_E2EE.md`; nothing else rewritten.
- `docs/e2ee-dm-hardening.md` section 3.5: the "NOT done" line about group attachments now points to `docs/GROUP_ATTACHMENTS_E2EE.md` and says "design written, not implemented".
- `docs/PORT_NOTES.md` and `docs/DM_V2_WIRE.md`: intentionally untouched (out of scope for this design step).
