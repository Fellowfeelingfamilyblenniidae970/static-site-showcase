const fs = require('fs');
const path = require('path');
const { deflateRawSync } = require('node:zlib');

const MAX_ENTRIES = 2000;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 200 * 1024 * 1024;

// 私钥 / 证书 / source map / lock 文件等不应打包进站点归档
const BLOCKED_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks',
  '.crt', '.cer', '.der',
  '.map',
  '.lock',
]);

const BLOCKED_FILENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
]);

const BLOCKED_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function isSensitivePath(relPath) {
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.')) return true; // 点文件 / 点目录（含 .env、.env.local、.git）
  }
  const base = segments[segments.length - 1].toLowerCase();
  if (BLOCKED_FILENAMES.has(base)) return true;
  if (BLOCKED_PREFIXES.some((prefix) => base === prefix || base.startsWith(prefix + '.'))) return true;
  const ext = path.posix.extname(base);
  if (BLOCKED_EXTENSIONS.has(ext)) return true;
  return false;
}

function sanitizeEntryName(relPath) {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  // 去除控制字符，避免损坏 ZIP 记录结构
  return segments.join('/').replace(/[\x00-\x1f]/g, '_');
}

function collectFiles(rootDir, dir, relPrefix, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = relPrefix ? relPrefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (isSensitivePath(relPath + '/')) continue;
      collectFiles(rootDir, absPath, relPath, results);
    } else if (entry.isFile()) {
      results.push({ absPath, relPath });
    }
    // 符号链接等特殊条目一律跳过，避免逃逸根目录
  }
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZipBuffer(directory, options = {}) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw zipError('ZIP_SOURCE_NOT_FOUND', `目录不存在: ${directory}`);
  }

  const includeFilter = typeof options.includeFilter === 'function' ? options.includeFilter : null;
  const limits = options.limits || {};
  const maxEntries = limits.maxEntries || MAX_ENTRIES;
  const maxFileSize = limits.maxFileSize || MAX_FILE_SIZE;
  const maxTotalSize = limits.maxTotalSize || MAX_TOTAL_SIZE;

  const found = [];
  collectFiles(root, root, '', found);

  const files = [];
  const skipped = [];
  let totalSize = 0;

  for (const item of found) {
    const relPath = toPosixPath(path.relative(root, item.absPath));
    if (isSensitivePath(relPath)) {
      skipped.push(relPath);
      continue;
    }
    if (includeFilter && !includeFilter(relPath)) {
      skipped.push(relPath);
      continue;
    }
    if (files.length >= maxEntries) {
      throw zipError('ZIP_TOO_MANY_FILES', `打包文件数量超过 ${maxEntries} 个`);
    }
    const stat = fs.statSync(item.absPath);
    if (stat.size > maxFileSize) {
      throw zipError('ZIP_FILE_TOO_LARGE', `文件超过 ${Math.floor(maxFileSize / 1024 / 1024)}MB 限制: ${relPath}`);
    }
    totalSize += stat.size;
    if (totalSize > maxTotalSize) {
      throw zipError('ZIP_TOTAL_TOO_LARGE', `打包总大小超过 ${Math.floor(maxTotalSize / 1024 / 1024)}MB`);
    }
    files.push({ absPath: item.absPath, relPath });
  }

  const chunks = [];
  const centralRecords = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.absPath);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const nameBuffer = Buffer.from(sanitizeEntryName(file.relPath), 'utf8');
    if (nameBuffer.length === 0 || nameBuffer.length > 0xffff) {
      throw zipError('ZIP_INVALID_NAME', `文件名无效: ${file.relPath}`);
    }
    const { dosTime, dosDate } = dosDateTime(new Date());

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // LFH 签名
    header.writeUInt16LE(20, 4); // 解压所需版本
    header.writeUInt16LE(0x0800, 6); // bit 11: UTF-8 文件名
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28); // extra 长度

    chunks.push(header, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8); // UTF-8 标志
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // LFH 偏移

    centralRecords.push(central, nameBuffer);
    offset += header.length + nameBuffer.length + compressed.length;
  }

  const centralSize = centralRecords.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // 磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...chunks, ...centralRecords, eocd]);
}

module.exports = {
  createZipBuffer,
  crc32,
  MAX_ENTRIES,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
};
