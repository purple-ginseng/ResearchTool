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

test('the page loads note-pdf.js before the reader; the note menu offers the export; nothing leaves the computer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('js/note-pdf.js') > 0 && html.indexOf('js/note-pdf.js') < html.indexOf('js/reader.js'));
  const reader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reader.js'), 'utf8');
  assert.match(reader, /label: 'Export note as PDF…'.*onClick: act\('export-pdf'\)/);
  assert.match(reader, /act === 'export-pdf'[\s\S]{0,200}RT\.notePdf\.print\(/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'note-pdf.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|https?:\/\//.test(src), 'no request of its own');
  assert.match(src, /th, \.np-body td \{ white-space: normal !important;/, 'table cells wrap on paper');
  assert.match(src, /break-inside: avoid/); assert.match(src, /@page \{ size:/);
});

console.log(`\n${n - failed} of ${n} passed`);
process.exit(failed ? 1 : 0);
