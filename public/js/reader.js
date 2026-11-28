/* Library tab, right pane (#detail): the reading workspace of the open reference.
   Left: PDF viewer (pdf.js: lazy pages, text layer, search, selection popover, snapshot tool).
   Right: tabs  Notes (Vditor Markdown editor, autosave, history, first draft by Claude) | Key points | Details.
   The place where the PDF was left (page, offset, zoom) is saved with the item and restored on open; the paper that was
   open is opened again at start. Page links ([p. 7](#rt-page=7) in a note, the page chips of key points) jump the PDF.
   RT.reader.open(id) / close(); listens to 'item:open'. Edits item objects from RT.library.items() in place and saves
   them; the note itself lives on the server in notes/<itemId>.md (GET/PUT /api/items/:id/note).
   Papers of a project (RT.projectPapers): the bookmark beside the star and the "Projects" line of the Details tab;
   reaching the last page of a paper that has a note asks once per session whether it is done.
   The "Verified venue" line of Details shows the venue check of RT.library (venue(id), checkVenues) and follows 'venues:changed'. */
(() => {
  const { $, $$, esc, api, toast, debounce, ls } = RT;
  RT.reader = RT.reader || {};

  const CATS = ['key', 'summary', 'background', 'problem', 'contribution', 'method', 'result', 'limitation', 'conclusion'];
  const TYPES = ['article', 'inproceedings', 'book', 'incollection', 'phdthesis', 'techreport', 'misc'];
  // the team's callouts - mirror of CALLOUTS in lib/notejson.js (colours are in reader.css)
  const CALLOUTS = {
    // icon + label: what the button inserts (the team's Markdown, unchanged); tip: the button's tooltip (UI text)
    abstract: { icon: '🏕️', label: '摘要', hint: 'green', tip: 'Summary callout (green)' }, key: { icon: '🍞', label: '重点讲解', hint: 'red', tip: 'Key explanation callout (red)' },
    concept: { icon: '✏️', label: '概念解释', hint: 'purple', tip: 'Concept callout (purple)' }, background: { icon: '🦄', label: '背景介绍', hint: 'orange', tip: 'Background callout (orange)' },
    ai: { icon: '💬', label: 'Claude', hint: 'blue' }, // a comment Claude wrote (right-click in the note, "Ask Claude")
  };
  const PURPLE = 'rgba(205,178,250,0.7)';
  // the tabs of the working pane: [id, icon, label, tooltip]
  const TABS = [
    ['notes', 'note', 'Notes', 'Notes: your reading note of the paper'],
    ['diagram', 'graph-node', 'Diagram', 'Diagram: let Claude draw the paper as a pipeline, workflow or flow chart with an explanation for every box'],
    ['quiz', 'quiz', 'Practice', 'Practice: a quiz that tests how well you understand the paper, with an explanation after every answer'],
    ['kp', 'highlight', 'Key points', 'Key points: the sentences that carry the paper, with your remarks'],
    ['details', 'info', 'Details', 'Details: bibliographic fields, PDF file, BibTeX'],
    ['related', 'lineage', 'Related', 'Related: the papers this one cites and the papers that cite it, with the ones in your library marked'],
  ];
  // faces of the labelled buttons of the Notes bar (their busy state swaps the icon for a spinner)
  const DRAFT_FACE = (busy = false) => `${busy ? '<span class="spin"></span>' : RT.icon('sparkle')}<span class="ib-text">${busy ? 'Drafting…' : 'Draft with Claude'}</span>`;
  const FIG_FACE = (busy = false) => `${busy ? '<span class="spin"></span>' : RT.icon('figure')}<span class="ib-text">Figures</span>`;
  const d = $('#detail');
  let cur = null, sentences = null, showSent = false; // cur: id of the open item
  let pdfView = null;                                  // viewer of the open item (or null)

  const items = () => (RT.library && RT.library.items ? RT.library.items() : []);
  const current = () => items().find((i) => i.id === cur);
  // The paper the reader shows, when current() no longer finds it (the list the library holds was reloaded or
  // replaced without it): look again - the list as it is now, then the library refreshed once - by the id that is
  // open. Still not there: say so, instead of a click that does nothing. Resolves the item, or null.
  const LOST = 'This paper is no longer in the library view - reopen it from the list';
  const openId = () => cur || ($('.rd-body', d) && d.dataset.item) || null; // (a paper's page is on screen)
  let recovering = null;
  async function recoverCurrent(where) {
    const id = openId();
    if (!id) return null;
    let it = items().find((i) => i.id === id);
    if (!it && RT.library && RT.library.refresh) {
      if (!recovering) recovering = Promise.resolve().then(() => RT.library.refresh()).catch((e) => RT.errors && RT.errors.log(e, 'reader: library refresh')).finally(() => { recovering = null; });
      await recovering;
      it = items().find((i) => i.id === id);
    }
    if (it) { cur = it.id; RT.state.sel = it.id; return it; }
    if (RT.errors) RT.errors.log(new Error(`the open paper ${id} is not in RT.library.items() (${items().length} items)`), where || 'reader');
    toast(LOST, 'bad');
    return null;
  }
  const report = (err, where) => (RT.reportError ? RT.reportError(err, where) : fail(err));
  // the AI that writes a comment into the note (Preferences › AI): its name goes into the note text, which the display
  // layer never rewrites, so it must be the real one (an Antigravity answer is not labelled Claude)
  const aiName = () => (RT.ai && RT.ai.name ? RT.ai.name() : 'Claude');
  const aiNameOf = (id) => (RT.ai && RT.ai.nameOf ? RT.ai.nameOf(id) : 'Claude'); // the provider that made saved content
  // whether the provider looks at pictures (Grok and Antigravity do not here): picture questions are offered only then
  const seesPictures = () => !(RT.ai && RT.ai.caps && RT.ai.caps().readsImage === false);
  const rid = () => Math.random().toString(16).slice(2, 12);
  // the theme of Preferences (<html data-theme>), else the system's
  const isDark = () => (RT.prefs && RT.prefs.isDark ? RT.prefs.isDark() : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  // editor UI language: localStorage rt.lang ('zh' | 'en', the note menu's "Editor language"), else the display language
  // of Preferences (rt.ui.lang), else the page language
  const uiLang = () => { const l = ls.get('rt.lang') || ls.get('rt.ui.lang') || document.documentElement.lang || 'en'; return /^zh/i.test(l) ? 'zh_CN' : 'en_US'; };
  const fail = (e) => toast(e && e.message ? e.message : String(e), 'bad');
  // a file drop handled here must not also reach the Library view (which would import it): stop it, then let core
  // reset its drag state with an empty drop
  function swallowDrop(e) {
    e.preventDefault(); e.stopPropagation();
    try { window.dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer() })); } catch { document.body.classList.remove('dragging'); }
  }

  // ====================================================================== Markdown normalisation
  // Vditor re-serialises Markdown (padded tables, "<br />", "[X]", extra blank lines). canon() brings its output
  // back to the note conventions that lib/notejson.js round-trips: compact GFM tables with :---: / --- separators,
  // <br>, "- [x] ", single blank lines, one trailing newline. Fenced code and $$ blocks are left untouched.
  function canon(md) {
    const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let fence = null, math = false;
    const splitRow = (l) => {
      let s = l.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
      const cells = []; let c = '';
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) { c += s[i] + s[i + 1]; i++; } else if (s[i] === '|') { cells.push(c.trim()); c = ''; } else c += s[i];
      }
      cells.push(c.trim());
      return cells;
    };
    const SEP = /^\s*\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (fence) { out.push(l); if (l.trim().replace(/^(>\s*)+/, '').startsWith(fence) && /^[`~\s>]+$/.test(l)) fence = null; continue; }
      if (!math) { const fm = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(l); if (fm) { fence = fm[1]; out.push(l); continue; } }
      if (/^\s*(?:>\s*)*\$\$\s*$/.test(l)) { math = !math; out.push(l.replace(/\s+$/, '')); continue; }
      if (math) { out.push(l); continue; }
      if (!l.trim()) { if (out.length && out[out.length - 1] === '') continue; out.push(''); continue; }
      if (l.trimStart().startsWith('|') && i + 1 < lines.length && SEP.test(lines[i + 1])) { // a table
        out.push('| ' + splitRow(l).join(' | ') + ' |');
        out.push('| ' + splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? ':---:' : /^:-+$/.test(c) ? ':---' : /^-+:$/.test(c) ? '---:' : '---')).join(' | ') + ' |');
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { out.push('| ' + splitRow(lines[i].replace(/<br\s*\/>/g, '<br>')).join(' | ') + ' |'); i++; }
        i--;
        continue;
      }
      l = l.replace(/<br\s*\/>/g, '<br>');
      l = l.replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]) \[)([ xX])\]\s+/, (m, a, c) => a + (c === ' ' ? ' ' : 'x') + '] ');
      out.push(l);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    while (out.length && out[0] === '') out.shift();
    return out.length ? out.join('\n') + '\n' : '';
  }

  // ====================================================================== Markdown editor (Vditor)
  const IC = (html, cls = '') => `<span class="rd-tbi ${cls}">${html}</span>`;
  const previewOptions = () => ({
    cdn: RT.vendor.VDITOR_CDN, mode: isDark() ? 'dark' : 'light', lang: uiLang(),
    theme: { current: isDark() ? 'dark' : 'light' }, hljs: { style: isDark() ? 'github-dark' : 'github' },
    math: { engine: 'KaTeX', inlineDigit: true },
    markdown: { mark: true, footnotes: true, toc: false, autoSpace: false, fixTermTypo: false, sanitize: true },
  });

  // ---- pictures and videos in a note
  // A picture is plain Markdown; a width chosen by hand is kept in the address, ![alt](url#w=320): every other
  // Markdown viewer ignores the fragment and shows the picture at its own size. A video is an HTML block,
  // <video src="url" controls width="480"></video>, the only form Markdown has for it.
  const isVideoUrl = (u) => /\.(mp4|webm|mov)(#.*)?$/i.test(String(u));
  const isMediaFile = (f) => /^(image|video)\//.test(f.type) || /\.(mp4|m4v|webm|mov)$/i.test(f.name || '');
  const mediaMd = (name, url) => (isVideoUrl(url) ? `<video src="${url}" controls preload="metadata" width="480"></video>`
    : `![${String(name || 'image').replace(/[\[\]\\]/g, '')}](${url})`);
  // the widths are applied by a style sheet (one rule per width in use), so the editor's own DOM is never touched
  const seenW = new Set();
  function sizeRules(md) {
    let added = false;
    for (const m of String(md || '').matchAll(/#w=(\d{2,4})(?=[)\s"'>]|$)/g)) if (!seenW.has(m[1])) { seenW.add(m[1]); added = true; }
    if (!added) return;
    let el = document.getElementById('rt-img-w');
    if (!el) { el = document.createElement('style'); el.id = 'rt-img-w'; document.head.append(el); }
    el.textContent = [...seenW].map((w) => `.vditor-reset img[src$="#w=${w}"]{width:${w}px;max-width:100%;height:auto}`).join('\n');
  }
  // "Ask Claude" comments that wait for their answer (ids of their placeholder lines). A placeholder that no request
  // of this page is going to fill - the page was reloaded while Claude was writing - is taken out when a note opens.
  const asking = new Set();
  const dropStaleAsks = (md) => String(md || '').replace(/^> \[!ai\][^\n]*\n>[^\n]*⟦([a-z0-9]{4,8})⟧[^\n]*\n?/gm, (all, id) => (asking.has(id) ? all : ''));
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a page reference in a note: [p. 7](#rt-page=7). Clicking it shows that page of the PDF.
  const pageLink = (n) => `[p. ${Number(n)}](#rt-page=${Number(n)})`;
  const PAGE_HREF = /^#rt-page=(\d{1,5})$/;

  // Create an editor in `host`. opts: {value, onInput(), onSave(), upload(file) -> Promise<url>, split: bool,
  // page(n, nearbyText) -> called when a page link is clicked}
  // Returns {value(), set(md), insert(md), wrap(a, b), focus(), disable(bool), destroy(), vd}.
  async function createEditor(host, opts) {
    const Vditor = await RT.vendor.vditor();
    host.innerHTML = '<div class="rd-ed-main"></div><div class="rd-preview vditor-reset" hidden></div>'
      + `<div class="rd-dictate" role="status" hidden><span class="rd-dictate-dot" aria-hidden="true"></span><span class="rd-dictate-l">Listening…</span><span class="rd-dictate-t" data-i18n-skip></span><button type="button" class="ib" title="Stop dictation" aria-label="Stop dictation">${RT.icon('stop')}</button></div>`;
    const main = $('.rd-ed-main', host), preview = $('.rd-preview', host);
    let vd, lastRange = null, destroyed = false, split = false, foundTimer = null;
    const contentEl = () => vd.vditor[vd.getCurrentMode()].element;
    const inEditor = (node) => node && contentEl().contains(node);

    const api_ = {
      vd: null,
      value: () => canon(vd.getValue()),
      set(md) { md = dropStaleAsks(md); sizeRules(md); vd.setValue(String(md || ''), true); lastRange = null; decorate(); renderPreview(); },
      focus() { vd.focus(); },
      disable(on) { if (on) vd.disabled(); else vd.enable(); },
      // put the caret back where it was in the editor (or at the end) before inserting from outside
      restoreCaret() {
        const sel = window.getSelection();
        if (sel.rangeCount && inEditor(sel.getRangeAt(0).startContainer)) return;
        const el = contentEl();
        el.focus();
        const r = lastRange && el.contains(lastRange.startContainer) ? lastRange : (() => { const x = document.createRange(); x.selectNodeContents(el); x.collapse(false); return x; })();
        sel.removeAllRanges(); sel.addRange(r);
      },
      // Insert Markdown at the caret. Vditor's insertValue() takes HTML, so Markdown goes through insertMD (Lute
      // renders it for the current mode) and plain strings are HTML-escaped first.
      insert(md) { api_.restoreCaret(); vd.insertMD(String(md)); changed(); },
      // Put words in at the caret the way typing does (dictation): the editor treats them as typed text.
      type(text) { api_.restoreCaret(); if (!document.execCommand('insertText', false, String(text))) vd.insertValue(esc(String(text))); changed(); },
      // Insert a block (callout, formula, table, image, quote) as its own block right after the block that holds
      // the caret, so it never ends up inside a heading, a list item or another callout.
      insertBlock(md) {
        api_.restoreCaret(); sizeRules(md);
        const el = contentEl(), sel = window.getSelection();
        let top = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
        while (top && top !== el && top.parentNode !== el) top = top.parentNode;
        if (!top || top === el || top.nodeType !== 1) top = el.lastElementChild; // caret not inside a block: append
        if (!top || (top.textContent || '').trim()) {
          const p = document.createElement('p');
          p.setAttribute('data-block', '0'); p.textContent = '\n';
          if (top) top.after(p); else el.append(p);
          const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
          sel.removeAllRanges(); sel.addRange(r);
        }
        vd.insertMD(String(md).trim() + '\n');
        // an inserted diagram / chart block is only drawn when the document is rendered as a whole
        if (/^(```|~~~)\s*(mermaid|echarts|flowchart|graphviz|plantuml|mindmap)\b/m.test(String(md))) { vd.setValue(vd.getValue()); lastRange = null; decorate(); }
        changed();
      },
      // wrap the selection (or a placeholder) in a / b
      wrap(a, b, placeholder = 'text') {
        api_.restoreCaret();
        const s = vd.getSelection();
        vd.updateValue(esc(a + (s || placeholder) + b));
        changed();
      },
      // Scroll to the block of the note that holds a passage found by the Library search and light it up for a
      // moment. `text` is the line as the search shows it, `words` the words that were searched. Nothing in the note
      // is changed (the mark is a CSS highlight over a range). Returns false when the passage is not there any more.
      reveal(text, words = []) {
        const letters = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const want = letters(text), toks = words.map((w) => String(w).toLowerCase()).filter(Boolean);
        const root = contentEl();
        const blocks = $$('p, li, h1, h2, h3, h4, h5, h6, td, th, pre', root).filter((b) => !$('p, li', b));
        let best = null, loose = null;
        for (const b of blocks.length ? blocks : [...root.children]) {
          const raw = (b.textContent || '').toLowerCase();
          if (!raw.trim()) continue;
          const mine = letters(raw);
          if (want.length >= 6 && (mine.includes(want) || (mine.length >= 12 && want.includes(mine)) || mine.includes(want.slice(0, 40)))) { best = b; break; }
          if (!loose && toks.length && toks.every((w) => raw.includes(w))) loose = b;
        }
        const el = best || loose;
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        if (window.Highlight && window.CSS && CSS.highlights) {
          const r = document.createRange(); r.selectNodeContents(el);
          CSS.highlights.set('rt-found', new Highlight(r));
          clearTimeout(foundTimer); foundTimer = setTimeout(() => CSS.highlights.delete('rt-found'), 2600);
        }
        return true;
      },
      toggleSplit(on) {
        split = on === undefined ? !split : !!on;
        preview.hidden = !split; host.classList.toggle('split', split);
        ls.set('rt.reader.split', split ? '1' : '0');
        renderPreview();
      },
      destroy() {
        if (offSpeech) { offSpeech(); RT.speech.stopListening(); RT.speech.stop('note'); }
        destroyed = true; mo.disconnect(); moPreview.disconnect(); document.removeEventListener('selectionchange', onSel); clearTimeout(rsTimer);
        if (window.CSS && CSS.highlights) { CSS.highlights.delete('rt-pcite'); CSS.highlights.delete('rt-found'); }
        clearTimeout(foundTimer);
        // Vditor's destroy() removes #vditorIconScript, the icon file RT.vendor.vditor() loaded by src; without it the next
        // editor fetches the icons again as an inline script, which the page's CSP blocks: put the (already run) element back
        const icons = document.getElementById('vditorIconScript');
        try { vd.destroy(); } catch { /* already gone */ }
        if (icons && !icons.isConnected) document.head.append(icons);
        host.innerHTML = '';
      },
    };
    const changed = () => { if (destroyed) return; decorateSoon(); renderPreviewSoon(); if (opts.onInput) opts.onInput(); };

    // ---- links. A page link (#rt-page=N) shows that page of the PDF and is given the text written before it in
    // the same paragraph (the quote), so the viewer can light the passage up. Any other link opens in a new tab.
    // `el` is the link itself (<a>, or the editor's own node for a link in the editing view).
    function followLink(el, url) {
      url = String(url || '').trim();
      const m = PAGE_HREF.exec(url);
      if (!m) { if (url && !BAD_URL.test(url) && !url.startsWith('#')) window.open(url, '_blank', 'noopener'); return; }
      let near = '';
      try {
        const block = el.closest('p, li, td, th, blockquote');
        if (block) { const r = document.createRange(); r.selectNodeContents(block); r.setEndBefore(el); near = r.toString(); }
      } catch { /* no text: the page alone */ }
      if (opts.page) opts.page(Number(m[1]), near);
    }
    preview.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]'); if (!a || !preview.contains(a)) return;
      if (PAGE_HREF.test(a.getAttribute('href') || '')) { e.preventDefault(); followLink(a, a.getAttribute('href')); }
    });

    // ---- resizing pictures and videos by hand: a frame with a corner grip over the one under the mouse. The frame
    // lives outside the editable area; the new width is written into the Markdown (see sizeRules / mediaMd above).
    const rs = document.createElement('div');
    rs.className = 'rd-rs'; rs.hidden = true;
    rs.innerHTML = '<span class="rd-rs-bar"><span class="rd-rs-info"></span><button type="button" class="rd-rs-reset" title="Back to the original size" aria-label="Back to the original size">↺</button></span><span class="rd-rs-grip" title="Drag to resize"></span>';
    host.append(rs);
    let rsEl = null, rsDrag = null, rsTimer = 0;
    const mediaOf = (t) => {
      const m = vd && t && t.closest ? t.closest('img, video') : null;
      return m && contentEl().contains(m) && !m.classList.contains('emoji') && m.getAttribute('src') ? m : null;
    };
    const baseSrc = (m) => (m.getAttribute('src') || '').replace(/#w=\d+$/, '');
    function rsPlace() {
      if (!rsEl) return;
      if (!rsEl.isConnected || destroyed) return rsHide();
      const h = vd.vditor.element.getBoundingClientRect(), r = rsEl.getBoundingClientRect(); // viewport coordinates: also right in fullscreen
      Object.assign(rs.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      rs.classList.toggle('low', r.top - h.top < 70); // no room above (the toolbar is there): the size goes inside the frame
      $('.rd-rs-info', rs).textContent = RT.i18n && RT.i18n.t ? RT.i18n.t('{0} px wide', Math.round(r.width)) : `${Math.round(r.width)} px wide`;
      rs.hidden = false;
    }
    function rsHide() { clearTimeout(rsTimer); if (rsDrag) return; rsEl = null; rs.hidden = true; }
    function rsCommit(m, w) {
      const video = m.tagName === 'VIDEO', base = baseSrc(m);
      const nth = $$(video ? 'video' : 'img', contentEl()).filter((x) => baseSrc(x) === base).indexOf(m);
      if (nth < 0) { rsEl = null; rs.hidden = true; return; } // the note was redrawn meanwhile
      let k = -1, done = false;
      // code is not rendered: fenced blocks are left alone, and inline code is matched first so it is skipped
      const outsideCode = (src, re, fn) => {
        let fence = null;
        return src.split('\n').map((ln) => {
          const f = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(ln);
          if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return ln; }
          if (f) { fence = f[1]; return ln; }
          return ln.replace(re, (all, ...g) => (all[0] === '`' ? all : fn(all, ...g)));
        }).join('\n');
      };
      let md = vd.getValue();
      if (video) md = outsideCode(md, /(`+)[^`\n]*?\1|<video\b[^>]*>/gi, (tag) => {
        if (!tag.includes(base) || ++k !== nth) return tag;
        done = true;
        const t = tag.replace(/\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        return w ? t.replace(/\s*\/?>$/, ` width="${w}">`) : t;
      });
      else md = outsideCode(md, new RegExp('(`+)[^`\\n]*?\\1|(!\\[(?:[^\\[\\]\\\\]|\\\\.|\\[(?:[^\\[\\]\\\\]|\\\\.)*\\])*\\]\\(\\s*<?' + escRe(base) + ')(?:#w=\\d+)?(?=[)\\s>])', 'g'), (all, tick, a) => {
        if (++k !== nth) return all;
        done = true; return a + (w ? '#w=' + w : '');
      });
      rsEl = null; rs.hidden = true;
      if (!done) { m.style.width = ''; m.style.height = ''; return toast('This one cannot be resized here: it is not written as a Markdown picture or a <video> tag.', 'bad'); }
      const top = contentEl().scrollTop;
      sizeRules(md); vd.setValue(md); lastRange = null; decorate();
      contentEl().scrollTop = top;
      changed();
    }
    // ---- right-click: ask Claude about the selection, a picture, a table or the block under the mouse. The answer
    // is appended below that block as a comment ("> [!ai]" callout); a selected phrase is highlighted (==phrase==)
    // and the block the comment belongs to is tinted by reader.css. opts.ask(payload) -> Promise<text>.
    const ASKS = [['explain', 'Explain this'], ['foundations', 'Explain the foundations'], ['meaning', 'What does it mean here?'], ['example', 'Give an example'], ['ask', 'Ask your own question…']];
    const ASK_LABEL = { explain: 'Explain', foundations: 'Foundations', meaning: 'Meaning', example: 'Example', ask: 'Question' };
    const askMenu = document.createElement('div');
    askMenu.className = 'popover menu rd-ask'; askMenu.hidden = true;
    host.append(askMenu);
    let askTarget = null;
    const oneLine = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const topBlock = (node) => { const el = contentEl(); let t = node; while (t && t !== el && t.parentNode !== el) t = t.parentNode; return t && t !== el && t.nodeType === 1 ? t : null; };
    const closeAsk = () => { askMenu.hidden = true; askTarget = null; };
    function askTargetAt(e) {
      const el = contentEl(), t = e.target, sel = window.getSelection();
      if (!el.contains(t) || vd.getCurrentMode() === 'sv') return null;
      const range = sel.rangeCount && !sel.isCollapsed && el.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).cloneRange() : null;
      // the text as it is written (a formula as $z_t$), without the rendered copies the editor shows beside the source
      const srcText = (node) => { const c = node.cloneNode ? node.cloneNode(true) : node; c.querySelectorAll('.vditor-ir__preview, .vditor-wysiwyg__preview, .katex').forEach((x) => x.remove()); return (c.textContent || '').trim(); };
      const picked = range ? srcText(range.cloneContents()) : '';
      if (picked) {
        const a = topBlock(range.startContainer), b = topBlock(range.endContainer);
        // highlighted only when it is plain text inside one piece of text: never across formatting, formulas, code or a table
        const single = a && a === b && range.startContainer === range.endContainer && range.startContainer.nodeType === 3 && !/\n/.test(picked)
          && !(range.startContainer.parentElement || el).closest('mark, code, table, .vditor-ir__marker, .vditor-ir__preview, .vditor-wysiwyg__preview, .katex, .language-math, [data-type="math-inline"], [data-type="math-block"]');
        return { kind: 'text', text: picked.slice(0, 6000), quote: oneLine(picked, 60), block: b || a, range, single };
      }
      const media = t.closest('img, video');
      if (media && media.tagName === 'VIDEO') return null; // Claude cannot watch a video: the browser's own menu
      const block = topBlock(t); if (!block) return null;
      if (media && !media.classList.contains('emoji')) {
        const m = /\/note\/assets\/([0-9a-f]{40}\.(?:png|jpe?g|gif|webp))/.exec(media.getAttribute('src') || ''); // pictures Claude can look at
        if (m && !seesPictures()) { // a provider that does not look at pictures (Preferences › AI says so): its caption, if any
          const alt = (media.getAttribute('alt') || '').trim();
          return alt ? { kind: 'text', text: alt.slice(0, 6000), quote: oneLine(alt, 60), block } : { kind: 'noimage', quote: 'picture', block };
        }
        if (m) return { kind: 'image', asset: m[1], text: media.getAttribute('alt') || '', quote: oneLine(media.getAttribute('alt') || 'picture', 40) || 'picture', block };
      }
      const table = t.closest('table');
      if (table && el.contains(table)) {
        const rows = [...table.rows].map((r) => [...r.cells].map((c) => oneLine(c.textContent, 200)).join(' | ')).join('\n');
        return { kind: 'table', text: rows.slice(0, 6000), quote: 'table: ' + oneLine(table.rows[0] ? [...table.rows[0].cells].map((c) => c.textContent.trim()).join(', ') : '', 40), block };
      }
      const text = srcText(block);
      if (!text || block.getAttribute('data-rt-callout') === 'ai') return null;
      return { kind: 'block', text: text.slice(0, 6000), quote: oneLine(text, 60), block };
    }
    host.addEventListener('contextmenu', (e) => {
      if (!opts.ask || e.shiftKey || destroyed || !vd || (opts.busy && opts.busy())) return; // Shift + right-click: the browser's own menu
      const tg = askTargetAt(e); if (!tg) return;
      e.preventDefault();
      askTarget = tg;
      if (tg.kind === 'noimage') askMenu.innerHTML = `<div class="rd-ask-h muted">Questions about a picture are not possible with Claude - select its caption or the text around it.</div><hr><div class="rd-ask-h muted">Shift + right-click: the browser's menu</div>`;
      else askMenu.innerHTML = `<div class="rd-ask-h muted">Ask Claude about “${esc(tg.quote)}”</div>${ASKS.map(([m, l]) => `<button type="button" data-ask="${m}">${l}</button>`).join('')}<hr><div class="rd-ask-h muted">The answer is added below as a comment · Shift + right-click: the browser's menu</div>`;
      askMenu.hidden = false;
      const mw = askMenu.offsetWidth, mh = askMenu.offsetHeight;
      askMenu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - mw - 4)) + 'px';
      askMenu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - mh - 4)) + 'px';
    });
    askMenu.addEventListener('mousedown', (e) => e.preventDefault()); // the selection in the note stays
    askMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b && askTarget) { const tg = askTarget; closeAsk(); ask(tg, b.dataset.ask); } });
    host.addEventListener('mousedown', (e) => { if (!askMenu.hidden && !askMenu.contains(e.target)) closeAsk(); });
    host.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !askMenu.hidden) { closeAsk(); e.stopPropagation(); } }, true);
    // apply fn(markdown) -> markdown to this editor
    // where the caret is: (index of its top-level block, characters before it in that block)
    const caretMark = () => {
      const el = contentEl(), sel = window.getSelection();
      if (!sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return null;
      const r = sel.getRangeAt(0), b = topBlock(r.startContainer); if (!b) return null;
      const pre = document.createRange(); pre.selectNodeContents(b); pre.setEnd(r.startContainer, r.startOffset);
      return { i: [...el.children].indexOf(b), n: el.children.length, off: pre.toString().length };
    };
    const caretBack = (m) => {
      const el = contentEl();
      if (!m || m.i < 0 || el.children.length !== m.n) return; // blocks were added or removed: leave it
      const b = el.children[m.i], tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      let left = m.off, node, last = null;
      while ((node = tw.nextNode())) { last = node; if (left <= node.data.length) break; left -= node.data.length; }
      if (!last) return;
      const r = document.createRange(); r.setStart(node || last, Math.min(left, (node || last).data.length)); r.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    };
    api_.patch = (fn) => {
      const md = vd.getValue(), next = fn(md);
      if (next === md) return false;
      const top = contentEl().scrollTop, mark = caretMark();
      sizeRules(next); vd.setValue(next); lastRange = null; decorate();
      contentEl().scrollTop = top; caretBack(mark);
      changed();
      return true;
    };
    async function ask(tg, mode) {
      let question = '';
      if (mode === 'ask') { question = ((await RT.ask({ title: 'Ask Claude', message: `Your question about “${tg.quote}”:`, okText: 'Ask', icon: 'send' })) || '').replace(/\s+/g, ' ').trim(); if (!question) return; }
      if (!tg.block || !tg.block.isConnected) return toast('That part of the note has changed - right-click it again.', 'bad');
      if (opts.busy && opts.busy()) return toast('Claude is writing the draft - wait until it is finished.', 'bad');
      const id = Math.random().toString(36).slice(2, 8), sel = window.getSelection();
      const clean = (s) => String(s).replace(/[\\`*_$\[\]<>|=~]/g, '').replace(/\s+/g, ' ').trim();
      // 1. highlight the selected phrase (when it sits inside one block) and put the caret into the block
      const r = document.createRange();
      if (tg.kind === 'text' && tg.single && tg.range && contentEl().contains(tg.range.commonAncestorContainer)) {
        sel.removeAllRanges(); sel.addRange(tg.range);
        const s = vd.getSelection();
        if (s && !/\n/.test(s)) vd.updateValue(esc('==' + s + '=='));
      } else { r.selectNodeContents(tg.block); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
      // 2. the comment, with a placeholder line that the answer replaces
      const headOf = (who) => `> [!ai] 💬 **${who} · ${ASK_LABEL[mode]}** — “${clean(mode === 'ask' ? oneLine(question, 80) : tg.quote)}”`;
      asking.add(id);
      api_.insertBlock(`${headOf(aiName())}\n> ⏳ ${aiName()} is writing… ⟦${id}⟧`);
      { const top = contentEl().scrollTop; vd.setValue(vd.getValue()); lastRange = null; decorate(); contentEl().scrollTop = top; } // tidy: the comment sits right under its block
      // 3. ask, then swap the placeholder for the answer (or take the comment away again)
      const line = new RegExp('^>[^\\n]*⟦' + id + '⟧[^\\n]*$', 'm'), whole = new RegExp('^> \\[!ai\\][^\\n]*\\n>[^\\n]*⟦' + id + '⟧[^\\n]*\\n?', 'm');
      let fn, ok = false;
      try {
        const res = await opts.ask({ mode, question, kind: tg.kind, text: tg.text, asset: tg.asset });
        const answer = res && typeof res === 'object' ? res.text : res, by = (res && res.provider) || aiName(); // the provider that answered
        const body = RT.cite.md(String(answer).trim()).split('\n').map((l) => (l.trim() ? '> ' + l.trim() : '>')).join('\n');
        // the comment's head names the provider that answered (the server says which), then the answer replaces the placeholder
        fn = (md) => (whole.test(md) ? md.replace(whole, (m) => `${headOf(by)}\n${body}${m.endsWith('\n') ? '\n' : ''}`) : md.replace(line, () => body)); ok = true;
      } catch (err) { fn = (md) => md.replace(whole, ''); toast('Claude could not answer: ' + (err.message || err), 'bad'); }
      // the note may have been closed meanwhile: then the saved note (or the editor that reopened it) is patched
      while (opts.busy && opts.busy()) await new Promise((r) => setTimeout(r, 1000)); // a draft is being written: the answer waits for it
      const done = destroyed ? (opts.patchLater ? await opts.patchLater(fn).catch(() => false) : false) : api_.patch(fn);
      if (!destroyed) { try { vd.clearStack(); } catch { /* older Vditor */ } } // Undo must not bring the placeholder back
      asking.delete(id);
      if (ok) toast(done ? 'Claude added a comment to the note' : 'Claude answered, but its comment had been removed from the note.', done ? 'ok' : '');
    }

    host.addEventListener('mouseover', (e) => {
      if (rsDrag) return;
      if (rs.contains(e.target)) return clearTimeout(rsTimer);
      const m = mediaOf(e.target);
      if (m) { clearTimeout(rsTimer); rsEl = m; rsPlace(); }
    });
    host.addEventListener('mouseout', (e) => {
      if (rsDrag || !rsEl) return;
      const to = e.relatedTarget;
      if (to && to.nodeType === 1 && (rs.contains(to) || to === rsEl)) return;
      clearTimeout(rsTimer); rsTimer = setTimeout(rsHide, 220);
    });
    host.addEventListener('scroll', () => { if (!rsDrag) rsPlace(); }, true);
    rs.addEventListener('pointerdown', (e) => {
      if (!e.target.classList.contains('rd-rs-grip') || !rsEl || e.button !== 0) return;
      e.preventDefault();
      const el = contentEl(), cs = getComputedStyle(el);
      rsDrag = { x: e.clientX, w: rsEl.getBoundingClientRect().width, now: null, id: e.pointerId,
        max: Math.max(80, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) };
      try { e.target.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
    });
    rs.addEventListener('pointermove', (e) => {
      const g = rsDrag; if (!g || e.pointerId !== g.id || !rsEl) return;
      g.now = Math.round(Math.min(g.max, Math.max(40, g.w + e.clientX - g.x)));
      rsEl.style.width = g.now + 'px'; rsEl.style.height = 'auto'; // shown at once; the Markdown is written when the drag ends
      rsPlace();
    });
    const rsEnd = (e) => {
      const g = rsDrag; if (!g || e.pointerId !== g.id) return;
      rsDrag = null;
      if (rsEl && !rsEl.isConnected) { rsEl = null; rs.hidden = true; } // the note was redrawn during the drag
      else if (rsEl && g.now && e.type === 'pointerup') rsCommit(rsEl, g.now);
      else { if (rsEl) { rsEl.style.width = ''; rsEl.style.height = ''; } rsHide(); }
    };
    rs.addEventListener('pointerup', rsEnd);
    rs.addEventListener('pointercancel', rsEnd);
    rs.addEventListener('click', (e) => { if (e.target.classList.contains('rd-rs-reset') && rsEl) rsCommit(rsEl, null); });

    // ---- never trust the HTML a note renders to. Lute's sanitizer misses some attribute injections (footnote
    // labels) and mermaid "click" links, so after every render: drop all on* attributes and every link / source that
    // is a javascript:, vbscript: or data:text/html URL. (The page's Content-Security-Policy blocks them as well.)
    const BAD_URL = /^[\s\u0000-\u001f]*(?:javascript|vbscript)\s*:|^[\s\u0000-\u001f]*data\s*:\s*text\/html/i;
    function scrub(root) {
      if (!root) return;
      for (const el of root.querySelectorAll('*')) {
        for (const a of [...el.attributes]) {
          const n = a.name.toLowerCase();
          if (n.startsWith('on')) el.removeAttribute(a.name);
          else if ((n === 'href' || n === 'xlink:href' || n === 'src' || n === 'action' || n === 'formaction' || n === 'srcdoc') && (n === 'srcdoc' || BAD_URL.test(a.value))) el.removeAttribute(a.name);
        }
      }
    }
    // ---- callouts: colour blockquotes whose first line is [!type] (the marker itself is hidden in the
    // rendered editing views and the preview; the source view still shows it)
    function decorate() {
      if (destroyed || !vd) return;
      scrub(contentEl());
      for (const bq of $$('blockquote', contentEl())) {
        const m = /^\s*\[!(\w+)\]/.exec(bq.textContent || '');
        const type = m ? (CALLOUTS[m[1].toLowerCase()] ? m[1].toLowerCase() : 'note') : null;
        if (type) { if (bq.getAttribute('data-rt-callout') !== type) bq.setAttribute('data-rt-callout', type); }
        else if (bq.hasAttribute('data-rt-callout')) bq.removeAttribute('data-rt-callout');
        // Hide the "[!type] " marker without touching the text (it stays in the Markdown): the first line is shifted
        // left by the marker's measured width and the overhang is clipped (see reader.css).
        let w = 0;
        const p = type && bq.firstElementChild, tn = p && p.tagName === 'P' && p.firstChild;
        const mm = tn && tn.nodeType === 3 ? /^\s*\[!\w+\][ \t]*/.exec(tn.data) : null;
        if (mm) { const rg = document.createRange(); rg.setStart(tn, 0); rg.setEnd(tn, mm[0].length); w = rg.getBoundingClientRect().width || 0; }
        const cur = parseFloat(bq.style.getPropertyValue('--rt-mw')) || 0;
        if (Math.abs(cur - w) > 0.5) { if (w) bq.style.setProperty('--rt-mw', w.toFixed(1) + 'px'); else bq.style.removeProperty('--rt-mw'); }
      }
      citeMarks();
    }
    // ---- page citations in Claude's comments: a "(p. 4)" that is plain text (an answer from before they were
    // written as page links) is marked without touching the note's content - the CSS Custom Highlight API paints
    // the ranges - and a click on one shows that page.
    const CITE_SKIP = 'code, a, .katex, .language-math, .vditor-ir__marker, .vditor-ir__preview, .vditor-wysiwyg__preview, [data-type="math-inline"], [data-type="math-block"]';
    function citeMarks() {
      if (!window.Highlight || !window.CSS || !CSS.highlights) return;
      const ranges = [];
      for (const bq of $$('blockquote[data-rt-callout="ai"]', contentEl())) {
        if (!/[（(][^()（）]*\d/.test(bq.textContent)) continue;
        const tw = document.createTreeWalker(bq, NodeFilter.SHOW_TEXT);
        for (let n; (n = tw.nextNode());) {
          const found = RT.cite.find(n.data);
          if (!found.length || !n.parentElement || n.parentElement.closest(CITE_SKIP)) continue;
          for (const c of found) { const r = document.createRange(); r.setStart(n, c.at); r.setEnd(n, c.at + c.len); ranges.push(r); }
        }
      }
      if (ranges.length) CSS.highlights.set('rt-pcite', new Highlight(...ranges)); else CSS.highlights.delete('rt-pcite');
    }
    main.addEventListener('click', (e) => {
      const bq = e.target.closest && e.target.closest('blockquote[data-rt-callout="ai"]');
      if (!bq || !opts.page || !window.getSelection().isCollapsed || e.target.closest(CITE_SKIP)) return;
      let node = null, off = 0;
      if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (p) { node = p.offsetNode; off = p.offset; } }
      else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(e.clientX, e.clientY); if (r) { node = r.startContainer; off = r.startOffset; } }
      if (!node || node.nodeType !== 3 || !bq.contains(node)) return;
      const hit = RT.cite.find(node.data).find((c) => off >= c.at && off <= c.at + c.len);
      if (hit) opts.page(hit.page, '');
    });
    let decoRaf = 0;
    const decorateSoon = () => { if (!decoRaf) decoRaf = requestAnimationFrame(() => { decoRaf = 0; decorate(); }); };
    const mo = new MutationObserver(decorateSoon);
    const citePreview = () => { for (const bq of $$('blockquote', preview)) if (/^\s*\[!ai\]/i.test(bq.textContent || '') || bq.closest('[data-subtype="ai"]')) RT.cite.dom(bq); }; // plain "(p. 4)" of a Claude comment -> a page chip
    const moPreview = new MutationObserver(() => scrub(preview)); // diagrams (mermaid ...) render after the preview's `after`

    function renderPreview() {
      if (destroyed || !split) return;
      const top = preview.scrollTop;
      try { Vditor.preview(preview, api_.value(), { ...previewOptions(), after() { preview.scrollTop = top; scrub(preview); citePreview(); } }); } catch (e) { console.error(e); }
    }
    const renderPreviewSoon = debounce(renderPreview, 350);
    const onSel = () => {
      if (destroyed || !vd) return;
      const sel = window.getSelection();
      if (sel.rangeCount && inEditor(sel.getRangeAt(0).startContainer)) lastRange = sel.getRangeAt(0).cloneRange();
    };

    const block = (md) => () => api_.insertBlock(md);
    // the custom buttons draw an icon of the app's set (RT.icon); what each one inserts is unchanged
    const TI = (name, cls = '') => IC(RT.icon(name), cls);
    const calloutBtn = (type) => ({
      name: 'rt-' + type, tipPosition: 'n', tip: CALLOUTS[type].tip,
      icon: TI('callout', 'co co-' + type),
      click: block(`> [!${type}] ${CALLOUTS[type].icon}\n> ${CALLOUTS[type].label}…`),
    });
    // Speech (speech.js), for the reading note only: dictate into the note at the caret (it is saved when the
    // dictation ends) and read the selection or the whole note aloud. Only what this browser can do is shown.
    const S = opts.speech && RT.speech ? RT.speech : null;
    const dictEl = $('.rd-dictate', host);
    const showDict = (interim = '') => { dictEl.hidden = false; $('.rd-dictate-t', dictEl).textContent = interim.length > 70 ? '…' + interim.slice(-70) : interim; };
    async function toggleDictate(e) {
      if (S.listening()) return S.stopListening();
      const noteLang = opts.speech.lang ? opts.speech.lang() : 'en';
      if (e && e.shiftKey) { // the language that is dictated, kept for this browser
        const next = S.dictationLang(noteLang) === 'zh-CN' ? 'en-US' : 'zh-CN';
        S.setDictationLang(next);
        return toast(next === 'zh-CN' ? 'Dictation language: 中文' : 'Dictation language: English', 'ok');
      }
      const lang = S.dictationLang(noteLang);
      let got = false;
      const ok = await S.listen({
        lang,
        onText: (t) => { if (destroyed) return; got = true; api_.type(S.escapeMd(t) + (lang === 'zh-CN' ? '' : ' ')); },
        onInterim: (t) => { if (!destroyed) showDict(t); },
        onEnd: () => { dictEl.hidden = true; if (!destroyed && got && opts.speech.done) opts.speech.done(); },
      });
      if (destroyed) { if (ok) S.stopListening(); return; } // the note was closed while the browser was asked
      if (ok && S.listening()) showDict('');
    }
    function toggleRead() {
      if (S.speaking() === 'note') return S.stop('note');
      const sel = window.getSelection();
      const picked = sel.rangeCount && !sel.isCollapsed && inEditor(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString().trim() : '';
      S.speak(S.plain(picked || vd.getValue()), { key: 'note' });
    }
    const speechBtns = !S ? [] : [
      ...(S.supported.stt ? [{ name: 'rt-dictate', tipPosition: 'n', tip: 'Dictate: speak, and your words go into the note at the cursor. Saved when you stop. Shift-click changes the language', icon: TI('mic'), click: (e) => { toggleDictate(e).catch(fail); } }] : []),
      ...(S.supported.tts ? [{ name: 'rt-read', tipPosition: 'n', tip: 'Read aloud: the selected text, or the whole note. Click again to stop', icon: TI('speaker'), click: () => toggleRead() }] : [])];
    if (S) dictEl.addEventListener('click', (e) => { if (e.target.closest('button')) S.stopListening(); });
    const markBtn = (name, on) => {
      const el = vd && vd.vditor.toolbar.elements[name]; if (!el) return;
      el.classList.toggle('rt-speech-on', !!on);
      const b = el.querySelector('button, [aria-label]'); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    const offSpeech = S ? S.onState((s) => { markBtn('rt-dictate', s.listening); markBtn('rt-read', s.speaking === 'note'); if (!s.listening) dictEl.hidden = true; }) : null;
    // groups (Vditor's '|'): text · lists · code and links · callouts · highlights · math and tables · media and history · view
    // (the rarely used ones sit in Vditor's own "more" menu, so the bar keeps to one row on a wide pane)
    const toolbar = ['headings', 'bold', 'italic', '|', 'quote', 'list', 'ordered-list', 'check', '|', 'link', 'inline-code', 'code', '|',
      calloutBtn('abstract'), calloutBtn('key'), calloutBtn('concept'), calloutBtn('background'), '|',
      { name: 'rt-hl-yellow', tipPosition: 'n', tip: 'Yellow highlight (==key conclusion==)', icon: TI('highlight', 'hl hl-y'), click: () => api_.wrap('==', '==', '重点') },
      { name: 'rt-hl-purple', tipPosition: 'n', tip: 'Purple highlight (concept sentence)', icon: TI('highlight', 'hl hl-p'), click: () => api_.wrap(`<mark style="background-color:${PURPLE}">`, '</mark>', '概念') },
      '|',
      { name: 'rt-formula', tipPosition: 'n', tip: 'Display formula ($$ … $$)', icon: TI('formula'), click: block('$$\na = b\n$$') },
      'table',
      { name: 'rt-qty', tipPosition: 'n', tip: 'Physical-quantity table', icon: TI('table', 'qty'), click: block('| **物理量** | **物理含义** |\n| :---: | --- |\n| $x$ | • 含义 |\n| $y$ | • 含义 |') },
      ...(speechBtns.length ? ['|', ...speechBtns] : []),
      '|', ...(opts.upload ? ['upload'] : []), 'undo', 'redo', '|', 'edit-mode',
      { name: 'rt-split', tipPosition: 'nw', tip: 'Split view: editor + rendered preview', icon: TI('split-view'), click: () => api_.toggleSplit() },
      { name: 'more', tipPosition: 'nw', toolbar: ['strike', 'outline', 'fullscreen', 'export'] }];

    await new Promise((resolve, reject) => {
      try {
        vd = new Vditor(main, {
          cdn: RT.vendor.VDITOR_CDN, lang: uiLang(), mode: 'ir', value: '', cache: { enable: false },
          height: '100%', theme: isDark() ? 'dark' : 'classic', placeholder: opts.placeholder || '',
          toolbar, toolbarConfig: { pin: true }, outline: { enable: false, position: 'right' }, counter: { enable: false },
          preview: { ...previewOptions(), delay: 300, actions: [] },
          // el: the <a> (WYSIWYG, preview) or the address part of a link in the instant-rendering view
          link: { isOpen: true, click: (el) => { if (!el) return; const a = el.closest('a, [data-type="a"]') || el; followLink(a, el.tagName === 'A' ? el.getAttribute('href') : el.textContent); } },
          upload: opts.upload ? {
            accept: 'image/*,video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov', multiple: true,
            // paste, toolbar button: store each picture or video as a note asset and insert it (returning null = handled)
            async handler(files) {
              for (const f of files) {
                const big = f.size > 8 * 1024 * 1024;
                if (big) toast(`Adding “${f.name}” (${Math.round(f.size / 1048576)} MB) to the note…`);
                try {
                  const url = await opts.upload(f), md = mediaMd(f.name, url);
                  if (!destroyed) { api_.insertBlock(md); if (big) toast('Added to the note', 'ok'); }
                  else { // the paper was closed while the file was on its way: it goes to the end of its note
                    const ok = opts.patchLater ? await opts.patchLater((c) => String(c || '').replace(/\s*$/, '') + '\n\n' + md + '\n').catch(() => false) : false;
                    toast(ok ? `“${f.name}” was added to the end of its note` : `“${f.name}” was uploaded but could not be put into the note`, ok ? 'ok' : 'bad');
                  }
                }
                catch (e) { return e.message || String(e); }
              }
              return null;
            },
          } : {},
          input: () => changed(),
          after: resolve,
        });
      } catch (e) { reject(e); }
    });
    api_.vd = vd;
    // The team's callouts are plain blockquotes in the Markdown source; Lute's own callout syntax would rewrite
    // "> [!abstract] 🏕️" (adds a title line), so it is switched off for the editing views.
    try { vd.vditor.lute.SetCallout(false); } catch { /* older lute */ }
    sizeRules(opts.value);
    vd.setValue(dropStaleAsks(opts.value), true);
    for (const m of ['ir', 'wysiwyg', 'sv']) if (vd.vditor[m]) mo.observe(vd.vditor[m].element, { childList: true, subtree: true, characterData: true });
    moPreview.observe(preview, { childList: true, subtree: true });
    // Vditor's "copy code" button works through an inline onclick, which the page's CSP blocks (and scrub() removes)
    host.addEventListener('click', (e) => {
      const c = e.target.closest && e.target.closest('.vditor-copy'); if (!c) return;
      const ta = c.querySelector('textarea'), code = ta ? ta.value : ((c.parentElement && c.parentElement.querySelector('code')) || {}).textContent || '';
      navigator.clipboard.writeText(code).then(() => toast('Copied', 'ok'), fail);
    });
    document.addEventListener('selectionchange', onSel);
    // Vditor calls its `input` callback up to 0.8 s after a keystroke: tell the owner at once that there is unsaved text
    for (const m of ['ir', 'wysiwyg', 'sv']) {
      if (!vd.vditor[m]) continue;
      for (const type of ['input', 'compositionend']) vd.vditor[m].element.addEventListener(type, () => { if (!destroyed && opts.onInput) opts.onInput(); });
    }
    host.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); if (opts.onSave) opts.onSave(); }
      // Vditor's own split view (sv) drops <br> inside table cells, so it is not offered; this module's split
      // view (editor + live preview) replaces it
      if (mod && e.altKey && e.code === 'Digit9') { e.preventDefault(); e.stopPropagation(); api_.toggleSplit(); }
    }, true);
    decorate();
    if (opts.split ?? ls.get('rt.reader.split') === '1') api_.toggleSplit(true);
    return api_;
  }

  // ====================================================================== PDF viewer
  // hooks: quote(text, page), keypoint(text, page), snapshot(blob, page) -> {asset} | null, moved() - the place in the
  // PDF changed, ask(payload, signal) -> Promise<text> ("Ask Claude" about a selection or a snapshot), language() ->
  // 'zh' | 'en' (the language of the answers), note(markdown) -> true when it was put into the note.
  // start: {page, frac, zoom} where to open the PDF (zoom null = fit width), or null for the first page.
  function createPdfView(host, item, hooks, start = null) {
    const id = item.id;
    host.innerHTML = `
      <div class="rd-pdfbar">
        <div class="tgroup" role="group" aria-label="Page">
          <button id="rd-pdf-prev" class="ib" title="Previous page" aria-label="Previous page">${RT.icon('chevron-left')}</button>
          <input type="text" id="rd-pdf-page" inputmode="numeric" title="Page: type a number and press Enter" aria-label="Page" value="1"><span id="rd-pdf-total" class="muted">/ –</span>
          <button id="rd-pdf-next" class="ib" title="Next page" aria-label="Next page">${RT.icon('chevron-right')}</button>
        </div>
        <div class="tgroup" role="group" aria-label="Zoom">
          <button id="rd-pdf-zoom-out" class="ib" title="Zoom out" aria-label="Zoom out">${RT.icon('zoom-out')}</button>
          <button id="pdf-fit" class="on ib" title="Fit width" aria-label="Fit width">${RT.icon('fit-width')}</button>
          <button id="rd-pdf-zoom-in" class="ib" title="Zoom in" aria-label="Zoom in">${RT.icon('zoom-in')}</button>
        </div>
        <div class="tgroup rd-find" role="group" aria-label="Find">${RT.pdfnav.controls.find('pdf')}</div>
        <span class="spacer"></span>
        <div class="tgroup rd-ovf rd-ovf-2" role="group" aria-label="Annotate">
          ${RT.highlights.control('pdf')}
          <button id="pdf-snap" class="ib" title="Snapshot: drag a rectangle on a page to insert that region into the note as an image" aria-label="Snapshot">${RT.icon('figure')}</button>
          ${RT.speech && RT.speech.supported.tts ? `<button id="pdf-read" class="ib" title="Read aloud: the selected text, or the paper from this page on. Click again to stop" aria-label="Read aloud" aria-pressed="false">${RT.icon('speaker')}</button>` : ''}
        </div>
        <div class="tgroup rd-ovf rd-ovf-1" role="group" aria-label="Navigate">${RT.pdfnav.controls.nav('pdf')}</div>
        <div class="tgroup rd-ovf rd-ovf-1" role="group" aria-label="Window">
          <a id="pdf-open" class="ib" href="/api/items/${esc(id)}/pdf" target="_blank" rel="noopener" title="Open the PDF in a new tab" aria-label="Open the PDF in a new tab">${RT.icon('external-link')}</a>
          <button id="rd-max-pdf" class="ib" title="Maximise / restore the PDF pane" aria-label="Maximise or restore the PDF pane">${RT.icon('maximize')}</button>
        </div>
        <button id="rd-pdf-more" class="ib rd-pdf-more" title="More PDF tools" aria-label="More PDF tools" aria-haspopup="menu" aria-expanded="false">${RT.icon('more')}</button>
      </div>
      <div class="rd-pdfscroll" tabindex="0"><div class="rd-pages"><div class="empty">Loading PDF…</div></div></div>
      <div class="rd-selpop" hidden>
        ${RT.highlights.dots()}
        <span class="rd-sep"></span>
        <button data-act="quote" class="ib" title="Quote in notes: insert the selection as a quote with its page number at the cursor of the note, and highlight it on the page" aria-label="Quote in notes">${RT.icon('quote')}</button>
        <button data-act="kp" class="ib" title="Add as key point, and highlight it on the page" aria-label="Add as key point">${RT.icon('star')}</button>
        <button data-act="copy" class="ib" title="Copy the selection" aria-label="Copy">${RT.icon('copy')}</button>
        ${RT.speech && RT.speech.supported.tts ? `<button data-act="read" class="ib" title="Read the selection aloud" aria-label="Read the selection aloud">${RT.icon('speaker')}</button>` : ''}
        <span class="rd-sep"></span>
        <button data-act="ai" class="ib" title="Ask Claude: explain or translate the selection, right here over the PDF" aria-label="Ask Claude about the selection" aria-haspopup="menu">${RT.icon('sparkle')}</button>
      </div>
      <div class="rd-selpop rd-snappop" hidden>
        <button data-snap-ai class="ib" title="Ask Claude about the region you just captured (it is in the note now)" aria-label="Ask Claude about the captured region" aria-haspopup="menu">${RT.icon('sparkle')}</button>
      </div>
      <div class="popover menu rd-aimenu" role="menu" hidden></div>
      <div class="rd-aipop" role="dialog" aria-label="Claude's answer" hidden></div>`;
    const scroller = $('.rd-pdfscroll', host), pagesEl = $('.rd-pages', host), pop = $('.rd-selpop', host);
    let pdf = null, slots = [], scale = 1, fit = true, base = { w: 612, h: 792 }, destroyed = false, snap = false;
    let hl = null; // the colour highlights of this paper (highlights.js), created below
    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    const task = pdfjsLib.getDocument({ url: `/api/items/${id}/pdf`, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' });
    task.promise.then(async (doc) => {
      if (destroyed) return doc.destroy();
      pdf = doc;
      const first = await pdf.getPage(1);
      if (destroyed) return;
      const vp = first.getViewport({ scale: 1 });
      base = { w: vp.width, h: vp.height };
      pagesEl.innerHTML = '';
      for (let n = 1; n <= pdf.numPages; n++) {
        const el = document.createElement('div');
        el.className = 'rd-page'; el.dataset.page = n;
        pagesEl.append(el);
        slots.push({ n, el, w: base.w, h: base.h, rendered: false, job: null, renderTask: null });
      }
      $('#rd-pdf-total', host).textContent = '/ ' + pdf.numPages;
      layout(); restore(); renderVisible();
      nav.changed(); // a search typed while the PDF was still loading runs now
    }).catch((e) => { if (!destroyed) pagesEl.innerHTML = `<div class="empty">Could not open the PDF: ${esc(e.message || e)}</div>`; });

    const fitScale = () => Math.max(0.2, (scroller.clientWidth - 28) / base.w);
    function layout() {
      if (fit) scale = fitScale();
      for (const s of slots) { s.el.style.width = Math.floor(s.w * scale) + 'px'; s.el.style.height = Math.floor(s.h * scale) + 'px'; }
      $('#pdf-fit', host).classList.toggle('on', fit);
      $('#pdf-fit', host).title = `Fit width (now ${Math.round(scale * 100)}%)`;
    }
    // Put the PDF where it was left. It waits until the pane has a size (the Library tab may be hidden at start);
    // until then nothing is reported as "the place moved", so the stored place is never overwritten by page 1.
    function restore() {
      if (!start || !slots.length || !scroller.clientWidth || !scroller.clientHeight) return;
      const st = start; start = null;
      if (st.zoom) { fit = false; scale = Math.min(6, Math.max(0.2, st.zoom)); }
      layout();
      const s = slots[Math.min(Math.max(1, st.page), slots.length) - 1];
      scroller.scrollTop = Math.max(0, s.el.offsetTop + (st.frac || 0) * s.el.offsetHeight);
    }
    // where the PDF is now: the page the page box shows, how far the pane is scrolled past its top (as a part of its
    // height; negative while that top is still below the top of the pane), and the zoom (null while "fit width" is
    // on). null while that cannot be told (loading, pane hidden).
    function position() {
      if (start || destroyed || !slots.length || !scroller.clientHeight) return null;
      const s = slots[currentPage() - 1];
      return { page: s.n, frac: Math.round(1000 * (scroller.scrollTop - s.el.offsetTop) / Math.max(1, s.el.offsetHeight)) / 1000, zoom: fit ? null : Math.round(scale * 1000) / 1000 };
    }
    const moved = debounce(() => { if (!destroyed && !start && hooks.moved) hooks.moved(); }, 600);
    function clearSlot(s) {
      if (s.renderTask) { try { s.renderTask.cancel(); } catch { /* done */ } }
      s.renderTask = null; s.job = null; s.rendered = false; s.el.replaceChildren();
    }
    function rescale(next, keepFit) {
      if (!slots.length || !scroller.clientWidth) return; // a hidden pane has no width to fit and no place to keep
      const page = currentPage(), s = slots[page - 1];
      const frac = s ? (scroller.scrollTop - s.el.offsetTop) / Math.max(1, s.el.offsetHeight) : 0;
      fit = !!keepFit; if (!fit) scale = Math.min(6, Math.max(0.2, next));
      slots.forEach(clearSlot); layout();
      if (s) scroller.scrollTop = s.el.offsetTop + frac * s.el.offsetHeight;
      renderVisible(); moved();
    }

    function renderPage(s) {
      if (s.job) return s.job;
      const at = scale;
      s.job = (async () => {
        const page = await pdf.getPage(s.n);
        if (destroyed || at !== scale) return;
        const vp1 = page.getViewport({ scale: 1 });
        if (Math.abs(vp1.width - s.w) > 0.5 || Math.abs(vp1.height - s.h) > 0.5) { s.w = vp1.width; s.h = vp1.height; s.el.style.width = Math.floor(s.w * scale) + 'px'; s.el.style.height = Math.floor(s.h * scale) + 'px'; }
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas'), r = dpr();
        canvas.width = Math.floor(vp.width * r); canvas.height = Math.floor(vp.height * r);
        const layer = document.createElement('div'); layer.className = 'textLayer';
        layer.style.setProperty('--scale-factor', scale);
        s.el.replaceChildren(canvas, layer);
        s.renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: r !== 1 ? [r, 0, 0, r, 0, 0] : null });
        await s.renderTask.promise;
        if (destroyed || at !== scale) return;
        const tc = await page.getTextContent();
        if (destroyed || at !== scale) return;
        await pdfjsLib.renderTextLayer({ textContentSource: tc, container: layer, viewport: vp }).promise;
        // as in pdf.js' own viewer: a catch-all element that keeps a drag selection from jumping to distant
        // text runs while the pointer is between two lines
        const eoc = document.createElement('div'); eoc.className = 'endOfContent'; layer.append(eoc);
        layer.addEventListener('mousedown', () => eoc.classList.add('active'));
        s.rendered = true;
        if (hl) hl.draw(s.n);
        nav.decorate(s.n, page).catch(() => {});
      })().catch((e) => { if (e && e.name !== 'RenderingCancelledException') console.error('PDF page', s.n, e); s.job = null; });
      return s.job;
    }
    function renderVisible() {
      if (destroyed || !pdf) return;
      const top = scroller.scrollTop, bottom = top + scroller.clientHeight;
      for (const s of slots) {
        const a = s.el.offsetTop, b = a + s.el.offsetHeight;
        if (b > top - 900 && a < bottom + 900) renderPage(s);
        else if ((b < top - 5000 || a > bottom + 5000) && (s.job || s.rendered)) clearSlot(s); // free far-away pages
      }
      const p = currentPage(), inp = $('#rd-pdf-page', host);
      if (document.activeElement !== inp) inp.value = p;
    }
    function currentPage() {
      const y = scroller.scrollTop + scroller.clientHeight * 0.35;
      for (const s of slots) if (s.el.offsetTop + s.el.offsetHeight > y) return s.n;
      return slots.length || 1;
    }
    // the page at the top of the pane (where goPage puts a page): Previous / Next step from it
    function topPage() {
      const y = scroller.scrollTop + 8;
      for (const s of slots) if (s.el.offsetTop + s.el.offsetHeight > y) return s.n;
      return slots.length || 1;
    }
    function goPage(n) {
      n = Math.min(Math.max(1, Math.round(Number(n)) || 1), slots.length || 1);
      const s = slots[n - 1]; if (!s) return;
      scroller.scrollTop = s.el.offsetTop - 6; renderVisible();
    }
    let raf = 0;
    scroller.addEventListener('scroll', () => { hidePop(); moved(); if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderVisible(); }); });
    const ro = new ResizeObserver(debounce(() => { if (destroyed || !slots.length || !scroller.clientWidth) return; placeAi(); closeAiMenu(); hideSnapPop(); if (start) { restore(); renderVisible(); return; } if (fit && Math.abs(fitScale() - scale) > 0.01) rescale(0, true); else renderVisible(); }, 120));
    ro.observe(scroller);

    // ---- search, links, table of contents and Back: the part shared with the Write preview (pdfnav.js)
    const nav = RT.pdfnav.create({
      prefix: 'pdf', pane: host, scroller,
      doc: () => pdf, pages: () => slots.length, pageEl: (n) => (slots[n - 1] ? slots[n - 1].el : null),
      top: (n) => slots[n - 1].el.offsetTop, scale: () => scale,
      ready: async (n) => { const s = slots[n - 1]; for (let k = 0; s && k < 3 && !s.rendered && !destroyed; k++) await renderPage(s); },
      active: () => RT.state.view === 'library',
    });

    // ---- light a passage up (a quote of the note, a key point): go to its page and mark the text for a moment.
    // Letters and digits only are compared, so line breaks, hyphenation and Markdown escapes do not matter. The
    // marks are drawn over the page; the text layer (and the marks of a search) is not touched.
    const ALNUM = /[\p{L}\p{N}]/u;
    const low = (c) => { const l = c.toLowerCase(); return l.length === 1 ? l : c; };
    const lettersOf = (t) => { let o = ''; for (const c of String(t || '')) if (c.length === 1 && ALNUM.test(c)) o += low(c); return o; };
    // the letters of a drawn page with their places in its text layer, and the Range of a passage among them
    function pageLetters(layer) {
      let hay = ''; const at = []; // at[i] = [text node, offset] of the i-th letter of the page
      const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node; (node = tw.nextNode());) { const d = node.data; for (let i = 0; i < d.length; i++) if (ALNUM.test(d[i])) { hay += low(d[i]); at.push([node, i]); } }
      return { hay, at };
    }
    function passageRange({ hay, at }, text) {
      const want = lettersOf(text);
      if (want.length < 8) return null;
      // the whole passage, else its end or its beginning (text around a quote in the note may have been edited)
      let a = hay.indexOf(want), len = want.length;
      if (a < 0 && want.length > 60) { len = 60; a = hay.indexOf(want.slice(-60)); if (a < 0) a = hay.indexOf(want.slice(0, 60)); }
      if (a < 0) return null;
      const range = document.createRange();
      range.setStart(at[a][0], at[a][1]); range.setEnd(at[a + len - 1][0], at[a + len - 1][1] + 1);
      return range;
    }
    // for a page that is drawn: a Range (or null) for each of `texts` (the key points underlined by highlights.js)
    function passages(n, texts) {
      const s = slots[n - 1], layer = s && s.rendered ? $('.textLayer', s.el) : null;
      if (!layer) return texts.map(() => null);
      const letters = pageLetters(layer);
      return texts.map((t) => passageRange(letters, t));
    }
    async function flash(n, text) {
      const s = slots[Math.min(Math.max(1, Math.round(Number(n)) || 1), slots.length || 1) - 1];
      if (!s || lettersOf(text).length < 8) return false;
      for (let k = 0; k < 3 && !s.rendered && !destroyed; k++) await renderPage(s);
      const layer = $('.textLayer', s.el);
      if (destroyed || !s.rendered || !layer) return false;
      const range = passageRange(pageLetters(layer), text);
      if (!range) return false;
      let rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).slice(0, 600);
      if (!rects.length) return false;
      scroller.scrollTop += rects[0].top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
      rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).slice(0, 600);
      const pr = s.el.getBoundingClientRect();
      $$('.rd-flash', pagesEl).forEach((x) => x.remove());
      const box = document.createElement('div'); box.className = 'rd-flash';
      for (const r of rects) { const m = document.createElement('i'); Object.assign(m.style, { left: (r.left - pr.left) + 'px', top: (r.top - pr.top) + 'px', width: r.width + 'px', height: r.height + 'px' }); box.append(m); }
      s.el.append(box);
      setTimeout(() => box.remove(), 2600);
      renderVisible();
      return true;
    }

    // ---- selection popover
    let selText = '', selPage = null;
    // the last passage selected on a page stays "the selection" for the Claude panel after the click into its box
    // took the browser's selection away; a plain click on a page (nothing selected) gives it up
    let kept = null;
    const keep = (k) => { if ((kept && kept.text) === (k && k.text) && (kept && kept.page) === (k && k.page)) return; kept = k; RT.claudeContext.refresh(); };
    function hidePop() { pop.hidden = true; }
    function showPop() {
      if (snap) return hidePop();
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return hidePop();
      const range = sel.getRangeAt(0);
      const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const pageEl = startEl && startEl.closest('.rd-page');
      if (!pageEl || !pagesEl.contains(pageEl)) return hidePop();
      const text = sel.toString().replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
      if (!text) return hidePop();
      selText = text; selPage = Number(pageEl.dataset.page);
      keep({ text, page: selPage });
      const rects = range.getClientRects(), r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      pop.hidden = false;
      const hr = host.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(r.right - hr.left - 40, hr.width - pop.offsetWidth - 6)) + 'px';
      pop.style.top = Math.min(r.bottom - hr.top + 6, hr.height - pop.offsetHeight - 6) + 'px';
    }
    pagesEl.addEventListener('mouseup', () => { $$('.endOfContent.active', pagesEl).forEach((x) => x.classList.remove('active')); setTimeout(() => { showPop(); const sel = window.getSelection(); if (!sel.rangeCount || sel.isCollapsed) keep(null); }, 0); });
    scroller.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') showPop(); });
    pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    pop.addEventListener('click', async (e) => {
      const b = e.target.closest('button'), act = b && b.dataset.act; if (!act) return;
      if (act === 'ai') { // the choices open where the popover was; the selection's place is kept for "Add to note"
        const sel = window.getSelection(), hr = host.getBoundingClientRect(), sr = sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).getBoundingClientRect() : pop.getBoundingClientRect();
        const at = { left: pop.offsetLeft, top: pop.offsetTop, selTop: sr.top - hr.top, selBottom: sr.bottom - hr.top };
        hidePop();
        return openAiMenu({ kind: 'pdf', text: selText, page: selPage, rects: hl.selection(), quote: short(selText, 60) }, at);
      }
      hidePop();
      try {
        if (act === 'copy') { await navigator.clipboard.writeText(selText); toast('Copied', 'ok'); return; }
        if (act === 'read') { RT.speech.speak(selText, { key: 'pdf' }); return; }
        // a highlight keeps the passage marked on the page; a quote and a key point leave one too, linked to them.
        // The place of the selection is read first: inserting into the note takes the selection away.
        const text = selText, rects = hl.selection();
        if (act === 'hl') {
          ls.set('rt.hl.color', b.dataset.color);
          if (await hl.add({ text, rects, color: b.dataset.color })) window.getSelection().removeAllRanges();
        } else if (act === 'quote') {
          if (hooks.quote(text, selPage) && rects && await hl.add({ text, rects, kind: 'quote', quiet: true })) window.getSelection().removeAllRanges();
        } else if (act === 'kp') {
          const kp = hooks.keypoint(text, selPage);
          if (kp && rects && await hl.add({ text, rects, kind: 'kp', kp, quiet: true })) window.getSelection().removeAllRanges();
        }
      } catch (err) { fail(err); }
    });
    hl = RT.highlights.create({
      id, pane: host, scroller, pagesEl, pageEl: (n) => (slots[n - 1] ? slots[n - 1].el : null), passages,
      ready: async (n) => { const s = slots[n - 1]; for (let k = 0; s && k < 3 && !s.rendered && !destroyed; k++) await renderPage(s); },
      remember: () => nav.remember(),
      keypoints: () => (hooks.keypoints ? hooks.keypoints() : []),
      openKeypoint: (kid) => { if (hooks.openKeypoint) hooks.openKeypoint(kid); },
      quote: (text, page) => hooks.quote(text, page),
    });
    const onDocDown = (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !pagesEl.contains(e.target)) hidePop();
      if (!aiMenu.hidden && !aiMenu.contains(e.target)) closeAiMenu();
      if (!snapPop.hidden && !snapPop.contains(e.target)) hideSnapPop();
    };
    document.addEventListener('mousedown', onDocDown);

    // ---- "Ask Claude" about a selection (the sparkle of the selection popover) or about a region that was just
    // captured: explain it or translate it. The answer is shown in a card over the PDF, so reading goes on without
    // touching the note; "Add to note" puts the passage (as a quote with its page) and the answer (a Claude
    // comment) into the note.
    const aiMenu = $('.rd-aimenu', host), aiPop = $('.rd-aipop', host), snapPop = $('.rd-snappop', host);
    const AI_ASKS = [['explain', 'Explain this'], ['foundations', 'Explain the foundations'], ['meaning', 'What does it mean here?'], ['example', 'Give an example']];
    const AI_LABEL = { explain: 'Explain', foundations: 'Foundations', meaning: 'Meaning', example: 'Example', ask: 'Question', translate: 'Translation' };
    const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const LANG_NAME = { zh: '中文', en: 'English' };
    const langs = () => (hooks.language && hooks.language() === 'en' ? ['en', 'zh'] : ['zh', 'en']); // the language of the note first
    let aiTarget = null, aiAt = null, ai = null, snapTimer = 0, snapAsset = null; // ai: the card {tg, mode, question, text, error, ctrl}
    function closeAiMenu() { aiMenu.hidden = true; }
    function openAiMenu(tg, at) {
      if (!hooks.ask) return;
      aiTarget = tg; aiAt = at;
      aiMenu.innerHTML = `<div class="rd-ask-h muted">Ask Claude about ${tg.kind === 'image' ? esc(tg.quote) : `“${esc(tg.quote)}”`}</div>
        ${AI_ASKS.map(([m, l]) => `<button type="button" role="menuitem" data-ai="${m}">${l}</button>`).join('')}
        ${tg.kind === 'pdf' ? langs().map((l) => `<button type="button" role="menuitem" data-ai="translate" data-lang="${l}" title="A faithful translation of the selection, nothing added">Translate to ${LANG_NAME[l]}</button>`).join('') : ''}
        <hr>
        <form class="rd-ai-q"><input type="text" maxlength="600" placeholder="Ask your own question…" aria-label="Your own question about it"><button class="ib" title="Ask Claude this question" aria-label="Ask">${RT.icon('send')}</button></form>`;
      aiMenu.hidden = false;
      aiMenu.style.left = Math.max(6, Math.min(at.left, host.clientWidth - aiMenu.offsetWidth - 6)) + 'px';
      aiMenu.style.top = Math.max(6, Math.min(at.top, host.clientHeight - aiMenu.offsetHeight - 6)) + 'px';
    }
    aiMenu.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }); // the selection on the page stays
    aiMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-ai]'); if (b && aiTarget) { closeAiMenu(); runAi(aiTarget, b.dataset.ai, '', b.dataset.lang); } });
    aiMenu.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('input', aiMenu).value.replace(/\s+/g, ' ').trim();
      if (!q || !aiTarget) return $('input', aiMenu).focus();
      closeAiMenu(); runAi(aiTarget, 'ask', q);
    });
    function closeAi() { if (ai && ai.ctrl) ai.ctrl.abort(); ai = null; aiPop.hidden = true; aiPop.innerHTML = ''; }
    // the card sits under the passage when there is room below it, else above it
    function placeAi() {
      const at = ai && ai.at; if (!at) return;
      const hw = host.clientWidth, hh = host.clientHeight, bar = scroller.offsetTop || 44, below = hh - at.selBottom, above = at.selTop - bar; // bar: the toolbar above the pages (it wraps in a narrow pane)
      aiPop.style.width = Math.min(440, hw - 12) + 'px';
      aiPop.style.left = Math.max(6, Math.min(at.left, hw - aiPop.offsetWidth - 6)) + 'px';
      const under = below >= 200 || below >= above;
      aiPop.style.top = under ? Math.max(bar, Math.min(at.selBottom + 6, hh - 126)) + 'px' : 'auto';
      aiPop.style.bottom = under ? 'auto' : Math.max(6, Math.min(hh - at.selTop + 6, hh - 170)) + 'px';
      aiPop.style.maxHeight = Math.max(120, Math.min(460, (under ? hh - Math.max(bar, at.selBottom + 6) : above) - 8)) + 'px';
    }
    // **bold** lead-ins become <b> - in the text only, never inside a formula ($a**b$ keeps its stars)
    const aiHtml = (s) => RT.cite((RT.diagram && RT.diagram.rich ? RT.diagram.rich(s) : esc(s).replace(/\n/g, '<br>'))
      .split(/(<span class="dg-math"[^>]*>[^<]*<\/span>)/).map((part, i) => (i % 2 ? part : part.replace(/\*\*([^*<\n]{1,200})\*\*/g, '<b>$1</b>'))).join(''));
    function drawAi() {
      if (!ai) return;
      const { tg, mode } = ai, wait = ai.text == null && !ai.error;
      aiPop.innerHTML = `
        <div class="rd-aipop-h"><span class="badge">Claude · ${AI_LABEL[mode]}${mode === 'translate' && ai.language ? ' · ' + LANG_NAME[ai.language] : ''}</span><span class="rd-aipop-q muted" title="${esc(ai.question || tg.text || tg.quote)}">${esc(ai.question ? short(ai.question, 70) : tg.kind === 'image' ? tg.quote : `“${tg.quote}”`)}${tg.page && (tg.kind !== 'image' || ai.question) ? ` · p. ${tg.page}` : ''}</span>
          <button class="ib ghost" data-ai-close title="Dismiss (Esc)" aria-label="Dismiss">${RT.icon('close')}</button></div>
        <div class="rd-aipop-b" tabindex="0" aria-live="polite">${wait ? `<span class="spin"></span> Claude is ${mode === 'translate' ? 'translating' : 'writing'}…` : ai.error ? `<span class="rd-aipop-err">Claude could not answer: ${esc(ai.error)}</span>` : aiHtml(ai.text)}</div>
        <div class="rd-aipop-f">
          ${wait ? '<span class="spacer"></span><button data-ai-close title="Stop Claude and close this">Cancel</button>'
    : ai.error ? '<span class="spacer"></span><button data-ai-close>Dismiss</button><button class="primary" data-ai-retry>Try again</button>'
    : `<button class="ib" data-ai-copy title="Copy the answer" aria-label="Copy the answer">${RT.icon('copy')}</button><span class="spacer"></span><button data-ai-close>Dismiss</button><button class="primary" data-ai-add title="${tg.kind === 'pdf' ? 'Put the passage (as a quote with its page) and this answer into the note' : 'Put this answer into the note, as a comment'}">Add to note</button>`}
        </div>`;
      aiPop.hidden = false;
      if (!wait && !ai.error && RT.diagram && RT.diagram.renderMath) RT.diagram.renderMath($('.rd-aipop-b', aiPop));
      placeAi();
    }
    async function runAi(tg, mode, question, language) {
      closeAi();
      const ctrl = new AbortController(), mine = ai = { tg, mode, question, language, text: null, error: null, ctrl, at: aiAt };
      drawAi();
      try {
        const res = await hooks.ask({ mode, question, kind: tg.kind, text: tg.text, asset: tg.asset, page: tg.page, ...(language ? { language } : {}) }, ctrl.signal);
        mine.by = (res && typeof res === 'object' && res.provider) || aiName(); // the provider that answered: named when it goes into the note
        mine.text = String((res && typeof res === 'object' ? res.text : res) || '').trim() || null; if (!mine.text) mine.error = 'the answer was empty.';
      }
      catch (err) { if (ctrl.signal.aborted) return; mine.error = err.message || String(err); }
      if (ai === mine && !destroyed) drawAi();
    }
    aiPop.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || !ai) return;
      if (b.dataset.aiClose != null) closeAi();
      else if (b.dataset.aiRetry != null) { aiAt = ai.at; runAi(ai.tg, ai.mode, ai.question, ai.language); }
      else if (b.dataset.aiCopy != null) navigator.clipboard.writeText(ai.text).then(() => toast('Copied', 'ok'), () => toast('Could not copy to the clipboard', 'bad'));
      else if (b.dataset.aiAdd != null && ai.text) {
        const { tg, mode } = ai, clean = (s) => String(s).replace(/[\\`*_$\[\]<>|=~]/g, '').replace(/\s+/g, ' ').trim();
        const head = `> [!ai] 💬 **${ai.by || aiName()} · ${AI_LABEL[mode]}** — “${clean(mode === 'ask' ? short(ai.question, 80) : tg.quote)}”`;
        const body = RT.cite.md(ai.text).split('\n').map((l) => (l.trim() ? '> ' + l.trim() : '>')).join('\n');
        // the passage first, as "Quote in notes" writes it (and marked on the page the same way), then the comment
        if (tg.kind === 'pdf' && !hooks.quote(short(tg.text, 1500), tg.page)) return;
        if (!hooks.note(`${head}\n${body}`)) return;
        const rects = tg.rects, text = tg.text;
        closeAi();
        toast('Added to the note', 'ok');
        if (tg.kind === 'pdf' && rects) { try { await hl.add({ text, rects, kind: 'quote', quiet: true }); } catch (err) { fail(err); } }
      }
    });
    function hideSnapPop() { clearTimeout(snapTimer); snapPop.hidden = true; }
    snapPop.addEventListener('click', (e) => {
      if (!e.target.closest('[data-snap-ai]') || !snapAsset) return;
      const s = snapAsset, at = { left: snapPop.offsetLeft, top: snapPop.offsetTop, selTop: s.top, selBottom: s.bottom };
      hideSnapPop();
      openAiMenu({ kind: 'image', asset: s.asset, page: s.page, text: `Figure (p. ${s.page})`, quote: `the region captured on p. ${s.page}` }, at);
    });

    // ---- snapshot tool: drag a rectangle on a page
    function setSnap(on) {
      snap = on; hidePop(); hl.hidePop(); hideSnapPop(); closeAiMenu();
      pagesEl.classList.toggle('snap', on); $('#pdf-snap', host).classList.toggle('on', on); $('#pdf-snap', host).setAttribute('aria-pressed', String(on));
      if (on) { window.getSelection().removeAllRanges(); toast('Snapshot: drag a rectangle over a figure or table (Esc to cancel)'); }
    }
    let drag = null;
    pagesEl.addEventListener('pointerdown', (e) => {
      if (!snap || e.button !== 0) return;
      const pageEl = e.target.closest('.rd-page'); if (!pageEl) return;
      e.preventDefault();
      const pr = pageEl.getBoundingClientRect();
      const box = document.createElement('div'); box.className = 'rd-snap-rect'; pageEl.append(box);
      drag = { pageEl, x0: e.clientX - pr.left, y0: e.clientY - pr.top, box, x: 0, y: 0, w: 0, h: 0 };
      pagesEl.setPointerCapture(e.pointerId);
    });
    pagesEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pr = drag.pageEl.getBoundingClientRect();
      const x1 = Math.min(Math.max(0, e.clientX - pr.left), pr.width), y1 = Math.min(Math.max(0, e.clientY - pr.top), pr.height);
      drag.x = Math.min(drag.x0, x1); drag.y = Math.min(drag.y0, y1); drag.w = Math.abs(x1 - drag.x0); drag.h = Math.abs(y1 - drag.y0);
      Object.assign(drag.box.style, { left: drag.x + 'px', top: drag.y + 'px', width: drag.w + 'px', height: drag.h + 'px' });
    });
    const endDrag = async (e) => {
      if (!drag) return;
      const g = drag; drag = null;
      try { pagesEl.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      g.box.remove();
      if (e.type === 'pointercancel' || g.w < 8 || g.h < 8) return;
      setSnap(false);
      try {
        toast('Capturing the region…');
        const page = Number(g.pageEl.dataset.page), blob = await capture(page, g);
        const pw = g.pageEl.clientWidth || 1, ph = g.pageEl.clientHeight || 1; // the region as fractions of the page
        const done = await hooks.snapshot(blob, page, { x: g.x / pw, y: g.y / ph, w: g.w / pw, h: g.h / ph });
        // the region is in the note now: for a few seconds a sparkle beside it offers to ask Claude about it
        if (done && done.asset && hooks.ask && seesPictures() && !destroyed && g.pageEl.isConnected) {
          const pr = g.pageEl.getBoundingClientRect(), hr = host.getBoundingClientRect();
          snapAsset = { asset: done.asset, page, top: pr.top - hr.top + g.y, bottom: pr.top - hr.top + g.y + g.h };
          snapPop.hidden = false;
          snapPop.style.left = Math.max(6, Math.min(pr.left - hr.left + g.x + g.w - snapPop.offsetWidth, hr.width - snapPop.offsetWidth - 6)) + 'px';
          snapPop.style.top = Math.max(44, Math.min(snapAsset.bottom + 6, hr.height - snapPop.offsetHeight - 6)) + 'px';
          clearTimeout(snapTimer); snapTimer = setTimeout(hideSnapPop, 12000);
        }
      } catch (err) { fail(err); }
    };
    pagesEl.addEventListener('pointerup', endDrag);
    pagesEl.addEventListener('pointercancel', endDrag);
    // render the page at 2x the on-screen size and cut the rectangle out
    async function capture(n, g) {
      const page = await pdf.getPage(n);
      let k = scale * 2;
      const v1 = page.getViewport({ scale: 1 });
      if (v1.width * k * v1.height * k > 36e6) k = Math.sqrt(36e6 / (v1.width * v1.height)); // stay inside canvas limits
      const vp = page.getViewport({ scale: k });
      const full = document.createElement('canvas');
      full.width = Math.floor(vp.width); full.height = Math.floor(vp.height);
      await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;
      const f = k / scale;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(g.w * f)); out.height = Math.max(1, Math.round(g.h * f));
      out.getContext('2d').drawImage(full, Math.round(g.x * f), Math.round(g.y * f), out.width, out.height, 0, 0, out.width, out.height);
      const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Could not capture that region');
      return blob;
    }

    // ---- toolbar
    // a narrow pane hides the Navigate and Window groups, a very narrow one also Annotate (reader.css): their buttons are in
    // the "more" menu. Highlights stays in the bar at the default layout, so the tour and the ⌘K palette (which list only
    // controls on screen) keep it
    const ICON_OF = { 'pdf-hl': 'highlight', 'pdf-snap': 'figure', 'pdf-read': 'speaker', 'pdf-outline': 'sidebar', 'pdf-back': 'arrow-left', 'pdf-open': 'external-link', 'rd-max-pdf': 'maximize' };
    // Read aloud (speech.js): the selection, else the paper from the page in view on, page after page (the view
    // follows the page that is being read). A page without text (a scan) is passed over.
    let readRun = 0; // each press of the button is a run of its own: a stopped one no longer turns pages
    function readPdf() {
      const S = RT.speech, run = ++readRun;
      if (S.speaking() === 'pdf') return S.stop('pdf');
      const sel = window.getSelection();
      // the selection as it is now (the popover's copy is only as fresh as the last mouse-up on a page)
      const picked = sel.rangeCount && !sel.isCollapsed && pagesEl.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString().replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim() : '';
      if (picked) return S.speak(picked, { key: 'pdf' });
      let n = currentPage() - 1, moved = false;
      const live = () => !destroyed && run === readRun && S.speaking() === 'pdf';
      const more = async () => {
        while (live() && ++n <= pdf.numPages) {
          let text = '';
          try { text = S.pdfText(await (await pdf.getPage(n)).getTextContent()); } catch (e) { console.error(e); }
          if (!live()) return null;
          if (text) { const page = n, turn = moved; moved = true; return { text, onStart: () => { if (turn && live()) goPage(page); } }; }
          moved = true;
        }
        return null;
      };
      return S.speak({ text: '', more }, { key: 'pdf' });
    }
    const offSpeech = RT.speech ? RT.speech.onState((s) => { const b = $('#pdf-read', host); if (b) { b.classList.toggle('on', s.speaking === 'pdf'); b.setAttribute('aria-pressed', s.speaking === 'pdf' ? 'true' : 'false'); } }) : null;
    function moreMenu(btn) {
      const items = [];
      for (const g of $$('.rd-pdfbar .rd-ovf', host)) {
        if (g.offsetParent !== null) continue; // shown in the bar
        items.push({ heading: g.getAttribute('aria-label') });
        for (const b of $$('button, a.ib', g)) {
          items.push({ label: b.getAttribute('aria-label') || b.title, icon: ICON_OF[b.id] || '', disabled: b.disabled, onClick: () => b.click() });
        }
      }
      if (items.length) RT.menu(btn, items, { align: 'end' });
    }
    host.addEventListener('click', (e) => {
      const more = e.target.closest('#rd-pdf-more');
      if (more) return moreMenu(more);
      const t = e.target.closest('button'); if (!t || !pdf) return;
      if (t.id === 'pdf-read') return readPdf();
      if (t.id === 'rd-pdf-prev') { const n = topPage(), s = slots[n - 1]; goPage(s && scroller.scrollTop > s.el.offsetTop + 2 ? n : n - 1); }
      else if (t.id === 'rd-pdf-next') goPage(topPage() + 1);
      else if (t.id === 'rd-pdf-zoom-in') rescale(scale * 1.2);
      else if (t.id === 'rd-pdf-zoom-out') rescale(scale / 1.2);
      else if (t.id === 'pdf-fit') rescale(0, true);
      else if (t.id === 'pdf-snap') setSnap(!snap);
    });
    $('#rd-pdf-page', host).addEventListener('change', (e) => goPage(e.target.value));
    $('#rd-pdf-page', host).addEventListener('keydown', (e) => { if (e.key === 'Enter') { goPage(e.target.value); e.target.blur(); } });
    // Esc closes the menu, then the answer card - but not while a dialog is open or while typing somewhere else
    // (the note, the find box, the Claude panel): an answer that is being written or read is not thrown away by an Esc meant for those
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (snap) setSnap(false);
      hidePop(); hideSnapPop();
      if (!aiMenu.hidden) return closeAiMenu();
      const el = document.activeElement, typing = el && !aiPop.contains(el) && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (ai && !typing && !e.defaultPrevented && !document.querySelector('dialog[open]')) closeAi();
    };
    scroller.addEventListener('scroll', () => { if (!snapPop.hidden) hideSnapPop(); }, { passive: true });
    document.addEventListener('keydown', onKey);

    return {
      // goPage from outside (a page link of the note, a key point) is a jump: Back returns from it
      // (a jump made before the stored reading place was restored replaces it)
      goPage: (n) => { start = null; nav.remember(); goPage(n); }, flash, position, highlights: hl,
      // keyboard (palette.js): a screen down / up, zoom in / out by a step, fit the width; false while the PDF is loading or hidden
      scrollScreen: (dir) => { if (!slots.length || start || !scroller.clientWidth) return false; scroller.scrollBy({ top: dir * Math.max(80, scroller.clientHeight - 48) }); return true; },
      zoom: (dir) => { if (!slots.length || start || !scroller.clientWidth) return false; if (!dir) rescale(0, true); else rescale(dir > 0 ? scale * 1.2 : scale / 1.2); return true; },
      page: () => (slots.length ? currentPage() : null), pages: () => slots.length,
      // scrolled to the very end (a short last page never reaches the line currentPage() goes by)
      atEnd: () => !!slots.length && !start && !!scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4, selection: () => kept, dropSelection: () => keep(null), refit: () => { if (start) { restore(); renderVisible(); } else if (fit) rescale(0, true); else renderVisible(); },
      destroy() {
        destroyed = true; ro.disconnect(); nav.destroy(); hl.destroy(); closeAi(); clearTimeout(snapTimer);
        if (offSpeech) { offSpeech(); RT.speech.stop('pdf'); }
        document.removeEventListener('mousedown', onDocDown); document.removeEventListener('keydown', onKey);
        slots.forEach((s) => { if (s.renderTask) { try { s.renderTask.cancel(); } catch { /* done */ } } });
        task.destroy().catch(() => {});
        host.innerHTML = '';
      },
    };
  }

  // ====================================================================== note state
  // one note is open at a time; `saved` is the canonical text the server has, `hash` its sha1
  const note = { id: null, ed: null, hash: null, saved: '', dirty: false, timer: null, chain: Promise.resolve(), token: 0, conflict: null };
  const drafts = new Map(); // itemId -> {ctrl, status}   draft generations in flight

  // keep: the text names the AI provider that made something (the display layer translates it, never renames that provider)
  const setNoteState = (text, cls = '', keep = false) => { const el = $('#note-state'); if (el) { el.toggleAttribute('data-brand-keep', !!keep); el.textContent = text; el.className = 'saved ' + cls; } };
  // An empty note shows a short invitation above the editor (the editor stays below it, so a click or a key there
  // starts writing); it goes as soon as the note has text or while Claude writes the draft.
  function updateNoteEmpty() {
    const box = $('#note-empty', d); if (!box) return;
    const it = current();
    const show = !!(it && note.ed && note.id === it.id && !drafts.has(it.id) && !note.ed.value().trim());
    if (show && !box.firstChild) {
      box.append(RT.emptyState({
        ill: 'emptyNotes', compact: true, title: 'No note yet', text: 'Write your own, or let Claude draft a first version from the paper.',
        actions: [
          { label: 'Draft with Claude', icon: 'sparkle', primary: true, title: DRAFT_HINT, onClick: () => startDraft() },
          { label: 'Start writing', icon: 'edit', onClick: () => { if (note.ed) note.ed.focus(); } },
        ],
      }));
    }
    if (box.hidden === !show) return;
    box.hidden = !show;
  }
  function noteChanged() {
    if (!note.ed) return;
    if (!$('#note-empty', d)?.hidden) updateNoteEmpty();
    note.dirty = true; setNoteState('Unsaved changes…');
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { saveNote('auto').catch(fail); }, 1500);
  }
  const putNote = (id, body) => api(`/api/items/${id}/note`, { method: 'PUT', json: body });

  // Save the open note. source: 'auto' | 'manual'. Resolves true when the server has the current text.
  function saveNote(source = 'auto', { force = false } = {}) {
    clearTimeout(note.timer);
    const run = async () => {
      if (!note.ed || !note.id) return true;
      const id = note.id, content = note.ed.value();
      if (content === note.saved && source !== 'manual' && !force) { // nothing changed (e.g. an edit was undone)
        note.dirty = false;
        if ($('#note-state') && /^Unsaved/.test($('#note-state').textContent)) setNoteState('');
        return true;
      }
      setNoteState('Saving…');
      try {
        const r = await putNote(id, { content, source, ...(force || !note.hash ? {} : { baseHash: note.hash }) });
        if (note.id !== id) return true;
        note.hash = r.hash; note.saved = content; note.conflict = null;
        if ($('#note-conflict')) $('#note-conflict').hidden = true;
        note.dirty = !!note.ed && note.ed.value() !== content;
        { const at = new Date().toLocaleTimeString(); setNoteState(source === 'manual' ? `Saved ${at}` : `Autosaved ${at}`, 'ok'); }
        if (note.dirty) noteChanged();
        return true;
      } catch (e) {
        if (note.id !== id) return false;
        if (e.status === 409 && e.data && e.data.conflict) { showConflict(e.data); return false; }
        setNoteState('Not saved', 'bad'); toast('Could not save the note: ' + e.message, 'bad');
        return false;
      }
    };
    return (note.chain = note.chain.then(run, run));
  }
  function showConflict(data) {
    note.conflict = data;
    setNoteState('Conflict', 'bad');
    const bar = $('#note-conflict'); if (!bar) return;
    bar.hidden = false;
  }
  // Leaving the note (other item, closing, page unload): send what is unsaved without waiting. The text never gets
  // lost: if the file changed on disk in the meantime, ours is written anyway and the disk version stays in History.
  // Whether there is something to send is decided by comparing the editor text with what the server has - never by
  // note.dirty, which Vditor's delayed input callback sets late. `unloading`: the page is going away, so the request
  // is sent with keepalive when it fits the browser's 64 KiB keepalive budget (measured in bytes, not characters).
  const noteUnsaved = () => !!(note.ed && note.id && note.ed.value() !== note.saved);
  const KEEPALIVE_MAX = 60000;
  const noteBody = (content, forced) => JSON.stringify(forced ? { content, source: 'manual', label: 'Kept while the file changed on disk' }
    : { content, source: 'auto', ...(note.hash ? { baseHash: note.hash } : {}) });
  const fitsKeepalive = (text) => new TextEncoder().encode(text).length < KEEPALIVE_MAX;
  function flushNoteAway(unloading = false) {
    clearTimeout(note.timer);
    if (!note.ed || !note.id) return;
    const id = note.id, content = note.ed.value();
    if (content === note.saved) { note.dirty = false; return; }
    const send = (text) => fetch(`/api/items/${id}/note`, { method: 'PUT', keepalive: unloading && fitsKeepalive(text), headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: text });
    send(noteBody(content, false))
      .then((r) => (r.status === 409 ? send(noteBody(content, true)) : r))
      .then(async (r) => {
        if (!r.ok) { toast('A note could not be saved (' + r.status + ')', 'bad'); return; }
        const j = await r.json().catch(() => null);
        // still the open note (the user stayed on the page): the editor now knows what the server has
        if (j && j.hash && note.id === id && note.ed) { note.hash = j.hash; note.saved = content; note.dirty = note.ed.value() !== content; if (!note.dirty) setNoteState(`Autosaved ${new Date().toLocaleTimeString()}`, 'ok'); }
      })
      .catch((e) => toast('A note could not be saved: ' + e.message, 'bad'));
  }
  function destroyEditor() {
    clearTimeout(note.timer);
    note.token++;
    if (note.ed) { try { note.ed.destroy(); } catch (e) { console.error(e); } }
    Object.assign(note, { id: null, ed: null, hash: null, saved: '', dirty: false, conflict: null });
  }
  async function uploadAsset(id, blob) {
    const r = await api(`/api/items/${id}/note/assets`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
    return r.url;
  }
  // "Ask Claude" about a part of the note or of the PDF -> the answer as text (in the language chosen for the note)
  // the first-draft language of Preferences (settings.json draftLanguage, RT.prefs); the note menu's "Draft language" changes it
  const noteLang = () => (RT.prefs ? RT.prefs.draftLanguage() : ls.get('rt.note.lang', 'zh') === 'en' ? 'en' : 'zh');
  // -> {text, provider}: the answer, and the name of the provider that gave it (what the note's comment names)
  const askClaude = (id, p, signal) => api(`/api/items/${id}/note/ask`, { method: 'POST', json: { language: noteLang(), ...p }, signal }).then((r) => ({ text: r.text, provider: r.provider || null }));
  async function loadNote(it) {
    const token = ++note.token, host = $('#note-editor');
    if (!host) return;
    host.innerHTML = '<div class="rd-skel" role="status" aria-busy="true" aria-label="Loading the note…"><i></i><i></i><i></i></div>';
    updateNoteEmpty();
    try {
      const n = await api(`/api/items/${it.id}/note`);
      delete it.notes; // migrated into notes/<id>.md by the server
      if (token !== note.token) return;
      const ed = await createEditor(host, {
        value: n.content, placeholder: RT.i18n ? RT.i18n.t('Reading note…') : 'Reading note…', // inside .vditor: not seen by i18n.js
        onInput: () => { if (note.token === token) noteChanged(); }, onSave: () => saveAll('manual'), upload: (file) => uploadAsset(it.id, file),
        page: (n, text) => { if (cur === it.id) showPage(n, text); },
        ask: (p) => askClaude(it.id, p),
        // dictation: the language of the note unless another was picked; the note is saved when the dictation ends
        speech: { lang: noteLang, done: () => { if (note.token === token) saveNote('auto').catch(fail); } },
        // an answer that arrives after this editor was closed: into the editor that has the note open now, else into the saved note
        busy: () => drafts.has(it.id),
        patchLater: async (fn) => {
          // the same paper may be on its way back onto the screen: give its editor a moment to load
          for (let k = 0; k < 20 && cur === it.id && !(note.id === it.id && note.ed); k++) await new Promise((r) => setTimeout(r, 250));
          if (note.id === it.id && note.ed && note.ed.patch) return note.ed.patch(fn);
          const r = await api(`/api/items/${it.id}/note`), next = fn(r.content);
          if (next === r.content) return false;
          await api(`/api/items/${it.id}/note`, { method: 'PUT', json: { content: next, baseHash: r.hash, source: 'auto' } });
          return true;
        },
      });
      if (token !== note.token) { ed.destroy(); return; }
      Object.assign(note, { id: it.id, ed, hash: n.hash, saved: ed.value(), dirty: false });
      setNoteState(n.exists ? '' : 'No note yet');
      renderDraftState();
      updateNoteEmpty();
    } catch (e) { if (token === note.token) host.innerHTML = `<div class="empty">Could not load the note: ${esc(e.message)}</div>`; }
  }
  // put text into the open editor as the new saved state (after a draft, restore, import, external change)
  function adoptNote(content, hash) {
    if (!note.ed) return;
    clearTimeout(note.timer);
    note.ed.set(content);
    Object.assign(note, { hash, saved: note.ed.value(), dirty: false, conflict: null });
    if ($('#note-conflict')) $('#note-conflict').hidden = true;
    updateNoteEmpty();
  }
  // the file may have been edited outside the editor (Claude panel, another program): reload when nothing is pending
  async function syncNote() {
    if (!note.ed || !note.id || note.dirty || drafts.has(note.id) || note.conflict || noteUnsaved()) return;
    const id = note.id;
    try {
      const n = await api(`/api/items/${id}/note`);
      if (note.id !== id || note.dirty || n.hash === note.hash || noteUnsaved()) return;
      adoptNote(n.content, n.hash); setNoteState('Reloaded from disk');
    } catch { /* offline: keep what we have */ }
  }

  // ====================================================================== item (metadata / key points) autosave
  let pendingSave = false;
  const saveItem = debounce(async () => {
    const it = current(); if (!it) return;
    pendingSave = false;
    try {
      const r = await api('/api/items/' + it.id, { method: 'PUT', json: { type: it.type, fields: it.fields, keypoints: it.keypoints, citekey: it.citekey } });
      it.citekey = r.item.citekey;
      if ($('#saved')) $('#saved').textContent = `Saved ${new Date().toLocaleTimeString()}`;
      RT.emit('item:updated', { id: it.id }); refreshBib();
    } catch (e) { toast('Could not save: ' + e.message, 'bad'); }
  }, 600);
  const touch = () => { pendingSave = true; if ($('#saved')) $('#saved').textContent = 'Saving…'; saveItem(); };
  async function saveAll(source = 'auto') {
    if (pendingSave) await saveItem.flush();
    return saveNote(source);
  }

  // ====================================================================== reading position
  // Where the PDF of the open paper is: kept with the item (item.reading = {page, frac, zoom}) a moment after it
  // moved and when the paper is left, so the paper opens there again. Losing it is harmless, so errors are silent.
  const samePlace = (a, b) => !!a && !!b && a.page === b.page && Math.abs((a.frac || 0) - (b.frac || 0)) < 0.01 && (a.zoom || null) === (b.zoom || null);
  const touring = () => document.body.classList.contains('touring'); // the tour moves the reader: that is no reading
  function savePosition(unloading = false) {
    const it = current();
    if (!it || !pdfView || touring()) return;
    const pos = pdfView.position();
    if (!pos || samePlace(pos, it.reading) || (!it.reading && pos.page === 1 && pos.frac <= 0.01 && !pos.zoom)) return;
    const pageChanged = !it.reading || it.reading.page !== pos.page;
    it.reading = pos;
    if (!unloading) maybeFinished(it, pos);
    fetch('/api/items/' + it.id, { method: 'PUT', keepalive: unloading, headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ reading: pos }) }).catch(() => {});
    if (pageChanged && !unloading) RT.emit('item:updated', { id: it.id }); // the list shows the page
  }
  const savePositionSoon = debounce(() => savePosition(), 1200);
  // the paper was opened by the user: the server notes the time and turns "to read" into "reading"
  async function markOpened(id) {
    try {
      const r = await api(`/api/items/${id}/opened`, { method: 'POST' });
      const it = items().find((i) => i.id === id); if (!it) return;
      for (const k of ['status', 'lastOpened']) if (k in r.item) it[k] = r.item[k];
      RT.emit('item:updated', { id });
    } catch { /* the list simply keeps the old status */ }
  }
  // Show page n of the PDF (un-maximising the other pane, switching to the PDF on a narrow window) and, with
  // `text`, light that passage up on the page.
  function showPage(n, text) {
    if (!pdfView) return toast('This reference has no PDF attached.', 'bad');
    const body = $('.rd-body', d), pane = $('#rd-pdf', d);
    if (body.dataset.max === 'work') { body.dataset.max = ''; applyLayout(); }
    if (pane && !pane.clientWidth) { ls.set('rt.reader.narrow', 'pdf'); applyLayout(); pdfView.refit(); }
    pdfView.goPage(n);
    if (text) pdfView.flash(n, text).catch(() => {});
  }

  // ====================================================================== open / close / layout
  let resuming = null; // id of the paper that is opened again at start (not a new "opened" for the server)
  function leave() {
    if (pendingSave) saveItem.flush();
    savePosition();
    flushNoteAway();
    destroyEditor();
    if (pdfView) { pdfView.destroy(); pdfView = null; }
  }
  function open(id, force = false) {
    if (id === cur && !force && $('.rd-body', d)) { RT.emit('item:shown', { id }); return; }
    leave();
    d.dataset.item = '';
    const again = id === cur || id === resuming;
    resuming = null;
    cur = id; RT.state.sel = id; sentences = null; showSent = false;
    ls.set('rt.reader.last', id);
    if (!again && !document.body.classList.contains('touring')) markOpened(id); // the tour's look at a paper is no opening
    renderDetail(); RT.emit('item:shown', { id }); RT.claudeContext.refresh();
  }
  function close() {
    leave();
    cur = null; RT.state.sel = null; sentences = null; showSent = false;
    ls.set('rt.reader.last', '');
    renderDetail(); RT.emit('item:closed'); RT.claudeContext.refresh();
  }

  const ratio = () => { const r = parseFloat(ls.get('rt.reader.ratio', '0.5')); return r > 0.1 && r < 0.9 ? r : 0.5; };
  function applyLayout() {
    const body = $('.rd-body', d); if (!body) return;
    body.style.setProperty('--rd-ratio', ratio());
    body.classList.toggle('swapped', ls.get('rt.reader.swap') === '1');
    const max = body.dataset.max || '';
    body.classList.toggle('max-pdf', max === 'pdf'); body.classList.toggle('max-work', max === 'work');
    for (const [sel, on] of [['#rd-max-pdf', max === 'pdf'], ['#rd-max-work', max === 'work']]) {
      const b = $(sel); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    }
    const side = ls.get('rt.reader.narrow', 'work');
    body.classList.toggle('m-pdf', side === 'pdf');
    $$('#rd-narrow button', d).forEach((b) => { b.classList.toggle('on', b.dataset.side === side); b.setAttribute('aria-pressed', String(b.dataset.side === side)); });
  }
  function setTab(tab) {
    if (!['notes', 'diagram', 'quiz', 'kp', 'details', 'related'].includes(tab)) tab = 'notes';
    ls.set('rt.reader.tab', tab);
    $$('.rd-tabs [data-tab]', d).forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-pressed', String(b.dataset.tab === tab)); });
    $$('.rd-panel', d).forEach((p) => (p.hidden = p.dataset.panel !== tab));
    if (tab !== 'notes' && (note.dirty || noteUnsaved())) saveNote('auto').catch(fail);
    $('#note-tools', d).hidden = tab !== 'notes';
    $('#note-status', d).hidden = tab !== 'notes';
    $('.rd-work', d).dataset.tab = tab;
    if (tab === 'diagram') showDiagram();
    if (tab === 'quiz') showQuiz();
    if (tab === 'related') showRelated();
  }
  // Related tab (related.js): the references of the open paper and the papers that cite it
  function showRelated() {
    const it = current(), host = $('#rd-related', d);
    if (it && host && RT.related) RT.related.show(host, it);
  }
  // Practice tab (quiz.js): multiple-choice questions on the open paper, written by Claude
  function showQuiz() {
    const it = current(), host = $('#rd-quiz', d);
    if (!it || !host || !RT.quiz) return;
    RT.quiz.show(host, it, {
      page(n) { if (pdfView) showPage(n); },
    });
  }
  // Diagram tab (diagram.js): explained pipeline / workflow / flow chart of the open paper, drawn by Claude
  function showDiagram() {
    const it = current(), host = $('#rd-diagram', d);
    if (!it || !host || !RT.diagram) return;
    RT.diagram.show(host, it, {
      page(n) { if (pdfView) showPage(n); },
      insert(md) { const ready = note.ed && !drafts.has(note.id); insertIntoNote(md); if (ready) toast('Diagram inserted into the note', 'ok'); },
    });
  }

  // Build the workspace of the open item (PDF viewer + editor are created once per item; the Key points and Details
  // panels are re-rendered by renderPanels()).
  function renderDetail() {
    const it = current();
    if (!it) { leave(); d.classList.remove('rd-open'); d.innerHTML = '<div class="empty">Select a reference to read it, take notes and see its key points.</div>'; return; }
    if ($('.rd-body', d) && d.dataset.item === it.id) return renderPanels();
    d.dataset.item = it.id; d.classList.add('rd-open');
    d.innerHTML = `
    <div class="rd-body ${it.pdf ? '' : 'no-pdf'}">
      <section class="rd-pdf" id="rd-pdf"></section>
      <div class="rd-divider" id="rd-divider" title="Drag to resize · double-click to reset"></div>
      <section class="rd-work">
        <div class="rd-tabs">
          <div class="seg" id="rd-narrow"><button data-side="pdf" class="ib" title="Show the PDF" aria-label="Show the PDF">${RT.icon('pdf')}</button><button data-side="work" class="ib" title="Show the notes, key points and details" aria-label="Show the notes">${RT.icon('note')}</button></div>
          <div class="rd-tablist" role="group" aria-label="Views of this paper">
            ${TABS.map(([k, ic, label, hint]) => `<button data-tab="${k}" class="rd-tab" title="${hint}" aria-label="${label}">${RT.icon(ic)}<span class="rd-tab-text">${label}</span></button>`).join('')}
          </div>
        </div>
        <div class="rd-ctx">
          <span class="rd-ctx-state">
            <span class="rd-note-state" id="note-status"><span class="saved" id="note-state"></span><span id="draft-status" class="muted"></span></span>
            <span class="saved rd-item-saved" id="saved"></span>
          </span>
          <span id="note-tools" class="rd-note-tools">
            <div class="tgroup" role="group" aria-label="Draft">
              <button id="btn-draft" class="accent ib has-text" title="Generate first draft: let Claude read the paper and write the first draft of the reading note in the team's format" aria-label="Draft with Claude">${DRAFT_FACE()}</button>
              <button id="btn-draft-cancel" class="ib" title="Stop Claude" aria-label="Stop Claude" hidden>${RT.icon('stop')}</button>
            </div>
            <div class="tgroup" role="group" aria-label="Insert">
              <span class="menu-wrap"><button id="btn-figures" class="ib has-text" title="Figures: the figures and tables of the paper, cut out of the PDF - click one to put it into the note, or fill the 📷 placeholders of the note" aria-label="Figures and tables of the paper" aria-haspopup="dialog" aria-expanded="false">${FIG_FACE()}</button><div class="popover fg-pop" id="fig-pop" hidden></div></span>
            </div>
          </span>
          <div class="tgroup" role="group" aria-label="Note">
            <button id="btn-note-menu" class="ib" title="More: save, history, export, import, template, languages" aria-label="More note actions" aria-haspopup="menu" aria-expanded="false">${RT.icon('more')}</button>
          </div>
          <div class="tgroup rd-layout" role="group" aria-label="Layout">
            <button id="rd-swap" class="ib" title="Swap the PDF and the notes" aria-label="Swap the PDF and the notes">${RT.icon('swap-panes')}</button>
            <button id="rd-max-work" class="ib" title="Maximise / restore this pane" aria-label="Maximise or restore this pane">${RT.icon('maximize')}</button>
          </div>
        </div>
        <div class="rd-attach" id="rd-attach" ${it.pdf ? 'hidden' : ''}>
          <span>No PDF attached — drop one here</span> <button id="btn-attach-pdf" class="ib" title="Attach PDF: choose a PDF file for this reference" aria-label="Attach PDF">${RT.icon('attach')}</button>
        </div>
        <div class="rd-panel rd-notes" data-panel="notes">
          <div class="rd-conflict" id="note-conflict" hidden>
            The note was changed on disk since it was opened (for example by Claude).
            <button data-act="conflict-theirs" class="ib" title="Load that version: replace what is in the editor with the note on disk" aria-label="Load that version">${RT.icon('pull')}</button><button data-act="conflict-mine" class="ib" title="Keep mine: save the editor's text over the version on disk (that one stays in History)" aria-label="Keep mine">${RT.icon('save')}</button>
          </div>
          <div class="rd-note-empty" id="note-empty" hidden></div>
          <div class="rd-editor" id="note-editor"></div>
        </div>
        <div class="rd-panel rd-diagram" data-panel="diagram" id="rd-diagram" hidden></div>
        <div class="rd-panel rd-quiz" data-panel="quiz" id="rd-quiz" hidden></div>
        <div class="rd-panel rd-scroll" data-panel="kp" id="rd-kp" hidden></div>
        <div class="rd-panel rd-scroll" data-panel="details" id="rd-details" hidden></div>
        <div class="rd-panel rd-related" data-panel="related" id="rd-related" hidden></div>
      </section>
      <input type="file" id="file-attach-pdf" accept="application/pdf,.pdf" hidden>
      <input type="file" id="file-note-import" accept=".md,.markdown,.txt,.json,text/markdown,application/json" hidden>
    </div>`;
    applyLayout();
    setTab(ls.get('rt.reader.tab', 'notes'));
    renderPanels();
    if (it.pdf) {
      pdfView = createPdfView($('#rd-pdf'), it, {
        quote(text, page) { return insertIntoNote(`> ${mdEsc(text)} (${pageLink(page)})`) === true; },
        keypoint(text, page) { return addKeypoint(text, page); },
        keypoints() { const now = current(); return now && now.id === it.id ? now.keypoints || [] : []; },
        openKeypoint,
        async snapshot(blob, page, region) {
          // a snapshot of a figure the app knows gets the label, width and caption start a placed figure gets
          const [url, f] = await Promise.all([uploadAsset(it.id, blob), RT.figures.match(it.id, page, region)]);
          if (cur !== it.id) return;
          const cap = f ? f.caption.replace(/^\s*\S+\s*[A-Z]?[\dIVXL]+\s*[:.|：．。—–-]?\s*/, '') : '';
          const md = f ? RT.figures.markdown(f, url, { language: noteLang(), desc: cap.length > 90 ? cap.slice(0, 90).replace(/\s+\S*$/, '') + '…' : cap }) : `![Figure (p. ${page})](${url})\n${pageLink(page)}`;
          if (insertIntoNote(md) !== true) return null;
          toast('Snapshot inserted into the note', 'ok');
          return { asset: String(url).split('/').pop() }; // the viewer offers "Ask Claude" about it
        },
        ask: (p, signal) => askClaude(it.id, p, signal),
        language: noteLang,
        note(md) { return insertIntoNote(md) === true; },
        moved: () => { if (!touring()) savePositionSoon(); },
      }, it.reading && typeof it.reading.page === 'number' ? it.reading : null);
    }
    loadNote(it);
  }
  // show a key point in the Key points tab and light its row up
  function openKeypoint(kid) {
    setTab('kp');
    const body = $('.rd-body', d);
    if (body.dataset.max === 'pdf') { body.dataset.max = ''; applyLayout(); }
    const row = $$('#kps .kp', d).find((r) => r.dataset.kid === kid);
    if (!row) return toast('That key point is not in the list any more.', 'bad');
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('lit'); void row.offsetWidth; row.classList.add('lit');
  }
  // A passage found by the Library search (library-list.js): open paper `id` if it is not open and show the
  // passage - h = {kind: 'pdf' | 'note' | 'kp', page, text, kp, own, tokens}. The PDF and the note editor load after
  // the paper opens, so this waits for the part it needs (and gives up when another paper is opened meanwhile).
  let revealRun = 0;
  async function reveal(id, h) {
    const run = ++revealRun;
    if (RT.state.view !== 'library') RT.setView('library');
    if (cur !== id) { if (RT.library && RT.library.select) RT.library.select(id); else open(id); }
    const live = () => run === revealRun && cur === id;
    const until = async (ok, ms = 15000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms;) {
        if (!live()) return false;
        if (ok()) return true;
        await new Promise((r) => setTimeout(r, 80));
      }
      return false;
    };
    const it = current();
    if (!it || it.id !== id) return;
    // on a narrow window only one pane shows: a note line or a key point needs the working pane, not the PDF
    const showWork = () => {
      const body = $('.rd-body', d), sw = $('#rd-narrow', d);
      if (body && sw && sw.offsetParent !== null && body.classList.contains('m-pdf')) { ls.set('rt.reader.narrow', 'work'); applyLayout(); }
    };
    if (h.kind === 'note') {
      setTab('notes');
      const body = $('.rd-body', d);
      if (body && body.dataset.max === 'pdf') { body.dataset.max = ''; applyLayout(); }
      showWork();
      if (!(await until(() => note.id === id && note.ed))) { if (live()) toast('The note is still loading - try again in a moment.', 'bad'); return; }
      await new Promise((r) => setTimeout(r, 60)); // the editor has just drawn the note
      if (live() && !note.ed.reveal(h.text, h.tokens || [])) toast('That line is not in the note any more.', 'bad');
      return;
    }
    if (h.kind === 'kp') {
      showWork();
      openKeypoint(h.kp);
      if (!it.pdf || !h.page || h.own) return; // the reader's own remark on a key point is not a passage of the PDF
    } else if (!it.pdf) return toast('This reference has no PDF attached.', 'bad');
    if (!(await until(() => pdfView && pdfView.page() !== null))) { if (live() && h.kind === 'pdf') toast('The PDF is still loading - try again in a moment.', 'bad'); return; }
    if (h.kind === 'kp') { pdfView.goPage(h.page); pdfView.flash(h.page, h.text).catch(() => {}); } // the key point stays in view beside the PDF
    else showPage(h.page || 1, h.text);
  }
  const mdEsc = (s) => String(s).replace(/([\\`*_$\[\]<])/g, '\\$1');
  function insertIntoNote(md) {
    if (!note.ed) return toast('The note editor is still loading - try again in a moment.', 'bad');
    if (drafts.has(note.id)) return toast('Claude is writing the draft - wait until it is finished.', 'bad');
    setTab('notes');
    const body = $('.rd-body', d);
    if (body.dataset.max === 'pdf') { body.dataset.max = ''; applyLayout(); }
    note.ed.insertBlock(md);
    return true;
  }
  function addKeypoint(text, page) {
    const it = current(); if (!it) return;
    it.keypoints = it.keypoints || [];
    const id = rid();
    it.keypoints.push({ id, text, page: page || null, category: 'key', note: '' });
    renderKps(); touch();
    toast(`Added as key point (p. ${page})`, 'ok');
    return id;
  }

  function renderPanels() {
    const it = current(); if (!it) return;
    const f = it.fields;
    // Details: one cell per field, its label above it (two columns on a wide pane, reader.css)
    const cell = (label, control, cls = '') => `<div class="mf ${cls}">${label}${control}</div>`;
    const field = (name, label, cls = '') => cell(`<label for="rd-f-${name}">${label}</label>`, `<input type="text" id="rd-f-${name}" data-field="${name}" class="${cls}" value="${esc(f[name] || '')}">`);
    const venueField = f.booktitle && !f.journal ? 'booktitle' : 'journal';
    $('#rd-kp').innerHTML = `
    <div class="detail-head">
      ${it.pdf ? `<button id="btn-reextract" class="ib" title="Re-extract: re-run the built-in sentence scoring" aria-label="Re-extract key points">${RT.icon('refresh')}</button>` : ''}
      ${it.pdf ? `<button id="btn-claude-extract" class="accent ib" title="Extract with Claude: let Claude pick the key sentences and add a short gloss to each" aria-label="Extract with Claude">${RT.icon('sparkle')}</button>` : ''}
    </div>
    ${it.pdf && it.textFound === false ? `<div class="notice">No text could be read from this PDF (it may be a scan), so no key points were extracted.</div>` : ''}
    <h4>Key points <span class="badge"${it.keypointSource === 'claude' ? ' data-brand-keep' : ''}>${it.keypointSource === 'claude' ? `picked by ${esc(aiNameOf(it.keypointBy))}` : it.keypointSource === 'abstract' ? 'from abstract' : 'auto-extracted'}</span><span class="spacer"></span>
      <button id="btn-add-kp" class="ib" title="Add a key point" aria-label="Add a key point">${RT.icon('plus')}</button></h4>
    <div id="kps"></div>
    ${it.pdf ? `<h4>All sentences <span class="spacer"></span><button id="btn-toggle-sent" class="ib" title="Browse all sentences of the paper" aria-label="Browse all sentences of the paper">${RT.icon('eye')}</button></h4><div id="sents"></div>` : ''}`;
    const hb = (id, icon, label, hint, extra = '') => `<button id="${id}" class="ib has-text" title="${hint}" aria-label="${label}"${extra}>${RT.icon(icon)}<span class="ib-text">${label}</span></button>`;
    $('#rd-details').innerHTML = `
    <div class="detail-head rd-dhead">
      <div class="tgroup" role="group" aria-label="PDF file">
        ${it.pdf ? `<a class="ib has-text" href="/api/items/${esc(it.id)}/pdf" target="_blank" rel="noopener" title="Open the PDF in a new tab" aria-label="Open the PDF in a new tab">${RT.icon('external-link')}<span class="ib-text">Open PDF</span></a>` : ''}
        ${hb('btn-replace-pdf', it.pdf ? 'upload' : 'attach', it.pdf ? 'Replace PDF' : 'Attach PDF', it.pdf ? 'Replace PDF: choose another file for this reference (the old file goes to the trash)' : 'Attach PDF: choose a PDF file for this reference')}
      </div>
      <div class="tgroup" role="group" aria-label="Mark">
        ${hb('btn-star', 'star', 'Star', 'Star this paper', ' aria-pressed="false"')}
        ${hb('btn-proj', RT.projectPapers.ICON, 'Project', 'Add to a project', ' aria-pressed="false"')}
      </div>
      <div class="tgroup" role="group" aria-label="Check">
        ${RT.lineage && RT.lineage.check ? hb('btn-rd-lineage', RT.lineage.ICON, 'Lineage', 'Check lineage: the works this paper builds on, the works that build on it and its history line among your papers') : ''}
        ${RT.related ? hb('btn-check-meta', RT.related.META_ICON, 'Metadata', 'Check metadata: compare this entry with the published record and, for an arXiv preprint, look for the published version (only the DOI or arXiv id is sent; the cite key stays)') : ''}
      </div>
      <div class="spacer"></div>
      <button id="btn-delete" class="ib has-text danger" title="Delete this reference from the library (it goes to Recently deleted and can be put back)" aria-label="Delete this reference">${RT.icon('delete')}<span class="ib-text">Delete</span></button>
    </div>
    ${it.pdf && it.metaSource === 'guess' ? `<div class="notice">No DOI was found in this PDF, so the title and authors below are a best guess — please check them.</div>` : ''}
    <div class="meta">
      ${cell('<label for="rd-f-title">Title</label>', `<textarea id="rd-f-title" data-field="title" class="title" rows="1" data-oneline>${esc(f.title || '')}</textarea>`, 'wide')}
      ${cell('<label for="rd-f-author">Authors</label>', `<textarea id="rd-f-author" data-field="author" rows="1" data-oneline placeholder="Last, First and Last, First">${esc(f.author || '')}</textarea>`, 'wide')}
      ${field('year', 'Year')}
      ${cell(`<label for="rd-f-${venueField}">${venueField === 'journal' ? 'Journal' : 'Venue'}</label>`, `<input type="text" id="rd-f-${venueField}" data-field="${venueField}" value="${esc(f[venueField] || '')}">`)}
      ${cell('<label class="rd-vn-label" title="Where the paper was published, verified at Crossref, DBLP, OpenAlex, Semantic Scholar and arXiv (the Library groups by it: View menu, Venue)">Verified venue</label>', '<div class="rd-venue" id="rd-venue"></div>', 'wide')}
      ${cell('<label for="citekey">Cite key</label>', `<input type="text" id="citekey" value="${esc(it.citekey)}">`)}
      ${cell('<label for="type">Type</label>', `<select id="type">${TYPES.concat(TYPES.includes(it.type) ? [] : [it.type]).map((t) => `<option ${t === it.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`)}
      ${cell('<label for="rd-status">Status</label>', `<select id="rd-status" title="Reading status: a paper becomes “Reading” when you open it for the first time; set “Done” when you have finished it">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}
      ${cell('<label for="rd-category">Category</label>', '<input type="text" id="rd-category" list="rd-cat-list" maxlength="60" placeholder="Uncategorized" title="The group this paper is listed under in the Library (changing it here counts as a manual choice, which Claude never overrides)">')}
      ${cell('<label for="rd-tags">Tags</label>', '<input type="text" id="rd-tags" placeholder="a, b, c" title="Up to 12 tags, separated by commas">', 'wide')}
      ${cell('<label class="rd-pj-label">Projects</label>', '<div class="rd-projects" id="rd-projects"></div>', 'wide')}
      <datalist id="rd-cat-list"></datalist>
      ${cell('<label for="rd-brief">Brief</label>', `<div class="rd-brief-row"><textarea id="rd-brief" rows="4" maxlength="600" title="What the paper is about in a sentence or two: shown under its title in the Library list. Claude writes it when the paper is grouped; you can edit it."></textarea><button id="btn-brief" class="ib" title="Write the brief with Claude (replaces the text here)" aria-label="Write the brief with Claude">${RT.icon('sparkle')}</button></div><div class="rd-brief-state" id="rd-brief-state" hidden></div>`, 'wide')}
      ${field('volume', 'Volume')}${field('pages', 'Pages')}
      ${field('doi', 'DOI')}${field('url', 'URL')}
    </div>
    <h4>Links <span class="spacer"></span><button id="btn-find-links" class="ib" title="Find links: also ask arXiv and Hugging Face (only the arXiv id is sent) and check that each project / code link answers" aria-label="Find links">${RT.icon('refresh')}<span>Find links</span></button></h4>
    <div class="rd-links" id="rd-links"><span class="muted">…</span></div>
    <h4>BibTeX <span class="spacer"></span><button id="btn-copy-bib" class="ib" title="Copy BibTeX" aria-label="Copy BibTeX">${RT.icon('copy')}</button></h4>
    <pre class="bib" id="bib"></pre>`;
    paintSentToggle(); renderKps(); refreshBib(); fillGrouping(); fillLinks(); if (showSent) renderSentences();
  }

  // category + tags (owned by the Library list; shown and editable here, saved on their own so an item autosave never touches them)
  const GROUP_FIELDS = ['category', 'tags', 'categoryStatus', 'categoryReason', 'categoryError', 'brief', 'briefStatus', 'briefError', 'briefBy'];
  const STATUS_LABEL = { unread: 'To read', reading: 'Reading', done: 'Done' };
  function fillGrouping() {
    const it = current(), c = $('#rd-category'), g = $('#rd-tags'), dl = $('#rd-cat-list');
    if (!it || !c || !g) return;
    const st = $('#rd-status'), star = $('#btn-star');
    if (st && document.activeElement !== st) st.value = STATUS_LABEL[it.status] ? it.status : 'unread';
    if (star) { const hint = it.starred ? 'Starred - click to remove the star' : 'Star this paper'; star.classList.toggle('on', !!it.starred); star.title = hint; star.setAttribute('aria-label', hint); star.setAttribute('aria-pressed', String(!!it.starred)); }
    fillProjects();
    fillVenue();
    if (document.activeElement !== c) c.value = it.category && it.category !== 'Uncategorized' ? it.category : '';
    if (document.activeElement !== g) g.value = (Array.isArray(it.tags) ? it.tags : []).join(', ');
    c.placeholder = it.categoryStatus === 'pending' ? 'Claude is grouping…' : 'Uncategorized';
    // the brief: Claude's (or the user's) text, a spinner while Claude writes it, the reason when it could not
    const br = $('#rd-brief'), bb = $('#btn-brief'), bs = $('#rd-brief-state');
    if (br && bb && bs) {
      const writing = it.briefStatus === 'pending' || (it.categoryStatus === 'pending' && !it.brief);
      // (while the box has the focus the text is only replaced if nothing was typed into it: a brief Claude just wrote shows up, an edit is kept)
      if (document.activeElement !== br || br.value === (br.dataset.shown ?? br.value + '!')) { br.value = it.brief || ''; br.dataset.shown = br.value; }
      br.placeholder = writing ? 'Claude is writing the brief…' : 'No brief yet - type one, or let Claude write it with the button on the right';
      bb.disabled = writing; bb.innerHTML = writing ? '<span class="spin"></span>' : RT.icon('sparkle');
      bs.hidden = it.briefStatus !== 'failed';
      // the saved error names the provider that failed then (data-brand-keep), and is translated on its own
      bs.innerHTML = it.briefStatus === 'failed' ? `<span>The brief could not be written:</span> <span data-brand-keep>${esc(it.briefError || 'unknown error')}</span>` : '';
    }
    let names = [];
    try { if (RT.categories && RT.categories.names) names = RT.categories.names() || []; } catch { names = []; }
    if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  }
  // the "Verified venue" line: what the venue check (RT.library.checkVenues, lib/venues.js) found, why it found
  // nothing, and a button that checks this paper again. The BibTeX fields are never changed by it.
  function fillVenue() {
    const it = current(), box = $('#rd-venue'), L = RT.library;
    if (!it || !box || !L.venue) return;
    const r = L.venue(it.id), run = L.venuesRunning();
    const link = (x) => (/^https:\/\//.test(x.url || '') ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" title="${esc(x.name + (x.venue ? ': ' + x.venue : '') + (x.year ? ' ' + x.year : ''))}">${esc(x.name)}</a>` : esc(x.name));
    const names = (rec) => { const seen = new Set(); return (rec.sources || []).filter((x) => !seen.has(x.name) && seen.add(x.name)).map(link).join(', '); };
    let html;
    if (run && run.current && run.current.id === it.id) html = '<span class="spin"></span>Checking the venue…';
    else if (!r) html = '<span class="muted">Not checked yet</span>';
    else if (r.stale) html = '<span class="muted">Not checked since the title, DOI or arXiv id changed</span>';
    else if (r.status === 'published') html = `<b title="${esc([r.venue, r.kind, r.publisher].filter(Boolean).join(' · '))}">${esc((r.short || r.venue || '') + (r.year ? ' ' + r.year : ''))}</b> · verified (${names(r)})${r.date ? ` <span class="muted">· first public ${esc(r.date)}</span>` : ''}`;
    else if (r.status === 'preprint') html = `arXiv preprint${r.date ? ' · v1 ' + esc(r.date) : ''}${r.claim ? ` <span class="rd-vn-claim" title="The arXiv entry says so, but no index confirms it">· claims: ${esc(r.claim)} (not confirmed)</span>` : ''}${(r.sources || []).length ? ` <span class="muted">(${names(r)})</span>` : ''}`;
    else html = `<span class="rd-vn-bad">Not verified:</span> ${esc(r.why || 'unknown reason')}`;
    if (r && !r.stale && r.lastError) html += ` <span class="muted" title="${esc(r.lastError)}">(the last check could not finish; this is the earlier answer)</span>`;
    const tip = r && !r.stale && r.why ? `${r.why}${r.checked ? `\nChecked ${new Date(r.checked).toLocaleString()}` : ''}` : '';
    box.title = tip;
    // drawn again on every progress poll: aria-disabled (not disabled) while a check runs, so the button keeps the focus
    const had = document.activeElement && document.activeElement.id === 'btn-venue-check';
    box.innerHTML = `<span class="rd-vn-text">${html}</span><button class="ib" id="btn-venue-check" title="${r ? 'Check the venue again' : 'Check the venue'} (only the DOI, arXiv id or title is sent)" aria-label="${r ? 'Check the venue again' : 'Check the venue'}"${run ? ' aria-disabled="true"' : ''}>${RT.icon('refresh')}<span>${r ? 'Check again' : 'Check'}</span></button>`;
    if (had) $('#btn-venue-check').focus({ preventScroll: true });
  }
  // the "Links" section: the paper's project page, code, arXiv, DOI / publisher page (lib/links.js) - what the authors
  // stated in the BibTeX fields, the PDF, the arXiv comment or on Hugging Face. GET uses no network (instant);
  // "Find links" (POST) also asks arXiv / Hugging Face and checks that each project / code link answers.
  const linksOf = new Map(); // id -> the last answer
  let linksBusy = null; // the id a "Find links" runs for
  function paintLinks() {
    const it = current(), box = $('#rd-links'), b = $('#btn-find-links');
    if (!it || !box) return;
    const L = linksOf.get(it.id), busy = linksBusy === it.id;
    if (b) { b.disabled = busy; b.innerHTML = busy ? '<span class="spin"></span><span>Finding…</span>' : `${RT.icon('refresh')}<span>Find links</span>`; }
    if (!L) { box.innerHTML = busy ? '' : '<span class="muted">Looking…</span>'; return; }
    const src = (x) => `Found in: ${[x.source, ...(x.also || [])].filter(Boolean).join(', ')}`;
    const row = (k, x) => {
      if (!x || !/^https?:\/\//.test(x.url || '')) return '';
      const short = x.url.replace(/^https?:\/\/(www\.)?/, '');
      return `<div class="rd-lk${x.dead ? ' dead' : ''}"><span class="rd-lk-k">${esc(k)}</span><a class="rd-lk-u" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" title="${esc(x.url + '\n' + src(x))}">${esc(short)}</a>`
        + `${x.dead ? ' <span class="rd-lk-dead" title="The last check got no answer (404, 410 or an unknown host); it is still listed">unreachable</span>' : ''}`
        + `${x.unconfirmed ? ' <span class="rd-lk-dead" title="Only Hugging Face names this repository - anyone can attach one there, and neither the paper, its PDF links, its arXiv comment nor its project page names it. It is not part of the paper package.">suggested by Hugging Face, unconfirmed</span>' : ''}`
        + `<a class="ib rd-lk-open" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(short)} in a new tab" aria-label="Open ${esc(k)}">${RT.icon('open')}</a></div>`;
    };
    const KIND = { video: 'Video', dataset: 'Dataset', model: 'Models', demo: 'Demo', link: 'Link', code: 'Code', repo: 'Related repo', project: 'Project page' };
    const rows = [
      row('Project page', L.project),
      ...(L.code || []).map((c) => row('Code', c)),
      row('arXiv', L.arxiv && { url: L.arxiv, source: 'arXiv id' }),
      row('DOI', L.doi && { url: L.doi, source: L.publisher === L.doi ? L.publisherSource || 'BibTeX doi' : 'BibTeX doi' }),
      L.publisher && L.publisher !== L.doi ? row('Publisher', { url: L.publisher, source: L.publisherSource }) : '',
      ...(L.other || []).map((o) => row(KIND[o.kind] || 'Link', o)),
    ].filter(Boolean);
    const when = L.checked ? `arXiv and Hugging Face asked on ${new Date(L.checked).toLocaleDateString()}` : 'From the BibTeX fields and the PDF text - "Find links" also asks arXiv and Hugging Face';
    box.innerHTML = (rows.length ? rows.join('') : '<span class="muted">No project page, code or DOI found yet.</span>')
      + `<div class="rd-lk-note muted">${esc(when)}${(L.notes || []).length ? ' · ' + esc(L.notes.join(' · ')) : ''}</div>`;
  }
  async function fillLinks() {
    const it = current(); if (!it || !$('#rd-links')) return;
    const id = it.id;
    paintLinks();
    try { const L = await api(`/api/items/${RT.enc(id)}/links`); linksOf.set(id, L); } catch { /* keep the last answer */ }
    if (current() && current().id === id) paintLinks();
  }
  async function findLinks(it) {
    if (linksBusy) return;
    linksBusy = it.id; paintLinks();
    try {
      const L = await api(`/api/items/${RT.enc(it.id)}/links`, { method: 'POST', json: { force: true } });
      linksOf.set(it.id, L);
      const n = (L.project ? 1 : 0) + (L.code || []).length, dead = [L.project, ...(L.code || [])].filter((x) => x && x.dead).length;
      toast(n ? `Found ${n === 1 ? 'one link' : n + ' links'} to a project page or code${dead ? ` (${dead} unreachable)` : ''}` : 'No project page or code link found for this paper', n ? 'ok' : '');
    } catch (e) { toast('Could not look for the links: ' + e.message, 'bad'); }
    finally { linksBusy = null; if (current() && current().id === it.id) paintLinks(); }
  }
  // the projects the paper is in: the bookmark of the Details head (the working project) and the "Projects" line
  function fillProjects() {
    const it = current(), PP = RT.projectPapers, b = $('#btn-proj'), box = $('#rd-projects');
    if (!it || !b || !box) return;
    const w = PP.working(), on = !!w && PP.has(it.id, w.id);
    const hint = !w ? (PP.projects().length ? 'Add to a project…' : PP.NO_PROJECT) : on ? `In “${w.name}” - click to remove` : `Add to “${w.name}”`;
    b.classList.toggle('on', on); b.title = hint; b.setAttribute('aria-label', hint); b.setAttribute('aria-pressed', String(on));
    const ps = PP.of(it.id).map((pid) => PP.project(pid)).filter(Boolean);
    const hadFocus = box.contains(document.activeElement); // a removed chip or the Add button: the focus stays in the line
    box.innerHTML = ps.map((p) => `<span class="rd-pj" title="This paper is one of the papers of “${esc(p.name)}”">${esc(p.name)}<button class="ib" data-unproj="${esc(p.id)}" title="Remove from “${esc(p.name)}”" aria-label="Remove from ${esc(p.name)}">${RT.icon('close')}</button></span>`).join('')
      + (PP.projects().length ? `<button class="ib rd-pj-add" id="btn-proj-add" title="Add this paper to a project" aria-label="Add to a project">${RT.icon('plus')}<span>Add to…</span></button>`
        : `<span class="muted">${esc(PP.NO_PROJECT)}</span>`);
    if (hadFocus) { const f = $('#btn-proj-add') || box.querySelector('button'); if (f) f.focus({ preventScroll: true }); }
  }
  // At the last page of the PDF, with a note written and the paper not Done: offer "Mark as done", once per paper and session
  const finishAsked = new Set();
  function maybeFinished(it, pos) {
    if (!it || finishAsked.has(it.id) || !pdfView || !pdfView.pages || statusOf(it) === 'done') return;
    const total = pdfView.pages();
    if (!total || total < 2 || (pos.page < total && !(pdfView.atEnd && pdfView.atEnd()))) return;
    const text = note.id === it.id && note.ed ? note.ed.value() : '';
    if (text.trim().length <= 40) return; // (as the server counts a note)
    finishAsked.add(it.id);
    const name = String(it.fields.title || it.citekey);
    toast(`Finished reading “${name.length > 60 ? name.slice(0, 58).replace(/\s+\S*$/, '') + '…' : name}”? Mark it as done`, '', { label: 'Mark as done', icon: 'check', run: () => RT.library.setStatus([it.id], { status: 'done' }) });
  }
  const statusOf = (it) => (STATUS_LABEL[it.status] ? it.status : 'unread');
  async function saveGrouping(t) {
    const it = current(); if (!it) return;
    const json = t.id === 'rd-category' ? { category: t.value.trim() || 'Uncategorized' }
      : t.id === 'rd-brief' ? { brief: t.value.replace(/\s+/g, ' ').trim() }
      : { tags: [...new Set(t.value.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean))] };
    try {
      const r = await api('/api/items/' + it.id, { method: 'PUT', json });
      for (const k of GROUP_FIELDS) { if (k in r.item) it[k] = r.item[k]; else delete it[k]; }
      RT.emit('item:updated', { id: it.id });
    } catch (e) { toast('Could not save: ' + e.message, 'bad'); }
    if (cur === it.id) { if (document.activeElement === t) t.blur(); fillGrouping(); }
  }

  // the Browse / Hide switch of "All sentences": an eye that shows its state, the words live in the hint
  function paintSentToggle() {
    const b = $('#btn-toggle-sent'); if (!b) return;
    const hint = showSent ? 'Hide the sentence list' : 'Browse all sentences of the paper';
    b.innerHTML = RT.icon(showSent ? 'eyeOff' : 'eye'); b.title = hint; b.setAttribute('aria-label', hint);
    b.setAttribute('aria-pressed', String(showSent)); b.classList.toggle('on', showSent);
  }

  function renderKps() {
    const it = current(); if (!it || !$('#kps')) return;
    $('#kps').innerHTML = (it.keypoints || []).map((k) => `
    <div class="kp" data-kid="${esc(k.id)}">
      <div class="side">${k.page && it.pdf ? `<button class="pg" data-goto="${Number(k.page) || 1}" title="Show this passage on page ${esc(k.page)} of the PDF" aria-label="Show page ${esc(k.page)} of the PDF">p. ${esc(k.page)}</button>` : `<span class="pg">${k.page ? 'p. ' + esc(k.page) : '—'}</span>`}
        <select data-k="category">${[...new Set([...CATS, k.category || 'key'])].map((c) => `<option ${c === (k.category || 'key') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <textarea class="text" data-k="text" rows="2" placeholder="Key sentence…">${esc(k.text)}</textarea>
      <textarea class="note" data-k="note" rows="2" placeholder="Your note…">${esc(k.note || '')}</textarea>
      <button class="ghost ib" data-del title="Remove this key point" aria-label="Remove this key point">${RT.icon('close')}</button>
    </div>`).join('') || '<div class="muted">No key points yet. Add one, select text in the PDF, or browse all sentences below.</div>';
    if (pdfView && pdfView.highlights) pdfView.highlights.redraw(); // the key points are underlined on the pages of the PDF
  }

  async function refreshBib() {
    const it = current(); if (!it || !$('#bib')) return;
    try { $('#bib').textContent = (await api(`/api/items/${it.id}/bibtex`)).bibtex; } catch { /* keeps the old text */ }
  }

  async function renderSentences() {
    const it = current(); if (!it) return;
    try { if (!sentences) sentences = (await api(`/api/items/${it.id}/sentences`)).sentences; }
    catch (e) { return toast(e.message, 'bad'); }
    const host = $('#sents'); if (!host) return;
    if (!$('#sent-filter')) host.innerHTML = `<div class="sent-tools"><input type="search" id="sent-filter" placeholder="Filter ${sentences.length} sentences…"></div><div id="sent-list"></div>`;
    const q = $('#sent-filter').value.trim().toLowerCase();
    const used = new Set(it.keypoints.map((k) => k.text));
    $('#sent-list').innerHTML = sentences.filter((s) => !q || s.text.toLowerCase().includes(q)).map((s) => `
    <div class="sent ${used.has(s.text) ? 'is-kp' : ''}"><button class="pg" data-goto="${Number(s.page) || 1}" title="Show this sentence on page ${esc(s.page)} of the PDF" aria-label="Show page ${esc(s.page)} of the PDF">p. ${esc(s.page)}</button><span class="sent-text">${esc(s.text)}</span>
    ${used.has(s.text) ? `<span class="sent-kp" title="Already a key point" role="img" aria-label="Already a key point">${RT.icon('star')}</span>` : `<button data-add-sent="${Number(s.i)}" class="ib" title="Add as key point" aria-label="Add as key point">${RT.icon('plus')}</button>`}</div>`).join('') || '<div class="muted">No sentences.</div>';
  }

  // ====================================================================== PDF attach / replace
  async function attachPdf(file) {
    const it = current(); if (!it || !file) return;
    if (!(/\.pdf$/i.test(file.name) || file.type === 'application/pdf')) return toast('Only a PDF file can be attached.', 'bad');
    if (it.pdf && !(await RT.confirm('Replace the PDF of this reference?\n\nThe current file is moved to the trash folder of the workspace.', { title: 'Replace the PDF', okText: 'Replace the PDF', icon: 'swap' }))) return;
    toast(`Attaching ${file.name} — extracting text…`);
    try {
      await saveAll('auto');
      const r = await api(`/api/items/${it.id}/pdf?name=${RT.enc(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/pdf' } });
      Object.assign(it, r.item);
      RT.figures.invalidate(it.id); // the figures belong to the old file
      RT.emit('item:updated', { id: it.id });
      toast(`PDF attached (${r.item.pages} pages)`, 'ok');
      if (cur === it.id) open(it.id, true); // rebuild with the viewer
    } catch (e) { toast('Could not attach the PDF: ' + e.message, 'bad'); }
  }

  // ====================================================================== first draft by Claude
  const DRAFT_HINT = "Generate first draft: let Claude read the paper and write the first draft of the reading note in the team's format";
  function renderDraftState() {
    const st = drafts.get(cur);
    const btn = $('#btn-draft'), cancel = $('#btn-draft-cancel'), label = $('#draft-status');
    if (!btn) return;
    btn.disabled = !!st; btn.innerHTML = DRAFT_FACE(!!st); btn.setAttribute('aria-busy', String(!!st));
    btn.title = st ? 'Claude is writing the first draft…' : DRAFT_HINT;
    cancel.hidden = !st; label.textContent = st ? st.status : '';
    if (note.ed && note.id === cur) note.ed.disable(!!st);
    updateNoteEmpty();
  }
  async function startDraft() {
    const it = current(); if (!it || drafts.has(it.id)) return;
    if (!note.ed || note.id !== it.id) return toast('The note editor is still loading - try again in a moment.', 'bad');
    if (!it.pdf && !it.fields.abstract) return toast('Attach the PDF first: there is nothing to read for this reference.', 'bad');
    let replace = false;
    if (note.ed.value().trim()) {
      if (!(await RT.confirm('Replace the current note with a new draft written by Claude?\n\nThe current note stays in History, so it can be restored.', { title: 'Write a new draft', okText: 'Replace the note with a new draft', icon: 'sparkle' }))) return;
      replace = true;
    }
    if (!(await saveAll('manual'))) return;
    const id = it.id, ctrl = new AbortController(), st = { ctrl, status: 'Starting…' };
    drafts.set(id, st); renderDraftState();
    const language = noteLang();
    let done = null, error = null, conflict = null;
    try {
      const r = await fetch(`/api/items/${id}/note/draft`, { method: 'POST', signal: ctrl.signal, headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ language, replace }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Request failed (${r.status})`); }
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: end, value } = await rd.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'status') { st.status = ev.text; if (cur === id && $('#draft-status')) $('#draft-status').textContent = ev.text; }
          else if (ev.type === 'done') done = ev;
          else if (ev.type === 'conflict') conflict = ev;
          else if (ev.type === 'error') error = ev.text;
        }
      }
      if (!done && !error && !conflict) error = 'The connection closed before the draft was finished.';
    } catch (e) { error = e.name === 'AbortError' ? 'Draft cancelled - the note was not changed.' : e.message; }
    drafts.delete(id);
    if (cur === id) {
      renderDraftState();
      if (done && note.ed && note.id === id) { adoptNote(done.content, done.hash); setNoteState(`Draft by ${done.provider || aiName()} ` + new Date().toLocaleTimeString(), 'ok', true); }
      // the note changed while Claude wrote: the draft was not applied (it is in History); show what is on disk
      if (conflict && note.ed && note.id === id && !noteUnsaved()) { adoptNote(conflict.current, conflict.hash); setNoteState('Draft not applied'); }
    }
    if (conflict) toast(conflict.text || 'The note changed while Claude was writing - the draft was not applied (it is in History).', 'bad');
    else if (done) {
      const f = done.figures || { placed: 0, missed: 0 };
      const pics = f.placed ? `${f.placed} figure${f.placed === 1 ? '' : 's'} placed${f.missed ? `, ${f.missed} still to take by hand (📷)` : ''}`
        : f.missed ? `${f.missed} 📷 placeholder${f.missed === 1 ? '' : 's'} to replace with snapshots` : '';
      toast(`First draft written for “${it.fields.title || it.citekey}” — check the （待核实） marks${pics ? '. ' + pics[0].toUpperCase() + pics.slice(1) : ''}.`, 'ok');
    }
    else toast(error, 'bad');
  }

  // ---------------------------------------------------------------- figures of the paper (figures.js)
  // The picker of the notes toolbar: a click on a picture inserts it at the cursor; "Place the figures in this
  // note" lets the server fill the 📷 placeholders of the saved note (found from the PDF's layout, no Claude call).
  const placeholderCount = () => (note.ed && note.id === cur ? RT.figures.countPlaceholders(note.ed.value()) : 0);
  function toggleFigures() {
    const it = current(), pop = $('#fig-pop'); if (!it || !pop) return;
    if (!pop.hidden) return RT.figures.close(pop);
    // (the picture of paper A never lands in the note of paper B: both callbacks hold on to the paper the picker was opened for)
    const canInsert = () => (cur !== it.id || note.id !== it.id || !note.ed ? 'The note editor is still loading - try again in a moment.' : drafts.has(it.id) ? 'Claude is writing the draft - wait until it is finished.' : true);
    RT.figures.open(pop, { item: it, button: $('#btn-figures'), language: noteLang, canInsert, insert: (md) => (canInsert() === true ? insertIntoNote(md) : false), place: placeFigures, placeholders: placeholderCount }).catch(fail);
  }
  async function placeFigures() {
    const it = current(); if (!it) return;
    if (!note.ed || note.id !== it.id) return toast('The note editor is still loading - try again in a moment.', 'bad');
    if (drafts.has(it.id)) return toast('Claude is writing the draft - wait until it is finished.', 'bad');
    if (!placeholderCount()) return toast('There is no 📷 placeholder in this note - click a picture in the Figures list to insert it at the cursor.');
    if (!(await saveAll('manual'))) return; // the server works on the saved note
    const id = it.id, btn = $('#btn-figures');
    if (btn) { btn.disabled = true; btn.innerHTML = FIG_FACE(true); btn.setAttribute('aria-busy', 'true'); }
    setNoteState('Placing the figures…');
    try {
      const r = await RT.figures.place(id, { baseHash: note.hash, language: noteLang() });
      if (cur === id && note.ed && note.id === id) {
        if (r.changed && !noteUnsaved()) { adoptNote(r.content, r.hash); setNoteState('Figures placed ' + new Date().toLocaleTimeString(), 'ok'); }
        else if (r.changed) showConflict({ conflict: true, content: r.content, hash: r.hash }); // typed meanwhile: the usual choice (load that version / keep mine)
        else setNoteState('');
      }
      const n = r.placed.length, m = r.missed.length;
      if (r.unavailable) toast('The figures could not be placed: ' + r.unavailable, 'bad');
      else if (n) toast(`${n} figure${n === 1 ? '' : 's'} placed${m ? `, ${m} still to take by hand (${r.missed.slice(0, 4).map((x) => x.label || '📷').join(', ')}${m > 4 ? ', …' : ''})` : ''}.`, 'ok');
      else toast(`None of the ${m} 📷 placeholder${m === 1 ? '' : 's'} could be filled${r.missed[0] ? ` (${r.missed[0].label || 'the first'}: ${r.missed[0].reason})` : ''}. Use the snapshot tool of the PDF viewer.`, 'bad');
    } catch (e) {
      if (e.status === 409 && e.data && e.data.conflict && cur === id && note.id === id) showConflict(e.data);
      else { setNoteState(''); toast(e.message, 'bad'); }
    }
    if (btn) { btn.disabled = false; btn.innerHTML = FIG_FACE(); btn.removeAttribute('aria-busy'); }
  }

  // ====================================================================== dialogs: history, template
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-note-hist" class="rd-dlg">
  <h3>Note history</h3>
  <div class="rd-hist"><div class="rd-hist-list" id="nh-list"></div><div class="rd-hist-diff" id="nh-diff"><div class="empty">Select a version to compare it with the current note.</div></div></div>
  <div class="dlg-actions"><span class="muted" id="nh-info"></span><span class="spacer"></span><button id="nh-restore" class="ib" title="Restore this version (the text it replaces stays in History)" aria-label="Restore this version" disabled>${RT.icon('undo')}</button><button id="nh-close" class="ib" title="Close" aria-label="Close">${RT.icon('close')}</button></div>
</dialog>
<dialog id="dlg-note-tpl" class="rd-dlg">
  <h3>Note template <span class="muted">— the format guide Claude follows when it writes a first draft</span></h3>
  <div class="rd-tpl-editor" id="tpl-editor"></div>
  <div class="dlg-actions">
    <button id="tpl-import" class="ib" title="Import the template from a JSON draft…" aria-label="Import from JSON draft">${RT.icon('import')}</button><button id="tpl-reset" class="ib" title="Reset to the built-in format guide" aria-label="Reset to built-in">${RT.icon('reset')}</button><span class="spacer"></span>
    <button id="tpl-cancel" class="ib" title="Cancel: close without saving" aria-label="Cancel">${RT.icon('close')}</button><button class="primary ib" id="tpl-save" title="Save template (⌘S)" aria-label="Save template">${RT.icon('check')}</button>
  </div>
  <input type="file" id="file-tpl-import" accept=".json,application/json" hidden>
</dialog>`);

  let histSel = null;
  // the kind of a note version, in words: an AI draft names the provider that wrote it (v.by; older ones were all
  // Claude's), kept out of the display layer's renaming, which would name the provider chosen now
  const NOTE_SRC = { manual: 'Saved', auto: 'Autosave', baseline: 'Before first edit', external: 'Edited outside', import: 'Imported', restore: 'Restored' };
  const histSrc = (v) => (v.source === 'claude' ? `<span class="badge" data-brand-keep>${esc(aiNameOf(v.by))}</span>` : `<span class="badge">${esc(NOTE_SRC[v.source] || v.source)}</span>`);
  async function openHistory() {
    const it = current(); if (!it) return;
    if (!(await saveAll('auto'))) return toast('The note could not be saved first - resolve the conflict in the bar above the note (save icon keeps your text, arrow icon loads the version on disk) or try again, then repeat this.', 'bad'); // Restore would replace text that is not in History
    histSel = null; $('#nh-restore').disabled = true; $('#nh-info').textContent = '';
    $('#nh-diff').innerHTML = '<div class="empty">Select a version to compare it with the current note.</div>';
    const { versions } = await api(`/api/items/${it.id}/note/history`);
    $('#nh-list').innerHTML = versions.map((v) => `
      <button class="rd-hv" data-vid="${esc(v.id)}"><b>${esc(new Date(v.ts).toLocaleString())}</b>
        <span>${histSrc(v)}${v.label ? `<span data-brand-keep>${esc(v.label)}</span> ` : ''}<span class="muted">+${Number(v.added) || 0} −${Number(v.removed) || 0}</span></span></button>`).join('')
      || '<div class="muted">No versions yet. Versions are recorded when the note is saved.</div>';
    $('#dlg-note-hist').showModal();
  }
  $('#nh-list').addEventListener('click', async (e) => {
    const b = e.target.closest('.rd-hv'), it = current(); if (!b || !it) return;
    try {
      const r = await api(`/api/items/${it.id}/note/history/${RT.enc(b.dataset.vid)}/diff?against=current`);
      histSel = b.dataset.vid;
      $$('.rd-hv', $('#nh-list')).forEach((x) => x.classList.toggle('on', x === b));
      const changed = r.ops.some((o) => o.t !== 'eq');
      // "del" = only in that version, "add" = only in the current note
      $('#nh-diff').innerHTML = `<div class="rd-diff">${r.ops.map((o) => `<div class="${o.t === 'add' ? 'add' : o.t === 'del' ? 'del' : 'eq'}">${esc(o.text) || '&nbsp;'}</div>`).join('')}</div>`;
      $('#nh-info').textContent = changed ? 'Red: only in the selected version · green: only in the current note' : 'Identical to the current note';
      $('#nh-restore').disabled = !changed;
    } catch (err) { fail(err); }
  });
  $('#nh-close').addEventListener('click', () => $('#dlg-note-hist').close());
  $('#nh-restore').addEventListener('click', async () => {
    const it = current(); if (!it || !histSel) return;
    try {
      const r = await api(`/api/items/${it.id}/note/history/${RT.enc(histSel)}/restore`, { method: 'POST' });
      if (note.id === it.id) { adoptNote(r.content, r.hash); setNoteState('Restored', 'ok'); }
      $('#dlg-note-hist').close(); toast('Version restored (the replaced text is in History)', 'ok');
    } catch (err) { fail(err); }
  });

  let tplEd = null;
  async function openTemplate() {
    const dlg = $('#dlg-note-tpl');
    try {
      const { content } = await api('/api/note-template');
      dlg.showModal();
      if (tplEd) { tplEd.destroy(); tplEd = null; }
      $('#tpl-editor').innerHTML = '<div class="empty">Loading…</div>';
      tplEd = await createEditor($('#tpl-editor'), { value: content, split: false, onSave: () => $('#tpl-save').click() });
    } catch (e) { fail(e); }
  }
  const closeTemplate = () => { $('#dlg-note-tpl').close(); };
  $('#dlg-note-tpl').addEventListener('close', () => { if (tplEd) { tplEd.destroy(); tplEd = null; } });
  $('#tpl-cancel').addEventListener('click', closeTemplate);
  $('#tpl-save').addEventListener('click', async () => {
    if (!tplEd) return;
    try { await api('/api/note-template', { method: 'PUT', json: { content: tplEd.value() } }); closeTemplate(); toast('Template saved', 'ok'); }
    catch (e) { fail(e); }
  });
  $('#tpl-reset').addEventListener('click', async () => {
    if (!(await RT.confirm('Replace the template with the built-in format guide?\n\nThe current template stays in the history folder of the workspace.', { title: 'Reset the template', okText: 'Reset the template', icon: 'reset' }))) return;
    try { const r = await api('/api/note-template', { method: 'PUT', json: { reset: true } }); if (tplEd) tplEd.set(r.content); toast('Template reset', 'ok'); }
    catch (e) { fail(e); }
  });
  $('#tpl-import').addEventListener('click', () => $('#file-tpl-import').click());
  async function importTemplateFile(file) {
    if (!file) return;
    try {
      let draft; try { draft = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON.'); }
      const r = await api('/api/note-template', { method: 'PUT', json: { draft } });
      if (tplEd && $('#dlg-note-tpl').open) tplEd.set(r.content);
      toast('Template imported from the JSON draft', 'ok');
    } catch (e) { toast('Could not import the template: ' + e.message, 'bad'); }
  }
  $('#file-tpl-import').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importTemplateFile(f); });

  async function importNoteFile(file) {
    const it = current(); if (!it || !file) return;
    try {
      if (note.ed && note.ed.value().trim() && !(await RT.confirm('Replace the current note with the imported file?\n\nThe current note stays in History.', { title: 'Import a note', okText: 'Replace the note with the file', icon: 'upload' }))) return;
      if (!(await saveAll('manual'))) return toast('The note could not be saved first - resolve the conflict in the bar above the note (save icon keeps your text, arrow icon loads the version on disk) or try again, then repeat this.', 'bad');
      const isJson = /\.json$/i.test(file.name) || file.type === 'application/json';
      const r = await api(`/api/items/${it.id}/note/import`, { method: 'POST', body: await file.text(), headers: { 'Content-Type': isJson ? 'application/json' : 'text/markdown' } });
      if (note.id === it.id) { adoptNote(r.content, r.hash); setNoteState('Imported', 'ok'); }
      toast('Note imported', 'ok');
    } catch (e) { toast('Could not import the note: ' + e.message, 'bad'); }
  }
  async function download(url) {
    await saveAll('auto');
    const a = document.createElement('a'); a.href = url; a.download = ''; document.body.append(a); a.click(); a.remove();
  }
  // ---- a note for another app: its pictures travel with it (lib/notes.js portableNote)
  const MB = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const missingNote = (h) => { const n = Number(h.get('X-RT-Missing')) || 0; return n ? ` - ${plural(n, 'picture')} missing on disk, marked "[missing image]"` : ''; };
  async function exportNoteZip(it, pdf = true) {
    try {
      await saveAll('auto');
      const r = await RT.downloadFile(`/api/items/${RT.enc(it.id)}/note/export?format=zip${pdf ? '' : '&pdf=0'}`);
      const pics = Number(r.headers.get('X-RT-Assets')) || 0, pdfs = Number(r.headers.get('X-RT-Pdfs')) || 0, notes = Number(r.headers.get('X-RT-Notes')) || 0;
      const parts = [notes ? 'the note' : 'no note yet', pics ? 'its pictures' : '', pdfs ? 'the PDF' : '', 'the BibTeX and links'].filter(Boolean);
      toast(`Saved ${r.name} (${MB(r.size)}): ${parts.join(', ')} - unzip it and open the .md${missingNote(r.headers)}`, 'ok');
      fillLinks(); // the export may have found links (it asks arXiv / Hugging Face)
    } catch (e) { toast('Could not export the paper package: ' + e.message, 'bad'); }
  }
  async function exportNoteEmbedded(it) {
    try {
      await saveAll('auto');
      const r = await RT.downloadFile(`/api/items/${RT.enc(it.id)}/note/export?format=md-embedded`);
      const omitted = Number(r.headers.get('X-RT-Omitted')) || 0, pics = Number(r.headers.get('X-RT-Images')) || 0;
      const big = r.size > 5 * 1048576 ? ` It is large (${MB(r.size)}): some apps open it slowly - the .zip export keeps the pictures as files.` : '';
      toast(`Saved ${r.name} (${MB(r.size)})${pics ? ' with the pictures inside' : ''}${omitted ? `, ${plural(omitted, 'video')} left out` : ''}${missingNote(r.headers)}.${big}`, big ? '' : 'ok');
    } catch (e) { toast('Could not export the note: ' + e.message, 'bad'); }
  }
  // Markdown with the pictures as data: URIs as text/plain, and the same rendered by Lute (the note editor's renderer)
  // as text/html, so that rich editors (Feishu, Notion, Word) paste the pictures too
  const COPY_MAX = 8 * 1048576;
  async function copyNote(it) {
    try {
      await saveAll('auto');
      const r = await fetch(`/api/items/${RT.enc(it.id)}/note/export?format=md-embedded`, { headers: { 'X-RT': '1' } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Request failed (${r.status})`); }
      const md = await r.text(), size = new Blob([md]).size;
      if (!md.trim()) return toast('The note is empty', 'bad');
      if (size > COPY_MAX) return toast(`The note with its pictures is ${MB(size)}, too large for the clipboard - use "Export paper package (.zip)" instead.`, 'bad');
      let html = '';
      try { const lute = note.ed && note.ed.vd && note.ed.vd.vditor && note.ed.vd.vditor.lute; if (lute) html = lute.Md2HTML(md); } catch { html = ''; }
      let rich = false;
      if (html && window.ClipboardItem && navigator.clipboard.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([md], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
          rich = true;
        } catch { /* text only below */ }
      }
      if (!rich) await navigator.clipboard.writeText(md);
      const pics = Number(r.headers.get('X-RT-Images')) || 0;
      toast(`Copied the note${rich ? ' as Markdown and formatted text' : ' as Markdown'}${pics ? ', with its pictures inside' : ''} (${MB(size)})${missingNote(r.headers)}`, 'ok');
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'The browser did not allow copying to the clipboard - use "Export note (.md, pictures inside)" or "Export paper package (.zip)" instead' : 'Could not copy the note: ' + e.message, 'bad'); }
  }

  // ====================================================================== events inside #detail
  // (the paper lost from the list: found again first, then this input is applied - it is not dropped)
  d.addEventListener('input', (e) => {
    const t = e.target, it = current();
    if (it) onInput(it, t);
    else if (openId()) recoverCurrent('reader input').then((found) => { if (found && t.isConnected) onInput(found, t); });
  });
  function onInput(it, t) {
    if (t.id === 'sent-filter') return void renderSentences();
    if (!t.closest('#rd-kp, #rd-details')) return; // the editor and the PDF toolbar handle their own input
    if (t.dataset.field) { const v = (t.hasAttribute('data-oneline') ? t.value.replace(/\s*\n\s*/g, ' ') : t.value).trim(); if (v) it.fields[t.dataset.field] = v; else delete it.fields[t.dataset.field]; }
    else if (t.id === 'citekey') it.citekey = t.value.trim();
    else if (t.id === 'type') it.type = t.value;
    else if (t.dataset.k && t.closest('.kp')) { const k = it.keypoints.find((x) => x.id === t.closest('.kp').dataset.kid); if (k) k[t.dataset.k] = t.value; }
    else return;
    touch();
  }
  d.addEventListener('change', (e) => {
    const t = e.target;
    if (!current() && openId()) return void recoverCurrent('reader change').then((found) => { if (found) onChange(t); });
    onChange(t);
  });
  function onChange(t) {
    if (t.id === 'citekey') saveItem.flush();
    else if (t.id === 'rd-category' || t.id === 'rd-tags' || t.id === 'rd-brief') saveGrouping(t).catch(fail);
    else if (t.id === 'rd-status') { const it = current(); if (it && RT.library.setStatus) RT.library.setStatus([it.id], { status: t.value }).then(() => { t.blur(); fillGrouping(); }).catch(fail); } // (a change that failed shows the stored status again)
    else if (t.id === 'file-attach-pdf') { const f = t.files[0]; t.value = ''; attachPdf(f); }
    else if (t.id === 'file-note-import') { const f = t.files[0]; t.value = ''; importNoteFile(f); }
  }

  // the language Claude writes first drafts and answers in (the same setting as Preferences > AI)
  function setDraftLang(v) {
    if (RT.prefs) return RT.prefs.setDraftLanguage(v).then(() => toast(`First drafts are now written in ${v === 'en' ? 'English' : '中文'} (also in Preferences)`, 'ok')).catch(fail);
    ls.set('rt.note.lang', v);
  }
  // the language of the editor's own menus and hints: the editor is rebuilt in it
  function setEditorLang(next) {
    const it = current(), prev = uiLang() === 'zh_CN' ? 'zh' : 'en';
    if (next === prev) return;
    ls.set('rt.lang', next);
    if (it) saveNote('auto').then((ok) => {
      if (cur !== it.id) return;
      if (!ok) { ls.set('rt.lang', prev); return toast('The note could not be saved first - resolve the conflict in the bar above the note (save icon keeps your text, arrow icon loads the version on disk) or try again, then repeat this.', 'bad'); } // never drop unsaved text with the old editor
      destroyEditor(); loadNote(it);
    }).catch(fail);
  }
  // the note's actions (the ⋯ menu of the Notes bar)
  async function noteAct(act) {
    const it = current(); if (!it) return;
    if (act === 'save') await saveAll('manual');
    else if (act === 'history') await openHistory();
    else if (act === 'export-pdf') {
      if (!(note.ed && note.id === it.id)) return toast('Open the note first.');
      const f = it.fields || {};
      await RT.notePdf.print({ md: note.ed.value(), title: f.title || it.citekey, authors: String(f.author || '').split(/\s+and\s+/).filter(Boolean).map((a) => a.split(',')[0].trim()).slice(0, 4).join(', ') + (String(f.author || '').split(/\s+and\s+/).length > 4 ? ' et al.' : ''), year: f.year || '', citekey: it.citekey, options: previewOptions() });
    }
    else if (act === 'export-md') await download(`/api/items/${it.id}/note/export?format=md`);
    else if (act === 'export-zip') await exportNoteZip(it);
    else if (act === 'export-zip-nopdf') await exportNoteZip(it, false);
    else if (act === 'export-md-embedded') await exportNoteEmbedded(it);
    else if (act === 'copy-note') await copyNote(it);
    else if (act === 'export-json') await download(`/api/items/${it.id}/note/export?format=json`);
    else if (act === 'import') $('#file-note-import').click();
    else if (act === 'template') await openTemplate();
    else if (act === 'template-import') $('#file-tpl-import').click();
  }
  function openNoteMenu(btn) {
    const it = current(); if (!it) return;
    const act = (a) => () => noteAct(a).catch((err) => toast(err.message, 'bad'));
    // the text-only export says when the pictures stay behind
    const mdHint = note.ed && note.id === it.id && /\/note\/assets\//.test(note.ed.value())
      ? 'The Markdown text only: the pictures of this note will not travel with it (their links only work in this app) - use "Export paper package (.zip)" for another app'
      : 'The Markdown text only';
    const draft = noteLang(), ed = uiLang() === 'zh_CN' ? 'zh' : 'en';
    const langs = (now, set) => [['zh', '中文'], ['en', 'English']].map(([v, label]) => ({ label, icon: v === now ? 'check' : '', onClick: () => set(v) }));
    RT.menu(btn, [
      { label: 'Save now', icon: 'save', kbd: [RT.modKey || '⌘', 'S'], onClick: act('save') },
      { label: 'History…', icon: 'history', title: 'Compare and restore earlier versions of this note', onClick: act('history') },
      { heading: 'Export' },
      { label: 'Export note as PDF…', icon: 'pdf', id: 'note-export-pdf', title: 'The note as a PDF, laid out for the page: wide tables and formulas are scaled to fit, pictures and diagrams stay inside the page, code wraps. It opens the print window of the browser - choose "Save as PDF" there.', onClick: act('export-pdf') },
      { label: 'Export paper package (.zip)', icon: 'archive', title: "One .zip with everything about the paper: the note as Markdown (a header with the authors, venue and links) with its pictures in assets/, the PDF, the BibTeX entry and the paper's links (project page, code, arXiv, DOI) - unzip it and open the .md in Obsidian, Typora, VS Code, or import the folder into Notion, Feishu, Yuque", onClick: act('export-zip') },
      { label: '… without the PDF', icon: 'archive', title: 'The same package without the PDF file: the links line points to the arXiv PDF when there is one', onClick: act('export-zip-nopdf') },
      { label: 'Export note (.md, pictures inside)', icon: 'export', title: 'One .md file with every picture inside it (base64 data: URIs): Typora, Obsidian and VS Code show it without a folder. Videos are left out.', onClick: act('export-md-embedded') },
      { label: 'Export note (.md, text only)', icon: 'export', id: 'note-export-md', title: mdHint, onClick: act('export-md') },
      { label: 'Export note (JSON draft)', icon: 'export', onClick: act('export-json') },
      { heading: 'Copy' },
      { label: 'Copy note for another app', icon: 'copy', title: 'Copy the note with its pictures inside, as Markdown and as formatted text: paste it into another app (Feishu, Notion, Word, Typora, Obsidian)', onClick: act('copy-note') },
      { heading: 'Import and template' },
      { label: 'Import note (.md / JSON draft)…', icon: 'import', onClick: act('import') },
      { label: 'Edit template…', icon: 'edit', title: 'The format guide Claude follows when it writes a first draft', onClick: act('template') },
      { label: 'Import template from JSON draft…', icon: 'import', onClick: act('template-import') },
      { heading: 'Languages' },
      { label: 'Draft language', icon: 'sparkle', title: "The language of first drafts and of Claude's answers in the note - the same setting as Preferences > AI > First-draft language", sub: langs(draft, setDraftLang) },
      { label: 'Editor language', icon: 'globe', title: "The language of the editor's own menus and hints", sub: langs(ed, setEditorLang) },
    ], { align: 'end' });
  }

  d.addEventListener('click', async (e) => {
    const t = e.target;
    let it = current();
    if (!it) { if (!openId() || !t.closest('button, a, [data-tab], [data-goto], [data-act], [data-del], [data-add-sent], [data-unproj], select, input')) return; it = await recoverCurrent('reader click'); if (!it) return; }
    try {
      if (t.closest('#btn-note-menu')) openNoteMenu(t.closest('#btn-note-menu'));
      else if (t.id === 'btn-figures') toggleFigures();
      else if (t.closest('.rd-tabs [data-tab]')) setTab(t.closest('[data-tab]').dataset.tab);
      else if (t.closest('#rd-narrow button')) { ls.set('rt.reader.narrow', t.dataset.side); applyLayout(); if (pdfView) pdfView.refit(); }
      else if (t.id === 'rd-swap') { ls.set('rt.reader.swap', ls.get('rt.reader.swap') === '1' ? '0' : '1'); applyLayout(); }
      else if (t.id === 'rd-max-pdf' || t.id === 'rd-max-work') {
        const body = $('.rd-body', d), want = t.id === 'rd-max-pdf' ? 'pdf' : 'work';
        body.dataset.max = body.dataset.max === want ? '' : want; applyLayout();
      }
      else if (t.closest('#btn-venue-check')) { if (RT.library.checkVenues && !RT.library.venuesRunning()) await RT.library.checkVenues([it.id], true); }
      else if (t.id === 'btn-brief') { if (RT.library.writeBriefs) await RT.library.writeBriefs([it.id]); }
      else if (t.closest('#btn-rd-lineage')) RT.lineage.check([it.id]);
      else if (t.id === 'btn-star') { if (RT.library.setStatus) await RT.library.setStatus([it.id], { starred: !it.starred }); }
      else if (t.closest('#btn-proj')) {
        if (RT.projectPapers.working()) await RT.projectPapers.toggle([it.id]);
        else { const r = t.closest('#btn-proj').getBoundingClientRect(), pid = await RT.projectPapers.pick({ title: 'Add this paper to', x: r.left, y: r.bottom + 3, current: false }); if (pid) await RT.projectPapers.toggle([it.id], { pid, on: true }); }
      }
      else if (t.closest('[data-unproj]')) await RT.projectPapers.toggle([it.id], { pid: t.closest('[data-unproj]').dataset.unproj, on: false });
      else if (t.closest('#btn-proj-add')) {
        const r = t.closest('#btn-proj-add').getBoundingClientRect();
        const pid = await RT.projectPapers.pick({ title: 'Add this paper to', x: r.left, y: r.bottom + 3, current: false });
        if (pid) await RT.projectPapers.toggle([it.id], { pid, on: true });
        const f = $('#btn-proj-add'); if (f && !$('.ctx-menu')) f.focus({ preventScroll: true }); // back from the menu
      }
      else if (t.closest('[data-goto]')) { // page chip of a key point or of a sentence: show the passage in the PDF
        const b = t.closest('[data-goto]'), kp = b.closest('.kp'), sent = b.closest('.sent');
        const k = kp ? (it.keypoints || []).find((x) => x.id === kp.dataset.kid) : null;
        showPage(Number(b.dataset.goto), k ? k.text : sent ? ($('.sent-text', sent) || {}).textContent : '');
      }
      else if (t.id === 'btn-draft') await startDraft();
      else if (t.id === 'btn-draft-cancel') { const st = drafts.get(it.id); if (st) st.ctrl.abort(); }
      else if (t.id === 'btn-attach-pdf' || t.id === 'btn-replace-pdf') $('#file-attach-pdf').click();
      else if (t.id === 'btn-check-meta') { if (RT.related) RT.related.checkMetadata(current()); }
      else if (t.closest('#btn-find-links')) await findLinks(it);
      else if (t.dataset.act === 'conflict-theirs') { if (note.conflict) { adoptNote(note.conflict.content, note.conflict.hash); setNoteState('Loaded the version on disk'); } }
      else if (t.dataset.act === 'conflict-mine') await saveNote('manual', { force: true });
      else if (t.matches('[data-del]')) { it.keypoints = it.keypoints.filter((k) => k.id !== t.closest('.kp').dataset.kid); renderKps(); touch(); if (showSent) renderSentences(); }
      else if (t.id === 'btn-add-kp') { it.keypoints.push({ id: rid(), text: '', page: null, category: 'key', note: '' }); renderKps(); $$('#kps .kp textarea.text').pop().focus(); touch(); }
      else if (t.id === 'btn-delete') {
        // no question: the message that follows has an Undo button, and the paper stays in "Recently deleted"
        await saveNote('auto');
        const gone = await api('/api/items/' + it.id, { method: 'DELETE' });
        pendingSave = false; destroyEditor(); if (pdfView) { pdfView.destroy(); pdfView = null; }
        cur = null; RT.state.sel = null; sentences = null; showSent = false;
        d.dataset.item = ''; // (while the list reloads, a click on the page still shown must not bring the deleted paper back)
        ls.set('rt.reader.last', '');
        if (RT.library && RT.library.refresh) await RT.library.refresh();
        renderDetail(); RT.emit('item:closed'); RT.claudeContext.refresh();
        const label = `“${it.fields.title || it.citekey}”`;
        if (RT.safety && RT.safety.deleted) RT.safety.deleted([gone.bin], label); else toast(`Deleted ${label}`, 'ok');
      }
      else if (t.id === 'btn-copy-bib') { await navigator.clipboard.writeText($('#bib').textContent); toast('BibTeX copied', 'ok'); }
      else if (t.id === 'btn-toggle-sent') { showSent = !showSent; paintSentToggle(); showSent ? renderSentences() : ($('#sents').innerHTML = ''); }
      else if (t.id === 'btn-reextract' || t.id === 'btn-claude-extract') {
        const mode = t.id === 'btn-claude-extract' ? 'claude' : 'heuristic';
        if (it.keypoints.some((k) => k.note) && !(await RT.confirm('This replaces the current key points, including the notes on them.', { title: 'Extract key points again', okText: 'Replace the key points', icon: 'refresh' }))) return;
        await saveItem.flush();
        const face = t.innerHTML, hint = t.title, busy = mode === 'claude' ? 'Claude is reading the paper…' : 'Extracting key points…';
        t.disabled = true; t.innerHTML = '<span class="spin"></span>'; t.title = busy; t.setAttribute('aria-busy', 'true');
        try {
          const r = await api(`/api/items/${it.id}/extract`, { method: 'POST', json: { mode } });
          Object.assign(it, r.item); delete it.notes;
          if (cur === it.id) renderPanels();
          RT.emit('item:updated', { id: it.id });
          toast(`${r.item.keypoints.length} key points extracted${r.truncated ? ' (paper was long; only the first part was sent to Claude)' : ''}`, 'ok');
        } catch (err) { toast(err.message, 'bad'); }
        if (t.isConnected) { t.disabled = false; t.innerHTML = face; t.title = hint; t.removeAttribute('aria-busy'); }
      }
      else if (t.matches('[data-add-sent]')) {
        const s = sentences.find((x) => x.i === Number(t.dataset.addSent));
        it.keypoints.push({ id: rid(), text: s.text, page: s.page, category: 'key', note: '', s: s.i });
        it.keypoints.sort((a, b) => (a.s ?? 1e9) - (b.s ?? 1e9));
        renderKps(); renderSentences(); touch();
      }
    } catch (err) { report(err, 'reader click' + (t.id ? ' #' + t.id : '')); } // (also an unexpected exception: shown and kept for Help › Copy diagnostics)
  });
  document.addEventListener('mousedown', (e) => {
    const f = $('#fig-pop'); if (f && !f.hidden && !e.target.closest('#fig-pop, #btn-figures')) RT.figures.close(f);
  });

  // Cmd/Ctrl+S anywhere in the reading workspace saves the note (as a save point) and the item
  // (Enter in the title or authors box ends the edit, as it did in the one-line fields: no line break in a field)
  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.target.matches && e.target.matches('textarea[data-oneline]')) { e.preventDefault(); saveItem.flush(); } });
  d.addEventListener('keydown', (e) => {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's')) return;
    if (current()) { e.preventDefault(); saveAll('manual').catch(fail); }
    else if (openId()) { e.preventDefault(); recoverCurrent('reader save').then((found) => { if (found) saveAll('manual').catch(fail); }); }
  });

  // ---- divider: drag to resize, double-click to reset
  d.addEventListener('pointerdown', (e) => {
    const div = e.target.closest('#rd-divider'); if (!div || e.button !== 0) return;
    e.preventDefault();
    const body = $('.rd-body', d), MIN = 260;
    div.setPointerCapture(e.pointerId); body.classList.add('dragging');
    const move = (ev) => {
      const r = body.getBoundingClientRect(), usable = r.width - div.offsetWidth;
      if (usable < 2 * MIN) return;
      let w = body.classList.contains('swapped') ? r.right - ev.clientX : ev.clientX - r.left; // width of the PDF pane
      w = Math.min(Math.max(MIN, w - div.offsetWidth / 2), usable - MIN);
      body.style.setProperty('--rd-ratio', w / usable);
    };
    const up = () => {
      div.removeEventListener('pointermove', move); div.removeEventListener('pointerup', up); div.removeEventListener('pointercancel', up);
      body.classList.remove('dragging');
      ls.set('rt.reader.ratio', String(parseFloat(body.style.getPropertyValue('--rd-ratio')) || 0.5));
      if (pdfView) pdfView.refit();
    };
    div.addEventListener('pointermove', move); div.addEventListener('pointerup', up); div.addEventListener('pointercancel', up);
  });
  d.addEventListener('dblclick', (e) => { if (e.target.closest('#rd-divider')) { ls.set('rt.reader.ratio', '0.5'); applyLayout(); if (pdfView) pdfView.refit(); } });

  // ---- file drops inside the workspace: a PDF on the attach area, images into the note
  d.addEventListener('dragover', (e) => { const a = e.target.closest && e.target.closest('#rd-attach'); if (a) a.classList.add('over'); });
  d.addEventListener('dragleave', (e) => { const a = e.target.closest && e.target.closest('#rd-attach'); if (a && !a.contains(e.relatedTarget)) a.classList.remove('over'); });
  d.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])]; if (!files.length || !current()) return;
    const attach = e.target.closest('#rd-attach');
    if (attach) { attach.classList.remove('over'); swallowDrop(e); attachPdf(files[0]); return; }
    if (e.target.closest('.rd-notes')) {
      const imgs = files.filter(isMediaFile); // pictures and videos go into the note
      if (!imgs.length) {
        // PDFs / .bib files: import them into the Library. The event is stopped here (capture phase) because Vditor's
        // own drop handler would otherwise take it and answer "only images can be added to a note".
        // (dataTransfer is read synchronously by the Library, before the event is stopped below)
        if (RT.library && RT.library.importDrop) RT.library.importDrop(e); // same handling as a drop anywhere else: PDFs, .bib, folders
        else if (RT.library && RT.library.importPdfs) RT.library.importPdfs(files);
        swallowDrop(e);
        return;
      }
      swallowDrop(e);
      const id = cur;
      (async () => {
        for (const f of imgs) {
          if (f.size > 8 * 1024 * 1024) toast(`Adding “${f.name}” (${Math.round(f.size / 1048576)} MB) to the note…`);
          const url = await uploadAsset(id, f), md = mediaMd(f.name, url);
          if (cur === id) insertIntoNote(md);
          else { // the paper was closed while the file was on its way: it goes to the end of its saved note
            const r = await api(`/api/items/${id}/note`);
            await api(`/api/items/${id}/note`, { method: 'PUT', json: { content: String(r.content || '').replace(/\s*$/, '') + '\n\n' + md + '\n', baseHash: r.hash, source: 'auto' } });
            toast(`“${f.name}” was added to the end of its note`, 'ok');
          }
        }
      })().catch(fail);
    }
  }, true);

  // ====================================================================== wiring
  RT.on('item:open', ({ id }) => open(id));
  // the list was refetched after a window focus / Claude run: show the fresh data unless the user is typing here
  RT.on('library:synced', () => {
    if (cur && !current()) return close(); // the item was removed outside the app
    const a = document.activeElement;
    if (!a || !a.closest('#rd-kp, #rd-details')) renderDetail();
    syncNote();
  });
  RT.on('item:categorized', ({ id } = {}) => { if (id === cur) fillGrouping(); }); // Claude's grouping result arrived
  RT.on('library:refreshed', fillGrouping);
  RT.on('item:updated', fillGrouping); // status or star changed in the list
  RT.on('memberships:changed', fillProjects); // added to or removed from a project, another working project
  RT.on('venues:changed', fillVenue); // a venue check moved on or finished
  RT.on('view:changed', () => { if (note.dirty || noteUnsaved()) saveNote('auto').catch(fail); if (pdfView && RT.state.view === 'library') pdfView.refit(); });
  RT.on('layout:changed', () => { if (pdfView) pdfView.refit(); });
  RT.addFlusher('reader', async () => { if (pendingSave) await saveItem.flush(); return saveNote('auto'); });
  RT.claudeContext.register('library', () => {
    const it = current();
    if (!it) return { label: '', title: '', context: RT.state.sel ? { itemId: RT.state.sel } : {} };
    // what is on screen goes along with a question: the page of the PDF and the passage selected in it
    const page = pdfView ? pdfView.page() : null, sel = pdfView ? pdfView.selection() : null;
    return {
      label: `· ${it.citekey}`, title: `${it.fields.title || it.citekey} - Claude is told which paper this is, where its note, text and PDF are, the page you are on and what you selected in the PDF.`,
      context: { itemId: it.id, ...(page ? { page } : {}), ...(sel ? { selection: { kind: 'pdf', text: sel.text.slice(0, 4000), page: sel.page } } : {}) },
      dropSelection: () => { if (pdfView) pdfView.dropSelection(); },
    };
  });
  window.addEventListener('beforeunload', (e) => {
    if (pendingSave) saveItem.flush();
    savePosition(true);
    if (noteUnsaved()) {
      // a request too large for keepalive may be cut off by the unload: ask the user to stay until it is through
      const big = !fitsKeepalive(noteBody(note.ed.value(), false));
      flushNoteAway(true);
      if (big) { e.preventDefault(); e.returnValue = ''; }
    }
  });
  // the system's theme changed, or the one of Preferences (prefs.js emits theme:changed for both)
  const themeEditors = () => { for (const ed of [note.ed, tplEd]) if (ed) { try { ed.vd.setTheme(isDark() ? 'dark' : 'classic', isDark() ? 'dark' : 'light', isDark() ? 'github-dark' : 'github'); } catch (e) { console.error(e); } } };
  if (RT.prefs) RT.on('theme:changed', themeEditors);
  else if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeEditors);

  Object.assign(RT.reader, {
    open, close, current, render: renderDetail, canon,
    dirty: () => pendingSave || note.dirty || noteUnsaved(),
    insert: insertIntoNote, editor: () => note.ed, reveal,
    // keyboard and the palette (palette.js): show a tab of the open paper; page and zoom its PDF
    // (the tabs are hidden while the PDF is maximised or, in a narrow window, while the PDF side shows: bring them back)
    tab(t) {
      if (!current()) return false;
      const body = $('.rd-body', d);
      if (body && body.dataset.max === 'pdf') body.dataset.max = '';
      if (ls.get('rt.reader.narrow', 'work') === 'pdf') ls.set('rt.reader.narrow', 'work');
      applyLayout(); setTab(t); return true;
    },
    tabNow: () => (current() ? ($('.rd-tabs [data-tab].on', d) || { dataset: {} }).dataset.tab || null : null),
    pdfScroll: (dir) => !!(current() && pdfView && pdfView.scrollScreen(dir)),
    pdfZoom: (dir) => !!(current() && pdfView && pdfView.zoom(dir)),
    hasPdf: () => !!(current() && pdfView),
    // a page chip of an explanation (RT.cite): show that page of the open paper
    page(n) { if (!current()) return toast('Open the paper in the Library to see that page.', 'bad'); if (RT.state.view !== 'library') RT.setView('library'); showPage(n); }, saveNote: (source) => saveAll(source || 'manual'),
  });

  renderDetail();

  // At start: open the paper that was open when the app was left (on this browser), or else the one opened last.
  if (RT.library && RT.library.refresh) {
    RT.library.refresh().then(() => {
      if (cur || RT.state.sel) return;
      const last = ls.get('rt.reader.last', null);
      const it = last === null ? items().filter((i) => i.lastOpened).sort((a, b) => String(b.lastOpened).localeCompare(String(a.lastOpened)))[0] : items().find((i) => i.id === last);
      if (!it) return;
      resuming = it.id;
      RT.library.select(it.id);
    }).catch(() => { /* the list reports that it could not load */ });
  }
})();
