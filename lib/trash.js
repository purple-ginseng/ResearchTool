// The trash: what is in <workspace>/trash, putting a deleted paper back, and emptying it.
// A deleted paper is one folder <workspace>/trash/library/<id>-<time>/ written by DELETE /api/items/:id
// (lib/routes/library.js): item.json plus the files that belonged to it. Everything else in the trash (replaced PDFs,
// deleted project files and projects ...) is listed only as a count and a size.
// Emptying is the ONE place where the app deletes user files for good, and only when the user asks for it.
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const { WS, DIRS, readJSON, loadLib, saveLib, httpErr } = core;

const LIB_TRASH = path.join(DIRS.trash, 'library');
const BIN = /^([0-9a-f]{10})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;
const STAMP = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;
const stampTime = (name) => { const m = STAMP.exec(name); const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN; return Number.isFinite(t) ? t : null; };

// bytes of a file or of everything in a folder (links are not followed)
function sizeOf(p) {
  let st; try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  try { for (const name of fs.readdirSync(p)) n += sizeOf(path.join(p, name)); } catch { /* unreadable: counted as empty */ }
  return n;
}

// The files of a deleted paper: name in the bin -> where it lives in the workspace (see the DELETE handler).
const PARTS = [
  ['sentences.json', 'sentences', (id) => path.join(DIRS.sentences, id + '.json')],
  ['notes.md', 'note', (id) => path.join(WS, 'notes', id + '.md')],
  ['note-assets', 'images', (id) => path.join(WS, 'notes', 'assets', id)],
  ['diagrams.json', 'diagrams', (id) => path.join(WS, 'diagrams', id + '.json')],
  ['quizzes.json', 'quizzes', (id) => path.join(WS, 'quizzes', id + '.json')],
  ['highlights.json', 'highlights', (id) => path.join(WS, 'highlights', id + '.json')],
];
const pdfIn = (dir) => { try { return fs.readdirSync(dir).find((n) => /\.pdf$/i.test(n)) || null; } catch { return null; } };

// A deleted paper, or null when the folder is not one (no readable item.json).
function readBin(bin) {
  const m = BIN.exec(String(bin));
  if (!m) return null;
  const dir = path.join(LIB_TRASH, bin);
  const item = readJSON(path.join(dir, 'item.json'), null);
  if (!item || typeof item !== 'object' || item.id !== m[1] || !item.fields || typeof item.fields !== 'object') return null;
  return { bin, dir, item, deleted: stampTime(m[2]) };
}

function listPapers() {
  let names = [];
  try { names = fs.readdirSync(LIB_TRASH); } catch { return []; }
  let ids = new Set();
  try { ids = new Set(loadLib().items.map((i) => i.id)); } catch { /* a damaged library: nothing can be restored anyway */ }
  const out = [];
  for (const name of names) {
    const b = readBin(name);
    if (!b) continue;
    const has = [];
    if (pdfIn(b.dir)) has.push('PDF');
    for (const [file, label] of PARTS) if (label !== 'sentences' && fs.existsSync(path.join(b.dir, file))) has.push(label);
    const kps = Array.isArray(b.item.keypoints) ? b.item.keypoints.length : 0;
    out.push({
      bin: b.bin, id: b.item.id, deleted: b.deleted ? new Date(b.deleted).toISOString() : null,
      title: String(b.item.fields.title || b.item.citekey || '(untitled)'), author: String(b.item.fields.author || ''),
      year: String(b.item.fields.year || ''), citekey: String(b.item.citekey || ''),
      has, keypoints: kps, size: sizeOf(b.dir), inLibrary: ids.has(b.item.id),
    });
  }
  return out.sort((a, b) => String(b.deleted).localeCompare(String(a.deleted)));
}

// Everything in the trash as units that can be removed one by one: {path, time, paper}. A name that carries the
// time it was put there is one unit; a folder without one (trash/library, trash/<project id>, trash/library/<item id>)
// is looked into; anything else counts from the time it was last changed.
function units() {
  const out = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const p = path.join(dir, d.name), t = stampTime(d.name);
      if (t !== null) out.push({ path: p, time: t, paper: dir === LIB_TRASH && BIN.test(d.name) });
      else if (d.isDirectory() && depth < 2) walk(p, depth + 1);
      else { let mt = Date.now(); try { mt = fs.lstatSync(p).mtimeMs; } catch { /* keep now */ } out.push({ path: p, time: mt, paper: false }); }
    }
  };
  walk(DIRS.trash, 0);
  return out;
}

const DAY = 86400000;
function summary(days = 30) {
  const all = units(), cut = Date.now() - days * DAY;
  let size = 0, oldSize = 0, old = 0, other = 0, otherSize = 0;
  for (const u of all) {
    const s = sizeOf(u.path); size += s;
    if (u.time < cut) { old++; oldSize += s; }
    if (!u.paper) { other++; otherSize += s; }
  }
  return { papers: listPapers(), size, count: all.length, old, oldSize, other, otherSize, days };
}

// Put a deleted paper back: the files first (each one only where nothing is in its place), then the item into
// library.json. If the library cannot be saved the files go back into the bin, so nothing is left half restored.
function restore(bin) {
  const b = readBin(bin);
  if (!b) throw httpErr(404, 'That paper is not in the trash any more');
  const lib = loadLib(); // throws when library.json is damaged
  const { item } = b;
  if (lib.items.some((i) => i.id === item.id)) throw httpErr(409, 'That paper is already in the library');
  const moved = [], kept = [];
  const put = (src, dest, label) => {
    if (!fs.existsSync(src)) return false;
    if (fs.existsSync(dest)) { kept.push(label); return false; } // never overwrite: the file stays in the trash
    core.P.move(src, dest); moved.push([src, dest]);
    return true;
  };
  try {
    const pdf = pdfIn(b.dir);
    const gotPdf = pdf ? put(path.join(b.dir, pdf), path.join(DIRS.pdfs, item.id + '.pdf'), 'PDF') : false;
    if (item.pdf && !gotPdf && !fs.existsSync(path.join(DIRS.pdfs, item.id + '.pdf'))) item.pdf = false; // the PDF is gone: a reference without one
    for (const [file, label, dest] of PARTS) put(path.join(b.dir, file), dest(item.id), label);
    // another paper may have taken the key in the meantime
    const taken = new Set(lib.items.map((i) => i.citekey));
    if (taken.has(item.citekey)) {
      const base = item.citekey || 'ref';
      item.citekey = [...'abcdefghijklmnopqrstuvwxyz'].map((s) => base + s).find((k) => !taken.has(k)) || `${base}-${core.newId().slice(0, 4)}`;
    }
    // a call that was waiting when the paper was deleted is not waiting any more
    if (item.categoryStatus === 'pending') delete item.categoryStatus;
    if (item.briefStatus === 'pending') delete item.briefStatus;
    lib.items.push(item);
    saveLib(lib);
  } catch (e) {
    for (const [src, dest] of moved.reverse()) { try { core.P.move(dest, src); } catch (e2) { console.error('trash restore, undo:', e2.message); } }
    throw e;
  }
  // the bin is finished with: item.json is in the library again; a folder that still holds something stays
  try {
    fs.rmSync(path.join(b.dir, 'item.json'), { force: true });
    if (!fs.readdirSync(b.dir).length) fs.rmdirSync(b.dir);
    else core.P.move(b.dir, path.join(LIB_TRASH, item.id, core.stamp() + '-left-after-restore'));
  } catch (e) { console.error('trash restore:', e.message); }
  return { item, kept };
}

// Delete for good. `days` = only what has been in the trash longer than that (0 = everything); `bin` = one paper.
function empty({ days = 0, bin = null } = {}) {
  let list;
  if (bin) {
    const b = readBin(bin);
    if (!b) throw httpErr(404, 'That paper is not in the trash any more');
    list = [{ path: b.dir }];
  } else {
    const cut = Date.now() - days * DAY;
    list = units().filter((u) => days <= 0 || u.time < cut);
  }
  let removed = 0, freed = 0, failed = 0;
  for (const u of list) {
    if (!core.inside(DIRS.trash, u.path) || u.path === DIRS.trash) continue; // only ever inside the trash folder
    const s = sizeOf(u.path);
    try { fs.rmSync(u.path, { recursive: true, force: true }); removed++; freed += s; } catch (e) { failed++; console.error('empty trash:', e.message); }
  }
  // folders that only grouped what was removed
  const prune = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) if (d.isDirectory() && stampTime(d.name) === null && depth < 2) {
      const p = path.join(dir, d.name);
      prune(p, depth + 1);
      try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* not empty */ }
    }
  };
  prune(DIRS.trash, 0);
  fs.mkdirSync(DIRS.trash, { recursive: true });
  return { removed, freed, failed };
}

module.exports = { summary, listPapers, restore, empty, sizeOf, BIN };
