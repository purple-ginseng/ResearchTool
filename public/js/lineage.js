/* Lineage window (#dlg-lineage): where a set of library papers comes from and where it went - the ideas of Connected
   Papers for the whole library, one category / research line, a project's papers or one paper with its neighbours.
     left    the set's papers (the origin), newest first
     centre  "History line" (the papers on a time axis, one lane per research line / sub-line, an arrow from a paper
             to each later library paper that cites it) | "Prior works" (the works the set's papers cite most) |
             "Derivative works" (the works that cite most of the set's papers); tables sortable, CSV / BibTeX
     right   the selected paper or work: authors, year, venue, citations, abstract (OpenAlex), Open / Add to library
   Nothing is asked of OpenAlex / Semantic Scholar until the user presses Look up; only DOIs / arXiv ids / OpenAlex ids
   are sent (lib/lineage.js). Entry points: the Library toolbar button #btn-lineage (injected here, after
   #btn-regroup), RT.lineage.open({scope, category, pid, id}) and the event 'lineage:open' with the same object (the
   reader's Related tab), and "Lineage of this line / category" in the ⋯ menu of a category header
   (RT.categories.headerExtras).
   Tables: "Most relevant" first (lib/lineage.js: cited by these papers and by the rest of the library, hub papers
   damped, "generic" works hidden unless asked; every row says why in its tooltip), filters (years, not in library /
   project, surveys, venue type, open PDF; per tab in rt.lineage.filters), row checkboxes with a selection bar.
   Add to project: a target project of its own (the scope's project, else the one picked here - rt.lineage.toProject -
   else the working project; the app's working project is never changed from here); rows, Add all, the details pane
   and the menu of a history-line node (right click, Shift+F10) add works to it - imported into the library first when
   needed - with one summary toast whose Undo takes them out of the project only (RT.projectPapers.toggle).
   The pure functions at the top also run under node (scripts/test-lineage.js). */
(() => {
  // ================================================================== pure: lanes, scale, layout
  const DAY = 86400000;
  // a short label for a node: the name before the colon ("PhysVLMM: ..." -> "PhysVLMM"), else the first words
  function shortName(title, max = 22) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const head = t.split(/:\s| - | – /)[0].trim();
    if (head && head.length <= max && head.length < t.length) return head;
    let out = '';
    for (const w of t.split(' ')) { if ((out + ' ' + w).trim().length > max) break; out = (out + ' ' + w).trim(); }
    return out || t.slice(0, max);
  }
  // the label of a node on the history line: the name before the colon when the title has one ("RMA"), else
  // "Surname Year" of the first author ("Schulman 2017"), else the first words with an ellipsis
  function nodeLabel(title, { first = '', year = '' } = {}, max = 22) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const head = t.split(/:\s| - | – /)[0].trim();
    if (head && head.length <= max && head.length < t.length) return head;
    if (t.length <= max) return t;
    const sur = surname(first);
    if (sur) return year ? sur + ' ' + year : sur;
    return shortName(t, max - 1) + '…';
  }
  // ---- authors: BibTeX fields as people write them ("Kumar, Ashish", "{EngineAI}", "Intelligence, Physical")
  // an organisation, not a person: kept whole ("Physical Intelligence", "Archon Robotics", "NVIDIA")
  const ORG_RE = /\b(intelligence|robotics|ai|team|labs?|laboratory|laboratories|inc|corp(oration)?|research|deepmind|openai|google|nvidia|meta|microsoft|alibaba|bytedance|tencent|collaboration|consortium|group|institute|university|technolog(y|ies)|systems|foundation|dynamics|unitree|engine\w*)\b/i;
  // one author as "First Last" (braces gone; "Last, First" turned round); '' for junk such as "{:}"
  function authorName(raw) {
    let a = String(raw || '').replace(/[{}]/g, '').replace(/\\[a-zA-Z]+\s*/g, '').replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(a)) return '';
    if (a.includes(',')) { const [last, ...first] = a.split(','); a = (first.join(' ').trim() + ' ' + last.trim()).trim(); }
    return a;
  }
  const isOrg = (name) => { const n = String(name || '').trim(); return !!n && (!/\s/.test(n) ? /[A-Z].*[A-Z]|^[A-Z0-9]+$/.test(n) || ORG_RE.test(n) : ORG_RE.test(n)); };
  // the name a label uses: an organisation whole, a person by the surname ("Kevin Black" -> "Black")
  const surname = (name) => { const n = authorName(name); return !n ? '' : isOrg(n) ? n : n.split(' ').pop(); };
  // the authors of a BibTeX field as "First Last" names
  const authorList = (field) => String(field || '').split(/\s+and\s+/i).map(authorName).filter(Boolean);
  // the first author of a BibTeX author field for a label ("Kumar, Ashish and ..." -> "Kumar", "Intelligence,
  // Physical and ..." -> "Physical Intelligence")
  const bibFirst = (author) => surname(authorList(author)[0] || '');
  // "Black et al.", "Physical Intelligence et al.", "Kumar & Fu"
  function authorsShort(field) {
    const a = authorList(field);
    if (!a.length) return '';
    return a.length > 2 ? surname(a[0]) + ' et al.' : a.map(surname).join(' & ');
  }
  // ---- titles: inline LaTeX as text ("$π_0$" -> "π₀", "$\pi_{0.5}$" -> "π0.5", "{VLA}" -> "VLA")
  const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', times: '×', cdot: '·', infty: '∞', leq: '≤', geq: '≥', to: '→', rightarrow: '→', star: '*', ast: '*' };
  const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋' };
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
  function texPlain(title) {
    let t = String(title || '');
    if (!/[$\\{}^_]/.test(t)) return t;
    const script = (body, map) => { const b = body.replace(/[{}]/g, ''); return [...b].every((c) => map[c]) ? [...b].map((c) => map[c]).join('') : b; };
    const math = (m) => m.replace(/\\([A-Za-z]+)\s*/g, (x, n) => GREEK[n] || n)
      .replace(/_(\{[^{}]*\}|.)/g, (x, b) => script(b, SUB)).replace(/\^(\{[^{}]*\}|.)/g, (x, b) => script(b, SUP)).replace(/[{}]/g, '');
    t = t.replace(/\$([^$]*)\$/g, (x, m) => math(m));
    t = t.replace(/\\([&%$#_{}])/g, '$1').replace(/\\([A-Za-z]+)\s*/g, (x, n) => GREEK[n] || '').replace(/[{}]/g, '').replace(/\$/g, '');
    return t.replace(/\s+/g, ' ').trim();
  }
  // ---- the table filters (B2), pure: venue type, surveys, the filter set
  const CONF_RE = /\b(conference|proceedings|symposium|workshop|cvpr|iccv|eccv|neurips|nips|icml|iclr|icra|iros|corl|rss|aaai|ijcai|siggraph|humanoids|robotics: science and systems|neural information processing|learning representations|computer vision and pattern)\b/i;
  function venueType(e) {
    const v = String((e && e.venue) || '');
    if (e && e.vtype === 'conference') return 'conference';
    if (e && e.vtype === 'repository') return 'preprint';
    if (/^(arxiv|biorxiv|medrxiv|ssrn|research square|openreview)\b/i.test(v) || (!v && e && e.arxiv)) return 'preprint';
    if (CONF_RE.test(v)) return 'conference';
    if (e && e.vtype === 'journal') return 'journal';
    return v ? 'journal' : '';
  }
  const isSurvey = (e) => !!e && (e.type === 'review' || /\b(survey|review|tutorial|overview)\b/i.test(String(e.title || '')) || (e.nrefs || 0) > 150);
  const FILTERS0 = { from: '', to: '', notLib: false, notProj: false, survey: '', vtype: '', oa: false, hideGeneric: true };
  // rows [{e, i}] -> the ones that pass the filters f; inProject(e) -> true when e is in the target project
  function filterRows(rows, f = FILTERS0, { inProject = () => false } = {}) {
    const from = Number(f.from) || 0, to = Number(f.to) || 0;
    return rows.filter(({ e }) => {
      if (f.hideGeneric && e.generic) return false;
      if (from && !(e.year >= from)) return false;
      if (to && !(e.year <= to)) return false;
      if (f.notLib && e.inLibrary) return false;
      if (f.notProj && inProject(e)) return false;
      if (f.survey === 'only' && !isSurvey(e)) return false;
      if (f.survey === 'hide' && isSurvey(e)) return false;
      if (f.vtype && venueType(e) !== f.vtype) return false;
      if (f.oa && !(e.oa || e.arxiv)) return false;
      return true;
    });
  }
  // the works an "Add to project" handles, three ways: in the library already (their ids), to import first, skipped
  // (no DOI or arXiv id). inProject(id) -> true for a library id that is a member already (left out)
  function splitForProject(entries, inProject = () => false) {
    const inLib = [], importable = [], skipped = [];
    let already = 0;
    for (const x of entries) {
      const e = x.e || x;
      if (e.inLibrary) { if (inProject(e.inLibrary)) already++; else inLib.push(x); }
      else if (e.ref) importable.push(x);
      else skipped.push(x);
    }
    return { inLib, importable, skipped, already };
  }
  // the project the Lineage adds to: the one picked here, else the scope's project, else the one remembered, else the
  // working project; only one that exists. -> pid | null
  function projectTarget({ picked = null, scopePid = null, stored = null, working = null } = {}, exists = () => true) {
    for (const p of [picked, scopePid, stored, working]) if (p && exists(p)) return p;
    return null;
  }
  // lanes from the categories: a research line and its sub-lines ("Line / Sub-line") next to each other, the line with
  // most papers first; inside a line the line itself first, then its sub-lines by size.
  // -> [{name, line, sub, count, first}]
  function laneOrder(papers, uncat = 'Uncategorized') {
    const per = new Map();
    for (const p of papers) { const c = p.category || uncat; per.set(c, (per.get(c) || 0) + 1); }
    const lines = new Map();
    for (const [name, n] of per) {
      const i = name.indexOf(' / ');
      const line = i > 0 ? name.slice(0, i) : name;
      if (!lines.has(line)) lines.set(line, { line, count: 0, lanes: [] });
      const L = lines.get(line); L.count += n; L.lanes.push({ name, line, sub: i > 0 ? name.slice(i + 3) : '', count: n });
    }
    const order = [...lines.values()].sort((a, b) => Number(a.line === uncat) - Number(b.line === uncat) || b.count - a.count || a.line.localeCompare(b.line));
    const out = [];
    for (const L of order) {
      L.lanes.sort((a, b) => Number(!!a.sub) - Number(!!b.sub) || b.count - a.count || a.name.localeCompare(b.name));
      L.lanes.forEach((ln, i) => out.push({ ...ln, first: i === 0, lineCount: L.count }));
    }
    return out;
  }
  const tOf = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? t : NaN; };
  // the x axis. mode 'time': linear, pxPerDay; 'even': the papers one step apart in date order (crowded months spread
  // out), year ticks at the first paper of each year. -> {x(date) -> px, width, ticks [{x, label, major}]}
  // In time mode `focus` (a date) with `leftW` (px) squeezes everything before the focus into the first leftW pixels,
  // so a few old works do not push the bulk of the papers into a corner.
  function timeScale(dates, { mode = 'time', pxPerDay = 1, step = 26, pad = 30, focus = null, leftW = 0 } = {}) {
    const ts = dates.map(tOf).filter(Number.isFinite).sort((a, b) => a - b);
    if (!ts.length) return { x: () => pad, width: pad * 2, ticks: [] };
    if (mode === 'even') {
      const uniq = [...new Set(ts)];
      const idx = new Map(uniq.map((t, i) => [t, i]));
      const x = (d) => { const t = tOf(d); if (idx.has(t)) return pad + idx.get(t) * step; let i = 0; while (i < uniq.length && uniq[i] < t) i++; return pad + Math.max(0, i - 0.5) * step; };
      const ticks = [];
      let lastY = null, lastM = null;
      uniq.forEach((t, i) => {
        const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth();
        if (y !== lastY) ticks.push({ x: pad + i * step, label: String(y), major: true, year: y });
        else if (m !== lastM && step >= 18) ticks.push({ x: pad + i * step, label: d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }), major: false, year: y });
        lastY = y; lastM = m;
      });
      return { x, width: pad * 2 + (uniq.length - 1) * step, ticks };
    }
    const t0 = ts[0] - 20 * DAY, t1 = ts[ts.length - 1] + 20 * DAY;
    const tf = focus != null && Number.isFinite(tOf(focus)) && tOf(focus) - 20 * DAY > t0 ? tOf(focus) - 20 * DAY : null;
    const lin = (t) => pad + (t - t0) / DAY * pxPerDay;
    const x = tf == null ? (d) => { const t = tOf(d); return lin(Number.isFinite(t) ? t : t0); }
      : (d) => { let t = tOf(d); if (!Number.isFinite(t)) t = t0; return t < tf ? pad + (t - t0) / (tf - t0) * leftW : pad + leftW + (t - tf) / DAY * pxPerDay; };
    const fullW = tf == null ? (t1 - t0) / DAY * pxPerDay : leftW + (t1 - tf) / DAY * pxPerDay;
    const ticks = [];
    const yearPx = 365 * pxPerDay;
    const s = new Date(t0), e = new Date(t1);
    for (let y = s.getUTCFullYear(); y <= e.getUTCFullYear(); y++) {
      for (let m = 0; m < 12; m++) {
        const t = Date.UTC(y, m, 1);
        if (t < t0 || t > t1 || (tf != null && t < tf && m !== 0)) continue;
        const every = yearPx >= 900 ? 1 : yearPx >= 400 ? 3 : yearPx >= 160 ? 6 : 12;
        if (m === 0) ticks.push({ x: x(new Date(t).toISOString()), label: String(y), major: true, year: y });
        else if (m % every === 0) ticks.push({ x: x(new Date(t).toISOString()), label: new Date(t).toLocaleString('en', { month: 'short', timeZone: 'UTC' }), major: false, year: y });
      }
    }
    return { x, width: pad * 2 + fullW, ticks };
  }
  // nodes in lanes without overlap: each node takes [x, x + w] on a row of its lane; the first row where it fits
  // (after `gap`), else a new row. nodes: [{id, lane, x, w}], lanes: [{name}] -> {pos {id: {x, y, row}}, lanes
  // [{name, top, height, rows}], height}
  function layout(nodes, lanes, { rowH = 22, lanePad = 6, gap = 8, top = 0 } = {}) {
    const by = new Map(lanes.map((l) => [l.name, []]));
    for (const n of nodes) { if (!by.has(n.lane)) { by.set(n.lane, []); lanes = [...lanes, { name: n.lane }]; } by.get(n.lane).push(n); }
    const pos = {}, out = [];
    let y = top;
    for (const l of lanes) {
      const list = (by.get(l.name) || []).slice().sort((a, b) => a.x - b.x || String(a.id).localeCompare(String(b.id)));
      const ends = [];
      for (const n of list) {
        // a node may come with its row decided (n.row); else the first row where it fits
        let r = Number.isInteger(n.row) && n.row >= 0 ? n.row : ends.findIndex((e) => e + gap <= n.x);
        if (r < 0) r = ends.length;
        while (ends.length <= r) ends.push(0);
        ends[r] = Math.max(ends[r], n.x + (n.w || 0));
        pos[n.id] = { x: n.x, y: y + lanePad + r * rowH + rowH / 2, row: r };
      }
      const rows = Math.max(1, ends.length);
      const height = lanePad * 2 + rows * rowH;
      out.push({ ...l, top: y, height, rows });
      y += height;
    }
    return { pos, lanes: out, height: y };
  }
  // ---- B7: Seminal (4+ years old, cited 500+), Recent (the last 18 months), Rising (most of its citations in the
  // last two years: c2 = citations this year and last, OpenAlex counts_by_year)
  function badgesOf(e, now = Date.now()) {
    const out = [];
    if (!e) return out;
    const y = new Date(now).getUTCFullYear();
    const t = Date.parse(e.date || (e.year ? e.year + '-07-01' : ''));
    const months = Number.isFinite(t) ? (now - t) / (30.44 * DAY) : null;
    const cited = Number(e.cited) || 0;
    if (e.year && e.year <= y - 4 && cited >= 500) out.push('Seminal');
    if (months != null && months <= 18 && months >= -1) out.push('Recent');
    if (e.c2 != null && e.c2 >= 20 && e.c2 >= 0.6 * cited && !(months != null && months <= 6)) out.push('Rising');
    return out;
  }
  // ---- B6: the ancestors of a set's papers - the top k prior works (not generic, cited by >= 2 of them), each with its
  // citing papers per lane, "burst" when >= half of them are from the last 12 months; each paper's dominant ancestor
  // (of the ancestors it cites, the one most of the set cites). -> {anc [{j, i, e, citers, lanes Map, burst}], dominant}
  function ancestry(papers, prior, { k = 8, laneOf = (p) => p.category, now = Date.now() } = {}) {
    const byId = new Map(papers.map((p) => [p.id, p]));
    const cand = prior.map((e, i) => ({ e, i })).filter(({ e }) => !e.generic && e.count >= 2)
      .sort((a, b) => b.e.count - a.e.count || (b.e.relevance || 0) - (a.e.relevance || 0) || a.i - b.i).slice(0, k);
    const anc = cand.map(({ e, i }, j) => {
      const citers = (e.citers || []).filter((id) => byId.has(id));
      const lanes = new Map();
      for (const id of citers) { const l = laneOf(byId.get(id)); if (!lanes.has(l)) lanes.set(l, []); lanes.get(l).push(id); }
      const recent = citers.filter((id) => { const t = Date.parse(byId.get(id).date); return Number.isFinite(t) && now - t <= 365 * DAY; }).length;
      return { j, i, e, citers, lanes, burst: citers.length >= 2 && recent / citers.length >= 0.5 };
    });
    const dominant = new Map();
    for (const a of anc) for (const id of a.citers) if (!dominant.has(id)) dominant.set(id, a.j);
    return { anc, dominant };
  }
  // ---- B8: BibTeX that keeps the case of acronyms and names ({OpenVLA}, {RT-2}) and files arXiv-only works as @misc
  function protectTitle(t) {
    return String(t || '').split(/(\s+)/).map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      const m = tok.match(/^([^\p{L}\p{N}\\]*)(.*?)([^\p{L}\p{N}]*)$/u);
      const [, a, core, b] = m || ['', '', tok, ''];
      return core && (/\p{Lu}/u.test(core.slice(1)) || (/\p{Lu}/u.test(core) && /\d/.test(core))) ? `${a}{${core}}${b}` : tok;
    }).join('');
  }
  const bibEsc = (s) => String(s || '').replace(/[{}\\]/g, '').replace(/([&%$#_])/g, '\\$1');
  function bibEntry(e, { key = 'work', note = '' } = {}) {
    const vt = venueType(e);
    const arxivOnly = !!e.arxiv && !e.doi;
    const type = arxivOnly ? 'misc' : e.doi && e.venue && e.venue !== 'arXiv' ? (vt === 'conference' ? 'inproceedings' : 'article') : 'misc';
    const au = (e.authors || []).map((a) => (isOrg(a) ? `{${bibEsc(a)}}` : bibEsc(a)));
    const f = [['title', `{${protectTitle(bibEsc(e.title))}}`], ['author', au.length ? `{${au.join(' and ')}${e.more ? ' and others' : ''}}` : ''], ['year', e.year ? `{${e.year}}` : ''],
      [type === 'inproceedings' ? 'booktitle' : type === 'article' ? 'journal' : '', type !== 'misc' ? `{${bibEsc(e.venue)}}` : ''],
      ['doi', e.doi ? `{${e.doi}}` : ''], ['eprint', e.arxiv ? `{${e.arxiv}}` : ''], ['archiveprefix', e.arxiv ? '{arXiv}' : ''],
      ['url', arxivOnly ? `{https://arxiv.org/abs/${e.arxiv}}` : ''], ['note', note ? `{${bibEsc(note)}}` : '']].filter(([k, v]) => k && v);
    return `@${type}{${key},\n${f.map(([a, v]) => `  ${a} = ${v}`).join(',\n')}\n}`;
  }
  // a cite key: surname + year + first long title word, unique among `used`
  // (an organisation by its first word: "Octo Model Team" -> octo; a title word may hold digits: omnih2o)
  function citeKey(e, used = new Set()) {
    const a0 = authorName((e.authors || [])[0] || '');
    const words = a0.split(/\s+/).filter(Boolean);
    const pick = !a0 ? 'anon' : isOrg(a0) ? words[0] : words[words.length - 1];
    const last = String(pick).normalize('NFKD').replace(/[^A-Za-z]/g, '').toLowerCase() || 'anon';
    const word = (String(e.title || '').toLowerCase().normalize('NFKD').match(/[a-z][a-z0-9]{3,}/) || ['work'])[0];
    const base = `${last}${e.year || ''}${word}`;
    let k = base, n = 2;
    while (used.has(k)) k = base + String.fromCharCode(95 + n++);
    used.add(k);
    return k;
  }
  // ---- B8: the grouped export - Foundational (the most relevant prior works), Recent (derivative and similar works of
  // the last two years), Surveys (from all three) -> [[name, [e]]]
  function groupedRows(d, { now = Date.now(), top = 15 } = {}) {
    const y = new Date(now).getUTCFullYear();
    const prior = (d.prior || []).filter((e) => !e.generic);
    const later = [...(d.derivative || []), ...(d.similar || [])];
    const seen = new Set();
    const uniq = (list) => list.filter((e) => { const k = e.w || e.key; if (seen.has(k)) return false; seen.add(k); return true; });
    const surveys = uniq([...prior, ...later].filter(isSurvey)).slice(0, top);
    const found = uniq(prior.filter((e) => !isSurvey(e))).slice(0, top);
    const recent = uniq(later.filter((e) => !isSurvey(e) && e.year >= y - 1).sort((a, b) => (b.relevance || 0) - (a.relevance || 0))).slice(0, top);
    return [['Foundational', found], ['Recent', recent], ['Surveys', surveys]].filter(([, l]) => l.length);
  }
  // a related-work bullet list of those groups (plain text, to paste)
  function bulletList(groups, setSize = 1) {
    const who = (e) => { const a = (e.authors || []).map(authorName).filter(Boolean); return a.length ? (a.length > 2 ? surname(a[0]) + ' et al.' : a.map(surname).join(' & ')) : ''; };
    const why = (e) => (e.cocited != null && e.citers == null && e.cites == null ? `co-cited by ${e.cocited} works that cite ${setSize === 1 ? 'this paper' : 'these papers'}` : e.citers ? (setSize === 1 ? 'cited by this paper' : `cited by ${e.count} of these ${setSize} papers`) : e.cites ? (setSize === 1 ? 'cites this paper' : `cites ${e.count} of these papers`) : '');
    return groups.map(([name, list]) => `${name}\n${list.map((e) => `- ${e.title} (${[who(e), e.year].filter(Boolean).join(', ')})${why(e) ? ' - ' + why(e) : ''}`).join('\n')}`).join('\n\n') + '\n';
  }
  // ---- B3: the papers of a hand-made set - lines / sub-lines picked (a line takes its sub-lines) and / or a text
  // every word of which is in the title, tags or category. items: library items -> [id]
  function customIds(items, { lines = [], q = '' } = {}, uncat = 'Uncategorized') {
    const L = new Set(lines);
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => {
      const c = it.category || uncat;
      const i = c.indexOf(' / ');
      if (L.has(c) || (i > 0 && L.has(c.slice(0, i)))) return true;
      if (!words.length) return false;
      const hay = [texPlain((it.fields && it.fields.title) || ''), (it.tags || []).join(' '), c].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    }).map((it) => it.id);
  }
  const pure = { shortName, nodeLabel, bibFirst, laneOrder, timeScale, layout, authorName, isOrg, surname, authorList, authorsShort, texPlain, venueType, isSurvey, filterRows, splitForProject, projectTarget, FILTERS0, badgesOf, ancestry, protectTitle, bibEntry, citeKey, groupedRows, bulletList, customIds };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
  if (typeof document === 'undefined') return;

  // ================================================================== the window
  const { $, $$, esc, api, toast, ls } = RT;
  RT.lineage = RT.lineage || {};
  // the plain text of a title with inline LaTeX, for the other modules (toasts of project-papers.js, safety.js)
  RT.texPlain = texPlain;
  const UNCAT = (RT.categories && RT.categories.UNCAT) || 'Uncategorized';
  const colorOf = (cat) => (RT.categories && RT.categories.color ? RT.categories.color(cat) : '#7c4dbe');
  const num = (n) => Number(n).toLocaleString('en-US');
  // text inside the history line's <svg> (tooltips, aria-labels): the i18n observer leaves svg alone, so it is
  // translated here (the window is drawn again when the display language changes)
  const T = (s) => (RT.i18n && RT.i18n.translate(s)) || s;
  // the reasons of a row's rank ("Cited by 5 of these 12 papers and by ... Relevance 4.2.", written by the server and
  // intentWhy): one text of several sentences, so the observer cannot match it - translated sentence by sentence
  const whyT = (s) => (!s || !RT.i18n || RT.i18n.lang() === 'en' ? s || '' : s.trim().split(/(?<=\.)\s+(?=[A-Z])/).map(T).join(' ').replace(/([。）]) (?=[^\x00-\x7f])/g, '$1'));
  // the width a node label takes, measured in the node face (Montserrat 500 11px) once per label; until the face has
  // loaded, a caps- and CJK-aware estimate is used and nothing is cached
  const labelW = (() => {
    const cache = new Map(); let ctx = null;
    const FONT = '500 11px Montserrat, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    const guess = (t) => { let w = 0; for (const ch of t) w += /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 11 : /[A-Z0-9]/.test(ch) ? 8.6 : 6.6; return w; };
    return (t) => {
      if (cache.has(t)) return cache.get(t);
      const ready = document.fonts && document.fonts.check && document.fonts.check(FONT, t);
      if (!ready) return guess(t);
      try { ctx = ctx || document.createElement('canvas').getContext('2d'); } catch { ctx = null; }
      if (!ctx) return guess(t);
      ctx.font = FONT;
      const w = Math.ceil(ctx.measureText(t).width) + 1;
      cache.set(t, w);
      return w;
    };
  })();
  // RT.icon names
  const I = { lineage: 'lineage', csv: 'export', bib: 'bibtex', zin: 'zoom-in', zout: 'zoom-out', fit: 'fit', ext: 'external-link', svg: 'image', group: 'list' };
  const TABS = [['history', 'History line'], ['prior', 'Prior works'], ['derivative', 'Derivative works'], ['similar', 'Similar']];
  const TABLES = ['prior', 'derivative', 'similar'];
  // the ancestors' colours (Ancestry mode): eight hues that read on the light and the dark theme
  const ANC_COLORS = ['#8e44c9', '#d0417e', '#c98a00', '#1f9d8f', '#3a7bd5', '#e0663f', '#5e9a3c', '#8d6e63'];
  let tab = TABS.some(([k]) => k === ls.get('rt.lineage.tab')) ? ls.get('rt.lineage.tab') : 'history';
  let scaleMode = ls.get('rt.lineage.scale') === 'time' ? 'time' : 'even';
  let showPrior = ls.get('rt.lineage.prior') !== '0';
  let hmode = ls.get('rt.lineage.hmode') === 'ancestry' ? 'ancestry' : 'citations'; // the history line: Citations | Ancestry
  let ancSel = null, laneSel = null;   // Ancestry: the ancestor (index) / lane whose edges are shown
  let scopePrev = 'library';           // the scope chosen before "Custom set…"
  let resume = null;                   // B8: where the window was when "Open in reader" closed it
  let adhoc = null;                    // an 'ids' scope that is not a saved set (origin papers left out)
  const ctxCache = new Map();          // B4: "<set key>|<work key>" -> {loading, per, note}
  let zoom = 1;               // multiplies the fitted scale
  const sorts = { prior: { by: 'relevance', dir: -1 }, derivative: { by: 'relevance', dir: -1 }, similar: { by: 'relevance', dir: -1 } };
  let st = null;               // { scope (request body), key, data (result), running (progress), error, seq, sel, checked }
  let pollTimer = null;
  const adding = new Set();
  const addingP = new Map();    // ref -> the promise of its import (an Add to project waits for it)
  const paperBusy = new Set();  // library ids whose project membership is being changed (no second click)
  const lastToggle = new Map(); // id / row key -> when its project change ended: the second click of a double click
  const DBL = 450;              // (within this many ms) is not a second change
  const tooSoon = (k) => Date.now() - (lastToggle.get(k) || 0) < DBL;
  const projAdding = new Set(); // keys of works being added to a project
  // the table filters, per tab, remembered in this browser (rt.lineage.filters)
  const filters = (() => { const f = ls.json('rt.lineage.filters', {}) || {}; return { prior: { ...FILTERS0, ...(f.prior || {}) }, derivative: { ...FILTERS0, ...(f.derivative || {}) }, similar: { ...FILTERS0, ...(f.similar || {}) } }; })();
  // the rows behind a "which": a table of the result, or the on-demand list of recent works citing the top ancestors
  const rowsOf = (which) => (!st || !st.data ? [] : which === 'recent' ? ((st.data.recent || {}).rows || []) : st.data[which] || []);
  const saveFilters = () => ls.set('rt.lineage.filters', JSON.stringify(filters));
  let laneW = Math.max(150, Math.min(420, Number(ls.get("rt.lineage.labelW")) || 230)); // the lane-name column, resizable
  let fitPending = false, yearPending = false;
  const workCache = new Map(); // W -> work with abstract (or {error})

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-lineage" class="lg" aria-labelledby="lg-title">
  <div class="lg-head">
    <span class="lg-ic">${RT.icon(I.lineage)}</span>
    <h3 id="lg-title">Lineage</h3>
    <select id="lg-scope" aria-label="Which papers" title="Which papers: the whole library, one research line, a project's papers, or one paper"></select>
    <span id="lg-status" class="muted" role="status"></span>
    <span class="spacer"></span>
    <button id="lg-refresh" class="ib" title="Compute again: look up the papers whose records are old and ask OpenAlex for the prior and derivative works anew" aria-label="Compute again">${RT.icon('refresh')}</button>
    <button id="lg-close" class="ib" title="Close (Esc)" aria-label="Close">${RT.icon('close')}</button>
  </div>
  <div class="lg-body">
    <aside class="lg-origin" aria-label="The papers of this set">
      <div class="lg-side-head"><b>Origin papers</b> <span id="lg-n" class="muted"></span></div>
      <input type="search" id="lg-oq" placeholder="Filter" aria-label="Filter the origin papers">
      <div id="lg-olist" class="lg-olist"></div>
    </aside>
    <section class="lg-main">
      <div class="lg-bar">
        <div class="seg" id="lg-tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" data-tab="${k}">${n} <span class="lg-cnt" data-cnt="${k}"></span></button>`).join('')}</div>
        <span class="spacer"></span>
        <span id="lg-tools" class="lg-tools"></span>
      </div>
      <div id="lg-view" class="lg-view"></div>
      <div id="lg-foot" class="lg-foot muted"></div>
    </section>
    <aside id="lg-detail" class="lg-detail" aria-label="Details of the selected paper"></aside>
  </div>
</dialog>`);
  const dlg = $('#dlg-lineage');
  // the app's toast (#toast, in the page header) is inert under the modal window: while the window is open it lives
  // inside it, so its Undo can be clicked (and reached by Tab); back in the header when the window closes
  const toastHome = document.createComment('toast');
  function adoptToast() {
    const t = document.getElementById('toast');
    if (!t || t.parentNode === dlg) return;
    t.parentNode.insertBefore(toastHome, t);
    dlg.append(t);
  }
  function releaseToast() {
    const t = document.getElementById('toast');
    if (t && t.parentNode === dlg && toastHome.parentNode) toastHome.parentNode.replaceChild(t, toastHome);
  }

  // ------------------------------------------------------------------ scope
  const libItems = () => (RT.library && RT.library.items ? RT.library.items() : []);
  const catOf = (it) => it.category || UNCAT;
  // the sets made by hand (B3), remembered in this browser: [{name, ids, lines, q}]
  const customSets = () => { const a = ls.json('rt.lineage.custom', []); return Array.isArray(a) ? a.filter((x) => x && x.name && Array.isArray(x.ids)) : []; };
  const saveCustom = (list) => { try { ls.set('rt.lineage.custom', JSON.stringify(list.slice(0, 12))); } catch { /* full */ } };
  const sameIds = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  function scopeValue(o) {
    if (!o || o.scope === 'library' || !o.scope) return 'library';
    if (o.scope === 'category') return 'cat:' + o.category;
    if (o.scope === 'project') return 'proj:' + o.pid;
    if (o.scope === 'paper') return 'paper:' + o.id;
    if (o.scope === 'ids') {
      const c = customSets().find((x) => x.name === o.label && sameIds(x.ids, o.ids || []));
      if (c) return 'set:' + c.name;
      adhoc = { scope: 'ids', ids: [...(o.ids || [])], label: o.label || `${(o.ids || []).length} papers` };
      return 'adhoc';
    }
    return 'library';
  }
  function scopeOf(v) {
    if (v.startsWith('cat:')) return { scope: 'category', category: v.slice(4) };
    if (v.startsWith('proj:')) return { scope: 'project', pid: v.slice(5) };
    if (v.startsWith('paper:')) return { scope: 'paper', id: v.slice(6) };
    if (v.startsWith('set:')) { const c = customSets().find((x) => x.name === v.slice(4)); if (c) return { scope: 'ids', ids: c.ids, label: c.name }; }
    if (v === 'adhoc' && adhoc) return adhoc;
    return { scope: 'library' };
  }
  function fillScopes(cur) {
    const items = libItems();
    const lanes = laneOrder(items.map((i) => ({ category: catOf(i) })), UNCAT);
    const lineN = new Map();
    for (const l of lanes) lineN.set(l.line, l.lineCount);
    const opts = [`<option value="library">The whole library (${items.length})</option>`];
    const lineOpts = [];
    let last = null;
    for (const l of lanes) {
      if (l.line === UNCAT) continue;
      if (l.line !== last) {
        last = l.line;
        // a line with sub-lines: the line itself (all its sub-lines) first
        if (l.sub || lanes.some((x) => x.line === l.line && x.sub)) lineOpts.push(`<option value="cat:${esc(l.line)}">${esc(l.line)} - all (${lineN.get(l.line)})</option>`);
      }
      lineOpts.push(`<option value="cat:${esc(l.name)}">${l.sub ? ' ' + esc(l.sub) : esc(l.name)} (${l.count})</option>`);
    }
    if (lineOpts.length) opts.push(`<optgroup label="Research lines">${lineOpts.join('')}</optgroup>`);
    const projects = (RT.projectPapers && RT.projectPapers.projects && RT.projectPapers.projects()) || [];
    // a project with no paper is not offered - unless it is the set shown (its last paper just taken out)
    const pj = projects.filter((p) => p.papers > 0 || 'proj:' + p.id === cur).map((p) => `<option value="proj:${esc(p.id)}">${esc(p.name)} (${p.papers})</option>`);
    if (pj.length) opts.push(`<optgroup label="Projects">${pj.join('')}</optgroup>`);
    if (cur.startsWith('paper:')) {
      const it = items.find((i) => i.id === cur.slice(6));
      opts.push(`<optgroup label="One paper"><option value="${esc(cur)}">${esc(texPlain((it && it.fields && it.fields.title) || 'This paper').slice(0, 70))}</option></optgroup>`);
    }
    if (cur.startsWith('cat:') && !lanes.some((l) => 'cat:' + l.name === cur || 'cat:' + l.line === cur)) opts.push(`<option value="${esc(cur)}">${esc(cur.slice(4))}</option>`);
    // the sets made by hand, the one-off set (origin papers left out) and the builder
    const have = new Set(items.map((i) => i.id));
    const mine = customSets().map((c) => `<option value="set:${esc(c.name)}">${esc(c.name)} (${c.ids.filter((id) => have.has(id)).length})</option>`);
    if (cur === 'adhoc' && adhoc) mine.push(`<option value="adhoc">${esc(adhoc.label)} (${adhoc.ids.length})</option>`);
    opts.push(`<optgroup label="Your sets">${mine.join('')}<option value="custom">Custom set… (several lines, or papers matching words)</option></optgroup>`);
    $('#lg-scope').innerHTML = opts.join('');
    $('#lg-scope').value = cur;
    if ($('#lg-scope').value !== cur) $('#lg-scope').value = 'library';
    scopePrev = $('#lg-scope').value; // what Cancel / Esc of the custom-set popover goes back to
  }

  // ------------------------------------------------------------------ open / load / poll
  function open(o = {}) {
    hideBack();
    const v = scopeValue(o);
    fillScopes(v);
    if (!dlg.open) dlg.showModal();
    adoptToast();
    setScope(scopeOf($('#lg-scope').value));
  }
  function setScope(scope, { back = null } = {}) {
    stopPoll();
    closePop();
    st = { scope, key: null, data: null, running: null, error: '', seq: 0, sel: null, filter: '', checked: { prior: new Set(), derivative: new Set(), similar: new Set(), recent: new Set() }, picked: null, excluded: new Set(), back };
    ancSel = null; laneSel = null;
    $('#lg-oq').value = '';
    zoom = 1;
    $('#lg-view').innerHTML = ''; // a new set starts at its own scroll position
    // the set's papers from the library at once (the server's answer replaces them): the origin list is never empty
    // while the cached answer is on its way
    st.originIds = localIds(scope); st.count = st.originIds.length;
    // one paper: its lineage is looked up straight away when that costs little (take(): a cached result, or a
    // computation within the list budget)
    st.autoGo = st.originIds.length === 1;
    render();
    request('cached');
  }
  // the ids of a scope as the server resolves them (lib/lineage.js resolveScope), from the library in this page
  function localIds(sc) {
    const items = libItems(), have = new Set(items.map((i) => i.id));
    if (!sc || !sc.scope || sc.scope === 'library') return items.map((i) => i.id);
    if (sc.scope === 'category') return items.filter((i) => { const c = catOf(i); return c === sc.category || c.startsWith(sc.category + ' / '); }).map((i) => i.id);
    if (sc.scope === 'project') { const m = RT.projectPapers && RT.projectPapers.members ? RT.projectPapers.members(sc.pid) : new Set(); return items.filter((i) => m.has(i.id)).map((i) => i.id); }
    if (sc.scope === 'paper') return have.has(sc.id) ? [sc.id] : [];
    if (sc.scope === 'ids') return [...new Set(sc.ids || [])].filter((id) => have.has(id));
    return [];
  }
  // a one-paper computation is cheap when its list queries fit the budget and today's allowance has room
  const DAILY_SAFE = 900;
  const cheap = (e) => !!e && e.papers === 1 && e.list <= e.budget && (e.today || 0) + e.list <= DAILY_SAFE;
  async function request(mode) {
    if (!st) return;
    const mine = st, seq = ++st.seq;
    if (mode !== 'cached') { st.error = ''; st.running = { phase: 'papers', done: 0, total: 0 }; render(); }
    let r;
    try { r = await api('/api/lineage', { method: 'POST', json: { ...st.scope, mode } }); }
    catch (e) { if (mine !== st || seq !== st.seq) return; st.running = null; st.error = e.message || String(e); render(); return; }
    if (mine !== st || seq !== st.seq) return;
    take(r);
  }
  function take(r) {
    st.key = r.key;
    if (r.estimate !== undefined) st.estimate = r.estimate;
    if (r.state === 'running') { st.running = r.progress || { phase: 'papers', done: 0, total: 0 }; st.count = r.scope && r.scope.count; poll(); }
    else if (r.state === 'done') {
      st.running = null; st.data = clean(r.result); st.stale = !!r.stale; st.outdated = !!r.outdated; st.staleInfo = r.staleInfo || null; st.error = '';
      // back from the reader (B8): the same tab, selection and scroll
      if (st.back) {
        st.sel = st.back.sel; st.tfilter = st.back.tfilter || ''; st.pendingScroll = st.back.scroll; st.back = null;
        // the focus on what was opened: its node (or origin row), its table row
        const s0 = st.sel;
        st.focusAfter = !s0 ? null : s0.kind === 'paper' ? (tab === 'history' ? `g.lg-node[data-node="${CSS.escape(s0.id)}"]` : `button.lg-orow[data-paper="${CSS.escape(s0.id)}"]`) : `tr[data-row="${CSS.escape(s0.kind + ':' + s0.i)}"]`;
      }
    }
    else if (r.state === 'error') { st.running = null; st.error = r.error || 'The computation failed.'; }
    else {
      st.running = null; st.count = r.scope && r.scope.count; st.originIds = (r.scope && r.scope.ids) || st.originIds || null; st.label = r.scope && r.scope.label;
      if (st.autoGo && !st.error && cheap(r.estimate)) { st.autoGo = false; return request('auto'); }
    }
    st.autoGo = false;
    render();
  }
  // what Semantic Scholar says of how the citing papers cite a prior work: the method count only where it gives
  // intents at all (it often gives none - then the intent is unknown, not "0 use its method")
  function intentWhy(e) {
    const n = (e.citers || []).length;
    if (e.known) return ` Semantic Scholar gives intents for ${e.known} of the ${n} citing papers: ${e.methods} use${e.methods === 1 ? 's' : ''} its method${e.influential ? `; ${e.influential} cite${e.influential === 1 ? 's' : ''} it as influential` : ''}.`;
    if (e.influential) return ` Semantic Scholar marks it influential in ${e.influential} of the ${n} citing papers (it gives no intents for them).`;
    return '';
  }
  // titles as text (no "$π_0$"), author names without braces
  function clean(d) {
    if (!d) return d;
    for (const p of d.papers || []) p.title = texPlain(p.title);
    for (const k of [...TABLES, 'recent']) for (const e of (k === 'recent' ? (d.recent || {}).rows : d[k]) || []) {
      e.title = texPlain(e.title);
      e.authors = (e.authors || []).map(authorName).filter(Boolean);
      e.last = authorName(e.last);
      e.badges = badgesOf(e);
      if (k === 'prior') e.why = (e.why || '') + intentWhy(e);
    }
    return d;
  }
  function poll() {
    stopPoll();
    const mine = st;
    pollTimer = setTimeout(async () => {
      if (mine !== st || !dlg.open || !st.key) return;
      try { const r = await api('/api/lineage/job?key=' + RT.enc(st.key)); if (mine === st) take(r); }
      catch (e) { if (mine === st) { st.running = null; st.error = e.message || String(e); render(); } }
    }, 1000);
  }
  function stopPoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }

  // ------------------------------------------------------------------ render
  const people = (authors, more) => { const a = authors || []; return a.length > 3 ? a[0] + ' et al.' : a.join(', ') + (more ? ' et al.' : ''); };
  const papersById = () => new Map(((st && st.data && st.data.papers) || []).map((p) => [p.id, p]));
  const dateLabel = (p) => (p.date ? (p.approx ? p.date.slice(0, 7) : p.date) : p.year || '');
  // the focus across a re-render: the focused control is found again by its id or data-* key (a ticked checkbox,
  // a bookmark, a sort button, a node) - keyboard users keep their place
  const FOCUS_ATTRS = ['node', 'check', 'checkall', 'proj', 'projpaper', 'add', 'row', 'sort', 'f', 'grouped', 'projchip', 'clearsel', 'addproj', 'addall', 'dl', 'tab', 'pick', 'paper', 'incl', 'hmode', 'scale', 'zoom', 'svg', 'lane', 'open', 'focus', 'pdproj', 'showgeneric', 'update', 'outlineage', 'outadd'];
  function focusSel(el) {
    if (!el || el === document.body || !dlg.contains(el)) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    for (const a of FOCUS_ATTRS) { const k = 'data-' + a; if (el.hasAttribute && el.hasAttribute(k)) return `${el.tagName.toLowerCase()}[${k}="${CSS.escape(el.getAttribute(k))}"]`; }
    return null;
  }
  function refocus(sel) {
    if (!sel || !dlg.open) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected && dlg.contains(a)) return;
    const el = dlg.querySelector(sel);
    if (el) el.focus({ preventScroll: true });
  }
  function render() {
    if (!st) return;
    const fk = focusSel(document.activeElement);
    renderAll();
    refocus(fk);
    if (st.focusAfter) { const el = dlg.querySelector(st.focusAfter); st.focusAfter = null; if (el) el.focus({ preventScroll: true }); }
  }
  const keep = (fn) => { const fk = focusSel(document.activeElement); fn(); refocus(fk); };
  function renderAll() {
    const d = st.data;
    $$('#lg-tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    for (const [k] of TABS) {
      const el = $(`[data-cnt="${k}"]`);
      el.textContent = !d ? '' : k === 'history' ? num(d.papers.length) : k === 'similar' && !d.similar ? '' : num(tableRows(k, { text: k === tab }).length);
    }
    $('#lg-refresh').disabled = !!st.running;
    $('#lg-status').innerHTML = statusLine();
    renderOrigin();
    if (st.running && !d) return renderProgress();
    if (!d) return renderIntro();
    if (tab === 'history') renderHistory(); else renderTable(tab);
    renderDetail();
    renderFoot();
  }
  // the detail column only takes room when something is selected (narrow windows, lineage.css)
  const markDetail = () => { const b = $('#dlg-lineage .lg-body'); if (b) b.classList.toggle('nodetail', !selected()); };
  function statusLine() {
    const d = st.data;
    if (st.running) {
      const p = st.running, what = p.phase === 'papers' ? `paper ${num(p.done)} of ${num(p.total)}` : p.phase === 'prior' ? 'prior works' : p.phase === 'derivative' ? 'derivative works' : '';
      return `<span class="spin"></span> Looking up ${esc(what)}…`;
    }
    if (!d) return '';
    const ago = Math.round((Date.now() - Date.parse(d.computed)) / 3600000);
    return esc(`${num(d.stats.set)} ${d.stats.set === 1 ? 'paper' : 'papers'} · ${num(d.stats.found)} known to OpenAlex · ${num(d.stats.withRefs)} with references · computed ${ago < 1 ? 'just now' : ago < 48 ? ago + ' h ago' : Math.round(ago / 24) + ' days ago'}`) + (st.staleInfo ? ' <b>· made for a slightly different set</b>' : st.stale ? ' <b>· old - Refresh computes it again</b>' : '');
  }
  function renderFoot() {
    const d = st.data, u = d.usage || {}, t = d.today || {};
    $('#lg-foot').textContent = $('#lg-status').title = `This computation asked OpenAlex ${num(u.single || 0)} single look-ups (free) and ${num(u.list || 0)} list queries (at most 10; ~1000 a day for this network), Semantic Scholar ${num(u.s2 || 0)} times. Today: ${num(t.list || 0)} list queries in all. Only DOIs, arXiv ids and OpenAlex ids were sent.`;
  }
  // what a computation would ask (B3): "X of Y papers already looked up; about N list queries (budget 10; today T)"
  function estimateText(e = st.estimate) {
    if (!e) return '';
    return `${num(e.known)} of ${num(e.papers)} papers already looked up${e.lookups ? `, ${num(e.lookups)} to look up (free single look-ups)` : ''}${e.noId ? `, ${num(e.noId)} without DOI or arXiv id` : ''}; about ${num(e.list)} list ${e.list === 1 ? 'query' : 'queries'} (at most ${num(e.budget)} per computation; ${num(e.today)} used today of OpenAlex's ~1000).`;
  }
  function renderIntro() {
    $('#lg-tools').innerHTML = '';
    $('#lg-foot').textContent = '';
    const n = st.count != null ? st.count : '';
    const est = estimateText();
    // at the top of the pane, the button before the explanations: visible at any window size or zoom (the pane
    // scrolls when the text is longer than it)
    $('#lg-view').innerHTML = `<div class="lg-intro">
      <div class="lg-intro-head">${RT.icon(I.lineage, { duo: 'sketch' })}<p><b>Where ${n === 1 ? 'this paper comes' : 'these ' + (n ? num(n) + ' ' : '') + 'papers come'} from, and where the work went.</b></p></div>
      <div class="lg-intro-go"><button id="lg-go" class="accent">${RT.icon('search')} Look up the lineage</button>${est ? `<span class="muted lg-est">${esc(est)}</span>` : ''}</div>
      ${st.error ? `<div class="notice lg-bad">${esc(st.error)}</div>` : ''}
      <p><b>The history line</b> lays them out in time, one lane per research line, with an arrow from a paper to each later paper of yours that cites it. <b>Prior works</b> are the papers yours cite most - usually the seminal works the line builds on. <b>Derivative works</b> cite many of yours - surveys and the newest work of the line. (The same ideas as Connected Papers.)</p>
      <p class="muted">Each paper is looked up once by its DOI or arXiv id at OpenAlex (free), and at Semantic Scholar when OpenAlex has no reference list. The two lists then take at most 10 OpenAlex list queries out of its daily allowance. Nothing else leaves this Mac - never a note, a title or the PDF. The answer is kept for a week.</p>
    </div>`;
    $('#lg-detail').innerHTML = '';
  }
  function renderProgress() {
    $('#lg-tools').innerHTML = '';
    const p = st.running;
    const frac = p.phase === 'papers' && p.total ? 0.05 + 0.75 * p.done / p.total : p.phase === 'prior' ? 0.85 : p.phase === 'derivative' ? 0.93 : 0.03;
    $('#lg-view').innerHTML = `<div class="lg-intro">
      <p><span class="spin"></span> ${p.phase === 'papers' ? `Looking up paper ${num(p.done)} of ${num(p.total)}${p.current ? ': <i>' + esc(p.current) + '</i>' : ''}` : p.phase === 'prior' ? 'Counting the prior works and fetching their records…' : 'Asking OpenAlex which works cite these papers…'}</p>
      <div class="lg-progress"><div style="width:${Math.round(frac * 100)}%"></div></div>
      <p class="muted">Semantic Scholar is asked about one paper a second, so a large library takes a few minutes the first time; later only new papers are looked up. You can close this window - the computation goes on and is kept.</p>
      ${p.usage ? `<p class="muted">So far: ${num(p.usage.single || 0)} OpenAlex look-ups, ${num(p.usage.list || 0)} list queries, ${num(p.usage.s2 || 0)} Semantic Scholar requests.</p>` : ''}
    </div>`;
    $('#lg-foot').textContent = '';
  }
  // the origin papers before anything is computed (B3): from the library, the ids the server named for the scope
  function prePapers() {
    const ids = new Set(st.originIds || []);
    return libItems().filter((it) => ids.has(it.id)).map((it) => { const f = it.fields || {}; return { id: it.id, title: texPlain(f.title || it.citekey), author: f.author || '', category: catOf(it), date: '', year: f.year || '', origin: true, refs: 1, pre: true }; });
  }
  const scopeLabel = () => (st.data && st.data.scope && st.data.scope.label) || st.label || (st.scope && st.scope.label) || 'these papers';
  function renderOrigin() {
    const box = $('#lg-olist');
    const d = st.data;
    const all = d ? d.papers : prePapers();
    if (!d && !all.length) { box.innerHTML = ''; $('#lg-n').textContent = st.count != null ? num(st.count) : ''; return; }
    const words = (st.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
    const list = all.filter((p) => !words.length || words.every((w) => (p.title + ' ' + p.author + ' ' + p.category).toLowerCase().includes(w)))
      .sort((a, b) => Number(b.origin) - Number(a.origin) || String(b.date || b.year).localeCompare(String(a.date || a.year)));
    const nOrigin = all.filter((p) => p.origin).length;
    $('#lg-n').textContent = num(nOrigin) + (all.some((p) => !p.origin) ? ` + ${num(all.filter((p) => !p.origin).length)} linked` : '');
    const sel = st.sel && st.sel.kind === 'paper' ? st.sel.id : null;
    const ex = st.excluded || new Set();
    // origin papers left out: "k left out -> look up the other n" (a set of its own, scope 'ids')
    const exN = all.filter((p) => p.origin && ex.has(p.id)).length;
    const bar = exN ? `<div class="lg-exbar">${num(exN)} left out · <button class="lg-linkbtn" data-runex="1" title="The lineage of the other ${num(nOrigin - exN)} papers (a set of its own)">Look up the other ${num(nOrigin - exN)}</button> · <button class="lg-linkbtn" data-clearex="1">Keep all</button></div>` : '';
    let linkedHead = false;
    box.innerHTML = bar + (list.map((p) => {
      let head = '';
      if (!p.origin && !linkedHead) { linkedHead = true; head = '<div class="lg-ohead muted">Linked papers of your library</div>'; }
      const chk = p.origin && nOrigin > 1 ? `<input type="checkbox" class="lg-incl" data-incl="${esc(p.id)}" ${ex.has(p.id) ? '' : 'checked'} aria-label="Include “${esc(short(p.title, 60))}”" title="Include this paper in the set (untick to leave it out)">` : '<span class="lg-incl-sp"></span>';
      const meta = RT.byline(authorsShort(p.author), [p.pre ? p.year : dateLabel(p), p.category]) + (p.pre ? '' : p.problem ? ' · <span class="lg-warn" title="' + esc(p.problem) + '">no references</span>' : !p.refs ? ' · <span class="lg-warn">no references</span>' : '');
      return `${head}<div class="lg-orow-w${ex.has(p.id) ? ' out' : ''}">${chk}<button class="lg-orow${p.id === sel ? ' sel' : ''}" data-paper="${esc(p.id)}" title="${esc(p.title)}"><span class="lg-dot" style="background:${esc(colorOf(p.category))}"></span><span class="lg-ot"><span class="lg-otitle" data-i18n-skip>${esc(p.title)}</span><span class="lg-ometa muted">${meta}</span></span></button></div>`;
    }).join('') || outsideHtml(words, all));
  }
  // the filter matches nothing in the set: the library papers outside it that it matches, each with "Check its
  // lineage" and (a project's set) "Add to “P”"
  const OUT_MAX = 8;
  function outsideHtml(words, all) {
    const inSet = new Set(all.map((p) => p.id));
    const hits = libItems().filter((it) => !inSet.has(it.id)).map((it) => {
      const f = it.fields || {}, title = texPlain(f.title || it.citekey);
      const s = (title + ' ' + (f.author || '') + ' ' + (f.year || '') + ' ' + catOf(it) + ' ' + (it.citekey || '')).toLowerCase();
      return words.every((w) => s.includes(w)) ? { it, title, f, inTitle: words.every((w) => title.toLowerCase().includes(w)) } : null;
    }).filter(Boolean).sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || String(b.f.year || '').localeCompare(String(a.f.year || '')));
    if (!hits.length) return '<div class="empty lg-nomatch">No paper matches.</div>';
    const pid = st.scope && st.scope.scope === 'project' ? st.scope.pid : null;
    const proj = pid && RT.projectPapers && RT.projectPapers.project ? RT.projectPapers.project(pid) : null;
    const q = (st.filter || '').trim();
    return `<div class="lg-outside" role="status"><div class="lg-out-head">“${esc(q)}” is not in this set</div>`
      + hits.slice(0, OUT_MAX).map(({ it, title, f }) => `<div class="lg-out-row">
        <span class="lg-dot" style="background:${esc(colorOf(catOf(it)))}"></span>
        <span class="lg-ot"><span class="lg-otitle" data-i18n-skip title="${esc(title)}">${esc(title)}</span><span class="lg-ometa muted">${RT.byline(authorsShort(f.author || ''), [f.year || '', catOf(it)])}</span>
        <span class="lg-out-acts"><button class="mini" data-outlineage="${esc(it.id)}">Check its lineage</button>${proj ? `<button class="mini" data-outadd="${esc(it.id)}" title="Add this paper to “${esc(proj.name)}”">Add to “${esc(proj.name)}”</button>` : ''}</span></span>
      </div>`).join('')
      + (hits.length > OUT_MAX ? `<div class="lg-out-more muted">${num(hits.length - OUT_MAX)} more in the library - type more of the title</div>` : '')
      + '</div>';
  }
  async function addOutside(id) {
    const pid = st && st.scope && st.scope.scope === 'project' ? st.scope.pid : null;
    if (!pid || paperBusy.has(id)) return;
    paperBusy.add(id);
    try { await RT.projectPapers.toggle([id], { pid, on: true }); }
    catch (e) { toast(e.message || String(e), 'bad'); return; }
    finally { paperBusy.delete(id); }
    // the set has one paper more: the scope again (its count in the select too), the filter kept to show the paper
    const f = st.filter || '', sc = st.scope;
    fillScopes(scopeValue(sc));
    setScope(sc);
    st.filter = f; $('#lg-oq').value = f; renderOrigin();
  }
  // the banner over a result made for a slightly different set (B3: the library one paper bigger)
  function staleBanner() {
    const x = st.staleInfo;
    const n = st.estimate ? st.estimate.list : null;
    if (!x && st.outdated && st.data) return `<div class="notice lg-note lg-stale" role="status">Computed before the relevance ranking: the derivative works are in citation order and there is no Similar list - <button class="lg-linkbtn" data-update="1" title="${esc(estimateText())}">Update${n != null ? ` (~${num(n)} ${n === 1 ? 'query' : 'queries'})` : ''}</button></div>`;
    if (!x || !st.data) return '';
    const bits = [`Computed for ${num(x.computedFor)} ${x.computedFor === 1 ? 'paper' : 'papers'}`];
    if (x.added) bits.push(`${num(x.added)} new not included`);
    if (x.removed) bits.push(`${num(x.removed)} no longer in the set`);
    return `<div class="notice lg-note lg-stale" role="status">${esc(bits.join(' · '))} · <button class="lg-linkbtn" data-update="1" title="${esc(estimateText())}">Update${n != null ? ` (~${num(n)} ${n === 1 ? 'query' : 'queries'})` : ''}</button></div>`;
  }
  const topNotes = (which) => staleBanner() + notesFor(which);

  // the notes of a result that concern this tab (a derivative-works note only on that tab); dismissible
  function notesFor(which) {
    const d = st.data;
    if (st.notesHidden) return '';
    const list = (d.notes || []).filter((n) => (/^Derivative works/.test(n) ? which === 'derivative' : /^Prior works/.test(n) ? which !== 'derivative' : true));
    if (!list.length) return '';
    return `<div class="lg-notes">${list.map((n) => `<div class="notice lg-note" title="${esc(n)}">${esc(n)}</div>`).join('')}<button class="ib lg-notes-x" data-hidenotes="1" title="Hide these notes" aria-label="Hide these notes">${RT.icon('close')}</button></div>`;
  }
  // the prior works drawn on the history line: dated, cited by 2+ of the set (1 for one paper), not generic, not a
  // library paper that is drawn as a node of its own already; the most relevant 12
  function shownPrior() {
    const d = st.data;
    const drawn = new Set(d.papers.map((p) => p.id));
    return d.prior.filter((w) => w.year && !w.generic && w.count >= (d.stats.set > 1 ? 2 : 1) && !(w.inLibrary && drawn.has(w.inLibrary))).slice(0, 12);
  }
  // the year labels win over the month labels; a label needs room after the one before it -> ticks with label or ''
  function tickLabels(ticks) {
    const xs = [];
    const room = (x, w) => xs.every((lx) => Math.abs(lx - x) >= w);
    const out = ticks.map((t) => ({ ...t, label: '' + t.label }));
    for (const t of out) if (t.major) { if (room(t.x, 34)) xs.push(t.x); else t.label = ''; }
    for (const t of out) if (!t.major) { if (room(t.x, 30)) xs.push(t.x); else t.label = ''; }
    // a month whose year has no label of its own yet says it ("Aug 2026")
    let ly = null;
    for (const t of out.slice().sort((a, b) => a.x - b.x)) {
      if (!t.label) continue;
      if (t.major) ly = t.year;
      else if (t.year != null && t.year !== ly) { t.label += ' ' + t.year; ly = t.year; }
    }
    return out;
  }

  // ------------------------------------------------------------------ history line
  const BAND = { prior: '\u0000prior', focus: '\u0000focus', deriv: '\u0000deriv' };
  const libCat = (id) => { const it = libItems().find((i) => i.id === id); return it ? catOf(it) : UNCAT; };
  function renderHistory() {
    const d = st.data;
    const focus = d.stats.set === 1 && d.scope && d.scope.focus ? d.scope.focus : null;
    const ancMode = hmode === 'ancestry' && !focus;
    $('#lg-tools').innerHTML = `
      ${focus ? '' : `<div class="seg" id="lg-hmode" role="group" aria-label="What the history line shows"><button data-hmode="citations" class="${ancMode ? '' : 'on'}" aria-pressed="${!ancMode}" title="Arrows between your papers: an earlier paper to each later one that cites it">Citations</button><button data-hmode="ancestry" class="${ancMode ? 'on' : ''}" aria-pressed="${ancMode}" title="Which works inspired which: the 8 works these papers build on most, with a bundle into each lane (width = how many of its papers cite it)">Ancestry</button></div>`}
      ${ancMode ? '' : `<label class="lg-chk" title="Show the most relevant prior works as nodes in a lane of their own (hollow: not in your library)"><input type="checkbox" id="lg-showprior" ${showPrior ? 'checked' : ''}> Prior works</label>`}
      <div class="seg" id="lg-scale"><button data-scale="even" class="${scaleMode === 'even' ? 'on' : ''}" title="Papers one step apart in date order: crowded months spread out">Order</button><button data-scale="time" class="${scaleMode === 'time' ? 'on' : ''}" title="True time scale">Time</button></div>
      ${scaleMode === 'time' ? '<button class="ib" data-zoom="year" title="The last 12 months across the width">Last 12 months</button>' : ''}
      <button class="ib" data-zoom="out" title="Zoom out" aria-label="Zoom out">${RT.icon(I.zout)}</button>
      <button class="ib" data-zoom="fit" title="Fit the whole history line to the width" aria-label="Fit to the width">${RT.icon(I.fit)}</button>
      <button class="ib" data-zoom="in" title="Zoom in" aria-label="Zoom in">${RT.icon(I.zin)}</button>
      <button class="ib" data-svg="1" title="Save the history line as an SVG picture (for slides or a proposal)" aria-label="Save the history line as SVG">${RT.icon(I.svg)} SVG</button>
      ${projChip()}`;
    const view = $('#lg-view');
    // the point in the middle stays in the middle across a zoom or a re-render
    const old = $('.lg-tl', view), keep = old && old.scrollWidth && !fitPending && !yearPending ? { c: (old.scrollLeft + old.clientWidth / 2) / old.scrollWidth, t: old.scrollTop } : null;
    const toEnd = yearPending;
    const notes = topNotes('history');
    if (!d.papers.length) { view.innerHTML = notes + '<div class="empty">No papers.</div>'; return; }
    // Ancestry (B6): the ancestors in a column of their own on the left, the time axis after it
    const AN = ancMode ? ancestry(d.papers, d.prior, { laneOf: (p) => p.category }) : null;
    const ANC_W = AN && AN.anc.length ? 290 : 0;
    const prior = showPrior && !AN ? shownPrior() : [];
    const pDate = (w) => w.date || (w.year ? w.year + '-07-01' : '');
    const dated = d.papers.filter((p) => p.date);
    const allDates = [...dated.map((p) => p.date), ...prior.map(pDate)];
    const LABEL_W = laneW, avail = Math.max(400, view.clientWidth - LABEL_W - 30 - ANC_W);
    // the scale at a zoom: the whole range fitted to the visible width at zoom 1
    let basePpd = 1;
    const mk = (z) => {
      if (scaleMode === 'even') {
        const n = new Set(allDates).size;
        // at least room for a dot and a short label between neighbours: a large set scrolls sideways instead of piling up
        return timeScale(allDates, { mode: 'even', step: Math.max(30, Math.min(70, (avail - 60) / Math.max(1, n - 1))) * z });
      }
      // fitted to the library papers: the bulk of them (from the 10th percentile on) gets 80 % of the width, the older
      // papers and the prior works share the rest
      const lt = dated.map((p) => Date.parse(p.date)).filter(Number.isFinite).sort((a, b) => a - b);
      const all = allDates.map(Date.parse).filter(Number.isFinite);
      const focusT = lt.length >= 10 ? lt[Math.floor(lt.length * 0.1)] : lt.length ? lt[0] : Math.min(...all);
      const older = Math.min(...all) < focusT - 30 * DAY;
      const leftW = older ? Math.round((avail - 60) * 0.2) : 0;
      const days = Math.max(60, (Math.max(...all) - (older ? focusT : Math.min(...all))) / DAY + 40);
      const ppd = Math.max(0.05, (avail - 60 - leftW) / days);
      // papers that pile up in a few recent months: stretched until neighbouring papers are ~12 px apart (median)
      const gaps = [];
      for (let i = 1; i < lt.length; i++) if (lt[i] >= focusT) gaps.push((lt[i] - lt[i - 1]) / DAY * ppd);
      gaps.sort((a, b) => a - b);
      const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      const stretch = med > 0 && med < 12 ? Math.min(6, 12 / med) : 1;
      basePpd = ppd * stretch;
      return timeScale(allDates, { mode: 'time', pxPerDay: ppd * stretch * z, focus: older ? new Date(focusT).toISOString() : null, leftW: leftW * z });
    };
    let scale = mk(zoom);
    // Fit: the zoom at which the whole content (with the labels of the last nodes) is as wide as the view
    if (fitPending) {
      fitPending = false;
      const need = scale.width + 160;
      if (need > avail) { zoom = Math.max(0.3, Math.min(1, avail / need)); scale = mk(zoom); }
    }
    // Last 12 months (time scale): 380 days across the width, the newest end in view
    if (yearPending) {
      yearPending = false;
      if (scaleMode === 'time') { zoom = Math.max(0.3, Math.min(8, (avail - 80) / (380 * basePpd))); scale = mk(zoom); }
    }
    const labels = zoom >= 0.75;
    const pid = targetPid();
    const nameOf = (p) => nodeLabel(p.title, { first: bibFirst(p.author), year: String(p.date || p.year || '').slice(0, 4) });
    // one paper: three bands - what it builds on | the paper | the papers of the library that cite it
    const cites = new Set(focus ? d.edges.filter(([a]) => a === focus).map(([, b]) => b) : []);
    const laneOf = (p) => (!focus ? p.category : p.id === focus ? BAND.focus : cites.has(p.id) ? BAND.prior : BAND.deriv);
    const X = (dt) => scale.x(dt) + ANC_W;
    const nodes = d.papers.map((p) => ({ id: p.id, lane: laneOf(p), x: X(p.date || allDates[0]), w: labels ? 14 + labelW(nameOf(p)) : 14, p }));
    // prior works get shorter labels; every one of them gets its label (the lane grows a row when needed)
    const priorName = (w) => nodeLabel(w.title, { first: (w.authors || [])[0] || '', year: w.year || '' }, 16);
    const pn = prior.map((w, i) => ({ id: 'prior:' + i, lane: BAND.prior, x: X(pDate(w)), w: labels ? 14 + labelW(priorName(w)) : 14, wk: w, label: true }));
    const lanes = focus
      ? [{ name: BAND.prior, line: 'Prior works', sub: '', count: pn.length + nodes.filter((n) => n.lane === BAND.prior).length, first: true }, { name: BAND.focus, line: 'This paper', sub: '', count: 1, first: true }, { name: BAND.deriv, line: 'Derivative works', sub: '', count: nodes.filter((n) => n.lane === BAND.deriv).length, first: true }]
      : [...(pn.length ? [{ name: BAND.prior, line: 'Prior works', sub: '', count: pn.length, first: true }] : []), ...laneOrder(d.papers, UNCAT)];
    const AXIS = 28;
    const L = layout([...pn, ...nodes], lanes, { top: 0, rowH: 22, gap: 6 });
    // Ancestry: the ancestor column needs its height (a small set: the last lane grows)
    const minH = AN && AN.anc.length ? 30 + AN.anc.length * 40 : 0;
    if (minH > L.height && L.lanes.length) { L.lanes[L.lanes.length - 1].height += minH - L.height; L.height = minH; }
    const width = Math.max(scale.width + ANC_W + (labels ? 160 : 30), avail + ANC_W);
    const height = L.height + 10;
    const sel = st.sel && st.sel.kind === 'paper' ? st.sel.id : st.sel && st.sel.kind === 'prior' ? 'prior:' + st.sel.i : null;
    // edges: from the older (cited) to the paper that cites it
    const paths = [];
    const edge = (a, b, cls, from, to) => {
      const A = L.pos[a], B = L.pos[b];
      if (!A || !B) return;
      const dx = Math.max(24, Math.abs(A.x - B.x) / 2);
      paths.push(`<path class="lg-e ${cls}" data-from="${esc(from)}" data-to="${esc(to)}" d="M${B.x.toFixed(1)},${B.y.toFixed(1)} C${(B.x + dx).toFixed(1)},${B.y.toFixed(1)} ${(A.x - dx).toFixed(1)},${A.y.toFixed(1)} ${(A.x - 6).toFixed(1)},${A.y.toFixed(1)}" marker-end="url(#lg-arrow)"/>`);
    };
    if (!AN) for (const [a, b] of d.edges) edge(a, b, '', b, a);
    pn.forEach((n) => { for (const c of n.wk.citers) edge(c, n.id, 'prior', n.id, c); });
    // Ancestry: the ancestors stacked in the left column, a bundle from each into every lane that cites it (width =
    // how many of the lane's papers cite it); the ancestor or lane picked: one curve to each of its papers
    let ancSvg = '';
    if (AN && AN.anc.length) {
      const laneBy = new Map(L.lanes.map((l) => [l.name, l]));
      const gapY = Math.max(36, Math.min(64, (L.height - 20) / AN.anc.length));
      const ay = (j) => 18 + j * gapY;
      const ax = 160; // the ancestor dots; their names to the left, the bundles fan out to the right
      const bundles = [], lines = [], heads = [];
      for (const a of AN.anc) {
        const col = ANC_COLORS[a.j % ANC_COLORS.length];
        const on = ancSel === a.j, dim = (ancSel != null && !on);
        for (const [lane, ids] of a.lanes) {
          const l = laneBy.get(lane);
          if (!l) continue;
          const ly = l.top + l.height / 2, tx = ANC_W - 4;
          const off = laneSel && laneSel !== lane;
          bundles.push(`<path class="lg-bundle${dim || off ? ' dim' : ''}" data-anc="${a.j}" d="M${ax + 7},${ay(a.j)} C${ax + 70},${ay(a.j)} ${tx - 60},${ly} ${tx},${ly}" style="stroke:${col};stroke-width:${(1 + 1.6 * Math.sqrt(ids.length)).toFixed(1)}"><title>${esc(T(`${a.e.title}\n→ ${lane}: ${ids.length} ${ids.length === 1 ? 'paper cites' : 'papers cite'} it`))}</title></path>`);
          if ((on || (laneSel === lane && ancSel == null)) && !off) for (const id of ids) {
            const P = L.pos[id];
            if (!P) continue;
            lines.push(`<path class="lg-e prior lg-aline" data-from="anc:${a.j}" data-to="${esc(id)}" d="M${tx},${ly} C${tx + 40},${ly} ${P.x - 40},${P.y} ${P.x - 6},${P.y}" style="stroke:${col}" marker-end="url(#lg-arrow)"/>`);
          }
        }
        const lbl = `${nodeLabel(a.e.title, { first: (a.e.authors || [])[0] || '', year: a.e.year || '' }, 18)} · ${a.e.count}`;
        const tip = `${a.e.title}\n${[surname((a.e.authors || [])[0] || ''), a.e.year].filter(Boolean).join(' ')} · cited by ${a.e.count} of these ${d.stats.set} papers${a.burst ? '\nBursting: at least half of the papers citing it are from the last 12 months' : ''}\nClick to show its edges (again to show all)`;
        heads.push(`<g class="lg-node lg-anc${on ? ' sel' : ''}${dim ? ' dim' : ''}" data-node="anc:${a.j}" transform="translate(${ax},${ay(a.j)})" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(T(`${a.e.title}: cited by ${a.e.count} of these papers`))}" aria-haspopup="menu"><title>${esc(T(tip))}</title>${a.burst ? '<circle class="lg-burst" r="11"/>' : ''}<circle r="7" style="fill:${col};stroke:${col}"/><text class="lg-alabel" x="-12" y="4" text-anchor="end">${esc(lbl)}</text></g>`);
      }
      ancSvg = `<rect class="lg-anccol" x="0" y="0" width="${ANC_W - 4}" height="${height}"/><g class="lg-bundles">${bundles.join('')}</g><g class="lg-edges">${lines.join('')}</g>${heads.join('')}`;
    }
    const laneBg = L.lanes.map((l, i) => `<rect class="lg-lane${i % 2 ? ' odd' : ''}${l.name === BAND.focus ? ' focus' : ''}" x="0" y="${l.top}" width="${width}" height="${l.height}"/>`).join('');
    const ticks = tickLabels(scale.ticks.filter((t) => t.x >= 0).map((t) => ({ ...t, x: t.x + ANC_W })));
    // the tick lines in the chart; their labels in the axis above it, which stays in view (sticky) while the chart scrolls
    const tickLines = ticks.map((t) => `<line class="lg-tick${t.major ? ' major' : ''}" x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="0" y2="${height}"/>`).join('');
    const tickText = ticks.map((t) => `<line class="lg-tick${t.major ? ' major' : ''}" x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${AXIS - 6}" y2="${AXIS}"/><text class="lg-tlabel${t.major ? ' major' : ''}" x="${Math.max(2, t.x + 3).toFixed(1)}" y="${AXIS - 10}">${esc(t.label)}</text>`).join('');
    const lastOf = (field) => { const a = authorList(field); return a.length > 1 ? a[a.length - 1] : ''; };
    let anyProj = false, anyLibPrior = false;
    const nodeSvg = (n, prior) => {
      const P = L.pos[n.id];
      const lib = prior ? n.wk.inLibrary : n.id;
      const cat = prior ? (lib ? libCat(lib) : null) : n.p.category;
      const dom = AN && !prior ? AN.dominant.get(n.id) : undefined;
      const color = AN && !prior ? (dom != null ? ANC_COLORS[dom % ANC_COLORS.length] : 'var(--line)') : cat ? colorOf(cat) : 'var(--muted)';
      const title = prior ? n.wk.title : n.p.title;
      const inP = !!lib && inProj(lib, pid);
      if (inP) anyProj = true;
      if (prior && lib) anyLibPrior = true;
      const pName = targetName();
      // first author + year in the label and the tooltip; the last author in the tooltip body
      const tip = prior
        ? `${n.wk.title}\n${[[surname((n.wk.authors || [])[0] || ''), n.wk.year].filter(Boolean).join(' '), n.wk.last && (n.wk.authors || []).length > 1 ? 'last author ' + n.wk.last : '', n.wk.cited != null ? 'cited ' + num(n.wk.cited) : ''].filter(Boolean).join(' · ')}\nCited by ${n.wk.count} of these papers${lib ? ' · in your library' : ''}${inP ? ` · in “${pName}”` : ''}`
        : `${n.p.title}\n${[[bibFirst(n.p.author), String(n.p.date || n.p.year || '').slice(0, 4)].filter(Boolean).join(' '), lastOf(n.p.author) ? 'last author ' + lastOf(n.p.author) : '', dateLabel(n.p), n.p.category].filter(Boolean).join(' · ')}${inP ? `\nIn “${pName}”` : ''}`;
      const isFocus = !prior && n.id === focus;
      const r = isFocus ? 8 : n.id === sel ? 7 : 5.5;
      const cls = `lg-node${prior ? ' prior' : ''}${prior && lib ? ' inlib' : ''}${n.id === sel ? ' sel' : ''}${!prior && !n.p.origin ? ' linked' : ''}${isFocus ? ' focus' : ''}${inP ? ' lg-inproj' : ''}`;
      return `<g class="${cls}" data-node="${esc(n.id)}" transform="translate(${P.x.toFixed(1)},${P.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(title)}" aria-haspopup="menu">
        <title>${esc(T(tip))}</title>${isFocus ? '<circle class="lg-fring" r="12"/>' : ''}${inP ? `<circle class="lg-pring" r="${r + 3}"/>` : ''}<circle r="${r}" style="${!prior || lib ? `fill:${esc(color)};` : ''}stroke:${esc(color)}"/>${labels && (!prior || n.label) ? `<text x="${isFocus ? 12 : 9}" y="4">${esc(prior ? priorName(n.wk) : nameOf(n.p))}</text>` : ''}</g>`;
    };
    const svgNodes = pn.map((n) => nodeSvg(n, true)).join('') + nodes.map((n) => nodeSvg(n, false)).join('');
    // a line with sub-lines: its name heads its first lane (the line's own lane, else the first sub-line), the
    // sub-lines are indented; the full name on hover
    const BAND_TXT = { [BAND.prior]: ['Prior works', focus ? 'What this paper builds on: the works it cites most, and the papers of your library it cites' : 'The works these papers cite most (hollow: not in your library)'], [BAND.focus]: ['This paper', 'The paper whose lineage this is'], [BAND.deriv]: ['Derivative works', 'The papers of your library that cite it'] };
    const laneLabels = L.lanes.map((l) => {
      const band = BAND_TXT[l.name];
      const color = band ? (l.name === BAND.focus ? 'var(--accent)' : 'var(--muted)') : colorOf(l.name);
      const head = !band && l.sub && l.first ? `<span class="lg-lline">${esc(l.line)} <span class="lg-lcount">${num(l.lineCount)}</span></span>` : '';
      const main = band ? band[0] : l.sub || l.name;
      const pick = AN && !band ? ` data-lane="${esc(l.name)}" role="button" tabindex="0" aria-pressed="${laneSel === l.name}"` : '';
      return `<div class="lg-lname${l.sub ? ' sub' : ''}${band && l.name !== BAND.focus ? ' prior' : ''}${l.name === BAND.focus ? ' focus' : ''}${head ? ' headed' : ''}${pick ? ' pickable' : ''}${laneSel === l.name && AN ? ' lsel' : ''}" style="top:${l.top}px;height:${l.height}px;--c:${esc(color)}" title="${esc(band ? band[1] : l.name + ` (${l.count || 0})` + (AN ? ' - click to show only the edges into this lane' : ''))}"${pick}>${head}<span class="lg-lmain"><span class="lg-dot"></span><span class="lg-lt">${esc(main)}</span><span class="lg-lcount">${num(l.count || 0)}</span></span></div>`;
    }).join('');
    const pName = targetName();
    view.innerHTML = `${notes}<div class="lg-tl" tabindex="-1">
      <div class="lg-axis" style="height:${AXIS}px"><div class="lg-axisname muted" style="width:${LABEL_W}px;height:${AXIS}px">${scaleMode === 'even' ? 'in date order' : 'time'}</div><svg class="lg-axsvg" width="${width}" height="${AXIS}" viewBox="0 0 ${width} ${AXIS}" aria-hidden="true">${tickText}</svg></div>
      <div class="lg-tl-in" style="height:${height}px">
        <div class="lg-lanes" style="width:${LABEL_W}px;height:${height}px">${laneLabels}<div class="lg-lresize" data-resize="1" title="Drag to widen the lane names" aria-hidden="true"></div></div>
        <svg class="lg-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(T('History line of these papers'))}">
          <defs><marker id="lg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class="lg-arrowhead"/></marker></defs>
          ${laneBg}${tickLines}${ancSvg}<g class="lg-edges">${paths.join('')}</g>${svgNodes}
        </svg>
      </div></div>
      <div class="lg-legend muted">${AN ? `<span>${AN.anc.length ? `Ancestry: the ${AN.anc.length} works these papers build on most (cited by 2 or more, generic works left out), a bundle into each lane - its width is how many of the lane's papers cite it; papers coloured by the ancestor they cite that most of the set cites (grey: none of them). Click an ancestor or a lane name to see its edges${ancSel != null || laneSel ? ' · <button class="lg-linkbtn" data-ancall="1">show all</button>' : ''}.` : 'No prior work is cited by two or more of these papers yet.'}</span>${AN.anc.some((a) => a.burst) ? '<span><svg width="24" height="24"><circle cx="12" cy="12" r="10" class="lg-burst"/><circle cx="12" cy="12" r="6" class="lg-filled"/></svg> bursting (half its citers from the last 12 months)</span>' : ''}` : `<span><svg width="34" height="10"><path d="M2,5 H28" class="lg-e"/><path d="M27,1 L33,5 L27,9 z" class="lg-arrowhead"/></svg> an earlier paper → a later one that cites it</span>`}${pn.some((n) => !n.wk.inLibrary) ? '<span><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" class="lg-hollow"/></svg> prior work (not in your library)</span>' : ''}${anyLibPrior ? '<span><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" class="lg-filled"/></svg> prior work in your library</span>' : ''}${anyProj ? `<span><svg width="16" height="16"><circle cx="8" cy="8" r="4" class="lg-filled"/><circle cx="8" cy="8" r="7" class="lg-pring"/></svg> in “${esc(pName)}”</span>` : ''}${focus ? '<span><svg width="20" height="20"><circle cx="10" cy="10" r="8" class="lg-fring"/><circle cx="10" cy="10" r="5" class="lg-filled"/></svg> this paper</span>' : ''}<span>${AN ? '' : num(d.edges.length) + ' citation links between these papers · '}hover a node for its title, click to see it, double-click to open it, right-click (or Shift+F10) for more</span></div>`;
    const tl = $('.lg-tl', view);
    if (st.pendingScroll) { tl.scrollLeft = st.pendingScroll.l || 0; tl.scrollTop = st.pendingScroll.t || 0; st.pendingScroll = null; }
    else if (keep) { tl.scrollLeft = keep.c * tl.scrollWidth - tl.clientWidth / 2; tl.scrollTop = keep.t; }
    else if (toEnd) tl.scrollLeft = tl.scrollWidth;
    else {
      // first view of a set: from the start (the prior works, which are older, in the top lane), scrolled only as far
      // as needed to bring the earliest library paper into view - nothing hides under the lane names at the start
      const visW = tl.clientWidth - LABEL_W;
      const libX = nodes.map((n) => L.pos[n.id].x);
      const minLib = libX.length ? Math.min(...libX) : 0;
      tl.scrollLeft = AN ? 0 : Math.max(0, Math.round(minLib - (visW - 160)));
    }
    highlightEdges(AN && ancSel != null ? 'anc:' + ancSel : sel);
  }
  function highlightEdges(id) {
    const svg = $('#lg-view .lg-svg');
    if (!svg) return;
    svg.classList.toggle('focus', !!id);
    $$('.lg-e', svg).forEach((p) => {
      const into = p.dataset.to === id, out = p.dataset.from === id;
      p.classList.toggle('in', into); p.classList.toggle('out', out);
    });
    $$('.lg-node', svg).forEach((g) => {
      const n = g.dataset.node;
      g.classList.toggle('near', !!id && n !== id && $$(`.lg-e[data-from="${CSS.escape(id)}"][data-to="${CSS.escape(n)}"], .lg-e[data-to="${CSS.escape(id)}"][data-from="${CSS.escape(n)}"]`, svg).length > 0);
    });
  }

  // ------------------------------------------------------------------ the target project (Add to project)
  const PP = () => RT.projectPapers || null;
  const hasProjects = () => { const pp = PP(); return !!(pp && pp.projects && pp.projects().length); };
  // the project Lineage adds to - never the app-wide working project changed from here (A8)
  function targetPid() {
    const pp = PP();
    if (!pp || !st) return null;
    const exists = (id) => !!pp.project(id);
    return projectTarget({ picked: st.picked, scopePid: st.scope && st.scope.scope === 'project' ? st.scope.pid : null, stored: ls.get('rt.lineage.toProject'), working: (pp.working() || {}).id }, exists);
  }
  const targetName = () => { const pid = targetPid(); const p = pid && PP().project(pid); return p ? p.name : ''; };
  const inProj = (itemId, pid = targetPid()) => !!(itemId && pid && PP() && PP().has(itemId, pid));
  const short = (s, n = 26) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s));
  // the chip "Project: P ▾" (or "Choose project"; or the reason there is none)
  function projChip() {
    if (!hasProjects()) return `<button class="ib lg-pchip" disabled title="${esc((PP() && PP().NO_PROJECT) || 'No project')}" aria-label="${esc((PP() && PP().NO_PROJECT) || 'No project')}">${RT.icon(PP() ? PP().ICON : 'bookmark')} ${esc((PP() && PP().NO_PROJECT) || 'No project')}</button>`;
    const n = targetName();
    return `<button class="ib lg-pchip${n ? '' : ' none'}" data-projchip="1" title="${n ? `Lineage adds works to “${esc(n)}” - click to choose another project (the working project of the app stays as it is)` : 'Choose the project Lineage adds works to'}" aria-label="${n ? `Target project: ${esc(n)}. Choose another` : 'Choose a project'}">${RT.icon(PP().ICON)} ${n ? `Project: ${esc(short(n))}` : 'Choose project'}${RT.icon('chevron-down', 'lg-caret')}</button>`;
  }
  // a context menu inside the Lineage window (the window is modal: a menu outside it could not be clicked)
  // (closed, the focus goes back to the control that opened it - found again by its data-* key after a re-render)
  function lgMenu(x, y, entries) {
    if (!RT.categories || !RT.categories.menu) return false;
    const opener = focusSel(document.activeElement);
    RT.categories.menu(x, y, entries);
    const m = document.querySelector('body > .ctx-menu');
    if (m && dlg.open) {
      dlg.append(m); const b = m.querySelector('button'); if (b) b.focus();
      const mo = new MutationObserver(() => { if (!m.isConnected) { mo.disconnect(); setTimeout(() => refocus(opener), 0); } });
      mo.observe(dlg, { childList: true });
    }
    return true;
  }
  // choose the target project -> pid | null (remembered in rt.lineage.toProject)
  function pickProject(x, y) {
    const pp = PP();
    if (!hasProjects()) { toast(pp ? pp.NO_PROJECT : 'No project', 'bad'); return Promise.resolve(null); }
    const cur = targetPid();
    return new Promise((resolve) => {
      let done = false;
      const end = (v) => { if (!done) { done = true; resolve(v); } };
      lgMenu(x ?? Math.round(window.innerWidth / 2 - 120), y ?? Math.round(window.innerHeight / 4), [{ head: 'Add Lineage works to' },
        ...pp.projects().map((p) => ({ label: `${p.name}${p.papers ? ` (${p.papers})` : ''}`, check: p.id === cur, run: () => { if (st) st.picked = p.id; ls.set('rt.lineage.toProject', p.id); end(p.id); render(); } }))]);
      // closed without a choice
      const m = dlg.querySelector('.ctx-menu');
      if (!m) return end(null);
      const mo = new MutationObserver(() => { if (!m.isConnected) { mo.disconnect(); setTimeout(() => end(null), 0); } });
      mo.observe(dlg, { childList: true });
    });
  }
  // the target, or the picker first when there is none (A6: with no project nothing is asked of the server)
  async function ensurePid(x, y) {
    if (!hasProjects()) { toast(PP() ? PP().NO_PROJECT : 'No project', 'bad'); return null; }
    return targetPid() || pickProject(x, y);
  }

  // ------------------------------------------------------------------ tables
  const COLS = {
    prior: [['chk', ''], ['title', 'Title'], ['last', 'Last author'], ['year', 'Year'], ['cited', 'Citations', 'How often it is cited overall (OpenAlex)', 'Cit.'], ['count', 'Cited by N of these', 'How many of these papers cite it', 'By N'], ['relevance', 'Relevance', 'Cited by these papers and by the rest of your library, with widely cited hub papers damped - hover a row for the reasons', 'Rel.'], ['lib', 'Library', 'In your library first'], ['proj', 'Proj', 'In the target project first']],
    derivative: [['chk', ''], ['title', 'Title'], ['last', 'Last author'], ['year', 'Year'], ['cited', 'Citations', 'How often it is cited overall (OpenAlex)', 'Cit.'], ['count', 'Cites N of these', 'How many of these papers it cites', 'Cites N'], ['relevance', 'Relevance', 'The papers of the set it cites, then the references it shares with them - hover a row for the reasons', 'Rel.'], ['lib', 'Library', 'In your library first'], ['proj', 'Proj', 'In the target project first']],
    similar: [['chk', ''], ['title', 'Title'], ['last', 'Last author'], ['year', 'Year'], ['cited', 'Citations', 'How often it is cited overall (OpenAlex)', 'Cit.'], ['count', 'Co-cited by M', 'How many of the works that cite these papers also cite it', 'Co-cit.'], ['relevance', 'Relevance', 'Co-citation and shared references, widely cited hub papers damped - hover a row for the reasons', 'Rel.'], ['lib', 'Library', 'In your library first'], ['proj', 'Proj', 'In the target project first']],
  };
  const SORTS = [['relevance', 'Most relevant', 'Cited by these papers and by the rest of your library; widely cited hub papers count less'], ['count', 'Most cited by these', 'How many of these papers cite it (derivative works: how many of them it cites)'], ['cited', 'Most cited overall', 'Citations in OpenAlex'], ['recent', 'Recent first', 'The newest works first']];
  const SORT_SIMILAR = [['relevance', 'Most relevant', 'Co-cited with these papers and sharing their references; hub papers count less'], ['count', 'Most co-cited', 'How many works citing these papers also cite it'], ['cited', 'Most cited overall', 'Citations in OpenAlex'], ['recent', 'Recent first', 'The newest works first']];
  // prior works whose citing sentences Semantic Scholar knows: "Builds on most" (1 + influential + 0.5 x method per citer)
  const buildsSort = (rows) => ['weighted', 'Builds on most', rows.some((e) => e.known) ? 'Per citing paper 1, +1 when Semantic Scholar marks the citation influential, +0.5 when it cites its method (intents only known for some papers)' : 'Per citing paper 1, +1 when Semantic Scholar marks the citation influential (it gives no intents for these papers)'];
  const sortsFor = (which) => (which === 'similar' ? SORT_SIMILAR : which === 'prior' && st && st.data && st.data.prior.some((e) => e.known || e.influential) ? [...SORTS.slice(0, 2), buildsSort(st.data.prior), ...SORTS.slice(2)] : SORTS);
  const dateKey = (e) => e.date || (e.year ? e.year + '-07-01' : '');
  // the rows of a table as filtered (text, the filter chips, "Hide generic") and sorted -> [{e, i}]
  function tableRows(which, { generic = true, text = true } = {}) {
    const d = st.data, s = sorts[which], pid = targetPid();
    const words = text ? (st.tfilter || '').toLowerCase().split(/\s+/).filter(Boolean) : [];
    let rows = (d[which] || []).map((e, i) => ({ e, i }));
    if (words.length) rows = rows.filter(({ e }) => words.every((w) => [e.title, e.authors.join(' '), e.last, e.venue, e.year].join(' ').toLowerCase().includes(w)));
    rows = filterRows(rows, { ...filters[which], hideGeneric: generic && filters[which].hideGeneric }, { inProject: (e) => inProj(e.inLibrary, pid) });
    const val = (e) => (s.by === 'title' ? e.title.toLowerCase() : s.by === 'last' ? String(e.last || '').toLowerCase() : s.by === 'lib' ? Number(!!e.inLibrary) : s.by === 'proj' ? Number(inProj(e.inLibrary, pid)) : s.by === 'recent' ? dateKey(e) : e[s.by] ?? -1);
    return rows.sort((a, b) => { const x = val(a.e), y = val(b.e); return (x < y ? -1 : x > y ? 1 : 0) * s.dir || (b.e.relevance || 0) - (a.e.relevance || 0) || b.e.count - a.e.count || a.i - b.i; });
  }
  // the rows the actions work on: the checked ones (as filtered) when some are checked, else all the filtered ones
  const checkedOf = (which) => (st && st.checked ? st.checked[which] : new Set());
  function actionRows(which) {
    const rows = tableRows(which), ch = checkedOf(which);
    return ch.size ? rows.filter(({ e }) => ch.has(e.key)) : rows;
  }
  const hiddenGeneric = (which) => (filters[which].hideGeneric ? tableRows(which, { generic: false }).length - tableRows(which).length : 0);
  // the rows "Add all to P" would handle (not in P yet; in the library or with a DOI / arXiv id)
  const projAddable = (which, pid = targetPid()) => actionRows(which).filter(({ e }) => !(e.inLibrary && inProj(e.inLibrary, pid)) && (e.inLibrary || e.ref) && !projAdding.has(e.key));
  // "cited by RT-2, Octo, +2 · 11 in your library" / "cites X, Y · shares 12 refs"
  function chipLine(e, which) {
    const by = papersById();
    const ids = (which === 'prior' ? e.citers : which === 'similar' ? e.via || e.cites : e.cites) || [];
    const names = ids.map((id) => by.get(id)).filter(Boolean).map((p) => shortName(p.title, 22));
    const bits = [];
    const verb = which === 'prior' ? 'cited by' : which === 'similar' ? (e.via && e.via.length ? 'co-cited with' : 'cites') : 'cites';
    if (names.length && !(st.data.stats.set === 1)) bits.push([`${verb} ${names.slice(0, 2).join(', ')}${names.length > 2 ? `, +${names.length - 2}` : ''}`]);
    if (which === 'prior' && e.libCount > e.count) bits.push([`${num(e.libCount)} in your library cite it`]);
    // Semantic Scholar's intents (B4): how the citing papers use it
    if (which === 'prior' && e.methods) bits.push([`method ×${e.methods}`, 'int', `${e.methods} of the citing papers use its method (Semantic Scholar)`]);
    if (which === 'prior' && e.influential) bits.push([`influential ×${e.influential}`, 'int', `${e.influential} of the citing papers cite it as influential (Semantic Scholar)`]);
    if (which === 'derivative' && e.coupling) bits.push([`shares ${num(e.coupling)} ${e.coupling === 1 ? 'ref' : 'refs'}`]);
    if (which === 'similar' && e.shared) bits.push([`shares ${num(e.shared)} ${e.shared === 1 ? 'ref' : 'refs'}`]);
    if (which === 'similar' && e.cocited) bits.push([`co-cited by ${num(e.cocited)}`]);
    for (const b of e.badges || []) bits.push([b, 'b-' + b.toLowerCase(), b === 'Seminal' ? 'Four or more years old and cited 500+ times' : b === 'Recent' ? 'From the last 18 months' : 'Most of its citations are from the last two years']);
    if (e.generic) bits.push(['generic', 'gen']);
    return bits.length ? `<span class="lg-chips">${bits.map(([b, c, t]) => `<span class="lg-chip${c ? ' ' + c : ''}"${t ? ` title="${esc(t)}"` : ''}>${esc(b)}</span>`).join('')}</span>` : '';
  }
  function libCell(e, which, i) {
    if (e.inLibrary) return `<button class="ib lg-have" data-open="${esc(e.inLibrary)}" title="In your library - open it" aria-label="In your library - open it">${RT.icon('check')}</button>`;
    if (e.ref && adding.has(e.ref)) return '<span class="spin" title="Being added"></span>';
    if (e.ref) return `<button class="ib lg-add" data-add="${which}:${i}" title="Add to the library (${esc(e.ref)})" aria-label="Add to the library">${RT.icon('plus')} Library</button>`;
    return '<span class="muted" title="No DOI or arXiv id is known for this one">—</span>';
  }
  // the bookmark of a row: filled = in the target project (click removes it from the project only)
  function projCell(e, which, i) {
    if (!e.inLibrary && !e.ref) return '<span class="muted" title="No DOI or arXiv id: it cannot be imported, so it cannot be added to a project">—</span>';
    if (projAdding.has(e.key)) return '<span class="spin" title="Being added to the project"></span>';
    if (!hasProjects()) return `<button class="ib lg-pj" disabled title="${esc(PP() ? PP().NO_PROJECT : 'No project')}" aria-label="${esc(PP() ? PP().NO_PROJECT : 'No project')}">${RT.icon(PP() ? PP().ICON : 'bookmark')}</button>`;
    const n = targetName();
    const on = inProj(e.inLibrary);
    const tip = !n ? 'Add to a project (choose it first)' : on ? `In “${n}” - click to remove it from the project (it stays in your library)` : e.inLibrary ? `Add to “${n}”` : `Add to “${n}” (imports it into your library first)`;
    const aria = !n ? 'Add to a project' : on ? `Remove from “${n}”` : `Add to “${n}”`;
    return `<button class="ib lg-pj${on ? ' on' : ''}" data-proj="${which}:${i}" title="${esc(tip)}" aria-label="${esc(aria)}" aria-pressed="${on}">${RT.icon(PP().ICON)}</button>`;
  }
  const yearOpts = () => { const d = st.data; const ys = [...d.prior, ...d.derivative, ...(d.similar || [])].map((e) => e.year).filter(Boolean); return ys.length ? [Math.min(...ys), Math.max(...ys)] : [1990, new Date().getFullYear()]; };
  function filterBar(which) {
    const f = filters[which], s = sorts[which];
    const [y0, y1] = yearOpts();
    const hid = hiddenGeneric(which);
    return `<div class="lg-fbar">
      <div class="seg lg-sortseg" role="group" aria-label="Order">${sortsFor(which).map(([k, n, tip]) => `<button data-sort="${k}" data-sortdir="-1" class="${s.by === k ? 'on' : ''}" title="${esc(tip)}" aria-pressed="${s.by === k}">${n}</button>`).join('')}</div>
      <label class="lg-chk" title="Hide field-wide hub papers (cited over 30,000 times, or a backbone / tool / benchmark most of these papers cite)"><input type="checkbox" data-f="hideGeneric" aria-label="Hide generic works" ${f.hideGeneric ? 'checked' : ''}> Hide generic</label>
      <span class="lg-fyear" title="Publication years"><input type="number" data-f="from" min="1900" max="2100" placeholder="${y0}" value="${esc(f.from)}" aria-label="From year">–<input type="number" data-f="to" min="1900" max="2100" placeholder="${y1}" value="${esc(f.to)}" aria-label="To year"></span>
      <label class="lg-chk"><input type="checkbox" data-f="notLib" aria-label="${which === 'prior' ? 'Missing from my library' : 'Not in library'}" ${f.notLib ? 'checked' : ''}> ${which === 'prior' ? 'Missing from my library' : 'Not in library'}</label>
      <label class="lg-chk" title="${hasProjects() ? 'Not in the target project' : esc(PP() ? PP().NO_PROJECT : '')}"><input type="checkbox" data-f="notProj" aria-label="Not in project" ${f.notProj ? 'checked' : ''} ${hasProjects() ? '' : 'disabled'}> ${which === 'prior' && targetName() ? `Missing from “${esc(short(targetName(), 16))}”` : 'Not in project'}</label>
      <select data-f="survey" aria-label="Surveys" title="Surveys: OpenAlex type review, survey / review / tutorial / overview in the title, or over 150 references"><option value="">Surveys too</option><option value="only" ${f.survey === 'only' ? 'selected' : ''}>Surveys only</option><option value="hide" ${f.survey === 'hide' ? 'selected' : ''}>Hide surveys</option></select>
      <select data-f="vtype" aria-label="Venue type"><option value="">Any venue</option>${[['conference', 'Conference'], ['journal', 'Journal'], ['preprint', 'Preprint']].map(([v, n]) => `<option value="${v}" ${f.vtype === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="lg-chk" title="An open-access PDF is known (OpenAlex), or it is on arXiv"><input type="checkbox" data-f="oa" aria-label="Has open PDF" ${f.oa ? 'checked' : ''}> Has open PDF</label>
      ${hid ? `<span class="muted lg-hidnote">${num(hid)} generic ${hid === 1 ? 'work' : 'works'} hidden - <button class="lg-linkbtn" data-showgeneric="1">show</button></span>` : ''}
    </div>`;
  }
  // the bar over a table with checked rows
  function selBar(which) {
    const ch = checkedOf(which);
    if (!ch.size) return '';
    const k = actionRows(which).length;
    const n = targetName(), nLib = addable(which).length, m = hasProjects() ? projAddable(which).length : 0;
    return `<div class="lg-selbar" role="toolbar" aria-label="Selected works"><b>${num(k)} selected</b>${k < ch.size ? ` <span class="muted">(${num(ch.size - k)} more hidden by the filters)</span>` : ''} →
      <button class="ib" data-addall="${which}" ${nLib ? '' : 'disabled'} title="${nLib ? `Add the ${nLib} selected works not in your library to it` : 'The selected works are in your library already (or have no DOI / arXiv id)'}">${RT.icon('plus')} Library (${num(nLib)})</button>
      <button class="ib" data-addproj="${which}" ${m ? '' : 'disabled'} title="${esc(hasProjects() ? (n ? `Add the ${m} selected works not in “${n}” yet to it` : 'Choose a project first') : PP() ? PP().NO_PROJECT : '')}">${RT.icon(PP() ? PP().ICON : 'plus')} ${n ? `Add to “${esc(short(n, 20))}”` : 'Add to project'} (${num(m)})</button>
      <button class="ib" data-dl="bib">${RT.icon(I.bib)} BibTeX</button><button class="ib" data-dl="csv">${RT.icon(I.csv)} CSV</button>
      <button class="ib" data-clearsel="${which}">${RT.icon('close')} Clear</button></div>`;
  }
  function renderTable(which) {
    const d = st.data;
    const sel0 = checkedOf(which).size;
    const nLib = addable(which).length, n = targetName(), m = projAddable(which).length;
    const nAct = actionRows(which).length, noRows = nAct ? '' : 'disabled';
    $('#lg-tools').innerHTML = `<input type="search" id="lg-tq" placeholder="Filter" aria-label="Filter the table" value="${esc(st.tfilter || '')}">
      ${projChip()}
      <button class="ib" data-dl="csv" ${noRows} title="${nAct ? `Download ${sel0 ? 'the selected works' : 'this table (as filtered)'} as CSV (${nAct})` : 'Nothing to export: the table is empty'}" aria-label="Download as CSV">${RT.icon(I.csv)} CSV</button>
      <button class="ib" data-dl="bib" ${noRows} title="${nAct ? `Download ${sel0 ? 'the selected works' : 'these works (as filtered)'} as BibTeX (${nAct})` : 'Nothing to export: the table is empty'}" aria-label="Download as BibTeX">${RT.icon(I.bib)} BibTeX</button>
      <button class="ib" data-grouped="1" title="For a proposal: Foundational / Recent / Surveys, as BibTeX or as a related-work bullet list" aria-label="Grouped export" aria-haspopup="menu">${RT.icon(I.group)} Grouped…</button>
      ${nLib ? `<button class="ib primary" data-addall="${which}" title="Add the ${nLib} ${sel0 ? 'selected works' : 'works of this table (as filtered)'} that are not in your library and have a DOI or arXiv id" aria-label="${sel0 ? 'Add selected' : 'Add all'} ${nLib} to the library">${RT.icon('plus')} ${sel0 ? 'Add selected' : 'Add all'} (${nLib})</button>` : ''}
      ${hasProjects() && m ? `<button class="ib primary" data-addproj="${which}" title="${n ? `Add the ${sel0 ? 'selected works' : 'works of this table (as filtered)'} that are not in “${esc(n)}” yet to it (works not in your library are imported first)` : 'Choose a project first'}" aria-label="${sel0 ? 'Add selected' : 'Add all'} ${m} to ${n ? esc(n) : 'a project'}">${RT.icon(PP().ICON)} ${sel0 ? 'Add selected' : 'Add all'} to ${n ? `“${esc(short(n, 18))}”` : 'project'} (${m})</button>` : ''}`;
    const notes = topNotes(which);
    const list = d[which];
    const view = $('#lg-view');
    const keepTop = ($('.lg-tablewrap', view) || {}).scrollTop || 0;
    // a line so new that few works cite it (B7): say so, and offer the newest works citing its top ancestors
    const young = which === 'derivative' && d.stats.set > 1 && list.length < 5 ? newLineNote() : '';
    if (which === 'similar' && !list) {
      view.innerHTML = notes + `<div class="empty lg-empty">The Similar list is made while the lineage is computed, from the works that cite these papers (no extra request) - this result is from before it existed. <button class="lg-linkbtn" data-update="1">Compute again${st.estimate ? ` (~${num(st.estimate.list)} list queries)` : ''}</button></div>`;
      return;
    }
    if (!list.length) {
      view.innerHTML = notes + young + `<div class="lg-tablewrap"><div class="empty lg-empty">${which === 'prior' ? 'No prior works: no reference list is known for these papers yet.' : which === 'similar' ? 'No similar works: too few works cite these papers yet.' : `No work is known that cites ${d.stats.set > 1 ? 'two or more of these papers' : 'this paper'}. ${d.partial ? 'The lookup is incomplete - see the note above.' : 'Recent preprints are cited later; Refresh asks again in a week.'}`}</div>${which === 'derivative' ? recentSection() : ''}</div>`;
      return;
    }
    const s = sorts[which];
    const sel = st.sel && st.sel.kind === which ? st.sel.i : -1;
    const rows = tableRows(which);
    const ch = checkedOf(which);
    const allOn = rows.length > 0 && rows.every(({ e }) => ch.has(e.key));
    const head = COLS[which].map(([k, nm, tip, sh]) => {
      if (k === 'chk') return `<th class="lg-c-chk"><input type="checkbox" data-checkall="${which}" ${allOn ? 'checked' : ''} aria-label="Select all ${rows.length} rows as filtered" title="Select all the rows as filtered"></th>`;
      return `<th class="lg-c-${k}${k === 'title' ? ' lg-ttl' : ''}" aria-sort="${s.by === k ? (s.dir < 0 ? 'descending' : 'ascending') : 'none'}"><button class="lg-sort${s.by === k ? ' on' : ''}" data-sort="${k}" title="${esc(tip || 'Sort by ' + nm.toLowerCase())}"><span class="lg-hl">${esc(nm)}</span>${sh ? `<span class="lg-hs" aria-hidden="true">${esc(sh)}</span>` : ''}${s.by === k ? RT.icon(s.dir < 0 ? 'chevron-down' : 'chevron-up', 'lg-sortic') : ''}</button></th>`;
    }).join('');
    const body = rows.map(({ e, i }) => `<tr class="${i === sel ? 'sel' : ''}${e.inLibrary ? ' have' : ''}${e.generic ? ' gen' : ''}" data-row="${which}:${i}" tabindex="0" title="${esc(whyT(e.why))}">
      <td class="lg-c-chk"><input type="checkbox" data-check="${which}:${i}" ${ch.has(e.key) ? 'checked' : ''} aria-label="Select “${esc(short(e.title, 60))}”"></td>
      <td class="lg-ttl"><span class="lg-rtitle">${esc(e.title)}</span><span class="muted lg-rmeta">${RT.byline(people(e.authors, e.more), [e.venue])}</span>${chipLine(e, which)}</td><td class="lg-c-last au">${esc(e.last || '')}</td><td class="num">${esc(e.year || '')}</td><td class="num lg-c-cited">${e.cited != null ? num(e.cited) : '—'}</td><td class="num"><b>${num(e.count)}</b></td><td class="num lg-c-relevance">${e.relevance != null ? e.relevance.toFixed(2) : ''}</td><td class="lg-act lg-act-lib">${libCell(e, which, i)}</td><td class="lg-act lg-act-proj">${projCell(e, which, i)}</td></tr>`).join('');
    const one = d.stats.set === 1;
    view.innerHTML = `<div class="lg-tablewrap">${notes}${young}${which === 'prior' ? missingStrip() : ''}${filterBar(which)}<table class="lg-table"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="9" class="empty">Nothing passes the filters.</td></tr>`}</tbody></table>${which === 'derivative' ? recentSection() : ''}${selBar(which)}</div>
      <div class="lg-legend muted">${which === 'prior' ? `The works ${one ? 'this paper cites' : 'these papers cite most'}: usually the seminal works the line builds on. “Cited by N of these” = how many of these papers cite it. “Most relevant” also counts the papers of your whole library that cite it and damps widely cited hub papers (hover a row for its reasons).` : which === 'similar' ? `Works close to ${one ? 'this paper' : 'these papers'} that are neither prior nor derivative works: co-cited with them by the works that cite them (“Co-cited by M”), or sharing many of their references - related and concurrent work, by citations, not by content.` : `Works that cite ${one ? 'this paper' : 'several of these papers'}: surveys and newer work of the same line. “Cites N of these” = how many of these papers it cites; “shares N refs” = references it has in common with ${one ? 'this paper and your library' : 'them'}.`} <span>${num(rows.length)} of ${num(list.length)} shown.</span></div>`;
    const leg = $('.lg-view > .lg-legend', dlg);
    // its title is the legend, translated piece by piece (the sentences and the count are separate text nodes)
    if (leg) leg.title = [...leg.childNodes].map((x) => T(x.textContent.trim())).filter(Boolean).join(' ');
    const tw = $('.lg-tablewrap', view);
    if (tw && st.pendingScroll) { tw.scrollTop = st.pendingScroll.t || 0; st.pendingScroll = null; }
    else if (tw && keepTop) tw.scrollTop = keepTop;
  }

  // "Top foundations you don't have" (B3): the most relevant prior works missing from the library
  function missingStrip() {
    const d = st.data;
    const rows = d.prior.map((e, i) => ({ e, i })).filter(({ e }) => !e.generic && !e.inLibrary && (d.stats.set === 1 || e.count >= 2)).slice(0, 5);
    if (!rows.length) return '';
    return `<div class="lg-miss"><b>Top foundations you don't have:</b> ${rows.map(({ e, i }) => `<span class="lg-mitem"><button class="lg-linkbtn" data-pick="prior:${i}" title="${esc(e.why ? whyT(e.why) : e.title)}">${esc(shortName(e.title, 30))}</button> <span class="muted">(${d.stats.set === 1 ? 'cited by it' : `${num(e.count)} of ${num(d.stats.set)}`})</span>${libCell(e, 'prior', i)}${projCell(e, 'prior', i)}</span>`).join('')}</div>`;
  }
  // B7: the note of a young line and its button; the list it brings, under the derivative works
  function newLineNote() {
    const d = st.data, n = (d.simStats && d.simStats.citing) || d.stats.citing || 0;
    return `<div class="notice lg-note lg-young">This line is new: only ${num(n)} ${n === 1 ? 'work cites' : 'works cite'} these papers so far${d.derivative.length ? `, and ${num(d.derivative.length)} of them cite${d.derivative.length === 1 ? 's' : ''} two or more` : ''}. ${d.recent ? '' : `<button class="lg-linkbtn" data-recentanc="1" ${st.recentBusy ? 'disabled' : ''} title="The newest works (last 18 months) that cite the top 3 prior works of these papers - one OpenAlex list query">${st.recentBusy ? '<span class="spin"></span> Asking…' : 'Recent works citing your line\'s top ancestors'}</button>`}${st.recentErr ? ` <span class="lg-warn">${esc(st.recentErr)}</span>` : ''}</div>`;
  }
  function recentSection() {
    const r = st.data.recent;
    if (!r) return '';
    const anc = (r.anc || []).map((a) => shortName(texPlain(a.title), 26));
    const ancName = new Map((r.anc || []).map((a) => [a.w, shortName(texPlain(a.title), 22)]));
    const sel = st.sel && st.sel.kind === 'recent' ? st.sel.i : -1;
    const rows = r.rows.map((e, i) => `<tr class="${i === sel ? 'sel' : ''}${e.inLibrary ? ' have' : ''}" data-row="recent:${i}" tabindex="0" title="${esc(`${e.title}\nCites ${e.ancs.map((w) => ancName.get(w)).join(', ')}${e.cites.length ? ` and ${e.cites.length} of these papers` : ''}`)}">
      <td class="lg-ttl"><span class="lg-rtitle">${esc(e.title)}</span><span class="muted lg-rmeta">${RT.byline(people(e.authors, e.more), [e.venue])}</span><span class="lg-chips">${e.ancs.map((w) => `<span class="lg-chip">cites ${esc(ancName.get(w) || w)}</span>`).join('')}${e.cites.length ? `<span class="lg-chip">cites ${num(e.cites.length)} of these</span>` : ''}${(e.badges || []).map((b) => `<span class="lg-chip b-${b.toLowerCase()}">${b}</span>`).join('')}</span></td>
      <td class="num">${esc(e.date ? e.date.slice(0, 7) : e.year || '')}</td><td class="num lg-c-cited">${e.cited != null ? num(e.cited) : '—'}</td><td class="lg-act">${libCell(e, 'recent', i)}</td><td class="lg-act">${projCell(e, 'recent', i)}</td></tr>`).join('');
    return `<div class="lg-recent"><h4>Recent works citing ${esc(anc.join(', '))} <span class="muted">· since ${esc(r.since)} · ${num(r.rows.length)}</span></h4>${rows ? `<table class="lg-table"><tbody>${rows}</tbody></table>` : '<div class="empty">None in the last 18 months.</div>'}</div>`;
  }
  async function loadRecent() {
    if (!st || !st.data || st.recentBusy) return;
    const mine = st;
    st.recentBusy = true; st.recentErr = ''; render();
    try {
      const r = await api('/api/lineage/recent', { method: 'POST', json: { key: st.data.key } });
      if (mine !== st) return;
      st.data.recent = r.recent;
      clean({ recent: r.recent });
    } catch (e) { if (mine === st) st.recentErr = e.message || String(e); }
    if (mine === st) { st.recentBusy = false; render(); }
  }

  // ------------------------------------------------------------------ details
  function selected() {
    if (!st || !st.sel || !st.data) return null;
    const s = st.sel;
    if (s.kind === 'paper') return { kind: 'paper', p: papersById().get(s.id) };
    if ([...TABLES, 'recent'].includes(s.kind)) return { kind: s.kind, e: rowsOf(s.kind)[s.i] };
    return null;
  }
  function select(sel) {
    st.sel = sel;
    if (tab === 'history') highlightEdges(sel && sel.kind === 'paper' ? sel.id : sel && sel.kind === 'prior' ? priorNodeId(sel.i) : null);
    $$('#lg-view .lg-node').forEach((g) => g.classList.toggle('sel', !!sel && g.dataset.node === (sel.kind === 'paper' ? sel.id : priorNodeId(sel.i))));
    $$('#lg-view tr[data-row]').forEach((tr) => tr.classList.toggle('sel', !!sel && tr.dataset.row === `${sel.kind}:${sel.i}`));
    $$('#lg-olist .lg-orow').forEach((b) => b.classList.toggle('sel', !!sel && sel.kind === 'paper' && b.dataset.paper === sel.id));
    renderDetail();
  }
  // a prior work shown on the history line: its node id is its position among the shown ones
  function priorNodeId(i) {
    if (!st.data) return null;
    const k = shownPrior().indexOf(st.data.prior[i]);
    return k >= 0 ? 'prior:' + k : null;
  }
  function linkList(ids, label) {
    const by = papersById();
    const list = ids.map((id) => by.get(id)).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!list.length) return '';
    return `<h4>${esc(label)} <span class="muted">${num(list.length)}</span></h4><div class="lg-links">${list.map((p) => `<button class="lg-link" data-paper="${esc(p.id)}" title="${esc(p.title)}"><span class="lg-dot" style="background:${esc(colorOf(p.category))}"></span><span>${esc(shortName(p.title, 40))}</span><span class="muted">${esc(String(p.date || '').slice(0, 4))}</span></button>`).join('')}</div>`;
  }
  // the project buttons of the details pane: "Add to P" / "In P ✓ Remove", and the chip to change P
  function projButtons(itemId, rowRef) {
    if (!hasProjects()) return `<button disabled title="${esc(PP() ? PP().NO_PROJECT : '')}">${RT.icon(PP() ? PP().ICON : 'plus')} ${esc(PP() ? PP().NO_PROJECT : 'No project')}</button>`;
    const n = targetName(), on = inProj(itemId);
    const busy = rowRef ? projAdding.has(rowRef.key) : paperBusy.has(itemId);
    const attr = rowRef ? `data-proj="${rowRef.which}:${rowRef.i}"` : `data-projpaper="${esc(itemId)}"`;
    const face = busy ? '<span class="spin"></span> Saving…' : on ? `${RT.icon('check')}<span>In “${esc(short(n, 22))}” - Remove</span>` : `${RT.icon(PP().ICON)} Add to ${n ? `“${esc(short(n, 22))}”` : 'project'}`;
    return `<span class="lg-pjgrp"><button class="${on ? '' : 'primary'} lg-pjbtn" ${attr} ${busy ? 'disabled' : ''} aria-label="${esc(on ? `Remove from “${n}”` : n ? `Add to “${n}”` : 'Add to a project')}" title="${esc(on ? `Remove it from “${n}” (it stays in your library)` : n ? `Add it to “${n}”` : 'Choose a project first')}">${face}</button><button class="ib lg-pchip mini" data-projchip="1" title="Choose the project Lineage adds to" aria-label="Choose the target project">${RT.icon('chevron-down')}</button></span>`;
  }
  function renderDetail() {
    const box = $('#lg-detail');
    const s = selected();
    markDetail();
    if (!s || (s.kind === 'paper' && !s.p) || (s.kind !== 'paper' && !s.e)) {
      box.innerHTML = `<div class="lg-dempty muted">Click a paper on the history line, in a table or on the left to see it here.</div>`;
      return;
    }
    if (s.kind === 'paper') {
      const p = s.p, d = st.data;
      const cites = d.edges.filter(([a]) => a === p.id).map(([, b]) => b);
      const citedBy = d.edges.filter(([, b]) => b === p.id).map(([a]) => a);
      const builds = d.prior.filter((w) => w.citers.includes(p.id) && !w.generic).slice(0, 8);
      const al = authorList(p.author);
      const nPD = paperRows(p.id);
      box.innerHTML = `<div class="lg-dhead"><span class="lg-dot" style="background:${esc(colorOf(p.category))}"></span><span class="muted">${esc(p.category)}</span></div>
        <h3 class="lg-dtitle">${esc(p.title)}</h3>
        <div class="lg-dmeta au">${esc(al.slice(0, 8).join(', ') + (al.length > 8 ? ' et al.' : ''))}</div>
        <div class="lg-dmeta muted">${esc([dateLabel(p) && 'first public ' + dateLabel(p), p.cited != null ? 'cited ' + num(p.cited) : '', p.refs ? `${num(p.refs)} references (${p.refSource})` : 'no reference list known'].filter(Boolean).join(' · '))}</div>
        ${p.problem ? `<div class="notice lg-note">${esc(p.problem)}</div>` : ''}
        <div class="lg-dact"><button class="primary" data-open="${esc(p.id)}">Open in reader</button>${projButtons(p.id, null)}${st.scope.scope !== 'paper' || st.scope.id !== p.id ? `<button data-focus="${esc(p.id)}" title="The lineage of this one paper and its neighbours">Lineage of this paper</button>` : ''}</div>
        ${nPD.prior.length + nPD.derivative.length && hasProjects() ? `<div class="lg-dact"><button data-pdproj="${esc(p.id)}" title="Choose which of its prior and derivative works to add to the project">${RT.icon(PP().ICON)} Add its prior + derivative works to ${targetName() ? `“${esc(short(targetName(), 20))}”` : 'a project'}…</button></div>` : ''}
        ${linkList(cites, 'Builds on (in your library)')}${linkList(citedBy, 'Built on by (in your library)')}
        ${builds.length ? `<h4>Prior works it cites</h4><div class="lg-links">${builds.map((w) => `<button class="lg-link" data-pick="prior:${d.prior.indexOf(w)}" title="${esc(w.title)}"><span class="lg-dot hollow"></span><span>${esc(shortName(w.title, 40))}</span><span class="muted">${esc(w.year || '')}</span></button>`).join('')}</div>` : ''}`;
      return;
    }
    const e = s.e, which = s.kind;
    const href = e.arxiv ? 'https://arxiv.org/abs/' + encodeURI(e.arxiv) : e.doi ? 'https://doi.org/' + encodeURI(e.doi) : e.w ? 'https://openalex.org/' + e.w : '';
    const ids = which === 'prior' ? e.citers : which === 'similar' ? e.via || e.cites || [] : e.cites || [];
    const wk = e.w ? workCache.get(e.w) : null;
    const KIND = { prior: 'Prior work', derivative: 'Derivative work', similar: 'Similar work', recent: 'Recent work citing the top ancestors' };
    const abs = !e.w ? '' : !wk ? '<p class="muted"><span class="spin"></span> Abstract…</p>' : wk.error ? `<p class="muted">${esc(wk.error)}</p>` : wk.abstract ? `<h4>Abstract</h4><p class="lg-abs">${esc(wk.abstract)}</p>` : '<p class="muted">OpenAlex has no abstract for this work.</p>';
    const authors = ((wk && wk.authors && wk.authors.length ? wk.authors : e.authors) || []).map(authorName).filter(Boolean);
    box.innerHTML = `<div class="lg-dhead"><span class="lg-dot hollow"></span><span class="muted">${KIND[which]}${e.inLibrary ? ' · in your library' : ''}${e.generic ? ' · generic' : ''}${(e.badges || []).length ? ' · ' + esc(e.badges.join(' · ')) : ''}</span></div>
      <h3 class="lg-dtitle">${esc(e.title)}</h3>
      <div class="lg-dmeta au">${esc(authors.join(', ') + (e.more ? ' et al.' : ''))}</div>
      ${e.last ? `<div class="lg-dmeta muted">Last author: <span class="au">${esc(e.last)}</span></div>` : ''}
      <div class="lg-dmeta muted">${esc([e.year, e.venue, e.cited != null ? 'cited ' + num(e.cited) : ''].filter(Boolean).join(' · '))}</div>
      ${e.why ? `<div class="lg-dmeta lg-why" title="Why it ranks where it does" data-i18n-skip>${esc(whyT(e.why))}</div>` : ''}
      <div class="lg-dact">${href ? `<a class="lg-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Open its page in the browser">${RT.icon(I.ext)} Open</a>` : ''}
        ${e.inLibrary ? `<button class="primary" data-open="${esc(e.inLibrary)}">Open in reader</button>` : e.ref ? `<button class="primary" data-add="${which}:${st.sel.i}" ${adding.has(e.ref) ? 'disabled' : ''}>${adding.has(e.ref) ? '<span class="spin"></span> Adding…' : RT.icon('plus') + ' Add to library'}</button>` : ''}
        ${e.inLibrary || e.ref ? projButtons(e.inLibrary, { which, i: st.sel.i, key: e.key }) : ''}</div>
      ${which === 'prior' && (e.citers || []).length ? contextsHtml(e) : ''}
      ${abs}
      ${linkList(ids, which === 'prior' ? 'Cited by these papers' : which === 'similar' ? (e.via && e.via.length ? 'Co-cited with these papers' : 'Cites these papers') : 'Cites these papers')}`;
    if (e.w && !workCache.has(e.w)) loadWork(e.w);
    if (which === 'prior' && (e.citers || []).length && !ctxCache.has(ctxKey(e))) loadContexts(e);
  }
  // B4: how the citing papers of the set cite a prior work - Semantic Scholar's intents, the influence flag and the
  // citing sentences; asked lazily (POST /api/lineage/contexts), kept for the session
  const ctxKey = (e) => `${(st && st.data && st.data.key) || ''}|${e.key}`;
  const INTENT_NAME = { methodology: 'uses its method', background: 'background', result: 'compares results' };
  function contextsHtml(e) {
    const c = ctxCache.get(ctxKey(e));
    if (!c || c.loading) return `<h4>How these papers cite it</h4><p class="muted"><span class="spin"></span> Asking Semantic Scholar how ${e.citers.length === 1 ? 'the citing paper cites' : `the ${num(e.citers.length)} citing papers cite`} it…</p>`;
    if (c.error) return `<h4>How these papers cite it</h4><p class="muted">${esc(c.error)}</p>`;
    const by = papersById();
    const ok = c.per.filter((x) => x.state === 'ok');
    const rows = ok.filter((x) => x.intents.length || x.influential || x.ctx.length).map((x) => {
      const p = by.get(x.id);
      return `<div class="lg-ctx"><button class="lg-link" data-paper="${esc(x.id)}" title="${esc(p ? p.title : '')}"><span class="lg-dot" style="background:${esc(colorOf(p ? p.category : UNCAT))}"></span><span>${esc(shortName(p ? p.title : x.id, 34))}</span></button>
        <span class="lg-chips">${x.influential ? '<span class="lg-chip int" title="Semantic Scholar marks this citation as influential">influential</span>' : ''}${x.intents.map((t) => `<span class="lg-chip int">${esc(INTENT_NAME[t] || t)}</span>`).join('')}</span>
        ${x.ctx.map((q) => `<blockquote class="lg-quote">“${esc(q)}”</blockquote>`).join('')}</div>`;
    }).join('');
    const quiet = ok.length - ok.filter((x) => x.intents.length || x.influential || x.ctx.length).length;
    return `<h4>How these papers cite it <span class="muted">${num(ok.length)} of ${num(c.per.length)} known</span></h4>${rows || '<p class="muted">Semantic Scholar has no intents or citing sentences for these citations.</p>'}${quiet && rows ? `<p class="muted">${num(quiet)} more cite it without a sentence Semantic Scholar could show.</p>` : ''}${c.note ? `<p class="muted lg-ctxnote">${esc(c.note)}</p>` : ''}${c.per.some((x) => x.state === 'pending') && !c.busy ? `<p><button class="lg-linkbtn" data-ctxmore="1" title="One Semantic Scholar request per paper, about one a second">Ask about ${num(Math.min(6, c.per.filter((x) => x.state === 'pending').length))} more</button></p>` : ''}`;
  }
  async function loadContexts(e) {
    const k = ctxKey(e), mine = st;
    ctxCache.set(k, { loading: true });
    try {
      const r = await api('/api/lineage/contexts', { method: 'POST', json: { ids: e.citers.slice(0, 60), work: { key: e.key, w: e.w, doi: e.doi, arxiv: e.arxiv, title: e.title } } });
      ctxCache.set(k, r);
      // the row learns its intents at once (the table chips and "Builds on most")
      const ok = r.per.filter((x) => x.state === 'ok');
      if (ok.length) {
        e.known = ok.filter((x) => x.intents.length).length; e.methods = ok.filter((x) => x.intents.includes('methodology')).length; e.influential = ok.filter((x) => x.influential).length;
        e.weighted = e.citers.length + e.influential + 0.5 * e.methods;
      }
    } catch (err) { ctxCache.set(k, { error: err.message || String(err) }); }
    if (mine === st && dlg.open) { const s2 = selected(); if (s2 && s2.e === e) renderDetail(); }
  }
  async function loadWork(w) {
    workCache.set(w, null);
    try { workCache.set(w, await api('/api/lineage/work/' + RT.enc(w))); }
    catch (err) { workCache.set(w, { error: err.message || String(err) }); }
    if (dlg.open && st && st.sel) { const s = selected(); if (s && s.e && s.e.w === w) renderDetail(); }
  }

  // ------------------------------------------------------------------ actions
  // the rows of the table as shown (filtered, checked) that can still be added
  const addable = (which) => (st && st.data ? actionRows(which).filter(({ e }) => !e.inLibrary && e.ref && !adding.has(e.ref)) : []);
  async function addAll(which) {
    const rows = addable(which);
    if (!rows.length) return toast('Every work of this table that can be added is in your library already.');
    if (!(await RT.confirm(`Add ${rows.length} ${rows.length === 1 ? 'work' : 'works'} of this table to your library?\n\nThey are imported one after the other (metadata and, when there is a free PDF, the PDF) - the Import panel shows the progress. Works without a DOI or arXiv id are left out. If automatic grouping is on, Claude groups each new paper.`, { title: 'Add all to the library', okText: `Add ${rows.length}` }))) return;
    let ok = 0, dup = 0, bad = 0;
    await Promise.all(rows.map(({ i }) => add(which, i, { quiet: true }).then((r) => { if (!r) return; if (r.state === 'failed') bad++; else if (r.state === 'dup') dup++; else ok++; })));
    toast(`Added ${ok} ${ok === 1 ? 'work' : 'works'}${dup ? ` · ${dup} already in your library` : ''}${bad ? ` · ${bad} could not be added (see the Import panel)` : ''}`, bad ? 'bad' : 'ok');
  }
  // -> the import's result; a row whose import is running already gets the running one (quiet), never a second import
  function add(which, i, opts = {}) {
    const e = rowsOf(which)[i];
    if (!e || !e.ref) return Promise.resolve(undefined);
    if (addingP.has(e.ref)) return addingP.get(e.ref);
    const p = addNow(e, opts).finally(() => addingP.delete(e.ref));
    addingP.set(e.ref, p);
    return p;
  }
  async function addNow(e, { quiet = false } = {}) {
    if (!RT.library || !RT.library.addRef) { toast('The Library is not ready yet.', 'bad'); return { state: 'failed', error: 'The Library is not ready yet.' }; }
    const mine = st;
    adding.add(e.ref); render();
    let r = null;
    try { r = await RT.library.addRef(e.ref); } catch (err) { r = { state: 'failed', error: err.message || String(err) }; }
    if (!r) r = { state: 'failed', error: 'no answer' };
    adding.delete(e.ref);
    if (!quiet) {
      if (r.state === 'failed') toast(`Could not add “${e.title.slice(0, 60)}”: ${r.error || 'unknown error'}`, 'bad');
      else if (r.state === 'dup') toast(`Already in your library: ${texPlain((r.dup && r.dup.title) || e.title)}`);
      else toast(`Added “${e.title.slice(0, 60)}”`, 'ok');
    }
    if (r.state !== 'failed') { if (r.itemId) e.inLibrary = r.itemId; else if (r.dup && r.dup.id) e.inLibrary = r.dup.id; }
    if (mine === st && dlg.open) render();
    return r;
  }
  // Add works to project pid: the ones in the library in one request; the others imported first (in parallel, as Add
  // all does), then the imported ones in one more request. One summary toast; its Undo takes exactly the works added
  // out of the project again - never out of the library. rows: [{which, i}]
  // the same work under two rows (a preprint and its published copy): one import for both
  const titleSig = (t) => texPlain(t).toLowerCase().replace(/<[^>]*>/g, ' ').replace(/\s+:\s+[^:]*\b(collaboration|consortium|team)\b[^:]*$/i, '').replace(/[^\p{L}\p{N}]+/gu, '');
  // a project deleted elsewhere: the chip and the picker forget it
  const forgetGone = () => { const pp = PP(); return Promise.resolve(pp && pp.refresh ? pp.refresh() : null).catch(() => {}).then(() => { if (st && st.picked && !(PP() && PP().project(st.picked))) st.picked = null; if (dlg.open) render(); }); };
  async function addToProject(rows, pid) {
    const pp = PP();
    if (!pp) return null;
    const mine = st;
    // a fresh look at the projects first (another window may have deleted this one)
    if (pp.refresh) await Promise.resolve(pp.refresh()).catch(() => {});
    const p = pp.project(pid);
    if (!p) { toast('That project no longer exists - choose another one (nothing was imported).', 'bad'); await forgetGone(); return null; }
    const ents = rows.map(({ which, i }) => ({ which, i, e: rowsOf(which)[i] })).filter((x) => x.e && !projAdding.has(x.e.key));
    const { inLib, importable, skipped, already } = splitForProject(ents, (id) => pp.has(id, pid));
    const busy = [...inLib, ...importable].map((x) => x.e.key);
    busy.forEach((k) => projAdding.add(k)); render();
    const added = [];
    let imported = 0, failed = 0, dupIn = 0, twins = 0, projFail = false, notAdded = 0;
    try {
      const libIds = [...new Set(inLib.map((x) => x.e.inLibrary))];
      if (libIds.length) { const r1 = await pp.toggle(libIds, { pid, on: true, quiet: true }); if (r1) added.push(...r1.ids); else { projFail = true; notAdded += libIds.length; } }
      if (!projFail) {
        const first = new Map();
        const got = await Promise.all(importable.map(async (x) => {
          const sig = titleSig(x.e.title);
          if (sig.length >= 12 && first.has(sig)) {
            // the twin of a row imported in this same go: it is that paper
            twins++;
            const r0 = await first.get(sig);
            const id0 = r0 && r0.state !== 'failed' ? r0.itemId || (r0.dup && r0.dup.id) : null;
            if (id0) x.e.inLibrary = id0;
            return null;
          }
          // a row whose own "+ Library" import is running: this waits for it (add() hands out the running import)
          const pr = add(x.which, x.i, { quiet: true });
          if (sig.length >= 12) first.set(sig, pr);
          const r = await pr;
          if (!r || r.state === 'failed') { failed++; return null; }
          const id = r.itemId || (r.dup && r.dup.id) || null;
          if (!id) { failed++; return null; }
          if (r.state === 'dup' && pp.has(id, pid)) { dupIn++; return null; }
          if (r.state !== 'dup') imported++;
          return id;
        }));
        const newIds = [...new Set(got.filter(Boolean))].filter((id) => !libIds.includes(id) && !pp.has(id, pid));
        if (newIds.length) { const r2 = await pp.toggle(newIds, { pid, on: true, quiet: true }); if (r2) added.push(...r2.ids); else { projFail = true; notAdded += newIds.length; } }
      }
    } finally { busy.forEach((k) => { projAdding.delete(k); lastToggle.set(k, Date.now()); }); }
    const ids = [...added];
    const inIt = already + dupIn;
    const tail = `${inIt ? ` · ${inIt} already in it${dupIn ? ` (${dupIn} found in your library on import)` : ''}` : ''}${twins ? ` · ${twins} ${twins === 1 ? 'was a second copy' : 'were second copies'} of the same paper (imported once)` : ''}${skipped.length ? ` · ${skipped.length} skipped (no DOI/arXiv)` : ''}${failed ? ` · ${failed} failed` : ''}`;
    if (projFail) {
      // the project change failed (the project deleted meanwhile, the server unreachable): say so, never "Added"
      toast(`Could not add ${notAdded} to “${p.name}” - it may have been deleted${ids.length ? ` · ${ids.length} added before that` : ''}${imported ? ` · ${imported} newly imported into your library (they stay there)` : ''}${tail}`, 'bad');
      await forgetGone();
      return { added: ids, imported, failed, skipped: skipped.length, already: inIt, error: true };
    }
    const msg = `Added ${ids.length} to “${p.name}”${imported ? ` (${imported} newly imported)` : ''}${tail}`;
    if (ids.length) toast(msg, failed ? 'bad' : 'ok', { label: ids.length === 1 ? `Undo: take it out of “${p.name}” again (the library keeps it)` : `Undo: take these ${ids.length} out of “${p.name}” again (the library keeps them)`, run: () => pp.toggle(ids, { pid, on: false, quiet: true }).then((r) => { if (r) toast(ids.length === 1 ? `Took 1 out of “${p.name}” - your library keeps it` : `Took ${ids.length} out of “${p.name}” - your library keeps them`); else forgetGone(); }) });
    else toast(msg, failed ? 'bad' : '');
    if (mine === st && dlg.open) render();
    return { added: ids, imported, failed, skipped: skipped.length, already: inIt };
  }
  // one row's bookmark: add (import first when needed) or, when it is a member, remove it from the project
  async function toggleRowProject(which, i, ev) {
    const e = rowsOf(which)[i];
    if (!e || projAdding.has(e.key) || tooSoon(e.key)) return;
    projAdding.add(e.key);
    let pid = null;
    try { pid = await ensurePid(ev && ev.clientX, ev && ev.clientY); } finally { projAdding.delete(e.key); }
    if (!pid || projAdding.has(e.key)) return;
    if (e.inLibrary && inProj(e.inLibrary, pid)) {
      projAdding.add(e.key); render();
      let r = null;
      try { r = await PP().toggle([e.inLibrary], { pid, on: false }); } finally { projAdding.delete(e.key); lastToggle.set(e.key, Date.now()); }
      if (!r) return forgetGone();
      return render();
    }
    return addToProject([{ which, i }], pid);
  }
  // a library paper (details pane, a history-line node): one change at a time - a double click is one change
  async function togglePaperProject(id, ev) {
    if (paperBusy.has(id) || tooSoon(id)) return;
    paperBusy.add(id);
    let pid = null;
    try { pid = await ensurePid(ev && ev.clientX, ev && ev.clientY); } finally { if (!pid) paperBusy.delete(id); }
    if (!pid) return;
    render();
    let r = null;
    try { r = await PP().toggle([id], { pid, on: !inProj(id, pid) }); } finally { paperBusy.delete(id); lastToggle.set(id, Date.now()); }
    if (!r) return forgetGone();
    render();
  }
  // a small dialog of the write UI (styled like the others) -> its result, or null
  function formDialog(html, read) {
    const ui = RT.write && RT.write.ui;
    if (!ui || !ui.openDialog) return null;
    return ui.openDialog(html, read, 'lg-pdlg');
  }
  // "Add all to P": the rows as filtered / checked, the first N as sorted (25 unless changed)
  async function addAllToProject(which, ev) {
    const pid = await ensurePid(ev && ev.clientX, ev && ev.clientY);
    if (!pid) return;
    const p = PP().project(pid);
    const all = projAddable(which, pid);
    if (!all.length) return toast(`Every work of this table that can be added is in “${p.name}” already.`);
    const sel = checkedOf(which).size > 0;
    const summary = (n) => { const x = splitForProject(all.slice(0, n), (id) => PP().has(id, pid)); return { n: x.inLib.length + x.importable.length, lib: x.inLib.length, imp: x.importable.length, skip: actionRows(which).filter(({ e }) => !e.inLibrary && !e.ref).length }; };
    const text = (n) => { const x = summary(n); return `${x.n} ${x.n === 1 ? 'work' : 'works'} → “${p.name}”: ${x.lib} already in your library, ${x.imp} to import first, ${x.skip} skipped (no DOI/arXiv).`; };
    const cap0 = Math.min(25, all.length);
    const dl = formDialog(`<form method="dialog"><h3>${sel ? 'Add the selected works' : 'Add all'} to “${esc(p.name)}”</h3>
      <p class="dlg-msg"><label>The first <input type="number" class="lg-cap" min="1" max="${all.length}" value="${cap0}" aria-label="How many rows"> rows as sorted (of ${all.length})</label></p>
      <p class="dlg-msg lg-capsum">${esc(text(cap0))}</p>
      <p class="muted dlg-msg">Works not in your library are imported first - the Import panel shows the progress. Undo takes them out of the project again; the library keeps them.</p>
      ${RT.write.ui.dlgActions({ okText: 'Add to the project', icon: 'check' })}</form>`, (d) => Number($('.lg-cap', d).value) || 0);
    let n;
    if (!dl) { n = (await RT.confirm(text(cap0), { title: `Add to “${p.name}”`, okText: 'Add' })) ? cap0 : 0; }
    else {
      const capIn = $('.lg-cap', dl.d);
      capIn.addEventListener('input', () => { $('.lg-capsum', dl.d).textContent = text(Math.max(0, Math.min(all.length, Number(capIn.value) || 0))); });
      capIn.focus(); capIn.select();
      n = await dl.result;
    }
    n = Math.max(0, Math.min(all.length, Number(n) || 0));
    if (!n) return;
    return addToProject(all.slice(0, n).map(({ i }) => ({ which, i })), pid);
  }
  // the prior and derivative works of one library paper: with a one-paper scope of it, the two tables; else the rows
  // whose citers (prior) or cited papers (derivative) include it
  function paperRows(id) {
    const d = st && st.data;
    if (!d) return { prior: [], derivative: [] };
    const one = st.scope.scope === 'paper' && st.scope.id === id;
    const pick = (which) => d[which].map((e, i) => ({ which, i, e })).filter(({ e }) => one || (which === 'prior' ? e.citers : e.cites || []).includes(id));
    return { prior: pick('prior'), derivative: pick('derivative') };
  }
  async function addPaperWorks(id, ev) {
    const pid = await ensurePid(ev && ev.clientX, ev && ev.clientY);
    if (!pid) return;
    const p = PP().project(pid), paper = papersById().get(id);
    const R = paperRows(id), multi = st.data.stats.set > 1;
    const pickRows = (o) => {
      const take = (list) => list.filter(({ e }) => (!o.noGeneric || !e.generic) && (!multi || e.count >= o.k) && !(e.inLibrary && PP().has(e.inLibrary, pid)) && (e.inLibrary || e.ref)).slice(0, o.top);
      return [...(o.prior ? take(R.prior) : []), ...(o.derivative ? take(R.derivative) : [])];
    };
    const read = (d) => ({ prior: $('[name=pr]', d).checked, derivative: $('[name=de]', d).checked, k: Number(($('[name=k]', d) || {}).value) || 1, top: Number($('[name=top]', d).value) || 0, noGeneric: $('[name=ng]', d).checked });
    const sumText = (o) => { const rows = pickRows(o); const x = splitForProject(rows); return `${rows.length} works → “${p.name}”: ${x.inLib.length} in your library, ${x.importable.length} to import first.`; };
    const dl = formDialog(`<form method="dialog"><h3>Add the prior and derivative works of “${esc(short(paper ? paper.title : 'this paper', 60))}” to “${esc(p.name)}”</h3>
      <p class="dlg-msg"><label><input type="checkbox" name="pr" checked> Prior works (${R.prior.length})</label> &nbsp; <label><input type="checkbox" name="de" checked> Derivative works (${R.derivative.length})</label></p>
      ${multi ? '<p class="dlg-msg"><label>Only rows cited by (or citing) at least <input type="number" name="k" min="1" value="1" style="width:5em"> of these papers</label></p>' : ''}
      <p class="dlg-msg"><label>Top <input type="number" name="top" min="1" value="10" style="width:5em"> of each, most relevant first</label> &nbsp; <label title="Field-wide hub papers"><input type="checkbox" name="ng" checked> Exclude generic</label></p>
      <p class="dlg-msg lg-capsum"></p>
      ${RT.write.ui.dlgActions({ okText: 'Add to the project', icon: 'check' })}</form>`, read);
    if (!dl) return;
    const upd = () => { $('.lg-capsum', dl.d).textContent = sumText(read(dl.d)); };
    dl.d.addEventListener('input', upd); dl.d.addEventListener('change', upd); upd();
    const o = await dl.result;
    if (!o) return;
    const rows = pickRows(o);
    if (!rows.length) return toast('Nothing to add with these choices.');
    return addToProject(rows, pid);
  }
  // the context menu of a node of the history line (right click, the Menu key, Shift+F10)
  function nodeMenu(node, x, y) {
    if (!st || !st.data) return;
    const n = targetName() ? `“${short(targetName(), 24)}”` : 'a project';
    const items = [];
    if (node.startsWith('prior:') || node.startsWith('anc:')) {
      const w = node.startsWith('anc:') ? ancOf(node) : shownPrior()[Number(node.slice(6))];
      const i = st.data.prior.indexOf(w);
      if (!w) return;
      items.push({ head: short(w.title, 50) });
      if (w.inLibrary || w.ref) items.push({ label: w.inLibrary && inProj(w.inLibrary) ? `Remove from ${n}` : `Add to ${n}`, run: () => toggleRowProject('prior', i, { clientX: x, clientY: y }) });
      if (!w.inLibrary && w.ref) items.push({ label: 'Add to library', run: () => add('prior', i) });
      if (w.inLibrary) { items.push({ label: 'Lineage of this paper', run: () => focusPaper(w.inLibrary) }, { label: 'Open in reader', run: () => openPaper(w.inLibrary) }); }
      items.push({ label: 'Details', run: () => select({ kind: 'prior', i }) });
    } else {
      const p = papersById().get(node);
      if (!p) return;
      items.push({ head: short(p.title, 50) });
      if (hasProjects()) items.push({ label: inProj(p.id) ? `Remove from ${n}` : `Add to ${n}`, run: () => togglePaperProject(p.id, { clientX: x, clientY: y }) });
      if (!(st.scope.scope === 'paper' && st.scope.id === p.id)) items.push({ label: 'Lineage of this paper', run: () => focusPaper(p.id) });
      items.push({ label: 'Open in reader', run: () => openPaper(p.id) });
      const R = paperRows(p.id);
      if (hasProjects() && R.prior.length + R.derivative.length) items.push({ label: `Add its prior + derivative works to ${n}…`, run: () => addPaperWorks(p.id, { clientX: x, clientY: y }) });
    }
    lgMenu(x, y, items);
  }
  // the prior work behind an ancestor node 'anc:j' (Ancestry mode)
  const ancOf = (node) => { const A = ancestry(st.data.papers, st.data.prior, { laneOf: (p) => p.category }); const a = A.anc[Number(String(node).slice(4))]; return a ? a.e : null; };
  function focusPaper(id) { fillScopes('paper:' + id); setScope({ scope: 'paper', id }); }
  // Open in reader (B8): the window closes, a "Back to Lineage" chip brings it back as it was (no recompute)
  function openPaper(id) {
    if (st && st.data) {
      const tl = $('#lg-view .lg-tl'), tw = $('#lg-view .lg-tablewrap');
      resume = { scope: st.scope, value: $('#lg-scope').value, adhoc, tab, zoom, sel: st.sel, tfilter: st.tfilter || '', scroll: { l: tl ? tl.scrollLeft : 0, t: tl ? tl.scrollTop : tw ? tw.scrollTop : 0 }, label: scopeLabel() };
    }
    dlg.close();
    releaseToast(); // now: the 'close' event comes later, and the Back chip goes beside the toast in the header
    if (RT.setView) RT.setView('library');
    if (RT.library && RT.library.select) RT.library.select(id);
    if (resume) showBack();
  }
  function showBack() {
    hideBack();
    // in the page header (it covers nothing there); at the foot of the window when there is no header
    const html = `<div id="lg-back" class="lg-back" role="region" aria-label="Lineage"><button class="primary" data-back="1" title="Reopen the Lineage window where you left it (${esc(resume.label)})">${RT.icon(I.lineage)} Back to Lineage</button><button class="ib" data-backx="1" title="Dismiss" aria-label="Dismiss">${RT.icon('close')}</button></div>`;
    const spot = document.querySelector('body > header #toast');
    if (spot) spot.insertAdjacentHTML('beforebegin', html); else document.body.insertAdjacentHTML('beforeend', html.replace('class="lg-back"', 'class="lg-back float"'));
    const el = $('#lg-back');
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.backx) { resume = null; return hideBack(); }
      reopen();
    });
  }
  function hideBack() { const el = document.getElementById('lg-back'); if (el) el.remove(); }
  function reopen() {
    const r = resume;
    if (!r) return;
    hideBack();
    if (r.adhoc) adhoc = r.adhoc;
    fillScopes(r.value);
    if (!dlg.open) dlg.showModal();
    adoptToast();
    tab = r.tab;
    setScope(r.scope, { back: r });
    zoom = r.zoom || 1;
  }
  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function save(name, text, type) {
    const href = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = href; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  }
  const fileBase = () => 'lineage-' + (scopeLabel() || 'library').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50).toLowerCase() + '-' + tab;
  function download(kind) {
    const which = tab, rows = actionRows(which).map((r) => r.e);
    if (!rows.length) return toast('Nothing to export: no rows.');
    const what = `${rows.length} ${rows.length === 1 ? 'work' : 'works'}`;
    if (kind === 'csv') {
      const head = ['Title', 'Authors', 'Last author', 'Year', 'Venue', 'Citations', which === 'prior' ? 'Cited by N of these' : which === 'similar' ? 'Co-cited by M' : 'Cites N of these', 'Relevance', 'Generic', 'DOI', 'arXiv', 'OpenAlex', 'In library'];
      const lines = [head, ...rows.map((e) => [e.title, e.authors.join('; ') + (e.more ? '; et al.' : ''), e.last, e.year, e.venue, e.cited, e.count, e.relevance != null ? e.relevance.toFixed(2) : '', e.generic ? 'yes' : '', e.doi, e.arxiv, e.w, e.inLibrary ? 'yes' : ''])].map((r) => r.map(csvCell).join(','));
      save(fileBase() + '.csv', '﻿' + lines.join('\n') + '\n', 'text/csv;charset=utf-8');
      toast(`Saved ${what} as CSV (${fileBase()}.csv)`, 'ok');
    } else {
      save(fileBase() + '.bib', bibOf(rows, which) + '\n', 'application/x-bibtex;charset=utf-8');
      toast(`Saved ${what} as BibTeX (${fileBase()}.bib)`, 'ok');
    }
  }
  // BibTeX of rows: a work of your library keeps its own cite key (so \cite works in your documents)
  function bibOf(rows, which, used = new Set()) {
    const keyOfLib = new Map(libItems().map((it) => [it.id, it.citekey]));
    const note = (e) => (which === 'prior' ? `Prior work: cited by ${e.count} papers of the set` : which === 'similar' ? `Similar work: co-cited with the set by ${e.cocited || 0} works` : which === 'recent' ? 'Recent work citing the top ancestors of the set' : `Derivative work: cites ${e.count} papers of the set`);
    return rows.map((e) => {
      const lib = e.inLibrary && keyOfLib.get(e.inLibrary);
      const key = lib && !used.has(lib) ? (used.add(lib), lib) : citeKey(e, used);
      return bibEntry(e, { key, note: note(e) });
    }).join('\n\n');
  }
  // the grouped export (B8): Foundational / Recent / Surveys as BibTeX, or a related-work bullet list to paste
  function groupedMenu(x, y) {
    const groups = groupedRows(st.data);
    if (!groups.length) return toast('Nothing to export yet.');
    const which = (e) => (st.data.prior.includes(e) ? 'prior' : (st.data.similar || []).includes(e) ? 'similar' : 'derivative');
    const sum = groups.map(([n, l]) => `${T(n)} ${l.length}`).join(', ');
    lgMenu(x, y, [{ head: `Grouped: ${sum}` },
      { label: 'Download grouped BibTeX', run: () => { const used = new Set(); save(fileBase().replace(/-[a-z]+$/, '') + '-grouped.bib', groups.map(([n, l]) => `% ==== ${n} (${l.length}) ====\n\n` + l.map((e) => bibOf([e], which(e), used)).join('\n\n')).join('\n\n') + '\n', 'application/x-bibtex;charset=utf-8'); } },
      { label: 'Copy as a related-work bullet list', run: async () => { const text = bulletList(groups, st.data.stats.set); try { await navigator.clipboard.writeText(text); toast(`Copied ${groups.reduce((a, [, l]) => a + l.length, 0)} works as a bullet list (${sum})`, 'ok'); } catch { save(fileBase().replace(/-[a-z]+$/, '') + '-related-work.txt', text, 'text/plain;charset=utf-8'); } } }]);
  }
  // Save the history line as SVG (B8): the chart with its computed styles inlined, the lane names and the axis
  const SVG_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linejoin', 'stroke-linecap', 'paint-order', 'opacity', 'font-size', 'font-weight', 'font-family', 'font-style', 'text-anchor', 'display', 'visibility'];
  function inlineStyles(src, dst) {
    const a = [src, ...src.querySelectorAll('*')], b = [dst, ...dst.querySelectorAll('*')];
    a.forEach((el, i) => {
      const d = b[i];
      if (!d || !d.setAttribute || el.tagName.toLowerCase() === 'title') return;
      const cs = getComputedStyle(el);
      d.setAttribute('style', SVG_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
      for (const x of ['class', 'tabindex', 'role', 'aria-label', 'aria-haspopup', 'aria-pressed', 'data-node', 'data-from', 'data-to', 'data-anc']) d.removeAttribute(x);
    });
  }
  function exportSvg() {
    const svg = $('#lg-view .lg-svg'), axis = $('#lg-view .lg-axsvg');
    if (!svg) return;
    const W = Number(svg.getAttribute('width')), H = Number(svg.getAttribute('height')), LW = laneW, AX = 28;
    const c1 = svg.cloneNode(true), c2 = axis ? axis.cloneNode(true) : null;
    inlineStyles(svg, c1); if (c2) inlineStyles(axis, c2);
    const ink = getComputedStyle(dlg).color, bg = getComputedStyle($('#lg-view .lg-lanes') || dlg).backgroundColor, font = getComputedStyle(svg).fontFamily;
    const lanes = $$('#lg-view .lg-lname').map((el) => {
      const line = $('.lg-lline', el), main = $('.lg-lt', el), cnt = $('.lg-lmain .lg-lcount', el);
      return `<rect x="0" y="${parseFloat(el.style.top) + AX}" width="4" height="${parseFloat(el.style.height)}" fill="${getComputedStyle(el).borderLeftColor}"/>${line ? `<text x="6" y="${parseFloat(el.style.top) + AX + 14}" font-weight="650" fill="${ink}">${esc(line.firstChild.textContent.trim())}</text>` : ''}<text x="${el.classList.contains('sub') ? 18 : 10}" y="${parseFloat(el.style.top) + AX + (line ? 29 : 16)}" fill="${ink}">${esc((main ? main.textContent : '') + (cnt ? ' (' + cnt.textContent + ')' : ''))}</text>`;
    }).join('');
    const out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${LW + W}" height="${AX + H}" viewBox="0 0 ${LW + W} ${AX + H}" font-family="${esc(font)}" font-size="11"><title>${esc('History line: ' + scopeLabel())}</title><rect width="100%" height="100%" fill="${bg}"/>${c2 ? `<g transform="translate(${LW},0)">${c2.innerHTML}</g>` : ''}<g transform="translate(${LW},${AX})">${c1.innerHTML}</g><rect x="0" y="0" width="${LW}" height="${AX + H}" fill="${bg}"/>${lanes}</svg>\n`;
    save(fileBase() + '.svg', out, 'image/svg+xml;charset=utf-8');
    toast('Saved the history line as SVG', 'ok');
  }

  // ------------------------------------------------------------------ the custom set (B3): several lines and sub-lines,
  // and / or the papers matching some words, under a name of your own (rt.lineage.custom)
  function closePop() { const p = dlg.querySelector('.lg-pop'); if (p) p.replaceWith(); }
  function openCustom(prev, edit = null) {
    closePop();
    const items = libItems();
    const lanes = laneOrder(items.map((i) => ({ category: catOf(i) })), UNCAT);
    const picked = new Set((edit && edit.lines) || []);
    let last = null;
    const boxes = [];
    for (const l of lanes) {
      if (l.line !== last) {
        last = l.line;
        if (lanes.some((x) => x.line === l.line && x.sub)) boxes.push(`<label class="lg-cl"><input type="checkbox" data-cline="${esc(l.line)}" ${picked.has(l.line) ? 'checked' : ''}> <b>${esc(l.line)}</b> <span class="muted">${num(l.lineCount)}</span></label>`);
      }
      boxes.push(`<label class="lg-cl${l.sub ? ' sub' : ''}"><input type="checkbox" data-cline="${esc(l.name)}" ${picked.has(l.name) ? 'checked' : ''}> ${esc(l.sub || l.name)} <span class="muted">${num(l.count)}</span></label>`);
    }
    const n0 = edit ? edit.name : RT.i18n ? RT.i18n.t('My set {0}', customSets().length + 1) : `My set ${customSets().length + 1}`;
    dlg.insertAdjacentHTML('beforeend', `<div class="lg-pop" role="dialog" aria-label="A set of your own" aria-modal="false">
      <h4>A set of your own</h4>
      <p class="muted">Tick research lines and sub-lines (a line takes all its sub-lines) and / or type words every one of which must be in a paper's title, tags or category. The set is remembered under its name in this browser.</p>
      <div class="lg-clines">${boxes.join('')}</div>
      <label class="lg-cq">Papers matching <input type="search" data-cq placeholder="e.g. VLA" value="${esc((edit && edit.q) || '')}"></label>
      <label class="lg-cq">Name <input type="text" data-cname maxlength="60" value="${esc(n0)}"></label>
      <div class="lg-csum muted" role="status"></div>
      <div class="lg-cact"><button class="primary" data-cgo="1">${RT.icon('check')} Use this set</button><button data-ccancel="1">Cancel</button>${edit ? '<button data-cdel="1" title="Forget this set">Delete</button>' : ''}</div>
    </div>`);
    const pop = dlg.querySelector('.lg-pop');
    pop.dataset.prev = prev;
    const read = () => ({ lines: $$('[data-cline]:checked', pop).map((x) => x.dataset.cline), q: $('[data-cq]', pop).value.trim(), name: $('[data-cname]', pop).value.trim() });
    const upd = () => { const o = read(); const ids = customIds(items, o, UNCAT); $('.lg-csum', pop).textContent = `${num(ids.length)} ${ids.length === 1 ? 'paper' : 'papers'}`; $('[data-cgo]', pop).disabled = !ids.length || !o.name; };
    pop.addEventListener('input', upd); pop.addEventListener('change', upd); upd();
    pop.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      ev.stopPropagation();
      if (b.dataset.ccancel) { closePop(); $('#lg-scope').value = prev; $('#lg-scope').focus(); return; }
      if (b.dataset.cdel && edit) { saveCustom(customSets().filter((c) => c.name !== edit.name)); closePop(); fillScopes('library'); return setScope({ scope: 'library' }); }
      if (b.dataset.cgo) {
        const o = read(), ids = customIds(items, o, UNCAT);
        if (!ids.length || !o.name) return;
        saveCustom([{ name: o.name, ids, lines: o.lines, q: o.q }, ...customSets().filter((c) => c.name !== o.name && !(edit && c.name === edit.name))]);
        closePop();
        fillScopes('set:' + o.name);
        setScope({ scope: 'ids', ids, label: o.name });
      }
    });
    $('[data-cq]', pop).focus();
  }

  // ------------------------------------------------------------------ events
  $('#lg-scope').addEventListener('change', (ev) => {
    const v = ev.target.value;
    if (v === 'custom') return openCustom(scopePrev);
    scopePrev = v;
    setScope(scopeOf(v));
  });
  $('#lg-close').addEventListener('click', () => dlg.close());
  $('#lg-refresh').addEventListener('click', () => request(st && st.data ? 'refresh' : 'auto'));
  dlg.addEventListener('close', () => { stopPoll(); releaseToast(); });
  // Esc in a menu of the window closes the menu, not the window
  // (the keydown itself is cancelled: Chrome honours preventDefault in the 'cancel' event only once per user
  // activation, so a second Esc in a row would close the window; the menu's own listener on document still closes it)
  let menuEsc = false;
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (dlg.querySelector('.ctx-menu')) { menuEsc = true; ev.preventDefault(); return; }
    // ... and in the custom-set popover, the popover (focus back on the scope it was opened from)
    const pop = dlg.querySelector('.lg-pop');
    if (pop) { menuEsc = true; ev.preventDefault(); ev.stopPropagation(); $('#lg-scope').value = pop.dataset.prev || 'library'; closePop(); $('#lg-scope').focus(); }
  }, true);
  dlg.addEventListener('cancel', (ev) => { if (menuEsc) { ev.preventDefault(); menuEsc = false; } });
  $('#lg-oq').addEventListener('input', (ev) => { if (st) { st.filter = ev.target.value; renderOrigin(); } });
  $('#lg-tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-tab]'); if (!b || !st) return;
    tab = b.dataset.tab; ls.set('rt.lineage.tab', tab); st.tfilter = ''; render();
  });
  dlg.addEventListener('click', (ev) => {
    if (!st) return;
    if (ev.target.matches && ev.target.matches('input, select, label, label *')) return; // checkboxes and filters: 'change'
    if (ev.target.closest && ev.target.closest('.lg-pop')) return;
    const t = ev.target.closest('button, a, tr[data-row], g.lg-node, .lg-lname[data-lane]');
    if (!t) return;
    if (t.id === 'lg-go') return request('auto');
    if (t.dataset.update) return request('refresh');
    if (t.dataset.ctxmore) { const s0 = selected(); if (s0 && s0.e) { ctxCache.delete(ctxKey(s0.e)); renderDetail(); } return; }
    if (t.dataset.recentanc) return loadRecent();
    if (t.dataset.grouped) { const r = t.getBoundingClientRect(); return groupedMenu(r.left, r.bottom + 4); }
    if (t.dataset.svg) return exportSvg();
    if (t.dataset.hmode) { hmode = t.dataset.hmode; ls.set('rt.lineage.hmode', hmode); ancSel = null; laneSel = null; zoom = 1; st.pendingScroll = { l: 0, t: 0 }; return keep(renderHistory); }
    if (t.dataset.ancall) { ancSel = null; laneSel = null; return keep(renderHistory); }
    if (t.dataset.lane) { laneSel = laneSel === t.dataset.lane ? null : t.dataset.lane; ancSel = null; return keep(renderHistory); }
    if (t.dataset.clearex) { st.excluded.clear(); return renderOrigin(); }
    if (t.dataset.runex) {
      const all = st.data ? st.data.papers.filter((p) => p.origin).map((p) => p.id) : st.originIds || [];
      const ids = all.filter((id) => !st.excluded.has(id));
      if (!ids.length) return;
      const sc = { scope: 'ids', ids, label: `${scopeLabel()} − ${all.length - ids.length}` };
      fillScopes(scopeValue(sc));
      return setScope(sc);
    }
    if (t.dataset.hidenotes) { st.notesHidden = true; $$('#lg-view .lg-notes').forEach((n) => n.replaceWith()); return; }
    if (t.dataset.open) { ev.preventDefault(); return openPaper(t.dataset.open); }
    if (t.dataset.focus) return focusPaper(t.dataset.focus);
    if (t.dataset.add) { const [w, i] = t.dataset.add.split(':'); ev.stopPropagation(); return add(w, Number(i)); }
    if (t.dataset.projchip) { const r = t.getBoundingClientRect(); return pickProject(r.left, r.bottom + 4); }
    if (t.dataset.proj) { const [w, i] = t.dataset.proj.split(':'); ev.stopPropagation(); return toggleRowProject(w, Number(i), ev); }
    if (t.dataset.projpaper) return togglePaperProject(t.dataset.projpaper, ev);
    if (t.dataset.pdproj) return addPaperWorks(t.dataset.pdproj, ev);
    if (t.dataset.addproj) return addAllToProject(t.dataset.addproj, ev);
    if (t.dataset.clearsel) { st.checked[t.dataset.clearsel].clear(); render(); const ca = dlg.querySelector('[data-checkall]'); if (ca) ca.focus(); return; }
    if (t.dataset.showgeneric) { filters[tab].hideGeneric = false; saveFilters(); return render(); }
    if (t.dataset.outlineage) return focusPaper(t.dataset.outlineage);
    if (t.dataset.outadd) return addOutside(t.dataset.outadd);
    if (t.dataset.paper) return select({ kind: 'paper', id: t.dataset.paper });
    if (t.dataset.pick) { const [k, i] = t.dataset.pick.split(':'); return select({ kind: k, i: Number(i) }); }
    if (t.dataset.sort) {
      const s = sorts[tab];
      if (t.dataset.sortdir) { s.by = t.dataset.sort; s.dir = -1; }
      else if (s.by === t.dataset.sort) s.dir = -s.dir;
      else { s.by = t.dataset.sort; s.dir = t.dataset.sort === 'title' || t.dataset.sort === 'last' ? 1 : -1; }
      return render();
    }
    if (t.dataset.dl) return download(t.dataset.dl);
    if (t.dataset.addall) return addAll(t.dataset.addall);
    if (t.dataset.scale) { scaleMode = t.dataset.scale; ls.set('rt.lineage.scale', scaleMode); zoom = 1; return keep(renderHistory); }
    if (t.dataset.zoom) {
      if (t.dataset.zoom === 'fit') { fitPending = true; zoom = 1; }
      else if (t.dataset.zoom === 'year') { yearPending = true; zoom = 1; }
      else zoom = Math.max(0.3, Math.min(8, zoom * (t.dataset.zoom === 'in' ? 1.5 : 1 / 1.5)));
      return keep(renderHistory);
    }
    if (t.dataset.row) { const [k, i] = t.dataset.row.split(':'); return select({ kind: k, i: Number(i) }); }
    if (t.dataset.node) {
      const n = t.dataset.node;
      if (n.startsWith('prior:')) { const shown = shownPrior(); return select({ kind: 'prior', i: st.data.prior.indexOf(shown[Number(n.slice(6))]) }); }
      // an ancestor (Ancestry): its edges (again: all of them), and its details
      if (n.startsWith('anc:')) { const j = Number(n.slice(4)); ancSel = ancSel === j ? null : j; laneSel = null; const w = ancOf(n); st.sel = w ? { kind: 'prior', i: st.data.prior.indexOf(w) } : st.sel; keep(renderHistory); return renderDetail(); }
      return select({ kind: 'paper', id: n });
    }
  });
  dlg.addEventListener('dblclick', (ev) => {
    const g = ev.target.closest('g.lg-node, .lg-orow');
    if (!g) return;
    const id = g.dataset.node || g.dataset.paper;
    if (id && !/^(prior|anc):/.test(id)) openPaper(id);
  });
  // the menu of a history-line node: right click
  dlg.addEventListener('contextmenu', (ev) => {
    const g = ev.target.closest && ev.target.closest('g.lg-node');
    if (!g || !st) return;
    ev.preventDefault();
    nodeMenu(g.dataset.node, ev.clientX, ev.clientY);
  });
  dlg.addEventListener('keydown', (ev) => {
    const t = ev.target;
    // ... or the Menu key / Shift+F10 on a node that has the focus
    if ((ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) && t.matches && t.matches('g.lg-node')) {
      ev.preventDefault();
      const r = t.getBoundingClientRect();
      return nodeMenu(t.dataset.node, r.left + 8, r.bottom + 4);
    }
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (!(t.matches && t.matches('g.lg-node, tr[data-row], .lg-lname[data-lane]'))) return;
    ev.preventDefault();
    // Enter on the paper that is already selected opens it
    if (ev.key === 'Enter' && t.matches('g.lg-node') && !/^(prior|anc):/.test(t.dataset.node) && st && st.sel && st.sel.id === t.dataset.node) return openPaper(t.dataset.node);
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  dlg.addEventListener('mouseover', (ev) => {
    const g = ev.target.closest && ev.target.closest('g.lg-node');
    if (g) highlightEdges(g.dataset.node);
  });
  dlg.addEventListener('mouseout', (ev) => {
    const g = ev.target.closest && ev.target.closest('g.lg-node');
    if (g && !(ev.relatedTarget && g.contains(ev.relatedTarget)) && st) highlightEdges(hmode === 'ancestry' && ancSel != null ? 'anc:' + ancSel : st.sel && st.sel.kind === 'paper' ? st.sel.id : st.sel && st.sel.kind === 'prior' ? priorNodeId(st.sel.i) : null);
  });
  dlg.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'lg-showprior') { showPrior = t.checked; ls.set('rt.lineage.prior', showPrior ? '1' : '0'); return keep(renderHistory); }
    if (st && t.dataset.incl) { if (t.checked) st.excluded.delete(t.dataset.incl); else st.excluded.add(t.dataset.incl); return renderOrigin(); }
    if (!st || !st.data) return;
    if (t.dataset.check) { const [w, i] = t.dataset.check.split(':'); const e = rowsOf(w)[Number(i)]; if (e) { if (t.checked) st.checked[w].add(e.key); else st.checked[w].delete(e.key); } return render(); }
    if (t.dataset.checkall) { const w = t.dataset.checkall; for (const { e } of tableRows(w)) { if (t.checked) st.checked[w].add(e.key); else st.checked[w].delete(e.key); } return render(); }
    if (t.dataset.f && TABLES.includes(tab)) {
      const f = filters[tab], k = t.dataset.f;
      f[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value ? String(Math.round(Number(t.value))) : '') : t.value;
      saveFilters();
      return render();
    }
  });
  dlg.addEventListener('input', (ev) => { if (ev.target.id === 'lg-tq' && st) { st.tfilter = ev.target.value; const pos = ev.target.selectionStart; render(); const q = $('#lg-tq'); q.focus(); q.setSelectionRange(pos, pos); } });
  // the lane-name column of the history line: drag its right edge (remembered: rt.lineage.labelW)
  dlg.addEventListener('pointerdown', (ev) => {
    const h = ev.target.closest && ev.target.closest('.lg-lresize');
    if (!h) return;
    ev.preventDefault();
    const x0 = ev.clientX, w0 = laneW;
    const lanes = h.parentElement, axisName = $('#lg-view .lg-axisname');
    const move = (e) => { laneW = Math.max(150, Math.min(420, Math.round(w0 + e.clientX - x0))); lanes.style.width = laneW + 'px'; if (axisName) axisName.style.width = laneW + 'px'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ls.set('rt.lineage.labelW', String(laneW)); renderHistory(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  // Cmd/Ctrl + wheel zooms the history line
  dlg.addEventListener('wheel', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !ev.target.closest('.lg-tl')) return;
    ev.preventDefault();
    zoom = Math.max(0.3, Math.min(8, zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    renderHistory();
  }, { passive: false });
  let resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (dlg.open && st && st.data && tab === 'history') renderHistory(); }, 150); });
  // a paper added, moved to another line or deleted: the marks and lanes follow (no service is asked)
  RT.on('library:refreshed', () => { if (dlg.open && st && st.data && !st.running) request('cached'); });
  RT.on('lineage:open', (o) => open(o || {}));
  // a paper put into or taken out of a project elsewhere (Library, Write tab): the bookmarks follow (A5)
  // before a lookup, a project's set follows its membership (the origin list is the library's papers of the project)
  const reproj = () => {
    if (!dlg.open || !st) return;
    if (!st.data && !st.running && st.scope && st.scope.scope === 'project') { st.originIds = localIds(st.scope); st.count = st.originIds.length; }
    // the counts in the scope select follow too ("P (4)" -> "P (3)"); not while the custom-set popover is open
    const cur = $('#lg-scope').value;
    if (cur !== 'custom' && !dlg.querySelector('.lg-pop')) fillScopes(cur);
    if (st.data || !st.running) render();
  };
  RT.on('memberships:changed', reproj);
  RT.on('i18n:changed', () => { if (dlg.open && st && (st.data || !st.running)) render(); });
  RT.on('projects:changed', reproj);

  // ------------------------------------------------------------------ the Library toolbar button
  function inject() {
    if ($('#btn-lineage')) return;
    // the Library toolbar's Explore group (RT.library.toolbarSlot): after Ask across papers; else after #btn-regroup
    const slot = RT.library && RT.library.toolbarSlot ? RT.library.toolbarSlot('explore') : null;
    const after = (slot && ($('#btn-compare', slot) || slot.firstElementChild)) || $('#btn-regroup') || $('#library-list .list-opts .spacer');
    if (!after) return;
    const where = slot && after.parentElement === slot ? (after.id === 'btn-compare' ? 'afterend' : 'beforebegin') : after.id === 'btn-regroup' ? 'afterend' : 'beforebegin';
    after.insertAdjacentHTML(where, `<button id="btn-lineage" class="ib" title="Lineage: prior works, derivative works and the history line of your papers (like Connected Papers)" aria-label="Lineage of your papers">${RT.icon(I.lineage)}</button>`);
    $('#btn-lineage').addEventListener('click', () => {
      // with a selection of several papers: their lineage; else the whole library
      open({ scope: 'library' });
    });
  }
  inject();
  RT.on('library:refreshed', inject);

  // ------------------------------------------------------------------ the category / line header menu (⋯)
  // categories.js keeps RT.categories.headerExtras if it already exists, so the load order does not matter
  RT.categories = RT.categories || {};
  RT.categories.headerExtras = RT.categories.headerExtras || [];
  RT.categories.headerExtras.push((name, { line, ids } = {}) => (ids && ids.length ? [{
    label: line ? 'Lineage of this line…' : 'Lineage of this category…',
    run: () => open({ scope: 'category', category: name }),
  }] : []));

  // "Check lineage" (Library row menu, reader header, ⌘K): one paper -> its lineage; several -> exactly those papers
  function check(ids) {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) return;
    if (list.length === 1) return open({ scope: 'paper', id: list[0] });
    open({ scope: 'ids', ids: list, label: 'Selected papers' });
  }
  Object.assign(RT.lineage, { open, reopen, check, ICON: I.lineage, ...pure });
})();
