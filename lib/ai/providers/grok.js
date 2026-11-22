// xAI Grok Build CLI (`grok`; official installer https://x.ai/cli, or npm @xai-official/grok), signed in with the
// user's xAI / X account (`grok login`, run by the user in a terminal; a free tier with usage limits, more with a
// paid plan). Researched on grok 1.0.92 (help text and the docs bundled in the binary; no model was ever called while
// writing this).
//   feature call: grok --prompt-file <tmp>/prompt.txt --verbatim --output-format json|streaming-json
//                 --permission-mode dontAsk --sandbox read-only --tools todo_write --disallowed-tools <DENY>
//                 --no-memory --no-subagents --disable-web-search --max-turns 1 --cwd <tmp> [-m <model>]
//                 [--reasoning-effort low|medium]
//   panel:        grok --prompt-file <tmp>/prompt.txt --verbatim --output-format streaming-json --permission-mode
//                 dontAsk --sandbox read-only --tools read_file,grep,list_dir --disallowed-tools <DENY> --no-memory
//                 --no-subagents --disable-web-search --cwd <empty panel folder> --add-dir <ws> [--add-dir <project>]
//                 [-r <session>]
// --prompt-file starts headless mode by itself (no -p, which would read stdin); --verbatim sends the prompt as it is
// (a first word such as "/goal" is never run as a slash command). The prompt file is mode 0600 inside a private
// per-call folder that is removed afterwards - never in argv.
// Read-only does not rest on one setting: (1) --tools is an allowlist of built-in tools - none that runs a command,
// writes, fetches or searches the web (a feature call needs no tool: todo_write only edits Grok's own task list) -
// so `always-approve` or allow rules in the user's ~/.grok config cannot reach a shell; (2) --disallowed-tools
// removes them once more; (3) dontAsk refuses anything not approved; (4) the read-only sandbox (macOS Seatbelt,
// Linux Landlock 5.13+). When Grok says on stderr that the sandbox is not in effect (Windows, an old kernel, a
// build without it) or that a --tools entry names no tool (then the other tools would stay available), the run is
// stopped and reported - never answered (child.js, unsafe()). The panel runs in an empty folder, so a .grok folder,
// AGENTS.md or .mcp.json of the workspace is never loaded as project configuration (Grok also needs folder trust for
// those); the workspace is an --add-dir.
// json: {text, stopReason, sessionId, requestId, usage?, total_cost_usd?};
// streaming-json: {"type":"text"|"thought"|"tool_call"|"usage"|"end", ...}.
// UNVERIFIED against a real run: the event fields, the exact not-signed-in / limit texts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tail, notInstalled } = require('./codex');

// shell, edits, files written, web, subagents: the internal ids (shell route) and the names of the daemon route
const DENY = 'run_terminal_cmd,search_replace,write,web_search,web_fetch,task,Shell,StrReplace,Delete,XSearch';
const COMMON = ['--permission-mode', 'dontAsk', '--sandbox', 'read-only', '--no-memory', '--no-subagents', '--disable-web-search'];
const grokHome = () => process.env.GROK_HOME || path.join(os.homedir(), '.grok');
function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const inp = u.input_tokens ?? u.inputTokens ?? 0, cached = u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0, out = u.output_tokens ?? u.outputTokens ?? 0;
  return { in: inp, cached, out };
}
const LIMIT_RE = /usage limit|free usage limit|rate limit|quota|run out of credits|out of credits|\b402\b|\b429\b|plan does not include|upgrade/i;

module.exports = {
  id: 'grok',
  label: 'xAI Grok Build',
  name: 'Grok',
  cliName: 'Grok Build',
  bin: 'grok',
  vendor: 'xAI',
  caps: { readsPdf: false, readsImage: false, sessions: true, agentic: false, partial: true, inAppLogin: false },
  keyVars: ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'],
  envPass: ['GROK_HOME'],
  promptFile: true,
  install: { mac: 'curl -fsSL https://x.ai/cli/install.sh | bash', linux: 'curl -fsSL https://x.ai/cli/install.sh | bash', win: 'irm https://x.ai/cli/install.ps1 | iex', alt: 'npm install -g @xai-official/grok' },
  docs: 'https://x.ai/cli',
  login: 'grok login',
  loginNote: 'Grok Build runs read-only only where its sandbox works (macOS, Linux 5.13 or later); on Windows ResearchTool stops its calls.',
  env: { GROK_DISABLE_AUTOUPDATER: '1' },
  format: (stream) => (stream ? 'lines' : 'json'),

  args({ mode, stream, cwd, model, effort, session, promptFile, addDirs = [] }) {
    const m = model ? ['-m', model] : [];
    const head = ['--prompt-file', promptFile, '--verbatim'];
    if (mode === 'chat') {
      // (a resumed session keeps its folders)
      return [...head, '--output-format', 'streaming-json', ...COMMON, '--tools', 'read_file,grep,list_dir', '--disallowed-tools', DENY, '--cwd', cwd,
        ...(session ? ['-r', session] : addDirs.flatMap((d) => ['--add-dir', d])), ...m];
    }
    return [...head, '--output-format', stream ? 'streaming-json' : 'json', ...COMMON, '--tools', 'todo_write', '--disallowed-tools', DENY, '--max-turns', '1', '--cwd', cwd,
      ...m, ...(effort ? ['--reasoning-effort', effort] : [])];
  },
  stdin: () => null,

  // stderr that means the read-only setup is not in effect: the run is stopped (child.js)
  unsafe(err) {
    if (/sandbox could not be applied|no sandbox enforcement|sandbox profile is not enforced|profile is not in effect|could not apply the .* sandbox profile/i.test(err)) {
      return 'Grok could not apply its read-only sandbox on this computer, so ResearchTool stopped the call (Grok\'s sandbox works on macOS and on Linux 5.13 or later, not on Windows). Choose another AI provider in Preferences › AI.';
    }
    if (/names? no tool, so other tools stay available|always-approve is active/i.test(err)) {
      return 'Grok did not accept ResearchTool\'s list of read-only tools, so ResearchTool stopped the call. Update Grok Build (grok update) or choose another AI provider in Preferences › AI.';
    }
    return null;
  },

  line(ev, st, emit) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.sessionId && !st.session) emit({ type: 'session', id: String(ev.sessionId) });
    if (ev.type === 'text' && typeof ev.data === 'string') emit({ type: 'delta', text: ev.data });
    else if (ev.type === 'thought') emit({ type: 'thinking' });
    else if (ev.type === 'tool_call') emit({ type: 'tool', name: String(ev.title || ev.name || ev.kind || 'tool'), detail: String((ev.rawInput && (ev.rawInput.path || ev.rawInput.file_path)) || '').slice(0, 200) });
    else if (ev.type === 'usage') st.usage = usageOf(ev.usage);
    else if (ev.type === 'error') st.errors.push(String(ev.message || ev.data || 'error'));
    else if (ev.type === 'end') emit({ type: 'final', isError: /error|fail/i.test(String(ev.stopReason || '')), error: st.errors.join(' ') || undefined, usage: st.usage, usd: ev.total_cost_usd });
  },
  json(j, st, emit) {
    if (!j || typeof j !== 'object') return;
    if (j.sessionId) emit({ type: 'session', id: String(j.sessionId) });
    if (typeof j.text === 'string') { emit({ type: 'message', text: j.text }); emit({ type: 'final', isError: false, usage: usageOf(j.usage), usd: j.total_cost_usd }); }
    else if (j.error) st.errors.push(String(j.error.message || j.error));
  },

  failure({ code, err, out, resumed, st }) {
    const all = `${(st && st.errors.join('\n')) || ''}\n${err}\n${out}`;
    if (resumed && /no session found|session not found|requires a valid session/i.test(all)) return { lost: true, text: 'This conversation is not known to Grok any more.' };
    if (/not signed in|grok login|no cached credentials/i.test(all)) return { signedOut: true, text: 'Not signed in to Grok. Run “grok login” in a terminal, then try again.' };
    if (LIMIT_RE.test(all)) return { text: 'Grok says the usage limit of your account is reached: ' + tail(all) };
    return { text: `grok exited with code ${code}. ${tail(all)}`.trim() };
  },

  // Installed: `grok --version`. Signed in: Grok's own stored sign-in ($GROK_HOME/auth.json) or an opted-in key -
  // read from disk, nothing is started (`grok usage` would ask the account over the network and start Grok's
  // background service). A sign-in that has expired shows when a call is made.
  async status({ run, env, keyKept }) {
    const v = await run('grok', ['--version'], { env, timeout: 15000 });
    if (v.code !== 0) return notInstalled(v);
    const out = { installed: true, version: (`${v.out}`.match(/\d+\.\d+\.\d+/) || [''])[0], signedIn: false };
    let creds = false;
    try { creds = fs.statSync(path.join(grokHome(), 'auth.json')).size > 2; } catch { /* none */ }
    if (creds) { out.signedIn = true; out.account = 'xAI account'; }
    else if (keyKept && (env.XAI_API_KEY || env.GROK_CODE_XAI_API_KEY)) { out.signedIn = true; out.account = 'an API key from the environment (XAI_API_KEY)'; }
    if (process.platform === 'win32') out.warning = 'Grok Build has no read-only sandbox on Windows, so ResearchTool stops its calls there. Choose another AI provider.';
    return out;
  },
};
