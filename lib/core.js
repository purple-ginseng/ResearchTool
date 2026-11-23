// Shared backend helpers: workspace paths, JSON storage, child processes, HTTP helpers and the
// project / history instances every route module uses. See ARCHITECTURE.md.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const plat = require('./platform');
const bib = require('./bibtex');
const createHistory = require('./history');
const createProjects = require('./projects');
const { httpErr, normRel, kindOf, mimeOf, expandHome, inside, MAX_TEXT } = createProjects;

const PORT = Number(process.env.PORT || 4790);
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
// all user data lives here (override with RT_WORKSPACE)
const WS = process.env.RT_WORKSPACE ? path.resolve(expandHome(process.env.RT_WORKSPACE)) : path.join(ROOT, 'workspace');
const DIRS = {
  pdfs: path.join(WS, 'pdfs'),
  sentences: path.join(WS, 'sentences'),
  projects: path.join(WS, 'projects'),
  export: path.join(WS, 'export'),
  history: path.join(WS, 'history'), // version history of project files
  cache: path.join(WS, 'cache'),     // preview PDFs, temporary zips
  trash: path.join(WS, 'trash'),     // deleted project files and projects
};
const LIB_FILE = path.join(WS, 'library.json');
const SETTINGS_FILE = path.join(WS, 'settings.json');

// GUI-launched processes often miss these on macOS; ~/.local/bin (the claude installer) everywhere; on Windows the
// TeX Live / MiKTeX / npm folders that exist (lib/platform.js)
// (RT_NO_EXTRA_PATH=1: the test suites, whose PATH holds only the fake AI CLIs and node - never a real CLI)
if (process.env.RT_NO_EXTRA_PATH !== '1') process.env.PATH = plat.buildPath(process.env.PATH, { home: os.homedir() });

// ---------- storage ----------
for (const d of [WS, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
// written to a private temporary file, flushed to disk, then moved into place: a crash never leaves half a file
let tmpSeq = 0;
const writeJSON = (f, data) => {
  const tmp = `${f}.${process.pid}.${++tmpSeq}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  plat.renameSync(tmp, f); // on Windows: waits out a moment's lock by antivirus / indexer / OneDrive
};

// ---------- the library file is never trusted blindly ----------
// library.json is re-read on every request so edits made by Claude Code in the terminal show up. A file that is
// missing means a new, empty library. A file that EXISTS but cannot be read as a library (a broken hand edit, a
// half-written file) is "damaged": nothing is loaded and nothing may be saved over it - before this check it was
// taken for an empty library and the next save wiped every reference. Copies are kept in <workspace>/backups/.
const BACKUP_DIR = path.join(WS, 'backups');
const bstamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
const damaged = (what) => { const e = new Error(`${what} is damaged and was not loaded. Restore a backup copy in the Library tab (nothing has been overwritten).`); e.status = 503; e.extra = { damaged: true }; return e; };
function readLibFile() {
  let text;
  try { text = fs.readFileSync(LIB_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let j; try { j = JSON.parse(text); } catch { throw damaged('library.json'); }
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) throw damaged('library.json');
  return j;
}
const loadLib = () => readLibFile() || { items: [] };
// A copy of the file as it is now, before it is overwritten: at most one every 10 minutes, the newest 30 kept plus
// one per day for 60 days.
let lastCopy = 0;
function keepCopy(force = false) {
  try {
    if (!fs.existsSync(LIB_FILE)) return null;
    if (!force && Date.now() - lastCopy < 10 * 60 * 1000) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `library-${bstamp()}.json`;
    fs.copyFileSync(LIB_FILE, path.join(BACKUP_DIR, name));
    lastCopy = Date.now();
    const all = fs.readdirSync(BACKUP_DIR).filter((n) => /^library-\d.*\.json$/.test(n)).sort().reverse();
    const days = new Set();
    all.forEach((n, k) => {
      const day = n.slice(8, 16), firstOfDay = !days.has(day); days.add(day);
      if (k >= 30 && !(firstOfDay && days.size <= 60)) { try { fs.unlinkSync(path.join(BACKUP_DIR, n)); } catch { /* keep it */ } }
    });
    return name;
  } catch (e) { console.error('library backup:', e.message); return null; }
}
// A copy before an AI run that has a shell and may write in the workspace (Codex with "Let Codex edit files"): always
// one, whatever the 10-minute rule says, unless the newest copy already holds exactly this file - so that a library
// the run damaged can be restored as it was right before it (Library tab, lib/core.js restoreLibBackup).
function keepCopyBeforeAi() {
  try {
    if (!fs.existsSync(LIB_FILE)) return null;
    const newest = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((n) => /^library-\d.*\.json$/.test(n)).sort().pop() : null;
    if (newest && fs.readFileSync(path.join(BACKUP_DIR, newest)).equals(fs.readFileSync(LIB_FILE))) return newest;
    return keepCopy(true);
  } catch (e) { console.error('library backup:', e.message); return null; }
}
function saveLib(lib) {
  if (!lib || !Array.isArray(lib.items)) throw new Error('Refusing to save: not a library');
  const cur = readLibFile(); // throws when the file on disk is damaged: it must be restored first, never overwritten
  // an empty library over a full one is almost always a mistake of the code, never of the user
  if (cur && cur.items.length >= 5 && lib.items.length === 0) throw Object.assign(new Error('Refusing to replace the whole library with an empty one.'), { status: 409 });
  keepCopy();
  writeJSON(LIB_FILE, lib);
}
const stampOf = (name) => { const m = /^library-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name; };
function listLibBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => /^library-\d.*\.json$/.test(n)).sort().reverse(); } catch { return []; }
  return names.slice(0, 40).map((name) => {
    let items = null;
    try { const j = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8')); if (Array.isArray(j.items)) items = j.items.length; } catch { /* a broken copy is listed as such */ }
    return { name, when: stampOf(name), items };
  });
}
// Put a backup copy back. The file it replaces is kept beside the copies (library-replaced-<time>.json).
function restoreLibBackup(name) {
  if (!/^library-[\w.-]+\.json$/.test(String(name))) throw httpErr(400, 'Bad backup name');
  const src = path.join(BACKUP_DIR, name);
  let j; try { j = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { throw httpErr(400, 'That copy cannot be read'); }
  if (!j || !Array.isArray(j.items)) throw httpErr(400, 'That copy is not a library');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(LIB_FILE)) fs.copyFileSync(LIB_FILE, path.join(BACKUP_DIR, `library-replaced-${bstamp()}.json`));
  writeJSON(LIB_FILE, j);
  return { items: j.items.length };
}
const libState = () => { try { readLibFile(); return { damaged: false }; } catch (e) { if (e.status === 503) return { damaged: true }; throw e; } };
// settings.json holds app settings plus keys owned by other modules (externalProjects, projectSettings, ...).
// loadSettings() returns the whole object (with exportDir defaulted); saveSettings() writes a whole object back.
const loadSettings = () => ({ exportDir: DIRS.export, ...readJSON(SETTINGS_FILE, {}) });
const saveSettings = (s) => writeJSON(SETTINGS_FILE, s);

const newId = () => crypto.randomBytes(5).toString('hex');
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const BIB_MARKER = '% Generated by ResearchTool - do not edit, changes are overwritten';

const allBibtex = (lib) => lib.items.map((i) => bib.serialize({ type: i.type, key: i.citekey, fields: i.fields })).join('\n\n') + '\n';

// Move a file or folder into <workspace>/trash/<...parts> (never hard-delete user files). Returns the new path.
function moveToTrash(src, ...parts) {
  const dest = path.join(DIRS.trash, ...parts);
  P.move(src, dest);
  return dest;
}

const GUIDE_HEAD = '# ResearchTool - workspace guide (v3)';
// heads of the guides written by earlier versions of the app: those files are replaced (the old one goes to the trash)
const OLD_GUIDE_HEADS = ['# ResearchTool workspace', '# ResearchTool - workspace guide (v2)'];
function writeWorkspaceGuide() {
  const f = path.join(WS, 'CLAUDE.md');
  // write it if missing, or replace the guide generated by a previous version of the app
  try {
    const cur = fs.readFileSync(f, 'utf8');
    if (!OLD_GUIDE_HEADS.some((h) => cur.startsWith(h + '\n') || cur.startsWith(h + '\r'))) return;
    try { moveToTrash(f, 'CLAUDE-' + stamp() + '.md'); } catch (e) { console.error('workspace guide:', e.message); return; }
  } catch { /* missing */ }
  fs.writeFileSync(f, `${GUIDE_HEAD}

This folder is the data directory of a local research web app (http://localhost:${PORT}).
You are helping a researcher read papers, keep notes and write LaTeX.

## Reference library
- \`library.json\` - all references. Each item: \`id\`, \`citekey\`, \`type\`, \`fields\` (BibTeX fields),
  \`keypoints\` (\`{id, text, page, category, note}\`), \`category\` (the group the paper is listed under, default
  "Uncategorized"), \`tags\` (list of strings), \`pdf\` (bool).
  You may edit keypoints, category and tags here; keep it valid JSON and keep existing ids. When you set a
  category yourself also set \`"categoryStatus": "manual"\`, so the app's automatic grouping leaves it alone.
- \`notes/<id>.md\` - the reading note of a reference, in Markdown (one file per item id). Conventions: \`#\`/\`##\`
  headings, LaTeX formulas (\`$...$\` inline, \`$$\` on its own lines for display), GFM tables, callouts written as
  blockquotes that start with \`> [!abstract]\`, \`> [!key]\`, \`> [!concept]\` or \`> [!background]\`,
  \`==yellow highlight==\`. Write every paragraph on one line. Edit these files in place; the app reloads them and
  keeps the earlier versions in its history.
- \`notes/assets/<id>/\` - images pasted into a note (referenced from the note as \`/api/items/<id>/note/assets/<file>\`).
- \`note-template.md\` - the team's note format guide that first drafts follow. Read it before you write a note.
- \`sentences/<id>.json\` - every sentence extracted from the paper's PDF, with page numbers.
- \`pdfs/<id>.pdf\` - the original PDFs.
- \`highlights/<id>.json\` - the passages the user highlighted in the PDF (\`text\`, \`page\`, \`color\`, \`comment\`). Read only.
- \`export/\` - exported \`references.bib\`, \`notes.md\`, \`library.csv\` and \`notes/<citekey>.md\`.

## LaTeX projects
A project is a folder with any number of files and sub-folders (.tex, .bib, .sty, figures ...).
- Internal projects live in \`projects/<name>/\`.
- External projects are existing folders elsewhere on disk that the user opened in the app. When one is open
  you are told its absolute path and may edit files there.
- Each project has a main file (the .tex with \\documentclass, usually \`main.tex\`) and a compiler
  (pdflatex, xelatex or lualatex). The app compiles with latexmk in the folder of the main file.
- \`references.bib\` next to the main file: if its first line is
  \`${BIB_MARKER}\`
  it is regenerated from library.json before every compile - never edit that one by hand. By default it holds
  only the entries the project cites: cite any citekey of the library and its entry is there at the next compile.
  A references.bib without that marker line was written by the user and is left alone. Cite with \`\\cite{citekey}\`.
- Edit files in place. The app reloads them after you finish and records your changes in the project's
  version history (shown to the user as "Claude" versions), where they can be compared and restored.
- Do not create or edit LaTeX build artefacts (.aux, .log, .bbl, .fls, .fdb_latexmk, .synctex.gz ...).

## App-managed folders (do not edit)
- \`history/\` - version history of project files. \`cache/\` - preview PDFs, the text read from each PDF, the log of AI calls (rebuilt when missing). \`trash/\` - deleted files.
- \`settings.json\` - app settings, including the list of opened external folders and the Overleaf links.
- A project imported from Overleaf is a Git clone: never touch its \`.git\` folder and never run git in it; the
  user syncs with the Pull / Push buttons of the app.

Only cite keys that exist in library.json (or in the project's own .bib files). Never invent references.
`);
}

// ---------- child processes ----------
// Always spawn(cmd, [args]) - never a shell. Every tool is started through spawnTool() (lib/platform.js): on
// macOS / Linux that is plain spawn(); on Windows it finds the .exe on PATH, runs an npm .cmd shim's script with node
// and refuses any other .cmd / .bat (only cmd.exe could run them). A tool that is not there fails with ENOENT as before.
const spawnTool = (cmd, args, opts) => plat.spawnTool(cmd, args, opts);
const resolveCmd = (cmd, env) => plat.resolveCmd(cmd, { env: env || process.env });
const killTree = (child, opts) => plat.killTree(child, opts); // Windows: taskkill /T /F; elsewhere SIGKILL as before
function run(cmd, args, { cwd, input, timeout = 60000, env, signal } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawnTool(cmd, args, { cwd, env: env || process.env }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    const timer = setTimeout(() => { if (!done) { killTree(child); err += '\n[timed out]'; } }, timeout);
    if (signal) { // the caller gave up (the client went away): stop the process
      const kill = () => { if (!done) killTree(child); };
      if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); // whole characters, also when a chunk ends inside one
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ code, out, err }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

// Why a helper program failed, for an error message. On Windows an exit code of 0xC0000000 or above is an NTSTATUS:
// the program crashed or could not start (a broken or mismatched install), which its stderr - usually empty - does
// not say. Otherwise the end of its stderr, or the exit code.
const NTSTATUS = { 0xC0000005: 'access violation', 0xC000007B: 'a DLL or the program is built for another system',
  0xC0000135: 'a DLL it needs was not found', 0xC0000139: 'a DLL entry point was not found',
  0xC0000142: 'a DLL failed to start', 0xC0000374: 'heap corruption', 0xC0000409: 'stack buffer overrun' };
function crashText(code) {
  if (typeof code !== 'number' || code < 0xC0000000 || code > 0xFFFFFFFF) return null;
  const why = NTSTATUS[code];
  return 'it crashed (Windows status 0x' + code.toString(16).toUpperCase() + (why ? ', ' + why : '') + ')';
}
function toolFailure(name, r, { max = 300, tail = false, hint = '' } = {}) {
  const crash = crashText(r && r.code);
  if (crash) return name + ' failed: ' + crash + '.' + (hint ? ' ' + hint : '');
  const s = String((r && (r.err || r.code)) ?? '');
  return name + ' failed: ' + (tail ? s.slice(-max) : s.slice(0, max));
}

// Environment for a child `claude` process: drop the variables a parent Claude session sets.
function claudeEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW)/.test(k)) delete env[k];
  return env;
}

// ---------- the AI features: how `claude -p` is called ----------
// Every feature call (grouping, key points, diagrams, quizzes, explanations, drafts) carries its whole task in the
// prompt, so it runs with a one-line system prompt and without the user's / project's settings and CLAUDE.md files.
// That alone removes about 4,500 input tokens per call (measured: 4,850 -> 440 for a one-line question).
// The Claude panel (routes/claude.js) is a real Claude Code session and keeps the defaults.
const AI_SYSTEM = 'You are a precise research assistant inside a reference manager. Follow the instructions in the user message exactly and output only what it asks for.';
// The teaching style: a standing instruction that goes with EVERY explanation Claude gives in this app (the Claude
// panel, "Ask Claude" in a note, examples in a diagram, the explanations of a quiz). The user edits it once in
// Settings instead of typing it with every question.
const TEACH_DEFAULT = `Explain like a deeply knowledgeable, patient teacher who can reach any kind of student (启发、解惑):
1. Say in one plain sentence what the point really is.
2. ALWAYS give the authors' own example (作者的例子): the concrete case, experiment, figure, number or wording the paper itself uses, with its page as (p. N). Stay faithful to it; if the paper gives none, say so.
3. ALWAYS give an everyday-life example (生活例子): an analogy from daily life that someone outside the field recognises at once, and say in a few words where the analogy stops fitting.
4. 启发: lead to the insight step by step - why it has to be this way - instead of only stating the result.
5. 解惑: name the misunderstanding a student most often has here and why it is tempting, then clear it up.
Use plain words, define each term the first time it appears, and keep formulas to what is needed.`;
const teachStyle = () => { const t = loadSettings().teachStyle; return typeof t === 'string' && t.trim() ? t.trim().slice(0, 3000) : TEACH_DEFAULT; };
// Page citations: a fixed rule that goes with every explanation about a paper, next to the (editable) teaching style,
// so the reader can tell what comes from the paper. The app turns "(p. N)" into a button that shows that page.
const citeRule = (language) => `PAGE CITATIONS (always, whatever the instruction above says): the paper text carries [p. N] markers. Right after each claim, number or example that you take from the paper, give its page in exactly this form: (p. N) - for example (p. 4), or (p. 4, 7) for two pages. After a claim that comes from general knowledge and not from this paper, write ${language === 'zh' ? '（通用知识）' : '(general knowledge)'}. Never guess a page: where the text you were given shows no marker, give no page.`;
const AI_MODES = ['economy', 'balanced', 'quality'];
const aiMode = () => { const m = loadSettings().aiMode; return AI_MODES.includes(m) ? m : 'balanced'; };
// kind: 'light' = short answers (grouping, key points, explanations, questions about a note)
//       'heavy' = whole-paper work (diagram, quiz, draft)
// economy:  low effort everywhere, the Sonnet model for light work, drafts from the extracted text only
// balanced: low effort for light work, medium for heavy work (the default)
// quality:  Claude Code's own effort
// --setting-sources '' also hides the model and effort the user chose in Claude Code's own settings: read them here
// and pass them on, so "Best quality" really is the user's configuration.
const userClaude = () => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'), 'utf8'));
    return { model: typeof j.model === 'string' && /^[\w.\-\[\]:]+$/.test(j.model) ? j.model : '', effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(j.effortLevel) ? j.effortLevel : '' };
  } catch { return { model: '', effort: '' }; }
};
function claudeArgs(kind, { tools = '', allowed = null, stream = false, partial = false } = {}) {
  const mode = aiMode();
  const a = ['-p', '--output-format', stream ? 'stream-json' : 'json', ...(stream ? ['--verbose'] : []), ...(partial ? ['--include-partial-messages'] : []),
    '--tools', tools, ...(allowed ? ['--allowedTools', allowed] : []),
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', AI_SYSTEM, '--setting-sources', ''];
  const u = userClaude();
  const effort = mode === 'quality' ? u.effort : kind === 'light' || mode === 'economy' ? 'low' : 'medium';
  if (effort) a.push('--effort', effort);
  if (mode === 'economy' && kind === 'light') a.push('--model', 'sonnet');
  else if (u.model) a.push('--model', u.model);
  return a;
}
// One line per finished AI call in <workspace>/cache/ai-usage.jsonl: tokens, cost and the seconds it took
// (the Settings window sums them up per feature).
// `j` is the CLI's result object (the JSON of --output-format json, or the "result" event of stream-json).
const USAGE_FILE = path.join(WS, 'cache', 'ai-usage.jsonl');
function recordUsage(feature, j) {
  try {
    const u = (j && j.usage) || {};
    const line = { t: Date.now(), f: feature, in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, usd: Number(j && j.total_cost_usd) || 0 };
    // another AI provider (lib/ai): its id, and a cost only when its CLI reported one (Codex and Antigravity do not)
    if (j && typeof j._provider === 'string' && j._provider !== 'claude') { line.p = j._provider; if (j.total_cost_usd == null) delete line.usd; }
    // (a call of another provider counts even without token numbers: Grok and Antigravity do not always report them)
    if (!line.in && !line.out && !line.cached && !line.p) return;
    const ms = Number(j && j.duration_ms); // how long the call took, as the CLI reports it
    if (ms > 0) line.ms = Math.round(ms);
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.appendFileSync(USAGE_FILE, JSON.stringify(line) + '\n');
  } catch { /* the log is a convenience */ }
}
function usageSummary() {
  const day = 86400000, now = Date.now(), start = new Date(); start.setHours(0, 0, 0, 0);
  const sum = () => ({ calls: 0, tokens: 0, usd: 0, ms: 0, timed: 0 }); // ms = total time of the `timed` calls (older lines have no time)
  const out = { today: sum(), week: sum(), byFeature: {}, byProvider: {} }; // byProvider: 'claude' for lines without p
  let lines = [];
  try { lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').slice(-5000); } catch { return out; }
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || now - r.t > 7 * day) continue;
    const tok = (r.in || 0) + (r.out || 0) + (r.cached || 0);
    const f = out.byFeature[r.f] || (out.byFeature[r.f] = sum());
    const pv = typeof r.p === 'string' ? r.p : 'claude', pr = out.byProvider[pv] || (out.byProvider[pv] = sum());
    for (const s of [out.week, f, pr, ...(r.t >= start.getTime() ? [out.today] : [])]) { s.calls++; s.tokens += tok; s.usd += r.usd || 0; if (r.ms > 0) { s.ms += r.ms; s.timed++; } }
  }
  return out;
}

// ---------- HTTP ----------
function readBody(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    if (Number(req.headers['content-length']) > limit) return reject(httpErr(413, 'Too large'));
    req.on('data', (c) => { size += c.length; if (size > limit) { chunks.length = 0; reject(httpErr(413, 'Too large')); } else if (size <= limit) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Parse a JSON object body ({} when empty); 415 unless Content-Type is application/json; 413 over `limit` bytes.
async function readJsonBody(req, limit) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw httpErr(415, 'Content-Type must be application/json');
  let j; try { j = JSON.parse(b.toString('utf8')); } catch { throw httpErr(400, 'Invalid JSON body'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw httpErr(400, 'Invalid JSON body');
  return j;
}
const send = (res, code, data, type = 'application/json') => {
  const body = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf',
};
// after: runs once the response is over - also when the client left before it began (a zip that took a minute to
// build for a tab that was closed meanwhile: its 'close' event is long past) or the file is not there
function sendFile(res, file, type, headers = {}, after) {
  if (res.destroyed) { if (after) after(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { if (after) after(); return send(res, 404, { error: 'Not found' }); }
    res.writeHead(200, { 'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', ...headers });
    const rs = fs.createReadStream(file);
    rs.on('error', () => res.destroy());
    if (after) res.on('close', after);
    rs.pipe(res);
  });
}
const attachment = (name) => ({ 'Content-Disposition':
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });

// ---------- LaTeX projects + their version history (shared by the projects and Claude routes) ----------
const TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,graphicx}
\usepackage[numbers]{natbib}
\usepackage{hyperref}

\title{Untitled Draft}
\author{}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Write your abstract here.
\end{abstract}

\section{Introduction}
Start writing. Use the Cite button to insert a reference from your library,
for example \verb|\cite{citekey}|.

% \nocite{*}  % uncomment to list every reference in the library

\bibliographystyle{plainnat}
\bibliography{references}
\end{document}
`;

const P = createProjects({ ws: WS, readJSON, writeJSON, template: TEMPLATE, loadLib });
const H = createHistory(DIRS.history, { burstMs: Number(process.env.RT_BURST_MS) || 5 * 60 * 1000 });
const sha1 = H.sha1;
const claudeActive = new Map(); // projectId -> number of running AI panel runs that may edit files (Claude, Codex opted in)
const aiActiveBy = new Map();   // projectId -> the providers of those runs, one entry per run, in the order they started
// a panel run that may edit files starts / ends (lib/routes/claude.js): both maps follow it. Each run removes its OWN
// entry when it ends, so two overlapping runs of different providers (a Claude run in one tab, a Codex run in another)
// never leave the one that ended named for the changes of the one still going.
function aiRunStart(projectId, by) {
  claudeActive.set(projectId, (claudeActive.get(projectId) || 0) + 1);
  aiActiveBy.set(projectId, [...(aiActiveBy.get(projectId) || []), by]);
}
function aiRunEnd(projectId, by) {
  const n = (claudeActive.get(projectId) || 1) - 1;
  if (n > 0) claudeActive.set(projectId, n); else claudeActive.delete(projectId);
  const list = [...(aiActiveBy.get(projectId) || [])], i = list.lastIndexOf(by);
  if (i >= 0) list.splice(i, 1);
  if (n > 0 && list.length) aiActiveBy.set(projectId, list); else aiActiveBy.delete(projectId);
}
const diskSource = (project) => (claudeActive.get(project.id) ? 'claude' : 'external');
// the record() options of a change found on disk: while an AI panel run is going, it names that run's provider (with
// runs of several providers going at once: the one that started last and is still going)
const diskOpts = (project) => {
  if (!claudeActive.get(project.id)) return {};
  const list = aiActiveBy.get(project.id), by = Array.isArray(list) && list.length ? list[list.length - 1] : 'claude';
  return { by };
};

// One-time upgrade of projects made by the single-file version of the app: mark their generated
// references.bib (so it keeps being regenerated) and move preview.pdf out of the project folder.
function migrate() {
  const s = readJSON(SETTINGS_FILE, {});
  if (s.projectsV2) return;
  for (const d of fs.readdirSync(DIRS.projects, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(DIRS.projects, d.name);
    try {
      const b = path.join(dir, 'references.bib');
      if (fs.existsSync(path.join(dir, 'main.tex')) && fs.existsSync(b)) {
        const t = fs.readFileSync(b, 'utf8');
        if (!t.startsWith(BIB_MARKER)) fs.writeFileSync(b, BIB_MARKER + '\n' + t);
      }
      const pv = path.join(dir, 'preview.pdf'), dest = path.join(DIRS.cache, d.name, 'preview.pdf');
      if (fs.existsSync(pv) && !fs.existsSync(dest)) P.move(pv, dest);
    } catch (e) { console.error('migrate', d.name, e.message); }
  }
  writeJSON(SETTINGS_FILE, { ...readJSON(SETTINGS_FILE, {}), projectsV2: true });
}

// AI panel edits -> history: snapshot before a run, record what changed after it. `by`: the provider that ran
// ('claude', or 'codex' with "Let Codex edit files"); the versions keep source 'claude' (= an AI made it).
const projectTextFiles = (project) => P.listFiles(project).filter((f) => f.type === 'file' && f.kind === 'text' && f.size <= MAX_TEXT);
function snapshotProject(project) { // path -> {hash, buf}; contents are kept (up to 64 MB) so a baseline can be recorded
  const snap = new Map(); let total = 0;
  for (const f of projectTextFiles(project)) {
    try {
      const buf = fs.readFileSync(path.join(project.path, f.path));
      total += buf.length;
      snap.set(f.path, { hash: sha1(buf), buf: total <= 64 * 1024 * 1024 ? buf : null });
    } catch { /* skip */ }
  }
  return snap;
}
function recordClaudeChanges(project, snap, by = 'claude') {
  const h = H.open(project.id);
  for (const f of projectTextFiles(project)) {
    try {
      const buf = fs.readFileSync(path.join(project.path, f.path)), hash = sha1(buf), last = h.newest(f.path);
      if (last) { if (last.hash !== hash) h.record(f.path, buf, 'claude', { by }); continue; }
      const before = snap.get(f.path);
      if ((before && before.hash === hash) || buf.toString('utf8', 0, BIB_MARKER.length) === BIB_MARKER) continue;
      if (before && before.buf) h.record(f.path, before.buf, 'baseline');
      h.record(f.path, buf, 'claude', { by });
    } catch { /* skip */ }
  }
  // a file the run deleted: its content from before the run is kept in the history (a baseline when it had none yet),
  // so that it can be restored from the project's history
  for (const [rel, before] of snap) {
    try {
      if (!before || !before.buf || fs.existsSync(path.join(project.path, rel))) continue;
      const last = h.newest(rel);
      if (!last) h.record(rel, before.buf, 'baseline'); else if (last.hash !== before.hash) h.record(rel, before.buf, 'external');
    } catch { /* skip */ }
  }
  h.commit();
}

// The configuration files of AI agents inside the folders an AI run may write (Codex's write mode: the open project and
// the notes folder): a CLAUDE.md, AGENTS.md or .claude/settings.json planted there would be loaded by a later run of
// Claude Code or Codex - instructions that outlive the run, or a hook that runs outside every sandbox. They are noted
// before the run and put back as they were after it: a new one goes to the workspace trash, a changed or deleted one
// gets its old content back.
const AGENT_FILES = new Set(['agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', 'gemini.md', '.mcp.json']);
const AGENT_DIRS = new Set(['.claude', '.codex', '.agents', '.grok', '.gemini']);
const AGENT_MAX = 1024 * 1024; // a larger file is noted by its hash only: changed, it goes to the trash
function agentEntries(root) { // [{rel, abs, dir}]: agent files (walked into agent folders) and agent folders, bounded
  const out = []; let seen = 0;
  (function walk(dir, rel, depth, inAgent) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (++seen > 20000) return;
      const r = rel ? rel + '/' + d.name : d.name, abs = path.join(dir, d.name), low = d.name.toLowerCase();
      if (low === '.git' || low === 'node_modules') continue;
      const agentDir = d.isDirectory() && AGENT_DIRS.has(low);
      if (inAgent || agentDir || (!d.isDirectory() && AGENT_FILES.has(low))) out.push({ rel: r, abs, dir: d.isDirectory() && !d.isSymbolicLink(), top: agentDir && !inAgent });
      if (d.isDirectory() && !d.isSymbolicLink() && depth < 10) walk(abs, r, depth + 1, inAgent || agentDir);
    }
  })(root, '', 0, false);
  return out;
}
function readAgentEntry(e) {
  const st = fs.lstatSync(e.abs);
  if (st.isSymbolicLink()) return { link: fs.readlinkSync(e.abs) };
  if (e.dir) return { dir: true };
  const buf = st.size <= AGENT_MAX ? fs.readFileSync(e.abs) : null;
  return { hash: buf ? sha1(buf) : 'size:' + st.size + ':' + st.mtimeMs, buf };
}
const sameAgent = (a, b) => (a.link != null ? a.link === b.link : a.dir ? !!b.dir : !b.dir && b.link == null && a.hash === b.hash);
function snapshotAgentFiles(roots) {
  return roots.map((root) => {
    const m = new Map();
    for (const e of agentEntries(root)) { try { m.set(e.rel, { ...readAgentEntry(e), top: e.top }); } catch { /* skip */ } }
    return { root, m };
  });
}
// -> the paths (absolute) that were put back as they were
function restoreAgentFiles(snaps) {
  const undone = [], when = stamp();
  const there = (abs) => { try { fs.lstatSync(abs); return true; } catch { return false; } };
  for (const { root, m } of snaps || []) {
    const trash = (abs, rel) => { try { moveToTrash(abs, 'ai-agent-files', when, path.basename(root), ...rel.split('/')); } catch { try { fs.rmSync(abs, { recursive: true, force: true }); } catch { /* left */ } } };
    const put = (abs, before) => {
      try {
        if (before.dir) fs.mkdirSync(abs, { recursive: true });
        else if (before.link != null) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.symlinkSync(before.link, abs); }
        else if (before.buf) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, before.buf); }
        else return false;
        return true;
      } catch { return false; }
    };
    const gone = []; // folders moved away whole: nothing inside them is looked at again
    for (const e of agentEntries(root)) { // (a folder comes before what is in it)
      if (gone.some((g) => e.rel.startsWith(g + '/'))) continue;
      const before = m.get(e.rel);
      let cur; try { cur = readAgentEntry(e); } catch { continue; }
      if (before && sameAgent(before, cur)) continue;
      undone.push(e.abs);
      // changed file: its old content written back over it (the changed one is kept in the trash: nothing is lost)
      if (before && before.buf && !cur.dir && cur.link == null) {
        try {
          const dest = path.join(DIRS.trash, 'ai-agent-files', when, path.basename(root), ...e.rel.split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(e.abs, dest);
          fs.writeFileSync(e.abs, before.buf); continue;
        } catch { /* below */ }
      }
      trash(e.abs, e.rel); if (e.dir) gone.push(e.rel); // new (or changed into something else): to the trash
    }
    for (const [rel, before] of m) { // deleted, or moved to the trash above: put back as it was
      const abs = path.join(root, ...rel.split('/'));
      if (there(abs)) continue;
      if (put(abs, before) && !undone.includes(abs)) undone.push(abs);
    }
  }
  return undone;
}

module.exports = {
  PORT, ROOT, PUBLIC, WS, DIRS, LIB_FILE, SETTINGS_FILE, BIB_MARKER, TEMPLATE, MIME, MAX_TEXT,
  readJSON, writeJSON, loadLib, saveLib, loadSettings, saveSettings, keepCopy, keepCopyBeforeAi, listLibBackups, restoreLibBackup, libState,
  newId, safeName, stamp, allBibtex, moveToTrash,
  run, crashText, toolFailure, spawnTool, resolveCmd, killTree, plat, claudeEnv, claudeArgs, aiMode, AI_MODES, recordUsage, usageSummary, teachStyle, TEACH_DEFAULT, citeRule,
  readBody, readJsonBody, send, sendFile, attachment,
  httpErr, normRel, kindOf, mimeOf, expandHome, inside,
  P, H, sha1, claudeActive, aiActiveBy, aiRunStart, aiRunEnd, diskSource, diskOpts, snapshotProject, recordClaudeChanges, snapshotAgentFiles, restoreAgentFiles,
  writeWorkspaceGuide, migrate,
};
