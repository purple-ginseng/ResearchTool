#!/usr/bin/env node
// Tests for public/js/texlint.js (spelling and writing checks of the Write editor).   Run:  node scripts/test-texlint.js
// The word list is the one the server builds (lib/spell.js); without a system dictionary the spelling tests are skipped.
const assert = require('node:assert/strict');
const path = require('node:path');
const spell = require('../lib/spell');
require(path.join(__dirname, '../public/js/texlint.js'));
const T = globalThis.RT.texlint;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 12).join('\n     ')); }
}
const list = spell.wordList();
if (list) T.setWords(list.plain.toString('utf8').split('\n'));
const C = T.checker([new Set(['franka', 'surname'])]);
const scan = (text, off = []) => T.scan(text, { off, known: list ? C.known : null });
const of = (text, type, off) => scan(text, off).filter((p) => p.type === type);
const words = (text) => of(text, 'spell').map((p) => p.word);
const doc = (body) => `\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n${body}\n\\end{document}\n`;

if (list) {
  test('correct words, inflections, British spellings and contractions are accepted', () => {
    for (const w of ['robots', 'learned', 'trajectories', 'modelling', 'labelled', 'colour', 'behaviour', 'optimise', 'optimisation', 'generalizes', 'pretrained',
      'datasets', 'embeddings', "don't", "robot's", 'reparameterization', 'automatically', 'scalability', 'unoccluded', 'Franka', 'SLAM', 'PyTorch', 'centre', 'analysed'])
      assert.equal(C.known(w), true, w);
  });
  test('roman numerals and a name that opens a bracket are not spelling mistakes', () => {
    for (const w of ['ii', 'iii', 'iv', 'vii', 'viii', 'xii']) assert.equal(C.known(w), true, w);
    assert.deepEqual(words(doc('We compare (i) speed, (ii) cost and (iii) reach of the arm (Zzyzxq Panda) here.')), []);
    assert.deepEqual(words(doc('It works. Zzyzxq starts a sentence.')), ['Zzyzxq']);
  });
  test('et al. before \\cite wants a tie', () => {
    assert.equal(of(doc('As shown by Smith et al. \\cite{a}, it works.'), 'tie').length, 1);
  });
  test('misspelt words are flagged', () => {
    for (const w of ['teh', 'recieve', 'seperate', 'algoritm', 'trajectry', 'enviroment']) assert.equal(C.known(w), false, w);
  });
  test('suggestions contain the intended word', () => {
    assert.ok(C.suggest('teh').includes('the'));
    assert.ok(C.suggest('recieve').includes('receive'));
    assert.ok(C.suggest('algoritm').includes('algorithm'));
    assert.equal(C.suggest('Enviroment')[0], 'Environment');
  });
  test('only prose is spell-checked', () => {
    assert.deepEqual(words(doc('We recieve data \\cite{recievekey} in Fig.~\\ref{fig:recieve} and $recieve_x$.\n\\[ teh = 1 \\]\n\\begin{align}\n teh &= 2\n\\end{align}\n% teh comment\n\\texttt{teh} \\url{http://teh.example/a%20b} \\label{sec:teh} \\includegraphics[width=1cm]{teh.png}\n\\begin{verbatim}\nteh } {\n\\end{verbatim}\n\\begin{tabular}{lcc} teh & ok \\\\ \\end{tabular}')),
      ['recieve', 'teh']);
  });
  test('the preamble is not prose; text after \\end{document} is ignored', () => {
    assert.deepEqual(words('\\documentclass{article}\n\\newcommand{\\teh}[1]{teh #1}\n\\begin{document}\nfine words\n\\end{document}\nteh'), []);
  });
  test('names in a sentence, accents, paths and words with digits are left alone', () => {
    assert.deepEqual(words(doc('We thank Zzyzx and Schr\\"odinger and Erd{\\H o}s and G\\"{o}del, see main.tex, resnet50 and foo/bar and a\\_b.')), []);
    assert.deepEqual(words(doc('Zzyzxq starts a sentence.')), ['Zzyzxq']);
  });
}
test('repeated words, also across a line break', () => {
  const p = of(doc('This is the the method.\nIt works and\nand it is fast. Yang Yang wrote it. $x$ x x.'), 'repeat');
  assert.deepEqual(p.map((x) => x.word), ['the', 'and']);
  assert.deepEqual(p[1].fix.from, { line: 4, ch: 12 });
  assert.deepEqual(p[1].fix.to, { line: 5, ch: 3 });
});
test('missing ~ before \\ref and \\cite', () => {
  const p = of(doc('See Figure \\ref{a} and Fig. \\ref{b}, shown in \\cite{c}. \\cite{d} agree, as does Table~\\ref{e} (\\ref{f}).\n\\ref{g} and \\citet{h}'), 'tie');
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.fix.text), ['~', '~', '~']);
});
test('straight quotes', () => {
  const p = of(doc('He said "hello" to \\"o and \\texttt{"x"}.'), 'quotes');
  assert.deepEqual(p.map((x) => x.fix.text), ['``', "''"]);
  assert.equal(of(doc('\\MakeOuterQuote{"} He said "hello".'), 'quotes').length, 0);
});
test('unmatched braces and environments', () => {
  assert.deepEqual(of(doc('\\textbf{bold} and {\\em fine} \\{ \\} $\\{x\\}$'), 'pairs'), []);
  assert.equal(of(doc('\\textbf{bold'), 'pairs')[0].msg, 'This { is never closed');
  assert.match(of(doc('text } more'), 'pairs')[0].msg, /^This } has no \{ before it/);
  assert.deepEqual(of(doc('\\begin{itemize}\n\\item a\n\\end{enumerate}'), 'pairs').map((x) => x.msg), ['\\begin{itemize} has no \\end{itemize} after it', '\\end{enumerate} has no \\begin{enumerate} before it']);
  assert.match(of(doc('\\begin{figure}\n\\caption{x}'), 'pairs')[0].msg, /\\begin\{figure\} has no \\end\{figure\}/);
  assert.deepEqual(of('\\newcommand{\\bi}{\\begin{itemize}}\n\\newcommand{\\ei}{\\end{itemize}}\n\\def\\x{\\begin{center}}', 'pairs'), []);
  assert.deepEqual(of(doc('\\url{http://a.b/c%7Bd} and \\verb|{| and \\begin{lstlisting}[language=C]\nif (x) {\n\\end{lstlisting}'), 'pairs'), []);
});
test('TODO notes in text, comments and \\todo', () => {
  assert.equal(of(doc('TODO write this % FIXME later\n\\todo{cite}'), 'todo').length, 3);
});
test('a check that is switched off reports nothing', () => {
  const text = doc('the the "x" Figure \\ref{a} } TODO');
  for (const [r] of T.RULES) if (r !== 'spell') { assert.ok(of(text, r).length > 0, r); assert.equal(of(text, r, [r]).length, 0, r + ' off'); }
});
test('positions are CodeMirror positions (0-based line and column)', () => {
  const p = of('a\r\nthe the', 'repeat')[0];
  assert.deepEqual([p.from, p.to], [{ line: 1, ch: 4 }, { line: 1, ch: 7 }]);
});
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
