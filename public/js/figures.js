/* Figures and tables of a paper, found by the server from the layout of the PDF (lib/figures.js - no AI call).
   RT.figures.list(id, {refresh})            -> Promise<{available, figures: [{key, kind, label, page, caption, box, confidence}], reason?, message?}>
   RT.figures.url(id, key, thumb)            -> address of the cropped picture (PNG)
   RT.figures.insertMarkdown(id, key, opts)  -> Promise<Markdown>: stores the crop with the note of the paper and returns
                                                the picture + caption line + page link, ready to insert ({language, desc})
   RT.figures.place(id, {baseHash, language, keys}) -> fills the "> 📷 ..." placeholders of the saved note (server side)
   RT.figures.match(id, page, region)        -> Promise<figure | null>: the figure / table a region of a page shows (region
                                                {x, y, w, h} as fractions of the page) - never waits long, never rejects
   RT.figures.markdown(f, url, opts)         -> the Markdown of figure f stored at url (the form the server writes)
   RT.figures.countPlaceholders(markdown)    -> number of "> 📷 ..." placeholder lines
   RT.figures.open(pop, opts) / close(pop)   -> the picker: thumbnails of the figures and tables; a click inserts one,
                                                "Place the figures in this note" fills the placeholders.
     opts: {item, button, language() -> 'zh' | 'en', insert(markdown) -> true when inserted, place() -> Promise, placeholders() -> number,
            canInsert() -> true, or the reason (text) why nothing can be inserted right now}
   Any module may use list / url / insertMarkdown; the reader (reader.js) owns the picker of the notes toolbar.
   Data: GET /api/items/:id/figures, GET .../figures/<key>.png[?thumb=1], POST .../figures/<key>/asset, POST /api/items/:id/note/figures. */
(() => {
  const { $, $$, esc, api, toast } = RT;
  RT.figures = RT.figures || {};
  const ICON = 'figure';
  const cache = new Map(); // item id -> Promise of the list

  function list(id, { refresh = false } = {}) {
    if (refresh || !cache.has(id)) {
      const p = api(`/api/items/${id}/figures${refresh ? '?refresh=1' : ''}`).catch((e) => ({ available: false, reason: 'failed', message: e.message, figures: [] }));
      cache.set(id, p);
      p.then((r) => { if (!r.available && cache.get(id) === p) cache.delete(id); }); // ask again next time (the PDF may be attached by then)
    }
    return cache.get(id);
  }
  const url = (id, key, thumb = false) => `/api/items/${id}/figures/${encodeURIComponent(key)}.png${thumb ? '?thumb=1' : ''}`;
  async function insertMarkdown(id, key, { language = 'zh', desc = '' } = {}) {
    const r = await api(`/api/items/${id}/figures/${encodeURIComponent(key)}/asset`, { method: 'POST', json: { language, desc } });
    return r.markdown;
  }
  const place = (id, { baseHash = null, language = 'zh', keys = null } = {}) => api(`/api/items/${id}/note/figures`, { method: 'POST', json: { baseHash, language, ...(keys ? { keys } : {}) } });
  const invalidate = (id) => { cache.delete(id); };
  // one test for a placeholder line, shared with the reader (the server has the same in lib/figures.js)
  const PLACEHOLDER_RE = /^[ \t]{0,3}>[ \t]*📷/gmu;
  const countPlaceholders = (md) => (String(md || '').match(PLACEHOLDER_RE) || []).length;
  // exactly what lib/figures.js figureMarkdown() and reader.js pageLink() write
  function markdown(f, src, { language = 'zh', desc = '' } = {}) {
    const d = String(desc || '').replace(/\s+/g, ' ').trim();
    return `![${f.label}](${src}${f.w ? '#w=' + f.w : ''})\n${f.label}${d ? (language === 'en' ? ': ' : '：') + d : ''} [p. ${Number(f.page)}](#rt-page=${Number(f.page)})`;
  }
  // The figure a hand-made snapshot shows: the one on that page whose box and the captured region cover each other
  // for the most part. Only a list that arrives within a moment is used - a snapshot never waits for an analysis.
  async function match(id, page, region) {
    try {
      if (!region || !(region.w > 0 && region.h > 0)) return null;
      const r = await Promise.race([list(id), new Promise((ok) => setTimeout(() => ok(null), 700))]);
      if (!r || !r.available) return null;
      let best = null, top = 0.5;
      for (const f of r.figures) {
        if (f.page !== page || !f.pageW || !f.pageH) continue;
        const b = { x: f.box.x / f.pageW, y: f.box.y / f.pageH, w: f.box.w / f.pageW, h: f.box.h / f.pageH };
        const ox = Math.min(b.x + b.w, region.x + region.w) - Math.max(b.x, region.x), oy = Math.min(b.y + b.h, region.y + region.h) - Math.max(b.y, region.y);
        if (ox <= 0 || oy <= 0) continue;
        const iou = ox * oy / (b.w * b.h + region.w * region.h - ox * oy);
        if (iou > top) { top = iou; best = f; }
      }
      return best;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- the picker
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const captionBody = (f) => f.caption.replace(/^\s*(Figure|Fig\.?|FIGURE|FIG\.?|Table|TABLE|Tab\.|图|表)\s*[A-Z]?[\dIVXL]+\s*[:.|：．。—–-]?\s*/, '');
  const unsureOf = (f) => f.placeable === false; // found, but the crop failed a check: shown, never placed unasked
  function close(pop) {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (pop._btn) pop._btn.setAttribute('aria-expanded', 'false');
  }
  async function open(pop, opts) {
    const it = opts.item, token = (pop._token = (pop._token || 0) + 1);
    pop._btn = opts.button || null;
    pop.hidden = false;
    if (pop._btn) pop._btn.setAttribute('aria-expanded', 'true');
    // keep the panel inside the window (it hangs below the toolbar button, which may sit near the right edge)
    const fit = () => { pop.style.left = ''; const over = pop.getBoundingClientRect().right - (window.innerWidth - 10); if (over > 0) pop.style.left = -Math.round(over) + 'px'; };
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Figures and tables of the paper');
    const waiting = opts.placeholders ? opts.placeholders() : 0;
    pop.innerHTML = `
      <div class="fg-head"><b>Figures and tables</b><span class="muted" id="fg-count"></span><span class="spacer"></span>
        <button class="ib fg-refresh" title="Look again: read the figures from the PDF once more" aria-label="Look for the figures again">${RT.icon('refresh')}</button>
        <button class="ib fg-close" title="Close (Esc)" aria-label="Close">${RT.icon('close')}</button></div>
      <button class="fg-place" ${waiting ? '' : 'disabled'} title="Replace every 📷 placeholder of this note whose figure or table was found in the PDF with the picture cut out of the page">${RT.icon(ICON)}<span>Place the figures in this note</span><span class="muted">${waiting ? `${waiting} 📷 placeholder${waiting === 1 ? '' : 's'}` : 'no 📷 placeholder in the note'}</span></button>
      <div class="fg-list" role="listbox" aria-label="Figures and tables found in the PDF"><div class="empty fg-state"><span class="spin"></span> Looking for the figures in the PDF…</div></div>
      <div class="fg-foot muted">Click a picture to put it into the note at the cursor. Found from the layout of the PDF, without Claude.</div>`;
    fit();
    const listEl = $('.fg-list', pop);
    const state = (html) => { listEl.innerHTML = `<div class="empty fg-state">${html}</div>`; };
    const load = async (refresh) => {
      const r = await list(it.id, { refresh });
      if (pop._token !== token || pop.hidden) return;
      if (!r.available) {
        $('#fg-count', pop).textContent = '';
        return state(r.reason === 'no-pdf' ? 'This reference has no PDF. Attach the PDF first - the figures are cut out of it.'
          : r.reason === 'no-poppler' ? 'Figures cannot be found on this computer: the poppler tools (pdftotext, pdftoppm) are not installed. <span class="muted">Install them (macOS: <code>brew install poppler</code>) or use the snapshot tool of the PDF viewer.</span>'
            : 'The figures could not be read from this PDF. ' + esc(r.message || ''));
      }
      if (!r.figures.length) { $('#fg-count', pop).textContent = ''; return state('No figure or table caption was found in this PDF. Use the snapshot tool (the camera above the PDF) to cut a region out by hand.'); }
      const nf = r.figures.filter((f) => f.kind === 'figure').length, nt = r.figures.length - nf;
      const pf = nf === 1 ? '' : 's', pt = nt === 1 ? '' : 's'; // one text per case: the dictionary translates it whole
      $('#fg-count', pop).textContent = nf && nt ? `${nf} figure${pf}, ${nt} table${pt}` : nf ? `${nf} figure${pf}` : nt ? `${nt} table${pt}` : '';
      listEl.innerHTML = r.figures.map((f) => {
        const body = captionBody(f), unsure = unsureOf(f);
        return `<button class="fg-item${unsure ? ' unsure' : ''}" role="option" data-key="${esc(f.key)}" title="${esc(`Insert ${f.label} (p. ${f.page}) into the note${unsure ? ` - the crop is uncertain${f.why && f.why[0] ? ' (' + f.why[0] + ')' : ''}: check it. It is not placed automatically` : ''}\n\n${f.caption}`)}" aria-label="${esc(`Insert ${f.label}, page ${f.page}: ${clip(body, 120)}`)}">
          <span class="fg-thumb"><img loading="lazy" alt="" src="${esc(url(it.id, f.key, true))}"></span>
          <span class="fg-meta"><b>${esc(f.label)}</b><span class="muted">p. ${Number(f.page)}${unsure ? ' · check the crop' : ''}</span></span>
          <span class="fg-cap">${esc(clip(body, 110))}</span></button>`;
      }).join('');
    };
    pop.onclick = async (e) => {
      const t = e.target.closest('button'); if (!t || !pop.contains(t)) return;
      if (t.classList.contains('fg-close')) { close(pop); if (pop._btn) pop._btn.focus(); return; }
      if (t.classList.contains('fg-refresh')) { state('<span class="spin"></span> Looking for the figures in the PDF…'); return void load(true); }
      if (t.classList.contains('fg-place')) { close(pop); return void opts.place(); }
      if (t.classList.contains('fg-item') && !t.classList.contains('busy')) {
        // nothing is stored before the note can take it (a draft is running, the editor is not there yet)
        const why = opts.canInsert ? opts.canInsert() : true;
        if (why !== true) return void toast(why || 'The note cannot take a picture right now.', 'bad');
        t.classList.add('busy'); t.setAttribute('aria-busy', 'true');
        try {
          const md = await insertMarkdown(it.id, t.dataset.key, { language: opts.language ? opts.language() : 'zh' });
          // the crop took a moment: only if this is still the open picker of the same paper does it go into the note
          if (pop._token !== token || pop.hidden || (opts.canInsert && opts.canInsert() !== true)) { /* the user moved on */ }
          else if (opts.insert(md) === true) { toast(`${$('b', t).textContent} was put into the note.`, 'ok'); close(pop); }
        } catch (err) { toast(err.message, 'bad'); }
        t.classList.remove('busy'); t.removeAttribute('aria-busy');
      }
    };
    // arrow keys move through the pictures, Escape closes and gives the focus back to the toolbar button
    pop.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(pop); if (pop._btn) pop._btn.focus(); return; }
      const items = $$('.fg-item', pop), at = items.indexOf(document.activeElement);
      if (!items.length || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      if (at < 0 && !['ArrowDown', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const cols = Math.max(1, Math.round(listEl.clientWidth / (items[0].offsetWidth || 1)));
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : at < 0 ? 0 : at + (e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : e.key === 'ArrowRight' ? 1 : -1);
      items[Math.max(0, Math.min(items.length - 1, to))].focus();
    };
    await load(false);
    if (pop._token === token && !pop.hidden) { const first = $('.fg-place:not([disabled])', pop) || $('.fg-item', pop) || $('.fg-close', pop); if (first) first.focus(); }
  }

  Object.assign(RT.figures, { list, url, insertMarkdown, place, match, markdown, countPlaceholders, PLACEHOLDER_RE, open, close, invalidate, ICON });
})();
