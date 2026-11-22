// Verified venues (lib/venues.js; data in <workspace>/venues.json, never in library.json):
//   GET  /api/venues                       {items: {id: record (+ stale: the entry changed since)}, running: {done, total, current} | null,
//                                          last: {done, total, stopped, error?} | null, damaged?: the name a damaged venues.json was kept under}
//   POST /api/venues/check {ids?, force?}  start ONE background check (one paper after the other; papers checked in the last
//                                          30 days with unchanged fields are skipped unless force) -> {started, total}; 409 while one runs
//   POST /api/venues/stop                  stop it before the next service is asked -> {stopped}
// Progress is polled through GET /api/venues, as the briefs report theirs through GET /api/categories.
const core = require('../core');
const venues = require('../venues');

async function handle(ctx) {
  const { path: p, method: M, json, send } = ctx;
  if (p === '/api/venues' && M === 'GET') return send(200, venues.status());
  if (p === '/api/venues/check' && M === 'POST') {
    const b = await json();
    if ('ids' in b && !(Array.isArray(b.ids) && b.ids.length <= 20000 && b.ids.every((x) => typeof x === 'string'))) throw core.httpErr(400, 'ids must be a list of paper ids');
    if ('force' in b && typeof b.force !== 'boolean') throw core.httpErr(400, 'force must be true or false');
    return send(200, venues.start({ ids: b.ids, force: b.force === true }));
  }
  if (p === '/api/venues/stop' && M === 'POST') return send(200, venues.stop());
  return false;
}

module.exports = { handle };
