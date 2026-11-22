#!/usr/bin/env node
// Tests for lib/figures.js (the local figure / table finder): caption detection, columns, regions, the raster step
// and the placeholders of a note - all on synthetic layout data, no PDF and no poppler needed.
// Run:  node scripts/test-figures.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RT_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-figtest-')); // lib/core creates its folders there
const F = require('../lib/figures');

let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 12).join('\n     ')); }
  })());
}

// ---------------------------------------------------------------- synthetic layout
const W = 612, H = 792, LEFT = [54, 298], RIGHT = [314, 558];
// a line of text between x0 and x1 at height y (font size h): the words are spread evenly
function line(x0, x1, y, text, h = 9) {
  const ws = text.split(' '), step = (x1 - x0) / ws.length;
  return F.makeLine(ws.map((t, i) => ({ x0: x0 + i * step, x1: x0 + (i + 1) * step - 2.5, y0: y, y1: y + h, t })));
}
const WORDS = 'the model is trained on a large set of robot data and then tuned'.split(' ');
// a justified paragraph of n lines in [x0, x1] starting at y
function para(x0, x1, y, n, h = 9) {
  const ls = [];
  for (let i = 0; i < n; i++) ls.push(line(x0, i === n - 1 ? x0 + (x1 - x0) * 0.6 : x1, y + i * 11, WORDS.slice(0, i === n - 1 ? 6 : 10).join(' '), h));
  return F.makeBlock(ls);
}
const block = (...ls) => F.makeBlock(ls);
const label = (x, y, text, h = 6) => block(line(x, x + text.length * 3.2, y, text, h)); // a small label inside a figure
// several pages of plain two-column text, so that the document shows its columns and its body size
const textPage = () => ({ w: W, h: H, blocks: [para(...LEFT, 72, 30), para(...RIGHT, 72, 30), para(...LEFT, 420, 28), para(...RIGHT, 420, 28)] });
// raster at 1 pixel per point from a list of inked rectangles [x0, y0, x1, y1]
function raster(page, rects) {
  const grid = new Uint8Array(W * H);
  const fill = (x0, y0, x1, y1) => { for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) grid[y * W + x] = 1; };
  for (const b of page.blocks) for (const l of b.lines) fill(l.x0, l.y0 + 1, l.x1, l.y1 - 1); // the text itself
  for (const r of rects) fill(...r);
  return F.rasterOf(W, H, (x, y) => grid[y * W + x] === 1);
}
// an outlined box with something in it (a drawing): frame + a few strokes
const drawing = (x0, y0, x1, y1) => [[x0, y0, x1, y0 + 2], [x0, y1 - 2, x1, y1], [x0, y0, x0 + 2, y1], [x1 - 2, y0, x1, y1], [x0 + 10, (y0 + y1) / 2, x1 - 10, (y0 + y1) / 2 + 3], [(x0 + x1) / 2, y0 + 8, (x0 + x1) / 2 + 3, y1 - 8]];
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// ---------------------------------------------------------------- captions
test('caption wording: what opens a caption', () => {
  const c = (t) => F.captionOf(t);
  assert.deepEqual([c('Figure 3: Overview of the method.').key, c('Fig. 12. Results on the benchmark').key, c('FIGURE 2 | Pipeline').key], ['fig-3', 'fig-12', 'fig-2']);
  assert.deepEqual([c('Table 2: Success rates').key, c('TABLE IV').key, c('Table 7. Ablation').kind], ['tab-2', 'tab-4', 'table']);
  assert.deepEqual([c('图 3：系统总体框架').key, c('表 2 实验结果').key, c('图3 方法').kind], ['fig-3', 'tab-2', 'figure']);
  assert.equal(c('Figure S2: Extra rollouts').key, 'fig-s2');
  assert.equal(c('Figure 3 Scaling ingredients. The effect of').key, 'fig-3');
  assert.equal(c('TABLE IV').label, 'Table IV');
  assert.ok(c('Figure 3: Overview').score > c('Figure 3 Scaling ingredients').score);
});
test('caption wording: sentences that only mention a figure are not captions', () => {
  for (const t of ['Figure 3 shows the rollout length chosen by the model', 'Table I summarizes the NRMSE performance of all', 'Figure 6). Our experiments focus on',
    'Fig. 2, the visual-perception module first extracts', 'Figure 11, show a similar trend as Figure 10', 'Figure 1 and Figure 4.', 'Figure 1(b) shows the rollout', 'Figure 3a compares',
    'Figures 3 and 4 show', 'In Figure 3: nothing', 'Table 2 using a white background for compatibility.']) assert.equal(F.captionOf(t), null, t);
});
test('a caption opens its block; inside a block only after a sentence end', () => {
  const page = { w: W, h: H, blocks: [
    block(line(...LEFT, 300, 'Figure 2: The pipeline of our method in three stages.'), line(...LEFT, 311, 'Each stage is trained on its own data.')),
    block(line(...LEFT, 400, 'are the main results of the first experiment.'), line(...LEFT, 411, 'Table 1: Quantitative results on all tasks.'), line(...LEFT, 422, 'Higher is better.')),
    block(line(...LEFT, 500, 'the results of this comparison are reported in'), line(...LEFT, 511, 'Figure 6. We compare to versions of our policy that')),
  ] };
  const caps = F.findCaptions(page);
  assert.deepEqual(caps.map((b) => b.cap.key), ['fig-2', 'tab-1']);
  assert.equal(page.blocks.length, 4, 'the block holding Table 1 was split in two');
  const t1 = caps[1];
  assert.equal(t1.lines.length, 2); near(t1.y0, 411, 0.01, 'top of the split caption');
  assert.equal(F.captionText(caps[0]), 'Figure 2: The pipeline of our method in three stages. Each stage is trained on its own data.');
});
test('caption lines read as a separate block, and the title under "TABLE I", belong to the caption', () => {
  const page = { w: W, h: H, blocks: [
    block(line(...LEFT, 300, 'Fig. 4: We propose an efficient video encoder for', 8)), block(line(...LEFT, 310, 'compressing short-horizon memory into few tokens here', 8), line(LEFT[0], 200, 320, 'and more.', 8)),
    block(line(140, 210, 500, 'TABLE I', 7)), block(line(80, 270, 509, 'RANGES OF THE ENVIRONMENT PARAMETERS', 7)),
    para(...LEFT, 600, 6),
  ] };
  const caps = F.findCaptions(page);
  assert.equal(caps.length, 2);
  assert.match(F.captionText(caps[0]), /^Fig\. 4: We propose .* and more\.$/);
  assert.equal(F.captionText(caps[1]), 'TABLE I RANGES OF THE ENVIRONMENT PARAMETERS');
  assert.equal(page.blocks.filter((b) => b.capOf).length, 2);
});

// ---------------------------------------------------------------- pdftotext XML
test('parseLayout reads pages, blocks, lines and words (entities decoded)', () => {
  const xml = `<doc>\n<page width="612.000000" height="792.000000">\n<flow>\n<block xMin="54.0" yMin="100.0" xMax="200.0" yMax="121.0">\n<line xMin="54.0" yMin="100.0" xMax="200.0" yMax="109.0">\n<word xMin="54.0" yMin="100.0" xMax="90.0" yMax="109.0">Fig.</word>\n<word xMin="94.0" yMin="100.0" xMax="110.0" yMax="109.0">2:</word>\n<word xMin="114.0" yMin="100.0" xMax="200.0" yMax="109.0">A&amp;B &lt;x&gt;</word>\n</line>\n<line xMin="54.0" yMin="112.0" xMax="120.0" yMax="121.0">\n<word xMin="54.0" yMin="112.0" xMax="120.0" yMax="121.0">next</word>\n</line>\n</block>\n</flow>\n</page>\n</doc>`;
  const pages = F.parseLayout(xml);
  assert.equal(pages.length, 1);
  assert.deepEqual([pages[0].w, pages[0].h, pages[0].blocks.length, pages[0].blocks[0].lines.length], [612, 792, 1, 2]);
  assert.equal(pages[0].blocks[0].lines[0].text, 'Fig. 2: A&B <x>');
  assert.equal(pages[0].blocks[0].lines[0].h, 9);
});
test('two columns read as one line per row are split at the gutter', () => {
  const word = (x0, x1, y, t) => `<word xMin="${x0}" yMin="${y}" xMax="${x1}" yMax="${y + 9}">${t}</word>`;
  let xml = '<page width="612" height="792">\n<block xMin="54" yMin="100" xMax="558" yMax="400">\n';
  for (let i = 0; i < 20; i++) {
    const y = 100 + i * 11;
    xml += `<line xMin="54" yMin="${y}" xMax="558" yMax="${y + 9}">\n`;
    for (let k = 0; k < 6; k++) xml += word(54 + k * 41, 54 + k * 41 + 38, y, 'left') + '\n';
    for (let k = 0; k < 6; k++) xml += word(314 + k * 41, 314 + k * 41 + 38, y, 'right') + '\n';
    xml += '</line>\n';
  }
  xml += '</block>\n</page>';
  const [page] = F.parseLayout(xml);
  assert.equal(page.blocks.length, 2);
  const [a, b] = page.blocks.sort((x, y) => x.x0 - y.x0);
  assert.ok(a.x1 < 306 && b.x0 > 306, 'one block per column');
  assert.deepEqual([a.lines.length, b.lines.length, a.lines[0].text], [20, 20, 'left left left left left left']);
});

// ---------------------------------------------------------------- columns, body text
test('columns and body text of a two-column paper', () => {
  const pages = [textPage(), textPage(), textPage()];
  const stats = F.docStats(pages);
  assert.equal(stats.bodyH, 9);
  assert.equal(stats.columns.length, 2);
  near(stats.columns[0].L, 54, 1, 'left column'); near(stats.columns[1].L, 314, 1, 'right column'); near(stats.columns[1].R, 555.5, 3, 'right edge');
  const page = { w: W, h: H, blocks: [para(...LEFT, 72, 8), label(80, 200, 'encoder'), label(150, 230, 'action expert 300M'), block(line(54, 180, 300, '3.2 Training Objective')), block(line(120, 240, 340, 'x = y + z (3)'))] };
  F.classifyPage(page, stats);
  assert.deepEqual(page.blocks.map((b) => b.body), [true, false, false, true, false], 'paragraph and heading are body, labels and a formula are not');
});
test('a running header is a margin block; the first line of the text is not', () => {
  const mk = (n) => ({ w: W, h: H, blocks: [block(line(54, 300, 30, 'IEEE TRANSACTIONS ON ROBOTICS PREPRINT', 6)), block(line(545, 558, 30, String(n), 6)), para(...LEFT, 60, 20), para(...RIGHT, 60, 20), block(line(300, 312, 760, String(n)))] });
  const pages = [mk(1), mk(2), mk(3), mk(4)];
  const stats = F.docStats(pages);
  assert.ok(stats.headerY > 36 && stats.headerY < 58, 'header ' + stats.headerY);
  assert.ok(stats.footerY > 700 && stats.footerY < 762, 'footer ' + stats.footerY);
  F.classifyPage(pages[1], stats);
  assert.deepEqual(pages[1].blocks.map((b) => b.margin), [true, true, false, false, true]);
});

// ---------------------------------------------------------------- regions (layout only)
function figurePage() {
  // left column: text, a figure with labels, its caption, text.  right column: caption of a table, the table cells, text.
  // bottom: a wide figure across both columns with a wide caption.
  const cap1 = block(line(...LEFT, 330, 'Fig. 3: Overview of the model with its two parts.', 8), line(LEFT[0], 200, 340, 'Details in the text.', 8));
  const cap2 = block(line(...RIGHT, 150, 'Table 2: Success rate of every method on all tasks.', 8));
  const cap3 = block(line(60, 550, 700, 'Figure 4: Rollouts of the policy on the four long-horizon tasks of the benchmark, one row per task.', 8));
  const cells = [];
  for (let r = 0; r < 5; r++) cells.push(label(320, 170 + r * 12, 'Method' + r, 8), label(420, 170 + r * 12, '0.9' + r, 8), label(500, 170 + r * 12, '12.' + r, 8));
  return {
    w: W, h: H, blocks: [para(...LEFT, 72, 8), label(80, 190, 'vision encoder'), label(190, 250, 'action head'), cap1, para(...LEFT, 360, 12),
      para(...RIGHT, 72, 6), cap2, ...cells, para(...RIGHT, 250, 22), cap3, para(...LEFT, 730, 3), para(...RIGHT, 730, 3)],
    caps: { cap1, cap2, cap3 },
  };
}
const figureRects = () => [...drawing(70, 180, 285, 322), [316, 166, 556, 167], [316, 232, 556, 233], ...drawing(60, 520, 550, 690)];
test('a figure is the area above its caption, in the caption\'s column, up to the body text', () => {
  const page = figurePage(), stats = F.docStats([textPage(), textPage(), page]);
  const caps = F.findCaptions(page), cols = F.classifyPage(page, stats);
  assert.equal(caps.length, 3);
  const r = F.xRange(page.caps.cap1, page, cols, caps);
  assert.equal(r.wide, false); near(r.xa, 54, 1, 'left'); near(r.xb, 298, 4, 'right');
  const up = F.sideRegion(page.caps.cap1, page, r, 'above');
  near(up.y0, 72 + 7 * 11 + 9, 1.5, 'top = end of the paragraph above'); near(up.y1, 330, 1, 'bottom = top of the caption'); assert.equal(up.bound, 'text');
  const down = F.sideRegion(page.caps.cap1, page, r, 'below');
  assert.ok(down.y1 - down.y0 < 12, 'nothing but body text below the caption');
});
test('a table is the area below its caption; a wide caption speaks for the whole width', () => {
  const page = figurePage(), stats = F.docStats([textPage(), textPage(), page]);
  const caps = F.findCaptions(page), cols = F.classifyPage(page, stats);
  const r2 = F.xRange(page.caps.cap2, page, cols, caps);
  assert.equal(r2.wide, false); near(r2.xa, 314, 1, 'left');
  const t = F.sideRegion(page.caps.cap2, page, r2, 'below');
  near(t.y0, 158, 1.5, 'top = end of the caption'); near(t.y1, 250, 1, 'bottom = next paragraph');
  const r3 = F.xRange(page.caps.cap3, page, cols, caps);
  assert.equal(r3.wide, true); near(r3.xa, 54, 1, 'left'); near(r3.xb, 556, 4, 'right');
  const w = F.sideRegion(page.caps.cap3, page, r3, 'above');
  near(w.y0, 250 + 21 * 11 + 9, 1.5, 'top = the lower of the two columns of text above'); near(w.y1, 700, 1, 'bottom');
});
test('captions side by side share the width between them', () => {
  const a = block(line(60, 280, 400, 'Figure 5: Left plot of the pair.')), b = block(line(330, 550, 400, 'Figure 6: Right plot of the pair.'));
  const page = { w: W, h: H, blocks: [para(54, 558, 72, 5), a, b, para(54, 558, 430, 20)] };
  const stats = F.docStats([page, page]);
  const caps = F.findCaptions(page), cols = F.classifyPage(page, stats);
  const ra = F.xRange(a, page, cols, caps), rb = F.xRange(b, page, cols, caps);
  near(ra.xb, 305, 2, 'left figure ends between the captions'); near(rb.xa, 305, 2, 'right figure starts there');
});

// ---------------------------------------------------------------- raster
test('readPGM and the summed-area table', () => {
  const head = Buffer.from('P5\n# made by a test\n4 3\n255\n', 'latin1');
  const px = Buffer.from([255, 255, 255, 255, 255, 0, 100, 255, 255, 255, 255, 240]);
  const r = F.readPGM(Buffer.concat([head, px]));
  assert.deepEqual([r.w, r.h], [4, 3]);
  const R = F.pageRaster(r, { w: 4, h: 3 });
  assert.equal(R.cnt(0, 0, 4, 3), 2, 'two dark pixels (240 is paper)');
  assert.deepEqual(R.trim({ x0: 0, y0: 0, x1: 4, y1: 3 }), { x0: 1, x1: 3, y0: 1, y1: 2 });
  assert.equal(R.trim({ x0: 0, y0: 0, x1: 4, y1: 1 }), null);
  assert.throws(() => F.readPGM(Buffer.from('P6\n1 1\n255\n000')));
});
test('analyze: figure above, table below, wide figure - boxes are tight around the ink and exclude the captions', () => {
  const page = figurePage();
  const pages = [textPage(), textPage(), page];
  const figs = F.analyze(pages, { 3: raster(page, figureRects()) });
  assert.deepEqual(figs.map((f) => f.key).sort(), ['fig-3', 'fig-4', 'tab-2']);
  const by = Object.fromEntries(figs.map((f) => [f.key, f]));
  const f3 = by['fig-3'].box, t2 = by['tab-2'].box, f4 = by['fig-4'].box;
  assert.equal(by['fig-3'].page, 3); assert.equal(by['fig-3'].side, 'above'); assert.equal(by['tab-2'].side, 'below');
  near(f3.x, 67, 1.5, 'fig-3 left'); near(f3.y, 177, 1.5, 'fig-3 top'); near(f3.x + f3.w, 288, 1.5, 'fig-3 right'); near(f3.y + f3.h, 325, 1.5, 'fig-3 bottom');
  assert.ok(f3.y + f3.h <= 330, 'the caption is not in the crop');
  near(t2.y, 163, 2, 'table top (its upper rule)'); near(t2.y + t2.h, 236, 2, 'table bottom (its lower rule)'); assert.ok(t2.x >= 310 && t2.x + t2.w <= 562);
  near(f4.x, 57, 1.5, 'wide figure left'); near(f4.x + f4.w, 553, 1.5, 'wide figure right'); near(f4.y, 517, 1.5, 'wide figure top');
  assert.equal(by['fig-4'].wide, true); assert.equal(by['fig-3'].wide, false);
  for (const f of figs) assert.ok(f.confidence >= 0.7 && f.confidence <= 1, f.key + ' confidence ' + f.confidence);
  assert.match(by['fig-3'].caption, /^Fig\. 3: Overview .* Details in the text\.$/);
});
test('analyze: a heading and a last line of a paragraph between the text and the figure are cut off', () => {
  const cap = block(line(...LEFT, 400, 'Figure 2: The training pipeline.', 8));
  const page = { w: W, h: H, blocks: [para(...LEFT, 72, 6), block(line(54, 150, 150, 'where x is the state.')), block(line(54, 190, 172, '3.1 Model Architecture')), label(100, 260, 'policy'), cap, para(...LEFT, 420, 20), para(...RIGHT, 72, 50)] };
  page.blocks[1].body = false;
  const figs = F.analyze([textPage(), textPage(), page], { 3: raster(page, drawing(70, 200, 280, 390)) });
  assert.equal(figs.length, 1);
  near(figs[0].box.y, 197, 1.5, 'the crop starts at the drawing, below the heading');
});
test('analyze: an empty area or plain text above a caption is not a figure; the same number twice keeps the better one', () => {
  const lone = block(line(...LEFT, 300, 'Figure 7: A caption with nothing drawn near it.', 8));
  const p1 = { w: W, h: H, blocks: [para(...LEFT, 72, 18), lone, para(...LEFT, 320, 30), para(...RIGHT, 72, 50)] };
  assert.deepEqual(F.analyze([textPage(), textPage(), p1], { 3: raster(p1, []) }), []);
  // "Figure 9" as a real caption on page 3 and as a weaker, caption-like line on page 4
  const real = block(line(...LEFT, 300, 'Figure 9: Real caption.', 8));
  const p3 = { w: W, h: H, blocks: [para(...LEFT, 72, 6), real, para(...LEFT, 320, 30), para(...RIGHT, 72, 50)] };
  const weak = block(line(...LEFT, 500, 'Figure 9 Again the same number', 8));
  const p4 = { w: W, h: H, blocks: [para(...LEFT, 72, 6), weak, para(...LEFT, 520, 10), para(...RIGHT, 72, 50)] };
  const figs = F.analyze([textPage(), textPage(), p3, p4], { 3: raster(p3, drawing(70, 150, 280, 290)), 4: raster(p4, drawing(70, 150, 280, 490)) });
  assert.deepEqual(figs.map((f) => [f.key, f.page]), [['fig-9', 3]]);
});
test('analyze: a table directly followed by a figure share the gap between the captions - divided at the white band', () => {
  const tcap = block(line(54, 558, 100, 'Table 3: Numbers of the ablation over all the tasks of the suite.', 8));
  const fcap = block(line(54, 558, 400, 'Figure 8: Curves of the ablation over all the tasks of the suite.', 8));
  const cells = [label(80, 125, 'A', 8), label(200, 125, '0.5', 8), label(80, 140, 'B', 8), label(200, 140, '0.7', 8)];
  const page = { w: W, h: H, blocks: [tcap, ...cells, fcap, para(54, 558, 420, 25)] };
  const figs = F.analyze([page, page], { 1: raster(page, [[60, 118, 550, 119], [60, 155, 550, 156], ...drawing(100, 200, 500, 390)]) });
  const by = Object.fromEntries(figs.map((f) => [f.key, f]));
  near(by['tab-3'].box.y + by['tab-3'].box.h, 159, 2, 'the table ends at its lower rule');
  near(by['fig-8'].box.y, 197, 2, 'the figure starts at the drawing');
});
test('analyze without a raster still gives the layout regions, with a lower confidence', () => {
  const page = figurePage();
  const figs = F.analyze([textPage(), textPage(), page], {});
  assert.deepEqual(figs.map((f) => f.key).sort(), ['fig-3', 'fig-4', 'tab-2']);
  assert.ok(figs.every((f) => f.confidence < 0.75));
});

// ---------------------------------------------------------------- notes
test('placeholder lines', () => {
  const p = F.parsePlaceholder;
  assert.deepEqual(p('> 📷 待截图：Figure 3（方法总体框架，第 5 页）'), { kind: 'figure', key: 'fig-3', label: 'Figure 3', desc: '方法总体框架', page: 5 });
  assert.deepEqual(p('> 📷 待截图：Table 2 (main results on LIBERO, p. 7)'), { kind: 'table', key: 'tab-2', label: 'Table 2', desc: 'main results on LIBERO', page: 7 });
  assert.deepEqual(p('>📷 待截图: Fig. 12（消融实验）'), { kind: 'figure', key: 'fig-12', label: 'Fig. 12', desc: '消融实验', page: null });
  assert.equal(p('> 📷 待截图：Table IV（参数范围，第 5 页）').key, 'tab-4');
  assert.equal(p('> 📷 待截图：图 2（框架，第 3 页）').key, 'fig-2');
  assert.equal(p('> 📷 待截图：方法框架图').key, null);
  assert.equal(p('> 📷 待截图：Figure 6a（学生成功率曲线，第 9 页）').key, 'fig-6');
  const two = p('> 📷 待截图：Figure 7 与 Figure 8（吞吐量与成功率，第 9 页）');
  assert.deepEqual([two.keys, two.label, two.desc, two.page], [['fig-7', 'fig-8'], 'Figure 7、Figure 8', '吞吐量与成功率', 9]);
  assert.deepEqual(p('> 📷 待截图：Figure 3 and Table 2 (both, p. 4)').keys, ['fig-3', 'tab-2']);
  assert.equal(p('> a normal quote about Figure 3'), null);
  assert.equal(p('📷 待截图：Figure 3'), null, 'not a blockquote');
});
const FIG = { key: 'fig-3', kind: 'figure', number: 3, label: 'Figure 3', page: 5, caption: 'Figure 3: x', box: { x: 50, y: 60, w: 500, h: 200 }, pageW: 612, pageH: 792, confidence: 0.9, wide: true };
const TAB = { ...FIG, key: 'tab-2', kind: 'table', number: 2, label: 'Table 2', page: 7, box: { x: 50, y: 60, w: 240, h: 100 }, wide: false };
const resolver = (calls) => async (key) => { calls.push(key); return key === 'fig-3' ? { figure: FIG, url: '/api/items/abc123/note/assets/' + 'a'.repeat(40) + '.png' } : key === 'tab-2' ? { figure: TAB, url: '/api/items/abc123/note/assets/' + 'b'.repeat(40) + '.png' } : null; };
test('placeIn replaces the placeholders that were found and nothing else', async () => {
  const note = ['# 方法论', '', '> 📷 待截图：Figure 3（方法总体框架，第 4 页）', '', 'Some text about Figure 3 and 📷 in a sentence.', '', '> [!key] 🍞', '> 📷 待截图：Figure 3（inside a callout）', '',
    '```', '> 📷 待截图：Figure 3（in code）', '```', '', '> 📷 待截图：Figure 9（没有找到，第 8 页）', '', '> 📷 待截图：Table 2 (main results, p. 7)', '', '| a | b |', '| - | - |', ''].join('\n');
  const calls = [];
  const r = await F.placeIn(note, resolver(calls), { language: 'zh' });
  const out = r.markdown.split('\n'), src = note.split('\n');
  assert.deepEqual(r.placed.map((p) => p.key), ['fig-3', 'tab-2']);
  assert.deepEqual(r.missed.map((m) => [m.key, m.reason]), [['fig-3', 'part of a longer quote'], ['fig-9', 'not found in the PDF']]);
  // the picture, then - in the same paragraph - the label, the description and the page link the snapshot tool writes
  assert.equal(out[2], `![Figure 3](/api/items/abc123/note/assets/${'a'.repeat(40)}.png#w=680)`);
  assert.equal(out[3], 'Figure 3：方法总体框架 [p. 5](#rt-page=5)', 'the page comes from the PDF, not from the placeholder');
  assert.equal(out[17], 'Table 2：main results [p. 7](#rt-page=7)');
  assert.match(out[16], /^!\[Table 2\]\(.*#w=420\)$/);
  // every other line is unchanged
  const rest = out.filter((l, i) => ![2, 3, 16, 17].includes(i));
  assert.deepEqual(rest, src.filter((l, i) => ![2, 15].includes(i)));
  // idempotent: a second run finds nothing to do
  const again = await F.placeIn(r.markdown, resolver([]), { language: 'zh' });
  assert.equal(again.markdown, r.markdown); assert.equal(again.placed.length, 0);
});
test('placeIn: the same figure twice gives the same picture; keys can be limited; a failing lookup leaves the line', async () => {
  const note = '> 📷 待截图：Figure 3 (first, p. 5)\n\ntext\n\n> 📷 待截图：Figure 3 (again, p. 5)\n\n> 📷 待截图：Table 2 (t, p. 7)\n';
  const r = await F.placeIn(note, resolver([]), { language: 'en', only: new Set(['fig-3']) });
  const urls = [...r.markdown.matchAll(/\]\((\/api[^)#]+)/g)].map((m) => m[1]);
  assert.equal(urls.length, 2); assert.equal(urls[0], urls[1]);
  assert.match(r.markdown, /^Figure 3: first \[p\. 5\]\(#rt-page=5\)$/m);
  assert.match(r.markdown, /^> 📷 待截图：Table 2 \(t, p\. 7\)$/m);
  assert.deepEqual(r.missed.map((m) => m.reason), ['not selected']);
  const bad = await F.placeIn(note, async () => { throw new Error('pdftoppm failed'); });
  assert.equal(bad.markdown, note); assert.equal(bad.missed.length, 3); assert.equal(bad.missed[0].reason, 'pdftoppm failed');
  const crlf = await F.placeIn('a\r\n\r\n> 📷 待截图：Figure 3 (x, p. 5)\r\n\r\nb\r\n', resolver([]), { language: 'en' });
  assert.equal(crlf.markdown.split('\r\n').length, 7, 'CRLF line ends are kept');
  assert.equal((await F.placeIn('', resolver([]))).markdown, '');
});
test('placeIn: a placeholder naming two figures gets both pictures, or stays when one is missing', async () => {
  const r = await F.placeIn('> 📷 待截图：Figure 3 与 Table 2（两者，第 5 页）\n\n> 📷 待截图：Figure 3 与 Figure 9（缺一，第 5 页）\n', resolver([]), { language: 'zh' });
  const out = r.markdown.split('\n');
  assert.match(out[0], /^!\[Figure 3\]/); assert.match(out[1], /^!\[Table 2\]/);
  assert.equal(out[2], 'Figure 3、Table 2：两者 [p. 5](#rt-page=5) [p. 7](#rt-page=7)');
  assert.equal(out[4], '> 📷 待截图：Figure 3 与 Figure 9（缺一，第 5 页）');
  assert.deepEqual([r.placed.length, r.missed.length], [2, 1]);
});
test('figure Markdown: page link as reader.js writes it, a display width for wide, narrow and tall figures', () => {
  assert.equal(F.pageLink(7), '[p. 7](#rt-page=7)');
  assert.equal(F.displayWidth(FIG), 680);
  assert.equal(F.displayWidth(TAB), 420);
  const tall = { ...TAB, box: { x: 0, y: 0, w: 200, h: 600 } };
  assert.equal(F.displayWidth(tall), 240, 'a tall figure is shown narrow');
  assert.equal(F.figureMarkdown(FIG, '/u.png'), '![Figure 3](/u.png#w=680)\nFigure 3 [p. 5](#rt-page=5)');
});
test('place() never throws for a paper without a PDF: the note comes back unchanged', async () => {
  const note = '# A\n\n> 📷 待截图：Figure 1（x，第 1 页）\n';
  const r = await F.place('abcdef0123', note, { language: 'zh' });
  assert.equal(r.markdown, note); assert.equal(r.placed.length, 0); assert.equal(r.missed.length, 1); assert.ok(r.unavailable);
  assert.deepEqual(await F.place('abcdef0123', 'no placeholder here'), { markdown: 'no placeholder here', placed: [], missed: [] });
  assert.equal((await F.promptList('abcdef0123')).text, '');
  await assert.rejects(() => F.image('abcdef0123', '../x'), /Bad figure key/);
});

// ---------------------------------------------------------------- what the review found (accuracy)
test('captions: a bare label is a caption only where it stands alone above its title', () => {
  const c = (t) => F.captionOf(t);
  assert.equal(c('Table1'), null, 'a cell of a table (a column called Table1)');
  assert.equal(c('Fig2'), null);
  assert.ok(c('TABLE II').bare && c('Table 2').bare && c('Table 2').score < c('TABLE II').score);
  assert.equal(c('Figure 18 (Left): Impact of longer anticipation times.').key, 'fig-18');
  assert.equal(c('Figure 3 (see Section 2) shows'), null);
  // "Table 2" among the column heads of a table, and "TABLE I" alone on its row with the title below it
  const cells = { w: W, h: H, blocks: [label(146, 255, 'Racket', 6), block(line(178, 205, 255, 'Table 2', 6)), label(243, 255, 'Umbre.', 6), label(150, 271, '10.4', 6)] };
  assert.deepEqual(F.findCaptions(cells), []);
  const ieee = { w: W, h: H, blocks: [block(line(160, 200, 100, 'TABLE I', 7)), block(line(90, 270, 110, 'RANGES OF THE PARAMETERS', 7)), label(80, 130, 'Friction', 7)] };
  const caps = F.findCaptions(ieee);
  assert.equal(caps.length, 1); assert.equal(F.captionText(caps[0]), 'TABLE I RANGES OF THE PARAMETERS');
  const noTitle = { w: W, h: H, blocks: [block(line(160, 200, 100, 'TABLE I', 7)), label(80, 300, 'far away', 7)] };
  assert.deepEqual(F.findCaptions(noTitle), [], 'no title, no caption');
});
test('two captions side by side on one line become two caption blocks', () => {
  const word = (x0, x1, y, t) => `<word xMin="${x0}" yMin="${y}" xMax="${x1}" yMax="${y + 9}">${t}</word>`;
  const row = (y, left, right) => {
    let x = 108, s = `<line xMin="108" yMin="${y}" xMax="504" yMax="${y + 9}">\n`;
    for (const t of left) { s += word(x, x + t.length * 4.5, y, t) + '\n'; x += t.length * 4.5 + 2.5; }
    x = 333;
    for (const t of right) { s += word(x, x + t.length * 4.5, y, t) + '\n'; x += t.length * 4.5 + 2.5; }
    return s + '</line>\n';
  };
  const xml = '<page width="612" height="792">\n<block xMin="108" yMin="242" xMax="504" yMax="273">\n'
    + row(242, 'Table 5: Comparison with the other model.'.split(' '), 'Table 6: Routing ablation study.'.split(' '))
    + row(253, 'It shares the same backbone'.split(' '), 'The embedding is as in Sec. 3.'.split(' ')) + '</block>\n</page>';
  const [page] = F.parseLayout(xml);
  const caps = F.findCaptions(page).sort((a, b) => a.x0 - b.x0);
  assert.deepEqual(caps.map((b) => b.cap.key), ['tab-5', 'tab-6']);
  assert.ok(caps[0].x1 < 330 && caps[1].x0 >= 333, 'each caption keeps to its side');
  assert.equal(F.captionText(caps[0]), 'Table 5: Comparison with the other model. It shares the same backbone');
  assert.equal(F.captionText(caps[1]), 'Table 6: Routing ablation study. The embedding is as in Sec. 3.');
  // a caption that only mentions another figure is left alone
  const plain = '<page width="612" height="792">\n<block xMin="108" yMin="242" xMax="504" yMax="251">\n' + row(242, 'Figure 2: Compare this with'.split(' '), 'Figure 4 above it'.split(' ')) + '</block>\n</page>';
  assert.equal(F.findCaptions(F.parseLayout(plain)[0]).length, 1);
});
// a table drawn with three rules of the same extent, and its cells
const tableRules = (x0, x1, y0, y1) => [[x0, y0, x1, y0 + 1], [x0, y0 + 14, x1, y0 + 15], [x0, y1 - 1, x1, y1]];
test('rules and frames: a table is its frame of rules; areas and short strokes are not rules', () => {
  const page = { w: W, h: H, blocks: [] };
  const R = F.pageRaster(raster(page, [...tableRules(80, 530, 100, 200), [80, 300, 530, 340], [100, 400, 130, 401]]), page);
  const rules = F.findRules(R);
  assert.equal(rules.length, 3, 'three rules; the grey area and the short stroke are none');
  const frames = F.findFrames(rules);
  assert.equal(frames.length, 1);
  near(frames[0].x0, 80, 1, 'frame left'); near(frames[0].x1, 530, 1, 'frame right'); near(frames[0].y0, 100, 1, 'frame top'); near(frames[0].y1, 200, 1, 'frame bottom');
  // a caption between two rules of the same extent ends a frame: two tables, one above the other
  const cap = block(line(200, 400, 215, 'Table 2: The second one.', 8));
  assert.equal(F.findFrames(F.findRules(F.pageRaster(raster(page, [...tableRules(80, 530, 100, 200), ...tableRules(80, 530, 230, 330)]), page)), [cap]).length, 2);
});
test('analyze: a text-heavy table keeps its left column, and the heading below it stays out', () => {
  // an appendix page that holds only a table: the wrapped description cells look like a column of text at x = 184
  const cap = block(line(214, 398, 100, 'Table 3: Data preprocessing and augmentations.', 8));
  const ops = ['Camera subsampling', 'Bounds filtering', 'Centering', 'Image resize', 'Voxel downsampling', 'Random yaw'].map((t, i) => block(line(87, 87 + t.length * 4, 132 + i * 22, t, 8)));
  const descs = [0, 1, 2, 3, 4, 5].map((i) => block(line(184, 525, 132 + i * 22, 'sample randomized calibrated views per timestep and concatenate them', 8), line(184, 420, 142 + i * 22, 'into a single scene cloud for the model', 8)));
  const head = [block(line(87, 127, 119, 'Operation', 8)), block(line(184, 228, 119, 'Description', 8))];
  const h1 = block(line(54, 66, 290, '3.3', 10)), h2 = block(line(72, 190, 290, 'Physical Experiments', 10));
  const page = { w: W, h: H, blocks: [cap, ...head, ...ops, ...descs, h1, h2, para(54, 558, 310, 12)] };
  const one = () => ({ w: W, h: H, blocks: [para(54, 558, 72, 50)] });
  const figs = F.analyze([one(), one(), one(), page], { 4: raster(page, tableRules(84, 528, 114, 270)) });
  assert.equal(figs.length, 1);
  const b = figs[0].box;
  near(b.x, 81, 2, 'the table starts at its rules, left of the Operation column'); near(b.x + b.w, 531, 2, 'table right');
  near(b.y, 111, 2, 'table top'); near(b.y + b.h, 273, 2, 'the table ends at its bottom rule, above the heading');
  assert.ok(figs[0].confidence >= F.MIN_PLACE);
});
test('analyze: with two tables on a page each caption gets its own frame (captions below the tables)', () => {
  const rowsOf = (y) => [0, 1, 2].map((i) => block(line(140, 470, y + 20 + i * 12, 'Optimizer AdamW with a learning rate of 1e-4 and decay', 8)));
  const c1 = block(line(200, 410, 185, 'Table 6: Architecture of the large model.', 8)), c2 = block(line(200, 410, 305, 'Table 7: Training configuration.', 8)), c3 = block(line(200, 410, 425, 'Table 8: Architecture of the small model.', 8));
  const page = { w: W, h: H, blocks: [...rowsOf(100), c1, ...rowsOf(220), c2, ...rowsOf(340), c3] };
  const one = () => ({ w: W, h: H, blocks: [para(54, 558, 72, 50)] });
  const figs = F.analyze([one(), one(), one(), page], { 4: raster(page, [...tableRules(130, 480, 100, 180), ...tableRules(130, 480, 220, 300), ...tableRules(130, 480, 340, 420)]) });
  const by = Object.fromEntries(figs.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(by).sort(), ['tab-6', 'tab-7', 'tab-8']);
  near(by['tab-6'].box.y, 97, 2, 'Table 6 is the table above its caption'); near(by['tab-7'].box.y, 217, 2, 'Table 7'); near(by['tab-8'].box.y, 337, 2, 'Table 8');
  for (const f of figs) { assert.equal(f.side, 'above'); near(f.box.h, 86, 3, f.key + ' height'); assert.ok(f.confidence >= F.MIN_PLACE, f.key); }
});
test('analyze: an algorithm above a figure is not part of the figure', () => {
  const algoHead = block(line(318, 500, 100, 'Algorithm 1 Terrain edge detection', 9));
  const code = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => block(line(318 + (i % 3) * 8, 470, 118 + i * 11, `${i + 1} if the edge set is empty then return`, 9)));
  const cap = block(line(...RIGHT, 330, 'Fig. 5: Volume points distributed within the foot manifold.', 8));
  const page = { w: W, h: H, blocks: [para(...LEFT, 72, 50), algoHead, ...code, cap, para(...RIGHT, 350, 30)] };
  const rects = [[314, 96, 558, 97], [314, 112, 558, 113], [314, 210, 558, 211], ...drawing(320, 225, 550, 320)];
  const figs = F.analyze([textPage(), textPage(), page], { 3: raster(page, rects) });
  assert.equal(figs.length, 1);
  near(figs[0].box.y, 222, 2, 'the crop starts at the picture, below the bottom rule of the algorithm');
  assert.ok(figs[0].confidence >= F.MIN_PLACE);
});
test('analyze: a table that sticks out of its column does not pull the neighbouring figure across the gutter', () => {
  const tcap = block(line(100, 250, 100, 'TABLE II', 7)), ttitle = block(line(70, 290, 110, 'ESTIMATION RESULTS ON THE OBJECTS', 7));
  const cells = [label(60, 135, 'Cond.', 7), label(120, 135, 'Mass', 7), label(60, 152, 'only', 7), label(120, 152, '0.031', 7)];
  const fcap = block(line(...RIGHT, 300, 'Fig. 3: Objects and surfaces used in the experiments.', 8));
  const page = { w: W, h: H, blocks: [tcap, ttitle, ...cells, para(...LEFT, 200, 40), fcap, para(...RIGHT, 320, 30)] };
  const rects = [...tableRules(54, 311, 128, 165), ...drawing(320, 75, 552, 290)]; // the table reaches 13 pt into the gutter
  const figs = F.analyze([textPage(), textPage(), page], { 3: raster(page, rects) });
  const by = Object.fromEntries(figs.map((f) => [f.key, f]));
  assert.ok(by['fig-3'] && by['tab-2']);
  assert.ok(by['fig-3'].box.x >= 314, 'the figure stays in its column: ' + by['fig-3'].box.x);
  assert.ok(by['tab-2'].box.x + by['tab-2'].box.w <= 316, 'the table ends at its rules: ' + (by['tab-2'].box.x + by['tab-2'].box.w));
  for (const f of figs) assert.ok(f.confidence >= F.MIN_PLACE && !(f.why || []).some((w) => /overlaps/.test(w)), f.key + ' ' + (f.why || []));
});
test('analyze: a caption set beside its plot', () => {
  const cap = block(line(134, 224, 259, 'Fig. 8: Mean SR of', 8), line(134, 224, 270, 'the model over all', 8), line(134, 224, 281, 'tasks with different', 8), line(134, 224, 292, 'numbers of iterations.', 8));
  const page = { w: W, h: H, blocks: [para(134, 480, 100, 12), cap, para(134, 480, 350, 30)] };
  const one = () => ({ w: W, h: H, blocks: [para(134, 480, 72, 55)] });
  const figs = F.analyze([one(), one(), page], { 3: raster(page, drawing(245, 250, 478, 330)) });
  assert.equal(figs.length, 1);
  assert.equal(figs[0].side, 'beside');
  near(figs[0].box.x, 242, 2, 'plot left'); near(figs[0].box.y, 247, 2, 'plot top'); near(figs[0].box.y + figs[0].box.h, 333, 2, 'plot bottom');
});
test('analyze: a row of panel titles at the top of a figure is kept', () => {
  const titles = [block(line(79, 280, 83, 'A Coupling prediction targets to the demonstration', 10)), block(line(304, 514, 83, 'B Resolving execution through self-grounded prediction', 10))];
  const cap = block(line(54, 558, 400, 'Fig. 2 Method overview. The model maps the trajectory onto a shared manifold.', 8));
  const page = { w: W, h: H, blocks: [...titles, cap, para(54, 558, 420, 25)] };
  const one = () => ({ w: W, h: H, blocks: [para(54, 558, 72, 55)] });
  const figs = F.analyze([one(), one(), page], { 3: raster(page, drawing(75, 100, 520, 390)) });
  near(figs[0].box.y, 81, 2, 'the titles are in the crop');
});
test('confidence says how sure the crop is: a failed check puts it under MIN_PLACE, the wording of the caption does not', () => {
  // the same clean figure under "Figure 3: ..." and under "Figure 3 Scaling ..." (no colon): both can be placed
  for (const text of ['Figure 3: Scaling ingredients of the model.', 'Figure 3 Scaling ingredients of the model.']) {
    const page = { w: W, h: H, blocks: [para(...LEFT, 72, 6), block(line(...LEFT, 330, text, 8)), para(...LEFT, 350, 30), para(...RIGHT, 72, 55)] };
    const [f] = F.analyze([textPage(), textPage(), page], { 3: raster(page, drawing(70, 180, 285, 320)) });
    assert.ok(f.confidence >= 0.85, text + ' -> ' + f.confidence);
    assert.equal(f.why, undefined);
  }
  // found from the layout alone (no raster): never placed unasked
  const page = figurePage();
  for (const f of F.analyze([textPage(), textPage(), page], {})) { assert.ok(f.confidence < F.MIN_PLACE, f.key); assert.ok(f.why.includes('no raster')); }
  // a picture that goes on beyond the crop (the neighbouring column holds text, so the crop cannot follow it)
  const cut = { w: W, h: H, blocks: [para(...LEFT, 72, 6), block(line(...LEFT, 330, 'Figure 4: A picture cut at its edge.', 8)), para(...LEFT, 350, 30), para(...RIGHT, 72, 5), para(...RIGHT, 330, 30)] };
  const rects = [[70, 180, 420, 182], [70, 318, 420, 320], [70, 180, 72, 320], [100, 250, 420, 253]];
  const [c] = F.analyze([textPage(), textPage(), cut], { 3: raster(cut, rects) });
  assert.ok(c.confidence < F.MIN_PLACE); assert.deepEqual(c.why, ['cut at the right']);
  // lines of running text inside the crop of a figure
  const tcap = block(line(...LEFT, 430, 'Figure 7: A frame around text.', 8));
  const sentence = (y) => block(line(60, 290, y, 'the model is trained on a large set of robot data', 9));
  const tx = { w: W, h: H, blocks: [label(80, 150, 'x'), sentence(200), sentence(222), sentence(244), tcap, para(...LEFT, 450, 20), para(...RIGHT, 72, 55)] };
  const [t] = F.analyze([textPage(), textPage(), tx], { 3: raster(tx, drawing(56, 140, 296, 420)) });
  assert.ok(t.confidence < F.MIN_PLACE); assert.deepEqual(t.why, ['running text inside']);
  // two crops that overlap: both are doubtful
  const a = block(line(60, 290, 330, 'Figure 5: The left one of two that share a picture.', 8)), b = block(line(60, 290, 345, 'Figure 6: The right one.', 8));
  const two = { w: W, h: H, blocks: [para(...LEFT, 72, 6), a, b, para(...LEFT, 365, 30), para(...RIGHT, 72, 55)] };
  const both = F.analyze([textPage(), textPage(), two], { 3: raster(two, drawing(70, 180, 285, 320)) });
  assert.ok(both.length <= 1 || both.every((f) => f.confidence < F.MIN_PLACE), 'one picture is not placed under two numbers');
});
test('analyze: the same number twice on a page - the certain caption wins before regions are made', () => {
  const real = block(line(...LEFT, 330, 'Table 2. Camera tracking performance on the dataset.', 8));
  const fake = block(line(60, 110, 400, 'Table 2 Sequences', 8)); // weaker wording, further down the column
  const page = { w: W, h: H, blocks: [para(...LEFT, 72, 20), real, label(80, 352, 'Method', 7), label(200, 352, 'Avg.', 7), label(80, 366, 'ours', 7), label(200, 366, '0.42', 7), fake, para(...LEFT, 420, 25), para(...RIGHT, 72, 55)] };
  const figs = F.analyze([textPage(), textPage(), page], { 3: raster(page, tableRules(56, 296, 345, 380)) });
  assert.equal(figs.length, 1);
  near(figs[0].box.y, 342, 2, 'the table below the real caption'); near(figs[0].box.y + figs[0].box.h, 383, 2, 'ends at its bottom rule');
});

// ---------------------------------------------------------------- what the review found (notes)
test('labels are whole words: "stable", "the table below", "config 3" name no figure and never throw', async () => {
  const p = F.parsePlaceholder;
  for (const t of ['The training is stable across seeds.', 'as shown in the table below', 'a notable result', 'table i lists the values', 'Table listing the results', 'the config 3 setting', 'a stable 2 system', '代表 3 种方法']) {
    assert.equal(p('> 📷 待截图：' + t).key, null, t);
    assert.equal(await F.captionFor('abcdef0123', t), null, t);
  }
  assert.equal(p('> 📷 待截图：主要结果的 table（第 6 页）').key, null);
  const r = await F.placeIn('> 📷 待截图：Figure 3（a，第 5 页）\n\n> 📷 待截图：主要结果的 table（第 6 页）\n', resolver([]));
  assert.deepEqual([r.placed.length, r.missed.length], [1, 1], 'one odd placeholder does not stop the others');
});
test('a placeholder is placed only when it opens with ONE figure or table', () => {
  const p = F.parsePlaceholder;
  assert.equal(p('> 📷 待截图：Algorithm 1（伪代码，与 Table 3 并列，第 5 页）').key, null);
  assert.equal(p('> 📷 待截图：overview diagram, see Fig. 2 (p. 4)').key, null);
  for (const t of ['Figure 3-5（三张图，第 2 页）', 'Table 1–3 (all results)', 'Figure 2 and 3 (both)', 'Figure 3、4（对比）', 'Figure 3 to 5 (x)']) { const r = p('> 📷 待截图：' + t); assert.equal(r.key, null, t); assert.equal(r.range, true, t); }
  assert.deepEqual(p('> 📷 待截图：**Figure 3**（方法，第 5 页）'), { kind: 'figure', key: 'fig-3', label: 'Figure 3', desc: '方法', page: 5 });
  assert.equal(p('> 📷 待截图：Figure 6a (left panel, p. 3)').key, 'fig-6');
  assert.deepEqual(p('> 📷 待截图：Figure 7 and Figure 8 (both, p. 9)').keys, ['fig-7', 'fig-8']);
});
test('placeIn leaves code blocks, HTML comments and $$ formulas alone', async () => {
  const ph = '> 📷 待截图：Figure 3（x，第 5 页）';
  const keep = async (md, what) => { const r = await F.placeIn(md, resolver([])); assert.equal(r.markdown, md, what); assert.equal(r.placed.length, 0, what); };
  await keep('````markdown\n```\n' + ph + '\n```\n````\n', 'a longer outer fence is not closed by a shorter inner one');
  await keep('```md\n' + ph + '\n``` not a closing fence\n' + ph + '\n```\n', 'a fence with text after it does not close');
  await keep('~~~\n```\n' + ph + '\n~~~\n', 'another fence character does not close');
  await keep('<!--\n' + ph + '\n-->\n', 'inside an HTML comment');
  await keep('$$\n' + ph + '\n$$\n', 'inside a display formula');
  const after = await F.placeIn('```\ncode\n```\n\n<!-- a comment -->\n\n$$a$$\n\n' + ph + '\n', resolver([]));
  assert.equal(after.placed.length, 1, 'after a closed fence, a one-line comment and a one-line formula the note goes on');
});
test('place(): an uncertain crop stays a placeholder; the same figure twice is one asset; a damaged PDF is analysed once', async () => {
  const id = 'feedc0ffee', ws = process.env.RT_WORKSPACE;
  fs.mkdirSync(path.join(ws, 'pdfs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'pdfs', id + '.pdf'), 'not really a PDF');
  const st = fs.statSync(path.join(ws, 'pdfs', id + '.pdf')), key = `${st.size}-${Math.round(st.mtimeMs)}`;
  const fig = (k, confidence, extra = {}) => ({ key: k, kind: 'figure', number: Number(k.slice(4)), label: 'Figure ' + k.slice(4), page: 2, caption: `Figure ${k.slice(4)}: Caption.`, box: { x: 10, y: 10, w: 200, h: 100 }, pageW: 612, pageH: 792, confidence, side: 'above', wide: false, ...extra });
  fs.mkdirSync(path.join(F.DIR, id), { recursive: true });
  fs.writeFileSync(path.join(F.DIR, id, 'index.json'), JSON.stringify({ v: F.VERSION, key, figures: [fig('fig-1', 0.95), fig('fig-2', 0.4, { why: ['cut at the left'] })] }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(F.DIR, id, 'fig-1-160.png'), png); fs.writeFileSync(path.join(F.DIR, id, 'fig-2-160.png'), png);
  const note = '> 📷 待截图：Figure 1（好的，第 2 页）\n\ntext\n\n> 📷 待截图：Figure 2（不确定，第 2 页）\n\n> 📷 待截图：Figure 1（再一次，第 2 页）\n';
  const r = await F.place(id, note, { language: 'zh' });
  assert.deepEqual(r.placed.map((x) => x.key), ['fig-1', 'fig-1']);
  assert.equal(r.placed[0].url, r.placed[1].url, 'one stored asset');
  assert.equal(fs.readdirSync(path.join(ws, 'notes', 'assets', id)).length, 1);
  assert.equal(r.missed.length, 1); assert.match(r.missed[0].reason, /uncertain \(cut at the left\)/);
  assert.ok(r.markdown.includes('> 📷 待截图：Figure 2（不确定，第 2 页）'), 'the uncertain one is left as it is');
  assert.equal((await F.place(id, r.markdown)).markdown, r.markdown, 'placing again changes nothing');
  // asked for by name (the picker, keys: [...]) it is placed
  assert.deepEqual((await F.place(id, r.markdown, { keys: ['fig-2'] })).placed.map((x) => x.key), ['fig-2']);
  // the prompt list carries only what can be placed, and only up to the page the draft reads
  assert.equal((await F.promptList(id)).text, 'Figure 1 (p. 2): Caption.');
  assert.equal((await F.promptList(id, { maxPage: 1 })).count, 0);
  // Ask Claude gets caption and page of a figure the passage names, from the cache only
  assert.deepEqual(await F.captionFor(id, 'What does Figure 1 show?'), { caption: 'Figure 1: Caption. (p. 2)', page: 2, key: 'fig-1' });
  assert.equal(await F.captionFor(id, 'see figure 1 and the stable result'), null, 'a label is written with a capital');
  assert.equal(F.countPlaceholders(note), 3); assert.equal(F.countPlaceholders(r.markdown), 1);
  // a list that failed is remembered for this file
  fs.writeFileSync(path.join(F.DIR, id, 'index.json'), JSON.stringify({ v: F.VERSION, key, figures: [], failed: 'pdftotext failed: damaged' }));
  F.drop('0000000000'); // (another paper: nothing happens)
  const info = {};
  // (memory still holds the good list; a fresh process would read the failed one from disk)
  assert.ok(Array.isArray(await F.list(id, info)));
});

Promise.all(pending).then(() => {
  fs.rmSync(process.env.RT_WORKSPACE, { recursive: true, force: true });
  console.log(failed ? `\n${failed} test(s) failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
});
