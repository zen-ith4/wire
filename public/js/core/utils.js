export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// URL auto-linking
//
// Turns bare http(s)/www URLs inside plain message text into safe,
// clickable <a> tags — used by chat.js/dm.js in place of a plain
// escapeHtml() call when rendering a message's .chat-bubble content,
// so it's the same single rendering pipeline, just URL-aware.
//
// Security model: only text that both (a) matches URL_REGEX (which
// can only ever start with a literal "http://", "https://", or
// "www.", and can never contain whitespace, <, >, ", or ' — see the
// character class below) and (b) parses via the URL constructor to
// a http:/https: protocol ever becomes an href. Everything else —
// including the non-URL portions of the message, and any candidate
// match that fails either check — goes through the exact same
// escapeHtml() used everywhere else in this codebase. There is no
// separate/parallel sanitization path here, just this URL-detection
// layer sitting in front of the existing one.
// ============================================================

// http(s)://… or www.… — deliberately excludes whitespace and the
// characters that matter for HTML-attribute safety (<, >, ", ')
// directly in the match itself, so a malicious/malformed URL can
// never contain the characters that would let it break out of the
// href="..." attribute it's about to be placed in below.
const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

const TRAILING_PUNCT_CHARS = new Set(['.', ',', '!', '?', ':', ';', "'", '"', ')', ']', '}']);
const BRACKET_PAIRS = { ')': '(', ']': '[', '}': '{' };

// Sentence punctuation (and unbalanced closing brackets) immediately
// after a URL almost never belong to the URL itself — e.g. "check
// this https://example.com." shouldn't include the trailing period
// in the link. Balanced brackets (…/wiki/Foo_(bar)) are the
// exception: a closing bracket is only trimmed if the match doesn't
// already contain a matching, still-open opening bracket.
function trimTrailingPunctuation(url) {
  let trimmed = url;
  let suffix = '';

  while (trimmed.length > 0) {
    const char = trimmed[trimmed.length - 1];
    if (!TRAILING_PUNCT_CHARS.has(char)) break;

    const opening = BRACKET_PAIRS[char];
    if (opening) {
      const opens = trimmed.split(opening).length - 1;
      const closes = trimmed.split(char).length - 1;
      // As many or more opens than closes inside the match means
      // this closing bracket is balancing one of them — keep it.
      if (opens >= closes) break;
    }

    suffix = char + suffix;
    trimmed = trimmed.slice(0, -1);
  }

  return { url: trimmed, suffix };
}

// Resolves a trimmed match to a safe, absolute href, or null if it
// isn't one. Explicit protocol allowlist (only ever http:/https:)
// on top of what URL_REGEX already guarantees, so nothing — not
// javascript:, data:, vbscript:, or anything else — can ever reach
// an href through this function even if the regex above were ever
// loosened later.
function resolveLinkHref(rawUrl) {
  const hasScheme = /^https?:\/\//i.test(rawUrl);
  const candidate = hasScheme ? rawUrl : `https://${rawUrl}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  return parsed.href;
}

export function linkifyHtml(text) {
  if (!text) return '';

  let result = '';
  let lastIndex = 0;
  let match;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const rawMatch = match[0];
    const matchStart = match.index;

    // Plain text before this match — same escaping as always.
    result += escapeHtml(text.slice(lastIndex, matchStart));

    const { url: trimmedUrl, suffix } = trimTrailingPunctuation(rawMatch);
    const href = trimmedUrl ? resolveLinkHref(trimmedUrl) : null;

    if (href) {
      // Display text is the original (trimmed) match exactly as the
      // user typed it — only the href itself gets normalized/
      // scheme-completed. escapeHtml() on both keeps this safe even
      // though URL_REGEX already excludes the characters that would
      // matter for breaking out of the href attribute.
      result += `<a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer" class="chat-link">${escapeHtml(trimmedUrl)}</a>`;
      result += escapeHtml(suffix);
    } else {
      // Matched the shape of a URL but didn't resolve to a safe
      // http(s) link (e.g. malformed) — fall back to plain escaped
      // text, identical to how it'd render without this function.
      result += escapeHtml(rawMatch);
    }

    lastIndex = matchStart + rawMatch.length;
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}

export function escapeAttr(s) {
  // For a value placed inside a double-quoted HTML attribute that the browser then parses as a
  // single-quoted JS string (onclick="fn('<value>')"). Two parsers run in order: HTML first (it
  // decodes entities), JS second. So '&' MUST be escaped first: otherwise a name like
  // x&#39;);evil();(&#39; is turned into x');evil();(' by the HTML parser and closes the JS string.
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function emptyState(icon, title, sub) {
  return `<div class="empty-state">
    ${icon}
    <div class="title">${title}</div>
    <div class="sub">${sub || ''}</div>
  </div>`;
}

export function loadingState() {
  return `<div class="loading-state"><div class="spin"></div> Loading…</div>`;
}

/**
 * Removes `el` from the DOM, playing its CSS exit transition first
 * (the 'msg-exit' class added to a chat message right before removal
 * — see core/motion.css) when the global Animations setting is on.
 * When it's off, this removes `el` synchronously, exactly as a plain
 * `el.remove()` would — no behavior change from before this setting
 * existed. `done`, if given, runs right after the element is
 * detached (for empty-state / cache bookkeeping that has to happen
 * post-removal).
 */
export function animateRemoval(el, done) {
  if (!el) return;

  const animationsOn =
    document.documentElement.getAttribute('data-animations') === 'on';

  if (!animationsOn) {
    el.remove();
    done?.();
    return;
  }

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    el.remove();
    done?.();
  };

  el.addEventListener('transitionend', finish, { once: true });
  // Fallback in case the element has no matching transition running
  // (e.g. it was already hidden, or the transitionend event is
  // otherwise missed) so removal never gets stuck.
  setTimeout(finish, 300);

  el.classList.add('msg-exit');
}

/**
 * Inserts `text` at the current cursor position (or replaces the
 * current selection) inside a text input, then restores focus and
 * places the cursor right after what was just inserted. Generic —
 * used by the emoji picker's composer integration, but not specific
 * to emoji.
 */
export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;

  input.value = input.value.slice(0, start) + text + input.value.slice(end);

  const pos = start + text.length;
  input.focus();
  input.setSelectionRange(pos, pos);
}

export function showToast(msg, type = 'info') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const div = document.createElement('div');
  div.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  div.textContent = msg;
  // A native modal <dialog> lives in the browser's top layer, above any
  // z-index. Attach the toast inside the topmost open one so it stays
  // visible while a Files dialog/viewer is open.
  const openDialogs = document.querySelectorAll('dialog[open]');
  const host = openDialogs.length ? openDialogs[openDialogs.length - 1] : document.body;
  host.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

// Escapes a value for use inside an HTML attribute (single- or double-
// quoted). Unlike escapeAttr() above -- which is written for values that
// get re-parsed as a JS string inside an inline onclick="" handler, and so
// rewrites ' and \ -- this one is for plain data-*/title attributes that
// are read back verbatim via dataset/getAttribute: the browser decodes the
// entities, so the original string round-trips exactly.
export function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
