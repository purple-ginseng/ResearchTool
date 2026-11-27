// The text tokenizer of the natural voice (Qwen3-TTS): the Qwen2 byte-level BPE of the model's tokenizer.json, in
// plain JavaScript. Text only: what is read aloud is never looked at for special tokens ("<|im_end|>" in a note is
// ordinary text), the caller puts the few special ids of the prompt in itself.
//   create(json) -> { encode(text) -> number[], id(token) -> number | undefined }
'use strict';

// GPT-2's pre-tokenizer pattern as tokenizer.json has it, with the (?i:...) group written out (Node 18 has no
// inline flags).
const SPLIT = /'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

// byte -> the character that stands for it in the vocabulary (printable bytes are themselves, the rest move up)
const BYTE_CHAR = (() => {
  const keep = [];
  for (let b = 33; b <= 126; b++) keep.push(b);
  for (let b = 161; b <= 172; b++) keep.push(b);
  for (let b = 174; b <= 255; b++) keep.push(b);
  const out = new Array(256);
  for (const b of keep) out[b] = String.fromCharCode(b);
  let n = 0;
  for (let b = 0; b < 256; b++) if (out[b] === undefined) out[b] = String.fromCharCode(256 + n++);
  return out;
})();

function create(json) {
  const model = json && json.model;
  if (!model || model.type !== 'BPE' || !model.vocab || !Array.isArray(model.merges)) throw new Error('not a BPE tokenizer.json');
  const vocab = new Map(Object.entries(model.vocab));
  const rank = new Map();
  model.merges.forEach((m, i) => { const [a, b] = Array.isArray(m) ? m : String(m).split(' '); rank.set(a + ' ' + b, i); });
  const special = new Map((json.added_tokens || []).map((t) => [t.content, t.id]));
  const cache = new Map();

  function bpe(word) {
    const hit = cache.get(word);
    if (hit) return hit;
    let parts = Array.from(Buffer.from(word, 'utf8'), (b) => BYTE_CHAR[b]);
    while (parts.length > 1) {
      let best = Infinity, at = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = rank.get(parts[i] + ' ' + parts[i + 1]);
        if (r !== undefined && r < best) { best = r; at = i; }
      }
      if (at < 0) break;
      const a = parts[at], b = parts[at + 1], next = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) { next.push(a + b); i++; } else next.push(parts[i]);
      }
      parts = next;
    }
    const ids = [];
    for (const p of parts) { const id = vocab.get(p); if (id !== undefined) ids.push(id); }
    if (cache.size < 20000) cache.set(word, ids);
    return ids;
  }

  return {
    encode(text) {
      const s = String(text == null ? '' : text).normalize('NFC'), ids = [];
      let last = 0;
      const piece = (w) => { if (w) for (const id of bpe(w)) ids.push(id); };
      for (const m of s.matchAll(SPLIT)) { piece(s.slice(last, m.index)); piece(m[0]); last = m.index + m[0].length; }
      piece(s.slice(last));
      return ids;
    },
    id: (token) => (special.has(token) ? special.get(token) : vocab.get(token)),
  };
}

module.exports = { create, BYTE_CHAR };
