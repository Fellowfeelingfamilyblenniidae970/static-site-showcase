const slug = location.pathname.split('/').filter(Boolean).at(-1);

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value));
}

function canonicalPageUrl(page) {
  return `/pages/${encodeURIComponent(page.slug)}`;
}

function emptyMessage(text) {
  const element = document.createElement('p');
  element.className = 'navigation-empty';
  element.textContent = text;
  return element;
}

async function fetchJsonWithFallback(primary, legacy) {
  const response = await fetch(primary);
  if (response.ok) return response.json();
  if (response.status !== 404) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '内容加载失败');
  }
  const fallback = await fetch(legacy);
  const data = await fallback.json();
  if (!fallback.ok) throw new Error(data.error || '内容加载失败');
  return data;
}

function renderPager(container, page, label) {
  const link = document.createElement('a');
  link.href = canonicalPageUrl(page);
  const kind = document.createElement('span');
  kind.textContent = label;
  const title = document.createElement('strong');
  title.textContent = page.title;
  link.append(kind, title);
  container.append(link);
}

function renderPageNavigation(container, pages, currentSlug) {
  if (!pages.length) {
    container.append(emptyMessage('暂无其他内容'));
    return;
  }

  const groups = new Map();
  pages.forEach((page) => {
    const category = page.category || '未分类';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(page);
  });

  groups.forEach((items, category) => {
    const group = document.createElement('section');
    group.className = 'page-nav-group';
    const heading = document.createElement('h2');
    heading.textContent = category;
    const links = document.createElement('div');
    items.forEach((page) => {
      const link = document.createElement('a');
      link.href = canonicalPageUrl(page);
      link.textContent = page.title;
      if (page.slug === currentSlug) link.setAttribute('aria-current', 'page');
      links.append(link);
    });
    group.append(heading, links);
    container.append(group);
  });
}

function showLoadError(error) {
  const state = document.getElementById('articleState');
  state.className = 'detail-loading error';
  const title = document.createElement('strong');
  title.textContent = '无法打开内容';
  const copy = document.createElement('p');
  copy.textContent = error.message;
  const link = document.createElement('a');
  link.href = '/pages';
  link.textContent = '返回内容列表';
  state.replaceChildren(title, copy, link);
}

async function loadPage() {
  const state = document.getElementById('articleState');
  try {
    const [detailData, listData] = await Promise.all([
      fetchJsonWithFallback(`/api/pages/${encodeURIComponent(slug)}`, `/api/articles/${encodeURIComponent(slug)}`),
      fetchJsonWithFallback('/api/pages', '/api/articles')
    ]);
    const page = detailData.page || detailData.article;
    const pages = listData.pages || listData.articles || [];
    if (!page) throw new Error('内容不存在');

    document.title = `${page.title} · 创意展厅`;
    document.getElementById('articleCategory').textContent = `${page.type || '页面'} · ${page.category || '未分类'}`;
    document.getElementById('articleTitle').textContent = page.title;
    const date = document.getElementById('articleDate');
    date.dateTime = page.createdAt;
    date.textContent = `发布于 ${formatDate(page.createdAt)}`;
    document.getElementById('articleExcerpt').textContent = page.excerpt || '';

    // contentHtml 由服务端安全渲染；前端不解析或重新生成不可信 HTML。
    const body = document.getElementById('articleBody');
    body.innerHTML = page.contentHtml;
    if (window.Prism) Prism.highlightAllUnder(body);

    const toc = document.getElementById('articleToc');
    (page.toc || []).filter((item) => item.level >= 1 && item.level <= 3).forEach((item) => {
      const link = document.createElement('a');
      link.href = `#${encodeURIComponent(item.id)}`;
      link.textContent = item.text;
      link.dataset.level = String(item.level);
      toc.append(link);
    });
    if (!toc.children.length) toc.append(emptyMessage('本页没有标题目录'));

    const pager = document.getElementById('articlePager');
    if (page.prev) renderPager(pager, page.prev, '上一篇');
    if (page.next) renderPager(pager, page.next, '下一篇');
    renderPageNavigation(document.getElementById('articleCategories'), pages, page.slug);

    if (location.pathname.startsWith('/articles/')) {
      history.replaceState(null, '', `${canonicalPageUrl(page)}${location.search}${location.hash}`);
    }
    state.hidden = true;
    document.getElementById('articleLayout').hidden = false;
  } catch (error) {
    showLoadError(error);
  }
}

document.addEventListener('DOMContentLoaded', loadPage);
