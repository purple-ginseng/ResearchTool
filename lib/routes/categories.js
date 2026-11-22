// Category routes: /api/categories[/rename|delete|regroup|apply|lines], POST /api/items/:id/categorize,
// POST /api/items/:id/brief and POST /api/briefs (briefs written by Claude in the background).
// Categories are not stored separately: a category exists while at least one item carries its name. A name may be a
// research line with a sub-line, "Line / Sub-line"; rename / delete with {line: true} act on a line and all its sub-lines.
const core = require('../core');
const cat = require('../categorize');
const ai = require('../ai');
const { UNCAT, catOf } = cat;

setTimeout(cat.resume, 300).unref(); // items still 'pending' from before a restart go back into the queue

async function handle(ctx) {
  const { path: p, segments: seg, method: M, json, send, req, res } = ctx;

  if (p === '/api/categories' && M === 'GET') return send(200, cat.summary(core.loadLib()));

  // the research lines Claude should prefer (Settings): GET -> {lines, default, isDefault}; PUT {lines} ('' = no preferred
  // lines at all; the default text = the built-in list); PUT {reset: true} = back to the built-in list
  const linesAnswer = () => ({ lines: cat.settings().researchLines, default: cat.LINES_DEFAULT, isDefault: typeof core.loadSettings().researchLines !== 'string', preferred: cat.preferredLines() });
  if (p === '/api/categories/lines' && M === 'GET') return send(200, linesAnswer());
  if (p === '/api/categories/lines' && M === 'PUT') {
    const b = await json();
    const s = core.loadSettings();
    if (b.reset === true) delete s.researchLines;
    else {
      const lines = cat.cleanLines(b.lines);
      if (lines === cat.cleanLines(cat.LINES_DEFAULT)) delete s.researchLines; else s.researchLines = lines; // '' is kept: none
    }
    core.saveSettings(s);
    return send(200, linesAnswer());
  }

  if (p === '/api/categories/rename' && M === 'POST') {
    const b = await json();
    const lib0 = core.loadLib();
    const from = cat.cleanCategory(b.from), to = cat.cleanCategory(b.to, b.line === true ? null : lib0.items.filter((i) => catOf(i) !== from));
    if (from === UNCAT) throw core.httpErr(400, `"${UNCAT}" cannot be renamed`);
    const lib = core.loadLib();
    if (b.line === true) { // a whole line: "From" and every "From / X" become "To" and "To / X"
      if (cat.subOf(from) || cat.subOf(to)) throw core.httpErr(400, 'A line name has no " / " in it');
      const src = lib.items.filter((i) => cat.inCategory(i, from));
      if (!src.length) throw core.httpErr(404, 'No such line');
      const others = lib.items.filter((i) => !cat.inCategory(i, from));
      const hit = others.find((i) => cat.lineOf(catOf(i)).toLowerCase() === to.toLowerCase());
      const name = hit ? cat.lineOf(catOf(hit)) : to; // merging into an existing line: its spelling wins
      for (const it of src) { const sub = cat.subOf(catOf(it)); it.category = cat.canonical(others, sub ? name + cat.SEP + sub : name); }
      core.saveLib(lib);
      return send(200, { ok: true, name, moved: src.length, merged: !!hit, ...cat.summary(lib) });
    }
    const src = lib.items.filter((i) => catOf(i) === from);
    if (!src.length) throw core.httpErr(404, 'No such category');
    // merge into an existing category (its spelling wins), unless this is only a change of case
    const others = lib.items.filter((i) => catOf(i) !== from);
    const name = cat.canonical(others, to);
    const merged = others.some((i) => catOf(i) === name);
    for (const it of src) it.category = name;
    core.saveLib(lib);
    return send(200, { ok: true, name, moved: src.length, merged, ...cat.summary(lib) });
  }

  if (p === '/api/categories/delete' && M === 'POST') {
    const b = await json();
    const name = cat.cleanCategory(b.name);
    if (name === UNCAT) throw core.httpErr(400, `"${UNCAT}" cannot be deleted`);
    const lib = core.loadLib();
    const src = lib.items.filter((i) => (b.line === true ? cat.inCategory(i, name) : catOf(i) === name));
    if (!src.length) throw core.httpErr(404, b.line === true ? 'No such line' : 'No such category');
    for (const it of src) { it.category = UNCAT; if (it.categoryStatus === 'manual') it.categoryStatus = 'done'; delete it.categoryReason; }
    core.saveLib(lib);
    return send(200, { ok: true, moved: src.length, ...cat.summary(lib) });
  }

  // a proposal as an NDJSON stream: {type:'start'|'progress'|...} lines, then {type:'proposal', ...} or {type:'error', error}
  if (p === '/api/categories/regroup' && M === 'POST') {
    const b = await json();
    const scope = b.scope === undefined ? 'uncategorized' : b.scope;
    if (!['uncategorized', 'all', 'category'].includes(scope)) throw core.httpErr(400, "scope must be 'uncategorized', 'all' or 'category'");
    const category = scope === 'category' ? cat.cleanCategory(b.category) : null;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = (o) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // the dialog was closed: stop the claude process
    try {
      const proposal = await cat.regroup({ scope, keepManual: b.keepManual !== false, category }, { onProgress: emit, signal: ac.signal });
      emit({ type: 'proposal', scope, ...proposal });
    } catch (e) { emit({ type: 'error', error: e.message || String(e) }); }
    if (!res.writableEnded) res.end();
    return true;
  }

  // apply (part of) a proposal, or a bulk move: {assignments: [{id, category}], manual?: bool}
  // restore: true (the Undo of "Organize from a file"): each assignment also carries the old categoryStatus /
  // categoryReason / categoryError, put back as they were, and ifCategory: a paper whose category is no longer that one
  // (moved by hand since) is left alone and counted in `skipped`
  if (p === '/api/categories/apply' && M === 'POST') {
    const b = await json();
    if (!Array.isArray(b.assignments) || !b.assignments.length) throw core.httpErr(400, 'assignments must be a non-empty list');
    if (b.assignments.length > 20000) throw core.httpErr(400, 'Too many assignments');
    const libItems = core.loadLib().items;
    const wanted = b.assignments.map((a) => {
      if (!a || typeof a.id !== 'string') throw core.httpErr(400, 'Each assignment needs an id and a category');
      // a name typed by the user: its line part in the library's spelling ("humanoid robotics/Nav" -> "Humanoid Robotics / Nav")
      return { id: a.id, category: cat.cleanCategory(a.category, b.restore === true ? null : libItems), old: b.restore === true ? a : null };
    });
    const lib = core.loadLib();
    const byId = new Map(lib.items.map((i) => [i.id, i]));
    const wantedIds = new Set(wanted.map((w) => w.id));
    const others = lib.items.filter((i) => !wantedIds.has(i.id));
    const spelling = new Map(); // one spelling per name within this request and with existing categories
    let changed = 0, missing = 0, skipped = 0;
    for (const a of wanted) {
      const it = byId.get(a.id);
      if (!it) { missing++; continue; }
      if (a.old && typeof a.old.ifCategory === 'string' && catOf(it).toLowerCase() !== a.old.ifCategory.toLowerCase()) { skipped++; continue; }
      const key = a.category.toLowerCase();
      if (!spelling.has(key)) spelling.set(key, cat.canonical(others, a.category));
      const name = spelling.get(key);
      if (catOf(it) !== name) changed++;
      it.category = name;
      if (!Array.isArray(it.tags)) it.tags = [];
      it.categoryStatus = b.manual === true ? 'manual' : 'done';
      delete it.categoryError;
      if (b.manual === true) delete it.categoryReason; else it.categoryReason = `Grouped with ${ai.name()} (library re-group)`;
      if (a.old) { // as it was ('pending' too: its grouping job, if still queued, then finishes it)
        for (const k of ['categoryStatus', 'categoryReason', 'categoryError']) { const v = a.old[k]; if (typeof v === 'string' && v) it[k] = v.slice(0, 2000); else delete it[k]; }
        if (it.categoryStatus && !['pending', 'done', 'failed', 'manual'].includes(it.categoryStatus)) delete it.categoryStatus;
      }
    }
    core.saveLib(lib);
    return send(200, { ok: true, changed, missing, skipped, ...cat.summary(lib) });
  }

  // re-run the automatic grouping for one item (also the retry after a failure)
  if (seg[1] === 'items' && seg[2] && seg[3] === 'categorize' && !seg[4] && M === 'POST') {
    const lib = core.loadLib();
    const item = lib.items.find((i) => i.id === seg[2]);
    if (!item) return send(404, { error: 'No such item' });
    cat.markPending(item);
    core.saveLib(lib);
    cat.enqueue(item.id);
    return send(200, { item });
  }

  // (re)write the brief of one item with Claude, in the background; replaces a brief that is there
  if (seg[1] === 'items' && seg[2] && seg[3] === 'brief' && !seg[4] && M === 'POST') {
    const lib = core.loadLib();
    const item = lib.items.find((i) => i.id === seg[2]);
    if (!item) return send(404, { error: 'No such item' });
    cat.markBriefPending(item);
    core.saveLib(lib);
    cat.enqueueBrief(item.id);
    return send(200, { item });
  }
  // write the briefs that are missing: {ids?: [...]} limits it to those papers; papers that have a brief, or are
  // being grouped right now (that call writes the brief too), are left alone
  if (p === '/api/briefs' && M === 'POST') {
    const b = await json();
    if ('ids' in b && !(Array.isArray(b.ids) && b.ids.every((x) => typeof x === 'string'))) throw core.httpErr(400, 'ids must be a list of paper ids');
    const only = 'ids' in b ? new Set(b.ids) : null;
    const lib = core.loadLib();
    const todo = lib.items.filter((i) => (!only || only.has(i.id)) && !i.brief && i.categoryStatus !== 'pending');
    const fresh = todo.filter((i) => i.briefStatus !== 'pending');
    for (const it of fresh) cat.markBriefPending(it);
    if (fresh.length) core.saveLib(lib);
    for (const it of todo) cat.enqueueBrief(it.id);
    return send(200, { queued: todo.length, ...cat.summary(lib) });
  }
  // stop writing briefs: the waiting papers are taken out of the queue and the call in progress is ended
  if (p === '/api/briefs/stop' && M === 'POST') {
    const stopped = cat.stopBriefs();
    return send(200, { stopped, ...cat.summary(core.loadLib()) });
  }

  return false;
}

module.exports = { handle };
