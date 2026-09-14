'use strict';

/**
 * Remembers window size/position/maximized-state across restarts.
 * Deliberately small and dependency-free rather than pulling in
 * electron-window-state, since we already have config-store.js.
 */

const { screen } = require('electron');
const configStore = require('./config-store');

const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

function getSavedBounds() {
  const saved = configStore.get('window') || {};

  const width = Number.isFinite(saved.width) ? saved.width : 1280;
  const height = Number.isFinite(saved.height) ? saved.height : 820;

  const bounds = {
    width: Math.max(width, MIN_WIDTH),
    height: Math.max(height, MIN_HEIGHT),
  };

  // Only restore x/y if they'd actually land on a currently-connected
  // display - otherwise a window from a since-unplugged second
  // monitor would open off-screen and look "missing".
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const displays = screen.getAllDisplays();
    const fits = displays.some((d) => {
      const { x, y, width: w, height: h } = d.workArea;
      return saved.x >= x && saved.y >= y && saved.x < x + w && saved.y < y + h;
    });

    if (fits) {
      bounds.x = saved.x;
      bounds.y = saved.y;
    }
  }

  return { bounds, isMaximized: Boolean(saved.isMaximized) };
}

function trackWindow(win) {
  const persist = () => {
    if (win.isDestroyed()) return;

    const isMaximized = win.isMaximized();
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();

    configStore.set('window', {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    });
  };

  let debounceTimer = null;
  const debouncedPersist = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(persist, 400);
  };

  win.on('resize', debouncedPersist);
  win.on('move', debouncedPersist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);
  win.on('close', persist);
}

module.exports = { getSavedBounds, trackWindow, MIN_WIDTH, MIN_HEIGHT };
