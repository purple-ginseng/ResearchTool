/* Safety nets: backups and the trash.
   - Backups window (Settings > "Show and restore backups…"): the dated copies of the whole workspace
     (lib/backup.js, /api/backup) and the copies of library.json alone (<workspace>/backups, lib/core.js). It opens by
     itself when the server reports that library.json is damaged (any request answering 503 {damaged: true}):
     nothing can be saved until a copy is put back.
   - Recently deleted (bin button of the Library): the deleted papers in <workspace>/trash/library, put back with
     everything that belonged to them, and emptying the trash (lib/trash.js, /api/trash).
   RT.safety.open()                    the Backups window
   RT.safety.trash()                   the Recently deleted window
   RT.safety.deleted(bins, label)      the message after a delete, with its Undo button
   RT.safety.backupState(el, status?)  one line about the last backup, written into el */
(() => {
  const { $, esc, api, toast, icon } = RT;
  RT.safety = RT.safety || {};

  const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB' : n >= 1000 ? Math.round(n / 1000) + ' kB' : (n || 0) + ' bytes');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const z = (n) => String(n).padStart(2, '0');
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  // "today", "yesterday", "5 days ago"
  const ago = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; const a = new Date(), days = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000); return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`; };

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-backups" class="bk">
  <h3 id="bk-title">Backups</h3>
  <div class="seg bk-seg" id="bk-seg" role="tablist"><button data-tab="ws" role="tab" class="on">Whole workspace</button><button data-tab="lib" role="tab">List of references only</button></div>
  <p class="muted" id="bk-info"></p>
  <div id="bk-list" class="bk-list"></div>
  <div class="dlg-actions"><button id="bk-now" title="Keep a copy as it is right now">Back up now</button><span class="spacer"></span><button id="bk-close">Close</button></div>
</dialog>
<dialog id="dlg-trash" class="bk trash-dlg">
  <h3>Recently deleted</h3>
  <p class="muted" id="tr-info">Papers you deleted, with their PDF, note, highlights, diagrams and quizzes. Put one back with the arrow.</p>
  <div id="tr-list" class="bk-list"></div>
  <p class="muted" id="tr-sum" role="status"></p>
  <div class="dlg-actions"><button id="tr-old" class="danger" hidden></button><button id="tr-all" class="danger" hidden></button><span class="spacer"></span><button id="tr-close">Close</button></div>
</dialog>`);

  // ================================================================= backups
  const dlg = $('#dlg-backups');
  let damaged = false, tab = 'ws', busy = false;

  const REASON = { manual: 'made by hand', daily: 'automatic', 'before-restore': 'kept before a restore' };
  function wsRows(r) {
    if (!r.snapshots.length) return `<div class="muted">No backup yet. ${r.auto ? 'The first one is made a minute or two after the app starts, then once a day.' : 'Automatic backup is switched off in Preferences.'}</div>`;
    return r.snapshots.map((b) => `
      <div class="bk-row"><span>${esc(when(b.when))}</span><span class="muted">${b.papers == null ? '' : plural(b.papers, 'paper') + ' · '}${size(b.bytes)} · ${esc(REASON[b.reason] || b.reason)}${b.other ? ` · <span class="bk-warn" title="${esc(b.workspace)}">of another workspace</span>` : ''}</span>
        <button data-snap="${esc(b.name)}" data-when="${esc(when(b.when))}" title="Put the workspace back to this backup">Restore</button></div>`).join('');
  }
  function libRows(r) {
    return r.backups.length ? r.backups.map((b, k) => `
      <div class="bk-row"><span>${esc(b.when)}</span><span class="muted">${b.items == null ? 'cannot be read' : plural(b.items, 'reference')}</span>
        <button data-restore="${esc(b.name)}" ${b.items == null ? 'disabled' : ''} class="${damaged && k === 0 ? 'primary' : ''}">Restore</button></div>`).join('')
      : `<div class="muted">No copies yet.${damaged ? ' Look under “Whole workspace” for a backup of everything.' : ''}</div>`;
  }
  async function load() {
    const list = $('#bk-list'), mine = tab;
    list.innerHTML = '<div class="muted"><span class="spin"></span> Loading…</div>';
    for (const b of $('#bk-seg').children) { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    try {
      if (tab === 'lib') {
        const r = await api('/api/library/backups');
        if (mine !== tab) return;
        damaged = !!r.damaged;
        $('#bk-info').innerHTML = damaged
          ? '<b>library.json could not be read, so nothing was loaded and nothing has been overwritten.</b> Put back the most recent copy below; the damaged file is kept beside the copies. Your PDFs, notes, diagrams and quizzes are separate files and are not affected.'
          : 'A copy of the list of references (titles, authors, key points, categories, tags) is kept automatically before it changes, at most every 10 minutes. Restoring one leaves PDFs, notes and everything else as they are.';
        list.innerHTML = libRows(r);
      } else {
        const r = await api('/api/backup');
        if (mine !== tab) return;
        $('#bk-info').innerHTML = `Dated copies of everything in the workspace, in <code>${esc(r.dir)}</code>${r.snapshots.length ? ` (${size(r.size)} on disk)` : ''}. Restoring one first keeps the workspace as it is now as another backup, and moves it to the trash as well.`
          + (r.error ? `<br><span class="bk-warn">The last backup failed: ${esc(r.error.message)}</span>` : '');
        list.innerHTML = wsRows(r);
      }
    } catch (e) { if (mine === tab) list.innerHTML = `<div class="muted">Could not load the backups: ${esc(e.message)}</div>`; }
    $('#bk-title').textContent = damaged ? 'The library file is damaged' : 'Backups';
    $('#bk-now').hidden = damaged && tab === 'lib';
  }
  function open(which) {
    if (which) tab = which;
    if (!dlg.open) dlg.showModal();
    load();
  }

  async function restoreSnapshot(t) {
    const ok = await RT.confirm(`Put the whole workspace back to the backup of ${t.dataset.when}?\n\nEverything changed since then is taken out of the workspace: papers, notes, highlights, projects. Nothing is lost for good - the workspace as it is now is first kept as another backup, and moved to the trash too.`, { title: 'Restore backup', okText: 'Restore this backup', icon: 'reset' });
    if (!ok) return;
    await RT.flush().catch(() => {});
    busy = true; t.disabled = true; t.innerHTML = '<span class="spin"></span>';
    $('#bk-info').innerHTML = '<span class="spin"></span> Restoring… keeping the current workspace first. Do not close this window.';
    try {
      const r = await api('/api/backup/restore', { method: 'POST', json: { name: t.dataset.snap } });
      toast(`Backup of ${t.dataset.when} restored${r.papers == null ? '' : `: ${plural(r.papers, 'paper')}`}. The page reloads…`, 'ok');
      RT.ls.set('rt.reader.last', ''); // the open paper may not exist in the restored workspace
      setTimeout(() => location.reload(), 900);
    } catch (err) { busy = false; toast(err.message, 'bad'); load(); }
  }

  dlg.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t || busy) return;
    if (t.id === 'bk-close') dlg.close();
    else if (t.dataset.tab) { tab = t.dataset.tab; load(); }
    else if (t.id === 'bk-now') {
      const label = t.textContent; t.disabled = true; t.innerHTML = '<span class="spin"></span> Backing up…';
      try {
        if (tab === 'lib') { await api('/api/library/backups', { method: 'POST', json: {} }); toast('List of references backed up', 'ok'); }
        else { const r = await api('/api/backup', { method: 'POST', json: {} }); toast(`Backup made: ${r.snapshot.files} files in ${r.dir}`, 'ok'); }
      } catch (err) { toast(err.message, 'bad'); }
      t.disabled = false; t.textContent = label; load();
    }
    else if (t.dataset.snap) restoreSnapshot(t);
    else if (t.dataset.restore) {
      if (!damaged && !(await RT.confirm('Replace the current list of references with this copy?\n\nThe current list is kept as a copy too, so this can be reversed.', { title: 'Restore the list of references', okText: 'Restore this copy', icon: 'reset' }))) return;
      t.disabled = true;
      try { const r = await api('/api/library/restore', { method: 'POST', json: { name: t.dataset.restore } }); toast(`Library restored: ${r.items} references`, 'ok'); setTimeout(() => location.reload(), 600); }
      catch (err) { toast(err.message, 'bad'); t.disabled = false; }
    }
  });
  dlg.addEventListener('cancel', (e) => { if (damaged || busy) e.preventDefault(); }); // a damaged library is not something to dismiss with Esc

  // any request can find the library damaged: say so once, with the way out
  let told = false;
  RT.on('library:damaged', () => { if (told) return; told = true; damaged = true; open('lib'); });
  if (window.RT_LIBRARY_DAMAGED) { told = true; damaged = true; open('lib'); } // reported before this script had loaded

  // one line about the backups for the Settings window
  async function backupState(el, r) {
    try {
      r = r || await api('/api/backup');
      const n = r.snapshots.filter((s) => !s.other).length;
      el.className = r.error || (r.stale && r.last) ? 'set-bad' : 'muted';
      el.textContent = (r.last ? `Last backup: ${ago(r.last.when)} (${when(r.last.when)}) · ${plural(n, 'backup')} kept, ${size(r.size)} on disk` : 'No backup has been made yet.')
        + (r.error ? ` · The last try failed: ${r.error.message}` : '');
    } catch (e) { el.className = 'muted'; el.textContent = 'Could not read the backup folder: ' + e.message; }
  }
  // at the start: say so when the backups have fallen behind (the disk was not connected, or they are switched off).
  // The answer is kept in RT.state.backup and sent as 'backup:status' (the Overview shows it without asking again).
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const r = await api('/api/backup?sizes=0');
      RT.state.backup = r;
      RT.emit('backup:status', r);
      if (!r.stale || (r.auto && !r.error && !r.last)) return; // never yet with automatic backup on: it is about to be made
      const b = $('#btn-settings');
      b.classList.add('attn'); b.title = `${r.last ? `The last backup of your workspace was made ${ago(r.last.when)}` : 'Your workspace has no backup'}${r.error ? ` (${r.error.message})` : r.auto ? '' : ' and automatic backup is switched off'} - open Preferences › Library & files`;
      RT.banner.show({ id: 'backup-stale', tone: 'warn', text: r.last ? `The last backup of your workspace was made ${ago(r.last.when)}.` : 'Your workspace has no backup yet.',
        action: { label: 'Open backup settings', onClick: () => (RT.prefs && RT.prefs.open ? RT.prefs.open('library') : $('#btn-settings').click()) } });
    } catch { /* the notice is a convenience */ }
  });

  // ================================================================= recently deleted
  const tdlg = $('#dlg-trash');
  let tbusy = false;
  const authors = (p) => [RT.authorsShort(p.author), p.year].filter(Boolean).join(', ');
  function paintTrash(r) {
    $('#tr-list').innerHTML = r.papers.length ? r.papers.map((p) => `
      <div class="bk-row tr-row" data-bin="${esc(p.bin)}">
        <div class="tr-what"><div class="tr-title" title="${esc(p.title)}">${esc(p.title)}</div>
          <div class="muted"><span class="au">${esc(authors(p))}</span> · deleted ${esc(ago(p.deleted))} · ${esc([...p.has, p.keypoints ? plural(p.keypoints, 'key point') : ''].filter(Boolean).join(', ') || 'reference only')} · ${size(p.size)}</div></div>
        <button class="ib" data-back title="${p.inLibrary ? 'A paper with this id is in the library again' : 'Put this paper back into the library'}" aria-label="Put back into the library" ${p.inLibrary ? 'disabled' : ''}>${icon('undo')}</button>
        <button class="ib" data-forever title="Delete this paper for good" aria-label="Delete for good">${icon('trash')}</button>
      </div>`).join('') : '<div class="muted tr-empty">No deleted papers.</div>';
    $('#tr-sum').textContent = r.count ? `The trash holds ${size(r.size)}: ${plural(r.papers.length, 'deleted paper')}${r.other ? ` and ${plural(r.other, 'other item')} (replaced PDFs, deleted project files, workspaces kept before a restore: ${size(r.otherSize)})` : ''}.` : 'The trash is empty.';
    const old = $('#tr-old'), all = $('#tr-all');
    old.hidden = !r.old; old.textContent = `Empty items older than ${r.days} days (${size(r.oldSize)})`; old.dataset.days = r.days; old.dataset.size = size(r.oldSize);
    all.hidden = !r.count; all.textContent = `Empty the trash (${size(r.size)})`; all.dataset.size = size(r.size);
  }
  async function loadTrash() {
    $('#tr-list').innerHTML = '<div class="muted"><span class="spin"></span> Loading…</div>'; $('#tr-sum').textContent = '';
    try { paintTrash(await api('/api/trash')); }
    catch (e) { $('#tr-list').innerHTML = `<div class="muted">Could not read the trash: ${esc(e.message)}</div>`; $('#tr-old').hidden = $('#tr-all').hidden = true; }
  }
  function trash() { if (!tdlg.open) tdlg.showModal(); loadTrash(); }

  // put papers back (bins of DELETE /api/items/:id or of the list); resolves how many came back
  async function putBack(bins) {
    let n = 0, last = null, kept = 0, err = '';
    for (const bin of bins) {
      try { const r = await api(`/api/trash/${RT.enc(bin)}/restore`, { method: 'POST', json: {} }); n++; last = r.item; kept += r.kept.length; }
      catch (e) { err = e.message; }
    }
    if (n) RT.emit('library:changed');
    if (err) toast(n ? `${plural(n, 'paper')} put back, ${bins.length - n} could not be: ${err}` : err, 'bad');
    else if (n) toast(n === 1 ? `Put back “${RT.texPlain ? RT.texPlain(last.fields.title || last.citekey) : last.fields.title || last.citekey}”${kept ? ' (some of its files were already there and stay in the trash)' : ''}` : `Put back ${plural(n, 'paper')}`, 'ok');
    return { n, last };
  }
  // the message after a delete: what went, and the way back
  function deleted(bins, label) {
    bins = (bins || []).filter(Boolean);
    if (!bins.length) return toast(`Deleted ${label}`, 'ok');
    toast(`Deleted ${label} - moved to Recently deleted`, 'ok', { label: 'Undo: put it back into the library', run: async () => {
      const r = await putBack(bins);
      if (r.n === 1 && r.last && RT.library && RT.library.select) { try { await RT.library.refresh(); RT.library.select(r.last.id); } catch { /* the list shows it anyway */ } }
    } });
  }

  tdlg.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t || tbusy) return;
    if (t.id === 'tr-close') return tdlg.close();
    const row = t.closest('.tr-row');
    tbusy = true;
    try {
      if (row && 'back' in t.dataset) {
        t.disabled = true; t.innerHTML = '<span class="spin"></span>';
        await putBack([row.dataset.bin]);
        await loadTrash();
      } else if (row && 'forever' in t.dataset) {
        if (await RT.confirm(`Delete “${$('.tr-title', row).textContent}” for good?\n\nIts PDF, note, highlights, diagrams and quizzes are removed from this Mac. This cannot be undone.`, { title: 'Delete for good', okText: 'Delete for good', danger: true, icon: 'trash' })) {
          paintTrash(await api(`/api/trash/${RT.enc(row.dataset.bin)}`, { method: 'DELETE' }));
          toast('Deleted for good', 'ok');
        }
      } else if (t.id === 'tr-old' || t.id === 'tr-all') {
        const days = t.id === 'tr-old' ? Number(t.dataset.days) : 0;
        if (await RT.confirm(`${days ? `Delete everything that has been in the trash for more than ${days} days` : 'Delete everything in the trash'} for good?\n\n${t.dataset.size} of deleted papers, replaced PDFs and deleted project files are removed from this Mac. This cannot be undone.`, { title: 'Empty the trash', okText: 'Delete for good', danger: true, icon: 'trash' })) {
          const label = t.textContent; t.disabled = true; t.innerHTML = '<span class="spin"></span> Emptying…';
          try { const r = await api('/api/trash?days=' + days, { method: 'DELETE' }); paintTrash(r); toast(`Trash emptied: ${size(r.freed)} freed${r.failed ? `, ${plural(r.failed, 'item')} could not be removed` : ''}`, r.failed ? 'bad' : 'ok'); }
          finally { t.disabled = false; if (t.querySelector('.spin')) t.textContent = label; }
        }
      }
    } catch (err) { toast(err.message, 'bad'); loadTrash(); }
    tbusy = false;
  });

  Object.assign(RT.safety, { open, trash, deleted, putBack, backupState });
})();
