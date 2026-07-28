const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createStrictZipUpload } = require('../lib/zip-upload');

function response() {
  const listeners = new Map();
  return {
    headersSent: false,
    statusCode: 200,
    once(event, handler) { listeners.set(event, handler); return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
    finish() { listeners.get('finish')?.(); }
  };
}

test('严格 ZIP 解析器仅在临时文件完整关闭后进入路由', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-host-zip-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const boundary = 'zcode-complete-upload';
  const bytes = Buffer.from('PK-complete-file-content');
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="site.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nSite\r\n--${boundary}--\r\n`)
  ]);
  const req = Readable.from([payload]);
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) };
  req.unpipe = Readable.prototype.unpipe.bind(req);
  req.resume = Readable.prototype.resume.bind(req);
  const res = response();
  const middleware = createStrictZipUpload({ uploadsDir: root, getMaxFileSize: () => 1024 * 1024 });

  await new Promise((resolve, reject) => middleware(req, res, (error) => error ? reject(error) : resolve()));
  assert.equal(req.files.file.size, bytes.length);
  assert.deepEqual(await fs.readFile(req.files.file.tempFilePath), bytes);
  const moved = path.join(root, 'moved.zip');
  await req.files.file.mv(moved);
  assert.deepEqual(await fs.readFile(moved), bytes);
  res.finish();
});
