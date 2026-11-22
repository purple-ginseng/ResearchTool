// Minimal BibTeX parser / serializer (handles nested braces, quoted values, # concatenation, @string macros).

function parse(src) {
  const entries = [];
  const macros = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };
  let i = 0;
  const n = src.length;
  const ws = () => { while (i < n && /\s/.test(src[i])) i++; };

  function braced() { // src[i] === '{'
    let depth = 0, start = i + 1;
    for (; i < n; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { const v = src.slice(start, i); i++; return v; } }
    }
    return src.slice(start);
  }
  function quoted() { // src[i] === '"'
    let depth = 0, start = ++i;
    for (; i < n; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      else if (src[i] === '"' && depth === 0) { const v = src.slice(start, i); i++; return v; }
    }
    return src.slice(start);
  }
  function value() {
    let out = '';
    for (;;) {
      ws();
      if (src[i] === '{') out += braced();
      else if (src[i] === '"') out += quoted();
      else {
        const m = /^[^\s,#}]+/.exec(src.slice(i, i + 200));
        if (!m) break;
        i += m[0].length;
        out += /^\d+$/.test(m[0]) ? m[0] : (macros[m[0].toLowerCase()] ?? m[0]);
      }
      ws();
      if (src[i] === '#') { i++; continue; }
      break;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const tm = /^\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(i, i + 60));
    if (!tm) continue;
    const type = tm[1].toLowerCase();
    i += tm[0].length;
    if (type === 'comment' || type === 'preamble') { i--; if (src[i] === '{') braced(); continue; }
    if (type === 'string') {
      ws();
      const km = /^([^\s=]+)\s*=/.exec(src.slice(i, i + 200));
      if (km) { i += km[0].length; macros[km[1].toLowerCase()] = value(); }
      continue;
    }
    ws();
    const km = /^([^\s,]*)\s*,/.exec(src.slice(i, i + 300));
    if (!km) continue;
    const key = km[1];
    i += km[0].length;
    const fields = {};
    for (;;) {
      ws();
      if (i >= n || src[i] === '}' || src[i] === ')') { i++; break; }
      const fm = /^([A-Za-z][\w:-]*)\s*=/.exec(src.slice(i, i + 100));
      if (!fm) { // junk: skip to next comma or closing brace
        while (i < n && src[i] !== ',' && src[i] !== '}') i++;
        if (src[i] === ',') i++;
        continue;
      }
      i += fm[0].length;
      fields[fm[1].toLowerCase()] = value();
      ws();
      if (src[i] === ',') i++;
    }
    if (Object.keys(fields).length) entries.push({ type, key, fields });
  }
  return entries;
}

const ORDER = ['author', 'title', 'journal', 'booktitle', 'year', 'month', 'volume', 'number', 'pages', 'publisher', 'editor', 'series', 'address', 'organization', 'school', 'institution', 'doi', 'url', 'eprint', 'archiveprefix', 'primaryclass', 'issn', 'isbn', 'note'];
const SKIP = new Set(['abstract', 'file', 'keywords', 'copyright', 'language']);

function serialize({ type, key, fields }) {
  const names = Object.keys(fields).filter((f) => !SKIP.has(f) && String(fields[f] ?? '').trim() !== '');
  names.sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const val = (f) => { const v = balance(String(fields[f]).trim()); return f === 'pages' ? v.replace(/\s*[‐-―]\s*/g, '--') : v; };
  const lines = names.map((f) => `  ${f} = {${val(f)}}`);
  return `@${type || 'misc'}{${key},\n${lines.join(',\n')}\n}`;
}

// make sure a value cannot break the .bib file
function balance(v) {
  let depth = 0, out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\' && i + 1 < v.length) { out += c + v[++i]; continue; }
    if (c === '{') depth++;
    if (c === '}') { if (depth === 0) continue; depth--; }
    out += c;
  }
  return out + '}'.repeat(depth);
}

const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'and', 'in', 'to', 'with', 'from', 'at', 'by', 'is', 'are', 'towards', 'toward', 'via']);
const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\\[a-zA-Z]+|[{}\\'"`^~]/g, '');

function makeKey(fields) {
  let last = 'anon';
  const author = ascii(String(fields.author || '')).split(/\s+and\s+/i)[0].trim();
  if (author) last = author.includes(',') ? author.split(',')[0] : author.split(/\s+/).pop();
  last = last.replace(/[^A-Za-z]/g, '').toLowerCase() || 'anon';
  const year = (String(fields.year || '').match(/\d{4}/) || [''])[0];
  const word = ascii(String(fields.title || '')).toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length > 2 && !STOP.has(w)) || '';
  return last + year + word;
}

// the forms used to compare papers (duplicates, matching a reference to the library): a DOI without its doi.org prefix,
// lower-cased; a title reduced to its letters and digits (compare only when that is at least 12 characters long)
const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^(https?:\/\/)?(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const normTitle = (t) => String(t || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

module.exports = { parse, serialize, makeKey, normDoi, normTitle };
