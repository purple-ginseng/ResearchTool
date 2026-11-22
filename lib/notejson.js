// Converter between the note app's JSON draft format (a Tiptap/ProseMirror document under `body`)
// and Markdown. Mapping (both directions):
//
//   heading {level}                         <->  #, ##, ...
//   paragraph                               <->  plain paragraph
//   paragraph {textAlign: center}           <->  <div align="center">…</div>
//   centered paragraph holding one formula  <->  $$ latex $$            (display formula)
//   inlineFormula {latex}                   <->  $latex$
//   hardBreak                               <->  <br>
//   marks: bold / italic / strike / code    <->  **x** / *x* / ~~x~~ / `x`
//   mark link {href}                        <->  [x](href)
//   mark textStyle {backgroundColor}        <->  ==x==  (yellow)  or  <mark style="background-color:…">x</mark>
//   mark textStyle {color}                  <->  <span style="color:…">x</span>
//   callout {fill, border, icon}            <->  > [!abstract|key|concept|background|note] <emoji>
//                                                > body…                (type is derived from the fill colour)
//   bulletList / orderedList {start} / listItem  <->  "- " / "N. " lists, nested by indentation
//   table / tableRow / tableHeader / tableCell   <->  GFM pipe table; bullet lists inside a cell become "• a<br>• b"
//   media {kind: image, src, alt}           <->  ![alt](src)
//   media {kind: file|video, src, name}     <->  [📎 name](src)
//   codeBlock {language}                    <->  ``` fenced block
//   blockquote                              <->  > quote
//   horizontalRule                          <->  ---
//   task list ("- [ ] a" / "- [x] b")       <->  bulletList whose listItems carry attrs.checked (true/false); a
//                                                taskList / taskItem node from other editors maps to the same Markdown
//   footnotes ("x[^1]" and "[^1]: text")    <->  kept as literal text (the note app has no footnote node)
//
// Anything unknown is rendered through its children so no text is lost.

const CALLOUTS = {
  abstract:   { fill: 'rgb(217,245,214)', border: 'rgb(142,224,133)', icon: '🏕️', label: '摘要' },          // green
  key:        { fill: 'rgb(253,226,226)', border: 'rgb(249,142,139)', icon: '🍞', label: '重点讲解' },       // red
  concept:    { fill: 'rgb(236,226,254)', border: 'rgb(173,130,247)', icon: '✏️', label: '概念解释' },       // purple
  background: { fill: 'rgb(254,234,210)', border: 'rgb(255,186,107)', icon: '🦄', label: '背景介绍' },       // orange
  note:       { fill: 'rgb(242,243,245)', border: 'rgb(222,224,227)', icon: '📝', label: '备注' },           // grey / unknown
};
const YELLOW = 'rgba(255,246,122,0.8)';
const norm = (c) => String(c || '').replace(/\s+/g, '').toLowerCase();
const calloutType = (fill) => Object.keys(CALLOUTS).find((k) => norm(CALLOUTS[k].fill) === norm(fill)) || 'note';

// ---------------------------------------------------------------- JSON -> Markdown
const escText = (s) => String(s).replace(/([\\`*_$\[\]<])/g, '\\$1').replace(/\\\[\^([^\s\]\\]+)\\\]/g, '[^$1]'); // footnote refs stay literal

function inlineToMd(nodes = []) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'hardBreak') { out += '<br>'; continue; }
    if (n.type === 'inlineFormula' || n.type === 'formula' || n.type === 'math') { out += wrapMarks(`$${String(n.attrs?.latex ?? '').trim()}$`, n.marks, true); continue; }
    if (n.type === 'text') { out += wrapMarks(n.text ?? '', n.marks); continue; }
    if (n.type === 'image') { out += `![${escText(n.attrs?.alt || '')}](${n.attrs?.src || ''})`; continue; }
    if (n.type === 'mention') { out += '@' + escText(n.attrs?.label || n.attrs?.id || ''); continue; }
    if (n.content) out += inlineToMd(n.content); else if (n.text) out += escText(n.text);
  }
  return out;
}

function wrapMarks(text, marks = [], raw = false) {
  const has = (t) => marks.some((m) => m.type === t);
  if (has('code') && !raw) return '`' + String(text).replace(/`/g, "'") + '`';
  // keep leading/trailing spaces outside the emphasis markers so the Markdown stays valid
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(text));
  let core = raw ? m[2] : escText(m[2]);
  if (!core) return text;
  const formulaBoldOnly = raw && marks.every((x) => x.type === 'bold'); // a bold formula is just a formula
  if (!formulaBoldOnly) {
    if (has('bold')) core = `**${core}**`;
    if (has('italic')) core = `*${core}*`;
    if (has('strike')) core = `~~${core}~~`;
    if (has('underline')) core = `<u>${core}</u>`;
    const ts = marks.find((x) => x.type === 'textStyle' || x.type === 'highlight');
    if (ts?.attrs?.color && ts.type === 'textStyle') core = `<span style="color:${ts.attrs.color}">${core}</span>`;
    const bg = ts?.attrs?.backgroundColor || (ts?.type === 'highlight' ? ts.attrs?.color || YELLOW : null);
    if (bg) core = norm(bg) === norm(YELLOW) ? `==${core}==` : `<mark style="background-color:${bg}">${core}</mark>`;
    const link = marks.find((x) => x.type === 'link');
    if (link?.attrs?.href) core = `[${core}](${link.attrs.href})`;
  }
  return m[1] + core + m[3];
}

const isEmptyPara = (n) => n.type === 'paragraph' && !(n.content || []).length;
const soleFormula = (n) => {
  const c = (n.content || []).filter((x) => !(x.type === 'text' && !String(x.text).trim()));
  return c.length === 1 && c[0].type === 'inlineFormula' ? c[0] : null;
};

function blocksToMd(nodes = [], ctx = {}) {
  const out = [];
  for (const n of nodes) {
    const md = blockToMd(n, ctx);
    if (md != null && md !== '') out.push(md);
  }
  return out.join('\n\n');
}

function blockToMd(n, ctx) {
  switch (n.type) {
    case 'heading': {
      const t = inlineToMd(n.content).trim();
      return t ? '#'.repeat(Math.min(6, Math.max(1, n.attrs?.level || 1))) + ' ' + t : null;
    }
    case 'paragraph': {
      if (isEmptyPara(n)) return null;
      const center = n.attrs?.textAlign === 'center';
      const f = soleFormula(n);
      if (f && center && !ctx.inCell) return `$$\n${String(f.attrs.latex).trim()}\n$$`;
      const t = inlineToMd(n.content).trim();
      if (!t) return null;
      return center && !ctx.inCell ? `<div align="center">${t}</div>` : t.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, '$1\\$2');
    }
    case 'blockFormula': case 'formulaBlock': case 'mathBlock':
      return `$$\n${String(n.attrs?.latex ?? inlineToMd(n.content)).trim()}\n$$`;
    case 'callout': {
      const type = calloutType(n.attrs?.fill);
      const icon = n.attrs?.icon?.value || '';
      const body = blocksToMd(n.content, ctx);
      return [`> [!${type}]${icon ? ' ' + icon : ''}`, ...(body ? body.split('\n').map((l) => (l ? '> ' + l : '>')) : [])].join('\n');
    }
    case 'blockquote':
      return blocksToMd(n.content, ctx).split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
    case 'bulletList': case 'orderedList': case 'taskList': return listToMd(n, ctx);
    case 'table': return tableToMd(n);
    case 'media': case 'image': {
      const a = n.attrs || {};
      if (!a.src) return null;
      if ((a.kind || 'image') === 'image') return `![${escText(String(a.alt || a.name || '').replace(/\s+/g, ' '))}](${encodeURI(a.src)})`;
      if (a.kind === 'video' && /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(a.src)) return `<video src="${encodeURI(a.src).replace(/"/g, '%22')}" controls preload="metadata" width="${Number(a.width) || 480}"></video>`;
      return `[📎 ${escText(a.name || 'file')}](${encodeURI(a.src)})`;
    }
    case 'codeBlock': {
      const code = (n.content || []).map((c) => c.text || '').join('');
      return '```' + (n.attrs?.language || '') + '\n' + code + '\n```';
    }
    case 'horizontalRule': return '---';
    default:
      if (n.content) return n.content.some((c) => c.type === 'text' || c.type === 'inlineFormula') ? inlineToMd(n.content).trim() : blocksToMd(n.content, ctx);
      return n.text ? escText(n.text) : null;
  }
}

function listToMd(list, ctx) {
  const ordered = list.type === 'orderedList';
  let num = Number(list.attrs?.start) || 1;
  const lines = [];
  for (const item of list.content || []) {
    const task = list.type === 'taskList' || typeof item.attrs?.checked === 'boolean';
    const marker = ordered ? `${num++}. ` : task ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- ';
    // a nested list directly follows its parent text (tight list); other blocks are separated by a blank line
    let body = '';
    for (const child of item.content || []) {
      const md = blockToMd(child, ctx);
      if (md == null || md === '') continue;
      body += (body ? (/List$/.test(child.type) ? '\n' : '\n\n') : '') + md;
    }
    const pad = ' '.repeat(ordered ? marker.length : 2);
    body.split('\n').forEach((l, i) => lines.push(i === 0 ? marker + l : l ? pad + l : ''));
  }
  return lines.join('\n');
}

function cellToMd(cell) {
  const parts = [];
  for (const b of cell.content || []) {
    if (b.type === 'paragraph') { const t = inlineToMd(b.content).trim(); if (t) parts.push(t); }
    else if (b.type === 'bulletList' || b.type === 'orderedList') {
      const items = (b.content || []).map((li, i) => (b.type === 'orderedList' ? `${i + 1}. ` : '• ') + blocksToMd(li.content, { inCell: true }).replace(/\n+/g, '<br>').trim());
      parts.push(items.length === 1 && b.type === 'bulletList' && !(cell.content.length > 1) ? items[0] : items.join('<br>'));
    } else { const t = blockToMd(b, { inCell: true }); if (t) parts.push(t.replace(/\n+/g, '<br>')); }
  }
  return parts.join('<br>').replace(/\|/g, '\\|') || ' ';
}

function tableToMd(table) {
  const rows = (table.content || []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return null;
  const cols = Math.max(...rows.map((r) => (r.content || []).length));
  const grid = rows.map((r) => Array.from({ length: cols }, (_, i) => (r.content?.[i] ? cellToMd(r.content[i]) : ' ')));
  const hasHeader = (rows[0].content || []).every((c) => c.type === 'tableHeader');
  const header = hasHeader ? grid.shift() : Array(cols).fill(' ');
  const centered = (ci) => { // a column is centred when all of its body cells hold centred paragraphs
    const body = rows.slice(hasHeader ? 1 : 0).map((r) => r.content?.[ci]).filter(Boolean);
    return body.length > 0 && body.every((c) => (c.content || []).every((p) => p.type === 'paragraph' && p.attrs?.textAlign === 'center'));
  };
  const sep = Array.from({ length: cols }, (_, i) => (centered(i) ? ':---:' : '---'));
  return [header, sep, ...grid].map((r) => '| ' + r.join(' | ') + ' |').join('\n');
}

function toMarkdown(input) {
  const doc = input?.body?.type === 'doc' ? input.body : input?.type === 'doc' ? input : null;
  if (!doc) throw new Error('Not a note JSON draft: expected a "body" object of type "doc".');
  return blocksToMd(doc.content).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------------------------------------------------------------- Markdown -> JSON
const P = (content, extra = {}) => ({ type: 'paragraph', attrs: { firstLineIndent: false, indent: 0, textAlign: null, ...extra }, ...(content && content.length ? { content } : {}) });

function parseInline(src) {
  const out = [];
  const push = (text, marks) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text' && JSON.stringify(last.marks || []) === JSON.stringify(marks)) last.text += text;
    else out.push({ type: 'text', ...(marks.length ? { marks } : {}), text });
  };
  const walk = (s, marks) => {
    let i = 0, buf = '';
    const flush = () => { push(buf, marks); buf = ''; };
    const wrapped = (open, close, mark) => {
      if (!s.startsWith(open, i)) return false;
      const end = s.indexOf(close, i + open.length);
      if (end < 0 || end === i + open.length) return false;
      flush(); walk(s.slice(i + open.length, end), [...marks, mark]); i = end + close.length; return true;
    };
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
      if (s.startsWith('<br>', i) || s.startsWith('<br/>', i) || s.startsWith('<br />', i)) { flush(); out.push({ type: 'hardBreak' }); i = s.indexOf('>', i) + 1; continue; }
      if (c === '$' && s[i + 1] !== '$') {
        const end = s.indexOf('$', i + 1);
        if (end > i + 1 && !/\s/.test(s[i + 1]) && !/\s/.test(s[end - 1])) { flush(); out.push({ type: 'inlineFormula', attrs: { latex: s.slice(i + 1, end) }, ...(marks.length ? { marks } : {}) }); i = end + 1; continue; }
      }
      if (c === '`') { const end = s.indexOf('`', i + 1); if (end > i) { flush(); push(s.slice(i + 1, end), [...marks, { type: 'code' }]); i = end + 1; continue; } }
      if (wrapped('**', '**', { type: 'bold' })) continue;
      if (wrapped('~~', '~~', { type: 'strike' })) continue;
      if (wrapped('==', '==', { type: 'textStyle', attrs: { color: null, backgroundColor: YELLOW } })) continue;
      if (wrapped('<u>', '</u>', { type: 'underline' })) continue;
      if ((c === '*' || c === '_') && s[i + 1] !== c && !/\s/.test(s[i + 1] || ' ') && (c === '*' || !/\w/.test(s[i - 1] || ' '))) { if (wrapped(c, c, { type: 'italic' })) continue; }
      let m;
      if ((m = /^<mark style="background-color:([^"]+)">([\s\S]*?)<\/mark>/.exec(s.slice(i)))) { flush(); walk(m[2], [...marks, { type: 'textStyle', attrs: { color: null, backgroundColor: m[1] } }]); i += m[0].length; continue; }
      if ((m = /^<span style="color:([^"]+)">([\s\S]*?)<\/span>/.exec(s.slice(i)))) { flush(); walk(m[2], [...marks, { type: 'textStyle', attrs: { color: m[1], backgroundColor: null } }]); i += m[0].length; continue; }
      if (c === '[' && (m = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/.exec(s.slice(i)))) { flush(); walk(m[1], [...marks, { type: 'link', attrs: { href: m[2] } }]); i += m[0].length; continue; }
      buf += c; i++;
    }
    flush();
  };
  walk(String(src), []);
  return out;
}

const RE = {
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/, hr: /^ {0,3}([-*_])( *\1){2,} *$/, fence: /^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/,
  list: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/, tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
  video: /^<video\b[^>]*?\bsrc="([^"]+)"[^>]*>\s*<\/video>$/i,
  image: /^!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/, file: /^\[📎\s*((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)$/,
  center: /^<div align="center">([\s\S]*)<\/div>$/,
};
const unesc = (s) => String(s).replace(/\\([\\`*_$\[\]<|])/g, '$1');
const splitRow = (line) => {
  const cells = []; let cur = '', s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
};

function parseBlocks(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l, next) => RE.heading.test(l) || RE.hr.test(l) || RE.fence.test(l) || /^\s*>/.test(l) || RE.list.test(l) || /^\s*\$\$/.test(l) || (l.includes('|') && next != null && RE.tableSep.test(next) && next.includes('-'));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = RE.fence.exec(line))) {
      const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(m[1])) body.push(lines[i++]);
      i++;
      out.push({ type: 'codeBlock', attrs: { language: m[2] || null }, ...(body.length ? { content: [{ type: 'text', text: body.join('\n') }] } : {}) });
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      let body = line.trim().slice(2);
      if (body.endsWith('$$') && body.length >= 2) { body = body.slice(0, -2); i++; }
      else { const acc = [body]; i++; while (i < lines.length && !lines[i].includes('$$')) acc.push(lines[i++]); if (i < lines.length) acc.push(lines[i++].replace(/\$\$.*$/, '')); body = acc.join('\n'); }
      out.push(P([{ type: 'inlineFormula', attrs: { latex: body.trim() } }], { textAlign: 'center' }));
      continue;
    }
    if ((m = RE.heading.exec(line))) {
      const level = m[1].length;
      out.push({ type: 'heading', attrs: { firstLineIndent: false, indent: 0, collapsed: false, textAlign: null, level, numbered: level <= 2, numberStart: null, numberLevel: level <= 2 ? level : null, numberPath: null }, content: parseInline(m[2]) });
      i++; continue;
    }
    if (RE.hr.test(line)) { out.push({ type: 'horizontalRule' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''));
      const cm = /^\[!(\w+)\]\s*(.*)$/.exec(body[0] || '');
      if (cm) {
        const def = CALLOUTS[cm[1].toLowerCase()] || CALLOUTS.note;
        const inner = parseBlocks(body.slice(1).join('\n'));
        out.push({ type: 'callout', attrs: { icon: { type: 'emoji', value: cm[2].trim() || def.icon }, color: null, fill: def.fill, border: def.border }, content: inner.length ? inner : [P()] });
      } else out.push({ type: 'blockquote', content: parseBlocks(body.join('\n')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line), aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const width = (n) => [Math.round(820 / n)];
      const cell = (type, text, ci, n) => {
        const center = type === 'tableHeader' || aligns[ci] === 'center';
        const segs = text.split(/<br\s*\/?>/).map((s) => s.trim()).filter(Boolean);
        let content;
        if (segs.length && segs.every((s) => s.startsWith('• '))) content = [{ type: 'bulletList', content: segs.map((s) => ({ type: 'listItem', attrs: { number: null, collapsed: false }, content: [P(parseInline(s.slice(2)))] })) }];
        else content = [P(parseInline(type === 'tableHeader' ? text.replace(/^\*\*(.*)\*\*$/, '$1') : text).map((x) => (type === 'tableHeader' && x.type === 'text' ? { ...x, marks: [{ type: 'bold' }] } : x)), { textAlign: center ? 'center' : null })];
        return { type, attrs: { backgroundColor: null, verticalAlign: center && type === 'tableCell' ? 'middle' : 'top', align: null, colspan: 1, rowspan: 1, colwidth: width(n) }, content };
      };
      const n = header.length;
      out.push({ type: 'table', attrs: { tableAlign: 'center', blockWidth: 100 }, content: [
        { type: 'tableRow', attrs: { height: null }, content: header.map((h, ci) => cell('tableHeader', h, ci, n)) },
        ...rows.map((r) => ({ type: 'tableRow', attrs: { height: null }, content: Array.from({ length: n }, (_, ci) => cell('tableCell', r[ci] || '', ci, n)) })),
      ] });
      continue;
    }
    if ((m = RE.list.exec(line))) {
      const baseIndent = m[1].length, ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const lm = RE.list.exec(lines[i]);
        if (!lm || lm[1].length !== baseIndent || /\d/.test(lm[2]) !== ordered) break;
        const contentIndent = lines[i].length - lm[3].length;
        const body = [lm[3]]; i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) { // blank line: the item continues only if the next non-blank line is indented
            let j = i; while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && /^\s+/.test(lines[j]) && lines[j].search(/\S/) > baseIndent) { body.push(''); i++; continue; }
            break;
          }
          if (l.search(/\S/) <= baseIndent) break;
          body.push(l.slice(Math.min(contentIndent, l.search(/\S/)))); i++;
        }
        const task = /^\[([ xX])\]\s+/.exec(body[0]);
        if (task) body[0] = body[0].slice(task[0].length);
        items.push({ type: 'listItem', attrs: { number: ordered && !items.length ? start : null, collapsed: false, ...(task ? { checked: task[1] !== ' ' } : {}) }, content: parseBlocks(body.join('\n')) });
      }
      out.push(ordered ? { type: 'orderedList', attrs: { start, type: null }, content: items } : { type: 'bulletList', content: items });
      continue;
    }
    // paragraph
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++]);
    // a soft line break is a space - except between two CJK / full-width characters, where a space would be wrong
    const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;
    const text = buf.map((l) => l.trim()).reduce((acc, l) => acc + (CJK.test(acc.slice(-1)) && CJK.test(l[0] || '') ? '' : ' ') + l);
    if ((m = RE.video.exec(text))) { // a video of the note: <video src="..." controls width="480"></video>
      const w = /\bwidth="(\d+)"/i.exec(text), node = media('video', m[1], '', m[1].split('/').pop());
      if (w) node.attrs.width = Number(w[1]);
      out.push(node); continue;
    }
    if ((m = RE.image.exec(text))) { out.push(media('image', decodeURI(m[2]), unesc(m[1]), 'image.png')); continue; }
    if ((m = RE.file.exec(text))) { out.push(media('file', decodeURI(m[2]), '', unesc(m[1]))); continue; }
    if ((m = RE.center.exec(text))) { out.push(P(parseInline(m[1]), { textAlign: 'center' })); continue; }
    out.push(P(parseInline(text)));
  }
  return out;
}

const media = (kind, src, alt, name) => ({ type: 'media', attrs: { blockWidth: 100, src, name, kind, imageAlign: 'center', pdfView: 'preview', videoView: 'preview', videoAlign: 'center', videoWidth: 100, alt, imageWidth: 100, description: '', imageCrop: null } });

// Returns a document body; pass `meta` (title, category, tags …) to get a full draft object.
function fromMarkdown(md, meta) {
  const body = { type: 'doc', attrs: { headingNumbering: false, pageMargin: 0, formulaFrames: true }, content: parseBlocks(md) };
  return meta ? { format: 'Markdown', ...meta, body } : body;
}

module.exports = { toMarkdown, fromMarkdown, CALLOUTS };

if (require.main === module) { // CLI: node lib/notejson.js <draft.json|note.md> [out]
  const fs = require('node:fs');
  const [src, dst] = process.argv.slice(2);
  if (!src) { console.error('usage: node lib/notejson.js <draft.json | note.md> [output file]'); process.exit(1); }
  const text = fs.readFileSync(src, 'utf8');
  const result = /\.json$/i.test(src) ? toMarkdown(JSON.parse(text)) : JSON.stringify(fromMarkdown(text, { title: require('node:path').basename(src).replace(/\.md$/i, '') }), null, 2);
  if (dst) fs.writeFileSync(dst, result); else process.stdout.write(result);
}
