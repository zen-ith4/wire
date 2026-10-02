// ============================================================
// Keyboard shortcuts
// ------------------------------------------------------------
// Wire had no shortcut system before this file: every existing
// keydown listener in the app (Escape-to-close on modals, arrow
// keys inside pickers/sliders, Enter-to-send in the composer,
// etc.) is local to one component and isn't user-configurable.
// This is the one small, app-wide registry: a handful of default
// shortcuts, each stored as {ctrl, alt, shift, meta, code}, with
// optional per-shortcut overrides persisted locally (same
// localStorage convention as every other device-only preference —
// see safeGetStorage/safeSetStorage in settings/theme.js).
//
// Keep this proportional: four defaults today. Adding a new
// shortcut later is one entry in DEFAULT_SHORTCUTS, nothing else.
// ============================================================

import { navigate } from './router.js';
import { safeGetStorage, safeSetStorage } from '../settings/theme.js';

const STORAGE_KEY = 'wire-keyboard-shortcuts';

// ------------------------------------------------------------
// Defaults
// ------------------------------------------------------------
// Alt+digit rather than Ctrl/Cmd+digit: Ctrl/Cmd+1-9 is already
// the browser's own tab-switcher in Chrome and Firefox, and this
// app runs in a plain browser tab as well as Electron/Capacitor.
// These four mirror the four persistent nav items (see
// core/app.js's NAV_ITEMS) — not invented, just exposed.
// ------------------------------------------------------------

export const DEFAULT_SHORTCUTS = [
  {
    id: 'nav-files',
    label: 'Go to My Files',
    sublabel: 'Switch to the My Files tab',
    combo: { ctrl: false, alt: true, shift: false, meta: false, code: 'Digit1' },
    action: () => navigate('files'),
  },
  {
    id: 'nav-chat',
    label: 'Go to Chat',
    sublabel: 'Switch to the Chat tab',
    combo: { ctrl: false, alt: true, shift: false, meta: false, code: 'Digit2' },
    action: () => navigate('chat'),
  },
  {
    id: 'nav-messages',
    label: 'Go to Messages',
    sublabel: 'Switch to the Messages tab',
    combo: { ctrl: false, alt: true, shift: false, meta: false, code: 'Digit3' },
    action: () => navigate('messages'),
  },
  {
    id: 'nav-settings',
    label: 'Go to Settings',
    sublabel: 'Switch to the Settings tab',
    combo: { ctrl: false, alt: true, shift: false, meta: false, code: 'Digit4' },
    action: () => navigate('settings'),
  },
];

// ------------------------------------------------------------
// Persistence — only overrides are stored; defaults stay in code.
// A stored value of `null` for an id means "no shortcut" (the
// user cleared it while resolving a conflict), which is distinct
// from "not customized".
// ------------------------------------------------------------

function loadOverrides() {
  try {
    const raw = safeGetStorage(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides) {
  safeSetStorage(STORAGE_KEY, JSON.stringify(overrides));
}

// ------------------------------------------------------------
// Combo helpers
// ------------------------------------------------------------

const MODIFIER_KEYS = new Set([
  'Control', 'Alt', 'Shift', 'Meta', 'OS',
  'CapsLock', 'Tab', 'ContextMenu', 'Fn', 'FnLock',
  'Hyper', 'Super', 'Symbol', 'SymbolLock',
]);

export function isModifierOnlyKey(key) {
  return MODIFIER_KEYS.has(key);
}

// The physical key (event.code — e.g. "Digit1", "KeyP") is used
// rather than event.key: on a Mac keyboard, Option+digit composes a
// special character ("⌥1" types "¡"), so event.key would silently
// stop matching. event.code reflects the physical key regardless of
// what character a modifier makes it produce.
export function comboFromEvent(e) {
  return {
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
    meta: !!e.metaKey,
    code: e.code,
  };
}

export function comboEquals(a, b) {
  if (!a || !b) return false;
  return (
    !!a.ctrl === !!b.ctrl &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift &&
    !!a.meta === !!b.meta &&
    a.code === b.code
  );
}

const RESERVED_CODES = ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyA', 'KeyR'];

// Browser/OS shortcuts this app must never swallow, even if a
// combo is technically free to assign.
export function isReservedCombo(combo) {
  if (!combo || !combo.code) return false;
  if (combo.code === 'F5') return true;

  const primary = combo.ctrl || combo.meta;
  if (!primary || combo.alt || combo.shift) return false;

  return RESERVED_CODES.includes(combo.code);
}

const isMac = /Mac|iPhone|iPad|iPod/.test(
  navigator.platform || navigator.userAgent || ''
);

const CODE_LABELS = {
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
};

function codeToLabel(code) {
  if (!code) return code;
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

// Returns an array of chip labels (modifiers first, key last) so
// the UI can render each as its own <kbd>.
export function formatCombo(combo) {
  if (!combo || !combo.code) return [];

  const parts = [];
  if (combo.ctrl) parts.push(isMac ? '⌃' : 'Ctrl');
  if (combo.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (combo.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (combo.meta) parts.push(isMac ? '⌘' : 'Win');
  parts.push(codeToLabel(combo.code));
  return parts;
}

// ------------------------------------------------------------
// Reading the current (default + override) state
// ------------------------------------------------------------

export function getAllShortcuts() {
  const overrides = loadOverrides();

  return DEFAULT_SHORTCUTS.map((s) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, s.id);
    const combo = hasOverride ? overrides[s.id] : s.combo;

    return {
      id: s.id,
      label: s.label,
      sublabel: s.sublabel,
      combo: combo || null,
      default: s.combo,
      isCustom: hasOverride,
    };
  });
}

function findDefault(id) {
  return DEFAULT_SHORTCUTS.find((s) => s.id === id) || null;
}

// Returns the shortcut currently bound to `combo`, if any, other
// than `excludingId`. Used by the settings UI before it lets a new
// combo overwrite one already in use.
export function findConflict(combo, excludingId) {
  if (!combo) return null;
  return (
    getAllShortcuts().find(
      (s) => s.id !== excludingId && comboEquals(s.combo, combo)
    ) || null
  );
}

// ------------------------------------------------------------
// Writing
// ------------------------------------------------------------

export function setShortcutCombo(id, combo) {
  if (!findDefault(id)) return;
  const overrides = loadOverrides();
  overrides[id] = combo;
  saveOverrides(overrides);
}

export function clearShortcutCombo(id) {
  if (!findDefault(id)) return;
  const overrides = loadOverrides();
  overrides[id] = null;
  saveOverrides(overrides);
}

export function resetShortcut(id) {
  const overrides = loadOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, id)) {
    delete overrides[id];
    saveOverrides(overrides);
  }
}

export function resetAllShortcuts() {
  saveOverrides({});
}

// ------------------------------------------------------------
// Global dispatch
// ------------------------------------------------------------
// One listener for the whole app session (see initialized guard
// below — same convention as files/dragdrop.js's initDragDrop).
// Reads the current bindings fresh on every keydown, so a change
// made in Settings takes effect immediately with nothing to
// re-attach.
// ------------------------------------------------------------

let initialized = false;
let recordingActive = false;

// The Settings recording UI calls this while it owns the very next
// keydown, so a shortcut isn't also triggered by the same keystroke
// that's being captured as a new binding.
export function setRecordingActive(active) {
  recordingActive = !!active;
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

function handleGlobalKeydown(e) {
  if (recordingActive) return;
  if (isEditableTarget(document.activeElement)) return;
  if (isModifierOnlyKey(e.key)) return;

  const combo = comboFromEvent(e);
  const match = getAllShortcuts().find((s) => comboEquals(s.combo, combo));
  if (!match) return;

  const def = findDefault(match.id);
  if (!def) return;

  e.preventDefault();
  def.action();
}

export function initKeyboardShortcuts() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('keydown', handleGlobalKeydown);
}
