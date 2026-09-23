// ============================================================
// Settings > category navigation (behavior)
// ------------------------------------------------------------
// Owns *which* Settings category is currently open and wires
// that into the app's existing in-route navigation stack
// (core/navigation.js), the same mechanism the image viewer,
// files viewer and profile card already use for Android Back:
// opening a category pushes an 'overlay' entry whose close()
// returns to the category list; Android Back and router-level
// route switches (core/router.js's resetNavigationContext, fired
// right before it renders a different top-level screen) both
// unwind it automatically, so this file never touches Android
// Back or the route stack directly.
//
// This module intentionally knows nothing about *how* a category
// renders — settings.js hands it renderBody()/bindCategory()
// callbacks so this stays a small, dependency-light state
// machine (same spirit as navigation.js itself).
// ============================================================

import {
  pushOverlay,
  closeOverlay
} from '../core/navigation.js';


// ============================================================
// State
//
// Module-level, not per-render: this is what lets a re-render
// triggered from *inside* an open category (settings-security.js
// / settings-media.js call renderSettings() directly after a
// write) redraw the same category instead of resetting to the
// list — settings.js reads getActiveSettingsCategory() fresh on
// every renderSettingsHtml() call.
// ============================================================

let activeCategoryId = null;

export function getActiveSettingsCategory() {
  return activeCategoryId;
}


// ============================================================
// DOM helpers
//
// Guarded with element lookups (not assumed present) because
// this can run while #content-area no longer holds the Settings
// screen at all (see resetSettingsCategory()).
// ============================================================

function setShellOpenClass(open) {
  const shell =
    document.getElementById('settings-shell');

  if (shell) {
    shell.classList.toggle(
      'category-open',
      Boolean(open)
    );
  }
}


// ============================================================
// Close
//
// Idempotent and safe to call more than once (same convention as
// closeImageViewer()/closeOverlay() elsewhere) — it is used both
// as the on-screen Back button's click handler AND as the
// overlay's own close() callback (Android Back, or a router-level
// route switch clearing stale context via resetNavigationContext
// before it renders the next screen).
// ============================================================

export function closeSettingsCategory() {
  if (!activeCategoryId) {
    return;
  }

  activeCategoryId = null;

  // Keeps navigation history in sync no matter how the category
  // was closed — the on-screen Back button, Android Back, or a
  // route switch away from Settings.
  closeOverlay('settings-category');

  setShellOpenClass(false);
}


// ============================================================
// Open
//
// renderBody(categoryId) must return that category's inner HTML
// (settings-render.js's renderCategoryBodyHtml); bindCategory(id)
// must wire up its event listeners against the DOM renderBody()
// just produced. Both are supplied by settings.js so this file
// stays render-agnostic.
// ============================================================

export async function openSettingsCategory(
  categoryId,
  {
    renderBody,
    bindCategory,
    label
  } = {}
) {
  if (
    !categoryId ||
    categoryId === activeCategoryId
  ) {
    return;
  }

  activeCategoryId = categoryId;

  const titleEl =
    document.getElementById(
      'settings-category-title'
    );

  if (titleEl) {
    titleEl.textContent = label || '';
  }

  const bodyEl =
    document.getElementById(
      'settings-category-body'
    );

  if (bodyEl && renderBody) {
    bodyEl.innerHTML =
      renderBody(categoryId);
  }

  // Two-layer transition (see .settings-shell/.category-open in
  // settings.css): the category list and the detail pane already
  // both exist in the DOM, sharing one grid cell, so adding this
  // class is the entire animation — no separate mount/unmount
  // step is needed for the slide/fade to play.
  setShellOpenClass(true);

  if (bindCategory) {
    await bindCategory(categoryId);
  }

  // Android Back should close this category and reveal the list
  // underneath, not navigate away from Settings entirely.
  pushOverlay(
    'settings-category',
    closeSettingsCategory
  );
}


// ============================================================
// Mount — called once per Settings paint (settings.js, after
// #content-area's innerHTML is set), whether that paint is a
// fresh entry into the tab or a re-render triggered from inside
// an open category.
// ============================================================

export function mountSettingsCategoryNav({
  renderBody,
  bindCategory,
  categories = []
} = {}) {
  const shell =
    document.getElementById(
      'settings-shell'
    );

  if (!shell) {
    return;
  }

  shell
    .querySelectorAll(
      '.settings-category-row'
    )
    .forEach(row => {
      row.addEventListener(
        'click',
        () => {
          const id =
            row.dataset.category;

          const category =
            categories.find(
              c => c.id === id
            );

          openSettingsCategory(
            id,
            {
              renderBody,
              bindCategory,
              label:
                category?.label || ''
            }
          );
        }
      );
    });

  const backBtn =
    document.getElementById(
      'settings-category-back'
    );

  backBtn?.addEventListener(
    'click',
    closeSettingsCategory
  );

  // The markup already reflects activeCategoryId (see
  // renderSettingsHtml()) whenever this paint happened while a
  // category was already open — e.g. the write-triggered
  // re-renders in settings-security.js/settings-media.js. Its
  // event listeners still need (re)binding against the fresh DOM,
  // and the overlay entry must exist whether this is that first
  // open or one of those refreshes — pushOverlay() is a no-op if
  // the entry is already there (see core/navigation.js), so this
  // is safe to call unconditionally.
  if (activeCategoryId && bindCategory) {
    void bindCategory(activeCategoryId);

    pushOverlay(
      'settings-category',
      closeSettingsCategory
    );
  }
}


// ============================================================
// Reset — called when the Settings tab is entered fresh (router
// navigation into #settings, see settings.js's showSettings()),
// so returning to the tab always starts at the category list
// rather than resuming wherever the user last drilled into.
//
// Not called from renderSettings() itself, since that also runs
// for the write-triggered refreshes above, where staying in the
// open category is exactly what's wanted.
// ============================================================

export function resetSettingsCategory() {
  if (activeCategoryId) {
    closeOverlay('settings-category');
  }

  activeCategoryId = null;
}
