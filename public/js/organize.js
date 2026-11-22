/* "Organize from a file": a .md reading list / outline or a .bib file regroups the Library and fills a project.
   One dialog (#dlg-organize) with two stages:
     source   choose a file, paste its text, or take a .bib / .md file of the working project (read only)
     preview  POST /api/organize/parse (lib/organize.js, writes nothing) -> one section per group of the file: its
              name (editable; empty = "Ungrouped", which changes no category), the papers found in the library (each
              ticked; its current category when it differs; a flag when it is under several groups - the first ticked
              group wins for the category) and the entries that are not in the library (greyed, with what was looked for)
   Apply: the groups become categories (manual, POST /api/categories/apply) or tags (added, at most 12 per paper, PUT
   /api/items/:id) or nothing; the ticked papers join the project (RT.projectPapers.toggle); the .bib entries that are
   not in the library can be imported first (POST /api/import/bibtex), the .md ones with a DOI / arXiv id can be handed
   to the import queue ("Look up and import", RT.library.importRefs - that asks the internet). One toast with Undo:
   the old categories (with their status and reason) back unless moved since, the tags this action added taken off, the
   papers it added to the project taken out again; imported papers stay (the toast offers to move them to the Trash).
   The choices are kept in localStorage rt-organize. RT.organize: open({file?, text?, name?, pid?}), ICON. */
(() => {
  const { $, $$, esc, api, toast, ls, enc } = RT;
  RT.organize = RT.organize || {};
  const PP = RT.projectPapers;
  const ICON = 'list'; // (an RT.icon name) headings with entries under them
  const UNCAT = 'Uncategorized';
  const MAX_TEXT = 2 * 1024 * 1024, MAX_BIB = 8 * 1024 * 1024; // as lib/organize.js
  const maxOf = (name) => (kindOf(name) === 'bib' ? MAX_BIB : MAX_TEXT);
  // a name cut to n characters at a word (what a category: 60, or a tag: 40 can hold)
  const clip = (x, n) => { x = String(x || '').trim(); return x.length <= n ? x : (x.slice(0, n + 1).replace(/\s+\S*$/, '') || x.slice(0, n)).slice(0, n).trim(); };
  const plural = (n, w, many = w + 's') => `${n} ${n === 1 ? w : many}`;
  const items = () => (RT.library && RT.library.items ? RT.library.items() : []);
  const itemOf = (id) => items().find((i) => i.id === id) || null;
  const catOf = (it) => (it && it.category) || UNCAT;
  const tagsOf = (it) => (it && Array.isArray(it.tags) ? it.tags : []);
  const kindOf = (name) => (/\.bib(tex)?$/i.test(name || '') ? 'bib' : /\.(md|markdown|txt)$/i.test(name || '') ? 'md' : undefined);
  const ib = (act, title, ic, cls = '') => `<button type="button" class="ib ${cls}" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${RT.icon(ic)}</button>`;

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-organize" class="org" aria-labelledby="org-title">
  <div class="org-head"><h3 id="org-title">Organize from a file</h3><span class="spacer"></span>${ib('close', 'Close (Esc)', 'close')}</div>
  <div id="org-body"></div>
  <input type="file" id="org-file" accept=".md,.markdown,.txt,.bib,.bibtex,text/markdown,text/plain" hidden>
</dialog>`);
  const dlg = $('#dlg-organize'), body = $('#org-body'), fileIn = $('#org-file');

  // the remembered choices: mode 'categories' | 'tags' | 'none', project (add to it), imp (import the missing .bib entries), level
  const prefs = () => ({ mode: 'categories', project: true, imp: false, level: 0, ...ls.json('rt-organize', {}) });
  const savePrefs = (p) => ls.set('rt-organize', JSON.stringify({ mode: p.mode, project: p.project, imp: p.imp, level: p.level }));

  // S.text / name / kind: the source; S.res: the parse answer; S.names: the group names as edited; S.off: unticked
  // "<group index>|<item id>"; S.pid: the project the papers go to
  const S = { stage: 'source', text: '', name: '', kind: undefined, res: null, names: [], off: new Set(), pid: null, busy: false, ...prefs() };

  // ---------------------------------------------------------------- source
  async function showSource() {
    S.stage = 'source'; S.res = null;
    const w = project();
    body.innerHTML = `<p class="muted org-intro">A Markdown reading list or outline (its headings become the groups; it can cite with <code>\\cite{key}</code>, <code>[@key]</code>, <code>\`key\`</code>, DOIs, arXiv ids or titles) or a <code>.bib</code> file (its comment headings or JabRef groups). The papers it names are found in your library; nothing changes until you press Apply.</p>
      <div class="org-src"><button type="button" class="primary" data-act="choose">${RT.icon('folder')} Choose a .md or .bib file…</button><span class="org-proj-files"></span></div>
      <label class="org-paste-l">or paste its text<textarea id="org-paste" rows="9" spellcheck="false" placeholder="# World models&#10;- [@ha2018world]&#10;- 10.48550/arXiv.2301.04104&#10;&#10;## Manipulation&#10;- Diffusion Policy: Visuomotor Policy Learning via Action Diffusion"></textarea></label>
      <div class="dlg-actions"><button type="button" class="primary" data-act="read">Find these papers</button></div>`;
    openDlg();
    if (!w) return;
    // the .bib / .md files of the working project, as one-click sources (GET only; nothing is written to it)
    let files = [];
    try { files = ((await api(`/api/projects/${enc(w.id)}`)).files || []).filter((f) => f.type === 'file' && /\.(bib|md|markdown)$/i.test(f.path) && !(f.size > maxOf(f.path))); }
    catch { return; }
    const el = $('.org-proj-files', body);
    if (!el || S.stage !== 'source' || !files.length) return;
    el.innerHTML = `<span class="muted">From “${esc(w.name)}”:</span>` + files.slice(0, 8).map((f) => `<button type="button" class="mini" data-pfile="${esc(f.path)}" title="Read ${esc(f.path)} of the project (it is not changed)">${esc(f.path)}</button>`).join('')
      + (files.length > 8 ? `<span class="muted">+${files.length - 8}</span>` : '');
  }
  async function fromProjectFile(rel) {
    const w = project(); if (!w) return;
    try { const f = await api(`/api/projects/${enc(w.id)}/file?path=${enc(rel)}`); await load(f.content, rel.split('/').pop()); }
    catch (e) { toast(`Could not read ${rel}: ${e.message}`, 'bad'); }
  }
  async function fromFile(f) {
    if (!f) return;
    if (f.size > maxOf(f.name)) return toast(`${f.name} is larger than ${maxOf(f.name) / 1024 / 1024} MB.`, 'bad');
    let text;
    try { text = await f.text(); } catch (e) { return toast(`Could not read ${f.name}: ${e.message}`, 'bad'); }
    await load(text, f.name);
  }
  async function load(text, name) {
    S.text = String(text || ''); S.name = name || ''; S.kind = kindOf(name); S.names = []; S.off = new Set();
    if (!S.text.trim()) return toast('That file is empty.', 'bad');
    await parse();
  }

  // ---------------------------------------------------------------- parse + preview
  async function parse() {
    let r;
    body.classList.add('busy');
    try { r = await api('/api/organize/parse', { method: 'POST', json: { text: S.text, name: S.name, kind: S.kind, level: S.level } }); }
    catch (e) { toast('Could not read the file: ' + e.message, 'bad'); return false; }
    finally { body.classList.remove('busy'); }
    // a new parse keeps the names typed so far (same groups in the same order) unless the groups changed
    const same = S.res && S.res.groups.length === r.groups.length && S.res.groups.every((g, i) => g.name === r.groups[i].name);
    if (!same) { S.names = r.groups.map((g) => clip(g.name, 60)); S.orig = [...S.names]; S.off = new Set(); }
    const first = S.stage !== 'preview';
    S.res = r; S.stage = 'preview';
    render();
    if (first) { const el = $('.org-sum', body); if (el) el.focus(); } // the old focus (the button pressed) is gone
    return true;
  }
  const project = () => (S.pid && PP.project(S.pid) ? { id: S.pid, name: PP.project(S.pid).name } : PP.working());
  // id -> [group index] of the groups a paper is under
  function placesOf() {
    const m = new Map();
    S.res.groups.forEach((g, gi) => { for (const e of g.entries) if (e.match) { const l = m.get(e.match.id) || []; if (!l.includes(gi)) l.push(gi); m.set(e.match.id, l); } });
    return m;
  }
  const on = (gi, id) => !S.off.has(gi + '|' + id);
  const nameOf = (gi) => String(S.names[gi] ?? '').trim();
  const unmatched = () => S.res.groups.flatMap((g) => g.entries.filter((e) => !e.match));
  const missingBib = () => unmatched().filter((e) => e.bibtex);
  const missingRefs = () => [...new Set(unmatched().filter((e) => !e.bibtex).map((e) => (e.arxiv ? 'arXiv:' + e.arxiv : e.doi || '')).filter(Boolean))];

  function render() {
    // the focused control is drawn again: focus the new one (a checkbox, select, option or name field)
    const keep = $('.org-groups', body), top = keep ? keep.scrollTop : 0, a = document.activeElement;
    const focus = a && body.contains(a) ? ['pick', 'all', 'act', 'opt', 'name'].filter((k) => a.dataset[k] !== undefined).map((k) => `[data-${k}="${CSS.escape(a.dataset[k])}"]`)[0] : null;
    draw();
    const g = $('.org-groups', body); if (g) g.scrollTop = top;
    if (focus) { const el = $(focus, body); if (el) el.focus(); }
  }
  function draw() {
    const r = S.res, places = placesOf(), w = project();
    const st = r.stats;
    const levels = r.kind === 'md' ? `<label class="org-level">Groups from <select data-act="level">${[[0, 'the nearest heading'], [1, '# headings'], [2, '## headings and above'], [3, '### headings and above']].map(([v, l]) => `<option value="${v}"${S.level === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` : '';
    const sum = `<div class="org-sum" tabindex="-1"><b>${st.matched} of ${plural(st.entries, 'entry', 'entries')}</b> found in your library · ${plural(r.groups.length, 'group')}${S.name ? ` · <span class="muted">${esc(S.name)}</span>` : ''}${st.truncated ? ' · <span class="warn">only the first 3000 entries were read</span>' : ''}<span class="spacer"></span>${levels}</div>`;
    const groups = r.groups.map((g, gi) => {
      const seen = new Set();
      const rows = g.entries.map((e) => {
        if (!e.match) return `<div class="org-row miss" title="Line ${e.line}: ${esc(e.raw)}"><span class="org-x">–</span><span class="org-main"><span class="org-t">${esc(e.title || e.key || e.doi || (e.arxiv ? 'arXiv:' + e.arxiv : '') || e.raw)}</span><span class="org-sub">${esc(e.why || 'not in the library')}${e.bibtex ? ' · can be imported' : ''}</span></span></div>`;
        const id = e.match.id;
        if (seen.has(id)) return '';
        seen.add(id);
        const it = itemOf(id), pl = places.get(id) || [];
        const firstOn = pl.find((x) => on(x, id) && nameOf(x));
        const cur = catOf(it), target = nameOf(gi);
        const others = pl.filter((x) => x !== gi).map((x) => `“${nameOf(x) || 'Ungrouped'}”`);
        const flag = others.length ? `<span class="org-flag" title="Also under ${esc(others.join(', '))}. As a category, the first ticked group with a name is used${firstOn !== undefined ? `: “${esc(nameOf(firstOn))}”` : ''}.">${plural(pl.length, 'group')}</span>` : '';
        const now = S.mode === 'categories' && target && cur.toLowerCase() !== target.toLowerCase() ? `<span class="org-now" title="Its category now">now in ${esc(cur)}</span>` : '';
        const inP = w && PP.has(id, w.id) ? `<span class="org-in" title="Already in “${esc(w.name)}”">in project</span>` : '';
        return `<label class="org-row"><input type="checkbox" data-pick="${gi}|${esc(id)}"${on(gi, id) ? ' checked' : ''}><span class="org-main"><span class="org-t">${esc((it && it.fields.title) || e.match.title || e.match.citekey)}</span><span class="org-sub">${esc(e.match.citekey || '')} · matched by ${esc(e.match.how)}</span></span>${flag}${now}${inP}</label>`;
      }).join('');
      const ids = [...seen], n = ids.filter((id) => on(gi, id)).length;
      return `<section class="org-grp" data-g="${gi}"><div class="org-gh"><input type="checkbox" data-all="${gi}" title="Tick or untick every paper of this group"${ids.length && n === ids.length ? ' checked' : ''}${!ids.length ? ' disabled' : ''}>
        <input type="text" class="org-name" data-name="${gi}" value="${esc(S.names[gi] ?? '')}" maxlength="60" placeholder="Ungrouped" aria-label="Name of this group" title="The category or tag this group becomes; empty = Ungrouped (their category is not changed)">
        <span class="muted">${n} of ${plural(ids.length, 'paper')}${g.entries.length > seen.size ? ` · ${g.entries.filter((e) => !e.match).length} not found` : ''}</span></div>${rows || '<div class="org-row miss">No entries.</div>'}</section>`;
    }).join('');
    const mb = missingBib(), mr = missingRefs();
    // the project: a select in the dialog (a menu would open under the modal dialog)
    const anyProject = PP.projects().length > 0;
    const proj = `Add the ticked papers to <select data-act="proj" aria-label="Project">${w ? '' : '<option value="" selected>choose a project…</option>'}${PP.projects().map((p) => `<option value="${esc(p.id)}"${w && w.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
    const warn = nameWarning();
    body.innerHTML = `${sum}<div class="org-groups">${groups || '<div class="empty">No references found in this file.</div>'}</div>
      <div class="org-opts">
        <label>Grouping <select data-act="mode"><option value="categories"${S.mode === 'categories' ? ' selected' : ''}>Use the groups as categories</option><option value="tags"${S.mode === 'tags' ? ' selected' : ''}>Add the groups as tags</option><option value="none"${S.mode === 'none' ? ' selected' : ''}>Leave the grouping as it is</option></select></label>
        <label class="org-check${anyProject ? '' : ' off'}"><input type="checkbox" data-opt="project"${S.project && anyProject ? ' checked' : ''}${anyProject ? '' : ' disabled'}> ${anyProject ? proj : esc(PP.NO_PROJECT)}</label>
        ${warn ? `<div class="org-check warn">${esc(warn)}</div>` : ''}
        ${mb.length ? `<label class="org-check"><input type="checkbox" data-opt="imp"${S.imp ? ' checked' : ''}> Import ${mb.length === 1 ? 'the entry' : `the ${mb.length} entries`} that ${mb.length === 1 ? 'is' : 'are'} not in the library (then grouped too)</label>` : ''}
        ${mr.length ? `<div class="org-check muted">${plural(mr.length, 'reference')} with a DOI or arXiv id ${mr.length === 1 ? 'is' : 'are'} not in the library. <button type="button" class="mini" data-act="lookup" title="Look them up online (arxiv.org, doi.org) and import them through the import queue; then open this file again">Look up and import</button></div>` : ''}
      </div>
      <div class="dlg-actions"><button type="button" data-act="back" title="Choose another file">Other file</button><span class="spacer"></span><button type="button" class="primary" data-act="apply"${S.busy ? ' disabled' : ''}>Apply</button></div>`;
    openDlg();
  }

  // names that will not be used as shown: cut to 40 characters as tags, or two groups that end up as one category / tag
  function nameWarning() {
    if (S.mode === 'none' || !S.res) return '';
    const n = S.mode === 'tags' ? 40 : 60, what = S.mode === 'tags' ? 'tag' : 'category';
    const named = S.res.groups.map((g, gi) => nameOf(gi)).filter(Boolean);
    const long = named.find((x) => x.length > n);
    const seen = new Map();
    for (const x of named) {
      const k = clip(x, n).toLowerCase(), o = seen.get(k);
      if (o !== undefined && o !== x) return `“${o}” and “${x}” become one ${what}: “${clip(x, n)}”`;
      seen.set(k, x);
    }
    return long ? `${S.mode === 'tags' ? 'Tags' : 'Categories'} hold ${n} characters: “${long}” becomes “${clip(long, n)}”` : '';
  }

  // ---------------------------------------------------------------- apply
  // what Apply does with the current ticks: [{id, cat?: name, tags: [names]}], and the ids for the project
  function plan() {
    const per = new Map(), ids = [];
    S.res.groups.forEach((g, gi) => {
      const name = nameOf(gi);
      for (const e of g.entries) {
        if (!e.match || !on(gi, e.match.id)) continue;
        const id = e.match.id;
        if (!ids.includes(id)) ids.push(id);
        if (!name) continue;
        const p = per.get(id) || { id, cat: null, tags: [] };
        if (!p.cat) p.cat = clip(name, 60);
        const t = clip(name, 40);
        if (t && !p.tags.some((x) => x.toLowerCase() === t.toLowerCase())) p.tags.push(t);
        per.set(id, p);
      }
    });
    return { per: [...per.values()], ids };
  }

  async function apply() {
    if (S.busy) return;
    S.busy = true; render();
    try { await applyNow(); } finally { S.busy = false; if (dlg.open && S.res) render(); }
  }
  async function applyNow() {
    const undo = { cats: [], tags: [], project: null, imported: [] };
    const parts = [];
    let imported = 0, bad = false;
    // a step failed: say so, and what was done before it (the import cannot be undone from here)
    const fail = (m) => toast(imported ? `Imported ${plural(imported, 'paper')}, but ${m.replace(/^./, (c) => c.toLowerCase())}` : m, 'bad');
    // the items as they are now (tags or categories may have changed in another window since the dialog opened)
    if (RT.library && RT.library.refresh) await RT.library.refresh().catch(() => {});
    // 1. the missing .bib entries, then read the file again so that they are found too
    if (S.imp && missingBib().length) {
      try {
        const r = await api('/api/import/bibtex', { method: 'POST', json: { text: missingBib().map((e) => e.bibtex).join('\n\n') } });
        imported = r.items.length; undo.imported = r.items.map((i) => i.id);
      } catch (e) { if (!(e.status === 409)) { toast('Could not import the missing entries: ' + e.message, 'bad'); return; } }
      if (RT.library && RT.library.refresh) await RT.library.refresh().catch(() => {});
      if (!(await parse())) return fail('Could not read the file again.');
    }
    const { per, ids } = plan();
    if (!ids.length && !imported) return toast('No paper is ticked.', 'bad');
    // 2. categories (the first ticked group with a name) or tags (every ticked group with a name)
    if (S.mode === 'categories') {
      const byCat = new Map(); // one apply call; spelling of existing categories wins on the server
      for (const p of per) {
        const it = itemOf(p.id); if (!it || catOf(it).toLowerCase() === p.cat.toLowerCase()) continue;
        undo.cats.push({ id: p.id, category: catOf(it), categoryStatus: it.categoryStatus || '', categoryReason: it.categoryReason || '', categoryError: it.categoryError || '', ifCategory: p.cat });
        byCat.set(p.cat.toLowerCase(), true);
      }
      if (undo.cats.length) {
        const assignments = undo.cats.map((u) => ({ id: u.id, category: u.ifCategory }));
        try {
          const r = await api('/api/categories/apply', { method: 'POST', json: { manual: true, assignments } });
          if (r.changed) parts.push(`Moved ${plural(r.changed, 'paper')} into ${plural(byCat.size, 'category', 'categories')}`);
          if (r.missing) parts.push(`${plural(r.missing, 'paper')} no longer in the library`);
        } catch (e) { fail('Could not change the categories: ' + e.message); return; }
      }
    } else if (S.mode === 'tags') {
      let full = 0, failed = 0;
      for (const p of per) {
        const it = itemOf(p.id); if (!it) continue;
        const old = tagsOf(it), add = p.tags.filter((t) => !old.some((x) => x.toLowerCase() === t.toLowerCase()));
        if (!add.length) continue;
        const next = [...old, ...add].slice(0, 12);
        if (next.length === old.length) { full++; continue; }
        if (next.length < old.length + add.length) full++;
        try { await api('/api/items/' + enc(p.id), { method: 'PUT', json: { tags: next } }); undo.tags.push({ id: p.id, added: next.slice(old.length) }); } catch { failed++; }
      }
      if (undo.tags.length) parts.push(`Tagged ${plural(undo.tags.length, 'paper')}`);
      if (full) parts.push(`${full} already had 12 tags`);
      if (failed) { parts.push(`${failed} could not be tagged`); bad = true; }
    }
    // 3. the project (only what is new to it is taken out again by Undo)
    const w = project();
    if (S.project && PP.projects().length && ids.length) {
      if (!w) { parts.push('no project chosen: the papers were not added to one'); bad = true; }
      else {
        const r = await PP.toggle(ids, { pid: w.id, on: true, quiet: true });
        if (r) { undo.project = { pid: r.pid, ids: r.ids }; parts.push(r.ids.length ? `added ${plural(r.ids.length, 'paper')} to “${w.name}”` : `all already in “${w.name}”`); }
        else { parts.push(`could not add the papers to “${w.name}”`); bad = true; }
      }
    }
    if (imported) parts.unshift(`Imported ${plural(imported, 'paper')}`);
    RT.emit('library:changed');
    S.applied = true; dlg.close();
    const msg = parts.length ? parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) : 'Nothing to change: the papers are already grouped like this';
    const can = undo.cats.length || undo.tags.length || (undo.project && undo.project.ids.length);
    toast(msg, bad ? 'bad' : 'ok', can ? { label: 'Undo', run: () => revert(undo) } : null);
  }

  // Undo: the old categories go back with their status, reason and error as they were (/api/categories/apply restore),
  // except a paper moved to another category since; the tags this action added are taken off (other tags stay); the
  // papers it added to the project are taken out; papers imported by it stay in the library (offered for the Trash).
  async function revert(undo) {
    const bad = [], kept = [];
    if (undo.cats.length) {
      try {
        const r = await api('/api/categories/apply', { method: 'POST', json: { restore: true, assignments: undo.cats } });
        if (r.skipped) kept.push(`${plural(r.skipped, 'paper')} moved since kept ${r.skipped === 1 ? 'its' : 'their'} category`);
      } catch (e) { bad.push(e.message); }
    }
    if (undo.tags.length) {
      if (RT.library && RT.library.refresh) await RT.library.refresh().catch(() => {}); // the tags as they are now
      for (const u of undo.tags) {
        const it = itemOf(u.id); if (!it) continue;
        const cur = tagsOf(it), next = cur.filter((t) => !u.added.some((x) => x.toLowerCase() === t.toLowerCase()));
        if (next.length === cur.length) continue;
        try { await api('/api/items/' + enc(u.id), { method: 'PUT', json: { tags: next } }); } catch (e) { bad.push(e.message); }
      }
    }
    if (undo.project && undo.project.ids.length) { const r = await PP.toggle(undo.project.ids, { pid: undo.project.pid, on: false, quiet: true }); if (!r) bad.push('the project'); }
    RT.emit('library:changed');
    if (bad.length) return toast('Undone in part: ' + bad[0], 'bad');
    const n = undo.imported.length;
    if (n) kept.push(`the ${n === 1 ? 'imported paper stays' : `${n} imported papers stay`} in the library`);
    const msg = kept.length ? 'Undone · ' + kept.join(' · ') : 'Undone: the grouping and the project are as before';
    toast(msg, 'ok', n ? { label: `Move the imported ${n === 1 ? 'paper' : 'papers'} to the Trash`, icon: 'trash', run: () => trashImported(undo.imported) } : null);
  }
  async function trashImported(list) {
    let done = 0;
    for (const id of list) { try { await api('/api/items/' + enc(id), { method: 'DELETE' }); done++; } catch { /* already gone */ } }
    if (RT.library && RT.library.refresh) await RT.library.refresh().catch(() => {});
    RT.emit('library:changed');
    toast(`Moved ${plural(done, 'paper')} to the Trash (it can be restored from there)`, done === list.length ? 'ok' : 'bad');
  }

  // ---------------------------------------------------------------- events
  function openDlg() { if (!dlg.open) dlg.showModal(); }
  dlg.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]'), pf = e.target.closest('[data-pfile]');
    if (pf) return fromProjectFile(pf.dataset.pfile);
    if (!a || a.tagName === 'SELECT') return;
    const act = a.dataset.act;
    if (act === 'close') return dlg.close();
    if (act === 'choose') return fileIn.click();
    if (act === 'read') {
      const text = $('#org-paste').value;
      if (!text.trim()) return toast('Paste the text of a .md or .bib file first, or choose a file.', 'bad');
      return load(text, '');
    }
    if (act === 'back') return showSource();
    if (act === 'apply') return apply();
    if (act === 'lookup') {
      const refs = missingRefs();
      if (!refs.length || !RT.library || !RT.library.importRefs) return;
      RT.library.importRefs(refs.join('\n'));
      dlg.close();
      toast(`Looking up ${plural(refs.length, 'reference')} in the import queue; open the file again when they are in.`);
    }
  });
  dlg.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.pick) { if (t.checked) S.off.delete(t.dataset.pick); else S.off.add(t.dataset.pick); return render(); }
    if (t.dataset.all !== undefined) {
      const gi = Number(t.dataset.all);
      for (const en of S.res.groups[gi].entries) if (en.match) { const k = gi + '|' + en.match.id; if (t.checked) S.off.delete(k); else S.off.add(k); }
      return render();
    }
    if (t.dataset.opt) { S[t.dataset.opt] = t.checked; savePrefs(S); return; }
    if (t.dataset.act === 'mode') { S.mode = t.value; savePrefs(S); return render(); }
    if (t.dataset.act === 'proj') { S.pid = t.value || null; if (S.pid) S.project = true; return render(); }
    if (t.dataset.act === 'level') { S.level = Number(t.value) || 0; savePrefs(S); return void parse(); }
    if (t.dataset.name !== undefined) S.names[Number(t.dataset.name)] = t.value; // (no re-render: it would swallow a click on Apply)
  });
  // a typed name is kept as it is typed; the rows show it at the next render
  dlg.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.name !== undefined) S.names[Number(e.target.dataset.name)] = e.target.value; });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.name !== undefined) { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'org-paste') { e.preventDefault(); $('[data-act=read]', dlg).click(); }
  });
  // Esc in a name field only leaves the field. A preview closed with edits (names, unticked papers) is kept: open()
  // without a file returns to it (a confirm dialog on top of this modal one would share its Esc)
  const edited = () => S.stage === 'preview' && S.res && (S.off.size > 0 || S.names.some((x, i) => String(x ?? '') !== String((S.orig || [])[i] ?? '')));
  const inName = () => { const a = document.activeElement; return a && dlg.contains(a) && a.dataset && a.dataset.name !== undefined ? a : null; };
  dlg.addEventListener('keydown', (e) => { const a = e.key === 'Escape' && inName(); if (a) { e.preventDefault(); e.stopPropagation(); a.blur(); } });
  dlg.addEventListener('cancel', (e) => { const a = inName(); if (a) { e.preventDefault(); a.blur(); } });
  dlg.addEventListener('close', () => { S.draft = !S.applied && !!edited(); S.applied = false; });
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; fromFile(f); });
  RT.on('memberships:changed', () => { if (dlg.open && S.stage === 'preview' && !S.busy) render(); });

  // open({file}) / open({text, name}) go straight to the preview; open({pid}) adds to that project; open() asks for a file
  async function open({ file, text, name, pid } = {}) {
    if (!file && typeof text !== 'string' && !pid && S.draft && S.res) { S.draft = false; S.busy = false; return render(); } // the preview left with edits
    Object.assign(S, prefs(), { pid: pid || null, busy: false, draft: false });
    await PP.load().catch(() => {});
    if (RT.library && RT.library.items && !items().length) await RT.library.refresh().catch(() => {});
    if (file) { await showSource(); return fromFile(file); }
    if (typeof text === 'string') { await showSource(); return load(text, name || ''); }
    return showSource();
  }

  Object.assign(RT.organize, { open, ICON });
})();
