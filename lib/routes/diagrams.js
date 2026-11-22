// Explained diagrams of library items (READER, "Diagram" tab) - see lib/diagrams.js.
//   GET     /api/items/:id/diagrams                       { diagrams, running }
//   POST    /api/items/:id/diagrams {kind?, focus?, language?}        -> NDJSON stream (status ... done | error)
//   DELETE  /api/items/:id/diagrams/:did                  { diagrams }
//   PUT     /api/items/:id/diagrams/:did {title, summary, groups, nodes, edges}   save a hand-edited diagram -> { diagram }
//   POST    /api/items/:id/diagrams/:did/explain {node | edge, mode: 'example'|'simpler', language?}  { entry, more }
const core = require('../core');
const diagrams = require('../diagrams');

async function handle(ctx) {
  const { res, segments: seg, method: M, send } = ctx;
  if (seg[1] !== 'items' || !seg[2] || seg[3] !== 'diagrams') return false;
  const item = core.loadLib().items.find((i) => i.id === seg[2]);
  if (!item) return send(404, { error: 'No such item' });
  const lang = (b) => (b.language === 'en' ? 'en' : 'zh');

  if (seg.length === 4) {
    if (M === 'GET') return send(200, { ...diagrams.read(item.id), running: diagrams.running(item.id) });
    if (M === 'POST') {
      const b = await ctx.json();
      if (diagrams.running(item.id)) return send(409, { error: 'A diagram is already being drawn for this reference', running: true });
      await diagrams.generate(item, {
        kind: diagrams.KINDS.includes(b.kind) ? b.kind : 'auto',
        focus: String(b.focus || '').replace(/\s+/g, ' ').trim().slice(0, 300), language: lang(b), res,
      });
      return true;
    }
    return false;
  }
  if (seg.length === 5 && M === 'DELETE') return send(200, diagrams.remove(item.id, seg[4]));
  if (seg.length === 5 && M === 'PUT') return send(200, diagrams.update(item.id, seg[4], await ctx.json()));
  if (seg.length === 6 && seg[5] === 'explain' && M === 'POST') {
    const b = await ctx.json();
    const ref = b.node != null ? { node: String(b.node) } : { edge: Number(b.edge) };
    return send(200, await diagrams.explain(item, seg[4], ref, b.mode, lang(b)));
  }
  return false;
}

module.exports = { handle };
