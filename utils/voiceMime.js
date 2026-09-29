const { baseMime } = require('./mediaKind');

// file-type reports some audio containers with parameters
// ("audio/ogg; codecs=opus") or a non-standard name ("audio/x-m4a").
// Neither string is on the inline-safe allowlist (utils/inlineSafeMime.js),
// so those files used to fall through to application/octet-stream:
// they were served as a forced download and never flagged as voice.
// This maps the sniffed value to the canonical allowlisted spelling.
function normalizeSniffedMime(sniffed) {
  const base = baseMime(sniffed);

  if (!base) return null;
  if (base === 'audio/x-m4a') return 'audio/mp4';

  return base;
}

// Containers MediaRecorder can produce, and the audio/* type each one
// is stored as when the client says "this is a voice recording".
// Sniffing alone can't tell an audio-only webm/mp4/ogg from a video
// file in the same container, so this leans on the client's claim.
// That is safe because it only ever relabels between types that are
// BOTH already on the inline-safe allowlist.
const VOICE_CONTAINER_MAP = {
  'video/webm': 'audio/webm',
  'audio/webm': 'audio/webm',
  'audio/ogg': 'audio/ogg',
  'video/ogg': 'audio/ogg',
  'audio/mp4': 'audio/mp4',
  'video/mp4': 'audio/mp4',
};

function isTruthyFlag(value) {
  return value === '1' || value === 'true' || value === true;
}

// Returns the audio/* mime to store, or null when this upload is not a
// (verifiable) voice recording.
function resolveVoiceMime(sniffedMime, clientMime, rawFlag) {
  if (!isTruthyFlag(rawFlag)) return null;
  if (typeof clientMime !== 'string' || !clientMime.startsWith('audio/')) {
    return null;
  }

  return VOICE_CONTAINER_MAP[baseMime(sniffedMime)] || null;
}

module.exports = {
  normalizeSniffedMime,
  resolveVoiceMime,
};
