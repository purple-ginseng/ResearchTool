/* Keyboard: the "Go to anything" box and the single-key shortcuts.
   - Cmd/Ctrl+K (or the keyboard button in the header) opens a box that finds a paper by a few letters of its title,
     author, year or cite key, switches tabs and runs the actions of the screen that is showing. The actions are the
     buttons RT.tour.actions() names (the PALETTE list in tour.js) plus the ones listed
     in commands() below.
   - Single keys, only while nothing is being typed (not in an input, a textarea, the note editor or CodeMirror, not
     during input-method composition, not while a dialog or the tour is open): "/" search, J / K next / previous
     paper, 1-6 tabs of the open paper (Alt+1-6 works while typing too), PageDown / PageUp, + - 0 on its PDF, "?"
     the list of keys. Keys inside the list itself (arrows, Enter, Delete ...) are in library-list.js.
   RT.palette.open() / close(). Keep the list of keys in guide.js ("Files & keys") in line with this file. */
(() => {
  const { $, $$, esc, toast } = RT;
  RT.palette = RT.palette || {};
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = MAC ? '⌘' : 'Ctrl+';
  const KEYBOARD = 'keyboard', PAPER = 'paper', DEFAULT_ICON = 'command';
  const TABS = [['notes', 'Notes', 'note'], ['diagram', 'Diagram', 'graph-node'], ['quiz', 'Practice', 'quiz'], ['kp', 'Key points', 'highlight'], ['details', 'Details', 'info'], ['related', 'Related', 'lineage']];
  const STATUS_ICONS = { toread: 'clock', unread: 'clock', reading: 'book-open', done: 'check' };
  const MAX_PAPERS = 40, RECENT = 6;

  const lib = () => RT.library || {};
  const reader = () => RT.reader || {};
  const PP = RT.projectPapers;
  const papers = () => (lib().items ? lib().items() : []);
  const openPaper = () => (RT.state.view === 'library' && reader().current ? reader().current() || null : null);

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-palette" class="pal" aria-label="Go to anything">
  <div class="pal-top">${RT.icon('search')}<input type="text" id="pal-q" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Find a paper or an action…" aria-label="Find a paper or an action"></div>
  <div id="pal-list" role="listbox" aria-label="Papers and actions"></div>
  <div class="pal-foot muted"><span>${RT.kbd(['↑', '↓'])} move</span><span>${RT.kbd('↵')} open or run</span><span>${RT.kbd('Esc')} close</span><span class="spacer"></span><span id="pal-count"></span><span class="pal-mod">${RT.kbd([RT.modKey, 'K'])}</span></div>
</dialog>`);
  const dlg = $('#dlg-palette'), input = $('#pal-q'), listEl = $('#pal-list');
  const PLACEHOLDER = input.placeholder;
  let shown = [];  // the rows on screen, top to bottom
  let at = 0;      // the lit row
  // a paper to pick ("Check lineage of…"): the box lists papers only and runs pick.run(item) on the chosen one
  let pick = null; // { placeholder, run(item), icon }

  // ---------------- what can be run ----------------
  const click = (sel) => () => { const b = $(sel); if (b && !b.disabled) b.click(); };
  function showPaper(id) {
    RT.setView('library');
    lib().select(id);
    const row = $$('#list .item.sel').find((r) => !r.classList.contains('recent')) || $('#list .item.sel');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  // the actions that have no button of the tour: [{ name, keys, icon, run }]
  // the views: "Go to the Library", "Go to Overview" ... (a group of their own)
  function viewCommands() {
    const keys = { library: 'G L', write: 'G W', overview: 'G O' };
    return [...RT.views.values()].sort((a, b) => a.order - b.order).filter((v) => v.id !== RT.state.view)
      .map((v) => ({ name: `Go to ${v.id === 'library' ? 'the Library' : v.title || v.id}`, run: () => (RT.nav && RT.nav.go ? RT.nav.go(v.id) : RT.setView(v.id)), icon: v.icon || DEFAULT_ICON, keys: keys[v.id] || '' }));
  }
  function commands() {
    const out = [], it = openPaper(), inLib = RT.state.view === 'library';
    const add = (name, run, icon = '', keys = '', boost = 0) => out.push({ name, run, icon, keys, boost });
    if (lib().focusSearch) add('Search the library', () => { RT.setView('library'); lib().focusSearch(); }, 'search', '/');
    if ($('#btn-paste-bib')) add('Add papers by arXiv id, DOI, link or BibTeX', () => { RT.setView('library'); click('#btn-paste-bib')(); }, 'paste');
    if (RT.organize) add('Organize from a .md / .bib file…', () => { RT.setView('library'); RT.organize.open(); }, 'list');
    if (it) {
      const now = reader().tabNow ? reader().tabNow() : null;
      TABS.forEach(([id, name, icon], n) => { if (id !== now) add(`Show the ${name} of this paper`, () => reader().tab(id), icon, String(n + 1)); });
      if (reader().hasPdf && reader().hasPdf()) {
        add('Zoom in on the PDF', () => pdfZoom(1), 'zoom-in', '+');
        add('Zoom out of the PDF', () => pdfZoom(-1), 'zoom-out', '-');
        add('Fit the PDF to the width of its pane', () => pdfZoom(0), 'fit-width', '0');
      }
      if (lib().setStatus) {
        const st = lib().statusOf ? lib().statusOf(it) : '';
        for (const [k, label] of Object.entries(lib().STATUS || {})) if (k !== st) add(`Mark this paper as ${label}`, () => lib().setStatus([it.id], { status: k }), STATUS_ICONS[k] || 'check');
        add(it.starred ? 'Remove the star of this paper' : 'Star this paper', () => lib().setStatus([it.id], { starred: !it.starred }), 'star');
      }
      const w = PP.working();
      if (w) add(PP.has(it.id, w.id) ? `Remove this paper from “${w.name}”` : `Add this paper to “${w.name}”`, () => PP.toggle([it.id], { pid: w.id, on: !PP.has(it.id, w.id) }), PP.ICON);
      if (RT.lineage && RT.lineage.check) add('Check lineage of this paper', () => RT.lineage.check([it.id]), RT.lineage.ICON);
      if (PP.projects().length > (w ? 1 : 0)) add('Add this paper to a project…', async () => { const pid = await PP.pick({ title: 'Add this paper to', current: false }); if (pid) await PP.toggle([it.id], { pid, on: true }); }, PP.ICON);
    }
    if (RT.lineage && RT.lineage.check && papers().length) add('Check lineage of…', () => pickPaper({ placeholder: 'Check the lineage of which paper? Type a few letters of its title…', icon: RT.lineage.ICON, run: (i) => RT.lineage.check([i.id]) }), RT.lineage.ICON);
    if (PP.projects().length > 1 || (PP.projects().length && !PP.working())) add('Switch working project…', async () => { const pid = await PP.pick({ title: 'Working project' }); if (pid) { PP.setWorking(pid); toast(`Working project: “${PP.project(pid).name}”`, 'ok'); } }, PP.ICON);
    if (inLib && lib().step && papers().length > 1) {
      add('Open the next paper of the list', () => lib().step(1), 'arrowRight', 'J');
      add('Open the previous paper of the list', () => lib().step(-1), 'arrowLeft', 'K');
    }
    // in the Library's overflow menu now, not on the toolbar: kept reachable from here (the hidden buttons still run them)
    if (inLib && $('#btn-expand-all')) {
      add('Expand all groups', click('#btn-expand-all'), 'expand');
      add('Collapse all groups', click('#btn-collapse-all'), 'collapse');
    }
    if ($('#btn-settings')) add('Preferences: language, theme, Claude usage, export folder, backup', click('#btn-settings'), 'settings', `${RT.modKey === 'Ctrl' ? 'Ctrl+' : '⌘'},`);
    // (only Claude Code signs in and out from the app; the account window of the others shows the status and how to sign in)
    if (RT.account && RT.account.open) add(RT.ai && RT.ai.caps().inAppLogin === false ? 'Claude Code account: status and how to sign in' : 'Claude Code account: sign in or out', () => RT.account.open(), 'user');
    // the items of the header's Help and More menus (a menu is not a button the tour can point at)
    if (RT.guide && RT.guide.open) {
      add('Open the Guide', () => RT.guide.open(), 'book-open');
      add('Show the keyboard shortcuts', () => RT.guide.open('files', 'keys'), KEYBOARD, '?');
    }
    if (RT.diagnostics) add('Copy diagnostics for a bug report', () => RT.diagnostics.copy(), 'copy');
    if (RT.tour && RT.tour.start) {
      add('Take the tour', () => RT.tour.start(), 'compass', '', 40); // first of the tour entries when “tour” is typed
      add('Tour of this screen', () => RT.tour.start({ chapter: RT.tour.forChapterOfView() }), 'compass');
      // one entry per chapter ("Tour: Library"): the names are in tour-steps.js
      for (const c of (RT.tour.chapters ? RT.tour.chapters() : [])) add(c.palette, () => RT.tour.start({ chapter: c.id }), 'compass');
    }
    if (RT.exportReferences) add('Export references…', () => RT.exportReferences(), 'export');
    if (RT.nav && RT.nav.trash && RT.safety) add('Recently deleted…', () => RT.nav.trash(), 'delete');
    if (RT.nav && RT.nav.preferences) add('Backups…', () => RT.nav.preferences('library'), 'archive');
    return out;
  }
  // every action of the screen: the ones above, then the buttons of the tour steps that are on screen
  function actions() {
    const out = commands().map((c) => ({ kind: 'act', name: c.name, keys: c.keys, iconHtml: RT.icon(c.icon || DEFAULT_ICON), run: c.run, boost: c.boost || 0 }));
    const named = new Set(out.map((c) => c.name));
    const seen = new Set(['btn-palette', 'btn-help', 'btn-app-menu', 'btn-tour', 'btn-export']); // the header menus: their items are above
    for (const a of (RT.tour && RT.tour.actions ? RT.tour.actions() : [])) {
      if (seen.has(a.el.id || a.el)) continue;
      seen.add(a.el.id || a.el);
      if (named.has(a.name)) continue;
      const svg = $('svg.ic', a.el); // the button's own icon (our markup)
      out.push({ kind: 'act', name: a.name, keys: '', iconHtml: svg && svg.innerHTML.trim() ? svg.outerHTML : RT.icon(DEFAULT_ICON), run: () => { if (a.el.isConnected && !a.el.disabled) a.el.click(); } });
    }
    return out;
  }
  const paperRow = (i) => ({ kind: 'paper', name: (RT.texPlain ? RT.texPlain(i.fields.title) : i.fields.title) || '(untitled)', sub: [RT.authorsShort(i.fields.author), i.fields.year].filter(Boolean).join(' · '), subHtml: RT.byline(RT.authorsShort(i.fields.author), [i.fields.year]), iconHtml: RT.icon(pick && pick.icon ? pick.icon : PAPER), run: pick ? ((p) => () => p.run(i))(pick) : () => showPaper(i.id) });

  // ---------------- matching ----------------
  // Every word of the query must be in the text: as it is typed (best at the start of the text or of a word), or -
  // for three letters or more - as letters in that order with little between them ("difpol" finds "Diffusion Policy").
  // 0 = no match.
  // Text as it is typed on a keyboard: "$π_{0.5}$" is found by "pi0.5", "Guédon" by "guedon".
  const GREEK = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega' };
  const norm = (text) => String(text == null ? '' : text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[α-ω]/g, (ch) => GREEK[ch] || ch).replace(/ø/g, 'o').replace(/ß/g, 'ss').replace(/[$\\{}^_*]/g, '');
  function score(words, text) {
    const t = norm(text);
    let initials = null; // the first letters of the words: "vla" finds "Vision-Language-Action"
    let total = 0;
    for (const w of words) {
      const i = t.indexOf(w);
      if (i >= 0) { total += 100 - Math.min(i, 60) + (i === 0 || /[\s\-–:;,.(\[/]/.test(t[i - 1]) ? 30 : 0); continue; }
      if (w.length < 3) return 0;
      if (initials === null) initials = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((x) => x[0]).join('');
      if (initials.includes(w)) { total += 70; continue; }
      let p = -1, gaps = 0;
      for (const ch of w) { const n = t.indexOf(ch, p + 1); if (n < 0) return 0; if (p >= 0) gaps += n - p - 1; p = n; }
      if (gaps > w.length * 3) return 0;
      total += Math.max(5, 40 - gaps);
    }
    return total;
  }
  const viewRows = () => viewCommands().map((c) => ({ kind: 'act', name: c.name, keys: c.keys, iconHtml: RT.icon(c.icon), run: c.run }));
  function results(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    const acts = pick ? [] : actions(); // picking a paper: papers only
    const views = pick ? [] : viewRows();
    if (!words.length) {
      const cur = openPaper();
      const recent = papers().filter((i) => i.lastOpened && (pick || !cur || i.id !== cur.id)).sort((a, b) => String(b.lastOpened).localeCompare(String(a.lastOpened))).slice(0, pick ? 12 : RECENT);
      return [{ head: 'Papers opened last', rows: recent.map(paperRow) }, { head: 'Views', rows: views }, { head: 'Actions', rows: acts }];
    }
    const rank = (rows, text) => rows.map((r) => { const s = score(words, text(r)); return [s > 0 ? s + (r.boost || 0) : 0, r]; }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
    // an action is found by its name in the display language too ("脉络" finds "Check lineage of…")
    // ... and by the AI provider's name the row shows ("Antigravity" finds "Tour: The Claude panel" when Antigravity is chosen)
    const shownName = (n) => {
      const i = RT.i18n; if (!i) return '';
      const t = i.lang && i.lang() !== 'en' && i.translate ? i.translate(n) || n : n;
      return i.rebrand ? i.rebrand(t) : t === n ? '' : t;
    };
    const a = rank(acts, (r) => r.name + ' ' + shownName(r.name));
    const v = rank(views, (r) => r.name + ' ' + shownName(r.name));
    // a paper: its title counts most; author, year and cite key are found too
    const p = papers().map((i) => [Math.max(score(words, String(i.fields.title || '')), 0.6 * score(words, [i.fields.title, i.fields.author, i.fields.year, i.citekey].join(' '))), i]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]);
    const more = Math.max(0, p.length - MAX_PAPERS);
    const groups = [{ head: 'Views', rows: v.map(([, r]) => r), top: v.length ? v[0][0] : 0 }, { head: 'Actions', rows: a.map(([, r]) => r), top: a.length ? a[0][0] : 0 },
      { head: more ? `Papers (the best ${MAX_PAPERS} of ${p.length})` : 'Papers', rows: p.slice(0, MAX_PAPERS).map(([, i]) => paperRow(i)), top: p.length ? p[0][0] : 0 }];
    return groups.sort((x, y) => y.top - x.top); // the better match first
  }

  // ---------------- the box ----------------
  function render() {
    const q = input.value.trim();
    const groups = results(q).filter((g) => g.rows.length);
    shown = groups.flatMap((g) => g.rows);
    at = Math.min(at, Math.max(0, shown.length - 1));
    let n = 0;
    const hint = !q && !pick ? `<div class="pal-hint" role="presentation">${RT.icon('search')}<span>${papers().length ? 'Type to find a paper by title, author or key' : 'Your library is empty: add papers on the Library tab first.'}</span></div>` : '';
    listEl.innerHTML = hint + groups.map((g) => `<div class="pal-head section-head" role="presentation"><span class="sh-title">${esc(g.head)}</span><span class="sh-count">${g.rows.length}</span></div>` + g.rows.map((r) => {
      const k = n++;
      return `<div class="pal-row${r.kind === 'paper' ? ' pal-paper' : ''}" role="option" id="pal-o-${k}" data-k="${k}" aria-selected="false"><span class="pal-ic">${r.iconHtml || ''}</span><span class="pal-name"${r.kind === 'paper' ? ' data-i18n-skip' : ''}>${esc(r.name)}</span>${r.sub ? `<span class="pal-sub">${r.subHtml != null ? r.subHtml : esc(r.sub)}</span>` : ''}${r.keys ? `<span class="pal-keys">${RT.kbd(r.keys.split(/(?<=\S)\s+(?=\S)/))}</span>` : ''}</div>`;
    }).join('')).join('');
    if (!shown.length) {
      listEl.append(RT.emptyState({ ill: 'emptySearch', compact: true, title: q ? 'Nothing matches' : 'Nothing to show yet', text: q ? 'Try fewer letters, or a word of the title.' : 'Add papers on the Library tab first.' }));
    }
    $('#pal-count').textContent = q && shown.length ? `${shown.length} found` : '';
    light(false);
    listEl.scrollTop = 0;
  }
  function light(scroll = true) {
    for (const el of $$('.pal-row', listEl)) { const on = Number(el.dataset.k) === at; el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on)); if (on && scroll) el.scrollIntoView({ block: 'nearest' }); }
    if (shown.length) input.setAttribute('aria-activedescendant', 'pal-o-' + at); else input.removeAttribute('aria-activedescendant');
  }
  function move(by) {
    if (!shown.length) return;
    at = Math.abs(by) === 1 ? (at + by + shown.length) % shown.length : Math.max(0, Math.min(shown.length - 1, at + by)); // one step wraps around, a page stops at the ends
    light();
  }
  function run(k = at) {
    const r = shown[k]; if (!r) return;
    close();
    // after the box has closed and the focus is back where it was
    setTimeout(() => { try { const p = r.run(); if (p && p.catch) p.catch((e) => toast(e.message, 'bad')); } catch (e) { toast(e.message || String(e), 'bad'); } }, 0);
  }
  // q: text to start with (RT.nav.search(q)); a click on the header pill passes its event instead
  function open(q) {
    if (dlg.open) return;
    if ($$('dialog[open]').length) return toast('Close the open window first.');
    if (RT.tour && RT.tour.active && RT.tour.active()) RT.tour.end();
    input.value = typeof q === 'string' ? q : ''; at = 0;
    pick = pending; pending = null;
    input.placeholder = pick ? pick.placeholder : PLACEHOLDER;
    dlg.showModal();
    render();
    input.focus();
  }
  function close() { if (dlg.open) dlg.close(); }
  // the box again, for a paper only (the palette's paper search): run(item) on the one chosen
  let pending = null;
  function pickPaper(o) {
    close();
    pending = o;
    open();
  }

  input.addEventListener('input', () => { at = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // Enter and the arrows belong to the input method while it composes
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'PageDown') move(8);
    else if (e.key === 'PageUp') move(-8);
    else if (e.key === 'Enter') run();
    else return;
    e.preventDefault();
  });
  listEl.addEventListener('mousemove', (e) => { const r = e.target.closest('.pal-row'); if (r && Number(r.dataset.k) !== at) { at = Number(r.dataset.k); light(false); } });
  listEl.addEventListener('mousedown', (e) => e.preventDefault()); // the cursor stays in the box
  listEl.addEventListener('click', (e) => { const r = e.target.closest('.pal-row'); if (r) run(Number(r.dataset.k)); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // a click beside the box

  const btn = $('#btn-palette');
  if (btn) {
    // the header's search pill (its icon and key caps are core.js's)
    btn.title = `Go to anything: find a paper or an action (${MOD}K)`;
    btn.addEventListener('click', () => open());
  }

  // ---------------- keys ----------------
  // Cmd+K (Ctrl+K off the Mac) from anywhere, also while typing. In the note editor the same key makes a link of
  // the selected words, so there it is left alone while something is selected.
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.shiftKey || !(MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || String(e.key).toLowerCase() !== 'k') return;
    if (dlg.open) { e.preventDefault(); e.stopPropagation(); return close(); }
    const sel = window.getSelection();
    if (e.target.closest && e.target.closest('.vditor') && sel && !sel.isCollapsed) return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) open();
  }, true);

  const typing = (t) => !!(t && t.closest && (t.isContentEditable || t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .CodeMirror, .vditor')));
  // true when the element the key went to sits in something that scrolls: PageDown / PageUp are then its own
  function scrolls(t) {
    for (let el = t; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
    }
    return false;
  }
  const pdfZoom = (dir) => { if (!reader().pdfZoom || !reader().pdfZoom(dir)) toast(reader().hasPdf && reader().hasPdf() ? 'The PDF is not showing yet.' : 'This paper has no PDF.'); };

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (document.querySelector('dialog[open]') || (RT.tour && RT.tour.active && RT.tour.active())) return;
    const t = e.target, inLib = RT.state.view === 'library', it = openPaper();
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    // Alt+1..6: the tabs of the open paper, also from inside the note or a quiz (by the place of the key: with Alt
    // the Mac types a symbol)
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-6]$/.test(e.code)) {
      if (it && reader().tab) { done(); if (!e.repeat) reader().tab(TABS[Number(e.code.slice(5)) - 1][0]); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(t) || (t.closest && t.closest('.ctx-menu, .menu, .popover'))) return;
    const k = e.key;
    if (k === '/') {
      if (inLib && lib().focusSearch) { done(); lib().focusSearch(); }
      else { const q = $('#pj-q'); if (q && q.getClientRects().length) { done(); q.focus(); q.select(); } }
    } else if (k === '?') { if (RT.guide && RT.guide.open) { done(); RT.guide.open('files', 'keys'); } }
    else if (!inLib) return;
    else if (!e.shiftKey && /^[jk]$/i.test(k)) { if (lib().step) { done(); if (!e.repeat) lib().step(k.toLowerCase() === 'j' ? 1 : -1); } } // (Caps Lock types J / K) // a held key does not race through the papers
    else if (!it) return;
    else if (/^[1-6]$/.test(k)) {
      const quiz = $('#rd-quiz'); // the quiz answers with 1-4 itself
      if (quiz && !quiz.hidden && k < '5' && (quiz.contains(t) || $('#qz-body', quiz))) return;
      if (reader().tab) { done(); reader().tab(TABS[Number(k) - 1][0]); }
    } else if (k === 'PageDown' || k === 'PageUp') {
      if (!scrolls(t) && reader().pdfScroll && reader().pdfScroll(k === 'PageDown' ? 1 : -1)) done();
    } else if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0') {
      if (reader().pdfZoom && reader().pdfZoom(k === '0' ? 0 : k === '+' || k === '=' ? 1 : -1)) done();
    }
  });

  Object.assign(RT.palette, { open, close, pickPaper });
})();
