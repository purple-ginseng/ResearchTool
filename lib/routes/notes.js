// Reading-note routes (READER). library.js runs first: it answers 404 for unknown item ids and returns false for the
// sub-paths below, so every /api/items/:id/... request that reaches this module belongs to an existing item - the
// item is looked up again here anyway.
//   GET|PUT  /api/note-template                      {content}  (PUT also accepts {draft: <JSON draft>} or {reset: true})
//   POST     /api/notes/export                       write every note to <exportDir>/notes/<citekey>.md
//   POST     /api/notes/export-zip {ids, widths?: 'html', pdf?: bool (default true), links?: bool (default true),
//            estimate?: true}  -> a zip of paper packages: <key>/<key>.md (front matter, header with the links, the note)
//            + <key>.bib + <key>.pdf + assets/ per paper, README.md + references.bib at the top. estimate: true answers
//            {papers, notes, pdfs, pdfBytes} instead (the client asks before a large download)
//   GET|PUT  /api/items/:id/note
//   GET      /api/items/:id/note/history[/:vid[/diff?against=previous|current]]     POST .../history/:vid/restore
//   POST     /api/items/:id/note/ask {mode: explain|foundations|meaning|example|ask, question?, kind, text, asset?, language}  { text }
//   POST     /api/items/:id/note/assets (raw image or video)  GET /api/items/:id/note/assets/<sha1>.<ext> (videos: Range)
//   GET      /api/items/:id/note/export?format=md|md-embedded|zip|json[&widths=html][&pdf=0|1][&links=0|1]
//            zip: the paper package of one paper; md-embedded: with the header and links (cached / local ones only)
//   POST     /api/items/:id/note/import (JSON draft or Markdown)
//   GET      /api/items/:id/links  the paper's links from its fields, PDF text and cached answers (no network)
//   POST     /api/items/:id/links {force?}  also asks arXiv / Hugging Face and checks the links (within ~15 s)
//   POST     /api/items/:id/note/draft {language? (else settings draftLanguage), replace?}  -> NDJSON stream
//   POST     /api/items/:id/pdf?name= (raw PDF)      attach or replace the PDF of an item
const core = require('../core');
const notes = require('../notes');
const notejson = require('../notejson');
const links = require('../links');
const { httpErr, attachment } = core;
const fs = require('node:fs');
const path = require('node:path');
const flag = (v, dflt) => (v == null || v === '' ? dflt : !(v === false || v === 0 || v === '0' || v === 'false'));

// send a zip of zipNotes() and remove it and its scratch folder afterwards
function sendZip(ctx, z, name) {
  return ctx.sendFile(z.file, 'application/zip', { ...attachment(name), 'X-RT-Papers': String(z.count), 'X-RT-Notes': String(z.notes), 'X-RT-Pdfs': String(z.pdfs),
    'X-RT-Missing': String(z.missing), 'X-RT-Assets': String(z.assets) }, () => {
    fs.rm(z.file, { force: true }, () => {}); fs.rm(z.tmp, { recursive: true, force: true }, () => {});
  });
}

async function handle(ctx) {
  const { req, res, path: p, segments: seg, method: M, query: q, send } = ctx;

  if (p === '/api/note-template') {
    if (M === 'GET') return send(200, notes.readTemplate());
    if (M === 'PUT') {
      const b = await ctx.json();
      if (b.reset === true) return send(200, notes.resetTemplate());
      if (b.draft && typeof b.draft === 'object') {
        let md; try { md = notejson.toMarkdown(b.draft); } catch (e) { throw httpErr(400, e.message); }
        return send(200, notes.writeTemplate(md));
      }
      return send(200, notes.writeTemplate(b.content));
    }
    return false;
  }
  if (p === '/api/notes/export' && M === 'POST') return send(200, notes.exportNotes(notes.exportDir()));
  if (p === '/api/notes/export-zip' && M === 'POST') {
    const b = await ctx.json();
    if (!Array.isArray(b.ids) || !b.ids.length) return send(400, { error: 'ids must be a non-empty list' });
    const want = new Set(b.ids.map(String)), items = core.loadLib().items.filter((i) => want.has(i.id));
    if (!items.length) return send(404, { error: 'None of these papers is in the library' });
    if (b.estimate === true) return send(200, notes.packageEstimate(items));
    const z = await notes.zipNotes(items, { htmlWidths: b.widths === 'html', pdf: flag(b.pdf, true), links: flag(b.links, true), index: true });
    return sendZip(ctx, z, items.length === 1 ? notes.fileKey(items[0]) + '.zip' : `papers (${z.count}).zip`);
  }

  // the most recently changed notes (the Overview's "Recent notes"): one directory read + a stat per note, read-only
  if (p === '/api/notes/recent' && M === 'GET') {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(q.get('limit')) || 10)));
    let names = [];
    try { names = await fs.promises.readdir(notes.NOTES_DIR); } catch { /* no notes folder yet */ }
    const rows = [];
    await Promise.all(names.filter((n) => /^[0-9a-f]{6,40}\.md$/i.test(n)).map(async (n) => {
      try { const st = await fs.promises.stat(path.join(notes.NOTES_DIR, n)); if (st.isFile() && st.size > 0) rows.push({ id: n.slice(0, -3), mtime: st.mtime.toISOString(), size: st.size }); } catch { /* gone meanwhile */ }
    }));
    rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return send(200, { notes: rows.slice(0, limit) });
  }

  if (seg[1] !== 'items' || !seg[2]) return false;
  const pdfRoute = seg[3] === 'pdf' && seg.length === 4 && M === 'POST';
  const linksRoute = seg[3] === 'links' && seg.length === 4 && (M === 'GET' || M === 'POST');
  if (seg[3] !== 'note' && !pdfRoute && !linksRoute) return false;
  const item = core.loadLib().items.find((i) => i.id === seg[2]);
  if (!item) return send(404, { error: 'No such item' });
  const id = item.id;

  if (linksRoute) {
    if (M === 'GET') return send(200, await links.links(item, { network: false }));
    const b = await ctx.json();
    return send(200, await links.links(item, { network: true, force: b.force === true, budget: 15000 }));
  }

  if (pdfRoute) {
    const buf = await ctx.body();
    return send(200, { item: await notes.attachPdf(id, buf, q.get('name') || 'paper.pdf') });
  }

  const sub = seg[4];
  if (!sub) {
    if (M === 'GET') return send(200, notes.readNote(id));
    if (M === 'PUT') {
      const b = await ctx.json();
      return send(200, notes.writeNote(id, b.content, { baseHash: typeof b.baseHash === 'string' ? b.baseHash : null, source: b.source === 'auto' ? 'auto' : 'manual', label: b.label }));
    }
    return false;
  }

  if (sub === 'history') {
    if (seg.length === 5 && M === 'GET') {
      const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 200, 1), 5000);
      return send(200, { versions: notes.listHistory(id, limit) });
    }
    if (seg.length === 6 && M === 'GET') return send(200, notes.versionContent(id, seg[5]));
    if (seg.length === 7 && seg[6] === 'diff' && M === 'GET') return send(200, notes.versionDiff(id, seg[5], q.get('against') || 'previous'));
    if (seg.length === 7 && seg[6] === 'restore' && M === 'POST') return send(200, notes.restoreVersion(id, seg[5]));
    return false;
  }

  if (sub === 'assets') {
    if (seg.length === 5 && M === 'POST') return send(200, notes.saveAsset(id, await ctx.body(notes.ASSET_MAX)));
    if (seg.length === 6 && (M === 'GET' || M === 'HEAD')) {
      const a = notes.assetFile(id, seg[5]);
      return a.video ? notes.sendRanged(ctx.req, ctx.res, a.file, a.type, a.headers) : ctx.sendFile(a.file, a.type, a.headers);
    }
    return false;
  }

  if (sub === 'export' && seg.length === 5 && M === 'GET') {
    const format = q.get('format') || 'md', htmlWidths = q.get('widths') === 'html';
    const { content } = notes.readNote(id);
    const name = notes.fileKey(item);
    const withLinks = flag(q.get('links'), true);
    if (format === 'zip') return sendZip(ctx, await notes.zipNotes([item], { htmlWidths, pdf: flag(q.get('pdf'), true), links: withLinks }), name + '.zip');
    if (format === 'md-embedded') { // one .md file, every picture inside as a data: URI
      if (!String(content || '').trim()) return send(400, { error: 'This paper has no note yet' });
      const pkg = notes.notePackage(item, content, { mode: 'embed', htmlWidths });
      // the header with the links (no PDF next to it: the arXiv PDF when there is one); the links found so far only,
      // so "Copy note for another app" is not kept waiting by the network
      if (withLinks) pkg.markdown = notes.paperHeader(item, pkg.markdown, await links.links(item, { network: false }), { yaml: false }) + pkg.markdown;
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', ...attachment(name + '.md'),
        'X-RT-Images': String(pkg.used.length), 'X-RT-Missing': String(pkg.missing.length), 'X-RT-Omitted': String(pkg.omitted.length) });
      res.end(pkg.markdown); return true;
    }
    if (format === 'md') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', ...attachment(name + '.md') }); res.end(content); return true; }
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...attachment(name + '.json') });
      res.end(JSON.stringify(notes.exportJson(item, content), null, 2));
      return true;
    }
    return send(400, { error: "format must be 'md', 'md-embedded', 'zip' or 'json'" });
  }

  if (sub === 'import' && seg.length === 5 && M === 'POST') {
    const md = notes.importToMarkdown(await ctx.body(4 * 1024 * 1024), req.headers['content-type'] || '');
    const saved = notes.writeNote(id, md, { source: 'import' }); // the old content is recorded in the history first
    return send(200, { content: md, ...saved });
  }

  if (sub === 'ask' && seg.length === 5 && M === 'POST') { // "Ask Claude": right-click in the note editor, or the sparkle on a selection / snapshot of the PDF -> { text }
    const b = await ctx.json();
    const ac = new AbortController(); // the page was closed while Claude was writing: stop it
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    return send(200, await notes.askAbout(item, { mode: String(b.mode || ''), question: b.question, kind: String(b.kind || ''), text: b.text, asset: b.asset, language: notes.pickLanguage(b.language), page: b.page, signal: ac.signal }));
  }
  if (sub === 'draft' && seg.length === 5 && M === 'POST') {
    const b = await ctx.json();
    if (notes.draftRunning(id)) return send(409, { error: 'A draft is already being generated for this reference', running: true });
    if (!item.pdf && !(item.fields && item.fields.abstract)) return send(400, { error: 'Attach the PDF first: there is nothing to read for this reference.' });
    const cur = notes.readNote(id);
    if (cur.content.trim() && b.replace !== true) return send(409, { error: 'This reference already has a note. Send replace: true to overwrite it (the old note stays in the history).', exists: true });
    await notes.generateDraft(item, { language: notes.pickLanguage(b.language), res, startHash: cur.hash });
    return true;
  }

  return false;
}

module.exports = { handle };
