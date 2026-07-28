const Busboy = require('busboy');
const { CODE_FIELDS, MAX_CODE_FILE_SIZE } = require('./code-site');

const BODY_FIELDS = new Set(['name', 'description']);

function strictCodeUpload(req, res, next) {
  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_CODE_FILE_SIZE,
        files: CODE_FIELDS.length,
        fields: BODY_FIELDS.size,
        parts: CODE_FIELDS.length + BODY_FIELDS.size + 1,
        fieldNameSize: 32,
        fieldSize: 2048,
        headerPairs: 20
      }
    });
  } catch {
    return res.status(400).json({ error: '请使用 multipart/form-data 提交代码' });
  }

  const body = Object.create(null);
  const files = Object.create(null);
  const seenFiles = new Set();
  let stopped = false;

  function stop(status, message) {
    if (stopped) return;
    stopped = true;
    req.unpipe(parser);
    req.resume();
    res.status(status).json({ error: message });
  }

  parser.on('field', (field, value, info) => {
    if (!BODY_FIELDS.has(field)) return stop(400, '代码上传包含不支持的表单字段');
    if (Object.hasOwn(body, field)) return stop(400, `${field} 只能提交一次`);
    if (info.nameTruncated || info.valueTruncated) return stop(413, `${field} 字段过长`);
    body[field] = value;
  });

  parser.on('file', (field, stream, info) => {
    if (!CODE_FIELDS.includes(field)) {
      stream.resume();
      return stop(400, '代码上传包含不支持的文件字段');
    }
    if (!info.filename || seenFiles.has(field)) {
      stream.resume();
      return stop(400, `${field} 只能提交一次`);
    }
    seenFiles.add(field);

    const chunks = [];
    stream.on('limit', () => stop(413, '单个代码文件不能超过 512 KiB'));
    stream.on('data', (chunk) => { if (!stopped) chunks.push(chunk); });
    stream.on('end', () => {
      if (!stopped) files[field] = { data: Buffer.concat(chunks) };
    });
    stream.on('error', () => stop(400, '代码文件读取失败'));
  });

  parser.on('filesLimit', () => stop(413, '代码文件数量不能超过 3 个'));
  parser.on('fieldsLimit', () => stop(413, '表单字段数量不能超过 2 个'));
  parser.on('partsLimit', () => stop(413, '上传内容包含过多部分'));
  parser.on('error', () => stop(400, '无法解析代码上传请求'));
  parser.on('finish', () => {
    if (stopped) return;
    req.body = body;
    req.files = files;
    next();
  });

  req.pipe(parser);
}

module.exports = { strictCodeUpload };
