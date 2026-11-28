#!/usr/bin/env node
// Tests for the voice that reads aloud (lib/voice/, lib/routes/voice.js) without the engine, the model or the
// network: the tokenizer on a small vocabulary, the sampling, where the files live, which builds exist, the unpacking
// of a package tarball (only the wanted files, never outside the folder), the download helper against a server of
// this test (continuing a part, refusing plain http elsewhere, too much data), the list of pinned files, and the
// service with a stand-in for the speaking process (audio in order, cancelling, one sentence after the other, a
// process that cannot start, nothing installed).
// The real model is tried by hand: it needs the 800 MB download and a graphics processor.
// Run:  node scripts/test-voice.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const tokenizer = require('../lib/voice/tokenizer');
const files = require('../lib/voice/install');
const synth = require('../lib/voice/synth');
const voice = require('../lib/voice');

let failed = 0, n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-voice-'));

test('tokenizer: byte-level BPE with ranked merges, text is never a special token', () => {
  const B = tokenizer.BYTE_CHAR, sp = B[32];
  assert.equal(B[65], 'A'); assert.equal(sp, 'Ġ'); assert.equal(B[10], 'Ċ');
  const zh = Array.from(Buffer.from('中'), (b) => B[b]);
  const vocab = {};
  ['h', 'e', 'l', 'o', 'w', 'r', 'd', sp, 'he', 'll', 'hell', 'hello', sp + 'w', '<', '|', 'a', '>', ...zh, zh[0] + zh[1], zh.join(''), B[10], '1', '2', '.'].forEach((t, i) => { vocab[t] = i; });
  const T = tokenizer.create({ model: { type: 'BPE', vocab, merges: [['h', 'e'], ['l', 'l'], ['he', 'll'], ['hell', 'o'], [sp, 'w'], [zh[0], zh[1]], [zh[0] + zh[1], zh[2]]] }, added_tokens: [{ id: 900, content: '<|a|>' }] });
  assert.deepEqual(T.encode('hello'), [vocab.hello]);
  assert.deepEqual(T.encode('hello world'), [vocab.hello, vocab[sp + 'w'], vocab.o, vocab.r, vocab.l, vocab.d]);
  assert.deepEqual(T.encode('中'), [vocab[zh.join('')]]);
  assert.deepEqual(T.encode('12.'), [vocab['1'], vocab['2'], vocab['.']], 'digits one by one');
  assert.deepEqual(T.encode('<|a|>'), [vocab['<'], vocab['|'], vocab.a, vocab['|'], vocab['>']], 'special tokens in text are text');
  assert.equal(T.id('<|a|>'), 900);
  assert.deepEqual(T.encode(''), []);
  assert.throws(() => tokenizer.create({ model: { type: 'WordPiece' } }));
});

test('sampleTopK: only the k most likely, never a masked value, the offset of a slice', () => {
  const l = new Float32Array(100).fill(-5); l[7] = 50; l[8] = -Infinity;
  for (let i = 0; i < 20; i++) assert.equal(synth.sampleTopK(l, 0, 100), 7);
  const m = new Float32Array(10).fill(-Infinity); m[6] = 1;
  assert.equal(synth.sampleTopK(m, 5, 10), 1, 'counted from the start of the slice');
  const seen = new Set(); const u = new Float32Array(60).fill(0); for (let i = 0; i < 400; i++) seen.add(synth.sampleTopK(u, 0, 60, 0.9, 5));
  assert.ok(seen.size <= 5 && seen.size > 1);
});

test('an overrunning piece: how long a text should take, and the fade of a cut', () => {
  const E = synth.expectedFrames;
  assert.ok(E('这篇论文提出了一种新的方法。') >= 35 && E('这篇论文提出了一种新的方法。') <= 50, 'about a quarter of a second a character');
  assert.ok(E('This paper proposes a new method.') >= 20 && E('This paper proposes a new method.') <= 32);
  assert.ok(E('accuracy 92.3 and 1234567') > E('accuracy ab.c and abcdefg'), 'digits are said as words');
  assert.equal(E(''), 12); assert.equal(E('好'), 12, 'never less than a second');
  const f = synth.fadeOut(new Float32Array(3000).fill(1));
  assert.equal(f[0], 1); assert.equal(f[1559], 1); assert.ok(f[2999] === 0 && f[2200] < 1 && f[2200] > 0);
  assert.equal(synth.fadeOut(new Float32Array(10).fill(1))[9], 0);
});

test('the files: one folder per user outside the app, the builds that exist, the pinned list', () => {
  assert.equal(files.dir({}, 'darwin', '/Users/a'), path.join('/Users/a', 'Library', 'Application Support', 'ResearchTool', 'voice'));
  assert.equal(files.dir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U'), path.join('C:\\L', 'ResearchTool', 'voice'));
  assert.equal(files.dir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/a'), path.join('/x', 'researchtool', 'voice'));
  assert.equal(files.dir({}, 'linux', '/home/a'), path.join('/home/a', '.local', 'share', 'researchtool', 'voice'));
  assert.equal(files.dir({ RT_VOICE_DIR: TMP }, 'darwin', '/Users/a'), path.join(TMP, 'researchtool-voice'), 'a folder of its own inside the named one');
  assert.ok(!files.dir().startsWith(path.join(__dirname, '..') + path.sep), 'not inside the app folder');
  assert.deepEqual(files.supported('darwin', 'arm64', '20.1.0'), { ok: true, reason: '' });
  assert.equal(files.supported('darwin', 'x64', '20.1.0').reason, 'platform');
  assert.equal(files.supported('linux', 'x64', '16.0.0').reason, 'node');
  for (const m of files.MODEL) {
    assert.match(m.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//, 'a fixed revision: ' + m.url);
    assert.match(m.sha256, /^[0-9a-f]{64}$/); assert.ok(m.size > 0);
  }
  for (const e of files.ENGINE) { assert.match(e.url, /^https:\/\/registry\.npmjs\.org\/[\w-]+\/-\/[\w-]+-\d+\.\d+\.\d+\.tgz$/); assert.equal(Buffer.from(e.sha512, 'base64').length, 64); }
  assert.equal(files.TOTAL, [...files.MODEL, ...files.ENGINE].reduce((a, x) => a + x.size, 0));
  assert.equal(files.installed(path.join(TMP, 'nothing')), false);
  // what a stopped download leaves is known and can be deleted; remove() touches only its own four names
  const part = path.join(TMP, 'partial');
  fs.mkdirSync(path.join(part, 'tmp'), { recursive: true }); fs.mkdirSync(path.join(part, 'model'), { recursive: true });
  fs.writeFileSync(path.join(part, 'tmp', 'x.part'), 'x'); fs.writeFileSync(path.join(part, 'mine.txt'), 'kept');
  assert.equal(files.leftovers(part), true); assert.equal(files.leftovers(path.join(TMP, 'nothing')), false);
  files.remove(part);
  assert.deepEqual(fs.readdirSync(part), ['mine.txt']);
  assert.equal(files.leftovers(part), false);
  assert.throws(() => files.mirrored('https://a/b', 'b', { RT_VOICE_MIRROR: 'http://example.com' }), /this computer/);
  assert.equal(files.mirrored('https://a/b', 'x/y', { RT_VOICE_MIRROR: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9/x/y');
  assert.equal(files.mirrored('https://a/b', 'b', {}), 'https://a/b');
});

// a tar archive of [name, content | {type, link}] entries
function tar(entries) {
  const blocks = [];
  for (const [name, c] of entries) {
    const meta = Buffer.isBuffer(c) || typeof c === 'string' ? null : c;
    const data = Buffer.isBuffer(c) || typeof c === 'string' ? Buffer.from(c) : Buffer.alloc(0), h = Buffer.alloc(512);
    const cutAt = name.length > 100 ? name.lastIndexOf('/') : -1; // (ustar: a long name is split at a slash)
    h.write(cutAt < 0 ? name : name.slice(cutAt + 1), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write(meta ? meta.type : '0', 156);
    if (meta && meta.link) h.write(meta.link, 157);
    h.write('ustar\0', 257); h.write('00', 263);
    if (cutAt >= 0) h.write(name.slice(0, cutAt), 345);
    h.write('        ', 148); let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('untar: only the files of the engine that are needed, of this computer, and nothing outside the folder', async () => {
  const big = Buffer.alloc(70000, 7), long = 'package/dist/' + 'd'.repeat(60) + '/' + 'e'.repeat(60) + '.js';
  const tgz = path.join(TMP, 'p.tgz'), dest = path.join(TMP, 'unpacked');
  fs.writeFileSync(tgz, tar([
    ['package/package.json', '{}'], ['package/dist/index.js', 'x'], ['package/dist/cjs/package.json', '{"type":"commonjs"}'], ['package/dist/esm/index.js', 'no'],
    ['package/dist/index.d.ts', 'no'], ['package/script/install.js', 'no'], ['package/lib/index.ts', 'no'],
    ['package/bin/napi-v6/darwin/arm64/a.node', big], ['package/bin/napi-v6/win32/x64/b.dll', 'no'],
    ['package/../escape.js', 'no'], ['package/dist/../../escape2.js', 'no'], ['other/dist/index.js', 'no'],
    ['package/dist/link.js', { type: '2', link: '/etc/passwd' }], ['package/dist/dir.js', { type: '5' }], [long, 'long'],
  ]));
  await files.untar(tgz, dest, files.pickEngine('onnxruntime-node', 'darwin', 'arm64'));
  const got = [];
  (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/'); else got.push(rel + e.name); } })(dest, '');
  assert.deepEqual(got.sort(), ['bin/napi-v6/darwin/arm64/a.node', 'dist/cjs/package.json', 'dist/index.js', long.slice(8), 'package.json'].sort());
  assert.ok(fs.readFileSync(path.join(dest, 'bin/napi-v6/darwin/arm64/a.node')).equals(big));
  assert.ok(!fs.existsSync(path.join(TMP, 'escape.js')) && !fs.existsSync(path.join(TMP, 'escape2.js')));
  const pick = files.pickEngine('onnxruntime-common', 'linux', 'x64');
  assert.equal(pick('package/dist/cjs/index.js'), 'dist/cjs/index.js');
  assert.equal(pick('package/bin/napi-v6/linux/x64/x.node'), null, 'binaries only from the engine itself');
  // a picker that points outside is refused
  await assert.rejects(files.untar(tgz, path.join(TMP, 'u2'), () => '../out.js'), /leaves the folder/);
});

test('fetchTo: a part is continued, plain http only on this computer, too much data is refused', async () => {
  const body = Buffer.from('0123456789'.repeat(1000));
  const asked = [];
  const srv = http.createServer((req, res) => {
    asked.push(req.headers.range || '');
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); return res.end(); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    if (req.url === '/big') { res.writeHead(200); return res.end(Buffer.concat([body, body])); }
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) { res.writeHead(206); return res.end(body.subarray(Number(m[1]))); }
    res.writeHead(200); res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const f = path.join(TMP, 'f.part');
    let counted = 0;
    assert.equal(await files.fetchTo(base + '/redirect', f, { size: body.length, local: true, onBytes: (k) => { counted += k; } }), body.length);
    assert.ok(fs.readFileSync(f).equals(body)); assert.equal(counted, body.length);
    fs.writeFileSync(f, body.subarray(0, 4000));
    await files.fetchTo(base + '/file', f, { size: body.length, local: true });
    assert.ok(fs.readFileSync(f).equals(body), 'continued, not started again');
    assert.equal(asked[asked.length - 1], 'bytes=4000-');
    const before = asked.length;
    await files.fetchTo(base + '/file', f, { size: body.length, local: true });
    assert.equal(asked.length, before, 'a complete file asks nothing');
    await assert.rejects(files.fetchTo(base + '/file', path.join(TMP, 'g.part'), { size: body.length }), /not an https address/);
    await assert.rejects(files.fetchTo(base + '/big', path.join(TMP, 'h.part'), { size: body.length, local: true }), (e) => e.code === 'hash');
    await assert.rejects(files.fetchTo(base + '/missing', path.join(TMP, 'i.part'), { size: 5, local: true }), (e) => e.code === 'gone');
    const ac = new AbortController(); ac.abort();
    await assert.rejects(files.fetchTo(base + '/file', path.join(TMP, 'j.part'), { size: body.length, local: true, signal: ac.signal }), (e) => e.code === 'cancelled');
  } finally { srv.close(); }
});

// a stand-in for lib/voice/worker.js: three pieces of two bytes per sentence, slowly; "boom" fails
const FAKE = `
const out = (m) => process.send(m), cancelled = new Set(); let busy = Promise.resolve();
process.on('disconnect', () => process.exit(0));
process.on('message', (m) => {
  if (m.type === 'cancel') return cancelled.add(m.id);
  busy = busy.then(async () => {
    if (m.text === 'boom') return out({ type: 'error', id: m.id, message: 'boom' });
    for (let i = 0; i < 3 && !cancelled.has(m.id); i++) { await new Promise((r) => setTimeout(r, 40)); if (!cancelled.has(m.id)) out({ type: 'audio', id: m.id, pcm: Buffer.from([m.text.charCodeAt(0), i]) }); }
    out({ type: 'done', id: m.id, frames: 3, seconds: 0.24, voice: m.voice });
  });
});
if (process.argv[2].includes('nogpu')) out({ type: 'fatal', code: 'gpu', message: 'no adapter' });
else setTimeout(() => out({ type: 'ready' }), process.argv[2].includes('slow') ? 300 : 0);
`;

test('the service: audio in order, one sentence after the other, cancelling, errors, nothing installed', async () => {
  const workerFile = path.join(TMP, 'fake-worker.js');
  fs.writeFileSync(workerFile, FAKE);
  const dir = path.join(TMP, 'installed');
  fs.mkdirSync(dir, { recursive: true });
  const none = voice.create({ dir: path.join(TMP, 'empty'), workerFile });
  await assert.rejects(none.speak({ text: 'a', lang: 'en-US' }, () => {}), (e) => e.code === 'missing');
  assert.equal(none.status().installed, false); assert.equal(none.status().loaded, false);
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ version: files.VERSION }));
  const v = voice.create({ dir, workerFile, idleMs: 150 });
  try {
    assert.equal(v.status().installed, true);
    await assert.rejects(v.speak({ text: 'a', lang: 'fr-FR' }, () => {}), (e) => e.code === 'bad');
    assert.equal(voice.hasChinese('作者提出通用方法 RECAP（RL with Experience and Corrections）'), true);
    assert.equal(voice.hasChinese('We call this 尺度 ambiguity in the monocular setting.'), true);
    assert.equal(voice.hasChinese('Plain English.'), false);
    const got = [];
    const [a, b] = await Promise.all([
      v.speak({ text: 'a', lang: 'en-US' }, (p) => got.push('a' + p[1])),
      v.speak({ text: 'b', lang: 'zh-CN', voice: 'nobody' }, (p) => got.push('b' + p[1])),
    ]);
    assert.deepEqual(got, ['a0', 'a1', 'a2', 'b0', 'b1', 'b2'], 'whole sentences, in the order asked');
    assert.equal(a.frames, 3); assert.equal(b.seconds, 0.24);
    assert.equal(v.status().loaded, true);
    const ac = new AbortController(), part = [];
    const t = v.speak({ text: 'c', lang: 'en-US' }, (p) => { part.push(p[1]); ac.abort(); }, ac.signal);
    await t;
    assert.ok(part.length < 3, 'stopped early: ' + part.length);
    await assert.rejects(v.speak({ text: 'boom', lang: 'en-US' }, () => {}), (e) => e.code === 'failed');
    await v.speak({ text: 'd', lang: 'en-US' }, () => {});
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(v.status().loaded, false, 'the process ends after the idle time');
    await v.speak({ text: 'e', lang: 'en-US' }, () => {});
    assert.equal(v.status().loaded, true, 'and starts again when asked');
  } finally { v.stop(); }
  // stopped while the model was still loading: the process is not kept for ever
  const dir3 = path.join(TMP, 'slow');
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(path.join(dir3, 'installed.json'), JSON.stringify({ version: files.VERSION }));
  const sl = voice.create({ dir: dir3, workerFile, idleMs: 200 });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(sl.speak({ text: 'a', lang: 'en-US' }, () => {}, ac.signal), (e) => e.code === 'cancelled');
    assert.equal(sl.status().loaded, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sl.status().loaded, false, 'ended after the idle time');
    // remove waits for the process and deletes; the status says nothing is left
    await sl.speak({ text: 'a', lang: 'en-US' }, () => {});
    const st = await sl.remove();
    assert.equal(st.installed, false); assert.equal(st.partial, false); assert.equal(st.loaded, false);
  } finally { sl.stop(); }
  // a process that cannot be started at all: an error with its code, not a request that waits for ever
  const dir4 = path.join(TMP, 'nospawn');
  fs.mkdirSync(dir4, { recursive: true });
  fs.writeFileSync(path.join(dir4, 'installed.json'), JSON.stringify({ version: files.VERSION }));
  const ns = voice.create({ dir: dir4, workerFile: path.join(TMP, 'there-is-no-such-file.js') });
  try {
    await assert.rejects(ns.speak({ text: 'a', lang: 'en-US' }, () => {}), (e) => e.code === 'engine');
    assert.equal(ns.status().loaded, false);
  } finally { ns.stop(); }
  // a computer without the graphics backend: said once, with its code, and the process is gone
  const dir2 = path.join(TMP, 'nogpu');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'installed.json'), JSON.stringify({ version: files.VERSION }));
  const g = voice.create({ dir: dir2, workerFile });
  try {
    await assert.rejects(g.speak({ text: 'a', lang: 'en-US' }, () => {}), (e) => e.code === 'gpu');
    assert.equal(g.status().problem, 'gpu');
  } finally { g.stop(); }
});

test('install through the service: progress, a failure is a code, a second click does not start twice', async () => {
  const dir = path.join(TMP, 'svc');
  let calls = 0, release;
  const v = voice.create({ dir, install: ({ onProgress }) => { calls++; onProgress(10, 100); return new Promise((res, rej) => { release = { res, rej }; }); } });
  if (!files.supported().ok) { assert.throws(() => v.install()); return; }
  assert.equal(v.install().installing, true);
  v.install();
  assert.equal(calls, 1);
  assert.deepEqual([v.status().done, v.status().total], [10, 100]);
  release.rej(Object.assign(new Error('x'), { code: 'offline' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(v.status().installing, false); assert.equal(v.status().problem, 'offline');
  v.install(); release.rej(Object.assign(new Error('weird'), { code: 'E_WEIRD 1' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(v.status().problem, 'failed', 'only plain words reach the page');
  // remove while a download runs: the download is stopped and waited for first
  let aborted = false;
  const w = voice.create({ dir: path.join(TMP, 'svc2'), install: ({ signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => { aborted = true; setTimeout(() => rej(Object.assign(new Error('c'), { code: 'cancelled' })), 50); })) });
  w.install();
  const after = await w.remove();
  assert.equal(aborted, true); assert.equal(after.installing, false); assert.equal(after.problem, '');
});

(async () => {
  for (const [name, fn] of tests) {
    n++;
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 12).join('\n     ')); }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${n - failed} of ${n} passed`);
  process.exit(failed ? 1 : 0);
})();
