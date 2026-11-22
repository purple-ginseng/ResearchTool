// Colour highlights on the PDF of a library item (READER, the PDF pane) - UI: public/js/highlights.js.
// The PDF file is never changed: the marks live in <workspace>/highlights/<id>.json and are drawn over the pages.
//   GET     /api/items/:id/highlights                 { highlights, removed }   (removed = how many can be restored)
//   POST    /api/items/:id/highlights {page, text, rects, color?, comment?, kind?, kp?}   -> { highlight, highlights, removed }
//   PUT     /api/items/:id/highlights/:hid {color?, comment?}                             -> { highlight, highlights, removed }
//   DELETE  /api/items/:id/highlights/:hid            { highlights, removed }   (kept in the file's "removed" list)
//   POST    /api/items/:id/highlights/restore         { highlight, highlights, removed }  puts the last removed one back
// highlight = {id, page, text, color, comment, kind ('mark' | 'quote' | 'kp'), kp? (id of the key point made from the
// same selection), rects: [[page, x, y, w, h], ...], created, updated?}. A rect is given as parts (0..1) of the width
// and height of its page, so it stays right at every zoom; `page` is the page the passage starts on.
const fs = require('fs');
const path = require('path');
const core = require('../core');
const { WS, readJSON, writeJSON, httpErr } = core;

const DIR = path.join(WS, 'highlights');
const COLORS = ['yellow', 'green', 'blue', 'pink'];
const KINDS = ['mark', 'quote', 'kp'];
const MAX = 3000, MAX_RECTS = 600, MAX_REMOVED = 100;

const file = (id) => path.join(DIR, id + '.json');
// an entry that can be drawn: the file may have been edited by hand (or by Claude Code in the terminal)
const whole = (h) => h && typeof h === 'object' && typeof h.id === 'string' && Number.isInteger(h.page) && typeof h.text === 'string'
  && Array.isArray(h.rects) && h.rects.length > 0 && h.rects.every((r) => Array.isArray(r) && r.length === 5 && r.every((v) => typeof v === 'number' && Number.isFinite(v)));
function read(id) {
  const f = file(id);
  let d = readJSON(f, null);
  if ((!d || typeof d !== 'object') && fs.existsSync(f)) {
    // a file that cannot be read is never overwritten by the next change: it is put aside in the trash first
    try { core.moveToTrash(f, 'library', id, core.stamp() + '-highlights-damaged.json'); } catch (e) { throw httpErr(500, 'The highlights file of this paper is damaged and could not be put aside: ' + e.message); }
    console.error('highlights: damaged file of', id, 'moved to the trash');
  }
  d = d && typeof d === 'object' ? d : {};
  const list = (v) => (Array.isArray(v) ? v.filter(whole) : []);
  return { highlights: list(d.highlights), removed: list(d.removed) };
}
function write(id, data) { fs.mkdirSync(DIR, { recursive: true }); writeJSON(file(id), data); }
const pub = (data) => ({ highlights: data.highlights, removed: data.removed.length });
// reading order: page, then from the top of the page, then from the left
function sort(list) {
  const key = (h) => { const r = h.rects[0] || [h.page, 0, 0]; return [h.page, r[2], r[1]]; };
  return list.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
}
// The file of an item that is deleted, or whose PDF is replaced (the marks would sit on the wrong text), goes to the trash.
function trash(id, ...parts) {
  const f = file(id);
  return fs.existsSync(f) ? core.moveToTrash(f, ...parts) : null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const part = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5;
function cleanRects(raw, page) {
  if (!Array.isArray(raw) || !raw.length) throw httpErr(400, 'A highlight needs the place of its text on the page');
  const out = [];
  for (const r of raw.slice(0, MAX_RECTS)) {
    if (!Array.isArray(r) || r.length !== 5) throw httpErr(400, 'The place of a highlight is not valid');
    const [p, x, y, w, h] = r.map(num);
    if (!Number.isInteger(p) || p < 1 || p > 20000 || [x, y, w, h].some(Number.isNaN)) throw httpErr(400, 'The place of a highlight is not valid');
    const x0 = part(x), y0 = part(y), x1 = part(x + w), y1 = part(y + h);
    if (x1 - x0 < 0.0005 || y1 - y0 < 0.0005) continue;
    out.push([p, x0, y0, Math.round((x1 - x0) * 1e5) / 1e5, Math.round((y1 - y0) * 1e5) / 1e5]);
  }
  if (!out.length) throw httpErr(400, 'A highlight needs the place of its text on the page');
  if (!out.some((r) => r[0] === page)) throw httpErr(400, 'The place of a highlight is not on its page');
  return out;
}
// control characters (a PDF with a broken font gives them) are dropped; line breaks and tabs stay
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

async function handle(ctx) {
  const { segments: seg, method: M, send } = ctx;
  if (seg[1] !== 'items' || !seg[2] || seg[3] !== 'highlights') return false;
  const item = core.loadLib().items.find((i) => i.id === seg[2]);
  if (!item) return send(404, { error: 'No such item' });
  const id = item.id;

  if (seg.length === 4 && M === 'GET') return send(200, pub(read(id)));
  if (seg.length === 4 && M === 'POST') {
    const b = await ctx.json();
    const page = Number(b.page);
    if (!Number.isInteger(page) || page < 1 || page > 20000) throw httpErr(400, 'A highlight needs a page number');
    const data = read(id);
    if (data.highlights.length >= MAX) throw httpErr(400, `This paper already has ${MAX} highlights - remove some first`);
    const h = {
      id: core.newId(), page, text: text(b.text, 6000).replace(/\s+/g, ' '),
      color: COLORS.includes(b.color) ? b.color : COLORS[0], comment: text(b.comment, 4000),
      kind: KINDS.includes(b.kind) ? b.kind : 'mark', rects: cleanRects(b.rects, page), created: new Date().toISOString(),
    };
    if (!h.text) throw httpErr(400, 'A highlight needs the text it marks');
    if (h.kind === 'kp' && typeof b.kp === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(b.kp)) h.kp = b.kp;
    data.highlights.push(h); sort(data.highlights);
    write(id, data);
    return send(200, { highlight: h, ...pub(data) });
  }
  if (seg.length === 5 && seg[4] === 'restore' && M === 'POST') {
    const data = read(id), h = data.removed.pop();
    if (!h) throw httpErr(404, 'There is no removed highlight to restore');
    delete h.removedAt;
    data.highlights.push(h); sort(data.highlights);
    write(id, data);
    return send(200, { highlight: h, ...pub(data) });
  }
  if (seg.length === 5 && (M === 'PUT' || M === 'DELETE')) {
    // the body is read before the file: nothing may wait between reading the file and writing it back, or a
    // second request handled in between would be undone
    const b = M === 'PUT' ? await ctx.json() : null;
    const data = read(id), h = data.highlights.find((x) => x.id === seg[4]);
    if (!h) throw httpErr(404, 'No such highlight');
    if (M === 'DELETE') {
      data.highlights = data.highlights.filter((x) => x !== h);
      data.removed.push({ ...h, removedAt: new Date().toISOString() }); // nothing is deleted for good: it can be restored
      if (data.removed.length > MAX_REMOVED) data.removed = data.removed.slice(-MAX_REMOVED);
      write(id, data);
      return send(200, pub(data));
    }
    if (b.color !== undefined) { if (!COLORS.includes(b.color)) throw httpErr(400, 'Unknown highlight colour'); h.color = b.color; }
    if (b.comment !== undefined) h.comment = text(b.comment, 4000);
    h.updated = new Date().toISOString();
    write(id, data);
    return send(200, { highlight: h, ...pub(data) });
  }
  return false;
}

// how many highlights a paper has (read only: a damaged file counts as none and is left where it is)
function count(id) {
  const d = readJSON(file(id), null);
  return d && typeof d === 'object' && Array.isArray(d.highlights) ? d.highlights.filter(whole).length : 0;
}

module.exports = { handle, trash, file, count };
