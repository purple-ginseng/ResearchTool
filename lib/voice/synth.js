// The natural voice itself: Qwen3-TTS 0.6B CustomVoice (Apache 2.0) as the ONNX graphs of
// danyalmalik/Qwen3-TTS-12Hz-0.6B-CustomVoice-ONNX-WebGPU, run with onnxruntime-node. The recipe is the one of that
// export's README (and of qwen_tts): the prompt through the talker; per 80 ms frame, code 0 sampled from the talker
// (temperature and top-k: see TEMPERATURE below; repetition penalty 1.05, control codes masked, no stop in the first two frames), codes
// 1-15 from the code predictor with a fresh cache, the sum of the 16 codes' embeddings plus the pad embedding fed
// back; the codec decoder turns frames into 24 kHz audio, here in pieces while the frames are still being made.
// Runs inside lib/voice/worker.js (its own process); nothing here knows about HTTP or files of the workspace.
//   load({ ort, dir, threads? }) -> { speak({text, lang, voice, onAudio, cancelled}) -> {frames, seconds, stopped}, VOICES }
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const tokenizer = require('./tokenizer');

const RATE = 24000, FRAME_SAMPLES = 1920; // 12.5 frames a second
const KV_HEADS = 8, HEAD_DIM = 128, TALKER_LAYERS = 28, CP_LAYERS = 5, CP_WIDTH = 1024;
const MAX_FRAMES = 8192, DECODE_CONTEXT = 25;
const FIRST_PIECE = 8, PIECE = 24;       // frames decoded at a time: a first piece soon (0.6 s), then about 2 s each
const HOLD = 2;                          // the newest frames wait for what follows them (the decoder looks a little ahead)
// the model's speakers that read Chinese or English (its config.json has two more, for Japanese and Korean)
const VOICES = [
  { id: 'serena', lang: 'zh-CN' }, { id: 'vivian', lang: 'zh-CN' }, { id: 'uncle_fu', lang: 'zh-CN' },
  { id: 'dylan', lang: 'zh-CN' }, { id: 'eric', lang: 'zh-CN' }, { id: 'ryan', lang: 'en-US' }, { id: 'aiden', lang: 'en-US' },
];
const DEFAULT_VOICE = { 'zh-CN': 'serena', 'en-US': 'ryan' };
const LANGUAGE = { 'zh-CN': 'chinese', 'en-US': 'english' };

// The sampling: steadier than the model's own defaults (0.9, 50), for an even, matter-of-fact reading of papers. In
// a trial of 27 Chinese and English pieces the recogniser heard a "happy" tone in two at 0.9 and in none at 0.7,
// with as few wrong words; at 0.5 a piece now and then never ended.
const TEMPERATURE = 0.7, TOP_K = 30;
const ATTEMPTS = 3; // draws of one piece of text before an overrunning one is kept (cut)
// About how many frames (80 ms each) a text takes to say: a Chinese character about a quarter of a second, a digit
// about as long (it is said as a word), other letters about fifteen a second.
function expectedFrames(text) {
  const t = String(text || '');
  const han = (t.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length, digits = (t.match(/\d/g) || []).length;
  const other = (t.match(/[^\s\d\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(12, Math.round(3.2 * han + 3 * digits + 0.9 * other));
}
// the last 60 ms of a cut-off sound go down to silence
function fadeOut(audio) {
  const out = Float32Array.from(audio), n = Math.min(out.length, 1440);
  for (let i = 0; i < n; i++) out[out.length - n + i] *= 1 - (i + 1) / n;
  return out;
}

function sampleTopK(logits, from, to, temperature = 0.9, k = 50) {
  // the k largest finite values of logits[from, to), then one drawn in proportion
  const idx = [], val = [];
  for (let i = from; i < to; i++) {
    const v = logits[i];
    if (!(v > -Infinity)) continue;
    if (idx.length < k) { let j = idx.length; while (j > 0 && val[j - 1] < v) j--; idx.splice(j, 0, i); val.splice(j, 0, v); }
    else if (v > val[k - 1]) { let j = k - 1; while (j > 0 && val[j - 1] < v) j--; idx.splice(j, 0, i); val.splice(j, 0, v); idx.pop(); val.pop(); }
  }
  if (!idx.length) return from;
  const max = val[0] / temperature, w = val.map((v) => Math.exp(v / temperature - max));
  let u = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < idx.length; i++) if ((u -= w[i]) < 0) return idx[i] - from;
  return idx[idx.length - 1] - from;
}

async function load({ ort, dir, threads = 4, talkerProvider = 'webgpu', decoderProvider = 'webgpu', temperature = TEMPERATURE, topK = TOP_K }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), tc = cfg.talker_config;
  const VOCAB = tc.vocab_size, CPV = tc.code_predictor_config.vocab_size, GROUPS = tc.num_code_groups, EOS = tc.codec_eos_token_id, W = tc.hidden_size;
  const tok = tokenizer.create(JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')));
  const open = (file, provider, n) => ort.InferenceSession.create(path.join(dir, file), { executionProviders: [provider], logSeverityLevel: 3, intraOpNumThreads: n, graphOptimizationLevel: 'all' });
  const talker = await open(path.join('talker', 'model.onnx'), talkerProvider, threads);
  const cp = await open(path.join('code_predictor', 'model.onnx'), 'cpu', threads);
  const textEmbed = await open('text_embed_q4.onnx', 'cpu', 2);
  const codecEmbed = await open('codec_embed_q4.onnx', 'cpu', 2);
  const decoder = await open('tok_decoder_q4.onnx', decoderProvider, 2);
  const ids64 = (ids) => new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
  const embedText = async (ids) => {
    const t = (await textEmbed.run({ ids: ids64(ids) })).embeds, n = t.data.length / ids.length;
    return ids.map((_, i) => Float32Array.from(t.data.subarray(i * n, (i + 1) * n)));
  };
  // the whole codec embedding table once (talker codes, then the 15 codebooks of the code predictor)
  const ROWS = VOCAB + (GROUPS - 1) * CPV, table = new Float32Array(ROWS * W);
  for (let a = 0; a < ROWS; a += 4096) {
    const ids = Array.from({ length: Math.min(4096, ROWS - a) }, (_, i) => a + i);
    table.set((await codecEmbed.run({ ids: ids64(ids) })).embeds.data, a * W);
  }
  await codecEmbed.release();
  const row = (id) => table.subarray(id * W, (id + 1) * W);
  const add = (...v) => { const o = new Float32Array(v[0].length); for (const a of v) for (let i = 0; i < o.length; i++) o[i] += a[i]; return o; };
  const [bosE, eosE, padE] = await embedText([cfg.tts_bos_token_id, cfg.tts_eos_token_id, cfg.tts_pad_token_id]);
  const role = [tok.id('<|im_start|>'), ...tok.encode('assistant\n')];
  const roleE = await embedText(role);

  // a decoder-only model with a key/value cache: run(rows) -> the logits and the hidden state of the last row
  function lm(graph, layers, width) {
    let past = {}, n = 0;
    for (let i = 0; i < layers; i++) for (const k of ['key', 'value']) past[`past_key_values.${i}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
    return async (rows) => {
      const x = new Float32Array(rows.length * width);
      rows.forEach((r, i) => x.set(r, i * width));
      n += rows.length;
      const out = await graph.run({ inputs_embeds: new ort.Tensor('float32', x, [1, rows.length, width]), attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]), ...past });
      past = {};
      for (const k of Object.keys(out)) if (k.startsWith('present.')) past['past_key_values.' + k.slice(8)] = out[k];
      const L = out.logits.data, H = out.hidden_states.data, ln = L.length / rows.length, hn = H.length / rows.length;
      return { logits: Float32Array.from(L.subarray(L.length - ln)), hidden: Float32Array.from(H.subarray(H.length - hn)) };
    };
  }

  async function decode(frames, from, to) { // audio of frames [from, to), with the frames before them as context
    const a = Math.max(0, from - DECODE_CONTEXT), n = to - a, codes = new BigInt64Array(GROUPS * n);
    for (let t = 0; t < n; t++) for (let g = 0; g < GROUPS; g++) codes[g * n + t] = BigInt(frames[a + t][g]);
    const audio = (await decoder.run({ codes: new ort.Tensor('int64', codes, [1, GROUPS, n]) })).audio.data;
    return audio.subarray((from - a) * FRAME_SAMPLES, (to - a) * FRAME_SAMPLES);
  }
  const pcm16 = (f) => { const b = Buffer.allocUnsafe(f.length * 2); for (let i = 0; i < f.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f[i])) * 32767), i * 2); return b; };

  // onAudio(Buffer of 16-bit mono samples at 24 kHz) is called piece by piece; cancelled() ends the work early
  async function speak({ text, lang = 'en-US', voice, onAudio, cancelled = () => false, stream = true, sampling = {} }) {
    const T = sampling.temperature || temperature, K = sampling.topK || topK;
    const language = LANGUAGE[lang] || 'english';
    const spk = tc.spk_id[voice] !== undefined ? voice : DEFAULT_VOICE[lang] || 'ryan';
    const body = tok.encode(String(text || '').trim());
    if (!body.length) return { frames: 0, seconds: 0, stopped: true };
    const dialect = (tc.spk_is_dialect || {})[spk];
    const langId = language === 'chinese' && dialect ? tc.codec_language_id[dialect] : tc.codec_language_id[language];
    const prefix = [tc.codec_think_id, tc.codec_think_bos_id, langId, tc.codec_think_eos_id, tc.spk_id[spk], tc.codec_pad_id];
    const rows = [...roleE];
    prefix.forEach((c, i) => rows.push(add(i < prefix.length - 1 ? padE : bosE, row(c))));
    const padC = row(tc.codec_pad_id);
    for (const t of [...(await embedText(body)), eosE]) rows.push(add(t, padC));
    rows.push(add(padE, row(tc.codec_bos_id)));

    // How long the text should take, in frames: now and then the sampling loses its way and never picks the stop
    // code, and what follows is babble. A whole piece (stream: false) that overruns is thrown away and made again
    // (the next draw nearly always ends as it should); when sound is sent as it is made, it can only be cut there.
    const expected = expectedFrames(text);
    const limit = Math.min(MAX_FRAMES, 25 + 9 * body.length, Math.round(1.7 * expected) + 25);
    let frames = [], stopped = false, done = false, sent = 0, decoding = null, failed = null;
    // decoding runs beside the generation: whenever enough new frames wait (all of them at the end)
    const pump = () => {
      if (decoding || failed) return;
      const ready = done ? frames.length : frames.length - HOLD;
      if (ready - sent < (done ? 1 : !stream ? Infinity : sent === 0 ? FIRST_PIECE : PIECE)) return;
      const from = sent, to = Math.min(ready, from + 300), last = done && to === frames.length && !stopped;
      decoding = decode(frames, from, to).then((audio) => { sent = to; if (!cancelled()) onAudio(pcm16(last ? fadeOut(audio) : audio)); }, (e) => { failed = e; }).then(() => { decoding = null; pump(); });
    };
    let attempts = 0;
    for (; attempts < (stream ? 1 : ATTEMPTS) && !stopped && !cancelled() && !failed; attempts++) {
      frames = []; sent = 0;
      const seen = new Set(), run = lm(talker, TALKER_LAYERS, W);
      let { logits, hidden } = await run(rows);
      for (let step = 0; step < limit && !cancelled() && !failed; step++) {
        for (const t of seen) logits[t] = logits[t] < 0 ? logits[t] * 1.05 : logits[t] / 1.05;
        const keep = step < 2 ? -Infinity : logits[EOS];
        for (let t = VOCAB - 1024; t < VOCAB; t++) logits[t] = -Infinity;
        logits[EOS] = keep;
        const c0 = sampleTopK(logits, 0, VOCAB, T, K);
        if (c0 === EOS) { stopped = true; break; }
        const frame = [c0], cpRun = lm(cp, CP_LAYERS, CP_WIDTH);
        let x = [hidden, row(c0)];
        for (let j = 0; j < GROUPS - 1; j++) {
          const { logits: cl } = await cpRun(x);
          const c = sampleTopK(cl, j * CPV, (j + 1) * CPV, sampling.cpTemperature || T, sampling.cpTopK || K);
          frame.push(c);
          x = [row(VOCAB + j * CPV + c)];
        }
        frames.push(frame); seen.add(c0);
        pump();
        const sum = add(...frame.map((c, g) => row(g === 0 ? c : VOCAB + (g - 1) * CPV + c)), padE);
        ({ logits, hidden } = await run([sum]));
      }
    }
    // no draw ended by itself: what is kept is cut where the text should be over (and faded out)
    if (!stopped && !stream) frames = frames.slice(0, Math.round(1.4 * expected) + 10);
    done = true;
    while (!failed && !cancelled() && (decoding || sent < frames.length)) { pump(); await decoding; }
    if (decoding) await decoding;
    if (failed) throw failed;
    return { frames: frames.length, seconds: frames.length * FRAME_SAMPLES / RATE, stopped, attempts };
  }

  return { speak, VOICES, RATE };
}

module.exports = { load, VOICES, DEFAULT_VOICE, RATE, sampleTopK, expectedFrames, fadeOut };
