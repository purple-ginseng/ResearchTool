/* Library tab, reader, "Practice" tab: multiple-choice quizzes that Claude writes from the paper (and the note) to
   test understanding. One question at a time: choose, Submit, then read why the answer is right and why each other
   option is wrong. The answers are kept with the quiz, so a quiz can be continued later; the result page lists the
   questions and offers to practise the missed ones again. "Cards" shows the same questions as flash cards.
   RT.quiz.show(host, item, {page(n)}) - called by reader.js when the tab is shown.
   Data: GET/POST /api/items/:id/quizzes, DELETE .../:qid, PUT .../:qid/progress (lib/quiz.js).
   Review (the second half of this file): every answered question gets a date to come back (right: after 1, 3, 7, 16,
   35 ... days; missed: the same day). The cards button of the Library list shows how many are due today across all
   papers and asks them as one session in a dialog, with the same question layout. RT.quiz.review() opens it.
   Data: GET /api/review[?cards=1], POST /api/review/answer, POST /api/review/off. */
(() => {
  const { $, $$, esc, api, toast, ls } = RT;
  RT.quiz = RT.quiz || {};

  const LEVELS = [['core', 'Core ideas'], ['deep', 'Deep understanding'], ['expert', 'Expert']];
  const LEVEL_NAME = Object.fromEntries(LEVELS);
  const KEYS = ['A', 'B', 'C', 'D'];
  // icon names (RT.icon)
  const I = { cards: 'quiz', bulb: 'bulb', chat: 'comment', prev: 'chevron-left', next: 'chevron-right', leaveOut: 'x-circle' };
  const CHEER = () => `<div class="qz-cheer">${RT.ill && RT.ill.successCelebration ? RT.ill.successCelebration({ size: 150 }) : ''}</div>`;

  const cache = new Map(); // itemId -> { quizzes, sel }
  const gens = new Map();  // itemId -> { ctrl (null: started before this page was loaded, watched by polling), status, t0, count, written }
  const sess = new Map();  // quiz id -> { order: [question ids being asked], pos, pick, hint, cpos (card), flipped }  (pos === order.length: the result page)
  let view = null;         // { host, item, hooks } of the panel on screen
  let mode = ls.get('rt.quiz.mode', 'quiz') === 'cards' ? 'cards' : 'quiz';

  const lang = () => (ls.get('rt.note.lang', 'zh') === 'en' ? 'en' : 'zh');
  const state = (id) => cache.get(id) || { quizzes: [], sel: null };
  const currentQz = () => { if (!view) return null; const st = state(view.item.id); return st.quizzes.find((q) => q.id === st.sel) || st.quizzes[0] || null; };
  const rich = (s) => (RT.diagram && RT.diagram.rich ? RT.diagram.rich(s) : esc(s));
  const richCite = (s) => RT.cite(rich(s)); // an explanation: its (p. N) become page chips
  const math = (root) => { if (RT.diagram && RT.diagram.renderMath) RT.diagram.renderMath(root); };
  const prog = (qz) => qz.progress || (qz.progress = {});
  const tally = (qz) => { const p = Object.values(prog(qz)); return { done: p.length, right: p.filter((x) => x.correct).length }; };

  function session(qz) {
    let s = sess.get(qz.id);
    const ids = qz.questions.map((q) => q.id);
    if (!s || s.order.some((id) => !ids.includes(id))) {
      const first = ids.findIndex((id) => !prog(qz)[id]);
      s = { order: ids, pos: first < 0 ? ids.length : first, pick: null, hint: false, cpos: 0, flipped: false };
      sess.set(qz.id, s);
    }
    return s;
  }
  const shuffled = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

  // ------------------------------------------------------------------ panel
  function show(host, item, hooks = {}) {
    view = { host, item, hooks };
    host.classList.add('qz');
    if (!host.dataset.wired) { host.dataset.wired = '1'; wire(host); }
    if (cache.has(item.id)) return render();
    host.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    api(`/api/items/${item.id}/quizzes`).then((r) => {
      cache.set(item.id, { quizzes: r.quizzes || [], sel: (r.quizzes && r.quizzes[0] && r.quizzes[0].id) || null });
      if (r.running) watch(item.id, r.progress);
      if (view && view.host === host && view.item.id === item.id) render();
    }).catch((e) => { if (view && view.host === host) host.innerHTML = `<div class="empty">Could not load the quizzes: ${esc(e.message)}</div>`; });
  }

  function render() {
    if (!view) return;
    const { host, item } = view, st = state(item.id), qz = currentQz(), gen = gens.get(item.id);
    const had = host.contains(document.activeElement); // the keyboard was in the panel: it stays there
    host.innerHTML = `
    <div class="qz-bar">
      <button id="qz-new" class="ib" title="New quiz: let Claude write another set of questions (another level or focus)" aria-label="New quiz" ${qz ? '' : 'hidden'}>${RT.icon('plus')}</button>
      <select id="qz-pick" title="Quizzes of this paper" aria-label="Quizzes of this paper" ${st.quizzes.length > 1 ? '' : 'hidden'}>${st.quizzes.map((q) => `<option value="${esc(q.id)}" ${qz && q.id === qz.id ? 'selected' : ''}>${esc(q.title)} · ${esc(LEVEL_NAME[q.level] || '')}</option>`).join('')}</select>
      <span class="qz-status muted" id="qz-status">${gen ? `<span class="spin"></span><span id="qz-status-text">${esc(gen.status)}</span>` : ''}</span>
      <button id="qz-stop" class="ib" title="Stop Claude" aria-label="Stop Claude" ${gen ? '' : 'hidden'}>${RT.icon('stop')}</button>
      <span class="spacer"></span>
      ${qz ? `<span class="seg" role="group" aria-label="How to practise"><button data-mode="quiz" class="${mode === 'quiz' ? 'on' : ''}" aria-pressed="${mode === 'quiz'}" title="Quiz: answer each question, then read the explanation">Quiz</button><button data-mode="cards" class="${mode === 'cards' ? 'on' : ''}" aria-pressed="${mode === 'cards'}" title="Flash cards: think of the answer, then turn the card">Cards</button></span>
      <button id="qz-restart" class="ib" title="Start again: forget my answers and shuffle the questions" aria-label="Start again">${RT.icon('reset')}</button>
      <button id="qz-del" class="ib danger" title="Delete this quiz" aria-label="Delete this quiz">${RT.icon('trash')}</button>` : ''}
    </div>
    <form class="qz-form" id="qz-form" ${!qz && !gen ? '' : 'hidden'}>
      <select id="qz-count" title="Number of questions" aria-label="Number of questions">${[5, 10, 15].map((n) => `<option value="${n}" ${n === 10 ? 'selected' : ''}>${n} questions</option>`).join('')}</select>
      <select id="qz-level" title="How hard the questions are" aria-label="Level">${LEVELS.map(([v, l]) => `<option value="${v}" ${v === 'deep' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" id="qz-focus" maxlength="300" placeholder="Focus (optional) — e.g. the training objective" title="What the questions should be about. Leave empty for the whole paper." aria-label="Focus of the quiz">
      <button class="accent ib" id="qz-go" title="Write the quiz with Claude: questions that test your understanding of this paper" aria-label="Write the quiz with Claude" ${gen ? 'disabled' : ''}>${RT.icon('sparkle')}</button>
    </form>
    ${qz && gen ? '<div class="qz-gen"><span class="spin"></span><b>Claude is writing a new quiz</b><span id="qz-wait-status"></span><div class="qz-progress"><i id="qz-wait-bar" style="width:0%"></i></div><span class="muted">You can keep practising or reload the page — it appears in the list when it is ready.</span></div>' : ''}
    ${qz ? '<div class="qz-scroll"><div class="qz-body" id="qz-body"></div></div>'
      : gen ? `<div class="empty qz-empty"><div class="qz-wait"><span class="spin"></span><b>Claude is writing your quiz</b><div id="qz-wait-status"></div><div class="qz-progress"><i id="qz-wait-bar" style="width:0%"></i></div><div class="muted">This usually takes 2 to 5 minutes for a full paper. You can keep working, open other papers or even reload the page — the quiz appears here when it is ready.</div></div></div>`
      : `<div class="empty qz-empty">${RT.icon(I.cards, { size: 34 })}<div>Test how well you understand this paper.<br>Claude writes multiple-choice questions; after each answer you see why it is right or wrong.</div></div>`}`;
    if (gen) { const add = $('#qz-new', host); if (add) add.disabled = true; paintGen(); }
    if (qz) paint();
    if (had && !host.contains(document.activeElement)) host.focus({ preventScroll: true });
  }

  // ---- the quiz that is being written: status, elapsed time and how many questions are done (bar and waiting screen)
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function paintGen() {
    if (!view) return;
    const gen = gens.get(view.item.id); if (!gen) return;
    const text = `${gen.status} · ${clock(Date.now() - gen.t0)}`;
    const a = $('#qz-status-text', view.host), b = $('#qz-wait-status', view.host), bar = $('#qz-wait-bar', view.host);
    if (a) a.textContent = text;
    if (b) b.textContent = text;
    if (bar) bar.style.width = (gen.count ? Math.max(4, (100 * (gen.written || 0)) / gen.count) : 4) + '%';
  }
  setInterval(() => { if (gens.size) paintGen(); }, 1000);
  // the quiz on screen, if the reader is in the middle of answering it (a new quiz must not take its place)
  const midQuiz = (st) => { const was = st.quizzes.find((q) => q.id === st.sel) || st.quizzes[0], s = was && sess.get(was.id); return s && s.pos < s.order.length && (s.pick != null || tally(was).done > 0) ? was : null; };
  // Take over the list the server has now; returns the quiz that is new (or null) and says so.
  function adopt(id, list) {
    const st = state(id), had = new Set(st.quizzes.map((q) => q.id)), mine = new Map(st.quizzes.map((q) => [q.id, q])); // copies on screen hold the answers given meanwhile
    const fresh = (list || []).find((q) => !had.has(q.id)) || null, busy = midQuiz(st);
    cache.set(id, { quizzes: (list || []).map((q) => mine.get(q.id) || q), sel: fresh && !busy ? fresh.id : st.sel || ((list || [])[0] || {}).id || null });
    if (fresh) toast(`Quiz ready: “${fresh.title}” — ${fresh.questions.length} questions.${busy ? ' Choose it in the list when you have finished this one.' : ''}`, 'ok');
    return fresh;
  }
  // A quiz that was started before this page was loaded (a reload, another window): show it and wait for it.
  function watch(id, p) {
    if (gens.has(id)) return;
    const gen = { ctrl: null, status: (p && p.text) || 'Claude is writing the quiz…', t0: (p && p.started) || Date.now(), count: (p && p.count) || 0, written: (p && p.written) || 0 };
    gens.set(id, gen);
    let fails = 0;
    const tick = async () => {
      if (gens.get(id) !== gen) return;
      let r = null, gone = false;
      try { r = await api(`/api/items/${id}/quizzes`); fails = 0; }
      catch (e) { gone = e.status === 404 || ++fails >= 20; } // 404: the reference was deleted; otherwise the server may be restarting
      if (gens.get(id) !== gen) return;
      if (gone) {
        gens.delete(id);
        if (fails >= 20) toast('Lost contact with the server - reload the page to see whether the quiz was written.', 'bad');
        if (view && view.item.id === id) render();
        return;
      }
      if (r && !r.running) {
        gens.delete(id);
        if (!adopt(id, r.quizzes)) toast('No quiz was written (stopped, or Claude could not finish) - try again.', 'bad');
        if (view && view.item.id === id) render();
        return;
      }
      if (r && r.progress) Object.assign(gen, { status: r.progress.text, count: r.progress.count, written: r.progress.written, t0: r.progress.started });
      paintGen();
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  }

  // ------------------------------------------------------------------ one question / the result page / a card
  function paint() {
    const qz = currentQz(), body = view && $('#qz-body', view.host);
    if (!qz || !body) return;
    const s = session(qz), had = view.host.contains(document.activeElement);
    body.innerHTML = mode === 'cards' ? cardHtml(qz, s) : s.pos >= s.order.length ? resultHtml(qz, s) : questionHtml(qz, s);
    math(body);
    if (had && !view.host.contains(document.activeElement)) view.host.focus({ preventScroll: true }); // the focused button was redrawn
    const scroll = body.parentElement; if (scroll) scroll.scrollTop = 0;
  }
  const qOf = (qz, id) => qz.questions.find((q) => q.id === id);
  const headHtml = (qz, s, label) => {
    const t = tally(qz), cards = mode === 'cards', n = cards ? qz.questions.length : s.order.length, at = cards ? s.cpos : s.pos;
    return `<div class="qz-top">
        <button class="ib ghost" data-go="-1" title="Previous (←)" aria-label="Previous" ${at > 0 ? '' : 'disabled'}>${RT.icon(I.prev)}</button>
        <span>${label}</span>
        <button class="ib ghost" data-go="1" title="Next (→)" aria-label="Next" ${at < n - (cards ? 1 : 0) ? '' : 'disabled'}>${RT.icon(I.next)}</button>
        <span class="spacer"></span>
        ${mode === 'quiz' ? `<span class="muted qz-score">${t.right} right${t.done - t.right ? ` · ${t.done - t.right} wrong` : ''}</span>` : ''}
      </div>
      <div class="qz-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${Math.min(at, n)}"><i style="width:${(100 * Math.min(cards ? at + 1 : at, n)) / n}%"></i></div>`;
  };
  // the four options of a question: `a` = the answer that was given ({choice}) or nothing yet, `pick` = the option chosen so far
  const optsHtml = (q, a, pick) => q.options.map((o, k) => {
    const cls = a ? (k === q.answer ? 'right' : k === a.choice ? 'wrong' : 'off') : pick === k ? 'on' : '';
    return `<button type="button" class="qz-opt ${cls}" data-opt="${k}" ${a ? 'disabled' : ''} aria-pressed="${!a && pick === k}">
          <span class="qz-key">${a && k === q.answer ? RT.icon('check') : a && k === a.choice ? RT.icon('close') : KEYS[k]}</span>
          <span class="qz-otext"><span>${rich(o)}</span>${a && (q.why || [])[k] ? `<span class="qz-why">${rich(q.why[k])}</span>` : ''}</span>
        </button>`;
  }).join('');
  function questionHtml(qz, s) {
    const q = qOf(qz, s.order[s.pos]), a = prog(qz)[q.id];
    const opts = optsHtml(q, a, s.pick);
    const last = s.pos === s.order.length - 1;
    return `${headHtml(qz, s, `Question ${s.pos + 1} of ${s.order.length}`)}
      <div class="qz-q">${rich(q.q)}</div>
      <div class="qz-opts">${opts}</div>
      ${a ? `<div class="qz-result ${a.correct ? 'ok' : 'bad'}">${a.correct ? 'Correct.' : `Not quite — the answer is ${KEYS[q.answer]}.`}</div>
        ${q.explain ? `<div class="qz-explain">${richCite(q.explain)}</div>` : ''}
        <div class="qz-actions">
          ${q.page && view.item.pdf ? `<button data-page="${q.page}" title="Go to page ${q.page} of the PDF, where this is discussed">p. ${q.page}</button>` : ''}
          <button class="ib" data-ask title="Ask Claude more about this question in the Claude panel" aria-label="Ask Claude about this">${RT.icon(I.chat)}</button>
          <span class="spacer"></span>
          <button class="primary" data-next title="${last ? 'See how you did' : 'Next question'} (Enter)">${last ? 'See the result' : 'Next'}</button>
        </div>`
    : `${s.hint && q.hint ? `<div class="qz-hint">${rich(q.hint)}</div>` : ''}
        <div class="qz-actions">
          ${q.hint && !s.hint ? `<button data-hint title="Show a hint (H)">${RT.icon(I.bulb)}Hint</button>` : ''}
          <span class="spacer"></span>
          <button class="primary" data-submit title="Check my answer (Enter)" ${s.pick == null ? 'disabled' : ''}>Submit</button>
        </div>`}`;
  }
  function resultHtml(qz, s) {
    const all = qz.questions, right = all.filter((q) => (prog(qz)[q.id] || {}).correct).length, n = all.length;
    const missed = all.filter((q) => prog(qz)[q.id] && !prog(qz)[q.id].correct).length;
    const pct = right / n;
    return `${headHtml(qz, s, 'Result')}
      <div class="qz-end">
        ${pct === 1 ? CHEER() : ''}
        <div class="qz-big">${right} / ${n}</div>
        <div>${pct === 1 ? 'Every answer right. Try a harder level or another focus.' : pct >= 0.7 ? 'A solid understanding. Look again at the ones you missed.' : pct >= 0.4 ? 'Some of it is there. The explanations of the missed questions show where to read again.' : 'Worth another read of the paper - the explanations point to the places.'}</div>
        <div class="qz-actions qz-center">
          ${missed ? `<button class="primary" data-again="missed" title="Ask the ${missed} missed question${missed > 1 ? 's' : ''} again">Practise the ${missed} I missed</button>` : ''}
          <button data-again="all" title="Forget my answers and ask every question again, in a new order">Start again</button>
          <button data-new title="Let Claude write new questions">New quiz</button>
        </div>
      </div>
      <ol class="qz-list">${all.map((q, k) => { const a = prog(qz)[q.id]; return `<li><button type="button" class="qz-row ${a ? (a.correct ? 'ok' : 'bad') : ''}" data-jump="${esc(q.id)}" title="Open this question again"><span class="qz-key">${a ? RT.icon(a.correct ? 'check' : 'close') : '–'}</span><span>${rich(q.q)}</span></button></li>`; }).join('')}</ol>`;
  }
  function cardHtml(qz, s) {
    const n = qz.questions.length, pos = s.cpos = Math.max(0, Math.min(s.cpos || 0, n - 1)), q = qz.questions[pos];
    return `${headHtml(qz, s, `Card ${pos + 1} of ${n}`)}
      <button type="button" class="qz-card ${s.flipped ? 'back' : ''}" data-flip title="Turn the card (Space)">
        ${s.flipped ? `<span class="qz-side">Answer</span><span class="qz-cans">${rich(q.options[q.answer])}</span>${q.explain ? `<span class="qz-cexp">${richCite(q.explain)}</span>` : ''}`
    : `<span class="qz-side">Question</span><span class="qz-cq">${rich(q.q)}</span><span class="muted qz-tap">Think of the answer, then click to turn the card</span>`}
      </button>
      ${s.flipped ? `<div class="qz-actions">${q.page && view.item.pdf ? `<button data-page="${q.page}" title="Go to page ${q.page} of the PDF">p. ${q.page}</button>` : ''}<button class="ib" data-ask title="Ask Claude more about this in the Claude panel" aria-label="Ask Claude about this">${RT.icon(I.chat)}</button><span class="spacer"></span><button class="primary" data-go="1" ${pos < n - 1 ? '' : 'disabled'}>Next card</button></div>` : ''}`;
  }

  // ------------------------------------------------------------------ answers
  async function save(qz, answers, reset = false) {
    const itemId = view.item.id;
    try { await api(`/api/items/${itemId}/quizzes/${qz.id}/progress`, { method: 'PUT', json: { answers, reset } }); }
    catch (e) { toast('Could not save your answer: ' + e.message, 'bad'); }
    refreshDue(); // an answer gives the question a date in the Review
  }
  function submit() {
    const qz = currentQz(); if (!qz || mode !== 'quiz') return;
    const s = session(qz), q = qOf(qz, s.order[s.pos]);
    if (!q || s.pick == null || prog(qz)[q.id]) return;
    prog(qz)[q.id] = { choice: s.pick, correct: s.pick === q.answer, at: new Date().toISOString() };
    save(qz, { [q.id]: s.pick });
    s.pick = null; s.hint = false;
    paint();
    const nx = view && $('#qz-body [data-next]', view.host); if (nx) nx.focus({ preventScroll: true });
  }
  function go(d) {
    const qz = currentQz(); if (!qz) return;
    const s = session(qz), cards = mode === 'cards', max = cards ? qz.questions.length - 1 : s.order.length, at = cards ? s.cpos : s.pos;
    const to = Math.max(0, Math.min(max, at + d));
    if (to === at) return;
    if (cards) s.cpos = to; else s.pos = to;
    s.pick = null; s.hint = false; s.flipped = false;
    paint();
  }
  function again(which) {
    const qz = currentQz(); if (!qz) return;
    const s = session(qz), p = prog(qz);
    if (which === 'missed') {
      const ids = qz.questions.map((q) => q.id).filter((id) => p[id] && !p[id].correct);
      if (!ids.length) return;
      for (const id of ids) delete p[id];
      save(qz, Object.fromEntries(ids.map((id) => [id, null])));
      s.order = shuffled(ids);
    } else {
      qz.progress = {};
      save(qz, {}, true);
      s.order = shuffled(qz.questions.map((q) => q.id));
    }
    s.pos = 0; s.pick = null; s.hint = false; s.flipped = false;
    paint();
  }

  // ------------------------------------------------------------------ writing a quiz with Claude
  async function generate(count, level, focus) {
    if (!view) return;
    const id = view.item.id;
    if (gens.has(id)) return;
    const ctrl = new AbortController(), gen = { ctrl, status: 'Starting…', t0: Date.now(), count, written: 0 };
    gens.set(id, gen);
    const paintStatus = () => { if (view && view.item.id === id) paintGen(); };
    render();
    let done = null, error = null, lost = false;
    try {
      const r = await fetch(`/api/items/${id}/quizzes`, { method: 'POST', signal: ctrl.signal, headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ count, level, focus, language: lang() }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.running) { gens.delete(id); watch(id, null); if (view && view.item.id === id) render(); return; } // already being written: wait for that one
        throw new Error(j.error || `Request failed (${r.status})`);
      }
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: end, value } = await rd.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'status') { gen.status = ev.text; if (ev.written != null) gen.written = ev.written; paintStatus(); }
          else if (ev.type === 'done') done = ev;
          else if (ev.type === 'error') error = ev.text;
        }
      }
      if (!done && !error) { lost = true; error = 'The connection closed before the quiz was finished.'; }
    } catch (e) { if (e.name === 'AbortError') error = 'Stopped - no quiz was written.'; else { lost = true; error = e.message; } }
    gens.delete(id);
    if (lost) { // the server keeps writing after the connection is gone: ask it where things stand
      try {
        const r = await api(`/api/items/${id}/quizzes`);
        if (r.running) { watch(id, r.progress); if (view && view.item.id === id) render(); return; }
        if (adopt(id, r.quizzes)) { if (view && view.item.id === id) render(); return; }
      } catch { /* report the first error below */ }
    }
    if (done) adopt(id, done.quizzes); // in the middle of another quiz of this paper: that one stays on screen
    else toast(error, 'bad');
    if (view && view.item.id === id) render();
  }

  // ------------------------------------------------------------------ events (one set per host element)
  function wire(host) {
    host.tabIndex = -1;
    host.addEventListener('submit', (e) => {
      if (e.target.id !== 'qz-form') return;
      e.preventDefault();
      generate(Number($('#qz-count', host).value), $('#qz-level', host).value, $('#qz-focus', host).value.trim());
    });
    host.addEventListener('change', (e) => { if (e.target.id === 'qz-pick' && view) { state(view.item.id).sel = e.target.value; render(); } });
    host.addEventListener('keydown', (e) => {
      if (!view || e.metaKey || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('input, select, textarea'))) return;
      const qz = currentQz(); if (!qz || !$('#qz-body', host)) return;
      const s = session(qz), k = e.key.toLowerCase();
      const onBtn = e.target.tagName === 'BUTTON';
      if (mode === 'cards') {
        if (k === ' ' && !onBtn) { s.flipped = !s.flipped; paint(); }
        else if (k === 'arrowright') go(1); else if (k === 'arrowleft') go(-1); else return;
        return e.preventDefault();
      }
      const q = s.pos < s.order.length ? qOf(qz, s.order[s.pos]) : null, answered = q && prog(qz)[q.id];
      const n = '1234'.indexOf(k) >= 0 && k.length === 1 ? '1234'.indexOf(k) : 'abcd'.indexOf(k) >= 0 && k.length === 1 ? 'abcd'.indexOf(k) : -1;
      if (q && !answered && n >= 0) { s.pick = n; paint(); }
      else if (q && !answered && k === 'h' && q.hint) { s.hint = true; paint(); }
      else if (k === 'enter' && !onBtn) { if (q && !answered) submit(); else if (q) go(1); }
      else if (k === 'arrowright') go(1); else if (k === 'arrowleft') go(-1);
      else return;
      e.preventDefault();
      if (!host.contains(document.activeElement) || document.activeElement === document.body) host.focus({ preventScroll: true });
    });
    host.addEventListener('click', async (e) => {
      if (!view) return;
      const t = e.target.closest('button'); if (!t) return;
      const qz = currentQz(), s = qz && session(qz);
      if (t.dataset.mode) { mode = t.dataset.mode === 'cards' ? 'cards' : 'quiz'; ls.set('rt.quiz.mode', mode); if (s) s.flipped = false; render(); }
      else if (t.id === 'qz-new') { const f = $('#qz-form', host); f.hidden = !f.hidden; t.classList.toggle('on', !f.hidden); if (!f.hidden) $('#qz-focus', host).focus(); }
      else if (t.id === 'qz-stop') { // the server keeps writing when a page goes away, so stopping is asked for explicitly
        const id = view.item.id, g = gens.get(id);
        t.disabled = true;
        try { await api(`/api/items/${id}/quizzes/stop`, { method: 'POST', json: {} }); } catch (err) { toast(err.message, 'bad'); }
        if (g && g.ctrl) g.ctrl.abort();
      }
      else if (t.id === 'qz-restart' && qz) { if (tally(qz).done && !(await RT.confirm('Start this quiz again?\n\nYour answers so far are forgotten.', { title: 'Start again', okText: 'Start again', icon: 'reset' }))) return; again('all'); host.focus({ preventScroll: true }); }
      else if (t.id === 'qz-del' && qz) {
        if (!(await RT.confirm(`Delete the quiz “${qz.title}”?\n\nIts questions and your answers are deleted, and this cannot be undone.`, { title: 'Delete quiz', okText: 'Delete', danger: true }))) return;
        try {
          const id = view.item.id, r = await api(`/api/items/${id}/quizzes/${qz.id}`, { method: 'DELETE' });
          const mine = new Map(state(id).quizzes.map((q) => [q.id, q]));
          cache.set(id, { quizzes: r.quizzes.map((q) => mine.get(q.id) || q), sel: (r.quizzes[0] || {}).id || null });
          sess.delete(qz.id);
          if (view && view.item.id === id) render();
        } catch (err) { toast(err.message, 'bad'); }
      }
      else if (!qz) return;
      else if (t.dataset.opt != null) { s.pick = Number(t.dataset.opt); paint(); const b = $(`#qz-body [data-opt="${s.pick}"]`, host); if (b) b.focus({ preventScroll: true }); }
      else if (t.dataset.submit != null) submit();
      else if (t.dataset.hint != null) { s.hint = true; paint(); }
      else if (t.dataset.next != null) go(1);
      else if (t.dataset.go) go(Number(t.dataset.go));
      else if (t.dataset.flip != null) { s.flipped = !s.flipped; paint(); const c = $('#qz-body [data-flip]', host); if (c) c.focus({ preventScroll: true }); }
      else if (t.dataset.jump != null) { s.order = qz.questions.map((q) => q.id); s.pos = Math.max(0, s.order.indexOf(t.dataset.jump)); paint(); }
      else if (t.dataset.again) again(t.dataset.again);
      else if (t.dataset.new != null) { const f = $('#qz-form', host); f.hidden = false; $('#qz-focus', host).focus(); }
      else if (t.dataset.page && view.hooks.page) { view.hooks.page(Number(t.dataset.page)); host.focus({ preventScroll: true }); }
      else if (t.dataset.ask != null) {
        const q = mode === 'cards' ? qz.questions[s.cpos] : qOf(qz, s.order[Math.min(s.pos, s.order.length - 1)]), box = $('#claude-input');
        RT.claude.toggle(true);
        if (box) { box.value = `About this practice question on the paper “${view.item.fields.title || view.item.citekey}”: “${q.q}” (the correct answer is “${q.options[q.answer]}”): `; box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      }
    });
  }

  // ================================================================== Review: the questions that are due, of all papers
  const LS_DAY = 86400000;
  const rv = { queue: [], pos: 0, pick: null, hint: false, info: null, loading: false, error: '', right: 0, wrong: 0, total: 0, first: 0 };
  // queue: [{card, a: {choice, correct, review} | null, tries, saving, noted, off}] - a missed question is put at the end once more
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysTo = (iso) => Math.round((dayStart(new Date(iso)) - dayStart(new Date())) / LS_DAY);
  // translated here: the result goes into a sentence ("It comes back {0}.") that is translated as a whole
  const tr = (s, ...a) => (RT.i18n && RT.i18n.t ? RT.i18n.t(s, ...a) : String(s).replace(/\{(\d+)\}/g, (m, i) => a[i]));
  const when = (iso) => { const n = daysTo(iso); return n <= 0 ? tr('today') : n === 1 ? tr('tomorrow') : n < 14 ? tr('in {0} days', n) : n < 60 ? tr('in {0} weeks', Math.round(n / 7)) : tr('in {0} months', Math.round(n / 30)); };

  // the Review button: in the Explore group of the Library toolbar (RT.library.toolbarSlot) when it has one, else before
  // the trash button; moved into the slot when the Library draws its toolbar later
  const reviewSlot = () => (RT.library && RT.library.toolbarSlot ? RT.library.toolbarSlot('explore') : null);
  const listOpts = $('#btn-trash');
  if (reviewSlot() || listOpts) {
    const html = `<button id="btn-review" class="ib has-text" title="Review: the quiz questions that are due today, from all papers" aria-label="Review the questions that are due">${RT.icon(I.cards)}<span class="ib-text">Review</span><span class="rv-badge" id="rv-badge" hidden></span></button>`;
    if (reviewSlot()) reviewSlot().insertAdjacentHTML('beforeend', html); else listOpts.insertAdjacentHTML('beforebegin', html);
  }
  // before Group with Claude (the Library keeps that one last); compare and lineage stay ahead of it
  const placeReview = () => {
    const b = $('#btn-review'), slot = reviewSlot(); if (!b || !slot) return;
    const rg = $('#btn-regroup', slot), anchor = rg || $('#btn-trash', slot);
    if (anchor ? b.nextElementSibling !== anchor : b.parentElement !== slot) { if (anchor) anchor.before(b); else slot.append(b); }
  };
  RT.on('library:refreshed', placeReview);
  setTimeout(placeReview, 0);
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-review" class="rv" aria-labelledby="rv-title">
  <div class="rv-head"><h3 id="rv-title">Review</h3><span class="muted" id="rv-count"></span><span class="spacer"></span>
    <div class="seg rv-scope" id="rv-scope" role="group" aria-label="Which papers" hidden><button type="button" data-scope="all" title="The questions of all papers">All papers</button><button type="button" data-scope="project"></button></div>
    <button class="ib ghost" id="rv-close" title="Close (Esc) - the review continues where you left it" aria-label="Close">${RT.icon('close')}</button></div>
  <div class="qz-scroll rv-scroll"><div class="qz-body" id="rv-body" tabindex="-1"></div></div>
</dialog>`);
  const dlg = $('#dlg-review'), rvBody = $('#rv-body');

  let dueTimer = 0, allDue = 0; // (allDue: what is due in all papers, for the empty scoped review)
  function paintDue(n) {
    allDue = n || 0;
    const b = $('#rv-badge'), btn = $('#btn-review'); if (!b || !btn) return;
    b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n || '');
    const t = n ? `Review: ${plural(n, 'question')} due today, from all papers` : 'Review: no quiz question is due today';
    btn.title = t; btn.setAttribute('aria-label', t);
  }
  // how many questions are due (the badge of the button); asked again when answers change, the window comes back and every half hour
  function refreshDue() {
    clearTimeout(dueTimer);
    dueTimer = setTimeout(async () => { try { const r = await api('/api/review'); if (!scopePid()) rv.info = { ...(rv.info || {}), ...r }; paintDue(r.due); } catch { /* the badge keeps what it showed */ } }, 250);
  }

  // scope: all papers, or the papers of the working project (project-papers.js; remembered in rt.rv.scope)
  const workingProject = () => (RT.projectPapers && RT.projectPapers.working ? RT.projectPapers.working() : null);
  const scopePid = () => (rv.scope === 'project' && rv.project ? rv.project.id : null);
  const reviewUrl = (cards) => { const q = [cards ? 'cards=1' : '', scopePid() ? 'project=' + RT.enc(scopePid()) : ''].filter(Boolean).join('&'); return '/api/review' + (q ? '?' + q : ''); };
  function paintScope() {
    const seg = $('#rv-scope'), pj = rv.project;
    seg.hidden = !pj;
    if (!pj) return;
    const b = $('[data-scope=project]', seg);
    b.textContent = `“${pj.name}”`; b.title = `Only the questions of the papers of the project “${pj.name}”`;
    for (const x of $$('button', seg)) x.classList.toggle('on', x.dataset.scope === (scopePid() ? 'project' : 'all'));
  }
  // the scope the dialog opens with; opts.project = a project id (the Library's "Review this project")
  // -> true when it is another scope than the session in memory
  function pickScope(opts) {
    const w = workingProject(), was = scopePid();
    rv.project = opts && opts.project ? { id: opts.project, name: opts.name || (w && w.id === opts.project ? w.name : opts.project) } : w;
    const want = opts && opts.project ? 'project' : ls.get('rt.rv.scope', 'all');
    rv.scope = want === 'project' && rv.project ? 'project' : 'all';
    paintScope();
    return was !== scopePid();
  }
  $('#rv-scope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scope]'); if (!b || rv.loading) return;
    ls.set('rt.rv.scope', b.dataset.scope);
    const was = scopePid();
    rv.scope = b.dataset.scope === 'project' && rv.project ? 'project' : 'all';
    paintScope();
    if (was !== scopePid()) loadReview();
  });

  const answeredCount = () => rv.queue.filter((e) => e.a).length;
  async function loadReview() {
    rv.loading = true; rv.error = ''; paintReview();
    try {
      let r;
      try { r = await api(reviewUrl(true)); } catch (e) { // the project is gone: all papers
        if (e.status !== 404 || !scopePid()) throw e;
        rv.scope = 'all'; rv.project = null; paintScope(); r = await api(reviewUrl(true));
      }
      rv.info = r; rv.queue = shuffled(r.cards || []).map((card) => ({ card, a: null, tries: 0 }));
      rv.away = false; rv.pos = 0; rv.pick = null; rv.hint = false; rv.right = 0; rv.wrong = 0; rv.total = r.due || 0; rv.first = rv.queue.length;
      if (!scopePid()) paintDue(r.due); // the badge counts all papers
    } catch (e) { rv.error = e.message; }
    rv.loading = false; paintReview();
  }
  function openReview(opts) {
    if (typeof opts === 'string') opts = { project: opts }; // review(pid) or review({project, name})
    if (!dlg.open) { if (document.querySelector('dialog[open]')) return toast('Close the open window first.'); dlg.showModal(); }
    if (pickScope(opts && opts.project ? opts : null)) rv.queue = []; // a session of another scope is not continued
    // a session in the middle stays (without the papers deleted meanwhile); a finished or untouched one is asked for
    // again, because answers given in a paper may have changed what is due
    // (one that was left to look at a paper also stays: its button says that the review waits)
    const mid = !rv.loading && rv.queue.length && rv.pos < rv.queue.length && (answeredCount() > 0 || rv.away);
    if (mid) {
      const have = new Set(RT.library.items().map((i) => i.id)), cur = rv.queue[rv.pos];
      rv.queue = rv.queue.filter((e) => e.a || have.has(e.card.itemId));
      rv.pos = rv.queue.includes(cur) ? rv.queue.indexOf(cur) : Math.min(rv.pos, rv.queue.length);
      paintReview();
    } else if (!rv.loading) loadReview();
    rvBody.focus({ preventScroll: true });
  }

  const paperHtml = (c) => `<div class="rv-paper">
      <button type="button" class="rv-open" data-rv-open title="Open this paper${c.q.page && c.pdf ? ` at page ${c.q.page}, where this is discussed` : ''} (the review waits here)">${RT.icon('open')}<span>${esc(RT.texPlain ? RT.texPlain(c.title) : c.title)}</span></button>
      <span class="muted rv-meta">${esc([c.quizTitle, LEVEL_NAME[c.level]].filter(Boolean).join(' · '))}${c.wrong ? ` · missed ${c.wrong === 1 ? 'once' : c.wrong + ' times'}` : ''}</span>
    </div>`;
  const backText = (e) => (e.failed ? 'This answer could not be saved, so the question stays due.' : !e.a || !e.a.review ? '' : e.a.correct ? `It comes back ${when(e.a.review.due)}.` : e.requeued ? 'It comes back at the end of this session.' : 'It stays due today.');
  function reviewQuestionHtml(e) {
    const c = e.card, q = c.q, a = e.a, n = rv.queue.length, last = rv.pos === n - 1;
    const head = `<div class="qz-top">
        <button class="ib ghost" data-go="-1" title="Previous (←)" aria-label="Previous" ${rv.pos > 0 ? '' : 'disabled'}>${RT.icon(I.prev)}</button>
        <span>Question ${rv.pos + 1} of ${n}${e.tries ? ' · again' : ''}</span>
        <button class="ib ghost" data-go="1" title="${a ? 'Next' : 'Skip for now - it stays due'} (→)" aria-label="${a ? 'Next' : 'Skip for now'}">${RT.icon(I.next)}</button>
        <span class="spacer"></span>
        <span class="muted qz-score">${rv.right} right${rv.wrong ? ` · ${rv.wrong} wrong` : ''}</span>
      </div>
      <div class="qz-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${rv.pos}"><i style="width:${(100 * rv.pos) / n}%"></i></div>`;
    return `${head}${paperHtml(c)}
      <div class="qz-q">${rich(q.q)}</div>
      <div class="qz-opts">${optsHtml(q, a, rv.pick)}</div>
      ${a ? `<div class="qz-result ${a.correct ? 'ok' : 'bad'}">${a.correct ? 'Correct.' : `Not quite — the answer is ${KEYS[q.answer]}.`} <span class="rv-back">${e.saving ? '<span class="spin"></span>' : esc(backText(e))}</span></div>
        ${q.explain ? `<div class="qz-explain">${richCite(q.explain).replace(/ data-pcite="(\d+)" title="[^"]*"/g, ' data-rv-page="$1" title="Open the paper at page $1"')}</div>` : ''}
        <div class="qz-actions">
          ${q.page && c.pdf ? `<button data-rv-page="${q.page}" title="Open the paper at page ${q.page}, where this is discussed (the review waits here)">p. ${q.page}</button>` : ''}
          <button class="ib" data-rv-note title="${e.noted ? 'Added to the note of this paper' : 'Add to note: put this question, the answer and the explanation into the note of this paper'}" aria-label="Add to note" ${e.noted ? 'disabled' : ''}>${RT.icon(e.noted ? 'check' : 'note')}</button>
          <button class="ib ${e.off ? 'on' : ''}" data-rv-off aria-pressed="${!!e.off}" title="${e.off ? 'This question is left out of the review - press to have it asked again' : 'Do not ask this question in the review again'}" aria-label="Leave this question out of the review">${RT.icon(I.leaveOut)}</button>
          <span class="spacer"></span>
          <button class="primary" data-next title="${last ? 'See how the review went' : 'Next question'} (Enter)">${last ? 'Finish' : 'Next'}</button>
        </div>`
    : `${rv.hint && q.hint ? `<div class="qz-hint">${rich(q.hint)}</div>` : ''}
        <div class="qz-actions">
          ${q.hint && !rv.hint ? `<button data-hint title="Show a hint (H)">${RT.icon(I.bulb)}Hint</button>` : ''}
          <span class="spacer"></span>
          <button class="primary" data-submit title="Check my answer (Enter)" ${rv.pick == null ? 'disabled' : ''}>Submit</button>
        </div>`}`;
  }
  const nextHtml = (info) => (info && info.next ? `The next ${info.next.n === 1 ? 'question comes' : `${info.next.n} questions come`} back ${when(info.next.at)}.` : '');
  function reviewEndHtml() {
    const info = rv.info || {}, left = info.due || 0, skipped = rv.queue.filter((e) => !e.a).length, done = rv.right + rv.wrong;
    return `<div class="qz-end">
        ${done && !rv.wrong ? CHEER() : ''}
        <div class="qz-big">${rv.right} / ${done}</div>
        <div>${!done ? 'No question was answered.' : rv.wrong ? 'The explanations of the missed ones show where to read again.' : 'Every answer right.'}
          ${left ? `<br>${plural(left, 'question')} ${left === 1 ? 'is' : 'are'} still due today${skipped ? ` (${skipped} skipped)` : ''}.` : `<br>Nothing more is due today. ${nextHtml(info)}`}</div>
        <div class="qz-actions qz-center">
          ${left ? `<button class="primary" data-rv-more title="Go on with the questions that are still due">Review ${Math.min(left, info.cap || left)} more</button>` : ''}
          <button data-rv-done>Done</button>
        </div>
      </div>
      <ol class="qz-list">${rv.queue.map((e, k) => `<li><button type="button" class="qz-row ${e.a ? (e.a.correct ? 'ok' : 'bad') : ''}" data-rv-jump="${k}" title="Show this question again"><span class="qz-key">${e.a ? RT.icon(e.a.correct ? 'check' : 'close') : '–'}</span><span>${rich(e.card.q.q)}<span class="muted rv-of"> — ${esc(RT.texPlain ? RT.texPlain(e.card.title) : e.card.title)}</span></span></button></li>`).join('')}</ol>`;
  }
  function paintReview() {
    const info = rv.info || {}, n = rv.queue.length;
    $('#rv-count').textContent = rv.loading || rv.error || !n ? '' : rv.total > rv.first ? `${plural(rv.total, 'question')} due today, ${rv.first} in this session` : ((np) => `${n} question${n === 1 ? '' : 's'} from ${np} paper${np === 1 ? '' : 's'}`)(new Set(rv.queue.map((e) => e.card.itemId)).size);
    if (rv.loading) rvBody.innerHTML = '<div class="empty rv-empty"><span class="spin"></span></div>';
    else if (rv.error) rvBody.innerHTML = `<div class="empty rv-empty"><div>Could not load the review: ${esc(rv.error)}</div><div class="qz-actions qz-center"><button data-rv-more>Try again</button></div></div>`;
    else if (!n) {
      rvBody.innerHTML = `<div class="empty rv-empty">${RT.icon(I.cards, { size: 34 })}<div>${info.scheduled
        ? `<b>Nothing is due today.</b><br>${nextHtml(info)}`
        : scopePid() ? `<b>No answered questions in the papers of “${esc(rv.project.name)}” yet.</b><br>Answer a quiz in the <b>Practice</b> tab of one of its papers.${allDue ? ` <b>All papers</b> has ${plural(allDue, 'question')} due today.` : ''}`
        : '<b>Nothing to review yet.</b><br>Answer a quiz in the <b>Practice</b> tab of a paper. Every question you answer comes back here: a missed one the same day, one you got right after 1, 3, 7, 16 and 35 days.'}</div>
        <div class="qz-actions qz-center"><button data-rv-done>Close</button></div></div>`;
    } else rvBody.innerHTML = rv.pos >= n ? reviewEndHtml() : reviewQuestionHtml(rv.queue[rv.pos]);
    math(rvBody);
    // a new question starts at its top; choosing an option or a hint keeps the place (Submit may be below the fold)
    const shown = rv.loading || rv.error || !n ? null : rv.pos >= n ? 'end' : rv.queue[rv.pos];
    if (shown !== rv.shown || (shown && shown !== 'end' && !!shown.a !== rv.shownAnswered)) rvBody.parentElement.scrollTop = 0;
    rv.shown = shown; rv.shownAnswered = !!(shown && shown.a);
    if (dlg.open && !dlg.contains(document.activeElement)) rvBody.focus({ preventScroll: true });
  }
  const rvFocus = (sel) => { const b = $(sel, rvBody); if (b) b.focus({ preventScroll: true }); else rvBody.focus({ preventScroll: true }); };

  async function reviewSubmit() {
    const e = rv.queue[rv.pos];
    if (!e || e.a || rv.pick == null) return;
    const c = e.card, choice = rv.pick, correct = choice === c.q.answer;
    e.a = { choice, correct, review: null }; e.saving = true;
    if (correct) rv.right++; else rv.wrong++;
    // a missed question is asked once more at the end of the session (twice at most)
    if (!correct && e.tries < 2) { rv.queue.push({ card: { ...c, wrong: c.wrong + 1 }, a: null, tries: e.tries + 1 }); e.requeued = true; }
    rv.pick = null; rv.hint = false;
    paintReview(); rvFocus('[data-next]');
    try {
      const r = await api('/api/review/answer', { method: 'POST', json: { itemId: c.itemId, quizId: c.quizId, qid: c.q.id, choice } });
      e.a.review = r.review; paintDue(r.due); // r.due counts all papers
      if (!scopePid()) rv.info = { ...(rv.info || {}), due: r.due };
      else api(reviewUrl(false)).then((x) => { rv.info = { ...(rv.info || {}), ...x }; }).catch(() => {});
      cache.delete(c.itemId); // the Practice tab of that paper shows the new answer when it is opened next
      if (view && view.item.id === c.itemId && view.host.isConnected) show(view.host, view.item, view.hooks);
    } catch (err) { e.failed = true; toast('Could not save your answer: ' + err.message, 'bad'); }
    e.saving = false;
    if (rv.queue[rv.pos] === e) { const el = $('.rv-back', rvBody); if (el) el.textContent = backText(e); }
  }
  function reviewGo(d) {
    const to = Math.max(0, Math.min(rv.queue.length, rv.pos + d));
    if (to === rv.pos) return;
    rv.pos = to; rv.pick = null; rv.hint = false;
    if (to === rv.queue.length) api(reviewUrl(false)).then((r) => { rv.info = { ...(rv.info || {}), ...r }; if (!scopePid()) paintDue(r.due); if (rv.pos === rv.queue.length) paintReview(); }).catch(() => {});
    paintReview();
  }
  // the paper of the card on screen, in the reader (at a page of its PDF when one is given); the session waits in memory
  function reviewOpenPaper(c, page) {
    rv.away = true; dlg.close();
    if (page && c.pdf && RT.reader.reveal) return RT.reader.reveal(c.itemId, { kind: 'pdf', page, text: '' });
    if (RT.state.view !== 'library') RT.setView('library');
    RT.library.select(c.itemId);
  }
  // "Add to note": the question, the right answer and the explanation as a quote block at the end of the paper's note
  const mdLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  function noteMd(c) {
    const q = c.q, where = q.page ? ` (p. ${q.page})` : '';
    return `> **Review question${where}:** ${mdLine(q.q)}\n>\n> **Answer:** ${mdLine(q.options[q.answer])}${q.explain ? `\n>\n> ${mdLine(q.explain)}` : ''}`;
  }
  async function reviewAddNote(e, btn) {
    const c = e.card, md = RT.cite.md(noteMd(c)); // (p. N) becomes a link to that page, as in every note
    btn.disabled = true;
    try {
      const open = RT.reader.current && RT.reader.current();
      if (open && open.id === c.itemId && RT.reader.editor()) { // the note of this paper is in the editor: it goes in there, like every other insert
        if (RT.reader.insert(md) !== true) { btn.disabled = false; return; }
      } else {
        const n = await api(`/api/items/${c.itemId}/note`);
        await api(`/api/items/${c.itemId}/note`, { method: 'PUT', json: { content: (n.content || '').replace(/\s*$/, n.content && n.content.trim() ? '\n\n' : '') + md + '\n', baseHash: n.hash || null, source: 'manual', label: 'Review question added' } });
      }
      for (const x of rv.queue) if (x.card.itemId === c.itemId && x.card.quizId === c.quizId && x.card.q.id === c.q.id) x.noted = true;
      toast(`Added to the note of “${c.title}”.`, 'ok');
    } catch (err) { toast('Could not add it to the note: ' + err.message, 'bad'); }
    if (rv.queue[rv.pos] === e) { paintReview(); rvFocus('[data-next]'); }
  }
  async function reviewOff(e) {
    const c = e.card, off = !e.off;
    try {
      const r = await api('/api/review/off', { method: 'POST', json: { itemId: c.itemId, quizId: c.quizId, qid: c.q.id, off } });
      for (const x of rv.queue) if (x.card.itemId === c.itemId && x.card.quizId === c.quizId && x.card.q.id === c.q.id) x.off = r.off;
      if (r.off) rv.queue = rv.queue.filter((x, k) => k <= rv.pos || x.a || !x.off); // its second round is not asked
      rv.info = { ...(rv.info || {}), due: r.due }; paintDue(r.due);
      toast(r.off ? 'This question is left out of the review from now on.' : 'This question is asked in the review again.', 'ok');
    } catch (err) { toast(err.message, 'bad'); }
    if (rv.queue[rv.pos] === e) { paintReview(); rvFocus('[data-rv-off]'); }
  }

  if ($('#btn-review')) $('#btn-review').addEventListener('click', () => openReview());
  $('#rv-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', refreshDue);
  dlg.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || rv.loading) return;
    const e = rv.queue[rv.pos], k = ev.key.toLowerCase(), onBtn = ev.target.tagName === 'BUTTON';
    const n = k.length === 1 && '1234'.indexOf(k) >= 0 ? '1234'.indexOf(k) : k.length === 1 && 'abcd'.indexOf(k) >= 0 ? 'abcd'.indexOf(k) : -1;
    if (e && !e.a && n >= 0) { rv.pick = n; paintReview(); rvBody.focus({ preventScroll: true }); } // not on the option: Enter then submits
    else if (e && !e.a && k === 'h' && e.card.q.hint) { rv.hint = true; paintReview(); }
    else if (k === 'enter' && !onBtn) { if (e && !e.a) reviewSubmit(); else if (e) reviewGo(1); }
    else if (k === 'arrowright') reviewGo(1); else if (k === 'arrowleft') reviewGo(-1);
    else return;
    ev.preventDefault();
  });
  rvBody.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.pcite[data-rv-page]'), t = chip || ev.target.closest('button'); if (!t) return;
    const e = rv.queue[rv.pos], d = t.dataset;
    if (d.rvMore != null) loadReview();
    else if (d.rvDone != null) dlg.close();
    else if (d.rvJump != null) { rv.pos = Number(d.rvJump); rv.pick = null; rv.hint = false; paintReview(); }
    else if (!e) return;
    else if (d.opt != null) { rv.pick = Number(d.opt); paintReview(); rvFocus(`[data-opt="${rv.pick}"]`); }
    else if (d.submit != null) reviewSubmit();
    else if (d.hint != null) { rv.hint = true; paintReview(); }
    else if (d.next != null) reviewGo(1);
    else if (d.go) reviewGo(Number(d.go));
    else if (d.rvOpen != null) reviewOpenPaper(e.card, e.a ? e.card.q.page : null); // before the answer, the page would give it away
    else if (d.rvPage) reviewOpenPaper(e.card, Number(d.rvPage));
    else if (d.rvNote != null) reviewAddNote(e, t);
    else if (d.rvOff != null) reviewOff(e);
  });
  rvBody.addEventListener('keydown', (ev) => { // a page chip is a link: Enter and Space follow it
    const chip = ev.target.closest && ev.target.closest('.pcite[data-rv-page]'), e = rv.queue[rv.pos];
    if (chip && e && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); ev.stopPropagation(); reviewOpenPaper(e.card, Number(chip.dataset.rvPage)); }
  });

  // what is due changes when papers come and go, when the window is used again after a while, and at midnight
  RT.on('library:changed', refreshDue);
  RT.on('library:refreshed', refreshDue);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDue(); });
  setInterval(refreshDue, 30 * 60 * 1000);
  refreshDue();

  Object.assign(RT.quiz, { show, forget: (id) => cache.delete(id), review: openReview });
})();
