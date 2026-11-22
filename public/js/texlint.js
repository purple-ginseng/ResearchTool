/* Spelling and writing checks for LaTeX source, used by the Write editor (write.js). No UI here -> RT.texlint:
     scan(text, {off, known})  -> problems [{type, from: {line, ch}, to: {line, ch}, msg, word?, fix?: {from, to, text}}]
                                  type: 'spell' | 'repeat' | 'tie' | 'quotes' | 'pairs' | 'todo'  (RULES below)
     load()                    -> Promise: fetches the English word list once (GET /api/spell/words)
     checker([Set, ...])       -> {known(word), suggest(word)} for the word list plus the given sets of lower-case words
   scan() reads the text the way LaTeX does, roughly: comments, commands, math ($ $, \( \), \[ \], math environments),
   verbatim and drawing environments, and the arguments that are keys or code (\cite, \ref, \label, \includegraphics,
   \usepackage ...) are never treated as prose. The word list holds base forms only, so known() strips the usual
   endings and prefixes and accepts British spellings; it would rather miss a mistake than flag a correct word.
   Tests: node scripts/test-texlint.js */
(() => {
const root = typeof window !== 'undefined' ? window : globalThis;
const RT = root.RT || (root.RT = {});

const RULES = [
  ['spell', 'Spelling'],
  ['repeat', 'Repeated words'],
  ['tie', 'Missing ~ before \\ref and \\cite'],
  ['quotes', 'Straight quotes "'],
  ['pairs', 'Unmatched braces and environments'],
  ['todo', 'TODO notes'],
];

// ---------------- the word list ----------------
let dict = null, loading = null;
function load() {
  if (dict) return Promise.resolve(true);
  if (!loading) {
    loading = fetch('/api/spell/words').then(async (r) => {
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `The word list could not be loaded (${r.status})`); }
      return r.text();
    }).then((t) => { dict = new Set(t.split('\n')); return true; }).catch((e) => { loading = null; throw e; });
  }
  return loading;
}
const setWords = (words) => { dict = new Set(words); }; // for the tests

const ROMAN = /^x{0,3}(ix|iv|v?i{0,3})$/;
const CONTRACTIONS = new Set(["can't", "won't", "shan't", "ain't", "let's", "o'clock"]);
const PREFIXES = ['un', 're', 'non', 'pre', 'sub', 'multi', 'over', 'under', 'inter', 'intra', 'semi', 'self', 'super', 'hyper', 'meta', 'micro', 'macro',
  'mis', 'post', 'anti', 'auto', 'cross', 'pseudo', 'quasi', 'tele', 'trans', 'dis', 'co', 'de'];
// the words `w` (lower case) may be a form of: plural, past, -ing, -ly ..., an American spelling, the word without a prefix
function bases(w) {
  const out = [], n = w.length;
  const add = (b, min = 4) => { if (b.length >= min && b !== w && !out.includes(b)) out.push(b); };
  const end = (s) => n > s.length + 1 && w.endsWith(s);
  const cut = (k, plus = '', min = 4) => add(w.slice(0, n - k) + plus, min);
  const undouble = (k) => { const b = w.slice(0, n - k); if (b.length >= 4 && b[b.length - 1] === b[b.length - 2]) add(b.slice(0, -1), 3); };
  // the everyday endings may leave a three-letter word (used -> use, boxes -> box); the others need four letters
  if (end('ies')) cut(3, 'y');
  if (end('es')) cut(2, '', 3);
  if (end('s') && !end('ss') && !end('us')) cut(1, '', 3);
  if (end('ied')) cut(3, 'y');
  if (end('ed')) { cut(2, '', 3); cut(1, '', 3); undouble(2); }
  if (end('ing')) { cut(3, '', 3); cut(3, 'e', 3); undouble(3); }
  if (end('ily')) cut(3, 'y');
  if (end('ally')) cut(4);
  if (end('bly')) cut(1, 'e');
  if (end('ly')) cut(2, '', 3);
  if (end('ier')) cut(3, 'y');
  if (end('iest')) cut(4, 'y');
  if (end('er')) { cut(2, '', 3); cut(1, '', 3); undouble(2); }
  if (end('est')) { cut(3, '', 3); cut(2, '', 3); undouble(3); }
  if (end('iness')) cut(5, 'y');
  if (end('ness')) cut(4);
  if (end('less')) cut(4);
  if (end('ful')) cut(3);
  if (end('ment')) cut(4);
  if (end('ability')) cut(7, 'able');
  if (end('ibility')) cut(7, 'ible');
  if (end('able')) { cut(4); cut(4, 'e'); undouble(4); }
  if (end('ity')) { cut(3); cut(3, 'e'); }
  if (end('ization')) cut(5, 'e');
  if (end('ation')) { cut(5); cut(5, 'e'); }
  if (end('ion')) { cut(3); cut(3, 'e'); }
  if (end('ize')) { cut(3); cut(3, 'e'); cut(3, 'y'); }
  for (const s of ['wise', 'like', 'free', 'based', 'aware']) if (end(s)) cut(s.length);
  // British -> American
  const us = w.replace(/isation/, 'ization').replace(/is(e|ed|es|ing|er|ers|able)$/, 'iz$1').replace(/ys(e|ed|es|ing|er|ers)$/, 'yz$1')
    .replace(/our(s|ed|ing|able|al|ful|less|ite|ites|hood)?$/, (m, s) => 'or' + (s || '')).replace(/tre(s|d)?$/, (m, s) => 'ter' + (s || ''))
    .replace(/ogue(s)?$/, (m, s) => 'og' + (s || '')).replace(/ence(s)?$/, (m, s) => 'ense' + (s || ''));
  add(us);
  for (const p of PREFIXES) if (w.startsWith(p) && n - p.length >= 4) add(w.slice(p.length));
  return out;
}
function checker(extra = []) {
  const memo = new Map();
  const has = (w) => dict.has(w) || extra.some((s) => s.has(w));
  const form = (w, depth) => { // w or something it is a form of is a word
    if (has(w)) return true;
    if (depth >= 3) return false;
    for (const b of bases(w)) if (form(b, depth + 1)) return true;
    return false;
  };
  const part = (p) => {
    if (p.length < 3 || /[A-Z]/.test(p.slice(1)) || !/^[A-Za-z]+$/.test(p)) return true; // short, an acronym or CamelCase, not plain Latin letters
    const l = p.toLowerCase();
    if (ROMAN.test(l)) return true; // (iii), Section IV
    if (!memo.has(l)) memo.set(l, form(l, 0));
    return memo.get(l);
  };
  // true unless the word is (very likely) misspelt; always true before the word list is loaded
  function known(word) {
    if (!dict) return true;
    let w = String(word).replace(/’/g, "'");
    if (has(w.toLowerCase()) || CONTRACTIONS.has(w.toLowerCase())) return true;
    w = w.replace(/n't$/i, '').replace(/'(s|ll|re|ve|d|m)$/i, '');
    return w.split("'").every(part);
  }
  // up to 6 words one edit away from `word`, the likeliest first
  function suggest(word) {
    if (!dict) return [];
    const w = String(word).toLowerCase(), n = w.length, out = [], seen = new Set([w]);
    const ok = (c) => c.length >= 2 && (has(c) || (/(s|ed|ing|ly)$/.test(c) && bases(c).some(has)));
    const tryAdd = (c, rank) => { if (!seen.has(c)) { seen.add(c); if (ok(c)) out.push({ c, rank: rank + (c[0] === w[0] ? 0 : 0.5) }); } };
    const AZ = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < n - 1; i++) tryAdd(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2), 0);          // two letters swapped
    for (let i = 0; i <= n; i++) for (const ch of AZ) tryAdd(w.slice(0, i) + ch + w.slice(i), 1);          // one letter missing
    for (let i = 0; i < n; i++) for (const ch of AZ) if (ch !== w[i]) tryAdd(w.slice(0, i) + ch + w.slice(i + 1), 2); // one wrong letter
    for (let i = 0; i < n; i++) tryAdd(w.slice(0, i) + w.slice(i + 1), 3);                                 // one letter too many
    out.sort((a, b) => a.rank - b.rank);
    const list = out.slice(0, 6).map((x) => x.c);
    for (let i = 2; i <= n - 2 && list.length < 7; i++) { if (has(w.slice(0, i)) && has(w.slice(i))) { list.push(w.slice(0, i) + ' ' + w.slice(i)); break; } } // a missing space
    const cap = /^[A-Z]/.test(word);
    return list.map((c) => (cap ? c[0].toUpperCase() + c.slice(1) : c));
  }
  return { known, suggest };
}

// ---------------- reading LaTeX ----------------
const strip = (s) => s.replace(/\*$/, '');
const MATH_ENVS = new Set(['equation', 'align', 'alignat', 'xalignat', 'gather', 'multline', 'flalign', 'eqnarray', 'displaymath', 'math', 'split', 'aligned', 'alignedat',
  'gathered', 'cases', 'dcases', 'array', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'Bmatrix', 'smallmatrix', 'dmath', 'IEEEeqnarray']);
// LaTeX code rather than prose: read (braces must match) but not checked for spelling
const CODE_ENVS = new Set(['tikzpicture', 'pgfpicture', 'axis', 'tikzcd', 'circuitikz', 'forest', 'thebibliography', 'filecontents']);
// not LaTeX at all: skipped up to the matching \end
const VERB_ENVS = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment', 'alltt', 'BVerbatim', 'LVerbatim']);
// environments whose first arguments are settings: \begin{tabular}{lcc}, \begin{minipage}{0.5\linewidth} ...
const ARG_ENVS = new Set(['tabular', 'tabularx', 'tabulary', 'array', 'longtable', 'minipage', 'subfigure', 'subtable', 'wrapfigure', 'wraptable', 'multicols',
  'thebibliography', 'spacing', 'adjustbox', 'IEEEeqnarray', 'alignat', 'xalignat', 'alignedat', 'lstlisting', 'minted', 'filecontents']);
// commands whose {arguments} are keys, names, lengths or code - how many of them (Infinity = every one that follows directly)
const ALL = Infinity;
const ARGS = { label: ALL, input: ALL, include: ALL, includeonly: ALL, includegraphics: ALL, usepackage: ALL, RequirePackage: ALL, documentclass: ALL,
  bibliography: ALL, bibliographystyle: ALL, addbibresource: ALL, graphicspath: ALL, color: ALL, pagestyle: ALL, thispagestyle: ALL, vspace: ALL, hspace: ALL,
  setlength: ALL, addtolength: ALL, setcounter: ALL, addtocounter: ALL, newcounter: ALL, definecolor: ALL, hypersetup: ALL, newtheorem: ALL, pgfplotsset: ALL,
  usetikzlibrary: ALL, tikzset: ALL, bibitem: ALL, captionsetup: ALL, lstset: ALL, geometry: ALL, rule: ALL, linespread: ALL, fontsize: ALL, DeclareMathOperator: ALL,
  newcolumntype: ALL, sisetup: ALL, SI: ALL, si: ALL, qty: ALL, unit: ALL, num: ALL, ang: ALL, ensuremath: ALL, enlargethispage: ALL, setlist: ALL, titleformat: ALL,
  titlespacing: ALL, numberwithin: ALL, counterwithin: ALL, texttt: ALL, lstinline: ALL, mintinline: ALL, foreignlanguage: ALL, selectlanguage: ALL,
  gls: ALL, Gls: ALL, glspl: ALL, Glspl: ALL, acrshort: ALL, acrlong: ALL, acrfull: ALL, ac: ALL, acp: ALL, acl: ALL, acf: ALL, newacronym: ALL, hyperlink: 1, hypertarget: 1,
  url: ALL, path: ALL, nolinkurl: ALL, href: 1, textcolor: 1, colorbox: 1, fcolorbox: 2, multicolumn: 2, multirow: 2, resizebox: 2, scalebox: 1, parbox: 1,
  raisebox: 1, ifthenelse: 1, cellcolor: ALL, rowcolor: ALL, columncolor: ALL, hphantom: ALL, vphantom: ALL, phantom: ALL, pgfmathsetmacro: ALL, includepdf: ALL, lstinputlisting: ALL,
  inputminted: ALL, crefname: ALL, Crefname: ALL, hyphenation: ALL, DeclareUnicodeCharacter: ALL, IfFileExists: 1, setcitestyle: ALL, bibpunct: ALL };
// definitions: the name being defined and the body are code
const DEFS = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'newenvironment', 'renewenvironment', 'def', 'gdef', 'edef', 'xdef', 'let',
  'newif', 'DeclarePairedDelimiter', 'NewDocumentCommand', 'RenewDocumentCommand', 'NewDocumentEnvironment', 'newcolumntype', 'DeclareMathOperator']);
// their argument is read as it stands (a URL may hold % and _)
const RAW = new Set(['url', 'path', 'nolinkurl', 'href', 'lstinline', 'mintinline']);
const CITE_RE = /^[A-Za-z]*[cC]ite[A-Za-z]*$/, REF_RE = /^([A-Za-z]*ref|[cC]refrange|[cC]pageref)$/;
const argsOf = (name) => (name === 'hyperref' ? 0 : CITE_RE.test(name) || REF_RE.test(name) ? ALL : ARGS[name] || 0);
const TIE = new Set(['ref', 'eqref', 'pageref', 'cite', 'citep']);
const NOTE_CMDS = new Set(['todo', 'TODO', 'fixme', 'FIXME', 'missingfigure', 'todoinline']);
// \"o \'e \c{c} \ss ... : the letters around an accent command are pieces of one word
const ACCENT = /^(['"`^~=.]|[cvuHdbkrt]|ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)$/;
const ACCENT_NEXT = /^\{?\\(?:['"`^~=.]|(?:[cvuHdbkrt]|ss|ae|oe|aa|o|l|i|j)(?![a-zA-Z]))/;
const TOK = /(%)|\\([a-zA-Z@]+\*?|[^a-zA-Z@]|$)|(\$\$?)|([{}])|(\[)|(")|(\p{L}+(?:['’]\p{L}+)*)|([ \t]+)|([^])/yu;
const ENV_ARG = /\s*\{([^{}\\%]*)\}/y;
const ABBREV = /(?:^|[\s(~])(?:Fig|Figs|Eq|Eqs|Sec|Secs|Tab|Tabs|Alg|Thm|Def|Ref|Refs|App|Ch|Prop|Lem|Cor|No|Nos|al)\.$/;

// index just after the bracket that closes the one at `at`, on the same line; -1 if it is not closed there
function closer(line, at, open, close) {
  let depth = 0;
  for (let j = at; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return -1;
}

function scan(text, o = {}) {
  const off = new Set(o.off || []), on = (r) => !off.has(r);
  const known = on('spell') && typeof o.known === 'function' ? o.known : null;
  const lines = String(text).split(/\r\n?|\n/);
  const out = [];
  const hasDoc = /^[^%\n]*\\begin\s*\{document\}/m.test(text);
  const noQuotes = /\\MakeOuterQuote|\\shorthandon|\\usepackage\[[^\]]*\b(n?german|austrian|dutch|czech|polish|slovak|swedish|finnish|danish|norsk|italian)\b[^\]]*\]\{babel\}/.test(text);
  let inDoc = !hasDoc, done = false, spelt = 0, pairs = 0;
  let math = null;       // {kind: '$' | '$$' | '(' | '[' | 'env', env}
  let verb = null;       // name of the verbatim environment we are inside
  let pend = null;       // right after a command: {n: arguments still to skip, def, raw, named}
  let last = null;       // the previous word, while only spaces separate it from the next: {lower, end}
  let glue = null;       // {line, ch}: an accent construct ended here, a word starting here is a piece of a longer word
  let skipping = 0, defSkip = 0;
  const stack = [];      // open { and \begin: {t: '{' | 'env', name, line, ch, len, skip, def, resume, accent}
  const push = (e) => { stack.push(e); if (e.skip) { skipping++; if (e.def) defSkip++; } };
  const pop = () => { const e = stack.pop(); if (e.skip) { skipping--; if (e.def) defSkip--; } return e; };
  const add = (type, line, ch, to, msg, more) => out.push({ type, from: { line, ch }, to: { line, ch: to }, msg, ...more });
  const pair = (line, ch, to, msg) => { if (on('pairs') && pairs++ < 60) add('pairs', line, ch, to, msg); };
  const open = (e) => (e.t === '{' ? pair(e.line, e.ch, e.ch + 1, 'This { is never closed') : pair(e.line, e.ch, e.ch + e.len, `\\begin{${e.name}} has no \\end{${e.name}} after it`));
  const prose = () => !math && !skipping && inDoc;
  // is the capitalised word at `at` the first word of a sentence, a heading or an argument?
  const sentenceStart = (i, at) => {
    let s = lines[i].slice(0, at).trimEnd();
    if (!s) { // first word of the line: look at how the line before ends (a closing brace there is the end of a command line)
      s = i > 0 ? lines[i - 1].trimEnd() : '';
      if (!s || s.endsWith('}') || /(^|[^\\])%/.test(s)) return true;
    }
    return /[.!?:;{\]]$|``$|\\item$|\\\\$/.test(s); // not after "(": a bracket often opens with a name - (Franka Panda)
  };

  for (let i = 0; i < lines.length && !done; i++) {
    const line = lines[i];
    if (!line.trim()) { // a blank line ends the paragraph
      if (math && math.kind === '$') math = null;
      last = null; pend = null;
      continue;
    }
    let pos = 0;
    if (verb) { const k = line.indexOf(`\\end{${verb}}`); if (k < 0) continue; pos = k; verb = null; }
    while (pos < line.length) {
      TOK.lastIndex = pos;
      const m = TOK.exec(line); if (!m) break;
      const tok = m[0], at = pos;
      pos += tok.length;
      if (m[8] !== undefined) continue; // spaces
      if (pend) {
        if (m[5] && !math) { const e = closer(line, at, '[', ']'); if (e > 0) { pos = e; continue; } pend = null; } // [options]
        else if (tok === '{' && pend.n > 0) {
          const next = { n: pend.n - 1, def: pend.def, named: true };
          if (pend.raw) { const e = closer(line, at, '{', '}'); if (e > 0) { pos = e; pend = next; continue; } }
          push({ t: '{', line: i, ch: at, skip: true, def: !!pend.def, resume: next }); pend = null;
          continue;
        } else if (pend.def && m[2] && !pend.named) { pend.named = true; continue; } // \newcommand\name ...
        else pend = null;
      }
      if (m[1]) { // comment to the end of the line
        if (on('todo')) for (const t of line.slice(at).matchAll(/\b(TODO|FIXME|XXX)\b/g)) add('todo', i, at + t.index, at + t.index + t[0].length, 'A note left in a comment');
        last = null;
        break;
      }
      if (m[2] !== undefined) { // command
        const name = strip(m[2]);
        last = null;
        if (!name) continue;
        if (ACCENT.test(name)) {
          const top = stack[stack.length - 1];
          if (line[at - 1] === '{' && top && top.t === '{' && top.line === i && top.ch === at - 1) top.accent = true; // {\"o}
          glue = { line: i, ch: pos + (/^[a-zA-Z]+$/.test(name) && line[pos] === ' ' ? 1 : 0) };
          continue;
        }
        if (name === '(' || name === '[') { if (!math) math = { kind: name }; continue; }
        if (name === ')' || name === ']') { if (math && math.kind === (name === ')' ? '(' : '[')) math = null; continue; }
        if (name === 'begin' || name === 'end') {
          ENV_ARG.lastIndex = pos;
          const em = ENV_ARG.exec(line);
          if (!em) continue;
          pos = ENV_ARG.lastIndex;
          if (defSkip > 0) continue; // inside a definition: \newcommand{\bi}{\begin{itemize}}
          const env = em[1].trim(), eb = strip(env);
          if (name === 'begin') {
            push({ t: 'env', name: env, line: i, ch: at, len: pos - at });
            if (env === 'document') inDoc = true;
            pend = { n: ARG_ENVS.has(eb) ? ALL : 0 };
            if (VERB_ENVS.has(eb)) {
              const k = line.indexOf(`\\end{${env}}`, pos);
              pend = null;
              if (k < 0) { verb = env; pos = line.length; } else pos = k;
            } else if (!math && (MATH_ENVS.has(eb) || CODE_ENVS.has(eb))) math = { kind: 'env', env };
          } else {
            let k = stack.length - 1;
            while (k >= 0 && !(stack[k].t === 'env' && stack[k].name === env)) k--;
            if (k < 0) pair(i, at, pos, `\\end{${env}} has no \\begin{${env}} before it`);
            else { while (stack.length - 1 > k) open(pop()); pop(); }
            if (math && math.kind === 'env' && math.env === env) math = null;
            if (env === 'document') { done = true; break; }
          }
          continue;
        }
        if (name === 'verb' || (name === 'lstinline' && line[pos] && line[pos] !== '{' && line[pos] !== '[')) { // \verb|...|
          const d = line[pos], k = d ? line.indexOf(d, pos + 1) : -1;
          pos = k < 0 ? line.length : k + 1;
          continue;
        }
        if (NOTE_CMDS.has(name)) { if (on('todo')) add('todo', i, at, pos, 'A note left in the text'); pend = { n: ALL }; continue; }
        if (on('tie') && TIE.has(name) && prose()) {
          const pre = line.slice(0, at), sp = pre.match(/ +$/);
          if (sp) {
            const before = pre.slice(0, sp.index);
            if (/[\p{L}\p{N}}]$/u.test(before) || ABBREV.test(before)) {
              add('tie', i, sp.index, at, `Put ~ in place of this space, so that \\${name} cannot be pushed onto the next line away from the word before it`, { fix: { from: { line: i, ch: sp.index }, to: { line: i, ch: at }, text: '~' } });
            }
          }
        }
        pend = { n: argsOf(name), def: DEFS.has(name), raw: RAW.has(name) };
        if (pend.def && !pend.n) pend.n = ALL;
        continue;
      }
      if (m[3]) { // $ or $$
        last = null;
        if (skipping) continue;
        if (math && (math.kind === '$' || math.kind === '$$')) math = null; else if (!math) math = { kind: tok };
        continue;
      }
      if (m[4]) {
        last = null;
        if (tok === '{') { push({ t: '{', line: i, ch: at, accent: !!glue && glue.line === i && glue.ch === at }); continue; }
        const top = stack[stack.length - 1];
        if (top && top.t === '{') {
          pop();
          if (top.skip) pend = top.resume;
          if (top.accent) glue = { line: i, ch: pos };
        } else if (!defSkip) pair(i, at, pos, top ? `This } has no { before it (\\begin{${top.name}} on line ${top.line + 1} is still open)` : 'This } has no { before it');
        continue;
      }
      if (m[6]) { // "
        last = null;
        if (on('quotes') && !noQuotes && prose()) {
          const opening = at === 0 || /[\s(\[{~-]/.test(line[at - 1]);
          add('quotes', i, at, pos, 'A straight " is not a quotation mark in LaTeX. Write `` to open a quotation and \'\' to close it', { fix: { from: { line: i, ch: at }, to: { line: i, ch: pos }, text: opening ? '``' : "''" } });
        }
        continue;
      }
      if (m[7]) { // a word
        if (!prose()) { last = null; continue; }
        const w = tok, lower = w.toLowerCase();
        if (/^(TODO|FIXME|XXX)$/.test(w)) { if (on('todo')) add('todo', i, at, pos, 'A note left in the text'); last = null; continue; }
        if (on('repeat') && last && last.lower === lower && w.length > 1 && !/^\p{Lu}/u.test(w)) {
          add('repeat', i, at, pos, `“${w}” is written twice`, { word: w, fix: { from: last.end, to: { line: i, ch: pos }, text: '' } });
        }
        last = { lower, end: { line: i, ch: pos } };
        if (!known || spelt >= 1500) continue;
        const glued = glue && glue.line === i && glue.ch === at;
        if (glued) { glue = null; continue; }
        const prev = line[at - 1] || '', next = line[pos] || '';
        if (/[\\/@_#^\d]/.test(prev) || /[/@_^\d]/.test(next)) continue;                   // part of a path, an address, a name with digits
        if ((prev === '.' && /\p{L}/u.test(line[at - 2] || '')) || (next === '.' && /\p{L}/u.test(line[pos + 1] || ''))) continue; // main.tex, e.g.
        if (ACCENT_NEXT.test(line.slice(pos, pos + 8))) continue;                          // Schr\"odinger
        if (/^\p{Lu}/u.test(w) && !sentenceStart(i, at)) continue;                         // a name in the middle of a sentence
        if (!known(w)) { spelt++; add('spell', i, at, pos, `“${w}” is not in the dictionary`, { word: w }); }
        continue;
      }
      last = null; // punctuation, digits, anything else
    }
    pend = null; // arguments are looked for on the line of their command only
  }
  if (!done) while (stack.length) open(pop());
  out.sort((a, b) => a.from.line - b.from.line || a.from.ch - b.from.ch);
  return out;
}

RT.texlint = { RULES, scan, load, checker, setWords, ready: () => !!dict };
})();
