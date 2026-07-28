const path = require('path');
const fs = require('fs').promises;

const MAX_FILES = 300;
const MAX_DEPTH = 8;
const MAX_FILE_SIZE = 512 * 1024;
const ALLOWED_EXTENSIONS = new Map([
  ['.html', 'html'], ['.htm', 'html'], ['.css', 'css'], ['.scss', 'scss'],
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.jsx', 'javascript'],
  ['.json', 'json'], ['.md', 'markdown'], ['.txt', 'plaintext'],
  ['.svg', 'xml'], ['.xml', 'xml'], ['.yml', 'yaml'], ['.yaml', 'yaml']
]);
const BLOCKED_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
]);
const BLOCKED_EXTENSIONS = new Set([
  '.map', '.pem', '.key', '.crt', '.cer', '.p12', '.pfx', '.jks', '.keystore'
]);

function sourceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw sourceError('INVALID_PATH', '无效的文件路径');
  }

  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw sourceError('INVALID_PATH', '无效的文件路径');
  }

  const clean = path.posix.normalize(normalized);
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) {
    throw sourceError('INVALID_PATH', '无效的文件路径');
  }

  return clean;
}

function inspectPath(relativePath) {
  const clean = normalizeSourcePath(relativePath);
  const segments = clean.split('/');
  const fileName = segments.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);

  if (segments.length > MAX_DEPTH || segments.some((segment) => segment.startsWith('.'))) {
    return { allowed: false, clean };
  }
  if (BLOCKED_NAMES.has(fileName) || BLOCKED_EXTENSIONS.has(extension)) {
    return { allowed: false, clean };
  }

  const language = ALLOWED_EXTENSIONS.get(extension);
  return { allowed: Boolean(language), clean, language };
}

async function resolveSourceFile(siteRoot, relativePath) {
  const inspected = inspectPath(relativePath);
  if (!inspected.allowed) throw sourceError('FILE_NOT_ALLOWED', '该文件不可展示', 403);

  const root = await fs.realpath(siteRoot);
  const candidate = path.resolve(root, ...inspected.clean.split('/'));
  const candidateStat = await fs.lstat(candidate).catch(() => null);
  if (!candidateStat) throw sourceError('FILE_NOT_FOUND', '文件不存在', 404);
  if (candidateStat.isSymbolicLink()) throw sourceError('FILE_NOT_ALLOWED', '该文件不可展示', 403);

  const real = await fs.realpath(candidate);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw sourceError('FILE_NOT_FOUND', '文件不存在', 404);
  }

  const stat = await fs.lstat(real);
  if (!stat.isFile()) {
    throw sourceError('FILE_NOT_ALLOWED', '该文件不可展示', 403);
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw sourceError('FILE_TOO_LARGE', '文件过大，无法在线展示', 413);
  }

  return { real, size: stat.size, path: inspected.clean, language: inspected.language };
}

async function listSourceFiles(siteRoot) {
  const files = [];

  async function visit(dir, relativeDir = '', depth = 0) {
    if (depth >= MAX_DEPTH || files.length >= MAX_FILES) return;

    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= MAX_FILES || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await visit(full, relative, depth + 1);
      } else if (entry.isFile()) {
        const inspected = inspectPath(relative);
        if (!inspected.allowed) continue;
        const stat = await fs.stat(full);
        if (stat.size <= MAX_FILE_SIZE) {
          files.push({ path: inspected.clean, language: inspected.language, size: stat.size });
        }
      }
    }
  }

  await visit(siteRoot);
  files.sort((a, b) => {
    if (a.path === 'index.html') return -1;
    if (b.path === 'index.html') return 1;
    return a.path.localeCompare(b.path);
  });
  return files;
}

async function readSourceFile(siteRoot, relativePath) {
  const file = await resolveSourceFile(siteRoot, relativePath);
  const buffer = await fs.readFile(file.real);
  if (buffer.includes(0)) throw sourceError('BINARY_FILE', '二进制文件不可展示', 415);
  return { path: file.path, language: file.language, size: file.size, content: buffer.toString('utf8') };
}

module.exports = {
  listSourceFiles,
  readSourceFile,
  normalizeSourcePath,
  inspectPath,
  MAX_FILES,
  MAX_DEPTH,
  MAX_FILE_SIZE
};
