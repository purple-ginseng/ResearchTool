/* Categories: colours, small dialogs (ask / confirm), the category header menu and the "Group with Claude" dialog
   (POST /api/categories/regroup streams a PROPOSAL; nothing changes until the user applies it).
   RT.categories: UNCAT, color(name), names(), lineOf(name), subOf(name), isLine(name), idsOf(name), ask(opts),
   menu(x, y, entries), headerMenu(name, x, y), rename(name), remove(name), regroupDialog({scope, category}),
   headerExtras (a list other modules push to: fn(name, {line, ids}) -> menu entries, added at the end of the ⋯ menu
   of a category / line header). Emits 'library:changed' after changes.
   Research lines: a category "Line / Sub-line" is nested under its line in the list; a line and its sub-lines share
   a hue. The ⋯ menu of a line header renames / deletes / re-groups the whole line. */
(() => {
  const { $, $$, esc, api, toast } = RT;
  RT.categories = RT.categories || {};

  const UNCAT = 'Uncategorized';
  // Purple Ginseng: purple, pink, gold first, then distinct hues
  const PALETTE = ['#7b4cc2', '#d1477f', '#c9971a', '#4f6bd8', '#a3378f', '#2f9a8a', '#e07a5f', '#8c6bd6', '#b07d12', '#5e5a8a'];
  const SEP = ' / ';
  const lineOf = (name) => { const s = String(name); const i = s.indexOf(SEP); return i > 0 ? s.slice(0, i) : s; };
  const subOf = (name) => { const s = String(name); const i = s.indexOf(SEP); return i > 0 ? s.slice(i + SEP.length) : ''; };
  /* colour:begin - the same stable hash and shades as colorOf() of lib/categorize.js (scripts/test-categorize.js checks it) */
  const hashOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; };
  const UNCAT_COLOR = '#9aa0a6';
  const SHADES = [-0.32, 0.3, -0.16, 0.46, 0.14, -0.44, 0.6, -0.24, 0.38, 0.06, -0.08, 0.22];
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16), ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return '#' + ch.map((c) => Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f).toString(16).padStart(2, '0')).join('');
  }
  function colorMap(names) {
    const lines = new Map(); // line -> {n, subs}
    for (const nm of names) {
      if (nm === UNCAT) continue;
      const l = lineOf(nm);
      if (!lines.has(l)) lines.set(l, { n: 0, subs: new Set() });
      const e = lines.get(l); e.n++; if (subOf(nm)) e.subs.add(subOf(nm));
    }
    const P = PALETTE.length, used = new Set(), hue = new Map();
    const nested = [...lines].filter(([, e]) => e.subs.size).sort((a, b) => b[1].subs.size - a[1].subs.size || b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [l] of nested) {
      let i = hashOf(l) % P;
      for (let k = 0; k < P && used.has(i); k++) i = (i + 1) % P;
      used.add(i); hue.set(l, PALETTE[i]);
    }
    const free = [...Array(P).keys()].filter((i) => !used.has(i));
    for (const l of lines.keys()) if (!hue.has(l)) hue.set(l, PALETTE[free.length ? free[hashOf(l) % free.length] : hashOf(l) % P]);
    const out = new Map();
    for (const nm of names) {
      if (nm === UNCAT) { out.set(nm, UNCAT_COLOR); continue; }
      const l = lineOf(nm), sub = subOf(nm);
      if (!sub) { out.set(nm, hue.get(l)); continue; }
      const subs = [...lines.get(l).subs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.set(nm, shade(hue.get(l), SHADES[subs.indexOf(sub) % SHADES.length]));
    }
    return out;
  }
  /* colour:end */
  // the colour of a category among the library's categories (recomputed when the set of names changes)
  // (cached per library array; a move or a refresh empties the cache)
  let colorCache = null;
  function color(name) {
    if (name === UNCAT) return UNCAT_COLOR;
    const all = items();
    if (!colorCache || colorCache.ref !== all || colorCache.len !== all.length) {
      const seen = new Set();
      for (const it of all) seen.add(catOf(it));
      colorCache = { ref: all, len: all.length, names: [...seen], map: colorMap([...seen]) };
    }
    return colorCache.map.get(name) || colorMap([...colorCache.names, name]).get(name);
  }
  if (RT.on) for (const ev of ['library:changed', 'library:refreshed']) RT.on(ev, () => { colorCache = null; });
  const items = () => (RT.library && RT.library.items ? RT.library.items() : []);
  const catOf = (it) => it.category || UNCAT;
  // existing category names, most used first, "Uncategorized" never offered
  function names() {
    const n = new Map();
    for (const it of items()) if (catOf(it) !== UNCAT) n.set(catOf(it), (n.get(catOf(it)) || 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  }
  const changed = () => RT.emit('library:changed');
  // a line = a name without " / " that has sub-lines in the library; idsOf(name) = the papers of a category or of a whole line
  const isLine = (name) => !subOf(name) && name !== UNCAT && items().some((i) => catOf(i).startsWith(name + SEP));
  const inName = (it, name) => catOf(it) === name || (isLineName(name) && catOf(it).startsWith(name + SEP));
  const isLineName = (name) => !subOf(name) && name !== UNCAT;
  const idsOf = (name) => items().filter((i) => inName(i, name)).map((i) => i.id);
  const headerExtras = RT.categories.headerExtras || [];

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-ask" class="dlg-small">
  <h3 id="ask-title"></h3>
  <p class="muted" id="ask-msg"></p>
  <input type="text" id="ask-input" list="ask-list" autocomplete="off">
  <datalist id="ask-list"></datalist>
  <div class="dlg-actions"><button id="ask-cancel" class="ib" title="Cancel (Esc)" aria-label="Cancel">${RT.icon('close')}</button><button class="primary ib" id="ask-ok" title="OK" aria-label="OK">${RT.icon('check')}</button></div>
</dialog>
<dialog id="dlg-regroup">
  <h3>Group with Claude</h3>
  <div id="rg-setup">
    <p class="muted">Claude proposes research lines (“Line / Sub-line”) from what each paper builds on - the methods it starts from, its Preliminaries and Related Work, read from your PDFs on this Mac - besides titles and tags. The lines it prefers are set in Preferences › AI. Nothing changes until you apply.</p>
    <div class="rg-scope" id="rg-scope"></div>
    <label class="rg-check"><input type="checkbox" id="rg-keep" checked> Keep papers I filed by hand where they are</label>
    <p class="muted rg-keepnote" id="rg-keepnote" hidden></p>
    <h4>New imports</h4>
    <label class="rg-check"><input type="checkbox" id="rg-auto"> Group newly imported papers automatically</label>
    <label class="rg-check">Category language
      <select id="rg-lang"><option value="auto">Follow existing categories</option><option value="en">English</option><option value="zh">中文</option></select></label>
    <div class="dlg-actions"><button id="rg-close" class="ib" title="Close (Esc)" aria-label="Close">${RT.icon('close')}</button><button class="primary ib" id="rg-start" title="Ask Claude for a proposal (you review it before anything changes)" aria-label="Ask Claude for a proposal">${RT.icon('sparkle')}</button></div>
  </div>
  <div id="rg-run" hidden>
    <p id="rg-progress">Asking Claude…</p>
    <div class="rg-bar"><div id="rg-bar-fill"></div></div>
    <div class="dlg-actions"><button id="rg-cancel" class="ib" title="Cancel: stop asking Claude" aria-label="Cancel">${RT.icon('stop')}</button></div>
  </div>
  <div id="rg-proposal" hidden>
    <p class="muted" id="rg-summary"></p>
    <h4>Proposed research lines <span class="muted rg-hint">names can be edited; “Line / Sub-line” nests under the line</span></h4>
    <div id="rg-cats"></div>
    <h4>Moves <span class="spacer"></span><button id="rg-all" class="ib" title="Tick all moves" aria-label="Tick all moves">${RT.icon('checkbox-on')}</button><button id="rg-none" class="ib" title="Untick all moves" aria-label="Untick all moves">${RT.icon('checkbox')}</button></h4>
    <div id="rg-moves"></div>
    <div class="dlg-actions"><button id="rg-back" class="ib" title="Back to the options" aria-label="Back">${RT.icon('arrowLeft')}</button><button id="rg-discard" class="ib" title="Discard the proposal and close" aria-label="Discard">${RT.icon('close')}</button><button class="primary ib" id="rg-apply" title="Apply" aria-label="Apply">${RT.icon('check')}</button></div>
  </div>
</dialog>`);

  // ---------------- ask: a small text / confirm dialog (never window.prompt) ----------------
  // ask({title, message, value, placeholder, options: [..], okLabel (the hint of the confirm button), icon (RT.icon name; default check, trash when danger), danger, input: false for a confirm}) -> Promise<string | true | null>
  let askDone = null;
  function ask(o = {}) {
    const dlg = $('#dlg-ask');
    if (askDone) askDone(null);
    $('#ask-title').textContent = o.title || '';
    $('#ask-msg').textContent = o.message || ''; $('#ask-msg').hidden = !o.message;
    const inp = $('#ask-input');
    inp.hidden = o.input === false; inp.value = o.value || ''; inp.placeholder = o.placeholder || ''; inp.maxLength = o.maxLength || 60;
    $('#ask-list').innerHTML = (o.options || []).map((v) => `<option value="${esc(v)}"></option>`).join('');
    const okBtn = $('#ask-ok'); okBtn.innerHTML = RT.icon(o.icon || (o.danger ? 'trash' : 'check')); const okName = o.okLabel || o.okText || 'OK'; okBtn.title = okName + ' (Enter)'; okBtn.setAttribute('aria-label', okName); okBtn.classList.toggle('danger', !!o.danger);
    if (!dlg.open) dlg.showModal();
    if (o.input === false) okBtn.focus(); else { inp.focus(); inp.select(); }
    return new Promise((resolve) => { askDone = (v) => { askDone = null; if (dlg.open) dlg.close(); resolve(v); }; });
  }
  const askOk = () => { if (!askDone) return; const inp = $('#ask-input'); if (inp.hidden) return askDone(true); const v = inp.value.replace(/\s+/g, ' ').trim(); if (v) askDone(v); else inp.focus(); };
  $('#ask-ok').addEventListener('click', askOk);
  $('#ask-cancel').addEventListener('click', () => askDone && askDone(null));
  $('#ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); askOk(); } });
  $('#dlg-ask').addEventListener('close', () => askDone && askDone(null)); // Esc

  // ---------------- a small context menu ----------------
  // menu(x, y, [{label, run, danger, check (bool: shows a tick column)} | {head: 'text'} | '-'])
  let menuEl = null;
  const CHECK = RT.icon('check');
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function menu(x, y, entries) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.innerHTML = entries.map((en, i) => (en === '-' ? '<hr>' : en.head ? `<div class="ctx-head">${esc(en.head)}</div>`
      : `<button data-i="${i}" role="${'check' in en ? 'menuitemcheckbox' : 'menuitem'}"${'check' in en ? ` aria-checked="${!!en.check}"` : ''} class="${en.danger ? 'danger' : ''}">${'check' in en ? `<span class="ctx-check">${en.check ? CHECK : ''}</span>` : ''}${esc(en.label)}</button>`)).join('');
    document.body.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    menuEl.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const en = entries[Number(b.dataset.i)];
      closeMenu();
      Promise.resolve().then(() => en.run()).catch((err) => toast(err.message, 'bad'));
    });
    const first = $('button', menuEl); if (first) first.focus();
    // Up / Down / Home / End move over the entries (Esc closes it: below)
    menuEl.addEventListener('keydown', (e) => {
      const bs = $$('button', menuEl), at = bs.indexOf(document.activeElement);
      const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : null;
      if (to === null || !bs.length) return;
      e.preventDefault(); bs[(to + bs.length) % bs.length].focus();
    });
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  // ---------------- rename / delete a category or a whole research line ----------------
  async function rename(name) {
    if (isLine(name)) return renameLine(name);
    const to = await ask({ title: 'Rename category', message: `Rename “${name}”. Typing the name of another category merges the two; “Line / Sub-line” files it under a research line.`, value: name, options: names().filter((n) => n !== name), okLabel: 'Rename', icon: 'edit' });
    if (!to || to === name) return;
    try {
      const r = await api('/api/categories/rename', { method: 'POST', json: { from: name, to } });
      toast(r.merged ? `Merged “${name}” into “${r.name}” (${r.moved} paper${r.moved === 1 ? '' : 's'})` : `Renamed to “${r.name}”`, 'ok');
      changed();
    } catch (e) { toast('Could not rename: ' + e.message, 'bad'); }
  }
  async function renameLine(name) {
    const lines = [...new Set(names().map(lineOf))].filter((n) => n !== name);
    const to = await ask({ title: 'Rename research line', message: `Rename the line “${name}” and all of its sub-lines (${idsOf(name).length} papers). Typing the name of another line merges the two.`, value: name, options: lines, okLabel: 'Rename', icon: 'edit' });
    if (!to || to === name) return;
    if (to.includes('/')) return void toast('A line name has no “/” in it', 'bad');
    try {
      const r = await api('/api/categories/rename', { method: 'POST', json: { from: name, to, line: true } });
      toast(r.merged ? `Merged the line “${name}” into “${r.name}” (${r.moved} paper${r.moved === 1 ? '' : 's'})` : `Renamed the line to “${r.name}”`, 'ok');
      changed();
    } catch (e) { toast('Could not rename: ' + e.message, 'bad'); }
  }
  async function remove(name) {
    const line = isLine(name);
    const n = idsOf(name).length;
    const ok = await ask({ title: line ? 'Delete research line' : 'Delete category', message: `Delete ${line ? `the line “${name}” and its sub-lines` : `“${name}”`}? ${n === 1 ? 'Its paper stays in the library and moves' : `Its ${n} papers stay in the library and move`} to “${UNCAT}”.`, input: false, okLabel: line ? 'Delete line' : 'Delete category', danger: true });
    if (!ok) return;
    try { await api('/api/categories/delete', { method: 'POST', json: { name, line } }); toast(`Deleted ${line ? 'line' : 'category'} “${name}”`, 'ok'); changed(); }
    catch (e) { toast('Could not delete: ' + e.message, 'bad'); }
  }
  function headerMenu(name, x, y) {
    const line = isLine(name), ids = idsOf(name);
    const entries = [];
    if (name !== UNCAT) entries.push({ label: line ? 'Rename line…' : 'Rename…', run: () => rename(name) }, { label: line ? 'Delete line' : 'Delete category', run: () => remove(name), danger: true }, '-');
    entries.push({ label: line ? 'Re-group this line with Claude…' : 'Re-group this category with Claude…', run: () => regroupDialog({ scope: 'category', category: name }) });
    if (RT.compare) entries.push({ label: line ? 'Compare or ask the papers of this line…' : 'Compare or ask the papers of this category…', run: () => RT.compare.start(ids) });
    const extra = [];
    for (const fn of headerExtras) { try { extra.push(...(fn(name, { line, ids }) || [])); } catch (e) { console.error('category menu:', e); } }
    if (extra.length) entries.push('-', ...extra);
    menu(x, y, entries);
  }

  // ---------------- Group with Claude ----------------
  let rg = null; // { scope, category, abort, proposal }
  const show = (step) => { for (const s of ['setup', 'run', 'proposal']) $('#rg-' + s).hidden = s !== step; };

  async function regroupDialog(o = {}) {
    const all = items();
    const uncat = all.filter((i) => catOf(i) === UNCAT).length;
    const category = o.category && all.some((i) => inName(i, o.category)) ? o.category : null;
    const scopes = [['uncategorized', `Only “${UNCAT}” papers`, uncat], ['all', 'The whole library', all.length]];
    if (category) scopes.push(['category', isLine(category) ? `Only the line “${category}” and its sub-lines` : `Only “${category}”`, all.filter((i) => inName(i, category)).length]);
    const want = o.scope === 'category' && !category ? 'uncategorized' : (o.scope || (uncat ? 'uncategorized' : 'all'));
    $('#rg-scope').innerHTML = scopes.map(([v, label, n]) => `<label class="rg-check"><input type="radio" name="rg-scope" value="${esc(v)}" ${v === want ? 'checked' : ''}> ${esc(label)} <span class="badge">${n}</span></label>`).join('');
    rg = { category };
    keepFor(want);
    show('setup');
    if (!$('#dlg-regroup').open) $('#dlg-regroup').showModal();
    try { const s = await api('/api/settings'); $('#rg-auto').checked = s.autoCategorize !== false; $('#rg-lang').value = s.categoryLanguage || 'auto'; }
    catch (e) { toast(e.message, 'bad'); }
  }
  // Re-grouping the whole library by research line: papers filed by hand would keep the old split (and Claude would
  // reuse it), so for that scope "keep" starts off when many papers are manual, with a word on what it means
  function keepFor(scope) {
    const manual = items().filter((i) => i.categoryStatus === 'manual').length;
    const note = $('#rg-keepnote');
    const many = scope === 'all' && manual >= 5;
    $('#rg-keep').checked = !many;
    note.hidden = !(scope === 'all' && manual);
    note.textContent = `${manual} ${manual === 1 ? 'paper was' : 'papers were'} filed by hand. Kept, they stay in their categories and the old split stays with them; unticked, Claude files them by research line too (you still review the proposal).`;
  }
  $('#rg-scope').addEventListener('change', (e) => { if (e.target.name === 'rg-scope') keepFor(e.target.value); });
  const saveSetting = async (patch) => { try { await api('/api/settings', { method: 'PUT', json: patch }); } catch (e) { toast('Could not save the setting: ' + e.message, 'bad'); } };
  $('#rg-auto').addEventListener('change', (e) => saveSetting({ autoCategorize: e.target.checked }));
  $('#rg-lang').addEventListener('change', (e) => saveSetting({ categoryLanguage: e.target.value }));

  function closeRegroup() { if (rg && rg.abort) rg.abort.abort(); rg = null; if ($('#dlg-regroup').open) $('#dlg-regroup').close(); }
  $('#rg-close').addEventListener('click', closeRegroup);
  $('#rg-discard').addEventListener('click', closeRegroup);
  $('#rg-cancel').addEventListener('click', () => { if (rg && rg.abort) rg.abort.abort(); show('setup'); });
  $('#rg-back').addEventListener('click', () => show('setup'));
  $('#dlg-regroup').addEventListener('close', () => { if (rg && rg.abort) rg.abort.abort(); });

  $('#rg-start').addEventListener('click', async () => {
    if (!rg) return;
    const scope = ($('input[name=rg-scope]:checked') || {}).value || 'uncategorized';
    const run = rg; run.scope = scope; run.abort = new AbortController();
    show('run');
    $('#rg-progress').textContent = 'Asking Claude…'; $('#rg-bar-fill').style.width = '4%';
    try {
      const res = await fetch('/api/categories/regroup', {
        method: 'POST', headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, signal: run.abort.signal,
        body: JSON.stringify({ scope, keepManual: $('#rg-keep').checked, category: scope === 'category' ? run.category : undefined }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Request failed (${res.status})`); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', last = null;
      const line = (l) => {
        if (!l.trim()) return;
        const m = JSON.parse(l); last = m;
        if (m.type === 'evidence') $('#rg-progress').textContent = `Reading what ${m.total} paper${m.total === 1 ? ' builds' : 's build'} on (Preliminaries, Related Work, methods named)…`;
        else if (m.type === 'start') $('#rg-progress').textContent = m.total ? `Asking Claude about ${m.total} paper${m.total === 1 ? '' : 's'}${m.chunks > 1 ? ` in ${m.chunks} batches` : ''}${m.evidence ? ` (${m.evidence} with evidence from their own text)` : ''}…` : 'Nothing to group.';
        else if (m.type === 'progress') { if (m.chunks > 1) $('#rg-progress').textContent = `Batch ${m.chunk} of ${m.chunks} — ${m.done} of ${m.total} papers grouped so far…`; $('#rg-bar-fill').style.width = Math.max(4, Math.round(100 * (m.chunk - 0.5) / m.chunks)) + '%'; }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl; while ((nl = buf.indexOf('\n')) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      line(buf);
      if (rg !== run) return; // closed meanwhile
      if (!last || last.type === 'error') throw new Error(last ? last.error : 'No answer');
      if (last.type !== 'proposal') throw new Error('The answer ended without a proposal');
      run.abort = null; run.proposal = last;
      renderProposal();
    } catch (e) {
      if (rg !== run) return;
      run.abort = null;
      show('setup');
      if (e.name !== 'AbortError') toast('Grouping failed: ' + e.message, 'bad');
    }
  });

  function renderProposal() {
    const p = rg.proposal;
    // by line (largest first), the line itself before its sub-lines
    const lineSize = new Map();
    for (const c of p.categories) lineSize.set(lineOf(c.name), (lineSize.get(lineOf(c.name)) || 0) + c.count);
    p.categories.sort((a, b) => lineSize.get(lineOf(b.name)) - lineSize.get(lineOf(a.name)) || lineOf(a.name).localeCompare(lineOf(b.name)) || !!subOf(a.name) - !!subOf(b.name) || b.count - a.count);
    for (const c of p.categories) c.edited = c.name;
    for (const a of p.assignments) a.on = true;
    const parts = [`${p.total} paper${p.total === 1 ? '' : 's'} looked at`, `${p.assignments.length} would move`];
    if (p.unchanged) parts.push(`${p.unchanged} stay where they are`);
    if (p.unassigned) parts.push(`${p.unassigned} got no answer and stay`);
    if (p.skippedManual) parts.push(`${p.skippedManual} filed by hand were left out`);
    if (p.evidence) parts.push(`${p.evidence} read from their own text`);
    $('#rg-summary').textContent = parts.join(' · ') + '. Nothing has been changed yet.';
    const nLines = lineSize.size, nSubs = p.categories.filter((c) => subOf(c.name)).length;
    let lastLine = null;
    $('#rg-cats').innerHTML = p.categories.map((c, i) => {
      const l = lineOf(c.name), sub = !!subOf(c.name);
      const head = l !== lastLine && p.categories.some((x) => lineOf(x.name) === l && subOf(x.name))
        ? `<div class="rg-line"><span class="cat-dot" style="background:${esc(color(l))}"></span><b>${esc(l)}</b><span class="badge">${esc(lineSize.get(l))}</span></div>` : '';
      lastLine = l;
      return `${head}
      <div class="rg-cat${sub ? ' rg-sub' : ''}"><span class="cat-dot" style="background:${esc(color(c.name))}"></span>
        <input type="text" data-ci="${i}" value="${esc(c.name)}" maxlength="60" aria-label="Category name">
        <span class="badge">${esc(c.count)}</span><span class="muted rg-desc" title="${esc(c.description || '')}">${esc(c.description || '')}</span></div>`;
    }).join('') || '<div class="muted">Claude proposed no categories.</div>';
    if (p.categories.length) $('#rg-cats').insertAdjacentHTML('afterbegin', `<div class="muted rg-count">${nLines} research line${nLines === 1 ? '' : 's'}${nSubs ? `, ${nSubs} sub-line${nSubs === 1 ? '' : 's'}` : ''}</div>`);
    $('#rg-moves').innerHTML = p.assignments.length ? `<table class="rg-table"><thead><tr><th></th><th>Paper</th><th>Now</th><th></th><th>Proposed</th></tr></thead><tbody>${
      p.assignments.map((a, i) => `<tr data-ai="${i}"><td><input type="checkbox" data-ai="${i}" checked aria-label="Apply this move"></td>
        <td class="rg-title">${esc(a.title)}${a.year ? ` <span class="muted">${esc(a.year)}</span>` : ''}</td>
        <td class="rg-from">${esc(a.from)}</td><td class="muted">→</td><td class="rg-to" data-to="${esc(a.to)}">${esc(a.to)}</td></tr>`).join('')
    }</tbody></table>` : '<div class="muted">No paper would move: the current grouping already matches what Claude proposes.</div>';
    show('proposal');
    updateApply();
  }
  const editedName = (to) => { const c = rg.proposal.categories.find((x) => x.name === to); return c ? c.edited.replace(/\s+/g, ' ').trim() : to; };
  function updateApply() {
    const p = rg.proposal;
    const n = p.assignments.filter((a) => a.on).length;
    const bad = p.categories.some((c) => { const v = c.edited.replace(/\s+/g, ' ').trim(); return !v || v.length > 60; });
    const label = n ? `Apply ${n} move${n === 1 ? '' : 's'}` : 'Nothing to apply';
    const ap = $('#rg-apply');
    ap.innerHTML = RT.icon('check') + (n ? `<span class="rg-n">${n}</span>` : '');
    ap.title = bad ? label + ' (a category name is empty or too long)' : label; ap.setAttribute('aria-label', label);
    ap.disabled = !n || bad;
  }
  $('#rg-cats').addEventListener('input', (e) => {
    const i = e.target.dataset.ci; if (i === undefined || !rg || !rg.proposal) return;
    const c = rg.proposal.categories[Number(i)]; c.edited = e.target.value;
    e.target.classList.toggle('invalid', !e.target.value.trim());
    for (const td of $$('#rg-moves .rg-to')) if (td.dataset.to === c.name) td.textContent = editedName(c.name) || '—';
    updateApply();
  });
  $('#rg-moves').addEventListener('change', (e) => {
    const i = e.target.dataset.ai; if (i === undefined || !rg || !rg.proposal) return;
    rg.proposal.assignments[Number(i)].on = e.target.checked;
    e.target.closest('tr').classList.toggle('off', !e.target.checked);
    updateApply();
  });
  const tickAll = (on) => { if (!rg || !rg.proposal) return; for (const a of rg.proposal.assignments) a.on = on; for (const cb of $$('#rg-moves input[type=checkbox]')) { cb.checked = on; cb.closest('tr').classList.toggle('off', !on); } updateApply(); };
  $('#rg-all').addEventListener('click', () => tickAll(true));
  $('#rg-none').addEventListener('click', () => tickAll(false));
  $('#rg-apply').addEventListener('click', async () => {
    if (!rg || !rg.proposal) return;
    const assignments = rg.proposal.assignments.filter((a) => a.on).map((a) => ({ id: a.id, category: editedName(a.to) }));
    if (!assignments.length) return;
    $('#rg-apply').disabled = true; $('#rg-apply').innerHTML = '<span class="spin"></span>'; $('#rg-apply').title = 'Applying…'; $('#rg-apply').setAttribute('aria-label', 'Applying');
    try {
      const r = await api('/api/categories/apply', { method: 'POST', json: { assignments } });
      toast(`Moved ${r.changed} paper${r.changed === 1 ? '' : 's'} into ${new Set(assignments.map((a) => a.category.toLowerCase())).size} categor${new Set(assignments.map((a) => a.category.toLowerCase())).size === 1 ? 'y' : 'ies'}`, 'ok');
      closeRegroup(); changed();
    } catch (e) { toast('Could not apply: ' + e.message, 'bad'); updateApply(); }
  });

  Object.assign(RT.categories, { UNCAT, SEP, color, names, lineOf, subOf, isLine, idsOf, ask, menu, closeMenu, headerMenu, headerExtras, rename, remove, regroupDialog });
})();
