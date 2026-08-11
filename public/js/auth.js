import { api } from './api.js';

let currentUser = null;
let token = localStorage.getItem('token');

export function getToken() {
  return token;
}

export function setToken(newToken) {
  token = newToken;
  localStorage.setItem('token', newToken);
}

export function getCurrentUser() {
  return currentUser;
}

export function setCurrentUser(user) {
  currentUser = user;
}

export async function login(username, password) {
  const data = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  setToken(data.token);
  setCurrentUser({
    id: data.id,
    username: data.username,
    is_admin: data.is_admin,
  });
  return data;
}

export function logout() {
  localStorage.removeItem('token');
  token = null;
  currentUser = null;
  window.location.reload();
}

export function renderLogin() {
  const wrap = document.getElementById('login-wrap');
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="card login-card">
      <div class="login-mark">F</div>
      <h1>Sign in to FileHub</h1>
      <p class="hint">Your private drive over WireGuard</p>
      <form id="login-form">
        <input type="text" id="login-username" placeholder="Username" required>
        <input type="password" id="login-password" placeholder="Password" required>
        <button type="submit" class="btn btn-primary">Sign in</button>
      </form>
      <div id="login-error" class="field-error"></div>
    </div>
  `;

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const btn = e.target.querySelector('button');
    const errorEl = document.getElementById('login-error');

    btn.disabled = true;
    errorEl.textContent = '';

    try {
      await login(username, password);
      window.location.reload();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
}