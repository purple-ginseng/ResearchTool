/* Ask across papers / comparison tables (server: lib/compare.js, routes: lib/routes/compare.js).
   One dialog (#dlg-compare) with three stages:
     list   the saved tables (open, delete) and "New"
     setup  compare in a table (columns, one per line) or ask one question; the papers (those selected in the Library,
            or the papers of a category), at most 15, with what there is to read on each and a token estimate
     table  the table: one row per paper, a cell = text + page chips that open that paper at that page; cells can be
            edited by hand (double-click), columns changed, missing cells filled, a paper asked again or left out;
            export as Markdown / CSV / LaTeX (booktabs + \cite), into the note of the open paper or the open .tex file
   The server fills the table one paper at a time and saves after each, with or without this page: the page that
   started a run reads its NDJSON stream, any other page (or this one after a reload) follows it by asking again.
   RT.compare: open() (the list, or the table that was left through a page chip), start(ids) (setup with these
   papers), show(id), ICON. */
(() => {
  const { $, $$, esc, api, toast, ls } = RT;
  RT.compare = RT.compare || {};
  const ICON = 'table'; // (an RT.icon name)
  const UNCAT = 'Uncategorized';
  const icon = (n) => RT.icon(n);
  const ib = (act, title, ic, cls = '') => `<button type="button" class="ib ${cls}" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${icon(ic)}</button>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const items = () => (RT.library && RT.library.items ? RT.library.items() : []);
  const itemOf = (id) => items().find((i) => i.id === id) || null;

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-compare" class="cmp" aria-labelledby="cmp-title">
  <div class="cmp-head"><h3 id="cmp-title"></h3><span class="spacer"></span><span id="cmp-tools"></span>${ib('close', 'Close (Esc)', 'close')}</div>
  <div id="cmp-body"></div>
</dialog>`);
  const dlg = $('#dlg-compare'), body = $('#cmp-body'), tools = $('#cmp-tools'), titleEl = $('#cmp-title');

  // S.stage 'list' | 'setup' | 'table'
  const S = { stage: 'list', tables: [], running: null, max: 15, maxCols: 8, defaults: [], pool: [], on: new Set(), sources: {}, kind: 'compare', est: null, estRun: 0,
    table: null, live: null, prog: null, note: '', poll: null, editCols: false, back: null };

  // ------------------------------------------------------------------ text of a cell
  // escaped text, $...$ handed to KaTeX (the renderer of the diagrams)
  const rich = (s) => esc(String(s || '')).split(/(\$[^$\n]{1,300}\$)/).map((p, i) => (i % 2 ? `<span class="dg-math" data-tex="${p.slice(1, -1)}">${p}</span>`
    : p.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>'))).join(''); // and the little Markdown a model uses for emphasis
  const math = (root) => { if (RT.diagram && RT.diagram.renderMath) RT.diagram.renderMath(root); };
  const chip = (itemId, page, label) => `<span class="cmp-pg" role="link" tabindex="0" data-item="${esc(itemId)}" data-page="${page}" title="Open this paper at page ${page}">${esc(label)}</span>`;
  // the overall answer: [citekey, p. 4] -> the cite key and a chip per page, for the papers of the table
  function summaryHtml(t) {
    const byKey = new Map(t.rows.filter((r) => r.citekey).map((r) => [r.citekey.toLowerCase(), r]));
    return rich(t.summary.text).replace(/\[([^\[\],;]{1,80})((?:,\s*pp?\.\s*\d+(?:\s*[,–-]\s*\d+)*)?)\]/g, (whole, key, pages) => {
      const r = byKey.get(key.trim().toLowerCase());
      if (!r) return whole;
      const nums = (pages.match(/\d+/g) || []).map(Number);
      return `<span class="cmp-ref"><span class="cmp-key" role="link" tabindex="0" data-item="${esc(r.itemId)}" title="${esc(r.title)}">${esc(r.citekey)}</span>${nums.map((n) => chip(r.itemId, n, 'p. ' + n)).join('')}</span>`;
    }).replace(/\n{2,}/g, '<br><br>');
  }

  // ------------------------------------------------------------------ dialog plumbing
  function setHead(title, html) { titleEl.textContent = title; tools.innerHTML = html || ''; }
  function openDlg() { if (!dlg.open) dlg.showModal(); }
  function closeMenu() { const m = $('.cmp-menu', dlg); if (m) m.remove(); }
  function menu(anchor, entries) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'ctx-menu cmp-menu';
    m.innerHTML = entries.map((en, i) => (en === '-' ? '<hr>' : `<button type="button" data-i="${i}" class="${en.danger ? 'danger' : ''}">${esc(en.label)}</button>`)).join('');
    dlg.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.min(r.bottom + 2, innerHeight - m.offsetHeight - 8) + 'px';
    m.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; closeMenu(); entries[Number(b.dataset.i)].run(); });
    const first = $('button', m); if (first) first.focus();
  }
  dlg.addEventListener('pointerdown', (e) => { if (!e.target.closest('.cmp-menu') && !e.target.closest('[data-act=export], [data-act=row]')) closeMenu(); });
  dlg.addEventListener('cancel', (e) => {
    if ($('.cmp-menu', dlg)) { e.preventDefault(); closeMenu(); }
    else if ($('.cmp-edit', dlg)) { e.preventDefault(); render(); }
    else if (S.editCols) { e.preventDefault(); S.editCols = false; render(); }
  });
  dlg.addEventListener('close', () => { stopPoll(); closeMenu(); S.editCols = false; });
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };

  // ------------------------------------------------------------------ list of saved tables
  async function showList() {
    S.stage = 'list'; stopPoll();
    setHead('Ask across papers', ib('new', 'New: compare papers in a table, or ask them one question', 'plus', 'primary'));
    body.innerHTML = '<div class="cmp-empty muted"><span class="spin"></span> Loading…</div>';
    openDlg();
    try {
      const r = await api('/api/compare');
      Object.assign(S, { tables: r.tables || [], running: r.running, max: r.max || 15, maxCols: r.maxCols || 8, defaults: r.defaults || [] });
    } catch (e) { if (S.stage === 'list') body.innerHTML = `<div class="cmp-empty bad">The saved tables could not be read: ${esc(e.message)}</div>`; return; }
    if (S.stage !== 'list') return;
    if (!S.tables.length) { // nothing saved yet: what it does, and where to start
      const sel = RT.library && RT.library.selection ? RT.library.selection() : [];
      body.innerHTML = '';
      body.append(RT.emptyState({ ill: 'emptyInbox', title: 'No table yet',
        text: `Select a few papers in the Library list (${RT.modKey || '⌘'}-click or Shift-click) or right-click a category, and choose Compare. Claude reads each paper once and fills a table with the method, the data, the results - or whatever columns you name - each with the pages it comes from. You can also ask all of them one question.`,
        actions: [sel.length > 1 ? { label: `Use the ${sel.length} selected papers`, icon: 'check', primary: true, onClick: () => start(sel) } : null,
          { label: 'Start with the papers of a category…', icon: 'folder', primary: sel.length < 2, onClick: () => newSetup() }] }));
      return;
    }
    body.innerHTML = `<div class="cmp-list">${S.tables.map((t) => `
      <div class="cmp-item card interactive" data-id="${esc(t.id)}" tabindex="0" role="button" aria-label="Open ${esc(t.title)}">
        <span class="cmp-item-ic">${icon(t.kind === 'ask' ? 'help' : ICON)}</span>
        <span class="cmp-item-main"><span class="cmp-item-title">${esc(t.title)}</span>
          <span class="muted cmp-item-sub">${esc([plural(t.papers, 'paper'), t.kind === 'ask' ? 'one question' : t.columns.join(', '), when(t.updated)].filter(Boolean).join(' · '))}</span></span>
        ${t.running ? '<span class="cmp-state"><span class="spin"></span> being filled</span>' : t.todo ? `<span class="cmp-state warn">${plural(t.todo, 'paper')} not filled</span>` : ''}
        ${ib('del', 'Delete this table (it goes to the trash folder of the workspace)', 'trash', 'ghost')}
      </div>`).join("")}</div>`;
  }

  // ------------------------------------------------------------------ setup
  const colsText = (cols) => cols.map((c) => (typeof c === 'string' ? c : c.hint ? `${c.name}: ${c.hint}` : c.name)).join('\n');
  const parseCols = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^([^:：]{1,80})[:：]\s*(.*)$/.exec(l); return m ? { name: m[1].trim(), hint: m[2].trim() } : { name: l, hint: '' }; });
  // the project open in the Write tab, else the working project of the Library (project-papers.js), with the ids of
  // its papers that are in the library -> {id, name, ids} | null
  async function projectPool() {
    const w = (RT.state.view === 'write' && RT.write && RT.write.currentProject && RT.write.currentProject())
      || (RT.projectPapers && RT.projectPapers.working ? RT.projectPapers.working() : null);
    if (!w || !w.id) return null;
    try { const r = await api(`/api/projects/${RT.enc(w.id)}/papers`); return { id: w.id, name: r.project.name, ids: r.papers.map((x) => x.id).filter((id) => itemOf(id)) }; } catch { return null; }
  }
  // "New" without a selection: the papers of the project, when it has some
  async function newSetup() {
    const sel = RT.library && RT.library.selection ? RT.library.selection() : [];
    if (sel.length) return showSetup(sel);
    const pj = await projectPool();
    if (pj && pj.ids.length > S.max) toast(`“${pj.name}” has ${plural(pj.ids.length, 'paper')} - the first ${S.max} are ticked.`, '');
    return showSetup(pj ? pj.ids : []);
  }
  function categories() {
    const n = new Map();
    for (const it of items()) { const c = it.category || UNCAT; n.set(c, (n.get(c) || 0) + 1); }
    return [...n].sort((a, b) => a[0].localeCompare(b[0]));
  }
  async function showSetup(ids) {
    S.stage = 'setup'; stopPoll(); S.est = null; S.sources = {};
    S.pool = (ids || []).filter((id) => itemOf(id));
    S.on = new Set(S.pool.slice(0, S.max));
    S.kind = ls.get('rt.cmp.kind') === 'ask' ? 'ask' : 'compare';
    S.back = S.back || null;
    setHead('Ask across papers', ib('list', 'Back to the saved tables', 'arrowLeft'));
    const cols = ls.get('rt.cmp.cols') || colsText(S.defaults.length ? S.defaults : ['Method', 'Action representation', 'Training data', 'Results']);
    body.innerHTML = `<div class="cmp-setup">
      <div class="seg" id="cmp-kind" role="group" aria-label="What to do"><button type="button" data-kind="compare">Compare in a table</button><button type="button" data-kind="ask">Ask one question</button></div>
      <label id="cmp-cols-l">Columns - one per line. After a colon you can say what you want there.
        <textarea id="cmp-cols" rows="5" spellcheck="false" placeholder="Method&#10;Action representation: discrete tokens, continuous, diffusion or flow&#10;Training data&#10;Results">${esc(cols)}</textarea></label>
      <label id="cmp-q-l" hidden>The question - every paper is asked on its own, then Claude writes one overall answer.
        <textarea id="cmp-q" rows="2" maxlength="500" placeholder="e.g. Which of these use a diffusion policy, and with what action horizon?">${esc(ls.get('rt.cmp.q') || '')}</textarea></label>
      <div class="cmp-opts">
        <label>Answer in <select id="cmp-lang"><option value="en">English</option><option value="zh">中文</option></select></label>
        <span class="spacer"></span>
        <select id="cmp-cat" aria-label="Add the papers of a category"><option value="">Add the papers of a category…</option>${categories().map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`).join('')}</select>
      </div>
      <div id="cmp-papers" class="cmp-papers" role="group" aria-label="Papers"></div>
      <div class="cmp-foot"><span id="cmp-count"></span><span class="spacer"></span><span id="cmp-est" class="muted" aria-live="polite"></span>
        <button type="button" class="primary ib" data-act="go" title="Ask Claude: one call per paper" aria-label="Ask Claude">${icon('sparkle')}</button></div>
    </div>`;
    $('#cmp-lang').value = ls.get('rt.cmp.lang') === 'zh' ? 'zh' : 'en';
    paintKind(); paintPapers(); estimate();
    openDlg();
    projectPool().then((pj) => { // offer the papers of the project too
      const sel = $('#cmp-cat'); if (!pj || !pj.ids.length || !sel || S.stage !== 'setup') return;
      S.project = pj;
      sel.options[0].insertAdjacentHTML('afterend', `<option value="@project">The papers of “${esc(pj.name)}” (${pj.ids.length})</option>`);
    });
    (S.kind === 'ask' ? $('#cmp-q') : $('#cmp-cols')).focus();
  }
  function paintKind() {
    for (const b of $$('#cmp-kind button')) b.classList.toggle('on', b.dataset.kind === S.kind);
    $('#cmp-cols-l').hidden = S.kind !== 'compare'; $('#cmp-q-l').hidden = S.kind !== 'ask';
  }
  const SRC = { pdf: 'PDF', note: 'note only', thin: 'brief only', none: 'nothing to read' };
  function guessSource(it) { return it.pdf ? 'pdf' : (it.keypoints || []).length ? 'note' : it.brief || (it.fields && it.fields.abstract) ? 'thin' : ''; }
  function paintPapers() {
    const host = $('#cmp-papers'); if (!host) return;
    host.innerHTML = S.pool.map((id) => {
      const it = itemOf(id); if (!it) return '';
      const f = it.fields || {}, src = S.sources[id] || guessSource(it), none = src === 'none';
      return `<label class="cmp-paper${none ? ' off' : ''}" title="${esc(f.title || '')}"><input type="checkbox" data-id="${esc(id)}"${S.on.has(id) && !none ? ' checked' : ''}${none ? ' disabled' : ''}>
        <span class="cmp-paper-main"><span class="cmp-paper-title">${esc((RT.texPlain ? RT.texPlain(f.title || '') : f.title) || it.citekey || 'Untitled')}</span><span class="muted cmp-paper-sub">${RT.byline(RT.authorsShort(f.author), [f.year, it.category && it.category !== UNCAT ? it.category : ''])}</span></span>
        <span class="cmp-src${none ? ' bad' : ''}">${esc(SRC[src] || '')}</span></label>`;
    }).join('') || '<div class="cmp-empty muted">No paper chosen yet. Add the papers of a category above - or close this window, select papers in the Library list and choose Compare.</div>';
    paintCount();
  }
  function paintCount() {
    const el = $('#cmp-count'); if (!el) return;
    const n = S.on.size, over = n > S.max;
    el.textContent = over ? `${n} chosen - at most ${S.max} for one table` : n ? `${plural(n, 'paper')} chosen` : 'Tick the papers to ask';
    el.classList.toggle('bad', over);
    $('[data-act=go]', body).disabled = !n || over;
  }
  const setupBody = () => ({ ids: S.pool.filter((id) => S.on.has(id)), kind: S.kind, columns: parseCols($('#cmp-cols').value), question: $('#cmp-q').value.trim(), language: $('#cmp-lang').value });
  const MODE = { economy: 'Economy', balanced: 'Balanced', quality: 'Best quality' };
  const estimate = RT.debounce(async () => {
    const el = $('#cmp-est'); if (!el || S.stage !== 'setup') return;
    const b = setupBody(), run = ++S.estRun;
    if (!b.ids.length || b.ids.length > S.max) { el.textContent = ''; return; }
    el.innerHTML = '<span class="spin"></span> Estimating…';
    try {
      const r = await api('/api/compare/estimate', { method: 'POST', json: b });
      if (run !== S.estRun || S.stage !== 'setup') return;
      let changed = false;
      for (const p of r.papers) { if (S.sources[p.id] !== p.source) { S.sources[p.id] = p.source; changed = true; } if (p.source === 'none') S.on.delete(p.id); }
      if (changed) paintPapers();
      const round = (n) => (n >= 10000 ? Math.round(n / 1000) + ',000' : String(Math.round(n / 100) * 100));
      el.textContent = r.calls ? `About ${round(r.tokensIn + r.tokensOut)} tokens in ${plural(r.calls, 'call')} · Claude usage: ${MODE[r.mode] || r.mode}` : 'None of these papers has anything to read.';
      el.title = 'An estimate of what is sent and written. Each paper is one small call: its brief, your note and key points, and the passages of the PDF that match the columns - never the whole PDF. The amount of text per paper follows “Claude usage” in Preferences › AI.';
    } catch (e) { if (run === S.estRun && el.isConnected) el.textContent = 'No estimate: ' + e.message; }
  }, 500);

  // ------------------------------------------------------------------ running a table
  const tableUrl = (id, rest = '') => `/api/compare/${RT.enc(id)}${rest}`;
  const shown = (id) => dlg.open && S.stage === 'table' && S.table && S.table.id === id;
  function stopPoll() { clearInterval(S.poll); S.poll = null; }
  // follow a run this page does not hold the stream of (after a reload, or started in another window)
  function follow(id) {
    stopPoll();
    S.poll = setInterval(async () => {
      if (!shown(id)) return stopPoll();
      try {
        const r = await api(tableUrl(id));
        if (!shown(id) || S.live === id) return;
        S.table = r.table; S.prog = null;
        if (!r.running) stopPoll();
        if (!$('.cmp-edit', dlg)) render();
      } catch { /* the next round tries again */ }
    }, 1500);
  }
  // POST and read the NDJSON answer: table, row ..., done | error
  async function stream(url, json) {
    let id = null, done = false, error = '';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(json || {}) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Request failed (${r.status})`); }
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
          if (ev.type === 'table') {
            id = ev.table.id; S.live = id; S.note = '';
            if (S.starting || (S.table && S.table.id === id)) { S.table = ev.table; S.stage = 'table'; S.starting = false; S.editCols = false; S.prog = null; }
          } else if (ev.type === 'row' && S.table && S.table.id === id) {
            const i = S.table.rows.findIndex((x) => x.itemId === ev.row.itemId);
            if (i >= 0) S.table.rows[i] = ev.row;
            S.prog = { done: ev.done, total: ev.total };
          } else if (ev.type === 'status') S.note = ev.text;
          else if (ev.type === 'done') { done = true; if (S.table && S.table.id === id) S.table = ev.table; finished(ev.table); }
          else if (ev.type === 'error') error = ev.text;
          if (shown(id) && !$('.cmp-edit', dlg)) render();
        }
      }
    } catch (e) { error = error || e.message; }
    S.starting = false;
    if (S.live === id) S.live = null;
    S.note = '';
    if (error) toast(error, 'bad');
    if (!id) { if (S.stage === 'setup') paintCount(); else if (S.stage === 'table' && S.table && dlg.open) show(S.table.id); return; } // refused: show what the server has
    if (!done && shown(id)) { // the connection went away, the server works on: ask it where things stand
      try { const r = await api(tableUrl(id)); S.table = r.table; if (r.running) follow(id); } catch { /* keep what is shown */ }
      render();
    } else if (shown(id)) render();
  }
  function finished(t) {
    const failed = t.rows.filter((r) => r.state === 'failed').length;
    const msg = t.status === 'stopped' ? `Stopped - “${t.title}” keeps what was filled.` : failed ? `“${t.title}” is filled, ${plural(failed, 'paper')} could not be read.` : `“${t.title}” is filled.`;
    if (shown(t.id)) toast(msg, failed || t.status === 'stopped' ? '' : 'ok');
    else toast(msg, failed ? '' : 'ok', { label: 'Open the table', icon: 'open', run: () => show(t.id) });
  }
  async function go() {
    const b = setupBody();
    if (b.kind === 'ask' && !b.question) { toast('Type the question to ask.', 'bad'); $('#cmp-q').focus(); return; }
    if (b.kind === 'compare' && !b.columns.length) { toast('Name at least one column.', 'bad'); $('#cmp-cols').focus(); return; }
    if (b.kind === 'compare' && b.columns.length > S.maxCols) { toast(`A table can have at most ${S.maxCols} columns.`, 'bad'); return; }
    ls.set('rt.cmp.kind', b.kind); ls.set('rt.cmp.lang', b.language);
    if (b.kind === 'compare') ls.set('rt.cmp.cols', $('#cmp-cols').value.trim()); else ls.set('rt.cmp.q', b.question);
    const btn = $('[data-act=go]', body);
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    S.starting = true;
    await stream('/api/compare', b);
    if (S.stage === 'setup' && btn.isConnected) { btn.innerHTML = icon('sparkle'); paintCount(); }
  }
  async function show(id) {
    S.stage = 'table'; S.editCols = false; stopPoll();
    if (!S.table || S.table.id !== id) { S.table = null; setHead('Ask across papers', ib('list', 'Back to the saved tables', 'arrowLeft')); body.innerHTML = '<div class="cmp-empty muted"><span class="spin"></span> Loading…</div>'; }
    openDlg();
    try {
      const r = await api(tableUrl(id));
      if (S.stage !== 'table') return;
      if (S.live !== id) { S.table = r.table; S.prog = null; if (r.running) follow(id); }
      render();
    } catch (e) { if (S.stage === 'table') { S.table = null; body.innerHTML = `<div class="cmp-empty bad">${esc(e.message)}</div>`; } }
  }

  // ------------------------------------------------------------------ the table
  const busy = (t) => t.status === 'running';
  const missing = (t, r) => t.columns.some((c) => !r.cells || !r.cells[c.id]);
  function render() {
    if (S.stage !== 'table' || !S.table) return;
    const t = S.table, run = busy(t), todo = t.rows.filter((r) => missing(t, r)).length, failed = t.rows.filter((r) => r.state === 'failed').length;
    // a question whose overall answer was not written (stopped, or that one call failed) can still get it
    const noSummary = t.kind === 'ask' && !todo && !(t.summary && t.summary.text) && t.rows.filter((r) => r.cells && r.cells.c1 && r.cells.c1.text).length > 1;
    const keep = $('.cmp-scroll', body), sx = keep ? keep.scrollLeft : 0, sy = keep ? keep.scrollTop : 0;
    setHead(t.title, [
      ib('list', 'Back to the saved tables', 'arrowLeft'),
      run ? ib('stop', 'Stop: keep what is filled so far', 'stop') : '',
      !run && noSummary ? ib('fill', 'Write the overall answer with Claude (one call, from the answers below)', 'sparkle', 'primary') : '',
      !run && todo ? ib('fill', `Fill the ${todo === t.rows.length ? '' : 'missing '}cells with Claude (${plural(todo, 'paper')})`, 'sparkle', 'primary') : '',
      !run ? ib('rename', 'Rename the table', 'pencil') : '',
      !run && t.kind === 'compare' ? ib('cols', 'Change the columns', 'table') : '',
      ib('export', 'Export or insert: Markdown, CSV, LaTeX', 'download'),
      !run ? ib('delete', 'Delete this table', 'trash') : '',
    ].join(''));
    const p = S.prog;
    const status = run ? `<span class="spin"></span> ${esc(S.note || (p && p.total ? `Claude is reading the papers: ${p.done} of ${p.total} done…` : 'Claude is reading the papers…'))} <span class="muted">You can close this window; the table is saved as it fills.</span>`
      : [plural(t.rows.length, 'paper'), t.kind === 'ask' ? '' : plural(t.columns.length, 'column'), when(t.updated),
        failed ? `<span class="bad">${plural(failed, 'paper')} could not be read</span>` : '', noSummary ? '<span class="warn">the overall answer is not written yet</span>' : '', todo - failed > 0 ? `<span class="warn">${plural(todo - failed, 'paper')} not filled yet</span>` : ''].filter(Boolean).join(' · ');
    const cell = (r, c) => {
      const x = r.cells && r.cells[c.id];
      if (!x) return `<td class="cmp-wait"${run ? '' : ` data-col="${esc(c.id)}" title="Not filled yet - double-click to type it yourself"`}>${r.state === 'running' ? '<span class="spin"></span>' : r.state === 'failed' ? '' : '<span class="muted">…</span>'}</td>`;
      return `<td data-col="${esc(c.id)}"${run ? '' : ' title="Double-click to edit"'}>${x.text ? `${rich(x.text)} ${(x.pages || []).map((n) => chip(r.itemId, n, 'p. ' + n)).join('')}` : '<span class="muted cmp-none">not stated</span>'}</td>`;
    };
    const row = (r) => `<tr data-item="${esc(r.itemId)}" class="${r.state === 'failed' ? 'failed' : ''}">
      <th scope="row"><span class="cmp-key" role="link" tabindex="0" data-item="${esc(r.itemId)}" title="Open this paper">${esc(r.title)}</span>
        <span class="muted cmp-paper-sub">${RT.byline(RT.authorsShort(r.author), [r.year])}${r.source && r.source !== 'pdf' ? ` · <span title="Claude had no PDF text for this paper">from the ${r.source === 'note' ? 'note' : 'brief'} only</span>` : ''}</span>
        ${r.state === 'failed' ? `<span class="bad cmp-err">${esc(r.error || 'Could not be read.')}</span>` : ''}
        ${run ? '' : `<button type="button" class="ib ghost mini cmp-rowbtn" data-act="row" title="This paper: ask again, or leave it out" aria-label="More for this paper">${icon('more')}</button>`}</th>
      ${t.columns.map((c) => cell(r, c)).join('')}</tr>`;
    body.innerHTML = `<div class="cmp-view">
      <div class="cmp-status" role="status">${status}</div>
      ${t.kind === 'ask' ? `<div class="cmp-question"><b>Question</b> ${esc(t.question)}</div>` : ''}
      ${t.summary && t.summary.text ? `<div class="cmp-summary">${summaryHtml(t)}</div>` : ''}
      ${S.editCols ? `<div class="cmp-coledit"><label>Columns - one per line, with what you want there after a colon. A column you remove or rename loses its cells; new columns are empty until you press the sparkle.
        <textarea id="cmp-cols2" rows="${Math.min(8, t.columns.length + 1)}" spellcheck="false">${esc(colsText(t.columns))}</textarea></label>
        <div class="dlg-actions">${ib('cols-cancel', 'Cancel', 'close')}${ib('cols-save', 'Save the columns', 'check', 'primary')}</div></div>` : ''}
      <div class="cmp-scroll"><table class="cmp-table${t.kind === 'ask' ? ' ask' : ''}"><thead><tr><th scope="col">Paper</th>${t.columns.map((c) => `<th scope="col"${c.hint ? ` title="${esc(c.hint)}"` : ''}>${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>${t.rows.map(row).join('')}</tbody></table></div>
    </div>`;
    const sc = $('.cmp-scroll', body); sc.scrollLeft = sx; sc.scrollTop = sy;
    math(body);
    if (S.editCols) $('#cmp-cols2').focus();
  }

  async function put(patch, okMsg) {
    try { const r = await api(tableUrl(S.table.id), { method: 'PUT', json: patch }); S.table = r.table; if (okMsg) toast(okMsg, 'ok'); render(); return true; }
    catch (e) { toast(e.message, 'bad'); return false; }
  }
  function editCell(td) {
    const t = S.table, tr = td.closest('tr[data-item]');
    if (!t || busy(t) || !tr || $('.cmp-edit', dlg)) return;
    const r = t.rows.find((x) => x.itemId === tr.dataset.item), x = r && r.cells && r.cells[td.dataset.col];
    if (!r) return;
    const old = x ? x.text : '';
    td.innerHTML = `<textarea class="cmp-edit" rows="${Math.max(3, Math.ceil(old.length / 38))}" aria-label="Text of the cell" title="Enter saves, Esc cancels. Leave it empty for “not stated”.">${esc(old)}</textarea>`;
    const ta = $('textarea', td);
    let over = false;
    const end = async (save) => {
      if (over) return; over = true;
      const text = ta.value.replace(/\s+/g, ' ').trim();
      if (!save || text === old) return render();
      if (!(await put({ cell: { itemId: r.itemId, col: td.dataset.col, text } }))) render();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); end(true); }
      else if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); end(false); }
    });
    ta.addEventListener('blur', () => end(true));
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  const fill = (json) => { if (S.table) { S.table.status = 'running'; S.prog = null; render(); stream(tableUrl(S.table.id, '/fill'), json || {}); } };
  function rowMenu(btn) {
    const tr = btn.closest('tr[data-item]'), t = S.table, r = t && t.rows.find((x) => x.itemId === tr.dataset.item);
    if (!r) return;
    menu(btn, [
      { label: 'Ask Claude again for this paper', run: () => fill({ rows: [r.itemId] }) },
      { label: 'Open this paper', run: () => jump(r.itemId, null) },
      '-',
      { label: 'Leave this paper out of the table', danger: true, run: async () => {
        if (t.rows.length === 1) return toast('A table needs at least one paper - delete the table instead.', 'bad');
        if (await RT.confirm(`Leave “${r.title}” out of this table? Its row is removed.`, { title: 'Leave the paper out', okText: 'Remove the row', danger: true })) put({ removeRow: r.itemId });
      } },
    ]);
  }
  // open a paper of the table (at a page): the window closes, "Ask across papers" opens it again where it was
  function jump(itemId, page) {
    if (!itemOf(itemId)) return toast('This paper is not in the library any more.', 'bad');
    S.back = S.table ? S.table.id : null;
    dlg.close();
    if (page && RT.reader && RT.reader.reveal && itemOf(itemId).pdf) RT.reader.reveal(itemId, { kind: 'pdf', page });
    else { RT.setView('library'); if (RT.library && RT.library.select) RT.library.select(itemId); if (page) toast('This paper has no PDF attached.', ''); }
    if (S.back) toast('The table is behind the table button of the Library list.', '', { label: 'Back to the table', icon: 'undo', run: () => show(S.back) });
  }

  // ------------------------------------------------------------------ export
  async function exported(format) { return api(tableUrl(S.table.id, `/export?format=${format}`)); }
  async function copy(format, what) {
    try { const r = await exported(format); await navigator.clipboard.writeText(r.text); toast(`Copied as ${what}`, 'ok'); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Could not copy to the clipboard' : e.message, 'bad'); }
  }
  function download(format) { const a = document.createElement('a'); a.href = tableUrl(S.table.id, `/export?format=${format}&download=1`); a.download = ''; dlg.append(a); a.click(); a.remove(); }
  async function toNote() {
    const it = RT.reader && RT.reader.current && RT.reader.current();
    if (!it) return toast('Open the paper whose note should get the table first.', 'bad');
    try {
      const r = await exported('md');
      dlg.close(); RT.setView('library');
      RT.reader.insert('\n' + r.text + '\n');
      toast('The table was added to the note of the open paper.', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  const texBuf = () => { const e = RT.write && RT.write.ed; const b = RT.state.view === 'write' && e && e.cm && e.ok() ? e.activeBuf() : null; return b && b.kind === 'text' && /\.tex$/i.test(b.path || '') ? b : null; };
  async function toLatex() {
    const b = texBuf();
    if (!b) return toast('Open a .tex file of a project in the Write tab first, and put the cursor where the table should go.', 'bad');
    try {
      const r = await exported('tex');
      dlg.close();
      let pkg = false; // the rules of the table come from booktabs: load it when this file has the preamble and lacks it
      // (a table the app exports from cells that may have been edited by hand: a labelled save, not an AI version)
      const ok = await RT.write.ed.applyClaude(b, () => {
        const cm = RT.write.ed.cm;
        RT.write.ed.insertBlock(r.text.replace(/\n+$/, '').split('\n').filter((l) => !/^% .*booktabs/.test(l)));
        const lines = cm.getValue().split('\n'), begin = lines.findIndex((l) => /^[^%]*\\begin\{document\}/.test(l));
        const pre = lines.slice(0, begin < 0 ? 0 : begin);
        if (!pre.some((l) => /^[^%]*\\documentclass/.test(l))) return;
        if (pre.some((l) => /^[^%]*\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bbooktabs\b/.test(l))) { pkg = true; return; }
        let at = -1;
        pre.forEach((l, i) => { if (/^[^%]*\\(?:usepackage|documentclass)\b/.test(l)) at = i; });
        const cur = cm.getCursor();
        cm.replaceRange('\\usepackage{booktabs}\n', { line: at + 1, ch: 0 });
        cm.setCursor(cur.line + 1, cur.ch);
        pkg = true;
      }, { source: 'manual', label: 'Comparison table inserted' });
      if (ok) toast(pkg ? `The table was inserted into ${b.path}.` : `The table was inserted into ${b.path}. It needs \\usepackage{booktabs} in the preamble of the main file.`, 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  function exportMenu(btn) {
    const it = RT.reader && RT.reader.current && RT.reader.current(), b = texBuf();
    menu(btn, [
      { label: 'Copy as Markdown', run: () => copy('md', 'Markdown') },
      { label: 'Copy as LaTeX (booktabs table with \\cite)', run: () => copy('tex', 'LaTeX') },
      '-',
      ...(it ? [{ label: `Add to the note of “${String((it.fields && it.fields.title) || it.citekey).slice(0, 46)}”`, run: toNote }] : []),
      ...(b ? [{ label: `Insert into ${b.path} at the cursor`, run: toLatex }] : []),
      ...(it || b ? ['-'] : []),
      { label: 'Download as Markdown (.md)', run: () => download('md') },
      { label: 'Download as CSV (.csv)', run: () => download('csv') },
      { label: 'Download as LaTeX (.tex)', run: () => download('tex') },
    ]);
  }

  // ------------------------------------------------------------------ events
  dlg.addEventListener('click', async (e) => {
    const pg = e.target.closest('.cmp-pg'), key = e.target.closest('.cmp-key');
    if (pg) return jump(pg.dataset.item, Number(pg.dataset.page));
    if (key) return jump(key.dataset.item, null);
    const kind = e.target.closest('#cmp-kind button');
    if (kind) { S.kind = kind.dataset.kind; paintKind(); estimate(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) { const it = e.target.closest('.cmp-item'); if (it) show(it.dataset.id); return; }
    const act = b.dataset.act, t = S.table;
    if (act === 'close') dlg.close();
    else if (act === 'list') showList();
    else if (act === 'new') newSetup();
    else if (act === 'go') go();
    else if (act === 'del') {
      e.stopPropagation();
      const row = b.closest('.cmp-item'), x = S.tables.find((y) => y.id === row.dataset.id);
      if (!(await RT.confirm(`Delete the table “${x ? x.title : ''}”? It is moved to the trash folder of the workspace.`, { title: 'Delete the table', okText: 'Delete', danger: true }))) return;
      try { await api(tableUrl(row.dataset.id), { method: 'DELETE' }); if (S.table && S.table.id === row.dataset.id) S.table = null; showList(); } catch (err) { toast(err.message, 'bad'); }
    } else if (!t) return;
    else if (act === 'stop') { try { await api(tableUrl(t.id, '/stop'), { method: 'POST', json: {} }); } catch (err) { toast(err.message, 'bad'); } }
    else if (act === 'fill') fill({});
    else if (act === 'rename') { const name = await RT.ask({ title: 'Rename the table', value: t.title, okText: 'Rename' }); if (name && name.trim() && name.trim() !== t.title) put({ title: name.trim() }); }
    else if (act === 'cols') { S.editCols = !S.editCols; render(); }
    else if (act === 'cols-cancel') { S.editCols = false; render(); }
    else if (act === 'cols-save') {
      const cols = parseCols($('#cmp-cols2').value);
      if (!cols.length) return toast('Name at least one column.', 'bad');
      S.editCols = false;
      if (await put({ columns: cols })) { if (S.table.rows.some((r) => missing(S.table, r))) toast('The columns are saved. Press the sparkle to fill the new ones.', 'ok'); } else { S.editCols = true; render(); }
    } else if (act === 'export') exportMenu(b);
    else if (act === 'row') rowMenu(b);
    else if (act === 'delete') {
      if (!(await RT.confirm(`Delete the table “${t.title}”? It is moved to the trash folder of the workspace.`, { title: 'Delete the table', okText: 'Delete', danger: true }))) return;
      try { await api(tableUrl(t.id), { method: 'DELETE' }); S.table = null; showList(); } catch (err) { toast(err.message, 'bad'); }
    }
  });
  dlg.addEventListener('dblclick', (e) => { const td = e.target.closest('.cmp-table td[data-col]'); if (td && !e.target.closest('.cmp-pg')) editCell(td); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest ? e.target.closest('.cmp-pg, .cmp-key, .cmp-item') : null;
    if (!el || e.target !== el) return;
    e.preventDefault(); el.click();
  });
  dlg.addEventListener('change', (e) => {
    const c = e.target.closest('#cmp-papers input[data-id]');
    if (c) { if (c.checked) S.on.add(c.dataset.id); else S.on.delete(c.dataset.id); paintCount(); estimate(); return; }
    if (e.target.id === 'cmp-cat' && e.target.value) {
      const add = (e.target.value === '@project' && S.project ? S.project.ids : items().filter((i) => (i.category || UNCAT) === e.target.value).map((i) => i.id)).filter((id) => !S.pool.includes(id));
      for (const id of add) { S.pool.push(id); if (S.on.size < S.max) S.on.add(id); }
      if (add.length && S.on.size >= S.max && add.some((id) => !S.on.has(id))) toast(`At most ${S.max} papers go into one table - the first ${S.max} are ticked.`, '');
      e.target.value = ''; paintPapers(); estimate();
    }
  });
  dlg.addEventListener('input', (e) => { if (e.target.id === 'cmp-cols' || e.target.id === 'cmp-q') estimate(); });

  // ------------------------------------------------------------------ entry points
  function open() { if (S.back && S.table && S.table.id === S.back) { const id = S.back; S.back = null; return show(id); } S.back = null; return showList(); }
  async function start(ids) {
    const list = (ids || []).filter((id) => itemOf(id));
    if (!S.defaults.length) { try { const r = await api('/api/compare'); Object.assign(S, { max: r.max || 15, maxCols: r.maxCols || 8, defaults: r.defaults || [] }); } catch { /* the built-in defaults do */ } }
    if (list.length > S.max) toast(`At most ${S.max} papers go into one table - the first ${S.max} are ticked.`, '');
    S.back = null;
    showSetup(list);
  }
  // the Library toolbar: first in its Explore group (RT.library.toolbarSlot), else before #btn-trash as before
  const slot = RT.library && RT.library.toolbarSlot ? RT.library.toolbarSlot('explore') : null, before = $('#btn-trash');
  if (slot || before) {
    const html = `<button id="btn-compare" class="ib" title="Ask across papers: compare the selected papers in a table or ask them one question - and the tables you saved" aria-label="Ask across papers and comparison tables">${icon(ICON)}</button>`;
    if (slot) slot.insertAdjacentHTML('afterbegin', html); else before.insertAdjacentHTML('beforebegin', html);
    $('#btn-compare').addEventListener('click', () => { const sel = RT.library && RT.library.selection ? RT.library.selection() : []; if (sel.length > 1) start(sel); else open(); });
  }
  Object.assign(RT.compare, { open, start, show, ICON });
})();
