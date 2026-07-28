const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS, MIN_UPLOAD_MAX_FILE_SIZE, DEFAULT_UPLOAD_MAX_FILE_SIZE,
  MAX_UPLOAD_MAX_FILE_SIZE, uploadMaxFileSizeFromEnv, normalizeSettings, patchSettings, projectPublicSettings
} = require('../lib/settings');

test('默认设置包含完整的品牌、首页、外观和上传配置且不可修改', () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS), ['branding', 'home', 'appearance', 'uploads']);
  assert.equal(DEFAULT_SETTINGS.home.layout, 'editorial');
  assert.equal(DEFAULT_SETTINGS.home.showPreview, true);
  assert.equal(DEFAULT_SETTINGS.appearance.defaultTheme, 'system');
  assert.equal(DEFAULT_SETTINGS.uploads.maxFileSize, DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.branding), true);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.uploads), true);
});

test('规范化旧的扁平设置并为缺失或损坏值补默认值', () => {
  const settings = normalizeSettings({
    siteName: '旧站名', footerText: '旧页脚', homeLayout: 'grid', showPreview: false,
    defaultTheme: 'dark', accentColor: '#ABCDEF', home: { title: 42 }
  });
  assert.equal(settings.branding.name, '旧站名');
  assert.equal(settings.branding.footer, '旧页脚');
  assert.equal(settings.home.layout, 'grid');
  assert.equal(settings.home.showPreview, false);
  assert.equal(settings.home.title, DEFAULT_SETTINGS.home.title);
  assert.equal(settings.appearance.defaultTheme, 'dark');
  assert.equal(settings.appearance.accentColor, '#abcdef');
  assert.equal(settings.uploads.maxFileSize, DEFAULT_UPLOAD_MAX_FILE_SIZE);
});

test('上传限制支持环境默认值并严格校验整数边界', () => {
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: String(12 * 1024 * 1024) }), 12 * 1024 * 1024);
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: '0' }), DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: 'not-a-number' }), DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(normalizeSettings({}, { uploadMaxFileSize: 12 * 1024 * 1024 }).uploads.maxFileSize, 12 * 1024 * 1024);
  assert.equal(patchSettings({}, { uploads: { maxFileSize: MIN_UPLOAD_MAX_FILE_SIZE } }).uploads.maxFileSize, MIN_UPLOAD_MAX_FILE_SIZE);
  assert.equal(patchSettings({}, { uploads: { maxFileSize: MAX_UPLOAD_MAX_FILE_SIZE } }).uploads.maxFileSize, MAX_UPLOAD_MAX_FILE_SIZE);
  for (const value of [MIN_UPLOAD_MAX_FILE_SIZE - 1, MAX_UPLOAD_MAX_FILE_SIZE + 1, MIN_UPLOAD_MAX_FILE_SIZE + 1, 1.5, '52428800']) {
    assert.throws(() => patchSettings({}, { uploads: { maxFileSize: value } }), { code: 'INVALID_SETTING', path: 'uploads.maxFileSize' });
  }
});

test('PATCH 仅深合并白名单字段且不改变原对象', () => {
  const current = normalizeSettings({ branding: { name: '原名称' }, home: { layout: 'grid' } });
  const updated = patchSettings(current, {
    branding: { description: '新描述' }, appearance: { allowThemeSwitch: false }
  });
  assert.equal(updated.branding.name, '原名称');
  assert.equal(updated.branding.description, '新描述');
  assert.equal(updated.home.layout, 'grid');
  assert.equal(updated.appearance.allowThemeSwitch, false);
  assert.equal(current.branding.description, DEFAULT_SETTINGS.branding.description);
  assert.notEqual(updated.branding, current.branding);
});

test('PATCH 严格拒绝未知字段、错误类型、超长值、枚举和颜色', () => {
  assert.throws(() => patchSettings({}, { secret: {} }), { code: 'UNKNOWN_SETTING', path: 'secret' });
  assert.throws(() => patchSettings({}, { branding: { unknown: true } }), { code: 'UNKNOWN_SETTING' });
  assert.throws(() => patchSettings({}, { branding: { name: '' } }), { code: 'INVALID_SETTING' });
  assert.throws(() => patchSettings({}, { branding: { description: 'x'.repeat(301) } }), { code: 'INVALID_SETTING' });
  assert.throws(() => patchSettings({}, { home: { layout: 'masonry' } }), { code: 'INVALID_SETTING' });
  assert.throws(() => patchSettings({}, { home: { showPreview: 'yes' } }), { code: 'INVALID_SETTING' });
  assert.throws(() => patchSettings({}, { appearance: { accentColor: 'red' } }), { code: 'INVALID_SETTING' });
  assert.throws(() => patchSettings({}, { appearance: { defaultTheme: 'sepia' } }), { code: 'INVALID_SETTING' });
});

test('公开投影只返回规范化的公开结构和副本', () => {
  const projected = projectPublicSettings({ branding: { name: '公开名称' }, adminToken: 'secret' });
  assert.deepEqual(Object.keys(projected), ['branding', 'home', 'appearance']);
  assert.equal(projected.branding.name, '公开名称');
  assert.equal(projected.uploads, undefined);
  assert.equal(projected.adminToken, undefined);
  assert.notEqual(projected, DEFAULT_SETTINGS);
});
