// The test suites' guard against a real AI CLI: loaded BEFORE anything requires node:child_process (test-ai.js
// requires it first; smoke-server.js starts the server as `node -r guard.js server.js`), it wraps spawn / spawnSync /
// execFile / execFileSync of node:child_process. Every start of claude / codex / gemini / grok / agy is resolved first
// (the absolute path given, or the first executable match on the child's PATH) and REFUSED - an exception, nothing
// is started - unless it lies in the fakes' folder $FAKE_AI_BIN. On Windows a node.exe that runs a script of a
// node_modules folder (an npm .cmd shim resolved by lib/platform.js) must run one of the fakes' folder as well. Every
// AI start (and every refusal) is logged to $FAKE_AI_GUARD_LOG (JSON lines), so a suite can assert that every call
// resolved to a fake.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const AI = new Set(['claude', 'codex', 'gemini', 'grok', 'agy']);
const BIN = process.env.FAKE_AI_BIN ? path.resolve(process.env.FAKE_AI_BIN) : null;
const LOG = process.env.FAKE_AI_GUARD_LOG || null;
const WIN = process.platform === 'win32';
if (!BIN) throw new Error('guard.js: FAKE_AI_BIN is not set');

const real = (f) => { try { return fs.realpathSync(f); } catch { return path.resolve(f); } };
const BIN_REAL = real(BIN);
const inBin = (f) => [path.resolve(f), real(f)].every((x) => [BIN, BIN_REAL].some((b) => x === b || x.startsWith(b + path.sep)));
const baseName = (f) => path.basename(String(f)).toLowerCase().replace(/\.(exe|cmd|bat|ps1|com|js)$/, '');
function envPath(env) {
  const e = env || process.env, k = Object.keys(e).find((x) => x.toUpperCase() === 'PATH');
  return k ? String(e[k] || '') : '';
}
function which(file, env) {
  if (path.isAbsolute(file)) return file;
  if (/[\\/]/.test(file)) return path.resolve(file);
  const exts = WIN ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  for (const d of envPath(env).split(path.delimiter)) {
    if (!d) continue;
    for (const x of exts) {
      const f = path.join(d, file + x);
      try { if (fs.statSync(f).isFile()) { if (!WIN) fs.accessSync(f, fs.constants.X_OK); return f; } } catch { /* next */ }
    }
  }
  return null;
}
const log = (o) => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch { /* the suite reports it */ } } };

function check(file, args, opts) {
  const name = baseName(file);
  let ai = AI.has(name) ? name : null, target = null;
  // Windows: node.exe running the cli.js of an npm package (the .cmd shim of a global install)
  if (!ai && name === 'node' && Array.isArray(args) && typeof args[0] === 'string' && /[\\/]node_modules[\\/]/i.test(args[0])) { ai = 'node-script'; target = args[0]; }
  if (!ai) return;
  const resolved = target ? path.resolve(target) : which(String(file), opts && opts.env);
  const ok = resolved == null || inBin(resolved); // (not found at all: nothing can start)
  log({ cmd: ai, file: resolved, ok });
  if (!ok) throw new Error(`fake-ai guard: refused to start ${ai} at ${resolved} - outside the fakes' folder ${BIN}`);
}
// (args and options may be left out: spawn(file, opts))
const split = (args, opts) => (Array.isArray(args) ? [args, opts] : [[], args]);
for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const orig = cp[fn];
  cp[fn] = function guarded(file, a, o, ...rest) { const [args, opts] = split(a, o); check(file, args, opts); return orig.call(this, file, a, o, ...rest); };
}
// a shell would hide what it starts: the suites never need one
for (const fn of ['exec', 'execSync']) {
  const orig = cp[fn];
  cp[fn] = function guarded(command, ...rest) {
    if ([...AI].some((n) => new RegExp(`(^|[\\s/\\\\;&|"'])${n}(\\.exe|\\.cmd)?([\\s"';&|]|$)`, 'i').test(String(command)))) { log({ cmd: 'shell', file: String(command).slice(0, 200), ok: false }); throw new Error('fake-ai guard: refused a shell command naming an AI CLI'); }
    return orig.call(this, command, ...rest);
  };
}
module.exports = { BIN, LOG, inBin };
