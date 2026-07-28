const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const Database = require('../database');
const { getDefaultAdminCredentials, verifyPassword } = require('../lib/password');

async function fixture(t, legacy) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-sqlite-'));
  const legacyPath = path.join(dir, 'sites.json');
  if (legacy) await fs.writeFile(legacyPath, JSON.stringify(legacy));
  const db = new Database({
    dbPath: path.join(dir, 'platform.db'),
    legacyJsonPath: legacyPath,
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '123456' }
  });
  await db.init();
  t.after(() => { db.close(); return fs.rm(dir, { recursive: true, force: true }); });
  return db;
}

test('首次初始化使用显式管理员密码且密码经过哈希', async (t) => {
  const db = await fixture(t);
  const admin = db.getUserByUsername('admin');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.default_password, false);
  assert.notEqual(admin.password_hash, '123456');
  assert.equal(await verifyPassword('123456', admin.password_hash), true);
});

test('未设置初始管理员密码时拒绝创建公开默认账号', () => {
  assert.throws(
    () => getDefaultAdminCredentials({ ADMIN_USERNAME: 'admin' }),
    /ADMIN_PASSWORD is required/
  );
});

test('新站点归属管理员并默认为草稿和代码公开', async (t) => {
  const db = await fixture(t);
  const admin = db.getUserByUsername('admin');
  const site = await db.createSite({ id: 'one', name: 'One', path: '/tmp/one' }, admin.id);
  assert.equal(site.owner_user_id, admin.id);
  assert.equal(site.published, false);
  assert.equal(site.source_visible, true);
  assert.equal((await db.getPublishedSites()).length, 0);
});

test('编辑者只能通过 owner 条件读取和删除自己的站点', async (t) => {
  const db = await fixture(t);
  const one = await db.createUser({ username: 'editor_one', password: 'abcdef', role: 'editor' });
  const two = await db.createUser({ username: 'editor_two', password: 'abcdef', role: 'editor' });
  await db.createSite({ id: 'owned', name: 'Owned', path: '/tmp/owned' }, one.id);
  assert.equal((await db.getAllSites(one.id)).length, 1);
  assert.equal(await db.getSiteById('owned', two.id), null);
  assert.equal(Number((await db.deleteSite('owned', two.id)).changes), 0);
  assert.equal(Number((await db.deleteSite('owned', one.id)).changes), 1);
});

test('旧 JSON 迁移一次并将站点归属管理员', async (t) => {
  const db = await fixture(t, { sites: [{ id: 'legacy', name: 'Old', path: '/tmp/old', published: true, source_visible: false }] });
  const site = await db.getSiteById('legacy');
  assert.equal(site.owner_user_id, db.getUserByUsername('admin').id);
  assert.equal(site.published, true);
  assert.equal(site.source_visible, false);
  assert.ok(await fs.stat(`${db.legacyJsonPath}.migrated.bak`));
});

test('全站设置可以持久化', async (t) => {
  const db = await fixture(t);
  const settings = db.getSettings();
  settings.home.layout = 'grid';
  db.updateSettings(settings);
  assert.equal(db.getSettings().home.layout, 'grid');
});

test('旧 sites schema 自动移除自定义域名字段', async (t) => {
  const db = await fixture(t);
  db.db.exec('PRAGMA foreign_keys=OFF; DROP TABLE sites; CREATE TABLE sites (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT "", path TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, source_visible INTEGER NOT NULL DEFAULT 1, custom_domain TEXT, domain_status TEXT, domain_verification_token TEXT, domain_verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); PRAGMA foreign_keys=ON;');
  db.migrateRemovedDomainColumns();
  const columns = db.db.prepare("PRAGMA table_info('sites')").all().map((column) => column.name);
  assert.equal(columns.includes('custom_domain'), false);
  assert.equal(columns.includes('domain_status'), false);
});

test('页面支持创建、更新、删除并按 sort_order 排序', async (t) => {
  const db = await fixture(t);
  const later = await db.createPage({ slug: 'later', title: 'Later', content: 'later', published: true, sort_order: 20 });
  const first = await db.createPage({ slug: 'first', title: 'First', content: 'first', published: true, sort_order: 1 });
  const draft = await db.createPage({ slug: 'draft', title: 'Draft', content: 'draft', sort_order: 0 });

  assert.equal(later.published, true);
  assert.equal(draft.published, false);
  assert.deepEqual(db.getPublishedPages().map((page) => page.slug), ['first', 'later']);

  const updated = db.updatePage(later.id, { title: 'Updated', sort_order: 0, published: false });
  assert.equal(updated.title, 'Updated');
  assert.equal(updated.published, false);
  assert.deepEqual(db.getPublishedPages().map((page) => page.slug), ['first']);
  assert.equal(Number(db.deletePage(first.id).changes), 1);
  assert.equal(db.getPageById(first.id), null);
});

test('页面字段执行严格校验且 slug 唯一', async (t) => {
  const db = await fixture(t);
  assert.throws(() => db.createPage({ slug: 'bad-', title: 'Bad' }), /slug/);
  assert.throws(() => db.createPage({ slug: 'valid', title: '', published: false }), /标题/);
  assert.throws(() => db.createPage({ slug: 'valid', title: 'Valid', published: 'true' }), /布尔值/);
  assert.throws(() => db.createPage({ slug: 'valid', title: 'Valid', sort_order: 1.5 }), /排序值/);
  assert.throws(() => db.createPage({ slug: 'valid', title: 'Valid', category: 'x'.repeat(81) }), /分类/);
  db.createPage({ slug: 'unique', title: 'Unique' });
  assert.throws(() => db.createPage({ slug: 'unique', title: 'Duplicate' }), /UNIQUE constraint failed/);
});
