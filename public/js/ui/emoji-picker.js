// ============================================================
// Emoji picker
// ------------------------------------------------------------
// One picker instance is created lazily on first use and reused
// for the rest of the session — by both the message composer and
// message reactions (see chat.js / dm.js). It never gets removed
// from the DOM once created; opening it again just repositions and
// re-shows the same node, which is what makes repeated opens
// flicker-free (no rebuild, no layout thrash).
//
// This module owns *only* picker mechanics (rendering, search,
// categories, recents, skin tone, positioning, open/close). It has
// no opinion about what selecting an emoji *does* — every call to
// openEmojiPicker() supplies its own onSelect callback, so the
// composer can insert a character into an input while a reaction
// button can call a completely different API. That separation
// is what lets one picker serve two very different features.
// ============================================================

import { CATEGORIES, EMOJI } from '../vendor/emoji-data.js';

const RECENTS_KEY = 'wire-emoji-recents';
const SKIN_KEY = 'wire-emoji-skin';
const MAX_RECENTS = 24;

const SKIN_SWATCH_COLORS = [
  '#9A9AA3',
  '#FFE0BD',
  '#F1C27D',
  '#E0AC69',
  '#C68642',
  '#8D5524'
];

const SKIN_LABELS = [
  'Default',
  'Light',
  'Medium-Light',
  'Medium',
  'Medium-Dark',
  'Dark'
];

const SEARCH_ICON = `
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <circle cx="10.5" cy="10.5" r="6.5"/>
    <line x1="16" y1="16" x2="21" y2="21"/>
  </svg>
`;

// ---------------- Persisted state ----------------

function getRecents() {
  try {
    return JSON.parse(
      localStorage.getItem(RECENTS_KEY)
    ) || [];
  } catch (e) {
    return [];
  }
}

function pushRecent(id) {
  const recents = getRecents().filter(
    r => r !== id
  );

  recents.unshift(id);

  try {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(
        recents.slice(0, MAX_RECENTS)
      )
    );
  } catch (e) {
    // Storage disabled/full — recents just won't persist this session.
  }
}

function getSkin() {
  try {
    const n = Number(
      localStorage.getItem(SKIN_KEY)
    );

    return Number.isInteger(n) &&
      n >= 0 &&
      n <= 5
      ? n
      : 0;
  } catch (e) {
    return 0;
  }
}

function setSkin(n) {
  try {
    localStorage.setItem(
      SKIN_KEY,
      String(n)
    );
  } catch (e) {
    // Non-fatal — falls back to the default tone next load.
  }
}

/**
 * Emoji Mart stores the default/native emoji at skins[0].
 *
 * currentSkin:
 *   0 = default
 *   1 = light
 *   2 = medium-light
 *   3 = medium
 *   4 = medium-dark
 *   5 = dark
 *
 * Therefore currentSkin directly maps to the Emoji Mart skins index.
 */
function emojiChar(item, skin) {
  if (!item.skin || skin <= 0) {
    return item.char;
  }

  const skinData = item.skins?.[skin];

  return skinData?.native || item.char;
}

// ---------------- Module state (the one shared instance) ----------------

let pickerEl = null;
let onSelectCallback = null;
let currentSkin = getSkin();
let isOpen = false;

const emojiById = new Map(
  EMOJI.map(e => [e.id, e])
);

// ---------------- DOM construction (built once) ----------------

function buildPicker() {
  const el = document.createElement('div');

  el.className = 'emoji-picker';

  el.setAttribute(
    'role',
    'dialog'
  );

  el.setAttribute(
    'aria-label',
    'Emoji picker'
  );

  el.innerHTML = `
    <div class="emoji-picker-header">
      <div class="emoji-picker-search-wrap">
        <span class="emoji-picker-search-icon">
          ${SEARCH_ICON}
        </span>

        <input
          type="text"
          class="emoji-picker-search"
          placeholder="Search emoji…"
          autocomplete="off"
        >
      </div>

      <button
        type="button"
        class="emoji-picker-skin-btn"
        title="Skin tone"
      ></button>
    </div>

    <div class="emoji-picker-tabs"></div>

    <div class="emoji-picker-body"></div>

    <div class="emoji-picker-skin-menu"></div>
  `;

  const tabsEl = el.querySelector(
    '.emoji-picker-tabs'
  );

  tabsEl.innerHTML = CATEGORIES.map(cat =>
    `
      <button
        type="button"
        class="emoji-picker-tab"
        data-cat="${cat.id}"
        title="${cat.name}"
      >
        ${cat.icon}
      </button>
    `
  ).join('');

  const skinMenuEl = el.querySelector(
    '.emoji-picker-skin-menu'
  );

  skinMenuEl.innerHTML =
    SKIN_SWATCH_COLORS.map((color, i) =>
      `
        <button
          type="button"
          class="emoji-picker-skin-swatch"
          data-skin="${i}"
          title="${SKIN_LABELS[i]}"
          style="--swatch:${color};"
        ></button>
      `
    ).join('');

  // ---- Search ----

  const searchInput = el.querySelector(
    '.emoji-picker-search'
  );

  searchInput.addEventListener(
    'input',
    () => {
      renderBody(
        el,
        searchInput.value
      );
    }
  );

  // ---- Category tabs ----

  tabsEl.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest(
        '.emoji-picker-tab'
      );

      if (!btn) return;

      const section = el.querySelector(
        `.emoji-picker-section[data-cat="${btn.dataset.cat}"]`
      );

      if (section) {
        section.scrollIntoView({
          block: 'start'
        });
      }
    }
  );

  // ---- Skin tone button ----

  const skinBtn = el.querySelector(
    '.emoji-picker-skin-btn'
  );

  skinBtn.addEventListener(
    'click',
    (e) => {
      e.stopPropagation();

      skinMenuEl.classList.toggle(
        'active'
      );
    }
  );

  // ---- Skin tone menu ----

  skinMenuEl.addEventListener(
    'click',
    (e) => {
      const swatch = e.target.closest(
        '.emoji-picker-skin-swatch'
      );

      if (!swatch) return;

      currentSkin = Number(
        swatch.dataset.skin
      );

      setSkin(currentSkin);

      updateSkinButton(el);

      skinMenuEl.classList.remove(
        'active'
      );

      renderBody(
        el,
        searchInput.value
      );
    }
  );

  // ---- Emoji selection ----

  el.querySelector(
    '.emoji-picker-body'
  ).addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest(
        '.emoji-picker-emoji'
      );

      if (!btn) return;

      const item = emojiById.get(
        btn.dataset.id
      );

      if (!item) return;

      pushRecent(item.id);

      const char = emojiChar(
        item,
        currentSkin
      );

      if (onSelectCallback) {
        onSelectCallback(char);
      }

      closeEmojiPicker();
    }
  );

  // Stop clicks inside the picker from being
  // treated as outside clicks.
  el.addEventListener(
    'click',
    (e) => {
      e.stopPropagation();
    }
  );

  updateSkinButton(el);

  return el;
}

function updateSkinButton(el) {
  const btn = el.querySelector(
    '.emoji-picker-skin-btn'
  );

  btn.style.setProperty(
    '--swatch',
    SKIN_SWATCH_COLORS[currentSkin]
  );
}

// ---------------- Rendering ----------------

function renderBody(el, query) {
  const body = el.querySelector(
    '.emoji-picker-body'
  );

  const tabsEl = el.querySelector(
    '.emoji-picker-tabs'
  );

  const q = query
    .trim()
    .toLowerCase();

  // ---- Search ----

  if (q) {
    tabsEl.classList.add('hidden');

    const matches = EMOJI.filter(
      item =>
        item.name
          .toLowerCase()
          .includes(q) ||

        item.kw.includes(q) ||

        item.id
          .toLowerCase()
          .includes(q)
    );

    body.innerHTML = matches.length
      ? `
        <div
          class="emoji-picker-section"
          data-cat="search"
        >
          <div class="emoji-picker-section-title">
            Search Results
          </div>

          <div class="emoji-picker-grid">
            ${matches
              .map(item => emojiButtonHtml(item))
              .join('')}
          </div>
        </div>
      `
      : `
        <div class="emoji-picker-empty">
          No emoji found
        </div>
      `;

    return;
  }

  tabsEl.classList.remove(
    'hidden'
  );

  // ---- Recents ----

  const recents = getRecents()
    .map(id => emojiById.get(id))
    .filter(Boolean);

  const sections = [];

  if (recents.length) {
    sections.push(`
      <div
        class="emoji-picker-section"
        data-cat="recent"
      >
        <div class="emoji-picker-section-title">
          Frequently Used
        </div>

        <div class="emoji-picker-grid">
          ${recents
            .map(item => emojiButtonHtml(item))
            .join('')}
        </div>
      </div>
    `);
  }

  // ---- Categories ----

  for (const cat of CATEGORIES) {
    const items = EMOJI.filter(
      item => item.cat === cat.id
    );

    sections.push(`
      <div
        class="emoji-picker-section"
        data-cat="${cat.id}"
      >
        <div class="emoji-picker-section-title">
          ${cat.name}
        </div>

        <div class="emoji-picker-grid">
          ${items
            .map(item => emojiButtonHtml(item))
            .join('')}
        </div>
      </div>
    `);
  }

  body.innerHTML =
    sections.join('');
}

function emojiButtonHtml(item) {
  return `
    <button
      type="button"
      class="emoji-picker-emoji"
      data-id="${item.id}"
      title="${item.name}"
    >
      ${item.char}
    </button>
  `;
}

// ---------------- Positioning ----------------

function positionPicker(el, anchorEl) {
  const rect =
    anchorEl.getBoundingClientRect();

  const pickerRect =
    el.getBoundingClientRect();

  const margin = 8;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer opening upward from the trigger.
  // Flip to below only if there isn't enough room above.
  let top =
    rect.top -
    pickerRect.height -
    margin;

  if (top < margin) {
    top =
      rect.bottom +
      margin;
  }

  top = Math.min(
    Math.max(
      top,
      margin
    ),
    vh -
      pickerRect.height -
      margin
  );

  let left = rect.left;

  left = Math.min(
    Math.max(
      left,
      margin
    ),
    vw -
      pickerRect.width -
      margin
  );

  el.style.top =
    `${top}px`;

  el.style.left =
    `${left}px`;
}

// ---------------- Outside click / Escape ----------------

function handleDocumentClick(e) {
  if (
    pickerEl &&
    !pickerEl.contains(e.target)
  ) {
    closeEmojiPicker();
  }
}

function handleDocumentKeydown(e) {
  if (e.key === 'Escape') {
    closeEmojiPicker();
  }
}

// ---------------- Public API ----------------

/**
 * Opens the shared picker anchored near `anchorEl`.
 *
 * `onSelect(char)` is called with the chosen emoji's
 * native character, already carrying the selected
 * skin-tone modifier when applicable.
 *
 * What happens with the character is entirely up to
 * the caller.
 */
export function openEmojiPicker({
  anchorEl,
  onSelect
}) {
  if (
    !anchorEl ||
    typeof onSelect !== 'function'
  ) {
    return;
  }

  if (!pickerEl) {
    pickerEl = buildPicker();

    document.body.appendChild(
      pickerEl
    );
  }

  // Re-opening from the same trigger toggles closed.
  if (
    isOpen &&
    pickerEl.dataset.anchorId ===
      anchorEl.dataset.emojiAnchorId
  ) {
    closeEmojiPicker();
    return;
  }

  if (
    !anchorEl.dataset.emojiAnchorId
  ) {
    anchorEl.dataset.emojiAnchorId =
      String(Math.random()).slice(2);
  }

  pickerEl.dataset.anchorId =
    anchorEl.dataset.emojiAnchorId;

  onSelectCallback = onSelect;

  // Reset search on every open.
  const searchInput =
    pickerEl.querySelector(
      '.emoji-picker-search'
    );

  searchInput.value = '';

  pickerEl
    .querySelector(
      '.emoji-picker-skin-menu'
    )
    .classList.remove('active');

  renderBody(
    pickerEl,
    ''
  );

  // Measure while invisible so the picker
  // never flashes at (0, 0).
  pickerEl.style.visibility =
    'hidden';

  pickerEl.classList.add(
    'measuring'
  );

  positionPicker(
    pickerEl,
    anchorEl
  );

  pickerEl.classList.remove(
    'measuring'
  );

  pickerEl.style.visibility =
    '';

  requestAnimationFrame(() => {
    pickerEl.classList.add(
      'active'
    );
  });

  isOpen = true;

  // Deferred so the click that opened the picker
  // doesn't immediately trigger outside-click handling.
  setTimeout(() => {
    document.addEventListener(
      'click',
      handleDocumentClick
    );

    document.addEventListener(
      'keydown',
      handleDocumentKeydown
    );
  }, 0);
}

export function closeEmojiPicker() {
  if (
    !pickerEl ||
    !isOpen
  ) {
    return;
  }

  pickerEl.classList.remove(
    'active'
  );

  isOpen = false;

  onSelectCallback = null;

  document.removeEventListener(
    'click',
    handleDocumentClick
  );

  document.removeEventListener(
    'keydown',
    handleDocumentKeydown
  );
}

export function isEmojiPickerOpen() {
  return isOpen;
}