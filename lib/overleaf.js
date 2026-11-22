// Overleaf sync through Overleaf's official Git integration.
// Authentication is left entirely to git's own credential helper (the macOS Keychain, the Windows Credential Manager,
// a Linux credential helper): this code never sees, stores or logs a password / Git token, never puts one in a URL,
// and never talks to overleaf.com itself.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core');
const plat = require('./platform');
const { DIRS, ROOT, MAX_TEXT, httpErr, P, H, sha1, loadSettings, saveSettings, kindOf } = core;

// e.g. RT_OVERLEAF_GIT_BASE=file:///tmp/x/remotes to test against local bare repositories
const BASE = String(process.env.RT_OVERLEAF_GIT_BASE || 'https://git.overleaf.com').replace(/\/+$/, '');
const BRANCH = 'master';
const LOGIN_SCRIPT = path.join(ROOT, 'scripts', 'overleaf-login.sh');
const MSG_PULL = 'Local changes before pull (ResearchTool)';
const MSG_PUSH = 'Update from ResearchTool';
const T_LOCAL = 30000;                                              // local git commands
const T_NET = Math.max(1000, Number(process.env.RT_OVERLEAF_NET_TIMEOUT_MS) || 45000); // fetch / push / ls-remote
const T_CLONE = Math.max(T_NET, Number(process.env.RT_OVERLEAF_CLONE_TIMEOUT_MS) || 180000);

// ---------- input validation ----------
// Accepts a project URL (https://www.overleaf.com/project/<id>), a git URL (https://git.overleaf.com/<id>) or a bare
// id. Anything else is a 400. Returns the 24-hex project id in lower case.
function parseRef(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s || s.length > 300) throw httpErr(400, 'Paste the link of an Overleaf project, e.g. https://www.overleaf.com/project/0123456789abcdef01234567');
  let m = /^([0-9a-f]{24})$/i.exec(s)
    || /^https:\/\/(?:www\.)?overleaf\.com\/project\/([0-9a-f]{24})(?:[/?#][^\s]*)?$/i.exec(s)
    || /^https:\/\/(?:git@)?git\.overleaf\.com\/([0-9a-f]{24})(?:\.git)?\/?$/i.exec(s);
  if (!m) {
    if (/^https:\/\/(?:www\.)?overleaf\.com\/read\//i.test(s)) throw httpErr(400, 'That is a read-only share link. Open the project on Overleaf and copy the address from the browser (https://www.overleaf.com/project/...).');
    throw httpErr(400, 'Not an Overleaf project link. Expected https://www.overleaf.com/project/<24 characters>, https://git.overleaf.com/<id> or the bare project id.');
  }
  return m[1].toLowerCase();
}
const remoteUrl = (olId) => `${BASE}/${olId}`;
const webUrl = (olId) => `https://www.overleaf.com/project/${olId}`;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// the exact one-line command the user runs once in a terminal to store the token with git's credential helper
// (Windows: in Git Bash, which comes with Git for Windows and reads C:/... paths)
const loginCommand = (olId, platform = process.platform) =>
  `bash ${shq(platform === 'win32' ? LOGIN_SCRIPT.replace(/\\/g, '/') : LOGIN_SCRIPT)} ${olId}`;

// ---------- git ----------
// Never prompt: a missing credential must fail at once instead of waiting for input nobody can give.
function gitEnv(ceiling) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never',
    LC_ALL: 'C', LANG: 'C', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS']) delete env[k];
  if (ceiling) env.GIT_CEILING_DIRECTORIES = ceiling; // never fall back to a repository above the project folder
  return env;
}
const baseCfg = (platform = process.platform, execPath = process.execPath) => ['-c', 'core.askPass=', '-c', 'core.quotePath=false', '-c', 'commit.gpgSign=false', '-c', 'advice.detachedHead=false',
  '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=30', '-c', 'core.fsmonitor=false',
  // the files on disk are byte for byte what Overleaf has: no CRLF conversion (Git for Windows sets autocrlf=true
  // system-wide); deep Overleaf folders inside a long project path must not fail with "Filename too long" there
  '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true',
  // files inside .git can be written by other tools (the Claude panel has file tools): never run hooks from there,
  // never use the command-running "ext::" transport. The repository's own config is checked by checkRepoConfig().
  // The hooks folder is a path below a file, which can hold nothing: /dev/null, and on Windows (where /dev/null would
  // be C:\dev\null, a folder anyone may create) node.exe itself.
  '-c', `core.hooksPath=${platform === 'win32' ? execPath : '/dev/null'}`, '-c', 'protocol.ext.allow=never'];
const BASE_CFG = baseCfg();
const scrub = (s) => String(s || '').replace(/(:\/\/)[^/@\s]+@/g, '$1'); // never echo credentials that a URL might carry

// spawn('git', [args]) - no shell (core.spawnTool). Resolves {code, out, err, timedOut}; never rejects. On timeout the
// whole process tree is killed (git and its remote helper): the process group, on Windows taskkill /T.
function git(args, { cwd, timeout = T_LOCAL, ceiling } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false, child;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err: scrub(err), timedOut }); };
    try { child = core.spawnTool('git', [...BASE_CFG, ...args], { cwd, env: gitEnv(ceiling), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e), timedOut: false }); }
    const timer = setTimeout(() => {
      timedOut = true;
      core.killTree(child, { group: true });
      setTimeout(() => finish(null), 1500); // in case 'close' never comes
    }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); // whole characters, also when a chunk ends inside one
    child.stdout.on('data', (d) => { if (out.length < 8e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    child.on('error', (e) => { err += String(e.message || e); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

const AUTH_RE = /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]|HTTP 40[13]|Permission denied|Unauthorized/i;
const MISSING_RE = /returned error: 404|repository '.*' not found|Repository not found|does not appear to be a git repository|Remote branch \S+ not found/i;
const NET_RE = /Could not resolve host|Failed to connect|Couldn't connect|Connection refused|Connection reset|Connection timed out|Operation timed out|Network is unreachable|unable to access|SSL|TLS|early EOF|hung up unexpectedly|RPC failed|returned error: 5\d\d|transfer closed/i;
const lastLines = (s, n = 4) => plat.lines(s || '').map((l) => l.trim()).filter(Boolean).slice(-n).join(' ').slice(0, 400);

// Turn a failed network git command into an HTTP error: 401 needsLogin, 404 unknown project, 502 offline.
function netError(r, olId, what) {
  const e = r.err || '';
  if (r.code === -1) return httpErr(500, /EUNSAFECMD|can only be run through a command shell/.test(e) ? e.slice(0, 400) : 'git is not installed (or could not be started). ' + plat.installGitHint());
  if (!r.timedOut && AUTH_RE.test(e)) {
    return httpErr(401, `Overleaf asked for a login. Store your Overleaf Git token in ${plat.credentialStore()} once (see the command${process.platform === 'win32' ? ', run it in Git Bash' : ''}), then try again.`,
      { needsLogin: true, command: loginCommand(olId) });
  }
  if (!r.timedOut && MISSING_RE.test(e)) return httpErr(404, 'Overleaf has no project with this id (or its Git access is not available to you).', { notFound: true });
  if (r.timedOut) return httpErr(502, `${what} timed out - Overleaf could not be reached. Check your internet connection and try again.`, { offline: true, timedOut: true });
  if (NET_RE.test(e)) return httpErr(502, `${what} failed - Overleaf could not be reached. ${lastLines(e, 2)}`, { offline: true });
  return httpErr(502, `${what} failed: ${lastLines(e) || 'git exited with code ' + r.code}`, { offline: true });
}

// ---------- link storage: settings.json key "overleafLinks", keyed by the local project id ----------
function links() {
  const l = loadSettings().overleafLinks;
  return l && typeof l === 'object' && !Array.isArray(l) ? l : {};
}
function getLink(pid) {
  const l = links()[pid];
  return l && typeof l.projectId === 'string' && /^[0-9a-f]{24}$/.test(l.projectId) ? l : null;
}
function setLink(pid, link) { // read-modify-write of the whole settings object
  const s = loadSettings();
  const all = s.overleafLinks && typeof s.overleafLinks === 'object' && !Array.isArray(s.overleafLinks) ? { ...s.overleafLinks } : {};
  if (link) all[pid] = link; else delete all[pid];
  saveSettings({ ...s, overleafLinks: all });
}
function touchSync(pid) {
  const l = getLink(pid);
  if (l) setLink(pid, { ...l, lastSync: new Date().toISOString() });
}

// ---------- one git operation per project at a time ----------
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

// ---------- repository helpers ----------
const EXCLUDE_BEGIN = '# >>> ResearchTool: LaTeX build artefacts (managed, do not edit between the markers)';
const EXCLUDE_END = '# <<< ResearchTool';
const EXCLUDES = ['*.aux', '*.log', '*.fls', '*.fdb_latexmk', '*.out', '*.toc', '*.bbl', '*.blg', '*.lof', '*.lot', '*.nav', '*.snm',
  '*.vrb', '*.bcf', '*.xdv', '*.run.xml', '*.synctex.gz', '*.synctex(busy)', '.DS_Store'];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Local-only ignore rules in .git/info/exclude (never a .gitignore in the user's project). Also hides the PDF that
// latexmk writes next to the main file (Overleaf builds its own).
function writeExclude(dir, mainFile) {
  const f = path.join(dir, '.git', 'info', 'exclude');
  let old = '';
  try { old = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
  const rest = old.replace(new RegExp(escRe(EXCLUDE_BEGIN) + '[\\s\\S]*?' + escRe(EXCLUDE_END) + '\\n?'), '').replace(/\s+$/, '');
  const lines = [...EXCLUDES];
  if (mainFile && !/[\n\r]/.test(mainFile)) lines.push('/' + mainFile.replace(/\.[^./]+$/, '').replace(/([*?[\]\\!# ])/g, '\\$1') + '.pdf');
  const text = (rest ? rest + '\n' : '') + [EXCLUDE_BEGIN, ...lines, EXCLUDE_END].join('\n') + '\n';
  if (text !== old) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
}

// git trusts everything in .git/config: filter / diff / merge drivers, credential.helper, core.sshCommand, aliases,
// includes ... all run commands. A clone made by this app only ever holds the few settings below, so before every
// git operation the file is checked line by line and anything else stops the sync (409) - nothing in it is executed.
const CFG_BOOL = /^(true|false)$/i;
const CFG_ALLOWED = {
  core: { repositoryformatversion: /^[01]$/, filemode: CFG_BOOL, bare: /^false$/i, logallrefupdates: CFG_BOOL, ignorecase: CFG_BOOL,
    precomposeunicode: CFG_BOOL, symlinks: CFG_BOOL, autocrlf: /^(true|false|input)$/i },
  user: { name: /^[^\\"]*$/, email: /^[^\\"]*$/ },
  'remote "origin"': { url: null /* compared with the link */, tagopt: /^--no-tags$/, fetch: /^\+?refs\/heads\/[A-Za-z0-9_*\/-]+:refs\/remotes\/origin\/[A-Za-z0-9_*\/-]+$/ },
  branch: { remote: /^origin$/, merge: /^refs\/heads\/[A-Za-z0-9_.\/-]+$/ },
};
function checkRepoConfig(dir, olId) {
  const refuse = (what) => httpErr(409, `Sync is switched off for this project: its .git/config holds a setting this app did not write (${what}). Remove it from the file, or unlink the project and import it from Overleaf again.`, { unsafeConfig: true });
  let text;
  try { text = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); } catch { throw httpErr(409, 'This project folder is not a Git clone any more (its .git/config is missing). Unlink it and import the Overleaf project again.'); }
  let section = null, sawUrl = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    let m = /^\[([A-Za-z0-9-]+)(?:\s+"([^"\\]*)")?\]$/.exec(line);
    if (m) {
      const name = m[1].toLowerCase();
      section = name === 'remote' ? (m[2] === 'origin' ? 'remote "origin"' : null) : name === 'branch' ? (m[2] != null ? 'branch' : null) : (m[2] == null ? name : null);
      if (!section || !CFG_ALLOWED[section]) throw refuse(line.slice(0, 60));
      continue;
    }
    m = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !section || /[\\"]/.test(m[2])) throw refuse(line.slice(0, 60));
    const key = m[1].toLowerCase(), value = m[2].replace(/\s+[#;].*$/, '').trim(), rule = CFG_ALLOWED[section][key];
    if (section === 'remote "origin"' && key === 'url') { if (value !== remoteUrl(olId)) throw refuse('remote url ' + scrub(value).slice(0, 80)); sawUrl = true; continue; }
    if (!rule || !rule.test(value)) throw refuse(`${section}.${key}`.slice(0, 60));
  }
  if (!sawUrl) throw refuse('no remote "origin" url');
}
// .git/info/attributes has the highest precedence: no clean / smudge filter named by a .gitattributes file is used.
function writeAttributes(dir) {
  const f = path.join(dir, '.git', 'info', 'attributes'), text = '# managed by ResearchTool\n* -filter -text\n';
  let old = null;
  try { old = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
  if (old !== text) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
}

// A linked project with its own .git folder. Throws 404 / 409 otherwise.
function repoOf(project) {
  const link = getLink(project.id);
  if (!link) throw httpErr(409, 'This project is not linked to Overleaf');
  if (project.missing) throw httpErr(404, 'The project folder no longer exists');
  let st = null;
  try { st = fs.statSync(path.join(project.path, '.git')); } catch { /* none */ }
  if (!st || !st.isDirectory()) throw httpErr(409, 'This project folder is not a Git clone any more (its .git folder is missing). Unlink it and import the Overleaf project again.');
  const cwd = project.path, ceiling = path.dirname(require('./projects').realpath(project.path)); // the same realpath as project paths (native on Windows)
  // checked again before every single git command, not only once per operation
  const g = async (args, opts = {}) => { checkRepoConfig(cwd, link.projectId); writeAttributes(cwd); return git(args, { cwd, ceiling, ...opts }); };
  checkRepoConfig(cwd, link.projectId);
  return { link, cwd, g, project };
}
async function must(repo, args, what, opts) {
  const r = await repo.g(args, opts);
  if (r.code !== 0) throw httpErr(500, `${what || 'git ' + args[0]} failed: ${lastLines(r.err || r.out) || (r.timedOut ? 'timed out' : 'exit code ' + r.code)}`);
  return r.out;
}
const zlist = (s) => s.split('\0').filter(Boolean);
// "ResearchTool" identity only if the user has none configured
async function identity(repo) {
  if (repo.ident) return repo.ident;
  const [n, e] = await Promise.all([repo.g(['config', 'user.name']), repo.g(['config', 'user.email'])]);
  repo.ident = [...(n.out.trim() ? [] : ['-c', 'user.name=ResearchTool']), ...(e.out.trim() ? [] : ['-c', 'user.email=researchtool@localhost'])];
  return repo.ident;
}
const head = async (repo) => (await must(repo, ['rev-parse', 'HEAD'])).trim();
async function dirtyFiles(repo) {
  const out = await must(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], 'git status');
  return zlist(out).map((l) => l.slice(3));
}
// Commit everything that changed locally. Returns true if a commit was made.
async function commitLocal(repo, message) {
  writeExclude(repo.cwd, repo.project.mainFile);
  await must(repo, ['add', '-A'], 'git add');
  const d = await repo.g(['diff', '--cached', '--quiet']);
  if (d.code === 0) return false;
  await must(repo, [...await identity(repo), 'commit', '-q', '--no-verify', '-m', message], 'git commit');
  return true;
}
async function fetch(repo) {
  const r = await repo.g(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`], { timeout: T_NET });
  if (r.code !== 0) throw netError(r, repo.link.projectId, 'Contacting Overleaf');
}
async function counts(repo) {
  const r = await repo.g(['rev-list', '--left-right', '--count', `HEAD...origin/${BRANCH}`]);
  if (r.code !== 0) return { ahead: 0, behind: 0 };
  const [a, b] = r.out.trim().split(/\s+/).map(Number);
  return { ahead: a || 0, behind: b || 0 };
}
const inMerge = (repo) => fs.existsSync(path.join(repo.cwd, '.git', 'MERGE_HEAD'));
async function abortMerge(repo) {
  if (!inMerge(repo)) return;
  const r = await repo.g(['merge', '--abort']);
  if (r.code !== 0) await repo.g(['reset', '--merge']);
}

// Merge origin/master into the (fully committed) working tree.
// -> {updated: [files], merged: bool}   merged = a real merge of both sides (false: nothing to do / fast-forward)
// -> {conflict: true, files}            the merge was aborted: the working tree is exactly as before, no markers
// strategy 'mine' | 'theirs' resolves conflicts by taking that side.
async function mergeRemote(repo, strategy) {
  await abortMerge(repo); // a merge left behind by a crash
  const before = await head(repo);
  const { ahead, behind } = await counts(repo);
  if (!behind) return { updated: [], merged: false };
  const ident = await identity(repo);
  const x = strategy === 'mine' ? ['-X', 'ours'] : strategy === 'theirs' ? ['-X', 'theirs'] : [];
  const r = await repo.g([...ident, 'merge', '--no-edit', '--no-verify', ...x, `origin/${BRANCH}`]);
  if (r.code !== 0) {
    const unmerged = inMerge(repo) ? zlist((await repo.g(['diff', '--name-only', '--diff-filter=U', '-z'])).out) : [];
    if (!unmerged.length) { // not a content conflict (e.g. an ignored local file is in the way)
      await abortMerge(repo);
      throw httpErr(500, 'Merging the Overleaf version failed: ' + (lastLines(r.err || r.out, 6) || (r.timedOut ? 'timed out' : 'exit code ' + r.code)));
    }
    if (!strategy) { await abortMerge(repo); return { conflict: true, files: unmerged }; }
    try { // what -X cannot decide (one side deleted the file, ...): take the chosen side as a whole
      const stages = new Map(); // path -> Set of stages (2 = mine, 3 = Overleaf)
      for (const rec of zlist((await repo.g(['ls-files', '-u', '-z'])).out)) {
        const tab = rec.indexOf('\t'), stage = Number(rec.slice(0, tab).split(' ')[2]), file = rec.slice(tab + 1);
        if (!stages.has(file)) stages.set(file, new Set());
        stages.get(file).add(stage);
      }
      const want = strategy === 'mine' ? 2 : 3;
      for (const [file, st] of stages) {
        if (st.has(want)) {
          await must(repo, ['checkout', strategy === 'mine' ? '--ours' : '--theirs', '--', file], 'Resolving ' + file);
          await must(repo, ['add', '--', file], 'Resolving ' + file);
        } else await must(repo, ['rm', '-q', '-f', '--', file], 'Resolving ' + file); // that side deleted it (a copy is in the trash)
      }
      await must(repo, [...ident, 'commit', '-q', '--no-verify', '--no-edit'], 'Finishing the merge');
    } catch (e) { await abortMerge(repo); throw e; }
  }
  const updated = zlist(await must(repo, ['diff', '--name-only', '-z', '--no-renames', before, 'HEAD']));
  return { updated, merged: ahead > 0 };
}

// History (source 'external') for the text files a pull changed. `snap` = core.snapshotProject() taken before.
function recordHistory(project, snap, files) {
  try {
    const h = H.open(project.id);
    for (const rel of files) {
      try {
        const r = P.resolveIn(project, rel);
        if (!r.exists) continue;
        const st = fs.statSync(r.abs);
        if (!st.isFile() || st.size > MAX_TEXT || kindOf(r.abs) !== 'text') continue;
        const buf = fs.readFileSync(r.abs);
        if (buf.includes(0)) continue;
        const last = h.newest(r.rel), before = snap && snap.get(r.rel);
        if (!last && !before) continue; // a file that is new from Overleaf: its history starts with the first edit here
        // the local content from just before the pull, if the history does not have it yet
        if (before && before.buf && before.hash !== sha1(buf) && (!last || last.hash !== before.hash)) h.record(r.rel, before.buf, last ? core.diskSource(project) : 'baseline');
        h.record(r.rel, buf, 'external');
      } catch { /* skip this file */ }
    }
    h.commit();
  } catch (e) { console.error('overleaf: history', e.message); }
}

// ---------- operations ----------
async function status() {
  const v = await git(['--version']);
  let helper = null;
  if (v.code === 0) {
    const h = await git(['config', '--get-all', 'credential.helper'], { cwd: ROOT });
    helper = plat.lines(h.out).map((l) => l.trim()).filter(Boolean).pop() || null;
  }
  return { git: v.code === 0, base: BASE, credentialHelper: helper };
}

function importProject({ url, name } = {}) {
  const olId = parseRef(url);
  let local;
  if (name != null && String(name).trim()) {
    local = P.safeName(String(name));
    if (!local || local === 'open' || local === 'import-zip' || (process.platform === 'win32' && plat.winReserved(local))) throw httpErr(400, 'Invalid project name (use letters, digits, - and _)');
  } else local = 'overleaf-' + olId.slice(0, 6);
  return enqueue('import:' + local, async () => {
    const dest = path.join(DIRS.projects, local);
    if (fs.existsSync(dest)) throw httpErr(409, `A project named "${local}" already exists. Choose another local name.`);
    for (const [pid, l] of Object.entries(links())) {
      if (l && l.projectId === olId && fs.existsSync(path.join(DIRS.projects, pid, '.git'))) {
        throw httpErr(409, `This Overleaf project is already here as "${pid}".`, { existing: pid });
      }
    }
    // clone into a hidden temp folder first, so a failed clone never leaves a half project behind
    const tmp = path.join(DIRS.projects, '.overleaf-clone-' + crypto.randomBytes(5).toString('hex'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
    let r;
    try {
      r = await git(['clone', '--quiet', '--no-tags', '--origin', 'origin', '--branch', BRANCH, '--', remoteUrl(olId), tmp],
        { cwd: DIRS.projects, timeout: T_CLONE });
    } catch (e) { cleanup(); throw e; }
    if (r.code !== 0) { cleanup(); throw netError(r, olId, 'Cloning from Overleaf'); }
    try {
      if (fs.existsSync(dest)) throw httpErr(409, `A project named "${local}" already exists. Choose another local name.`);
      writeExclude(tmp, null);
      fs.renameSync(tmp, dest);
    } catch (e) { cleanup(); throw e; }
    const link = { projectId: olId, url: webUrl(olId), lastSync: new Date().toISOString() };
    setLink(local, link);
    try { writeExclude(dest, P.get(local).mainFile); } catch { /* cosmetic */ }
    return { project: { ...P.get(local), overleaf: link } };
  });
}

async function projectStatus(project, doFetch) {
  const link = getLink(project.id);
  if (!link) return { linked: false };
  const base = { linked: true, projectId: link.projectId, url: link.url, lastSync: link.lastSync || null, dirty: 0, ahead: 0, behind: 0 };
  let repo;
  try { repo = repoOf(project); } catch (e) { return { ...base, broken: true, error: e.message }; }
  return enqueue(project.id, async () => {
    const extra = {};
    if (doFetch) {
      try { await fetch(repo); }
      catch (e) {
        if (e.extra && e.extra.needsLogin) { extra.needsLogin = true; extra.command = e.extra.command; }
        else { extra.offline = true; extra.error = e.message; }
      }
    }
    try {
      writeExclude(repo.cwd, project.mainFile);
      const dirty = (await dirtyFiles(repo)).length;
      return { ...base, dirty, ...await counts(repo), ...extra };
    } catch (e) {
      if (e.extra && e.extra.unsafeConfig) return { ...base, broken: true, error: e.message };
      throw e;
    }
  });
}

// commit local changes, fetch, merge. Shared by pull, push and resolve.
async function sync(repo, message, strategy) {
  const snap = core.snapshotProject(repo.project);
  await abortMerge(repo);
  await commitLocal(repo, message);
  await fetch(repo);
  let res = await mergeRemote(repo);
  let trashed = null;
  if (res.conflict) {
    if (!strategy) {
      throw httpErr(409, `Overleaf and your local copy both changed ${res.files.length === 1 ? res.files[0] : res.files.length + ' files'} in a way that cannot be combined automatically. Nothing was changed on disk - choose which version to keep.`,
        { conflict: true, files: res.files });
    }
    trashed = keepCopies(repo.project, res.files); // the local versions, before anything is replaced
    res = await mergeRemote(repo, strategy);
    if (res.conflict) throw httpErr(500, 'The conflict could not be resolved automatically');
  }
  if (res.updated.length) recordHistory(repo.project, snap, res.updated);
  return { ...res, trashed };
}
// Copy the local versions of the conflicting files to <workspace>/trash/<projectId>/<timestamp>/.
function keepCopies(project, files) {
  const dir = path.join(DIRS.trash, project.id, P.stamp());
  let n = 0;
  for (const rel of files) {
    let r;
    try { r = P.resolveIn(project, rel); } catch { continue; }
    if (!r.exists || !fs.statSync(r.abs).isFile()) continue; // deleted locally: nothing to keep
    const dest = path.join(dir, r.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(r.abs, dest);
    n++;
  }
  return n ? plat.toSlash(path.relative(core.WS, dir)) : null;
}

function pull(project) {
  const repo = repoOf(project);
  return enqueue(project.id, async () => {
    const res = await sync(repo, MSG_PULL);
    touchSync(project.id);
    return { ok: true, updated: res.updated, merged: res.merged };
  });
}

function cleanMessage(m) {
  if (m == null || m === '') return MSG_PUSH;
  if (typeof m !== 'string') throw httpErr(400, 'message must be a string');
  return m.replace(/\r/g, '').replace(/\0/g, '').trim().slice(0, 2000) || MSG_PUSH;
}
async function pushCommits(repo) {
  const { ahead } = await counts(repo);
  if (!ahead) return 0;
  const r = await repo.g(['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${BRANCH}`], { timeout: T_NET });
  if (r.code !== 0) {
    if (!r.timedOut && /non-fast-forward|fetch first|\[rejected\]|failed to update ref|cannot lock ref/i.test(r.err) && !AUTH_RE.test(r.err)) {
      throw httpErr(409, 'Overleaf changed while pushing. Nothing was lost - press Push again.', { rejected: true });
    }
    const remote = plat.lines(r.err).filter((l) => /^remote:/.test(l)).map((l) => l.replace(/^remote:\s*/, '').trim()).filter(Boolean).join(' ').slice(0, 400);
    if (!r.timedOut && remote && !AUTH_RE.test(r.err) && !NET_RE.test(r.err)) throw httpErr(502, 'Overleaf refused the push: ' + remote, { refused: true });
    throw netError(r, repo.link.projectId, 'Pushing to Overleaf');
  }
  await repo.g(['update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD']);
  return ahead;
}
function push(project, message) {
  const msg = cleanMessage(message);
  const repo = repoOf(project);
  return enqueue(project.id, async () => {
    const res = await sync(repo, msg);
    const pushed = await pushCommits(repo);
    touchSync(project.id);
    return { ok: true, pushed, updated: res.updated, merged: res.merged };
  });
}

function resolve(project, strategy) {
  if (strategy !== 'mine' && strategy !== 'theirs') throw httpErr(400, "strategy must be 'mine' or 'theirs'");
  const repo = repoOf(project);
  return enqueue(project.id, async () => {
    const res = await sync(repo, MSG_PULL, strategy);
    touchSync(project.id);
    return { ok: true, strategy, updated: res.updated, merged: res.merged, trashed: res.trashed };
  });
}

// Removes the link entry only: the folder and its .git stay.
function unlink(project) {
  if (!getLink(project.id)) throw httpErr(409, 'This project is not linked to Overleaf');
  return enqueue(project.id, async () => { setLink(project.id, null); return { ok: true }; });
}

module.exports = { BASE, BRANCH, baseCfg, parseRef, loginCommand, status, importProject, projectStatus, pull, push, resolve, unlink, getLink };
