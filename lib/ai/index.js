// The AI provider of the app: which local CLI the AI features run - Claude Code (default), OpenAI Codex, xAI Grok
// Build or Google Antigravity - each signed in with the user's own account. See ARCHITECTURE.md ("lib/ai").
//   settings.json  aiProvider: 'claude' | 'codex' | 'grok' | 'antigravity'   (absent / unknown = 'claude'; so is a
//                  provider no longer offered, such as 'gemini' - Gemini CLI, removed: its aiProviders / aiUseEnvKey
//                  entries are left in the file and ignored)
//                  aiProviders: { codex: {model, categoryModel}, ... }  (Claude keeps the top-level categoryModel)
//                  aiUseEnvKey: { codex: true, ... }  pass that provider's API-key variables on to its CLI (opt-in,
//                  off by default for every provider; a boolean only: the app never stores, asks for or shows a key)
//                  aiPanelEdits: { codex: true }  let that provider's AI panel edit files ("Let Codex edit files",
//                  opt-in, off by default; a boolean only, and only for a provider that declares panelWrite - Codex)
// The features call
//   ai.run(claudeArgs, runOpts, {kind, model, image})    instead of core.run('claude', claudeArgs, runOpts)
//   ai.spawn(claudeArgs, spawnOpts, {kind, stream, partial, model})   instead of core.spawnTool('claude', ...)
// With Claude selected these ARE those calls, with the same arguments (scripts/test-ai.js checks it against a
// snapshot). With another provider the call goes to an AiChild (child.js), which answers in Claude's output format.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../core');
const { AiChild } = require('./child');
const claudeCompat = require('./claude-compat');
const diag = require('../diagnostics');

const PROVIDERS = {
  claude: require('./providers/claude'),
  codex: require('./providers/codex'),
  grok: require('./providers/grok'),
  antigravity: require('./providers/antigravity'),
};
const IDS = Object.keys(PROVIDERS);
const MODEL_RE = /^(?!-)[\w.\-\[\]:/]{1,80}$/; // never option-like
// a conversation id handed back by the browser: hex and '-', never starting with '-' (it goes into argv)
const SESSION_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;

// ---------- the private folder the other CLIs run in ----------
// Outside the workspace, so that no CLI finds the workspace's own .grok / .codex / .agents / .mcp.json / AGENTS.md
// (or those of a folder above it) as "project" configuration: feature calls run in a new empty folder
// run/run-* (removed afterwards), the AI panel in panel/ (kept empty, the same path every time, because a CLI may
// keep its conversations per folder). <os temp>/researchtool-ai-<hash of the workspace path>, mode 0700, owned by
// this user - otherwise (someone else made it, a link, wider rights) a new random folder for this run instead.
// Made when a CLI first needs it (most servers never run another CLI).
const HOME_BASE = path.join(os.tmpdir(), 'researchtool-ai-' + crypto.createHash('sha1').update(core.WS).digest('hex').slice(0, 12));
function ownPrivateDir(d) {
  try {
    const st = fs.lstatSync(d);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (process.platform === 'win32') return true; // the user's own %TEMP%
    return st.uid === process.getuid() && (st.mode & 0o077) === 0;
  } catch { return false; }
}
let home = null;
function aiHome() {
  if (home && ownPrivateDir(home)) return home;
  try { fs.mkdirSync(HOME_BASE, { mode: 0o700 }); } catch { /* there already */ }
  home = ownPrivateDir(HOME_BASE) ? HOME_BASE : fs.mkdtempSync(path.join(os.tmpdir(), 'researchtool-ai-'));
  return home;
}
const tmpRoot = () => path.join(aiHome(), 'run');
const panelDir = () => path.join(aiHome(), 'panel');
// the panel folder holds nothing: whatever is in it (a CLI's own leftovers, a planted .grok) is removed first
function cleanPanelDir(d = panelDir()) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(d)) fs.rmSync(path.join(d, n), { recursive: true, force: true });
  return d;
}
// the folder Codex's write mode runs in (its -C, a writable root of its own): empty, outside the workspace, so that
// the workspace - settings.json, library.json, history/, backups/, its CLAUDE.md and .claude/ - is never writable
const writePanelDir = () => path.join(aiHome(), 'panel-write');

// ---------- the environment of the other CLIs: an allowlist ----------
// Only what a CLI needs to run and to find the user's own sign-in (home, temp, locale, Windows system folders, proxy
// and certificate settings, the provider's own *_HOME), plus the provider's API-key variables when the user opted in.
// Nothing else of the server's environment (AWS_*, GITHUB_TOKEN, other providers' keys, *_SECRET ...) reaches them:
// they run commands the model chooses, and such a command (env, printenv) could show a variable in an answer.
const ENV_ALLOW = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', // (the keyring of a Linux desktop, where a CLI may keep its sign-in)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', '__CF_USER_TEXT_ENCODING']);
// (FAKE_AI_*: the settings of the test suite's fake CLIs, scripts/fixtures/fake-ai - no real CLI reads them)
const envAllowed = (k) => ENV_ALLOW.has(k) || /^LC_[A-Z]+$/.test(k) || /^FAKE_AI_[A-Z]+$/.test(k);

const settings = () => core.loadSettings();
const currentId = (s = settings()) => (IDS.includes(s.aiProvider) ? s.aiProvider : 'claude');
const current = () => PROVIDERS[currentId()];
const provider = (id) => PROVIDERS[id] || null;
// The AI panel may edit files with provider `id`: Claude Code always (file tools only); another provider only when it
// declares panelWrite (Codex: its workspace-write sandbox) AND the user ticked it in Preferences › AI (never by default)
function panelEdits(id, s = settings()) {
  const p = PROVIDERS[id];
  if (!p || id === 'claude' || !p.panelWrite) return false;
  return !!(s.aiPanelEdits && typeof s.aiPanelEdits === 'object' && s.aiPanelEdits[id] === true);
}
// the capabilities as they are in effect: `agentic` (the panel edits files) is true for an opted-in panelWrite
// provider, so every switch that follows it (the panel's read-only note, "Fix with Claude", the guide and tour texts,
// the project snapshot of lib/routes/claude.js) follows the opt-in
const capsOf = (id, s = settings()) => (panelEdits(id, s) ? { ...PROVIDERS[id].caps, agentic: true } : PROVIDERS[id].caps);
const caps = () => capsOf(currentId());
// the panel of the provider chosen now runs in a write mode of its own (not Claude: its panel always edits)
const panelWrites = () => currentId() !== 'claude' && panelEdits(currentId());
// the name of the provider that runs the AI features now ('Claude', 'Codex', 'Grok', 'Antigravity'): what the server
// writes into saved content an AI produced (note history labels, grouping reasons, saved error texts) - captured when
// the call starts, so that the content names the provider that made it
const name = () => current().name;
const nameOf = (id) => (PROVIDERS[id] ? PROVIDERS[id].name : 'Claude');
// the error when the provider's CLI could not be started at all (not installed, not on PATH): names that CLI and where
// to look - the Claude panel's account button for Claude Code, Preferences › AI for the others (no in-app sign-in)
function notStarted() {
  const p = current();
  return p.id === 'claude' ? 'Claude Code could not be started. Open the Claude panel and check the account (person button).'
    : `${p.cliName} could not be started - check in Preferences › AI that it is installed and signed in (${p.bin}).`;
}
// the error of a feature call that failed (r = the {code, out, err} of run(), or null for a streaming call): the CLI
// could not be started at all -> notStarted() with its hint; otherwise "<provider> could not answer: <why>" in the
// provider's own words. `who` is the provider name captured when the call started.
function callFailed(r, why, who = name()) {
  if (r && r.code === -1) return notStarted();
  // (an older Claude Code: its own plain message, never behind "could not answer" - lib/ai/claude-compat.js)
  if (typeof why === 'string' && claudeCompat.TOO_OLD_RE.test(why.trim())) return why.trim();
  const w = String(why == null || why === '' ? 'exit code ' + (r ? r.code : '?') : why).replace(/\s+/g, ' ').trim();
  return `${who} could not answer: ` + (w.length <= 400 ? w : w.slice(0, 400) + ' …');
}
const cfgOf = (id, s = settings()) => (s.aiProviders && typeof s.aiProviders === 'object' && s.aiProviders[id] && typeof s.aiProviders[id] === 'object' ? s.aiProviders[id] : {});
const okModel = (m) => (typeof m === 'string' && MODEL_RE.test(m) ? m : '');
// the model of a non-Claude provider: the user's choice, else the CLI's own default (the app names no models of
// other vendors). Claude's models stay where they were (claudeArgs, top-level categoryModel).
function modelFor(id, { category = false } = {}) {
  const c = cfgOf(id);
  return (category && okModel(c.categoryModel)) || okModel(c.model);
}
// an API key from the environment: only when the user ticked it in Preferences > AI (never by default)
function useEnvKey(id, s = settings()) {
  const v = s.aiUseEnvKey && typeof s.aiUseEnvKey === 'object' ? s.aiUseEnvKey[id] : undefined;
  return id !== 'claude' && v === true;
}
// reasoning effort for the CLIs that take one (Codex config key, Grok --reasoning-effort, Antigravity --effort): as for Claude, low for
// light work and in economy, medium for heavy work in balanced, the CLI's own choice in quality
function effortFor(kind) {
  const mode = core.aiMode();
  if (mode === 'quality') return '';
  return kind === 'light' || mode === 'economy' ? 'low' : 'medium';
}
const noEffort = new Set(); // providers whose CLI refused the effort override once: not sent again

// Environment of a non-Claude child: the allowlist above, the provider's own variables (p.envPass: where it keeps
// its sign-in, an organisation project), its API-key variables only when opted in, plus its fixed settings (no
// auto-update, no colour codes). (Claude's calls keep core.claudeEnv() exactly as before lib/ai: the server's
// environment minus the parent Claude session's variables; `claude` runs no shell tool in this app's feature calls.)
function envFor(p) {
  const keys = useEnvKey(p.id) ? new Set(p.keyVars) : new Set();
  const own = new Set(p.envPass || []);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (envAllowed(K) || own.has(K) || keys.has(K)) env[k] = v;
  }
  return { ...env, NO_COLOR: '1', ...(p.env || {}) };
}
// The version check of a provider with a minimum version (Antigravity: an old agy would run without its read-only
// flags - see providers/antigravity.js): `<bin> --version` before a call, the answer kept for VERSION_TTL (and
// refreshed by every status check). Below the minimum, or no version to read, the CLI is not started. "Not found"
// starts it anyway, so that the call reports "not installed" as for every other provider.
const VERSION_TTL = 10 * 60 * 1000;
const verCache = new Map(); // id -> {at, version}: only versions that passed
function noteVersion(p, version) {
  if (!p.minVersion) return;
  if (version && !p.tooOld(version)) verCache.set(p.id, { at: Date.now(), version }); else verCache.delete(p.id);
}
async function versionGate(p) {
  if (!p.minVersion) return null;
  const c = verCache.get(p.id);
  if (c && Date.now() - c.at < VERSION_TTL) return null;
  fs.mkdirSync(tmpRoot(), { recursive: true });
  const v = await core.run(p.bin, ['--version'], { cwd: tmpRoot(), env: envFor(p), timeout: 15000 });
  if (v.code !== 0) {
    if (/ENOENT|not found|EUNSAFECMD/i.test(v.err)) return null; // (the call itself fails the usual way)
    return p.tooOld('');
  }
  const version = p.versionOf(v);
  noteVersion(p, version);
  return p.tooOld(version);
}
const deps = (p) => ({ spawnTool: core.spawnTool, killTree: core.killTree, env: () => envFor(p), tmpRoot: tmpRoot(), onRetry: (id) => noEffort.add(id), gate: versionGate });
function child(p, o) {
  const opts = { ...o, aiHome: aiHome(), envKey: useEnvKey(p.id), effort: o.mode === 'chat' || noEffort.has(p.id) ? '' : (o.effort ?? effortFor(o.kind)) };
  return new AiChild(p, opts, deps(p));
}

// A feature call that waits for the whole answer. Claude: core.run('claude', args, runOpts) as before (through
// claude-compat.js, which runs it once more with the compatible options when an older claude refuses one).
// Otherwise the same {code, out, err} shape, `out` being Claude's JSON envelope ({result, is_error, usage, ...}).
function run(claudeArgs, runOpts = {}, aiOpts = {}) {
  const p = current();
  if (p.id === 'claude') return claudeCompat.run(claudeArgs, runOpts);
  const { input, timeout = 60000, signal } = runOpts;
  return new Promise((resolve) => {
    const c = child(p, { mode: 'feature', kind: aiOpts.kind || 'light', stream: false, model: aiOpts.model ?? modelFor(p.id), image: aiOpts.image || null });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { core.killTree(c); err += '\n[timed out]'; } }, timeout);
    if (signal) { const kill = () => { if (!done) core.killTree(c); }; if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: -1, out: '', err: String(e) }); });
    c.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      // a provider's own error is reported in words in `err` (the features show `err` when the call failed)
      const r = c.result;
      if (r && r.is_error) diag.noteAiError(p.id, r.result);
      resolve({ code: code == null ? 1 : code, out, err: r && r.is_error ? r.result : err });
    });
    c.stdin.end(input == null ? '' : input);
  });
}

// A streaming feature call (draft, quiz, diagram, grouping). Claude: core.spawnTool('claude', args, spawnOpts), in a
// wrapper that looks the same to the caller (claude-compat.js: once more with the compatible options when an older
// claude refuses one).
function spawn(claudeArgs, spawnOpts, aiOpts = {}) {
  const p = current();
  if (p.id === 'claude') return claudeCompat.spawn(claudeArgs, spawnOpts);
  const c = child(p, { mode: 'feature', kind: aiOpts.kind || 'light', stream: !!aiOpts.stream, partial: !!aiOpts.partial, model: aiOpts.model ?? modelFor(p.id), image: aiOpts.image || null });
  c.once('close', () => { if (c.result && c.result.is_error) diag.noteAiError(p.id, c.result.result); });
  return c;
}

// The AI panel with a non-Claude provider: a read-only chat in the workspace (lib/routes/claude.js) - or, for Codex
// with "Let Codex edit files" ticked, a chat in its workspace-write sandbox (`write`; providers/codex.js). The context
// the panel adds (open paper, project, teaching style) is `system`, sent ahead of the message on stdin.
// Read-only: Codex runs in the workspace itself (-C, its read-only sandbox, user config and rules ignored); Grok and
// Antigravity run in the empty panel folder and get the workspace (and an external project) as an added read-only
// folder, so that the workspace's own CLI configuration is never loaded.
// Write mode: Codex runs in an empty folder of its own (writePanelDir) and `addDirs` are its only other writable
// roots - the route passes the open project's folder and the notes folder, each checked (P.aiRoot). The workspace is
// never one: it still reads it (the sandbox reads everywhere), but it cannot change the app's data, the settings
// that name the external projects, the history and backups, or the agent files Claude Code loads there.
// (`write`: the mode the route took when the request came - the same for its note, snapshot and argv; left out, the
// settings now. Only ever for a provider that declares panelWrite.)
function spawnChat({ system, session, addDirs = [], write }) {
  const p = current();
  if (session != null && !SESSION_RE.test(String(session))) session = null;
  const inWs = !!p.chatInWorkspace;
  write = write === undefined ? panelEdits(p.id) : !!write && !!p.panelWrite;
  if (write) {
    let ws = core.WS; try { ws = core.plat.realpath(ws); } catch { /* keep */ }
    // (never the workspace or a folder that holds it, whatever the caller passed)
    const roots = addDirs.filter((d) => typeof d === 'string' && path.isAbsolute(d) && !core.plat.insideAnyCase(d, ws) && !core.plat.insideAnyCase(d, core.WS));
    return child(p, { mode: 'chat', stream: true, partial: true, cwd: cleanPanelDir(writePanelDir()), system, session: session || null,
      addDirs: roots, model: modelFor(p.id), write: true });
  }
  return child(p, { mode: 'chat', stream: true, partial: true, cwd: inWs ? core.WS : cleanPanelDir(), system, session: session || null,
    addDirs: inWs ? addDirs : [core.WS, ...addDirs], model: modelFor(p.id) });
}
// where the panel's CLI runs, for the context the panel writes ("its files, relative to ..."): null = the workspace
// (Claude; Codex read-only), else the workspace's path is named (Grok, Antigravity, Codex's write mode)
const chatRoot = (write = panelWrites()) => (current().id === 'claude' || (current().chatInWorkspace && !write) ? null : core.WS);
const READ_ONLY_NOTE = 'You run in a read-only sandbox inside ResearchTool: you can read the files named here but you cannot change any file. When the user asks for a change, show it as text (the new passage, or a short diff) and say that it was not applied; never claim that a file was changed.';
// the panel in write mode (Codex opted in): it has a shell, so the rules are spelled out. The sandbox lets it write
// only the open project and the notes folder (lib/routes/claude.js puts agent files there back as they were).
const WRITE_NOTE = 'You run in a sandbox inside ResearchTool that lets you change only the files of the open LaTeX project and the user\'s reading notes (the notes folder of the workspace); everything else, the workspace included, is read-only, and the network is off. Change only the files the user asks about: those of the open project, or a reading note when asked. Never delete or rename a file unless the user asks for it. Never touch library.json, settings.json, pdfs/, sentences/, cache/, history/, history-notes/, backups/, trash/ or any other data of the app, and never create or change agent files (CLAUDE.md, AGENTS.md, .claude/, .codex/, .mcp.json): the app undoes such changes. Do not run git. After a change, say in one or two sentences which files you changed.';

// ---------- status: installed, version, signed in - never a model call ----------
async function status(id, { fresh = false } = {}) {
  const p = PROVIDERS[id];
  if (!p) throw core.httpErr(400, 'Unknown AI provider');
  try {
    if (id === 'claude') {
      const s = await require('../routes/account').status();
      return { id, installed: !!s.installed, version: s.version || '', signedIn: s.unknown ? null : !!s.loggedIn, account: s.email || '', problem: s.problem };
    }
    const env = envFor(p);
    // in the empty panel folder: never the app folder (a git repository) nor the workspace (its own CLI config)
    const run = (cmd, args, o) => core.run(cmd, args, { cwd: cleanPanelDir(), ...o });
    const st = await p.status({ run, env, keyKept: useEnvKey(id), fresh });
    if (p.minVersion && st.installed) noteVersion(p, st.version);
    return { id, ...st };
  } catch (e) { return { id, installed: false, signedIn: null, problem: String(e.message || e).slice(0, 300) }; }
}
const statusAll = async (o) => Object.fromEntries(await Promise.all(IDS.map(async (id) => [id, await status(id, o)])));

// what the front end needs to know about the providers (no secrets: none are kept)
function info() {
  const s = settings();
  return {
    current: currentId(s),
    providers: IDS.map((id) => {
      const p = PROVIDERS[id];
      // caps: in effect (agentic follows the opt-in); panelWrite: the provider offers "Let ... edit files"
      return { id, label: p.label, name: p.name, cliName: p.cliName, bin: p.bin, vendor: p.vendor, caps: capsOf(id, s), install: p.install, docs: p.docs, login: p.login, loginNote: p.loginNote || '', configNote: p.configNote || '',
        keyVars: p.keyVars, useEnvKey: useEnvKey(id, s), panelWrite: !!p.panelWrite, panelEdits: panelEdits(id, s), model: id === 'claude' ? '' : okModel(cfgOf(id, s).model), categoryModel: id === 'claude' ? (okModel(s.categoryModel) || '') : okModel(cfgOf(id, s).categoryModel) };
    }),
  };
}

// PUT /api/settings: the AI keys of the body, checked, written into the settings object `s`
function configure(s, b) {
  if ('aiProvider' in b) {
    if (!IDS.includes(b.aiProvider)) throw core.httpErr(400, `aiProvider must be one of ${IDS.join(', ')}`);
    if (b.aiProvider === 'claude') delete s.aiProvider; else s.aiProvider = b.aiProvider;
  }
  if ('aiProviders' in b) {
    if (!b.aiProviders || typeof b.aiProviders !== 'object' || Array.isArray(b.aiProviders)) throw core.httpErr(400, 'aiProviders must be an object');
    const cur = s.aiProviders && typeof s.aiProviders === 'object' ? { ...s.aiProviders } : {};
    for (const [id, v] of Object.entries(b.aiProviders)) {
      if (!IDS.includes(id) || id === 'claude') throw core.httpErr(400, 'aiProviders: unknown provider ' + String(id).slice(0, 20));
      if (!v || typeof v !== 'object') throw core.httpErr(400, 'aiProviders.' + id + ' must be an object');
      const next = { ...(cur[id] || {}) };
      for (const k of ['model', 'categoryModel']) {
        if (!(k in v)) continue;
        if (v[k] === '' || v[k] == null) { delete next[k]; continue; }
        if (!okModel(v[k])) throw core.httpErr(400, `aiProviders.${id}.${k} must be a model name (letters, digits, . - _ : / [ ])`);
        next[k] = v[k];
      }
      if (Object.keys(next).length) cur[id] = next; else delete cur[id];
    }
    if (Object.keys(cur).length) s.aiProviders = cur; else delete s.aiProviders;
  }
  if ('aiUseEnvKey' in b) {
    if (!b.aiUseEnvKey || typeof b.aiUseEnvKey !== 'object' || Array.isArray(b.aiUseEnvKey)) throw core.httpErr(400, 'aiUseEnvKey must be an object');
    const cur = s.aiUseEnvKey && typeof s.aiUseEnvKey === 'object' ? { ...s.aiUseEnvKey } : {};
    for (const [id, v] of Object.entries(b.aiUseEnvKey)) {
      if (!IDS.includes(id) || id === 'claude') throw core.httpErr(400, 'aiUseEnvKey: unknown provider');
      if (typeof v !== 'boolean') throw core.httpErr(400, 'aiUseEnvKey values must be true or false');
      cur[id] = v;
    }
    s.aiUseEnvKey = cur;
  }
  if ('aiPanelEdits' in b) {
    if (!b.aiPanelEdits || typeof b.aiPanelEdits !== 'object' || Array.isArray(b.aiPanelEdits)) throw core.httpErr(400, 'aiPanelEdits must be an object');
    const cur = s.aiPanelEdits && typeof s.aiPanelEdits === 'object' ? { ...s.aiPanelEdits } : {};
    for (const [id, v] of Object.entries(b.aiPanelEdits)) {
      // (Claude's panel always edits; Grok and Antigravity stay read-only: they declare no panelWrite)
      if (!IDS.includes(id) || id === 'claude' || !PROVIDERS[id].panelWrite) throw core.httpErr(400, 'aiPanelEdits: this provider cannot edit files in the AI panel: ' + String(id).slice(0, 20));
      if (typeof v !== 'boolean') throw core.httpErr(400, 'aiPanelEdits values must be true or false');
      if (v) cur[id] = true; else delete cur[id];
    }
    if (Object.keys(cur).length) s.aiPanelEdits = cur; else delete s.aiPanelEdits;
  }
}

// Folders of calls that never finished (the server was stopped mid-call): removed at start (and the folder of
// earlier versions inside the workspace)
// (the private folder only when it is this user's own - never through a link someone else put there)
for (const d of [ownPrivateDir(HOME_BASE) ? path.join(HOME_BASE, 'run') : null, path.join(core.DIRS.cache, 'ai-tmp')]) {
  if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* removed next time */ } }
}

module.exports = { claudeCompat, PROVIDERS, IDS, MODEL_RE, SESSION_RE, chatRoot, currentId, current, provider, caps, capsOf, panelEdits, panelWrites, name, nameOf, notStarted, callFailed, modelFor, useEnvKey, effortFor, envFor,
  run, spawn, spawnChat, READ_ONLY_NOTE, WRITE_NOTE, status, statusAll, info, configure };
// the private folder and its parts (made on first use)
Object.defineProperties(module.exports, { AI_HOME: { get: aiHome, enumerable: true }, TMP_ROOT: { get: tmpRoot, enumerable: true }, PANEL_DIR: { get: panelDir, enumerable: true }, WRITE_PANEL_DIR: { get: writePanelDir, enumerable: true } });
