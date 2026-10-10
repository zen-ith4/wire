# Group E2EE: multi-device Sender Key design

Status: implemented on branch `fix/group-e2ee-hardening` (not merged).
Tests: `tests/groups/group-multidevice.test.mjs` (MD-1..MD-6),
`group-audit.test.mjs` (F-I, G), `group-keys-contract.test.mjs` (L-1).

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

* No per-message sender authentication: any member holding a sender's key can
  encrypt under it; attribution relies on the server's `sender_id`.
* KDM rows carry no AAD binding group/sender/epoch yet (planned: F2); a
  relabelled row yields an id no envelope references: denial of service, not
  confusion.
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
