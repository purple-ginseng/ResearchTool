#!/usr/bin/env node
/* The automated checks of the project page. No dependencies; Node 18 or newer. Run from the site folder (the gh-pages checkout):
 *
 *   node scripts/check-site.mjs            every check; prints one line per check, then the page weight; exit 1 if any check fails
 *   node scripts/check-site.mjs --quiet    only the failures and the weight table
 *
 * Run it after ANY change to index.html, css/site.css, js/site.js or the files they load, after `node scripts/build-zh.mjs`,
 * and before committing. Nothing is fetched and nothing is written.
 *
 * What it checks, on the three pages index.html (/), zh/index.html (/zh/) and 404.html:
 *
 *   links        every local href, src, srcset, poster, data-zoom, every url() of css/site.css, every 'img/…' or 'media/…' path in
 *                js/site.js and every URL of this site in the meta tags, the JSON-LD and sitemap.xml points to a file that exists;
 *                every #fragment points to an id of its page
 *   sprite       every <use href="#id"> (and every '#id' that js/site.js swaps in) has its <symbol>; no <symbol> is left unused;
 *                apart from i-github every symbol is a Margin Sketch drawing: only <path class="sk-…"> with a rule in css/site.css,
 *                and none of its path data is path data of the line-drawn sprite it replaced (commit 0f55540; the fingerprints
 *                are in OLD_SPRITE below, and `git show 0f55540:index.html` is read as well when git has that commit);
 *                the i-github symbol is still byte for byte the one of that commit. The comparison is pinned to that commit
 *                and not to HEAD, because once the redrawn sprite is committed HEAD holds the new drawings
 *   sketch CSS   the rules of css/site.css the drawings cannot do without: the GitHub mark is a line (#i-github path has no fill
 *                and a stroke in the text colour), an icon takes the text colour (.icon sets --sk-ink), every --sk-* token that is
 *                used is defined, the dark grounds (.band-dark, .oss) have their own ink, every class of the sprite has a fill;
 *                the wipe-in and every hidden state of the reveal sit inside prefers-reduced-motion: no-preference (or are undone
 *                under prefers-reduced-motion: reduce), and a lazy drawing waits for its reveal with opacity, never clipped away
 *                (it would not be fetched ahead); a size in container units that also holds var() sits inside @supports;
 *                the plates and the journey tiles keep their ground in forced-colours mode
 *   ids, h1      no id is used twice on a page; each page has exactly one <h1>
 *   JSON-LD      every block parses; the main graph (#ld-main) of / and /zh/ still holds a WebSite, WebPage, Person,
 *                SoftwareApplication, SoftwareSourceCode and VideoObject node; the FAQPage block (#ld-faq) of each page says what
 *                its visible FAQ says, question by question
 *   languages    <html lang>, the canonical link, og:url and the hreflang links of / and /zh/ point where they should, both ways;
 *                each of the two pages has a title, a description and one non-empty og:title, og:description, og:image, og:type
 *                and twitter:card; sitemap.xml lists both pages with the same alternates
 *   zh           zh/index.html is what scripts/build-zh.mjs would write now, and nothing is left untranslated (--check --strict)
 *   no CDN       nothing is loaded from another host: scripts, styles, fonts, images, and nothing inside the SVG files. No inline
 *                script, event handler, style sheet or style attribute, and neither css/site.css nor js/site.js, holds the address
 *                of another host at all (comments apart), so a load that only starts at run time is caught as well. The one
 *                exception is the CI status badge of the open-source card (ALLOWED_EXTERNAL): lazy, no referrer, text fallback
 *   images       every <img> that has a src, and every <video>, has width and height; for local files the two have the
 *                proportions of the file itself (so nothing jumps when it loads); every <img> has an alt attribute
 *   plates       every illustration box is either decorative (aria-hidden="true") or an image with a description (role="img" plus
 *                an aria-label, or an aria-labelledby that leads to a text; in Chinese on /zh/); its aspect-ratio is the one of
 *                its drawing, so the drawing is not stretched under its labels; every label (.lbl) sits on the sheet; every icon
 *                (an <svg> with a <use>) and the sprite itself are hidden from assistive technology, or have a name of their own;
 *                every file in img/sketch/ is used
 *   weight       what each page loads, raw and as sent (gzip for text), against the budgets in BUDGET below; no file of
 *                img/sketch/ over its own cap
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = 'https://purple-ginseng.github.io/ResearchTool/';
const BASE_PATH = new URL(BASE_URL).pathname;                      // /ResearchTool/
const PAGES = [
  { file: 'index.html', url: BASE_URL, lang: 'en' },
  { file: 'zh/index.html', url: BASE_URL + 'zh/', lang: 'zh-CN' },
  { file: '404.html', url: null, lang: 'en' },
];
/* The only resource the page may load from another host (see "no CDN" above). */
const ALLOWED_EXTERNAL = ['https://github.com/purple-ginseng/ResearchTool/actions/workflows/ci.yml/badge.svg'];
/* Budgets in bytes. "sent" = gzip for text (HTML, CSS, JS, SVG), the file size for everything else. Raise one only on purpose. */
const BUDGET = {
  html: 205_000,          // one page's HTML, raw (the inline icon sprite is about 36 kB of it)
  firstLoad: 325_000,     // sent: HTML, CSS, JS, preloads, images without loading="lazy", CSS backgrounds
  /* The three figures for the drawings are NOT the caps of the style guide (docs/design-review/style-guide.md section 9.3: 12 kB a
     plate, 120 kB raw for all new SVG of a page). They hold the drawings at what docs/design-review/_src/site_build.py writes after
     its byte pass (largest plate 29.2 kB; 234.9 kB raw and 87.0 kB sent in all), with about 2 % of room, so that any growth fails
     here. The approved plates cannot reach 9.3 without being drawn with fewer strokes: either that is done, and these three go down
     to 12_000 / 120_000, or 9.3 is amended to these figures. Until one of the two is decided, do not raise them. */
  sketchFile: 30_000,     // one file of img/sketch/, raw
  sketchRaw: 240_000,     // every Margin Sketch drawing a page can load: the inline sprite plus img/sketch/, raw
  sketchSent: 89_000,     // the same, sent
};
/* What the main JSON-LD graph of / and /zh/ has to hold (two VideoObject nodes today; one is asked for). */
const LD_TYPES = ['WebSite', 'WebPage', 'Person', 'SoftwareApplication', 'SoftwareSourceCode', 'VideoObject'];
/* One of each, not empty, on / and on /zh/. */
const SOCIAL_META = ['og:title', 'og:description', 'og:image', 'og:type', 'twitter:card'];
/* sha1 (first 10 hex digits) of every path of the line-drawn sprite of commit 0f55540, i-github excluded */
const OLD_COMMIT = '0f55540';
const OLD_SPRITE = new Set(('105b9d523c 14837284de 191a59e2e7 1e748ca2e0 1ecbdeda6e 21d0e64a17 25d209aa22 2826dccdd5 30066fe3d0 31103ebfe1 371a7a66ac '
  + '3cc0f5165f 46f123f84c 47807b5026 4d28e032e1 4eaa588030 5739591b06 580e9fc1b5 62b96868b2 68058ef849 682d048511 6905c31388 6c9e951e33 740988758a '
  + '765f838cb2 810c5db388 829dc800bc 866a5c4366 88e969d841 8bdc8edc1b 9201573cec 9219e01c24 9d59f08ff6 9e7361d44a 9ea443e56f a0413ae3d0 a187880281 '
  + 'aacbee57b9 acd47a9e4b ae4624e2f7 b9a78190aa be677640ee c27da267d1 c3f075f007 c6378507ed cf59ce2053 d03c56e564 d0602a257e d398a0a390 e0a3a6a930 '
  + 'f5f0176706 f72b2eb657 f8f8f0bc63 fc98a28fcb').split(' '));
const OLD_GITHUB = 'bfb0b37d47';   // sha1 (first 10) of the whole i-github <symbol> of that commit

const quiet = process.argv.includes('--quiet');
const results = [];
function check(name, problems, note = '') {
  const ok = problems.length === 0;
  results.push({ name, ok });
  if (!ok || !quiet) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok && note ? '  (' + note + ')' : ''}`);
  for (const p of problems.slice(0, 40)) console.log('        ' + p);
  if (problems.length > 40) console.log(`        … and ${problems.length - 40} more`);
}
const read = (rel) => readFileSync(join(SITE, rel), 'utf8');
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const TEXT_EXT = /\.(html|css|js|mjs|svg|xml|json|txt)$/i;
const sizeCache = new Map();
function size(rel) {                                               // { raw, sent } of a site file
  if (!sizeCache.has(rel)) {
    const buf = readFileSync(join(SITE, rel));
    sizeCache.set(rel, { raw: buf.length, sent: TEXT_EXT.test(rel) ? gzipSync(buf, { level: 9 }).length : buf.length });
  }
  return sizeCache.get(rel);
}

/* ---------------------------------------------------------------- a small HTML reader (tags, attributes, raw script / style text) */
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|nbsp);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' }[k];
});
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function parse(html) {
  const tags = [];                                                  // { name, attrs: Map, at, parent (the element it is in), raw (script / style body) }
  const open = [];                                                  // the elements that are open, innermost last
  let m; TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    if (!m[2]) continue;                                            // a comment
    const name = m[2].toLowerCase();
    if (m[1]) {                                                     // an end tag closes the innermost open element of its name
      const i = open.map((t) => t.name).lastIndexOf(name);
      if (i >= 0) open.length = i;
      continue;
    }
    const attrs = new Map();
    let a; ATTR.lastIndex = 0;
    while ((a = ATTR.exec(m[3]))) attrs.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
    const tag = { name, attrs, at: m.index, end: TAG.lastIndex, parent: open[open.length - 1] || null };
    if (name === 'script' || name === 'style') {
      const close = html.toLowerCase().indexOf(`</${name}`, TAG.lastIndex);
      tag.raw = html.slice(TAG.lastIndex, close);
      TAG.lastIndex = close;
    }
    tags.push(tag);
    if (!VOID.has(name) && !m[4]) open.push(tag);
  }
  const lineAt = (i) => html.slice(0, i).split('\n').length;
  return { html, tags, lineAt };
}
/* inner HTML of the first element that matches `open` (a regex for its start tag); nested tags of the same name are balanced */
function inner(html, open, from = 0) {
  open.lastIndex = from;
  const m = open.exec(html);
  if (!m) return null;
  const name = /<([a-zA-Z0-9]+)/.exec(m[0])[1];
  const same = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*>`, 'gi');
  same.lastIndex = m.index + m[0].length;
  let depth = 1, n;
  while (depth && (n = same.exec(html))) depth += n[1] ? -1 : 1;
  return depth ? null : { start: m.index, innerStart: m.index + m[0].length, innerEnd: n.index, end: same.lastIndex, text: html.slice(m.index + m[0].length, n.index) };
}
/* the element itself or the nearest one around it that passes the test, or null */
const closest = (tag, test) => { for (let t = tag; t; t = t.parent) if (test(t)) return t; return null; };
const hasClass = (t, c) => (t.attrs.get('class') || '').split(/\s+/).includes(c);
const visible = (h) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, '');   // text without any white space: compared, never shown

/* ---------------------------------------------------------------- style sheets and scripts without their comments */
const cssCode = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ');
/* The rules of a style sheet, in order: { sel, sels (the selector list), body, at (the @media / @supports / @container preludes
   around it, outermost first) }. @keyframes and @font-face come as one rule each, with the at-rule as their selector. */
function cssRules(text) {
  const src = cssCode(text), rules = [];
  const walk = (from, to, at) => {
    for (let i = from; i < to;) {
      const start = src.indexOf('{', i);
      if (start < 0 || start >= to) break;
      let depth = 1, j = start + 1;
      while (j < to && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const sel = src.slice(i, start).split(';').pop().trim().replace(/\s+/g, ' ');
      if (/^@(?:media|supports|container|layer)\b/.test(sel)) walk(start + 1, j - 1, [...at, sel]);
      else rules.push({ sel, sels: sel.split(',').map((x) => x.trim()), body: src.slice(start + 1, j - 1), at });
      i = j;
    }
  };
  walk(0, src.length, []);
  return rules;
}
/* A script without its comments. Strings and regular expressions are kept as they are, so an address inside one stays, and
   'https://…' is not mistaken for a line comment. Where it cannot tell, it keeps the text. */
function jsCode(src) {
  let out = '', last = '';                                          // last: the last character of code that is not white space
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last)))) {
      let j = i + 1, cls = false;                                   // a string, or a regular expression (a / where no division can be)
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (c === '/') { if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '\n') break; if (src[j] === '/' && !cls) break; } else if (src[j] === c) break;
      }
      out += src.slice(i, j + 1); last = c; i = j + 1; continue;
    }
    out += c; if (!/\s/.test(c)) last = c; i++;
  }
  return out;
}
/* the address of a host: https://host.tld, http://host.tld or //host.tld */
const HOST = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
/* -> the first address of another host in a piece of code or CSS, or null; an XML namespace is a name, not an address */
const hostIn = (code) => { const m = HOST.exec(code.replace(/http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace)/g, '')); return m ? m[0] : null; };

/* ---------------------------------------------------------------- where a URL of a page leads */
const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(u);
function localTarget(pageFile, u) {
  /* -> { file, hash } for a URL that stays on this site, null for another host, a mailto: and the like */
  let hash = '';
  const h = u.indexOf('#');
  if (h >= 0) { hash = u.slice(h + 1); u = u.slice(0, h); }
  u = u.split('?')[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) {
    if (!u.startsWith(BASE_URL) && u + '/' !== BASE_URL) return null;
    u = BASE_PATH + u.slice(BASE_URL.length);
  }
  let file;
  if (u === '') file = pageFile;
  else if (u.startsWith('/')) {
    if (!u.startsWith(BASE_PATH) && u + '/' !== BASE_PATH) return { file: null, hash, bad: 'outside ' + BASE_PATH };
    file = u.slice(BASE_PATH.length);
  } else file = join(dirname(pageFile), u);
  file = file.replace(/\\/g, '/');
  if (file === '' || file === '.' || file.endsWith('/')) file = join(file, 'index.html').replace(/\\/g, '/');
  else if (existsSync(join(SITE, file)) && statSync(join(SITE, file)).isDirectory()) file = file + '/index.html';
  if (relative(SITE, resolve(SITE, file)).startsWith('..')) return { file: null, hash, bad: 'outside the site' };
  return { file: relative(SITE, resolve(SITE, file)).replace(/\\/g, '/'), hash };
}
const srcsetUrls = (v) => v.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);

/* ---------------------------------------------------------------- read everything once */
const css = read('css/site.css');
const js = read('js/site.js');
const pages = PAGES.map((p) => ({ ...p, ...parse(read(p.file)) }));
for (const p of pages) {
  p.ids = new Map();
  for (const t of p.tags) if (t.attrs.has('id')) p.ids.set(t.attrs.get('id'), (p.ids.get(t.attrs.get('id')) || 0) + 1);
}
const cssUrls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]);
const jsPaths = [...js.matchAll(/['"]((?:img|media|fonts|css|js|brand)\/[^'"]+)['"]/g)].map((m) => m[1]);
const jsSymbols = [...js.matchAll(/['"]#((?:i|j|d|o)-[a-z0-9-]+)['"]/g)].map((m) => m[1]);

/* ---------------------------------------------------------------- links */
{
  const bad = [];
  const URL_ATTRS = ['href', 'src', 'poster', 'data-zoom'];
  for (const p of pages) {
    const seen = new Set();
    const test = (u, what, line) => {
      const key = what + ' ' + u;
      if (seen.has(key)) return; seen.add(key);
      const t = localTarget(p.file, u);
      if (!t) return;                                               // another host: see "no CDN"
      if (t.bad) { bad.push(`${p.file}:${line} ${what}="${u}": ${t.bad}`); return; }
      if (!existsSync(join(SITE, t.file))) { bad.push(`${p.file}:${line} ${what}="${u}": no file ${t.file}`); return; }
      if (t.hash && what !== 'JSON-LD') {                             // an @id like …/#app names a thing, it is not an anchor
        const target = pages.find((q) => q.file === t.file);
        if (target && !target.ids.has(decodeURIComponent(t.hash))) bad.push(`${p.file}:${line} ${what}="${u}": no id "${t.hash}" in ${t.file}`);
      }
    };
    for (const t of p.tags) {
      const line = () => p.lineAt(t.at);
      for (const a of URL_ATTRS) if (t.attrs.has(a) && t.attrs.get(a) !== '') test(t.attrs.get(a), a, line());
      if (t.attrs.has('srcset')) for (const u of srcsetUrls(t.attrs.get('srcset'))) test(u, 'srcset', line());
      if (t.name === 'meta' && /^(og:image|og:url|twitter:image)$/.test(t.attrs.get('property') || t.attrs.get('name') || '')) test(t.attrs.get('content') || '', 'content', line());
      if (t.name === 'script' && t.attrs.get('type') === 'application/ld+json') {
        for (const m of t.raw.matchAll(/"(https?:\/\/[^"]+)"/g)) if (m[1].startsWith(BASE_URL)) test(m[1], 'JSON-LD', line());
      }
    }
  }
  for (const u of cssUrls) {
    if (isExternal(u) || u.startsWith('data:')) continue;
    if (!existsSync(join(SITE, 'css', u))) bad.push(`css/site.css url(${u}): no such file`);
  }
  for (const u of jsPaths) if (!existsSync(join(SITE, u))) bad.push(`js/site.js '${u}': no such file`);
  const map = read('sitemap.xml');
  for (const m of map.matchAll(/(?:<(?:loc|image:loc|video:thumbnail_loc|video:content_loc)>|href=")(https?:\/\/[^<"]+)/g)) {
    const t = localTarget('index.html', m[1]);
    if (t && (t.bad || !existsSync(join(SITE, t.file)))) bad.push(`sitemap.xml ${m[1]}: no such file`);
  }
  check('links: every local URL of the three pages, the CSS, the script and the sitemap leads to a file (and every #fragment to an id)', bad);
}

/* ---------------------------------------------------------------- sprite */
const sprite = {};
const spriteClasses = new Set();                                    // the sk-… classes the symbols use
{
  const bad = [];
  for (const p of pages) {
    const symbols = new Map();
    for (const m of p.html.matchAll(/<symbol id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) symbols.set(m[1], m[0]);
    sprite[p.file] = symbols;
    const used = new Set(jsSymbols);
    for (const t of p.tags) {
      if (t.name !== 'use') continue;
      const h = t.attrs.get('href') ?? t.attrs.get('xlink:href') ?? '';
      if (!h.startsWith('#')) { bad.push(`${p.file}:${p.lineAt(t.at)} <use href="${h}">: not a symbol of this page`); continue; }
      used.add(h.slice(1));
      if (!symbols.has(h.slice(1))) bad.push(`${p.file}:${p.lineAt(t.at)} <use href="${h}">: no such <symbol>`);
    }
    if (symbols.size) {
      for (const id of jsSymbols) if (!symbols.has(id)) bad.push(`js/site.js uses '#${id}': no such <symbol> in ${p.file}`);
      for (const id of symbols.keys()) if (!used.has(id)) bad.push(`${p.file}: <symbol id="${id}"> is never used`);
    }
  }
  check('sprite: every <use> has its <symbol>, and every <symbol> is used', bad, `${sprite['index.html'].size} symbols`);
}
{
  const bad = [];
  const old = new Set(OLD_SPRITE);
  let oldGithub = null, source = 'the fingerprints in this script';
  const git = spawnSync('git', ['show', `${OLD_COMMIT}:index.html`], { cwd: SITE, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (git.status === 0 && git.stdout) {
    source += ` and git show ${OLD_COMMIT}:index.html`;
    for (const m of git.stdout.matchAll(/<symbol id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
      if (m[1] === 'i-github') { oldGithub = m[0]; continue; }
      for (const d of m[2].matchAll(/\sd="([^"]*)"/g)) old.add(sha(d[1].trim().replace(/\s+/g, ' ')));
    }
  }
  const cssClasses = new Set([...css.matchAll(/\.(sk-[a-z0-9-]+)\b/g)].map((m) => m[1]));
  for (const p of pages) {
    for (const [id, whole] of sprite[p.file]) {
      if (id === 'i-github') {
        if (sha(whole) !== OLD_GITHUB || (oldGithub !== null && whole !== oldGithub)) bad.push(`${p.file}: the i-github symbol differs from the one of commit ${OLD_COMMIT}`);
        continue;
      }
      const body = whole.replace(/^<symbol[^>]*>|<\/symbol>$/g, '');
      const rest = body.replace(/<path class="(sk-[a-z0-9-]+)" d="[^"]*"\/>/g, (all, c) => { spriteClasses.add(c); if (!cssClasses.has(c)) bad.push(`${p.file}: #${id} uses class ${c}, which css/site.css does not style`); return ''; });
      if (rest.trim() !== '') bad.push(`${p.file}: #${id} is not only filled Margin Sketch paths: ${rest.trim().slice(0, 70)}`);
      for (const d of body.matchAll(/\sd="([^"]*)"/g)) if (old.has(sha(d[1].trim().replace(/\s+/g, ' ')))) bad.push(`${p.file}: #${id} still holds a path of the old line-drawn sprite`);
    }
  }
  if (!sprite['index.html'].has('i-github')) bad.push('index.html: the i-github symbol is missing');
  check('sprite: every symbol except i-github is redrawn (no path of the old sprite), i-github is untouched', bad, 'compared with ' + source);
}

/* ---------------------------------------------------------------- the CSS the drawings depend on */
{
  const bad = [];
  const rules = cssRules(css);
  const top = rules.filter((r) => r.at.length === 0);
  const sets = (r, prop) => { const m = new RegExp('(?:^|[;{\\s])' + prop.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;}]+)').exec(r.body); return m ? m[1].trim() : null; };
  /* the GitHub mark: the symbol has no fill or stroke of its own */
  if (!top.some((r) => r.sels.includes('#i-github path') && sets(r, 'fill') === 'none' && sets(r, 'stroke') === 'currentColor')) bad.push('css/site.css: no rule "#i-github path { fill: none; stroke: currentColor }": the GitHub mark would be a solid blob');
  /* an icon is drawn in the colour of the text around it */
  if (!top.some((r) => r.sels.includes('.icon') && sets(r, '--sk-ink') === 'currentColor')) bad.push('css/site.css: .icon does not set --sk-ink: currentColor: every icon would have the ink of the plates, on any ground');
  /* tokens: all that are used are defined; the dark grounds have their own */
  const root = new Map();
  for (const r of top) if (r.sels.includes(':root')) for (const m of r.body.matchAll(/(--sk-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) root.set(m[1], m[2].trim());
  for (const name of new Set([...cssCode(css).matchAll(/var\(\s*(--sk-[a-z0-9-]+)/g)].map((m) => m[1]))) if (!root.has(name)) bad.push(`css/site.css: ${name} is used but :root does not define it`);
  const dark = top.find((r) => r.sels.includes('.band-dark') && r.sels.includes('.oss') && sets(r, '--sk-ink') !== null);
  if (!dark) bad.push('css/site.css: no rule ".band-dark, .oss" that sets --sk-ink: dark ink on the dark bands');
  else for (const name of ['--sk-ink', '--sk-text', '--sk-hatch', '--sk-wash']) if (sets(dark, name) === null || sets(dark, name) === root.get(name)) bad.push(`css/site.css: ".band-dark, .oss" does not give ${name} a value of its own`);
  for (const c of spriteClasses) if (!top.some((r) => r.sels.includes('.' + c) && /^var\(--sk-/.test(sets(r, 'fill') || ''))) bad.push(`css/site.css: no rule gives .${c} its fill from a --sk-* token`);
  /* motion: the wipe-in and every hidden state only when the visitor allows motion */
  const inMedia = (r, feature) => r.at.some((a) => /^@media\b/.test(a) && a.replace(/\s+/g, '').includes(feature));
  const HIDDEN = /\[data-reveal=(['"]?)hidden\1\]/;
  const undone = new Set(rules.filter((r) => inMedia(r, '(prefers-reduced-motion:reduce)') && /opacity\s*:\s*1\b/.test(r.body)).flatMap((r) => r.sels));
  for (const r of rules) {
    if (inMedia(r, '(prefers-reduced-motion:no-preference)')) continue;
    if (/\bsk-draw\b/.test(r.sel + ' ' + r.body)) bad.push(`css/site.css: "${r.sel}" uses sk-draw outside @media (prefers-reduced-motion: no-preference)`);
    if (inMedia(r, '(prefers-reduced-motion:reduce)')) continue;
    for (const sel of r.sels) if (HIDDEN.test(sel) && !undone.has(sel)) bad.push(`css/site.css: "${sel}" hides content outside @media (prefers-reduced-motion: no-preference), and no reduced-motion rule undoes it`);
  }
  /* a loading="lazy" image that is clipped away or not rendered while it waits is not fetched before its reveal: it waits with opacity */
  for (const r of rules) for (const sel of r.sels) {
    if (HIDDEN.test(sel) && /\.ill\b(?!-)/.test(sel) && /(?:^|[;\s])(?:clip-path|clip|display|visibility|content-visibility)\s*:/.test(r.body)) bad.push(`css/site.css: "${sel}" hides a lazy drawing with ${/(clip-path|clip|display|visibility|content-visibility)\s*:/.exec(r.body)[1]}: its file would only be fetched at the reveal (use opacity)`);
  }
  if (!rules.some((r) => /\bsk-draw\b/.test(r.body) && r.sel !== '@keyframes sk-draw')) bad.push('css/site.css: nothing uses the sk-draw animation any more: remove this check with it');
  /* container units: a declaration with var() is never dropped by a browser that does not know cqw, so it needs a feature query */
  for (const r of rules) for (const decl of r.body.split(';')) {
    if (/\bvar\(/.test(decl) && /\dcq(?:w|h|i|b|min|max)\b/.test(decl) && !r.at.some((a) => /^@supports\b.*\dcq/.test(a))) bad.push(`css/site.css: "${r.sel}" mixes var() with a container unit outside @supports (width: 1cqw): ${decl.trim().slice(0, 60)}`);
  }
  /* forced colours: a drawing keeps its ink, so it has to keep its ground */
  for (const sel of ['.plate', '.jtile']) {
    if (!rules.some((r) => inMedia(r, '(forced-colors:active)') && r.sels.includes(sel) && sets(r, 'forced-color-adjust') === 'none' && sets(r, 'background') !== null)) bad.push(`css/site.css: in @media (forced-colors: active), ${sel} does not keep its ground (forced-color-adjust: none and a background)`);
  }
  check('sketch CSS: the GitHub mark, the ink of the icons, the tokens, motion only when allowed, the container-unit fallback and forced colours', bad, `${rules.length} rules read`);
}

/* ---------------------------------------------------------------- ids, h1 */
{
  const bad = [];
  for (const p of pages) for (const [id, n] of p.ids) if (n > 1) bad.push(`${p.file}: id="${id}" is used ${n} times`);
  check('ids: no id is used twice on a page', bad);
}
{
  const bad = [];
  for (const p of pages) { const n = p.tags.filter((t) => t.name === 'h1').length; if (n !== 1) bad.push(`${p.file}: ${n} <h1> elements`); }
  check('headings: exactly one <h1> on each page', bad);
}

/* ---------------------------------------------------------------- JSON-LD */
{
  const bad = [];
  let blocks = 0, questions = 0;
  for (const p of pages) {
    let faq = null;
    const byId = new Map();                                         // id of the <script> -> the @type values it holds
    for (const t of p.tags) {
      if (t.name !== 'script' || t.attrs.get('type') !== 'application/ld+json') continue;
      blocks++;
      let data;
      try { data = JSON.parse(t.raw); } catch (e) { bad.push(`${p.file}:${p.lineAt(t.at)} JSON-LD does not parse: ${e.message}`); continue; }
      const nodes = [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])];
      byId.set(t.attrs.get('id') || '', new Set(nodes.flatMap((n) => [].concat(n['@type'] || []))));
      for (const node of nodes) if (node['@type'] === 'FAQPage') faq = node;
    }
    if (p.url) {                                                    // the two language pages carry the whole graph
      if (!byId.has('ld-main')) bad.push(`${p.file}: no <script type="application/ld+json" id="ld-main"> (the main graph)`);
      else for (const type of LD_TYPES) if (!byId.get('ld-main').has(type)) bad.push(`${p.file}: the main graph (#ld-main) has no ${type} node`);
      if (!byId.has('ld-faq')) bad.push(`${p.file}: no <script type="application/ld+json" id="ld-faq"> (the FAQPage block)`);
      else if (!byId.get('ld-faq').has('FAQPage')) bad.push(`${p.file}: #ld-faq holds no FAQPage node`);
    }
    const section = inner(p.html, /<section\b[^>]*\bid="faq"[^>]*>/g);
    if (!section) { if (faq) bad.push(`${p.file}: a FAQPage block but no #faq section`); continue; }
    if (!faq) { bad.push(`${p.file}: #faq has no FAQPage JSON-LD`); continue; }
    /* the Chinese text of the English page lives in data-zh attributes: not visible, so not compared */
    const shown = [...section.text.replace(/\sdata-zh(?:-[\w-]+)?="[^"]*"/g, '').matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
      .map((m) => ({ q: visible(m[1]), a: visible(m[2]) }));
    const said = (faq.mainEntity || []).map((e) => ({ q: (e.name || '').replace(/\s+/g, ''), a: ((e.acceptedAnswer || {}).text || '').replace(/\s+/g, '') }));
    questions += shown.length;
    if (shown.length !== said.length) bad.push(`${p.file}: ${shown.length} visible questions, ${said.length} in the FAQPage block`);
    shown.forEach((s, i) => {
      if (!said[i]) return;
      if (s.q !== said[i].q) bad.push(`${p.file}: FAQ question ${i + 1} differs: "${s.q.slice(0, 40)}" / "${said[i].q.slice(0, 40)}"`);
      else if (s.a !== said[i].a) bad.push(`${p.file}: the answer to FAQ question ${i + 1} differs from its JSON-LD`);
    });
    if (faq.url !== p.url) bad.push(`${p.file}: the FAQPage url is ${faq.url}`);
  }
  check('JSON-LD: every block parses, the main graph holds its ' + LD_TYPES.length + ' kinds of node, and each FAQPage block says what the visible FAQ says', bad, `${blocks} blocks, ${questions} questions`);
}

/* ---------------------------------------------------------------- languages: canonical, hreflang, sitemap */
{
  const bad = [];
  const want = { en: BASE_URL, 'zh-CN': BASE_URL + 'zh/', zh: BASE_URL + 'zh/', 'x-default': BASE_URL };
  for (const p of pages.filter((q) => q.url)) {
    const html = p.tags.find((t) => t.name === 'html');
    if (html.attrs.get('lang') !== p.lang) bad.push(`${p.file}: <html lang="${html.attrs.get('lang')}">, expected ${p.lang}`);
    const canon = p.tags.filter((t) => t.name === 'link' && t.attrs.get('rel') === 'canonical').map((t) => t.attrs.get('href'));
    if (canon.length !== 1 || canon[0] !== p.url) bad.push(`${p.file}: canonical is ${canon.join(', ') || 'missing'}, expected ${p.url}`);
    const og = p.tags.filter((t) => t.name === 'meta' && t.attrs.get('property') === 'og:url').map((t) => t.attrs.get('content'));
    if (og.length !== 1 || og[0] !== p.url) bad.push(`${p.file}: og:url is ${og.join(', ') || 'missing'}, expected ${p.url}`);
    const alt = new Map(p.tags.filter((t) => t.name === 'link' && t.attrs.get('rel') === 'alternate' && t.attrs.has('hreflang')).map((t) => [t.attrs.get('hreflang'), t.attrs.get('href')]));
    for (const [lang, url] of Object.entries(want)) if (alt.get(lang) !== url) bad.push(`${p.file}: hreflang="${lang}" is ${alt.get(lang) || 'missing'}, expected ${url}`);
    for (const lang of alt.keys()) if (!(lang in want)) bad.push(`${p.file}: unexpected hreflang="${lang}"`);
    if (alt.get(p.lang) !== p.url) bad.push(`${p.file}: its own hreflang (${p.lang}) does not point to itself`);
    for (const need of ['title', 'h1']) if (!p.tags.some((t) => t.name === need)) bad.push(`${p.file}: no <${need}>`);
    if (!p.tags.some((t) => t.name === 'meta' && t.attrs.get('name') === 'description' && (t.attrs.get('content') || '').length > 50)) bad.push(`${p.file}: no meta description`);
    for (const key of SOCIAL_META) {
      const found = p.tags.filter((t) => t.name === 'meta' && (t.attrs.get('property') === key || t.attrs.get('name') === key)).map((t) => (t.attrs.get('content') || '').trim());
      if (found.length !== 1 || found[0] === '') bad.push(`${p.file}: ${found.length ? found.length + ' ' + key + ' tags' + (found.length === 1 ? ', empty' : '') : 'no ' + key}, expected one with a content`);
      else if (key === 'og:image' && !found[0].startsWith(BASE_URL)) bad.push(`${p.file}: og:image is ${found[0]}, expected an address under ${BASE_URL}`);
    }
  }
  const map = read('sitemap.xml');
  const urls = [...map.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  for (const p of pages.filter((q) => q.url)) {
    const entry = urls.find((u) => u.includes(`<loc>${p.url}</loc>`));
    if (!entry) { bad.push(`sitemap.xml does not list ${p.url}`); continue; }
    for (const [lang, url] of Object.entries(want)) if (!entry.includes(`hreflang="${lang}" href="${url}"`)) bad.push(`sitemap.xml: ${p.url} lacks hreflang="${lang}" -> ${url}`);
  }
  if (urls.length !== 2) bad.push(`sitemap.xml lists ${urls.length} pages, expected 2`);
  check('languages: canonical, og:url and hreflang of / and /zh/ agree, both have their Open Graph and Twitter tags, and sitemap.xml lists both pages', bad);
}

/* ---------------------------------------------------------------- zh/index.html is current */
{
  const r = spawnSync(process.execPath, [join(SITE, 'scripts', 'build-zh.mjs'), '--check', '--strict'], { cwd: SITE, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean);
  check('zh: zh/index.html is up to date and fully translated (build-zh.mjs --check --strict)', r.status === 0 ? [] : out.length ? out : ['build-zh.mjs exited with ' + r.status]);
}

/* ---------------------------------------------------------------- nothing is loaded from another host */
const allowedSeen = new Set();
{
  const bad = [];
  const load = (u, where) => {
    if (!isExternal(u)) return;
    if (ALLOWED_EXTERNAL.includes(u)) { allowedSeen.add(u); return; }
    bad.push(`${where}: loads ${u}`);
  };
  for (const p of pages) {
    for (const t of p.tags) {
      const where = `${p.file}:${p.lineAt(t.at)} <${t.name}>`;
      const rel = (t.attrs.get('rel') || '').toLowerCase().split(/\s+/);
      if (t.name === 'link') {
        if (rel.some((r) => ['stylesheet', 'preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch', 'icon', 'apple-touch-icon', 'manifest'].includes(r))) load(t.attrs.get('href') || '', where);
        continue;
      }
      if (['script', 'img', 'video', 'audio', 'source', 'track', 'iframe', 'embed', 'input'].includes(t.name)) {
        load(t.attrs.get('src') || '', where);
        for (const u of srcsetUrls(t.attrs.get('srcset') || '')) load(u, where);
        load(t.attrs.get('poster') || '', where);
      }
      if (t.name === 'object') load(t.attrs.get('data') || '', where);
      if (t.name === 'use' || t.name === 'image') load(t.attrs.get('href') || t.attrs.get('xlink:href') || '', where);
      if (t.attrs.has('data-zoom')) load(t.attrs.get('data-zoom'), where);
      /* what follows looks for the address itself, wherever it stands: a script can build an element, CSS has image-set() */
      let host;
      if (t.attrs.has('style')) {
        for (const m of t.attrs.get('style').matchAll(/url\(\s*['"]?([^'")]+)/g)) load(m[1], where + ' style');
        if ((host = hostIn(cssCode(t.attrs.get('style'))))) bad.push(`${where} style: holds the address ${host}`);
      }
      if (t.name === 'style') {
        for (const m of t.raw.matchAll(/url\(\s*['"]?([^'")]+)|@import\s+['"]([^'"]+)/g)) load(m[1] || m[2], where);
        if ((host = hostIn(cssCode(t.raw)))) bad.push(`${where}: holds the address ${host}`);
      }
      if (t.name === 'script' && !t.attrs.has('src') && t.attrs.get('type') !== 'application/ld+json') {
        if (/\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\b/.test(t.raw)) bad.push(`${where}: an inline script that talks to the network`);
        if ((host = hostIn(jsCode(t.raw)))) bad.push(`${where}: an inline script that holds the address ${host}`);
      }
      for (const [name, value] of t.attrs) if (/^on[a-z]+$/.test(name) && (host = hostIn(jsCode(value)))) bad.push(`${where} ${name}: holds the address ${host}`);
    }
  }
  for (const u of cssUrls) load(u, 'css/site.css url()');
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) load(m[1], 'css/site.css @import');
  for (const m of cssCode(css).matchAll(new RegExp(HOST.source, 'gi'))) bad.push(`css/site.css: holds the address ${m[0]} (${cssCode(css).slice(Math.max(0, m.index - 30), m.index).replace(/\s+/g, ' ').trim()} …)`);
  if (/\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\s*\(/.test(js)) bad.push('js/site.js: talks to the network');
  { const host = hostIn(jsCode(js)); if (host) bad.push(`js/site.js: holds the address ${host}`); }
  const svgs = [];
  const walk = (dir) => { for (const f of readdirSync(join(SITE, dir), { withFileTypes: true })) { if (f.name.startsWith('.')) continue; const rel = join(dir, f.name); if (f.isDirectory()) walk(rel); else if (f.name.endsWith('.svg')) svgs.push(rel.replace(/\\/g, '/')); } };
  walk('.');
  for (const f of svgs) {
    const s = read(f);
    for (const m of s.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']|url\(\s*['"]?([^'")]+)|@import\s+['"]([^'"]+)/g)) { const u = m[1] || m[2] || m[3]; if (!u.startsWith('#')) load(u, f); }
    for (const m of s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) { const host = hostIn(cssCode(m[1])); if (host) bad.push(`${f}: its <style> holds the address ${host}`); }
    if (/<script\b|<foreignObject\b/i.test(s)) bad.push(`${f}: holds a <script> or <foreignObject>`);
  }
  for (const u of ALLOWED_EXTERNAL) if (!allowedSeen.has(u)) bad.push(`ALLOWED_EXTERNAL lists ${u}, which no page loads any more: remove it from scripts/check-site.mjs`);
  check('no CDN: nothing is loaded from another host, and no script or style sheet holds the address of one', bad, allowedSeen.size ? `known exception: the CI badge from ${new URL([...allowedSeen][0]).host}` : `${svgs.length} SVG files read too`);
}

/* ---------------------------------------------------------------- images: width, height, proportions, alt */
function dimensions(rel) {                                          // [width, height] of a local image, or null
  const buf = readFileSync(join(SITE, rel));
  if (rel.endsWith('.svg')) {
    const head = /<svg\b[^>]*>/.exec(buf.toString('utf8'));
    if (!head) return null;
    const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head[0]);
    const w = /\swidth="([\d.]+)"/.exec(head[0]), h = /\sheight="([\d.]+)"/.exec(head[0]);
    return vb ? [+vb[1], +vb[2]] : w && h ? [+w[1], +h[1]] : null;
  }
  if (buf.slice(1, 4).toString() === 'PNG') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    const kind = buf.slice(12, 16).toString();
    if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
    if (kind === 'VP8X') return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
{
  const bad = [];
  let n = 0;
  for (const p of pages) {
    for (const t of p.tags) {
      if (t.name !== 'img' && t.name !== 'video') continue;
      const where = `${p.file}:${p.lineAt(t.at)} <${t.name}${t.attrs.get('src') ? ' src="' + t.attrs.get('src') + '"' : ''}>`;
      if (t.name === 'img' && !t.attrs.has('alt')) bad.push(`${where}: no alt attribute`);
      const src = t.attrs.get('src') || '';
      if (t.name === 'img' && src === '') continue;                 // the lightbox image: filled in when a screenshot is opened
      if (ALLOWED_EXTERNAL.includes(src)) continue;                 // the CI badge: its width is GitHub's to choose (css gives it its height)
      n++;
      const w = +t.attrs.get('width'), h = +t.attrs.get('height');
      if (!(w > 0) || !(h > 0)) { bad.push(`${where}: width and height are needed`); continue; }
      if (t.name !== 'img') continue;
      for (const u of [src, ...srcsetUrls(t.attrs.get('srcset') || '')]) {
        const target = localTarget(p.file, u);
        if (!target || !target.file || !existsSync(join(SITE, target.file))) continue;
        const d = dimensions(target.file);
        if (d && Math.abs(d[0] / d[1] - w / h) / (w / h) > 0.01) bad.push(`${where}: width="${w}" height="${h}" but ${target.file} is ${d[0]} x ${d[1]}`);
      }
    }
  }
  check('images: every <img> and <video> has width and height in the proportions of its file, and every <img> an alt', bad, `${n} checked`);
}

/* ---------------------------------------------------------------- plates */
{
  const bad = [];
  const usedFiles = new Set(cssUrls.map((u) => join('css', u).replace(/\\/g, '/')));
  for (const p of pages) {
    for (const t of p.tags) {
      for (const a of ['src', 'href']) if (t.attrs.has(a)) { const target = localTarget(p.file, t.attrs.get(a)); if (target && target.file) usedFiles.add(target.file); }
      const where = `${p.file}:${p.lineAt(t.at)}`;
      /* icons: an <svg> that shows a symbol, and the sprite that holds the symbols, say nothing to a screen reader unless they are named */
      if (t.name === 'use' || t.name === 'symbol') {
        const svg = closest(t, (a) => a.name === 'svg');
        if (!svg) bad.push(`${where} <${t.name}> outside an <svg>`);
        else if (!svg.checked) {
          svg.checked = true;
          const named = t.name === 'use' && svg.attrs.get('role') === 'img' && ((svg.attrs.get('aria-label') || '').trim() !== '' || p.ids.has(svg.attrs.get('aria-labelledby') || ''));
          if (!named && !closest(svg, (a) => a.attrs.get('aria-hidden') === 'true')) bad.push(`${p.file}:${p.lineAt(svg.at)} ${t.name === 'use' ? 'icon <use href="' + (t.attrs.get('href') || '') + '">' : 'the sprite'}: its <svg> is neither aria-hidden="true" (nor inside such an element) nor named`);
        }
      }
      /* labels: on a sheet, and on it */
      if (hasClass(t, 'lbl')) {
        if (!closest(t.parent, (a) => hasClass(a, 'ill-box'))) bad.push(`${where} label: not inside an illustration box`);
        const style = t.attrs.get('style') || '';
        for (const side of ['left', 'top']) {
          const m = new RegExp('(?:^|;)\\s*' + side + '\\s*:\\s*([^;]+)').exec(style);
          let values = m ? [m[1].trim()] : [];
          const custom = m && /^var\(\s*(--[\w-]+)\s*\)$/.exec(values[0]);   // top: var(--t): the value is in css/site.css, one per plate width
          if (custom) values = [...cssCode(css).matchAll(new RegExp(custom[1] + '\\s*:\\s*([^;}]+)', 'g'))].map((x) => x[1].trim());
          if (!values.length) bad.push(`${where} label: no ${side} in its style${custom ? ' (css/site.css never sets ' + custom[1] + ')' : ''}`);
          for (const v of values) if (!/^-?[\d.]+%$/.test(v) || !(parseFloat(v) >= 0 && parseFloat(v) <= 100)) bad.push(`${where} label: ${side} is ${v}, off the sheet (0% to 100%)`);
        }
      }
      if (!hasClass(t, 'ill-box')) continue;
      /* the box: decorative or described */
      const label = (t.attrs.get('aria-label') || '').trim();
      const refs = (t.attrs.get('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      let text = label;
      for (const id of refs) {
        const el = inner(p.html, new RegExp('<[a-zA-Z][\\w-]*\\b[^>]*\\sid="' + id.replace(/[^\w-]/g, '\\$&') + '"[^>]*>', 'g'));
        if (!el) bad.push(`${where} illustration: aria-labelledby="${id}", but the page has no such element`);
        else text += visible(el.text);
      }
      const hidden = t.attrs.get('aria-hidden') === 'true';
      const described = t.attrs.get('role') === 'img' && (label.length > 20 || refs.length > 0);
      if (hidden === described) bad.push(`${where} illustration: needs either aria-hidden="true" or role="img" with a description`);
      else if (described) {
        if (refs.length && text.length <= 40) bad.push(`${where} illustration: its description (aria-labelledby="${refs.join(' ')}") is ${text.length ? 'only "' + text + '"' : 'empty'}`);
        if (p.lang !== 'en' && /^[\x20-\x7e]*$/.test(text)) bad.push(`${where} illustration: its description is not translated (data-zh-aria-label, or data-zh on the element it points to)`);
      }
      /* the box has the proportions of its drawing: the drawing fills it (css: width and height 100%), and the labels are placed in per cent of it */
      const ratio = /(?:^|;)\s*aspect-ratio\s*:\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(t.attrs.get('style') || '');
      const drawings = p.tags.filter((q) => q.name === 'img' && hasClass(q, 'ill') && closest(q.parent, (a) => a === t));
      if (!ratio) bad.push(`${where} illustration: no aspect-ratio in its style`);
      if (drawings.length !== 1) bad.push(`${where} illustration: holds ${drawings.length} drawings (<img class="ill">), expected one`);
      else if (ratio) {
        const w = +drawings[0].attrs.get('width'), h = +drawings[0].attrs.get('height'), box = +ratio[1] / +ratio[2];
        if (!(w > 0 && h > 0) || Math.abs(box - w / h) / (w / h) > 0.01) bad.push(`${where} illustration: aspect-ratio ${ratio[1]}/${ratio[2]}, but its drawing ${drawings[0].attrs.get('src')} is ${w} x ${h}: it would be stretched`);
      }
    }
  }
  if (existsSync(join(SITE, 'img', 'sketch'))) for (const f of readdirSync(join(SITE, 'img', 'sketch'))) if (!usedFiles.has('img/sketch/' + f)) bad.push(`img/sketch/${f} is not used by any page or by css/site.css`);
  for (const p of pages) if (/img\/illustrations\//.test(p.html) || /img\/illustrations\//.test(css)) bad.push(`${p.file} or css/site.css still points into img/illustrations/`);
  check('plates: every illustration is decorative or described, has the proportions of its drawing and its labels on the sheet; every icon is hidden or named; every file of img/sketch/ is used', bad);
}

/* ---------------------------------------------------------------- weight */
{
  const kb = (n) => (n / 1000).toFixed(1).padStart(8) + ' kB';
  const bad = [];
  console.log('\nPage weight (raw / sent; sent = gzip for HTML, CSS, JS and SVG, the file size for fonts, images and video)');
  const sketchFiles = existsSync(join(SITE, 'img', 'sketch')) ? readdirSync(join(SITE, 'img', 'sketch')).map((f) => 'img/sketch/' + f) : [];
  for (const p of pages.filter((q) => q.url)) {
    const first = new Set(), lazy = new Set(), video = new Set(), fonts = new Set();
    const add = (set, u) => { const t = localTarget(p.file, u); if (t && t.file && existsSync(join(SITE, t.file))) set.add(t.file); };
    first.add(p.file);
    for (const t of p.tags) {
      const rel = (t.attrs.get('rel') || '').split(/\s+/);
      if (t.name === 'link' && (rel.includes('stylesheet') || rel.includes('preload'))) add(first, t.attrs.get('href') || '');
      if (t.name === 'script' && t.attrs.has('src')) add(first, t.attrs.get('src'));
      if (t.name === 'img' && t.attrs.get('src')) {
        const set = t.attrs.get('loading') === 'lazy' ? lazy : first;
        add(set, t.attrs.get('src'));                               // the smallest candidate: the src
      }
      if (t.name === 'video' && t.attrs.has('poster')) add(first, t.attrs.get('poster'));   // a poster is fetched with the page, the video is not
      if (t.name === 'source' && t.attrs.has('src')) add(video, t.attrs.get('src'));
    }
    for (const u of cssUrls) { const f = join('css', u).replace(/\\/g, '/'); if (existsSync(join(SITE, f))) (f.startsWith('fonts/') ? fonts : first).add(f); }
    for (const f of first) { lazy.delete(f); if (f.startsWith('fonts/')) fonts.delete(f); }
    const sum = (set) => [...set].reduce((a, f) => ({ raw: a.raw + size(f).raw, sent: a.sent + size(f).sent }), { raw: 0, sent: 0 });
    const html = size(p.file), f1 = sum(first), fl = sum(lazy), fv = sum(video), ff = sum(fonts);
    const symbols = [...sprite[p.file].entries()].filter(([id]) => id !== 'i-github').map(([, s]) => s).join('\n');
    const sk = sketchFiles.reduce((a, f) => ({ raw: a.raw + size(f).raw, sent: a.sent + size(f).sent }), { raw: Buffer.byteLength(symbols), sent: gzipSync(symbols, { level: 9 }).length });
    console.log(`  ${p.url.replace(BASE_URL, '/')}`);
    console.log(`    HTML                                 ${kb(html.raw)} ${kb(html.sent)}    budget ${kb(BUDGET.html).trim()} raw`);
    console.log(`    first load (${String(first.size).padStart(2)} files)                ${kb(f1.raw)} ${kb(f1.sent)}    budget ${kb(BUDGET.firstLoad).trim()} sent`);
    console.log(`    other fonts, when used (${fonts.size})           ${kb(ff.raw)} ${kb(ff.sent)}`);
    console.log(`    lazy images, as scrolled to (${String(lazy.size).padStart(2)})     ${kb(fl.raw)} ${kb(fl.sent)}`);
    console.log(`    video, on play (${video.size})                   ${kb(fv.raw)} ${kb(fv.sent)}`);
    console.log(`    of all that, Margin Sketch drawings  ${kb(sk.raw)} ${kb(sk.sent)}    budget ${kb(BUDGET.sketchRaw).trim()} raw, ${kb(BUDGET.sketchSent).trim()} sent`);
    if (html.raw > BUDGET.html) bad.push(`${p.file}: ${html.raw} bytes of HTML, budget ${BUDGET.html}`);
    if (f1.sent > BUDGET.firstLoad) bad.push(`${p.file}: first load sends ${f1.sent} bytes, budget ${BUDGET.firstLoad}`);
    if (sk.raw > BUDGET.sketchRaw) bad.push(`${p.file}: ${sk.raw} bytes of Margin Sketch drawings, budget ${BUDGET.sketchRaw}`);
    if (sk.sent > BUDGET.sketchSent) bad.push(`${p.file}: Margin Sketch drawings send ${sk.sent} bytes, budget ${BUDGET.sketchSent}`);
  }
  const largest = sketchFiles.reduce((a, f) => (size(f).raw > size(a).raw ? f : a), sketchFiles[0]);
  if (largest) console.log(`  largest file of img/sketch/              ${kb(size(largest).raw)} ${kb(size(largest).sent)}    budget ${kb(BUDGET.sketchFile).trim()} raw  (${largest.split('/').pop()})`);
  for (const f of sketchFiles) if (size(f).raw > BUDGET.sketchFile) bad.push(`${f}: ${size(f).raw} bytes, budget ${BUDGET.sketchFile} for one drawing`);
  console.log('');
  check('weight: each page stays inside its budgets', bad);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
