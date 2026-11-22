// Lineage of a SET of library papers: their prior works, their derivative works and the history line between them -
// the ideas of Connected Papers, computed for the whole library, one category / research line, a project's papers or
// one paper with its neighbourhood.
//   Prior works       the works most cited by the set's papers (count = how many set papers reference it), the set
//                     itself left out: usually the seminal works the line builds on.
//   Derivative works  the works that cite many papers of the set (count = how many set papers they reference): surveys
//                     and later works of the same line. >= 2 set papers (>= 1 for a single paper).
//   History line      the set's papers on a time axis (first public date) with "A cites B" between library papers.
// (Connected Papers itself draws its graph by co-citation and bibliographic coupling - two papers are close when many
// papers cite both, or when they cite many of the same papers; the two lists above are exactly the "most co-cited
// outside the graph" and the "most coupled to the graph" views of that, which need only reference lists.)
//
// Data, all through the rate-limited helpers of lib/related.js, identifiers only:
//   - per library paper its OpenAlex work, a free single look-up (works/https://doi.org/<DOI or arXiv DOI>), with the
//     referenced_works; where OpenAlex has no reference list (common for arXiv preprints) Semantic Scholar's
//     references (paper/ARXIV:<id>/references), whose DOIs / arXiv ids are mapped to OpenAlex ids where needed.
//     Kept in <workspace>/cache/lineage/works.json for 14 days (a paper whose references could not be had: 1 hour).
//   - LIST queries of OpenAlex (filter=openalex:W|W, filter=doi:..|.., filter=cites:W|W) come out of a daily
//     allowance shared by the network (~1000): at most LIST_BUDGET per computation, every answer cached; the result
//     of a set is kept for 7 days in cache/lineage/sets/<sha1>.json (1 hour when it is partial).
// The counting, ranking and matching functions are pure (tests: node scripts/test-lineage.js).
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const rel = require('./related');
const refs = require('./refs');
const { normDoi, normTitle } = require('./bibtex');

const DIR = path.join(core.DIRS.cache, 'lineage');
const WORKS_FILE = path.join(DIR, 'works.json');
const SETS_DIR = path.join(DIR, 'sets');
const VERSION = 1, SET_VERSION = 1;
const DAY = 24 * 3600 * 1000;
const PAPER_FRESH = 14 * DAY, PAPER_RETRY = 3600 * 1000, META_FRESH = 14 * DAY;
const SET_FRESH = 7 * DAY, SET_PARTIAL = 3600 * 1000;
const TOP = 40;                 // rows of the prior / derivative tables
const POOL = 120;               // prior / derivative works kept per set: the relevance ranking (present) picks the TOP
const GENERIC_CITED = 30000;    // a work cited more often than this is a field-wide hub ("generic")
const GENERIC_SHARE = 0.6;      // ... and so is a backbone / optimizer / framework / benchmark cited by >= 60 % of a set
const LIST_BUDGET = 10;         // OpenAlex list requests per computation (prior <= 5, derivative the rest)
const PRIOR_BUDGET = 5;
const SIMILAR_BUDGET = 1;       // ... of which one for the metadata of the similar works
const BATCH = 50;               // ids per filter=...|... request
const MAX_S2_REFS = 500;
const S2_SHORT = 40;            // an OpenAlex reference list shorter than this is completed from Semantic Scholar
const HEAVY = 3000;             // a set paper cited more often than this gets a cites: query of its own, one page
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const W_RE = /^W\d{1,12}$/;

const str = rel.str;
const fail = (status, msg, extra) => core.httpErr(status, msg, extra);
const num = (n) => Number(n).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);
const wOf = (s) => { const m = String(s || '').match(/W\d{1,12}$/); return m ? m[0] : ''; };
// a title without what some records append to it: Crossref's "<sup>0</sup>" marks and OpenAlex's
// " : Open X-Embodiment Collaboration 0" (the collaboration named after a spaced colon)
const cleanTitle = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+:\s+[^:]*\b(collaboration|consortium|team)\b[^:]*$/i, '').replace(/\s+/g, ' ').trim();
const titleKey = (t) => { const n = normTitle(cleanTitle(t)); return n.length >= 12 ? n : ''; };
const arxivDoi = (id) => '10.48550/arxiv.' + String(id).toLowerCase();

// ===================================================================== pure part

// the reference keys of one library paper: OpenAlex ids, else "doi:<doi>" (an arXiv id as its arXiv DOI), else
// "t:<normalized title>". `dois` maps a DOI to the OpenAlex id it is known to stand for.
function refKeys(rec, dois = {}) {
  const out = new Set();
  if (!rec) return [];
  for (const w of rec.refs || []) if (W_RE.test(w)) out.add(w);
  for (const r of rec.s2 || []) {
    for (const k of s2Keys(r)) {
      const d = k.startsWith('doi:') ? dois[k.slice(4)] : null;
      out.add(d && d.w ? d.w : k);
    }
  }
  return [...out];
}
// a Semantic Scholar reference [doi, arxiv, title, year] -> its key
function s2Key(r) {
  if (!Array.isArray(r)) return '';
  const [doi, arxiv, title] = r;
  if (doi) return 'doi:' + doi.toLowerCase();
  if (arxiv) return 'doi:' + arxivDoi(arxiv);
  const t = titleKey(title);
  return t ? 't:' + t : '';
}
// ... and all the keys it stands for: a reference with a DOI and an arXiv id (the published paper and its preprint,
// often two OpenAlex works) under both, so the papers citing either copy meet in one entry
function s2Keys(r) {
  const k = s2Key(r);
  if (!k) return [];
  return Array.isArray(r) && r[0] && r[1] ? [k, 'doi:' + arxivDoi(r[1])] : [k];
}
// Rows of a table that are one work under two records (a preprint and its published copy: the same cleaned title,
// arXiv id, DOI or OpenAlex id) become one row - the first (the stronger) keeps its place and takes what the other
// knows; `list` ('citers' | 'cites') is the union, and the count its size. Titles are shown cleaned.
function mergeDupRows(rows, list = null) {
  const out = [], byG = new Map();
  for (const e0 of rows || []) {
    const e = { ...e0, title: cleanTitle(e0.title) || e0.title };
    const t = titleKey(e.title);
    const gs = [t && 't:' + t, e.arxiv && 'a:' + String(e.arxiv).toLowerCase(), e.doi && 'd:' + String(e.doi).toLowerCase(), e.w && 'w:' + e.w].filter(Boolean);
    const hit = gs.map((g) => byG.get(g)).find(Boolean);
    if (!hit) { out.push(e); gs.forEach((g) => byG.set(g, e)); continue; }
    if (list) { hit[list] = [...new Set([...(hit[list] || []), ...(e[list] || [])])]; hit.count = hit[list].length; }
    else hit.count = Math.max(hit.count || 0, e.count || 0);
    hit.alt = [...new Set([...(hit.alt || []), e.key, e.w].filter((k) => k && k !== hit.key && k !== hit.w))];
    for (const f of ['doi', 'arxiv', 'field', 'type', 'vtype', 'date']) if (!hit[f] && e[f]) hit[f] = e[f];
    if ((!hit.venue || /^arxiv/i.test(hit.venue)) && e.venue && !/^arxiv/i.test(e.venue)) hit.venue = e.venue;
    if (!(hit.authors || []).length && (e.authors || []).length) { hit.authors = e.authors; hit.more = e.more; hit.last = hit.last || e.last; }
    hit.cited = Math.max(Number(hit.cited) || 0, Number(e.cited) || 0);
    hit.oa = !!(hit.oa || e.oa);
    for (const f of ['coupling', 'nrefs', 'libCites', 'shared', 'cocited']) if (e[f] != null && !(hit[f] >= e[f])) hit[f] = e[f];
    gs.forEach((g) => { if (!byG.has(g)) byG.set(g, hit); });
  }
  return out;
}

// The identity of every library paper: which OpenAlex ids, DOIs, arXiv ids and titles stand for it.
// papers: [{id, w?, aliases?, doi?, arxiv?, title?}] -> match(e) with e = {w?, doi?, arxiv?, title?} -> library id | null
function matcher(papers) {
  const byW = new Map(), byDoi = new Map(), byTitle = new Map();
  for (const p of papers) {
    for (const w of [p.w, ...(p.aliases || [])]) if (w && !byW.has(w)) byW.set(w, p.id);
    for (const d of [p.doi, p.arxiv && arxivDoi(p.arxiv)]) if (d && !byDoi.has(d.toLowerCase())) byDoi.set(d.toLowerCase(), p.id);
    const t = titleKey(p.title);
    if (t && !byTitle.has(t)) byTitle.set(t, p.id);
  }
  const match = (e) => {
    if (!e) return null;
    if (e.w && byW.has(e.w)) return byW.get(e.w);
    for (const d of [e.doi, e.arxiv && arxivDoi(e.arxiv)]) if (d && byDoi.has(d.toLowerCase())) return byDoi.get(d.toLowerCase());
    const t = titleKey(e.title);
    return (t && byTitle.get(t)) || null;
  };
  match.key = (k) => (W_RE.test(k) ? byW.get(k) || null : k.startsWith('doi:') ? byDoi.get(k.slice(4)) || null : k.startsWith('t:') ? byTitle.get(k.slice(2)) || null : null);
  match.alias = (w, id) => { if (w && !byW.has(w)) byW.set(w, id); };
  return match;
}

// Prior works: how many set papers reference each key. set: [{id, keys}]; isSelf(key) -> true for the set's own papers.
// -> Map key -> Set of citing set-paper ids (each set paper counts once)
function countPrior(set, isSelf = () => false) {
  const counts = new Map();
  for (const p of set) {
    for (const k of new Set(p.keys || [])) {
      if (isSelf(k, p.id)) continue;
      if (!counts.has(k)) counts.set(k, new Set());
      counts.get(k).add(p.id);
    }
  }
  return counts;
}
// keys with the same work behind them (a DOI that is a known OpenAlex id, a preprint and its published copy with the
// same title) become one entry; its citers are the union. groups: [[key, key, ...]] -> new Map
function mergeCounts(counts, groups) {
  const out = new Map(counts);
  for (const g of groups) {
    const keys = g.filter((k) => out.has(k));
    if (keys.length < 2) continue;
    const [first, ...rest] = keys;
    const all = new Set(out.get(first));
    for (const k of rest) { for (const id of out.get(k)) all.add(id); out.delete(k); }
    out.set(first, all);
  }
  return out;
}
// the order of both tables: most set papers first, then (derivative works) the most references shared with the set
// (bibliographic coupling), then most cited, then the older one, then the key (stable)
function rank(rows) {
  return rows.slice().sort((a, b) => b.count - a.count || (b.coupling || 0) - (a.coupling || 0) || (b.cited ?? -1) - (a.cited ?? -1) || (a.year || 9999) - (b.year || 9999) || String(a.key).localeCompare(String(b.key)));
}
// Derivative works: works citing set papers, counted by how many DISTINCT set papers they reference.
// citing: [{w, refs: [W], ...}], setW: Map W -> set-paper id, isSelf(work) -> true for the set's own papers
// coupleWith: works the set's papers reference; a citer's `coupling` = how many of them it references too
function countDerivative(citing, setW, { min = 2, isSelf = () => false, coupleWith = null } = {}) {
  const seen = new Set(), out = [];
  for (const c of citing) {
    if (!c || !c.w || seen.has(c.w)) continue;
    seen.add(c.w);
    if (isSelf(c)) continue;
    const cites = new Set();
    for (const r of c.refs || []) if (setW.has(r)) cites.add(setW.get(r));
    if (cites.size < min) continue;
    let coupling = 0;
    if (coupleWith) for (const r of new Set(c.refs || [])) if (coupleWith.has(r) && !setW.has(r)) coupling++;
    out.push({ ...c, key: c.w, count: cites.size, coupling, cites: [...cites] });
  }
  return rank(out);
}
// the first public date of a library paper: the earliest of its arXiv month, the OpenAlex publication date and the
// BibTeX year / month (the OpenAlex date wins inside the arXiv month: it has the day). -> {date 'YYYY-MM-DD', approx}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function firstDate({ arxiv, oaDates = [], year, month } = {}) {
  const c = [];
  const m = String(arxiv || '').match(/^(\d{2})(\d{2})\.\d{4,5}/);
  const ax = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `20${m[1]}-${m[2]}` : '';
  // an OpenAlex date of 1 January is mostly a year-only placeholder: approximate, and the arXiv month of the same year
  // (a preprint's month is its first public date) wins over it
  for (const d of oaDates) if (/^\d{4}-\d{2}-\d{2}$/.test(d || '')) c.push({ date: d, approx: /-01-01$/.test(d), jan1: /-01-01$/.test(d) });
  if (ax) {
    const inMonth = c.find((x) => x.date.startsWith(ax) && !x.approx);
    if (!inMonth) c.push({ date: ax + '-01', approx: true });
  }
  // the BibTeX date: with a month it competes; a bare year only stands in when nothing better is known (mid-year)
  const y = Number(year);
  if (Number.isInteger(y) && y > 1500 && y < 2200) {
    const mm = MONTHS[String(month || '').slice(0, 3).toLowerCase()] || (Number(month) >= 1 && Number(month) <= 12 ? Number(month) : 0);
    if (mm) c.push({ date: `${y}-${String(mm).padStart(2, '0')}-01`, approx: true });
    else if (!c.length) c.push({ date: `${y}-07-01`, approx: true });
  }
  // a placeholder gives way to anything more precise in its year
  const best = c.filter((x) => !(x.jan1 && c.some((y) => y !== x && !y.jan1 && y.date.slice(0, 4) === x.date.slice(0, 4))));
  if (!best.length) return { date: '', approx: true };
  best.sort((a, b) => a.date.localeCompare(b.date) || Number(a.approx) - Number(b.approx));
  return { date: best[0].date, approx: best[0].approx };
}
// the OpenAlex abstract (an inverted index word -> positions) as text
function abstractOf(inv, max = 3000) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) if (Array.isArray(pos)) for (const p of pos) if (Number.isInteger(p) && p >= 0 && p < 5000) words[p] = w;
  return str(words.filter((w) => w !== undefined).join(' '), max);
}
// one OpenAlex work -> the compact record kept and shown
function workOf(w) {
  if (!w || typeof w !== 'object') return null;
  const id = wOf(w.id);
  if (!id) return null;
  const auth = Array.isArray(w.authorships) ? w.authorships : [];
  const nameOf = (a) => str((a && a.author && a.author.display_name) || (a && a.raw_author_name), 80);
  const names = auth.map(nameOf).filter(Boolean);
  // the last author: the one OpenAlex marks 'last'; else the end of the list, unless OpenAlex cut the list short
  const lastA = auth.filter((a) => a && a.author_position === 'last').map(nameOf)[0] || (w.is_authors_truncated ? '' : names[names.length - 1] || '');
  const locs = [w.primary_location, ...(Array.isArray(w.locations) ? w.locations : [])].filter((l) => l && typeof l === 'object');
  let arxiv = '';
  for (const l of locs) for (const u of [l.landing_page_url, l.pdf_url]) {
    if (arxiv || typeof u !== 'string') continue;
    const m = u.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?$/i);
    if (m) { const r = refs.parseRef(m[1]); if (r && r.kind === 'arxiv') arxiv = r.id; }
  }
  let doi = normDoi(str(w.doi, 300));
  const am = doi.match(ARXIV_DOI);
  if (am) { arxiv = arxiv || am[1]; doi = ''; }
  if (doi && !/^10\.\d{4,9}\/\S+$/.test(doi)) doi = '';
  const src = w.primary_location && w.primary_location.source;
  const y = Number(w.publication_year);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(w.publication_date || '') ? w.publication_date : '';
  return {
    w: id, title: str(w.title || w.display_name, 400), authors: names.slice(0, 6), more: Math.max(0, names.length - 6),
    last: lastA, year: Number.isInteger(y) && y > 1500 && y < 2200 ? y : date ? Number(date.slice(0, 4)) : null, date,
    venue: rel.venueName(src && src.display_name), doi, arxiv,
    type: str(w.type, 40),
    field: str(w.primary_topic && w.primary_topic.field && w.primary_topic.field.display_name, 80),
    vtype: str(src && src.type, 30),
    oa: !!(w.open_access && (w.open_access.oa_url || w.open_access.is_oa)) || !!arxiv,
    cited: Number.isFinite(Number(w.cited_by_count)) ? Math.max(0, Math.round(Number(w.cited_by_count))) : null,
    // citations in this calendar year and the one before (OpenAlex counts_by_year; null when it was not asked)
    c2: Array.isArray(w.counts_by_year) ? recentCites(w.counts_by_year) : null,
  };
}
function recentCites(cby, year = new Date().getUTCFullYear()) {
  let n = 0;
  for (const c of cby) if (c && Number(c.year) >= year - 1) n += Math.max(0, Number(c.cited_by_count) || 0);
  return n;
}
// not a paper: a journal or a front matter that OpenAlex resolved a reference to ("COMPUTER GRAPHICS forum")
function bogus(m) {
  if (!m) return true;
  if (m.type === 'paratext' || m.type === 'journal') return true;
  const t = String(m.title || '').trim().toLowerCase();
  if (!(m.authors || []).length && t && (t === String(m.venue || '').trim().toLowerCase() || /^(proceedings|journal|transactions|annals|bulletin)\b/.test(t))) return true;
  return false;
}
const refsOf = (w) => (Array.isArray(w && w.referenced_works) ? w.referenced_works.map(wOf).filter(Boolean) : []);
// the reference an "Add" hands to the import (as the Related tab does)
const refOf = (e) => (e.arxiv ? 'arXiv:' + e.arxiv : e.doi ? 'doi:' + e.doi : '');
// a stable key of a set: what kind of set and which papers
const setKey = (kind, label, ids) => core.sha1(Buffer.from(JSON.stringify([SET_VERSION, kind, label, [...ids].sort()]))).slice(0, 24);

// ---- relevance: a ranking that damps the field's hub papers and can be read in words (computed in present(), so a
// stored set needs no new request). Prior works: each citing set paper counts 1 / ln(e + cited / 1000) - a work cited
// 60,000 times counts a quarter, one cited 300 times almost fully - and the papers of the WHOLE library that cite it
// too add ln(1 + n) (with the same damping): the works your own line keeps building on rise, AlphaFold in a robotics
// library sinks. Derivative works: the set papers they cite, then how much of the reference list they share with the
// set (Salton: shared / sqrt(|their refs| x |the set's refs|)).
const hubDamp = (cited) => 1 / Math.log(Math.E + Math.max(0, Number(cited) || 0) / 1000);
// the keys a prior work can be cited under (its OpenAlex id, DOI, arXiv DOI, title)
function workKeys(e) {
  const out = [e.key, e.w, ...(e.alt || []), e.doi && 'doi:' + String(e.doi).toLowerCase(), e.arxiv && 'doi:' + arxivDoi(e.arxiv)];
  const t = titleKey(e.title);
  if (t) out.push('t:' + t);
  return [...new Set(out.filter(Boolean))];
}
// how many papers of the library cite a work. citers: Map key -> Set of library ids (countPrior over the library)
function libraryCount(e, citers) {
  const ids = new Set();
  for (const k of workKeys(e)) for (const id of citers.get(k) || []) ids.add(id);
  for (const id of e.citers || []) ids.add(id);
  return ids.size;
}
// a backbone / optimizer / framework / benchmark-dataset title or venue (only together with a share of the set)
const GENERIC_RE = /\b(adam|optimi[sz](?:er|ation)|stochastic gradient|batch normali[sz]ation|layer normali[sz]ation|dropout|residual learning|resnet|attention is all you need|transformers?|bert|vision transformer|an image is worth|imagenet|coco|pytorch|tensorflow|jax|mujoco|isaac (?:gym|sim|lab)|physics engine|gym|toolkit|framework|large-scale hierarchical image database|u-net|vgg|gans?|generative adversarial|variational auto-?encoder|auto-encoding variational)\b/i;
function isGeneric(e, setSize) {
  if ((Number(e.cited) || 0) > GENERIC_CITED) return true;
  return setSize >= 5 && e.count / setSize >= GENERIC_SHARE && GENERIC_RE.test(`${e.title || ''} ${e.venue || ''}`);
}
const salton = (shared, a, b) => (shared > 0 && a > 0 && b > 0 ? shared / Math.sqrt(a * b) : 0);
const fmt = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toString();
// one prior work -> {relevance, libCount, generic, why}. ctx: {setSize, citers (Map, the whole library), fields
// (Set of the set's main fields, may be empty)}
function priorRelevance(e, { setSize = 1, citers = new Map(), fields = null } = {}) {
  const libCount = Math.max(e.count, libraryCount(e, citers));
  const extra = Math.max(0, libCount - e.count);
  const damp = hubDamp(e.cited);
  const off = !!(fields && fields.size && e.field && !fields.has(e.field));
  // the rest of the library breaks ties within a line; for a set of several papers it never weighs more than half of
  // the set's own count (a narrow line is not pulled towards the library's dominant line)
  const libRaw = 0.8 * Math.log(1 + extra);
  const libTerm = setSize > 1 ? Math.min(libRaw, 0.5 * e.count) : libRaw;
  const relevance = damp * (e.count + libTerm) * (off ? 0.6 : 1);
  const generic = isGeneric(e, setSize);
  const parts = [];
  parts.push(setSize === 1 ? 'Cited by this paper' : `Cited by ${e.count} of these ${setSize} papers`);
  if (extra) parts.push(`and by ${extra} more ${extra === 1 ? 'paper' : 'papers'} of your library (${libCount} in all${libTerm < libRaw ? '; the library counts at most half as much as these papers' : ''})`);
  else parts.push(setSize === 1 ? 'and by no other paper of your library' : 'and by no other paper of your library');
  let why = parts.join(' ') + '.';
  if (e.cited != null) why += damp < 0.5 ? ` Cited ${num(e.cited)} times overall: a widely cited work, so it counts ${Math.round(damp * 100)} % (hub papers are damped).` : ` Cited ${num(e.cited)} times overall (counts ${Math.round(damp * 100)} %).`;
  if (off) why += ` Its field (${e.field}) is outside the main fields of these papers: counts 60 %.`;
  if (generic) why += (Number(e.cited) || 0) > GENERIC_CITED ? ` Generic: cited over ${num(GENERIC_CITED)} times - a field-wide hub, hidden unless “Hide generic” is off.` : ` Generic: a backbone / tool / benchmark that ${Math.round(e.count / setSize * 100)} % of these papers cite.`;
  why += ` Relevance ${fmt(relevance)}.`;
  return { relevance, libCount, generic, why };
}
// one derivative work -> {relevance, generic: false, why}. setRefs: how many works the set's papers reference
// a survey / review / tutorial (OpenAlex type, the title, or a reference list of over 150 works) - it cites many
// papers of any set, so as a derivative work its count weighs half
const SURVEY_RE = /\b(survey|review|tutorial|overview)\b/i;
const isSurveyRow = (e) => !!e && (e.type === 'review' || SURVEY_RE.test(String(e.title || '')) || (Number(e.nrefs) || 0) > 150);
function derivRelevance(e, { setSize = 1, setRefs = 0 } = {}) {
  const s = e.nrefs ? salton(e.coupling || 0, e.nrefs, setRefs) : 0;
  const survey = isSurveyRow(e);
  const relevance = (survey ? 0.5 : 1) * e.count + Math.min(0.9, s * 30) + 0.05 * Math.log10(1 + (Number(e.cited) || 0)) + (s ? 0 : Math.min(0.5, 0.05 * (e.coupling || 0)));
  let why = setSize === 1 ? 'Cites this paper.' : `Cites ${e.count} of these ${setSize} papers.`;
  if (survey) why += ' A survey or review (it cites many papers of any line): its count weighs half.';
  if (e.coupling) why += ` Shares ${e.coupling} ${e.coupling === 1 ? 'reference' : 'references'} with ${setSize === 1 ? 'it and your library' : 'them'}${s ? ` (coupling ${fmt(s, 3)})` : ''}.`;
  if (e.libCites && e.libCites > e.count) why += ` It cites ${e.libCites} papers of your library in all.`;
  if (e.cited != null) why += ` Cited ${num(e.cited)} times.`;
  why += ` Relevance ${fmt(relevance)}.`;
  return { relevance, generic: false, why };
}
// a table in relevance order (ties: the count, then the older work, then the key)
const byRelevance = (rows) => rows.slice().sort((a, b) => b.relevance - a.relevance || b.count - a.count || (a.year || 9999) - (b.year || 9999) || String(a.key).localeCompare(String(b.key)));
// the main fields of a set: the fields of its prior works weighted by their counts, the top 3 (none when unknown)
function mainFields(rows, n = 3) {
  const w = new Map();
  for (const e of rows) if (e.field) w.set(e.field, (w.get(e.field) || 0) + e.count);
  const known = [...w.values()].reduce((a, b) => a + b, 0);
  if (known < 5) return new Set();
  return new Set([...w].sort((a, b) => b[1] - a[1]).slice(0, n).map(([f]) => f));
}
// one similar work (B9) -> {relevance, generic: false, why}. Co-citation: how many of the works citing these papers
// cite it too, as a share (Salton, with its overall citations standing in for its citers: hub papers sink);
// bibliographic coupling: the references it shares with these papers. ctx: {setSize, nCiting, setRefs}
function similarRelevance(e, { setSize = 1, nCiting = 0, setRefs = 0 } = {}) {
  const co = e.cocited && nCiting ? e.cocited / Math.sqrt(Math.max(1, Number(e.cited) || 1) * nCiting) : 0;
  const cp = e.shared && e.nrefs ? salton(e.shared, e.nrefs, setRefs) : 0;
  const relevance = Math.min(3, 5 * co) + Math.min(3, 5 * cp) + 0.1 * Math.log(1 + (e.cocited || 0)) + 0.1 * Math.log(1 + (e.shared || 0));
  const bits = [];
  if (e.cocited) bits.push(`Co-cited with ${setSize === 1 ? 'this paper' : 'these papers'}: ${e.cocited} of the ${num(nCiting)} works that cite ${setSize === 1 ? 'it' : 'them'} cite it too${Number(e.cited) > 0 ? ` (it is cited ${num(e.cited)} times in all)` : ''}.`);
  if (e.shared) bits.push(`Shares ${e.shared} ${e.shared === 1 ? 'reference' : 'references'} with ${setSize === 1 ? 'this paper' : 'these papers'}${cp ? ` (coupling ${fmt(cp, 3)})` : ''}.`);
  const n = (e.cites || []).length;
  if (n) bits.push(`It cites ${setSize === 1 ? 'this paper' : `${n} of these papers`}, but ranks below the cutoff of the derivative works (the top ${TOP}): a derivative work further down. Relevance ${fmt(relevance)}.`);
  else bits.push(`${setSize === 1 ? 'It does not cite this paper' : 'It cites none of these papers and is not among their prior works'}: likely related or concurrent work. Relevance ${fmt(relevance)}.`);
  return { relevance, generic: false, why: bits.join(' ') };
}
// the rows a stored set shows: every row ranked; the non-generic TOP plus the generic ones (to be shown on demand)
function rankRows(rows, which, ctx) {
  const score = which === 'prior' ? priorRelevance : which === 'similar' ? similarRelevance : derivRelevance;
  const scored = rows.map((e) => ({ ...e, ...score(e, ctx) }));
  const ranked = byRelevance(scored);
  const keep = ranked.filter((e) => !e.generic).slice(0, TOP);
  const gen = ranked.filter((e) => e.generic).slice(0, 25);
  return byRelevance([...keep, ...gen]);
}

// Similar works (B9), from the works citing the set (fetched for the derivative works anyway - no request):
//   co-cited  works the citers also cite, neither the set's papers nor works the set cites (those are prior works)
//   coupled   citers not listed as derivative works that share >= minShared references with the set
// citing: [{w, refs}], setW: Map W -> set id, ownRefs: Set of W the set cites, listed: Set of keys already shown
// -> {cocited: Map W -> {n, via: Set of set ids}, coupled: [{...c, shared, cites}], nCiting}
function similarCandidates(citing, { setW, ownRefs = new Set(), listed = new Set(), isSelf = () => false, minShared = 3 } = {}) {
  const seen = new Set(), cocited = new Map(), coupled = [];
  for (const c of citing) {
    if (!c || !c.w || seen.has(c.w)) continue;
    seen.add(c.w);
    const refs = new Set(c.refs || []);
    const cites = new Set();
    for (const r of refs) if (setW.has(r)) cites.add(setW.get(r));
    if (!cites.size) continue;
    for (const r of refs) {
      if (setW.has(r) || ownRefs.has(r) || listed.has(r)) continue;
      if (!cocited.has(r)) cocited.set(r, { n: 0, via: new Set() });
      const x = cocited.get(r); x.n++; for (const id of cites) x.via.add(id);
    }
    if (listed.has(c.w) || isSelf(c)) continue;
    let shared = 0;
    for (const r of refs) if (ownRefs.has(r) && !setW.has(r)) shared++;
    if (shared >= minShared) coupled.push({ ...c, shared, cites: [...cites] });
  }
  return { cocited, coupled, nCiting: seen.size };
}
// The stored set closest to a scope that has no result of its own (B3: the library one paper bigger): the same kind
// and label (any label for a hand-picked set), at least minOverlap of the ids shared (of the larger set), the newest.
// entries: [[key, {kind, label, ids, computed}]] -> {key, overlap, added [ids], removed [ids], ...} | null
function closestSet(entries, { kind, label, ids }, minOverlap = 0.9) {
  const want = new Set(ids);
  let best = null;
  for (const [key, e] of entries) {
    if (!e || e.kind !== kind || (kind !== 'ids' && e.label !== label) || !Array.isArray(e.ids)) continue;
    const have = new Set(e.ids);
    let inter = 0;
    for (const id of want) if (have.has(id)) inter++;
    const overlap = inter / Math.max(want.size, have.size, 1);
    if (overlap < minOverlap) continue;
    if (!best || String(e.computed) > String(best.computed) || (e.computed === best.computed && overlap > best.overlap)) {
      best = { key, ...e, overlap, added: [...want].filter((id) => !have.has(id)), removed: [...have].filter((id) => !want.has(id)) };
    }
  }
  return best;
}
// the label a set's key is made with: the paper's id for one paper, nothing for the whole library
const keyLabel = (scope) => (scope.kind === 'paper' ? scope.focus : scope.kind === 'library' ? '' : scope.label);
// an ISO date n months back
const monthsAgo = (n, now = new Date()) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

// ===================================================================== the cache of works
let store = null, saveTimer = null;
function load() {
  if (store) return store;
  const s = core.readJSON(WORKS_FILE, null);
  store = s && s.v === VERSION && s.papers && s.works ? s : { v: VERSION, papers: {}, works: {}, dois: {}, usage: {} };
  store.dois = store.dois || {}; store.usage = store.usage || {};
  return store;
}
function save(now = false) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const go = () => { try { fs.mkdirSync(DIR, { recursive: true }); core.writeJSON(WORKS_FILE, store); } catch (e) { console.error('lineage cache:', e.message); } };
  if (now) go(); else saveTimer = setTimeout(go, 1500);
}
// what was asked today, for the Lineage window and the logs
function count(kind, job) {
  const s = load(), d = today();
  // keep two weeks of counts
  for (const k of Object.keys(s.usage)) if (k < new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10)) delete s.usage[k];
  const u = s.usage[d] || (s.usage[d] = { list: 0, single: 0, s2: 0 });
  u[kind] = (u[kind] || 0) + 1;
  if (job) job.usage[kind] = (job.usage[kind] || 0) + 1;
}
const fresh = (t, ms) => t && Date.now() - Date.parse(t) < ms;

// an OpenAlex LIST query, counted against the budget of the computation
// A spent daily allowance (429 with a Retry-After of hours) is remembered: until it has passed no list query is sent.
function busyErr(until) {
  const h = Math.max(1, Math.round((until - Date.now()) / 3600000));
  return fail(503, `OpenAlex has no requests left for today from this network (its free daily allowance is used up). Try again in about ${h} hour${h === 1 ? '' : 's'}.`, { busy: true, retryAfter: Math.round((until - Date.now()) / 1000) });
}
const busyUntil = () => { const t = Number(load().busyUntil) || 0; return t > Date.now() ? t : 0; };
async function oaList(job, query) {
  if (job.usage.list >= job.budget) throw fail(429, 'budget', { budget: true });
  const b = busyUntil();
  if (b) throw busyErr(b);
  count('list', job);
  try { return await rel.oa(query); }
  catch (e) {
    if (e.extra && e.extra.busy && e.extra.retryAfter >= 600) { load().busyUntil = Date.now() + e.extra.retryAfter * 1000; save(); }
    throw e;
  }
}
// (primary_topic and open_access come with the same answers: no extra request)
// (counts_by_year too: the Rising badge)
const LIB_SELECT = 'id,doi,title,display_name,publication_date,publication_year,referenced_works,cited_by_count,authorships,is_authors_truncated,type,primary_location,locations,primary_topic,open_access,counts_by_year';
const META_SELECT = 'id,doi,title,display_name,publication_date,publication_year,cited_by_count,authorships,is_authors_truncated,type,primary_location,locations,primary_topic,open_access,counts_by_year';
const DERIV_SELECT = META_SELECT + ',referenced_works';

// ---- Semantic Scholar references: [doi, arxiv, title, year] per reference, and what the citing paper says of each:
// [key, title key, influential 0/1, intents, up to 2 citing sentences of <= 300 characters]
const S2_REF_FIELDS = 'externalIds,title,year,isInfluential,intents,contexts';
const INTENTS = new Set(['methodology', 'background', 'result']);
function parseS2Refs(j) {
  const s2 = [], cx = [];
  for (const d of (j && Array.isArray(j.data) ? j.data : [])) {
    const p = d && d.citedPaper;
    if (!p || typeof p !== 'object') continue;
    const x = p.externalIds && typeof p.externalIds === 'object' ? p.externalIds : {};
    let doi = normDoi(str(x.DOI, 300)), ax = '';
    const r = refs.parseRef(str(x.ArXiv, 60));
    if (r && r.kind === 'arxiv') ax = r.id;
    const am = doi.match(ARXIV_DOI);
    if (am) { ax = ax || am[1]; doi = ''; }
    if (doi && !/^10\.\d{4,9}\/\S+$/.test(doi)) doi = '';
    const t = str(p.title, 300);
    if (!(doi || ax || titleKey(t))) continue;
    const ref = [doi, ax, t, Number(p.year) || null];
    s2.push(ref);
    const intents = (Array.isArray(d.intents) ? d.intents : []).map((v) => String(v).toLowerCase()).filter((v) => INTENTS.has(v));
    const ctx = (Array.isArray(d.contexts) ? d.contexts : []).map((c) => str(String(c || '').replace(/\s+/g, ' ').trim(), 300)).filter((c) => c.length > 20).slice(0, 2);
    const inf = d.isInfluential ? 1 : 0;
    if (inf || intents.length || ctx.length) cx.push([s2Key(ref), titleKey(t) ? 't:' + titleKey(t) : '', inf, intents, ctx]);
  }
  return { s2, cx };
}
// the citation contexts, kept apart from works.json (they are larger): <cache>/lineage/contexts.json
// {v, papers {identKey: {t (fetched), refs [[key, tkey, inf, intents, ctx]]}}}
const CX_FILE = path.join(DIR, 'contexts.json');
let cxStore = null, cxTimer = null;
function loadCx() {
  if (cxStore) return cxStore;
  const c = core.readJSON(CX_FILE, null);
  cxStore = c && c.v === 1 && c.papers ? c : { v: 1, papers: {} };
  return cxStore;
}
function putContexts(identKey, list) {
  loadCx().papers[identKey] = { t: new Date().toISOString(), refs: list };
  if (cxTimer) clearTimeout(cxTimer);
  cxTimer = setTimeout(() => { cxTimer = null; try { fs.mkdirSync(DIR, { recursive: true }); core.writeJSON(CX_FILE, cxStore); } catch (e) { console.error('lineage contexts:', e.message); } }, 1500);
}
// what one citing paper says of a work: its context record (refs) and the work's keys -> {influential, intents, ctx} | null
function contextOf(refsList, keys) {
  const want = new Set(keys);
  for (const r of refsList || []) if (want.has(r[0]) || (r[1] && want.has(r[1]))) return { influential: !!r[2], intents: r[3] || [], ctx: r[4] || [] };
  return null;
}
// the intents of a prior work over its citers (only those whose contexts are known) -> {methods, influential, known, weighted}
// weighted = the sum over the citers of 1 + influential + 0.5 x methodology (citers without contexts count 1)
// known = the citers whose record gives intents at all (Semantic Scholar often gives none: then nothing is known of
// methods - not "0 use its method"); influence counts wherever a record is known
function intentSummary(e, cxOfPaper) {
  const keys = workKeys(e);
  let methods = 0, influential = 0, known = 0, weighted = 0;
  for (const id of e.citers || []) {
    const rec = cxOfPaper(id);
    const c = rec ? contextOf(rec.refs, keys) : null;
    if (rec && (rec.refs || []).some((r) => Array.isArray(r[3]) && r[3].length)) known++;
    if (c && c.intents.includes('methodology')) methods++;
    if (c && c.influential) influential++;
    weighted += 1 + (c && c.influential ? 1 : 0) + (c && c.intents.includes('methodology') ? 0.5 : 0);
  }
  return { methods, influential, known, weighted };
}

// ---- one library paper -> its record { w, aliases, fetched, date, title, cited, refs, s2, refSource, problem? }
async function resolvePaper(item, job, { force = false } = {}) {
  const id = rel.identOf(item);
  if (!id) return null;
  const s = load();
  const old = s.papers[id.key];
  // (a record from before Semantic Scholar was also asked for arXiv papers with an OpenAlex list is looked up again)
  const s2Due = old && !old.s2Tried && !old.problem && old.refs && old.refs.length && (id.arxiv || old.refs.length < S2_SHORT);
  if (old && !force && !s2Due && fresh(old.fetched, old.problem ? PAPER_RETRY : old.s2Problem ? DAY : PAPER_FRESH)) return old;
  const rec = { w: '', aliases: [], fetched: new Date().toISOString(), dates: [], title: '', cited: null, refs: [], s2: [], refSource: '' };
  // OpenAlex: the published DOI and, when the entry also has an arXiv id, the preprint (often a work of its own)
  const asks = [id.doi, id.arxiv && refs.arxivDoi(id.arxiv)].filter(Boolean);
  let oaErr = null;
  for (const doi of asks) {
    let w = null;
    try { count('single', job); w = await rel.oa('works/https://doi.org/' + rel.doiPath(doi) + '?select=' + LIB_SELECT); }
    catch (e) { if (e.extra && e.extra.offline) throw e; oaErr = e; continue; }
    const m = workOf(w);
    if (!m) continue;
    if (!rec.w) { rec.w = m.w; rec.title = m.title; rec.cited = m.cited; } else if (m.w !== rec.w) rec.aliases.push(m.w);
    if (m.date) rec.dates.push(m.date);
    const r = refsOf(w);
    if (r.length > rec.refs.length) { rec.refs = r; rec.refSource = 'OpenAlex'; }
    // the record of the work itself, so it is not fetched again as a prior / derivative work
    s.works[m.w] = { ...m, fetched: rec.fetched };
  }
  // Semantic Scholar when OpenAlex has no reference list - and also for arXiv papers and short lists, because
  // OpenAlex often keeps only part of a recent preprint's references; the two lists are joined (refKeys)
  if (!rec.refs.length || id.arxiv || rec.refs.length < S2_SHORT) {
    rec.s2Tried = true;
    const sid = id.arxiv ? 'ARXIV:' + encodeURIComponent(id.arxiv) : 'DOI:' + rel.doiPath(id.doi);
    try {
      count('s2', job);
      // the intents, the influence flag and the citing sentences come with the same answer (no extra request)
      const j = await rel.s2(`paper/${sid}/references?fields=${S2_REF_FIELDS}&limit=${MAX_S2_REFS}`);
      const got = parseS2Refs(j);
      rec.s2 = got.s2;
      if (j) putContexts(id.key, got.cx);
      if (rec.s2.length) rec.refSource = rec.refs.length ? 'OpenAlex + Semantic Scholar' : 'Semantic Scholar';
      else if (!j && !rec.refs.length) rec.problem = 'Semantic Scholar does not know this paper.';
    } catch (e) {
      if (e.extra && e.extra.offline && !rec.w) throw e;
      // with an OpenAlex list the paper is still usable: Semantic Scholar is asked again in a day
      if (rec.refs.length) rec.s2Problem = e.message; else rec.problem = e.message;
    }
  }
  if (!rec.w && !rec.s2.length && oaErr) rec.problem = oaErr.message;
  if (!rec.w && !rec.s2.length && !rec.problem) rec.problem = 'Neither OpenAlex nor Semantic Scholar knows this paper yet.';
  // a failed look-up never replaces a good record
  if (old && !old.problem && rec.problem && !rec.w && !rec.s2.length) { old.retried = rec.fetched; return old; }
  s.papers[id.key] = rec;
  save();
  return rec;
}

// a cached work record that need not be fetched again: young enough, and from after the field (primary_topic) joined
// the select (a work OpenAlex did not return is kept as `missing`)
const metaFresh = (m) => !!m && fresh(m.fetched, META_FRESH) && (m.missing || 'field' in m);
// ---- metadata of works by their OpenAlex ids (batched; cached). Returns the ids it could not get.
async function fetchMeta(job, ids, max) {
  const s = load();
  const want = [...new Set(ids)].filter((w) => W_RE.test(w) && !metaFresh(s.works[w])).slice(0, max * BATCH);
  for (let i = 0; i < want.length; i += BATCH) {
    const part = want.slice(i, i + BATCH);
    const j = await oaList(job, `works?filter=openalex:${part.join('|')}&per-page=${BATCH}&select=${META_SELECT}`);
    const now = new Date().toISOString();
    for (const w of (j && Array.isArray(j.results) ? j.results : [])) { const m = workOf(w); if (m) s.works[m.w] = { ...m, fetched: now }; }
    for (const w of part) if (!s.works[w]) s.works[w] = { w, title: '', fetched: now, missing: true };
  }
  save();
}
// DOIs -> OpenAlex ids (batched; cached, also "no work")
async function resolveDois(job, dois, max) {
  const s = load();
  const want = [...new Set(dois)].filter((d) => d && !/[|,]/.test(d) && !(s.dois[d] && fresh(s.dois[d].t, META_FRESH))).slice(0, max * BATCH);
  for (let i = 0; i < want.length; i += BATCH) {
    const part = want.slice(i, i + BATCH);
    const j = await oaList(job, `works?filter=doi:${part.map((d) => encodeURIComponent(d)).join('|')}&per-page=${BATCH}&select=${META_SELECT}`);
    const now = new Date().toISOString();
    for (const w of (j && Array.isArray(j.results) ? j.results : [])) {
      const m = workOf(w);
      if (!m) continue;
      s.works[m.w] = { ...m, fetched: now };
      const d = normDoi(str(w.doi, 300)).toLowerCase();
      if (d) s.dois[d] = { w: m.w, t: now };
    }
    for (const d of part) if (!s.dois[d]) s.dois[d] = { w: '', t: now };
  }
  save();
}

// ===================================================================== a computation
const jobs = new Map(); // key -> job

// what the set is: {kind, label, ids (the origin papers), focus? (one paper)}
function resolveScope(body, items) {
  const kind = String(body.scope || 'library');
  const live = (ids) => { const have = new Set(items.map((i) => i.id)); return [...new Set(ids)].filter((id) => have.has(id)); };
  if (kind === 'library') return { kind, label: 'The whole library', ids: items.map((i) => i.id) };
  if (kind === 'category') {
    const name = str(body.category, 200);
    if (!name) throw fail(400, 'category is missing');
    const ids = items.filter((i) => { const c = i.category || 'Uncategorized'; return c === name || c.startsWith(name + ' / '); }).map((i) => i.id);
    if (!ids.length) throw fail(404, `No paper is in “${name}”.`);
    return { kind, label: name, ids, category: name };
  }
  if (kind === 'project') {
    const project = core.P.get(String(body.pid || ''));
    const ids = live(core.P.papers(project).map((p) => p.id));
    if (!ids.length) throw fail(404, `The project “${project.name}” has no papers yet.`);
    return { kind, label: project.name, ids, pid: project.id };
  }
  if (kind === 'paper') {
    const it = items.find((i) => i.id === body.id);
    if (!it) throw fail(404, 'No such item');
    return { kind, label: (it.fields && it.fields.title) || it.citekey, ids: [it.id], focus: it.id };
  }
  if (kind === 'ids') {
    if (!Array.isArray(body.ids) || body.ids.length > 1000) throw fail(400, 'ids must be a list of at most 1000 paper ids');
    const ids = live(body.ids.map(String));
    if (!ids.length) throw fail(400, 'None of these papers is in the library.');
    return { kind, label: str(body.label, 120) || `${ids.length} papers`, ids };
  }
  throw fail(400, 'scope must be library, category, project, paper or ids');
}

const setFile = (key) => path.join(SETS_DIR, key + '.json');
function readSet(key) { const c = core.readJSON(setFile(key), null); return c && c.v === SET_VERSION && c.key === key ? c : null; }

// the library side of every result: identity and dates of each paper (cached records only)
function libraryPapers(items) {
  const s = load();
  return items.map((it) => {
    const f = it.fields || {}, id = rel.identOf(it), rec = id ? s.papers[id.key] : null;
    const fd = firstDate({ arxiv: id && id.arxiv, oaDates: rec ? rec.dates : [], year: f.year, month: f.month });
    return {
      id: it.id, w: rec ? rec.w : '', aliases: rec ? rec.aliases : [], doi: id ? id.doi : '', arxiv: id ? id.arxiv : '',
      title: str(f.title, 400) || it.citekey, rec, date: fd.date, approx: fd.approx, item: it,
    };
  });
}

// cached works whose DOI / arXiv id / title is a library paper's (a published copy of a preprint) are that paper
function learnAliases(match, s) {
  for (const [w, m] of Object.entries(s.works)) if (m && m.title && !match({ w })) { const id = match({ doi: m.doi, arxiv: m.arxiv, title: m.title }); if (id) match.alias(w, id); }
}

// "A cites B" between library papers: the reference keys of A that are library papers (also by the titles Semantic
// Scholar gave). Built from the cached records with the matcher as it is now, so aliases learned later count too.
function citesOf(p, match, dois) {
  const out = new Set();
  for (const k of refKeys(p.rec, dois)) { const id = match.key(k); if (id && id !== p.id) out.add(id); }
  for (const r of (p.rec && p.rec.s2) || []) { const id = match({ title: r[2] }); if (id && id !== p.id) out.add(id); }
  return out;
}
function edgesOf(nodes, byId, match, dois) {
  const edges = [];
  for (const id of nodes) {
    const p = byId.get(id);
    if (!p) continue;
    for (const to of citesOf(p, match, dois)) if (nodes.has(to)) edges.push([id, to]);
  }
  return edges;
}

async function compute(job) {
  const items = core.loadLib().items;
  const scope = job.scope;
  const inSet = new Set(scope.ids);
  const setItems = items.filter((i) => inSet.has(i.id));
  const notes = [];
  // 1. the set's papers (and, for one paper, its neighbours' cached records are enough)
  job.phase = 'papers'; job.total = setItems.length; job.done = 0;
  let s2Busy = 0, unknown = 0, noId = 0;
  for (const it of setItems) {
    job.current = str(it.fields && it.fields.title, 120);
    const rec = await resolvePaper(it, job);
    if (!rec) noId++;
    else if (!rec.w && !rec.s2.length) unknown++;
    else if (!rec.refs.length && !rec.s2.length && rec.problem && /Semantic Scholar/.test(rec.problem)) s2Busy++;
    job.done++;
  }
  job.current = '';
  save(true);
  const s = load();
  const lib = libraryPapers(items);
  const match = matcher(lib);
  const byId = new Map(lib.map((p) => [p.id, p]));
  const set = lib.filter((p) => inSet.has(p.id));
  if (noId) notes.push(`${noId} of these papers ${noId === 1 ? 'has' : 'have'} no DOI or arXiv id and could not be looked up.`);
  if (unknown) notes.push(`${unknown} ${unknown === 1 ? 'paper is' : 'papers are'} not known to OpenAlex or Semantic Scholar yet (very new preprints take a few weeks).`);
  if (s2Busy) notes.push(`For ${s2Busy} ${s2Busy === 1 ? 'paper' : 'papers'} OpenAlex has no reference list and Semantic Scholar was busy: Refresh asks again in an hour.`);
  // works whose metadata matches a library paper (a published copy of a preprint): known as that paper from now on
  learnAliases(match, s);

  // 2. prior works
  job.phase = 'prior';
  const isSelf = (k) => { const id = match.key(k); return !!id && inSet.has(id); };
  const keysOf = (p) => refKeys(p.rec, s.dois);
  let counts = countPrior(set.map((p) => ({ id: p.id, keys: keysOf(p) })), isSelf);
  const single = set.length === 1;
  let priorErr = null;
  try {
    // DOIs of Semantic Scholar references that several set papers share (or, for one paper, all of them) -> OpenAlex ids
    const minShared = single ? 1 : 2;
    const doiKeys = [...counts].filter(([k, c]) => k.startsWith('doi:') && c.size >= minShared).sort((a, b) => b[1].size - a[1].size).map(([k]) => k.slice(4));
    if (doiKeys.length) await resolveDois(job, doiKeys, 2);
    counts = countPrior(set.map((p) => ({ id: p.id, keys: keysOf(p) })), isSelf);
    // the metadata of the strongest candidates
    const pool = [...counts].sort((a, b) => b[1].size - a[1].size || String(a[0]).localeCompare(String(b[0]))).slice(0, single ? 150 : POOL).map(([k]) => k);
    await fetchMeta(job, pool.filter((k) => W_RE.test(k)), PRIOR_BUDGET - job.usage.list > 0 ? PRIOR_BUDGET - job.usage.list : 0);
  } catch (e) { if (!(e.extra && e.extra.budget)) priorErr = e; }
  // the metadata just fetched may show more published copies of library papers
  learnAliases(match, s);
  // the same work under two keys (a DOI and its OpenAlex id, the preprint and the published paper): one entry
  const groups = new Map();
  const s2Info = new Map(); // key -> [doi, arxiv, title, year] of a reference only Semantic Scholar named
  for (const p of set) for (const r of (p.rec && p.rec.s2) || []) for (const k of s2Keys(r)) if (!s2Info.has(k)) s2Info.set(k, r);
  const metaOfKey = (k) => {
    if (W_RE.test(k)) { const m = s.works[k]; return m && m.title ? m : null; }
    const r = s2Info.get(k);
    return r ? { title: r[2], year: r[3], doi: r[0], arxiv: r[1], authors: [], last: '', cited: null, venue: '' } : null;
  };
  // (by the cleaned title or by the arXiv id: the ICRA copy of a preprint carries the same arXiv id)
  const gOf = new Map();
  for (const k of counts.keys()) {
    const m = metaOfKey(k);
    if (!m) continue;
    const t = titleKey(m.title);
    const gk = [t && 't:' + t, m.arxiv && 'a:' + String(m.arxiv).toLowerCase()].filter(Boolean);
    if (!gk.length) continue;
    let g = gk.map((x) => gOf.get(x)).find(Boolean);
    if (!g) { g = []; groups.set(gk[0], g); }
    g.push(k);
    for (const x of gk) if (!gOf.has(x)) gOf.set(x, g);
  }
  // within a group the OpenAlex work with the most citations names the entry
  const ordered = [...groups.values()].map((g) => g.sort((a, b) => Number(W_RE.test(b)) - Number(W_RE.test(a)) || ((metaOfKey(b) || {}).cited ?? -1) - ((metaOfKey(a) || {}).cited ?? -1)));
  counts = mergeCounts(counts, ordered);
  const prior = rank([...counts].map(([k, citers]) => {
    const m = metaOfKey(k);
    if (!m || !m.title || bogus(m)) return null;
    const self = match({ w: W_RE.test(k) ? k : '', doi: m.doi, arxiv: m.arxiv, title: m.title });
    if (self && inSet.has(self)) return null;
    return { key: k, w: W_RE.test(k) ? k : '', title: cleanTitle(m.title) || m.title, authors: m.authors || [], more: m.more || 0, last: m.last || '', year: m.year || null, date: m.date || '', venue: m.venue || '', doi: m.doi || '', arxiv: m.arxiv || '', cited: m.cited ?? null, field: m.field || '', type: m.type || '', vtype: m.vtype || '', oa: !!m.oa, c2: m.c2 ?? null, count: citers.size, citers: [...citers] };
  }).filter(Boolean)).slice(0, POOL);
  if (priorErr) notes.push('Prior works are incomplete: ' + priorErr.message);
  const withRefs = set.filter((p) => p.rec && (p.rec.refs.length || p.rec.s2.length)).length;
  if (!withRefs && set.length) notes.push('No reference list is known for these papers, so there are no prior works to show.');

  // 3. derivative works
  job.phase = 'derivative';
  const setW = new Map();
  for (const p of set) for (const w of [p.w, ...(p.aliases || [])]) if (w) setW.set(w, p.id);
  // works that are known as a set paper by their title (the published copy) also count as that paper
  for (const [w, m] of Object.entries(s.works)) { if (setW.has(w) || !m || !m.title) continue; const id = match({ w }); if (id && inSet.has(id)) setW.set(w, id); }
  const citing = [];
  let derivErr = null;
  const ws = [...new Set(set.map((p) => p.w).filter(Boolean))];
  let capped = false, outOfBudget = false;
  if (ws.length) {
    // a heavily cited set paper (3DGS: 12k citers) gets a chunk of its own with one page, so that its citers - mostly
    // works citing only it - do not fill the pages of the other papers. One paper: its most cited citers and its
    // newest ones (a list sorted by citations alone is the field's famous works, many off-topic).
    const citedOf = (w) => { const m = s.works[w]; return (m && m.cited) || 0; };
    const heavy = ws.filter((w) => !single && citedOf(w) > HEAVY), light = ws.filter((w) => !heavy.includes(w));
    const chunks = [];
    for (let i = 0; i < light.length; i += BATCH) chunks.push({ ids: light.slice(i, i + BATCH), page: 1, more: true, max: 5, sort: 'cited_by_count:desc' });
    if (single) chunks.push({ ids: light, page: 1, more: true, max: 3, sort: 'publication_date:desc' });
    // the research front (B7): the most cited works of the last 18 months that cite the set, one page per chunk of
    // 50 (at most 2) - sorted by citations alone the list is mostly older works. Asked in the first round, so they
    // come out of the last cited-sorted pages and the total stays within the budget.
    else {
      const since = monthsAgo(18);
      for (let i = 0, k = 0; i < light.length && k < 2; i += BATCH, k++) chunks.splice(1 + 2 * k, 0, { ids: light.slice(i, i + BATCH), page: 1, more: true, max: 1, sort: 'cited_by_count:desc', extra: ',from_publication_date:' + since, recent: true });
    }
    for (const w of heavy) chunks.push({ ids: [w], page: 1, more: true, max: 1, sort: 'cited_by_count:desc' });
    try {
      // round robin over the chunks while the budget lasts and a chunk has more pages
      // (one list query is kept for the metadata of the similar works)
      const derivBudget = job.budget - SIMILAR_BUDGET;
      for (let round = 0; chunks.some((c) => c.more && c.page <= c.max) && job.usage.list < derivBudget; round++) {
        for (const c of chunks) {
          if (!c.more || c.page > c.max || job.usage.list >= derivBudget) continue;
          const j = await oaList(job, `works?filter=cites:${c.ids.join('|')}${c.extra || ''}&sort=${c.sort}&per-page=200&page=${c.page}&select=${DERIV_SELECT}`);
          const got = j && Array.isArray(j.results) ? j.results : [];
          const now = new Date().toISOString();
          for (const w of got) {
            const m = workOf(w);
            if (!m) continue;
            s.works[m.w] = { ...m, fetched: now };
            citing.push({ ...m, refs: refsOf(w), recent: !!c.recent });
          }
          c.more = got.length === 200; c.page++;
        }
      }
      outOfBudget = chunks.some((c) => !c.recent && c.more && c.page <= c.max);
      capped = !outOfBudget && chunks.some((c) => c.more);
    } catch (e) { if (e.extra && e.extra.budget) outOfBudget = true; else derivErr = e; }
    if (outOfBudget) notes.push('Derivative works: not every citing paper could be read (the request budget of one computation is used up); the most cited ones were.');
    else if (capped) notes.push(`Derivative works: only the first ${num(new Set(citing.map((c) => c.w)).size)} citing papers (the most cited${single ? ' and the newest' : ''}) were read.`);
    save();
  }
  if (derivErr) notes.push('Derivative works are incomplete: ' + derivErr.message);
  // the citers may be published copies of library papers too
  learnAliases(match, s);
  for (const [w, m] of Object.entries(s.works)) { if (setW.has(w) || !m || !m.title) continue; const id = match({ w }); if (id && inSet.has(id)) setW.set(w, id); }
  // bibliographic coupling with the set: the works the set's papers reference (OpenAlex ids), the set left out
  // (one paper: the references of the whole library, so a citer of the paper that builds on the same line ranks up)
  const coupleWith = new Set();
  for (const p of single ? lib : set) for (const k of keysOf(p)) if (W_RE.test(k)) coupleWith.add(k);
  const libW = new Map();
  for (const p of lib) for (const w of [p.w, ...(p.aliases || [])]) if (w) libW.set(w, p.id);
  const derivative = countDerivative(citing.filter((c) => !bogus(c)), setW, { min: single ? 1 : 2, coupleWith, isSelf: (c) => { const id = match(c); return !!id && inSet.has(id); } }).slice(0, POOL)
    .map(({ refs: r, ...c }) => ({ ...c, nrefs: new Set(r || []).size, libCites: new Set((r || []).filter((w) => libW.has(w)).map((w) => libW.get(w))).size }));
  if (!ws.length && set.length) notes.push('None of these papers is known to OpenAlex, so the papers that cite them cannot be listed.');

  // 4b. similar works: co-cited with the set by its citers, or coupled to it (no request but one metadata batch)
  job.phase = 'similar';
  const ownRefs = new Set();
  for (const p of set) for (const k of keysOf(p)) if (W_RE.test(k)) ownRefs.add(k);
  const listed = new Set([...prior.flatMap((e) => [e.key, e.w]), ...derivative.map((e) => e.w)].filter(Boolean));
  const simC = similarCandidates(citing.filter((c) => !bogus(c)), { setW, ownRefs, listed, minShared: single ? 2 : 3, isSelf: (c) => { const id = match(c); return !!id && inSet.has(id); } });
  const minCo = single ? 2 : 3;
  const coTop = [...simC.cocited].filter(([, v]) => v.n >= minCo).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 150);
  try { await fetchMeta(job, coTop.map(([w]) => w), Math.max(0, Math.min(SIMILAR_BUDGET, job.budget - job.usage.list))); } catch (e) { if (!(e.extra && e.extra.budget)) notes.push('Similar works are incomplete: ' + e.message); }
  const simRows = new Map();
  for (const [w, v] of coTop) {
    const m = s.works[w];
    if (!m || !m.title || bogus(m) || (Number(m.cited) || 0) > GENERIC_CITED) continue;
    const self = match(m);
    if (self && inSet.has(self)) continue;
    simRows.set(w, { ...m, key: w, refs: undefined, cocited: v.n, via: [...v.via], shared: 0, count: v.n });
  }
  for (const c of simC.coupled) {
    if ((Number(c.cited) || 0) > GENERIC_CITED) continue;
    const { refs: r, recent: _r, ...m } = c;
    const had = simRows.get(c.w);
    simRows.set(c.w, { ...m, ...(had || {}), key: c.w, shared: c.shared, nrefs: new Set(r || []).size, cites: c.cites, cocited: had ? had.cocited : (simC.cocited.get(c.w) || { n: 0 }).n, count: had ? had.cocited : (simC.cocited.get(c.w) || { n: 0 }).n });
  }
  const similar = rankRows([...simRows.values()], 'similar', { setSize: set.length, nCiting: simC.nCiting, setRefs: ownRefs.size }).slice(0, 80)
    .map(({ relevance, why, generic, ...e }) => e);

  // 4. the history line: the set's papers (one paper: with its library neighbours) and "A cites B" between them
  const citesOfP = (p) => citesOf(p, match, s.dois);
  let nodes = new Set(inSet);
  if (single) {
    const me = set[0];
    if (me) {
      for (const id of citesOfP(me)) nodes.add(id);
      for (const p of lib) if (p.id !== me.id && citesOfP(p).has(me.id)) nodes.add(p.id);
      for (const d of derivative) { const id = match(d); if (id) nodes.add(id); }
    }
  }
  const edges = edgesOf(nodes, byId, match, s.dois);
  const papers = [...nodes].map((id) => byId.get(id)).filter(Boolean).map((p) => ({
    id: p.id, w: p.w, title: p.title, date: p.date, approx: p.approx, origin: inSet.has(p.id),
    refSource: p.rec ? p.rec.refSource : '', refs: p.rec ? Math.max(p.rec.refs.length, p.rec.s2.length) : 0, cited: p.rec ? p.rec.cited : null,
    problem: p.rec ? p.rec.problem || '' : (rel.identOf(p.item) ? '' : 'no DOI or arXiv id'),
  }));
  const partial = !!(priorErr || derivErr || s2Busy);
  // with a spent OpenAlex allowance the partial result stands until the allowance is back (not just an hour)
  const busy = [priorErr, derivErr].find((e) => e && e.extra && e.extra.busy);
  const retryUntil = busy ? new Date(Date.now() + Math.max(SET_PARTIAL, (busy.extra.retryAfter || 0) * 1000)).toISOString() : null;
  return {
    v: SET_VERSION, key: job.key, computed: new Date().toISOString(), partial, retryUntil,
    scope: { kind: scope.kind, label: scope.label, ids: scope.ids, focus: scope.focus || null, category: scope.category || null, pid: scope.pid || null },
    papers, edges, prior, derivative, similar, simStats: { citing: simC.nCiting, ownRefs: ownRefs.size }, notes, setRefs: coupleWith.size,
    stats: { set: set.length, found: set.filter((p) => p.w).length, withRefs, viaS2: set.filter((p) => p.rec && p.rec.s2 && p.rec.s2.length).length, citing: citing.length },
    usage: { ...job.usage },
  };
}

// what the page gets: the stored result, marked against the library as it is now
function present(res) {
  const items = core.loadLib().items;
  const lib = libraryPapers(items);
  const match = matcher(lib);
  const s = load();
  learnAliases(match, s);
  const byId = new Map(lib.map((p) => [p.id, p]));
  const mark = (e) => ({ ...e, inLibrary: match({ w: e.w, doi: e.doi, arxiv: e.arxiv, title: e.title }), ref: refOf(e) });
  // the papers: current titles, categories and authors (a paper deleted since is left out)
  const papers = res.papers.filter((p) => byId.has(p.id)).map((p) => {
    const lp = byId.get(p.id), it = lp.item, f = it.fields || {};
    return { ...p, date: lp.date || p.date, approx: lp.date ? lp.approx : p.approx, title: str(f.title, 400) || p.title, category: it.category || 'Uncategorized', citekey: it.citekey, author: str(f.author, 2000), year: str(f.year, 8), status: it.status || '', starred: !!it.starred };
  });
  const have = new Set(papers.map((p) => p.id));
  // the arrows again from the cached records: aliases learned since the set was computed add theirs
  const edges = edgesOf(have, byId, match, s.dois);
  // the relevance ranking: who in the whole library cites each prior work (cached records only, no request)
  const citers = countPrior(lib.map((p) => ({ id: p.id, keys: refKeys(p.rec, s.dois) })));
  const setSize = (res.stats && res.stats.set) || (res.scope && res.scope.ids ? res.scope.ids.length : 1);
  // rows of sets stored before the prior rows carried field / type / open access / recent citations: from the cached
  // work records (no request); a preprint and its published copy as one row
  const withMeta = (e) => { const m = e.w && s.works[e.w]; if (!m) return e; const o = { ...e }; for (const f of ['field', 'type', 'vtype', 'oa', 'c2']) if (o[f] == null && m[f] != null) o[f] = m[f]; return o; };
  const priorRows = mergeDupRows(res.prior.filter((e) => !bogus(e)).map(withMeta), 'citers');
  const ctx = { setSize, citers, fields: mainFields(priorRows), setRefs: res.setRefs || 0 };
  // what the citing papers say of a prior work (Semantic Scholar intents, cached contexts only - no request)
  const cx = loadCx();
  const cxOf = (id) => { const lp = byId.get(id), ident = lp && rel.identOf(lp.item); return ident ? cx.papers[ident.key] || null : null; };
  const prior = rankRows(priorRows, 'prior', ctx).map((e) => ({ ...mark(e), ...intentSummary(e, cxOf) }));
  const derivative = rankRows(mergeDupRows(res.derivative.filter((e) => !bogus(e)), 'cites'), 'derivative', ctx).map(mark);
  // similar works: none of the set, none of the rows shown in the two tables
  const shownKeys = new Set([...prior, ...derivative].flatMap((e) => [e.key, e.w]).filter(Boolean));
  const inSet = new Set(res.scope.ids || []);
  const similar = Array.isArray(res.similar)
    ? rankRows(mergeDupRows(res.similar.filter((e) => !bogus(e) && !shownKeys.has(e.key))), 'similar', { setSize, nCiting: (res.simStats || {}).citing || 0, setRefs: (res.simStats || {}).ownRefs || 0 }).map(mark).filter((e) => !(e.inLibrary && inSet.has(e.inLibrary)))
    : null;
  const recent = res.recentAnc ? { ...res.recentAnc, rows: res.recentAnc.rows.map(mark).filter((e) => !(e.inLibrary && inSet.has(e.inLibrary))) } : null;
  return { ...res, papers, edges, prior, derivative, similar, recent, today: (load().usage[today()] || { list: 0, single: 0, s2: 0 }) };
}

// ---- the index of the stored sets (B3): key -> {kind, label, ids, computed}; rebuilt from the files when missing
const INDEX_FILE = path.join(SETS_DIR, 'index.json');
const indexEntry = (res) => ({ kind: res.scope.kind, label: keyLabel({ kind: res.scope.kind, label: res.scope.label, focus: res.scope.focus }), ids: res.scope.ids, computed: res.computed, partial: !!res.partial });
function readIndex() {
  const ix = core.readJSON(INDEX_FILE, null);
  if (ix && ix.v === 1 && ix.sets) return ix;
  const out = { v: 1, sets: {} };
  let files = [];
  try { files = fs.readdirSync(SETS_DIR); } catch { return out; }
  for (const f of files) { const m = f.match(/^([0-9a-f]{24})\.json$/); const c = m && readSet(m[1]); if (c && c.scope) out.sets[c.key] = indexEntry(c); }
  try { core.writeJSON(INDEX_FILE, out); } catch { /* read-only: rebuilt next time */ }
  return out;
}
function indexPut(res) {
  const ix = readIndex();
  ix.sets[res.key] = indexEntry(res);
  try { core.writeJSON(INDEX_FILE, ix); } catch (e) { console.error('lineage index:', e.message); }
}
// what a computation of the scope would ask (B3), from the cached records only: papers looked up already, papers to
// look up, about how many list queries
function estimate(scope, items) {
  const s = load(), inSet = new Set(scope.ids);
  const lib = libraryPapers(items), set = lib.filter((p) => inSet.has(p.id));
  let known = 0, lookups = 0, noId = 0;
  for (const p of set) {
    const id = rel.identOf(p.item);
    if (!id) { noId++; continue; }
    const rec = s.papers[id.key];
    if (rec && fresh(rec.fetched, rec.problem ? PAPER_RETRY : PAPER_FRESH)) known++; else lookups++;
  }
  const single = set.length === 1;
  const counts = countPrior(set.map((p) => ({ id: p.id, keys: refKeys(p.rec, s.dois) })));
  const pool = [...counts].sort((a, b) => b[1].size - a[1].size).slice(0, single ? 150 : POOL).map(([k]) => k);
  const metaMiss = pool.filter((k) => W_RE.test(k) && !metaFresh(s.works[k])).length;
  const doiMiss = [...counts].filter(([k, c]) => k.startsWith('doi:') && c.size >= (single ? 1 : 2) && !(s.dois[k.slice(4)] && fresh(s.dois[k.slice(4)].t, META_FRESH))).length;
  const prior = Math.min(PRIOR_BUDGET, Math.min(2, Math.ceil(doiMiss / BATCH)) + Math.ceil(metaMiss / BATCH));
  // about one page of 200 citing works per 200 citations of a chunk's papers (at most 5), the newest pages, one
  // page per heavily cited paper
  const ws = set.map((p) => p.w).filter(Boolean);
  const citedOf = (w) => (s.works[w] && s.works[w].cited) || 0;
  let deriv = 0;
  if (ws.length) {
    const heavy = ws.filter((w) => !single && citedOf(w) > HEAVY), light = ws.filter((w) => !heavy.includes(w));
    for (let i = 0; i < light.length; i += BATCH) deriv += Math.max(1, Math.min(5, Math.ceil(light.slice(i, i + BATCH).reduce((a, w) => a + citedOf(w), 0) / 200)));
    deriv += heavy.length + (single ? 3 : Math.min(2, Math.ceil(light.length / BATCH)));
  }
  const list = Math.min(LIST_BUDGET, prior + Math.min(deriv, LIST_BUDGET - SIMILAR_BUDGET - Math.min(prior, PRIOR_BUDGET)) + (ws.length ? SIMILAR_BUDGET : 0));
  return { papers: scope.ids.length, known, lookups, noId, list, budget: LIST_BUDGET, today: (s.usage[today()] || {}).list || 0 };
}

// POST /api/lineage: mode 'cached' (never asks a service) | 'auto' (a stored result when it is fresh, else compute) |
// 'refresh' (compute again). -> {key, state 'done' | 'running' | 'none' | 'error', progress?, result?, error?}
function start(body) {
  const items = core.loadLib().items;
  const scope = resolveScope(body || {}, items);
  const kl = keyLabel(scope);
  const key = setKey(scope.kind, kl, scope.ids);
  const mode = ['cached', 'auto', 'refresh'].includes(body.mode) ? body.mode : 'auto';
  const running = jobs.get(key);
  if (running && running.state === 'running') return status(key);
  const stored = readSet(key);
  const waiting = stored && stored.retryUntil && Date.parse(stored.retryUntil) > Date.now();
  // a set stored before the relevance ranking (no Similar list, derivative rows without their reference counts) is
  // ranked by citations alone: shown, but stale - Update computes it again ('auto' does so at once)
  const outdated = !!stored && (!Array.isArray(stored.similar) || (stored.derivative || []).some((e) => e.nrefs == null));
  const ok = stored && !outdated && (waiting || fresh(stored.computed, stored.partial ? SET_PARTIAL : SET_FRESH));
  if (mode === 'cached' || (mode === 'auto' && ok)) {
    if (stored) return { key, state: 'done', stale: !ok, outdated, estimate: ok ? null : estimate(scope, items), result: present(stored) };
    // no result of its own: the newest stored set of the same kind that shares >= 90 % of the papers, marked stale
    const near = closestSet(Object.entries(readIndex().sets), { kind: scope.kind, label: kl, ids: scope.ids });
    const old = near && readSet(near.key);
    const est = estimate(scope, items);
    if (old) return { key, state: 'done', stale: true, staleInfo: { key: near.key, computedFor: old.scope.ids.length, added: near.added.length, removed: near.removed.length, computed: old.computed }, estimate: est, result: present(old) };
    return { key, state: 'none', scope: { kind: scope.kind, label: scope.label, count: scope.ids.length, ids: scope.ids }, estimate: est };
  }
  const job = { key, scope, state: 'running', phase: 'papers', done: 0, total: scope.ids.length, current: '', usage: { list: 0, single: 0, s2: 0 }, budget: LIST_BUDGET, refresh: mode === 'refresh', started: Date.now() };
  jobs.set(key, job);
  compute(job).then((res) => {
    try { fs.mkdirSync(SETS_DIR, { recursive: true }); core.writeJSON(setFile(key), res); indexPut(res); } catch (e) { console.error('lineage set cache:', e.message); }
    job.state = 'done'; job.result = res;
    console.log(`lineage ${scope.kind} “${scope.label}”: ${res.stats.set} papers, OpenAlex list requests ${job.usage.list}, single look-ups ${job.usage.single}, Semantic Scholar ${job.usage.s2}`);
  }).catch((e) => {
    job.state = 'error'; job.error = e.message || String(e); job.errorExtra = e.extra || null;
    console.error('lineage:', job.error);
  }).finally(() => { job.finished = Date.now(); save(true); setTimeout(() => { if (jobs.get(key) === job) jobs.delete(key); }, 10 * 60 * 1000); });
  return status(key);
}
function status(key) {
  const job = jobs.get(key);
  if (!job) { const stored = readSet(key); return stored ? { key, state: 'done', result: present(stored) } : { key, state: 'none' }; }
  const progress = { phase: job.phase, done: job.done, total: job.total, current: job.current, usage: { ...job.usage } };
  if (job.state === 'running') return { key, state: 'running', progress, scope: { kind: job.scope.kind, label: job.scope.label, count: job.scope.ids.length } };
  if (job.state === 'error') return { key, state: 'error', error: job.error, busy: !!(job.errorExtra && job.errorExtra.busy), progress };
  return { key, state: 'done', result: present(job.result) };
}

// GET /api/lineage/work/W123: one work with its abstract (a free single look-up; cached with the rest)
async function work(w) {
  if (!W_RE.test(w)) throw fail(400, 'Not an OpenAlex work id');
  const s = load();
  const m = s.works[w];
  if (m && m.abstractChecked && fresh(m.fetched, META_FRESH)) return m;
  count('single', null);
  const j = await rel.oa(`works/${w}?select=${META_SELECT},abstract_inverted_index`);
  const got = workOf(j);
  if (!got) throw fail(404, 'OpenAlex does not know this work.');
  s.works[w] = { ...got, abstract: abstractOf(j.abstract_inverted_index), abstractChecked: true, fetched: new Date().toISOString() };
  save();
  return s.works[w];
}
// POST /api/lineage/contexts {ids: [library ids of the set papers citing a work], work: {key, w, doi, arxiv, title}}
// -> {per [{id, state 'ok'|'pending'|'noid', influential, intents, ctx}], asked, note, busy}. What each citing paper
// says of the work (Semantic Scholar intents and citing sentences). Papers whose contexts are not cached yet are
// asked about lazily, one request each at the Semantic Scholar gate, at most CX_MAX per call; a busy answer stops it
// (the rest stays pending, the tables are not affected).
const CX_FRESH = 14 * DAY, CX_MAX = 6;
async function contexts(body = {}) {
  const items = core.loadLib().items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].slice(0, 60);
  const w = body.work && typeof body.work === 'object' ? body.work : {};
  const e = { key: str(w.key, 400), w: W_RE.test(String(w.w || '')) ? w.w : '', doi: normDoi(str(w.doi, 300)), arxiv: str(w.arxiv, 60), title: str(w.title, 400) };
  const keys = workKeys(e);
  // the DOIs known to stand for its OpenAlex id count too
  if (e.w) for (const [d, v] of Object.entries(load().dois)) if (v && v.w === e.w) keys.push('doi:' + d);
  const cx = loadCx();
  let asked = 0, note = '', busy = false;
  const per = [];
  for (const id of ids) {
    const it = byId.get(id), ident = it && rel.identOf(it);
    if (!ident) { per.push({ id, state: 'noid' }); continue; }
    let rec = cx.papers[ident.key];
    if (!(rec && fresh(rec.t, CX_FRESH)) && !busy && asked < CX_MAX) {
      const sid = ident.arxiv ? 'ARXIV:' + encodeURIComponent(ident.arxiv) : 'DOI:' + rel.doiPath(ident.doi);
      try {
        asked++; count('s2', null);
        const j = await rel.s2(`paper/${sid}/references?fields=${S2_REF_FIELDS}&limit=${MAX_S2_REFS}`);
        putContexts(ident.key, parseS2Refs(j).cx);
        rec = cx.papers[ident.key];
      } catch (err) {
        if (err.extra && (err.extra.busy || err.extra.offline)) busy = true;
        note = err.message || String(err);
      }
    }
    if (!rec || !fresh(rec.t, CX_FRESH * 4)) { per.push({ id, state: 'pending' }); continue; }
    per.push({ id, state: 'ok', ...(contextOf(rec.refs, keys) || { influential: false, intents: [], ctx: [] }) });
  }
  if (asked) save();
  const pending = per.filter((x) => x.state === 'pending').length;
  if (!note && pending) note = `${pending} more citing ${pending === 1 ? 'paper' : 'papers'} not asked about yet (Semantic Scholar is asked about at most ${CX_MAX} at a time).`;
  else if (busy) note = 'Semantic Scholar is busy: ' + note + ' The tables are not affected.';
  return { per, asked, note, busy };
}
// POST /api/lineage/recent {key} (B7): the newest works (last 18 months) citing the top 3 non-generic prior works of a
// stored set - for a line so new that few works cite it yet. One list query, on demand; kept with the set.
async function recentAncestors(body = {}) {
  const key = String(body.key || '');
  if (!/^[0-9a-f]{24}$/.test(key)) throw fail(400, 'key is missing');
  const res = readSet(key);
  if (!res) throw fail(404, 'Compute this set first.');
  if (!(res.recentAnc && fresh(res.recentAnc.computed, SET_FRESH))) {
    const shown = present(res);
    const anc = shown.prior.filter((e) => e.w && !e.generic).slice(0, 3);
    if (!anc.length) throw fail(404, 'No prior work with an OpenAlex id is known for these papers.');
    const job = { usage: { list: 0, single: 0, s2: 0 }, budget: 1 };
    const since = monthsAgo(18);
    const j = await oaList(job, `works?filter=cites:${anc.map((a) => a.w).join('|')},from_publication_date:${since},to_publication_date:${today()}&sort=publication_date:desc&per-page=100&select=${DERIV_SELECT}`);
    const items = core.loadLib().items, lib = libraryPapers(items), match = matcher(lib), inSet = new Set(res.scope.ids);
    const setW = new Map();
    for (const p of lib) if (inSet.has(p.id)) for (const w of [p.w, ...(p.aliases || [])]) if (w) setW.set(w, p.id);
    const now = new Date().toISOString(), s = load();
    const rows = [];
    for (const w of (j && Array.isArray(j.results) ? j.results : [])) {
      const m = workOf(w);
      if (!m || bogus(m)) continue;
      s.works[m.w] = { ...m, fetched: now };
      const self = match(m);
      if (self && inSet.has(self)) continue;
      const r = new Set(refsOf(w));
      const ancs = anc.filter((a) => r.has(a.w)).map((a) => a.w);
      const cites = [...new Set([...r].filter((x) => setW.has(x)).map((x) => setW.get(x)))];
      rows.push({ ...m, key: m.w, ancs, cites, count: ancs.length, nrefs: r.size });
    }
    save();
    rows.sort((a, b) => b.ancs.length - a.ancs.length || b.cites.length - a.cites.length || String(b.date).localeCompare(String(a.date)));
    res.recentAnc = { computed: now, since, anc: anc.map((a) => ({ w: a.w, title: a.title })), rows: rows.slice(0, 40), usage: job.usage };
    try { core.writeJSON(setFile(key), res); } catch (e) { console.error('lineage set cache:', e.message); }
  }
  return { recent: present(res).recent };
}
const usage = () => ({ today: load().usage[today()] || { list: 0, single: 0, s2: 0 }, days: load().usage, budget: LIST_BUDGET });

module.exports = {
  start, status, work, usage, contexts, recentAncestors,
  // pure, for the tests
  refKeys, s2Key, s2Keys, mergeDupRows, cleanTitle, matcher, bogus, citesOf, edgesOf, countPrior, mergeCounts, countDerivative, rank, firstDate, abstractOf, workOf, refOf, setKey, resolveScope,
  hubDamp, workKeys, libraryCount, isGeneric, salton, priorRelevance, derivRelevance, byRelevance, mainFields, rankRows,
  parseS2Refs, contextOf, intentSummary, similarCandidates, similarRelevance, closestSet, keyLabel, monthsAgo, recentCites,
  TOP, POOL, LIST_BUDGET, PRIOR_BUDGET, SIMILAR_BUDGET, GENERIC_CITED,
};
