// An older Claude Code: the feature calls (draft, ask / translate, quiz, diagrams, grouping / briefs, compare,
// writing, key points) pass options that a Claude Code of some months ago does not know yet (--effort,
// --setting-sources, --system-prompt ...). Such a claude stops at once with commander's own message
// ("error: unknown option '--effort'") and the feature failed outright, while the Claude panel - a smaller set of
// options - still worked. Here, in the one place every Claude feature call goes through (lib/ai/index.js run / spawn):
//   - an unknown option (and no answer written): the call runs ONCE more with the compatible set below; from then on
//     this server run uses that set for every feature call (logged once). Decided per call by the argv that call
//     actually used, so calls that ran at the same time each get their own retry.
//   - an --effort value this claude does not offer ("option '--effort <level>' argument 'xhigh' is invalid" - e.g.
//     the level from the user's own Claude Code settings in "Best quality" mode): only --effort with that value is
//     left out (remembered), the rest of the argv stays as it is. (So at most two retries: this one, then the
//     compatible set; never a loop.)
//   - when the compatible set fails the same way too, the call ends with a plain message:
//     'Claude Code needs an update: run "claude update", then try again. Your version (X) does not support ...'
//   - after `claude update` nothing needs a restart: while the compatible set is in use, `claude --version` is asked
//     again at most once a minute, and a new version clears what was remembered.
// The normal argv is never changed: the compatible set is used only after a claude refused an option.
// The compatible set: what the Claude panel passes (-p, --output-format, --verbose, --include-partial-messages,
// --tools, --allowedTools, --append-system-prompt) plus --strict-mcp-config and --model. --tools / --allowedTools are
// passed unchanged, and --strict-mcp-config stays, so that no MCP server of the user's configuration adds tools to a
// call that carries untrusted paper text (it is older than --tools, which the panel already needs; a claude without
// it gets the "update" message, never a looser call).
// Dropped: --effort, --setting-sources, --disable-slash-commands, --no-session-persistence; --system-prompt becomes
// --append-system-prompt. What that changes for the calls (the same as in the Claude panel): Claude Code loads the
// user's and the workspace's settings, hooks and CLAUDE.md files and its own full system prompt (more input tokens
// per call), and it keeps each call as a session (`claude --resume` lists them). The permission rules of those
// settings apply too: a call whose allowed tools are limited to one path (the picture question: Read(//<image>)) is
// therefore never run with the compatible set - it relies on Claude's default "deny the rest", which a user rule
// such as "Read" or a bypassPermissions default mode would open; it gets the "update" message instead.
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const core = require('../core');
const diag = require('../diagnostics');

// commander's messages for an argv it does not accept (the first line of stderr): an unknown option, a value it
// does not offer (an --effort level it does not know), an argument too many (the value of an unknown option).
// Nothing else - not signed in, a usage limit, a network error - ever matches.
const OPTION_ERR = /^error: (?:unknown option '--?[A-Za-z][\w-]*'|too many arguments\b|option '--?[A-Za-z][\w-]*[^'\n]*' argument '[^'\n]*' is invalid)/m;
const VALUE_ERR = /^error: option '(--?[A-Za-z][\w-]*)[^'\n]*' argument '([^'\n]*)' is invalid/m;
const head = (stderr) => String(stderr || '').slice(0, 4000);
const isOptionError = (stderr) => OPTION_ERR.test(head(stderr));
// the options whose refused value may simply be left out (the CLI then uses its own default)
const OPTIONAL_VALUE = new Set(['--effort']);

const DROP = new Set(['--disable-slash-commands', '--no-session-persistence']);
const DROP_WITH_VALUE = new Set(['--effort', '--setting-sources']);
const WITH_VALUE = new Set(['--output-format', '--tools', '--allowedTools', '--disallowedTools', '--model', '--append-system-prompt', '--resume', '--add-dir', '--permission-mode', '--mcp-config']);
function compatArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (DROP.has(a)) continue;
    if (DROP_WITH_VALUE.has(a)) { i++; continue; }
    if (a === '--system-prompt') { out.push('--append-system-prompt', args[++i]); continue; }
    if (WITH_VALUE.has(a)) { out.push(a, args[++i]); continue; } // (a value is never read as a flag: --tools '')
    out.push(a);
  }
  return out;
}
// allowed tools limited to a path ("Read(//...)"): such a call must keep --setting-sources '' (see above)
function pathLimited(args) {
  const i = args.indexOf('--allowedTools');
  return i >= 0 && /\(/.test(String(args[i + 1] || ''));
}

let compat = false; // this server run: the claude on PATH needs the compatible set
const refusedValues = new Map(); // option -> Set of values this claude refused (only OPTIONAL_VALUE options)
let knownVersion = '', lastProbe = 0;
let versionP = null;
function claudeVersion() {
  if (!versionP) {
    versionP = core.run('claude', ['--version'], { env: core.claudeEnv(), timeout: 15000 })
      .then((v) => (v.code === 0 && (/\d+\.\d+\.\d+/.exec(v.out) || [])[0]) || 'unknown', () => 'unknown');
    versionP.then(() => setTimeout(() => { versionP = null; }, 60000).unref());
  }
  return versionP;
}
function clearRemembered() { compat = false; refusedValues.clear(); knownVersion = ''; }
// remember the version a refusal came from; while something is remembered, look again at most once a minute
function noteVersion() { lastProbe = Date.now(); claudeVersion().then((v) => { if (v !== 'unknown') knownVersion = v; }); }
function reprobe() {
  if (!(compat || refusedValues.size) || Date.now() - lastProbe < 60000) return;
  lastProbe = Date.now();
  versionP = null; // (asked anew, not the answer kept for the messages)
  claudeVersion().then((v) => {
    if (v === 'unknown' || !knownVersion || v === knownVersion) return;
    console.warn(`claude is now version ${v} (was ${knownVersion}): the AI features use their normal options again`);
    clearRemembered();
  });
}
const tooOldMessage = (version) => `Claude Code needs an update: run "claude update", then try again. Your version (${version || 'unknown'}) does not support an option ResearchTool uses.`;
const TOO_OLD_RE = /^Claude Code needs an update: run "claude update", then try again\./;
function useCompat(stderr) {
  if (compat) return;
  compat = true;
  noteVersion();
  diag.noteAiError('claude', 'an option was refused, the compatible option set is used from now on: ' + diag.firstLine(stderr));
  claudeVersion().then((v) => console.warn(`claude (version ${v}) does not accept an option of the AI features (${diag.firstLine(stderr).slice(0, 120)}): `
    + 'from now on they use the compatible option set - like the Claude panel they then load your Claude Code settings, hooks and CLAUDE.md files and are kept as sessions'));
}
function rememberValue(opt, value) {
  if (!refusedValues.has(opt)) refusedValues.set(opt, new Set());
  if (refusedValues.get(opt).has(value)) return;
  refusedValues.get(opt).add(value);
  noteVersion();
  console.warn(`claude does not accept ${opt} ${value}: the AI features leave ${opt} out while it is set to that`);
}
// the argv of one try: the values this claude refused left out, then the compatible set if this call uses it
function argvFor(args, useCompatSet) {
  const a = [];
  for (let i = 0; i < args.length; i++) {
    const s = refusedValues.get(args[i]);
    if (s && s.has(args[i + 1])) { i++; continue; }
    a.push(args[i]);
  }
  return useCompatSet ? compatArgs(a) : a;
}
// the state of one call: which argv it used, which retries it had
function startCall(args) { reprobe(); const st = { compat: compat && !pathLimited(args), value: false }; return { st, argv: argvFor(args, st.compat) }; }
// after a try that claude refused (an option error): the argv of the next try, or null = no further try
function nextTry(args, err, st) {
  const v = VALUE_ERR.exec(head(err));
  if (v) {
    const i = args.indexOf(v[1]);
    if (!OPTIONAL_VALUE.has(v[1]) || st.value || i < 0 || args[i + 1] !== v[2]) return null;
    st.value = true;
    rememberValue(v[1], v[2]);
    return argvFor(args, st.compat);
  }
  if (st.compat || pathLimited(args)) return null;
  useCompat(err);
  st.compat = true;
  return argvFor(args, true);
}
const errorEnvelope = (msg) => ({ type: 'result', subtype: 'error', is_error: true, result: msg });
// the first line of what a failed call said, for Help › Copy diagnostics
function noteFailure(code, out, err) {
  let text = '';
  try { const j = JSON.parse(out); if (j && j.is_error) text = String(j.result || ''); } catch { /* not the envelope */ }
  if (!text && code !== 0) text = err || `exit code ${code}`;
  if (text) diag.noteAiError('claude', text);
}

// the last complete JSON line of a stream (its result event), or the whole tail (the envelope of --output-format json)
function lastJson(tail) {
  const lines = String(tail).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) { try { JSON.parse(lines[i]); return lines[i]; } catch { /* not a whole line */ } }
  return tail;
}

// ---- a call that waits for the whole answer (core.run) ----
async function run(args, opts = {}) {
  const { st, argv } = startCall(args);
  let r = await core.run('claude', argv, opts);
  for (;;) {
    if (r.code === 0 || r.code === -1 || (opts.signal && opts.signal.aborted) || !isOptionError(r.err)) { noteFailure(r.code, r.out, r.err); return r; }
    const next = nextTry(args, r.err, st);
    if (!next) break;
    r = await core.run('claude', next, opts);
  }
  const msg = tooOldMessage(await claudeVersion());
  diag.noteAiError('claude', msg);
  return { code: r.code || 1, out: JSON.stringify(errorEnvelope(msg)), err: msg };
}

// ---- a streaming call (core.spawnTool): a child process that looks like the real one to its caller ----
// stdout is passed on as it comes (an option error writes none: once anything came, the call is never repeated);
// stderr is held until the process ends, so that a refused first try leaves no trace for the caller. stdin is kept
// (the prompt) to be written once more to the second try.
class ClaudeChild extends EventEmitter {
  constructor(args, opts) {
    super();
    this.args = args; this.opts = opts;
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.pid = undefined; this.exitCode = null; this.signalCode = null; this.killed = false;
    this.real = null; this.input = []; this.inputDone = false; this.closed = false;
    this.stream = args[args.indexOf('--output-format') + 1] === 'stream-json';
    this.stdin = new Writable({
      write: (c, enc, cb) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c, enc); this.input.push(b); if (this.real) this.real.stdin.write(b); cb(); },
      final: (cb) => { this.inputDone = true; if (this.real) this.real.stdin.end(); cb(); },
    });
    const { st, argv } = startCall(args);
    this.st = st;
    this._launch(argv); // (a spawn that throws reaches the caller, as before)
  }
  kill(signal) {
    this.killed = true;
    if (this.real && this.real.exitCode == null && this.real.signalCode == null) { try { this.real.kill(signal); } catch { /* gone */ } }
    return true;
  }
  _launch(argv) {
    const c = core.spawnTool('claude', argv, this.opts);
    this.real = c; this.pid = c.pid;
    let wrote = false, held = [], heldLen = 0, errored = false, tail = '';
    c.stdin.on('error', () => {});
    for (const b of this.input) c.stdin.write(b);
    if (this.inputDone) c.stdin.end();
    c.stdout.on('data', (d) => { wrote = true; tail = (tail + d).slice(-8000); this.stdout.write(d); });
    c.stderr.on('data', (d) => {
      if (held) { held.push(d); heldLen += d.length; if (heldLen > 64000) { for (const x of held) this.stderr.write(x); held = null; } }
      else this.stderr.write(d);
    });
    c.on('error', (e) => { errored = true; this.emit('error', e); });
    c.on('close', (code, signal) => {
      const err = held ? Buffer.concat(held.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x))))).toString('utf8') : '';
      const refused = !this.killed && !errored && !wrote && code !== 0 && held && isOptionError(err);
      const next = refused ? nextTry(this.args, err, this.st) : null;
      if (next) {
        try { return this._launch(next); } catch (e) { this.emit('error', e); return this._close(-2, null); }
      }
      if (refused) {
        return claudeVersion().then((v) => {
          const msg = tooOldMessage(v);
          diag.noteAiError('claude', msg);
          const env = JSON.stringify(errorEnvelope(msg));
          this.stdout.write(this.stream ? env + '\n' : env);
          this.stderr.write(msg + '\n');
          this._close(this.killed ? null : (code || 1), this.killed ? 'SIGKILL' : null);
        });
      }
      if (held && held.length) this.stderr.write(err);
      if (code !== 0 && !this.killed && !errored) noteFailure(code, lastJson(tail), err);
      this._close(code, signal);
    });
  }
  _close(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code; this.signalCode = code == null ? (signal || 'SIGKILL') : null;
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit('close', code, signal || null)); // after the caller's 'data' handlers
  }
}
const spawn = (args, opts) => new ClaudeChild(args, opts);

module.exports = { run, spawn, compatArgs, isOptionError, tooOldMessage, TOO_OLD_RE, needsCompat: () => compat,
  refusedValues: () => [...refusedValues].flatMap(([o, s]) => [...s].map((v) => `${o} ${v}`)),
  _reset: () => { clearRemembered(); versionP = null; lastProbe = 0; }, _probeDue: () => { lastProbe = 0; } };
