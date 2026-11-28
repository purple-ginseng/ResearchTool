/* Speech in the Library: read aloud (text to speech) and dictation (speech to text).
   - Read aloud is done by the voice of lib/voice on the server of this computer: a neural model (Qwen3-TTS) that is
     fetched once in Preferences > General > Speech. The page sends a sentence or two at a time (/api/voice/speak)
     and plays the samples as they arrive, so the text of a paper or a note never leaves the computer. Until the
     voice is installed, the read buttons say where it is fetched.
   - Dictation uses the browser's speech recognition. Where the browser can recognise on this computer
     (SpeechRecognition.available with processLocally) that is used; otherwise the browser sends the audio to its own
     speech service (Chrome: Google), which the app says once, before the first use, and asks.
   The pure part (plain, pdfText, chunks, langOf, escapeMd) also loads in Node (scripts/test-speech.js).
   API (RT.speech): supported {tts, stt}, speak(text | {text, more}, {key, voice}) -> Promise<bool>, stop(key?),
   speaking(), listen({lang, onText, onInterim, onEnd}) -> Promise<bool>, stopListening(), listening(),
   onState(fn) -> off(), dictationLang(noteLang) / setDictationLang(lang), prefs() / setPrefs({natural, lang}),
   sample(lang, voiceId), natural(fresh) -> the status of the voice on the server. */
(function (root, factory) {
  const pure = factory();
  if (typeof module === 'object' && module.exports) module.exports = pure;
  else root.RTSpeechPure = pure;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g;
  const PICTO = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

  // 'zh-CN' when a good part of the letters are Chinese characters, else 'en-US'
  function langOf(text) {
    const s = String(text || ''), han = (s.match(CJK) || []).length, words = (s.match(/[A-Za-z]+/g) || []).length;
    return han > 0 && han >= words ? 'zh-CN' : 'en-US'; // (a Chinese sentence with English terms is Chinese)
  }

  // an inline formula: a short symbol is said ("x", "E"), anything longer is left out
  function inlineMath(src) {
    const t = String(src).trim();
    return /^[A-Za-z0-9]{1,12}$/.test(t) ? ' ' + t + ' ' : ' ';
  }

  // Markdown of a reading note -> the text a person would read out: no code, no formulas, no pictures, no markup
  function plain(md) {
    let s = String(md || '').replace(/\r\n?/g, '\n');
    s = s.replace(/^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`{3,}|~{3,})[^\n]*\n(?:[\s\S]*?\n)??[ \t>]*\1[`~]*[ \t]*$/gm, '\n') // fenced code, diagrams (also in a list or a quote)
      .replace(/^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/m, '\n');   // a fence that is never closed runs to the end
    s = s.replace(/\$\$[\s\S]*?\$\$/g, '\n');                              // display formulas
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                           // pictures
    for (let before = null; before !== s;) { before = s; s = s.replace(/<(video|audio|svg|style|script)\b[\s\S]*?<\/\1\s*>/gi, ' '); }
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, (m, t) => (/^p{1,2}\.\s*\d/i.test(t.trim()) ? ' ' : t)); // links; page links (p. 2) are dropped
    s = s.replace(/<br\s*\/?>/gi, '\n');
    // tags only ("a<b and c>d" is text), until none is left ("<<b>b>" must not leave a tag behind)
    for (let before = null; before !== s;) { before = s; s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>\n]*=[^<>\n]*)?\s*\/?>/g, ''); }
    s = s.replace(/`([^`\n]*)`/g, '$1');
    s = s.replace(/\$(?=\S)(?!\d[\d,.]*(?:\s|$))([^$\n]{1,200}?)(?<=\S)\$(?!\d)/g, (m, f) => inlineMath(f)); // not two prices on a line
    const lines = s.split('\n').map((line) => {
      let l = line.replace(/^\s*(>\s*)+/, '');                             // quotes, callouts
      l = l.replace(/^\s*\[![a-zA-Z-]+\][+-]?\s*/, '');
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)) return ''; // the rule of a table
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '';                 // a horizontal rule
      const heading = /^\s*#{1,6}\s+/.test(l);
      l = l.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').replace(/^\s*[•·]\s*/, '');
      if (/\|/.test(l) && /^\s*\|/.test(line.replace(/^\s*(>\s*)+/, ''))) l = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ', ');
      l = l.replace(/==([^=\n]+)==/g, '$1').replace(/~~([^~\n]+)~~/g, '$1');
      l = l.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(（“"'])[*_]([^*_\n]+)[*_](?=$|[\s).,;:!?，。；：！？）”"'])/g, '$1$2');
      l = l.replace(/\\([\\`*_{}\[\]()#+\-.!|<>~=$])/g, '$1').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); // (&amp; last: "&amp;lt;" is the text "&lt;")
      l = l.replace(/[(（]\s*[)）]/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
      l = l.replace(PICTO, '').replace(/[ \t\u00a0]+/g, ' ').trim();
      if (l && (heading || !/[.!?:;。！？：；…,，、]$/.test(l))) l += langOf(l) === 'zh-CN' ? '。' : '.'; // a pause after a heading or a list line
      return l;
    });
    return lines.filter(Boolean).join('\n').trim();
  }

  // The text of one PDF page (pdf.js getTextContent()) in reading order as pdf.js gives it: lines are joined, a word
  // broken over two lines is put together, and the arXiv stamp in the margin is left out.
  function pdfText(tc) {
    const items = (tc && tc.items) || [];
    let out = '';
    for (const it of items) {
      const str = typeof it.str === 'string' ? it.str : '';
      if (/^arXiv:\d{4}\.\d{4,5}(v\d+)?\s+\[/.test(str.trim())) continue;
      out += str;
      if (it.hasEOL) out += '\n';
    }
    out = out.replace(/([A-Za-z])-\n(?=[a-z])/g, '$1').replace(/\s*\n\s*/g, ' ').replace(/[ \t\u00a0]+/g, ' ');
    return out.replace(/ (?=[\u3400-\u9fff])/g, (m, i, s) => (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s[i - 1] || '') ? '' : m)).trim();
  }

  // Text -> [{text, lang}]: sentence by sentence (a speech engine is steadier with short utterances, and each piece
  // gets the voice of its own language), neighbours of one language joined up to `max` characters.
  function chunks(text, max = 220) {
    const s = String(text || '').replace(/[ \t\u00a0]+/g, ' ');
    // a sentence ends at 。！？； anywhere, and at . ! ? ; only before a space or the end ("92.3%", "e.g." stay whole)
    const sentences = s.match(/(?:[^.!?;。！？；\n]|[.!?;](?=[^\s"'”’）)\]]))+(?:[.!?;。！？；]+["'”’）)\]]*)?[ \t]*|[.!?;。！？；]+[ \t]*|\n+/g) || [];
    const parts = [];
    for (let piece of sentences) {
      piece = piece.replace(/\s+/g, ' ').trim();
      if (!piece || !/[\p{L}\p{N}]/u.test(piece)) continue;
      while (piece.length > max) { // one long sentence: cut at a comma or a space before the limit
        const head = piece.slice(0, max);
        let cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(', '), head.lastIndexOf('：'));
        if (cut < max * 0.4) cut = head.lastIndexOf(' ');
        if (cut < max * 0.4) cut = max - 1;
        parts.push(piece.slice(0, cut + 1).trim()); piece = piece.slice(cut + 1).trim();
      }
      if (piece) parts.push(piece);
    }
    const out = [];
    for (const p of parts) {
      const lang = langOf(p), last = out[out.length - 1];
      if (last && last.lang === lang && last.text.length + 1 + p.length <= max) last.text += (lang === 'zh-CN' ? '' : ' ') + p;
      else out.push({ text: p, lang });
    }
    return out;
  }

  // What is left out when text is spoken: the parts of a paper that are not sentences. A voice model stumbles over
  // them (it babbles, repeats or makes sounds that are not speech): citation numbers "[4, 14-29]", author-year
  // citations "(Mildenhall et al., 2020)", links, and a clause that is a formula ("s t+1 = f(a t, s t)").
  const MATHS = /[=^_\\{}|<>\u2190-\u21ff\u2200-\u22ff\u0370-\u03ff\u2a00-\u2aff]/;
  const CITE = "\\p{Lu}[\\p{L}'’.-]+(?:\\s+(?:et al\\.?|and|&)(?:\\s+\\p{Lu}[\\p{L}'’.-]+)?)?,?\\s+(?:19|20)\\d\\d[a-z]?";
  const CITED = new RegExp('[(（]\\s*(?:(?:see|e\\.g\\.,?|cf\\.)\\s+)?' + CITE + '(?:\\s*[;,]\\s*' + CITE + ')*\\s*[)）]', 'gu');
  function forSpeech(text) {
    let s = String(text || '');
    s = s.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
    s = s.replace(/[\[［]\s*\d+(?:\s*[,;，、\u2013\u2014-]\s*\d+)*\s*[\]］]/g, '');
    s = s.replace(CITED, '');
    // sentence by sentence, the clauses that are formulas go
    s = s.replace(/(?:[^.!?。！？\n]|[.!?](?=\S))+[.!?。！？]*/g, (sentence) => { // (a dot inside "0.5" ends nothing)
      if (!MATHS.test(sentence)) return sentence;
      const end = (/[.!?。！？]+\s*$/.exec(sentence) || [''])[0];
      // clauses end at a comma, semicolon or colon that is not inside brackets ("f(a, b)" is one thing)
      const clauses = []; let depth = 0, cur = '';
      for (const ch of sentence.slice(0, sentence.length - end.length)) {
        if ('([{（［'.includes(ch)) depth++; else if (')]}）］'.includes(ch)) depth = Math.max(0, depth - 1);
        if (depth === 0 && ',;:，；：'.includes(ch)) { clauses.push([cur, ch]); cur = ''; } else cur += ch;
      }
      clauses.push([cur, '']);
      const body = clauses.filter(([c]) => !MATHS.test(c)).map(([c, sep]) => c + sep).join('').replace(/^[\s,;:，；：]+|[\s,;:，；：]+$/g, '');
      return /[A-Za-z\u3400-\u9fff]{2}/.test(body) ? ' ' + body + (end || '. ') : ' ';
    });
    s = s.replace(/[(（\[]\s*[)）\]]/g, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?，。；：！？)）\]])/g, '$1').replace(/([,;:，；：])\s*(?=[.!?。！？])/g, '').replace(/([。！？，；：])[ \t]+/g, '$1');
    return s.trim();
  }

  // dictated words are text, never Markdown: what would start markup is escaped
  const escapeMd = (s) => String(s || '').replace(/([\\`*_\[\]<>~$|])/g, '\\$1').replace(/^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s)/, '$1\\$2');

  return { langOf, plain, pdfText, chunks, forSpeech, escapeMd };
});

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.RT) return;
  const RT = window.RT, P = window.RTSpeechPure;
  const { toast } = RT;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const AC = window.AudioContext || window.webkitAudioContext || null; // plays the voice
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } } };
  const LANG_NAME = { 'zh-CN': 'Chinese', 'en-US': 'English' };
  // a sentence with a part put in ({0}): translated as a whole, the part translated first (i18n.js t(en, ...args))
  const tr = (en, ...args) => (RT.i18n && typeof RT.i18n.t === 'function' ? RT.i18n.t(en, ...args) : en.replace(/\{(\d)\}/g, (m, k) => args[k]));
  const fns = new Set();
  const state = () => ({ speaking: job ? job.key : null, listening: !!rec });
  const notify = () => { const s = state(); for (const fn of [...fns]) { try { fn(s); } catch (e) { console.error(e); } } };

  // ---------------------------------------------------------------- read aloud
  let job = null; // {key, parts, i, more, said, voice, player, abort}
  function finish(j, said) {
    if (job !== j) return;
    job = null; notify();
    if (!said) toast('There is no text to read here.');
  }
  // What Preferences > General > Speech keeps, for this browser: natural {'en-US', 'zh-CN'}: the speaker of the voice
  // per language ('' = the usual one), lang: the dictation language ('' = the language of the note).
  const NATURAL_KEY = { 'en-US': 'rt.speech.natural.en', 'zh-CN': 'rt.speech.natural.zh' };
  function prefs() {
    const l = store.get('rt.speech.lang');
    return { lang: l === 'zh-CN' || l === 'en-US' ? l : '', natural: { 'en-US': store.get(NATURAL_KEY['en-US']) || '', 'zh-CN': store.get(NATURAL_KEY['zh-CN']) || '' } };
  }
  function setPrefs(p = {}) {
    if (p.lang != null) store.set('rt.speech.lang', p.lang === 'zh-CN' || p.lang === 'en-US' ? p.lang : '');
    for (const l of Object.keys(NATURAL_KEY)) if (p.natural && typeof p.natural[l] === 'string') store.set(NATURAL_KEY[l], /^[a-z_]{0,20}$/.test(p.natural[l]) ? p.natural[l] : '');
  }
  const SAMPLE = { 'en-US': 'This is how I read a paper aloud. The method recovers geometry and appearance from a single video.', 'zh-CN': '这是我朗读论文的声音。该方法从单个视频中恢复几何与外观。' };
  // hear a speaker before it is saved (Preferences)
  const sample = (lang, voiceId) => speak(SAMPLE[lang] || SAMPLE['en-US'], { key: 'sample', voice: { [lang]: voiceId || '' } });

  // ---------------------------------------------------------------- the voice
  // A neural voice (Qwen3-TTS) that the server of this computer runs once it was fetched in Preferences
  // (lib/voice/, /api/voice/*). The page sends a sentence or two at a time and plays the samples as they arrive.
  let nat = null, natAt = 0;
  async function natural(fresh) { // the server's status (lib/routes/voice.js), kept for some seconds; null: no answer
    if (!AC) return null;
    if (!fresh && natAt && Date.now() - natAt < 15000) return nat;
    try { const r = await fetch('/api/voice/status'); nat = r.ok ? await r.json() : null; } catch { nat = null; }
    natAt = nat && nat.installed ? Date.now() : 0; // only "it is there" is kept: anything else is asked again
    return nat;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NAT_RATE = 24000;
  // characters of one piece, made whole before it is heard: whole sentences, about 15 to 20 seconds of speech
  // (a Chinese character takes as long to say as four or five letters). A smaller limit cuts English sentences in
  // the middle, and each half is then spoken with the melody of a sentence of its own.
  const PART = { 'zh-CN': 90, 'en-US': 260 };
  const AHEAD = 45;   // seconds of sound in hand at most: the next piece is made while this one is heard
  let actx = null;
  function natPlayer() {
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume().catch(() => { /* needs a click: there was one */ });
    const live = new Set(), timers = new Set();
    let head = 0; // the time (of actx) at which the sound in hand ends
    return {
      // a whole piece, after what is in hand; onStart() is called when it begins to be heard
      add(f, onStart) {
        const b = actx.createBuffer(1, f.length, NAT_RATE);
        b.getChannelData(0).set(f);
        const src = actx.createBufferSource();
        src.buffer = b; src.connect(actx.destination);
        const at = Math.max(head, actx.currentTime + 0.06);
        src.start(at); head = at + b.duration;
        live.add(src); src.onended = () => live.delete(src);
        if (onStart) { const t = setTimeout(() => { timers.delete(t); onStart(); }, Math.max(0, (at - actx.currentTime) * 1000)); timers.add(t); }
      },
      ahead: () => Math.max(0, head - actx.currentTime),
      stop() { for (const src of live) { try { src.onended = null; src.stop(); } catch { /* ended */ } } live.clear(); for (const t of timers) clearTimeout(t); timers.clear(); head = 0; },
    };
  }
  // one piece of text: the server makes all of its sound, then it is queued. false: the voice did not speak it
  // (j.natProblem says why)
  async function natPart(j, p) {
    const ac = j.abort = new AbortController();
    let r, bytes;
    try {
      r = await fetch('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RT': '1' }, signal: ac.signal,
        body: JSON.stringify({ text: p.text, lang: p.lang, stream: false, voice: (j.voice ? j.voice[p.lang] : prefs().natural[p.lang]) || '' }) });
      if (!r.ok) { let code = 'failed'; try { code = (await r.json()).code || code; } catch { /* no JSON */ } j.natProblem = code; return false; }
      bytes = new Uint8Array(await r.arrayBuffer());
    } catch { j.natProblem = 'failed'; return false; }
    if (job !== j) return true;
    const n = bytes.length >> 1;
    if (!n) return true; // (nothing to say in it)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2), f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
    const onStart = p.onStart;
    j.player.add(f, onStart ? () => { if (job === j) { try { onStart(); } catch (e) { console.error(e); } } } : null);
    return true;
  }
  const NAT_PROBLEM = {
    gpu: 'The voice needs a graphics processor (WebGPU) that this computer does not offer here.',
    missing: 'Reading aloud needs the voice, which is downloaded once in Preferences > General > Speech.',
    platform: 'There is no voice for this kind of computer.',
  };
  // what more() gives: a text, or {text, onStart} (onStart: called when that text begins to be heard)
  const partsOf = (m) => {
    const text = P.forSpeech(typeof m === 'string' ? m : (m && m.text) || '');
    let parts;
    if (P.langOf(text) === 'zh-CN') {
      // a Chinese text is Chinese throughout: a sentence that is mostly English terms is still read by the Chinese
      // speaker (who says the terms in English), not handed to the English one
      parts = P.chunks(text, PART['zh-CN']);
      for (const x of parts) x.lang = 'zh-CN';
    } else {
      parts = P.chunks(text, PART['en-US']).flatMap((x) => (x.lang === 'zh-CN' && x.text.length > PART['zh-CN'] ? P.chunks(x.text, PART['zh-CN']).map((y) => ({ ...y, lang: 'zh-CN' })) : [x]));
    }
    if (m && typeof m === 'object' && typeof m.onStart === 'function' && parts.length) parts[0].onStart = m.onStart;
    return parts;
  };
  async function nextNatural(j) {
    const pl = j.player = natPlayer();
    toast('Preparing the first paragraph. Reading starts in a moment.');
    for (;;) {
      if (job !== j) return;
      while (job === j && pl.ahead() > AHEAD) await sleep(200); // never far ahead of the listener
      if (job !== j) return;
      if (j.i >= j.parts.length) {
        let more = null;
        if (j.more) { try { more = await j.more(); } catch (e) { console.error(e); } }
        if (job !== j) return;
        if (more == null) break;
        j.parts = partsOf(more); j.i = 0;
        continue;
      }
      const ok = await natPart(j, j.parts[j.i]);
      if (job !== j) return;
      if (!ok) { // what was made so far is said, then the reason is given
        while (job === j && pl.ahead() > 0.05) await sleep(120);
        if (job !== j) return;
        nat = null; natAt = 0;
        job = null; notify();
        toast(tr(NAT_PROBLEM[j.natProblem] || 'The voice could not read this.'), 'bad');
        return;
      }
      j.i++; j.said = true;
      if (actx.state !== 'running') { // the browser did not let the page make sound: nothing would ever be heard
        await sleep(1000);
        if (job !== j) return;
        if (actx.state !== 'running') { stop(); toast('The browser did not let the page play sound. Press the read button again.', 'bad'); return; }
      }
    }
    while (job === j && pl.ahead() > 0.05) await sleep(120);
    finish(j, j.said);
  }

  // speak(text) or speak({text, more}): more() -> Promise<string | {text, onStart} | null> gives what comes after
  // (the next page; onStart is called when it begins to be heard). A piece of text is made whole before it is
  // heard, and the next one is made meanwhile: the first sound takes a moment, then the reading has no seams.
  // voice: {lang: speaker} to hear another speaker than the saved one.
  async function speak(what, { key = 'text', voice = null } = {}) {
    if (!AC) { toast('This browser cannot play sound made by the page.', 'bad'); return false; }
    // (now, inside the click: some browsers only let sound start from the user's own action)
    try { if (!actx) actx = new AC(); if (actx.state !== 'running') actx.resume().catch(() => {}); } catch { /* said below, if it stays silent */ }
    const src = typeof what === 'string' ? { text: what } : (what || {});
    stopListening(); stop();
    const j = job = { key, parts: partsOf(src.text || ''), i: 0, more: src.more || null, said: false, voice, player: null, abort: null };
    if (!j.parts.length && !j.more) { job = null; toast('There is no text to read here.'); return false; }
    notify();
    const st = await natural();
    if (job !== j) return false;
    if (!st || !st.installed) {
      job = null; notify();
      toast(tr(!st ? 'The voice did not answer. Is ResearchTool still running?' : !st.supported ? NAT_PROBLEM.platform : NAT_PROBLEM.missing), 'bad');
      return false;
    }
    nextNatural(j).catch((e) => { console.error(e); if (job === j) stop(); });
    return true;
  }
  function stop(key) {
    if (!job || (key && job.key !== key)) return false;
    const j = job;
    job = null;
    if (j.abort) { try { j.abort.abort(); } catch { /* done */ } }
    if (j.player) j.player.stop();
    notify();
    return true;
  }
  window.addEventListener('pagehide', () => { if (job) stop(); });

  // ---------------------------------------------------------------- dictation
  let rec = null, recStop = null;
  const SILENCE_MS = 8000; // no word for this long: dictation ends by itself
  const DICT = { zh: 'zh-CN', en: 'en-US' };
  // the language that is dictated: the one picked for this browser (Shift-click on the microphone), else the note's
  const dictationLang = (noteLang) => prefs().lang || DICT[noteLang] || 'en-US';
  const setDictationLang = (l) => setPrefs({ lang: l });

  async function onDevice(lang) {
    if (!SR || typeof SR.available !== 'function') return false;
    try { return (await SR.available({ langs: [lang], processLocally: true })) === 'available'; } catch { return false; }
  }
  async function listen({ lang = 'en-US', onText, onInterim, onEnd } = {}) {
    if (!SR) { toast('This browser has no speech recognition. Dictation works in Chrome, Edge and Safari.', 'bad'); return false; }
    if (rec) return false;
    const local = await onDevice(lang);
    if (!local && store.get('rt.speech.cloudOk') !== '1') {
      const ok = await RT.confirm('Dictation uses the speech recognition of your browser. This browser turns speech into text with its own online service (in Chrome that is Google), so what you say while the microphone is on is sent there. ResearchTool itself sends nothing, and reading aloud stays on this computer.', { title: 'Dictation', okText: 'Use dictation' });
      if (!ok) return false;
      store.set('rt.speech.cloudOk', '1');
    }
    if (rec) return false;
    stop();
    const r = new SR();
    r.lang = lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    if (local) { try { r.processLocally = true; } catch { /* older engine */ } }
    let timer = 0, ended = false, problem = '';
    const quiet = () => { clearTimeout(timer); timer = setTimeout(() => { try { r.stop(); } catch { /* ended */ } }, SILENCE_MS); };
    const end = () => {
      if (ended) return; ended = true;
      clearTimeout(timer);
      if (rec === r) { rec = null; recStop = null; }
      notify();
      if (problem) toast(problem, 'bad');
      if (onEnd) { try { onEnd(); } catch (e) { console.error(e); } }
    };
    r.onresult = (e) => {
      quiet();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], t = res[0] ? res[0].transcript : '';
        if (res.isFinal) { if (t.trim() && onText) { try { onText(t.trim(), lang); } catch (err) { console.error(err); } } }
        else interim += t;
      }
      if (onInterim) { try { onInterim(interim.trim()); } catch (err) { console.error(err); } }
    };
    r.onerror = (e) => {
      const code = e.error;
      if (code === 'no-speech' || code === 'aborted') return;
      problem = code === 'not-allowed' || code === 'service-not-allowed' ? 'The microphone is blocked for this page. Allow it in the address bar of the browser, then try again.'
        : code === 'audio-capture' ? 'No microphone was found.'
          : code === 'network' ? 'Dictation needs an internet connection in this browser.'
            : code === 'language-not-supported' ? tr('This browser cannot dictate {0}.', tr(LANG_NAME[lang] || lang))
              : tr('Dictation stopped ({0}).', code);
    };
    r.onend = end;
    rec = r; recStop = () => { try { r.stop(); } catch { end(); } };
    notify();
    r.onstart = quiet; r.onaudiostart = quiet; // (not from start(): the browser may be asking for the microphone)
    try { r.start(); } catch (e) { problem = 'Dictation could not start: ' + (e.message || e); end(); return false; }
    return true;
  }
  function stopListening() { if (!recStop) return false; recStop(); return true; }

  RT.speech = {
    supported: { tts: !!AC, stt: !!SR },
    natural, // (fresh?) -> the status of the voice on the server, or null
    plain: P.plain, pdfText: P.pdfText, escapeMd: P.escapeMd, langOf: P.langOf,
    speak, stop, speaking: () => (job ? job.key : null),
    listen, stopListening, listening: () => !!rec,
    dictationLang, setDictationLang, prefs, setPrefs, sample,
    onState(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
})();
