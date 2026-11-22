/* Library tab, reader, "Diagram" tab: explained diagrams (pipeline / workflow / flow chart / concept map) that Claude
   draws from the paper and its note. Pointing at a box or an arrow opens a card with its description and explanation;
   the card can ask Claude for a concrete example or simpler words (kept with the diagram).
   RT.diagram.show(host, item, {page(n), insert(md)}) - called by reader.js when the tab is shown.
   Data: GET/POST /api/items/:id/diagrams, DELETE .../:did, POST .../:did/explain (lib/diagrams.js). */
(() => {
  const { $, $$, esc, api, toast, ls } = RT;
  RT.diagram = RT.diagram || {};

  const KINDS = [['auto', 'Let Claude choose'], ['pipeline', 'Pipeline'], ['workflow', 'Workflow'], ['flowchart', 'Flow chart'], ['concept', 'Concept map']];
  const KIND_NAME = { pipeline: 'Pipeline', workflow: 'Workflow', flowchart: 'Flow chart', concept: 'Concept map' };
  const TYPE_NAME = { input: 'Input', process: 'Step', decision: 'Decision', data: 'Data', model: 'Model', output: 'Output', concept: 'Concept' };
  // icon names (RT.icon)
  const I = {
    flow: 'graph-node', bulb: 'bulb', simpler: 'menu', chat: 'comment', pin: 'pin', fit: 'fit-width', addBox: 'plus-circle',
    arrow: 'arrow-right', below: 'arrow-down', undo: 'undo', redo: 'redo', tidy: 'grid',
  };
  const NODE_W = 178, SEP = 24, VGAP = 64, PAD = 14;

  const cache = new Map(); // itemId -> { diagrams, sel }
  const gens = new Map();  // itemId -> { ctrl, status }
  let view = null;         // { host, item, hooks } of the panel on screen
  let card = null;         // { key, pinned, anchor } of the open card
  let hideTimer = 0, showTimer = 0, zoom = 0; // zoom 0 = fit to the width
  let editing = false;     // edit mode: the head is a form and a clicked box / arrow opens as a form
  let linking = null;      // { from: box id } while the user picks the box a new arrow points to
  let drawTimer = 0;
  let sizes = null;        // box id -> { w, h } as measured by draw()
  let drag = null;         // the box being moved by hand (edit mode): { el, node, dg, id, px, py, x0, y0, scale, moving, raf }
  let skipClick = false;   // the click that ends a drag is not a click on the box
  const pinned = (n) => Number.isFinite(n.x) && Number.isFinite(n.y); // moved by hand: x / y = left / top in the canvas
  const TYPES = ['input', 'process', 'decision', 'data', 'model', 'output', 'concept'];

  const lang = () => (ls.get('rt.note.lang', 'zh') === 'en' ? 'en' : 'zh');
  const state = (id) => cache.get(id) || { diagrams: [], sel: null };
  const currentDg = () => { if (!view) return null; const st = state(view.item.id); return st.diagrams.find((g) => g.id === st.sel) || st.diagrams[0] || null; };

  // text with inline $formulas$ -> HTML (KaTeX renders them once it is loaded)
  const rich = (s) => esc(s).replace(/\$([^$\n]{1,200})\$/g, (m, tex) => `<span class="dg-math" data-tex="${tex}">${m}</span>`).replace(/\n/g, '<br>');
  const richCite = (s) => RT.cite(rich(s)); // an explanation: its (p. N) become page chips
  let katexLoad = null;
  function renderMath(root) {
    const spans = $$('.dg-math:not(.done)', root);
    if (!spans.length) return;
    const run = () => spans.forEach((el) => {
      // the attribute holds escaped text; dataset gives it back unescaped
      try { window.katex.render(el.dataset.tex, el, { throwOnError: false }); el.classList.add('done'); } catch { /* keep the source text */ }
    });
    if (window.katex) return run();
    if (!katexLoad) katexLoad = Promise.all([RT.loadCss('/vendor/vditor/dist/js/katex/katex.min.css'), RT.loadScript('/vendor/vditor/dist/js/katex/katex.min.js')]).catch(() => { katexLoad = null; });
    katexLoad.then(() => { if (window.katex) { run(); if (view && root.isConnected && root.classList.contains('dg-canvas')) draw(); } });
  }

  // ------------------------------------------------------------------ layout: layers top to bottom
  function layout(dg, size, hold) {
    const ids = dg.nodes.map((n) => n.id);
    const E = dg.edges.map((e, i) => ({ i, a: e.from, b: e.to, rev: false }));
    const outs = new Map(ids.map((i) => [i, []])), indeg = new Map(ids.map((i) => [i, 0]));
    for (const e of E) { outs.get(e.a).push(e); indeg.set(e.b, indeg.get(e.b) + 1); }
    // break cycles: an edge that closes a loop is laid out upside down
    const seen = new Map();
    const visit = (u) => { seen.set(u, 1); for (const e of outs.get(u)) { const s = seen.get(e.b); if (s === 1) e.rev = true; else if (!s) visit(e.b); } seen.set(u, 2); };
    for (const u of ids) if (!indeg.get(u) && !seen.get(u)) visit(u);
    for (const u of ids) if (!seen.get(u)) visit(u);
    for (const e of E) { e.u = e.rev ? e.b : e.a; e.v = e.rev ? e.a : e.b; }
    // longest-path layering
    const down = new Map(ids.map((i) => [i, []])), up = new Map(ids.map((i) => [i, []]));
    for (const e of E) { down.get(e.u).push(e.v); up.get(e.v).push(e.u); }
    const rank = new Map(), deg = new Map(ids.map((i) => [i, up.get(i).length]));
    const queue = ids.filter((i) => !deg.get(i));
    for (const u of queue) rank.set(u, 0);
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      for (const v of down.get(u)) { rank.set(v, Math.max(rank.get(v) || 0, rank.get(u) + 1)); deg.set(v, deg.get(v) - 1); if (!deg.get(v)) queue.push(v); }
    }
    for (const u of ids) if (!rank.has(u)) rank.set(u, 0);
    // a side input sits right above what it feeds, not at the very top
    for (const u of ids) if (!up.get(u).length && down.get(u).length) rank.set(u, Math.max(0, Math.min(...down.get(u).map((v) => rank.get(v))) - 1));
    // long edges get a waypoint in every layer they cross
    const box = new Map(ids.map((i) => [i, { id: i, w: size.get(i).w, h: size.get(i).h, r: rank.get(i), upN: [], downN: [] }]));
    for (const e of E) {
      e.chain = [e.u];
      for (let r = rank.get(e.u) + 1; r < rank.get(e.v); r++) { const id = `~${e.i}_${r}`; box.set(id, { id, w: 10, h: 0, r, dummy: true, upN: [], downN: [] }); e.chain.push(id); }
      e.chain.push(e.v);
      for (let k = 0; k + 1 < e.chain.length; k++) { box.get(e.chain[k]).downN.push(e.chain[k + 1]); box.get(e.chain[k + 1]).upN.push(e.chain[k]); }
    }
    const layers = [];
    for (const b of box.values()) (layers[b.r] = layers[b.r] || []).push(b);
    for (let r = 0; r < layers.length; r++) layers[r] = layers[r] || [];
    // order inside the layers: barycentre sweeps
    const index = () => layers.forEach((L) => L.forEach((b, k) => (b.o = k)));
    index();
    const sweep = (L, key) => {
      for (const b of L) { const ns = b[key]; b.bc = ns.length ? ns.reduce((s, n) => s + box.get(n).o, 0) / ns.length : b.o; }
      L.sort((p, q) => p.bc - q.bc || p.o - q.o); L.forEach((b, k) => (b.o = k));
    };
    for (let it = 0; it < 4; it++) {
      for (let r = 1; r < layers.length; r++) sweep(layers[r], 'upN');
      for (let r = layers.length - 2; r >= 0; r--) sweep(layers[r], 'downN');
    }
    // x: packed and centred first, then pulled towards the neighbours without changing the order
    for (const L of layers) {
      let x = 0;
      for (const b of L) { b.x = x + b.w / 2; x += b.w + SEP; }
      const mid = (x - SEP) / 2;
      for (const b of L) b.x -= mid;
    }
    const pull = (L, key) => {
      if (!L.length) return;
      const want = L.map((b) => (b[key].length ? b[key].reduce((s, n) => s + box.get(n).x, 0) / b[key].length : b.x));
      const gap = (k) => (L[k].w + L[k + 1].w) / 2 + SEP;
      const lo = [], hi = [];
      for (let k = 0; k < L.length; k++) lo[k] = k ? Math.max(want[k], lo[k - 1] + gap(k - 1)) : want[k];
      for (let k = L.length - 1; k >= 0; k--) hi[k] = k < L.length - 1 ? Math.min(want[k], hi[k + 1] - gap(k)) : want[k];
      L.forEach((b, k) => (b.x = (lo[k] + hi[k]) / 2));
    };
    for (let it = 0; it < 3; it++) {
      for (let r = 1; r < layers.length; r++) pull(layers[r], 'upN');
      for (let r = layers.length - 2; r >= 0; r--) pull(layers[r], 'downN');
    }
    // y
    let y = PAD;
    const top = [], tall = [];
    layers.forEach((L, r) => { tall[r] = Math.max(0, ...L.map((b) => b.h)); top[r] = y; y += tall[r] + VGAP; });
    for (const b of box.values()) b.y = top[b.r] + (tall[b.r] - b.h) / 2;
    const minX = Math.min(...[...box.values()].map((b) => b.x - b.w / 2));
    for (const b of box.values()) b.x += PAD - minX;
    // boxes the user moved by hand stay where they were put; their arrows are drawn straight from box to box
    const pins = new Set();
    for (const n of dg.nodes) if (pinned(n) && box.has(n.id)) { const b = box.get(n.id); b.x = n.x + b.w / 2; b.y = n.y; pins.add(n.id); }
    // a box dragged left of / above the rest: the drawing is shifted (sx, sy) so that it stays inside the canvas;
    // `hold` keeps the shift of the moment a drag began, so nothing moves under the pointer
    const all = [...box.values()];
    const sx = hold ? hold.sx : Math.max(0, PAD - Math.min(...all.map((b) => b.x - b.w / 2)));
    const sy = hold ? hold.sy : Math.max(0, PAD - Math.min(...all.map((b) => b.y)));
    const width = Math.max(...all.map((b) => b.x + b.w / 2)) + sx + PAD;
    const height = Math.max(y - VGAP, ...all.map((b) => b.y + b.h)) + sy + PAD;
    // ports: several arrows on one side of a box are spread along it
    const ports = (list, side) => {
      const by = new Map();
      for (const e of list) { const id = side === 'out' ? e.u : e.v; if (!by.has(id)) by.set(id, []); by.get(id).push(e); }
      for (const [id, es] of by) {
        const b = box.get(id), step = Math.min(26, (b.w * 0.7) / es.length);
        es.sort((p, q) => box.get(side === 'out' ? p.chain[1] : p.chain[p.chain.length - 2]).x - box.get(side === 'out' ? q.chain[1] : q.chain[q.chain.length - 2]).x);
        es.forEach((e, k) => (e[side] = b.x + (k - (es.length - 1) / 2) * step));
      }
    };
    ports(E, 'out'); ports(E, 'in');
    const f1 = (v) => v.toFixed(1);
    const direct = (e) => {
      const a = box.get(e.a), b = box.get(e.b);
      let p0, p1, c0, c1;
      if (b.y - (a.y + a.h) >= 18) { // the target is below: bottom -> top
        p0 = [e.rev ? a.x : e.out, a.y + a.h]; p1 = [e.rev ? b.x : e.in, b.y];
        const m = (p0[1] + p1[1]) / 2; c0 = [p0[0], m]; c1 = [p1[0], m];
      } else if (a.y - (b.y + b.h) >= 18) { // above: top -> bottom
        p0 = [a.x, a.y]; p1 = [b.x, b.y + b.h];
        const m = (p0[1] + p1[1]) / 2; c0 = [p0[0], m]; c1 = [p1[0], m];
      } else { // side by side
        const s = b.x >= a.x ? 1 : -1;
        p0 = [a.x + s * a.w / 2, a.y + a.h / 2]; p1 = [b.x - s * b.w / 2, b.y + b.h / 2];
        const m = (p0[0] + p1[0]) / 2; c0 = [m, p0[1]]; c1 = [m, p1[1]];
      }
      return { i: e.i, rev: false, d: `M${f1(p0[0])} ${f1(p0[1])}C${f1(c0[0])} ${f1(c0[1])} ${f1(c1[0])} ${f1(c1[1])} ${f1(p1[0])} ${f1(p1[1])}`,
        lx: (p0[0] + 3 * c0[0] + 3 * c1[0] + p1[0]) / 8, ly: (p0[1] + 3 * c0[1] + 3 * c1[1] + p1[1]) / 8 };
    };
    const paths = E.map((e) => {
      if (pins.has(e.a) || pins.has(e.b)) return direct(e);
      const first = box.get(e.u), last = box.get(e.v);
      const pts = [[e.out, first.y + first.h]];
      for (const id of e.chain.slice(1, -1)) { const b = box.get(id); pts.push([b.x, top[b.r]], [b.x, top[b.r] + tall[b.r]]); }
      pts.push([e.in, last.y]);
      let dpath = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let k = 1; k < pts.length; k++) {
        const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
        if (x0 === x1) dpath += `L${x1.toFixed(1)} ${y1.toFixed(1)}`;
        else { const m = (y0 + y1) / 2; dpath += `C${x0.toFixed(1)} ${m.toFixed(1)} ${x1.toFixed(1)} ${m.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`; }
      }
      // the label sits on the first curve, nearer the end where the arrows are further apart (fan-out: lower, fan-in: higher)
      const fanOut = down.get(e.u).length, fanIn = up.get(e.v).length;
      const t = e.chain.length > 2 ? 0.5 : fanOut > fanIn ? 0.66 : fanIn > fanOut ? 0.34 : 0.5;
      const [x0, y0] = pts[0], [x1, y1] = pts[1], m = (y0 + y1) / 2, q = 1 - t;
      const lx = q * q * q * x0 + 3 * q * q * t * x0 + 3 * q * t * t * x1 + t * t * t * x1;
      const ly = q * q * q * y0 + 3 * q * q * t * m + 3 * q * t * t * m + t * t * t * y1;
      return { i: e.i, d: dpath, rev: e.rev, lx, ly };
    });
    return { box, paths, width, height, sx, sy };
  }

  // ------------------------------------------------------------------ editing by hand: saved automatically
  const saves = new Map(); // diagram id -> { itemId, dg, timer } of the edits not sent yet
  let saveChain = Promise.resolve(); // PUTs go out one after the other, so an older one never lands last
  // "more" (examples / simpler explanations) is only used by the server for a box or arrow it does not have: one that an
  // undo brought back (see update() in lib/diagrams.js)
  const payload = (dg) => ({ title: dg.title, summary: dg.summary, groups: dg.groups, nodes: dg.nodes, edges: dg.edges });
  const putUrl = (s, id) => `/api/items/${s.itemId}/diagrams/${id}`;
  function paintSaved(text, itemId) {
    if (!view || view.item.id !== itemId || gens.has(itemId) || linking) return;
    const el = $('#dg-status', view.host); if (el) el.textContent = text;
  }
  const dirty = (itemId) => [...saves.values()].some((v) => v.itemId === itemId);
  function saveNow(id) {
    const s = saves.get(id); if (!s) return saveChain;
    clearTimeout(s.timer); saves.delete(id);
    const body = payload(s.dg);
    saveChain = saveChain.then(() => api(putUrl(s, id), { method: 'PUT', json: body }))
      .then(() => { if (!dirty(s.itemId)) paintSaved('Saved', s.itemId); }, (e) => {
        // keep it as unsent (retried shortly, resent when the page closes) unless the diagram is gone on the server
        if (e.status !== 404 && e.status !== 400 && !saves.has(id)) saves.set(id, { itemId: s.itemId, dg: s.dg, failed: true, timer: setTimeout(() => saveNow(id), 5000) });
        paintSaved('Not saved - trying again', s.itemId);
        if (!s.failed) toast('Could not save the diagram: ' + e.message, 'bad');
      });
    return saveChain;
  }
  function queueSave(dg) {
    if (!view) return;
    const old = saves.get(dg.id); if (old) clearTimeout(old.timer);
    saves.set(dg.id, { itemId: view.item.id, dg, timer: setTimeout(() => saveNow(dg.id), 700) });
    paintSaved('Saving…', view.item.id);
  }
  const flushSaves = () => { for (const id of [...saves.keys()]) saveNow(id); return saveChain; };
  const dropSave = (id) => { const s = saves.get(id); if (s) { clearTimeout(s.timer); saves.delete(id); } };
  window.addEventListener('pagehide', () => { // closing the page inside the 0.7 s before a save
    for (const [id, s] of saves) {
      clearTimeout(s.timer);
      try {
        let body = JSON.stringify(payload(s.dg));
        // a keepalive request may carry 64 KiB at most; the server keeps its own "more" for every box and arrow it has
        if (new Blob([body]).size > 60000) body = JSON.stringify({ ...payload(s.dg), nodes: s.dg.nodes.map(({ more, ...n }) => n), edges: s.dg.edges.map(({ more, ...e }) => e) });
        fetch(putUrl(s, id), { method: 'PUT', keepalive: true, headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body }).catch(() => {});
      } catch { /* nothing more to do */ }
    }
    saves.clear();
  });
  // a diagram was changed: save soon; `now` redraws at once (boxes or arrows were added / removed)
  function changed(dg, now = false) {
    queueSave(dg);
    clearTimeout(drawTimer);
    if (now) draw(); else drawTimer = setTimeout(draw, 220);
  }
  // ---- undo / redo: snapshots of the diagram taken before every change (kept until the page is reloaded)
  const hist = new Map(); // diagram id -> { undo: [json], redo: [json], tag, at }
  const snap = (dg) => JSON.stringify(payload(dg));
  // call BEFORE changing dg; changes with the same tag (typing in one field) within 3 s are one step
  function record(dg, tag = '') {
    let h = hist.get(dg.id); if (!h) hist.set(dg.id, h = { undo: [], redo: [], tag: '', at: 0 });
    const now = Date.now();
    if (!(tag && tag === h.tag && now - h.at < 3000)) { h.undo.push(snap(dg)); if (h.undo.length > 100) h.undo.shift(); }
    h.tag = tag; h.at = now; h.redo.length = 0;
    paintTools();
  }
  function step(dir) { // -1 = undo, 1 = redo
    const dg = currentDg(), h = dg && hist.get(dg.id);
    const from = h && (dir < 0 ? h.undo : h.redo);
    if (!from || !from.length || drag) return;
    (dir < 0 ? h.redo : h.undo).push(snap(dg)); h.tag = '';
    const s = JSON.parse(from.pop());
    // answers Claude gave since the snapshot stay with their box / arrow (the server keeps them too)
    const nm = new Map(dg.nodes.map((n) => [n.id, n.more])), em = new Map(dg.edges.map((e) => [e.from + '>' + e.to, e.more]));
    for (const n of s.nodes) if (nm.has(n.id)) n.more = nm.get(n.id) || [];
    for (const e of s.edges) if (em.has(e.from + '>' + e.to)) e.more = em.get(e.from + '>' + e.to) || [];
    Object.assign(dg, s); // the same object stays in the cache and in the save queue
    setLinking(null); hideCard(true);
    const o = $(`#dg-pick option[value="${CSS.escape(dg.id)}"]`, view.host); if (o) o.textContent = dg.title;
    paintHead(); changed(dg, true); paintTools();
  }
  // the bar buttons that only exist in edit mode
  function paintTools() {
    if (!view) return;
    const dg = currentDg(), h = dg && hist.get(dg.id);
    const set = (sel, hidden, off) => { const b = $(sel, view.host); if (b) { b.hidden = hidden; if (off != null) b.disabled = off; } };
    set('#dg-add-box', !editing);
    set('#dg-undo', !editing, !(h && h.undo.length));
    set('#dg-redo', !editing, !(h && h.redo.length));
    set('#dg-tidy', !editing || !dg || !dg.nodes.some(pinned));
    keepKeys();
  }
  // the focused control was hidden or disabled: keep the keyboard (undo, Esc) in the panel
  function keepKeys() {
    if (!view || !editing) return;
    const a = document.activeElement;
    if (!a || a === document.body || (view.host.contains(a) && (a.disabled || a.closest('#dg-card[hidden]')))) view.host.focus({ preventScroll: true });
  }
  const freshId = (dg, prefix) => {
    const used = new Set([...dg.nodes.map((n) => n.id), ...dg.groups.map((g) => g.id)]);
    for (;;) { const id = prefix + Math.random().toString(36).slice(2, 8); if (!used.has(id)) return id; }
  };
  const newBox = (dg, group = '') => ({ id: freshId(dg, 'n'), label: 'New box', type: 'process', group, desc: '', explain: '', page: null, more: [] });
  const anchorOf = (key) => { const c = view && $('#dg-canvas', view.host), q = CSS.escape(key); return c ? $(`.dg-node[data-key="${q}"], .dg-elabel[data-key="${q}"]`, c) || $(`.dg-edge[data-key="${q}"]`, c) : null; };
  // open the form of a box / arrow that was just created
  function openEdit(key) {
    let a = anchorOf(key); if (!a) return;
    editing = true; paintMode();
    a = anchorOf(key) || a;
    if (a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showCard(a, true);
    const first = view && $('#dg-card [data-f]', view.host);
    if (first) { first.focus(); if (first.select) first.select(); }
  }
  function setLinking(from) {
    linking = from ? { from } : null;
    if (!view) return;
    const c = $('#dg-canvas', view.host), el = $('#dg-status', view.host);
    if (c) c.classList.toggle('dg-linking', !!linking);
    if (el && !gens.has(view.item.id)) el.textContent = linking ? 'Click the box the arrow should point to · Esc cancels' : '';
    if (linking) { const a = anchorOf('n:' + from); if (a) a.focus({ preventScroll: true }); } // keeps the keyboard (Esc) inside the panel
  }
  // edit mode on / off: the bar button, the head and the hint line follow
  function paintMode() {
    if (!view) return;
    const b = $('#dg-edit', view.host), c = $('#dg-canvas', view.host);
    if (b) { b.classList.toggle('on', editing); b.setAttribute('aria-pressed', String(editing)); }
    if (c) c.classList.toggle('dg-editing', editing);
    paintTools(); paintHead();
  }
  function headHtml(dg) {
    const tip = editing ? 'Editing · click a box or an arrow to change it · drag a box to move it · saved automatically' : 'Point at a box or an arrow to read what it means · click to keep the card open';
    if (!editing) return `<h3>${rich(dg.title)} <span class="badge">${esc(KIND_NAME[dg.kind] || 'Diagram')}</span></h3>
        ${dg.summary ? `<p>${rich(dg.summary)}</p>` : ''}
        ${dg.groups.length ? `<div class="dg-legend">${dg.groups.map((g, k) => `<span class="dg-chip dg-g${k % 5}">${esc(g.label)}</span>`).join('')}</div>` : ''}
        <p class="muted dg-tip">${tip}</p>`;
    return `<div class="dg-edit">
        <input type="text" data-h="title" maxlength="90" value="${esc(dg.title)}" title="Title of the diagram" aria-label="Title of the diagram">
        <textarea data-h="summary" rows="3" maxlength="800" placeholder="How to read the diagram and its main message" title="Summary" aria-label="Summary">${esc(dg.summary)}</textarea>
        <div class="dg-legend">${dg.groups.map((g, k) => `<span class="dg-chip dg-g${k % 5}"><input type="text" data-g="${esc(g.id)}" maxlength="40" value="${esc(g.label)}" size="${Math.max(6, Math.min(24, g.label.length + 2))}" title="Name of the group" aria-label="Name of the group"><button type="button" class="ib ghost" data-gdel="${esc(g.id)}" title="Remove this group (its boxes stay)" aria-label="Remove this group">${RT.icon('close')}</button></span>`).join('')}
          ${dg.groups.length < 8 ? `<button type="button" class="ib" data-gadd title="Add a group (a phase or part that boxes can belong to)" aria-label="Add a group">${RT.icon('plus')}</button>` : ''}</div>
      </div><p class="muted dg-tip">${tip}</p>`;
  }
  function paintHead() {
    const dg = currentDg(), el = view && $('#dg-head', view.host);
    if (!dg || !el) return;
    el.innerHTML = headHtml(dg); renderMath(el);
  }
  function editHtml(key) {
    const x = target(key); if (!x) return '';
    const { dg, node, edge } = x;
    const name = (id) => (dg.nodes.find((n) => n.id === id) || {}).label || 'Untitled';
    const done = `<span class="spacer"></span><button class="ib ghost" data-done title="Done: close this form (changes are already saved)" aria-label="Done">${RT.icon('check')}</button>`;
    if (node) return `
      <div class="dg-card-h"><span class="badge">Edit box</span>${done}</div>
      <div class="dg-edit">
        <label>Name<input type="text" data-f="label" maxlength="60" value="${esc(node.label)}"></label>
        <div class="dg-edit-row">
          <label>Kind<select data-f="type">${TYPES.map((t) => `<option value="${t}" ${t === node.type ? 'selected' : ''}>${TYPE_NAME[t]}</option>`).join('')}</select></label>
          <label>Group<select data-f="group"><option value="">None</option>${dg.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === node.group ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}${dg.groups.length < 8 ? '<option value="+">New group…</option>' : ''}</select></label>
          <label class="dg-edit-page">Page<input type="number" data-f="page" min="1" max="4999" value="${node.page || ''}"></label>
        </div>
        <label>What it is <span class="muted">(one sentence)</span><textarea data-f="desc" rows="2" maxlength="600">${esc(node.desc)}</textarea></label>
        <label>Explanation<textarea data-f="explain" rows="5" maxlength="2000">${esc(node.explain)}</textarea></label>
      </div>
      <div class="dg-card-actions">
        <button data-link title="Draw an arrow from this box: click here, then click the box it should point to">${RT.icon(I.arrow)}Arrow to…</button>
        <button data-next title="Add a new box below this one, joined by an arrow">${RT.icon(I.below)}Box below</button>
        <span class="spacer"></span>
        <button class="ib danger" data-remove title="Delete this box and its arrows" aria-label="Delete this box">${RT.icon('trash')}</button>
      </div>`;
    return `
      <div class="dg-card-h"><span class="badge">Edit arrow</span><b>${rich(name(edge.from))} → ${rich(name(edge.to))}</b>${done}</div>
      <div class="dg-edit">
        <label>Label <span class="muted">(a few words, may be empty)</span><input type="text" data-f="label" maxlength="40" value="${esc(edge.label)}"></label>
        <label>What it means<textarea data-f="desc" rows="3" maxlength="600">${esc(edge.desc)}</textarea></label>
      </div>
      <div class="dg-card-actions">
        <button data-reverse title="Turn the arrow round (its examples are dropped)">${RT.icon('swap')}Reverse</button>
        <span class="spacer"></span>
        <button class="ib danger" data-remove title="Delete this arrow" aria-label="Delete this arrow">${RT.icon('trash')}</button>
      </div>`;
  }
  // a field of the open form (or of the head) was typed in
  async function onField(el) {
    const dg = currentDg(); if (!dg) return;
    if (el.dataset.h) { // title / summary
      const v = el.value.replace(/\s+/g, ' ').trim();
      if (el.dataset.h === 'title' && !v) return;
      record(dg, 'h:' + el.dataset.h);
      if (el.dataset.h === 'title') { dg.title = v; const o = $(`#dg-pick option[value="${CSS.escape(dg.id)}"]`, view.host); if (o) o.textContent = v; }
      else dg.summary = v;
      return queueSave(dg);
    }
    if (el.dataset.g) { // group name
      const g = dg.groups.find((y) => y.id === el.dataset.g), v = el.value.replace(/\s+/g, ' ').trim();
      if (!g || !v) return;
      record(dg, 'g:' + g.id);
      g.label = v; el.size = Math.max(6, Math.min(24, v.length + 2));
      return queueSave(dg);
    }
    const x = card && target(card.key), f = el.dataset.f;
    if (!x || !f) return;
    if (f === 'page') { record(dg, `f:${card.key}:page`); const n = Math.round(Number(el.value)); x.t.page = n > 0 && n < 5000 ? n : null; return queueSave(dg); }
    if (f === 'group' && el.value === '+') {
      const label = ((await RT.ask({ title: 'New group', message: 'Name of the new group (a phase or part of the method):', okText: 'Add the group' })) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!el.isConnected) return; // the card was closed while the name was asked for
      if (!label) { el.value = x.t.group || ''; return; }
      record(dg);
      const g = { id: freshId(dg, 'g'), label };
      dg.groups.push(g); x.t.group = g.id;
      el.blur(); paintHead(); changed(dg, true); refreshCard(); // blur: the form may be rebuilt (new option)
      return;
    }
    record(dg, f === 'type' || f === 'group' ? '' : `f:${card.key}:${f}`);
    x.t[f] = f === 'desc' || f === 'explain' ? el.value.replace(/\s+/g, ' ').trim() : f === 'label' ? el.value.replace(/\s+/g, ' ').trim() : el.value;
    if (f === 'desc' || f === 'explain') queueSave(dg); else changed(dg);
  }

  // ------------------------------------------------------------------ panel
  function show(host, item, hooks = {}) {
    hideCard(true);
    view = { host, item, hooks };
    host.classList.add('dg');
    if (!host.dataset.wired) { host.dataset.wired = '1'; wire(host); }
    if (cache.has(item.id)) return render();
    host.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    api(`/api/items/${item.id}/diagrams`).then((r) => {
      cache.set(item.id, { diagrams: r.diagrams || [], sel: (r.diagrams && r.diagrams[0] && r.diagrams[0].id) || null });
      if (view && view.host === host && view.item.id === item.id) render();
    }).catch((e) => { if (view && view.host === host) host.innerHTML = `<div class="empty">Could not load the diagrams: ${esc(e.message)}</div>`; });
  }

  const formHtml = (empty) => `
    <form class="dg-form" id="dg-form" ${empty ? '' : 'hidden'}>
      <select id="dg-kind" title="Kind of diagram" aria-label="Kind of diagram">${KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <input type="text" id="dg-focus" maxlength="300" placeholder="Focus (optional) — e.g. the training procedure" title="What the diagram should explain. Leave empty for the core method of the paper." aria-label="Focus of the diagram">
      <button class="accent ib" id="dg-go" title="Draw with Claude: read the paper and the note, then draw the diagram with an explanation for every box" aria-label="Draw with Claude">${RT.icon('sparkle')}</button>
    </form>`;

  function render() {
    if (!view) return;
    const { host, item } = view, st = state(item.id), dg = currentDg(), gen = gens.get(item.id);
    hideCard(true); linking = null; clearTimeout(drawTimer);
    if (drag) { const d = drag; drag = null; cancelAnimationFrame(d.raf); if (d.moving) queueSave(d.dg); } // the boxes are rebuilt: a drag ends where it is
    host.innerHTML = `
    <div class="dg-bar">
      <button id="dg-new" class="ib ${dg ? '' : 'on'}" title="New diagram: let Claude draw another one (a different kind or focus)" aria-label="New diagram" ${dg ? '' : 'hidden'}>${RT.icon('plus')}</button>
      <select id="dg-pick" title="Diagrams of this paper" aria-label="Diagrams of this paper" ${st.diagrams.length > 1 ? '' : 'hidden'}>${st.diagrams.map((g) => `<option value="${esc(g.id)}" ${dg && g.id === dg.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}</select>
      <span class="dg-status muted" id="dg-status">${gen ? `<span class="spin"></span> ${esc(gen.status)}` : dirty(item.id) ? 'Not saved yet' : ''}</span>
      <button id="dg-stop" class="ib" title="Stop Claude" aria-label="Stop Claude" ${gen ? '' : 'hidden'}>${RT.icon('stop')}</button>
      <span class="spacer"></span>
      ${dg ? `<button id="dg-tidy" class="ib" title="Tidy up: lay the boxes out automatically again (forgets where you dragged them)" aria-label="Tidy up" hidden>${RT.icon(I.tidy)}</button><button id="dg-undo" class="ib" title="Undo the last change (⌘Z / Ctrl+Z)" aria-label="Undo" hidden>${RT.icon(I.undo)}</button><button id="dg-redo" class="ib" title="Redo (⇧⌘Z / Ctrl+Y)" aria-label="Redo" hidden>${RT.icon(I.redo)}</button>
      <button id="dg-add-box" class="ib" title="Add a box (then join it with “Arrow to…”)" aria-label="Add a box" ${editing ? '' : 'hidden'}>${RT.icon(I.addBox)}</button><button id="dg-edit" class="ib ${editing ? 'on' : ''}" aria-pressed="${editing}" title="Edit by hand: change the title, the boxes and the arrows" aria-label="Edit by hand">${RT.icon('pencil')}</button>
      <button id="dg-zoom-out" class="ib" title="Zoom out" aria-label="Zoom out">${RT.icon('zoom-out')}</button><button id="dg-zoom-fit" class="ib" title="Fit to the width" aria-label="Fit to the width">${RT.icon(I.fit)}</button><button id="dg-zoom-in" class="ib" title="Zoom in" aria-label="Zoom in">${RT.icon('zoom-in')}</button>
      <button id="dg-insert" class="ib" title="Insert into the note: the diagram (as a Mermaid block) and the description of every box" aria-label="Insert into the note">${RT.icon('note')}</button>
      <button id="dg-copy" class="ib" title="Copy as Mermaid (for Markdown, Notion, Obsidian, Overleaf figures …)" aria-label="Copy as Mermaid">${RT.icon('copy')}</button>
      <button id="dg-del" class="ib danger" title="Delete this diagram" aria-label="Delete this diagram">${RT.icon('trash')}</button>` : ''}
    </div>
    ${formHtml(!dg && !gen)}
    ${dg ? `<div class="dg-scroll" id="dg-scroll">
      <div class="dg-head" id="dg-head">${headHtml(dg)}</div>
      <div class="dg-fit" id="dg-fit"><div class="dg-canvas" id="dg-canvas"></div></div>
    </div>` : `<div class="empty dg-empty">${RT.icon(I.flow, { size: 34 })}<div>${gen ? 'Claude is reading the paper and drawing the diagram — this takes a minute or two.<br>You can keep working in the other tabs meanwhile.' : 'Let Claude turn this paper into a pipeline, workflow, flow chart or concept map.<br>Every box comes with an explanation, and you can ask for examples.'}</div></div>`}
    <div class="dg-card" id="dg-card" hidden></div>`;
    if (gen) { const go = $('#dg-go', host), add = $('#dg-new', host); if (go) go.disabled = true; if (add) add.disabled = true; }
    renderMath($('.dg-head', host) || host);
    paintTools();
    if (dg) draw();
  }

  // (re)build the boxes and arrows of the selected diagram and lay them out
  function draw() {
    const dg = currentDg(), canvas = view && $('#dg-canvas', view.host);
    if (!dg || !canvas || !canvas.offsetParent) return; // hidden tab: drawn when it is shown
    if (drag && drag.moving) return; // the box under the pointer must stay; drawn again when it is dropped
    const gi = new Map(dg.groups.map((g, k) => [g.id, k % 5]));
    canvas.style.transform = ''; canvas.style.width = ''; canvas.style.height = '';
    canvas.innerHTML = dg.nodes.map((n) => `<button type="button" class="dg-node dg-t-${esc(n.type)} ${gi.has(n.group) ? 'dg-g' + gi.get(n.group) : ''}" data-key="n:${esc(n.id)}" style="width:${NODE_W}px" aria-label="${esc(n.label)}: ${esc(n.desc)}"><span class="dg-kind">${esc(TYPE_NAME[n.type] || 'Step')}</span><span class="dg-label">${rich(n.label || 'Untitled')}</span></button>`).join('');
    canvas.classList.toggle('dg-linking', !!linking); canvas.classList.toggle('dg-editing', editing);
    renderMath(canvas);
    sizes = new Map();
    for (const el of $$('.dg-node', canvas)) sizes.set(el.dataset.key.slice(2), { w: el.offsetWidth, h: el.offsetHeight });
    place();
    // rebuilding the boxes dropped the focus: keep the keyboard (undo, Esc) in the panel
    if (editing && (!document.activeElement || document.activeElement === document.body)) view.host.focus({ preventScroll: true });
  }
  // lay the boxes out and (re)draw the arrows; the box elements stay (called for every step of a drag)
  function place() {
    const dg = currentDg(), canvas = view && $('#dg-canvas', view.host);
    if (!dg || !canvas || !sizes || dg.nodes.some((n) => !sizes.has(n.id))) return;
    const L = layout(dg, sizes, drag && drag.moving ? drag : null);
    canvas.dataset.sx = L.sx; canvas.dataset.sy = L.sy;
    $$('.dg-edges, .dg-elabel', canvas).forEach((n) => n.remove());
    for (const el of $$('.dg-node', canvas)) { const b = L.box.get(el.dataset.key.slice(2)); el.style.left = (b.x - b.w / 2 + L.sx) + 'px'; el.style.top = (b.y + L.sy) + 'px'; }
    canvas.insertAdjacentHTML('afterbegin', `<svg class="dg-edges" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" aria-hidden="true">
      <defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>
      <g transform="translate(${L.sx} ${L.sy})">${L.paths.map((p) => `<g class="dg-edge" data-key="e:${p.i}"><path class="dg-hit" d="${p.d}"/><path class="dg-line" d="${p.d}" ${p.rev ? 'marker-start' : 'marker-end'}="url(#dg-arrow)"/></g>`).join('')}</g></svg>`);
    canvas.insertAdjacentHTML('beforeend', L.paths.map((p) => (dg.edges[p.i].label ? `<span class="dg-elabel" data-key="e:${p.i}" style="left:${p.lx + L.sx}px;top:${p.ly + L.sy}px">${rich(dg.edges[p.i].label)}</span>` : '')).join(''));
    renderMath(canvas);
    canvas.dataset.w = L.width; canvas.dataset.h = L.height;
    applyZoom();
    if (card) { // the boxes were rebuilt: the open card belongs to the new element of the same box / arrow
      const a = anchorOf(card.key);
      if (!a || !target(card.key)) hideCard(true);
      else { card.anchor = a; $$(`[data-key="${CSS.escape(card.key)}"]`, canvas).forEach((n) => n.classList.add('dg-on')); placeCard(); }
    }
  }
  function applyZoom() {
    const canvas = view && $('#dg-canvas', view.host), fit = view && $('#dg-fit', view.host);
    if (!canvas || !fit) return;
    const w = Number(canvas.dataset.w) || 1, h = Number(canvas.dataset.h) || 1;
    const avail = $('#dg-scroll', view.host).clientWidth - 24;
    const s = drag && drag.moving ? drag.scale : zoom || Math.min(1, Math.max(0.35, avail / w)); // no rescaling under the pointer
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.style.transform = s === 1 ? '' : `scale(${s})`;
    if (drag && drag.moving) return; // the frame keeps its size while a box is dragged, so nothing shifts under the pointer
    fit.style.width = w * s + 'px'; fit.style.height = h * s + 'px';
    fit.dataset.scale = s;
  }

  // ------------------------------------------------------------------ the card of a box or an arrow
  function target(key) {
    const dg = currentDg(); if (!dg || !key) return null;
    if (key[0] === 'n') { const n = dg.nodes.find((x) => x.id === key.slice(2)); return n ? { dg, node: n, t: n } : null; }
    const e = dg.edges[Number(key.slice(2))];
    return e ? { dg, edge: e, t: e } : null;
  }
  const busy = new Set(); // the questions Claude is answering (an arrow is named by its end points: its index can change)
  const busyTag = (x, mode) => `${x.dg.id}|${x.node ? 'n:' + x.node.id : 'e:' + x.edge.from + '>' + x.edge.to}|${mode}`;
  function cardHtml(key) {
    const x = target(key); if (!x) return '';
    if (card && card.edit) return editHtml(key);
    const { dg, node, edge, t } = x;
    const name = (id) => (dg.nodes.find((n) => n.id === id) || {}).label || 'Untitled';
    const group = node && dg.groups.find((g) => g.id === node.group);
    const wait = (mode) => busy.has(busyTag(x, mode));
    const btn = (mode, icon, label, hint) => `<button data-more="${mode}" title="${hint}" ${wait(mode) ? 'disabled aria-busy="true"' : ''}>${wait(mode) ? '<span class="spin"></span>' : RT.icon(icon)}${label}</button>`;
    const has = (mode) => (t.more || []).some((m) => m.mode === mode);
    return `
      <div class="dg-card-h"><span class="badge">${node ? esc(TYPE_NAME[node.type] || 'Step') : 'Arrow'}</span><b>${node ? rich(node.label || 'Untitled') : `${rich(name(edge.from))} → ${rich(name(edge.to))}`}</b>
        ${card && card.pinned ? `<button class="ib ghost" data-close title="Close" aria-label="Close">${RT.icon('close')}</button>` : ''}</div>
      ${group ? `<div class="dg-card-g">${esc(group.label)}</div>` : ''}
      ${edge && edge.label ? `<div class="dg-card-g">${rich(edge.label)}</div>` : ''}
      ${t.desc ? `<p class="dg-desc">${richCite(t.desc)}</p>` : ''}
      ${node && node.explain ? `<p class="dg-explain">${richCite(node.explain)}</p>` : ''}
      ${(t.more || []).map((m) => `<div class="dg-ex dg-ex-${esc(m.mode)}"><span>${m.mode === 'example' ? 'Example' : 'In simpler words'}</span>${richCite(m.text)}</div>`).join('')}
      <div class="dg-card-actions">
        ${btn('example', I.bulb, has('example') ? 'Another example' : 'Example', 'Too abstract? Ask Claude for a concrete example')}
        ${btn('simpler', I.simpler, 'Simpler', 'Ask Claude to explain it again in simpler words')}
        <span class="spacer"></span>
        ${node && node.page && view.item.pdf ? `<button data-page="${node.page}" title="Go to page ${node.page} of the PDF, where this is described">p. ${node.page}</button>` : ''}
        <button class="ib" data-edit title="Edit this ${node ? 'box' : 'arrow'} by hand" aria-label="Edit by hand">${RT.icon('pencil')}</button>
        <button class="ib" data-ask title="Ask your own question about this in the Claude panel" aria-label="Ask Claude about this">${RT.icon(I.chat)}</button>
      </div>`;
  }
  function placeCard() {
    const el = view && $('#dg-card', view.host);
    if (!el || !card || !card.anchor.isConnected) return;
    const host = view.host.getBoundingClientRect(), a = card.anchor.getBoundingClientRect();
    const w = Math.min(380, host.width - 16);
    el.style.width = w + 'px';
    el.style.maxHeight = '';
    let h = el.offsetHeight;
    let left = a.left + a.width / 2 - w / 2 - host.left;
    left = Math.max(8, Math.min(left, host.width - w - 8));
    const below = host.height - 8 - (a.bottom - host.top + 6), above = a.top - host.top - 6 - 8;
    let top;
    if (h <= below) top = a.bottom - host.top + 6;
    else if (h <= above) top = a.top - host.top - 6 - h;
    else if (Math.max(below, above) >= 160) { // fits on neither side: the larger side, scrolling inside the card, so the box stays in view
      el.style.maxHeight = Math.max(below, above) + 'px'; h = el.offsetHeight;
      top = below >= above ? a.bottom - host.top + 6 : a.top - host.top - 6 - h;
    } else top = host.height - h - 8;
    el.style.left = left + 'px'; el.style.top = Math.max(8, Math.min(top, Math.max(8, host.height - h - 8))) + 'px';
  }
  function showCard(anchor, pinned = false) {
    const key = anchor.dataset.key, el = view && $('#dg-card', view.host);
    if (!el || !target(key)) return;
    clearTimeout(hideTimer);
    if (card && card.key === key && card.pinned && !pinned) return;
    card = { key, pinned, anchor, edit: pinned && editing };
    $$('.dg-on', view.host).forEach((n) => n.classList.remove('dg-on'));
    $$(`[data-key="${CSS.escape(key)}"]`, view.host).forEach((n) => n.classList.add('dg-on'));
    el.innerHTML = cardHtml(key); el.hidden = false; el.classList.toggle('pinned', pinned);
    renderMath(el); placeCard();
  }
  function refreshCard() {
    const el = view && $('#dg-card', view.host);
    if (!el || !card) return;
    const y = el.scrollTop;
    el.innerHTML = cardHtml(card.key); renderMath(el); placeCard(); el.scrollTop = y;
  }
  function hideCard(now = false) {
    clearTimeout(hideTimer); clearTimeout(showTimer);
    const close = () => {
      if (view) { const el = $('#dg-card', view.host); if (el) el.hidden = true; $$('.dg-on', view.host).forEach((n) => n.classList.remove('dg-on')); }
      card = null; keepKeys();
    };
    if (now) close(); else hideTimer = setTimeout(close, 260);
  }

  async function askMore(mode) {
    if (!card || !view) return;
    const x = target(card.key); if (!x) return;
    const { dg } = x, key = card.key, itemId = view.item.id, tag = busyTag(x, mode);
    if (busy.has(tag)) return;
    const from = x.edge && x.edge.from, to = x.edge && x.edge.to;
    let live = null;
    busy.add(tag);
    if (!card.pinned) { card.pinned = true; $('#dg-card', view.host).classList.add('pinned'); } // the answer needs somewhere to land
    refreshCard();
    try {
      await flushSaves(); // Claude answers about the box as it is now
      if (saves.has(dg.id)) throw new Error('the diagram could not be saved first - try again in a moment');
      const body = key[0] === 'n' ? { node: key.slice(2) } : { edge: Number(key.slice(2)) };
      const r = await api(`/api/items/${itemId}/diagrams/${dg.id}/explain`, { method: 'POST', json: { ...body, mode, language: lang() } });
      // dg is the object kept in the cache; an undo may have replaced its boxes and arrows meanwhile
      live = x.node ? dg.nodes.find((n) => n.id === x.node.id) : dg.edges.find((e) => e.from === from && e.to === to);
      if (live) live.more = r.more;
      else { // deleted or reversed meanwhile: an undo / redo that brings it back must bring the answer too
        const h = hist.get(dg.id);
        for (const stack of h ? [h.undo, h.redo] : []) stack.forEach((json, k) => {
          const s = JSON.parse(json);
          const t = x.node ? s.nodes.find((n) => n.id === x.node.id) : s.edges.find((e) => e.from === from && e.to === to);
          if (t) { t.more = r.more; stack[k] = JSON.stringify(s); }
        });
      }
    } catch (e) { toast('Claude could not answer: ' + e.message, 'bad'); }
    busy.delete(tag);
    if (view && view.item.id === itemId && card && currentDg() === dg && live && (target(card.key) || {}).t === live && !card.edit) { refreshCard(); const el = $('#dg-card', view.host); el.scrollTop = el.scrollHeight; }
  }

  // ------------------------------------------------------------------ drawing with Claude
  async function generate(kind, focus) {
    if (!view) return;
    const item = view.item, id = item.id;
    if (gens.has(id)) return;
    const ctrl = new AbortController(), gen = { ctrl, status: 'Starting…' };
    gens.set(id, gen);
    const paint = () => { if (view && view.item.id === id) { const el = $('#dg-status', view.host); if (el) el.innerHTML = `<span class="spin"></span> ${esc(gen.status)}`; } };
    if (view.item.id === id) render();
    let done = null, error = null;
    try {
      const r = await fetch(`/api/items/${id}/diagrams`, { method: 'POST', signal: ctrl.signal, headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, focus, language: lang() }) });
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
          if (ev.type === 'status') { gen.status = ev.text; paint(); }
          else if (ev.type === 'done') done = ev;
          else if (ev.type === 'error') error = ev.text;
        }
      }
      if (!done && !error) error = 'The connection closed before the diagram was finished.';
    } catch (e) { error = e.name === 'AbortError' ? 'Stopped - no diagram was drawn.' : e.message; }
    gens.delete(id);
    if (done) {
      const mine = new Map(state(id).diagrams.map((g) => [g.id, g])); // keep the copies on screen: they may hold edits not sent yet
      cache.set(id, { diagrams: done.diagrams.map((g) => mine.get(g.id) || g), sel: done.diagram.id }); toast(`Diagram drawn: “${done.diagram.title}” — point at a box to read its explanation.`, 'ok');
    } else toast(error, 'bad');
    if (view && view.item.id === id) render();
  }

  // ------------------------------------------------------------------ Mermaid / Markdown
  const mmText = (s) => String(s).replace(/\$([^$\n]{1,200})\$/g, '$1').replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
  function mermaid(dg) {
    const shape = (n) => {
      const l = `"${mmText(n.label || 'Untitled')}"`;
      return n.type === 'decision' ? `{${l}}` : n.type === 'input' || n.type === 'output' ? `([${l}])` : n.type === 'data' ? `[(${l})]` : n.type === 'concept' ? `(${l})` : `[${l}]`;
    };
    const lines = ['flowchart TD'];
    const inGroup = new Set();
    for (const g of dg.groups) {
      lines.push(`  subgraph ${g.id}["${mmText(g.label)}"]`);
      for (const n of dg.nodes) if (n.group === g.id) { lines.push(`    ${n.id}${shape(n)}`); inGroup.add(n.id); }
      lines.push('  end');
    }
    for (const n of dg.nodes) if (!inGroup.has(n.id)) lines.push(`  ${n.id}${shape(n)}`);
    for (const e of dg.edges) lines.push(`  ${e.from} -->${e.label ? `|"${mmText(e.label)}"|` : ''} ${e.to}`);
    return lines.join('\n');
  }
  const noteMd = (dg) => `**${dg.title}**\n\n\`\`\`mermaid\n${mermaid(dg)}\n\`\`\`\n\n${dg.nodes.map((n, k) => `${k + 1}. **${n.label || 'Untitled'}**${n.desc ? ' — ' + n.desc : ''}`).join('\n')}`;

  // ------------------------------------------------------------------ events (one set per host element)
  function wire(host) {
    const keyEl = (t) => (t.closest ? t.closest('[data-key]') : null);
    host.tabIndex = -1; // a click on the background keeps the keyboard in the panel (undo, Esc)
    host.addEventListener('mouseover', (e) => {
      if (drag && drag.moving) return;
      const k = keyEl(e.target);
      if (k) { clearTimeout(hideTimer); clearTimeout(showTimer); if (!linking && (!card || !card.pinned)) showTimer = setTimeout(() => showCard(k), card ? 60 : 140); }
      else if (e.target.closest('#dg-card')) clearTimeout(hideTimer);
    });
    host.addEventListener('mouseout', (e) => {
      if (!(keyEl(e.target) || e.target.closest('#dg-card'))) return;
      const to = e.relatedTarget;
      if (to && to.closest && (to.closest('#dg-card') || keyEl(to))) return;
      clearTimeout(showTimer);
      if (card && !card.pinned) hideCard();
    });
    host.addEventListener('focusin', (e) => { const k = keyEl(e.target); if (k && !linking && !drag && (!card || !card.pinned)) showCard(k); });
    // ---- moving a box by hand (edit mode)
    host.addEventListener('pointerdown', (e) => {
      const el = editing && !linking && e.button === 0 && !e.ctrlKey && e.isPrimary !== false && view && e.target.closest ? e.target.closest('.dg-node') : null;
      const x = el && target(el.dataset.key);
      if (!x || (drag && drag.moving)) return; // a press whose release never arrived is simply replaced
      const sc = $('#dg-scroll', host), cv = $('#dg-canvas', host), sx = Number(cv.dataset.sx) || 0, sy = Number(cv.dataset.sy) || 0;
      drag = { el, node: x.node, dg: x.dg, id: e.pointerId, px: e.clientX, py: e.clientY, cx: e.clientX, cy: e.clientY, x0: el.offsetLeft - sx, y0: el.offsetTop - sy, sx, sy, sc, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0,
        scale: Number(($('#dg-fit', host) || { dataset: {} }).dataset.scale) || 1, moving: false, raf: 0 };
    });
    // the box follows the pointer, also when the panel is scrolled during the drag
    const dragMove = () => {
      const d = drag; if (!d) return;
      const dx = d.cx - d.px + (d.sc ? d.sc.scrollLeft - d.sl : 0), dy = d.cy - d.py + (d.sc ? d.sc.scrollTop - d.st : 0);
      if (!d.moving) {
        if (Math.hypot(dx, dy) < 5) return;
        d.moving = true; record(d.dg);
        clearTimeout(showTimer); clearTimeout(drawTimer); hideCard(true);
        try { d.el.setPointerCapture(d.id); } catch { /* the pointer is gone */ }
        d.el.classList.add('dg-drag');
      }
      d.node.x = Math.min(8000, Math.max(-8000, Math.round(d.x0 + dx / d.scale)));
      d.node.y = Math.min(8000, Math.max(-8000, Math.round(d.y0 + dy / d.scale)));
      if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; if (drag === d) place(); });
    };
    host.addEventListener('pointermove', (e) => {
      const d = drag; if (!d || e.pointerId !== d.id) return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) return drop(e); // the button was released where we could not see it
      d.cx = e.clientX; d.cy = e.clientY; dragMove();
    });
    const drop = (e) => {
      const d = drag; if (!d || e.pointerId !== d.id) return;
      drag = null;
      if (!d.moving) return;
      cancelAnimationFrame(d.raf);
      skipClick = true; setTimeout(() => { skipClick = false; }, 0);
      changed(d.dg, true); paintTools();
    };
    host.addEventListener('pointerup', drop);
    host.addEventListener('pointercancel', drop);
    host.addEventListener('keydown', (e) => {
      const z = (e.metaKey || e.ctrlKey) && !e.altKey ? e.key.toLowerCase() : '';
      if (editing && (z === 'z' || z === 'y') && !(e.target.closest && e.target.closest('input, textarea, select'))) { // inside a field the browser undoes the typing
        e.preventDefault(); step(z === 'y' || e.shiftKey ? 1 : -1); return;
      }
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return; // Esc that closes an input-method window is not ours
      if (linking) { setLinking(null); e.stopPropagation(); }
      else if (card) { hideCard(true); e.stopPropagation(); }
    });
    host.addEventListener('input', (e) => { const t = e.target; if (t.dataset && (t.dataset.f || t.dataset.h || t.dataset.g)) onField(t); });
    host.addEventListener('submit', (e) => {
      if (e.target.id !== 'dg-form') return;
      e.preventDefault();
      generate($('#dg-kind', host).value, $('#dg-focus', host).value.trim());
    });
    host.addEventListener('change', (e) => {
      if (e.target.id === 'dg-pick' && view) { state(view.item.id).sel = e.target.value; render(); }
      else if (e.target.dataset && e.target.dataset.g && !e.target.value.trim()) { // an emptied group name goes back to what it was
        const cur = currentDg(), g = cur && cur.groups.find((y) => y.id === e.target.dataset.g);
        if (g) e.target.value = g.label;
      }
    });
    let downInCard = false; // a press that began in the card (selecting text, resizing a field) and ended outside it
    host.addEventListener('mousedown', (e) => { downInCard = !!(e.target.closest && e.target.closest('#dg-card')); }, true);
    host.addEventListener('click', async (e) => {
      if (!view) return;
      const fromCard = downInCard; downInCard = false;
      if (skipClick) { skipClick = false; return; }
      if (fromCard && !e.target.closest('#dg-card')) return;
      const t = e.target, dg = currentDg();
      const k = keyEl(t);
      if (k && linking) { // the second click of "Arrow to…"
        const from = linking.from, to = k.dataset.key[0] === 'n' ? k.dataset.key.slice(2) : null;
        setLinking(null);
        if (!to || to === from || !dg) return;
        let at = dg.edges.findIndex((x) => x.from === from && x.to === to);
        if (at >= 0) toast('These two boxes are already joined by an arrow in that direction.');
        else { record(dg); dg.edges.push({ from, to, label: '', desc: '', more: [] }); at = dg.edges.length - 1; hideCard(true); changed(dg, true); }
        openEdit('e:' + at);
        return;
      }
      if (linking && !t.closest('#dg-zoom-in, #dg-zoom-out, #dg-zoom-fit')) setLinking(null);
      if (k) {
        clearTimeout(showTimer);
        if (card && card.pinned && card.key === k.dataset.key) hideCard(true);
        else { showCard(k, true); if (card && card.edit) { const f = $('#dg-card [data-f]', host); if (f) f.focus({ preventScroll: true }); } }
        return;
      }
      if (t.closest('#dg-card')) {
        const x = target(card && card.key);
        if (t.dataset.more) askMore(t.dataset.more);
        else if (t.dataset.close != null || t.dataset.done != null) hideCard(true);
        else if (t.dataset.edit != null && card) { editing = true; paintMode(); card.pinned = true; card.edit = true; $('#dg-card', host).classList.add('pinned'); refreshCard(); const f = $('#dg-card [data-f]', host); if (f) f.focus(); }
        else if (t.dataset.link != null && x && x.node) { hideCard(true); setLinking(x.node.id); }
        else if (t.dataset.next != null && x && x.node) {
          if (dg.nodes.length >= 40) return toast('A diagram can have at most 40 boxes.', 'bad');
          record(dg);
          const n = newBox(dg, x.node.group);
          if (pinned(x.node)) { // a box that was placed by hand gets its new box right below it, beside any box already there
            n.x = x.node.x; n.y = Math.min(8000, x.node.y + (((sizes && sizes.get(x.node.id)) || {}).h || 50) + VGAP);
            for (let k = 0; k < 40 && n.x + NODE_W + SEP <= 8000 && dg.nodes.some((m) => pinned(m) && Math.abs(m.x - n.x) < NODE_W && Math.abs(m.y - n.y) < 40); k++) n.x += NODE_W + SEP;
          }
          dg.nodes.push(n); dg.edges.push({ from: x.node.id, to: n.id, label: '', desc: '', more: [] });
          hideCard(true); changed(dg, true); openEdit('n:' + n.id);
        }
        else if (t.dataset.reverse != null && x && x.edge) {
          if (dg.edges.some((y) => y.from === x.edge.to && y.to === x.edge.from)) return toast('There is already an arrow in the other direction.');
          record(dg);
          [x.edge.from, x.edge.to] = [x.edge.to, x.edge.from]; x.edge.more = [];
          changed(dg, true); refreshCard();
        }
        else if (t.dataset.remove != null && x && x.edge) { record(dg); dg.edges.splice(dg.edges.indexOf(x.edge), 1); hideCard(true); changed(dg, true); }
        else if (t.dataset.remove != null && x && x.node) {
          if (dg.nodes.length < 2) return toast('This is the last box - delete the whole diagram with the bin in the bar instead.', 'bad');
          const arrows = dg.edges.filter((y) => y.from === x.node.id || y.to === x.node.id).length;
          if (!(await RT.confirm(`Delete the box “${x.node.label || 'Untitled'}”${arrows ? ` and its ${arrows} arrow${arrows > 1 ? 's' : ''}` : ''}?\n\nIts explanation and examples are deleted with it. Undo in the bar brings it back.`, { title: 'Delete box', okText: 'Delete', danger: true }))) return;
          record(dg);
          dg.nodes = dg.nodes.filter((y) => y !== x.node); dg.edges = dg.edges.filter((y) => y.from !== x.node.id && y.to !== x.node.id);
          hideCard(true); changed(dg, true);
        }
        else if (t.dataset.page && view.hooks.page) view.hooks.page(Number(t.dataset.page));
        else if (t.dataset.ask != null) {
          if (!x) return;
          const what = x.node ? `the box “${x.node.label}”` : `the arrow from “${(x.dg.nodes.find((n) => n.id === x.edge.from) || {}).label}” to “${(x.dg.nodes.find((n) => n.id === x.edge.to) || {}).label}”`;
          const box = $('#claude-input');
          RT.claude.toggle(true);
          if (box) { box.value = `In the diagram “${x.dg.title}” of the paper “${view.item.fields.title || view.item.citekey}”, about ${what} (${x.t.desc}): `; box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
        }
        return;
      }
      if (card && card.pinned) hideCard(true);
      if (t.id === 'dg-edit') { editing = !editing; paintMode(); }
      else if (t.id === 'dg-undo') step(-1);
      else if (t.id === 'dg-redo') step(1);
      else if (t.id === 'dg-tidy' && dg) { record(dg); for (const n of dg.nodes) { delete n.x; delete n.y; } changed(dg, true); paintTools(); }
      else if (t.id === 'dg-add-box' && dg) {
        if (dg.nodes.length >= 40) return toast('A diagram can have at most 40 boxes.', 'bad');
        record(dg);
        const n = newBox(dg); dg.nodes.push(n); changed(dg, true); openEdit('n:' + n.id);
      }
      else if (t.dataset.gadd != null && dg && dg.groups.length < 8) {
        const g = { id: freshId(dg, 'g'), label: 'New group' };
        record(dg); dg.groups.push(g); queueSave(dg); paintHead();
        const inp = $(`#dg-head [data-g="${CSS.escape(g.id)}"]`, host); if (inp) { inp.focus(); inp.select(); }
      }
      else if (t.dataset.gdel && dg) {
        record(dg);
        dg.groups = dg.groups.filter((g) => g.id !== t.dataset.gdel);
        for (const n of dg.nodes) if (n.group === t.dataset.gdel) n.group = '';
        paintHead(); changed(dg, true);
      }
      else if (t.id === 'dg-new') { const f = $('#dg-form', host); f.hidden = !f.hidden; t.classList.toggle('on', !f.hidden); if (!f.hidden) $('#dg-focus', host).focus(); }
      else if (t.id === 'dg-stop') { const g = gens.get(view.item.id); if (g) g.ctrl.abort(); }
      else if (t.id === 'dg-zoom-in' || t.id === 'dg-zoom-out') {
        const cur = Number($('#dg-fit', host).dataset.scale) || 1;
        zoom = Math.min(2, Math.max(0.35, Math.round((cur + (t.id === 'dg-zoom-in' ? 0.15 : -0.15)) * 100) / 100)); applyZoom();
      }
      else if (t.id === 'dg-zoom-fit') { zoom = 0; applyZoom(); }
      else if (t.id === 'dg-copy' && dg) {
        try { await navigator.clipboard.writeText(mermaid(dg)); toast('Copied as Mermaid', 'ok'); } catch { toast('Could not copy to the clipboard', 'bad'); }
      }
      else if (t.id === 'dg-insert' && dg && view.hooks.insert) { view.hooks.insert(noteMd(dg)); }
      else if (t.id === 'dg-del' && dg) {
        if (!(await RT.confirm(`Delete the diagram “${dg.title}”?\n\nIts explanations and examples are deleted with it, and this cannot be undone.`, { title: 'Delete diagram', okText: 'Delete', danger: true }))) return;
        const pending = saves.has(dg.id);
        try {
          dropSave(dg.id); await saveChain; // an edit on its way must not arrive after the delete
          const id = view.item.id, r = await api(`/api/items/${id}/diagrams/${dg.id}`, { method: 'DELETE' });
          hist.delete(dg.id);
          const mine = new Map(state(id).diagrams.map((g) => [g.id, g])); // the copies on screen may hold edits not sent yet
          cache.set(id, { diagrams: r.diagrams.map((g) => mine.get(g.id) || g), sel: (r.diagrams[0] || {}).id || null });
          if (view && view.item.id === id) render();
        } catch (err) { if (err.status === 404) hist.delete(dg.id); else if (pending) queueSave(dg); toast(err.message, 'bad'); }
      }
    });
    host.addEventListener('scroll', () => { if (drag && drag.moving) return dragMove(); if (card && !card.pinned) hideCard(true); else placeCard(); }, true);
    new ResizeObserver(() => { if (view && view.host === host && $('#dg-canvas', host)) { if (!$('#dg-canvas', host).dataset.w) draw(); else applyZoom(); placeCard(); } }).observe(host);
  }

  Object.assign(RT.diagram, { show, layout, mermaid, rich, renderMath, forget: (id) => cache.delete(id) }); // rich / renderMath: text with $formulas$, shared with quiz.js
})();
