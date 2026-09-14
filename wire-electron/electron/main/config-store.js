'use strict';

/**
 * Persistent desktop-client configuration.
 *
 * This stores ONLY desktop-client concerns (which Wire server to talk
 * to, window geometry, a couple of UI prefs) — never server secrets.
 * It intentionally has nothing to do with the project's `.env` file:
 * that file configures the Wire *server* (JWT_SECRET, SMTP, DB path,
 * WireGuard subnet, ...) and must never be read, written, or bundled
 * by the desktop client.
 *
 * File lives at: <app.getPath('userData')>/wire-config.json
 * e.g. ~/.config/Wire/wire-config.json on Linux,
 *      ~/Library/Application Support/Wire/wire-config.json on macOS,
 *      %APPDATA%/Wire/wire-config.json on Windows.
 *
 * This is a per-user OS-managed directory — never the project
 * directory and never the current working directory.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILE_NAME = 'wire-config.json';

const DEFAULTS = Object.freeze({
  // The Wire server the user has chosen to connect to, e.g.
  // "https://wire.example.com" or "http://10.10.0.7:3000".
  // null means "not configured yet" -> show the Welcome screen.
  serverUrl: null,

  // Whether to skip the "which server?" prompt on next launch.
  rememberServer: true,

  // Per-origin opt-in to trust a self-signed/invalid certificate.
  // Off by default. Keyed by origin ("https://host:port"), value is
  // the exact certificate fingerprint the user accepted, so a MITM
  // presenting a *different* bad cert for the same host is still
  // rejected rather than silently trusted.
  trustedCertificates: {},

  // Window geometry, remembered between launches.
  window: {
    width: 1280,
    height: 820,
    x: null,
    y: null,
    isMaximized: false,
  },
});

let cache = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
}

function readFromDisk() {
  const configPath = getConfigPath();

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      window: {
        ...structuredClone(DEFAULTS.window),
        ...(parsed && parsed.window ? parsed.window : {}),
      },
      trustedCertificates: {
        ...(parsed && typeof parsed.trustedCertificates === 'object' && parsed.trustedCertificates
          ? parsed.trustedCertificates
          : {}),
      },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[config-store] Failed to read config, using defaults:', err.message);
    }
    return structuredClone(DEFAULTS);
  }
}

function writeToDisk(config) {
  const configPath = getConfigPath();

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Write atomically: write to a temp file then rename, so a crash
    // mid-write can't corrupt the config the next launch depends on.
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    console.error('[config-store] Failed to write config:', err.message);
  }
}

function load() {
  if (!cache) {
    cache = readFromDisk();
  }
  return cache;
}

function save() {
  if (cache) {
    writeToDisk(cache);
  }
}

function get(keyPath) {
  const config = load();
  return keyPath.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), config);
}

function set(keyPath, value) {
  const config = load();
  const keys = keyPath.split('.');
  let obj = config;

  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]];
  }

  obj[keys[keys.length - 1]] = value;
  save();
  return config;
}

function getAll() {
  return structuredClone(load());
}

module.exports = {
  getConfigPath,
  get,
  set,
  getAll,
  DEFAULTS,
};
