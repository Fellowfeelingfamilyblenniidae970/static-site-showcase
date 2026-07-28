const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, escapeHtml } = require('../lib/markdown');

test('XSS：完整原文先转义，输出不发生变异', () => {
  const payload = '# <script>alert(1)</script>\n\n<img src=x onerror=alert(1)> "quoted" & <b>raw</b>';
  const { contentHtml, toc } = renderMarkdown(payload);
  assert.ok(!contentHtml.includes('<script>'), '不得出现可执行 script 标签');
  assert.ok(!contentHtml.includes('<img'), '不得出现原始 img 标签');
  assert.ok(!/<[a-zA-Z]/.test(contentHtml.replace(/<h1 id="[^"]*">|<\/h1>|<p>|<\/p>/g, '')), '除受控标签外不得出现原始 HTML 标签');
  assert.ok(contentHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(contentHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(contentHtml.includes('&quot;quoted&quot; &amp; &lt;b&gt;raw&lt;/b&gt;'));
  assert.equal(toc[0].text, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(toc[0].id, 'scriptalert1script');
});

test('标题渲染：#-### 生成稳定锚点并收集目录', () => {
  const md = '# Hello World\n\n## 第二章 小节\n\n### Deep Dive\n\n#### 不支持的级别\n\n# Hello World';
  const { contentHtml, toc } = renderMarkdown(md);
  assert.ok(contentHtml.includes('<h1 id="hello-world">Hello World</h1>'));
  assert.ok(contentHtml.includes('<h2 id="第二章-小节">第二章 小节</h2>'));
  assert.ok(contentHtml.includes('<h3 id="deep-dive">Deep Dive</h3>'));
  // 重复标题锚点去重，保持稳定
  assert.ok(contentHtml.includes('<h1 id="hello-world-2">Hello World</h1>'));
  // #### 不在受控子集内，按段落处理
  assert.ok(contentHtml.includes('<p>#### 不支持的级别</p>'));
  assert.deepEqual(toc, [
    { level: 1, id: 'hello-world', text: 'Hello World' },
    { level: 2, id: '第二章-小节', text: '第二章 小节' },
    { level: 3, id: 'deep-dive', text: 'Deep Dive' },
    { level: 1, id: 'hello-world-2', text: 'Hello World' }
  ]);
});

test('列表：ul 与 ol 正确渲染，行内元素在列表项中生效', () => {
  const md = '- 第一项\n- 第二项 **加粗**\n\n1. one\n2. two `code`';
  const { contentHtml } = renderMarkdown(md);
  assert.ok(contentHtml.includes('<ul>\n<li>第一项</li>\n<li>第二项 <strong>加粗</strong></li>\n</ul>'));
  assert.ok(contentHtml.includes('<ol>\n<li>one</li>\n<li>two <code>code</code></li>\n</ol>'));
});

test('代码块：输出 Prism 可用 language class，内容不再解析行内语法', () => {
  const md = '```javascript\nconst a = "<b>";\n**not bold** `not code`\n```\n\n```\nplain <tag>\n```';
  const { contentHtml } = renderMarkdown(md);
  assert.ok(contentHtml.includes('<pre><code class="language-javascript">'));
  assert.ok(contentHtml.includes('const a = &quot;&lt;b&gt;&quot;;'));
  assert.ok(contentHtml.includes('**not bold** `not code`'), '代码块内不得解析行内语法');
  assert.ok(contentHtml.includes('<pre><code class="language-plaintext">plain &lt;tag&gt;</code></pre>'));
});

test('行内元素：code、粗体与段落', () => {
  const md = '这是 `let x = 1;` 行内代码，以及 **重要** 内容。\n同段落第二行。';
  const { contentHtml } = renderMarkdown(md);
  assert.ok(contentHtml.includes('<p>这是 <code>let x = 1;</code> 行内代码，以及 <strong>重要</strong> 内容。\n同段落第二行。</p>'));
});

test('链接协议白名单：仅放行 http/https/mailto', () => {
  const md = [
    '[官网](https://example.com?a=1&b=2)',
    '[镜像](http://example.com)',
    '[邮件](mailto:test@example.com)',
    '[注入](javascript:alert(1))',
    '[伪装](JaVaScRiPt:alert(1))',
    '[相对](/local/path)',
    '[数据](data:text/html,<script>alert(1)</script>)'
  ].join('\n\n');
  const { contentHtml } = renderMarkdown(md);
  assert.ok(contentHtml.includes('<a href="https://example.com?a=1&amp;b=2" rel="noopener noreferrer">官网</a>'));
  assert.ok(contentHtml.includes('<a href="http://example.com" rel="noopener noreferrer">镜像</a>'));
  assert.ok(contentHtml.includes('<a href="mailto:test@example.com" rel="noopener noreferrer">邮件</a>'));
  assert.ok(!/href="javascript:/i.test(contentHtml), 'javascript: 协议必须被拒绝');
  assert.ok(!/href="data:/i.test(contentHtml), 'data: 协议必须被拒绝');
  assert.ok(!contentHtml.includes('href="/local/path"'), '相对路径不在白名单内');
  assert.ok(contentHtml.includes('[注入](javascript:alert(1))'), '被拒绝的链接按原文本输出');
  assert.ok(contentHtml.includes('[伪装](JaVaScRiPt:alert(1))'));
});

test('空输入与空标题兜底', () => {
  assert.deepEqual(renderMarkdown(''), { contentHtml: '', toc: [] });
  const { contentHtml, toc } = renderMarkdown('# !!!');
  assert.ok(contentHtml.includes('<h1 id="section">!!!</h1>'));
  assert.equal(toc[0].id, 'section');
});

test('escapeHtml 覆盖全部危险字符', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
