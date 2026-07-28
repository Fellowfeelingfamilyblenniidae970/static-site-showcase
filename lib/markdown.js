'use strict';

/**
 * 安全的 Markdown 受控子集渲染器。
 *
 * 安全策略：先对完整 Markdown 原文做 HTML 转义，再在转义后的文本上
 * 解析受控语法（标题 / 段落 / 列表 / 代码块 / 行内 code / 粗体 / 链接）。
 * 链接仅允许 http:、https:、mailto: 协议，其余（如 javascript:）按普通
 * 文本原样输出，绝不生成可执行属性。
 *
 * 零依赖，仅使用 Node 内置能力。
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_LINK_PROTOCOL = /^(https?:|mailto:)/i;
const FENCE_RE = /^```([A-Za-z0-9_+#-]*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const UL_ITEM_RE = /^\s*[-*]\s+(.+)$/;
const OL_ITEM_RE = /^\s*\d{1,9}[.)]\s+(.+)$/;

function slugify(text) {
  const slug = text
    .toLowerCase()
    .replace(/&(?:amp|lt|gt|quot|#39);/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug || 'section';
}

function uniqueSlug(text, used) {
  const base = slugify(text);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  const slug = `${base}-${index}`;
  used.add(slug);
  return slug;
}

/** 去除行内标记，得到标题的纯文本（用于锚点与目录）。 */
function plainText(escaped) {
  return escaped
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/[`*]/g, '');
}

function renderLinkSafeSegment(segment) {
  let out = segment.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    if (ALLOWED_LINK_PROTOCOL.test(url)) {
      return `<a href="${url}" rel="noopener noreferrer">${label}</a>`;
    }
    return match;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

/** 在已转义文本上渲染行内元素：行内 code、链接、粗体。 */
function renderInline(escaped) {
  return escaped
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return renderLinkSafeSegment(part);
    })
    .join('');
}

function startsBlock(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    UL_ITEM_RE.test(line) ||
    OL_ITEM_RE.test(line)
  );
}

/**
 * 渲染 Markdown 受控子集。
 * @param {string} markdown 原始 Markdown 文本
 * @returns {{ contentHtml: string, toc: Array<{ level: number, id: string, text: string }> }}
 */
function renderMarkdown(markdown) {
  const escaped = escapeHtml(markdown == null ? '' : markdown);
  const lines = escaped.split(/\r?\n/);
  const html = [];
  const toc = [];
  const usedSlugs = new Set();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const language = fence[1] ? fence[1].toLowerCase() : 'plaintext';
      const codeLines = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过闭合围栏
      html.push(`<pre><code class="language-${language}">${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      const text = plainText(heading[2]);
      const id = uniqueSlug(text, usedSlugs);
      toc.push({ level, id, text });
      html.push(`<h${level} id="${id}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (UL_ITEM_RE.test(line)) {
      const items = [];
      while (i < lines.length && UL_ITEM_RE.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].match(UL_ITEM_RE)[1])}</li>`);
        i += 1;
      }
      html.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }

    if (OL_ITEM_RE.test(line)) {
      const items = [];
      while (i < lines.length && OL_ITEM_RE.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].match(OL_ITEM_RE)[1])}</li>`);
        i += 1;
      }
      html.push(`<ol>\n${items.join('\n')}\n</ol>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }

  return { contentHtml: html.join('\n'), toc };
}

module.exports = { renderMarkdown, escapeHtml };
