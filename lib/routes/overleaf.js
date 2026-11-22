// Overleaf sync routes (Git integration; see lib/overleaf.js):
//   GET  /api/overleaf/status
//   POST /api/overleaf/import {url, name?}
//   GET  /api/projects/:id/overleaf[?fetch=1]
//   POST /api/projects/:id/overleaf/pull | push {message?} | resolve {strategy} | unlink
// Runs before lib/routes/projects.js; everything else under /api/projects is left to it (return false).
const core = require('../core');
const ol = require('../overleaf');

async function handle(ctx) {
  const { path: p, segments: seg, method: M } = ctx;

  if (seg[1] === 'overleaf') {
    if (p === '/api/overleaf/status' && M === 'GET') return ctx.send(200, await ol.status());
    if (p === '/api/overleaf/import' && M === 'POST') {
      const body = await ctx.json();
      if (typeof body.url !== 'string') throw core.httpErr(400, 'url must be a string');
      if (body.name != null && typeof body.name !== 'string') throw core.httpErr(400, 'name must be a string');
      return ctx.send(200, await ol.importProject({ url: body.url, name: body.name }));
    }
    throw core.httpErr(404, 'Unknown endpoint');
  }

  if (seg[1] === 'projects' && seg[2] && seg[3] === 'overleaf' && seg.length <= 5) {
    const project = core.P.get(seg[2]); // 404 for an unknown id: ids from the URL only ever match an existing project
    const sub = seg[4];
    if (!sub && M === 'GET') return ctx.send(200, await ol.projectStatus(project, ctx.query.get('fetch') === '1'));
    if (M === 'POST' && sub === 'pull') return ctx.send(200, await ol.pull(project));
    if (M === 'POST' && sub === 'push') { const body = await ctx.json(); return ctx.send(200, await ol.push(project, body.message)); }
    if (M === 'POST' && sub === 'resolve') { const body = await ctx.json(); return ctx.send(200, await ol.resolve(project, body.strategy)); }
    if (M === 'POST' && sub === 'unlink') return ctx.send(200, await ol.unlink(project));
    throw core.httpErr(404, 'Unknown endpoint');
  }
  return false;
}

module.exports = { handle };
