/* Write tab: Claude in the LaTeX editor -> RT.writeAi (server: lib/writing.js, lib/routes/drafting.js).
   - Ask Claude about a selection (right-click it, or the sparkle of the toolbar): improve / shorten / translate /
     an instruction of your own. The proposal is shown under the passage as a word-by-word comparison; nothing in the
     file changes until it is accepted, and an accepted change is a "Claude" version of the project history.
   - Draft related work (the books button of the toolbar): choose papers of the library, Claude writes LaTeX that
     cites only their keys from the notes, key points and briefs; the draft is shown first, then inserted at the cursor.
   The editor itself is reached through RT.write.ed (cm, ok, activeBuf, applyClaude, insertBlock). */
(() => {
const { $, $$, esc, api, toast, ls, enc, authorsShort } = RT;
RT.writeAi = RT.writeAi || {};
const E = () => RT.write.ed, ui = () => RT.write.ui;
const MAX_SEL = 6000;
const MODES = [
  { id: 'improve', label: 'Improve the wording', icon: 'sparkle' },
  { id: 'shorten', label: 'Shorten by about 20%' },
  { id: 'translate', label: 'Translate into academic English' },
  { id: 'custom', label: 'Tell Claude what to change…', icon: 'pencil' },
];
const modeLabel = (p) => (p.mode === 'custom' ? `“${p.instruction}”` : MODES.find((m) => m.id === p.mode).label);
const pUrl = (rest) => `/api/projects/${enc(RT.write.currentProject().id)}${rest}`;

// ---------------- word-by-word comparison of two texts ----------------
// ops [{t: 'eq' | 'del' | 'add', text}]; LaTeX commands, words and single other characters (CJK) are the units
const TOKEN = /\s+|\\[A-Za-z@]+\*?|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\s\S]/gu;
function wordDiff(aText, bText) {
  const a = aText.match(TOKEN) || [], b = bText.match(TOKEN) || [];
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const raw = [], push = (t, text) => raw.push({ t, text });
  for (let i = 0; i < s; i++) push('eq', a[i]);
  const n = ea - s, m = eb - s;
  if (n && m && n * m <= 6e6) {
    const w = m + 1, L = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[s + i] === b[s + j]) { push('eq', a[s + i]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push('del', a[s + i++]);
      else push('add', b[s + j++]);
    }
    for (; i < n; i++) push('del', a[s + i]);
    for (; j < m; j++) push('add', b[s + j]);
  } else { for (let i = s; i < ea; i++) push('del', a[i]); for (let j = s; j < eb; j++) push('add', b[j]); }
  for (let i = ea; i < a.length; i++) push('eq', a[i]);
  // one removed run and one added run per changed place: a space that both texts share between two changed words
  // joins them, so the comparison reads as phrases and not as single words
  const ops = []; let del = '', add = '';
  const flush = () => { if (del) ops.push({ t: 'del', text: del }); if (add) ops.push({ t: 'add', text: add }); del = ''; add = ''; };
  raw.forEach((o, k) => {
    if (o.t === 'del') del += o.text;
    else if (o.t === 'add') add += o.text;
    else if ((del || add) && !o.text.trim() && !o.text.includes('\n') && raw[k + 1] && raw[k + 1].t !== 'eq') { del += o.text; add += o.text; }
    else { flush(); const last = ops[ops.length - 1]; if (last && last.t === 'eq') last.text += o.text; else ops.push({ t: 'eq', text: o.text }); }
  });
  flush();
  return ops;
}
const kept = (ops) => { let eq = 0, all = 0; for (const o of ops) { if (o.t !== 'add') all += o.text.length; if (o.t === 'eq') eq += o.text.length; } return all ? eq / all : 0; };

// ---------------- ask Claude about the selection ----------------
let cur = null; // the one proposal on screen: {buf, doc, mark, widget, node, mode, instruction, original, ctx, state, ac, text, ...}
function drop(p = cur) {
  if (!p) return;
  if (p.ac) { try { p.ac.abort(); } catch { /* already done */ } }
  if (p.widget) p.widget.clear();
  if (p.mark) p.mark.clear();
  p.dead = true;
  if (cur === p) cur = null;
}
function render(p) {
  if (p.dead) return;
  const btn = (act, title, icon, cls = '') => `<button type="button" class="ib ${cls}" data-ai="${act}" title="${esc(title)}" aria-label="${esc(title.split(':')[0])}">${ui().icon(icon)}</button>`;
  let body = '', actions = '';
  if (p.state === 'wait') {
    body = `<div class="ai-wait"><span class="spin"></span><span>Claude is writing a proposal for the marked text…</span></div>`;
    actions = btn('reject', 'Stop', 'stop');
  } else if (p.state === 'error') {
    body = `<div class="ai-msg bad">${esc(p.error)}</div>`;
    actions = btn('retry', 'Ask again', 'refresh') + btn('reject', 'Close', 'close');
  } else if (p.same) {
    body = `<div class="ai-msg">Claude would leave this passage as it is.</div>`;
    actions = btn('retry', 'Ask again', 'refresh') + btn('reject', 'Close', 'close');
  } else {
    const ops = wordDiff(p.original, p.text);
    // a translation shares almost nothing with the original: show the new text alone instead of a wall of red and green
    const plain = kept(ops) < 0.2;
    const html = plain ? `<ins>${esc(p.text.trim())}</ins>` : ops.map((o) => (o.t === 'eq' ? esc(o.text) : o.t === 'del' ? `<del>${esc(o.text)}</del>` : `<ins>${esc(o.text)}</ins>`)).join('');
    const count = (t) => (t.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[㐀-鿿]/g) || []).length, wa = count(p.original), wb = count(p.text);
    body = `<div class="ai-diff" tabindex="0">${html}</div>`
      + (p.newKeys && p.newKeys.length ? `<div class="ai-msg bad">Claude added ${p.newKeys.length === 1 ? 'a cite key that is' : 'cite keys that are'} not in your library: ${p.newKeys.map((k) => `<code>${esc(k)}</code>`).join(', ')}. Check before you accept.</div>` : '')
      + `<div class="ai-note muted">${plain ? 'The marked text above would be replaced by this.' : `Red is removed, green is added. ${wa} → ${wb} words${wa ? ` (${wb >= wa ? '+' : '−'}${Math.round(Math.abs(wb - wa) / wa * 100)}%)` : ''}.`} Nothing has changed yet.</div>`;
    actions = btn('retry', 'Ask again: another proposal for the same text', 'refresh') + btn('reject', 'Reject: keep my text', 'close')
      + btn('accept', 'Accept: put this in place of the marked text (kept as a Claude version in the history)', 'check', 'primary');
  }
  p.node.innerHTML = `<div class="ai-head"><span class="ai-title">${RT.icon('sparkle')}<b>Claude</b><span class="muted">${esc(modeLabel(p))}</span></span><span class="spacer"></span>${actions}</div>${body}`;
  p.widget.changed();
}
async function request(p) {
  p.state = 'wait'; p.error = ''; p.ac = new AbortController();
  render(p);
  try {
    const r = await api(pUrl('/rewrite'), { method: 'POST', json: { mode: p.mode, instruction: p.instruction, text: p.original, ...p.ctx }, signal: p.ac.signal });
    if (p.dead) return;
    Object.assign(p, { state: 'ready', text: r.text, same: !!r.same || r.text === p.original, newKeys: r.newKeys || [] });
  } catch (e) {
    if (p.dead || e.name === 'AbortError') return;
    p.state = 'error';
    p.error = e instanceof TypeError ? 'Could not reach the app. Check that ResearchTool is still running, then ask again.' : e.message;
  }
  p.ac = null;
  render(p);
  if (p.state === 'ready' && p.buf === E().activeBuf() && p.widget.line) E().cm.scrollIntoView({ line: p.doc.getLineNumber(p.widget.line) + 1, ch: 0 }, 60);
}
async function accept(p) {
  if (p.busy) return; p.busy = true;
  let stale = false;
  const ok = await E().applyClaude(p.buf, () => {
    const r = p.mark.find();
    if (!r || p.doc.getRange(r.from, r.to) !== p.original) { stale = true; return false; }
    p.doc.replaceRange(p.text.split('\n'), r.from, r.to, 'claude'); // an array of lines: right for CRLF files too
    p.doc.setCursor(CodeMirror.changeEnd({ from: r.from, to: r.to, text: p.text.split('\n') }));
  });
  p.busy = false;
  if (stale) { drop(p); return toast('The marked text was edited after you asked, so the proposal no longer fits. Select it and ask again.', 'bad'); }
  if (!ok && !p.dead && p.mark.find()) return; // the file could not be saved (a message says why): the proposal stays
  drop(p);
  if (ok) { toast('Accepted — the change is a Claude version in the history.', 'ok'); E().cm.focus(); }
}
// the heading the passage stands under, read from the lines above it
function sectionAbove(doc, line) {
  for (let n = line; n >= 0 && n > line - 400; n--) {
    const m = /\\(?:chapter|section|subsection|subsubsection)\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/.exec(doc.getLine(n));
    if (m) return m[1];
  }
  const abs = /\\begin\{abstract\}/; // the abstract has no heading of its own
  for (let n = line; n >= 0 && n > line - 60; n--) if (abs.test(doc.getLine(n))) return 'Abstract';
  return '';
}
function selection() { // the selected passage of the open text file, or null with a message
  const e = E();
  if (!e.cm) { toast('The editor could not be started, so Claude cannot work on a selection.', 'bad'); return null; }
  if (!e.ok()) return null;
  const cm = e.cm, text = cm.getSelection();
  if (!text.trim()) { toast('Select the text Claude should work on first.', 'bad'); return null; }
  if (cm.listSelections().length > 1) { toast('Select one passage at a time.', 'bad'); return null; }
  if (text.length > MAX_SEL) { toast(`The selection is too long (${text.length.toLocaleString()} characters). Select a few paragraphs at a time — at most about ${MAX_SEL.toLocaleString()} characters.`, 'bad'); return null; }
  return { cm, text, from: cm.getCursor('from'), to: cm.getCursor('to') };
}
function start(mode, instruction = '') {
  const s = selection(); if (!s) return;
  const { cm, from, to } = s, doc = cm.getDoc(), buf = E().activeBuf();
  drop();
  const node = document.createElement('div'); node.className = 'ai-prop';
  const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
  const p = cur = { buf, doc, node, mode, instruction, original: s.text,
    ctx: { section: sectionAbove(doc, from.line), before: doc.getRange({ line: Math.max(0, from.line - 12), ch: 0 }, from).slice(-700), after: doc.getRange(to, { line: to.line + 8, ch: 0 }).slice(0, 400) },
    mark: doc.markText(from, to, { className: 'ai-old' }),
    widget: doc.addLineWidget(last, node, { noHScroll: true }) };
  node.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // the editor keeps the focus
  node.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ai]'); if (!b || p.dead) return;
    if (b.dataset.ai === 'accept') accept(p).catch((err) => toast(err.message, 'bad'));
    else if (b.dataset.ai === 'retry') { if (p.mark.find() && p.doc.getRange(p.mark.find().from, p.mark.find().to) === p.original) request(p); else { drop(p); toast('The marked text was edited — select it and ask again.', 'bad'); } }
    else drop(p);
  });
  node.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); drop(p); cm.focus(); } });
  cm.setCursor(to); // the mark shows the passage from here on
  request(p);
}
async function custom() {
  if (!selection()) return;
  const text = await ui().ask({ title: 'Tell Claude what to change', message: 'Claude rewrites the selected text the way you say. You see its proposal before anything changes.',
    value: ls.get('rt-ai-instruction', ''), placeholder: 'e.g. make it more formal · merge the two sentences · use the passive voice', okText: 'Ask Claude', icon: 'sparkle' });
  if (text === null) return;
  const inst = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!inst) return toast('Say what Claude should change.', 'bad');
  ls.set('rt-ai-instruction', inst);
  start('custom', inst);
}
function weakClaims() {
  const s = selection(); if (!s) return;
  if (!RT.claude || !RT.claude.ask) return toast('The Claude panel is not available.', 'bad');
  if (s.text.length > 4000) toast('The Claude panel reads the first 4,000 characters of a selection — select less to have all of it checked.');
  RT.claude.ask('Read the text I selected in the editor the way a critical reviewer would. List the claims in it that are overstated, vague, or not backed by evidence or a citation: quote each in a few words, say what is weak about it, and say what would fix it (a number, a citation, a narrower wording). Do not change any file.');
}
const copyText = (text) => navigator.clipboard.writeText(text).catch(() => toast('The browser did not allow copying.', 'bad'));
function items(withClipboard) {
  const cm = E().cm, sel = cm ? cm.getSelection() : '';
  const none = !sel.trim();
  return [{ head: 'Ask Claude about the selection' },
    ...(none ? [{ note: 'Select a sentence or a paragraph in the editor first.' }] : []),
    ...MODES.map((m) => ({ label: m.label, icon: m.icon, disabled: none, run: () => (m.id === 'custom' ? custom() : start(m.id)) })),
    { sep: true }, { label: 'Find weak claims', title: 'Answers in the Claude panel; nothing is changed', disabled: none, run: weakClaims },
    ...(withClipboard ? [{ sep: true }, { label: 'Copy', icon: 'copy', run: () => copyText(sel) },
      { label: 'Cut', run: () => copyText(sel).then(() => { cm.replaceSelection(''); cm.focus(); }) },
      // this menu stands in for the browser's own, so it has to offer Paste too
      ...(navigator.clipboard && navigator.clipboard.readText ? [{ label: 'Paste', run: () => navigator.clipboard.readText().then((t) => { if (t) cm.replaceSelection(t); cm.focus(); },
        () => toast(`The browser did not allow pasting from this menu — press ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}V instead.`, 'bad')) }] : [])] : [])];
}
function menu(anchor) { if (E().cm ? E().ok() : (toast('The editor could not be started.', 'bad'), false)) ui().menu(anchor, items(false)); }

if (E().cm) {
  // right-click inside the selection (a right-click on a spelling mark has its own menu, set up in write.js)
  E().cm.on('contextmenu', (c, e) => {
    if (e.defaultPrevented || !c.somethingSelected() || !c.getSelection().trim() || c.listSelections().length > 1) return;
    const pos = c.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    if (CodeMirror.cmpPos(pos, c.getCursor('from')) < 0 || CodeMirror.cmpPos(pos, c.getCursor('to')) > 0) return;
    e.preventDefault();
    ui().menu({ x: e.clientX, y: e.clientY }, items(true));
  });
}

// ---------------- related work from library papers ----------------
const UNCAT = 'Uncategorized';
let rwOpen = false;
async function relatedWork() {
  const e = E();
  if (!e.cm) return toast('The editor could not be started, so a draft cannot be inserted.', 'bad');
  if (!e.ok() || rwOpen) return;
  const buf = e.activeBuf();
  rwOpen = true;
  try { await rwDialog(buf); } finally { rwOpen = false; }
}
async function rwDialog(buf) {
  const icon = (n) => ui().icon(n);
  const d = document.createElement('dialog');
  d.className = 'wr-dlg rw-dlg';
  d.innerHTML = `<form method="dialog">
    <h3>Draft related work from your library</h3>
    <div class="rw-pick">
      <p class="muted rw-lead">Claude writes LaTeX from your reading notes, key points and briefs — not from the PDFs — and cites only the papers you tick.</p>
      <label>What this part should bring out (optional, one line)
        <input type="text" id="rw-angle" maxlength="400" autocomplete="off" placeholder="e.g. how world models are used for robot manipulation, and what they still lack"></label>
      <div class="rw-filter">
        <input type="search" id="rw-q" placeholder="Filter papers…" aria-label="Filter papers" spellcheck="false">
        <select id="rw-cat" aria-label="Category"></select>
        <button type="button" class="ib" id="rw-all" title="Tick every paper shown" aria-label="Tick every paper shown">${icon('check')}</button>
        <button type="button" class="ib" id="rw-none" title="Untick all" aria-label="Untick all">${icon('close')}</button>
      </div>
      <div id="rw-list" class="rw-list" role="group" aria-label="Papers"><div class="rw-empty muted"><span class="spin"></span> Loading the library…</div></div>
      <div class="rw-foot"><label class="check"><input type="checkbox" id="rw-head" checked> Start with <code>\\section{Related Work}</code></label><span class="spacer"></span><span id="rw-count" class="muted" aria-live="polite"></span></div>
    </div>
    <div class="rw-wait" hidden><span class="spin"></span><span id="rw-wait-text"></span></div>
    <div class="rw-result" hidden><div id="rw-notes"></div><pre id="rw-latex" tabindex="0"></pre></div>
    <div class="dlg-actions">
      <button type="button" class="ib" data-rw="cancel" title="Cancel (Esc)" aria-label="Cancel">${icon('close')}</button>
      <button type="button" class="ib" data-rw="stop" title="Stop" aria-label="Stop" hidden>${icon('stop')}</button>
      <button type="button" class="ib" data-rw="back" title="Back: choose other papers or another angle" aria-label="Back" hidden>${icon('arrowLeft')}</button>
      <button type="button" class="ib" data-rw="copy" title="Copy the LaTeX" aria-label="Copy the LaTeX" hidden>${icon('copy')}</button>
      <button type="button" class="primary ib" data-rw="draft" title="Write the draft with Claude" aria-label="Write the draft with Claude">${icon('sparkle')}</button>
      <button type="button" class="primary ib" data-rw="insert" title="Insert the draft at the cursor (kept as a Claude version in the history)" aria-label="Insert the draft at the cursor" hidden>${icon('check')}</button>
    </div></form>`;
  document.body.append(d);
  const q = (s) => $(s, d);
  const hay = new Map(); // id -> the text the filter looks in
  let papers = [], noted = new Set(), max = 30, picked = new Set(), ac = null, result = null, stage = 'pick', members = new Set();
  const PROJ = '@project'; // the category filter's "This project (N)": the papers of the open project
  const show = (st) => {
    stage = st;
    q('.rw-pick').hidden = st !== 'pick'; q('.rw-wait').hidden = st !== 'wait'; q('.rw-result').hidden = st !== 'result';
    for (const b of $$('[data-rw]', d)) b.hidden = !({ pick: ['cancel', 'draft'], wait: ['stop'], result: ['back', 'copy', 'insert'] })[st].includes(b.dataset.rw);
  };
  // what there is to write from, per paper
  const stuff = (it) => {
    const kp = (it.keypoints || []).length, has = noted.has(it.id), thin = !has && !kp && (it.brief || (it.fields && it.fields.abstract));
    return { none: !has && !kp && !thin, text: [has ? 'note' : '', kp ? `${kp} key point${kp === 1 ? '' : 's'}` : '', thin ? (it.brief ? 'brief only' : 'abstract only') : ''].filter(Boolean).join(' · ') || 'nothing to write from' };
  };
  const shown = () => {
    const s = q('#rw-q').value.trim().toLowerCase(), cat = q('#rw-cat').value;
    return papers.filter((it) => (!cat || (cat === PROJ ? members.has(it.id) : (it.category || UNCAT) === cat)) && (!s || hay.get(it.id).includes(s)));
  };
  const count = () => {
    const n = picked.size, over = n > max;
    q('#rw-count').textContent = over ? `${n} chosen — at most ${max} for one draft` : n ? `${n} paper${n === 1 ? '' : 's'} chosen` : 'Tick the papers to write about';
    q('#rw-count').classList.toggle('bad', over);
    q('[data-rw=draft]').disabled = !n || over;
  };
  const list = () => {
    const rows = shown();
    q('#rw-list').innerHTML = rows.map((it) => {
      const m = stuff(it), f = it.fields || {};
      return `<label class="rw-row${m.none ? ' off' : ''}" title="${esc(f.title || '')}"><input type="checkbox" data-id="${esc(it.id)}"${picked.has(it.id) ? ' checked' : ''}${m.none ? ' disabled' : ''}>
        <span class="rw-main"><span class="rw-title">${esc(f.title || it.citekey)}</span><span class="muted rw-sub">${RT.byline(authorsShort(f.author), [f.year, it.category && it.category !== UNCAT ? it.category : ''])}</span></span>
        <span class="rw-mat${m.none ? ' bad' : ''}">${esc(m.text)}</span></label>`;
    }).join('') || `<div class="rw-empty muted">${papers.length ? 'No paper matches the filter.' : 'Your library is empty — add papers in the Library tab first.'}</div>`;
    count();
  };
  const done = new Promise((resolve) => {
    const close = () => { if (ac) ac.abort(); try { d.close(); } catch { /* already closed */ } d.remove(); resolve(); };
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); if (stage === 'wait') { if (ac) ac.abort(); } else close(); });
    d.addEventListener('submit', (ev) => ev.preventDefault());
    q('#rw-angle').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); if (!q('[data-rw=draft]').disabled) draft(); } });
    q('#rw-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault(); });
    q('#rw-q').addEventListener('input', list); q('#rw-cat').addEventListener('change', list);
    q('#rw-list').addEventListener('change', (ev) => { const c = ev.target.closest('input[data-id]'); if (!c) return; if (c.checked) picked.add(c.dataset.id); else picked.delete(c.dataset.id); count(); });
    q('#rw-all').addEventListener('click', () => { for (const it of shown()) if (!stuff(it).none) picked.add(it.id); list(); });
    q('#rw-none').addEventListener('click', () => { picked.clear(); list(); });
    async function draft() {
      const ids = papers.filter((it) => picked.has(it.id)).map((it) => it.id);
      ls.set('rt-rw-angle', q('#rw-angle').value.trim());
      q('#rw-wait-text').textContent = `Claude is writing from what you have on ${ids.length} paper${ids.length === 1 ? '' : 's'}. This takes up to a minute or two…`;
      show('wait'); q('[data-rw=stop]').focus();
      ac = new AbortController();
      try {
        result = await api(pUrl('/related-work'), { method: 'POST', json: { ids, angle: q('#rw-angle').value, heading: q('#rw-head').checked }, signal: ac.signal });
        ac = null;
        const names = (a) => a.map((x) => `<code title="${esc(x.title || '')}">${esc(x.citekey || x)}</code>`).join(', ');
        const r = result, notes = [`<li>About ${r.words} words, citing ${r.cited.length} of the ${r.papers} paper${r.papers === 1 ? '' : 's'} it was given. Read it against the papers before you keep it.</li>`];
        if (r.uncited.length) notes.push(`<li>Not cited (too little to go on, or it did not fit): ${names(r.uncited)}</li>`);
        if (r.thin.length) notes.push(`<li>Written from the brief or abstract alone, because there is no note and no key point yet: ${names(r.thin)}</li>`);
        if (r.skipped.length) notes.push(`<li>Left out, because the library holds nothing to write from: ${names(r.skipped)}</li>`);
        if (r.dropped.length) notes.push(`<li class="bad">Removed ${r.dropped.length === 1 ? 'a citation' : 'citations'} of ${r.dropped.length === 1 ? 'a key' : 'keys'} that ${r.dropped.length === 1 ? 'is' : 'are'} not among the chosen papers: ${names(r.dropped)}</li>`);
        q('#rw-notes').innerHTML = `<ul>${notes.join('')}</ul>`;
        q('#rw-latex').textContent = r.latex;
        show('result'); q('[data-rw=insert]').focus();
      } catch (err) {
        ac = null; show('pick');
        if (err.name !== 'AbortError') toast(err instanceof TypeError ? 'Could not reach the app. Check that ResearchTool is still running.' : err.message, 'bad');
      }
    }
    d.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button[data-rw]'); if (!b) return;
      const act = b.dataset.rw;
      if (act === 'cancel') close();
      else if (act === 'stop') { if (ac) ac.abort(); }
      else if (act === 'back') { show('pick'); list(); }
      else if (act === 'copy') copyText(result.latex).then(() => toast('Copied', 'ok'));
      else if (act === 'draft') draft();
      else if (act === 'insert') {
        if (b.disabled) return;
        const r = result, cm = E().cm, n = r.cited.length;
        b.disabled = true; // the dialog stays until the draft is in the file, so a draft that could not be inserted is not lost
        const ok = await E().applyClaude(buf, () => {
          if (E().activeBuf() !== buf) return false;
          cm.setCursor(cm.getCursor('to')); // never over a selection
          E().insertBlock([`% --- Draft by Claude from ${r.papers} paper${r.papers === 1 ? '' : 's'} of the library: check every claim against the papers before you keep it ---`,
            ...r.latex.split('\n'), '% --- End of the draft ---']);
        });
        b.disabled = false;
        if (ok) { close(); cm.focus(); toast(`Draft inserted, citing ${n} paper${n === 1 ? '' : 's'} — it is a Claude version in the history.`, 'ok'); }
        else toast('The file could not be saved, so the draft was not inserted. It is still here to copy.', 'bad');
      }
    });
  });
  d.showModal();
  show('pick'); count();
  q('#rw-angle').value = ls.get('rt-rw-angle', '');
  q('#rw-head').checked = !/\\section\*?\{\s*related\s+work/i.test(E().cm.getValue()); // the file has that heading already
  q('#rw-angle').focus();
  try {
    if (RT.library && RT.library.refresh) await RT.library.refresh().catch(() => {});
    const pj = RT.write.currentProject();
    const [mat, pp] = await Promise.all([api('/api/writing/material').catch(() => ({ notes: [], max: 30 })),
      pj ? api(`/api/projects/${enc(pj.id)}/papers`).catch(() => null) : null]);
    members = new Set(pp ? pp.papers.map((r) => r.id) : []);
    noted = new Set(mat.notes || []); max = mat.max || 30;
    papers = (RT.library && RT.library.items ? RT.library.items() : []).slice()
      .sort((a, b) => (a.category || UNCAT).localeCompare(b.category || UNCAT) || String(b.fields.year || '').localeCompare(String(a.fields.year || '')) || a.citekey.localeCompare(b.citekey));
    for (const it of papers) hay.set(it.id, [it.citekey, it.fields.title, it.fields.author, it.fields.year, it.category, (it.tags || []).join(' ')].join(' ').toLowerCase());
    const cats = [...new Set(papers.map((it) => it.category || UNCAT))];
    const nMine = papers.filter((it) => members.has(it.id)).length;
    q('#rw-cat').innerHTML = `<option value="">All categories</option>${nMine ? `<option value="${PROJ}">This project (${nMine})</option>` : ''}${cats.map((c) => `<option value="${esc(c)}">${esc(c)} (${papers.filter((it) => (it.category || UNCAT) === c).length})</option>`).join('')}`;
    // start from the papers selected in the Library list, if any; else from the papers of the project
    const sel = RT.library && RT.library.selection ? RT.library.selection() : [];
    for (const id of sel) { const it = papers.find((x) => x.id === id); if (it && !stuff(it).none) picked.add(id); }
    if (!sel.length && nMine) {
      for (const it of papers) if (members.has(it.id) && !stuff(it).none && picked.size < max) picked.add(it.id);
      q('#rw-cat').value = PROJ;
    }
    if (d.isConnected) list();
  } catch (err) { if (d.isConnected) q('#rw-list').innerHTML = `<div class="rw-empty bad">${esc(err.message)}</div>`; }
  return done;
}

// write.js: the file a proposal belongs to was closed or loaded again from disk - stop the request, take the proposal away
function forget(buf) { if (cur && (!buf || cur.buf === buf)) drop(cur); }

Object.assign(RT.writeAi, { menu, start, relatedWork, wordDiff, forget });
})();
