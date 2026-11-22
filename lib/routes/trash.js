// The trash (lib/trash.js; UI: "Recently deleted" in the Library, public/js/safety.js)
//   GET    /api/trash                     {papers[{bin, id, title, author, year, citekey, deleted, has[], keypoints, size,
//                                          inLibrary}], size, count, old, oldSize, other, otherSize, days}
//   POST   /api/trash/:bin/restore        put a deleted paper back with its files -> {item, kept[]}
//   DELETE /api/trash/:bin                delete that paper for good
//   DELETE /api/trash?days=30             delete for good what has been in the trash longer than 30 days (days=0: everything)
const core = require('../core');
const trash = require('../trash');

async function handle(ctx) {
  const { path: p, segments: seg, method: M, send } = ctx;
  if (seg[1] !== 'trash') return false;
  if (p === '/api/trash' && M === 'GET') return send(200, trash.summary());
  if (p === '/api/trash' && M === 'DELETE') {
    const days = Number(ctx.query.get('days'));
    if (!ctx.query.has('days') || !Number.isInteger(days) || days < 0 || days > 3650) throw core.httpErr(400, 'days must be a whole number (0 = everything)');
    return send(200, { ...trash.empty({ days }), ...trash.summary() });
  }
  if (seg.length === 4 && seg[3] === 'restore' && M === 'POST') {
    const r = trash.restore(seg[2]);
    return send(200, { item: r.item, kept: r.kept });
  }
  if (seg.length === 3 && M === 'DELETE') return send(200, { ...trash.empty({ bin: seg[2] }), ...trash.summary() });
  return false;
}

module.exports = { handle };
