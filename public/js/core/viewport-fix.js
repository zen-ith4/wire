// Real mobile viewport height (accounts for the browser chrome/address
// bar and the on-screen keyboard) exposed as --vh, used by .app/.main
// (layout/app.css) as calc(var(--vh,1vh) * 100). 100dvh already covers
// most modern browsers on its own; this is the JS fallback/refinement
// for the ones that resize the layout viewport instead (older Android
// WebViews, some in-app browsers) so the composer never ends up hidden
// behind the keyboard or a phantom scrollbar appears from a stale 100vh.
//
// Loaded as a classic (non-module) synchronous <script src> right after
// the favicon link, before the rest of <head>/<body>, so it still runs
// before first paint -- same timing as the inline version it replaces.
// It was moved out of index.html into this file because the app's
// Content-Security-Policy (middleware/csp.js) has no 'unsafe-inline' in
// script-src, so an inline <script> block would silently fail to run.
(function () {
  function setVh() {
    var vv = window.visualViewport;
    var h = (vv && vv.height) || window.innerHeight;
    document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
  }
  setVh();
  window.addEventListener('resize', setVh);
  window.addEventListener('orientationchange', setVh);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setVh);
  }
})();
