// ============================================================
// Chat composer — shared by Group Chat and DMs
//
// Owns everything about "typing a message and attaching files":
//   - textarea auto-grow + Enter-to-send / Shift+Enter-for-newline
//   - staging selected/dropped/pasted files above the input instead
//     of uploading them immediately, so the user can see, caption,
//     and remove attachments before anything is sent
//   - sending: text-only, files-only, or files+caption, uploading
//     any staged files concurrently and independently (one file
//     failing doesn't stop or block the others)
//
// Implemented once here instead of duplicating this logic in both
// chat.js and dm.js (which already share the typing-indicator engine
// the same way — see typing.js).
// ============================================================

import { ICONS } from '../icons.js';
import { escapeHtml, formatBytes, showToast } from '../core/utils.js';
import { xhrUpload } from '../files/upload.js';
import { api } from '../core/api.js';
import { createVoiceRecorder, isVoiceRecordingSupported } from '../media/voice-recorder.js';

const MAX_TEXTAREA_HEIGHT = 140; // px — grows up to ~6 lines, then scrolls

let chipSeq = 0;

function iconForFile(file) {
  const type = file.type || '';
  if (type.startsWith('image/')) return ICONS.image;
  if (type.startsWith('video/')) return ICONS.video;
  if (type.startsWith('audio/')) return ICONS.audio;
  return ICONS.file;
}

/**
 * @param {object} config
 * @param {string} config.inputId - the composer <textarea> id
 * @param {string} config.fileInputId - the hidden <input type=file> id
 * @param {string} config.stagingId - container id for staged-file chips
 * @param {string} [config.replyPreviewId] - container id for the "Replying to ..." bar
 * @param {string} config.sendTextUrl - endpoint for text-only messages
 * @param {string} config.uploadUrl - endpoint for a single file+caption upload
 * @param {(content:string) => object} config.buildTextBody - JSON body for a text-only send
 * @param {(form: FormData) => void} [config.buildFormExtra] - append extra fields (e.g. recipient_id)
 * @param {(message: object) => void} config.onMessage - called with each server response to render it
 * @param {{notifyTyping():void, stop():void}} config.typingEmitter
 * @param {() => boolean} [config.canSend] - e.g. DMs require an open conversation
 * @param {string} [config.inputAreaId] - the row (textarea + buttons) to hide while recording
 * @param {string} [config.micButtonId] - the mic button that starts recording
 * @param {string} [config.recordingBarId] - container shown in place of inputAreaId while recording
 * @param {string} [config.recordingTimeId] - element that displays the live recording timer
 * @param {string} [config.recordingCancelId] - button that discards the in-progress recording
 * @param {string} [config.recordingStopId] - button that finalizes and sends the recording
 */
export function createComposer(config) {
  const {
    inputId,
    fileInputId,
    stagingId,
    replyPreviewId,
    sendTextUrl,
    uploadUrl,
    buildTextBody,
    buildFormExtra,
    onMessage,
    typingEmitter,
    canSend = () => true,
    inputAreaId,
    micButtonId,
    recordingBarId,
    recordingTimeId,
    recordingCancelId,
    recordingStopId,
  } = config;

  // Each entry: { key, file, status: 'pending'|'uploading'|'error', progress, error }
  let staged = [];

  // The message currently being replied to (or null). Shape matches
  // reply.js/buildReplyPreview(): { id, username, content,
  // hasAttachment, attachmentName, attachmentMime }.
  let currentReply = null;

  function getInput() {
    return document.getElementById(inputId);
  }

  function getStagingEl() {
    return document.getElementById(stagingId);
  }

  // ---------- Staging UI ----------

  function renderStaging() {
    const el = getStagingEl();
    if (!el) return;
    if (staged.length === 0) {
      el.innerHTML = '';
      el.classList.remove('active');
      return;
    }
    el.classList.add('active');
    el.innerHTML = staged.map(item => `
      <div class="attach-chip${item.status === 'error' ? ' error' : ''}${item.status === 'uploading' ? ' uploading' : ''}" id="attach-chip-${item.key}">
        <span class="attach-chip-icon">${iconForFile(item.file)}</span>
        <div class="attach-chip-info">
          <span class="attach-chip-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>
          <span class="attach-chip-meta">${item.status === 'error' ? escapeHtml(item.error || 'Failed') : formatBytes(item.file.size)}</span>
        </div>
        ${item.status === 'uploading' ? `
          <div class="attach-chip-progress"><div class="attach-chip-progress-fill" style="width:${item.progress || 0}%"></div></div>
        ` : `
          <button type="button" class="attach-chip-remove" title="Remove" onclick="window['__composerRemove_${stagingId}']('${item.key}')">${ICONS.close}</button>
        `}
      </div>
    `).join('');
  }

  function setChipProgress(key, percent) {
    const chip = document.getElementById(`attach-chip-${key}`);
    if (!chip) return;
    const fill = chip.querySelector('.attach-chip-progress-fill');
    if (fill) fill.style.width = `${percent}%`;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    files.forEach(file => {
      staged.push({ key: String(++chipSeq), file, status: 'pending', progress: 0, error: null });
    });
    renderStaging();
  }

  function removeFile(key) {
    staged = staged.filter(item => item.key !== key);
    renderStaging();
  }
  // Exposed per-instance (keyed by stagingId) so the inline onclick
  // above can reach the right composer without a global name clash
  // between the chat and DM composers on the same page.
  window[`__composerRemove_${stagingId}`] = removeFile;

  function clearStaged() {
    staged = [];
    renderStaging();
  }

  // ---------- Reply preview ----------

  function getReplyPreviewEl() {
    return replyPreviewId ? document.getElementById(replyPreviewId) : null;
  }

  function replyPreviewText(reply) {
    if (reply.content) return escapeHtml(reply.content);
    if (reply.hasAttachment) {
      const mime = reply.attachmentMime || '';
      const kind = reply.isVoiceMessage ? 'Voice message'
        : mime.startsWith('image/') ? 'Photo'
        : mime.startsWith('video/') ? 'Video'
        : mime.startsWith('audio/') ? 'Audio'
        : (reply.attachmentName || 'Attachment');
      return escapeHtml(kind);
    }
    return '';
  }

  function renderReplyPreview() {
    const el = getReplyPreviewEl();
    if (!el) return;
    if (!currentReply) {
      el.innerHTML = '';
      el.classList.remove('active');
      return;
    }
    el.classList.add('active');
    el.innerHTML = `
      <div class="reply-preview-icon">${ICONS.reply}</div>
      <div class="reply-preview-body">
        <div class="reply-preview-name">Replying to ${escapeHtml(currentReply.username)}</div>
        <div class="reply-preview-text">${replyPreviewText(currentReply)}</div>
      </div>
      <button type="button" class="reply-preview-close" title="Cancel reply" onclick="window['__composerCancelReply_${stagingId}']()">${ICONS.close}</button>
    `;
  }

  /** Called from chat.js/dm.js when the user clicks a message's Reply action. */
  function setReplyTo(replyPreview) {
    currentReply = replyPreview;
    renderReplyPreview();
    const input = getInput();
    if (input) input.focus();
  }

  function clearReply() {
    currentReply = null;
    renderReplyPreview();
  }
  // Exposed per-instance (keyed by stagingId), same pattern as
  // __composerRemove_ above, so the inline onclick on the preview's
  // close button reaches the right composer.
  window[`__composerCancelReply_${stagingId}`] = clearReply;

  // ---------- Textarea: auto-grow + Enter / Shift+Enter ----------

  function autoGrow() {
    const el = getInput();
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }

  function resetTextareaHeight() {
    const el = getInput();
    if (!el) return;
    el.style.height = 'auto';
    el.style.overflowY = 'hidden';
  }

  function wireTextarea() {
    const el = getInput();
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter inserts a newline (default textarea
      // behavior — just don't intercept it). isComposing guards
      // against IME composition (e.g. Persian/CJK input methods)
      // where Enter confirms a candidate rather than submitting.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    el.addEventListener('input', autoGrow);
  }

  // ---------- Sending ----------

  async function uploadStagedFile(item, caption, replyToId) {
    item.progress = 0;
    try {
      const form = new FormData();
      form.append('file', item.file, item.file.name);
      if (caption) form.append('content', caption);
      if (replyToId) form.append('reply_to_id', replyToId);
      if (buildFormExtra) buildFormExtra(form);
      const message = await xhrUpload(uploadUrl, form, (pct) => {
        item.progress = pct;
        setChipProgress(item.key, pct);
      });
      onMessage(message);
      return { ok: true, key: item.key };
    } catch (e) {
      item.status = 'error';
      item.error = e.message || 'Upload failed';
      showToast(`${item.file.name}: ${item.error}`, 'error');
      return { ok: false, key: item.key };
    }
  }

  async function send() {
    if (!canSend()) return;
    const input = getInput();
    const content = input ? input.value.trim() : '';
    const filesToSend = staged.filter(item => item.status !== 'uploading');

    if (filesToSend.length === 0 && !content) return; // nothing to do

    typingEmitter.stop();

    // Captured once at send time — the reply bar (and currentReply)
    // is cleared right after the request goes out, same moment the
    // input itself is cleared below, so it can't apply to whatever
    // the user starts typing next.
    const replyToId = currentReply ? currentReply.id : null;

    // Text-only message — unchanged single round trip.
    if (filesToSend.length === 0) {
      try {
        const message = await api(sendTextUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...buildTextBody(content), reply_to_id: replyToId }),
        });
        if (input) {
          input.value = '';
          resetTextareaHeight();
        }
        clearReply();
        onMessage(message);
      } catch (e) {
        showToast(e.message, 'error');
      }
      return;
    }

    // One or more staged files: upload them all concurrently and
    // independently — Promise.allSettled means a failure on one
    // never stops, blocks, or waits on the others, and never throws
    // out of this function (so the composer/UI can't freeze because
    // of it). The caption (if any) rides along with the first file
    // only, matching the single-file+caption behavior this app
    // already had — there's no "one message, many attachments"
    // concept on the backend to attach it to all of them at once.
    if (input) {
      input.value = '';
      resetTextareaHeight();
    }
    clearReply();
    // Mark the whole batch "uploading" synchronously and render once
    // before any network activity starts, so the progress UI actually
    // appears from the first frame instead of only after everything
    // has already settled.
    filesToSend.forEach(item => { item.status = 'uploading'; item.progress = 0; });
    renderStaging();

    const results = await Promise.allSettled(
      // reply_to_id (like the caption) rides along with the first
      // file only — there's no "one message, many attachments"
      // concept on the backend to attach it to all of them at once.
      filesToSend.map((item, i) => uploadStagedFile(item, i === 0 ? content : '', i === 0 ? replyToId : null))
    );

    // Drop everything that succeeded; keep failed items staged (with
    // their error shown) so the user can see what didn't go through
    // and remove or retry it, instead of it silently vanishing. Only
    // touch items that were actually part of this batch — anything
    // added to `staged` after the batch started (not expected from
    // the UI today, but guarded against) is left untouched.
    const batchKeys = new Set(filesToSend.map(item => item.key));
    const failedKeys = new Set(
      results
        .map(r => (r.status === 'fulfilled' ? r.value : null))
        .filter(v => v && !v.ok)
        .map(v => v.key)
    );
    staged = staged.filter(item => !batchKeys.has(item.key) || failedKeys.has(item.key));
    renderStaging();
  }

  function wireFileInput() {
    const fileInput = document.getElementById(fileInputId);
    if (!fileInput) return;
    fileInput.addEventListener('change', () => {
      addFiles(fileInput.files);
      fileInput.value = ''; // allow re-selecting the same file later
    });
  }

  // ---------- Voice message recording ----------
  //
  // Not staged like a file attachment (there's nothing to caption or
  // reorder before sending — a voice message is finalized and sent
  // in one motion, same as tapping a mic button in any chat app).
  // The composer's normal input row is swapped for a small recording
  // bar (Cancel / timer / Stop) for the duration of the recording.

  // The one createVoiceRecorder() instance currently open, or null
  // when idle. Exactly one of cancelRecording()/finishRecording()/
  // destroy() retires it — see createVoiceRecorder's own resource
  // safety notes for why that's enough to guarantee the mic is
  // released.
  let activeRecorder = null;

  function getRecordingEls() {
    return {
      inputArea: inputAreaId ? document.getElementById(inputAreaId) : null,
      bar: recordingBarId ? document.getElementById(recordingBarId) : null,
      micBtn: micButtonId ? document.getElementById(micButtonId) : null,
      timeEl: recordingTimeId ? document.getElementById(recordingTimeId) : null,
    };
  }

  function formatRecordingTime(elapsedMs) {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function setRecordingUiActive(active) {
    const { inputArea, bar, micBtn, timeEl } = getRecordingEls();
    if (inputArea) inputArea.style.display = active ? 'none' : '';
    if (bar) bar.classList.toggle('active', active);
    if (micBtn) micBtn.classList.toggle('recording', active);
    if (!active && timeEl) timeEl.textContent = '0:00';
  }

  async function startRecording() {
    if (activeRecorder) return; // already recording — mic button is a no-op mid-recording

    if (!isVoiceRecordingSupported()) {
      showToast('Voice recording is not supported in this browser', 'error');
      return;
    }

    const recorder = createVoiceRecorder({
      onTick: (elapsedMs) => {
        const { timeEl } = getRecordingEls();
        if (timeEl) timeEl.textContent = formatRecordingTime(elapsedMs);
      },
      onMaxDuration: () => {
        showToast('Reached the maximum voice message length', 'info');
        finishRecording();
      },
    });

    try {
      await recorder.start();
    } catch (e) {
      // getUserMedia/MediaRecorder failed — recorder.start() already
      // released anything it partially opened before rejecting, so
      // there's nothing further to clean up here.
      const message =
        e && e.name === 'NotAllowedError'
          ? 'Microphone permission was denied'
          : (e && e.message) || 'Could not start recording';
      showToast(message, 'error');
      return;
    }

    activeRecorder = recorder;
    setRecordingUiActive(true);
  }

  /** Discards the in-progress recording without sending anything. */
  function cancelRecording() {
    if (!activeRecorder) return;
    const recorder = activeRecorder;
    activeRecorder = null;
    setRecordingUiActive(false);
    recorder.cancel();
  }

  /** Stops, finalizes, and uploads the in-progress recording as a message. */
  async function finishRecording() {
    if (!activeRecorder) return;
    const recorder = activeRecorder;
    activeRecorder = null;
    setRecordingUiActive(false);

    let result;
    try {
      result = await recorder.stop();
    } catch (e) {
      showToast((e && e.message) || 'Recording failed', 'error');
      return;
    }

    if (!result) return; // nothing captured (e.g. an instant tap-and-release) — treat like a cancel

    const { blob, ext } = result;
    const file = new File([blob], `voice-message-${Date.now()}.${ext}`, {
      type: blob.type || 'audio/webm',
    });

    if (!canSend()) return;

    const replyToId = currentReply ? currentReply.id : null;
    clearReply();

    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('is_voice_message', '1');
      if (replyToId) form.append('reply_to_id', replyToId);
      if (buildFormExtra) buildFormExtra(form);
      // No progress callback needed here — voice messages are small
      // and short-lived enough that a progress bar would just flash.
      const message = await xhrUpload(uploadUrl, form, () => {});
      onMessage(message);
    } catch (e) {
      showToast((e && e.message) || 'Failed to send voice message', 'error');
    }
  }

  function wireVoiceRecording() {
    const { micBtn } = getRecordingEls();
    const cancelBtn = recordingCancelId ? document.getElementById(recordingCancelId) : null;
    const stopBtn = recordingStopId ? document.getElementById(recordingStopId) : null;
    if (micBtn) micBtn.addEventListener('click', startRecording);
    if (cancelBtn) cancelBtn.addEventListener('click', cancelRecording);
    if (stopBtn) stopBtn.addEventListener('click', finishRecording);
  }

  /**
   * Releases any in-progress recording's mic/timer resources.
   * Callers (chat.js/dm.js) must call this before discarding a
   * composer instance — e.g. navigating away mid-recording — since
   * nothing else would otherwise stop that mic stream once the
   * composer's own DOM is torn down by the next render.
   */
  function destroy() {
    if (activeRecorder) {
      const recorder = activeRecorder;
      activeRecorder = null;
      recorder.cancel();
    }
    window.removeEventListener('pagehide', destroy);
  }

  wireTextarea();
  wireFileInput();
  wireVoiceRecording();
  renderStaging();
  renderReplyPreview();

  // Best-effort safety net: if this composer instance is ever
  // garbage-collected while still recording (e.g. a caller forgets
  // to call destroy()), 'pagehide' still fires as the tab is closed/
  // navigated away from entirely, so the mic gets released even in
  // that edge case. destroy() itself is idempotent, so this never
  // double-releases anything when the normal cleanup path already ran.
  window.addEventListener('pagehide', destroy);

  return { addFiles, removeFile, clearStaged, send, setReplyTo, clearReply, destroy };
}
