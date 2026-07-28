const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const unzipper = require('unzipper');
const { createZipBuffer, crc32, MAX_ENTRIES, MAX_FILE_SIZE, MAX_TOTAL_SIZE } = require('../lib/zip');

async function makeFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-zip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>你好，世界</h1>\n', 'utf8');
  await fs.writeFile(path.join(dir, 'assets', 'style.css'), 'body { color: red; }\n', 'utf8');
  await fs.writeFile(path.join(dir, '中文文件.txt'), 'UTF-8 文件名与内容\n', 'utf8');

  // 确定性二进制内容（含 0x00-0xFF 全字节范围）
  const binary = Buffer.alloc(8192);
  for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 31 + 7) & 0xff;
  await fs.writeFile(path.join(dir, 'assets', 'binary.bin'), binary);

  // 以下文件都应被跳过
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n', 'utf8');
  await fs.writeFile(path.join(dir, '.git', 'config'), '[core]\n', 'utf8');
  await fs.writeFile(path.join(dir, 'secret.pem'), 'PRIVATE KEY\n', 'utf8');
  await fs.writeFile(path.join(dir, 'cert.crt'), 'CERT\n', 'utf8');
  await fs.writeFile(path.join(dir, 'app.js.map'), '{}\n', 'utf8');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(dir, 'id_rsa'), 'KEY\n', 'utf8');

  return { dir, binary };
}

async function unzipToMap(buffer) {
  const archive = await unzipper.Open.buffer(buffer);
  const result = new Map();
  for (const entry of archive.files) {
    if (entry.type === 'Directory') continue;
    result.set(entry.path, await entry.buffer());
  }
  return result;
}

test('crc32 符合标准测试向量', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('默认限制常量符合要求', () => {
  assert.equal(MAX_ENTRIES, 2000);
  assert.equal(MAX_FILE_SIZE, 25 * 1024 * 1024);
  assert.equal(MAX_TOTAL_SIZE, 200 * 1024 * 1024);
});

test('打包文本、二进制与 UTF-8 文件名，跳过敏感文件', async (t) => {
  const { dir, binary } = await makeFixture(t);
  const zip = createZipBuffer(dir);

  assert.ok(Buffer.isBuffer(zip));
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '应以 LFH 签名开头');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, '应以 EOCD 签名结尾');

  const entries = await unzipToMap(zip);
  const names = [...entries.keys()].sort();
  assert.deepEqual(names, ['assets/binary.bin', 'assets/style.css', 'index.html', '中文文件.txt']);

  assert.equal(entries.get('index.html').toString('utf8'), '<h1>你好，世界</h1>\n');
  assert.equal(entries.get('中文文件.txt').toString('utf8'), 'UTF-8 文件名与内容\n');
  assert.ok(entries.get('assets/binary.bin').equals(binary), '二进制内容应逐字节一致');

  for (const blocked of ['.env', '.git/config', 'secret.pem', 'cert.crt', 'app.js.map', 'package-lock.json', 'id_rsa']) {
    assert.ok(!entries.has(blocked), `不应包含 ${blocked}`);
  }
});

test('includeFilter 控制打包范围', async (t) => {
  const { dir } = await makeFixture(t);
  const zip = createZipBuffer(dir, { includeFilter: (rel) => rel.endsWith('.html') });
  const entries = await unzipToMap(zip);
  assert.deepEqual([...entries.keys()], ['index.html']);
});

test('超出条目数、单文件与总量限制时报错', async (t) => {
  const { dir } = await makeFixture(t);
  assert.throws(
    () => createZipBuffer(dir, { limits: { maxEntries: 2 } }),
    { code: 'ZIP_TOO_MANY_FILES' },
  );
  assert.throws(
    () => createZipBuffer(dir, { limits: { maxFileSize: 100 } }),
    { code: 'ZIP_FILE_TOO_LARGE' },
  );
  assert.throws(
    () => createZipBuffer(dir, { limits: { maxTotalSize: 200 } }),
    { code: 'ZIP_TOTAL_TOO_LARGE' },
  );
});

test('目录不存在时报错', () => {
  assert.throws(() => createZipBuffer('/nonexistent-path-for-zip-test'), { code: 'ZIP_SOURCE_NOT_FOUND' });
});

test('空目录生成仅含 EOCD 的合法空包', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-zip-empty-'));
  try {
    const zip = createZipBuffer(dir);
    assert.equal(zip.length, 22);
    const entries = await unzipToMap(zip);
    assert.equal(entries.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
