const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const {
  extractZip,
  flattenSingleRoot,
  hasRootIndex,
  safeJoin,
  walkFiles
} = require('../lib/extract');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-extract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('测试 ZIP 安全解压为可访问的静态站点', async (t) => {
  const dir = await tempDir(t);
  const archive = path.join(__dirname, '..', 'test-site.zip');
  const result = await extractZip(archive, dir);

  assert.equal(result.written, 4);
  assert.deepEqual(result.skipped, []);
  assert.equal(await hasRootIndex(dir), true);
  assert.deepEqual((await walkFiles(dir)).sort(), [
    'index.html',
    'logo.svg',
    'script.js',
    'style.css'
  ]);
});

test('安全路径解析拒绝绝对路径和目录穿越', async (t) => {
  const dir = await tempDir(t);
  assert.equal(safeJoin(dir, '../outside.txt'), null);
  assert.equal(safeJoin(dir, '/absolute.txt'), null);
  assert.equal(safeJoin(dir, 'C:\\absolute.txt'), null);
  assert.equal(safeJoin(dir, 'assets/app.js'), path.join(dir, 'assets', 'app.js'));
});

test('单层包装目录仅在包含 index.html 时展开', async (t) => {
  const dir = await tempDir(t);
  const wrapper = path.join(dir, 'site');
  await fs.mkdir(wrapper);
  await fs.writeFile(path.join(wrapper, 'index.html'), '<!doctype html>');
  await fs.writeFile(path.join(wrapper, 'app.js'), '');

  assert.equal(await flattenSingleRoot(dir), 'site');
  assert.equal(await hasRootIndex(dir), true);
  assert.deepEqual((await walkFiles(dir)).sort(), ['app.js', 'index.html']);
});
