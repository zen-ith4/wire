# Production checks (read-only)

Everything in this file is **HUMAN TODO**. None of it was run by an agent: this
workspace has no access to production, and it must not get one.

The statements below are **READ-ONLY**. Run them with SQLite's read-only mode:

```bash
sqlite3 -readonly /path/to/wire.db
```

`-readonly` makes SQLite refuse any write, so a copy-paste mistake cannot change
data. If your SQLite is older than 3.8.8 (no `-readonly`), open with
`sqlite3 /path/to/wire.db 'PRAGMA query_only=ON; ...'` instead — but then verify
the prompt shows `query_only` is on before pasting anything else.

Replace `/path/to/wire.db` with the production `DB_PATH`. Take the numbers
before deploying, then again after, so a difference is attributable.

## 1. Row totals (before/after deploy)

```sql
-- Every message row, per table
SELECT 'dm_messages' AS what, COUNT(*) AS n FROM direct_messages
UNION ALL
SELECT 'group_messages', COUNT(*) FROM group_messages
UNION ALL
SELECT 'users', COUNT(*) FROM users
UNION ALL
SELECT 'groups', COUNT(*) FROM groups;
```

## 2. Group attachments (should be 0 while the group attachments UI flag is off)

The group attachments UI is behind `GROUP_ATTACHMENTS_UI_ENABLED` in
`public/js/chat/group-attachments-flag.js`, which is `false` on this branch.
Nothing should be able to create `group_messages` attachment rows through the
shipped UI while it stays false.

```sql
-- Group messages that carry an attachment file
SELECT COUNT(*) AS group_messages_with_attachment
FROM group_messages
WHERE attachment_path IS NOT NULL AND attachment_path <> '';

-- Voice notes among them (the flag-off shipped UI never sets this)
SELECT COUNT(*) AS group_voice_messages
FROM group_messages
WHERE is_voice_message = 1;

-- Sanity: any group attachment row whose path is empty/NULL but size is set
SELECT COUNT(*) AS group_attachment_rows_inconsistent
FROM group_messages
WHERE attachment_path IS NULL AND attachment_size IS NOT NULL;
```

Expected: `group_messages_with_attachment` = 0 unless someone already ran a
flag-on dev build against production (it should not happen), or the number is
non-zero and stable — record it, do not "fix" it.

## 3. DM attachments, end-to-end encrypted vs legacy plaintext

```sql
-- Total DM attachment rows, split by whether the client sent an E2EE envelope
SELECT
  COUNT(*)                                              AS dm_attachment_rows,
  SUM(CASE WHEN attachment_meta IS NOT NULL
           THEN 1 ELSE 0 END)                           AS e2ee_meta_rows,
  SUM(CASE WHEN attachment_meta IS NULL
           THEN 1 ELSE 0 END)                           AS legacy_plaintext_rows,
  SUM(CASE WHEN is_voice_message = 1
           THEN 1 ELSE 0 END)                           AS dm_voice_rows
FROM direct_messages
WHERE attachment_path IS NOT NULL AND attachment_path <> '';
```

`legacy_plaintext_rows` should only shrink (old rows being deleted). New rows
always carry `attachment_meta`: the DM uploader requires it (see
`validateEncryptedUpload` in `controllers/dm.controller.js`).

## 4. Deactivated accounts

`is_active = 0` accounts must get `401` from media routes after this merge
(`middleware/mediaAuth.js` now resolves the account with `loadActiveUser`),
even when they hold an unexpired token.

```sql
-- How many accounts are deactivated at all
SELECT COUNT(*) AS deactivated_users FROM users WHERE is_active = 0;

-- Their live message residue (informational only; nothing is deleted by this merge)
SELECT
  COUNT(*) AS dm_rows_involving_deactivated_users
FROM direct_messages dm
WHERE dm.sender_id IN (SELECT id FROM users WHERE is_active = 0)
   OR dm.recipient_id IN (SELECT id FROM users WHERE is_active = 0);
```

## 5. Schema readiness (must match what the branch expects)

This branch changes **no** schema: `git diff github/main...HEAD -- database/`
touches only two comment lines in `database/migrations.js` (the
`docs/…` → `docs/archive/…` path rewrite). So the production database only has
to satisfy what `github/main` already requires. Confirm the columns are there:

```sql
-- Columns the DM E2EE v2 code and the attachment routes read
SELECT name, type, "notnull", dflt_value
FROM pragma_table_info('direct_messages')
WHERE name IN ('attachment_meta', 'attachment_iv', 'is_voice_message', 'reply_to_id', 'edited_at');

SELECT name, type, "notnull", dflt_value
FROM pragma_table_info('group_messages')
WHERE name IN ('attachment_path', 'attachment_iv', 'is_voice_message', 'reply_to_id');

SELECT name, type, "notnull", dflt_value
FROM pragma_table_info('users')
WHERE name IN ('is_active', 'must_change_password', 'dm_e2ee_min_version',
               'legacy_login_closed', 'legacy_login_closed_at');
```

Expected: every row listed (5 columns for `users`, 5 for `direct_messages`,
4 for `group_messages`). A missing row means production is behind `github/main`
and must be updated **before** this deploy; the trigger-based ratchet in
`database/migrations.js` runs at boot and would not be able to add a column the
code reads.

## 6. Filesystem checks (not SQL — run on the server host)

```bash
# Attachment directories: sizes and file counts, before and after deploy
du -sh "$DM_UPLOAD_DIR" "$GROUP_UPLOAD_DIR" 2>/dev/null
find "$DM_UPLOAD_DIR"    -type f | wc -l
find "$GROUP_UPLOAD_DIR" -type f | wc -l

# APK served by /api/apk/info must be the file the deploy put there
ls -l "$APK_PATH" 2>/dev/null || ls -l "$(dirname "$APK_PATH")/app-debug.apk"
```

## 7. Cross-check after the deploy

1. `GET /api/apk/info` must return the **same** `sha256` as the APK file on disk,
   and `available: true` (see `docs/RELEASE_RUNBOOK.md`).
2. Re-run §1: totals must be >= the pre-deploy numbers (this merge deletes
   nothing), and §2 must still be 0 for group attachments with the flag off.
3. §4's deactivated user, using their old token, must now get `401` on a media
   URL. That is a live test, not SQL — the exact `curl` is in the runbook.
