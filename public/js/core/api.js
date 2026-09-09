import {
  getToken,
  logout
} from './auth.js';


let isHandlingUnauthorized = false;


/* =========================================================
 * API
 * ========================================================= */

export async function api(
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
      url,
      {
        ...options,
        headers
      }
    );


  if (response.status === 401) {

    if (!isHandlingUnauthorized) {
      isHandlingUnauthorized = true;

      try {
        logout();
      } catch (error) {
        console.error(
          'Logout failed:',
          error
        );
      }
    }

    throw new Error(
      'Session expired'
    );
  }


  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Server error (${response.status}): ${
        text.substring(0, 100)
      }`
    );
  }


  if (!response.ok) {
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
      url,
      {
        ...options,
        headers
      }
    );


  if (response.status === 401) {

    if (!isHandlingUnauthorized) {
      isHandlingUnauthorized = true;

      try {
        logout();
      } catch (error) {
        console.error(
          'Logout failed:',
          error
        );
      }
    }

    throw new Error(
      'Session expired'
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