(() => {
  'use strict';

  const form = document.getElementById('loginForm');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const submitButton = document.getElementById('submitButton');
  const buttonText = submitButton.querySelector('.button-text');
  const spinner = submitButton.querySelector('.spinner');
  const errorBox = document.getElementById('loginError');

  function goToAdmin() {
    window.location.replace('/admin/');
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    if (!value) return '';
    try { return decodeURIComponent(value.slice(prefix.length)); }
    catch (_error) { return value.slice(prefix.length); }
  }

  function setError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function setBusy(busy) {
    form.setAttribute('aria-busy', String(busy));
    username.disabled = busy;
    password.disabled = busy;
    submitButton.disabled = busy;
    spinner.hidden = !busy;
    buttonText.textContent = busy ? '正在登录…' : '登录';
  }

  async function responseMessage(response, fallback) {
    try {
      const body = await response.json();
      if (typeof body.error === 'string' && body.error.trim()) return body.error;
      if (typeof body.message === 'string' && body.message.trim()) return body.message;
    } catch (_error) {
      // Non-JSON errors use the safe local fallback below.
    }
    return fallback;
  }

  async function checkSession() {
    try {
      const response = await fetch('/api/auth/me', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (response.ok) {
        goToAdmin();
        return;
      }
    } catch (_error) {
      // A failed session probe should not prevent a fresh login attempt.
    }
    submitButton.disabled = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('');

    const submittedUsername = username.value.trim();
    const submittedPassword = password.value;
    if (!submittedUsername || !submittedPassword) {
      setError('请输入用户名和密码。');
      (!submittedUsername ? username : password).focus();
      return;
    }

    setBusy(true);
    try {
      const challenge = await fetch('/api/auth/login-challenge', {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store'
      });
      if (!challenge.ok) throw new Error(await responseMessage(challenge, '无法准备登录请求，请稍后重试。'));
      const loginCsrf = readCookie('zcode_login_csrf');
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Login-CSRF-Token': loginCsrf
        },
        body: JSON.stringify({
          username: submittedUsername,
          password: submittedPassword
        })
      });

      if (!response.ok) {
        throw new Error(await responseMessage(response, '登录失败，请检查用户名和密码。'));
      }
      goToAdmin();
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败，请稍后重试。');
      setBusy(false);
      password.select();
    }
  });

  checkSession();
})();
