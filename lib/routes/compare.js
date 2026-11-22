// Ask across papers / comparison tables (LIBRARY) - see lib/compare.js; UI: public/js/compare.js.
//   GET     /api/compare                       { tables: [{id, kind, title, question, papers, columns, status, todo, running, ...}],
//                                                running: <table id> | null, max, maxCols, defaults: [column names] }
//   POST    /api/compare/estimate {ids, kind, columns | question}   { papers: [{id, source}], calls, tokensIn, tokensOut, mode, max }
//   POST    /api/compare {ids, kind 'compare' | 'ask', columns | question, language?, title?}   -> NDJSON stream
//                                                (table, row ..., status, done | error); the job goes on without the page
//   GET     /api/compare/:id                   { table, running }
//   PUT     /api/compare/:id {title?, columns?, cell?: {itemId, col, text}, removeRow?}   { table }
//   POST    /api/compare/:id/fill {rows?: [itemId], all?}   fill the missing cells / ask again -> NDJSON stream
//   POST    /api/compare/:id/stop              { stopped }
//   DELETE  /api/compare/:id                   to the trash   { ok }
//   GET     /api/compare/:id/export?format=md|csv|tex[&download=1]   { text, name } - or the file itself
const core = require('../core');
const compare = require('../compare');

async function handle(ctx) {
  const { res, segments: seg, method: M, send } = ctx;
  if (seg[1] !== 'compare') return false;
  if (seg.length === 2) {
    if (M === 'GET') return send(200, { tables: compare.list(), running: compare.running(), max: compare.MAX_PAPERS, maxCols: compare.MAX_COLS, defaults: compare.DEFAULT_COLUMNS });
    if (M === 'POST') { await compare.create(await ctx.json(), res); return true; }
    return false;
  }
  if (seg.length === 3 && seg[2] === 'estimate' && M === 'POST') return send(200, await compare.estimate(await ctx.json()));
  const id = seg[2];
  if (seg.length === 3) {
    if (M === 'GET') return send(200, { table: compare.read(id), running: compare.isRunning(id) });
    if (M === 'PUT') return send(200, { table: compare.update(id, await ctx.json()) });
    if (M === 'DELETE') return send(200, compare.remove(id));
    return false;
  }
  if (seg.length === 4 && seg[3] === 'fill' && M === 'POST') { await compare.refill(id, await ctx.json(), res); return true; }
  if (seg.length === 4 && seg[3] === 'stop' && M === 'POST') return send(200, compare.stop(id));
  if (seg.length === 4 && seg[3] === 'export' && M === 'GET') {
    const out = compare.exportAs(id, String(ctx.query.get('format') || 'md'));
    if (ctx.query.get('download') !== '1') return send(200, { text: out.text, name: out.name });
    res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'no-store', ...core.attachment(out.name) });
    res.end(out.text);
    return true;
  }
  return false;
}

module.exports = { handle };
