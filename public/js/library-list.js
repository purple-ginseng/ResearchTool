/* Library tab, left pane (#library-list): import queue (PDFs, folders, .bib; a .md file opens "Organize from a file", organize.js), search (titles and details, or - with
   the switch in the search box - the text of every PDF, note and key point: GET /api/search, the matching passages
   are listed under each paper and open it at that page, note line or key point), the list grouped by
   category (a research line "Line / Sub-line" nests its sub-lines under the line) / year / reading status / verified venue (see "venues" below), tag and status filter, a "Continue reading" group of the papers opened last,
   multi-select with bulk actions, drag onto a category header, keyboard (rows take the focus: Up / Down, Enter,
   Shift+Up / Down, Space, Delete - see "keyboard" below; J / K and "/" come from palette.js). A row shows the paper's brief (item.brief, written by
   Claude when the paper is grouped) under its title.
   Papers of a project (RT.projectPapers, project-papers.js): the bookmark button of a row and the menus add a paper to the
   working project, the "Project" chip above the list switches it (rows dropped on it are added), a pinned group lists
   the papers of the working project with their progress, and the View menu groups / filters by project.
   Owns the in-memory list of items: RT.library.items() / refresh(). Emits 'item:open' {id} when a reference is opened,
   'library:changed' after it changed items on the server, 'item:categorized' {id} when Claude's grouping of an item arrived.
   Dialogs and menus come from categories.js (RT.categories), which loads after this file: only used at event time. */
(() => {
  const { $, $$, esc, api, toast, authorsShort, ls, enc } = RT;
  RT.library = RT.library || {};
  const PP = RT.projectPapers;

  const UNCAT = 'Uncategorized';
  const C = () => RT.categories || {};
  const color = (name) => (C().color ? C().color(name) : '#9aa0a6');
  const catOf = (it) => it.category || UNCAT;
  // a row's title as text: inline LaTeX ("$π_0$") as "π₀" (RT.texPlain, lineage.js; the list draws after it loaded)
  const showTitle = (i) => (RT.texPlain ? RT.texPlain(i.fields.title || '') : i.fields.title) || '(untitled)';
  const tagsOf = (it) => (Array.isArray(it.tags) ? it.tags : []);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // reading status of a paper: 'unread' (shown as "To read", also when nothing is stored) | 'reading' | 'done'
  const STATUS = { unread: 'To read', reading: 'Reading', done: 'Done' };
  const STATUS_ORDER = ['reading', 'unread', 'done'];
  const statusOf = (it) => (STATUS[it.status] ? it.status : 'unread');
  const RECENT_MAX = 5;
  function ago(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const day = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(Date.now()) - day(t)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(t).toLocaleDateString();
  }
  // "p. 7 of 20": where the PDF was left (nothing for a paper still on its first page)
  const progress = (it) => (it.reading && it.reading.page > 1 ? `p. ${Number(it.reading.page)}${it.pages ? ' of ' + Number(it.pages) : ''}` : '');

  const host = $('#library-list');
  // Toolbar (labelled groups): the search box with the full-text chip and the project chip; then Add (Import, Add by
  // ID), View (group / sort menu), Explore (#ll-slot-explore: compare.js, lineage.js and quiz.js put their buttons
  // there, before the hidden #btn-trash they used to anchor on; Group with Claude last) and the overflow menu (expand /
  // collapse all, Recently deleted, venue check, missing briefs). Under it, the filter chips (rt.lib.show).
  // .list-pane is an inline-size container: the labels fold away when the pane is narrow.
  host.innerHTML = `
      <div class="search-row">
        <div class="search-box">${RT.icon('search', 'sb-ic')}<input type="search" id="search" placeholder="Search title, author, tag…" title="Search title, author, key, tag or category" aria-label="Search the library"><button type="button" id="search-clear" class="ib sb-btn" title="Clear the search" aria-label="Clear the search" hidden>${RT.icon('close')}</button><button type="button" id="search-all" class="sb-btn sb-keys" title="Search everywhere (${RT.modKey || '⌘'}K): papers, notes and every action" aria-label="Search everywhere">${RT.kbd ? RT.kbd([RT.modKey || '⌘', 'K']) : '⌘K'}</button></div>
        <button id="search-scope" class="chip" aria-pressed="false">${RT.icon('audit')}<span class="ib-text">Full text</span></button>
      </div>
      <div class="proj-row"><button id="proj-chip" class="proj-chip" aria-haspopup="true"></button></div>
      <div id="search-info" class="muted" role="status" hidden></div>
      <div class="list-opts">
        <div class="tgroup" role="group" aria-label="Add papers">
          <button id="btn-import-pdf" class="primary ib has-text keep-text" title="Import PDF or .bib files, or organize the library from a .md reading list (you can also drop PDFs, folders, .bib or .md files anywhere on the page)" aria-label="Import PDF or .bib files, or organize from a .md file">${RT.icon('import')}<span class="ib-text">Import</span></button>
          <button id="btn-paste-bib" class="ib has-text" title="Add by arXiv id, DOI or link, or paste BibTeX (⌘V anywhere in the Library does the same)" aria-label="Add by arXiv id, DOI, link or BibTeX">${RT.icon('doi')}<span class="ib-text">Add by ID</span></button>
          <input type="file" id="file-pdf" accept="application/pdf,.pdf,.bib,.bibtex,.md,.markdown" multiple hidden>
        </div>
        <div class="tgroup" role="group" aria-label="View">
          <button id="btn-view" class="ib has-text keep-text" title="Group and sort the list" aria-label="Group and sort the list" aria-haspopup="menu" aria-expanded="false">${RT.icon('filter')}<span class="ib-text" id="view-label">Category</span>${RT.icon('chevron-down', 'ib-caret')}</button>
        </div>
        <div class="tgroup" role="group" aria-label="Explore" id="ll-slot-explore">
          <button id="btn-trash" class="ib" hidden title="Recently deleted: put a deleted paper back, or empty the trash" aria-label="Recently deleted">${RT.icon('trash')}</button>
          <button id="btn-regroup" class="ib" title="Group with Claude: let Claude propose categories for your papers" aria-label="Group with Claude">${RT.icon('sparkle')}</button>
        </div>
        <span class="spacer"></span>
        <span id="group-status" class="muted"></span>
        <button id="btn-ll-more" class="ib" title="More actions: expand or collapse all groups, recently deleted, venues, briefs" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">${RT.icon('more')}</button>
        <button id="btn-expand-all" class="ib" hidden title="Expand all groups" aria-label="Expand all groups">${RT.icon('expand')}</button>
        <button id="btn-collapse-all" class="ib" hidden title="Collapse all groups" aria-label="Collapse all groups">${RT.icon('collapse')}</button>
      </div>
      <div id="tag-filter" class="ll-chips" role="group" aria-label="Show"></div>
      <div id="bulk" hidden></div>
      <div id="venue-bar" role="status" hidden></div>
      <div id="jobs"></div>
      <div id="list"></div>`;
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-bib">
  <h3>Add papers by id, link or BibTeX</h3>
  <p class="muted">One per line: an arXiv id or link, a DOI or doi.org link, an OpenReview link - or BibTeX. arXiv and OpenReview papers arrive with their PDF. A DOI (or a publisher link that contains it) is looked up at doi.org and gets a PDF when a free copy is found (through OpenAlex, or on arXiv under the same title); otherwise the reference is added without one and you can attach the PDF later.</p>
  <textarea id="bib-text" rows="12" aria-label="arXiv ids, DOIs, links or BibTeX" placeholder="2410.24164&#10;https://arxiv.org/abs/1706.03762&#10;10.1109/ICRA48891.2023.10160591&#10;https://openreview.net/forum?id=...&#10;&#10;or BibTeX:&#10;@article{key,&#10;  title = {...},&#10;  author = {...},&#10;  year = {2024}&#10;}"></textarea>
  <div class="dlg-actions"><button value="cancel" id="bib-cancel" class="ib" title="Cancel (Esc)" aria-label="Cancel">${RT.icon('close')}</button><button class="primary ib" id="bib-ok" title="Add these papers to the library" aria-label="Add these papers to the library">${RT.icon('import')}</button></div>
</dialog>`);

  // The icons drawn in every row (star, bookmark, key points) come from one hidden sprite: a row holds a short <use>
  // instead of the whole drawing, which keeps a list of thousands of papers quick to draw.
  const ROW_IC = {};
  {
    const syms = [];
    for (const n of ['star', 'bookmark', 'highlight']) {
      const svg = RT.icon(n), inner = svg.replace(/^<svg[^>]*>|<\/svg>$/g, '');
      syms.push(`<symbol id="ll-i-${n}" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`);
      ROW_IC[n] = `<svg class="ic" aria-hidden="true" focusable="false"><use href="#ll-i-${n}"/></svg>`;
    }
    host.insertAdjacentHTML('beforeend', `<svg class="ll-sprite" width="0" height="0" aria-hidden="true" focusable="false">${syms.join('')}</svg>`);
  }
  let items = [];
  let groupBy = ['category', 'year', 'venue', 'status', 'project', 'none'].includes(ls.get('rt.lib.group')) ? ls.get('rt.lib.group') : 'category';
  let sortBy = ['added', 'opened', 'status', 'year', 'pubNew', 'pubOld', 'title'].includes(ls.get('rt.lib.sort')) ? ls.get('rt.lib.sort') : 'added';
  let collapsed = ls.json('rt.lib.collapsed', {}) || {};
  let showBriefs = ls.get('rt.lib.briefs') !== '0'; // the brief line of a row (View menu)
  let tagFilter = null;
  // null | 'unread' | 'reading' | 'done' | 'starred' | 'nopdf' | 'project' (in the working project); the filter chips,
  // kept in localStorage rt.lib.show
  const SHOWS = ['unread', 'reading', 'done', 'starred', 'nopdf', 'project'];
  let statusFilter = SHOWS.includes(ls.get('rt.lib.show')) ? ls.get('rt.lib.show') : null;
  const setShow = (v) => { statusFilter = SHOWS.includes(v) ? v : null; ls.set('rt.lib.show', statusFilter || ''); };
  const picked = new Set();   // multi-selection (ids)
  let anchor = null;          // last clicked id, for Shift-click ranges
  let order = [];             // ids of the rows currently rendered, top to bottom
  let dragIds = null;         // ids being dragged onto a category header

  // ---------------- data ----------------
  const CAT_FIELDS = ['category', 'tags', 'categoryStatus', 'categoryReason', 'categoryError', 'status', 'starred', 'lastOpened', 'brief', 'briefStatus', 'briefError', 'briefBy'];
  // Refetch and merge into the existing objects (the reader edits them in place, so their identity is kept).
  // The open item keeps its unsaved edits: only the grouping fields are taken from the server while the reader is dirty.
  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const fresh = (await api('/api/library')).items;
      const old = new Map(items.map((i) => [i.id, i]));
      const dirtyId = RT.reader && RT.reader.dirty && RT.reader.dirty() ? RT.state.sel : null;
      const grouped = [];
      items = fresh.map((f) => {
        const it = old.get(f.id);
        if (!it) return f;
        if (it.categoryStatus === 'pending' && f.categoryStatus !== 'pending') grouped.push(f.id);
        if (it.id === dirtyId) { for (const k of CAT_FIELDS) { if (k in f) it[k] = f[k]; else delete it[k]; } return it; }
        for (const k of Object.keys(it)) if (!(k in f)) delete it[k];
        return Object.assign(it, f);
      });
      for (const id of [...picked]) if (!items.some((i) => i.id === id)) picked.delete(id);
      if (RT.state.sel && !items.some((i) => i.id === RT.state.sel)) RT.state.sel = null;
      renderList();
      loadVenues(); // (the records of changed entries are "stale" now)
      RT.emit('library:refreshed');
      for (const id of grouped) RT.emit('item:categorized', { id });
      schedulePoll();
      return items;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  // after this module changed something on the server: refetch once, then tell the others
  let selfEmit = false;
  async function changed() {
    try { await refresh(); } catch (e) { toast('Could not load the library: ' + e.message, 'bad'); }
    selfEmit = true; try { RT.emit('library:changed'); } finally { selfEmit = false; }
  }

  // while Claude is grouping or writing briefs: ask the (cheap) category summary every 3 s and refetch when a pending count moved
  let pollTimer = null;
  const pendingCount = () => items.filter((i) => i.categoryStatus === 'pending').length;
  const briefPending = () => items.filter((i) => i.briefStatus === 'pending').length;
  function schedulePoll() {
    if (pollTimer || !(pendingCount() || briefPending())) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      try { const c = await api('/api/categories'); if (c.pending !== pendingCount() || (c.briefPending || 0) !== briefPending()) await refresh(); } catch { /* server away: try again */ }
      schedulePoll();
    }, 3000);
  }

  // ---------------- list ----------------
  const yearOf = (it) => { const m = String(it.fields.year || '').match(/\d{4}/); return m ? m[0] : ''; };

  // ---------------- venues: where a paper was published, VERIFIED (GET /api/venues, lib/venues.js) ----------------
  // A record is {status 'published' | 'preprint' | 'unverified', venue, short, kind, year, date, publisher, sources
  // [{name, venue, year, url}], claim, why, error?, missed?, checked, stale}. It counts only while the entry is unchanged
  // since its check (`stale` = the title, DOI or arXiv id changed): otherwise the paper is "not checked". The check never
  // runs by itself: the View menu, the venue bar and a row's menu start it (POST /api/venues/check); while it runs the
  // GET is polled for its progress, as the briefs are.
  let venues = { items: {}, running: null };
  let venueSig = '', venueTimer = null, venueWasRunning = false, venueStopping = false;
  let venueRun = null, venueAway = false; // the ids of the check this page started (null: the whole library); GET failed
  const VENUE_PRE = 'arXiv preprint', VENUE_NONE = 'Unverified / 未归类';
  const venueOf = (it) => { const r = venues.items[it.id]; return r && !r.stale ? r : null; };
  // a published paper or an arXiv preprint (arXiv itself confirms it; an index behind a bot wall, `missed`, is asked
  // again after a week - the record says so in its why)
  const confirmedOf = (it) => { const r = venueOf(it); return r && (r.status === 'published' || r.status === 'preprint') ? r : null; };
  const venueName = (r) => r.short || r.venue || 'Unknown venue';
  const sourceNames = (r) => [...new Set((r.sources || []).map((x) => x.name))];
  // what the server would check again: never checked, changed since, failed, an index left out, or older than 30 days
  // the same rule as isFresh() in lib/venues.js: a record that lacks only an index behind a bot wall is due after a week
  const venueDue = (it) => { const r = venues.items[it.id]; const age = Date.now() - Date.parse(r && r.checked);
    return !r || r.stale || !!r.error || !!r.lastError || !(age < 30 * 86400000)
      || (!!(r.missed && r.missed.length) && r.status !== 'published' && !(age < 7 * 86400000)); };
  // the year of the Year grouping and sort: the verified first public year (arXiv v1, else the publication), else BibTeX
  const yearShown = (it) => { const r = confirmedOf(it); const y = r && (String(r.date || '').match(/^\d{4}/) || [r.year])[0]; return y ? String(y) : yearOf(it); };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | '': the record's first public date, else the BibTeX year (and month)
  function pubDate(it) {
    const r = confirmedOf(it);
    if (r && /^\d{4}(-\d\d){0,2}$/.test(String(r.date || ''))) return String(r.date);
    const y = yearOf(it); if (!y) return '';
    const m = String(it.fields.month || '').replace(/[{}]/g, '').trim().toLowerCase();
    const n = /^\d{1,2}$/.test(m) ? Number(m) : MONTHS.indexOf(m.slice(0, 3)) + 1;
    return n >= 1 && n <= 12 ? `${y}-${String(n).padStart(2, '0')}` : y;
  }
  // the venue part of a row's meta line (grouped by Venue): [text, tooltip]
  function venueBits(it) {
    const r = venueOf(it), raw = venues.items[it.id], by = yearOf(it) ? yearOf(it) + ' · ' : ''; // the BibTeX year where nothing is verified
    if (!r) return [by + (raw ? 'not checked since the entry changed' : 'not checked'), raw ? 'The title, DOI or arXiv id changed after the venue check: check it again (row menu)' : 'The venue of this paper has not been checked yet'];
    if (r.status === 'published') return [`${venueName(r)}${r.year ? ' ' + r.year : ''}`, `${r.venue || venueName(r)}${r.publisher ? ' · ' + r.publisher : ''} - verified by ${sourceNames(r).join(' + ')}`];
    if (r.status === 'preprint') {
      const text = `arXiv${r.date ? ' · v1 ' + r.date : ''}${r.claim ? ` · claims: ${r.claim} (not confirmed)` : ''}`;
      return [text, `${r.why || 'An arXiv preprint'}${r.claim ? `\nThe arXiv entry says “${r.claim}”, but no index confirms it.` : ''}`];
    }
    return [by + (r.error ? 'check failed' : 'not verified'), r.why || 'Not verified'];
  }
  async function loadVenues() {
    let r;
    try { r = await api('/api/venues'); } catch { // the server is away: keep what is shown, say so, and try again while a check runs
      if (!venueAway) { venueAway = true; renderVenueBar(); }
      clearTimeout(venueTimer); venueTimer = venues.running || venueWasRunning ? setTimeout(loadVenues, 3000) : null;
      return;
    }
    if (venueAway) { venueAway = false; venueSig = ''; }
    const sig = JSON.stringify(r.items || {});
    const was = venues.running;
    venues = { items: r.items || {}, running: r.running || null };
    if (venues.running) venueWasRunning = true;
    const moved = sig !== venueSig;
    if (moved) { venueSig = sig; renderList(); } else renderVenueBar();
    if (moved || JSON.stringify(was) !== JSON.stringify(venues.running)) RT.emit('venues:changed');
    if (!venues.running && venueWasRunning) {
      venueWasRunning = false;
      // only the papers of this check are counted; `last` says how the job ended (none: the server restarted meanwhile)
      const last = r.last, run = venueRun ? items.filter((it) => venueRun.has(it.id)) : items;
      const recs = run.map(venueOf).filter(Boolean), n = (st) => recs.filter((x) => x.status === st).length;
      const counts = `${n('published')} published, ${plural(n('preprint'), 'arXiv preprint')}, ${n('unverified')} not verified`;
      if (!last) toast('The venue check was interrupted (the app was restarted). The venues checked so far stay.', 'bad');
      else if (last.error) toast(`${last.error} Checked: ${counts}`, 'bad');
      else toast(`Venue check ${last.stopped && last.done < last.total ? 'stopped' : 'finished'}. Of the ${plural(last.done, 'paper')} checked: ${counts}`, 'ok');
      venueStopping = false; venueRun = null;
      RT.emit('venues:changed');
    }
    clearTimeout(venueTimer); venueTimer = null;
    if (venues.running) venueTimer = setTimeout(loadVenues, 1500);
  }
  // ids: the papers to check (null = the whole library); force: also the ones checked in the last 30 days
  async function checkVenues(ids, force = false) {
    try {
      const r = await api('/api/venues/check', { method: 'POST', json: { ...(ids ? { ids } : {}), force } });
      if (r.started) venueRun = ids ? new Set(ids) : null;
      if (!r.started) toast(ids && ids.length === 1 ? 'The venue of this paper was checked in the last 30 days.' : 'Every venue was checked in the last 30 days: nothing to do.', 'ok');
    } catch (e) { toast(e.status === 409 ? 'Venues are being checked already: wait for that check, or stop it.' : 'Could not start the venue check: ' + e.message, 'bad'); }
    await loadVenues();
  }
  async function stopVenues() {
    try { const r = await api('/api/venues/stop', { method: 'POST', json: {} }); venueStopping = !!r.stopped; }
    catch (e) { toast('Could not stop: ' + e.message, 'bad'); }
    await loadVenues();
  }
  // above the list: the progress of a check, or (grouped by Venue) what is verified and the button that checks the rest
  function renderVenueBar() {
    const el = $('#venue-bar'), run = venues.running;
    el.hidden = !run && groupBy !== 'venue';
    if (el.hidden) { el.innerHTML = ''; return; }
    if (venueAway) { el.innerHTML = `<span class="vb-text muted">The venues could not be loaded (is the app running?).${run ? ' Trying again…' : ''}</span>`; return; }
    if (run) {
      // the bar is drawn again on every poll: the Stop button keeps the keyboard focus
      const had = document.activeElement && document.activeElement.id === 'venues-stop';
      el.innerHTML = `<span class="spin"></span><span class="vb-text" title="${esc(run.current ? 'Now: ' + run.current.title : '')}">${venueStopping ? 'Stopping' : 'Checking venues'} ${Number(run.done)}/${Number(run.total)}…${run.current ? ` <span class="muted">${esc(run.current.title)}</span>` : ''}</span><span class="spacer"></span><button class="mini ib" id="venues-stop"${venueStopping ? ' disabled' : ''} title="Stop the venue check (the venues checked so far stay)" aria-label="Stop the venue check">${RT.icon('stop')}</button>`;
      if (had) $('#venues-stop').focus();
      return;
    }
    const recs = items.map(confirmedOf), n = (st) => recs.filter((x) => x && x.status === st).length, due = items.filter(venueDue).length;
    el.innerHTML = `<span class="vb-text muted" title="Published = confirmed by the publisher's record (Crossref) or by two indexes (DBLP, OpenAlex, Semantic Scholar) naming the same venue and year, or by one exact DBLP entry. An arXiv comment such as “Accepted to …” alone does not count.">${n('published')} verified · ${n('preprint')} arXiv · ${items.length - n('published') - n('preprint')} unverified</span><span class="spacer"></span>`
      + (due ? `<button class="mini" id="venues-check" title="Look the venue of these papers up at Crossref, DBLP, OpenAlex, Semantic Scholar and arXiv (only the DOI, arXiv id or title is sent; one paper after the other)">${RT.icon('check')} Check venues of ${plural(due, 'paper')}</button>` : '');
  }
  $('#venue-bar').addEventListener('click', (e) => {
    if (e.target.closest('#venues-stop')) { e.target.closest('#venues-stop').disabled = true; stopVenues(); }
    else if (e.target.closest('#venues-check')) { e.target.closest('#venues-check').disabled = true; checkVenues(null); }
  });
  // ---------------- search ----------------
  // The words of the search box: "quoted words" stay together, the rest is cut at spaces. A paper matches when its
  // details contain every word, in any order.
  function wordsOf(q) {
    const out = [];
    const re = /"([^"]+)"|“([^”]+)”|(\S+)/g;
    for (let m; (m = re.exec(q));) { const t = (m[1] || m[2] || m[3].replace(/^["“”]+|["“”]+$/g, '')).replace(/\s+/g, ' ').trim().toLowerCase(); if (t && !out.includes(t)) out.push(t); } // a quote that is not closed yet is not part of the word
    return out;
  }
  // Searching inside papers and notes (the switch in the search box). `ft` is the answer of GET /api/search for
  // the words in `ft.q`: {papers: {<id>: {n, hits, more}}, total}; `state` is '' | 'busy' | 'bad'.
  let scope = ls.get('rt.lib.scope') === 'all' ? 'all' : 'titles';
  let ft = { q: '', papers: {}, total: 0, tokens: [], state: '', error: '' };
  let ftTimer = null, ftAbort = null, ftRun = 0;
  const ftBusyMore = new Set(); // ids whose other passages are being fetched
  const deep = () => scope === 'all';
  // long enough to be worth a search of every text: two characters, or one Chinese / Japanese / Korean character
  const worthIt = (q) => q.length >= 2 || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(q);
  const hitsOf = (id) => (deep() && ft.q && ft.q === $('#search').value.trim() ? ft.papers[id] : null);
  function searchChanged(wait = 220) {
    clearTimeout(ftTimer);
    if (ftAbort) { ftAbort.abort(); ftAbort = null; }
    const q = $('#search').value.trim();
    const run = ++ftRun;
    ftBusyMore.clear();
    if (!deep() || !worthIt(q)) { ft = { q: '', papers: {}, total: 0, tokens: [], state: '', error: '' }; renderList(); return; }
    ft.state = 'busy'; ft.error = '';
    renderList();
    ftTimer = setTimeout(async () => {
      const ac = new AbortController(); ftAbort = ac;
      try {
        const r = await api('/api/search?q=' + enc(q), { signal: ac.signal });
        if (run !== ftRun) return;
        ft = { q, papers: r.papers || {}, total: r.total || 0, tokens: r.tokens || [], state: '', error: '' };
      } catch (e) {
        if (run !== ftRun || e.name === 'AbortError') return;
        ft = { q, papers: {}, total: 0, tokens: [], state: 'bad', error: e.message };
      }
      if (ftAbort === ac) ftAbort = null;
      renderList();
    }, wait);
  }
  function setScope(next) {
    scope = next === 'all' ? 'all' : 'titles';
    ls.set('rt.lib.scope', scope);
    renderScope();
    searchChanged(0);
  }
  function renderScope() {
    const b = $('#search-scope'), on = deep();
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Full text: searching inside the PDFs, notes and key points too - click to search titles and details only' : 'Also search inside the PDFs, notes and key points';
    b.setAttribute('aria-label', 'Full text: also search inside the PDFs, notes and key points');
    $('#search').placeholder = on ? 'Search papers, notes, key points…' : 'Search title, author, tag…';
    $('#search').title = on ? 'Search titles and details, and the text of every PDF, note and key point. Several words are found in any order; put "words in quotes" to find them together.'
      : 'Search title, author, key, tag, category or brief. Several words are found in any order.';
  }
  // `shown` = the papers of the list as it is drawn (after the tag and status filters)
  function renderSearchInfo(shown) {
    const el = $('#search-info'), q = $('#search').value.trim();
    el.hidden = !(deep() && q);
    if (el.hidden) return;
    el.classList.toggle('bad', ft.state === 'bad');
    if (!worthIt(q)) el.textContent = 'Type one more character to search inside papers and notes.';
    else if (ft.state === 'busy') el.innerHTML = '<span class="spin"></span>Searching inside papers and notes…';
    else if (ft.state === 'bad') el.textContent = 'Could not search inside papers and notes: ' + ft.error;
    else {
      const found = shown.map((i) => hitsOf(i.id)).filter(Boolean), n = found.length, total = found.reduce((a, r) => a + r.n, 0);
      const hidden = Object.keys(ft.papers).length - n; // papers with passages that the tag or status filter keeps out of the list
      el.textContent = n ? `${plural(total, 'passage')} in ${plural(n, 'paper')}${shown.length > n ? ` · ${plural(shown.length - n, 'more paper')} by title or details` : ''}`
        : hidden > 0 ? 'No passage in the papers shown - the tag or status filter hides the papers that have one.' : 'No passage inside a paper or note matches.';
    }
  }
  // a passage with the words of the search marked
  function markHtml(text, tokens) {
    const toks = [...tokens].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!toks.length) return esc(text);
    const re = new RegExp(toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    let out = '', at = 0;
    for (let m; (m = re.exec(text));) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(text.slice(at, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      at = m.index + m[0].length;
    }
    return out + esc(text.slice(at));
  }
  const HIT_KIND = { note: ['Note', 'Open the note at this line'], kp: ['Key point', 'Show this key point'], pdf: ['', 'Open the paper at this page'] };
  function hitsHtml(i) {
    const r = hitsOf(i.id);
    if (!r || !r.hits.length) return '';
    const rows = r.hits.map((h, k) => {
      const [label, tip] = HIT_KIND[h.kind] || HIT_KIND.pdf;
      const where = h.kind === 'pdf' ? `p. ${Number(h.page) || '?'}` : h.kind === 'kp' && h.page ? `${label} · p. ${Number(h.page)}` : label;
      return `<button class="hit" data-hit="${k}" title="${tip}"><span class="hit-where hit-${esc(h.kind)}">${esc(where)}</span><span class="hit-text">${markHtml(h.text, ft.tokens)}</span></button>`;
    }).join('');
    const more = r.more > 0 && r.all ? `<span class="hit-more muted">Only the first ${r.hits.length} of ${r.n} passages are listed</span>` : r.more > 0 ? `<button class="hit-more" data-more="${esc(i.id)}" title="Show every matching passage of this paper"${ftBusyMore.has(i.id) ? ' disabled' : ''}>${ftBusyMore.has(i.id) ? '<span class="spin"></span>' : ''}Show ${plural(r.more, 'more passage')}</button>` : '';
    return `<div class="hits${r.all ? ' all' : ''}" aria-label="${plural(r.n, 'matching passage')}">${rows}${more}</div>`;
  }
  // every matching passage of one paper (the list starts with the first few of each)
  async function moreHits(id) {
    const q = ft.q, run = ftRun;
    if (!q || ftBusyMore.has(id)) return;
    ftBusyMore.add(id); renderList();
    try {
      const r = await api(`/api/search?q=${enc(q)}&id=${enc(id)}`);
      if (run !== ftRun) return;
      if (r.papers && r.papers[id]) ft.papers[id] = { ...r.papers[id], all: true };
    } catch (e) { if (run === ftRun) toast('Could not load the other passages: ' + e.message, 'bad'); }
    finally { if (run === ftRun) { ftBusyMore.delete(id); renderList(); } }
  }
  // open the paper of a passage and show the passage: the page of the PDF, the line of the note, or the key point
  function openHit(id, h) {
    if (!RT.reader || !RT.reader.reveal) return select(id);
    if (RT.state.sel !== id) select(id);
    RT.reader.reveal(id, { kind: h.kind, page: h.page, own: h.own, text: h.pass || h.text.replace(/^… | …$/g, ''), kp: h.kp, tokens: ft.tokens });
  }

  const showOk = (i, f) => (f === 'starred' ? !!i.starred : f === 'nopdf' ? !i.pdf : f === 'project' ? PP.has(i.id) : statusOf(i) === f);
  function visible() {
    const words = wordsOf($('#search').value.trim());
    const shown = items.filter((i) => {
      if (tagFilter && !tagsOf(i).some((t) => t.toLowerCase() === tagFilter.toLowerCase())) return false;
      if (statusFilter && !showOk(i, statusFilter)) return false;
      if (!words.length || hitsOf(i.id)) return true;
      const v = venueOf(i);
      const hay = [i.citekey, i.fields.title, i.fields.author, i.fields.year, i.fields.journal, i.fields.booktitle, catOf(i), ...tagsOf(i), i.brief, v && v.status === 'published' ? `${v.short} ${v.venue}` : ''].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const title = (i) => String(i.fields.title || '').toLowerCase();
    if (sortBy === 'year') shown.sort((a, b) => (yearShown(b) || '0').localeCompare(yearShown(a) || '0') || title(a).localeCompare(title(b)));
    else if (sortBy === 'pubNew' || sortBy === 'pubOld') { // the papers without any date come last in both orders
      const dir = sortBy === 'pubNew' ? -1 : 1;
      shown.sort((a, b) => { const x = pubDate(a), y = pubDate(b); return (!x) - (!y) || dir * x.localeCompare(y) || title(a).localeCompare(title(b)); });
    }
    else if (sortBy === 'title') shown.sort((a, b) => title(a).localeCompare(title(b)));
    else if (sortBy === 'opened') shown.sort((a, b) => String(b.lastOpened || '').localeCompare(String(a.lastOpened || '')) || String(b.added || '').localeCompare(String(a.added || '')));
    else if (sortBy === 'status') shown.sort((a, b) => STATUS_ORDER.indexOf(statusOf(a)) - STATUS_ORDER.indexOf(statusOf(b)) || String(b.lastOpened || '').localeCompare(String(a.lastOpened || '')) || String(b.added || '').localeCompare(String(a.added || '')));
    else shown.sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
    return shown;
  }
  function groupsOf(shown) {
    if (groupBy === 'none') return [{ key: null, items: shown }];
    if (groupBy === 'project') { // a paper in several projects is listed in each
      const map = new Map(), none = [];
      for (const it of shown) {
        const pids = PP.of(it.id).filter((pid) => PP.project(pid));
        if (!pids.length) none.push(it);
        for (const pid of pids) { if (!map.has(pid)) map.set(pid, []); map.get(pid).push(it); }
      }
      return [...PP.projects().filter((p) => map.has(p.id)).map((p) => ({ key: 'project:' + p.id, name: p.name, items: map.get(p.id), pid: p.id })),
        ...(none.length ? [{ key: 'project:', name: 'In no project', items: none }] : [])];
    }
    if (groupBy === 'venue') { // the verified venues (most papers first), then the arXiv preprints, then everything else
      const map = new Map(), pre = [], none = [];
      for (const it of shown) {
        const r = venueOf(it);
        if (r && r.status === 'published') { const k = venueName(r); if (!map.has(k)) map.set(k, { items: [], full: new Map(), by: new Set() }); const g = map.get(k); g.items.push(it); if (!g.full.get(r.venue || k)) g.full.set(r.venue || k, r.publisher || ''); for (const s of sourceNames(r)) g.by.add(s); }
        else if (r && r.status === 'preprint' && confirmedOf(it)) pre.push(it);
        else none.push(it);
      }
      const names = [...map.keys()].sort((a, b) => map.get(b).items.length - map.get(a).items.length || a.localeCompare(b, undefined, { sensitivity: 'base' }));
      return [...names.map((name) => ({ key: 'venue:' + name, name, items: map.get(name).items, tip: `${[...map.get(name).full].map(([v, pub]) => (pub ? v + ' · ' + pub : v)).join('\n')}\nVerified by ${[...map.get(name).by].join(', ')}` })),
        ...(pre.length ? [{ key: 'venue:@preprint', name: VENUE_PRE, items: pre, tip: 'Confirmed on arXiv; no publication could be verified (an “Accepted to …” comment alone does not count)' }] : []),
        ...(none.length ? [{ key: 'venue:@none', name: VENUE_NONE, items: none, tip: 'Not checked yet, changed since the check, not found, the indexes disagree, or the check failed (open the paper: Details tells why)' }] : [])];
    }
    const map = new Map();
    for (const it of shown) { const k = groupBy === 'year' ? (yearShown(it) || 'No year') : groupBy === 'status' ? STATUS[statusOf(it)] : catOf(it); if (!map.has(k)) map.set(k, []); map.get(k).push(it); }
    const names = [...map.keys()];
    const stOrder = STATUS_ORDER.map((k) => STATUS[k]);
    if (groupBy === 'status') names.sort((a, b) => stOrder.indexOf(a) - stOrder.indexOf(b));
    else if (groupBy === 'year') names.sort((a, b) => (a === 'No year') - (b === 'No year') || b.localeCompare(a));
    else names.sort((a, b) => (a === UNCAT) - (b === UNCAT) || a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const flat = names.map((name) => ({ key: groupBy + ':' + name, name, items: map.get(name), cat: groupBy === 'category',
      st: groupBy === 'status' ? STATUS_ORDER[stOrder.indexOf(name)] : null }));
    return groupBy === 'category' ? nestLines(flat) : flat;
  }
  // Research lines: the categories "Line / Sub-line" of one line are nested under a line header (key 'line:<Line>');
  // the papers filed under the line itself come first, then one group per sub-line (its key stays 'category:<full name>').
  // A category without sub-lines stays a group of its own.
  const SEP = ' / ';
  const lineOf = (name) => { const i = name.indexOf(SEP); return i > 0 ? name.slice(0, i) : name; };
  const subOf = (name) => { const i = name.indexOf(SEP); return i > 0 ? name.slice(i + SEP.length) : ''; };
  function nestLines(flat) {
    const byLine = new Map();
    for (const g of flat) { const l = g.name === UNCAT ? UNCAT : lineOf(g.name); if (!byLine.has(l)) byLine.set(l, []); byLine.get(l).push(g); }
    const out = [];
    for (const [line, list] of byLine) {
      if (list.length === 1 && !subOf(list[0].name)) { out.push(list[0]); continue; }
      const direct = list.find((g) => g.name === line);
      const children = list.filter((g) => g !== direct).map((g) => ({ ...g, sub: subOf(g.name) }))
        .sort((a, b) => a.sub.localeCompare(b.sub, undefined, { sensitivity: 'base' }));
      out.push({ key: 'line:' + line, name: line, line: true, cat: true, direct: direct ? direct.items : [], children,
        items: [...(direct ? direct.items : []), ...children.flatMap((c) => c.items)] });
    }
    return out.sort((a, b) => (a.name === UNCAT) - (b.name === UNCAT) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  // a group header of the list (a line header too); `label` is what it shows (a sub-line shows only its own part)
  // the name of a group: a category, line, venue or project name is the user's (never translated: data-i18n-skip); a
  // status, a year or a built-in group ("Uncategorized", "In no project") is UI text
  function grpName(g, label) {
    const tip = g.tip || (g.line ? `Research line “${g.name}”: ${plural(g.children.length, 'sub-line')}` : g.name);
    const own = (g.cat && g.name !== UNCAT) || g.pid || (/^venue:/.test(g.key || '') && !/^venue:@/.test(g.key));
    if (!own) return `<span class="grp-name" title="${esc(tip)}">${esc(label)}</span>`;
    // the tooltip is the name itself: skip all of it; a tooltip of its own (a research line, a venue) is translated
    return tip === g.name ? `<span class="grp-name" title="${esc(tip)}" data-i18n-skip>${esc(label)}</span>`
      : `<span class="grp-name" title="${esc(tip)}"><span data-i18n-skip>${esc(label)}</span></span>`;
  }
  // a group header: chevron, colour dot (a category), status ring (grouped by status) or bookmark (a project), the name,
  // the count pill and the actions (shown on hover and focus)
  const CHEV = RT.icon('chevron-down', 'caret');
  function grpHead(g, { cls = '', label = g.name, collapsedNow = !!collapsed[g.key] } = {}) {
    const busy = g.items.some((i) => i.categoryStatus === 'pending');
    const more = g.cat ? `<button class="grp-more ib" data-menu="${esc(g.name)}" title="${g.line ? 'Line actions' : 'Category actions'}" aria-label="${g.line ? 'Line actions' : 'Category actions'}">${RT.icon('more')}</button>`
      : g.pid ? `<button class="grp-more ib" data-pmenu="${esc(g.pid)}" title="Project actions: review, compare, reading pack, open in Write" aria-label="Project actions">${RT.icon('more')}</button>` : '';
    return `<div class="grp${cls}${collapsedNow ? ' collapsed' : ''}" data-key="${esc(g.key)}" role="button" tabindex="0" aria-expanded="${collapsedNow ? 'false' : 'true'}">
          ${CHEV}${g.cat ? `<span class="cat-dot" style="background:${esc(color(g.name))}"></span>` : ''}${g.st ? `<span class="st st-${g.st}"></span>` : ''}${g.pid ? `<span class="grp-pj">${RT.icon(PP.ICON)}</span>` : ''}
          ${grpName(g, label)}<span class="grp-count sh-count">${g.items.length}</span>${busy ? '<span class="spin"></span>' : ''}${more ? `<span class="sh-actions">${more}</span>` : ''}
        </div>`;
  }
  // the papers opened last that are not marked Done, newest first (only while the list is not searched or filtered)
  function recentOf() {
    if ($('#search').value.trim() || tagFilter || statusFilter) return [];
    return items.filter((i) => i.lastOpened && statusOf(i) !== 'done').sort((a, b) => String(b.lastOpened).localeCompare(String(a.lastOpened))).slice(0, RECENT_MAX);
  }
  const statusDot = (i) => { const st = statusOf(i); return `<button class="st st-${st}" data-status="${esc(i.id)}" title="${STATUS[st]} - click to change the reading status" aria-label="Reading status: ${STATUS[st]}. Change"></button>`; };
  // the bookmark of a row: in the working project or not (click adds or removes it)
  function projBtn(i) {
    const w = PP.working(), on = !!w && PP.has(i.id, w.id);
    const hint = !PP.loaded() ? 'Add to a project' : !w ? (PP.projects().length ? 'Add to a project: choose the working project first' : PP.NO_PROJECT) : on ? `In “${w.name}” - click to remove` : `Add to “${w.name}”`;
    return `<button class="pj${on ? ' on' : ''}" data-proj="${esc(i.id)}" title="${esc(hint)}" aria-pressed="${on ? 'true' : 'false'}">${ROW_IC.bookmark}</button>`;
  }
  const starBtn = (i) => `<button class="star${i.starred ? ' on' : ''}" data-star="${esc(i.id)}" title="${i.starred ? 'Starred - click to remove the star' : 'Star this paper'}" aria-label="${i.starred ? 'Remove the star' : 'Star this paper'}" aria-pressed="${i.starred ? 'true' : 'false'}">${ROW_IC.star}</button>`;
  // a short row of the "Continue reading" group: title, where the PDF was left, when it was opened
  function recentRowHtml(i) {
    const at = progress(i), when = ago(i.lastOpened);
    const frac = i.reading && i.pages && i.reading.page > 1 ? Math.min(1, Number(i.reading.page) / Number(i.pages)) : 0;
    return `
    <div class="item recent${i.id === RT.state.sel ? ' sel' : ''}" data-id="${esc(i.id)}" draggable="true" tabindex="-1"${i.id === RT.state.sel ? ' aria-current="true"' : ''} title="${esc(i.fields.title || '(untitled)')}">
      <div class="th">${statusDot(i)}<div class="t" data-i18n-skip>${esc(showTitle(i))}</div></div>
      <div class="m"><span class="au">${esc(authorsShort(i.fields.author))}</span>${at ? `<span class="rc-p">${esc(at)}</span>` : ''}${when ? `<span>${esc(when)}</span>` : ''}</div>${frac ? `<div class="rc-bar" aria-hidden="true"><span style="width:${Math.round(frac * 100)}%"></span></div>` : ''}
    </div>`;
  }

  // ---------------- the papers of the working project: a pinned group under "Continue reading" ----------------
  // Its rows come in the order they were added; the line under the header (GET /api/projects/:id/papers) tells how
  // far the reading is, and opens a checklist of what is left to do.
  let projWait = null;
  function projectGroup() {
    const w = PP.working();
    if (!w || groupBy === 'project' || $('#search').value.trim() || tagFilter || statusFilter) return null;
    const ids = PP.members(w.id);
    if (!ids.size) return null;
    const d = PP.papersNow(w.id);
    if (!d && !projWait) projWait = PP.papers(w.id).then(() => renderList()).catch(() => {}).finally(() => { projWait = null; });
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = new Map(d ? d.papers.map((r) => [r.id, r]) : []);
    const list = (d ? d.papers.map((r) => r.id).filter((id) => ids.has(id)) : [...ids]).filter((id) => byId.has(id)).map((id) => byId.get(id));
    return { w, list, d, rows };
  }
  // the progress line of the project group: small pills ("3 papers", "3 reading", "0 cited"; the rest only when not 0)
  function projStats(d) {
    if (!d) return [];
    const c = d.counts;
    return [plural(c.total, 'paper'), c.toRead && `${c.toRead} to read`, c.reading && `${c.reading} reading`, c.done && `${c.done} done`,
      `${c.cited} cited`, c.noNote && `${c.noNote} without a note`, c.due && plural(c.due, 'question') + ' due'].filter(Boolean);
  }
  function projRowHtml(i, r) {
    const cited = r ? (r.cited ? (r.citedCount ? `cited ${r.citedCount}×` : 'cited') : 'not cited') : '';
    const bits = [yearOf(i), cited, r && !r.hasNote ? 'no note' : ''].filter(Boolean);
    return `
    <div class="item recent proj${i.id === RT.state.sel ? ' sel' : ''}" data-id="${esc(i.id)}" draggable="true" tabindex="-1"${i.id === RT.state.sel ? ' aria-current="true"' : ''} title="${esc(i.fields.title || '(untitled)')}">
      <div class="th">${statusDot(i)}<div class="t" data-i18n-skip>${esc(showTitle(i))}</div>${projBtn(i)}</div>
      <div class="m"><span class="au">${esc(authorsShort(i.fields.author))}</span>${bits.map((b) => `<span>${esc(b)}</span>`).join('')}</div>
    </div>`;
  }
  function projGroupHtml(g) {
    const shut = !!collapsed.project, stats = projStats(g.d);
    return `<div class="grp-wrap recent-wrap proj-wrap pinned" data-pid="${esc(g.w.id)}">
        <div class="grp grp-pin${shut ? ' collapsed' : ''}" data-key="project" role="button" tabindex="0" aria-expanded="${shut ? 'false' : 'true'}" title="The papers of the working project “${esc(g.w.name)}”">
          ${CHEV}<span class="grp-pj">${RT.icon('bookmark')}</span><span class="grp-name">In “${esc(g.w.name)}”</span><span class="grp-count sh-count">${g.list.length}</span>
          <span class="sh-actions"><button class="grp-more ib" data-pmenu="${esc(g.w.id)}" title="Project actions: review, compare, reading pack, open in Write" aria-label="Project actions">${RT.icon('more')}</button></span>
        </div>${shut ? '' : `${stats.length ? `<button class="proj-stats" data-pstats="${esc(g.w.id)}" title="What is left to do: the papers not read yet, read without a note, not cited yet">${stats.map((b) => `<span class="ps-chip">${esc(b)}</span>`).join('')}</button>` : ''}${g.list.map((i) => projRowHtml(i, g.rows.get(i.id))).join('')}`}</div>`;
  }

  // a row: title (two lines), byline, one meta line (year · venue · pages · where the reading stopped · category), the
  // brief (Category grouping, when shown), then the small chips (no PDF, key points, cite key, up to 3 tags + N)
  const KP_IC = ROW_IC.highlight;
  function metaBits(i) {
    const out = [];
    if (groupBy === 'venue') { const [text, tip] = venueBits(i); out.push(`<span class="vn" title="${esc(tip)}">${esc(text)}</span>`); }
    else {
      const y = yearShown(i); if (y) out.push(`<span>${esc(y)}</span>`);
      const v = confirmedOf(i);
      if (v && v.status === 'published') out.push(`<span class="vn" title="${esc(v.venue || venueName(v))}" data-i18n-skip>${esc(venueName(v))}</span>`);
      else if (v && v.status === 'preprint') out.push('<span class="vn">arXiv</span>');
    }
    if (Number(i.pages) > 0) out.push(`<span>${esc(plural(Number(i.pages), 'page'))}</span>`);
    const at = statusOf(i) === 'reading' ? progress(i) : '';
    if (at) out.push(`<span class="rc-p" title="Where you stopped reading">${esc(at)}</span>`);
    if (groupBy !== 'category') out.push(`<span class="m-cat"><span class="cat-dot" style="background:${esc(color(catOf(i)))}"></span><span${catOf(i) === UNCAT ? '' : ' data-i18n-skip'}>${esc(catOf(i))}</span></span>`);
    return out.join('');
  }
  function rowHtml(i) {
    const tags = tagsOf(i);
    let state = '';
    if (i.categoryStatus === 'pending') state = '<span class="grouping" title="Claude is choosing a category"><span class="spin"></span>Grouping…</span>';
    else if (i.categoryStatus === 'failed') state = `<span class="grp-failed" data-brand-keep title="${esc(i.categoryError || 'Grouping failed')}">${RT.icon('warning')}<span>Not grouped</span></span><button class="mini ib" data-retry="${esc(i.id)}" title="Retry grouping: ask Claude again" aria-label="Retry grouping">${RT.icon('refresh')}</button>`;
    const kp = (i.keypoints || []).length;
    const chips = (i.pdf ? '' : '<span class="badge nopdf" title="No PDF attached: open the paper to attach one">No PDF</span>')
      + (kp ? `<span class="badge kp" title="Key points">${KP_IC}${kp}</span>` : '')
      + `<code>${esc(i.citekey)}</code>`
      + tags.slice(0, 3).map((t) => `<button class="tag${tagFilter && t.toLowerCase() === tagFilter.toLowerCase() ? ' on' : ''}" data-tag="${esc(t)}" title="Show only papers tagged “${esc(t)}”">${esc(t)}</button>`).join('')
      + (tags.length > 3 ? `<span class="tag more" title="${esc(tags.slice(3).join(', '))}">+${tags.length - 3}</span>` : '');
    // the brief: two lines under the title (Category grouping), the whole text when the pointer rests on it
    const brief = !showBriefs || groupBy !== 'category' ? '' : i.brief ? `<div class="brief" data-i18n-skip title="${esc(i.brief)}">${i.briefStatus === 'pending' ? '<span class="spin"></span>' : ''}${esc(i.brief)}</div>`
      : i.briefStatus === 'pending' ? '<div class="brief wait"><span class="spin"></span>Claude is writing the brief…</div>' : '';
    return `
    <div class="item${i.id === RT.state.sel ? ' sel' : ''}${picked.has(i.id) ? ' picked' : ''}" data-id="${esc(i.id)}" draggable="true" tabindex="-1"${i.id === RT.state.sel ? ' aria-current="true"' : ''}>
      <div class="th">${statusDot(i)}<div class="t" data-i18n-skip>${esc(showTitle(i))}</div>${projBtn(i)}${starBtn(i)}</div>
      <div class="by"><span class="au">${esc(authorsShort(i.fields.author))}</span></div>
      <div class="m">${metaBits(i)}</div>${brief}
      <div class="tags">${chips}${state}</div>${hitsHtml(i)}
    </div>`;
  }

  // The list is drawn again as a whole (also when a passage is clicked): keep how far a paper's long list of
  // passages was scrolled, and the keyboard focus on a passage, a row or a group header.
  function keepPassages() {
    const idOf = (el) => { const it = el.closest('.item'); return it ? it.dataset.id : ''; };
    const tops = $$('#list .hits.all').map((el) => [idOf(el), el.scrollTop]).filter(([, top]) => top > 0);
    const a = document.activeElement, focus = a && a.closest && a.closest('#list .hits') ? [idOf(a), a.dataset.hit, a.dataset.more] : null;
    const inList = a && a.closest && a.closest('#list');
    const rowAt = inList && a.classList.contains('item') ? [a.dataset.id, slotOf(a)] : null;
    const grpAt = inList && a.classList.contains('grp') ? a.dataset.key : null;
    return () => {
      if (rowAt) { const el = rowEl(rowAt[0], rowAt[1]); if (el) el.focus({ preventScroll: true }); }
      if (grpAt !== null) { const el = $$('#list .grp').find((g) => g.dataset.key === grpAt); if (el) el.focus({ preventScroll: true }); }
      const row = (id) => $$('#list .item').find((el) => el.dataset.id === id && $('.hits', el));
      for (const [id, top] of tops) { const el = row(id) && $('.hits.all', row(id)); if (el) el.scrollTop = top; }
      const r = focus && row(focus[0]);
      if (!r) return;
      const el = (focus[1] !== undefined && $$('.hit', r).find((b) => b.dataset.hit === focus[1])) || (focus[2] !== undefined && ($('button.hit-more', r) || $('.hit', r)));
      if (el) el.focus({ preventScroll: true });
    };
  }
  // what the list below the pinned groups is called (the divider between them)
  const DIVIDER = { category: 'Categories', status: 'Reading status', year: 'Years', venue: 'Venues', project: 'Projects', none: 'All papers' };
  function renderList() {
    if (statusFilter === 'project' && PP.loaded() && !PP.working()) setShow(null); // the working project is gone: show all
    const keep = keepPassages();
    const shown = visible();
    order = [];
    let html = '';
    const recent = recentOf();
    if (recent.length) { // not part of `order`: Shift-click ranges and the selection work on the list below
      const shut = !!collapsed.recent;
      html += `<div class="grp-wrap recent-wrap pinned">
        <div class="grp grp-pin${shut ? ' collapsed' : ''}" data-key="recent" role="button" tabindex="0" aria-expanded="${shut ? 'false' : 'true'}" title="The papers you opened last">
          ${CHEV}<span class="grp-pin-ic">${RT.icon('history')}</span><span class="grp-name">Continue reading</span><span class="grp-count sh-count">${recent.length}</span>
        </div>${shut ? '' : recent.map(recentRowHtml).join('')}</div>`;
    }
    const pg = projectGroup();
    if (pg && pg.list.length) html += projGroupHtml(pg);
    if (html && shown.length) html += `<div class="section-head ll-divider" role="presentation"><span class="sh-title">${DIVIDER[groupBy] || 'All papers'}</span><span class="sh-count">${shown.length}</span></div>`;
    for (const g of groupsOf(shown)) {
      const isCollapsed = g.key && collapsed[g.key];
      const hue = g.cat ? ` style="--cat:${esc(color(g.name))}"` : '';
      if (g.line) { // a research line: its own papers, then its sub-lines, each a group that can be closed
        html += `<div class="grp-wrap line-wrap" data-cat="${esc(g.name)}" data-line="${esc(g.name)}"${hue}>${grpHead(g, { cls: ' grp-line' })}`;
        if (!isCollapsed) {
          for (const i of g.direct) { order.push(i.id); html += rowHtml(i); }
          for (const c of g.children) {
            html += `<div class="grp-wrap sub-wrap" data-cat="${esc(c.name)}" style="--cat:${esc(color(c.name))}">${grpHead(c, { cls: ' grp-sub', label: c.sub })}`;
            if (!collapsed[c.key]) for (const i of c.items) { order.push(i.id); html += rowHtml(i); }
            html += '</div>';
          }
        }
        html += '</div>';
        continue;
      }
      if (g.key) html += `<div class="grp-wrap${g.cat ? ' cat-wrap' : ''}" ${g.cat ? `data-cat="${esc(g.name)}"` : ''}${g.pid ? `data-pid="${esc(g.pid)}"` : ''}${hue}>
        ${grpHead(g)}`;
      if (!isCollapsed) { for (const i of g.items) { order.push(i.id); html += rowHtml(i); } }
      if (g.key) html += '</div>';
    }
    const list = $('#list');
    list.innerHTML = html;
    if (!shown.length) list.append(emptyEl());
    keep();
    tabStop();
    renderSearchInfo(shown);
    renderChrome();
    renderVenueBar();
    renderJobs();
  }
  // the list has nothing to show: an empty library (import), or nothing matches the search / the filters
  const LOOKS_LIKE_ID = (q) => REF_RE.test(bare(q));
  function emptyEl() {
    if (!items.length) {
      return RT.emptyState({ ill: 'onboardingImport', title: 'Your library is empty', text: 'Import PDFs or a .bib file, or drop them anywhere on the page.',
        actions: [{ label: 'Import papers', icon: 'import', primary: true, onClick: () => $('#btn-import-pdf').click() },
          { label: 'Add by DOI or arXiv', icon: 'doi', onClick: () => $('#btn-paste-bib').click() }] });
    }
    const q = $('#search').value.trim(), filtered = !!(tagFilter || statusFilter);
    const el = RT.emptyState({ ill: 'emptySearch', compact: true,
      title: q ? `No papers match “${q}”` : 'No papers match these filters',
      text: q && filtered ? 'The filters above the list are on too.' : '',
      actions: [
        q && !deep() ? { label: 'Search inside PDFs too', icon: 'audit', primary: true, onClick: () => setScope('all') } : null,
        filtered ? { label: 'Clear filters', icon: 'close', primary: !q || deep(), onClick: clearFilters } : null,
        q ? { label: `Search everywhere (${RT.modKey || '⌘'}K)`, icon: 'search', onClick: () => searchEverywhere(q) } : null,
        q && LOOKS_LIKE_ID(q) ? { label: 'Add by DOI or arXiv', icon: 'doi', onClick: () => { $('#btn-paste-bib').click(); $('#bib-text').value = q; } } : null,
      ] });
    return el;
  }
  function clearFilters() { tagFilter = null; setShow(null); renderList(); }
  function searchEverywhere(q) { if (RT.nav && RT.nav.search) RT.nav.search(q || undefined); else if (RT.palette && RT.palette.open) RT.palette.open(); }
  // the filter chips (the same filter as before: one at a time; rt.lib.show) with their counts, the tag filter, and
  // "Clear filters" when one is on
  const CHIPS = [[null, 'All'], ['unread', 'To read'], ['reading', 'Reading'], ['done', 'Done'], ['starred', 'Starred'], ['nopdf', 'No PDF']];
  const GROUP_LABEL = { category: 'Category', status: 'Reading status', year: 'Year', venue: 'Venue', project: 'Project', none: 'No grouping' };
  function renderChrome() {
    $('#btn-expand-all').disabled = $('#btn-collapse-all').disabled = groupBy === 'none';
    $('#view-label').textContent = GROUP_LABEL[groupBy] || 'Category';
    const tf = $('#tag-filter'); tf.hidden = !items.length && !tagFilter && !statusFilter; // an empty library: nothing to filter
    const n = { null: items.length, unread: 0, reading: 0, done: 0, starred: 0, nopdf: 0 };
    for (const i of items) { n[statusOf(i)]++; if (i.starred) n.starred++; if (!i.pdf) n.nopdf++; }
    const a = document.activeElement, had = a && a.closest && a.closest('#tag-filter') ? (a.dataset.show !== undefined ? 's:' + a.dataset.show : a.id) : null;
    const w = PP.working();
    tf.innerHTML = CHIPS.map(([v, label]) => { const on = statusFilter === v; return `<button type="button" class="chip${on ? ' on' : ''}" data-show="${v || ''}" aria-pressed="${on}">${label}<span class="chip-n">${n[v]}</span></button>`; }).join('')
      + (statusFilter === 'project' && w ? `<button type="button" class="chip on" data-show="project" aria-pressed="true" title="Show all papers again">${RT.icon('bookmark')}<span>In “${esc(w.name)}”</span></button>` : '')
      + (tagFilter ? `<button type="button" class="chip on" id="tag-chip" aria-pressed="true" title="Tag filter: click to show all tags again">${RT.icon('tag')}<span data-i18n-skip>${esc(tagFilter)}</span>${RT.icon('close')}</button>` : '')
      + (tagFilter || statusFilter ? '<button type="button" class="ll-clear" id="tag-clear" title="Clear the filters (show all papers)">Clear filters</button>' : '');
    if (had) { const el = had.startsWith('s:') ? $$('#tag-filter [data-show]').find((b) => b.dataset.show === had.slice(2)) : had && $('#' + had); (el || $('#tag-filter .chip.on') || $('#tag-filter .chip')).focus({ preventScroll: true }); }
    const bulk = $('#bulk');
    bulk.hidden = !picked.size;
    if (picked.size) bulk.innerHTML = `<b>${picked.size} selected</b><span class="spacer"></span>${RT.compare ? `<button class="mini ib" data-bulk="compare" title="Ask these papers: compare them in a table, or ask them one question (Claude reads each paper once)" aria-label="Compare or ask the selected papers">${RT.icon('table')}</button>` : ''}<button class="mini ib" data-bulk="project" title="${esc(PP.working() ? `Add the selected papers to “${PP.working().name}”` : 'Add the selected papers to a project')}" aria-label="Add to project">${RT.icon(PP.ICON)}</button><button class="mini ib" data-bulk="notes-zip" title="Export paper packages (.zip): a folder per paper with its note and pictures, PDF, BibTeX and links (project page, code, arXiv, DOI)" aria-label="Export paper packages">${RT.icon('zip')}</button><button class="mini ib" data-bulk="move" title="Move the selected papers to a category" aria-label="Move to a category">${RT.icon('folder')}</button><button class="mini ib" data-bulk="tag" title="Add a tag to the selected papers" aria-label="Add a tag">${RT.icon('tag')}</button><button class="mini ib danger" data-bulk="delete" title="Delete the selected papers" aria-label="Delete">${RT.icon('trash')}</button><button class="mini ib" data-bulk="clear" title="Clear the selection (Esc)" aria-label="Clear the selection">${RT.icon('close')}</button>`;
    renderChip();
    const briefs = briefPending();
    const pend = pendingCount() + briefs, failed = items.filter((i) => i.categoryStatus === 'failed').length;
    const busy = [pendingCount() ? `grouping ${plural(pendingCount(), 'paper')}` : '', briefs ? `writing the brief of ${plural(briefs, 'paper')}` : ''].filter(Boolean).join(' and ');
    $('#group-status').innerHTML = (pend ? `<span title="Claude is ${busy}"><span class="spin"></span>${pend}</span>` : '')
      + (briefs ? `<button class="mini ib" id="briefs-stop" title="Stop writing the briefs (the ones already written stay)" aria-label="Stop writing the briefs">${RT.icon('stop')}</button>` : '')
      + (failed ? `${pend ? ' · ' : ''}<span class="grp-failed" title="${plural(failed, 'paper')} could not be grouped">${RT.icon('warning')}${failed}</span> <button class="mini ib" id="retry-all" title="Retry grouping: ask Claude to group them again" aria-label="Retry grouping">${RT.icon('refresh')}</button>` : '');
  }

  // the "Project" chip: the working project (click to switch it; rows dropped on it are added to it)
  function renderChip() {
    const b = $('#proj-chip'), w = PP.working(), n = PP.projects().length;
    b.hidden = !PP.loaded(); b.parentElement.hidden = b.hidden;
    const name = w ? w.name : 'No project';
    b.innerHTML = `${RT.icon('bookmark')}${w ? '<span class="pc-lab">Project:</span>' : ''}<span class="pc-name"${w ? ' data-i18n-skip' : ''}>${esc(name)}</span>${RT.icon('chevron-down', 'pc-caret')}`;
    b.classList.toggle('on', !!w);
    const hint = w ? `Working project: “${w.name}”. Papers you bookmark are added to this project. Click to switch it; drop papers here to add them.`
      : n ? 'No working project: click to choose the project the bookmark of a row adds papers to' : PP.NO_PROJECT + ': then papers can be added to it from here.';
    b.title = hint; b.setAttribute('aria-label', 'Project: ' + name);
  }
  // a menu by a control, from entries in the shape of the categories menu ({label, run, check, danger, own: the label
  // is the user's (not translated)} | {head} | '-'), drawn by RT.menu (keyboard, focus back on the control); a second
  // click on the same control closes it
  let llMenu = null;
  function popMenu(anchor, entries, opts = {}) {
    if (llMenu && llMenu.anchor === anchor && llMenu.el.isConnected) { llMenu.close(true); llMenu = null; return null; }
    if (!RT.menu) { const r = anchor.getBoundingClientRect(); if (C().menu) C().menu(r.left, r.bottom + 3, entries); return null; }
    const its = [];
    for (const en of entries) {
      if (!en) continue;
      if (en === '-') its.push({ sep: true });
      else if (en.head) its.push({ heading: en.head });
      else its.push({ label: en.label, danger: en.danger, disabled: en.disabled, icon: 'check' in en ? (en.check ? 'check' : null) : en.icon, onClick: en.run, ck: 'check' in en ? !!en.check : undefined, own: en.own });
    }
    const m = RT.menu(anchor, its, opts);
    const btns = $$('.mi', m.el); let k = 0;
    for (const it of its) {
      if (it.sep || (it.heading && !it.label)) continue;
      const b = btns[k++]; if (!b) break;
      if (it.own) { const l = $('.mi-label', b); if (l) l.dataset.i18nSkip = ''; }
      if (it.ck === undefined) continue;
      b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', String(it.ck));
      if (!it.ck) b.insertAdjacentHTML('afterbegin', '<span class="ic mi-blank" aria-hidden="true"></span>');
    }
    llMenu = m;
    return m;
  }
  function chipMenu(anchor) {
    const w = PP.working(), ps = PP.projects();
    if (!ps.length) return popMenu(anchor, [{ head: 'No project yet' }, { label: PP.NO_PROJECT + ': go there', run: () => RT.setView('write') }]);
    popMenu(anchor, [{ head: 'Working project' }, ...ps.map((p) => ({ label: `${p.name}${p.papers ? ` (${p.papers})` : ''}`, own: true, check: !!w && w.id === p.id, run: () => PP.setWorking(p.id) })),
      ...(w ? ['-', { label: `Show only the papers in “${w.name}”`, check: statusFilter === 'project', run: () => { setShow(statusFilter === 'project' ? null : 'project'); renderList(); } },
        ...projActions(w.id)] : [])]);
  }
  // the actions on the papers of one project (the ⋯ of its group, the chip)
  function projActions(pid) {
    const p = PP.project(pid); if (!p) return [];
    // in the order they were added to the project (compare takes the first 15)
    const ids = async () => { let l; try { l = (await PP.papers(pid)).papers.map((r) => r.id); } catch { l = [...PP.members(pid)]; } return l.filter((id) => items.some((i) => i.id === id)); };
    const d = PP.papersNow(pid);
    return [
      ...(RT.quiz && RT.quiz.review ? [{ label: `Review this project${d && d.counts.due ? ` (${plural(d.counts.due, 'question')} due)` : ''}`, run: () => RT.quiz.review({ project: pid }) }] : []),
      ...(RT.compare && RT.compare.start ? [{ label: 'Compare these papers…', run: async () => { const l = await ids(); if (l.length < 2) return toast('A comparison needs at least two papers in the project.', 'bad'); RT.compare.start(l); } }] : []),
      ...(RT.organize ? [{ label: 'Add papers from a .md / .bib file…', run: () => RT.organize.open({ pid }) }] : []),
      { label: 'Export reading pack', run: () => PP.readingPack(pid) },
      { label: 'Download reading pack (.zip, paper packages)', run: () => PP.readingPackZip(pid) },
      ...(RT.write && RT.write.openProject ? [{ label: `Open “${p.name}” in Write`, run: () => PP.openInWrite(pid) }] : []),
    ];
  }
  // the checklist of a project: what is not read, has no note, is not cited yet (a click opens the paper)
  async function projChecklist(pid, anchor) {
    let d;
    try { d = await PP.papers(pid); } catch (e) { return toast('Could not load the papers of the project: ' + e.message, 'bad'); }
    const have = new Set(items.map((i) => i.id)), MAX = 6, out = [];
    const part = (head, rows) => {
      rows = rows.filter((r) => have.has(r.id));
      if (!rows.length) return;
      if (out.length) out.push('-');
      out.push({ head: `${rows.length} ${head}` }, ...rows.slice(0, MAX).map((r) => ({ label: r.title || r.citekey, own: true, run: () => select(r.id) })));
      if (rows.length > MAX) out.push({ head: `… and ${rows.length - MAX} more` });
    };
    part('not read yet', d.papers.filter((r) => r.status === 'unread'));
    part('read without a note', d.papers.filter((r) => r.status !== 'unread' && !r.hasNote));
    part('not cited yet', d.papers.filter((r) => !r.cited));
    if (!out.length) out.push({ head: 'Nothing left to do: every paper is read, noted and cited' });
    popMenu(anchor, out);
  }

  // open a reference: highlight it here and let the reader show it
  function select(id) {
    RT.state.sel = id;
    picked.clear(); anchor = id;
    renderList();
    RT.emit('item:open', { id });
  }

  $('#list').addEventListener('click', (e) => {
    const t = e.target;
    const hit = t.closest('[data-hit]'), moreHit = t.closest('[data-more]');
    if (hit || moreHit) {
      const id = (hit || moreHit).closest('.item').dataset.id, r = ft.papers[id];
      if (moreHit) moreHits(id); else if (r && r.hits[Number(hit.dataset.hit)]) openHit(id, r.hits[Number(hit.dataset.hit)]);
      return;
    }
    const pj = t.closest('[data-proj]');
    if (pj) { // without a working project yet: choose one, it becomes the working project
      if (PP.working() || !PP.projects().length) PP.toggle([pj.dataset.proj]);
      else { const r = pj.getBoundingClientRect(); PP.pick({ title: 'Add to project', x: r.left, y: r.bottom + 3, current: false }).then((pid) => { if (pid) { PP.setWorking(pid); PP.toggle([pj.dataset.proj], { pid, on: true }); } }); }
      return;
    }
    const pmenu = t.closest('[data-pmenu]');
    if (pmenu) { popMenu(pmenu, projActions(pmenu.dataset.pmenu), { align: 'end' }); return; }
    const pst = t.closest('[data-pstats]');
    if (pst) { projChecklist(pst.dataset.pstats, pst); return; }
    const more = t.closest('[data-menu]');
    if (more) { const r = more.getBoundingClientRect(); if (C().headerMenu) C().headerMenu(more.dataset.menu, r.left, r.bottom + 2); return; }
    const retry = t.closest('[data-retry]');
    if (retry) return void categorize([retry.dataset.retry]);
    const st = t.closest('[data-status]');
    if (st) { popMenu(st, statusEntries([st.dataset.status])); return; }
    const star = t.closest('[data-star]');
    if (star) { const it = items.find((i) => i.id === star.dataset.star); if (it) setStatus([it.id], { starred: !it.starred }); return; }
    const tag = t.closest('[data-tag]');
    if (tag) { tagFilter = tagFilter && tagFilter.toLowerCase() === tag.dataset.tag.toLowerCase() ? null : tag.dataset.tag; renderList(); return; }
    const grp = t.closest('.grp');
    if (grp) return toggleGroup(grp.dataset.key);
    const el = t.closest('.item');
    if (!el) return;
    const id = el.dataset.id;
    if (e.metaKey || e.ctrlKey) {
      // start from the open item so "open one, Cmd-click another" selects both
      if (!picked.size && RT.state.sel && RT.state.sel !== id && order.includes(RT.state.sel)) picked.add(RT.state.sel);
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      anchor = id; renderList();
    } else if (e.shiftKey && anchor && order.includes(anchor) && order.includes(id)) { // (a "Continue reading" row whose paper sits in a collapsed group has no place in the range)
      const b = posOf(id, 0, el), a = posOf(anchor, b);
      for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(x);
      renderList();
    } else select(id);
  });
  // ---------------- keyboard ----------------
  // Rows and group headers take the focus. Up / Down (Home / End) move over them, Enter opens the paper (or opens /
  // closes the group), Shift+Up / Down extend the selection, Space adds the row to it or takes it out, forward Delete or
  // Cmd/Ctrl+Backspace (as in Finder) deletes the row (or the selection it is part of), Left / Right close / open a group. Only one row or
  // header is a Tab stop (the focused one, else the open paper, else the first), so Tab leaves the list instead of walking it.
  // A paper can have several rows: in "Continue reading", in the pinned project group, and (grouped by project) once per
  // project. slotOf(row) tells them apart: 'recent', 'proj' or the key of its group; rowEl(id) without a slot is the
  // first row in the list below the pinned groups.
  const slotOf = (el) => { const w = el.closest('.grp-wrap'); if (!w) return ''; if (w.classList.contains('proj-wrap')) return 'proj'; if (w.classList.contains('recent-wrap')) return 'recent'; const g = w.querySelector(':scope > .grp'); return g ? g.dataset.key : ''; };
  const rowEl = (id, slot) => { const rows = $$('#list .item').filter((el) => el.dataset.id === id); return rows.find((el) => (slot === undefined ? !el.classList.contains('recent') : slotOf(el) === slot)) || rows[0] || null; };
  // the place of a row in `order` (a paper in several project groups is in it more than once): that very row when it is
  // in the list below, else the copy of the id nearest to `near`
  const mainRows = () => $$('#list .item').filter((el) => !el.classList.contains('recent'));
  function posOf(id, near = 0, el = null) {
    if (el && !el.classList.contains('recent')) { const k = mainRows().indexOf(el); if (k >= 0 && order[k] === id) return k; }
    let best = -1;
    order.forEach((x, k) => { if (x === id && (best < 0 || Math.abs(k - near) < Math.abs(best - near))) best = k; });
    return best;
  }
  const navEls = () => $$('#list .item, #list .grp');
  function tabStop() {
    const els = navEls(), rows = els.filter((el) => el.classList.contains('item')); if (!els.length) return;
    const a = document.activeElement, cur = a && a.closest ? a.closest('#list .item, #list .grp') : null; // (or a button inside it)
    const stop = cur || rows.find((r) => r.classList.contains('sel') && !r.classList.contains('recent')) || rows.find((r) => r.classList.contains('sel')) || rows[0] || els[0];
    for (const el of els) el.tabIndex = el === stop ? 0 : -1; // the group headers too: the arrows reach them
    // the small buttons of a row or a header (status dot, star, tags, category menu) are reached by Tab from that row
    // only; the passages of a full-text search stay Tab stops
    for (const b of $$('#list .item > .th button, #list .item > .tags button, #list .grp button')) b.tabIndex = b.closest('.item, .grp') === stop ? 0 : -1;
  }
  function focusEl(el) {
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
    tabStop();
    return true;
  }
  // put the keyboard in the list: on the row that is the Tab stop (the open paper, else the first row)
  const focusList = () => focusEl(navEls().find((el) => el.tabIndex === 0) || navEls()[0]);
  function focusSearch() { const q = $('#search'); q.focus(); q.select(); }
  // J / K (palette.js): open the paper below / above the open one, in the order of the list. Opening a paper can
  // move it (it becomes "Reading", it was opened last), so a run of J / K walks the list as it was at its first step.
  let trail = null; // { sig, ids, at }
  function step(dir) {
    if (!order.length) return false;
    const sig = [groupBy, sortBy, tagFilter, statusFilter, $('#search').value, order.length].join('\n');
    if (!trail || trail.sig !== sig || trail.ids[trail.at] !== RT.state.sel) trail = { sig, ids: [...order], at: order.indexOf(RT.state.sel) };
    let next = trail.at < 0 ? 0 : trail.at + dir;
    while (trail.ids[next] !== undefined && !order.includes(trail.ids[next])) next += dir; // not in the list any more
    const id = trail.ids[next];
    if (id === undefined) return false;
    const a = document.activeElement, had = !!(a && a.closest && a.closest('#list'));
    trail.at = next;
    select(id);
    const el = rowEl(id);
    if (el) { if (had) focusEl(el); else el.scrollIntoView({ block: 'nearest' }); }
    return true;
  }
  $('#list').addEventListener('keydown', (e) => {
    const el = e.target;
    if (e.isComposing || e.keyCode === 229 || !el.classList) return;
    const isRow = el.classList.contains('item'), isGrp = el.classList.contains('grp');
    if ((!isRow && !isGrp) || e.metaKey || e.ctrlKey || e.altKey) return; // a button inside a row keeps its own keys
    const k = e.key, els = navEls(), at = els.indexOf(el);
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      done();
      const dir = k === 'ArrowDown' ? 1 : -1;
      if (e.shiftKey && isRow && (k === 'ArrowDown' || k === 'ArrowUp')) { // extend the selection over the papers (headers are passed over)
        let to = at + dir; while (els[to] && !els[to].classList.contains('item')) to += dir;
        const target = els[to]; if (!target) return;
        const id = el.dataset.id, tid = target.dataset.id, slot = slotOf(target);
        if (!anchor || !order.includes(anchor)) anchor = id;
        if (order.includes(anchor) && order.includes(tid)) {
          const b = posOf(tid, 0, target), a = posOf(anchor, b);
          picked.clear();
          for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(x);
          renderList();
        }
        focusEl(rowEl(tid, slot));
        return;
      }
      const target = k === 'Home' ? els[0] : k === 'End' ? els[els.length - 1] : els[at + dir];
      if (!target) return;
      if (target.classList.contains('item')) anchor = target.dataset.id; // a Shift+arrow that follows starts here
      focusEl(target);
    } else if (isGrp) {
      const shut = el.classList.contains('collapsed');
      if (k === 'Enter' || k === ' ' || (k === 'ArrowRight' && shut) || (k === 'ArrowLeft' && !shut)) { done(); toggleGroup(el.dataset.key); }
    } else if (k === 'Enter') { done(); select(el.dataset.id); }
    else if (k === ' ') { // like Cmd/Ctrl-click
      done();
      const id = el.dataset.id;
      if (!order.includes(id)) return; // a "Continue reading" row is not part of the selection
      if (!picked.size && RT.state.sel && RT.state.sel !== id && order.includes(RT.state.sel)) picked.add(RT.state.sel);
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      anchor = id; renderList();
    } else if (k === 'ArrowLeft') { const wrap = el.closest('.grp-wrap'), g = wrap && $('.grp', wrap); if (g) { done(); focusEl(g); } }
    else if (k === 'Delete' || (k === 'Backspace' && (e.metaKey || e.ctrlKey))) { // a plain Backspace does nothing: it is too easy to tap while correcting a search
      done();
      if (e.repeat) return; // a held key must not empty the list
      const id = el.dataset.id, ids = picked.has(id) ? [...picked] : [id];
      deleteDialog(ids).then(() => { // the keyboard stays in the list, on the row that took the place of the deleted one
        const a = document.activeElement;
        if (document.querySelector('dialog[open]') || (a && a !== document.body && a.isConnected)) return; // not deleted after all, or the focus went elsewhere meanwhile
        const now = navEls(); focusEl(now[Math.min(at, now.length - 1)]);
      }).catch((err) => toast(err.message, 'bad'));
    }
  });
  // Down in the search box goes to the list
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !e.isComposing && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && navEls().length) { e.preventDefault(); focusList(); } });
  $('#list').addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); }); // no text selection on Shift-click
  function toggleGroup(key) {
    if (collapsed[key]) delete collapsed[key]; else collapsed[key] = true;
    ls.set('rt.lib.collapsed', JSON.stringify(collapsed));
    renderList();
  }
  $('#list').addEventListener('contextmenu', (e) => {
    if (!C().menu) return;
    const grp = e.target.closest('.grp-wrap[data-cat] .grp');
    if (grp) { e.preventDefault(); C().headerMenu(grp.parentElement.dataset.cat, e.clientX, e.clientY); return; }
    const el = e.target.closest('.item');
    if (!el) return;
    e.preventDefault();
    const ids = picked.has(el.dataset.id) ? [...picked] : [el.dataset.id];
    const n = ids.length > 1 ? ` ${ids.length} papers` : '';
    C().menu(e.clientX, e.clientY, [
      ...statusEntries(ids), '-',
      { label: `Move${n} to category…`, run: () => moveDialog(ids) },
      { label: `Add tag${n ? ' to' + n : ''}…`, run: () => tagDialog(ids) },
      { label: `Group${n} with Claude again`, run: () => categorize(ids) },
      { label: ids.length > 1 ? `Write the briefs of${n} with Claude` : 'Write the brief with Claude', run: () => writeBriefs(ids) },
      { label: ids.length > 1 ? `Check the venues of${n} again` : 'Check venue again', run: () => checkVenues(ids, true) },
      ...(RT.compare && ids.length > 1 ? [{ label: `Compare or ask${n}…`, run: () => RT.compare.start(ids) }] : []),
      ...projEntries(ids, n, e.clientX, e.clientY),
      ...(RT.lineage && RT.lineage.check ? [{ label: n ? `Check lineage of${n}` : 'Check lineage', run: () => RT.lineage.check(ids) }] : []),
      '-',
      { label: n ? `Export paper packages of${n} (.zip)` : 'Export paper package (.zip)', run: () => PP.notesZip(ids) },
      { label: n ? `Export paper packages of${n} without the PDFs (.zip)` : 'Export paper package without the PDF (.zip)', run: () => PP.notesZip(ids, { pdf: false }) },
      '-',
      { label: n ? `Delete${n}…` : 'Delete', run: () => deleteDialog(ids), danger: true },
    ]);
  });

  // menu entries: add to / remove from the working project, add to another project
  function projEntries(ids, n, x, y) {
    const w = PP.working(), out = ['-'];
    if (w) {
      if (!ids.every((id) => PP.has(id, w.id))) out.push({ label: `Add${n} to “${w.name}”`, run: () => PP.toggle(ids, { pid: w.id, on: true }) });
      if (ids.some((id) => PP.has(id, w.id))) out.push({ label: `Remove${n} from “${w.name}”`, run: () => PP.toggle(ids, { pid: w.id, on: false }) });
    }
    out.push({ label: `Add${n} to project…`, run: async () => { const pid = await PP.pick({ title: `Add${n || ' this paper'} to`, x, y, current: false }); if (pid) await PP.toggle(ids, { pid, on: true }); } });
    return out;
  }

  $('#search').addEventListener('input', () => { $('#search-clear').hidden = !$('#search').value; if (deep()) searchChanged(); else renderList(); });
  $('#search-clear').addEventListener('click', () => { const q = $('#search'); q.value = ''; q.dispatchEvent(new Event('input')); q.focus(); });
  $('#search-all').addEventListener('click', () => searchEverywhere($('#search').value.trim()));
  $('#search-scope').addEventListener('click', () => setScope(deep() ? 'titles' : 'all'));
  renderScope();
  // View: Group by / Sort by / Briefs (the filters are the chips under the toolbar)
  $('#btn-view').addEventListener('click', (e) => {
    e.stopPropagation();
    const g = (v, label) => ({ label, check: groupBy === v, run: () => { groupBy = v; ls.set('rt.lib.group', v); renderList(); } });
    const s = (v, label) => ({ label, check: sortBy === v, run: () => { sortBy = v; ls.set('rt.lib.sort', v); renderList(); } });
    popMenu(e.currentTarget, [{ head: 'Group by' }, g('category', 'Category'), g('status', 'Reading status'), g('year', 'Year'), g('venue', 'Venue (verified)'), ...(PP.projects().length ? [g('project', 'Project')] : []), g('none', 'None'), '-',
      { head: 'Sort by' }, s('added', 'Date added'), s('opened', 'Last opened'), s('status', 'Reading status'), s('year', 'Year'), s('pubNew', 'Publication date (newest first)'), s('pubOld', 'Publication date (oldest first)'), s('title', 'Title'), '-',
      { head: 'Briefs' }, { label: 'Show the brief under each title', check: showBriefs, run: () => { showBriefs = !showBriefs; ls.set('rt.lib.briefs', showBriefs ? '1' : '0'); renderList(); } }]);
  });
  // More actions: expand / collapse all, Recently deleted, the venue check, the missing briefs
  $('#btn-ll-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const due = items.filter(venueDue).length, mb = missingBriefs().length, none = groupBy === 'none';
    popMenu(e.currentTarget, [
      { label: 'Expand all groups', icon: 'expand', disabled: none, run: () => setAllCollapsed(false) },
      { label: 'Collapse all groups', icon: 'collapse', disabled: none, run: () => setAllCollapsed(true) },
      '-',
      venues.running ? { label: `Stop the venue check (${Number(venues.running.done)}/${Number(venues.running.total)})`, icon: 'stop', run: stopVenues }
        : { label: due ? `Check venues of ${plural(due, 'paper')}…` : 'Every venue was checked in the last 30 days', icon: 'venue-verified', disabled: !due, run: () => checkVenues(null) },
      { label: mb === 1 ? 'Write the missing brief with Claude…' : mb ? `Write the ${mb} missing briefs with Claude…` : 'Every paper has a brief', icon: 'sparkle', disabled: !mb, run: () => confirmBriefs(mb) },
      '-',
      { label: 'Recently deleted…', icon: 'delete', run: () => $('#btn-trash').click() },
    ], { align: 'end' });
  });
  function setAllCollapsed(on) {
    for (const g of groupsOf(visible())) for (const x of [g, ...(g.children || [])]) { if (!x.key) continue; if (on) collapsed[x.key] = true; else delete collapsed[x.key]; }
    ls.set('rt.lib.collapsed', JSON.stringify(collapsed));
    renderList();
  }
  $('#btn-expand-all').addEventListener('click', () => setAllCollapsed(false));
  $('#btn-collapse-all').addEventListener('click', () => setAllCollapsed(true));
  $('#tag-filter').addEventListener('click', (e) => {
    if (e.target.closest('#tag-clear')) { clearFilters(); $('#search').focus(); return; }
    if (e.target.closest('#tag-chip')) { tagFilter = null; renderList(); return; }
    const c = e.target.closest('[data-show]');
    if (!c) return;
    const v = c.dataset.show || null;
    setShow(v === statusFilter && v !== null ? null : v); renderList();
  });
  $('#btn-regroup').addEventListener('click', () => { if (C().regroupDialog) C().regroupDialog({}); });
  $('#btn-trash').addEventListener('click', () => { if (RT.safety && RT.safety.trash) RT.safety.trash(); });
  $('#group-status').addEventListener('click', async (e) => {
    const stop = e.target.closest('#briefs-stop');
    if (!stop) return;
    stop.disabled = true;
    try { const r = await api('/api/briefs/stop', { method: 'POST', json: {} }); toast(r.stopped ? `Stopped: ${plural(r.stopped, 'paper')} left without a brief` : 'Nothing was waiting any more', 'ok'); }
    catch (err) { toast('Could not stop: ' + err.message, 'bad'); }
    await refresh();
  });
  $('#group-status').addEventListener('click', (e) => { if (e.target.closest('#retry-all')) categorize(items.filter((i) => i.categoryStatus === 'failed').map((i) => i.id)); });
  $('#bulk').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b) return;
    const ids = [...picked];
    if (b.dataset.bulk === 'clear') { picked.clear(); renderList(); }
    else if (b.dataset.bulk === 'compare') { if (RT.compare) RT.compare.start(ids); }
    else if (b.dataset.bulk === 'project') {
      if (PP.working()) PP.toggle(ids, { on: true });
      else { const r = b.getBoundingClientRect(); PP.pick({ title: `Add ${plural(ids.length, 'paper')} to`, x: r.left, y: r.bottom + 3, current: false }).then((pid) => pid && PP.toggle(ids, { pid, on: true })); }
    }
    else if (b.dataset.bulk === 'notes-zip') PP.notesZip(ids);
    else if (b.dataset.bulk === 'move') moveDialog(ids);
    else if (b.dataset.bulk === 'tag') tagDialog(ids);
    else if (b.dataset.bulk === 'delete') deleteDialog(ids);
  });
  document.addEventListener('keydown', (e) => {
    // Esc gives the selection up - unless the key was meant for something else: a box being typed in, the note, an
    // open menu, a list or a card of the PDF pane
    if (e.key !== 'Escape' || !picked.size || RT.state.view !== 'library' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const f = document.activeElement;
    if (f && f !== document.body && !f.closest('#library-list')) return;
    if (document.querySelector('.ctx-menu, .rt-menu, #detail .pn-panel:not([hidden]), #detail .hl-panel:not([hidden]), #detail .hl-pop:not([hidden]), #detail .rd-aipop:not([hidden]), #detail .rd-aimenu:not([hidden])')) return;
    picked.clear(); renderList();
  });

  // ---------------- changes: reading status and star, move, tag, delete, re-run grouping ----------------
  // patch: {status} and / or {starred}. The item objects are updated in place (the reader may hold unsaved edits of one).
  async function setStatus(ids, patch) {
    let failed = 0;
    for (const id of ids) {
      const it = items.find((i) => i.id === id); if (!it) continue;
      if ((!('status' in patch) || statusOf(it) === patch.status) && (!('starred' in patch) || !!it.starred === patch.starred)) continue;
      try {
        const r = await api('/api/items/' + enc(id), { method: 'PUT', json: patch });
        for (const k of ['status', 'starred']) { if (k in r.item) it[k] = r.item[k]; else delete it[k]; }
      } catch { failed++; }
    }
    if (failed) toast(`${plural(failed, 'paper')} could not be changed`, 'bad');
    renderList();
    selfEmit = true; try { RT.emit('item:updated', { ids }); } finally { selfEmit = false; }
  }
  // menu entries "Mark as ..." and the star for one or several papers
  function statusEntries(ids) {
    const its = ids.map((id) => items.find((i) => i.id === id)).filter(Boolean);
    const all = (fn) => its.length > 0 && its.every(fn);
    return [{ head: its.length > 1 ? `Mark ${its.length} papers as` : 'Mark as' },
      ...Object.keys(STATUS).map((k) => ({ label: STATUS[k], check: all((i) => statusOf(i) === k), run: () => setStatus(ids, { status: k }) })),
      { label: 'Starred', check: all((i) => i.starred), run: () => setStatus(ids, { starred: !all((i) => i.starred) }) }];
  }
  async function moveTo(ids, category) {
    ids = ids.filter((id) => { const it = items.find((i) => i.id === id); return it && catOf(it) !== category; });
    if (!ids.length) return;
    try {
      await api('/api/categories/apply', { method: 'POST', json: { manual: true, assignments: ids.map((id) => ({ id, category })) } });
      toast(`Moved ${plural(ids.length, 'paper')} to “${category}”`, 'ok');
    } catch (e) { toast('Could not move: ' + e.message, 'bad'); }
    await changed();
  }
  async function moveDialog(ids) {
    if (!ids.length || !C().ask) return;
    const name = await C().ask({ title: `Move ${plural(ids.length, 'paper')} to category`, message: 'Pick an existing category or type a new name.', options: [...C().names(), UNCAT], placeholder: 'Category', okLabel: 'Move', icon: 'folder' });
    if (name) await moveTo(ids, name);
  }
  async function tagDialog(ids) {
    if (!ids.length || !C().ask) return;
    const all = [...new Set(items.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b));
    const tag = await C().ask({ title: `Add a tag to ${plural(ids.length, 'paper')}`, options: all, placeholder: 'Tag', okLabel: 'Add tag', icon: 'tag', maxLength: 40 });
    if (!tag) return;
    let done = 0, full = 0, failed = 0;
    for (const id of ids) {
      const it = items.find((i) => i.id === id); if (!it) continue;
      const tags = tagsOf(it);
      if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
      if (tags.length >= 12) { full++; continue; }
      try { await api('/api/items/' + enc(id), { method: 'PUT', json: { tags: [...tags, tag] } }); done++; } catch { failed++; }
    }
    toast(`Tagged ${plural(done, 'paper')} with “${tag}”` + (full ? ` · ${full} already have 12 tags` : '') + (failed ? ` · ${failed} failed` : ''), failed ? 'bad' : 'ok');
    await changed();
  }
  // One paper is deleted at once - the message that follows has an Undo button, and the paper stays in "Recently
  // deleted". Several at a time are asked about first (and can be undone the same way).
  async function deleteDialog(ids) {
    if (!ids.length) return;
    const one = ids.length === 1 ? items.find((i) => i.id === ids[0]) : null;
    if (!one) {
      if (!C().ask) return;
      const ok = await C().ask({ title: 'Delete from the library', input: false, danger: true, okLabel: 'Delete',
        message: `Delete ${plural(ids.length, 'paper')} with their key points and notes? They are moved to Recently deleted, where you can put them back.` });
      if (!ok) return;
    }
    let failed = 0;
    const bins = [];
    const wasOpen = ids.includes(RT.state.sel);
    if (wasOpen && RT.reader && RT.reader.close) { try { await RT.flush('reader'); } catch {} RT.reader.close(); }
    for (const id of ids) { try { const r = await api('/api/items/' + enc(id), { method: 'DELETE' }); bins.push(r.bin); picked.delete(id); } catch { failed++; } }
    const label = one ? `“${one.fields.title || one.citekey}”` : plural(bins.length, 'paper');
    if (failed && !bins.length) toast(`${failed} could not be deleted`, 'bad');
    else if (RT.safety && RT.safety.deleted) RT.safety.deleted(bins, label + (failed ? ` (${failed} could not be deleted)` : ''));
    else toast(`Deleted ${label}`, 'ok');
    await changed();
  }
  // Briefs: `ids` = rewrite the brief of these papers; null = write the ones that are missing. Claude works in the
  // background (several papers per call); the poll above shows them as they arrive.
  const missingBriefs = () => items.filter((i) => !i.brief && i.briefStatus !== 'pending' && i.categoryStatus !== 'pending');
  // the menu item ends in "…": ask first, as the Overview does (writeBriefs(null) itself starts Claude at once)
  async function confirmBriefs(n) {
    const ok = await RT.confirm(`Claude writes the missing briefs of ${plural(n, 'paper')} in the background. This uses your Claude account. Start now?`,
      { title: 'Write the missing briefs', okText: 'Write briefs', icon: 'sparkle' });
    if (ok) await writeBriefs(null);
  }
  async function writeBriefs(ids) {
    try {
      if (ids) {
        let failed = 0;
        for (const id of ids) { try { await api(`/api/items/${enc(id)}/brief`, { method: 'POST' }); } catch { failed++; } }
        if (failed) toast(`${plural(failed, 'paper')} could not be queued for a brief`, 'bad');
      } else {
        const r = await api('/api/briefs', { method: 'POST', json: {} });
        toast(r.queued ? `Claude is writing the brief of ${plural(r.queued, 'paper')} - they appear in the list as they arrive` : 'Every paper already has a brief', 'ok');
      }
    } catch (e) { toast('Could not start writing the briefs: ' + e.message, 'bad'); }
    await changed();
  }
  async function categorize(ids) {
    let failed = 0;
    for (const id of ids) { try { await api(`/api/items/${enc(id)}/categorize`, { method: 'POST' }); } catch { failed++; } }
    if (failed) toast(`${failed} could not be queued for grouping`, 'bad');
    await changed();
  }

  // drag rows onto a category header (or anywhere inside that group)
  $('#list').addEventListener('dragstart', (e) => {
    const el = e.target.closest ? e.target.closest('.item') : null;
    if (!el) return;
    dragIds = picked.has(el.dataset.id) ? [...picked] : [el.dataset.id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-rt-items', JSON.stringify(dragIds));
    e.dataTransfer.setData('text/plain', dragIds.map((id) => (items.find((i) => i.id === id) || {}).citekey || '').join(', '));
    host.classList.add('moving');
  });
  const clearDrop = () => { for (const el of $$('#list .drop')) el.classList.remove('drop'); };
  $('#list').addEventListener('dragend', () => { dragIds = null; clearDrop(); host.classList.remove('moving'); });
  $('#list').addEventListener('dragover', (e) => {
    if (!dragIds) return;
    const wrap = e.target.closest('.grp-wrap[data-cat], .grp-wrap[data-pid]');
    clearDrop();
    if (!wrap) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    wrap.classList.add('drop');
  });
  $('#list').addEventListener('drop', (e) => {
    const wrap = e.target.closest('.grp-wrap[data-cat], .grp-wrap[data-pid]');
    const ids = dragIds; dragIds = null; clearDrop(); host.classList.remove('moving');
    if (!ids || !wrap) return;
    e.preventDefault();
    if (wrap.dataset.pid) PP.toggle(ids, { pid: wrap.dataset.pid, on: true }); // a project group: the papers join that project
    else moveTo(ids, wrap.dataset.cat);
  });
  // the "Project" chip: a click switches the working project, rows dropped on it join it
  const chip = $('#proj-chip');
  chip.addEventListener('click', (e) => { e.stopPropagation(); chipMenu(chip); });
  chip.addEventListener('dragover', (e) => { if (!dragIds || !PP.working()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; chip.classList.add('drop'); });
  chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
  chip.addEventListener('drop', (e) => {
    const ids = dragIds; dragIds = null; chip.classList.remove('drop'); clearDrop(); host.classList.remove('moving');
    if (!ids) return;
    e.preventDefault(); e.stopPropagation(); // (not a file drop for the import)
    PP.toggle(ids, { on: true });
  });

  // ---------------- import queue ----------------
  // job: { qid, kind: 'pdf'|'bib'|'ref', file | ref, name, state, pct, error, itemId, dup: {id, title}, note, force, noPdf }
  // state: queued | uploading | extracting | metadata | downloading | imported | dup | failed   ("imported" shows Grouping / Done)
  const jobs = [];
  const MAX_ACTIVE = 2;
  let active = 0, batch = null; // batch: { jobs of this run, imported, dup, failed }
  const STATE_TEXT = { queued: 'Waiting', uploading: 'Uploading', extracting: 'Extracting text', metadata: 'Looking up metadata', downloading: 'Downloading the PDF' };
  const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  const isBib = (f) => /\.bib(tex)?$/i.test(f.name);
  const isMd = (f) => /\.(md|markdown)$/i.test(f.name);

  function enqueue(files) {
    // a .md file is a reading list / outline: it opens "Organize from a file" (organize.js) instead of being imported
    const md = files.filter(isMd);
    if (md.length && RT.organize) {
      RT.setView('library');
      RT.organize.open({ file: md[0] });
      if (md.length > 1) toast(`Only one .md file is read at a time: “${md[0].name}”`);
      files = files.filter((f) => !isMd(f));
      if (!files.length) return;
    }
    const good = files.filter((f) => isPdf(f) || isBib(f));
    if (!good.length) return toast('Nothing to import: only PDF and .bib files are supported.', 'bad');
    RT.setView('library');
    if (!batch) batch = { jobs: [], imported: 0, dup: 0, failed: 0 };
    for (const f of good) { const j = { qid: 'q' + Math.random().toString(36).slice(2, 12), kind: isPdf(f) ? 'pdf' : 'bib', file: f, name: f.name, state: 'queued', pct: 0 }; jobs.push(j); batch.jobs.push(j); }
    if (good.length < files.length) toast(`${files.length - good.length} file${files.length - good.length === 1 ? ' is' : 's are'} not PDF or .bib and ${files.length - good.length === 1 ? 'was' : 'were'} skipped`);
    renderJobs(); pump();
  }
  // ---- papers added by reference: arXiv id or link, DOI or doi.org link, OpenReview link (the server, lib/refs.js,
  // has the last word on what each one is; this only tells a reference from other pasted text)
  const REF_RE = /^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z][a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\s*\[[\w.-]+\])?$|^(?:https?:\/\/)?(?:www\.|export\.)?(?:arxiv|alphaxiv)\.org\/(?:abs|pdf|html|format|ps)\/\S+$|^https?:\/\/[^\/\s]+\/\S*\b10\.\d{4,9}\/\S+$|^(?:(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/\S+$|^(?:https?:\/\/)?(?:www\.)?openreview\.net\/(?:forum|pdf|attachment)\?\S*\bid=[\w-]+\S*$/i;
  const bare = (t) => t.trim().replace(/^[-*•]\s+/, '').replace(/^[<"'\s]+|[>"',;.\s]+$/g, '');
  // pasted text -> { refs: the references in it, unknown: the pieces that are none }; several per line are fine
  function splitRefs(text) {
    const refs = [], unknown = [], seen = new Set();
    const add = (r) => { const k = r.toLowerCase(); if (!seen.has(k)) { seen.add(k); refs.push(r); } };
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = bare(raw);
      if (!line) continue;
      if (REF_RE.test(line)) { add(line); continue; }
      for (const tok of line.split(/[\s,;]+/).map(bare).filter(Boolean)) { if (REF_RE.test(tok)) add(tok); else unknown.push(tok); }
    }
    return { refs, unknown };
  }
  const refName = (r) => r.replace(/^https?:\/\/(www\.)?/i, '').replace(/^(dx\.)?doi\.org\//i, 'doi:').replace(/^(?:export\.)?(?:arxiv|alphaxiv)\.org\/(abs|pdf|html|format|ps)\//i, 'arXiv:').replace(/^(arxiv|doi):\s*/i, (x, k) => (k.toLowerCase() === 'arxiv' ? 'arXiv:' : 'doi:'));
  function enqueueRefs(refs, onDone) {
    if (refs.length > 100) { toast(`Only the first 100 of ${refs.length} references are added; paste the rest afterwards.`); refs = refs.slice(0, 100); }
    RT.setView('library');
    if (!batch) batch = { jobs: [], imported: 0, dup: 0, failed: 0 };
    for (const r of refs) { const j = { qid: 'q' + Math.random().toString(36).slice(2, 12), kind: 'ref', ref: r, name: refName(r), state: 'queued', pct: 0, onDone }; jobs.push(j); batch.jobs.push(j); }
    renderJobs(); pump();
  }
  // POST one reference; the server reports where it is (metadata, download, text extraction) through /api/import/progress
  async function fetchRef(j) {
    j.state = 'metadata'; renderJobs();
    let timer = setInterval(async () => {
      try {
        const r = await api('/api/import/progress?job=' + enc(j.qid));
        if (timer && r.stage && r.stage !== j.state && STATE_TEXT[r.stage]) { j.state = r.stage; renderJobs(); }
      } catch { /* keep the last stage */ }
    }, 500);
    try { return await api('/api/import/ref', { method: 'POST', json: { ref: j.ref, force: !!j.force, job: j.qid } }); }
    finally { clearInterval(timer); timer = null; }
  }

  function pump() {
    while (active < MAX_ACTIVE) {
      const j = jobs.find((x) => x.state === 'queued');
      if (!j) break;
      active++;
      runJob(j).catch((e) => { j.state = 'failed'; j.error = e.message || String(e); }).finally(() => {
        active--;
        if (batch) { if (j.state === 'imported') batch.imported += j.count || 1; else if (j.state === 'dup') batch.dup++; else if (j.state === 'failed') batch.failed++; }
        renderJobs(); pump();
        // (the Related tab waits for its "Add": told once, a Retry from the queue is not its business any more)
        if (j.onDone) { const told = j.onDone; j.onDone = null; try { told({ state: j.state, itemId: j.state === 'imported' ? j.itemId : null, dup: j.dup || null, error: j.error || '' }); } catch (e) { console.error(e); } }
        if (!active && !jobs.some((x) => x.state === 'queued')) finished();
      });
    }
  }
  // POST the PDF with upload progress; the server reports its stage through /api/import/progress
  function uploadPdf(j) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/import/pdf?name=${enc(j.name)}&job=${enc(j.qid)}${j.force ? '&force=1' : ''}`);
      x.setRequestHeader('X-RT', '1');
      x.setRequestHeader('Content-Type', 'application/pdf');
      let timer = null;
      const stop = () => { clearInterval(timer); timer = null; };
      x.upload.onprogress = (e) => { if (e.lengthComputable) { j.pct = Math.round(100 * e.loaded / e.total); renderJobs(); } };
      x.upload.onload = () => {
        j.state = 'extracting'; renderJobs();
        timer = setInterval(async () => {
          try { const r = await api('/api/import/progress?job=' + enc(j.qid)); if (timer && r.stage === 'metadata' && j.state === 'extracting') { j.state = 'metadata'; renderJobs(); } } catch { /* keep the last stage */ }
        }, 500);
      };
      x.onload = () => {
        stop();
        let data = {};
        try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || `Request failed (${x.status})`), { status: x.status, data }));
      };
      x.onerror = () => { stop(); reject(new Error('The server could not be reached')); };
      x.send(j.file);
    });
  }
  async function runJob(j) {
    j.state = 'uploading'; j.error = ''; j.dup = null; renderJobs();
    try {
      if (j.kind === 'pdf') {
        const r = await uploadPdf(j);
        j.itemId = r.item.id; j.count = 1;
      } else if (j.kind === 'ref') {
        const r = await fetchRef(j);
        j.itemId = r.item.id; j.count = 1;
        j.noPdf = !r.pdf; j.note = r.why || '';
        if (r.item.fields && r.item.fields.title) j.name = r.item.fields.title; // the row now names the paper, not the id
      } else {
        const text = await j.file.text();
        j.state = 'extracting'; renderJobs();
        const r = await api('/api/import/bibtex', { method: 'POST', json: { text, force: !!j.force } });
        j.itemId = r.items[0].id; j.count = r.items.length; // the first entry of the file
        j.note = plural(r.items.length, 'reference') + (r.skipped && r.skipped.length ? `, ${r.skipped.length} already in library` : '');
        if (r.skipped && r.skipped.length >= r.items.length) j.organize = { text, name: j.name, all: false }; // mostly known: offer to organize by it
      }
      j.state = 'imported';
      await refresh().catch(() => {});
    } catch (e) {
      if (j.kind === 'bib' && e.status === 409 && j.file) j.organize = { text: await j.file.text().catch(() => ''), name: j.name, all: true }; // every entry known
      if (e.status === 409 && e.data && e.data.duplicateOf) { j.state = 'dup'; j.dup = { id: e.data.duplicateOf, title: e.data.duplicateTitle || 'existing paper', reason: e.data.duplicateReason || '' }; }
      else { j.state = 'failed'; j.error = e.message || String(e); }
    }
  }
  async function finished() {
    const b = batch; batch = null;
    if (!b) return;
    try { await refresh(); } catch { /* the list shows what it has */ }
    selfEmit = true; try { RT.emit('library:changed'); } finally { selfEmit = false; }
    // open the first imported paper (in queue order, not the one that happened to finish first) if nothing is open
    const first = b.jobs.find((j) => j.state === 'imported' && items.some((i) => i.id === j.itemId));
    if (first && !RT.state.sel) select(first.itemId);
    const parts = [];
    if (b.imported) parts.push(`Imported ${plural(b.imported, 'paper')}`);
    if (b.dup) parts.push(`${b.dup} already in library`);
    if (b.failed) parts.push(`${b.failed} failed`);
    // a .bib file whose entries are at least half in the library already: its grouping may be what is wanted
    const org = RT.organize && b.jobs.find((j) => j.organize && j.organize.text);
    if (org) {
      const o = org.organize; org.organize = null;
      // every entry known: the file counts as one "already in library" above; say how many entries instead
      const n = (o.text.match(/@\s*(?!comment\b|string\b|preamble\b)[a-z]+\s*[{(]/gi) || []).length;
      const at = parts.findIndex((x) => /already in library$/.test(x));
      if (o.all && at >= 0) parts.splice(at, 1, ...(b.dup > 1 ? [`${b.dup - 1} already in library`] : []));
      const what = !o.all ? `most of ${o.name} is in the library already` : n > 1 ? `all ${n} entries of ${o.name} are in the library already` : `${o.name} is in the library already`;
      return toast([...parts, what].join(' · ') + ' - organize the library by it?', b.failed ? 'bad' : 'ok', { label: 'Organize the library by this file', icon: 'list', run: () => RT.organize.open({ text: o.text, name: o.name }) });
    }
    toast(parts.join(' · '), b.failed ? 'bad' : 'ok');
  }

  // what a row shows; an imported paper stays "Grouping with Claude" until its category arrives
  function jobView(j) {
    if (j.state === 'dup') return { cls: 'dup', html: `Already in library: <a href="#" data-open="${esc(j.dup.id)}">${esc(j.dup.title)}</a>${j.dup.reason ? ` <span class="muted">(${esc(j.dup.reason)})</span>` : ''}`, actions: `<button class="mini ib" data-force="${esc(j.qid)}" title="Import anyway, as a second copy" aria-label="Import anyway">${RT.icon('import')}</button>`, final: true };
    if (j.state === 'failed') return { cls: 'bad', html: `Failed: ${esc(j.error)}`, actions: `<button class="mini ib" data-again="${esc(j.qid)}" title="Retry this import" aria-label="Retry this import">${RT.icon('refresh')}</button>`, final: true };
    if (j.state === 'imported') {
      const it = items.find((i) => i.id === j.itemId);
      if (j.kind !== 'bib' && it && it.categoryStatus === 'pending') return { cls: 'busy', html: '<span class="spin"></span>Grouping with Claude' };
      const open = it ? ` <a href="#" data-open="${esc(it.id)}">Open</a>` : '';
      if (j.kind === 'bib') return { cls: 'ok', html: `Done · ${esc(j.note || '')}${open}`, done: true, final: true };
      // added without a PDF: the row stays until it is cleared, and opening the paper shows "Attach PDF"
      if (j.noPdf && it && !it.pdf) return { cls: 'dup', html: `Added without a PDF${j.note ? ': ' + esc(j.note) : ''}. <a href="#" data-open="${esc(it.id)}">Open it to attach the PDF</a>`, final: true };
      if (it && it.categoryStatus === 'failed') return { cls: 'ok', html: `Done · not grouped <button class="mini ib" data-retry="${esc(it.id)}" data-brand-keep title="Retry grouping${it.categoryError ? esc(' (' + it.categoryError + ')') : ''}" aria-label="Retry grouping">${RT.icon('refresh')}</button>${open}`, done: true, final: true };
      return { cls: 'ok', html: `Done${it && catOf(it) !== UNCAT ? ` · <span class="cat-dot" style="background:${esc(color(catOf(it)))}"></span>${esc(catOf(it))}` : ''}${open}`, done: true, final: true };
    }
    if (j.state === 'uploading') return { cls: 'busy', html: `<span class="spin"></span>Uploading${j.pct && j.pct < 100 ? ` ${j.pct}%` : ''}` };
    if (j.state === 'queued') return { cls: 'wait', html: 'Waiting' };
    return { cls: 'busy', html: `<span class="spin"></span>${STATE_TEXT[j.state] || esc(j.state)}` };
  }
  function renderJobs() {
    const el = $('#jobs');
    if (!jobs.length) { if (el.innerHTML) el.innerHTML = ''; return; }
    const views = jobs.map((j) => [j, jobView(j)]);
    const finishedN = views.filter(([, v]) => v.final).length;
    for (const [j, v] of views) { // finished rows leave on their own after a while; problems stay until dismissed
      if (v.done && !j.timer) j.timer = setTimeout(() => { const k = jobs.indexOf(j); if (k >= 0) jobs.splice(k, 1); renderJobs(); }, 12000);
    }
    el.innerHTML = `<div class="jobs-head"><b>Import</b><span class="muted">${finishedN} of ${jobs.length} finished</span><span class="spacer"></span>${finishedN ? '<button class="mini ib" id="jobs-clear" title="Clear finished rows" aria-label="Clear finished rows">' + RT.icon('close') + '</button>' : ''}</div>`
      + views.map(([j, v]) => `<div class="job ${v.cls}" data-qid="${esc(j.qid)}"><div class="job-name" title="${esc(j.name)}">${esc(j.name)}</div><div class="job-state">${v.html}</div>${v.actions ? `<div class="job-actions">${v.actions}</div>` : ''}</div>`).join('');
  }
  $('#jobs').addEventListener('click', (e) => {
    const t = e.target;
    const open = t.closest('[data-open]');
    if (open) { e.preventDefault(); if (items.some((i) => i.id === open.dataset.open)) select(open.dataset.open); else toast('That paper is no longer in the library.', 'bad'); return; }
    const retryG = t.closest('[data-retry]');
    if (retryG) return void categorize([retryG.dataset.retry]);
    const again = t.closest('[data-again], [data-force]');
    if (again) {
      const j = jobs.find((x) => x.qid === (again.dataset.again || again.dataset.force)); if (!j) return;
      if (again.dataset.force) j.force = true;
      j.state = 'queued'; j.pct = 0;
      if (!batch) batch = { jobs: [], imported: 0, dup: 0, failed: 0 };
      if (!batch.jobs.includes(j)) batch.jobs.push(j);
      renderJobs(); pump(); return;
    }
    if (t.closest('#jobs-clear')) {
      for (let k = jobs.length - 1; k >= 0; k--) if (jobView(jobs[k]).final) { clearTimeout(jobs[k].timer); jobs.splice(k, 1); }
      renderJobs();
    }
  });

  // files and folders from a drop: folders are walked (webkitGetAsEntry must be called during the event)
  function readEntries(reader) { return new Promise((resolve, reject) => reader.readEntries(resolve, reject)); }
  async function walk(entry, out) {
    if (out.length >= 2000) return;
    if (entry.isFile) {
      if (!/\.(pdf|bib|bibtex)$/i.test(entry.name)) return;
      out.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { const batchOf = await readEntries(reader); if (!batchOf.length) break; for (const en of batchOf) await walk(en, out); }
    }
  }
  async function dropped(e) {
    const dt = e.dataTransfer;
    const entries = [...(dt.items || [])].map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    const plain = [...dt.files];
    let files = plain;
    if (entries.some((en) => en.isDirectory)) {
      files = [];
      try { for (const en of entries) await walk(en, files); }
      catch (err) { return toast('Could not read the dropped folder: ' + (err.message || err.name || err), 'bad'); }
      if (!files.length) return toast('No PDF or .bib files in that folder.', 'bad');
    }
    enqueue(files);
  }

  $('#btn-import-pdf').addEventListener('click', () => $('#file-pdf').click());
  $('#file-pdf').addEventListener('change', (e) => { enqueue([...e.target.files]); e.target.value = ''; });
  const importPdfs = (files) => enqueue([...files]);

  async function importBibtex(text) {
    try {
      const r = await api('/api/import/bibtex', { method: 'POST', json: { text } });
      RT.setView('library'); await changed(); select(r.items[0].id);
      toast(`Imported ${plural(r.items.length, 'reference')} from BibTeX` + (r.skipped && r.skipped.length ? ` · ${r.skipped.length} already in library` : ''), 'ok');
      return true;
    } catch (e) {
      if (e.status === 409 && e.data && e.data.duplicateOf) {
        RT.setView('library');
        if (items.some((i) => i.id === e.data.duplicateOf)) select(e.data.duplicateOf);
        toast(`Already in library: ${e.data.duplicateTitle || 'that reference'}`, 'bad');
        return true;
      }
      toast(e.message, 'bad'); return false;
    }
  }
  const isBibtex = (text) => /@\w+\s*\{/.test(text);
  // arXiv ids / links, DOIs, OpenReview links in pasted text -> the import queue. false when the text holds none.
  function importRefs(text) {
    const { refs, unknown } = splitRefs(text);
    if (!refs.length) return false;
    enqueueRefs(refs);
    if (unknown.length) toast(`${plural(unknown.length, 'piece')} of the text ${unknown.length === 1 ? 'is' : 'are'} not an arXiv id, a DOI or a link and ${unknown.length === 1 ? 'was' : 'were'} skipped (“${unknown[0].slice(0, 40)}”${unknown.length > 1 ? ', …' : ''})`);
    return true;
  }
  // one reference through the queue (the Add button of the Related tab) -> Promise<{state: 'imported' | 'dup' | 'failed', itemId, dup, error}>
  function addRef(ref) {
    return new Promise((resolve) => {
      const r = String(ref || '').trim();
      if (!r) return resolve({ state: 'failed', itemId: null, dup: null, error: 'not an arXiv id or a DOI' });
      enqueueRefs([r], resolve); // (the server decides what it is, as for a pasted one)
    });
  }
  $('#btn-paste-bib').addEventListener('click', () => { $('#bib-text').value = ''; $('#dlg-bib').showModal(); });
  $('#bib-cancel').addEventListener('click', () => $('#dlg-bib').close());
  $('#bib-ok').addEventListener('click', async () => {
    const text = $('#bib-text').value;
    if (!text.trim()) return toast('Paste an arXiv id or link, a DOI or BibTeX first.', 'bad');
    if (isBibtex(text)) { if (await importBibtex(text)) $('#dlg-bib').close(); return; }
    if (importRefs(text)) $('#dlg-bib').close();
    else toast('Nothing recognised: give an arXiv id or link, a DOI, an OpenReview link (one per line) or BibTeX.', 'bad');
  });
  // ⌘/Ctrl+Enter adds, like the button
  $('#bib-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#bib-ok').click(); } });

  // paste BibTeX, arXiv ids / links or DOIs anywhere (outside a text field) to import them; other text is left alone
  document.addEventListener('paste', (e) => {
    if (RT.state.view !== 'library' || e.target.closest('input, textarea, .CodeMirror, [contenteditable]') || document.querySelector('dialog[open]')) return; // never while the Write tab shows
    const text = e.clipboardData.getData('text');
    if (isBibtex(text)) { e.preventDefault(); importBibtex(text); return; }
    if (!text.trim() || text.length > 20000) return;
    const { refs, unknown } = splitRefs(text);
    if (refs.length && !unknown.length) { e.preventDefault(); enqueueRefs(refs); }
  });

  // ---------------- wiring ----------------
  // the Library tab; files dropped anywhere while it shows are imported (core calls onDrop of the ACTIVE view only,
  // so nothing happens here while the Write tab is active)
  RT.registerView({ id: 'library', title: 'Library', icon: 'library', order: 10, onDrop: (e) => { if (RT.state.view === 'library') dropped(e).catch((err) => toast(err.message, 'bad')); } });

  RT.on('library:changed', () => { if (!selfEmit) refresh().catch((e) => toast('Could not load the library: ' + e.message, 'bad')); });
  // Group with Claude stays last in the Explore group, whatever the other modules appended after it
  RT.on('library:refreshed', () => { const sl = toolbarSlot('explore'), rg = $('#btn-regroup'); if (sl && rg && sl.lastElementChild !== rg) sl.append(rg); });
  RT.on('item:updated', () => { if (!selfEmit) renderList(); });  // an item object was edited in place (no refetch needed)
  RT.on('item:shown', renderList);    // RT.state.sel changed
  RT.on('item:closed', renderList);
  RT.on('memberships:changed', renderList); // papers added to or removed from a project, another working project
  // window focus / end of a Claude run: refetch, unless the reader holds edits that are not saved yet
  RT.on('disk:sync', async () => {
    if (RT.reader && RT.reader.dirty && RT.reader.dirty()) return;
    try { await refresh(); RT.emit('library:synced'); } catch {}
    if (deep() && ft.q && !ft.state && !ftBusyMore.size && !Object.values(ft.papers).some((r) => r.all)) searchChanged(0); // notes may have changed meanwhile
  });

  Object.assign(RT.library, { items: () => items, refresh, select, render: renderList, importPdfs, importBibtex, importRefs, addRef, writeBriefs,
    importDrop: (e) => dropped(e).catch((err) => toast(err.message, 'bad')), // a file drop another module caught (the note editor)
    selection: () => [...picked], moveTo, categorize, setStatus, STATUS, statusOf,
    venue: (id) => venues.items[id] || null, venuesRunning: () => venues.running, checkVenues, // the reader's Venue line
    step, focusList, focusSearch, // keyboard (palette.js): the paper below / above, the focus into the list / the search box
    filter, focusCategory, search, toolbarSlot }); // the Overview and the other modules (see below)

  // ---------------- hooks for other modules ----------------
  // filter({status: 'unread' | 'reading' | 'done' | null, starred, noPdf}): show the Library with that filter chip on
  // (one filter at a time, as the chips; nothing given: all papers). The search and the tag filter are cleared.
  function filter({ status = null, starred = false, noPdf = false } = {}) {
    RT.setView('library');
    tagFilter = null; $('#search').value = ''; $('#search-clear').hidden = true;
    setShow(starred ? 'starred' : noPdf ? 'nopdf' : status);
    if (deep()) searchChanged(0); else renderList();
  }
  // focusCategory(name): group by category, open that category (and its line), scroll to its header and flash it
  function focusCategory(name) {
    RT.setView('library');
    name = String(name || '');
    if (groupBy !== 'category') { groupBy = 'category'; ls.set('rt.lib.group', groupBy); }
    tagFilter = null; setShow(null); $('#search').value = ''; $('#search-clear').hidden = true; if (deep()) searchChanged(0);
    for (const k of ['category:' + name, 'line:' + name, 'line:' + lineOf(name)]) delete collapsed[k];
    ls.set('rt.lib.collapsed', JSON.stringify(collapsed));
    renderList();
    const wrap = $$('#list .grp-wrap[data-cat]').find((w) => w.dataset.cat === name);
    const head = wrap && $(':scope > .grp', wrap);
    if (!head) return false;
    head.scrollIntoView({ block: 'start' });
    head.focus({ preventScroll: true }); tabStop();
    head.classList.remove('flash'); void head.offsetWidth; head.classList.add('flash');
    setTimeout(() => head.classList.remove('flash'), 1600);
    return true;
  }
  // search(q): put q in the search box and run it; "#tag" with a tag of the library filters by that tag instead
  function search(q = '') {
    RT.setView('library');
    q = String(q || '');
    const m = /^#(.+)$/.exec(q.trim());
    const tag = m && [...new Set(items.flatMap(tagsOf))].find((t) => t.toLowerCase() === m[1].toLowerCase());
    if (tag) { tagFilter = tag; q = ''; }
    const box = $('#search'); box.value = q; $('#search-clear').hidden = !q;
    if (deep()) searchChanged(0); else renderList();
    if (!tag) box.focus();
  }
  // toolbarSlot('explore') -> the element other modules put their toolbar buttons in (#ll-slot-<name>), or null
  function toolbarSlot(name) { return document.getElementById('ll-slot-' + name); }

  refresh().catch((e) => toast('Could not load the library: ' + e.message, 'bad'));
})();
