// ============================================================
// Chat composer — shared by Group Chat and DMs
//
// Owns everything about "typing a message and attaching files":
//   - textarea auto-grow + Enter-to-send / Shift+Enter-for-newline
//   - staging selected/dropped/pasted files above the input instead
//     of uploading them immediately, so the user can see, caption,
//     and remove attachments before anything is sent
//   - sending: text-only, files-only, or files+caption, uploading
//     any staged files concurrently and independently
//
// Keyboard behavior:
//   - Enter sends
//   - Shift+Enter creates a newline
//   - Sending does NOT explicitly focus/blur/show/hide the keyboard
//
// Android behavior:
//   - Do NOT use enterkeyhint="send"
//   - Send button uses pointerdown.preventDefault() so tapping it
//     does not steal focus from the textarea and close the keyboard.
// ============================================================

import { ICONS } from '../icons.js';

import {
  escapeHtml,
  formatBytes,
  showToast
} from '../core/utils.js';

import { xhrUpload } from '../files/upload.js';

import { api } from '../core/api.js';

import {
  createVoiceRecorder,
  isVoiceRecordingSupported
} from '../media/voice-recorder.js';

const MAX_TEXTAREA_HEIGHT = 140;

let chipSeq = 0;

// ============================================================
// DEBUG
// ============================================================

const DEBUG = true;

function debug(
  label,
  data = null
) {
  if (!DEBUG) return;

  let suffix = '';

  if (
    data !== null &&
    data !== undefined
  ) {
    try {
      suffix =
        ` ${JSON.stringify(data)}`;
    } catch {
      suffix = '';
    }
  }

  console.log(
    `[composer] ${label}${suffix}`
  );
}

function debugText(
  message
) {
  if (!DEBUG) return;

  console.log(
    `[composer] ${message}`
  );
}

function getDebugInput(
  inputId
) {
  return document.getElementById(
    inputId
  );
}

function describeElement(
  el
) {
  if (!el) {
    return 'null';
  }

  return [
    `tag=${el.tagName || '?'}`,
    `id=${el.id || ''}`,
    `class=${
      typeof el.className === 'string'
        ? el.className
        : ''
    }`
  ].join(' ');
}

function debugInputState(
  inputId,
  label,
  extra = {}
) {
  if (!DEBUG) return;

  const input =
    getDebugInput(
      inputId
    );

  const active =
    document.activeElement;

  debugText(
    `${label} | ` +
    `active=${describeElement(active)} | ` +
    `input=${describeElement(input)} | ` +
    `activeIsInput=${!!input && active === input} | ` +
    `connected=${!!input && input.isConnected} | ` +
    `valueLength=${input?.value?.length ?? 0}` +
    (
      Object.keys(extra).length
        ? ` | ${Object.entries(extra)
            .map(
              ([key, value]) =>
                `${key}=${String(value)}`
            )
            .join(' | ')}`
        : ''
    )
  );
}

function debugInputLifecycle(
  inputId,
  label
) {
  if (!DEBUG) return;

  const input =
    getDebugInput(
      inputId
    );

  debugText(
    `${label}: node | ` +
    `exists=${!!input} | ` +
    `connected=${!!input && input.isConnected} | ` +
    `active=${describeElement(document.activeElement)}`
  );
}

// ============================================================
// FILE ICON
// ============================================================

function iconForFile(
  file
) {
  const type =
    file.type ||
    '';

  if (
    type.startsWith(
      'image/'
    )
  ) {
    return ICONS.image;
  }

  if (
    type.startsWith(
      'video/'
    )
  ) {
    return ICONS.video;
  }

  if (
    type.startsWith(
      'audio/'
    )
  ) {
    return ICONS.audio;
  }

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
export function createComposer(
  config
) {
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

  let staged = [];

  let currentReply =
    null;

  // Prevent one Enter action from triggering both keydown
  // and beforeinput.
  let sendInProgress =
    false;

  // ==========================================================
  // INPUT
  // ==========================================================

  function getInput() {
    return document.getElementById(
      inputId
    );
  }

  function getStagingEl() {
    return document.getElementById(
      stagingId
    );
  }

  // ==========================================================
  // INPUT DEBUG LISTENERS
  // ==========================================================

  function wireInputDebug() {
    const input =
      getInput();

    if (!input) {
      debug(
        'wireInputDebug: input NOT FOUND',
        {
          inputId
        }
      );

      return;
    }

    if (
      input.__composerDebugWired
    ) {
      debug(
        'wireInputDebug: already attached',
        {
          inputId
        }
      );

      return;
    }

    input.__composerDebugWired =
      true;

    debugText(
      `wireInputDebug: attached | input=${describeElement(input)}`
    );

    input.addEventListener(
      'focus',
      () => {
        debugInputState(
          inputId,
          'EVENT focus'
        );
      }
    );

    input.addEventListener(
      'blur',
      e => {
        const related =
          e.relatedTarget;

        debugText(
          `EVENT blur | ` +
          `related=${describeElement(related)} | ` +
          `activeAfterBlur=${describeElement(document.activeElement)}`
        );
      }
    );

    input.addEventListener(
      'keydown',
      e => {
        debugText(
          `EVENT keydown | ` +
          `key=${JSON.stringify(e.key)} | ` +
          `code=${JSON.stringify(e.code)} | ` +
          `keyCode=${e.keyCode} | ` +
          `which=${e.which} | ` +
          `shift=${e.shiftKey} | ` +
          `ctrl=${e.ctrlKey} | ` +
          `alt=${e.altKey} | ` +
          `meta=${e.metaKey} | ` +
          `composing=${e.isComposing} | ` +
          `repeat=${e.repeat} | ` +
          `defaultPrevented=${e.defaultPrevented}`
        );
      },
      true
    );

    input.addEventListener(
      'keyup',
      e => {
        debugText(
          `EVENT keyup | ` +
          `key=${JSON.stringify(e.key)} | ` +
          `code=${JSON.stringify(e.code)} | ` +
          `keyCode=${e.keyCode} | ` +
          `which=${e.which} | ` +
          `shift=${e.shiftKey} | ` +
          `composing=${e.isComposing} | ` +
          `defaultPrevented=${e.defaultPrevented}`
        );
      },
      true
    );

    input.addEventListener(
      'beforeinput',
      e => {
        debugText(
          `EVENT beforeinput | ` +
          `type=${JSON.stringify(e.inputType)} | ` +
          `data=${JSON.stringify(e.data)} | ` +
          `shift=${e.shiftKey} | ` +
          `defaultPrevented=${e.defaultPrevented}`
        );
      },
      true
    );

    input.addEventListener(
      'input',
      () => {
        debugInputState(
          inputId,
          'EVENT input'
        );
      }
    );

    input.addEventListener(
      'compositionstart',
      () => {
        debugText(
          'EVENT compositionstart'
        );
      }
    );

    input.addEventListener(
      'compositionend',
      () => {
        debugText(
          'EVENT compositionend'
        );
      }
    );
  }

  // ==========================================================
  // SEND BUTTON
  // ==========================================================
  //
  // IMPORTANT:
  //
  // A normal button tap causes the browser/WebView to focus the
  // button before firing click.
  //
  // That causes:
  //
  //   textarea
  //       ↓
  //   blur
  //       ↓
  //   button focus
  //       ↓
  //   keyboard closes
  //       ↓
  //   click
  //
  // We prevent the default pointerdown action instead.
  //
  // This keeps the textarea focused while the click event still
  // fires normally and the existing send handler continues to work.
  // ==========================================================

  function wireSendButton() {
    const buttons =
      document.querySelectorAll(
        '.btn-send'
      );

    if (
      buttons.length === 0
    ) {
      debugText(
        'SEND BUTTON: no .btn-send found'
      );

      return;
    }

    buttons.forEach(
      button => {
        if (
          button.__composerSendButtonWired
        ) {
          return;
        }

        button.__composerSendButtonWired =
          true;

        button.addEventListener(
          'pointerdown',
          e => {
            debugText(
              `SEND BUTTON pointerdown | ` +
              `pointerType=${e.pointerType} | ` +
              `button=${e.button} | ` +
              `activeBefore=${describeElement(document.activeElement)}`
            );

            /*
             * Critical fix:
             *
             * Prevent the button from becoming focused.
             * Do NOT prevent click.
             */
            e.preventDefault();

            debugText(
              `SEND BUTTON pointerdown prevented | ` +
              `defaultPrevented=${e.defaultPrevented} | ` +
              `activeAfter=${describeElement(document.activeElement)}`
            );
          }
        );

        button.addEventListener(
          'focus',
          () => {
            debugText(
              `SEND BUTTON FOCUS | button=${describeElement(button)}`
            );
          },
          true
        );

        button.addEventListener(
          'click',
          e => {
            debugText(
              `SEND BUTTON CLICK | ` +
              `detail=${e.detail} | ` +
              `trusted=${e.isTrusted} | ` +
              `active=${describeElement(document.activeElement)}`
            );
          },
          true
        );
      }
    );

    debugText(
      `SEND BUTTON: wired | count=${buttons.length}`
    );
  }

  // ==========================================================
  // STAGING UI
  // ==========================================================

  function renderStaging() {
    const el =
      getStagingEl();

    if (!el) return;

    if (
      staged.length === 0
    ) {
      el.innerHTML = '';

      el.classList.remove(
        'active'
      );

      return;
    }

    el.classList.add(
      'active'
    );

    el.innerHTML =
      staged
        .map(
          item => `
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
                ? escapeHtml(
                    item.error ||
                      'Failed'
                  )
                : formatBytes(
                    item.file.size
                  )
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
    `
        )
        .join('');
  }

  function setChipProgress(
    key,
    percent
  ) {
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
      fill.style.width =
        `${percent}%`;
    }
  }

  function addFiles(
    fileList
  ) {
    const files =
      Array.from(
        fileList || []
      );

    if (
      files.length === 0
    ) {
      return;
    }

    files.forEach(
      file => {
        staged.push({
          key:
            String(
              ++chipSeq
            ),

          file,

          status:
            'pending',

          progress:
            0,

          error:
            null
        });
      }
    );

    renderStaging();
  }

  function removeFile(
    key
  ) {
    staged =
      staged.filter(
        item =>
          item.key !==
          key
      );

    renderStaging();
  }

  window[
    `__composerRemove_${stagingId}`
  ] = removeFile;

  function cancelUpload(
    key
  ) {
    const item =
      staged.find(
        i =>
          i.key ===
          key
      );

    if (
      !item ||
      item.status !==
        'uploading'
    ) {
      return;
    }

    item.cancelledByUser =
      true;

    if (item.cancel) {
      item.cancel();
    }

    staged =
      staged.filter(
        i =>
          i.key !==
          key
      );

    renderStaging();
  }

  window[
    `__composerCancelUpload_${stagingId}`
  ] = cancelUpload;

  function clearStaged() {
    staged = [];

    renderStaging();
  }

  // ==========================================================
  // REPLY PREVIEW
  // ==========================================================

  function getReplyPreviewEl() {
    return replyPreviewId
      ? document.getElementById(
          replyPreviewId
        )
      : null;
  }

  function replyPreviewText(
    reply
  ) {
    if (reply.content) {
      return escapeHtml(
        reply.content
      );
    }

    if (reply.hasAttachment) {
      const mime =
        reply.attachmentMime ||
        '';

      const kind =
        reply.isVoiceMessage
          ? 'Voice message'
          : mime.startsWith(
              'image/'
            )
            ? 'Photo'
            : mime.startsWith(
                'video/'
              )
              ? 'Video'
              : mime.startsWith(
                  'audio/'
                )
                ? 'Audio'
                : (
                    reply.attachmentName ||
                    'Attachment'
                  );

      return escapeHtml(
        kind
      );
    }

    return '';
  }

  function renderReplyPreview() {
    const el =
      getReplyPreviewEl();

    if (!el) return;

    if (!currentReply) {
      el.innerHTML = '';

      el.classList.remove(
        'active'
      );

      return;
    }

    el.classList.add(
      'active'
    );

    el.innerHTML = `
      <div class="reply-preview-icon">
        ${ICONS.reply}
      </div>

      <div class="reply-preview-body">
        <div class="reply-preview-name">
          Replying to ${escapeHtml(
            currentReply.username
          )}
        </div>

        <div class="reply-preview-text">
          ${replyPreviewText(
            currentReply
          )}
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

  function setReplyTo(
    replyPreview
  ) {
    debug(
      'setReplyTo',
      {
        replyId:
          replyPreview?.id
      }
    );

    currentReply =
      replyPreview;

    renderReplyPreview();

    const input =
      getInput();

    if (input) {
      input.focus({
        preventScroll:
          true
      });
    }
  }

  function clearReply() {
    debug(
      'clearReply'
    );

    currentReply =
      null;

    renderReplyPreview();
  }

  window[
    `__composerCancelReply_${stagingId}`
  ] = clearReply;

  // ==========================================================
  // TEXTAREA
  // ==========================================================

  function autoGrow() {
    const el =
      getInput();

    if (!el) return;

    el.style.height =
      'auto';

    const next =
      Math.min(
        el.scrollHeight,
        MAX_TEXTAREA_HEIGHT
      );

    el.style.height =
      `${next}px`;

    el.style.overflowY =
      el.scrollHeight >
      MAX_TEXTAREA_HEIGHT
        ? 'auto'
        : 'hidden';
  }

  function resetTextareaHeight() {
    const el =
      getInput();

    if (!el) return;

    el.style.height =
      'auto';

    el.style.overflowY =
      'hidden';
  }

  function beginSendFromInput(
    source
  ) {
    debugInputState(
      inputId,
      `BEGIN SEND source=${source}`,
      {
        active:
          document.activeElement ===
          getInput()
      }
    );

    if (sendInProgress) {
      debugText(
        `SEND IGNORED duplicate | source=${source}`
      );

      return;
    }

    sendInProgress =
      true;

    void send()
      .finally(() => {
        sendInProgress =
          false;

        debugInputState(
          inputId,
          `SEND FINISHED source=${source}`
        );
      });
  }

  function wireTextarea() {
    const el =
      getInput();

    if (!el) {
      debug(
        'wireTextarea: INPUT NOT FOUND',
        {
          inputId
        }
      );

      return;
    }

    if (
      el.__composerTextareaWired
    ) {
      debugText(
        'wireTextarea: already attached'
      );

      return;
    }

    el.__composerTextareaWired =
      true;

    debugText(
      `wireTextarea: attached | input=${describeElement(el)}`
    );

    el.removeAttribute(
      'enterkeyhint'
    );

    el.setAttribute(
      'inputmode',
      'text'
    );

    // --------------------------------------------------------
    // KEYDOWN
    // --------------------------------------------------------

    el.addEventListener(
      'keydown',
      e => {
        const isEnter =
          e.key === 'Enter' ||
          e.code === 'Enter' ||
          e.keyCode === 13 ||
          e.which === 13;

        if (!isEnter) {
          return;
        }

        if (
          e.shiftKey
        ) {
          return;
        }

        debugText(
          `SEND TRIGGER keydown | ` +
          `key=${JSON.stringify(e.key)} | ` +
          `code=${JSON.stringify(e.code)} | ` +
          `keyCode=${e.keyCode} | ` +
          `which=${e.which} | ` +
          `shift=${e.shiftKey} | ` +
          `composing=${e.isComposing} | ` +
          `activeBefore=${describeElement(document.activeElement)}`
        );

        e.preventDefault();

        e.stopPropagation();

        e.stopImmediatePropagation();

        debugText(
          `SEND TRIGGER keydown prevented | ` +
          `defaultPrevented=${e.defaultPrevented} | ` +
          `activeAfterPrevent=${describeElement(document.activeElement)}`
        );

        beginSendFromInput(
          'keydown'
        );
      },
      true
    );

    // --------------------------------------------------------
    // BEFOREINPUT
    // --------------------------------------------------------

    el.addEventListener(
      'beforeinput',
      e => {
        if (
          e.inputType !==
            'insertLineBreak' &&
          e.inputType !==
            'insertParagraph'
        ) {
          return;
        }

        if (
          e.shiftKey
        ) {
          return;
        }

        debugText(
          `SEND TRIGGER beforeinput | ` +
          `type=${JSON.stringify(e.inputType)} | ` +
          `data=${JSON.stringify(e.data)} | ` +
          `activeBefore=${describeElement(document.activeElement)}`
        );

        e.preventDefault();

        e.stopPropagation();

        e.stopImmediatePropagation();

        debugText(
          `SEND TRIGGER beforeinput prevented | ` +
          `defaultPrevented=${e.defaultPrevented} | ` +
          `activeAfterPrevent=${describeElement(document.activeElement)}`
        );

        beginSendFromInput(
          'beforeinput'
        );
      },
      true
    );

    el.addEventListener(
      'input',
      autoGrow
    );

    wireInputDebug();
  }

  // ==========================================================
  // SENDING
  // ==========================================================

  async function uploadStagedFile(
    item,
    caption,
    replyToId
  ) {
    item.progress =
      0;

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
          pct => {
            item.progress =
              pct;

            setChipProgress(
              item.key,
              pct
            );
          }
        );

      item.cancel =
        () =>
          uploadPromise.cancel();

      const message =
        await uploadPromise;

      debugText(
        `uploadStagedFile: onMessage BEFORE | key=${item.key}`
      );

      debugInputState(
        inputId,
        'upload: before onMessage'
      );

      onMessage(
        message
      );

      debugInputState(
        inputId,
        'upload: after onMessage'
      );

      return {
        ok:
          true,

        key:
          item.key
      };

    } catch (e) {
      if (
        item.cancelledByUser
      ) {
        return {
          ok:
            false,

          key:
            item.key,

          cancelled:
            true
        };
      }

      item.status =
        'error';

      item.error =
        e.message ||
        'Upload failed';

      showToast(
        `${item.file.name}: ${item.error}`,
        'error'
      );

      return {
        ok:
          false,

        key:
          item.key
      };
    }
  }

  async function send() {
    debugInputState(
      inputId,
      'SEND START'
    );

    debugInputLifecycle(
      inputId,
      'SEND START'
    );

    if (!canSend()) {
      debugText(
        'SEND ABORT | canSend=false'
      );

      return;
    }

    const input =
      getInput();

    const content =
      input
        ? input.value.trim()
        : '';

    const filesToSend =
      staged.filter(
        item =>
          item.status !==
          'uploading'
      );

    debugText(
      `SEND STATE | ` +
      `hasInput=${!!input} | ` +
      `contentLength=${content.length} | ` +
      `stagedCount=${staged.length} | ` +
      `filesToSend=${filesToSend.length} | ` +
      `replyId=${currentReply?.id ?? 'null'}`
    );

    if (
      filesToSend.length ===
        0 &&
      !content
    ) {
      debugText(
        'SEND ABORT | empty message'
      );

      return;
    }

    typingEmitter.stop();

    const replyToId =
      currentReply
        ? currentReply.id
        : null;

    if (
      filesToSend.length ===
      0
    ) {
      try {
        debugInputState(
          inputId,
          'TEXT SEND: before buildTextBody'
        );

        const textBody =
          await buildTextBody(
            content,
            replyToId
          );

        debugInputState(
          inputId,
          'TEXT SEND: after buildTextBody'
        );

        debugText(
          'TEXT SEND: API START'
        );

        const message =
          await api(
            sendTextUrl,
            {
              method:
                'POST',

              headers: {
                'Content-Type':
                  'application/json'
              },

              body:
                JSON.stringify({
                  ...textBody,

                  reply_to_id:
                    replyToId
                })
            }
          );

        debugInputState(
          inputId,
          'TEXT SEND: API COMPLETE'
        );

        debugInputLifecycle(
          inputId,
          'TEXT SEND: after API'
        );

        const inputBeforeClear =
          getInput();

        debugText(
          `TEXT SEND: clearing input | ` +
          `sameNode=${inputBeforeClear === input} | ` +
          `connected=${!!inputBeforeClear && inputBeforeClear.isConnected}`
        );

        if (input) {
          input.value =
            '';

          resetTextareaHeight();
        }

        debugInputState(
          inputId,
          'TEXT SEND: after input clear'
        );

        clearReply();

        debugInputState(
          inputId,
          'TEXT SEND: before onMessage'
        );

        const nodeBeforeMessage =
          getInput();

        onMessage(
          message
        );

        const nodeAfterMessage =
          getInput();

        debugText(
          `TEXT SEND: onMessage DOM comparison | ` +
          `sameOriginal=${input === nodeAfterMessage} | ` +
          `sameBeforeAfter=${nodeBeforeMessage === nodeAfterMessage} | ` +
          `originalConnected=${!!input && input.isConnected} | ` +
          `currentConnected=${!!nodeAfterMessage && nodeAfterMessage.isConnected}`
        );

        debugInputState(
          inputId,
          'TEXT SEND: after onMessage'
        );

        debugInputLifecycle(
          inputId,
          'TEXT SEND: COMPLETE'
        );

      } catch (e) {
        debugText(
          `TEXT SEND: ERROR | ${e?.message || String(e)}`
        );

        showToast(
          e.message,
          'error'
        );
      }

      return;
    }

    // ========================================================
    // ATTACHMENTS
    // ========================================================

    debugInputState(
      inputId,
      'ATTACHMENT SEND: before clear'
    );

    if (input) {
      input.value =
        '';

      resetTextareaHeight();
    }

    debugInputState(
      inputId,
      'ATTACHMENT SEND: after clear'
    );

    clearReply();

    filesToSend.forEach(
      item => {
        item.status =
          'uploading';

        item.progress =
          0;
      }
    );

    renderStaging();

    debugText(
      `ATTACHMENT SEND: uploads START | count=${filesToSend.length}`
    );

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

    debugInputState(
      inputId,
      'ATTACHMENT SEND: uploads COMPLETE'
    );

    const batchKeys =
      new Set(
        filesToSend.map(
          item =>
            item.key
        )
      );

    const failedKeys =
      new Set(
        results
          .map(
            r =>
              r.status ===
              'fulfilled'
                ? r.value
                : null
          )
          .filter(
            v =>
              v &&
              !v.ok
          )
          .map(
            v =>
              v.key
          )
      );

    staged =
      staged.filter(
        item =>
          !batchKeys.has(
            item.key
          ) ||
          failedKeys.has(
            item.key
          )
      );

    renderStaging();

    debugInputState(
      inputId,
      'ATTACHMENT SEND: COMPLETE'
    );
  }

  // ==========================================================
  // FILE INPUT
  // ==========================================================

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

        fileInput.value =
          '';
      }
    );
  }

  // ==========================================================
  // VOICE RECORDING
  // ==========================================================

  let activeRecorder =
    null;

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
          : null
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
    ).padStart(
      2,
      '0'
    )}`;
  }

  function setRecordingUiActive(
    active
  ) {
    const {
      inputArea,
      bar,
      micBtn,
      timeEl
    } =
      getRecordingEls();

    if (inputArea) {
      inputArea.style.display =
        active
          ? 'none'
          : '';
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
    if (activeRecorder) {
      return;
    }

    if (
      !isVoiceRecordingSupported()
    ) {
      showToast(
        'Voice recording is not supported in this browser',
        'error'
      );

      return;
    }

    const recorder =
      createVoiceRecorder({
        onTick:
          elapsedMs => {
            const {
              timeEl
            } =
              getRecordingEls();

            if (timeEl) {
              timeEl.textContent =
                formatRecordingTime(
                  elapsedMs
                );
            }
          },

        onMaxDuration:
          () => {
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
        e.name ===
          'NotAllowedError'
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
    if (!activeRecorder) {
      return;
    }

    const recorder =
      activeRecorder;

    activeRecorder =
      null;

    setRecordingUiActive(
      false
    );

    recorder.cancel();
  }

  async function finishRecording() {
    if (!activeRecorder) {
      return;
    }

    const recorder =
      activeRecorder;

    activeRecorder =
      null;

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

    if (!result) {
      return;
    }

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

    if (!canSend()) {
      return;
    }

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

      onMessage(
        message
      );

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
    } =
      getRecordingEls();

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

  // ==========================================================
  // DESTROY
  // ==========================================================

  function destroy() {
    debug(
      'DESTROY'
    );

    if (activeRecorder) {
      const recorder =
        activeRecorder;

      activeRecorder =
        null;

      recorder.cancel();
    }

    window.removeEventListener(
      'pagehide',
      destroy
    );
  }

  // ==========================================================
  // INITIALIZE
  // ==========================================================

  debug(
    'CREATE COMPOSER',
    {
      inputId,
      fileInputId,
      stagingId
    }
  );

  wireTextarea();

  wireSendButton();

  wireFileInput();

  wireVoiceRecording();

  renderStaging();

  renderReplyPreview();

  window.addEventListener(
    'pagehide',
    destroy
  );

  debugInputState(
    inputId,
    'INITIAL STATE'
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