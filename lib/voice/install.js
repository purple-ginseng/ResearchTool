// The files of the natural voice: where they live, what they are, and how they get there.
// Nothing of this ships with the app (it stays "zero npm dependencies"): the engine (onnxruntime-node, MIT) and the
// model (Qwen3-TTS 0.6B CustomVoice as ONNX graphs, Apache 2.0) are fetched once, on the user's click in
// Preferences, from the npm registry and from Hugging Face, each file at a pinned version with its checksum. A file
// whose checksum differs is thrown away, so what runs is exactly what was tried when this list was written.
// They are kept outside the app folder and the workspace (one copy per user, untouched by updates and backups).
//   dir() -> the folder; supported() -> {ok, reason}; installed() -> boolean; TOTAL bytes to download
//   install({ onProgress(done, total), signal }) -> Promise; remove()
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = 1; // of this list: another number means "install again"
const ORT = '1.31.1';
const ENGINE = [
  { name: 'onnxruntime-node', url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT}.tgz`, size: 115391311, sha512: 'ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==' },
  { name: 'onnxruntime-common', url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ORT}.tgz`, size: 72322, sha512: 'F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==' },
];
const HF = 'https://huggingface.co/danyalmalik/';
const TALKER = HF + 'Qwen3-TTS-12Hz-0.6B-CustomVoice-ONNX-WebGPU/resolve/ccdd14012062ee383dda616d7799cc955924af8a/';
const CODEC = HF + 'Qwen3-TTS-Tokenizer-12Hz-ONNX-WebGPU/resolve/b2aa169358f3ba36110a9c9ce7d5a75209e39b7f/';
const MODEL = [
  ['config.json', TALKER, 4908, '81aca2b6fac304944d8acf345272d8a9a727d5fc2e2e66b222ab4729340c7455'],
  ['tokenizer.json', TALKER, 11423986, '09267689b8362020b9763b65dd5be7e086b31e28d72e02837a9e781de9a91bc7'],
  ['text_embed_q4.onnx', TALKER, 97239399, '6a0d7fa5c29e1a60ccce507a92827ddb432ddf49dfea8c166a886c5c7d138df9'],
  ['codec_embed_q4.onnx', TALKER, 21627240, 'e5f424a00c8c565f1d660f6dffd69ff3be9bceeacdd55b5c0eb936bd72958cd5'],
  ['talker/model.onnx', TALKER, 276512, '2edc5aed01da638848a17123ee0673782d6d5a406339969e4198e555a2ab8ff3'],
  ['talker/model.onnx.data', TALKER, 301203456, '026537338baf696232457b7e624a9c8794f16caa358a5a8cc88d92f61a091e3c'],
  ['code_predictor/model.onnx', TALKER, 56354, '6ac4c6c4cc831ff024015537d1ae16c0d3e72b17e4ef512c4c5924a26a7b7a4c'],
  ['code_predictor/model.onnx.data', TALKER, 157483008, '35284527836a5c52836f58d4fe0e140eb3a9a442cbeed44cd8d494c5eb056bf8'],
  ['tok_decoder_q4.onnx', CODEC, 100611208, '75b53ce2ef29c390eeda17c6ffd76a34cf05cef9e0da0de05c42dfe563084a93'],
].map(([file, base, size, sha256]) => ({ file, url: base + file, size, sha256 }));
const TOTAL = ENGINE.reduce((n, e) => n + e.size, 0) + MODEL.reduce((n, m) => n + m.size, 0);
// the engine's package has a build for these (there is none for Intel Macs)
const BUILDS = new Set(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']);

function dir(env = process.env, platform = process.platform, home = os.homedir()) {
  // (a folder of its own inside the named one: install and remove only ever touch what the app made)
  if (env.RT_VOICE_DIR) return path.join(path.resolve(env.RT_VOICE_DIR), 'researchtool-voice');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ResearchTool', 'voice');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ResearchTool', 'voice');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'researchtool', 'voice');
}
const engineDir = (d = dir()) => path.join(d, 'engine');
const modelDir = (d = dir()) => path.join(d, 'model');
const marker = (d = dir()) => path.join(d, 'installed.json');

function supported(platform = process.platform, arch = process.arch, node = process.versions.node) {
  if (!BUILDS.has(`${platform}-${arch}`)) return { ok: false, reason: 'platform' };
  if (Number(node.split('.')[0]) < 18) return { ok: false, reason: 'node' };
  return { ok: true, reason: '' };
}
function installed(d = dir()) {
  try { return JSON.parse(fs.readFileSync(marker(d), 'utf8')).version === VERSION; } catch { return false; }
}
// files of a download that did not finish (or of a removal that could not): there is something to delete
function leftovers(d = dir()) {
  return !installed(d) && ['tmp', 'engine', 'model'].some((n) => fs.existsSync(path.join(d, n)));
}

// ---------------------------------------------------------------- download
// Tests (and nobody else) point RT_VOICE_MIRROR at a server of this computer that has the same files under their
// names; the checksums are checked all the same.
function mirrored(url, key, env = process.env) {
  const m = env.RT_VOICE_MIRROR;
  if (!m) return url;
  const u = new URL(m);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('RT_VOICE_MIRROR must be an http address of this computer');
  return m.replace(/\/+$/, '') + '/' + key;
}
const coded = (code, message) => Object.assign(new Error(message || code), { code });

// GET url into `file`, continuing a part that is already there; resolves with the size on disk
function fetchTo(url, file, { size, signal, onBytes, redirects = 5, local = false }) {
  return new Promise((resolve, reject) => {
    let have = 0;
    try { have = fs.statSync(file).size; } catch { /* nothing yet */ }
    if (have > size) { fs.rmSync(file, { force: true }); have = 0; }
    if (have === size) return resolve(have);
    if (signal && signal.aborted) return reject(coded('cancelled'));
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return reject(coded('failed', 'refused: not an https address'));
    let req = null, out = null, settled = false;
    const onAbort = () => fail(coded('cancelled'));
    const settle = () => { settled = true; if (signal) signal.removeEventListener('abort', onAbort); };
    // every way out goes through here: the request and the file are closed, and no stream is left to throw by itself
    function fail(err) {
      if (settled) return;
      settle();
      if (req) { req.on('error', () => {}); req.destroy(); }
      if (out) { out.on('error', () => {}); out.destroy(); }
      reject(err);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'User-Agent': 'ResearchTool', ...(have ? { Range: `bytes=${have}-` } : {}) } }, (res) => {
      res.on('error', (e) => fail(coded('offline', e.message)));
      const code = res.statusCode;
      try { // (this callback runs outside the promise: what throws here must become its rejection)
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (settled) return;
          if (redirects <= 0) return fail(coded('failed', 'too many redirects'));
          let next;
          try { next = new URL(res.headers.location, u).href; } catch { return fail(coded('failed', 'a redirect that is not an address')); }
          settle();
          return fetchTo(next, file, { size, signal, onBytes, redirects: redirects - 1, local }).then(resolve, reject);
        }
        if (code === 416) { fs.rmSync(file, { force: true }); return fail(coded('failed', 'the server refused the range')); }
        if (code !== 200 && code !== 206) return fail(coded(code === 404 ? 'gone' : 'failed', `HTTP ${code}`));
        if (code === 200 && have) { fs.rmSync(file, { force: true }); have = 0; }
        out = fs.createWriteStream(file, { flags: have ? 'a' : 'w' });
      } catch (e) { res.resume(); return fail(coded('disk', e.message)); }
      let got = have;
      res.on('data', (c) => {
        if (settled) return;
        got += c.length;
        if (got > size) return fail(coded('hash', 'more data than expected'));
        if (onBytes) onBytes(c.length);
      });
      out.on('error', (e) => fail(coded('disk', e.message)));
      out.on('finish', () => { if (settled) return; if (got !== size) return fail(coded('offline', 'the connection ended early')); settle(); resolve(got); });
      res.pipe(out);
    });
    req.setTimeout(60000, () => fail(coded('offline', 'no answer')));
    req.on('error', (e) => fail(coded('offline', e.message)));
  });
}
function digest(file, algo, enc) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest(enc)));
  });
}
// one file, checked: a part that turns out wrong is deleted and fetched once more from the start
async function fetchChecked(url, file, { size, algo, enc, want, signal, onBytes, local }) {
  for (let attempt = 0; ; attempt++) {
    let counted = 0;
    try { counted = fs.statSync(file).size; if (counted <= size && onBytes) onBytes(counted); else counted = 0; } catch { /* nothing yet */ }
    let net = 0;
    for (;;) { // a dropped connection continues where it stopped, a few times
      try { await fetchTo(url, file, { size, signal, onBytes: (n) => { counted += n; if (onBytes) onBytes(n); }, local }); break; }
      catch (e) { if (e.code !== 'offline' || ++net > 4 || (signal && signal.aborted)) throw e; await new Promise((r) => setTimeout(r, 1500 * net)); }
    }
    if ((await digest(file, algo, enc)) === want) return;
    fs.rmSync(file, { force: true });
    if (onBytes) onBytes(-counted);
    if (attempt >= 1) throw coded('hash', 'a downloaded file is not the expected one');
  }
}

// ---------------------------------------------------------------- .tgz
// The files of a package tarball that `pick(name)` gives a place (a path under dest, or null): regular files only.
async function untar(tgz, dest, pick, signal) {
  const root = path.resolve(dest);
  let pending = Buffer.alloc(0), entry = null, longName = null, ended = false;
  const oct = (b) => parseInt(b.toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
  const str = (b) => b.toString('utf8').replace(/\0.*$/, '');
  const take = (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (ended) return;
      if (!entry) {
        if (pending.length < 512) return;
        const h = pending.subarray(0, 512); pending = pending.subarray(512);
        if (h.every((x) => x === 0)) { ended = true; return; }
        const type = String.fromCharCode(h[156] || 48), size = oct(h.subarray(124, 136));
        let name = str(h.subarray(0, 100));
        const prefix = h.subarray(257, 262).toString('latin1') === 'ustar' ? str(h.subarray(345, 500)) : '';
        if (prefix) name = prefix + '/' + name;
        if (longName != null && type !== 'L' && type !== 'x') { name = longName; longName = null; }
        entry = { type, left: size, pad: (512 - (size % 512)) % 512, fd: null, meta: type === 'L' || type === 'x' ? [] : null };
        if (type === '0') {
          const rel = pick(name);
          if (rel) {
            const file = path.resolve(root, rel);
            if (!file.startsWith(root + path.sep)) throw coded('failed', 'a path leaves the folder');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            entry.fd = fs.openSync(file, 'w');
          }
        }
      }
      if (entry.left > 0) {
        if (!pending.length) return;
        const part = pending.subarray(0, Math.min(entry.left, pending.length));
        pending = pending.subarray(part.length); entry.left -= part.length;
        if (entry.fd != null) fs.writeSync(entry.fd, part);
        if (entry.meta) entry.meta.push(Buffer.from(part));
        if (entry.left > 0) return;
      }
      if (pending.length < entry.pad) return;
      pending = pending.subarray(entry.pad);
      if (entry.fd != null) fs.closeSync(entry.fd);
      if (entry.meta) {
        const text = Buffer.concat(entry.meta).toString('utf8');
        if (entry.type === 'L') longName = text.replace(/\0.*$/, '');
        else { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text); if (m) longName = m[1]; }
      }
      entry = null;
    }
  };
  const src = fs.createReadStream(tgz), gz = zlib.createGunzip();
  src.on('error', (e) => gz.destroy(e)); // (pipe() does not pass a read error on)
  try {
    for await (const chunk of src.pipe(gz)) {
      if (signal && signal.aborted) throw coded('cancelled');
      take(chunk);
    }
  } finally {
    src.destroy();
    if (entry && entry.fd != null) { try { fs.closeSync(entry.fd); } catch { /* closed */ } }
  }
}
// what of the two packages is needed to run: the JavaScript and the build of this computer
function pickEngine(name, platform = process.platform, arch = process.arch) {
  return (entryName) => {
    const m = /^package\/(.+)$/.exec(entryName);
    if (!m || m[1].split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
    const rel = m[1];
    if (rel === 'package.json' || rel === 'LICENSE') return rel;
    // (dist/cjs/package.json says "commonjs" inside a package that is an ES module by default: it is needed)
    if (/^dist\/(?:.+\.js|(?:.+\/)?package\.json)$/.test(rel) && !rel.startsWith('dist/esm/')) return rel;
    if (name === 'onnxruntime-node' && rel.startsWith(`bin/napi-v6/${platform}/${arch}/`)) return rel;
    return null;
  };
}

// ---------------------------------------------------------------- install / remove
async function install({ onProgress = () => {}, signal, d = dir(), env = process.env } = {}) {
  const sup = supported();
  if (!sup.ok) throw coded(sup.reason);
  const tmp = path.join(d, 'tmp'), local = !!env.RT_VOICE_MIRROR;
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) { throw coded('disk', e.message); }
  fs.rmSync(marker(d), { force: true });
  let done = 0;
  const onBytes = (n) => { done += n; onProgress(Math.max(0, Math.min(done, TOTAL)), TOTAL); };
  const check = () => { if (signal && signal.aborted) throw coded('cancelled'); };
  try {
    // the model, file by file (a file that is already complete and right is kept)
    for (const m of MODEL) {
      const dest = path.join(modelDir(d), ...m.file.split('/'));
      let ok = false;
      try { ok = fs.statSync(dest).size === m.size && (await digest(dest, 'sha256', 'hex')) === m.sha256; } catch { /* not there */ }
      check();
      if (ok) { onBytes(m.size); continue; }
      const part = path.join(tmp, m.file.replace(/\//g, '__') + '.part');
      await fetchChecked(mirrored(m.url, m.file, env), part, { size: m.size, algo: 'sha256', enc: 'hex', want: m.sha256, signal, onBytes, local });
      check();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(part, dest);
    }
    // the engine: two package tarballs, unpacked into engine/node_modules
    const fresh = path.join(tmp, 'engine');
    fs.rmSync(fresh, { recursive: true, force: true });
    for (const e of ENGINE) {
      const tgz = path.join(tmp, path.basename(new URL(e.url).pathname) + '.part');
      await fetchChecked(mirrored(e.url, path.basename(new URL(e.url).pathname), env), tgz, { size: e.size, algo: 'sha512', enc: 'base64', want: e.sha512, signal, onBytes, local });
      check();
      await untar(tgz, path.join(fresh, 'node_modules', e.name), pickEngine(e.name), signal);
    }
    check();
    if (!fs.existsSync(path.join(fresh, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node'))) throw coded('platform');
    fs.rmSync(engineDir(d), { recursive: true, force: true });
    fs.renameSync(fresh, engineDir(d));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(marker(d), JSON.stringify({ version: VERSION, engine: ORT, when: new Date().toISOString() }));
  } catch (e) {
    if (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') throw coded('disk', e.message);
    throw e;
  }
}
// only what install() made, inside the voice folder
function remove(d = dir()) {
  // the marker goes last: a removal that could not finish still shows as installed, with its Remove button
  for (const name of ['tmp', 'engine', 'model', 'installed.json']) fs.rmSync(path.join(d, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  try { fs.rmdirSync(d); } catch { /* something else is in it, or it never was */ }
}

module.exports = { VERSION, ORT, ENGINE, MODEL, TOTAL, BUILDS, dir, engineDir, modelDir, supported, installed, leftovers, install, remove, untar, pickEngine, fetchTo, mirrored };
