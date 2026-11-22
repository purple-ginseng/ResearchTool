#!/usr/bin/env node
// Tests for the papers of a project: lib/projects.js (papers, editPapers, listLite, bibScope 'project', remove),
// the routes of lib/routes/projects.js (papers, memberships, reading-pack, annotated, refs) and the project review
// of lib/quiz.js - in-process, against a temporary workspace. No AI call, no server.
// Run:  node scripts/test-project-papers.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pptest-'));
process.env.RT_WORKSPACE = WS; // lib/core creates its folders there
const EXPORT = path.join(WS, 'out');

const item = (id, citekey, title, extra = {}) => ({ id, citekey, type: 'article', fields: { title, author: 'Smith, Ann and Lee, Bo', year: '2021' },
  keypoints: [{ id: 'k1' + id, text: 'A result with 50% & more_stuff.', page: 3, category: 'result' }, { id: 'k2' + id, text: 'The main contribution.', page: 1, category: 'contribution' }],
  added: '2026-01-01T00:00:00.000Z', category: 'Uncategorized', tags: [], ...extra });
fs.writeFileSync(path.join(WS, 'library.json'), JSON.stringify({ items: [
  item('aaaaaa0001', 'smith2021a', 'First paper', { status: 'done', brief: 'Shows that A beats B.', starred: true, pages: 10, reading: { page: 4 } }),
  item('aaaaaa0002', 'lee2021b', 'Second paper', { status: 'reading' }),
  item('aaaaaa0003', 'kim2020c', 'Third paper'),
  item('aaaaaa0004', 'Ng2019d', 'Fourth paper'),
] }));
fs.writeFileSync(path.join(WS, 'settings.json'), JSON.stringify({ exportDir: EXPORT }));
fs.mkdirSync(path.join(WS, 'notes'), { recursive: true });
fs.writeFileSync(path.join(WS, 'notes', 'aaaaaa0001.md'), '# Note of the first paper\n\nThis is a note that is long enough to count as one.\n');
fs.mkdirSync(path.join(WS, 'highlights'), { recursive: true });
fs.writeFileSync(path.join(WS, 'highlights', 'aaaaaa0001.json'), JSON.stringify({ highlights: [{ id: 'h1', page: 1, text: 'x', rects: [[1, 0.1, 0.1, 0.2, 0.02]] }, { id: 'bad' }], removed: [] }));
const q = (id, answer) => ({ id, q: 'Q?', options: ['a', 'b', 'c', 'd'], answer, explain: '', why: ['', '', '', ''] });
fs.mkdirSync(path.join(WS, 'quizzes'), { recursive: true });
const past = new Date(Date.now() - 3 * 86400000).toISOString();
fs.writeFileSync(path.join(WS, 'quizzes', 'aaaaaa0001.json'), JSON.stringify({ quizzes: [{ id: 'qz1', questions: [q('q1', 0), q('q2', 1), q('q3', 2)],
  progress: {}, review: { q1: { step: 0, interval: 0, due: past, right: 0, wrong: 1 }, q2: { step: 2, interval: 3, due: new Date(Date.now() + 30 * 86400000).toISOString(), right: 2, wrong: 0 } } }] }));
fs.writeFileSync(path.join(WS, 'quizzes', 'aaaaaa0003.json'), JSON.stringify({ quizzes: [{ id: 'qz2', questions: [q('q9', 0)], progress: {}, review: { q9: { step: 0, interval: 0, due: past } } }] }));

const core = require('../lib/core');
const routes = require('../lib/routes/projects');
const quizRoutes = require('../lib/routes/quiz');
const writing = require('../lib/writing');
const { P } = core;

// a request against a route module: -> {code, data}
async function call(mod, method, url, body) {
  const u = new URL(url, 'http://localhost'), p = decodeURIComponent(u.pathname);
  let out = null;
  const ctx = { url: u, path: p, segments: p.split('/').filter(Boolean), method, query: u.searchParams, req: null, res: { on() {} },
    json: async () => body || {}, send: (code, data) => { out = { code, data }; return true; },
    sendFile: (file, type, headers, after) => { out = { code: 200, file, type, headers, after }; return true; } };
  try { if (!(await mod.handle(ctx))) return { code: 404, data: null }; } catch (e) { return { code: e.status || 500, data: { error: e.message } }; }
  return out;
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 12).join('\n     ')); }
}

(async () => {
  const proj = P.create('Proposal', { template: 'blank' });
  fs.writeFileSync(path.join(proj.path, 'main.tex'), '\\documentclass{article}\\begin{document}\n\\cite{smith2021a} \\cite{smith2021a,kim2020c} \\citep{ng2019d}\n% \\cite{lee2021b}\n\\bibliography{references}\n\\end{document}\n');
  const base = `/api/projects/${proj.id}`;

  await test('editPapers: add, dedupe, order, unknown ids ignored', () => {
    const r = P.editPapers(proj, { add: ['aaaaaa0002', 'aaaaaa0001', 'aaaaaa0002', 'nope'] });
    assert.deepEqual(r.papers.map((p) => p.id), ['aaaaaa0002', 'aaaaaa0001']);
    assert.deepEqual(r.ignored, ['nope']);
    assert.ok(!Number.isNaN(Date.parse(r.papers[0].added)));
    const r2 = P.editPapers(proj, { add: ['aaaaaa0001'], remove: ['aaaaaa0002'] });
    assert.deepEqual(r2.papers.map((p) => p.id), ['aaaaaa0001']);
    assert.throws(() => P.editPapers(proj, { add: 'x' }), /lists/);
  });
  await test('POST /papers -> {papers, ignored}', async () => {
    const r = await call(routes, 'POST', base + '/papers', { add: ['aaaaaa0002', 'zzz'] });
    assert.equal(r.code, 200);
    assert.deepEqual(r.data, { papers: ['aaaaaa0001', 'aaaaaa0002'], ignored: ['zzz'], added: ['aaaaaa0002'], removed: [] });
  });
  await test('GET /papers rows, cited, counts, citedNotMember', async () => {
    const r = await call(routes, 'GET', base + '/papers');
    assert.equal(r.code, 200);
    const d = r.data;
    assert.deepEqual(d.project, { id: proj.id, name: proj.name });
    assert.deepEqual(d.papers.map((x) => x.id), ['aaaaaa0001', 'aaaaaa0002']);
    const [a, b] = d.papers;
    assert.equal(a.author, 'Smith et al.');
    assert.equal(a.status, 'done'); assert.equal(b.status, 'reading');
    assert.equal(a.cited, true); assert.equal(a.citedCount, 2);
    assert.equal(b.cited, false); assert.equal(b.citedCount, 0); // only cited in a comment
    assert.equal(a.hasNote, true); assert.equal(b.hasNote, false);
    assert.equal(a.highlights, 1);
    assert.deepEqual(a.quiz, { answered: 2, correct: 1, due: 1 });
    assert.equal(a.pages, 10); assert.equal(a.readingPage, 4); assert.equal(a.starred, true);
    assert.deepEqual(d.citedNotMember.map((x) => x.citekey).sort(), ['Ng2019d', 'kim2020c']); // case-blind like BibTeX
    assert.deepEqual(d.counts, { total: 2, toRead: 0, reading: 1, done: 1, cited: 1, noNote: 1, due: 1 });
  });
  await test('GET /api/memberships and ?lite=1', async () => {
    const r = await call(routes, 'GET', '/api/memberships');
    assert.deepEqual(r.data.byItem, { aaaaaa0001: [proj.id], aaaaaa0002: [proj.id] });
    assert.deepEqual(r.data.projects, [{ id: proj.id, name: proj.name, path: proj.path, external: false, overleaf: false, papers: 2 }]);
    const l = await call(routes, 'GET', '/api/projects?lite=1');
    assert.deepEqual(l.data.projects, r.data.projects);
  });
  await test('papers in the trash stay stored but are not shown', async () => {
    const lib = JSON.parse(fs.readFileSync(path.join(WS, 'library.json'), 'utf8'));
    const gone = lib.items.splice(1, 1);
    fs.writeFileSync(path.join(WS, 'library.json'), JSON.stringify(lib));
    assert.deepEqual(P.papers(proj).map((p) => p.id), ['aaaaaa0001', 'aaaaaa0002']);
    assert.deepEqual((await call(routes, 'GET', base + '/papers')).data.papers.map((x) => x.id), ['aaaaaa0001']);
    assert.equal(P.listLite()[0].papers, 1);
    lib.items.splice(1, 0, ...gone); // put back: reconnected
    fs.writeFileSync(path.join(WS, 'library.json'), JSON.stringify(lib));
    assert.equal(P.listLite()[0].papers, 2);
  });
  await test('review limited to a project', async () => {
    const all = await call(quizRoutes, 'GET', '/api/review');
    assert.equal(all.data.due, 2);
    const mine = await call(quizRoutes, 'GET', `/api/review?project=${proj.id}&cards=1`);
    assert.equal(mine.data.due, 1);
    assert.deepEqual(mine.data.cards.map((c) => c.itemId), ['aaaaaa0001']);
    assert.equal((await call(quizRoutes, 'GET', '/api/review?project=nope')).code, 404);
  });
  await test('bibScope project: settings, decorate, writeReferences header, refs', async () => {
    assert.equal(P.get(proj.id).bibScope, 'cited');
    assert.equal(P.setSettings(proj, { bibScope: 'project' }).bibScope, 'project');
    assert.throws(() => P.setSettings(proj, { bibScope: 'x' }), /bibScope/);
    const refs = await call(routes, 'GET', base + '/refs');
    assert.deepEqual(refs.data.citedKeys.sort(), ['kim2020c', 'ng2019d', 'smith2021a']);
    assert.equal(refs.data.scope, 'project');
    assert.equal(refs.data.counts.citedInLibrary, 4); // 3 cited + lee2021b of the project
    // the compile would write references.bib; the header is checked through the generated text
    const bibFile = path.join(proj.path, 'references.bib');
    fs.writeFileSync(bibFile, core.BIB_MARKER + '\n');
    const r = await call(routes, 'POST', base + '/compile', {}); // latexmk may be missing: references.bib is written first
    assert.ok(r);
    const bib = fs.readFileSync(bibFile, 'utf8');
    assert.match(bib, /^% Generated by ResearchTool.*\n% Cited entries plus the papers of this project: 4\./);
    assert.match(bib, /lee2021b/);
    assert.equal(P.setSettings(proj, { bibScope: 'cited' }).bibScope, 'cited');
    assert.equal(P.get(proj.id).bibScope, 'cited');
  });
  await test('annotated bibliography', async () => {
    const r = await call(routes, 'POST', base + '/annotated', {});
    assert.deepEqual(r.data.keys, ['smith2021a', 'lee2021b']);
    assert.match(r.data.latex, /\\begin\{description\}/);
    assert.match(r.data.latex, /\\item\[\\cite\{smith2021a\}\] Shows that A beats B\./);
    assert.match(r.data.latex, /A result with 50\\% \\& more\\_stuff\. \(p\.~3\)/);
    const one = await call(routes, 'POST', base + '/annotated', { ids: ['aaaaaa0003', 'none'] });
    assert.deepEqual(one.data.keys, ['kim2020c']);
    assert.equal((await call(routes, 'POST', base + '/annotated', { ids: 'x' })).code, 400);
    assert.equal(writing.texEsc('a_b $x_1$'), 'a\\_b $x_1$');
  });
  await test('reading pack', async () => {
    const r = await call(routes, 'POST', base + '/reading-pack', {});
    assert.equal(r.code, 200);
    assert.equal(r.data.dir, path.join(EXPORT, 'Proposal - reading pack'));
    assert.deepEqual(r.data.files, ['reading-list.md', 'references.bib', 'notes/smith2021a.md']);
    assert.match(r.data.markdown, /## First paper \(2021\)/);
    assert.match(r.data.markdown, /`smith2021a` · Done · cited: yes/);
    assert.match(r.data.markdown, /- A result with 50% & more_stuff\. \(p\. 3\)/);
    assert.match(r.data.markdown, /Note: \[notes\/smith2021a\.md\]/);
    const bib = fs.readFileSync(path.join(r.data.dir, 'references.bib'), 'utf8');
    assert.match(bib, /smith2021a/); assert.match(bib, /lee2021b/); assert.doesNotMatch(bib, /kim2020c/);
    assert.ok(fs.existsSync(path.join(r.data.dir, 'notes', 'smith2021a.md')));
    assert.ok(!fs.existsSync(path.join(proj.path, 'reading-list.md')));
    const again = await call(routes, 'POST', base + '/reading-pack', {}); // a second pack replaces the first
    assert.equal(again.code, 200);
  });
  await test('reading pack as a zip: one paper package per paper, reading-list.md (the one index) + references.bib at the top', async () => {
    const r = await call(routes, 'POST', base + '/reading-pack?format=zip&links=0', {});
    assert.equal(r.code, 200); assert.equal(r.type, 'application/zip');
    try {
      const list = require('./zipread').list(r.file);
      const top = 'Proposal - reading pack/';
      assert.ok(!list.includes(top + 'README.md'), 'a second index: ' + list.join(', '));
      for (const f of ['reading-list.md', 'references.bib', 'smith2021a/smith2021a.md', 'smith2021a/smith2021a.bib', 'lee2021b/lee2021b.md']) assert.ok(list.includes(top + f), f + ' not in ' + list.join(', '));
      assert.ok(!list.some((f) => f.includes('/notes/')), list.join(', '));
      const md = require('./zipread').read(r.file, top + 'reading-list.md').toString('utf8');
      assert.match(md, /Paper package: \[smith2021a\/smith2021a\.md\]\(smith2021a\/smith2021a\.md\)/);
    } finally { r.after(); }
  });
  await test('rename keeps the papers, remove of an internal project drops them', async () => {
    const r = await call(routes, 'POST', base + '/rename-project', { name: 'Renamed' });
    assert.equal(r.code, 200);
    const next = P.get('Renamed');
    assert.deepEqual(P.papers(next).map((p) => p.id), ['aaaaaa0001', 'aaaaaa0002']);
    P.remove(next);
    assert.deepEqual(P.papers({ id: 'Renamed' }), []);
  });
  await test('an external folder keeps its papers when it is forgotten and opened again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ppext-'));
    fs.writeFileSync(path.join(dir, 'main.tex'), '\\documentclass{article}\n');
    const ext = P.openFolder(dir);
    P.editPapers(ext, { add: ['aaaaaa0003'] });
    P.setSettings(ext, { compiler: 'xelatex' });
    P.remove(ext);
    assert.equal(P.listLite().some((x) => x.id === ext.id), false);
    const back = P.openFolder(dir);
    assert.equal(back.id, ext.id);
    assert.deepEqual(P.papers(back).map((p) => p.id), ['aaaaaa0003']);
    assert.equal(back.compiler, 'pdflatex'); // the other settings are forgotten as before
    P.remove(back);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('a renamed external folder takes over the papers of the missing one', () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ppmv-')), a = path.join(top, 'a', 'thesis'), b = path.join(top, 'b', 'thesis');
    fs.mkdirSync(a, { recursive: true }); fs.writeFileSync(path.join(a, 'main.tex'), '\\documentclass{article}\n');
    const ext = P.openFolder(a);
    P.editPapers(ext, { add: ['aaaaaa0003', 'aaaaaa0004'] });
    fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b);
    const moved = P.openFolder(b);
    assert.notEqual(moved.id, ext.id);
    assert.deepEqual(P.papers(moved).map((p) => p.id), ['aaaaaa0003', 'aaaaaa0004']);
    assert.equal(P.listLite().some((x) => x.id === ext.id), true); // the missing entry is kept (an unmounted drive comes back)
    P.remove(moved); // forgotten, then moved again: still found by its folder name
    const c = path.join(top, 'c', 'thesis'); fs.mkdirSync(path.dirname(c), { recursive: true }); fs.renameSync(b, c);
    const again = P.openFolder(c);
    assert.deepEqual(P.papers(again).map((p) => p.id), ['aaaaaa0003', 'aaaaaa0004']);
    const c2 = path.join(top, 'c', 'thesis-v2'); fs.renameSync(c, c2); // renamed where it is
    const renamed = P.openFolder(c2);
    assert.deepEqual(P.papers(renamed).map((p) => p.id), ['aaaaaa0003', 'aaaaaa0004']);
    P.remove(renamed);
    fs.rmSync(top, { recursive: true, force: true });
  });
  await test('a new project does not inherit the papers of a deleted folder of that name', () => {
    const x = P.create('Gone-x', { template: 'blank' });
    P.editPapers(x, { add: ['aaaaaa0001'] });
    fs.rmSync(x.path, { recursive: true, force: true }); // deleted outside the app
    const y = P.create('Gone-x', { template: 'blank' });
    assert.deepEqual(P.papers(y), []);
    P.editPapers(y, { add: ['aaaaaa0002'] });
    fs.rmSync(y.path, { recursive: true, force: true });
    const z = P.create('Other-z', { template: 'blank' });
    const r = P.renameProject(z, 'Gone-x');
    assert.deepEqual(P.papers(r), []);
    P.remove(r);
  });
  await test('add / remove report what really changed', async () => {
    const pr = P.create('Changes', { template: 'blank' }), u = `/api/projects/${pr.id}/papers`;
    let r = await call(routes, 'POST', u, { add: ['aaaaaa0001', 'aaaaaa0002'] });
    assert.deepEqual(r.data.added, ['aaaaaa0001', 'aaaaaa0002']);
    r = await call(routes, 'POST', u, { add: ['aaaaaa0001', 'aaaaaa0003'] });
    assert.deepEqual(r.data.added, ['aaaaaa0003']);
    r = await call(routes, 'POST', u, { remove: ['aaaaaa0004', 'aaaaaa0002'] });
    assert.deepEqual(r.data.removed, ['aaaaaa0002']);
    P.remove(P.get(pr.id));
  });
  await test('reading pack: same names get their own folder, never a project folder', async () => {
    const one = P.create('Twin', { template: 'blank' });
    P.editPapers(one, { add: ['aaaaaa0001'] });
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pptwin-')), d = path.join(top, 'Twin');
    fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'main.tex'), '\\documentclass{article}\n');
    const two = P.openFolder(d);
    P.editPapers(two, { add: ['aaaaaa0002'] });
    const a = await call(routes, 'POST', `/api/projects/${one.id}/reading-pack`, {});
    const b = await call(routes, 'POST', `/api/projects/${two.id}/reading-pack`, {});
    assert.equal(a.code, 200); assert.equal(b.code, 200);
    assert.notEqual(a.data.dir, b.data.dir);
    assert.match(fs.readFileSync(path.join(a.data.dir, 'reading-list.md'), 'utf8'), /First paper/);
    // a project folder inside its own pack folder: refused, nothing goes to the trash
    const inner = path.join(EXPORT, 'notes - reading pack', 'notes'); fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'main.tex'), '\\documentclass{article}\n');
    const ip = P.openFolder(inner);
    P.editPapers(ip, { add: ['aaaaaa0001'] });
    const pk = await call(routes, 'POST', `/api/projects/${ip.id}/reading-pack`, {});
    assert.equal(pk.code, 400);
    assert.ok(fs.existsSync(path.join(inner, 'main.tex')));
    P.remove(ip);
    // the export folder is another project's folder
    const s = JSON.parse(fs.readFileSync(path.join(WS, 'settings.json'), 'utf8'));
    fs.writeFileSync(path.join(WS, 'settings.json'), JSON.stringify({ ...s, exportDir: d }));
    const bad = await call(routes, 'POST', `/api/projects/${one.id}/reading-pack`, {});
    assert.equal(bad.code, 400);
    assert.ok(!fs.readdirSync(d).some((n) => /reading pack/.test(n)));
    fs.writeFileSync(path.join(WS, 'settings.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(WS, 'settings.json'), 'utf8')), exportDir: EXPORT }));
    P.remove(two); P.remove(P.get(one.id));
    fs.rmSync(top, { recursive: true, force: true });
  });
  await test('LaTeX escaping of the annotated bibliography', () => {
    assert.equal(writing.texEsc('US$ 5'), 'US\\$ 5');
    assert.equal(writing.texEsc('a\\$b'), 'a\\textbackslash{}\\$b');
    assert.equal(writing.texEsc('x $a%b$'), 'x \\$a\\%b\\$');
    assert.equal(writing.texEsc('cost $5 and $10'), 'cost \\$5 and \\$10');
    assert.equal(writing.texEsc('$π_0$ and π'), '$\\pi _0$ and \\ensuremath{\\pi}');
    assert.deepEqual(writing.annotatedBibliography([]), { latex: '% Annotated bibliography from ResearchTool: 0 papers\n', keys: [] });
  });

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
