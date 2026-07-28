const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, getDefaultAdminCredentials } = require('./lib/password');
const { normalizeSettings, uploadMaxFileSizeFromEnv } = require('./lib/settings');

const LEGACY_MIGRATION = 'legacy_json_v1';

function now() { return new Date().toISOString(); }
function toBool(value) { return value === true || value === 1; }
function userRow(row) {
  if (!row) return null;
  return { ...row, active: toBool(row.active), default_password: toBool(row.default_password) };
}
function siteRow(row) {
  if (!row) return null;
  return { ...row, published: toBool(row.published), source_visible: toBool(row.source_visible) };
}
function pageRow(row) {
  if (!row) return null;
  return { ...row, published: toBool(row.published) };
}

class DatabaseManager {
  constructor(options = {}) {
    if (typeof options === 'string') options = { dbPath: options };
    this.env = options.env || process.env;
    const configured = options.dbPath || this.env.DB_PATH || path.join(__dirname, 'database', 'platform.db');
    if (configured.endsWith('.json')) {
      this.legacyJsonPath = path.resolve(configured);
      this.dbPath = path.join(path.dirname(this.legacyJsonPath), 'platform.db');
    } else {
      this.dbPath = configured === ':memory:' ? configured : path.resolve(configured);
      this.legacyJsonPath = options.legacyJsonPath || path.join(path.dirname(this.dbPath), 'sites.json');
    }
    this.db = null;
  }

  async init() {
    if (this.db) return this;
    if (this.dbPath !== ':memory:') fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (this.dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
    this.createSchema();
    this.migrateRemovedDomainColumns();
    const admin = await this.ensureDefaultAdmin();
    this.migrateLegacySites(admin.id);
    this.ensureSettings();
    return this;
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','editor')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        default_password INTEGER NOT NULL DEFAULT 0 CHECK(default_password IN (0,1)),
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        session_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
        source_visible INTEGER NOT NULL DEFAULT 1 CHECK(source_visible IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sites_owner_idx ON sites(owner_user_id);
      CREATE INDEX IF NOT EXISTS sites_public_idx ON sites(published, created_at DESC);
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        excerpt TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'article' CHECK(type IN ('article','doc','code')),
        published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pages_public_idx ON pages(published,category,sort_order,created_at);
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  }

  migrateRemovedDomainColumns() {
    const columns = this.db.prepare("PRAGMA table_info('sites')").all().map((column) => column.name);
    if (!columns.includes('custom_domain')) return;

    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      this.db.exec(`
        CREATE TABLE sites_without_domains (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          path TEXT NOT NULL,
          published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
          source_visible INTEGER NOT NULL DEFAULT 1 CHECK(source_visible IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sites_without_domains
          (id,owner_user_id,name,description,path,published,source_visible,created_at,updated_at)
          SELECT id,owner_user_id,name,description,path,published,source_visible,created_at,updated_at FROM sites;
        DROP TABLE sites;
        ALTER TABLE sites_without_domains RENAME TO sites;
        CREATE INDEX sites_owner_idx ON sites(owner_user_id);
        CREATE INDEX sites_public_idx ON sites(published,created_at DESC);
        INSERT OR REPLACE INTO schema_migrations(name,applied_at) VALUES('remove_custom_domains_v1',datetime('now'));
        COMMIT;
      `);
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON;');
    }
  }

  async ensureDefaultAdmin() {
    const existing = this.db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get();
    if (existing) return userRow(existing);
    const credentials = getDefaultAdminCredentials(this.env);
    return this.createUser({
      username: credentials.username,
      password: credentials.password,
      role: 'admin'
    });
  }

  migrateLegacySites(adminId) {
    const migrated = this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(LEGACY_MIGRATION);
    if (migrated || !fs.existsSync(this.legacyJsonPath)) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.legacyJsonPath, 'utf8')); }
    catch { parsed = { sites: [] }; }
    const insert = this.db.prepare(`INSERT OR IGNORE INTO sites
      (id,owner_user_id,name,description,path,published,source_visible,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const site of Array.isArray(parsed.sites) ? parsed.sites : []) {
        const created = site.created_at || now();
        insert.run(String(site.id), adminId, String(site.name || '未命名站点'), String(site.description || ''),
          String(site.path || ''), site.published === true ? 1 : 0, site.source_visible === true ? 1 : 0,
          created, site.updated_at || created);
      }
      this.db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)').run(LEGACY_MIGRATION, now());
      this.db.exec('COMMIT');
      if (this.dbPath !== ':memory:' && !fs.existsSync(`${this.legacyJsonPath}.migrated.bak`)) {
        fs.copyFileSync(this.legacyJsonPath, `${this.legacyJsonPath}.migrated.bak`);
      }
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureSettings() {
    const current = this.db.prepare('SELECT value FROM settings WHERE id=1').get();
    const uploadMaxFileSize = uploadMaxFileSizeFromEnv(this.env);
    if (!current) {
      const settings = normalizeSettings({}, { uploadMaxFileSize });
      this.db.prepare('INSERT INTO settings(id,value,updated_at) VALUES(1,?,?)')
        .run(JSON.stringify(settings), now());
    } else {
      const parsed = JSON.parse(current.value);
      const options = parsed?.uploads?.maxFileSize === undefined ? { uploadMaxFileSize } : {};
      const normalized = normalizeSettings(parsed, options);
      this.db.prepare('UPDATE settings SET value=?,updated_at=? WHERE id=1')
        .run(JSON.stringify(normalized), now());
    }
  }

  async createUser(input) {
    const username = String(input.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new TypeError('用户名必须为 3-32 位字母、数字、点、下划线或连字符');
    if (!['admin', 'editor'].includes(input.role)) throw new TypeError('无效角色');
    const passwordHash = input.passwordHash || await hashPassword(input.password);
    const id = input.id || randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO users
      (id,username,password_hash,role,active,default_password,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, username, passwordHash, input.role,
      input.active === false ? 0 : 1, input.defaultPassword ? 1 : 0, timestamp, timestamp);
    return this.getUserById(id);
  }
  getUserById(id) { return userRow(this.db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
  getUserByUsername(username) { return userRow(this.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username)); }
  getAllUsers() { return this.db.prepare('SELECT * FROM users ORDER BY created_at').all().map(userRow); }
  countActiveAdmins() { return Number(this.db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1").get().count); }
  async updateUser(id, updates) {
    const fields = [], values = [];
    if (Object.hasOwn(updates, 'role')) {
      if (!['admin', 'editor'].includes(updates.role)) throw new TypeError('无效角色');
      fields.push('role=?'); values.push(updates.role);
    }
    if (Object.hasOwn(updates, 'active')) {
      if (typeof updates.active !== 'boolean') throw new TypeError('active 必须是布尔值');
      fields.push('active=?'); values.push(updates.active ? 1 : 0);
    }
    if (Object.hasOwn(updates, 'username')) {
      const username = String(updates.username).trim();
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new TypeError('用户名格式无效');
      fields.push('username=?'); values.push(username);
    }
    if (updates.password || updates.passwordHash) {
      fields.push('password_hash=?', 'default_password=0', 'session_version=session_version+1');
      values.push(updates.passwordHash || await hashPassword(updates.password));
    }
    if (!fields.length) return this.getUserById(id);
    fields.push('updated_at=?'); values.push(now(), id);
    const result = this.db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...values);
    if (updates.password || Object.hasOwn(updates, 'active') || Object.hasOwn(updates, 'role') || Object.hasOwn(updates, 'username')) this.deleteSessionsForUser(id);
    return result.changes ? this.getUserById(id) : null;
  }
  deleteUser(id) { return this.db.prepare('DELETE FROM users WHERE id=?').run(id); }
  setLastLogin(id) { this.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), id); }

  createSession(session) {
    this.db.prepare(`INSERT INTO sessions
      (token_hash,user_id,csrf_hash,session_version,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(session.tokenHash, session.userId, session.csrfHash,
      session.sessionVersion, now(), now(), session.idleExpiresAt, session.absoluteExpiresAt);
  }
  getSessionByHash(hash) {
    return this.db.prepare(`SELECT s.*,u.username,u.role,u.active,u.default_password,u.session_version user_session_version
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.idle_expires_at>? AND s.absolute_expires_at>? AND u.active=1 AND s.session_version=u.session_version`)
      .get(hash, now(), now()) || null;
  }
  touchSession(hash, idleExpiresAt) { this.db.prepare('UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE token_hash=?').run(now(), idleExpiresAt, hash); }
  updateSessionCsrf(hash, csrfHash) { this.db.prepare('UPDATE sessions SET csrf_hash=? WHERE token_hash=?').run(csrfHash, hash); }
  deleteSessionByHash(hash) { return this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); }
  deleteSessionsForUser(id) { return this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
  deleteExpiredSessions() { return this.db.prepare('DELETE FROM sessions WHERE idle_expires_at<=? OR absolute_expires_at<=?').run(now(), now()); }

  async createSite(site, ownerId) {
    const owner = ownerId || this.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get()?.id;
    if (!owner) throw new Error('站点必须有所有者');
    const id = site.id || randomUUID(), timestamp = now();
    this.db.prepare(`INSERT INTO sites
      (id,owner_user_id,name,description,path,published,source_visible,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, owner, String(site.name), String(site.description || ''), String(site.path),
      site.published ? 1 : 0, site.source_visible === false ? 0 : 1, timestamp, timestamp);
    return this.getSiteById(id);
  }
  async getAllSites(ownerId) {
    const sql = `SELECT s.*,u.username owner_username FROM sites s JOIN users u ON u.id=s.owner_user_id ${ownerId ? 'WHERE s.owner_user_id=?' : ''} ORDER BY s.created_at DESC`;
    return (ownerId ? this.db.prepare(sql).all(ownerId) : this.db.prepare(sql).all()).map(siteRow);
  }
  async getPublishedSites() {
    return this.db.prepare(`SELECT s.*,u.username owner_username FROM sites s JOIN users u ON u.id=s.owner_user_id WHERE s.published=1 ORDER BY s.created_at DESC`).all().map(siteRow);
  }
  async getSiteById(id, ownerId) {
    const sql = `SELECT s.*,u.username owner_username FROM sites s JOIN users u ON u.id=s.owner_user_id WHERE s.id=?${ownerId ? ' AND s.owner_user_id=?' : ''}`;
    return siteRow(ownerId ? this.db.prepare(sql).get(id, ownerId) : this.db.prepare(sql).get(id));
  }
  async updateSite(id, updates, ownerId) {
    const allowed = ['name','description','path','published','source_visible'];
    const fields = [], values = [];
    for (const field of allowed) if (Object.hasOwn(updates, field)) {
      fields.push(`${field}=?`);
      const value = ['published','source_visible'].includes(field) ? (updates[field] ? 1 : 0) : updates[field];
      values.push(value);
    }
    if (!fields.length) return this.getSiteById(id, ownerId);
    fields.push('updated_at=?'); values.push(now(), id);
    let sql = `UPDATE sites SET ${fields.join(',')} WHERE id=?`;
    if (ownerId) { sql += ' AND owner_user_id=?'; values.push(ownerId); }
    const result = this.db.prepare(sql).run(...values);
    return result.changes ? this.getSiteById(id, ownerId) : null;
  }
  async deleteSite(id, ownerId) {
    return ownerId ? this.db.prepare('DELETE FROM sites WHERE id=? AND owner_user_id=?').run(id, ownerId)
      : this.db.prepare('DELETE FROM sites WHERE id=?').run(id);
  }
  countSitesByOwner(id) { return Number(this.db.prepare('SELECT COUNT(*) count FROM sites WHERE owner_user_id=?').get(id).count); }
  getUsersWithSiteCounts() {
    return this.db.prepare(`SELECT u.*,COUNT(s.id) site_count FROM users u
      LEFT JOIN sites s ON s.owner_user_id=u.id GROUP BY u.id ORDER BY u.created_at`).all().map(userRow);
  }

  validatePage(input, partial = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('页面数据格式无效');
    const page = {};
    if (!partial || Object.hasOwn(input, 'slug')) {
      const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
      if (!/^[a-z0-9](?:[a-z0-9-]{0,79}[a-z0-9])?$/.test(slug)) throw new TypeError('slug 必须由小写字母、数字和连字符组成，最长 81 位且不能以连字符结尾');
      page.slug = slug;
    }
    if (!partial || Object.hasOwn(input, 'title')) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 160) throw new TypeError('页面标题必须为 1-160 字符');
      page.title = title;
    }
    if (Object.hasOwn(input, 'category')) {
      const category = typeof input.category === 'string' ? input.category.trim() : '';
      if (category.length > 80) throw new TypeError('页面分类不得超过 80 字符');
      page.category = category;
    }
    if (Object.hasOwn(input, 'excerpt')) {
      const excerpt = typeof input.excerpt === 'string' ? input.excerpt.trim() : '';
      if (excerpt.length > 500) throw new TypeError('页面摘要不得超过 500 字符');
      page.excerpt = excerpt;
    }
    if (Object.hasOwn(input, 'content')) {
      if (typeof input.content !== 'string') throw new TypeError('页面内容必须是字符串');
      if (Buffer.byteLength(input.content, 'utf8') > 300 * 1024) throw new TypeError('页面内容不得超过 300KB');
      page.content = input.content;
    }
    if (Object.hasOwn(input, 'type')) {
      if (!['article','doc','code'].includes(input.type)) throw new TypeError('页面类型无效');
      page.type = input.type;
    }
    if (Object.hasOwn(input, 'published')) {
      if (typeof input.published !== 'boolean') throw new TypeError('published 必须是布尔值');
      page.published = input.published ? 1 : 0;
    }
    if (Object.hasOwn(input, 'sort_order')) {
      if (!Number.isSafeInteger(input.sort_order) || input.sort_order < 0 || input.sort_order > 999999) throw new TypeError('排序值无效');
      page.sort_order = input.sort_order;
    }
    return page;
  }
  createPage(input) {
    const page = this.validatePage({ type: 'article', published: false, ...input });
    const id = randomUUID(); const timestamp = now();
    this.db.prepare(`INSERT INTO pages (id,slug,title,category,excerpt,content,type,published,sort_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,page.slug,page.title,page.category||'',page.excerpt||'',page.content||'',page.type,page.published,page.sort_order||0,timestamp,timestamp);
    return this.getPageById(id);
  }
  getPageById(id) { return pageRow(this.db.prepare('SELECT * FROM pages WHERE id=?').get(id)); }
  getPageBySlug(slug, publishedOnly = false) {
    return pageRow(this.db.prepare(`SELECT * FROM pages WHERE slug=?${publishedOnly ? ' AND published=1' : ''}`).get(slug));
  }
  getAllPages() { return this.db.prepare('SELECT * FROM pages ORDER BY sort_order,created_at DESC,id').all().map(pageRow); }
  getPublishedPages(category) {
    const rows = category ? this.db.prepare('SELECT * FROM pages WHERE published=1 AND category=? ORDER BY sort_order,created_at,id').all(category)
      : this.db.prepare('SELECT * FROM pages WHERE published=1 ORDER BY sort_order,created_at,id').all();
    return rows.map(pageRow);
  }
  updatePage(id, input) {
    const page = this.validatePage(input, true);
    const fields = [], values = [];
    for (const [key, value] of Object.entries(page)) { fields.push(`${key}=?`); values.push(value); }
    if (!fields.length) return this.getPageById(id);
    fields.push('updated_at=?'); values.push(now(), id);
    const result = this.db.prepare(`UPDATE pages SET ${fields.join(',')} WHERE id=?`).run(...values);
    return result.changes ? this.getPageById(id) : null;
  }
  deletePage(id) { return this.db.prepare('DELETE FROM pages WHERE id=?').run(id); }
  getAdjacentPages(page) {
    const pages = this.getPublishedPages(page.category);
    const index = pages.findIndex((item) => item.id === page.id);
    return { prev: index > 0 ? pages[index-1] : null, next: index >= 0 && index < pages.length-1 ? pages[index+1] : null };
  }

  getSettings() { return normalizeSettings(JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value)); }
  updateSettings(value) {
    const normalized = normalizeSettings(value);
    this.db.prepare('UPDATE settings SET value=?,updated_at=? WHERE id=1').run(JSON.stringify(normalized), now());
    return normalized;
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}

module.exports = DatabaseManager;
module.exports.siteFromRow = siteRow;
