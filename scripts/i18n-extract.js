#!/usr/bin/env node
// Display language: find the UI strings of the front end and report which of them the Chinese dictionary
// (public/js/i18n/zh.js) does not translate yet. See docs/preferences.md.
//
//   node scripts/i18n-extract.js                 coverage summary + the first untranslated strings
//   node scripts/i18n-extract.js --missing       every untranslated string, one per line (with its file)
//   node scripts/i18n-extract.js --json [file]   every untranslated string as a JSON object {"English": ""} (to fill in)
//   node scripts/i18n-extract.js --all           every string found, translated or not (JSON array)
//   node scripts/i18n-extract.js --skip-file lineage.js   leave a file out (repeatable; --with <file> takes one back)
//   node scripts/i18n-extract.js --check         the summary, and exit code 1 unless every string is translated (CI)
//
// What counts as a UI string (heuristic, the same rules the translator applies at run time):
//   - the value of a tip: property ({tip: 'Split view: editor + preview'}, turned into a tooltip by the code);
//   - text between tags and the values of title / aria-label / placeholder / alt / data-tip / label in HTML strings
//     (a template literal's ${...} becomes {0}, {1} ... - the dictionary keys use the same placeholders);
//   - other string literals that read like text: a capitalised word or words with spaces, not code (selectors,
//     class names, URLs, API paths, event names, CSS);
//   - the static text and attributes of public/index.html.
// Paper data never appears in the code, so it is never extracted.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'data-tip', 'label'];

// ---------- a small JavaScript lexer: comments, strings, template literals (nested), regex literals ----------
function lex(src) {
  const out = []; // {kind: 'str'|'tpl', parts: [text | {expr}] , line}
  let i = 0, line = 1, lastSig = '';
  const n = src.length;
  function readTemplate() { // at the char after the opening backtick; returns {parts}
    const parts = []; let buf = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { buf += unescape(src.slice(i, i + 2)); i += 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') {
        if (buf) parts.push(buf); buf = '';
        i += 2; const start = i; let depth = 1;
        while (i < n && depth) { // skip the expression, minding nested strings / templates
          const d = src[i];
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (!depth) break; }
          else if (d === '`') { i++; const inner = readTemplate(); out.push({ kind: 'tpl', parts: inner.parts, line }); continue; }
          else if (d === '"' || d === "'") { i++; const s = readString(d); out.push({ kind: 'str', parts: [s], line }); continue; }
          else if (d === '\n') line++;
          i++;
        }
        parts.push({ expr: src.slice(start, i) }); i++; continue;
      }
      if (c === '\n') line++;
      buf += c; i++;
    }
    if (buf) parts.push(buf);
    return { parts };
  }
  // the object property a literal is the value of, when it is one of TIP_PROPS ({tip: 'Split view'}: a hint the
  // code turns into a tooltip, e.g. a Vditor toolbar button) - such a value is UI text even when it is short
  function propBefore(at) { const m = /\b(tip)\s*:\s*$/.exec(src.slice(Math.max(0, at - 24), at)); return m ? m[1] : null; }
  function readString(q) {
    let s = '';
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { s += unescape(src.slice(i, i + 2)); i += 2; continue; }
      if (src[i] === '\n') break;
      s += src[i++];
    }
    i++;
    return s;
  }
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; line += (src.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
    if (c === '"' || c === "'") { const l = line, prop = propBefore(i); i++; out.push({ kind: 'str', parts: [readString(c)], line: l, prop }); lastSig = 'x'; continue; }
    if (c === '`') { const l = line, prop = propBefore(i); i++; const parts = readTemplate().parts; out.push({ kind: 'tpl', parts, line: l, prop }); lastSig = 'x'; continue; }
    if (c === '/' && (/[(,=:\[!&|?{};+\-*%<>~^]$/.test(lastSig) || lastSig === '' || /\b(return|typeof|case|in|of)$/.test(lastSig))) {
      // a regex literal
      i++; let cls = false;
      while (i < n && src[i] !== '\n') { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++; }
      i++; while (/[a-z]/i.test(src[i] || '')) i++;
      lastSig = 'x'; continue;
    }
    if (!/\s/.test(c)) {
      if (/[\w$]/.test(c)) { let w = ''; while (i < n && /[\w$]/.test(src[i])) w += src[i++]; lastSig = w; continue; }
      lastSig = c;
    }
    i++;
  }
  return out;
}
function unescape(e) {
  const m = { '\\n': '\n', '\\t': '\t', '\\r': '', '\\\'': "'", '\\"': '"', '\\`': '`', '\\\\': '\\', '\\$': '$' };
  return m[e] !== undefined ? m[e] : e.slice(1);
}

// ---------- HTML pieces of a string: text segments and the translatable attributes ----------
const PH = (k) => `\u0001${k}\u0001`;
const TAG = /<\/?[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/; // a tag; a ">" inside a quoted attribute does not end it
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&hellip;': '…', '&rarr;': '→', '&mdash;': '—', '&ndash;': '–', '&times;': '×', '&middot;': '·' };
const decode = (s) => s.replace(/&[#\w]+;/g, (e) => (ENT[e] !== undefined ? ENT[e] : /^&#(\d+);$/.test(e) ? String.fromCodePoint(+e.slice(2, -1)) : e));
function htmlPieces(s) {
  const pieces = [];
  // drop <script>/<style> blocks and comments
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const re = new RegExp(TAG.source, 'g'); let last = 0, m;
  while ((m = re.exec(s))) {
    pieces.push(s.slice(last, m.index));
    for (const a of ATTRS) {
      const am = new RegExp(`\\s${a}=("([^"]*)"|'([^']*)')`).exec(m[0]);
      if (am) pieces.push({ attr: decode(am[2] ?? am[3]) });
    }
    last = m.index + m[0].length;
  }
  pieces.push(s.slice(last));
  return pieces.map((p) => (typeof p === 'string' ? decode(p) : p.attr));
}

// a template's text with ${...} as placeholders, renumbered from {0} within each piece
function normalise(piece) {
  let k = 0; const map = new Map();
  const t = piece.replace(/\u0001(\d+)\u0001/g, (_, id) => { if (!map.has(id)) map.set(id, k++); return `{${map.get(id)}}`; });
  return t.replace(/\s+/g, ' ').trim();
}

// ---------- does a string read like UI text? ----------
const SELECTOR = /^[a-z0-9]*(?:[.#][\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?)*$/i;
const isSelectorList = (s) => s.includes(',') && s.split(/\s*,\s*/).every((part) => part.split(/\s+/).every((x) => x === '>' || SELECTOR.test(x)));
function isUiText(s, fromHtml) {
  if (!s || s.length < 2 || s.length > 2000) return false;
  if (isSelectorList(s)) return false; // 'input, textarea, .CodeMirror'
  const bare = s.replace(/\{\d+\}/g, '').trim();
  if (!/[A-Za-z]{2,}/.test(bare)) return false;
  if (/^[\s{}\d.,:;·•—–\-+×/()%#|…→←↑↓]*$/.test(bare)) return false;
  if (/^(https?:|mailto:|data:|blob:|\/|\.\/|#[\w-]|\.[a-z][\w-]*([\s.:#\[>,]|$)|\[[\w-]+)/i.test(bare)) return false; // links, paths, selectors
  if (/\/api\/|=>|\bfunction\s*\(|\$\{|\bvar\(--|^\s*[\w-]+\s*:\s*[^ ]+;|\b(const|let|var) [\w$]+ =|\breturn [\w$(]+;|===|!==|&&|\|\|/.test(s)) return false; // code / CSS
  if (/^[a-z][\w-]*:[\w-]+$/.test(bare)) return false; // event names 'library:changed'
  if (/^M[\d.\s,-]/.test(bare) && /\d/.test(bare)) return false; // SVG path data
  if (/^\\[a-zA-Z]+/.test(bare)) return false; // LaTeX commands
  if (/^@[a-z]+\{?/i.test(bare)) return false; // BibTeX entry types
  if (/\.(js|css|json|png|svg|woff2?|html)(\?|$)/i.test(bare) && !/\s/.test(bare)) return false;
  if (/^\{\d+\} [a-z]{3,}$|^[a-z]{3,} \{\d+\}$/.test(s)) return true; // "{0} reading", "{0} cited"
  if (!/\s/.test(bare)) {
    // one word: UI only when capitalised (Save, Library) and not code (camelCase, snake_case, CONSTANTS, ids)
    if (/[_$]|[a-z][A-Z]|^\d|[=<>{}\[\]]/.test(bare)) return false;
    if (/^[A-Z0-9-]{2,}$/.test(bare) && !fromHtml) return false;
    if (!/^[A-Z]/.test(bare) && !fromHtml) return false;
    if (/^[a-z][\w-]*$/.test(bare) && fromHtml) return /^[a-z]{3,}$/.test(bare); // a lowercase word between tags ("or", "and" are short)
  } else {
    // several words: not a list of class names / selectors / CSS values / attribute soup
    if (/^[a-z0-9-]+( [a-z0-9-]+)*$/.test(bare) && !fromHtml && /-/.test(bare)) return false; // 'ib small primary-btn'
    if (/^[\w-]+( [\w-]+)*$/.test(bare) && !/[A-Z]/.test(bare) && !fromHtml && bare.split(' ').length < 3) {
      // two lowercase words without punctuation: usually class names ('ib small'); text when they are common words
      if (!/^(a|an|the|no|not|and|or|of|in|on|to|by|for|with|from|all|any|this|that|is|are|was|be)\b|\b(the|a|an|of|to|in)\b/.test(bare)) return false;
    }
    if (/[{}]|<[a-z\/!]|[a-z"']>/i.test(bare) && !/^\{\d+\}/.test(s)) return false; // markup, not "Preferences > Claude"
    if (/^[\w.-]+=/.test(bare)) return false;
    if (/^(rgba?|hsla?|calc|translate|scale|rotate)\(/.test(bare)) return false;
    if (/^\d+(px|em|rem|%|ms|s)\b/.test(bare)) return false;
  }
  return true;
}

// ---------- extraction ----------
const MARKUP = /\bwhere\(|\bicon\(|\bi\(|\bic\(|\bkbd|html|Html|HTML|<[a-z/]|\bsvg|Svg|chip|\bbtn|Btn|\brich\(|\bspin\b|\brow\(|\brows\b|\.map\(|\.join\(|\bbadge|\bdot\(/;
function stringsOfJs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const tok of lex(src)) {
    let flat = '', k = 0;
    const looksHtml = /<\/?[a-zA-Z][^>]*>/.test(tok.parts.filter((p) => typeof p === 'string').join(''));
    // in an HTML template an interpolated icon / element / HTML piece is a tag boundary, not part of the text
    for (const p of tok.parts) flat += typeof p === 'string' ? p : looksHtml && MARKUP.test(p.expr) ? '<x-i>' : PH(k++);
    const isHtml = /<\/?[a-zA-Z][^>]*>/.test(flat) || /&[a-z]+;/.test(flat);
    const pieces = isHtml ? htmlPieces(flat) : [flat];
    for (const piece of pieces) {
      const t = normalise(piece);
      if (/^\{\d+\}$/.test(t)) continue;
      // a tip: value is UI text when it has a word in it ("{0} callout ({1})"), unless it is code or a bare list of names
      const tip = tok.prop === 'tip' && !isHtml && /[A-Za-z]{3,}/.test(t.replace(/\{\d+\}/g, '')) && !/=>|\$\{|\.join\(/.test(t);
      if (tip || isUiText(t, isHtml)) found.push({ s: t, line: tok.line });
    }
  }
  return found;
}
function stringsOfHtml(file) {
  let src = fs.readFileSync(file, 'utf8');
  const body = src.replace(/<head>[\s\S]*?<\/head>/i, (h) => (/<title>([^<]*)<\/title>/i.exec(h) || ['', ''])[0]);
  return htmlPieces(body).map((p) => p.replace(/\s+/g, ' ').trim()).filter((t) => isUiText(t, true)).map((s) => ({ s, line: 0 }));
}

function extract({ skip = [] } = {}) {
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js') && !skip.includes(f) && f !== 'i18n.js').sort();
  const all = new Map(); // string -> [file:line]
  const add = (s, where) => { if (!all.has(s)) all.set(s, []); all.get(s).push(where); };
  for (const f of files) for (const { s, line } of stringsOfJs(path.join(JS_DIR, f))) add(s, `${f}:${line}`);
  for (const { s } of stringsOfHtml(path.join(ROOT, 'public', 'index.html'))) add(s, 'index.html');
  return all;
}

module.exports = { lex, htmlPieces, isUiText, extract, stringsOfJs };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const skip = [];
  for (let j = 0; j < argv.length; j++) {
    if (argv[j] === '--skip-file') skip.push(argv[++j]);
    if (argv[j] === '--with') { const w = argv[++j]; const at = skip.indexOf(w); if (at >= 0) skip.splice(at, 1); }
  }
  const all = extract({ skip });
  const I = require('../public/js/i18n.js');
  const zh = require('../public/js/i18n/zh.js');
  const tr = I.createTranslator(zh);
  const missing = [], done = [];
  const notUi = new Set(zh.notUi || []);
  for (const s of notUi) all.delete(s); // strings the dictionary marks as not UI text (headers, prompts, selectors)
  for (const [s, where] of all) (tr.translate(s) !== null ? done : missing).push({ s, where });
  if (argv.includes('--all')) { console.log(JSON.stringify([...all.keys()], null, 1)); process.exit(0); }
  if (argv.includes('--json')) {
    const o = {}; for (const m of missing) o[m.s] = '';
    const at = argv.indexOf('--json'), file = argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null;
    const text = JSON.stringify(o, null, 1);
    if (file) fs.writeFileSync(file, text); else console.log(text);
    process.exit(0);
  }
  if (argv.includes('--missing')) { for (const m of missing) console.log(`${m.where[0]}\t${m.s}`); process.exit(0); }
  const pct = all.size ? ((done.length / all.size) * 100).toFixed(1) : '100';
  console.log(`UI strings found: ${all.size} (files skipped: ${skip.join(', ') || 'none'})`);
  console.log(`translated: ${done.length} (${pct}%), untranslated: ${missing.length}`);
  console.log(`dictionary entries: ${Object.keys(zh.dict).length}, patterns: ${Object.keys(zh.dict).filter((k) => /\{\d+\}/.test(k)).length}, rules: ${zh.rules.length}`);
  for (const m of missing.slice(0, 40)) console.log(`  ${m.where[0]}\t${m.s}`);
  if (missing.length > 40) console.log(`  ... ${missing.length - 40} more (--missing lists all)`);
  if (argv.includes('--check') && missing.length) {
    console.error(`i18n check failed: ${missing.length} UI string${missing.length === 1 ? '' : 's'} without a Chinese translation`);
    process.exitCode = 1;
  }
}
