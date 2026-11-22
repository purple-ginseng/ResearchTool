// Claude in the LaTeX editor (lib/writing.js; UI: public/js/write-ai.js). Runs before projects.js.
//   GET  /api/writing/material                -> {notes: [ids of the papers that have a reading note], max}
//   POST /api/projects/:id/rewrite            {mode 'improve'|'shorten'|'translate'|'custom', instruction?, text, section?,
//                                              before?, after?} -> {text, same, newKeys}   (nothing is written)
//   POST /api/projects/:id/related-work       {ids, angle?, heading?} -> {latex, papers, cited, uncited, thin, skipped,
//                                              dropped, words}                              (nothing is written)
const core = require('../core');
const writing = require('../writing');

async function handle(ctx) {
  const { path: p, segments: seg, method: M, res } = ctx;
  if (p === '/api/writing/material' && M === 'GET') return ctx.send(200, { notes: writing.notedIds(), max: writing.RW_MAX });
  if (seg[1] === 'projects' && seg[2] && seg.length === 4 && M === 'POST' && (seg[3] === 'rewrite' || seg[3] === 'related-work')) {
    const project = core.P.get(seg[2]); // 404 unless registered
    if (project.missing) return ctx.send(404, { error: 'The project folder no longer exists: ' + project.path });
    const b = await ctx.json();
    const ac = new AbortController(); // Stop, or the page was closed while Claude was writing
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    if (seg[3] === 'rewrite') {
      return ctx.send(200, await writing.rewrite({ mode: String(b.mode || ''), instruction: b.instruction, text: b.text, section: b.section, before: b.before, after: b.after, signal: ac.signal }));
    }
    return ctx.send(200, await writing.relatedWork({ ids: b.ids, angle: b.angle, heading: b.heading !== false, signal: ac.signal }));
  }
  return false;
}

module.exports = { handle };
