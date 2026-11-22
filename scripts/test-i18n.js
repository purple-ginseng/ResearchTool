#!/usr/bin/env node
// Tests for the display language layer: the pure translator of public/js/i18n.js with the Chinese dictionary
// (public/js/i18n/zh.js), and the string extraction of scripts/i18n-extract.js. No browser, no server.
// Run:  node scripts/test-i18n.js
'use strict';
const assert = require('node:assert/strict');
const I = require('../public/js/i18n.js');
const zh = require('../public/js/i18n/zh.js');
const X = require('./i18n-extract.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

// ---------- a small dictionary: the engine ----------
const mini = I.createTranslator({
  dict: {
    Save: '保存', 'Search…': '搜索…', Tags: '标签', today: '今天', 'not cited': '未引用',
    'Deleted {0}': '已删除 {0}', 'Merged “{0}” into “{1}”': '已将“{0}”合并到“{1}”', 'Moved {0} into {1}': '已将 {0} 移入 {1}',
    'Page {0} of {1}': '第 {0} / {1} 页', 'In “{0}”': '在“{0}”中', 'No backup yet': '还没有备份', '{0} - see Settings': '{0}——见设置',
    'x{0}y': 'should never be used (too short to be specific)',
  },
  keep: ['BibTeX'],
  rules: [[/^(\d+) papers?$/, '$1 篇论文'], [/^(\d+) (\w+)$/, (m) => (m[2] === 'files' ? `${m[1]} 个文件` : null)]],
});

t('exact match, white space around it is kept', () => {
  assert.equal(mini.translate('Save'), '保存');
  assert.equal(mini.translateText('  Save\n'), '  保存\n');
  assert.equal(mini.translateText('Unknown words'), null);
  assert.equal(mini.translateText('   '), null);
});

t('keep list counts as translated but changes nothing', () => {
  assert.equal(mini.translate('BibTeX'), 'BibTeX');
  assert.equal(mini.translateText('BibTeX'), null); // nothing to replace in the DOM
});

t('placeholders: captures are put back, order can change', () => {
  assert.equal(mini.translate('Merged “A” into “B”'), '已将“A”合并到“B”');
  assert.equal(mini.translate('Page 3 of 12'), '第 3 / 12 页');
  assert.equal(mini.translate('In “My project”'), '在“My project”中'); // 2 letters but 5 characters of literal text
});

t('a capture that is a count is translated by the rules', () => {
  assert.equal(mini.translate('Deleted 3 papers'), '已删除 3 篇论文');
  assert.equal(mini.translate('Deleted 1 paper'), '已删除 1 篇论文');
  assert.equal(mini.translate('Moved 12 files into Archive'), '已将 12 个文件 移入 Archive');
});

t('a capture that is user content stays as it is, even when it is a UI word', () => {
  assert.equal(mini.translate('Deleted Save'), '已删除 Save'); // "Save" might be a tag or a title
  assert.equal(mini.translate('Merged “Tags” into “today”'), '已将“Tags”合并到“today”');
});

t('a capture that is a whole UI sentence is translated', () => {
  assert.equal(mini.translate('No backup yet - see Settings'), '还没有备份——见设置');
});

t('keys without enough literal text never match', () => {
  assert.equal(mini.translate('xAy'), null);
});

t('rules: a function rule may decline', () => {
  assert.equal(mini.translate('4 files'), '4 个文件');
  assert.equal(mini.translate('4 cats'), null);
});

t('trailing punctuation and parentheses fall back to the bare words', () => {
  assert.equal(mini.translate('Tags:'), '标签：');
  assert.equal(mini.translate('Save.'), '保存。');
  assert.equal(mini.translate('(Save)'), '（保存）');
});

t('pieces joined by a middle dot are translated one by one', () => {
  assert.equal(mini.translateText(' · today'), ' · 今天');
  assert.equal(mini.translate('3 papers · not cited'), '3 篇论文 · 未引用');
  assert.equal(mini.translate('Smith et al. · 3 papers'), 'Smith et al. · 3 篇论文'); // an unknown piece (a name) stays
});

t('format(): templates with arguments, English and Chinese', () => {
  assert.equal(mini.format('en', 'Deleted {0}', ['3 papers']), 'Deleted 3 papers');
  assert.equal(mini.format('zh', 'Deleted {0}', ['3 papers']), '已删除 3 篇论文');
  assert.equal(mini.format('zh', 'Save', []), '保存');
  assert.equal(mini.format('zh', 'Not in the dictionary', []), 'Not in the dictionary');
});

// ---------- the real dictionary ----------
const real = I.createTranslator(zh);
t('the Chinese dictionary loads and is well formed', () => {
  assert.ok(Object.keys(zh.dict).length > 2500, 'at least 2500 entries');
  for (const [k, v] of Object.entries(zh.dict)) {
    assert.equal(typeof v, 'string', k);
    assert.ok(v.length, `empty translation for ${k}`);
    const ks = new Set([...k.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));
    for (const m of v.matchAll(/\{(\d+)\}/g)) assert.ok(ks.has(m[1]), `placeholder {${m[1]}} of the translation is not in “${k}”`);
  }
  for (const r of zh.rules) assert.ok(r[0] instanceof RegExp);
});

t('the Chinese dictionary: common strings', () => {
  assert.equal(real.translate('Cancel'), '取消');
  assert.equal(real.translate('Preferences'), '偏好设置');
  assert.equal(real.translate('Display language'), '显示语言');
  assert.equal(real.translate('First-draft language'), '初稿语言');
  assert.equal(real.translate('Search…'), '搜索…');
});

t('the Chinese dictionary: counts and dynamic strings', () => {
  assert.equal(real.translate('3 papers'), '3 篇论文');
  assert.equal(real.translate('1 question'), '1 道题');
  assert.equal(real.translate('12 entries'), '12 个条目');
  assert.equal(real.translate('Deleted 3 papers'), '已删除 3 篇论文');
  assert.equal(real.translate('Merged “A” into “B” (2 papers)'), '已将“A”合并到“B”（2 篇论文）');
  assert.equal(real.translate('Question 2 of 10'), '第 2 / 10 题');
  assert.equal(real.translate('5 days ago'), '5 天前');
  assert.equal(real.translate('p. 7 of 20'), '第 7 / 20 页');
});

t('the Chinese dictionary: a metadata line keeps the names and translates the rest', () => {
  assert.equal(real.translate('Dong et al. · 2026 · not cited'), 'Dong et al. · 2026 · 未引用');
  assert.equal(real.translate('3 papers · 3 reading · 0 cited'), '3 篇论文 · 3 在读 · 0 已引用');
  assert.equal(real.translateText(' · today'), ' · 今天');
  assert.equal(real.translate('Reading - click to change the reading status'), '在读——点击更改阅读状态'); // a status is a captureWord
});

t('the Chinese dictionary: technical names stay', () => {
  for (const s of ['BibTeX', 'Overleaf', 'Markdown']) assert.equal(real.translate(s) ?? s, s);
  assert.match(real.translate('Copy BibTeX'), /BibTeX/);
  assert.match(real.translate('Download PDF'), /PDF/);
});

t('user content is left alone: titles and names that are not UI strings', () => {
  for (const s of ['Attention Is All You Need', 'Diffusion Policy: Visuomotor Policy Learning via Action Diffusion', 'Smith et al.', 'World Models']) assert.equal(real.translateText(s), null, s);
});

t('the skip list covers the editors, the PDF text and the paper data', () => {
  for (const sel of ['[data-i18n-skip]', '.vditor', '.vditor-reset', '.CodeMirror', '.textLayer', 'textarea', 'code', 'pre', '.au']) assert.ok(I.SKIP.split(', ').includes(sel), sel);
});

// ---------- extraction ----------
t('a placeholder at the edge of a key does not take a sentence fragment', () => {
  // "{0} papers" / "{0} found" / "Show {0}" / "New {0}" must not give "Lineage of your 篇论文", "找到 1 not", "新建quiz: …"
  assert.equal(real.translate('Lineage of your papers'), '你的论文的脉络');
  assert.equal(real.translate('Show all papers'), null);
  assert.equal(real.translate('Delete 3 papers'), null);
  assert.equal(real.translate('0 of 0 papers · 1 not found'), '0 / 0 篇论文 · 1 个未找到');
  assert.equal(real.translate('Open in somewhere'), null); // "Open {0}" does not take "in somewhere"
  assert.equal(real.translate('Open in reader'), '在阅读器中打开'); // its own entry
  assert.ok(!/quiz:/.test(real.translate('New quiz: let Claude write another set of questions (another level or focus)')));
  // a count, a title and a delimited capture still work
  assert.equal(real.translate('12 papers'), '12 篇论文');
  assert.equal(real.translate('Found in: paper p. 1 (link)'), '来源：paper p. 1 (link)');
  assert.equal(real.translate('Deleted Causal Dynamics Learning for Task-Independent State Abstraction'), '已删除 Causal Dynamics Learning for Task-Independent State Abstraction');
});

t('a count-noun key takes only a count, not a reading status ("Reading papers" is not "在读 篇论文")', () => {
  const k = I.createTranslator({ dict: { '{0} papers': '{0} 篇论文', Reading: '在读' }, captureWords: ['Reading'], rules: [[/^(\d+) papers?$/, '$1 篇论文']] });
  assert.equal(k.translate('Reading papers'), null);
  assert.equal(k.translate('3 papers'), '3 篇论文');
  assert.equal(real.translate('Reading papers'), '在读的论文');
});

t('a tooltip of several lines keeps its lines; pieces joined by " · " are translated line by line', () => {
  assert.equal(real.translate('OpenVLA\nKim 2024 · last author Finn · cited 1,234\nCited by 5 of these papers · in your library'),
    'OpenVLA\nKim 2024 · 末位作者 Finn · 被引 1,234\n被其中 5 篇论文引用 · 在你的文献库中');
  assert.equal(real.translate('Attention Is All You Need\n→ VLA: 3 papers cite it'), 'Attention Is All You Need\n→ VLA：3 篇论文引用了它');
});

t('Lineage: compound forms and the reasons of a row, sentence by sentence', () => {
  assert.equal(real.translate('12 papers · 10 known to OpenAlex · 9 with references · computed 3 h ago'), '12 篇论文 · OpenAlex 收录 10 篇 · 9 篇有参考文献 · 3 小时前计算');
  assert.equal(real.translate('Undo: take it out of “Thesis” again (the library keeps it)'), '撤销：把它再移出“Thesis”（文献库仍保留它）');
  assert.equal(real.translate('Added 3 works · 2 already in your library'), '已添加 3 篇工作 · 2 篇已在你的文献库中');
  assert.equal(real.translate('Semantic Scholar gives intents for 3 of the 5 citing papers: 2 use its method; 1 cites it as influential.'), 'Semantic Scholar 给出了 5 篇施引论文中 3 篇的引用意图：2 篇使用了它的方法；1 篇将其引用标为有影响力。');
  assert.equal(real.translate('Cited by 5 of these 12 papers and by no other paper of your library.'), '被这 12 篇论文中的 5 篇引用，未被你文献库中的其他论文引用。');
  assert.equal(real.translate('Relevance 4.2.'), '相关度 4.2。');
});

t('an optional count: the key without it wins, a count with its space is translated', () => {
  assert.equal(real.translate('Add to “My project”'), '添加到“My project”');
  assert.equal(real.translate('Move to category…'), '移到类别…');
  assert.equal(real.translate('Move 3 papers to category…'), '将 3 篇论文移到类别…');
  assert.equal(real.translate('0 of 1 entry'), '0 / 1 个条目');
});

t('a confirm of several paragraphs: the key has one space, the text keeps its line breaks', () => {
  assert.equal(real.translate('Replace the current note with a new draft written by Claude?\n\nThe current note stays in History, so it can be restored.'),
    '用 Claude 写的新草稿替换当前笔记？\n\n当前笔记会保留在历史中，可以恢复。');
  assert.equal(real.translate('Delete the quiz “Q1”?\n\nIts questions and your answers are deleted, and this cannot be undone.'), '删除测验“Q1”？\n\n其题目和你的答案都会被删除，且无法撤销。');
  assert.equal(real.translateText('  Delete the box “A” and its 2 arrows?\n\nIts explanation and examples are deleted with it. Undo in the bar brings it back.\n'),
    '  删除方框“A”及其 2 个箭头？\n\n其解释和示例也会一并删除。工具栏中的撤销可以恢复。\n');
  // sentence counts that differ: the translation without the breaks, never a wrong cut
  const m2 = I.createTranslator({ dict: { 'One. Two.': '一二。' } });
  assert.equal(m2.translate('One.\n\nTwo.'), '一二。');
});

t('review pass 2: exact keys over a placeholder that would capture an English word', () => {
  assert.equal(real.translate('Origin papers'), '起源论文');
  assert.equal(real.translate('Highlight in yellow'), '用黄色高亮');
  assert.equal(real.translate('Highlight in pink (stays on the page)'), '用粉色高亮（保留在页面上）');
  assert.equal(real.translate('Open arXiv'), '打开 arXiv');
  assert.equal(real.translate('Compile'), '编译');
  assert.equal(real.translate('Tokens'), 'Token 数');
  const m3 = I.createTranslator({ dict: { '{0} papers': '{0} 篇论文', '{0} copied': '已复制 {0}' }, rules: [[/^(\d+) papers?$/, '$1 篇论文']] });
  assert.equal(m3.translate('Seminal papers'), null); // a heading, not a count
  assert.equal(m3.translate('3 papers'), '3 篇论文');
  assert.equal(m3.translate('BibTeX copied'), '已复制 BibTeX'); // not a count noun: a single name still fills it
});

t('extraction: HTML text, attributes and placeholders', () => {
  const pieces = X.htmlPieces('<button title="Save the note" aria-label="Save">Save &amp; close</button> <i>x</i>');
  assert.ok(pieces.includes('Save the note') && pieces.includes('Save') && pieces.some((p) => p.includes('Save & close')));
  const toks = X.lex('const a = `<b>${n}</b> papers in “${esc(name)}”`; toast("Could not save: " + e.message); // "comment"\n const re = /"x"/g;');
  const strs = toks.map((k) => k.parts.map((p) => (typeof p === 'string' ? p : '${}')).join(''));
  assert.ok(strs.includes('Could not save: '));
  assert.ok(!strs.some((s) => s.includes('comment')), 'comments are not strings');
  assert.ok(!strs.some((s) => s === 'x'), 'regex literals are not strings');
});

t('extraction: what counts as UI text', () => {
  for (const s of ['Save', 'Delete {0} papers?', 'Could not save:', 'today and tomorrow']) assert.ok(X.isUiText(s, false), s);
  for (const s of ['library:changed', '.item, .grp', '#dlg-settings', '/api/settings', 'ib small', 'Content-Type', 'rgba(0,0,0,.2)', 'M3 8h10', 'camelCase', 'click']) assert.ok(!X.isUiText(s, false) || s === 'Content-Type', s);
});

t('extraction: runs on the code and reports coverage', () => {
  const all = X.extract();
  assert.ok(all.size > 1500, `found ${all.size} strings`);
  const notUi = new Set(zh.notUi);
  let total = 0, done = 0;
  for (const s of all.keys()) { if (notUi.has(s)) continue; total++; if (real.translate(s) !== null) done++; }
  const pct = (done / total) * 100;
  console.log(`   coverage: ${done}/${total} = ${pct.toFixed(1)}%`);
  assert.ok(pct >= 95, `coverage ${pct.toFixed(1)}% is below 95%`);
});

console.log(`\n${n} tests passed`);
