// Figures and tables of a paper, found locally from its PDF (lib/figures.js - no AI call).
// (This module runs before library.js, so it looks the item up itself.)
//   GET  /api/items/:id/figures[?refresh=1]     { available, figures: [{key, kind, number, label, page, caption, box, pageW, pageH, confidence,
//                                               placeable (sure enough to be put into a note unasked), why? (what is doubtful), w (display width in a note)}] }
//                                               refresh=1 analyses the PDF again instead of answering from the cache
//                                               available: false + reason 'no-pdf' | 'no-poppler' | 'failed' (+ message) when there is nothing to show
//   GET  /api/items/:id/figures/<key>.png       the crop (PNG); ?thumb=1 a small one for lists
//   POST /api/items/:id/figures/<key>/asset     {language?, desc?} -> { url, markdown, figure }: the crop stored as an asset of
//                                               the note, with the Markdown to insert at the cursor
//   POST /api/items/:id/note/figures            {keys?: [...], baseHash?, language?} -> fills the "> 📷 ..." placeholders of the
//                                               saved note: { content, hash, mtime, versionId, changed, placed: [...], missed: [...] }.
//                                               409 {conflict, content, hash} when the note on disk is not the one the page has
//                                               (baseHash), or changed while the pictures were cut out.
const core = require('../core');
const figures = require('../figures');
const notes = require('../notes');
const { httpErr } = core;

const pub = (f) => ({ key: f.key, kind: f.kind, number: f.number, label: f.label, page: f.page, caption: f.caption, box: f.box, pageW: f.pageW, pageH: f.pageH, confidence: f.confidence,
  placeable: f.confidence >= figures.MIN_PLACE, ...(f.why && f.why.length ? { why: f.why.slice(0, 4) } : {}), w: figures.displayWidth(f) });
const lang = (v) => (v === 'en' ? 'en' : 'zh');

async function handle(ctx) {
  const { segments: seg, method: M, query: q, send } = ctx;
  if (seg[1] !== 'items' || !seg[2]) return false;
  const isList = seg[3] === 'figures', isPlace = seg[3] === 'note' && seg[4] === 'figures' && seg.length === 5;
  if (!isList && !isPlace) return false;
  const item = core.loadLib().items.find((i) => i.id === seg[2]);
  if (!item) return send(404, { error: 'No such item' });
  const id = item.id;

  if (isPlace) {
    if (M !== 'POST') return false;
    const b = await ctx.json();
    if (notes.draftRunning(id)) throw httpErr(409, 'Claude is writing a draft for this reference - wait until it is finished.', { running: true });
    const cur = notes.readNote(id);
    if (typeof b.baseHash === 'string' && cur.hash && b.baseHash !== cur.hash) throw httpErr(409, 'The note was changed on disk since you opened it', { conflict: true, content: cur.content, hash: cur.hash });
    const keys = Array.isArray(b.keys) ? b.keys.map(String).filter((k) => figures.KEY_RE.test(k)).slice(0, 200) : null;
    const r = await figures.place(id, cur.content, { language: lang(b.language), keys });
    const extra = { placed: r.placed, missed: r.missed, ...(r.unavailable ? { unavailable: r.unavailable } : {}) };
    if (!r.placed.length || r.markdown === cur.content) return send(200, { content: cur.content, hash: cur.hash, mtime: cur.mtime, changed: false, ...extra });
    // baseHash = the note the pictures were placed into: an edit that arrived meanwhile is never overwritten
    const saved = notes.writeNote(id, r.markdown, { baseHash: cur.hash, source: 'manual', label: `Figures placed (${r.placed.length})` });
    return send(200, { content: r.markdown, ...saved, changed: true, ...extra });
  }

  if (seg.length === 4 && M === 'GET') {
    if (!item.pdf) return send(200, { available: false, reason: 'no-pdf', message: 'This reference has no PDF.', figures: [] });
    try {
      const info = { force: q.get('refresh') === '1' };
      const figs = await figures.list(id, info);
      if (info.failed) return send(200, { available: false, reason: 'failed', message: info.failed, figures: [] });
      return send(200, { available: true, figures: figs.map(pub) });
    }
    catch (e) {
      if (e.extra && e.extra.unavailable) return send(200, { available: false, reason: 'no-poppler', message: e.message, figures: [] });
      if (e.status === 404) return send(200, { available: false, reason: 'no-pdf', message: e.message, figures: [] });
      return send(200, { available: false, reason: 'failed', message: e.message || String(e), figures: [] });
    }
  }
  if (seg.length === 5 && (M === 'GET' || M === 'HEAD')) {
    const m = /^((?:fig|tab)-[a-z]?\d{1,3})\.png$/.exec(seg[4]);
    if (!m) throw httpErr(400, 'Bad figure key');
    const img = await figures.image(id, m[1], q.get('thumb') ? { dpi: 56 } : {});
    return ctx.sendFile(img.file, 'image/png', { 'X-Content-Type-Options': 'nosniff' });
  }
  if (seg.length === 6 && seg[5] === 'asset' && M === 'POST') {
    if (!figures.KEY_RE.test(seg[4])) throw httpErr(400, 'Bad figure key');
    const b = await ctx.json();
    const a = await figures.asset(id, seg[4]);
    const desc = typeof b.desc === 'string' ? b.desc.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    return send(200, { url: a.url, name: a.name, figure: pub(a.figure), markdown: figures.figureMarkdown(a.figure, a.url, { desc, language: lang(b.language) }) });
  }
  return false;
}

module.exports = { handle };
