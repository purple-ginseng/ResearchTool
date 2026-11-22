// Full-text search of the library: the sentences of every PDF (sentences/<id>.json), the reading notes
// (notes/<id>.md) and the key points. The index lives in ONE long-lived worker thread (this same file, the
// lib/search-worker.js pattern), so reading and parsing a few hundred files never stops the server's only thread and
// a key press is answered from memory. Before each search the worker compares the size and modification time of
// every file with what it holds and reads again only the files that changed - nothing is ever written.
//   search(q, {id?})  -> {tokens, papers: {<id>: {n, hits[], more}}, total, indexed, ms}
//   warm()            build the index ahead of the first search
// Matching: the query is cut into words ("quoted words" stay together); a sentence, note line or key point matches
// when it contains every word, in any order, ignoring case. Plain substring matching, so Chinese text (which has
// no spaces) is found as typed.
const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const MAX_Q = 200, MAX_TOKENS = 8;
const PER_PAPER = 4;      // passages sent per paper in a search of the whole library
const PER_PAPER_ALL = 200; // ... and when one paper is asked for (id)
const SNIP = 170;         // characters of a passage shown in the list

// "deep learning" 机器人 Foo -> ['deep learning', '机器人', 'foo']
function tokens(q) {
  const out = [];
  const re = /"([^"]+)"|“([^”]+)”|(\S+)/g;
  for (let m; (m = re.exec(String(q || '').slice(0, MAX_Q)));) {
    // a quote that is not closed (yet - the box searches while you type) is not part of the word
    const t = (m[1] || m[2] || m[3].replace(/^["“”]+|["“”]+$/g, '')).replace(/\s+/g, ' ').trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

// ---------------------------------------------------------------- the worker: index + search
function startWorker({ sentDir, noteDir, textDir }) {
  const papers = new Map(); // id -> {sKey, sents[{page,text,lc}], nKey, lines[{line,text,lc}], kps[{id,page,text,lc}]}  (lc = the text in lower case)
  let ids = [];

  const keyOf = (file) => { try { const st = fs.statSync(file); return `${st.size}-${Math.round(st.mtimeMs)}`; } catch { return ''; } };
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // A note line as it reads on screen: without the Markdown around links, images, headings, quotes and emphasis.
  function plain(line) {
    return squash(line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]{1,200}>/g, ' ')
      .replace(/^\s*(>\s*)+/, '')
      .replace(/^\[![\w-]+\][+-]?\s*/, '') // the marker of a callout: > [!note] Title
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/\*\*|__|~~|==|`/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!$<>|])/g, '$1'));
  }

  function loadSentences(id) {
    const out = [];
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(sentDir, id + '.json'), 'utf8')); } catch { /* none, or unreadable */ }
    for (const s of data && Array.isArray(data.sentences) ? data.sentences : []) {
      const text = squash(s && s.text);
      if (text) out.push({ page: Number(s.page) || 0, text, lc: text.toLowerCase() });
    }
    if (out.length) return out;
    // A PDF whose text gave no sentences (the sentence rules are made for English): the paragraphs of the cached
    // page text, when the paper has been opened and that cache exists.
    try {
      const t = JSON.parse(fs.readFileSync(path.join(textDir, id + '.json'), 'utf8'));
      (Array.isArray(t.pages) ? t.pages : []).forEach((pg, i) => {
        for (const par of String(pg).split(/\n\s*\n/)) {
          const text = squash(par).slice(0, 600);
          if (text.length >= 2) out.push({ page: i + 1, text, lc: text.toLowerCase() });
        }
      });
    } catch { /* no cached text either */ }
    return out;
  }
  function loadNote(id) {
    const out = [];
    let md = '';
    try { md = fs.readFileSync(path.join(noteDir, id + '.md'), 'utf8'); } catch { return out; }
    const rows = md.split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].length > 20000) continue; // an embedded image or other data, not prose
      const text = plain(rows[i]);
      if (text.length >= 2 && !/^[-=*_|:\s]+$/.test(text)) out.push({ line: i + 1, text, lc: text.toLowerCase() });
    }
    return out;
  }

  // Bring the index in line with the files on disk (cheap when nothing changed: three stat calls per paper).
  function sync() {
    const want = new Set(ids);
    for (const id of [...papers.keys()]) if (!want.has(id)) papers.delete(id);
    for (const id of ids) {
      let p = papers.get(id);
      if (!p) { p = { sKey: null, sents: [], nKey: null, lines: [], kps: [] }; papers.set(id, p); }
      const sKey = keyOf(path.join(sentDir, id + '.json')) + '|' + keyOf(path.join(textDir, id + '.json'));
      const nKey = keyOf(path.join(noteDir, id + '.md'));
      if (p.sKey !== sKey) { p.sents = loadSentences(id); p.sKey = sKey; }
      if (p.nKey !== nKey) { p.lines = loadNote(id); p.nKey = nKey; }
    }
  }

  function setLib(items) {
    ids = items.map((i) => i.id);
    for (const it of items) {
      let p = papers.get(it.id);
      if (!p) { p = { sKey: null, sents: [], nKey: null, lines: [], kps: [] }; papers.set(it.id, p); }
      p.kps = [];
      for (const k of it.kps) {
        const text = squash(k.text), note = squash(k.note);
        if (text) p.kps.push({ id: k.id, page: Number(k.page) || 0, text, lc: text.toLowerCase() });
        if (note) p.kps.push({ id: k.id, page: Number(k.page) || 0, text: note, lc: note.toLowerCase(), own: true });
      }
    }
  }

  // the part of a passage around its first matching word
  function snippet(text, lc, toks) {
    if (text.length <= SNIP) return text;
    let at = -1;
    for (const t of toks) { const i = lc.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (lc.length !== text.length) at = Math.min(at, text.length - 1); // a rare letter whose lower case is longer
    let start = Math.max(0, at - 50);
    if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < at) start = sp + 1; }
    const end = Math.min(text.length, start + SNIP);
    return (start > 0 ? '… ' : '') + text.slice(start, end).trim() + (end < text.length ? ' …' : '');
  }

  function search(toks, only) {
    sync();
    const out = {};
    let total = 0;
    const cap = only ? PER_PAPER_ALL : PER_PAPER;
    for (const [id, p] of papers) {
      if (only && id !== only) continue;
      const hits = [];
      let n = 0;
      const seen = new Set(); // a key point is usually a sentence of the paper: list it once, as the key point
      const scan = (list, make, kind) => {
        for (const x of list) {
          let ok = true;
          for (const t of toks) if (!x.lc.includes(t)) { ok = false; break; }
          if (!ok) continue;
          if (kind === 'kp') seen.add(x.lc); else if (kind === 'pdf' && seen.has(x.lc)) continue;
          n++;
          if (hits.length < cap) hits.push({ ...make(x), text: snippet(x.text, x.lc, toks) });
        }
      };
      // the reader's own words first, then the paper page by page
      scan(p.lines, (x) => ({ kind: 'note', line: x.line }));
      scan(p.kps, (x) => ({ kind: 'kp', kp: x.id, page: x.page, ...(x.own ? { own: true } : {}) }), 'kp');
      scan(p.sents, (x) => ({ kind: 'pdf', page: x.page, ...(x.text.length > SNIP ? { pass: x.text } : {}) }), 'pdf');
      if (!n) continue;
      out[id] = { n, hits, more: n - hits.length };
      total += n;
    }
    return { papers: out, total, indexed: papers.size };
  }

  parentPort.on('message', (m) => {
    try {
      if (m.type === 'lib') return setLib(m.items);
      if (m.type === 'search') {
        const t0 = Date.now();
        const r = search(m.tokens, m.only);
        return parentPort.postMessage({ seq: m.seq, result: { ...r, ms: Date.now() - t0 } });
      }
      if (m.type === 'warm') { sync(); return parentPort.postMessage({ seq: m.seq, result: { indexed: papers.size } }); }
    } catch (e) {
      if (m.seq) parentPort.postMessage({ seq: m.seq, error: e.message || String(e) });
    }
  });
}

if (!isMainThread && workerData && workerData.fulltext) startWorker(workerData.fulltext);

// ---------------------------------------------------------------- the server side
let worker = null, seq = 0, libKey = null;
const waiting = new Map(); // seq -> {resolve, reject, timer, w (the worker that was asked)}

// the questions put to worker `w` fail; those put to a newer worker stay
function failAll(w, err) {
  for (const [id, p] of waiting) if (p.w === w) { waiting.delete(id); clearTimeout(p.timer); p.reject(err); }
}
function ensureWorker() {
  if (worker) return worker;
  const core = require('./core');
  const w = new Worker(__filename, { workerData: { fulltext: { sentDir: core.DIRS.sentences, noteDir: path.join(core.WS, 'notes'), textDir: path.join(core.DIRS.cache, 'text') } } });
  w.unref(); // never keeps the server alive on its own
  w.on('message', (m) => {
    const p = waiting.get(m.seq); if (!p) return;
    waiting.delete(m.seq); clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  const gone = (e) => { if (worker === w) { worker = null; libKey = null; } failAll(w, e instanceof Error ? e : new Error('The search stopped unexpectedly')); };
  w.on('error', gone);
  w.on('exit', () => gone());
  worker = w; libKey = null;
  return w;
}
// tell the worker which papers exist and what their key points are - only when library.json changed
function sendLib(w) {
  const core = require('./core');
  let key = '';
  try { const st = fs.statSync(core.LIB_FILE); key = `${st.size}-${st.mtimeMs}`; } catch { /* no library yet */ }
  if (key === libKey) return;
  const lib = core.loadLib();
  w.postMessage({ type: 'lib', items: lib.items.map((i) => ({ id: i.id, kps: (Array.isArray(i.keypoints) ? i.keypoints : []).filter((k) => k && typeof k === 'object').map((k) => ({ id: k.id, page: k.page, text: k.text, note: k.note })) })) });
  libKey = key;
}
function ask(msg, timeout) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = ensureWorker(); sendLib(w); } catch (e) { return reject(e); }
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      // a search that does not come back: start over with a fresh worker next time
      if (worker === w) { worker = null; libKey = null; }
      w.terminate().catch(() => {});
      reject(new Error('The search took too long - try again'));
    }, timeout);
    waiting.set(id, { resolve, reject, timer, w });
    w.postMessage({ ...msg, seq: id });
  });
}

async function search(q, { id } = {}) {
  const toks = tokens(q);
  if (!toks.length) return { tokens: [], papers: {}, total: 0, indexed: 0, ms: 0 };
  const r = await ask({ type: 'search', tokens: toks, only: id || null }, 20000);
  return { tokens: toks, ...r };
}
const warm = () => ask({ type: 'warm' }, 60000);

module.exports = { search, warm, tokens };
