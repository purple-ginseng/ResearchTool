#!/usr/bin/env node
// Tests for the portable note export of lib/notes.js: portableNote() (asset links -> relative paths or data: URIs,
// the #w width fragment, page links, missing pictures, code left alone, CRLF), notePackage() on real files and a zip
// round trip of zipNotes() (the entry list, every link of the .md is a file of the zip). Run:  node scripts/test-note-export.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Z = require('./zipread'); // reads the zips without the unzip program (also on Windows)
process.env.RT_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-notexport-')); // lib/core creates its folders there
const notes = require('../lib/notes');

let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 12).join('\n     ')); }
  })());
}

const ID = 'ab12cd34ef', A = 'a'.repeat(40) + '.png', B = 'b'.repeat(40) + '.jpg', V = 'c'.repeat(40) + '.mp4', GONE = 'd'.repeat(40) + '.png';
const url = (name, id = ID) => `/api/items/${id}/note/assets/${name}`;
const rel = (have) => (id, name) => (have.includes(name) ? { src: 'assets/' + name } : { missing: true });

test('picture links become relative, the #w fragment is dropped', () => {
  const r = notes.portableNote(`# T\n\n![Figure 2](${url(A)}#w=680)\nFigure 2: text\n\n![](${url(B)})\n`, { resolve: rel([A, B]) });
  assert.equal(r.markdown, `# T\n\n![Figure 2](assets/${A})\nFigure 2: text\n\n![](assets/${B})\n`);
  assert.deepEqual(r.used.map((u) => u.name), [A, B]);
  assert.deepEqual(r.missing, []);
  assert.ok(!r.markdown.includes('/api/') && !r.markdown.includes('#w='));
});

test('html widths: a picture with a width becomes <img width>, one without stays Markdown', () => {
  const r = notes.portableNote(`![Fig "1" <a>](${url(A)}#w=440)\n![b](${url(B)})`, { resolve: rel([A, B]), htmlWidths: true });
  assert.equal(r.markdown, `<img src="assets/${A}" width="440" alt="Fig &quot;1&quot; &lt;a&gt;">\n![b](assets/${B})`);
});

test('page links become plain text, other links stay', () => {
  const r = notes.portableNote('see [p. 5](#rt-page=5) and [p. 12](#rt-page=12), [site](https://x.org)', { resolve: rel([]) });
  assert.equal(r.markdown, 'see p. 5 and p. 12, [site](https://x.org)');
});

test('a missing picture leaves a visible note, never a dead /api link', () => {
  const r = notes.portableNote(`![Figure 9](${url(GONE)}#w=680)\n![](${url(GONE)})`, { resolve: rel([]) });
  assert.equal(r.markdown, '[missing image: Figure 9]\n[missing image]');
  assert.deepEqual(r.missing, [GONE]);
});

test('alt text with brackets and escapes, a title, <url> form', () => {
  const r = notes.portableNote(`![a [b] \\] c](<${url(A)}#w=300> "title")`, { resolve: rel([A]) });
  assert.equal(r.markdown, `![a [b] \\] c](assets/${A})`);
});

test('videos and file links get the new address; omitted ones a note', () => {
  const md = `<video src="${url(V)}" controls preload="metadata" width="480"></video>\n[📎 clip.mp4](${url(V)})`;
  const r = notes.portableNote(md, { resolve: rel([V]) });
  assert.equal(r.markdown, `<video src="assets/${V}" controls preload="metadata" width="480"></video>\n[📎 clip.mp4](assets/${V})`);
  const o = notes.portableNote(md, { resolve: () => ({ omitted: true }) });
  assert.equal(o.markdown, `[video not included: ${V}]\n📎 clip.mp4 [file not included: ${V}]`);
  assert.deepEqual(o.omitted, [V]);
});

test('an asset of another paper is resolved by its own id', () => {
  const seen = [];
  notes.portableNote(`![x](${url(A, '0123456789')})`, { resolve: (id, name) => { seen.push(id + '/' + name); return { src: 'x' }; } });
  assert.deepEqual(seen, ['0123456789/' + A]);
});

test('code is left alone: fenced blocks (also in a quote) and inline spans', () => {
  const md = `\`![x](${url(A)})\` [p. 1](#rt-page=1)\n\n\`\`\`md\n![x](${url(A)}#w=680)\n[p. 2](#rt-page=2)\n\`\`\`\n> ~~~\n> [p. 3](#rt-page=3)\n> ~~~\n![y](${url(A)})`;
  const r = notes.portableNote(md, { resolve: rel([A]) });
  assert.equal(r.markdown, `\`![x](${url(A)})\` p. 1\n\n\`\`\`md\n![x](${url(A)}#w=680)\n[p. 2](#rt-page=2)\n\`\`\`\n> ~~~\n> [p. 3](#rt-page=3)\n> ~~~\n![y](assets/${A})`);
});

test('CRLF line ends become LF and still match', () => {
  const r = notes.portableNote(`a\r\n![F](${url(A)}#w=680)\r\n[p. 4](#rt-page=4)\r\n`, { resolve: rel([A]) });
  assert.equal(r.markdown, `a\n![F](assets/${A})\np. 4\n`);
});

// a workspace with one paper whose note has two pictures (one missing on disk) and a video
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4520000000049454e44ae426082', 'hex');
const ws = process.env.RT_WORKSPACE, adir = path.join(ws, 'notes', 'assets', ID);
fs.mkdirSync(adir, { recursive: true });
fs.writeFileSync(path.join(adir, A), PNG);
fs.writeFileSync(path.join(adir, V), Buffer.alloc(64));
const NOTE = `# Note\n\n![Figure 1](${url(A)}#w=680)\nFigure 1: x [p. 3](#rt-page=3)\n\n![Gone](${url(GONE)})\n\n<video src="${url(V)}" controls width="480"></video>\n`;
fs.writeFileSync(path.join(ws, 'notes', ID + '.md'), NOTE);
const ITEM = { id: ID, citekey: 'Odd key/名 2024:*', fields: { title: 'T' } };

test('fileKey makes a safe folder name of an odd cite key', () => {
  assert.equal(notes.fileKey(ITEM), 'Odd_key___2024__');
});

test('embedded: every picture a data: URI, videos left out, size counted', () => {
  const p = notes.notePackage(ITEM, NOTE, { mode: 'embed' });
  assert.ok(p.markdown.includes(`![Figure 1](data:image/png;base64,${PNG.toString('base64')})`));
  assert.ok(p.markdown.includes('[missing image: Gone]'));
  assert.ok(p.markdown.includes(`[video not included: ${V}]`));
  assert.equal(p.bytes, Buffer.byteLength(p.markdown));
  assert.ok(p.bytes > PNG.length * 4 / 3);
  assert.deepEqual(p.files, []);
});

test('zip round trip: <key>/<key>.md + <key>/assets/, every link is a file of the zip', async () => {
  const z = await notes.zipNotes([ITEM, { id: 'ffffffffff', citekey: 'empty' }], { links: false });
  try {
    assert.equal(z.count, 2); assert.equal(z.notes, 1); assert.equal(z.missing, 1);
    const list = Z.list(z.file);
    const key = notes.fileKey(ITEM);
    assert.ok(list.includes(`${key}/${key}.md`), list.join(', '));
    assert.ok(list.includes(`${key}/assets/${A}`) && list.includes(`${key}/assets/${V}`), list.join(', '));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-unzip-'));
    Z.extract(z.file, out);
    const md = fs.readFileSync(path.join(out, key, key + '.md'), 'utf8');
    const links = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)|src="([^"]+)"/g)].map((m) => m[1] || m[2]);
    assert.equal(links.length, 2);
    assert.ok(list.includes(`${key}/${key}.bib`) && list.includes('empty/empty.md'), list.join(', '));
    assert.ok(fs.readFileSync(path.join(out, 'empty', 'empty.md'), 'utf8').includes('_No note yet._'));
    for (const l of links) assert.ok(fs.existsSync(path.join(out, key, l)), 'missing in the zip: ' + l);
    assert.ok(!md.includes('/api/') && !md.includes('#rt-page') && md.includes('Figure 1: x p. 3'));
    fs.rmSync(out, { recursive: true, force: true });
  } finally { fs.rmSync(z.file, { force: true }); fs.rmSync(z.tmp, { recursive: true, force: true }); }
});

test('an absolute address of the app is replaced whole', () => {
  const r = notes.portableNote(`![abs](http://localhost:4790${url(A)}#w=500) <img src="http://127.0.0.1:4790${url(A)}">`, { resolve: rel([A]) });
  assert.equal(r.markdown, `![abs](assets/${A}) <img src="assets/${A}">`);
});

test('fileKey: no leading - or ., no trailing ., no Windows device name', () => {
  const k = (citekey) => notes.fileKey({ id: 'ab12cd34ef', citekey });
  assert.equal(k('-TTtouch'), '_TTtouch'); assert.equal(k('smith2020a.'), 'smith2020a'); assert.equal(k('..x'), '_x');
  assert.equal(k('CON'), 'CON_'); assert.equal(k('lpt1.x'), 'lpt1_.x'); assert.equal(k('console'), 'console');
});

test('zipTree: a name that starts with - is a folder, not an option of zip', async () => {
  const tmp = notes.scratchDir();
  for (const n of ['-T', '-TTfalse']) { fs.mkdirSync(path.join(tmp, n)); fs.writeFileSync(path.join(tmp, n, 'a.md'), 'x'); }
  const file = await notes.zipTree(tmp, ['-T', '-TTfalse']);
  try {
    const list = Z.list(file);
    assert.ok(list.includes('-T/a.md') && list.includes('-TTfalse/a.md'), list.join(', '));
  } finally { fs.rmSync(file, { force: true }); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('exportNotes: keys that repeat (also only in case) get -2, names maps every paper to its own file', () => {
  const ids = ['1111111111', '2222222222', '3333333333', '4444444444'], keys = ['li2021', 'li2021', 'Smith2020a', 'smith2020a'];
  fs.writeFileSync(path.join(ws, 'library.json'), JSON.stringify({ items: ids.map((id, i) => ({ id, citekey: keys[i], fields: {} })) }));
  ids.forEach((id, i) => fs.writeFileSync(path.join(ws, 'notes', id + '.md'), `note ${i}\n`));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-exportnotes-'));
  try {
    const r = notes.exportNotes(out, { ids: new Set(ids) });
    assert.deepEqual(ids.map((id) => r.names[id]), ['li2021.md', 'li2021-2.md', 'Smith2020a.md', 'smith2020a-2.md']);
    assert.equal(r.count, 4);
    ids.forEach((id, i) => assert.equal(fs.readFileSync(path.join(r.dir, r.names[id]), 'utf8'), `note ${i}\n`));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('zipNotes: a paper without a note still gets a package; nothing valid is a 400', async () => {
  const z = await notes.zipNotes([{ id: 'eeeeeeeeee', citekey: 'x', fields: { title: 'X' } }], { links: false });
  try { assert.equal(z.count, 1); assert.equal(z.notes, 0); } finally { fs.rmSync(z.file, { force: true }); fs.rmSync(z.tmp, { recursive: true, force: true }); }
  await assert.rejects(notes.zipNotes([{ id: 'not-an-id', citekey: 'x' }]), (e) => e.status === 400);
});

// a paper package: front matter, header, links, the PDF and the .bib next to the .md, README.md + references.bib
const PID = '5555555555';
fs.mkdirSync(path.join(ws, 'pdfs'), { recursive: true });
fs.writeFileSync(path.join(ws, 'pdfs', PID + '.pdf'), '%PDF-1.4\n%fake\n');
fs.writeFileSync(path.join(ws, 'notes', PID + '.md'), `# 摘要\n\nThe note. ![F](${url(A, PID)}#w=300)\n`);
fs.mkdirSync(path.join(ws, 'notes', 'assets', PID), { recursive: true });
fs.writeFileSync(path.join(ws, 'notes', 'assets', PID, A), PNG);
const PAPER = { id: PID, citekey: 'yu2025forcevla', type: 'article', pdf: true, tags: ['VLA', 'force'],
  fields: { title: 'Force{VLA}: "Enhancing" VLA: $\\alpha$ 力', author: 'Yu, Jiawen and Hongyuan Liu', year: '2025', doi: '10.48550/ARXIV.2505.22159', url: 'https://arxiv.org/abs/2505.22159' } };

test('package: <key>.md with front matter and links that resolve to files of the zip (pdf, bib, assets)', async () => {
  const z = await notes.zipNotes([PAPER, ITEM], { index: true, network: false });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-unzip-'));
  try {
    const list = Z.list(z.file);
    const k = 'yu2025forcevla';
    for (const f of [`${k}/${k}.md`, `${k}/${k}.bib`, `${k}/${k}.pdf`, `${k}/assets/${A}`, 'README.md', 'references.bib']) assert.ok(list.includes(f), f + ' not in ' + list.join(', '));
    assert.equal(z.pdfs, 1);
    Z.extract(z.file, out);
    const md = fs.readFileSync(path.join(out, k, k + '.md'), 'utf8');
    // front matter first, valid double-quoted strings
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    assert.ok(fm, md.slice(0, 300));
    const get = (name) => { const m = new RegExp(`^${name}: (.*)$`, 'm').exec(fm[1]); return m ? JSON.parse(m[1].startsWith('[') || m[1].startsWith('"') ? m[1] : JSON.stringify(m[1])) : undefined; };
    assert.equal(get('title'), 'ForceVLA: "Enhancing" VLA: $\\alpha$ 力');
    assert.deepEqual(get('authors'), ['Jiawen Yu', 'Hongyuan Liu']);
    assert.equal(get('arxiv'), '2505.22159'); assert.equal(get('pdf'), k + '.pdf'); assert.deepEqual(get('tags'), ['VLA', 'force']);
    // the title heading (the note starts with "# 摘要"), the links line, then the note
    assert.ok(md.includes('\n# ForceVLA: "Enhancing" VLA: $\\alpha$ 力\n'), md.slice(0, 600));
    assert.ok(md.includes(`[PDF](${k}.pdf) · [BibTeX](${k}.bib) · [arXiv](https://arxiv.org/abs/2505.22159)`), md.slice(0, 600));
    assert.ok(md.indexOf('# 摘要') > md.indexOf('[PDF]'));
    for (const m of md.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(m[1])) assert.ok(fs.existsSync(path.join(out, k, m[1])), 'missing in the zip: ' + m[1]);
    assert.ok(fs.readFileSync(path.join(out, k, k + '.bib'), 'utf8').startsWith('@article{yu2025forcevla,'));
    const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
    for (const m of readme.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(m[1])) assert.ok(fs.existsSync(path.join(out, m[1])), 'README link missing: ' + m[1]);
    assert.ok(/@article\{yu2025forcevla,[\s\S]*@misc\{Odd key/.test(fs.readFileSync(path.join(out, 'references.bib'), 'utf8')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(z.file, { force: true }); fs.rmSync(z.tmp, { recursive: true, force: true }); }
});

test('package without the PDF: no .pdf in the zip, the PDF link is the arXiv PDF; estimate counts the PDF bytes', async () => {
  const z = await notes.zipNotes([PAPER], { pdf: false, network: false });
  try {
    const list = Z.list(z.file);
    assert.ok(!list.some((f) => f.endsWith('.pdf')) && !list.includes('README.md'), list.join(', '));
    const md = Z.read(z.file, 'yu2025forcevla/yu2025forcevla.md').toString('utf8');
    assert.ok(md.includes('[PDF](https://arxiv.org/pdf/2505.22159)'));
  } finally { fs.rmSync(z.file, { force: true }); fs.rmSync(z.tmp, { recursive: true, force: true }); }
  assert.deepEqual(notes.packageEstimate([PAPER, ITEM]), { papers: 2, notes: 2, pdfs: 1, pdfBytes: fs.statSync(path.join(ws, 'pdfs', PID + '.pdf')).size });
});

Promise.all(pending).then(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
  console.log('\nall note export tests passed');
});
