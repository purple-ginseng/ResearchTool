// LaTeX project routes: /api/fs/[pick|list|tools], /api/projects, /api/projects/open, /api/projects/import-zip,
// /api/projects/:id[/file|raw|files|upload|rename|rename-project|compile|download|pdf|settings|search|labels|synctex|
// wordcount|spelling|refs|papers|reading-pack|annotated|history[/:vid[/diff|restore]]], /api/spell/words, /api/memberships
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isUtf8 } = require('node:buffer');
const core = require('../core');
const diff = require('../diff');
const { DIRS, BIB_MARKER, MAX_TEXT, loadLib, newId, allBibtex, run, readBody, attachment,
  httpErr, normRel, kindOf, mimeOf, expandHome, inside, P, H, sha1, diskSource, diskOpts } = core;
const { isArtefact, MAX_PAPERS, realpath } = require('../projects');
const plat = require('../platform');
const ai = require('../ai');
const { writeZip } = require('../zip');
const { searchFiles, runRegexSearch } = require('../search-worker');
const spell = require('../spell');
const refcheck = require('../refcheck');
const notes = require('../notes');
const quiz = require('../quiz');
const writing = require('../writing');
const highlights = require('./highlights');

const previewPdf = (project) => path.join(DIRS.cache, project.id, 'preview.pdf');
// The file list without the PDF that latexmk writes next to the main file (it is shown in the preview instead).
function projectFiles(project, cap) {
  const out = project.mainFile ? project.mainFile.replace(/\.[^./]+$/, '') + '.pdf' : null;
  return P.listFiles(project, cap).filter((f) => f.path !== out);
}

// Record files that were edited outside the app (only files that already have history).
function scanExternal(project) {
  const h = H.open(project.id);
  for (const rel of h.files()) {
    try {
      const r = P.resolveIn(project, rel);
      if (!r.exists) continue;
      const st = fs.statSync(r.abs);
      if (!st.isFile() || st.size > MAX_TEXT) continue;
      const buf = fs.readFileSync(r.abs);
      if (sha1(buf) !== h.newest(rel).hash) h.record(rel, buf, diskSource(project), diskOpts(project));
    } catch { /* unreadable or path no longer valid */ }
  }
  h.commit();
}

function readText(project, rel) {
  const r = P.resolveIn(project, rel);
  if (!r.exists) throw httpErr(404, 'No such file: ' + r.rel);
  const st = fs.statSync(r.abs);
  if (!st.isFile()) throw httpErr(400, 'Not a file: ' + r.rel);
  const kind = kindOf(r.abs);
  if (kind !== 'text') throw httpErr(415, 'Not a text file', { kind });
  if (st.size > MAX_TEXT) throw httpErr(415, 'File is larger than 2 MB', { kind });
  const buf = fs.readFileSync(r.abs), hash = sha1(buf);
  // a file in another encoding (latin1 ...) would be mangled by decoding it and saving it back as UTF-8
  if (!isUtf8(buf)) throw httpErr(415, 'This file is not UTF-8 encoded, so it cannot be edited here. Convert it to UTF-8 first.', { kind: 'binary' });
  const h = H.open(project.id), last = h.newest(r.rel);
  if (last && last.hash !== hash) { h.record(r.rel, buf, diskSource(project), diskOpts(project)); h.commit(); }
  return { path: r.rel, content: buf.toString('utf8'), mtime: st.mtimeMs, hash };
}

// Keep the content of a file that is about to be overwritten: text goes into the history (as the baseline, or as
// an unnoticed outside edit), anything else (binary, larger than 2 MB) is copied to the workspace trash.
function keepOld(project, r, h, disk) {
  const size = disk ? disk.length : fs.statSync(r.abs).size;
  if (size <= MAX_TEXT && kindOf(r.abs) === 'text') {
    if (!disk) disk = fs.readFileSync(r.abs);
    if (!disk.includes(0)) {
      const last = h.newest(r.rel);
      if (!last) h.record(r.rel, disk, 'baseline');
      else if (last.hash !== sha1(disk)) h.record(r.rel, disk, diskSource(project), diskOpts(project));
      return;
    }
  }
  const dest = path.join(DIRS.trash, project.id, P.stamp(), r.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(r.abs, dest);
}

function writeText(project, rel, body) {
  const r = P.resolveIn(project, rel);
  if (typeof body.content !== 'string') throw httpErr(400, 'content must be a string');
  const buf = Buffer.from(body.content, 'utf8'), hash = sha1(buf);
  if (buf.length > MAX_TEXT) throw httpErr(413, 'File is larger than 2 MB - too large to edit here');
  let disk = null;
  if (r.exists) {
    if (!fs.statSync(r.abs).isFile()) throw httpErr(400, 'Not a file: ' + r.rel);
    disk = fs.readFileSync(r.abs);
  }
  const diskHash = disk ? sha1(disk) : null;
  if (body.baseHash && disk && diskHash !== body.baseHash && diskHash !== hash) {
    throw httpErr(409, 'The file was changed on disk since you opened it', { conflict: true, content: disk.toString('utf8'), hash: diskHash });
  }
  const h = H.open(project.id);
  if (disk && diskHash !== hash) keepOld(project, r, h, disk);
  if (!disk || diskHash !== hash) {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    fs.writeFileSync(r.abs, buf);
  }
  // 'claude': a change Claude proposed in the editor and the user accepted (write-ai.js saves the text before it first)
  // by: the AI provider that made a 'claude' change (its id, checked against the known providers)
  const src = body.source === 'auto' || body.source === 'claude' ? body.source : 'manual';
  const v = h.record(r.rel, buf, src, { label: body.label, by: src === 'claude' && ai.IDS.includes(body.by) ? body.by : null });
  h.commit();
  return { mtime: fs.statSync(r.abs).mtimeMs, hash, versionId: v ? v.id : null };
}

function createEntry(project, body) {
  const r = P.resolveIn(project, body.path);
  if (body.type !== 'file' && body.type !== 'dir') throw httpErr(400, "type must be 'file' or 'dir'");
  if (r.exists) throw httpErr(409, 'Already exists: ' + r.rel);
  if (body.type === 'dir') fs.mkdirSync(r.abs, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    fs.writeFileSync(r.abs, typeof body.content === 'string' ? body.content : '', { flag: 'wx' });
  }
}

function renameEntry(project, body) {
  const a = P.resolveIn(project, body.from), b = P.resolveIn(project, body.to);
  if (!a.exists) throw httpErr(404, 'No such file: ' + a.rel);
  if (a.rel === b.rel) return;
  if (b.rel.startsWith(a.rel + '/')) throw httpErr(400, 'Cannot move a folder into itself');
  if (b.exists) { // allowed only when it is the same entry (case-only rename on a case-insensitive disk)
    const sa = fs.lstatSync(a.lpath), sb = fs.lstatSync(b.lpath);
    if (!(sa.ino === sb.ino && sa.dev === sb.dev && a.rel.toLowerCase() === b.rel.toLowerCase())) throw httpErr(409, 'Already exists: ' + b.rel);
  }
  fs.mkdirSync(path.dirname(b.lpath), { recursive: true });
  fs.renameSync(a.lpath, b.lpath);
  H.rename(project.id, a.rel, b.rel);
  P.renamed(project, a.rel, b.rel);
}

function historyVersion(project, vid) {
  const h = H.open(project.id), v = h.find(vid);
  if (!v) throw httpErr(404, 'No such version');
  return { h, v };
}
function currentText(project, rel) {
  try {
    const r = P.resolveIn(project, rel);
    if (!r.exists) return '';
    const st = fs.statSync(r.abs);
    return st.isFile() && st.size <= MAX_TEXT ? fs.readFileSync(r.abs, 'utf8') : '';
  } catch { return ''; }
}
function restoreVersion(project, vid) {
  const { h, v } = historyVersion(project, vid);
  const buf = h.blob(v);
  if (!buf) throw httpErr(500, 'The stored content of this version is missing');
  const r = P.resolveIn(project, v.file);
  if (r.exists) {
    const st = fs.statSync(r.abs);
    if (!st.isFile()) throw httpErr(400, 'Not a file: ' + r.rel);
    const disk = fs.readFileSync(r.abs);
    if (sha1(disk) !== sha1(buf)) keepOld(project, r, h, disk);
  }
  fs.mkdirSync(path.dirname(r.abs), { recursive: true });
  fs.writeFileSync(r.abs, buf);
  const nv = h.record(v.file, buf, 'restore');
  h.commit();
  return { content: buf.toString('utf8'), hash: sha1(buf), mtime: fs.statSync(r.abs).mtimeMs, versionId: nv ? nv.id : null };
}

// ---------- compile ----------
// Does any .tex file of the project load references.bib (\bibliography{references}, \addbibresource{references.bib})?
const USES_REFS = /\\(?:bibliography|nobibliography|addbibresource|addglobalbib)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;
function usesReferences(project) {
  for (const f of textFiles(project)) {
    if (!/\.(tex|ltx|cls|sty)$/i.test(f.path)) continue;
    const text = readProjectText(project, f.path);
    if (text == null) continue;
    const body = text.replace(/(^|[^\\])%.*$/gm, '$1'); // comments do not count
    for (const m of body.matchAll(USES_REFS)) {
      if (m[1].split(',').some((n) => /^(?:\.\/)?references(?:\.bib)?$/.test(n.trim()))) return true;
    }
  }
  return false;
}
// What the last LaTeX run recorded as cited: the .aux of the main file, the .aux files it reads (\include) and the
// .bcf of biber. This is how a citation made through an own macro (\mycite{key}) is found.
function auxTexts(dir, stem) {
  const out = [], seen = new Set();
  const read = (abs, depth) => {
    if (seen.has(abs) || seen.size > 200 || !inside(dir, abs)) return;
    seen.add(abs);
    let t;
    try { if (fs.statSync(abs).size > 8e6) return; t = fs.readFileSync(abs, 'latin1'); } catch { return; }
    out.push(t);
    if (depth < 3) for (const m of t.matchAll(/\\@input\{([^{}]+\.aux)\}/g)) read(path.resolve(dir, m[1]), depth + 1);
  };
  read(path.join(dir, stem + '.aux'), 0);
  read(path.join(dir, stem + '.bcf'), 3);
  return out;
}
const sourceTexts = (project, re) => textFiles(project).filter((f) => re.test(f.path))
  .map((f) => ({ path: f.path, text: readProjectText(project, f.path) })).filter((f) => f.text != null);
// The references.bib next to the main file: written by the app ('generated'), by the user ('own') or not there ('none').
function referencesFile(project) {
  if (!project.mainFile) return { rel: null, state: 'none' };
  const rel = path.posix.join(path.posix.dirname(project.mainFile), 'references.bib');
  let cur = null;
  try {
    const r = P.resolveIn(project, rel);
    if (!r.exists) return { rel, state: 'none' };
    cur = fs.readFileSync(r.abs, 'utf8');
  } catch { return { rel, state: 'own' }; } // unreadable: not ours to judge
  return { rel, state: cur.split('\n', 1)[0].replace(/\r$/, '') === BIB_MARKER ? 'generated' : 'own' };
}
function writeReferences(project, dir, stem) {
  // regenerate references.bib from the library, but never overwrite one the user wrote
  const f = path.join(dir, 'references.bib');
  let cur = null;
  try { cur = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return; }
  if (cur != null && cur.split('\n', 1)[0].replace(/\r$/, '') !== BIB_MARKER) return;
  // never add the file to a project that does not use it: an Overleaf clone or a folder opened from disk would
  // otherwise get it, and the next sync would commit and push it
  if (cur == null && !usesReferences(project)) return;
  const lib = loadLib();
  let items = lib.items, note = '';
  if (project.bibScope !== 'all') {
    // only what the project cites, so that co-authors and Overleaf do not receive the whole personal library
    const want = refcheck.citedKeys(sourceTexts(project, /\.(tex|ltx)$/i), auxTexts(dir, stem));
    items = refcheck.pickCited(lib.items, want);
    if (want.all) note = `% \\nocite{*} is used, so every entry of the library is here (${items.length}).\n`;
    else if (project.bibScope === 'project') { // ... and the papers the user added to the project, cited or not
      const take = new Set([...items, ...memberItems(project, lib.items)]);
      items = lib.items.filter((i) => take.has(i));
      note = `% Cited entries plus the papers of this project: ${items.length}. Cite another paper or add it to the project and it is here at the next compile.\n`;
    } else note = `% Only the entries this project cites: ${items.length}. Cite another paper and it is added at the next compile.\n`;
  }
  const next = BIB_MARKER + '\n' + note + allBibtex({ items });
  if (next !== cur) fs.writeFileSync(f, next);
}

// The references check of the Write tab, and the keys the editor needs for its live marks.
function projectRefs(project) {
  const ref = referencesFile(project);
  const files = sourceTexts(project, /\.(tex|ltx|bib)$/i);
  let loadsBib = false, hasItems = false;
  const mainDir = project.mainFile ? path.posix.dirname(project.mainFile) : '.';
  const bibPaths = new Set(files.filter((f) => /\.bib$/i.test(f.path)).map((f) => f.path.toLowerCase()));
  const named = new Map(); // the .bib files the .tex files load, by the name written there -> is it a file of the project
  for (const f of files) {
    if (!/\.(tex|ltx)$/i.test(f.path)) continue;
    const body = f.text.replace(/(^|[^\\])%.*$/gm, '$1');
    for (const m of body.matchAll(USES_REFS)) {
      loadsBib = true;
      for (const raw of m[1].split(',')) {
        const n = raw.trim();
        if (!n) continue;
        const file = /\.bib$/i.test(n) ? n : n + '.bib';
        // BibTeX and biber look from the folder of the main file; a file loaded from a sub-file may be meant from there
        const found = [mainDir, path.posix.dirname(f.path)].some((d) => bibPaths.has(path.posix.normalize(path.posix.join(d, file)).toLowerCase()));
        named.set(file, named.get(file) || found);
      }
    }
    if (/\\bibitem\b/.test(body)) hasItems = true;
  }
  // the library supplies the entries when the app writes references.bib - or will, at the next compile; a project
  // that has no bibliography at all yet is treated the same, so that a first draft is not covered in warnings
  const library = ref.state === 'generated' || (ref.state === 'none' && (usesReferences(project) || (!loadsBib && !hasItems)));
  const items = loadLib().items;
  // A .bib file that is loaded but is not a file of this project (a path outside the folder, a file of the TeX
  // installation such as IEEEabrv, one that is too large to read here): its keys are unknown, so no key may be
  // called undefined. references.bib itself counts as there when the app is going to write it.
  const outside = [...named].filter(([file, found]) => !found && !(library && /^(?:\.\/)?references\.bib$/.test(file))).map(([file]) => file);
  const want = projectCited(project, files); // what the .tex files and the last LaTeX run cite, counted the way writeReferences does
  const r = refcheck.check({ files, generated: ref.state === 'generated' ? ref.rel : null, library, items, scope: project.bibScope,
    outside, alsoCited: want ? want.keys : null });
  if (library && want) r.counts.citedInLibrary = refcheck.pickCited(items, want).length; // the entries an "only cited" references.bib holds
  r.counts.citedOnly = r.counts.citedInLibrary; // what "only cited" would hold, whatever the scope is
  if (project.bibScope === 'project') { // the papers of the project are there on purpose, cited or not
    const members = memberItems(project, items), mine = new Set(members.map((i) => String(i.citekey).toLowerCase()));
    r.unused = r.unused.filter((u) => !mine.has(u.key.toLowerCase()));
    r.counts.unused = r.unused.length;
    if (library && want && !want.all) r.counts.citedInLibrary = new Set([...refcheck.pickCited(items, want), ...members]).size;
  }
  return { ...r, referencesFile: ref.rel, referencesState: ref.state, loadsBib, citedKeys: [...(want || refcheck.citedKeys(files)).keys] };
}
// What a project cites as projectRefs and writeReferences count it: the .tex files plus the .aux / .bcf of the last
// LaTeX run of the main file; null when there is no main file
function projectCited(project, files) {
  if (!project.mainFile) return null;
  try {
    const main = P.resolveIn(project, project.mainFile);
    return refcheck.citedKeys(files, auxTexts(path.dirname(main.abs), path.basename(main.abs).replace(/\.[^.]+$/, '')));
  } catch { return null; } // the .tex files alone then
}

// ---------- the papers of a project ----------
// Library items the user added to a project (settings.json projectSettings[id].papers), in the order they were added.
// Papers in the trash are not in the library and are not shown; putting one back brings it back here.
const memberItems = (project, items = loadLib().items) => {
  const byId = new Map(items.map((i) => [i.id, i]));
  return P.papers(project).map((m) => byId.get(m.id)).filter(Boolean);
};
const STATUS_LABEL = { unread: 'To read', reading: 'Reading', done: 'Done' };
const statusOf = (it) => (STATUS_LABEL[it.status] ? it.status : 'unread');
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function firstAuthor(author) {
  const list = String(author || '').replace(/[{}]/g, '').split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean);
  if (!list.length) return '';
  const last = list[0].includes(',') ? list[0].split(',')[0].trim() : list[0].split(/\s+/).pop();
  return list.length > 1 ? `${last} et al.` : last;
}
// -> {project: {id, name}, papers: [row], citedNotMember: [{id, citekey, title}], counts, nociteAll}
function projectPapers(project) {
  const items = loadLib().items, byId = new Map(items.map((i) => [i.id, i]));
  const members = P.live(P.papers(project), items);
  const files = project.missing ? [] : sourceTexts(project, /\.(tex|ltx)$/i);
  const want = projectCited(project, files) || refcheck.citedKeys(files);
  const low = new Set([...want.keys].map((k) => k.toLowerCase()));
  const uses = new Map(); // BibTeX does not tell Foo2020 from foo2020
  for (const [k, n] of want.uses) uses.set(k.toLowerCase(), (uses.get(k.toLowerCase()) || 0) + n);
  const noted = new Set(writing.notedIds()), now = new Date();
  const papers = members.map((m) => {
    const it = byId.get(m.id), f = it.fields || {}, key = String(it.citekey || '').toLowerCase();
    return { id: it.id, citekey: it.citekey || '', title: oneLine(f.title, 300) || it.citekey || 'Untitled', author: firstAuthor(f.author),
      year: oneLine(f.year, 8), status: statusOf(it), starred: !!it.starred, added: m.added || null, cited: !!key && low.has(key),
      citedCount: (key && uses.get(key)) || 0, hasNote: noted.has(it.id), highlights: highlights.count(it.id), quiz: quiz.stats(it.id, now),
      pages: Number.isInteger(it.pages) ? it.pages : null, readingPage: it.reading && Number.isInteger(it.reading.page) ? it.reading.page : null };
  });
  const mine = new Set(members.map((m) => m.id));
  const citedNotMember = items.filter((i) => !mine.has(i.id) && i.citekey && low.has(String(i.citekey).toLowerCase())).slice(0, 500)
    .map((i) => ({ id: i.id, citekey: i.citekey, title: oneLine(i.fields && i.fields.title, 300) || i.citekey }));
  const n = (fn) => papers.filter(fn).length;
  const counts = { total: papers.length, toRead: n((r) => r.status === 'unread'), reading: n((r) => r.status === 'reading'), done: n((r) => r.status === 'done'),
    cited: n((r) => r.cited), noNote: n((r) => !r.hasNote), due: papers.reduce((s, r) => s + r.quiz.due, 0) };
  return { project: { id: project.id, name: project.name }, papers, citedNotMember, counts, nociteAll: want.all };
}
// -> {papers, ignored, added, removed}: added / removed are the ids this call really changed (an Undo takes back only those)
function editProjectPapers(project, body) {
  const before = new Set(P.papers(project).map((m) => m.id));
  const r = P.editPapers(project, { add: body.add == null ? [] : body.add, remove: body.remove == null ? [] : body.remove });
  const after = new Set(r.papers.map((m) => m.id));
  return { papers: P.live(r.papers).map((m) => m.id), ignored: r.ignored,
    added: [...after].filter((id) => !before.has(id)), removed: [...before].filter((id) => !after.has(id)) };
}
// GET /api/memberships: every project (cheap) and, per library item, the projects it is in
function memberships() {
  const known = new Set(loadLib().items.map((i) => i.id)), byItem = {};
  const projects = P.listLite();
  for (const pr of projects) for (const m of P.papers(pr)) if (known.has(m.id)) (byItem[m.id] || (byItem[m.id] = [])).push(pr.id);
  return { projects, byItem };
}
// The reading pack of a project: <exportDir>/<name> - reading pack/ with reading-list.md, references.bib (the
// BibTeX of its papers) and notes/ (their notes, exported like "Export references" does). Never inside the project.
// into: a scratch folder to write the pack into instead (the .zip download), then nothing is checked or trashed.
const packName = (name) => String(name || 'project').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || 'project';
// into (the zip download): one paper package per paper (notes.writePackages: <key>/<key>.md with the links, .bib,
// .pdf when `pdf`, assets/) instead of the notes/ folder; reading-list.md stays the one index (with each paper's
// venue and links line) and references.bib is written once, here
async function readingPack(project, { into = null, pdf = true, links = true } = {}) {
  const all = P.listLite();
  // two projects of the same name (an internal one and a folder on disk) must not share one pack folder
  const same = all.some((o) => o.id !== project.id && packName(o.name) === packName(project.name));
  // in a zip the top folder is ASCII: zip(1) does not mark UTF-8 names, so Windows would garble a Chinese name
  const ascii = packName(project.name).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  const base = into || notes.exportDir(), dir = path.join(base, into ? `${ascii ? ascii + ' - ' : ''}reading pack`
    : `${packName(project.name)}${same ? ` (${project.id})` : ''} - reading pack`);
  const real = (p) => plat.realpathNear(p); // native on Windows (8.3 names expanded), also for a folder not made yet
  const packReal = path.join(real(base), path.basename(dir));
  // never write into a project folder, and never trash one that is inside the pack folder
  for (const o of into ? [] : all) {
    const pr = real(o.path);
    if (plat.insideAnyCase(pr, packReal) || plat.insideAnyCase(packReal, pr)) throw httpErr(400, `The export folder overlaps the folder of the project “${o.name}” - choose another export folder in Settings`);
  }
  const info = projectPapers(project), items = memberItems(project);
  fs.mkdirSync(dir, { recursive: true });
  // the notes of an earlier pack go to the trash, so that a paper taken out of the project is not left there
  const oldNotes = path.join(dir, 'notes');
  if (!into && fs.existsSync(oldNotes)) core.moveToTrash(oldNotes, 'reading-pack', `${project.id}-${P.stamp()}`, 'notes');
  const noteName = new Map();
  let packed = null;
  if (into) {
    packed = await notes.writePackages(dir, items, { pdf, links, index: false });
    for (const it of items) if (packed.names[it.id]) noteName.set(it.id, `${packed.names[it.id]}/${packed.names[it.id]}.md`);
  } else {
    const exported = notes.exportNotes(dir, { ids: new Set(items.map((i) => i.id)) });
    for (const it of items) if (exported.names[it.id]) noteName.set(it.id, 'notes/' + exported.names[it.id]);
  }
  fs.writeFileSync(path.join(dir, 'references.bib'), items.length ? allBibtex({ items }) : '');
  const row = new Map(info.papers.map((r) => [r.id, r]));
  let md = `# Reading pack: ${project.name}\n\n${items.length} paper${items.length === 1 ? '' : 's'}, exported ${new Date().toLocaleDateString('sv-SE')}. BibTeX: [references.bib](references.bib)\n\n`;
  for (const it of items) {
    const f = it.fields || {}, r = row.get(it.id);
    md += `## ${oneLine(f.title, 300) || it.citekey || 'Untitled'}${f.year ? ` (${oneLine(f.year, 8)})` : ''}\n\n`;
    md += `${oneLine(f.author, 600) || 'unknown authors'}  \n\`${it.citekey || ''}\` · ${STATUS_LABEL[statusOf(it)]} · cited: ${r && r.cited ? 'yes' : 'no'}\n\n`;
    if (it.brief) md += `${oneLine(it.brief, 800)}\n\n`;
    for (const k of writing.topKeyPoints(it, 5)) md += `- ${oneLine(k.text, 500)}${Number.isInteger(k.page) && k.page > 0 ? ` (p. ${k.page})` : ''}\n`;
    if (writing.topKeyPoints(it, 1).length) md += '\n';
    const line = packed ? notes.indexLine(it, packed.links[it.id] || null) : '';
    if (noteName.has(it.id)) md += `${packed ? 'Paper package' : 'Note'}: [${noteName.get(it.id)}](${encodeURI(noteName.get(it.id))})${line ? ' · ' + line : ''}\n\n`;
  }
  fs.writeFileSync(path.join(dir, 'reading-list.md'), md);
  return { dir, files: ['reading-list.md', 'references.bib', ...noteName.values()], markdown: md };
}
// POST /api/projects/:id/annotated {ids?}: an annotated bibliography in LaTeX (no AI call); default: the project's papers
function annotated(project, body) {
  let items;
  if (body.ids != null) {
    if (!Array.isArray(body.ids) || body.ids.length > MAX_PAPERS) throw httpErr(400, `ids must be a list of at most ${MAX_PAPERS} paper ids`);
    const byId = new Map(loadLib().items.map((i) => [i.id, i]));
    items = [...new Set(body.ids.map(String))].map((x) => byId.get(x)).filter(Boolean);
  } else items = memberItems(project);
  return writing.annotatedBibliography(items);
}

function parseLog(log, dir, root) {
  const errors = [], warnings = [];
  for (const line of plat.lines(log)) { // TeX on Windows (MiKTeX) may end lines with \r\n
    let m;
    if (/==> Fatal error/.test(line)) continue;
    if ((m = line.match(/^(.+?\.[A-Za-z0-9_]+):(\d+): (.*)$/))) {
      const rel = path.relative(root, path.resolve(dir, m[1])).split(path.sep).join('/');
      const inProject = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      errors.push({ file: inProject ? rel : null, line: inProject ? Number(m[2]) : null, msg: inProject ? m[3] : `${m[1]}: ${m[3]}` });
    } else if (/^! /.test(line)) errors.push({ file: null, line: null, msg: line.slice(2) });
    else if ((m = line.match(/Citation `([^']+)' .*undefined/))) warnings.push(`Undefined citation: ${m[1]}`);
    else if ((m = line.match(/Reference `([^']+)' .*undefined/))) warnings.push(`Undefined reference: ${m[1]}`);
    else if ((m = line.match(/^(?:LaTeX|(?:Package|Class) (\S+)) Warning: (.+)$/))) warnings.push((m[1] ? m[1] + ': ' : '') + m[2].trim());
  }
  return { errors, warnings: [...new Set(warnings)].slice(0, 200) };
}

// "Recompile from scratch": the build artefacts of the main file, and every .aux in the project (\include writes
// one per chapter), are moved to the workspace trash so the next run starts clean.
function clearAux(project, main) {
  const dir = path.dirname(main.abs), stem = path.basename(main.abs).replace(/\.[^.]+$/, '');
  const dest = path.join(DIRS.trash, project.id, P.stamp() + '-build-files');
  let n = 0;
  const trash = (abs) => { try { P.move(abs, path.join(dest, path.relative(main.root, abs))); n++; } catch { /* leave it */ } };
  (function walk(d, depth) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules' && depth < 8) walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;
      const low = e.name.toLowerCase();
      if (low.endsWith('.aux') || (d === dir && e.name.startsWith(stem + '.') && isArtefact(e.name))) trash(abs);
    }
  })(main.root, 0);
  return n;
}

const compiling = new Map(); // one compile per project at a time
// opts: {fromScratch: clear the build files first, stopOnFirstError (default true, as before)}
async function compile(project, opts = {}) {
  if (!project.mainFile) throw httpErr(400, 'This project has no main .tex file. Choose one in the project settings.');
  const id = project.id;
  while (compiling.get(id)) await compiling.get(id);
  const job = (async () => {
    const main = P.resolveIn(project, project.mainFile);
    if (!main.exists) throw httpErr(400, 'Main file not found: ' + project.mainFile);
    const dir = path.dirname(main.abs), base = path.basename(main.abs), stem = base.replace(/\.[^.]+$/, '');
    writeReferences(project, dir, stem);
    const t0 = Date.now();
    const cleared = opts.fromScratch ? clearAux(project, main) : 0;
    const halt = opts.stopOnFirstError !== false;
    // -norc: never load latexmkrc / .latexmkrc (they are Perl code and a project folder may come from anywhere)
    const engine = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[project.compiler] || '-pdf';
    const r = await run('latexmk', ['-norc', engine, '-interaction=nonstopmode', '-file-line-error', ...(halt ? ['-halt-on-error'] : []), '-synctex=1', '-no-shell-escape',
      ...(opts.fromScratch ? ['-g'] : []), base],
      { cwd: dir, timeout: 180000, env: { ...process.env, max_print_line: '1000', error_line: '254', half_error_line: '238' } });
    let log = '';
    try { log = fs.readFileSync(path.join(dir, stem + '.log'), 'latin1'); } catch { log = r.out + r.err; }
    const { errors, warnings } = parseLog(log, dir, main.root);
    if (r.code === -1 && !errors.length) errors.push({ file: null, line: null, msg: 'Could not run latexmk: ' + r.err });
    else if (r.code !== 0 && !errors.length) {
      errors.push({ file: null, line: null, msg: 'Compilation failed - see the log' });
      log += '\n--- latexmk ---\n' + (r.out + r.err).slice(-6000);
    }
    // keep the last good PDF for the preview, outside the project folder
    const out = path.join(dir, stem + '.pdf'), pv = previewPdf(project);
    // without "stop on first error" TeX carries on past errors and still writes a PDF: show that one too
    let fresh = r.code === 0 && fs.existsSync(out);
    if (!fresh && !halt) { try { fresh = fs.statSync(out).mtimeMs >= t0 - 1000; } catch { /* no PDF */ } }
    if (fresh) { fs.mkdirSync(path.dirname(pv), { recursive: true }); fs.copyFileSync(out, pv); }
    return { ok: r.code === 0, hasPdf: fs.existsSync(pv), errors, warnings, ms: Date.now() - t0, log: log.slice(-200000),
      synctex: fs.existsSync(path.join(dir, stem + '.synctex.gz')), ...(opts.fromScratch ? { cleared } : {}) };
  })();
  const gate = job.then(() => {}, () => {}).finally(() => { if (compiling.get(id) === gate) compiling.delete(id); });
  compiling.set(id, gate);
  return job;
}

async function zipProject(project) {
  const files = projectFiles(project, 20000).filter((f) => f.type === 'file').map((f) => f.path);
  if (!files.length) throw httpErr(400, 'The project has no files');
  const out = path.join(DIRS.cache, project.id, `download-${newId()}.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cwd = realpath(project.path);
  const r = await run('zip', ['-q', out, '-@'], { cwd, input: files.join('\n') + '\n', timeout: 120000 });
  if (r.code === -1) { // no zip program (Windows): the same zip, written by lib/zip.js
    try { await writeZip(out, cwd, files); return out; }
    catch (e) { fs.rmSync(out, { force: true }); throw httpErr(500, 'zip failed: ' + e.message); }
  }
  if (r.code !== 0 || !fs.existsSync(out)) { fs.rmSync(out, { force: true }); throw httpErr(500, 'zip failed: ' + (r.err || r.out || r.code)); }
  return out;
}

// ---------- SyncTeX ----------
// The PDF latexmk wrote next to the main file (not the cached preview copy) and its .synctex.gz.
function synctexTarget(project) {
  if (!project.mainFile) throw httpErr(404, 'This project has no main file, so there is no SyncTeX data');
  const main = P.resolveIn(project, project.mainFile);
  if (!main.exists) throw httpErr(404, 'Main file not found: ' + project.mainFile);
  const dir = path.dirname(main.abs), stem = path.basename(main.abs).replace(/\.[^.]+$/, '');
  if (!fs.existsSync(path.join(dir, stem + '.pdf')) || !(fs.existsSync(path.join(dir, stem + '.synctex.gz')) || fs.existsSync(path.join(dir, stem + '.synctex')))) {
    throw httpErr(404, 'No SyncTeX data yet - compile the project first');
  }
  return { main, dir, pdf: stem + '.pdf' };
}
// "Key:value" records between "SyncTeX result begin" and "SyncTeX result end"; a new record starts at every `first` key
function synctexRecords(out, first) {
  const recs = []; let cur = null, on = false;
  for (const line of String(out).split(/\r?\n/)) {
    if (/^SyncTeX result begin/.test(line)) { on = true; continue; }
    if (/^SyncTeX result end/.test(line)) { on = false; continue; }
    if (!on) continue;
    const i = line.indexOf(':'); if (i < 1) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === first) { cur = {}; recs.push(cur); }
    if (cur && !(k in cur)) cur[k] = v;
  }
  return recs;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
async function synctex(project, body) {
  const { main, dir, pdf } = synctexTarget(project);
  if (body.direction === 'forward') {
    const r = P.resolveIn(project, body.file);
    if (!r.exists) throw httpErr(404, 'No such file: ' + r.rel);
    const line = Math.max(1, parseInt(body.line, 10) || 1), col = Math.max(0, parseInt(body.column, 10) || 0);
    // the name must match the one TeX recorded: try the path as TeX saw it from the main file's folder, then others
    const rel = path.relative(dir, r.abs);
    const names = [...new Set([rel, './' + rel, path.join(dir, rel), dir + '/./' + rel, r.abs])];
    for (const name of names) {
      const res = await run('synctex', ['view', '-i', `${line}:${col}:${name}`, '-o', pdf], { cwd: dir, timeout: 20000 });
      if (res.code === -1) throw httpErr(501, `The synctex program was not found (it comes with ${plat.texHint()})`);
      const boxes = synctexRecords(res.out, 'Output').map((o) => {
        const page = num(o.Page), h = num(o.h), v = num(o.v), W = num(o.W), H = num(o.H);
        if (!page || h == null || v == null) return null;
        return { page, x: h, y: v - (H || 0), width: W || 0, height: H || 0 };
      }).filter(Boolean);
      if (boxes.length) return { ...boxes[0], boxes: boxes.slice(0, 20) };
    }
    throw httpErr(404, 'SyncTeX found no PDF position for that line');
  }
  if (body.direction === 'inverse') {
    const page = parseInt(body.page, 10), x = Number(body.x), y = Number(body.y);
    if (!(page >= 1) || !Number.isFinite(x) || !Number.isFinite(y)) throw httpErr(400, 'page, x and y must be numbers');
    const res = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdf}`], { cwd: dir, timeout: 20000 });
    if (res.code === -1) throw httpErr(501, `The synctex program was not found (it comes with ${plat.texHint()})`);
    for (const o of synctexRecords(res.out, 'Output')) {
      if (!o.Input || !(num(o.Line) >= 1)) continue;
      let abs = path.resolve(dir, o.Input);
      try { abs = realpath(abs); } catch { continue; }
      if (!inside(main.root, abs) || abs === main.root) continue; // a package or class file outside the project
      const c = num(o.Column);
      return { file: path.relative(main.root, abs).split(path.sep).join('/'), line: num(o.Line), column: c != null && c >= 0 ? c : 0 };
    }
    throw httpErr(404, 'SyncTeX found no source line for that position');
  }
  throw httpErr(400, "direction must be 'forward' or 'inverse'");
}

// ---------- project-wide search, labels, word count ----------
const textFiles = (project) => projectFiles(project, 5000).filter((f) => f.type === 'file' && f.kind === 'text' && f.size <= MAX_TEXT);
function readProjectText(project, rel) {
  try { const r = P.resolveIn(project, rel); return r.exists ? fs.readFileSync(r.abs, 'utf8') : null; } catch { return null; }
}
async function searchProject(project, q, { regex, cs }) {
  if (typeof q !== 'string' || !q) throw httpErr(400, 'q is required');
  if (q.length > 1000) throw httpErr(400, 'The search text is too long');
  if (regex) { try { new RegExp(q); } catch (e) { throw httpErr(400, e.message); } }
  const files = [];
  for (const f of textFiles(project)) { // paths are resolved here, on the main thread, through the project resolver
    try { const r = P.resolveIn(project, f.path); if (r.exists) files.push({ path: f.path, abs: r.abs }); } catch { /* skip */ }
  }
  if (!regex) return searchFiles(files, q, { regex: false, cs });
  // a user-typed pattern can backtrack for ever: match in a worker thread that is terminated after 2 s
  try { return await runRegexSearch(files, q, { regex: true, cs }); }
  catch (e) { throw httpErr(e.code === 'TIMEOUT' ? 400 : 500, e.message); }
}
// every \label{...} in the project's .tex files (text after an unescaped % is ignored)
function projectLabels(project) {
  const labels = [];
  for (const f of textFiles(project)) {
    if (!/\.tex$/i.test(f.path)) continue;
    const text = readProjectText(project, f.path);
    if (text == null) continue;
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/(^|[^\\])%.*$/, '$1');
      for (const m of line.matchAll(/\\label\{([^{}]+)\}/g)) if (labels.length < 5000) labels.push({ name: m[1].trim(), file: f.path, line: i + 1 });
    });
  }
  return labels;
}
const toolCache = new Map(); // program -> found?
async function hasTool(cmd, args) {
  if (!toolCache.has(cmd)) toolCache.set(cmd, (await run(cmd, args, { timeout: 15000 })).code !== -1);
  return toolCache.get(cmd);
}
// Words of the document, in all and per section. texcount reads the main file with everything it includes merged in
// (-merge), so the words of a section that lives in an \input file count for that section. Chinese, Japanese or
// Korean text is counted by character (-ch / -ja / -kr).
function cjkFlags(project) {
  let han = false, kana = false, hangul = false, read = 0;
  for (const f of textFiles(project)) {
    if (!/\.(tex|ltx)$/i.test(f.path) || read > 20 * 1024 * 1024) continue;
    const text = readProjectText(project, f.path);
    if (text == null) continue;
    read += text.length;
    han = han || /[一-鿿]/.test(text); kana = kana || /[぀-ヿ]/.test(text); hangul = hangul || /[가-힯]/.test(text);
  }
  return kana ? ['-ja'] : hangul ? ['-kr'] : han ? ['-ch'] : [];
}
// texcount prints what follows the heading command up to the end of the line: keep the title, i.e. stop at the brace
// that closes it ("Introduction}\label{sec:intro" -> "Introduction")
function headingTitle(t) {
  let depth = 0, i = 0;
  for (; i < t.length; i++) { const c = t[i]; if (c === '\\') { i++; continue; } if (c === '{') depth++; else if (c === '}' && --depth < 0) break; }
  return t.slice(0, i).trim().slice(0, 300);
}
const SUB_KINDS = { Part: 'part', Chapter: 'chapter', Section: 'section', Subsection: 'subsection' };
const SUB_LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3 };
async function wordCount(project) {
  if (!project.mainFile) throw httpErr(400, 'This project has no main .tex file');
  const main = P.resolveIn(project, project.mainFile);
  if (!main.exists) throw httpErr(400, 'Main file not found: ' + project.mainFile);
  const cjk = cjkFlags(project);
  const r = await run('texcount', ['-merge', '-utf8', '-sub=subsection', ...cjk, path.basename(main.abs)], { cwd: path.dirname(main.abs), timeout: 60000 });
  if (r.code === -1) throw httpErr(501, 'texcount is not installed');
  const out = r.out || '';
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  const words = num(/^Words in text:\s*(\d+)/m), headerWords = num(/^Words in headers:\s*(\d+)/m), captionWords = num(/^Words outside text[^:\n]*:\s*(\d+)/m);
  if (words == null || headerWords == null || captionWords == null) throw httpErr(500, 'texcount gave no result: ' + (out.trim() || r.err || '').slice(0, 300));
  // "  5+1+0 (1/0/0/0) Section: Introduction" - one line per part / chapter / section / subsection, "_top_" = before the first
  const sections = [];
  for (const m of out.matchAll(/^\s+(\d+)\+(\d+)\+(\d+)\s+\(\d+\/\d+\/\d+\/\d+\)\s+(.*)$/gm)) {
    const own = Number(m[1]) + Number(m[2]) + Number(m[3]);
    const t = m[4].match(/^(Part|Chapter|Section|Subsection):\s?(.*)$/);
    sections.push(t ? { kind: SUB_KINDS[t[1]], title: headingTitle(t[2]), words: own, total: own } : { kind: 'top', title: '', words: own, total: own });
  }
  // total = the heading with everything under it (a section with its subsections)
  sections.forEach((sec, i) => {
    if (sec.kind === 'top') return;
    for (let j = i + 1; j < sections.length && sections[j].kind !== 'top' && SUB_LEVEL[sections[j].kind] > SUB_LEVEL[sec.kind]; j++) sec.total += sections[j].words;
  });
  return { words, headerWords, captionWords, headers: num(/^Number of headers:\s*(\d+)/m) || 0, floats: num(/^Number of floats[^:\n]*:\s*(\d+)/m) || 0,
    inlineMath: num(/^Number of math inlines:\s*(\d+)/m) || 0, displayMath: num(/^Number of math displayed:\s*(\d+)/m) || 0,
    total: words + headerWords + captionWords, sections, byCharacter: cjk.length > 0, mainFile: project.mainFile };
}

// ---------- spelling: the project dictionary and the words of the references ----------
// {words: what the user added for this project, known: the words of the project's .bib files and of the library
// (names, title words), which are accepted as well}
function projectSpelling(project) {
  const texts = [];
  let read = 0;
  for (const f of textFiles(project)) {
    if (!/\.bib$/i.test(f.path) || read > 8 * 1024 * 1024) continue;
    const text = readProjectText(project, f.path);
    if (text != null) { texts.push(text); read += text.length; }
  }
  try {
    for (const it of loadLib().items || []) {
      const fl = (it && it.fields) || {};
      texts.push(fl.author, fl.editor, fl.title, fl.booktitle, fl.journal, fl.publisher);
    }
  } catch { /* a damaged library must not break the editor */ }
  return { words: P.words(project), known: spell.wordsOf(texts) };
}
function editSpelling(project, body) {
  const list = (v, name) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 500) throw httpErr(400, `${name} must be a list of words`);
    return v.map((w) => { const c = spell.cleanWord(w); if (!c) throw httpErr(400, `“${String(w).slice(0, 40)}” is not a word (letters, with ' or - inside)`); return c; });
  };
  P.editWords(project, { add: list(body.add, 'add'), remove: list(body.remove, 'remove') });
  return projectSpelling(project);
}
// the English word list, as plain text with one word per line; the browser keeps it (ETag) until the server's copy changes
function sendWordList(ctx) {
  const list = spell.wordList();
  if (!list) return ctx.send(404, { error: 'No English word list was found on this computer (looked for /usr/share/dict/words), so spelling cannot be checked.' });
  const { req, res } = ctx;
  const head = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=0, must-revalidate', ETag: list.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === list.etag) { res.writeHead(304, head); res.end(); return true; }
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (gz) head['Content-Encoding'] = 'gzip';
  res.writeHead(200, head);
  res.end(gz ? list.gzip : list.plain);
  return true;
}

// ---------- zip import ----------
// Entries of a zip from its central directory (the part unzip trusts): [{name, symlink, size}]. The local header of
// every entry must carry the very same name: bsdtar (the unpacker on Windows) names files from the local headers, so a
// zip whose two names differ could slip a name past checkZip() that was never checked.
function zipEntries(buf) {
  const badZip = () => httpErr(400, 'That is not a valid .zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw badZip();
  const total = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw httpErr(400, 'This zip is too large (zip64 archives are not supported)');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw badZip();
    const host = buf.readUInt16LE(p + 4) >> 8, size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    if (p + 46 + nlen > buf.length) throw badZip();
    const loc = buf.readUInt32LE(p + 42);
    if (loc + 30 > buf.length || buf.readUInt32LE(loc) !== 0x04034b50) throw badZip();
    const lnlen = buf.readUInt16LE(loc + 26);
    if (lnlen !== nlen || loc + 30 + lnlen > buf.length || !buf.subarray(loc + 30, loc + 30 + lnlen).equals(buf.subarray(p + 46, p + 46 + nlen))) {
      throw httpErr(400, 'The zip is damaged or crafted (an entry has two different names) - not imported');
    }
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nlen), symlink: (mode & 0o170000) === 0o120000, special: host === 3 && (mode & 0o170000) !== 0 && ![0o100000, 0o040000, 0o120000].includes(mode & 0o170000), size });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
function checkZip(entries, platform = process.platform) {
  if (!entries.length) throw httpErr(400, 'The zip file is empty');
  if (entries.length > 20000) throw httpErr(400, 'The zip has too many files (more than 20000)');
  let total = 0;
  // two entries for one file ("a.tex" twice, "./a.tex" and "a.tex", and on the case-blind disks of Windows and macOS
  // "A.tex" and "a.tex"): the second would silently replace the first
  const blind = platform === 'win32' || platform === 'darwin', seen = new Map();
  for (const e of entries) {
    const n = e.name;
    if (e.symlink || e.special) throw httpErr(400, `The zip contains a symbolic link or special file (${n}) - not imported`);
    if (!n || n.includes('\0') || n.includes('\\') || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) {
      throw httpErr(400, `The zip contains an entry that would be written outside the project folder (${n}) - not imported`);
    }
    // Windows reads some names differently (".. " is "..", "a:b" is a stream of "a", NUL is a device): refused there
    // ("./" segments are fine: they mean nothing, as in normRel - Windows' own tar writes "./main.tex")
    if (platform === 'win32' && n.split('/').filter((s) => s && s !== '.').some(plat.winBadName)) {
      throw httpErr(400, `The zip contains a file name that Windows cannot use (${n}) - not imported`);
    }
    if (!n.endsWith('/')) {
      let key = n.split('/').filter((s) => s && s !== '.').join('/');
      if (blind) key = key.toLowerCase();
      if (seen.has(key)) throw httpErr(400, `The zip contains the same file twice (${seen.get(key)} and ${n}${blind ? ', which this computer does not tell apart' : ''}) - not imported`);
      seen.set(key, n);
    }
    total += e.size;
  }
  if (total > ZIP_MAX) throw httpErr(400, 'The zip unpacks to more than 1 GB');
}
const ZIP_MAX = 1024 * 1024 * 1024;
// bytes of the regular files below `dir` (lstat: links are not followed); stops counting once `stopAt` is passed
function treeSize(dir, stopAt = Infinity) {
  let total = 0;
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (total > stopAt) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else { try { total += fs.lstatSync(abs).size; } catch { /* vanished */ } }
    }
  })(dir);
  return total;
}
// The program that unpacks a .zip: unzip, else a bsdtar - Windows 10+ has one in System32 (tried first there, never
// a tar of another package found earlier on PATH), macOS in /usr/bin. GNU tar (Linux) cannot read a zip: then there
// is none. -> {kind 'unzip'|'tar', cmd} | null. A program that is found is remembered; a missing one is looked for
// again after a minute.
let unpacker = null;
async function findUnpacker() {
  if (unpacker && (unpacker.v || Date.now() - unpacker.t < 60000)) return unpacker.v;
  let v = null;
  if ((await run('unzip', ['-v'], { timeout: 15000 })).code !== -1) v = { kind: 'unzip', cmd: 'unzip' };
  else {
    const sys = process.platform === 'win32' ? path.win32.join(plat.getEnv(process.env, 'SystemRoot') || 'C:\\Windows', 'System32', 'tar.exe') : null;
    for (const t of [...(sys ? [sys] : []), 'tar']) {
      const r = await run(t, ['--version'], { timeout: 15000 });
      if (r.code === 0 && /bsdtar|libarchive/i.test(r.out + r.err)) { v = { kind: 'tar', cmd: t }; break; }
    }
  }
  unpacker = { t: Date.now(), v };
  return v;
}
const unzipMissing = () => httpErr(501, process.platform === 'linux'
  ? 'The unzip program was not found on this machine (install it, for example: sudo apt install unzip)'
  : 'The unzip program was not found on this machine');
// unzip into `out`, measuring what is really written: the sizes in the zip's directory are only a claim. The child is
// killed as soon as the output passes the cap. -> {code (unzip's: 1 = warnings only; tar's: 0 or failed), err, tooBig}
function unzipCapped(zip, out, cap, unp = { kind: 'unzip', cmd: 'unzip' }) {
  return new Promise((resolve) => {
    let err = '', done = false, tooBig = false, child;
    const finish = (code) => { if (done) return; done = true; clearInterval(poll); clearTimeout(timer); resolve({ code: unp.kind === 'tar' && code > 0 ? Math.max(2, code) : code, err, tooBig }); };
    const args = unp.kind === 'tar' ? ['-x', '-f', zip, '-C', out] : ['-q', '-o', zip, '-d', out];
    try { child = core.spawnTool(unp.cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, err: String(e), tooBig }); }
    const poll = setInterval(() => { if (treeSize(out, cap) > cap) { tooBig = true; clearInterval(poll); core.killTree(child); } }, 250);
    const timer = setTimeout(() => { err += '\n[timed out]'; core.killTree(child); }, 180000);
    child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    child.on('error', (e) => { err = String(e); finish(-1); });
    child.on('close', (code) => finish(code == null ? 137 : code));
  });
}
// After extraction: nothing but plain files and folders, all inside `root`, no file larger than the zip declared
// for it and not more than 1 GB in all.
function checkExtracted(root, entries) {
  const declared = new Map(entries.map((e) => [e.name.split('/').filter((s) => s && s !== '.').join('/'), e.size]));
  let total = 0;
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name), st = fs.lstatSync(abs), rel = path.relative(root, abs).split(path.sep).join('/');
      if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw httpErr(400, `The zip contains a symbolic link or special file (${rel}) - not imported`);
      if (st.isDirectory()) { walk(abs); continue; }
      total += st.size;
      if (declared.has(rel) && st.size > declared.get(rel)) throw httpErr(400, `The zip is damaged or lies about its content (${rel} is larger than the zip says) - not imported`);
      if (total > ZIP_MAX) throw httpErr(400, 'The zip unpacks to more than 1 GB');
    }
  })(root);
}
async function importZip(buf, name) {
  if (!buf.length) throw httpErr(400, 'Empty upload');
  const entries = zipEntries(buf);
  checkZip(entries);
  const tmp = path.join(DIRS.cache, 'import-' + newId()), zip = path.join(tmp, 'upload.zip'), out = path.join(tmp, 'x');
  fs.mkdirSync(out, { recursive: true });
  try {
    fs.writeFileSync(zip, buf);
    const unp = await findUnpacker();
    if (!unp) throw unzipMissing();
    const r = await unzipCapped(zip, out, ZIP_MAX, unp);
    if (r.tooBig) throw httpErr(400, 'The zip unpacks to more than 1 GB');
    if (r.code === -1) throw unzipMissing();
    if (r.code > 1) throw httpErr(400, 'Could not unpack the zip: ' + (r.err || unp.kind + ' error ' + r.code).trim().slice(0, 300));
    checkExtracted(out, entries);
    // drop Finder metadata; a zip that wraps everything in one folder becomes that folder
    fs.rmSync(path.join(out, '__MACOSX'), { recursive: true, force: true });
    let root = out;
    for (;;) {
      const ents = fs.readdirSync(root).filter((n) => n !== '.DS_Store');
      if (ents.length === 1 && fs.statSync(path.join(root, ents[0])).isDirectory()) root = path.join(root, ents[0]); else break;
    }
    if (!fs.readdirSync(root).length) throw httpErr(400, 'The zip file is empty');
    const id = P.freeName(name || 'imported');
    P.move(root, path.join(P.PROJECTS, id));
    return P.get(id);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); } // temporary unpack folder (never user files)
}

// ---------- folder browser ----------
// The folders inside `q` (absolute; none = the home folder) -> {status?, body: {path, parent, dirs}}. On Windows the
// "parent" of a drive (C:\) is the list of drives, shown as the folder "This PC", so that D:\ can be reached too.
const DRIVES = 'This PC';
function fsListing(q, { platform = process.platform, home = os.homedir(), fsm = fs } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32' && q === DRIVES) {
    const dirs = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try { if (fsm.statSync(d).isDirectory()) dirs.push({ name: d, path: d }); } catch { /* no such drive, or no disc in it */ }
    }
    return { body: { path: DRIVES, parent: null, dirs } };
  }
  const x = q ? plat.expandHome(q, home, platform) : home;
  if (q && !P.isAbsolute(x)) return { status: 400, body: { error: 'path must be absolute' } };
  const dir = P.resolve(x);
  let ents;
  try { ents = fsm.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { status: e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 400, body: { error: 'Cannot read that folder: ' + dir } }; }
  const dirs = [];
  for (const d of ents) {
    if (d.name.startsWith('.')) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) { try { isDir = fsm.statSync(P.join(dir, d.name)).isDirectory(); } catch { isDir = false; } }
    if (isDir) dirs.push({ name: d.name, path: P.join(dir, d.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const top = P.dirname(dir) === dir;
  return { body: { path: dir, parent: top ? (platform === 'win32' && /^[A-Za-z]:\\$/.test(dir) ? DRIVES : null) : P.dirname(dir), dirs } };
}

// ---------- routes ----------
async function handle(ctx) {
  const { req, url, path: p, segments: seg, method: M, json, send, sendFile } = ctx;

  // folder picker / browser
  if (p === '/api/fs/pick' && M === 'POST') {
    if (process.platform !== 'darwin') return send(501, { error: 'The native folder chooser is only available on macOS' });
    // the caller may name what the folder is for (letters and spaces only: the text goes into an AppleScript string)
    const b = await json().catch(() => ({}));
    const title = typeof b.prompt === 'string' && /^[A-Za-z ]{1,60}$/.test(b.prompt) ? b.prompt : 'Open LaTeX folder';
    const ac = new AbortController(); // the request was dropped (tab closed, reload): close the dialog too
    ctx.res.on('close', () => { if (!ctx.res.writableEnded) ac.abort(); });
    const r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${title}")`], { timeout: 5 * 60 * 1000, signal: ac.signal });
    const out = r.out.trim();
    if (r.code !== 0 || !out) {
      if (/-128|cancel/i.test(r.err) || /timed out/.test(r.err)) return send(200, { path: null });
      return send(500, { error: 'Could not open the folder chooser: ' + (r.err.trim() || r.code) });
    }
    return send(200, { path: out.length > 1 ? out.replace(/\/+$/, '') : out });
  }
  if (p === '/api/fs/list' && M === 'GET') {
    const r = fsListing(url.searchParams.get('path'));
    return send(r.status || 200, r.body);
  }

  // which optional command-line tools exist (the front end hides what cannot work)
  if (p === '/api/fs/tools' && M === 'GET') {
    const [texcount, synctexOk, unzip] = await Promise.all([hasTool('texcount', ['-version']), hasTool('synctex', ['help']), findUnpacker()]);
    return send(200, { texcount, synctex: synctexOk, unzip: !!unzip, spell: spell.available() });
  }
  if (p === '/api/spell/words' && M === 'GET') return sendWordList(ctx);

  // LaTeX projects (folders)
  if (p === '/api/projects' && M === 'GET') return send(200, { projects: url.searchParams.get('lite') ? P.listLite() : P.list() });
  if (p === '/api/memberships' && M === 'GET') return send(200, memberships());
  if (p === '/api/projects' && M === 'POST') { const { name, template } = await json(); return send(200, { project: P.create(name, template ? { template } : {}) }); }
  if (p === '/api/projects/import-zip' && M === 'POST') {
    const buf = await readBody(req, 100 * 1024 * 1024);
    const project = await importZip(buf, String(url.searchParams.get('name') || '').replace(/\.zip$/i, ''));
    return send(200, { project });
  }
  if (p === '/api/projects/open' && M === 'POST') { const b = await json(); return send(200, { project: P.openFolder(b.path) }); }
  if (seg[1] === 'projects' && seg[2] && seg.length <= 6) {
    const project = P.get(seg[2]); // 404 unless registered
    const id = project.id, q = url.searchParams, act = seg[3];
    if (!act && M === 'DELETE') {
      P.remove(project);
      if (!project.external) { // its history goes to the trash with it, so a new project of the same name starts clean
        try { if (fs.existsSync(H.dir(id))) P.move(H.dir(id), path.join(DIRS.trash, `${id}.history-${P.stamp()}`)); } catch (e) { console.error(e.message); }
        fs.rmSync(path.join(DIRS.cache, id), { recursive: true, force: true });
      }
      return send(200, { ok: true });
    }
    if (!act && M === 'GET') {
      if (project.missing) return send(200, { project, files: [] });
      scanExternal(project);
      return send(200, { project, files: projectFiles(project) });
    }
    if (act === 'pdf' && M === 'GET' && seg.length === 4) {
      return sendFile(previewPdf(project), 'application/pdf', q.get('download') ? attachment(project.name + '.pdf') : {});
    }
    // the papers of a project live in the settings, not in its folder: they work while the folder is missing too
    if (seg.length === 4 && act === 'papers' && M === 'GET') return send(200, projectPapers(project));
    if (seg.length === 4 && act === 'papers' && M === 'POST') return send(200, editProjectPapers(project, await json()));
    if (seg.length === 4 && act === 'reading-pack' && M === 'POST' && q.get('format') === 'zip') { // the same pack as a download
      const tmp = notes.scratchDir();
      try {
        const r = await readingPack(project, { into: tmp, pdf: q.get('pdf') !== '0', links: q.get('links') !== '0' });
        const zip = await notes.zipTree(tmp, [path.basename(r.dir)]);
        return sendFile(zip, 'application/zip', attachment(`${packName(project.name)} - reading pack.zip`), () => { fs.rm(zip, { force: true }, () => {}); fs.rm(tmp, { recursive: true, force: true }, () => {}); });
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    }
    if (seg.length === 4 && act === 'reading-pack' && M === 'POST') return send(200, await readingPack(project));
    if (seg.length === 4 && act === 'annotated' && M === 'POST') return send(200, annotated(project, await json()));
    if (project.missing && act !== 'history') return send(404, { error: 'The project folder no longer exists: ' + project.path });

    if (seg.length === 4) {
      if (act === 'settings' && M === 'PUT') return send(200, { project: P.setSettings(project, await json()) });
      if (act === 'file' && M === 'GET') return send(200, readText(project, q.get('path')));
      if (act === 'file' && M === 'PUT') return send(200, writeText(project, q.get('path'), await json()));
      if (act === 'file' && M === 'DELETE') {
        const r = P.resolveIn(project, q.get('path'));
        if (!r.exists) return send(404, { error: 'No such file: ' + r.rel });
        P.trashFile(project, r);
        return send(200, { ok: true });
      }
      if (act === 'raw' && M === 'GET') {
        const r = P.resolveIn(project, q.get('path'));
        if (!r.exists || !fs.statSync(r.abs).isFile()) return send(404, { error: 'No such file: ' + r.rel });
        // user files are served as inert data: no sniffing, no script execution if opened directly
        // (PDFs are exempt: the browser's PDF viewer does not run inside a sandbox)
        return sendFile(r.abs, mimeOf(r.abs), { 'X-Content-Type-Options': 'nosniff', ...(mimeOf(r.abs) === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
          ...(q.get('download') ? attachment(path.basename(r.rel)) : {}) });
      }
      if (act === 'files' && M === 'POST') { createEntry(project, await json()); return send(200, { ok: true }); }
      if (act === 'upload' && M === 'POST') {
        const overwrite = !!q.get('overwrite');
        const exists = (x) => { if (x.exists && !overwrite) throw httpErr(409, 'Already exists: ' + x.rel); if (x.exists && !fs.statSync(x.abs).isFile()) throw httpErr(400, 'Not a file: ' + x.rel); };
        exists(P.resolveIn(project, q.get('path'))); // fail early, before the body is transferred
        const buf = await readBody(req, 50 * 1024 * 1024);
        const r = P.resolveIn(project, q.get('path')); // again: things may have changed while the body arrived
        exists(r);
        const h = H.open(id);
        if (r.exists) keepOld(project, r, h); // the replaced file stays in the history or the trash
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        try { fs.writeFileSync(r.abs, buf, r.exists ? {} : { flag: 'wx' }); }
        catch (e) { if (e.code === 'EEXIST') throw httpErr(409, 'Already exists: ' + r.rel); throw e; }
        if (h.newest(r.rel) && buf.length <= MAX_TEXT && !buf.includes(0)) h.record(r.rel, buf, 'manual');
        h.commit();
        return send(200, { ok: true });
      }
      if (act === 'rename' && M === 'POST') { renameEntry(project, await json()); return send(200, { ok: true }); }
      if (act === 'rename-project' && M === 'POST') {
        const b = await json();
        if (typeof b.name !== 'string') return send(400, { error: 'name must be a string' });
        while (compiling.get(id)) await compiling.get(id); // never rename a folder latexmk is writing into
        const next = P.renameProject(project, b.name);
        if (next.id !== id) { // history and cached preview follow the new id
          for (const [from, to, what] of [[H.dir(id), H.dir(next.id), 'history'], [path.join(DIRS.cache, id), path.join(DIRS.cache, next.id), 'cache']]) {
            try {
              if (!fs.existsSync(from)) continue;
              if (fs.existsSync(to)) {
                const sa = fs.statSync(from), sb = fs.statSync(to);
                // not the same folder under another capitalisation: left over from an older project of that name
                if (!(sa.ino === sb.ino && sa.dev === sb.dev)) P.move(to, path.join(DIRS.trash, `${next.id}.${what}-${P.stamp()}`));
              }
              fs.renameSync(from, to);
            } catch (e) { console.error('rename-project', what, e.message); }
          }
        }
        return send(200, { project: next, previousId: id });
      }
      if (act === 'compile' && M === 'POST') { const b = await json(); return send(200, await compile(project, { fromScratch: !!b.fromScratch, stopOnFirstError: b.stopOnFirstError !== false })); }
      if (act === 'synctex' && M === 'POST') return send(200, await synctex(project, await json()));
      if (act === 'search' && M === 'GET') return send(200, await searchProject(project, q.get('q'), { regex: q.get('regex') === '1', cs: q.get('case') === '1' }));
      if (act === 'labels' && M === 'GET') return send(200, { labels: projectLabels(project) });
      if (act === 'refs' && M === 'GET') return send(200, projectRefs(project));
      if (act === 'wordcount' && M === 'GET') return send(200, await wordCount(project));
      if (act === 'spelling' && M === 'GET') return send(200, projectSpelling(project));
      if (act === 'spelling' && M === 'POST') return send(200, editSpelling(project, await json()));
      if (act === 'download' && M === 'GET') {
        const zip = await zipProject(project);
        return sendFile(zip, 'application/zip', attachment(project.name + '.zip'), () => fs.rm(zip, { force: true }, () => {}));
      }
      if (act === 'history' && M === 'GET') {
        const file = q.get('path') ? normRel(q.get('path')) : null;
        const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 200, 1), 5000);
        return send(200, { versions: H.list(id, file, limit) });
      }
    }
    if (act === 'history' && seg[4]) {
      if (seg.length === 5 && M === 'GET') { const { h, v } = historyVersion(project, seg[4]); return send(200, { version: H.pub(v), content: h.text(v) }); }
      if (seg.length === 5 && M === 'PUT') {
        const { h, v } = historyVersion(project, seg[4]);
        const b = await json();
        if (typeof b.label !== 'string') return send(400, { error: 'label must be a string' });
        v.label = H.cleanLabel(b.label); h.touch(); h.commit();
        return send(200, { version: H.pub(v) });
      }
      if (seg[5] === 'diff' && M === 'GET') {
        const against = q.get('against') || 'previous';
        if (against !== 'previous' && against !== 'current') return send(400, { error: "against must be 'previous' or 'current'" });
        const { h, v } = historyVersion(project, seg[4]);
        const ops = against === 'previous' ? diff.lineDiff(h.text(h.prevOf(v)), h.text(v)) : diff.lineDiff(h.text(v), currentText(project, v.file));
        return send(200, { version: H.pub(v), against, ops });
      }
      if (seg[5] === 'restore' && M === 'POST') return send(200, restoreVersion(project, seg[4]));
    }
  }

  return false;
}

// handle() is the route; _test holds the parts scripts/test-platform.js calls directly
module.exports = { handle, _test: { parseLog, synctexRecords, zipEntries, checkZip, fsListing, findUnpacker, importZip, zipProject } };
