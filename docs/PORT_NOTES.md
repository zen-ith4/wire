# Group E2EE port notes (Y -> X v1.3.6)

Group E2EE + CSP/XSS hardening were ported from a v1.0.0 tree onto v1.3.6.
X's own code wins on every conflict. Deliberate deviations and limits:

## DM attachment encryption is NOT part of this port
X encrypts DM *text* only; DM attachments are stored/served as before.
`public/js/crypto/messages/attachment-crypto.js` is kept byte-identical to
the source tree, but **its DM functions (`encryptAttachmentForDm`,
`decryptAttachmentForDm`, ...) are unused in X**. Nothing in the DM path
(`dm.controller`, `dm.service`, `mediaToken.js`, `media/attachments.js`,
audio/video players, `composer.js`/`dm.js` upload code) was modified.
Only the group half of that file (`encryptAttachmentForGroup`,
`decryptAttachmentForGroup`) is intended for use, once group attachments exist.

## Group attachments: server ready, client not wired (same as the source tree)
- Server (`controllers/groups.controller.js`): an upload without a valid
  `attachment_iv` is rejected (400) and the body is always served as opaque
  `attachment` bytes, so a plaintext group attachment can never be stored.
- Client: the group composer has no file input/staging element, paste-image
  is a no-op (`wirePasteImage`), and `media/attachments.js` has no `'group'`
  branch. So the UI cannot send or render group attachments yet.
- `composer.js` was NOT changed: X's composer already `await`s an async
  `buildTextBody`, which is all group text encryption needs.

## Other deliberate choices
- **`chat/thread.js` is NOT byte-identical to the source tree.** Differences:
  1. `revokeMediaPlayerBlobUrls` is defined locally (X's `media/attachments.js`
     has no such export and is intentionally untouched). Same behaviour.
  2. Group messages that carry an attachment render an inert, non-interactive
     note (`unsupportedAttachmentHtml`, filename escaped as text) instead of
     calling `attachments.js`'s shared `renderAttachment()` / image loaders /
     `imageDownloadButtonHtml()`. That card has an inline `onclick` download
     handler (blocked by a strict CSP) and would try to fetch an encrypted group
     body as a plain file. The group attachment client is not wired in this port.
  3. `avatarHtml(..., false, true)`: group avatars use the opt-in `delegated`
     mode (see next item). `chat/group.js` makes the same one-argument change.
- **`chat/group.js` is NOT byte-identical to the source tree either.** Besides the
  same avatar argument: `confirmInDialog()` wraps the two `showConfirm()` calls made
  from the group-settings dialog ("Remove member", "Leave group"). Those settings
  open in a native modal `<dialog>` (`showModal()`), which makes the rest of the page
  inert and puts the dialog in the top layer, so the page-level `#confirm-modal` was
  buried and unclickable: the promise never settled and nothing happened. Found by
  driving the real app in Chromium (the jsdom tests cannot see top-layer stacking);
  pinned by `tests/groups/group-confirm-in-dialog-browser.test.mjs`. The confirm
  modal is moved into the open dialog while it is shown and put back afterwards.
- `ui/avatar.js`: `avatarHtml()` gained an optional 5th parameter `delegated`
  (default `false`). Default output and click behaviour are byte-for-byte what X
  had (inline `onclick` with `stopPropagation`, which X's DM list rows rely on so
  clicking an avatar does not also open the row). Only `delegated=true` omits the
  inline handler; that is what the Groups UI needs to work under an enforced CSP.
  The source tree instead removed the inline handler for every avatar, which
  would change stop-propagation ordering for X's existing rows, so it was not ported.
- `core/auth.js` `setCurrentUser()` refreshes `groups_enabled` from `/api/me` when
  the caller's object lacks it (login/2FA/register build the user by hand). It is
  skipped when `groups_enabled` is already present (app.js startup, settings saves),
  which the source tree did not do. Without this the Groups nav item would not appear
  until a page reload after login.
- `crypto/identity-service.js` `lockIdentity()` also clears the group key caches
  (`tests/groups/lock-identity-clears-group-keys.test.mjs`, new).
- `chat/reactions.js`: chat/dm keep X's design (React button in the action
  bar, no row when there are no reactions). Only scope `group` renders the
  add-reaction button inside the row, because `thread.js` has no action-bar
  React button. Its CSS lives in `css/features/groups.css`.
- Groups nav item is in the desktop sidebar only. The phone tab bar and the
  admin "More" menu (`ui/mobile-shell.js`) are untouched, so phones cannot
  reach Groups yet. Off by default (`GROUPS_ENABLED=false`).
- `public/js/core/viewport-fix.js` (from the source tree) is shipped but
  unused: X's `index.html` keeps its inline `--vh` script (see CSP_TODO.md).
- CSP is Report-Only unless `CSP_ENFORCE=true`; see `docs/CSP_TODO.md`.

## Tests
- `npm test` runs `scripts/run-tests.mjs`: every `tests/**/*.test.mjs` except the
  documented list in `tests/EXCLUDED_NOT_APPLICABLE.json` (`npm run test:excluded`
  runs those on their own). The tests use `CSP_ENFORCE=true` from `tests/test.env`.
- Modified copies of source-tree tests (no assertion changed):
  - `tests/csp-static.test.mjs`: the blanket "known legacy file" allowlist became
    per-file caps (`LEGACY_CAPS`), see `docs/CSP_TODO.md`.
  - `tests/csp-xss-render.test.mjs`: the benign element-count baseline is computed per
    scope (X's chat/dm reaction rows have no add-button; the group row does).
- New tests written for this port: `tests/groups/thread-blob-cleanup.test.mjs`,
  `tests/groups/lock-identity-clears-group-keys.test.mjs`,
  `tests/groups/group-confirm-in-dialog-browser.test.mjs` (real Chromium).
- Some tests hardcode `/home/claude/wire/...`; run them with that path symlinked to
  the repo root. The real-Chromium test needs `@sparticuz/chromium` and
  `puppeteer-core` in `/tmp/browser-check` (`CHROMIUM_DIR`), outside the repo.

## Task C, phase 1: escapeHtml -> escapeHtmlAttr (20 sites)
- X's `escapeHtml()` does not escape quotes; the 20 uses inside quoted attributes now call
  `escapeHtmlAttr()`: `chat/dm.js` (1), `chat/composer.js` (1), `settings/settings-render.js` (11),
  `settings/settings-shortcuts.js` (4), `settings/settings-appearance-custom.js` (2),
  `settings/settings-bubble-gradient.js` (1). Text-node uses are untouched. `core/auth.js` has
  its own local `escapeHtml()` that escapes both quote kinds and stays as is.
- Modified test: `tests/csp-static.test.mjs`, only the `escapeHtmlInAttr` caps (all 0 now).
- New test: `tests/csp-attr-escape.test.mjs` (real render functions + jsdom DOM parser; each
  site type fails on the pre-change code and passes after).
- Merge note: `dm.js`/`composer.js` got one added import line (`escapeHtmlAttr,`) plus one
  edited site each, in their own commit.

## Task C, phase 2: automated acceptance checks (new tests only, no app changes)
The original acceptance checklist file is not in the repo; this maps the items named in Task C.
Run with `npm test` (real Chromium needed; without it these tests SKIP, which is not a pass).

Automated now
- Server never stores plaintext, group text and DM text: `tests/acceptance-no-plaintext.test.mjs`
  runs the REAL `node server.js` and real Chromium, then scans `.db`, `-wal`, `-shm`, every
  upload dir and multer's temp dir (all redirected into one work dir; a control fails if the
  server writes anywhere else) and the captured stdout/stderr, once live and once after stop.
- DM attachments (bytes + caption) must leave no marker: same file, **depends on agent B's patch**.
  On a tree without it the test is `todo` and fails with the exact hit (file bytes in
  `dm-uploads/`, caption in `wire.db-wal`). It becomes a hard test automatically when
  `controllers/dm.controller.js` mentions `attachment_iv`, or with `DM_ATTACH_E2EE=1`.
- Group attachments: uploads without a valid `attachment_iv` (missing, non-base64, oversized,
  no session, non-member) are rejected and leave no file behind.
- Log leak: no JWT / Bearer / base64-or-hex 32-byte key / wrapped-key field / password patterns,
  and none of the exact secret values the server holds (tokens, the password, every value of
  key-ish DB columns) appear in the server logs.
- XSS sweep, real Chromium, Report-Only CSP so handlers WOULD run: `tests/acceptance-xss-sweep-browser.test.mjs`.
  Paths: group name (create + rename), username, profile bio, DM text, group text, link text,
  reply quote (DM + group), reaction emoji (DM + group), attachment filename, member role.
  Seen by sender and receiver; `window.__pwned` must stay false. This app has no display-name
  field, so the profile `bio` stands in for it.

Findings from phase 2 (reported, NOT fixed here; both are `todo` tests that pass once fixed)
1. Stored XSS via attachment filename (confirmed, executes on click for sender and receiver):
   `escapeAttr()` in `public/js/core/utils.js` does not escape `&`, and its result is placed
   inside a single-quoted JS string in inline `onclick="window.downloadAttachment(id, '<name>', ...)"`
   (`media/attachments.js` 886 and 995, `media/audio-player.js` 249). A file named
   `x&#39;);__pwned=1;(&#39;.txt` closes the string after HTML decoding. Escaping `&` first fixes it
   (verified on a scratch tree). Enforced CSP would also block it, but CSP is not enforceable yet.
2. `services/auth.service.js registerUser()` only checks that the username is non-empty;
   `isValidUsername()` runs only in `createUser()`. `/api/auth/register` therefore accepts
   usernames like `"><img src=x onerror=...>`. The sweep shows they currently render inert.
   Agent A's area.

Still manual
- Real push notifications, APK build, Capacitor shell, real multi-device group use, TLS/network
  deployment, visual/UX review, mobile layout (Phase 3).
- Enforced CSP (`CSP_ENFORCE=true`) is not safe yet: see docs/CSP_TODO.md.
- Group attachments through the UI (disabled by design; only the server-side rejection is automated).

Depends on other agents
- Agent B: DM attachment E2EE (above); `dm.js:1503` (Send) and `dm.js:2095` (delete) inline onclick.
- Agent A: the 6 known baseline failures (stale selectors), register username validation.

## Files changed vs the X base (verified)
`git diff --name-status 7655a7e..HEAD -- ':!tests' ':!docs'` was compared against an independently written list; they match exactly. Nothing else outside `tests/` and `docs/` differs from X.

**Modified (26):**

- `.env.example`: GROUPS_ENABLED, CSP_ENFORCE
- `config/constants.js`: GROUPS_ENABLED, GROUP_UPLOAD_*
- `config/multer.js`: group upload middlewares
- `config/socket.js`: register group socket
- `controllers/me.controller.js`: groups_enabled in /api/me
- `database/migrations.js`: rebuild message_reactions CHECK for existing DBs
- `database/tables/index.js`: 4 group tables
- `database/tables/messageReactions.tabels.js`: allow message_type 'group'
- `middleware/mediaAuth.js`: 'group' resource type
- `package-lock.json`: fake-indexeddb
- `package.json`: test scripts, fake-indexeddb
- `public/css/main.css`: import groups.css
- `public/js/chat/reactions.js`: emoji XSS fix, delegated clicks, group scope
- `public/js/chat/reply.js`: filename XSS fix, delegated click, group scope
- `public/js/core/app.js`: Groups nav item (groups_enabled)
- `public/js/core/auth.js`: setCurrentUser refreshes groups_enabled
- `public/js/core/router.js`: groups route + composer teardown
- `public/js/core/socket.js`: group socket events
- `public/js/core/utils.js`: escapeHtmlAttr; linkify href
- `public/js/crypto/identity-service.js`: lockIdentity clears group key caches
- `public/js/crypto/keys/key-derivation.js`: export deriveSharedSecret, info param (default unchanged)
- `public/js/ui/avatar.js`: opt-in delegated avatar
- `server.js`: mount csp + /api/groups
- `services/socket.service.js`: group emitters
- `sockets/index.js`: register group socket (unused entry point, kept in sync)
- `utils/ensureDirectories.js`: GROUP_UPLOAD_DIR

**Added (28):**

- `controllers/groups.controller.js`
- `database/tables/groupKeyDistributions.tabels.js`
- `database/tables/groupMembers.tabels.js`
- `database/tables/groupMessages.tabels.js`
- `database/tables/groups.tabels.js`
- `middleware/csp.js`
- `public/css/features/groups.css`
- `public/js/chat/group.js`
- `public/js/chat/thread.js`
- `public/js/core/viewport-fix.js`
- `public/js/crypto/messages/attachment-crypto.js`
- `public/js/crypto/messages/group-message-crypto.js`
- `routes/groups.routes.js`
- `scripts/run-tests.mjs`
- `services/groupKdm.service.js`
- `services/groupMessages.service.js`
- `services/groups.service.js`
- `sockets/group.socket.js`
- `public/js/crypto/groups/*` (10 files)

Not touched (protected): `dm.js`, `composer.js`, `chat.js`, `media/attachments.js`, `media/mediaToken.js`, the audio/video players, `ui/mobile-shell.js`, `sw.js`, `sw-manifest.js`, `index.html`, `settings/*`, `dm.controller`/`dm.service`, `messages.css`, `responsive.css`, and everything for push, APK, appearance, shortcuts, fonts and message sounds.
