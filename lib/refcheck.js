// Bibliography hygiene of a LaTeX project (routes: lib/routes/projects.js; UI: public/js/write.js).
//   citedKeys(texts, extra)  the keys a project cites: \cite-family commands of its .tex files (public/js/refscan.js,
//                            the scanner the editor uses too) plus what the last LaTeX run wrote to .aux / .bcf, so a
//                            citation made through an own macro is found from the second compile on
//   pickCited(items, want)   the library items for those keys (and the entries they cross-reference)
//   check({...})             the references check: undefined keys, keys defined more than once, entries never cited,
//                            cited entries without a year or venue or that are still an arXiv preprint
// Nothing here reads or writes files; the caller passes the texts in.
const bib = require('./bibtex');
const scan = require('../public/js/refscan.js');

const isTex = (p) => /\.(tex|ltx)$/i.test(p);
const isBib = (p) => /\.bib$/i.test(p);

// texts: [{path, text}] - the .tex files; aux: the text of .aux / .bcf files of the last run (may be empty)
// -> {keys, all, uses: Map key -> how often the .tex files cite it}
function citedKeys(texts, aux = []) {
  const keys = new Set(), uses = new Map();
  let all = false;
  for (const t of texts) {
    if (!isTex(t.path)) continue;
    const c = scan.cites(t.text);
    if (c.all) all = true;
    for (const u of c.uses) { keys.add(u.key); uses.set(u.key, (uses.get(u.key) || 0) + 1); }
  }
  for (const a of aux) {
    for (const m of String(a).matchAll(/\\(?:citation|abx@aux@cite(?:\{[^{}]*\})?)\{([^{}]*)\}/g)) for (const k of m[1].split(',')) { if (k.trim() === '*') all = true; else if (k.trim()) keys.add(k.trim()); }
    for (const m of String(a).matchAll(/<bcf:citekey[^>]*>([^<]+)<\/bcf:citekey>/g)) { if (m[1].trim() === '*') all = true; else keys.add(m[1].trim()); }
  }
  return { keys, all, uses };
}

// BibTeX does not tell Foo2020 from foo2020, so neither does the choice of entries
function pickCited(items, want) {
  if (want.all) return items;
  const low = new Set([...want.keys].map((k) => k.toLowerCase()));
  const byKey = new Map(items.map((i) => [String(i.citekey).toLowerCase(), i]));
  const take = new Set();
  const add = (i, depth) => {
    if (!i || take.has(i)) return;
    take.add(i);
    const x = i.fields && (i.fields.crossref || i.fields.xref);
    if (x && depth < 3) add(byKey.get(String(x).toLowerCase()), depth + 1);
  };
  for (const i of items) if (low.has(String(i.citekey).toLowerCase())) add(i, 0);
  return items.filter((i) => take.has(i));
}

// what a careful author would still look up before submitting
function gaps(type, f) {
  const has = (k) => !!String(f[k] || '').trim();
  const out = [];
  if (!has('year') && !has('date')) out.push('no year');
  const venue = ['journal', 'journaltitle', 'booktitle', 'publisher', 'school', 'institution', 'organization', 'howpublished'].some(has);
  const arxivish = /arxiv|corr\b/i.test([f.journal, f.journaltitle, f.howpublished, f.publisher, f.note].join(' ')) || (!venue && (has('eprint') || /arxiv\.org/i.test(f.url || '')));
  const published = has('booktitle') || ((has('journal') || has('journaltitle')) && !/arxiv|corr\b/i.test((f.journal || '') + (f.journaltitle || '')));
  if (arxivish && !published) out.push('arXiv preprint only - check for a published version');
  else if (!venue && type !== 'online' && type !== 'software') out.push(type === 'article' ? 'no journal' : 'no venue (journal, book title or publisher)');
  if (!has('author') && !has('editor')) out.push('no author');
  if (!has('title')) out.push('no title');
  return out;
}

const CAP = 500;
// files: [{path, text}] every .tex / .ltx / .bib file of the project; generated: path of the references.bib the app
// writes (or null); library: does the library supply entries to this project; items: the library items;
// outside: .bib files the project loads that are not among `files` (their keys are unknown, so nothing is called
// undefined); alsoCited: keys the last LaTeX run recorded (a citation through an own macro is not "never cited")
function check({ files, generated, library, items, scope, outside = [], alsoCited = null }) {
  const uses = new Map(); // key -> [{file, line, col, len}]
  let all = false;
  const defs = [];        // {key, file, line} of the project's own .bib files and \bibitem lines
  const fields = new Map(); // "file\nkey" -> {type, fields} for the own .bib entries
  const bibFiles = [];
  for (const f of files) {
    if (isTex(f.path)) {
      const c = scan.cites(f.text);
      if (c.all) all = true;
      for (const u of c.uses) {
        if (!uses.has(u.key)) uses.set(u.key, []);
        uses.get(u.key).push({ file: f.path, line: u.line + 1, col: u.ch + 1, len: u.len });
      }
      for (const b of scan.bibitems(f.text)) defs.push({ key: b.key, file: f.path, line: b.line + 1, item: true });
    } else if (isBib(f.path) && f.path !== generated) {
      const keys = scan.bibKeys(f.text);
      bibFiles.push({ path: f.path, entries: keys.length });
      for (const k of keys) defs.push({ key: k.key, file: f.path, line: k.line + 1 });
      try { for (const e of bib.parse(f.text)) if (!fields.has(f.path + '\n' + e.key)) fields.set(f.path + '\n' + e.key, e); } catch { /* a file that cannot be parsed still lists its keys */ }
    }
  }
  const libKeys = new Map((library ? items : []).map((i) => [i.citekey, i]));
  const own = new Map(); // key -> its definitions in the project
  for (const d of defs) { if (!own.has(d.key)) own.set(d.key, []); own.get(d.key).push(d); }
  const defined = (k) => own.has(k) || libKeys.has(k);
  const allKeys = [...new Set([...own.keys(), ...libKeys.keys()])];

  const undefinedKeys = [];
  if (!outside.length) {
    for (const [key, list] of uses) {
      if (defined(key)) continue;
      // looking for similar keys is the costly part: only for the rows that are shown
      undefinedKeys.push({ key, uses: list.slice(0, 50), count: list.length, suggest: undefinedKeys.length < CAP ? scan.near(key, allKeys) : [] });
    }
  }

  // defined more than once: BibTeX compares keys without regard to case
  const groups = new Map();
  for (const d of defs) { const l = d.key.toLowerCase(); if (!groups.has(l)) groups.set(l, []); groups.get(l).push({ key: d.key, file: d.file, line: d.line }); }
  for (const [k] of libKeys) { const l = k.toLowerCase(); if (groups.has(l)) groups.get(l).push({ key: k, library: true }); }
  const duplicates = [...groups.values()].filter((g) => g.length > 1).map((g) => ({ key: g[0].key, where: g }));

  const unused = [];
  const lowCited = new Set([...uses.keys(), ...(alsoCited || [])].map((k) => String(k).toLowerCase()));
  if (!all) for (const d of defs) if (!d.item && !lowCited.has(d.key.toLowerCase())) unused.push({ key: d.key, file: d.file, line: d.line });

  const incomplete = [];
  for (const key of uses.keys()) {
    const d = own.get(key);
    if (d) {
      const e = d[0].item ? null : fields.get(d[0].file + '\n' + key);
      const g = e ? gaps(e.type, e.fields || {}) : [];
      if (g.length) incomplete.push({ key, file: d[0].file, line: d[0].line, issues: g });
    } else if (libKeys.has(key)) {
      const i = libKeys.get(key), g = gaps(i.type, i.fields || {});
      if (g.length) incomplete.push({ key, library: true, id: i.id, title: String(i.fields.title || '').slice(0, 200), issues: g });
    }
  }

  const citedInLibrary = library ? pickCited(items, { keys: new Set(uses.keys()), all }).length : 0;
  const cap = (list) => list.slice(0, CAP);
  return {
    scope, library, generated, nociteAll: all, bibFiles, outside,
    counts: { cited: uses.size, libraryEntries: items.length, citedInLibrary, undefined: undefinedKeys.length, duplicates: duplicates.length, unused: unused.length, incomplete: incomplete.length },
    // for the live marks of the editor: every key the project's own files define
    defs: defs.map((d) => ({ key: d.key, file: d.file, line: d.line })),
    undefined: cap(undefinedKeys), duplicates: cap(duplicates), unused: cap(unused), incomplete: cap(incomplete),
  };
}

module.exports = { citedKeys, pickCited, check, gaps };
