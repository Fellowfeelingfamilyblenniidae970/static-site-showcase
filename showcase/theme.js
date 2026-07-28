(() => {
  const key = 'site-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function current() {
    return localStorage.getItem(key) || 'dark';
  }

  function apply(theme, persist = false) {
    const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    document.documentElement.className = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelectorAll('[data-theme]').forEach((button) => {
      button.dataset.active = String(button.dataset.theme === theme);
    });
    if (persist) localStorage.setItem(key, theme);
  }

  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    document.querySelectorAll('[data-theme]').forEach((button) => {
      button.addEventListener('click', () => apply(button.dataset.theme, true));
    });
    media.addEventListener('change', () => {
      if (current() === 'system') apply('system');
    });
  });
})();
