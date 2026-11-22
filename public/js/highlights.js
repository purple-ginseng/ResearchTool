/* Colour highlights on the PDF of a paper (reader.js, createPdfView) -> RT.highlights.
   The PDF file is never changed: a highlight is {page, text, colour, comment, rects} kept by the server in
   <workspace>/highlights/<id>.json (lib/routes/highlights.js) and drawn here as a layer between the page picture and
   its text layer, again every time a page is drawn. A rect is stored as parts (0..1) of the width and height of its
   page, so the marks stay on their text at every zoom. This module adds
     - the colour dots of the selection popover (RT.highlights.dots()) and add(): a highlight from the selection;
       "Quote in notes" and "Add as key point" call add() too, so the passage they took stays marked on the page
     - a card on a click on a highlight: change the colour, write a comment, go to the key point made from the same
       selection, quote it in the note, copy, remove
     - the list of all highlights of the paper (RT.highlights.control() is its toolbar button): click one to go there
     - a skim layer: the sentences of the key points are underlined on their pages (found in the text layer).
   RT.highlights.create(adapter) wires it to a viewer. */
RT.highlights = (() => {
  const { $, $$, esc, api, toast, ls, icon, debounce } = RT;
  const COLORS = ['yellow', 'green', 'blue', 'pink'];
  const ICON_MARKER = 'highlight';
  const DOCK_MIN = 480; // the list docks beside the pages when they keep at least this width, and lies over them otherwise
  const KIND = { mark: 'Highlight', quote: 'Quoted in the note', kp: 'Key point' };
  const lastColor = () => { const c = ls.get('rt.hl.color', 'yellow'); return COLORS.includes(c) ? c : 'yellow'; };

  // markup: the colour dots of the selection popover, and the toolbar button that opens the list
  const dots = () => COLORS.map((c) => `<button data-act="hl" data-color="${c}" class="ib hl-dot" title="Highlight in ${c} (stays on the page)" aria-label="Highlight in ${c}"><i class="hl-sw" data-color="${c}"></i></button>`).join('');
  const control = (p) => `<button id="${p}-hl" class="ib" title="Highlights: the passages you marked in this PDF, and the key points shown on the pages" aria-label="Highlights" aria-pressed="false">${icon(ICON_MARKER)}</button>`;

  /* adapter:
       id            item id                         pane       the PDF pane (position: relative)
       scroller      the scrolling element           pagesEl    the element that holds the pages
       pageEl(n)     element of page n or null       ready(n)   resolves when page n is drawn (canvas + text layer)
       passages(n, texts)   for a drawn page: a DOM Range (or null) for each text, found in its text layer
       remember()    note the place before a jump (Back)
       keypoints()   key points of the item [{id, text, page}]      openKeypoint(id)   show that key point
       quote(text, page)    put a quote into the note; true when it was inserted */
  function create(a) {
    const base = `/api/items/${a.id}/highlights`;
    let list = [], removed = 0, state = 'loading', error = '', dead = false;
    let tints = new Map();      // page -> [{kp, rects}] key point sentences found on a drawn page
    let showKps = ls.get('rt.hl.kps', '1') !== '0';
    let stale = false;          // a page could not be measured (the PDF pane was hidden): draw again when it shows
    // changes are sent one after the other, so their answers arrive in order and a late one never undoes a newer one
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    const btn = $('#pdf-hl', a.pane);

    const pop = document.createElement('div'); pop.className = 'hl-pop'; pop.hidden = true;
    const panel = document.createElement('div'); panel.className = 'hl-panel'; panel.hidden = true;
    panel.innerHTML = `<div class="pn-head"><b>Highlights</b><span class="muted hl-count"></span><span class="spacer"></span>
      <button class="ib hl-kps" aria-pressed="false">${icon('star')}</button>
      <button class="ib hl-restore" title="Put the highlight you removed last back on its page" aria-label="Restore the last removed highlight" hidden>${icon('undo')}</button>
      <button class="ib hl-close" title="Close this list (Esc)" aria-label="Close this list">${icon('close')}</button></div><div class="hl-list"></div>`;
    a.pane.append(panel, pop);
    const listEl = $('.hl-list', panel);

    // ---- geometry: the boxes of the text of a Range, per page, as parts of the page
    function rectsOf(range) {
      const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      if (!root) return [];
      const boxes = new Map(); // page element -> [{l, t, r, b}] in px of that page
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const sub = document.createRange();
      let seen = 0;
      const take = (node) => {
        const el = node.parentElement, layer = el && el.closest('.textLayer'), pageEl = layer && layer.closest('.rd-page');
        if (!pageEl || !a.pagesEl.contains(pageEl) || el.closest('.endOfContent')) return;
        const from = node === range.startContainer ? range.startOffset : 0, to = node === range.endContainer ? range.endOffset : node.data.length;
        if (to <= from || !node.data.slice(from, to).trim()) return;
        sub.setStart(node, from); sub.setEnd(node, to);
        const pr = pageEl.getBoundingClientRect();
        for (const r of sub.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          const l = Math.max(0, r.left - pr.left), t = Math.max(0, r.top - pr.top), rr = Math.min(pr.width, r.right - pr.left), b = Math.min(pr.height, r.bottom - pr.top);
          if (rr - l < 1 || b - t < 1) continue;
          if (!boxes.has(pageEl)) boxes.set(pageEl, []);
          boxes.get(pageEl).push({ l, t, r: rr, b });
        }
      };
      // walk the text from the start of the range to its end
      let node = range.startContainer.nodeType === 3 ? range.startContainer : null, started = false;
      tw.currentNode = range.startContainer;
      if (!node) node = tw.nextNode();
      for (; node && seen < 20000; node = tw.nextNode(), seen++) {
        if (!range.intersectsNode(node)) { if (started) break; continue; }
        started = true; take(node);
      }
      const out = [];
      for (const [pageEl, bs] of boxes) {
        const pr = pageEl.getBoundingClientRect(), p = Number(pageEl.dataset.page);
        // the pieces of one line become one box
        bs.sort((x, y) => (x.t + x.b) / 2 - (y.t + y.b) / 2 || x.l - y.l);
        const lines = [];
        for (const b of bs) {
          const h = b.b - b.t;
          const line = lines.find((m) => Math.min(m.b, b.b) - Math.max(m.t, b.t) > 0.5 * Math.min(h, m.b - m.t) && b.l <= m.r + 1.2 * h && b.r >= m.l - 1.2 * h);
          if (line) { line.l = Math.min(line.l, b.l); line.t = Math.min(line.t, b.t); line.r = Math.max(line.r, b.r); line.b = Math.max(line.b, b.b); }
          else lines.push({ ...b });
        }
        for (const m of lines) out.push([p, m.l / pr.width, m.t / pr.height, (m.r - m.l) / pr.width, (m.b - m.t) / pr.height]);
      }
      return out.sort((x, y) => x[0] - y[0] || x[2] - y[2] || x[1] - y[1]).slice(0, 600);
    }

    // ---- drawing
    const pct = (v) => (v * 100).toFixed(3) + '%';
    function group(cls, rects, n) {
      const g = document.createElement('div'); g.className = cls;
      for (const r of rects) { if (r[0] !== n) continue; const m = document.createElement('i'); Object.assign(m.style, { left: pct(r[1]), top: pct(r[2]), width: pct(r[3]), height: pct(r[4]) }); g.append(m); }
      return g;
    }
    // Draw the layer of page n again (the viewer calls this when it has drawn the page; also after every change).
    function draw(n) {
      if (dead) return;
      const el = a.pageEl(n), text = el && $('.textLayer', el);
      if (!el || !text) return; // not drawn (yet): the viewer calls again when it is
      if (!el.offsetWidth) { stale = true; return; } // the pane is hidden: the key points cannot be placed now
      const old = $('.hl-layer', el); if (old) old.remove();
      const layer = document.createElement('div'); layer.className = 'hl-layer';
      tints.delete(n);
      if (showKps) {
        const linked = new Set(list.filter((h) => h.kp).map((h) => h.kp));
        const kps = (a.keypoints() || []).filter((k) => k.id && Number(k.page) === n && k.text && !linked.has(k.id));
        if (kps.length) {
          let ranges = [];
          try { ranges = a.passages(n, kps.map((k) => k.text)) || []; } catch { ranges = []; }
          const found = [];
          kps.forEach((k, i) => {
            const rects = ranges[i] ? rectsOf(ranges[i]).filter((r) => r[0] === n) : [];
            if (!rects.length) return;
            found.push({ kp: k.id, rects });
            const g = group('hl-kp', rects, n); g.dataset.kp = k.id; layer.append(g);
          });
          if (found.length) tints.set(n, found);
        }
      }
      for (const h of list) {
        if (!h.rects.some((r) => r[0] === n)) continue;
        const g = group('hl-mark', h.rects, n); g.dataset.id = h.id; g.dataset.color = h.color;
        if (h.comment) g.classList.add('noted');
        layer.append(g);
      }
      el.insertBefore(layer, text);
    }
    function drawAll() { stale = false; for (const el of $$('.rd-page', a.pagesEl)) draw(Number(el.dataset.page)); }
    const drawSoon = debounce(drawAll, 60);
    const pagesOf = (h) => [...new Set(h.rects.map((r) => r[0]))];

    // ---- the list
    const snippet = (t, n = 150) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t);
    function paintKpsToggle() {
      const b = $('.hl-kps', panel), hint = showKps ? 'Key points are underlined on the pages - click to hide them' : 'Underline the key points of this paper on the pages';
      b.title = hint; b.setAttribute('aria-label', hint); b.setAttribute('aria-pressed', String(showKps)); b.classList.toggle('on', showKps);
    }
    function paintList() {
      $('.hl-count', panel).textContent = state === 'ok' && list.length ? String(list.length) : '';
      $('.hl-restore', panel).hidden = !(state === 'ok' && removed > 0);
      paintKpsToggle();
      if (panel.hidden) return;
      if (state === 'loading') { listEl.innerHTML = '<div class="pn-empty"><span class="spin"></span>Loading the highlights…</div>'; return; }
      if (state === 'error') { listEl.innerHTML = `<div class="pn-empty">The highlights could not be loaded: ${esc(error)}<br><button class="hl-retry">Try again</button></div>`; return; }
      if (!list.length) { listEl.innerHTML = '<div class="pn-empty">No highlights yet. Select text in the PDF and click a colour dot. A passage you quote in the note or add as a key point is highlighted too.</div>'; return; }
      listEl.innerHTML = list.map((h) => `<button class="pn-row hl-row" data-id="${esc(h.id)}" title="Go to this highlight on page ${esc(h.page)}">
        <i class="hl-sw" data-color="${esc(h.color)}"></i><span class="pn-pg">p. ${esc(h.page)}</span>
        <span class="pn-snip">${esc(snippet(h.text))}${h.kind !== 'mark' ? ` <span class="hl-kind">${esc(KIND[h.kind] || 'Highlight')}</span>` : ''}${h.comment ? `<span class="hl-note">${esc(snippet(h.comment, 220))}</span>` : ''}</span></button>`).join('');
    }
    // the list takes its place beside the pages when the pane is wide enough for both, and lies over them otherwise
    function place() {
      if (dead) return;
      const on = !panel.hidden;
      if (on) panel.style.top = a.scroller.offsetTop + 'px';
      const free = a.pane.clientWidth - (parseFloat(a.scroller.style.marginLeft) || 0);
      a.scroller.style.marginRight = on && free - panel.offsetWidth >= DOCK_MIN ? panel.offsetWidth + 'px' : '';
    }
    function setPanel(on) {
      panel.hidden = !on; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on));
      place();
      if (on) { paintList(); a.pane.dispatchEvent(new CustomEvent('rt:pdf-panel', { detail: { from: 'hl' } })); }
    }
    // the list of matches / contents of a narrow pane lies along the bottom, under this panel: one of the two at a time
    const onOtherPanel = (e) => { if (e.detail && e.detail.from === 'nav' && e.detail.bottom && !panel.hidden) setPanel(false); };
    a.pane.addEventListener('rt:pdf-panel', onOtherPanel);
    const docked = () => !!a.scroller.style.marginRight;
    const ro = window.ResizeObserver ? new ResizeObserver(() => { if (!panel.hidden) place(); if (stale && a.pane.offsetWidth) drawAll(); }) : null;
    if (ro) ro.observe(a.pane);
    function adopt(r) { list = r.highlights || []; removed = r.removed || 0; state = 'ok'; paintList(); drawAll(); }
    // after a change of one highlight (colour, comment): only its pages are drawn again
    function changed(r) { list = r.highlights || []; removed = r.removed || 0; paintList(); pagesOf(r.highlight).forEach(draw); }
    async function load() {
      state = 'loading'; paintList();
      try { const r = await api(base); if (!dead) adopt(r); }
      catch (e) { if (dead) return; state = 'error'; error = e.message; paintList(); }
    }

    // ---- go to a highlight and make it blink
    async function go(h) {
      const el = a.pageEl(h.page), r = h.rects.find((x) => x[0] === h.page) || h.rects[0];
      if (!el || !r) return;
      a.remember();
      if (!panel.hidden && !docked()) setPanel(false); // the list lies over the pages: get it out of the way of the mark
      a.scroller.scrollTop = Math.max(0, el.offsetTop + r[2] * el.offsetHeight - a.scroller.clientHeight / 3);
      await a.ready(h.page);
      if (dead) return;
      draw(h.page);
      const g = $$('.hl-mark', el).find((x) => x.dataset.id === h.id);
      if (g) { g.classList.remove('hl-blink'); void g.offsetWidth; g.classList.add('hl-blink'); setTimeout(() => g.classList.remove('hl-blink'), 1700); }
    }

    // ---- add a highlight from the current selection. `rects` may be given (taken before the selection was lost).
    function selection() {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return null;
      const rects = rectsOf(sel.getRangeAt(0));
      return rects.length ? rects : null;
    }
    async function add({ text, rects, color, kind, kp, quiet }) {
      rects = rects || selection();
      if (!rects) { if (!quiet) toast('That selection has no text that can be highlighted.', 'bad'); return null; }
      if (state !== 'ok') { if (!quiet) toast('The highlights of this paper are not loaded yet - try again in a moment.', 'bad'); return null; }
      const page = rects[0][0];
      const r = await serial(() => api(base, { method: 'POST', json: { page, text, rects, color: COLORS.includes(color) ? color : lastColor(), kind: kind || 'mark', kp } }));
      if (dead) return null;
      adopt(r);
      return r.highlight;
    }

    // ---- the card of one highlight (or of an underlined key point)
    let open = null; // {h} or {kp}
    // a comment is saved half a second after the last key, and at once when the card closes
    let cTimer = 0, cWait = null; // {id, value} typed and not sent yet
    function flushComment() {
      clearTimeout(cTimer);
      const w = cWait; cWait = null;
      if (!w) return;
      serial(() => api(`${base}/${w.id}`, { method: 'PUT', json: { comment: w.value } }))
        .then((r) => { if (dead) return; changed(r); if (open && open.h && open.h.id === w.id) open.h = r.highlight; })
        .catch((e) => toast('The comment could not be saved: ' + e.message, 'bad'));
    }
    function queueComment(id, value) { cWait = { id, value }; clearTimeout(cTimer); cTimer = setTimeout(flushComment, 500); }
    // drop = true: what was typed is not saved (the highlight is being removed)
    function hidePop(drop) {
      if (drop === true) { clearTimeout(cTimer); cWait = null; } else flushComment();
      if (pop.hidden) return;
      pop.hidden = true; open = null;
    }
    function showPop(what, x, y) {
      hidePop();
      open = what;
      const kps = a.keypoints() || [];
      if (what.h) {
        const h = what.h, kp = h.kp && kps.find((k) => k.id === h.kp);
        pop.innerHTML = `<div class="hl-pop-row">${COLORS.map((c) => `<button class="ib hl-dot${c === h.color ? ' on' : ''}" data-color="${c}" title="Make this highlight ${c}" aria-label="Make this highlight ${c}" aria-pressed="${c === h.color}"><i class="hl-sw" data-color="${c}"></i></button>`).join('')}
          <span class="spacer"></span>
          ${kp ? `<button class="ib" data-do="kp" title="Show the key point made from this passage" aria-label="Show the key point">${icon('star')}</button>` : ''}
          <button class="ib" data-do="quote" title="Quote this passage in the note, with its page number" aria-label="Quote in notes">${icon('quote')}</button>
          <button class="ib" data-do="copy" title="Copy the highlighted text" aria-label="Copy the highlighted text">${icon('copy')}</button>
          <button class="ib" data-do="del" title="Remove this highlight (it can be restored from the list of highlights)" aria-label="Remove this highlight">${icon('trash')}</button></div>
          <div class="hl-pop-text">${esc(snippet(h.text, 220))}</div>
          <textarea rows="2" placeholder="Comment…" aria-label="Comment on this highlight" maxlength="4000"></textarea>`;
        $('textarea', pop).value = h.comment || '';
      } else {
        const kp = kps.find((k) => k.id === what.kp);
        pop.innerHTML = `<div class="hl-pop-row"><b>Key point</b><span class="spacer"></span>
          <button class="ib" data-do="kp" title="Show this key point" aria-label="Show this key point">${icon('star')}</button></div>
          <div class="hl-pop-text">${esc(snippet(kp ? kp.text : '', 220))}</div>`;
      }
      pop.hidden = false;
      const hr = a.pane.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(x - hr.left - 20, hr.width - pop.offsetWidth - 6)) + 'px';
      pop.style.top = Math.max(6, Math.min(y - hr.top + 10, hr.height - pop.offsetHeight - 6)) + 'px';
    }
    pop.addEventListener('input', (e) => { if (e.target.matches('textarea') && open && open.h) queueComment(open.h.id, e.target.value); });
    pop.addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t || !open) return;
      const h = open.h;
      try {
        if (t.dataset.color && h) {
          ls.set('rt.hl.color', t.dataset.color);
          const r = await serial(() => api(`${base}/${h.id}`, { method: 'PUT', json: { color: t.dataset.color } }));
          if (dead) return;
          changed(r);
          if (open && open.h && open.h.id === h.id) { open.h = r.highlight; $$('.hl-dot', pop).forEach((b) => { const on = b.dataset.color === r.highlight.color; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); }
        } else if (t.dataset.do === 'kp') { const id = h ? h.kp : open.kp; hidePop(); a.openKeypoint(id); }
        else if (t.dataset.do === 'copy') { await navigator.clipboard.writeText(h.text); toast('Copied', 'ok'); hidePop(); }
        else if (t.dataset.do === 'quote') { hidePop(); a.quote(h.text, h.page); }
        else if (t.dataset.do === 'del') {
          hidePop(true);
          const r = await serial(() => api(`${base}/${h.id}`, { method: 'DELETE' }));
          if (dead) return;
          adopt(r);
          toast('Highlight removed. The arrow in the list of highlights puts it back.', 'ok');
        }
      } catch (err) { toast(err.message || String(err), 'bad'); }
    });

    // a click on a page (not the end of a selection, not a link): is there a highlight under the pointer?
    function hit(e) {
      const pageEl = e.target.closest && e.target.closest('.rd-page');
      if (!pageEl || e.target.closest('.pn-link')) return null;
      const pr = pageEl.getBoundingClientRect(), n = Number(pageEl.dataset.page);
      const x = (e.clientX - pr.left) / pr.width, y = (e.clientY - pr.top) / pr.height;
      const inside = (rects) => rects.some((r) => r[0] === n && x >= r[1] && x <= r[1] + r[3] && y >= r[2] && y <= r[2] + r[4]);
      for (let i = list.length - 1; i >= 0; i--) if (inside(list[i].rects)) return { h: list[i] };
      for (const t of tints.get(n) || []) if (inside(t.rects)) return { kp: t.kp };
      return null;
    }
    const onClick = (e) => {
      if (e.button !== 0 || a.pagesEl.classList.contains('snap')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const what = hit(e);
      if (what) showPop(what, e.clientX, e.clientY); else hidePop();
    };
    a.pagesEl.addEventListener('click', onClick);
    // the pointer shows that a highlight can be clicked
    let overRaf = 0;
    const onMove = (e) => { if (overRaf) return; overRaf = requestAnimationFrame(() => { overRaf = 0; if (!dead) a.pagesEl.classList.toggle('hl-over', !!hit(e)); }); };
    a.pagesEl.addEventListener('mousemove', onMove);
    const onScroll = () => hidePop();
    a.scroller.addEventListener('scroll', onScroll);
    const onDocDown = (e) => { if (!pop.hidden && !pop.contains(e.target)) hidePop(); };
    document.addEventListener('mousedown', onDocDown, true);
    const onKey = (e) => {
      if (e.key !== 'Escape' || !a.pane.offsetParent || document.querySelector('dialog[open]')) return; // not ours: the pane is hidden, or a dialog is open
      if (!pop.hidden) hidePop(); else if (!panel.hidden && (a.pane.contains(document.activeElement) || document.activeElement === document.body)) setPanel(false);
    };
    document.addEventListener('keydown', onKey);

    btn.addEventListener('click', () => setPanel(panel.hidden));
    panel.addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.classList.contains('hl-close')) return setPanel(false);
      if (t.classList.contains('hl-retry')) return load();
      if (t.classList.contains('hl-kps')) { showKps = !showKps; ls.set('rt.hl.kps', showKps ? '1' : '0'); paintKpsToggle(); drawAll(); return; }
      if (t.classList.contains('hl-restore')) {
        try { const r = await serial(() => api(`${base}/restore`, { method: 'POST' })); if (dead) return; adopt(r); toast('Highlight restored', 'ok'); go(r.highlight).catch(() => {}); }
        catch (err) { toast(err.message, 'bad'); }
        return;
      }
      const h = t.dataset.id && list.find((x) => x.id === t.dataset.id);
      if (h) go(h).catch(() => {});
    });

    load();
    return {
      draw, add, selection, redraw: drawSoon, hidePop: () => hidePop(),
      destroy() {
        hidePop(); dead = true; if (ro) ro.disconnect(); a.scroller.style.marginRight = '';
        a.pagesEl.removeEventListener('click', onClick); a.pagesEl.removeEventListener('mousemove', onMove); a.scroller.removeEventListener('scroll', onScroll);
        document.removeEventListener('mousedown', onDocDown, true); document.removeEventListener('keydown', onKey); a.pane.removeEventListener('rt:pdf-panel', onOtherPanel);
        panel.remove(); pop.remove();
      },
    };
  }

  return { create, dots, control, COLORS };
})();
