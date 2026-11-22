// Full-text search of the library (the "search inside papers and notes" switch of the Library search box) - see
// lib/fulltext.js.
//   GET /api/search?q=<words>[&id=<item id>]
//     -> { tokens, papers: { <id>: { n, hits: [{kind: 'note'|'kp'|'pdf', text, page?, line?, kp?, pass?}], more } }, total, indexed, ms }
//   Every paper comes with its first passages (`more` = how many were left out); with `id`, the passages of that one paper.
const core = require('../core');
const fulltext = require('../fulltext');

// build the index shortly after the server started, so the first search does not wait for it
const t = setTimeout(() => { fulltext.warm().catch((e) => console.error('search index:', e.message)); }, 1500);
t.unref();

async function handle(ctx) {
  if (ctx.path !== '/api/search' || ctx.method !== 'GET') return false;
  const q = String(ctx.query.get('q') || '');
  if (q.length > 200) throw core.httpErr(400, 'The search text is too long');
  const id = ctx.query.get('id');
  if (id && !core.loadLib().items.some((i) => i.id === id)) throw core.httpErr(404, 'No such item');
  return ctx.send(200, await fulltext.search(q, { id: id || null }));
}
module.exports = { handle };
