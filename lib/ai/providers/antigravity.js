// Google Antigravity CLI (`agy`; official installer https://antigravity.google/cli/install.sh, Windows install.ps1),
// signed in with the user's Google account (run `agy` once in a terminal; Google OAuth for a personal account, or a
// Google Cloud project). This is the way a personal Google account works with ResearchTool: Gemini CLI no longer
// serves personal accounts (2026-06-18). Researched on agy 1.5.14: its --help, its changelog and the official docs
// (antigravity.google/docs: headless, permissions, modes, install). Checked against the real agy 1.5.14: --version,
// a bare -p and --settings without a prompt, and one short greeting turn (scripts/fixtures/fake-ai/agy-1.5.14-turn.jsonl);
// no other model turn was run, and no tool step was ever seen.
//   feature call: agy --input-format stream-json --output-format stream-json --mode plan --sandbox
//                 --disable-slash-commands --print-timeout 600s --settings <FEATURE settings> [--model M]
//                 [--effort low|medium] -p                                         cwd: an empty temp folder
//   panel:        agy --input-format stream-json --output-format stream-json --mode plan --sandbox
//                 --disable-slash-commands --print-timeout 1200s --settings <CHAT settings> --add-dir <ws>
//                 [--add-dir <external project>] [--conversation <id>] [--model M] -p
//                 cwd: the empty panel folder
// -p "" is the LAST pair: agy 1.5.14 requires a value for -p ("flag needs an argument: -p", checked with the real
// agy) and, with --input-format stream-json, reads the prompt from stdin; an empty value carries nothing. Last, so
// an agy before 1.1.18 (which took a valueless -p's next argument as the prompt) cannot swallow a safety flag. And agy older than MIN_VERSION is never started at all: every call first
// checks `agy --version` (lib/ai/index.js versionGate; changelog: --disable-slash-commands 1.1.9, --mode honoured in
// -p only since 1.1.12, --input-format stream-json 1.1.15, finished_reason 1.4.11, AGY_ERROR + exit 3 1.5.0, retried
// successes reported as ERROR until 1.5.13).
// The prompt: stdin, one NDJSON line {"event":"user","message":{"content":"<text>"}} (docs, headless: with
// --input-format stream-json the prompt comes on stdin and a -p value would be dropped). Never in argv.
// Output (stream-json, each event's data nested under its name, see line()): init {cwd, tools, permission_mode, model?}, step_update {conversation_id, step_index, state,
// step_type: user_input|agent_response|tool|checkpoint, tool_name?, text_delta?, usage?, tool_info?},
// result {conversation_id, status: SUCCESS|ERROR|CANCELED|INTERRUPTED|..., response, error?, usage: {input_tokens,
// output_tokens, thinking_tokens, cache_read_tokens, total_tokens}, finished_reason?, denied_actions?}.
// A turn that fails ends with exit code 3 and an `AGY_ERROR: {...}` line on stderr; --print-timeout expiring too.
// Read-only does not rest on one setting:
//   (1) --settings (this session only, never saved) denies every action kind of the permission system: command(*),
//       write_file(*), read_url(*), execute_url(*), mcp(*) - and read_file(*) in a feature call, which needs no tool.
//       Deny beats ask and allow (docs, permissions), so the user's own allow rules cannot lift it.
//       toolPermission "request-review": nothing runs without approval, and headless -p soft-denies what needs one.
//       The rules go under "permissions" only: agy 1.5.14 refuses an unknown key ("--settings: unknown setting
//       \"permission\"", checked with the real agy, no prompt) and then reports permission_mode "request-review".
//   (2) --mode plan (also agentMode in --settings): NOT a read-only guarantee in print mode - the changelog says
//       headless runs "proceed through plan review automatically" - which is why (1) and (5) are there.
//   (3) --sandbox: terminal commands in the OS sandbox (which also blocks ~/.config, ~/Library/Application Support).
//   (4) an empty folder outside the workspace (project rules, .agents/ of the workspace are never loaded); the
//       workspace is an --add-dir in the panel only.
//   (5) a tool step naming a path outside the folders of the call (the run folder; in the panel the workspace and
//       the added folders) stops the call at once (line()): a user's own "Non-Workspace Access", read_file allow
//       rule, hook or plugin cannot make the panel read ~/.ssh or ~/.gemini unnoticed. (The step is reported when
//       it starts; whether agy has already read the file by then is UNVERIFIED - the answer is never used.)
//   Never --dangerously-skip-permissions, --mode auto (reads outside the workspace without asking) or accept-edits.
// Fail closed: the init event must come first and name a permission mode that asks (request-review / strict);
// anything else - no init, a missing permission_mode, "always-proceed", the agent mode instead of the tool
// permission - stops the run before any text reaches the caller; so does a stderr notice that the sandbox, the
// --mode or the --settings were not applied (unsafe()), which stops whatever has not been shown yet.
// "@" followed by a character could be read as a file mention (agy offers mentions after "(" or any character too,
// changelog): a word joiner (U+2060) goes after EVERY such "@" and is taken out of the answer again. Whether agy
// parses mentions in stream-json input at all, and whether U+2060 stops it, is UNVERIFIED.
// "/word" is never a slash command (--disable-slash-commands).
// Status: `agy --version` only. ResearchTool does not check the sign-in (that would mean starting agy: print mode
// answers "/usage" without a model turn per the changelog, but that is unverified and not used), so signedIn is
// null - it shows at the first call - unless an opted-in GEMINI_API_KEY is there. The user's own agy folders
// (~/.gemini/antigravity, ~/.gemini/antigravity-cli, ~/.gemini/config) are never read; only whether the second exists.
// Seen with the real agy 1.5.14: the settings keys agentMode, toolPermission and permissions are accepted (an unknown
// key is refused), init then reports permission_mode "request-review", the events are nested, the conversation id is
// a UUID. UNVERIFIED (no real run has tested them): that each deny rule refuses its action (the rule kinds read_file /
// write_file / read_url; command, mcp, execute_url are documented), the stdin message shape {"event":"user",
// "message":{"content"}} beyond a plain prompt, the other permission_mode values, the stderr texts of unsafe(), the
// fields of a tool step, whether user hooks / plugins (~/.gemini/config) can approve what --settings denies. A check
// without a model turn: `agy -p "/permissions" --settings '<settingsJson()>' --output-format json`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tail, notInstalled } = require('./codex');

const DENY_ALWAYS = ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
function settingsJson({ mode, apiKey }) {
  const deny = mode === 'chat' ? DENY_ALWAYS : [...DENY_ALWAYS, 'read_file(*)'];
  const rules = { allow: [], ask: [], deny };
  return JSON.stringify({ agentMode: 'plan', toolPermission: 'request-review', permissions: rules, ...(apiKey ? { modelProvider: 'gemini' } : {}) });
}
const SAFE_MODES = new Set(['request-review', 'strict']);
const MIN_VERSION = '1.5.13';
const verParts = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || []).slice(1).map(Number);
// a message when this agy must not be started (too old, or its version unknown), else null
function tooOld(version) {
  const v = verParts(version), m = verParts(MIN_VERSION);
  if (v.length !== 3) return 'ResearchTool could not tell which version of Antigravity is installed, so it did not start it. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.';
  for (let i = 0; i < 3; i++) { if (v[i] > m[i]) return null; if (v[i] < m[i]) return `Antigravity ${v.join('.')} is too old for ResearchTool (it needs ${MIN_VERSION} or later to run read-only). Update Antigravity (agy update), then try again.`; }
  return null;
}
const versionOf = (v) => (`${v.out || ''}\n${v.err || ''}`.match(/\d+\.\d+\.\d+/) || [''])[0];
// a conversation id that can go into argv later (lib/ai/index.js SESSION_RE): others are not offered for resume
const CONV_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
// every absolute path a tool step names (its parameters)
function pathsOf(ti, ev) {
  const out = [], p = (ti && (ti.parameters || ti.params)) || {};
  const add = (k, v) => { if (typeof v === 'string' && /path|file|dir|uri|target|cwd|root/i.test(k)) out.push(v); else if (Array.isArray(v)) v.forEach((x) => add(k, x)); };
  for (const [k, v] of Object.entries(p)) add(k, v);
  if (ev && typeof ev.path === 'string') out.push(ev.path);
  return out;
}
function inside(f, roots, cwd) {
  let s = String(f).replace(/^file:\/\//i, '');
  if (s.startsWith('~')) return false; // the user's home: never one of the folders of a call
  if (!path.isAbsolute(s)) s = path.resolve(cwd || '/', s);
  const cand = [path.resolve(s)]; try { cand.push(fs.realpathSync(s)); } catch { /* not there */ }
  const rs = []; for (const r of roots) { if (!r) continue; rs.push(path.resolve(r)); try { rs.push(fs.realpathSync(r)); } catch { /* gone */ } }
  return cand.every((c) => rs.some((r) => c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)));
}
const WJ = '⁠';
const unWj = (s) => String(s).split(WJ).join('');
const agyDir = () => path.join(os.homedir(), '.gemini', 'antigravity-cli');
function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const inp = Number(u.input_tokens) || 0, cached = Number(u.cache_read_tokens) || 0;
  return { in: Math.max(0, inp - cached), cached, out: (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0) };
}
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : String(e.message || e.status || JSON.stringify(e)));
const OLD_FLAGS = 'This version of Antigravity does not know the options ResearchTool runs it with read-only, so ResearchTool stopped the call. Update Antigravity (agy update), then try again.';
const SIGN_IN = 'Not signed in to Antigravity. Run “agy” in a terminal and sign in with Google, then try again.';
const LIMIT_RE = /RESOURCE_EXHAUSTED|quota|usage limit|rate limit|out of credits|credits balance|\b429\b/i;

module.exports = {
  id: 'antigravity',
  label: 'Antigravity',
  name: 'Antigravity',
  cliName: 'Antigravity CLI',
  bin: 'agy',
  vendor: 'Google',
  caps: { readsPdf: false, readsImage: false, sessions: true, agentic: false, partial: true, inAppLogin: false },
  // a Gemini API key, or Application Default Credentials: only when the user ticks the option (off by default)
  keyVars: ['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_QUOTA_PROJECT'],
  envPass: ['GOOGLE_CLOUD_LOCATION'],
  install: { mac: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', win: 'irm https://antigravity.google/cli/install.ps1 | iex' },
  docs: 'https://antigravity.google/docs/getting-started?tab=cli',
  login: 'agy',
  loginNote: 'Run “agy” once in a terminal and sign in with Google (a personal Google account works). ResearchTool cannot check the sign-in without a call: it shows at the first one.',
  // no logo, no terminal status escapes in the output
  env: { AGY_CLI_HIDE_LOGO: '1', AGY_CLI_OSC7501: 'off' },
  format: () => 'lines',
  minVersion: MIN_VERSION,
  tooOld,
  versionOf,
  // an --effort the chosen model does not take: once more without it (the text is a guess: UNVERIFIED)
  retryWithoutEffort: (err) => /--effort|(unknown|invalid|unsupported) (thinking )?effort|effort .{0,40}(not supported|unsupported|invalid)/i.test(err),

  args({ mode, model, effort, session, addDirs = [], envKey }) {
    const apiKey = !!(envKey && process.env.GEMINI_API_KEY);
    const head = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--sandbox', '--disable-slash-commands'];
    const m = model ? ['--model', model] : [];
    // -p last: see the header (an agy before 1.1.18 would take the next flag as the prompt)
    if (mode === 'chat') {
      return [...head, '--print-timeout', '1200s', '--settings', settingsJson({ mode, apiKey }), ...addDirs.flatMap((d) => ['--add-dir', d]),
        ...(session ? ['--conversation', session] : []), ...m, '-p', ''];
    }
    return [...head, '--print-timeout', '600s', '--settings', settingsJson({ mode, apiKey }), ...m, ...(effort ? ['--effort', effort] : []), '-p', ''];
  },
  stdin: (text) => JSON.stringify({ event: 'user', message: { content: String(text).replace(/@(?=\S)/g, `@${WJ}`) } }) + '\n',
  settingsJson,

  // stderr that means the read-only setup is not in effect: the run is stopped (child.js)
  unsafe(err) {
    if (/turn(s|ed|ing)? off the (terminal )?sandbox|sandbox (is |was )?(not available|unavailable|disabled|not supported|not applied|off\b)|sandbox (could|can)(not|n't) (be )?(start|run|appl|enabl)|without (an? |the )?(OS |terminal )?sandbox|no OS sandbox/i.test(err)) {
      return 'Antigravity could not run with its sandbox on this computer, so ResearchTool stopped the call (it needs the OS sandbox: macOS, Linux with user namespaces, Windows 11 24H2 or later). Choose another AI provider in Preferences › AI.';
    }
    // an agy that does not know one of the flags (Go flag parsing; an old agy) - it exits anyway; the update hint
    if (/flag provided but not defined|unknown (flag|shorthand flag)|flag needs an argument/i.test(err)) return OLD_FLAGS;
    if (/--settings.{0,80}(invalid|malformed|ignored|unknown|could not|failed)|(invalid|unknown|unrecognized) (permission )?(rule|setting|key)|(--mode|mode) .{0,40}(ignored|unrecognized|invalid|not (applied|available))|falling back to (the )?(default|auto) mode|always-proceed/i.test(err)) {
      return 'Antigravity did not accept ResearchTool\'s read-only settings, so ResearchTool stopped the call. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.';
    }
    return null;
  },

  line(ev, st, emit) {
    if (!ev || typeof ev !== 'object') return;
    // agy 1.5.14 nests each event's data under its name: {"event":"init","conversation_id":…,"init":{cwd,
    // permission_mode}}, {"event":"step_update","step_update":{…,text_delta,usage}}, {"event":"result","result":
    // {status,response,usage,…}} (seen in a real run). Flatten it; a flat event is read as it is.
    if (typeof ev.event === 'string' && ev[ev.event] && typeof ev[ev.event] === 'object' && !Array.isArray(ev[ev.event])) {
      ev = { ...ev[ev.event], type: ev.event, ...(ev.conversation_id && !ev[ev.event].conversation_id ? { conversation_id: ev.conversation_id } : {}) };
    }
    const kind = ev.type || ev.event;
    if (kind === 'init') {
      // fail closed: the permission mode agy reports must be one that asks (and so, headless, refuses)
      if (st.initOk) return;
      if (ev.permission_mode == null || ev.permission_mode === '') {
        st.unsafe = 'Antigravity did not report the permission mode it runs in, so ResearchTool stopped the call before using its answer. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.';
      } else if (!SAFE_MODES.has(String(ev.permission_mode))) {
        st.unsafe = `Antigravity started with the permission mode “${String(ev.permission_mode).slice(0, 40)}” instead of asking for approval, so ResearchTool stopped the call before using its answer. Choose another AI provider in Preferences › AI.`;
      } else st.initOk = true;
      return;
    }
    // nothing counts before a valid init: a step or a result first means the read-only check never happened
    if (!st.initOk) {
      if (kind === 'step_update' || kind === 'result') st.unsafe = 'Antigravity answered without first reporting the permission mode it runs in, so ResearchTool stopped the call before using its answer. Update Antigravity (agy update) or choose another AI provider in Preferences › AI.';
      return;
    }
    if (ev.conversation_id && !st.session && CONV_RE.test(String(ev.conversation_id))) emit({ type: 'session', id: String(ev.conversation_id) });
    if (kind === 'step_update' && ev.step_type === 'tool' && st.roots) {
      const ti = ev.tool_info || {};
      const out = pathsOf(ti, ev).filter((f) => !inside(f, st.roots, st.cwd));
      if (out.length) {
        st.unsafe = 'Antigravity tried to use a file outside the folders ResearchTool gave it, so ResearchTool stopped the call before using its answer. Check your Antigravity settings (Non-Workspace Access, allow rules, hooks) or choose another AI provider in Preferences › AI.';
        return;
      }
    }
    if (kind === 'step_update') {
      if (ev.step_type === 'agent_response' && typeof ev.text_delta === 'string' && ev.text_delta) {
        const t = unWj(ev.text_delta); st.deltaText = (st.deltaText || '') + t; emit({ type: 'delta', text: t });
      } else if (ev.step_type === 'tool' && ev.state !== 'DONE') {
        const ti = ev.tool_info || {}, p = ti.parameters || ti.params || {};
        emit({ type: 'tool', name: String(ev.tool_name || ti.name || 'tool'), detail: String(p.path || p.file_path || p.AbsolutePath || p.pattern || '').slice(0, 200) });
      }
    } else if (kind === 'result') {
      const ok = String(ev.status || '').toUpperCase() === 'SUCCESS' && !ev.finished_reason;
      if (ev.finished_reason) st.finishedReason = String(ev.finished_reason);
      if (!ok) {
        st.errors.push(errText(ev.error) || `Antigravity ended the turn with status ${ev.status || 'unknown'}${ev.finished_reason ? ` (${ev.finished_reason})` : ''}`);
        emit({ type: 'final', isError: true, error: undefined, usage: usageOf(ev.usage) });
        return;
      }
      const resp = typeof ev.response === 'string' ? unWj(ev.response) : '';
      if (resp && resp.trim() !== String(st.deltaText || '').trim()) emit({ type: 'message', text: resp });
      emit({ type: 'final', isError: false, usage: usageOf(ev.usage) });
    }
  },
  // (no json(): stream-json input needs stream-json output, format() is always 'lines')

  failure({ code, err, out, resumed, st }) {
    const all = `${(st && st.errors.join('\n')) || ''}\n${err}\n${out}`;
    let agy = null;
    const m = /AGY_ERROR:\s*(\{.*\})/.exec(err || '');
    if (m) { try { agy = JSON.parse(m[1]); } catch { /* text only */ } }
    const canon = agy ? `${agy.status || agy.canonical_status || agy.code || ''} ${agy.http_status || agy.http_code || ''} ${agy.message || ''}` : '';
    const both = `${canon}\n${all}`;
    if (/flag provided but not defined|unknown (flag|shorthand flag)|flag needs an argument/i.test(both)) return { text: OLD_FLAGS };
    if (resumed && /conversation.{0,60}(not found|does not exist|unknown|no longer)|no (such )?conversation|could not (find|load) (the )?conversation/i.test(both)) return { lost: true, text: 'This conversation is not known to Antigravity any more.' };
    if (/UNAUTHENTICATED|authentication required|not signed in|not logged in|no saved (sign-in|session|login)|please (sign|log) in|\/login\b|\b401\b/i.test(both)) return { signedOut: true, text: SIGN_IN };
    if ((st && st.finishedReason === 'print_timeout') || /print timeout|DEADLINE_EXCEEDED/i.test(both)) return { text: 'Antigravity stopped at its time limit before the answer was complete. Try again, or choose a shorter text.' };
    if (LIMIT_RE.test(both)) return { text: 'Antigravity says the usage limit of your account is reached: ' + tail(both) };
    return { text: `agy exited with code ${code}. ${tail(both)}`.trim() };
  },

  async status({ run, env, keyKept }) {
    const v = await run('agy', ['--version'], { env, timeout: 15000 });
    if (v.code !== 0) return notInstalled(v);
    const out = { installed: true, version: versionOf(v), signedIn: null };
    const old = tooOld(out.version);
    if (old) { out.warning = old; out.outdated = true; return out; }
    if (keyKept && env.GEMINI_API_KEY) { out.signedIn = true; out.account = 'an API key from the environment (GEMINI_API_KEY)'; return out; }
    if (keyKept && /^(1|true|yes)$/i.test(String(env.AGY_ADC_AUTH || ''))) { out.account = 'Application Default Credentials (AGY_ADC_AUTH)'; return out; }
    let setUp = false;
    try { setUp = fs.statSync(agyDir()).isDirectory(); } catch { /* never run */ }
    out.warning = setUp ? 'ResearchTool does not check the Antigravity sign-in (that would mean starting agy): it shows at the first call.'
      : 'Antigravity has not been set up on this computer yet: run “agy” once in a terminal and sign in with Google.';
    return out;
  },
};
