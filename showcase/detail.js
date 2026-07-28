const state = {
  id: location.pathname.split('/').filter(Boolean).at(-1),
  site: null,
  files: [],
  source: null,
  mode: 'code',
  wrapped: false
};

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date(value));
}

function setMode(mode) {
  state.mode = mode;
  const content = document.querySelector('.workspace-content');
  content.dataset.mode = mode;
  document.querySelectorAll('.mode-switch [data-mode]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.mode === mode));
  });
}

function refreshPreview() {
  const frame = document.getElementById('previewFrame');
  document.getElementById('previewLoading').hidden = false;
  frame.src = frame.src;
}

async function fullscreenPreview() {
  const pane = document.querySelector('.preview-pane');
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (state.mode !== 'preview') setMode('preview');
  try {
    if (pane.requestFullscreen) await pane.requestFullscreen();
    else window.open(state.site.previewUrl, '_blank', 'noopener');
  } catch {
    window.open(state.site.previewUrl, '_blank', 'noopener');
  }
}

function fileIcon(path) {
  const extension = path.split('.').pop().toLowerCase();
  if (extension === 'html') return '<>';
  if (extension === 'css') return '#';
  if (extension === 'js' || extension === 'json') return '{}';
  return '·';
}

function renderFileTree() {
  const tree = document.getElementById('fileTree');
  if (state.files.length === 0) {
    tree.textContent = '没有可展示的源文件';
    tree.className = 'file-tree empty';
    return;
  }

  const root = { children: new Map() };
  state.files.forEach((file) => {
    const parts = file.path.split('/');
    let parent = root;
    parts.forEach((name, index) => {
      if (!parent.children.has(name)) {
        parent.children.set(name, {
          name,
          path: parts.slice(0, index + 1).join('/'),
          file: index === parts.length - 1 ? file : null,
          children: new Map()
        });
      }
      parent = parent.children.get(name);
    });
  });

  function appendNodes(parent, container, depth) {
    [...parent.children.values()]
      .sort((left, right) => Number(Boolean(left.file)) - Number(Boolean(right.file)) || left.name.localeCompare(right.name, 'zh-CN'))
      .forEach((node) => {
        if (!node.file) {
          const directory = document.createElement('div');
          directory.className = 'file-directory';
          directory.style.setProperty('--depth', String(depth));
          directory.textContent = `▾ ${node.name}`;
          container.append(directory);
          appendNodes(node, container, depth + 1);
          return;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.path = node.file.path;
        button.title = node.file.path;
        button.style.setProperty('--depth', String(depth));
        const icon = document.createElement('span');
        icon.textContent = fileIcon(node.file.path);
        const label = document.createElement('span');
        label.textContent = node.name;
        button.append(icon, label);
        button.addEventListener('click', () => loadSource(node.file.path));
        container.append(button);
      });
  }

  tree.className = 'file-tree';
  const fragment = document.createDocumentFragment();
  appendNodes(root, fragment, 0);
  tree.replaceChildren(fragment);
}

async function loadSource(filePath) {
  const codeState = document.getElementById('codeState');
  const codeBlock = document.getElementById('codeBlock');
  codeState.hidden = false;
  codeState.innerHTML = '<span class="loader"></span>正在读取代码...';
  codeBlock.hidden = true;

  try {
    const response = await fetch(`/api/gallery/${state.id}/source?path=${encodeURIComponent(filePath)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取失败');

    state.source = data.source;
    document.getElementById('currentFile').textContent = data.source.path;
    document.getElementById('currentLanguage').textContent = data.source.language;

    document.querySelectorAll('.file-tree button').forEach((button) => {
      button.dataset.active = String(button.dataset.path === filePath);
    });

    const code = document.getElementById('sourceCode');
    code.className = `language-${data.source.language}`;
    code.textContent = data.source.content;
    if (window.Prism) Prism.highlightElement(code);
    codeState.hidden = true;
    codeBlock.hidden = false;
  } catch (error) {
    codeState.textContent = `无法读取代码：${error.message}`;
  }
}

async function copyCode() {
  if (!state.source) return;
  const button = document.getElementById('copyCode');
  try {
    await navigator.clipboard.writeText(state.source.content);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => { button.textContent = '复制代码'; }, 1600);
}

function toggleWrap() {
  state.wrapped = !state.wrapped;
  document.getElementById('codeBlock').classList.toggle('wrap', state.wrapped);
  document.getElementById('wrapCode').setAttribute('aria-pressed', String(state.wrapped));
}

async function loadFiles() {
  const tree = document.getElementById('fileTree');
  try {
    const response = await fetch(`/api/gallery/${state.id}/files`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法读取文件');
    state.files = data.files;
    renderFileTree();
    if (state.files.length > 0) await loadSource(state.files[0].path);
  } catch (error) {
    tree.className = 'file-tree empty';
    tree.textContent = error.message;
    document.getElementById('codeState').textContent = error.message;
  }
}

async function initDetail() {
  const detailState = document.getElementById('detailState');
  try {
    const response = await fetch(`/api/gallery/${state.id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '作品不存在');
    state.site = data.site;

    document.title = `${data.site.name} · 创意展厅`;
    document.getElementById('workTitle').textContent = data.site.name;
    document.getElementById('workDescription').textContent = data.site.description || '一个可以实时运行和查看源代码的静态网站作品。';
    document.getElementById('workOwner').textContent = `作者：${data.site.ownerUsername || '未署名'}`;
    document.getElementById('workDate').textContent = `发布于 ${formatDate(data.site.createdAt)}`;
    document.getElementById('workDate').dateTime = data.site.createdAt;
    document.getElementById('openStandalone').href = data.site.previewUrl;

    const download = document.getElementById('downloadZip');
    if (data.site.sourceVisible) {
      download.href = `/api/gallery/${encodeURIComponent(state.id)}/download`;
      download.hidden = false;
      setMode('code');
    } else {
      document.querySelector('[data-mode="code"]').hidden = true;
      setMode('preview');
    }

    const frame = document.getElementById('previewFrame');
    frame.addEventListener('load', () => { document.getElementById('previewLoading').hidden = true; });
    frame.src = data.site.previewUrl;

    detailState.hidden = true;
    document.getElementById('detailContent').hidden = false;
    if (data.site.sourceVisible) await loadFiles();
    else {
      document.getElementById('fileTree').textContent = '该作品未公开源代码';
      document.getElementById('codeState').textContent = '该作品未公开源代码';
    }
  } catch (error) {
    detailState.className = 'detail-loading error';
    detailState.innerHTML = `<strong>无法打开作品</strong><p>${error.message}</p><a href="/">返回作品列表</a>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mode-switch [data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.getElementById('refreshPreview').addEventListener('click', refreshPreview);
  document.getElementById('fullscreenPreview').addEventListener('click', fullscreenPreview);
  document.getElementById('copyCode').addEventListener('click', copyCode);
  document.getElementById('wrapCode').addEventListener('click', toggleWrap);
  initDetail();
});
