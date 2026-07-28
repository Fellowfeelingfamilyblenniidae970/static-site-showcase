'use strict';

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { createZipBuffer } = require('./zip');

try {
  const zip = createZipBuffer(workerData.directory);
  fs.writeFileSync(workerData.outputPath, zip, { flag: 'wx', mode: 0o600 });
  parentPort.postMessage({ ok: true, size: zip.length });
} catch (error) {
  try { fs.rmSync(workerData.outputPath, { force: true }); } catch {}
  parentPort.postMessage({
    ok: false,
    error: {
      code: error.code || 'ZIP_BUILD_FAILED',
      message: error.message || '压缩包生成失败'
    }
  });
}
