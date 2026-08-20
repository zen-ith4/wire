// ============================================================
// Typing indicator engine — shared by Chat and DMs
//
// Both features need identical behavior on both sides of the wire:
//   - sender: announce "typing" at most once every REPEAT_INTERVAL_MS
//     while actively typing (not once per keystroke), and announce
//     "stopped" after a short silence.
//   - receiver: show "X is typing…" and auto-hide it if no refresh
//     arrives within REMOTE_TIMEOUT_MS, as a safety net for a lost
//     'stop-typing' event (e.g. a tab closing uncleanly).
//
// Implemented once here instead of duplicating these timers in both
// chat.js and dm.js.
// ============================================================

// How often the sender re-announces "typing" while continuously
// typing. Keeping this well above 0 is what keeps typing indicators
// from generating one socket message per keystroke.
const REPEAT_INTERVAL_MS = 2000;

// How long the sender waits after the last keystroke before telling
// everyone else typing has stopped.
const STOP_AFTER_SILENCE_MS = 2500;

// Receiver-side safety net: hide a remote "is typing" indicator if no
// refresh arrives in this long. Deliberately larger than
// REPEAT_INTERVAL_MS so one missed/delayed message doesn't flicker
// the indicator off while the other person is still typing.
const REMOTE_TIMEOUT_MS = 5000;

/**
 * @param {() => (import('socket.io-client').Socket|null)} getSocket - lazy accessor, since the socket
 *   connects after login, i.e. after this module's callers already exist.
 * @param {string} startEvent - e.g. 'chat:typing'
 * @param {string} stopEvent - e.g. 'chat:stop-typing'
 * @param {() => (object|null)} getPayload - returns the payload to send, or null to skip
 *   entirely (e.g. DMs with no conversation currently open).
 */
export function createTypingEmitter(getSocket, startEvent, stopEvent, getPayload) {
  let lastEmitAt = 0;
  let silenceTimer = null;

  function stop() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
    if (lastEmitAt === 0) return; // never announced "typing", nothing to stop
    lastEmitAt = 0;
    const socket = getSocket();
    const payload = getPayload();
    if (socket && payload !== null) {
      socket.emit(stopEvent, payload);
    }
  }

  function notifyTyping() {
    const payload = getPayload();
    if (payload === null) return; // e.g. no DM conversation open
    const socket = getSocket();
    if (!socket) return;

    const now = Date.now();
    if (now - lastEmitAt > REPEAT_INTERVAL_MS) {
      lastEmitAt = now;
      socket.emit(startEvent, payload);
    }

    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stop, STOP_AFTER_SILENCE_MS);
  }

  return { notifyTyping, stop };
}

/**
 * Tracks who is currently typing on the receiving side, keyed by user
 * id (so group chat can show several typists at once), and calls
 * `renderFn(usernames[])` whenever the set changes.
 */
export function createTypingIndicator(renderFn) {
  const typers = new Map(); // user_id -> { username, timeout }

  function render() {
    renderFn(Array.from(typers.values()).map(t => t.username));
  }

  function set(userId, username) {
    const existing = typers.get(userId);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => {
      typers.delete(userId);
      render();
    }, REMOTE_TIMEOUT_MS);
    typers.set(userId, { username, timeout });
    render();
  }

  function clear(userId) {
    const existing = typers.get(userId);
    if (!existing) return;
    clearTimeout(existing.timeout);
    typers.delete(userId);
    render();
  }

  function clearAll() {
    typers.forEach(t => clearTimeout(t.timeout));
    typers.clear();
    render();
  }

  return { set, clear, clearAll };
}

/**
 * Wires an <input>'s 'input' event to a typing emitter. Shared
 * because chat.js and dm.js both need identical wiring — emit while
 * there's content, stop immediately if the field is cleared.
 */
export function wireTypingInput(inputId, emitter) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('input', () => {
    if (input.value.trim().length > 0) {
      emitter.notifyTyping();
    } else {
      emitter.stop();
    }
  });
}
