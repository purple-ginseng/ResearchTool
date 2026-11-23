// Fake AI CLIs for the tests (scripts/test-ai.js, scripts/smoke-server.js): `claude`, `codex`, `grok` and `agy`
// (Google Antigravity) as far as ResearchTool uses them. Never a real model, never the network, never a login.
//   node fake.js <provider> [args...]      (the harness writes a sh wrapper or an npm-style .cmd shim per provider)
// Each call is logged as one JSON line to $FAKE_AI_LOG: {p, argv, cwd, stdin, promptFile, envKeys, pid}. Env values are
// never logged, only the names. The answer is picked from markers in the prompt, so the JSON features get valid JSON.
// $FAKE_AI_STATE picks a failure mode: ok (default) | signedout | quota | slow | malformed | lost | badconfig |
//   nosandbox (grok: warns that its sandbox is not applied, then answers anyway - the app must stop it) |
//   timeout (agy: --print-timeout expired: a partial answer, AGY_ERROR line, exit 3) | softdeny (agy: a tool was
//   soft-denied - a stderr notice and denied_actions - the answer still comes) | badmode (agy: init reports the
//   permission mode always-proceed - the app must stop it) | nomode (agy: init without permission_mode) | noinit (agy:
//   text before any init) | outside (agy: a tool step reads ~/.ssh) | old (agy: \`--version\` says 1.0.2) | noversion
//   (agy: \`--version\` prints no version) - the app must stop each of them |
//   oldclaude (claude: an older Claude Code - \`--version\` 1.0.30, and every option it does not know yet, --effort,
//   --setting-sources, --system-prompt ..., stops it with commander's "error: unknown option '--effort'", exit 1) |
//   ancientclaude (the same, and it does not know --strict-mcp-config either: the compatible set fails too) |
//   effortvalue (claude: a current Claude Code that offers no --effort low - commander's "error: option '--effort
//   <level>' argument 'low' is invalid. Allowed choices are medium, high.", exit 1; every other option is known)
// $FAKE_AI_WRITE=<absolute file>[<path.delimiter><absolute file>...] (codex): the panel's write mode ("Let Codex edit
//   files") - the fake appends a line to each file (making it and its folders if need be) only when it runs in
//   workspace-write with the panel's write settings and the file is inside a writable root (-C / cwd, --add-dir,
//   writable_roots), as the real sandbox would; the log line says what it wrote (wrote: the first file or null,
//   wroteAll: every file written). workspace-write anywhere else (a feature call, without approvals off / network
//   off / no tmp) exits 97.
// $FAKE_AI_HOLD=<absolute file> (codex): after logging the call, wait (at most 20 s) until that file exists before
//   answering - so that a test can look at the app, and change files, while the run is going.
// The output formats follow the CLI research (codex-cli 0.171.0, grok 1.0.92, agy 1.5.14); they are this project's
// best reading of those CLIs and must be confirmed against a real run (ARCHITECTURE.md, "unverified") - except agy's
// flag and --settings checks and the nested events of a plain turn, which were seen with the real agy 1.5.14.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = process.argv[2];
const a = process.argv.slice(3);
const STATE = process.env.FAKE_AI_STATE || 'ok';
const has = (f) => a.includes(f);
const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const out = (s) => process.stdout.write(s);
const line = (o) => out(JSON.stringify(o) + '\n');

// flags the app must never pass to any of these CLIs (exit 97 = a test failure the harness looks for)
const FORBIDDEN = [/^--yolo$/, /^-y$/, /^--always-approve$/, /^--approve-for-me$/, /^--dangerously/, /^bypassPermissions$/, /^workspace-write$/,
  /^danger-full-access$/, /^--with-api-key$/, /^--with-access-token$/, /^yolo$/, /^auto_edit$/, /^--trust$/, /^--oauth$/];
// codex: workspace-write only as the panel's write mode ("Let Codex edit files") - a chat call (no --ephemeral, the
// shell tool not switched off) with approvals off, no network and no /tmp or $TMPDIR; anywhere else it is forbidden
const CODEX_WRITE_SAFE = ['approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'];
const codexWrite = () => P === 'codex' && a[0] === 'exec' && (a[a.indexOf('-s') + 1] === 'workspace-write' || a.includes('sandbox_mode="workspace-write"'));
const codexWriteOk = () => codexWrite() && !has('--ephemeral') && !has('features.shell_tool=false') && !has('-i') && CODEX_WRITE_SAFE.every((k) => has(k))
  && (a[1] === 'resume' ? !has('-s') && !has('--add-dir') : a.includes('-C')) && !a.some((x) => /network_access=true|danger-full-access|sandbox_mode="read-only"/.test(x));
function refuseForbidden() {
  if (P === 'claude') return;
  const bad = a.find((x) => FORBIDDEN.some((re) => re.test(x)) && !(x === 'workspace-write' && codexWriteOk()))
    || (codexWrite() && !codexWriteOk() ? 'workspace-write without the panel\'s write settings' : undefined);
  const login = (a[0] === 'login' && a[1] !== 'status') || a[0] === 'logout' || a[0] === 'auth';
  if (bad || login) { process.stderr.write(`fake ${P}: forbidden argument ${bad || a[0]}\n`); log({ forbidden: bad || a[0] }); process.exit(97); }
}

function log(extra = {}) {
  const f = process.env.FAKE_AI_LOG;
  if (!f) return;
  const pf = val('--prompt-file');
  let promptFile = null;
  if (pf) { try { promptFile = fs.readFileSync(pf, 'utf8'); } catch { promptFile = '<unreadable>'; } }
  fs.appendFileSync(f, JSON.stringify({ p: P, argv: a, cwd: process.cwd(), stdin: extra.stdin ?? null, promptFile, promptFilePath: pf || null,
    envKeys: Object.keys(process.env).sort(), pid: process.pid, state: STATE, ...extra }) + '\n');
}

const readStdin = () => new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve('');
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => resolve(s));
  process.stdin.on('error', () => resolve(s));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the answer, by what the prompt asks for ----------
function answerFor(prompt) {
  const p = String(prompt);
  const echo = (/SENTINEL-[A-Za-z0-9]+/.exec(p) || [''])[0];
  if (/"cells"\s*:/.test(p)) { // compare / ask across papers
    const ids = [...new Set([...p.matchAll(/"(c\d+)": \{"text"/g)].map((m) => m[1]))];
    return JSON.stringify({ cells: Object.fromEntries((ids.length ? ids : ['c1']).map((id) => [id, { text: `Fake ${P} cell ${id}`, pages: [1] }])) });
  }
  if (/"category": "<category name>"/.test(p)) return JSON.stringify({ category: `Fake ${P} line`, tags: ['fake', P], reason: 'It builds on fake work.', brief: 'A fake brief.' });
  if (/"questions"/.test(p)) {
    const q = (n) => ({ q: `Fake question ${n} by ${P}?`, options: [`Right ${n}`, `Wrong a${n}`, `Wrong b${n}`, `Wrong c${n}`], answer: 0, explain: 'Because (p. 1).', why: ['yes', 'no', 'no', 'no'], hint: 'Think.', page: 1 });
    return JSON.stringify({ title: `Fake quiz ${P}`, questions: [q(1), q(2), q(3)] });
  }
  if (/"nodes"/.test(p) && /"edges"/.test(p)) {
    return JSON.stringify({ title: `Fake diagram ${P}`, kind: 'flowchart', summary: 'A fake diagram.', groups: [],
      nodes: [{ id: 'a', label: 'Input', type: 'data', desc: 'in', explain: 'x', page: 1 }, { id: 'b', label: 'Output', type: 'process', desc: 'out', explain: 'y', page: 1 }],
      edges: [{ from: 'a', to: 'b', label: 'goes to', desc: 'flow' }] });
  }
  if (/Reply with ONLY a JSON array/.test(p)) return JSON.stringify([{ i: 0, category: 'result', note: `fake ${P} key point` }, { i: 1, category: 'method', note: 'second' }]);
  return `# Fake answer by ${P}\n\nThis is a fake answer (p. 1).${echo ? ' ' + echo : ''}\n`;
}
const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30 };
const SESSION = '11111111-2222-4333-8444-555555555555';
const chunks = (s) => s.match(/[\s\S]{1,12}/g) || [''];

// ---------- claude ----------
// the options an older Claude Code knows (oldclaude / ancientclaude): what the Claude panel passes, --model, and
// --strict-mcp-config (not ancientclaude)
const OLD_FLAGS = new Set(['-p', '--verbose', '--include-partial-messages', '--strict-mcp-config']);
const OLD_VALUE = new Set(['--output-format', '--tools', '--allowedTools', '--append-system-prompt', '--model', '--permission-mode', '--resume', '--add-dir']);
function oldClaudeRefuses() {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (OLD_VALUE.has(x)) { i++; continue; }
    if (OLD_FLAGS.has(x) && !(STATE === 'ancientclaude' && x === '--strict-mcp-config')) continue;
    if (x.startsWith('-')) return `error: unknown option '${x}'`;
    return `error: too many arguments. Expected 0 arguments but got 1.`;
  }
  return null;
}
async function claude() {
  const old = STATE === 'oldclaude' || STATE === 'ancientclaude';
  if (a[0] === '--version') { log(); out(old ? '1.0.30 (Claude Code)\n' : '9.9.9 (Claude Code, fake)\n'); return 0; }
  if (STATE === 'effortvalue' && val('--effort') === 'low') {
    const refused = "error: option '--effort <level>' argument 'low' is invalid. Allowed choices are medium, high.";
    log({ refused }); process.stderr.write(refused + '\n'); return 1;
  }
  if (old && a[0] !== 'auth') {
    const refused = oldClaudeRefuses();
    if (refused) { log({ refused }); process.stderr.write(refused + '\n'); return 1; }
  }
  if (a[0] === 'auth' && a[1] === 'status') {
    log();
    if (STATE === 'signedout') { line({ loggedIn: false, authMethod: 'none' }); return 1; }
    line({ loggedIn: true, authMethod: 'claude.ai', email: 'fake@example.invalid', subscriptionType: 'pro' }); return 0;
  }
  if (!has('-p')) { log(); process.stderr.write('fake claude: only -p, --version and auth status\n'); return 3; }
  const stdin = await readStdin();
  log({ stdin });
  if (STATE === 'slow') await sleep(60000);
  const text = answerFor(stdin), sid = val('--resume') || SESSION;
  const fmt = val('--output-format');
  const lost = STATE === 'lost' && val('--resume');
  const err = STATE === 'signedout' ? 'Not logged in · Please run /login' : STATE === 'quota' ? 'Claude AI usage limit reached' : lost ? `No conversation found with session ID: ${sid}` : null;
  const result = { type: 'result', subtype: err ? 'error' : 'success', is_error: !!err, result: err || text, session_id: sid, usage, total_cost_usd: 0.0012, duration_ms: 900 };
  if (fmt === 'stream-json') {
    line({ type: 'system', subtype: 'init', session_id: sid });
    if (!err) {
      if (has('--include-partial-messages')) {
        line({ type: 'stream_event', event: { type: 'message_start', message: { usage } } });
        line({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
        for (const c of chunks(text)) line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: c } } });
        line({ type: 'stream_event', event: { type: 'content_block_stop' } });
      }
      line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    }
    line(result);
  } else if (STATE === 'malformed') out('this is not json {');
  else line(result);
  return err ? 1 : 0;
}

// ---------- codex (exec --json: JSONL events) ----------
async function codex() {
  if (a[0] === '--version' || a[0] === '-V') { log(); out(`codex-cli 0.171.0\n`); return 0; }
  if (a[0] === 'login' && a[1] === 'status') {
    log();
    if (STATE === 'signedout') { process.stderr.write('Not logged in\n'); return 1; }
    process.stderr.write('Logged in using ChatGPT\n'); return 0;
  }
  if (a[0] !== 'exec') { log(); process.stderr.write('fake codex: only exec, login status and --version\n'); return 3; }
  if (a[a.length - 1] !== '-') { log(); process.stderr.write('fake codex: the prompt must come on stdin (-)\n'); return 98; }
  const stdin = await readStdin();
  // $FAKE_AI_WRITE=<absolute file>: the panel asks for an edit. Like the real sandbox, the file is changed only in
  // workspace-write and only inside a writable root: the -C folder (a new chat) or the cwd (resume), an --add-dir,
  // or a sandbox_workspace_write.writable_roots entry. Otherwise the "command" fails and nothing is written.
  let fileWrite = null;
  const targets = String(process.env.FAKE_AI_WRITE || '').split(path.delimiter).filter(Boolean);
  if (targets.length && a[0] === 'exec') {
    const roots = [a.includes('-C') ? a[a.indexOf('-C') + 1] : process.cwd()];
    a.forEach((x, i) => { if (x === '--add-dir') roots.push(a[i + 1]); });
    const wr = a.find((x) => x.startsWith('sandbox_workspace_write.writable_roots='));
    if (wr) { try { roots.push(...JSON.parse(wr.slice(wr.indexOf('=') + 1))); } catch { log({ forbidden: 'writable_roots is not a TOML array of basic strings: ' + wr }); return 97; } }
    // (the realpath of the nearest folder that exists: a file in a folder still to be made)
    // (Windows: the native realpath, which expands 8.3 short names such as RUNNER~1 as the app's does; compared
    // without regard to case, as the file system does)
    const rp = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync;
    const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const real = (p) => { let rest = ''; p = path.resolve(p); for (;;) { try { return fold(path.join(rp(p), rest)); } catch { const up = path.dirname(p); if (up === p) return fold(path.join(p, rest)); rest = path.join(path.basename(p), rest); p = up; } } };
    const wrote = [];
    for (const target of targets) {
      const t = real(target);
      const ok = codexWriteOk() && roots.some((r) => { const rr = real(r); return t === rr || t.startsWith(rr + path.sep); });
      if (ok) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.appendFileSync(target, '% edited by fake codex\n'); wrote.push(target); }
    }
    fileWrite = { target: targets[0], ok: wrote.includes(targets[0]), roots, wrote };
  }
  log({ stdin, ...(fileWrite ? { wrote: fileWrite.ok ? fileWrite.target : null, wroteAll: fileWrite.wrote, roots: fileWrite.roots } : {}) });
  if (process.env.FAKE_AI_HOLD) { const until = Date.now() + 20000; while (!fs.existsSync(process.env.FAKE_AI_HOLD) && Date.now() < until) await sleep(50); }
  if (STATE === 'slow') await sleep(60000);
  if (STATE === 'signedout') { process.stderr.write('Error: Not logged in. Run `codex login` to sign in.\n'); return 1; }
  if (STATE === 'badconfig' && a.some((x) => /model_reasoning_effort/.test(x))) { process.stderr.write('Error: unknown configuration key `model_reasoning_effort`\n'); return 2; }
  const ri = a.indexOf('resume');
  const sid = ri >= 0 ? a[ri + 1] : SESSION;
  if (STATE === 'lost' && ri >= 0) { process.stderr.write(`Error: no rollout found for thread id ${sid}\n`); return 1; }
  if (STATE === 'malformed') { out('garbage line\n{"type":\n'); return 0; }
  line({ type: 'thread.started', thread_id: sid });
  line({ type: 'turn.started' });
  if (STATE === 'quota') { line({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }); return 1; }
  line({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Thinking**' } });
  if (fileWrite) {
    line({ type: 'item.started', item: { id: 'item_w', type: 'file_change', changes: [{ path: fileWrite.target, kind: 'update' }] } });
    line({ type: 'item.completed', item: { id: 'item_w', type: 'file_change', status: fileWrite.ok ? 'completed' : 'failed', changes: [{ path: fileWrite.target, kind: 'update' }] } });
  }
  line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: answerFor(stdin) } });
  line({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 40 } });
  return 0;
}

// ---------- grok (--output-format json | streaming-json; the prompt from --prompt-file) ----------
async function grok() {
  if (a[0] === '--version' || a[0] === '-v' || a[0] === 'version') { log(); out('grok 1.0.92 (b06756fd6256)\n'); return 0; }
  if (a[0] === 'usage') {
    log();
    if (STATE === 'signedout') { process.stderr.write('not signed in: run `grok login`, set XAI_API_KEY, or set a model api_key/env_key\n'); return 1; }
    line({ plan: 'SuperGrok', usagePct: 12 }); return 0;
  }
  const pf = val('--prompt-file');
  if (has('-p') || !pf || !has('--verbatim')) { log(); process.stderr.write('fake grok: --prompt-file and --verbatim, without -p (which reads stdin)\n'); return 3; }
  if (val('--sandbox') !== 'read-only' || val('--permission-mode') !== 'dontAsk') { log(); process.stderr.write('fake grok: read-only sandbox and dontAsk are required\n'); return 97; }
  const tools = (val('--tools') || '').split(',');
  if (!val('--tools') || tools.some((t) => !['read_file', 'grep', 'list_dir', 'todo_write'].includes(t)) || !/run_terminal_cmd/.test(val('--disallowed-tools') || '')) {
    log(); process.stderr.write('fake grok: a read-only --tools allowlist and --disallowed-tools are required\n'); return 97;
  }
  log();
  if (STATE === 'nosandbox') process.stderr.write("warning: sandbox could not be applied: Landlock is not supported by this kernel. The 'read-only' profile is not in effect.\n");
  if (STATE === 'slow') await sleep(60000);
  let prompt = '';
  try { prompt = fs.readFileSync(pf, 'utf8'); } catch { process.stderr.write('fake grok: cannot read the prompt file\n'); return 4; }
  const fmt = val('--output-format') || 'plain';
  const sid = val('-r') || val('--resume') || SESSION;
  if (STATE === 'signedout') { process.stderr.write('Not signed in. Run `grok login` to authenticate (or `grok login --device-code` if no browser is available).\n'); return 1; }
  if (STATE === 'lost' && (has('-r') || has('--resume'))) { process.stderr.write(`No session found with ID: ${sid}\n`); return 1; }
  if (STATE === 'quota') { process.stderr.write('Error: you have reached the usage limit of your plan\n'); return 1; }
  if (STATE === 'malformed') { out('{not json'); return 0; }
  const text = answerFor(prompt);
  if (fmt === 'streaming-json') {
    line({ type: 'thought', data: 'Thinking about it…' });
    for (const c of chunks(text)) line({ type: 'text', data: c });
    line({ type: 'usage', messageId: 'resp_1', stopReason: 'end_turn', usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30 } });
    line({ type: 'end', stopReason: 'EndTurn', sessionId: sid, total_cost_usd: 0.0021 });
  } else {
    out(JSON.stringify({ text, stopReason: 'EndTurn', sessionId: sid, requestId: 'req_1', usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30 }, total_cost_usd: 0.0021 }, null, 2) + '\n');
  }
  return 0;
}

// ---------- agy (Google Antigravity: -p --input-format stream-json --output-format stream-json) ----------
// Refuses what would make it act: --dangerously-skip-permissions (FORBIDDEN above), --mode auto / accept-edits, a
// missing --sandbox / --mode plan / --disable-slash-commands / --print-timeout, --settings without the deny rules,
// any subcommand but --version (models, update, login, acp, mcp, plugin ... - exit 97), a prompt in argv.
const AGY_VERSION = '9.8.7'; // not the real agy's 1.5.14: a status that shows 9.8.7 came from this fake
const AGY_CONV = '055a398f-db14-4c5f-abbb-1bf03f8120a7';
// like the real agy 1.5.14 (seen in a real run): each event's data nested under its name, the conversation id also at
// the top of init; and the warning it prints because --disable-slash-commands makes --mode plan a no-op
function aline(o) {
  const { type, ...rest } = o;
  line({ event: type, ...(type === 'init' ? { conversation_id: AGY_CONV } : {}), [type]: rest });
}
async function agy() {
  if (a[0] === '--version' || a[0] === '-v') { log(); out((STATE === 'old' ? '1.0.2' : STATE === 'noversion' ? 'agy (build unknown)' : AGY_VERSION) + '\n'); return 0; }
  // an agy before 1.1.18 (help-1.0.2.txt): a valueless -p takes the next argument as its prompt, --input-format and
  // --mode are unknown flags - it must never get this far (lib/ai/index.js versionGate)
  if (STATE === 'old' || STATE === 'noversion') { log({ forbidden: 'an agy below the minimum version was started' }); process.stderr.write('flag provided but not defined: -input-format\n'); return 2; }
  if (a.length && !a[0].startsWith('-')) { log({ forbidden: a[0] }); process.stderr.write(`fake agy: subcommand ${a[0]} is never run by ResearchTool\n`); return 97; }
  const mode = val('--mode');
  if (mode !== 'plan') { log({ forbidden: '--mode ' + mode }); process.stderr.write(`fake agy: --mode plan is required (got ${mode})\n`); return 97; }
  if (!has('-p') || val('--input-format') !== 'stream-json' || val('--output-format') !== 'stream-json') { log(); process.stderr.write('fake agy: -p with stream-json input and output only\n'); return 3; }
  // like the real agy 1.5.14: -p takes a value ("flag needs an argument: -p", exit 2); the app sends -p "" last
  // (has('-p') above guarantees pi >= 0; the last-pair check compares the elements, not indexOf against a.length)
  const pi = a.indexOf('-p');
  if (pi < 0 || pi + 1 >= a.length) { log(); process.stderr.write('flag needs an argument: -p\n'); return 2; }
  if (a[pi + 1] !== '') { log({ forbidden: 'prompt in argv' }); process.stderr.write('fake agy: the prompt must come on stdin (-p "")\n'); return 97; }
  const pLastPair = a.length >= 2 && a[a.length - 2] === '-p' && a[a.length - 1] === '' && a.lastIndexOf('-p') === pi;
  if (!pLastPair) { log({ forbidden: '-p "" is not last' }); process.stderr.write('fake agy: -p "" must be the last pair\n'); return 97; }
  if (!has('--sandbox') || !has('--disable-slash-commands') || !/^\d+s$/.test(val('--print-timeout') || '')) { log(); process.stderr.write('fake agy: --sandbox, --disable-slash-commands and --print-timeout are required\n'); return 97; }
  let set = null; try { set = JSON.parse(val('--settings') || ''); } catch { /* none */ }
  // like the real agy 1.5.14: an unknown settings key is refused (exit 1)
  const KNOWN = ['agentMode', 'toolPermission', 'permissions', 'modelProvider'];
  const unknownKey = set && Object.keys(set).find((k) => !KNOWN.includes(k));
  if (unknownKey) { log(); process.stderr.write(`Error: --settings: unknown setting "${unknownKey}"\n`); return 1; }
  const deny = (set && set.permissions && set.permissions.deny) || [];
  if (!set || set.agentMode !== 'plan' || set.toolPermission !== 'request-review' || !['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'].every((r) => deny.includes(r))
    || (set.permissions.allow && set.permissions.allow.length)) {
    log(); process.stderr.write('fake agy: --settings must deny command, write_file, mcp, read_url and execute_url and allow nothing\n'); return 97;
  }
  const raw = await readStdin();
  let msg = null; try { msg = JSON.parse(raw.trim().split('\n')[0]); } catch { /* below */ }
  const prompt = msg && msg.event === 'user' && msg.message && typeof msg.message.content === 'string' ? msg.message.content : null;
  log({ stdin: prompt, stdinRaw: raw.length > 2000 ? raw.slice(0, 2000) : raw, stdinLines: raw.split('\n').filter(Boolean).length });
  if (prompt == null) { process.stderr.write('error: stream-json input: missing "event" field or invalid JSON\n'); return 1; }
  process.stderr.write('warning: --mode plan has no effect while slash command expansion is disabled.\n');
  if (STATE === 'slow') await sleep(60000);
  const conv = val('--conversation') || AGY_CONV;
  const result = (o) => aline({ type: 'result', conversation_id: conv, duration_seconds: 1.2, num_turns: 1, ...o });
  const AGYERR = (o) => process.stderr.write('AGY_ERROR: ' + JSON.stringify(o) + '\n');
  if (STATE === 'signedout') { process.stderr.write('error: authentication required: no saved sign-in. Run agy to sign in.\n'); return 1; }
  if (STATE === 'lost' && has('--conversation')) { process.stderr.write(`warning: conversation ${conv} not found\n`); AGYERR({ status: 'NOT_FOUND', message: `conversation ${conv} not found` }); return 3; }
  if (STATE === 'nosandbox') process.stderr.write('warning: the terminal sandbox is not available on this system (user namespaces are disabled); turning off the terminal sandbox\n');
  if (STATE === 'noinit') { aline({ type: 'step_update', conversation_id: conv, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Fake answer before any init' }); }
  else aline({ type: 'init', cwd: process.cwd(), tools: ['view_file', 'list_dir', 'grep_search'], ...(STATE === 'nomode' ? {} : { permission_mode: STATE === 'badmode' ? 'always-proceed' : 'request-review' }) });
  aline({ type: 'step_update', conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input' });
  if (STATE === 'quota') {
    AGYERR({ status: 'RESOURCE_EXHAUSTED', http_status: 429, retryable: false, error_id: 'e1', message: 'You have reached your individual quota.' });
    result({ status: 'ERROR', response: '', error: { message: 'You have reached your individual quota. (RESOURCE_EXHAUSTED)' } }); return 3;
  }
  if (STATE === 'malformed') { out('garbage\n{"type":\n'); return 0; }
  const text = answerFor(prompt);
  if (STATE === 'softdeny') {
    aline({ type: 'step_update', conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { path: 'x.txt' } } });
    process.stderr.write('agy: soft-denied write_file(x.txt) in print mode; add the allow rule write_file(x.txt) to permit it\n');
  }
  if (STATE === 'outside') {
    aline({ type: 'step_update', conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: path.join(os.homedir(), '.ssh', 'id_fake') } } });
  }
  const cs = chunks(text), part = STATE === 'timeout' ? cs.slice(0, 2) : cs;
  for (const c of part) aline({ type: 'step_update', conversation_id: conv, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: c });
  const usage = { input_tokens: 120, output_tokens: 40, thinking_tokens: 5, cache_read_tokens: 30, total_tokens: 195 };
  if (STATE === 'timeout') {
    process.stderr.write('[agy] print timeout after 600s\n'); AGYERR({ status: 'DEADLINE_EXCEEDED', message: 'print timeout: terminated 0 background tasks' });
    result({ status: 'ERROR', finished_reason: 'print_timeout', response: part.join(''), usage }); return 3;
  }
  result({ status: 'SUCCESS', response: text, usage, ...(STATE === 'softdeny' ? { denied_actions: ['write_file(x.txt)'] } : {}) });
  return 0;
}

(async () => {
  refuseForbidden();
  const fn = { claude, codex, grok, agy }[P];
  if (!fn) { process.stderr.write('fake.js: unknown provider ' + P + '\n'); process.exit(2); }
  const code = await fn();
  process.exitCode = code;
})();
