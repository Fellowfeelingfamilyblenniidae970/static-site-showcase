function pageUrl(page) {
  return `/pages/${encodeURIComponent(page.slug)}`;
}

function createPageCard(page) {
  const card = document.createElement('a');
  card.className = 'article-card';
  card.href = pageUrl(page);

  const meta = document.createElement('div');
  meta.className = 'article-card-meta';
  const type = document.createElement('span');
  type.className = 'article-type';
  type.textContent = page.type || '页面';
  const category = document.createElement('span');
  category.textContent = page.category || '未分类';
  meta.append(type, category);

  const title = document.createElement('h3');
  title.textContent = page.title;
  const excerpt = document.createElement('p');
  excerpt.textContent = page.excerpt || '打开查看完整内容。';
  const date = document.createElement('time');
  date.dateTime = page.createdAt;
  date.textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(page.createdAt));
  card.append(meta, title, excerpt, date);
  return card;
}

async function fetchPages() {
  const preferred = await fetch('/api/pages');
  if (preferred.ok) return preferred.json();
  if (preferred.status !== 404) {
    const error = await preferred.json().catch(() => ({}));
    throw new Error(error.error || '加载失败');
  }
  const legacy = await fetch('/api/articles');
  const data = await legacy.json();
  if (!legacy.ok) throw new Error(data.error || '加载失败');
  return data;
}

async function loadPages() {
  const list = document.getElementById('articleList');
  try {
    const data = await fetchPages();
    const pages = data.pages || data.articles || [];
    if (!pages.length) {
      const empty = document.createElement('div');
      empty.className = 'gallery-empty';
      empty.textContent = '尚未发布内容页面';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...pages.map(createPageCard));
  } catch (error) {
    const message = document.createElement('div');
    message.className = 'gallery-state error';
    message.textContent = `内容加载失败：${error.message}`;
    list.replaceChildren(message);
  }
}

document.addEventListener('DOMContentLoaded', loadPages);
