# RFC: Phase 3 - forward secrecy for DMs (design only)

**Status: DRAFT. No code, no wire change.** Nothing here may be implemented
until the owner replies with a chosen option and the word "GO". Written for
STEP 3F follow-up 3.H on the tree after `wire-final-39`. Every claim about the
current code cites the line it was read from.

---

## 1. Where DMs are today

| fact | where |
|---|---|
| One X25519 identity key per account; `UNIQUE(user_id)` | `database/tables/identity_keys.tabels.js:2-15` |
| The private key is stored on the server, wrapped under a password-derived key (`encrypted_private_key`, `salt`, `iv`, `kdf`, `kdf_params`), so a second device logs in and gets the SAME key | `database/tables/identity_keys.tabels.js:5-10` |
| v2 text key: X25519 + HKDF-SHA-256, one key per direction (`Wire-E2EE-DM-v2-a2b` / `-b2a`) | `public/js/crypto/messages/dm-v2.js:52-54`, `:190`, `:231` |
| v2 AAD: `dm-msg-v2`, version, fromUserId, toUserId, senderKeyFp, direction, iv, replyToId | `public/js/crypto/messages/dm-v2.js:324` |
| Attachment meta AAD: the same fields under the label `dm-att-v2` | `public/js/crypto/messages/dm-v2.js:715` |
| Replay store keyed on the AAD-bound iv: 2000 per conversation, 50 conversations, per device | `public/js/crypto/messages/dm-v2-wire.js:55`, `:61` |
| Rotation archives the OLD PUBLIC key (`identity_key_rotations`), never the old private key | `services/identityKeyHistory.service.js:5-9` |
| Peer trust: every accepted peer key is kept per device (TOFU pin + archive) | `public/js/crypto/keys/peer-trust.js:30` |

So DMs are **static-static**: the two identity keys determine every message key
of the pair, forever. Anyone who obtains one of the two private keys (a seized
unlocked device, the password plus the server row, a stolen browser profile
where "remember me" was ticked - see `docs/SECURITY_CLAIMS.md`) reads the whole history of
that account, past and future, until the key is rotated.

## 2. What "forward secrecy" would have to mean here

- **FS (past):** compromising a device or a long-term key TODAY does not reveal
  messages sent BEFORE the compromise.
- **PCS (future):** after a compromise ends, later messages become secret again
  without the user doing anything.

Neither property helps against the server as a code distributor: the server
serves the web client, so a malicious server can ship JavaScript that copies
plaintext (`docs/e2ee-dm-hardening.md` §7.1). Every option below is judged only
against **device / key compromise**, the one threat FS is about.

## 3. The options

### (a) Ephemeral-static X25519 per message ("sender-side FS")

Per message the sender makes a fresh X25519 pair `e`, derives
`HKDF(X25519(e, pk_peer), info = 'Wire-E2EE-DM-v3-<dir>')`, sends `pk_e` with the
envelope, and forgets `e`.

| | |
|---|---|
| Threat gain | A seized SENDER device cannot decrypt what it sent (it no longer has `e`), **unless it kept the plaintext** - and it does: the thread cache and history are stored decrypted for display. The recipient's static key still decrypts every message ever sent to it. Net: **half** of FS, for the sender only, and only for an attacker who gets the key without the device's stored history. |
| Envelope / AAD | New version 3. `ephemeralPub` (32 bytes) added to the envelope AND to the AAD (it is an input to the key; binding it stops a swap that would turn decryption failure into a confusing error). `senderKeyFp` stays (it is still the sender's identity: the receiver checks it). |
| Multi-device | No new state: the key travels with the message. Works with the current "same key on every device" model unchanged. |
| Phase 2 archive | Unchanged for the recipient (static key). The sender cannot re-read its own sent v3 rows from the server after a reload unless it also encrypts a copy to itself (a second ephemeral to its own static key: +48 bytes) - otherwise "my own sent messages" disappear on a new device. |
| Offline / out-of-order | Unaffected: each row is self-contained. |
| History / search / export | Unaffected for received rows; sent rows need the self-copy above. |
| Server | None (one longer `content`; the 2000-character cut at `controllers/dm.controller.js:454` already limits v2 to ~1328 plaintext bytes and would cut v3 further - fix 3.F.2 first). |
| Migration | v3 alongside v2, same layered pin as v1 -> v2 (`users.dm_e2ee_min_version`, layer-2 pin). Old rows stay readable forever. |
| Effort / risk | Small (~1-2 weeks with tests). Low risk: no chain, no state. The real risk is the CLAIM - it must be labelled "sender-side forward secrecy" or not advertised at all. |

### (b) X3DH + Double Ratchet (Signal protocol)

Per-device pre-key bundles (signed pre-key + one-time pre-keys), an X3DH
handshake per device pair, then a Double Ratchet per conversation per device
pair (Marlinspike & Perrin, "The X3DH Key Agreement Protocol" and "The Double
Ratchet Algorithm", Signal, 2016).

| | |
|---|---|
| Threat gain | Real FS and PCS for message KEYS. Still bounded by stored plaintext: a seized device shows whatever history it keeps decrypted. |
| Envelope / AAD | New version; the header carries the ratchet public key, the chain counters (`n`, `pn`); AD = the X3DH associated data (both identity keys) plus the existing fields. A new wire format end to end. |
| Multi-device | **The biggest cost.** Today a second device simply unwraps the same identity key from the server. A ratchet needs one session per (sender device, recipient device): device registration, per-device bundles, fan-out of every message to every device of both parties (Signal's "sesame"). That is a protocol change, not an implementation detail. |
| Phase 2 archive | The pin/archive model assumes static keys. It would move to per-device identity keys and per-device safety numbers. |
| Offline / out-of-order | Skipped-message keys must be stored (bounded) - Socket.IO and the history sync deliver out of order, so this is load-bearing. A bug here loses messages silently. |
| History / search / export | A new device cannot read old history at all (by design). Users of this app expect history on every device; either that expectation is dropped, or an encrypted history backup is designed - which re-creates a long-term key and gives back much of the FS gained. |
| Server | Pre-key tables, device table, per-device message fan-out, pre-key refill. All state a malicious server controls (it can withhold one-time pre-keys; the signed pre-key still holds). |
| Migration | A new conversation type; v1/v2 rows stay readable; no in-place upgrade of history. |
| Effort / risk | Large (months). **Must not be hand-rolled**: use `@signalapp/libsignal-client` (native/WASM; changes the storage model) and budget an external review of the integration. Unaudited, a home-made ratchet is worse than an honest "no FS" label. |

### (c) Do nothing (keep static-static), label it

| | |
|---|---|
| Threat gain | None. |
| Cost of doing nothing | A compromise of one identity private key exposes **every** DM of that account, past and future, until rotation. The key is reachable from: an unlocked device; a browser profile where "remember me" was ticked (the unlock key is then kept in IndexedDB `wire-e2ee-store`, `public/js/crypto/keys/unlock-key-store.js:19`, written only when `rememberMe === true`, `public/js/core/auth.js:492`; the wrapped private key is on the server); the account password plus the server's `identity_keys` row. |
| Effort | Documentation only: `docs/SECURITY_CLAIMS.md` already states "no forward secrecy for DMs". |

## 4. Groups

**Out of scope of this RFC.** Group messages use Sender Keys
(`docs/GROUP_E2EE_MULTIDEVICE_DESIGN.md`): a chain per sender, rotated on
membership change. Whether a Sender Key chain is advanced per message (hash
ratchet) and how rotation bounds exposure is a separate review; nothing in
options (a)-(c) changes the group path, and option (b) would not cover groups
(Signal uses Sender Keys for groups too; MLS, RFC 9420, would be the group
equivalent and is a larger project).

## 5. Test plan (for whichever option is chosen)

1. Seam tests first (rule 3): the real encrypt and the real decrypt, no mocks,
   asserting the envelope shape and the exact AAD bytes (as `tests/dm-v2.test.mjs`
   does for v2).
2. Known-answer vectors for the new derivation (fixed keys -> fixed key bytes).
3. Negative tests with positive controls: swapped `ephemeralPub` / ratchet key,
   reordered header fields, v3 -> v2 downgrade on a pinned peer
   (`DowngradeRefusedError`), replayed rows (the iv-keyed store), each shown RED
   with a planted violation.
4. (a) only: a test that the sender's ephemeral private key is not reachable
   after `encrypt` returns (no module-level cache), and the self-copy round
   trip on a fresh device.
5. (b) only: out-of-order and lost-message tests with the skipped-key bound;
   a device added mid-conversation; a device removed.
6. Browser tests on Linux with `@sparticuz/chromium` for send/receive, reload,
   second device, tamper placeholder.

## 6. Recommendation

**(c) now, stated plainly; (a) only if the owner wants the narrower claim and
accepts the self-copy design for sent history; (b) only as a separate project
with a library and an audit budget.** Reason: the realistic compromise of this
app is a device or browser profile that also holds the decrypted history, and
neither (a) nor (b) protects history that the client itself keeps in clear.
The highest-value step against device compromise is not FS but local hygiene:
lock the identity on every logout (`lockIdentity()` has no caller today, see
`docs/E2EE_TRIAGE_3I.md` R3) and keep auto-unlock ("remember me") opt-in, as
it is today.

## 7. Decision needed

The owner picks (a), (b) or (c) and replies "GO". Until then: no code, no
wire change, and the docs keep saying "no forward secrecy for DMs".
