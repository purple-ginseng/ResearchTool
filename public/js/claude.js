/* Claude panel (right-hand aside #claude). The context sent with a prompt comes from the provider that the
   active view registered with RT.claudeContext.register(viewId, fn).
   Every paper and every LaTeX project has its own conversations (messages + the CLI's session id). The open one is
   kept in this browser's localStorage under rt.claude.chats (bounded) and shown again after a reload; all of them
   are kept in the workspace (lib/routes/chats.js, <workspace>/chats/). "New chat" starts another conversation
   about the same paper and the earlier ones stay: the History button lists them, and those of the other papers,
   to be read again or continued. The answer is drawn while
   it is written (text deltas of POST /api/claude); the Send button is a Stop button while a run is going.
   With another AI provider than Claude (Preferences › AI, RT.ai) the panel is a read-only chat: that CLI can read the
   workspace but edits nothing - unless it is Codex with "Let Codex edit files" ticked (caps.agentic is then true, and
   the panel shows the usual hint instead of the read-only note). A conversation remembers its provider (p); another
   provider starts a new one. */
(() => {
  const { $, $$ } = RT;
  RT.claude = RT.claude || {};

  $('#claude').innerHTML = `
    <div class="claude-head">
      <span class="claude-mark">${RT.icon('sparkle')}</span><strong>Claude Code</strong>
      <span id="claude-ctx" class="chip" hidden></span>
      <div class="spacer"></div>
      <button id="claude-history" class="ib" title="History: the earlier conversations about this paper or project, and those about your other papers" aria-label="Conversation history" aria-haspopup="menu">${RT.icon('history')}</button>
      <button id="claude-new" class="ib" title="New chat: start a fresh conversation about this paper or project. The current one stays in the history." aria-label="New chat">${RT.icon('plus')}</button>
    </div>
    <div id="claude-log">
      <div class="msg hint" id="claude-hint" title="Runs your local claude CLI inside the workspace folder. It can read your library and notes and edit the files of your LaTeX project directly.">Local <code>claude</code> CLI — reads your library and notes, edits your LaTeX project. Try: “Draft a related-work paragraph from my key points.”</div>
      <div class="msg hint ro" id="claude-ro" hidden><b>Read-only:</b> <span>Claude can read your library, notes and project files but cannot change them.</span> <span data-brand-keep>To let the AI edit your files, choose Claude Code in Preferences › AI, or tick “Let Codex edit files” there with Codex.</span></div>
    </div>
    <div id="claude-sel" hidden>
      <span class="claude-sel-text"></span>
      <button type="button" class="ib" id="claude-sel-x" title="Do not send this selection" aria-label="Do not send this selection">${RT.icon('close')}</button>
    </div>
    <form id="claude-form">
      <textarea id="claude-input" rows="3" placeholder="Ask Claude…" title="Enter to send, Shift+Enter for a new line, Esc to stop an answer" aria-label="Message to Claude"></textarea>
      <button class="primary ib" id="claude-send" title="Send (Enter)" aria-label="Send">${RT.icon('send')}</button>
    </form>
    <div class="claude-foot muted" title="Run this in a terminal to use Claude Code in the same workspace">Terminal: <code id="claude-cmd"></code></div>`;

  // ---------------- conversations: one per paper / project, kept across reloads ----------------
  const STORE = 'rt.claude.chats', MAX_CHATS = 40, MAX_MSGS = 60, MAX_MSG_CHARS = 12000, MAX_STORE_CHARS = 1500000;
  const KEEP = new Set(['user', 'bot', 'tool', 'err']);
  const chats = new Map(); // key -> { key, id, session, log: [{c, t}], busy, abort, live: null | {text}, status, dead, archived }
  // the id of a conversation (a paper can have several): 12 letters and digits
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  const keyOf = (c) => (c && c.itemId ? 'item:' + c.itemId : c && (c.projectId || c.project) ? 'project:' + (c.projectId || c.project) : 'general');
  const readStore = () => { const o = RT.ls.json(STORE, null); return o && typeof o === 'object' && o.chats && typeof o.chats === 'object' ? o : { v: 1, chats: {} }; };
  function getChat(key) {
    let c = chats.get(key);
    if (c) return c;
    const st = readStore().chats[key];
    c = { key, id: newId(), session: null, p: 'claude', log: [], busy: false, abort: null, live: null, status: '', dead: false, archived: false };
    if (st && typeof st === 'object') {
      if (typeof st.i === 'string' && /^[a-z0-9]{6,24}$/.test(st.i)) c.id = st.i;
      if (typeof st.s === 'string' && /^[0-9a-f-]{8,64}$/i.test(st.s)) c.session = st.s;
      if (typeof st.p === 'string' && /^[a-z]{2,12}$/.test(st.p)) c.p = st.p; // the AI provider of the session (older chats: Claude)
      if (Array.isArray(st.log)) c.log = st.log.filter((e) => Array.isArray(e) && KEEP.has(e[0]) && typeof e[1] === 'string').map((e) => ({ c: e[0], t: e[1] }));
    }
    chats.set(key, c);
    if (c.log.length) keep(c); // (a conversation from before the history existed is put into it)
    return c;
  }
  // the workspace's copy of a conversation (lib/routes/chats.js): a moment after the last change, or at once
  function keep(chat, now = false) {
    clearTimeout(chat.keepTimer);
    if (chat.dead || !chat.log.length) return;
    const go = () => fetch(`/api/chats/${encodeURIComponent(chat.key)}/${chat.id}`, { method: 'PUT', keepalive: now, headers: { 'Content-Type': 'application/json', 'X-RT': '1' },
      body: JSON.stringify({ s: chat.session, p: chat.p || 'claude', log: chat.log.map((e) => [e.c, e.t]) }) }).catch(() => { /* the next change tries again */ });
    if (now) go(); else chat.keepTimer = setTimeout(go, 1200);
  }
  // write one conversation back (the stored object is read again first, so another window's conversations stay)
  function saveChat(chat) {
    if (chat.dead) return;
    keep(chat);
    if (chat.archived || chats.get(chat.key) !== chat) return; // an earlier conversation: only the workspace has it
    const o = readStore();
    if (!chat.log.length && !chat.session) delete o.chats[chat.key];
    else {
      o.chats[chat.key] = { i: chat.id, s: chat.session, p: chat.p || 'claude', t: Date.now(),
        log: chat.log.slice(-MAX_MSGS).map((e) => [e.c, e.t.length > MAX_MSG_CHARS ? e.t.slice(0, MAX_MSG_CHARS) + '\n\n… (shortened)' : e.t]) };
    }
    const oldest = () => Object.keys(o.chats).filter((k) => k !== chat.key).sort((a, b) => (o.chats[a].t || 0) - (o.chats[b].t || 0))[0];
    while (Object.keys(o.chats).length > MAX_CHATS && oldest()) delete o.chats[oldest()];
    let str = JSON.stringify(o);
    while (str.length > MAX_STORE_CHARS && oldest()) { delete o.chats[oldest()]; str = JSON.stringify(o); }
    for (let i = 0; i < 6; i++) { // the browser's store may be full: give up the oldest conversations and try again
      try { localStorage.setItem(STORE, str); return; } catch { /* full or not available */ }
      const k = oldest(); if (!k) return;
      delete o.chats[k]; str = JSON.stringify(o);
    }
  }
  let active = getChat('general');
  let stale = true;  // the log on screen is not the active conversation's (it is drawn when the panel is showing)
  let liveEl = null; // the bubble of the answer that is being written
  const shown = () => !$('#claude').hidden;

  let stick = true; // the log follows new content until the reader scrolls up
  const pin = () => { const log = $('#claude-log'); if (stick) log.scrollTop = log.scrollHeight; };
  // The Send button shows an icon only: the send arrow when idle, a stop square while Claude is answering.
  function reflect() {
    const busy = active.busy, b = $('#claude-send');
    b.innerHTML = RT.icon(busy ? 'stop' : 'send');
    b.title = busy ? 'Stop the answer (Esc)' : 'Send (Enter)';
    b.setAttribute('aria-label', busy ? 'Stop the answer' : 'Send');
    b.classList.toggle('stop', busy);
    $('#claude-log').setAttribute('aria-busy', String(busy));
    wait();
  }
  // a line with a spinner at the end of the log while Claude is working and no text is arriving
  function wait() {
    let w = $('#claude-log .msg.wait');
    const on = active.busy && !active.live && shown() && !stale;
    if (!on) { if (w) w.remove(); return; }
    if (!w) { w = document.createElement('div'); w.className = 'msg wait'; w.setAttribute('role', 'status'); w.innerHTML = '<span class="spin"></span><span class="wait-text"></span>'; }
    $('.wait-text', w).textContent = active.status || 'Claude is working…';
    $('#claude-log').append(w); // always the last line
    pin();
  }
  function toggle(show = $('#claude').hidden) {
    $('#claude').hidden = !show;
    RT.emit('layout:changed');
    if (show) { if (stale || active.busy) renderLog(); else wait(); $('#claude-input').focus(); } // a run went on while the panel was hidden: draw where it is now
  }
  $('#btn-claude').addEventListener('click', () => toggle());
  $('#claude-log').addEventListener('scroll', (e) => { const l = e.currentTarget; stick = l.scrollHeight - l.scrollTop - l.clientHeight < 60; });
  // put a conversation aside: it stays in the history, an answer that is being written is stopped
  function archive(chat) {
    chat.archived = true;
    if (chat.busy) stop(chat);
    if (chat.live && chat.live.text.trim()) { chat.log.push({ c: 'bot', t: chat.live.text }); chat.live = null; }
    keep(chat, true);
    if (chats.get(chat.key) === chat) chats.delete(chat.key);
    const o = readStore();
    if (o.chats[chat.key] && (o.chats[chat.key].i || '') === chat.id) { delete o.chats[chat.key]; RT.ls.set(STORE, JSON.stringify(o)); }
  }
  $('#claude-new').addEventListener('click', () => {
    const old = active;
    if (!old.log.length && !old.busy) { $('#claude-input').focus(); return; } // it is new already
    archive(old);
    active = getChat(old.key);
    renderLog(); reflect();
    $('#claude-input').focus();
  });

  // ---------------- history: the earlier conversations of this paper, and those of the others ----------------
  const tr = (t, ...a) => (RT.i18n && typeof RT.i18n.t === 'function' ? RT.i18n.t(t, ...a) : t.replace(/\{(\d)\}/g, (m, k) => a[k]));
  const when = (t) => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
  let projectNames = null;
  async function nameOf(key) {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (key === 'general') return tr('General questions');
    if (kind === 'item') { const it = RT.library && RT.library.items ? RT.library.items().find((x) => x.id === id) : null; return it ? ((it.fields && it.fields.title) || it.title || it.citekey || id) : tr('A paper that is no longer in the library'); }
    if (!projectNames) { projectNames = new Map(); try { for (const pr of await RT.api('/api/projects?lite=1')) projectNames.set(pr.id, pr.name || pr.id); } catch { /* shown without names */ } }
    return projectNames.get(id) || tr('A project that is no longer there');
  }
  // open a kept conversation in the panel (of the paper or project that is showing, or of the one that is opened next)
  async function openThread(key, id) {
    const cur = chats.get(key);
    if (cur && cur.id === id) return cur;
    const t = await RT.api(`/api/chats/${encodeURIComponent(key)}/${id}`);
    if (cur) archive(cur);
    const c = { key, id: t.id, session: t.s || null, p: t.p || 'claude', log: (t.log || []).map((e) => ({ c: e[0], t: e[1] })), busy: false, abort: null, live: null, status: '', dead: false, archived: false };
    chats.set(key, c);
    saveChat(c);
    if (key === active.key) { active = c; stick = true; if (shown()) renderLog(); else stale = true; reflect(); }
    return c;
  }
  async function goTo(key, id) {
    try {
      await openThread(key, id);
      if (key === active.key) return;
      const [kind, ref] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (kind === 'item' && RT.library && RT.library.select) { if (RT.setView) RT.setView('library'); RT.library.select(ref); }
      else if (kind === 'project' && RT.write && RT.write.openProject) await RT.write.openProject(ref);
      else RT.toast('Open that paper or project to see the conversation.');
    } catch (e) { RT.toast(e.message, 'bad'); }
  }
  $('#claude-history').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    let all;
    try { all = await RT.api('/api/chats'); } catch (err) { RT.toast(err.message, 'bad'); return; }
    projectNames = null;
    const key = active.key, mine = (all.find((x) => x.key === key) || { threads: [] }).threads;
    const line = (th) => `${th.title} · ${when(th.t)}`;
    const items = [{ heading: tr(key === 'general' ? 'General questions' : key.startsWith('item:') ? 'This paper' : 'This project') }];
    if (!mine.length) items.push({ label: tr('No conversation yet'), disabled: true });
    for (const th of mine) items.push({ label: line(th), icon: th.id === active.id ? 'check' : 'history', title: tr('{0} questions. Click to read it again or to go on with it.', th.n), onClick: () => goTo(key, th.id) });
    if (mine.some((th) => th.id === active.id)) {
      items.push({ label: tr('Delete this conversation'), icon: 'delete', danger: true, onClick: async () => {
        if (!(await RT.confirm('Delete the conversation that is showing? This cannot be undone.', { title: 'History', okText: 'Delete' }))) return;
        const old = active; old.dead = true; clearTimeout(old.keepTimer); if (old.abort) old.abort.abort();
        chats.delete(old.key);
        const o = readStore(); delete o.chats[old.key]; RT.ls.set(STORE, JSON.stringify(o));
        try { await RT.api(`/api/chats/${encodeURIComponent(old.key)}/${old.id}`, { method: 'DELETE' }); } catch (err) { RT.toast(err.message, 'bad'); }
        active = getChat(old.key); renderLog(); reflect();
      } });
    }
    const others = all.filter((x) => x.key !== key).slice(0, 15);
    if (others.length) {
      items.push({ sep: true }, { heading: tr('Other papers and projects') });
      for (const o of others) {
        const name = await nameOf(o.key), th = o.threads[0];
        items.push({ label: `${name.length > 46 ? name.slice(0, 45) + '…' : name} — ${th.title.length > 40 ? th.title.slice(0, 39) + '…' : th.title}`, icon: o.key.startsWith('project:') ? 'folder' : 'paper',
          title: tr('{0} conversations, the last one {1}. Click to open it there.', o.threads.length, when(o.t)), onClick: () => goTo(o.key, th.id) });
      }
    }
    RT.menu(btn, items, { align: 'end' });
  });

  // the passage that goes along with the next question (selected in the PDF or in the editor)
  let dropSel = null;
  function showSel(c) {
    const s = c.context && c.context.selection, box = $('#claude-sel');
    dropSel = typeof c.dropSelection === 'function' ? c.dropSelection : null;
    box.hidden = !(s && s.text);
    if (box.hidden) return;
    const one = s.text.replace(/\s+/g, ' ').trim();
    const where = s.kind === 'editor' ? `Selection${s.line ? ' · line ' + s.line : ''}` : `Selection${s.page ? ' · p. ' + s.page : ''}`;
    $('.claude-sel-text', box).textContent = `${where}: “${one.length > 70 ? one.slice(0, 70) + '…' : one}”`;
    box.title = 'This selection is sent along with your next question.';
  }
  $('#claude-sel-x').addEventListener('click', () => { if (dropSel) dropSel(); else $('#claude-sel').hidden = true; });

  RT.on('claude:context', (c) => {
    // the context (the open paper's cite key, the project ...) as a chip; the providers' labels start with "· "
    const el = $('#claude-ctx'), label = String(c.label || '').replace(/^\s*·\s*/, '');
    el.textContent = label; el.title = c.title || ''; el.hidden = !label;
    showSel(c);
    const key = keyOf(c.context);
    if (key === active.key) return;
    active = getChat(key); // another paper or project: its own conversation
    stick = true;
    if (shown()) renderLog(); else stale = true;
    reflect();
  });
  let wsPath = '';
  const showCmd = () => { if (wsPath) $('#claude-cmd').textContent = `cd "${wsPath}" && ${RT.ai ? RT.ai.provider().bin : 'claude'}`; };
  RT.on('status', (s) => { wsPath = s.workspace; showCmd(); });
  // another AI provider: its command in the hint and the terminal line, and the read-only note
  RT.on('ai:changed', (p) => {
    const code = $('#claude-hint code'); if (code) code.textContent = p.bin;
    const agentic = !!(p.caps && p.caps.agentic);
    $('#claude-ro').hidden = agentic; $('#claude-hint').hidden = !agentic; // ("edits your LaTeX project": Claude's, or Codex opted in)
    showCmd();
  });

  function msgEl(cls, text) {
    const m = document.createElement('div'); m.className = 'msg ' + cls; m.textContent = text;
    return m;
  }
  // draw the active conversation: what was said so far, the answer being written, the "working" line
  function renderLog() {
    stale = false; liveEl = null;
    const log = $('#claude-log');
    $$('.msg:not(.hint)', log).forEach((m) => m.remove());
    for (const e of active.log) { const m = msgEl(e.c, e.t); log.append(m); if (e.c === 'bot') pretty(m, e.t); }
    if (active.live) drawLive(active);
    stick = true; pin(); wait();
  }
  // add a message to a conversation (and to the screen when that conversation is showing)
  function push(chat, cls, text, el = null) {
    if (chat.dead) return null;
    chat.log.push({ c: cls, t: text });
    if (chat.log.length > MAX_MSGS * 2) chat.log.splice(0, chat.log.length - MAX_MSGS);
    saveChat(chat);
    if (chat !== active || !shown() || stale) { stale = stale || chat === active; return null; }
    const m = el || msgEl(cls, text);
    if (!el) $('#claude-log').append(m);
    if (cls === 'user') stick = true;
    wait(); pin(); // someone reading further up is left there
    if (cls === 'bot') pretty(m, text);
    return m;
  }
  // ---- the answer while it is written: plain text at once, drawn as Markdown again every little while
  let liveTimer = 0, liveBusy = false, liveGap = 350;
  function drawLive(chat) {
    if (chat !== active || chat.dead || !shown() || stale || !chat.live) return;
    if (!liveEl || !liveEl.isConnected) {
      liveEl = msgEl('bot live', ''); $('#claude-log').append(liveEl); wait();
    }
    if (!liveEl.classList.contains('md')) { liveEl.textContent = chat.live.text; pin(); }
    if (liveTimer || liveBusy) return;
    liveTimer = setTimeout(async () => {
      liveTimer = 0;
      const el = liveEl, text = chat.live && chat === active ? chat.live.text : null;
      if (!el || text == null || !el.classList.contains('live')) return;
      liveBusy = true;
      const t0 = performance.now();
      try { await pretty(el, text); } finally { liveBusy = false; }
      liveGap = Math.max(350, Math.min(2500, 3 * (performance.now() - t0))); // long answers are redrawn less often
      if (chat.live && chat.live.text !== text) drawLive(chat);
    }, liveGap);
  }
  // the block is complete (or the run ended): it becomes an ordinary message of the conversation
  function endLive(chat, text) {
    const t = text != null ? text : chat.live ? chat.live.text : '';
    chat.live = null;
    const el = chat === active && liveEl && liveEl.isConnected ? liveEl : null;
    if (chat === active) liveEl = null;
    if (el) el.classList.remove('live');
    if (!t.trim()) { if (el) el.remove(); return; }
    push(chat, 'bot', t, el);
  }
  // Claude answers in Markdown: headings, lists, tables, quotes, code and formulas are drawn as such (the same
  // renderer as the notes). The plain text shows first and stays if the renderer cannot be loaded.
  // the theme of Preferences (System / Light / Dark) when prefs.js is there, else the system's
  const isDark = () => (RT.prefs && RT.prefs.isDark ? RT.prefs.isDark() : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  const BAD_URL = /^[\s\u0000-\u001f]*(?:javascript|vbscript)\s*:|^[\s\u0000-\u001f]*data\s*:\s*text\/html/i;
  function scrub(root) { // never trust rendered HTML: no event handlers, no script URLs (the page's CSP blocks them as well)
    for (const el of root.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'srcdoc') el.removeAttribute(a.name);
        else if ((n === 'href' || n === 'xlink:href' || n === 'src' || n === 'action' || n === 'formaction') && BAD_URL.test(a.value)) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) { el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    }
  }
  // Drawing is asynchronous: a later call for the same bubble wins, whatever order the two finish in.
  async function pretty(m, text) {
    const seq = m._seq = (m._seq || 0) + 1;
    m._md = text; // drawn again when the theme changes
    if (!/[#*_`|>$\[\]~-]|^\s*\d+\.\s/m.test(text)) { // nothing to format
      if (m.classList.contains('md')) { m.classList.remove('md'); if (m._obs) m._obs.forEach((o) => o.disconnect()); }
      m.textContent = text;
      return;
    }
    try {
      const Vditor = await RT.vendor.vditor();
      if (!m.isConnected || seq !== m._seq) return;
      const box = document.createElement('div');
      await Vditor.preview(box, text, {
        cdn: RT.vendor.VDITOR_CDN, mode: isDark() ? 'dark' : 'light', lang: 'en_US',
        theme: { current: isDark() ? 'dark' : 'light' }, hljs: { style: isDark() ? 'github-dark' : 'github' },
        math: { engine: 'KaTeX', inlineDigit: false }, // "$5 and $10" is money, not a formula
        markdown: { mark: true, footnotes: false, toc: false, autoSpace: false, fixTermTypo: false, sanitize: true },
        after() { scrub(box); },
      });
      scrub(box);
      if (RT.reader && RT.reader.current && (RT.reader.current() || {}).pdf) RT.cite.dom(box); // (p. N) -> a chip that shows that page of the open paper
      if (!m.isConnected || seq !== m._seq || !box.textContent.trim()) return;
      box.className = 'vditor-reset claude-md' + (isDark() ? ' vditor-reset--dark' : '');
      if (m._obs) m._obs.forEach((o) => o.disconnect()); // of the drawing this one replaces
      m.textContent = ''; m.classList.add('md'); m.append(box);
      const mo = new MutationObserver(() => scrub(box)); mo.observe(box, { childList: true, subtree: true }); // diagrams and formulas are drawn a little later
      pin();
      const ro = new ResizeObserver(pin); ro.observe(box); // formulas and code colouring arrive later and make the answer taller
      m._obs = [mo, ro];
    } catch (e) { console.error('claude panel markdown:', e); }
  }
  // the theme changed (Preferences or the system; prefs.js emits theme:changed for both): draw the answers again in it
  const rethemeAnswers = () => { for (const m of document.querySelectorAll('.msg.bot.md')) if (m._md && !m.classList.contains('live')) pretty(m, m._md); };
  if (RT.prefs) RT.on('theme:changed', rethemeAnswers);
  else if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rethemeAnswers);
  // "copy code" buttons of the renderer use an inline handler, which the page's CSP blocks: do it here
  $('#claude-log').addEventListener('click', (e) => {
    const c = e.target.closest && e.target.closest('.vditor-copy'); if (!c) return;
    const ta = c.querySelector('textarea'), code = ta ? ta.value : ((c.parentElement && c.parentElement.querySelector('code')) || {}).textContent || '';
    navigator.clipboard.writeText(code).then(() => RT.toast('Copied', 'ok'), () => RT.toast('Could not copy to the clipboard', 'bad'));
  });

  const stop = (chat = active) => { if (chat.busy && chat.abort) { chat.stopped = true; chat.abort.abort(); } };
  $('#claude-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#claude-form').requestSubmit(); }
    else if (e.key === 'Escape' && active.busy && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); stop(); } // not the Esc that closes an input-method window
  });

  // One request to /api/claude; what comes back is written into `chat`, which need not be the one on screen.
  // Returns 'lost' when the CLI no longer has the conversation that was to be continued.
  async function runOnce(chat, prompt, context) {
    const res = await fetch('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RT': '1' },
      body: JSON.stringify({ prompt, sessionId: chat.session, context }), signal: chat.abort.signal });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
    chat.asked = true;
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', lost = false, finished = false;
    const status = (t) => { chat.status = t; if (chat === active) wait(); };
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      if (chat.dead) { reader.cancel().catch(() => {}); break; } // the conversation was deleted: this run is over
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'session') { chat.session = ev.sessionId; saveChat(chat); }
        else if (ev.type === 'delta') { if (!chat.live) chat.live = { text: '' }; chat.live.text += ev.text; drawLive(chat); }
        else if (ev.type === 'text') { endLive(chat, ev.text); status(''); }
        else if (ev.type === 'status') status(ev.text);
        else if (ev.type === 'tool') { endLive(chat); push(chat, 'tool', `▸ ${ev.name} ${String(ev.detail).split('/').slice(-2).join('/')}`); status(''); }
        else if (ev.type === 'error') { finished = true; endLive(chat); push(chat, 'err', ev.text); } // the server said why it ended
        else if (ev.type === 'done') {
          finished = true;
          endLive(chat);
          if (ev.lost) lost = true;
          else { if (ev.sessionId) chat.session = ev.sessionId; if (ev.isError) push(chat, 'err', ev.error || 'Claude reported an error.'); }
        }
      }
    }
    endLive(chat);
    if (!finished && !chat.dead && !lost) push(chat, 'err', 'The answer ended early - the connection to the app was lost. Ask again.');
    return lost ? 'lost' : 'ok';
  }

  $('#claude-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const here = keyOf(RT.claudeContext.current().context); // in case a view changed its context without saying so
    if (here !== active.key) { active = getChat(here); stale = true; reflect(); }
    if (active.busy) { // the button is Stop now; Enter in the box leaves the text there
      if (e.submitter) stop(); else RT.toast('Claude is still answering - press Stop (Esc) first, or wait.');
      return;
    }
    const prompt = $('#claude-input').value.trim();
    if (!prompt) return;
    if (stale) renderLog();
    const chat = active;
    chat.busy = true; chat.stopped = false; chat.status = ''; chat.abort = new AbortController();
    $('#claude-input').value = '';
    $('#claude-input').focus();
    push(chat, 'user', prompt);
    // a conversation that was held with another AI provider cannot be continued by this one
    const prov = RT.ai ? RT.ai.id() : 'claude';
    if (chat.session && (chat.p || 'claude') !== prov) { chat.session = null; push(chat, 'tool', '▸ This conversation was with another AI provider, so a new one starts here.'); }
    chat.p = prov;
    reflect();
    chat.asked = false; // the question reached the server
    try {
      if (!(await RT.flush())) throw new Error('Some files could not be saved, so Claude would not see your latest text. Resolve that and send again.');
      const cur = RT.claudeContext.current(), context = cur.context || {};
      if (keyOf(context) !== chat.key) throw new Error('The paper or project changed while your text was being saved. Send the question again.');
      const s = context.selection;
      if (s && s.text) { // said in the log, then given up: a follow-up question is not about it any more
        push(chat, 'tool', `▸ with your selection${s.kind === 'editor' ? (s.line ? ' from line ' + s.line : '') : s.page ? ' on p. ' + s.page : ''}`);
        if (typeof cur.dropSelection === 'function') cur.dropSelection();
      }
      if (chat.abort.signal.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      if ((await runOnce(chat, prompt, context)) === 'lost') {
        chat.session = null;
        push(chat, 'tool', '▸ The earlier conversation is no longer on this Mac, so Claude starts a fresh one here.');
        if ((await runOnce(chat, prompt, context)) === 'lost') push(chat, 'err', 'Claude could not start a conversation. Try again.');
      }
    } catch (err) {
      endLive(chat); // what was written so far stays
      if (chat.stopped || err.name === 'AbortError') push(chat, 'tool', '▸ Stopped.');
      else push(chat, 'err', err instanceof TypeError ? 'Could not reach the app. Check that ResearchTool is still running, then ask again.' : err.message);
      // nothing was asked yet: the question goes back into the box instead of being lost
      if (!chat.asked && !chat.stopped && chat === active && !$('#claude-input').value.trim()) $('#claude-input').value = prompt;
    }
    chat.busy = false; chat.abort = null; chat.status = '';
    saveChat(chat);
    reflect();
    RT.emit('disk:sync'); // Claude may have edited the library or project files
  });
  // leaving the page ends the runs (the server stops them): keep what was written so far
  window.addEventListener('pagehide', () => {
    for (const chat of chats.values()) {
      if (!chat.busy || chat.dead) { if (!chat.dead) keep(chat, true); continue; }
      if (chat.live && chat.live.text.trim()) chat.log.push({ c: 'bot', t: chat.live.text });
      chat.log.push({ c: 'tool', t: '▸ Interrupted when the page was closed or reloaded.' });
      chat.live = null; saveChat(chat);
    }
  });
  reflect();

  // Open the panel and send `prompt` as if the user had typed it (used by "Fix with Claude" menus).
  // While another request is running the text is only placed in the box, for the user to send afterwards.
  function ask(prompt) {
    toggle(true);
    $('#claude-input').value = prompt;
    if (active.busy) { RT.toast('Claude is still working — the request is in the box, press Enter when it is done.'); return false; }
    $('#claude-form').requestSubmit();
    return true;
  }
  Object.assign(RT.claude, { toggle, ask, isOpen: () => !$('#claude').hidden });
})();
