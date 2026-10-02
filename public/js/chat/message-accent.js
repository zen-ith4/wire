// ============================================================
// Message bubble accent color
//
// By design, every message bubble — mine or someone else's — is
// painted with the CURRENT VIEWER's own accent color, not the
// sender's. A message's sender never determines its color; only
// "who is looking at the chat right now" does. See settings/theme.js
// for where the viewer picks/persists their accent (PUT
// /api/me/accent-color).
//
// Each message element still gets its own --message-accent /
// --message-accent-contrast custom properties (rather than reading
// the global --accent-bg/--indigo vars directly in CSS) so that a
// live accent change (see repaintAllMessageAccents()) can repaint
// every currently-rendered bubble in one pass without a full
// re-render.
// ============================================================

import { getCurrentUser } from '../core/auth.js';
import {
  ACCENT_PRESETS,
  rgbStringFromHex,
  contrastTextFor,
  getUseAccentForBubbles,
  getCurrentAccentHex
} from '../settings/theme.js';

// Fallback chain:
// 1. Current user's persisted DB accent_color
// 2. Current local accent (wire-accent)
// 3. Neutral preset
//
// This matches the same fallback behavior used by the rest of the
// accent system in settings/theme.js.
const FALLBACK_ACCENT_HEX = ACCENT_PRESETS[0].hex;

function isValidHex(hex) {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex);
}

function currentViewerAccentHex() {
  const me = getCurrentUser();

  if (isValidHex(me?.accent_color)) {
    return me.accent_color;
  }

  return getCurrentAccentHex() || FALLBACK_ACCENT_HEX;
}

function paint(el, hex) {
  // "Use accent color for chat bubbles" OFF -> deliberately leave
  // --message-accent/-contrast unset, so .chat-bubble's own
  // var(--message-accent, var(--ink2)) fallback takes over and the
  // bubble renders with the app's normal default colors instead.
  if (!getUseAccentForBubbles()) {
    el.style.removeProperty('--message-accent');
    el.style.removeProperty('--message-accent-contrast');
    return;
  }

  const rgb = rgbStringFromHex(hex);
  el.style.setProperty('--message-accent', `rgb(${rgb})`);
  el.style.setProperty('--message-accent-contrast', contrastTextFor(rgb));
}

/**
 * Paints a single message element with the CURRENT VIEWER's accent
 * color. Sender identity is intentionally irrelevant here — every
 * bubble, own or not, gets the same color: whoever is looking at the
 * chat right now.
 *
 * @param {HTMLElement} el - the .chat-msg element for this message.
 */
export function setMessageAccent(el) {
  paint(el, currentViewerAccentHex());
}

/**
 * Re-paints every currently-rendered message (group chat + any open
 * DM thread) with the viewer's current accent color. Call this right
 * after the viewer's own accent_color changes (Settings) so already
 * on-screen messages update instantly instead of waiting for the next
 * render/reload.
 */
export function repaintAllMessageAccents() {
  const hex = currentViewerAccentHex();
  document.querySelectorAll('.chat-msg').forEach((el) => paint(el, hex));
}