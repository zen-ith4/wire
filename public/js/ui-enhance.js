// ============================================================
// Custom <select> — native option lists can't be themed reliably,
// so every <select> in the app gets wrapped with a real glass menu.
// The original <select> stays in the DOM (just visually hidden) and
// is kept in sync via a real 'change' event, so all existing
// `.value` / `onchange` code elsewhere in the app keeps working
// untouched (see files.js, admin.js, share.js, dm.js).
//
// NOTE: the CSS for .dselect / .dselect-trigger / .dselect-menu
// already ships in style.css — this file was the missing piece
// that actually builds/wires the markup.
// ============================================================

export function enhanceSelects(root) {
  (root || document)
    .querySelectorAll('select:not([data-dselect])')
    .forEach(buildCustomSelect);
}

function buildCustomSelect(sel) {
  sel.dataset.dselect = '1';

  const wrap = document.createElement('div');
  wrap.className = 'dselect';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dselect-trigger';
  if (sel.disabled) trigger.disabled = true;

  const label = document.createElement('span');
  label.className = 'dselect-label';
  trigger.appendChild(label);
  trigger.insertAdjacentHTML(
    'beforeend',
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`
  );
  wrap.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'dselect-menu';
  wrap.appendChild(menu);

  function sync() {
    const opts = Array.from(sel.options);
    const current = opts.find(o => o.value === sel.value) || opts[0];
    label.textContent = current ? current.textContent : '';
    menu.innerHTML = '';
    opts.forEach(o => {
      const row = document.createElement('div');
      row.className = 'dselect-option' + (o.value === sel.value ? ' selected' : '');
      row.textContent = o.textContent;
      row.onclick = (ev) => {
        ev.stopPropagation();
        if (sel.value !== o.value) {
          sel.value = o.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sync();
        closeAllDselects();
      };
      menu.appendChild(row);
    });
  }

  sync();
  // Keep the fake menu in sync if the underlying <select>'s options
  // are rebuilt in place (e.g. a caller repopulates it without a
  // full re-render).
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true });

  trigger.onclick = (ev) => {
    ev.stopPropagation();
    const willOpen = !wrap.classList.contains('open');
    closeAllDselects();
    if (willOpen) wrap.classList.add('open');
  };
}

function closeAllDselects() {
  document.querySelectorAll('.dselect.open').forEach(w => w.classList.remove('open'));
}

document.addEventListener('click', closeAllDselects);

let started = false;
let pending = false;

/**
 * Call once at startup. Does an initial pass over the document, then
 * watches for new <select> elements being injected (this app rebuilds
 * whole views via innerHTML, e.g. files.js/admin.js/share.js/dm.js,
 * so new <select>s appear constantly).
 *
 * The mutation callback is batched onto a microtask so that a single
 * innerHTML replacement (which fires many mutation records at once)
 * only triggers one enhancement pass instead of one per node.
 */
export function startAutoEnhance() {
  if (started) return;
  started = true;

  enhanceSelects(document);

  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      enhanceSelects(document);
    });
  }).observe(document.body, { childList: true, subtree: true });
}
