// ============================================================
// Custom <select>
//
// Native <select> menus cannot be themed consistently across
// browsers/platforms, so Wire uses a custom glass dropdown UI.
//
// The original <select> is intentionally kept in the DOM.
// It remains the source of truth for:
//
//   - .value
//   - .options
//   - .selectedIndex
//   - disabled
//   - existing change/onchange handlers
//
// Selecting an item through the custom UI updates the real
// <select> and dispatches a real bubbling `change` event.
//
// Performance notes:
//   - One MutationObserver handles the whole document.
//   - We only inspect newly-added nodes instead of rescanning
//     the entire document after every mutation.
//   - Each <select> gets one `change` listener.
//   - Option DOM is rebuilt only when the option structure changes.
//   - Selection changes only update the label + selected classes.
//
// Existing callers in files.js/admin.js/share.js/dm.js can keep
// using normal <select> APIs.
// ============================================================

const SELECT_SELECTOR = 'select:not([data-dselect])';
const DSELECT_ATTRIBUTE = 'data-dselect';

let started = false;
let observer = null;

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export function enhanceSelects(root = document) {
  if (!root) return;

  if (root instanceof HTMLSelectElement) {
    if (!root.hasAttribute(DSELECT_ATTRIBUTE)) {
      buildCustomSelect(root);
    }
    return;
  }

  if (typeof root.querySelectorAll !== 'function') return;

  root.querySelectorAll(SELECT_SELECTOR).forEach(buildCustomSelect);
}

/**
 * Start automatic enhancement.
 *
 * The initial document is scanned once.
 * Afterwards a single MutationObserver watches for newly-added
 * <select> elements.
 *
 * This is intentionally limited to childList mutations. We do not
 * watch every attribute change in the entire document because that
 * would create unnecessary observer traffic for a UI that changes
 * frequently.
 */
export function startAutoEnhance() {
  if (started) return;
  started = true;

  enhanceSelects(document);

  const target = document.body || document.documentElement;
  if (!target) return;

  observer = new MutationObserver(handleMutations);

  observer.observe(target, {
    childList: true,
    subtree: true,
  });
}

// ------------------------------------------------------------
// Custom select construction
// ------------------------------------------------------------

function buildCustomSelect(sel) {
  if (!(sel instanceof HTMLSelectElement)) return;
  if (sel.hasAttribute(DSELECT_ATTRIBUTE)) return;

  sel.setAttribute(DSELECT_ATTRIBUTE, '');

  const wrap = document.createElement('div');
  wrap.className = 'dselect';

  sel.parentNode?.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dselect-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const label = document.createElement('span');
  label.className = 'dselect-label';

  const arrow = document.createElement('svg');
  arrow.setAttribute('width', '14');
  arrow.setAttribute('height', '14');
  arrow.setAttribute('viewBox', '0 0 24 24');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('aria-hidden', 'true');

  const polyline = document.createElement('polyline');
  polyline.setAttribute('points', '6 9 12 15 18 9');

  arrow.appendChild(polyline);

  trigger.append(label, arrow);
  wrap.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'dselect-menu';
  menu.setAttribute('role', 'listbox');

  wrap.appendChild(menu);

  const state = {
    wrap,
    trigger,
    label,
    menu,
    optionsSignature: '',
  };

  // Store state on the select so no global Map is required.
  sel._dselectState = state;

  // ----------------------------------------------------------
  // Initial state
  // ----------------------------------------------------------

  rebuildOptions(sel);
  syncSelectState(sel);

  // ----------------------------------------------------------
  // Native select changes
  // ----------------------------------------------------------

  sel.addEventListener('change', () => {
    syncSelectState(sel);
  });

  // ----------------------------------------------------------
  // Trigger
  // ----------------------------------------------------------

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (sel.disabled) return;

    const willOpen = !wrap.classList.contains('open');

    closeAllDselects();

    if (willOpen) {
      openDselect(sel);
    }
  });

  // ----------------------------------------------------------
  // Keyboard support
  // ----------------------------------------------------------

  trigger.addEventListener('keydown', (event) => {
    if (sel.disabled) return;

    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'ArrowDown':
        event.preventDefault();

        if (!wrap.classList.contains('open')) {
          openDselect(sel);
        } else {
          selectRelativeOption(sel, 1);
        }
        break;

      case 'ArrowUp':
        event.preventDefault();

        if (!wrap.classList.contains('open')) {
          openDselect(sel);
        } else {
          selectRelativeOption(sel, -1);
        }
        break;

      case 'Escape':
        if (wrap.classList.contains('open')) {
          event.preventDefault();
          closeDselect(sel);
        }
        break;
    }
  });
}

// ------------------------------------------------------------
// Option rendering
// ------------------------------------------------------------

function rebuildOptions(sel) {
  const state = sel._dselectState;
  if (!state) return;

  const signature = getOptionsSignature(sel);

  // Nothing about the option list changed.
  if (signature === state.optionsSignature) {
    syncSelectedOption(sel);
    return;
  }

  state.optionsSignature = signature;

  const fragment = document.createDocumentFragment();

  Array.from(sel.options).forEach((option, index) => {
    const row = document.createElement('div');

    row.className = 'dselect-option';
    row.setAttribute('role', 'option');
    row.dataset.value = option.value;
    row.dataset.index = String(index);

    row.textContent = option.textContent;

    row.addEventListener('click', (event) => {
      event.stopPropagation();

      if (sel.disabled || option.disabled) return;

      if (sel.selectedIndex !== index) {
        sel.selectedIndex = index;

        // Keep existing Wire code working exactly as with a native
        // select. `change` is the standard event for committed
        // select changes.
        sel.dispatchEvent(
          new Event('change', {
            bubbles: true,
          })
        );
      } else {
        // The selection itself did not change, but the UI may have
        // been rebuilt, so make sure the visual state is correct.
        syncSelectState(sel);
      }

      closeDselect(sel);
    });

    fragment.appendChild(row);
  });

  state.menu.replaceChildren(fragment);

  syncSelectState(sel);
}

// ------------------------------------------------------------
// State synchronization
// ------------------------------------------------------------

function syncSelectState(sel) {
  const state = sel._dselectState;
  if (!state) return;

  const options = Array.from(sel.options);
  const current =
    options[sel.selectedIndex] ||
    options.find(option => option.value === sel.value) ||
    options[0];

  state.label.textContent = current?.textContent || '';

  state.trigger.disabled = sel.disabled;

  state.trigger.setAttribute(
    'aria-expanded',
    state.wrap.classList.contains('open') ? 'true' : 'false'
  );

  if (current) {
    state.trigger.setAttribute(
      'aria-label',
      current.textContent || 'Select'
    );
  } else {
    state.trigger.removeAttribute('aria-label');
  }

  syncSelectedOption(sel);
}

function syncSelectedOption(sel) {
  const state = sel._dselectState;
  if (!state) return;

  const selectedIndex = sel.selectedIndex;

  Array.from(state.menu.children).forEach((row, index) => {
    const selected = index === selectedIndex;

    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

// ------------------------------------------------------------
// Option signature
// ------------------------------------------------------------

function getOptionsSignature(sel) {
  return Array.from(sel.options)
    .map(option => [
      option.value,
      option.textContent,
      option.disabled ? '1' : '0',
    ].join('\u0001'))
    .join('\u0002');
}

// ------------------------------------------------------------
// Open / close
// ------------------------------------------------------------

function openDselect(sel) {
  const state = sel._dselectState;
  if (!state || sel.disabled) return;

  closeAllDselects(state.wrap);

  state.wrap.classList.add('open');
  state.trigger.setAttribute('aria-expanded', 'true');
}

function closeDselect(sel) {
  const state = sel._dselectState;
  if (!state) return;

  state.wrap.classList.remove('open');
  state.trigger.setAttribute('aria-expanded', 'false');
}

function closeAllDselects(except = null) {
  document
    .querySelectorAll('.dselect.open')
    .forEach(wrap => {
      if (wrap !== except) {
        wrap.classList.remove('open');

        const trigger = wrap.querySelector('.dselect-trigger');
        trigger?.setAttribute('aria-expanded', 'false');
      }
    });
}

// ------------------------------------------------------------
// Keyboard selection
// ------------------------------------------------------------

function selectRelativeOption(sel, direction) {
  const options = Array.from(sel.options).filter(option => !option.disabled);

  if (!options.length) return;

  const current = options.indexOf(
    sel.options[sel.selectedIndex]
  );

  let nextIndex;

  if (current === -1) {
    nextIndex = direction > 0 ? 0 : options.length - 1;
  } else {
    nextIndex = current + direction;

    if (nextIndex < 0) {
      nextIndex = options.length - 1;
    } else if (nextIndex >= options.length) {
      nextIndex = 0;
    }
  }

  const nextOption = options[nextIndex];

  if (!nextOption) return;

  if (sel.value !== nextOption.value) {
    sel.value = nextOption.value;

    sel.dispatchEvent(
      new Event('change', {
        bubbles: true,
      })
    );
  }
}

// ------------------------------------------------------------
// Mutation handling
// ------------------------------------------------------------

function handleMutations(mutations) {
  const candidates = new Set();

  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;

    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const element = /** @type {Element} */ (node);

      if (
        element.matches?.(SELECT_SELECTOR)
      ) {
        candidates.add(element);
      }

      element
        .querySelectorAll?.(SELECT_SELECTOR)
        .forEach(select => candidates.add(select));
    }
  }

  candidates.forEach(buildCustomSelect);
}

// ------------------------------------------------------------
// Global outside-click handling
// ------------------------------------------------------------

document.addEventListener('click', () => {
  closeAllDselects();
});

// ------------------------------------------------------------
// Keep custom menus correct when a select's options are rebuilt
// ------------------------------------------------------------
//
// We intentionally do NOT attach a MutationObserver to every
// <select>. The central document observer handles newly-created
// selects, while this delegated observer catches option changes
// inside existing custom selects.
//
// This observer is throttled to one microtask per mutation batch.
//
// ------------------------------------------------------------

let optionSyncPending = false;

const optionObserver = new MutationObserver(mutations => {
  let needsSync = false;

  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;

    const target = mutation.target;

    if (
      target instanceof HTMLSelectElement &&
      target.hasAttribute(DSELECT_ATTRIBUTE)
    ) {
      needsSync = true;
      break;
    }

    if (
      target.closest?.('select[data-dselect]')
    ) {
      needsSync = true;
      break;
    }
  }

  if (!needsSync || optionSyncPending) return;

  optionSyncPending = true;

  queueMicrotask(() => {
    optionSyncPending = false;

    document
      .querySelectorAll('select[data-dselect]')
      .forEach(rebuildOptions);
  });
});

// ------------------------------------------------------------
// Start observing existing document when the module loads.
//
// If the app imports this module before <body> exists, defer the
// observer until DOMContentLoaded.
// ------------------------------------------------------------

function startOptionObserver() {
  if (!document.documentElement) return;

  optionObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    startOptionObserver,
    { once: true }
  );
} else {
  startOptionObserver();
}