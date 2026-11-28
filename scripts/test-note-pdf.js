#!/usr/bin/env node
// Tests for the note as a PDF (public/js/note-pdf.js), the part that needs no browser: the text area of a page, the
// paper for a locale, the scale at which a wide thing fits, the proposed file name; and that the page loads the
// module before the reader, which offers it in the note's menu. The layout itself (a wide table, a long formula, a
// tall diagram inside the page) is tried in a browser by hand: it needs the renderers.
// Run:  node scripts/test-note-pdf.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('../public/js/note-pdf.js');

let failed = 0, n = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 10).join('\n     ')); }
}

test('page: the text area of A4 and Letter in CSS pixels, A4 for a name that is not known', () => {
  const a4 = N.page('A4');
  assert.equal(a4.css, '210mm 297mm'); assert.equal(a4.margin, '25.4mm 25.4mm 25.4mm', 'the margins of a report: one inch');
  assert.equal(a4.width, Math.floor((210 - 50.8) * 96 / 25.4)); assert.equal(a4.height, Math.floor((297 - 50.8) * 96 / 25.4));
  for (const name of Object.keys(N.PAGES)) assert.ok(N.PAGES[name].margin.every((m) => m >= 20), name + ': never less than 20 mm');
  const us = N.page('Letter');
  assert.equal(us.name, 'Letter'); assert.ok(us.width > a4.width && us.height < a4.height);
  assert.deepEqual(N.page('Tabloid'), a4);
  assert.equal(N.paperFor('en-US'), 'Letter'); assert.equal(N.paperFor('fr-CA'), 'Letter');
  assert.equal(N.paperFor('en-GB'), 'A4'); assert.equal(N.paperFor('zh-CN'), 'A4'); assert.equal(N.paperFor(''), 'A4'); assert.equal(N.paperFor(undefined), 'A4');
});

test('fit: 1 when it fits, the ratio when it does not, never below the least', () => {
  assert.equal(N.fit(600, 672), 1); assert.equal(N.fit(672, 672), 1);
  assert.equal(N.fit(1344, 672), 0.5);
  assert.equal(N.fit(1000, 672), 0.672);
  assert.equal(N.fit(5000, 672), 0.5); assert.equal(N.fit(5000, 672, 0.3), 0.3);
  assert.ok(1500 * N.fit(1500, 672, 0.3) <= 672, 'the scaled width is never wider than the room');
  assert.equal(N.fit(100, 0), 1); assert.equal(N.fit(NaN, 672), 1);
});

test('fileName: the cite key (or the title), without characters a file name cannot have', () => {
  assert.equal(N.fileName('smith2026looped', 'A title'), 'smith2026looped - note');
  assert.equal(N.fileName('', 'What: is "this"? <a/b>'), 'What is this a b - note');
  assert.equal(N.fileName('', ''), 'note - note');
  assert.ok(N.fileName('', 'x'.repeat(300)).length <= 90);
  assert.equal(N.fileName('', '循环 Transformer 的笔记'), '循环 Transformer 的笔记 - note');
});

test('mathBars: a bar inside a formula of a table row no longer ends the cell; everything else stays', () => {
  const H = '| a | b |\n| :---: | --- |\n', B = (row) => { const out = N.mathBars(H + row); assert.ok(out.startsWith(H)); return out.slice(H.length); };
  assert.equal(B('| $u(\\mathbf{A}_t^\\tau | \\mathbf{A}_t) = \\epsilon$ | x |'), '| $u(\\mathbf{A}_t^\\tau \\| \\mathbf{A}_t) = \\epsilon$ | x |');
  assert.equal(B('| $|x|$ | $\\left|a\\right|$ | $ p(a|b) $ |'), '| $\\|x\\|$ | $\\left\\|a\\right\\|$ | $ p(a\\|b) $ |');
  assert.equal(B('> | $$p(a|b)$$ | y |'), '> | $$p(a\\vert b)$$ | y |', 'a "$$" formula: the bar is named');
  assert.equal(B('| $$|x| + |\\mathbf{y}|$$ |'), '| $$\\vert x\\vert + \\vert\\mathbf{y}\\vert$$ |');
  assert.equal(B('| $\\text{a|b}$ | $\\begin{array}{c|c} 1 & 2 \\end{array}$ |'), '| $\\text{a\\|b}$ | $\\begin{array}{c\\|c} 1 & 2 \\end{array}$ |');
  assert.equal(B('| the $i$th joint | $p(a|b)$s |'), '| the $i$th joint | $p(a\\|b)$s |');
  assert.equal(B('| $x$$5$ | $x$ cost | $a$$p(a|b)$ |'), '| $x$$5$ | $x$ cost | $a$$p(a\\|b)$ |', 'two formulas side by side are two formulas');
  assert.equal(B('| US$5 | $p(a|b)$ |'), '| US$5 | $p(a\\|b)$ |');
  assert.equal(B('| ZED Mini（约 $400） | $360\\times640$ RGB, $p(a|b)$ |'), '| ZED Mini（约 $400） | $360\\times640$ RGB, $p(a\\|b)$ |');
  // what drew correctly before stays as it is: bars that are escaped already, money, code, formulas without a bar
  for (const same of ['| $a$ | $b$ |', "| $T(s'\\|s,a)$ | $\\|w\\|_2$ |", '| costs $5 | $6 each |', '| costs $5 | $x_i$ each |', '| tea | $100 | 100$ |', '| $250 | $x$ |', '| the $i$th joint | weight $w$ |',
    '| H$_2$O | $x$ |', '| `$a|b$` | c |', '| a \\$ b | c $ d |', '| $a | b |', '| price $400 total | see $a$ here |', '| $$5 | 6$ |'])
    assert.equal(B(same), same, same);
  // only the rows of a table, and not what is code
  for (const same of ['text $p(a|b)$ outside a table', '| $a|b$ | not a table: no line of dashes |', '|x| is $\\begin{array}{c|c} 1 & 2 \\end{array}$', '', 'para\n\n    | a | b |\n    | --- | --- |\n    | $a|b$ | c |',
    '````\n```\n' + H + '| $a|b$ | c |\n```\n````', '```\n```js\n' + H + '| $a|b$ |\n```', '~~~\n```\n' + H + '| $a|b$ |\n~~~', '```\n' + H + '| $a|b$ |'])
    assert.equal(N.mathBars(same), same, same);
  assert.equal(N.mathBars('a | b\n--- | ---\n$p(a|b)$ | x\n\n| $p(a|b)$ |'), 'a | b\n--- | ---\n$p(a\\|b)$ | x\n\n| $p(a|b)$ |', 'rows without a bar in front; the table ends at an empty line');
  assert.equal(N.mathBars('| $p(a|b)$ | head |\n| --- | --- |'), '| $p(a\\|b)$ | head |\n| --- | --- |', 'the header row too');
  assert.equal(N.mathBars('> ```\n> code\n\n' + H + '| $a|b$ | c |'), '> ```\n> code\n\n' + H + '| $a\\|b$ | c |', 'code of a quote ends with the quote');
  assert.equal(N.mathBars('``` x ```\n\n' + H + '| $a|b$ | c |'), '``` x ```\n\n' + H + '| $a\\|b$ | c |', 'a code span is not a fence');
  const HI = '    | a | b |\n    | :---: | --- |\n'; // (the header, indented as in a list item)
  assert.equal(N.mathBars('1. step\n\n' + HI + '    | $a|b$ | c |'), '1. step\n\n' + HI + '    | $a\\|b$ | c |', 'a table of a list item');
  assert.equal(N.mathBars(H + '| $a|b$ |\r\n| $c|d$ |\r'), H + '| $a\\|b$ |\r\n| $c\\|d$ |\r');
  // what the editor gives back (the bars escaped) is not changed a second time
  for (const row of ['| $u(a | b) = c$ | x |', '| $|x|$ | $$p(a|b)$$ | $\\text{a|b}$ |', '| $a$$p(a|b)$ | US$5 |']) { const once = N.mathBars(H + row); assert.notEqual(once, H + row); assert.equal(N.mathBars(once), once, row); }
  assert.equal(N.mathBars(null), ''); assert.equal(N.mathBars('a\n' + H + '| $x|y$ |\nb').split('\n').length, 5);
  const t = Date.now();
  for (const long of ['$a '.repeat(66000), '$a$b '.repeat(30000), '`'.repeat(100000), '$a | '.repeat(40000), '`a` $ | '.repeat(30000)]) N.mathBars(H + '| ' + long + '|');
  assert.ok(Date.now() - t < 3000, 'a very long row takes no time to speak of (' + (Date.now() - t) + ' ms)');
});

test('the page loads note-pdf.js before the reader; the note menu offers the export; nothing leaves the computer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('js/note-pdf.js') > 0 && html.indexOf('js/note-pdf.js') < html.indexOf('js/reader.js'));
  const reader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reader.js'), 'utf8');
  assert.match(reader, /label: 'Export note as PDF…'.*onClick: act\('export-pdf'\)/);
  assert.match(reader, /act === 'export-pdf'[\s\S]{0,200}RT\.notePdf\.print\(/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'note-pdf.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|https?:\/\//.test(src), 'no request of its own');
  assert.match(src, /th, \.np-body td \{ white-space: normal !important;/, 'table cells wrap on paper');
  assert.match(src, /const title = RT\.texPlain \? RT\.texPlain\(note\.title/, 'LaTeX in a title is shown as text');
  assert.match(src, /P\.fileName\(note\.citekey, title\)/); assert.match(src, /np-title">\$\{esc\(title\)\}/); assert.ok(!/esc\(note\.title\)/.test(src));
  assert.equal(require('../public/js/lineage.js').texPlain('$\\pi_0$: A Vision-Language-Action Flow Model'), 'π₀: A Vision-Language-Action Flow Model');
  assert.match(src, /Vditor\.preview\(stage, P\.mathBars\(note\.md\)/, 'the export draws the note with the bars named');
  assert.match(reader, /Vditor\.preview\(preview, RT\.notePdf\.mathBars\(/, 'and so does the preview beside the editor');
  assert.match(reader, /const bars = \(md\) => RT\.notePdf\.mathBars\(/);
  assert.equal((reader.match(/vd\.setValue\(bars\(/g) || []).length, 4, 'a note, a restored or patched text and the first text go into the editor with the bars escaped');
  assert.equal((reader.match(/vd\.insertMD\(bars\(/g) || []).length, 2, 'and so does text that is inserted');
  assert.ok(!/vd\.setValue\((?!bars\(|vd\.getValue\(\))/.test(reader), 'no other way into the editor');
  assert.match(src, /break-inside: avoid/); assert.match(src, /@page \{ size:/);
});

console.log(`\n${n - failed} of ${n} passed`);
process.exit(failed ? 1 : 0);
