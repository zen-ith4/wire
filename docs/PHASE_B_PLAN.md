# Phase B plan — F12 login scheme (option A) + F4 cap + dependents

Status: DESIGN ONLY. Nothing here is implemented. REVISION 3 (incorporates the owner's decisions of 2026-10-07, including the T9, username and flaky-test answers; see section 0). Written against the Phase A tree
(`wire-no-chat_4` + 0001 + Phase A) and the hardening branch's step (c) `a20d2ec`.

Important difference from `a20d2ec`: that commit is a hard cut (the server rejects every
raw password from day one, `database/migrations.js` only adds two nullable columns, and
every existing account would be locked out because their `password_hash` is
bcrypt(raw password), not bcrypt(authKey)). Option A replaces the hard cut with a
migration. Everything in `a20d2ec` about the new scheme itself (derivation, validation,
client modules, fake salts) is reused as is.

---------------------------------------------------------------------------------------

## 0. Owner decisions incorporated in this revision

| # | Decision | Where it lands |
|---|---|---|
| 1 | Pruner test commit `d6092f2` is part of the Phase A patches | `phase-a-patches-v2.zip` already has it (10 patches) |
| 2 (rev. 3) | Flaky group-dialog test: fix A (min-height) only if position sampling shows zero shift at 320x568, 375x667, 414x896 in real Chromium with screenshots, otherwise fix B (Create disabled until loaded); regression test; separate small commit | section 6, commit 11 |
| 3a | "Legacy account" visible in `kdf-params`: accepted | T3 |
| 3b | `saveIdentityKey` write-once REQUIRED; key changes only through the migration ticket or an explicit, authenticated, CAS-protected rotation; tests | T8 (rewritten) |
| 3c (rev. 3) | **No raw-password hash is kept after migration** (T1 model, strongest anti-downgrade). Admin: per-user migration status; explicit action to close legacy login for inactive NOT-yet-migrated accounts (admin chooses) plus a bulk action for the same set | T9 (rewritten) |
| 3d | Server-side minimum password length may be lost; client enforces >= 12; docs say client-side only | T4/T5/T6, section 2.9 |
| 4 | `config/socket.js`: reject `pcr` AND media tokens explicitly, with tests | T5, tests |
| 5 (rev. 3) | Username validation at registration and admin creation only; approved with changes (lowercase + clear error; existing accounts untouched and reported; mixed-case existing usernames must still log in) | T6 |
| 6 | F4: document the soft cap and the replay window at eviction; order eviction by `(at, counter)` | section 3 |
| 7 | `sw-manifest.js` is NOT regenerated in any new commit; (d)'s copy is overwritten at the end, no need to rebuild (d) | section 5 |

---------------------------------------------------------------------------------------

## 1. Facts about the current (X) code that drive the design

| Fact | Where |
|---|---|
| `password_hash = bcrypt(raw password)`, cost `BCRYPT_ROUNDS` (default 12) | `utils/password.js`, `services/auth.service.js`, `services/user.service.js` |
| Identity v1: wrapKey = PBKDF2-SHA-256(password, **per-identity** random salt, 600k client-side), AES-GCM; server floor is only **100,000** and `kdf==='PBKDF2-SHA-256'`, `version===1` are hard-coded | `public/js/crypto/identity.js`, `controllers/me.controller.js` (`changePassword`) |
| `saveIdentityKey` accepts any `kdf`, any `version>=1`, no iteration floor, and **upserts** (`ON CONFLICT(user_id) DO UPDATE SET public_key = excluded.public_key ...`), i.e. a valid session can replace the account's public key | `controllers/me.controller.js` |
| Login = `POST /api/auth/login {username,password}` → (email verification / email-2FA challenge) → JWT (24 h, no revocation, no token version) → client `initializeIdentity(password)` restores v1 identity or creates it | `services/auth.service.js`, `public/js/core/auth.js` |
| Remember-me / auto-unlock caches the raw wrapKey bytes (`unlockKey`) | `identity-service.js`, `core/auth.js` |
| 2FA enable/disable ask for `current_password` (raw) | `controllers/settings.controller.js`, `services/settings.service.js` |
| Admin create user sends raw `password` | `public/js/settings/admin.js`, `controllers/admin.controller.js`, `user.service.createUser` |
| Setup wizard hashes the operator's typed password; seed hashes `DEFAULT_ADMIN_PASS` with `bcryptjs` cost 12 | `utils/setupWizard.js`, `database/seed.js` |
| Register sends raw `password`; the client keeps it in memory to create the identity after email verification | `controllers/auth.controller.js`, `core/auth.js` |

---------------------------------------------------------------------------------------

## 2. F12 migration state machine (approved option A)

### 2.1 Primitives (unchanged from `a20d2ec`)

```
master  = PBKDF2-HMAC-SHA-256(password_utf8, users.kdf_salt, N)        N >= 600,000
authKey = HKDF-SHA-256(master, salt = 32 zero bytes, info = "Wire-Auth-v1")           -> server
wrapKey = HKDF-SHA-256(master, salt = 32 zero bytes, info = "Wire-Identity-Wrap-v1")  -> never leaves browser
password_hash = bcrypt(authKey as 43 base64url chars)
identity v2: kdf = "PBKDF2-SHA-256+HKDF-SHA-256", version = 2, identity.salt == users.kdf_salt,
             identity.kdfParams.iterations == users.kdf_iterations
```

* Salts: `users.kdf_salt` = 16 random bytes (base64), generated by the **client** at
  registration, at migration and at **every** password change (never reused across passwords).
  Unknown usernames get `fakeKdfSalt(username)` = first 16 bytes of
  HMAC-SHA256(SHA256("wire-fake-kdf-salt|"+JWT_SECRET), lowercase username).
  The HKDF salt is the fixed 32 zero bytes; domain separation is entirely in the two `info`
  strings above. The PBKDF2 salt is the account salt, **not** the old per-identity salt.
* Floors: client refuses `iterations < 600000` whatever the server says (already in
  `deriveCredentials`); server floor for scheme 2 is 600,000 (DB trigger + validators).
  Legacy v1 identities with 100k..600k iterations stay readable until migrated; the migration
  rewraps them under >= 600k, so nothing below 600k survives migration.

### 2.2 Persistent state (new columns on `users`, `ALTER TABLE ... ADD COLUMN`)

| column | meaning |
|---|---|
| `auth_scheme INTEGER NOT NULL DEFAULT 1` | 1 = legacy (`password_hash = bcrypt(raw)`), 2 = `bcrypt(authKey)`. Existing rows become 1 by default; every INSERT path in the new code sets 2 explicitly |
| `kdf_salt TEXT`, `kdf_iterations INTEGER` | scheme-2 parameters (NULL while scheme 1) |
| `scheme_migrated_at TEXT` | when 1 → 2 happened (admin visibility) |
| `legacy_last_login_at TEXT` | last successful *legacy* login (admin visibility; shows who is still unmigrated and active) |
| `legacy_login_closed INTEGER NOT NULL DEFAULT 0`, `legacy_login_closed_at TEXT` | T9: set by an admin on a NOT-yet-migrated account; there is no retained raw-password hash column |
| `must_change_password INTEGER NOT NULL DEFAULT 0` | forced change (admin-created users, `DEFAULT_ADMIN_PASS` seed) |
| table `auth_migration_tickets(user_id PK, ticket_hash, expires_at)` | single-use, 10-minute ticket issued only by a successful legacy login |

Triggers (so a bug in a controller cannot break the invariants):
* `BEFORE UPDATE OF auth_scheme`: abort if `NEW.auth_scheme < OLD.auth_scheme` (**anti-downgrade**).
* `BEFORE UPDATE/INSERT`: abort if `NEW.auth_scheme = 2` and (`kdf_salt` is NULL or `kdf_iterations < 600000`).
* `identity_keys.version` may never decrease (`BEFORE UPDATE OF version`).

### 2.3 States

Combined state is (users.auth_scheme, identity_keys row):

| state | scheme | identity | how a user gets there |
|---|---|---|---|
| L-none | 1 | none | seeded admin who never logged in; a legacy user who never completed first identity creation |
| L-v1 | 1 | v1 | every existing X user who has logged in at least once |
| M-none | 2 | none | new registration before the client finished creating the identity; migrated L-none; admin-created user before first login |
| M-v2 | 2 | v2 | steady state |
| ILLEGAL | 2 + v1, or 1 + v2 | | prevented: migration writes password + identity in ONE SQLite transaction; `saveIdentityKey` refuses v1 when scheme 2 and v2 when scheme 1 |

### 2.4 Transitions

**T0 — DB migration at startup (once).** Before the first `ALTER TABLE`, copy the database with
`VACUUM INTO 'data.db.pre-f12.<timestamp>'` (consistent even with WAL). Then add the columns and
triggers. Idempotent. All existing users land in L-*.

**T1 — legacy login** (the legacy hash exists only for unmigrated accounts) `POST /api/auth/login {username, password}`:
* Accepted only when `auth_scheme = 1` and `legacy_login_closed = 0` (T9); verified with bcrypt(raw). For scheme-2 users the same
  body gets `400 raw_password_rejected` after a dummy bcrypt (timing-equal) — **server-side
  anti-downgrade**: once migrated, the server never again accepts a raw password for that user
* Unchanged: email-verification gate, email-2FA challenge, JWT issuance, rate limits.
* Response additionally carries `migration: {required: true, ticket, min_iterations: 600000}`.
  The ticket is generated only at the point where the JWT is issued (after email verification /
  2FA), stored as SHA-256, expires in 10 minutes, one active ticket per user.
* Sets `legacy_last_login_at`.

**T2 — migrate** `POST /api/auth/migrate-credentials` (JWT + ticket):
Client, in memory, with the password it just typed:
1. `restoreIdentity(password)` with the v1 identity (this is the existing unlock). New check: the
   unwrapped private key must derive the server's stored `public_key`, otherwise abort.
2. generates `kdf_salt`, runs `deriveCredentials(password, kdf_salt, 600000)` → `authKey`, `wrapKey`.
3. re-wraps the private key with `wrapKey` (identity v2 payload, `salt == kdf_salt`), non-extractable
   key objects, buffers zeroed.
4. sends `{ticket, auth_key, kdf_salt, kdf_iterations, identity | null, expected_identity_version: 1 | null}`.

Server, one transaction: ticket valid and unexpired and consumed; `auth_scheme` still 1 (else
`409 already_migrated`); identity payload validated (v2, kdf name, hash SHA-256, iterations ==
`kdf_iterations`, salt == `kdf_salt`, and the stored row is still the v1 row the client saw — a
compare-and-swap, so two devices migrating at once cannot clobber each other); the public key is
**not** accepted from the client (as today). Then: `password_hash = bcrypt(auth_key)` (this single column assignment **destroys the legacy bcrypt(raw)**: nothing derived from the raw password remains on the server),
`auth_scheme = 2`, `kdf_salt`, `kdf_iterations`, `scheme_migrated_at`, identity row replaced,
all tickets deleted. Anything else → rollback, user stays in L-*, can retry at next login.
`identity: null` is accepted only when no identity row exists (L-none → M-none); the client then
creates a v2 identity through the normal path.

Client side effects after success: clear this device's auto-unlock cache (the cached v1 `unlockKey`
no longer matches); pin `wire.authscheme.<username> = 2` (see T3).
Other devices: their cached unlockKey fails → existing "Auto-unlock failed, falling back to
password" path → they log in with the v2 flow.

**T3 — v2 login** `GET /api/auth/kdf-params?username=` then `POST /api/auth/login {username, auth_key}`:
* `kdf-params` returns `{scheme: 2, salt, iterations}` for scheme-2 users, `{scheme: 2, salt: fake,
  iterations: 600000}` for unknown names, and `{scheme: 1}` for legacy users. **Known leak,
  inherent to option A:** until a user migrates, "legacy account" is distinguishable from "no such
  account". It is rate limited (`kdfParamsRateLimiter`) and disappears as users migrate.
  Alternative without the leak: always answer `scheme: 2` and let the client fall back to raw
  password on 401 — rejected, because it would let any MITM / hostile server harvest raw passwords
  by answering 401.
* `auth_key` for a scheme-1 user → generic 401 (after dummy bcrypt).
* **Client anti-downgrade:** after the first successful v2 login the client pins
  `wire.authscheme.<username>=2` and from then on **refuses** to send a raw password for that
  username, and refuses any `kdf-params` with `iterations < 600000` or `scheme: 1`. A hostile server
  cannot push a pinned device back. An unpinned device (never logged in as that user) is exposed
  exactly until that user's migration — the honest residual risk of option A without a time window.

**T4 — change password** `PUT /api/me/password` (fixes the `me.controller` hard checks):
* Scheme 2 only: `{current_auth_key, new_auth_key, new_kdf_salt, new_kdf_iterations, identity}`.
  Identity must be v2 / `PBKDF2-SHA-256+HKDF-SHA-256` / iterations >= 600000 / `salt == new_kdf_salt`
  (replaces today's `kdf==='PBKDF2-SHA-256' && iterations>=100000 && version===1`). Fresh salt every
  time. Password hash and identity commit in one transaction with a CAS on the identity row (the
  hardened branch's fix for the non-extractable-key re-wrap is taken as is).
* Scheme 1 session → `409 migrate_first` (login always runs T2 first, so this only happens after a
  crashed migration).
* Raw `current_password` / `new_password` → `400 raw_password_rejected`.
* **Password length (decision 3d):** the server can no longer enforce any minimum (it never sees the
  password). The client enforces **>= 12 characters** on register, change-password, admin-create and the
  forced change; the check is **client-side only** (a modified client can set a shorter password) and the
  design doc and the admin UI help text say so. The check is NOT applied at login, so existing users with
  shorter passwords are not locked out and are not forced to change (they can raise it voluntarily).
  The setup wizard (a host console, so it can check) also requires 12. `DEFAULT_ADMIN_PASS` cannot be
  checked; it is covered by the forced change.
* Sessions: unchanged. JWTs are 24 h and not revoked on password change today; this plan does not
  change that (a token-version column would be a separate decision).

**T5 — admin-created users** (`POST /api/admin/users`): the admin's browser generates the salt and
derives `authKey` (as in `a20d2ec`); the server stores scheme 2 with `must_change_password = 1`.
The admin necessarily knows the temporary password.
* Enforcement is **server-side**: while `must_change_password = 1`, login issues a *restricted* JWT
  (`pcr: true` claim). `authenticate` (and the Socket.IO handshake in `config/socket.js`) accept it
  only for `PUT /api/me/password`, `GET /api/me`, `GET /api/me/kdf-params`, `GET /api/me/identity`.
  Every other route → `403 password_change_required`.
* **Socket.IO (decision 4):** `config/socket.js` calls `jwt.verify` directly. The handshake is changed to
  use `verifySessionToken` and to refuse any token with `pcr: true` and any token with `typ === 'media'`
  (media tokens are accepted by the socket today). Tests: a media token and a `pcr` token are each refused
  at the handshake (connect error), a normal session token connects, and a `pcr` token cannot reach any HTTP
  route outside the allow list.
* `PUT /api/me/password` clears the flag and returns a fresh unrestricted token. The identity
  (M-none) is then created under the new password, so there is nothing to re-wrap on this path.
* `DEFAULT_ADMIN_PASS` seed: derived in Node with `deriveCredentialsNode` (replacing the raw
  `bcryptjs` hash), scheme 2, `must_change_password = 1` (the value lives in an environment file, so
  it is treated as compromised). An existing DB that already contains the admin is not touched
  (the admin simply migrates through T1/T2).
* Setup wizard: same Node derivation, scheme 2, `must_change_password = 0` (typed interactively on
  the host console; it is never stored in a file).

**T6 — register** `POST /api/auth/register`: scheme 2 only
(`{username,email,auth_key,kdf_salt,kdf_iterations}`); raw `password` → `400 raw_password_rejected`.
No new legacy account can ever be created. Email verification continues to work; the client keeps
the password in memory exactly as today to build the identity afterwards.
**Username validation (decision 5, approved with changes):** today `registerUser` only checks `username` is
non-empty (it lowercases and trims, nothing else); the password check `< 6` there is removed because the
server no longer sees the password; the email regex stays.
* **Rules, applied ONLY at registration and admin creation** through one shared function
  (`validateNewUsername`) used by `registerUser` and `createUser`: trim, then **lowercase normalization**
  (the stored value is always lowercase, as it is today); 3-32 characters; charset `[a-z0-9._-]`; must start
  and end with `[a-z0-9]`; no `..`, `__` or `--` runs; not in the reserved list (`admin`, `root`, `system`,
  `support`, `wire`, `null`, `undefined`). Failure: `400`, `code = 'INVALID_USERNAME'` and a message that
  names the broken rule ("Usernames are 3-32 characters: lowercase letters, digits, '.', '_' or '-',
  starting and ending with a letter or digit."). If the input only differed by case it is accepted and
  stored lowercase (no error); the client mirrors the rules for instant feedback and shows the same message.
* **Existing accounts are never touched:** no rename, no delete, no forced change. The server logs once at
  startup, and an admin-only `GET /api/admin/username-audit` plus `scripts/audit-usernames.mjs` (read-only)
  report every existing username that would be invalid under the rules (and any pair that collides when
  compared case-insensitively). The report only lists; nothing is changed.
* **Existing mixed-case usernames must still log in.** Verified in the code: every path lowercases the
  typed username before `WHERE username = ?` (`auth.service.js:85/243/323`, `user.service.js:27/132`), and
  the `DEFAULT_ADMIN_USER` seed (`database/seed.js`) stores the value exactly as configured, so a
  mixed-case stored name (for example `Admin`) can never be matched today. Fix in this phase: login and
  `findUserByUsername` look up with `WHERE username = ? COLLATE NOCASE` (the stored value is not modified).
  If an exact match and a different-case match both exist, the exact match wins; if two different-case
  rows collide, login refuses with a generic 401 and the audit report flags it for the admin. `kdf-params`
  uses the same case-insensitive lookup and returns the stored row's salt, so the browser derives the right
  credentials whatever case the user typed; the client lowercases nothing itself for the KDF (the salt is
  per account, not per spelling).
* Tests: each rule (accept and reject), uppercase input normalised and stored lowercase, reserved names,
  registration and admin creation both validated, a fixture with `Admin`/`MixedCase` rows still logs in
  with any casing and migrates, audit lists the invalid and colliding fixtures and changes no row.

**T7 — 2FA enable/disable "current password":** scheme 2 → `current_auth_key` (client fetches the
account salt from `GET /api/me/kdf-params`); scheme 1 (crashed-migration session) → raw
`current_password` still accepted, scheme 2 → raw rejected.

**T8 — identity writes: public key is write-once (decision 3b, required)**
Today `saveIdentityKey` upserts and overwrites `public_key`; `a20d2ec` keeps that. New behaviour:
* `POST /api/me/identity-key` (create): inserts only when the user has no identity row.
  If a row exists: same `publicKey` as stored -> `200 {success:true, unchanged:true}` and **nothing is
  written** (keeps the client's retry-after-partial-success path idempotent); different `publicKey` ->
  `409 identity_exists`, row untouched. Validators: scheme 2 requires v2 and salt/iterations equal to the
  account's; scheme 1 requires v1; version may not decrease; iteration floor.
* The public key changes ONLY in two ways:
  1. **Migration ticket (T2):** the migrate payload carries no public key, so it never changes an
     existing key. The ticket path may create the very first identity for an L-none user (that is a
     first write, not a change).
  2. **Explicit rotation** `POST /api/me/identity-key/rotate`, authenticated by session AND a fresh
     `current_auth_key` (re-proves the password), CAS-protected: body carries `expected_public_key` and
     `expected_updated_at`; the update is `... WHERE user_id = ? AND public_key = ? AND updated_at = ?`
     and `409 identity_changed` when zero rows match. New identity must be a complete v2 payload
     (new public key + re-wrapped private key). Rate limited. Writes a row to a new
     `identity_key_rotations(user_id, old_public_key, new_public_key, at)` log so an admin/user can see
     that it happened. **No UI in Phase B** (endpoint + tests only): a rotation invalidates DM sessions
     and every KDM wrapped to the old key, so it needs a deliberate product flow.
* Tests: second create with another key -> 409 and row byte-identical; same key -> 200 unchanged;
  concurrent creates -> one row; rotate without/with wrong `current_auth_key` -> 403; stale
  `expected_public_key` or `expected_updated_at` -> 409; two concurrent rotations -> exactly one wins;
  rotation writes the log row; a scheme-1 user cannot rotate; migration leaves `public_key` unchanged.

**T9 — legacy login after migration, and admin tools (decision 3c, revision 3)**
* **Migrated accounts can never log in with a raw password again.** At the moment of migration the legacy
  bcrypt(raw) is overwritten by bcrypt(authKey) (T2); no copy is kept anywhere. The server therefore never
  sees that user's password again. This is the T1 model and the strongest anti-downgrade: there is no
  state in which a migrated account accepts a raw password, and no switch that could re-enable it.
  (The earlier draft's retained-hash design and its two warnings are removed.)
* **Admin visibility:** per-user migration status (`Legacy` / `Migrated <date>` / `Closed`), last legacy
  login, `must_change_password`, and a summary count (N of M unmigrated, K inactive).
* **Closing legacy login for NOT-yet-migrated accounts (admin's choice):**
  - `POST /api/admin/users/:id/close-legacy-login`: sets `legacy_login_closed = 1`,
    `legacy_login_closed_at = now` for ONE unmigrated account. Refused (`409`) for an already-migrated
    account (nothing to close).
  - `GET /api/admin/legacy-accounts?inactive_days=N`: lists unmigrated accounts whose
    `legacy_last_login_at` (or `created_at` if never) is older than N days, so the admin sees the set before
    acting.
  - `POST /api/admin/close-legacy-login {inactive_days: N, confirm_count: C}`: bulk action over exactly that
    set; refuses if the current count differs from `confirm_count`, so the admin cannot close a different
    set than the one they were shown. Admins and the caller's own account are never included.
  - Effect on a closed account: `POST /auth/login` with the raw password returns the same generic 401 as a
    wrong password (after the dummy bcrypt, no enumeration), the account cannot migrate (migration needs a
    legacy login), and `kdf-params` still answers `scheme: 1` (accepted leak, decision 3a). It is a
    deliberate lock-out of an inactive account.
  - **Reopen:** `POST /api/admin/users/:id/open-legacy-login` (admin) clears the flag so a closed user can
    still migrate; no data was ever removed.
* Admin actions are logged (user id, admin id, time) in the existing server log.
* Tests: migrated account cannot log in with its old raw password (before and after a server restart), and
  the database holds no bcrypt(raw) for it (assert `password_hash` verifies only against authKey);
  closing one unmigrated account blocks only it; reopen restores; bulk close touches exactly the listed
  inactive unmigrated set, respects `confirm_count`, skips admins and the caller; migrated accounts are
  never affected; non-admin gets 403; actions are idempotent; a closed account's login answer is
  byte-identical to a wrong-password answer.

### 2.5 Admin visibility
`GET /api/admin/users` adds `auth_scheme`, `scheme_migrated_at`, `legacy_last_login_at`,
`must_change_password`, `legacy_login_closed`; the admin UI shows a "Credentials" column (`Legacy` / `Migrated <date>` /
`Must change password`) and a summary line "N of M users still on the legacy scheme", a per-user "Close legacy login" action for unmigrated accounts and a bulk "Close legacy login for inactive unmigrated accounts" action with a preview of the set (T9). No
password-derived value is ever exposed.

### 2.6 What happens to each existing X feature

| X feature | Effect |
|---|---|
| Login / logout | T1/T3. Same UI; one extra ~1–2 s KDF at the first login after the upgrade (two PBKDF2 runs) |
| Email verification at registration/login | Unchanged; ticket is issued only after it passes |
| Email 2FA (login challenge) | Unchanged; ticket is issued only after `verify-2fa` |
| 2FA enable/disable | T7 |
| Remember me / auto-unlock | Cache cleared on migrate and on password change; devices fall back to password prompt once |
| Setup wizard / `DEFAULT_ADMIN_PASS` | T5 |
| Admin create user | T5 + forced change |
| Change password | T4 |
| Sessions / JWT / media tokens | Unchanged (24 h, no revocation); only addition is the restricted `pcr` token |
| DMs (E2EE identity key) | Same X25519 key, only the wrapper changes; DM history is untouched |
| Group E2EE (Sender Keys, Phase A) | Untouched; the group `local-wrap-key` is derived from the unlocked identity and does not depend on the password scheme |
| Old clients (cached app) | `password` login works only for scheme-1 users; after migration they get `raw_password_rejected` and must update (the group protocol already has the `X-Wire-Group-Proto` / 426 gate for the same purpose) |
| Rollback | Restore `data.db.pre-f12.<ts>` and the previous build. Users who migrated after the backup lose those changes; their v2 identities are unreadable by old code, so a rollback after migration needs the backup |

### 2.7 Tests (design; each uses a COPY of the database)

Fixtures: `tests/fixtures/legacy-x.db` built by a script run against the **base** commit
(`0c2145b`): users `alice` (v1 identity, 100,000 iterations), `bob` (v1, 600,000), `carol` (no identity),
`admin` (seeded from raw `DEFAULT_ADMIN_PASS`), `dave` (email 2FA enabled), `erin` (deactivated).
Every migration test does `fs.copyFileSync` of the fixture (after `wal_checkpoint(TRUNCATE)`)
into `os.tmpdir()` and opens only the copy; one guard test asserts the fixture's SHA-256 is unchanged
after the whole suite. A fresh-DB variant runs the same scenarios from an empty database.

* T0: both DB kinds start; backup file exists and opens; columns and triggers present; re-running is a no-op.
* T1/T2 happy path for alice/bob/carol/admin/dave: legacy login → ticket → migrate → v2 login works → v1 login rejected → DM identity public key unchanged → same private key after unlock → pre-existing DMs and group messages still decrypt.
* Atomicity: kill between the password and identity updates (fault injection) → neither changed.
* Concurrency: two migrations racing → exactly one wins, the other `409`, identity intact.
* Ticket: expired / reused / other user's / missing → refused; ticket not issued before 2FA completes.
* Anti-downgrade: SQL `UPDATE users SET auth_scheme = 1` aborts; v1 identity write for a scheme-2 user → 400; `kdf-params` with 1,000 iterations → client refuses; pinned client refuses a `scheme: 1` answer.
* Change password: v2 identity accepted; v1 identity or `version:1` → 400; raw fields → 400; wrong `current_auth_key` → 403; fresh salt every time.
* Admin-created user: restricted token cannot hit any other route or open a socket; after the change it can.
* Seed / wizard: derived hash verifies against the browser `deriveCredentials` for the same password+salt (byte-identical derivations).
* `kdf-params` leak is pinned by a test so a change in behaviour is deliberate.
* Existing tests that register with a raw password through `fetch`
  (only `group-confirm-in-dialog-browser.test.mjs` today) move to derived credentials; the browser tests that log in through the UI need no change.

### 2.8 Decisions
All answered: 3a accepted, 3b write-once required, 3c = no retained raw hash plus admin tools for unmigrated inactive accounts, 3d client >= 12 only, username rules approved with changes (T6). Nothing is pending from the owner except "read the plan, go".

### 2.9 Password policy documentation
The design doc gets a short "Password policy" section: minimum 12 characters, enforced by the official client
only, never by the server (the server cannot see the password); no check at login; existing shorter
passwords keep working; the wizard enforces 12 on the host console; `DEFAULT_ADMIN_PASS` is covered by a
forced change.

---------------------------------------------------------------------------------------

## 3. F4 behaviour at the 100,000-entry cap per key

Code: `public/js/crypto/groups/sender-key-store.js` (`SEEN_CAP_PER_KEY = 100000`, `claimNonce`, `pruneSeen`).

* **Scope:** the cap is per `senderKeyId` (one row per accepted `(senderKeyId, full 12-byte nonce)`).
* **When it runs:** only after a *new* claim, and only with probability 1/64. So the store can
  exceed the cap by a few dozen rows on average before a prune; it is a soft cap.
* **Eviction policy:** when `count > cap`, rows are sorted by `at` (the local time the nonce was
  claimed) ascending and the oldest `(count - cap) + ceil(cap/10)` are deleted, i.e. down to about
  90,000. Cleanup with the key itself (leave/remove) and rotation behaviour are unchanged: rotation
  keeps the rows, leaving deletes them.
* **Does eviction reopen replay? Yes, for exactly the evicted nonces.** A hostile server that
  re-posts the stored ciphertext of an evicted message under a fresh server message id will get
  `'new'` and the message is shown again. It cannot affect any message among the newest ~90,000 of that
  sender key, and no eviction can ever reject a legitimate message (the code comment is correct on
  that). Practical window: about 90,000 messages by a single sender key (months to years in a normal
  group; weeks in a very chatty bot group).
* **Weak spot:** `at` is the claim time, not the message order. A device that syncs a long history in
  one burst claims thousands of nonces within the same millisecond, so the "oldest" among them is
  arbitrary and recent messages may be evicted before old ones. Cheap fix: order by `(at, counter)`.
* **Optional hardening (not implemented, your call):** keep a tiny per-`(senderKeyId, noncePrefix)`
  high-water mark of evicted counters. A nonce with the same prefix and a counter `<=` the mark that
  is not in the set is treated as suspect. The per-process random prefix (F10) keeps this correct after
  a restore. Cost: one small row per prefix; it closes most of the evicted-replay window.
* **Decision 6 (approved):** keep the cap, order eviction by `(at, counter)`, and document in the design
  doc (a) that the cap is soft (checked on 1/64 of new claims, overshoot of a few dozen rows is normal),
  (b) the eviction order and the ~90,000 floor after a prune, (c) the **replay window at eviction**: a
  hostile server can re-post a stored ciphertext of an evicted nonce under a fresh message id and it is
  accepted once as new; messages among the newest ~90,000 per key are never affected; legitimate messages
  are never rejected. The watermark hardening is NOT done unless you ask. Test: with a small cap, a burst of
  claims with identical `at` evicts the lowest counters first, and an evicted nonce is accepted again
  (documenting the window) while a retained one still conflicts.

---------------------------------------------------------------------------------------

## 4. X features that depend on the auth files Phase B will change

Files: `controllers/auth.controller.js`, `services/auth.service.js`, `controllers/me.controller.js`,
`services/user.service.js`, `controllers/settings.controller.js`, `services/settings.service.js`,
`controllers/admin.controller.js`, `utils/setupWizard.js`, `database/seed.js`,
`database/tables/users.tabels.js`, `database/migrations.js`, `routes/auth.routes.js`,
`routes/me.routes.js`, `middleware/rateLimiter.js`, `middleware/authenticate.js`,
`config/socket.js` (restricted token), `public/js/core/auth.js`, `public/js/crypto/identity*.js`,
`public/js/settings/{admin,settings-security}.js`, new `utils/credentials.js`,
`public/js/crypto/{credentials,account-kdf}.js`.

| Feature | Depends on | Phase B change |
|---|---|---|
| Setup wizard (first run) | `hashPassword(raw)` into `users` | Node derivation (scheme 2) |
| `DEFAULT_ADMIN_PASS` seed | `bcryptjs.hashSync(raw, 12)` | Node derivation, scheme 2, forced change |
| Admin user creation | raw `password` in body + `createUser(…, password, …)` | `auth_key` + salt, `must_change_password` |
| Registration + email verification | raw `password`; client keeps it for identity creation | `auth_key` + salt |
| Login + email-verification gate + email-2FA challenge | `comparePassword(raw, hash)` inside `authenticateUser` | scheme-aware credential check; ticket issued after the gates |
| Password change | `current_password`/`new_password` + v1-only identity checks (`kdf`, `version===1`, floor 100k) | T4 |
| Email 2FA enable/disable ("current password") | `comparePassword` in `settings.service` | T7 |
| Sessions | JWT 24 h, `verifySessionToken`, `authenticate` DB lookup, socket handshake (`config/socket.js` calls `jwt.verify` directly, not `verifySessionToken`, so it also accepts media tokens today; the restricted token check must be added there explicitly) | restricted `pcr` token only; nothing else changes |
| Remember me / auto-unlock | cached raw wrapKey | cleared on migrate/change |
| Identity create/restore/re-encrypt | v1 wrapper keyed by per-identity salt | v2 wrapper keyed by account salt |
| Identity upload endpoint | upsert, no floors | T8 |
| Tests | `_test-server`, `_browser-actor`, `lock-identity-clears-group-keys`, raw `register` in `group-confirm-in-dialog-browser` | updated; plus the new migration/fixture tests above |
| Service worker precache | `sw-manifest.js` | regenerated once at the very end |


---------------------------------------------------------------------------------------

## 5. `sw-manifest.js` (decision 7) and proposed Phase B commit sequence

I do not regenerate `public/sw-manifest.js` in any new commit. Procedure for the end of the integration:
`node scripts/build-sw-manifest.mjs && node scripts/build-sw-manifest.mjs --check`, run on the final checkout
(it hashes raw file bytes and `--check` compares the manifest text exactly, so the checkout's line endings
must be the final ones).

Phase A commits that touch `public/**` and therefore would otherwise have needed a regenerated manifest:
`b6ade2e` (F1, 4 files), `502f22a` (F7, 2), `b389be5` (F9, 2), `23d3832` (a, 6), `607076c` (b, 12),
`6649a93` (d, 5). `6649a93` (d) is the only one that currently CARRIES a regenerated `sw-manifest.js`
(it was regenerated before this decision); it is overwritten by your final regeneration, and I can send a
variant of (d) without that file if you prefer.

Proposed Phase B commits (each tested; `*` = touches `public/**`, i.e. would need the manifest):
1. DB: columns, triggers, `VACUUM INTO` backup, tickets table, rotation log, fixtures + migration tests
2. Server credentials util, `kdf-params`, login (both schemes), migrate endpoint, anti-downgrade
3. `me.controller`: change password (v2), write-once identity create, rotation endpoint, tests
4. Client credentials/KDF, login + migration flow, pin, auto-unlock clearing, min 12 (`*`)
5. Admin create + forced change + restricted `pcr` token + socket handshake (rejects `pcr` and media) (`*` for admin.js)
6. Setup wizard + `DEFAULT_ADMIN_PASS` seed
7. 2FA enable/disable with `current_auth_key` (`*`)
8. Admin tools: migration status, close/reopen legacy login for inactive unmigrated accounts, bulk close with preview (server + admin UI) (`*`)
9. Username validation + case-insensitive lookup + audit (server + client mirror) (`*`)
10. F4 eviction order `(at, counter)` + design-doc updates (cap, replay window, password policy) (`*` for sender-key-store.js)
11. Group dialog flake fix (A or B per section 6) + regression test (`*` for groups.css or group.js) — a separate small commit, independent of the login scheme

---------------------------------------------------------------------------------------

## 6. Known flaky test and proposed fix (for your approval; NOT implemented)

**Known flaky:** `tests/groups/group-confirm-in-dialog-browser.test.mjs`
("group settings: the Remove-member confirmation is visible, topmost and works (real Chromium)").
Measured on the Phase A tree: **1 failure in 20** runs alone, **1 in 20** inside the full suite
(plus 1 in 80 with the instrumented copy, 0 in 27 under CPU load). Always the same signature:
`Waiting for selector '#group-input' failed`. It is a UI layout shift, not a crypto/KDM race: no
`POST /api/groups` is ever sent in a failing run.

**Mechanism, with exact lines**
1. `public/js/chat/group.js:645` renders the people list as `loadingState()`; `group.js:737` awaits
   `GET /api/share/users`; `group.js:743` (`paintPeople()`) replaces the list. The loaded list is about 40 px
   shorter than the loading state (`public/css/features/groups.css:81-82`: `.grp-picker-list` has only a
   `max-height: 260px`, no min-height), and the `<dialog>` is vertically centred, so the Create button moves
   up by about 20 px (measured: y 598 -> 578).
2. The test (and a fast user) types the name and clicks `#new-group-create` (handler at `group.js:696`)
   during that ~100 ms window. If the pointer lands after the shift on the area below the panel, the target
   is the `<dialog>` element itself.
3. `public/js/files/dialog.js:51-53` (`pointerdown` sets `pressStartedOnBackdrop = event.target === dialog`)
   and `dialog.js:55-58` (`click`: `if (event.target === dialog && pressStartedOnBackdrop) close();`)
   then close the dialog. The create handler never runs, the page ends on "No groups yet" without the
   dialog, which is exactly the captured screenshot. (The click landing on the backdrop is inferred from the
   captured state plus the measured shift; I did not trace the individual mouse event.)

**Fix selection rule (decision 3, approved)**
1. Implement **A** (`min-height` on `.grp-picker-list`, `groups.css:81`) and measure in real Chromium at
   **320x568, 375x667 and 414x896**: sample `#new-group-create` position (y and x) every 40 ms for 1 s
   from the moment the dialog appears, with a screenshot at the first and last sample per viewport.
2. If every viewport shows **exactly one** `y` value (zero shift), keep A.
3. Otherwise revert A and implement **B**: `createBtn.disabled = true` before `group.js:734`, enabled after
   `paintPeople()` at `:743` and in the error branch at `:740`; the test waits for
   `#new-group-create:not([disabled])` before typing/clicking.
4. Regression test (new file, real Chromium, skips like the other browser tests when Chromium is missing):
   opens the dialog, samples the Create button's `y` for one second, asserts a single distinct value; at the
   three viewports above for A, at 1280x900 plus a "disabled until loaded" assertion for B. Plus a check
   that the original flaky test still passes 20 of 20 alone after the change.
5. It is its own commit (commit 11), independent of the login scheme, and the known-flaky listing is removed
   in that commit.

Until then the original test stays as is and is listed as known flaky (1/20).
