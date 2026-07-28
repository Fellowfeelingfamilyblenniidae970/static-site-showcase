const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');

const MAX_ENTRIES = 2000;
const MAX_ENTRY_SIZE = 25 * 1024 * 1024;
const MAX_EXTRACTED_SIZE = 200 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;

function archiveError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeJoin(baseDir, entryPath) {
  const base = path.resolve(baseDir);
  const cleaned = entryPath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null;

  const resolved = path.resolve(base, cleaned);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function extractZip(zipPath, destDir) {
  const archive = await unzipper.Open.file(zipPath);
  const entries = archive.files.filter((entry) => entry.type !== 'Directory');
  if (entries.length > MAX_ENTRIES) {
    throw archiveError('ZIP_TOO_MANY_FILES', `压缩包文件数量超过 ${MAX_ENTRIES} 个`);
  }

  const skipped = [];
  let written = 0;
  let totalSize = 0;
  let actualTotalSize = 0;

  for (const entry of entries) {
    const uncompressedSize = Number(entry.uncompressedSize || 0);
    const compressedSize = Number(entry.compressedSize || 0);
    const ratio = compressedSize > 0 ? uncompressedSize / compressedSize : uncompressedSize;

    if (uncompressedSize > MAX_ENTRY_SIZE) {
      throw archiveError('ZIP_ENTRY_TOO_LARGE', `文件 ${entry.path} 解压后过大`);
    }
    if (ratio > MAX_COMPRESSION_RATIO) {
      throw archiveError('ZIP_RATIO_TOO_HIGH', `文件 ${entry.path} 压缩比异常`);
    }

    totalSize += uncompressedSize;
    if (totalSize > MAX_EXTRACTED_SIZE) {
      throw archiveError('ZIP_TOO_LARGE', '压缩包解压后的总大小超过限制');
    }

    const target = safeJoin(destDir, entry.path);
    if (!target) {
      skipped.push(entry.path);
      continue;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    let actualEntrySize = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        actualEntrySize += chunk.length;
        actualTotalSize += chunk.length;
        if (actualEntrySize > MAX_ENTRY_SIZE || actualTotalSize > MAX_EXTRACTED_SIZE) {
          callback(archiveError('ZIP_TOO_LARGE', '压缩包解压后的大小超过限制'));
        } else {
          callback(null, chunk);
        }
      }
    });
    await pipeline(entry.stream(), limiter, fs.createWriteStream(target, { flags: 'wx' }));
    written++;
  }

  return { written, skipped, extractedSize: actualTotalSize };
}

async function walkFiles(dir, base = dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }

  return out;
}

async function hasRootIndex(dir) {
  try {
    const stat = await fsp.stat(path.join(dir, 'index.html'));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function flattenSingleRoot(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const visible = entries.filter((entry) => entry.name !== '__MACOSX' && !entry.name.startsWith('.'));
  if (visible.length !== 1 || !visible[0].isDirectory()) return null;

  const inner = path.join(dir, visible[0].name);
  if (!(await hasRootIndex(inner))) return null;

  for (const child of await fsp.readdir(inner)) {
    await fsp.rename(path.join(inner, child), path.join(dir, child));
  }
  await fsp.rmdir(inner);
  return visible[0].name;
}

module.exports = {
  safeJoin,
  extractZip,
  walkFiles,
  hasRootIndex,
  flattenSingleRoot,
  MAX_ENTRIES,
  MAX_ENTRY_SIZE,
  MAX_EXTRACTED_SIZE,
  MAX_COMPRESSION_RATIO
};
