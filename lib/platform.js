// What differs between macOS, Linux and Windows, in one place: the PATH the server adds, how a command-line tool is
// found and started without a shell, how a process tree is stopped, path containment, file names Windows refuses,
// tool output with \r\n line ends, and the wording of a few messages.
//
// Every function takes the platform (and, where it matters, the environment and the file-system probes) as options,
// so scripts/test-platform.js can play Windows on any machine. lib/core.js wires them to the real process.
//
// Security: tools are always started with spawn(file, [args]) and never through a shell (no shell: true, no
// cmd.exe /c). User-controlled arguments (paper titles, prompts, file names) therefore never reach a command
// interpreter. On Windows that rules out .cmd / .bat files, which only cmd.exe can run: an npm shim (claude.cmd) is
// read instead and the JavaScript file it points at is run with node itself; any other .cmd is refused.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const isFileReal = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isDirReal = (f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
const listReal = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const pathOf = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// ---------- environment ----------
// Windows environment names are case-blind (PATH is usually spelled "Path"); a copy of process.env ({...env}) is a
// plain object, so the key is looked up by hand.
function envKey(env, name, platform = process.platform) {
  if (!env) return null;
  if (platform !== 'win32') return Object.prototype.hasOwnProperty.call(env, name) ? name : null;
  const low = name.toLowerCase();
  return Object.keys(env).find((k) => k.toLowerCase() === low) || null;
}
function getEnv(env, name, platform = process.platform) {
  const k = envKey(env, name, platform);
  return k == null ? undefined : env[k];
}

// ---------- PATH ----------
// Folders added to PATH at start (only those that exist on Windows; the macOS ones as before, because a server
// started from Finder / launchd gets a minimal PATH): TeX, Homebrew, ~/.local/bin (the claude CLI's own installer).
function extraPathDirs({ platform = process.platform, env = process.env, home = '', isDir = isDirReal, list = listReal } = {}) {
  const P = pathOf(platform), out = [];
  if (platform === 'darwin') out.push('/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin');
  if (home) out.push(P.join(home, '.local', 'bin'));
  // Grok Build's own installer (x.ai/cli/install.sh, install.ps1) puts grok in ~/.grok/bin: added when it is there
  if (home && platform !== 'win32' && isDir(P.join(home, '.grok', 'bin'))) out.push(P.join(home, '.grok', 'bin'));
  if (platform === 'win32') {
    const get = (n) => getEnv(env, n, platform);
    const drive = get('SystemDrive') || 'C:';
    const cand = [];
    // TeX Live: C:\texlive\<year>\bin\windows (2023+), bin\win64, bin\win32 (older); the newest year first
    const tl = P.join(drive + '\\', 'texlive');
    for (const y of list(tl).filter((n) => /^\d{4}$/.test(n)).sort().reverse()) {
      for (const b of ['windows', 'win64', 'win32']) cand.push(P.join(tl, y, 'bin', b));
    }
    // MiKTeX (per-user and all-users installs)
    for (const base of [get('LOCALAPPDATA') && P.join(get('LOCALAPPDATA'), 'Programs'), get('ProgramFiles'), get('ProgramFiles(x86)')]) {
      if (base) cand.push(P.join(base, 'MiKTeX', 'miktex', 'bin', 'x64'), P.join(base, 'MiKTeX', 'miktex', 'bin'));
    }
    if (get('APPDATA')) cand.push(P.join(get('APPDATA'), 'npm')); // npm's global bin folder (claude.cmd)
    if (home) cand.push(P.join(home, '.grok', 'bin'));            // Grok Build (install.ps1)
    if (get('LOCALAPPDATA')) cand.push(P.join(get('LOCALAPPDATA'), 'agy', 'bin')); // Antigravity CLI (install.ps1)
    if (home) cand.push(P.join(home, 'scoop', 'shims'));          // scoop (poppler, git ...)
    if (get('ProgramData')) cand.push(P.join(get('ProgramData'), 'chocolatey', 'bin'));
    for (const d of cand) if (isDir(d)) out.push(d);
  }
  return out;
}
// The PATH the server runs with: the current one first, then the extra folders, no folder twice.
function buildPath(current, opts = {}) {
  const platform = opts.platform || process.platform, delim = platform === 'win32' ? ';' : ':';
  const key = (d) => (platform === 'win32' ? d.replace(/[\\/]+$/, '').toLowerCase() : d.replace(/\/+$/, '') || '/');
  const seen = new Set(), out = [];
  for (const d of [...String(current || '').split(delim), ...extraPathDirs(opts)]) {
    if (!d || seen.has(key(d))) continue;
    seen.add(key(d)); out.push(d);
  }
  return out.join(delim);
}

// ---------- finding a tool ----------
// An npm / cmd-shim .cmd file -> {target (relative to the .cmd's folder), localNode} or null. The forms written by
// cmd-shim:  "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*   (npm 7+)
//            "%~dp0\node.exe"  "%~dp0\node_modules\pkg\cli.js" %*   /   node  "%~dp0\..." %*   (older)
//            "%dp0%\node_modules\pkg\bin\tool.exe"   %*   (a package whose bin is a program)
function parseCmdShim(text) {
  const t = String(text || '').replace(/\r/g, '');
  if (t.length > 16384) return null;
  let m, last = null;
  const re = /"%(?:~dp0|dp0%)\\?([^"%\n]+)"[ \t]+%\*/g;
  while ((m = re.exec(t))) last = m[1];
  // the target must stay below the shim's folder: no absolute path, no drive, no ".." step
  if (!last || /^[\\/]|^[A-Za-z]:/.test(last) || last.split(/[\\/]/).some((s) => s.trim() === '..')) return null;
  const ext = path.win32.extname(last).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    if (!/%_prog%|\bnode(?:\.exe)?\b/i.test(t)) return null; // a .js target that is not run by node: not an npm shim
    return { target: last, kind: 'node', localNode: /IF EXIST "%(?:~dp0|dp0%)\\?node\.exe"/i.test(t) };
  }
  if (ext === '.exe' || ext === '.com') return { target: last, kind: 'exe', localNode: false };
  // a node script without an extension (a package "bin" such as @xai-official/grok's bin/grok, whose first line is
  // "#!/usr/bin/env node"): npm writes the same node shim for it, so it is run the same way - node <script>
  if (ext === '' && /%_prog%|\bnode(?:\.exe)?\b/i.test(t)) return { target: last, kind: 'node', localNode: /IF EXIST "%(?:~dp0|dp0%)\\?node\.exe"/i.test(t) };
  return null;
}

const enoent = (cmd, args) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', errno: -4058, syscall: 'spawn ' + cmd, path: cmd, spawnargs: args || [] });

// How to start `cmd` without a shell -> {file, args (put before the caller's)} or {error}. On macOS / Linux nothing
// changes: {file: cmd, args: []} and spawn() searches PATH as it always did. On Windows PATH x PATHEXT is searched
// (never the current folder): an .exe / .com is run directly; an npm .cmd shim is read and its JavaScript file run
// with node (process.execPath, or the node.exe next to the shim when the shim prefers it); any other match
// (.bat / .cmd that is not an npm shim, .ps1, ...) is not run - {error} with code EUNSAFECMD says what was found.
// Nothing found: {error} with code ENOENT, like spawn() itself, so the "not installed" messages keep working.
function resolveCmd(cmd, { platform = process.platform, env = process.env, isFile = isFileReal,
  readFile = (f) => fs.readFileSync(f, 'utf8'), execPath = process.execPath } = {}) {
  cmd = String(cmd);
  if (platform !== 'win32') return { file: cmd, args: [] };
  const W = path.win32;
  if (!cmd || cmd.includes('\0') || /["<>|*?\n\r]/.test(cmd)) return { error: enoent(cmd) };
  let exts = String(getEnv(env, 'PATHEXT', platform) || '').split(';').map((e) => e.trim().toLowerCase()).filter((e) => /^\.[a-z0-9]+$/.test(e));
  if (!exts.length) exts = ['.com', '.exe', '.bat', '.cmd'];
  const hasDir = /[\\/]/.test(cmd) || W.isAbsolute(cmd);
  // a path is taken only when it is absolute: "bin\tool" or "C:tool" would be looked up in the current folder
  if (hasDir && !W.isAbsolute(cmd)) return { error: enoent(cmd) };
  if (/^[A-Za-z]:(?![\\/])/.test(cmd)) return { error: enoent(cmd) };
  const dirs = hasDir ? [null] : String(getEnv(env, 'PATH', platform) || '').split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && W.isAbsolute(d)); // a relative entry (".") is never searched
  const own = W.extname(cmd).toLowerCase();
  const names = own && exts.includes(own) ? [cmd] : exts.map((e) => cmd + e); // never the bare name: npm also writes a sh script "claude"
  let unsafe = null;
  for (const dir of dirs) {
    for (const name of names) {
      const f = dir == null ? W.resolve(name) : W.join(dir, name);
      if (!isFile(f)) continue;
      const ext = W.extname(f).toLowerCase();
      if (ext === '.exe' || ext === '.com') return { file: f, args: [] };
      if (ext === '.cmd' || ext === '.bat') {
        let shim = null;
        try { shim = parseCmdShim(readFile(f)); } catch { /* unreadable */ }
        if (shim) {
          const target = W.resolve(W.dirname(f), shim.target);
          if (insideAnyCase(W.dirname(f), target, 'win32') && isFile(target)) {
            if (shim.kind === 'exe') return { file: target, args: [], via: f };
            const local = W.join(W.dirname(f), 'node.exe');
            return { file: shim.localNode && isFile(local) ? local : execPath, args: [target], via: f };
          }
        }
      }
      if (!unsafe) unsafe = f; // keep looking: a real program later in PATH is fine
    }
  }
  if (unsafe) {
    return { error: Object.assign(new Error(`Found ${unsafe}, which can only be run through a command shell - ResearchTool does not do that, for safety. Install the native build of ${cmd} (an .exe), or install it with npm so that its .cmd is a standard npm shim.`),
      { code: 'EUNSAFECMD', path: unsafe }) };
  }
  return { error: enoent(cmd) };
}

// A stand-in for a child process that could not be started: emits 'error' (and 'close', as Node does) on the next
// tick, so callers handle it exactly like a failed spawn().
function failedChild(err) {
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  c.pid = undefined; c.exitCode = null; c.signalCode = null; c.killed = false;
  c.kill = () => false;
  process.nextTick(() => {
    c.exitCode = -2;
    c.emit('error', err);
    c.stdout.end(); c.stderr.end();
    c.emit('close', -2, null);
  });
  return c;
}

// spawn() for every tool the app runs. Same signature; never a shell.
function spawnTool(cmd, args = [], opts = {}, deps = {}) {
  if (opts && opts.shell) throw new Error('spawnTool never uses a shell');
  const platform = deps.platform || process.platform;
  const r = resolveCmd(cmd, { ...deps, env: deps.env || (opts && opts.env) || process.env });
  if (r.error) return failedChild(r.error);
  const o = platform === 'win32' ? { windowsHide: true, ...opts, detached: false } : opts; // detached = a new console window there
  return (deps.spawn || spawn)(r.file, [...r.args, ...args], o);
}

// Stop a child and what it started. Windows: taskkill /T /F (there are no process groups, and every signal is a hard
// kill there anyway); elsewhere `signal` (SIGKILL unless given) to the process group when the child leads one
// (spawned with detached: true), else to the child.
// A child that has already exited is left alone: on Windows its pid may already belong to another process (Node
// closes the process handle at 'exit', before 'close'), and taskkill /T /F would kill that one and its tree.
function killTree(child, { platform = process.platform, group = false, signal = 'SIGKILL', env = process.env, spawnFn = spawn } = {}) {
  if (!child) return;
  if (child.exitCode != null || child.signalCode != null) return;
  // a wrapper that stops its own process tree (lib/ai/child.js AiChild, around a codex / grok / agy process): through
  // its kill(), so it knows it was stopped - a taskkill of its pid would end the CLI with exit code 1 and no signal,
  // which it would report as a failed call (the Stop button showing "Grok could not answer" on Windows)
  if (child.killsOwnTree === true && typeof child.kill === 'function') { try { child.kill(signal); } catch { /* gone */ } return; }
  if (platform === 'win32' && child.pid) {
    const tk = path.win32.join(getEnv(env, 'SystemRoot', platform) || 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const k = spawnFn(tk, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
      return;
    } catch { /* fall through */ }
  }
  if (group && child.pid && platform !== 'win32') { try { process.kill(-child.pid, signal); return; } catch { /* not a group leader */ } }
  try { child.kill(signal); } catch { /* gone */ }
}

// ---------- paths ----------
// Is `p` the folder `root` or inside it? Both are absolute, already resolved paths (realpaths where it matters).
// A plain prefix test with the platform's separator - exactly as strict as before; on Windows the drive letter is
// compared case-blind (c:\ and C:\ are the same drive), the rest of the path exactly (a case difference fails closed).
function inside(root, p, platform = process.platform) {
  root = String(root); p = String(p);
  if (platform === 'win32') {
    const up = (s) => s.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
    root = up(root); p = up(p);
    if (p === root) return true;
    return p.startsWith(/^[A-Z]:\\$/.test(root) ? root : root + '\\');
  }
  return p === root || p.startsWith(root + '/');
}
// The same, case-blind on the case-insensitive file systems of macOS and Windows: for refusals only ("the backup
// folder must not be inside the workspace"), where matching more is the safe side.
function insideAnyCase(root, p, platform = process.platform) {
  if (platform === 'win32') return inside(String(root).replace(/\//g, '\\').toLowerCase(), String(p).replace(/\//g, '\\').toLowerCase(), platform);
  if (platform === 'darwin') return inside(String(root).toLowerCase(), String(p).toLowerCase(), platform);
  return inside(root, p, platform);
}
const samePath = (a, b, platform = process.platform) => (platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
// A path relative to a folder as the API shows it: always with forward slashes.
const toSlash = (rel) => String(rel).split(/[\\/]/).join('/');
// "~" and "~/x" (and "~\x" on Windows) -> the home folder
function expandHome(p, home, platform = process.platform) {
  const re = platform === 'win32' ? /^~(?=[\\/]|$)/ : /^~(?=\/|$)/;
  return String(p || '').replace(re, () => home);
}

// The real path of `p`. Windows: the native realpath, which also expands 8.3 short names (GIT~1 -> .git) and gives
// the case as it is on disk; some volumes make it fail (Google Drive for desktop, RAM disks, some network shares and
// VirtualBox folders: EISDIR / UNKNOWN), and then the JavaScript realpath is used instead. A path that does not
// exist still throws ENOENT. Elsewhere fs.realpathSync as before.
function realpath(p, { platform = process.platform, fsm = fs } = {}) {
  if (platform !== 'win32') return fsm.realpathSync(p);
  try { return fsm.realpathSync.native(p); }
  catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) throw e; return fsm.realpathSync(p); }
}
// The same for a path that may not exist yet (an export or backup folder about to be made): the real path of the
// nearest folder that exists, with the rest appended - so a TEMP path in 8.3 form (C:\Users\RUNNER~1\...) is compared
// in its long form like everything else.
function realpathNear(p, opts = {}) {
  const P = pathOf(opts.platform || process.platform);
  p = P.resolve(String(p));
  const rest = [];
  for (let cur = p; ;) {
    try { return P.join(realpath(cur, opts), ...rest.reverse()); }
    catch {
      const up = P.dirname(cur);
      if (up === cur) return p;
      rest.push(P.basename(cur)); cur = up;
    }
  }
}
// A Claude Code permission rule path for an absolute file ("Read(<this>)"): rules take POSIX form, "//" + the path
// marks an absolute one; on Windows C:\Users\x.png is written //c/Users/x.png (a backslash is a glob escape there).
function claudeRulePath(abs, platform = process.platform) {
  abs = String(abs);
  if (platform !== 'win32') return '/' + abs;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  if (!m) return null; // a UNC or relative path has no such form
  return '//' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
}

// ---------- renaming ----------
// fs.renameSync that waits out the short locks Windows puts on a file that was just written: antivirus (Defender),
// the search indexer, OneDrive / Dropbox hold it for a moment and the rename fails with EPERM / EACCES / EBUSY. Tried
// again for up to ~2 s (as graceful-fs does); other errors, and every error elsewhere, are thrown at once.
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
function renameSync(from, to, { platform = process.platform, fsm = fs, budget = 2000, sleep = sleepSync } = {}) {
  if (platform !== 'win32') return fsm.renameSync(from, to);
  let waited = 0, delay = 10;
  for (;;) {
    try { return fsm.renameSync(from, to); }
    catch (e) {
      if (!e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || waited >= budget) throw e;
      sleep(delay); waited += delay; delay = Math.min(delay * 2, 200);
    }
  }
}

// ---------- file names ----------
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i;
// A file / folder name Windows cannot create or that means something else there: <>:"|?* and control characters
// (":" also opens an alternate data stream), a trailing dot or space (dropped by Windows: "a." is "a", ".. " is ".."),
// device names (CON, NUL, COM1, LPT1 ..., also with an extension).
const winBadName = (s) => /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || WIN_RESERVED.test(s);
const winReserved = (s) => WIN_RESERVED.test(String(s));
// A name the app makes up (a time stamp, a key) made safe for every platform.
function safeFileName(s, fallback = 'file') {
  let n = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/[. ]+$/, '').replace(/^\s+/, '');
  if (!n || n === '.' || n === '..') n = fallback;
  if (WIN_RESERVED.test(n)) n = n.replace(/^([^.]*)/, '$1_');
  return n;
}

// ---------- tool output ----------
const lines = (s) => String(s == null ? '' : s).split(/\r?\n/);
const lf = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n'); // \r\n only: a lone \r stays what it was

// ---------- wording ----------
const credentialStore = (platform = process.platform) =>
  (platform === 'darwin' ? 'the macOS Keychain' : platform === 'win32' ? 'the Windows Credential Manager' : "git's credential helper");
const installGitHint = (platform = process.platform) =>
  (platform === 'darwin' ? 'Install the Xcode command line tools: xcode-select --install'
    : platform === 'win32' ? 'Install Git for Windows (https://git-scm.com/download/win) and start ResearchTool again'
      : 'Install it with your package manager (for example: sudo apt install git)');
const texHint = (platform = process.platform) => (platform === 'darwin' ? 'MacTeX / TeX Live' : platform === 'win32' ? 'TeX Live / MiKTeX' : 'TeX Live');

module.exports = {
  envKey, getEnv, extraPathDirs, buildPath, parseCmdShim, resolveCmd, failedChild, spawnTool, killTree,
  inside, insideAnyCase, samePath, toSlash, expandHome, realpath, realpathNear, claudeRulePath, renameSync,
  winBadName, winReserved, safeFileName, lines, lf,
  credentialStore, installGitHint, texHint,
};
