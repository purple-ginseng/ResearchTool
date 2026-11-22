#!/usr/bin/env node
// Round-trip tests for lib/notejson.js (note JSON draft <-> Markdown).   Run:  node scripts/test-notejson.js
//   1. templates/literature-note-guide.md       md -> json -> md must be byte-identical
//   2. a synthetic note with every construct the note editor can produce: byte-identical, and json -> md -> json
//      must give the same document again (so nothing is lost in either direction)
//   3. constructs that only degrade gracefully (footnotes, task lists from other editors, unknown nodes)
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { toMarkdown, fromMarkdown, CALLOUTS } = require('../lib/notejson');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 12).join('\n     ')); }
}
function firstDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `line ${i + 1}:\n  expected ${JSON.stringify(A[i])}\n  actual   ${JSON.stringify(B[i])}`;
  return 'identical';
}
const same = (expected, actual) => assert.ok(expected === actual, firstDiff(expected, actual));
const types = (doc) => { const out = []; (function walk(n) { out.push(n.type); (n.content || []).forEach(walk); })(doc); return out; };

const SYNTHETIC = `# 摘要

> [!abstract] 🏕️
> 本文提出 **TinyFlow**，基于 $W_t$ 的方法，成功率 87.5%。
>
> 第二段，含 ==重点== 。

# 研究背景

> [!background] 🦄
> 背景介绍

普通段落，含 **加粗**、*斜体*、~~删除~~、\`inline code\`、[链接](https://example.org/a_b) 和行内公式 $\\tau_t = s(1-u)$。

关键结论用 ==淡黄色高亮==，概念句用 <mark style="background-color:rgba(205,178,250,0.7)">淡紫色高亮</mark>，还有 <span style="color:rgb(216,57,49)">红色文字</span>。

# 方法论

> 📷 待截图：Figure 1（方法框架，第 3 页）

## 模块一

> [!key] 🍞
> 重点讲解

> [!concept] ✏️
> 概念解释

$$
W_t = W_{t-1} - \\eta \\nabla f(W_{t-1}; z_t)
$$

| **物理量** | **物理含义** |
| :---: | --- |
| $\\mathcal{D} = \\{\\xi^{(i)}\\}_{i=1}^N$ | • 包含 $N$ 条轨迹的训练数据集。<br>• 第二点 |
| $\\tau_t$ | • 噪声水平 |

| **阶段** | **步骤** | **具体流程** |
| --- | --- | --- |
| 训练 | 1 | 前向传播 a \\| b |
| 推理 | 2 | 初始化 |

## 列表

- 无序一
  - 嵌套
- 无序二

1. 有序一
2. 有序二

- [ ] 待办
- [x] 已完成

![Figure (p. 3)](/api/items/abc123/note/assets/0123456789abcdef0123456789abcdef01234567.png)

[📎 supplement.pdf](/files/supplement.pdf)

\`\`\`python
def f(x):
    return x  # | not a table | $not math$

\`\`\`

<div align="center">居中的一行</div>

---

# 总结

1. 局限性（待核实）
2. 思考[^1]

[^1]: 脚注内容
`;

test('guide: md -> json -> md is byte-identical', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'literature-note-guide.md'), 'utf8');
  same(md, toMarkdown(fromMarkdown(md)));
});
test('guide: converts to the expected node types', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'templates', 'literature-note-guide.md'), 'utf8');
  const t = types(fromMarkdown(md));
  // (the guide no longer embeds example images - they pointed at a route that does not exist; 'media' is covered by the synthetic note)
  for (const k of ['heading', 'callout', 'table', 'orderedList', 'inlineFormula']) assert.ok(t.includes(k), 'missing node type ' + k);
});
test('synthetic note: md -> json -> md is byte-identical', () => same(SYNTHETIC, toMarkdown(fromMarkdown(SYNTHETIC))));
test('synthetic note: json -> md -> json is stable', () => {
  const doc = fromMarkdown(SYNTHETIC);
  assert.deepEqual(fromMarkdown(toMarkdown(doc)), doc);
});
test('synthetic note: every construct maps to a node', () => {
  const doc = fromMarkdown(SYNTHETIC), t = types(doc);
  for (const k of ['heading', 'paragraph', 'callout', 'blockquote', 'table', 'tableHeader', 'tableCell', 'bulletList', 'orderedList', 'listItem', 'media', 'codeBlock', 'horizontalRule', 'inlineFormula'])
    assert.ok(t.includes(k), 'missing node type ' + k);
  const callouts = doc.content.filter((n) => n.type === 'callout');
  assert.deepEqual(callouts.map((c) => c.attrs.fill), ['abstract', 'background', 'key', 'concept'].map((k) => CALLOUTS[k].fill));
  const display = doc.content.find((n) => n.type === 'paragraph' && n.attrs.textAlign === 'center' && n.content?.[0]?.type === 'inlineFormula');
  assert.ok(display, 'display formula is a centred paragraph holding one formula');
  const qty = doc.content.find((n) => n.type === 'table');
  assert.equal(qty.content[1].content[0].content[0].attrs.textAlign, 'center', 'symbol column is centred');
  assert.equal(qty.content[1].content[1].content[0].type, 'bulletList', 'meaning column holds a bullet list');
  assert.equal(qty.content[1].content[1].content[0].content.length, 2);
  const marks = JSON.stringify(doc);
  assert.ok(marks.includes('rgba(255,246,122,0.8)'), 'yellow highlight');
  assert.ok(marks.includes('rgba(205,178,250,0.7)'), 'purple highlight');
  const code = doc.content.find((n) => n.type === 'codeBlock');
  assert.equal(code.attrs.language, 'python');
  assert.ok(code.content[0].text.includes('| not a table | $not math$'));
});
test('task lists keep their state', () => {
  const doc = fromMarkdown('- [ ] a\n- [x] b\n');
  assert.deepEqual(doc.content[0].content.map((li) => li.attrs.checked), [false, true]);
  // taskList / taskItem nodes written by other Tiptap editors map to the same Markdown
  const other = { type: 'doc', content: [{ type: 'taskList', content: [
    { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
    { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'open' }] }] }] }] };
  same('- [x] done\n- [ ] open\n', toMarkdown(other));
});
test('footnotes degrade to literal text', () => {
  const md = '结论[^1]，见[^note-2]。\n\n[^1]: 第一条\n';
  same(md, toMarkdown(fromMarkdown(md)));
  assert.ok(JSON.stringify(fromMarkdown(md)).includes('[^1]'));
});
test('unknown nodes keep their text', () => {
  const doc = { body: { type: 'doc', content: [{ type: 'mysteryBlock', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] }, { type: 'mysteryLeaf', text: 'also kept' }] } };
  const md = toMarkdown(doc);
  assert.ok(md.includes('kept') && md.includes('also kept'), md);
});
test('a callout without emoji gets the default icon', () => {
  same('> [!key] 🍞\n> text\n', toMarkdown(fromMarkdown('> [!key]\n> text\n')));
});
test('full draft object carries the meta data', () => {
  const d = fromMarkdown('# T\n', { title: 'Paper', format: 'Markdown', category: 'Robotics', tags: ['a', 'b'] });
  assert.equal(d.title, 'Paper'); assert.equal(d.format, 'Markdown'); assert.equal(d.category, 'Robotics');
  assert.deepEqual(d.tags, ['a', 'b']); assert.equal(d.body.type, 'doc');
  same('# T\n', toMarkdown(d));
});
test('not a draft -> clear error', () => assert.throws(() => toMarkdown({ foo: 1 }), /Not a note JSON draft/));

console.log(failed ? `\n${failed} test(s) failed` : '\nall notejson tests passed');
process.exit(failed ? 1 : 0);
