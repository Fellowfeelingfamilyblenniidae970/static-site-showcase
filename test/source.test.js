const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  listSourceFiles,
  readSourceFile,
  normalizeSourcePath,
  MAX_FILE_SIZE
} = require('../lib/source');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-source-'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Hello</h1>');
  await fs.writeFile(path.join(root, 'assets', 'app.js'), 'console.log("ok")');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=value');
  await fs.writeFile(path.join(root, 'certificate.pem'), 'private');
  await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  return root;
}

test('文件列表只包含允许展示的文本源码', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = await listSourceFiles(root);
  assert.deepEqual(files.map((file) => file.path), ['index.html', 'assets/app.js']);
});

test('index.html 可以安全读取', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await readSourceFile(root, './index.html');
  assert.equal(source.language, 'html');
  assert.match(source.content, /Hello/);
});

test('拒绝路径穿越和绝对路径', () => {
  for (const value of ['../secret.js', '/etc/passwd', 'C:\\secret.js', 'a/../../secret.js']) {
    assert.throws(() => normalizeSourcePath(value), { code: 'INVALID_PATH' });
  }
});

test('拒绝敏感文件、二进制文件和超大文件', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(readSourceFile(root, '.env'), { code: 'FILE_NOT_ALLOWED' });
  await assert.rejects(readSourceFile(root, 'certificate.pem'), { code: 'FILE_NOT_ALLOWED' });
  await assert.rejects(readSourceFile(root, 'image.bin'), { code: 'FILE_NOT_ALLOWED' });

  const huge = path.join(root, 'huge.js');
  await fs.writeFile(huge, Buffer.alloc(MAX_FILE_SIZE + 1));
  await assert.rejects(readSourceFile(root, 'huge.js'), { code: 'FILE_TOO_LARGE' });
});

test('拒绝符号链接', async (t) => {
  const root = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  const target = path.join(outside, 'secret.js');
  await fs.writeFile(target, 'secret');

  try {
    await fs.symlink(target, path.join(root, 'linked.js'));
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('当前系统未允许创建符号链接');
    throw error;
  }

  await assert.rejects(readSourceFile(root, 'linked.js'), { code: 'FILE_NOT_ALLOWED' });
});
