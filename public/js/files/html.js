// Escaping for the Files modules.
//
// core/utils.js escapeHtml() is fine for element text but does NOT
// escape quotes (it round-trips through textContent/innerHTML), so it
// must never be used inside an attribute value. esc() escapes all five
// characters and is safe in both places. File and folder names are
// attacker-controlled (anyone who can upload chooses them), so every
// interpolation in these modules goes through it.

const MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
}
