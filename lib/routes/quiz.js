// Practice quizzes of library items (READER, "Practice" tab) - see lib/quiz.js.
//   GET     /api/items/:id/quizzes                          { quizzes, running, progress: {text, count, written, started} | null }
//   POST    /api/items/:id/quizzes {count?, level?, focus?, language?}   -> NDJSON stream (status ... done | error)
//   POST    /api/items/:id/quizzes/stop                     stop the quiz that is being written   { stopped }
//   DELETE  /api/items/:id/quizzes/:qid                     { quizzes }
//   PUT     /api/items/:id/quizzes/:qid/progress {answers: {<question id>: 0..3 | null}, reset?}   { progress }
// Spaced review of the answered questions of all papers (the Review button of the Library list):
//   GET     /api/review[?cards=1][&project=<pid>]           { due, scheduled, next: {at, n} | null, cap, cards? }
//                                                           (project: only the papers of that project)
//   POST    /api/review/answer {itemId, quizId, qid, choice}   { correct, review, due }
//   POST    /api/review/off {itemId, quizId, qid, off}      leave a question out of the review / take it back in
const core = require('../core');
const quiz = require('../quiz');

async function handle(ctx) {
  const { res, segments: seg, method: M, send } = ctx;
  if (seg[1] === 'review') {
    if (seg.length === 2 && M === 'GET') {
      const pid = ctx.query.get('project');
      const ids = pid ? new Set(core.P.papers(core.P.get(pid)).map((x) => x.id)) : null; // 404 for an unknown project
      return send(200, quiz.review({ cards: ctx.query.get('cards') === '1', ids }));
    }
    if (seg.length === 3 && seg[2] === 'answer' && M === 'POST') return send(200, quiz.reviewAnswer(await ctx.json()));
    if (seg.length === 3 && seg[2] === 'off' && M === 'POST') return send(200, quiz.reviewOff(await ctx.json()));
    return false;
  }
  if (seg[1] !== 'items' || !seg[2] || seg[3] !== 'quizzes') return false;
  const item = core.loadLib().items.find((i) => i.id === seg[2]);
  if (!item) return send(404, { error: 'No such item' });

  if (seg.length === 4) {
    if (M === 'GET') return send(200, { ...quiz.read(item.id), running: quiz.running(item.id), progress: quiz.progress(item.id) });
    if (M === 'POST') {
      const b = await ctx.json();
      if (quiz.running(item.id)) return send(409, { error: 'A quiz is already being written for this reference', running: true });
      await quiz.generate(item, {
        count: quiz.COUNTS.includes(Number(b.count)) ? Number(b.count) : 10,
        level: quiz.LEVELS.includes(b.level) ? b.level : 'deep',
        focus: String(b.focus || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        language: b.language === 'en' ? 'en' : 'zh', res,
      });
      return true;
    }
    return false;
  }
  if (seg.length === 5 && seg[4] === 'stop' && M === 'POST') return send(200, quiz.stop(item.id));
  if (seg.length === 5 && M === 'DELETE') return send(200, quiz.remove(item.id, seg[4]));
  if (seg.length === 6 && seg[5] === 'progress' && M === 'PUT') return send(200, quiz.answer(item.id, seg[4], await ctx.json()));
  return false;
}

module.exports = { handle };
