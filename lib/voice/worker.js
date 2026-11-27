// The process that speaks (started by lib/voice/index.js with child_process.fork, "advanced" serialization so
// audio travels as Buffers). It holds the engine and the model (about 1.5 GB of memory) and nothing else: no HTTP,
// no workspace. Arguments: <engine folder> <model folder>.
//   in:  {type: 'speak', id, text, lang, voice} | {type: 'cancel', id}
//   out: {type: 'ready'} | {type: 'fatal', code, message} | {type: 'audio', id, pcm} | {type: 'done', id, frames, seconds}
//        | {type: 'error', id, message}
'use strict';
const path = require('node:path');
const [engine, model] = process.argv.slice(2);
const out = (m) => { try { process.send(m); } catch { process.exit(0); } };
const cancelled = new Set();
let voice = null, busy = Promise.resolve();

process.on('disconnect', () => process.exit(0)); // the server went away
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  if (m.type !== 'speak') return;
  busy = busy.then(async () => {
    try {
      if (cancelled.has(m.id)) return out({ type: 'done', id: m.id, frames: 0, seconds: 0 });
      const r = await voice.speak({ text: m.text, lang: m.lang, voice: m.voice, cancelled: () => cancelled.has(m.id), onAudio: (pcm) => out({ type: 'audio', id: m.id, pcm }) });
      out({ type: 'done', id: m.id, frames: r.frames, seconds: r.seconds });
    } catch (e) {
      out({ type: 'error', id: m.id, message: String((e && e.message) || e).slice(0, 300) });
    } finally { cancelled.delete(m.id); }
  });
});

(async () => {
  let ort;
  try { ort = require(path.join(engine, 'node_modules', 'onnxruntime-node')); }
  catch (e) { return out({ type: 'fatal', code: 'engine', message: String(e.message || e).slice(0, 300) }); }
  const backends = typeof ort.listSupportedBackends === 'function' ? ort.listSupportedBackends().map((b) => b.name) : [];
  if (!backends.includes('webgpu')) return out({ type: 'fatal', code: 'gpu', message: 'no WebGPU backend' });
  try { voice = await require('./synth').load({ ort, dir: model }); }
  catch (e) { return out({ type: 'fatal', code: /webgpu|adapter|device|gpu/i.test(String(e && e.message)) ? 'gpu' : 'engine', message: String((e && e.message) || e).slice(0, 300) }); }
  out({ type: 'ready' });
})();
