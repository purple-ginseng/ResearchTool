// The natural voice (reading aloud with a neural model instead of the system's voices), as the server sees it:
// is it there, fetch it, remove it, and speak. The files are lib/voice/install.js's business, the model runs in
// lib/voice/worker.js (a process of its own, started on the first sentence and ended after some idle minutes, so
// its memory is only held while something is read).
//   create({ dir?, idleMs? }) -> { status(), install(), cancelInstall(), remove(), speak({text, lang, voice}, onAudio, signal), stop() }
'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
const files = require('./install');
const { VOICES, DEFAULT_VOICE, RATE } = require('./synth');

const LANGS = new Set(['zh-CN', 'en-US']);
const hasChinese = (t) => { const han = (String(t).match(/[\u3400-\u9fff]/g) || []).length; return han >= 2; }; // (any Chinese in it: a Chinese speaker says English terms well, not the other way round)
const coded = (code, message) => Object.assign(new Error(message || code), { code });

function create({ dir = files.dir(), idleMs = 5 * 60 * 1000, install = files.install, workerFile = path.join(__dirname, 'worker.js') } = {}) {
  let installing = null;   // {done, total, abort}
  let problem = '';        // the code of what went wrong last ('' = nothing): offline, hash, disk, gpu, engine ...
  let child = null, ready = null, idle = null, nextId = 1;
  const jobs = new Map();  // id -> {onAudio, resolve, reject}

  function status() {
    const sup = files.supported();
    return {
      supported: sup.ok, reason: sup.reason, installed: files.installed(dir), partial: !installing && files.leftovers(dir), bytes: files.TOTAL,
      installing: !!installing, done: installing ? installing.done : 0, total: installing ? installing.total : 0,
      problem, loaded: !!child, rate: RATE, voices: VOICES, defaults: DEFAULT_VOICE,
    };
  }

  function startInstall() {
    const sup = files.supported();
    if (!sup.ok) throw coded(sup.reason);
    if (installing || files.installed(dir)) return status();
    const ac = new AbortController();
    const mine = installing = { done: 0, total: files.TOTAL, abort: () => ac.abort(), promise: null };
    problem = '';
    mine.promise = install({ d: dir, signal: ac.signal, onProgress: (done, total) => { mine.done = done; mine.total = total; } })
      .then(() => { problem = ''; }, (e) => { problem = e.code === 'cancelled' ? '' : (typeof e.code === 'string' && /^[a-z]+$/.test(e.code) ? e.code : 'failed'); if (e.code !== 'cancelled') console.error('voice install:', e.message); })
      .finally(() => { if (installing === mine) installing = null; });
    return status();
  }
  function cancelInstall() { if (installing) installing.abort(); return status(); }

  function stop() { // -> the process that was told to end, or null
    clearTimeout(idle);
    const c = child; child = null; ready = null;
    if (c) { try { c.kill(); } catch { /* gone */ } }
    for (const j of jobs.values()) j.reject(coded('stopped'));
    jobs.clear();
    return c;
  }
  // A running download is stopped and waited for, and so is the speaking process: files are deleted only when
  // nothing writes or holds them any more.
  async function remove() {
    const cur = installing;
    if (cur) { cur.abort(); await cur.promise; }
    const c = stop();
    if (c && c.exitCode === null && c.signalCode === null) await new Promise((r) => { c.once('exit', r); const t = setTimeout(r, 5000); if (t.unref) t.unref(); });
    files.remove(dir);
    problem = '';
    return status();
  }

  function start() {
    if (ready) return ready;
    const c = child = fork(workerFile, [files.engineDir(dir), files.modelDir(dir)], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    ready = new Promise((resolve, reject) => {
      c.on('message', (m) => {
        if (!m) return;
        if (m.type === 'ready') { problem = ''; return resolve(); }
        if (m.type === 'fatal') { problem = m.code === 'gpu' ? 'gpu' : 'engine'; console.error('voice:', m.message); reject(coded(problem)); return; }
        const j = jobs.get(m.id);
        if (!j) return;
        if (m.type === 'audio') { try { j.onAudio(Buffer.from(m.pcm.buffer, m.pcm.byteOffset, m.pcm.byteLength)); } catch (e) { console.error(e); } return; }
        jobs.delete(m.id);
        if (m.type === 'done') j.resolve({ frames: m.frames, seconds: m.seconds });
        else j.reject(coded('failed', m.message));
      });
      const gone = () => {
        if (child !== c) return; // (an older process that ends later has no say over the jobs of the next one)
        child = null; ready = null;
        for (const [id, j] of jobs) { jobs.delete(id); j.reject(coded('engine')); }
      };
      c.on('exit', () => { reject(coded('engine')); gone(); });
      c.on('error', () => { problem = 'engine'; reject(coded('engine')); gone(); }); // a process that could not be started: no 'exit' follows
    });
    ready.catch(() => { if (child === c) { child = null; ready = null; try { c.kill(); } catch { /* gone */ } } });
    return ready;
  }

  // onAudio(Buffer): 16-bit mono samples at RATE, piece by piece. Sentences are spoken one after another.
  // stream: false = the audio of the whole text comes at the end, decoded in one go (no seams inside it)
  async function speak({ text, lang, voice, stream = true }, onAudio, signal) {
    if (!files.installed(dir)) throw coded('missing');
    if (!LANGS.has(lang)) throw coded('bad');
    // Chinese text is read as Chinese by a Chinese speaker, whatever the page asked for: the English speakers
    // read Chinese with a heavy accent (a page that was open before an update may still ask for it)
    if (lang !== 'zh-CN' && hasChinese(text)) { lang = 'zh-CN'; if (!VOICES.some((x) => x.id === voice && x.lang === 'zh-CN')) voice = DEFAULT_VOICE['zh-CN']; }
    clearTimeout(idle);
    try {
      await start();
      if (signal && signal.aborted) throw coded('cancelled');
      const id = nextId++, c = child;
      if (!c) throw coded('engine');
      return await new Promise((resolve, reject) => {
        jobs.set(id, { onAudio, resolve, reject });
        if (signal) signal.addEventListener('abort', () => { try { c.send({ type: 'cancel', id }); } catch { /* gone */ } }, { once: true });
        c.send({ type: 'speak', id, text, lang, stream: stream !== false, voice: VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE[lang] });
      });
    } finally {
      clearTimeout(idle);
      if (child && !jobs.size) { idle = setTimeout(stop, idleMs); if (idle.unref) idle.unref(); } // (also after a stop while it loaded)
    }
  }

  return { status, install: startInstall, cancelInstall, remove, speak, stop, dir };
}

module.exports = { create, LANGS, VOICES, hasChinese };
