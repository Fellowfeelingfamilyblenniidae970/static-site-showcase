function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(value));
}

function createWorkCard(site, index, options = {}) {
  const link = document.createElement('a');
  link.className = 'work-card';
  link.href = site.detailUrl;
  link.style.setProperty('--delay', `${Math.min(index * 60, 420)}ms`);

  const copy = document.createElement('div');
  copy.className = 'work-copy';

  const number = document.createElement('span');
  number.className = 'work-number';
  number.textContent = String(index + 1).padStart(2, '0');

  const title = document.createElement('h3');
  title.textContent = site.name;

  const description = document.createElement('p');
  description.textContent = site.description || '打开作品，查看实时运行效果和项目源代码。';

  const meta = document.createElement('div');
  meta.className = 'work-meta';
  const owner = document.createElement('span');
  owner.className = 'work-owner';
  owner.textContent = `作者：${site.ownerUsername || '未署名'}`;
  const date = document.createElement('time');
  date.dateTime = site.createdAt;
  date.textContent = formatDate(site.createdAt);
  const source = document.createElement('span');
  source.textContent = site.sourceVisible ? '源码公开' : '源码未公开';
  meta.append(owner, date, source);

  const action = document.createElement('span');
  action.className = 'work-action';
  action.textContent = '打开作品';

  copy.append(number, title, description, meta, action);

  const visual = document.createElement('div');
  visual.className = 'work-visual';
  const browserBar = document.createElement('div');
  browserBar.className = 'mini-browser-bar';
  browserBar.innerHTML = '<i></i><i></i><i></i><span>LIVE PREVIEW</span>';
  const iframe = document.createElement('iframe');
  iframe.title = `${site.name} 预览`;
  iframe.src = site.previewUrl;
  iframe.loading = 'lazy';
  iframe.tabIndex = -1;
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
  visual.append(browserBar, iframe);

  link.append(copy);
  if (options.layout !== 'compact' && options.showPreview !== false) {
    link.append(visual);
  } else {
    link.classList.add('work-card-text-only');
  }
  return link;
}

let gallerySites = [];
let gallerySettings = null;
let galleryLoggedIn = false;

function preferredLayout() {
  return localStorage.getItem('gallery-layout') || gallerySettings?.home?.layout || 'editorial';
}

function renderGallery(layout = preferredLayout()) {
  const grid = document.getElementById('galleryGrid');
  grid.dataset.layout = layout;
  document.querySelectorAll('[data-layout]').forEach((button) => {
    button.dataset.active = String(button.dataset.layout === layout);
  });

  if (gallerySites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gallery-empty';
    const title = document.createElement('strong');
    title.textContent = '公开作品正在准备中';
    const copy = document.createElement('p');
    copy.textContent = '通过工作台发布前端作品后，它们会展示在这里并可直接运行。';
    const action = document.createElement('a');
    action.href = galleryLoggedIn ? '/admin/' : '/login';
    action.textContent = galleryLoggedIn ? '进入工作台' : '管理员登录';
    empty.append(title, copy, action);
    grid.replaceChildren(empty);
    return;
  }

  grid.replaceChildren(...gallerySites.map((site, index) =>
    createWorkCard(site, index, { layout, showPreview: gallerySettings?.home?.showPreview })));
}

async function loadGallery() {
  const grid = document.getElementById('galleryGrid');
  try {
    const [config, galleryResponse, authResponse] = await Promise.all([
      window.siteConfigPromise || Promise.resolve(null),
      fetch('/api/gallery'),
      fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    ]);
    const data = await galleryResponse.json();
    if (!galleryResponse.ok) throw new Error(data.error || '加载失败');

    gallerySettings = config;
    gallerySites = [...(data.sites || [])]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    document.getElementById('workCount').textContent = gallerySites.length;
    const authEntry = document.getElementById('authEntry');
    if (authResponse.ok) {
      galleryLoggedIn = true;
      authEntry.href = '/admin/';
      authEntry.textContent = '进入工作台';
    }
    renderGallery();
  } catch (error) {
    const message = document.createElement('div');
    message.className = 'gallery-state error';
    message.textContent = `公开作品加载失败：${error.message}`;
    grid.replaceChildren(message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-layout]').forEach((button) => {
    button.addEventListener('click', () => {
      localStorage.setItem('gallery-layout', button.dataset.layout);
      renderGallery(button.dataset.layout);
    });
  });
  loadGallery();
});
