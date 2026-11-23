// LaTeX projects: a project is a folder. Internal ones live in <workspace>/projects/<name>,
// external ones are folders anywhere on disk that the user opened (remembered in settings.json).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const plat = require('./platform');

const httpErr = (status, msg, extra) => Object.assign(new Error(msg), { status, extra });
const bad = (msg) => httpErr(400, msg);

const COMPILERS = ['pdflatex', 'xelatex', 'lualatex'];
const MAX_TEXT = 2 * 1024 * 1024;
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const TEXT_EXT = words(`tex bib sty cls bst bbx cbx lbx def cfg clo dtx ins ltx tikz pgf txt text md markdown csv tsv json yaml yml toml
  xml html htm css js mjs ts py r rmd m jl sh bash zsh c h cpp hpp java rs go rb pl lua ini conf latexmkrc gitignore gitattributes
  editorconfig gp gnuplot asy mp sql rst org tsx jsx bat ps1 dat`);
const TEXT_NAMES = words('latexmkrc makefile readme license dockerfile authors changelog todo');
const IMAGE_EXT = words('png jpg jpeg gif svg webp bmp ico');
const ARTEFACT_EXT = words('aux log fls fdb_latexmk out toc bbl blg lof lot nav snm vrb bcf xdv');
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip', json: 'application/json; charset=utf-8',
  eps: 'application/postscript', ps: 'application/postscript', tif: 'image/tiff', tiff: 'image/tiff',
};

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const isArtefact = (name) => { const n = name.toLowerCase(); return ARTEFACT_EXT.has(extOf(n)) || n.endsWith('.synctex.gz') || n.endsWith('.run.xml'); };
const excluded = (name, isDir) => name.startsWith('.') || name === 'node_modules' || (!isDir && isArtefact(name));
// (on Windows also its 8.3 short name GIT~1, GIT~2 ...: the native realpath expands it, the fallback one does not)
const isGitDir = (seg, platform = process.platform) => seg.toLowerCase() === '.git' || (platform === 'win32' && /^git~\d+$/i.test(seg));
// containment and "~" as in lib/platform.js (the platform argument is for the tests)
const inside = (root, p, platform = process.platform) => plat.inside(root, p, platform);
const expandHome = (p, platform = process.platform) => plat.expandHome(p, os.homedir(), platform);
// Windows: the native realpath also expands 8.3 short names (GIT~1 -> .git) and gives the case as it is on disk;
// where a volume makes it fail, the JavaScript one (lib/platform.js)
const realpath = (p) => plat.realpath(p);

function sniffText(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return !buf.subarray(0, n).includes(0);
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function kindOf(abs) {
  const name = path.basename(abs), ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext) || (!ext && TEXT_NAMES.has(name.replace(/^\./, '').toLowerCase()))) return 'text';
  if (MIME[ext]) return 'binary';
  return sniffText(abs) ? 'text' : 'binary';
}
function mimeOf(abs) {
  const ext = extOf(path.basename(abs));
  if (MIME[ext]) return MIME[ext];
  return kindOf(abs) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

// Lexical check of a project-relative path: forward slashes, no '..', not absolute, no NUL. On Windows also no name
// that Windows would read differently: a ':' (drive or alternate data stream), a trailing dot or space ('.. ' is '..'
// there), a device name (CON, NUL ...) or one of <>"|?*.
function normRel(rel, platform = process.platform) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw bad('Invalid path');
  if (rel.includes('\\')) throw bad('Invalid path: use forward slashes');
  if (rel.startsWith('/') || rel.startsWith('~') || /^[A-Za-z]:/.test(rel)) throw bad('Path must be relative to the project folder');
  const segs = [];
  for (const s of rel.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') throw bad('Path escapes the project folder');
    if (platform === 'win32' && plat.winBadName(s)) throw bad(`Invalid file name on Windows: ${s.slice(0, 80)}`);
    segs.push(s);
  }
  if (!segs.length) throw bad('Invalid path');
  return segs.join('/');
}

// templates for "New project" (the default template of older callers is passed in by lib/core.js)
const BLANK = String.raw`\documentclass{article}
\usepackage[utf8]{inputenc}

\title{Untitled}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}

\end{document}
`;
const EXAMPLE = {
  'main.tex': String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb,graphicx}
\usepackage{hyperref}

\title{An Example Project}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
This example shows the building blocks of a LaTeX paper: sections, mathematics, a figure, a table,
lists and cross-references. Edit the text on the left and the PDF on the right follows.
\end{abstract}

\input{sections/introduction}

\section{Mathematics}\label{sec:math}
Inline mathematics such as $e^{i\pi} + 1 = 0$ sits in the text; displayed equations get a number:
\begin{equation}\label{eq:gauss}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}
Equation~\eqref{eq:gauss} is the Gaussian integral.

\section{Figures and tables}\label{sec:floats}
Figure~\ref{fig:box} is drawn with a rule; replace it with \verb|\includegraphics| and your own image
(use the figure button in the toolbar). Table~\ref{tab:data} is a small table.

\begin{figure}[htbp]
  \centering
  \fbox{\rule{0pt}{2.5cm}\rule{6cm}{0pt}}
  \caption{A placeholder figure.}
  \label{fig:box}
\end{figure}

\begin{table}[htbp]
  \centering
  \begin{tabular}{|l|r|r|}
    \hline
    Method & Accuracy & Time (s) \\
    \hline
    Baseline & 81.2 & 14 \\
    Ours & 86.7 & 11 \\
    \hline
  \end{tabular}
  \caption{Example results.}
  \label{tab:data}
\end{table}

\section{Lists}
\begin{itemize}
  \item Bullet lists use \texttt{itemize}.
  \item \textbf{Bold} and \textit{italic} text.
\end{itemize}
\begin{enumerate}
  \item Numbered lists use \texttt{enumerate}.
  \item See Section~\ref{sec:intro} for the introduction.
\end{enumerate}

\end{document}
`,
  'sections/introduction.tex': String.raw`\section{Introduction}\label{sec:intro}
This section lives in its own file, \texttt{sections/introduction.tex}, and is pulled into the main
file with \verb|\input|. Splitting a long paper into one file per section keeps it manageable.

\subsection{Citing your library}
Use the cite button in the toolbar (or type \verb|\cite{| and pick a key) to cite a reference from
your library. Add \verb|\bibliographystyle{plain}| and \verb|\bibliography{references}| before
\verb|\end{document}| to print the reference list.
`,
};
// the writing checks of the editor (public/js/texlint.js) that a project can switch off
const CHECKS = ['spell', 'repeat', 'tie', 'quotes', 'pairs', 'todo', 'cite'];
// what the generated references.bib of a project holds: the entries it cites (default), the whole library, or the
// entries it cites plus the papers of the project
const BIB_SCOPES = ['cited', 'all', 'project'];
const MAX_WORDS = 5000;
const MAX_PAPERS = 1000;
// {pages, words, skipRefs}: the page / word limit of a document. Stored values are read leniently; strict = a
// request, where a wrong value is an error.
function cleanBudget(b, strict = false) {
  const out = { pages: null, words: null, skipRefs: false };
  if (!b || typeof b !== 'object') return out;
  for (const [k, max] of [['pages', 5000], ['words', 5000000]]) {
    const v = b[k];
    if (v == null || v === '' || v === 0) continue;
    if (Number.isInteger(v) && v > 0 && v <= max) out[k] = v;
    else if (strict) throw bad(`The ${k === 'pages' ? 'page' : 'word'} limit must be a whole number between 1 and ${max}`);
  }
  out.skipRefs = !!out.pages && b.skipRefs === true;
  return out;
}
const RESERVED = new Set(['open', 'import-zip']); // would collide with /api/projects/<route>
// ... and on Windows a device name (CON, NUL, AUX ...) cannot be a folder
const reservedName = (n) => RESERVED.has(n) || (process.platform === 'win32' && plat.winReserved(n));

module.exports = function createProjects({ ws, readJSON, writeJSON, template, loadLib = () => ({ items: [] }) }) {
  const PROJECTS = path.join(ws, 'projects');
  const TRASH = path.join(ws, 'trash');
  const SETTINGS_FILE = path.join(ws, 'settings.json');
  const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  const loadCfg = () => {
    const s = readJSON(SETTINGS_FILE, {});
    return { all: s, external: Array.isArray(s.externalProjects) ? s.externalProjects.filter((e) => e && e.id && e.path) : [],
      per: s.projectSettings && typeof s.projectSettings === 'object' ? s.projectSettings : {} };
  };
  const saveCfg = (c) => writeJSON(SETTINGS_FILE, { ...c.all, externalProjects: c.external, projectSettings: c.per });

  // The single path resolver used by every file endpoint. Walks the path segment by segment, realpath-ing
  // every existing component, so neither '..' nor a symlink can lead outside the project root.
  // Returns {rel, abs (real path), lpath (path of the entry itself, not following a final symlink), exists, root}.
  function resolveIn(project, rel) {
    const norm = normRel(rel);
    // Git metadata is never reachable through the file API: git trusts .git/config (filters, helpers, hooks run commands)
    if (norm.split('/').some((s) => isGitDir(s))) throw bad('The .git folder of a project cannot be read or changed here');
    let root;
    try { root = realpath(project.path); } catch { throw httpErr(404, 'The project folder no longer exists'); }
    const segs = norm.split('/');
    let cur = root, lpath = root, i = 0;
    for (; i < segs.length; i++) {
      const next = path.join(cur, segs[i]);
      try { fs.lstatSync(next); } catch (e) { if (e.code === 'ENOENT') break; throw bad('Invalid path'); }
      let real;
      try { real = realpath(next); } catch { throw bad('Invalid path (broken link)'); }
      if (!inside(root, real)) throw bad('Path escapes the project folder');
      if (path.relative(root, real).split(path.sep).some((s) => isGitDir(s))) throw bad('The .git folder of a project cannot be read or changed here'); // a link into .git
      lpath = next; cur = real;
    }
    const exists = i === segs.length;
    const abs = exists ? cur : path.join(cur, ...segs.slice(i));
    return { rel: norm, abs, lpath: exists ? lpath : abs, exists, root };
  }

  // Flat recursive listing sorted by path (dirs included), without dotfiles, node_modules and build artefacts.
  function listFiles(project, cap = 2000) {
    let root;
    try { root = realpath(project.path); } catch { return []; }
    const out = [];
    (function walk(dirAbs, prefix) {
      let ents;
      try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
      ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of ents) {
        if (out.length >= cap) return;
        const abs = path.join(dirAbs, d.name), rel = prefix + d.name;
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (excluded(d.name, st.isDirectory())) continue;
        if (d.isSymbolicLink()) { // linked files are fine if they stay inside; linked folders are not followed
          if (!st.isFile()) continue;
          try { if (!inside(root, realpath(abs))) continue; } catch { continue; }
        }
        if (st.isDirectory()) {
          out.push({ path: rel, type: 'dir', size: 0, mtime: st.mtimeMs, kind: null });
          walk(abs, rel + '/');
        } else if (st.isFile()) {
          out.push({ path: rel, type: 'file', size: st.size, mtime: st.mtimeMs, kind: kindOf(abs) });
        }
      }
    })(root, '');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // main.tex if present, else the first .tex (shallowest, alphabetical) containing \documentclass
  function detectMain(project) {
    if (fs.existsSync(path.join(project.path, 'main.tex'))) return 'main.tex';
    const tex = listFiles(project).filter((f) => f.type === 'file' && /\.tex$/i.test(f.path));
    const depth = (p) => p.split('/').length;
    tex.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1));
    for (const f of tex) {
      try {
        const fd = fs.openSync(path.join(project.path, f.path), 'r');
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (/^[^%\n]*\\documentclass/m.test(buf.toString('utf8', 0, n))) return f.path;
      } catch { /* unreadable: skip */ }
    }
    return null;
  }

  // ISO time of the newest file in a project folder (build artefacts and dotfiles do not count); bounded walk
  function newestMtime(root) {
    let newest = 0, seen = 0;
    (function walk(dir, depth) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        if (seen >= 5000) return;
        const isDir = d.isDirectory();
        if (excluded(d.name, isDir) || d.isSymbolicLink()) continue;
        seen++;
        if (isDir) { if (depth < 8) walk(path.join(dir, d.name), depth + 1); continue; }
        try { const m = fs.statSync(path.join(dir, d.name)).mtimeMs; if (m > newest) newest = m; } catch { /* skip */ }
      }
    })(root, 0);
    if (!newest) { try { newest = fs.statSync(root).mtimeMs; } catch { /* missing */ } }
    return newest ? new Date(newest).toISOString() : null;
  }

  function decorate(raw, cfg) {
    const st = cfg.per[raw.id] || {};
    let missing = true;
    try { missing = !fs.statSync(raw.path).isDirectory(); } catch { /* missing */ }
    // Overleaf link: stored by the Overleaf module under settings.json "overleafLinks", keyed by project id
    const links = cfg.all.overleafLinks, link = links && typeof links === 'object' ? links[raw.id] : null;
    const p = { ...raw, mainFile: null, compiler: COMPILERS.includes(st.compiler) ? st.compiler : 'pdflatex', missing,
      updatedAt: missing ? null : newestMtime(raw.path), overleaf: link && typeof link === 'object' ? link : null,
      budget: cleanBudget(st.budget), checksOff: Array.isArray(st.checksOff) ? st.checksOff.filter((c) => CHECKS.includes(c)) : [],
      bibScope: BIB_SCOPES.includes(st.bibScope) ? st.bibScope : 'cited' };
    if (missing) { p.mainFile = st.mainFile || null; return p; }
    if (st.mainFile) {
      try { const r = resolveIn(p, st.mainFile); if (r.exists && fs.statSync(r.abs).isFile()) p.mainFile = r.rel; } catch { /* stale setting */ }
    }
    if (!p.mainFile) p.mainFile = detectMain(p);
    return p;
  }
  function rawList(cfg) {
    const internal = fs.readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
      .map((name) => ({ id: name, name, path: path.join(PROJECTS, name), external: false }));
    const taken = new Set(internal.map((p) => p.id));
    const external = cfg.external.filter((e) => !taken.has(e.id))
      .map((e) => ({ id: e.id, name: path.basename(e.path) || e.path, path: e.path, external: true }));
    return [...internal, ...external];
  }
  const list = () => { const cfg = loadCfg(); return rawList(cfg).map((r) => decorate(r, cfg)); };
  // ids from the URL only ever match a registered / existing project
  function get(id) {
    const cfg = loadCfg();
    const raw = rawList(cfg).find((r) => r.id === id);
    if (!raw) throw httpErr(404, 'No such project');
    return decorate(raw, cfg);
  }

  // create(name): as before - makes the folder with the default template, or returns the existing project.
  // create(name, {template: 'blank' | 'example'}): a new project only (409 if the name is taken).
  function create(name, opts = {}) {
    name = safeName(name);
    if (!name || reservedName(name)) throw bad('Invalid project name (use letters, numbers, dashes)');
    const dir = path.join(PROJECTS, name);
    if (opts.template) {
      if (opts.template !== 'blank' && opts.template !== 'example') throw bad("template must be 'blank' or 'example'");
      if (fs.existsSync(dir)) throw httpErr(409, `A project named “${name}” already exists`);
    }
    if (!fs.existsSync(dir)) { // a new folder: settings left by an earlier folder of that name (deleted outside the app) do not carry over
      const cfg = loadCfg();
      if (cfg.per[name]) { delete cfg.per[name]; saveCfg(cfg); }
    }
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'main.tex');
    if (!fs.existsSync(f) && !fs.readdirSync(dir).length) {
      if (opts.template === 'example') {
        for (const [rel, text] of Object.entries(EXAMPLE)) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), text);
        }
      } else fs.writeFileSync(f, opts.template === 'blank' ? BLANK : template);
    }
    return get(name);
  }
  // a free internal project name based on `name` (name, name-2, name-3 ...)
  function freeName(name) {
    const base = safeName(name) || 'project';
    const cfg = loadCfg(), taken = (n) => reservedName(n) || fs.existsSync(path.join(PROJECTS, n)) || cfg.external.some((e) => e.id === n);
    if (!taken(base)) return base;
    for (let i = 2; ; i++) { const n = `${base.slice(0, 55)}-${i}`; if (!taken(n)) return n; }
  }
  // Rename an internal project: its folder is renamed, so its id changes. Settings (compiler, main file, Overleaf
  // link) follow here; the caller moves the history and the cache.
  function renameProject(project, name) {
    if (project.external) throw bad('A folder on disk cannot be renamed here - rename the folder itself and open it again');
    if (project.missing) throw httpErr(404, 'The project folder no longer exists');
    const nn = safeName(name);
    if (!nn || reservedName(nn)) throw bad('Invalid project name (use letters, numbers, dashes)');
    if (nn === project.id) return get(nn);
    const cfg = loadCfg(), dest = path.join(PROJECTS, nn);
    let clash = cfg.external.some((e) => e.id === nn);
    try { // an existing entry is fine only if it is this very folder (case-only rename on a case-insensitive disk)
      const a = fs.statSync(project.path), b = fs.lstatSync(dest);
      if (!(a.ino === b.ino && a.dev === b.dev)) clash = true;
    } catch { /* free */ }
    if (clash) throw httpErr(409, `A project named “${nn}” already exists`);
    fs.renameSync(project.path, dest);
    if (cfg.per[project.id]) { cfg.per[nn] = cfg.per[project.id]; delete cfg.per[project.id]; }
    else delete cfg.per[nn]; // a stale entry of a folder of that name that was deleted outside the app
    const links = cfg.all.overleafLinks;
    if (links && typeof links === 'object' && links[project.id]) {
      const next = { ...links, [nn]: links[project.id] }; delete next[project.id];
      cfg.all = { ...cfg.all, overleafLinks: next };
    }
    saveCfg(cfg);
    return get(nn);
  }

  function openFolder(p) {
    p = expandHome(String(p || '').trim());
    if (!p || p.includes('\0') || !path.isAbsolute(p)) throw bad('Give the absolute path of a folder');
    let real;
    try { real = realpath(p); if (!fs.statSync(real).isDirectory()) throw new Error('not a directory'); }
    catch { throw bad('That is not a folder: ' + p); }
    let home = os.homedir(); try { home = realpath(home); } catch { /* keep */ }
    if (real === path.parse(real).root || plat.samePath(real, home)) throw bad('Open a project folder, not your whole home folder or disk');
    let projReal = PROJECTS; try { projReal = realpath(PROJECTS); } catch { /* keep */ }
    if (path.dirname(real) === projReal) return get(path.basename(real)); // already an internal project
    const id = 'ext-' + crypto.createHash('sha1').update(real).digest('hex').slice(0, 10);
    const cfg = loadCfg();
    if (!cfg.external.some((e) => e.id === id)) {
      cfg.external.push({ id, path: real });
      // A renamed or moved folder gets a new id: it gets a COPY of the paper list of the one missing (or forgotten)
      // folder that had the same name (moved) or sat in the same folder (renamed), so that renaming or moving the
      // folder does not lose its papers. Nothing else carries over - never the Overleaf link (a new version of a
      // folder must not push to the old Overleaf project) - and the old entry is kept as it is (a folder on a drive
      // that is not mounted is "missing" too, and comes back with all its settings).
      if (!cfg.per[id]) {
        const gone = (p) => { try { return !fs.statSync(p).isDirectory(); } catch { return true; } };
        const like = (p) => typeof p === 'string' && p !== real && gone(p) && (path.basename(p) === path.basename(real) || path.dirname(p) === path.dirname(real));
        const cands = [...new Set([
          ...cfg.external.filter((e) => e.id !== id && like(e.path)).map((e) => e.id),
          ...Object.keys(cfg.per).filter((k) => k.startsWith('ext-') && cfg.per[k] && like(cfg.per[k].folder) && !cfg.external.some((e) => e.id === k)),
        ])].filter((k) => cfg.per[k]);
        // (several candidates with the same list - the same folder moved more than once - count as one)
        const lists = [...new Set(cands.map((k) => Array.isArray(cfg.per[k].papers) && cfg.per[k].papers.length ? JSON.stringify(cfg.per[k].papers.map((x) => x && x.id)) : '').filter(Boolean))];
        const from = lists.length === 1 ? cands.find((k) => JSON.stringify((cfg.per[k].papers || []).map((x) => x && x.id)) === lists[0]) : null;
        if (from) cfg.per[id] = { papers: cfg.per[from].papers.map((x) => ({ ...x })) };
      }
      saveCfg(cfg);
    }
    return get(id);
  }

  // The folder of a project as it may be handed to an AI CLI (the panel's --add-dir, a writable root of Codex's write
  // mode): its realpath, checked again here, because settings.json - where an external project's path is kept - is a
  // plain file that a hand edit or a program (an AI run included) can change. openFolder() binds an external id to its
  // folder (id = ext-<sha1 of the realpath>) and refuses the home folder and a disk root: the same is required now,
  // plus never the workspace, a folder inside it or a folder that holds it (that would hand over the app's own data).
  // An internal project is a folder directly in <workspace>/projects. Throws a 409 with the reason otherwise.
  function aiRoot(project) {
    const refuse = (why) => httpErr(409, `The folder of the project “${project.name}” cannot be given to the AI: ${why}.`, { aiRoot: false });
    let real;
    try { real = realpath(project.path); if (!fs.statSync(real).isDirectory()) throw new Error('not a folder'); }
    catch { throw refuse('it is not a folder'); }
    let projReal = PROJECTS; try { projReal = realpath(PROJECTS); } catch { /* keep */ }
    if (!project.external) {
      if (path.dirname(real) !== projReal || path.basename(real) !== project.id) throw refuse('it is not in the projects folder of the workspace');
      return real;
    }
    let home = os.homedir(); try { home = realpath(home); } catch { /* keep */ }
    let wsReal = ws; try { wsReal = realpath(ws); } catch { /* keep */ }
    if (real === path.parse(real).root || plat.samePath(real, home) || plat.insideAnyCase(real, home)) throw refuse('it is the home folder, a folder that holds it, or a whole disk');
    if (plat.insideAnyCase(real, wsReal) || plat.insideAnyCase(wsReal, real)) throw refuse('it is the workspace, a folder inside it or a folder that holds it');
    const id = 'ext-' + crypto.createHash('sha1').update(real).digest('hex').slice(0, 10);
    if (project.id !== id) throw refuse('its entry in settings.json no longer matches the folder that was opened. Open the folder again (Write › Open folder on disk…)');
    return real;
  }

  function move(src, dest) { // rename, or copy + remove across volumes
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(src, dest); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  }
  // never hard-delete: <workspace>/trash/<projectId>/<timestamp>/<path>
  function trashFile(project, r) {
    const dest = path.join(TRASH, project.id, stamp(), r.rel);
    move(r.lpath, dest);
    return dest;
  }

  // external: forget only. internal: move the folder to <workspace>/trash/.
  // A folder that is only forgotten gets the same id when it is opened again, so its papers are kept for that.
  function remove(project) {
    const cfg = loadCfg();
    if (project.external) cfg.external = cfg.external.filter((e) => e.id !== project.id);
    else if (!project.missing) move(project.path, path.join(TRASH, `${project.id}.project-${stamp()}`));
    const kept = project.external && cfg.per[project.id] && Array.isArray(cfg.per[project.id].papers) ? cfg.per[project.id].papers : null;
    delete cfg.per[project.id];
    if (kept && kept.length) cfg.per[project.id] = { papers: kept, folder: project.path }; // folder: see openFolder
    const links = cfg.all.overleafLinks; // a later project of the same name must not inherit the Overleaf link
    if (links && typeof links === 'object' && links[project.id]) { const next = { ...links }; delete next[project.id]; cfg.all = { ...cfg.all, overleafLinks: next }; }
    saveCfg(cfg);
  }

  function setSettings(project, patch) {
    const cfg = loadCfg();
    const st = { ...(cfg.per[project.id] || {}) };
    if ('compiler' in patch) {
      if (!COMPILERS.includes(patch.compiler)) throw bad('compiler must be one of ' + COMPILERS.join(', '));
      st.compiler = patch.compiler;
    }
    if ('mainFile' in patch) {
      if (patch.mainFile == null || patch.mainFile === '') delete st.mainFile; // back to auto-detection
      else {
        const r = resolveIn(project, patch.mainFile);
        if (!r.exists || !fs.statSync(r.abs).isFile()) throw bad('mainFile does not exist: ' + r.rel);
        st.mainFile = r.rel;
      }
    }
    if ('budget' in patch) { // page / word limit of the document; {} or null clears it
      const bud = cleanBudget(patch.budget, true);
      if (bud.pages || bud.words) st.budget = bud; else delete st.budget;
    }
    if ('checksOff' in patch) { // writing checks of the editor that are switched off for this project
      if (!Array.isArray(patch.checksOff) || patch.checksOff.some((c) => !CHECKS.includes(c))) throw bad('checksOff must be a list of: ' + CHECKS.join(', '));
      const off = CHECKS.filter((c) => patch.checksOff.includes(c));
      if (off.length) st.checksOff = off; else delete st.checksOff;
    }
    if ('bibScope' in patch) {
      if (!BIB_SCOPES.includes(patch.bibScope)) throw bad('bibScope must be one of ' + BIB_SCOPES.join(', '));
      if (patch.bibScope === 'cited') delete st.bibScope; else st.bibScope = patch.bibScope;
    }
    cfg.per[project.id] = st;
    saveCfg(cfg);
    return get(project.id);
  }
  // the project dictionary: words the spelling check accepts in this project (kept with the project settings)
  function words(project) {
    const w = (loadCfg().per[project.id] || {}).words;
    return Array.isArray(w) ? w.filter((x) => typeof x === 'string') : [];
  }
  function editWords(project, { add = [], remove = [] } = {}) {
    const cfg = loadCfg();
    const st = { ...(cfg.per[project.id] || {}) };
    const drop = new Set(remove.map((w) => String(w).toLowerCase()));
    const list = (Array.isArray(st.words) ? st.words.filter((x) => typeof x === 'string') : []).filter((w) => !drop.has(w.toLowerCase()));
    const have = new Set(list.map((w) => w.toLowerCase()));
    for (const w of add) { if (!have.has(w.toLowerCase())) { have.add(w.toLowerCase()); list.push(w); } }
    if (list.length > MAX_WORDS) throw bad(`A project dictionary holds at most ${MAX_WORDS} words`);
    list.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    if (list.length) st.words = list; else delete st.words;
    cfg.per[project.id] = st;
    saveCfg(cfg);
    return list;
  }
  // The papers of a project: library items the user added to it ([{id, added}], in the order they were added).
  // Ids of papers that went to the trash stay here (putting the paper back reconnects it); callers show only the
  // ids that are in the library (live()).
  const cleanPapers = (v) => (Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && p.id) : []);
  function papers(project) { return cleanPapers((loadCfg().per[project.id] || {}).papers); }
  function editPapers(project, { add = [], remove = [] } = {}) {
    if (!Array.isArray(add) || !Array.isArray(remove)) throw bad('add and remove must be lists of paper ids');
    const known = new Set(loadLib().items.map((i) => i.id));
    const cfg = loadCfg();
    const st = { ...(cfg.per[project.id] || {}) };
    const drop = new Set(remove.map(String));
    const list = cleanPapers(st.papers).filter((p) => !drop.has(p.id));
    const have = new Set(list.map((p) => p.id)), ignored = [], now = new Date().toISOString();
    for (const raw of add) {
      const id = String(raw);
      if (!known.has(id)) { if (!ignored.includes(id)) ignored.push(id); continue; }
      if (!have.has(id)) { have.add(id); list.push({ id, added: now }); }
    }
    if (list.length > MAX_PAPERS) throw bad(`A project holds at most ${MAX_PAPERS} papers`);
    if (list.length) st.papers = list; else delete st.papers;
    cfg.per[project.id] = st;
    saveCfg(cfg);
    return { papers: list, ignored };
  }
  // the stored papers that are in the library now
  function live(list, items = loadLib().items) {
    const known = new Set(items.map((i) => i.id));
    return list.filter((p) => known.has(p.id));
  }
  // The projects without the walk through their folders that list() does: [{id, name, path, external, overleaf, papers}]
  // (papers = how many of its papers are in the library).
  function listLite() {
    const cfg = loadCfg(), links = cfg.all.overleafLinks && typeof cfg.all.overleafLinks === 'object' ? cfg.all.overleafLinks : {};
    const known = new Set(loadLib().items.map((i) => i.id));
    return rawList(cfg).map((r) => ({ id: r.id, name: r.name, path: r.path, external: r.external, overleaf: !!(links[r.id] && typeof links[r.id] === 'object'),
      papers: cleanPapers((cfg.per[r.id] || {}).papers).filter((p) => known.has(p.id)).length }));
  }
  // keep the stored mainFile pointing at the file after a rename
  function renamed(project, from, to) {
    const cfg = loadCfg();
    const st = cfg.per[project.id];
    if (!st || !st.mainFile) return;
    if (st.mainFile === from) st.mainFile = to;
    else if (st.mainFile.startsWith(from + '/')) st.mainFile = to + st.mainFile.slice(from.length);
    else return;
    saveCfg(cfg);
  }

  return { list, listLite, get, aiRoot, create, freeName, renameProject, openFolder, remove, setSettings, words, editWords, papers, editPapers, live, renamed, resolveIn, listFiles, trashFile, move, safeName, stamp, PROJECTS, TRASH };
};

Object.assign(module.exports, { httpErr, normRel, kindOf, mimeOf, expandHome, inside, realpath, isArtefact, isGitDir, MAX_TEXT, COMPILERS, BIB_SCOPES, MAX_PAPERS });
