// The non-Claude part of scripts/test-ai.js (kept here so run-tests.js does not start it on its own).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

async function run(h) {
  const { test, PATHS, runPath, settings, readLog, clearLog, WS, BIN, A, route, core } = h;
  const ai = require('../../../lib/ai');
  const plat = require('../../../lib/platform');
  const notes = require('../../../lib/notes');
  const quiz = require('../../../lib/quiz');
  const routeAi = require('../../../lib/routes/ai');
  const routeLibrary = require('../../../lib/routes/library');
  const grok = require('../../../lib/ai/providers/grok');
  const agy = require('../../../lib/ai/providers/antigravity');
  const OTHERS = ['codex', 'grok', 'antigravity'];
  const TMP = ai.TMP_ROOT;
  const real = (d) => { try { return plat.realpath(d); } catch { return d; } }; // (Windows: the native realpath, as the app's)
  // other secrets of the server's environment: never passed on to codex / grok / agy (only Claude keeps the
  // environment it always had - the golden above)
  const OTHER = { GROK_CODE_XAI_API_KEY: 'g-fake', CURSOR_API_KEY: 'c-fake', GROK_AUTH_PROVIDER_COMMAND: '/bin/false', GATEWAY_API_KEY: 'gw-fake', AWS_SECRET_ACCESS_KEY: 'aws-fake',
    GITHUB_TOKEN: 'gh-fake', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/fake.json', OPENAI_BASE_URL: 'http://127.0.0.1:9/fake', GEMINI_CLI_TRUST_WORKSPACE: 'true', MY_SERVICE_SECRET: 's-fake' };
  Object.assign(process.env, OTHER);
  const KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'AGY_ADC_AUTH', ...Object.keys(OTHER)];
  process.env.AGY_ADC_AUTH = 'true'; // (an ADC sign-in exported for some other tool: dropped unless opted in)
  process.env.CODEX_HOME = path.join(h.TOP, 'codex-home'); // never the user's own ~/.codex/config.toml
  const GROK_HOME = path.join(h.TOP, 'grok-home'); fs.mkdirSync(GROK_HOME, { recursive: true }); process.env.GROK_HOME = GROK_HOME;
  const grokAuth = (on) => { const f = path.join(GROK_HOME, 'auth.json'); if (on) fs.writeFileSync(f, '{"fake":"session"}'); else fs.rmSync(f, { force: true }); };
  grokAuth(true);
  const state = (s) => { process.env.FAKE_AI_STATE = s; };
  const RO = {
    codex: (a) => (a.includes('-s') && a[a.indexOf('-s') + 1] === 'read-only') || a.includes('sandbox_mode="read-only"'),
    grok: (a) => a[a.indexOf('--sandbox') + 1] === 'read-only' && a[a.indexOf('--permission-mode') + 1] === 'dontAsk' && a.includes('--verbatim') && !a.includes('-p')
      && a[a.indexOf('--tools') + 1].split(',').every((t) => ['read_file', 'grep', 'list_dir', 'todo_write'].includes(t)) && /run_terminal_cmd/.test(a[a.indexOf('--disallowed-tools') + 1]),
    antigravity: (a) => {
      const set = JSON.parse(a[a.indexOf('--settings') + 1]), deny = set.permissions.deny;
      return a[a.indexOf('--mode') + 1] === 'plan' && a.includes('--sandbox') && a.includes('--disable-slash-commands') && /^\d+s$/.test(a[a.indexOf('--print-timeout') + 1])
        && a.length >= 2 && a[a.length - 2] === '-p' && a[a.length - 1] === '' && a.indexOf('-p') === a.lastIndexOf('-p') && !a.some((x) => /dangerously/.test(x)) && set.agentMode === 'plan' && set.toolPermission === 'request-review'
        && ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'].every((r) => deny.includes(r)) && !set.permissions.allow.length;
    },
  };
  const featureCalls = (calls) => calls.filter((c) => c.p !== 'claude' && !['--version', 'login', 'usage'].includes(c.argv[0]));
  const usageLines = () => { try { return fs.readFileSync(path.join(WS, 'cache', 'ai-usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

  // ================= selection =================
  await test('provider selection: absent or unknown aiProvider means claude; each id selects its provider', () => {
    settings({ aiProvider: undefined }); assert.equal(ai.currentId(), 'claude');
    settings({ aiProvider: 'bogus' }); assert.equal(ai.currentId(), 'claude');
    for (const id of [...OTHERS, 'claude']) { settings({ aiProvider: id }); assert.equal(ai.currentId(), id); assert.equal(ai.current().id, id); }
    settings({ aiProvider: undefined });
  });
  // Gemini CLI is no longer offered (Google ended personal-account use on 2026-06-18): a settings.json saved while it was
  await test('a saved aiProvider "gemini" (Gemini CLI, removed) falls back to Claude; its stale entries are ignored, never an error', async () => {
    settings({ aiProvider: 'gemini', aiProviders: { gemini: { model: 'gemini-fake-pro', categoryModel: 'gemini-fake-flash' }, codex: { model: 'gpt-fake' } }, aiUseEnvKey: { gemini: true } });
    try {
      assert.equal(ai.currentId(), 'claude'); assert.equal(ai.current().id, 'claude'); assert.equal(ai.provider('gemini'), null);
      assert.ok(!ai.IDS.includes('gemini') && !('gemini' in ai.PROVIDERS));
      assert.equal(ai.chatRoot(), null, 'the panel is the Claude panel');
      let r = await route(routeAi, 'GET', '/api/ai/providers');
      assert.equal(r.code, 200); assert.equal(r.data.current, 'claude'); assert.deepEqual(r.data.providers.map((p) => p.id), ['claude', 'codex', 'grok', 'antigravity']);
      assert.equal(r.data.providers.find((p) => p.id === 'codex').model, 'gpt-fake', 'the other providers keep their settings');
      r = await route(routeAi, 'GET', '/api/ai/status?p=gemini');
      assert.equal(r.code, 400, JSON.stringify(r)); assert.match(JSON.stringify(r.data), /Unknown AI provider/);
      await assert.rejects(ai.status('gemini'), /Unknown AI provider/);
      const all = await ai.statusAll({}); assert.deepEqual(Object.keys(all), ['claude', 'codex', 'grok', 'antigravity']);
      // a feature call with the stale setting runs Claude Code (the fake claude), never a gemini
      clearLog(); const run = await ai.run(['-p', '--output-format', 'json'], { input: 'x', timeout: 20000 }, {});
      assert.equal(run.code, 0, JSON.stringify(run)); assert.ok(readLog().length >= 1 && readLog().every((c) => c.p === 'claude'), JSON.stringify(readLog().map((c) => c.p)));
      // saving other settings keeps working; choosing gemini again is refused
      r = await route(routeLibrary, 'PUT', '/api/settings', { aiUseEnvKey: { codex: false } }); assert.equal(r.code, 200, JSON.stringify(r));
      for (const bad of [{ aiProvider: 'gemini' }, { aiProviders: { gemini: { model: 'x' } } }, { aiUseEnvKey: { gemini: true } }]) {
        r = await route(routeLibrary, 'PUT', '/api/settings', bad); assert.equal(r.code, 400, JSON.stringify(bad) + ' -> ' + JSON.stringify(r));
      }
    } finally { settings({ aiProvider: undefined, aiProviders: undefined, aiUseEnvKey: undefined }); }
  });
  await test('PUT /api/settings: aiProvider from the list only, model names checked, the env-key choice a boolean', async () => {
    let r = await route(routeLibrary, 'PUT', '/api/settings', { aiProvider: 'codex', aiProviders: { codex: { model: 'gpt-5.1-codex', categoryModel: '' } }, aiUseEnvKey: { codex: false } });
    assert.equal(r.code, 200, JSON.stringify(r)); assert.equal(r.data.aiProvider, 'codex');
    const s = core.readJSON(core.SETTINGS_FILE, {});
    assert.equal(s.aiProvider, 'codex'); assert.deepEqual(s.aiProviders, { codex: { model: 'gpt-5.1-codex' } }); assert.deepEqual(s.aiUseEnvKey, { codex: false });
    for (const bad of [{ aiProvider: 'openai' }, { aiProviders: { codex: { model: 'x; rm -rf /' } } }, { aiProviders: { claude: { model: 'opus' } } }, { aiUseEnvKey: { codex: 'yes' } }, { aiProviders: { codex: { model: '--dangerously-bypass' } } }]) {
      r = await route(routeLibrary, 'PUT', '/api/settings', bad); // (an option-like model name included)
      assert.equal(r.code, 400, JSON.stringify(bad) + ' -> ' + JSON.stringify(r));
    }
    r = await route(routeLibrary, 'PUT', '/api/settings', { aiProvider: 'claude', aiProviders: { codex: { model: '' } } });
    assert.equal(r.code, 200); const s2 = core.readJSON(core.SETTINGS_FILE, {});
    assert.ok(!('aiProvider' in s2) && !('aiProviders' in s2), 'claude and empty models leave no keys behind: ' + JSON.stringify(s2));
    settings({ aiUseEnvKey: undefined });
  });
  await test('GET /api/ai/providers: the four providers, their capabilities and hints, no secret', async () => {
    const r = await route(routeAi, 'GET', '/api/ai/providers');
    assert.equal(r.code, 200); assert.equal(r.data.current, 'claude');
    assert.deepEqual(r.data.providers.map((p) => p.id), ['claude', 'codex', 'grok', 'antigravity']);
    const g = r.data.providers.find((p) => p.id === 'antigravity');
    assert.equal(g.bin, 'agy'); assert.equal(g.label, 'Antigravity'); assert.equal(g.vendor, 'Google'); assert.equal(g.login, 'agy');
    assert.equal(g.install.mac, 'curl -fsSL https://antigravity.google/cli/install.sh | bash'); assert.equal(g.install.win, 'irm https://antigravity.google/cli/install.ps1 | iex');
    assert.ok(!g.install.alt, 'no Homebrew line: no official cask was found'); assert.equal(g.caps.agentic, false); assert.equal(g.caps.sessions, true);
    const c = r.data.providers.find((p) => p.id === 'codex');
    assert.equal(c.caps.readsPdf, false); assert.equal(c.caps.agentic, false); assert.equal(c.login, 'codex login'); assert.match(c.install.mac, /@openai\/codex/);
    assert.ok(!/sk-fake|xai-fake|gm-fake/.test(JSON.stringify(r.data)), 'no key value in the answer');
  });
  // Antigravity has no sign-in check without a model call: "unknown until the first call", honestly
  await test('status antigravity: installed and version from `agy --version` only; signed in is unknown (null) with a hint', async () => {
    clearLog(); state('ok');
    const dir = path.join(h.HOME, '.gemini', 'antigravity-cli');
    fs.rmSync(dir, { recursive: true, force: true });
    let r = await route(routeAi, 'GET', '/api/ai/status?p=antigravity&fresh=1'), s = r.data.status.antigravity;
    assert.equal(s.installed, true, JSON.stringify(s)); assert.equal(s.version, '9.8.7', 'the fake agy answered (the real one is 1.5.14)'); assert.equal(s.signedIn, null);
    assert.match(s.warning, /not been set up.*run “agy” once/);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'settings.json'), '{"secret":"never-read"}');
    s = await ai.status('antigravity', { fresh: true });
    assert.equal(s.signedIn, null); assert.match(s.warning, /does not check the Antigravity sign-in.*shows at the first call/); assert.ok(!JSON.stringify(s).includes('never-read'));
    settings({ aiUseEnvKey: { antigravity: true } });
    s = await ai.status('antigravity', { fresh: true });
    settings({ aiUseEnvKey: undefined });
    assert.equal(s.signedIn, true); assert.match(s.account, /GEMINI_API_KEY/);
    const calls = readLog();
    assert.ok(calls.length === 3 && calls.every((c) => c.p === 'antigravity' && c.argv.length === 1 && c.argv[0] === '--version'), JSON.stringify(calls.map((c) => c.argv)));
    assert.ok(calls.every((c) => real(c.cwd) === real(ai.PANEL_DIR)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ================= status, never a model call =================
  for (const id of ['codex', 'grok']) {
    await test(`status ${id}: installed, version, signed in - and no model call (only --version / login status / usage)`, async () => {
      clearLog(); state('ok'); grokAuth(true);
      const r = await route(routeAi, 'GET', '/api/ai/status?p=' + id + '&fresh=1');
      settings({ aiUseEnvKey: undefined });
      const s = r.data.status[id];
      assert.equal(s.installed, true, JSON.stringify(s)); assert.match(s.version, /^\d+\.\d+\.\d+$/); assert.equal(s.signedIn, true, JSON.stringify(s));
      const calls = readLog();
      assert.ok(calls.length >= 1 && calls.every((c) => c.p === id && ['--version', 'login', 'usage'].includes(c.argv[0])), JSON.stringify(calls.map((c) => c.argv)));
      assert.ok(calls.every((c) => !c.argv.includes('exec') && !c.argv.includes('-p')));
      if (id === 'grok') assert.deepEqual(calls.map((c) => c.argv[0]), ['--version'], 'grok: no `grok usage` (network, background service)');
      assert.ok(calls.every((c) => real(c.cwd) === real(ai.PANEL_DIR)), 'status runs in the empty panel folder: ' + calls.map((c) => c.cwd));
    });
    await test(`status ${id}: signed out is reported as such`, async () => {
      state('signedout'); grokAuth(false);
      const s = await ai.status(id, { fresh: true });
      assert.equal(s.signedIn, false, JSON.stringify(s));
      state('ok'); settings({ aiUseEnvKey: undefined }); grokAuth(true);
    });
  }
  await test('status: a CLI that is not installed -> installed false (nothing else is run)', async () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    const old = process.env[key];
    // only an empty folder: never the machine's PATH, where a real codex / gemini / grok / agy may be installed
    const empty = path.join(h.TOP, 'empty-bin'); fs.mkdirSync(empty, { recursive: true });
    process.env[key] = empty;
    try { for (const id of OTHERS) { const s = await ai.status(id, { fresh: true }); assert.equal(s.installed, false, id + ' ' + JSON.stringify(s)); } }
    finally { process.env[key] = old; }
  });

  // ================= every call path through every provider =================
  const CLAUDE_ONLY = new Set(['account-status']); // the Claude Code account dialog
  for (const id of OTHERS) {
    settings({ aiProvider: id }); state('ok');
    for (const name of Object.keys(PATHS)) {
      if (CLAUDE_ONLY.has(name)) continue;
      settings({ aiProvider: id });
      const before = usageLines().length;
      const r = await runPath(name);
      await test(`${id} ${name}`, () => {
        const calls = featureCalls(r.calls);
        if (name === 'ask-image' && !ai.provider(id).caps.readsImage) {
          assert.ok(!r.ok && /cannot look at pictures/.test(String(r.detail)), 'refused before a spawn: ' + String(r.detail).slice(0, 200));
          assert.equal(r.calls.length, 0, 'nothing was started');
          return;
        }
        assert.ok(r.ok, 'the feature failed: ' + JSON.stringify(r.detail).slice(0, 600));
        assert.ok(r.calls.every((c) => c.p === id), 'only the ' + id + ' fake ran: ' + r.calls.map((c) => c.p));
        if (name === 'api-status') { assert.equal(r.detail.data.ai.provider, id); assert.equal(r.detail.data.ai.installed, true); assert.ok(!('claude' in r.detail.data)); return; }
        assert.ok(calls.length >= 1, 'one call at least');
        for (const c of calls) {
          const argv = c.argv.join('\u0001');
          assert.ok(!/SENTINEL-|Diffusion Policies|learns actions|Line two/.test(argv), 'user text in argv: ' + argv.slice(0, 300));
          assert.ok(RO[id](c.argv), 'read-only flags: ' + c.argv.join(' '));
          for (const k of KEYS) assert.ok(!c.envKeys.includes(k), k + ' must be dropped for ' + id);
          const prompt = id === 'grok' ? c.promptFile : c.stdin;
          assert.ok(prompt && prompt.length > 50, 'the prompt came on stdin / in the prompt file');
          if (id === 'grok') { assert.equal(c.stdin, null); assert.ok(!fs.existsSync(c.promptFilePath), 'the prompt file is removed'); }
          if (name.startsWith('chat')) {
            if (id === 'codex') assert.equal(real(c.cwd), real(WS));
            else {
              // an empty folder of its own, never the workspace (whose .grok / .agents would be loaded); the workspace added
              assert.equal(real(c.cwd), real(ai.PANEL_DIR), 'the panel runs in the empty panel folder: ' + c.cwd);
              assert.ok(!real(c.cwd).startsWith(real(WS) + path.sep), 'outside the workspace');
              if (name === 'chat') assert.equal(c.argv[c.argv.indexOf('--add-dir') + 1], WS, c.argv.join(' '));
              if (id === 'antigravity') assert.ok(!JSON.parse(c.argv[c.argv.indexOf('--settings') + 1]).permissions.deny.includes('read_file(*)'), 'the panel may read files');
              const prompt = id === 'grok' ? c.promptFile : c.stdin;
              if (name === 'chat') assert.ok(prompt.includes('relative to the workspace folder ' + WS), 'the paths named in the context are the workspace\'s');
            }
          }
          else if (id === 'antigravity' && name !== 'api-status') assert.ok(JSON.parse(c.argv[c.argv.indexOf('--settings') + 1]).permissions.deny.includes('read_file(*)'), 'a feature call reads no file');
          if (!name.startsWith('chat')) { assert.ok(c.cwd.startsWith(TMP + path.sep) || fs.realpathSync(path.dirname(c.cwd)) === fs.realpathSync(TMP) || c.cwd.includes('ai-tmp'), 'feature calls run in an empty temp folder: ' + c.cwd); assert.ok(!fs.existsSync(c.cwd), 'and it is removed: ' + c.cwd); }
        }
        if (/^(ask|translate|draft|quiz|diagram|compare|rewrite|related-work|key-points|grouping)/.test(name)) {
          const u = usageLines().slice(before);
          assert.ok(u.length >= 1 && u.every((l) => l.p === id), 'usage lines carry the provider: ' + JSON.stringify(u));
          if (id !== 'grok') assert.ok(u.every((l) => !('usd' in l)), 'no cost where the CLI reports none');
        }
        if (name === 'ask-image') { const a = calls[0].argv, i = a.indexOf('-i'); assert.ok(i > 0 && a[i + 1].endsWith('.png') && a[i + 2] === '-s', a.join(' ')); }
        if (id === 'codex' && !name.startsWith('chat') && name !== 'api-status') { const a = calls[0].argv.join(' '); assert.ok(/features\.shell_tool=false/.test(a) && /web_search="disabled"/.test(a) && /shell_environment_policy\.inherit="core"/.test(a), 'codex feature calls: no shell, no web: ' + a); }
        if (name.startsWith('draft')) {
          const prompt = id === 'grok' ? calls[0].promptFile : calls[0].stdin;
          assert.ok(/\[p\. 1\]/.test(prompt) && /\[p\. 3\]/.test(prompt), 'the draft is written from the extracted text with its page markers');
          assert.ok(!calls[0].argv.includes('Read'), 'no tools');
        }
        if (name === 'chat-resume') {
          const a = calls[0].argv;
          assert.ok(id === 'codex' ? a[1] === 'resume' && a[2] === '11111111-2222-4333-8444-555555555555'
            : id === 'antigravity' ? a[a.indexOf('--conversation') + 1] === '055a398f-db14-4c5f-abbb-1bf03f8120a7' : a.includes('-r'), 'resumes the session: ' + a.join(' '));
          assert.ok(!a.includes('--ephemeral'));
        }
        if (name === 'grouping-model') { const want = { codex: 'gpt-fake-mini', grok: 'grok-fake-fast', antigravity: 'agy-fake-flash' }[id], a = calls[0].argv; assert.equal(a[a.indexOf(id === 'antigravity' ? '--model' : '-m') + 1], want, 'the category model: ' + a.join(' ')); }
        if (id === 'antigravity' && !name.startsWith('chat') && name !== 'api-status') { const a = calls[0].argv; assert.ok(['low', 'medium'].includes(a[a.indexOf('--effort') + 1]), 'an effort: ' + a.join(' ')); }
      });
    }
  }

  // ================= failure modes =================
  const ask = () => notes.askAbout(h.it(A), { mode: 'ask', question: 'Why?', kind: 'note', text: 'The method learns actions.', language: 'en' }).then((x) => ({ ok: true, x }), (e) => ({ ok: false, e }));
  for (const id of OTHERS) {
    settings({ aiProvider: id });
    await test(`${id}: not signed in -> a readable error that names the Terminal command`, async () => {
      state('signedout'); const r = await ask(); state('ok');
      assert.ok(!r.ok); assert.match(r.e.message, id === 'antigravity' ? /Not signed in to Antigravity\. Run “agy” in a terminal and sign in with Google/ : new RegExp(`Not signed in to .*${id} login`, 'i'));
    });
    await test(`${id}: usage limit -> the provider's message`, async () => {
      state('quota'); const r = await ask(); state('ok');
      assert.ok(!r.ok); assert.match(r.e.message, /usage limit|limit/i);
    });
    await test(`${id}: output that cannot be read -> an error, never garbage as the answer`, async () => {
      state('malformed'); const r = await ask(); state('ok');
      assert.ok(!r.ok, 'must fail: ' + JSON.stringify(r.x)); assert.match(r.e.message, /no answer that ResearchTool could read|exited/);
    });
    await test(`${id}: an unknown resume id in the panel -> lost, the panel starts a new conversation`, async () => {
      state('lost'); const r = await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'again', sessionId: '99999999-2222-4333-8444-555555555555', context: {} }); state('ok');
      const done = (r.events || []).find((e) => e.type === 'done');
      assert.ok(done && done.isError && done.lost === true && done.sessionId === null, JSON.stringify(r.events));
    });
    await test(`${id}: the panel answer streams (session, text or deltas, done) and adds the read-only note`, async () => {
      clearLog();
      const r = await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'Hello SENTINEL-x', context: { itemId: A } });
      const ev = r.events || [];
      const done = ev[ev.length - 1];
      // (Grok names the session at the end of the stream only)
      assert.ok(ev.some((e) => e.type === 'session') && ev.some((e) => e.type === 'delta' || e.type === 'text') && done.type === 'done' && done.sessionId && !done.isError, JSON.stringify(ev).slice(0, 400));
      const c = featureCalls(readLog())[0], prompt = id === 'grok' ? c.promptFile : c.stdin;
      assert.match(prompt, /read-only sandbox/); assert.ok(!/Edit the project files in place/.test(prompt));
      assert.ok(prompt.indexOf('<instructions>') === 0 && prompt.indexOf('Hello SENTINEL-x') > prompt.indexOf('</instructions>'));
    });
  }
  settings({ aiProvider: 'codex', aiMode: 'balanced' });
  await test('codex: an unknown effort config key -> the call is made again without it, and it is not sent again', async () => {
    clearLog(); state('badconfig');
    const r = await ai.run([], { input: 'x', timeout: 20000 }, { kind: 'heavy' });
    const r2 = await ai.run([], { input: 'y', timeout: 20000 }, { kind: 'heavy' });
    state('ok');
    const calls = featureCalls(readLog());
    assert.equal(r.code, 0, JSON.stringify(r)); assert.equal(r2.code, 0);
    assert.equal(calls.length, 3); assert.ok(calls[0].argv.includes('model_reasoning_effort="medium"')); assert.ok(!calls[1].argv.join(' ').includes('effort') && !calls[2].argv.join(' ').includes('effort'));
  });
  settings({ aiMode: undefined });

  // ================= the review's findings: read-only must fail closed =================
  settings({ aiProvider: 'grok' });
  await test('grok: "sandbox could not be applied" on stderr -> the run is stopped and reported, the answer is never used', async () => {
    clearLog(); state('nosandbox');
    const r = await ai.run([], { input: 'SENTINEL-nosb', timeout: 20000 }, {});
    state('ok');
    assert.notEqual(r.code, 0, JSON.stringify(r)); assert.match(r.err, /could not apply its read-only sandbox/);
    assert.ok(!/Fake answer/.test(r.out), 'no answer: ' + r.out.slice(0, 200));
    const res = new h.FakeRes();
    state('nosandbox'); await quiz.generate(h.it(A), { count: quiz.COUNTS[0], level: 'core', focus: '', language: 'en', res }); await res.done; state('ok');
    const ev = res.events();
    assert.ok(!ev.some((e) => e.type === 'done') && ev.some((e) => e.type === 'error' && /sandbox/.test(e.text)), JSON.stringify(ev).slice(0, 400));
  });
  await test('grok: a Grok that ignores the tool allowlist ("names no tool, so other tools stay available") is stopped', () => {
    assert.match(grok.unsafe("warning: --tools: 'todo_write' names no tool, so other tools stay available"), /did not accept/);
    assert.match(grok.unsafe('always-approve is active while prompt_policy is dontAsk (Deny); unapproved tools will not be auto-denied'), /did not accept/);
    assert.match(grok.unsafe('This build of Grok has no sandbox enforcement.'), /sandbox/);
    assert.equal(grok.unsafe("warning: --disallowed-tools: 'Shell' names no tool, so it removes nothing"), null, 'an unknown deny entry is harmless');
  });
  await test('panel session ids: an option-like value (leading "-") is never resumed, for any provider', async () => {
    assert.ok(ai.SESSION_RE.test('11111111-2222-4333-8444-555555555555'));
    for (const bad of ['--------', '-cdeadbeef', '-eeeeeeee', '-e', 'abc', '1234567g']) assert.ok(!ai.SESSION_RE.test(bad), bad);
    for (const id of ['claude', ...OTHERS]) {
      settings({ aiProvider: id }); clearLog();
      await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'hi', sessionId: '-eeeeeeee', context: {} });
      const c = readLog().find((x) => x.p === id && !['--version', 'auth', 'login'].includes(x.argv[0]));
      assert.ok(c && !c.argv.includes('-eeeeeeee'), id + ': ' + (c && c.argv.join(' ')));
    }
  });
  settings({ aiProvider: 'codex' });
  await test('codex: where the user keeps the Codex sign-in (config.toml) is passed on, nothing else of that file', async () => {
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "o9-fake"\ncli_auth_credentials_store = "keyring"\n[mcp_servers.x]\ncommand = "evil"\n');
    clearLog(); await ai.run([], { input: 'x', timeout: 20000 }, {});
    const a = featureCalls(readLog())[0].argv;
    assert.ok(a.includes('cli_auth_credentials_store="keyring"') && !a.join(' ').includes('o9-fake') && a.includes('--ignore-user-config'), a.join(' '));
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'cli_auth_credentials_store = "x\\" -c evil"\n');
    clearLog(); await ai.run([], { input: 'x', timeout: 20000 }, {});
    assert.ok(!featureCalls(readLog())[0].argv.some((x) => /cli_auth|evil/.test(x)), 'an odd value is not passed');
    fs.rmSync(path.join(process.env.CODEX_HOME, 'config.toml'));
  });
  // ================= "Let Codex edit files": the opt-in write mode of the Codex panel =================
  const codexP = require('../../../lib/ai/providers/codex');
  const routeClaude = require('../../../lib/routes/claude');
  const BASE = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules'];
  const SAFE = ['-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="core"'];
  const WSAFE = ['-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'];
  const SID = '11111111-2222-4333-8444-555555555555';
  await test('codex argv, read-only (not opted in): exactly as before the write mode (golden), with or without write: false', () => {
    const ws = path.join(h.TOP, 'ws-x');
    const chat = ['exec', ...BASE, '-s', 'read-only', '-C', ws, ...SAFE, '-'];
    const resume = ['exec', 'resume', SID, ...BASE, '-c', 'sandbox_mode="read-only"', ...SAFE, '-'];
    const feature = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', ws, ...SAFE,
      '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-m', 'gpt-fake', '-c', 'model_reasoning_effort="low"', '-'];
    for (const o of [{}, { write: false }, { write: undefined, addDirs: ['/ext/proj'] }]) {
      assert.deepEqual(codexP.args({ mode: 'chat', cwd: ws, ...o }), chat, JSON.stringify(o));
      assert.deepEqual(codexP.args({ mode: 'chat', cwd: ws, session: SID, ...o }), resume, JSON.stringify(o));
    }
    // a feature call never writes, whatever it is handed
    for (const write of [false, true]) assert.deepEqual(codexP.args({ mode: 'feature', cwd: ws, model: 'gpt-fake', effort: 'low', write, addDirs: ['/ext/proj'] }), feature);
  });
  await test('codex argv, write mode: workspace-write, approvals never, no network, no /tmp or $TMPDIR; an external project writable', () => {
    const ws = path.join(h.TOP, 'ws-x');
    assert.deepEqual(codexP.args({ mode: 'chat', cwd: ws, write: true }), ['exec', ...BASE, '-s', 'workspace-write', '-C', ws, ...SAFE, ...WSAFE, '-']);
    assert.deepEqual(codexP.args({ mode: 'chat', cwd: ws, write: true, session: SID, model: 'gpt-fake' }),
      ['exec', 'resume', SID, ...BASE, '-c', 'sandbox_mode="workspace-write"', ...SAFE, ...WSAFE, '-m', 'gpt-fake', '-']);
    // the external project: --add-dir for a new chat (exec has it), the writable_roots key for a resume (it has none)
    assert.deepEqual(codexP.args({ mode: 'chat', cwd: ws, write: true, addDirs: ['/Users/x/My Paper'] }), ['exec', ...BASE, '-s', 'workspace-write', '-C', ws, ...SAFE, ...WSAFE, '--add-dir', '/Users/x/My Paper', '-']);
    assert.deepEqual(codexP.args({ mode: 'chat', cwd: ws, write: true, session: SID, addDirs: ['/Users/x/My Paper'] }),
      ['exec', 'resume', SID, ...BASE, '-c', 'sandbox_mode="workspace-write"', ...SAFE, ...WSAFE, '-c', 'sandbox_workspace_write.writable_roots=["/Users/x/My Paper"]', '-']);
    // a Windows path keeps its backslashes, a quote is escaped: a TOML basic string (and JSON reads it the same)
    const win = 'C:\\Users\\a "b"\\proj';
    assert.equal(codexP.tomlStr(win), '"C:\\\\Users\\\\a \\"b\\"\\\\proj"');
    assert.equal(JSON.parse(codexP.tomlStr(win)), win);
    const odd = path.join(path.parse(ws).root, 'x "q"', 'back\\slash', 'p'); // (absolute on this OS)
    const a = codexP.args({ mode: 'chat', cwd: ws, write: true, session: SID, addDirs: [odd, 'relative/never'] });
    const wr = a.find((x) => x.startsWith('sandbox_workspace_write.writable_roots='));
    assert.equal(wr, `sandbox_workspace_write.writable_roots=[${codexP.tomlStr(odd)}]`);
    assert.deepEqual(JSON.parse(wr.slice(wr.indexOf('=') + 1)), [odd], 'only absolute folders, the value read back unchanged');
    assert.equal(codexP.tomlStr('a\nb\u0001'), '"a\\u000ab\\u0001"');
    // never anything that widens it
    for (const x of [a, codexP.args({ mode: 'chat', cwd: ws, write: true })]) assert.ok(!x.some((y) => /danger|network_access=true|--approve-for-me|--trust|--dangerously/.test(y)), x.join(' '));
  });
  await test('aiPanelEdits: booleans only, only for a provider that supports it (Codex); Grok, Antigravity and Claude are refused', async () => {
    let r = await route(routeLibrary, 'PUT', '/api/settings', { aiPanelEdits: { codex: true } });
    assert.equal(r.code, 200, JSON.stringify(r)); assert.deepEqual(core.readJSON(core.SETTINGS_FILE, {}).aiPanelEdits, { codex: true });
    for (const bad of [{ aiPanelEdits: { codex: 'yes' } }, { aiPanelEdits: { codex: 1 } }, { aiPanelEdits: { grok: true } }, { aiPanelEdits: { antigravity: true } }, { aiPanelEdits: { claude: true } },
      { aiPanelEdits: { gemini: true } }, { aiPanelEdits: [true] }, { aiPanelEdits: null }, { aiPanelEdits: true }]) {
      r = await route(routeLibrary, 'PUT', '/api/settings', bad); assert.equal(r.code, 400, JSON.stringify(bad) + ' -> ' + JSON.stringify(r));
    }
    assert.deepEqual(core.readJSON(core.SETTINGS_FILE, {}).aiPanelEdits, { codex: true }, 'a refused body changes nothing');
    r = await route(routeLibrary, 'PUT', '/api/settings', { aiPanelEdits: { codex: false } });
    assert.equal(r.code, 200); assert.ok(!('aiPanelEdits' in core.readJSON(core.SETTINGS_FILE, {})), 'off leaves no key behind');
    // a hand-edited settings.json with a non-boolean or an unsupported provider is no opt-in
    for (const v of [{ codex: 'true' }, { codex: 1 }, { grok: true }, 'codex']) { settings({ aiProvider: 'codex', aiPanelEdits: v }); assert.equal(ai.panelEdits('codex'), false, JSON.stringify(v)); assert.equal(ai.caps().agentic, false); }
    settings({ aiProvider: 'grok', aiPanelEdits: { grok: true } }); assert.equal(ai.caps().agentic, false); assert.equal(ai.panelWrites(), false);
    settings({ aiProvider: undefined, aiPanelEdits: undefined });
  });
  await test('ai.caps() and /api/ai/providers follow the opt-in: agentic for Codex only when ticked; Grok and Antigravity never', async () => {
    const prov = async () => (await route(routeAi, 'GET', '/api/ai/providers')).data.providers;
    settings({ aiProvider: 'codex', aiPanelEdits: undefined });
    assert.equal(ai.caps().agentic, false); assert.equal(ai.panelWrites(), false);
    let ps = await prov(), c = ps.find((p) => p.id === 'codex');
    assert.equal(c.caps.agentic, false); assert.equal(c.panelWrite, true); assert.equal(c.panelEdits, false);
    for (const id of ['grok', 'antigravity']) { const p = ps.find((x) => x.id === id); assert.equal(p.panelWrite, false); assert.equal(p.panelEdits, false); assert.equal(p.caps.agentic, false); }
    settings({ aiPanelEdits: { codex: true } });
    assert.equal(ai.caps().agentic, true); assert.equal(ai.panelWrites(), true);
    ps = await prov(); c = ps.find((p) => p.id === 'codex');
    assert.equal(c.caps.agentic, true); assert.equal(c.panelEdits, true); assert.equal(c.caps.readsPdf, false, 'the other capabilities stay');
    assert.equal(ai.PROVIDERS.codex.caps.agentic, false, 'the provider module itself is not changed');
    // another provider chosen: the Codex opt-in does not carry over; Claude stays agentic
    settings({ aiProvider: 'grok' }); assert.equal(ai.caps().agentic, false); assert.equal(ai.panelWrites(), false);
    settings({ aiProvider: undefined }); assert.equal(ai.caps().agentic, true); assert.equal(ai.panelWrites(), false, 'Claude: its own panel, no write mode');
    settings({ aiPanelEdits: undefined });
  });

  // a LaTeX project the fake codex edits (FAKE_AI_WRITE), inside the workspace and outside it
  const proj = core.P.create('CodexEdit', { template: 'blank' });
  const extDir = path.join(h.TOP, 'ext-codex-proj'); fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'main.tex'), '\\documentclass{article}\\begin{document}External\\end{document}\n');
  const ext = core.P.openFolder(extDir);
  const routeProjects = require('../../../lib/routes/projects');
  const versions = (p, file = 'main.tex') => core.H.list(p.id, file, 100);
  const panel = (p, sessionId, extra = {}) => route(routeClaude, 'POST', '/api/claude', { prompt: 'Fix the title SENTINEL-w', ...(sessionId ? { sessionId } : {}), context: { projectId: p.id, file: 'main.tex' }, ...extra });
  const backups = () => { try { return fs.readdirSync(path.join(WS, 'backups')).filter((n) => /^library-\d.*\.json$/.test(n)).sort(); } catch { return []; } };
  const lastCodex = () => featureCalls(readLog()).filter((c) => c.p === 'codex').pop();
  const NOTES = real(path.join(WS, 'notes'));
  const roots = (c) => { const r = []; c.argv.forEach((x, i) => { if (x === '--add-dir') r.push(c.argv[i + 1]); }); return r; };
  const holdFile = path.join(h.TOP, 'hold-codex');
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // a panel run that waits (FAKE_AI_HOLD) until `during()` has looked at the app and changed files
  async function heldPanel(p, during) {
    fs.rmSync(holdFile, { force: true }); process.env.FAKE_AI_HOLD = holdFile; clearLog();
    const run = panel(p);
    let failed = null; // (the run is always waited for, so that a failed check leaves nothing going for the next test)
    try {
      for (let i = 0; i < 400 && !lastCodex(); i++) await settle(25);
      assert.ok(lastCodex(), 'the fake codex was started');
      await during();
    } catch (e) { failed = e; } finally { fs.writeFileSync(holdFile, ''); }
    const r = await run; delete process.env.FAKE_AI_HOLD; fs.rmSync(holdFile, { force: true });
    if (failed) throw failed;
    return r;
  }
  try {
    await test('codex write mode, a project in the workspace: the file is changed, the history keeps a baseline and a version by codex', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: { codex: true } }); state('ok');
      const file = path.join(proj.path, 'main.tex'), before = fs.readFileSync(file, 'utf8');
      process.env.FAKE_AI_WRITE = file; clearLog();
      fs.rmSync(path.join(WS, 'backups'), { recursive: true, force: true });
      const r = await panel(proj);
      const done = (r.events || []).find((e) => e.type === 'done');
      assert.ok(done && !done.isError, JSON.stringify(r.events).slice(0, 500));
      const c = lastCodex();
      assert.equal(c.wrote, file, 'the fake wrote the file: ' + JSON.stringify(c.roots));
      assert.equal(c.argv[c.argv.indexOf('-s') + 1], 'workspace-write');
      // its own empty folder (outside the workspace) is the -C folder; the project and the notes are the added ones
      assert.equal(real(c.argv[c.argv.indexOf('-C') + 1]), real(ai.WRITE_PANEL_DIR)); assert.equal(real(c.cwd), real(ai.WRITE_PANEL_DIR));
      assert.deepEqual(roots(c), [real(proj.path), NOTES]);
      assert.ok(c.stdin.includes(ai.WRITE_NOTE) && c.stdin.includes('Edit the project files in place') && !/read-only sandbox/.test(c.stdin), 'the write note instead of the read-only note');
      assert.ok(c.stdin.includes(`relative to the workspace folder ${WS}`) || !c.stdin.includes('relative to the folder you run in'), 'paths are named relative to the workspace');
      assert.ok((r.events || []).some((e) => e.type === 'tool' && e.name === 'Edit'), 'the edit is shown in the panel');
      assert.equal(fs.readFileSync(file, 'utf8'), before + '% edited by fake codex\n');
      const vs = versions(proj);
      assert.equal(vs.length, 2, JSON.stringify(vs)); assert.equal(vs[0].source, 'claude'); assert.equal(vs[0].by, 'codex'); assert.equal(vs[1].source, 'baseline');
      assert.equal(core.claudeActive.get(proj.id), undefined, 'the run is over'); assert.equal(core.aiActiveBy.get(proj.id), undefined);
      // library.json was copied right before the run (Codex has a shell)
      const b = backups(); assert.ok(b.length >= 1, 'a library copy'); assert.ok(fs.readFileSync(path.join(WS, 'backups', b[b.length - 1])).equals(fs.readFileSync(core.LIB_FILE)));
      const n = b.length; await panel(proj); assert.equal(backups().length, n, 'not a second identical copy');
      // the resumed conversation keeps the write mode: sandbox_mode and the writable roots as config keys (resume takes
      // no -s / -C / --add-dir) and runs in the same empty folder
      clearLog(); const r2 = await panel(proj, SID);
      assert.ok((r2.events || []).some((e) => e.type === 'done' && !e.isError));
      const c2 = lastCodex(); assert.equal(c2.argv[1], 'resume'); assert.ok(c2.argv.includes('sandbox_mode="workspace-write"') && !c2.argv.includes('-s') && c2.wrote === file, c2.argv.join(' '));
      assert.ok(c2.argv.includes(`sandbox_workspace_write.writable_roots=[${codexP.tomlStr(real(proj.path))}, ${codexP.tomlStr(NOTES)}]`), c2.argv.join(' '));
      assert.equal(real(c2.cwd), real(ai.WRITE_PANEL_DIR));
      assert.ok(versions(proj).filter((v) => v.by === 'codex').length >= 2);
    });
    await test('codex write mode: the workspace is never writable - settings.json, library.json, history, backups and its agent files stay as they are', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: { codex: true } });
      fs.mkdirSync(path.join(WS, 'backups'), { recursive: true });
      const hist = core.H.dir(proj.id); fs.mkdirSync(hist, { recursive: true });
      const targets = [core.SETTINGS_FILE, core.LIB_FILE, path.join(WS, 'backups', 'library-x.json'), path.join(hist, 'planted.json'), path.join(WS, 'CLAUDE.md'), path.join(WS, 'AGENTS.md'), path.join(WS, '.claude', 'settings.json'), path.join(WS, '.mcp.json')];
      const before = targets.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
      for (const [i, sid] of [[0, null], [1, SID]]) {
        process.env.FAKE_AI_WRITE = [path.join(proj.path, 'main.tex'), ...targets].join(path.delimiter); clearLog();
        const r = await panel(proj, sid);
        assert.ok((r.events || []).some((e) => e.type === 'done' && !e.isError), i + JSON.stringify(r).slice(0, 300));
        const c = lastCodex();
        assert.deepEqual(c.wroteAll, [path.join(proj.path, 'main.tex')], 'only the project file: ' + JSON.stringify(c.roots));
        for (const r0 of c.roots) assert.ok(!core.plat.insideAnyCase(real(r0), real(WS)), 'never the workspace or a folder that holds it: ' + r0);
      }
      targets.forEach((f, i) => assert.deepEqual(fs.existsSync(f) ? fs.readFileSync(f) : null, before[i], f));
    });
    await test('codex write mode, an external project: --add-dir for a new chat, writable_roots for a resume; versions by codex', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: { codex: true } });
      const file = path.join(ext.path, 'main.tex'); process.env.FAKE_AI_WRITE = file;
      clearLog(); await panel(ext);
      let c = lastCodex();
      assert.deepEqual(roots(c), [real(ext.path), NOTES]); assert.equal(c.wrote, file, JSON.stringify(c.roots));
      clearLog(); await panel(ext, SID);
      c = lastCodex();
      assert.ok(c.argv.includes(`sandbox_workspace_write.writable_roots=[${codexP.tomlStr(real(ext.path))}, ${codexP.tomlStr(NOTES)}]`) && !c.argv.includes('--add-dir'), c.argv.join(' '));
      assert.equal(c.wrote, file, JSON.stringify(c.roots));
      const vs = versions(ext);
      assert.ok(vs.filter((v) => v.source === 'claude' && v.by === 'codex').length === 2 && vs.some((v) => v.source === 'baseline'), JSON.stringify(vs));
      // a file outside every writable root is not written (the fake sandbox, like the real one)
      process.env.FAKE_AI_WRITE = path.join(h.TOP, 'outside.tex'); fs.writeFileSync(process.env.FAKE_AI_WRITE, 'x\n');
      clearLog(); await panel(ext); assert.equal(lastCodex().wrote, null); assert.equal(fs.readFileSync(process.env.FAKE_AI_WRITE, 'utf8'), 'x\n');
    });
    await test('an external project whose settings.json entry was changed is never handed to the AI (home, disk, workspace, another folder)', async () => {
      const saved = core.readJSON(core.SETTINGS_FILE, {}).externalProjects;
      const idOf = (p) => 'ext-' + crypto.createHash('sha1').update(real(p)).digest('hex').slice(0, 10);
      const other = path.join(h.TOP, 'other-folder'); fs.mkdirSync(other, { recursive: true });
      const homeId = idOf(os.homedir());
      const cases = [
        ['the path of an existing entry changed (same id)', saved.map((e) => (e.id === ext.id ? { ...e, path: other } : e)), ext.id],
        ['the home folder, with the id it would get', [...saved, { id: homeId, path: os.homedir() }], homeId],
        ['a folder that holds the workspace', [...saved, { id: idOf(h.TOP), path: h.TOP }], idOf(h.TOP)],
        ['the workspace itself', [...saved, { id: idOf(WS), path: WS }], idOf(WS)],
        ['a folder inside the workspace', [...saved, { id: idOf(path.join(WS, 'history')), path: path.join(WS, 'history') }], idOf(path.join(WS, 'history'))],
      ];
      try {
        for (const provider of ['codex', undefined, 'grok']) {
          settings({ aiProvider: provider, aiPanelEdits: { codex: true } });
          for (const [what, list, id] of cases) {
            settings({ externalProjects: list }); clearLog();
            const p = core.P.get(id);
            const r = await route(routeClaude, 'POST', '/api/claude', { prompt: 'x SENTINEL-w', context: { projectId: id } });
            assert.equal(r.code, 409, `${provider || 'claude'}: ${what}: ${JSON.stringify(r).slice(0, 300)}`);
            assert.match(String((r.data || (r.events || [])[0] || {}).error), /cannot be given to the AI/); // (core.send: the JSON body)
            assert.equal(readLog().filter((c) => c.argv[0] !== '--version').length, 0, 'no CLI was started: ' + what);
            assert.ok(p.path, what);
          }
        }
        // the entry as openFolder made it is fine
        settings({ externalProjects: saved, aiProvider: 'codex' }); clearLog();
        const r = await panel(ext); assert.ok((r.events || []).some((e) => e.type === 'done'), JSON.stringify(r).slice(0, 300));
        assert.equal(core.P.aiRoot(ext), real(ext.path)); assert.equal(core.P.aiRoot(proj), real(proj.path));
        // (the disk root, checked directly: listing it as a project would walk the whole disk)
        const root = path.parse(WS).root;
        assert.throws(() => core.P.aiRoot({ id: idOf(root), name: 'root', path: root, external: true }), /home folder, a folder that holds it, or a whole disk/);
        assert.throws(() => core.P.aiRoot({ id: proj.id, name: 'x', path: extDir, external: false }), /projects folder/);
      } finally { settings({ externalProjects: saved, aiProvider: undefined }); }
    });
    await test('codex write mode: agent files it plants or changes in the project and the notes go back as they were', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: { codex: true } });
      const keep = path.join(proj.path, 'AGENTS.md'); fs.writeFileSync(keep, '# the user\'s own AGENTS.md\n');
      const kept = path.join(proj.path, '.codex-notes.txt'); // (not an agent file: changes stay)
      const planted = [path.join(proj.path, 'CLAUDE.md'), path.join(proj.path, '.claude', 'settings.json'), path.join(proj.path, 'sub', 'CLAUDE.md'), path.join(NOTES, 'AGENTS.md'), path.join(NOTES, '.mcp.json')];
      for (const f of planted) fs.rmSync(f, { force: true });
      fs.rmSync(path.join(proj.path, '.claude'), { recursive: true, force: true });
      process.env.FAKE_AI_WRITE = [path.join(proj.path, 'main.tex'), keep, kept, ...planted].join(path.delimiter); clearLog();
      const r = await panel(proj);
      const c = lastCodex();
      assert.equal(c.wroteAll.length, 3 + planted.length, 'the fake wrote all of them: ' + JSON.stringify(c.wroteAll));
      for (const f of planted) assert.ok(!fs.existsSync(f), 'removed again: ' + f);
      assert.ok(!fs.existsSync(path.join(proj.path, '.claude')), 'the planted .claude folder is gone');
      assert.equal(fs.readFileSync(keep, 'utf8'), '# the user\'s own AGENTS.md\n', 'a changed agent file has its content back');
      const trashed = []; (function walk(d) { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else trashed.push(f); } })(path.join(WS, 'trash', 'ai-agent-files'));
      assert.ok(trashed.some((f) => path.basename(f) === 'AGENTS.md' && fs.readFileSync(f, 'utf8').includes('edited by fake codex')), 'the changed one is kept in the trash: ' + trashed.join(' '));
      assert.ok(fs.readFileSync(kept, 'utf8').includes('edited by fake codex'), 'other files keep the change');
      assert.ok(fs.readFileSync(path.join(proj.path, 'main.tex'), 'utf8').includes('edited by fake codex'));
      assert.ok(fs.existsSync(path.join(WS, 'trash', 'ai-agent-files')), 'what was planted is in the trash');
      const err = (r.events || []).find((e) => e.type === 'error' && /agent files/.test(e.text));
      assert.ok(err && /CLAUDE\.md/.test(err.text), JSON.stringify(r.events).slice(0, 600));
      assert.ok(!versions(proj, 'AGENTS.md').some((v) => v.source === 'claude'), 'the undone change is not recorded');
      fs.rmSync(keep); fs.rmSync(kept);
      // a run that touches no agent file says nothing about them
      process.env.FAKE_AI_WRITE = path.join(proj.path, 'main.tex'); const r2 = await panel(proj);
      assert.ok(!(r2.events || []).some((e) => e.type === 'error'), JSON.stringify(r2.events).slice(0, 400));
    });
    await test('a file an AI panel run deleted keeps its content from before the run in the history (restorable)', () => {
      const f = path.join(proj.path, 'gone.tex'); fs.writeFileSync(f, 'before the run\n');
      const snap = core.snapshotProject(proj); fs.rmSync(f);
      core.recordClaudeChanges(proj, snap, 'codex');
      const vs = versions(proj, 'gone.tex'); assert.equal(vs.length, 1); assert.equal(vs[0].source, 'baseline');
      assert.equal(core.H.open(proj.id).text(core.H.open(proj.id).find(vs[0].id)), 'before the run\n');
    });
    await test('codex not opted in: the panel stays read-only - argv as before, nothing is written, nothing recorded, no library copy', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: undefined });
      const file = path.join(proj.path, 'main.tex'), before = fs.readFileSync(file, 'utf8'), n = versions(proj).length, nb = backups().length;
      fs.appendFileSync(core.LIB_FILE, ' '); // (a library that differs from its newest copy: a write-mode run would copy it)
      process.env.FAKE_AI_WRITE = file; clearLog();
      const r = await panel(proj);
      assert.ok((r.events || []).some((e) => e.type === 'done' && !e.isError));
      const c = lastCodex();
      assert.deepEqual(c.argv, ['exec', ...BASE, '-s', 'read-only', '-C', c.argv[c.argv.indexOf('-C') + 1], ...SAFE, '-']);
      assert.equal(real(c.argv[c.argv.indexOf('-C') + 1]), real(WS), 'read-only: in the workspace, as before');
      assert.equal(c.wrote, null); assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.ok(/read-only sandbox/.test(c.stdin) && !c.stdin.includes(ai.WRITE_NOTE) && !/Edit the project files in place/.test(c.stdin));
      assert.equal(versions(proj).length, n, 'no version'); assert.equal(backups().length, nb, 'no copy');
    });
    await test('codex not opted in: while the run goes the project is not AI-active, and a change on disk stays an external version', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: undefined }); delete process.env.FAKE_AI_WRITE;
      const file = path.join(proj.path, 'main.tex');
      const r = await heldPanel(proj, async () => {
        assert.equal(core.claudeActive.get(proj.id), undefined); assert.equal(core.aiActiveBy.get(proj.id), undefined); assert.deepEqual(core.diskOpts(proj), {});
        fs.appendFileSync(file, '% the user\'s own edit, in another editor\n');
        const g = await route(routeProjects, 'GET', `/api/projects/${proj.id}/file?path=main.tex`);
        assert.equal(g.code, 200, JSON.stringify(g).slice(0, 300));
      });
      assert.ok((r.events || []).some((e) => e.type === 'done' && !e.isError));
      const v = versions(proj)[0]; assert.equal(v.source, 'external'); assert.ok(!('by' in v), JSON.stringify(v));
    });
    await test('codex write mode: a change the app notices on disk while the run goes is a version by codex', async () => {
      settings({ aiProvider: 'codex', aiPanelEdits: { codex: true } }); delete process.env.FAKE_AI_WRITE;
      const file = path.join(proj.path, 'main.tex');
      const r = await heldPanel(proj, async () => {
        assert.equal(core.claudeActive.get(proj.id), 1); assert.deepEqual(core.diskOpts(proj), { by: 'codex' });
        fs.appendFileSync(file, '% written while the run goes\n');
        const g = await route(routeProjects, 'GET', `/api/projects/${proj.id}/file?path=main.tex`);
        assert.equal(g.code, 200, JSON.stringify(g).slice(0, 300));
        const v = versions(proj)[0]; assert.equal(v.source, 'claude'); assert.equal(v.by, 'codex');
      });
      assert.ok((r.events || []).some((e) => e.type === 'done' && !e.isError));
      assert.equal(core.claudeActive.get(proj.id), undefined);
    });
    await test('changes found on disk during AI panel runs name the provider of a run still going (core.diskOpts); none outside a run', () => {
      assert.deepEqual(core.diskOpts(proj), {});
      try {
        core.aiRunStart(proj.id, 'codex');
        assert.equal(core.diskSource(proj), 'claude'); assert.deepEqual(core.diskOpts(proj), { by: 'codex' });
        // a Claude run in another tab, then the Codex run ends first: the changes are Claude's
        core.aiRunStart(proj.id, 'claude'); assert.deepEqual(core.diskOpts(proj), { by: 'claude' });
        core.aiRunEnd(proj.id, 'codex'); assert.deepEqual(core.diskOpts(proj), { by: 'claude' }); assert.equal(core.claudeActive.get(proj.id), 1);
        core.aiRunEnd(proj.id, 'claude'); assert.deepEqual(core.diskOpts(proj), {});
        // the other way round: the newer Claude run ends first, the older Codex run is still going
        core.aiRunStart(proj.id, 'codex'); core.aiRunStart(proj.id, 'claude'); core.aiRunEnd(proj.id, 'claude');
        assert.deepEqual(core.diskOpts(proj), { by: 'codex' });
        core.aiRunEnd(proj.id, 'codex');
        assert.equal(core.claudeActive.get(proj.id), undefined); assert.equal(core.aiActiveBy.get(proj.id), undefined);
      } finally { core.claudeActive.delete(proj.id); core.aiActiveBy.delete(proj.id); }
    });
    await test('the fake codex refuses workspace-write without the panel\'s write settings (exit 97)', async () => {
      const r = await core.run('codex', ['exec', ...BASE, '-s', 'workspace-write', '-C', WS, ...SAFE, '-'], { input: 'x', timeout: 20000, cwd: h.TOP });
      assert.equal(r.code, 97, JSON.stringify(r));
      const r2 = await core.run('codex', ['exec', '--json', '--ephemeral', '-s', 'workspace-write', '-C', WS, ...WSAFE, '-c', 'features.shell_tool=false', '-'], { input: 'x', timeout: 20000, cwd: h.TOP });
      assert.equal(r2.code, 97, 'never in a feature call');
    });
  } finally { delete process.env.FAKE_AI_WRITE; delete process.env.FAKE_AI_HOLD; settings({ aiProvider: undefined, aiPanelEdits: undefined }); }

  settings({ aiProvider: 'grok' });
  await test('the panel folder of grok / antigravity is emptied before use (a planted .grok / .mcp.json is gone)', async () => {
    fs.mkdirSync(path.join(ai.PANEL_DIR, '.grok'), { recursive: true }); fs.writeFileSync(path.join(ai.PANEL_DIR, '.mcp.json'), '{}');
    clearLog();
    await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'hi', context: {} });
    assert.deepEqual(fs.readdirSync(ai.PANEL_DIR), []);
    const st = fs.statSync(ai.AI_HOME); if (process.platform !== 'win32') assert.equal(st.mode & 0o077, 0, 'the private folder is not readable by others');
    assert.ok(!real(ai.AI_HOME).startsWith(real(WS)), 'outside the workspace');
  });
  // ================= Antigravity: read-only must fail closed, its own failure modes =================
  settings({ aiProvider: 'antigravity' });
  await test('antigravity: the prompt is one stream-json line on stdin ({"event":"user","message":{"content"}}), nothing in argv', async () => {
    clearLog();
    const r = await ai.run([], { input: 'Translate SENTINEL-agy', timeout: 20000 }, {});
    assert.equal(r.code, 0, JSON.stringify(r)); assert.match(JSON.parse(r.out).result, /Fake answer by agy/);
    const c = featureCalls(readLog())[0];
    assert.equal(c.stdinLines, 1); assert.deepEqual(Object.keys(JSON.parse(c.stdinRaw)), ['event', 'message']); assert.ok(c.stdin.endsWith('Translate SENTINEL-agy'));
    assert.ok(!c.argv.some((x) => x.includes('SENTINEL')));
    const u = JSON.parse(r.out).usage; assert.deepEqual([u.input_tokens, u.cache_read_input_tokens, u.output_tokens], [90, 30, 45], 'usage: input minus cached, output plus thinking');
  });
  await test('antigravity: no "@" is ever a file mention (a word joiner after every "@" before a character, taken out of the answer)', async () => {
    clearLog();
    const r = await ai.run([], { input: 'Read @notes/a.md, (@/etc/hosts) "@~/.ssh/id" and mail ada@example.org; a lone @ stays', timeout: 20000 }, {});
    const c = featureCalls(readLog())[0];
    assert.ok(['@\u2060notes/a.md', '(@\u2060/etc/hosts)', '"@\u2060~/.ssh/id"', 'ada@\u2060example.org', 'lone @ stays'].every((x) => c.stdin.includes(x)), c.stdin);
    assert.ok(!/@(?!\u2060)\S/.test(c.stdin), 'no "@" without the word joiner: ' + c.stdin);
    assert.ok(!JSON.parse(r.out).result.includes('\u2060'));
  });
  await test('antigravity: --print-timeout expired (AGY_ERROR, exit 3, finished_reason) -> an error, the partial answer is never used', async () => {
    state('timeout'); const r = await ai.run([], { input: 'long', timeout: 20000 }, {}); state('ok');
    assert.notEqual(r.code, 0); assert.match(r.err, /stopped at its time limit/); assert.equal(JSON.parse(r.out).is_error, true);
  });
  await test('antigravity: a soft-denied tool (stderr notice, denied_actions) leaves the answer usable and nothing written', async () => {
    clearLog(); state('softdeny'); const r = await ai.run([], { input: 'x', timeout: 20000 }, {}); state('ok');
    assert.equal(r.code, 0, JSON.stringify(r)); assert.match(JSON.parse(r.out).result, /Fake answer/);
    assert.ok(!fs.existsSync(path.join(featureCalls(readLog())[0].cwd, 'x.txt')));
  });
  await test('antigravity: "turning off the terminal sandbox" on stderr -> the run is stopped, the answer never used', async () => {
    state('nosandbox'); const r = await ai.run([], { input: 'SENTINEL-nosb', timeout: 20000 }, {}); state('ok');
    assert.notEqual(r.code, 0); assert.match(r.err, /could not run with its sandbox/); assert.ok(!/Fake answer/.test(r.out));
    const res = new h.FakeRes();
    state('nosandbox'); await quiz.generate(h.it(A), { count: quiz.COUNTS[0], level: 'core', focus: '', language: 'en', res }); await res.done; state('ok');
    const ev = res.events(); assert.ok(!ev.some((e) => e.type === 'done') && ev.some((e) => e.type === 'error' && /sandbox/.test(e.text)), JSON.stringify(ev).slice(0, 400));
  });
  await test('antigravity: an init event reporting another permission mode (always-proceed) -> stopped before any answer, panel too', async () => {
    state('badmode'); const r = await ai.run([], { input: 'x', timeout: 20000 }, {});
    const p = await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'hi', context: {} }); state('ok');
    assert.notEqual(r.code, 0); assert.match(r.err, /permission mode “always-proceed”/); assert.ok(!/Fake answer/.test(r.out));
    const done = (p.events || []).find((e) => e.type === 'done');
    assert.ok(done && done.isError && /always-proceed/.test(done.error) && !(p.events || []).some((e) => e.type === 'delta' && /Fake/.test(e.text)), JSON.stringify(p.events).slice(0, 400));
  });
  // ---- fail closed on what agy itself reports (init first, a permission mode that asks, no path outside the call) ----
  for (const [st8, re] of [['nomode', /did not report the permission mode/], ['noinit', /answered without first reporting the permission mode/], ['outside', /a file outside the folders ResearchTool gave it/]]) {
    await test(`antigravity: ${st8} -> the call is stopped, no text of it reaches the feature or the panel`, async () => {
      state(st8); const r = await ai.run([], { input: 'x', timeout: 20000 }, {});
      const p = await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'hi', context: {} }); state('ok');
      assert.notEqual(r.code, 0); assert.match(r.err, re); assert.ok(!/Fake answer/.test(r.out), r.out);
      const done = (p.events || []).find((e) => e.type === 'done');
      assert.ok(done && done.isError && re.test(done.error) && !(p.events || []).some((e) => /Fake answer/.test(JSON.stringify(e)) && e.type !== 'done'), JSON.stringify(p.events).slice(0, 600));
    });
  }
  await test('antigravity: a tool step inside the folders of the call (the soft-denied x.txt of the run folder, the workspace in the panel) is fine', () => {
    const run = (ev, roots, cwd) => { const st = { errors: [], initOk: true, roots, cwd }; agy.line(ev, st, () => {}); return st.unsafe || null; };
    const step = (p) => ({ type: 'step_update', step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: p } });
    assert.equal(run(step({ path: 'x.txt' }), [TMP], TMP), null);
    assert.equal(run(step({ AbsolutePath: path.join(WS, 'notes', 'a.md') }), [ai.PANEL_DIR, WS], ai.PANEL_DIR), null);
    assert.ok(run(step({ AbsolutePath: path.join(WS, '..', 'outside.md') }), [ai.PANEL_DIR, WS], ai.PANEL_DIR));
    assert.ok(run(step({ DirectoryPath: '~/.gemini' }), [ai.PANEL_DIR, WS], ai.PANEL_DIR));
    assert.ok(run(step({ SearchPaths: ['notes', '/etc'] }), [WS], WS), 'a list of paths: each one');
    assert.ok(run(step({ path: path.join(WS, 'notes') }), [TMP], TMP), 'a feature call: the workspace is outside its run folder');
    // and before init nothing counts
    const st = { errors: [] }; agy.line({ type: 'result', status: 'SUCCESS', response: 'x' }, st, () => assert.fail('emitted before init')); assert.ok(st.unsafe);
  });
  // ---- an agy too old to run read-only is never started ----
  await test('antigravity: agy 1.0.2 (or no version to read) -> status says "update", the call is refused before -p ever runs', async () => {
    for (const st8 of ['old', 'noversion']) {
      clearLog(); state(st8);
      const s = await ai.status('antigravity', { fresh: true });
      const r = await ai.run([], { input: 'SENTINEL-old', timeout: 20000 }, {});
      const p = await route(require('../../../lib/routes/claude'), 'POST', '/api/claude', { prompt: 'hi', context: {} });
      state('ok');
      assert.equal(s.installed, true); assert.equal(s.outdated, true, JSON.stringify(s));
      assert.match(s.warning, st8 === 'old' ? /Antigravity 1\.0\.2 is too old.*1\.5\.13.*agy update/ : /could not tell which version.*agy update/);
      assert.notEqual(r.code, 0); assert.match(r.err, /agy update/); assert.ok(!/Fake answer/.test(r.out));
      const done = (p.events || []).find((e) => e.type === 'done'); assert.ok(done && done.isError && /agy update/.test(done.error), JSON.stringify(p.events).slice(0, 400));
      const calls = readLog().filter((c) => c.p === 'antigravity');
      assert.ok(calls.length >= 2 && calls.every((c) => c.argv.length === 1 && c.argv[0] === '--version' && !c.forbidden), JSON.stringify(calls.map((c) => c.argv)));
    }
    // updated: the next status check lets it run again
    await ai.status('antigravity', { fresh: true });
    const r = await ai.run([], { input: 'again', timeout: 20000 }, {}); assert.equal(r.code, 0, JSON.stringify(r));
    for (const v of ['1.5.12', '1.4.99', '0.9.0', '']) assert.ok(agy.tooOld(v), v);
    for (const v of ['1.5.13', '1.5.14', '1.6.0', '2.0.0']) assert.equal(agy.tooOld(v), null, v);
  });
  await test('antigravity: flag errors of an older agy (Go flag parsing) -> "update Antigravity", never "exited with code 2"', () => {
    for (const e of ['flag provided but not defined: -input-format', 'unknown flag: --input-format', 'unknown shorthand flag: \'p\' in -p', 'flag needs an argument: -p']) {
      assert.match(agy.failure({ code: 2, err: e, out: '', st: { errors: [] } }).text, /Update Antigravity \(agy update\)/, e);
      assert.match(agy.unsafe(e), /agy update/, e);
    }
  });
  await test('antigravity: the deny rules go under "permissions" only (agy refuses an unknown key); -p "" is the last pair', () => {
    for (const mode of ['feature', 'chat']) {
      const a = agy.args({ mode, addDirs: [WS], session: '055a398f-db14-4c5f-abbb-1bf03f8120a7', model: 'm1', effort: 'low' });
      assert.deepEqual(a.slice(-2), ['-p', '']);
      const set = JSON.parse(a[a.indexOf('--settings') + 1]);
      assert.equal(set.permission, undefined); assert.ok(set.permissions.deny.includes('command(*)'));
    }
  });
  await test('antigravity: unsafe() names unapplied settings / mode; a soft-deny notice is harmless', () => {
    assert.match(agy.unsafe('warning: --settings: unknown permission rule kind "execute_url"'), /did not accept/);
    assert.match(agy.unsafe('warning: --mode plan is not available here; falling back to default mode'), /did not accept/);
    assert.match(agy.unsafe('Sandbox is not available on this system'), /sandbox/);
    assert.equal(agy.unsafe('agy: soft-denied write_file(x.txt) in print mode; add the allow rule write_file(x.txt) to permit it'), null);
  });
  await test('antigravity: a real agy 1.5.14 turn (recorded, nested events) is read: request-review init, the answer, no stop', () => {
    const st = {}, em = [];
    for (const l of fs.readFileSync(path.join(__dirname, 'agy-1.5.14-turn.jsonl'), 'utf8').trim().split('\n')) agy.line(JSON.parse(l), st, (e) => em.push(e));
    assert.equal(st.unsafe || null, null); assert.ok(st.initOk);
    assert.equal(em.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello! How can I help you today?\n');
    assert.ok(em.some((e) => e.type === 'final'));
    assert.equal(agy.unsafe('warning: --mode plan has no effect while slash command expansion is disabled.'), null);
  });
  await test('the fake agy itself refuses --dangerously-skip-permissions, --mode auto / accept-edits, a prompt in argv and its subcommands', async () => {
    const plat2 = require('../../../lib/platform');
    const base = agy.args({ mode: 'feature' });
    const runFake = (args) => new Promise((res) => { const c = plat2.spawnTool('agy', args, { env: process.env }); c.on('close', (code) => res(code)); c.stdin.end(agy.stdin('hi')); });
    const swap = (k, v) => { const a = [...base]; a[a.indexOf(k) + 1] = v; return a; };
    assert.equal(await runFake(base), 0);
    for (const bad of [[...base.slice(0, -2), '--dangerously-skip-permissions', '-p', ''], swap('--mode', 'auto'), swap('--mode', 'accept-edits'), [...base.slice(0, -2), '-p', 'a prompt'], ['-p', '', ...base.slice(0, -2)], ['models'], ['update'], ['acp'], ['login']]) {
      assert.equal(await runFake(bad), 97, bad.join(' '));
    }
    // like the real agy 1.5.14 (checked, no prompt): a bare -p and an unknown settings key are refused
    assert.equal(await runFake(base.slice(0, -1)), 2, 'bare -p: flag needs an argument');
    const withKey = [...base]; const si = withKey.indexOf('--settings'); withKey[si + 1] = JSON.stringify({ ...JSON.parse(withKey[si + 1]), permission: {} });
    assert.equal(await runFake(withKey), 1, 'unknown settings key');
  });
  settings({ aiProvider: undefined });

  // ================= the env-key opt-in =================
  // (env names are case-blind on Windows, where PATH is usually spelt "Path": a name counts in any case there - for
  // "dropped" too, so a key in another case is still caught)
  const has = (keys, name, platform = process.platform) => keys.some((x) => (platform === 'win32' ? x.toUpperCase() === name.toUpperCase() : x === name));
  await test('the env allowlist keeps PATH in any case (Windows: "Path"), and drops a key in any case', () => {
    const pk = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH'), pv = process.env[pk];
    const saved = { XAI_API_KEY: process.env.XAI_API_KEY };
    delete process.env[pk]; process.env.Path = pv; delete process.env.XAI_API_KEY; process.env.xai_api_key = 'xai-fake-lower';
    try {
      settings({ aiProvider: 'grok' });
      const e = ai.envFor(ai.provider('grok'));
      assert.equal(e.Path, pv, 'Path is passed on under its own name: ' + Object.keys(e).join(','));
      assert.ok(!Object.keys(e).some((k) => k.toUpperCase() === 'XAI_API_KEY'), 'a key in lower case is dropped too');
    } finally { delete process.env.Path; delete process.env.xai_api_key; process.env[pk] = pv; Object.assign(process.env, saved); settings({ aiProvider: undefined }); }
    assert.ok(has(['Path'], 'PATH', 'win32') && !has(['Path'], 'PATH', 'linux'));
  });
  await test('API keys: dropped by default for every provider, kept for that provider only when opted in; other secrets never', async () => {
    const keys = async (id) => { settings({ aiProvider: id }); clearLog(); await ai.run([], { input: 'k', timeout: 20000 }, {}); return featureCalls(readLog())[0].envKeys; };
    let k = await keys('codex'); assert.ok(!has(k, 'OPENAI_API_KEY') && !has(k, 'XAI_API_KEY') && !has(k, 'GEMINI_API_KEY'));
    k = await keys('grok'); assert.ok(!has(k, 'XAI_API_KEY') && !has(k, 'GROK_CODE_XAI_API_KEY') && has(k, 'GROK_HOME') && has(k, 'PATH'));
    k = await keys('antigravity'); assert.ok(!has(k, 'GEMINI_API_KEY') && !has(k, 'AGY_ADC_AUTH') && !has(k, 'GOOGLE_APPLICATION_CREDENTIALS') && has(k, 'HOME') && has(k, 'PATH'));
    assert.ok(!('modelProvider' in JSON.parse(featureCalls(readLog())[0].argv[featureCalls(readLog())[0].argv.indexOf('--settings') + 1])), 'no API-key provider unless opted in');
    settings({ aiUseEnvKey: { codex: true, grok: true } });
    k = await keys('codex'); assert.ok(has(k, 'OPENAI_API_KEY') && has(k, 'CODEX_API_KEY') && !has(k, 'XAI_API_KEY') && !has(k, 'GEMINI_API_KEY') && !has(k, 'GOOGLE_APPLICATION_CREDENTIALS'));
    k = await keys('grok'); assert.ok(has(k, 'XAI_API_KEY') && has(k, 'GROK_CODE_XAI_API_KEY') && !has(k, 'CURSOR_API_KEY') && !has(k, 'GROK_AUTH_PROVIDER_COMMAND') && !has(k, 'OPENAI_API_KEY') && !has(k, 'GEMINI_API_KEY'));
    settings({ aiUseEnvKey: { antigravity: true } });
    k = await keys('antigravity'); assert.ok(has(k, 'GEMINI_API_KEY') && has(k, 'AGY_ADC_AUTH') && !has(k, 'XAI_API_KEY') && !has(k, 'OPENAI_API_KEY'));
    { const a = featureCalls(readLog())[0].argv; assert.equal(JSON.parse(a[a.indexOf('--settings') + 1]).modelProvider, 'gemini', 'agy reads GEMINI_API_KEY only with modelProvider "gemini"'); }
    for (const id of OTHERS) { k = await keys(id); for (const x of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'MY_SERVICE_SECRET', 'OPENAI_BASE_URL', 'GATEWAY_API_KEY']) assert.ok(!has(k, x), x + ' reached ' + id); }
    const s = fs.readFileSync(core.SETTINGS_FILE, 'utf8'); assert.ok(!/sk-fake|fake-test/.test(s), 'no key is ever written to settings.json');
    settings({ aiUseEnvKey: undefined });
  });

  // ================= cancel, timeout =================
  for (const id of OTHERS) {
    settings({ aiProvider: id });
    await test(`${id}: a timeout kills the CLI and reports it`, async () => {
      clearLog(); state('slow');
      const t0 = Date.now(); const r = await ai.run([], { input: 'slow', timeout: 700 }, {}); state('ok');
      assert.ok(Date.now() - t0 < 8000, 'returned quickly'); assert.notEqual(r.code, 0);
      await new Promise((res) => setTimeout(res, 200));
      const c = readLog().find((x) => x.p === id && !['--version'].includes(x.argv[0]));
      assert.ok(c, 'it was started'); assert.throws(() => process.kill(c.pid, 0), 'the fake process is gone');
      assert.equal(fs.readdirSync(ai.TMP_ROOT).length, 0, 'its temp folder is gone');
    });
    await test(`${id}: cancelling (abort signal) kills the CLI`, async () => {
      clearLog(); state('slow');
      const ac = new AbortController(); setTimeout(() => ac.abort(), 400);
      const t0 = Date.now(); const r = await ai.run([], { input: 'slow', timeout: 60000, signal: ac.signal }, {}); state('ok');
      assert.ok(Date.now() - t0 < 8000); assert.notEqual(r.code, 0);
      await new Promise((res) => setTimeout(res, 200));
      const c = readLog().find((x) => x.p === id); assert.ok(c); assert.throws(() => process.kill(c.pid, 0));
    });
  }
  settings({ aiProvider: 'grok' });
  await test('grok: the Stop button of a quiz stops a streaming call (no quiz, no error from the CLI)', async () => {
    state('slow');
    const res = new h.FakeRes();
    const p = quiz.generate(h.it(A), { count: 5, level: 'core', focus: '', language: 'en', res });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(quiz.stop(A).stopped, true);
    await p; await res.done; state('ok');
    const ev = res.events();
    assert.ok(ev.some((e) => e.type === 'error' && /Stopped/.test(e.text)), JSON.stringify(ev));
  });
  // Windows (simulated): killTree is taskkill /T /F of the pid, and the CLI then exits with code 1, not a signal - a
  // stop must still read as a stop (the AiChild is told it was killed), never "grok exited with code 1"
  await test('grok, Windows killing simulated (taskkill, exit code 1): Stop is a stop, a timeout a timeout - never a CLI error', async () => {
    const orig = plat.killTree, tk = [];
    const taskkill = (file, args) => { tk.push(args[1]); try { process.kill(Number(args[1]), 'SIGKILL'); } catch { /* gone */ } return { on() {} }; };
    plat.killTree = (child, o = {}) => orig(child, { ...o, platform: 'win32', env: {}, spawnFn: taskkill });
    try {
      state('slow');
      const res = new h.FakeRes();
      const p = quiz.generate(h.it(A), { count: 5, level: 'core', focus: '', language: 'en', res });
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(quiz.stop(A).stopped, true);
      await p; await res.done;
      const ev = res.events();
      assert.ok(ev.some((e) => e.type === 'error' && /Stopped/.test(e.text)) && !ev.some((e) => /exited with code|could not answer/.test(e.text || '')), JSON.stringify(ev));
      assert.ok(tk.length >= 1, 'the CLI was stopped by taskkill');
      const r = await ai.run([], { input: 'slow', timeout: 700 }, {});
      assert.notEqual(r.code, 0); assert.match(r.err, /\[timed out\]/); assert.ok(!/exited with code/.test(r.err), r.err);
    } finally { plat.killTree = orig; state('ok'); }
  });

  // ================= prompts: quotes, newlines, unicode, long; never argv, never a shell =================
  const WEIRD = 'He said "quote" and \'single\'\n$(touch PWNED) `touch PWNED2` ; rm -rf / && echo %PATH% ^& | > < \\ \u00fc\u00f1\u00ef \u8bba\u6587 \ud83d\ude00\r\nend';
  for (const id of OTHERS) {
    settings({ aiProvider: id });
    await test(`${id}: a prompt with quotes, newlines, shell characters and unicode arrives unchanged, outside argv`, async () => {
      clearLog();
      const r = await ai.run([], { input: WEIRD, timeout: 20000 }, {});
      assert.equal(r.code, 0, JSON.stringify(r));
      const c = featureCalls(readLog())[0], got = id === 'grok' ? c.promptFile : c.stdin;
      assert.ok(got.endsWith(WEIRD), 'unchanged'); assert.ok(!c.argv.some((x) => x.includes('PWNED') || x.includes('quote')));
      assert.ok(!fs.existsSync(path.join(c.cwd, 'PWNED')) && !fs.existsSync(path.join(WS, 'PWNED')) && !fs.existsSync('PWNED'), 'no shell ran it');
    });
    await test(`${id}: a long prompt (400,000 characters) goes on stdin / in the file, argv stays short`, async () => {
      clearLog();
      const big = ('Lorem ipsum dolor sit amet, ' + '\u00fc'.repeat(3) + '. ').repeat(12500);
      const r = await ai.run([], { input: big, timeout: 30000 }, {});
      assert.equal(r.code, 0, JSON.stringify(r).slice(0, 300));
      const c = featureCalls(readLog())[0], got = id === 'grok' ? c.promptFile : c.stdin;
      assert.ok(got.length >= big.length && got.endsWith(big)); assert.ok(c.argv.join(' ').length < 1500, 'argv: ' + c.argv.join(' ').length);
    });
  }
  await test('no shell anywhere in lib/ai: spawnTool only (it refuses shell: true), no exec / execSync', () => {
    const dir = path.join(__dirname, '..', '..', '..', 'lib', 'ai');
    const files = [...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'providers')).map((f) => path.join(dir, 'providers', f))];
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      assert.ok(!/child_process|\bexecSync\b|\bexecFile\b|shell\s*:\s*true/.test(s), f);
    }
    assert.throws(() => plat.spawnTool('codex', [], { shell: true }), /never uses a shell/);
  });

  // ================= Windows: the npm shims of the CLIs (simulated) =================
  const SHIM = (rel) => require('./install').npmShim(rel).replace('\\cli.js', '');
  const vdisk = (files) => { const m = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v])); return { isFile: (f) => m.has(String(f).toLowerCase()), readFile: (f) => { const v = m.get(String(f).toLowerCase()); if (v == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v; } }; };
  const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const ENV = { Path: NPM + ';C:\\Tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const disk = vdisk({
    [NPM + '\\codex.cmd']: SHIM('@openai\\codex\\bin\\codex.js'), [NPM + '\\node_modules\\@openai\\codex\\bin\\codex.js']: '',
    // npm's node shim of @xai-official/grok's bin/grok (a node launcher without an extension)
    [NPM + '\\grok.cmd']: SHIM('@xai-official\\grok\\bin\\grok'), [NPM + '\\node_modules\\@xai-official\\grok\\bin\\grok']: '',
    'C:\\Tools\\codex2.bat': '@echo off\r\ncodex %*\r\n',
  });
  const W = (cmd, files = disk) => plat.resolveCmd(cmd, { platform: 'win32', env: ENV, ...files, execPath: 'C:\\node\\node.exe' });
  await test('Windows (simulated): the codex.cmd npm shim runs as node + its script, never cmd.exe', () => {
    assert.deepEqual(W('codex'), { file: 'C:\\node\\node.exe', args: [NPM + '\\node_modules\\@openai\\codex\\bin\\codex.js'], via: NPM + '\\codex.cmd' });
  });
  await test('Windows (simulated): grok - npm\'s node shim of its extensionless launcher bin/grok runs as node + launcher; grok.exe on PATH directly', () => {
    // @xai-official/grok 1.0.92 on Windows: bin/grok is a "#!/usr/bin/env node" launcher (postinstall.js: "Windows keeps
    // the node launcher"), the native grok.exe goes to ~/.grok/bin - there is no bin/grok.exe in the package
    assert.deepEqual(W('grok'), { file: 'C:\\node\\node.exe', args: [NPM + '\\node_modules\\@xai-official\\grok\\bin\\grok'], via: NPM + '\\grok.cmd' });
    const d2 = vdisk({ 'C:\\Tools\\grok.exe': '' });
    assert.deepEqual(W('grok', d2), { file: 'C:\\Tools\\grok.exe', args: [] });
  });
  await test('Windows (simulated): agy.exe from the Antigravity installer (%LOCALAPPDATA%\\agy\\bin) runs directly', () => {
    const d = vdisk({ 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe': '' });
    assert.deepEqual(plat.resolveCmd('agy', { platform: 'win32', env: { Path: 'C:\\Users\\me\\AppData\\Local\\agy\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, ...d, execPath: 'C:\\node\\node.exe' }),
      { file: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe', args: [] });
  });
  await test('Windows (simulated): a shim without its program, or a hand-written .bat, is refused (EUNSAFECMD), never run by a shell', () => {
    const d3 = vdisk({ [NPM + '\\grok.cmd']: '@ECHO off\r\n"%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok"   %*\r\n' });
    assert.equal(W('grok', d3).error.code, 'EUNSAFECMD');
    assert.equal(W('codex2').error.code, 'EUNSAFECMD');
  });

  settings({ aiProvider: undefined });
  state('ok');
  fs.rmSync(ai.AI_HOME, { recursive: true, force: true }); // the private folder of this test workspace
}

module.exports = { run };
