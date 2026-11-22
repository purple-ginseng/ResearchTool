#!/usr/bin/env node
// Tests for public/js/refscan.js and lib/refcheck.js (citation keys, the references check).   Run:  node scripts/test-refscan.js
const assert = require('node:assert/strict');
const path = require('node:path');
const S = require(path.join(__dirname, '../public/js/refscan.js'));
const R = require('../lib/refcheck');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 12).join('\n     ')); }
}
const keys = (tex) => S.cites(tex).uses.map((u) => u.key);

test('cite variants', () => {
  assert.deepEqual(keys('a \\cite{a,b} \\citep[see][p. 3]{c} \\textcite{d} \\nocite{e} \\Citet*{f} \\parencite [x] {g}'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});
test('positions', () => {
  const u = S.cites('x\n  \\cite{ aa ,\n bb}').uses;
  assert.deepEqual(u, [{ key: 'aa', line: 1, ch: 9, len: 2 }, { key: 'bb', line: 2, ch: 1, len: 2 }]);
});
test('comments and definitions do not count', () => {
  assert.deepEqual(keys('% \\cite{no}\n50\\% \\cite{yes} % \\cite{no2}\n\\newcommand{\\mc}[1]{\\citep{#1}}\\setcitestyle{numbers}'), ['yes']);
});
test('verbatim text does not count', () => {
  assert.deepEqual(keys('\\verb|\\cite{no}| \\cite{yes}\n\\begin{verbatim}\n\\cite{no}\n\\end{verbatim}\n\\cite{b}'), ['yes', 'b']);
  assert.deepEqual(S.cites('\\verb|x%| \\cite{a}').uses, [{ key: 'a', line: 0, ch: 16, len: 1 }]);
});
test('nocite star', () => {
  assert.equal(S.cites('\\nocite{*}').all, true);
  assert.equal(S.cites('% \\nocite{*}\n\\cite{a}').all, false);
});
test('biblatex multicite', () => {
  assert.deepEqual(keys('\\cites{a}{b,c} \\parencites(pre)(post)[p. 1]{d}[2]{e} and \\cite{f}'), ['a', 'b', 'c', 'd', 'e', 'f']);
});
test('bib keys', () => {
  const k = S.bibKeys('@string{x = "y"}\n@comment{no,}\n@article{Foo2020,\n title={A @ B}}\n@InProceedings{ bar-21 ,\n}');
  assert.deepEqual(k.map((e) => [e.key, e.type, e.line]), [['Foo2020', 'article', 2], ['bar-21', 'inproceedings', 4]]);
  assert.equal(k[1].ch, 16);
});
test('bibitems', () => {
  assert.deepEqual(S.bibitems('\\bibitem[Knuth 84]{knuth}\n\\bibitem{b}').map((b) => [b.key, b.line, b.ch]), [['knuth', 0, 19], ['b', 1, 9]]);
});
test('near', () => {
  assert.deepEqual(S.near('vaswani2017atention', ['vaswani2017attention', 'he2016deep']), ['vaswani2017attention']);
  assert.deepEqual(S.near('Ho2020', ['ho2020', 'xx']), ['ho2020']);
  assert.deepEqual(S.near('vaswani2017', ['vaswani2017attention', 'vaswani2018x']), ['vaswani2017attention', 'vaswani2018x']);
  assert.deepEqual(S.near('zzz', ['abc']), []);
});
test('cited keys with aux and bcf', () => {
  const w = R.citedKeys([{ path: 'a.tex', text: '\\cite{a}' }, { path: 'a.bib', text: '\\cite{no}' }], ['\\citation{b,c}\n\\abx@aux@cite{0}{d}', '<bcf:citekey order="1">e</bcf:citekey>']);
  assert.deepEqual([...w.keys].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(R.citedKeys([], ['\\citation{*}']).all, true);
});
test('pick cited with crossref', () => {
  const items = [{ citekey: 'A', fields: { crossref: 'proc' } }, { citekey: 'b', fields: {} }, { citekey: 'proc', fields: {} }];
  assert.deepEqual(R.pickCited(items, { keys: new Set(['a']), all: false }).map((i) => i.citekey), ['A', 'proc']);
  assert.equal(R.pickCited(items, { keys: new Set(), all: true }).length, 3);
});
test('check', () => {
  const items = [{ id: '1', citekey: 'lib1', type: 'article', fields: { author: 'A', title: 'T', year: '2020', journal: 'arXiv preprint arXiv:1' } },
    { id: '2', citekey: 'dup', type: 'article', fields: { author: 'A', title: 'T', year: '2020', journal: 'J' } }];
  const files = [{ path: 'main.tex', text: '\\cite{lib1,own1,gone}\n\\cite{gone}' },
    { path: 'own.bib', text: '@article{own1,\n title={T}, author={A}}\n@book{never,\n title={T}}\n@misc{DUP,\n}' },
    { path: 'references.bib', text: '@article{ignored,}' }];
  const r = R.check({ files, generated: 'references.bib', library: true, items, scope: 'cited' });
  assert.deepEqual(r.undefined.map((u) => [u.key, u.count]), [['gone', 2]]);
  assert.deepEqual(r.undefined[0].uses[0], { file: 'main.tex', line: 1, col: 17, len: 4 });
  assert.deepEqual(r.duplicates.map((d) => d.key), ['DUP']);
  assert.deepEqual(r.unused.map((d) => d.key), ['never', 'DUP']);
  assert.deepEqual(r.incomplete.map((d) => [d.key, d.issues[0]]), [['lib1', 'arXiv preprint only - check for a published version'], ['own1', 'no year']]);
  assert.equal(r.counts.citedInLibrary, 1);
  const r2 = R.check({ files, generated: null, library: false, items, scope: 'cited' });
  assert.deepEqual(r2.undefined.map((u) => u.key).sort(), ['gone', 'lib1']);
});
test('a .bib file from outside the project, citations of the last run', () => {
  const files = [{ path: 'main.tex', text: '\\cite{gone}' }, { path: 'own.bib', text: '@book{never,\n title={T}}\n@book{Macro,\n title={T}}' }];
  const r = R.check({ files, generated: null, library: false, items: [], scope: 'cited', outside: ['IEEEabrv.bib'], alsoCited: new Set(['macro']) });
  assert.equal(r.undefined.length, 0);
  assert.deepEqual(r.outside, ['IEEEabrv.bib']);
  assert.deepEqual(r.unused.map((d) => d.key), ['never']);
});
console.log(failed ? `\n${failed} test(s) failed` : '\nall passed');
process.exit(failed ? 1 : 0);
