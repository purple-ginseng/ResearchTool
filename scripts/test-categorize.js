#!/usr/bin/env node
// Tests for the research-line grouping of lib/categorize.js: "Line / Sub-line" names, colours shared by a line and its
// sub-lines (and the same in public/js/categories.js), the evidence read from a paper's own text, the prompts, the
// sub-line rule and the line summary. Pure: a throw-away workspace, no server, no claude call, no network.
// Run:  node scripts/test-categorize.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RT_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cat-test-'));
const cat = require('../lib/categorize');
const core = require('../lib/core');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

// ---------- names ----------
t('line and sub-line of a name', () => {
  assert.equal(cat.lineOf('Humanoid / Locomotion'), 'Humanoid');
  assert.equal(cat.subOf('Humanoid / Locomotion'), 'Locomotion');
  assert.equal(cat.lineOf('World Models'), 'World Models');
  assert.equal(cat.subOf('World Models'), '');
  assert.equal(cat.subOf('Humanoid / Teleoperation & Data'), 'Teleoperation & Data');
});
t('joinLevels normalises separators and keeps two levels', () => {
  assert.equal(cat.joinLevels('Humanoid  /Locomotion'), 'Humanoid / Locomotion');
  assert.equal(cat.joinLevels('Humanoid > Manipulation'), 'Humanoid / Manipulation');
  assert.equal(cat.joinLevels('A / B / C'), 'A / B: C');                  // a third level joins the sub-line
  assert.equal(cat.joinLevels('Humanoid / '), 'Humanoid');
  assert.equal(cat.joinLevels('Sim2Real I/O'), 'Sim2Real I/O');              // a slash inside a word stays
  assert.equal(cat.joinLevels('Humanoid/Locomotion'), 'Humanoid/Locomotion');  // ... for a name typed by the user
  assert.equal(cat.joinLevels('Humanoid/Locomotion', { lines: ['humanoid'] }), 'Humanoid / Locomotion'); // a known line splits
  assert.equal(cat.joinLevels('Sim/Real Transfer', { lines: ['Humanoid'] }), 'Sim/Real Transfer');           // ... others stay one name
  assert.equal(cat.claudeLineName('Visuo/Tactile Manipulation', ['VLA', 'Humanoid']), 'Visuo/Tactile Manipulation');
  assert.equal(cat.claudeLineName('Humanoid Robotics / Locomotion / Sim-to-Real', []), 'Humanoid Robotics / Locomotion: Sim-to-Real');
  assert.equal(cat.cleanCategory(' Humanoid /  Locomotion '), 'Humanoid / Locomotion');
});
t('Claude names: catch-all sub-lines are dropped, catch-all lines refused', () => {
  assert.equal(cat.claudeLineName('"Humanoid / Other"'), 'Humanoid');
  assert.equal(cat.claudeLineName('VLA / Misc'), 'VLA');
  assert.equal(cat.claudeLineName('Humanoid/Manipulation.'), 'Humanoid / Manipulation');
  assert.throws(() => cat.claudeLineName('Misc / Things'));
  assert.throws(() => cat.claudeLineName(''));
});

// ---------- colours ----------
const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
t('a line and its sub-lines share a hue family', () => {
  const base = cat.colorOf('Humanoid');
  for (const sub of ['Locomotion', 'Manipulation', 'Teleoperation & Data', 'Perception']) {
    const c = cat.colorOf('Humanoid / ' + sub);
    assert.match(c, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(hue(c) - hue(base)) < 4, `${sub}: ${c} vs ${base}`);
  }
  assert.equal(cat.colorOf('World Models'), cat.colorOf('World Models')); // stable
  assert.ok(cat.PALETTE.includes(cat.colorOf('World Models')));           // plain names keep the palette colours
  assert.equal(cat.colorOf(cat.UNCAT), '#9aa0a6');
});
t('the browser computes the same colours (public/js/categories.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/categories.js'), 'utf8');
  const body = src.slice(src.indexOf('/* colour:begin'), src.indexOf('/* colour:end */'));
  const pal = src.match(/const PALETTE = (\[[^\]]+\]);/)[1];
  const fn = new Function('UNCAT', `const PALETTE = ${pal}; const SEP = ' / ';
    const lineOf = (name) => { const s = String(name); const i = s.indexOf(SEP); return i > 0 ? s.slice(0, i) : s; };
    const subOf = (name) => { const s = String(name); const i = s.indexOf(SEP); return i > 0 ? s.slice(i + SEP.length) : ''; };
    ${body}; return colorMap;`)(cat.UNCAT);
  const names = ['VLA', 'World Models', 'Humanoid / Locomotion', 'Humanoid / Manipulation', 'MoCap & Human Motion', '具身智能 / 灵巧手', 'Humanoid Robotics / A', 'Humanoid Robotics / B', cat.UNCAT];
  assert.deepEqual([...fn(names)], [...cat.colorMap(names)]);
});
t('colorMap: distinct sub-line shades; a line with sub-lines has a hue of its own', () => {
  const subs = ['Dexterous Manipulation', 'Foundation Models & VLA', 'Loco-Manipulation', 'Perception & Navigation', 'Teleoperation & Human Data', 'Whole-Body Control', 'Locomotion'];
  const names = [...subs.map((x) => 'Humanoid Robotics / ' + x), 'Articulated Object Manipulation', 'Continual RL', 'Learning from Human Video', 'Non-Prehensile Manipulation', 'World Models', 'VLA', 'MoCap', 'Legged', 'Tactile', 'SLAM', '3DGS'];
  const m = cat.colorMap(names);
  const sc = subs.map((x) => m.get('Humanoid Robotics / ' + x));
  assert.equal(new Set(sc).size, sc.length, sc.join(' '));
  const lineHue = cat.colorMap(['Humanoid Robotics', ...names]).get('Humanoid Robotics');
  for (const n of names.filter((x) => !x.includes(' / '))) assert.notEqual(m.get(n), lineHue, n);
  assert.equal(cat.colorOf('Humanoid Robotics / Locomotion', names), m.get('Humanoid Robotics / Locomotion'));
});
t('cleanCategory with the library: the line in its existing spelling, "Line/Sub" split at a known line', () => {
  const lib = [{ category: 'Humanoid Robotics / Whole-Body Control' }, { category: 'Humanoid Robotics / Locomotion' }, { category: 'VLA' }];
  assert.equal(cat.cleanCategory('humanoid robotics / Navigation', lib), 'Humanoid Robotics / Navigation');
  assert.equal(cat.cleanCategory('Humanoid Robotics/Whole-Body Control', lib), 'Humanoid Robotics / Whole-Body Control');
  assert.equal(cat.cleanCategory('vla', lib), 'VLA');
  assert.equal(cat.cleanCategory('Humanoid/Locomotion', lib), 'Humanoid/Locomotion'); // no line "Humanoid" yet
});

// ---------- evidence from the paper's own text ----------
const PAGES = [
  `WEVO: World Model-Enabled VLA Optimization\nAbstract. We present WEVO.\n1 Introduction\nOur policy builds on OpenVLA and is fine-tuned from π0 on humanoid data. We adopt DreamerV3 as the world model.\nFigure 1. We use Adam.\n`,
  `2 Related Work\nA. Vision-Language-Action Models\nRT-2 and OpenVLA map images to actions.\nB. World Models for Control\nDreamer learns latent dynamics.\nHumanoid Loco-Manipulation. Recent humanoid systems use whole-body control.\n3 Preliminaries\nWe consider a partially observable Markov decision process with observations o_t and actions a_t. The world model predicts the next latent.\n4 Method\nWe build on OpenVLA again.\n`,
  `References\n[1] Brohan et al. RT-2 builds on PaLI-X.\n`,
];
t('paperEvidence: builds-on names, preliminaries and related-work topics', () => {
  const e = cat.paperEvidence(PAGES, { title: 'WEVO: World Model-Enabled VLA Optimization' });
  assert.ok(e.length <= cat.EVIDENCE_MAX, e);
  assert.match(e, /^builds on: OpenVLA, /);       // most named first
  assert.match(e, /π0/); assert.match(e, /DreamerV3/);
  assert.doesNotMatch(e, /WEVO/);                 // its own name
  assert.doesNotMatch(e, /\bAdam\b/);             // not a method it builds on
  assert.doesNotMatch(e, /PaLI-X/);               // the references are not read
  assert.match(e, /preliminaries: The world model predicts the next latent\./); // the MDP boilerplate sentence is skipped
  assert.match(e, /related work: Vision-Language-Action Models · World Models for Control · Humanoid Loco-Manipulation/);
});
t('paperEvidence: nothing to go on', () => {
  assert.equal(cat.paperEvidence([]), '');
  assert.equal(cat.paperEvidence(['Just a short note with no sections.']), '');
  const long = cat.paperEvidence(['1 Introduction\n' + 'We build on ' + Array.from({ length: 40 }, (_, i) => `Model${i}X`).join(', ') + '.\n2 Related Work\n' + Array.from({ length: 9 }, (_, i) => `A. Topic Number ${i} Of Many Words`).join('\n')]);
  assert.ok(long.length <= cat.EVIDENCE_MAX);
});
t('paperEvidence: datasets, tools, robots and the paper\'s own name variants are not methods; names de-duplicated', () => {
  const page = '1 Introduction\nOur policy builds on OpenVLA, ImageNet-1K and PyTorch. It is based on TraceVLA-Phi3 and ImageNet1K. ' +
    'We fine-tune Qwen3-VL-2B and Qwen3-VL2B on a TurtleBot with a VL53L8 sensor in MuJoCo, based on VLM and ONNX.\n';
  const e = cat.paperEvidence([page], { title: 'TraceVLA: Visual Trace Prompting' });
  assert.match(e, /^builds on: /);
  for (const bad of ['ImageNet', 'PyTorch', 'TraceVLA', 'TurtleBot', 'VL53L8', 'MuJoCo', 'VLM', 'ONNX']) assert.doesNotMatch(e, new RegExp('\\b' + bad), bad);
  assert.match(e, /OpenVLA/);
  assert.equal((e.match(/Qwen3/g) || []).length, 1, e);
  const pi = cat.paperEvidence(['1 Introduction\nWe build on π0 and PaliGemma.\n'], { title: '$\\pi_0$: A Vision-Language-Action Flow Model' });
  assert.doesNotMatch(pi, /π0/, pi);
});
t('paperEvidence: math / table / figure sentences skipped; Related Work ends at the method; prose-only Related Work', () => {
  const page = '2 Preliminaries\nphi = q, sgn q, q, 1 x = y.\nTable 2 Success Rate (%) OpenVLA 32.8% vs 40.1%.\nDiffusion policies model the action distribution with a denoising process.\n3 Method\n';
  assert.match(cat.paperEvidence([page]), /preliminaries: Diffusion policies model the action distribution/);
  const rw = '2 Related Work\nLocomotion has been learned with world models and with model-free RL in many settings. More text follows here.\n3 Method\n3.1 Model Architecture\nWe use a transformer.\n';
  const e = cat.paperEvidence([rw]);
  assert.match(e, /related work: Locomotion has been learned with world models/);
  assert.doesNotMatch(e, /Model Architecture/);
  const sub = '2 Related Work\n2.1 Humanoid Control\nText.\n2.2 World Models\nText.\n3 Approach\n3.1 Planning with Latent Dynamics\nText.\nFuture work\n';
  const s = cat.paperEvidence([sub]);
  assert.match(s, /related work: Humanoid Control · World Models$/);
});

// ---------- preferred lines (Settings) ----------
t('preferred lines: default, own list, cleaning', () => {
  const names = cat.preferredLines().map((l) => l.name);
  for (const want of ['VLA', 'World Models', 'Humanoid / Locomotion', 'Humanoid / Manipulation', 'Humanoid / Teleoperation & Data', 'MoCap & Human Motion', 'Legged Locomotion', 'Dexterous & Tactile Manipulation', 'Non-Prehensile Manipulation', '3D Reconstruction & Gaussian Splatting', 'Model-Based RL', 'Robot Learning Foundations']) assert.ok(names.includes(want), want);
  const s = core.loadSettings(); s.researchLines = cat.cleanLines('  - VLA: vision-language-action\r\n\r\nHumanoid/ Locomotion\nVLA\nTactile Sensing:  touch  '); core.saveSettings(s);
  assert.deepEqual(cat.preferredLines(), [{ name: 'VLA', description: 'vision-language-action' }, { name: 'Humanoid / Locomotion', description: '' }, { name: 'Tactile Sensing', description: 'touch' }]);
  assert.throws(() => cat.cleanLines('x'.repeat(3001)));
  assert.throws(() => cat.cleanLines(42));
  delete s.researchLines; core.saveSettings(s);
});

// ---------- prompts ----------
const item = (id, title, category = cat.UNCAT, extra = {}) => ({ id, fields: { title, year: '2025', abstract: 'An abstract that is long enough to be used as one, about robots that learn from data and act.' }, tags: ['robots'], category, ...extra });
t('regroup prompt: research-line rules, preferred lines, evidence per paper', () => {
  const items = [item('a', 'Paper A'), item('b', 'Paper B', cat.UNCAT, { brief: 'Brief of B.' })];
  const p = cat.regroupPrompt({ chunk: items, total: 2, fixed: [], decided: [], items, chunkNo: 1, chunks: 1, evidence: new Map([['a', 'builds on: OpenVLA']]) });
  assert.match(p, /RESEARCH LINE/);
  assert.match(p, /"Line \/ Sub-line"/);
  assert.match(p, /4 or more papers/);
  assert.match(p, /- Humanoid \/ Teleoperation & Data/);
  assert.match(p, /"builds":"builds on: OpenVLA"/);
  assert.match(p, /"brief":"Brief of B\."/);
  const items2 = [item('a', 'Paper A', cat.UNCAT, { brief: 'Brief of A.' })];
  const p2 = cat.regroupPrompt({ chunk: items2, total: 1, fixed: [], decided: [], items: items2, chunkNo: 1, chunks: 1, evidence: new Map([['a', 'builds on: OpenVLA']]) });
  assert.match(p2, /"builds":"builds on: OpenVLA","brief":"Brief of A\."/); // evidence and brief together
  const p3 = cat.regroupPrompt({ chunk: items2, total: 1, fixed: [], manual: ['- Humanoid Robotics / Foundation Models & VLA (7 papers): "X"'], decided: [], items: items2, chunkNo: 1, chunks: 1 });
  assert.match(p3, /FILED BY HAND[^\n]*not a model/);
  assert.match(p3, /This is about the\s+name only/);
});
t('classify prompt: same rules and evidence', () => {
  const items = [item('a', 'Paper A', 'VLA'), item('b', 'Paper B')];
  const p = cat.classifyPrompt(items[1], items, 'builds on: GR00T; related work: Humanoid Whole-Body Control');
  assert.match(p, /RESEARCH LINE/);
  assert.match(p, /- VLA \(1 paper\)/);
  assert.match(p, /Builds \(from its own text\): builds on: GR00T/);
  assert.doesNotMatch(cat.classifyPrompt(items[1], items), /Builds \(from/);
});

// ---------- the sub-line rule and the line summary ----------
t('settleLines: one spelling per line; sub-lines of a line under 4 papers fold into the line', () => {
  const target = new Map([['1', 'Humanoid / Locomotion'], ['2', 'humanoid / Manipulation'], ['3', 'Humanoid / Locomotion'], ['4', 'Humanoid / Teleoperation & Data'],
    ['5', 'MoCap / Datasets'], ['6', 'MoCap / Retargeting'], ['7', 'World Models']]);
  const renamed = cat.settleLines(target, []);
  assert.equal(target.get('2'), 'Humanoid / Manipulation');
  assert.equal(target.get('5'), 'MoCap'); assert.equal(target.get('6'), 'MoCap');
  assert.equal(target.get('1'), 'Humanoid / Locomotion');
  assert.equal(renamed.get('MoCap / Datasets'), 'MoCap');
  // papers outside the re-grouping count towards the size of a line (and give its spelling)
  const t2 = new Map([['5', 'mocap / Datasets']]);
  cat.settleLines(t2, ['MoCap / Retargeting', 'MoCap', 'MoCap / Datasets']);
  assert.equal(t2.get('5'), 'MoCap / Datasets');
});
t('linesOf: lines with counts and their sub-lines', () => {
  const l = cat.linesOf(new Map([['Humanoid / Locomotion', 5], ['Humanoid / Manipulation', 3], ['Humanoid', 1], ['VLA', 7]]));
  assert.deepEqual(l.map((x) => [x.name, x.count]), [['Humanoid', 9], ['VLA', 7]]);
  assert.deepEqual(l[0].sublines.map((s) => [s.sub, s.count]), [['Locomotion', 5], ['Manipulation', 3]]);
  assert.equal(l[0].direct, 1);
  const s = cat.summary({ items: [item('a', 'A', 'Humanoid / Locomotion'), item('b', 'B', 'Humanoid / Manipulation'), item('c', 'C')] });
  assert.deepEqual(s.lines.map((x) => x.name), ['Humanoid']);
});
t('inCategory: a line holds its sub-lines, a sub-line only itself', () => {
  const a = item('a', 'A', 'Humanoid / Locomotion'), b = item('b', 'B', 'Humanoid'), c = item('c', 'C', 'Humanoids');
  assert.ok(cat.inCategory(a, 'Humanoid') && cat.inCategory(b, 'Humanoid') && !cat.inCategory(c, 'Humanoid'));
  assert.ok(cat.inCategory(a, 'Humanoid / Locomotion') && !cat.inCategory(b, 'Humanoid / Locomotion'));
});

fs.rmSync(process.env.RT_WORKSPACE, { recursive: true, force: true });
console.log(`\n${n} tests passed`);
