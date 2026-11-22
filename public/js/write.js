/* Write tab (#view-write): the LaTeX editor. Projects are folders; the landing page (project list) is built by
   projects-home.js inside #pj-home, the editor lives in #wr:
     top bar (home, save, project menu, history, layout)  |  icon rail + file tree / outline / project search
     | tabs + toolbar + CodeMirror  |  PDF pane (recompile, logs, page + zoom controls, SyncTeX)  |  history view.
   Exposes RT.write: openProject / flushAll / currentProject / sync / compile / showHome / ui (shared dialogs + menus). */
(() => {
const { $, $$, esc, api, toast, debounce, ls, enc, authorsShort } = RT;
RT.write = RT.write || {};
const libItems = () => (RT.library && RT.library.items ? RT.library.items() : []);
const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || '');
const MOD = MAC ? '⌘' : 'Ctrl+';
const KEY = MAC ? 'Cmd' : 'Ctrl';

// ---------------- icons: the shared set (RT.icon, core.js) ----------------
// The Editor's old names go through RT.icon's alias table (chevDown, tex, bib, ol, layout ...); the few below are
// names where the Editor means something more specific than the shared alias.
const ICON_NAMES = { ref: 'tag', cite: 'citation', related: 'quote', cmptable: 'grid', leave: 'sign-out', pdf: 'pdf', image: 'image' };
const ic = (name, cls = '') => { const n = ICON_NAMES[name] || name; return RT.icon(RT.icon.has(n) ? n : 'paper', { cls }); };
// kept for write-ai.js / projects-home.js (RT.write.ui.icon): the same as ic
const icon = (name) => ic(name);

// ---------------- shared UI: menus, popovers, dialogs (also used by projects-home.js) ----------------
document.body.insertAdjacentHTML('beforeend', '<div id="ctx" class="popover menu" hidden role="menu"></div><div id="wr-pop" class="popover" hidden></div>');
let popAnchor = null, justClosed = null;
function closeMenus(target) {
  if (popAnchor && target && popAnchor.contains && popAnchor.contains(target)) justClosed = popAnchor; // the click that follows must not reopen it
  $('#ctx').hidden = true; $('#wr-pop').hidden = true; popAnchor = null;
}
function place(el, anchor, o = {}) {
  el.hidden = false;
  let x, y;
  if (anchor instanceof Element) { const r = anchor.getBoundingClientRect(); x = o.right ? r.right - el.offsetWidth : r.left; y = r.bottom + 3; if (y + el.offsetHeight > innerHeight - 6 && r.top - el.offsetHeight - 3 > 4) y = r.top - el.offsetHeight - 3; }
  else ({ x, y } = anchor);
  el.style.left = Math.max(4, Math.min(x, innerWidth - el.offsetWidth - 6)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - el.offsetHeight - 6)) + 'px';
}
const reopening = (anchor) => { if (anchor instanceof Element && justClosed === anchor) { justClosed = null; return true; } return false; };
// items: [{label, icon, check (bool), hint, disabled, danger, run} | {sep: true} | {head: 'text'} | {note: 'a sentence'}]
function menu(anchor, items, o = {}) {
  if (reopening(anchor)) return;
  closeMenus();
  const m = $('#ctx');
  m._items = items;
  m.innerHTML = items.map((it, i) => (it.sep ? '<hr>' : it.head ? `<div class="menu-head">${esc(it.head)}</div>` : it.note ? `<div class="menu-note">${esc(it.note)}</div>`
    : `<button role="menuitem" data-i="${i}"${it.disabled ? ' disabled' : ''} class="${it.danger ? 'danger' : ''}"${it.title ? ` title="${esc(it.title)}"` : ''}>`
      + `<span class="mi">${it.check ? ic('check') : it.icon ? icon(it.icon) : ''}</span><span class="ml">${esc(it.label)}</span>${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}</button>`)).join('');
  place(m, anchor, o);
  popAnchor = anchor instanceof Element ? anchor : null;
  const first = $('button:not([disabled])', m); if (first) first.focus();
}
$('#ctx').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  const it = $('#ctx')._items[Number(b.dataset.i)];
  closeMenus();
  if (it && it.run) Promise.resolve().then(it.run).catch((err) => toast(err.message, 'bad'));
});
$('#ctx').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const bs = $$('#ctx button:not([disabled])'), n = bs[(bs.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length];
  if (n) n.focus();
});
function popover(anchor, html, o = {}) {
  if (reopening(anchor)) return null;
  closeMenus();
  const p = $('#wr-pop');
  p.style.width = o.width ? o.width + 'px' : '';
  p.innerHTML = html;
  place(p, anchor, o);
  popAnchor = anchor instanceof Element ? anchor : null;
  return p;
}
// searchable list: items [{key, title, sub, mark?, group?}] - a group name is shown as a heading where it starts
function pickList(anchor, { placeholder = 'Search…', items, onPick, empty = 'Nothing found.' }) {
  const pop = popover(anchor, `<input type="search" class="pl-q" placeholder="${esc(placeholder)}" spellcheck="false"><div class="pl-list"></div>`, { width: 380 });
  if (!pop) return;
  const q = $('.pl-q', pop), list = $('.pl-list', pop);
  items.forEach((it, n) => { it._n = n; it._s = [it.key, it.title, it.sub].join(' ').toLowerCase(); });
  const render = () => {
    const s = q.value.trim().toLowerCase();
    let group = null;
    list.innerHTML = items.filter((it) => !s || it._s.includes(s)).slice(0, 300)
      .map((it, n) => {
        const head = it.group && it.group !== group ? `<div class="pl-head">${esc(it.group)}</div>` : '';
        group = it.group;
        return `${head}<div class="pl-item${n === 0 ? ' cur' : ''}" data-n="${it._n}"><code>${esc(it.key)}</code>${esc(it.title || '')}${it.mark ? `<span class="pl-mark"> · ${esc(it.mark)}</span>` : ''}${it.sub ? `<div class="muted">${esc(it.sub)}</div>` : ''}</div>`;
      }).join('')
      || `<div class="muted pl-empty">${esc(empty)}</div>`;
  };
  const pick = (el) => { if (!el) return; const it = items[Number(el.dataset.n)]; closeMenus(); Promise.resolve().then(() => onPick(it)).catch((err) => toast(err.message, 'bad')); };
  q.addEventListener('input', render);
  q.addEventListener('keydown', (e) => {
    const cur = $('.pl-item.cur', list);
    if (e.key === 'Enter') { e.preventDefault(); pick(cur); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = $$('.pl-item', list), n = cur && all[all.indexOf(cur) + (e.key === 'ArrowDown' ? 1 : -1)]; // over the headings
      if (n) { cur.classList.remove('cur'); n.classList.add('cur'); n.scrollIntoView({ block: 'nearest' }); }
    }
  });
  list.addEventListener('click', (e) => pick(e.target.closest('.pl-item')));
  render(); q.focus();
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx, #wr-pop')) closeMenus(e.target); });
document.addEventListener('click', () => setTimeout(() => { justClosed = null; }, 0));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !($('#ctx').hidden && $('#wr-pop').hidden)) { const a = popAnchor; closeMenus(); if (a && a.focus) a.focus(); } });
window.addEventListener('blur', () => closeMenus());

// A modal <dialog> with a <form method="dialog">. Resolves read(dialog) when the form is submitted (OK), or null
// when it is cancelled (Cancel button, Esc). Settles on the click itself rather than waiting for the close event.
function openDialog(html, read = () => true, cls = '') {
  const d = document.createElement('dialog');
  d.className = 'wr-dlg ' + cls; d.innerHTML = html;
  document.body.append(d);
  const result = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { d.close(); } catch { /* already closed */ } d.remove(); resolve(v); };
    d.addEventListener('submit', (e) => { e.preventDefault(); done(read(d)); });
    d.addEventListener('click', (e) => { if (e.target.closest('[data-cancel]')) done(null); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    d.addEventListener('close', () => done(null));
  });
  d.showModal();
  return { d, result };
}
// The action row of a dialog: labelled buttons (icon and name). okText names the confirm button, icon
// is its face (default: a check mark, or the trash can for a destructive Delete / Remove); cancel: false leaves
// only the confirm button.
function dlgActions({ okText = 'OK', icon: okIcon = '', danger = false, cancel = true } = {}) {
  const face = okIcon || (danger && /^(delete|remove)/i.test(okText) ? 'trash' : 'check');
  return `<div class="dlg-actions">${cancel ? `<button type="button" class="ib has-text" data-cancel title="Cancel (Esc)">${ic('close')}<span class="ib-text">Cancel</span></button>` : ''}`
    + `<button class="primary ib has-text${danger ? ' danger' : ''}" value="ok" title="${esc(okText)} (Enter)">${icon(face)}<span class="ib-text">${esc(okText)}</span></button></div>`;
}
// in-page replacement for prompt(): resolves the text, or null when cancelled
function ask({ title, message = '', value = '', placeholder = '', okText = 'OK', icon: okIcon = '' }) {
  const { d, result } = openDialog(`<form method="dialog"><h3>${esc(title)}</h3>${message ? `<p class="muted dlg-msg">${esc(message)}</p>` : ''}
    <input type="text" class="dlg-input" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">
    ${dlgActions({ okText, icon: okIcon })}</form>`, (x) => $('.dlg-input', x).value);
  const inp = $('.dlg-input', d);
  inp.focus();
  const dot = value.lastIndexOf('.'), slash = value.lastIndexOf('/');
  inp.setSelectionRange(slash + 1, dot > slash + 1 ? dot : value.length); // select the name, not the folder or extension
  return result;
}
// in-page replacement for confirm()
function confirmDlg(message, { title = 'Please confirm', okText = 'OK', danger = false, icon: okIcon = '' } = {}) {
  const { d, result } = openDialog(`<form method="dialog"><h3>${esc(title)}</h3><p class="dlg-msg">${esc(message)}</p>
    ${dlgActions({ okText, icon: okIcon, danger })}</form>`);
  $('button.primary', d).focus();
  return result.then((v) => v === true);
}
function download(url) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.append(a); a.click(); a.remove(); }

// ---------------- markup ----------------
const COMPILE_HINT = `Recompile the project (${MOD}Enter)`;
const tb = (cmd, title, inner, cls = '') => `<button class="tb ${cls}" data-cmd="${cmd}" title="${esc(title)}" aria-label="${esc(title)}">${inner}</button>`;
$('#view-write').innerHTML = `
  <div id="pj-home"></div>
  <div id="wr" hidden>
    <div class="wr-top">
      <div class="tgroup" role="group" aria-label="File">
      <button id="btn-home" class="tb" title="Back to all projects" aria-label="Back to all projects">${ic('home')}</button>
      <button id="btn-save" class="tb" title="Save all files and add a version to the history (${MOD}S)" aria-label="Save">${RT.icon('save')}</button>
      </div>
      <span id="save-state" class="muted"></span>
      <div class="spacer"></div>
      <button id="btn-proj-menu" class="wr-title" title="Project menu" aria-label="Project menu" aria-haspopup="true"><span id="proj-name"></span>${ic('chevDown')}</button>
      <div class="spacer"></div>
      <div id="overleaf-slot"></div>
      <div class="tgroup" role="group" aria-label="View">
      <button id="btn-history" class="tb" title="History: browse, compare and restore earlier versions" aria-label="History">${ic('history')}</button>
      <button id="btn-layout" class="tb" title="Layout: choose which panes are shown" aria-label="Layout" aria-haspopup="true">${ic('layout')}</button>
      </div>
    </div>
    <div class="wr-body" id="wr-body">
      <div class="wr-rail">
        <button id="rail-files" class="tb" title="File tree" aria-label="File tree">${ic('files')}</button>
        <button id="rail-search" class="tb" title="Search in the whole project" aria-label="Search in the whole project">${ic('search')}</button>
        <button id="rail-library" class="tb" title="Library: cite your papers here, add them to this project (${MAC ? '⇧⌘L' : 'Shift+Ctrl+L'})" aria-label="Library">${RT.icon('books')}</button>
      </div>
      <div class="side-pane" id="side">
        <div id="side-files">
          <div class="pane-head"><span class="ph-title">File tree</span><span class="spacer"></span>
            <button id="btn-new-file" class="tb" title="New file" aria-label="New file">${ic('newFile')}</button>
            <button id="btn-new-folder" class="tb" title="New folder" aria-label="New folder">${ic('newFolder')}</button>
            <button id="btn-upload" class="tb" title="Upload files (or drop them on the tree)" aria-label="Upload files">${ic('upload')}</button>
            <button id="btn-side-close" class="tb" title="Hide the file tree" aria-label="Hide the file tree">${ic('close')}</button>
            <input type="file" id="file-upload" multiple hidden>
          </div>
          <div id="tree" role="tree"></div>
          <div class="wr-hdiv" id="div-outline" title="Drag to resize · double-click to reset"></div>
          <div id="outline-pane">
            <div class="pane-head"><span class="ph-title">File outline</span><span class="spacer"></span>
              <button id="wc-total" class="tb" hidden></button></div>
            <div id="outline"></div>
          </div>
        </div>
        <div id="side-search" hidden>
          <div class="pane-head"><span class="ph-title">Search project</span><span class="spacer"></span>
            <button id="btn-search-close" class="tb" title="Hide" aria-label="Hide the search panel">${ic('close')}</button></div>
          <div class="ps-form">
            <input type="search" id="ps-q" placeholder="Search…" title="Search in every text file of this project" aria-label="Search in all files" spellcheck="false">
            <button id="ps-case" class="tb" title="Match case" aria-label="Match case" aria-pressed="false">Aa</button>
            <button id="ps-regex" class="tb" title="Regular expression" aria-label="Regular expression" aria-pressed="false">.*</button>
          </div>
          <div id="ps-results"><div class="muted ps-note">Type to search every text file of this project.</div></div>
        </div>
        <div id="side-lib" hidden>
          <div class="pane-head"><span class="ph-title">Library</span><span class="spacer"></span>
            <button id="btn-lib-close" class="tb" title="Hide" aria-label="Hide the Library panel">${ic('close')}</button></div>
          <div class="ps-form">
            <input type="search" id="wl-q" placeholder="Search title, author, year, key…" title="Search the library: title, authors, year, cite key or category" aria-label="Search the library" spellcheck="false">
          </div>
          <div class="wl-bar" id="wl-bar" hidden>
            <span id="wl-n" class="muted"></span><span class="spacer"></span>
            <button id="wl-cite-sel" class="ib" title="Insert one \\cite{…} with the keys of the selected papers at the cursor">${ic('cite')}<span>Cite</span></button>
            <button id="wl-clear" class="ib ghost" title="Clear the selection" aria-label="Clear the selection">${ic('close')}</button>
          </div>
          <div id="wl-list" role="listbox" aria-multiselectable="true" aria-label="Papers of the library"></div>
          <div class="muted wl-foot">Click to select, double-click or drag into the text to cite.</div>
        </div>
      </div>
      <div class="wr-div" id="div-side" title="Drag to resize · double-click to reset"></div>
      <div class="editor-pane" id="editor-pane">
        <div id="tabs"></div>
        <div class="toolbar" id="ed-toolbar" role="toolbar" aria-label="Editor toolbar">
          <div class="tgroup" role="group" aria-label="Undo and redo">${tb('undo', `Undo (${MOD}Z)`, ic('undo'))}${tb('redo', `Redo (${MAC ? '⇧⌘Z' : 'Ctrl+Y'})`, ic('redo'))}</div>
          <div class="tgroup" role="group" aria-label="Format">
            <button class="tb tb-style" data-cmd="style" title="Text style" aria-label="Text style" aria-haspopup="true"><span id="style-name">Normal text</span>${ic('chevDown')}</button>
            ${tb('bold', `Bold (${MOD}B)`, '<b>B</b>')}${tb('italic', `Italic (${MOD}I)`, '<i>I</i>')}${tb('ul', 'Bullet list', ic('ul'))}${tb('ol', 'Numbered list', ic('ol'))}
          </div>
          <div class="tgroup" role="group" aria-label="Math">${tb('math', 'Inline math  $ … $', '<span class="tb-tx">$</span>')}${tb('dmath', 'Display math  \\[ … \\]', ic('formula'))}${tb('symbol', 'Insert symbol', '<span class="tb-tx">Ω</span>')}</div>
          <div class="tgroup" role="group" aria-label="Insert">${tb('cite', 'Insert citation from the library (\\cite)', ic('cite'))}${tb('ref', 'Insert cross-reference (\\ref)', ic('ref'))}${tb('link', 'Insert link (\\href)', ic('link'))}${tb('figure', 'Insert figure', ic('image'))}${tb('table', 'Insert table', ic('table'))}</div>
          <div class="tgroup" role="group" aria-label="Library">${tb('papers', 'Papers of this project: cite them, see what is not read or not cited yet, annotated bibliography, reading pack', ic('papers'))}${tb('cmptable', 'Comparison tables of library papers: open one and insert it here as a booktabs table with \\cite', ic('cmptable'))}</div>
          <div class="tgroup" role="group" aria-label="Claude">${tb('askai', 'Ask Claude to rewrite the selected text: improve, shorten, translate (or right-click the selection)', RT.icon('sparkle'))}${tb('related', 'Draft related work from papers of your library, with Claude', ic('related'))}</div>
          <span class="spacer"></span>
          <div class="tgroup" role="group" aria-label="Check">
            <button class="tb" id="btn-checks" title="Spelling and writing checks" aria-label="Spelling and writing checks" aria-haspopup="true">${ic('spell')}<span id="ck-badge" class="cnt" hidden></span></button>
            ${tb('search', `Search and replace in this file (${MOD}F, replace: ${MAC ? '⌥⌘F' : 'Shift+Ctrl+F'})`, ic('search'))}
          </div>
        </div>
        <div id="conflict" class="conflict" hidden>
          <span>This file changed on disk while you were editing it.</span>
          <button id="conflict-mine" class="ib" title="Keep mine: overwrite the file on disk with your text" aria-label="Keep mine">${RT.icon('save')}</button>
          <button id="conflict-theirs" class="ib" title="Load theirs: replace your text with the version on disk" aria-label="Load theirs">${ic('refresh')}</button>
        </div>
        <div id="edit-area">
          <div id="editor-host"><textarea id="editor" spellcheck="false"></textarea></div>
          <div id="file-view" hidden></div>
        </div>
        <div class="statusbar"><button id="compile-status" class="ghost" title="Show or hide the compile log">—</button><span id="file-path"></span></div>
      </div>
      <div class="wr-div" id="div-pdf" title="Drag to resize · double-click to reset">
        <button id="sync-to-pdf" title="Go to PDF location of the cursor" aria-label="Go to PDF location">${ic('arrowRight')}</button>
        <button id="sync-to-code" title="Go to code location of the last clicked PDF position (or double-click the PDF)" aria-label="Go to code location">${ic('arrowLeft')}</button>
      </div>
      <div class="preview-pane" id="preview-pane">
        <div class="pdf-bar">
          <div class="tgroup" role="group" aria-label="Build"><div class="split-btn"><button id="btn-compile" class="primary" title="${COMPILE_HINT}" aria-label="Recompile">${ic('refresh')}</button><button id="btn-compile-menu" class="primary" title="Compile options" aria-haspopup="true" aria-label="Compile options">${ic('chevDown')}</button></div>
          <button id="btn-log" class="tb" title="Logs and output files" aria-label="Logs">${ic('logs')}<span id="log-badge" class="cnt" hidden></span></button>
          <button id="btn-pdf-dl" class="tb" title="Download PDF" aria-label="Download PDF">${ic('download')}</button></div>
          <span class="spacer"></span>
          <div class="tgroup" role="group" aria-label="Page"><button id="pdf-prev" class="tb" title="Previous page" aria-label="Previous page">${ic('up')}</button>
          <button id="pdf-next" class="tb" title="Next page" aria-label="Next page">${ic('chevDown')}</button>
          <span class="pdf-pages"><input type="text" id="pdf-page" inputmode="numeric" value="0" aria-label="Page number" title="Type a page number and press Enter"> / <span id="pdf-total">0</span></span>
          <button id="pdf-budget" class="tb" hidden></button></div>
          <div class="tgroup" role="group" aria-label="Zoom">
          <button id="pdf-zoom-out" class="tb" title="Zoom out" aria-label="Zoom out">${RT.icon('zoom-out')}</button>
          <button id="pdf-zoom-in" class="tb" title="Zoom in" aria-label="Zoom in">${RT.icon('zoom-in')}</button>
          <button id="pdf-zoom" class="tb tb-style" title="Zoom" aria-label="Zoom" aria-haspopup="true"><span id="pdf-zoom-label">100%</span>${ic('chevDown')}</button></div>
          <div class="tgroup" role="group" aria-label="Find and navigate">${RT.pdfnav.controls('pv', 'tb')}</div>
        </div>
        <div class="pdf-area">
          <div id="preview" tabindex="0"></div>
          <div id="preview-empty" class="empty">The compiled PDF appears here.</div>
          <div id="log-panel" hidden></div>
        </div>
      </div>
    </div>
    <div id="history" hidden>
      <div id="diff-view"></div>
      <div class="hist-side">
        <div class="hist-head">
          <button id="hist-close" class="ib" title="Back to the editor" aria-label="Back to the editor">${ic('arrowLeft')}</button><strong>History</strong><div class="spacer"></div>
          <div class="seg" id="hist-scope" role="group" aria-label="Which files"><button data-scope="file" class="ib on" title="This file: versions of the open file" aria-label="This file">${ic('oneFile')}</button><button data-scope="all" class="ib" title="All files: versions of every file of the project" aria-label="All files">${ic('allFiles')}</button></div>
          <div class="seg" id="hist-filter" role="group" aria-label="Which versions"><button data-filter="all" class="ib on" title="All history: every recorded version" aria-label="All history">${ic('history')}</button><button data-filter="labels" class="ib" title="Labels: only the versions you gave a name" aria-label="Labels">${ic('ref')}</button></div>
          <button id="btn-label" class="ib" title="Label current version…: save the open file and give this version a name" aria-label="Label current version">${ic('labelAdd')}</button>
        </div>
        <div id="hist-list"></div>
      </div>
    </div>
  </div>`;

// ---------------- state + helpers ----------------
const UI_DEFAULT = { side: 250, split: 0.5, outline: 0.32, layout: 'both', sideOpen: true, panel: 'files' };
const W = { project: null, files: [], sig: '', bufs: new Map(), open: [], active: null, collapsed: new Set(), lastCompile: null, showLog: false, seq: 0,
  mode: 'home', tools: { texcount: false, synctex: true, spell: true }, labels: [], wc: null,
  ui: { ...UI_DEFAULT, ...ls.json('rt-wr-ui', {}) },
  opts: { auto: ls.get('rt-auto-compile', '1') !== '0', halt: ls.get('rt-halt-on-error', '0') === '1' },
  hist: { on: false, all: false, filter: 'all', versions: [], groups: [], sel: null, against: 'previous', rows: [], seq: 0, seq2: 0 } };
// the papers of the open project (GET /papers): {pid, data: {project, papers [row], citedNotMember, counts, nociteAll}}
const PP = { pid: null, data: null, seq: 0 };
const SCOPE_HINT = { cited: 'only cited', all: 'whole library', project: 'cited + project' };
// on a narrow window the side panel is an overlay that starts closed; that state is not remembered
const narrow = () => innerWidth <= 900;
let narrowOpen = false;
const sideOpen = () => (narrow() ? narrowOpen : W.ui.sideOpen);
const setSideOpen = (v) => { if (narrow()) narrowOpen = v; else W.ui.sideOpen = v; };
const pUrl = (rest = '', pid = W.project.id) => `/api/projects/${enc(pid)}${rest}`;
const baseName = (p) => String(p).replace(/\/+$/, '').split('/').pop();
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const extOf = (p) => { const n = baseName(p), i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const activeBuf = () => W.bufs.get(W.active) || null;
const modeFor = (p) => (/\.(tex|sty|cls|bib|bst|ltx|tikz)$/i.test(p) ? 'stex' : /\.(md|markdown)$/i.test(p) ? 'markdown' : null);
const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fileEntry = (p) => W.files.find((f) => f.path === p);
const filesSig = (files) => files.map((f) => f.path + ':' + f.mtime).join('|');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : /(ch|s|x)$/.test(w) ? 'es' : 's'}`;
// clean a user-typed relative path; returns null if it is empty or tries to leave the project
function cleanPath(p) {
  const parts = String(p || '').trim().replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}
// path of `to` as seen from folder `fromDir` (both project-relative)
function relPath(fromDir, to) {
  const a = fromDir ? fromDir.split('/') : [], b = to.split('/');
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
const saveUi = () => ls.set('rt-wr-ui', JSON.stringify(W.ui));

// ---------------- layout: three resizable panes ----------------
function applyLayout() {
  const u = W.ui, both = u.layout === 'both';
  u.side = Math.max(150, Math.min(u.side, 600)); u.split = Math.max(0.15, Math.min(u.split, 0.85)); u.outline = Math.max(0.1, Math.min(u.outline, 0.8));
  const showSide = sideOpen() && u.layout !== 'pdf';
  $('#side').hidden = !showSide; $('#div-side').hidden = !showSide;
  $('#side').style.width = u.side + 'px';
  $('#side-files').hidden = u.panel !== 'files'; $('#side-search').hidden = u.panel !== 'search'; $('#side-lib').hidden = u.panel !== 'library';
  $('#rail-files').classList.toggle('on', showSide && u.panel === 'files'); $('#rail-search').classList.toggle('on', showSide && u.panel === 'search');
  $('#rail-library').classList.toggle('on', showSide && u.panel === 'library');
  if (showSide && u.panel === 'library') renderLib();
  $('#editor-pane').hidden = u.layout === 'pdf'; $('#preview-pane').hidden = u.layout === 'editor'; $('#div-pdf').hidden = !both;
  $('#editor-pane').style.flex = `${both ? 1 - u.split : 1} 1 0`; $('#preview-pane').style.flex = `${both ? u.split : 1} 1 0`;
  $('#outline-pane').style.flex = `0 0 ${Math.round(u.outline * 100)}%`;
  saveUi(); editor.refresh(); pdfResized();
}
// drag a divider: move(event) is called while dragging, reset() on double-click
function divider(el, move, reset) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag'); document.body.classList.add('wr-resizing');
    const onMove = (ev) => { move(ev); applyLayoutSoon(); };
    const stop = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop); el.classList.remove('drag'); document.body.classList.remove('wr-resizing'); applyLayout(); };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
  });
  el.addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; reset(); applyLayout(); });
}
let layoutRaf = 0;
function applyLayoutSoon() { // while dragging: sizes only, the expensive refreshes run at the end of the drag
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0; const u = W.ui;
    $('#side').style.width = Math.max(150, Math.min(u.side, 600)) + 'px';
    $('#editor-pane').style.flex = `${1 - u.split} 1 0`; $('#preview-pane').style.flex = `${u.split} 1 0`;
    $('#outline-pane').style.flex = `0 0 ${Math.round(u.outline * 100)}%`;
  });
}
divider($('#div-side'), (e) => { W.ui.side = e.clientX - $('#side').getBoundingClientRect().left; }, () => { W.ui.side = UI_DEFAULT.side; });
divider($('#div-pdf'), (e) => {
  const a = $('#editor-pane').getBoundingClientRect(), b = $('#preview-pane').getBoundingClientRect(), total = b.right - a.left;
  if (total > 0) W.ui.split = Math.max(0.15, Math.min(0.85, (b.right - e.clientX) / total));
}, () => { W.ui.split = UI_DEFAULT.split; });
divider($('#div-outline'), (e) => {
  const r = $('#side-files').getBoundingClientRect();
  if (r.height > 0) W.ui.outline = Math.max(0.1, Math.min(0.8, (r.bottom - e.clientY) / r.height));
}, () => { W.ui.outline = UI_DEFAULT.outline; });
function setLayout(layout) { W.ui.layout = layout; applyLayout(); }
function togglePanel(panel) {
  const u = W.ui;
  if (u.layout === 'pdf') u.layout = 'both';
  if (sideOpen() && u.panel === panel) setSideOpen(false); else { setSideOpen(true); u.panel = panel; }
  applyLayout();
  if (sideOpen() && panel === 'search') { $('#ps-q').focus(); $('#ps-q').select(); }
  if (sideOpen() && panel === 'library') { $('#wl-q').focus(); $('#wl-q').select(); }
}
$('#rail-files').addEventListener('click', () => togglePanel('files'));
$('#rail-search').addEventListener('click', () => togglePanel('search'));
$('#rail-library').addEventListener('click', () => togglePanel('library'));
$('#btn-lib-close').addEventListener('click', () => { setSideOpen(false); applyLayout(); });
$('#btn-side-close').addEventListener('click', () => { setSideOpen(false); applyLayout(); });
$('#btn-search-close').addEventListener('click', () => { setSideOpen(false); applyLayout(); });
$('#btn-layout').addEventListener('click', (e) => {
  const u = W.ui, it = (label, v, icon) => ({ label, check: u.layout === v, icon, run: () => setLayout(v) });
  menu(e.currentTarget, [it('Editor and PDF', 'both'), it('Editor only', 'editor'), it('PDF only', 'pdf'),
    { label: 'PDF in separate tab', icon: 'open', run: () => { if (!W.lastCompile || !W.lastCompile.hasPdf) return toast('There is no compiled PDF yet — compile first.', 'bad'); window.open(pUrl(`/pdf?t=${Date.now()}`), '_blank', 'noopener'); setLayout('editor'); } },
    { sep: true }, { label: sideOpen() ? 'Hide file tree' : 'Show file tree', icon: 'panel', run: () => { setSideOpen(!sideOpen()); if (u.layout === 'pdf') u.layout = 'both'; applyLayout(); } },
    { label: 'Reset pane sizes', run: () => { Object.assign(u, { side: UI_DEFAULT.side, split: UI_DEFAULT.split, outline: UI_DEFAULT.outline }); applyLayout(); } }], { right: true });
});

// ---------------- editor (one CodeMirror, one Doc per open file) ----------------
const ta = $('#editor');
let cm = null, silent = false;
if (window.CodeMirror) {
  try {
    cm = CodeMirror.fromTextArea(ta, { mode: 'stex', lineNumbers: true, gutters: ['CodeMirror-linenumbers', 'ck-gutter'], lineWrapping: true, indentUnit: 2, tabSize: 2, dragDrop: false,
      matchBrackets: true, autoCloseBrackets: { pairs: '()[]{}$$', explode: '', closeBefore: ')]}\'":;>$,.' }, styleActiveLine: true,
      extraKeys: {
        [`${KEY}-B`]: () => runCmd('bold'), [`${KEY}-I`]: () => runCmd('italic'), [`${KEY}-/`]: () => toggleComment(),
        [`${KEY}-Enter`]: () => { flushAll().then(() => compile()); }, 'Ctrl-Space': () => showHints(), F8: () => gotoProblem(1), 'Shift-F8': () => gotoProblem(-1),
        Tab: (c) => { if (c.somethingSelected()) c.indentSelection('add'); else c.replaceSelection('  ', 'end'); },
      } });
  } catch (e) { console.error(e); cm = null; }
}
if (!cm) ta.addEventListener('input', () => { const b = activeBuf(); if (b && b.kind === 'text') touchBuf(b); });
const editor = {
  refresh() { if (cm) setTimeout(() => cm.refresh(), 0); },
  ok() { // a text file is showing in the editor
    const b = activeBuf();
    if (!b || b.kind !== 'text' || W.hist.on) { toast('Open a text file in the editor first.', 'bad'); return false; }
    return true;
  },
  insert(text) {
    if (!editor.ok()) return;
    if (cm) { cm.replaceSelection(text); cm.focus(); } else { ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); touchBuf(activeBuf()); }
  },
  goto(line, col, len) {
    if (!line) return;
    if (cm) {
      const l = Math.min(line, cm.lineCount()) - 1, ch = Math.max(0, (col || 1) - 1);
      if (len) cm.setSelection({ line: l, ch }, { line: l, ch: ch + len }); else cm.setCursor(l, ch);
      cm.scrollIntoView({ line: l, ch }, Math.max(60, cm.getScrollInfo().clientHeight / 3)); cm.focus();
    } else { const pos = ta.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0); ta.focus(); ta.setSelectionRange(pos, pos); }
  },
};

const bufText = (b) => (b.doc ? b.doc.getValue() : b.path === W.active ? ta.value : b.text);
function makeDoc(b, content) {
  b.doc = CodeMirror.Doc(content, modeFor(b.path), 0, content.includes('\r\n') ? '\r\n' : null);
  b.doc.on('change', () => { if (!silent) touchBuf(b); else if (b.path === W.active) outlineSoon(); if (b.path === W.active) checksSoon(); });
}
// replace a buffer's content with what is on disk, without marking it dirty
function setBufContent(b, content, hash, mtime) {
  if (RT.writeAi && RT.writeAi.forget) RT.writeAi.forget(b); // the passage a proposal is about is replaced
  silent = true;
  try {
    if (b.doc) {
      const act = cm.getDoc() === b.doc, cur = b.doc.getCursor(), sc = act ? cm.getScrollInfo() : null;
      b.doc.setValue(content); b.doc.setCursor(cur); if (sc) cm.scrollTo(sc.left, sc.top);
    } else { b.text = content; if (b.path === W.active) ta.value = content; }
  } finally { silent = false; }
  clearTimeout(b.timer);
  b.hash = hash; if (mtime !== undefined) b.mtime = mtime;
  b.dirty = false; b.conflict = null; b.rev = (b.rev || 0) + 1;
  renderMarks();
}
function touchBuf(b) {
  b.rev = (b.rev || 0) + 1;
  const was = b.dirty; b.dirty = true;
  if (!was) renderMarks(); else renderSaveState();
  if (b.path === W.active) outlineSoon();
  clearTimeout(b.timer);
  if (!b.conflict) b.timer = setTimeout(() => autosave(b), 1200);
}
async function autosave(b) {
  const ok = await saveBuf(b, 'auto');
  if (ok && !b.dirty && b.pid === W.project?.id && W.opts.auto && RT.state.view === 'write') compile();
}

// Saves are serialised per file. Resolves true when the file on disk matches what was sent.
function saveBuf(b, source = 'auto', o = {}) {
  clearTimeout(b.timer);
  const run = async () => {
    if (b.closed) return true;
    if (b.conflict && !o.force) { renderConflict(); return false; }
    if (!b.dirty && !o.always && !o.force) return true;
    const content = bufText(b), rev = b.rev;
    const body = { content, source };
    if (o.label) body.label = o.label;
    if (o.by && source === 'claude') body.by = o.by;
    if (!o.force && b.hash) body.baseHash = b.hash;
    b.saving = true; renderSaveState();
    try {
      const r = await api(pUrl(`/file?path=${enc(b.path)}`, b.pid), { method: 'PUT', json: body, keepalive: !!o.keepalive });
      b.hash = r.hash; b.mtime = r.mtime; b.savedAt = new Date(); b.conflict = null;
      if (b.rev === rev) b.dirty = false;
      if (b.pid === W.project?.id) {
        const ent = fileEntry(b.path); if (ent) { ent.mtime = r.mtime; W.sig = filesSig(W.files); }
        if (W.hist.on && r.versionId) loadHistory();
        if (/\.tex$/i.test(b.path)) labelsSoon();
        if (/\.(tex|ltx|bib)$/i.test(b.path)) { countsSoon(); refsSoon(); if (/\.bib$/i.test(b.path)) spellingSoon(); }
      }
      return true;
    } catch (e) {
      if (e.status === 409 && e.data && e.data.conflict) {
        b.conflict = { content: e.data.content, hash: e.data.hash };
        toast(`${b.path} changed on disk — in the bar above the editor, keep your text (save icon) or load the disk version (reload icon).`, 'bad');
      } else toast(`Could not save ${b.path}: ${e.message}`, 'bad');
      return false;
    } finally { b.saving = false; renderMarks(); renderConflict(); }
  };
  return (b.queue = (b.queue || Promise.resolve(true)).then(run, run));
}
// save every dirty file (autosave-style); true if nothing is left unsaved
async function flushAll() {
  // wait for running saves too, then judge by the buffers' state (not by the result of some earlier save)
  await Promise.all([...W.bufs.values()].filter((b) => b.kind === 'text').map((b) => (b.dirty ? saveBuf(b, 'auto') : b.queue)));
  return ![...W.bufs.values()].some((b) => b.dirty || b.conflict);
}
// the Save button / Cmd+S: a 'manual' version of the active file, plus every other dirty file
async function saveAll(label) {
  if (!W.project) return;
  const a = activeBuf(), jobs = [];
  for (const b of W.bufs.values()) {
    if (b.kind !== 'text') continue;
    if (b === a) jobs.push(saveBuf(b, 'manual', { label, always: true }));
    else if (b.dirty) jobs.push(saveBuf(b, 'manual'));
  }
  const ok = (await Promise.all(jobs)).every(Boolean);
  if (ok && label) toast(`Version labelled “${label}”`, 'ok');
  if (ok && W.project.mainFile) compile();
  return ok;
}

// A change Claude proposed and the user accepted (write-ai.js). What is in the editor is saved first, so the 'Claude'
// version of the history holds that change alone; edit() makes the change and returns false when it no longer applies.
// opts.by: the id of the provider that made the change (RT.ai.id() when it was asked for): stored with the version.
// opts.source / opts.label: an insert no AI wrote (a comparison table) is a plain 'manual' version with a label instead
async function applyClaude(b, edit, { by, source = 'claude', label } = {}) {
  if (!b || b.closed || b.kind !== 'text') return false;
  if (b.conflict) { renderConflict(); toast(`${b.path} changed on disk — settle that in the bar above the editor first.`, 'bad'); return false; }
  if (!(await saveBuf(b, 'auto'))) return false;
  if (b.closed || edit() === false) return false;
  const ok = await saveBuf(b, source, source === 'claude' ? { always: true, by: by || (RT.ai ? RT.ai.id() : 'claude') } : { always: true, label });
  if (ok && !b.dirty && b.pid === W.project?.id && W.opts.auto && RT.state.view === 'write') compile();
  return ok;
}

function renderSaveState() {
  const b = activeBuf(), el = $('#save-state');
  const any = [...W.bufs.values()].some((x) => x.dirty);
  if (!b || b.kind !== 'text') el.textContent = any ? 'Unsaved changes' : '';
  else if (b.saving) el.textContent = 'Saving…';
  else if (b.dirty || any) el.textContent = 'Unsaved changes';
  else el.textContent = b.savedAt ? `Saved ${hhmm(b.savedAt)}` : '';
}
// dirty dots + active highlight on tabs and tree rows, without re-rendering them
function renderMarks() {
  for (const el of $$('#tabs .ftab, #tree .tr')) {
    const b = W.bufs.get(el.dataset.path);
    el.classList.toggle('dirty', !!(b && b.dirty));
    el.classList.toggle('active', el.dataset.path === W.active);
  }
  renderSaveState();
}
function renderConflict() { const b = activeBuf(); $('#conflict').hidden = !(b && b.conflict) || W.hist.on; }
$('#conflict-mine').addEventListener('click', async () => {
  const b = activeBuf(); if (!b || !b.conflict) return;
  b.conflict = null; b.dirty = true;
  if (await saveBuf(b, 'manual', { force: true }) && W.opts.auto) compile();
});
$('#conflict-theirs').addEventListener('click', async () => {
  const b = activeBuf(); if (!b || !b.conflict) return;
  if (!(await confirmDlg(`Replace your text in ${b.path} with the version on disk? Your unsaved changes to this file are dropped.`, { okText: 'Load the version on disk and drop my changes', icon: 'refresh', danger: true }))) return;
  if (!b.conflict) return;
  setBufContent(b, b.conflict.content, b.conflict.hash); renderConflict();
  if (W.opts.auto) compile();
});

// ---------------- home <-> project ----------------
function setMode(mode) {
  W.mode = mode; W.peek = false; ls.set('rt-write-mode', mode);
  $('#pj-home').hidden = mode !== 'home'; $('#wr').hidden = mode !== 'project';
  if (mode === 'home' && RT.projectsHome && RT.projectsHome.show) RT.projectsHome.show();
  RT.claudeContext.refresh();
}
function unloadProject() {
  if (RT.writeAi && RT.writeAi.forget) RT.writeAi.forget(); // a proposal of Claude that is still open (write-ai.js)
  for (const b of W.bufs.values()) { b.closed = true; b.dirty = false; clearTimeout(b.timer); }
  W.bufs.clear(); W.open = []; W.active = null; W.project = null; W.files = []; W.sig = ''; W.lastCompile = null; W.labels = []; W.refs = null; W.showLog = false; W.autoLog = false;
  W.wc = null; ++wcSeq; wcLatest = null; wcError = ''; renderWcTotal(); resetChecks(); PP.pid = null; PP.data = null; ++PP.seq;
  ++W.seq; ++compileSeq; setCompiling(false);
  Object.assign(W.hist, { on: false, sel: null, versions: [], groups: [] });
  closeMenus(); pdfClear(); renderLog(); setStatus('—');
}
// back to the project list; unsaved text is saved first
async function showHome() {
  if (W.project && W.bufs.size && !(await flushAll())
    && !(await confirmDlg('Some files could not be saved. Leave the project anyway and drop those changes?', { okText: 'Leave and drop the unsaved changes', icon: 'leave', danger: true }))) return false;
  unloadProject(); setMode('home');
  return true;
}
$('#btn-home').addEventListener('click', () => showHome().catch((e) => toast(e.message, 'bad')));

let overleafSig = null;
function mountOverleaf() {
  const p = W.project, sig = p ? p.id + "|" + ((p.overleaf && p.overleaf.projectId) || "") : ""; // not lastSync: a pull or push must not remount the control
  if (sig === overleafSig) return;
  overleafSig = sig;
  const slot = $('#overleaf-slot'); slot.replaceChildren();
  if (p && RT.overleaf && RT.overleaf.mountSync) { try { RT.overleaf.mountSync(slot, p); } catch (e) { console.error(e); } }
}
function applyProject(r) {
  W.project = r.project; W.files = r.files || []; W.sig = filesSig(W.files);
  $('#proj-name').textContent = r.project.name + (r.project.missing ? ' (missing)' : '');
  $('#btn-proj-menu').title = 'Project menu — ' + r.project.path + (r.project.external ? ' (folder on disk)' : '');
  renderTree(); mountOverleaf();
  RT.claudeContext.refresh(); renderPath(); renderWcTotal(); renderBudget();
}
function renderPath() {
  const p = W.project, el = $('#file-path');
  el.textContent = p ? (W.active ? `${p.path}/${W.active}` : p.path) : ''; el.title = el.textContent;
}
function persistTabs() { if (W.project) ls.set('rt-tabs:' + W.project.id, JSON.stringify({ open: W.open, active: W.active })); }

// opts.compile false: no compile on open (the cached preview is shown when there is one); opts.remember false: the
// project does not become the one opened last / the working project (the tour's look at a project, tour.js)
async function openProject(id, opts = {}) {
  const { compile: build = true, remember = true } = opts || {};
  if (W.project && W.bufs.size && !(await flushAll())
    && !(await confirmDlg('Some files could not be saved. Switch projects anyway and drop those changes?', { okText: 'Switch project and drop the unsaved changes', icon: 'leave', danger: true }))) return false;
  const seq = ++W.seq;
  let r;
  try { r = await api(`/api/projects/${enc(id)}`); }
  catch (e) { toast(`Could not open the project ${id}: ${e.message}`, 'bad'); if (!W.project) setMode('home'); return false; }
  if (seq !== W.seq) return false;
  unloadProject(); W.seq = seq;
  W.collapsed = new Set(ls.json('rt-collapsed:' + id, []));
  setMode('project');
  applyProject(r);
  // the project opened last is the working project of the Library's project buttons (project-papers.js)
  if (remember) { ls.set('rt-project', id); ls.set('rt-working-project', JSON.stringify({ id: r.project.id, name: r.project.name })); }
  RT.emit('project:opened', { id: r.project.id, name: r.project.name });
  loadPapers();
  applyLayout();
  const isFile = (p) => W.files.some((f) => f.path === p && f.type === 'file');
  const saved = ls.json('rt-tabs:' + id, null) || {};
  let open = (Array.isArray(saved.open) ? saved.open : []).filter(isFile);
  const active = isFile(saved.active) ? saved.active : null;
  if (!open.length) { const first = (isFile(r.project.mainFile) && r.project.mainFile) || (W.files.find((f) => f.type === 'file' && f.kind === 'text') || {}).path; if (first) open = [first]; }
  if (!cm) open = [active || open[0]].filter(Boolean);
  for (const p of open) { await openFile(p, { activate: false }); if (seq !== W.seq) return false; }
  activate(active && W.bufs.has(active) ? active : W.open[0] || null);
  renderHistMode();
  if (r.project.missing) previewEmpty('This folder no longer exists on disk. Go back to the project list to remove it.');
  else {
    if (build) compile();
    else { const url = pUrl(`/pdf?t=${Date.now()}`), cs = compileSeq; fetch(url).then((x) => { if (x.ok && cs === compileSeq && W.seq === seq) showPdf(url, cs); }).catch(() => {}); }
    loadLabels(); loadCounts(); loadSpelling(); loadRefs();
  }
  return true;
}
// the projects home over an open project without closing it (the tour's Editor steps): on = true shows the list,
// false puts the project back; the mode stays 'project'
function peekHome(on) {
  if (W.mode !== 'project') return false;
  $('#pj-home').hidden = !on; $('#wr').hidden = !!on; W.peek = !!on;
  if (on && RT.projectsHome && RT.projectsHome.show) RT.projectsHome.show();
  return true;
}

// ---------------- project menu (the name in the top bar) ----------------
const COMPILERS = [['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX'], ['lualatex', 'LuaLaTeX']];
const compilerItems = () => COMPILERS.map(([v, label]) => ({ label, check: (W.project.compiler || 'pdflatex') === v, run: () => setCompiler(v) }));
$('#btn-proj-menu').addEventListener('click', (e) => {
  const p = W.project; if (!p) return;
  const ok = !p.missing;
  menu(e.currentTarget, [
    ...(p.external ? [] : [{ label: 'Rename…', icon: 'pencil', disabled: !ok, run: renameProject }]),
    { label: 'Download source (.zip)', icon: 'download', disabled: !ok, run: async () => { await flushAll(); download(pUrl('/download')); } },
    { label: 'Download PDF', icon: 'pdf', run: downloadPdf },
    { sep: true },
    { label: 'Main file…', icon: 'tex', hint: p.mainFile ? baseName(p.mainFile) : 'none', disabled: !ok, run: () => pickMain($('#btn-proj-menu')) },
    { head: 'Compiler' }, ...compilerItems().map((it) => ({ ...it, disabled: !ok })),
    { sep: true }, { label: 'Word count and limits…', icon: 'ruler', disabled: !ok, run: lengthDialog },
    { label: 'Papers of this project…', icon: 'papers', hint: PP.data ? String(PP.data.counts.total) : '', run: papersDialog },
    { label: 'References…', icon: 'bib', hint: SCOPE_HINT[p.bibScope] || SCOPE_HINT.cited, disabled: !ok, run: refsDialog },
    { sep: true }, { label: 'Label current version…', icon: 'ref', disabled: !ok, run: labelVersion },
  ]);
});
function downloadPdf() {
  if (!W.lastCompile || !W.lastCompile.hasPdf) return toast('There is no compiled PDF yet — compile first.', 'bad');
  download(pUrl('/pdf?download=1'));
}
function pickMain(anchor) {
  const tex = W.files.filter((f) => f.type === 'file' && /\.(tex|ltx)$/i.test(f.path));
  if (!tex.length) return toast('This project has no .tex file yet.', 'bad');
  pickList(anchor, { placeholder: 'Choose the main .tex file…', items: tex.map((f) => ({ key: baseName(f.path), title: '', sub: f.path + (f.path === W.project.mainFile ? ' — current main file' : '') , path: f.path })), onPick: (it) => setMain(it.path) });
}
async function setCompiler(v) {
  if (!needProject()) return;
  const r = await api(pUrl('/settings'), { method: 'PUT', json: { compiler: v } });
  applyProject({ project: r.project, files: W.files });
  await flushAll(); compile();
}
async function renameProject() {
  const p = W.project; if (!p || p.external) return;
  const name = await ask({ title: 'Rename project', message: 'Letters, numbers, dashes and underscores. The project folder is renamed too.', value: p.name, okText: 'Rename', icon: 'pencil' });
  if (name === null || !name.trim() || name.trim() === p.name) return;
  if (!(await flushAll())) return toast('Some files could not be saved — resolve that before renaming.', 'bad');
  const r = await api(pUrl('/rename-project'), { method: 'POST', json: { name: name.trim() } });
  for (const k of ['rt-tabs:', 'rt-collapsed:']) { const v = ls.get(k + p.id); if (v !== null) ls.set(k + r.project.id, v); }
  rekeyProject(p.id, r.project);
  unloadProject();
  RT.emit('projects:changed');
  await openProject(r.project.id);
  toast(`Renamed to ${r.project.name}`, 'ok');
}
// ---------------- word count per section, page / word limit ----------------
const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');
let wcSeq = 0, wcLatest = null, wcError = '', toolsP = Promise.resolve();
// the counts of the whole document (texcount, from the files as saved); refreshed after every save.
// -> the counts, or null (wcError then says why, when the count itself failed)
async function loadCounts() {
  const p = W.project; if (!p) return null;
  await toolsP;
  const cur = W.project;
  if (!cur || cur.id !== p.id) return null;
  if (cur.missing || !cur.mainFile || !W.tools.texcount) { W.wc = null; renderWcTotal(); renderOutline(); return null; }
  const seq = ++wcSeq;
  const mine = (async () => {
    const same = () => !!W.project && W.project.id === p.id;
    // a count that started later (a save came in between) has the newer numbers: wait for that one
    const newer = () => (same() && wcLatest && wcLatest.seq > seq ? wcLatest.promise : null);
    let failed = '';
    try {
      const r = await api(pUrl('/wordcount', p.id));
      if (seq !== wcSeq) return newer();
      if (!same()) return null;
      W.wc = r;
    } catch (e) {
      if (seq !== wcSeq) return newer();
      if (!same()) return null;
      failed = e.message || 'The words could not be counted.'; // the outline keeps the last counts: the next save tries again
    }
    wcError = failed;
    renderWcTotal(); renderOutline();
    return failed ? null : W.wc;
  })();
  wcLatest = { seq, promise: mine };
  return mine;
}
const countsSoon = debounce(() => { loadCounts(); }, 1200);
// 'bad' over the limit, 'warn' at it (pages) or within a tenth of it (words)
const budgetClass = (n, limit, near) => (!limit ? '' : n > limit ? 'bad' : n >= near ? 'warn' : '');
function renderWcTotal() {
  const el = $('#wc-total'), wc = W.wc, lim = W.project && W.project.budget ? W.project.budget.words : null;
  el.hidden = !wc;
  if (!wc) return;
  const unit = wc.byCharacter ? 'words and characters' : 'words';
  el.textContent = `${fmt(wc.total)}${lim ? ` / ${fmt(lim)}` : ''} words`;
  el.className = 'tb wc-total ' + budgetClass(wc.total, lim, lim * 0.9);
  el.title = `${fmt(wc.total)} ${unit} in the whole document${lim ? ` — the limit is ${fmt(lim)}${wc.total > lim ? `, ${fmt(wc.total - lim)} too many` : ''}` : ''}. Counted from ${wc.mainFile} and the files it includes after every save. Click for the count of each section and the limits.`;
  el.setAttribute('aria-label', el.title);
}
$('#wc-total').addEventListener('click', () => lengthDialog().catch((e) => toast(e.message, 'bad')));
// the count of each heading of the open file: outline index -> words (with its subsections)
const normTitle = (t) => cleanTitle(String(t)).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function outlineCounts(items) {
  const out = new Map(), wc = W.wc;
  if (!wc || !wc.sections) return out;
  if (!wc.sections.length) { // texcount gives no breakdown for a document with a single heading: all the words are its words
    const heads = items.map((x, i) => (x.level <= SEC_LEVEL.subsection ? i : -1)).filter((i) => i >= 0);
    if (wc.headers === 1 && heads.length === 1) out.set(heads[0], wc.total);
    return out;
  }
  const group = (list, keyOf, val) => { const m = new Map(); list.forEach((x, i) => { const k = keyOf(x); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(val(x, i)); } }); return m; };
  const all = group(wc.sections, (x) => (x.kind === 'top' ? null : x.kind + '|' + normTitle(x.title)), (x) => x.total);
  const mine = group(items, (x) => (x.level <= SEC_LEVEL.subsection ? x.kind + '|' + normTitle(x.title) : null), (x, i) => i);
  // a title that is used more often in the document than in this file cannot be told apart: no count for it
  for (const [k, idx] of mine) { const tot = all.get(k); if (tot && tot.length === idx.length) idx.forEach((i, n) => out.set(i, tot[n])); }
  return out;
}
// how many pages come before the reference list: the page of the "References" heading, or the one before it when
// the heading starts that page. null when the PDF has no such heading.
async function pagesBeforeRefs() {
  const doc = PV.doc, gen = PV.gen; if (!doc) return null;
  if (PV.refs && PV.refs.gen === gen) return PV.refs.n;
  let n = null;
  try {
    // the lines of a page: text items joined (small capitals come as separate pieces), in reading order
    const rowsOf = async (pn) => {
      const items = (await (await doc.getPage(pn)).getTextContent()).items.filter((x) => x.str && x.str.trim());
      const rows = [];
      for (const it of items) { const y = it.transform[5], r = rows[rows.length - 1]; if (r && Math.abs(r.y - y) < 2) r.s += it.str; else rows.push({ y, s: it.str }); }
      return rows;
    };
    const isRefHead = (r) => /^(\d+\.?|[IVX]+\.)?(references|bibliography|literaturecited|workscited)$/i.test(r.s.replace(/\s+/g, ''));
    for (let pn = doc.numPages; pn >= 1 && pn > doc.numPages - 80 && n == null; pn--) {
      const rows = await rowsOf(pn);
      if (PV.gen !== gen) return null;
      let at = -1; // the lowest match on the page: one above it would be the running head
      rows.forEach((r, i) => { if (isRefHead(r) && (at < 0 || r.y < rows[at].y)) at = i; });
      if (at < 0) continue;
      const head = rows[at];
      // Main text on this page: what is printed above the heading, or - in a two-column paper, where the heading may
      // top the right column - what comes before it in reading order. A running head is not main text: it is the
      // line that sits where the top line of the page before sits.
      let main = rows.filter((r, i) => r.y > head.y + 4 || i < at);
      if (pn > 1) {
        const prev = await rowsOf(pn - 1);
        if (PV.gen !== gen) return null;
        const top = prev.reduce((m, r) => Math.max(m, r.y), -Infinity);
        // "References" as the running head of a later page of the list: the heading itself is on an earlier page
        if (Math.abs(head.y - top) < 3 && prev.some((r) => Math.abs(r.y - top) < 3 && isRefHead(r))) continue;
        main = main.filter((r) => Math.abs(r.y - top) >= 3);
      }
      n = main.reduce((sum, r) => sum + r.s.trim().length, 0) >= 3 ? pn : pn - 1;
    }
  } catch { n = null; }
  if (PV.gen !== gen) return null;
  PV.refs = { gen, n };
  return n;
}
// {n, total, refs}: the pages that count towards the limit
async function countedPages() {
  const b = W.project && W.project.budget, total = PV.pages.length;
  const refs = b && b.skipRefs && total ? await pagesBeforeRefs() : null;
  return { n: refs == null ? total : Math.max(0, refs), total, refs };
}
let budgetSeq = 0;
async function renderBudget() {
  const el = $('#pdf-budget'), p = W.project, b = p && p.budget, seq = ++budgetSeq;
  if (!b || !b.pages || !PV.pages.length || !PV.doc) { el.hidden = true; return; }
  const c = await countedPages();
  if (seq !== budgetSeq || !W.project || W.project !== p && W.project.id !== p.id) return;
  const cls = budgetClass(c.n, b.pages, b.pages);
  el.hidden = false;
  el.textContent = `${c.n} / ${b.pages} pages`;
  el.className = 'tb pdf-budget ' + cls;
  el.title = (b.skipRefs ? (c.refs == null ? `No “References” heading was found in the PDF, so all ${plural(c.total, 'page')} are counted. ` : `${plural(c.n, 'page')} before the reference list (${c.total} in all). `) : `${plural(c.n, 'page')}. `)
    + `The page limit of this project is ${b.pages}${cls === 'bad' ? ` — ${plural(c.n - b.pages, 'page')} over` : cls === 'warn' ? ' — at the limit' : ''}. Click to change it.`;
  el.setAttribute('aria-label', el.title);
}
$('#pdf-budget').addEventListener('click', () => lengthDialog().catch((e) => toast(e.message, 'bad')));

async function lengthDialog() {
  if (!needProject()) return;
  const p = W.project, b = p.budget || {};
  let wc = null, why = '';
  if (!W.tools.texcount) why = 'Words cannot be counted: the texcount program is not installed (it comes with MacTeX / TeX Live).';
  else if (!p.mainFile) why = 'Words cannot be counted: this project has no main .tex file.';
  else if (!(await flushAll())) why = 'Some files could not be saved, so the words were not counted.';
  else {
    toast('Counting words…');
    try { wc = await loadCounts(); if (!wc) why = wcError ? `The words could not be counted: ${wcError}` : 'The words could not be counted.'; } catch (e) { why = e.message; }
    toast('');
  }
  if (!W.project || W.project.id !== p.id) return;
  const pg = PV.pages.length ? await countedPages() : null;
  const row = (k, v, cls = '') => `<tr class="${cls}"><td>${k}</td><td>${fmt(v)}</td></tr>`;
  const secName = (x) => (x.kind === 'top' ? '<span class="muted">Before the first section (title, abstract)</span>' : esc(cleanTitle(x.title) || '(untitled)'));
  const secs = wc ? wc.sections.filter((x) => x.kind !== 'top' || x.words) : [];
  const unit = wc && wc.byCharacter ? 'words and characters' : 'words';
  const dlg = openDialog(`<form method="dialog"><h3>Word count and limits</h3>
    ${wc ? `<p class="wc-total"><strong class="${budgetClass(wc.total, b.words, b.words * 0.9)}">${fmt(wc.total)}</strong> ${unit}${b.words ? ` of ${fmt(b.words)}` : ''}${pg ? ` · <strong class="${budgetClass(pg.n, b.pages, b.pages)}">${pg.n}</strong> ${pg.n === 1 ? 'page' : 'pages'}${b.pages ? ` of ${b.pages}` : ''}${pg.refs != null ? ' before the reference list' : ''}` : ''}</p>
    ${secs.length > 1 ? `<div class="wc-scroll"><table class="wc">${secs.map((x) => row(secName(x), x.kind === 'top' ? x.words : x.total, 'wc-' + x.kind)).join('')}</table></div>` : ''}
    <details class="wc-more"><summary>What is counted</summary><table class="wc">${row('Words in text', wc.words)}${row('Words in headings', wc.headerWords)}${row('Words in captions and footnotes', wc.captionWords)}${row('Headings', wc.headers)}${row('Figures and tables', wc.floats)}${row('Inline formulas', wc.inlineMath)}${row('Displayed formulas', wc.displayMath)}</table>
      <p class="muted">Counted by texcount from ${esc(wc.mainFile)} and the files it includes, as they were last saved. A section includes its subsections; the reference list is not counted.${wc.byCharacter ? ' Chinese, Japanese and Korean text is counted by character.' : ''}</p></details>`
    : `<p class="muted dlg-msg">${esc(why)}</p>`}
    <h4>Limits of this project</h4>
    <div class="dlg-row"><label>Page limit<input type="text" id="bud-pages" inputmode="numeric" autocomplete="off" placeholder="none" maxlength="6" pattern="\\s*[1-9][0-9]{0,3}\\s*" title="A whole number of pages, for example 8 (empty for no limit)" value="${b.pages || ''}"></label>
      <label>Word limit<input type="text" id="bud-words" inputmode="numeric" autocomplete="off" placeholder="none" maxlength="10" pattern="\\s*[1-9][0-9,]{0,8}\\s*" title="A whole number of words, for example 6000 (empty for no limit)" value="${b.words || ''}"></label></div>
    <label class="check"><input type="checkbox" id="bud-refs"${b.skipRefs ? ' checked' : ''}> The reference list does not count towards the page limit</label>
    <p class="muted">The pages are shown against the limit above the PDF and the words above the outline: amber at the limit, red over it. Leave a box empty for no limit.</p>
    ${dlgActions({ okText: 'Save the limits' })}</form>`, (d) => ({ pages: $('#bud-pages', d).value.trim(), words: $('#bud-words', d).value.trim(), skipRefs: $('#bud-refs', d).checked }));
  $('#bud-pages', dlg.d).focus();
  const res = await dlg.result;
  if (!res || !W.project || W.project.id !== p.id) return;
  const int = (v, what) => { if (!v) return null; const n = Number(v.replace(/[,\s]/g, '')); if (!Number.isInteger(n) || n < 1) throw new Error(`The ${what} limit must be a whole number, for example ${what === 'page' ? '8' : '6000'}.`); return n; };
  const budget = { pages: int(res.pages, 'page'), words: int(res.words, 'word'), skipRefs: res.skipRefs };
  if (budget.pages === (b.pages || null) && budget.words === (b.words || null) && (budget.skipRefs === !!b.skipRefs || !budget.pages)) return;
  const r = await api(pUrl('/settings'), { method: 'PUT', json: { budget } });
  applyProject({ project: r.project, files: W.files });
  toast(budget.pages || budget.words ? 'Limits saved' : 'Limits removed', 'ok');
}
async function labelVersion() {
  const b = activeBuf(); if (!b || b.kind !== 'text') return toast('Open a text file first.', 'bad');
  const label = ((await ask({ title: 'Label this version', message: `A name for the current version of ${b.path}, shown in the history.`, okText: 'Save label', icon: 'ref' })) || '').trim();
  if (label) await saveAll(label);
}
$('#btn-label').addEventListener('click', () => labelVersion().catch((e) => toast(e.message, 'bad')));

// ---------------- file tree ----------------
const fileIcon = (f) => (f.type === 'dir' ? null : /^(tex|ltx|sty|cls)$/.test(extOf(f.path)) ? 'tex' : /^(bib|bst)$/.test(extOf(f.path)) ? 'bib' : f.kind === 'image' ? 'image' : f.kind === 'pdf' ? 'pdf' : 'file');
function renderTree() {
  const p = W.project, host = $('#tree');
  if (!p) { host.innerHTML = ''; return; }
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#tree .tr') ? document.activeElement.dataset.path : null;
  const byPath = new Map(W.files.map((f) => [f.path, f]));
  for (const f of W.files) for (let d = dirName(f.path); d && !byPath.has(d); d = dirName(d)) byPath.set(d, { path: d, type: 'dir' });
  const kids = new Map();
  for (const f of byPath.values()) { const k = dirName(f.path); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(f); }
  const walk = (par, depth) => (kids.get(par) || [])
    .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }))
    .map((f) => {
      const dir = f.type === 'dir', shut = dir && W.collapsed.has(f.path), b = W.bufs.get(f.path);
      return `<div class="tr ${dir ? 'dir' : 'file'}${f.path === W.active ? ' active' : ''}${b && b.dirty ? ' dirty' : ''}" data-path="${esc(f.path)}" data-type="${dir ? 'dir' : 'file'}" style="padding-left:${6 + depth * 14}px" tabindex="0" role="treeitem" draggable="true" title="${esc(f.path)}"${dir ? ` aria-expanded="${!shut}"` : ''}>`
        + `<span class="tw">${dir ? ic(shut ? 'chevRight' : 'chevDown') : ''}</span><span class="fi fi-${dir ? 'dir' : fileIcon(f)}">${ic(dir ? (shut ? 'folder' : 'folderOpen') : fileIcon(f))}</span><span class="nm">${esc(baseName(f.path))}</span>`
        + (f.path === p.mainFile ? '<span class="main-mark" title="Main file — this is what gets compiled">main</span>' : '')
        + `<span class="dot" title="Unsaved changes"></span><button class="ghost more" title="Actions" aria-label="Actions for ${esc(f.path)}" tabindex="-1">${ic('more')}</button></div>`
        + (dir && !shut ? walk(f.path, depth + 1) : '');
    }).join('');
  host.innerHTML = walk('', 0) || `<div class="muted tree-empty">${p.missing ? 'Folder not found.' : 'This folder is empty.<br>Create a file or drop files here.'}</div>`;
  if (focused) { const el = $$('#tree .tr').find((x) => x.dataset.path === focused); if (el) el.focus(); }
}
function toggleDir(path) {
  W.collapsed.has(path) ? W.collapsed.delete(path) : W.collapsed.add(path);
  ls.set('rt-collapsed:' + W.project.id, JSON.stringify([...W.collapsed]));
  renderTree();
  const el = $$('#tree .tr').find((x) => x.dataset.path === path); if (el) el.focus();
}
function treeOpen(row) {
  if (row.dataset.type === 'dir') toggleDir(row.dataset.path);
  else { openFile(row.dataset.path).catch((e) => toast(e.message, 'bad')); if (narrow() && narrowOpen) { narrowOpen = false; applyLayout(); } }
}
const rowMenu = (row, anchor) => showCtx(row.dataset.path, row.dataset.type, anchor);
$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.tr'); if (!row) return;
  const more = e.target.closest('.more');
  if (more) return rowMenu(row, more);
  treeOpen(row);
});
$('#tree').addEventListener('keydown', (e) => {
  const row = e.target.closest('.tr'); if (!row || e.target !== row || e.metaKey || e.ctrlKey || e.altKey) return;
  const { path, type } = row.dataset, act = (fn) => { e.preventDefault(); Promise.resolve().then(fn).catch((err) => toast(err.message, 'bad')); };
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); treeOpen(row); }
  else if (e.key === 'F2') act(() => renameEntry(path));
  else if (e.key === 'Delete' || e.key === 'Backspace') act(() => deleteEntry(path, type));
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const rows = $$('#tree .tr'), n = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]; if (n) n.focus(); }
  else if (type === 'dir' && ((e.key === 'ArrowRight' && W.collapsed.has(path)) || (e.key === 'ArrowLeft' && !W.collapsed.has(path)))) { e.preventDefault(); toggleDir(path); }
});
$('#tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tr'); if (!row) return;
  e.preventDefault(); showCtx(row.dataset.path, row.dataset.type, { x: e.clientX, y: e.clientY });
});
function showCtx(path, type, anchor) {
  const dir = type === 'dir', here = dir ? path : dirName(path);
  menu(anchor, [
    { label: 'Rename…', icon: 'pencil', hint: 'F2', run: () => renameEntry(path) },
    { label: 'Delete…', icon: 'trash', hint: 'Del', danger: true, run: () => deleteEntry(path, type) },
    ...(!dir ? [{ label: 'Download', icon: 'download', run: () => download(pUrl(`/raw?path=${enc(path)}&download=1`)) }] : []),
    ...(!dir && /\.(tex|ltx)$/i.test(path) ? [{ label: 'Set as main file', icon: 'tex', disabled: path === W.project.mainFile, run: () => setMain(path) }] : []),
    { sep: true },
    { label: 'New file here', icon: 'newFile', run: () => newEntry('file', here) },
    { label: 'New folder here', icon: 'newFolder', run: () => newEntry('dir', here) },
    { label: 'Upload here', icon: 'upload', run: () => pickUpload(here) },
  ]);
}
// drag a row onto a folder (or onto the empty part of the tree = top level) to move it
let dragPath = null;
const dropDir = (e) => { const row = e.target.closest && e.target.closest('.tr'); return row ? (row.dataset.type === 'dir' ? row.dataset.path : dirName(row.dataset.path)) : ''; };
const clearDrop = () => { $$('#tree .drop').forEach((x) => x.classList.remove('drop')); $('#tree').classList.remove('drop-root'); };
$('#tree').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.tr'); if (!row) return;
  dragPath = row.dataset.path;
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-rt-path', dragPath);
});
$('#tree').addEventListener('dragend', () => { dragPath = null; clearDrop(); });
$('#tree').addEventListener('dragover', (e) => {
  if (!dragPath) return;
  const dir = dropDir(e);
  clearDrop();
  if (dir === dirName(dragPath) || dir === dragPath || dir.startsWith(dragPath + '/')) { e.dataTransfer.dropEffect = 'none'; return; }
  e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
  const row = dir ? $$('#tree .tr').find((x) => x.dataset.path === dir) : null;
  if (row) row.classList.add('drop'); else $('#tree').classList.add('drop-root');
});
$('#tree').addEventListener('drop', (e) => {
  if (!dragPath) return;
  e.preventDefault(); e.stopPropagation();
  const from = dragPath, dir = dropDir(e); dragPath = null; clearDrop();
  if (dir === dirName(from) || dir === from || dir.startsWith(from + '/')) return;
  moveEntry(from, (dir ? dir + '/' : '') + baseName(from)).then(() => toast(`Moved ${baseName(from)} to ${dir || 'the top level'}`, 'ok'), (err) => toast(err.message, 'bad'));
});

const needProject = () => { if (W.project && !W.project.missing) return true; toast('Open a project first.', 'bad'); return false; };
// a project was renamed (next = the new project) or removed (next = null): the remembered project ids follow it
function rekeyProject(oldId, next) {
  if (ls.get('rt-project') === oldId) { if (next) ls.set('rt-project', next.id); else try { localStorage.removeItem('rt-project'); } catch { /* no storage */ } }
  const w = ls.json('rt-working-project', null);
  if (w && w.id === oldId) { if (next) ls.set('rt-working-project', JSON.stringify({ id: next.id, name: next.name })); else try { localStorage.removeItem('rt-working-project'); } catch { /* no storage */ } }
}
async function newEntry(type, dir = '') {
  if (!needProject()) return;
  const what = type === 'dir' ? 'folder' : 'file';
  const raw = await ask({ title: `New ${what}`, message: type === 'file' ? 'File name — you can include folders, e.g. sections/intro.tex' : 'Folder name', value: dir ? dir + '/' : '', placeholder: type === 'file' ? 'name.tex' : 'folder', okText: `Create ${what}`, icon: type === 'file' ? 'newFile' : 'newFolder' });
  if (raw === null) return;
  const path = cleanPath(raw); if (!path || (dir && path === dir)) return toast('That is not a valid name.', 'bad');
  await api(pUrl('/files'), { method: 'POST', json: type === 'file' ? { path, type, content: '' } : { path, type } });
  for (let d = type === 'dir' ? path : dirName(path); d; d = dirName(d)) W.collapsed.delete(d);
  await refreshProject();
  if (type === 'file') await openFile(path);
}
$('#btn-new-file').addEventListener('click', () => newEntry('file').catch((e) => toast(e.message, 'bad')));
$('#btn-new-folder').addEventListener('click', () => newEntry('dir').catch((e) => toast(e.message, 'bad')));

let uploadDir = '';
function pickUpload(dir = '') { if (!needProject()) return; uploadDir = dir; $('#file-upload').click(); }
$('#btn-upload').addEventListener('click', () => pickUpload(''));
$('#file-upload').addEventListener('change', (e) => { const files = [...e.target.files].map((file) => ({ file, rel: file.name })); e.target.value = ''; uploadFiles(files, uploadDir).catch((err) => toast(err.message, 'bad')); });
async function uploadFiles(list, dir = '') {
  if (!needProject() || !list.length) return [];
  const done = [];
  for (const { file, rel } of list) {
    const path = cleanPath((dir ? dir + '/' : '') + rel); if (!path) continue;
    const send = (ow) => api(pUrl(`/upload?path=${enc(path)}${ow ? '&overwrite=1' : ''}`), { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    toast(`Uploading ${path}…`);
    try { await send(false); done.push(path); }
    catch (e) {
      if (e.status === 409 && (await confirmDlg(`${path} already exists. Replace it?`, { okText: 'Replace' }))) { try { await send(true); done.push(path); } catch (e2) { toast(`${path}: ${e2.message}`, 'bad'); } }
      else if (e.status !== 409) toast(`${path}: ${e.message}`, 'bad');
    }
  }
  if (done.length) toast(`Uploaded ${plural(done.length, 'file')}`, 'ok');
  await syncProject();
  return done;
}
// files (and whole folders) dropped from Finder
async function droppedFiles(dt) {
  const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, rel: file.name }));
  const out = [];
  const walk = async (en, pre) => {
    if (en.name.startsWith('.')) return;
    if (en.isFile) out.push({ file: await new Promise((res, rej) => en.file(res, rej)), rel: pre + en.name });
    else if (en.isDirectory) {
      const rd = en.createReader();
      for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const c of batch) await walk(c, pre + en.name + '/'); }
    }
  };
  for (const en of entries) await walk(en, '');
  return out;
}
async function writeDrop(e) {
  if (W.mode !== 'project') { if (RT.projectsHome && RT.projectsHome.onDrop) RT.projectsHome.onDrop(e); return; }
  if (!e.target.closest || !e.target.closest('#side')) return toast('Drop files on the file tree to add them to the project.');
  const row = e.target.closest('.tr');
  const dir = row ? (row.dataset.type === 'dir' ? row.dataset.path : dirName(row.dataset.path)) : '';
  try { await uploadFiles(await droppedFiles(e.dataTransfer), dir); } catch (err) { toast('Upload failed: ' + err.message, 'bad'); }
}

async function renameEntry(from) {
  const raw = await ask({ title: 'Rename', message: 'New name — change the folder part to move it.', value: from, okText: 'Rename', icon: 'pencil' });
  if (raw === null) return;
  const to = cleanPath(raw); if (!to) return toast('That is not a valid name.', 'bad');
  if (to !== from) await moveEntry(from, to);
}
// rename / move a file or folder and keep open tabs, the main file and collapsed folders pointing at it
async function moveEntry(from, to) {
  await flushAll();
  await api(pUrl('/rename'), { method: 'POST', json: { from, to } });
  const map = (p) => (p === from ? to : p && p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  const wasMain = W.project.mainFile, bufs = new Map();
  for (const [p, b] of W.bufs) {
    const np = map(p);
    if (np !== p && b.doc && modeFor(np) !== modeFor(p)) { const act = cm.getDoc() === b.doc; b.path = np; makeDoc(b, b.doc.getValue()); if (act) cm.swapDoc(b.doc); }
    b.path = np; bufs.set(np, b);
  }
  W.bufs = bufs; W.open = W.open.map(map); W.active = map(W.active);
  W.collapsed = new Set([...W.collapsed].map(map)); ls.set('rt-collapsed:' + W.project.id, JSON.stringify([...W.collapsed]));
  persistTabs(); renderTabs();
  await refreshProject();
  if (wasMain && map(wasMain) !== wasMain && W.project.mainFile !== map(wasMain)) await setMain(map(wasMain), true);
  renderPath(); RT.claudeContext.refresh(); outlineSoon();
  if (W.hist.on) loadHistory();
}
async function deleteEntry(path, type) {
  if (!(await confirmDlg(`Delete ${type === 'dir' ? 'the folder ' : ''}“${path}”${type === 'dir' ? ' and everything in it' : ''}?\n\nIt is moved to the workspace trash, not permanently deleted.`, { title: 'Delete', okText: 'Delete', danger: true }))) return;
  for (const p of [...W.open]) if (p === path || p.startsWith(path + '/')) dropTab(p);
  await api(pUrl(`/file?path=${enc(path)}`), { method: 'DELETE' });
  toast(`Moved ${path} to the trash`, 'ok');
  await syncProject();
}
async function setMain(path, quiet) {
  const r = await api(pUrl('/settings'), { method: 'PUT', json: { mainFile: path } });
  applyProject({ project: r.project, files: W.files });
  if (!quiet) { toast(`${path} is now the main file`, 'ok'); compile(); }
}
async function refreshProject() {
  const pid = W.project.id, r = await api(pUrl());
  if (W.project && W.project.id === pid) applyProject(r);
}

// ---------------- open files / tabs ----------------
async function openFile(path, o = {}) {
  if (!W.project) return null;
  const pid = W.project.id;
  if (!W.bufs.has(path)) {
    const ent = fileEntry(path);
    const b = { pid, path, kind: (ent && ent.kind) || 'text', dirty: false, rev: 0 };
    if (b.kind === 'text') {
      try {
        const f = await api(pUrl(`/file?path=${enc(path)}`));
        b.hash = f.hash; b.mtime = f.mtime;
        if (cm) makeDoc(b, f.content); else b.text = f.content;
      } catch (e) {
        if (e.status !== 415) { toast(`Could not open ${path}: ${e.message}`, 'bad'); return null; }
        b.kind = e.data && e.data.kind && e.data.kind !== 'text' ? e.data.kind : 'binary'; b.note = e.message;
      }
    }
    if (!W.project || W.project.id !== pid) return null;
    if (!W.bufs.has(path)) {
      if (!cm) for (const p of [...W.open]) await closeTab(p); // plain-textarea fallback: one file at a time
      W.bufs.set(path, b); W.open.push(path); markErrors();
    }
  }
  if (o.activate !== false) activate(path);
  return W.bufs.get(path);
}
function activate(path) {
  if (!cm) { const old = activeBuf(); if (old && old.kind === 'text' && old.path !== path) old.text = ta.value; }
  W.active = path && W.bufs.has(path) ? path : null;
  const b = activeBuf();
  if (b && b.kind === 'text') { if (cm) { if (cm.getDoc() !== b.doc) cm.swapDoc(b.doc); } else ta.value = b.text; }
  if (W.hist.on && !W.hist.all) { W.hist.sel = null; loadHistory(); }
  renderTabs(); renderMarks(); showArea(); renderConflict(); renderPath(); RT.claudeContext.refresh(); persistTabs();
  renderOutline(); updateStyleName(); runChecks();
}
function renderTabs() {
  $('#tabs').innerHTML = W.open.map((p) => {
    const b = W.bufs.get(p);
    return `<div class="ftab${p === W.active ? ' active' : ''}${b && b.dirty ? ' dirty' : ''}" data-path="${esc(p)}" title="${esc(p)}"><button class="nm">${esc(baseName(p))}</button><span class="dot" title="Unsaved changes"></span><button class="x ghost" title="Close" aria-label="Close ${esc(p)}">${ic('close')}</button></div>`;
  }).join('');
  const el = $('#tabs .ftab.active'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.ftab'); if (!t) return;
  if (e.target.closest('.x')) closeTab(t.dataset.path).catch((err) => toast(err.message, 'bad')); else if (t.dataset.path !== W.active) activate(t.dataset.path);
});
$('#tabs').addEventListener('mousedown', (e) => { if (e.button === 1 && e.target.closest('.ftab')) e.preventDefault(); });
$('#tabs').addEventListener('auxclick', (e) => { const t = e.target.closest('.ftab'); if (t && e.button === 1) { e.preventDefault(); closeTab(t.dataset.path).catch((err) => toast(err.message, 'bad')); } });
// remove a tab without saving (the caller has dealt with unsaved text)
function dropTab(path) {
  const b = W.bufs.get(path); if (!b) return;
  if (RT.writeAi && RT.writeAi.forget) RT.writeAi.forget(b);
  b.closed = true; b.dirty = false; clearTimeout(b.timer);
  const i = W.open.indexOf(path);
  W.bufs.delete(path); W.open = W.open.filter((p) => p !== path);
  if (W.active === path) activate(W.open[Math.min(i, W.open.length - 1)] || null);
  else { renderTabs(); renderMarks(); persistTabs(); }
}
async function closeTab(path) {
  const b = W.bufs.get(path); if (!b) return;
  if (b.kind === 'text' && (b.dirty || b.saving)) {
    const ok = await saveBuf(b, 'auto');
    if ((!ok || b.dirty) && !(await confirmDlg(`${path} could not be saved. Close it anyway and drop the unsaved changes?`, { okText: 'Close the file and drop the unsaved changes', icon: 'leave', danger: true }))) return;
    if (ok && b.pid === W.project?.id && W.opts.auto) compile();
  }
  if (W.bufs.get(path) === b) dropTab(path);
}
// which of editor / file preview is showing in the editor area
function showArea() {
  const b = activeBuf(), text = !!b && b.kind === 'text';
  $('#editor-host').hidden = !text; $('#file-view').hidden = text;
  $('#ed-toolbar').classList.toggle('off', !text);
  if (text) { editor.refresh(); return; }
  const fv = $('#file-view');
  if (!b) { fv.innerHTML = `<div class="empty">${W.project && W.project.missing ? 'This project folder is missing.' : 'Pick a file in the file tree to start editing.'}</div>`; return; }
  const raw = pUrl(`/raw?path=${enc(b.path)}`);
  if (b.kind === 'image') fv.innerHTML = `<div class="img-view"><img src="${esc(raw)}&t=${Date.now()}" alt="${esc(b.path)}"><div class="muted">${esc(b.path)} · <a href="${esc(raw)}&download=1">Download</a></div></div>`;
  else fv.innerHTML = `<div class="empty"><div><p><strong>${esc(baseName(b.path))}</strong></p><p class="muted">${b.kind === 'pdf' ? 'PDF files are not shown in the editor.' : esc(b.note || 'This file cannot be edited here.')}</p><p>${b.kind === 'pdf' ? `<a href="${esc(raw)}" target="_blank" rel="noopener">Open in a new tab</a> · ` : ''}<a href="${esc(raw)}&download=1">Download</a></p></div></div>`;
}
async function gotoLine(path, line, col, len) {
  if (W.hist.on) await setHistory(false);
  if (W.ui.layout === 'pdf') setLayout('both');
  const b = await openFile(path);
  if (b && b.kind === 'text') { showArea(); setTimeout(() => editor.goto(line, col, len), 0); }
}

// ---------------- file outline ----------------
const SEC_LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const SEC_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
const stripComment = (line) => { const m = line.match(/(^|[^\\])(\\\\)*%/); return m ? line.slice(0, m.index + m[0].length - 1) : line; };
function braceArg(s, i) { // text of the {...} group whose content starts at index i (to the end of the line if it is not closed there)
  let depth = 1, j = i;
  for (; j < s.length; j++) { const c = s[j]; if (c === '\\') { j++; continue; } if (c === '{') depth++; else if (c === '}' && --depth === 0) break; }
  return s.slice(i, j);
}
const cleanTitle = (t) => t.replace(/\\label\{[^}]*\}/g, '').replace(/\\([&%$#_])/g, '$1').replace(/\\[a-zA-Z]+\*?/g, ' ').replace(/[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
function parseOutline(text, path) {
  const items = [], lines = text.split('\n');
  if (/\.bib$/i.test(path)) {
    lines.forEach((l, i) => { const m = l.match(/^\s*@([A-Za-z]+)\s*[{(]\s*([^,\s{}]+)/); if (m && !/^(comment|string|preamble)$/i.test(m[1])) items.push({ level: 0, title: m[2], kind: m[1].toLowerCase(), line: i + 1 }); });
    return { kind: 'bib', items };
  }
  if (modeFor(path) !== 'stex') return null;
  lines.forEach((raw, i) => {
    if (raw.indexOf('\\') < 0) return;
    const line = stripComment(raw);
    SEC_RE.lastIndex = 0;
    let m;
    while ((m = SEC_RE.exec(line))) items.push({ level: SEC_LEVEL[m[1]], title: cleanTitle(braceArg(line, SEC_RE.lastIndex)) || '(untitled)', kind: m[1], line: i + 1 });
  });
  return { kind: 'tex', items };
}
const OUT = { items: [], shut: new Set(), key: '' };
function renderOutline() {
  const b = activeBuf(), host = $('#outline');
  const res = b && b.kind === 'text' && !W.hist.on ? parseOutline(bufText(b), b.path) : null;
  OUT.items = res ? res.items : [];
  if (!res || !res.items.length) {
    host.innerHTML = `<div class="muted out-empty">${!b ? 'Open a file to see its outline.' : !res ? 'No outline for this kind of file.' : res.kind === 'bib' ? 'No entries in this .bib file yet.' : 'No sections yet.<br>Add <code>\\section{…}</code> and it appears here.'}</div>`;
    return;
  }
  // parent = nearest earlier item with a smaller level
  const stack = [];
  OUT.items.forEach((it, i) => {
    while (stack.length && OUT.items[stack[stack.length - 1]].level >= it.level) stack.pop();
    it.depth = stack.length; it.parent = stack.length ? stack[stack.length - 1] : -1; it.kids = false;
    if (it.parent >= 0) OUT.items[it.parent].kids = true;
    it.key = `${b.path}|${it.level}|${it.title}`;
    stack.push(i);
  });
  const hiddenBy = (it) => { for (let p = it.parent; p >= 0; p = OUT.items[p].parent) if (OUT.shut.has(OUT.items[p].key)) return true; return false; };
  const counts = res.kind === 'tex' ? outlineCounts(OUT.items) : new Map(), unit = W.wc && W.wc.byCharacter ? 'words and characters' : 'words';
  host.innerHTML = OUT.items.map((it, i) => (hiddenBy(it) ? '' : `<div class="ol-row" data-i="${i}" style="padding-left:${6 + it.depth * 13}px" tabindex="0" title="${esc(it.title)} — line ${it.line}${counts.has(i) ? ` — ${fmt(counts.get(i))} ${unit}${it.kids ? ', with its subsections' : ''} (as last saved)` : ''}">`
    + `<span class="tw${it.kids ? ' has' : ''}">${it.kids ? ic(OUT.shut.has(it.key) ? 'chevRight' : 'chevDown') : ''}</span><span class="nm">${esc(it.title)}</span>${res.kind === 'bib' ? `<span class="muted ol-kind">${esc(it.kind)}</span>` : ''}${counts.has(i) ? `<span class="ol-wc">${fmt(counts.get(i))}</span>` : ''}</div>`)).join('');
  outlineCursor();
}
const outlineSoon = debounce(renderOutline, 300);
function outlineCursor() {
  if (!cm || !OUT.items.length) return;
  const line = cm.getCursor().line + 1;
  let cur = -1;
  OUT.items.forEach((it, i) => { if (it.line <= line) cur = i; });
  for (const el of $$('#outline .ol-row')) el.classList.toggle('cur', Number(el.dataset.i) === cur);
}
$('#outline').addEventListener('click', (e) => {
  const row = e.target.closest('.ol-row'); if (!row) return;
  const it = OUT.items[Number(row.dataset.i)]; if (!it) return;
  if (e.target.closest('.tw.has')) { OUT.shut.has(it.key) ? OUT.shut.delete(it.key) : OUT.shut.add(it.key); renderOutline(); return; }
  editor.goto(it.line);
});
$('#outline').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const row = e.target.closest('.ol-row'), it = row && OUT.items[Number(row.dataset.i)]; if (it) editor.goto(it.line); } });

// ---------------- project-wide search ----------------
const PS = { cs: false, regex: false, seq: 0 };
async function projectSearch() {
  const q = $('#ps-q').value, host = $('#ps-results'), seq = ++PS.seq;
  if (!W.project || !q) { host.innerHTML = '<div class="muted ps-note">Type to search every text file of this project.</div>'; return; }
  try {
    await flushAll();
    const r = await api(pUrl(`/search?q=${enc(q)}&regex=${PS.regex ? 1 : 0}&case=${PS.cs ? 1 : 0}`));
    if (seq !== PS.seq) return;
    const by = new Map();
    for (const m of r.matches) { if (!by.has(m.file)) by.set(m.file, []); by.get(m.file).push(m); }
    host.innerHTML = `<div class="muted ps-note">${r.matches.length ? `${plural(r.matches.length, 'match')} in ${plural(by.size, 'file')}${r.truncated ? ' — only the first 500 are shown' : ''}` : 'No matches.'}</div>`
      + [...by].map(([file, ms]) => `<div class="ps-file" title="${esc(file)}">${ic(fileIcon({ path: file, type: 'file' }))}<span class="nm">${esc(file)}</span><span class="cnt">${ms.length}</span></div>`
        + ms.map((m) => { const at = Math.max(0, Math.min(m.at, m.text.length)), end = Math.min(m.text.length, at + m.len);
          return `<div class="ps-hit" tabindex="0" data-file="${esc(m.file)}" data-line="${m.line}" data-col="${m.col}" data-len="${m.len}"><span class="ln">${m.line}</span><span class="tx">${esc(m.text.slice(0, at).trimStart())}<mark>${esc(m.text.slice(at, end))}</mark>${esc(m.text.slice(end))}</span></div>`; }).join('')).join('');
  } catch (e) { if (seq === PS.seq) host.innerHTML = `<div class="ps-note bad">${esc(e.message)}</div>`; }
}
const projectSearchSoon = debounce(projectSearch, 300);
$('#ps-q').addEventListener('input', projectSearchSoon);
$('#ps-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); projectSearchSoon.flush(); } });
for (const [id, k] of [['#ps-case', 'cs'], ['#ps-regex', 'regex']]) {
  $(id).addEventListener('click', () => { PS[k] = !PS[k]; $(id).classList.toggle('on', PS[k]); $(id).setAttribute('aria-pressed', String(PS[k])); projectSearch(); });
}
const hitGo = (el) => { if (el) gotoLine(el.dataset.file, Number(el.dataset.line), Number(el.dataset.col), Number(el.dataset.len)).catch((e) => toast(e.message, 'bad')); };
$('#ps-results').addEventListener('click', (e) => hitGo(e.target.closest('.ps-hit')));
$('#ps-results').addEventListener('keydown', (e) => { if (e.key === 'Enter') hitGo(e.target.closest('.ps-hit')); });

// ---------------- labels (for \ref) ----------------
async function loadLabels() {
  const p = W.project; if (!p || p.missing) return [];
  try { const r = await api(pUrl('/labels', p.id)); if (W.project && W.project.id === p.id) W.labels = r.labels || []; } catch { /* keep the old list */ }
  return W.labels;
}
const labelsSoon = debounce(() => { loadLabels(); }, 1500);

// ---------------- editor toolbar ----------------
function wrap(before, after, placeholder = '') {
  cm.operation(() => {
    const sel = cm.getSelection();
    if (sel) { cm.replaceSelection(before + sel + after, 'around'); return; }
    const c = cm.getCursor();
    cm.replaceRange(before + placeholder + after, c);
    cm.setSelection({ line: c.line, ch: c.ch + before.length }, { line: c.line, ch: c.ch + before.length + placeholder.length });
  });
  cm.focus();
}
// insert whole lines at the cursor (replacing the selection), on lines of their own; `at` = [line index, column] for the cursor
function insertBlock(lines, at) {
  cm.operation(() => {
    const from = cm.getCursor('from'), to = cm.getCursor('to');
    const before = cm.getLine(from.line).slice(0, from.ch), after = cm.getLine(to.line).slice(to.ch);
    const indent = before.match(/^\s*/)[0], pre = before.trim() ? '\n' + indent : '';
    const text = pre + lines.map((l, i) => (i ? indent : '') + l).join('\n') + (after.trim() ? '\n' + indent : '');
    cm.replaceRange(text.split('\n'), from, to); // lines, so a CRLF file gets its own line ends
    if (at) { const l0 = from.line + (pre ? 1 : 0); cm.setCursor(l0 + at[0], (at[0] === 0 && !pre ? from.ch : indent.length) + at[1]); }
  });
  cm.focus();
}
const STYLES = [['', 'Normal text'], ['section', 'Section'], ['subsection', 'Subsection'], ['subsubsection', 'Subsubsection'], ['paragraph', 'Paragraph']];
// a heading line: {indent, cmd, inner (the title), rest (what follows the closing brace, e.g. \label{...})}
function headingOf(line) {
  const m = line.match(/^(\s*)\\(section|subsection|subsubsection|paragraph)\*?\{/);
  if (!m) return null;
  const inner = braceArg(line, m[0].length);
  return { indent: m[1], cmd: m[2], inner, rest: line.slice(m[0].length + inner.length + 1) };
}
function currentStyle() {
  if (!cm) return '';
  const h = headingOf(cm.getLine(cm.getCursor().line));
  return h ? h.cmd : '';
}
function updateStyleName() { const s = currentStyle(); $('#style-name').textContent = (STYLES.find((x) => x[0] === s) || STYLES[0])[1]; }
function setStyle(cmd) {
  cm.operation(() => {
    const from = cm.getCursor('from'), to = cm.getCursor('to');
    const n = from.line, line = cm.getLine(n), h = headingOf(line);
    if (!h && from.line === to.line && from.ch !== to.ch) { // part of a line is selected: that becomes the heading
      if (cmd) insertBlock([`\\${cmd}{${cm.getSelection()}}`]);
      return;
    }
    const indent = h ? h.indent : line.match(/^\s*/)[0], inner = h ? h.inner : line.trim(), rest = h ? h.rest : '';
    const head = indent + (cmd ? `\\${cmd}{${inner}}` : inner);
    cm.replaceRange(head + (cmd || !rest.trim() ? rest : ' ' + rest.trim()), { line: n, ch: 0 }, { line: n, ch: line.length });
    cm.setCursor(n, cmd ? head.length - 1 : head.length);
  });
  cm.focus(); updateStyleName();
}
function makeList(env) {
  const sel = cm.getSelection();
  const rows = sel.trim() ? sel.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => '  \\item ' + l.replace(/^\\item\s*/, '')) : ['  \\item '];
  insertBlock([`\\begin{${env}}`, ...rows, `\\end{${env}}`], [rows.length, rows[rows.length - 1].length]);
}
function toggleComment() {
  if (!cm || !editor.ok()) return;
  cm.operation(() => {
    const from = cm.getCursor('from'), to = cm.getCursor('to');
    const last = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
    const nums = []; for (let n = from.line; n <= last; n++) nums.push(n);
    const filled = nums.filter((n) => cm.getLine(n).trim());
    const off = filled.length > 0 && filled.every((n) => /^\s*%/.test(cm.getLine(n)));
    for (const n of filled.length ? filled : nums) {
      const l = cm.getLine(n);
      if (off) { const m = l.match(/^(\s*)% ?/); cm.replaceRange('', { line: n, ch: m[1].length }, { line: n, ch: m[0].length }); }
      else { const ind = l.match(/^\s*/)[0].length; cm.replaceRange('% ', { line: n, ch: ind }); }
    }
  });
}
const SYMBOLS = [['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma'], ['δ', 'delta'], ['ε', 'epsilon'], ['θ', 'theta'], ['λ', 'lambda'], ['μ', 'mu'], ['π', 'pi'], ['ρ', 'rho'], ['σ', 'sigma'], ['τ', 'tau'],
  ['φ', 'phi'], ['χ', 'chi'], ['ψ', 'psi'], ['ω', 'omega'], ['Γ', 'Gamma'], ['Δ', 'Delta'], ['Θ', 'Theta'], ['Λ', 'Lambda'], ['Σ', 'Sigma'], ['Φ', 'Phi'], ['Ψ', 'Psi'], ['Ω', 'Omega'],
  ['∑', 'sum'], ['∏', 'prod'], ['∫', 'int'], ['∂', 'partial'], ['∇', 'nabla'], ['∞', 'infty'], ['√', 'sqrt{}'], ['±', 'pm'], ['×', 'times'], ['·', 'cdot'], ['÷', 'div'], ['≤', 'leq'],
  ['≥', 'geq'], ['≠', 'neq'], ['≈', 'approx'], ['≡', 'equiv'], ['∝', 'propto'], ['∈', 'in'], ['∉', 'notin'], ['⊂', 'subset'], ['∪', 'cup'], ['∩', 'cap'], ['∀', 'forall'], ['∃', 'exists'],
  ['→', 'rightarrow'], ['←', 'leftarrow'], ['⇒', 'Rightarrow'], ['⇔', 'Leftrightarrow'], ['↦', 'mapsto'], ['…', 'dots'], ['ℝ', 'mathbb{R}'], ['ℕ', 'mathbb{N}'], ['∅', 'emptyset'], ['¬', 'neg'], ['∧', 'land'], ['∨', 'lor']];
async function figureDialog() {
  const p = W.project;
  const imgs = W.files.filter((f) => f.type === 'file' && (f.kind === 'image' || f.kind === 'pdf' || /\.(eps|ps|tiff?)$/i.test(f.path)));
  const res = await openDialog(`<form method="dialog"><h3>Insert figure</h3>
    <label>Image already in this project<select id="fig-file"><option value="">— none chosen —</option>${imgs.map((f) => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('')}</select></label>
    <div class="dlg-row"><label>…or upload a new image<input type="file" id="fig-upload" accept="image/*,.pdf,.eps"></label><label class="narrow">into folder<input type="text" id="fig-dir" value="figures" spellcheck="false"></label></div>
    <label>Caption<input type="text" id="fig-caption" placeholder="What the figure shows"></label>
    <div class="dlg-row"><label>Label (for \\ref)<input type="text" id="fig-label" placeholder="fig:my-figure" spellcheck="false"></label>
      <label class="narrow">Width<select id="fig-width"><option value="0.5">50% of the line</option><option value="0.8" selected>80% of the line</option><option value="1">full line width</option></select></label></div>
    ${dlgActions({ okText: 'Insert figure', icon: 'image' })}</form>`, (d) => ({ file: $('#fig-file', d).value, upload: $('#fig-upload', d).files[0] || null, dir: $('#fig-dir', d).value, caption: $('#fig-caption', d).value.trim(), label: $('#fig-label', d).value.trim(), width: $('#fig-width', d).value })).result;
  if (!res || !W.project || W.project.id !== p.id) return;
  let path = res.file;
  if (res.upload) {
    const done = await uploadFiles([{ file: res.upload, rel: res.upload.name }], cleanPath(res.dir) || '');
    if (!done.length) return;
    path = done[0];
  }
  if (!path) return toast('Choose an image of the project or upload one.', 'bad');
  const mainDir = W.project.mainFile ? dirName(W.project.mainFile) : '';
  const width = res.width === '1' ? '\\linewidth' : res.width + '\\linewidth';
  insertBlock(['\\begin{figure}[htbp]', '  \\centering', `  \\includegraphics[width=${width}]{${relPath(mainDir, path)}}`, `  \\caption{${res.caption}}`, `  \\label{${res.label || 'fig:' + baseName(path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9:_-]+/g, '-')}}`, '\\end{figure}'], res.caption ? [5, 12] : [3, 11]);
  const mb = W.bufs.get(W.project.mainFile);
  if (mb && mb.kind === 'text' && !/graphicx/.test(bufText(mb))) toast('Figure inserted — add \\usepackage{graphicx} to the preamble of the main file.', 'ok');
}
function insertTable(rows, cols) {
  const row = (r) => '    ' + Array.from({ length: cols }, (_, c) => (r === 0 ? `Head ${c + 1}` : ' ')).join(' & ') + ' \\\\';
  const body = [];
  for (let r = 0; r < rows; r++) { body.push(row(r)); body.push('    \\hline'); }
  insertBlock(['\\begin{table}[htbp]', '  \\centering', `  \\begin{tabular}{|${Array(cols).fill('l').join('|')}|}`, '    \\hline', ...body, '  \\end{tabular}', '  \\caption{}', '  \\label{tab:}', '\\end{table}'], [6 + rows * 2 - 1, 11]);
}
const CMDS = {
  undo: () => { cm.undo(); cm.focus(); }, redo: () => { cm.redo(); cm.focus(); },
  style: (btn) => { const cur = currentStyle(); menu(btn, STYLES.map(([v, label]) => ({ label, check: v === cur, run: () => setStyle(v) }))); },
  bold: () => wrap('\\textbf{', '}'), italic: () => wrap('\\textit{', '}'), math: () => wrap('$', '$'),
  dmath: () => { const sel = cm.getSelection().trim(); insertBlock(['\\[', '  ' + sel, '\\]'], [1, 2 + sel.length]); },
  symbol: (btn) => {
    const pop = popover(btn, `<div class="sym-grid">${SYMBOLS.map(([ch, c]) => `<button type="button" data-c="${esc(c)}" title="\\${esc(c)}" aria-label="${esc(c)}">${esc(ch)}</button>`).join('')}</div><div class="muted pop-note">Symbols need math mode: $ … $</div>`, { width: 330 });
    if (pop) $('.sym-grid', pop).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; closeMenus(); const c = b.dataset.c; cm.replaceSelection('\\' + c + (/\}$/.test(c) ? '' : ' ')); if (/\{\}$/.test(c)) cm.execCommand('goCharLeft'); cm.focus(); });
  },
  link: async () => {
    const url = await ask({ title: 'Insert link', message: 'Web address. The selected text becomes the link text (needs \\usepackage{hyperref}).', value: 'https://', okText: 'Insert link', icon: 'link' });
    if (!url || !url.trim()) return;
    const sel = cm.getSelection();
    if (sel) cm.replaceSelection(`\\href{${url.trim()}}{${sel}}`);
    else wrap(`\\href{${url.trim()}}{`, '}', 'link text');
    cm.focus();
  },
  ref: async (btn) => {
    await flushAll();
    const labels = await loadLabels();
    pickList(btn || $('[data-cmd=ref]'), { placeholder: 'Search labels…', empty: 'No \\label{…} found in the .tex files of this project.',
      items: labels.map((l) => ({ key: l.name, title: '', sub: `${l.file}:${l.line}` })), onPick: (it) => editor.insert(`\\ref{${it.key}}`) });
  },
  cite: async (btn) => {
    try { if (RT.library && RT.library.refresh) await RT.library.refresh(); } catch { /* use what is loaded */ }
    await loadPapers(true);
    // the papers of the project first, then the rest of the library
    const mine = memberRows(), have = new Set(mine.map((r) => r.citekey)), group = mine.length ? 'Library' : undefined;
    const items = [...mine.map((r) => ({ key: r.citekey, title: `${r.author} ${r.year}`, sub: r.title, mark: citeMark(r), group: 'In this project' })),
      ...libItems().filter((i) => !have.has(i.citekey)).map((i) => ({ key: i.citekey, title: `${authorsShort(i.fields.author)} ${i.fields.year || ''}`, sub: i.fields.title || '', group }))];
    pickList(btn || $('[data-cmd=cite]'), { placeholder: 'Search library…', empty: 'Your library is empty — import references in the Library tab.',
      items, onPick: (it) => editor.insert(`\\cite{${it.key}}`) });
  },
  figure: () => figureDialog(),
  table: (btn) => {
    const R = 8, C = 8;
    const pop = popover(btn, `<div class="tbl-grid" style="grid-template-columns:repeat(${C},18px)">${Array.from({ length: R * C }, (_, i) => `<i data-r="${Math.floor(i / C) + 1}" data-c="${(i % C) + 1}"></i>`).join('')}</div><div class="muted pop-note" id="tbl-size">Pick the table size</div>`, { width: 190 });
    if (!pop) return;
    const grid = $('.tbl-grid', pop);
    grid.addEventListener('mouseover', (e) => {
      const c = e.target.closest('i'); if (!c) return;
      const r0 = Number(c.dataset.r), c0 = Number(c.dataset.c);
      for (const x of $$('i', grid)) x.classList.toggle('on', Number(x.dataset.r) <= r0 && Number(x.dataset.c) <= c0);
      $('#tbl-size', pop).textContent = `${r0} × ${c0}  (rows × columns)`;
    });
    grid.addEventListener('click', (e) => { const c = e.target.closest('i'); if (!c) return; closeMenus(); insertTable(Number(c.dataset.r), Number(c.dataset.c)); });
  },
  ul: () => makeList('itemize'), ol: () => makeList('enumerate'),
  askai: (btn) => RT.writeAi.menu(btn || $('[data-cmd=askai]')), related: () => RT.writeAi.relatedWork(), // write-ai.js
  cmptable: () => { if (RT.compare) RT.compare.open(); }, // compare.js
  papers: () => papersDialog(),
  search: () => { cm.focus(); cm.execCommand('findPersistent'); },
};
function runCmd(name, btn) {
  const f = CMDS[name]; if (!f) return;
  if (name === 'papers') return Promise.resolve().then(() => f(btn)).catch((e) => toast(e.message, 'bad')); // needs no open file
  if (!cm) return toast('The editor could not be started, so the toolbar is unavailable.', 'bad');
  if (!editor.ok()) return;
  Promise.resolve().then(() => f(btn)).catch((e) => toast(e.message, 'bad'));
}
$('#ed-toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the editor's selection
$('#ed-toolbar').addEventListener('click', (e) => { const b = e.target.closest('button[data-cmd]'); if (b) runCmd(b.dataset.cmd, b); });

// ---------------- autocomplete ----------------
const ENVS = ['abstract', 'align', 'align*', 'center', 'description', 'document', 'enumerate', 'equation', 'equation*', 'figure', 'figure*', 'itemize', 'tabular', 'table', 'table*',
  'quote', 'verbatim', 'theorem', 'lemma', 'proof', 'definition', 'minipage', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'array', 'thebibliography', 'tikzpicture', 'frame', 'columns', 'lstlisting'];
// '|' marks where the cursor goes
const COMMANDS = ['section{|}', 'subsection{|}', 'subsubsection{|}', 'paragraph{|}', 'chapter{|}', 'textbf{|}', 'textit{|}', 'emph{|}', 'texttt{|}', 'underline{|}', 'textsc{|}', 'cite{|}', 'citep{|}', 'citet{|}',
  'ref{|}', 'eqref{|}', 'pageref{|}', 'label{|}', 'begin{|}', 'end{|}', 'item ', 'includegraphics[width=\\linewidth]{|}', 'caption{|}', 'centering', 'footnote{|}', 'input{|}', 'include{|}',
  'usepackage{|}', 'documentclass{|}', 'title{|}', 'author{|}', 'date{|}', 'maketitle', 'tableofcontents', 'newcommand{|}{}', 'renewcommand{|}{}', 'frac{|}{}', 'sqrt{|}', 'sum', 'int', 'prod', 'lim',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'sigma', 'phi', 'omega', 'infty', 'partial', 'nabla', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx', 'rightarrow', 'Rightarrow',
  'left', 'right', 'mathbf{|}', 'mathrm{|}', 'mathcal{|}', 'mathbb{|}', 'text{|}', 'hline', 'textwidth', 'linewidth', 'bibliography{|}', 'bibliographystyle{|}', 'newpage', 'noindent', 'vspace{|}', 'hspace{|}',
  'url{|}', 'href{|}{}', 'today', 'LaTeX', 'verb', 'nocite{|}', 'appendix', 'multicolumn{|}{}{}', 'quad', 'dots', 'ldots', 'overline{|}', 'hat{|}', 'bar{|}', 'vec{|}'];
function texHint(c) {
  const cur = c.getCursor(), line = c.getLine(cur.line).slice(0, cur.ch), P = CodeMirror.Pos;
  const out = (from, list) => (list.length ? { list, from: P(cur.line, from), to: cur } : null);
  let m;
  if ((m = line.match(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^{}]*)$/))) {
    const part = m[1].split(',').pop(), q = part.trim().toLowerCase(), from = cur.ch - part.length + (part.length - part.trimStart().length);
    // the papers of the project first (under a heading), then the library and the open .bib files
    const mine = new Map(memberRows().map((r) => [r.citekey, r])), keys = new Map();
    for (const [k, r] of mine) keys.set(k, `${r.author} ${r.year} — ${r.title}`);
    for (const i of libItems()) if (!keys.has(i.citekey)) keys.set(i.citekey, `${authorsShort(i.fields.author)} ${i.fields.year || ''} — ${i.fields.title || ''}`);
    for (const b of W.bufs.values()) if (b.kind === 'text' && /\.bib$/i.test(b.path)) for (const it of parseOutline(bufText(b), b.path).items) if (!keys.has(it.title)) keys.set(it.title, b.path);
    const list = [...keys].filter(([k, d]) => !q || k.toLowerCase().includes(q) || d.toLowerCase().includes(q)).slice(0, 60);
    const anyMine = list.some(([k]) => mine.has(k));
    return out(from, list.map(([k, d], n) => {
      const r = mine.get(k), prev = n && list[n - 1][0];
      const head = !anyMine ? '' : r && !n ? 'In this project' : !r && (!n || mine.has(prev)) ? 'Library' : '';
      const text = `${k}   ${d.slice(0, r ? 56 : 70)}${r ? `  · ${citeMark(r)}` : ''}`;
      return { text: k, displayText: text, render: (el) => { if (head) { const h = document.createElement('div'); h.className = 'hint-head'; h.textContent = head; el.append(h); } el.append(text); } };
    }));
  }
  if ((m = line.match(/\\(?:eq|page|auto|name|c|C|v)?ref\*?\{([^{}]*)$/))) {
    const q = m[1].toLowerCase(), seen = new Set();
    return out(cur.ch - m[1].length, W.labels.filter((l) => !seen.has(l.name) && seen.add(l.name) && (!q || l.name.toLowerCase().includes(q))).slice(0, 60).map((l) => ({ text: l.name, displayText: `${l.name}   ${l.file}:${l.line}` })));
  }
  if ((m = line.match(/\\(begin|end)\{([a-zA-Z*]*)$/))) {
    const q = m[2].toLowerCase();
    return out(cur.ch - m[2].length, ENVS.filter((e) => e.startsWith(q)).map((env) => (m[1] === 'end' ? { text: env } : { text: env, hint: (cc, data) => cc.operation(() => {
      cc.replaceRange(env, data.from, data.to);
      let p = cc.getCursor();
      if (cc.getLine(p.line).slice(p.ch).startsWith('}')) p = P(p.line, p.ch + 1); else { cc.replaceRange('}', p); p = cc.getCursor(); }
      const indent = cc.getLine(p.line).match(/^\s*/)[0], item = /^(itemize|enumerate|description)$/.test(env) ? '\\item ' : '';
      cc.replaceRange(`\n${indent}  ${item}\n${indent}\\end{${env}}`, p);
      cc.setCursor(p.line + 1, indent.length + 2 + item.length);
    }) })));
  }
  if ((m = line.match(/\\([a-zA-Z]+)$/))) {
    const q = m[1];
    return out(cur.ch - q.length, COMMANDS.filter((x) => x.startsWith(q) && x.replace(/[{[ ].*$/, '') !== q).slice(0, 40).map((x) => ({ text: x.replace('|', ''), displayText: '\\' + x.replace('|', ''), hint: (cc, data) => cc.operation(() => {
      const next = cc.getLine(data.to.line).slice(data.to.ch);
      let ins = x;
      if (next.startsWith('{') && x.includes('{')) ins = x.slice(0, x.indexOf('{')); // braces are already there
      const at = ins.indexOf('|');
      cc.replaceRange(ins.replace('|', ''), data.from, data.to);
      if (at >= 0) cc.setCursor(data.from.line, data.from.ch + at);
      if (/^(cite[pt]?|nocite|ref|eqref|pageref|begin|end)\{/.test(x)) setTimeout(showHints, 0);
    }) })));
  }
  return null;
}
function showHints() {
  const b = activeBuf();
  if (!cm || !cm.showHint || !b || b.kind !== 'text' || modeFor(b.path) !== 'stex' || W.hist.on) return;
  cm.showHint({ hint: texHint, completeSingle: false, closeCharacters: /[\s()\[\];>]/ });
}
if (cm) {
  cm.on('keyup', (c, e) => { if (!c.state.completionActive && e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey) showHints(); });
  const onCursor = debounce(() => { outlineCursor(); updateStyleName(); }, 80);
  cm.on('cursorActivity', onCursor);
}

// ---------------- spelling and writing checks (rules and word list: texlint.js) ----------------
// The problems of the open .tex file are marked in the editor a moment after each change. Which checks run is a
// setting of the project (project.checksOff); so are the words added to its dictionary.
const CK = { added: [], known: [], checker: null, dict: 'none', dictError: '', problems: [], skipped: false };
const ckOff = () => new Set((W.project && W.project.checksOff) || []);
const isTexPath = (p) => /\.(tex|ltx)$/i.test(p);
// .tex files get every check; a .bib file is checked for keys that are defined twice
const checkable = (b) => !!(cm && RT.texlint && b && b.kind === 'text' && b.doc && /\.(tex|ltx|bib)$/i.test(b.path) && !W.hist.on && W.project && !W.project.missing);
// the rules of texlint.js, and the citation keys, which need the project and the library (citeProblems below)
const ckRules = () => [...RT.texlint.RULES, ['cite', 'Citation keys (not found, defined twice)']];
const ruleName = (id) => (ckRules().find((r) => r[0] === id) || [id, id])[1];
function makeChecker() { CK.checker = RT.texlint.checker([new Set(CK.added.map((w) => w.toLowerCase())), new Set(CK.known)]); }
function resetChecks() { CK.added = []; CK.known = []; CK.checker = null; CK.problems = []; CK.skipped = false; renderCheckBadge(); }
// the project dictionary and the words of the references
async function loadSpelling() {
  const p = W.project; if (!p || p.missing || !RT.texlint) return;
  try {
    const r = await api(pUrl('/spelling', p.id));
    if (!W.project || W.project.id !== p.id) return;
    CK.added = r.words || []; CK.known = r.known || [];
    makeChecker(); runChecks();
  } catch { /* spelling then runs with the word list alone */ }
}
const spellingSoon = debounce(() => { loadSpelling(); }, 2000);
function ensureDict() { // the English word list is fetched the first time a .tex file is checked for spelling
  if (CK.dict !== 'none') return;
  if (W.tools.spell === false) { CK.dict = 'failed'; CK.dictError = 'No English word list was found on this computer, so spelling cannot be checked.'; return; }
  CK.dict = 'loading';
  RT.texlint.load().then(() => { CK.dict = 'ready'; runChecks(); }, (e) => { CK.dict = 'failed'; CK.dictError = e.message; });
}
function clearMarks(b) { for (const m of b.ckMarks || []) m.clear(); b.ckMarks = []; if (b.doc && b.doc.clearGutter) b.doc.clearGutter('ck-gutter'); }
function runChecks() {
  if (!cm) return;
  const b = activeBuf();
  if (!checkable(b)) {
    if (b && b.doc && b.ckMarks && b.ckMarks.length) cm.operation(() => clearMarks(b));
    CK.problems = []; CK.skipped = false; renderCheckBadge();
    return;
  }
  const off = ckOff(), tex = isTexPath(b.path);
  let problems = [];
  if (tex) {
    if (!off.has('spell')) ensureDict();
    if (!CK.checker) makeChecker();
    try { problems = RT.texlint.scan(bufText(b), { off: [...off], known: CK.dict === 'ready' ? CK.checker.known : null }); }
    catch (e) { console.error(e); problems = []; }
  }
  if (!off.has('cite')) {
    try { problems.push(...citeProblems(b, tex)); } catch (e) { console.error(e); }
    problems.sort((x, y) => x.from.line - y.from.line || x.from.ch - y.from.ch);
  }
  // the word or key being typed is not judged before the cursor leaves it
  const cur = cm.getCursor(), typing = cm.hasFocus() && !cm.somethingSelected();
  CK.skipped = false;
  problems = problems.filter((p) => { if (!typing || (p.type !== 'spell' && p.type !== 'cite') || p.to.line !== cur.line || p.to.ch !== cur.ch) return true; CK.skipped = true; return false; });
  cm.operation(() => {
    clearMarks(b);
    const dotted = new Set();
    for (const p of problems.slice(0, 1500)) {
      const m = b.doc.markText(p.from, p.to, { className: `cm-ck cm-ck-${p.type}`, title: p.msg });
      m.ck = p; b.ckMarks.push(m);
      if (p.type !== 'cite' || dotted.has(p.from.line) || !b.doc.setGutterMarker) continue;
      dotted.add(p.from.line); // a dot beside the line number: seen while scrolling, click it for the ways to put it right
      const dot = document.createElement('div');
      dot.className = 'ck-dot'; dot.title = p.msg;
      b.doc.setGutterMarker(p.from.line, 'ck-gutter', dot);
    }
  });
  CK.problems = problems; renderCheckBadge();
}
const checksSoon = debounce(runChecks, 600);
function renderCheckBadge() {
  const badge = $('#ck-badge'), n = CK.problems.length, sp = CK.problems.filter((p) => p.type === 'spell').length;
  badge.hidden = !n; badge.textContent = n > 99 ? '99+' : n;
  badge.className = 'cnt ' + (CK.problems.some((p) => p.type === 'spell' || p.type === 'pairs' || p.type === 'cite') ? 'bad' : 'warn');
  $('#btn-checks').title = 'Spelling and writing checks' + (n ? ` — ${sp ? `${plural(sp, 'spelling mistake')}${n > sp ? ' and ' : ''}` : ''}${n > sp ? plural(n - sp, 'other problem') : ''} in this file (F8 goes to the next one)` : '');
}
// the marks as they are now (they move with the text), in reading order
function liveMarks() {
  const b = activeBuf();
  return ((b && b.ckMarks) || []).map((m) => ({ m, r: m.find() })).filter((x) => x.r)
    .sort((a, c) => a.r.from.line - c.r.from.line || a.r.from.ch - c.r.from.ch);
}
function gotoProblem(dir) {
  if (!cm || !editor.ok()) return;
  const list = liveMarks();
  if (!list.length) return toast(checkable(activeBuf()) ? 'No problems found in this file.' : 'Spelling and writing checks run on .tex files, the citation keys on .bib files too.');
  const cur = cm.getCursor(dir > 0 ? 'to' : 'from'), cmp = (a, c) => a.line - c.line || a.ch - c.ch;
  const x = dir > 0 ? list.find((y) => cmp(y.r.from, cur) >= 0 && !(cmp(y.r.from, cm.getCursor('from')) === 0 && cm.somethingSelected())) || list[0]
    : [...list].reverse().find((y) => cmp(y.r.from, cur) < 0) || list[list.length - 1];
  cm.setSelection(x.r.from, x.r.to);
  cm.scrollIntoView({ from: x.r.from, to: x.r.to }, Math.max(60, cm.getScrollInfo().clientHeight / 3)); cm.focus();
  toast(x.m.ck.msg);
}
async function toggleCheck(id) {
  if (!needProject()) return;
  const off = ckOff();
  off.has(id) ? off.delete(id) : off.add(id);
  const r = await api(pUrl('/settings'), { method: 'PUT', json: { checksOff: [...off] } });
  applyProject({ project: r.project, files: W.files });
  runChecks();
  toast(`${ruleName(id)}: ${off.has(id) ? 'no longer checked in this project' : 'checked again'}`);
}
async function editWords(body, done) {
  const p = W.project; if (!p) return;
  const r = await api(pUrl('/spelling', p.id), { method: 'POST', json: body });
  if (!W.project || W.project.id !== p.id) return;
  CK.added = r.words || []; CK.known = r.known || [];
  makeChecker(); runChecks();
  if (done) toast(done, 'ok');
}
$('#btn-checks').addEventListener('click', (e) => {
  if (!needProject()) return;
  if (!RT.texlint) return toast('The writing checks could not be loaded.', 'bad');
  const off = ckOff(), n = CK.problems.length, can = checkable(activeBuf());
  const spellNote = CK.dict === 'failed' ? 'no word list' : CK.dict === 'loading' ? 'loading…' : '';
  menu(e.currentTarget, [
    { head: !can ? 'Checks run on .tex and .bib files' : n ? `${plural(n, 'problem')} in this file` : 'No problems in this file' },
    { label: 'Next problem', icon: 'chevDown', hint: 'F8', disabled: !n, run: () => gotoProblem(1) },
    { label: 'Previous problem', icon: 'up', hint: MAC ? '⇧F8' : 'Shift+F8', disabled: !n, run: () => gotoProblem(-1) },
    { head: 'Check this project for' },
    ...ckRules().map(([id, label]) => ({ label, check: !off.has(id), hint: id === 'spell' ? spellNote : '', title: id === 'spell' && CK.dict === 'failed' ? CK.dictError : '', run: () => toggleCheck(id) })),
    { sep: true },
    { label: 'Check the references…', icon: 'cite', title: 'Citations without an entry, keys defined twice, entries never cited or incomplete - in the whole project', run: refsDialog },
    { label: 'Project dictionary…', icon: 'bib', run: dictionaryDialog },
  ], { right: true });
});
// the words added for this project: add, remove
function dictionaryDialog() {
  const { d } = openDialog(`<form method="dialog"><h3>Project dictionary</h3>
    <p class="muted dlg-msg">Words the spelling check accepts in this project. The names and title words of your references are accepted anyway.</p>
    <div class="dw-add"><input type="text" id="dw-new" placeholder="Add a word" spellcheck="false" autocomplete="off" aria-label="Word to add"><button type="button" class="ib" id="dw-add" title="Add the word" aria-label="Add the word">${ic('plus')}</button></div>
    <div id="dw-list" class="dw-list"></div>
    ${dlgActions({ okText: 'Done', cancel: false })}</form>`, () => true, 'dw-dlg');
  const list = $('#dw-list', d), inp = $('#dw-new', d);
  const render = () => {
    list.innerHTML = CK.added.map((w) => `<span class="dw-word">${esc(w)}<button type="button" class="ghost" data-w="${esc(w)}" title="Remove “${esc(w)}”" aria-label="Remove ${esc(w)}">${ic('close')}</button></span>`).join('')
      || '<div class="muted">No words yet. Right-click an underlined word in the editor and choose “Add to the project dictionary”, or type one above.</div>';
  };
  const add = async () => {
    const w = inp.value.trim(); if (!w) return;
    try { await editWords({ add: [w] }); inp.value = ''; render(); } catch (e) { toast(e.message, 'bad'); }
    inp.focus();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  $('#dw-add', d).addEventListener('click', add);
  list.addEventListener('click', async (e) => {
    const x = e.target.closest('button[data-w]'); if (!x) return;
    try { await editWords({ remove: [x.dataset.w] }); render(); } catch (err) { toast(err.message, 'bad'); }
  });
  render(); inp.focus();
}
if (cm) {
  // right-click on an underlined place: what is wrong, the ways to put it right, and how to stop being told
  cm.on('contextmenu', (c, e) => {
    const pos = c.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    if (pos.outside) return;
    const m = c.findMarksAt(pos).find((x) => x.ck), r = m && m.find();
    if (!r) return;
    e.preventDefault();
    if (m.ck.type === 'cite') return citeMenu(m, { x: e.clientX, y: e.clientY });
    const p = m.ck, items = [{ note: p.msg }];
    const put = (text, from = r.from, to = r.to) => { c.replaceRange(text, from, to); c.focus(); };
    if (p.type === 'spell') {
      const word = c.getRange(r.from, r.to), sug = CK.checker ? CK.checker.suggest(word) : [];
      items.push(...(sug.length ? sug.map((x) => ({ label: x, run: () => put(x) })) : [{ label: 'No suggestions', disabled: true }]),
        { sep: true }, { label: `Add “${word}” to the project dictionary`, icon: 'plus', run: () => editWords({ add: [word] }, `“${word}” is now accepted in this project`) });
    } else if (p.type === 'repeat') {
      items.push({ label: 'Remove the repeated word', icon: 'trash', run: () => { // from the end of the word before, which may be on the line above
        let from = r.from; const before = c.getLine(from.line).slice(0, from.ch);
        if (before.trim()) from = { line: from.line, ch: before.trimEnd().length };
        else if (from.line > 0) from = { line: from.line - 1, ch: c.getLine(from.line - 1).trimEnd().length };
        put('', from, r.to);
      } });
    } else if (p.type === 'tie') items.push({ label: 'Put ~ in place of the space', icon: 'check', run: () => put('~') });
    else if (p.type === 'quotes') items.push(...[p.fix.text, p.fix.text === '``' ? "''" : '``'].map((q, k) => ({ label: `Change to ${q}  (${q === '``' ? 'opening' : 'closing'} quotation mark)`, icon: k ? '' : 'check', run: () => put(q) })));
    items.push({ sep: true }, { label: `Stop checking: ${ruleName(p.type).toLowerCase()}`, title: 'Switches this check off for this project. The checks button in the toolbar turns it on again.', run: () => toggleCheck(p.type) });
    menu({ x: e.clientX, y: e.clientY }, items);
  });
  cm.on('cursorActivity', () => { if (CK.skipped) checksSoon(); });
  // the dot beside a line number: the menu of the first citation problem on that line
  cm.on('gutterClick', (c, line, gutter, e) => {
    if (gutter !== 'ck-gutter') return;
    const x = liveMarks().find((y) => y.m.ck.type === 'cite' && y.r.from.line === line);
    if (!x) return;
    const at = { x: e.clientX + 8, y: e.clientY + 8 };
    // after this mouse press has run its course: it closes open menus and places the cursor
    setTimeout(() => { const r = x.m.find(); if (!r) return; c.setSelection(r.from, r.to); citeMenu(x.m, at); }, 0);
  });
}

// ---------------- references: undefined and duplicate keys in the editor, the references check ----------------
// W.refs is what the server knows about the saved files (GET /refs): the keys the project's own .bib files and
// \bibitem lines define, and whether the library supplies entries (the app writes references.bib). The open file
// is scanned as it is typed (refscan.js), so a mark appears and goes without waiting for a save or a compile.
let refsSeq = 0;
async function loadRefs() {
  const p = W.project; if (!p || p.missing) return null;
  const seq = ++refsSeq;
  try {
    const r = await api(pUrl('/refs', p.id));
    if (seq !== refsSeq || !W.project || W.project.id !== p.id) return null;
    W.refs = r; runChecks();
    loadPapers(true); // what is cited may have changed
    return r;
  } catch { return null; } // the marks then stay as they were
}
const refsSoon = debounce(() => { loadRefs(); }, 1200);
const libEntry = (i) => ({ key: i.citekey, title: `${authorsShort(i.fields.author)} ${i.fields.year || ''}`, sub: i.fields.title || '' });
function citeProblems(b, tex) {
  const R = W.refs, S = RT.refscan;
  if (!R || !S) return [];
  const text = bufText(b), lib = libItems(), out = [];
  const span = (u) => ({ from: { line: u.line, ch: u.ch }, to: { line: u.line, ch: u.ch + u.len } });
  const libLoaded = lib.length > 0 || !R.counts.libraryEntries; // never call every key undefined because the list is not there yet
  if (tex) {
    if (R.library && !libLoaded) return [];
    if (R.outside && R.outside.length) return []; // a .bib file from outside the project is loaded: its keys are not known here
    const known = new Set(R.defs.filter((d) => d.file !== b.path).map((d) => d.key));
    for (const i of S.bibitems(text)) known.add(i.key);
    const inLib = new Set(lib.map((i) => i.citekey));
    if (R.library) for (const k of inLib) known.add(k);
    for (const u of S.cites(text).uses) {
      if (known.has(u.key)) continue;
      const twin = [...known].find((k) => k.toLowerCase() === u.key.toLowerCase());
      const msg = twin ? `“${u.key}” is written “${twin}” where it is defined. BibTeX accepts either spelling, biber does not - better use the same one.`
        : !R.library && inLib.has(u.key) ? `“${u.key}” is in your library, but this project uses its own .bib file, and that has no entry with this key.`
        : `No reference has the key “${u.key}”${R.library ? (R.defs.length ? ' - neither your library nor the .bib files of this project.' : ' in your library.') : ' in the .bib files of this project.'}`;
      out.push({ type: 'cite', kind: 'undefined', key: u.key, msg, ...span(u) });
    }
    return out;
  }
  if (b.path === R.generated) return []; // written by the app
  const mine = S.bibKeys(text), first = new Map(), seen = new Map();
  for (const e of mine) { const l = e.key.toLowerCase(); seen.set(l, (seen.get(l) || 0) + 1); if (!first.has(l)) first.set(l, e); }
  const other = new Map();
  if (R.library && libLoaded) for (const i of lib) other.set(String(i.citekey).toLowerCase(), { library: true });
  for (const d of R.defs) if (d.file !== b.path && /\.bib$/i.test(d.file)) other.set(d.key.toLowerCase(), { file: d.file, line: d.line });
  for (const e of mine) {
    const l = e.key.toLowerCase();
    let where = null;
    if (seen.get(l) > 1) { const o = first.get(l) === e ? mine.find((x) => x !== e && x.key.toLowerCase() === l) : first.get(l); where = { file: b.path, line: o.line + 1, same: true }; }
    else where = other.get(l) || null;
    if (!where) continue;
    const at = where.library ? 'in your library, which references.bib is written from' : where.same ? `on line ${where.line}` : `in ${where.file} (line ${where.line})`;
    out.push({ type: 'cite', kind: 'duplicate', key: e.key, other: where, msg: `The key “${e.key}” is defined more than once: also ${at}. BibTeX keeps one entry and reports the other as an error.`, ...span(e) });
  }
  return out;
}
// the entries a citation can use in this project: the library (when it supplies references.bib) and the own .bib files
function citeChoices() {
  const R = W.refs, items = [], have = new Set();
  if (!R || R.library) for (const i of libItems()) { have.add(i.citekey); items.push(libEntry(i)); }
  for (const d of (R && R.defs) || []) if (!have.has(d.key)) { have.add(d.key); items.push({ key: d.key, title: '', sub: `${d.file}:${d.line}` }); }
  return items;
}
// replace the key at range() with an entry picked from a searchable list
function pickEntry(anchor, range, wrong) {
  const items = citeChoices();
  pickList(anchor, { placeholder: `Search for the entry that “${wrong}” should be…`, empty: items.length ? 'Nothing found.' : 'There is no reference to choose from - add papers in the Library tab.', items,
    onPick: (it) => { const r = range(); if (!r || !cm) return; cm.replaceRange(it.key, r.from, r.to); cm.focus(); } });
}
function citeMenu(m, at) {
  const p = m.ck, r = m.find(); if (!r) return;
  const items = [{ note: p.msg }];
  if (p.kind === 'undefined') {
    const choices = citeChoices(), byKey = new Map(choices.map((c) => [c.key, c]));
    for (const k of RT.refscan.near(p.key, choices.map((c) => c.key))) {
      const c = byKey.get(k), what = [c.title.trim(), c.sub].filter(Boolean).join(' — ');
      items.push({ label: `Change to ${k}${what ? `  (${what.length > 44 ? what.slice(0, 42) + '…' : what})` : ''}`, icon: 'check', run: () => { const x = m.find(); if (x) { cm.replaceRange(k, x.from, x.to); cm.focus(); } } });
    }
    const xy = cm.cursorCoords(r.from, 'window');
    items.push({ label: W.refs && !W.refs.library ? 'Pick an entry of this project…' : 'Pick an entry from the library…', icon: 'cite', run: () => pickEntry({ x: xy.left, y: xy.bottom + 4 }, () => m.find(), p.key) });
  } else if (p.other && !p.other.library) {
    items.push({ label: p.other.same ? `Go to the other entry (line ${p.other.line})` : `Open the other entry in ${baseName(p.other.file)}`, icon: 'arrowRight', run: () => gotoLine(p.other.file, p.other.line) });
  }
  items.push({ sep: true }, { label: 'Check the references of the project…', icon: 'bib', run: refsDialog },
    { label: 'Stop checking citation keys', title: 'Switches this check off for this project. The checks button in the toolbar turns it on again.', run: () => toggleCheck('cite') });
  menu(at, items);
}

// The references check: where references.bib comes from and what it holds, then every citation problem of the project.
async function refsDialog() {
  if (!needProject()) return;
  const pid = W.project.id;
  const { d } = openDialog(`<form method="dialog"><h3>References</h3><div id="rf-body" class="rf-body"><p class="muted"><span class="spin"></span> Checking the references…</p></div>
    ${dlgActions({ okText: 'Done', cancel: false })}</form>`, () => true, 'rf-dlg');
  const body = $('#rf-body', d);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const loc = (file, line) => `<span class="rf-at">${esc(file)}:${line}</span>`;
  const section = (title, hint, total, rows) => (!total ? '' : `<h4>${esc(title)} <span class="cnt">${total}</span></h4>${hint ? `<p class="muted rf-hint">${hint}</p>` : ''}<div class="rf-list">${rows.join('')}</div>${total > rows.length ? `<p class="muted rf-hint">… and ${total - rows.length} more.</p>` : ''}`);
  let R = null;
  const render = () => {
    const c = R.counts, gen = R.referencesState !== 'own' && R.library;
    let src;
    if (R.referencesState === 'own') src = `<p class="rf-src">This project has a <code>${esc(R.referencesFile || 'references.bib')}</code> of its own. The app leaves it as it is.</p>`;
    else if (!gen) src = '<p class="rf-src">This project takes its references from its own .bib files or a hand-written list, not from your library.</p>';
    else {
      src = `<p class="rf-src"><code>${esc(R.referencesFile || 'references.bib')}</code> is written from your library before every compile. It holds:</p>
        <label class="check"><input type="radio" name="rf-scope" value="cited"${R.scope === 'all' || R.scope === 'project' ? '' : ' checked'}> Only the papers this project cites <span class="muted">(${c.citedOnly ?? c.citedInLibrary} of ${c.libraryEntries})</span></label>
        <label class="check"><input type="radio" name="rf-scope" value="project"${R.scope === 'project' ? ' checked' : ''}> Cited + this project's papers <span class="muted">(${R.scope === 'project' ? `${c.citedInLibrary} of ${c.libraryEntries}` : count(PP.data ? PP.data.counts.total : 0, 'paper', 'papers') + ' in the project'})</span></label>
        <label class="check"><input type="radio" name="rf-scope" value="all"${R.scope === 'all' ? ' checked' : ''}> The whole library <span class="muted">(${count(c.libraryEntries, 'entry', 'entries')})</span></label>
        ${R.nociteAll ? '<p class="muted rf-hint"><code>\\nocite{*}</code> is in the project, so every entry of the library is included either way.</p>' : ''}
        ${!R.loadsBib ? '<p class="muted rf-hint">No .tex file loads a bibliography yet. Put <code>\\bibliographystyle{plain}</code> and <code>\\bibliography{references}</code> before <code>\\end{document}</code> and the file is written at the next compile.</p>' : ''}`;
    }
    const pickBtn = (u) => `<button type="button" class="ib" data-pick title="Pick the entry this key should be" aria-label="Pick the entry for ${esc(u.key)}">${ic('cite')}</button>`;
    const parts = [
      section('Cited, but there is no such entry', 'LaTeX prints these as [?]. Click one to go to the place.', c.undefined, R.undefined.map((u, n) => {
        const f = u.uses[0];
        return `<div class="rf-row" data-go="u${n}" tabindex="0" role="button"><code>${esc(u.key)}</code>${u.count > 1 ? `<span class="muted">${u.count}×</span>` : ''}${loc(f.file, f.line)}${u.suggest.length ? `<span class="muted rf-more">Did you mean ${esc(u.suggest[0])}?</span>` : ''}${pickBtn(u)}</div>`;
      })),
      section('Defined more than once', 'BibTeX keeps one entry and reports the others as errors.', c.duplicates, R.duplicates.map((u, n) => {
        const w = u.where.map((x) => (x.library ? 'your library' : `${esc(x.file)}:${x.line}`)).join(', ');
        return `<div class="rf-row" data-go="d${n}" tabindex="0" role="button"><code>${esc(u.key)}</code><span class="rf-at">${w}</span></div>`;
      })),
      section('Cited, but incomplete', 'Worth a look before you submit.', c.incomplete, R.incomplete.map((u, n) => `<div class="rf-row" data-go="i${n}" tabindex="0" role="button" title="${u.library ? 'Show the paper in the Library' : 'Go to the entry'}"><code>${esc(u.key)}</code><span class="rf-at">${esc(u.issues.join('; '))}</span>${u.library ? `<span class="muted rf-more">${esc(u.title || '')}</span>` : loc(u.file, u.line)}</div>`)),
      section('Never cited', 'Entries of your own .bib files that no .tex file cites.', c.unused, R.unused.map((u, n) => `<div class="rf-row" data-go="n${n}" tabindex="0" role="button"><code>${esc(u.key)}</code>${loc(u.file, u.line)}</div>`)),
    ].join('');
    const out = (R.outside || []).length ? `<p class="muted rf-hint">This project also loads ${R.outside.slice(0, 5).map((f) => `<code>${esc(f)}</code>`).join(', ')}${R.outside.length > 5 ? ' and more' : ''}, which ${R.outside.length > 1 ? 'are not files' : 'is not a file'} of this project (or ${R.outside.length > 1 ? 'are' : 'is'} too large to read here). The app cannot see ${R.outside.length > 1 ? 'their' : 'its'} keys, so citations without an entry are not looked for.</p>` : '';
    const fine = parts ? '' : `<p class="rf-ok">${ic('check')} ${c.cited ? `${count(c.cited, 'key is', 'keys are')} cited in this project${(R.outside || []).length ? ', and nothing else stands out.' : ', and every one has an entry.'}` : 'This project does not cite anything yet. Use the cite button of the toolbar, or type <code>\\cite{</code> and pick a key.'}</p>`;
    body.innerHTML = src + out + parts + fine;
  };
  const load = async () => {
    try {
      await flushAll();
      const r = await api(pUrl('/refs', pid));
      if (!d.isConnected) return;
      R = r;
      if (W.project && W.project.id === pid) { W.refs = r; runChecks(); }
      render();
    } catch (e) { if (d.isConnected) body.innerHTML = `<p class="rf-err">The references could not be checked: ${esc(e.message)}</p>`; }
  };
  body.addEventListener('change', async (e) => {
    if (e.target.name !== 'rf-scope' || !W.project || W.project.id !== pid) return;
    const scope = e.target.value;
    for (const x of $$('input[name=rf-scope]', body)) x.disabled = true;
    try {
      const r = await api(pUrl('/settings', pid), { method: 'PUT', json: { bibScope: scope } });
      applyProject({ project: r.project, files: W.files });
      toast(scope === 'all' ? 'references.bib will hold your whole library' : scope === 'project' ? 'references.bib will hold the cited papers and the papers of this project' : 'references.bib will hold only the papers this project cites', 'ok');
      compile(); // writes the file anew
    } catch (err) { toast(err.message, 'bad'); }
    await load();
  });
  const act = (row, pick) => {
    if (!row || !R) return;
    const kind = row.dataset.go[0], u = { u: R.undefined, d: R.duplicates, i: R.incomplete, n: R.unused }[kind][Number(row.dataset.go.slice(1))];
    if (!u) return;
    d.close();
    (async () => {
      if (kind === 'u') {
        const f = u.uses[0];
        await gotoLine(f.file, f.line, f.col, f.len);
        if (!pick || !cm) return;
        await new Promise((res) => setTimeout(res, 40)); // gotoLine places the cursor a moment later
        const from = { line: f.line - 1, ch: f.col - 1 }, sel = { from, to: { line: from.line, ch: from.ch + f.len } };
        if (W.active !== f.file || cm.getRange(sel.from, sel.to) !== u.key) return; // the text has changed meanwhile
        const xy = cm.cursorCoords(from, 'window');
        pickEntry({ x: xy.left, y: xy.bottom + 4 }, () => (cm.getRange(sel.from, sel.to) === u.key ? sel : null), u.key);
      } else if (kind === 'd') { const w = u.where.find((x) => !x.library); if (w) await gotoLine(w.file, w.line); }
      else if (kind === 'i' && u.library) { RT.setView('library'); if (RT.library && RT.library.select) RT.library.select(u.id); }
      else await gotoLine(u.file, u.line);
    })().catch((err) => toast(err.message, 'bad'));
  };
  body.addEventListener('click', (e) => { if (!e.target.closest('input, label')) act(e.target.closest('.rf-row'), !!e.target.closest('[data-pick]')); });
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('rf-row')) { e.preventDefault(); act(e.target, false); } });
  await load();
}

// ---------------- the papers of the project ----------------
// The Library adds papers to a project (project-papers.js; stored in settings.json projectSettings[pid].papers). Here
// they are listed with what the project does with them - cited or not, read, noted - and \cite, the annotated
// bibliography and the reading pack are made from them. The cite picker and the \cite{ completion list them first.
const memberRows = () => (PP.data && W.project && PP.pid === W.project.id ? PP.data.papers.filter((r) => r.citekey) : []);
const citeMark = (r) => (r.cited ? 'cited' : r.status === 'done' ? 'not cited' : r.status === 'reading' ? 'reading' : 'to read');
const STATUS_NAME = { unread: 'Not read yet', reading: 'Reading', done: 'Read' };
async function loadPapers(force) {
  const p = W.project; if (!p) return null;
  if (!force && PP.pid === p.id && PP.data) return PP.data;
  const seq = ++PP.seq;
  try {
    // through the cache of project-papers.js when it is there, so that the Library's pinned group shares the request
    const r = await (RT.projectPapers && RT.projectPapers.papers ? RT.projectPapers.papers(p.id, { fresh: true }) : api(pUrl('/papers', p.id)));
    if (seq === PP.seq && W.project && W.project.id === p.id) { PP.pid = p.id; PP.data = r; }
  } catch { /* keep what was loaded */ }
  return PP.data;
}
// add or remove papers (never deletes one); through project-papers.js when it is there (toast with Undo, event)
async function editMembers(pid, ids, on) {
  // (its 'projects:changed' {ids} reloads the rows, see the end of this file)
  if (RT.projectPapers && RT.projectPapers.toggle) await RT.projectPapers.toggle(ids, { pid, on });
  else {
    await api(pUrl('/papers', pid), { method: 'POST', json: on ? { add: ids } : { remove: ids } });
    RT.emit('projects:changed', { pid, ids, on });
    const name = (W.project && W.project.id === pid && W.project.name) || 'the project';
    toast(`${on ? 'Added' : 'Removed'} ${plural(ids.length, 'paper')} ${on ? 'to' : 'from'} “${name}”`, 'ok', { label: 'Undo', run: () => editMembers(pid, ids, !on).catch((e) => toast(e.message, 'bad')) });
  }
}
let ppDlg = null; // the open Papers dialog {d, pid}
async function papersDialog() {
  if (!W.project || ppDlg) return;
  const p = W.project;
  const { d, result } = openDialog(`<form method="dialog"><h3>Papers of “${esc(p.name)}”</h3>
    <div id="pp-body" class="pp-body"><p class="muted"><span class="spin"></span> Loading the papers…</p></div>
    <div class="pp-tools">
      <button type="button" data-pp="annotated" title="Insert a LaTeX description list at the cursor: the \\cite of each paper of this project with its brief and key points (no AI; ${MOD}Z takes it out)">${ic('cite')}<span>Insert annotated bibliography</span></button>
      <button type="button" data-pp="pack" title="Write reading-list.md, references.bib and the notes of these papers into the export folder">${ic('download')}<span>Export reading pack</span></button>
      <button type="button" data-pp="pack-zip" title="Download the reading pack as one .zip: reading-list.md, references.bib and a package per paper (its note with the pictures, PDF, BibTeX and links)">${ic('zip')}<span>Download as .zip</span></button>
    </div>
    ${dlgActions({ okText: 'Done', cancel: false })}</form>`, () => true, 'pp-dlg');
  ppDlg = { d, pid: p.id };
  result.then(() => { if (ppDlg && ppDlg.d === d) ppDlg = null; });
  d.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pp]'); if (!b || b.disabled) return;
    const row = b.closest('[data-id]');
    ppAction(b.dataset.pp, row && row.dataset.id, b).catch((err) => { b.disabled = false; toast(err.message, 'bad'); });
  });
  paintPapers();
  await loadPapers(true);
  paintPapers();
}
function paintPapers() {
  if (!ppDlg || !ppDlg.d.isConnected) return;
  const body = $('#pp-body', ppDlg.d), D = PP.pid === ppDlg.pid ? PP.data : null;
  if (!D) return;
  const c = D.counts, rows = D.papers;
  const btn = (act, title, face, dis = false) => `<button type="button" class="ib" data-pp="${act}" title="${esc(title)}" aria-label="${esc(title)}"${dis ? ' disabled' : ''}>${face}</button>`;
  const row = (r) => `<div class="pp-row" data-id="${esc(r.id)}">
      <span class="pp-dot st-${esc(r.status)}" title="${esc(STATUS_NAME[r.status] || '')}"></span>
      <span class="pp-main"><span class="pp-title" title="${esc(r.title)}">${esc(r.title || r.citekey)}</span>
        <span class="muted pp-sub">${r.citekey ? `<code>${esc(r.citekey)}</code> ` : ''}${r.author ? `<span class="au">${esc(r.author)}</span> ` : ''}${esc(r.year || '')}</span></span>
      <span class="pp-cited${r.cited ? ' on' : ''}">${r.cited ? (r.citedCount ? `cited ${r.citedCount}×` : 'cited') : 'not cited'}</span>
      <span class="badge pp-note${r.hasNote ? ' on' : ''}" title="${r.hasNote ? 'Has a reading note' : 'No reading note yet'}">${r.hasNote ? 'note' : 'no note'}</span>
      <span class="pp-hl muted" title="${plural(r.highlights, 'highlight')}">${r.highlights ? r.highlights + ' hl' : ''}</span>
      <span class="pp-acts">${btn('cite', r.citekey ? `Insert \\cite{${r.citekey}} at the cursor` : 'This paper has no cite key', ic('cite'), !r.citekey)}${btn('open', 'Open in the Library', ic('open'))}${btn('remove', 'Remove from this project (the paper stays in the library)', ic('minus'))}</span>
    </div>`;
  const sum = [plural(c.total, 'paper'), `${c.toRead} to read`, `${c.reading} reading`, `${c.done} done`, `${c.cited} cited`, `${c.noNote} without a note`, c.due ? plural(c.due, 'question') + ' due' : ''].filter(Boolean).join(' · ');
  const risk = rows.filter((r) => r.cited && (r.status !== 'done' || !r.hasNote));
  const flag = (r, why, add) => `<div class="pp-row pp-flag" data-id="${esc(r.id)}"><span class="pp-main"><span class="pp-title" title="${esc(r.title || '')}">${esc(r.title || r.citekey)}</span><span class="muted pp-sub">${r.citekey ? `<code>${esc(r.citekey)}</code> ` : ''}${esc(why)}</span></span>
      <span class="pp-acts">${add ? btn('add', 'Add this paper to the project', ic('plus')) : ''}${btn('open', 'Open in the Library', ic('open'))}</span></div>`;
  body.innerHTML = (rows.length ? `<p class="muted pp-sum">${esc(sum)}</p><div class="pp-list">${rows.map(row).join('')}</div>`
    : `<p class="pp-empty">No papers in this project yet. In the Library, press the project button next to a paper's star (or right-click papers) to add them to “${esc(D.project.name)}”.</p>`)
    + (D.citedNotMember.length ? `<h4>Cited but not in this project <span class="cnt">${D.citedNotMember.length}</span>${D.citedNotMember.length > 1 ? '<button type="button" class="ghost pp-addall" data-pp="addall" title="Add every one of them to the project">Add all</button>' : ''}</h4>
      <div class="pp-list">${D.citedNotMember.map((x) => flag(x, 'cited in the .tex files', true)).join('')}</div>` : '')
    + (risk.length ? `<h4>Cited but not read yet / no note <span class="cnt">${risk.length}</span></h4><p class="muted pp-hint">Worth a read before you rely on them.</p>
      <div class="pp-list">${risk.map((r) => flag(r, [r.status !== 'done' ? (r.status === 'reading' ? 'still reading' : 'not read yet') : '', r.hasNote ? '' : 'no note'].filter(Boolean).join(', '))).join('')}</div>` : '')
    + (D.nociteAll ? '<p class="muted pp-hint"><code>\\nocite{*}</code> is in the project: every entry of the library goes into its bibliography.</p>' : '');
  for (const b of $$('[data-pp=annotated], [data-pp=pack]', ppDlg.d)) b.disabled = !rows.length;
}
// the cursor was never put anywhere: it sits before \\documentclass, where nothing should be inserted
const unplaced = () => { const c = cm.getCursor(); return c.line === 0 && c.ch === 0 && !cm.somethingSelected() && cm.lineCount() > 1; };
async function ppAction(act, id, b) {
  const pid = ppDlg.pid, d = ppDlg.d, D = PP.data;
  const r = D && id ? D.papers.find((x) => x.id === id) || D.citedNotMember.find((x) => x.id === id) : null;
  if (act === 'cite') {
    d.close(); // back to the editor: the cursor is where it was
    if (!r || !cm || !W.project || W.project.id !== pid || !editor.ok()) return;
    if (unplaced()) return toast(`Click in the text where the citation goes, then cite again (the cursor is still at the start of the file).`, 'bad');
    editor.insert(`\\cite{${r.citekey}}`);
  } else if (act === 'open') {
    d.close();
    RT.setView('library'); if (RT.library && RT.library.select) RT.library.select(id);
  } else if (act === 'remove' || act === 'add') { b.disabled = true; await editMembers(pid, [id], act === 'add'); }
  else if (act === 'addall') { b.disabled = true; await editMembers(pid, D.citedNotMember.map((x) => x.id), true); }
  else if (act === 'annotated') {
    b.disabled = true;
    const a = await api(pUrl('/annotated', pid), { method: 'POST', json: {} });
    b.disabled = false;
    if (!a.keys.length) return toast('None of the papers of this project has a cite key.', 'bad');
    const buf = activeBuf();
    if (!cm || !buf || buf.kind !== 'text' || !isTexPath(buf.path) || W.hist.on || !W.project || W.project.id !== pid) return toast('Open a .tex file in the editor first, with the cursor where the bibliography should go.', 'bad');
    if (unplaced()) return toast('Click in the text where the bibliography should go first (the cursor is still at the start of the file).', 'bad');
    d.close();
    cm.setCursor(cm.getCursor('to')); // never over a selection
    insertBlock(a.latex.replace(/\n+$/, '').split('\n')); // one change: undo takes it out
    toast(`Inserted an annotated bibliography of ${plural(a.keys.length, 'paper')} — ${MOD}Z takes it out again.`, 'ok');
  } else if (act === 'pack-zip') {
    b.disabled = true;
    try { await RT.projectPapers.readingPackZip(pid); } finally { b.disabled = false; }
  } else if (act === 'pack') {
    b.disabled = true;
    try {
      const k = await api(pUrl('/reading-pack', pid), { method: 'POST', json: {} });
      toast(`Reading pack written to ${k.dir} (${plural(k.files.length, 'file')})`, 'ok');
    } finally { b.disabled = false; }
  }
}

// ---------------- the Library panel (icon rail, Shift+Cmd+L) ----------------
// The whole library beside the editor, from RT.library.items(): the papers of this project first (marked), then one
// group per research line / sub-line (categories "Line / Sub-line"), each row with title, authors, year and cite key.
// Click selects (several at once), double-click / the cite button / a drag into the text inserts \cite{a,b} - at the
// cursor, never at the untouched start of the file (unplaced()) and never before \documentclass.
const WL = { sel: new Set(), q: '', seq: 0 };
const libOpen = () => !$('#side-lib').hidden && !$('#side').hidden;
const UNCAT_NAME = 'Uncategorized';
const lineName = (c) => (RT.categories && RT.categories.lineOf ? RT.categories.lineOf(c) : c.split(' / ')[0]);
const subName = (c) => (RT.categories && RT.categories.subOf ? RT.categories.subOf(c) : c.split(' / ').slice(1).join(' / '));
const inProject = (id) => {
  if (!W.project) return false;
  if (PP.data && PP.pid === W.project.id) return PP.data.papers.some((r) => r.id === id);
  return !!(RT.projectPapers && RT.projectPapers.has && RT.projectPapers.has(id, W.project.id));
};
const WL_MAX = 400; // rows drawn at once; the search narrows the rest
function renderLib() {
  const list = $('#wl-list'); if (!list || !libOpen()) return;
  const all = libItems(), q = WL.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const id of [...WL.sel]) if (!all.some((i) => i.id === id)) WL.sel.delete(id);
  const hay = (i) => [i.fields.title, i.fields.author, i.fields.year, i.citekey, i.category].join(' ').toLowerCase();
  const hits = q.length ? all.filter((i) => { const h = hay(i); return q.every((w) => h.includes(w)); }) : all;
  const byTitle = (a, b) => String(a.fields.title || '').localeCompare(String(b.fields.title || ''), undefined, { sensitivity: 'base' });
  const mine = hits.filter((i) => inProject(i.id)).sort(byTitle);
  const rest = hits.filter((i) => !inProject(i.id));
  // groups: line -> sub-line ('' = filed under the line itself) -> papers; Uncategorized last
  const lines = new Map();
  for (const i of rest) {
    const c = i.category || UNCAT_NAME, l = c === UNCAT_NAME ? UNCAT_NAME : lineName(c), sub = c === UNCAT_NAME ? '' : subName(c);
    if (!lines.has(l)) lines.set(l, new Map());
    const m = lines.get(l); if (!m.has(sub)) m.set(sub, []); m.get(sub).push(i);
  }
  const cmp = (a, b) => (a === UNCAT_NAME) - (b === UNCAT_NAME) || a.localeCompare(b, undefined, { sensitivity: 'base' });
  let n = 0;
  const row = (i, proj) => {
    if (n++ >= WL_MAX) return '';
    const f = i.fields || {}, key = i.citekey || '', sel = WL.sel.has(i.id), au = authorsShort(f.author || '');
    const b = (act, title, face, dis) => `<button type="button" class="ib" data-wl="${act}" title="${esc(title)}" aria-label="${esc(title)}"${dis ? ' disabled' : ''}>${face}</button>`;
    const pj = W.project ? (proj ? b('remove', 'Remove from this project (the paper stays in the library)', ic('minus')) : b('add', 'Add to this project', ic('plus'))) : '';
    return `<div class="wl-row${sel ? ' sel' : ''}${proj ? ' in-proj' : ''}" data-id="${esc(i.id)}" role="option" aria-selected="${sel}" tabindex="-1" draggable="${key ? 'true' : 'false'}">
      <input type="checkbox" class="wl-check" tabindex="-1"${sel ? ' checked' : ''}${key ? '' : ' disabled'} aria-label="Select">
      <span class="wl-main"><span class="wl-title" data-i18n-skip title="${esc(f.title || '')}">${proj ? `<span class="wl-mark" title="In this project">${RT.icon(RT.projectPapers ? RT.projectPapers.ICON : 'bookmark')}</span>` : ''}${esc(f.title || key || '(no title)')}</span>
        <span class="wl-sub muted"><span data-i18n-skip>${esc(au)}</span>${f.year ? ` <span data-i18n-skip>${esc(f.year)}</span>` : ''}${key ? ` <code data-i18n-skip>${esc(key)}</code>` : ' <span class="wl-nokey">no cite key</span>'}</span></span>
      <span class="wl-acts">${b('cite', key ? `Insert \\cite{${key}} at the cursor` : 'This paper has no cite key', ic('cite'), !key)}${pj}${b('open', 'Open in the Library reader', ic('open'))}</span>
    </div>`;
  };
  let html = '';
  if (mine.length) html += `<div class="wl-head wl-proj">${RT.icon(RT.projectPapers ? RT.projectPapers.ICON : 'bookmark')}<span>In this project</span> <span class="cnt">${mine.length}</span></div>${mine.map((i) => row(i, true)).join('')}`;
  for (const l of [...lines.keys()].sort(cmp)) {
    const subs = lines.get(l), total = [...subs.values()].reduce((a, x) => a + x.length, 0);
    const dot = RT.categories && RT.categories.color ? `<span class="wl-dot" style="background:${esc(RT.categories.color(l))}"></span>` : '';
    html += `<div class="wl-head">${dot}<span${l === UNCAT_NAME ? '' : ' data-i18n-skip'}>${esc(l)}</span> <span class="cnt">${total}</span></div>`;
    for (const sub of [...subs.keys()].sort((a, b) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      const ps = subs.get(sub).sort(byTitle);
      if (sub) html += `<div class="wl-head wl-subhead"><span data-i18n-skip>${esc(sub)}</span> <span class="cnt">${ps.length}</span></div>`;
      html += ps.map((i) => row(i, false)).join('');
    }
  }
  if (n > WL_MAX) html += `<div class="muted wl-note">${esc(`${n - WL_MAX} more - search to narrow the list`)}</div>`;
  list.innerHTML = html || `<div class="muted wl-note">${all.length ? 'No paper matches.' : 'Your library is empty — import references in the Library tab.'}</div>`;
  paintLibBar();
}
function paintLibBar() {
  const n = WL.sel.size;
  $('#wl-bar').hidden = !n;
  $('#wl-n').textContent = `${plural(n, 'paper')} selected`;
}
const libKeys = (ids) => { const items = libItems(); return ids.map((id) => (items.find((i) => i.id === id) || {}).citekey).filter(Boolean); };
// the keys of the selected papers in the order of the list
const selectedIds = () => $$('#wl-list .wl-row.sel').map((r) => r.dataset.id).concat([...WL.sel].filter((id) => !$(`#wl-list .wl-row[data-id="${CSS.escape(id)}"]`)));
// where \documentclass stands in the open file, or null when it has none
function docclassAt() {
  const n = cm.lineCount();
  for (let l = 0; l < Math.min(n, 400); l++) {
    if (/^[^%]*\\documentclass\b/.test(cm.getLine(l))) return { line: l };
  }
  return null;
}
// before \documentclass or on its line (the preamble's first line takes no text)
const beforeDocclass = (pos) => { const d = docclassAt(); return !!d && pos.line <= d.line; };
// after \end{document} (LaTeX ignores what follows it): its line from the \end on, and every line below
function afterEnddoc(pos) {
  if (!docclassAt()) return false;
  for (let l = cm.lineCount() - 1; l >= 0; l--) {
    const m = /^([^%]*?)\\end\s*\{document\}/.exec(cm.getLine(l));
    if (m) return pos.line > l || (pos.line === l && pos.ch > m[1].length);
  }
  return false;
}
function citeKeys(keys, at) {
  keys = [...new Set(keys.filter(Boolean))];
  if (!keys.length) return toast('None of these papers has a cite key.', 'bad');
  if (!cm) return toast('The editor could not be started, so the toolbar is unavailable.', 'bad');
  if (W.mode !== 'project' || !editor.ok()) return;
  if (at) {
    if (beforeDocclass(at)) return toast('Drop the citation into the text of the document, after \\documentclass.', 'bad');
    if (afterEnddoc(at)) return toast('Drop the citation into the text of the document, before \\end{document}.', 'bad');
    cm.setCursor(at);
  }
  else {
    if (unplaced()) return toast(`Click in the text where the citation goes, then cite again (the cursor is still at the start of the file).`, 'bad');
    if (!cm.somethingSelected() && beforeDocclass(cm.getCursor())) return toast('Put the cursor in the text of the document, after \\documentclass, then cite again.', 'bad');
    if (!cm.somethingSelected() && afterEnddoc(cm.getCursor())) return toast('Put the cursor in the text of the document, before \\end{document}, then cite again.', 'bad');
  }
  editor.insert(`\\cite{${keys.join(',')}}`);
}
function toggleSel(id, on) {
  const r = $(`#wl-list .wl-row[data-id="${CSS.escape(id)}"]`);
  const key = libKeys([id])[0];
  if (!key) return;
  const v = on === undefined ? !WL.sel.has(id) : on;
  if (v) WL.sel.add(id); else WL.sel.delete(id);
  if (r) { r.classList.toggle('sel', v); r.setAttribute('aria-selected', String(v)); const c = $('.wl-check', r); if (c) c.checked = v; }
  paintLibBar();
}
let wlLast = null; // the row a Shift-click extends from
$('#wl-list').addEventListener('click', (e) => {
  const r = e.target.closest('.wl-row'); if (!r) return;
  const id = r.dataset.id, b = e.target.closest('button[data-wl]');
  if (b) {
    if (b.disabled) return;
    const act = b.dataset.wl;
    if (act === 'cite') citeKeys(libKeys([id]));
    else if (act === 'open') { RT.setView('library'); if (RT.library && RT.library.select) RT.library.select(id); }
    else if ((act === 'add' || act === 'remove') && W.project) { b.disabled = true; editMembers(W.project.id, [id], act === 'add').catch((err) => { b.disabled = false; toast(err.message, 'bad'); }); }
    return;
  }
  if (e.shiftKey && wlLast) {
    const rows = $$('#wl-list .wl-row'), a = rows.findIndex((x) => x.dataset.id === wlLast), z = rows.indexOf(r);
    if (a >= 0 && z >= 0) { for (const x of rows.slice(Math.min(a, z), Math.max(a, z) + 1)) toggleSel(x.dataset.id, true); return; }
  }
  toggleSel(id); wlLast = id; r.focus({ preventScroll: true });
});
$('#wl-list').addEventListener('dblclick', (e) => {
  const r = e.target.closest('.wl-row'); if (!r || e.target.closest('button, input')) return;
  e.preventDefault();
  const id = r.dataset.id, ids = WL.sel.has(id) && WL.sel.size > 1 ? selectedIds() : [id];
  citeKeys(libKeys(ids));
});
$('#wl-list').addEventListener('keydown', (e) => {
  const r = e.target.closest('.wl-row'); if (!r) return;
  if (e.key === 'Enter') { e.preventDefault(); citeKeys(libKeys(WL.sel.has(r.dataset.id) && WL.sel.size > 1 ? selectedIds() : [r.dataset.id])); }
  else if (e.key === ' ') { e.preventDefault(); toggleSel(r.dataset.id); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = $$('#wl-list .wl-row'), n = rows[rows.indexOf(r) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (n) n.focus(); else if (e.key === 'ArrowUp') $('#wl-q').focus();
  }
});
$('#wl-q').addEventListener('input', debounce(() => { WL.q = $('#wl-q').value; renderLib(); }, 120));
$('#wl-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { const r = $('#wl-list .wl-row'); if (r) { e.preventDefault(); r.focus(); } }
  else if (e.key === 'Escape' && $('#wl-q').value) { e.preventDefault(); e.stopPropagation(); $('#wl-q').value = ''; WL.q = ''; renderLib(); }
});
$('#wl-cite-sel').addEventListener('click', () => citeKeys(libKeys(selectedIds())));
$('#wl-clear').addEventListener('click', () => { WL.sel.clear(); for (const r of $$('#wl-list .wl-row.sel')) { r.classList.remove('sel'); r.setAttribute('aria-selected', 'false'); const c = $('.wl-check', r); if (c) c.checked = false; } paintLibBar(); });
// drag a row (or the selection it belongs to) into the text
const CITE_TYPE = 'application/x-rt-cite';
$('#wl-list').addEventListener('dragstart', (e) => {
  const r = e.target.closest('.wl-row'); if (!r) return;
  const ids = WL.sel.has(r.dataset.id) ? selectedIds() : [r.dataset.id], keys = libKeys(ids);
  if (!keys.length) { e.preventDefault(); return; }
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(CITE_TYPE, JSON.stringify(keys));
  e.dataTransfer.setData('text/plain', `\\cite{${keys.join(',')}}`);
  document.body.classList.add('wl-dragging');
});
$('#wl-list').addEventListener('dragend', () => document.body.classList.remove('wl-dragging'));
if (cm) {
  const wrap = cm.getWrapperElement();
  const citeDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes(CITE_TYPE);
  wrap.addEventListener('dragover', (e) => {
    if (!citeDrag(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    cm.setCursor(pos); // the caret shows where the citation lands
    if (!cm.hasFocus()) cm.focus();
  });
  wrap.addEventListener('drop', (e) => {
    if (!citeDrag(e)) return;
    e.preventDefault(); e.stopPropagation(); document.body.classList.remove('wl-dragging');
    let keys = []; try { keys = JSON.parse(e.dataTransfer.getData(CITE_TYPE)) || []; } catch { /* nothing to insert */ }
    citeKeys(keys, cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window'));
  });
}
// Shift+Cmd+L (Shift+Ctrl+L): open the panel and put the cursor in its search box
document.addEventListener('keydown', (e) => {
  if (RT.state.view !== 'write' || W.mode !== 'project' || e.altKey || !e.shiftKey || String(e.key).toLowerCase() !== 'l') return;
  if (!(MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || document.querySelector('dialog[open]')) return;
  e.preventDefault(); e.stopPropagation();
  if (libOpen() && W.ui.panel === 'library') { $('#wl-q').focus(); $('#wl-q').select(); } else togglePanel('library');
}, true);
RT.on('library:changed', () => renderLib());
RT.on('library:refreshed', () => renderLib());
RT.on('memberships:changed', () => renderLib());

// ---------------- top bar ----------------
$('#btn-save').addEventListener('click', () => saveAll().catch((e) => toast(e.message, 'bad')));
document.addEventListener('keydown', (e) => {
  if (RT.state.view !== 'write' || W.mode !== 'project' || !(e.metaKey || e.ctrlKey) || e.altKey || String(e.key).toLowerCase() !== 's') return;
  e.preventDefault(); e.stopPropagation();
  if (!document.querySelector('dialog[open]')) saveAll().catch((err) => toast(err.message, 'bad'));
}, true);
window.addEventListener('beforeunload', (e) => {
  const d = [...W.bufs.values()].filter((b) => b.dirty); if (!d.length) return;
  for (const b of d) if (!b.conflict) saveBuf(b, 'auto', { keepalive: bufText(b).length < 30000 }); // best effort, in case the user leaves anyway
  e.preventDefault(); e.returnValue = '';
});

// ---------------- compile + logs ----------------
let compileSeq = 0;
function setStatus(text, cls = '') { const s = $('#compile-status'); s.textContent = text; s.className = 'ghost ' + cls; }
// the Recompile button is an icon: while compiling it spins (.busy) and its hint says so
function setCompiling(on) {
  const b = $('#btn-compile');
  b.classList.toggle('busy', on); b.setAttribute('aria-busy', String(on));
  b.title = on ? 'Compiling…' : COMPILE_HINT; b.setAttribute('aria-label', on ? 'Compiling' : 'Recompile');
}
function previewEmpty(msg) { pdfClear(); const el = $('#preview-empty'); el.style.display = ''; el.innerHTML = msg; }
// the file an error belongs to, as a project-relative path
function errFile(e) {
  const p = W.project; if (!p) return null;
  const f = e.file ? String(e.file).replace(/^\.\//, '') : p.mainFile; if (!f) return null;
  if (fileEntry(f)) return f;
  const alt = (p.mainFile && dirName(p.mainFile) ? dirName(p.mainFile) + '/' : '') + f;
  return fileEntry(alt) ? alt : f;
}
function markErrors() {
  if (!cm) return;
  const errs = (W.lastCompile && W.lastCompile.errors) || [];
  for (const b of W.bufs.values()) {
    if (!b.doc) continue;
    (b.marks || []).forEach((h) => b.doc.removeLineClass(h, 'background', 'cm-err-line'));
    b.marks = errs.filter((e) => e.line && e.line <= b.doc.lineCount() && errFile(e) === b.path).map((e) => b.doc.addLineClass(e.line - 1, 'background', 'cm-err-line'));
  }
}
function renderLog() {
  const r = W.lastCompile, host = $('#log-panel'), badge = $('#log-badge');
  const ne = r ? r.errors.length : 0, nw = r ? r.warnings.length : 0;
  badge.hidden = !(ne || nw); badge.textContent = ne || nw; badge.className = 'cnt ' + (ne ? 'bad' : 'warn');
  $('#btn-log').title = r ? `Logs — ${plural(ne, 'error')}, ${plural(nw, 'warning')}` : 'Logs';
  $('#btn-log').classList.toggle('on', W.showLog);
  host.hidden = !W.showLog;
  if (!W.showLog) return;
  const issues = !r ? '' : r.errors.map((e, i) => { const f = errFile(e); return `<div class="issue err${f ? ' go' : ''}" data-err="${i}" data-file="${esc(f || '')}" data-line="${e.line || ''}" tabindex="0"><span class="issue-kind">Error</span>${f ? `<span class="issue-at">${esc(f)}${e.line ? ':' + e.line : ''}</span>` : ''}<span class="issue-msg">${esc(e.msg)}</span></div>`; }).join('')
    + r.warnings.map((w, i) => `<div class="issue warn" data-warn="${i}" tabindex="0"><span class="issue-kind">Warning</span><span class="issue-msg">${esc(w)}</span></div>`).join('');
  host.innerHTML = `<div class="log-head"><strong>Logs</strong><span class="muted">${r ? `${plural(ne, 'error')} · ${plural(nw, 'warning')}` : 'nothing compiled yet'}</span><span class="spacer"></span>${ne ? (canEdit() ? `<button id="log-fix" class="ib" title="Fix with Claude: send the errors to Claude Code, which edits the project files to fix them (you can also right-click a single error or warning)" aria-label="Fix with Claude">${RT.icon('sparkle')}</button>`
    : `<button id="log-fix" class="ib" title="Suggest a fix with Claude: send the errors to the Claude panel, which says what to change (with this provider the panel does not edit files)" aria-label="Suggest a fix with Claude">${RT.icon('sparkle')}</button>`) : ''}<button id="log-close" class="tb" title="Back to the PDF" aria-label="Close the logs">${ic('close')}</button></div>
    <div class="log-body">${issues || (r ? '<div class="issue okay">No errors or warnings.</div>' : '')}
      <h4>Raw log</h4><pre class="log">${esc(r ? r.log || 'The log is empty.' : 'No compile log yet.')}</pre></div>`;
}
function toggleLog(on = !W.showLog) { W.showLog = on; W.autoLog = false; renderLog(); }
$('#btn-log').addEventListener('click', () => toggleLog());
$('#compile-status').addEventListener('click', () => { if (W.ui.layout === 'editor') setLayout('both'); toggleLog(); });
const issueGo = (el) => { if (el && el.dataset.file) gotoLine(el.dataset.file, Number(el.dataset.line) || 0).catch((e) => toast(e.message, 'bad')); };
// ---- "Fix with Claude": hand compile problems to the Claude panel, which edits the project files
function logExcerpt(msg) { // the part of the raw log around a message
  const log = (W.lastCompile && W.lastCompile.log) || '', key = String(msg).split(': ').pop().slice(0, 60);
  const at = key ? log.indexOf(key) : -1; if (at < 0) return '';
  let a = at, b = at;
  for (let n = 0; n < 4 && a > 0; n++) a = log.lastIndexOf('\n', a - 2) + 1;
  for (let n = 0; n < 14 && b >= 0 && b < log.length; n++) { const nx = log.indexOf('\n', b + 1); if (nx < 0) { b = log.length; break; } b = nx; }
  return log.slice(a, b).trim().slice(0, 2000);
}
// a provider that edits the project files itself (Claude Code): the others run read-only and suggest the change
// (another provider chosen: the log's fix button says what it does now)
RT.on('ai:changed', () => { if (W.lastCompile) renderLog(); });
function canEdit() { return !(RT.ai && RT.ai.caps && RT.ai.caps().agentic === false); }
function fixLabel(all) { return canEdit() ? (all ? `Fix all ${all} errors with Claude` : 'Fix with Claude') : all ? `Suggest fixes for all ${all} errors with Claude` : 'Suggest a fix with Claude'; }
function askClaudeFix(problems, kind = 'error') { // problems: [{msg, at}]
  const p = W.project; if (!p || !problems.length) return;
  if (!RT.claude || !RT.claude.ask) return toast('The Claude panel is not available.', 'bad');
  const many = problems.length > 1, list = problems.slice(0, 8);
  const body = list.map((x, i) => `${many ? `${i + 1}. ` : ''}${x.msg}${x.at ? `\n   Reported at: ${x.at}` : ''}${x.excerpt ? `\n   Log excerpt:\n${x.excerpt.replace(/^/gm, '   | ')}` : ''}`).join('\n\n');
  RT.claude.ask(`Fix ${many ? `these LaTeX compile ${kind}s` : `this LaTeX compile ${kind}`} in my project "${p.name}"${p.mainFile ? ` (main file: ${p.mainFile})` : ''}.\n\n${body}\n\n`
    + (canEdit() ? 'Read the files involved, find the real cause (for example two packages that clash, or a wrong option), and make the smallest edit to the project files that fixes it. Do not remove content to make the error go away. Then tell me in one or two sentences what you changed.'
      : 'Read the files involved, find the real cause (for example two packages that clash, or a wrong option), and show the smallest change that fixes it as a short diff of the file. You cannot edit files: I will make the change myself. Do not remove content to make the error go away.'));
}
const errProblem = (e) => { const f = errFile(e); return { msg: e.msg, at: f ? f + (e.line ? ':' + e.line : '') : '', excerpt: logExcerpt(e.msg) }; };
$('#log-panel').addEventListener('contextmenu', (e) => {
  const r = W.lastCompile; if (!r) return;
  const at = { x: e.clientX, y: e.clientY }, copy = (t) => navigator.clipboard.writeText(t).then(() => toast('Copied', 'ok'));
  const is = e.target.closest('.issue[data-err], .issue[data-warn]');
  if (is) {
    e.preventDefault();
    const err = is.dataset.err != null ? r.errors[Number(is.dataset.err)] : null, warn = err ? null : r.warnings[Number(is.dataset.warn)];
    const prob = err ? errProblem(err) : { msg: String(warn), at: '', excerpt: logExcerpt(warn) };
    return menu(at, [
      { label: fixLabel(0), icon: 'sparkle', run: () => askClaudeFix([prob], err ? 'error' : 'warning') },
      ...(err && r.errors.length > 1 ? [{ label: fixLabel(r.errors.length), icon: 'sparkle', run: () => askClaudeFix(r.errors.map(errProblem)) }] : []),
      { label: 'Explain with Claude', run: () => RT.claude.ask(`Explain this LaTeX compile ${err ? 'error' : 'warning'} from my project "${W.project.name}" in plain words and say how to fix it. Do not change any file.\n\n${prob.msg}${prob.at ? `\nReported at: ${prob.at}` : ''}${prob.excerpt ? `\n\nLog excerpt:\n${prob.excerpt}` : ''}`) },
      { sep: true },
      ...(is.dataset.file ? [{ label: 'Go to the line', run: () => issueGo(is) }] : []),
      { label: 'Copy message', run: () => copy(prob.msg) },
    ]);
  }
  const sel = String(window.getSelection() || '').trim();
  if (sel && e.target.closest('pre.log')) { // a selected part of the raw log
    e.preventDefault();
    const text = sel.slice(0, 4000);
    return menu(at, [
      { label: fixLabel(0), run: () => askClaudeFix([{ msg: 'This part of the compile log:', excerpt: text }], 'problem') },
      { label: 'Explain with Claude', run: () => RT.claude.ask(`Explain this part of the LaTeX compile log of my project "${W.project.name}" in plain words. Do not change any file.\n\n${text}`) },
      { sep: true },
      { label: 'Copy', run: () => copy(sel) },
    ]);
  }
});
$('#log-panel').addEventListener('click', (e) => { if (e.target.closest('#log-close')) return toggleLog(false); if (e.target.closest('#log-fix')) return askClaudeFix(W.lastCompile.errors.map(errProblem)); issueGo(e.target.closest('.issue')); });
$('#log-panel').addEventListener('keydown', (e) => { if (e.key === 'Enter') issueGo(e.target.closest('.issue')); });

async function compile(o = {}) {
  const p = W.project; if (!p || p.missing) return;
  W.needCompile = false;
  if (!p.mainFile) {
    ++compileSeq; W.lastCompile = null; setCompiling(false); renderLog(); markErrors(); setStatus('No main file');
    return previewEmpty('<div><p><strong>This project has no main file.</strong></p><p>In the file tree, open the ⋯ menu (or right-click) on the .tex file that contains <code>\\documentclass</code> and choose “Set as main file”.</p></div>');
  }
  const seq = ++compileSeq;
  setStatus(o.fromScratch ? 'Recompiling from scratch…' : 'Compiling…'); setCompiling(true);
  let r;
  try { r = await api(pUrl('/compile'), { method: 'POST', json: { stopOnFirstError: W.opts.halt, fromScratch: !!o.fromScratch } }); }
  catch (e) { if (seq === compileSeq) { setCompiling(false); setStatus('Compile failed: ' + e.message, 'bad'); } return; }
  if (seq !== compileSeq || !W.project || W.project.id !== p.id) return; // a newer compile is on its way
  setCompiling(false);
  r.errors = r.errors || []; r.warnings = r.warnings || [];
  W.lastCompile = r;
  if (!r.ok && !r.hasPdf && !W.showLog) { W.showLog = true; W.autoLog = true; } // nothing to look at but the errors
  else if (r.ok && W.autoLog) { W.showLog = false; W.autoLog = false; }
  renderLog(); markErrors();
  if (r.ok) setStatus(`Compiled in ${(r.ms / 1000).toFixed(1)}s${r.warnings.length ? ` · ${plural(r.warnings.length, 'warning')}` : ''}`, 'ok');
  else setStatus(`${plural(r.errors.length || 1, 'LaTeX error')}${r.hasPdf ? ' — click for the log' : ''}`, 'bad');
  if (r.hasPdf) showPdf(pUrl(`/pdf?t=${Date.now()}`), seq);
  else previewEmpty('No PDF yet — fix the errors shown in the logs and compile again.');
  // the compile may have created files (e.g. references.bib): refresh the tree without triggering another compile
  refreshProject().catch(() => {});
  refsSoon(); // ... and references.bib may now be the one the app writes
}
$('#btn-compile').addEventListener('click', async () => { if (!needProject()) return; await flushAll(); compile(); });
$('#btn-compile-menu').addEventListener('click', (e) => {
  if (!needProject()) return;
  menu(e.currentTarget, [
    { label: 'Auto compile', check: W.opts.auto, title: 'Compile after every autosave', run: () => { W.opts.auto = !W.opts.auto; ls.set('rt-auto-compile', W.opts.auto ? '1' : '0'); toast(`Auto compile ${W.opts.auto ? 'on' : 'off'}`); } },
    { head: 'Compiler' }, ...compilerItems(),
    { sep: true },
    { label: 'Recompile from scratch', icon: 'refresh', title: 'Clears the auxiliary build files (.aux, .toc, .bbl …) first', run: async () => { await flushAll(); compile({ fromScratch: true }); } },
    { label: 'Stop on first error', check: W.opts.halt, run: async () => { W.opts.halt = !W.opts.halt; ls.set('rt-halt-on-error', W.opts.halt ? '1' : '0'); await flushAll(); compile(); } },
  ]);
});
$('#btn-pdf-dl').addEventListener('click', downloadPdf);

// ---------------- PDF viewer (pdf.js): lazy pages, text layer, zoom, page box; keeps the scroll position across compiles ----------------
const pvHost = $('#preview');
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const savedZoom = ls.get('rt-pdf-zoom', 'width');
const PV = { doc: null, url: null, pages: [], scale: 1, zoom: savedZoom === 'width' || savedZoom === 'height' ? savedZoom : Number(savedZoom) || 'width', page: 0, gen: 0, lastClick: null };
// search, links, table of contents and Back: the part shared with the Library reader (pdfnav.js)
const pvNav = RT.pdfnav.create({
  prefix: 'pv', pane: $('#preview-pane'), scroller: pvHost,
  doc: () => PV.doc, pages: () => PV.pages.length, pageEl: (n) => (PV.pages[n - 1] ? PV.pages[n - 1].el : null),
  top: (n) => PV.pages[n - 1].el.offsetTop, scale: () => PV.scale,
  // page n is drawn from the document that is open now (a page keeps its old picture until then)
  ready: async (n) => {
    const p = PV.pages[n - 1];
    for (let i = 0; p && i < 80 && PV.pages[n - 1] === p && (p.stale || p.busy || !p.canvas); i++) { renderVisible(); await new Promise((res) => setTimeout(res, 50)); }
  },
  active: () => RT.state.view === 'write' && W.mode === 'project' && !W.showLog,
});
function pdfClear() {
  PV.gen++; PV.pages = []; PV.page = 0; PV.lastClick = null; PV.url = null; pvNav.reset();
  if (PV.doc) { const d = PV.doc; PV.doc = null; Promise.resolve().then(() => d.destroy()).catch(() => {}); }
  pvHost.replaceChildren(); pvHost.style.display = 'none';
  $('#pdf-page').value = '0'; $('#pdf-total').textContent = '0'; renderBudget();
}
function pdfScale() {
  const p = PV.pages[Math.max(0, PV.page - 1)] || PV.pages[0];
  if (!p) return 1;
  if (PV.zoom === 'width') return pvHost.clientWidth ? Math.max(0.1, (pvHost.clientWidth - 28) / p.w) : PV.scale || 1;
  if (PV.zoom === 'height') return pvHost.clientHeight ? Math.max(0.1, (pvHost.clientHeight - 20) / p.h) : PV.scale || 1;
  return PV.zoom;
}
function layoutPages() {
  for (let pass = 0; pass < 2; pass++) { // twice: sizing the pages can make a scrollbar appear, which changes the width to fit
    const sc = pdfScale();
    if (pass && Math.abs(sc - PV.scale) < 0.002) break;
    PV.scale = sc;
    for (const p of PV.pages) {
      p.el.style.width = Math.floor(p.w * sc) + 'px'; p.el.style.height = Math.floor(p.h * sc) + 'px';
      if (p.canvas && p.scale !== sc) p.stale = true;
    }
  }
  $('#pdf-zoom-label').textContent = Math.round(PV.scale * 100) + '%';
}
function renderVisible() {
  if (!PV.doc || !pvHost.clientHeight) return;
  const H = pvHost.clientHeight, top = pvHost.scrollTop - H, bot = pvHost.scrollTop + 2 * H;
  for (const p of PV.pages) {
    const y = p.el.offsetTop, h = p.el.offsetHeight;
    if (y + h > top && y < bot) { if ((p.stale || !p.canvas) && p.fail !== PV.gen + ':' + PV.scale) renderPage(p); }
    else if (p.canvas && (y + h < top - 8 * H || y > bot + 8 * H)) { p.el.querySelectorAll('canvas, .textLayer, .pn-links').forEach((x) => x.remove()); p.canvas = null; } // free far-away pages
  }
}
async function renderPage(p) {
  if (p.busy) return;
  p.busy = true; p.stale = false;
  const gen = PV.gen, scale = PV.scale, doc = PV.doc;
  let ok = false;
  try {
    const page = await doc.getPage(p.n);
    const dpr = Math.min(window.devicePixelRatio || 1, Math.max(1, Math.sqrt(16e6 / (p.w * p.h * scale * scale)))); // cap the canvas at ~16 MP
    const vp = page.getViewport({ scale: scale * dpr });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const tl = document.createElement('div'); tl.className = 'textLayer'; tl.style.setProperty('--scale-factor', scale);
    try { await pdfjsLib.renderTextLayer({ textContentSource: await page.getTextContent(), container: tl, viewport: page.getViewport({ scale }) }).promise; } catch { /* the page still shows without selectable text */ }
    if (gen === PV.gen && scale === PV.scale && PV.pages[p.n - 1] === p) {
      p.el.querySelectorAll('canvas, .textLayer, .pn-links').forEach((x) => x.remove());
      p.el.prepend(c, tl); p.canvas = c; p.scale = scale; ok = true;
      pvNav.decorate(p.n, page).catch(() => {});
    }
  } catch (e) { if (gen === PV.gen && scale === PV.scale) { p.fail = gen + ':' + scale; console.error('PDF page ' + p.n, e); } }
  finally { p.busy = false; if (!ok) p.stale = true; if (!ok || p.stale) requestAnimationFrame(renderVisible); }
}
// one pdf.js worker for every document (otherwise each compile would start a new one)
let sharedWorker = null;
function pdfWorker() {
  try { if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new pdfjsLib.PDFWorker(); } catch { sharedWorker = null; }
  return sharedWorker;
}
async function showPdf(url, seq) {
  pvHost.style.display = 'block'; $('#preview-empty').style.display = 'none';
  if (!window.pdfjsLib) { pvHost.innerHTML = `<iframe title="PDF preview" src="${esc(url)}#view=FitH"></iframe>`; return; }
  let doc, sizes;
  try {
    doc = await pdfjsLib.getDocument({ url, worker: pdfWorker() || undefined, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise;
    sizes = await Promise.all(Array.from({ length: doc.numPages }, async (_, i) => { const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 }); return { w: vp.width, h: vp.height }; }));
  } catch (e) { if (seq === compileSeq) setStatus('Compiled, but the preview could not be drawn: ' + e.message, 'bad'); if (doc) doc.destroy().catch(() => {}); return; }
  if (seq !== compileSeq) { doc.destroy().catch(() => {}); return; }
  const old = PV.doc, top = pvHost.scrollTop;
  PV.doc = doc; PV.url = url; PV.gen++;
  while (PV.pages.length > sizes.length) PV.pages.pop().el.remove();
  sizes.forEach((s, i) => {
    let p = PV.pages[i];
    if (!p) { const el = document.createElement('div'); el.className = 'pg'; el.dataset.page = i + 1; pvHost.append(el); p = { n: i + 1, el }; PV.pages.push(p); }
    p.w = s.w; p.h = s.h; p.stale = true; // the old picture stays until the new one is drawn: no flicker, same scroll position
  });
  if (!PV.page) PV.page = 1;
  layoutPages(); pvHost.scrollTop = top;
  $('#pdf-total').textContent = sizes.length;
  trackPage(); renderVisible(); pvNav.changed(); renderBudget();
  if (old) Promise.resolve().then(() => old.destroy()).catch(() => {});
}
// The page at the top of the pane - the same page scrollToPage(n) puts there, so Previous / Next always move by one
// page however short the pages are (beamer slides, low zoom).
function topPage() {
  const top = pvHost.scrollTop + 8;
  for (const p of PV.pages) if (p.el.offsetTop + p.el.offsetHeight > top) return p.n;
  return PV.pages.length;
}
function trackPage() {
  if (!PV.pages.length || !pvHost.clientHeight) return;
  // scrolled to the very end: the last page is showing even when it cannot reach the top of the pane
  const max = pvHost.scrollHeight - pvHost.clientHeight;
  const n = max > 0 && pvHost.scrollTop >= max - 1 ? PV.pages.length : topPage();
  PV.page = n;
  if (document.activeElement !== $('#pdf-page')) $('#pdf-page').value = n;
}
let pvRaf = 0;
pvHost.addEventListener('scroll', () => { if (!pvRaf) pvRaf = requestAnimationFrame(() => { pvRaf = 0; trackPage(); renderVisible(); }); });
function scrollToPage(n, yPts = null) {
  const p = PV.pages[Math.max(1, Math.min(n, PV.pages.length)) - 1]; if (!p) return;
  pvHost.scrollTop = yPts == null ? p.el.offsetTop - 6 : p.el.offsetTop + yPts * PV.scale - pvHost.clientHeight / 3;
  trackPage(); renderVisible();
}
function setZoom(z) {
  if (!PV.pages.length) { PV.zoom = z; ls.set('rt-pdf-zoom', String(z)); return; }
  const frac = pvHost.scrollHeight ? (pvHost.scrollTop + pvHost.clientHeight / 2) / pvHost.scrollHeight : 0;
  PV.zoom = z; ls.set('rt-pdf-zoom', String(z));
  layoutPages();
  pvHost.scrollTop = frac * pvHost.scrollHeight - pvHost.clientHeight / 2;
  trackPage(); renderVisible();
}
const stepZoom = (dir) => {
  const cur = PV.scale, next = dir > 0 ? ZOOMS.find((z) => z > cur * 1.02) : [...ZOOMS].reverse().find((z) => z < cur * 0.98);
  if (next) setZoom(next);
};
$('#pdf-zoom-in').addEventListener('click', () => stepZoom(1));
$('#pdf-zoom-out').addEventListener('click', () => stepZoom(-1));
$('#pdf-zoom').addEventListener('click', (e) => menu(e.currentTarget, [
  { label: 'Fit to width', check: PV.zoom === 'width', run: () => setZoom('width') }, { label: 'Fit to height', check: PV.zoom === 'height', run: () => setZoom('height') }, { sep: true },
  ...ZOOMS.map((z) => ({ label: Math.round(z * 100) + '%', check: PV.zoom === z, run: () => setZoom(z) }))], { right: true }));
$('#pdf-prev').addEventListener('click', () => {
  if (!PV.pages.length) return;
  const n = topPage(), p = PV.pages[n - 1];
  // in the middle of a page: first back to its top, like every PDF viewer
  scrollToPage(p && pvHost.scrollTop > p.el.offsetTop + 2 ? n : n - 1);
});
$('#pdf-next').addEventListener('click', () => { if (PV.pages.length) scrollToPage(topPage() + 1); });
$('#pdf-page').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const n = parseInt(e.target.value, 10);
  if (n >= 1 && n <= PV.pages.length) scrollToPage(n); else e.target.value = PV.page;
  e.target.blur();
});
$('#pdf-page').addEventListener('focus', (e) => e.target.select());
$('#pdf-page').addEventListener('blur', (e) => { e.target.value = PV.page; });
// the pane changed size (divider, layout, window, Claude panel): refit and draw what is now visible
const pdfResized = debounce(() => {
  if (!PV.doc || !pvHost.clientWidth) return;
  if (PV.zoom === 'width' || PV.zoom === 'height') {
    const s = pdfScale();
    if (Math.abs(s - PV.scale) > 0.004) { const frac = pvHost.scrollHeight ? pvHost.scrollTop / pvHost.scrollHeight : 0; layoutPages(); pvHost.scrollTop = frac * pvHost.scrollHeight; }
  }
  trackPage(); renderVisible();
}, 150);
if (window.ResizeObserver) new ResizeObserver(() => pdfResized()).observe(pvHost); else window.addEventListener('resize', () => pdfResized());

// ---------------- SyncTeX ----------------
function flashBox(box) {
  const p = PV.pages[box.page - 1]; if (!p) return;
  const el = document.createElement('div'); el.className = 'sync-hl';
  const s = PV.scale, pad = 3;
  Object.assign(el.style, { left: box.x * s - pad + 'px', top: box.y * s - pad + 'px', width: Math.max(box.width * s, 10) + 2 * pad + 'px', height: Math.max(box.height * s, 10) + 2 * pad + 'px' });
  p.el.append(el);
  setTimeout(() => el.remove(), 1800);
}
async function syncToPdf() {
  const b = activeBuf();
  if (!cm || !b || b.kind !== 'text') return toast('Put the cursor in a .tex file first.', 'bad');
  if (!PV.doc) return toast('There is no compiled PDF yet — compile first.', 'bad');
  const cur = cm.getCursor();
  let r;
  try { r = await api(pUrl('/synctex'), { method: 'POST', json: { direction: 'forward', file: b.path, line: cur.line + 1, column: cur.ch } }); }
  catch (e) { return toast(e.status === 404 ? `${e.message}${b.dirty ? ' (the file has unsaved changes — compile again)' : ''}` : 'SyncTeX: ' + e.message, 'bad'); }
  if (W.ui.layout === 'editor') { setLayout('both'); await new Promise((res) => setTimeout(res, 250)); }
  if (W.showLog) toggleLog(false);
  scrollToPage(r.page, r.y);
  const seen = new Set();
  for (const box of (r.boxes || [r]).filter((x) => x.page === r.page)) { const k = [box.x, box.y, box.width, box.height].join(); if (!seen.has(k)) { seen.add(k); flashBox(box); } }
}
async function syncToCode(pos = PV.lastClick) {
  if (!pos) return toast('Click a spot in the PDF first (or double-click it to jump straight to the source).', 'bad');
  let r;
  try { r = await api(pUrl('/synctex'), { method: 'POST', json: { direction: 'inverse', page: pos.page, x: pos.x, y: pos.y } }); }
  catch (e) { return toast(e.status === 404 ? e.message : 'SyncTeX: ' + e.message, 'bad'); }
  await gotoLine(r.file, r.line, r.column ? r.column + 1 : 1);
  if (cm) { const h = cm.addLineClass(Math.min(r.line, cm.lineCount()) - 1, 'background', 'cm-sync-line'); setTimeout(() => cm.removeLineClass(h, 'background', 'cm-sync-line'), 1600); }
}
function pdfPoint(e) {
  const el = e.target.closest && e.target.closest('.pg'); if (!el) return null;
  const r = el.getBoundingClientRect();
  return { page: Number(el.dataset.page), x: (e.clientX - r.left) / PV.scale, y: (e.clientY - r.top) / PV.scale };
}
pvHost.addEventListener('click', (e) => { const p = pdfPoint(e); if (p) PV.lastClick = p; });
pvHost.addEventListener('dblclick', (e) => { const p = pdfPoint(e); if (p) { PV.lastClick = p; syncToCode(p).catch((err) => toast(err.message, 'bad')); } });
$('#sync-to-pdf').addEventListener('click', () => syncToPdf().catch((e) => toast(e.message, 'bad')));
$('#sync-to-code').addEventListener('click', () => syncToCode().catch((e) => toast(e.message, 'bad')));

// ---------------- history (full-width view: diff in the centre, versions on the right) ----------------
const SRC = { manual: 'Saved', auto: 'Autosave', baseline: 'Before first edit', external: 'Edited outside', claude: 'Claude', restore: 'Restored' };
// the kind of a version as shown: an AI ('claude') version names the provider that made it (v.by; older versions,
// all by Claude, have none) and is kept out of the display layer's renaming (data-brand-keep), which would otherwise
// name the provider chosen now
const srcHtml = (v) => (v.source === 'claude' ? `<span data-brand-keep>${esc(RT.ai ? RT.ai.nameOf(v.by) : 'Claude')}</span>` : esc(SRC[v.source] || v.source));
// translated here: the label shares its text node with the time and the kind of save (the diff's title)
function dayLabel(ts) {
  const d = new Date(ts), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((day(new Date()) - day(d)) / 864e5);
  const tr = (x) => (RT.i18n && RT.i18n.t ? RT.i18n.t(x) : x), zh = !!(RT.i18n && RT.i18n.lang && RT.i18n.lang() === 'zh');
  return n === 0 ? tr('Today') : n === 1 ? tr('Yesterday') : d.toLocaleDateString(zh ? 'zh-CN' : undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
const histSel = () => W.hist.versions.find((v) => v.id === W.hist.sel) || null;
const histGroup = () => W.hist.groups.find((g) => g.versions.some((v) => v.id === W.hist.sel)) || null;
// "All files": changes saved together (same kind, same label, within two minutes) are one version touching several files
function groupVersions(vs, all) {
  const groups = [];
  for (const v of vs) {
    const g = groups[groups.length - 1];
    if (all && g && g.source === v.source && (g.label || '') === (v.label || '') && (g.by || '') === (v.by || '') && Math.abs(new Date(g.ts) - new Date(v.ts)) <= 120000 && !g.versions.some((x) => x.file === v.file)) g.versions.push(v);
    else groups.push({ ts: v.ts, source: v.source, label: v.label, by: v.by, versions: [v] });
  }
  return groups;
}
function renderHistMode() {
  const h = W.hist;
  $('#history').hidden = !h.on; $('#wr-body').hidden = h.on;
  $('#btn-history').classList.toggle('on', h.on);
  $$('#hist-scope button').forEach((b) => b.classList.toggle('on', (b.dataset.scope === 'all') === h.all));
  $$('#hist-filter button').forEach((b) => b.classList.toggle('on', b.dataset.filter === h.filter));
  renderConflict();
  if (!h.on) { showArea(); pdfResized(); }
}
async function setHistory(on) {
  W.hist.on = on; W.hist.sel = null;
  renderHistMode();
  if (on) { closeMenus(); $('#hist-list').innerHTML = '<div class="muted hist-empty">Loading…</div>'; renderDiffEmpty(); await flushAll(); await loadHistory(); }
  else { renderOutline(); runChecks(); }
}
$('#btn-history').addEventListener('click', () => { if (W.project) setHistory(!W.hist.on).catch((e) => toast(e.message, 'bad')); });
$('#hist-close').addEventListener('click', () => setHistory(false).catch((e) => toast(e.message, 'bad')));
$('#hist-scope').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; W.hist.all = b.dataset.scope === 'all'; W.hist.sel = null; renderHistMode(); loadHistory(); });
$('#hist-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; W.hist.filter = b.dataset.filter; W.hist.sel = null; renderHistMode(); renderHistory(); });

async function loadHistory() {
  const h = W.hist; if (!h.on || !W.project) return;
  const seq = ++h.seq;
  if (!h.all && !W.active) { h.versions = []; return renderHistory(); }
  try {
    const r = await api(pUrl(`/history?${h.all ? '' : 'path=' + enc(W.active) + '&'}limit=${h.all ? 1000 : 300}`));
    if (seq !== h.seq) return;
    h.versions = r.versions || [];
  } catch (e) { if (seq !== h.seq) return; h.versions = []; toast('Could not load the history: ' + e.message, 'bad'); }
  if (h.sel && !histSel()) h.sel = null;
  renderHistory();
}
function renderDiffEmpty() {
  $('#diff-view').innerHTML = `<div class="empty"><div><p><strong>${W.hist.all ? 'History of all files' : esc(W.active ? `History of ${W.active}` : 'History')}</strong></p><p class="muted">Pick a version on the right to see what changed in it.<br>You can compare it with the current text, label it, or restore it.</p></div></div>`;
}
function renderHistory() {
  const h = W.hist; let day = '';
  h.groups = groupVersions(h.filter === 'labels' ? h.versions.filter((v) => v.label) : h.versions, h.all);
  const sel = histGroup();
  $('#hist-list').innerHTML = h.groups.map((g) => {
    const d = dayLabel(g.ts), head = d !== day ? `<div class="hist-day">${esc(d)}</div>` : ''; day = d;
    const add = g.versions.reduce((n, v) => n + (Number(v.added) || 0), 0), del = g.versions.reduce((n, v) => n + (Number(v.removed) || 0), 0);
    const files = g.versions.map((v) => v.file);
    return `${head}<div class="hv${g === sel ? ' sel' : ''}" data-id="${esc(g.versions[0].id)}" tabindex="0">
      <div class="hv-top"><span class="hv-time">${esc(hhmm(g.ts))}</span><span class="badge src-${esc(g.source)}">${srcHtml(g)}</span><span class="spacer"></span><span class="hv-add">+${add}</span><span class="hv-del">−${del}</span></div>
      ${g.label ? `<div class="hv-chips"><span class="hv-chip" title="Label" data-brand-keep>${ic('ref')}${esc(g.label)}</span></div>` : ''}${h.all ? `<div class="hv-file muted" title="${esc(files.join('\n'))}">${files.length > 1 ? `${files.length} files: ` : ''}${esc(files.slice(0, 3).join(', '))}${files.length > 3 ? ` +${files.length - 3}` : ''}</div>` : ''}</div>`;
  }).join('') || `<div class="muted hist-empty">${h.filter === 'labels' ? 'No labelled versions yet.<br>Use the tag button above to name one.' : !h.all && !W.active ? 'Open a file to see its history.' : 'No versions recorded yet.<br>Versions appear as you edit and save.'}</div>`;
  if (h.sel && !sel) h.sel = null;
  if (!h.sel) renderDiffEmpty();
}
const histPick = (el) => { if (el) { W.hist.sel = el.dataset.id; renderHistory(); loadDiff().catch((e) => toast(e.message, 'bad')); } };
$('#hist-list').addEventListener('click', (e) => histPick(e.target.closest('.hv')));
$('#hist-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); histPick(e.target.closest('.hv')); } });

const diffLine = (r) => `<div class="dl ${r.t}"><span class="ln">${r.a}</span><span class="ln">${r.b}</span><span class="sg">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''}</span><span class="tx">${esc(String(r.text ?? '').replace(/\r?\n$/, ''))}</span></div>`;
async function loadDiff() {
  const h = W.hist, v = histSel(), g = histGroup(), host = $('#diff-view'); if (!v) return;
  const seq = ++h.seq2;
  host.innerHTML = '<div class="empty">Loading…</div>';
  let r;
  try { if (h.against === 'current') await flushAll(); r = await api(pUrl(`/history/${enc(v.id)}/diff?against=${h.against}`)); }
  catch (e) { if (seq === h.seq2) host.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (seq !== h.seq2 || h.sel !== v.id) return;
  let a = 0, b = 0;
  const rows = (h.rows = (r.ops || []).map((o) => ({ t: o.t, text: o.text, a: o.t !== 'add' ? ++a : '', b: o.t !== 'del' ? ++b : '' })));
  let body = '', i = 0;
  while (i < rows.length) {
    if (rows[i].t !== 'eq') { body += diffLine(rows[i++]); continue; }
    let j = i; while (j < rows.length && rows[j].t === 'eq') j++;
    if (j - i > 8) { // keep 3 lines of context next to changes, fold the rest
      const head = i === 0 ? 0 : 3, tail = j === rows.length ? 0 : 3;
      body += rows.slice(i, i + head).map(diffLine).join('') + `<button class="dl fold" data-from="${i + head}" data-to="${j - tail}" title="Show these lines">⋯ ${j - i - head - tail} unchanged lines</button>` + rows.slice(j - tail, j).map(diffLine).join('');
    } else body += rows.slice(i, j).map(diffLine).join('');
    i = j;
  }
  const changed = rows.some((x) => x.t !== 'eq');
  const files = h.all && g ? `<div class="diff-files"><span class="muted">${plural(g.versions.length, 'file')} changed in this version:</span>${g.versions.map((x) => `<button class="dfile${x.id === v.id ? ' on' : ''}" data-id="${esc(x.id)}" title="${esc(x.file)}">${ic(fileIcon({ path: x.file, type: 'file' }))}<span>${esc(x.file)}</span><span class="hv-add">+${Number(x.added) || 0}</span><span class="hv-del">−${Number(x.removed) || 0}</span></button>`).join('')}</div>` : '';
  host.innerHTML = `<div class="diff-head">
      <div class="diff-title"><strong>${esc(v.file)}</strong> <span class="muted">${esc(dayLabel(v.ts))} ${esc(hhmm(v.ts))} · ${srcHtml(v)}</span>${v.label ? `<span class="hv-chip" data-brand-keep>${ic('ref')}${esc(v.label)}</span>` : ''}</div>
      <div class="spacer"></div>
      <div class="seg" id="diff-against" role="group" aria-label="Compare with"><button data-against="previous" class="ib${h.against === 'previous' ? ' on' : ''}" title="Changes in this version: what it changed compared with the one before it" aria-label="Changes in this version">${ic('delta')}</button><button data-against="current" class="ib${h.against === 'current' ? ' on' : ''}" title="Compared with now: what has changed between this version and the file as it is now" aria-label="Compared with now">${RT.icon('swap')}</button></div>
      <button id="hist-label" class="ib" title="${v.label ? 'Change or remove the label of this version' : 'Label this version…'}" aria-label="Label this version">${ic('ref')}</button><button id="hist-restore" class="primary ib" title="Restore this version (the current content stays in the history)" aria-label="Restore this version">${RT.icon('reset')}</button>
    </div>${files}
    <div class="diff-body">${changed ? body : `<div class="empty">${h.against === 'current' ? 'No line differences from the file as it is now.' : rows.length ? 'No visible line changes: this version only changed line endings or the final newline.' : 'This version is an empty file.'}</div>`}</div>`;
}
$('#diff-view').addEventListener('click', async (e) => {
  const t = e.target, h = W.hist, v = histSel();
  const fold = t.closest('.fold');
  if (fold) { fold.outerHTML = h.rows.slice(Number(fold.dataset.from), Number(fold.dataset.to)).map(diffLine).join(''); return; }
  const ag = t.closest('#diff-against button'), df = t.closest('.dfile');
  try {
    if (ag) { h.against = ag.dataset.against; await loadDiff(); }
    else if (df) { h.sel = df.dataset.id; await loadDiff(); }
    else if (!v) return;
    else if (t.closest('#hist-label')) {
      const label = await ask({ title: 'Label this version', message: 'Leave it empty to remove the label.', value: v.label || '', okText: 'Save label', icon: 'ref' }); if (label === null) return;
      await api(pUrl(`/history/${enc(v.id)}`), { method: 'PUT', json: { label: label.trim() } });
      await loadHistory(); await loadDiff();
    } else if (t.closest('#hist-restore')) await restoreVersion(v);
  } catch (err) { toast(err.message, 'bad'); }
});
async function restoreVersion(v) {
  if (!(await confirmDlg(`Restore ${v.file} to the version from ${dayLabel(v.ts)} ${hhmm(v.ts)}?\n\nThe current content stays in the history, so this can be undone.`, { title: 'Restore version', okText: 'Restore', icon: 'reset' }))) return;
  if (!(await flushAll())) return toast('Some files could not be saved — resolve that before restoring.', 'bad');
  const r = await api(pUrl(`/history/${enc(v.id)}/restore`), { method: 'POST' });
  await refreshProject();
  const b = W.bufs.get(v.file);
  if (b && b.kind === 'text') { setBufContent(b, r.content, r.hash, r.mtime); b.savedAt = new Date(); }
  await setHistory(false);
  await openFile(v.file);
  renderSaveState();
  toast(`Restored ${v.file}`, 'ok');
  compile();
}

// ---------------- disk sync: pick up anything changed outside the editor (Claude, terminal, another app) ----------------
async function syncOnce() {
  const p = W.project; if (!p || p.missing) return;
  let changed = false;
  try {
    const r = await api(pUrl('', p.id));
    if (!W.project || W.project.id !== p.id) return;
    const before = W.sig;
    applyProject(r);
    changed = W.sig !== before;
    for (const b of [...W.bufs.values()]) {
      if (b.dirty || b.saving || b.closed) continue;
      const listed = !!fileEntry(b.path); // the list leaves out dotfiles, build artefacts and anything past its cap
      if (listed && b.kind !== 'text') { if (b.path === W.active && changed) showArea(); continue; }
      const h0 = b.hash, same = () => !(b.dirty || b.saving || b.closed || b.hash !== h0 || W.bufs.get(b.path) !== b); // not edited or saved meanwhile
      try {
        const f = await api(pUrl(`/file?path=${enc(b.path)}`, p.id));
        if (b.kind === 'text' && same() && f.hash !== b.hash) { setBufContent(b, f.content, f.hash, f.mtime); changed = true; }
      } catch (e) { if (e.status === 404 && same()) { dropTab(b.path); changed = true; } } // really gone from disk
    }
  } catch { return; }
  if (changed) { markErrors(); labelsSoon(); countsSoon(); spellingSoon(); refsSoon(); if (W.hist.on) loadHistory(); if (RT.state.view === 'write') compile(); else W.needCompile = true; }
}
let syncP = null, syncAgain = false;
function syncProject() {
  if (syncP) { syncAgain = true; return syncP; }
  syncP = (async () => { do { syncAgain = false; await syncOnce(); } while (syncAgain); })().catch(() => {}).finally(() => { syncP = null; });
  return syncP;
}

// ---------------- wiring ----------------
let started = false;
async function boot() {
  toolsP = api('/api/fs/tools').then((t) => { W.tools = { ...W.tools, ...t }; }).catch(() => {});
  const id = ls.get('rt-project');
  // come back to where the user was: inside a project, or on the project list
  if (ls.get('rt-write-mode') === 'project' && id && (await openProject(id).catch(() => false))) return;
  setMode('home');
}
RT.registerView({
  id: 'write', title: 'Editor', icon: 'pencil', order: 20, // the header says Editor; elsewhere the text still names it the Write tab
  onShow() {
    if (!started) { started = true; boot().catch((e) => toast(e.message, 'bad')); return; }
    if (W.mode === 'home') { if (RT.projectsHome && RT.projectsHome.show) RT.projectsHome.show(); return; }
    editor.refresh(); pdfResized();
    syncProject().then(() => { if (W.needCompile && RT.state.view === 'write') compile(); }); // changes picked up while another tab was showing
  },
  onDrop: writeDrop, // files dropped on the tree are uploaded into the project
});
RT.claudeContext.register('write', () => {
  const p = W.mode === 'project' ? W.project : null;
  let sel = null; // the text selected in the editor, with the line it starts on
  const buf = p && W.active && !W.hist.on ? activeBuf() : null;
  if (cm && buf && buf.kind === 'text' && cm.somethingSelected()) {
    const text = cm.getSelection();
    if (text.trim()) sel = { kind: 'editor', text: text.slice(0, 4000), line: cm.getCursor('from').line + 1 };
  }
  return {
    label: p ? `· ${p.name}${W.active ? ' / ' + W.active : ''}` : '',
    title: p ? p.path : '',
    context: p && !p.missing ? { projectId: p.id, ...(W.active ? { file: W.active } : {}), ...(sel ? { selection: sel } : {}) } : {},
    dropSelection: () => { if (cm && cm.somethingSelected()) cm.setCursor(cm.getCursor('to')); },
  };
});
// the text selected in the editor goes along with a question to Claude: keep its panel in step with the selection
if (cm) {
  let hadSel = false;
  const selChanged = debounce(() => RT.claudeContext.refresh(), 250);
  cm.on('cursorActivity', () => { const has = cm.somethingSelected(); if (has || hadSel) selChanged(); hadSel = has; });
}
RT.addFlusher('write', flushAll);
RT.on('layout:changed', () => { editor.refresh(); pdfResized(); });
let wasNarrow = narrow();
window.addEventListener('resize', debounce(() => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); applyLayout(); } }, 200)); // the side panel changes between docked and overlay
RT.on('disk:sync', syncProject); // window focus, end of a Claude run: pick up anything changed outside the editor
RT.on('project:changed', (d) => { if (W.project && (!d || !d.id || d.id === W.project.id)) return syncProject(); });
RT.on('projects:changed', (d) => {
  if (!W.project) return null;
  if (d && d.ids) return d.pid && d.pid !== W.project.id ? null : loadPapers(true).then(() => { paintPapers(); renderLib(); }); // papers added / removed in the Library
  return refreshProject().catch(() => {}); // e.g. the project was linked to Overleaf
});

Object.assign(RT.write, { openProject, flushAll, currentProject: () => W.project, sync: syncProject, compile, showHome, peekHome, peeking: () => !!W.peek, mode: () => W.mode, rekeyProject, papers: papersDialog,
  ui: { ic, icon, menu, popover, pickList, ask, confirmDlg, openDialog, dlgActions, download, closeMenus },
  ed: { cm, ok: editor.ok, activeBuf, applyClaude, insertBlock } }); // the editor, for write-ai.js

$('#wr').hidden = true;
applyLayout(); showArea(); renderOutline(); renderLog();
})();
