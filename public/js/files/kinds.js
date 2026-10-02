// ============================================================
// File kinds for the Files tab.
//
// PREVIEWABLE = what gets the in-app viewer/player on click. Anything
// else downloads. (Server side, utils/mediaKind.js re-checks the real
// bytes before streaming, so this list only decides intent.)
// ============================================================

const PREVIEW_EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
  video: ['mp4', 'webm', 'mov'],
  audio: ['mp3', 'wav', 'flac', 'ogg'],
};

const AUDIO_ICON_EXTENSIONS = ['aac', 'wma', 'm4a', 'opus', 'oga'];

export function extensionOf(name) {
  const value = String(name || '');
  const dot = value.lastIndexOf('.');

  // "README" and ".gitignore" have no extension.
  if (dot <= 0 || dot === value.length - 1) return '';

  return value.slice(dot + 1).toLowerCase();
}

/** 'image' | 'video' | 'audio' when the viewer can open it, else null. */
export function previewKind(name) {
  const ext = extensionOf(name);
  if (!ext) return null;

  for (const [kind, list] of Object.entries(PREVIEW_EXTENSIONS)) {
    if (list.includes(ext)) return kind;
  }

  return null;
}

/** Visual category for the icon tile: folder | image | video | audio | file */
export function tileKind(name, type) {
  if (type === 'dir') return 'folder';

  const kind = previewKind(name);
  if (kind) return kind;

  return AUDIO_ICON_EXTENSIONS.includes(extensionOf(name)) ? 'audio' : 'file';
}

const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio' };

/** "PNG image", "MP3 audio" ... */
export function describeType(name, kind) {
  const ext = extensionOf(name).toUpperCase();
  const label = (KIND_LABEL[kind] || 'File').toLowerCase();

  return ext ? `${ext} ${label}` : label[0].toUpperCase() + label.slice(1);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');

  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${ss}`
    : `${m}:${ss}`;
}
