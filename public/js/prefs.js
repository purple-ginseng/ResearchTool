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
       rt.ui.icons  'sketch' | 'classic'  this browser's copy of the workspace setting iconStyle (settings.json, sent
                    with PUT /api/settings; the icon set RT.icon draws): ui-boot.js reads it, so the first paint has
                    the right icons, and it is corrected on load when the workspace says otherwise
     the workspace (settings.json through PUT /api/settings, the server uses them):
       draftLanguage ('zh' | 'en'), aiMode, teachStyle, autoCategorize, categoryLanguage, exportDir, backupDir,
       backupAuto, autoUpdate (the Updates part of General: its line and buttons are painted by update.js); the
       research lines through PUT /api/categories/lines

   RT.prefs = { open(pane?), draftLanguage() -> 'zh' | 'en', setDraftLanguage(l) -> Promise, theme(), isDark() }
   events: 'prefs:draftLanguage' (l), 'theme:changed' ({theme, dark}), 'prefs:saved'; RT.icon.setStyle emits
   'icons:style' when the icon set changes */
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

  // ---------------- the icon set (settings.json iconStyle; this browser's copy is rt.ui.icons) ----------------
  // RT.icon.setStyle redraws every icon on the page at once, so nothing needs a reload
  let savedIcons = icon.style();
  function iconsSaved(style) { savedIcons = icon.styles.includes(style) ? style : icon.styles[0]; ls.set('rt.ui.icons', savedIcons); icon.setStyle(savedIcons); }

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
    iconsSaved(s.iconStyle); // (another browser may have changed it: the copy of this one is put right)
  }).catch(() => {});

  // ---------------- the dialog ----------------
  const PANES = [['general', 'General', 'settings'], ['claude', 'AI', 'sparkle'], ['library', 'Library & files', 'folder'], ['write', 'Editor', 'editor']];
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
        <h4>Icon style ${where(false)}</h4>
        <p class="muted">How the icons are drawn: by hand with a fountain pen (the app's own set), or as plain lines of one weight.</p>
        <div class="seg pf-seg" role="radiogroup" aria-label="Icon style" id="pref-icons">
          <button type="button" role="radio" data-icons-pick="sketch" title="Hand-drawn icons: the app's own drawings, as if made with a fountain pen">${icon('library', { style: 'sketch' })}<span>Hand-drawn</span></button>
          <button type="button" role="radio" data-icons-pick="classic" title="Classic icons: plain lines of one weight">${icon('library', { style: 'classic' })}<span>Classic</span></button>
        </div>
        <div id="pref-speech" hidden>
        <h4>Speech ${where(true)}</h4>
        <div id="pref-natural">
        <p class="muted">Papers and notes are read aloud by a neural voice (Qwen3-TTS) with the tone and pauses of a person reading. It is fetched once and runs on this computer, so what is read never leaves it.</p>
        <p class="muted" id="pref-natural-state" role="status"></p>
        <div class="set-row"><button type="button" id="pref-natural-get" title="Fetch the engine (onnxruntime, from the npm registry) and the model (from Hugging Face) once. Every file is checked against its known checksum.">Download the voice</button><button type="button" id="pref-natural-cancel" hidden>Cancel the download</button><button type="button" id="pref-natural-remove" hidden title="Delete the engine and the model from this computer again">Remove the voice</button><progress id="pref-natural-bar" max="100" value="0" hidden></progress></div>
        <div class="set-row" data-natural-row hidden><label for="pref-natural-zh" class="pf-lab">Chinese voice</label>
          <select id="pref-natural-zh" data-natural-lang="zh-CN" class="pf-narrow"></select>
          <button type="button" class="ib" data-natural-test="zh-CN" title="Hear this voice" aria-label="Hear the Chinese voice">${icon('speaker')}</button></div>
        <div class="set-row" data-natural-row hidden><label for="pref-natural-en" class="pf-lab">English voice</label>
          <select id="pref-natural-en" data-natural-lang="en-US" class="pf-narrow"></select>
          <button type="button" class="ib" data-natural-test="en-US" title="Hear this voice" aria-label="Hear the English voice">${icon('speaker')}</button></div>
        </div>
        <div class="set-row"><label for="pref-dict-lang" class="pf-lab">Dictation language</label>
          <select id="pref-dict-lang" class="pf-narrow"><option value="">Same as the note</option><option value="en-US">English</option><option value="zh-CN" data-i18n-skip>中文</option></select></div>
        </div>
        <h4>Start on ${where(true)}</h4>
        <p class="muted">The view the app opens on when the page is loaded.</p>
        <div class="seg pf-seg" role="radiogroup" aria-label="Start on" id="pref-start">
          <button type="button" role="radio" data-start-pick="library" title="Open on the Library">${icon('library')}<span>Library</span></button>
          <button type="button" role="radio" data-start-pick="overview" title="Open on the Overview">${icon('dashboard')}<span>Overview</span></button>
          <button type="button" role="radio" data-start-pick="last" title="Open on the view you used last">${icon('history')}<span>Last used</span></button>
        </div>
        <h4>Updates ${where(false)}</h4>
        <label class="set-check"><input type="checkbox" id="pref-auto-update"> Keep ResearchTool up to date automatically</label>
        <p class="muted">When ticked, ResearchTool asks GitHub about once a day whether there is a newer version, and downloads and installs the new program code by itself, without asking each time. The request is anonymous: nothing about you, your library or your notes is sent, and your workspace and backups are never touched. After an update, restart ResearchTool to finish it. Off unless you tick it; “Check for updates now” and “Update now” work either way, and ask GitHub only when you press them.</p>
        <p class="muted" id="update-state" role="status"></p>
        <div class="set-row"><button id="update-check" type="button" title="Ask GitHub now whether there is a newer version. Nothing is installed.">Check for updates now</button><button id="update-apply" type="button" title="Download the newer version from GitHub and install it now. ResearchTool has to be restarted afterwards." hidden>Update now</button></div>
      </section>

      <section class="pf-pane" id="pf-pane-claude" role="tabpanel" aria-labelledby="pf-tab-claude" hidden>
        <h4>AI provider ${where(false)}</h4>
        <p class="muted" data-brand-keep>The command-line AI tool on this computer that the AI features use, signed in with your own account. ResearchTool never asks for an API key and never stores one.</p>
        <div class="set-row"><select id="ai-provider" class="pf-narrow" aria-label="AI provider" data-i18n-skip></select><button id="ai-check" type="button" class="ib" title="Check again whether it is installed and signed in" aria-label="Check again">${icon('refresh')}</button></div>
        <div id="ai-status" class="pf-ai-status" role="status" data-brand-keep></div>
        <div id="ai-other" data-brand-keep hidden>
          <p class="muted" id="ai-caps"></p>
          <div class="set-row"><label for="ai-model" class="pf-lab">Model</label><input type="text" id="ai-model" class="pf-narrow" spellcheck="false" maxlength="80" placeholder="the CLI's default" aria-label="Model" data-i18n-skip></div>
          <div class="set-row"><label for="ai-cat-model" class="pf-lab">Model for grouping</label><input type="text" id="ai-cat-model" class="pf-narrow" spellcheck="false" maxlength="80" placeholder="the same model" aria-label="Model for grouping" data-i18n-skip></div>
          <label class="set-check"><input type="checkbox" id="ai-env-key"> <span id="ai-env-key-text">Use an API key from the environment ResearchTool was started with, instead of my account</span></label>
          <div id="ai-edits-box" hidden>
            <label class="set-check"><input type="checkbox" id="ai-panel-edits"> <span>Let Codex edit files in the AI panel</span></label>
            <p class="muted">It runs in Codex's workspace-write sandbox: it can change the files of the open project and your reading notes, nothing else of the workspace, with no network. Each change to a LaTeX project is recorded in the project history and can be restored. Off unless you tick it.</p>
          </div>
        </div>
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
  let pickedTheme = theme(), pickedStart = startView(), pickedIcons = savedIcons;
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
  function markIcons(v) { pickedIcons = v; for (const b of $$('[data-icons-pick]', dlg)) { const on = b.dataset.iconsPick === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); } }
  const withIcons = (body) => ({ ...body, iconStyle: pickedIcons }); // what PUT /api/settings gets: settingsBody() and the icon style picked here
  $('#pref-start').addEventListener('click', (e) => { const b = e.target.closest('[data-start-pick]'); if (b) markStart(b.dataset.startPick); });
  $('#pref-icons').addEventListener('click', (e) => { const b = e.target.closest('[data-icons-pick]'); if (b) { markIcons(b.dataset.iconsPick); icon.setStyle(pickedIcons); } }); // previewed at once, Cancel puts it back
  // a radio group: the arrow keys move the choice (theme, icon style and start view)
  for (const g of [$('#pref-theme'), $('#pref-icons'), $('#pref-start')]) g.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const bs = $$('[role=radio]', g), i = Math.max(0, bs.indexOf(document.activeElement)), n = bs[(i + (/Right|Down/.test(e.key) ? 1 : -1) + bs.length) % bs.length];
    e.preventDefault(); n.focus(); n.click();
  });
  $('#pref-theme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme-pick]'); if (b) { markTheme(b.dataset.themePick); applyTheme(pickedTheme); } }); // previewed at once, Cancel puts it back
  $('#pref-hints').addEventListener('change', (e) => { $('#pref-hint-delay').disabled = !e.target.checked; });
  // ---------------- speech (speech.js): the voice that reads (lib/voice on the server) and dictation ----------------
  async function fillSpeech() {
    const S = RT.speech, box = $('#pref-speech');
    if (!S || !(S.supported.tts || S.supported.stt)) { box.hidden = true; return; }
    box.hidden = false;
    $('#pref-dict-lang').value = S.prefs().lang;
    $('#pref-dict-lang').closest('.set-row').hidden = !S.supported.stt;
    $('#pref-natural').hidden = !S.supported.tts;
    naturalFilled = false;
    if (S.supported.tts) showNatural(await S.natural(true));
  }
  let naturalFilled = false, naturalTimer = 0;

  // the voice: its state, the download, its speakers
  const NATURAL_NAME = { serena: 'Serena', vivian: 'Vivian', uncle_fu: 'Uncle Fu', dylan: 'Dylan (Beijing dialect)', eric: 'Eric (Sichuan dialect)', ryan: 'Ryan', aiden: 'Aiden' };
  const NATURAL_PROBLEM = {
    offline: 'The download stopped: there was no connection. Press Download to continue it.',
    hash: 'A downloaded file was not the expected one, so nothing was installed.',
    disk: 'The files could not be written. Is the disk full?',
    gpu: 'The voice needs a graphics processor (WebGPU) that this computer does not offer here.',
    engine: 'The voice could not start on this computer.',
  };
  const mb = (n) => String(Math.round(n / 1e6));
  function showNatural(st) {
    const tr = (t, ...a) => (RT.i18n ? RT.i18n.t(t, ...a) : t.replace(/\{(\d)\}/g, (m, k) => a[k]));
    const state = $('#pref-natural-state'), get = $('#pref-natural-get'), cancel = $('#pref-natural-cancel'), remove = $('#pref-natural-remove'), bar = $('#pref-natural-bar');
    clearTimeout(naturalTimer);
    const rows = $$('[data-natural-row]', $('#pref-natural'));
    if (!st) { state.textContent = tr('The voice did not answer. Is ResearchTool still running?'); for (const el of [get, cancel, remove, bar, ...rows]) el.hidden = true; return; }
    const sentence = !st.supported ? (st.reason === 'node' ? tr('The voice needs Node.js 18 or newer.') : tr('There is no voice for this kind of computer.'))
      : st.installing ? tr('Downloading: {0} of {1} MB', mb(st.done), mb(st.total))
        : st.installed ? (st.problem ? tr(NATURAL_PROBLEM[st.problem] || 'The voice could not start on this computer.') : tr('Installed. While it reads it uses about 1 GB of memory, which is given back a few minutes later.'))
          : st.problem ? tr(NATURAL_PROBLEM[st.problem] || 'The download failed.')
            : st.partial ? tr('Not installed yet: a download was started and can be continued. Its files are kept until then.')
              : tr('Not installed yet, so nothing is read aloud. One download of about {0} MB.', mb(st.bytes));
    if (state.textContent !== sentence) state.textContent = sentence;
    get.hidden = !st.supported || st.installing || st.installed;
    cancel.hidden = !st.installing;
    remove.hidden = !(st.installed || st.partial) || st.installing;
    remove.textContent = tr(st.installed ? 'Remove the voice' : 'Delete what was downloaded');
    bar.hidden = !st.installing; bar.value = st.total ? Math.round(st.done / st.total * 100) : 0;
    for (const r of rows) r.hidden = !st.installed;
    if (st.installed && !naturalFilled) {
      const p = RT.speech.prefs();
      for (const sel of $$('select[data-natural-lang]', $('#pref-natural'))) {
        const lang = sel.dataset.naturalLang, list = [...st.voices.filter((v) => v.lang === lang), ...st.voices.filter((v) => v.lang !== lang)];
        sel.textContent = '';
        for (const v of list) { const o = document.createElement('option'); o.value = v.id; o.textContent = tr(NATURAL_NAME[v.id] || v.id); sel.append(o); }
        sel.value = list.some((v) => v.id === p.natural[lang]) ? p.natural[lang] : st.defaults[lang];
      }
      naturalFilled = true;
    }
    if (!st.installed) naturalFilled = false;
    if (st.installing && $('#pref-speech').closest('dialog').open) naturalTimer = setTimeout(() => RT.speech.natural(true).then(showNatural), 1000);
  }
  const naturalCall = (url, method) => RT.api(url, { method }).then((st) => { showNatural(st); return RT.speech.natural(true); }).then(showNatural).catch((e) => RT.toast(e.message, 'bad'));
  $('#pref-natural-get').addEventListener('click', () => naturalCall('/api/voice/install', 'POST'));
  $('#pref-natural-cancel').addEventListener('click', () => naturalCall('/api/voice/cancel', 'POST'));
  $('#pref-natural-remove').addEventListener('click', async () => {
    const st = await RT.speech.natural(true);
    if (st && st.installed && !(await RT.confirm('Remove the voice from this computer? Nothing is read aloud until it is downloaded again.', { title: 'Voice', okText: 'Remove' }))) return;
    RT.speech.stop();
    naturalCall('/api/voice', 'DELETE');
  });
  $('#pref-speech').addEventListener('click', (e) => {
    const n = e.target.closest('[data-natural-test]');
    if (n) RT.speech.sample(n.dataset.naturalTest, $('#pref-natural').querySelector('select[data-natural-lang="' + n.dataset.naturalTest + '"]').value);
  });
  { const dlgEl = $('#pref-speech').closest('dialog'); if (dlgEl) dlgEl.addEventListener('close', () => { clearTimeout(naturalTimer); if (RT.speech) RT.speech.stop('sample'); }); } // a sample stops with the dialog
  const saveSpeech = () => {
    const S = RT.speech; if (!S || !(S.supported.tts || S.supported.stt)) return;
    // a speaker is stored only from a list that was filled
    const natural = {};
    if (naturalFilled) for (const sel of $$('select[data-natural-lang]', $('#pref-natural'))) natural[sel.dataset.naturalLang] = sel.value;
    S.setPrefs({ natural, lang: $('#pref-dict-lang').value });
  };

  async function open(pane) {
    try {
      const s = await api('/api/settings'), u = s.aiUsage || {}, k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1000 ? Math.round(n / 1000) + ' k' : String(n || 0));
      // this browser
      $('#pref-lang').value = uiLang();
      const h = hints(); $('#pref-hints').checked = h !== 'off'; $('#pref-hint-delay').value = h === 'normal' ? 'normal' : 'fast'; $('#pref-hint-delay').disabled = h === 'off';
      markTheme(theme()); markStart(startView());
      fillSpeech().catch((e) => console.error(e));
      $('#pref-auto-compile').checked = ls.get('rt-auto-compile', '1') !== '0'; $('#pref-halt').checked = ls.get('rt-halt-on-error', '0') === '1';
      // the workspace
      iconsSaved(s.iconStyle); markIcons(savedIcons);
      setDraftCache(s.draftLanguage); $('#pref-draft-lang').value = draftLang;
      $('#export-dir').value = s.exportDir; $('#ai-mode').value = s.aiMode || 'balanced';
      $('#teach-style').value = s.teachStyle || ''; $('#teach-reset').dataset.def = s.teachDefault || '';
      $('#pref-auto-cat').checked = s.autoCategorize !== false; $('#pref-cat-lang').value = s.categoryLanguage || 'auto';
      $('#backup-dir').value = s.backupDir || ''; $('#backup-auto').checked = s.backupAuto !== false;
      $('#backup-state').textContent = ''; if (RT.safety && RT.safety.backupState) RT.safety.backupState($('#backup-state'));
      $('#pref-auto-update').checked = s.autoUpdate === true; if (RT.update && RT.update.show) RT.update.show(); // (not awaited: painted when the answer is there)
      $('#ai-usage').textContent = u.week && u.week.calls ? `AI features today: ${u.today.calls} calls, ${k(u.today.tokens)} tokens · last 7 days: ${u.week.calls} calls, ${k(u.week.tokens)} tokens` : 'No AI calls recorded yet.';
      // what each feature used in the last 7 days, and how long one of its calls takes on average
      const NAMES = { grouping: 'Grouping', brief: 'Briefs', 'key-points': 'Key points', ask: 'Explanations', translate: 'Translations', quiz: 'Quizzes', draft: 'Note drafts', diagram: 'Diagrams', 'diagram-explain': 'Diagram examples', chat: 'AI panel', rewrite: 'Rewrites in the editor', 'related-work': 'Related-work drafts', compare: 'Tables and questions across papers' };
      const secs = (f) => (f.timed ? (f.ms / f.timed / 1000).toFixed(f.ms / f.timed < 9950 ? 1 : 0) + ' s' : '—');
      const rows = Object.entries(u.byFeature || {}).sort((a, b) => b[1].tokens - a[1].tokens);
      $('#ai-features').hidden = !rows.length;
      $('#ai-features').innerHTML = rows.length ? '<tr><th>Last 7 days</th><th>Calls</th><th>Tokens</th><th title="Average time of one call">Time per call</th></tr>'
        + rows.map(([name, f]) => `<tr><td>${esc(NAMES[name] || name)}</td><td>${f.calls}</td><td>${k(f.tokens)}</td><td>${secs(f)}</td></tr>`).join('')
        // the same calls by the provider that made them (the rows above are of every provider): its own name, never
        // renamed to the provider chosen now
        + '<tr><th>By provider</th><th>Calls</th><th>Tokens</th><th title="Average time of one call">Time per call</th></tr>'
        + Object.entries(u.byProvider || {}).sort((a, b) => b[1].calls - a[1].calls)
          .map(([id, f]) => `<tr><td data-brand-keep>${esc(RT.ai ? RT.ai.nameOf(id) : id)}</td><td>${f.calls}</td><td>${k(f.tokens)}</td><td>${secs(f)}</td></tr>`).join('') : '';
      try { const l = await api('/api/categories/lines'); $('#research-lines').value = l.lines || ''; $('#lines-reset').dataset.def = l.default || ''; } catch { /* older server: the field stays empty */ }
      await aiPane.load();
      showPane(pane || ls.get('rt.ui.prefsPane', 'general'));
      if (!dlg.open) dlg.showModal();
    } catch (e) { toast(e.message, 'bad'); }
  }
  // closing without Save: a previewed theme or icon style goes back
  dlg.addEventListener('close', () => { if (pickedTheme !== theme()) applyTheme(theme()); if (icon.style() !== savedIcons) icon.setStyle(savedIcons); if (RT.ai && RT.ai.preview) RT.ai.preview(null); });
  $('#set-cancel').addEventListener('click', () => dlg.close());
  $('#pf-close').addEventListener('click', () => dlg.close());
  $('#btn-settings').addEventListener('click', () => open());
  $('#btn-settings').title = `Preferences: language, theme, icon style, start view, Claude, first-draft language, export folder, backup (${RT.modKey === 'Ctrl' ? 'Ctrl+' : '⌘'},)`;
  $('#btn-settings').setAttribute('aria-label', 'Preferences');
  document.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !document.querySelector('dialog[open]:not(#dlg-settings)')) { e.preventDefault(); if (!dlg.open) open(); }
  });
  $('#set-backups').addEventListener('click', () => { dlg.close(); if (RT.safety) RT.safety.open(); });

  // ---------------- the AI provider (lib/ai): choice, status, hints, model ----------------
  const aiPane = (() => {
    let info = null, status = {}, edits = {}; // edits: id -> {model, categoryModel, useEnvKey, panelEdits} typed in this dialog
    const osKey = () => (/Win/i.test(navigator.platform) ? 'win' : /Mac/i.test(navigator.platform) ? 'mac' : 'linux');
    const prov = (id) => (info && info.providers.find((p) => p.id === id)) || null;
    const sel = () => $('#ai-provider').value || 'claude';
    const cmd = (c) => `<span class="pf-cmd"><code>${esc(c)}</code><button type="button" class="ib" data-ai-copy="${esc(c)}" title="Copy the command" aria-label="Copy the command">${icon('copy')}</button></span>`;
    function keep() { const id = sel(); if (id === 'claude' || !prov(id)) return; edits[id] = { model: $('#ai-model').value.trim(), categoryModel: $('#ai-cat-model').value.trim(), useEnvKey: $('#ai-env-key').checked, panelEdits: !!prov(id).panelWrite && $('#ai-panel-edits').checked }; }
    function paint() {
      const id = sel(), p = prov(id), s = status[id];
      if (!p) return;
      const el = $('#ai-status');
      const data = (t) => `<span data-i18n-skip>${esc(t)}</span>`; // names, versions, accounts: shown as they are
      // a warning is the server's own sentence (translated); a problem is what the CLI printed (shown as it is)
      const extra = s ? (s.warning ? `<br><span class="set-bad">${esc(s.warning)}</span>` : '') + (s.problem ? `<br><span class="muted">${data(s.problem)}</span>` : '') : '';
      if (!s) el.innerHTML = '<span class="spin"></span> Checking…';
      else if (!s.installed) {
        const inst = (p.install && (p.install[osKey()] || p.install.mac)) || p.bin;
        el.innerHTML = `<span class="acct-dot bad"></span> <b>Not installed on this computer.</b> <span>Install it in a terminal, then start ResearchTool again:</span> ${cmd(inst)}${p.install && p.install.alt ? ` ${cmd(p.install.alt)}` : ''}${extra}`;
      } else {
        const state = s.signedIn === true ? 'Installed, signed in' : s.signedIn === false ? 'Installed, not signed in' : 'Installed; the sign-in could not be checked';
        const how = s.signedIn === true ? '' : id === 'claude' ? ' <span>Sign in with the person button in the AI panel.</span>' : p.login ? ` <span>To sign in with your own account, run this in a terminal:</span> ${cmd(p.login)}` : '';
        // what the sign-in needs (Antigravity: run agy once), unless the warning says it already
        const note = s.signedIn !== true && p.loginNote && p.loginNote !== s.warning ? `<br><span class="muted">${esc(p.loginNote)}</span>` : '';
        el.innerHTML = `<span class="acct-dot ${s.signedIn === true ? 'ok' : s.signedIn === false ? 'bad' : 'warn'}"></span> ${data(p.cliName + (s.version ? ' ' + s.version : ''))} · <span>${state}</span>${s.account ? ` (${esc(s.account)})` : ''}.${how}${note}${extra}`;
      }
      const other = id !== 'claude';
      $('#ai-other').hidden = !other;
      if (!other) return;
      const e = edits[id] || { model: p.model || '', categoryModel: p.categoryModel || '', useEnvKey: !!p.useEnvKey, panelEdits: !!p.panelEdits };
      $('#ai-model').value = e.model; $('#ai-cat-model').value = e.categoryModel; $('#ai-env-key').checked = e.useEnvKey;
      // "Let Codex edit files": only for a provider that offers it (Codex); Grok and Antigravity stay read-only
      $('#ai-edits-box').hidden = !p.panelWrite; $('#ai-panel-edits').checked = !!p.panelWrite && !!e.panelEdits;
      $('#ai-env-key-text').innerHTML = `<span>Use an API key from the environment ResearchTool was started with, instead of my account (off unless you tick it):</span> ${(p.keyVars || []).map((k) => `<code data-i18n-skip>${esc(k)}</code>`).join(' ')}`;
      // what the panel does with this provider: as ticked in this dialog (saved or not)
      const panel = !p.panelWrite ? 'With this provider the AI panel is read-only: it reads your files but does not edit them.'
        : e.panelEdits ? 'With this provider the AI panel edits files, because you let it (below).' : 'With this provider the AI panel is read-only unless you let it edit files (below).';
      $('#ai-caps').innerHTML = [panel, 'First drafts are written from the text extracted from the PDF.',
        p.caps && p.caps.readsImage ? 'Questions about a picture in a note work.' : 'Questions about a picture in a note are not possible with this provider.',
        p.panelWrite ? 'Only Claude Code reads PDFs itself.' : 'Only Claude Code (and Codex, when you let it) edits files; only Claude Code reads PDFs itself.', p.configNote || '']
        .filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join(' ');
    }
    async function check(fresh) {
      const id = sel();
      // only the provider on show (each check starts that CLI once: --version, codex login status)
      try { const r = await RT.ai.status(id, fresh); Object.assign(status, r.status); } catch (e) { status[id] = { installed: true, signedIn: null, problem: e.message }; }
      paint();
    }
    async function load() {
      edits = {}; status = {};
      try { info = await api('/api/ai/providers'); } catch { info = { current: 'claude', providers: RT.ai ? RT.ai.providers() : [] }; }
      $('#ai-provider').innerHTML = info.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
      $('#ai-provider').value = info.current;
      paint(); check(false);
    }
    $('#ai-provider').addEventListener('focus', keep);
    // the rest of the dialog names the provider picked here at once ("Ask Codex", "Codex usage"); Cancel puts it back
    const preview = () => { if (RT.ai && RT.ai.preview) RT.ai.preview(sel()); };
    $('#ai-provider').addEventListener('change', () => { paint(); preview(); if (!status[sel()]) check(true); });
    for (const f of ['#ai-model', '#ai-cat-model', '#ai-env-key']) $(f).addEventListener('change', keep);
    $('#ai-panel-edits').addEventListener('change', () => { keep(); paint(); }); // (the sentence about the panel follows it)
    $('#ai-check').addEventListener('click', () => { status[sel()] = null; paint(); check(true); });
    $('#pf-pane-claude').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ai-copy]'); if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.aiCopy); toast('Copied', 'ok'); } catch { toast('Could not copy to the clipboard', 'bad'); }
    });
    // what PUT /api/settings gets: the provider, and the model / key / panel-edit choice of every provider that was edited
    function body() {
      keep();
      const out = { aiProvider: sel() };
      const ids = Object.keys(edits);
      if (ids.length) {
        out.aiProviders = Object.fromEntries(ids.map((id) => [id, { model: edits[id].model, categoryModel: edits[id].categoryModel }]));
        out.aiUseEnvKey = Object.fromEntries(ids.map((id) => [id, edits[id].useEnvKey]));
        // (only providers that offer it: the server refuses the others)
        const w = ids.filter((id) => prov(id) && prov(id).panelWrite);
        if (w.length) out.aiPanelEdits = Object.fromEntries(w.map((id) => [id, edits[id].panelEdits]));
      }
      return info ? out : {};
    }
    return { load, body };
  })();

  const settingsBody = () => ({ ...aiPane.body(), exportDir: $('#export-dir').value, aiMode: $('#ai-mode').value, teachStyle: $('#teach-style').value, backupDir: $('#backup-dir').value, backupAuto: $('#backup-auto').checked,
    draftLanguage: $('#pref-draft-lang').value === 'en' ? 'en' : 'zh', autoCategorize: $('#pref-auto-cat').checked, categoryLanguage: $('#pref-cat-lang').value, autoUpdate: $('#pref-auto-update').checked });
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
      await api('/api/settings', { method: 'PUT', json: withIcons(settingsBody()) }); // the folder as it is typed now
      setDraftCache(settingsBody().draftLanguage); iconsSaved(pickedIcons);
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
      const body = withIcons(settingsBody());
      await api('/api/settings', { method: 'PUT', json: body });
      if (RT.ai) RT.ai.refresh(); // the provider's name on buttons and messages, the panel mode
      await api('/api/categories/lines', { method: 'PUT', json: { lines: $('#research-lines').value } });
      setDraftCache(body.draftLanguage); iconsSaved(body.iconStyle);
      // this browser
      saveSpeech();
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
