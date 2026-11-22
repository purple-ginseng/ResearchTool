/* Preferences (the gear in the header, ⌘, / Ctrl+,): one dialog with a section list on the left and a pane per section.
   Replaces the old Settings dialog of core.js and keeps its element ids (#dlg-settings #export-dir #ai-mode #ai-usage
   #ai-features #teach-style #teach-reset #research-lines #lines-reset #backup-dir #backup-pick #backup-auto
   #backup-state #backup-now #set-backups #set-ok #set-cancel).

   Where each preference is stored:
     this browser (localStorage, applied before the first request by ui-boot.js):
       rt.ui.lang   'en' | 'zh'           display language (RT.i18n when it is loaded)
       rt.ui.hints  'fast' | 'normal' | 'off'   the hover hints of tips.js (150 ms, 500 ms, the browser's own tooltips)
       rt.ui.theme  'system' | 'light' | 'dark' <html data-theme> overrides prefers-color-scheme
       rt.ui.startView 'library' | 'overview' | 'last'   the view the page opens on (read by core.js at boot)
       rt-auto-compile, rt-halt-on-error   the Write tab's compile options (read by write.js when the page loads)
     the workspace (settings.json through PUT /api/settings, the server uses them):
       draftLanguage ('zh' | 'en'), aiMode, teachStyle, autoCategorize, categoryLanguage, exportDir, backupDir,
       backupAuto; the research lines through PUT /api/categories/lines

   RT.prefs = { open(pane?), draftLanguage() -> 'zh' | 'en', setDraftLanguage(l) -> Promise, theme(), isDark() }
   events: 'prefs:draftLanguage' (l), 'theme:changed' ({theme, dark}), 'prefs:saved' */
(() => {
  const { $, $$, api, toast, esc, icon, ls, flush } = RT;

  // ---------------- per-browser UI preferences ----------------
  const THEMES = ['system', 'light', 'dark'], HINTS = ['fast', 'normal', 'off'];
  const theme = () => { const t = ls.get('rt.ui.theme', 'system'); return THEMES.includes(t) ? t : 'system'; };
  const hints = () => { const h = ls.get('rt.ui.hints', 'fast'); return HINTS.includes(h) ? h : 'fast'; };
  const uiLang = () => (/^zh/i.test(ls.get('rt.ui.lang', '') || '') ? 'zh' : 'en');
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || (t !== 'light' && !!(mq && mq.matches)); };
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    RT.emit('theme:changed', { theme: t, dark: isDark() });
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (theme() === 'system') RT.emit('theme:changed', { theme: 'system', dark: isDark() }); });
  async function applyLang(l) {
    if (l === uiLang()) return;
    if (RT.i18n && typeof RT.i18n.setLang === 'function') { RT.i18n.setLang(l); return; }
    ls.set('rt.ui.lang', l);
    if (await RT.confirm('The display language changes when the page is reloaded.', { title: 'Display language', okText: 'Reload now' })) { await flush(); location.reload(); }
  }

  // ---------------- the first-draft language (settings.json draftLanguage, cached for the reader) ----------------
  let draftLang = ls.get('rt.note.lang', 'zh') === 'en' ? 'en' : 'zh'; // until /api/settings answers: the old per-browser choice
  const draftLanguage = () => draftLang;
  function setDraftCache(l) { l = l === 'en' ? 'en' : 'zh'; if (l !== draftLang) { draftLang = l; RT.emit('prefs:draftLanguage', l); } }
  async function setDraftLanguage(l) {
    l = l === 'en' ? 'en' : 'zh'; const was = draftLang;
    setDraftCache(l);
    try { await api('/api/settings', { method: 'PUT', json: { draftLanguage: l } }); }
    catch (e) { setDraftCache(was); toast('Could not save the first-draft language: ' + e.message, 'bad'); throw e; }
  }
  api('/api/settings').then(async (s) => {
    // once: the language chosen before it moved to settings.json (localStorage rt.note.lang) becomes the preference
    const old = ls.get('rt.note.lang', null);
    if (!s.draftLanguageSet && (old === 'en' || old === 'zh')) { try { await api('/api/settings', { method: 'PUT', json: { draftLanguage: old } }); s.draftLanguage = old; } catch { /* stays the default */ } }
    if (old !== null) try { localStorage.removeItem('rt.note.lang'); } catch { /* no storage */ }
    setDraftCache(s.draftLanguage);
  }).catch(() => {});

  // ---------------- the dialog ----------------
  const PANES = [['general', 'General', 'settings'], ['claude', 'Claude', 'sparkle'], ['library', 'Library & files', 'folder'], ['write', 'Editor', 'editor']];
  const STARTS = ['library', 'overview', 'last'];
  const startView = () => { const v = ls.get('rt.ui.startView', 'library'); return STARTS.includes(v) ? v : 'library'; };
  const where = (browser) => `<span class="pf-where badge${browser ? ' info' : ''}" title="${browser ? 'Kept in this browser only (localStorage): another browser or computer has its own' : 'Saved in the workspace (settings.json): every browser that opens this workspace uses it'}">${browser ? 'This browser' : 'Workspace'}</span>`;
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-settings" class="prefs" aria-labelledby="pf-title">
  <div class="pf-head"><h3 id="pf-title">Preferences</h3><span class="spacer"></span><button type="button" class="ib" id="pf-close" title="Close without saving (Esc)" aria-label="Close">${icon('close')}</button></div>
  <div class="pf-body">
    <nav class="pf-nav" role="tablist" aria-orientation="vertical" aria-label="Preference sections">
      ${PANES.map(([id, label, ic]) => `<button type="button" role="tab" id="pf-tab-${id}" data-pane="${id}" aria-controls="pf-pane-${id}" title="${label}">${icon(ic)}<span>${label}</span></button>`).join('')}
    </nav>
    <div class="pf-panes">
      <section class="pf-pane" id="pf-pane-general" role="tabpanel" aria-labelledby="pf-tab-general">
        <h4>Display language ${where(true)}</h4>
        <p class="muted">The language of the menus, buttons and messages. Your papers, notes and Claude's answers are never translated.</p>
        <select id="pref-lang" class="pf-narrow" aria-label="Display language" data-i18n-skip><option value="en">English</option><option value="zh">中文（简体）</option></select>
        <h4>Hints on hover ${where(true)}</h4>
        <p class="muted">A short hint saying what a button does, shown when the pointer rests on it or the keyboard focuses it.</p>
        <label class="set-check"><input type="checkbox" id="pref-hints"> Show hints on hover</label>
        <div class="set-row"><label for="pref-hint-delay" class="pf-lab">Show after</label>
          <select id="pref-hint-delay" class="pf-narrow"><option value="fast">Fast — 0.15 s</option><option value="normal">Normal — 0.5 s</option></select></div>
        <h4>Theme ${where(true)}</h4>
        <div class="seg pf-seg" role="radiogroup" aria-label="Theme" id="pref-theme">
          <button type="button" role="radio" data-theme-pick="system" title="Follow the light or dark setting of the system">${icon('monitor')}<span>System</span></button>
          <button type="button" role="radio" data-theme-pick="light" title="Always light">${icon('sun')}<span>Light</span></button>
          <button type="button" role="radio" data-theme-pick="dark" title="Always dark">${icon('moon')}<span>Dark</span></button>
        </div>
        <h4>Start on ${where(true)}</h4>
        <p class="muted">The view the app opens on when the page is loaded.</p>
        <div class="seg pf-seg" role="radiogroup" aria-label="Start on" id="pref-start">
          <button type="button" role="radio" data-start-pick="library" title="Open on the Library">${icon('library')}<span>Library</span></button>
          <button type="button" role="radio" data-start-pick="overview" title="Open on the Overview">${icon('dashboard')}<span>Overview</span></button>
          <button type="button" role="radio" data-start-pick="last" title="Open on the view you used last">${icon('history')}<span>Last used</span></button>
        </div>
      </section>

      <section class="pf-pane" id="pf-pane-claude" role="tabpanel" aria-labelledby="pf-tab-claude" hidden>
        <h4>First-draft language ${where(false)}</h4>
        <p class="muted">The language Claude writes a reading note's first draft in (“Generate first draft”), and the language of “Ask Claude” answers and figure captions in a note. The note's “More” menu changes the same setting.</p>
        <select id="pref-draft-lang" class="pf-narrow" aria-label="First-draft language" data-i18n-skip><option value="zh">中文</option><option value="en">English</option></select>
        <h4>Claude usage ${where(false)}</h4>
        <p class="muted">How much the AI features (grouping, key points, drafts, diagrams, quizzes, explanations) may spend. The Claude panel is not affected.</p>
        <select id="ai-mode" aria-label="Claude usage">
          <option value="economy">Economy — least tokens: quick answers, a lighter model for small tasks, drafts from the text only (no figures)</option>
          <option value="balanced">Balanced — quick small tasks, careful diagrams, quizzes and drafts (recommended)</option>
          <option value="quality">Best quality — Claude thinks as long as it wants; uses the most tokens</option>
        </select>
        <p class="muted" id="ai-usage"></p>
        <table class="ai-features" id="ai-features" hidden></table>
        <h4>How Claude explains ${where(false)}</h4>
        <p class="muted">This instruction is added to every explanation automatically — in the Claude panel, “Ask Claude” in a note, diagram examples and quiz explanations — so you never have to type it. Edit it to change how Claude teaches.</p>
        <textarea id="teach-style" rows="8" maxlength="3000" spellcheck="false" aria-label="How Claude explains" data-i18n-skip></textarea>
        <div><button id="teach-reset" type="button" title="Put the built-in teaching style back">Reset to the built-in style</button></div>
        <h4>Research lines Claude should prefer ${where(false)}</h4>
        <p class="muted">When Claude groups your papers it files each one under the research line it builds on (its background, preliminaries and the methods it extends), not its application words. One line per row, optionally “Name: what belongs there”; write “Line / Sub-line” for a sub-line. Claude prefers these names and adds a line only when none fits. An empty box gives Claude no preferred lines; “Reset to the built-in lines” brings the list back.</p>
        <textarea id="research-lines" rows="7" maxlength="3000" spellcheck="false" aria-label="Research lines Claude should prefer" data-i18n-skip></textarea>
        <div><button id="lines-reset" type="button" title="Put the built-in list of research lines back">Reset to the built-in lines</button></div>
        <h4>Grouping on import ${where(false)}</h4>
        <label class="set-check"><input type="checkbox" id="pref-auto-cat"> Group newly imported papers automatically</label>
        <div class="set-row"><label for="pref-cat-lang" class="pf-lab">Names of new categories</label>
          <select id="pref-cat-lang" class="pf-narrow"><option value="auto">Follow existing categories</option><option value="en">English</option><option value="zh">中文</option></select></div>
      </section>

      <section class="pf-pane" id="pf-pane-library" role="tabpanel" aria-labelledby="pf-tab-library" hidden>
        <h4>Export folder ${where(false)}</h4>
        <p class="muted">“Export references” writes these files here:</p>
        <p class="pf-files"><code>references.bib</code><code>notes.md</code><code>library.csv</code><code>notes/&lt;citekey&gt;.md</code></p>
        <p class="muted">The last is one Markdown file per reading note. Use an absolute path, e.g. your LaTeX project folder.</p>
        <input type="text" id="export-dir" spellcheck="false" aria-label="Export folder" data-i18n-skip>
        <h4>Backup ${where(false)}</h4>
        <p class="muted">A dated copy of the whole workspace — references, PDFs, notes, highlights, diagrams, quizzes, projects, history and the trash — is kept in this folder. Files that did not change take no extra space. Choose a folder on another disk or in iCloud Drive to be safe when this Mac fails. Projects opened from a folder on disk are not part of it.</p>
        <div class="set-row"><input type="text" id="backup-dir" spellcheck="false" aria-label="Backup folder" placeholder="/path/to/backup/folder" data-i18n-skip><button id="backup-pick" type="button" class="ib" title="Choose the backup folder…" aria-label="Choose the backup folder">${icon('folder')}</button></div>
        <label class="set-check"><input type="checkbox" id="backup-auto"> Back up automatically once a day while the app is running</label>
        <p class="muted" id="backup-state" role="status"></p>
        <div class="set-row"><button id="backup-now" type="button" title="Save the preferences and take a backup right now">Back up now</button><button id="set-backups" type="button" title="See the backups and put one back">Show and restore backups…</button></div>
      </section>

      <section class="pf-pane" id="pf-pane-write" role="tabpanel" aria-labelledby="pf-tab-write" hidden>
        <h4>Compile ${where(true)}</h4>
        <p class="muted">The same options as the menu next to “Compile” in the Editor. A change here applies when the page is next loaded.</p>
        <label class="set-check"><input type="checkbox" id="pref-auto-compile"> Auto compile: compile after every autosave</label>
        <label class="set-check"><input type="checkbox" id="pref-halt"> Stop on first error</label>
      </section>
    </div>
  </div>
  <div class="dlg-actions pf-actions"><span class="muted pf-foot">Saved when you press Save.</span><span class="spacer"></span><button id="set-cancel" type="button">Cancel</button><button class="primary" id="set-ok" type="button">Save</button></div>
</dialog>`);

  const dlg = $('#dlg-settings');
  let pickedTheme = theme(), pickedStart = startView();
  function showPane(id) {
    if (!PANES.some(([p]) => p === id)) id = 'general';
    for (const b of $$('.pf-nav [data-pane]', dlg)) { const on = b.dataset.pane === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
    for (const p of $$('.pf-pane', dlg)) p.hidden = p.id !== 'pf-pane-' + id;
    ls.set('rt.ui.prefsPane', id);
  }
  $('.pf-nav', dlg).addEventListener('click', (e) => { const b = e.target.closest('[data-pane]'); if (b) showPane(b.dataset.pane); });
  $('.pf-nav', dlg).addEventListener('keydown', (e) => { // arrow keys move between the sections
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const tabs = $$('.pf-nav [data-pane]', dlg), i = tabs.indexOf(document.activeElement);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); tabs[j].focus(); showPane(tabs[j].dataset.pane);
  });
  function markTheme(t) { pickedTheme = t; for (const b of $$('[data-theme-pick]', dlg)) { const on = b.dataset.themePick === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); } }
  function markStart(v) { pickedStart = v; for (const b of $$('[data-start-pick]', dlg)) { const on = b.dataset.startPick === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); } }
  $('#pref-start').addEventListener('click', (e) => { const b = e.target.closest('[data-start-pick]'); if (b) markStart(b.dataset.startPick); });
  // a radio group: the arrow keys move the choice (theme and start view)
  for (const g of [$('#pref-theme'), $('#pref-start')]) g.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const bs = $$('[role=radio]', g), i = Math.max(0, bs.indexOf(document.activeElement)), n = bs[(i + (/Right|Down/.test(e.key) ? 1 : -1) + bs.length) % bs.length];
    e.preventDefault(); n.focus(); n.click();
  });
  $('#pref-theme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme-pick]'); if (b) { markTheme(b.dataset.themePick); applyTheme(pickedTheme); } }); // previewed at once, Cancel puts it back
  $('#pref-hints').addEventListener('change', (e) => { $('#pref-hint-delay').disabled = !e.target.checked; });

  async function open(pane) {
    try {
      const s = await api('/api/settings'), u = s.aiUsage || {}, k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1000 ? Math.round(n / 1000) + ' k' : String(n || 0));
      // this browser
      $('#pref-lang').value = uiLang();
      const h = hints(); $('#pref-hints').checked = h !== 'off'; $('#pref-hint-delay').value = h === 'normal' ? 'normal' : 'fast'; $('#pref-hint-delay').disabled = h === 'off';
      markTheme(theme()); markStart(startView());
      $('#pref-auto-compile').checked = ls.get('rt-auto-compile', '1') !== '0'; $('#pref-halt').checked = ls.get('rt-halt-on-error', '0') === '1';
      // the workspace
      setDraftCache(s.draftLanguage); $('#pref-draft-lang').value = draftLang;
      $('#export-dir').value = s.exportDir; $('#ai-mode').value = s.aiMode || 'balanced';
      $('#teach-style').value = s.teachStyle || ''; $('#teach-reset').dataset.def = s.teachDefault || '';
      $('#pref-auto-cat').checked = s.autoCategorize !== false; $('#pref-cat-lang').value = s.categoryLanguage || 'auto';
      $('#backup-dir').value = s.backupDir || ''; $('#backup-auto').checked = s.backupAuto !== false;
      $('#backup-state').textContent = ''; if (RT.safety && RT.safety.backupState) RT.safety.backupState($('#backup-state'));
      $('#ai-usage').textContent = u.week && u.week.calls ? `AI features today: ${u.today.calls} calls, ${k(u.today.tokens)} tokens · last 7 days: ${u.week.calls} calls, ${k(u.week.tokens)} tokens` : 'No AI calls recorded yet.';
      // what each feature used in the last 7 days, and how long one of its calls takes on average
      const NAMES = { grouping: 'Grouping', brief: 'Briefs', 'key-points': 'Key points', ask: 'Explanations', translate: 'Translations', quiz: 'Quizzes', draft: 'Note drafts', diagram: 'Diagrams', 'diagram-explain': 'Diagram examples', chat: 'Claude panel', rewrite: 'Rewrites in the editor', 'related-work': 'Related-work drafts', compare: 'Tables and questions across papers' };
      const secs = (f) => (f.timed ? (f.ms / f.timed / 1000).toFixed(f.ms / f.timed < 9950 ? 1 : 0) + ' s' : '—');
      const rows = Object.entries(u.byFeature || {}).sort((a, b) => b[1].tokens - a[1].tokens);
      $('#ai-features').hidden = !rows.length;
      $('#ai-features').innerHTML = rows.length ? '<tr><th>Last 7 days</th><th>Calls</th><th>Tokens</th><th title="Average time of one call">Time per call</th></tr>'
        + rows.map(([name, f]) => `<tr><td>${esc(NAMES[name] || name)}</td><td>${f.calls}</td><td>${k(f.tokens)}</td><td>${secs(f)}</td></tr>`).join('') : '';
      try { const l = await api('/api/categories/lines'); $('#research-lines').value = l.lines || ''; $('#lines-reset').dataset.def = l.default || ''; } catch { /* older server: the field stays empty */ }
      showPane(pane || ls.get('rt.ui.prefsPane', 'general'));
      if (!dlg.open) dlg.showModal();
    } catch (e) { toast(e.message, 'bad'); }
  }
  // closing without Save: a previewed theme goes back
  dlg.addEventListener('close', () => { if (pickedTheme !== theme()) applyTheme(theme()); });
  $('#set-cancel').addEventListener('click', () => dlg.close());
  $('#pf-close').addEventListener('click', () => dlg.close());
  $('#btn-settings').addEventListener('click', () => open());
  $('#btn-settings').title = `Preferences: language, theme, start view, Claude, first-draft language, export folder, backup (${RT.modKey === 'Ctrl' ? 'Ctrl+' : '⌘'},)`;
  $('#btn-settings').setAttribute('aria-label', 'Preferences');
  document.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !document.querySelector('dialog[open]:not(#dlg-settings)')) { e.preventDefault(); if (!dlg.open) open(); }
  });
  $('#set-backups').addEventListener('click', () => { dlg.close(); if (RT.safety) RT.safety.open(); });

  const settingsBody = () => ({ exportDir: $('#export-dir').value, aiMode: $('#ai-mode').value, teachStyle: $('#teach-style').value, backupDir: $('#backup-dir').value, backupAuto: $('#backup-auto').checked,
    draftLanguage: $('#pref-draft-lang').value === 'en' ? 'en' : 'zh', autoCategorize: $('#pref-auto-cat').checked, categoryLanguage: $('#pref-cat-lang').value });
  // the native folder chooser of macOS; when it is not available the path is typed
  $('#backup-pick').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await api('/api/fs/pick', { method: 'POST', json: { prompt: 'Choose the backup folder' } }); if (r.path) $('#backup-dir').value = r.path; }
    catch { $('#backup-state').textContent = 'The folder chooser is not available here: type the full path of the folder instead.'; $('#backup-dir').focus(); }
    b.disabled = false;
  });
  $('#backup-now').addEventListener('click', async (e) => {
    const b = e.currentTarget, st = $('#backup-state');
    b.disabled = true; st.className = 'muted'; st.innerHTML = '<span class="spin"></span> Backing up…';
    try {
      await api('/api/settings', { method: 'PUT', json: settingsBody() }); // the folder as it is typed now
      setDraftCache(settingsBody().draftLanguage);
      const r = await api('/api/backup', { method: 'POST', json: {} });
      toast(`Backup made: ${r.snapshot.files} files in ${r.dir}`, 'ok');
      if (RT.safety && RT.safety.backupState) RT.safety.backupState(st, r);
    } catch (err) { st.className = 'set-bad'; st.textContent = 'The backup failed: ' + err.message; }
    b.disabled = false;
  });
  $('#teach-reset').addEventListener('click', (e) => { $('#teach-style').value = e.currentTarget.dataset.def || ''; });
  $('#lines-reset').addEventListener('click', (e) => { $('#research-lines').value = e.currentTarget.dataset.def || ''; });
  $('#set-ok').addEventListener('click', async () => {
    try {
      const body = settingsBody();
      await api('/api/settings', { method: 'PUT', json: body });
      await api('/api/categories/lines', { method: 'PUT', json: { lines: $('#research-lines').value } });
      setDraftCache(body.draftLanguage);
      // this browser
      const h = !$('#pref-hints').checked ? 'off' : $('#pref-hint-delay').value === 'normal' ? 'normal' : 'fast';
      ls.set('rt.ui.hints', h); document.documentElement.dataset.hints = h; if (RT.tips) RT.tips.configure();
      ls.set('rt.ui.theme', pickedTheme); applyTheme(pickedTheme);
      ls.set('rt.ui.startView', pickedStart);
      const ac = $('#pref-auto-compile').checked ? '1' : '0', ha = $('#pref-halt').checked ? '1' : '0';
      const writeChanged = ac !== (ls.get('rt-auto-compile', '1') !== '0' ? '1' : '0') || ha !== (ls.get('rt-halt-on-error', '0') === '1' ? '1' : '0');
      ls.set('rt-auto-compile', ac); ls.set('rt-halt-on-error', ha);
      const lang = $('#pref-lang').value === 'zh' ? 'zh' : 'en';
      dlg.close();
      RT.emit('prefs:saved');
      toast(writeChanged ? 'Preferences saved. The compile options apply when the page is next loaded.' : 'Preferences saved', 'ok');
      await applyLang(lang);
    } catch (e) { toast(e.message, 'bad'); }
  });

  RT.prefs = { open, draftLanguage, setDraftLanguage, theme, isDark };
})();
