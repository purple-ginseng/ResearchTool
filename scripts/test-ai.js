#!/usr/bin/env node
// Tests of the AI providers (lib/ai): Claude Code, OpenAI Codex, xAI Grok Build and Google Antigravity (agy). (Gemini
// CLI is not offered any more: a saved aiProvider 'gemini' falls back to Claude.) No real CLI is
// ever run: fake ones (scripts/fixtures/fake-ai/fake.js) are put first on PATH, log every call (argv, cwd, stdin, the
// NAMES of the env variables) and answer in the formats of the CLI research.
//   1. Claude golden: with no provider chosen, every AI call path spawns `claude` with exactly the argv, cwd, stdin and
//      env names it did before lib/ai existed (snapshot scripts/fixtures/fake-ai/claude-golden.json, recorded at
//      8a4faf4 with --record-golden).
//   2. Every call path through codex, grok and antigravity: the feature works, the prompt is never in argv, feature calls
//      run in an empty temporary folder that is removed afterwards, the provider's API-key variables are dropped
//      unless opted in, read-only flags are always there, the Grok prompt file is private and deleted.
//   3. Provider selection, status without a model call, failure modes (not signed in, quota, malformed output, an
//      unknown resume id, an unknown config key), cancel and timeout, prompts with quotes / newlines / unicode, a long
//      prompt via stdin, no shell, the Windows .cmd shims of the npm packages (simulated).
// Run:  node scripts/test-ai.js            (RT_TEST_TMP=<dir> puts the temporary workspace there)
//       node scripts/test-ai.js --record-golden   (only on the commit before lib/ai: writes the Claude snapshot)
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { installFakes, linkHelpers, nodeOnlyDir } = require('./fixtures/fake-ai/install');

const RECORD = process.argv.includes('--record-golden');
const GOLDEN = path.join(__dirname, 'fixtures', 'fake-ai', 'claude-golden.json');
// a fixed path, so the Claude argv (which names files of the workspace) compares across runs
const BASE = process.env.RT_TEST_TMP || os.tmpdir();
const TOP = path.join(BASE, 'rt-test-ai');
fs.rmSync(TOP, { recursive: true, force: true });
const WS = path.join(TOP, 'ws'), BIN = path.join(TOP, 'bin'), LOG = path.join(TOP, 'calls.jsonl');
// GEMINI_CLI_HOME stays pointed at an empty temporary folder (and among the Claude golden's env names): a real
// Gemini CLI home is never the user's, even though the app no longer runs Gemini CLI
const CLAUDE_DIR = path.join(TOP, 'claude-config'), GEMINI_HOME = path.join(TOP, 'gemini-home');
for (const d of [WS, BIN, CLAUDE_DIR, path.join(GEMINI_HOME, '.gemini')]) fs.mkdirSync(d, { recursive: true });
installFakes(BIN);
// the user's own Claude Code settings are read for "Best quality": a fixed copy here, never the real one
fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'high' }));
// PATH: ONLY the fake CLIs' folder and a folder holding nothing but a link to this node binary - never the folder node
// lives in (/opt/homebrew/bin holds a real codex and gemini here), ~/.local/bin or any other folder where a real
// claude / codex / gemini / grok / agy may be installed. The few helper programs the features
// need (pdftotext ...) are linked into the fakes' folder by name (never an AI CLI). RT_NO_EXTRA_PATH keeps lib/core.js
// from adding its usual folders. HOME is a temporary folder too, so ~/.gemini, ~/.grok, ~/.codex are never the user's.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const REAL_HOME = os.userInfo().homedir;
const HOME = path.join(TOP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const HELPER_DIRS = linkHelpers(BIN, process.env[pathKey], ['pdftotext', 'pdftoppm', 'pdfinfo', 'zip', 'unzip']); // (Windows only: folders)
const NODE_DIR = nodeOnlyDir(path.join(TOP, 'node'));
const GUARD_LOG = path.join(TOP, 'guard.jsonl');
const TEST_PATH = [BIN, NODE_DIR, ...HELPER_DIRS];
process.env[pathKey] = TEST_PATH.join(path.delimiter);
for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|OPENAI|CODEX|GEMINI|GOOGLE|XAI|GROK|AGY|ANTIGRAVITY|XDG_|APPDATA$|LOCALAPPDATA$)/i.test(k)) delete process.env[k];
Object.assign(process.env, {
  HOME, USERPROFILE: HOME, RT_NO_EXTRA_PATH: '1',
  // the XDG folders (Linux: where a CLI may keep its config or sign-in) and the Windows app-data folders: temporary too
  XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_DATA_HOME: path.join(HOME, '.local', 'share'), XDG_CACHE_HOME: path.join(HOME, '.cache'), XDG_STATE_HOME: path.join(HOME, '.local', 'state'),
  ...(process.platform === 'win32' ? { APPDATA: path.join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(HOME, 'AppData', 'Local') } : {}),
  // (agy has no home variable of its own: its folders are ~/.gemini/antigravity*, ~/.gemini/config - in HOME above)
  FAKE_AI_BIN: BIN, FAKE_AI_GUARD_LOG: GUARD_LOG,
  RT_WORKSPACE: WS, CLAUDE_CONFIG_DIR: CLAUDE_DIR, GEMINI_CLI_HOME: GEMINI_HOME, FAKE_AI_LOG: LOG, FAKE_AI_STATE: 'ok',
  // fake keys: the app must drop them unless the user opted in
  OPENAI_API_KEY: 'sk-fake-test', CODEX_API_KEY: 'fake-test', XAI_API_KEY: 'xai-fake-test', GEMINI_API_KEY: 'gm-fake-test',
});

// ---------- a small workspace: two papers (one with a PDF, sentences, a note and a picture) ----------
function tinyPdf(pages) {
  const n = pages.length, objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`];
  const font = 3 + n * 2;
  pages.forEach((t, i) => {
    const stream = t.map((l, k) => `BT /F1 12 Tf 72 ${700 - k * 18} Td (${l}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const A = 'a1b2c3d4e5', B = 'f6a7b8c9d0';
const PAGE = (k) => [`Section ${k}. Diffusion policies for robot control.`, 'We propose a method that learns actions from demonstrations.', 'Our results show a 20 percent gain over the baseline.', 'The approach is limited by the amount of data.'];
fs.mkdirSync(path.join(WS, 'pdfs'), { recursive: true });
fs.writeFileSync(path.join(WS, 'pdfs', A + '.pdf'), tinyPdf([PAGE(1), PAGE(2), PAGE(3)]));
fs.mkdirSync(path.join(WS, 'sentences'), { recursive: true });
fs.writeFileSync(path.join(WS, 'sentences', A + '.json'), JSON.stringify({ sentences: PAGE(1).map((text, i) => ({ i, page: 1, section: 'Intro', text })) }));
fs.mkdirSync(path.join(WS, 'notes', 'assets', A), { recursive: true });
fs.writeFileSync(path.join(WS, 'notes', A + '.md'), '# Reading note\n\nThe method learns actions from demonstrations.\n\n![Figure 1](/api/items/' + A + '/note/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)\n');
fs.writeFileSync(path.join(WS, 'notes', 'assets', A, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
const item = (id, title, extra) => ({ id, citekey: 'key' + id.slice(0, 4), type: 'article', fields: { title, author: 'Ada Tester and Bo Fake', year: '2025', abstract: 'We study diffusion policies. Results improve by 20 percent.' }, keypoints: [], category: 'Uncategorized', tags: [], ...extra });
fs.writeFileSync(path.join(WS, 'library.json'), JSON.stringify({ items: [item(A, 'Diffusion Policies "Quoted" — ünïcödé 论文', { pdf: true, pages: 3 }), item(B, 'A paper without a PDF', { pdf: false })] }));
fs.writeFileSync(path.join(WS, 'settings.json'), JSON.stringify({ autoCategorize: false, backupAuto: false }));

// before anything loads node:child_process: no claude / codex / gemini / grok / agy outside BIN can ever be started
require('./fixtures/fake-ai/guard');
// (read by the guard at load: not left in the environment, so the Claude calls keep the env names of the golden)
delete process.env.FAKE_AI_BIN; delete process.env.FAKE_AI_GUARD_LOG;
const core = require('../lib/core');
// every program the app starts is resolved here first: an AI CLI must resolve to its fake in BIN, every time
const plat = require('../lib/platform');
const AI_BINS = new Set(['claude', 'codex', 'gemini', 'grok', 'agy']);
const resolved = [];
const spawnToolOrig = plat.spawnTool;
plat.spawnTool = (cmd, args, opts, deps) => {
  if (AI_BINS.has(cmd)) {
    const env = (opts && opts.env) || process.env, r = plat.resolveCmd(cmd, { env });
    // (macOS / Linux: resolveCmd leaves the name to spawn, which takes the first match on the child's PATH)
    let file = r.file || null;
    if (file && !path.isAbsolute(file)) {
      const pv = env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH')] || '';
      file = pv.split(path.delimiter).map((d) => path.join(d, file)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) || null;
    }
    resolved.push({ cmd, file, via: r.via || null });
  }
  return spawnToolOrig(cmd, args, opts, deps);
};
const notes = require('../lib/notes');
const quiz = require('../lib/quiz');
const diagrams = require('../lib/diagrams');
const cat = require('../lib/categorize');
const compare = require('../lib/compare');
const writing = require('../lib/writing');
const routeClaude = require('../lib/routes/claude');
const routeAccount = require('../lib/routes/account');
const routeLibrary = require('../lib/routes/library');

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 12).join('\n     ')); }
}

// ---------- helpers ----------
class FakeRes extends EventEmitter {
  constructor() { super(); this.body = ''; this.headersSent = false; this.writableEnded = false; this.destroyed = false; this.done = new Promise((r) => { this._r = r; }); }
  writeHead(code, h) { this.statusCode = code; this.headers = h; this.headersSent = true; }
  write(s) { this.body += s; return true; }
  end(s) { if (s) this.body += s; if (this.writableEnded) return; this.writableEnded = true; this.emit('finish'); this._r(); setImmediate(() => this.emit('close')); }
  events() { return this.body.split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
}
const settings = (o) => { const s = core.readJSON(core.SETTINGS_FILE, {}); for (const [k, v] of Object.entries(o)) { if (v === undefined) delete s[k]; else s[k] = v; } core.writeJSON(core.SETTINGS_FILE, s); };
// (the fake `agy` logs itself as "agy": the provider id is "antigravity")
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => (c.p === 'agy' ? { ...c, p: 'antigravity' } : c)) : []);
const clearLog = () => fs.rmSync(LOG, { force: true });
const lib = () => core.loadLib();
const it = (id) => lib().items.find((i) => i.id === id);
const ctxOf = (method, p, body) => {
  const res = new FakeRes(), url = new URL('http://localhost' + p); let sent = null;
  return { res, get sent() { return sent; }, ctx: { req: new EventEmitter(), res, url, path: url.pathname, segments: url.pathname.split('/').filter(Boolean), method, query: url.searchParams,
    json: async () => body || {}, send: (code, data) => { sent = { code, data }; res.end(); return true; }, core } };
};
async function route(mod, method, p, body) {
  const c = ctxOf(method, p, body);
  try { if (!(await mod.handle(c.ctx))) return { code: 404, data: { error: 'not handled' } }; } catch (e) { return { code: e.status || 500, data: { error: e.message } }; }
  await c.res.done;
  return c.sent || { code: c.res.statusCode, events: c.res.events() };
}
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ---------- the AI call paths of the app (the same list for every provider) ----------
// each returns {ok, detail}: ok = the feature produced its result
let lastDiagram = null, chatSession = null;
const PATHS = {
  'chat': async () => {
    const r = await route(routeClaude, 'POST', '/api/claude', { prompt: 'What is "this" paper about?\nLine two — ünïcödé SENTINEL-chat', context: { itemId: A, page: 2, selection: { text: 'learns actions', page: 2 } } });
    const done = (r.events || []).find((e) => e.type === 'done');
    chatSession = done && done.sessionId;
    return { ok: !!done && !done.isError && (r.events || []).some((e) => e.type === 'text' || e.type === 'delta'), detail: r };
  },
  'chat-resume': async () => {
    const r = await route(routeClaude, 'POST', '/api/claude', { prompt: 'And the results? SENTINEL-chat2', sessionId: chatSession || '11111111-2222-4333-8444-555555555555', context: { itemId: A } });
    const done = (r.events || []).find((e) => e.type === 'done');
    return { ok: !!done && !done.isError, detail: r };
  },
  'account-status': async () => { const r = await route(routeAccount, 'GET', '/api/claude/auth'); return { ok: r.code === 200 && r.data.installed === true, detail: r }; },
  'api-status': async () => { const r = await route(routeLibrary, 'GET', '/api/status'); return { ok: r.code === 200 && (r.data.claude !== undefined || !!r.data.ai), detail: r }; },
  'ask': async () => { const r = await notes.askAbout(it(A), { mode: 'ask', question: 'Why "this"? SENTINEL-ask', kind: 'note', text: 'The method learns actions from demonstrations.', language: 'en' }); return { ok: /Fake answer/.test(r.text), detail: r }; },
  'ask-image': async () => { const r = await notes.askAbout(it(A), { mode: 'ask', question: 'What does the figure show? SENTINEL-img', kind: 'image', asset: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', text: 'Figure 1', language: 'en' }); return { ok: /Fake answer/.test(r.text), detail: r }; },
  'translate': async () => { const r = await notes.askAbout(it(A), { mode: 'translate', kind: 'pdf', text: 'We propose a method SENTINEL-tr.', language: 'zh', page: 1 }); return { ok: /Fake answer/.test(r.text), detail: r }; },
  'draft': async () => {
    const res = new FakeRes();
    await notes.generateDraft(it(A), { language: 'en', res, startHash: notes.readNote(A).hash || null });
    await res.done;
    const ev = res.events(), done = ev.find((e) => e.type === 'done' || e.type === 'conflict');
    return { ok: !!done, detail: ev };
  },
  'draft-economy': async () => {
    settings({ aiMode: 'economy' });
    try { return await PATHS.draft(); } finally { settings({ aiMode: undefined }); }
  },
  'quiz': async () => {
    const res = new FakeRes();
    await quiz.generate(it(A), { count: quiz.COUNTS[0], level: 'core', focus: '', language: 'en', res });
    await res.done;
    const ev = res.events();
    return { ok: ev.some((e) => e.type === 'done' && e.quiz && e.quiz.questions.length >= 3), detail: ev };
  },
  'diagram': async () => {
    const res = new FakeRes();
    await diagrams.generate(it(A), { kind: 'auto', focus: '', language: 'en', res });
    await res.done;
    const ev = res.events(), d = ev.find((e) => e.type === 'done');
    lastDiagram = d && d.diagram;
    return { ok: !!(d && d.diagram.nodes.length >= 2), detail: ev };
  },
  'diagram-explain': async () => {
    if (!lastDiagram) return { ok: false, detail: 'no diagram' };
    const r = await diagrams.explain(it(A), lastDiagram.id, { node: lastDiagram.nodes[0].id }, 'example', 'en');
    return { ok: /Fake answer/.test(r.entry.text), detail: r };
  },
  'grouping': async () => {
    const l = lib(); l.items.find((i) => i.id === B).categoryStatus = 'pending'; core.saveLib(l);
    await cat.classifyOne(B);
    const b = it(B);
    return { ok: b.categoryStatus === 'done' && /Fake/.test(b.category), detail: { status: b.categoryStatus, category: b.category, error: b.categoryError } };
  },
  'grouping-model': async () => {
    settings({ categoryModel: 'haiku', aiProviders: { codex: { categoryModel: 'gpt-fake-mini' }, grok: { categoryModel: 'grok-fake-fast' }, antigravity: { categoryModel: 'agy-fake-flash' } } });
    try { return await PATHS.grouping(); } finally { settings({ categoryModel: undefined, aiProviders: undefined }); }
  },
  'compare': async () => {
    const res = new FakeRes();
    await compare.create({ ids: [A], kind: 'ask', question: 'What is the gain? SENTINEL-cmp', language: 'en' }, res);
    await res.done;
    const ev = res.events(), d = ev.find((e) => e.type === 'done');
    const cell = d && d.table.rows[0].cells && d.table.rows[0].cells.c1;
    return { ok: !!(cell && /Fake/.test(cell.text)), detail: ev.slice(-2) };
  },
  'rewrite': async () => { const r = await writing.rewrite({ mode: 'improve', text: 'We propose a method "quoted" SENTINEL-rw.' }); return { ok: /Fake answer/.test(JSON.stringify(r)), detail: r }; },
  'related-work': async () => { const r = await writing.relatedWork({ ids: [A] }); return { ok: /Fake answer/.test(JSON.stringify(r)), detail: r }; },
  'key-points': async () => { const r = await route(routeLibrary, 'POST', `/api/items/${A}/extract`, { mode: 'claude' }); return { ok: r.code === 200 && r.data.item.keypointSource === 'claude' && r.data.item.keypoints.length >= 1, detail: r }; },
};

// what a call looked like, with the temporary paths written as <TOP> so runs compare
const TOP_REAL = (() => { try { return fs.realpathSync.native(TOP); } catch { return TOP; } })(); // macOS: /tmp is /private/tmp
const norm = (s) => [TOP_REAL, TOP_REAL.replace(/\\/g, '/'), TOP, TOP.replace(/\\/g, '/')]
  .reduce((acc, t) => acc.split(t).join('<TOP>'), String(s));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
// (the env names that matter here, not the whole environment of the machine the test runs on; the app folder as <ROOT>)
const ENV_NAMES = /^(CLAUDE|ANTHROPIC|OPENAI|CODEX|GEMINI|GOOGLE|XAI|GROK|FAKE_|RT_WORKSPACE$)/;
const ROOTDIR = path.join(__dirname, '..');
const shape = (c) => ({ p: c.p, argv: c.argv.map(norm), cwd: c.cwd === ROOTDIR ? '<ROOT>' : norm(c.cwd), stdin: c.stdin == null ? null : sha(norm(c.stdin)), envKeys: c.envKeys.filter((k) => ENV_NAMES.test(k)) });

async function runPath(name) {
  clearLog();
  let r;
  try { r = await PATHS[name](); } catch (e) { r = { ok: false, detail: e.stack || e.message, error: e }; }
  await settle(30);
  return { ...r, calls: readLog() };
}

(async () => {
  // ================= 1. Claude: the same calls as before lib/ai =================
  const claudeRuns = {};
  for (const name of Object.keys(PATHS)) claudeRuns[name] = await runPath(name);
  if (RECORD) {
    const out = {};
    for (const [name, r] of Object.entries(claudeRuns)) out[name] = { ok: r.ok, calls: r.calls.map(shape) };
    fs.writeFileSync(GOLDEN, JSON.stringify({ recordedAt: '8a4faf4', note: 'argv/cwd/stdin-hash/env-names of every claude call per call path, before lib/ai', paths: out }, null, 1) + '\n');
    console.log('golden written: ' + GOLDEN);
    for (const [name, r] of Object.entries(claudeRuns)) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name}: ${r.calls.length} call(s)${r.ok ? '' : ' ' + JSON.stringify(r.detail).slice(0, 300)}`);
    process.exit(0);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).paths;
  for (const [name, r] of Object.entries(claudeRuns)) {
    await test(`claude (no provider set) ${name}: byte-identical argv, cwd, stdin and env names`, () => {
      assert.ok(golden[name], 'no golden entry');
      assert.equal(r.ok, golden[name].ok, 'the feature result differs: ' + JSON.stringify(r.detail).slice(0, 400));
      assert.deepEqual(r.calls.map(shape), golden[name].calls);
    });
  }
  await require('./fixtures/fake-ai/provider-tests').run({ test, PATHS, runPath, settings, readLog, clearLog, TOP, WS, BIN, LOG, HOME, A, B, FakeRes, route, core, lib, it });

  // ================= 4. Saved content names the provider that produced it =================
  // (the display layer renames "Claude" on screen only; what the server writes - note history versions, key points,
  // answers for a note comment, a related-work draft, saved error texts - names the provider that made it)
  const ai = require('../lib/ai');
  for (const [id, name] of [['claude', 'Claude'], ['antigravity', 'Antigravity'], ['codex', 'Codex'], ['grok', 'Grok']]) {
    await test(`${id}: saved content and answers name ${name}, never a hard-coded Claude`, async () => {
      settings({ aiProvider: id === 'claude' ? undefined : id });
      try {
        assert.equal(ai.name(), name);
        const ask = await notes.askAbout(it(A), { mode: 'ask', question: 'Why? SENTINEL-prov', kind: 'note', text: 'The method learns actions.', language: 'en' });
        assert.equal(ask.provider, name, 'the answer for a note comment names its provider');
        const res = new FakeRes();
        await notes.generateDraft(it(A), { language: 'en', res, startHash: notes.readNote(A).hash || null });
        await res.done;
        const done = res.events().find((e) => e.type === 'done');
        assert.ok(done, 'the draft was written: ' + JSON.stringify(res.events().slice(-2)).slice(0, 300));
        assert.equal(done.provider, name);
        const v = notes.listHistory(A)[0];
        assert.equal(v.source, 'claude', 'the internal source id of an AI version stays "claude"');
        assert.equal(v.by, id, 'the version records the provider that wrote it');
        assert.ok(!v.label, 'no label: the badge names the provider, as it always named Claude (' + v.label + ')');
        const rw = await writing.relatedWork({ ids: [A] });
        assert.equal(rw.provider, name, 'the related-work draft (its LaTeX comment) names its provider');
        const kp = await route(routeLibrary, 'POST', `/api/items/${A}/extract`, { mode: 'claude' });
        assert.equal(kp.code, 200, JSON.stringify(kp.data).slice(0, 300));
        assert.equal(kp.data.item.keypointSource, 'claude');
        assert.equal(kp.data.item.keypointBy, id, 'the key points record who picked them');
        assert.equal(it(A).keypointBy, id, '... in library.json too');
        const ns = ai.notStarted();
        if (id === 'claude') assert.match(ns, /^Claude Code could not be started/);
        else { assert.ok(ns.startsWith(ai.current().cliName + ' could not be started'), ns); assert.ok(!/Claude/.test(ns), 'no Claude in: ' + ns); }
        if (!ai.caps().readsImage) {
          await assert.rejects(notes.askAbout(it(A), { mode: 'ask', question: 'What? SENTINEL-img2', kind: 'image', asset: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', text: '', language: 'en' }),
            (e) => e.message.startsWith(`${name} cannot look at pictures`) && !/Claude/.test(e.message), 'the refusal names the provider and never suggests "Claude Code" (the display layer would rename it)');
        }
      } finally { settings({ aiProvider: undefined }); }
    });
  }
  // ================= 5. An older Claude Code: refused options -> one retry with the compatible set =================
  // (scripts/fixtures/fake-ai/fake.js oldclaude / ancientclaude: commander's "error: unknown option '--effort'")
  const compat = ai.claudeCompat;
  const claudeP = (calls) => calls.filter((c) => c.p === 'claude' && c.argv.includes('-p'));
  const valOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const withState = async (st, fn) => { process.env.FAKE_AI_STATE = st; compat._reset(); try { return await fn(); } finally { process.env.FAKE_AI_STATE = 'ok'; compat._reset(); } };
  const FEATURES = ['ask', 'translate', 'draft', 'quiz', 'diagram', 'grouping', 'compare', 'rewrite', 'related-work', 'key-points'];
  await test('older claude: the first refused feature call runs once more with the compatible options; later calls use them at once; every feature works', () => withState('oldclaude', async () => {
    const first = await runPath('ask');
    assert.ok(first.ok, 'ask worked on the retry: ' + JSON.stringify(first.detail).slice(0, 300));
    const fc = claudeP(first.calls);
    assert.equal(fc.length, 2, 'one refused call, one retry: ' + JSON.stringify(fc.map((c) => c.refused || 'ok')));
    assert.match(fc[0].refused, /^error: unknown option '--/);
    assert.deepEqual(fc[0].argv.map(norm), golden.ask.calls.find((c) => c.argv.includes('-p')).argv, 'the first try is the normal argv, unchanged');
    assert.ok(!fc[1].refused);
    assert.ok(compat.needsCompat(), 'remembered for this server run');
    for (const name of FEATURES) {
      const r = await runPath(name);
      assert.ok(r.ok, `${name} works with the older claude: ` + JSON.stringify(r.detail).slice(0, 300));
      const calls = claudeP(r.calls), want = golden[name].calls.filter((c) => c.argv.includes('-p'));
      assert.ok(calls.length >= 1 && calls.every((c) => !c.refused), `${name}: no refused call any more`);
      for (const [k, c] of calls.entries()) {
        for (const f of ['--effort', '--setting-sources', '--system-prompt', '--disable-slash-commands', '--no-session-persistence']) assert.ok(!c.argv.includes(f), `${name}: ${f} is not sent`);
        assert.ok(c.argv.includes('--strict-mcp-config'), `${name}: no MCP servers of the user's configuration`);
        const g = want[Math.min(k, want.length - 1)].argv;
        assert.equal(valOf(c.argv, '--tools'), valOf(g, '--tools'), `${name}: the same tools allowlist`);
        assert.equal(valOf(c.argv, '--allowedTools') === undefined ? undefined : norm(valOf(c.argv, '--allowedTools')), valOf(g, '--allowedTools'), `${name}: the same allowed tools`);
        assert.equal(valOf(c.argv, '--append-system-prompt'), valOf(g, '--system-prompt'), `${name}: the system prompt is appended instead`);
      }
    }
    // the picture question (Read allowed for one path only) is never run with the compatible set: it would load the
    // user's permission rules - the plain "update" message instead, after the one normal try
    const img = await runPath('ask-image');
    assert.ok(!img.ok);
    assert.ok(img.error && compat.TOO_OLD_RE.test(img.error.message), 'ask-image: ' + (img.error && img.error.message));
    const ic = claudeP(img.calls);
    assert.equal(ic.length, 1, 'ask-image: one try');
    assert.ok(ic[0].argv.includes('--setting-sources') && ic[0].argv.includes('--system-prompt'), 'ask-image: the normal argv');
    const chat = await runPath('chat');
    assert.ok(chat.ok, 'the panel works as before');
    assert.deepEqual(claudeP(chat.calls).map((c) => c.argv.map(norm)), golden.chat.calls.filter((c) => c.argv.includes('-p')).map((c) => c.argv), 'the panel argv is unchanged');
  }));
  await test('older claude, then `claude update`: the next call after the version changed uses the normal options again (no restart)', () => withState('oldclaude', async () => {
    assert.ok((await runPath('ask')).ok);
    await settle(100);
    assert.ok(compat.needsCompat());
    process.env.FAKE_AI_STATE = 'ok'; // (now version 9.9.9)
    compat._probeDue();
    assert.ok((await runPath('ask')).ok, 'still works while the version is asked');
    await settle(300);
    assert.ok(!compat.needsCompat(), 'cleared: the version changed');
    const r = await runPath('ask');
    assert.ok(claudeP(r.calls)[0].argv.includes('--setting-sources'), 'the normal argv again');
  }));
  await test('older claude, calls at the same time: each refused call gets its own retry (decided by the argv it used)', () => withState('oldclaude', async () => {
    clearLog();
    const rs = await Promise.allSettled([1, 2, 3].map((k) => notes.askAbout(it(A), { mode: 'ask', question: `Why ${k}? SENTINEL-par`, kind: 'note', text: 'x', language: 'en' })));
    assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled'], JSON.stringify(rs.map((r) => r.reason && r.reason.message)));
    assert.ok(claudeP(readLog()).length <= 6);
  }));
  await test('a claude that offers no --effort low: only --effort is left out, the other options stay; remembered', () => withState('effortvalue', async () => {
    const r = await runPath('ask');
    assert.ok(r.ok, JSON.stringify(r.detail).slice(0, 300));
    const fc = claudeP(r.calls);
    assert.equal(fc.length, 2);
    assert.match(fc[0].refused, /argument 'low' is invalid/);
    assert.deepEqual(fc[1].argv.map(norm), fc[0].argv.map(norm).filter((x, i, a) => !(x === '--effort' || a[i - 1] === '--effort')), 'only --effort low is left out');
    assert.ok(fc[1].argv.includes('--setting-sources') && fc[1].argv.includes('--no-session-persistence') && fc[1].argv.includes('--system-prompt'));
    assert.ok(!compat.needsCompat(), 'not the compatible set');
    assert.deepEqual(compat.refusedValues(), ['--effort low']);
    const again = await runPath('ask');
    assert.equal(claudeP(again.calls).length, 1, 'known now');
    assert.ok(!claudeP(again.calls)[0].argv.includes('--effort'));
    const d = await runPath('draft');
    assert.ok(d.ok);
    assert.equal(valOf(claudeP(d.calls)[0].argv, '--effort'), 'medium', 'another value is still passed');
  }));
  await test('older claude that refuses the compatible options too: one retry only, then the plain "update" message (EN, and translated)', () => withState('ancientclaude', async () => {
    const want = compat.tooOldMessage('1.0.30');
    assert.equal(want, 'Claude Code needs an update: run "claude update", then try again. Your version (1.0.30) does not support an option ResearchTool uses.');
    clearLog();
    await assert.rejects(notes.askAbout(it(A), { mode: 'ask', question: 'Why? SENTINEL-old', kind: 'note', text: 'x', language: 'en' }), (e) => e.message === want);
    const fc = claudeP(readLog());
    assert.equal(fc.length, 2, 'exactly one retry: ' + fc.length);
    assert.ok(fc.every((c) => c.refused));
    const stream = async (start) => { clearLog(); const res = new FakeRes(); await start(res); await res.done; const e = res.events().find((x) => x.type === 'error'); return { text: e ? e.text : JSON.stringify(res.events().slice(-1)), calls: claudeP(readLog()).length }; };
    for (const [f, start] of [['draft', (res) => notes.generateDraft(it(A), { language: 'en', res, startHash: notes.readNote(A).hash || null })],
      ['quiz', (res) => quiz.generate(it(A), { count: quiz.COUNTS[0], level: 'core', focus: '', language: 'en', res })],
      ['diagram', (res) => diagrams.generate(it(A), { kind: 'auto', focus: '', language: 'en', res })]]) {
      const r = await stream(start);
      assert.equal(r.text, want, f);
      assert.ok(r.calls <= 2, `${f}: no loop (${r.calls} calls)`);
    }
    // balanced mode, a PDF with enough text: the lean draft (PDF only) must not be asked for again from the text
    {
      const C = 'c0c1c2c3c4';
      fs.writeFileSync(path.join(WS, 'pdfs', C + '.pdf'), tinyPdf(Array.from({ length: 14 }, (_, k) => PAGE(k + 1))));
      const l0 = lib(); l0.items.push(item(C, 'A long paper', { pdf: true, pages: 14 })); core.saveLib(l0);
      try {
        compat._reset(); // (first use: the normal argv, then the compatible set)
        clearLog();
        const res = new FakeRes();
        await notes.generateDraft(it(C), { language: 'en', res, startHash: null });
        await res.done;
        const ev = res.events(), e = ev.find((x) => x.type === 'error');
        assert.equal(e && e.text, want, 'lean draft');
        assert.ok(!ev.some((x) => x.type === 'status' && /could not be read/.test(x.text)), 'no "the PDF could not be read" step');
        const n = claudeP(readLog()).length;
        assert.equal(n, 2, `lean draft: the normal try and the compatible one, no third call (${n} calls)`);
      } finally { const l1 = lib(); l1.items = l1.items.filter((i) => i.id !== C); core.saveLib(l1); fs.rmSync(path.join(WS, 'pdfs', C + '.pdf'), { force: true }); }
    }
    clearLog();
    await assert.rejects(writing.rewrite({ mode: 'improve', text: 'We propose SENTINEL-old.' }), (e) => e.message.includes(want));
    assert.equal(claudeP(readLog()).length, 1, 'known now: the compatible set at once, no retry');
    const l = lib(); l.items.find((i) => i.id === B).categoryStatus = 'pending'; core.saveLib(l);
    await cat.classifyOne(B);
    assert.ok(String(it(B).categoryError).includes(want), it(B).categoryError);
    const zh = require('../public/js/i18n/zh.js'), tr = require('../public/js/i18n.js').createTranslator(zh);
    assert.ok(/claude update/.test(tr.translate(want) || '') && /[\u4e00-\u9fff]/.test(tr.translate(want)), 'translated: ' + tr.translate(want));
    assert.ok(/[\u4e00-\u9fff]/.test(tr.translate('Claude could not answer: ' + want) || ''), 'translated with the prefix too');
  }));
  for (const st of ['signedout', 'quota']) {
    await test(`claude ${st}: not an option error - no retry, the compatible set is not used`, () => withState(st, async () => {
      const r = await runPath('ask');
      assert.ok(!r.ok);
      assert.equal(claudeP(r.calls).length, 1);
      assert.ok(!compat.needsCompat());
    }));
  }
  await test('a normal claude after all this: the argv of every feature is the golden one again', async () => {
    compat._reset();
    for (const name of ['ask', 'draft', 'grouping']) {
      const r = await runPath(name);
      // (argv and cwd: the env names and the prompts differ by now - the tests above set CODEX_HOME, wrote notes)
      const cut = (c) => ({ p: c.p, argv: c.argv, cwd: c.cwd });
      assert.deepEqual(r.calls.map(shape).map(cut), golden[name].calls.map(cut), name);
    }
  });

  // ================= 6. Help › Copy diagnostics: GET /api/diagnostics leaks nothing =================
  await test('GET /api/diagnostics: versions, tools and AI status, with no home path, workspace path or e-mail', async () => {
    const diag = require('../lib/diagnostics');
    diag.noteAiError('claude', `ENOENT reading ${path.join(WS, 'notes', 'x.md')} for bob.smith@example.com\nsecond line ${REAL_HOME}`);
    diag.noteAiError('codex', `failed at ${path.join(os.homedir(), '.codex', 'auth.json')}`);
    const r = await route(require('../lib/routes/diagnostics'), 'GET', '/api/diagnostics');
    assert.equal(r.code, 200, JSON.stringify(r).slice(0, 300));
    const d = r.data, s = JSON.stringify(d);
    assert.equal(d.app.version, require('../package.json').version);
    assert.equal(d.node, process.version);
    assert.equal(d.ai.provider, 'claude'); assert.equal(d.ai.version, '9.9.9'); assert.equal(d.ai.installed, true); assert.equal(d.ai.signedIn, true);
    assert.equal(d.ai.compatibleOptions, false);
    assert.deepEqual(Object.keys(d.tools).sort(), ['git', 'latexmk', 'pdftotext', 'unzip']);
    assert.equal(d.workspace, '<workspace>');
    for (const bad of [WS, TOP, REAL_HOME, os.homedir(), 'fake@example.invalid', 'bob.smith', '@example.com']) assert.ok(!s.includes(bad), 'leaks ' + bad + ': ' + s.slice(0, 600));
    assert.ok(!('account' in d.ai) && !/"email"|"account"/i.test(s), 'no account name');
    const e = d.aiErrors.slice(-2);
    assert.equal(e[0].text, 'ENOENT reading <workspace>/notes/x.md for <email>', 'first line only, redacted');
    assert.equal(e[1].text, 'failed at ~/.codex/auth.json');
    // a workspace and a home under another user's folder (a fake user path): <home>
    assert.equal(diag.redact('/Users/alice/Research/ws/notes/a.md and /home/bob/x and C:\\Users\\Carol\\ws'), '<home>/Research/ws/notes/a.md and <home>/x and <home>\\ws');
    // a name with a space, drives and shares, the macOS /private alias of the workspace either way round
    assert.equal(diag.redact('/Users/Jane Doe/Documents/x and C:\\Users\\Jane Doe\\x'), '<home>/Documents/x and <home>\\x');
    assert.equal(diag.redact('/Volumes/JaneDoeDrive/p/a.tex \\\\server\\home\\jdoe\\x'), '<volume>/p/a.tex <share>\\x');
    const realWs = fs.realpathSync.native(WS), alias = realWs.startsWith('/private/') ? realWs.slice(8) : null;
    assert.equal(diag.redact(realWs + '/a'), '<workspace>/a');
    if (alias) assert.equal(diag.redact(alias + '/a'), '<workspace>/a', 'the /private alias');
    // the user name of a proxy URL, keys and tokens
    assert.equal(diag.redact('https://user:pass@proxy.corp.example:8080 failed'), 'https://<user>@proxy.corp.example:8080 failed');
    for (const k of ['sk-ant-api03-AAAAbbbbCCCC1234dd', 'ghp_abcdefgh12345678', 'xai-abcdefgh1234', 'AIzaSyA1234567890abcdefghijklmn', 'sk-proj-abcdef123456']) {
      const r = diag.redact(`invalid x-api-key ${k} / Authorization: Bearer ${k}`);
      assert.ok(!r.includes(k.slice(4, 12)) && /<secret>/.test(r), r);
    }
    assert.equal(diag.redact("error: unknown option '--effort'"), "error: unknown option '--effort'", 'an option error stays readable');
    // the page: quoted pieces of its error messages
    const red = require('../public/js/redact.js');
    assert.equal(red.quoted(`Unexpected token 'm', "my private"... is not valid JSON`), `Unexpected token 'm', "<text>"... is not valid JSON`);
    assert.equal(red.quoted("Cannot read properties of null (reading 'boom')"), "Cannot read properties of null (reading 'boom')");
  });

  // ================= a CLI that is not installed: every feature says the same (notStarted, with its hint) =================
  for (const id of ['claude', 'antigravity', 'codex']) {
    await test(`${id}: with its CLI missing, every feature says that it could not be started and where to look`, async () => {
      const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
      const old = process.env[key];
      const empty = path.join(TOP, 'empty-bin-features'); fs.mkdirSync(empty, { recursive: true });
      settings({ aiProvider: id === 'claude' ? undefined : id });
      process.env[key] = empty;
      try {
        const want = ai.notStarted();
        const msgOf = async (fn) => { try { const r = await fn(); return r && r.error ? r.error : JSON.stringify(r); } catch (e) { return e.message; } };
        const stream = async (start) => { const res = new FakeRes(); await start(res); await res.done; const e = res.events().find((x) => x.type === 'error'); return e ? e.text : JSON.stringify(res.events().slice(-1)); };
        const got = {
          ask: await msgOf(() => notes.askAbout(it(A), { mode: 'ask', question: 'Why? SENTINEL-nf', kind: 'note', text: 'The method learns actions.', language: 'en' })),
          draft: await stream((res) => notes.generateDraft(it(A), { language: 'en', res, startHash: notes.readNote(A).hash || null })),
          quiz: await stream((res) => quiz.generate(it(A), { count: quiz.COUNTS[0], level: 'core', focus: '', language: 'en', res })),
          diagram: await stream((res) => diagrams.generate(it(A), { kind: 'auto', focus: '', language: 'en', res })),
          keyPoints: await msgOf(async () => { const r = await route(routeLibrary, 'POST', `/api/items/${A}/extract`, { mode: 'claude' }); return { error: r.data && (r.data.error || r.data.message) }; }),
          rewrite: await msgOf(() => writing.rewrite({ mode: 'improve', text: 'We propose a method SENTINEL-nf.' })),
          grouping: await msgOf(async () => { const l = lib(); l.items.find((i) => i.id === B).categoryStatus = 'pending'; core.saveLib(l); await cat.classifyOne(B); return { error: it(B).categoryError }; }),
        };
        for (const [f, m] of Object.entries(got)) assert.equal(m, want, `${f}: ${m}`);
      } finally { process.env[key] = old; settings({ aiProvider: undefined }); }
    });
  }
  await test('a note draft that could not be applied is labelled with the provider that wrote it', async () => {
    settings({ aiProvider: 'antigravity' });
    try {
      const res = new FakeRes();
      await notes.generateDraft(it(A), { language: 'en', res, startHash: 'not-the-hash-of-the-note' });
      await res.done;
      const c = res.events().find((e) => e.type === 'conflict');
      assert.ok(c, 'a conflict: ' + JSON.stringify(res.events().slice(-2)).slice(0, 300));
      assert.match(c.text, /while Antigravity was writing/);
      assert.ok(!/Claude/.test(c.text), c.text);
      const v = notes.listHistory(A).find((x) => x.id === c.versionId);
      assert.equal(v.label, 'Draft by Antigravity - not applied (the note changed meanwhile)');
      assert.equal(v.by, 'antigravity');
    } finally { settings({ aiProvider: undefined }); }
  });
  await test('history versions keep a valid provider id only (by), and show it in the public shape', () => {
    const H = require('../lib/history')(path.join(TOP, 'hist-by'));
    const h = H.open('p1');
    h.record('a.tex', Buffer.from('one'), 'claude', { by: 'grok' });
    h.record('a.tex', Buffer.from('two'), 'claude', { by: '../evil id' });
    h.record('a.tex', Buffer.from('three'), 'manual');
    h.commit();
    const vs = H.list('p1', 'a.tex', 10);
    assert.deepEqual(vs.map((v) => v.by || null), [null, null, 'grok']);
  });
  await test('usage: a call of another provider counts even when its CLI reported no tokens', () => {
    const before = core.usageSummary().byProvider.grok || { calls: 0 };
    core.recordUsage('ask', { usage: {}, duration_ms: 1200, _provider: 'grok' });
    core.recordUsage('ask', { usage: {} }); // a Claude result without numbers: nothing (as before)
    const after = core.usageSummary().byProvider.grok;
    assert.equal(after.calls, before.calls + 1);
  });

  // a fake that is missing (deleted, not executable, a shim mismatch) must not fall through to a CLI further on PATH
  const DECOY = path.join(TOP, 'decoy'), MARK = path.join(TOP, 'decoy-ran');
  await test('the guard refuses a CLI outside the fakes\' folder before it starts (a decoy "codex" later on PATH never runs)', async () => {
    fs.mkdirSync(DECOY, { recursive: true });
    const f = path.join(DECOY, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    fs.writeFileSync(f, process.platform === 'win32' ? `@echo off\r\necho x> "${MARK}"\r\n` : `#!/bin/sh\ntouch "${MARK}"\n`); fs.chmodSync(f, 0o755);
    const env = { ...process.env, [pathKey]: [path.join(TOP, 'empty-fakes'), DECOY].join(path.delimiter) };
    const c = (() => { try { return plat.spawnTool('codex', ['exec'], { env }); } catch (e) { return e; } })();
    if (!(c instanceof Error)) await new Promise((r) => { c.on('error', r); c.on('close', r); });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!fs.existsSync(MARK), 'the decoy ran');
    assert.ok(c instanceof Error || process.platform === 'win32', 'refused with an exception: ' + c);
  });

  await test('no real AI CLI was ever run: every claude / codex / gemini / grok / agy call resolved to its fake in the test folder', () => {
    const realAgy = path.join(REAL_HOME, '.local', 'bin', 'agy');
    const inBin = (f) => !!f && (path.dirname(f) === BIN || f.startsWith(BIN + path.sep));
    assert.ok(resolved.length > 50 && resolved.some((r) => r.cmd === 'agy'), 'calls were recorded: ' + resolved.length);
    // (file null: not found at all - the "not installed" test, whose PATH is an empty folder - so nothing was started)
    const bad = resolved.filter((r) => !(r.file && r.file.startsWith(DECOY + path.sep))).filter((r) => (r.file != null && !(process.platform === 'win32' ? inBin(r.via) || inBin(r.file) : inBin(r.file))) || r.file === realAgy);
    assert.ok(resolved.filter((r) => r.cmd === 'agy' && r.file).length > 20, 'agy ran (as its fake) for the feature tests');
    assert.deepEqual(bad, [], 'resolved outside the fakes\' folder');
    assert.deepEqual(process.env[pathKey].split(path.delimiter), TEST_PATH, 'PATH holds only the fakes and node');
    assert.deepEqual(fs.readdirSync(NODE_DIR), [process.platform === 'win32' ? 'node.exe' : 'node'], 'the node folder holds node only');
    // the guard (scripts/fixtures/fake-ai/guard.js) saw every start of an AI CLI before it happened, refused none
    const g = fs.readFileSync(GUARD_LOG, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(g.length >= resolved.filter((r) => r.file).length && g.some((x) => x.cmd === 'agy'), 'the guard saw the calls: ' + g.length + ' of ' + resolved.length + ' (' + resolved.filter((r) => r.file).length + ' found)');
    const decoy = (x) => !!x.file && x.file.startsWith(DECOY + path.sep);
    assert.ok(g.some((x) => decoy(x) && !x.ok) || process.platform === 'win32', 'the decoy was refused by the guard');
    assert.deepEqual(g.filter((x) => !decoy(x)).filter((x) => !x.ok || (x.file != null && (!inBin(x.file) || x.file === realAgy))), [], 'the guard refused or let through a CLI outside the fakes');
  });

  fs.rmSync(TOP, { recursive: true, force: true, maxRetries: 3 });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
