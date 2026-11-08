import { getCurrentUser } from './auth.js';
import { enterView } from './view-session.js';
import { perfNavStart } from './perf.js';

// The four primary tabs use their cache-first entry points (show*): a
// view that has been loaded before paints from memory immediately and
// revalidates in the background; the first visit loads normally.
import { showFiles } from '../files/files.js';
import { renderSharedFile } from '../files/share-view.js';
import {
  showDm,
  destroyDmComposer,
} from '../chat/dm.js';
import {
  showGroups,
  destroyGroupComposer,
} from '../chat/group.js';
import { showSettings } from '../settings/settings.js';

import {
  renderAdminUsers,
  renderAdminFolders,
  renderAdminPermissions,
  renderAdminAudit,
} from '../settings/admin.js';

import { renderWireguard } from '../wireguard/wireguard.js';

import { App } from '../vendor/capacitor-app.js';

// Dependency-free in-route navigation context (DM conversation
// selection and overlay screens: image viewer, files viewer,
// preview, profile card). See core/navigation.js for the full
// picture — router.js remains the single owner of the Android Back
// listener and of route-level history; it just asks navigation.js
// first whether there's finer-grained context to unwind.
import {
  hasContext as hasNavigationContext,
  handleBack as handleNavigationBack,
  resetContext as resetNavigationContext,
} from './navigation.js';

const routes = {
  files: {
    title: 'My Files',
    render: showFiles,
    flush: true,
  },


  messages: {
    title: 'Messages',
    render: showDm,
    flush: true,
  },

  groups: {
    title: 'Groups',
    render: showGroups,
    flush: true,
  },

  settings: {
    title: 'Settings',
    render: showSettings,
  },

  // Opened by a file share link (#share/<token>, see files/links.js).
  'share-link': {
    title: 'Shared file',
    render: renderSharedFile,
    flush: true,
  },

  'admin-users': {
    title: 'Users',
    render: renderAdminUsers,
  },

  'admin-folders': {
    title: 'Shared Folders',
    render: renderAdminFolders,
  },

  'admin-permissions': {
    title: 'Permissions',
    render: renderAdminPermissions,
  },

  'admin-audit': {
    title: 'Audit log',
    render: renderAdminAudit,
  },

  'admin-wireguard': {
    title: 'WireGuard',
    render: renderWireguard,
  },
};

const SHARE_PREFIX = 'share/';

function shareTokenFrom(view) {
  return (
    typeof view === 'string' &&
    view.startsWith(SHARE_PREFIX)
  )
    ? view.slice(SHARE_PREFIX.length)
    : null;
}

// -------------------------------------------------------------------------
// Router state
// -------------------------------------------------------------------------

let currentView = null;

let hashListenerAttached = false;

let androidBackButtonAttached = false;

let routerInitialized = false;

// -------------------------------------------------------------------------
// Wire navigation stack
//
// IMPORTANT:
//
// Every stack entry contains both the route and its params:
//
//   {
//     view: 'messages',
//     params: {
//       id: 'abc',
//       username: 'Alice'
//     }
//   }
//
// This means Back can restore the exact navigation state instead of
// merely restoring the route name.
//
// Android Back is completely independent from window.history.
// -------------------------------------------------------------------------

let navigationStack = [];

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function isValidRoute(view) {
  return (
    typeof view === 'string' &&
    (
      routes[view] ||
      shareTokenFrom(view) !== null
    )
  );
}

function resolveRoute(view) {
  return isValidRoute(view)
    ? view
    : 'files';
}

// -------------------------------------------------------------------------
// Navigation entry helpers
// -------------------------------------------------------------------------

function cloneNavigationParams(params) {
  if (
    params === undefined ||
    params === null
  ) {
    return params;
  }

  /*
   * Params should normally be plain serializable objects.
   *
   * Use structuredClone when available so Back gets its own snapshot
   * instead of sharing a mutable object with the current route.
   */
  try {
    if (
      typeof structuredClone === 'function'
    ) {
      return structuredClone(params);
    }
  } catch (err) {
    console.warn(
      '[router] structuredClone failed:',
      err
    );
  }

  /*
   * Fallback for normal JSON-style route params.
   */
  try {
    return JSON.parse(
      JSON.stringify(params)
    );
  } catch (err) {
    console.warn(
      '[router] Could not clone navigation params:',
      err
    );

    return params;
  }
}

function createNavigationEntry(
  view,
  params
) {
  return {
    view,
    params: cloneNavigationParams(
      params
    ),
  };
}

function serializeNavigationParams(
  params
) {
  if (
    params === undefined ||
    params === null
  ) {
    return '';
  }

  try {
    return JSON.stringify(params);
  } catch (err) {
    return String(params);
  }
}

function navigationEntriesEqual(
  a,
  b
) {
  if (!a || !b) {
    return false;
  }

  return (
    a.view === b.view &&
    serializeNavigationParams(a.params) ===
      serializeNavigationParams(b.params)
  );
}

function getCurrentNavigationEntry() {
  return (
    navigationStack[
      navigationStack.length - 1
    ] || null
  );
}

function getPreviousNavigationEntry() {
  if (
    navigationStack.length < 2
  ) {
    return null;
  }

  return navigationStack[
    navigationStack.length - 2
  ];
}

function logNavigationStack(reason) {
  console.log(
    '[router] navigation stack:',
    reason,
    navigationStack.map(
      (entry) => ({
        view: entry.view,
        params: entry.params,
      })
    )
  );
}

// -------------------------------------------------------------------------
// URL synchronization
// -------------------------------------------------------------------------

function syncUrlToView(view) {
  const targetHash = `#${view}`;

  if (
    window.location.hash === targetHash
  ) {
    return;
  }

  /*
   * Keep the URL synchronized without creating a browser-history entry.
   *
   * Android Back uses navigationStack instead.
   */
  window.history.replaceState(
    null,
    '',
    targetHash
  );
}

// -------------------------------------------------------------------------
// Android Back button
// -------------------------------------------------------------------------

function initAndroidBackButton() {
  console.log(
    '[router] initAndroidBackButton() called'
  );

  if (
    !window.Capacitor?.isNativePlatform?.()
  ) {
    console.log(
      '[router] NOT native Capacitor platform'
    );

    return;
  }

  console.log(
    '[router] native Capacitor platform detected'
  );

  if (
    androidBackButtonAttached
  ) {
    console.log(
      '[router] Back listener already attached'
    );

    return;
  }

  try {
    App.addListener(
      'backButton',
      async (event) => {
        console.log(
          '[router] BACK BUTTON RECEIVED',
          event
        );

        logNavigationStack(
          'before Android Back'
        );

        /*
         * Overlays (image viewer, files viewer, preview, profile
         * card) and DM conversation selection live underneath route-
         * level history, in navigation.js. Android Back must unwind
         * those first: closing an overlay or stepping back to a
         * previous DM should never also pop a route or exit the app
         * in the same press.
         */
        if (
          hasNavigationContext()
        ) {
          handleNavigationBack();

          return;
        }

        /*
         * Repair an impossible empty stack.
         */
        if (
          navigationStack.length === 0
        ) {
          const rootEntry =
            createNavigationEntry(
              'files',
              undefined
            );

          navigationStack = [
            rootEntry,
          ];

          currentView = 'files';

          logNavigationStack(
            'stack repaired'
          );
        }

        /*
         * At root there is nowhere inside Wire to navigate.
         */
        if (
          navigationStack.length <= 1
        ) {
          console.log(
            '[router] At navigation root, exiting app'
          );
          console.log(
            '[nav] ROOT -> EXIT'
          );

          await App.exitApp();

          return;
        }

        /*
         * Remove the currently visible entry.
         *
         * Example:
         *
         * [
         *   files,
         *   chat,
         *   messages(A),
         *   messages(B)
         * ]
         *
         * becomes:
         *
         * [
         *   files,
         *   chat,
         *   messages(A)
         * ]
         */
        const currentEntry =
          navigationStack.pop();

        console.log(
          '[router] Removed current entry:',
          currentEntry
        );

        /*
         * The new last item is the exact destination.
         */
        const previousEntry =
          getCurrentNavigationEntry();

        if (
          !previousEntry
        ) {
          console.warn(
            '[router] Previous navigation entry missing'
          );

          await App.exitApp();

          return;
        }

        console.log(
          '[router] Android Back ->',
          previousEntry
        );

        logNavigationStack(
          'after pop'
        );

        /*
         * IMPORTANT:
         *
         * fromBack=true means navigate() must NOT push the destination
         * onto the stack again.
         *
         * The destination is already the last item.
         */
        navigate(
          previousEntry.view,
          cloneNavigationParams(
            previousEntry.params
          ),
          {
            fromBack: true,
          }
        );
      }
    );

    androidBackButtonAttached = true;

    console.log(
      '[router] BACK BUTTON LISTENER ATTACHED'
    );
  } catch (err) {
    console.error(
      '[router] BACK BUTTON INIT FAILED',
      err
    );
  }
}

// -------------------------------------------------------------------------
// Router initialization
// -------------------------------------------------------------------------

export function initRouter() {
  /*
   * Prevent duplicate initialization.
   */
  if (
    routerInitialized
  ) {
    console.log(
      '[router] initRouter() ignored: already initialized'
    );

    return;
  }

  routerInitialized = true;

  /*
   * Install native Android Back handling.
   */
  initAndroidBackButton();

  /*
   * Determine the initial route.
   *
   * Invalid or missing hashes always start at Files.
   */
  const rawInitialView =
    window.location.hash.slice(1) ||
    'files';

  const initialView =
    resolveRoute(rawInitialView);

  /*
   * The initial route is the only route in the stack.
   */
  navigationStack = [
    createNavigationEntry(
      initialView,
      undefined
    ),
  ];

  logNavigationStack(
    'initialization'
  );

  /*
   * Mount the initial route.
   *
   * fromBack=true prevents this initial mount from being interpreted
   * as forward navigation.
   */
  navigate(
    initialView,
    undefined,
    {
      initial: true,
      fromBack: true,
    }
  );

  // ---------------------------------------------------------------
  // Hash listener
  // ---------------------------------------------------------------

  if (
    hashListenerAttached
  ) {
    return;
  }

  hashListenerAttached = true;

  window.addEventListener(
    'hashchange',
    () => {
      const rawView =
        window.location.hash.slice(1) ||
        'files';

      const view =
        resolveRoute(rawView);

      console.log(
        '[router] hashchange:',
        view
      );

      /*
       * navigate() uses replaceState(), so normally our own navigation
       * does not produce hashchange.
       *
       * If some other part of the application changes location.hash
       * directly, this becomes a real forward navigation and gets
       * recorded by navigate().
       */
      if (
        view === currentView
      ) {
        return;
      }

      navigate(view);
    }
  );
}

/*
 * Clears the router's in-memory state so a later initRouter() call
 * (after a failed/aborted startup falls back to the login screen and
 * the user retries) is treated as a fresh initialization instead of
 * being ignored by the routerInitialized guard above.
 *
 * Intentionally does NOT unregister the window 'hashchange' listener
 * or the Android Back button listener: those are page-level and safe
 * to leave attached (re-attaching would just create duplicates), and
 * once currentView is cleared here, initRouter()'s next run repopulates
 * navigationStack/currentView from scratch before anything else can
 * read them.
 */
export function resetRouter() {
  routerInitialized = false;
  currentView = null;
  navigationStack = [];

  console.log(
    '[router] resetRouter(): state cleared'
  );
}

// -------------------------------------------------------------------------
// Loading -> content animation
// -------------------------------------------------------------------------

let contentSwapMotionBound = false;

function bindContentSwapMotion() {
  if (
    contentSwapMotionBound
  ) {
    return;
  }

  const root =
    document.getElementById(
      'content-area'
    );

  if (
    !root ||
    typeof MutationObserver !== 'function'
  ) {
    return;
  }

  contentSwapMotionBound = true;

  new MutationObserver(
    (records) => {
      if (
        !document.documentElement.hasAttribute(
          'data-animations'
        )
      ) {
        return;
      }

      for (
        const rec of records
      ) {
        const target =
          rec.target;

        if (
          !(target instanceof Element) ||
          target.closest('.chat-messages')
        ) {
          continue;
        }

        const replacedLoading =
          Array.from(
            rec.removedNodes
          ).some(
            (n) =>
              n.nodeType === 1 &&
              (
                n.matches(
                  '.loading-state'
                ) ||
                n.querySelector(
                  '.loading-state'
                )
              )
          );

        if (
          !replacedLoading
        ) {
          continue;
        }

        rec.addedNodes.forEach(
          (n) => {
            if (
              n.nodeType === 1 &&
              !n.matches(
                '.loading-state'
              )
            ) {
              n.classList.add(
                'motion-fade-in'
              );
            }
          }
        );
      }
    }
  ).observe(
    root,
    {
      childList: true,
      subtree: true,
    }
  );
}

// -------------------------------------------------------------------------
// Navigation
// -------------------------------------------------------------------------

export function navigate(
  view,
  params,
  options = {}
) {
  const user =
    getCurrentUser();

  if (!user) {
    return;
  }

  const {
    fromBack = false,
    initial = false,
  } = options;

  const resolvedView =
    resolveRoute(view);

  const requestedEntry =
    createNavigationEntry(
      resolvedView,
      params
    );

  const currentEntry =
    getCurrentNavigationEntry();

  // -----------------------------------------------------------------------
  // Ignore exact duplicate navigation
  // -----------------------------------------------------------------------

  /*
   * IMPORTANT:
   *
   * Comparing only currentView was the source of a subtle problem.
   *
   * These are different navigations:
   *
   *   messages(A)
   *   messages(B)
   *
   * even though currentView === "messages" for both.
   *
   * Therefore compare both route AND params.
   */
  if (
    !initial &&
    !fromBack &&
    navigationEntriesEqual(
      currentEntry,
      requestedEntry
    )
  ) {
    console.log(
      '[router] Duplicate navigation ignored:',
      requestedEntry
    );

    return;
  }

  bindContentSwapMotion();

  perfNavStart(
    resolvedView
  );

  const shareToken =
    shareTokenFrom(
      resolvedView
    );

  const isShareLink =
    shareToken !== null;

  const route =
    isShareLink
      ? routes['share-link']
      : routes[resolvedView];

  if (!route) {
    console.warn(
      '[router] Unknown route:',
      resolvedView
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Wire navigation stack
  // -----------------------------------------------------------------------

  /*
   * Forward navigation:
   *
   *   files
   *   -> chat
   *   -> messages(A)
   *   -> messages(B)
   *
   * creates:
   *
   *   [
   *     files,
   *     chat,
   *     messages(A),
   *     messages(B)
   *   ]
   *
   * Back navigation does NOT push anything because the current item was
   * already popped by initAndroidBackButton().
   */
  if (
    !initial &&
    !fromBack
  ) {
    /*
     * Repair an empty stack if necessary.
     */
    if (
      navigationStack.length === 0
    ) {
      navigationStack = [
        createNavigationEntry(
          currentView || 'files',
          undefined
        ),
      ];
    }

    /*
     * Never add an exact duplicate.
     */
    const lastEntry =
      getCurrentNavigationEntry();

    if (
      !navigationEntriesEqual(
        lastEntry,
        requestedEntry
      )
    ) {
      navigationStack.push(
        requestedEntry
      );

      console.log(
        '[router] Forward navigation recorded:',
        requestedEntry
      );
    }
  }

  /*
   * Safety fallback.
   */
  if (
    navigationStack.length === 0
  ) {
    navigationStack = [
      requestedEntry,
    ];
  }

  // -----------------------------------------------------------------------
  // View ownership
  // -----------------------------------------------------------------------

  /*
   * Update currentView BEFORE rendering.
   *
   * view-session.js uses this boundary to invalidate asynchronous work
   * belonging to the previous route.
   */
  currentView =
    resolvedView;

  enterView(
    isShareLink
      ? 'share-link'
      : routes[resolvedView]
        ? resolvedView
        : 'files'
  );

  // Release any in-progress voice recording before switching views.
  destroyDmComposer();
  destroyGroupComposer();

  // -----------------------------------------------------------------------
  // Navigation UI
  // -----------------------------------------------------------------------

  document
    .querySelectorAll(
      '.nav-link, .bottom-nav-item, .more-menu-item'
    )
    .forEach(
      (link) => {
        /*
         * Shared files belong to My Files from the navigation's
         * point of view.
         */
        const isActive =
          link.dataset.view === (
            isShareLink
              ? 'files'
              : resolvedView
          );

        link.classList.toggle(
          'active',
          isActive
        );

        if (isActive) {
          link.setAttribute(
            'aria-current',
            'page'
          );
        } else {
          link.removeAttribute(
            'aria-current'
          );
        }
      }
    );

  // -----------------------------------------------------------------------
  // Top bar
  // -----------------------------------------------------------------------

  const title =
    document.getElementById(
      'topbar-title'
    );

  if (title) {
    title.textContent =
      route.title;
  }

  // -----------------------------------------------------------------------
  // Content area
  // -----------------------------------------------------------------------

  const content =
    document.getElementById(
      'content-area'
    );

  if (content) {
    content.classList.toggle(
      'content--flush',
      !!route.flush
    );
  }

  // -----------------------------------------------------------------------
  // In-route navigation context
  // -----------------------------------------------------------------------

  /*
   * Any DM conversation selection or overlay (image viewer, files
   * viewer, preview, profile card) belonged to the screen we're
   * leaving. Closing overlays here (resetContext() does this) covers
   * the rare case where a route switch happens without one having
   * been closed first, so Android Back never inherits stale context
   * from a screen that's no longer showing.
   */
  resetNavigationContext(
    `route:${resolvedView}`
  );

  // -----------------------------------------------------------------------
  // Render route
  // -----------------------------------------------------------------------

  route.render(
    isShareLink
      ? {
          token: shareToken,
        }
      : cloneNavigationParams(
          params
        )
  );

  // -----------------------------------------------------------------------
  // Page/view transition
  // -----------------------------------------------------------------------

  if (content) {
    content.classList.remove(
      'view-enter'
    );

    void content.offsetWidth;

    content.classList.add(
      'view-enter'
    );
  }

  // -----------------------------------------------------------------------
  // URL synchronization
  // -----------------------------------------------------------------------

  syncUrlToView(
    resolvedView
  );

  logNavigationStack(
    `navigate(${resolvedView})`
  );
}

// -------------------------------------------------------------------------
// Debug helpers
// -------------------------------------------------------------------------

/*
 * These are intentionally exposed for debugging from Chrome remote
 * debugging / WebView console.
 *
 * Example:
 *
 *   window.__wireNavigationStack()
 *
 * returns:
 *
 *   [
 *     { view: 'files', params: undefined },
 *     { view: 'messages', params: { id: '123', username: 'Alice' } }
 *   ]
 */

window.__wireNavigationStack =
  function () {
    return navigationStack.map(
      (entry) => ({
        view: entry.view,
        params:
          cloneNavigationParams(
            entry.params
          ),
      })
    );
  };

window.__wireCurrentView =
  function () {
    return currentView;
  };