// Cache of the text pdftotext reads from a paper's PDF, so that a question about a paper does not extract the whole
// PDF again: <workspace>/cache/text/<id>.json = {v, key, pages[]} plus a small in-memory map. The key is the size and
// modification time of pdfs/<id>.pdf, so a replaced file is never answered from an old copy. Everything here is
// derived data: it can be deleted at any time and is rebuilt on the next use.
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');

const DIR = path.join(core.DIRS.cache, 'text');
const VERSION = 1;
const MAX_MEM = 12;       // papers kept in memory (a paper is 50-300 kB of text)
const mem = new Map();    // id -> {key, pages, memo: Map}   (insertion order = least recently used first)
const inflight = new Map(); // id -> Promise of a running extraction, shared by the callers that arrive meanwhile

const pdfFile = (id) => path.join(core.DIRS.pdfs, id + '.pdf');
const cacheFile = (id) => path.join(DIR, id + '.json');
function keyOf(id) {
  try { const st = fs.statSync(pdfFile(id)); return `${st.size}-${Math.round(st.mtimeMs)}`; } catch { return null; }
}

// pdftotext of one file -> the text of each page
async function pdfToPages(file) {
  const r = await core.run('pdftotext', ['-enc', 'UTF-8', file, '-'], { timeout: 120000 });
  if (r.code !== 0) throw core.httpErr(r.code === -1 ? 500 : 400, core.toolFailure('pdftotext', r, { hint: 'Reinstall or update poppler (README, Troubleshooting).' }));
  const pages = core.plat.lf(r.out).split('\f'); // \r\n (pdftotext on Windows) -> \n
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  return pages;
}

function remember(id, key, pages) {
  mem.delete(id);
  mem.set(id, { key, pages, memo: new Map() });
  while (mem.size > MAX_MEM) mem.delete(mem.keys().next().value);
  return pages;
}
// the entry of a paper while it still belongs to the PDF on disk (and mark it as used)
function entry(id) {
  const e = mem.get(id);
  if (!e) return null;
  if (e.key !== keyOf(id)) { mem.delete(id); return null; }
  mem.delete(id); mem.set(id, e);
  return e;
}

// Text of every page of the PDF of item `id`: from memory, else from the cache file, else from pdftotext.
// Rejects like pdfToPages when there is no readable PDF. `info.hit` tells where the text came from.
async function pages(id, info = {}) {
  const e = entry(id);
  if (e) { info.hit = 'memory'; return e.pages; }
  const key = keyOf(id);
  if (!key) throw core.httpErr(404, 'This paper has no PDF');
  const disk = core.readJSON(cacheFile(id), null);
  if (disk && disk.v === VERSION && disk.key === key && Array.isArray(disk.pages) && disk.pages.every((p) => typeof p === 'string')) {
    info.hit = 'disk';
    return remember(id, key, disk.pages);
  }
  info.hit = 'extracted';
  if (!inflight.has(id)) {
    inflight.set(id, (async () => {
      try {
        const out = await pdfToPages(pdfFile(id));
        if (keyOf(id) === key) put(id, out); // the file was not replaced while it was read
        return out;
      } finally { inflight.delete(id); }
    })());
  }
  return inflight.get(id);
}

// Store text that was just extracted from the PDF now at pdfs/<id>.pdf (import, attach / replace).
function put(id, pageList) {
  const key = keyOf(id);
  if (!key || !Array.isArray(pageList)) return;
  remember(id, key, pageList);
  try { fs.mkdirSync(DIR, { recursive: true }); core.writeJSON(cacheFile(id), { v: VERSION, key, pages: pageList }); }
  catch (e) { console.error('text cache:', e.message); } // the cache is a convenience
}
// Forget a paper (its PDF was replaced or the item was deleted).
function drop(id) {
  mem.delete(id);
  try { fs.rmSync(cacheFile(id), { force: true }); } catch { /* nothing to remove */ }
}

// Values worked out from the cached pages (the prompt text, its paragraphs): kept in memory with the pages and
// thrown away with them. memo() returns undefined when there is nothing (or the PDF changed).
function memo(id, name) { const e = entry(id); return e ? e.memo.get(name) : undefined; }
function setMemo(id, name, value) { const e = entry(id); if (e) e.memo.set(name, value); return value; }

module.exports = { DIR, pdfToPages, pages, put, drop, memo, setMemo, keyOf };
