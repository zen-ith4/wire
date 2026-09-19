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
import {
  createVoiceRecorder,
  isVoiceRecordingSupported
} from '../media/voice-recorder.js';

const MAX_TEXTAREA_HEIGHT = 140;

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
 * @param {string} config.inputId
 * @param {string} config.fileInputId
 * @param {string} config.stagingId
 * @param {string} [config.replyPreviewId]
 * @param {string} config.sendTextUrl
 * @param {string} config.uploadUrl
 * @param {(content:string, replyToId:number|null) => object|Promise<object>} config.buildTextBody
 * @param {(form: FormData) => void} [config.buildFormExtra]
 * @param {(message: object) => void} config.onMessage
 * @param {{notifyTyping():void, stop():void}} config.typingEmitter
 * @param {() => boolean} [config.canSend]
 * @param {string} [config.inputAreaId]
 * @param {string} [config.micButtonId]
 * @param {string} [config.recordingBarId]
 * @param {string} [config.recordingTimeId]
 * @param {string} [config.recordingCancelId]
 * @param {string} [config.recordingStopId]
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

  // Each entry:
  // { key, file, status: 'pending'|'uploading'|'error', progress, error }
  let staged = [];

  // Message currently being replied to.
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
      <div
        class="attach-chip${item.status === 'error' ? ' error' : ''}${item.status === 'uploading' ? ' uploading' : ''}"
        id="attach-chip-${item.key}"
      >
        <span class="attach-chip-icon">
          ${iconForFile(item.file)}
        </span>

        <div class="attach-chip-info">
          <span
            class="attach-chip-name"
            title="${escapeHtml(item.file.name)}"
          >
            ${escapeHtml(item.file.name)}
          </span>

          <span class="attach-chip-meta">
            ${
              item.status === 'error'
                ? escapeHtml(item.error || 'Failed')
                : formatBytes(item.file.size)
            }
          </span>
        </div>

        ${
          item.status === 'uploading'
            ? `
              <div class="attach-chip-progress">
                <div
                  class="attach-chip-progress-fill"
                  style="width:${item.progress || 0}%"
                ></div>
              </div>

              <button
                type="button"
                class="attach-chip-remove"
                title="Cancel upload"
                aria-label="Cancel upload"
                onclick="window['__composerCancelUpload_${stagingId}']('${item.key}')"
              >
                ${ICONS.close}
              </button>
            `
            : `
              <button
                type="button"
                class="attach-chip-remove"
                title="Remove"
                onclick="window['__composerRemove_${stagingId}']('${item.key}')"
              >
                ${ICONS.close}
              </button>
            `
        }
      </div>
    `).join('');
  }

  function setChipProgress(key, percent) {
    const chip =
      document.getElementById(
        `attach-chip-${key}`
      );

    if (!chip) return;

    const fill =
      chip.querySelector(
        '.attach-chip-progress-fill'
      );

    if (fill) {
      fill.style.width = `${percent}%`;
    }
  }

  function addFiles(fileList) {
    const files =
      Array.from(fileList || []);

    if (files.length === 0) return;

    files.forEach(file => {
      staged.push({
        key: String(++chipSeq),
        file,
        status: 'pending',
        progress: 0,
        error: null
      });
    });

    renderStaging();
  }

  function removeFile(key) {
    staged =
      staged.filter(
        item => item.key !== key
      );

    renderStaging();
  }

  window[`__composerRemove_${stagingId}`] =
    removeFile;

  // Cancels one in-flight upload without touching any other staged
  // item. Aborts the underlying XHR (see item.cancel, set in
  // uploadStagedFile) so the request itself stops, not just its UI.
  function cancelUpload(key) {
    const item =
      staged.find(
        i => i.key === key
      );

    if (!item || item.status !== 'uploading') return;

    item.cancelledByUser = true;

    if (item.cancel) {
      item.cancel();
    }

    staged =
      staged.filter(
        i => i.key !== key
      );

    renderStaging();
  }

  window[`__composerCancelUpload_${stagingId}`] =
    cancelUpload;

  function clearStaged() {
    staged = [];
    renderStaging();
  }

  // ---------- Reply preview ----------

  function getReplyPreviewEl() {
    return replyPreviewId
      ? document.getElementById(replyPreviewId)
      : null;
  }

  function replyPreviewText(reply) {
    if (reply.content) {
      return escapeHtml(reply.content);
    }

    if (reply.hasAttachment) {
      const mime =
        reply.attachmentMime || '';

      const kind =
        reply.isVoiceMessage
          ? 'Voice message'
          : mime.startsWith('image/')
            ? 'Photo'
            : mime.startsWith('video/')
              ? 'Video'
              : mime.startsWith('audio/')
                ? 'Audio'
                : (
                    reply.attachmentName ||
                    'Attachment'
                  );

      return escapeHtml(kind);
    }

    return '';
  }

  function renderReplyPreview() {
    const el =
      getReplyPreviewEl();

    if (!el) return;

    if (!currentReply) {
      el.innerHTML = '';
      el.classList.remove('active');
      return;
    }

    el.classList.add('active');

    el.innerHTML = `
      <div class="reply-preview-icon">
        ${ICONS.reply}
      </div>

      <div class="reply-preview-body">
        <div class="reply-preview-name">
          Replying to ${escapeHtml(currentReply.username)}
        </div>

        <div class="reply-preview-text">
          ${replyPreviewText(currentReply)}
        </div>
      </div>

      <button
        type="button"
        class="reply-preview-close"
        title="Cancel reply"
        onclick="window['__composerCancelReply_${stagingId}']()"
      >
        ${ICONS.close}
      </button>
    `;
  }

  function setReplyTo(replyPreview) {
    currentReply = replyPreview;

    renderReplyPreview();

    const input = getInput();

    if (input) {
      input.focus();
    }
  }

  function clearReply() {
    currentReply = null;
    renderReplyPreview();
  }

  window[`__composerCancelReply_${stagingId}`] =
    clearReply;

  // ---------- Textarea ----------

  function autoGrow() {
    const el = getInput();

    if (!el) return;

    el.style.height = 'auto';

    const next =
      Math.min(
        el.scrollHeight,
        MAX_TEXTAREA_HEIGHT
      );

    el.style.height = `${next}px`;

    el.style.overflowY =
      el.scrollHeight > MAX_TEXTAREA_HEIGHT
        ? 'auto'
        : 'hidden';
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

    el.addEventListener(
      'keydown',
      (e) => {
        if (
          e.key === 'Enter' &&
          !e.shiftKey &&
          !e.isComposing
        ) {
          e.preventDefault();
          send();
        }
      }
    );

    el.addEventListener(
      'input',
      autoGrow
    );
  }

  // ---------- Sending ----------

  async function uploadStagedFile(
    item,
    caption,
    replyToId
  ) {
    item.progress = 0;

    try {
      const form =
        new FormData();

      form.append(
        'file',
        item.file,
        item.file.name
      );

      if (caption) {
        form.append(
          'content',
          caption
        );
      }

      if (replyToId) {
        form.append(
          'reply_to_id',
          replyToId
        );
      }

      if (buildFormExtra) {
        buildFormExtra(form);
      }

      const uploadPromise =
        xhrUpload(
          uploadUrl,
          form,
          (pct) => {
            item.progress = pct;
            setChipProgress(
              item.key,
              pct
            );
          }
        );

      // Exposed so the cancel button (see cancelUpload) can abort
      // this specific request without affecting any other upload.
      item.cancel = () =>
        uploadPromise.cancel();

      const message =
        await uploadPromise;

      onMessage(message);

      return {
        ok: true,
        key: item.key
      };

    } catch (e) {
      // The user already removed this chip from `staged` and
      // aborted the request themselves (see cancelUpload) — nothing
      // left to clean up or surface as an error.
      if (item.cancelledByUser) {
        return {
          ok: false,
          key: item.key,
          cancelled: true
        };
      }

      item.status = 'error';

      item.error =
        e.message ||
        'Upload failed';

      showToast(
        `${item.file.name}: ${item.error}`,
        'error'
      );

      return {
        ok: false,
        key: item.key
      };
    }
  }

  async function send() {
    if (!canSend()) return;

    const input =
      getInput();

    const content =
      input
        ? input.value.trim()
        : '';

    const filesToSend =
      staged.filter(
        item =>
          item.status !== 'uploading'
      );

    if (
      filesToSend.length === 0 &&
      !content
    ) {
      return;
    }

    typingEmitter.stop();

    const replyToId =
      currentReply
        ? currentReply.id
        : null;

    // ---------- Text-only message ----------

    if (filesToSend.length === 0) {
      try {
        /*
         * buildTextBody may now be async.
         *
         * This is important for E2EE because encryption
         * uses Web Crypto and therefore returns a Promise.
         */
        const textBody = await buildTextBody(
            content,
            replyToId
        );

        const message = await api(sendTextUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...textBody,
                reply_to_id: replyToId
            }),
        });

        if (input) {
          input.value = '';
          resetTextareaHeight();
        }

        clearReply();

        onMessage(message);

      } catch (e) {
        showToast(
          e.message,
          'error'
        );
      }

      return;
    }

    // ---------- Attachments ----------

    if (input) {
      input.value = '';
      resetTextareaHeight();
    }

    clearReply();

    filesToSend.forEach(
      item => {
        item.status = 'uploading';
        item.progress = 0;
      }
    );

    renderStaging();

    const results =
      await Promise.allSettled(
        filesToSend.map(
          (item, i) =>
            uploadStagedFile(
              item,
              i === 0
                ? content
                : '',
              i === 0
                ? replyToId
                : null
            )
        )
      );

    const batchKeys =
      new Set(
        filesToSend.map(
          item => item.key
        )
      );

    const failedKeys =
      new Set(
        results
          .map(
            r =>
              r.status === 'fulfilled'
                ? r.value
                : null
          )
          .filter(
            v => v && !v.ok
          )
          .map(
            v => v.key
          )
      );

    staged =
      staged.filter(
        item =>
          !batchKeys.has(item.key) ||
          failedKeys.has(item.key)
      );

    renderStaging();
  }

  // ---------- File input ----------

  function wireFileInput() {
    const fileInput =
      document.getElementById(
        fileInputId
      );

    if (!fileInput) return;

    fileInput.addEventListener(
      'change',
      () => {
        addFiles(
          fileInput.files
        );

        fileInput.value = '';
      }
    );
  }

  // ---------- Voice recording ----------

  let activeRecorder = null;

  function getRecordingEls() {
    return {
      inputArea:
        inputAreaId
          ? document.getElementById(
              inputAreaId
            )
          : null,

      bar:
        recordingBarId
          ? document.getElementById(
              recordingBarId
            )
          : null,

      micBtn:
        micButtonId
          ? document.getElementById(
              micButtonId
            )
          : null,

      timeEl:
        recordingTimeId
          ? document.getElementById(
              recordingTimeId
            )
          : null,
    };
  }

  function formatRecordingTime(
    elapsedMs
  ) {
    const totalSeconds =
      Math.floor(
        elapsedMs / 1000
      );

    const minutes =
      Math.floor(
        totalSeconds / 60
      );

    const seconds =
      totalSeconds % 60;

    return `${minutes}:${String(
      seconds
    ).padStart(2, '0')}`;
  }

  function setRecordingUiActive(
    active
  ) {
    const {
      inputArea,
      bar,
      micBtn,
      timeEl
    } = getRecordingEls();

    if (inputArea) {
      inputArea.style.display =
        active ? 'none' : '';
    }

    if (bar) {
      bar.classList.toggle(
        'active',
        active
      );
    }

    if (micBtn) {
      micBtn.classList.toggle(
        'recording',
        active
      );
    }

    if (
      !active &&
      timeEl
    ) {
      timeEl.textContent =
        '0:00';
    }
  }

  async function startRecording() {
    if (activeRecorder) return;

    if (!isVoiceRecordingSupported()) {
      showToast(
        'Voice recording is not supported in this browser',
        'error'
      );

      return;
    }

    const recorder =
      createVoiceRecorder({
        onTick: (elapsedMs) => {
          const {
            timeEl
          } = getRecordingEls();

          if (timeEl) {
            timeEl.textContent =
              formatRecordingTime(
                elapsedMs
              );
          }
        },

        onMaxDuration: () => {
          showToast(
            'Reached the maximum voice message length',
            'info'
          );

          finishRecording();
        }
      });

    try {
      await recorder.start();

    } catch (e) {
      const message =
        e &&
        e.name === 'NotAllowedError'
          ? 'Microphone permission was denied'
          : (
              e?.message ||
              'Could not start recording'
            );

      showToast(
        message,
        'error'
      );

      return;
    }

    activeRecorder =
      recorder;

    setRecordingUiActive(
      true
    );
  }

  function cancelRecording() {
    if (!activeRecorder) return;

    const recorder =
      activeRecorder;

    activeRecorder = null;

    setRecordingUiActive(
      false
    );

    recorder.cancel();
  }

  async function finishRecording() {
    if (!activeRecorder) return;

    const recorder =
      activeRecorder;

    activeRecorder = null;

    setRecordingUiActive(
      false
    );

    let result;

    try {
      result =
        await recorder.stop();

    } catch (e) {
      showToast(
        e?.message ||
          'Recording failed',
        'error'
      );

      return;
    }

    if (!result) return;

    const {
      blob,
      ext
    } = result;

    const file =
      new File(
        [blob],
        `voice-message-${Date.now()}.${ext}`,
        {
          type:
            blob.type ||
            'audio/webm'
        }
      );

    if (!canSend()) return;

    const replyToId =
      currentReply
        ? currentReply.id
        : null;

    clearReply();

    try {
      const form =
        new FormData();

      form.append(
        'file',
        file,
        file.name
      );

      form.append(
        'is_voice_message',
        '1'
      );

      if (replyToId) {
        form.append(
          'reply_to_id',
          replyToId
        );
      }

      if (buildFormExtra) {
        buildFormExtra(form);
      }

      const message =
        await xhrUpload(
          uploadUrl,
          form,
          () => {}
        );

      onMessage(message);

    } catch (e) {
      showToast(
        e?.message ||
          'Failed to send voice message',
        'error'
      );
    }
  }

  function wireVoiceRecording() {
    const {
      micBtn
    } = getRecordingEls();

    const cancelBtn =
      recordingCancelId
        ? document.getElementById(
            recordingCancelId
          )
        : null;

    const stopBtn =
      recordingStopId
        ? document.getElementById(
            recordingStopId
          )
        : null;

    if (micBtn) {
      micBtn.addEventListener(
        'click',
        startRecording
      );
    }

    if (cancelBtn) {
      cancelBtn.addEventListener(
        'click',
        cancelRecording
      );
    }

    if (stopBtn) {
      stopBtn.addEventListener(
        'click',
        finishRecording
      );
    }
  }

  function destroy() {
    if (activeRecorder) {
      const recorder =
        activeRecorder;

      activeRecorder = null;

      recorder.cancel();
    }

    window.removeEventListener(
      'pagehide',
      destroy
    );
  }

  // ---------- Initialize ----------

  wireTextarea();
  wireFileInput();
  wireVoiceRecording();

  renderStaging();
  renderReplyPreview();

  window.addEventListener(
    'pagehide',
    destroy
  );

  return {
    addFiles,
    removeFile,
    clearStaged,
    send,
    setReplyTo,
    clearReply,
    destroy
  };
}