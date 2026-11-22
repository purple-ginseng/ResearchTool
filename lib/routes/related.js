// Related papers and the metadata check (lib/related.js):
//   GET  /api/items/:id/related[?mode=cached|refresh]  references and citing papers of an item, each marked with the
//                                                      library item it matches ("cached" never asks a service)
//   GET  /api/items/:id/metadata-check                 what the published record would change in the entry
//   POST /api/items/:id/metadata-check {values}        apply the chosen changes (the cite key stays)
// Runs after library.js, which has already answered 404 for an unknown item id.
const core = require('../core');
const rel = require('../related');

async function handle(ctx) {
  const { segments: seg, method: M } = ctx;
  if (seg[1] !== 'items' || !seg[2] || seg.length !== 4 || (seg[3] !== 'related' && seg[3] !== 'metadata-check')) return false;
  const item = core.loadLib().items.find((i) => i.id === seg[2]);
  if (!item) return ctx.send(404, { error: 'No such item' });
  if (seg[3] === 'related' && M === 'GET') {
    const mode = ctx.query.get('mode');
    return ctx.send(200, await rel.related(item, mode === 'cached' || mode === 'refresh' ? mode : 'auto'));
  }
  if (seg[3] === 'metadata-check' && M === 'GET') return ctx.send(200, await rel.checkMetadata(item));
  if (seg[3] === 'metadata-check' && M === 'POST') {
    const b = await ctx.json();
    return ctx.send(200, { item: rel.applyMetadata(item.id, b.values) });
  }
  return false;
}

module.exports = { handle };
