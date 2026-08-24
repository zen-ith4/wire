'use strict';

const form = document.getElementById('connect-form');
const addressInput = document.getElementById('address');
const connectBtn = document.getElementById('connect-btn');
const connectBtnLabel = document.getElementById('connect-btn-label');
const forgetBtn = document.getElementById('forget-btn');
const statusArea = document.getElementById('status-area');
const hintEl = document.getElementById('connect-hint');

const params = new URLSearchParams(window.location.search);
const autoAttempt = params.get('auto') === '1';
const incomingError = params.get('error');

// The <form> submits natively on Enter (single text input, one submit
// button) — no extra keydown handling needed for that. We just listen
// for the resulting 'submit' event below.

function renderStatus(message, kind) {
  if (!message) {
    statusArea.innerHTML = '';
    return;
  }

  const spinner = kind === 'info' ? '<span class="spin"></span>' : '';
  statusArea.innerHTML = `<div class="status-line ${kind}">${spinner}<span>${escapeHtml(message)}</span></div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setBusy(isBusy, label) {
  connectBtn.disabled = isBusy;
  connectBtnLabel.textContent = label || (isBusy ? 'Connecting…' : 'Connect');
}

async function attemptConnect(address, { isAutoAttempt } = {}) {
  setBusy(true, isAutoAttempt ? 'Connecting…' : 'Connecting…');
  renderStatus(isAutoAttempt ? `Connecting to ${address}…` : 'Connecting…', 'info');

  const result = await window.wireClient.connect(address);

  if (result.success) {
    // main process now navigates the window to the remote server —
    // nothing further to render here.
    renderStatus('Connected. Loading Wire…', 'ok');
    return;
  }

  setBusy(false);
  renderStatus(result.error || 'Could not connect. Please check the address and try again.', 'error');
}

async function init() {
  const saved = await window.wireClient.getSavedServer();

  if (saved) {
    addressInput.value = saved;
    forgetBtn.hidden = false;
  }

  if (incomingError) {
    hintEl.textContent = 'Enter your Wire server address to continue';
    renderStatus(incomingError, 'error');
  }

  if (autoAttempt && saved && !incomingError) {
    attemptConnect(saved, { isAutoAttempt: true });
  }

  addressInput.focus();
  // Put the cursor at the end rather than selecting the pre-filled value.
  const len = addressInput.value.length;
  addressInput.setSelectionRange(len, len);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = addressInput.value.trim();
  if (!value) {
    renderStatus('Please enter a server address.', 'error');
    return;
  }
  attemptConnect(value, { isAutoAttempt: false });
});

forgetBtn.addEventListener('click', async () => {
  await window.wireClient.forgetServer();
  addressInput.value = '';
  forgetBtn.hidden = true;
  renderStatus(null);
  addressInput.focus();
});

init();
