#!/usr/bin/env node
// Tests for the pure part of public/js/speech.js: what is read aloud from a note (plain) and from a PDF page
// (pdfText), how it is cut into utterances (chunks) and how dictated words are kept from becoming Markdown (escapeMd).
// (The voice itself: scripts/test-voice.js.)
// No browser, no microphone, no speech engine.   Run:  node scripts/test-speech.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../public/js/speech.js');

let failed = 0, n = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 12).join('\n     ')); }
}

test('langOf: Chinese text with English terms is Chinese, English with a Chinese word is English', () => {
  assert.equal(S.langOf('MonoPhysics estimates geometry from monocular videos.'), 'en-US');
  assert.equal(S.langOf('采用 3DGS 作为 3D 表示并与基于粒子的 MPM 仿真天然对接'), 'zh-CN');
  assert.equal(S.langOf('The authors call this 尺度 ambiguity in the monocular setting of the paper.'), 'en-US');
  assert.equal(S.langOf(''), 'en-US');
  assert.equal(S.langOf('我们使用 Transformer 和 self-attention 机制。'), 'zh-CN');
  assert.equal(S.langOf('Transformer 模型'), 'zh-CN');
});

test('plain: markup, code, formulas, pictures and page links are not read', () => {
  const md = [
    '## 3.1 Problem setting', '',
    '> [!abstract] 🏕️', '> The **input** is a _monocular_ video ([p. 2](rt://page/2)).', '',
    '- uses ==3DGS== and `MPM` together', '1. second ~~old~~ point',
    '![Figure 1](assets/f1.png)', '',
    '$$', 'C = c_{bg} \\prod_i (1-\\alpha_i)', '$$', '',
    'Young\'s modulus $E$ and $\\frac{a}{b}$ are recovered, see [the site](https://example.org/x).',
    '```mermaid', 'graph TD; A-->B', '```',
    '<mark style="background-color:#d9c8f5">concept</mark> sentence',
    '| **Quantity** | **Meaning** |', '| :---: | --- |', '| $x$ | position |',
  ].join('\n');
  const t = S.plain(md);
  for (const bad of ['#', '*', '_', '`', '$', '==', '~~', '](', 'http', 'assets/', 'mermaid', 'graph TD', '\\prod', '<mark', '[!abstract]', '🏕', 'p. 2', '|', ':---:']) assert.ok(!t.includes(bad), `"${bad}" is still in: ${t}`);
  assert.match(t, /^3\.1 Problem setting\.$/m);
  assert.match(t, /The input is a monocular video/);
  assert.match(t, /uses 3DGS and MPM together\./);
  assert.match(t, /second old point\./);
  assert.match(t, /Young's modulus\s+E\s+and\s+are recovered, see the site\./);
  assert.match(t, /concept sentence\./);
  assert.match(t, /Quantity, Meaning/);
  assert.match(t, /x\s*, position/);
  assert.equal(S.plain(''), '');
  assert.equal(S.plain('a &amp;lt; b'), 'a &lt; b.', 'an escaped entity is unescaped once');
  assert.equal(S.plain('x <<b>i>y</i> z'), 'x y z.', 'no tag is left by removing another');
  // what looks like markup but is text stays; code in a list item or a callout goes
  assert.equal(S.plain('Training costs $500 on A100 versus $2,000 on H100.'), 'Training costs $500 on A100 versus $2,000 on H100.');
  assert.equal(S.plain('If a<b and c>d then swap; accuracy<baseline while loss>threshold.'), 'If a<b and c>d then swap; accuracy<baseline while loss>threshold.');
  assert.equal(S.plain('1. Install:\n   ```bash\n   pip install torch\n   ```\n2. Run it.'), 'Install:\nRun it.');
  assert.equal(S.plain('> [!note]\n> ```py\n> x = 1\n> ```\n> done'), 'done.');
  assert.equal(S.plain('before\n\n```js\nnever closed'), 'before.');
  assert.equal(S.plain('~~~\na\n~~~\nmiddle\n```\nb\n```\nend'), 'middle.\nend.');
  assert.equal(S.plain('```js\nlet a = 1;\n```'), '');
});

test('plain: a Chinese heading ends with a Chinese full stop, a sentence keeps its own', () => {
  assert.equal(S.plain('# 方法论\n\n输入是一段视频。'), '方法论。\n输入是一段视频。');
});

test('pdfText: lines are joined, a hyphenated word is mended, the arXiv stamp is left out', () => {
  const tc = { items: [
    { str: 'arXiv:2605.30320v2 [cs.CV] 1 Oct 2026', hasEOL: true },
    { str: 'Recovering the physical prop', hasEOL: false }, { str: '-', hasEOL: true },
    { str: 'erties of objects from video,', hasEOL: true },
    { str: 'such as material stiffness.', hasEOL: true },
    { str: 'A well-', hasEOL: true }, { str: 'Known result.', hasEOL: true },
    {}, { str: 7 },
  ] };
  assert.equal(S.pdfText(tc), 'Recovering the physical properties of objects from video, such as material stiffness. A well- Known result.');
  assert.equal(S.pdfText(null), '');
  assert.equal(S.pdfText({ items: [{ str: '单目设置', hasEOL: true }, { str: '缺乏约束', hasEOL: true }] }), '单目设置缺乏约束');
});

test('chunks: one utterance per run of sentences in a language, never longer than the limit, nothing lost', () => {
  const text = 'First sentence. Second one! 这是中文句子。还有一句？ Back to English; done.';
  const c = S.chunks(text, 60);
  assert.deepEqual(c.map((x) => x.lang), ['en-US', 'zh-CN', 'en-US']);
  assert.equal(c[0].text, 'First sentence. Second one!');
  assert.equal(c[1].text, '这是中文句子。还有一句？');
  const long = 'word '.repeat(200).trim() + '.';
  const parts = S.chunks(long, 80);
  assert.ok(parts.length > 10);
  for (const p of parts) assert.ok(p.text.length <= 80, String(p.text.length));
  assert.equal(parts.map((p) => p.text).join(' ').replace(/\s+/g, ' '), long);
  const noBreak = '字'.repeat(500);
  for (const p of S.chunks(noBreak, 100)) assert.ok(p.text.length <= 100);
  assert.equal(S.chunks(noBreak, 100).map((p) => p.text).join(''), noBreak);
  assert.deepEqual(S.chunks(''), []);
  // a dot inside a number, a version or an abbreviation is not the end of a sentence
  assert.equal(S.chunks('We reach an accuracy of 92.3% at 0.5 IoU, a gain of 1.7 points over v2.0. Use e.g. a larger model.')[0].text, 'We reach an accuracy of 92.3% at 0.5 IoU, a gain of 1.7 points over v2.0. Use e.g. a larger model.');
  assert.deepEqual(S.chunks('One. Two? Three!', 6).map((x) => x.text), ['One.', 'Two?', 'Three!']);
  assert.deepEqual(S.chunks('He said "stop." Then left.', 16).map((x) => x.text), ['He said "stop."', 'Then left.']);
  { const big = ('The model reaches 31.02 dB on scene 4.5 (see Sec. 3.1). ' + '结果见表 2.1，提升 3.5%。').repeat(2500); const t0 = process.hrtime.bigint(); const c = S.chunks(big); const ms = Number(process.hrtime.bigint() - t0) / 1e6; assert.ok(ms < 1500, `chunks on ${big.length} characters took ${ms} ms`); assert.ok(c.every((x) => x.text.length <= 220)); assert.ok(!c.some((x) => /\d\. \d/.test(x.text))); }
  assert.deepEqual(S.chunks(' \n ... \n — '), []);
});


test('forSpeech: citations, links and formulas are not read; ordinary sentences are untouched', () => {
  const F = S.forSpeech;
  assert.equal(F('Video models use pixel-space state, trained with photometric reconstruction [4, 14–29] or prediction [30].'), 'Video models use pixel-space state, trained with photometric reconstruction or prediction.');
  assert.equal(F('NeRF (Mildenhall et al., 2020) and its successors (Barron et al., 2021; Müller and Evans, 2022) are slow.'), 'NeRF and its successors are slow.');
  assert.equal(F('Existing approaches [5] formulate this as a single-step update, s t+1 = f(a t, s t), which accumulates error.'), 'Existing approaches formulate this as a single-step update, which accumulates error.');
  assert.equal(F('We minimise L = ∑ ||x − y||. The result is stable.'), 'The result is stable.');
  assert.equal(F('See https://example.org/a?b=1 for the code.'), 'See for the code.');
  assert.equal(F('The method reaches 92.3% accuracy (see Table 2), a gain of 1.7 points.'), 'The method reaches 92.3% accuracy (see Table 2), a gain of 1.7 points.');
  assert.equal(F('本文提出一种新方法［3］，准确率达到 92.3%。其中 α = 0.5，效果最好。'), '本文提出一种新方法，准确率达到 92.3%。效果最好。');
  assert.equal(F(''), '');
});

test('escapeMd: dictated words stay text', () => {
  assert.equal(S.escapeMd('a * b _c_ `d` [e] <f>'), 'a \\* b \\_c\\_ \\`d\\` \\[e\\] \\<f\\>');
  assert.equal(S.escapeMd('# not a heading'), '\\# not a heading');
  assert.equal(S.escapeMd('1. not a list'), '\\1. not a list');
  assert.equal(S.escapeMd('- nor this'), '\\- nor this');
  assert.equal(S.escapeMd('plain words, 中文也一样。'), 'plain words, 中文也一样。');
});

test('the page loads speech.js before the reader, and the reader only shows what the browser can do', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('js/speech.js') > 0 && html.indexOf('js/speech.js') < html.indexOf('js/reader.js'));
  const reader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reader.js'), 'utf8');
  assert.match(reader, /S\.supported\.stt \? \[\{ name: 'rt-dictate'/);
  assert.match(reader, /RT\.speech && RT\.speech\.supported\.tts \? `<button id="pdf-read"/);
  const speech = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'speech.js'), 'utf8');
  // a Chinese text is read as Chinese throughout, by one speaker
  assert.match(speech, /for \(const x of parts\) x\.lang = 'zh-CN';/);
  assert.match(speech, /const PART = \{ 'zh-CN': 90, 'en-US': 260 \};/, 'English pieces are long enough for whole sentences');
  // the only thing speech.js asks for is the voice of this computer's own server
  const asked = [...speech.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(asked.sort(), ["'/api/voice/speak'", "'/api/voice/status'"]);
  assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|speechSynthesis|https?:\/\//.test(speech), 'no other service, no system voice');
});

console.log(`\n${n - failed} of ${n} passed`);
process.exit(failed ? 1 : 0);
