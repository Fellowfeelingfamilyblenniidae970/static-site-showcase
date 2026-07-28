const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('node:path');
const fs = require('node:fs').promises;
const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { Worker } = require('node:worker_threads');
const { verifyPassword } = require('./lib/password');
const { createAuth } = require('./lib/auth');
const { extractZip, hasRootIndex, flattenSingleRoot } = require('./lib/extract');
const { listSourceFiles, readSourceFile } = require('./lib/source');
const { renderMarkdown } = require('./lib/markdown');
const {
  patchSettings, projectPublicSettings, MIN_UPLOAD_MAX_FILE_SIZE, MAX_UPLOAD_MAX_FILE_SIZE
} = require('./lib/settings');
const { saveBrandAsset, deleteBrandAsset, MAX_IMAGE_SIZE } = require('./lib/image');
const { buildCodeSite } = require('./lib/code-site');
const { strictCodeUpload } = require('./lib/code-upload');
const { createStrictZipUpload } = require('./lib/zip-upload');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loginAttempts = new Map();
const LOGIN_ATTEMPT_TTL = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10000;

function createApp({ db, rootDir = __dirname } = {}) {
  if (!db) throw new TypeError('database is required');
  const app = express();
  const sitesDir = path.join(rootDir, 'sites');
  const uploadsDir = path.join(rootDir, 'uploads');
  const brandingDir = path.join(rootDir, 'database', 'assets', 'branding');
  const publicDir = path.join(rootDir, 'public');
  const showcaseDir = path.join(rootDir, 'showcase');
  const auth = createAuth(db);
  const sharedHandlers = new Map();
  let activeZipBuilds = 0;

  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const zipUpload = createStrictZipUpload({
    uploadsDir,
    getMaxFileSize: () => db.getSettings().uploads.maxFileSize
  });
  const imageUpload = fileUpload({ limits: { fileSize: MAX_IMAGE_SIZE }, abortOnLimit: true, useTempFiles: false });

  function requestHost(req) {
    const raw = req.get('host');
    if (!raw || raw.length > 300 || /[\s,\\/?#@]/.test(raw)) return null;
    try {
      const parsed = new URL(`http://${raw}`);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
      if (!hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
      if (isIP(hostname)) return hostname;
      const validHostname = hostname.length <= 253 && hostname.split('.').every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
      return validHostname ? hostname : null;
    } catch { return null; }
  }

  function pruneLoginAttempts(timestamp) {
    for (const [key, record] of loginAttempts) {
      if (record.expiresAt <= timestamp) loginAttempts.delete(key);
    }
    while (loginAttempts.size >= MAX_LOGIN_ATTEMPTS) loginAttempts.delete(loginAttempts.keys().next().value);
  }

  function buildZipFile(directory, outputPath) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'lib', 'zip-worker.js'), { workerData: { directory, outputPath } });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => {
        worker.terminate().catch(() => {});
        finish(Object.assign(new Error('压缩包生成超时'), { code: 'ZIP_BUILD_TIMEOUT' }));
      }, 120000);
      worker.once('message', (message) => {
        if (message.ok) finish(null, message);
        else finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => {
        if (code !== 0) finish(Object.assign(new Error('压缩包生成进程异常退出'), { code: 'ZIP_WORKER_EXIT' }));
      });
    });
  }

  function siteStatic(site) {
    if (!sharedHandlers.has(site.id)) {
      sharedHandlers.set(site.id, express.static(path.join(sitesDir, site.id), {
        index: 'index.html', etag: true, maxAge: 0, fallthrough: true,
        setHeaders(res) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads");
        }
      }));
    }
    return sharedHandlers.get(site.id);
  }

  app.use((req, res, next) => {
    const host = requestHost(req);
    if (!host) return res.status(400).send('Invalid Host');
    next();
  });

  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: true, limit: '512kb' }));
  app.use('/showcase', express.static(showcaseDir));
  app.use('/assets/branding', express.static(brandingDir, { immutable: true, maxAge: '1y', fallthrough: false }));
  app.get('/login', (req, res) => {
    res.setHeader('Set-Cookie', auth.issueLoginCsrf().cookie);
    if (auth.currentSession(req)) return res.redirect('/admin/');
    res.sendFile(path.join(publicDir, 'login.html'));
  });
  app.get('/api/auth/login-challenge', (req, res) => {
    res.setHeader('Set-Cookie', auth.issueLoginCsrf().cookie);
    res.set('Cache-Control', 'no-store').json({ success: true });
  });
  app.get('/login.js', (req, res) => res.sendFile(path.join(publicDir, 'login.js')));
  app.get('/login.css', (req, res) => res.sendFile(path.join(publicDir, 'login.css')));
  app.get(/^\/admin$/, (req, res) => res.redirect('/admin/'));
  app.get('/admin/', auth.optional, (req, res) => req.auth ? res.sendFile(path.join(publicDir, 'index.html')) : res.redirect('/login'));
  app.use('/admin', auth.required, express.static(publicDir, { index: false }));

  function publicUser(user) {
    return { id: user.id, username: user.username, role: user.role, active: user.active, defaultPassword: user.default_password,
      siteCount: Number(user.site_count || 0), createdAt: user.created_at, lastLoginAt: user.last_login_at };
  }
  function adminSite(site) {
    return { id: site.id, name: site.name, description: site.description, url: `/sites/${site.id}/`, detailUrl: `/works/${site.id}`,
      published: site.published, sourceVisible: site.source_visible, ownerId: site.owner_user_id,
      ownerUsername: site.owner_username, createdAt: site.created_at, updatedAt: site.updated_at };
  }
  function publicSite(site) {
    return { id: site.id, name: site.name, description: site.description, previewUrl: `/sites/${site.id}/`, detailUrl: `/works/${site.id}`,
      sourceVisible: site.source_visible, ownerUsername: site.owner_username, createdAt: site.created_at, updatedAt: site.updated_at };
  }
  function ownerFilter(req) { return req.auth.user.role === 'admin' ? undefined : req.auth.user.id; }
  async function managedSite(req) {
    if (!UUID_RE.test(req.params.id)) return null;
    return db.getSiteById(req.params.id, ownerFilter(req));
  }

  app.post('/api/auth/login', auth.loginCsrf, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const timestamp = Date.now();
    pruneLoginAttempts(timestamp);
    const key = `${req.ip}:${username.toLowerCase()}`;
    const record = loginAttempts.get(key) || { count: 0, until: 0, expiresAt: timestamp + LOGIN_ATTEMPT_TTL };
    const user = db.getUserByUsername(username);
    const valid = user?.active && await verifyPassword(String(req.body.password || ''), user.password_hash);
    if (valid) {
      loginAttempts.delete(key); db.setLastLogin(user.id); db.deleteSessionsForUser(user.id);
      const issued = auth.issue(user);
      res.setHeader('Set-Cookie', [auth.clearLoginCsrfCookie(), issued.cookie, issued.csrfCookie]);
      return res.json({ success: true, user: publicUser(user) });
    }
    if (record.until > timestamp) return res.status(429).json({ error: '登录尝试过多，请稍后重试' });
    record.count += 1;
    record.until = record.count >= 5 ? timestamp + Math.min(record.count * 30000, 300000) : 0;
    loginAttempts.set(key, record);
    return res.status(401).json({ error: '用户名或密码错误' });
  });
  app.get('/api/auth/me', auth.required, (req, res) => res.set('Cache-Control', 'no-store').json({ success: true, user: req.auth.user }));
  app.post('/api/auth/logout', auth.csrf, (req, res) => {
    db.deleteSessionByHash(req.auth.sessionHash); res.setHeader('Set-Cookie', auth.clearCookie()); res.json({ success: true });
  });
  app.post('/api/auth/change-password', auth.csrf, async (req, res) => {
    const user = db.getUserById(req.auth.user.id);
    if (!await verifyPassword(String(req.body.currentPassword || ''), user.password_hash)) return res.status(400).json({ error: '当前密码不正确' });
    const password = String(req.body.newPassword || '');
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '新密码长度必须为 6-128 位' });
    await db.updateUser(user.id, { password });
    res.setHeader('Set-Cookie', auth.clearCookie()); res.json({ success: true, relogin: true });
  });

  app.patch('/api/auth/profile', auth.csrf, async (req, res) => {
    const user = db.getUserById(req.auth.user.id);
    if (!await verifyPassword(String(req.body.currentPassword || ''), user.password_hash)) {
      return res.status(400).json({ error: '当前密码不正确' });
    }
    const username = String(req.body.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: '用户名必须为 3-32 位字母、数字、点、下划线或连字符' });
    }
    try {
      await db.updateUser(user.id, { username });
      db.deleteSessionsForUser(user.id);
      res.setHeader('Set-Cookie', auth.clearCookie());
      res.json({ success: true, relogin: true });
    } catch (error) {
      const conflict = String(error.code || '').startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(error.message);
      res.status(conflict ? 409 : 400).json({ error: conflict ? '用户名已被使用' : error.message });
    }
  });

  app.get('/api/users', auth.admin, (req, res) => res.json({ success: true, users: db.getUsersWithSiteCounts().map(publicUser) }));
  app.get('/api/users/:id/sites', auth.admin, async (req, res) => {
    if (!db.getUserById(req.params.id)) return res.status(404).json({ error: '账号不存在' });
    res.json({ success: true, sites: (await db.getAllSites(req.params.id)).map(adminSite) });
  });
  app.post('/api/users', auth.admin, auth.csrf, async (req, res) => {
    try {
      const password = String(req.body.password || '');
      if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '密码长度必须为 6-128 位' });
      const user = await db.createUser({ username: req.body.username, password, role: req.body.role || 'editor' });
      res.status(201).json({ success: true, user: publicUser(user) });
    } catch (error) { res.status(error.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 400).json({ error: error.message }); }
  });
  app.patch('/api/users/:id', auth.admin, auth.csrf, async (req, res) => {
    const target = db.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.id === req.auth.user.id) return res.status(400).json({ error: '请通过个人资料修改当前账号' });
    if (target.role === 'admin' && target.active && db.countActiveAdmins() === 1 && (req.body.active === false || req.body.role === 'editor')) {
      return res.status(400).json({ error: '不能禁用或降级最后一个有效管理员' });
    }
    const updates = {};
    for (const key of ['username', 'role', 'active']) if (Object.hasOwn(req.body, key)) updates[key] = req.body[key];
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
    try { res.json({ success: true, user: publicUser(await db.updateUser(target.id, updates)) }); }
    catch (error) {
      const conflict = String(error.code || '').startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(error.message);
      res.status(conflict ? 409 : 400).json({ error: conflict ? '用户名已被使用' : error.message });
    }
  });
  app.post('/api/users/:id/reset-password', auth.admin, auth.csrf, async (req, res) => {
    const target = db.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.id === req.auth.user.id) return res.status(400).json({ error: '请使用修改密码功能修改当前账号密码' });
    const password = String(req.body.password || '');
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '密码长度必须为 6-128 位' });
    await db.updateUser(req.params.id, { password }); res.json({ success: true });
  });
  app.post('/api/users/:id/revoke-sessions', auth.admin, auth.csrf, (req, res) => {
    const target = db.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.id === req.auth.user.id) return res.status(400).json({ error: '不能通过管理接口撤销当前会话' });
    db.deleteSessionsForUser(req.params.id); res.json({ success: true });
  });
  app.delete('/api/users/:id', auth.admin, auth.csrf, (req, res) => {
    const target = db.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.id === req.auth.user.id || (target.role === 'admin' && target.active && db.countActiveAdmins() === 1)) return res.status(400).json({ error: '不能删除当前或最后一个管理员账号' });
    if (db.countSitesByOwner(target.id)) return res.status(409).json({ error: '该账号仍拥有站点，请先处理这些站点' });
    db.deleteUser(target.id); res.json({ success: true });
  });

  app.get('/api/settings', (req, res) => res.set('Cache-Control', 'public, max-age=15').json({ success: true, settings: projectPublicSettings(db.getSettings()) }));
  app.get('/api/upload-config', auth.required, (req, res) => {
    const maxFileSize = db.getSettings().uploads.maxFileSize;
    res.set('Cache-Control', 'no-store').json({
      success: true,
      uploads: { maxFileSize, minFileSize: MIN_UPLOAD_MAX_FILE_SIZE, maxAllowedFileSize: MAX_UPLOAD_MAX_FILE_SIZE }
    });
  });
  app.get('/api/admin/settings', auth.admin, (req, res) => res.set('Cache-Control', 'no-store').json({ success: true, settings: db.getSettings() }));
  app.patch('/api/admin/settings', auth.admin, auth.csrf, (req, res) => {
    try { res.json({ success: true, settings: db.updateSettings(patchSettings(db.getSettings(), req.body)) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  async function removeUnusedBrandAsset(settings, url) {
    if (!url?.startsWith('/assets/branding/') || Object.values(settings.branding).includes(url)) return;
    await deleteBrandAsset(brandingDir, path.basename(url)).catch(() => {});
  }

  async function saveBrand(kind, req, res) {
    if (!req.files?.file || Array.isArray(req.files.file)) return res.status(400).json({ error: '请选择一个图片文件' });
    try {
      const asset = await saveBrandAsset(brandingDir, req.files.file.data);
      const oldSettings = db.getSettings();
      const oldUrl = oldSettings.branding[kind];
      const url = `/assets/branding/${asset.filename}`;
      const settings = db.updateSettings(patchSettings(oldSettings, { branding: { [kind]: url } }));
      if (oldUrl !== url) await removeUnusedBrandAsset(settings, oldUrl);
      res.json({ success: true, url, settings });
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  }
  for (const kind of ['logo', 'favicon']) {
    app.post(`/api/admin/settings/assets/${kind}`, auth.admin, auth.csrf, imageUpload, (req, res) => saveBrand(kind, req, res));
    app.delete(`/api/admin/settings/assets/${kind}`, auth.admin, auth.csrf, async (req, res) => {
      const settings = db.getSettings(), oldUrl = settings.branding[kind];
      const updated = db.updateSettings(patchSettings(settings, { branding: { [kind]: null } }));
      await removeUnusedBrandAsset(updated, oldUrl);
      res.json({ success: true, settings: updated });
    });
  }

  async function discardUpload(uploaded) {
    const files = [];
    function collect(value) {
      if (!value) return;
      if (Array.isArray(value)) return value.forEach(collect);
      if (value.tempFilePath) files.push(value);
      else if (typeof value === 'object') Object.values(value).forEach(collect);
    }
    collect(uploaded);
    await Promise.all(files.map((item) => fs.rm(item.tempFilePath, { force: true }).catch(() => {})));
  }

  app.post('/api/sites', auth.csrf, zipUpload, async (req, res) => {
    if (!req.files?.file || Array.isArray(req.files.file) || Object.keys(req.files).some((key) => key !== 'file')) {
      await discardUpload(req.files);
      return res.status(400).json({ error: '请选择一个 ZIP 文件' });
    }
    const body = req.body || {};
    if (Object.keys(body).some((key) => !['name', 'description'].includes(key)) ||
      ['name', 'description'].some((key) => Array.isArray(body[key]))) {
      await discardUpload(req.files);
      return res.status(400).json({ error: '站点信息格式无效' });
    }
    const uploaded = req.files.file;
    if (uploaded.size > req.zipUploadMaxFileSize) {
      await discardUpload(req.files);
      return res.status(413).send(`ZIP 文件不能超过 ${Math.round(req.zipUploadMaxFileSize / 1024 / 1024)} MiB`);
    }
    if (path.extname(uploaded.name).toLowerCase() !== '.zip') {
      await discardUpload(uploaded);
      return res.status(400).json({ error: '只支持 ZIP 格式文件' });
    }
    const name = String(req.body.name || uploaded.name.replace(/\.zip$/i, '')).trim().slice(0, 120);
    if (!name) {
      await discardUpload(uploaded);
      return res.status(400).json({ error: '站点名称不能为空' });
    }
    const id = randomUUID(), sitePath = path.join(sitesDir, id), archivePath = path.join(uploadsDir, `${id}.zip`);
    try {
      await fs.mkdir(sitePath, { recursive: true }); await fs.mkdir(uploadsDir, { recursive: true }); await uploaded.mv(archivePath);
      const result = await extractZip(archivePath, sitePath); await fs.rm(archivePath, { force: true }); await flattenSingleRoot(sitePath);
      if (!await hasRootIndex(sitePath)) throw Object.assign(new Error('压缩包根目录未找到 index.html'), { status: 400 });
      const site = await db.createSite({ id, name, description: String(req.body.description || '').trim().slice(0,500), path: sitePath }, req.auth.user.id);
      res.status(201).json({ success: true, site: adminSite(site), ...result });
    } catch (error) {
      await Promise.all([fs.rm(sitePath,{recursive:true,force:true}).catch(()=>{}),fs.rm(archivePath,{force:true}).catch(()=>{})]);
      res.status(error.status || (error.code?.startsWith('ZIP_') ? 400 : 500)).json({ error: error.status || error.code?.startsWith('ZIP_') ? error.message : '文件上传失败' });
    }
  });
  app.post('/api/sites/code', auth.csrf, strictCodeUpload, async (req, res) => {
    const nameValue = req.body?.name;
    const descriptionValue = req.body?.description;
    if (typeof nameValue !== 'string' || typeof descriptionValue !== 'undefined' && typeof descriptionValue !== 'string') {
      return res.status(400).json({ error: '站点信息格式无效' });
    }
    const name = nameValue.trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: '站点名称不能为空' });
    const id = randomUUID(), sitePath = path.join(sitesDir, id);
    try {
      const files = buildCodeSite(req.files, name, `/sites/${id}/`);
      await fs.mkdir(sitePath);
      for (const [filename, content] of Object.entries(files)) {
        await fs.writeFile(path.join(sitePath, filename), content, { encoding: 'utf8', flag: 'wx' });
      }
    } catch (error) {
      await fs.rm(sitePath, { recursive: true, force: true }).catch(() => {});
      return res.status(error.status || 500).json({ error: error.status ? error.message : '代码上传失败' });
    }
    try {
      const site = await db.createSite({
        id,
        name,
        description: String(descriptionValue || '').trim().slice(0, 500),
        path: sitePath
      }, req.auth.user.id);
      return res.status(201).json({ success: true, site: adminSite(site) });
    } catch {
      await Promise.all([
        db.deleteSite(id).catch(() => {}),
        fs.rm(sitePath, { recursive: true, force: true }).catch(() => {})
      ]);
      return res.status(500).json({ error: '代码上传失败' });
    }
  });
  app.get('/api/sites', auth.required, async (req, res) => res.json({ success: true, sites: (await db.getAllSites(ownerFilter(req))).map(adminSite) }));
  app.get('/api/sites/:id', auth.required, async (req, res) => {
    const site = await managedSite(req); site ? res.json({ success:true,site:adminSite(site) }) : res.status(404).json({error:'网站不存在'});
  });
  app.patch('/api/sites/:id', auth.csrf, async (req, res) => {
    const current = await managedSite(req); if (!current) return res.status(404).json({error:'网站不存在'});
    const updates = {};
    if (Object.hasOwn(req.body,'published')) updates.published = req.body.published === true;
    if (Object.hasOwn(req.body,'sourceVisible')) updates.source_visible = req.body.sourceVisible === true;
    if (Object.hasOwn(req.body,'name')) {
      updates.name = String(req.body.name).trim().slice(0,120);
      if (!updates.name) return res.status(400).json({error:'站点名称不能为空'});
    }
    if (Object.hasOwn(req.body,'description')) updates.description = String(req.body.description).trim().slice(0,500);
    const site = await db.updateSite(current.id, updates, ownerFilter(req)); res.json({success:true,site:adminSite(site)});
  });
  app.delete('/api/sites/:id', auth.csrf, async (req, res) => {
    const site = await managedSite(req); if (!site) return res.status(404).json({error:'网站不存在'});
    await fs.rm(path.join(sitesDir,site.id),{recursive:true,force:true}); await db.deleteSite(site.id,ownerFilter(req)); sharedHandlers.delete(site.id); res.json({success:true});
  });

  function publicPageSummary(page){return {id:page.id,slug:page.slug,title:page.title,category:page.category,excerpt:page.excerpt,type:page.type,url:`/pages/${page.slug}`,createdAt:page.created_at,updatedAt:page.updated_at};}
  function publicPageDetail(page){const rendered=renderMarkdown(page.content);const adjacent=db.getAdjacentPages(page);return {...publicPageSummary(page),contentHtml:rendered.contentHtml,toc:rendered.toc,prev:adjacent.prev?publicPageSummary(adjacent.prev):null,next:adjacent.next?publicPageSummary(adjacent.next):null};}
  function requestedCategory(req){return typeof req.query.category==='string'?req.query.category:undefined;}
  function pageError(res,error){const conflict=/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(error.message)||String(error.code||'').startsWith('SQLITE_CONSTRAINT');return res.status(conflict?409:400).json({error:conflict?'slug 已被使用':error.message});}

  app.get('/api/gallery', async(req,res)=>res.json({success:true,sites:(await db.getPublishedSites()).map(publicSite)}));
  app.get('/api/pages',(req,res)=>res.json({success:true,pages:db.getPublishedPages(requestedCategory(req)).map(publicPageSummary)}));
  app.get('/api/pages/:slug',(req,res)=>{const page=db.getPageBySlug(req.params.slug,true);if(!page)return res.status(404).json({error:'页面不存在或尚未发布'});res.json({success:true,page:publicPageDetail(page)});});
  app.get('/api/articles',(req,res)=>res.json({success:true,articles:db.getPublishedPages(requestedCategory(req)).map(publicPageSummary)}));
  app.get('/api/articles/:slug',(req,res)=>{const page=db.getPageBySlug(req.params.slug,true);if(!page)return res.status(404).json({error:'文章不存在或尚未发布'});res.json({success:true,article:publicPageDetail(page)});});

  app.get('/api/admin/pages',auth.admin,(req,res)=>res.set('Cache-Control','no-store').json({success:true,pages:db.getAllPages()}));
  app.post('/api/admin/pages/preview',auth.admin,auth.csrf,(req,res)=>{try{const validated=db.validatePage({content:req.body.content},true);res.set('Cache-Control','no-store').json({success:true,...renderMarkdown(validated.content)});}catch(error){res.status(400).json({error:error.message});}});
  app.post('/api/admin/pages',auth.admin,auth.csrf,async(req,res)=>{try{const page=await db.createPage(req.body);res.status(201).json({success:true,page});}catch(error){pageError(res,error);}});
  app.patch('/api/admin/pages/:id',auth.admin,auth.csrf,(req,res)=>{try{const page=db.updatePage(req.params.id,req.body);if(!page)return res.status(404).json({error:'页面不存在'});res.json({success:true,page});}catch(error){pageError(res,error);}});
  app.delete('/api/admin/pages/:id',auth.admin,auth.csrf,(req,res)=>{const result=db.deletePage(req.params.id);if(!result.changes)return res.status(404).json({error:'页面不存在'});res.json({success:true});});
  app.get('/api/gallery/:id', async(req,res)=>{const site=UUID_RE.test(req.params.id)?await db.getSiteById(req.params.id):null;if(!site?.published)return res.status(404).json({error:'作品不存在或尚未发布'});res.json({success:true,site:publicSite(site)});});
  app.get('/api/gallery/:id/files', async(req,res)=>{const site=UUID_RE.test(req.params.id)?await db.getSiteById(req.params.id):null;if(!site?.published)return res.status(404).json({error:'作品不存在'});if(!site.source_visible)return res.status(403).json({error:'该作品未公开源代码'});res.json({success:true,files:await listSourceFiles(path.join(sitesDir,site.id))});});
  app.get('/api/gallery/:id/download', async(req,res)=>{
    const site=UUID_RE.test(req.params.id)?await db.getSiteById(req.params.id):null;
    if(!site?.published)return res.status(404).json({error:'作品不存在'});
    if(!site.source_visible)return res.status(403).json({error:'该作品未公开源代码'});
    if(activeZipBuilds>=2)return res.status(429).json({error:'当前下载任务较多，请稍后重试'});
    const outputPath=path.join(uploadsDir,`${site.id}-${randomUUID()}.download.zip`);
    activeZipBuilds+=1;
    try{
      await fs.mkdir(uploadsDir,{recursive:true});
      const result=await buildZipFile(path.join(sitesDir,site.id),outputPath);
      const filename=encodeURIComponent(`${site.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')}.zip`);
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Type','application/zip');
      res.setHeader('Content-Disposition',`attachment; filename="project.zip"; filename*=UTF-8''${filename}`);
      res.setHeader('Content-Length',String(result.size));
      res.sendFile(outputPath,{},()=>fs.rm(outputPath,{force:true}).catch(()=>{}));
    }catch(error){
      await fs.rm(outputPath,{force:true}).catch(()=>{});
      if(!res.headersSent)res.status(error.code?.startsWith('ZIP_')?413:500).json({error:error.message});
    }finally{activeZipBuilds-=1;}
  });
  app.get('/api/gallery/:id/source', async(req,res)=>{const site=UUID_RE.test(req.params.id)?await db.getSiteById(req.params.id):null;if(!site?.published)return res.status(404).json({error:'作品不存在'});if(!site.source_visible)return res.status(403).json({error:'该作品未公开源代码'});try{res.json({success:true,source:await readSourceFile(path.join(sitesDir,site.id),req.query.path)});}catch(error){res.status(error.status||500).json({error:error.message});}});

  app.use('/sites/:id', auth.optional, async(req,res)=>{
    const site=UUID_RE.test(req.params.id)?await db.getSiteById(req.params.id):null;
    if(!site||(!site.published&&req.auth?.user.role!=='admin'&&req.auth?.user.id!==site.owner_user_id))return res.status(404).send('网站不存在');
    if(req.originalUrl===`/sites/${site.id}`)return res.redirect(301,`/sites/${site.id}/`);
    siteStatic(site)(req,res,()=>res.status(404).send('页面不存在'));
  });
  app.get('/works/:id',(req,res)=>UUID_RE.test(req.params.id)?res.sendFile(path.join(showcaseDir,'detail.html')):res.status(404).send('作品不存在'));
  app.get(['/pages','/articles'],(req,res)=>res.sendFile(path.join(showcaseDir,'articles.html')));
  app.get(['/pages/:slug','/articles/:slug'],(req,res)=>db.getPageBySlug(req.params.slug,true)?res.sendFile(path.join(showcaseDir,'article.html')):res.status(404).send('页面不存在或尚未发布'));
  app.get('/',(req,res)=>res.sendFile(path.join(showcaseDir,'index.html')));
  app.get('/health',(req,res)=>res.json({status:'ok',timestamp:new Date().toISOString()}));

  app.locals.paths={sitesDir,uploadsDir,brandingDir}; app.locals.auth=auth;
  return app;
}

module.exports = { createApp };
