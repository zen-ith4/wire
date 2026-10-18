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

## Decisions (recorded by the reviewer)

1. `services/auth.service.js`: the extra
   `const constants = require('../config/constants')` line is **ACCEPTED**
   (option a). It is the smallest way to keep the default in one place.
   Nothing else in that file is changed.
2. `tests/dm-blob-url-cleanup.test.mjs`: the two-line mock completion
   (`encryptDmTextV2`, `decryptDmTextV2`) is **ACCEPTED**. It fixes a 1B
   regression; no assertion changed.
3. A **fifth** `INSERT INTO users` site exists:
   `utils/setupWizard.js:632` (first-admin wizard). The full list that stays at
   `DEFAULT 1` is: `database/seed.js:55`, `utils/setupWizard.js:632`,
   `services/user.service.js:91`, `services/user.service.js:290`.
   **"Default 2 applies to self-registration only."**

## Running the DM v2 tests (Linux)

Procedure: `docs/ci/RUN_ON_LINUX.md`. CI recipe: `docs/ci/linux-tests.yml`
(documentation only - it is NOT under `.github/` and is not activated).

## 0. Facts established by the reviewer on a real Linux machine

These are the **reviewer's** results, reproduced from their report. They are not
output produced by this tree; the machine that produced `wire-final-26` has no
WSL, no Docker and no distro.

Reviewer ran the **unmodified `wire-final-25` zip** on Linux (node v22.22.2,
`npm ci`, Chromium via `@sparticuz/chromium`, `CHROMIUM_DIR=/tmp/browser-check`):

**Non-browser set (72 files): `607 tests / 603 pass / 0 fail / 0 cancelled / 4 skipped`.**

The 4th skip, against this tree's 3, is:

```
upgrade: DB created by the base code ... # SKIP BASE_TAG not available in this checkout
```

A git tag is missing from the zip. That is an environment artefact of shipping a
zip rather than a clone, **not a defect**. (A tag cannot be carried by
`git archive` of a single commit.)

**Browser files - all pass, 0 fail, 0 cancelled:**

| file | tests |
|---|---|
| `dm-v2-wire-browser` | 1 |
| `dm-e2ee-default-browser` | 1 |
| `peer-trust-browser` | 3 |
| `mobile-groups-tab-browser` | 4 |
| `identity-key-history-browser` | - |
| `csp-confirm-enforced-browser` | - |
| `dm-csp-handlers-enforced-browser` | - |
| `credentials/f12-browser-login` | 6 |
| `groups/group-e2e-browser` | - |
| `group-confirm-in-dialog-browser` | - |
| `group-csp-browser` | - |
| `group-dialog-create-settled-browser` | - |
| `group-hostile-browser` | - |
| `acceptance-xss-sweep-browser` | 8 (1 skip) |
| `acceptance-no-plaintext` | 8 |

### What this corrects

The earlier "Windows-only renderer freeze" labels were **environmental** for
`groups/group-e2e-browser`, `peer-trust-browser`, `mobile-groups-tab-browser`
and `acceptance-xss-sweep-browser`: those files are not Windows-only, the local
Chromium shim was the problem.

For `dm-v2-wire-browser` the label was **wrong on both counts**. It was the two
production bugs found in STEP 1E, not the environment: `buildDmV2Content()` did
not return `content` (1D) and `openDmV2Envelope()` handed `decryptDmV2()` the
flat normalised envelope (1E). Windows could run that file all along.

### Defect in our own procedure document

`docs/ci/RUN_ON_LINUX.md` shipped with a command that **fails**:

```bash
npm ci @sparticuz/chromium puppeteer-core   # WRONG: npm ci takes no package names
```

It must be `npm install @sparticuz/chromium puppeteer-core`. Fixed in
`wire-final-26`. The reviewer hit it, which is how it was found.

## Part B (STEP 1J) - one undecryptable row shows a placeholder

Before: a single row that failed to decrypt (tampered ciphertext, rewritten
version, rewritten reply_to_id, or any corrupt envelope) made the WHOLE history
fail to load: bubbles=0, the thread showed "Failed to load", and the good rows
and the legacy rows disappeared too. Pre-existing (v1 took the same path), not a
v2 regression.

After: decryptDmMessages() decrypts each row independently (Promise.allSettled).
A rejected row becomes ONE placeholder ("Unable to decrypt", undecryptable:true)
in its own place; every other row still renders. A held row (null) is left out,
Phase 2 behaviour unchanged. Applies to v1 and v2 (shared code).

The placeholder carries only id, sender_id, recipient_id, sender_username,
created_at, timestamp, reply_to_id, content="Unable to decrypt", undecryptable:true.
It never carries the original content, the reply target content, attachment or
media data, or the error text. buildDmMessageEl renders it as a plain,
non-interactive bubble (no copy, reply, edit, react, link or media handling,
no quote, no reactions). The three batch sites (syncDmMessagesSince,
loadRecentDm, loadOlderDm) use ROW counts for hasMore and guard entry.oldest
against an empty decrypted set.
