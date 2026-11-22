/* Overview tab: a dashboard of the library, the reading, the notes, the research lines, the Write projects and the
   workspace's health. Read-only: every card links to the place where the work is done (RT.nav and the module hooks,
   each guarded so a missing hook only makes a link do less).
   Data: RT.library.items() (no extra /api/library), RT.state.backup + 'backup:status', RT.state.status + 'status',
   RT.projectPapers (paper counts of the projects); requests, cached for 60 s: GET /api/categories (again after
   'library:refreshed'), /api/projects, /api/projects/:id/papers (the 3 most recent projects), /api/review, /api/trash,
   /api/notes/recent (fallback /api/writing/material). Never /api/status, /api/claude/auth, /api/lineage, /api/related.
   Rendered on the first show, then again (debounced) on library / project / membership / backup events while the tab
   shows; a hidden tab is only marked dirty. */
(function () {
  'use strict';
  const { $, esc, api, enc } = RT;
  const icon = (n, o) => RT.icon(n, o);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const DAY = 86400000;
  const STATUS = { unread: 'To read', reading: 'Reading', done: 'Done' };
  const statusOf = (it) => (STATUS[it.status] ? it.status : 'unread');
  const guard = (fn) => { try { const r = fn(); if (r && r.catch) r.catch((e) => console.error(e)); return r; } catch (e) { console.error(e); return undefined; } };
  const titleOf = (it) => { const t = String((it.fields && it.fields.title) || it.title || it.citekey || 'Untitled'); return RT.texPlain ? RT.texPlain(t) : t.replace(/[{}]/g, ''); }; // inline LaTeX as text (lineage.js)
  const yearOf = (it) => (it.fields && it.fields.year) || '';
  const time = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
  // "today", "yesterday", "3 days ago", else the date (the library list says it the same way)
  function ago(iso) {
    const t = time(iso); if (!t) return '';
    const day = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(Date.now()) - day(t)) / DAY);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(t).toLocaleDateString();
  }

  const view = RT.registerView({ id: 'overview', title: 'Overview', icon: 'dashboard', order: 5, onShow: show, onHide: () => { active = false; } });
  const host = view.el;
  host.innerHTML = '<div class="ov-scroll"><div class="ov" id="ov"></div></div>';
  const root = $('#ov', host);

  // ---------------- cached GETs (60 s; a failed request is not kept) ----------------
  const TTL = 60000;
  const cache = new Map(); // url -> {at, p}
  function get(url, ttl = TTL) {
    const c = cache.get(url);
    if (c && Date.now() - c.at < ttl) return c.p;
    const p = api(url).catch((e) => { cache.delete(url); throw e; });
    cache.set(url, { at: Date.now(), p });
    return p;
  }
  const drop = (prefix) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); };

  // ---------------- one pass over the library ----------------
  let libSeen = false; // the library list has loaded at least once (else an empty array means "not yet")
  function digest(items) {
    const now = Date.now(), week = now - 7 * DAY, month = now - 30 * DAY;
    const s = { total: items.length, unread: 0, reading: 0, done: 0, starred: 0, week: 0, month: 0, noPdf: 0, noBrief: 0, opened: [], added: [], tags: new Map() };
    for (const it of items) {
      const st = statusOf(it); s[st]++;
      if (it.starred) s.starred++;
      if (!it.pdf) s.noPdf++;
      if (!it.brief && it.briefStatus !== 'pending' && it.categoryStatus !== 'pending') s.noBrief++;
      const a = time(it.added);
      if (a >= week) s.week++;
      if (a >= month) s.month++;
      if (it.lastOpened && st !== 'done') s.opened.push(it);
      s.added.push(it);
      if (Array.isArray(it.tags)) for (const t of it.tags) { const k = String(t).trim(); if (k) s.tags.set(k, (s.tags.get(k) || 0) + 1); }
    }
    const top = (arr, key, n) => { const withT = arr.map((it) => [time(it[key]), it]); withT.sort((x, y) => y[0] - x[0]); return withT.slice(0, n).map((x) => x[1]); };
    s.opened = top(s.opened, 'lastOpened', 6);
    s.added = top(s.added, 'added', 6);
    s.topTags = [...s.tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
    return s;
  }
  const items = () => (RT.library && RT.library.items ? RT.library.items() || [] : []);
  const byId = () => { const m = new Map(); for (const it of items()) m.set(it.id, it); return m; };

  // ---------------- links into the rest of the app ----------------
  const go = {
    paper(id, page) { RT.nav.openPaper(id, page ? { page } : {}); },
    notes(id) { RT.nav.openPaper(id, { tab: 'notes' }); }, // core waits for the reader (item:shown) before switching tab
    library(filter) {
      RT.nav.go('library');
      if (filter && RT.library && typeof RT.library.filter === 'function') guard(() => RT.library.filter(filter));
    },
    category(name) {
      RT.nav.go('library');
      if (RT.library && typeof RT.library.focusCategory === 'function') guard(() => RT.library.focusCategory(name));
    },
    tag(tag) {
      RT.nav.go('library');
      if (RT.library && typeof RT.library.search === 'function') { guard(() => RT.library.search('#' + tag)); return; }
      const s = $('#search'); // until the Library has a search hook: put the tag in its search box
      if (s) { s.value = tag; s.dispatchEvent(new Event('input', { bubbles: true })); s.focus(); }
    },
    project(id) {
      RT.nav.go('write');
      if (RT.projectsHome && typeof RT.projectsHome.open === 'function') guard(() => RT.projectsHome.open(id));
      else if (RT.write && RT.write.openProject) guard(() => RT.write.openProject(id));
    },
    review() { if (RT.quiz && RT.quiz.review) guard(() => RT.quiz.review()); else RT.nav.review(); },
    async briefs(n) {
      const ok = await RT.confirm(`Claude writes the missing briefs of ${plural(n, 'paper')} in the background. This uses your Claude plan. Start now?`,
        { title: 'Write the missing briefs', okText: 'Write briefs', icon: 'sparkle' });
      if (ok && RT.library && RT.library.writeBriefs) await RT.library.writeBriefs(null);
    },
  };

  // ---------------- rendering ----------------
  const ACTIONS = { }; // data-ov value -> handler (one delegated listener)
  let seq = 0;
  const act = (fn) => { const k = 'a' + (++seq); ACTIONS[k] = fn; return `data-ov="${k}"`; };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ov]');
    if (!b || !root.contains(b)) return;
    const fn = ACTIONS[b.dataset.ov];
    if (fn) { e.preventDefault(); guard(fn); }
  });

  const cardHead = (id, title, ic, link) => `<div class="card-head"><span class="ov-hic">${icon(ic, { size: 18, duo: true })}</span><h2 class="card-title" id="ov-h-${id}">${esc(title)}</h2>${link || ''}</div>`;
  const headLink = (label, fn) => `<button type="button" class="ov-link" ${act(fn)}>${esc(label)}${icon('chevron-right')}</button>`;
  const skel = (n = 3) => `<div class="ov-skel" aria-hidden="true">${'<span></span>'.repeat(n)}</div>`;
  const empty = (opts) => RT.emptyState({ compact: true, ...opts });
  // a card is a section with its own body; slots that load later are filled by fill(slot, html | element)
  function fill(slot, content) {
    const el = $(`[data-slot="${slot}"]`, root);
    if (!el) return;
    if (typeof content === 'string') el.innerHTML = content; else el.replaceChildren(content);
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function render() {
    dirty = false;
    for (const k of Object.keys(ACTIONS)) delete ACTIONS[k];
    const list = items();
    const loading = !list.length && !libSeen;
    const s = digest(list);
    last = s;
    const mod = RT.modKey || '⌘';
    const summary = loading ? '' : [plural(s.total, 'paper'), s.reading ? `Reading: ${s.reading}` : '', s.week ? `Added this week: ${s.week}` : ''].filter(Boolean)
      .map((x) => `<span>${esc(x)}</span>`).join('<span class="ov-dot" aria-hidden="true">·</span>');
    root.innerHTML = `
      <div class="ov-hello">
        <span class="ov-crest">${RT.crest(40)}</span>
        <div class="ov-hello-text">
          <p class="ov-greet">${esc(greeting())}</p>
          <h1>Overview</h1>
          <p class="ov-sum">${summary}</p>
        </div>
      </div>
      <div class="ov-actions" role="group" aria-label="Quick actions">
        <button type="button" class="ov-act primary" ${act(() => RT.nav.importFiles())}><span class="ov-act-ic">${icon('import', { size: 18 })}</span><span class="ov-act-l">Import papers</span></button>
        <button type="button" class="ov-act" ${act(() => RT.nav.addById())}><span class="ov-act-ic">${icon('doi', { size: 18 })}</span><span class="ov-act-l">Add by DOI or arXiv</span></button>
        <button type="button" class="ov-act" ${act(() => RT.nav.search())} aria-keyshortcuts="${RT.isMac ? 'Meta+K' : 'Control+K'}"><span class="ov-act-ic">${icon('search', { size: 18 })}</span><span class="ov-act-l">Search</span><span class="ov-act-k">${RT.kbd([mod, 'K'])}</span></button>
        <button type="button" class="ov-act" ${act(() => RT.nav.newProject())}><span class="ov-act-ic">${icon('projects', { size: 18 })}</span><span class="ov-act-l">New project</span></button>
      </div>
      <div class="ov-tourslot" data-slot="tour"></div>
      <div class="ov-notices" data-slot="notices"></div>
      <div class="ov-grid">
        <section class="card ov-card span-8" aria-labelledby="ov-h-cont">${cardHead('cont', 'Continue reading', 'history', headLink('Show all in Library', () => go.library({ status: 'reading' })))}<div class="card-body" data-slot="continue"></div></section>
        <section class="card ov-card span-4" aria-labelledby="ov-h-stats">${cardHead('stats', 'Reading stats', 'analytics', headLink('Library', () => go.library()))}<div class="card-body" data-slot="stats"></div></section>
        <section class="card ov-card span-6" aria-labelledby="ov-h-added">${cardHead('added', 'Recently added', 'add', headLink('Show all in Library', () => go.library()))}<div class="card-body" data-slot="added"></div></section>
        <section class="card ov-card span-6" aria-labelledby="ov-h-notes"><div data-slot="notes-head">${cardHead('notes', 'Recent notes', 'note')}</div><div class="card-body" data-slot="notes">${skel()}</div></section>
        <section class="card ov-card span-6" aria-labelledby="ov-h-lines">${cardHead('lines', 'Research lines', 'grid', headLink('Show all in Library', () => go.library()))}<div class="card-body" data-slot="lines">${skel(4)}</div><div data-slot="tags"></div></section>
        <section class="card ov-card span-6" aria-labelledby="ov-h-proj">${cardHead('proj', 'Projects in the Editor', 'projects', headLink('Open the Editor', () => RT.nav.go('write')))}<div class="card-body" data-slot="projects">${skel()}</div>
          <div class="card-foot"><button type="button" class="ib has-text" ${act(() => RT.nav.newProject())}>${icon('add')}<span class="ib-text">New project</span></button></div></section>
        <section class="card ov-card span-12 ov-health" aria-labelledby="ov-h-health">${cardHead('health', 'Workspace health', 'health')}<div class="card-body" data-slot="health"></div></section>
      </div>`;
    if (loading) {
      for (const k of ['continue', 'stats', 'added']) fill(k, skel());
    } else {
      renderContinue(s); renderStats(s); renderAdded(s); renderTags(s);
    }
    renderNotices(s, null);
    renderTour();
    renderHealth();
    // what comes from the server; each card fills itself when its answer arrives
    loadNotes(); loadLines(); loadProjects(); loadReview(s); loadTrash();
  }
  let last = null;

  // ----- continue reading -----
  function progressOf(it) {
    const r = it.reading || {}, page = Number(r.page) || 0, pages = Number(it.pages) || 0;
    let frac = pages && page ? page / pages : Number(r.frac);
    if (!Number.isFinite(frac)) frac = 0;
    frac = Math.max(0, Math.min(1, frac));
    const label = page ? (pages ? `p. ${page} of ${pages}` : `p. ${page}`) : '';
    return { page, frac, label };
  }
  function renderContinue(s) {
    if (!s.opened.length) {
      fill('continue', empty({ ill: 'emptyLibrary', title: 'Nothing opened yet', text: 'Papers you open appear here.',
        actions: [{ label: 'Import papers', icon: 'import', primary: !s.total, onClick: () => RT.nav.importFiles() }] }));
      return;
    }
    fill('continue', `<ul class="ov-list ov-cont">${s.opened.map((it) => {
      const p = progressOf(it), pct = Math.round(p.frac * 100);
      return `<li><button type="button" class="ov-row" ${act(() => go.paper(it.id, p.page > 1 ? p.page : 0))}>
        <span class="ov-t" data-i18n-skip>${esc(titleOf(it))}</span>
        <span class="ov-by" data-i18n-skip>${RT.byline(RT.authorsShort(it.fields && it.fields.author), [yearOf(it)])}</span>
        <span class="ov-prog"><span class="ov-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Reading progress"><span></span></span>
          <span class="ov-meta">${esc(p.label)}</span><span class="ov-meta ov-when">${esc(ago(it.lastOpened))}</span></span>
      </button></li>`;
    }).join('')}</ul>`);
    for (const bar of root.querySelectorAll('.ov-bar')) bar.firstElementChild.style.width = bar.getAttribute('aria-valuenow') + '%';
  }

  // ----- reading stats -----
  function renderStats(s) {
    if (!s.total) {
      fill('stats', empty({ ill: 'onboardingImport', title: 'Your library is empty', text: 'Import PDFs or a .bib file, or drop them anywhere on the page.' }));
      return;
    }
    const seg = ['unread', 'reading', 'done'].map((k) => ({ k, n: s[k] })).filter((x) => x.n);
    const stat = (label, n, ic, fn, hint) => `<button type="button" class="ov-stat" ${act(fn)}${hint ? ` title="${esc(hint)}"` : ''}><span class="ov-stat-n">${n}</span><span class="ov-stat-l">${icon(ic)}<span>${esc(label)}</span></span></button>`;
    fill('stats', `
      <div class="ov-seg" role="img" aria-label="${esc(`To read ${s.unread}, Reading ${s.reading}, Done ${s.done}`)}">${seg.map((x) => `<span class="ov-s-${x.k}" data-n="${x.n}"></span>`).join('')}</div>
      <div class="ov-legend">${['unread', 'reading', 'done'].map((k) => `<button type="button" class="ov-lg ov-s-${k}" ${act(() => go.library({ status: k }))}><i aria-hidden="true"></i><span>${STATUS[k]}</span><b>${s[k]}</b></button>`).join('')}</div>
      <div class="ov-stats">
        ${stat('Starred', s.starred, 'star', () => go.library({ starred: true }))}
        ${stat('Without PDF', s.noPdf, 'pdf', () => go.library({ noPdf: true }))}
        ${stat('Added this week', s.week, 'calendar', () => go.library())}
        ${stat('Added this month', s.month, 'calendar', () => go.library())}
      </div>`);
    for (const el of root.querySelectorAll('.ov-seg > span')) el.style.flexGrow = el.dataset.n;
  }

  // ----- recently added -----
  function renderAdded(s) {
    if (!s.added.length) {
      fill('added', empty({ ill: 'emptyLibrary', title: 'No papers yet', text: 'Import PDFs, a .bib file or add a paper by its DOI or arXiv id.',
        actions: [{ label: 'Add by DOI or arXiv', icon: 'doi', onClick: () => RT.nav.addById() }] }));
      return;
    }
    fill('added', `<ul class="ov-list">${s.added.map((it) => `<li><button type="button" class="ov-row ov-row-1" ${act(() => go.paper(it.id))}>
        <span class="ov-st ov-s-${statusOf(it)}" role="img" aria-label="${STATUS[statusOf(it)]}" title="${STATUS[statusOf(it)]}"></span>
        <span class="ov-tb"><span class="ov-t one" data-i18n-skip>${esc(titleOf(it))}</span><span class="ov-by" data-i18n-skip>${RT.byline(RT.authorsShort(it.fields && it.fields.author), [yearOf(it)])}</span></span>
        <span class="ov-meta ov-when">${esc(ago(it.added))}</span></button></li>`).join('')}</ul>`);
  }

  // ----- recent notes (GET /api/notes/recent; fallback: the papers with a note, by when they were opened) -----
  async function loadNotes() {
    let rows = null, fallback = false;
    try { rows = (await get('/api/notes/recent?limit=20')).notes || []; } catch {
      try { const r = await get('/api/writing/material'); fallback = true; rows = (r.notes || []).map((id) => ({ id })); } catch { rows = null; }
    }
    if (!root.isConnected) return;
    const lib = byId();
    if (fallback) fill('notes-head', cardHead('notes', 'Papers with notes', 'note'));
    if (rows === null) { fill('notes', `<p class="ov-err">${esc('The notes could not be read.')}</p>`); return; }
    let list = rows.map((r) => ({ ...r, it: lib.get(r.id) })).filter((r) => r.it);
    if (fallback) list.sort((a, b) => time(b.it.lastOpened) - time(a.it.lastOpened));
    list = list.slice(0, 6);
    if (!list.length) {
      fill('notes', empty({ ill: 'emptyNotes', title: 'No notes yet', text: 'Open a paper and write in its Notes tab, or let Claude draft a first version.',
        actions: items().length ? [{ label: 'Continue reading', icon: 'history', onClick: () => go.library({ status: 'reading' }) }] : [] }));
      return;
    }
    fill('notes', `<ul class="ov-list">${list.map((r) => `<li><button type="button" class="ov-row ov-row-1" ${act(() => go.notes(r.id))}>
        <span class="ov-lead">${icon('note')}</span>
        <span class="ov-tb"><span class="ov-t one" data-i18n-skip>${esc(titleOf(r.it))}</span><span class="ov-by" data-i18n-skip>${RT.byline(RT.authorsShort(r.it.fields && r.it.fields.author), [yearOf(r.it)])}</span></span>
        <span class="ov-meta ov-when">${esc(r.mtime ? ago(r.mtime) : ago(r.it.lastOpened))}</span></button></li>`).join('')}</ul>`);
  }

  // ----- research lines + top tags -----
  let linesOpen = false;
  async function loadLines() {
    let r;
    try { r = await get('/api/categories'); } catch { if (root.isConnected) fill('lines', `<p class="ov-err">${esc('The research lines could not be read.')}</p>`); return; }
    if (!root.isConnected) return;
    const lines = Array.isArray(r.lines) ? r.lines.filter((l) => l && l.name) : [];
    const colorOf = new Map((r.categories || []).map((c) => [c.name, c.color]));
    const color = (name) => (RT.categories && RT.categories.color ? RT.categories.color(name) : colorOf.get(name) || 'var(--line-strong)');
    if (!lines.length) {
      fill('lines', empty({ ill: 'emptySearch', title: 'No research lines yet', text: 'Group your papers with Claude in the Library, or give them a category yourself.',
        actions: [{ label: 'Open the Library', icon: 'library', onClick: () => go.library() }] }));
      return;
    }
    const shown = linesOpen ? lines : lines.slice(0, 8);
    const sub = (l) => (l.sublines || []).slice(0, 3).map((x) => `<button type="button" class="ov-sub" ${act(() => go.category(x.name))}><span class="ov-cdot" data-c="${esc(color(x.name))}"></span><span class="ov-cn" data-i18n-skip>${esc(x.sub || x.name)}</span><span class="ov-cc">${x.count}</span></button>`).join('')
      + ((l.sublines || []).length > 3 ? `<span class="ov-more">${esc(`+${l.sublines.length - 3} more sub-lines`)}</span>` : '');
    fill('lines', `<ul class="ov-lines">${shown.map((l) => `<li>
        <button type="button" class="ov-line" ${act(() => go.category(l.name))}><span class="ov-cdot" data-c="${esc(color(l.name))}"></span><span class="ov-cn" data-i18n-skip>${esc(l.name)}</span><span class="ov-cc">${plural(l.count, 'paper')}</span></button>
        ${(l.sublines || []).length ? `<div class="ov-subs">${sub(l)}</div>` : ''}</li>`).join('')}</ul>
      ${lines.length > 8 ? `<button type="button" class="ov-link ov-all" aria-expanded="${linesOpen}" ${act(() => { linesOpen = !linesOpen; loadLines(); })}>${esc(linesOpen ? 'Show fewer' : `Show all (${lines.length})`)}${icon(linesOpen ? 'chevron-up' : 'chevron-down')}</button>` : ''}`);
    for (const d of root.querySelectorAll('.ov-cdot[data-c]')) d.style.background = d.dataset.c;
  }
  function renderTags(s) {
    if (!s.topTags.length) { fill('tags', ''); return; }
    fill('tags', `<div class="ov-tags"><div class="section-head"><span class="sh-title">Top tags</span></div><div class="ov-chips">${s.topTags.map(([t, n]) => `<button type="button" class="chip" ${act(() => go.tag(t))}><span data-i18n-skip>${esc(t)}</span><span class="ov-cc">${n}</span></button>`).join('')}</div></div>`);
  }

  // ----- projects in the Editor -----
  async function loadProjects() {
    let r;
    try { r = await get('/api/projects'); } catch { if (root.isConnected) fill('projects', `<p class="ov-err">${esc('The projects could not be read.')}</p>`); return; }
    if (!root.isConnected) return;
    const list = (r.projects || []).filter((p) => p && p.id && !p.missing).sort((a, b) => time(b.updatedAt) - time(a.updatedAt)).slice(0, 5);
    if (!list.length) {
      fill('projects', empty({ ill: 'onboardingWelcome', title: 'No projects yet', text: 'Write papers and theses in LaTeX with your library at hand.',
        actions: [{ label: 'New project', icon: 'add', primary: true, onClick: () => RT.nav.newProject() }] }));
      return;
    }
    const PP = RT.projectPapers;
    const countOf = (p) => { const x = PP && PP.project ? PP.project(p.id) : null; return x && Number.isFinite(x.papers) ? x.papers : null; };
    fill('projects', `<ul class="ov-list">${list.map((p, i) => {
      const n = countOf(p);
      return `<li><button type="button" class="ov-row ov-proj" ${act(() => go.project(p.id))}>
        <span class="ov-lead">${icon(p.overleaf ? 'overleaf-sync' : 'folder')}</span>
        <span class="ov-tb"><span class="ov-pn" data-i18n-skip>${esc(p.name || p.id)}</span>
          <span class="ov-pm">${n !== null ? `<span>${esc(plural(n, 'paper'))}</span>` : ''}${p.overleaf ? '<span class="badge info">Overleaf</span>' : ''}<span data-pc="${i}"></span></span>
          ${i < 3 ? `<span class="ov-prog" data-pbar="${i}" hidden><span class="ov-bar"><span></span></span><span class="ov-meta" data-ptext="${i}"></span></span>` : ''}</span>
        <span class="ov-meta ov-when">${esc(p.updatedAt ? `Updated ${ago(p.updatedAt)}` : '')}</span></button></li>`;
    }).join('')}</ul>`);
    // done / total and the citations of the 3 most recent projects
    list.slice(0, 3).forEach(async (p, i) => {
      let c;
      try { c = (await get(`/api/projects/${enc(p.id)}/papers`)).counts; } catch { return; }
      if (!c || !root.isConnected) return;
      const bar = $(`[data-pbar="${i}"]`, root), cited = $(`[data-pc="${i}"]`, root);
      if (cited) cited.textContent = `Cited: ${c.cited || 0}`;
      if (bar && c.total) {
        const pct = Math.round(((c.done || 0) / c.total) * 100);
        bar.hidden = false;
        const b = $('.ov-bar', bar); b.setAttribute('role', 'progressbar'); b.setAttribute('aria-valuemin', '0'); b.setAttribute('aria-valuemax', '100'); b.setAttribute('aria-valuenow', String(pct)); b.setAttribute('aria-label', 'Papers read');
        b.firstElementChild.style.width = pct + '%';
        $(`[data-ptext="${i}"]`, root).textContent = `${c.done || 0} of ${c.total} read`;
      }
    });
  }

  // ----- notices: questions due, missing briefs -----
  let due = null;
  async function loadReview(s) {
    try { const r = await get('/api/review'); due = Number(r.due) || 0; } catch { due = null; }
    if (root.isConnected) renderNotices(s, due);
  }
  function renderNotices(s, n) {
    const out = [];
    if (n) out.push(`<div class="ov-notice"><span class="ov-n-ic">${icon('quiz', { size: 18 })}</span><span class="ov-n-t">${esc(`${plural(n, 'question')} due for review today`)}</span><button type="button" class="ib has-text" ${act(() => go.review())}>${icon('play')}<span class="ib-text">Review</span></button></div>`);
    if (s.noBrief && libSeen && RT.library && RT.library.writeBriefs) out.push(`<div class="ov-notice"><span class="ov-n-ic">${icon('sparkle', { size: 18 })}</span><span class="ov-n-t">${esc(`${plural(s.noBrief, 'paper')} without a brief`)}</span><button type="button" class="ib has-text" ${act(() => go.briefs(s.noBrief))}>${icon('sparkle')}<span class="ib-text">Write briefs with Claude…</span></button></div>`);
    fill('notices', out.join(''));
  }

  // ----- the guided tour (tour.js): offered until it was finished or dismissed -----
  function renderTour() {
    if (!RT.tour || !RT.tour.start || (RT.tour.seen && RT.tour.seen())) { fill('tour', ''); return; }
    fill('tour', `<div class="ov-tour" role="note">
        <span class="ov-tour-ic">${icon('compass', { size: 22 })}</span>
        <span class="ov-tour-t"><b>New here? Take the tour</b><span>A short walk from this Overview through the Library, the reader and your notes to the Editor, about five minutes.</span></span>
        <button type="button" class="primary ib has-text" ${act(() => RT.tour.start())}>${icon('play')}<span class="ib-text">Take the tour</span></button>
        <button type="button" class="ib ghost" title="Not now (Help › Take the tour starts it later)" aria-label="Not now" ${act(() => { if (RT.tour.dismiss) RT.tour.dismiss(); renderTour(); })}>${icon('close')}</button>
      </div>`);
  }
  document.addEventListener('tour:end', () => { if (built) renderTour(); });

  // ----- workspace health -----
  let trash = null;
  async function loadTrash() {
    try { trash = await get('/api/trash'); } catch { trash = null; }
    if (root.isConnected) renderHealth();
  }
  function renderHealth() {
    const rows = [];
    const b = RT.state.backup;
    if (b) {
      const bad = b.error || b.stale;
      const text = b.error ? `The last backup failed: ${b.error.message || b.error}` : b.last ? `Last backup ${ago(b.last.when)}` : 'Your workspace has no backup yet';
      rows.push({ ic: 'archive', tone: bad ? 'warn' : 'ok', badge: bad ? 'Needs attention' : 'Up to date', text, extra: b.auto ? 'Automatic backup is on' : 'Automatic backup is off', link: 'Backup settings', fn: () => RT.nav.preferences('library') });
    } else rows.push({ ic: 'archive', tone: '', badge: '', text: 'Checking the backups…', link: 'Backup settings', fn: () => RT.nav.preferences('library') });
    if (trash) {
      const n = Number(trash.count) || 0, old = Number(trash.old) || 0;
      rows.push({ ic: 'delete', tone: old ? 'warn' : 'ok', badge: old ? `${old} older than ${trash.days || 30} days` : '', text: n ? `${plural(n, 'item')} in Recently deleted` : 'Recently deleted is empty', link: 'Recently deleted', fn: () => RT.nav.trash() });
    }
    const st = RT.state.status || {};
    if ('pdftotext' in st) {
      const miss = [!st.pdftotext && 'pdftotext (PDF import)', !st.latexmk && 'latexmk (LaTeX preview)', !st.claude && 'claude CLI (Claude panel)'].filter(Boolean);
      rows.push({ ic: 'config', tone: miss.length ? 'warn' : 'ok', badge: miss.length ? 'Missing tools' : 'Ready', text: miss.length ? 'Not found on this machine: ' + miss.join(', ') : 'PDF import, LaTeX preview and Claude are ready' });
    }
    fill('health', `<ul class="ov-health-list">${rows.map((r) => `<li class="ov-hrow">
        <span class="ov-lead">${icon(r.ic)}</span>
        <span class="ov-tb"><span class="ov-ht">${esc(r.text)}</span>${r.extra ? `<span class="ov-meta">${esc(r.extra)}</span>` : ''}</span>
        ${r.badge ? `<span class="badge ${r.tone}">${esc(r.badge)}</span>` : ''}
        ${r.link ? `<button type="button" class="ov-link" ${act(r.fn)}>${esc(r.link)}${icon('chevron-right')}</button>` : ''}</li>`).join('')}</ul>`);
  }

  // ---------------- lifecycle ----------------
  let active = false, dirty = true, built = false;
  function show() {
    active = true;
    if (dirty || !built) { built = true; render(); }
    else { loadReview(last || digest(items())); loadTrash(); } // the cached answers come back at once
  }
  const later = RT.debounce(() => { if (active) render(); else dirty = true; }, 150);
  const touch = () => { if (active) later(); else dirty = true; };
  RT.on('library:refreshed', () => { libSeen = true; drop('/api/categories'); touch(); });
  RT.on('item:updated', touch);
  RT.on('projects:changed', () => { drop('/api/projects'); touch(); });
  RT.on('memberships:changed', touch);
  RT.on('backup:status', () => { if (active && built) renderHealth(); else dirty = true; });
  RT.on('status', () => { if (active && built) renderHealth(); else dirty = true; });

  // the Claude panel: no paper is open here, so the context is only counts
  RT.claudeContext.register('overview', () => {
    const s = last || { total: 0, unread: 0, reading: 0, done: 0 };
    return { label: '· Overview', title: 'The Overview: no paper or project is open', context: { overview: { papers: s.total, toRead: s.unread, reading: s.reading, done: s.done } } };
  });

  RT.overview = { render: () => render(), show: () => RT.nav.go('overview') };
})();
