(() => {
  'use strict';

  const firstString = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim();
  const pick = (object, ...keys) => keys.map((key) => object?.[key]).find((value) => value !== undefined);

  function safeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), window.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function setText(selector, value) {
    if (!value) return;
    document.querySelectorAll(selector).forEach((element) => {
      element.textContent = value;
    });
  }

  function applyLogo(value) {
    const src = safeHttpUrl(value);
    if (!src) return;
    document.querySelectorAll('.brand').forEach((brand) => {
      const oldMark = brand.querySelector('.brand-symbol, .brand-mark');
      let image = brand.querySelector('img[data-site-logo]');
      if (!image) {
        image = document.createElement('img');
        image.dataset.siteLogo = '';
        image.alt = '';
        image.width = 27;
        image.height = 23;
        image.style.objectFit = 'contain';
        image.style.flex = 'none';
        brand.prepend(image);
      }
      image.src = src;
      if (oldMark) oldMark.hidden = true;
    });
  }

  function applyFavicon(value) {
    const href = safeHttpUrl(value);
    if (!href) return;
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.append(link);
    }
    link.href = href;
  }

  function applyHomeCopy(home) {
    if (!home || !document.querySelector('.gallery-intro')) return;
    const eyebrow = firstString(pick(home, 'eyebrow', 'kicker'));
    const title = firstString(pick(home, 'title', 'heading'));
    const highlight = firstString(pick(home, 'highlight', 'highlightedText'));
    const copy = firstString(pick(home, 'description', 'copy', 'subtitle'));
    const sectionTitle = firstString(pick(home, 'sectionTitle', 'worksTitle'));
    const sectionCopy = firstString(pick(home, 'sectionDescription', 'worksDescription'));

    setText('.gallery-intro .eyebrow', eyebrow);
    setText('.gallery-intro .intro-copy', copy);
    setText('.section-heading h2', sectionTitle);
    setText('.section-heading > p', sectionCopy);

    const heading = document.querySelector('.gallery-intro h1');
    if (heading && title) {
      heading.textContent = '';
      heading.append(document.createTextNode(title));
      if (highlight) {
        heading.append(document.createElement('br'));
        const span = document.createElement('span');
        span.textContent = highlight;
        heading.append(span);
      }
    }
  }

  function applyTheme(config) {
    const theme = pick(config, 'theme', 'themeSwitch');
    const enabled = typeof theme === 'object' && theme !== null
      ? pick(theme, 'enabled', 'showSwitch')
      : pick(config, 'themeSwitchEnabled', 'showThemeSwitch');
    if (typeof enabled === 'boolean') {
      document.querySelectorAll('.theme-switch').forEach((control) => {
        control.hidden = !enabled;
      });
    }

    const preferred = firstString(
      typeof theme === 'object' && theme !== null ? pick(theme, 'default', 'mode') : undefined,
      pick(config, 'defaultTheme')
    );
    if (['light', 'dark', 'system'].includes(preferred) && !localStorage.getItem('site-theme')) {
      const dark = preferred === 'dark' || (preferred === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.className = dark ? 'dark' : 'light';
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    }
  }

  function applyConfig(payload) {
    const config = payload?.settings && typeof payload.settings === 'object' ? payload.settings : payload;
    if (!config || typeof config !== 'object') throw new Error('站点设置格式无效');

    const branding = config.branding && typeof config.branding === 'object' ? config.branding : {};
    const appearance = config.appearance && typeof config.appearance === 'object' ? config.appearance : {};
    const name = firstString(branding.name, pick(config, 'siteName', 'name', 'title'));
    const description = firstString(branding.description, pick(config, 'siteDescription', 'description'));
    const logo = firstString(branding.logo, pick(config, 'logoUrl', 'logo'));
    const favicon = firstString(branding.favicon, pick(config, 'faviconUrl', 'favicon'), logo);
    const footer = firstString(branding.footer, pick(config, 'footerText', 'footer'));
    const accent = firstString(appearance.accentColor, pick(config, 'accentColor', 'accent'));
    const home = pick(config, 'homepage', 'home', 'hero');

    setText('.brand > span:last-child, .brand-name, [data-site-name]', name);
    setText('[data-site-description]', description);
    setText('.footer > p, .site-footer > p, [data-site-footer]', footer);
    if (description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta) meta.content = description;
    }
    if (name && !location.pathname.startsWith('/works/')) document.title = name;
    if (accent && CSS.supports('color', accent)) document.documentElement.style.setProperty('--accent', accent);

    applyLogo(logo);
    applyFavicon(favicon);
    applyHomeCopy(home);
    applyTheme({
      ...config,
      defaultTheme: appearance.defaultTheme,
      themeSwitchEnabled: appearance.allowThemeSwitch
    });
    return config;
  }

  const ready = document.readyState === 'loading'
    ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();

  window.siteConfigPromise = fetch('/api/settings', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  })
    .then((response) => {
      if (!response.ok) throw new Error(`加载站点设置失败 (${response.status})`);
      return response.json();
    })
    .then((payload) => ready.then(() => applyConfig(payload)))
    .catch((error) => {
      console.warn('无法应用站点设置：', error);
      return null;
    });
})();
