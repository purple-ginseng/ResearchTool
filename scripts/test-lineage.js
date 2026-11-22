#!/usr/bin/env node
// Tests for the pure parts of the Lineage feature: lib/lineage.js (counting prior / derivative works, set exclusion,
// ranking ties, id matching, dates, the relevance ranking) and public/js/lineage.js (lanes, time scale, timeline layout,
// filters, add to project, titles and authors as text), and of B3-B9 (the closest stored set, custom sets, Semantic
// Scholar intents, badges, ancestry, BibTeX and the grouped export, similar works). No network.
//   Run:  node scripts/test-lineage.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lintest-'));
process.env.RT_WORKSPACE = WS; // lib/core creates its folders there
const L = require('../lib/lineage');
const T = require(path.join(__dirname, '../public/js/lineage.js'));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 8).join('\n     ')); }
}
const sizes = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.size]));

// ---------------------------------------------------------------- reference keys
test('refKeys: OpenAlex ids, Semantic Scholar DOIs mapped to OpenAlex ids, arXiv as arXiv DOI, titles', () => {
  const rec = { refs: ['W1', 'W2', 'W1', 'bogus'], s2: [['10.1/A', '', 'Paper A', 2020], ['', '2101.00001', 'An arXiv paper', 2021], ['', '', 'A reference without any identifier', 2019], ['', '', 'short', 2019], ['10.5/b', '', 'B', 2018]] };
  const keys = L.refKeys(rec, { '10.5/b': { w: 'W9' }, '10.1/a': { w: '' } });
  assert.deepEqual(keys, ['W1', 'W2', 'doi:10.1/a', 'doi:10.48550/arxiv.2101.00001', 't:areferencewithoutanyidentifier', 'W9']);
  assert.deepEqual(L.refKeys(null), []);
});

// ---------------------------------------------------------------- prior works
const set = [
  { id: 'a', keys: ['W1', 'W2', 'W3', 'W3', 'Wa'] }, // Wa = paper a itself (cites its own preprint)
  { id: 'b', keys: ['W1', 'W2', 'Wa'] },
  { id: 'c', keys: ['W1', 'W4'] },
];
test('countPrior: how many set papers cite each work, each paper once', () => {
  const c = L.countPrior(set);
  assert.deepEqual(sizes(c), { W1: 3, W2: 2, W3: 1, Wa: 2, W4: 1 });
  assert.deepEqual([...c.get('W2')].sort(), ['a', 'b']);
});
test('countPrior: the set itself is excluded', () => {
  const c = L.countPrior(set, (k) => k === 'Wa');
  assert.equal(c.has('Wa'), false);
  assert.equal(c.get('W1').size, 3);
});
test('mergeCounts: a DOI key and an OpenAlex id of the same work become one entry (union of citers)', () => {
  const c = L.countPrior([{ id: 'a', keys: ['W5'] }, { id: 'b', keys: ['doi:10.1/x'] }, { id: 'c', keys: ['W5', 'doi:10.1/x'] }]);
  const m = L.mergeCounts(c, [['W5', 'doi:10.1/x'], ['W404', 'W405']]);
  assert.deepEqual(sizes(m), { W5: 3 });
});
test('rank: count, then citations, then the older work, then the key', () => {
  const r = L.rank([
    { key: 'x', count: 2, cited: 10, year: 2020 },
    { key: 'y', count: 3, cited: 1, year: 2021 },
    { key: 'z', count: 2, cited: 10, year: 2018 },
    { key: 'b', count: 2, cited: 50, year: 2022 },
    { key: 'a', count: 2, cited: 10, year: 2018 },
    { key: 'n', count: 2, cited: null, year: 2010 },
  ]);
  assert.deepEqual(r.map((e) => e.key), ['y', 'b', 'a', 'z', 'x', 'n']);
});

// ---------------------------------------------------------------- derivative works
test('countDerivative: distinct set papers cited (aliases of one paper count once), threshold, exclusion, order', () => {
  const setW = new Map([['W1', 'a'], ['W1b', 'a'], ['W2', 'b'], ['W3', 'c']]);
  const citing = [
    { w: 'D1', title: 'cites a twice under two ids', refs: ['W1', 'W1b', 'W9'], cited: 5 },
    { w: 'D2', title: 'cites a and b', refs: ['W1', 'W2'], cited: 1 },
    { w: 'D3', title: 'cites all three', refs: ['W3', 'W2', 'W1'], cited: 0 },
    { w: 'D2', title: 'duplicate page', refs: ['W1', 'W2', 'W3'], cited: 1 },
    { w: 'W3', title: 'set paper c itself', refs: ['W1', 'W2'], cited: 9 },
    { w: 'D4', title: 'cites b and c', refs: ['W2', 'W3'], cited: 7 },
  ];
  const d = L.countDerivative(citing, setW, { min: 2, isSelf: (c) => c.w === 'W3' });
  assert.deepEqual(d.map((e) => [e.w, e.count]), [['D3', 3], ['D4', 2], ['D2', 2]]);
  assert.deepEqual(d[0].cites.sort(), ['a', 'b', 'c']);
  const one = L.countDerivative(citing, new Map([['W1', 'a']]), { min: 1 });
  assert.deepEqual(one.map((e) => e.w), ['W3', 'D1', 'D2', 'D3']);
});

// ---------------------------------------------------------------- matching library papers
test('matcher: OpenAlex id, alias, DOI, arXiv id (as id or arXiv DOI), title; learned aliases', () => {
  const m = L.matcher([
    { id: 'p1', w: 'W10', aliases: ['W11'], doi: '10.1109/ICRA.2024.1', arxiv: '2401.00001', title: 'Diffusion Policy for Humanoids' },
    { id: 'p2', w: '', doi: '', arxiv: '2402.00002', title: 'A world model for legged robots' },
    { id: 'p3', title: 'Short' },
  ]);
  assert.equal(m({ w: 'W10' }), 'p1');
  assert.equal(m({ w: 'W11' }), 'p1');
  assert.equal(m({ doi: '10.1109/icra.2024.1' }), 'p1');
  assert.equal(m({ doi: '10.48550/arXiv.2402.00002' }), 'p2');
  assert.equal(m({ arxiv: '2402.00002' }), 'p2');
  assert.equal(m({ title: 'A World Model for Legged Robots.' }), 'p2');
  assert.equal(m({ title: 'short' }), null); // titles under 12 characters never match
  assert.equal(m({ w: 'W99' }), null);
  assert.equal(m.key('doi:10.48550/arxiv.2401.00001'), 'p1');
  assert.equal(m.key('t:aworldmodelforleggedrobots'), 'p2');
  m.alias('W99', 'p2');
  assert.equal(m({ w: 'W99' }), 'p2');
  m.alias('W10', 'p2'); // a known id is never taken over
  assert.equal(m({ w: 'W10' }), 'p1');
});

// ---------------------------------------------------------------- dates, works, scope
test('firstDate: OpenAlex date inside the arXiv month wins, else the earliest, else the BibTeX year', () => {
  assert.deepEqual(L.firstDate({ arxiv: '2606.18772', oaDates: ['2026-06-21', '2026-09-03'], year: '2026' }), { date: '2026-06-21', approx: false });
  assert.deepEqual(L.firstDate({ arxiv: '2606.18772', oaDates: ['2026-09-03'] }), { date: '2026-06-01', approx: true });
  assert.deepEqual(L.firstDate({ year: '2021', month: 'mar' }), { date: '2021-03-01', approx: true });
  assert.deepEqual(L.firstDate({ year: '2021' }), { date: '2021-07-01', approx: true });
  assert.deepEqual(L.firstDate({}), { date: '', approx: true });
  assert.deepEqual(L.firstDate({ arxiv: '2610.40539', year: '2026' }), { date: '2026-10-01', approx: true }); // a bare year never wins over the arXiv month
});
test('workOf: id, arXiv id from the DOI or the location, last author, venue', () => {
  const w = L.workOf({
    id: 'https://openalex.org/W123', doi: 'https://doi.org/10.48550/arxiv.2303.04137', title: 'Diffusion <i>Policy</i>', publication_year: 2023, publication_date: '2023-03-07', cited_by_count: 812,
    authorships: [{ author_position: 'first', author: { display_name: 'Cheng Chi' } }, { author_position: 'middle', author: { display_name: 'B' } }, { author_position: 'last', author: { display_name: 'Shuran Song' } }],
    primary_location: { source: { display_name: 'arXiv (Cornell University)' } },
  });
  assert.equal(w.w, 'W123'); assert.equal(w.arxiv, '2303.04137'); assert.equal(w.doi, ''); assert.equal(w.title, 'Diffusion Policy');
  assert.equal(w.last, 'Shuran Song'); assert.equal(w.venue, 'arXiv'); assert.equal(w.cited, 812); assert.equal(w.date, '2023-03-07');
  const p = L.workOf({ id: 'W5', doi: 'https://doi.org/10.1126/scirobotics.abc', title: 'X', locations: [{ landing_page_url: 'https://arxiv.org/abs/2010.11251v2' }] });
  assert.equal(p.arxiv, '2010.11251'); assert.equal(p.doi, '10.1126/scirobotics.abc');
  assert.equal(L.workOf({ id: 'nope' }), null);
  assert.equal(L.refOf({ arxiv: '2303.04137', doi: '10.1/x' }), 'arXiv:2303.04137');
  assert.equal(L.refOf({ doi: '10.1/x' }), 'doi:10.1/x');
});
test('abstractOf: the inverted index back to text', () => {
  assert.equal(L.abstractOf({ world: [1], Hello: [0], again: [3], ',': [2] }), 'Hello world , again');
  assert.equal(L.abstractOf(null), '');
});
test('resolveScope: a research line includes its sub-lines; unknown ids are dropped', () => {
  const items = [
    { id: 'a', category: 'Humanoid / Locomotion' }, { id: 'b', category: 'Humanoid / Manipulation' },
    { id: 'c', category: 'Humanoid' }, { id: 'd', category: 'Humanoids Elsewhere' }, { id: 'e', fields: { title: 'One' } },
  ];
  assert.deepEqual(L.resolveScope({ scope: 'category', category: 'Humanoid' }, items).ids, ['a', 'b', 'c']);
  assert.deepEqual(L.resolveScope({ scope: 'category', category: 'Humanoid / Locomotion' }, items).ids, ['a']);
  assert.deepEqual(L.resolveScope({ scope: 'category', category: 'Uncategorized' }, items).ids, ['e']);
  assert.deepEqual(L.resolveScope({ scope: 'ids', ids: ['a', 'zz', 'a'] }, items).ids, ['a']);
  assert.equal(L.resolveScope({ scope: 'paper', id: 'e' }, items).focus, 'e');
  assert.equal(L.resolveScope({}, items).ids.length, 5);
  assert.throws(() => L.resolveScope({ scope: 'category', category: 'Nope' }, items), /No paper/);
  assert.throws(() => L.resolveScope({ scope: 'weird' }, items), /scope must be/);
  assert.equal(L.setKey('ids', 'x', ['b', 'a']), L.setKey('ids', 'x', ['a', 'b']));
  assert.notEqual(L.setKey('ids', 'x', ['a']), L.setKey('ids', 'x', ['a', 'b']));
});

// ---------------------------------------------------------------- timeline (public/js/lineage.js)
test('shortName: the name before the colon, else the first words', () => {
  assert.equal(T.shortName('PhysVLMM: Interaction-Conditioned Physical Belief Maps'), 'PhysVLMM');
  assert.equal(T.shortName('Learning to walk in minutes using massively parallel deep RL'), 'Learning to walk in');
  assert.equal(T.shortName('Short title'), 'Short title');
});
test('laneOrder: a line and its sub-lines together, biggest line first, the line itself before its sub-lines, Uncategorized last', () => {
  const p = (c) => ({ category: c });
  const lanes = T.laneOrder([p('VLA'), p('Humanoid / Manipulation'), p('Humanoid / Locomotion'), p('Humanoid / Locomotion'), p('Humanoid'), p('Uncategorized'), p('Uncategorized'), p('Uncategorized'), p('VLA'), p('MoCap & Human Motion')]);
  assert.deepEqual(lanes.map((l) => l.name), ['Humanoid', 'Humanoid / Locomotion', 'Humanoid / Manipulation', 'VLA', 'MoCap & Human Motion', 'Uncategorized']);
  assert.deepEqual(lanes.map((l) => l.first), [true, false, false, true, true, true]);
  assert.equal(lanes[1].sub, 'Locomotion'); assert.equal(lanes[1].line, 'Humanoid'); assert.equal(lanes[1].lineCount, 4);
});
test('timeScale: time mode is linear and ticks years; even mode spaces papers one step apart', () => {
  const s = T.timeScale(['2024-01-01', '2025-01-01'], { mode: 'time', pxPerDay: 1, pad: 10 });
  assert.equal(Math.round(s.x('2025-01-01') - s.x('2024-01-01')), 366);
  assert.ok(s.ticks.some((t) => t.major && t.label === '2025'));
  const e = T.timeScale(['2026-06-01', '2020-01-01', '2026-06-01', '2026-07-03'], { mode: 'even', step: 20, pad: 0 });
  assert.deepEqual(['2020-01-01', '2026-06-01', '2026-07-03'].map(e.x), [0, 20, 40]);
  assert.deepEqual(e.ticks.filter((t) => t.major).map((t) => [t.label, t.x]), [['2020', 0], ['2026', 20]]);
  assert.equal(T.timeScale([], {}).ticks.length, 0);
});
test('layout: no two nodes of a lane overlap; rows only when needed; lanes stack', () => {
  const lanes = [{ name: 'A' }, { name: 'B' }];
  const nodes = [
    { id: 1, lane: 'A', x: 0, w: 100 }, { id: 2, lane: 'A', x: 50, w: 100 }, { id: 3, lane: 'A', x: 120, w: 50 },
    { id: 4, lane: 'A', x: 108, w: 10 }, { id: 5, lane: 'B', x: 0, w: 10 }, { id: 6, lane: 'C', x: 0, w: 10 },
  ];
  const r = T.layout(nodes, lanes, { rowH: 20, lanePad: 5, gap: 8, top: 10 });
  assert.deepEqual([1, 2, 3, 4].map((id) => r.pos[id].row), [0, 1, 2, 0]); // 4 fits after 1 exactly at the gap, so 3 no longer does
  for (const a of nodes) for (const b of nodes) {
    if (a.id >= b.id || a.lane !== b.lane || r.pos[a.id].row !== r.pos[b.id].row) continue;
    const [l, rr] = a.x <= b.x ? [a, b] : [b, a];
    assert.ok(l.x + l.w + 8 <= rr.x, `nodes ${a.id} and ${b.id} overlap`);
  }
  assert.deepEqual(r.lanes.map((l) => [l.name, l.top, l.rows, l.height]), [['A', 10, 3, 70], ['B', 80, 1, 30], ['C', 110, 1, 30]]);
  assert.equal(r.height, 140);
  assert.equal(r.pos[5].y, 80 + 5 + 10);
});
test('layout: 112 papers in 10 lanes stay deterministic and within their lanes', () => {
  const nodes = [];
  for (let i = 0; i < 112; i++) nodes.push({ id: 'p' + i, lane: 'L' + (i % 10), x: (i * 37) % 900, w: 90 });
  const lanes = Array.from({ length: 10 }, (_, i) => ({ name: 'L' + i }));
  const a = T.layout(nodes, lanes), b = T.layout(nodes.slice().reverse(), lanes);
  assert.deepEqual(a.pos, b.pos);
  for (const n of nodes) { const ln = a.lanes.find((l) => l.name === n.lane); assert.ok(a.pos[n.id].y > ln.top && a.pos[n.id].y < ln.top + ln.height); }
});

// ---------------------------------------------------------------- review fixes
test('workOf: one author is the last author; a truncated list names no last author', () => {
  assert.equal(L.workOf({ id: 'W1', title: 'Rectified Flow', authorships: [{ author: { display_name: 'Qiang Liu' }, author_position: 'first' }] }).last, 'Qiang Liu');
  assert.equal(L.workOf({ id: 'W2', title: 'GPT-4', is_authors_truncated: true, authorships: [{ author: { display_name: 'A' }, author_position: 'first' }, { author: { display_name: 'Shawn Jain' }, author_position: 'middle' }] }).last, '');
});
test('bogus: a journal resolved as a work, front matter', () => {
  assert.equal(L.bogus({ title: 'COMPUTER GRAPHICS forum', venue: 'Computer Graphics Forum', authors: [] }), true);
  assert.equal(L.bogus({ title: 'Front matter', type: 'paratext', authors: ['X'] }), true);
  assert.equal(L.bogus({ title: '3D Gaussian Splatting', venue: 'ACM TOG', authors: ['Kerbl'] }), false);
});
test('countDerivative: bibliographic coupling breaks ties of the count', () => {
  const setW = new Map([['W1', 'a']]);
  const citing = [{ w: 'Wx', refs: ['W1', 'W9'], cited: 500 }, { w: 'Wy', refs: ['W1', 'W7', 'W8'], cited: 10 }];
  const d = L.countDerivative(citing, setW, { min: 1, coupleWith: new Set(['W7', 'W8', 'W1']) });
  assert.deepEqual(d.map((x) => [x.w, x.coupling]), [['Wy', 2], ['Wx', 0]]);
});
test('citesOf / edgesOf: arrows from the cached records with the matcher as it is now (aliases learned later count)', () => {
  const lib = [{ id: 'a', w: 'Wa', rec: { refs: ['W100'], s2: [] } }, { id: 'b', w: 'Wb', rec: { refs: [], s2: [] } }];
  const m = L.matcher(lib);
  assert.deepEqual(L.edgesOf(new Set(['a', 'b']), new Map(lib.map((p) => [p.id, p])), m, {}), []);
  m.alias('W100', 'b'); // the published copy of b, learned after the first look
  assert.deepEqual(L.edgesOf(new Set(['a', 'b']), new Map(lib.map((p) => [p.id, p])), m, {}), [['a', 'b']]);
});
test('nodeLabel: the name before a colon, else "Surname Year", else words with an ellipsis', () => {
  assert.equal(T.nodeLabel('RMA: Rapid Motor Adaptation for Legged Robots'), 'RMA');
  assert.equal(T.nodeLabel('Proximal Policy Optimization Algorithms', { first: 'John Schulman', year: 2017 }, 16), 'Schulman 2017');
  assert.equal(T.nodeLabel('Opening the Sim-to-Real Door for Humanoid Pixel-to-Action', {}), 'Opening the…');
  assert.equal(T.bibFirst('Kumar, Ashish and Fu, Zipeng'), 'Kumar');
});
test('timeScale: a focus squeezes the older dates into the first leftW pixels', () => {
  const s = T.timeScale(['2018-01-01', '2025-01-01', '2026-01-01'], { mode: 'time', pxPerDay: 1, pad: 0, focus: '2025-01-01', leftW: 100 });
  assert.ok(s.x('2018-01-01') >= 0 && s.x('2018-01-01') < 5);
  assert.ok(s.x('2024-12-01') <= 100);
  assert.ok(Math.abs(s.x('2026-01-01') - s.x('2025-01-01') - 365) < 1);
  assert.ok(s.ticks.filter((t) => t.x < 100).every((t) => t.major)); // only years in the squeezed part
});

// ---------------------------------------------------------------- B1: relevance that damps hub papers
test('hubDamp: a work cited 60,000 times counts about a quarter, one cited 300 times almost fully', () => {
  assert.equal(L.hubDamp(0), 1);
  assert.ok(Math.abs(L.hubDamp(60000) - 0.24) < 0.01);
  assert.ok(L.hubDamp(300) > 0.9);
  assert.ok(L.hubDamp(1000) > L.hubDamp(10000));
});
test('libraryCount: the papers of the whole library citing a work under any of its keys (OpenAlex id, DOI, arXiv DOI, title)', () => {
  const citers = new Map([['W1', new Set(['a', 'b'])], ['doi:10.48550/arxiv.2406.09246', new Set(['c'])], ['t:openvlaanopensourcevisionlanguageactionmodel', new Set(['d', 'a'])]]);
  const e = { key: 'W1', w: 'W1', arxiv: '2406.09246', title: 'OpenVLA: An Open-Source Vision-Language-Action Model', citers: ['x'], count: 1 };
  assert.deepEqual(L.workKeys(e), ['W1', 'doi:10.48550/arxiv.2406.09246', 't:openvlaanopensourcevisionlanguageactionmodel']);
  assert.equal(L.libraryCount(e, citers), 5); // a, b, c, d and the set paper x
});
test('isGeneric: over 30k citations; or a backbone / optimizer / benchmark cited by >= 60 % of a set of 5+', () => {
  assert.equal(L.isGeneric({ title: 'GPT-4 Technical Report', cited: 56107, count: 1 }, 1), true);
  assert.equal(L.isGeneric({ title: 'DistilBERT, a distilled version of BERT', cited: 13675, count: 1 }, 1), false); // one paper: the share rule does not apply
  assert.equal(L.isGeneric({ title: 'Adam: A Method for Stochastic Optimization', cited: 20000, count: 7 }, 10), true);
  assert.equal(L.isGeneric({ title: 'Adam: A Method for Stochastic Optimization', cited: 20000, count: 3 }, 10), false);
  assert.equal(L.isGeneric({ title: 'Deep Residual Learning for Image Recognition', cited: 290606, count: 6 }, 112), true);
  assert.equal(L.isGeneric({ title: 'Attention Is All You Need', cited: 151914, count: 5 }, 112), true);
  assert.equal(L.isGeneric({ title: 'DROID: A Large-Scale In-The-Wild Robot Manipulation Dataset', cited: 1248, count: 8 }, 10), false);
});
// pi0-like: every count is 1, so before this the global citation count decided the order
const pi0Rows = [
  ['Learning Transferable Visual Models From Natural Language Supervision', 61485, 11], ['GPT-4 Technical Report', 56107, 5],
  ['Highly accurate protein structure prediction with AlphaFold', 51213, 1], ['High-Resolution Image Synthesis with Latent Diffusion Models', 37162, 5],
  ['Training Language Models to Follow Instructions with Human Feedback', 19904, 1], ['DistilBERT, a distilled version of BERT: smaller, faster, cheaper and lighter', 13675, 1],
  ['Gemini: A Family of Highly Capable Multimodal Models', 12494, 2], ['Scalable Diffusion Models with Transformers', 9405, 10],
  ['Outrageously Large Neural Networks', 6977, 4], ['Emergent Abilities of Large Language Models', 6535, 1],
  ['OpenVLA: An Open-Source Vision-Language-Action Model', 4231, 29], ['PaLM-E: An Embodied Multimodal Language Model', 4144, 9],
  ['RT-2: Vision-Language-Action Models Transfer Web Knowledge to Robotic Control', 3495, 17], ['Learning Fine-Grained Bimanual Manipulation with Low-Cost Hardware', 3074, 18],
  ['Octo: An Open-Source Generalist Robot Policy', 1425, 11], ['DROID: A Large-Scale In-The-Wild Robot Manipulation Dataset', 1248, 11],
  ['Open X-Embodiment: Robotic Learning Datasets and RT-X Models', 1055, 7], ['BridgeData V2: A Dataset for Robot Learning at Scale', 981, 11],
  ['Fast Transformer Decoding: One Write-Head is All You Need', 1006, 1], ['Movie Gen: A Cast of Media Foundation Models', 756, 1],
].map(([title, cited, lib], i) => ({ key: 'W' + (100 + i), w: 'W' + (100 + i), title, cited, count: 1, citers: ['pi0'], lib }));
const pi0Citers = new Map(pi0Rows.map((e) => [e.w, new Set(['pi0', ...Array.from({ length: e.lib - 1 }, (_, k) => 'p' + k)])]));
test('priorRelevance (pi0-like, one paper): robot-learning works the library keeps citing rise, hubs sink; the reason is in words', () => {
  const ranked = L.rankRows(pi0Rows, 'prior', { setSize: 1, citers: pi0Citers });
  const top10 = ranked.filter((e) => !e.generic).slice(0, 10).map((e) => e.title);
  const robot = /VLA|Vision-Language-Action|RT-2|Bimanual|Octo|DROID|X-Embodiment|BridgeData|PaLM-E/;
  assert.ok(top10.filter((t) => robot.test(t)).length >= 6, top10.join(' | '));
  for (const t of ['GPT-4', 'AlphaFold']) assert.ok(ranked.find((e) => e.title.includes(t)).generic, t);
  const visible = ranked.filter((e) => !e.generic);
  assert.ok(visible.findIndex((e) => e.title.includes('DistilBERT')) >= 12);
  const ovla = ranked.find((e) => e.title.startsWith('OpenVLA'));
  assert.equal(ovla.libCount, 29);
  assert.match(ovla.why, /Cited by this paper and by 28 more papers of your library \(29 in all\)/);
  assert.match(ranked.find((e) => e.title.startsWith('GPT-4')).why, /Generic: cited over 30,000 times/);
  for (const e of ranked) assert.match(e.why, /Relevance \d/);
});
test('rankRows: the non-generic TOP in relevance order, the generic ones kept for "show"', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ key: 'W' + i, w: 'W' + i, title: 'Work ' + i, count: 1 + (i % 5), cited: i < 3 ? 50000 : 100 * i, citers: [] }));
  const r = L.rankRows(rows, 'prior', { setSize: 10, citers: new Map() });
  assert.equal(r.filter((e) => !e.generic).length, L.TOP);
  assert.equal(r.filter((e) => e.generic).length, 3);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].relevance >= r[i].relevance);
});
test('priorRelevance: a field outside the main fields of the set counts 60 %', () => {
  const rows = [{ count: 5, field: 'Computer Science' }, { count: 3, field: 'Engineering' }];
  const f = L.mainFields(rows);
  assert.deepEqual([...f], ['Computer Science', 'Engineering']);
  const a = L.priorRelevance({ title: 'x', count: 2, cited: 100, citers: [], field: 'Computer Science' }, { setSize: 5, fields: f });
  const b = L.priorRelevance({ title: 'y', count: 2, cited: 100, citers: [], field: 'Biochemistry, Genetics and Molecular Biology' }, { setSize: 5, fields: f });
  assert.ok(Math.abs(b.relevance / a.relevance - 0.6) < 1e-9);
  assert.match(b.why, /outside the main fields/);
  assert.equal(L.mainFields([{ count: 1, field: 'A' }]).size, 0); // too little known: no field rule
});
test('derivRelevance: the set papers cited first, then the Salton coupling; "shares N refs" in words', () => {
  assert.equal(L.salton(12, 48, 300), 12 / Math.sqrt(48 * 300));
  assert.equal(L.salton(0, 10, 10), 0);
  const a = L.derivRelevance({ count: 1, coupling: 20, nrefs: 60, cited: 10 }, { setSize: 1, setRefs: 3000 });
  const b = L.derivRelevance({ count: 1, coupling: 2, nrefs: 60, cited: 900 }, { setSize: 1, setRefs: 3000 });
  const c = L.derivRelevance({ count: 2, coupling: 0, nrefs: 60, cited: 0 }, { setSize: 3, setRefs: 3000 });
  assert.ok(a.relevance > b.relevance && c.relevance > a.relevance);
  assert.match(a.why, /Shares 20 references/);
});
test('workOf: the field (primary topic), the venue type and an open PDF come with the same answer', () => {
  const m = L.workOf({ id: 'https://openalex.org/W5', title: 'T', primary_topic: { field: { display_name: 'Computer Science' } }, primary_location: { source: { display_name: 'ICRA', type: 'conference' } }, open_access: { is_oa: true, oa_url: 'https://x/y.pdf' } });
  assert.equal(m.field, 'Computer Science'); assert.equal(m.vtype, 'conference'); assert.equal(m.oa, true);
  assert.equal(L.workOf({ id: 'W6', title: 'T' }).oa, false);
});

// ---------------------------------------------------------------- B2: filters (pure, public/js/lineage.js)
test('venueType and isSurvey', () => {
  assert.equal(T.venueType({ venue: 'arXiv' }), 'preprint');
  assert.equal(T.venueType({ venue: '', arxiv: '2401.00001' }), 'preprint');
  assert.equal(T.venueType({ venue: 'Robotics: Science and Systems' }), 'conference');
  assert.equal(T.venueType({ venue: 'IEEE Robotics and Automation Letters' }), 'journal');
  assert.equal(T.venueType({ venue: 'Some Venue', vtype: 'conference' }), 'conference');
  assert.equal(T.isSurvey({ title: 'A Survey on Vision-Language-Action Models' }), true);
  assert.equal(T.isSurvey({ title: 'X', type: 'review' }), true);
  assert.equal(T.isSurvey({ title: 'X', nrefs: 200 }), true);
  assert.equal(T.isSurvey({ title: 'OpenVLA' }), false);
});
test('filterRows: year range, not in library / project, surveys, venue type, open PDF, hide generic', () => {
  const rows = [
    { year: 2022, inLibrary: 'a', title: 'A survey of robot learning', venue: 'arXiv', arxiv: '1', generic: false },
    { year: 2024, inLibrary: null, title: 'B', venue: 'CoRL', generic: false },
    { year: 2025, inLibrary: 'c', title: 'C', venue: 'Nature', oa: true, generic: false },
    { year: 2026, inLibrary: null, title: 'D', venue: 'ICRA', generic: true },
  ].map((e, i) => ({ e, i }));
  const f = (o) => T.filterRows(rows, { ...T.FILTERS0, ...o }, { inProject: (e) => e.inLibrary === 'c' }).map((r) => r.e.title);
  assert.deepEqual(f({}), ['A survey of robot learning', 'B', 'C']);
  assert.deepEqual(f({ hideGeneric: false }), ['A survey of robot learning', 'B', 'C', 'D']);
  assert.deepEqual(f({ from: '2023', to: '2026' }), ['B', 'C']);
  assert.deepEqual(f({ from: '2023', to: '2026', notProj: true }), ['B']);
  assert.deepEqual(f({ notLib: true, hideGeneric: false }), ['B', 'D']);
  assert.deepEqual(f({ survey: 'only' }), ['A survey of robot learning']);
  assert.deepEqual(f({ survey: 'hide' }), ['B', 'C']);
  assert.deepEqual(f({ vtype: 'conference', hideGeneric: false }), ['B', 'D']);
  assert.deepEqual(f({ oa: true }), ['A survey of robot learning', 'C']);
});

// ---------------------------------------------------------------- A: add to project (pure parts)
test('splitForProject: in the library (not yet in the project), to import, skipped (no DOI / arXiv), already members', () => {
  const x = T.splitForProject([{ e: { inLibrary: 'a' } }, { e: { inLibrary: 'b' } }, { e: { ref: 'arXiv:1' } }, { e: {} }], (id) => id === 'b');
  assert.equal(x.inLib.length, 1); assert.equal(x.inLib[0].e.inLibrary, 'a');
  assert.equal(x.importable.length, 1); assert.equal(x.skipped.length, 1); assert.equal(x.already, 1);
});
test('projectTarget: picked here > the scope project > remembered > working; only existing projects; never changes the working one', () => {
  const ex = (p) => p !== 'gone';
  assert.equal(T.projectTarget({ scopePid: 'P', stored: 'S', working: 'W' }, ex), 'P');
  assert.equal(T.projectTarget({ picked: 'X', scopePid: 'P', stored: 'S', working: 'W' }, ex), 'X');
  assert.equal(T.projectTarget({ stored: 'gone', working: 'W' }, ex), 'W');
  assert.equal(T.projectTarget({ stored: 'S', working: 'W' }, ex), 'S');
  assert.equal(T.projectTarget({}, ex), null);
});

// ---------------------------------------------------------------- B5: titles and authors as text
test('texPlain: no "$" or "\\{" left in a title; subscripts as Unicode where they exist', () => {
  assert.equal(T.texPlain('$π_0$: A Vision-Language-Action Flow Model for General Robot Control'), 'π₀: A Vision-Language-Action Flow Model for General Robot Control');
  assert.equal(T.texPlain('$π_{0.5}$: a Vision-Language-Action Model'), 'π0.5: a Vision-Language-Action Model');
  assert.equal(T.texPlain('$\\pi_0$ and {VLA} \\{x\\} \\& more'), 'π₀ and VLA x & more');
  for (const t of ['$π^{*}_{0.6}$: a VLA That Learns From Experience', '{$\\alpha$}-Flow', 'x $10^{3}$ y']) assert.ok(!/[$]|\\\{/.test(T.texPlain(t)), T.texPlain(t));
  assert.equal(T.texPlain('Plain title'), 'Plain title');
});
test('authors: braces stripped, "Last, First" turned round, organisations kept whole', () => {
  assert.equal(T.authorName('Black, Kevin'), 'Kevin Black');
  assert.equal(T.authorName('{EngineAI}'), 'EngineAI');
  assert.equal(T.authorName('{:}'), '');
  assert.equal(T.authorsShort('Intelligence, Physical and Black, Kevin and Brown, Noah'), 'Physical Intelligence et al.');
  assert.equal(T.bibFirst('Intelligence, Physical and Black, Kevin'), 'Physical Intelligence');
  assert.equal(T.bibFirst('Robotics, Archon and {:} and Wang, Caojun'), 'Archon Robotics');
  assert.equal(T.authorsShort('{EngineAI}'), 'EngineAI');
  assert.equal(T.authorsShort('Kumar, Ashish and Fu, Zipeng'), 'Kumar & Fu');
  assert.equal(T.nodeLabel('A long title without any colon in it at all', { first: 'Physical Intelligence', year: 2025 }, 26), 'Physical Intelligence 2025');
  assert.equal(T.nodeLabel('A long title without any colon in it at all', { first: 'Kevin Black', year: 2024 }, 16), 'Black 2024');
});

// ---------------------------------------------------------------- B3: the closest stored set, the custom set
test('closestSet: same kind and label, >= 90 % overlap, the newest; a hand-made set matches by its ids alone', () => {
  const ids = Array.from({ length: 112 }, (_, i) => 'p' + i);
  const entries = [
    ['old', { kind: 'library', label: '', ids: ids.slice(0, 112), computed: '2026-11-20T00:00:00Z' }],
    ['older', { kind: 'library', label: '', ids: ids.slice(0, 112), computed: '2026-11-01T00:00:00Z' }],
    ['cat', { kind: 'category', label: 'VLA', ids: ids.slice(0, 112), computed: '2026-11-21T00:00:00Z' }],
    ['small', { kind: 'library', label: '', ids: ids.slice(0, 50), computed: '2026-11-21T00:00:00Z' }],
  ];
  const near = L.closestSet(entries, { kind: 'library', label: '', ids: [...ids, 'new1'] });
  assert.equal(near.key, 'old');
  assert.deepEqual(near.added, ['new1']);
  assert.deepEqual(near.removed, []);
  assert.ok(near.overlap > 0.99);
  assert.equal(L.closestSet(entries, { kind: 'library', label: '', ids: ids.slice(0, 80) }), null); // 80 / 112 < 0.9
  assert.equal(L.closestSet(entries, { kind: 'category', label: 'World Models', ids }), null); // another line
  assert.equal(L.closestSet([['x', { kind: 'ids', label: 'My VLA', ids: ids.slice(0, 20), computed: 'a' }]], { kind: 'ids', label: 'My VLA − 1', ids: ids.slice(0, 19) }).key, 'x');
  assert.equal(L.keyLabel({ kind: 'paper', focus: 'id1', label: 'T' }), 'id1');
  assert.equal(L.keyLabel({ kind: 'library', label: 'The whole library' }), '');
});
test('customIds: a line takes its sub-lines; words must all be in title, tags or category', () => {
  const items = [
    { id: 'a', category: 'VLA / Continual', fields: { title: 'Continual VLA' } },
    { id: 'b', category: 'VLA', fields: { title: 'OpenVLA' } },
    { id: 'c', category: 'World Models', fields: { title: 'A world model for VLA policies' }, tags: ['video'] },
    { id: 'd', category: 'Humanoid / Locomotion', fields: { title: 'Walking' } },
  ];
  assert.deepEqual(T.customIds(items, { lines: ['VLA'] }), ['a', 'b']);
  assert.deepEqual(T.customIds(items, { lines: ['VLA / Continual'] }), ['a']);
  assert.deepEqual(T.customIds(items, { lines: ['Humanoid / Locomotion'], q: 'vla' }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(T.customIds(items, { q: 'vla video' }), ['c']);
  assert.deepEqual(T.customIds(items, {}), []);
});

// ---------------------------------------------------------------- B4: Semantic Scholar intents and contexts
test('parseS2Refs / contextOf / intentSummary: intents, influence and sentences per reference', () => {
  const j = { data: [
    { isInfluential: true, intents: ['methodology', 'background', 'bogus'], contexts: ['We build on the flow matching policy of [12], which ...', 'short'], citedPaper: { externalIds: { ArXiv: '2410.24164' }, title: 'pi0: A Vision-Language-Action Flow Model', year: 2024 } },
    { isInfluential: false, intents: [], contexts: [], citedPaper: { externalIds: { DOI: '10.1000/adam' }, title: 'Adam', year: 2014 } },
    { isInfluential: false, intents: ['background'], contexts: ['As in RT-2 [3], the model is co-fine-tuned on web data and robot data.'], citedPaper: { externalIds: {}, title: 'RT-2: Vision-Language-Action Models Transfer Web Knowledge', year: 2023 } },
  ] };
  const { s2, cx } = L.parseS2Refs(j);
  assert.equal(s2.length, 3);
  assert.equal(cx.length, 2); // Adam: nothing to say
  assert.deepEqual(cx[0].slice(2, 4), [1, ['methodology', 'background']]);
  assert.equal(cx[0][4].length, 1); // the 'short' context is dropped
  const pi0 = { key: 'W1', w: 'W1', arxiv: '2410.24164', title: 'pi0: A Vision-Language-Action Flow Model', citers: ['a', 'b', 'c'] };
  assert.deepEqual(L.contextOf(cx, L.workKeys(pi0)).intents, ['methodology', 'background']);
  const rt2 = { key: 'W2', title: 'RT-2: Vision-Language-Action Models Transfer Web Knowledge' }; // matched by its title
  assert.equal(L.contextOf(cx, L.workKeys(rt2)).influential, false);
  // a: method + influential, b: known but says nothing of it, c: contexts unknown
  const per = { a: { refs: cx }, b: { refs: [] } };
  const sum = L.intentSummary(pi0, (id) => per[id] || null);
  assert.deepEqual(sum, { methods: 1, influential: 1, known: 1, weighted: 1 + 1 + 0.5 + 1 + 1 }); // b gives no intents at all: not known
});

// ---------------------------------------------------------------- B7: recent / rising
test('badgesOf and recentCites: Seminal, Recent, Rising', () => {
  const now = Date.parse('2026-11-21');
  assert.deepEqual(T.badgesOf({ year: 2017, cited: 9000, c2: 3000 }, now), ['Seminal']);
  assert.deepEqual(T.badgesOf({ year: 2026, date: '2026-03-01', cited: 40, c2: 40 }, now), ['Recent', 'Rising']);
  assert.deepEqual(T.badgesOf({ year: 2024, date: '2024-01-10', cited: 300, c2: 250 }, now), ['Rising']);
  assert.deepEqual(T.badgesOf({ year: 2024, cited: 300, c2: null }, now), []);
  assert.equal(L.recentCites([{ year: 2026, cited_by_count: 5 }, { year: 2025, cited_by_count: 7 }, { year: 2024, cited_by_count: 100 }], 2026), 12);
  assert.equal(L.monthsAgo(18, new Date('2026-11-21T00:00:00Z')), '2025-05-21');
  assert.equal(L.workOf({ id: 'W5', title: 'T', counts_by_year: [{ year: new Date().getUTCFullYear(), cited_by_count: 3 }] }).c2, 3);
});

// ---------------------------------------------------------------- B6: ancestry
test('ancestry: top k non-generic prior works cited by >= 2, citers per lane, dominant ancestor, burst', () => {
  const now = Date.parse('2026-11-21');
  const papers = [
    { id: 'a', category: 'H / Loco', date: '2026-06-01' }, { id: 'b', category: 'H / Loco', date: '2026-08-01' },
    { id: 'c', category: 'H / Manip', date: '2024-01-01' }, { id: 'd', category: 'H / Manip', date: '2023-01-01' },
  ];
  const prior = [
    { key: 'G', title: 'Adam', count: 4, citers: ['a', 'b', 'c', 'd'], generic: true },
    { key: 'S', title: 'SONIC', count: 3, citers: ['a', 'b', 'c'], relevance: 3 },
    { key: 'B', title: 'BeyondMimic', count: 3, citers: ['b', 'c', 'd'], relevance: 2 },
    { key: 'O', title: 'Once', count: 1, citers: ['d'] },
  ];
  const A = T.ancestry(papers, prior, { now });
  assert.deepEqual(A.anc.map((a) => a.e.key), ['S', 'B']); // generic and single-citer works left out; ties by relevance
  assert.deepEqual([...A.anc[0].lanes].map(([l, ids]) => [l, ids.length]), [['H / Loco', 2], ['H / Manip', 1]]);
  assert.equal(A.anc[0].citers.length, prior[1].count); // the bundle widths add up to "Cited by N"
  assert.equal(A.anc[0].burst, true);  // a, b of a, b, c are from the last 12 months
  assert.equal(A.anc[1].burst, false);
  assert.equal(A.dominant.get('a'), 0); assert.equal(A.dominant.get('d'), 1); assert.equal(A.dominant.has('x'), false);
  assert.equal(T.ancestry(papers, prior, { k: 1 }).anc.length, 1);
});

// ---------------------------------------------------------------- B8: BibTeX, grouped export
test('bibEntry: acronyms protected, arXiv-only as @misc with eprint, organisations braced, a DOI with a venue', () => {
  const b = T.bibEntry({ title: 'OpenVLA: An Open-Source Vision-Language-Action Model', authors: ['Moo Jin Kim', 'Physical Intelligence'], year: 2024, arxiv: '2406.09246', venue: 'arXiv' }, { key: 'kim2024openvla', note: 'Prior work' });
  assert.match(b, /^@misc\{kim2024openvla,/);
  assert.match(b, /title = \{\{OpenVLA\}: An/);
  assert.match(b, /eprint = \{2406\.09246\}/);
  assert.match(b, /archiveprefix = \{arXiv\}/);
  assert.match(b, /author = \{Moo Jin Kim and \{Physical Intelligence\}\}/);
  assert.doesNotMatch(b, /journal|booktitle/);
  const c = T.bibEntry({ title: 'RT-2 and 50% of $x$_y', authors: ['A B'], year: 2023, doi: '10.1/x', venue: 'Conference on Robot Learning' }, { key: 'k' });
  assert.match(c, /^@inproceedings\{k,/);
  assert.match(c, /booktitle = \{Conference on Robot Learning\}/);
  assert.match(c, /\{RT-2\} and 50\\% of \\\$x\\\$\\_y/);
  assert.equal(T.protectTitle('Learning to walk in minutes'), 'Learning to walk in minutes');
  assert.equal(T.protectTitle('Diffusion Policy: Visuomotor (DROID) x'), 'Diffusion Policy: Visuomotor ({DROID}) x');
  const used = new Set();
  assert.equal(T.citeKey({ authors: ['Moo Jin Kim'], year: 2024, title: 'OpenVLA: An Open-Source' }, used), 'kim2024openvla');
  assert.equal(T.citeKey({ authors: ['Moo Jin Kim'], year: 2024, title: 'OpenVLA again' }, used), 'kim2024openvlaa');
});
test('groupedRows / bulletList: Foundational, Recent, Surveys; each work once', () => {
  const now = Date.parse('2026-11-21');
  const d = {
    prior: [{ key: 'P1', w: 'W1', title: 'RT-2', authors: ['A Brohan', 'B C', 'D E'], year: 2023, count: 5, citers: ['a'], relevance: 4 }, { key: 'G', title: 'Adam', generic: true, year: 2014, count: 9, citers: [] }, { key: 'S', w: 'W3', title: 'A survey of robot learning', year: 2024, count: 2, citers: ['a'] }],
    derivative: [{ key: 'D1', w: 'W4', title: 'New VLA', authors: ['X Y'], year: 2026, count: 2, cites: ['a', 'b'], relevance: 2.5 }, { key: 'D0', w: 'W5', title: 'Old one', year: 2022, count: 3, cites: ['a'] }],
    similar: [{ key: 'W4', w: 'W4', title: 'New VLA', year: 2026, cocited: 3 }],
  };
  const g = T.groupedRows(d, { now });
  assert.deepEqual(g.map(([n, l]) => [n, l.map((e) => e.key)]), [['Foundational', ['P1']], ['Recent', ['D1']], ['Surveys', ['S']]]);
  const text = T.bulletList(g, 12);
  assert.match(text, /^Foundational\n- RT-2 \(Brohan et al\., 2023\) - cited by 5 of these 12 papers\n/);
  assert.match(text, /- New VLA \(Y, 2026\) - cites 2 of these papers/);
});

// ---------------------------------------------------------------- B9: similar works
test('similarCandidates / similarRelevance: co-cited works and coupled citers, the set and its prior works left out', () => {
  const setW = new Map([['Wa', 'a'], ['Wb', 'b']]);
  const ownRefs = new Set(['R1', 'R2', 'R3', 'R4']); // the set cites these: prior works, not similar
  const citing = [
    { w: 'C1', refs: ['Wa', 'X', 'R1', 'R2', 'R3'] },
    { w: 'C2', refs: ['Wa', 'Wb', 'X', 'Y'] },
    { w: 'C3', refs: ['Wb', 'X', 'Y', 'R1'] },
    { w: 'C1', refs: ['Wa', 'X'] },          // seen once
    { w: 'C4', refs: ['Q'] },                // cites no set paper: ignored
  ];
  const r = L.similarCandidates(citing, { setW, ownRefs, listed: new Set(['C2', 'Y']) });
  assert.equal(r.nCiting, 4);
  assert.deepEqual([...r.cocited].map(([k, v]) => [k, v.n, [...v.via].sort()]), [['X', 3, ['a', 'b']]]); // Y is listed already
  assert.deepEqual(r.coupled.map((c) => [c.w, c.shared]), [['C1', 3]]); // C2 is a derivative work, C3 shares 1
  const hub = L.similarRelevance({ cocited: 30, cited: 200000 }, { setSize: 5, nCiting: 1000, setRefs: 500 });
  const niche = L.similarRelevance({ cocited: 10, cited: 150 }, { setSize: 5, nCiting: 1000, setRefs: 500 });
  assert.ok(niche.relevance > hub.relevance, 'a hub co-cited with everything sinks');
  assert.match(niche.why, /Co-cited with these papers: 10 of the 1,000 works/);
  const ranked = L.rankRows([{ key: 'A', cocited: 2, cited: 10, count: 2 }, { key: 'B', shared: 12, nrefs: 40, cocited: 0, count: 0, cites: ['a'] }], 'similar', { setSize: 2, nCiting: 100, setRefs: 300 });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((e) => e.generic === false && e.why));
});


// ---------------------------------------------------------------- review fixes
test('s2Keys / cleanTitle / mergeDupRows: a preprint and its published copy are one row', () => {
  assert.deepEqual(L.s2Keys(['10.1109/icra57147.2024.10611477', '2310.08864', 'Open X-Embodiment', 2024]), ['doi:10.1109/icra57147.2024.10611477', 'doi:10.48550/arxiv.2310.08864']);
  assert.deepEqual(L.s2Keys(['', '2310.08864', 'x', 2023]), ['doi:10.48550/arxiv.2310.08864']);
  assert.deepEqual(L.refKeys({ s2: [['10.1/icra', '2310.08864', 'Open X-Embodiment: Robotic Learning Datasets and RT-X Models', 2024]] }, { '10.48550/arxiv.2310.08864': { w: 'W1' } }), ['doi:10.1/icra', 'W1']);
  assert.equal(L.cleanTitle('Open X-Embodiment: Robotic Learning Datasets and RT-X Models : Open X-Embodiment Collaboration <sup>0</sup>'), 'Open X-Embodiment: Robotic Learning Datasets and RT-X Models');
  assert.equal(L.cleanTitle('Open X-Embodiment: Robotic Learning Datasets and RT-X Models : Open X-Embodiment Collaboration 0'), 'Open X-Embodiment: Robotic Learning Datasets and RT-X Models');
  assert.equal(L.cleanTitle('RT-2: Vision-Language-Action Models'), 'RT-2: Vision-Language-Action Models');
  const rows = [
    { key: 'W1', w: 'W1', title: 'Open X-Embodiment: Robotic Learning Datasets and RT-X Models', arxiv: '2310.08864', doi: '', venue: 'arXiv', cited: 900, count: 2, citers: ['a', 'b'] },
    { key: 'W9', w: 'W9', title: 'Other work on robots and things', count: 2, citers: ['a', 'c'] },
    { key: 'W2', w: 'W2', title: 'Open X-Embodiment: Robotic Learning Datasets and RT-X Models : Open X-Embodiment Collaboration 0', doi: '10.1109/icra57147.2024.10611477', venue: 'ICRA', cited: 300, count: 2, citers: ['b', 'c'] },
  ];
  const m = L.mergeDupRows(rows, 'citers');
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].citers.sort(), ['a', 'b', 'c']);
  assert.equal(m[0].count, 3);
  assert.equal(m[0].doi, '10.1109/icra57147.2024.10611477');
  assert.equal(m[0].venue, 'ICRA');
  assert.ok(L.workKeys(m[0]).includes('W2'));
  assert.equal(rows[0].count, 2); // the input is left as it was
});
test('firstDate: an OpenAlex 1 January is a placeholder - the arXiv month of that year wins', () => {
  assert.deepEqual(L.firstDate({ arxiv: '2506.22242', oaDates: ['2025-01-01'] }), { date: '2025-06-01', approx: true });
  assert.deepEqual(L.firstDate({ oaDates: ['2024-01-01'] }), { date: '2024-01-01', approx: true });
  assert.deepEqual(L.firstDate({ arxiv: '2501.15830', oaDates: ['2025-01-01', '2025-01-27'] }), { date: '2025-01-27', approx: false });
  assert.deepEqual(L.firstDate({ oaDates: ['2024-01-01'], year: '2024', month: 'oct' }), { date: '2024-10-01', approx: true });
});
test('priorRelevance: in a set of several papers the rest of the library weighs at most half the set count', () => {
  const sonic = L.priorRelevance({ title: 'SONIC', count: 2, cited: 50, citers: ['a', 'b'], key: 'K1' }, { setSize: 12, citers: new Map([['K1', new Set(Array.from({ length: 26 }, (_, i) => 'x' + i))]]) });
  const flam = L.priorRelevance({ title: 'RoboFlamingo', count: 4, cited: 300, citers: ['a', 'b', 'c', 'd'], key: 'K2' }, { setSize: 12, citers: new Map() });
  assert.ok(flam.relevance > sonic.relevance, `${flam.relevance} > ${sonic.relevance}`);
  assert.match(sonic.why, /at most half/);
});
test('derivRelevance: a survey counts half; Similar: a citer below the cutoff says so', () => {
  const sv = L.derivRelevance({ title: 'World models for robot learning: a survey', count: 6, nrefs: 120, coupling: 10, cited: 40 }, { setSize: 113, setRefs: 3000 });
  const me = L.derivRelevance({ title: 'TacDyn-WAM', count: 4, nrefs: 50, coupling: 10, cited: 10 }, { setSize: 113, setRefs: 3000 });
  assert.ok(me.relevance > sv.relevance);
  assert.match(sv.why, /survey/);
  assert.match(L.similarRelevance({ shared: 5, nrefs: 40, cites: ['a', 'b'] }, { setSize: 12, nCiting: 100, setRefs: 500 }).why, /below the cutoff/);
  assert.match(L.similarRelevance({ cocited: 5, cited: 100 }, { setSize: 12, nCiting: 100, setRefs: 500 }).why, /concurrent/);
});
test('citeKey: organisations by their first word, title words with digits', () => {
  assert.equal(T.citeKey({ authors: ['Octo Model Team'], year: 2024, title: 'Octo: An Open-Source Generalist Robot Policy' }), 'octo2024octo');
  assert.equal(T.citeKey({ authors: ['Tairan He'], year: 2024, title: 'OmniH2O: Universal and Dexterous' }), 'he2024omnih2o');
  assert.equal(T.citeKey({ authors: [], year: 2025, title: 'AgiBot World Colosseo' }), 'anon2025agibot');
});
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(WS + '-backups', { recursive: true, force: true });
if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nall lineage tests passed');
