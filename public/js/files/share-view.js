// ============================================================
// Landing page for a file share link:  <app>/#share/<token>
//
// The recipient must be signed in to Wire (the router only mounts views
// after login, and every request below is authenticated). The token is
// sent in a JSON body / X-Share-Token header — never in a request URL —
// so it can't end up in server logs. It is kept only in this module's
// closure and dropped when the view is replaced or on logout.
//
// Same viewer and same download code as the Files tab; only the
// "where do the bytes come from" part differs.
// ============================================================

import { api } from '../core/api.js';
import { claimRender } from '../core/view-session.js';
import { resolveServerUrl } from '../core/server.js';
import { esc } from './html.js';
import { ICONS, fileIcon } from '../icons.js';
import { formatBytes, formatDate } from '../core/utils.js';
import { openViewer } from './viewer.js';
import { downloadFromSource, shareLinkSource } from './download.js';
import { describeType, tileKind } from './kinds.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// The token of the link currently on screen. Module-level (not global,
// not in the DOM) so one logout listener can wipe it.
let activeToken = '';

window.addEventListener('wire:logout', () => {
  activeToken = '';
});

function unavailableHtml() {
  return `
    <div class="sv-wrap">
      <div class="sv-card sv-card--error" role="alert">
        <div class="sv-icon sv-icon--error" aria-hidden="true">${ICONS.alert}</div>
        <h1 class="sv-title">This link isn’t available</h1>
        <p class="sv-text">
          It may have expired, been revoked, or the file was removed.
          Ask the person who sent it for a new link.
        </p>
        <div class="sv-actions">
          <button type="button" class="btn btn-primary" data-act="files">Go to My Files</button>
        </div>
      </div>
    </div>
  `;
}

export async function renderSharedFile(params = {}) {
  const isCurrent = claimRender('share-link');
  if (!isCurrent()) return;

  const main = document.getElementById('content-area');
  activeToken = typeof params.token === 'string' ? params.token : '';
  const token = activeToken;

  const goToFiles = () => {
    activeToken = '';
    window.location.hash = 'files';
  };

  main.innerHTML = `
    <div class="sv-wrap">
      <div class="sv-card" role="status">
        <span class="spin" aria-hidden="true"></span>
        <p class="sv-text">Opening shared file…</p>
      </div>
    </div>
  `;

  if (!token) {
    main.innerHTML = unavailableHtml();
    main.querySelector('[data-act="files"]')?.addEventListener('click', goToFiles);
    return;
  }

  let info;

  try {
    info = await api('/api/share/links/resolve', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    if (!isCurrent()) return;

    // The server answers every failure the same way; show one message.
    main.innerHTML = unavailableHtml();
    main.querySelector('[data-act="files"]')?.addEventListener('click', goToFiles);
    return;
  }

  if (!isCurrent()) return;

  const name = info.file_name;
  const kind = info.kind; // 'image' | 'video' | 'audio' | null (from the real bytes)

  const meta = [
    describeType(name, kind),
    formatBytes(info.size),
    info.modified ? `Modified ${formatDate(info.modified)}` : null,
  ].filter(Boolean).join(' · ');

  const expires = info.expires_at
    ? `Expires ${new Date(info.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'This link doesn’t expire';

  main.innerHTML = `
    <div class="sv-wrap">
      <div class="sv-card">
        <div class="files-tile files-tile--${tileKind(name, 'file')} files-tile--xl" aria-hidden="true">
          ${fileIcon(name, 'file')}
        </div>
        <h1 class="sv-title" title="${esc(name)}">${esc(name)}</h1>
        <p class="sv-meta">${esc(meta)}</p>
        <p class="sv-from">Shared by <strong>${esc(info.shared_by)}</strong> · ${esc(expires)}</p>
        <div class="sv-actions">
          ${kind ? `<button type="button" class="btn btn-primary sv-btn" data-act="preview">${ICONS.eye}<span>${kind === 'image' ? 'View' : 'Play'}</span></button>` : ''}
          <button type="button" class="btn ${kind ? '' : 'btn-primary'} sv-btn" data-act="download">${ICONS.download}<span>Download</span></button>
        </div>
        <button type="button" class="sv-link" data-act="files">Go to My Files</button>
      </div>
    </div>
  `;

  const item = {
    name,
    kind,
    size: info.size,
    modified: info.modified,

    async getMedia() {
      if (!activeToken || activeToken !== token) {
        throw new Error('This link is no longer available.');
      }

      const media = await api('/api/share/links/media-token', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ token }),
      });

      return {
        url: resolveServerUrl(
          `/api/share/links/stream/${media.link_id}?token=${encodeURIComponent(media.token)}`
        ),
        mime: media.mime,
      };
    },

    download: () => (
      activeToken === token
        ? downloadFromSource(shareLinkSource(token, name))
        : Promise.resolve()
    ),
  };

  // Listener lives on this render's own node: #content-area is shared
  // by every view and must not accumulate handlers.
  main.querySelector('.sv-wrap').addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;

    if (act === 'preview' && kind) openViewer({ items: [item], index: 0 });
    if (act === 'download') item.download();
    if (act === 'files') goToFiles();
  });
}
