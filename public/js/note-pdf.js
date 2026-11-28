/* A reading note as a PDF (the note's ⋯ menu › Export note as PDF).
   The note is drawn once more the way the editor shows it (Markdown, formulas, diagrams, tables, pictures), into a
   hidden frame that is exactly as wide as the text area of a page, then everything that would not fit is made to
   fit - a wide table or formula is scaled down, a picture or a diagram is limited to the page, code lines wrap - and
   the browser prints the frame: "Save as PDF" in its print window gives the file. The text stays text (it can be
   searched and copied), nothing is uploaded, and the note itself is not changed.
   The pure part (page sizes, the scale of a wide thing, the file name) also loads in Node (scripts/test-note-pdf.js).
   API (RT.notePdf): print({ md, title, authors, year, citekey, options, paper? }) -> Promise<bool>,
   PAGES, page(name), fit(width, room, least), fileName(citekey, title). */
(function (root, factory) {
  const pure = factory();
  if (typeof module === 'object' && module.exports) module.exports = pure;
  else root.RTNotePdfPure = pure;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const MM = 96 / 25.4; // CSS pixels in a millimetre
  // paper and margins in millimetres: [width, height], [top, side, bottom]. The margins are those of an ordinary
  // report: one inch on every side; the content is fitted to what is left, never into the margin.
  const PAGES = { A4: { size: [210, 297], margin: [25.4, 25.4, 25.4] }, Letter: { size: [215.9, 279.4], margin: [25.4, 25.4, 25.4] } };
  // the text area of a page in CSS pixels
  function page(name) {
    const p = PAGES[name] || PAGES.A4, [w, h] = p.size, [top, side, bottom] = p.margin;
    return { name: PAGES[name] ? name : 'A4', css: `${w}mm ${h}mm`, margin: `${top}mm ${side}mm ${bottom}mm`, width: Math.floor((w - 2 * side) * MM), height: Math.floor((h - top - bottom) * MM) };
  }
  // Letter where it is the paper people have (the United States, Canada, Mexico and a few more), A4 everywhere else
  const paperFor = (locale) => (/-(US|CA|MX|PH|CL|CO|VE|PR)\b/i.test(String(locale || '')) ? 'Letter' : 'A4');
  // the scale at which something `width` wide fits into `room`: 1 when it fits, never below `least` (what is still
  // too wide at that scale has to wrap or be cut by its own rules - text smaller than that cannot be read)
  const fit = (width, room, least = 0.5) => (!(width > room) || !(room > 0) ? 1 : Math.max(least, Math.floor(room / width * 1000) / 1000));
  // the name the browser proposes for the file
  function fileName(citekey, title) {
    const base = String(citekey || title || 'note').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';
    return base + ' - note';
  }
  return { PAGES, page, paperFor, fit, fileName, MM };
});

(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.RT) return;
  const RT = window.RT, P = window.RTNotePdfPure;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // what the page looks like: the note's own typography (the editor's style sheets are copied into the frame), in
  // black on white, with the rules of a printed page
  const sheet = (pg) => `
    @page { size: ${pg.css}; margin: ${pg.margin}; @bottom-center { content: counter(page); font: 9pt system-ui, sans-serif; color: #666; } }
    html, body { margin: 0; padding: 0; background: #fff !important; color: #111 !important; }
    body { width: ${pg.width}px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; }
    .np-head { display: block; margin: 0 0 14px; padding: 0 0 10px; border-bottom: 1px solid #bbb; }
    .np-title { font: 600 17pt/1.25 Georgia, 'Times New Roman', serif; margin: 0 0 4px; color: #111; }
    .np-meta { font: 9.5pt/1.4 system-ui, sans-serif; color: #555; margin: 0; }
    .np-body.vditor-reset { font-size: 10.5pt; line-height: 1.55; color: #111; background: #fff; padding: 0; overflow: visible; overflow-wrap: anywhere; }
    .np-body h1, .np-body h2, .np-body h3, .np-body h4, .np-body h5, .np-body h6 { break-after: avoid; page-break-after: avoid; color: #111; }
    .np-body h1 { font-size: 16pt; } .np-body h2 { font-size: 13.5pt; } .np-body h3 { font-size: 12pt; }
    .np-body p, .np-body li { orphans: 3; widows: 3; }
    .np-body img, .np-body svg, .np-body canvas { max-width: 100% !important; max-height: ${Math.floor(pg.height * 0.9)}px; height: auto; object-fit: contain; }
    .np-body img, .np-body figure, .np-body tr, .np-body pre, .np-body blockquote, .np-body .katex-display, .np-body .language-mermaid, .np-body .language-echarts,
    .np-body .language-math, .np-body .np-fit { break-inside: avoid; page-break-inside: avoid; }
    .np-body pre, .np-body pre code { white-space: pre-wrap !important; overflow-wrap: anywhere; word-break: break-word; overflow: visible !important; max-height: none !important; }
    .np-body pre > code { font-size: 8.5pt; }
    .np-body table { border-collapse: collapse; display: table; width: auto; max-width: none; overflow: visible; }
    .np-body th, .np-body td { white-space: normal !important; overflow-wrap: break-word; word-break: normal; padding: 4px 6px; } /* (the editor's cells do not wrap: on paper they must) */
    .np-body thead { display: table-header-group; }
    .np-body .katex-display { overflow: visible !important; }
    .np-body a { color: #1a3f8f; text-decoration: none; }
    .np-body video, .np-body audio, .np-body iframe, .np-body .vditor-copy, .np-body .vditor-linenumber__rows, .np-body button { display: none !important; }
    .np-fit { transform-origin: top left; }
    .np-body .np-wrap > .katex-html > .base { margin: 3px 0; }
  `;

  // formulas, diagrams and pictures are drawn a moment after the text: wait until nothing is left to draw
  async function settled(box, ms = 8000) {
    const until = Date.now() + ms;
    for (;;) {
      const pending = [...box.querySelectorAll('.language-mermaid, .language-echarts, .language-flowchart, .language-graphviz, .language-mindmap, .language-abc, .language-plantuml')].some((el) => el.getAttribute('data-processed') !== 'true' && !el.querySelector('svg, canvas, img'))
        || [...box.querySelectorAll('.language-math')].some((el) => !el.querySelector('.katex, mjx-container, .katex-error') && el.textContent.trim())
        || [...box.querySelectorAll('img')].some((im) => !im.complete);
      if (!pending || Date.now() > until) return !pending;
      await sleep(120);
    }
  }
  // never trust drawn Markdown: no handlers, no script addresses (the page's CSP refuses them as well)
  function scrub(rootEl) {
    for (const el of rootEl.querySelectorAll('script, object, embed, link, meta, base, form')) el.remove();
    for (const el of rootEl.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        else if (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) el.removeAttribute(a.name);
      }
    }
  }
  // what is wider than the page is brought to its width: a table or a display formula is scaled as a whole
  function fitAll(doc, pg) {
    const body = doc.querySelector('.np-body');
    let scaled = 0;
    for (const im of body.querySelectorAll('img')) { // a width chosen in the editor travels in the address (#w=320)
      const m = /#w=(\d{2,4})\b/.exec(im.getAttribute('src') || '');
      if (m) { im.style.width = Math.min(Number(m[1]), pg.width) + 'px'; im.style.height = 'auto'; }
    }
    for (const sv of body.querySelectorAll('svg')) { // a diagram drawn at a fixed size shrinks with its frame
      const w = sv.getBoundingClientRect().width;
      if (w > pg.width) { if (!sv.getAttribute('viewBox')) { const h = sv.getBoundingClientRect().height; sv.setAttribute('viewBox', `0 0 ${Math.ceil(w)} ${Math.ceil(h)}`); } sv.style.width = '100%'; sv.style.height = 'auto'; sv.removeAttribute('height'); }
    }
    for (const el of body.querySelectorAll('table, .katex-display > .katex, mjx-container[display="true"]')) {
      const room = pg.width - Math.max(0, el.getBoundingClientRect().left - body.getBoundingClientRect().left);
      const table = el.tagName === 'TABLE';
      // a table first lets its cells wrap; what is still too wide (many columns, a long formula) is scaled as a whole
      if (table && el.scrollWidth > room) { el.style.width = '100%'; el.style.fontSize = '8.5pt'; }
      // a long formula first breaks at its operators (KaTeX allows that between its top-level parts)
      if (!table && el.scrollWidth > room) { el.style.whiteSpace = 'normal'; el.classList.add('np-wrap'); }
      const k = P.fit(el.scrollWidth, room, table ? 0.3 : 0.4);
      if (k < 1) { el.classList.add('np-fit'); el.style.zoom = String(k); if (!table) el.style.display = 'inline-block'; scaled++; }
    }
    return scaled;
  }

  let busy = false;
  // print({md, title, authors, year, citekey, options}): options are the Vditor.preview options of the note editor
  async function print(note) {
    if (busy) return false;
    busy = true;
    const pg = P.page(note.paper || P.paperFor(navigator.language));
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${pg.width}px;height:${pg.height}px;border:0;visibility:hidden;`;
    const was = document.title;
    try {
      RT.toast('Preparing the PDF…');
      const Vditor = await RT.vendor.vditor();
      document.body.append(frame);
      const doc = frame.contentDocument;
      doc.open(); doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'); doc.close();
      // inline LaTeX of a title as text ("$\\pi_0$" -> "π₀"), the way the Library shows it (RT.texPlain, lineage.js)
      const title = RT.texPlain ? RT.texPlain(note.title || '') : String(note.title || '');
      doc.title = P.fileName(note.citekey, title);
      const meta = [note.authors, note.year, note.citekey].filter(Boolean).join(' · ');
      doc.body.innerHTML = `${title ? `<header class="np-head"><h1 class="np-title">${esc(title)}</h1>${meta ? `<p class="np-meta">${esc(meta)}</p>` : ''}</header>` : ''}<div class="np-body vditor-reset"></div>`;
      // drawn in the page itself (the renderers need its scripts), in a box as wide as the paper, then moved over
      const stage = document.createElement('div');
      stage.className = 'vditor-reset';
      stage.style.cssText = `position:fixed;left:-10000px;top:0;width:${pg.width}px;visibility:hidden;`;
      document.body.append(stage);
      try {
        await Vditor.preview(stage, String(note.md || ''), { ...(note.options || {}), mode: 'light', theme: { current: 'light' }, hljs: { style: 'github', lineNumber: false }, after() { scrub(stage); } });
        await settled(stage);
        scrub(stage);
        const body = doc.querySelector('.np-body');
        while (stage.firstChild) body.append(doc.adoptNode(stage.firstChild));
      } finally { stage.remove(); }
      // The style sheets of the renderers (text, formulas, code colours: the vendored ones, some of which are only
      // loaded while a note is drawn), then the page rules on top. The app's own style sheets stay out: they are
      // made for the screen.
      const sheets = [...document.querySelectorAll('link[rel~="stylesheet"]')].filter((l) => /\/vendor\/vditor\//.test(l.href));
      await Promise.all(sheets.map((l) => new Promise((resolve) => {
        const c = doc.createElement('link'); c.rel = 'stylesheet'; c.href = l.href;
        c.onload = c.onerror = resolve; setTimeout(resolve, 4000);
        doc.head.append(c);
      })));
      const st = doc.createElement('style'); st.textContent = sheet(pg); doc.head.append(st);
      if (!doc.querySelector('.np-body').textContent.trim() && !doc.querySelector('.np-body img, .np-body svg')) { RT.toast('This note is empty: there is nothing to export.'); return false; }
      await settled(doc.body, 4000);
      if (doc.fonts && doc.fonts.ready) { try { await Promise.race([doc.fonts.ready, sleep(1500)]); } catch { /* printed with what is there */ } }
      fitAll(doc, pg);
      if (typeof RT.notePdf._hook === 'function' && (await RT.notePdf._hook(doc, pg, frame)) === false) return true; // (tests look at the page instead of printing it)
      document.title = doc.title; // (the browser proposes the page's title as the file name)
      await new Promise((resolve) => {
        const done = () => { frame.contentWindow.removeEventListener('afterprint', done); resolve(); };
        frame.contentWindow.addEventListener('afterprint', done);
        setTimeout(done, 120000); // (a browser that never says the print window was closed)
        frame.contentWindow.focus();
        frame.contentWindow.print();
      });
      return true;
    } catch (e) {
      console.error(e);
      RT.toast('The note could not be made into a PDF: ' + (e.message || e), 'bad');
      return false;
    } finally {
      document.title = was;
      setTimeout(() => frame.remove(), 500);
      busy = false;
    }
  }

  RT.notePdf = { print, PAGES: P.PAGES, page: P.page, fit: P.fit, fileName: P.fileName, _fitAll: fitAll, _sheet: sheet };
})();
