import { api } from './api.js';
import { ICONS } from './icons.js';
import { showToast, emptyState, loadingState, escapeHtml, formatDate } from './utils.js';

export async function renderWireguard() {
  const main = document.getElementById('content-area');
  main.innerHTML = `<div class="card">${loadingState()}</div>`;

  try {
    const peers = await api('/api/admin/wireguard');
    let rows = peers.map(p => `
      <tr class="file-row">
        <td>${escapeHtml(p.username)}</td>
        <td class="text-muted">${escapeHtml(p.vpn_ip)}</td>
        <td>${p.online ? '<span class="badge badge-green"><span class="badge-dot"></span>Online</span>' : '<span class="badge badge-red"><span class="badge-dot"></span>Offline</span>'}</td>
        <td class="col-right text-muted">${p.last_handshake ? formatDate(p.last_handshake) : 'never'}</td>
      </tr>
    `).join('');

    main.innerHTML = `<div class="card">
      <div class="card-head"><div class="card-title">${ICONS.shield} WireGuard Peers</div></div>
      <div class="toolbar">
        <input type="text" id="wg-pubkey" placeholder="Peer public key" style="min-width:260px;">
        <input type="text" id="wg-username" placeholder="Friendly name">
        <button class="btn btn-primary btn-sm" onclick="window.mapWireguardPeer()">Map name</button>
      </div>
      <table class="file-table">
        <thead><tr><th>Name</th><th>VPN IP</th><th>Status</th><th class="col-right">Last handshake</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">${emptyState(ICONS.shield, 'No peers detected', 'Make sure wg interface is reachable.')}</td></tr>`}</tbody>
      </table>
    </div>`;
  } catch (e) {
    main.innerHTML = `<div class="card">${emptyState(ICONS.empty, 'Failed to load', escapeHtml(e.message))}</div>`;
  }
}

window.mapWireguardPeer = async function() {
  const public_key = document.getElementById('wg-pubkey').value.trim();
  const username = document.getElementById('wg-username').value.trim();

  if (!public_key || !username) return;

  try {
    await api('/api/admin/wireguard/peers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key, username }),
    });
    renderWireguard();
    showToast('Peer mapped', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
};