# Group E2EE: multi-device Sender Key design

Status: implemented on branch `fix/group-e2ee-hardening` (not merged).
Tests: `tests/groups/group-multidevice.test.mjs` (MD-1..MD-6),
`group-audit.test.mjs` (F-I, G), `group-keys-contract.test.mjs` (L-1).

Sections 1 to 5 describe the multi-device change and are kept as history (section 1 is the
**pre-change** protocol). Per-message signatures (Phase C) are section 6, proposals section 7.

## 1. Current (pre-change) protocol

| Item | Value |
|---|---|
| Message envelope | `{v:1, alg:"AES-GCM", senderKeyId, counter, iv, ciphertext}`; nonce = 4 zero bytes + 8-byte counter |
| senderKeyId | `hex(SHA-256("group:<groupId>:<ownerUserId>:<epoch>"))` |
| KDM (`group_key_distributions.wrapped_key`) | `{v:1, alg:"AES-GCM", iv, ciphertext}` wrapping the raw 32-byte key under the pairwise DM session key |
| KDM row | `(group_id, from_user_id, to_user_id, wrapped_key, epoch, delivered_at)`; no device column (delivery is tracked per device in `group_kdm_receipts`, see 3.4) |
| Recipient id derivation | from the KDM row's `(group_id, from_user_id, epoch)` |
| Identity model | identity keypair is per **account**, restored on every device; **no device id exists** |
| Mailbox | per user; `delivered_at` set once by whichever device acks first |
| Local role flag | `isMine` = "KDM owner is my account" (so a self-KDM copy became a sending key) |
| Counters | per device (IndexedDB, Web Lock), keyed by senderKeyId |

## 2. Failure scenario (all reproduced with real server + Socket.IO + client)

1. Alice's device 1 creates a key K1 for epoch E. id = H(g:alice:E).
2. Alice's device 2 has no key, so it creates K2 for the same epoch. **Same id.**
3. Bob receives K2's KDM and overwrites K1 under that id (put-by-id).
   Every message device 1 sent under K1 now fails authentication (MD-2).
4. Device 1 receives the self-KDM and adopts K2 while keeping its own counters.
   Both devices now encrypt under K2 with independent counters starting at 0:
   **(key, nonce) reuse** (MD-3 recovers `c1 XOR c2 == p1 XOR p2` from the DB).
5. Separately, the mailbox is consumed once per account: a device that signs
   in after another device drained Bob's KDM never gets Bob's key (MD-4).
6. Also: a failed KDM POST left an undistributed key as "current" (MD-6);
   two tabs both minting a first key (MD-5).

## 3. Minimum protocol change (implemented)

1. **senderKeyId = HMAC-SHA-256(key, "wire-sender-key-id/v2|group|owner|epoch")**.
   A PRF of the key, so distinct keys get distinct ids, and the id reveals
   nothing about the key. Recipients compute it after unwrapping; nothing new
   is transmitted. Envelope format unchanged.
2. **KDM `v:2`** (inside the opaque `wrapped_key`; server never parses it).
   Plaintext unchanged. `v:1` KDMs are still accepted and use the legacy id.
3. **Sending keys are device-local.** Received keys, including self-KDMs, are
   stored `isMine:0` (decrypt-only). Only records with `scheme:2` are eligible
   for sending; legacy records never are.
4. **Per-device mailbox receipts.** New table `group_kdm_receipts(kdm_id, device_id)`. Clients send an optional `device_id` (random, per browser
   profile) on drain and ack. Requests without it behave as before.
5. Client hardening: cross-tab Web Lock around key creation; discard a key
   whose KDM POST failed; a received key never overwrites a different key
   stored under the same id.
6. Server hardening: drain only returns KDMs for groups the caller is still
   in; removal purges the removed user's KDMs and evicts their sockets from
   `group:<id>`.

## 4. Compatibility and migration

* Old clients cannot parse `v:2` KDMs. They never ack what they cannot
  parse, and since F7 the server answers every KDM / message endpoint with
  `426 {code:"update_required", min_group_protocol:2}` unless the client
  declares `X-Wire-Group-Proto: 2` (`middleware/groupProtocol.js`,
  `core/api.js`). Group management endpoints stay reachable.
* Existing keys stay readable. Legacy own keys are never used to send again, so
  each group re-keys once per device after upgrade.
* Data already lost to a legacy id collision is **not** repaired.
* Every connected device of a member rotates on a membership change (key
  count grows with device count: members x devices KDM rows per event; set a
  group-size cap before large groups).
* Hardening added on this branch: the sending key is persisted only after the
  KDM POST returned 201 (F1); the KDM insert re-checks sender membership,
  recipient membership and epoch inside its transaction, stale epoch -> 409
  (F5); `device_id` is validated (400), registered per user in `group_devices`
  (cap 20, 10 new ids/hour, least recently seen evicted with its receipts) and
  stale devices/orphan receipts are pruned (F6).

## 5. Known limits (unchanged, out of scope)

* ~~No per-message sender authentication~~ **Resolved in Phase C**: every
  message is signed per Sender Key, see section 6 (known limitations: 6.7).
* ~~KDM rows carry no AAD binding group/sender/epoch yet~~ **Resolved**: the KDM
  AAD binds group, sender, recipient, epoch and version (6.2).
* One X25519 identity per account, restored on every device: no forward secrecy
  on key distribution, one browser cannot be revoked, KDMs are unsigned.
* Account password (F12, login scheme 2): one password, two independent secrets.
  PBKDF2-SHA-256 (600,000 iterations, per-account salt) turns the password into a
  master key; HKDF splits it into an auth key (sent to the server, which stores only
  a bcrypt hash of it) and a wrap key (never leaves the browser; wraps the identity
  key). The server never sees the password. New passwords must be at least 12
  characters (enforced in the browser, not at login, so existing accounts can still
  sign in). Accounts not yet migrated still use the legacy raw-password login until
  they sign in once, or until an admin closes that login.
* Replay protection (F4) is a per-sender-key seen-set in the browser's IndexedDB with
  a SOFT cap of 100,000 rows per key: pruning is only attempted after a new claim
  and then for 1 in 64 of them, so a key can overshoot the cap by a few dozen rows.
  A prune deletes the oldest rows ordered by (claim time, counter) down to about
  90,000. The counter breaks ties when a device claims a synced history in one burst.
  Replay window at eviction: a hostile server can re-post the stored ciphertext of
  an EVICTED nonce under a fresh message id, and it is accepted once as new. Rows
  among the newest ~90,000 of a key are never affected, and eviction never rejects a
  legitimate message. In practice the window is about 90,000 messages by one sender
  key (months to years in an ordinary group, weeks in a very chatty bot group). A
  per-prefix high-water mark would close most of it; it is not implemented.
* No history backfill for a newly added member (by design).



## 6. Per-message sender authentication (Phase C)

Status: implemented in Phase C (sub-steps C1 to C4), tests listed in 6.9. This section
supersedes the first bullet of section 5 ("No per-message sender authentication") and the
bullet about KDM rows without AAD (the KDM has been AAD-bound since F2, see 6.2).

**Wire format change.** The group protocol version is still `v:2`. It was **changed in place**:
the group protocol is unreleased, there is no v3 and no compatibility layer. Test groups created
before Phase C must be **recreated** (see 6.8).

### 6.1 What it adds

AES-GCM under a Sender Key is symmetric: every member who holds Alice's Sender Key can produce
a ciphertext that authenticates as "Alice's key". Phase C gives every Sender Key its own **ECDSA
P-256 / SHA-256 signing key pair** (WebCrypto only). Every group message is signed with the private
key of the Sender Key it is encrypted under; a receiver accepts a message only if the signature
verifies under the public key that arrived in a KDM unwrapped under the pairwise key of the claimed
sender. A message is attributed to the **owner of the verified key**, never to the server's `sender_id`.
Nothing about the account-level identity model changes. Each device has its own Sender Key and
therefore its own signing key; nothing signing-related is shared between devices.

### 6.2 Wire format

**Message envelope** (JSON string stored in `group_messages.content`; the server treats it as opaque):

| Field | Value |
|---|---|
| `v` | `2` |
| `alg` | `"AES-GCM"` |
| `senderKeyId` | 64 lowercase hex characters (see "Sender Key id" below) |
| `counter` | non-negative integer; must equal the last 8 bytes of the nonce |
| `iv` | base64 of the 12-byte nonce: 4-byte random per-process prefix, then the 8-byte big-endian counter |
| `ciphertext` | base64 of the AES-256-GCM output (ciphertext and 16-byte tag) |
| `reply_to_id` | **new**: positive integer or `null`; signed |
| `sig` | **new**: base64 of the raw 64-byte IEEE P1363 ECDSA signature (r then s) |

Any envelope key named `att`, `attachment` or `attachments` is refused (unverified): group attachments
are disabled and their bytes are not bound into the signature (see 6.7, item 5).

**AES-GCM additional data of a message**: `encodeFields("group-msg-v2", groupId, senderKeyId, counter, iv)`.

**`encodeFields`** (`public/js/crypto/groups/codec.js`): every field is written as
`1 type byte (0 = UTF-8 text, 1 = raw bytes) | 4-byte big-endian length | data`; numbers are their decimal text.
No two different field lists encode to the same bytes (property-tested in `group-signing.test.mjs`).

**Signed bytes** (`public/js/crypto/groups/signing.js`, `encodeSignedBytes`), in this order:

| # | Field | Encoding |
|---|---|---|
| 1 | label | text `"wire-group-msg-sig/v1"` (domain separation) |
| 2 | `groupId` | decimal text (the group the message ARRIVED in) |
| 3 | `senderKeyId` | text |
| 4 | `counter` | decimal text |
| 5 | `iv` | raw bytes, exactly 12 |
| 6 | `ciphertext` | raw bytes, **decoded** (never the base64 text, which is not canonical) |
| 7 | `reply_to_id` | decimal text, or a raw empty field for `null` (the two cannot collide) |
| 8 | attachment slot | raw bytes, **empty today** (reserved) |

The signature is over the ciphertext (encrypt, then sign) so it is verified **before** anything is decrypted.
ECDSA signatures are malleable (`(r, n-s)` also verifies; no low-S rule). That cannot create a second accepted
message because acceptance is keyed by `(senderKeyId, full 12-byte nonce)` in the seen-set (tested in
`group-signing.test.mjs`).

**KDM** (`group_key_distributions.wrapped_key`): JSON `{v:2, alg:"AES-GCM", iv, ciphertext}`.
The **plaintext is 97 bytes**: the 32-byte root key, then the 65-byte raw uncompressed signing public key
(`0x04 || X || Y`), wrapped under the pairwise DM session key.
AES-GCM additional data: `encodeFields("group-kdm-v2", groupId, fromUserId, toUserId, epoch, 2)`; the public key sits inside the
authenticated plaintext, so the GCM tag covers it. Any other plaintext length (a 32-byte plaintext is the
pre-signing format), a first point byte other than `0x04`, or a point that is not on the curve is rejected
(`KdmFormatError`; `LegacyKdmError` for the old format) before anything is stored.

**Sender Key id** (`sender-key-id.js`): `encKey = HKDF(root, "Wire-GroupKey-enc-v2")`,
`idKey = HKDF(root, "Wire-GroupKey-id-v2")`, and
`senderKeyId = hex(HMAC-SHA-256(idKey, encodeFields("group-sender-key-id-v2", groupId, ownerUserId, epoch, signPub)))`.
The id **commits to `signPub`**: the message AAD and the signed bytes both carry the id, so ciphertext and signature
are bound to this exact key pair; a second KDM with the same root and another signing key gets another id and can
never alias or overwrite an existing key; and a stored row whose `signPub`, owner, epoch or group was altered no longer
re-derives to its own id (checked on every load; the row is then unusable and its messages stay unverified).

**Local storage** (IndexedDB `wire-group-crypto`, store `sender-keys`, one record per key): the existing fields plus
`signPub` (base64, 65 bytes, every row) and, **only on keys generated on this device**, `signKeyWrapped {iv, ciphertext}`:
the PKCS#8 signing private key (138 bytes) under the local wrap key with additional data
`encodeFields("group-sig-priv-v1", senderKeyId, ownerUserId)`, written in the **same put** as the root, after the
KDM POST returned 201. A received key never has a signing private key.

### 6.3 Key lifecycle

* **Generation.** The private key is generated extractable only to be exported once (PKCS#8) and wrapped; the key
  used afterwards is a **non-extractable** re-import; every temporary buffer is zeroed (KDM plaintexts too).
* **Receipt.** `receiveKdm` unwraps under the pairwise key of the row's `from_user_id`, validates the structure,
  derives the id from `(group, from_user_id, epoch, root, signPub)` and only then stores. The **owner is the sender
  proven by the unwrap**, never a field the server can relabel. The owner, group, epoch and `signPub` of a stored id are
  immutable (`SenderKeyConflictError`).
* **Rotation.** A new Sender Key means a new pair. The superseded **own private signing key** is dropped only after the new
  key is durably stored, after the KDM POST returned 201, under the same sender-key lock; the old row keeps its root and
  public key so its history still decrypts and verifies. A failed or crashed rotation leaves the old key usable; a send that
  already holds the old signing key still signs. Non-deferred generation never drops anything; the next successful rotation
  does.
* **Sending** requires an own row (`isMine`) with a signing key that matches its public key. A row without one (a
  pre-signing row) is unusable for sending and the next ensure re-keys.
* **Second device.** It stores the other device's root and `signPub` verify-only and never obtains a private signing key.
* **Lock / logout.** `lockIdentity` clears every cached key, the signing keys included.

### 6.4 Receive order (`groups/message-crypto.js`, `decryptGroupMessageDetailed`)

1. Parse the envelope; check version, `senderKeyId`, counter and nonce shape (a malformed envelope throws a plain error and is
   dropped per message).
2. Refuse unexpected attachment fields; require a 64-byte `sig` and a `reply_to_id` that is `null` or a positive integer.
3. Load the key. No row: "waiting for key" (the only retried state). A row that cannot verify (no `signPub`, invalid
   key, id mismatch): **permanently unverified**.
4. **Verify the signature** (this is before decrypting and before claiming the nonce).
5. The verified owner must equal the server's `sender_id`; the signed `reply_to_id` is authoritative: a non-null server value
   that differs is a swap, a null server value with a signed target is allowed (deleted, or in another group where the server drops it).
   Both checks run **before** the claim so a re-post cannot burn the genuine message's nonce.
6. AES-GCM decrypt (additional data above).
7. Claim `(senderKeyId, nonce)` in the seen-set (`new`, `same` for the same message id, or `conflict`).

The client then builds the reply quote from the **signed** id, only from a server row that really is that message
(otherwise "Original message deleted"); the quoted message is verified like any message and its verified owner must equal the
user the server names as its author.

### 6.5 What the user sees

* Unverified message: nothing from it is rendered. A static placeholder (`⚠️ Message could not be verified`, built only from
  a CSS class, no interpolated data). It is **permanent**: never retried after a KDM drain or reconnect. Bulk history shows it
  in place (ids and order kept); a history fetch logs one aggregated console line.
* Unverified quote: the static label `⚠️ Unverified message`.
* Key not arrived: unchanged, `🔒 Waiting for encryption key…`, retried after a KDM drain.

### 6.6 Threat model

**The signature prevents:**

* a member who holds another member's Sender Key forging messages as that member (the forger cannot sign as the owner);
* the server relabelling the author of a message (`sender_id` is checked against the verified key's owner; a member re-posting
  someone else's signed message as his own is refused);
* key substitution in transit: the signing public key travels inside the AEAD of the KDM, bound to group, sender, recipient and
  epoch, and committed by the key id, so the server and third members cannot swap it; ownership follows the pairwise unwrap;
* cross-group replay of a valid envelope (the group id and the key id are signed);
* reply-target swaps (the target is signed; the server may only agree or drop it).

**It does NOT prevent or protect:**

* metadata: who talks to whom, when, message sizes, the membership list, timestamps, message ids and ordering (all server-controlled);
* deletion or omission: the server can delete messages or withhold them; a thread can be rewritten by omission (no history
  integrity, no gap detection);
* reactions, edits of server-side columns, and every other server column (they are not signed);
* availability: the server can refuse service or drop KDMs;
* confidentiality changes: Sender Keys still give no post-compromise security and no per-message forward secrecy; the signature adds
  authentication, not secrecy;
* identity-key attacks (see 6.7).

### 6.7 Known limitations

1. **Replay window at seen-set eviction.** After the soft cap evicted a nonce (about 90,000 messages by one key), a hostile
   **server** that re-posts the stored message under the **original** `sender_id` is accepted once; the same replay by a **member**
   under his own `sender_id` is rejected because the verified owner differs. Pinned by **C4-2**
   (`tests/groups/group-signing-adversarial.test.mjs`, named "KNOWN, ACCEPTED LIMITATION"). Scheduled rotation (7.1) would make
   the window unreachable.
2. **No epoch or membership cut-off on receive.** The client accepts any known key id whatever its epoch, so a message validly signed by a
   **removed member's own old key** is attributed to **her** (never to anyone else, never as a member's message). The server is the
   membership gate. A message signed late by a superseded key whose signing handle was still in memory (an in-flight send) is
   accepted. Pinned by **C4-5** and **C4-7** (same file); proposal in 7.2.
3. **No identity pinning, no fingerprints.** `keys/peer-keys.js` fetches peer identity public keys from the server with no pinning
   or safety number. A malicious server can still substitute identity public keys (and so read and forge at the account level);
   the signatures do not change that. Proposal in 7.4.
4. **Leaked passwords leak the identity.** The identity key is wrapped under the password-derived key and stored server-side
   (login scheme 2); anyone with the password and the wrapped blob recovers the identity and can then act as the account. Accepted.
5. **Group attachments are disabled and must bind their bytes into the signature before they are ever enabled.** The envelope
   has a reserved, empty attachment slot in the signed bytes; an envelope carrying attachment fields is refused; the attachment
   bytes themselves are only AEAD-protected under the Sender Key, so any member could forge a file "from" the key's owner. Pinned
   by **C3-12** (`tests/groups/group-signing-messages.test.mjs`), which fails if any client module starts calling
   `encryptAttachmentForGroup` and says what must be done first. The binding design is specified in
   `docs/GROUP_ATTACHMENTS_E2EE.md` (design only; not implemented in this step).
6. **A hostile role through a hostile members API is not covered.** The real-Chromium test
   (`tests/groups/group-hostile-browser.test.mjs`) edits the database, where `group_members.role` is schema-constrained to
   `owner`/`admin`/`member`, so a hostile role cannot be stored and was not exercised; a server that answers the members API
   with a hostile role is not covered.
7. Also by design: a structurally **malformed** envelope is dropped per message (nothing rendered, existing contract
   `K-2` in `group-keys-contract.test.mjs`); only a well-formed envelope that fails verification gets the placeholder. The bulk fetch
   omits "waiting for key" messages, as before.

### 6.8 Compatibility and migration

v2 changed in place and is unreleased: **there is no migration code; test groups created before Phase C must be recreated.**
What happens to old data, so nothing is surprising:

* Old messages have no `sig`: unverified placeholders.
* Old KDMs (32-byte plaintext) are never consumed and **never acked**; a drain logs **one** console line summarising them.
* A received row without `signPub` is kept but unusable: its messages are permanently unverified (not an endless "waiting for key"),
  one console line per key id per session.
* An own row without a signing key is unusable for sending; the next send re-keys.
* The server is unchanged and opaque to the new fields (`wrapped_key` and `content` are opaque strings).

### 6.9 Tests

| Area | Tests |
|---|---|
| Primitive (C1) | `group-signing.test.mjs` (round trip, every field tampered, wrong key, unambiguous encoding property test, malformed public keys, malleability + seen-set) |
| Key lifecycle (C2) | `group-signing-keys.test.mjs` (C2-1 .. C2-20: non-extractable cache, zeroed buffers, wrapped storage and AAD, KDM structure, claimed-sender check, immutable owner, rotation fault injection, second device, lock), `group-signing-ensure.test.mjs` (E-1 .. E-6: ensure, drain logging) |
| Sign / verify (C3) | `group-signing-messages.test.mjs` (C3-1 .. C3-12), `group-signing-ui.test.mjs` (UI-1 .. UI-8) |
| Adversarial (C4) | `group-signing-adversarial.test.mjs` (C4-1 .. C4-8), `group-signing-adversarial-ui.test.mjs` (C4-9 .. C4-13), `group-hostile-browser.test.mjs` (real Chromium) |
| End to end (C2) | `group-e2e-browser.test.mjs` (real Chromium, three accounts, the whole group lifecycle) |

## 7. Proposals (NOT implemented)

### 7.1 Scheduled Sender Key rotation

**What.** A device re-keys its own Sender Key (same epoch) when it has sent N messages with it **or** the key is a few days old,
whichever comes first: checked at send time inside the existing ensure lock (the same path as today's re-key; selection of the live
key by `(epoch, createdAt)` and the "drop the superseded private signing key after the 201" rule already exist).
Suggested start: N = 1,000 and 7 days.

**Why.** (a) It bounds the exposure of one leaked device key. (b) It bounds every key's seen-set to N rows, so with N well below the
90,000-row soft cap the eviction window of 6.7 item 1 becomes unreachable. (c) It bounds counters and the work of a "catch up" sync.

**Cost** (estimates from the sizes in 6.2 and Node timings of the primitives: sign 0.10 ms, verify 0.19 ms, public-key import 0.09 ms;
not measured on a phone):

| Item | One rotation by one device, 20 members | A membership change today, 20 members x 3 devices |
|---|---|---|
| KDM rows posted | 20 (one per member account) | 60 devices x 20 = 1,200 |
| Size of one `wrapped_key` | about 215 bytes of JSON (97 + 16 tag = 113 bytes, 152 base64 chars) | same |
| Posted bytes | about 4.3 KB | about 260 KB |
| Rows read per recipient device | 1 | 60 (one per sender device) |
| Client work per received KDM | one unwrap, HKDF, id derivation, public-key import: well under a millisecond on a desktop | x 60 |

A scheduled rotation is therefore two orders of magnitude cheaper than a membership change; the first send after it waits one
round trip (the KDM POST). **Risks:** more mailbox rows and receipts to prune; a rotation that races a send (covered by the existing
lock and by `getMySenderKey` re-selecting); chatty bot groups rotate often (N is per key, tune it); the server's KDM rate limits must
allow the burst when all devices cross the age threshold together (add jitter).

### 7.2 Receive-side epoch cut-off

**What.** Refuse (or mark) a message whose key epoch is older than the epoch in which it was posted.

**Why it is weaker than it looks.** The epoch change time and the group membership come from the **server**: a hostile server can
simply lie about them, so a cut-off only helps against a server that is honest but buggy, or an attacker who can post but not edit the
server's records. The signature already makes such a message attributable to its true author (6.7 item 2).

**Risks.** Late delivery: a device that was offline, or an in-flight send during a rotation, legitimately sends under the previous
epoch; a hard reject would lose real messages. Multi-device skew: a device that has not yet rotated keeps sending under the old epoch for
a while. Clock and ordering assumptions between server time and message ids.

**Suggested shape if wanted.** Do not reject: accept within a grace of one epoch, and **mark** older messages ("sent from a
previous membership") so the user sees them as such; for a sender who is no longer a member show "former member". Put the epoch into the signed
bytes only if the receive rule needs it (the key id already commits to the epoch).

### 7.3 Changes to the `group-e2ee-sender-keys` skill

Proposed text changes (not applied; the skill is outside this repository). Statements the code already contradicts are marked **stale**.

```diff
 ## Core idea in 6 lines
+7. Every Sender Key also has its own ECDSA P-256 signing key pair; every message is signed (encrypt, then sign) and the public key
+   travels in the KDM. Receivers verify before decrypting.

 ## Trust and threat model (state this honestly to users)
-Does NOT give: per-message sender authentication (anyone holding a sender's key can forge under it; attribution relies on server `sender_id`), ...
+Gives: per-message sender authentication (a member holding another's Sender Key cannot sign as him; attribution = owner of the verified key and
+it must equal the server's sender_id). Does NOT give: metadata protection, deletion or omission protection, post-compromise security, per-message forward
+secrecy, protection if the server swaps a user's identity public key (no pinning or safety numbers unless added), a receive-side epoch cut-off.
-KDM rows have no AAD binding group/sender/epoch; a relabelled KDM yields an id no envelope references (DoS only).   (stale: KDMs are AAD-bound)
+KDM AAD binds group, sender, recipient, epoch and version.

 ## Non-negotiable rules
-1. senderKeyId must be a PRF of the key: hex(HMAC-SHA256(key=senderKey, msg="wire-sender-key-id/v2|group|owner|epoch")). ...   (stale)
+1. senderKeyId must be a PRF of the key AND commit to the signing public key: separate HKDF subkeys for encryption and id, then
+   HMAC over length-prefixed fields (label, group, owner, epoch, signPub). Never join fields with "|".
-3. Nonce = 4 zero bytes + 8-byte big-endian counter ...   (stale)
+3. Nonce = 4 RANDOM bytes drawn per process (memory only, redrawn at unlock) + 8-byte big-endian counter, counter reserved under a Web Lock and persisted before
+   encrypting. The replay seen-set is keyed by the FULL 12-byte nonce.
+15. Sign every message over length-prefixed, domain-separated bytes (label, group, senderKeyId, counter, iv, decoded ciphertext, reply target, attachment slot).
+16. Verify BEFORE decrypting and BEFORE claiming the nonce; check the server's claims (author, reply target) before the claim too.
+17. Accept a signing public key only from a KDM that unwrapped under the pairwise key of the claimed sender; the owner is that sender; owner and public key of a
+    stored id are immutable.
+18. Attribute to the verified key's owner; require it to equal the server's sender_id.
+19. The signed reply target is authoritative; the server may only agree or drop it.
+20. Drop a superseded private signing key only after the new key is durably stored, after the KDM POST returned 201, under the lock; never share signing keys between devices.
+21. Unverified is a permanent state: static placeholder, no retry; only "key not arrived" is retried.
+22. Fail closed on every structural problem (lengths, point prefix and curve check, reply id type, signature length).
+23. Before group attachments are ever enabled, bind their bytes into the signature. The binding design is
+   specified in `docs/GROUP_ATTACHMENTS_E2EE.md` (design only; not implemented in this step).

 ## Lifecycle cheat-sheet
+- First send on a device: also requires an own key WITH a signing key (a row without one triggers a re-key); generate the key pair together with the root.

 ## Known limits to disclose, not hide
+Replay window at seen-set eviction (a hostile server, original sender_id); no epoch/membership cut-off on receive; no identity pinning; leaked password leaks the
+identity; group attachments not bound; a hostile role through a hostile API is untested.

+## references/pitfalls.md (additions)
+- Claiming the nonce before the server's claims are checked lets a re-post burn the genuine message.
+- Verifying with the key's own group instead of the arrival group lets a cross-group replay pass.
+- A shared test IndexedDB between two accounts clobbers wrapped rows: use one storage per device.
+- Every connected device rotates on every membership event: tests with several connected accounts must let rotations settle.
```

### 7.4 Safety numbers / key fingerprints (separate future item)

**Goal.** Close 6.7 item 3: let two people check that the identity public key each holds for the other is the one the other generated.

**Sketch.** (1) A fingerprint of the account identity public key (for example SHA-256 over a domain label and the key, shown as 12 groups of 5 digits and
as a QR code); (2) trust on first use: store each peer's key fingerprint locally when it is first seen and show a clear warning, not a silent
re-key, when it changes; (3) a "verified" mark after the user compares or scans, kept in local storage per peer; (4) for a group, a list of member
fingerprints in the members dialog, and a banner when a member's identity key changed since it was last seen. **Open points:** key change after a
legitimate device or password reset must not train users to ignore the warning; what a changed key does to DM history and to sending (block or warn); where the
trust store lives (it must survive logout but not be readable by the server); it needs product decisions and a UI, so it is a separate piece of work.
