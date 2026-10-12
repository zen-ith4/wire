# CSP TODO: legacy code that blocks `CSP_ENFORCE=true`

`middleware/csp.js` sends a strict policy (no `'unsafe-inline'`, no `'unsafe-eval'`).
It is **Report-Only by default** (`CSP_ENFORCE` unset/false) because parts of the
pre-existing UI still use constructs that a strict CSP blocks. Enforcing today
would silently break those controls. The Groups UI (`js/chat/group.js`,
`js/chat/thread.js`, `js/crypto/groups/*`) and every other file added by the
group port have **cap 0** and are clean under enforcement.

> **CSP_ENFORCE=true is STILL NOT SAFE.** The confirm modal (`#confirm-modal`, used by group message
> Delete, Remove member and DM delete) was converted to `data-action` + one delegated listener and is
> proven under the enforced header by `tests/csp-confirm-enforced-browser.test.mjs`, but these remain
> and are blocked when enforced:
> - **10 inline handlers in `public/index.html`**: image viewer (lines 211, 216, 241, 285, 311),
>   lines 348 and 349, profile card (lines 402, 407, 411; they were 404/409/413 before the confirm
>   modal lost two lines above them); plus the inline `<script>` at `index.html:19` (setVh) and
>   `style="display:none;"` at `index.html:92`;
> - **`public/js/core/auth.js:1324`** (login template, agent A);
> - **9 inline handlers in `public/js/chat/dm.js`**: **Attach, Emoji, Reply, Edit, the New-DM picker's
> back/close buttons, Thread back, Peer profile (avatar/name) and Jump to latest** do nothing under
> enforcement. Only the DM **Send** and message **Delete** buttons were converted to delegated listeners
> (`data-action="dm-send"` / `"dm-delete"`, covered by `tests/dm-csp-handlers-enforced-browser.test.mjs`);
> since the confirm modal is delegated too, DM delete now works end to end under enforcement;
> - the other legacy rows in the table below (the `chat/chat.js` row is stale: that file no longer exists).

## These counts are enforced

`tests/csp-static.test.mjs` holds a per-file cap for every number in the table
below (`LEGACY_CAPS`). A file fails if its count goes **above** its cap; a file
not listed has cap 0. Caps may only go down: when legacy code is converted, lower
or delete its entry in the test and its row here. `tests/groups/group-csp-browser.test.mjs`
runs the group UI in real Chromium with `CSP_ENFORCE=true` and requires zero violations.

Totals: **51 inline event-handler attributes**, **60 inline `style=""` attributes**, **5 `setAttribute('style'|'on*')`/`.cssText=` writes**, **0 `escapeHtml()` inside a quoted attribute** (was 20; all converted to `escapeHtmlAttr()`), **1 inline `<script>`** (all in `index.html`).

| File | `on*=` | `style=` | setAttribute/cssText | escapeHtml in attr | inline `<script>` |
|---|---:|---:|---:|---:|---:|
| `public/js/settings/settings-render.js` | 8 | 16 | 0 | 0 | 0 |
| `public/js/core/auth.js` | 0 | 21 | 0 | 0 | 0 |
| `public/js/chat/dm.js` | 9 | 3 | 1 | 0 | 0 |
| `public/index.html` | 10 | 1 | 0 | 0 | 1 |
| `public/js/settings/admin.js` | 7 | 3 | 0 | 0 | 0 |
| `public/js/media/attachments.js` | 3 | 1 | 4 | 0 | 0 |
| `public/js/chat/chat.js` | 5 | 1 | 0 | 0 | 0 |
| `public/js/chat/composer.js` | 4 | 1 | 0 | 0 | 0 |
| `public/js/settings/settings-appearance-custom.js` | 0 | 3 | 0 | 0 | 0 |
| `public/js/settings/settings-shortcuts.js` | 0 | 0 | 0 | 0 | 0 |
| `public/js/media/audio-player.js` | 1 | 1 | 0 | 0 | 0 |
| `public/js/ui/profile-card.js` | 1 | 1 | 0 | 0 | 0 |
| `public/js/wireguard/wireguard.js` | 1 | 1 | 0 | 0 | 0 |
| `public/js/media/video-player.js` | 0 | 2 | 0 | 0 | 0 |
| `public/js/media/voice-message.js` | 0 | 2 | 0 | 0 | 0 |
| `public/js/settings/settings-bubble-gradient.js` | 0 | 1 | 0 | 0 | 0 |
| `public/js/chat/reactions.js` | 1 | 0 | 0 | 0 | 0 |
| `public/js/ui/avatar.js` | 1 | 0 | 0 | 0 | 0 |
| `public/js/settings/settings-message-sounds.js` | 0 | 1 | 0 | 0 | 0 |
| `public/js/ui/emoji-picker.js` | 0 | 1 | 0 | 0 | 0 |

## Interim defence (already in place)

Until enforcement is on, the real protection is output escaping:
- `escapeHtmlAttr()` in `core/utils.js`, used for `title`/`data-*` attributes and the linkified `href`.
- Reaction emoji (`chat/reactions.js`): escaped as text and as `data-emoji`, delivered through a delegated listener instead of an inline `onclick` string. This closed a stored-XSS hole that existed in this tree before the port.
- Reply-quote filename/text (`chat/reply.js`): escaped in both branches.
- Group member role / names in `chat/group.js`: rendered as text.

## How to finish

1. Replace each inline `on*=` with `data-action="..."` plus one delegated listener (pattern: `chat/reply.js`, `chat/reactions.js`; `ui/avatar.js` has an opt-in `delegated` mode, the legacy default still emits `onclick`).
2. Replace `style="..."` with CSS classes, or set `el.style.prop = ...` from JS (allowed by CSP).
3. Move the inline `<script>` in `index.html` (the `--vh` fixer) into an external file (`js/core/viewport-fix.js` is already shipped for this).
4. ~~Replace `escapeHtml()`-in-attribute uses with `escapeHtmlAttr()`.~~ **Done** (20 sites; `tests/csp-attr-escape.test.mjs` renders each through the real function with `"`/`'` payloads, and the `escapeHtmlInAttr` cap in `tests/csp-static.test.mjs` is 0 everywhere, so any new site fails the build). `core/auth.js` keeps its own quote-escaping `escapeHtml()` and is excluded from that cap on purpose.
5. Lower the caps in `tests/csp-static.test.mjs`, run with `CSP_ENFORCE=false`, load every screen, and confirm the console has no `[Report Only]` violations. Then flip `CSP_ENFORCE=true`.

## Known effect while Report-Only
Browsers log `[Report Only] Refused to ...` for each legacy construct above. That is expected and harmless, and it is how you measure remaining work. No report endpoint is configured.
