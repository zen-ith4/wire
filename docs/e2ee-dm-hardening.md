# DM E2EE hardening — design (Phase 0, no code)

**Status:** design only. Nothing in this document has been implemented. No test
was written for it. Every claim about current behaviour below cites the file and
line it was read from, on `wire-final-8` at commit `b278c2b`.

**Scope:** 1:1 DM text and DM attachments. Group crypto is untouched — see
§6 for exactly why, and for what would have to change if it ever did.

---

## 1. What the code actually does today

Read before designing; these are the facts the rest of the document rests on.

**One long-lived X25519 identity key per user, forever.**
`database/tables/identity_keys.tabels.js` — one row per user
(`UNIQUE(user_id)`), `public_key`, `encrypted_private_key`, `version`. It is
written once (`PUT /me/identity-key`) and thereafter only replaced
(`POST /me/identity-key/rotate` → `me.controller.js:923` `UPDATE identity_keys
SET public_key = ?, …`).

**Peer keys are fetched, never authenticated.**
`keys/peer-keys.js:88` `getPeerPublicKey(userId)` does
`GET /api/me/identity-key/:userId` and imports whatever 32 bytes come back. No
fingerprint, no pin, no comparison against anything previously seen. A grep of
`public/js/**` for `fingerprint|pin|safetyNumber|keyChanged` returns only
unrelated words (`typingEmitter.stop`, `message grouping`): **there is no key
authentication anywhere in the client.**

**The pairwise key is symmetric and long-lived.**
`keys/key-derivation.js:22` `deriveSharedSecret` → 32 bytes; `:98` HKDF-SHA-256
with `salt = new Uint8Array(32)` (line 102) and `info = 'Wire-E2EE-v1'`
(lines 4–6, 12 bytes). Because X25519 satisfies
`DH(sk_A, pk_B) = DH(sk_B, pk_A)` and the `info` constant does not depend on
direction, **alice and bob derive the identical AES-GCM key**, and they keep
deriving it for as long as neither rotates.

**No AAD on DM.** `messages/encrypt.js:65` calls
`crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, encoded)` — no
`additionalData`. `messages/decrypt.js:118` likewise. The ciphertext is
therefore bound to nothing: not a sender, not a recipient, not a message id, not
a conversation.

**Same for DM attachments.** `messages/attachment-crypto.js:38` and `:60` use
`{ name: 'AES-GCM', iv }` with no `additionalData`. (The group paths in the same
file do bind — `:99` and `:146` pass `attachmentAad(...)`.)

**Groups already do this correctly**, and are the template:
- `groups/message-crypto.js:72` `messageAad = encodeFields('group-msg-v2', groupId, senderKeyId, counter, iv)`
- `groups/message-crypto.js:77` `attachmentAad = encodeFields('group-att-v2', groupId, senderKeyId, counter, iv)`
- `groups/kdm.js:58` `kdmAad = encodeFields('group-kdm-v2', groupId, fromUserId, toUserId, epoch, KDM_VERSION)`
  (`senderKeyId` is deliberately excluded — it is derived from the key being
  unwrapped, so including it would be circular.)

**The server assigns the message id after the client has already encrypted.**
`dm.controller.js:221` `findDmMessageWithUser(info.lastInsertRowid)`. The
client's `encryptOutgoingMessage` (`messages/message-crypto.js`) runs before the
POST. **Consequence: the server message id cannot appear in the AAD without a
second round trip.** This is the single most important constraint on the design
and it is why §4.3 introduces a client-generated id instead.

---

## 2. Notation

| symbol | meaning |
|---|---|
| `sk_X`, `pk_X` | X25519 identity private / public key of account `X`, 32 raw bytes |
| `ss` | `X25519(sk_X, pk_Y)`, 32 bytes — one per unordered pair, direction-blind |
| `fp_X` | `SHA-256(pk_X)`, 32 bytes — the identity fingerprint |
| `enc(v)` | `TextEncoder().encode(v)`, UTF-8 |
| `b64` | standard base64 with padding, as `groups/codec.js` |
| `AES-GCM` | 256-bit key, 12-byte nonce, 16-byte tag |

HKDF-SHA-256 is always `L = 256`. The **salt is 32 zero bytes in every
derivation below, including the existing ones.** That is deliberate and is not a
weakness: RFC 5869 §3.1 uses `salt` to raise the entropy of a low-entropy IKM, and
here the IKM is an X25519 output, which is already uniformly distributed.
Domain separation is `info`'s job, and every derivation in this document has a
distinct `info`.

---

## 3. Phase 1 — authenticated envelope, directional keys

Two changes, both client-side except the one additive column in §5.4.

### 3.1 Directional key derivation

Two keys per pair instead of one. This is the highest-value change in the whole
document: it is what makes reflection a cryptographic impossibility rather than
a server mislabelling.

The direction label must be computable identically on both sides without extra
state, so it is derived from the ordering of the two account ids:

```
directionLabel(from, to) = Number(from) < Number(to) ? 'a2b' : 'b2a'
```

| direction | HKDF `info` | bytes |
|---|---|---|
| DM v2, lower-id → higher-id | `'Wire-E2EE-DM-v2-a2b'` | 19 |
| DM v2, higher-id → lower-id | `'Wire-E2EE-DM-v2-b2a'` | 19 |
| DM v1 (existing, unchanged) | `'Wire-E2EE-v1'` | 12 |
| Group KDM (existing, unchanged) | `'Wire-E2EE-Group-KDM-v2'` | 22 |

All four are distinct and none is a prefix of another (verified, not assumed).

```
deriveDmV2Key(from, to):
    ss  = X25519(sk_self, pk_peer)                 // 32 bytes, zeroed in finally
    dir = directionLabel(from, to)                 // 'a2b' | 'b2a'
    key = HKDF-SHA-256(ikm = ss,
                       salt = 32 zero bytes,
                       info = enc('Wire-E2EE-DM-v2-' + dir),
                       L = 256)
```

**What this buys.** A v2 ciphertext made for alice→bob can only be decrypted by a
process holding the `a2b` key for that pair. Alice holds both directions, so
she could still decrypt her own message — but she cannot *send* it and have bob
accept it as a message from bob, because bob derives `a2b` for the message
`from=alice,to=bob`, and a server that rewrites the envelope's
`senderId`/`recipientId` to claim the reverse produces an AAD that no longer
matches. Reflection dies here.

**What it costs.** Two AES-GCM keys cached per peer instead of one. This breaks
nothing that exists today, because v1 keeps its own key and is never re-derived
from the v2 infos.

### 3.2 HKDF-keyed key confirmation is *not* used

There is no HKDF-Expand step (no `HKDF-Expand(prk, "confirm")`) as there is in
X25519ML-KEM and in Signal's triple-SHA256 confirmation. The AEAD tag already
fails to verify under a wrong key, which is the property being wanted; adding a
confirmation value would add a second thing to get wrong and buy nothing here.
Flagged explicitly because its absence will look like an omission.

### 3.3 AAD layout

Same style, same helper, same positional discipline as
`groups/codec.js encodeFields` — `1 type byte | 4-byte big-endian length | data`,
type `0` = UTF-8 text, type `1` = raw bytes. **Order is part of the format.**

```
dmMessageAad({ version, fromUserId, toUserId, senderKeyFp, direction, iv, replyToId })
  = encodeFields(
        'dm-msg-v2',        // type 0,  9 bytes   protocol label
        version,            // type 0,  1 byte    "2"
        fromUserId,         // type 0,  decimal
        toUserId,           // type 0,  decimal
        senderKeyFp,        // type 1, 32 bytes   SHA-256 of the SENDER's pk
        direction,          // type 0,  3 bytes   'a2b' | 'b2a'
        iv,                 // type 1, 12 bytes   the nonce itself
        replyToId,          // type 0,  decimal, 0 when absent
    )
```

Worst case (10-digit ids, 32-byte fingerprint, 12-byte nonce): **109 bytes.**

Per-field rationale:

- **`senderKeyFp`** is the sender's *own* identity fingerprint, not the DH
  fingerprint. It is the field that gives key-change detection for free: if the
  server swaps bob's key in `/api/me/identity-key/:id`, the receiver derives a
  different `ss`, a different AES key, and decryption fails. The failure *is* the
  detection. It cannot be stripped, because removing it changes the AAD.
- **`iv`** is bound so the nonce cannot be swapped between two ciphertexts under
  the same key — the same reason groups bind it.
- **`replyToId`** is known client-side at encrypt time (`chat/dm.js` builds
  `reply_to` before calling `encryptOutgoingMessage`) and is otherwise entirely
  server-controlled, so an unbound server could re-point a reply at any message.
  `0` means "no reply". Included from the start: adding a field to an AAD later
  silently breaks every row ever written in that version.
- **`messageId` is deliberately absent** — see §1, the server id does not exist
  yet. Replaced by a client-generated one, §4.3.

Attachments get their own label so a file can never be replayed as a message:

```
dmAttachmentAad({ version, fromUserId, toUserId, senderKeyFp, direction, iv, attachmentId })
  = encodeFields('dm-att-v2', version, fromUserId, toUserId, senderKeyFp, direction, iv, attachmentId)
```

### 3.4 What Phase 1 defends, and what it does not

| | |
|---|---|
| **Defends** | Server reflecting alice→bob as bob→alice (directional keys + AAD). Server relabelling `senderId`/`recipientId`/`reply_to_id`. Server swapping a peer's identity key *after* first contact (AAD-bound fingerprint). Server transplanting a ciphertext between conversations of the same pair. Server editing a message's header without detection. |
| **Does NOT defend** | **A malicious server on first contact** — see §7. TOFU is not defeated by anything in Phase 1, because the very first key the client learns is the one the server handed it. Metadata (§8). Any server that can serve the web client can serve modified JS (§8). |

---

## 4. Envelope wire format and version discrimination

### 4.1 v1 — unchanged, read forever

```json
{"encryption":{"version":1,"algorithm":"AES-GCM","iv":"…","ciphertext":"…"},
 "senderId":12,"recipientId":34}
```

v1 stays readable **forever**. There is no code path that can reject it, and
§5 is built so that no test needs to.

### 4.2 v2

```json
{"encryption":{
   "version":2,
   "algorithm":"AES-GCM",
   "iv":"<b64, 12 bytes>",
   "ciphertext":"<b64>",
   "senderFp":"<b64, 32 bytes>",
   "msgId":"<16 lowercase hex chars>"},
 "senderId":12,"recipientId":34}
```

`version` and `algorithm` are the **only** discriminators, and they are read
before anything else. `payload.js validateEncryptedMessagePayload` currently
throws `'Unsupported encryption version'` on anything but `1`; it becomes a
switch: `1` → the existing code path untouched, `2` → the new path, anything
else → throw. There is no negotiation, no capability exchange and no header: the
envelope is self-describing, which is what lets an old client simply fail to read
a v2 message rather than misread it.

`senderFp` is carried **in the clear** (not only in the AAD) for two reasons: so
a receiver can print a precise diagnosis ("bob's key changed on 2026-10-12")
instead of "Message authentication failed", and so it can be stored per row for
offline history (§4.4).

### 4.3 `msgId` — a client-generated id, and why

The server id is unavailable at encrypt time (§1). So the client generates 8
random bytes → 16 lowercase hex chars, puts it in `encryption.msgId`, and sends
it. The receiver:

1. **before** deriving any key: checks the msgId against its local per-conversation
   store, and if it has been seen, drops the message as a replay;
2. **then** decrypts.

This is replay prevention within a device's own history. It is *not* a global
anti-replay guarantee — a malicious server can still show a message to two
different recipients, or to the same recipient on a second device. §7 says so
plainly. The server must also learn to accept and echo the field; it does not
need to understand it.

### 4.4 The hard constraint this design creates: key history

`rotateIdentityKey` **overwrites** `public_key` (`me.controller.js:923`). Today
that destroys the ability to read history *only for new messages*, because v1
binds nothing. Once v2 binds `senderKeyFp`, a rotated peer makes **every earlier
v2 row undecryptable** — the AAD commits to a key the server no longer serves.

**Phase 2 therefore cannot be "add pinning" alone; it must add key archiving**,
or shipping Phase 1 first would give users a new way to lose their own history.
This is called out here because it inverts the obvious implementation order.

---

## 5. Migration, and how the downgrade is prevented

The model to copy is the credential one, which already exists in this codebase
and works: a server-authoritative integer column (`users.auth_scheme`), a client
that refuses to go backwards on its own initiative
(`account-kdf.js isScheme2Pinned` / `DowngradeRefusedError`), and a floor the
client re-checks even when the server proposes something weaker
(`account-kdf.js:71`, `p.iterations < KDF_ITERATIONS`).

Three layers, strongest last.

### 5.1 Layer 1 — server-authoritative floor (policy)

One additive column, via the existing mechanism in `database/migrations.js`
`VALID_COLUMNS` (the same pattern as `auth_scheme INTEGER NOT NULL DEFAULT 1`
at line 30):

```
users.dm_e2ee_min_version INTEGER NOT NULL DEFAULT 1
```

Default `1` is what makes this safe to deploy: every existing row keeps working
with no backfill, exactly as `auth_scheme` did. A server that sees a v2 envelope
heading for a peer whose `dm_e2ee_min_version` is `1` leaves it alone; the rule
only ever applies to rows the operator has opted in.

**This layer is advisory.** The server can lie about the column. It exists to
stop a *sloppy* downgrade and to give an operator a switch. Layers 2 and 3 are
what make the rule real.

### 5.2 Layer 2 — client pin (policy, per device)

`localStorage`, keyed exactly as `account-kdf.js` keys its pins —
`${serverEndpoint}|${localUserId}|${peerUserId}` — holding the highest envelope
version this browser has ever *sent to or received from* that peer.

- Sending v1 to a peer pinned at ≥ 2 → refuse locally, raise
  `DowngradeRefusedError`, render a warning. Never fall back silently.
- Receiving a v1 envelope from a peer pinned at ≥ 2 → still decrypt it (history
  is not the attack), but surface "this conversation was downgraded" once.

Storage unavailable → the pin is a no-op and the code proceeds. Same posture
`account-kdf.js:53-57` takes, and for the same reason: a pin is hardening, not
a requirement, because layer 3 does not depend on it.

### 5.3 Layer 3 — key separation and AAD binding (cryptographic, and the one that counts)

**This is what actually prevents downgrade, and it needs nothing from the
server.**

1. **v2 never uses the v1 key.** v2 derives from
   `'Wire-E2EE-DM-v2-a2b'/'b2a'`; v1 keeps `'Wire-E2EE-v1'`.
2. **The version is inside the AAD**, as field 2 of `encodeFields`.
3. Therefore a server that strips `version: 2 → 1` hands the receiver an envelope
   that the receiver opens with the v1 key **and** computes the v1 AAD for. Both
   the key and the AAD differ from what was used. Decryption fails. The server
   cannot paper over this, because it cannot encrypt anything at all — it holds
   no key material and never has.
4. The only way a valid v1 ciphertext comes into existence is a real client
   producing one. So downgrade requires the *client* to emit v1, which is
   exactly what layer 2 refuses to do.

**The honest limit:** layer 3 cannot stop a first-contact downgrade, because on
first contact the client has no v2 pin and no v2 transcript to compare against.
Against an active server adversary on a fresh conversation, the server simply
never mentions v2 and the client happily uses v1 forever. Layer 2's pin is the
only thing that catches that case, and only if the browser has seen the
conversation before. **A malicious server that is first contact for every
conversation defeats Phase 1 entirely** — see §7.

### 5.4 Unupgraded peers

Nothing blocks them and nothing forces them:

- Peer at `dm_e2ee_min_version = 1` → sender emits **v1**, exactly today's
  envelope, byte-identical. No new field, no new header, no negotiation.
- Peer at ≥ 2 → sender emits **v2**.
- A peer with **no identity key at all** keeps failing exactly as it does today.
  v2 introduces no new requirement: v1 already needs a peer public key.

The *sender* picks the version, per peer, from local state plus the server's
`dm_e2ee_min_version`. There is no attempt to make an old client understand v2,
and no fallback path for a client that cannot read it — it shows "cannot decrypt",
which is the honest outcome and is already the failure mode for an unknown
envelope version.

### 5.5 Server obligations, stated precisely

The server must, in addition to holding the column:

- **never rewrite `version`, `senderId`, `recipientId`, `reply_to_id`, `senderFp`
  or `msgId`** — it has no reason to, and §5.3 means tampering is detected;
- **store `msgId` verbatim** (it is inside the opaque `content` blob already,
  so this is free — this is a note for the future, not a schema change);
- **reject** `version = 2` when `dm_e2ee_min_version < 2` for the recipient —
  refuse to *store* a v2 envelope for a peer who is not opted in. This is
  belt-and-braces against a *buggy client* upgrading a peer behind its back, and
  is the one rule with teeth that the server can actually enforce.

### 5.6 Explicitly not done

`users.dm_e2ee_min_version` has **no** interaction with
`services/auth.service.js`. The anti-downgrade rule there
(`auth.service.js:150-163`) is untouched by this design — not loosened, not
bypassed, not given new flags. It is a different table, a different threat
(authKey vs raw password) and a different decision point (login vs send). It is
cited above only as the *pattern* to mirror.

---

## 6. Interaction with groups: nothing changes

**Answer: `groups/kdm.js` and `groups/session.js` require no modification, and
KDM wrap/unwrap keeps working unchanged.** Stated precisely:

- `keys/session.js getOrCreateGroupKdmKey(id)` calls
  `deriveSessionKeyFromPeer(privateKey, peerPublicKey, GROUP_KDM_INFO)`.
  `GROUP_KDM_INFO` is `'Wire-E2EE-Group-KDM-v2'` and stays byte-identical.
- Phase 1 **adds** two HKDF infos (`'Wire-E2EE-DM-v2-a2b'`, `'Wire-E2EE-DM-v2-b2a'`)
  and **does not modify** `'Wire-E2EE-v1'` or `'Wire-E2EE-Group-KDM-v2'`. All
  four are distinct, none a prefix of another. Nothing that already derives a key
  re-derives a different one.
- `kdm.js wrapSenderKeyForRecipient` / `unwrapKdmDetailed` are untouched. Their
  `kdmAad` already binds `group-kdm-v2, groupId, fromUserId, toUserId, epoch,
  KDM_VERSION` — that is the same class of protection Phase 1 gives DMs, and it
  is already there.
- `groups/message-crypto.js messageAad` / `attachmentAad` are untouched.

**The one pre-existing group weakness this document does not fix, stated so it
is not lost:** a KDM's *key* is still the direction-blind pairwise key. A server
could reflect a KDM row and re-label `from_user_id`/`to_user_id`. In practice the
AAD stops the re-label (it is bound), and the impact is bounded — the receiver
re-derives the same `senderKeyId` it already had and re-stores an equivalent
record. So it is a theoretical finding, not a live one, and fixing it means
directional KDM keys, which would **invalidate every KDM ever sent**. That trade
is out of scope here and is flagged for a separate decision.

---

## 7. Threat model per phase

| | Phase 1 (envelope + directional keys) | Phase 2 (continuity + change detection) | Phase 3 (forward secrecy) |
|---|---|---|---|
| **Passive server reading stored traffic** | No help — it holds no keys. | No help. | No help. |
| **Active server reflecting / relabelling messages** | **Defeated** (directional key + AAD). | Inherited. | Inherited. |
| **Active server swapping a peer's key *after* first contact** | **Detected** (AAD-bound `senderKeyFp`). | Defeated (signed prekeys + safety numbers). | Inherited. |
| **Active server swapping a peer's key *on first contact*** | **NOT defeated.** TOFU. | **NOT defeated**, unless the users compare a safety number out of band. | Inherited. |
| **Server downgrade v2 → v1** | **Defeated on an established conversation** (§5.3); **not on a fresh one**. | Inherited. | Inherited. |
| **Server replaying an old message** | Partially — `msgId` is per-device. | Inherited. | Inherited. |
| **Server suppressing / reordering / deleting** | **Not defended, and not defensible.** | Same. | Same. |
| **Forward secrecy (device seized today, history readable later)** | **No.** | **No.** | Only if Phase 3 ships. |

### 7.1 What no phase in this document defends

- **A malicious server on first contact defeats TOFU.** The client learns the
  peer's public key from that server and has nothing else to check it against.
  Phase 2's safety number fixes this *only* if two humans compare digits over a
  channel the server does not control. Without that comparison, TOFU is TOFU.
- **Metadata is fully visible to the server, always.** Who talks to whom, when,
  how often, message sizes, IP addresses, device counts, group membership,
  KDM fan-out patterns, rotation events. The payload is opaque; the envelope is
  not. Padding and cover traffic are not proposed here.
- **The web client code is served by the same server.** An attacker who controls
  the server can serve modified JavaScript that exfiltrates plaintext keys
  before anything else runs. **No amount of client-side cryptography defends
  against this.** It is the reason "the server can lie" is a permanent
  condition of this threat model rather than a temporary weakness, and it caps
  what any phase can honestly claim. A pinned/native client is the only real
  mitigation, which is out of scope.
- **XSS in the origin compromises everything**, including unwrapped identity keys
  held in IndexedDB. The CSP work elsewhere in this repo narrows this; it does
  not close it.

---

## 8. Phase 2 — key continuity and change detection

Prerequisite: **archive identity keys** (§4.4). Without it, change detection
converts key rotation from "old messages become unreadable" into "old messages
become unreadable *and* the user is warned", which is strictly worse.

Proposed, all borrowed from the Signal protocol — not invented here:

1. **Signed pre-keys (XEdDSA).** Each account publishes a batch of one-time
   pre-keys, each signed by the long-term identity key using XEdDSA
   (Sign, 1), so a server cannot substitute its own pre-key for the user's
   without invalidating the signature. This closes the first-contact hole that
   Phase 1 explicitly cannot close, *except* for the case where the server also
   substitutes the long-term identity key — which is what the safety number is
   for.
2. **Safety number.** A stable digest over both users' identity keys and their
   pre-key bundles, displayed and comparable, in the style of Signal's
   (PuTTY, 2021, §9). This is the out-of-band check that makes first contact
   trustworthy.
3. **Key-change alarm.** On a fingerprint mismatch for an established peer, block
   sending by default and require an explicit "I verified the new key" action —
   the same shape as Signal's "your safety number with X has changed".

Open questions that must be answered before code: pre-key batch size and refill
protocol; whether rotation keeps the old key archived and for how long; whether
change detection is per-conversation or per-peer (per-peer is simpler and leaks
less; per-conversation leaks less about *which* conversation changed).

---

## 9. Phase 3 — forward secrecy, three options

### (a) Ephemeral-static X25519 per message

Generate a fresh X25519 key pair per message; encrypt under
`HKDF(X25519(sk_msg, pk_peer), …)`. The peer needs a pre-key or the sender's
long-term public key.

- **For:** ~40 lines; reuses `X25519` and `HKDF` only; no state machine; a
  compromised long-term key does not decrypt stored traffic.
- **Against:** **it does not protect the receiver.** Bob's static private key
  decrypts every message ever sent to him, because every message used
  `X25519(sk_msg, pk_Bob)` and Bob can recompute it. Signal calls this
  asymmetric forward secrecy, and it is genuinely half the problem: sender
  compromise is covered, recipient compromise is not. Requires sending the
  ephemeral public key per message (+32 bytes, or 16 if prepended to the
  ciphertext).
- **Cost in this app:** breaks the `sessionKeys` cache model — a key per message
  means a key per message, so the cache becomes a write-only convenience; offline
  delivery works unchanged (the key travels with the message); history search and
  restore are unaffected (each row is self-contained); multi-device needs no
  extra state because nothing is shared between devices.
- **Verdict:** defensible as a strict improvement, and honest only if labelled
  "sender-side forward secrecy".

### (b) Signal-style Double Ratchet

The full construction: X3DH initialisation (Pohlig-Hellman et al., 2018) plus
the Double Ratchet (Pohlig-Hellman et al., 2018), as specified in the Signal
Double Ratchet revision (Cohn-Gordon, Cremers, Jackson, Messenger, 2018).

- **For:** the only option here giving **true** forward secrecy plus PCS — a
  compromised device does not expose *future* messages either, because keys are
  derived forward with a DH ratchet. Plus post-compromise security, which is the
  property that matters most for a long-lived account.
- **Against:** a chain per conversation, with skipped-key storage to tolerate
  out-of-order delivery. That is where the real risk is. A ratchet bug is
  usually silent — messages are simply never decryptable — and the failure is
  indistinguishable from a bug in the sender, which is how ratchet
  implementations lose user data quietly.
- **Cost in this app, concretely:**
  - *Multi-device:* the largest cost. Each device needs its own ratchet chain and
    its own pre-key bundle. Today "log in on a second device" copies an
    identity key and nothing else; with a ratchet, each device is an independent
    encryption endpoint with its own key distribution. This is a protocol
    change, not an implementation detail.
  - *Offline delivery:* every skipped key must be retained until the oldest
    possibly-lost message's limit, with a bound, or history is lost. This is
    where naive implementations fail.
  - *Loss / reordering:* requires the skipped-key store with a configurable
    window. Socket.IO already delivers out of order, so this is load-bearing,
    not theoretical.
  - *History search / restore:* every stored row needs its message-key index
    persisted. Search over history requires retaining old message keys — which is
    in direct tension with forward secrecy, and the tension is unresolvable
    without deciding whether the client is willing to keep keys it claims not to
    keep.
  - *Server-side storage:* +1 pre-key table, +1 session row per device per
    conversation, skipped-key retention. Substantially more, and all of it state
    a malicious server controls.
- **Verdict:** **it should not be hand-rolled here.** The instruction not to
  invent a custom ratchet is also just correct on the merits. The honest
  recommendation is one of:
  - use a vetted implementation — `@signalapp/libsignal-client` is maintained,
    audited and is the reference implementation, but it is a native/WASM
    dependency, it changes the storage model, and it would need an independent
    review of the integration; **or**
  - adopt **MLS** (RFC 9420, 2023) for groups and a reviewed X3DH/Double Ratchet
    for DMs, which is a larger project than this repository; **or**
  - ship Phase 1 and Phase 2, and state publicly that DMs have no forward
    secrecy.

  **Plainly: a correct Double Ratchet in this codebase, unaudited, is a worse
  outcome than an honest "no forward secrecy" label — because the first looks
  like protection and the second is at least true.**

### (c) Do nothing

Keep static-static, ship Phase 1 and Phase 2.

- **For:** no new state anywhere; no new failure modes; no new dependency;
  Phase 1's two fixes (reflection, relabelling) address the attacks that are
  actually reachable by the server today, which are *far* more likely than device
  seizure. Message history keeps working after key rotation.
- **Against:** a device seized today — stolen laptop, a coercive seizure, a
  compromised browser profile with the local identity key — exposes the **entire
  readable history** of every conversation, forever.
- **Cost:** none beyond declining to make the claim.

**Recommendation:** (c) now, then (a) labelled honestly, and treat (b) as a
separate project with a budget for a library and an audit. The choice between
(a) and (c) should be made by whoever owns the risk, with §7.1 in view: against
a malicious server, none of the three helps at all.

---

## 10. Contradictions with the assumptions above

**None.** All three assumptions were re-verified against the source at `b278c2b`
and all three hold:

1. *No key authentication in DMs* — confirmed. `keys/peer-keys.js:88` fetches
   from the server with no comparison; no fingerprint/pin/safety-number code
   exists anywhere in `public/js/**`.
2. *No AAD on DMs, same key both directions* — confirmed. `encrypt.js:65` passes
   `{ name, iv }` only; salt is 32 zero bytes (`key-derivation.js:102`); info is
   `'Wire-E2EE-v1'` (12 bytes); direction-blind because X25519 is symmetric and
   the `info` is a constant. Groups bind `groupId/senderKeyId/counter/iv` and
   KDMs bind `group/from/to/epoch` — confirmed at `groups/message-crypto.js:72,77`
   and `groups/kdm.js:58`.
3. *No forward secrecy* — confirmed. One X25519 key per user
   (`identity_keys`, `UNIQUE(user_id)`), replaced only by manual rotation, which
   overwrites it (`me.controller.js:923`).

### 10.1 Additions — things the assumptions do not mention, found while re-reading

These extend rather than contradict, and each one changes the design:

1. **DM attachments have the same defect as DM text.**
   `messages/attachment-crypto.js:38,60` pass no `additionalData`. Any Phase 1
   that only touches text leaves attachments reflectable and relabellable.
2. **The server message id does not exist at encrypt time**
   (`dm.controller.js:221` assigns it after the POST), so it cannot be bound in
   the AAD without a round trip. §4.3 substitutes a client-generated `msgId`.
3. **Key rotation destroys history, and gets worse in Phase 1.**
   `me.controller.js:923` overwrites `public_key` and there is no archive table.
   Today that is survivable because nothing is bound; once `senderKeyFp` is bound
   it is not. §4.4 makes archiving a Phase 2 prerequisite.
4. **The codebase already contains the pattern to copy.**
   `account-kdf.js` has the server-authoritative column + localStorage pin +
   client-side floor, and `groups/kdm.js` has the `encodeFields` AAD discipline.
   Neither needs to be designed from scratch.

---

## 11. Decisions needed before any code is written

1. Does Phase 1 ship before Phase 2, given §4.4 makes archiving a hard
   prerequisite? (Recommendation: **no** — ship archiving with Phase 1, or accept
   a documented regression where rotation loses history.)
2. Is `replyToId` in the v2 AAD confirmed safe, i.e. is the reply id stable
   across the DM send path at `chat/dm.js`?
3. Is per-peer or per-conversation key-change detection wanted?
4. For §9: who owns the decision between (a) and (c), given the server-attacker
   ceiling in §7.1?