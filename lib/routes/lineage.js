// Lineage of a set of library papers (lib/lineage.js): prior works, derivative works, the history line.
//   POST /api/lineage {scope 'library'|'category'|'project'|'paper'|'ids', category?, pid?, id?, ids?, label?,
//                      mode 'cached'|'auto'|'refresh'} -> {key, state 'done'|'running'|'none'|'error', result?, progress?, error?}
//   GET  /api/lineage/job?key=<key>      the same answer for a computation under way (poll it)
//   GET  /api/lineage/work/<W123>        one OpenAlex work with its abstract (a free single look-up, cached)
//   GET  /api/lineage/usage              requests asked today: {today {list, single, s2}, days, budget}
//   POST /api/lineage/contexts {ids, work} what the citing set papers say of a work (Semantic Scholar intents and
//                                        citing sentences; lazily, at most 6 requests per call)
//   POST /api/lineage/recent {key}       the newest works citing the top 3 prior works of a stored set (1 list query)
const lin = require('../lineage');

async function handle(ctx) {
  const { path: p, segments: seg, method: M } = ctx;
  if (seg[1] !== 'lineage') return false;
  if (p === '/api/lineage' && M === 'POST') return ctx.send(200, lin.start(await ctx.json()));
  if (p === '/api/lineage/job' && M === 'GET') {
    const key = String(ctx.query.get('key') || '');
    if (!/^[0-9a-f]{24}$/.test(key)) return ctx.send(400, { error: 'key is missing' });
    return ctx.send(200, lin.status(key));
  }
  if (seg[2] === 'work' && seg.length === 4 && M === 'GET') return ctx.send(200, await lin.work(seg[3]));
  if (p === '/api/lineage/usage' && M === 'GET') return ctx.send(200, lin.usage());
  if (p === '/api/lineage/contexts' && M === 'POST') return ctx.send(200, await lin.contexts(await ctx.json()));
  if (p === '/api/lineage/recent' && M === 'POST') return ctx.send(200, await lin.recentAncestors(await ctx.json()));
  return ctx.send(404, { error: 'Unknown endpoint' });
}

module.exports = { handle };
