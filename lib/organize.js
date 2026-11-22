// "Organize from a file": read a Markdown reading list / outline or a .bib file, find its references in the library
// and group them by the file's own headings. Pure: no file access, no network; the library items are passed in.
//   parse(text, { name?, kind?: 'md' | 'bib', level?: 0-6, items }) -> { kind, groups: [{ name, entries }], stats }
//   entry = { line (1-based), raw (<= 200 chars), key?, doi?, arxiv?, title?, match: {id, citekey, title, how} | null,
//             why? (unmatched: what was looked for), bibtex? (.bib only: the entry's own text, for importing it) }
// A paper found under several groups is kept in each of them (the dialog shows the conflict); within one group it is
// listed once. Groups without entries are left out. Tests: node scripts/test-organize.js
const bib = require('./bibtex');
const { normDoi, normTitle } = bib;

const MAX_TEXT = 2 * 1024 * 1024; // bytes of text
const MAX_TEXT_BIB = 8 * 1024 * 1024; // a .bib export with abstracts: about 1.5 KB per entry (3000 entries ~ 5 MB)
const MAX_ENTRIES = 3000;
const RAW_MAX = 200, BIBTEX_MAX = 20000;

// ---------- identifiers in free text ----------
const ARXIV_NEW = '\\d{4}\\.\\d{4,5}', ARXIV_OLD = '[a-z][a-z-]+(?:\\.[A-Za-z]{2})?\\/\\d{7}';
const RE_ARXIV_ANY = new RegExp(
  '(?:arxiv\\.org\\/(?:abs|pdf|html|format|ps)\\/|alphaxiv\\.org\\/(?:abs|pdf|overview)\\/|(?:huggingface\\.co|hf\\.co)\\/papers\\/|semanticscholar\\.org\\/arxiv\\/|arxiv:\\s*|10\\.48550\\/arxiv\\.)(' + ARXIV_NEW + '|' + ARXIV_OLD + ')(?:v\\d+)?'
  + '|(?<![\\w.\\/-])(' + ARXIV_NEW + ')(?:v\\d+)?(?![\\w\\/-]|\\.\\d)', 'gi');
const RE_DOI_ANY = /(?<![A-Za-z0-9.])(10\.\d{4,9}\/[^\s"'<>{}`\]|]+)/g; // also after "_" / "*" (emphasis) and "/" (doi.org)
const normArxiv = (id) => String(id || '').toLowerCase().replace(/v\d+$/, '');

// the arXiv ids in a text: 'arXiv:2412.10345v2', arxiv.org/abs|pdf links, the arXiv DOI, a bare new-style id
function arxivIds(s) {
  const out = [];
  for (const m of String(s || '').matchAll(RE_ARXIV_ANY)) { const id = normArxiv(m[1] || m[2]); if (!out.includes(id)) out.push(id); }
  return out;
}
// the DOIs in a text (without trailing punctuation or an unbalanced closing parenthesis)
function dois(s) {
  const out = [];
  for (const m of String(s || '').matchAll(RE_DOI_ANY)) {
    let d = m[1].replace(/#.*$/, '').replace(/[.,;:*_~]+$/, '');
    while (d.endsWith(')') && (d.match(/\(/g) || []).length < (d.match(/\)/g) || []).length) d = d.slice(0, -1).replace(/[.,;:*_~]+$/, '');
    d = d.replace(/\.pdf$/i, '');
    if (/%[0-9a-f]{2}/i.test(d)) { try { d = decodeURIComponent(d); } catch { /* keep it as written */ } }
    d = normDoi(d);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}
const arxivOfDoi = (d) => { const m = /^10\.48550\/arxiv\.(.+)$/i.exec(d || ''); return m ? normArxiv(m[1]) : ''; };

// ---------- the library index ----------
// item -> its arXiv id from eprint / arxiv / url / doi / journal / note
function itemArxiv(f) {
  for (const v of [f.eprint, f.arxiv, f.arxivid, f.doi, f.url, f.journal, f.note, f.howpublished]) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const ids = arxivIds(v);
    if (ids.length) return ids[0];
  }
  return '';
}
function buildIndex(items) {
  const byKey = new Map(), byDoi = new Map(), byArxiv = new Map(), byTitle = new Map();
  const put = (map, k, it) => { if (k && !map.has(k)) map.set(k, it); };
  for (const it of items || []) {
    const f = it.fields || {};
    put(byKey, String(it.citekey || '').toLowerCase(), it);
    put(byDoi, normDoi(f.doi), it);
    put(byArxiv, itemArxiv(f), it);
    const t = normTitle(f.title);
    if (t.length >= 12) put(byTitle, t, it);
  }
  return { byKey, byDoi, byArxiv, byTitle };
}
const matchOf = (it, how) => ({ id: it.id, citekey: it.citekey || '', title: String((it.fields && it.fields.title) || it.citekey || '').replace(/[{}]/g, '').slice(0, 300), how });
// citekey -> DOI -> arXiv id -> title. A cite key is only a name: when the DOI, arXiv id or title of the entry point at
// another paper of the library, that paper wins (a .bib from elsewhere can reuse a key the library gave another paper).
// Keys like li2026learning (name + year + first word) collide often: a key alone matches only when the entry has no
// usable title, its title is the paper's (one may be the other plus a subtitle), or its DOI / arXiv id is the paper's.
function findMatch(idx, e) {
  const t = e.title ? normTitle(e.title) : '';
  const byId = (e.doi && idx.byDoi.get(e.doi) && [idx.byDoi.get(e.doi), 'doi'])
    || (e.arxiv && idx.byArxiv.get(e.arxiv) && [idx.byArxiv.get(e.arxiv), 'arxiv'])
    || (t.length >= 12 && (idx.byTitle.get(t) || prefixHit(idx, t)) && [idx.byTitle.get(t) || prefixHit(idx, t), 'title']) || null;
  const k = e.key ? idx.byKey.get(String(e.key).toLowerCase()) : null;
  if (k && byId && byId[0] === k) return matchOf(k, 'citekey');
  if (k && !byId) {
    const kt = normTitle((k.fields || {}).title);
    const kf = k.fields || {};
    const sameId = (e.doi && normDoi(kf.doi) === e.doi) || (e.arxiv && itemArxiv(kf) === e.arxiv);
    if (t.length < 12 || !kt || t.startsWith(kt) || kt.startsWith(t) || sameId) return matchOf(k, 'citekey');
    return null; // the same key, but another paper: it can be imported
  }
  return byId ? matchOf(byId[0], byId[1]) : null;
}
function whyNot(e) {
  const what = [e.key && `cite key ${e.key}`, e.doi && `DOI ${e.doi}`, e.arxiv && `arXiv ${e.arxiv}`, e.title && 'title'].filter(Boolean);
  return what.length ? `No paper of the library has this ${what.join(', ')}` : 'Nothing to look for';
}

// ---------- groups ----------
// emoji, numbering ("1.", "1.2", "2)", "A."), inline markdown, links and a count ("World models (7)", the notes.md
// export of this app) removed from a heading
function cleanHeading(s) {
  return String(s || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '').replace(/`([^`]*)`/g, '$1').replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:\d+|[IVX]+)(?:\.\d+)*[.)]?|[A-Z][.)])\s+/, '').replace(/^\d+(?:\.\d+)+\s*/, '')
    .replace(/\s*\(\d{1,3}\)$/, '').replace(/[\s:–—-]+$/, '').trim().slice(0, 200);
}
// a comment line of a .bib file as a group heading: '% ---- World models ----', '%% Section: X', '% X'. Not a heading:
// boilerplate (encoding, "generated by"), separator lines, sentences (the notes this app writes end with a period), notes
// (TODO / FIXME / NOTE) and commented-out entries or fields (with "%", "@" or "=")
const BOILER = /^(?:encoding\b|this file was|created (?:by|with)|generated\b|exported\b|jabref|bibdesk|zotero|mendeley|annotated bibliography|comparison table|answers per paper|contains characters|only the entries|cited entries|\\nocite)/i;
function bibHeading(s) {
  let h = String(s || '').replace(/^[\s\-=*#~_+.:|<>\/\\%]+|[\s\-=*#~_+:|<>\/\\%]+$/g, '').trim();
  h = h.replace(/^(?:section|group|category|topic|heading|part)\s*(?:\d+\s*)?[:\-–—]\s*/i, '').trim();
  if (/[%@=]/.test(h) || /^(?:todo|fixme|note|xxx)\b/i.test(h)) return null;
  h = cleanHeading(h);
  if (!h || h.length > 80 || /[.;]$/.test(h) || h.split(/\s+/).length > 10 || BOILER.test(h) || /^[\W_]+$/.test(h)) return null;
  return h;
}

function collector(items) {
  const idx = buildIndex(items);
  const groups = new Map(); // name -> { name, entries, seen }
  let count = 0, truncated = false;
  function add(groupName, e) {
    if (count >= MAX_ENTRIES) { truncated = true; return; }
    let name = String(groupName || '');
    if (/^uncategori[sz]ed$/i.test(name.trim())) name = ''; // "Uncategorized" of an export: no category to give

    const out = { line: e.line, raw: String(e.raw || '').replace(/\s+/g, ' ').trim().slice(0, RAW_MAX) };
    for (const k of ['key', 'doi', 'arxiv', 'title']) if (e[k]) out[k] = String(e[k]).slice(0, 500);
    out.match = e.match !== undefined ? e.match : findMatch(idx, out);
    if (!out.match) out.why = out.key && idx.byKey.has(out.key.toLowerCase()) ? `The paper with cite key ${out.key} in the library is another paper (its title differs)` : whyNot(out);
    if (e.bibtex) out.bibtex = String(e.bibtex).slice(0, BIBTEX_MAX);
    let g = groups.get(name);
    if (!g) { g = { name, entries: [], seen: new Set() }; groups.set(name, g); }
    const sig = out.match ? 'id:' + out.match.id : 'u:' + [out.key && out.key.toLowerCase(), out.doi, out.arxiv, out.title && normTitle(out.title)].join('|');
    if (g.seen.has(sig)) return; // the same paper twice under one heading (a reading pack names it in the heading and by key)
    g.seen.add(sig);
    g.entries.push(out);
    count++;
  }
  function result(kind) {
    const list = [...groups.values()].filter((g) => g.entries.length).map((g) => ({ name: g.name, entries: g.entries }));
    const entries = list.reduce((s, g) => s + g.entries.length, 0);
    const matched = list.reduce((s, g) => s + g.entries.filter((e) => e.match).length, 0);
    return { kind, groups: list, stats: { entries, matched, unmatched: entries - matched, groups: list.length, ...(truncated ? { truncated: true } : {}) } };
  }
  return { idx, add, result, get count() { return count; }, get truncated() { return truncated; } };
}

// ---------- .bib ----------
// the entries of a .bib file with their position: [{ at, end, type, text }] (@comment / @string / @preamble included)
function scanBib(src) {
  const out = [];
  const re = /@\s*([A-Za-z]+)\s*([{(])/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m[2], start = m.index;
    if (/(?:^|[^\\])%/.test(src.slice(src.lastIndexOf('\n', start - 1) + 1, start))) { re.lastIndex = start + 1; continue; } // commented out
    let i = re.lastIndex, depth = 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (open === '{') { if (c === '{') depth++; else if (c === '}' && --depth === 0) break; }
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ')' && depth === 1) { depth = 0; break; }
    }
    const end = Math.min(src.length, i + 1);
    out.push({ at: start, end, type: m[1].toLowerCase(), text: src.slice(start, end), body: src.slice(re.lastIndex, Math.max(re.lastIndex, end - 1)) });
    re.lastIndex = end;
  }
  return out;
}
const cleanBibTitle = (t) => String(t || '').replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

// a decorated comment heading: '% ---- X ----', '%% X', '% Section: X' (or a one-line @comment{X}, see parseBib)
const decorated = (t) => /^%{2,}/.test(t) || /[-=*#~_+]{3,}/.test(t) || /^%+\s*(?:section|group|category|topic|heading|part)\b/i.test(t);
function parseBib(src, c) {
  const lineAt = lineIndex(src);
  const list = scanBib(src);
  // the heading-like comment lines between two entries: [{ h, deco, above }] (above: no blank line down to the entry)
  const gapHeads = (text) => {
    const ls = text.split('\n'), out = [];
    ls.forEach((l, j) => {
      const t = l.trim();
      if (!t.startsWith('%') || j === ls.length - 1) return;
      const h = bibHeading(t.replace(/^%+/, ''));
      const rule = (x) => x !== undefined && /^%+\s*[-=*#~_+]{3,}\s*$/.test(x.trim()); // a boxed heading: rules above / below
      if (h) out.push({ h, deco: decorated(t) || rule(ls[j - 1]) || rule(ls[j + 1]), above: ls.slice(j + 1, -1).every((x) => x.trim()) });
    });
    return out;
  };
  const oneLine = (e) => e.type === 'comment' && !/^\s*jabref-meta\s*:/i.test(e.body) && !e.body.trim().includes('\n') && bibHeading(e.body.trim());
  let pos = 0;
  const gaps = list.map((e) => { const g = gapHeads(src.slice(pos, e.at)); pos = e.end; return g; });
  // a file with decorated headings takes only those; else a plain '% X' counts, but not right above an entry (a note on it)
  const anyDeco = gaps.some((g) => g.some((x) => x.deco)) || list.some(oneLine);
  let heading = '';
  for (const [n, e] of list.entries()) {
    for (const x of gaps[n]) if (anyDeco ? x.deco : !x.above) heading = x.h;
    if (e.type === 'comment') { const h = oneLine(e); if (h) heading = h; continue; }
    if (e.type === 'string' || e.type === 'preamble') continue;
    const parsed = bib.parse(e.text)[0];
    if (!parsed) continue;
    const f = parsed.fields;
    const group = typeof f.groups === 'string' && f.groups.trim() ? f.groups.split(/[,;]/)[0].trim() : heading;
    const doi = normDoi(f.doi);
    c.add(group, {
      line: lineAt(e.at), raw: e.text, key: parsed.key, doi: doi || undefined,
      arxiv: arxivOfDoi(doi) || itemArxiv({ ...f, doi: '' }) || undefined,
      title: cleanBibTitle(f.title) || undefined, bibtex: e.text,
    });
    if (c.truncated) break;
  }
}

// ---------- Markdown ----------
// what a line may name as a title: the whole text, the text before " - " / " — " / "(" / "." / ", " / " | " / ": ",
// each ". " sentence (APA / Scholar "Cite": "Hafner, D. (2023). Title. arXiv"), quoted or italic text
function titleCandidates(text) {
  const s = String(text || '').trim();
  const out = new Set([s]);
  for (const sep of [' - ', ' — ', ' – ', ' (', '(', '. ', '.', ', ', ' | ', ': ']) { const i = s.indexOf(sep); if (i > 0) out.add(s.slice(0, i)); }
  for (const part of s.split(/\.\s+|\)\.\s*/)) out.add(part.replace(/\.$/, ''));
  out.add(s.replace(/\s*\(\d{4}[a-z]?\)\s*$/, ''));
  for (const m of s.matchAll(/["“]([^"”]{12,400})["”]/g)) out.add(m[1].replace(/[.,]$/, ''));
  for (const m of s.matchAll(/(?:^|\s)[*_]([^*_]{12,400})[*_](?=\s|[.,;:]|$)/g)) out.add(m[1]);
  return [...out].map((t) => t.trim()).filter((t) => normTitle(t).length >= 12);
}
// inline markdown off a line: list markers, check boxes, quote markers, bold / italic markers, links -> their text
function plainLine(l) {
  return String(l).replace(/^\s*(?:>\s*)*/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
// the one library paper whose (normalised) title begins with `n`, when `n` is long enough not to be a phrase that many
// titles share: a reading list often shortens a title ("Mem-World: ... World Models" without its last words)
function prefixHit(idx, n) {
  if (!n || n.length < 24) return null;
  let hit = null;
  for (const [full, it] of idx.byTitle) if (full.startsWith(n) && n.length >= full.length * 0.4) { if (hit && hit !== it) return null; hit = it; }
  return hit;
}
function titleMatch(idx, text) {
  const cands = titleCandidates(text);
  for (const t of cands) { const it = idx.byTitle.get(normTitle(t)); if (it) return { it, title: t }; }
  for (const t of cands) { const it = prefixHit(idx, normTitle(t)); if (it) return { it, title: t }; }
  return null;
}
const RE_CITE = /\\(?:no)?cite[a-zA-Z]*\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;
const RE_PANDOC_BRACKET = /\[([^\[\]]*@[^\[\]]*)\]/g;
const RE_AT_KEY = /(?:^|[\s\[;(])-?@([A-Za-z0-9_][\w:.#$%&+?<>~\/-]*)/g;

// the references of one line -> [{ key?, doi?, arxiv?, title?, match? }]
function lineRefs(idx, line) {
  const refs = [];
  const found = []; // [position, key], listed in the order of the line
  const addKey = (at, k) => { k = String(k).trim().replace(/[.,:;]+$/, ''); if (k) found.push([at, k]); };
  for (const m of line.matchAll(RE_CITE)) for (const k of m[1].split(',')) if (k.trim() !== '*') addKey(m.index, k);
  for (const m of line.matchAll(RE_PANDOC_BRACKET)) for (const k of m[1].matchAll(RE_AT_KEY)) addKey(m.index + k.index, k[1]);
  // pandoc @key outside brackets and `key` in backticks only when the library has that cite key (else e-mail-like noise)
  const blank = (x) => ' '.repeat(x.length);
  const noCite = line.replace(RE_CITE, blank).replace(RE_PANDOC_BRACKET, blank);
  for (const m of noCite.matchAll(RE_AT_KEY)) if (idx.byKey.has(m[1].replace(/[.,:;]+$/, '').toLowerCase())) addKey(m.index, m[1]);
  for (const m of noCite.matchAll(/`([^`\s]{2,100})`/g)) if (idx.byKey.has(m[1].toLowerCase())) addKey(m.index, m[1]);
  // Obsidian [[citekey]], [[citekey|alias]], [[Title#part]]: a cite key of the library, else a title
  const wiki = [];
  for (const m of line.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const k = m[1].trim().replace(/^@/, '');
    if (idx.byKey.has(k.toLowerCase())) addKey(m.index, k); else wiki.push(k);
  }
  const keys = [];
  for (const [, k] of found.sort((a, b) => a[0] - b[0])) if (!keys.some((x) => x.toLowerCase() === k.toLowerCase())) keys.push(k);
  for (const k of keys) refs.push({ key: k });
  if (keys.length) return refs;

  // identifiers: one entry per distinct paper (an arXiv link and its arXiv DOI are one)
  const ids = [];
  for (const d of dois(line)) { const ax = arxivOfDoi(d); ids.push(ax ? { doi: d, arxiv: ax } : { doi: d }); }
  for (const a of arxivIds(line)) if (!ids.some((x) => x.arxiv === a)) ids.push({ arxiv: a });
  const plain = plainLine(line).replace(/(?:\s+#[\w\/-]+)+$/, ''); // without trailing #tags
  const links = [...line.matchAll(/\[([^\]]{12,400})\]\(([^)]*)\)/g)].map((m) => m[1]);
  // also: **bold** / __bold__ spans, the [[Title]] of a wiki link, the cells of a table row (Notion, awesome lists)
  const bold = [...line.matchAll(/(\*\*|__)(?=\S)(.+?\S)\1/g)].map((m) => m[2]);
  const cells = /^\s*\|/.test(line) ? line.split('|').map((x) => plainLine(x)).filter(Boolean) : [];
  let tm = null;
  for (const t of [...links, ...wiki, ...bold, ...cells, plain]) { tm = titleMatch(idx, t); if (tm) break; }
  if (ids.length > 1) return ids;
  if (ids.length === 1) return [{ ...ids[0], title: tm ? tm.title : undefined }];
  return tm ? [{ title: tm.title }] : [];
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
function parseMd(src, c, { level = 0, name = '' } = {}) {
  const lines = src.split('\n');
  const heads = [null, null, null, null, null, null, null]; // heads[n] = the current heading of level n
  const groupNow = () => { for (let l = level || 6; l >= 1; l--) if (heads[l] !== null) return heads[l]; return ''; };
  let top = 0; // the first line after a front matter
  const fenceAt = (l) => /^\s{0,3}(`{3,}|~{3,})/.exec(l);
  const atx = (l) => /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
  const setext = (j) => j + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[j + 1]) && lines[j].trim() && !LIST_ITEM.test(lines[j])
    && !/^\s*[>|]/.test(lines[j]) && !atx(lines[j]) && !fenceAt(lines[j]) && (j <= top || !lines[j - 1].trim()) ? (lines[j + 1].trim()[0] === '=' ? 1 : 2) : 0;
  // the one paper of the library that the paragraph right under a heading names ("`citekey` · Read" of a reading pack,
  // "`citekey` — authors" of the notes export), looked for in its first two lines; a list under it is no such line
  function paperBelow(j) {
    const out = [];
    let seen = 0;
    for (let k = j + 1; k < lines.length && seen < 2; k++) {
      const l = lines[k];
      if (!l.trim()) { if (seen) break; continue; }
      if (atx(l) || fenceAt(l) || LIST_ITEM.test(l) || setext(k)) break;
      seen++;
      for (const r of lineRefs(c.idx, l)) { const m = findMatch(c.idx, r); if (m && !out.some((x) => x.m.id === m.id)) out.push({ r, m }); }
    }
    return out.length === 1 ? out[0] : null;
  }
  // a heading is a paper (an entry of the group above it, and it ends the same-level group before it) when it looks
  // like one: the paper is named right under it, or its text is a library title with a "(2021)" year or of 5+ words.
  // Else it is a group ("## Deep learning" stays a group, also when the library has a paper of that title).
  function heading(n, text, i, raw) {
    const clean = cleanHeading(text), year = /\(\d{4}[a-z]?\)\s*$/.test(text);
    const asTitle = titleMatch(c.idx, clean.replace(/\s*\(\d{4}[a-z]?\)\s*$/, ''));
    const below = paperBelow(i);
    const own = lineRefs(c.idx, text).filter((r) => r.key || r.doi || r.arxiv).map((r) => ({ r, m: findMatch(c.idx, r) })).filter((x) => x.m); // a key / id in it
    let refs = null;
    if (below && (year || (asTitle && asTitle.it.id === below.m.id) || own.some((x) => x.m.id === below.m.id)
      || [String(below.m.citekey).toLowerCase(), 'untitled'].includes(clean.toLowerCase()))) refs = [below.r];
    else if (asTitle && (year || clean.split(/\s+/).length >= 5)) refs = [{ title: asTitle.title }];
    else if (own.length) refs = own.map((x) => x.r);
    if (refs) {
      for (let l = n; l <= 6; l++) heads[l] = null;
      for (const r of refs) c.add(groupNow(), { line: i + 1, raw, ...r });
      return;
    }
    heads[n] = clean;
    for (let l = n + 1; l <= 6; l++) heads[l] = null;
  }
  let fence = null, i = 0;
  if (/^---\s*$/.test(lines[0] || '')) { // YAML front matter
    const end = lines.findIndex((l, k) => k > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = top = end + 1;
  }
  for (; i < lines.length && !c.truncated; i++) {
    const line = lines[i];
    const f = fenceAt(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = atx(line);
    if (h) { heading(h[1].length, h[2], i, line); continue; }
    const se = setext(i);
    if (se) { heading(se, line.trim(), i, line); i++; continue; }
    if (!line.trim()) continue;
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('|')) continue; // the |---|---| row of a table
    for (const r of lineRefs(c.idx, line)) c.add(groupNow(), { line: i + 1, raw: line, ...r });
  }
  // a note exported by this app (notes/<citekey>.md) names no other paper: it stands for its own paper
  if (!c.count && name) {
    const base = String(name).split(/[\\/]/).pop().replace(/\.(md|markdown|txt)$/i, '');
    if (c.idx.byKey.has(base.toLowerCase())) c.add('', { line: 1, raw: name, key: base });
  }
}

// ---------- entry point ----------
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
}
const BIB_TYPES = /(?:^|\n)\s*@\s*(?:article|inproceedings|incollection|misc|book|inbook|booklet|phdthesis|mastersthesis|techreport|online|unpublished|conference|manual|proceedings|thesis|report|software|dataset|electronic)\s*[{(]/i;
function detectKind(text, name, kind) {
  if (kind === 'md' || kind === 'bib') return kind;
  const ext = (/\.([a-z]+)$/i.exec(String(name || '')) || [])[1];
  if (ext && /^(bib|bibtex)$/i.test(ext)) return 'bib';
  if (ext && /^(md|markdown|txt)$/i.test(ext)) return 'md';
  return BIB_TYPES.test(text) && !/(?:^|\n)#{1,6}\s/.test(text) ? 'bib' : 'md';
}
function parse(text, { name = '', kind, level = 0, items = [] } = {}) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const k = detectKind(src, name, kind);
  const c = collector(items);
  if (k === 'bib') parseBib(src, c); else parseMd(src, c, { level, name });
  return c.result(k);
}

module.exports = { parse, MAX_TEXT, MAX_TEXT_BIB, MAX_ENTRIES, buildIndex, findMatch, arxivIds, dois, detectKind, cleanHeading, bibHeading };
