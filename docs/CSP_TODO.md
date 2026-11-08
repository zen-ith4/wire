# CSP status: front-end is CSP-clean

`middleware/csp.js` sends a strict policy (no `'unsafe-inline'`, no `'unsafe-eval'`,
no nonce or hash). The front-end under `public/` now contains none of the constructs
that policy blocks, so `CSP_ENFORCE=true` is safe to enable.

## What is enforced by tests

- `tests/csp-static.test.mjs` asserts a flat zero for every construct, with no
  allowlist: inline `on*=` handlers, `style=""` attributes, `setAttribute('style'|'on*')`
  and `.cssText` writes, `escapeHtml()` inside a quoted attribute, `eval` and string
  timers, `javascript:` URLs, and inline `<script>`, `<style>` or handler attributes in
  `index.html`.
- `tests/csp-handlers-enforced-browser.test.mjs` runs in real Chromium with
  `CSP_ENFORCE=true`. It clicks the converted controls and sweeps every top-level view
  (messages, files, groups, every settings category, every admin page). It asserts zero
  `securitypolicyviolation` events, including `style-src`, and zero `Refused to` console
  errors.
- `tests/groups/group-csp-browser.test.mjs` covers the groups UI the same way.

## How the replacements work

- Static styles became named classes in the stylesheet for their area
  (`css/pages/login.css`, `css/features/settings.css`, `css/utilities.css`).
  Each class carries the same declarations as the inline style it replaced.
- Show/hide that JS toggles through `el.style.display` uses `.js-hidden`
  (`display:none`, not `!important`), so an inline value set by JS still wins.
  Do not use `.hidden` for these: it is `!important` and would block the JS.
- Data-driven values (slider fill, swatch color, upload progress, aspect ratio, the
  background preview) are written as `data-*` attributes and applied through CSSOM by
  `js/ui/dynamic-vars.js`. Colors are checked against a hex pattern and numbers are
  clamped first. `js/ui/dynamic-vars.js` installs a `MutationObserver` at boot
  (`js/core/app.js`), so markup inserted later is covered without a per-call hook.
- Settings markup also goes through `applyDynamicSettingsStyles()`
  (`js/settings/dynamic-style.js`), called wherever settings HTML is written.

## Rules for new code

- Do not write `style="..."` in HTML strings, and do not use `setAttribute('style', ...)`
  or `.cssText`. Put the look in a class. For a value that depends on data, use a
  `data-*` attribute and apply it through `dynamic-vars.js`, or set a single property
  with `el.style.prop = ...` (that is allowed).
- Put any value that lands in an HTML attribute through `escapeHtmlAttr()`.
- Run `node scripts/build-sw-manifest.mjs` after any change under `public/`, then
  `--check`.

## Known gaps

- `open-image-viewer` and attachment download clicks are covered only by steps that
  run when an attachment is already on the page (`if (imgBtn)`). A deterministic test
  is still needed.
- The `CSP header: strict script-src` test in `csp-static.test.mjs` fails on the mock
  response's missing header and is not yet investigated. It fails on the unmodified
  tree too.

## Interim defence (still in place)

Output escaping remains the first line of defence: `escapeHtmlAttr()` for attributes,
escaped text for reactions and reply quotes, and member names in `chat/group.js`
rendered as text.
