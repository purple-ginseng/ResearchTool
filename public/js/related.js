/* Library tab, reader, "Related" tab: the papers the open paper cites (References) and the papers that cite it (Cited
   by), from OpenAlex / Semantic Scholar. Nothing is asked until the user presses Look up (or has ticked "by itself");
   only the paper's DOI or arXiv id is sent. Papers already in the library are marked and open with a click; the others
   are added with one click through the import queue of the Library (RT.library.addRef) and, with "also add to “P”"
   ticked (localStorage rt.related.toProject = 1), to the working project too (RT.projectPapers).
   "Lineage of this paper" (#rl-lineage) opens the Lineage window (lineage.js) on this paper and its neighbours.
   "Check metadata" (also a button of the Details tab) compares the entry with the published record and, for an arXiv
   preprint, offers to turn it into the published entry - the cite key stays.
   RT.related.show(host, item) - called by reader.js when the tab is shown; RT.related.checkMetadata(item).
   Data: GET /api/items/:id/related[?mode=cached|refresh], GET / POST /api/items/:id/metadata-check (lib/related.js). */
(() => {
  const { $, $$, esc, api, toast, ls } = RT;
  RT.related = RT.related || {};

  // icon names (RT.icon): the tab and its intro, "Check metadata", the Lineage window (lineage.js loads after this file)
  const I = { graph: 'lineage', meta: 'venue-verified' };
  const LINEAGE = 'lineage';
  const LISTS = { references: 'References', citations: 'Cited by' };
  const SORTS = [['cited', 'Most cited'], ['new', 'Newest'], ['old', 'Oldest'], ['lib', 'In library first']];

  const cache = new Map();  // item id -> { data, loading, error, seq }
  const adding = new Set(); // references being added right now ("arXiv:1703.06907")
  let view = null;          // { host, item } of the panel on screen
  let list = LISTS[ls.get('rt.related.list')] ? ls.get('rt.related.list') : 'references';
  let sort = SORTS.some(([k]) => k === ls.get('rt.related.sort')) ? ls.get('rt.related.sort') : 'cited';
  let filter = '';

  const state = (id) => { if (!cache.has(id)) cache.set(id, { data: null, loading: false, error: '', seq: 0 }); return cache.get(id); };
  const onScreen = () => !!(view && view.host.isConnected && !view.host.hidden);
  const auto = () => ls.get('rt.related.auto') === '1';
  // "also add to the working project" for the papers added from here (remembered)
  const toProject = () => ls.get('rt.related.toProject') === '1';
  const projBox = () => { const w = RT.projectPapers && RT.projectPapers.working(); return w ? `<label class="rl-proj" title="Papers added from this list also go into the working project “${esc(w.name)}”"><input type="checkbox" id="rl-proj" data-pid="${esc(w.id)}" ${toProject() ? 'checked' : ''}> also add to “${esc(w.name)}”</label>` : ''; };
  const num = (n) => Number(n).toLocaleString('en-US');
  function ago(iso) {
    const d = Math.max(0, Date.now() - Date.parse(iso)), day = 24 * 3600 * 1000;
    if (!Number.isFinite(d)) return '';
    if (d < 3600 * 1000) return 'just now';
    if (d < day) return 'today';
    if (d < 2 * day) return 'yesterday';
    if (d < 60 * day) return Math.round(d / day) + ' days ago';
    return Math.round(d / (30 * day)) + ' months ago';
  }
  const sentTo = (data) => (data && data.ident ? data.ident.label : 'DOI or arXiv id');

  // ------------------------------------------------------------------ panel
  function show(host, item) {
    const other = !view || view.item.id !== item.id;
    view = { host, item };
    host.classList.add('rl');
    if (!host.dataset.wired) { host.dataset.wired = '1'; wire(host); }
    if (other) filter = '';
    const st = state(item.id);
    render();
    if (st.loading) return;
    // what is kept on this Mac is shown at once; a service is asked only when the user chose "by itself"
    // (a lookup that failed is not repeated by itself: the button asks again)
    if (!st.data) { if (!st.failed) load(item.id, auto() ? 'auto' : 'cached'); }
    else if (st.data.fetched) load(item.id, 'cached', true); // the library may have changed: fresh "in library" marks
    else if (st.data.ident && auto() && !st.failed) load(item.id, 'auto'); // "by itself" was ticked after this paper was shown
  }
  async function load(id, mode, quiet = false) {
    const st = state(id);
    if (quiet && st.loading) return; // a lookup is under way: its answer brings fresh marks anyway
    const seq = ++st.seq;
    if (!quiet) { st.loading = mode === 'cached' ? 'local' : 'ask'; st.error = ''; if (view && view.item.id === id) render(); }
    try {
      const r = await api(`/api/items/${id}/related${mode === 'auto' ? '' : '?mode=' + mode}`);
      if (seq !== st.seq) return;
      st.data = r; st.error = ''; st.failed = false;
    } catch (e) {
      if (seq !== st.seq) return;
      if (!quiet) { st.error = e.message || String(e); st.failed = mode !== 'cached'; }
    }
    if (!quiet) st.loading = false;
    if (view && view.item.id === id && onScreen()) render(quiet);
  }

  function render(keepScroll) {
    if (!view) return;
    const { host, item } = view, st = state(item.id), d = st.data;
    const top = keepScroll && $('#rl-list', host) ? $('#rl-list', host).scrollTop : 0;
    if (st.loading && !(d && d.fetched)) {
      host.innerHTML = `<div class="empty rl-empty"><div><span class="spin"></span> ${st.loading === 'ask' ? 'Asking OpenAlex for the references and the papers that cite this one…' : ''}</div></div>`;
      return;
    }
    if (d && d.ident === null) {
      host.innerHTML = `<div class="empty rl-empty">${RT.icon(I.graph, { size: 34 })}<div>This entry has no DOI and no arXiv id, so its references cannot be looked up.<br>Add one in the DOI field of the Details tab.</div></div>`;
      return;
    }
    if (!d || !d.fetched) {
      host.innerHTML = `<div class="rl-intro">
        ${RT.icon(I.graph, { size: 34 })}
        <p><b>References and cited by.</b> See which papers this one builds on and which later papers cite it. The ones you already have are marked; the others are one click from your library.</p>
        <p class="muted">The lists come from OpenAlex (and from Semantic Scholar when OpenAlex has none). Only this paper's <b>${esc(sentTo(d))}</b> is sent - never your notes, your library or the PDF. The answer is kept on this Mac.</p>
        <div class="rl-go"><button id="rl-lookup" class="accent ib" title="Look up the references and the citing papers of this paper" aria-label="Look up the references and the citing papers">${RT.icon('search')}</button>
          <label><input type="checkbox" id="rl-auto" ${auto() ? 'checked' : ''}> Look up by itself whenever I open this tab</label>
          <span class="spacer"></span><button id="rl-lineage" data-intro="1" class="ib" title="Lineage of this paper: its prior works, the works that build on it and its history line among your papers (like Connected Papers)" aria-label="Lineage of this paper">${RT.icon(LINEAGE)}</button></div>
        ${st.error ? `<div class="notice rl-bad">${esc(st.error)}</div>` : ''}
      </div>`;
      return;
    }
    const up = d.upgrade;
    host.innerHTML = `
      <div class="rl-bar">
        <div class="seg" id="rl-seg">${Object.entries(LISTS).map(([k, name]) => `<button data-list="${k}" class="${k === list ? 'on' : ''}" aria-pressed="${k === list}">${name} <span class="rl-n">${num(d[k].total)}</span></button>`).join('')}</div>
        <input type="search" id="rl-q" placeholder="Filter by title, author or venue" aria-label="Filter the list" value="${esc(filter)}">
        <select id="rl-sort" title="Order of the list" aria-label="Order of the list">${SORTS.map(([k, name]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${name}</option>`).join('')}</select>
 ${projBox()}
<button id="rl-lineage" class="ib" title="Lineage of this paper: its prior works, the works that build on it and its history line among your papers (like Connected Papers)" aria-label="Lineage of this paper">${RT.icon(LINEAGE)}</button>
        <button id="rl-refresh" class="ib" title="Look up again (last looked up ${esc(ago(d.fetched))}; only the ${esc(sentTo(d))} is sent)" aria-label="Look up again" ${st.loading ? 'disabled' : ''}>${st.loading ? '<span class="spin"></span>' : RT.icon('refresh')}</button>
      </div>
      ${up ? `<div class="notice rl-up"><span>This preprint has been published${up.venue ? ' in <b>' + esc(up.venue) + '</b>' : ''}${up.year ? ' (' + esc(up.year) + ')' : ''}. Your entry still cites the arXiv version.</span><button id="rl-check" class="ib" title="Check metadata: see what the published record would change in this entry (the cite key stays)" aria-label="Check metadata">${RT.icon(I.meta)}</button></div>` : ''}
      ${st.error ? `<div class="notice rl-bad">${esc(st.error)}</div>` : ''}
      ${d.warning ? `<div class="notice rl-bad">${esc(d.warning)}</div>` : ''}
      ${(d.notes || []).map((n) => `<div class="notice">${esc(n)}</div>`).join('')}
      <div class="rl-list" id="rl-list" tabindex="-1"></div>
      <div class="rl-foot muted" id="rl-foot"></div>`;
    renderList();
    if (top) $('#rl-list', host).scrollTop = top;
  }

  function rows() {
    const d = state(view.item.id).data, l = d[list];
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    let out = l.list.map((e, i) => ({ e, i }));
    if (words.length) out = out.filter(({ e }) => { const hay = [e.title, e.authors.join(' '), e.venue, e.year || ''].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); });
    const by = {
      cited: (a, b) => (b.e.cited ?? -1) - (a.e.cited ?? -1) || a.i - b.i,
      new: (a, b) => (b.e.year || 0) - (a.e.year || 0) || (b.e.cited ?? -1) - (a.e.cited ?? -1),
      old: (a, b) => (a.e.year || 9999) - (b.e.year || 9999) || (b.e.cited ?? -1) - (a.e.cited ?? -1),
      lib: (a, b) => Number(!!b.e.inLibrary) - Number(!!a.e.inLibrary) || (b.e.cited ?? -1) - (a.e.cited ?? -1),
    };
    return out.sort(by[sort] || by.cited);
  }
  const people = (e) => (e.authors.length > 3 ? e.authors.slice(0, 3).join(', ') + ' et al.' : e.authors.join(', ') + (e.more ? ' et al.' : ''));
  function rowHtml({ e, i }) {
    const href = e.arxiv ? 'https://arxiv.org/abs/' + encodeURI(e.arxiv) : e.doi ? 'https://doi.org/' + encodeURI(e.doi) : '';
    const meta = RT.byline(people(e), [e.year, e.venue, e.cited !== null && e.cited !== undefined ? 'cited ' + num(e.cited) : '']);
    const title = e.inLibrary
      ? `<a href="#" data-open="${esc(e.inLibrary)}" title="In your library - open it">${esc(e.title)}</a>`
      : href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Open its page at ${e.arxiv ? 'arxiv.org' : 'doi.org'} in the browser">${esc(e.title)}</a>` : esc(e.title);
    const act = e.inLibrary
      ? `<button class="ib rl-have" data-open="${esc(e.inLibrary)}" title="In your library - open it" aria-label="In your library - open it">${RT.icon('check')}</button>`
      : e.ref && adding.has(e.ref) ? '<span class="rl-busy" title="Being added - see the import list on the left"><span class="spin"></span></span>'
      : e.ref ? `<button class="ib" data-add="${i}" title="Add to the library (${esc(e.ref)}): the details are looked up and the PDF is downloaded when a free one exists" aria-label="Add to the library">${RT.icon('plus')}</button>`
      : '<span class="rl-none muted" title="No DOI or arXiv id is known for this one, so it cannot be added by itself">—</span>';
    return `<div class="rl-row${e.inLibrary ? ' have' : ''}"><div class="rl-main"><div class="rl-title">${title}${e.inLibrary ? ' <span class="badge">in library</span>' : ''}</div><div class="rl-meta muted">${meta}</div></div><div class="rl-act">${act}</div></div>`;
  }
  function renderList() {
    if (!view) return;
    const host = view.host, d = state(view.item.id).data, box = $('#rl-list', host), foot = $('#rl-foot', host);
    if (!box || !d || !d.fetched) return;
    const l = d[list], shown = rows();
    const what = list === 'references' ? 'references' : 'citing papers';
    const empty = (o) => { box.innerHTML = ''; box.append(RT.emptyState({ ill: 'emptySearch', compact: true, ...o })); };
    if (!l.list.length) {
      empty(list === 'references'
        ? { title: 'No reference list found', text: 'Neither OpenAlex nor Semantic Scholar has the reference list of this paper. That is common for a recent preprint; the refresh button asks again.' }
        : { title: 'No citing papers yet', text: 'No paper that cites this one is known yet.' });
    } else if (!shown.length) {
      empty({ title: 'Nothing in this list matches the filter', actions: [{ label: 'Clear the filter', icon: 'close', onClick: () => { filter = ''; const q = $('#rl-q', host); if (q) { q.value = ''; q.focus(); } renderList(); } }] });
    }
    else box.innerHTML = shown.map(rowHtml).join('');
    const have = l.list.filter((e) => e.inLibrary).length;
    const count = !l.list.length ? '' : l.more
      ? `The first ${num(l.list.length)} ${what} (${l.source || 'the index'} has more)`
      : l.total > l.list.length
      ? (list === 'citations' ? `The ${num(l.list.length)} most cited of ${num(l.total)} citing papers` : `${num(l.list.length)} of ${num(l.total)} references (the others are not in the index)`)
      : `${num(l.list.length)} ${what}`;
    foot.title = foot.textContent = [count, have ? `${have} in your library` : '', l.source ? 'from ' + l.source : '', 'looked up ' + ago(d.fetched), `only the ${sentTo(d)} was sent`].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------------ actions
  async function add(e) {
    if (!e || !e.ref || adding.has(e.ref)) return;
    if (!RT.library || !RT.library.addRef) return toast('The Library is not ready yet.', 'bad');
    const id = view.item.id;
    const box = $('#rl-proj', view.host), pid = box && box.checked ? box.dataset.pid : null; // the project the label names
    adding.add(e.ref); renderList();
    let r = null;
    try { r = await RT.library.addRef(e.ref); } catch (err) { r = { state: 'failed', error: err.message || String(err) }; }
    adding.delete(e.ref);
    if (r.state === 'failed') toast(`Could not add “${e.title.slice(0, 60)}”: ${r.error || 'unknown error'}`, 'bad');
    else if (r.state === 'dup') toast(`Already in your library: ${r.dup && r.dup.title ? r.dup.title : e.title}`);
    if (r.itemId) e.inLibrary = r.itemId; else if (r.dup && r.dup.id) e.inLibrary = r.dup.id;
    if (e.inLibrary && r.state !== 'failed' && pid && RT.projectPapers) await RT.projectPapers.toggle([e.inLibrary], { pid, on: true });
    if (view && view.item.id === id && onScreen()) { renderList(); load(id, 'cached', true); }
  }
  function wire(host) {
    host.addEventListener('click', (ev) => {
      const t = ev.target.closest('button, a'); if (!t || !view) return;
      const st = state(view.item.id);
      if (t.dataset.open) { ev.preventDefault(); if (RT.library && RT.library.select) RT.library.select(t.dataset.open); return; }
      if (t.dataset.add) { const e = st.data && st.data[list].list[Number(t.dataset.add)]; add(e); return; }
      if (t.dataset.list) { list = t.dataset.list; ls.set('rt.related.list', list); $$('#rl-seg button', host).forEach((b) => { b.classList.toggle('on', b.dataset.list === list); b.setAttribute('aria-pressed', String(b.dataset.list === list)); }); renderList(); $('#rl-list', host).scrollTop = 0; return; }
      if (t.id === 'rl-lookup') load(view.item.id, 'auto');
      else if (t.id === 'rl-refresh') load(view.item.id, 'refresh');
      else if (t.id === 'rl-check') checkMetadata(view.item);
      else if (t.id === 'rl-lineage') RT.emit('lineage:open', { scope: 'paper', id: view.item.id });
    });
    host.addEventListener('input', (ev) => {
      if (ev.target.id === 'rl-q') { filter = ev.target.value; renderList(); }
    });
    host.addEventListener('change', (ev) => {
      if (ev.target.id === 'rl-sort') { sort = ev.target.value; ls.set('rt.related.sort', sort); renderList(); }
      else if (ev.target.id === 'rl-auto') ls.set('rt.related.auto', ev.target.checked ? '1' : '0');
      else if (ev.target.id === 'rl-proj') ls.set('rt.related.toProject', ev.target.checked ? '1' : '0');
    });
  }
  // a paper was added, deleted or put back: the "in library" marks follow (no service is asked for that)
  RT.on('library:refreshed', () => {
    if (!onScreen()) return;
    const st = state(view.item.id);
    if (st.data && st.data.fetched && !st.loading) load(view.item.id, 'cached', true);
  });

  // another working project: the "also add to" label names it
  RT.on('memberships:changed', () => {
    if (!onScreen()) return;
    const old = $('.rl-proj', view.host), w = RT.projectPapers && RT.projectPapers.working();
    if (old && old.querySelector('input').dataset.pid === (w && w.id)) return;
    const had = old && old.contains(document.activeElement);
    if (old) old.outerHTML = projBox(); else if ($('#rl-refresh', view.host)) $('#rl-refresh', view.host).insertAdjacentHTML('beforebegin', projBox());
    if (had && $('#rl-proj', view.host)) $('#rl-proj', view.host).focus();
  });

  // ------------------------------------------------------------------ Check metadata
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-meta" class="rl-dlg" aria-labelledby="mc-title">
  <h3 id="mc-title">Check metadata</h3>
  <div id="mc-body"></div>
  <div class="dlg-actions"><button id="mc-cancel">Close</button><button id="mc-apply" class="primary" hidden>Update the entry</button></div>
</dialog>`);
  const dlg = $('#dlg-meta');
  let check = null; // { item, seq, changes }
  let checkSeq = 0;
  async function checkMetadata(item) {
    if (!item) return;
    const seq = ++checkSeq;
    check = { item, seq, changes: [] };
    $('#mc-apply').hidden = true;
    $('#mc-body').innerHTML = `<p class="rl-wait"><span class="spin"></span> Looking for the published record of “${esc((item.fields && item.fields.title) || item.citekey)}”…</p><p class="muted">Only the paper's DOI or arXiv id is sent (to doi.org and, for an arXiv preprint, OpenAlex, Semantic Scholar and arXiv).</p>`;
    if (!dlg.open) dlg.showModal();
    let r;
    try { r = await api(`/api/items/${item.id}/metadata-check`); }
    catch (e) { if (seq === checkSeq && dlg.open) $('#mc-body').innerHTML = `<div class="notice rl-bad">${esc(e.message || String(e))}</div>`; return; }
    if (seq !== checkSeq || !dlg.open) return;
    if (!r.found) { $('#mc-body').innerHTML = `<p>${esc(r.message || 'Nothing to change.')}</p>`; return; }
    check.changes = r.changes;
    $('#mc-body').innerHTML = `
      <p>${esc(r.message || (r.kind === 'refresh' ? 'The record at doi.org differs from this entry.' : ''))} Tick what to take over.</p>
      <div class="mc-scroll"><table class="mc-table">
        <thead><tr><th></th><th>Field</th><th>Now</th><th>${r.kind === 'published' ? 'Published record' : 'Record at doi.org'}</th></tr></thead>
        <tbody>${r.changes.map((c, i) => `<tr><td><input type="checkbox" id="mc-${i}" data-i="${i}" ${c.minor ? '' : 'checked'}></td><td><label for="mc-${i}">${esc(c.label)}</label></td><td class="mc-from">${c.from ? esc(c.from) : '<span class="muted">empty</span>'}</td><td class="mc-to">${c.to ? esc(c.to) : '<span class="muted">removed</span>'}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">The cite key <code>${esc(item.citekey)}</code> stays as it is, so documents that already cite this paper keep working. Rows that only differ in spelling are not ticked.</p>`;
    $('#mc-apply').hidden = false; $('#mc-apply').disabled = false;
  }
  $('#mc-cancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { checkSeq++; check = null; });
  $('#mc-apply').addEventListener('click', async () => {
    if (!check) return;
    const { item, changes } = check, values = {};
    for (const box of $$('#mc-body input[type=checkbox]:checked')) { const c = changes[Number(box.dataset.i)]; if (c) values[c.field] = c.to; }
    if (!Object.keys(values).length) return toast('Tick at least one row, or close the window.', 'bad');
    const btn = $('#mc-apply');
    btn.disabled = true;
    try {
      // what was typed into the Details tab is saved first, so it is neither lost nor written over the new fields
      if ((await RT.flush('reader')) === false) throw new Error('the open paper could not be saved first');
      const r = await api(`/api/items/${item.id}/metadata-check`, { method: 'POST', json: { values } });
      item.type = r.item.type; item.fields = r.item.fields; item.metaSource = r.item.metaSource;
      cache.delete(item.id); // the entry may now be known by its DOI: the lists are read again when the tab is shown
      dlg.close();
      RT.emit('item:updated', { id: item.id });
      if (RT.reader && RT.reader.current && RT.reader.current() === item) {
        RT.reader.render();
        if (onScreen() && view.item.id === item.id) show(view.host, item);
      }
      toast('Entry updated - the cite key is unchanged', 'ok');
    } catch (e) { btn.disabled = false; toast('Could not update the entry: ' + (e.message || e), 'bad'); }
  });

  Object.assign(RT.related, { show, checkMetadata, ICON: I.graph, META_ICON: I.meta });
})();
