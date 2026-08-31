import { getToken } from '../core/auth.js';


export function progressBarHtml(id) {
  return `
  <div class="upload-progress" id="${id}">
    <div class="upload-progress-info">
      <span class="upload-progress-name"></span>
    </div>

    <div class="upload-progress-track">
      <div class="upload-progress-fill"></div>
    </div>

    <span class="upload-progress-pct"></span>
  </div>`;
}


export function showUploadProgress(containerId, filename) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.style.display = 'flex';

  const name = el.querySelector('.upload-progress-name');
  const fill = el.querySelector('.upload-progress-fill');
  const pct = el.querySelector('.upload-progress-pct');

  if (name) name.textContent = filename;
  if (fill) fill.style.width = '0%';
  if (pct) pct.textContent = '0%';
}


export function updateUploadProgress(containerId, percent) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const pct = Math.min(100, Math.max(0, percent));

  const fill = el.querySelector('.upload-progress-fill');
  const text = el.querySelector('.upload-progress-pct');

  if (fill) {
    fill.style.width = `${pct}%`;
  }

  if (text) {
    text.textContent = `${pct}%`;
  }
}


export function hideUploadProgress(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.style.display = 'none';
}


export function xhrUpload(url, formData, onProgress) {

  let xhr;

  const promise = new Promise((resolve, reject) => {

    xhr = new XMLHttpRequest();

    xhr.open('POST', url);

    // 5 minutes timeout
    xhr.timeout = 300000;


    const token = getToken();

    if (token) {
      xhr.setRequestHeader(
        'Authorization',
        `Bearer ${token}`
      );
    }


    let lastProgress = -1;


    xhr.upload.onprogress = (e) => {

      if (!e.lengthComputable || !onProgress) {
        return;
      }

      const percent = Math.round(
        (e.loaded / e.total) * 100
      );


      // جلوگیری از update تکراری
      if (percent !== lastProgress) {
        lastProgress = percent;
        onProgress(percent);
      }

    };


    xhr.onload = () => {

      let data = {};

      try {
        data = JSON.parse(xhr.responseText);
      } catch {}


      if (onProgress) {
        onProgress(100);
      }


      if (xhr.status >= 200 && xhr.status < 300) {

        resolve(data);

      } else {

        reject(
          new Error(
            data.error ||
            `Upload failed (${xhr.status})`
          )
        );

      }

    };


    xhr.onerror = () => {
      reject(
        new Error('Network error during upload')
      );
    };


    xhr.ontimeout = () => {
      reject(
        new Error('Upload timeout')
      );
    };


    xhr.onabort = () => {
      reject(
        new Error('Upload cancelled')
      );
    };


    xhr.send(formData);

  });


  // NOTE: every caller in this codebase does `await xhrUpload(...)`
  // directly and uses the resolved value as the server response
  // (see chat.js / dm.js — `const message = await xhrUpload(...)`).
  // Returning a plain `{ promise, cancel }` wrapper object here meant
  // `await` resolved to that wrapper itself (it has no `.then`), not
  // the actual response — every uploaded chat/DM message rendered as
  // a broken bubble with undefined content until the socket echo
  // corrected it a moment later. Attaching `cancel` directly onto the
  // promise keeps cancellation available without breaking `await`.
  promise.cancel = () => {
    if (xhr) {
      xhr.abort();
    }
  };

  return promise;
}