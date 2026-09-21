// ============================================================
// File share links — the "Copy link" dialog.
//
// Flow: pick an expiry -> Create link -> the link is shown with a Copy
// button. Existing active links for the file are listed underneath and
// can be revoked (two-step, inline: no second dialog, since a native
// modal <dialog> would sit above the app's fake confirm modal).
//
// The link is  <server>/#share/<token>. The token lives in the URL
// fragment on purpose: browsers never send fragments to the server or
// in Referer headers, so it stays out of access logs. The server only
// ever stores a hash of it and can't show it again — that is why old
// links are listed by date, not by URL.
//
// Only the folder owner can create links (server-enforced); the file
// row hides the button for everyone else.
// ============================================================

import { api } from '../core/api.js';
import { getServerEndpoint, isNativeApp } from '../core/server.js';
import { esc } from './html.js';
import { ICONS, fileIcon } from '../icons.js';
import { showToast, formatDate } from '../core/utils.js';
import { openDialog } from './dialog.js';
import { tileKind } from './kinds.js';

const EXPIRY_OPTIONS = [
  { value: 3600, label: '1 hour' },
  { value: 86400, label: '1 day' },
  { value: 604800, label: '7 days' },
  { value: 2592000, label: '30 days' },
  { value: 0, label: 'Never' },
];

const DEFAULT_EXPIRY = 604800;

export function buildShareUrl(token) {
  const base =
    isNativeApp() || window.location.protocol === 'file:'
      ? `${getServerEndpoint()}/`
      : `${window.location.origin}${window.location.pathname}`;

  return `${base}#share/${token}`;
}

/**
 * Copies `text`. Resolves to:
 *   'copied'   the browser confirmed it
 *   'selected' automatic copy failed; `field` (if given) is selected so
 *              the user can copy manually
 * Never claims success it didn't get.
 *
 * `field` must be an <input>/<textarea> INSIDE the open dialog: while a
 * modal <dialog> is open everything outside it is inert, so a temporary
 * element appended to <body> could not be selected or copied.
 */
export async function copyText(text, field = null) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      /* permission denied / not focused: fall through */
    }
  }

  if (field) {
    try {
      field.focus({ preventScroll: true });
      field.select();
      field.setSelectionRange(0, text.length);

      if (document.execCommand && document.execCommand('copy')) {
        return 'copied';
      }
    } catch {
      /* ignore */
    }

    field.focus({ preventScroll: true });
    field.select();
  }

  return 'selected';
}

function expiryText(iso) {
  if (!iso) return 'Never expires';

  const at = new Date(iso);

  return `Expires ${at.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

export function openLinkDialog({ folderId, subpath, file }) {
  const kind = tileKind(file, 'file');
  const query =
    `folder_id=${encodeURIComponent(folderId)}` +
    `&subpath=${encodeURIComponent(subpath || '')}` +
    `&file=${encodeURIComponent(file)}`;

  let alive = true;
  let created = null; // { url, expires_at } for the link made in this session
  let pendingRevoke = null;
  let links = [];

  const { panel, close } = openDialog({
    variant: 'modal',
    className: 'files-linkdlg',
    onClose: () => { alive = false; created = null; },
  });

  panel.innerHTML = `
    <div class="fd-head">
      <div class="files-tile files-tile--${kind}" aria-hidden="true">${fileIcon(file, 'file')}</div>
      <div class="fd-titles">
        <h2 class="fd-title" id="fl-title">Share link</h2>
        <p class="fd-sub" title="${esc(file)}">${esc(file)}</p>
      </div>
      <button type="button" class="fd-close" aria-label="Close" data-act="close" autofocus>${ICONS.close}</button>
    </div>

    <div class="fd-body">
      <p class="fd-help">
        Anyone signed in to Wire who has the link can open this file, until it
        expires or you revoke it. The link never gives access to the rest of
        the folder.
      </p>

      <div class="fl-create">
        <label class="fd-label" for="fl-expiry">Link expires after</label>
        <div class="fl-create-row">
          <select id="fl-expiry" class="fd-select">
            ${EXPIRY_OPTIONS.map((o) =>
              `<option value="${o.value}"${o.value === DEFAULT_EXPIRY ? ' selected' : ''}>${o.label}</option>`
            ).join('')}
          </select>
          <button type="button" class="btn btn-primary fd-btn" data-act="create">
            ${ICONS.link}<span>Create link</span>
          </button>
        </div>
      </div>

      <div class="fl-result" hidden>
        <label class="fd-label" for="fl-url">Your new link</label>
        <div class="fl-url-row">
          <input id="fl-url" class="fl-url" type="text" readonly spellcheck="false" autocomplete="off" autocapitalize="off">
          <button type="button" class="btn btn-primary fd-btn fl-copy" data-act="copy">
            ${ICONS.copy}<span>Copy</span>
          </button>
        </div>
        <p class="fl-status" role="status" aria-live="polite"></p>
        <p class="fl-note">
          ${ICONS.clock}<span class="fl-expiry-note"></span>
        </p>
      </div>

      <div class="fl-existing" hidden>
        <h3 class="fd-section">Active links <span class="fd-count"></span></h3>
        <ul class="fl-list"></ul>
        <p class="fd-hint">
          For security a link can only be shown when it is created. Create a
          new one if you need the address again.
        </p>
      </div>
    </div>

    <div class="fd-foot">
      <button type="button" class="btn fd-btn" data-act="close">Done</button>
    </div>
  `;

  panel.parentElement.setAttribute('aria-labelledby', 'fl-title');

  const $ = (sel) => panel.querySelector(sel);
  const urlInput = $('#fl-url');
  const statusEl = $('.fl-status');
  const createBtn = $('[data-act="create"]');
  const copyBtn = $('[data-act="copy"]');

  function setStatus(text, tone = '') {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  }

  function renderResult() {
    const box = $('.fl-result');

    if (!created) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    urlInput.value = created.url;
    $('.fl-expiry-note').textContent = expiryText(created.expires_at);
  }

  function renderLinks() {
    const wrap = $('.fl-existing');
    const list = $('.fl-list');

    wrap.hidden = links.length === 0;
    $('.fd-count').textContent = links.length ? `(${links.length})` : '';

    list.innerHTML = links.map((link) => {
      const confirming = pendingRevoke === link.id;
      const isNew = created && created.id === link.id;

      return `
        <li class="fl-item${confirming ? ' is-confirming' : ''}" data-id="${link.id}">
          <div class="fl-item-main">
            <div class="fl-item-title">
              Created ${esc(formatDate(link.created_at))}
              ${isNew ? '<span class="fl-badge">New</span>' : ''}
            </div>
            <div class="fl-item-sub">${esc(expiryText(link.expires_at))}</div>
          </div>
          ${confirming ? `
            <div class="fl-confirm" role="group" aria-label="Confirm revoke">
              <span class="fl-confirm-text">Revoke? People using it lose access.</span>
              <button type="button" class="btn fd-btn" data-act="revoke-cancel">Cancel</button>
              <button type="button" class="btn btn-danger fd-btn" data-act="revoke-confirm" data-id="${link.id}">Revoke</button>
            </div>
          ` : `
            <button type="button" class="btn btn-danger-ghost fd-btn" data-act="revoke" data-id="${link.id}"
              aria-label="Revoke link created ${esc(formatDate(link.created_at))}">
              ${ICONS.trash}<span>Revoke</span>
            </button>
          `}
        </li>
      `;
    }).join('');
  }

  async function loadLinks() {
    try {
      const result = await api(`/api/share/links?${query}`);
      if (!alive) return;

      links = Array.isArray(result) ? result : [];
      renderLinks();
    } catch (error) {
      if (alive) showToast(error.message, 'error');
    }
  }

  async function createLink() {
    const expires_in = Number($('#fl-expiry').value);

    createBtn.disabled = true;
    createBtn.classList.add('is-busy');

    try {
      const result = await api('/api/share/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folderId, subpath: subpath || '', file, expires_in }),
      });

      if (!alive) return;

      created = {
        id: result.id,
        url: buildShareUrl(result.token),
        expires_at: result.expires_at,
      };

      renderResult();
      await loadLinks();
      if (!alive) return;

      // Try to copy right away, but only say so if the browser agreed.
      const outcome = await copyText(created.url, urlInput);

      if (!alive) return;

      if (outcome === 'copied') {
        setStatus('Link created and copied to clipboard.', 'ok');
      } else {
        setStatus('Link created. Automatic copy isn’t available here — the link is selected, so copy it manually.', 'warn');
      }

      copyBtn.focus({ preventScroll: true });

    } catch (error) {
      if (alive) showToast(error.message, 'error');
    } finally {
      createBtn.disabled = false;
      createBtn.classList.remove('is-busy');
    }
  }

  async function copyCreated() {
    if (!created) return;

    const outcome = await copyText(created.url, urlInput);

    if (outcome === 'copied') {
      setStatus('Copied to clipboard.', 'ok');
      showToast('Link copied', 'success');
    } else {
      setStatus('Couldn’t copy automatically. The link is selected — copy it manually.', 'warn');
    }
  }

  async function revoke(id) {
    try {
      await api(`/api/share/links/${id}`, { method: 'DELETE' });

      if (!alive) return;

      if (created && created.id === id) {
        created = null;
        renderResult();
        setStatus('');
      }

      pendingRevoke = null;
      links = links.filter((l) => l.id !== id);
      renderLinks();
      showToast('Link revoked', 'success');

    } catch (error) {
      if (alive) showToast(error.message, 'error');
    }
  }

  panel.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;

    const id = Number(btn.dataset.id);

    switch (btn.dataset.act) {
      case 'close': close(); break;
      case 'create': createLink(); break;
      case 'copy': copyCreated(); break;
      case 'revoke': pendingRevoke = id; renderLinks();
        panel.querySelector('[data-act="revoke-cancel"]')?.focus({ preventScroll: true });
        break;
      case 'revoke-cancel': {
        const prev = pendingRevoke;
        pendingRevoke = null;
        renderLinks();
        panel.querySelector(`[data-act="revoke"][data-id="${prev}"]`)?.focus({ preventScroll: true });
        break;
      }
      case 'revoke-confirm': revoke(id); break;
      default: break;
    }
  });

  urlInput.addEventListener('focus', () => urlInput.select());

  loadLinks();

  return { close };
}
