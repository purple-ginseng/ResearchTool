// OpenAI Codex CLI (`codex`, npm @openai/codex), signed in with the user's ChatGPT account (`codex login`, run by the
// user in a terminal). Researched on codex-cli 0.171.0 (help texts only; no model was ever called while writing this).
//   feature call: codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules
//                 [-i <picture>] -s read-only -C <empty temp folder> <SAFE> -c features.shell_tool=false
//                 -c features.unified_exec=false [-m <model>] [-c model_reasoning_effort="low"] -
//   panel:        codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules -s read-only -C <ws> <SAFE> -
//                 codex exec resume <id> --json --skip-git-repo-check --ignore-user-config --ignore-rules
//                   -c sandbox_mode="read-only" <SAFE> -   (resume takes no -s / -C; the folder is the spawn's cwd)
//   SAFE:         -c web_search="disabled" -c shell_environment_policy.inherit="core" [-c cli_auth_credentials_store=..]
// The prompt always comes on stdin ("-"). Output: JSONL events (thread.started, item.*, turn.completed / failed).
// A feature call needs no tool: the shell tool is switched off (config keys of the features table; an unknown one is
// only a warning), so a prompt-injected PDF cannot have it `cat` a file of the disk into a draft. The panel keeps the
// shell (Codex reads files only through it), inside the read-only sandbox (no writes, no network; it can READ files
// outside the workspace - Codex has no read limit we can set from here) with only the core environment variables
// (HOME, PATH, ...) for its commands, and no web search. Codex has no turn limit option.
// --ignore-user-config skips ~/.codex/config.toml (MCP servers, profiles, the user's model): only where it keeps the
// sign-in (cli_auth_credentials_store) is read from it and passed on, so `codex login status` and the calls agree.
// UNVERIFIED against a real run: the agent_message field name (`text`), the effort config key, the error texts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const STATUS_TIMEOUT = 15000;
const isMsg = (it) => it && (it.type === 'agent_message' || it.type === 'assistant_message' || it.item_type === 'agent_message' || it.item_type === 'assistant_message');
const textOf = (it) => (typeof it.text === 'string' ? it.text : typeof it.message === 'string' ? it.message : Array.isArray(it.content) ? it.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('') : '');

module.exports = {
  id: 'codex',
  label: 'OpenAI Codex',
  name: 'Codex',
  cliName: 'Codex CLI',
  bin: 'codex',
  vendor: 'OpenAI',
  caps: { readsPdf: false, readsImage: true, sessions: true, agentic: false, partial: false, inAppLogin: false },
  keyVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  envPass: ['CODEX_HOME'],
  chatInWorkspace: true,
  install: { mac: 'npm install -g @openai/codex', linux: 'npm install -g @openai/codex', win: 'npm install -g @openai/codex', alt: 'brew install --cask codex' },
  configNote: 'Your ~/.codex/config.toml is not used for these calls (only where Codex keeps your sign-in): its model, profiles and MCP servers do not apply here.',
  docs: 'https://developers.openai.com/codex/cli',
  login: 'codex login',
  format: () => 'lines',

  args({ mode, cwd, model, effort, image, session }) {
    const base = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules'];
    const store = credStore();
    const safe = ['-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="core"', ...(store ? ['-c', `cli_auth_credentials_store="${store}"`] : [])];
    const m = model ? ['-m', model] : [];
    if (mode === 'chat') {
      if (session) return ['exec', 'resume', session, ...base, '-c', 'sandbox_mode="read-only"', ...safe, ...m, '-'];
      return ['exec', ...base, '-s', 'read-only', '-C', cwd, ...safe, ...m, '-'];
    }
    // -i takes several values: it goes right before another option, so "-" is never read as a picture
    return ['exec', ...base.slice(0, 1), '--ephemeral', ...base.slice(1), ...(image ? ['-i', image] : []), '-s', 'read-only', '-C', cwd, ...safe,
      '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', ...m, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'];
  },
  stdin: (text) => text,

  // one JSONL event -> normalised events (see lib/ai/child.js)
  line(ev, st, emit) {
    if (!ev || typeof ev !== 'object') return;
    const it = ev.item;
    if (ev.type === 'thread.started' && ev.thread_id) emit({ type: 'session', id: String(ev.thread_id) });
    else if ((ev.type === 'item.started' || ev.type === 'item.completed') && it) {
      if (isMsg(it)) { if (ev.type === 'item.completed') { const t = textOf(it); if (t) emit({ type: 'message', text: t }); } }
      else if (it.type === 'reasoning') emit({ type: 'thinking' });
      else if (it.type === 'command_execution' && ev.type === 'item.started') emit({ type: 'tool', name: 'Shell', detail: String(it.command || '').slice(0, 200) });
      else if (it.type === 'file_change' && ev.type === 'item.started') emit({ type: 'tool', name: 'Edit', detail: '' });
      else if (it.type === 'error' && it.message) st.errors.push(String(it.message));
    } else if (ev.type === 'turn.completed') {
      const u = ev.usage || {};
      emit({ type: 'final', isError: false, usage: { in: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), cached: u.cached_input_tokens || 0, out: u.output_tokens || 0 } });
    } else if (ev.type === 'turn.failed') emit({ type: 'final', isError: true, error: String((ev.error && ev.error.message) || 'Codex reported an error') });
    else if (ev.type === 'error' && ev.message) st.errors.push(String(ev.message));
  },

  // no successful turn: what went wrong, in words
  failure({ code, err, out, resumed, st }) {
    const all = `${(st && st.errors.join('\n')) || ''}\n${err}\n${out}`;
    if (resumed && /no (rollout|conversation|session|thread) found|session not found|thread .*not found|unknown (session|thread)/i.test(all)) return { lost: true, text: 'This conversation is not known to Codex any more.' };
    if (/not logged in|not signed in|codex login|unauthori[sz]ed|\b401\b/i.test(all)) return { text: 'Not signed in to Codex. Run “codex login” in a terminal, then try again.', signedOut: true };
    if (/usage limit|rate limit|quota|\b429\b/i.test(all)) return { text: 'Codex says the usage limit of your account is reached: ' + tail(all) };
    return { text: `codex exited with code ${code}. ${tail(all)}`.trim() };
  },
  // an "unknown config key" for the effort override: the call is made once more without it (and not again)
  retryWithoutEffort: (err) => /model_reasoning_effort|unknown (configuration|config) (key|field)/i.test(err),

  async status({ run, env }) {
    const v = await run('codex', ['--version'], { env, timeout: STATUS_TIMEOUT });
    if (v.code !== 0) return notInstalled(v);
    const out = { installed: true, version: (`${v.out}\n${v.err}`.match(/\d+\.\d+\.\d+/) || [''])[0], signedIn: null };
    // local: reads the stored login, never calls a model
    const s = await run('codex', ['login', 'status'], { env, timeout: STATUS_TIMEOUT });
    const text = `${s.out}\n${s.err}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^WARNING/i.test(l));
    if (s.code === 0) { out.signedIn = true; out.account = (text.find((l) => /logged in|signed in/i.test(l)) || text[0] || '').slice(0, 200); }
    else if (s.code === 1 || /not logged in/i.test(text.join(' '))) out.signedIn = false;
    else out.problem = (text.join(' ') || `codex login status exited with code ${s.code}`).slice(0, 300);
    return out;
  },
};

// where the user's Codex keeps its sign-in (file / keyring / auto), from $CODEX_HOME/config.toml: a top-level line
// cli_auth_credentials_store = "keyring" (before any [table]); only these words are passed on
function credStore() {
  try {
    const f = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const top = fs.readFileSync(f, 'utf8').split(/^\s*\[/m)[0];
    const m = /^\s*cli_auth_credentials_store\s*=\s*["']([a-z]+)["']\s*(?:#.*)?$/m.exec(top);
    return m && ['file', 'keyring', 'auto', 'ephemeral'].includes(m[1]) ? m[1] : '';
  } catch { return ''; }
}
function tail(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(-400); }
function notInstalled(v) {
  return { installed: false, signedIn: false, ...(/EUNSAFECMD|command shell/.test(v.err) ? { problem: v.err.trim().slice(0, 400) } : {}) };
}
module.exports.tail = tail;
module.exports.notInstalled = notInstalled;
