const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const MAX_IMAGE_SIZE = 2 * 1024 * 1024;
const TYPES = [
  { mime: 'image/png', extension: '.png', matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', extension: '.jpg', matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', extension: '.webp', matches: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }
];

function imageError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function inspectImage(value, options = {}) {
  const maxSize = options.maxSize === undefined ? MAX_IMAGE_SIZE : options.maxSize;
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new TypeError('maxSize 必须是正整数');
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    throw imageError('INVALID_IMAGE', '图片内容必须是二进制数据');
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length === 0) throw imageError('EMPTY_IMAGE', '图片不能为空');
  if (buffer.length > maxSize) throw imageError('IMAGE_TOO_LARGE', `图片不得超过 ${maxSize} 字节`, 413);

  const type = TYPES.find((candidate) => candidate.matches(buffer));
  if (!type) throw imageError('UNSUPPORTED_IMAGE_TYPE', '只支持 PNG、JPEG 和 WebP 图片', 415);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return { mime: type.mime, extension: type.extension, size: buffer.length, hash, filename: `${hash}${type.extension}` };
}

async function saveBrandAsset(directory, value, options = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('资源目录不能为空');
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  const image = inspectImage(buffer, options);
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, image.filename);
  try {
    await fs.writeFile(destination, buffer, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return { ...image, path: destination };
}

async function deleteBrandAsset(directory, filename) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('资源目录不能为空');
  if (typeof filename !== 'string' || !/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(filename))
    throw imageError('INVALID_ASSET_NAME', '无效的品牌资源文件名');
  const destination = path.join(directory, filename);
  await fs.rm(destination, { force: true });
  return true;
}

module.exports = {
  MAX_IMAGE_SIZE,
  inspectImage,
  validateImage: inspectImage,
  saveBrandAsset,
  saveBrandImage: saveBrandAsset,
  deleteBrandAsset,
  deleteBrandImage: deleteBrandAsset
};
