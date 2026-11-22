/* Citation keys in LaTeX and BibTeX source. No UI here; the same file runs in the browser (RT.refscan, used by
   write.js for the live marks) and on the server (required by lib/refcheck.js for the references check and for the
   "only cited" references.bib), so both always agree on what counts as a citation.
     cites(tex)      -> {uses: [{key, line, ch, len}], all}   keys of every \cite-family command (\citep[see][p. 3]{a,b},
                        \textcite{a}, \nocite{a}, \cites{a}{b} ...) outside comments; all = \nocite{*} is there
     bibKeys(bib)    -> [{key, type, line, ch, len}]          the entries of a .bib file, in file order
     bibitems(tex)   -> [{key, line, ch, len}]                \bibitem{key} of a hand-written thebibliography
     near(key, keys) -> up to 4 of `keys` that look like `key` (another case, a typing slip, the same beginning)
   line and ch count from 0, as in CodeMirror.
   Tests: node scripts/test-refscan.js */
(() => {
const root = typeof window !== 'undefined' ? window : globalThis;
const RT = root.RT || (root.RT = {});

// a comment is blanked out, not removed, so that every position stays where it is in the file
// (the same goes for text that LaTeX prints as it stands: \verb|\cite{key}| and the verbatim environments)
const spaces = (m) => m.replace(/[^\n]/g, ' ');
const blankComments = (text) => String(text)
  .replace(/\\verb\*?([^A-Za-z\s*])[^\n]*?\1/g, spaces)
  .replace(/(^|[^\\])%[^\n]*/gm, (m, a) => a + ' '.repeat(m.length - a.length))
  .replace(/\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment|filecontents\*?)\}[^]*?\\end\s*\{\1\}/g, spaces);
function locator(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (at) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; }
    return { line: lo, ch: at - starts[lo] };
  };
}

// any command whose name contains "cite" takes keys - except the ones that set a style or define a command
const CITE = /\\([A-Za-z]*[cC]ite[A-Za-z]*)\*?\s*((?:\([^()\n]*\)\s*)*(?:\[[^\]]*\]\s*)*)\{([^{}]*)\}/g;
const MORE = /\s*((?:\([^()]*\)\s*)*(?:\[[^\]]*\]\s*)*)\{([^{}]*)\}/y; // \cites{a}{b}: the groups that follow
const NOT_KEYS = /^(setcitestyle|citestyle|bibcite|citeindextype|DeclareCiteCommand|DeclareMultiCiteCommand|DeclareCiteAlias|ExecuteBibliographyOptions|newcites|citeindextrue|citeindexfalse)$/;
const KEY_OK = /^[^\s#\\%~{},"=]+$/;

function cites(tex) {
  const text = blankComments(String(tex).replace(/\r\n?/g, '\n')), at = locator(text);
  const uses = [];
  let all = false;
  const group = (cmd, list, start) => { // list = the text between the braces, start = its index in the file
    let pos = start;
    for (const part of list.split(',')) {
      const key = part.trim(), i = pos + (part.length - part.trimStart().length);
      pos += part.length + 1;
      if (!key) continue;
      if (key === '*') { if (/^nocite$/i.test(cmd)) all = true; continue; }
      if (!KEY_OK.test(key)) continue; // #1 inside a \newcommand, a macro ...
      uses.push({ key, ...at(i), len: key.length });
    }
  };
  for (const m of text.matchAll(CITE)) {
    if (NOT_KEYS.test(m[1])) continue;
    let end = m.index + m[0].length;
    group(m[1], m[3], end - 1 - m[3].length);
    if (/cites$/i.test(m[1])) { // biblatex multicite: one key list per group
      for (;;) {
        MORE.lastIndex = end;
        const x = MORE.exec(text);
        if (!x) break;
        end = x.index + x[0].length;
        group(m[1], x[2], end - 1 - x[2].length);
      }
    }
  }
  return { uses, all };
}

const BIB_ENTRY = /@\s*([A-Za-z]+)\s*[{(]\s*([^\s,{}()="#%]+)\s*,/g;
function bibKeys(bib) {
  const text = String(bib).replace(/\r\n?/g, '\n'), at = locator(text), out = [];
  for (const m of text.matchAll(BIB_ENTRY)) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const i = m.index + m[0].lastIndexOf(m[2]);
    out.push({ key: m[2], type, ...at(i), len: m[2].length });
  }
  return out;
}

const BIBITEM = /\\bibitem\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g;
function bibitems(tex) {
  const text = blankComments(String(tex).replace(/\r\n?/g, '\n')), at = locator(text), out = [];
  for (const m of text.matchAll(BIBITEM)) {
    const key = m[1].trim();
    if (!key || !KEY_OK.test(key)) continue;
    out.push({ key, ...at(m.index + m[0].length - 1 - m[1].length + (m[1].length - m[1].trimStart().length)), len: key.length });
  }
  return out;
}

// edit distance, given up as soon as it must be larger than `max`
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function near(key, keys) {
  const k = String(key).toLowerCase(), max = k.length <= 5 ? 1 : k.length <= 12 ? 2 : 3;
  const stem = (k.match(/^[a-z]+\d{2,4}/) || [''])[0]; // vaswani2017 of vaswani2017attention
  const out = [];
  for (const c of keys) {
    if (c === key) continue;
    const l = String(c).toLowerCase();
    let score = null;
    if (l === k) score = 0;
    else if (k.length >= 5 && l.length >= 5 && (l.startsWith(k) || k.startsWith(l))) score = 1; // the key cut short, or with something added
    else {
      const d = distance(k, l, max);
      if (d <= max) score = d;
      else if (stem.length >= 6 && l.startsWith(stem)) score = 4;
    }
    if (score != null) out.push({ c, score });
  }
  return out.sort((a, b) => a.score - b.score || a.c.localeCompare(b.c)).slice(0, 4).map((x) => x.c);
}

const api = { cites, bibKeys, bibitems, near };
RT.refscan = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
