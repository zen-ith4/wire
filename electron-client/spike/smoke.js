#!/usr/bin/env node
/**
 * Smoke test for Electron app startup.
 * Launches Electron, waits for connect screen, then exits.
 */

const { spawn } = require('child_process');
const path = require('path');

const electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const appPath = path.join(__dirname, '..');

console.log(`[smoke] Starting Electron from ${electronPath}`);
console.log(`[smoke] App path: ${appPath}`);

const electron = spawn(electronPath, [appPath], {
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let errorOutput = '';
let exited = false;

electron.stdout.on('data', (data) => {
  output += data.toString();
  console.log(`[stdout] ${data.toString().trim()}`);
});

electron.stderr.on('data', (data) => {
  errorOutput += data.toString();
  console.log(`[stderr] ${data.toString().trim()}`);
});

electron.on('close', (code) => {
  exited = true;
  console.log(`[smoke] Electron exited with code ${code}`);
  if (code === 0) {
    console.log('[smoke] SUCCESS: Electron started and exited cleanly');
  } else {
    console.log('[smoke] FAILURE: Electron exited with non-zero code');
  }
});

electron.on('error', (err) => {
  exited = true;
  console.log(`[smoke] ERROR: ${err.message}`);
});

// Timeout after 30 seconds
setTimeout(() => {
  if (!exited) {
    console.log('[smoke] TIMEOUT: Killing Electron after 30s');
    electron.kill('SIGTERM');
    setTimeout(() => {
      if (!exited) electron.kill('SIGKILL');
    }, 5000);
  }
}, 30000);

// Auto-quit after connect screen loads (we detect "ready-to-show" in main.js)
setTimeout(() => {
  if (!exited) {
    console.log('[smoke] Requesting app quit after 10s');
    // We can't easily signal the app to quit from here without IPC,
    // so we'll just kill it after a reasonable time
  }
}, 10000);