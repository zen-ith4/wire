# DM v2 wire format - opt-in procedure and limits (STEP 1B)

See `docs/e2ee-dm-hardening.md` sections 3-5 for the authoritative design. This
document covers only what a deployer/operator needs to know about STEP 1B.

## What STEP 1B does

- Adds `users.dm_e2ee_min_version INTEGER NOT NULL DEFAULT 1` (server floor, layer 1).
- Adds `public/js/crypto/messages/dm-v2.js` (1A) and `dm-v2-wire.js` (this step):
  version selection per peer, the layer-2 client pin, the msgId replay store.
- Adds `scripts/dm-e2ee-optin.mjs` so an admin can raise an account from 1 to 2.
- Wires `public/js/chat/dm.js` to send v2 when the peer's floor is 2, and to
  decrypt v2 on receive, while v1 keeps working byte-identically.

**Default is 1. With no opt-in, the system behaves EXACTLY as before.** No
existing message, key or envelope changes.

## Opt-in procedure

1. Deploy the new server. Existing rows keep `dm_e2ee_min_version = 1`.
2. Verify `node scripts/build-sw-manifest.mjs --check` is current.
3. For each account that should get v2:

   ```
   node scripts/dm-e2ee-optin.mjs alice bob
   ```

   - Idempotent: a second run prints `changed 0 of N rows`.
   - `--dry-run` shows what would change without writing.
   - `--db /path/to/wire.db` targets a specific database.
   - Accepts usernames or numeric ids.

4. The admin boundary is **filesystem access to the SQLite file**. There is no
   web endpoint for this; whoever can read the DB can already read every
   ciphertext and password hash, so this grants nothing new, but it keeps the
   switch offline and auditable.

## Why opt-in only raises

`UPDATE users SET dm_e2ee_min_version = 2 WHERE id = ? AND dm_e2ee_min_version < 2`.

There is deliberately no "lower" option. Once an account is at 2, lowering it
would have to walk every conversation back to v1, which is exactly the downgrade
this design refuses to do. STEP 1C turns the column into a hard ratchet enforced
by SQLite triggers; building anything that has to be removed later is worse.

## Replay store sizing

- `DM_V2_REPLAY_PER_CONV_MAX = 2000` msgIds per conversation.
- `DM_V2_REPLAY_MAX_CONVERSATIONS = 50` conversations.
- One entry is roughly `{"0123456789abcdef":1234}` = ~50 bytes of JSON, so
  2000 entries is ~100 KB per conversation (~200 KB counted in UTF-16), against a
  ~5 MB per-origin localStorage budget shared with pins and everything else.
- FIFO eviction: an old msgId falls out of the window instead of the store
  growing without bound. The server chooses how many messages arrive, so an
  unbounded store would be an attacker-controlled memory leak.
- QuotaExceededError on write: evict and continue, never throw into the UI.

## Honest limits

1. **Replay detection is per-device history, not global anti-replay.** A
   malicious server can still show a message to two different recipients, or to
   the same recipient on a second device. A replay older than the window (2000
   messages) is not detected.
2. **A same-row rollback to an old envelope version is not covered.** An edit
   gives the row a new msgId; the old msgId may stay in the store. Replaying the
   OLD row with the OLD msgId is not flagged because it is, by definition, the
   same row.
3. **First-contact downgrade is not defeated.** On a fresh conversation the
   client has no v2 pin and no v2 transcript; a server that never mentions v2
   keeps the client on v1 forever. Layer 2's pin only catches it after the
   browser has seen the conversation before. A malicious server that is first
   contact for every conversation defeats Phase 1 - see docs/e2ee-dm-hardening.md
   section 7.
4. **Own rotation makes own history unreadable.** An own identity-key rotation
   makes every earlier v2 row you sent undecryptable (the AAD commits to a key
   the server no longer serves). No escrow is added; this is documented and out
   of scope.
5. **Layer 1 is advisory.** The server can lie about `dm_e2ee_min_version`.
   Layer 3 (key separation + AAD) is what makes a downgrade actually fail, and
   it needs nothing from the server.
6. **Attachment encryption is untouched.** `isEncryptedEnvelopeShape` still
   requires version 1; `sendEncryptedAttachment` is unchanged.

## Manifest

`public/` gained `dm-v2-wire.js`, so `public/sw-manifest.js` was regenerated
with `node scripts/build-sw-manifest.mjs` and verified with `--check`.

## Upgrade script for existing rows (STEP 1C)

`scripts/dm-e2ee-upgrade-existing.mjs` raises every account still at 1 to 2.

```
node scripts/dm-e2ee-upgrade-existing.mjs [--dry-run] [--db path/to/wire.db]
```

- Admin-only: needs filesystem access to the SQLite file.
- Explicit: NOT run at boot, NOT an automatic migration. An operator decides.
- Idempotent: second run reports `changed 0 of M rows`.
- `--dry-run`: performs no write; proves it by hashing rows before/after.
- Only raises 1 -> 2 (the ratchet trigger refuses anything else).

## Ratchet limit (honest)

The `trg_users_dm_e2ee_min_version_*` triggers protect against buggy application
code. Anyone with write access to the DB file, or code that can run
`DROP TRIGGER`, can remove them. They do not defend against an attacker holding
the database file.