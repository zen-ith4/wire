import {
getToken,
logout
} from './auth.js';

import {
resolveServerUrl
} from './server.js';

import { perfApi } from './perf.js';

const GROUP_PROTOCOL = 2;

let isHandlingUnauthorized = false;

/*
 * Did a 401 end THIS session?
 *
 * The explicit codes/messages always do. A bare `{error: 'Unauthorized'}` is what
 * the auth middleware answers when the bearer token is valid-looking but the
 * account no longer accepts it (token_version bumped by a password change,
 * account deactivated, user gone). Credential errors on login/change-password
 * carry their own messages ('Invalid credentials', ...), so a bare Unauthorized
 * on a request that SENT a token is a dead session. Without this the client kept
 * the revoked token, never ran logout(), and wire:logout never cleared the held
 * key-trust state for the next account on the same page.
 */
function isSessionError(data, token) {
  return (
    data?.code === 'TOKEN_EXPIRED' ||
    data?.code === 'INVALID_TOKEN' ||
    data?.code === 'AUTH_REQUIRED' ||
    data?.error === 'Session expired' ||
    data?.error === 'Invalid token' ||
    data?.error === 'Authentication required' ||
    (Boolean(token) && data?.error === 'Unauthorized')
  );
}

/* =========================================================

* API
* ========================================================= */

// Every request goes through this thin wrapper so opt-in timing
// (core/perf.js, off unless localStorage.wire_perf === '1') can see it.
export async function api(
url,
options = {}
) {
const perfDone = perfApi();

try {
return await apiRequest(url, options);
} finally {
perfDone();
}
}

async function apiRequest(
url,
options = {}
) {
const token = getToken();

const headers = {
...options.headers
};

if (token) {
headers['Authorization'] =
'Bearer ' + token;
}

// F7: tell the server which group E2EE protocol this build speaks. Stale
// builds omit it and get an explicit 426 update_required instead of silently
// failing to parse v:2 KDMs. Bump together with GROUP_PROTOCOL_MIN
// (middleware/groupProtocol.js).
if (typeof url === 'string' && url.startsWith('/api/groups')) {
headers['X-Wire-Group-Proto'] = String(GROUP_PROTOCOL);
}

const response =
await fetch(
resolveServerUrl(url),
{
...options,
headers
}
);

const text =
await response.text();

let data = null;

try {
data = text
? JSON.parse(text)
: null;
} catch {
data = null;
}

/*

* Handle authentication failures separately.
* 
* A 401 does NOT automatically mean that the session
* expired. Some endpoints may legitimately use 401 for
* things such as incorrect credentials.
  */
  if (response.status === 401) {

const errorMessage =
  data?.error ||
  'Authentication required';

/*
 * Only treat the response as an expired/invalid session
 * when the server explicitly tells us that authentication
 * failed because of the session/token.
 */
const sessionError = isSessionError(data, token);

if (sessionError && !isHandlingUnauthorized) {
  isHandlingUnauthorized = true;

  try {
    logout();
  } catch (error) {
    console.error(
      'Logout failed:',
      error
    );
  }

  throw new Error(
    'Session expired'
  );
}

throw new Error(errorMessage);

}

if (response.status === 426 && data?.code === 'update_required') {

try {
globalThis.dispatchEvent?.(
new CustomEvent('wire:update-required', { detail: data })
);
} catch {
/* no DOM events available */
}

const err = new Error(data.error || 'Update required');
err.code = 'update_required';
throw err;

}

if (!response.ok) {

if (!data) {
  throw new Error(
    `Server error (${response.status}): ${
      text.substring(0, 100)
    }`
  );
}

throw new Error(
  data.error ||
  `Request failed (${response.status})`
);

}

return data;
}

/* =========================================================

* Blob API
* ========================================================= */

export async function fetchBlob(
url,
options = {}
) {
const token = getToken();

const headers = {
...options.headers
};

if (token) {
headers['Authorization'] =
'Bearer ' + token;
}

const response =
await fetch(
resolveServerUrl(url),
{
...options,
headers
}
);

if (response.status === 401) {

const text =
  await response.text();

let data = null;

try {
  data = text
    ? JSON.parse(text)
    : null;
} catch {
  data = null;
}

const sessionError = isSessionError(data, token);

if (sessionError && !isHandlingUnauthorized) {
  isHandlingUnauthorized = true;

  try {
    logout();
  } catch (error) {
    console.error(
      'Logout failed:',
      error
    );
  }

  throw new Error(
    'Session expired'
  );
}

throw new Error(
  data?.error ||
  'Authentication required'
);

}

if (!response.ok) {

const err =
  await response
    .json()
    .catch(() => ({
      error: 'Request failed'
    }));

throw new Error(
  err.error ||
  'Request failed'
);

}

return await response.blob();
}