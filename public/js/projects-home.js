/* Projects home (#pj-home inside the Write tab): the list of all LaTeX projects - search, filters, sort menu, cards,
   "New project" menu (blank, example, folder on disk, .zip upload, Overleaf import), rename / download / remove.
   write.js shows this page (RT.projectsHome.show()) and provides the shared dialogs and menus (RT.write.ui).
   RT.projectsHome.open(id) opens a project, RT.projectsHome.create() opens the "New project" menu (Overview, RT.nav). */
(() => {
const { $, $$, esc, api, toast, ls, enc } = RT;
const I = RT.icon;
const FILTER_TIPS = { all: 'All projects', local: 'Projects stored in the workspace', folder: 'Folders on disk opened as projects', overleaf: 'Projects linked to Overleaf' };
RT.projectsHome = RT.projectsHome || {};
const ui = () => RT.write.ui;
const S = { projects: [], papers: new Map(), filter: ls.get('rt-pj-filter', 'all'), q: '', sort: { key: 'updated', dir: 'desc', ...ls.json('rt-pj-sort', {}) }, built: false, seq: 0, busy: false };
const FILTERS = [['all', 'All projects', 'home', () => true], ['local', 'Local', 'files', (p) => !p.external && !p.overleaf],
  ['folder', 'Folders', 'folder', (p) => p.external], ['overleaf', 'Overleaf', 'cloud', (p) => !!p.overleaf]];
if (!FILTERS.some((f) => f[0] === S.filter)) S.filter = 'all';

// "3 months ago"
function relTime(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const ago = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (s < 45) return 'just now';
  if (s < 3600) return ago(Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return ago(Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return ago(Math.round(s / 86400), 'day');
  if (s < 86400 * 365) return ago(Math.max(1, Math.round(s / (86400 * 30.44))), 'month');
  return ago(Math.max(1, Math.round(s / (86400 * 365.25))), 'year');
}
const sourceOf = (p) => (p.overleaf ? 'Overleaf' : p.external ? 'Folder on disk' : 'Local');

const SORTS = [['updated', 'desc', 'Last modified, newest first'], ['updated', 'asc', 'Last modified, oldest first'], ['title', 'asc', 'Title, A to Z'], ['title', 'desc', 'Title, Z to A']];
const sortLabel = () => (S.sort.key === 'title' ? 'Title' : 'Last modified');

function build() {
  if (S.built || !$('#pj-home') || !RT.write || !RT.write.ui) return false;
  S.built = true;
  const ic = ui().ic;
  $('#pj-home').innerHTML = `
    <aside class="pj-side">
      <div class="pj-side-title section-head"><span class="sh-title">Show</span></div>
      <nav id="pj-filters" aria-label="Project filters">${FILTERS.map(([id, label, icon]) => `<button data-f="${id}" title="${esc(FILTER_TIPS[id] || label)}">${ic(icon)}<span class="nm ui">${esc(label)}</span><span class="cnt" data-cnt="${id}"></span></button>`).join('')}</nav>
    </aside>
    <section class="pj-main">
      <div class="pj-head">
        <div class="pj-head-text"><h2>Projects</h2><p class="pj-desc muted">Write papers and theses with your library at hand</p></div>
        <div class="spacer"></div>
        <button id="pj-new" class="primary ib has-text" aria-haspopup="true" title="New project: blank, example, a folder on disk, a .zip, or an Overleaf import">${I('add')}<span class="ib-text">New project</span>${I('chevron-down', { cls: 'pj-chev' })}</button>
        <input type="file" id="pj-zip" accept=".zip,application/zip" hidden>
      </div>
      <div class="pj-search">${I('search')}<input type="search" id="pj-q" placeholder="Search…" spellcheck="false" title="Search projects by title" aria-label="Search projects by title"></div>
      <div class="section-head pj-list-head"><span class="sh-title" id="pj-title">All projects</span><span class="sh-count" id="pj-count"></span>
        <span class="sh-actions"><button id="pj-sort" class="ib has-text ghost" aria-haspopup="true" title="Sort the projects">${I('sort')}<span class="ib-text" id="pj-sort-label">Last modified</span>${I('chevron-down', { cls: 'pj-chev' })}</button></span></div>
      <div class="pj-list-wrap">
        <div id="pj-rows" class="pj-cards" role="list" aria-labelledby="pj-title"></div>
        <div id="pj-empty" class="pj-empty" hidden></div>
      </div>
      <div class="pj-foot muted" id="pj-foot"></div>
    </section>`;
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-folder">
  <h3>Open LaTeX folder</h3>
  <div class="fs-bar"><button id="fs-up" class="ib" title="Parent folder" aria-label="Parent folder">${I('arrow-up')}</button><input type="text" id="fs-path" placeholder="/path/to/folder" spellcheck="false" title="Absolute path of the folder" aria-label="Folder path"><button id="fs-go" class="ib" title="Go to this path (Enter)" aria-label="Go to this path">${I('arrowRight')}</button></div>
  <div id="fs-list"></div>
  <div class="dlg-actions"><button id="fs-cancel" class="ib has-text" title="Cancel">${I('close')}<span class="ib-text">Cancel</span></button><button class="primary ib has-text" id="fs-open" title="Open this folder as a project">${I('folder')}<span class="ib-text">Open this folder</span></button></div>
</dialog>`);

  $('#pj-filters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.filter = b.dataset.f; ls.set('rt-pj-filter', S.filter); render(); });
  $('#pj-q').addEventListener('input', (e) => { S.q = e.target.value; render(); });
  $('#pj-sort').addEventListener('click', (e) => {
    RT.menu(e.currentTarget, [{ heading: 'Sort by' }, ...SORTS.map(([key, dir, label]) => ({ label, icon: S.sort.key === key && S.sort.dir === dir ? 'check' : '',
      onClick: () => { S.sort = { key, dir }; ls.set('rt-pj-sort', JSON.stringify(S.sort)); render(); } }))], { align: 'end' });
  });
  const projectOf = (el) => { const c = el && el.closest('[data-id]'); return c && S.projects.find((x) => x.id === c.dataset.id); };
  $('#pj-rows').addEventListener('click', (e) => {
    const p = projectOf(e.target); if (!p) return;
    const act = e.target.closest('button[data-act]');
    if (act && act.dataset.act === 'more') return moreMenu(act, p);
    run(act ? act.dataset.act : 'open', p);
  });
  $('#pj-rows').addEventListener('keydown', (e) => {
    if (e.target.closest('button')) return;
    const p = projectOf(e.target);
    if (p && e.key === 'Enter') run('open', p);
    else if (p && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) { e.preventDefault(); moreMenu($('[data-act=more]', e.target.closest('[data-id]')) || e.target, p); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { // move between the cards
      const cards = $$('#pj-rows [data-id]'), i = cards.indexOf(e.target.closest('[data-id]')), n = cards[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (n) { e.preventDefault(); n.focus(); }
    }
  });
  $('#pj-rows').addEventListener('contextmenu', (e) => { const p = projectOf(e.target); if (!p) return; e.preventDefault(); moreMenu({ x: e.clientX, y: e.clientY }, p); });
  $('#pj-new').addEventListener('click', (e) => newMenu(e.currentTarget));
  $('#pj-zip').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importZip(f).catch((err) => toast(err.message, 'bad')); });

  $('#fs-list').addEventListener('click', (e) => { const el = e.target.closest('.fs-dir'); if (el) fsList(el.dataset.path); });
  $('#fs-up').addEventListener('click', () => { if (fsParent) fsList(fsParent); });
  $('#fs-go').addEventListener('click', () => fsList($('#fs-path').value.trim()));
  $('#fs-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fsList($('#fs-path').value.trim()); } });
  $('#fs-cancel').addEventListener('click', () => $('#dlg-folder').close());
  $('#fs-open').addEventListener('click', async () => {
    const path = $('#fs-path').value.trim(); if (!path) return;
    try { await openFolder(path); $('#dlg-folder').close(); } catch (e) { toast(e.message, 'bad'); }
  });
  return true;
}
// the "New project" menu: blank, example, a folder on disk, a .zip, an Overleaf import
function newMenu(anchor) {
  ui().menu(anchor, [
    { label: 'Blank project', icon: 'newFile', run: () => newProject('blank') },
    { label: 'Example project', icon: 'tex', run: () => newProject('example') },
    { sep: true },
    { label: 'Open folder on disk…', icon: 'folder', run: pickFolder },
    { label: 'Upload .zip…', icon: 'upload', run: () => $('#pj-zip').click() },
    ...(RT.overleaf && RT.overleaf.importDialog ? [{ sep: true }, { label: 'Import from Overleaf…', icon: 'cloud', run: importOverleaf }] : []),
  ], { right: true });
}
// the rare actions of a project card: rename, download, remove
function moreMenu(anchor, p) {
  const items = [];
  if (!p.external && !p.missing) items.push({ label: 'Rename…', icon: 'edit', onClick: () => run('rename', p) });
  if (!p.missing) items.push({ label: 'Download as .zip', icon: 'download', onClick: () => run('zip', p) });
  if (items.length) items.push({ sep: true });
  items.push(p.external
    ? { label: 'Remove from the list…', icon: 'delete', danger: true, title: 'Remove from the list (the folder is kept)', onClick: () => run('remove', p) }
    : { label: 'Delete…', icon: 'delete', danger: true, title: 'Remove (moves it to the workspace trash)', onClick: () => run('remove', p) });
  if (anchor instanceof Element) RT.menu(anchor, items, { align: 'end' });
  else { // a right-click: a menu at the pointer
    const tmp = document.createElement('span');
    Object.assign(tmp.style, { position: 'fixed', left: anchor.x + 'px', top: anchor.y + 'px', width: '1px', height: '1px' });
    document.body.append(tmp);
    RT.menu(tmp, items, { onClose: () => tmp.remove() });
  }
}

function render() {
  if (!S.built) return;
  const ic = ui().ic, q = S.q.trim().toLowerCase();
  for (const [id, , , test] of FILTERS) { const el = $(`[data-cnt="${id}"]`); if (el) el.textContent = S.projects.filter(test).length; }
  $$('#pj-filters button').forEach((b) => { const on = b.dataset.f === S.filter; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'true' : 'false'); });
  const f = FILTERS.find((x) => x[0] === S.filter) || FILTERS[0];
  $('#pj-title').textContent = { all: 'All projects', local: 'Local projects', folder: 'Folders on disk', overleaf: 'Overleaf projects' }[f[0]];
  const inFilter = S.projects.filter(f[3]);
  const rows = inFilter.filter((p) => !q || p.name.toLowerCase().includes(q));
  const dir = S.sort.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => (S.sort.key === 'title'
    ? dir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : (!a.updatedAt) - (!b.updatedAt) || dir * String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) || a.name.localeCompare(b.name)));
  $('#pj-count').textContent = rows.length;
  $('#pj-sort-label').textContent = sortLabel();
  $('#pj-sort').title = `Sort the projects (now: ${SORTS.find(([k, d]) => k === S.sort.key && d === S.sort.dir)?.[2] || sortLabel()})`;
  $('#pj-rows').innerHTML = rows.map((p) => {
    const src = sourceOf(p), kind = p.overleaf ? 'overleaf' : p.external ? 'folder' : 'local';
    const tip = p.overleaf ? (p.overleaf.url || 'Linked to an Overleaf project') + (p.overleaf.lastSync ? ` — last synced ${relTime(p.overleaf.lastSync)}` : '') : p.path;
    const n = S.papers.has(p.id) ? S.papers.get(p.id) || 0 : null;
    return `<div class="card interactive pj-card${p.missing ? ' missing' : ''}" role="listitem" data-id="${esc(p.id)}" tabindex="0" aria-label="${esc(p.name)}">
      <span class="pj-fi">${ic(p.overleaf ? 'cloud' : p.external ? 'folder' : 'tex')}</span>
      <div class="pj-info">
        <div class="pj-name"><span class="nm" data-i18n-skip title="${esc(p.name)}">${esc(p.name)}</span><span class="badge pj-src pj-src-${kind}${p.overleaf ? ' ok' : ''}" title="${esc(tip)}">${p.overleaf ? I('overleaf-sync') : ''}${esc(src)}</span>${p.missing ? '<span class="badge bad pj-missing">folder missing</span>' : ''}</div>
        ${p.overleaf ? '' : `<div class="pj-path" data-i18n-skip title="${esc(p.path)}">${esc(p.path || '')}</div>`}
        <div class="pj-meta">${n === null ? '' : `<span class="pj-papers" title="Papers of the Library added to the project">${I('library')}<span>${esc(n === 1 ? '1 paper' : `${n} papers`)}</span></span>`}<span class="pj-when" title="${p.updatedAt ? esc(new Date(p.updatedAt).toLocaleString()) : ''}">${I('clock')}<span>Updated</span> <span>${esc(relTime(p.updatedAt))}</span></span></div>
      </div>
      <div class="pj-acts">${p.missing ? '' : `<button class="primary ib has-text pj-open" data-act="open" title="Open the project in the editor">${ic('arrowRight')}<span class="ib-text">Open</span></button>`}<button class="ib pj-more" data-act="more" aria-haspopup="true" title="More actions: rename, download, delete" aria-label="More actions">${I('more')}</button></div>
    </div>`;
  }).join('');
  const empty = $('#pj-empty');
  empty.hidden = rows.length > 0;
  $('.pj-list-head').hidden = !S.projects.length;
  if (!rows.length) {
    empty.replaceChildren(S.projects.length
      ? RT.emptyState({ ill: 'emptySearch', compact: true, title: 'No projects match', text: q ? 'Try another search, or clear the search box.' : 'Nothing in this group yet.',
        actions: q ? [{ label: 'Clear the search', icon: 'close', onClick: () => { $('#pj-q').value = ''; S.q = ''; render(); } }] : [{ label: 'All projects', icon: 'home', onClick: () => { S.filter = 'all'; ls.set('rt-pj-filter', 'all'); render(); } }] })
      : RT.emptyState({ ill: 'onboardingWelcome', title: 'No projects yet', text: 'Start a blank project, try the example, or open a folder.',
        actions: [{ label: 'New project', icon: 'add', primary: true, onClick: (e) => newMenu(e && e.currentTarget ? e.currentTarget : $('#pj-new')) },
          { label: 'Try the example', icon: 'latex', onClick: () => newProject('example').catch((err) => toast(err.message, 'bad')) }] }));
  }
  $('#pj-foot').textContent = `Showing ${rows.length} out of ${inFilter.length} project${inFilter.length === 1 ? '' : 's'}`;
}

async function refresh() {
  if (!build() && !S.built) return;
  const seq = ++S.seq;
  try {
    const [r, lite] = await Promise.all([api('/api/projects'), api('/api/projects?lite=1').catch(() => null)]);
    if (seq !== S.seq) return;
    S.projects = r.projects || [];
    S.papers = new Map(((lite && lite.projects) || []).map((x) => [x.id, x.papers || 0])); // the count of the Papers column
    render();
  } catch (e) { if (seq === S.seq) toast('Could not load the projects: ' + e.message, 'bad'); }
}
function show() { build(); render(); return refresh(); }
const visible = () => RT.state.view === 'write' && RT.write && RT.write.mode && RT.write.mode() === 'home';
const open = (id) => RT.write.openProject(id);

async function run(act, p) {
  try {
    if (act === 'open') {
      if (p.missing) return toast(`The folder ${p.path} no longer exists — remove the project from the list or put the folder back.`, 'bad');
      await open(p.id);
    } else if (act === 'rename') await rename(p);
    else if (act === 'zip') ui().download(`/api/projects/${enc(p.id)}/download`);
    else if (act === 'remove') await remove(p);
  } catch (e) { toast(e.message, 'bad'); }
}
async function newProject(template) {
  const name = await ui().ask({ title: template === 'example' ? 'New example project' : 'New blank project', message: 'Project name — letters, numbers, dashes and underscores (it is also the name of the project folder).', placeholder: 'my-paper', okText: 'Create' });
  if (name === null) return;
  if (!name.trim()) return toast('Give the project a name.', 'bad');
  const r = await api('/api/projects', { method: 'POST', json: { name: name.trim(), template } });
  RT.emit('projects:changed');
  await open(r.project.id);
}
async function importZip(file) {
  if (!/\.zip$/i.test(file.name)) return toast('Choose a .zip file.', 'bad');
  if (file.size > 100 * 1024 * 1024) return toast('That zip is larger than 100 MB.', 'bad');
  toast(`Unpacking ${file.name}…`);
  const r = await api('/api/projects/import-zip?name=' + enc(file.name.replace(/\.zip$/i, '')), { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } });
  toast(`Imported ${file.name} as ${r.project.name}`, 'ok');
  RT.emit('projects:changed');
  await open(r.project.id);
}
async function importOverleaf() {
  const p = await RT.overleaf.importDialog();
  await refresh();
  if (p && p.id) await open(p.id);
}
async function rename(p) {
  const name = await ui().ask({ title: 'Rename project', message: 'Letters, numbers, dashes and underscores. The project folder is renamed too.', value: p.name, okText: 'Rename' });
  if (name === null || !name.trim() || name.trim() === p.name) return;
  const r = await api(`/api/projects/${enc(p.id)}/rename-project`, { method: 'POST', json: { name: name.trim() } });
  for (const k of ['rt-tabs:', 'rt-collapsed:']) { const v = ls.get(k + p.id); if (v !== null) ls.set(k + r.project.id, v); }
  RT.write.rekeyProject(p.id, r.project); // rt-project, rt-working-project
  toast(`Renamed ${p.name} to ${r.project.name}`, 'ok');
  RT.emit('projects:changed');
}
async function remove(p) {
  const msg = p.external
    ? `Remove “${p.name}” from the list?\n\nThe folder ${p.path} and its files are NOT deleted — it is only forgotten here. Its version history is kept.`
    : `Remove the project “${p.name}”?\n\nIts folder is moved to the workspace trash (not permanently deleted).`;
  if (!(await ui().confirmDlg(msg, { title: 'Remove project', okText: 'Remove', danger: true }))) return;
  await api(`/api/projects/${enc(p.id)}`, { method: 'DELETE' });
  RT.write.rekeyProject(p.id, null);
  toast(p.external ? `Removed ${p.name} from the list (files untouched)` : `Moved ${p.name} to the workspace trash`, 'ok');
  RT.emit('projects:changed');
}

// open an existing folder: native chooser first, in-page browser as the fallback
async function pickFolder() {
  let r;
  toast('Choose a folder in the dialog that just opened…');
  try { r = await api('/api/fs/pick', { method: 'POST' }); }
  catch { toast(''); return browseFolder(); }
  toast('');
  if (r.path) await openFolder(r.path);
}
async function openFolder(path) {
  const r = await api('/api/projects/open', { method: 'POST', json: { path } });
  toast(`Opened ${r.project.path}`, 'ok');
  RT.emit('projects:changed');
  await open(r.project.id);
}
let fsParent = null;
async function fsList(path) {
  try {
    const r = await api('/api/fs/list' + (path ? '?path=' + enc(path) : ''));
    $('#fs-path').value = r.path; fsParent = r.parent; $('#fs-up').disabled = !r.parent;
    $('#fs-list').innerHTML = (r.dirs || []).map((d) => `<button class="fs-dir" data-path="${esc(d.path)}" title="${esc(d.path)}">${I('folder')}<span>${esc(d.name)}</span></button>`).join('') || '<div class="muted">No sub-folders here.</div>';
    $('#fs-list').scrollTop = 0;
  } catch (e) { toast(e.message, 'bad'); $('#fs-list').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}
function browseFolder() { $('#fs-list').innerHTML = ''; $('#dlg-folder').showModal(); return fsList(''); }

// a .zip dropped on the project list is imported as a new project; a .md reading list opens "Organize from a file"
// (organize.js) in the Library
function onDrop(e) {
  const md = [...e.dataTransfer.files].find((f) => /\.(md|markdown)$/i.test(f.name));
  if (md && RT.organize && ![...e.dataTransfer.files].some((f) => /\.zip$/i.test(f.name))) { RT.setView('library'); RT.organize.open({ file: md }); return; }
  const zips = [...e.dataTransfer.files].filter((f) => /\.zip$/i.test(f.name));
  if (!zips.length) return toast('Drop a .zip here to import it as a new project. To add files to a project, open it and drop them on its file tree.');
  importZip(zips[0]).catch((err) => toast(err.message, 'bad'));
}

RT.on('projects:changed', (d) => {
  if (!S.built) return null;
  if (!(d && d.ids)) return refresh();
  // papers added / removed: only the Papers column changes, its counts are in the cache of project-papers.js
  if (RT.projectPapers && RT.projectPapers.loaded && RT.projectPapers.loaded()) { S.papers = new Map(RT.projectPapers.projects().map((x) => [x.id, x.papers || 0])); if (visible()) render(); return null; }
  return visible() ? refresh() : null;
});
RT.on('disk:sync', () => { if (S.built && visible()) return refresh(); });

// for the Overview (overview.js) and RT.nav: open a project by id; create = the "New project" menu
async function openById(id) {
  if (RT.state.view !== 'write') RT.setView('write');
  if (!S.projects.length) await show();
  const p = S.projects.find((x) => x.id === id);
  if (p) return run('open', p);
  return open(id);
}
async function create() {
  if (RT.state.view !== 'write') RT.setView('write');
  if (RT.write && RT.write.mode && RT.write.mode() !== 'home' && RT.write.showHome && !(await RT.write.showHome())) return;
  await show();
  const b = $('#pj-new');
  if (b) { b.focus(); newMenu(b); }
}

Object.assign(RT.projectsHome, { show, refresh, onDrop, browseFolder, open: openById, create });
})();
