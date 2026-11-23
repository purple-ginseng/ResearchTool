// Path helpers of the AI test suites (test-ai.js, smoke-server.js), the same on every OS. Windows spells one folder
// several ways: C:\ or c:\, \ or /, the 8.3 short name of a runner's temp folder (C:\Users\RUNNER~1\...) or its long
// name (C:\Users\runneradmin\...), and Claude's rule form //c/Users/... (lib/platform.js claudeRulePath). Every
// helper takes `platform` (and path functions follow it), so the Windows behaviour is unit-tested on macOS / Linux too.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// the real path as the OS reports it: on Windows the native one (long names, not 8.3), as lib/platform.js realpath
function hostReal(p, { platform = process.platform, fsm = fs } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  try { return platform === 'win32' ? fsm.realpathSync.native(p) : fsm.realpathSync(p); } catch { return P.resolve(p); }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every spelling of the given folders (`tops`: e.g. the folder as given and hostReal of it): as given, with / for \,
// and on Windows Claude's rule form without its leading slash (/c/Users/... - so //c/Users/x becomes /<TOP>/x, as the
// '/' + '/var/...' of macOS does).
function spellings(tops, platform = process.platform) {
  const out = new Set();
  for (const t of tops) {
    if (!t) continue;
    out.add(t); out.add(t.replace(/\\/g, '/'));
    const m = platform === 'win32' && /^([A-Za-z]):[\\/](.*)$/.exec(t);
    if (m) out.add('/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/'));
  }
  return [...out].filter((s) => s.length > 1).sort((a, b) => b.length - a.length);
}

// A normaliser for the Claude golden (scripts/fixtures/fake-ai/claude-golden.json, recorded on macOS): every spelling
// of the folders becomes <TOP>; on Windows case-blind (C: / c:, RUNNER~1 / runner~1) and the rest of a path that
// starts there gets / for \ (<TOP>\ws\notes -> <TOP>/ws/notes). Only paths: other text (a prompt's own backslashes)
// stays as it is. On macOS / Linux exactly the plain replacement the golden was recorded with.
function makeNorm(tops, { platform = process.platform, token = '<TOP>' } = {}) {
  const sp = spellings(tops, platform);
  if (!sp.length) return (s) => String(s);
  const re = new RegExp(sp.map(esc).join('|'), platform === 'win32' ? 'gi' : 'g');
  const tail = new RegExp(esc(token) + '[^\\s"\'`()<>|;,*?]*', 'g');
  return (s) => {
    const r = String(s).replace(re, token);
    return platform === 'win32' ? r.replace(tail, (m) => m.replace(/\\/g, '/')) : r;
  };
}

// Is the file `f` inside the folder `dir` (or the folder itself)? Each spelling of f (as given, and hostReal of it)
// must lie in one spelling of dir (as given, hostReal of it); on Windows separators and case do not matter (one
// folder, however it is written) - a file elsewhere is still outside.
function inDir(dir, f, { platform = process.platform, real = (p) => hostReal(p, { platform }) } = {}) {
  if (!f || !dir) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const canon = (p) => (platform === 'win32' ? P.resolve(p).replace(/\//g, '\\').toLowerCase() : P.resolve(p));
  const dirs = [dir, real(dir)].map(canon);
  return [f, real(f)].map(canon).every((x) => dirs.some((d) => x === d || x.startsWith(d.endsWith(P.sep) ? d : d + P.sep)));
}

// The AI CLI a guard log entry (scripts/fixtures/fake-ai/guard.js) started: its cmd, or for a node.exe running an npm
// package's cli.js (Windows: the .cmd shim) the CLI of that package (node_modules/fake-claude/cli.js -> claude).
function guardCli(x) {
  if (!x || x.cmd !== 'node-script') return x && x.cmd;
  const m = /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?(?:fake-)?([a-z]+)[\\/][^\\/]*$/i.exec(String(x.file || ''));
  return m ? m[1].toLowerCase() : 'node-script';
}

module.exports = { hostReal, spellings, makeNorm, inDir, guardCli };
