// Keeping the app itself up to date (Preferences › General › Updates): an opt-in, fast-forward-only update of the
// app folder from the official repository on GitHub. Off unless settings.json says autoUpdate: true.
//
// What a check does, in this order - everything local first, so a copy that cannot update never causes a request:
//   1. the app folder is an ordinary git clone (its own .git folder, top level of the work tree) and git starts;
//   2. the settings inside .git are those of a plain clone: nothing there that makes git run a program or go
//      somewhere else (a filter, an include, http settings, a remote named like an address, a partial clone,
//      .git/info/attributes, alternates) - what cannot be switched off from the command line is refused;
//   3. no git command is running or half done there (index.lock, a merge / rebase / cherry-pick / bisect);
//   4. the user's git settings do not rewrite the address (url.*.insteadOf); origin is the official repository;
//      the branch is main, following origin/main; HEAD is not detached;
//   5. no tracked file was changed (untracked and ignored files - the workspace! - do not count and are never touched);
//   6. the one network request: git fetch of main from the address written in this file (OFFICIAL_URL), over https;
//   7. the fetched commit is strictly ahead of HEAD (never when this copy is ahead or has diverged), and what it
//      holds is safe to check out here: no file inside the workspace or backup folder, no symbolic link, no
//      submodule, no name Windows cannot write, no two names that differ only in case, a package.json this
//      updater understands (version, engines.node, updateEpoch);
//   8. only when asked to apply: everything local once more, then git merge --ff-only of exactly that commit.
// Never: a merge commit, a rebase, reset, stash, clean, checkout of another branch, a submodule, a repository hook,
// a credential, a prompt, a shell. Nothing from the browser or from settings.json ever reaches a git argument: the
// address, the branch and the allowed protocol are constants here, and what a test changes about them (a local bare
// repository instead of GitHub) is a parameter of createUpdater() that no setting, request or environment variable
// can reach.
// After an update the files on disk are new but this process still runs the old server code: status() says
// restartNeeded until the server is started again. Nothing restarts by itself (how the server was started is not
// ours to know).
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const plat = require('./platform');

const OFFICIAL_URL = 'https://github.com/purple-ginseng/ResearchTool.git';
// origin as `git clone` wrote it: https or ssh form, with or without ".git" - fully anchored, so no user name in
// front of the host, no port, no other host that merely starts with github.com
const OFFICIAL_RE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)purple-ginseng\/ResearchTool(?:\.git)?\/?$/i;
const isOfficial = (url) => typeof url === 'string' && url.length <= 200 && OFFICIAL_RE.test(url);
const HEAD_REF = 'refs/heads/main', REMOTE_REF = 'refs/remotes/origin/main'; // always full names: a tag "main" must not matter
// The maintainer's brake: a release that this updater must not install by itself (it needs a manual step) raises
// "updateEpoch" in package.json above the number the running updater knows.
const EPOCH = 1;
const USER_DIRS = ['workspace', 'backups']; // user data inside the app folder (lib/core.js WS, lib/backup.js DEFAULT_DIR)
const SHA = /^[0-9a-f]{40,64}$/;
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24}$/;
const HOUR = 3600000;
const T_LOCAL = 30000, T_NET = 150000, T_MERGE = 600000;
const short = (sha) => (SHA.test(String(sha || '')) ? sha.slice(0, 7) : '');

// ---------- settings: PUT /api/settings {autoUpdate} ----------
// Validates and writes into the settings object `s` (saved by the caller). Absent means off: only `true` switches the
// updates on, and nothing else about updates is ever read from settings.json (the Claude panel can write that file).
function configure(s, b) {
  if (!('autoUpdate' in b)) return;
  if (typeof b.autoUpdate !== 'boolean') throw core.httpErr(400, 'autoUpdate must be true or false');
  if (b.autoUpdate) s.autoUpdate = true; else delete s.autoUpdate;
}

// ---------- git ----------
// The options every call gets, the local ones too (git status would run core.fsmonitor's command).
const gitCfg = (protocols, platform = process.platform, execPath = process.execPath, fetchUrl = OFFICIAL_URL) => [
  // files inside .git can be written by other tools: no hook is ever run (reference-transaction on fetch, post-merge
  // on merge). The hooks folder is a path below a file, which can hold nothing: /dev/null, and on Windows (where
  // /dev/null would be C:\dev\null, a folder anyone may create) node.exe itself - as lib/overleaf.js does.
  `core.hooksPath=${platform === 'win32' ? execPath : '/dev/null'}`, 'core.fsmonitor=false',
  // never a credential and never a question: the repository is public, so nothing is sent and nothing can pop up
  'core.askPass=', 'credential.helper=',
  // only https (a test: the local-file transport); also set as GIT_ALLOW_PROTOCOL, which beats any configuration
  'protocol.allow=never', ...protocols.map((p) => `protocol.${p}.allow=always`), 'protocol.ext.allow=never',
  'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'fetch.prune=false', 'fetch.pruneTags=false',
  // the config form, not --no-autostash: an old git refuses a flag it does not know but ignores an unknown key.
  // With merge.autoStash=true in the user's own settings a merge would stash a file edited a moment ago.
  'merge.autoStash=false', 'merge.verifySignatures=false', 'commit.gpgSign=false',
  // git puts branch.main.mergeOptions in front of the options of every merge into main: "--squash" there would
  // rewrite the files without moving HEAD, "--autostash" beats merge.autoStash above. An empty value is no option.
  'branch.main.mergeOptions=',
  // no background clean-up after a fetch: it keeps files open (Windows) long after the answer was given
  'gc.auto=0', 'maintenance.auto=false',
  'http.sslVerify=true', 'http.lowSpeedLimit=1', 'http.lowSpeedTime=30', 'fetch.fsckObjects=true',
  // the request is anonymous: no header (a token kept as http.extraHeader - CI checkouts write one) and no cookie
  // of the user's git settings goes along. An empty extraHeader empties the list.
  'http.extraHeader=', 'http.cookieFile=', 'http.saveCookies=false',
  ...httpScoped(fetchUrl),
  'core.protectHFS=true', 'core.protectNTFS=true', 'core.longpaths=true',
  'core.quotePath=false', 'core.pager=cat', 'advice.detachedHead=false',
  // (core.autocrlf and core.fileMode are left as they are: .gitattributes pins the line ends, and overriding them
  // here would make unchanged files look modified)
].flatMap((c) => ['-c', c]);
// git reads http.* per address, and a key that names an address ("http.https://github.com/.sslVerify") beats the
// plain one above whatever file it stands in - a user who once switched the certificate check off for github.com
// behind a company proxy would fetch updates unchecked. So the same keys again for exactly the address that is
// fetched: no key can match it better, and of two equal ones the command line, read last, wins. (The proxy and the
// certificate files of the user's own settings are left alone on purpose; inside the app folder http.* is refused.)
function httpScoped(url) {
  if (!/^https?:\/\/[^\s=]+$/i.test(String(url))) return []; // (a test's local path: http.* plays no part there)
  return ['sslVerify=true', 'extraHeader=', 'cookieFile=', 'saveCookies=false'].map((kv) => `http.${url}.${kv}`);
}
// The environment of every call. No inherited GIT_* variable survives (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_COUNT,
// GIT_SSL_NO_VERIFY, GIT_ALLOW_PROTOCOL, GIT_SSH ... of the shell the server was started from) except where the
// certificates and git's own programs are. The user's global configuration stays: it carries the proxy, a company's
// certificates and safe.directory.
const KEEP_ENV = new Set(['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_EXEC_PATH']);
function gitEnv(base, root, protocols) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^GIT_/i.test(k) || KEEP_ENV.has(k.toUpperCase())) env[k] = v;
  return Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', // never wait for input nobody can give
    LC_ALL: 'C', LANG: 'C', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true',
    GIT_OPTIONAL_LOCKS: '0',          // our git status never holds the index lock the user's own git may want
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: protocols.join(':'),
    GIT_CEILING_DIRECTORIES: path.dirname(root), // never fall back to a repository above the app folder
  });
}

const NET_RE = /Could not resolve host|Failed to connect|Couldn't connect|Could not connect|Connection refused|Connection reset|Connection timed out|Operation timed out|Network is unreachable|No route to host|unable to access|SSL|TLS|certificate|early EOF|hung up unexpectedly|RPC failed|returned error: 5\d\d|transfer closed|proxy/i;
// why a fetch failed: 'no-git' (git could not be started), 'offline' (GitHub was not reached: no network, a
// captive portal, a proxy, a certificate problem, a timeout) or 'fetch-failed' (anything else, such as a 404)
const fetchReason = (r) => (r.code === -1 ? 'no-git' : r.timedOut || NET_RE.test(r.err || '') ? 'offline' : 'fetch-failed');

// ---------- the settings inside .git ----------
// Whatever can write a file below the app folder (another tool, an AI run with file tools) can write .git/config,
// and git does what that file says. The options above switch off what a fixed option can reach (hooks, fsmonitor,
// credentials, merge options). The rest has a name of its own choosing in its key - a filter, an address - so no
// option can name it in advance: it is looked for, and a clone that has any of it is not updated by the app
// ('config'). Nothing a plain `git clone` or an editor writes is in this list.
//   filter.<name>.*           clean / smudge / process run a program on every file git status or a checkout looks at
//   include.*, includeIf.*    another file's settings, which the list of this file's keys does not show
//   http.*                    per-address proxy, certificate check and headers (see httpScoped) - the user's own
//                             belong in their global settings, which are kept
//   core.alternateRefsCommand a program run during a fetch;  core.attributesFile: where filters are switched on
//   extensions.partialClone, remote.<name>.promisor / .partialCloneFilter
//                             a partial clone downloads missing files from the remote of that NAME whenever a command
//                             needs one - a request no check here would know about
//   extensions.worktreeConfig a second settings file (.git/config.worktree)
//   remote.<address>.*        a remote section named like an address applies to a fetch of that address (uploadpack,
//                             proxy, extra refspecs that move other branches). A remote with an ordinary name
//                             (origin, upstream, a fork) plays no part: the fetch names the address, not the remote.
// names: the keys of `git config --local --list --name-only -z` -> the kind of the first offending key, or null. Only
// the kind is ever shown - a key can hold an address with a token in it.
const REMOTE_NICK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
function configProblem(names) {
  for (const raw of names || []) {
    const n = String(raw), a = n.indexOf('.'), b = n.lastIndexOf('.');
    if (a < 1) continue;
    const sec = n.slice(0, a).toLowerCase(), key = n.slice(b + 1).toLowerCase(), sub = b > a ? n.slice(a + 1, b) : null;
    if (sec === 'filter' || sec === 'include' || sec === 'includeif' || sec === 'http') return sec;
    if (sec === 'core' && sub === null && (key === 'alternaterefscommand' || key === 'attributesfile')) return 'core.' + key;
    if (sec === 'extensions' && sub === null && (key === 'partialclone' || key === 'worktreeconfig')) return 'extensions.' + key;
    if (sec === 'remote' && sub !== null && (!REMOTE_NICK.test(sub) || key === 'promisor' || key === 'partialclonefilter')) return 'remote';
  }
  return null;
}
// The two files inside .git that do the same without a key (no process is started to look): .git/info/attributes
// switches a filter on for every file, and objects/info/alternates makes a fetch run core.alternateRefsCommand
// (and borrows objects from a folder that is not this clone's). -> the kind, or null
function gitDirProblem(gd) {
  try {
    if (plat.lines(fs.readFileSync(path.join(gd, 'info', 'attributes'), 'utf8')).some((l) => l.trim() && !l.trim().startsWith('#'))) return 'info/attributes';
  } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return 'info/attributes'; }
  try { fs.lstatSync(path.join(gd, 'objects', 'info', 'alternates')); return 'objects/info/alternates'; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return 'objects/info/alternates'; }
  return null;
}

// ---------- what a commit would put on disk ----------
// `git ls-tree -r -z` output -> [{mode, path}]
function parseTree(out) {
  const list = [];
  for (const rec of String(out || '').split('\0')) {
    const m = /^(\d{6}) \w+ [0-9a-f]+\t([\s\S]+)$/.exec(rec);
    if (m) list.push({ mode: m[1], path: m[2] });
  }
  return list;
}
// The first reason not to check a tree out by itself -> {what, path} | null. `dirs`: folders (relative to the app
// folder, forward slashes) that hold the user's data; compared without case, because the disk may not have one.
function treeProblem(entries, dirs = USER_DIRS) {
  const mine = dirs.map((d) => String(d).toLowerCase().replace(/\/+$/, '')).filter(Boolean);
  const seen = new Map(); // lower-cased path of every file and folder -> as it is written
  for (const e of entries) {
    const p = e.path, low = p.toLowerCase(), parts = p.split('/');
    // an ignored file is overwritten by a checkout without a word: nothing tracked may ever sit where the data is
    if (mine.some((d) => low === d || low.startsWith(d + '/'))) return { what: 'user-data', path: p };
    if (e.mode === '120000') return { what: 'symlink', path: p };
    if (e.mode === '160000' || low === '.gitmodules') return { what: 'submodule', path: p };
    if (e.mode !== '100644' && e.mode !== '100755') return { what: 'mode', path: p };
    // a name Windows cannot create, or reads as another one, leaves a half checkout there (and a tree that is
    // "modified" for ever after)
    if (parts.some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git' || s.includes('\\') || plat.winBadName(s))) return { what: 'bad-name', path: p };
    for (let i = 1; i <= parts.length; i++) { // two names that differ only in case are one file on macOS and Windows
      const pre = parts.slice(0, i).join('/'), k = pre.toLowerCase(), was = seen.get(k);
      if (was === undefined) seen.set(k, pre); else if (was !== pre) return { what: 'case', path: p };
    }
  }
  return null;
}
// package.json "engines".node against the Node that runs: only the form ">=18", ">=18.17" or ">=18.17.1" is
// understood. Anything else cannot be judged, and the cautious answer is no (the test suite checks the app's own
// package.json, so the maintainer is stopped first).
function nodeOk(range, have = process.versions.node) {
  if (range == null) return true;
  const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(range));
  if (!m) return false;
  const want = [m[1], m[2] || 0, m[3] || 0].map(Number), got = String(have).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((got[i] || 0) !== want[i]) return (got[i] || 0) > want[i];
  return true;
}
// What the new package.json says -> {version} or {reason, detail}
function packageProblem(text, have) {
  let j; try { j = JSON.parse(text); } catch { return { reason: 'blocked', detail: { what: 'package' } }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.version !== 'string' || !VERSION.test(j.version)) return { reason: 'blocked', detail: { what: 'package' } };
  if (j.updateEpoch !== undefined && !(Number.isInteger(j.updateEpoch) && j.updateEpoch >= 0 && j.updateEpoch <= EPOCH)) return { reason: 'manual', detail: { version: j.version } };
  const range = j.engines && typeof j.engines === 'object' ? j.engines.node : undefined;
  if (!nodeOk(range, have)) return { reason: 'needs-node', detail: { version: j.version, needs: String(range).replace(/[^0-9A-Za-z.>=^~| *-]/g, '').slice(0, 30) } };
  return { version: j.version };
}

// HEAD of a plain repository read from its files (no process is started): a branch file, or packed-refs. null when
// it cannot be read this way (no repository; the newer "reftable" storage) - the commit is then known only once a
// check has asked git (never the plain status: it starts no process).
function headOnDisk(root) {
  try {
    const gd = path.join(root, '.git');
    if (!fs.lstatSync(gd).isDirectory()) return null;
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head;
    const m = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head);
    if (!m || m[1].split('/').some((s) => !s || s === '.' || s === '..')) return null;
    try { const v = fs.readFileSync(path.join(gd, ...m[1].split('/')), 'utf8').trim(); if (SHA.test(v)) return v; } catch { /* a packed ref */ }
    for (const line of plat.lines(fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8'))) {
      const p = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
      if (p && p[2] === m[1]) return p[1];
    }
  } catch { /* not there */ }
  return null;
}

// ---------- the updater ----------
// root          the app folder
// The rest is for the tests (scripts/test-update.js), which run against local bare repositories in temporary folders
// and never against this repository or the network. None of it is read from settings, a request or the environment:
// allowOrigin(url) -> bool, fetchUrl, protocols, env, timeouts, now(), minInterval (between two fetches),
// lookInterval (how long a look at the local conditions is reused),
// settings() -> {autoUpdate}, stateFile (the last check, kept across restarts; display only), disabled (the kill
// switch), userDirs() -> absolute folders of user data, onGit(args) (called before every git process), nodeVersion,
// log (the line the terminal gets after an update).
function createUpdater({ root, allowOrigin = isOfficial, fetchUrl = OFFICIAL_URL, protocols = ['https'], env = process.env,
  netTimeout = T_NET, mergeTimeout = T_MERGE, localTimeout = T_LOCAL, now = Date.now, minInterval = 60000, lookInterval = 5000,
  settings = () => core.loadSettings(), stateFile = null, disabled = false, userDirs = () => [], onGit = null, nodeVersion = process.versions.node, log = console.log } = {}) {
  root = path.resolve(String(root));
  const CFG = gitCfg(protocols, process.platform, process.execPath, fetchUrl), ENV = gitEnv(env, root, protocols);
  const stats = { spawns: 0, fetches: 0, merges: 0 };

  // spawn('git', [args]) in the app folder - no shell (core.spawnTool). Resolves {code, out, err, timedOut}; never
  // rejects. code -1: git could not be started. On timeout the process tree is killed (git and its remote helper).
  function git(args, { timeout = localTimeout } = {}) {
    return new Promise((resolve) => {
      let out = '', err = '', done = false, timedOut = false, child;
      const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err, timedOut }); };
      stats.spawns++;
      try { if (onGit) onGit(args); } catch { /* a test's spy */ }
      try { child = core.spawnTool('git', [...CFG, ...args], { cwd: root, env: ENV, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e), timedOut: false }); }
      const timer = setTimeout(() => {
        timedOut = true;
        core.killTree(child, { group: true });
        setTimeout(() => finish(null), 1500); // in case 'close' never comes
      }, timeout);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (out.length < 8e6) out += d; });
      child.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
      child.on('error', (e) => { err += String(e.message || e); finish(-1); });
      child.on('close', (code) => finish(code));
    });
  }
  const revParse = async (what) => { const r = await git(['rev-parse', '--verify', '--quiet', what + '^{commit}']); const s = r.out.trim(); return r.code === 0 && SHA.test(s) ? s : null; };

  // ---- what this process loaded, taken before anything can change the folder ----
  const diskVersion = () => { try { const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; return typeof v === 'string' && VERSION.test(v) ? v : ''; } catch { return ''; } };
  // Read from the files, never by starting git: creating the updater and the plain status must start no process
  // (the box may be off; the status is a GET that any page can cause). Where the refs cannot be read from files
  // (reftable), the commit is unknown until the first look at the local conditions has asked git - `seen` - and
  // until then only the version tells that the files are newer than the program.
  const boot = { version: diskVersion(), commit: headOnDisk(root) };
  let seen = null;         // HEAD as git last said it (used only where the files cannot tell)
  const diskCommit = () => headOnDisk(root) || seen || null;

  // ---- state ----
  let running = null;      // the check in flight (one at a time)
  let pre = null;          // the last look at the local conditions: {ok, reason, detail}
  let last = null;         // the last check of this run: {when, result, reason, detail, head, sha, version, ahead, behind,
                           //   local (the reason is about the folder itself), stale (a later look found the folder in order)}
  let lastFetchAt = -Infinity;
  let net = null;          // what the last fetch brought: {sha} | {reason}
  let updated = null;      // {from, to, version, restartNeeded: true} once this process has updated the folder
  let halfNew = false;     // a fast-forward of this process stopped half way: some files on disk may be new
  let looking = null, lookedAt = -Infinity; // the look at the local conditions in flight, and when `pre` was taken
  const readState = () => { const j = stateFile ? core.readJSON(stateFile, null) : null; return j && typeof j === 'object' && typeof j.when === 'string' && !isNaN(Date.parse(j.when)) ? j : null; };
  // A fast-forward that stopped half way leaves changed files and the old HEAD - which looks exactly like "the user
  // edited program files" (dirty), and the advice for that is wrong here. So it is remembered, also across a
  // restart: {head (the commit the folder was on), sha (the one it was going to)}. While HEAD is still `head` and
  // the tree is not clean, the answer is 'interrupted'; once the tree is clean or HEAD has moved, it is over.
  const brokenOf = (j) => (j && j.interrupted && typeof j.interrupted === 'object' && SHA.test(String(j.interrupted.head || '')) && SHA.test(String(j.interrupted.sha || '')) ? { head: j.interrupted.head, sha: j.interrupted.sha } : null);
  let broken = brokenOf(readState());
  function mended() { // (the one thing a look may write: the mark is taken out of the state file)
    if (!broken) return;
    broken = null;
    const j = readState();
    if (j && j.interrupted) { delete j.interrupted; try { core.writeJSON(stateFile, j); } catch (e) { console.error('update state:', e.message); } }
  }
  function lastCheck() {
    const l = last || readState();
    if (!l) return null;
    const codeOf = (v) => (typeof v === 'string' && /^[a-z-]{1,24}$/.test(v) ? v : null);
    return { when: new Date(Date.parse(l.when)).toISOString(), result: codeOf(l.result) || 'failed', reason: codeOf(l.reason) };
  }

  // folders of user data that lie inside the app folder, relative to it (workspace/ and backups/ always)
  function dataDirs() {
    const out = [...USER_DIRS];
    let base; try { base = plat.realpath(root); } catch { base = root; }
    for (const d of userDirs() || []) {
      try {
        const rel = path.relative(base, plat.realpathNear(d));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.push(plat.toSlash(rel));
      } catch { /* a folder that cannot be resolved is not inside */ }
    }
    return out;
  }

  // ---- the local conditions (no network, nothing written) -> {ok: true, head} | {ok: false, reason, detail} ----
  async function local() {
    const no = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail } : {}) });
    if (disabled) return no('disabled');
    const gd = path.join(root, '.git');
    let st; try { st = fs.lstatSync(gd); } catch { return no('not-git'); } // from a ZIP: git is not even started
    if (!st.isDirectory()) return no('unusual');                           // a linked work tree, a submodule, a link
    // the top level of its own work tree: both "up" and "prefix" are empty only there, whatever the path looks like
    // (8.3 names, /tmp -> /private/tmp); core.worktree or a broken .git that sends git to a repository above fail
    // here, and so does a .git whose settings and objects are kept somewhere else (.git/commondir).
    // (This first command only reads settings and prints paths - it looks at no file of the work tree, so nothing
    // that .git/config names can run yet.)
    const top = await git(['rev-parse', '--is-inside-work-tree', '--show-cdup', '--show-prefix', '--git-dir', '--git-common-dir']);
    if (top.code === -1) return no('no-git');
    // (macOS: /usr/bin/git is a stand-in that fails until the command line tools are installed and their license
    // agreed to - "git is not usable", not "this is no repository")
    if (top.code !== 0) return no(/dubious ownership|safe\.directory/i.test(top.err) ? 'unsafe' : /not a git repository/i.test(top.err) ? 'not-git' : /xcode|xcrun|developer tools|license/i.test(top.err) ? 'no-git' : 'git-failed');
    const t = plat.lines(top.out);
    if (t[0] !== 'true' || t[1] !== '' || t[2] !== '' || t[3] !== '.git' || t[4] !== '.git') return no('unusual');
    // before any command that looks at files or fetches: nothing in .git that would run a program or change where
    // a fetch goes (configProblem, gitDirProblem). --local lists this file's own keys; includes are not followed,
    // which is why an include is itself refused.
    const odd = gitDirProblem(gd);
    if (odd) return no('config', { what: odd });
    const cf = await git(['config', '--local', '--list', '--name-only', '-z']);
    if (cf.code !== 0) return no('git-failed');
    const key = configProblem(cf.out.split('\0'));
    if (key) return no('config', { what: key });
    if (fs.existsSync(path.join(gd, 'index.lock'))) return no('locked');
    if (['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'].some((n) => fs.existsSync(path.join(gd, n)))) return no('in-progress');
    // url.<x>.insteadOf in the user's settings would send the fetch somewhere else: asked of git itself, no network
    const u = await git(['ls-remote', '--get-url', fetchUrl]);
    if (u.code !== 0 || u.out.trim() !== fetchUrl) return no('redirect');
    const o = await git(['remote', 'get-url', 'origin']);
    if (o.code !== 0 || !allowOrigin(o.out.trim())) return no('origin'); // (the address itself is never shown: a fork's may hold a token)
    const b = await git(['symbolic-ref', '-q', 'HEAD']);
    if (b.code === 1) return no('detached');
    if (b.code !== 0) return no('git-failed');
    if (b.out.trim() !== HEAD_REF) return no('branch');
    const tr = await git(['config', '--get-regexp', '^branch\\.main\\.(remote|merge)$']);
    const pairs = plat.lines(tr.out).map((l) => l.trim()).filter(Boolean).sort().join('\n');
    if (pairs !== 'branch.main.merge refs/heads/main\nbranch.main.remote origin') return no('tracking');
    const s = await git(['status', '--porcelain', '--untracked-files=no']);
    if (s.code !== 0) return no('git-failed');
    const head = await revParse('HEAD');
    if (!head) return no('git-failed');
    seen = head;
    if (!boot.commit) boot.commit = head; // (refs that cannot be read from files: the first look is the earliest it is known)
    if (s.out.trim()) {
      if (broken && broken.head === head) return no('interrupted');
      mended();
      return no('dirty');
    }
    mended();
    if (head === boot.commit) halfNew = false; // the folder is again exactly what this process loaded
    // a reason of the last check that was about the folder itself is answered afresh by this look
    if (last && last.result === 'failed' && last.local) last.stale = true;
    return { ok: true, head };
  }
  // The same look for the status (GET /api/update/status?local=1 - a GET, which the X-RT rule does not cover): one
  // at a time, and the answer is reused for a few seconds, so a page that asks a hundred times starts git once.
  function look() {
    if (looking) return looking;
    const age = now() - lookedAt;
    if (pre && age >= 0 && age < lookInterval) return Promise.resolve(pre);
    looking = local().then((r) => { if (!running) { pre = r; lookedAt = now(); } return r; }).finally(() => { looking = null; });
    return looking;
  }

  // ---- one check ----
  function remember(o) {
    last = { when: new Date(now()).toISOString(), ...o };
    if (stateFile) { try { core.writeJSON(stateFile, { when: last.when, result: last.result, reason: last.reason || null, ...(broken ? { interrupted: broken } : {}) }); } catch (e) { console.error('update state:', e.message); } }
    return last;
  }
  async function run({ apply }) {
    pre = await local(); lookedAt = now();
    // (local: a reason about the folder itself - the next look at it answers afresh, see status())
    if (!pre.ok) { remember({ result: 'failed', reason: pre.reason, detail: pre.detail, local: true }); return {}; }
    const head = pre.head;
    let throttled = false;
    if (now() - lastFetchAt < minInterval) {
      // asked again within a minute: no second request. The commit the last one fetched is compared again ("Update
      // now" right after "Check for updates now" needs no network); a request that failed is answered as it was.
      throttled = true;
    } else {
      lastFetchAt = now(); stats.fetches++; net = null;
      // --refmap= (empty): only the one ref named here is written, whatever refspecs any settings hold
      const f = await git(['fetch', '--no-tags', '--no-recurse-submodules', '--refmap=', '--quiet', fetchUrl, `+${HEAD_REF}:${REMOTE_REF}`], { timeout: netTimeout });
      const got = f.code === 0 ? await revParse(REMOTE_REF) : null; // resolved once; from here on only this commit is spoken of
      net = got ? { sha: got } : { reason: f.code === 0 ? 'fetch-failed' : fetchReason(f) };
    }
    if (!net || !net.sha) { remember({ result: 'failed', reason: net ? net.reason : 'fetch-failed' }); return { throttled }; }
    const sha = net.sha;
    if (sha === head) { remember({ result: 'up-to-date', head, sha, ahead: 0, behind: 0 }); return { throttled }; }
    const c = await git(['rev-list', '--left-right', '--count', `${head}...${sha}`]);
    const m = /^(\d+)\s+(\d+)\s*$/.exec(c.out);
    if (c.code !== 0 || !m) { remember({ result: 'failed', reason: 'compare', head, sha }); return { throttled }; }
    const ahead = Number(m[1]), behind = Number(m[2]);
    if (ahead > 0 || behind === 0) { remember({ result: 'failed', reason: behind > 0 ? 'diverged' : 'ahead', head, sha, ahead, behind }); return { throttled }; }
    // what the new commit holds, read from the object store - nothing is checked out yet
    const tree = await git(['ls-tree', '-r', '-z', '--full-tree', sha]);
    const pkg = await git(['show', `${sha}:package.json`]);
    if (tree.code !== 0 || pkg.code !== 0) { remember({ result: 'failed', reason: 'compare', head, sha, ahead, behind }); return { throttled }; }
    const bad = treeProblem(parseTree(tree.out), dataDirs());
    const pk = bad ? null : packageProblem(pkg.out, nodeVersion);
    if (bad || pk.reason) {
      const detail = bad ? { what: bad.what, path: bad.path.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 120) } : pk.detail;
      remember({ result: 'failed', reason: bad ? 'blocked' : pk.reason, detail, head, sha, ahead, behind });
      return { throttled };
    }
    const version = pk.version;
    if (!apply) { remember({ result: 'available', head, sha, version, ahead, behind }); return { throttled }; }

    // ---- apply: everything local once more (the download took time), then the fast-forward to exactly that commit ----
    pre = await local(); lookedAt = now();
    if (!pre.ok || pre.head !== head) { remember({ result: 'failed', reason: pre.ok ? 'moved' : pre.reason, detail: pre.detail, local: !pre.ok }); return { throttled }; }
    stats.merges++;
    const mg = await git(['merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', '--quiet', sha], { timeout: mergeTimeout });
    const after = await revParse('HEAD');
    if (after) seen = after;
    if (mg.code === 0 && after === sha) {
      updated = { from: short(head), to: short(sha), version, restartNeeded: true };
      remember({ result: 'updated', head: sha, sha, version, ahead: 0, behind: 0 });
      log(`ResearchTool was updated to v${version} (${short(sha)}). Restart it to finish: stop it (Ctrl+C) and run node server.js again.`);
      return { throttled };
    }
    // git says no before it writes anything: a file in the way (untracked or ignored), a file edited this very moment
    const st = await git(['status', '--porcelain', '--untracked-files=no']);
    const clean = st.code === 0 && !st.out.trim();
    if (!mg.timedOut && mg.code !== null && after === head && /would be overwritten|untracked working tree files|Not possible to fast-forward/i.test(mg.err)) {
      const files = plat.lines(mg.err).filter((l) => /^\t\S/.test(l)).map((l) => l.trim().replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 120)).slice(0, 5);
      const mine = /local changes/i.test(mg.err);
      remember({ result: 'failed', reason: mine ? 'dirty' : 'refused', ...(mine ? { local: true } : {}), ...(files.length ? { detail: { files } } : {}), head, sha, version, ahead, behind });
    } else if (after === head && clean) {
      // nothing was written - also when git was stopped (the timeout) before it got anywhere: the folder is whole
      remember({ result: 'failed', reason: 'refused', head, sha, version, ahead, behind });
    } else {
      // stopped half way (the disk is full, a file is locked, the process was killed): some files are new. The
      // page must not call this "updated", and the next look must not call it "you changed program files".
      halfNew = true;
      if (after === head) { broken = { head, sha }; pre = { ok: false, reason: 'interrupted' }; lookedAt = now(); }
      remember({ result: 'failed', reason: 'interrupted', local: true });
    }
    return { throttled };
  }

  // ---- what the page shows: GET /api/update/status (no network; with {local: true} the local conditions are looked at) ----
  async function status({ local: wanted = false } = {}) {
    if (wanted && !running) { try { await look(); } catch { /* keeps what was known */ } }
    const commit = diskCommit(), version = diskVersion();
    const l = last, fresh = !!(l && l.head && l.head === commit); // what a check found is about the HEAD it saw
    const failed = l && l.result === 'failed';
    // 'interrupted' is about the folder as the stopped fast-forward left it: once HEAD is elsewhere (the repair in
    // docs/troubleshooting.md moves it) it no longer holds, and what the folder is like is not known until the next look
    const gone = !!(broken && commit && commit !== broken.head);
    const p = pre && !pre.ok && pre.reason === 'interrupted' && (gone || !broken) ? null : pre;
    // why not: what the last look at the folder found; else what the last check found after that look - but not a
    // reason about the folder itself (dirty, another branch ...) once a later look has found the folder in order
    const why = p && !p.ok ? p : failed && !l.stale && !(gone && l.reason === 'interrupted') ? l : null;
    return {
      auto: settings().autoUpdate === true, disabled: !!disabled,
      supported: p ? p.ok : null, reason: why ? why.reason : null, ...(why && why.detail ? { detail: why.detail } : {}),
      version, commit: short(commit), running: { version: boot.version, commit: short(boot.commit) },
      // new files on disk, old code in memory: after our own update, after a git pull by hand, and after a
      // fast-forward that stopped half way (HEAD and the version may both still be the old ones then)
      restartNeeded: !!updated || halfNew || (!!boot.commit && !!commit && commit !== boot.commit) || (!!boot.version && !!version && version !== boot.version),
      checking: !!running,
      ahead: fresh && Number.isInteger(l.ahead) ? l.ahead : null, behind: fresh && Number.isInteger(l.behind) ? l.behind : null,
      available: fresh && l.result === 'available' ? { commit: short(l.sha), version: l.version } : null,
      lastCheck: lastCheck(), updated,
    };
  }

  // POST /api/update/check: one at a time. A second caller is told so - it never shares the first one's run (an
  // "apply" must not be answered by a check that only looked, nor the other way round).
  function check({ apply = false } = {}) {
    if (running) return status().then((s) => ({ ...s, result: 'busy', busy: true }));
    const p = (async () => {
      let extra = {};
      try { extra = await run({ apply: apply === true }); }
      catch (e) { console.error('update check:', e && e.message ? e.message : e); remember({ result: 'failed', reason: 'git-failed' }); }
      return extra;
    })();
    running = p;
    return p.then(async (extra) => {
      running = null;
      const s = await status();
      return { ...s, result: last ? last.result : 'failed', ...(extra.throttled ? { throttled: true } : {}) };
    });
  }

  // ---- by itself: a little after the start and then every hour, a check when the last one is 20 hours old ----
  // The setting is read every time, so unticking the box stops the requests at once. With the box off nothing is
  // started at all - not even a local git command. A check that failed on the way (offline, a changed file, another
  // branch) is tried again the next hour; one whose answer was read and will not change by waiting is not.
  const SETTLED = new Set(['ahead', 'diverged', 'blocked', 'manual', 'needs-node', 'compare', 'refused', 'interrupted']);
  async function tick() {
    try {
      if (disabled || running || settings().autoUpdate !== true) return null;
      const l = lastCheck(), t = l ? Date.parse(l.when) : NaN;
      const age = t <= now() ? now() - t : Infinity; // (a time in the future - a changed clock, an edited file - counts as never)
      // (an update that a check by hand found and left is installed at the next tick, not a day later; a failure
      // that only GitHub's side or a deliberate step of the user can change waits the full time like a success)
      if (l && l.result !== 'available' && age < (l.result === 'failed' && !SETTLED.has(l.reason) ? 50 * 60000 : 20 * HOUR)) return null;
      return await check({ apply: true });
    } catch (e) { console.error('automatic update:', e && e.message ? e.message : e); return null; }
  }
  let timers = null;
  function schedule() {
    if (timers || disabled) return;
    timers = [setTimeout(tick, Number(process.env.RT_UPDATE_FIRST_MS) || 75 * 1000), setInterval(tick, HOUR)];
    for (const t of timers) t.unref();
  }
  // the box was just ticked: the first check now, not in a day (not awaited by the request that saved the setting)
  function kick() { if (!disabled && settings().autoUpdate === true) check({ apply: true }).catch(() => {}); }

  return { status, check, tick, schedule, kick, boot, stats, env: ENV, cfg: CFG };
}

// the one updater of the running server: the app folder itself
let theReal = null;
function real() {
  if (!theReal) {
    theReal = createUpdater({
      root: core.ROOT, stateFile: path.join(core.DIRS.cache, 'update.json'),
      // RT_NO_UPDATE=1: the kill switch. It can only switch updates off (it beats the setting), never widen anything.
      disabled: process.env.RT_NO_UPDATE === '1',
      userDirs: () => [core.WS, require('./backup').config().dir],
    });
  }
  return theReal;
}

module.exports = { createUpdater, real, configure, isOfficial, treeProblem, parseTree, nodeOk, packageProblem, headOnDisk, fetchReason, gitCfg, gitEnv, configProblem, gitDirProblem,
  OFFICIAL_URL, EPOCH, USER_DIRS };
