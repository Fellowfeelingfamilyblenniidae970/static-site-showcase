const state = { user: null, sites: [], pages: [], selectedFile: null, loadedViews: new Set(), pageSlugManual: false, previewTimer: null, previewRequest: 0 };
const $ = (id) => document.getElementById(id);

function cookie(name) { const item = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`)); return item ? decodeURIComponent(item.slice(name.length + 1)) : ''; }
async function apiFetch(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'X-CSRF-Token': cookie('zcode_csrf'), ...(options.headers || {}) } });
  if (response.status === 401) { location.replace('/login'); throw new Error('登录已过期'); }
  return response;
}
async function request(url, options = {}) { const response = await apiFetch(url, options); const type = response.headers.get('content-type') || ''; const data = type.includes('application/json') ? await response.json() : { error: (await response.text()).trim() }; if (!response.ok) throw Object.assign(new Error(data.error || `操作失败 (${response.status})`), { status: response.status }); return data; }
function message(text, type = 'success') { const el = $('globalMessage'); el.textContent = text; el.dataset.type = type; el.hidden = false; clearTimeout(message.timer); message.timer = setTimeout(() => el.hidden = true, 5000); }
function errorBox(id, text = '') { const el = $(id); el.textContent = text; el.hidden = !text; }
function action(text, style, handler) { const el = document.createElement('button'); el.type = 'button'; el.className = `btn btn-sm ${style}`; el.textContent = text; el.addEventListener('click', handler); return el; }
function badge(text, type = '') { const el = document.createElement('span'); el.className = `status-badge ${type}`; el.textContent = text; return el; }
function closeDialog(dialog) { dialog.close(); dialog.querySelectorAll('.alert').forEach((el) => el.hidden = true); }

const views = {
  sites: ['站点管理', '部署新站点并管理已有作品。'],
  pages: ['内容页面', '创建、预览并发布 Markdown 内容页面。'],
  settings: ['全站设置', '设置公开首页的品牌、外观和默认布局。'],
  users: ['账号管理', '管理账号，并展开查看各账号上传的页面。'],
  account: ['账号设置', '查看账号身份并更新登录凭据。']
};
const editorViews = new Set(['sites', 'account']);
function currentView() { const requested = location.hash.slice(1) || 'sites'; return views[requested] ? requested : 'sites'; }
async function showView() {
  let view = currentView();
  if (state.user?.role !== 'admin' && !editorViews.has(view)) { location.hash = 'sites'; view = 'sites'; }
  document.querySelectorAll('[data-view]').forEach((el) => el.hidden = el.dataset.view !== view);
  document.querySelectorAll('[data-view-link]').forEach((el) => el.dataset.active = String(el.dataset.viewLink === view));
  $('viewTitle').textContent = views[view][0]; $('viewDescription').textContent = views[view][1];
  if (state.loadedViews.has(view)) return;
  state.loadedViews.add(view);
  try {
    if (view === 'sites') await loadSites();
    if (view === 'pages') await loadPages();
    if (view === 'settings') await loadSettings();
    if (view === 'users') await loadUsers();
  } catch (error) { state.loadedViews.delete(view); message(error.message, 'error'); }
}

async function loadMe() {
  const { user } = await request('/api/auth/me'); state.user = user;
  const role = user.role === 'admin' ? '管理员' : '编辑者';
  $('currentUser').textContent = `${user.username} · ${role}`;
  $('accountCurrentUsername').textContent = user.username;
  $('accountUsername').value = user.username;
  $('accountRole').value = role;
  $('roleLabel').textContent = user.role === 'admin' ? '可管理全部内容' : '仅管理自己的内容';
  $('siteScope').textContent = user.role === 'admin' ? '全部账号上传的站点' : '仅显示你上传的站点';
  $('defaultPasswordWarning').hidden = !user.defaultPassword;
  document.querySelectorAll('[data-admin-only]').forEach((el) => el.hidden = user.role !== 'admin');
}
async function logout() { await request('/api/auth/logout', { method: 'POST' }); location.replace('/login'); }

async function saveOwnUsername(event) {
  event.preventDefault(); errorBox('accountUsernameError');
  const submit = $('accountUsernameSubmit'); submit.disabled = true;
  try {
    await request('/api/auth/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('accountUsername').value.trim(), currentPassword: $('accountUsernamePassword').value }) });
    alert('用户名已修改，所有会话已失效。请使用新用户名重新登录。'); location.replace('/login');
  } catch (error) { errorBox('accountUsernameError', error.message); }
  finally { submit.disabled = false; }
}
async function saveOwnPassword(event) {
  event.preventDefault(); errorBox('accountPasswordError');
  const submit = $('accountPasswordSubmit');
  if ($('accountNewPassword').value !== $('accountNewPasswordConfirm').value) return errorBox('accountPasswordError', '两次输入的新密码不一致');
  submit.disabled = true;
  try {
    await request('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: $('accountCurrentPassword').value, newPassword: $('accountNewPassword').value }) });
    alert('密码已修改，当前会话已失效。请使用新密码重新登录。'); location.replace('/login');
  } catch (error) { errorBox('accountPasswordError', error.message); }
  finally { submit.disabled = false; }
}

const pageTypeLabels = { article: '文章', doc: '文档', code: '代码' };

function pageSlug(title) {
  const normalized = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const parts = [];
  for (const character of normalized) {
    if (/[a-z0-9]/.test(character)) parts.push(character);
    else if (/\s|[-_.]/.test(character)) parts.push('-');
    else if (/[^\x00-\x7f]/.test(character)) parts.push(`-u${character.codePointAt(0).toString(16)}-`);
  }
  return parts.join('').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 81).replace(/-$/g, '') || 'page';
}
function pagePayload() {
  return {
    title: $('pageTitle').value.trim(),
    slug: $('pageSlug').value.trim().toLowerCase(),
    type: $('pageType').value,
    category: $('pageCategory').value.trim(),
    excerpt: $('pageExcerpt').value.trim(),
    sort_order: Number.parseInt($('pageSortOrder').value, 10) || 0,
    published: $('pagePublished').checked,
    content: $('pageContent').value
  };
}
function previewPlaceholder(text, className = 'preview-placeholder') {
  const paragraph = document.createElement('p'); paragraph.className = className; paragraph.textContent = text; return paragraph;
}
function closePageEditor() {
  clearTimeout(state.previewTimer); state.previewRequest += 1; $('pageEditor').hidden = true; $('pageForm').reset(); $('pageId').value = ''; $('pagePreview').replaceChildren(previewPlaceholder('预览内容将在此显示')); $('previewStatus').textContent = '输入正文后自动预览';
}
function openPageEditor(page = null) {
  clearTimeout(state.previewTimer); state.previewRequest += 1; $('pageForm').reset();
  $('pageId').value = page?.id || ''; $('pageTitle').value = page?.title || ''; $('pageSlug').value = page?.slug || ''; $('pageType').value = page?.type || 'article'; $('pageCategory').value = page?.category || ''; $('pageExcerpt').value = page?.excerpt || ''; $('pageSortOrder').value = String(page?.sort_order ?? 0); $('pagePublished').checked = Boolean(page?.published); $('pageContent').value = page?.content || '';
  state.pageSlugManual = Boolean(page); $('pageEditorTitle').textContent = page ? '编辑内容页面' : '新建内容页面'; $('pageEditorDescription').textContent = page ? `正在编辑：${page.title}` : '填写页面信息并使用 Markdown 编写正文'; $('savePageBtn').textContent = page ? '保存修改' : '创建页面'; $('pageEditor').hidden = false;
  if (page?.content) schedulePagePreview(true); else { $('pagePreview').replaceChildren(previewPlaceholder('预览内容将在此显示')); $('previewStatus').textContent = '输入正文后自动预览'; }
  $('pageEditor').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('pageTitle').focus({ preventScroll: true });
}
async function renderPagePreview() {
  const content = $('pageContent').value; const requestId = ++state.previewRequest;
  if (!content.trim()) { $('pagePreview').replaceChildren(previewPlaceholder('输入 Markdown 后将在此显示预览')); $('previewStatus').textContent = '等待输入'; return; }
  $('previewStatus').textContent = '正在生成预览...';
  try {
    const data = await request('/api/admin/pages/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    if (requestId !== state.previewRequest) return;
    $('pagePreview').innerHTML = data.contentHtml;
    if (window.Prism) window.Prism.highlightAllUnder($('pagePreview'));
    $('previewStatus').textContent = '预览已更新';
  } catch (error) {
    if (requestId !== state.previewRequest) return;
    $('pagePreview').replaceChildren(previewPlaceholder(error.message, 'preview-error')); $('previewStatus').textContent = '预览失败';
  }
}
function schedulePagePreview(immediate = false) {
  clearTimeout(state.previewTimer); state.previewRequest += 1;
  state.previewTimer = setTimeout(renderPagePreview, immediate ? 0 : 400);
}
function pageCard(page) {
  const card = document.createElement('article'); card.className = 'page-card';
  const info = document.createElement('div'); info.className = 'page-card-info'; const titleRow = document.createElement('div'); titleRow.className = 'site-title-row'; const title = document.createElement('h3'); title.textContent = page.title; const badges = document.createElement('div'); badges.className = 'status-badges'; badges.append(badge(page.published ? '已发布' : '已下架', page.published ? 'published' : ''), badge(pageTypeLabels[page.type] || page.type, `page-type-${page.type}`)); titleRow.append(title, badges);
  const meta = document.createElement('dl'); meta.className = 'page-meta'; [['分类', page.category || '未分类'], ['Slug', page.slug], ['排序', String(page.sort_order ?? 0)]].forEach(([label, value]) => { const item = document.createElement('div'); const term = document.createElement('dt'); term.textContent = label; const detail = document.createElement('dd'); detail.textContent = value; item.append(term, detail); meta.append(item); }); info.append(titleRow, meta); if (page.excerpt) { const excerpt = document.createElement('p'); excerpt.textContent = page.excerpt; info.append(excerpt); }
  const actions = document.createElement('div'); actions.className = 'site-actions'; actions.append(action('编辑', 'btn-outline', () => openPageEditor(page)), action(page.published ? '下架' : '发布', page.published ? 'btn-outline' : 'btn-primary', () => setPagePublished(page)));
  const publicButton = action('公开查看', 'btn-outline', () => window.open(`/pages/${encodeURIComponent(page.slug)}`, '_blank', 'noopener')); publicButton.disabled = !page.published; publicButton.title = page.published ? '在新窗口打开公开页面' : '发布后可公开查看'; actions.append(publicButton, action('删除', 'btn-destructive', () => deletePage(page))); card.append(info, actions); return card;
}
async function loadPages(force = false) {
  if (state.user.role !== 'admin') return; if (force) state.loadedViews.delete('pages');
  const { pages } = await request('/api/admin/pages'); state.pages = pages; $('pagesList').replaceChildren(...(pages.length ? pages.map(pageCard) : [previewPlaceholder('暂无内容页面，点击“新建页面”开始创建。', 'list-message')])); state.loadedViews.add('pages');
}
async function savePage(event) {
  event.preventDefault(); const id = $('pageId').value; const submit = $('savePageBtn'); submit.disabled = true;
  try {
    await request(id ? `/api/admin/pages/${id}` : '/api/admin/pages', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pagePayload()) });
    message(id ? '内容页面已保存' : '内容页面已创建'); closePageEditor(); await loadPages(true);
  } catch (error) { message(error.message, 'error'); }
  finally { submit.disabled = false; }
}
async function setPagePublished(page) {
  try { await request(`/api/admin/pages/${page.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ published: !page.published }) }); message(page.published ? '内容页面已下架' : '内容页面已发布'); await loadPages(true); }
  catch (error) { message(error.message, 'error'); }
}
async function deletePage(page) {
  if (!confirm(`确定删除内容页面“${page.title}”吗？此操作无法撤销。`)) return;
  try { await request(`/api/admin/pages/${page.id}`, { method: 'DELETE' }); if ($('pageId').value === page.id) closePageEditor(); message('内容页面已删除'); await loadPages(true); }
  catch (error) { message(error.message, 'error'); }
}

async function loadSettings() {
  if (state.user.role !== 'admin') return;
  const { settings } = await request('/api/admin/settings');
  $('settingName').value = settings.branding.name; $('settingDescription').value = settings.branding.description; $('settingFooter').value = settings.branding.footer;
  $('settingHomeTitle').value = settings.home.title; $('settingHomeDescription').value = settings.home.description; $('settingLayout').value = settings.home.layout;
  $('settingTheme').value = settings.appearance.defaultTheme; $('settingAccent').value = settings.appearance.accentColor;
  $('settingThemeSwitch').checked = settings.appearance.allowThemeSwitch; $('settingPreview').checked = settings.home.showPreview;
}
async function saveSettings(event) {
  event.preventDefault();
  try {
    await request('/api/admin/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branding: { name: $('settingName').value, description: $('settingDescription').value, footer: $('settingFooter').value }, home: { title: $('settingHomeTitle').value, description: $('settingHomeDescription').value, layout: $('settingLayout').value, showPreview: $('settingPreview').checked }, appearance: { defaultTheme: $('settingTheme').value, allowThemeSwitch: $('settingThemeSwitch').checked, accentColor: $('settingAccent').value } }) });
    message('全站设置已保存');
  } catch (error) { message(error.message, 'error'); }
}
async function uploadAsset(kind, file) { if (!file) return; const form = new FormData(); form.append('file', file); try { await request(`/api/admin/settings/assets/${kind}`, { method: 'POST', body: form }); message('品牌图片已更新'); } catch (error) { message(error.message, 'error'); } }
async function removeAsset(kind) { try { await request(`/api/admin/settings/assets/${kind}`, { method: 'DELETE' }); message('品牌图片已移除'); } catch (error) { message(error.message, 'error'); } }

function openCreateUser() { $('createUserForm').reset(); errorBox('createUserError'); $('createUserDialog').showModal(); $('newUsername').focus(); }
async function createUser(event) {
  event.preventDefault(); errorBox('createUserError');
  if ($('newUserPassword').value !== $('newUserPasswordConfirm').value) return errorBox('createUserError', '两次输入的密码不一致');
  const submit = $('createUserSubmit'); submit.disabled = true;
  try {
    await request('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('newUsername').value, password: $('newUserPassword').value, role: $('newUserRole').value }) });
    closeDialog($('createUserDialog')); message('账号已创建'); await loadUsers(true);
  } catch (error) { errorBox('createUserError', error.message); }
  finally { submit.disabled = false; }
}
function openEditUser(user) { $('editUserId').value = user.id; $('editUsername').value = user.username; $('editUserRole').value = user.role; $('editUserActive').checked = user.active; $('editUserPassword').value = ''; errorBox('editUserError'); $('editUserDialog').showModal(); }
async function saveEditedUser(event) {
  event.preventDefault(); errorBox('editUserError'); const id = $('editUserId').value;
  try {
    await request(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('editUsername').value, role: $('editUserRole').value, active: $('editUserActive').checked }) });
    if ($('editUserPassword').value) await request(`/api/users/${id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('editUserPassword').value }) });
    closeDialog($('editUserDialog')); message('账号已更新'); await loadUsers(true);
  } catch (error) { errorBox('editUserError', error.message); }
}
async function revokeSessions(id) { try { await request(`/api/users/${id}/revoke-sessions`, { method: 'POST' }); message('账号会话已撤销'); } catch (error) { message(error.message, 'error'); } }
async function deleteUser(user) { if (!confirm(`确定删除账号“${user.username}”吗？`)) return; try { await request(`/api/users/${user.id}`, { method: 'DELETE' }); message('账号已删除'); loadUsers(true); } catch (error) { message(error.message, 'error'); } }

function userSiteRow(site) {
  const row = document.createElement('article'); row.className = 'account-site-row';
  const info = document.createElement('div'); const title = document.createElement('strong'); title.textContent = site.name; const meta = document.createElement('span'); meta.textContent = site.published ? '已发布' : '草稿'; info.append(title, meta);
  const actions = document.createElement('div'); actions.className = 'site-actions';
  actions.append(action('预览', 'btn-outline', () => window.open(site.url, '_blank', 'noopener')));
  actions.append(action('编辑', 'btn-outline', () => openEditSite(site)));
  actions.append(action(site.published ? '下架' : '发布', 'btn-outline', () => updateSite(site.id, { published: !site.published }, () => toggleUserSites(site.ownerId, true))));
  actions.append(action(site.sourceVisible ? '隐藏代码' : '公开代码', 'btn-outline', () => updateSite(site.id, { sourceVisible: !site.sourceVisible }, () => toggleUserSites(site.ownerId, true))));
  if (site.published) actions.append(action('展示页', 'btn-outline', () => window.open(site.detailUrl, '_blank', 'noopener')));
  actions.append(action('删除', 'btn-destructive', () => deleteSite(site, () => loadUsers(true)))); row.append(info, actions); return row;
}
async function toggleUserSites(userId, forceReload = false) {
  const container = document.querySelector(`[data-user-sites="${userId}"]`); const button = document.querySelector(`[data-toggle-sites="${userId}"]`);
  if (!container) return;
  if (!forceReload && !container.hidden) { container.hidden = true; button.textContent = '查看页面'; return; }
  container.hidden = false; container.textContent = '加载中...'; button.textContent = '收起页面';
  try { const { sites } = await request(`/api/users/${userId}/sites`); container.replaceChildren(...(sites.length ? sites.map(userSiteRow) : [Object.assign(document.createElement('p'), { textContent: '该账号尚未上传页面' })])); }
  catch (error) { container.textContent = error.message; }
}
function userCard(user) {
  const card = document.createElement('article'); card.className = 'user-card expanded-user-card'; const top = document.createElement('div'); top.className = 'user-card-top';
  const info = document.createElement('div'); const title = document.createElement('strong'); title.textContent = user.username; const meta = document.createElement('span'); meta.textContent = `${user.role === 'admin' ? '管理员' : '编辑者'} · ${user.active ? '已启用' : '已禁用'} · ${user.siteCount} 个页面`; info.append(title, meta);
  const actions = document.createElement('div'); actions.className = 'site-actions'; const toggle = action('查看页面', 'btn-outline', () => toggleUserSites(user.id)); toggle.dataset.toggleSites = user.id; actions.append(toggle); if (user.id === state.user.id) actions.append(action('账号设置', 'btn-outline', () => { location.hash = 'account'; })); else actions.append(action('编辑账号', 'btn-outline', () => openEditUser(user)), action('踢下线', 'btn-outline', () => revokeSessions(user.id)), action('删除账号', 'btn-destructive', () => deleteUser(user)));
  top.append(info, actions); const sites = document.createElement('div'); sites.className = 'account-sites'; sites.dataset.userSites = user.id; sites.hidden = true; card.append(top, sites); return card;
}
async function loadUsers(force = false) { if (state.user.role !== 'admin') return; if (force) state.loadedViews.delete('users'); const { users } = await request('/api/users'); $('usersList').replaceChildren(...users.map(userCard)); state.loadedViews.add('users'); }

function uploadMode() { return $('uploadModeCode').checked ? 'code' : 'zip'; }
function setUploadMode() {
  const code = uploadMode() === 'code';
  $('zipUploadPane').hidden = code; $('codeUploadPane').hidden = !code;
  $('siteName').required = code; $('codeHtml').required = code;
  $('uploadBtn').textContent = code ? '从代码创建草稿' : '上传 ZIP 为草稿';
  errorBox('uploadError');
}
function setupUpload() {
  $('uploadArea').addEventListener('click', () => $('fileInput').click()); $('uploadArea').addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('fileInput').click(); } });
  $('fileInput').addEventListener('change', () => selectFile($('fileInput').files[0])); $('uploadArea').addEventListener('dragover', (event) => { event.preventDefault(); $('uploadArea').dataset.dragover = 'true'; }); $('uploadArea').addEventListener('dragleave', () => $('uploadArea').dataset.dragover = 'false'); $('uploadArea').addEventListener('drop', (event) => { event.preventDefault(); $('uploadArea').dataset.dragover = 'false'; selectFile(event.dataTransfer.files[0]); });
  document.querySelectorAll('[name="uploadMode"]').forEach((input) => input.addEventListener('change', setUploadMode)); setUploadMode();
}
function selectFile(file) { if (!file?.name.toLowerCase().endsWith('.zip')) { state.selectedFile = null; $('fileInput').value = ''; $('fileName').hidden = true; return errorBox('uploadError', '请选择 ZIP 文件'); } state.selectedFile = file; $('fileName').textContent = file.name; $('fileName').hidden = false; errorBox('uploadError'); if (!$('siteName').value) $('siteName').value = file.name.replace(/\.zip$/i, ''); }
function resetUpload() { state.selectedFile = null; $('fileInput').value = ''; $('siteName').value = ''; $('siteDescription').value = ''; $('codeHtml').value = ''; $('codeCss').value = ''; $('codeJavascript').value = ''; $('fileName').hidden = true; errorBox('uploadError'); }
function codeBlob(content, type) { return new Blob([content], { type: `${type};charset=utf-8` }); }
async function uploadSite(event) {
  event.preventDefault(); errorBox('uploadError');
  const code = uploadMode() === 'code';
  if (!code && !state.selectedFile) return errorBox('uploadError', '请先选择 ZIP 文件');
  if (code && !$('codeHtml').value.trim()) return errorBox('uploadError', '请粘贴 HTML 代码');
  if (code && !$('siteName').value.trim()) return errorBox('uploadError', '站点名称不能为空');
  const form = new FormData();
  if (code) {
    form.append('html', codeBlob($('codeHtml').value, 'text/html'), 'index.html');
    if ($('codeCss').value) form.append('css', codeBlob($('codeCss').value, 'text/css'), 'style.css');
    if ($('codeJavascript').value) form.append('javascript', codeBlob($('codeJavascript').value, 'text/javascript'), 'script.js');
  } else form.append('file', state.selectedFile);
  form.append('name', $('siteName').value); form.append('description', $('siteDescription').value);
  const submit = $('uploadBtn'); submit.disabled = true; $('resetBtn').disabled = true; $('uploadForm').setAttribute('aria-busy', 'true');
  try {
    await request(code ? '/api/sites/code' : '/api/sites', { method: 'POST', body: form });
    resetUpload(); message(code ? '代码站点已创建为草稿' : '站点已上传为草稿');
    try { await loadSites(); } catch (error) { message(`站点已创建，但列表刷新失败：${error.message}`, 'error'); }
  } catch (error) { errorBox('uploadError', error.message); }
  finally { submit.disabled = false; $('resetBtn').disabled = false; $('uploadForm').removeAttribute('aria-busy'); }
}

function openEditSite(site) { $('editSiteId').value = site.id; $('editSiteName').value = site.name; $('editSiteDescription').value = site.description || ''; $('editSiteDialog').showModal(); }
async function saveEditedSite(event) { event.preventDefault(); const id = $('editSiteId').value; try { await updateSite(id, { name: $('editSiteName').value, description: $('editSiteDescription').value }); closeDialog($('editSiteDialog')); } catch {} }
function siteCard(site) {
  const card = document.createElement('article'); card.className = 'site-card'; const head = document.createElement('div'); head.className = 'site-card-head'; const info = document.createElement('div'); const row = document.createElement('div'); row.className = 'site-title-row'; const title = document.createElement('h3'); title.textContent = site.name; const badges = document.createElement('div'); badges.className = 'status-badges'; badges.append(badge(site.published ? '已发布' : '草稿', site.published ? 'published' : ''), badge(site.sourceVisible ? '代码公开' : '代码隐藏', site.sourceVisible ? 'source-on' : '')); row.append(title, badges); info.append(row); if (site.ownerUsername) { const owner = document.createElement('p'); owner.textContent = `所有者：${site.ownerUsername}`; info.append(owner); } if (site.description) { const p = document.createElement('p'); p.textContent = site.description; info.append(p); }
  const actions = document.createElement('div'); actions.className = 'site-actions'; actions.append(action('预览', 'btn-outline', () => window.open(site.url, '_blank', 'noopener')), action('编辑', 'btn-outline', () => openEditSite(site)), action(site.published ? '下架' : '发布', site.published ? 'btn-outline' : 'btn-primary', () => updateSite(site.id, { published: !site.published })), action(site.sourceVisible ? '隐藏代码' : '公开代码', 'btn-outline', () => updateSite(site.id, { sourceVisible: !site.sourceVisible }))); if (site.published) actions.append(action('展示页', 'btn-outline', () => window.open(site.detailUrl, '_blank', 'noopener'))); actions.append(action('删除', 'btn-destructive', () => deleteSite(site))); head.append(info, actions); card.append(head); return card;
}
async function loadSites() { const { sites } = await request('/api/sites'); state.sites = sites; $('sitesList').replaceChildren(...(sites.length ? sites.map(siteCard) : [])); state.loadedViews.add('sites'); }
async function updateSite(id, updates, after) { try { await request(`/api/sites/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) }); message('页面已更新'); if (after) await after(); else await loadSites(); } catch (error) { message(error.message, 'error'); throw error; } }
async function deleteSite(site, after) { if (!confirm(`确定删除“${site.name}”吗？`)) return; try { await request(`/api/sites/${site.id}`, { method: 'DELETE' }); message('页面已删除'); if (after) await after(); else await loadSites(); } catch (error) { message(error.message, 'error'); } }

function bindEvents() {
  window.addEventListener('hashchange', showView); $('logoutBtn').addEventListener('click', logout); $('createUserBtn').addEventListener('click', openCreateUser);
  $('createUserForm').addEventListener('submit', createUser); $('accountUsernameForm').addEventListener('submit', saveOwnUsername); $('accountPasswordForm').addEventListener('submit', saveOwnPassword); $('editUserForm').addEventListener('submit', saveEditedUser); $('editSiteForm').addEventListener('submit', saveEditedSite); $('settingsForm').addEventListener('submit', saveSettings); $('pageForm').addEventListener('submit', savePage);
  $('uploadForm').addEventListener('submit', uploadSite); $('resetBtn').addEventListener('click', resetUpload); $('refreshBtn').addEventListener('click', () => loadSites().catch((error) => message(error.message, 'error'))); $('refreshPagesBtn').addEventListener('click', () => loadPages(true)); $('createPageBtn').addEventListener('click', () => openPageEditor()); $('closePageEditorBtn').addEventListener('click', closePageEditor); $('cancelPageEditBtn').addEventListener('click', closePageEditor); $('logoInput').addEventListener('change', () => uploadAsset('logo', $('logoInput').files[0])); $('faviconInput').addEventListener('change', () => uploadAsset('favicon', $('faviconInput').files[0]));
  $('pageTitle').addEventListener('input', () => { if (!state.pageSlugManual) $('pageSlug').value = pageSlug($('pageTitle').value); }); $('pageSlug').addEventListener('input', () => { state.pageSlugManual = true; $('pageSlug').value = $('pageSlug').value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+/g, '').slice(0, 81); }); $('pageSlug').addEventListener('blur', () => { $('pageSlug').value = $('pageSlug').value.replace(/-+$/g, ''); }); $('pageContent').addEventListener('input', () => schedulePagePreview());
  document.querySelectorAll('[data-close-dialog]').forEach((el) => el.addEventListener('click', () => closeDialog(el.closest('dialog')))); document.querySelectorAll('[data-remove-asset]').forEach((el) => el.addEventListener('click', () => removeAsset(el.dataset.removeAsset)));
  setupUpload();
}
async function init() { bindEvents(); try { await loadMe(); await showView(); } catch (error) { message(error.message, 'error'); } }
document.addEventListener('DOMContentLoaded', init);
