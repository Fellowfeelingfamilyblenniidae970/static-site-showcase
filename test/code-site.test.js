const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCodeSite, MAX_CODE_FILE_SIZE } = require('../lib/code-site');

function upload(value) {
  return { data: Buffer.isBuffer(value) ? value : Buffer.from(value) };
}

test('HTML 片段生成完整站点并转义标题', () => {
  const files = buildCodeSite({
    html: upload('<main>你好</main>'),
    css: upload('body { color: red; }'),
    javascript: upload('document.body.dataset.ready = "1";')
  }, '标题 <测试>');

  assert.deepEqual(Object.keys(files), ['index.html', 'style.css', 'script.js']);
  assert.match(files['index.html'], /^<!doctype html>/);
  assert.match(files['index.html'], /<meta charset="UTF-8">/);
  assert.match(files['index.html'], /<title>标题 &lt;测试&gt;<\/title>/);
  assert.match(files['index.html'], /<link rel="stylesheet" href="style\.css">/);
  assert.match(files['index.html'], /<main>你好<\/main>/);
  assert.match(files['index.html'], /<script src="script\.js"><\/script>/);
  assert.equal(files['style.css'], 'body { color: red; }');
  assert.equal(files['script.js'], 'document.body.dataset.ready = "1";');
});

test('带 doctype 的 HTML 片段仍补齐文档结构', () => {
  const files = buildCodeSite({ html: upload('<!doctype html><main>Fragment</main>') }, 'Fragment');
  assert.match(files['index.html'], /^<!doctype html>\n<html lang="zh-CN">/);
  assert.match(files['index.html'], /<!doctype html><main>Fragment<\/main>/);
});

test('完整 HTML 保持内容并不重复直接引用', () => {
  const html = '<!doctype html><html><head><link href="./style.css?v=1" rel="stylesheet"></head><body><h1>Site</h1><script src="script.js#ready"></script></body></html>';
  const files = buildCodeSite({ html: upload(html), css: upload('h1{}'), javascript: upload('ready()') }, 'Site');
  assert.equal((files['index.html'].match(/style\.css/g) || []).length, 1);
  assert.equal((files['index.html'].match(/script\.js/g) || []).length, 1);
  assert.match(files['index.html'], /<h1>Site<\/h1>/);
});

test('嵌套、根绝对和外部同名资源不冒充生成文件', () => {
  const html = '<html><head><link rel=stylesheet href=assets/style.css><link rel=stylesheet href=https://cdn.example/style.css></head><body><script src=/script.js></script><script src=assets/script.js></script></body></html>';
  const files = buildCodeSite({ html: upload(html), css: upload('body{}'), javascript: upload('ready()') }, 'Site', '/sites/site-id/');
  assert.match(files['index.html'], /href="style\.css"/);
  assert.match(files['index.html'], /src="script\.js"/);
  assert.equal((files['index.html'].match(/style\.css/g) || []).length, 3);
  assert.equal((files['index.html'].match(/script\.js/g) || []).length, 3);
});

test('base 元素存在时使用当前页面 URL 加载生成资源', () => {
  const html = '<html><head><base href="https://assets.example/"></head><body>Site</body></html>';
  const files = buildCodeSite({ html: upload(html), css: upload('body{}'), javascript: upload('ready()') }, 'Site', '/sites/site-id/');
  assert.equal((files['index.html'].match(/new URL\("style\.css",location\.href\)/g) || []).length, 1);
  assert.equal((files['index.html'].match(/new URL\("script\.js",location\.href\)/g) || []).length, 1);
});

test('注释和脚本字符串中的伪标签不影响资源插入', () => {
  const html = '<html><head><!-- <link rel="stylesheet" href="style.css"> --></head><body><script>const closing = "</body>";</script><p>Site</p></body></html>';
  const files = buildCodeSite({ html: upload(html), css: upload('body{}'), javascript: upload('ready()') }, 'Site');
  assert.match(files['index.html'], /<\/script><p>Site<\/p>\n  <script src="script\.js"><\/script><\/body>/);
  assert.match(files['index.html'], /<\/head>/);
});

test('完整 HTML 在缺少 head 或 body 结束标签时仍补充资源', () => {
  const files = buildCodeSite({
    html: upload('<html><main>Site</main></html>'),
    css: upload('main{}'),
    javascript: upload('ready()')
  }, 'Site');
  assert.match(files['index.html'], /<head>\s*<link rel="stylesheet" href="style\.css">\s*<\/head>/);
  assert.match(files['index.html'], /<script src="script\.js"><\/script>\s*<\/html>/);
});

test('显式但未闭合的 body 在正文末尾追加脚本', () => {
  const files = buildCodeSite({
    html: upload('<html><head></head><body><main>Site</main>'),
    javascript: upload('document.querySelector("main").remove()')
  }, 'Site');
  assert.match(files['index.html'], /<main>Site<\/main>\n  <script src="script\.js"><\/script>$/);
});

test('代码生成器拒绝空 HTML、重复字段、额外字段、NUL、无效 UTF-8 和超限内容', () => {
  assert.throws(() => buildCodeSite({}, 'Empty'), /请粘贴 HTML/);
  assert.throws(() => buildCodeSite({ html: [upload('one'), upload('two')] }, 'Duplicate'), /只能提交一次/);
  assert.throws(() => buildCodeSite({ html: upload('ok'), asset: upload('bad') }, 'Extra'), /不支持的文件字段/);
  assert.throws(() => buildCodeSite({ html: upload(Buffer.from([65, 0, 66])) }, 'NUL'), /NUL/);
  assert.throws(() => buildCodeSite({ html: upload(Buffer.from([0xc3, 0x28])) }, 'UTF8'), /UTF-8/);
  assert.throws(() => buildCodeSite({ html: upload(Buffer.alloc(MAX_CODE_FILE_SIZE + 1, 65)) }, 'Large'), (error) => error.status === 413);
});
