// ============================================================
// Emoji picker
// ------------------------------------------------------------
// One picker instance is created lazily on first use and reused
// for the rest of the session.
//
// Emoji data itself is also lazy-loaded. The relatively large
// emoji dataset is NOT imported during module evaluation. It is
// fetched only when the picker is actually opened for the first
// time.
//
// Category contents are rendered lazily as their sections approach
// the viewport. This avoids creating hundreds of emoji buttons and
// forcing a large DOM/layout pass on the first open.
//
// This module owns *only* picker mechanics (rendering, search,
// categories, recents, skin tone, positioning, open/close). It has
// no opinion about what selecting an emoji *does* — every call to
// openEmojiPicker() supplies its own onSelect callback.
// ============================================================

// ---------------- Lazy emoji data ----------------

let emojiDataPromise = null;
let CATEGORIES = [];
let EMOJI = [];
let emojiDataLoaded = false;

function loadEmojiData() {
  if (emojiDataLoaded) {
    return Promise.resolve();
  }

  if (!emojiDataPromise) {
    emojiDataPromise = import('../vendor/emoji-data.js')
      .then((module) => {
        CATEGORIES = module.CATEGORIES;
        EMOJI = module.EMOJI;

        emojiById.clear();

        for (const emoji of EMOJI) {
          emojiById.set(
            emoji.id,
            emoji
          );
        }

        emojiDataLoaded = true;
      })
      .catch((error) => {
        // Allow another attempt if the dynamic import failed.
        emojiDataPromise = null;

        console.error(
          '[emoji-picker] Failed to load emoji data:',
          error
        );

        throw error;
      });
  }

  return emojiDataPromise;
}

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

// ---------------- Module state ----------------

let pickerEl = null;
let onSelectCallback = null;
let currentSkin = getSkin();
let isOpen = false;

const emojiById = new Map();

// ---------------- Lazy section rendering ----------------

let sectionObserver = null;

function createSectionObserver() {
  if (sectionObserver) {
    return sectionObserver;
  }

  if (
    typeof IntersectionObserver ===
    'undefined'
  ) {
    return null;
  }

  sectionObserver =
    new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          const section =
            entry.target;

          renderLazySection(
            section
          );

          sectionObserver?.unobserve(
            section
          );
        }
      },
      {
        root: null,
        rootMargin: '300px 0px',
        threshold: 0
      }
    );

  return sectionObserver;
}

function renderLazySection(section) {
  if (
    section.dataset.rendered ===
    'true'
  ) {
    return;
  }

  const catId =
    section.dataset.cat;

  const items = EMOJI.filter(
    item => item.cat === catId
  );

  const grid =
    section.querySelector(
      '.emoji-picker-grid'
    );

  if (!grid) {
    return;
  }

  grid.innerHTML = items
    .map(item =>
      emojiButtonHtml(item)
    )
    .join('');

  section.dataset.rendered =
    'true';
}

function observeLazySections(el) {
  const observer =
    createSectionObserver();

  const sections =
    el.querySelectorAll(
      '.emoji-picker-section[data-lazy="true"]'
    );

  if (!observer) {
    for (const section of sections) {
      renderLazySection(section);
    }

    return;
  }

  for (const section of sections) {
    observer.observe(section);
  }
}

function createCategorySection(cat) {
  return `
    <div
      class="emoji-picker-section"
      data-cat="${cat.id}"
      data-lazy="true"
    >
      <div class="emoji-picker-section-title">
        ${cat.name}
      </div>

      <div class="emoji-picker-grid"></div>
    </div>
  `;
}

// ---------------- DOM construction ----------------

function buildPicker() {
  const el =
    document.createElement('div');

  el.className =
    'emoji-picker';

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

  const tabsEl =
    el.querySelector(
      '.emoji-picker-tabs'
    );

  tabsEl.innerHTML =
    CATEGORIES.map(cat =>
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

  const skinMenuEl =
    el.querySelector(
      '.emoji-picker-skin-menu'
    );

  skinMenuEl.innerHTML =
    SKIN_SWATCH_COLORS.map(
      (color, i) =>
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

  const searchInput =
    el.querySelector(
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
      const btn =
        e.target.closest(
          '.emoji-picker-tab'
        );

      if (!btn) {
        return;
      }

      const section =
        el.querySelector(
          `.emoji-picker-section[data-cat="${btn.dataset.cat}"]`
        );

      if (section) {
        renderLazySection(
          section
        );

        section.scrollIntoView({
          block: 'start'
        });
      }
    }
  );

  // ---- Skin tone button ----

  const skinBtn =
    el.querySelector(
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
      const swatch =
        e.target.closest(
          '.emoji-picker-skin-swatch'
        );

      if (!swatch) {
        return;
      }

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
      const btn =
        e.target.closest(
          '.emoji-picker-emoji'
        );

      if (!btn) {
        return;
      }

      const item =
        emojiById.get(
          btn.dataset.id
        );

      if (!item) {
        return;
      }

      pushRecent(item.id);

      const char =
        emojiChar(
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
  const btn =
    el.querySelector(
      '.emoji-picker-skin-btn'
    );

  btn.style.setProperty(
    '--swatch',
    SKIN_SWATCH_COLORS[
      currentSkin
    ]
  );
}

// ---------------- Rendering ----------------

function renderBody(el, query) {
  const body =
    el.querySelector(
      '.emoji-picker-body'
    );

  const tabsEl =
    el.querySelector(
      '.emoji-picker-tabs'
    );

  const q =
    query
      .trim()
      .toLowerCase();

  // Disconnect observers for the previous
  // category DOM before replacing it.
  if (sectionObserver) {
    sectionObserver.disconnect();
  }

  // ---- Search ----

  if (q) {
    tabsEl.classList.add(
      'hidden'
    );

    const matches =
      EMOJI.filter(
        item =>
          item.name
            .toLowerCase()
            .includes(q) ||

          item.kw.includes(q) ||

          item.id
            .toLowerCase()
            .includes(q)
      );

    body.innerHTML =
      matches.length
        ? `
          <div
            class="emoji-picker-section"
            data-cat="search"
            data-rendered="true"
          >
            <div class="emoji-picker-section-title">
              Search Results
            </div>

            <div class="emoji-picker-grid">
              ${matches
                .map(item =>
                  emojiButtonHtml(item)
                )
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

  const recents =
    getRecents()
      .map(id =>
        emojiById.get(id)
      )
      .filter(Boolean);

  const sections = [];

  if (recents.length) {
    sections.push(`
      <div
        class="emoji-picker-section"
        data-cat="recent"
        data-rendered="true"
      >
        <div class="emoji-picker-section-title">
          Frequently Used
        </div>

        <div class="emoji-picker-grid">
          ${recents
            .map(item =>
              emojiButtonHtml(item)
            )
            .join('')}
        </div>
      </div>
    `);
  }

  // ---- Categories ----
  //
  // Only section headers/placeholders are
  // created here. The actual emoji buttons
  // are generated when each section approaches
  // the viewport.

  for (const cat of CATEGORIES) {
    sections.push(
      createCategorySection(cat)
    );
  }

  body.innerHTML =
    sections.join('');

  observeLazySections(el);
}

function emojiButtonHtml(item) {
  return `
    <button
      type="button"
      class="emoji-picker-emoji"
      data-id="${item.id}"
      title="${item.name}"
    >
      ${emojiChar(item, currentSkin)}
    </button>
  `;
}

// ---------------- Positioning ----------------

function positionPicker(
  el,
  anchorEl
) {
  const rect =
    anchorEl.getBoundingClientRect();

  const pickerRect =
    el.getBoundingClientRect();

  const margin = 8;

  const vw =
    window.innerWidth;

  const vh =
    window.innerHeight;

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

  let left =
    rect.left;

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
 * Emoji data is dynamically imported the first time
 * this function is called. The picker itself is also
 * created only after the data is available.
 *
 * `onSelect(char)` is called with the chosen emoji's
 * native character, already carrying the selected
 * skin-tone modifier when applicable.
 *
 * What happens with the character is entirely up to
 * the caller.
 */
export async function openEmojiPicker({
  anchorEl,
  onSelect
}) {
  if (
    !anchorEl ||
    typeof onSelect !== 'function'
  ) {
    return;
  }

  // Load the large emoji dataset only when
  // the picker is actually needed.
  await loadEmojiData();

  if (!pickerEl) {
    pickerEl =
      buildPicker();

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
      String(
        Math.random()
      ).slice(2);
  }

  pickerEl.dataset.anchorId =
    anchorEl.dataset.emojiAnchorId;

  onSelectCallback =
    onSelect;

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
    .classList.remove(
      'active'
    );

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