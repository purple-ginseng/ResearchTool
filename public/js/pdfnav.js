/* PDF navigation shared by the Library reader (reader.js, createPdfView) and the compiled-PDF preview of the Write
   tab (write.js) -> RT.pdfnav. A viewer keeps drawing its own pages (canvas + pdf.js text layer); this module adds
     - search over the whole document: matches marked in the text layers, a list of every match with its page and
       the words around it, Cmd/Ctrl+F, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G while the PDF pane has the focus
     - the links of the PDF (citations, figures, sections, web addresses) as transparent anchors over each page, with
       a small picture of the target while the pointer rests on an internal link
     - the table of contents of the PDF (pdf.getOutline) in a side panel
     - a Back button (Cmd/Ctrl+[ or Alt+Left) that returns to the place a jump started from.
   RT.pdfnav.controls(prefix, cls) is the markup of the toolbar controls, RT.pdfnav.create(adapter) wires them. */
RT.pdfnav = (() => {
  const { $, $$, esc, debounce, toast, icon } = RT;
  const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || '');
  const MOD = MAC ? '⌘' : 'Ctrl+';
  const MAX_ROWS = 400;   // matches listed in the panel
  const MAX_OUTLINE = 800; // entries of a table of contents
  const SIDE_MIN = 780;    // the panel docks beside the pages from this pane width on (the pages keep about 490 px), below them otherwise
  const JOIN = '\u0001';   // stands for a hyphen that only breaks a word at the end of a line

  // The toolbar controls: table of contents, Back, the Find box with its counter, previous / next match and the
  // list of matches. `p` prefixes the ids (they are unique across the page), `cls` is the button class of the bar.
  // controls() is all of them in one run; controls.nav() (contents, Back) and controls.find() (the Find box and its
  // buttons) are the same markup split for a toolbar that groups them (reader.js).
  const navControls = (p, cls = 'ib') => `<button id="${p}-outline" class="${cls}" title="Table of contents of the PDF" aria-label="Table of contents" aria-pressed="false">${icon('sidebar')}</button>
        <button id="${p}-back" class="${cls}" title="Back to where you were before the last jump (${MOD}[)" aria-label="Back to where you were" disabled>${icon('arrow-left')}</button>`;
  const findControls = (p, cls = 'ib') => `<span class="pn-find">${icon('search', 'pn-find-ic')}<input type="search" id="${p}-search" class="pn-search" placeholder="Find…" title="Find in the PDF (${MOD}F). Enter: next match, Shift+Enter: previous" aria-label="Find in the PDF"></span>
        <span id="${p}-hits" class="muted pn-hits" aria-live="polite"></span>
        <button id="${p}-hit-prev" class="${cls}" title="Previous match (Shift+Enter or Shift+${MOD}G)" aria-label="Previous match">${icon('chevron-up')}</button>
        <button id="${p}-hit-next" class="${cls}" title="Next match (Enter or ${MOD}G)" aria-label="Next match">${icon('chevron-down')}</button>
        <button id="${p}-hit-list" class="${cls}" title="List of all matches, with page and context" aria-label="List of matches" aria-pressed="false">${icon('list')}</button>`;
  function controls(p, cls = 'ib') { return `${navControls(p, cls)}
        ${findControls(p, cls)}`; }
  controls.nav = navControls;
  controls.find = findControls;

  // ---- text of a page as one searchable string
  const lowc = (c) => { const l = c.toLowerCase(); return l.length === 1 ? l : c; };
  const isLetter = (c) => /\p{L}/u.test(c);
  const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);
  const isLower = (c) => isLetter(c) && c === lowc(c) && c !== c.toUpperCase();
  // pieces: [{t, eol}] in reading order (the text items of pdf.js, or the spans of a drawn text layer - both give
  // the same string). Returns {text (lower case), orig, pi[], off[]}: character i of `text` is character off[i] of
  // piece pi[i] (-1: a space this function put between two lines). White space is collapsed; a word broken by a
  // hyphen at the end of a line keeps JOIN in place of the hyphen, which a search then treats as "maybe a hyphen".
  function model(pieces) {
    let orig = ''; const pi = [], off = [];
    const push = (ch, i, o) => { orig += ch; pi.push(i); off.push(o); };
    const pop = () => { orig = orig.slice(0, -1); pi.pop(); off.pop(); };
    let brk = false;
    pieces.forEach((p, i) => {
      const t = p.t || '';
      for (let o = 0; o < t.length; o++) {
        const ch = t[o];
        if (ch === '­') continue;
        if (/\s/.test(ch)) { if (!brk && orig && orig[orig.length - 1] !== ' ') push(' ', i, o); continue; }
        if (brk) {
          brk = false;
          let e = orig.length - 1;
          if (e >= 0 && orig[e] === ' ') e--;
          if (e >= 1 && (orig[e] === '-' || orig[e] === '‐') && isLetter(orig[e - 1]) && isLower(ch)) {
            const hi = pi[e], ho = off[e];
            while (orig.length > e) pop();
            push(JOIN, hi, ho);
          } else if (e >= 1 && (orig[e] === '-' || orig[e] === '‐') && isWordChar(orig[e - 1]) && isWordChar(ch)) {
            while (orig.length > e + 1) pop();           // "Vision-" + "Language", "GPT-" + "4": the hyphen is real, no space follows it
          } else if (orig && orig[orig.length - 1] !== ' ') push(' ', -1, 0);
        }
        push(ch, i, o);
      }
      if (p.eol) brk = true;
    });
    let text = '';
    for (let i = 0; i < orig.length; i++) text += lowc(orig[i]);
    return { text, orig, pi, off };
  }
  const cleanQuery = (q) => { let o = ''; for (const c of String(q || '').replace(/[­\u0001]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)) o += c.length === 1 ? lowc(c) : c; return o; };
  // the query as a pattern: a line-break hyphen may sit between any two letters, and stands for a typed hyphen
  function pattern(q) {
    const parts = [];
    for (let i = 0; i < q.length; i++) parts.push(q[i] === '-' ? `[-‐${JOIN}]` : q[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(parts.join(JOIN + '?'), 'g');
  }
  function findIn(m, re) {
    const out = []; re.lastIndex = 0;
    for (let x; (x = re.exec(m.text));) { if (!x[0].length) { re.lastIndex++; continue; } out.push([x.index, x.index + x[0].length]); }
    return out;
  }
  const plain = (s) => s.split(JOIN).join('');
  // hyphen: the query has a hyphen, so a line-break hyphen inside the match is a real one
  function snippet(m, a, b, hyphen) {
    let s = Math.max(0, a - 40), e = Math.min(m.orig.length, b + 70);
    if (s > 0) { const sp = m.orig.indexOf(' ', s); if (sp >= 0 && sp < a - 8) s = sp + 1; }
    if (e < m.orig.length) { const sp = m.orig.lastIndexOf(' ', e); if (sp > b + 8) e = sp; }
    return { before: (s > 0 ? '… ' : '') + plain(m.orig.slice(s, a)), hit: m.orig.slice(a, b).split(JOIN).join(hyphen ? '-' : ''), after: plain(m.orig.slice(b, e)) + (e < m.orig.length ? ' …' : '') };
  }

  /* adapter:
       prefix     id prefix of the controls (see controls())          pane      element that holds bar and pages
       scroller   the scrolling element; panels are put next to it     doc()     the open PDFDocumentProxy or null
       pages()    number of pages                                      pageEl(n) wrapper of page n (position: relative)
       top(n)     offsetTop of page n inside the scroller              scale()   CSS pixels per PDF point
       ready(n)   promise: page n is drawn, with its text layer        active()  the shortcuts may act (view showing)
     The viewer calls decorate(n, page) each time it has drawn a page, changed() when another document was loaded
     (a recompile) and destroy() when it goes away. */
  function create(a) {
    const scroller = a.scroller, pane = a.pane, holder = scroller.parentElement;
    const el = (k) => $(`#${a.prefix}-${k}`, pane);
    const input = el('search'), label = el('hits'), backBtn = el('back'), listBtn = el('hit-list'), outBtn = el('outline');
    const panel = document.createElement('div'); panel.className = 'pn-panel'; panel.hidden = true;
    panel.innerHTML = `<div class="pn-head"><b class="pn-title"></b><span class="muted pn-count"></span><span class="spacer"></span><button class="ib pn-close" title="Close this list (Esc)" aria-label="Close this list">${icon('close')}</button></div><div class="pn-list"></div>`;
    const peek = document.createElement('div'); peek.className = 'pn-peek'; peek.hidden = true;
    holder.append(panel, peek);
    const listEl = $('.pn-list', panel);
    let dead = false, mode = '';                       // mode: '' | 'hits' | 'outline' - what the panel shows
    let query = '', re = null, hits = [], hitAt = -1, searching = false, token = 0, noText = false;
    let models = null, modelsDoc = null, modelsJob = null;
    let outline = null, outlineDoc = null, outlineToken = 0;
    const stack = [];                                   // places to go back to: {page, y in points below the page top}
    const links = new WeakMap();                        // anchor -> link annotation
    const clampPage = (n) => Math.min(Math.max(1, Math.round(Number(n)) || 1), a.pages() || 1);
    const layerOf = (n) => { const p = a.pageEl(n); return p ? $('.textLayer', p) : null; };

    // ---- where the view is, jumps and the way back
    function where() {
      const P = a.pages(); if (!P || !scroller.clientHeight) return null;
      const y = scroller.scrollTop; let n = 1;
      for (let i = 1; i <= P; i++) { if (a.top(i) <= y + 1) n = i; else break; }
      return { page: n, y: (y - a.top(n)) / (a.scale() || 1) };
    }
    let target = null;
    let autoTop = -1;                                   // where the last step of a search left the view (see search())
    function paintBack() { backBtn.disabled = !stack.length; }
    function remember() {
      const w = where(); if (!w) return;
      const last = stack[stack.length - 1];
      if (last && last.page === w.page && Math.abs(last.y - w.y) < 24) return;
      stack.push(w); if (stack.length > 60) stack.shift();
      paintBack();
    }
    function back() {
      const w = stack.pop(); paintBack();
      if (!w || !a.pages()) return;
      scroller.scrollTop = a.top(clampPage(w.page)) + w.y * a.scale();
    }
    // go to page n, y points below its top (null: the top of the page), and show for a moment where that is
    function jump(n, y) {
      n = clampPage(n);
      const pageEl = a.pageEl(n); if (!pageEl) return;
      scroller.scrollTop = y == null ? a.top(n) - 6 : a.top(n) + Math.max(0, y * a.scale() - Math.min(90, scroller.clientHeight / 4));
      if (y == null) return;
      $$('.pn-target', scroller).forEach((x) => x.remove());
      const bar = document.createElement('div'); bar.className = 'pn-target';
      bar.style.top = Math.max(0, y * a.scale() - 3) + 'px';
      pageEl.append(bar);
      target = { n, bar };                              // decorate() puts it back when the page is drawn only now
      setTimeout(() => { bar.remove(); if (target && target.bar === bar) target = null; }, 2200);
    }
    // a destination of the PDF (a name or an explicit array) -> {page, x, y} in points from the top left, or null
    async function resolve(dest) {
      const doc = a.doc(); if (!doc || dest == null) return null;
      try {
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (!Array.isArray(dest) || !dest.length) return null;
        const ref = dest[0];
        const n = ref && typeof ref === 'object' ? (await doc.getPageIndex(ref)) + 1 : Number.isInteger(ref) ? ref + 1 : 0;
        if (!n || n > doc.numPages) return null;
        const kind = dest[1] && dest[1].name; let px = null, py = null;
        if (kind === 'XYZ') { px = dest[2]; py = dest[3]; }
        else if (kind === 'FitH' || kind === 'FitBH') py = dest[2];
        else if (kind === 'FitV' || kind === 'FitBV') px = dest[2];
        else if (kind === 'FitR') { px = dest[2]; py = dest[5]; }
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        px = num(px); py = num(py);
        if (px == null && py == null) return { page: n, x: null, y: null };
        const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
        const [x, y] = vp.convertToViewportPoint(px == null ? 0 : px, py == null ? 0 : py);
        return { page: n, x: px == null ? null : Math.min(Math.max(0, x), vp.width), y: py == null ? null : Math.min(Math.max(0, y), vp.height) };
      } catch { return null; }
    }
    async function follow(l, fromPage) {
      let t = null;
      if (l.dest != null) t = await resolve(l.dest);
      else if (l.action) {
        const P = a.pages();
        const n = { NextPage: fromPage + 1, PrevPage: fromPage - 1, FirstPage: 1, LastPage: P }[l.action];
        if (n) t = { page: clampPage(n), y: null };
      }
      if (dead) return;
      if (!t) return toast('This link points to a place that is not in the PDF.', 'bad');
      hidePeek(); remember(); jump(t.page, t.y);
    }

    // ---- links of a page (and the marks of a running search): the viewer calls this after drawing page n
    async function decorate(n, page) {
      const pageEl = a.pageEl(n); if (!pageEl || dead) return;
      markPage(n);
      if (target && target.n === n && !target.bar.isConnected) pageEl.append(target.bar);
      let annots;
      try { annots = await page.getAnnotations({ intent: 'display' }); } catch { return; }
      if (dead || a.pageEl(n) !== pageEl) return;
      $$('.pn-links', pageEl).forEach((x) => x.remove());
      const list = annots.filter((x) => x.subtype === 'Link' && Array.isArray(x.rect) && (x.url || x.dest != null || x.action));
      if (!list.length) return;
      const vp = page.getViewport({ scale: 1 });
      const box = document.createElement('div'); box.className = 'pn-links';
      for (const l of list) {
        const r = vp.convertToViewportRectangle(l.rect);
        const x1 = Math.min(r[0], r[2]), x2 = Math.max(r[0], r[2]), y1 = Math.min(r[1], r[3]), y2 = Math.max(r[1], r[3]);
        if (!(x2 - x1 > 0.5) || !(y2 - y1 > 0.5)) continue;
        const k = document.createElement('a'); k.className = 'pn-link'; k.dataset.page = n;
        const web = typeof l.url === 'string' && /^(https?:|mailto:)/i.test(l.url);
        if (web) { k.href = l.url; k.target = '_blank'; k.rel = 'noopener noreferrer'; k.title = l.url.slice(0, 300); k.classList.add('ext'); }
        else if (l.url) continue; // some other kind of address: not followed
        else { k.href = '#'; k.setAttribute('aria-label', 'Link to another place in this PDF'); }
        Object.assign(k.style, { left: (100 * x1 / vp.width) + '%', top: (100 * y1 / vp.height) + '%', width: (100 * (x2 - x1) / vp.width) + '%', height: (100 * (y2 - y1) / vp.height) + '%' });
        links.set(k, l); box.append(k);
      }
      if (box.firstChild) pageEl.append(box);
    }
    scroller.addEventListener('click', (e) => {
      const k = e.target.closest && e.target.closest('a.pn-link'); if (!k) return;
      const l = links.get(k);
      if (!l) return e.preventDefault();
      if (k.classList.contains('ext')) return;         // a web address: the browser opens it in a new tab
      e.preventDefault();
      follow(l, Number(k.dataset.page)).catch(() => {});
    });

    // ---- a small picture of the place an internal link points to, while the pointer rests on the link
    let peekTimer = 0, peekToken = 0, peekTask = null;
    function hidePeek() {
      clearTimeout(peekTimer); peekToken++;
      if (peekTask) { try { peekTask.cancel(); } catch { /* done */ } peekTask = null; }
      if (!peek.hidden) { peek.hidden = true; peek.replaceChildren(); }
    }
    async function showPeek(k) {
      const l = links.get(k), my = ++peekToken;
      if (!l || l.dest == null) return;
      const t = await resolve(l.dest);
      const doc = a.doc();
      if (dead || my !== peekToken || !t || !doc || !k.isConnected) return;
      const page = await doc.getPage(t.page);
      if (dead || my !== peekToken) return;
      const v1 = page.getViewport({ scale: 1 });
      const W = Math.min(v1.width, 440), H = Math.min(v1.height, 210);
      const x0 = Math.min(Math.max(0, (t.x == null ? 0 : t.x) - 16), v1.width - W), y0 = Math.min(Math.max(0, (t.y == null ? 0 : t.y) - 12), v1.height - H);
      const css = Math.min(1.1, Math.max(0.5, (holder.clientWidth - 30) / W)), r = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(W * css * r); canvas.height = Math.floor(H * css * r);
      canvas.style.width = Math.floor(W * css) + 'px'; canvas.style.height = Math.floor(H * css) + 'px';
      const vp = page.getViewport({ scale: css * r, offsetX: -x0 * css * r, offsetY: -y0 * css * r });
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      peekTask = task;
      try { await task.promise; } catch { return; } finally { if (peekTask === task) peekTask = null; }
      if (dead || my !== peekToken || !k.isConnected) return;
      const cap = document.createElement('div'); cap.className = 'pn-peek-cap'; cap.textContent = `Page ${t.page} — click to go there`;
      peek.replaceChildren(canvas, cap); peek.hidden = false;
      const hr = holder.getBoundingClientRect(), kr = k.getBoundingClientRect();
      const w = peek.offsetWidth, h = peek.offsetHeight;
      peek.style.left = Math.max(6, Math.min(kr.left - hr.left - 20, hr.width - w - 6)) + 'px';
      const below = kr.bottom - hr.top + 8;
      peek.style.top = (below + h <= hr.height - 4 || kr.top - hr.top - h - 8 < 0 ? below : kr.top - hr.top - h - 8) + 'px';
    }
    scroller.addEventListener('mouseover', (e) => {
      const k = e.target.closest && e.target.closest('a.pn-link'); if (!k || k.classList.contains('ext')) return;
      clearTimeout(peekTimer);
      peekTimer = setTimeout(() => { showPeek(k).catch(() => {}); }, 350);
    });
    scroller.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('a.pn-link')) hidePeek(); });

    // ---- search
    async function pageModels() {
      const doc = a.doc();
      if (models && modelsDoc === doc) return models;
      if (modelsJob && modelsJob.doc === doc) return modelsJob.p;
      const p = (async () => {
        const out = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const tc = await (await doc.getPage(n)).getTextContent();
          out.push(model(tc.items.filter((i) => i.str !== undefined).map((i) => ({ t: i.str, eol: i.hasEOL }))));
        }
        if (a.doc() === doc) { models = out; modelsDoc = doc; }
        return out;
      })();
      modelsJob = { doc, p };
      p.catch(() => {}).finally(() => { if (modelsJob && modelsJob.p === p) modelsJob = null; });
      return p;
    }
    function paintLabel() {
      label.textContent = searching ? 'Searching…' : !query || !a.doc() ? '' : !hits.length ? 'No matches' : hitAt >= 0 ? `${hitAt + 1} / ${hits.length}` : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`;
    }
    // jumpTo: go to the first match at or after the page that shows (a new search); false: only count and mark
    // (the document was compiled again - the view stays where it is)
    async function search(q, jumpTo = true) {
      const my = ++token;
      query = cleanQuery(q); re = query ? pattern(query) : null; hits = []; hitAt = -1; noText = false;
      const doc = a.doc();
      if (!query || !doc) { searching = false; paintLabel(); markAll(); if (mode === 'hits') renderHits(); return; }
      searching = true; paintLabel(); if (mode === 'hits') renderHits();
      let ms;
      try { ms = await pageModels(); }
      catch (e) { if (my === token && !dead) { searching = false; query = ''; re = null; paintLabel(); if (mode === 'hits') renderHits(); toast('Could not read the text of the PDF: ' + (e && e.message || e), 'bad'); } return; }
      if (my !== token || dead) return;
      searching = false;
      noText = !ms.some((m) => m.text.length);
      ms.forEach((m, i) => findIn(m, re).forEach(([s, e], k) => hits.push({ page: i + 1, k, a: s, b: e })));
      markAll(); paintLabel();
      if (mode === 'hits') renderHits();
      if (!hits.length || !jumpTo) return;
      const w = where(), p = w ? w.page : 1;
      const first = hits.findIndex((h) => h.page >= p);
      // one way back per search, not one per pause while typing: the place is kept only if the reader moved the
      // view since the last match was shown
      if (Math.abs(scroller.scrollTop - autoTop) > 2) remember();
      await goHit(first < 0 ? 0 : first);
    }
    // wrap the matches inside the drawn text layer of page n in <mark class="pn-hit" data-hit="k">
    function markPage(n) {
      const layer = layerOf(n); if (!layer) return;
      const parts = [];
      for (const node of layer.querySelectorAll('span, br')) {
        if (node.tagName === 'BR') { parts.push({ t: '', eol: true, node: null }); continue; }
        if (node.querySelector('span')) continue;        // a marked-content wrapper, not a text run
        const t = node.textContent;                      // also drops the marks of an earlier search
        if (node.firstElementChild) node.textContent = t;
        parts.push({ t, eol: false, node, cuts: [] });
      }
      if (!re) return;
      const m = model(parts);
      findIn(m, re).forEach(([s, e], k) => {
        let cur = null;
        for (let i = s; i < e; i++) {
          const p = m.pi[i]; if (p < 0) continue;
          if (cur && cur.p === p) cur.b = m.off[i] + 1;
          else { cur = { p, a: m.off[i], b: m.off[i] + 1 }; parts[p].cuts.push([cur, k]); }
        }
      });
      for (const p of parts) {
        if (!p.node || !p.cuts.length) continue;
        const t = p.t; let html = '', at = 0;
        for (const [c, k] of p.cuts) { if (c.a < at) continue; html += esc(t.slice(at, c.a)) + `<mark class="pn-hit" data-hit="${k}">${esc(t.slice(c.a, c.b))}</mark>`; at = c.b; }
        p.node.innerHTML = html + esc(t.slice(at));
      }
      const h = hits[hitAt];
      if (h && h.page === n) $$(`.pn-hit[data-hit="${h.k}"]`, layer).forEach((x) => x.classList.add('cur'));
    }
    function markAll() { for (let n = 1, P = a.pages(); n <= P; n++) markPage(n); }
    async function goHit(i) {
      if (!hits.length) return;
      hitAt = ((i % hits.length) + hits.length) % hits.length;
      const h = hits[hitAt], my = token;
      paintLabel(); paintCurRow();
      if (!layerOf(h.page)) scroller.scrollTop = a.top(h.page) - 6;
      autoTop = scroller.scrollTop;
      try { await a.ready(h.page); } catch { /* the page is shown without the mark */ }
      if (dead || my !== token || hits[hitAt] !== h) return;
      $$('.pn-hit.cur', scroller).forEach((x) => x.classList.remove('cur'));
      const pageEl = a.pageEl(h.page);
      const marks = pageEl ? $$(`.pn-hit[data-hit="${h.k}"]`, pageEl) : [];
      marks.forEach((x) => x.classList.add('cur'));
      if (marks[0]) {
        const r = marks[0].getBoundingClientRect(), sr = scroller.getBoundingClientRect();
        if (r.top < sr.top + 30 || r.bottom > sr.bottom - 30) scroller.scrollTop += r.top - sr.top - scroller.clientHeight / 3;
      } else scroller.scrollTop = a.top(h.page) - 6;
      autoTop = scroller.scrollTop;
    }
    const step = (d) => { if (hits.length) goHit(hitAt < 0 && d < 0 ? hits.length - 1 : hitAt + d).catch(() => {}); };

    // ---- the side panel: the list of matches or the table of contents
    // the panel takes its place beside the pages when the pane is wide enough for both, below them otherwise
    function place() {
      const wide = holder.clientWidth >= SIDE_MIN;
      panel.classList.toggle('pn-bottom', !wide);
      panel.style.top = wide ? scroller.offsetTop + 'px' : '';
      scroller.style.marginLeft = mode && wide ? panel.offsetWidth + 'px' : '';
      scroller.style.marginBottom = mode && !wide ? panel.offsetHeight + 'px' : '';
    }
    function setMode(m) {
      mode = m; panel.hidden = !m;
      listBtn.classList.toggle('on', m === 'hits'); listBtn.setAttribute('aria-pressed', String(m === 'hits'));
      outBtn.classList.toggle('on', m === 'outline'); outBtn.setAttribute('aria-pressed', String(m === 'outline'));
      place();
      if (!m) return;
      // in a narrow pane this list lies along the bottom, where another panel of the pane (the highlights) would cover it
      pane.dispatchEvent(new CustomEvent('rt:pdf-panel', { detail: { from: 'nav', bottom: panel.classList.contains('pn-bottom') } }));
      if (m === 'hits') renderHits(); else renderOutline();
    }
    const onOtherPanel = (e) => { if (e.detail && e.detail.from !== 'nav' && mode && panel.classList.contains('pn-bottom')) setMode(''); };
    pane.addEventListener('rt:pdf-panel', onOtherPanel);
    function head(title, count) { $('.pn-title', panel).textContent = title; $('.pn-count', panel).textContent = count; }
    const note = (html) => { listEl.innerHTML = `<div class="pn-empty">${html}</div>`; };
    function renderHits() {
      head('Matches', hits.length ? String(hits.length) : '');
      if (searching) return note('<span class="spin"></span> Searching the whole PDF…');
      if (!a.doc()) return note('There is no PDF to search yet.');
      if (!query) return note(`Type in the Find box (${MOD}F) to search the whole PDF. Every match is listed here with its page.`);
      if (!hits.length) return note(noText ? 'This PDF has no text to search (it looks like a scan).' : `No matches for “${esc(query)}”.`);
      const rows = hits.slice(0, MAX_ROWS).map((h, i) => {
        const s = snippet(models[h.page - 1], h.a, h.b, query.includes('-'));
        return `<button class="pn-row${i === hitAt ? ' cur' : ''}" data-hit="${i}"><span class="pn-pg">p. ${h.page}</span><span class="pn-snip">${esc(s.before)}<b>${esc(s.hit)}</b>${esc(s.after)}</span></button>`;
      });
      listEl.innerHTML = rows.join('') + (hits.length > MAX_ROWS ? `<div class="pn-empty">Only the first ${MAX_ROWS} of ${hits.length} matches are listed. The arrows still step through all of them.</div>` : '');
      paintCurRow();
    }
    function paintCurRow() {
      if (mode !== 'hits') return;
      $$('.pn-row.cur', listEl).forEach((x) => x.classList.remove('cur'));
      const row = $(`.pn-row[data-hit="${hitAt}"]`, listEl);
      if (row) { row.classList.add('cur'); row.scrollIntoView({ block: 'nearest' }); }
    }
    async function loadOutline() {
      const doc = a.doc();
      if (outline && outlineDoc === doc) return outline;
      const tree = await doc.getOutline();
      const flat = [];
      const walk = (items, depth) => { for (const it of items || []) { if (flat.length >= MAX_OUTLINE) return; flat.push({ title: String(it.title || '').replace(/\s+/g, ' ').trim() || 'Untitled', depth, dest: it.dest, url: it.url, bold: !!it.bold }); walk(it.items, depth + 1); } };
      walk(tree, 0);
      for (const it of flat) { if (it.dest != null) it.at = await resolve(it.dest); if (a.doc() !== doc) break; }
      if (a.doc() === doc) { outline = flat; outlineDoc = doc; }
      return flat;
    }
    async function renderOutline() {
      const my = ++outlineToken;
      head('Contents', '');
      if (!a.doc()) return note('There is no PDF yet.');
      if (!(outline && outlineDoc === a.doc())) note('<span class="spin"></span> Reading the table of contents…');
      let flat;
      try { flat = await loadOutline(); }
      catch (e) { if (my === outlineToken && mode === 'outline') note('Could not read the table of contents: ' + esc(e && e.message || String(e))); return; }
      if (dead || my !== outlineToken || mode !== 'outline') return;
      if (!flat.length) return note('This PDF has no table of contents. Use the page box or Find to move around.');
      listEl.replaceChildren(...flat.map((it, i) => {
        const b = document.createElement('button'); b.className = 'pn-row pn-ol' + (it.bold || !it.depth ? ' top' : ''); b.dataset.ol = i;
        b.style.paddingLeft = 8 + Math.min(it.depth, 6) * 14 + 'px';
        const t = document.createElement('span'); t.className = 'pn-snip'; t.textContent = it.title;
        const p = document.createElement('span'); p.className = 'pn-pg'; p.textContent = it.at ? it.at.page : it.url ? 'web' : '';
        b.append(t, p);
        if (!it.at && !it.url) { b.disabled = true; b.title = 'This entry does not point to a place in the PDF'; }
        return b;
      }));
      paintSection();
    }
    // light up the entry of the section that shows
    function paintSection() {
      if (mode !== 'outline' || !outline || outlineDoc !== a.doc()) return;
      const w = where(); if (!w) return;
      const y = w.y + scroller.clientHeight / 3 / (a.scale() || 1);
      let cur = -1;
      outline.forEach((it, i) => { if (it.at && (it.at.page < w.page || (it.at.page === w.page && (it.at.y == null ? 0 : it.at.y) <= y))) cur = i; });
      const old = $('.pn-row.cur', listEl), row = cur < 0 ? null : $(`.pn-row[data-ol="${cur}"]`, listEl);
      if (old === row) return;
      if (old) old.classList.remove('cur');
      if (row) { row.classList.add('cur'); row.scrollIntoView({ block: 'nearest' }); }
    }
    const sectionSoon = debounce(paintSection, 150);
    scroller.addEventListener('scroll', () => { hidePeek(); if (mode === 'outline') sectionSoon(); });
    panel.addEventListener('click', (e) => {
      if (e.target.closest('.pn-close')) return setMode('');
      const row = e.target.closest('.pn-row'); if (!row) return;
      if (row.dataset.hit != null) { remember(); goHit(Number(row.dataset.hit)).catch(() => {}); return; }
      const it = outline && outline[Number(row.dataset.ol)]; if (!it) return;
      if (it.at) { remember(); jump(it.at.page, it.at.y); }
      else if (typeof it.url === 'string' && /^https?:/i.test(it.url)) window.open(it.url, '_blank', 'noopener,noreferrer');
    });
    const ro = window.ResizeObserver ? new ResizeObserver(() => { if (mode) place(); }) : null;
    if (ro) ro.observe(scroller);

    // ---- controls and keys
    const searchSoon = debounce((v) => { search(v).catch(() => {}); }, 300);
    function focusSearch() {
      input.focus(); input.select();
      if (!mode && (query || input.value.trim())) setMode('hits');
    }
    function clearSearch() { input.value = ''; searchSoon.flush(''); if (mode === 'hits') setMode(''); }
    input.addEventListener('input', () => { if (input.value.trim() && mode !== 'hits') setMode('hits'); searchSoon(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (cleanQuery(input.value) !== query) searchSoon.flush(input.value); else if (!searching) step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); clearSearch(); scroller.focus({ preventScroll: true }); }
    });
    const onClick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b === el('hit-next')) step(1);
      else if (b === el('hit-prev')) step(-1);
      else if (b === listBtn) setMode(mode === 'hits' ? '' : 'hits');
      else if (b === outBtn) setMode(mode === 'outline' ? '' : 'outline');
      else if (b === backBtn) back();
    };
    pane.addEventListener('click', onClick);
    const onKey = (e) => {
      if (dead || !a.active() || !pane.offsetParent || document.querySelector('dialog[open]')) return;
      const f = document.activeElement;
      if (!(pane.contains(f) || !f || f === document.body)) return; // the keys belong to the PDF pane while it has the focus (or nothing has)
      const mod = (MAC ? e.metaKey : e.ctrlKey) && !e.altKey, k = String(e.key).toLowerCase();
      const typing = !!f && f !== document.body && (/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) || f.isContentEditable);
      if (mod && !e.shiftKey && k === 'f') { e.preventDefault(); e.stopPropagation(); focusSearch(); }
      else if (mod && k === 'g') { e.preventDefault(); e.stopPropagation(); if (hits.length) step(e.shiftKey ? -1 : 1); else focusSearch(); }
      // Cmd/Ctrl+[ never reaches the browser here (there it would leave the app); Alt+Left stays a text key in a box
      else if (mod && !e.shiftKey && e.key === '[') { e.preventDefault(); e.stopPropagation(); back(); }
      else if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'ArrowLeft' && !typing) { if (stack.length) { e.preventDefault(); e.stopPropagation(); back(); } }
      else if (e.key === 'Escape' && mode && f !== input && !e.defaultPrevented) { e.preventDefault(); setMode(''); } // one Esc, one thing closed
    };
    document.addEventListener('keydown', onKey, true);

    return {
      decorate, remember, focusSearch,
      // another document is shown in the same view (the Write preview after a compile): the back stack stays, the
      // search is run again without moving, the table of contents is read again
      changed() {
        models = null; modelsDoc = null; outline = null; outlineDoc = null; hidePeek();
        if (query) search(query, false).catch(() => {}); else if (mode === 'hits') renderHits();
        if (mode === 'outline') renderOutline();
      },
      // no document any more
      reset() {
        token++; outlineToken++; models = null; modelsDoc = null; outline = null; outlineDoc = null; hits = []; hitAt = -1; searching = false;
        stack.length = 0; paintBack(); hidePeek(); label.textContent = '';
        if (mode) setMode('');
      },
      destroy() {
        dead = true; token++; hidePeek(); if (ro) ro.disconnect();
        document.removeEventListener('keydown', onKey, true); pane.removeEventListener('click', onClick); pane.removeEventListener('rt:pdf-panel', onOtherPanel);
        panel.remove(); peek.remove(); scroller.style.marginLeft = ''; scroller.style.marginBottom = '';
      },
    };
  }

  return { controls, create };
})();
