// The figures and tables of a paper, found LOCALLY from the layout of its PDF - no AI call anywhere in this file.
//   list(id)                 -> [{key, kind, number, label, page, caption, box, pageW, pageH, confidence}]
//   image(id, key, {dpi})    -> {file, buf} PNG of that region of the page
//   place(id, markdown)      -> {markdown, placed, missed}: the "> 📷 待截图：Figure 3 (...)" placeholders of a note
//                               replaced by the cropped picture, stored as a normal note asset
//   promptList(id)           -> the cheap text list a prompt can carry instead of looking at the pages
// How: `pdftotext -bbox-layout` gives every text block / line / word with its box. A caption is a block that starts
// with "Figure 3:" / "Fig. 3." / "TABLE II" / "图 3"; the picture is the area above it (a table: below it) up to the
// nearest body text, other caption or page margin, in the caption's column or across the page. A low-resolution
// grey rendering of the page (`pdftoppm -gray`, PGM) then trims that area to the ink, takes away a strip of body
// text that the layout step let through, and tells an empty area from a drawn one.
// Everything is cached in <workspace>/cache/figures/<id>/ (index.json + the crops), keyed by the size and
// modification time of the PDF like lib/textcache.js: derived data, safe to delete, rebuilt on the next use.
// poppler is optional: without it list() rejects with 501 {unavailable: true} and nothing else is affected.
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const textcache = require('./textcache');

const DIR = path.join(core.DIRS.cache, 'figures');
const VERSION = 4;
const KEY_RE = /^(fig|tab)-[a-z]?\d{1,3}$/;
const RASTER_DPI = 60;
const INK = 236;             // a grey value below this is ink
const CROP_DPI = 160, CROP_MAX_PX = 1800;
const CAPTION_MAX = 420;

// ====================================================================== 1. layout (pure)
const unxml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (all, n, d, h) => (d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[n.toLowerCase()]));
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// A line built from its words: box, text, number of words and `h`, the height of a typical word (the font size as
// far as the layout tells it; the line box itself grows with sub- and superscripts).
function makeLine(words) {
  const l = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, text: '', n: words.length, h: 0 };
  for (const w of words) { l.x0 = Math.min(l.x0, w.x0); l.y0 = Math.min(l.y0, w.y0); l.x1 = Math.max(l.x1, w.x1); l.y1 = Math.max(l.y1, w.y1); }
  l.text = words.map((w) => w.t).join(' ');
  l.h = median(words.map((w) => w.y1 - w.y0));
  l.words = words;
  return l;
}
function makeBlock(lines) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, lines };
  for (const l of lines) { b.x0 = Math.min(b.x0, l.x0); b.y0 = Math.min(b.y0, l.y0); b.x1 = Math.max(b.x1, l.x1); b.y1 = Math.max(b.y1, l.y1); }
  return b;
}
// XML of `pdftotext -bbox-layout` -> [{w, h, blocks: [{x0, y0, x1, y1, lines: [{x0, y0, x1, y1, text, n, h}]}]}]
function parseLayout(xml) {
  const pages = [];
  let page = null, lines = null, words = null;
  const re = /<(page|block|line|word)\b([^>]*)>(?:([^<]*)<\/word>)?|<\/(line|block)>/g;
  const box = /xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)"/;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === 'page') {
      const w = /width="([^"]+)"/.exec(m[2]), h = /height="([^"]+)"/.exec(m[2]);
      page = { w: Number(w && w[1]) || 612, h: Number(h && h[1]) || 792, blocks: [] };
      pages.push(page);
    } else if (m[1] === 'block') lines = [];
    else if (m[1] === 'line') words = [];
    else if (m[1] === 'word') {
      const b = box.exec(m[2]), t = unxml(m[3] || '').trim();
      if (b && words && t) words.push({ x0: Number(b[1]), y0: Number(b[2]), x1: Number(b[3]), y1: Number(b[4]), t });
    } else if (m[4] === 'line') { if (words && words.length && lines) lines.push(makeLine(words)); words = null; }
    else if (m[4] === 'block') { if (page && lines && lines.length) page.blocks.push(makeBlock(lines)); lines = null; }
  }
  splitGutter(pages);
  splitSideCaptions(pages);
  for (const p of pages) for (const b of p.blocks) for (const l of b.lines) delete l.words;
  return pages;
}
// pdftotext sometimes reads the two columns of a page as ONE line per row (the left and the right column joined,
// with the gutter as a wide gap between two words). Where many wide lines of the document have such a gap at the
// same place, those lines are cut there and their blocks become a left and a right block.
function splitGutter(pages) {
  const GAP = 6.5;
  const cover = new Map();
  let wide = 0;
  const gapsOf = (l) => { const g = []; for (let i = 1; i < l.words.length; i++) if (l.words[i].x0 - l.words[i - 1].x1 >= GAP) g.push([l.words[i - 1].x1, l.words[i].x0, i]); return g; };
  for (const p of pages) for (const b of p.blocks) for (const l of b.lines) {
    if (!l.words || l.n < 8 || l.x1 - l.x0 < p.w * 0.55) continue;
    wide++;
    for (const [a, z] of gapsOf(l)) for (let x = Math.ceil(a); x <= Math.floor(z); x++) cover.set(x, (cover.get(x) || 0) + 1);
  }
  if (wide < 12) return null;
  let gx = null, top = 0;
  const w0 = pages[0] ? pages[0].w : 612;
  for (const [x, n] of cover) if (x > w0 * 0.3 && x < w0 * 0.7 && n > top) { top = n; gx = x; }
  if (gx == null || top < wide * 0.4) return null;
  { let a = gx, z = gx; while ((cover.get(a - 1) || 0) >= top * 0.8) a--; while ((cover.get(z + 1) || 0) >= top * 0.8) z++; gx = (a + z) / 2; } // the middle of the river
  for (const p of pages) {
    const out = [];
    for (const b of p.blocks) {
      let cutAny = false;
      const parts = [];
      for (const l of b.lines) {
        const g = l.words ? gapsOf(l).find(([a, z]) => a <= gx + 1 && z >= gx - 1) : null;
        if (g) { cutAny = true; parts.push(makeLine(l.words.slice(0, g[2])), makeLine(l.words.slice(g[2]))); } else parts.push(l);
      }
      if (!cutAny) { out.push(b); continue; }
      const side = (l) => (l.x1 <= gx + 2 ? 0 : l.x0 >= gx - 2 ? 1 : 2);
      // runs of lines on the same side, in reading order, become blocks (a line across both columns stands alone)
      const groups = [[], []];
      const spans = [];
      for (const l of parts) { const k = side(l); if (k === 2) spans.push(l); else groups[k].push(l); }
      for (const g of groups) {
        let run = [];
        for (const l of g) { // a vertical jump (a spanning line or a figure in between) starts a new block
          if (run.length && l.y0 - run[run.length - 1].y1 > Math.max(l.h, 6) * 1.6) { out.push(makeBlock(run)); run = []; }
          run.push(l);
        }
        if (run.length) out.push(makeBlock(run));
      }
      for (const l of spans) out.push(makeBlock([l]));
    }
    p.blocks = out;
  }
  return gx;
}

// Two floats set side by side have their captions side by side, and pdftotext reads the two as ONE block, often
// as one line per row ("Table 5: Comparison ...    Table 6: Ablation ..."). Where a second caption opens to the
// right of the first one - in the middle of a line after a gap much wider than a space, or as a line of its own
// that starts far to the right of another caption line of the block - the block is cut at the left edge of that
// second caption: what lies right of it becomes a block of its own.
function splitSideCaptions(pages) {
  const START = /^(Figure|Fig\.?|FIGURE|FIG\.?|Table|TABLE|Tab\.|图|表)/;
  const certain = (t) => { const c = START.test(t) ? captionOf(t) : null; return c && c.score >= 0.9 ? c : null; };
  for (const p of pages) {
    for (let bi = 0; bi < p.blocks.length; bi++) {
      const b = p.blocks[bi];
      let from = -1, xs = 0;
      // (a) inside a line
      for (let li = 0; li < b.lines.length && from < 0; li++) {
        const ws = b.lines[li].words;
        if (!ws || ws.length < 4) continue;
        const gaps = []; for (let i = 1; i < ws.length; i++) gaps.push(ws[i].x0 - ws[i - 1].x1);
        const space = Math.max(1.5, median(gaps));
        for (let i = 2; i < ws.length - 1; i++) {
          const g = ws[i].x0 - ws[i - 1].x1;
          if (g < 6 || g < space * 2.2 || !certain(ws.slice(i).map((w) => w.t).join(' '))) continue;
          from = li; xs = ws[i].x0;
          break;
        }
      }
      // (b) two caption lines in one block, one starting far to the right of the other
      if (from < 0) {
        const starts = b.lines.map((l, i) => ({ l, i, c: certain(l.text) })).filter((x) => x.c);
        for (const x of starts) for (const y of starts) {
          if (from >= 0 || x === y || x.c.key === y.c.key || y.l.x0 - x.l.x0 < 60) continue;
          if (!b.lines.some((l) => l.x0 < y.l.x0 - 30 && l.x1 > y.l.x0 + 30 && Math.abs(l.y0 - y.l.y0) < 40) && x.l.x1 > y.l.x0 - 4) continue; // (not side by side)
          from = Math.min(x.i, y.i); xs = y.l.x0;
        }
      }
      if (from < 0) continue;
      const left = [], right = [], stray = [];
      b.lines.forEach((l, li) => {
        if (l.x0 >= xs - 2) { (li < from ? stray : right).push(l); return; }
        if (l.x1 <= xs || li < from || !l.words) { left.push(l); return; }
        let k = l.words.findIndex((w, i) => i > 0 && Math.abs(w.x0 - xs) <= 2);
        if (k < 0) k = l.words.findIndex((w, i) => i > 0 && l.words[i - 1].x1 <= xs + 2 && w.x0 >= xs - 8 && w.x0 - l.words[i - 1].x1 >= 3.5);
        if (k < 0) { left.push(l); return; }
        left.push(makeLine(l.words.slice(0, k))); right.push(makeLine(l.words.slice(k)));
      });
      if (!left.length || !right.length) continue;
      const byY = (x, y) => x.y0 - y.y0;
      const made = [makeBlock(left.sort(byY)), makeBlock(right.sort(byY)), ...stray.map((l) => makeBlock([l]))];
      p.blocks.splice(bi, 1, ...made);
      bi += made.length - 1; // (the parts are not looked at again)
    }
  }
}

// ---------------------------------------------------------------- captions
const ROMAN = { I: 1, V: 5, X: 10, L: 50 };
function roman(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]], nx = ROMAN[s[i + 1]] || 0; n += v < nx ? -v : v; }
  return n > 0 && n < 90 ? n : 0;
}
const CAP_RE = /^(Figure|Fig\.?|FIGURE|FIG\.?|Table|TABLE|Tab\.|图|表)(\s*)([A-Z]?\d{1,3}|[IVXL]{1,6})(?![\w])\s*([:.|：．。—–-]?)\s*(.*)$/;
const CAP_HEAD = /^\s*(?:Figure|Fig\.?|FIGURE|FIG\.?|Table|TABLE|Tab\.|图|表)\s*(?:[A-Z]?\d{1,3}|[IVXL]{1,6})(?![\w])\s*[:.|：．。—–-]?\s*/; // the label of a caption, to take it off
// a sentence that merely begins with "Figure 3 shows ..." is body text
const VERBS = /^(shows?|illustrates?|presents?|depicts?|demonstrates?|compares?|plots?|reports?|summari[sz]es?|provides?|gives?|lists?|displays?|visuali[sz]es?|details?|contains?|describes?|highlights?|indicates?|reveals?|and|or|in|is|are|we|for|the|a|also|further|above|below)\b/i;
// -> {kind, number, key, label, rest, score} when `text` (a line) opens like a caption, else null. `score` is how
// sure the wording alone makes us (0..1); where the line stands decides the rest.
function captionOf(text) {
  const m = CAP_RE.exec(String(text || '').trim());
  if (!m) return null;
  const kind = /^(t|表)/i.test(m[1]) ? 'table' : 'figure';
  const num = m[3], isRoman = /^[IVXL]+$/.test(num);
  let number, tag = '';
  if (isRoman) { number = roman(num); if (!number) return null; }
  else { const d = /^([A-Z]?)(\d+)$/.exec(num); tag = d[1].toLowerCase(); number = Number(d[2]); }
  const delim = m[4], rest = m[5].trim();
  let score, bare = false;
  if (delim && rest) score = /^[)\],;]/.test(rest) ? 0 : 0.9;
  else if (delim && !rest) score = delim === '.' ? 0.5 : 0.7;      // "Fig. 17." closes a sentence more often than it opens a caption
  else if (!rest) {
    // the label alone on its line (IEEE "TABLE I", "Table 1" above its title). "Table1" without a space is a cell
    // of a table (a column called Table1), and so is any such label that does not stand alone - see findCaptions
    bare = true;
    score = !m[2] && !/[图表]/.test(m[1]) ? 0 : /^(TABLE|FIGURE|FIG)/.test(m[1]) ? 0.75 : 0.55;
  } else if (/^\([A-Za-z][A-Za-z ,&-]{0,14}\)\s*[:.：]\s*\S/.test(rest)) score = 0.85; // "Figure 18 (Left): Impact of ..."
  else if (/^[A-Z\u4e00-\u9fff]/.test(rest) && !VERBS.test(rest)) score = 0.6;   // "Figure 3 Scaling ingredients."
  else score = 0;
  if (isRoman && !(delim || !rest)) score = 0;                     // "Table I summarizes ..."
  if (isRoman && kind === 'figure' && !/^FIG/.test(m[1])) score = Math.min(score, 0.5);
  if (!score) return null;
  const zh = /[图表]/.test(m[1]);
  const word = zh ? m[1] : kind === 'table' ? 'Table' : 'Figure';
  return { kind, number, key: `${kind === 'table' ? 'tab' : 'fig'}-${tag}${number}`, label: `${word} ${num}`, rest, score, ...(bare ? { bare } : {}) };
}

// The captions of a page. A caption normally opens its block; pdftotext sometimes glues it to the text above, so a
// line inside a block counts too when the wording is certain and the line visibly starts something new (the line
// before ends a sentence, sits further away than the lines of the block do, or is set in another size). Such a
// block is split in two. Returns the caption blocks; page.blocks is updated in place (`cap` set on them).
function findCaptions(page) {
  const out = [];
  for (let bi = 0; bi < page.blocks.length; bi++) {
    const b = page.blocks[bi];
    if (b.cap) { out.push(b); continue; }
    const pitches = [];
    for (let i = 1; i < b.lines.length; i++) pitches.push(b.lines[i].y0 - b.lines[i - 1].y0);
    const pitch = median(pitches) || 0;
    for (let li = 0; li < b.lines.length; li++) {
      const line = b.lines[li], c = captionOf(line.text);
      if (!c) continue;
      if (li > 0) {
        const prev = b.lines[li - 1];
        const newStart = /[.!?。”"]$/.test(prev.text) || (pitch && line.y0 - prev.y0 > pitch * 1.45) || Math.abs(line.h - prev.h) > 0.7
          || Math.abs(line.x0 - prev.x0) > 24 || line.y0 < prev.y0 - 2;
        if (c.score < 0.9 || !newStart) continue;
        c.score = 0.8;
        // split: the lines above stay a block of their own
        const head = makeBlock(b.lines.slice(0, li)), tail = makeBlock(b.lines.slice(li));
        page.blocks.splice(bi, 1, head, tail);
        tail.cap = c;
        out.push(tail);
        bi++; // the tail is handled
        break;
      }
      b.cap = c;
      out.push(b);
      break;
    }
  }
  // a caption glued to the paragraph that follows it: the paragraph starts after a visibly larger step
  for (let k = 0; k < out.length; k++) {
    const b = out[k], ls = b.lines;
    if (ls.length < 4) continue;
    const steps = []; for (let i = 1; i < ls.length; i++) steps.push(ls[i].y0 - ls[i - 1].y0);
    const pitch = median(steps);
    const at = steps.findIndex((v) => v > pitch * 1.4 && v > pitch + 2.5);
    if (at < 0) continue;
    const head = makeBlock(ls.slice(0, at + 1)), tail = makeBlock(ls.slice(at + 1));
    head.cap = b.cap;
    page.blocks.splice(page.blocks.indexOf(b), 1, head, tail);
    out[k] = head;
  }
  // a caption whose later lines were read as a block of their own: the block right below it, set in the same size,
  // is the rest of the caption
  for (const b of out) {
    let last = b;
    for (let guard = 0; guard < 4; guard++) {
      const lh = last.lines[last.lines.length - 1].h || 8;
      const tol = /[a-z]{3}/.test(b.lines[b.lines.length - 1].text) ? 0.6 : 1.7; // small capitals (IEEE table titles) vary in height
      // (a caption that has ended - a full stop, and the next block is set to another left edge - does not go on:
      // that block is a label of the next figure or the running text)
      const ll = last.lines[last.lines.length - 1], ended = /[.!?。]$/.test(ll.text);
      const next = page.blocks.find((o) => o !== b && !o.cap && !o.capOf && o.y0 >= last.y1 - 2 && o.y0 - last.y1 < lh * 0.75 && !(ended && Math.abs(o.x0 - ll.x0) > 6)
        && Math.abs(o.lines[0].h - lh) <= tol && ((o.x0 >= b.x0 - 6 && o.x1 <= Math.max(b.x1, last.x1) + 6) || (Math.abs((o.x0 + o.x1) - (b.x0 + b.x1)) < 24 && o.x1 - o.x0 < (b.x1 - b.x0) * 2.2)) && !captionOf(o.lines[0].text));
      if (!next) break;
      next.capOf = b; (b.more = b.more || []).push(next); last = next;
    }
    if (b.more) b.y1c = Math.max(b.y1, ...b.more.map((o) => o.y1));
  }
  // "TABLE I" alone on its line: the title is the next block right below it
  for (const b of out) {
    if (b.cap.rest || b.lines.length > 1 || b.more) continue;
    const next = page.blocks.filter((o) => o !== b && !o.cap && !o.capOf && o.y0 >= b.y1 - 2 && o.y0 - b.y1 < 9 && o.x0 < b.x1 + 200 && o.x1 > b.x0 - 200 && o.lines.length <= 3)
      .sort((x, y) => x.y0 - y.y0)[0];
    if (next) { next.capOf = b; b.title = next; }
  }
  // a bare label ("TABLE I", "Table 2") is a caption only where it stands alone on its row and a title follows;
  // "Table 2" among other cells on the same row is a column head, the name of a sequence, a tick label ...
  for (let k = out.length - 1; k >= 0; k--) {
    const b = out[k];
    if (!b.cap.bare) continue;
    const l = b.lines[0], cy = (l.y0 + l.y1) / 2;
    const alone = !page.blocks.some((o) => o !== b && o.lines.some((x) => x !== l && x.y0 < cy && x.y1 > cy && x.x1 > l.x0 - 45 && x.x0 < l.x1 + 45));
    if (alone && (b.lines.length > 1 || b.title || b.more)) continue;
    uncaption(b);
    out.splice(k, 1);
  }
  return out;
}
// take back what findCaptions said about a block
function uncaption(b) {
  delete b.cap;
  if (b.title) { delete b.title.capOf; delete b.title; }
  for (const o of b.more || []) delete o.capOf;
  delete b.more; delete b.y1c;
}
function captionText(b) {
  let t = '';
  const lines = [...b.lines, ...(b.title ? b.title.lines : []), ...(b.more || []).flatMap((o) => o.lines)];
  for (const l of lines) t = /[A-Za-z]-$/.test(t) && /^[a-z]/.test(l.text) ? t.slice(0, -1) + l.text : (t ? t + ' ' : '') + l.text;
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > CAPTION_MAX ? t.slice(0, CAPTION_MAX - 1).replace(/\s+\S*$/, '') + '…' : t;
}

// ---------------------------------------------------------------- body text, columns, margins
// What the whole document tells: the size of the body text, the columns, the running header and footer.
function docStats(pages) {
  const hist = new Map();
  for (const p of pages) for (const b of p.blocks) for (const l of b.lines) { if (l.n < 4) continue; const k = Math.round(l.h * 2) / 2; hist.set(k, (hist.get(k) || 0) + l.n); }
  let bodyH = 9, top = 0;
  for (const [k, n] of hist) if (n > top) { top = n; bodyH = k; }
  // running header / footer: a one-line block at the top / bottom whose text (digits aside) comes back on many pages
  const sig = (b) => b.lines[0].text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);
  const band = (isTop) => {
    const seen = new Map(), cand = [];
    for (const p of pages) {
      const mine = new Set();
      for (const b of p.blocks) if (b.lines.length === 1 && (isTop ? b.y1 < p.h * 0.14 : b.y0 > p.h * 0.88)) { const k = sig(b); cand.push([k, isTop ? b.y1 : b.y0]); mine.add(k); }
      for (const k of mine) seen.set(k, (seen.get(k) || 0) + 1);
    }
    const need = Math.max(3, Math.ceil(pages.length * 0.4)); // (titles of plots at the top of two pages are not a header)
    // ... and stands at the same height each time (a page number does; "(12)" or "0.5" near the bottom of some pages do not)
    const ys = new Map();
    for (const [k, y] of cand) if (seen.get(k) >= need) { if (!ys.has(k)) ys.set(k, []); ys.get(k).push(y); }
    let edge = null;
    for (const a of ys.values()) {
      const md = median(a), same = a.filter((y) => Math.abs(y - md) <= 8);
      if (same.length < need) continue;
      for (const y of same) edge = edge == null ? y : isTop ? Math.max(edge, y) : Math.min(edge, y);
    }
    return edge == null ? null : edge + (isTop ? 1 : -1);
  };
  const stats = { bodyH, headerY: pages.length >= 3 ? band(true) : null, footerY: pages.length >= 3 ? band(false) : null };
  stats.columns = columnsOf(pages.flatMap((p) => p.blocks.flatMap((b) => b.lines)), bodyH, 8);
  return stats;
}
// Columns = the left edges many full lines of body text share, each with the right edge those lines reach.
function columnsOf(lines, bodyH, minCount) {
  const long = lines.filter((l) => l.n >= 6 && Math.abs(l.h - bodyH) <= bodyH * 0.2).sort((a, b) => a.x0 - b.x0);
  const groups = [];
  for (const l of long) {
    const g = groups[groups.length - 1];
    if (g && l.x0 - g.first <= 2.5) g.lines.push(l); else groups.push({ first: l.x0, lines: [l] });
  }
  const topN = Math.max(0, ...groups.map((g) => g.lines.length));
  let cols = groups.filter((g) => g.lines.length >= Math.max(minCount, topN * 0.2)).map((g) => {
    const xs = g.lines.map((l) => l.x1).sort((a, b) => a - b);
    return { L: median(g.lines.map((l) => l.x0)), R: xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.85))], n: g.lines.length };
  }).filter((c) => c.R - c.L >= 110);
  // an indented group inside a column (first lines of paragraphs, lists) is not a column
  cols = cols.filter((c) => !cols.some((o) => o !== c && o.L < c.L && c.L <= o.L + 32 && Math.abs(o.R - c.R) <= 8 && o.n >= c.n * 0.6));
  const chosen = [];
  for (const c of cols.sort((a, b) => b.n - a.n)) {
    if (chosen.every((o) => Math.min(o.R, c.R) - Math.max(o.L, c.L) <= 0.2 * Math.min(o.R - o.L, c.R - c.L))) chosen.push(c);
  }
  return chosen.sort((a, b) => a.L - b.L);
}
const HEADING_RE = /^(\d{1,2}(\.\d{1,2}){0,3}\.?|[IVX]{1,5}\.|[A-Z]\.(\d\.?)?|Appendix [A-Z])\s+[A-Z]/;
const EQNUM_RE = /\((?:[A-Z]\.?)?\d{1,3}[a-z]?\)\s*$/;
// Is this line set like the running text of the paper (and not like a label inside a figure)?
function bodyishLine(l, stats, cols) {
  if (Math.abs(l.h - stats.bodyH) > stats.bodyH * 0.17) return false;
  const atLeft = cols.some((c) => l.x0 >= c.L - 3 && l.x0 <= c.L + 22 && l.x1 <= c.R + 6);
  if (atLeft && l.n >= 4) return true;
  if (atLeft && HEADING_RE.test(l.text)) return true;
  if (EQNUM_RE.test(l.text) && cols.some((c) => Math.abs(l.x1 - c.R) <= 4)) return true;
  if (/^([IVX]{1,5}\.|\d{1,2}(\.\d{1,2}){0,2}\.?)\s+[A-Z]/.test(l.text) && l.n <= 12 && l.h >= stats.bodyH * 0.8) return true; // a centred section heading
  return l.n >= 9;
}
// Marks the blocks of a page: b.body (running text: a paragraph, a heading, a footnote), b.margin (running header
// / footer). Small text blocks - axis labels, legends, sub-figure labels, table cells - stay unmarked: they belong
// to whatever figure or table they stand in. Returns the columns of the page.
function classifyPage(page, stats, tables = []) {
  // (the cells of a table found by its rules are not running text, however long they are)
  const inTable = (b) => tables.some((f) => (b.x0 + b.x1) / 2 > f.x0 - 2 && (b.x0 + b.x1) / 2 < f.x1 + 2 && (b.y0 + b.y1) / 2 > f.y0 - 1 && (b.y0 + b.y1) / 2 < f.y1 + 1);
  for (const b of page.blocks) b.inTable = !b.cap && !b.capOf && inTable(b);
  const own = columnsOf(page.blocks.filter((b) => !b.cap && !b.inTable).flatMap((b) => b.lines), stats.bodyH, 5);
  // the columns this page shows, and those of the document where the page has too little text to show them
  // (a page of references shows the hanging indent as its "column": the document's column with the same right edge wins)
  for (let i = 0; i < own.length; i++) { const c = stats.columns.find((k) => Math.abs(k.R - own[i].R) <= 8 && own[i].L - k.L > 0 && own[i].L - k.L <= 32); if (c) own[i] = c; }
  const cols = [...own, ...stats.columns.filter((c) => own.every((o) => Math.min(o.R, c.R) - Math.max(o.L, c.L) <= 0.2 * Math.min(o.R - o.L, c.R - c.L)))].sort((x, y) => x.L - y.L);
  for (const b of page.blocks) {
    b.body = false; b.margin = false;
    if (b.lines.length === 1 && !b.cap && !b.capOf && ((stats.headerY != null && b.y1 <= stats.headerY) || (stats.footerY != null && b.y0 >= stats.footerY))) { b.margin = true; continue; }
    if (b.cap || b.capOf || b.inTable) continue;
    b.stamp = /^arXiv:\d{4}\.\d{4,5}/.test(b.lines[0].text) && b.y1 - b.y0 > 3 * (b.x1 - b.x0); // the arXiv stamp up the left margin
    if (b.stamp) continue;
    const ls = b.lines, n = ls.length;
    const h = median(ls.map((l) => l.h));
    const words = ls.reduce((s, l) => s + l.n, 0);
    const col = cols.find((c) => b.x0 >= c.L - 4 && b.x1 <= c.R + 8);
    if (n >= 3) {
      // a justified paragraph: the lines share both edges (the first may be indented, the last may be short)
      const x1s = ls.slice(0, -1).map((l) => l.x1), x0s = ls.slice(1).map((l) => l.x0);
      const tight = (a) => { const md = median(a); return a.filter((v) => Math.abs(v - md) <= 2.5).length >= a.length * 0.8; };
      if (tight(x1s) && tight(x0s) && words / n >= 5 && b.x1 - b.x0 >= 120) { b.body = true; continue; }
    }
    if (n >= 2 && col && h >= stats.bodyH * 0.72 && h <= stats.bodyH * 1.3) {
      const wide = b.x1 - b.x0 >= (col.R - col.L) * 0.72;
      const left = ls.filter((l) => l.x0 <= col.L + 12).length >= n * 0.5 || ls.filter((l) => Math.abs(l.x1 - col.R) <= 3).length >= (n - 1) * 0.6;
      if (wide && left && words / n >= 4.5) { b.body = true; continue; }
    }
    if (n === 1 && col && Math.abs(h - stats.bodyH) <= stats.bodyH * 0.17) {
      const l = ls[0];
      if (l.n >= 6 && l.x0 <= col.L + 22 && l.x1 >= col.R - 3) { b.body = true; continue; } // one full line
    }
    if (n <= 2 && col && h >= stats.bodyH * 0.92 && Math.abs(b.x0 - col.L) <= 3 && HEADING_RE.test(ls[0].text) && ls[0].n <= 14) { b.body = true; continue; }
  }
  // an IEEE section heading: roman number, small capitals (so its letters measure smaller than the body), centred
  for (const b of page.blocks) {
    if (b.body || b.cap || b.capOf || b.margin || b.inTable || b.lines.length !== 1) continue;
    const l = b.lines[0];
    if (!/^[IVX]{1,5}\.\s+[A-Z]/.test(l.text) || l.n > 14 || l.text !== l.text.toUpperCase() || l.h < stats.bodyH * 0.6 || l.h > stats.bodyH * 1.3) continue;
    if (cols.some((c) => l.x0 >= c.L - 3 && l.x1 <= c.R + 3 && Math.abs((l.x0 + l.x1) - (c.L + c.R)) <= 30)) b.body = true;
  }
  // a section heading read in two pieces ("3.3" and "Physical Experiments" as blocks of their own on one line)
  for (const b of page.blocks) {
    if (b.body || b.cap || b.capOf || b.margin || b.inTable || b.lines.length !== 1) continue;
    const l = b.lines[0];
    if (!/^(\d{1,2}(\.\d{1,2}){0,3}\.?|[A-Z]\.\d{1,2}(\.\d{1,2}){0,2}\.?|[IVX]{1,5}\.)$/.test(l.text) || l.h < stats.bodyH * 0.9 || l.h > stats.bodyH * 1.7) continue;
    if (!cols.some((c) => Math.abs(l.x0 - c.L) <= 3)) continue;
    const cy = (l.y0 + l.y1) / 2;
    const title = page.blocks.find((o) => o !== b && !o.cap && !o.capOf && !o.inTable && o.lines.length <= 2 && o.lines[0].y0 < cy && o.lines[0].y1 > cy
      && o.x0 > l.x1 && o.x0 - l.x1 < 30 && /^[A-Z]/.test(o.lines[0].text) && o.lines[0].n <= 14 && Math.abs(o.lines[0].h - l.h) <= 1.5);
    if (title) { b.body = true; title.body = true; }
  }
  cols.textL = Math.min(...[...cols, ...stats.columns].map((c) => c.L));
  cols.textR = Math.max(...[...cols, ...stats.columns].map((c) => c.R));
  return cols;
}

// ---------------------------------------------------------------- rules and frames (raster)
// The horizontal rules of a page: straight thin lines at least `minLen` points long (the rules of a table, of an
// algorithm, under a running header). Areas (pictures, shaded cells) are not rules.
function findRules(R, minLen = 48) {
  const out = [], w = R.w, h = R.h, need = Math.max(8, Math.round(minLen * R.sx));
  const px = (x, y) => R.cnt(x, y, x + 1, y + 1) > 0;
  const share = (x0, x1, y) => (y < 0 || y >= h ? 0 : R.cnt(x0, y, x1, y + 1) / (x1 - x0));
  for (let y = 0; y < h; y++) {
    if (R.cnt(0, y, w, y + 1) < need) continue;
    let x = 0;
    while (x < w) {
      if (!px(x, y)) { x++; continue; }
      const x0 = x;
      while (x < w && px(x, y)) x++;
      if (x - x0 < need) continue;
      if (share(x0, x, y - 1) >= 0.85) continue;          // the lower rows of something that began above
      let t = 1;
      while (t <= 3 && share(x0, x, y + t) >= 0.85) t++;
      if (t > 3) continue;                                // an area, not a line
      if (share(x0, x, y - 1) > 0.5 || share(x0, x, y + t) > 0.5) continue;
      out.push({ x0: x0 / R.sx, x1: x / R.sx, y0: y / R.sy, y1: (y + t) / R.sy });
    }
  }
  return out;
}
// Frames: two or more rules of the same extent one above the other - a table (top rule, rule under the head, bottom
// rule), an algorithm. A caption between two rules ends a frame (two tables of the same width, one above the other).
function findFrames(rules, caps = []) {
  const clusters = [];
  for (const r of rules.slice().sort((a, b) => a.y0 - b.y0)) {
    let c = clusters.find((k) => Math.abs(k.x0 - r.x0) <= 3 && Math.abs(k.x1 - r.x1) <= 3);
    if (!c) clusters.push(c = { x0: r.x0, x1: r.x1, rules: [] });
    c.rules.push(r);
  }
  const frames = [];
  const parts = (b) => [b, b.title, ...(b.more || [])].filter(Boolean);
  for (const c of clusters) {
    let run = [];
    const flush = () => {
      if (run.length >= 2 && run[run.length - 1].y1 - run[0].y0 >= 8) frames.push({ x0: Math.min(...run.map((r) => r.x0)), x1: Math.max(...run.map((r) => r.x1)), y0: run[0].y0, y1: run[run.length - 1].y1, n: run.length });
      run = [];
    };
    for (const r of c.rules) {
      const prev = run[run.length - 1];
      if (prev && caps.some((b) => parts(b).some((o) => o.y0 >= prev.y1 - 3 && o.y1 <= r.y0 + 3 && o.x1 > c.x0 && o.x0 < c.x1))) flush();
      run.push(r);
    }
    flush();
  }
  return frames;
}
// The frame that stands right above / below a table caption (null: none). Between the caption and the first rule
// there may be a head row (a table without a top rule, slanted column heads): the frame still counts when that
// stretch is drawn without a wide white band and holds no other caption. -> {f, d: white space between the caption
// and the table}
function frameFor(cap, frames, side, R, caps = []) {
  const end = capEnd(cap), cw = cap.x1 - cap.x0, found = [];
  for (const f of frames) {
    const ov = Math.min(f.x1, cap.x1) - Math.max(f.x0, cap.x0);
    if (ov < Math.min(0.5 * Math.min(f.x1 - f.x0, cw), 40)) continue; // (a caption set to the left margin over a centred table)
    const gap = side === 'below' ? f.y0 - end : cap.y0 - f.y1;
    if (gap < -3 || gap > 120) continue;
    let d = gap;
    if (gap > 30) {
      if (!R) continue;
      const strip = { x0: f.x0, x1: f.x1, y0: side === 'below' ? end + 0.5 : f.y1 + 0.5, y1: side === 'below' ? f.y0 - 0.5 : cap.y0 - 0.5 };
      if (caps.some((o) => o !== cap && o.y0 < strip.y1 && o.y1 > strip.y0 && o.x1 > strip.x0 && o.x0 < strip.x1)) continue;
      const a = R.rows(strip).a;
      if (side !== 'below') a.reverse(); // from the caption towards the frame
      let lead = 0, white = 0, widest = 0;
      while (lead < a.length && a[lead] === 0) lead++;
      for (let i = lead; i < a.length; i++) { if (a[i] === 0) { white++; widest = Math.max(widest, white); } else white = 0; }
      if (lead / R.sy > 30 || widest / R.sy > 12) continue;
      d = lead / R.sy;
    }
    found.push({ f, d });
  }
  // rules of several extents in one table (a full frame and the shorter rules under groups of columns): the
  // largest of the frames that start about where the nearest one does
  const dmin = Math.min(...found.map((x) => x.d));
  return found.filter((x) => x.d <= dmin + 12).sort((x, y) => area(y.f) - area(x.f))[0] || null;
}

// ---------------------------------------------------------------- the region of one caption (layout only)
// Horizontal range a caption speaks for: its column when the caption fits in one column of a multi-column page,
// else the width of the text; never across a caption standing beside it.
function xRange(cap, page, cols, caps) {
  // the width of the text: the columns of this page and those of the document (a page of tables only shows the
  // wrapped cells of a table as its "column")
  const textL = Number.isFinite(cols.textL) ? cols.textL : cols.length ? Math.min(...cols.map((c) => c.L)) : Math.min(cap.x0, page.w * 0.1);
  const textR = Number.isFinite(cols.textR) ? cols.textR : cols.length ? Math.max(...cols.map((c) => c.R)) : Math.max(cap.x1, page.w * 0.9);
  let xa = textL, xb = textR, wide = true;
  if (cols.length >= 2) {
    const c = cols.find((k) => cap.x0 >= k.L - 14 && cap.x1 <= k.R + 14);
    if (c) { xa = c.L; xb = c.R; wide = false; }
  }
  xa = Math.min(xa, cap.x0); xb = Math.max(xb, cap.x1);
  // floats side by side (two figures, or a figure beside a table): a caption standing clear to the left or right of
  // this one, on the same height or not far above / below, ends the range half way between the two
  let hardL = false, hardR = false;
  for (const o of caps) {
    if (o === cap) continue;
    const same = o.y0 < cap.y1 && o.y1 > cap.y0;
    const nearBy = Math.min(Math.abs(o.y0 - cap.y1), Math.abs(cap.y0 - o.y1)) < 200 && cap.x1 - cap.x0 < (xb - xa) * 0.62 && o.x1 - o.x0 < (xb - xa) * 0.62;
    if (!same && !nearBy) continue;
    if (o.x0 >= cap.x1) { const m = (cap.x1 + o.x0) / 2; if (m < xb) { xb = m; hardR = true; } }
    else if (o.x1 <= cap.x0) { const m = (cap.x0 + o.x1) / 2; if (m > xa) { xa = m; hardL = true; } }
  }
  // a narrow caption with running text beside it (a figure the text flows around): the text is the limit
  if (cap.x1 - cap.x0 < (xb - xa) * 0.62) {
    for (const o of page.blocks) {
      if (!o.body || o.y0 >= cap.y1 || o.y1 <= cap.y0) continue;
      if (o.x0 >= cap.x1 - 2) { xb = Math.min(xb, o.x0 - 3); hardR = true; }
      else if (o.x1 <= cap.x0 + 2) { xa = Math.max(xa, o.x1 + 3); hardL = true; }
    }
  }
  return { xa, xb, wide, textL, textR, hardL, hardR };
}
// The free area on one side of a caption: from the caption to the nearest body text / caption / margin block
// that lies in the horizontal range. -> {x0, y0, x1, y1, bound: 'text' | 'caption' | 'margin' | 'page'}
function sideRegion(cap, page, range, side) {
  const { xa, xb } = range;
  const capTop = cap.y0, capBottom = capEnd(cap);
  let edge = side === 'above' ? 0 : page.h, bound = 'page', obst = null;
  for (const b of [...page.blocks, ...(page.obst || [])]) { // (obst: the tables and algorithms found by their rules)
    if (b === cap || b.capOf === cap) continue;
    if (!(b.body || b.cap || b.capOf || b.margin || b.frame || b.algo)) continue;
    const ov = Math.min(b.x1, xb) - Math.max(b.x0, xa);
    if (!b.margin && ov <= Math.min(0.2 * (b.x1 - b.x0), 24)) continue;
    const kind = b.margin ? 'margin' : b.cap || b.capOf || b.frame || b.algo ? 'caption' : 'text';
    if (side === 'above') { if (b.y1 <= capTop + 2 && b.y1 > edge) { edge = b.y1; bound = kind; obst = b; } else if (b.y0 < capTop && b.y1 > capTop + 2 && capTop > edge) { edge = capTop; bound = kind; obst = null; } }
    else if (b.y0 >= capBottom - 2 && b.y0 < edge) { edge = b.y0; bound = kind; obst = b; }
    else if (b.y1 > capBottom && b.y0 < capBottom - 2 && capBottom < edge) { edge = capBottom; bound = kind; obst = null; }
  }
  const hard = { hardL: !!range.hardL, hardR: !!range.hardR, wide: !!range.wide };
  return side === 'above' ? { x0: xa, x1: xb, y0: edge + 0.5, y1: capTop - 0.5, bound, obst, ...hard } : { x0: xa, x1: xb, y0: capBottom + 0.5, y1: edge - 0.5, bound, obst, ...hard };
}

// ====================================================================== 2. raster (pure)
// PGM (P5) -> {w, h, sum}: `sum` is the summed-area table of the ink pixels, so any rectangle is counted at once.
function readPGM(buf) {
  let pos = 0;
  const token = () => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }
      break;
    }
    const s = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString('latin1', s, pos);
  };
  if (token() !== 'P5') throw new Error('not a PGM file');
  const w = Number(token()), h = Number(token()), max = Number(token());
  pos++; // the single white-space byte after the header
  if (!(w > 0 && h > 0) || max !== 255 || buf.length - pos < w * h) throw new Error('bad PGM file');
  return rasterOf(w, h, (x, y) => buf[pos + y * w + x] < INK);
}
function rasterOf(w, h, isInk) {
  const W = w + 1, sum = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { if (isInk(x, y)) row++; sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row; }
  }
  return { w, h, sum };
}
// A page raster addressed in PDF points
function pageRaster(r, page) {
  const sx = r.w / page.w, sy = r.h / page.h, W = r.w + 1;
  const cnt = (px0, py0, px1, py1) => { // pixel rectangle, right / bottom exclusive
    px0 = Math.max(0, Math.min(r.w, px0)); px1 = Math.max(px0, Math.min(r.w, px1)); py0 = Math.max(0, Math.min(r.h, py0)); py1 = Math.max(py0, Math.min(r.h, py1));
    return r.sum[py1 * W + px1] - r.sum[py0 * W + px1] - r.sum[py1 * W + px0] + r.sum[py0 * W + px0];
  };
  const X = (x) => Math.round(x * sx), Y = (y) => Math.round(y * sy);
  return {
    sx, sy, cnt, X, Y, w: r.w, h: r.h,
    ink: (b) => cnt(X(b.x0), Y(b.y0), Math.max(X(b.x0) + 1, X(b.x1)), Math.max(Y(b.y0) + 1, Y(b.y1))),
    // ink per pixel row / column of a box
    rows(b) { const x0 = X(b.x0), x1 = X(b.x1), y0 = Y(b.y0), y1 = Y(b.y1), a = []; for (let y = y0; y < y1; y++) a.push(cnt(x0, y, x1, y + 1)); return { a, y0, x0, x1 }; },
    colsOf(b) { const x0 = X(b.x0), x1 = X(b.x1), y0 = Y(b.y0), y1 = Y(b.y1), a = []; for (let x = x0; x < x1; x++) a.push(cnt(x, y0, x + 1, y1)); return { a, x0 }; },
    // the box shrunk to its ink (null: nothing is drawn there)
    trim(b) {
      const rw = this.rows(b), i0 = rw.a.findIndex((v) => v > 0);
      if (i0 < 0) return null;
      let i1 = rw.a.length - 1; while (rw.a[i1] === 0) i1--;
      const t = { x0: b.x0, x1: b.x1, y0: (rw.y0 + i0) / sy, y1: (rw.y0 + i1 + 1) / sy };
      const cl = this.colsOf(t), j0 = cl.a.findIndex((v) => v > 0);
      let j1 = cl.a.length - 1; while (cl.a[j1] === 0) j1--;
      return { x0: (cl.x0 + j0) / sx, x1: (cl.x0 + j1 + 1) / sx, y0: t.y0, y1: t.y1 };
    },
  };
}

// ====================================================================== 3. region = layout + raster
// Where the ink of a text line really ends. The boxes pdftotext reports follow the font's own metrics, and some
// fonts state them wrongly (a 9 pt line reported 4 pt high), so an edge taken from a box can cut through the
// letters. From the middle of the line walk up (dir -1) or down (+1) to the first white pixel row.
function inkEdge(R, line, dir, limit = 9) {
  const x0 = R.X(line.x0), x1 = Math.max(R.X(line.x0) + 1, R.X(line.x1));
  let y = R.Y((line.y0 + line.y1) / 2);
  if (R.cnt(x0, y, x1, y + 1) === 0) return null;
  const stop = y + dir * Math.round(limit * R.sy);
  while (y !== stop && R.cnt(x0, y, x1, y + 1) > 0) y += dir;
  if (R.cnt(x0, y, x1, y + 1) > 0) return null; // no white row within reach: leave the box as reported
  return (dir > 0 ? y : y + 1) / R.sy;
}
// a side region with its two ends moved off the letters of the caption and of the text block that bounds it
function snapRegion(reg, cap, R, side, page) {
  if (!R) return reg;
  const out = { ...reg };
  const last = (b) => b.lines[b.lines.length - 1];
  // the bounding block and the blocks that end on the same line (a running header comes in several pieces)
  const mates = (o, k) => (o ? page.blocks.filter((b) => (b.margin || b.body || b.cap || b.capOf) && Math.abs(b[k] - o[k]) < 4 && b.x1 > reg.x0 && b.x0 < reg.x1) : []);
  const endBlock = [cap, cap.title, ...(cap.more || [])].filter(Boolean).sort((a, b) => b.y1 - a.y1)[0];
  if (side === 'above') {
    const near = inkEdge(R, cap.lines[0], -1); if (near != null) out.y1 = Math.min(out.y1, near - 0.3);
    for (const o of mates(reg.obst, 'y1')) { const far = inkEdge(R, last(o), 1); if (far != null) out.y0 = Math.max(out.y0, far + 0.3); }
  } else {
    const near = inkEdge(R, last(endBlock), 1); if (near != null) out.y0 = Math.max(out.y0, near + 0.3);
    for (const o of mates(reg.obst, 'y0')) { const far = inkEdge(R, o.lines[0], -1); if (far != null) out.y1 = Math.min(out.y1, far - 0.3); }
  }
  return out;
}
const capEnd = (cap) => Math.max(cap.y1, cap.title ? cap.title.y1 : 0, cap.y1c || 0);
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
// The lines of the page that lie (mostly) inside a box
function linesIn(page, box, minOv = 0.5) {
  const out = [];
  for (const b of page.blocks) {
    if (b.y1 < box.y0 || b.y0 > box.y1 || b.x1 < box.x0 || b.x0 > box.x1) continue;
    for (const l of b.lines) {
      const cy = (l.y0 + l.y1) / 2, ov = Math.min(l.x1, box.x1) - Math.max(l.x0, box.x0);
      if (cy >= box.y0 && cy <= box.y1 && ov > (l.x1 - l.x0) * minOv) out.push(l);
    }
  }
  return out;
}
const AFFIL_RE = /@|https?:|www\.|\.(edu|com|org|io|ai)\b|Universit|Institut|Department|Laborator|School of|College|École|Equal contribution|Corresponding author|Project lead|Research\b|Inc\.|^[\d†‡*∗§¶]+\s?[A-Z]/;
const AUTHOR_RE = /[a-zé]\s?\d(\s?,\s?\d)*\s?[*†‡∗§]*\s?(,|$|\s[A-Z])|[a-zé]\s?[*†‡∗§]+\s?(,|$)/;
// Refine a side region with the raster: cut strips of plain body text off its far end (a heading, the last line of
// a paragraph, a formula that the layout step did not recognise), then trim to the ink.
// -> {box, ink (share of the box that is drawn), textShare, bodyWords, rules} or null when nothing is there.
function refine(reg, cap, page, R, stats, cols, side, kind, firstPage = false) {
  let box = { x0: reg.x0, x1: reg.x1, y0: reg.y0, y1: reg.y1 };
  if (box.y1 - box.y0 < 6) return null;
  if (!R) return { box, ink: null, textShare: 0, bodyWords: 0, rules: 0, cut: 0 };
  const GAP = firstPage && side === 'above' ? 2 : Math.max(3, Math.round(4.5 * R.sy)); // (author lines sit close above a teaser figure)
  let cut = 0;
  for (let round = 0; round < 8; round++) {
    const rw = R.rows(box);
    // segments of inked rows separated by white gaps
    const segs = [];
    let s = -1, white = 0;
    for (let i = 0; i <= rw.a.length; i++) {
      const on = i < rw.a.length && rw.a[i] > 0;
      if (on) { if (s < 0) s = i; white = 0; }
      else if (s >= 0) { white++; if (white >= GAP || i === rw.a.length) { segs.push([s, i - white + 1]); s = -1; } }
    }
    if (segs.length < 2) break;
    const far = side === 'above' ? segs[0] : segs[segs.length - 1];
    const strip = { x0: box.x0, x1: box.x1, y0: (rw.y0 + far[0]) / R.sy - 0.6, y1: (rw.y0 + far[1]) / R.sy + 0.6 };
    const ls = linesIn(page, strip, 0.12); // also a line that only reaches into the range (a title across the page)
    if (!ls.length) { // no text: on the first page a thin rule across (the lines around a title) goes too, anything else is the figure
      if (firstPage && side === 'above' && kind === 'figure' && strip.y1 - strip.y0 <= 5.5 && segs.length > 2) { box.y0 = strip.y1; cut++; continue; }
      break;
    }
    const total = R.ink(strip), inText = ls.reduce((n, l) => n + R.ink({ x0: l.x0 - 0.5, x1: l.x1 + 0.5, y0: Math.max(strip.y0, l.y0 - 3), y1: Math.min(strip.y1, l.y1 + 3) }), 0); // (generous: reported boxes can be lower than the letters)
    // one row of labels over the parts of the picture ("A Coupling ...   B Resolving ...", "w/ penalty   w/o penalty")
    // is not running text: running text starts at the left edge of a column
    if (kind === 'figure' && !firstPage && ls.length >= 2 && Math.max(...ls.map((l) => l.y0)) - Math.min(...ls.map((l) => l.y0)) < 3
      && (ls.some((l) => !cols.some((c) => l.x0 >= c.L - 3 && l.x0 <= c.L + 22)) || ls.every((l) => /^\(?[A-Ha-h]\)?[.:]?\s+[A-Z(]/.test(l.text)))) break;
    const bodyish = ls.filter((l) => bodyishLine(l, stats, cols));
    let strict = kind === 'table' ? bodyish.filter((l) => l.n >= 8).length >= Math.max(1, ls.length * 0.5) : bodyish.length >= Math.max(1, ls.length * 0.5);
    // the first page: title, authors, affiliations and addresses above a teaser figure are text of normal size or larger
    if (!strict && firstPage && side === 'above' && kind === 'figure') {
      const big = ls.filter((l) => l.h >= stats.bodyH * 0.7);
      strict = big.length >= ls.length * 0.6 && (cut > 0 || big.reduce((n, l) => n + l.n, 0) >= 5 || ls.some((l) => l.h >= stats.bodyH * 1.25));
    }
    // ... and so are author names with their marks ("Ann Lee 1,2*"), affiliations, e-mail and web addresses (often
    // small, the address often in a frame). Judged by what the lines say, not by their size.
    let affil = false;
    if (firstPage && side === 'above' && kind === 'figure') {
      const real = ls.filter((l) => l.text.length >= 3), chars = real.reduce((n, l) => n + l.text.length, 0);
      const hit = real.filter((l) => AFFIL_RE.test(l.text) || AUTHOR_RE.test(l.text)).reduce((n, l) => n + l.text.length, 0);
      affil = chars > 0 ? hit >= chars * 0.5 : cut > 0; // (a strip of marks only, between such lines)
    }
    if (!(total > 0 && (affil ? inText >= total * 0.6 : inText >= total * 0.88 && strict))) break;
    if (side === 'above') box.y0 = strip.y1; else box.y1 = strip.y0;
    cut++;
  }
  // a table: horizontal rules across (most of) it. Text below the last rule that reads like body text is not part of it.
  let rules = 0;
  const t0 = R.trim(box);
  if (!t0) return null;
  {
    const rw = R.rows({ x0: t0.x0, x1: t0.x1, y0: t0.y0, y1: t0.y1 }), wpx = rw.x1 - rw.x0;
    let last = -1, first = -1, prev = false;
    for (let i = 0; i < rw.a.length; i++) { const on = rw.a[i] >= wpx * 0.85; if (on && !prev) { rules++; if (first < 0) first = i; } if (on) last = i; prev = on; }
    if (kind === 'table' && rules >= 2 && side === 'below') {
      const yLast = (rw.y0 + last + 1) / R.sy;
      const tail = { x0: box.x0, x1: box.x1, y0: yLast + 1, y1: box.y1 };
      const ls = tail.y1 - tail.y0 > 4 ? linesIn(page, tail) : [];
      if (ls.filter((l) => bodyishLine(l, stats, cols) && (l.n >= 5 || HEADING_RE.test(l.text))).length >= Math.max(1, ls.length * 0.4)) { box.y1 = yLast + 1; cut++; }
    }
    if (kind === 'table' && rules >= 2 && side === 'above') {
      const yFirst = (rw.y0 + first) / R.sy;
      const head = { x0: box.x0, x1: box.x1, y0: box.y0, y1: yFirst - 1 };
      const ls = head.y1 - head.y0 > 4 ? linesIn(page, head) : [];
      if (ls.filter((l) => bodyishLine(l, stats, cols) && l.n >= 5).length >= Math.max(1, ls.length * 0.4)) { box.y0 = yFirst - 1; cut++; }
    }
  }
  // trim to the ink, looking a little beyond the text width (figures often stick out), but not into the next column
  const pad = 14;
  let blockL = false, blockR = false, textL = false, textR = false;
  const look = { x0: Math.max(0, box.x0 - (reg.hardL ? 0 : pad)), x1: Math.min(page.w, box.x1 + (reg.hardR ? 0 : pad)), y0: box.y0, y1: box.y1 }; // (no look-aside towards a neighbouring float)
  for (const b of [...page.blocks, ...(page.obst || [])]) { // body text or another float beside the region limits the look-aside
    if (!(b.body || b.cap || b.frame || b.stamp) || b === cap || b.y1 <= box.y0 || b.y0 >= box.y1) continue;
    if (b.x0 >= box.x1 - 2) { look.x1 = Math.min(look.x1, Math.max(box.x1, b.x0 - 2)); blockR = true; if (b.body) textR = true; }
    if (b.x1 <= box.x0 + 2) { look.x0 = Math.max(look.x0, Math.min(box.x0, b.x1 + 2)); blockL = true; if (b.body) textL = true; }
    // a table that reaches a little into this column from the neighbouring one: nothing of it belongs to the crop
    if (b.frame && b.x1 > box.x0 + 2 && (b.x0 + b.x1) / 2 < box.x0) { look.x0 = Math.max(look.x0, b.x1 + 2); blockL = true; }
    if (b.frame && b.x0 < box.x1 - 2 && (b.x0 + b.x1) / 2 > box.x1) { look.x1 = Math.min(look.x1, b.x0 - 2); blockR = true; }
  }
  let t = R.trim(look);
  if (!t) return null;
  // Where the ink reaches the limit of the look-aside, the crop would cut through something. Two floats side by
  // side (the limit is the middle between their captions, the pictures may meet somewhere else): the white column
  // nearest to the limit is the real border. A figure of one column whose neighbour reaches into the gutter (or
  // which itself does): the first white column outwards, up to the next column - else the first one inwards, but
  // never inside the column itself.
  for (const dir of [-1, 1]) {
    const hard = dir < 0 ? reg.hardL : reg.hardR;
    if (!(dir < 0 ? t.x0 - look.x0 <= 1.5 / R.sx : look.x1 - t.x1 <= 1.5 / R.sx) || (!hard && (reg.wide || (dir < 0 ? blockL : blockR)))) continue;
    const y0 = R.Y(t.y0), y1 = R.Y(t.y1), at = R.X(dir < 0 ? look.x0 : look.x1);
    const white = (x) => x >= 0 && x < R.w && R.cnt(x, y0, x + 1, y1) === 0;
    let found = null;
    if (hard) {
      const reach = Math.round(26 * R.sx);
      for (let d = 1; d <= reach && found == null; d++) { if (white(at - d)) found = at - d; else if (white(at + d - 1)) found = at + d - 1; }
    } else {
      const nb = cols.filter((c) => (dir < 0 ? c.R < box.x0 : c.L > box.x1)).map((c) => (dir < 0 ? c.R + 1 : c.L - 1));
      const out = nb.length ? R.X(dir < 0 ? Math.max(...nb) : Math.min(...nb)) : at + dir * Math.round(26 * R.sx);
      for (let x = at + (dir < 0 ? -1 : 0); (dir < 0 ? x >= out : x < out) && found == null; x += dir) if (white(x)) found = x;
      const edge = R.X(dir < 0 ? box.x0 : box.x1);
      for (let x = at + (dir < 0 ? 0 : -1); (dir < 0 ? x < edge : x >= edge) && found == null; x -= dir) if (white(x)) found = x;
    }
    if (found == null) continue;
    if (dir < 0) look.x0 = (found + 1) / R.sx; else look.x1 = found / R.sx;
    t = R.trim(look) || t;
  }
  // a float across the page that sticks out further than the look-aside: follow the ink to the next white column
  if (reg.wide) {
    let grown = false;
    const y0 = R.Y(t.y0), y1 = R.Y(t.y1), max = Math.round(90 * R.sx);
    for (const dir of [-1, 1]) {
      if (dir < 0 ? reg.hardL || blockL || t.x0 - look.x0 > 1.5 / R.sx : reg.hardR || blockR || look.x1 - t.x1 > 1.5 / R.sx) continue;
      let x = R.X(dir < 0 ? look.x0 : look.x1), n = 0;
      while (n < max && x > 0 && x < R.w && R.cnt(dir < 0 ? x - 1 : x, y0, dir < 0 ? x : x + 1, y1) > 0) { x += dir; n++; }
      if (n && n < max) { if (dir < 0) look.x0 = x / R.sx; else look.x1 = x / R.sx; grown = true; }
    }
    if (grown) t = R.trim(look) || t;
  }
  return { box: t, lim: { y0: box.y0, y1: box.y1 }, rules, cut, textL, textR, ...measure(t, page, R, stats, cols) };
}
// Is what `refine` found a picture / a table, and how good is it? -> 0 (no) .. 1
function quality(r, kind, page) {
  if (!r) return 0;
  const w = r.box.x1 - r.box.x0, h = r.box.y1 - r.box.y0;
  if (w < 36 || h < (kind === 'table' ? 14 : 22)) return 0;
  if (r.ink == null) return 0.5; // no raster: the layout alone
  if (r.ink < 0.004) return 0;
  let q = 1;
  if (kind === 'figure') {
    if (r.textShare > 0.93 && r.bodyWords >= 12) return 0;       // plain text, not a figure
    if (r.textShare > 0.93) q -= 0.25;
    if (r.bodyWords > 60) q -= 0.35; else if (r.bodyWords > 25) q -= 0.15;
    if (h < 40) q -= 0.2;
  } else {
    if (r.bodyWords > 120 && !r.rules) q -= 0.4; else if (r.bodyWords > 60 && !r.rules) q -= 0.2;
    if (r.rules >= 2) q += 0.05;
    if (r.rules === 0 && r.textShare < 0.5) q -= 0.15;             // drawn, but no rule: maybe a picture after all
  }
  if (h > page.h * 0.8) q -= 0.25;
  return Math.max(0.05, Math.min(1, q));
}

// What a crop holds: {ink (share of the box that is drawn), textShare (how much of the ink is text), bodyWords}
function measure(t, page, R, stats, cols) {
  const ls = linesIn(page, t);
  const total = R.ink(t), inText = ls.reduce((n, l) => n + R.ink({ x0: l.x0, x1: l.x1, y0: l.y0 - 1.5, y1: l.y1 + 1.5 }), 0);
  const bodyWords = ls.filter((l) => bodyishLine(l, stats, cols)).reduce((n, l) => n + l.n, 0);
  return { ink: total / Math.max(1, (R.X(t.x1) - R.X(t.x0)) * (R.Y(t.y1) - R.Y(t.y0))), textShare: total ? Math.min(1, inText / total) : 0, bodyWords };
}
// A caption set BESIDE its picture: a narrow caption of several lines with the plot to its right (or left), as some
// journal styles do. The picture is what is drawn at the height of the caption, up and down to the first wide white
// band, between the text above and below. -> {reg, r} or null
function besideRegion(cap, page, cols, R, stats) {
  if (!R || !Number.isFinite(cols.textL)) return null;
  const end = capEnd(cap);
  let best = null;
  for (const dir of [1, -1]) {
    let x0 = Math.max(0, dir > 0 ? cap.x1 + 5 : cols.textL - 10), x1 = Math.min(page.w, dir > 0 ? cols.textR + 10 : cap.x0 - 5);
    let top = 0, bottom = page.h;
    for (const b of [...page.blocks, ...(page.obst || [])]) {
      if (b === cap || b.capOf === cap || !(b.body || b.cap || b.capOf || b.margin || b.frame || b.algo)) continue;
      if (!b.margin && Math.min(b.x1, x1) - Math.max(b.x0, x0) <= 8) continue;
      if (b.y1 <= cap.y0 + 4) top = Math.max(top, b.y1 + 1);
      else if (b.y0 >= end - 4) bottom = Math.min(bottom, b.y0 - 1);
      else if (dir > 0) x1 = Math.min(x1, b.x0 - 3); else x0 = Math.max(x0, b.x1 + 3); // text at the height of the caption
    }
    if (x1 - x0 < 60 || bottom - top < 30) continue;
    const rw = R.rows({ x0, x1, y0: top, y1: bottom }), GAP = Math.max(3, Math.round(7 * R.sy));
    let s = -1;
    for (let i = Math.max(0, R.Y(cap.y0) - rw.y0); i < Math.min(rw.a.length, R.Y(end) - rw.y0); i++) if (rw.a[i] > 0) { s = i; break; }
    if (s < 0) continue;
    let a = s, z = s, white = 0;
    for (let i = s - 1; i >= 0; i--) { if (rw.a[i] > 0) { a = i; white = 0; } else if (++white >= GAP) break; }
    white = 0;
    for (let i = s + 1; i < rw.a.length; i++) { if (rw.a[i] > 0) { z = i; white = 0; } else if (++white >= GAP) break; }
    const reg = { x0, x1, y0: (rw.y0 + a) / R.sy, y1: (rw.y0 + z + 1) / R.sy, bound: 'beside', dir };
    const t = R.trim(reg);
    if (!t) continue;
    const r = { box: t, lim: null, rules: 0, cut: 0, ...measure(t, page, R, stats, cols) };
    if (!best || area(t) > area(best.r.box)) best = { reg, r };
  }
  return best;
}
// Does the crop cut through something? The ink goes on right outside its left or right edge on many rows, or a
// straight line runs on across the edge. -> 'left' | 'right' | null
function edgeCut(box, R, skip = {}) {
  const y0 = R.Y(box.y0), y1 = R.Y(box.y1), L = Math.max(4, Math.round(10 * R.sx));
  for (const dir of [-1, 1]) {
    if (dir < 0 ? skip.left : skip.right) continue;
    const xe = dir < 0 ? R.X(box.x0) : R.X(box.x1), a = dir < 0 ? xe - 2 : xe;
    if (a < 0 || a + 2 > R.w) continue;
    let on = 0, cross = false;
    for (let y = y0; y < y1; y++) {
      if (R.cnt(a, y, a + 2, y + 1) === 0) continue;
      on++;
      if (R.cnt(xe - L, y, xe + L, y + 1) >= 2 * L - 1) cross = true;
    }
    if (on > (y1 - y0) * 0.12 || cross) return dir < 0 ? 'left' : 'right';
  }
  return null;
}

const MIN_PLACE = 0.5; // below this a crop is offered in the picker, but never put into a note unasked
// All figures and tables of a document. `rasters` maps a page number (1-based) to the output of readPGM (missing
// pages are handled from the layout alone, and never trusted enough to be placed).
// `confidence` says how sure the CROP is, not how the caption is worded: it starts high and every check the final
// box fails (cut at an edge, running text inside, another float inside or overlapping, the unusual side of the
// caption, found without a raster) puts it under MIN_PLACE; `why` lists those checks.
function analyze(pages, rasters = {}, debug = null) {
  const stats = docStats(pages);
  // 1. the captions. A weaker wording loses against a certain one of the same number ("Table 2" as the name of a
  //    column against "Table 2. Camera tracking ..."), before it can stand in the way of a region.
  const capsOf = pages.map((p) => findCaptions(p));
  for (const caps of capsOf) {
    const top = new Map();
    for (const b of caps) top.set(b.cap.key, Math.max(top.get(b.cap.key) || 0, b.cap.score));
    for (let k = caps.length - 1; k >= 0; k--) if (caps[k].cap.score < top.get(caps[k].cap.key) - 0.12) { uncaption(caps[k]); caps.splice(k, 1); }
  }

  // 2. the rules of each page with a caption; tables are taken from their frame of rules where one stands right
  //    above or below the caption
  const info = pages.map((page, pi) => {
    const caps = capsOf[pi];
    page.obst = [];
    if (!caps.length) return null;
    const raw = rasters[pi + 1], R = raw ? pageRaster(raw, page) : null;
    const rules = R ? findRules(R).filter((r) => !(stats.headerY != null && r.y1 <= stats.headerY + 6) && !(stats.footerY != null && r.y0 >= stats.footerY - 6)) : [];
    return { page, pi, caps, R, frames: findFrames(rules, caps), claimed: new Map() };
  });
  const opts = [], tv = { above: 0, below: 0 };
  for (const I of info) {
    if (!I) continue;
    for (const cap of I.caps) {
      if (cap.cap.kind !== 'table') continue;
      const o = { I, cap, above: frameFor(cap, I.frames, 'above', I.R, I.caps), below: frameFor(cap, I.frames, 'below', I.R, I.caps) };
      if (!o.above && !o.below) continue;
      if (!o.above !== !o.below) { o.one = o.above ? 'above' : 'below'; tv[o.one]++; }
      opts.push(o);
    }
  }
  const prefT = tv.above > tv.below ? 'above' : 'below', taken = new Set();
  const claim = (o, side, sure) => {
    const f = o[side].f, I = o.I;
    taken.add(f);
    // rules of another extent that belong to the same table (a head set narrower, a frame inside the frame)
    const u = { x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 };
    for (const g of I.frames) {
      if (g === f || taken.has(g)) continue;
      const oy = Math.min(g.y1, f.y1) - Math.max(g.y0, f.y0), ox = Math.min(g.x1, f.x1) - Math.max(g.x0, f.x0);
      if (oy >= 0.6 * (g.y1 - g.y0) && ox >= 0.5 * (g.x1 - g.x0)) { taken.add(g); u.x0 = Math.min(u.x0, g.x0); u.x1 = Math.max(u.x1, g.x1); u.y0 = Math.min(u.y0, g.y0); u.y1 = Math.max(u.y1, g.y1); }
    }
    // The rules do not always show the whole table (a head row above the first rule, shaded rows that hide the
    // last rule, rows after it): on the side of the caption the table starts at the caption; on the far side it
    // goes on while rows follow each other closely, up to the next caption or float and never into running text.
    const R = I.R, end = capEnd(o.cap), dir = side === 'below' ? 1 : -1;
    let lim = dir > 0 ? (stats.footerY != null ? stats.footerY : I.page.h) : (stats.headerY != null ? stats.headerY : 0);
    const others = [...I.caps.filter((c) => c !== o.cap).flatMap((c) => [c, c.title, ...(c.more || [])].filter(Boolean)), ...I.page.obst];
    for (const q of others) {
      if (q.x1 <= u.x0 || q.x0 >= u.x1) continue;
      if (dir > 0 && q.y0 >= u.y1 - 2) lim = Math.min(lim, q.y0 - 1);
      if (dir < 0 && q.y1 <= u.y0 + 2) lim = Math.max(lim, q.y1 + 1);
    }
    let far = dir > 0 ? u.y1 : u.y0, grew = false;
    const strip = dir > 0 ? { x0: u.x0 - 2, x1: u.x1 + 2, y0: u.y1 + 0.5, y1: lim } : { x0: u.x0 - 2, x1: u.x1 + 2, y0: lim, y1: u.y0 - 0.5 };
    if (strip.y1 - strip.y0 >= 3) {
      const rw = R.rows(strip), n = rw.a.length, GAP = Math.max(3, Math.round(6 * R.sy));
      let last = -1, white = 0;
      for (let k = 0; k < n; k++) { if (rw.a[dir > 0 ? k : n - 1 - k] > 0) { last = k; white = 0; } else if (++white >= GAP) break; }
      if (last >= 0) {
        let to = dir > 0 ? (rw.y0 + last + 1) / R.sy : (rw.y0 + n - 1 - last) / R.sy;
        const ls = linesIn(I.page, dir > 0 ? { ...strip, y1: to } : { ...strip, y0: to }).sort((a, b2) => (dir > 0 ? a.y0 - b2.y0 : b2.y0 - a.y0));
        const text = ls.find((l) => l.n >= 6 && bodyishLine(l, stats, stats.columns));
        if (text) to = dir > 0 ? text.y0 - 1 : text.y1 + 1;
        if (dir > 0 ? to > far + 4 : to < far - 4) { far = to; grew = true; }
      }
    }
    if (dir > 0) u.y1 = far; else u.y0 = far;
    for (const g of I.frames) { // rules inside the part the table grew by are its own
      if (taken.has(g) || (g.y0 + g.y1) / 2 < u.y0 || (g.y0 + g.y1) / 2 > u.y1 || Math.min(g.x1, u.x1) - Math.max(g.x0, u.x0) < 0.5 * (g.x1 - g.x0)) continue;
      taken.add(g); u.x0 = Math.min(u.x0, g.x0); u.x1 = Math.max(u.x1, g.x1);
    }
    // (where the letters of the caption really end: the boxes pdftotext reports can be lower than the ink)
    const endBlock = [o.cap, o.cap.title, ...(o.cap.more || [])].filter(Boolean).sort((a, b2) => b2.y1 - a.y1)[0];
    const ink = side === 'below' ? inkEdge(R, endBlock.lines[endBlock.lines.length - 1], 1) : inkEdge(R, o.cap.lines[0], -1);
    const near = side === 'below' ? Math.max(end, ink == null ? end : ink) + 0.3 : Math.min(o.cap.y0, ink == null ? o.cap.y0 : ink) - 0.3;
    const look = { x0: u.x0 - 4, x1: u.x1 + 4, y0: side === 'below' ? near : u.y0 - 1, y1: side === 'above' ? near : u.y1 + 1 };
    const box = R.trim(look) || u;
    I.claimed.set(o.cap, { f, side, box, n: f.n, sure, grew, near });
    I.page.obst.push({ x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1, frame: true, table: true, cap: null, of: o.cap });
  };
  // a caption with a frame on one side only takes it - first those on the side this paper prefers, so that a frame
  // between two captions goes to the right one; then the captions with a frame on both sides: the nearer one
  for (const side of [prefT, prefT === 'above' ? 'below' : 'above']) for (const o of opts) if (o.one === side && !taken.has(o[side].f)) claim(o, side, true);
  for (const o of opts) {
    if (o.I.claimed.has(o.cap)) continue;
    const A = o.above && !taken.has(o.above.f), B = o.below && !taken.has(o.below.f);
    if (!A && !B) continue;
    const side = A && B ? (Math.abs(o.above.d - o.below.d) > 4 ? (o.above.d < o.below.d ? 'above' : 'below') : prefT) : A ? 'above' : 'below';
    claim(o, side, !(A && B) || Math.abs(o.above.d - o.below.d) > 8 || tv[side] >= 3 * Math.max(1, tv[side === 'above' ? 'below' : 'above']));
  }
  // algorithms are floats too: their frame (or at least their head line) bounds a figure like a caption does
  for (const I of info) {
    if (!I) continue;
    for (const b of I.page.blocks) {
      b.algo = false;
      if (b.cap || !/^Algorithm\s+\d{1,2}\b\s*[:.]?(\s|$)/.test(b.lines[0].text)) continue;
      const cy = (b.lines[0].y0 + b.lines[0].y1) / 2;
      const f = I.frames.filter((g) => !taken.has(g) && cy > g.y0 - 14 && cy < g.y1 && b.x1 > g.x0 && b.x0 < g.x1).sort((x, y) => area(y) - area(x))[0];
      if (f) { taken.add(f); I.page.obst.push({ x0: f.x0, x1: f.x1, y0: Math.min(f.y0, b.y0), y1: f.y1, frame: true, algo: true }); } else b.algo = true;
    }
  }

  // 3. the two sides of every other caption (layout, then the raster)
  const cands = [];
  for (const I of info) {
    if (!I) continue;
    const { page, pi, caps, R } = I;
    const cols = classifyPage(page, stats, page.obst.filter((o) => o.table));
    for (const b of page.blocks) if (b.algo) b.body = false;
    I.cols = cols;
    for (const cap of caps) {
      const range = xRange(cap, page, cols, caps), kind = cap.cap.kind;
      const none = { reg: null, r: null, q: 0 };
      const cl = I.claimed.get(cap);
      if (cl) {
        const b = cl.box;
        const reg = { x0: b.x0, x1: b.x1, y0: cl.side === 'below' ? Math.max(b.y0 - 3, cl.near) : b.y0 - 3, y1: cl.side === 'above' ? Math.min(b.y1 + 3, cl.near) : b.y1 + 3, bound: 'frame' };
        const r = { box: b, lim: null, rules: cl.n, cut: 0, frame: true, sure: cl.sure, grew: cl.grew, ...measure(b, page, R, stats, cols) };
        cands.push({ cap, page, pi, range, R, cols, sides: { above: none, below: none, [cl.side]: { reg, r, q: 1 } } });
        continue;
      }
      const sides = {};
      for (const side of ['above', 'below']) {
        let reg = snapRegion(sideRegion(cap, page, range, side), cap, R, side, page);
        let r = refine(reg, cap, page, R, stats, cols, side, kind, pi === 0);
        // a column-wide caption under a picture that runs across the columns: the picture crosses the gutter and
        // goes on in the neighbouring column (ink in the gutter alone is a table or a plot that is a little too wide)
        if (r && R && !range.wide && !range.hardL && !range.hardR && cols.length >= 2) {
          const mine = cols.find((k) => cap.x0 >= k.L - 14 && cap.x1 <= k.R + 14), at = cols.indexOf(mine);
          const nb = at >= 0 ? [cols[at - 1], cols[at + 1]].filter(Boolean) : [];
          for (const o of nb) {
            const right = o.L > mine.L, g = right ? { x0: mine.R + 1.5, x1: o.L - 1.5 } : { x0: o.R + 1.5, x1: mine.L - 1.5 };
            if (g.x1 - g.x0 < 3) continue;
            const rw = R.rows({ ...g, y0: r.box.y0, y1: r.box.y1 });
            if (rw.a.filter((v) => v > 0).length < rw.a.length * 0.3) continue;
            const band = R.rows({ x0: right ? o.L + 4 : o.R - 44, x1: right ? o.L + 44 : o.R - 4, y0: r.box.y0, y1: r.box.y1 });
            if (band.a.filter((v) => v > 0).length < band.a.length * 0.5) continue;
            const wideRange = { ...range, xa: range.textL, xb: range.textR, wide: true };
            const reg2 = snapRegion(sideRegion(cap, page, wideRange, side), cap, R, side, page);
            const r2 = refine(reg2, cap, page, R, stats, cols, side, kind, pi === 0);
            if (r2 && area(r2.box) > area(r.box) * 1.25 && quality(r2, kind, page) >= quality(r, kind, page) - 0.1) { r = r2; reg = reg2; r.widened = true; }
            break;
          }
        }
        sides[side] = { reg, r, q: quality(r, kind, page) };
      }
      // nothing above, nothing below, and the caption is a narrow one of several lines: the picture stands beside it
      // (also when above / below only holds the part of that picture that reaches past the caption: a region that
      // starts right at the caption, smaller than what stands beside it)
      if (kind === 'figure' && R && cap.lines.length + (cap.more || []).reduce((n, o) => n + o.lines.length, 0) >= 3 && cap.x1 - cap.x0 < (range.textR - range.textL) * 0.4) {
        const bs = besideRegion(cap, page, cols, R, stats);
        const q = bs ? quality(bs.r, kind, page) : 0;
        if (q > 0) {
          const part = (sd) => sides[sd].q > 0 && (sd === 'above' ? cap.y0 - sides[sd].r.box.y1 : sides[sd].r.box.y0 - capEnd(cap)) < 3 && area(sides[sd].r.box) < area(bs.r.box);
          for (const sd of ['above', 'below']) if (part(sd)) sides[sd] = { ...sides[sd], q: 0 };
          if (!sides.above.q && !sides.below.q) sides.beside = { ...bs, q };
        }
      }
      cands.push({ cap, page, pi, sides, range, R, cols });
    }
  }
  // Which side the picture is on: the usual one (figure above, table below its caption) unless only the other side
  // holds something; where both do, the side the unambiguous captions of the same kind use in this paper.
  const usual = { figure: 'above', table: 'below' }, votes = { figure: { above: 0, below: 0 }, table: { above: 0, below: 0 } };
  for (const c of cands) { const a = c.sides.above.q > 0, b = c.sides.below.q > 0; if (a !== b) votes[c.cap.cap.kind][a ? 'above' : 'below'] += 1; }
  const picks = [];
  for (const c of cands) {
    const kind = c.cap.cap.kind, v = votes[kind];
    const pref = v.above === v.below ? usual[kind] : v.above > v.below ? 'above' : 'below';
    const other = pref === 'above' ? 'below' : 'above';
    let side = c.sides[pref].q > 0 ? pref : c.sides[other].q > 0 ? other : c.sides.beside && c.sides.beside.q > 0 ? 'beside' : null;
    if (!side) { if (debug) debug.push({ key: c.cap.cap.key, page: c.pi + 1, why: 'nothing on either side', text: c.cap.lines[0].text.slice(0, 60), above: c.sides.above.reg, below: c.sides.below.reg, ra: c.sides.above.r, rb: c.sides.below.r }); continue; }
    // both sides hold something and this paper gives no lead: a clearly better other side wins
    if (side === pref && c.sides[other].q > 0 && v.above === v.below && c.sides[other].q >= c.sides[pref].q + 0.3) side = other;
    picks.push({ c, side, pref, box: { ...c.sides[side].r.box }, why: [], soft: [] });
  }
  // A table (below its caption) directly followed by a figure (above its caption) share the space between the two
  // captions: it is divided at its widest white band. (Tables found by their rules never get here.)
  for (const a of picks) {
    if (a.side !== 'below' || a.c.sides.below.r.frame) continue;
    for (const b of picks) {
      if (b === a || b.c.pi !== a.c.pi || b.side !== 'above' || b.c.cap.cap.kind !== 'figure' || b.c.sides.above.r.frame || b.c.cap.y0 <= a.c.cap.y0) continue;
      const ov = Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0), ox = Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0);
      if (ov < 0.5 * Math.min(a.box.y1 - a.box.y0, b.box.y1 - b.box.y0) || ox < 0.5 * Math.min(a.box.x1 - a.box.x0, b.box.x1 - b.box.x0)) continue;
      const R = a.c.R, u = { x0: Math.min(a.box.x0, b.box.x0), x1: Math.max(a.box.x1, b.box.x1), y0: Math.min(a.box.y0, b.box.y0), y1: Math.max(a.box.y1, b.box.y1) };
      let best = null;
      if (R) {
        const rw = R.rows(u);
        let s0 = -1;
        for (let i = 0; i <= rw.a.length; i++) {
          const white = i < rw.a.length && rw.a[i] === 0;
          if (white) { if (s0 < 0) s0 = i; } else if (s0 >= 0) { if (s0 > 0 && i < rw.a.length && (!best || i - s0 > best[1] - best[0])) best = [s0, i]; s0 = -1; }
        }
        if (best && (best[1] - best[0]) / R.sy < 4) best = null;
        if (best) {
          const ta = R.trim({ ...u, x0: a.box.x0, x1: a.box.x1, y1: (rw.y0 + best[0]) / R.sy }), tb = R.trim({ ...u, x0: b.box.x0, x1: b.box.x1, y0: (rw.y0 + best[1]) / R.sy });
          if (ta && tb) { a.box = ta; b.box = tb; a.soft.push('shared'); b.soft.push('shared'); } else best = null;
        }
      }
      if (!best) { a.why.push('shared'); b.why.push('shared'); }
    }
  }
  // 4. the final boxes, and what each of them fails
  const minH = (kind) => (kind === 'table' ? 14 : 22);
  const done = [];
  for (const pk of picks) {
    const { c, side, pref } = pk;
    const kind = c.cap.cap.kind, v = votes[kind], S = c.sides[side], R = c.R;
    if (pk.box.x1 - pk.box.x0 < 36 || pk.box.y1 - pk.box.y0 < minH(kind)) { if (debug) debug.push({ key: c.cap.cap.key, page: c.pi + 1, why: 'the final box is tiny', text: c.cap.lines[0].text.slice(0, 60) }); continue; }
    const m = 3; // margin kept around the ink, never across the caption
    const b = { x0: Math.max(0, pk.box.x0 - m), x1: Math.min(c.page.w, pk.box.x1 + m), y0: Math.max(0, pk.box.y0 - m), y1: Math.min(c.page.h, pk.box.y1 + m) };
    if (side === 'beside') { if (S.reg.dir > 0) b.x0 = Math.max(b.x0, Math.min(pk.box.x0, c.cap.x1 + 1)); else b.x1 = Math.min(b.x1, Math.max(pk.box.x1, c.cap.x0 - 1)); }
    else {
      if (side === 'above') b.y1 = Math.min(b.y1, Math.max(pk.box.y1, S.reg.y1)); else b.y0 = Math.max(b.y0, Math.min(pk.box.y0, S.reg.y0));
      // ... nor across the text that bounds the region on the other side
      if (side === 'above') b.y0 = Math.max(b.y0, Math.min(pk.box.y0, S.reg.y0)); else b.y1 = Math.min(b.y1, Math.max(pk.box.y1, S.reg.y1));
      // ... and never across the place where text was cut off (the margin would bring half a line back)
      const lim = S.r.lim;
      if (lim && S.r.cut) { b.y0 = Math.max(b.y0, Math.min(pk.box.y0, lim.y0)); b.y1 = Math.min(b.y1, Math.max(pk.box.y1, lim.y1)); }
    }
    const both = c.sides.above.q > 0 && c.sides.below.q > 0, why = pk.why, soft = pk.soft;
    if (!R) why.push('no raster');
    else if (!S.r.frame) {
      const e = edgeCut(pk.box, R, { left: S.r.textL, right: S.r.textR }); // (running text right beside the crop is not a cut)
      if (e) why.push('cut at the ' + e);
      if (kind === 'figure' && linesIn(c.page, pk.box).filter((l) => l.n >= 7 && bodyishLine(l, stats, c.cols)).length >= 3) why.push('running text inside');
    }
    if (S.r.frame && !S.r.sure) soft.push('a table on both sides');
    if (S.r.frame && S.r.grew) soft.push('goes on beyond its rules');
    for (const o of c.page.blocks) { // the caption of another float inside the crop
      if (!o.cap || o === c.cap) continue;
      const l = o.lines[0], cy = (l.y0 + l.y1) / 2, cx = (l.x0 + l.x1) / 2;
      if (cy > pk.box.y0 && cy < pk.box.y1 && cx > pk.box.x0 && cx < pk.box.x1) { why.push('another caption inside'); break; }
    }
    const strong = v[side] >= 3 && v[side] >= 3 * v[side === 'above' ? 'below' : 'above'];
    if (both && side !== usual[kind]) (strong ? soft : why).push('the unusual side');
    if (side !== pref && side !== 'beside') soft.push('not the side this paper uses');
    if (S.r.widened) soft.push('widened across the columns');
    if (side === 'beside') soft.push('beside the caption');
    if (c.cap.cap.score < 0.6) why.push('weak caption wording');
    done.push({ pk, b, both });
  }
  // two crops of one page that overlap: one of them holds (a part of) the other
  for (const x of done) {
    for (const y of done) {
      if (x === y || x.pk.c.pi !== y.pk.c.pi) continue;
      const ox = Math.min(x.b.x1, y.b.x1) - Math.max(x.b.x0, y.b.x0), oy = Math.min(x.b.y1, y.b.y1) - Math.max(x.b.y0, y.b.y0);
      if (ox > 8 && oy > 8 && !(x.pk.c.cap.cap.key === y.pk.c.cap.cap.key)) { if (!x.pk.why.includes('overlaps ' + y.pk.c.cap.cap.label)) x.pk.why.push('overlaps ' + y.pk.c.cap.cap.label); }
    }
  }
  const out = new Map();
  for (const { pk, b } of done) {
    const { c, side } = pk, kind = c.cap.cap.kind, S = c.sides[side];
    let conf = (0.9 + (c.cap.cap.score >= 0.9 ? 0.05 : 0)) * (0.4 + 0.6 * S.q);
    if (pk.soft.length) conf = Math.min(conf, 0.7);
    if (pk.why.length) conf = Math.min(conf, 0.4);
    conf = Math.round(Math.max(0.05, Math.min(0.98, conf)) * 100) / 100;
    const fig = {
      key: c.cap.cap.key, kind, number: c.cap.cap.number, label: c.cap.cap.label, page: c.pi + 1, caption: captionText(c.cap),
      box: { x: round1(b.x0), y: round1(b.y0), w: round1(b.x1 - b.x0), h: round1(b.y1 - b.y0) }, pageW: round1(c.page.w), pageH: round1(c.page.h),
      confidence: conf, side, wide: (b.x1 - b.x0) >= (c.range.textR - c.range.textL) * 0.62,
      ...(pk.why.length || pk.soft.length ? { why: [...pk.why, ...pk.soft] } : {}),
    };
    // the same number twice (on two pages): the caption worded more certainly, then the better crop
    const old = out.get(fig.key), sc = c.cap.cap.score;
    if (!old || sc > old.score + 0.2 || (sc >= old.score - 0.2 && fig.confidence > old.fig.confidence + 0.001)) out.set(fig.key, { fig, score: sc });
  }
  for (const p of pages) delete p.obst;
  return [...out.values()].map((o) => o.fig).sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x);
}
const round1 = (v) => Math.round(v * 10) / 10;

// ====================================================================== 4. files, cache, poppler
const ID_RE = /^[0-9a-f]{6,40}$/i;
const checkId = (id) => { if (!ID_RE.test(String(id))) throw core.httpErr(400, 'Bad item id'); return String(id); };
const pdfFile = (id) => path.join(core.DIRS.pdfs, checkId(id) + '.pdf');
const dirOf = (id) => path.join(DIR, checkId(id));
const mem = new Map();      // id -> {key, figures}
const inflight = new Map(); // id -> Promise of a running analysis
const unavailable = (msg) => core.httpErr(501, msg, { unavailable: true });

let tools = null; // null: not checked yet
async function available() {
  if (tools == null) {
    const [a, b] = await Promise.all([core.run('pdftotext', ['-v'], { timeout: 8000 }), core.run('pdftoppm', ['-v'], { timeout: 8000 })]);
    tools = a.code !== -1 && b.code !== -1;
    if (!tools) setTimeout(() => { tools = null; }, 60000).unref(); // installed meanwhile? look again in a minute
  }
  return tools;
}
// the cache folder of a paper, emptied when it belongs to another PDF file
function cacheDir(id, key) {
  const dir = dirOf(id), idx = core.readJSON(path.join(dir, 'index.json'), null);
  if (idx && (idx.v !== VERSION || idx.key !== key)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const RASTER_MAX_PAGES = 120, RASTER_MAX_PX = 600000; // (a summed-area table costs 4 bytes a pixel: about 1.4 MB a page)
async function rasterPages(file, pageNos, dir, pages) {
  const out = {};
  const tmp = fs.mkdtempSync(path.join(dir, 'ras-'));
  try {
    const todo = pageNos.slice(0, RASTER_MAX_PAGES); // a book: the pages after these are judged from the layout alone
    const worker = async () => {
      for (;;) {
        const n = todo.shift();
        if (n == null) return;
        const pg = pages[n - 1], px = (pg.w / 72) * (pg.h / 72); // a poster-size page is rendered coarser, never bigger
        const dpi = Math.max(12, Math.min(RASTER_DPI, Math.floor(Math.sqrt(RASTER_MAX_PX / px))));
        const r = await core.run('pdftoppm', ['-gray', '-r', String(dpi), '-f', String(n), '-l', String(n), '-singlefile', file, path.join(tmp, 'p' + n)], { timeout: 60000 });
        if (r.code !== 0) continue; // this page is judged from the layout alone
        try { out[n] = readPGM(fs.readFileSync(path.join(tmp, 'p' + n + '.pgm'))); } catch { /* unreadable */ }
        fs.rmSync(path.join(tmp, 'p' + n + '.pgm'), { force: true });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return out;
}
async function build(id, key) {
  const file = pdfFile(id);
  const r = await core.run('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', file, '-'], { timeout: 120000 });
  if (r.code === -1) { tools = null; throw unavailable('poppler (pdftotext) is not installed'); }
  if (r.code !== 0) throw core.httpErr(400, core.toolFailure('pdftotext', r, { tail: true, hint: 'Reinstall or update poppler (docs/troubleshooting.md).' }));
  const pages = parseLayout(r.out);
  const dir = cacheDir(id, key);
  const withCaps = [];
  pages.forEach((p, i) => { if (p.blocks.some((b) => b.lines.some((l) => captionOf(l.text)))) withCaps.push(i + 1); });
  const rasters = withCaps.length ? await rasterPages(file, withCaps, dir, pages) : {};
  const figures = analyze(pages, rasters);
  if (textcache.keyOf(id) === key) { // the file was not replaced while it was read
    try { core.writeJSON(path.join(dir, 'index.json'), { v: VERSION, key, figures }); } catch (e) { console.error('figure cache:', e.message); }
    mem.set(id, { key, figures });
    while (mem.size > 40) mem.delete(mem.keys().next().value);
  }
  return figures;
}
// The figures and tables of the PDF of item `id` (memory, then cache/figures/<id>/index.json, then the analysis).
// Rejects 404 without a PDF, 501 {unavailable: true} without poppler.
// opts in:  cachedOnly - never wait for an analysis: null when the paper was not analysed yet (the analysis is
//                        started in the background, so the next call has it); force - analyse again.
// opts out: hit ('memory' | 'disk' | 'analysed'), failed (why a PDF could not be read: such a result is cached
//           like any other, as an empty list, so a damaged PDF is not analysed again on every call).
async function list(id, opts = {}) {
  checkId(id);
  const key = textcache.keyOf(id);
  if (!key) throw core.httpErr(404, 'This paper has no PDF');
  const give = (c, hit) => { opts.hit = hit; if (c.failed) opts.failed = c.failed; return c.figures; };
  if (!opts.force) {
    const m = mem.get(id);
    if (m && m.key === key) return give(m, 'memory');
    const disk = core.readJSON(path.join(dirOf(id), 'index.json'), null);
    if (disk && disk.v === VERSION && disk.key === key && Array.isArray(disk.figures)) {
      const c = { key, figures: disk.figures, ...(disk.failed ? { failed: String(disk.failed) } : {}) };
      mem.set(id, c);
      return give(c, 'disk');
    }
  }
  if (!(await available())) throw unavailable('Figures cannot be found on this computer: poppler (pdftotext, pdftoppm) is not installed.');
  const tag = id + ':' + key;
  if (!inflight.has(tag)) {
    inflight.set(tag, build(id, key).then((figures) => ({ key, figures }), (e) => {
      if (e && e.extra && e.extra.unavailable) throw e;
      const c = { key, figures: [], failed: String((e && e.message) || e).slice(0, 300) };
      if (textcache.keyOf(id) === key) {
        try { core.writeJSON(path.join(cacheDir(id, key), 'index.json'), { v: VERSION, key, figures: [], failed: c.failed }); } catch { /* not cached, then */ }
        mem.set(id, c);
      }
      return c;
    }).finally(() => inflight.delete(tag)));
  }
  const job = inflight.get(tag);
  if (opts.cachedOnly) { job.catch(() => {}); return null; }
  return give(await job, 'analysed');
}
// PNG of one figure -> {file, buf, width, height (pixels)}. dpi: 40..220 (the default keeps the long side under 1800 px).
async function image(id, key, { dpi } = {}) {
  if (!KEY_RE.test(String(key))) throw core.httpErr(400, 'Bad figure key');
  const figs = await list(id);
  const f = figs.find((x) => x.key === key);
  if (!f) throw core.httpErr(404, 'No such figure in this paper');
  let d = Math.round(Math.min(220, Math.max(40, Number(dpi) || CROP_DPI)));
  const long = Math.max(f.box.w, f.box.h);
  if (long * d / 72 > CROP_MAX_PX) d = Math.max(40, Math.floor(CROP_MAX_PX * 72 / long));
  const k = textcache.keyOf(id);
  const dir = cacheDir(id, k), file = path.join(dir, `${key}-${d}.png`);
  const s = d / 72, width = Math.max(1, Math.round(f.box.w * s)), height = Math.max(1, Math.round(f.box.h * s));
  if (!fs.existsSync(file)) {
    if (!(await available())) throw unavailable('poppler (pdftoppm) is not installed');
    const tmp = path.join(dir, `${key}-${d}.${process.pid}.${Date.now().toString(36)}`);
    const r = await core.run('pdftoppm', ['-png', '-r', String(d), '-f', String(f.page), '-l', String(f.page), '-x', String(Math.round(f.box.x * s)), '-y', String(Math.round(f.box.y * s)),
      '-W', String(width), '-H', String(height), '-singlefile', pdfFile(id), tmp], { timeout: 90000 });
    if (r.code !== 0 || !fs.existsSync(tmp + '.png')) { fs.rmSync(tmp + '.png', { force: true }); throw core.httpErr(r.code === -1 ? 501 : 500, core.toolFailure('pdftoppm', r, { tail: true, hint: 'Reinstall or update poppler (docs/troubleshooting.md).' }), r.code === -1 ? { unavailable: true } : undefined); }
    core.plat.renameSync(tmp + '.png', file);
  }
  return { file, buf: fs.readFileSync(file), width, height, figure: f };
}
// Forget a paper (its PDF was replaced or the item was deleted).
function drop(id) {
  mem.delete(id);
  try { fs.rmSync(dirOf(id), { recursive: true, force: true }); } catch { /* nothing to remove */ }
}

// ====================================================================== 5. notes: placeholders -> pictures
// "> 📷 待截图：Figure 3（一句话说明，第 5 页）" / "> 📷 待截图：Table 2 (description, p. 5)"
const PLACE_RE = /^[ \t]{0,3}>[ \t]*📷[ \t]*(?:待截图|Screenshot|Snapshot)?[ \t]*[:：]?[ \t]*(.*)$/u;
const PLACE_ALL_RE = /^[ \t]{0,3}>[ \t]*📷/gmu; // every placeholder line of a note (the same test the reader's toolbar uses)
const countPlaceholders = (markdown) => (String(markdown || '').match(PLACE_ALL_RE) || []).length;
// "Figure 3", "Fig. 3", "Table II", "图 3", "Figure 6a" ((a part of) Figure 6) - as a word of its own: not the
// "fig 3" in "config 3", the "table 2" in "stable 2", the 表 in 代表. Roman numbers only in capitals ("table i"
// and "Table listing" are no labels).
const LABEL_RE = /(?:(?<![A-Za-z])(Figure|Fig\.?|FIGURE|FIG\.?|figure|fig\.|Table|Tab\.|TABLE|table)|(?<![截地])(图)|(?<![代图报])(表))\s*([A-Za-z]?\d{1,3}|[IVXL]{1,6})(?:\s?\(?[a-h]\)?)?(?![\w])/;
// -> {kind, key} of a LABEL_RE match; key null when the number cannot be read
const labelKey = (l) => {
  const word = l[1] || l[2] || l[3], num = l[4];
  const kind = /^(t|表)/i.test(word) ? 'table' : 'figure';
  let number = 0, tag = '';
  if (/^[IVXL]+$/.test(num)) number = roman(num);
  else { const d = /^([A-Za-z]?)(\d+)$/.exec(num); if (d) { tag = d[1].toLowerCase(); number = Number(d[2]); } }
  return { kind, key: number ? `${kind === 'table' ? 'tab' : 'fig'}-${tag}${number}` : null };
};
// -> {kind, key, label, desc, page} of a placeholder line, or null when the line is not one. `key` is null when
// the line does not say which ONE figure it wants: the label must open the placeholder ("Algorithm 1, beside
// Table 3" asks for an algorithm, not for Table 3) and must not be a range ("Figure 3-5", "Table 1 and 2").
// A placeholder that names two figures in full ("Figure 7 与 Figure 8", "Figure 7 and Figure 8") has `keys`, all of them.
function parsePlaceholder(line) {
  const m = PLACE_RE.exec(line);
  if (!m) return null;
  const whole = m[1].trim();
  let rest = whole.replace(/^[*_`[【「『\s]+/, ''); // "**Figure 3**（...）"
  const l = LABEL_RE.exec(rest);
  if (!l || l.index !== 0) return { key: null, label: '', desc: whole, page: null };
  const first = labelKey(l), keys = [first.key];
  let label = l[0].replace(/\s+/g, ' ');
  const closers = (t) => t.replace(/^[*_`\]】」』]+/, '').trim();
  rest = closers(rest.slice(l[0].length));
  // further labels joined to the first one, before the description starts
  for (;;) {
    const j = /^(?:与|和|及|、|,|，|\/|&|and\b)\s*/i.exec(rest), n = j && LABEL_RE.exec(rest.slice(j[0].length));
    if (!n || n.index !== 0) break;
    keys.push(labelKey(n).key); label += '、' + n[0].replace(/\s+/g, ' ');
    rest = closers(rest.slice(j[0].length + n[0].length));
  }
  const range = /^(?:[-–—~～]|to\b|至|到)\s*[A-Za-z]?\d/i.test(rest) || /^(?:与|和|及|、|,|，|\/|&|and\b)\s*[A-Za-z]?\d/i.test(rest);
  let desc = rest.replace(/^[:：.\-—–\s]+/, '');
  const br = /^[（(]([\s\S]*)[）)]\s*[。.]?$/.exec(desc);
  if (br) desc = br[1].trim();
  let page = null;
  desc = desc.replace(/[,，;；、]?\s*(?:第\s*(\d{1,4})\s*页|(?:p\.|page|pp\.)\s*(\d{1,4}))\s*$/i, (all, a, b) => { page = Number(a || b); return ''; }).trim();
  desc = desc.replace(/[,，;；、\s]+$/, '');
  const out = { kind: first.kind, key: !range && keys.every(Boolean) ? first.key : null, label, desc, page };
  if (range) out.range = true;
  if (keys.length > 1 && out.key) out.keys = [...new Set(keys)];
  return out;
}
// exactly what public/js/reader.js pageLink() writes
const pageLink = (n) => `[p. ${Number(n)}](#rt-page=${Number(n)})`;
// the display width (#w=) of a figure in a note: the note column is about 700 px wide
function displayWidth(f) {
  let w = f.wide ? 680 : Math.round(Math.min(560, Math.max(300, f.box.w * 1.75)) / 20) * 20;
  if (f.box.h * (w / f.box.w) > 560) w = Math.max(240, Math.round(560 * f.box.w / f.box.h / 20) * 20); // a tall one: not higher than the pane
  return w;
}
// The Markdown of one figure in a note: the picture and, in the same paragraph, the line that says what it is and
// links to its page (the form the snapshot tool of the PDF viewer writes).
function figureMarkdown(f, url, { desc = '', language = 'zh', before = [] } = {}) {
  const d = String(desc || '').replace(/\s+/g, ' ').trim();
  const sep = language === 'en' ? ': ' : '：';
  const all = [...before, { figure: f, url }]; // several pictures under one description ("Figure 7 and Figure 8")
  const pages = [...new Set(all.map((g) => g.figure.page))];
  return all.map((g) => `![${g.figure.label}](${g.url}#w=${displayWidth(g.figure)})`).join('\n')
    + `\n${all.map((g) => g.figure.label).join(language === 'en' ? ', ' : '、')}${d ? sep + d : ''} ${pages.map(pageLink).join(' ')}`;
}
// Pure: replace the placeholders of `markdown` for which `resolve(key)` (async) gives {figure, url}.
// Only a placeholder that stands alone (not inside a longer quote or a code block) is touched; everything else in
// the note is returned byte for byte. `only` (optional Set of keys) limits which ones are placed.
async function placeIn(markdown, resolve, { language = 'zh', only = null } = {}) {
  const lines = String(markdown || '').split('\n');
  const placed = [], missed = [];
  // what is not the text of the note: a fenced code block (closed only by a fence of the same character, at least
  // as long, with nothing after it), an HTML comment, a $$ formula
  let fence = null, comment = false, math = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && !fm[2].trim()) fence = null; continue; }
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (math) { if (line.includes('$$')) math = false; continue; }
    if (fm) { fence = { ch: fm[1][0], len: fm[1].length }; continue; }
    const co = line.lastIndexOf('<!--');
    if (co >= 0 && line.indexOf('-->', co) < 0) { comment = true; continue; }
    if ((line.match(/\$\$/g) || []).length % 2 === 1) { math = true; continue; }
    let p = null;
    try { p = parsePlaceholder(line.replace(/\r$/, '')); } // (one odd line never stops the others)
    catch (e) { missed.push({ label: '', key: null, reason: 'could not be read: ' + (e.message || e) }); continue; }
    if (!p) continue;
    const quoted = (s) => s != null && /^[ \t]{0,3}>/.test(s);
    if (quoted(lines[i - 1]) || quoted(lines[i + 1])) { missed.push({ label: p.label, key: p.key, reason: 'part of a longer quote' }); continue; }
    if (!p.key) { missed.push({ label: p.label || p.desc.slice(0, 40), key: null, reason: p.range ? 'names several figures - take them one by one' : 'does not start with a figure or table number' }); continue; }
    const keys = p.keys || [p.key];
    if (only && !keys.some((k) => only.has(k))) { missed.push({ label: p.label, key: p.key, reason: 'not selected' }); continue; }
    const got = [];
    let reason = '';
    for (const k of keys) {
      let g = null;
      try { g = await resolve(k); if (!g) reason = 'not found in the PDF'; } catch (e) { reason = e.message || String(e); }
      if (!g) break;
      got.push(g);
    }
    if (got.length < keys.length) { missed.push({ label: p.label, key: p.key, reason }); continue; } // all of them or the line stays
    const cr = line.endsWith('\r') ? '\r' : '';
    let md;
    try {
      md = got.length === 1 ? figureMarkdown(got[0].figure, got[0].url, { desc: p.desc, language })
        : figureMarkdown(got[got.length - 1].figure, got[got.length - 1].url, { desc: p.desc, language, before: got.slice(0, -1) });
    } catch (e) { missed.push({ label: p.label, key: p.key, reason: e.message || String(e) }); continue; }
    lines[i] = md.split('\n').join(cr + '\n') + cr;
    for (const g of got) placed.push({ key: g.figure.key, label: g.figure.label, page: g.figure.page, url: g.url, confidence: g.figure.confidence });
  }
  return { markdown: lines.join('\n'), placed, missed };
}
// Store the crop of a figure as an asset of the note of item `id` (content-addressed: the same crop is one file,
// however often it is placed). -> {figure, url, name}
const assetJobs = new Map();
function asset(id, key) {
  const tag = id + ':' + key + ':' + textcache.keyOf(id);
  if (!assetJobs.has(tag)) {
    assetJobs.set(tag, (async () => {
      const img = await image(id, key);
      const saved = require('./notes').saveAsset(id, img.buf); // (required late: notes.js requires this module)
      return { figure: img.figure, url: saved.url, name: saved.name };
    })().finally(() => assetJobs.delete(tag)));
  }
  return assetJobs.get(tag);
}
// Fill the placeholders of a note of item `id`. Never throws for a missing PDF / poppler: the note comes back as it
// is, with the reason in `unavailable`.
async function place(id, markdown, { language = 'zh', keys = null } = {}) {
  const md = String(markdown || '');
  if (!/📷/u.test(md)) return { markdown: md, placed: [], missed: [] };
  let figs;
  try { figs = await list(id); }
  catch (e) {
    const r = await placeIn(md, async () => null, { language });
    return { markdown: md, placed: [], missed: r.missed.map((m) => ({ ...m, reason: e.message })), unavailable: e.message };
  }
  const by = new Map(figs.map((f) => [f.key, f]));
  const only = Array.isArray(keys) && keys.length ? new Set(keys.map(String).filter((k) => KEY_RE.test(k))) : null;
  return placeIn(md, async (key) => {
    const f = by.get(key);
    if (!f) return null;
    // a wrong picture in a note is worse than a placeholder left in place
    if (f.confidence < MIN_PLACE && !(only && only.has(key))) throw new Error(`found, but the crop is uncertain${f.why && f.why.length ? ' (' + f.why[0] + ')' : ''} - insert it from the Figures list if it looks right`);
    return asset(id, key);
  }, { language, only });
}

// ====================================================================== 6. prompts
// The list a prompt can carry: one line per figure / table with its page and the beginning of its caption.
// Cheap text (about 35 tokens a line, at most 20 lines) that tells Claude which figures exist without looking at a page.
async function promptList(id, { max = 20, clip = 110, minConfidence = MIN_PLACE, maxPage = 0 } = {}) {
  let figs;
  try { figs = await list(id); } catch { return { text: '', count: 0 }; }
  // `maxPage`: the last page Claude is told to read (the figures of an appendix it does not read only cost tokens)
  const use = figs.filter((f) => f.confidence >= minConfidence && (!maxPage || f.page <= maxPage)).slice(0, max);
  const text = use.map((f) => {
    let c = f.caption.replace(CAP_HEAD, '').trim();
    if (c.length > clip) c = c.slice(0, clip).replace(/\s+\S*$/, '') + '…';
    return `${f.label} (p. ${f.page}): ${c}`;
  }).join('\n');
  return { text, count: use.length, more: figs.length - use.length };
}
// The figure a passage speaks about ("Figure 3", "图 3", "Table II" - written as a label, with a capital):
// {caption (one line for a prompt), page, key} or null. Never waits for an analysis and never throws: a paper whose
// figures were not looked for yet gives null now (the analysis starts in the background for the next question).
async function captionFor(id, text) {
  try {
    const m = LABEL_RE.exec(String(text || ''));
    if (!m || (m[1] && !/^[FT]/.test(m[1]))) return null;
    const { key } = labelKey(m);
    if (!key) return null;
    const figs = await list(id, { cachedOnly: true });
    const f = figs && figs.find((x) => x.key === key);
    return f ? { caption: `${f.caption} (p. ${f.page})`, page: f.page, key } : null;
  } catch { return null; }
}

module.exports = {
  DIR, KEY_RE, MIN_PLACE, VERSION, available, list, image, asset, place, drop, promptList, captionFor, countPlaceholders,
  // pure parts (scripts/test-figures.js)
  parseLayout, makeLine, makeBlock, captionOf, findCaptions, captionText, docStats, columnsOf, classifyPage, xRange, sideRegion,
  readPGM, rasterOf, pageRaster, findRules, findFrames, refine, quality, analyze, parsePlaceholder, placeIn, figureMarkdown, displayWidth, pageLink,
};
