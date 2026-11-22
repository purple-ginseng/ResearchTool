/* Tour: a guided walk through the whole app in 8 chapters, from the Overview to the Editor (the script is
   public/js/tour-steps.js, window.RT_TOUR). Each step dims the page, lights up one control and explains it in a small
   card: "Chapter n/8 · step k/N", Back / Next, a list of the chapters to jump to, Skip; → ← Enter and Esc. The tour
   switches views itself (RT.nav.go), opens the paper read last for the reader chapters (RT.nav.openPaper), shows the
   reader tab a step is about (RT.reader.tab), opens the Claude panel for its chapter and the latest project for the
   Editor steps - and waits for each control to render. A control that is not on screen (no backup notice, a project
   not linked to Overleaf) is explained in a centred card instead; nothing throws. With an empty library or no project
   the steps that need one become one card that says so. The tour changes no data and presses no button of the app
   (only, in a narrow window, the reader's PDF / notes switch): while it runs the reader keeps no reading position and
   notes no "opened" (reader.js checks body.touring), the Editor's projects home is shown over an open project without
   closing it (RT.write.peekHome) and a project the tour opens is not compiled nor made the working project. At the end
   the Claude panel, the reader tab, the paper (one the tour opened is closed when the view is another) and the Editor
   (its open project, or its projects home) are put back as they were
   (the view stays where the tour ended). A tool folded into the PDF bar's ⋯ menu is lit there, with a note saying so.
   Entry points: Help › "Take the tour" / "Tour of this screen" (core.js), the palette ("Take the tour", "Tour:
   Library" ...), the "Take the tour" notice on the Overview (overview.js, until the tour was finished or dismissed),
   the Guide. #btn-tour stays in the page, hidden, as the old entry point.
   API: RT.tour.start({chapter (id or 1-8), step (id)}), end(), next(), back(), goTo(stepId), active(), steps() (the
   whole script, for the demo recorder), chapters(), seen() (finished or dismissed), forChapterOfView(), actions()
   (the buttons of the screen for the palette). DOM events on document: 'tour:step' {chapter, chapterIndex, step,
   steps, id, index, total, found}, 'tour:end' {completed, id}. localStorage: rt.tour.done (finished),
   rt.tour.dismissed (skipped / closed the Overview notice). */
(() => {
  const { $, $$, ls, toast } = RT;
  RT.tour = RT.tour || {};
  const DATA = window.RT_TOUR || { CHAPTERS: [], STEPS: [] };
  const CHAPTERS = DATA.CHAPTERS, STEPS = DATA.STEPS;
  const MOD = RT.isMac ? '⌘' : 'Ctrl+';
  const DONE = 'rt.tour.done', DISMISSED = 'rt.tour.dismissed';
  const L = (s, ...a) => (RT.i18n && RT.i18n.t ? RT.i18n.t(s, ...a) : String(s).replace(/\{(\d+)\}/g, (m, i) => (a[i] !== undefined ? a[i] : m)));
  // a step's own text: translated here (exact entries of zh-tour.js), then {mod} -> ⌘ / Ctrl+
  // ... and with the chosen AI provider's name for "Claude" (the card is data-i18n-skip, so the display layer does not)
  const T = (s) => {
    let t = s;
    try { t = (RT.i18n && RT.i18n.translate && RT.i18n.translate(s)) || s; if (RT.i18n && RT.i18n.rebrand) t = RT.i18n.rebrand(t); } catch { t = s; }
    return String(t).replace(/\{mod\}/g, MOD);
  };
  // a step's text for the chosen provider: step.alt holds the words for one that lacks a capability Claude Code has
  // (alt.agentic: the panel cannot edit files, alt.readsPdf: works from the extracted text, alt.claude: any provider
  // but Claude) - so no card claims what the provider does not do
  const textOf = (s) => {
    if (!s.alt || !RT.ai) return s.text;
    const caps = RT.ai.caps() || {};
    const k = Object.keys(s.alt).find((c) => (c === 'claude' ? !RT.ai.isClaude() : caps[c] === false));
    return k ? s.alt[k] : s.text;
  };
  RT.tour.textOf = textOf;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chOf = (id) => CHAPTERS.find((c) => c.id === id);

  document.body.insertAdjacentHTML('beforeend', `
<div id="tour" hidden>
  <div class="tour-block"></div>
  <div class="tour-hole"></div>
  <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
    <div class="tour-head">
      <button type="button" id="tour-chapters" class="tour-ch" aria-haspopup="true" aria-expanded="false" title="Jump to a chapter"><span id="tour-chname" data-i18n-skip></span>${RT.icon('chevron-down')}</button>
      <span class="spacer"></span>
      <button type="button" id="tour-close" class="ib ghost" title="End the tour (Esc)" aria-label="End the tour">${RT.icon('close')}</button>
    </div>
    <div class="tour-progress" aria-hidden="true"><span id="tour-bar"></span></div>
    <div id="tour-chlist" class="tour-chlist" role="group" aria-label="Chapters" hidden></div>
    <span class="tour-count" id="tour-count" data-i18n-skip></span>
    <b id="tour-title" data-i18n-skip></b>
    <p id="tour-text" aria-live="polite" data-i18n-skip></p>
    <p id="tour-missing" class="tour-missing" hidden>This part is not on screen right now, so here is what it does.</p>
    <p id="tour-folded" class="tour-missing" hidden>At this width this tool is in the ⋯ menu lit here.</p>
    <div class="tour-actions"><button type="button" id="tour-skip" class="ghost" title="Leave the tour; restart it any time from Help">Skip tour</button><span class="spacer"></span><button type="button" id="tour-back" title="Previous step (←)">‹ Back</button><button type="button" id="tour-next" class="primary" title="Next step (→ or Enter)">Next ›</button></div>
  </div>
</div>`);
  const root = $('#tour'), hole = $('.tour-hole', root), block = $('.tour-block', root), cardEl = $('.tour-card', root);
  const btn = $('#btn-tour');
  let run = null; // { plan, at, el, token, timer, claudeWas, tabWas, focus }

  const visible = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]'); };
  const sels = (s) => (s.el == null ? [] : Array.isArray(s.el) ? s.el : [s.el]);
  function find(s) {
    for (const sel of sels(s)) {
      let list = [];
      try { list = $$(sel); } catch { continue; } // a bad selector only loses its step's light
      const el = list.find(visible);
      if (el) return el;
    }
    return null;
  }
  const items = () => { try { return (RT.library && RT.library.items && RT.library.items()) || []; } catch { return []; } };
  const claudeOpen = () => !!(RT.claude && RT.claude.isOpen ? RT.claude.isOpen() : !$('#claude').hidden);
  const setClaude = (show) => { if (claudeOpen() !== show && RT.claude && RT.claude.toggle) { try { RT.claude.toggle(show); } catch (e) { console.error(e); } } };

  // ---------------- the plan: the steps of this run ----------------
  // steps that need a paper (or a project) give way to their chapter's one "empty" card when there is none
  function buildPlan(have) {
    const plan = [];
    CHAPTERS.forEach((ch, ci) => {
      const out = [];
      let emptied = false;
      for (const s of STEPS.filter((x) => x.ch === ch.id)) {
        const need = s.needs || ch.needs || (s.mode === 'project' ? 'project' : null);
        if (need && !have[need]) {
          if (!emptied && ch.empty) { out.push({ id: ch.id + '-empty', ch: ch.id, el: ch.empty.el, title: ch.empty.title, text: ch.empty.text, empty: true, mode: s.mode === 'project' ? 'home' : undefined }); emptied = true; }
          continue;
        }
        out.push(s);
      }
      out.forEach((s, k) => plan.push({ s, ch, ci, k, n: out.length }));
    });
    return plan;
  }
  // the whole script, as the demo recorder sees it (every step, whatever the library holds)
  function steps() {
    const out = [];
    CHAPTERS.forEach((ch, ci) => {
      const list = STEPS.filter((x) => x.ch === ch.id);
      list.forEach((s, k) => out.push({ id: s.id, chapter: ch.id, chapterTitle: ch.title, chapterIndex: ci + 1, step: k + 1, steps: list.length,
        title: s.title.replace(/\{mod\}/g, MOD), text: textOf(s).replace(/\{mod\}/g, MOD), selector: sels(s).join(', ') || null,
        view: ch.view || null, tab: s.tab || null, claude: !!s.claude, mode: s.mode || null }));
    });
    return out;
  }

  // ---------------- getting the screen ready for a step ----------------
  async function waitFor(fn, ms) {
    const until = Date.now() + ms;
    for (;;) { const v = fn(); if (v || Date.now() >= until) return v; await sleep(80); }
  }
  function lastPaper() {
    const list = items();
    if (!list.length) return null;
    if (RT.state.sel && list.some((i) => i.id === RT.state.sel)) return RT.state.sel;
    const t = (i) => Date.parse(i.lastOpened || '') || 0;
    return [...list].sort((a, b) => t(b) - t(a))[0].id;
  }
  async function ensurePaper() {
    const ready = () => RT.state.sel && $('#detail .rd-tablist') && visible($('#detail .rd-tablist'));
    if (ready()) return true;
    const id = lastPaper();
    if (!id) return false;
    try { RT.nav.openPaper(id); if (run) run.openedPaper = id; } catch (e) { console.error(e); }
    return !!(await waitFor(ready, 5000));
  }
  async function ensureProject() {
    if (!RT.write) return false;
    if (RT.write.peeking && RT.write.peeking()) RT.write.peekHome(false); // the open project was only covered by the list
    const isOpen = () => RT.write.mode && RT.write.mode() === 'project' && visible($('#wr')); // (its side may show another panel than the files)
    if (isOpen()) return true;
    let id = null;
    try { id = (RT.write.currentProject && RT.write.currentProject() && RT.write.currentProject().id) || ls.get('rt-project', ''); } catch { id = null; }
    if (!id) { const c = $('#pj-rows .pj-card[data-id]'); id = c && c.dataset.id; }
    if (!id) return false;
    // a look only: no compile, and the project does not become the one opened last or the working project
    try { if ((await RT.write.openProject(id, { compile: false, remember: false })) && run) run.openedProject = true; } catch (e) { console.error(e); }
    return !!(await waitFor(isOpen, 5000));
  }
  async function prepare(p) {
    const { s, ch } = p;
    if (ch.view && RT.state.view !== ch.view && RT.views && RT.views.has(ch.view)) RT.nav.go(ch.view);
    setClaude(!!s.claude || !!(run && run.claudeWas)); // open for its chapter; otherwise as the user had it
    if (!s.empty && (ch.needs === 'paper' || s.tab)) {
      if (await ensurePaper() && s.tab && RT.reader && RT.reader.tabNow && RT.reader.tabNow() !== s.tab) { try { RT.reader.tab(s.tab); } catch (e) { console.error(e); } }
    }
    if (s.side === 'pdf' && !s.empty) { // a narrow window shows one side of the reader: the PDF for this step
      const b = $$('#rd-narrow button[data-side="pdf"]').find(visible);
      if (b && b.getAttribute('aria-pressed') !== 'true' && !b.classList.contains('on')) b.click();
    }
    if (s.mode === 'home' && RT.write && RT.write.mode && RT.write.mode() !== 'home') { // the list over the open project, which stays open
      try { if (!(RT.write.peekHome && RT.write.peekHome(true)) && RT.write.showHome) RT.write.showHome(); } catch (e) { console.error(e); }
    }
    if (s.mode === 'project' && !s.empty) await ensureProject();
  }

  // ---------------- drawing ----------------
  function place() {
    if (!run) return;
    if (document.querySelector('dialog[open]')) return end(); // a window opened over the tour: it wins
    const vw = window.innerWidth, vh = window.innerHeight, P = 5;
    const cw = Math.min(360, vw - 24); cardEl.style.width = cw + 'px';
    const ch = cardEl.offsetHeight, G = 12;
    const clampX = (x) => Math.max(12, Math.min(x, vw - cw - 12)), clampY = (y) => Math.max(12, Math.min(y, vh - ch - 12));
    let el = run.el;
    if (el && !visible(el)) el = run.el = run.pending ? null : find(run.plan[run.at].s); // re-rendered: look it up again
    if (run.pending && run.shown && !el) return; // the old control went away while the next step gets ready: hold still
    root.classList.toggle('tour-centred', !el);
    if (!el) { // a centred card over the dimmed page
      hole.style.display = 'none';
      cardEl.style.left = clampX((vw - cw) / 2) + 'px'; cardEl.style.top = clampY((vh - ch) / 2) + 'px';
      return;
    }
    hole.style.display = '';
    const r = el.getBoundingClientRect();
    const x0 = Math.max(4, r.left - P), y0 = Math.max(4, r.top - P), x1 = Math.min(vw - 4, r.right + P), y1 = Math.min(vh - 4, r.bottom + P);
    Object.assign(hole.style, { left: x0 + 'px', top: y0 + 'px', width: Math.max(0, x1 - x0) + 'px', height: Math.max(0, y1 - y0) + 'px' });
    const cx = clampX((x0 + x1) / 2 - cw / 2), cy = clampY((y0 + y1) / 2 - ch / 2);
    let left, top;
    if (vh - y1 >= ch + G + 12) { left = cx; top = y1 + G; }            // below
    else if (y0 >= ch + G + 12) { left = cx; top = y0 - G - ch; }       // above
    else if (vw - x1 >= cw + G + 12) { left = x1 + G; top = cy; }       // right
    else if (x0 >= cw + G + 12) { left = x0 - G - cw; top = cy; }       // left
    else { left = clampX(x1 - cw - 16); top = clampY(y1 - ch - 16); }   // a large area: inside its lower right corner
    cardEl.style.left = left + 'px'; cardEl.style.top = top + 'px';
  }
  function paint() { // the card's words for the current step (again after a language switch)
    if (!run) return;
    const p = run.plan[run.at];
    $('#tour-chname').textContent = `${p.ci + 1}. ${T(p.ch.title)}`;
    $('#tour-count').textContent = L('Chapter {0}/{1} · step {2}/{3}', p.ci + 1, CHAPTERS.length, p.k + 1, p.n);
    $('#tour-bar').style.width = `${Math.round(((run.at + 1) / run.plan.length) * 100)}%`;
    $('#tour-title').textContent = T(p.s.title);
    $('#tour-text').textContent = T(textOf(p.s));
    $('#tour-missing').hidden = !!(run.el || run.pending || p.s.el == null || p.s.empty);
    // a fallback that is the PDF bar's ⋯ menu: the tool the card is about is folded into it at this width
    $('#tour-folded').hidden = !(run.el && !run.pending && p.s.id !== 'rd-more' && run.el.id === 'rd-pdf-more' && sels(p.s)[0] !== '#rd-pdf-more');
    $('#tour-back').disabled = run.at === 0;
    const last = run.at === run.plan.length - 1;
    $('#tour-back').textContent = L('‹ Back');
    $('#tour-next').textContent = last ? L('Finish tour') : L('Next ›');
    $('#tour-skip').hidden = last;
    renderChapters();
  }
  function renderChapters() {
    const list = $('#tour-chlist'), cur = run ? run.plan[run.at].ci : -1;
    list.replaceChildren(...CHAPTERS.map((c, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.ch = c.id; b.className = 'tour-chi' + (i === cur ? ' on' : '');
      if (i === cur) b.setAttribute('aria-current', 'step');
      b.innerHTML = `<span class="tour-chn">${i + 1}</span><span class="tour-cht" data-i18n-skip></span>`;
      b.lastChild.textContent = T(c.title);
      return b;
    }));
  }
  function toggleChapters(show = $('#tour-chlist').hidden) {
    $('#tour-chlist').hidden = !show;
    $('#tour-chapters').setAttribute('aria-expanded', String(show));
    place();
    if (show) { const on = $('#tour-chlist .on') || $('#tour-chlist button'); if (on) on.focus(); }
  }

  async function show(at) {
    if (!run) return;
    const token = ++run.token;
    run.at = Math.max(0, Math.min(at, run.plan.length - 1));
    const p = run.plan[run.at];
    // the card keeps showing the step it was on until the next one is ready (no jump while a view switches)
    run.pending = true;
    $('#tour-chlist').hidden = true; $('#tour-chapters').setAttribute('aria-expanded', 'false');
    root.classList.add('tour-busy');
    if (!run.shown) { paint(); place(); } // the very first card: centred until its control is found
    try { await prepare(p); } catch (e) { console.error(e); }
    if (!run || run.token !== token) return;
    const el = p.s.el == null ? null : await waitFor(() => find(p.s), p.s.wait != null ? p.s.wait : 1500);
    if (!run || run.token !== token) return;
    run.el = el || null; run.pending = false; run.shown = true;
    root.classList.remove('tour-busy');
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* old engines */ } }
    paint(); place();
    if (!root.contains(document.activeElement)) $('#tour-next').focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('tour:step', { detail: { chapter: p.ch.id, chapterIndex: p.ci + 1, step: p.k + 1, steps: p.n, id: p.s.id, index: run.at, total: run.plan.length, found: !!el } }));
  }
  function next() { if (!run) return; if (run.at >= run.plan.length - 1) finish(); else show(run.at + 1); }
  function back() { if (run && run.at > 0) show(run.at - 1); }
  function goTo(id) {
    if (!run) return start({ step: id });
    const i = run.plan.findIndex((p) => p.s.id === id || p.ch.id === id);
    if (i >= 0) show(i);
  }
  function finish() {
    ls.set(DONE, '1');
    end(true);
    toast(L('Tour complete. Take it again any time from Help › Take the tour.'), 'ok');
  }

  async function start(opts = {}) {
    if (typeof opts === 'string' || typeof opts === 'number') opts = { chapter: opts };
    if (run) end();
    const dlg = $$('dialog[open]');
    if (dlg.some((d) => d.id !== 'dlg-guide')) { toast(L('Close the open window first, then start the tour.')); return; }
    dlg.forEach((d) => d.close());
    if (RT.palette && RT.palette.close) { try { RT.palette.close(); } catch { /* not open */ } }
    // what this run can show: papers in the library, a project in the Editor (a read-only look)
    let projects = !!$('#pj-rows .pj-card');
    if (!projects) { try { const r = await RT.api('/api/projects?lite=1'); projects = !!(r && r.projects && r.projects.length); } catch { projects = false; } }
    if (run) return; // started twice meanwhile
    const plan = buildPlan({ paper: items().length > 0, project: projects });
    if (!plan.length) return;
    let at = 0;
    if (opts.chapter != null) {
      const ci = typeof opts.chapter === 'number' ? opts.chapter - 1 : CHAPTERS.findIndex((c) => c.id === opts.chapter);
      const i = plan.findIndex((p) => p.ci === ci); if (i >= 0) at = i;
    }
    if (opts.step) { const i = plan.findIndex((p) => p.s.id === opts.step); if (i >= 0) at = i; }
    const writeWas = RT.write && RT.write.mode ? RT.write.mode() : null;
    run = { plan, at, el: null, token: 0, pending: false, claudeWas: claudeOpen(), tabWas: { id: RT.state.sel, tab: RT.reader && RT.reader.tabNow ? RT.reader.tabNow() : null }, writeWas, openedProject: false, openedPaper: null, focus: document.activeElement, timer: 0 };
    root.hidden = false;
    document.body.classList.add('touring');
    run.timer = setInterval(place, 250); // panes resize, lists load: keep the light on the control
    show(at);
  }
  function end(completed = false) {
    if (!run) return;
    const r = run; run = null;
    clearInterval(r.timer);
    root.hidden = true; root.classList.remove('tour-busy', 'tour-centred');
    document.body.classList.remove('touring');
    if (!completed && r.at < r.plan.length - 1) ls.set(DISMISSED, '1');
    setClaude(r.claudeWas);
    // the reader tab the user had (the tour only showed others)
    if (r.tabWas.tab && RT.state.sel === r.tabWas.id && RT.reader && RT.reader.tabNow && RT.reader.tabNow() !== r.tabWas.tab) { try { RT.reader.tab(r.tabWas.tab); } catch (e) { console.error(e); } }
    // no paper was open and the tour opened one to show the reader: closed again once it is off screen
    if (r.openedPaper && !r.tabWas.id && RT.state.sel === r.openedPaper && RT.state.view !== 'library' && RT.reader && RT.reader.close) { try { RT.reader.close(); } catch (e) { console.error(e); } }
    // the Editor as it was: the open project uncovered, or the projects home when the tour opened a project to show it
    if (RT.write) {
      try {
        if (RT.write.peeking && RT.write.peeking()) RT.write.peekHome(false);
        if (r.openedProject && r.writeWas !== 'project' && RT.write.mode && RT.write.mode() === 'project' && RT.write.showHome) RT.write.showHome();
      } catch (e) { console.error(e); }
    }
    const p = r.plan[r.at];
    // the listeners first (the Overview's notice re-renders and may take the button that started the tour), then the focus
    document.dispatchEvent(new CustomEvent('tour:end', { detail: { completed: !!completed, id: p ? p.s.id : null } }));
    if (!document.querySelector('dialog[open]')) {
      const back = r.focus && r.focus.isConnected && r.focus !== document.body && visible(r.focus) ? r.focus : $$('#btn-help, #btn-palette').find(visible);
      if (back && back.focus) back.focus({ preventScroll: true });
    }
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'tour-next') next();
    else if (t.id === 'tour-back') back();
    else if (t.id === 'tour-close' || t.id === 'tour-skip') end();
    else if (t.id === 'tour-chapters') toggleChapters();
    else if (t.dataset.ch && run) { const i = run.plan.findIndex((p) => p.ch.id === t.dataset.ch); if (i >= 0) show(i); }
  });
  // the keyboard belongs to the tour while it runs
  document.addEventListener('keydown', (e) => {
    if (e.repeat && e.key !== 'Tab' && (run || e.target === btn)) { e.preventDefault(); e.stopPropagation(); return; } // a held key must not race through the tour
    if (!run || e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts (reload, zoom) stay
    if (document.querySelector('dialog[open]')) { end(); return; } // a window opened meanwhile: the keyboard is its own
    const inList = !$('#tour-chlist').hidden;
    if (e.key === 'Escape') { if (inList) toggleChapters(false); else end(); }
    else if (inList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const b = $$('#tour-chlist button'), i = b.indexOf(document.activeElement);
      b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length].focus();
    } else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !(e.target.closest && e.target.closest('#tour button')))) next();
    else if (e.key === 'ArrowLeft') back();
    else if (e.key === 'Tab') { // keep the focus on the card's buttons
      const b = $$('button:not(:disabled)', cardEl).filter(visible), i = b.indexOf(document.activeElement);
      if (b.length) b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus();
    } else if (e.target.closest && e.target.closest('#tour')) return; // Enter / Space on a tour button
    e.preventDefault(); e.stopPropagation();
  }, true);
  window.addEventListener('resize', place);
  // a pane that scrolls (the Overview, the list) moves the control: follow it on the next frame
  let raf = 0;
  document.addEventListener('scroll', () => { if (run && !raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); }, true);
  if (RT.i18n && RT.i18n.onChange) RT.i18n.onChange(() => paint());
  if (RT.on) RT.on('ai:changed', () => paint()); // another provider chosen: its name, and its words for what it cannot do

  if (btn) { btn.innerHTML = RT.icon('compass'); btn.addEventListener('click', () => start()); }

  // the chapter of the view on screen ("Tour of this screen")
  // (the Library: its list chapter, also with a paper open beside it - the reader's when the focus is in the paper)
  const inPaper = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('#detail') && RT.state.sel); };
  const forChapterOfView = () => (RT.state.view === 'write' ? 'editor' : RT.state.view === 'library' ? (inPaper() ? 'reader' : 'library') : 'overview');

  // the buttons of the screen the palette can run by name (palette.js): [{ el, name }] for those on screen now
  const PALETTE = [
    ['#btn-import-pdf', 'Import PDF or .bib files'], ['#btn-view', 'Group, sort and filter the list'], ['#btn-regroup', 'Group the papers with Claude'],
    ['#btn-review', 'Review the quiz questions that are due today'], ['#btn-compare', 'Ask across papers: comparison tables and questions'],
    ['#pdf-hl', 'List the highlights of this paper'], ['#btn-figures', 'Put a figure of the paper into the note'],
    ['#btn-draft', 'Generate the first draft of the note with Claude'], ['#btn-note-menu', 'More note actions: history, export, template'],
    ['#dg-edit', 'Edit the diagram by hand'], ['#dg-insert', 'Insert the diagram into the note'], ['#rl-lookup', 'Look up the references and the citing papers'],
    ['#btn-check-meta', 'Check the metadata against the published record'], ['#btn-claude-extract', 'Extract the key points with Claude'],
    ['#pj-new', 'New project'], ['#btn-home', 'Back to the list of projects'], ['#btn-save', 'Save all files of the project'],
    ['#btn-history', 'Show the history of the project'], ['#btn-checks', 'Spelling and writing checks'], ['[data-cmd=papers]', 'Papers of this project'],
    ['[data-cmd=askai]', 'Ask Claude to rewrite the selected text'], ['[data-cmd=related]', 'Draft related work from library papers'],
    ['[data-cmd=cmptable]', 'Insert a comparison table of library papers'], ['#wc-total', 'Word count and limits'], ['#btn-compile', 'Recompile the PDF'],
    ['#sync-to-pdf', 'Show the cursor’s place in the PDF'], ['#btn-claude', 'Show or hide the Claude panel'],
  ];
  const actions = () => PALETTE.map(([sel, name]) => ({ el: find({ el: sel }), name }))
    .filter((a) => a.el && a.el.tagName === 'BUTTON' && !a.el.disabled && !a.el.closest('[hidden]'));

  Object.assign(RT.tour, {
    start, end: () => end(false), next, back, goTo, active: () => !!run, actions, steps,
    chapters: () => CHAPTERS.map((c, i) => ({ id: c.id, index: i + 1, title: c.title, palette: c.palette, view: c.view || null })),
    current: () => (run ? { id: run.plan[run.at].s.id, chapter: run.plan[run.at].ch.id, index: run.at, total: run.plan.length, found: !!run.el, pending: run.pending } : null),
    seen: () => ls.get(DONE, '') === '1' || ls.get(DISMISSED, '') === '1',
    dismiss: () => ls.set(DISMISSED, '1'),
    forChapterOfView,
  });
})();
