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

import bidiFactory from '../vendor/bidi-js.js';

const bidi =
  bidiFactory();

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
 * @param {string} [config.editPreviewId] Enables edit mode entirely —
 *   only supplied by DM's composer today (see chat/dm.js). Omit to
 *   keep a composer (e.g. group chat's) exactly as it was.
 * @param {(content:string) => object|Promise<object>} [config.buildEditBody]
 *   Same job as buildTextBody, but for the PATCH body of an in-place
 *   edit — no reply_to_id, since a reply target isn't editable.
 * @param {(id:number) => string} [config.editUrlFor] Builds the PATCH
 *   URL for a given message id.
 * @param {(message: object) => void} [config.onEdit] Called with the
 *   server's updated message after a successful edit. Deliberately
 *   separate from onMessage: onMessage's callers (e.g. addDmMessage)
 *   dedupe by id and would silently no-op for a message id already
 *   in the cache.
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
    editPreviewId,
    buildEditBody,
    editUrlFor,
    onEdit,
  } = config;

  let staged = [];

  let currentReply =
    null;

  // Non-null while an existing message is being edited (see
  // setEditMessage/cancelEdit below): { id }. Mutually exclusive
  // with currentReply — entering one clears the other.
  let currentEdit =
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

        <div
          class="reply-preview-text"
          dir="auto"
        >
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

    // Replying and editing are mutually exclusive states of the same
    // composer — starting one cancels the other.
    if (currentEdit) {
      cancelEdit();
    }

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
  // EDIT MODE
  // ==========================================================
  //
  // Only wired up when the caller supplies editPreviewId/
  // buildEditBody/editUrlFor (today: DM's composer only — see
  // chat/dm.js). Without them setEditMessage() is a no-op, so a
  // composer that never passes these config keys (group chat's)
  // behaves exactly as it did before edit mode existed.

  function getEditPreviewEl() {
    return editPreviewId
      ? document.getElementById(
          editPreviewId
        )
      : null;
  }

  function getComposerWrapperEl() {
    const input =
      getInput();

    return input
      ? input.closest(
          '.composer-wrapper'
        )
      : null;
  }

  function renderEditPreview() {
    const el =
      getEditPreviewEl();

    if (!el) return;

    if (!currentEdit) {
      el.innerHTML = '';

      el.classList.remove(
        'active'
      );

      return;
    }

    el.classList.add(
      'active'
    );

    // Deliberately reuses the reply-preview-* classes (same bar,
    // icon, body and close-button styling) — this is the same kind
    // of "composer is doing something with an existing message"
    // affordance as the reply preview, just with a different icon/
    // label, not a second implementation of it.
    el.innerHTML = `
      <div class="reply-preview-icon">
        ${ICONS.edit}
      </div>

      <div class="reply-preview-body">
        <div class="reply-preview-name">
          Editing message
        </div>
      </div>

      <button
        type="button"
        class="reply-preview-close"
        title="Cancel edit"
        onclick="window['__composerCancelEdit_${stagingId}']()"
      >
        ${ICONS.close}
      </button>
    `;
  }

  // Disables attaching/recording while editing: editing is
  // restricted to plain text (see dm.controller.js's editMessage),
  // so nothing staged or recorded here could ever be sent anyway.
  function setAttachDisabled(
    disabled
  ) {
    const fileInput =
      fileInputId
        ? document.getElementById(
            fileInputId
          )
        : null;

    if (fileInput) {
      fileInput.disabled =
        disabled;
    }

    const {
      micBtn
    } =
      getRecordingEls();

    if (micBtn) {
      micBtn.disabled =
        disabled;
    }
  }

  function setEditMessage(
    msg
  ) {
    // Composer wasn't configured for edit mode (e.g. group chat) —
    // do nothing rather than half-enter a broken state.
    if (
      !editPreviewId ||
      !buildEditBody ||
      !editUrlFor
    ) {
      return;
    }

    debug(
      'setEditMessage',
      {
        id: msg?.id
      }
    );

    if (currentReply) {
      clearReply();
    }

    currentEdit = {
      id: msg.id
    };

    const input =
      getInput();

    if (input) {
      input.value =
        msg.content ||
        '';

      autoGrow();
    }

    renderEditPreview();

    const wrapper =
      getComposerWrapperEl();

    if (wrapper) {
      wrapper.classList.add(
        'is-editing'
      );
    }

    setAttachDisabled(
      true
    );

    if (input) {
      input.focus({
        preventScroll:
          true
      });

      const len =
        input.value.length;

      try {
        input.setSelectionRange(
          len,
          len
        );
      } catch {
        // Ignore — non-fatal if the browser refuses on this input
        // state, caret position is a nicety here, not a requirement.
      }
    }
  }

  // Leaves edit mode WITHOUT sending anything and WITHOUT restoring
  // the message's original text — the composer goes back to its
  // normal, empty state exactly like canceling a reply does.
  function cancelEdit() {
    debug(
      'cancelEdit'
    );

    currentEdit =
      null;

    renderEditPreview();

    const wrapper =
      getComposerWrapperEl();

    if (wrapper) {
      wrapper.classList.remove(
        'is-editing'
      );
    }

    setAttachDisabled(
      false
    );

    const input =
      getInput();

    if (input) {
      input.value =
        '';

      clearBidiCaretState();

      resetTextareaHeight();
    }
  }

  window[
    `__composerCancelEdit_${stagingId}`
  ] = cancelEdit;

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

  // ==========================================================
  // BIDIRECTIONAL TEXT / CARET
  // ==========================================================
  //
  // IMPORTANT:
  //
  // `dir="auto"` gives the textarea paragraph-aware bidi
  // behavior, but it does NOT give JavaScript a visual caret
  // navigation model.
  //
  // bidi-js gives us the Unicode Bidirectional Algorithm's
  // resolved embedding levels and visual reorder segments.
  //
  // We use those to build:
  //
  //   visual caret position
  //          ↓
  //   logical selectionStart
  //
  // This means ArrowLeft / ArrowRight can follow the visual
  // direction of mixed RTL/LTR text instead of blindly doing:
  //
  //   position - 1
  //   position + 1
  //
  // The actual textarea value ALWAYS remains in logical order.
  //
  // Example:
  //
  //   hello سلام
  //
  // remains exactly:
  //
  //   h e l l o [space] س ل ا م
  //
  // while caret navigation follows the visual bidi runs.
  //
  // ==========================================================

  /*
   * The current visual caret slot.
   *
   * A logical caret position can occur more than once in a visual
   * caret map because the two sides of an RTL/LTR run boundary
   * can correspond to the same logical boundary.
   *
   * Keeping the visual slot lets us preserve that "affinity"
   * between consecutive ArrowLeft / ArrowRight presses.
   */
  let bidiCaretState =
    null;

  function getBidiLevels(
    text
  ) {
    if (!text) {
      return null;
    }

    try {
      return bidi.getEmbeddingLevels(
        text,
        'ltr'
      );
    } catch (e) {
      debugText(
        `BIDI: getEmbeddingLevels failed | ${e?.message || String(e)}`
      );

      return null;
    }
  }

  function getDirectionAtPosition(
    text,
    position
  ) {
    if (!text) {
      return 'ltr';
    }

    const result =
      getBidiLevels(
        text
      );

    if (
      !result ||
      !result.levels ||
      result.levels.length === 0
    ) {
      return 'ltr';
    }

    const index =
      Math.max(
        0,
        Math.min(
          position,
          result.levels.length - 1
        )
      );

    const level =
      result.levels[index];

    return level % 2 === 1
      ? 'rtl'
      : 'ltr';
  }

  function getParagraphDirection(
    text
  ) {
    if (!text) {
      return 'ltr';
    }

    const result =
      getBidiLevels(
        text
      );

    if (
      !result ||
      !result.paragraphs ||
      result.paragraphs.length === 0
    ) {
      return 'ltr';
    }

    return result.paragraphs[0].level % 2
      ? 'rtl'
      : 'ltr';
  }

  /**
   * Reverse an array range in-place.
   *
   * bidi-js returns reorder segments as inclusive ranges.
   */
  function reverseArrayRange(
    array,
    start,
    end
  ) {
    while (
      start < end
    ) {
      const tmp =
        array[start];

      array[start] =
        array[end];

      array[end] =
        tmp;

      start++;
      end--;
    }
  }

  /**
   * Build the visual order of logical character indices.
   *
   * Example:
   *
   * logical:
   *
   *   abc سلام
   *
   * visual indices become something like:
   *
   *   0 1 2 3 7 6 5 4
   *
   * The actual values depend on the resolved bidi levels.
   */
  function getVisualCharacterOrder(
    text,
    embeddingLevels
  ) {
    if (
      !text ||
      !embeddingLevels ||
      !embeddingLevels.levels
    ) {
      return [];
    }

    const order =
      Array.from(
        {
          length:
            text.length
        },
        (_, index) =>
          index
      );

    try {
      const segments =
        bidi.getReorderSegments(
          text,
          embeddingLevels
        );

      if (
        Array.isArray(
          segments
        )
      ) {
        for (
          const segment
          of segments
        ) {
          if (
            !Array.isArray(
              segment
            ) ||
            segment.length < 2
          ) {
            continue;
          }

          const start =
            Math.max(
              0,
              segment[0]
            );

          const end =
            Math.min(
              order.length - 1,
              segment[1]
            );

          if (
            start <= end
          ) {
            reverseArrayRange(
              order,
              start,
              end
            );
          }
        }
      }

      return order;

    } catch (e) {
      debugText(
        `BIDI: getReorderSegments failed | ${e?.message || String(e)}`
      );

      /*
       * Safe fallback:
       *
       * If bidi-js cannot calculate the visual order, return
       * logical order so the textarea remains usable.
       */
      return order;
    }
  }

  /**
   * Build the visual sequence of logical caret positions.
   *
   * A character has two logical boundaries:
   *
   * LTR character at index i:
   *
   *   left = i
   *   right = i + 1
   *
   * RTL character at index i:
   *
   *   left = i + 1
   *   right = i
   *
   * Therefore the visual caret sequence can contain duplicate
   * logical positions at bidi run boundaries. That is intentional.
   */
  function buildVisualCaretMap(
    text
  ) {
    const empty =
      {
        positions: [],
        visualCharacters: [],
        embeddingLevels: null
      };

    if (!text) {
      return empty;
    }

    const embeddingLevels =
      getBidiLevels(
        text
      );

    if (
      !embeddingLevels ||
      !embeddingLevels.levels
    ) {
      return empty;
    }

    const visualCharacters =
      getVisualCharacterOrder(
        text,
        embeddingLevels
      );

    if (
      visualCharacters.length ===
      0
    ) {
      return {
        positions:
          [0],
        visualCharacters,
        embeddingLevels
      };
    }

    const positions =
      [];

    for (
      const logicalIndex
      of visualCharacters
    ) {
      const level =
        embeddingLevels.levels[
          logicalIndex
        ] ?? 0;

      if (
        level % 2 ===
        1
      ) {
        /*
         * RTL character:
         *
         * visual left side  = logical index + 1
         * visual right side = logical index
         */
        positions.push(
          logicalIndex + 1
        );
      } else {
        /*
         * LTR character:
         *
         * visual left side  = logical index
         * visual right side = logical index + 1
         */
        positions.push(
          logicalIndex
        );
      }
    }

    /*
     * Add the final visual boundary.
     *
     * The right side of the final visual character is the last
     * caret boundary in visual order.
     */
    const finalLogicalIndex =
      visualCharacters[
        visualCharacters.length - 1
      ];

    const finalLevel =
      embeddingLevels.levels[
        finalLogicalIndex
      ] ?? 0;

    positions.push(
      finalLevel % 2 === 1
        ? finalLogicalIndex
        : finalLogicalIndex + 1
    );

    return {
      positions,
      visualCharacters,
      embeddingLevels
    };
  }

  /**
   * Find all visual slots representing one logical caret position.
   */
  function findVisualCaretSlots(
    positions,
    logicalPosition
  ) {
    const slots =
      [];

    for (
      let i = 0;
      i < positions.length;
      i++
    ) {
      if (
        positions[i] ===
        logicalPosition
      ) {
        slots.push(i);
      }
    }

    return slots;
  }

  /**
   * Find the most sensible visual slot for a logical caret
   * when we don't have previous visual-affinity information.
   *
   * For an LTR paragraph we prefer the first occurrence.
   * For an RTL paragraph we prefer the last occurrence.
   *
   * This only matters at bidi run boundaries where the same
   * logical boundary can have two visual representations.
   */
  function findCanonicalVisualCaretSlot(
    positions,
    logicalPosition,
    paragraphDirection
  ) {
    const slots =
      findVisualCaretSlots(
        positions,
        logicalPosition
      );

    if (
      slots.length === 0
    ) {
      return -1;
    }

    if (
      paragraphDirection ===
      'rtl'
    ) {
      return slots[
        slots.length - 1
      ];
    }

    return slots[0];
  }

  /**
   * Find the visual caret slot matching the current textarea
   * selection.
   */
  function resolveCurrentVisualCaretSlot(
    text,
    logicalPosition,
    positions
  ) {
    if (
      bidiCaretState &&
      bidiCaretState.text ===
        text &&
      bidiCaretState.logicalPosition ===
        logicalPosition &&
      bidiCaretState.visualSlot >= 0 &&
      bidiCaretState.visualSlot <
        positions.length &&
      positions[
        bidiCaretState.visualSlot
      ] === logicalPosition
    ) {
      return bidiCaretState.visualSlot;
    }

    return findCanonicalVisualCaretSlot(
      positions,
      logicalPosition,
      getParagraphDirection(
        text
      )
    );
  }

  /**
   * Store caret affinity.
   */
  function setBidiCaretState(
    text,
    logicalPosition,
    visualSlot
  ) {
    bidiCaretState = {
      text,
      logicalPosition,
      visualSlot
    };
  }

  /**
   * Clear bidi caret affinity.
   *
   * Used when the user makes a mouse/touch selection or when
   * the text node changes independently of our caret navigation.
   */
  function clearBidiCaretState() {
    bidiCaretState =
      null;
  }

  /**
   * Move the caret according to the visual bidi order.
   *
   * IMPORTANT:
   *
   * This function does NOT modify the text.
   * It only changes selectionStart/selectionEnd.
   */
  function moveCaretVisually(
    direction
  ) {
    const el =
      getInput();

    if (!el) {
      return false;
    }

    if (
      el.selectionStart ===
        null ||
      el.selectionEnd ===
        null
    ) {
      return false;
    }

    /*
     * Never override normal selection movement.
     *
     * If something is selected, native browser behavior should
     * handle ArrowLeft/ArrowRight.
     */
    if (
      el.selectionStart !==
      el.selectionEnd
    ) {
      clearBidiCaretState();

      return false;
    }

    const text =
      el.value;

    /*
     * Empty input has no bidi map.
     */
    if (!text) {
      clearBidiCaretState();

      return false;
    }

    const logicalPosition =
      el.selectionStart;

    const model =
      buildVisualCaretMap(
        text
      );

    const positions =
      model.positions;

    if (
      positions.length ===
      0
    ) {
      return false;
    }

    let currentSlot =
      resolveCurrentVisualCaretSlot(
        text,
        logicalPosition,
        positions
      );

    if (
      currentSlot < 0
    ) {
      return false;
    }

    /*
     * Visual movement:
     *
     * ArrowLeft  => previous visual caret slot
     * ArrowRight => next visual caret slot
     *
     * This intentionally does NOT assume logicalPosition ± 1.
     */
    const nextSlot =
      direction ===
      'left'
        ? currentSlot - 1
        : currentSlot + 1;

    if (
      nextSlot < 0 ||
      nextSlot >=
        positions.length
    ) {
      return false;
    }

    const nextLogicalPosition =
      positions[
        nextSlot
      ];

    /*
     * If moving one visual slot lands on the exact same logical
     * position, continue through the visual map until we reach
     * another logical position.
     *
     * This handles duplicated boundaries at bidi run edges.
     */
    let resolvedSlot =
      nextSlot;

    while (
      resolvedSlot >= 0 &&
      resolvedSlot <
        positions.length &&
      positions[
        resolvedSlot
      ] === logicalPosition
    ) {
      resolvedSlot +=
        direction ===
        'left'
          ? -1
          : 1;
    }

    if (
      resolvedSlot < 0 ||
      resolvedSlot >=
        positions.length
    ) {
      return false;
    }

    const resolvedPosition =
      positions[
        resolvedSlot
      ];

    if (
      resolvedPosition ===
      logicalPosition
    ) {
      return false;
    }

    try {
      el.setSelectionRange(
        resolvedPosition,
        resolvedPosition
      );

      setBidiCaretState(
        text,
        resolvedPosition,
        resolvedSlot
      );

      debugText(
        `BIDI CARET MOVE | ` +
        `direction=${direction} | ` +
        `logical=${logicalPosition} -> ${resolvedPosition} | ` +
        `visualSlot=${currentSlot} -> ${resolvedSlot}`
      );

      return true;

    } catch (e) {
      debugText(
        `BIDI CARET MOVE failed | ${e?.message || String(e)}`
      );

      return false;
    }
  }

  /**
   * Rebuild the bidi state after text input.
   *
   * We intentionally preserve the logical selection produced by
   * the browser. The visual-affinity model is only used for the
   * next ArrowLeft / ArrowRight operation.
   */
  function handleBidiInput() {
    const el =
      getInput();

    if (!el) {
      return;
    }

    const start =
      el.selectionStart ?? 0;

    const end =
      el.selectionEnd ?? start;

    const text =
      el.value;

    applyBidiState();

    if (!text) {
      clearBidiCaretState();

      return;
    }

    const model =
      buildVisualCaretMap(
        text
      );

    if (
      start === end &&
      model.positions.length
    ) {
      const paragraphDirection =
        getParagraphDirection(
          text
        );

      const visualSlot =
        findCanonicalVisualCaretSlot(
          model.positions,
          start,
          paragraphDirection
        );

      if (
        visualSlot >= 0
      ) {
        setBidiCaretState(
          text,
          start,
          visualSlot
        );
      } else {
        clearBidiCaretState();
      }

    } else {
      clearBidiCaretState();
    }

    /*
     * Keep the logical selection exactly where the browser placed
     * it after the input event.
     *
     * We do this on the next frame because some mobile browsers
     * finish their selection update after the input event.
     */
    requestAnimationFrame(
      () => {
        const current =
          getInput();

        if (!current) {
          return;
        }

        try {
          current.setSelectionRange(
            start,
            end
          );
        } catch {
          // Ignore detached/replaced nodes.
        }
      }
    );
  }

  /**
   * Keep the textarea neutral from the application's point of
   * view while explicitly requesting paragraph-aware bidi layout.
   *
   * `dir="auto"` on textarea is intended to use paragraph-aware
   * bidi behavior. `unicode-bidi: plaintext` makes that behavior
   * explicit instead of depending on surrounding CSS.
   */
  function applyBidiState() {
    const el =
      getInput();

    if (!el) {
      return;
    }

    el.setAttribute(
      'dir',
      'auto'
    );

    /*
     * Explicitly request plaintext bidi behavior.
     *
     * This is particularly important if a global CSS rule or
     * inherited unicode-bidi/direction value is interfering with
     * the textarea.
     */
    el.style.unicodeBidi =
      'plaintext';

    /*
     * Do NOT force direction here.
     *
     * `dir=auto` is responsible for determining the paragraph
     * base direction.
     */
    el.style.textAlign =
      'start';
  }

  function preserveCaret(
    start,
    end
  ) {
    const el =
      getInput();

    if (!el) {
      return;
    }

    requestAnimationFrame(
      () => {
        try {
          el.setSelectionRange(
            start,
            end
          );
        } catch {
          // Ignore selection errors from detached/replaced nodes.
        }
      }
    );
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

    // --------------------------------------------------------
    // BIDI
    // --------------------------------------------------------

    applyBidiState();

    clearBidiCaretState();

    // --------------------------------------------------------
    // MOBILE KEYBOARD
    // --------------------------------------------------------

    el.removeAttribute(
      'enterkeyhint'
    );

    el.setAttribute(
      'inputmode',
      'text'
    );

    // --------------------------------------------------------
    // NEWLINE
    // --------------------------------------------------------

    function insertNewline() {
      const value =
        el.value;

      const start =
        el.selectionStart ?? value.length;

      const end =
        el.selectionEnd ?? start;

      const nextValue =
        value.slice(0, start) +
        '\n' +
        value.slice(end);

      el.value =
        nextValue;

      const nextCaret =
        start + 1;

      el.setSelectionRange(
        nextCaret,
        nextCaret
      );

      autoGrow();

      handleBidiInput();

      /*
       * Programmatic .value changes do not fire input
       * automatically, so notify the rest of the composer.
       */
      try {
        el.dispatchEvent(
          new InputEvent(
            'input',
            {
              bubbles: true,
              inputType: 'insertLineBreak',
              data: '\n'
            }
          )
        );
      } catch {
        el.dispatchEvent(
          new Event(
            'input',
            {
              bubbles: true
            }
          )
        );
      }

      debugText(
        `ENTER -> NEWLINE | ` +
        `start=${start} | ` +
        `end=${end} | ` +
        `caret=${nextCaret}`
      );
    }

    // --------------------------------------------------------
    // KEYDOWN
    // --------------------------------------------------------

    el.addEventListener(
      'keydown',
      e => {
        /*
         * Never interfere with IME composition.
         */
        if (e.isComposing) {
          return;
        }

        /*
         * Modifier-assisted arrows belong to browser/OS.
         */
        if (
          e.ctrlKey ||
          e.altKey ||
          e.metaKey
        ) {
          return;
        }

        /*
         * ------------------------------------------------------
         * VISUAL BIDI CARET NAVIGATION
         * ------------------------------------------------------
         */
        if (
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight'
        ) {
          const moved =
            moveCaretVisually(
              e.key === 'ArrowLeft'
                ? 'left'
                : 'right'
            );

          if (moved) {
            e.preventDefault();
            return;
          }

          return;
        }

        /*
         * ------------------------------------------------------
         * ENTER
         * ------------------------------------------------------
         */
        const isEnter =
          e.key === 'Enter' ||
          e.code === 'Enter' ||
          e.keyCode === 13 ||
          e.which === 13;

        if (!isEnter) {
          return;
        }

        /*
         * ------------------------------------------------------
         * SHIFT + ENTER
         * ------------------------------------------------------
         *
         * Always newline.
         */
        if (e.shiftKey) {
          e.preventDefault();

          insertNewline();

          return;
        }

        /*
         * ------------------------------------------------------
         * MOBILE / VIRTUAL KEYBOARD
         * ------------------------------------------------------
         *
         * Do NOT handle Enter from keydown as Send here.
         *
         * Mobile keyboards may emit keydown Enter for their
         * action key as well. beforeinput handles that case.
         *
         * We identify physical keyboard Enter using the
         * KeyboardEvent's physical-code information.
         */
        const isPhysicalEnter =
          e.code === 'Enter' &&
          e.location === KeyboardEvent.DOM_KEY_LOCATION_STANDARD;

        if (!isPhysicalEnter) {
          return;
        }

        /*
         * Plain physical Enter -> SEND
         */
        e.preventDefault();

        debugText(
          `ENTER -> SEND | ` +
          `key=${JSON.stringify(e.key)} | ` +
          `code=${JSON.stringify(e.code)} | ` +
          `location=${e.location} | ` +
          `shift=${e.shiftKey}`
        );

        beginSendFromInput(
          'physical-enter'
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
          e.inputType !== 'insertLineBreak' &&
          e.inputType !== 'insertParagraph'
        ) {
          return;
        }

        /*
         * ------------------------------------------------------
         * ANY BEFOREINPUT LINE BREAK
         * ------------------------------------------------------
         *
         * This is primarily for mobile virtual keyboards.
         *
         * We always turn it into a newline instead of sending.
         */
        e.preventDefault();

        insertNewline();

        debugText(
          `ENTER -> NEWLINE beforeinput | ` +
          `type=${JSON.stringify(e.inputType)} | ` +
          `data=${JSON.stringify(e.data)} | ` +
          `shift=${e.shiftKey}`
        );
      },
      true
    );

    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    el.addEventListener(
      'input',
      () => {
        autoGrow();

        handleBidiInput();
      }
    );

    // --------------------------------------------------------
    // SELECTION
    // --------------------------------------------------------

    el.addEventListener(
      'select',
      () => {
        if (!DEBUG) {
          return;
        }

        const text =
          el.value;

        const start =
          el.selectionStart ?? 0;

        const end =
          el.selectionEnd ?? start;

        if (
          start !== end
        ) {
          clearBidiCaretState();
        }

        const direction =
          text
            ? getDirectionAtPosition(
                text,
                Math.max(
                  0,
                  Math.min(
                    start,
                    text.length - 1
                  )
                )
              )
            : 'ltr';

        debugText(
          `BIDI selection | ` +
          `start=${start} | ` +
          `end=${end} | ` +
          `direction=${direction}`
        );
      }
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

    // ========================================================
    // EDIT SUBMIT
    // ========================================================
    //
    // A currentEdit in progress takes over Enter/send-button entirely
    // — attachments are never part of an edit (see setAttachDisabled
    // in setEditMessage), so filesToSend below is irrelevant here.
    if (currentEdit) {
      if (!content) {
        debugText(
          'SEND ABORT | empty edit'
        );

        return;
      }

      const editingId =
        currentEdit.id;

      typingEmitter.stop();

      try {
        const editBody =
          await buildEditBody(
            content
          );

        const message =
          await api(
            editUrlFor(
              editingId
            ),
            {
              method:
                'PATCH',

              headers: {
                'Content-Type':
                  'application/json'
              },

              body:
                JSON.stringify(
                  editBody
                )
            }
          );

        // Ends edit mode and clears the input — same "back to
        // normal, nothing left staged" outcome as a successful
        // reply-attached send.
        cancelEdit();

        if (onEdit) {
          onEdit(
            message
          );
        }
      } catch (e) {
        showToast(
          e.message,
          'error'
        );
      }

      return;
    }

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

          clearBidiCaretState();

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

      clearBidiCaretState();

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

    currentEdit =
      null;

    clearBidiCaretState();

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
    setEditMessage,
    cancelEdit,
    destroy
  };
}