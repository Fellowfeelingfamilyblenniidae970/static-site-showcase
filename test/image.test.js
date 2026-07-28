const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { inspectImage, saveBrandAsset, deleteBrandAsset } = require('../lib/image');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
const WEBP = Buffer.from('RIFF0000WEBPdata', 'ascii');

test('通过 magic bytes 识别 PNG、JPEG 和 WebP 并生成内容哈希文件名', () => {
  assert.match(inspectImage(PNG).filename, /^[a-f0-9]{64}\.png$/);
  assert.equal(inspectImage(JPEG).mime, 'image/jpeg');
  assert.equal(inspectImage(WEBP).extension, '.webp');
  assert.equal(inspectImage(PNG).filename, inspectImage(Buffer.from(PNG)).filename);
});

test('拒绝 SVG、伪装扩展内容、空内容和超限图片', () => {
  assert.throws(() => inspectImage(Buffer.from('<svg/>')), { code: 'UNSUPPORTED_IMAGE_TYPE' });
  assert.throws(() => inspectImage(Buffer.from('not png')), { code: 'UNSUPPORTED_IMAGE_TYPE' });
  assert.throws(() => inspectImage(Buffer.alloc(0)), { code: 'EMPTY_IMAGE' });
  assert.throws(() => inspectImage(PNG, { maxSize: PNG.length - 1 }), { code: 'IMAGE_TOO_LARGE' });
});

test('品牌资源按哈希保存、去重并安全删除', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-image-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await saveBrandAsset(dir, PNG);
  const second = await saveBrandAsset(dir, PNG);
  assert.equal(first.filename, second.filename);
  assert.deepEqual(await fs.readFile(first.path), PNG);
  assert.deepEqual(await fs.readdir(dir), [first.filename]);
  assert.equal(await deleteBrandAsset(dir, first.filename), true);
  await assert.rejects(fs.stat(first.path), { code: 'ENOENT' });
});

test('删除工具拒绝路径穿越和非内容哈希文件名', async () => {
  await assert.rejects(deleteBrandAsset('/tmp/assets', '../secret.png'), { code: 'INVALID_ASSET_NAME' });
  await assert.rejects(deleteBrandAsset('/tmp/assets', `${'a'.repeat(64)}.svg`), { code: 'INVALID_ASSET_NAME' });
});
