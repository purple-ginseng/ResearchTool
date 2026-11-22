#!/usr/bin/env node
// Tests for lib/links.js (pure parts, no network): URLs in synthetic pdftotext text (line-broken URLs, trailing
// punctuation, the reference list ignored, code vs project page), arXiv comment forms, the BibTeX fields, merging and
// ranking of the sources; and the YAML front matter of lib/notes.js (quotes, colons, $math$, CJK). Line-end hyphens
// of URLs, dead project pages, code from the authors' project page (saved HTML in scripts/fixtures/links/), Hugging
// Face repositories no author source confirms; links() with a stub fetch (no real network).
// Run:  node scripts/test-links.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RT_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-links-')); // lib/core creates its folders there
const L = require('../lib/links');
const notes = require('../lib/notes');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 10).join('\n     ')); }
}
const scan = (pages, own = {}) => L.scanPages(pages, { own, dropReferences: notes.dropReferences });
const pick = (list, kind) => list.filter((x) => x.kind === kind).map((x) => x.url);

// a body of filler text (so that the reference list starts after a quarter of the paper, as notes.dropReferences wants)
const filler = (n) => Array.from({ length: n }, (_, i) => `This is line ${i} of the method section, describing the approach in some detail for the reader.`).join('\n');
const refs = Array.from({ length: 14 }, (_, i) => `[${i + 1}] A. Author, B. Author, et al. Some cited paper number ${i}. In Proc. CVPR, 2023. Code is available at https://github.com/cited/repo${i}.`).join('\n');

test('cleanUrl: trailing punctuation, balanced parentheses, a link without https://', () => {
  assert.equal(L.cleanUrl('https://tonyfang.net/FoAR/.'), 'https://tonyfang.net/FoAR/');
  assert.equal(L.cleanUrl('https://x.github.io/),'), 'https://x.github.io');
  assert.equal(L.cleanUrl('https://en.wikipedia.org/wiki/A_(b))'), 'https://en.wikipedia.org/wiki/A_(b)');
  assert.equal(L.cleanUrl('github.com/AetherLabsAI/CausalWM;'), 'https://github.com/AetherLabsAI/CausalWM');
  assert.equal(L.cleanUrl('https://localhost'), null);
});

test('joinBroken: a URL broken at the margin is joined, a whole one is not', () => {
  const long = 'We provide code, models of our test objects, a video showcasing our algorithm, and material at https://papers.starslab.';
  assert.equal(L.joinBroken(`${long}\nca/fast-inertial-identification/.\nNext sentence here.`), `${long}ca/fast-inertial-identification/.\nNext sentence here.`);
  assert.equal(L.joinBroken('information is essential for success. Project website: https:\n//phys2real.github.io/\n'), 'information is essential for success. Project website: https://phys2real.github.io/\n');
  // a link alone on a short line, then the next line of the page: not joined
  assert.equal(L.joinBroken('Project page: https://sparsh-ssl.github.io/\nKeywords: Tactile sensing'), 'Project page: https://sparsh-ssl.github.io/\nKeywords: Tactile sensing');
  // "Optimization Details." after a URL that ends a line is the next heading, not part of the URL
  const t = 'frame rates. The source code and all our data are available at the address:\nhttps://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/\nOptimization Details. For stability';
  assert.equal(L.joinBroken(t), t);
});

test('scanPages: page 1 links classified (github.io = project, github.com repo = code, HF = code)', () => {
  const p1 = 'Title of the paper\nProject: yufanwei.github.io/CD-LAM-project-page\n§ Code: https://github.com/AetherLabsAI/CD-LAM\nModels: https://huggingface.co/AetherLabs-AI/CD-LAM\nDownloaded from https://www.science.org on November 19, 2026\nhttps://www.youtube.com/watch?v=abc';
  const s = scan([p1, filler(10)]);
  assert.deepEqual(pick(s, 'project'), ['https://yufanwei.github.io/CD-LAM-project-page']);
  assert.deepEqual(pick(s, 'code'), ['https://github.com/AetherLabsAI/CD-LAM', 'https://huggingface.co/AetherLabs-AI/CD-LAM']);
  assert.deepEqual(pick(s, 'video'), ['https://www.youtube.com/watch?v=abc']);
  assert.ok(!s.some((x) => /science\.org/.test(x.url)), 'the publisher stamp is not a link of the paper');
  assert.equal(s[0].source, 'paper p. 1');
});

test('scanPages: the reference list is ignored, an announced link in the body is kept, a footnote to a library is not', () => {
  const body = filler(60) + '\nOur code is available at https://github.com/me/ours.\n' + filler(20)
    + '\nWe extract scenes with the PySceneDetect library,3 which splits videos into clips.\n3 https://github.com/Breakthrough/PySceneDetect\n' + filler(30);
  const s = scan(['Title\nAbstract text.', 'Intro text.', body, 'References\n' + refs, 'Appendix\nMore results.']);
  assert.deepEqual(pick(s, 'code'), ['https://github.com/me/ours']);
  assert.equal(s[0].source, 'paper p. 3');
});

test('scanPages: only this paper\'s own arXiv link, other arXiv / DOI links are citations', () => {
  const s = scan(['See https://arxiv.org/abs/2401.00001 and https://arxiv.org/abs/2505.22159v2 and https://doi.org/10.1145/1'], { arxiv: '2505.22159' });
  assert.deepEqual(s.map((x) => [x.kind, x.url]), [['arxiv', 'https://arxiv.org/abs/2505.22159v2']]);
});

test('classify: a project site named with code, data and videos; a dataset page; a bare github profile', () => {
  assert.equal(L.classify('https://t3.alanz.info', 'Data, code, and model checkpoints are opensourced at '), 'project');
  assert.equal(L.classify('https://www.after-review.com/myCode', 'Code available at: '), 'skip'); // a review placeholder
  assert.equal(L.classify('https://twistdata.github.io', 'Our collected dataset is also open-sourced at '), 'dataset');
  assert.equal(L.classify('https://github.com/leggedrobotics', ''), 'link');
  assert.equal(L.classify('https://huggingface.co/papers/2401.00001', ''), 'skip');
  assert.equal(L.classify('https://openreview.net/forum?id=x', 'Project page '), 'skip');
});

test('scanComment: arXiv comment forms', () => {
  const c = L.scanComment('Accepted to CoRL 2025. Project page: https://foo.github.io/bar. Code: github.com/foo/bar, videos at https://youtu.be/xyz');
  assert.deepEqual(c.map((x) => [x.kind, x.url]), [['project', 'https://foo.github.io/bar'], ['code', 'https://github.com/foo/bar'], ['video', 'https://youtu.be/xyz']]);
  assert.deepEqual(L.scanComment('22 pages, 10 figures. Webpage at https://lab.example.org/paper'), [{ url: 'https://lab.example.org/paper', kind: 'project', source: 'arXiv comment', keyword: true }]);
  assert.deepEqual(L.scanComment('Accepted to ICRA 2024'), []);
});

test('fromFields: arXiv DOI and url, a publisher DOI, howpublished with \\url{}', () => {
  const a = L.fromFields({ fields: { doi: '10.48550/ARXIV.2505.22159', url: 'https://arxiv.org/abs/2505.22159' } });
  assert.equal(a.arxiv, 'https://arxiv.org/abs/2505.22159'); assert.equal(a.doi, null); assert.equal(a.publisher, null);
  const b = L.fromFields({ fields: { doi: '10.1109/ICRA.2022.1', url: 'https://ieeexplore.ieee.org/document/1', howpublished: '\\url{https://github.com/a/b}' } });
  assert.equal(b.doi, 'https://doi.org/10.1109/ICRA.2022.1');
  assert.deepEqual(b.publisher, { url: 'https://ieeexplore.ieee.org/document/1', source: 'BibTeX url' });
  assert.deepEqual(b.extra, [{ url: 'https://github.com/a/b', kind: 'code', source: 'BibTeX howpublished' }]);
});

test('merge: the paper\'s own links first, the same repository once, disagreeing repositories all listed, dead marked', () => {
  const paper = [{ url: 'https://lab.org/x', kind: 'project', source: 'paper p. 2', keyword: false }, { url: 'https://x.github.io', kind: 'project', source: 'paper p. 1', keyword: true }, { url: 'https://github.com/A/x', kind: 'code', source: 'paper p. 1' }];
  const comment = [{ url: 'https://github.com/a/x.git', kind: 'code', source: 'arXiv comment' }, { url: 'https://y.github.io', kind: 'project', source: 'arXiv comment' }];
  const hf = L.fromHF({ githubRepo: 'https://github.com/other/x', projectPage: 'https://x.github.io/' });
  const m = L.merge({ fields: { arxiv: 'https://arxiv.org/abs/1', doi: null }, paper, comment, hf, reach: { 'https://github.com/other/x': { dead: true } } });
  assert.equal(m.project.url, 'https://x.github.io'); // the one the paper announces
  assert.deepEqual(m.project.also, ['Hugging Face']);
  assert.deepEqual(m.code.map((c) => [c.url, c.source, c.also || null, !!c.dead, !!c.unconfirmed]), [
    ['https://github.com/A/x', 'paper p. 1', ['arXiv comment'], false, false], ['https://github.com/other/x', 'Hugging Face', null, true, true]]);
  assert.deepEqual(m.other.map((o) => o.url), ['https://lab.org/x', 'https://y.github.io']);
  assert.equal(m.arxiv, 'https://arxiv.org/abs/1');
});

test('front matter: quotes, colons, backslashes, $math$, CJK, line breaks are valid YAML strings', () => {
  const fm = notes.frontMatter({ title: 'Say "hi": a $\\alpha$-test\nof 中文 标题', authors: ['O\'Brien, J.', 'Zhang 张'], year: 2024, empty: '', none: null, tags: [] });
  assert.equal(fm, '---\ntitle: "Say \\"hi\\": a $\\\\alpha$-test of 中文 标题"\nauthors: ["O\'Brien, J.", "Zhang 张"]\nyear: 2024\n---\n');
  // read back with a tiny YAML double-quoted reader: the same strings come out
  const unq = (s) => JSON.parse(s); // YAML double-quoted strings with \" and \\ only are JSON strings
  assert.equal(unq(fm.split('\n')[1].slice(7)), 'Say "hi": a $\\alpha$-test of 中文 标题');
});

test('plainTex / authorList: TeX accents and braces, "Last, First" names', () => {
  assert.equal(notes.plainTex('{GPU}s for Schr\\"{o}dinger \\& co: $\\mathcal{O}(n)$'), 'GPUs for Schrödinger & co: $\\mathcal{O}(n)$');
  assert.equal(notes.plainTex('\\url{x} \\v{c}'), 'x č');
  assert.deepEqual(notes.authorList('M{\\"u}ller, Hans and Jane Doe and Li, Wei'), ['Hans Müller', 'Jane Doe', 'Wei Li']);
});

test('PDF hyperlinks: a printed URL cut at "_" becomes the annotation, links behind words are found, mailto/orcid/doi dropped', () => {
  const p1 = 'ActionReasoning: a paper\nCode: https://github.com/StephenYing/Action Reasoning\nThe code and videos are available on the project website and GitHub repository.\n' + filler(30);
  const annots = [{ page: 1, url: 'https://github.com/StephenYing/Action_Reasoning' }, { page: 1, url: 'https://host-site.host-robotics.workers.dev/' },
    { page: 1, url: 'https://github.com/CGuangyan-BIT/HOST' }, { page: 1, url: 'https://orcid.org/0000-0002-5168-8648' }, { page: 1, url: 'https://doi.org/10.1145/3592433' },
    { page: 1, url: 'http://crossmark.crossref.org/dialog/?doi=10.1126' }, { page: 1, url: 'https://arxiv.org/abs/2602.21161v1' }, { page: 2, url: 'https://www.acme-robots.com/product' },
    { page: 4, url: 'https://github.com/late/page' }];
  const out = L.scanPages([p1, filler(40), filler(40), filler(40)], { own: { arxiv: '2602.21161' }, dropReferences: notes.dropReferences, annots });
  assert.deepEqual(pick(out, 'code'), ['https://github.com/StephenYing/Action_Reasoning', 'https://github.com/CGuangyan-BIT/HOST']);
  assert.equal(out.find((x) => x.url.endsWith('Action_Reasoning')).source, 'paper p. 1'); // the printed one, completed
  assert.deepEqual(pick(out, 'project'), ['https://host-site.host-robotics.workers.dev']);
  assert.deepEqual(pick(out, 'link'), ['https://www.acme-robots.com/product']); // page 2, not a project host
  assert.ok(!out.some((x) => /orcid|doi\.org|crossref|late\/page/.test(x.url)), JSON.stringify(out));
  assert.deepEqual(pick(out, 'arxiv'), ['https://arxiv.org/abs/2602.21161v1']); // its own arXiv page (with a version)
  // an annotation that goes on with "/" is another page, not the rest of the printed one
  const o2 = L.scanPages(['Project page: https://x.github.io\n' + filler(20)], { annots: [{ page: 1, url: 'https://x.github.io/other' }] });
  assert.deepEqual(pick(o2, 'project'), ['https://x.github.io', 'https://x.github.io/other']);
});

test('review placeholders of anonymized papers are no links', () => {
  const out = scan(['Code available at: www.after-review.com/myCode\nSee https://anonymous.4open.science/r/abc for the anonymized code.\n' + filler(30)]);
  assert.ok(!out.some((x) => /after-review/.test(x.url)), JSON.stringify(out));
  assert.equal(L.classify('https://www.after-review.com/myCode', 'code'), 'skip');
  assert.equal(L.classify('https://anonymous.4open.science/r/abc', 'code'), 'code');
});

test('merge: a Hugging Face repository no author source names is unconfirmed, one matching the project page is not; ENOTFOUND hosts go to other', () => {
  const hf = L.fromHF({ githubRepo: 'https://github.com/1x-technologies/1xgpt', projectPage: 'https://sites.google.com/view/genie-2024/home' });
  const a = L.merge({ paper: [{ url: 'https://sites.google.com/view/genie-2024/home', kind: 'project', source: 'paper p. 1 (link)' }], hf });
  assert.deepEqual(a.code.map((c) => [c.url, !!c.unconfirmed]), [['https://github.com/1x-technologies/1xgpt', true]]);
  const b = L.merge({ paper: [{ url: 'https://aetherlabsai.github.io/CausalWM', kind: 'project', source: 'paper p. 1' }], hf: L.fromHF({ githubRepo: 'https://github.com/AetherLabsAI/CausalWM' }) });
  assert.equal(b.code[0].unconfirmed, undefined);
  const c = L.merge({ paper: [{ url: 'https://github.com/z/sure', kind: 'code', source: 'paper p. 1' }], hf: L.fromHF({ githubRepo: 'https://github.com/q/unsure' }) });
  assert.deepEqual(c.code.map((x) => x.url), ['https://github.com/z/sure', 'https://github.com/q/unsure']);
  const d = L.merge({ paper: [{ url: 'https://www.nohost.example/code', kind: 'code', source: 'paper p. 1' }, { url: 'https://gone.example', kind: 'project', source: 'paper p. 1', keyword: true },
    { url: 'https://github.com/a/404', kind: 'code', source: 'paper p. 1' }],
  reach: { 'https://www.nohost.example/code': { dead: true, error: 'ENOTFOUND' }, 'https://gone.example': { dead: true, error: 'ENOTFOUND' }, 'https://github.com/a/404': { dead: true, status: 404 } } });
  assert.equal(d.project, null);
  assert.deepEqual(d.code.map((x) => [x.url, !!x.dead]), [['https://github.com/a/404', true]]); // a 404 stays listed, marked
  assert.deepEqual(d.other.map((x) => [x.url, x.kind, !!x.gone, !!x.dead]), [['https://www.nohost.example/code', 'code', true, true], ['https://gone.example', 'project', true, true]]);
});

test('authorList: BibTeX "and others" is no author; the byline says et al.', () => {
  assert.deepEqual(notes.authorList('Smith, John and others'), ['John Smith']);
  const h = notes.paperHeader({ id: 'abcdef0001', citekey: 'smith2020', fields: { title: 'T', author: 'Smith, John and others', year: '2020' } }, '', null, { yaml: true });
  assert.ok(/authors: \["John Smith"\]/.test(h) && /John Smith, et al\./.test(h), h);
});

test('front matter: dead and unconfirmed links stay out of project / code, dead ones listed as unreachable', () => {
  const lk = { arxiv: null, doi: null, publisher: null, project: { url: 'https://p.example', source: 'paper p. 1', dead: true },
    code: [{ url: 'https://github.com/a/ok', source: 'paper p. 1' }, { url: 'https://github.com/a/404', source: 'paper p. 1', dead: true }, { url: 'https://github.com/hf/x', source: 'Hugging Face', unconfirmed: true }], other: [] };
  const h = notes.paperHeader({ id: 'abcdef0002', citekey: 'k', fields: { title: 'T' } }, '', lk);
  const fm = h.split('---')[1];
  assert.ok(!/^project:/m.test(fm), fm);
  assert.match(fm, /^code: \["https:\/\/github.com\/a\/ok"\]$/m);
  assert.match(fm, /^unreachable: \["https:\/\/p.example", "https:\/\/github.com\/a\/404"\]$/m);
  assert.ok(h.includes('[Code](https://github.com/a/ok) · [Code 2](https://github.com/a/404) (unreachable)\n'), h);
  assert.ok(!h.includes('github.com/hf/x'), 'a repository only Hugging Face names is no part of the package: ' + h);
  assert.ok(!notes.indexLine({ id: 'abcdef0002', fields: {} }, { ...lk, code: [lk.code[2]] }).includes('hf/x'));
});

test('core.sendFile: a client that left while the zip was built still gets its scratch files removed', () => {
  let ran = 0;
  require('../lib/core').sendFile({ destroyed: true }, '/nonexistent.zip', 'application/zip', {}, () => ran++);
  assert.equal(ran, 1);
});

// ---------------------------------------------------------------- 1. hyphens of line-broken URLs
test('joinBroken keeps a hyphen at the end of the line (LaTeX \\url breaks at "-" without adding one)', () => {
  const t = 'Please visit the project website and see videos and the infrastructure at https://project-\ninstinct.github.io/hiking-in-the-wild.\nAbstract—Achieving';
  assert.equal(L.joinBroken(t), 'Please visit the project website and see videos and the infrastructure at https://project-instinct.github.io/hiking-in-the-wild.\nAbstract—Achieving');
  // also on a short line (a URL never ends with "-")
  assert.equal(L.joinBroken('Data at https://twist-\ndata.github.io.\nNext'), 'Data at https://twist-data.github.io.\nNext');
});

test('restoreHyphens: the hyphen pdftotext dropped is taken back from the -raw text and from the PDF\'s hyperlinks', () => {
  // pdftotext (not -raw) joined "project-" + "instinct" and dropped the hyphen; -raw printed it at the line end
  const text = 'Please visit the project website and see videos at https://projectinstinct.github.io/hiking-in-the-wild.\nAbstract';
  const raw = 'Please visit the project website and see videos at https://project-\ninstinct.github.io/hiking-in-the-wild.\nAbstract';
  assert.equal(L.restoreHyphens(text, raw), 'Please visit the project website and see videos at https://project-instinct.github.io/hiking-in-the-wild.\nAbstract');
  // a URL -raw prints as it is stays; one without a hyphenated twin stays
  assert.equal(L.restoreHyphens('at https://abc.github.io and https://a-b.github.io', 'at https://abc.github.io and https://a-b.github.io'), 'at https://abc.github.io and https://a-b.github.io');
  assert.equal(L.restoreHyphens('at https://abc.github.io/x', 'at https://other-site.org'), 'at https://abc.github.io/x');
  const s = L.scanPages([text + '\n' + filler(20)], { raw: [raw + '\n' + filler(20)], dropReferences: notes.dropReferences });
  assert.deepEqual(pick(s, 'project'), ['https://project-instinct.github.io/hiking-in-the-wild']);
  // without the -raw text: the hyperlink of the page that differs only by hyphens replaces the printed URL
  const a = L.scanPages([text + '\n' + filler(20)], { annots: [{ page: 1, url: 'https://project-instinct.github.io/hiking-in-the-wild' }], dropReferences: notes.dropReferences });
  assert.deepEqual(a.map((x) => [x.kind, x.url]), [['project', 'https://project-instinct.github.io/hiking-in-the-wild']]);
});

// ---------------------------------------------------------------- 2. dead project pages
test('merge: a dead project page gives way to another that answers; a dead one alone stays, marked, out of the front matter', () => {
  const paper = [{ url: 'https://projectinstinct.github.io/hiking-in-the-wild', kind: 'project', source: 'paper p. 1', keyword: true },
    { url: 'https://project-instinct.github.io/hiking-in-the-wild', kind: 'project', source: 'paper p. 1 (link)', keyword: false }];
  const m = L.merge({ paper, reach: { 'https://projectinstinct.github.io/hiking-in-the-wild': { dead: true, status: 404 } } });
  assert.equal(m.project.url, 'https://project-instinct.github.io/hiking-in-the-wild');
  assert.deepEqual(m.other.map((o) => [o.url, !!o.dead]), [['https://projectinstinct.github.io/hiking-in-the-wild', true]]);
  const d = L.merge({ paper: [{ url: 'https://nail-uh.github.io/rcra-website.github.io', kind: 'project', source: 'paper p. 1', keyword: true }], reach: { 'https://nail-uh.github.io/rcra-website.github.io': { dead: true, status: 404 } } });
  assert.equal(d.project.dead, true);
  const fm = notes.paperHeader({ id: 'abcdef0003', citekey: 'k', fields: { title: 'T' } }, '', { ...d, code: [] }).split('---')[1];
  assert.ok(!/^project:/m.test(fm) && /^unreachable: \["https:\/\/nail-uh.github.io\/rcra-website.github.io"\]$/m.test(fm), fm);
});

// ---------------------------------------------------------------- 3. code from the authors' project page
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'links', name), 'utf8');
test('project page (nerfies template): the Code button; HF data / model as other; not the related work, BibTeX, footer, script', () => {
  const anchors = L.pageAnchors(fixture('nerfies-template.html'), 'https://tonyfang.net/FoAR/');
  assert.ok(!anchors.some((a) => /script\/inside|ForceMimic|nerfies|keunhong/.test(a.url)), JSON.stringify(anchors));
  const got = L.fromPage(anchors, { project: 'https://tonyfang.net/FoAR/', title: 'FoAR: Force-Aware Reactive Policy for Contact-Rich Robotic Manipulation' });
  assert.deepEqual(got.map((x) => [x.kind, x.url]), [['code', 'https://github.com/Alan-Heoooh/FoAR'], ['dataset', 'https://huggingface.co/datasets/alan/foar-data'], ['model', 'https://huggingface.co/alan/foar-ckpt']]);
  assert.ok(got.every((x) => x.source === 'project page'));
});

test('project page: the page\'s own source repo and a repo named like the page path without "Code" are left out', () => {
  const project = 'https://project-instinct.github.io/hiking-in-the-wild';
  const got = L.fromPage(L.pageAnchors(fixture('page-source.html'), project), { project, title: 'Hiking in the Wild: A Scalable Perceptive Parkour Framework for Humanoids' });
  assert.deepEqual(got.map((x) => [x.kind, x.url]), [['code', 'https://github.com/project-instinct/InstinctLab']]);
  // the same repository named like the page path, its anchor saying "Code": accepted
  const html = '<a href="https://github.com/project-instinct/hiking-in-the-wild"><span>Code</span></a>';
  assert.deepEqual(L.fromPage(L.pageAnchors(html, project), { project }).map((x) => x.url), ['https://github.com/project-instinct/hiking-in-the-wild']);
});

test('project page: the repo named like the paper is the code, companion repos of the lab are not; deep links -> repo', () => {
  const project = 'https://ai.meta.com/vjepa/';
  const html = ['vjepa2', 'IntPhys2', 'minimal_video_pairs', 'CausalVQA'].map((r) => `<a href="https://github.com/facebookresearch/${r}"><span>Code</span></a>`).join('')
    + '<a href="https://github.com/facebookresearch/vjepa2/blob/main/README.md">GitHub</a>';
  const got = L.fromPage(L.pageAnchors(html, project), { project, title: 'V-JEPA 2: Self-Supervised Video Models Enable Understanding, Prediction and Planning' });
  assert.deepEqual(got.filter((x) => x.kind === 'code').map((x) => x.url), ['https://github.com/facebookresearch/vjepa2']);
  assert.deepEqual(got.filter((x) => x.kind === 'repo').map((x) => x.url.split('/').pop()), ['IntPhys2', 'minimal_video_pairs', 'CausalVQA']);
  // no repo named like the paper: the Code buttons stay
  const other = L.fromPage(L.pageAnchors('<a href="https://github.com/a/tool/tree/dev">Code</a>', project), { project, title: 'Something Else Entirely' });
  assert.deepEqual(other.map((x) => x.url), ['https://github.com/a/tool']);
});

test('project page: a repository named like the paper (no "code" word), relative links and baselines', () => {
  const project = 'https://lab.example.org/papers/gs/';
  const anchors = L.pageAnchors(fixture('name-match.html'), project);
  const got = L.fromPage(anchors, { project, title: '3D Gaussian Splatting for Real-Time Radiance Field Rendering' });
  assert.deepEqual(got.map((x) => x.url), ['https://github.com/graphdeco-inria/gaussian-splatting']);
  assert.ok(!anchors.some((a) => /multinerf/.test(a.url)));
  assert.equal(L.nameMatches('FoAR', 'FoAR: Force-Aware Reactive Policy'), true);
  assert.equal(L.nameMatches('DyWA-code', 'DyWA: Dynamics-adaptive World Action Model'), true);
  assert.equal(L.nameMatches('colmap', '3D Gaussian Splatting for Real-Time Radiance Field Rendering'), false);
});

test('merge: the project page confirms a Hugging Face repository; its HF models are other, not code', () => {
  const page = L.fromPage(L.pageAnchors(fixture('nerfies-template.html'), 'https://tonyfang.net/FoAR/'), { project: 'https://tonyfang.net/FoAR/', title: 'FoAR: x' });
  const m = L.merge({ paper: [{ url: 'https://tonyfang.net/FoAR/', kind: 'project', source: 'paper p. 1', keyword: true }], page, hf: L.fromHF({ githubRepo: 'https://github.com/Alan-Heoooh/FoAR' }) });
  assert.deepEqual(m.code, [{ url: 'https://github.com/Alan-Heoooh/FoAR', source: 'project page', also: ['Hugging Face'] }]);
  assert.deepEqual(m.other.map((o) => [o.kind, o.url]), [['dataset', 'https://huggingface.co/datasets/alan/foar-data'], ['model', 'https://huggingface.co/alan/foar-ckpt']]);
});

test('project page: Google Sites redirector links unwrapped, a News section left out', () => {
  const project = 'https://sites.google.com/view/forcevla2025/';
  const got = L.fromPage(L.pageAnchors(fixture('google-sites.html'), project), { project, title: 'ForceVLA: Enhancing VLA Models' });
  assert.deepEqual(got.map((x) => x.url), ['https://github.com/ft-robotic/ForceVLA/']);
});

test('project page: the repository of the paper\'s other version ("TWIST" on the TWIST2 page) is left out, the named one first', () => {
  const project = 'https://yanjieze.com/projects/TWIST2/';
  const page = '<nav><a href="https://github.com/YanjieZe/TWIST" class="navbar-code-btn"><i class="fab fa-github"></i> Code</a></nav>'
    + '<a href="https://github.com/xr/Toolkit">Code of the toolkit</a><a href="https://github.com/amazon-far/TWIST2"><i class="fab fa-github"></i> Code (Fully Open-Sourced)</a>';
  const got = L.fromPage(L.pageAnchors(page, project), { project, title: 'TWIST2: Scalable, Portable, and Holistic Humanoid Data Collection System' });
  assert.deepEqual(got.map((x) => x.url), ['https://github.com/amazon-far/TWIST2', 'https://github.com/xr/Toolkit']);
});

test('merge: a file of a repository and the repository itself are one repository (the repository URL kept)', () => {
  const m = L.merge({ page: [{ url: 'https://github.com/project-instinct/InstinctLab/blob/main/tasks/parkour/README.md', kind: 'code', source: 'project page' }],
    hf: L.fromHF({ githubRepo: 'https://github.com/project-instinct/InstinctLab' }) });
  assert.deepEqual(m.code, [{ url: 'https://github.com/project-instinct/InstinctLab', source: 'project page', also: ['Hugging Face'] }]);
});

// ---------------------------------------------------------------- 4. Hugging Face only: not in the package
test('merge: a Hugging Face repository is confirmed by the owner of the authors\' <owner>.github.io, not by its name alone', () => {
  const p = [{ url: 'https://someone.github.io/CausalWM', kind: 'project', source: 'paper p. 1' }];
  assert.equal(L.merge({ paper: p, hf: L.fromHF({ githubRepo: 'https://github.com/thirdparty/CausalWM' }) }).code[0].unconfirmed, true);
  assert.equal(L.merge({ paper: p, hf: L.fromHF({ githubRepo: 'https://github.com/Someone/CausalWM' }) }).code[0].unconfirmed, undefined);
});

// ---------------------------------------------------------------- links() with a stub network
async function withNet(routes, fn) {
  const realFetch = global.fetch, dnsP = require('node:dns').promises, realLookup = dnsP.lookup;
  global.fetch = async (url, opts = {}) => {
    for (const [re, h] of routes) if (re.test(String(url))) return h(String(url), opts);
    return new Response('', { status: 404 });
  };
  dnsP.lookup = async (host, o) => (o && o.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 });
  try { return await fn(); } finally { global.fetch = realFetch; dnsP.lookup = realLookup; }
}
const atom = (comment) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/2601.07718v1</id><title>T</title>${comment ? `<arxiv:comment>${comment}</arxiv:comment>` : ''}</entry></feed>`;
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
function seed(item, paper) { // the scan of a paper's text, as links() caches it (an item without a PDF)
  const file = path.join(L.DIR, item.id + '.json');
  return L.links(item).then(() => { const c = JSON.parse(fs.readFileSync(file, 'utf8')); c.paper = paper; fs.writeFileSync(file, JSON.stringify(c)); });
}
const atests = [];
const atest = (name, fn) => atests.push([name, fn]);

atest('links(): the project page is checked while arXiv is still slow - a 404 is marked dead within the budget', async () => {
  const item = { id: 'abcdef0101', citekey: 'a', fields: { title: 'RCRA', eprint: '2610.25419' } };
  await seed(item, [{ url: 'https://rcra-website.github.io', kind: 'project', source: 'paper p. 1', page: 1, keyword: true }]);
  const r = await withNet([
    [/export\.arxiv\.org/, () => new Promise((ok) => setTimeout(() => ok(new Response(atom(''), { status: 200 })), 2500))],
    [/rcra-website\.github\.io/, () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } })],
  ], () => L.links(item, { network: true, budget: 1200 }));
  assert.equal(r.checked, null, 'arXiv had not answered yet');
  assert.equal(r.project.dead, true, JSON.stringify(r));
  const fm = notes.paperHeader(item, '', r).split('---')[1];
  assert.ok(!/^project:/m.test(fm) && /^unreachable: \["https:\/\/rcra-website.github.io"\]$/m.test(fm), fm);
  await new Promise((ok) => setTimeout(ok, 1500)); // let the arXiv answer land
});

atest('links(): the project page is read once (GET) for its code; HF repo confirmed by it, a third-party HF repo is not', async () => {
  const item = { id: 'abcdef0102', citekey: 'b', fields: { title: 'FoAR: Force-Aware Reactive Policy for Contact-Rich Robotic Manipulation', eprint: '2411.15753' } };
  await seed(item, [{ url: 'https://tonyfang.net/FoAR', kind: 'project', source: 'paper p. 1', page: 1, keyword: true }]);
  let gets = 0;
  const routes = [
    [/export\.arxiv\.org/, () => new Response(atom(''), { status: 200 })],
    [/huggingface\.co\/api\/papers/, () => new Response(JSON.stringify({ githubRepo: 'https://github.com/Alan-Heoooh/FoAR' }), { status: 200, headers: { 'content-type': 'application/json' } })],
    [/tonyfang\.net\/FoAR$/, (u, o) => { assert.equal(o.method, 'GET'); gets++; return new Response(null, { status: 301, headers: { location: 'https://tonyfang.net/FoAR/' } }); }],
    [/tonyfang\.net\/FoAR\/$/, () => html(fixture('nerfies-template.html'))],
    [/github\.com|huggingface\.co\//, () => new Response('', { status: 200 })],
  ];
  const r = await withNet(routes, () => L.links(item, { network: true, budget: 5000 }));
  assert.deepEqual(r.code.map((c) => [c.url, c.source, c.also || null, !!c.unconfirmed]), [['https://github.com/Alan-Heoooh/FoAR', 'project page', ['Hugging Face'], false]]);
  assert.ok(r.other.some((o) => o.kind === 'model' && o.url === 'https://huggingface.co/alan/foar-ckpt'), JSON.stringify(r.other));
  assert.equal(gets, 1);
  const c = JSON.parse(fs.readFileSync(path.join(L.DIR, item.id + '.json'), 'utf8'));
  assert.equal(c.page.for, 'https://tonyfang.net/FoAR'); assert.ok(!/<html|<a /i.test(JSON.stringify(c.page)), 'only the links are kept');
  await withNet(routes, () => L.links(item, { network: true, budget: 5000 })); // cached: not read again
  assert.equal(gets, 1);
  // Genie: Hugging Face names a third-party repository, the project page does not -> unconfirmed, no part of the package
  const g = { id: 'abcdef0103', citekey: 'g', fields: { title: 'Genie: Generative Interactive Environments', eprint: '2402.15391' } };
  await seed(g, [{ url: 'https://sites.google.com/view/genie-2024/home', kind: 'project', source: 'paper p. 1 (link)', page: 1, keyword: false }]);
  const r2 = await withNet([
    [/export\.arxiv\.org/, () => new Response(atom(''), { status: 200 })],
    [/huggingface\.co\/api\/papers/, () => new Response(JSON.stringify({ githubRepo: 'https://github.com/1x-technologies/1xgpt' }), { status: 200 })],
    [/sites\.google\.com/, () => html('<h1>Genie</h1><a href="https://www.youtube.com/watch?v=x">Video</a>')],
    [/github\.com/, () => new Response('', { status: 200 })],
  ], () => L.links(g, { network: true, budget: 5000 }));
  assert.deepEqual(r2.code.map((x) => [x.url, !!x.unconfirmed]), [['https://github.com/1x-technologies/1xgpt', true]]);
  const h = notes.paperHeader(g, '', r2);
  assert.ok(!h.includes('1xgpt'), h);
  assert.ok(!notes.indexLine(g, r2).includes('1xgpt'));
});

atest('fetchPage: a page that only moved (meta refresh) is followed', async () => {
  const r = await withNet([
    [/yanjieze\.com\/TWIST2$/, () => html(fixture('moved.html'))],
    [/yanjieze\.com\/projects\/TWIST2\/$/, () => html('<a href="https://github.com/amazon-far/TWIST2" class="button"><i class="fab fa-github"></i> Code</a>')],
  ], () => L.fetchPage('https://yanjieze.com/TWIST2'));
  assert.deepEqual(r.page.anchors.map((a) => a.url), ['https://github.com/amazon-far/TWIST2']);
  assert.equal(r.page.for, 'https://yanjieze.com/TWIST2');
});

atest('fetchPage: not HTML, too large, a redirect to a local address', async () => {
  const r = await withNet([[/a\.example\.org/, () => new Response('%PDF-', { status: 200, headers: { 'content-type': 'application/pdf' } })]], () => L.fetchPage('https://a.example.org/x'));
  assert.deepEqual([r.reach.dead, r.page.error, r.page.anchors.length], [false, 'not HTML', 0]);
  const big = '<a href="https://github.com/a/code">Code</a>' + 'x'.repeat(3 * 1024 * 1024) + '<a href="https://github.com/a/late">Code</a>';
  const b = await withNet([[/b\.example\.org/, () => html(big)]], () => L.fetchPage('https://b.example.org'));
  assert.deepEqual(b.page.anchors.map((a) => a.url), ['https://github.com/a/code']);
  const realLookup = require('node:dns').promises.lookup;
  const c = await withNet([[/c\.example\.org/, () => new Response(null, { status: 302, headers: { location: 'http://intranet.example.org/' } })]], async () => {
    require('node:dns').promises.lookup = async (host, o) => (/intranet/.test(host) ? [{ address: '192.168.1.2', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    return L.fetchPage('https://c.example.org');
  });
  require('node:dns').promises.lookup = realLookup;
  assert.equal(c.page.error, 'not a public address');
});

(async () => {
  for (const [name, fn] of atests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 10).join('\n     ')); }
  }
  fs.rmSync(process.env.RT_WORKSPACE, { recursive: true, force: true });
  if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
  console.log('\nall link tests passed');
})();
