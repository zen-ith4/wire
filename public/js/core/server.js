const SERVER_STORAGE_KEY = 'wire_server_endpoint';

const DEFAULT_SERVER_ENDPOINT = 'https://wireapp.ir';

let nativeDetected = null;

function isCapacitor() {
  if (nativeDetected !== null) {
    return nativeDetected;
  }

  const capacitor = window.Capacitor;

  // window.Capacitor may not exist yet the first time this runs: answer
  // "not native" but do not remember it. Once it exists, the answer is
  // fixed for the life of the page, so it is computed (and logged) once
  // instead of on every API request.
  if (!capacitor) {
    return false;
  }

  const native =
    typeof capacitor.isNativePlatform === 'function' &&
    capacitor.isNativePlatform();

  nativeDetected = native;

  console.log('[Server] Native app:', native);

  return native;
}

export function isNativeApp() {
  return isCapacitor();
}

export function normalizeServerAddress(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('Please enter a server address.');
  }

  let input = rawInput.trim();

  if (!input) {
    throw new Error('Please enter a server address.');
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    input = 'http://' + input;
  }

  let parsed;

  try {
    parsed = new URL(input);
  } catch (error) {
    throw new Error(
      "That doesn't look like a valid address. Try formats like 192.168.1.100:3000 or https://example.com"
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// servers are supported.');
  }

  if (!parsed.hostname) {
    throw new Error('Please include a host or IP address.');
  }

  return parsed.origin;
}

export function getServerEndpoint() {
  if (!isCapacitor()) {
    return window.location.origin;
  }

  const saved = localStorage.getItem(SERVER_STORAGE_KEY);

  if (!saved) {
    return DEFAULT_SERVER_ENDPOINT;
  }

  try {
    return normalizeServerAddress(saved);
  } catch {
    localStorage.removeItem(SERVER_STORAGE_KEY);
    return DEFAULT_SERVER_ENDPOINT;
  }
}

export function setServerEndpoint(rawInput) {
  const normalized = normalizeServerAddress(rawInput);

  localStorage.setItem(SERVER_STORAGE_KEY, normalized);

  return normalized;
}

export function clearServerEndpoint() {
  localStorage.removeItem(SERVER_STORAGE_KEY);
}

export function resolveServerUrl(url) {
  if (!url || typeof url !== 'string') {
    return url;
  }

  if (!isCapacitor()) {
    return url;
  }

  try {
    const endpoint = getServerEndpoint();
    return new URL(url, endpoint).toString();
  } catch {
    return url;
  }
}