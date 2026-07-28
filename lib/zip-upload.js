const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const Busboy = require('busboy');

const BODY_FIELDS = new Set(['name', 'description']);

function moveFile(source, destination) {
  return fsp.rename(source, destination).catch(async (error) => {
    if (error.code !== 'EXDEV') throw error;
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fsp.rm(source, { force: true });
  });
}

function createStrictZipUpload({ uploadsDir, getMaxFileSize }) {
  if (!uploadsDir || typeof getMaxFileSize !== 'function') throw new TypeError('ZIP upload configuration is required');

  return function strictZipUpload(req, res, next) {
    void (async () => {
    const maxFileSize = getMaxFileSize();
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: maxFileSize + 1,
          files: 2,
          fields: 3,
          parts: 4,
          fieldNameSize: 32,
          fieldSize: 2048,
          headerPairs: 20
        }
      });
    } catch {
      return res.status(400).json({ error: '请使用 multipart/form-data 上传 ZIP 文件' });
    }

    await fsp.mkdir(uploadsDir, { recursive: true });
    const tempDir = await fsp.mkdtemp(path.join(uploadsDir, 'request-'));
    const body = Object.create(null);
    const streams = new Set();
    const writes = [];
    let uploaded = null;
    let settled = false;
    let cleanupPromise;

    const cleanup = () => cleanupPromise ||= fsp.rm(tempDir, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 50
    }).catch(() => {});

    async function stop(status, message, respond = true) {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      req.resume();
      for (const { input, output } of streams) {
        input.unpipe(output);
        input.resume();
        output.destroy();
      }
      await Promise.allSettled(writes);
      await cleanup();
      if (respond && !res.headersSent) res.status(status).json({ error: message });
    }

    res.once('finish', cleanup);
    res.once('close', cleanup);
    req.once('aborted', () => { void stop(400, '上传已中止', false); });

    parser.on('field', (field, value, info) => {
      if (!BODY_FIELDS.has(field)) return void stop(400, '站点上传包含不支持的表单字段');
      if (Object.hasOwn(body, field)) return void stop(400, `${field} 只能提交一次`);
      if (info.nameTruncated || info.valueTruncated) return void stop(413, `${field} 字段过长`);
      body[field] = value;
    });

    parser.on('file', (field, input, info) => {
      if (field !== 'file' || uploaded) {
        input.resume();
        return void stop(400, '请选择一个 ZIP 文件');
      }
      if (!info.filename) {
        input.resume();
        return void stop(400, '请选择一个 ZIP 文件');
      }

      const tempFilePath = path.join(tempDir, 'upload.zip');
      const output = fs.createWriteStream(tempFilePath, { flags: 'wx', mode: 0o600 });
      const record = { input, output };
      streams.add(record);
      uploaded = {
        name: info.filename,
        size: 0,
        tempFilePath,
        mv(destination) { return moveFile(tempFilePath, destination); }
      };

      const write = new Promise((resolve, reject) => {
        let finished = false;
        output.once('finish', () => { finished = true; });
        output.once('close', () => finished ? resolve() : reject(new Error('ZIP temporary file closed before finishing')));
        output.once('error', reject);
      }).finally(() => streams.delete(record));
      writes.push(write);

      input.on('data', (chunk) => { uploaded.size += chunk.length; });
      input.once('limit', () => { void stop(413, `ZIP 文件不能超过 ${Math.round(maxFileSize / 1024 / 1024)} MiB`); });
      input.once('error', () => { void stop(400, 'ZIP 文件读取失败'); });
      output.once('error', () => { void stop(500, 'ZIP 临时文件写入失败'); });
      input.pipe(output);
    });

    parser.once('filesLimit', () => { void stop(400, '请选择一个 ZIP 文件'); });
    parser.once('fieldsLimit', () => { void stop(400, '站点上传包含过多表单字段'); });
    parser.once('partsLimit', () => { void stop(400, '站点上传包含过多部分'); });
    parser.once('error', () => { void stop(400, '上传数据格式无效'); });
    parser.once('finish', async () => {
      if (settled) return;
      try {
        await Promise.all(writes);
      } catch {
        return void stop(500, 'ZIP 临时文件写入失败');
      }
      if (settled) return;
      settled = true;
      req.body = body;
      req.files = uploaded ? { file: uploaded } : null;
      req.zipUploadMaxFileSize = maxFileSize;
      next();
    });

    if (req.aborted) return void stop(400, '上传已中止', false);
    req.pipe(parser);
    })().catch(next);
  };
}

module.exports = { createStrictZipUpload };
