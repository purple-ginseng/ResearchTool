/* Papers of a project: which Library papers belong to which writing project (the Write tab's projects), and the
   "working project" the Library's add buttons put papers into. No UI of its own except the project picker; the
   Library list, the reader, the palette and the Write tab draw with it. -> RT.projectPapers
   Data: GET /api/memberships {projects: [{id, name, external, overleaf, papers}], byItem: {itemId: [pid]}} (cached,
   fetched again on 'projects:changed' and when the window gets the focus back, at most every 10 s);
   GET /api/projects/:id/papers (the rows and counts of one project, cached until something changes).
   The working project: localStorage rt-working-project ({id, name}), else rt-project (the project opened last in the
   Write tab), else the only project. Emits 'memberships:changed' whenever the cache or the working project changed,
   and 'projects:changed' {pid, ids, on} after it added or removed papers. Never deletes a paper. */
(() => {
  const { api, toast, ls, enc } = RT;
  RT.projectPapers = RT.projectPapers || {};

  const ICON = 'bookmark'; // (an RT.icon name) the paper is kept for a project
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const NO_PROJECT = 'Create or open a project in the Write tab first';

  let cache = null;      // {projects, byItem}
  let loading = null, loadedAt = 0;
  const details = new Map(); // pid -> {data, at} | {wait: Promise}
  let selfEmit = false;

  function changed() { details.clear(); RT.emit('memberships:changed'); }
  function refresh() {
    if (loading) return loading;
    loading = api('/api/memberships').then((r) => {
      cache = { projects: Array.isArray(r.projects) ? r.projects : [], byItem: r.byItem && typeof r.byItem === 'object' ? r.byItem : {} };
      loadedAt = Date.now();
      changed();
      return cache;
    }).finally(() => { loading = null; });
    return loading;
  }
  const load = () => (cache ? Promise.resolve(cache) : refresh());
  const projects = () => (cache ? cache.projects : []);
  const project = (pid) => projects().find((p) => p.id === pid) || null;
  const loaded = () => !!cache;

  // {id, name} of the working project, or null (none, or not loaded yet)
  function working() {
    if (!cache) return null;
    const w = ls.json('rt-working-project', null);
    for (const id of [w && w.id, ls.get('rt-project')]) { const p = id && project(id); if (p) return { id: p.id, name: p.name }; }
    return cache.projects.length === 1 ? { id: cache.projects[0].id, name: cache.projects[0].name } : null;
  }
  function setWorking(id) {
    const p = project(id); if (!p) return false;
    ls.set('rt-working-project', JSON.stringify({ id: p.id, name: p.name }));
    RT.emit('memberships:changed');
    return true;
  }

  const of = (itemId) => (cache && cache.byItem[itemId]) || [];
  function has(itemId, pid) {
    const id = pid || (working() || {}).id;
    return !!id && of(itemId).includes(id);
  }
  function members(pid) {
    const out = new Set();
    if (!cache || !pid) return out;
    for (const [itemId, pids] of Object.entries(cache.byItem)) if (pids.includes(pid)) out.add(itemId);
    return out;
  }
  // after a POST: the members of pid are exactly `ids`
  function adopt(pid, ids) {
    if (!cache) return;
    const keep = new Set(ids);
    for (const [itemId, pids] of Object.entries(cache.byItem)) {
      const next = pids.filter((x) => x !== pid || keep.has(itemId));
      if (next.length) cache.byItem[itemId] = next; else delete cache.byItem[itemId];
    }
    for (const id of ids) { const pids = cache.byItem[id] || (cache.byItem[id] = []); if (!pids.includes(pid)) pids.push(pid); }
    const p = project(pid); if (p) p.papers = ids.length;
  }

  // a title as text: inline LaTeX ("$π_{0.7}$") becomes "π0.7" by lineage.js's texPlain (RT.texPlain, set when it loads)
  const plainTitle = (t) => (RT.texPlain ? RT.texPlain(t) : String(t));
  const titleOf = (id) => { const it = RT.library && RT.library.items ? RT.library.items().find((i) => i.id === id) : null; return it ? plainTitle(it.fields.title || it.citekey || 'the paper') : 'the paper'; };
  const short = (s) => (s.length > 60 ? s.slice(0, 58).replace(/\s+\S*$/, '') + '…' : s);
  // Add (on = true) or remove (on = false) papers; on left out = add unless every one of them is already in.
  // -> Promise<{pid, ids: the ones that changed, on} | null>. The toast has an Undo.
  async function toggle(ids, { pid, on, quiet = false } = {}) {
    ids = [...new Set((ids || []).filter(Boolean))];
    if (!ids.length) return null;
    await load().catch(() => {});
    const p = project(pid || (working() || {}).id);
    if (!p) { toast(projects().length ? 'Choose a project first: the “Project” button at the top of the list' : NO_PROJECT, 'bad'); return null; }
    if (on === undefined) on = !ids.every((id) => has(id, p.id));
    // all of them go to the server (the cache may be behind another window); what changed comes back from it
    let r;
    try { r = await api(`/api/projects/${enc(p.id)}/papers`, { method: 'POST', json: on ? { add: ids } : { remove: ids } }); }
    catch (e) { toast(`Could not change the papers of “${p.name}”: ${e.message}`, 'bad'); return null; }
    adopt(p.id, r.papers || []);
    const done = (on ? r.added : r.removed) || [];
    if (!done.length && !(r.ignored || []).length) {
      if (!quiet) toast(on ? `Already in “${p.name}”` : `Not in “${p.name}”`);
      RT.emit('memberships:changed');
      return { pid: p.id, ids: [], on };
    }
    details.delete(p.id);
    selfEmit = true; try { RT.emit('projects:changed', { pid: p.id, ids: done, on }); } finally { selfEmit = false; }
    RT.emit('memberships:changed');
    if (!quiet) {
      const what = done.length === 1 ? `“${short(titleOf(done[0]))}”` : plural(done.length, 'paper');
      const msg = (on ? `Added ${what} to “${p.name}”` : `Removed ${what} from “${p.name}”`) + ((r.ignored || []).length ? ` · ${plural(r.ignored.length, 'paper')} not found` : '');
      if (done.length) toast(msg, 'ok', { label: 'Undo', run: () => toggle(done, { pid: p.id, on: !on, quiet: true }) });
      else toast(msg, 'bad');
    }
    return { pid: p.id, ids: done, on };
  }

  // Let the user choose a project in a small menu (at x, y; else near the top of the window).
  // -> Promise<pid | null> (null when the menu is closed without a choice)
  async function pick({ title = 'Add to project', x, y, current = true } = {}) {
    await load().catch(() => {});
    const ps = projects();
    if (!ps.length) { toast(NO_PROJECT, 'bad'); return null; }
    if (!RT.categories || !RT.categories.menu) return null;
    const w = working();
    return new Promise((resolve) => {
      let done = false;
      const end = (v) => { if (!done) { done = true; resolve(v); } };
      RT.categories.menu(x ?? Math.round(window.innerWidth / 2 - 120), y ?? Math.round(window.innerHeight / 4), [{ head: title },
        ...ps.map((p) => ({ label: `${p.name}${p.papers ? ` (${p.papers})` : ''}`, ...(current ? { check: !!w && w.id === p.id } : {}), run: () => end(p.id) }))]);
      // the menu closes before its entry runs: give the entry the first word
      const el = document.querySelector('.ctx-menu');
      if (!el) return end(null);
      const mo = new MutationObserver(() => { if (!el.isConnected) { mo.disconnect(); setTimeout(() => end(null), 0); } });
      mo.observe(document.body, { childList: true });
    });
  }

  // GET /api/projects/:id/papers, cached until the members, a status or a note changed
  function papers(pid, { fresh = false } = {}) {
    const d = details.get(pid);
    if (d && !fresh) return d.wait || Promise.resolve(d.data);
    const wait = api(`/api/projects/${enc(pid)}/papers`).then((data) => { details.set(pid, { data, at: Date.now() }); return data; })
      .catch((e) => { details.delete(pid); throw e; });
    details.set(pid, { wait });
    return wait;
  }
  const papersNow = (pid) => { const d = details.get(pid); return d && d.data ? d.data : null; };

  // the reading pack of a project: reading list, BibTeX and notes in the export folder
  async function readingPack(pid) {
    const p = project(pid);
    try {
      await RT.flush('reader');
      const r = await api(`/api/projects/${enc(pid)}/reading-pack`, { method: 'POST', json: {} });
      toast(`Reading pack of “${p ? p.name : pid}”: ${plural(r.files.length, 'file')} in ${r.dir}`, 'ok');
      return r;
    } catch (e) { toast('Could not export the reading pack: ' + e.message, 'bad'); return null; }
  }
  // Paper packages hold the PDFs: over PDF_ASK bytes of PDFs the user chooses first (with them, without them, or not
  // now). -> true (with the PDFs) | false (without) | null (cancelled)
  const PDF_ASK = 100 * 1048576;
  const MB = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  async function askPdfs(ids) {
    if (!ids.length) return true;
    let e;
    try { e = await api('/api/notes/export-zip', { method: 'POST', json: { ids, estimate: true } }); } catch { return true; }
    if (!e || !(e.pdfBytes > PDF_ASK)) return true;
    const ui = RT.write && RT.write.ui;
    if (!ui || !ui.openDialog) return window.confirm(`The PDFs of ${plural(e.pdfs, 'paper')} are ${MB(e.pdfBytes)}. Put them in the .zip? (Cancel: without the PDFs)`);
    const { d, result } = ui.openDialog(`<form method="dialog"><h3>Export with the PDFs?</h3>
      <p class="dlg-msg">The PDFs of ${plural(e.pdfs, 'paper')} are ${MB(e.pdfBytes)} in all, so the .zip will be large. The packages without the PDFs still have the notes, pictures, BibTeX and links (with the arXiv PDF link when there is one).</p>
      <div class="dlg-actions pk-choice"><button type="button" class="ib" data-cancel title="Cancel (Esc)" aria-label="Cancel">${ui.ic('close')}</button>
      <button type="submit" data-pick="no">Without the PDFs</button><button type="submit" class="primary" data-pick="yes">With the PDFs (${MB(e.pdfBytes)})</button></div></form>`,
    (x) => x.dataset.pick || null, 'pk-dlg');
    d.addEventListener('click', (ev) => { const b = ev.target.closest('[data-pick]'); if (b) d.dataset.pick = b.dataset.pick; });
    d.querySelector('[data-pick="yes"]').focus();
    const v = await result;
    return v === 'yes' ? true : v === 'no' ? false : null;
  }
  const pdfNote = (h, pdf) => { const n = Number(h.get('X-RT-Pdfs')) || 0; return pdf === false ? ', without the PDFs' : n ? `, ${plural(n, 'PDF')}` : ''; };
  // the same pack as a .zip download: a paper package per paper (note, pictures, PDF, BibTeX, links), reading-list.md,
  // references.bib - nothing written to the export folder
  async function readingPackZip(pid) {
    try {
      await RT.flush('reader');
      let ids = [];
      try { ids = (await papers(pid)).papers.map((r) => r.id); } catch { ids = [...members(pid)]; }
      const pdf = await askPdfs(ids);
      if (pdf === null) return;
      if (ids.length > 1) toast(`Packing the reading pack of ${plural(ids.length, 'paper')} - looking up their links first, this can take a minute…`);
      const r = await RT.downloadFile(`/api/projects/${enc(pid)}/reading-pack?format=zip${pdf ? '' : '&pdf=0'}`, { method: 'POST', json: {} });
      toast(ids.length ? `Saved ${r.name}: reading list, references.bib and ${ids.length === 1 ? 'the package of its paper' : `a package for each of its ${ids.length} papers`} (note with pictures, BibTeX, links${pdf ? ', PDF' : ''})` : `Saved ${r.name}: the project has no papers yet, so only the reading list is in it`, 'ok');
    } catch (e) { toast('Could not download the reading pack: ' + e.message, 'bad'); }
  }
  // the packages of papers as one .zip: a folder per paper with its .md (header with the links), pictures in assets/,
  // .bib and PDF; README.md and references.bib at the top. opts.pdf: false leaves the PDFs out (asked when undefined)
  async function notesZip(ids, opts = {}) {
    try {
      await RT.flush('reader');
      const pdf = opts.pdf === false ? false : await askPdfs(ids);
      if (pdf === null) return;
      if (ids.length > 1) toast(`Packing ${plural(ids.length, 'paper')} - looking up their links first, this can take a minute…`);
      const r = await RT.downloadFile('/api/notes/export-zip', { method: 'POST', json: { ids, pdf } });
      const n = Number(r.headers.get('X-RT-Notes')) || 0, p = Number(r.headers.get('X-RT-Papers')) || ids.length, miss = Number(r.headers.get('X-RT-Missing')) || 0;
      toast(`Saved ${r.name}: ${plural(p, 'paper package')}${pdfNote(r.headers, pdf)}${n < p ? ` (${plural(p - n, 'paper')} without a note yet)` : ''}${miss ? `, ${plural(miss, 'picture')} missing on disk` : ''}`, 'ok');
    } catch (e) { toast('Could not export the paper packages: ' + e.message, 'bad'); }
  }
  function openInWrite(pid) {
    if (!RT.write || !RT.write.openProject) return;
    RT.setView('write');
    Promise.resolve(RT.write.openProject(pid)).catch((e) => toast(e.message, 'bad'));
  }

  // ---------------- keeping it current ----------------
  RT.on('projects:changed', () => { if (!selfEmit) refresh().catch(() => {}); });
  RT.on('project:opened', (p) => {
    if (!p || !p.id) return;
    ls.set('rt-working-project', JSON.stringify({ id: p.id, name: p.name || p.id }));
    if (!project(p.id)) refresh().catch(() => {}); else RT.emit('memberships:changed');
  });
  // what the rows count (status, notes, highlights, quiz) may have changed
  // (only for papers of a project, and once after a burst: turning the pages of the PDF updates the item too)
  const stale = RT.debounce(() => { if (details.size) { details.clear(); RT.emit('memberships:changed'); } }, 1500);
  RT.on('item:updated', (e) => { const ids = e ? (e.ids || [e.id]) : []; if (details.size && ids.some((id) => of(id).length)) stale(); });
  RT.on('library:changed', () => refresh().catch(() => {})); // a paper deleted or put back
  window.addEventListener('focus', () => { if (Date.now() - loadedAt > 10000) refresh().catch(() => {}); });

  Object.assign(RT.projectPapers, { ICON, NO_PROJECT, load, refresh, loaded, projects, project, working, setWorking, has, of, members,
    toggle, pick, papers, papersNow, readingPack, readingPackZip, notesZip, askPdfs, openInWrite });
  refresh().catch(() => {});
})();
