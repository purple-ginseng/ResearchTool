#!/usr/bin/env node
/* Generates zh/index.html, the static Simplified Chinese project page, from index.html, and keeps the FAQPage
 * JSON-LD of index.html in step with its visible FAQ. No dependencies; Node 18 or newer.
 *
 * HOW TO RE-RUN: after ANY change to index.html, run from the site folder (the gh-pages checkout)
 *
 *   node scripts/build-zh.mjs           sync the FAQ JSON-LD in index.html, then write zh/index.html
 *   node scripts/build-zh.mjs --check   change nothing; exit 1 if index.html's FAQ JSON-LD or zh/index.html is stale
 *   add --strict                        also fail on English text that has neither data-zh nor translate="no"
 *
 * and commit index.html and zh/index.html together. Never edit zh/index.html by hand.
 *
 * index.html is the single source of truth: English content plus the Chinese text in
 *   data-zh="..."        -> replaces the element's inner HTML on the Chinese page
 *   data-zh-<attr>="..." -> replaces (or adds) attribute <attr>; the value is written as seen from zh/ and is used as-is
 * Every other relative URL (src, href, srcset, poster, data-zoom) gets a ../ prefix, so zh/ shares the English page's
 * assets. Canonical and og:url point to /zh/, <html> gets lang="zh-CN" data-lang="zh" data-base="../", and the
 * 中文 link of the EN / 中文 switch becomes the current page.
 *
 * JSON-LD: the FAQPage block (<script id="ld-faq">) is rebuilt from each page's own <details> in #faq, so the
 * structured data always says what the visible FAQ says. In the main graph (<script id="ld-main">) the Chinese page
 * gets its own WebPage node (zh/ url, Chinese name) and the Chinese SoftwareApplication texts from ZH_LD below; keep
 * ZH_LD in step when the English description, featureList or screenshots change (the build fails on a count mismatch).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(SITE, 'index.html');
const OUT = join(SITE, 'zh', 'index.html');
const BASE_URL = 'https://purple-ginseng.github.io/ResearchTool/';
const ZH_URL = BASE_URL + 'zh/';
const URL_ATTRS = new Set(['src', 'href', 'srcset', 'poster', 'data-zoom']);

/* Chinese texts of the SoftwareApplication node; same order as the English ones in index.html. */
const ZH_LD = {
  description: '免费开源（MIT）的科研工作区，运行在你自己的电脑上：带 PDF 阅读器、高亮和 Markdown 阅读笔记的文献库，查看论文之间关系的工具，以及带实时 PDF 预览、类似 Overleaf 的 LaTeX 编辑器。AI 功能可选，通过你自己的 Claude Code、OpenAI Codex、xAI Grok Build 或 Google Antigravity 命令行运行。',
  applicationSubCategory: '文献管理、PDF 阅读器与 LaTeX 编辑器',
  softwareRequirements: 'Node.js 18 或更新版本。可选：poppler（导入 PDF、找出图表）、latexmk 加 MacTeX、TeX Live 或 MiKTeX（编译）、git（Overleaf 同步）、一个 AI 命令行工具：Claude Code、OpenAI Codex、xAI Grok Build（不支持 Windows）或 Google Antigravity',
  featureList: [
    '文献库：导入 PDF、文件夹和 .bib（BibTeX）文件，或粘贴 arXiv ID、DOI 和 OpenReview 链接',
    '重复检测、标签、阅读状态和可嵌套的研究方向',
    '全文搜索 PDF、笔记和要点，支持中文',
    'PDF 阅读器：搜索、目录、可点击的内部链接和彩色高亮',
    'Markdown 阅读笔记：公式、图片、视频和版本历史',
    '句子级要点，每条都链接到 PDF 对应页',
    '在本机根据 PDF 版面找出图和表',
    '相关论文和发展脉络，数据来自 OpenAlex 和 Semantic Scholar',
    '用 Crossref、DBLP、OpenAlex、Semantic Scholar、PMLR 和 arXiv 核对发表出处',
    '类似 Overleaf 的 LaTeX 编辑器：latexmk 实时 PDF 预览、双向 SyncTeX',
    '从文献库引用；references.bib 只包含项目实际引用的条目',
    '保存和自动保存的版本，可逐行对比差异并恢复',
    '可选：通过 Overleaf 的 Git 集成同步',
    '可选 AI 功能：通过你自己的 Claude Code、OpenAI Codex、xAI Grok Build 或 Google Antigravity 命令行',
    '英文和简体中文界面，浅色和深色主题',
    '只在 127.0.0.1 上运行；无需账号，无统计',
  ],
  screenshotCaptions: [
    '概览：继续阅读、待复习的题目和阅读统计',
    '按研究方向整理的文献库',
    'PDF 与 Markdown 阅读笔记并排',
    '发展脉络：一个研究方向所依托的前人工作',
    '实时预览 PDF 的 LaTeX 编辑器',
  ],
};

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const LD = /(<script type="application\/ld\+json" id="(ld-main|ld-faq)">)([\s\S]*?)(<\/script>)/g;

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|nbsp);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' }[k];
});
const isRelative = (u) => u !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(u);
const rebase = (name, v) => name === 'srcset'
  ? v.split(',').map((part) => { const p = part.trim(); return isRelative(p) ? '../' + p : p; }).join(', ')
  : (isRelative(v) ? '../' + v : v);

function parseAttrs(s) {
  const out = []; let m; ATTR.lastIndex = 0;
  while ((m = ATTR.exec(s))) out.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
  return out;
}
const serialize = (attrs) => attrs.map(([k, v]) => (v === null ? ' ' + k : ` ${k}="${v}"`)).join('');

/* ---------------------------------------------------------------- JSON-LD helpers */
/* Visible text: block tags become a space, inline tags (code, a, strong ...) vanish without one. */
const text = (h) => decode(h.replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6])\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, ''))
  .replace(/\s+/g, ' ').replace(/([。！？；：」）])\s+(?=[^\x00-\x7F])/g, '$1').trim();
function faqFrom(page, url, lang) {
  const at = page.indexOf('id="faq"');
  const section = (at < 0 ? '' : page.slice(at, page.indexOf('</section>', at)))
    .replace(/\sdata-zh(?:-[\w-]+)?="[^"]*"/g, '');                   // the Chinese text of the English page is not visible
  const mainEntity = [...section.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map(([, q, a]) => ({ '@type': 'Question', name: text(q), acceptedAnswer: { '@type': 'Answer', text: text(a) } }));
  return { '@context': 'https://schema.org', '@type': 'FAQPage', '@id': url + '#faq', url, inLanguage: lang, mainEntity };
}
const formatFaq = (o) => '\n' + JSON.stringify(o, null, 1) + '\n';
const formatGraph = (o) => '\n{"@context":' + JSON.stringify(o['@context']) + ',"@graph":[\n'
  + o['@graph'].map((n) => JSON.stringify(n)).join(',\n') + '\n]}\n';

function zhGraph(body, page, problems) {
  const data = JSON.parse(body);
  const title = text((page.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1]);
  for (const n of data['@graph'] || []) {
    if (n['@type'] === 'WebPage') {
      Object.assign(n, { '@id': ZH_URL + '#webpage', url: ZH_URL, name: title, inLanguage: 'zh-CN' });
    } else if (n['@type'] === 'SoftwareApplication') {
      if ((n.featureList || []).length !== ZH_LD.featureList.length) problems.push(`featureList has ${(n.featureList || []).length} English and ${ZH_LD.featureList.length} Chinese items: update ZH_LD`);
      if ((n.screenshot || []).length !== ZH_LD.screenshotCaptions.length) problems.push('screenshot count differs from ZH_LD.screenshotCaptions: update ZH_LD');
      n.description = ZH_LD.description;
      n.applicationSubCategory = ZH_LD.applicationSubCategory;
      n.softwareRequirements = ZH_LD.softwareRequirements;
      n.featureList = ZH_LD.featureList;
      (n.screenshot || []).forEach((s, i) => { if (ZH_LD.screenshotCaptions[i]) s.caption = ZH_LD.screenshotCaptions[i]; });
      if (n.installUrl) n.installUrl = n.installUrl.replace(BASE_URL + '#', ZH_URL + '#');
    }
  }
  return formatGraph(data);
}

/* ---------------------------------------------------------------- the English page: FAQ JSON-LD from the visible FAQ */
export function syncEnglish(src) {
  return src.replace(LD, (all, open, id, body, close) => (id === 'ld-faq' ? open + formatFaq(faqFrom(src, BASE_URL, 'en')) + close : all));
}

/* ---------------------------------------------------------------- the Chinese page */
export function buildZh(src) {
  let out = '', i = 0, m;
  const problems = [], warnings = [];
  const stack = [];                                                   // open elements: [name, exempt]
  const SKIP = new Set(['svg', 'code', 'kbd', 'time', 'title']);
  TAG.lastIndex = 0;
  while ((m = TAG.exec(src))) {
    const between = src.slice(i, m.index);
    if (/[A-Za-z]{3}/.test(between.replace(/<!doctype[^>]*>/i, '')) && !stack.some((f) => f[1])) {   // English text with no Chinese version
      const line = src.slice(0, m.index).split('\n').length;
      warnings.push(`line ${line}: English text without data-zh (or translate="no"): "${between.trim().replace(/\s+/g, ' ').slice(0, 60)}"`);
    }
    out += between; i = TAG.lastIndex;
    const [whole, close, rawName, attrStr, selfClose] = m;
    if (!rawName) { out += whole; continue; }                         // comment
    if (close) {
      const n = rawName.toLowerCase(), at = stack.map((f) => f[0]).lastIndexOf(n);
      if (at >= 0) stack.length = at;
      out += whole; continue;
    }
    const name = rawName.toLowerCase();
    let attrs = parseAttrs(attrStr);
    const get = (k) => (attrs.find((a) => a[0] === k) || [])[1];
    const zhInner = get('data-zh');
    if (!VOID.has(name) && !selfClose && !RAW.has(name) && zhInner === undefined) {
      const parentExempt = stack.length && stack[stack.length - 1][1];
      stack.push([name, parentExempt || SKIP.has(name) || (get('lang') !== undefined && name !== 'html') || get('translate') === 'no']);
    }

    // 1. data-zh-<attr> overrides; everything else relative gets ../
    const overrides = new Map(attrs.filter(([k]) => k.startsWith('data-zh-')).map(([k, v]) => [k.slice(8), v]));
    attrs = attrs.filter(([k]) => k !== 'data-zh' && !k.startsWith('data-zh-'))
      .map(([k, v]) => [k, overrides.has(k) ? overrides.get(k) : (URL_ATTRS.has(k) && v !== null ? rebase(k, v) : v)]);
    for (const [k, v] of overrides) if (!attrs.some((a) => a[0] === k)) attrs.push([k, v]);

    // 2. page-level specifics
    if (name === 'html') {
      attrs = attrs.filter(([k]) => !['lang', 'data-lang', 'data-base'].includes(k));
      attrs.unshift(['lang', 'zh-CN'], ['data-lang', 'zh'], ['data-base', '../']);
    }
    if (get('data-set-lang') !== undefined) {                        // current-language marker
      attrs = attrs.filter(([k]) => k !== 'aria-current');
      if (get('data-set-lang') === 'zh') attrs.push(['aria-current', 'page']);
    }
    if (name === 'meta' && get('property') === 'og:url') attrs = attrs.map(([k, v]) => [k, k === 'content' ? ZH_URL : v]);
    if (name === 'link' && get('rel') === 'canonical') attrs = attrs.map(([k, v]) => [k, k === 'href' ? ZH_URL : v]);

    const tag = `<${rawName}${serialize(attrs)}${selfClose ? '/' : ''}>`;
    out += tag === `<${rawName}${serialize(parseAttrs(attrStr))}${selfClose ? '/' : ''}>` ? whole : tag;   // untouched tags stay byte-identical

    // 3. raw text elements: copy their body (JSON-LD is patched below)
    if (RAW.has(name) && !selfClose) {
      const end = src.toLowerCase().indexOf(`</${name}`, i);
      out += src.slice(i, end); i = end; TAG.lastIndex = end;
      continue;
    }
    // 4. data-zh: skip the English inner HTML up to the matching end tag
    if (zhInner !== undefined && zhInner !== null && !VOID.has(name) && !selfClose) {
      let depth = 1, n;
      const same = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, 'gi');
      same.lastIndex = i;
      while (depth && (n = same.exec(src))) depth += n[1] ? -1 : 1;
      if (depth) { problems.push(`unclosed <${name}> with data-zh near offset ${m.index}`); continue; }
      out += decode(zhInner);
      i = n.index; TAG.lastIndex = n.index;
    }
  }
  out += src.slice(i);
  out = out.replace(LD, (all, open, id, body, close) => {
    try {
      return open + (id === 'ld-faq' ? formatFaq(faqFrom(out, ZH_URL, 'zh-CN')) : zhGraph(body, out, problems)) + close;
    } catch (e) { problems.push(`JSON-LD ${id}: ${e.message}`); return all; }
  });
  out = out.replace(/^(<!doctype html>\s*)/i, '$1<!-- Generated by scripts/build-zh.mjs from ../index.html. Do not edit: change index.html (data-zh attributes) and run node scripts/build-zh.mjs. -->\n');
  return { html: out, problems, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const original = readFileSync(SRC, 'utf8');
  const src = syncEnglish(original);
  const { html, problems, warnings } = buildZh(src);
  warnings.forEach((w) => console.warn('build-zh: warning: ' + w));
  problems.forEach((p) => console.error('build-zh: ' + p));
  if (problems.length || (warnings.length && process.argv.includes('--strict'))) process.exit(2);
  if (check) {
    const faqOk = src === original;
    const zhOk = existsSync(OUT) && readFileSync(OUT, 'utf8') === html;
    if (!faqOk) console.log('index.html: the FAQPage JSON-LD does not match the visible FAQ');
    console.log(zhOk ? 'zh/index.html is up to date' : 'zh/index.html is out of date');
    if (!faqOk || !zhOk) { console.log('run: node scripts/build-zh.mjs'); process.exit(1); }
    process.exit(0);
  }
  if (src !== original) { writeFileSync(SRC, src); console.log('updated the FAQPage JSON-LD in index.html'); }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);
  console.log('wrote zh/index.html');
}
