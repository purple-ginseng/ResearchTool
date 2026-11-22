// References and "cited by" of a paper, and its published version, from the free scholarly indexes.
// Only the paper's DOI or arXiv id is ever sent out (to api.openalex.org, api.semanticscholar.org, export.arxiv.org
// and doi.org) - never a title, a note or anything else of the library. OpenAlex is asked first (generous limits);
// Semantic Scholar fills in when OpenAlex does not know the paper or has no reference list for it (it reads the
// reference lists of arXiv PDFs, but without a key it often answers "too many requests").
// The shared helpers getJson / oa / s2 are also used by lib/venues.js, which sends a paper's TITLE too (its own note).
// Answers are kept in <workspace>/cache/related/<sha1 of the id>.json; everything in them is untrusted text.
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const refs = require('./refs');

const UA = { 'User-Agent': 'ResearchTool-local/0.1', Accept: 'application/json' };
const DIR = path.join(core.DIRS.cache, 'related');
const VERSION = 1;
// a cached answer older than this is looked up again when the tab is opened (an answer with a gap - a service could
// not be asked - after an hour)
const FRESH_MS = 30 * 24 * 3600 * 1000, PARTIAL_MS = 3600 * 1000;
const fresh = (rec) => Date.now() - Date.parse(rec.fetched) < (rec.notes && rec.notes.length ? PARTIAL_MS : FRESH_MS);
const MAX_REFS = 400, MAX_CITING = 200;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

const fail = (status, msg, extra) => core.httpErr(status, msg, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const { normDoi, normTitle } = require('./bibtex');
const arxivOf = (s) => { const r = refs.parseRef(s); return r && r.kind === 'arxiv' ? r.id : ''; };

// ---------- the identifier of a library item ----------
// -> { doi: its DOI when that is not an arXiv DOI, arxiv: its arXiv id, key, label } | null when it has neither
function identOf(item) {
  const f = (item && item.fields) || {};
  let doi = '', arxiv = '';
  for (const v of [f.doi, f.eprint, f.url]) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const r = refs.parseRef(v);
    if (!r) continue;
    if (r.kind === 'arxiv' && !arxiv) arxiv = r.id;
    if (r.kind === 'doi' && !doi) doi = r.id;
  }
  if (!doi && !arxiv) return null;
  const key = doi ? 'doi:' + doi.toLowerCase() : 'arxiv:' + arxiv.toLowerCase();
  return { doi, arxiv, key, label: doi ? 'DOI ' + doi : 'arXiv id ' + arxiv };
}
const cacheFile = (id) => path.join(DIR, core.sha1(Buffer.from(id.key)) + '.json');
function readCache(id) {
  const c = core.readJSON(cacheFile(id), null);
  return c && c.v === VERSION && c.key === id.key && c.references && c.citations ? c : null;
}
// an entry that got its DOI from the metadata check was looked up by its arXiv id before: that answer still holds
const readAny = (id) => readCache(id) || (id.doi && id.arxiv ? readCache({ key: 'arxiv:' + id.arxiv.toLowerCase() }) : null);

// ---------- asking a service: one request at a time per service, with a pause between them ----------
function gate(gapMs) {
  let line = Promise.resolve();
  return () => { const turn = line; line = turn.then(() => sleep(gapMs)); return turn; };
}
const turnOA = gate(150), turnS2 = gate(1100);
const netMsg = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'did not answer in time' : 'could not be reached (are you online?)');

// -> parsed JSON | null for "not known" (404); throws 502 (no answer / broken answer) or 503 (asked to wait)
async function getJson(name, turn, url, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await turn();
    let r;
    try { r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw fail(502, `${name} ${netMsg(e)}.`, { offline: true }); }
    if (r.status === 404 || r.status === 400) { if (r.body) r.body.cancel().catch(() => {}); return null; }
    if (r.status === 429 || r.status === 403) {
      if (r.body) r.body.cancel().catch(() => {});
      // Retry-After (seconds): OpenAlex answers a spent daily allowance with many hours
      const wait = Math.min(Math.max(Number(r.headers.get('retry-after')) || 0, 0), 86400);
      if (attempt < retries && wait < 30) { await sleep(2000 + attempt * 3000); continue; }
      throw fail(503, wait >= 3600
        ? `${name} has no requests left for today from this network (its free daily allowance is used up). Try again in about ${Math.round(wait / 3600)} hours.`
        : `${name} is taking no more requests from this network for the moment (its free allowance is shared). Try again in a few minutes.`, { busy: true, retryAfter: wait });
    }
    if (!r.ok) { if (r.body) r.body.cancel().catch(() => {}); throw fail(502, `${name} answered with an error (${r.status}).`); }
    try { return await r.json(); } catch { throw fail(502, `${name} sent an answer that could not be read.`); }
  }
}
const oa = (pathAndQuery) => getJson('OpenAlex', turnOA, 'https://api.openalex.org/' + pathAndQuery);
const s2 = (pathAndQuery) => getJson('Semantic Scholar', turnS2, 'https://api.semanticscholar.org/graph/v1/' + pathAndQuery, { retries: 2 });
const doiPath = (doi) => String(doi).split('/').map(encodeURIComponent).join('/');

// OpenAlex names some proceedings twice ("... Pattern Recognition/Proceedings - ... Pattern Recognition"): the first is enough
function venueName(venue) {
  const v = str(venue, 300).split(/\s*\/\s*Proceedings\b/i)[0].slice(0, 160).trim();
  return /^arxiv\b/i.test(v) ? 'arXiv' : v;
}
// ---------- one paper of a list: { title, authors[], more (authors left out), year, venue, doi, arxiv, cited } ----------
function entry({ title, authors, year, venue, doi, arxiv, cited }) {
  const names = (Array.isArray(authors) ? authors : []).map((a) => str(a, 80)).filter(Boolean);
  let d = normDoi(str(doi, 300)), ax = arxiv ? arxivOf(str(arxiv, 60)) : '';
  const m = d.match(ARXIV_DOI);
  if (m) { ax = ax || arxivOf(m[1]); d = ''; } // an arXiv DOI is kept as the arXiv id it stands for
  if (d && !/^10\.\d{4,9}\/\S+$/.test(d)) d = '';
  const y = Number(year);
  const v = venueName(venue);
  return {
    title: str(title, 400), authors: names.slice(0, 6), more: Math.max(0, names.length - 6),
    year: Number.isInteger(y) && y > 1500 && y < 2200 ? y : null, venue: v, doi: d, arxiv: ax,
    cited: Number.isFinite(Number(cited)) && Number(cited) >= 0 ? Math.round(Number(cited)) : null,
  };
}
const OA_SELECT = 'id,doi,title,publication_year,type,authorships,primary_location,locations,cited_by_count';
function oaEntry(w) {
  if (!w || typeof w !== 'object') return null;
  const locs = [w.primary_location, ...(Array.isArray(w.locations) ? w.locations : [])].filter((l) => l && typeof l === 'object');
  let arxiv = '';
  for (const l of locs) for (const u of [l.landing_page_url, l.pdf_url]) if (!arxiv && typeof u === 'string' && /arxiv\.org\/(abs|pdf)\//i.test(u)) arxiv = arxivOf(u.replace(/^http:/, 'https:'));
  const src = w.primary_location && w.primary_location.source;
  const e = entry({
    title: w.title || w.display_name, year: w.publication_year, doi: w.doi, arxiv, cited: w.cited_by_count,
    authors: (Array.isArray(w.authorships) ? w.authorships : []).map((a) => (a && a.author && a.author.display_name) || (a && a.raw_author_name)),
    venue: src && src.display_name,
  });
  return e.title ? e : null;
}
function s2Entry(p) {
  if (!p || typeof p !== 'object') return null;
  const x = p.externalIds && typeof p.externalIds === 'object' ? p.externalIds : {};
  const e = entry({
    title: p.title, year: p.year, doi: x.DOI, arxiv: x.ArXiv, cited: p.citationCount, venue: p.venue,
    authors: (Array.isArray(p.authors) ? p.authors : []).map((a) => a && a.name),
  });
  return e.title ? e : null;
}
// the same paper twice in a list (preprint and published copy are often separate records): keep the first
function tidy(list, self) {
  const seen = new Set(), out = [];
  const selfKeys = self ? [self.doi && 'd' + self.doi.toLowerCase(), self.arxiv && 'a' + self.arxiv.toLowerCase(), self.title && normTitle(self.title).length >= 12 && 't' + normTitle(self.title)].filter(Boolean) : [];
  for (const e of list) {
    if (!e) continue;
    const keys = [e.doi && 'd' + e.doi, e.arxiv && 'a' + e.arxiv.toLowerCase(), normTitle(e.title).length >= 12 && 't' + normTitle(e.title)].filter(Boolean);
    if (!keys.length) keys.push('x' + e.title + e.year);
    if (keys.some((k) => seen.has(k) || selfKeys.includes(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(e);
  }
  return out;
}

// ---------- OpenAlex ----------
async function openAlex(id) {
  const w = await oa('works/https://doi.org/' + doiPath(id.doi || refs.arxivDoi(id.arxiv)) + '?select=' + OA_SELECT + ',referenced_works_count');
  if (!w || typeof w.id !== 'string') return null;
  const wid = (w.id.match(/W\d+$/) || [''])[0];
  if (!wid) return null;
  const me = oaEntry(w) || entry({});
  const src = w.primary_location && w.primary_location.source;
  const work = { ...me, type: str(w.type, 40), refCount: Number(w.referenced_works_count) || 0, hosted: str(src && src.type, 40) };
  const out = { work, references: null, citations: null };
  if (work.refCount > 0) {
    const list = [];
    for (let page = 1; list.length < MAX_REFS; page++) {
      const j = await oa(`works?filter=cited_by:${wid}&per-page=200&page=${page}&select=${OA_SELECT}`);
      const got = j && Array.isArray(j.results) ? j.results : [];
      list.push(...got.map(oaEntry));
      if (got.length < 200) break;
    }
    out.references = { source: 'OpenAlex', total: work.refCount, list };
  }
  const total = work.cited || 0;
  if (total > 0) {
    const j = await oa(`works?filter=cites:${wid}&sort=cited_by_count:desc&per-page=${MAX_CITING}&select=${OA_SELECT}`);
    const got = j && Array.isArray(j.results) ? j.results : [];
    out.citations = { source: 'OpenAlex', total: Math.max(total, (j && j.meta && Number(j.meta.count)) || 0), list: got.map(oaEntry) };
  } else out.citations = { source: 'OpenAlex', total: 0, list: [] };
  return out;
}

// ---------- Semantic Scholar ----------
const s2Id = (id) => (id.arxiv ? 'ARXIV:' + encodeURIComponent(id.arxiv) : 'DOI:' + doiPath(id.doi));
const S2_FIELDS = 'title,year,venue,externalIds,citationCount,authors';
async function s2List(id, which) { // which: 'references' | 'citations'
  const key = which === 'references' ? 'citedPaper' : 'citingPaper';
  const limit = which === 'references' ? MAX_REFS : MAX_CITING;
  const j = await s2(`paper/${s2Id(id)}/${which}?fields=${S2_FIELDS}&limit=${limit}`);
  if (!j || !Array.isArray(j.data)) return null;
  return { source: 'Semantic Scholar', total: j.data.length, more: Number.isInteger(j.next), list: j.data.map((d) => s2Entry(d && d[key])) };
}
// the record of the paper itself: where it was published
async function s2Paper(id) {
  const p = await s2(`paper/${s2Id(id)}?fields=title,year,venue,publicationVenue,journal,externalIds,publicationTypes,citationCount,referenceCount`);
  if (!p || typeof p !== 'object' || !p.title) return null;
  const e = s2Entry(p);
  const types = Array.isArray(p.publicationTypes) ? p.publicationTypes.map(String) : [];
  const pv = p.publicationVenue && typeof p.publicationVenue === 'object' ? p.publicationVenue : {};
  const j = p.journal && typeof p.journal === 'object' ? p.journal : {};
  const venue = /^arxiv\b/i.test(str(pv.name)) ? e.venue : venueName(pv.name) || e.venue;
  // the "journal" of a preprint is arXiv itself (volume "abs/2107.04034"): that says nothing about the published paper,
  // and neither does the type "JournalArticle" that comes with it
  const preprint = /^(arxiv|corr)\b/i.test(str(j.name)) || /^abs\//i.test(str(j.volume));
  const pvType = str(pv.type, 30).toLowerCase();
  const meeting = pvType === 'conference' || /\b(conference|proceedings|symposium|workshop|congress)\b/i.test(venue);
  return {
    ...e, venue,
    kind: pvType === 'journal' || (!meeting && !preprint && types.includes('JournalArticle') && !types.includes('Conference')) ? 'article' : 'inproceedings',
    volume: preprint ? '' : str(j.volume, 30), pages: preprint ? '' : str(j.pages, 40).replace(/\s*-\s*/, '--'), refCount: Number(p.referenceCount) || 0,
  };
}

// ---------- the lookup ----------
// -> the cache record { v, key, fetched, work, references{source,total,list}, citations{...}, published, notes[] }
async function fetchRelated(id) {
  const notes = [];
  let a = null, oaErr = null;
  try { a = await openAlex(id); } catch (e) { oaErr = e; }
  let references = a && a.references, citations = a && a.citations;
  let work = a ? a.work : null;
  let s2Err = null;
  // Semantic Scholar: when OpenAlex could not be asked, does not know the paper, or has no reference list for it
  if (!references || !references.list.length) {
    try {
      const r = await s2List(id, 'references');
      if (r && r.list.length) references = r;
      if (!citations) { const c = await s2List(id, 'citations'); if (c) citations = c; }
    } catch (e) { s2Err = e; }
  }
  if (!references && !citations) {
    if (oaErr && s2Err) throw oaErr.extra && oaErr.extra.offline ? oaErr : s2Err.extra && s2Err.extra.offline ? s2Err : oaErr;
    if (oaErr) throw oaErr;
    if (s2Err && !a) throw s2Err;
    if (!a) throw fail(404, `Neither OpenAlex nor Semantic Scholar knows a paper with the ${id.label}. A very new preprint can take a few weeks to appear there.`);
  }
  if (s2Err && (!references || !references.list.length)) notes.push('OpenAlex has no reference list for this paper. ' + s2Err.message);
  if (oaErr && (references || citations)) notes.push(oaErr.message + ' The lists below come from Semantic Scholar.');
  const self = { doi: id.doi, arxiv: id.arxiv, title: work && work.title };
  const clean = (l, cap) => {
    if (!l) return { source: '', total: 0, list: [] };
    const list = tidy(l.list, self).slice(0, cap);
    return { source: l.source, total: Math.max(Number(l.total) || 0, list.length), more: !!l.more, list };
  };
  // where the paper was published, as far as this lookup shows it (the metadata check asks further)
  let published = null;
  if (work && work.doi && work.type !== 'preprint') published = { doi: work.doi, venue: work.venue === 'arXiv' ? '' : work.venue, year: work.year, source: 'OpenAlex' };
  const rec = {
    v: VERSION, key: id.key, fetched: new Date().toISOString(),
    work: work ? { title: work.title, year: work.year, venue: work.venue, doi: work.doi, arxiv: work.arxiv, type: work.type } : null,
    references: clean(references, MAX_REFS), citations: clean(citations, MAX_CITING), published, notes,
  };
  try { fs.mkdirSync(DIR, { recursive: true }); core.writeJSON(cacheFile(id), rec); } catch (e) { console.error('related cache:', e.message); }
  return rec;
}
const unknown = new Map(); // key -> { until, error }: "no index knows this paper" is remembered for an hour (Look up again still asks)
const running = new Map(); // key -> the lookup under way (two tabs, or a double click, share it)
function lookup(id) {
  let p = running.get(id.key);
  if (!p) { p = fetchRelated(id).finally(() => running.delete(id.key)); running.set(id.key, p); }
  return p;
}

// ---------- which of the listed papers are in the library ----------
function libraryIndex(items, exceptId) {
  const byDoi = new Map(), byArxiv = new Map(), byTitle = new Map();
  for (const it of items) {
    if (it.id === exceptId) continue;
    const id = identOf(it);
    if (id && id.doi) byDoi.set(id.doi.toLowerCase(), it.id);
    if (id && id.arxiv) byArxiv.set(id.arxiv.toLowerCase(), it.id);
    const t = normTitle(it.fields && it.fields.title);
    if (t.length >= 12 && !byTitle.has(t)) byTitle.set(t, it.id);
  }
  return (e) => (e.doi && byDoi.get(e.doi)) || (e.arxiv && byArxiv.get(e.arxiv.toLowerCase())) || byTitle.get(normTitle(e.title)) || null;
}
// what the page gets: the record plus, per paper, the library item it matches and the reference "Add" hands to the import
function present(rec, item, extra = {}) {
  const match = libraryIndex(core.loadLib().items, item.id);
  const mark = (l) => ({ ...l, list: l.list.map((e) => ({ ...e, venue: venueName(e.venue), inLibrary: match(e), ref: e.arxiv ? 'arXiv:' + e.arxiv : e.doi ? 'doi:' + e.doi : '' })) });
  const id = identOf(item);
  return {
    ident: id && { doi: id.doi, arxiv: id.arxiv, label: id.label }, fetched: rec.fetched, work: rec.work, notes: rec.notes || [],
    references: mark(rec.references), citations: mark(rec.citations),
    // an arXiv entry whose published version is known: the page offers "Check metadata"
    upgrade: id && id.arxiv && !id.doi && rec.published ? rec.published : null, ...extra,
  };
}
// mode: 'cached' (never asks a service) | 'auto' (asks when there is no answer yet or it is a month old) | 'refresh'
async function related(item, mode = 'auto') {
  const id = identOf(item);
  if (!id) return { ident: null };
  const cached = readAny(id);
  if (mode === 'cached') return cached ? present(cached, item, { cached: true }) : { ident: { doi: id.doi, arxiv: id.arxiv, label: id.label }, fetched: null };
  if (mode !== 'refresh' && cached && fresh(cached)) return present(cached, item, { cached: true });
  const miss = unknown.get(id.key);
  if (miss && mode !== 'refresh' && !cached && miss.until > Date.now()) throw miss.error;
  try { const rec = await lookup(id); unknown.delete(id.key); return present(rec, item, { cached: false }); }
  catch (e) {
    if (e && e.status === 404) unknown.set(id.key, { until: Date.now() + PARTIAL_MS, error: e });
    // offline or asked to wait: the earlier answer is better than none
    if (cached) return present(cached, item, { cached: true, warning: e.message + ' Showing the lists as they were looked up earlier.' });
    throw e;
  }
}

// ---------- "Check metadata": the published version of a preprint, or the record of a DOI ----------
const BIB_FIELDS = ['title', 'author', 'year', 'month', 'journal', 'booktitle', 'volume', 'number', 'pages', 'publisher', 'editor', 'series', 'address', 'organization', 'issn', 'isbn', 'doi', 'url', 'eprint', 'archiveprefix', 'primaryclass'];
const LABELS = { title: 'Title', author: 'Authors', year: 'Year', month: 'Month', journal: 'Journal', booktitle: 'Venue', volume: 'Volume', number: 'Number', pages: 'Pages', publisher: 'Publisher', editor: 'Editors', series: 'Series', address: 'Address', organization: 'Organization', issn: 'ISSN', isbn: 'ISBN', doi: 'DOI', url: 'URL', eprint: 'arXiv id', archiveprefix: 'Archive', primaryclass: 'arXiv class', '@type': 'Entry type' };
const TYPES = ['article', 'inproceedings', 'book', 'incollection', 'phdthesis', 'mastersthesis', 'techreport', 'misc', 'unpublished', 'proceedings', 'inbook', 'booklet', 'manual'];
const loose = (s) => String(s || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const lastNames = (a) => String(a || '').split(/\s+and\s+/i).map((n) => (n.includes(',') ? n.split(',')[0] : n.trim().split(/\s+/).pop() || '')
  .normalize('NFKD').replace(/[^\p{L}]+/gu, '').toLowerCase()).join('|');
// same paper? equal once punctuation is dropped, or nearly the same words (a published title often differs a little)
function sameWork(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (x === y || (x.length > 20 && y.length > 20 && (x.includes(y) || y.includes(x)))) return true;
  const words = (t) => new Set(String(t).normalize('NFKD').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  const A = words(a), B = words(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.max(1, A.size + B.size - both) >= 0.6;
}
// where an arXiv paper was published: OpenAlex, then Semantic Scholar, then arXiv's own record
// -> { doi?, venue?, year?, kind?, volume?, pages?, source } | null ; throws when no service could be asked
async function findPublished(id) {
  const errs = [];
  let asked = 0;
  const cached = readCache(id);
  if (cached && cached.published && fresh(cached)) return cached.published;
  try {
    const w = await oa('works/https://doi.org/' + doiPath(refs.arxivDoi(id.arxiv)) + '?select=id,doi,title,type,publication_year,primary_location');
    asked++;
    const e = w && oaEntry(w);
    if (e && e.doi && str(w.type, 40) !== 'preprint') return { doi: e.doi, venue: e.venue === 'arXiv' ? '' : e.venue, year: e.year, source: 'OpenAlex' };
  } catch (e) { errs.push(e); }
  try {
    const p = await s2Paper(id);
    asked++;
    if (p && p.doi) return { doi: p.doi, venue: p.venue === 'arXiv' ? '' : p.venue, year: p.year, kind: p.kind, volume: p.volume, pages: p.pages, source: 'Semantic Scholar' };
    if (p && p.venue && p.venue !== 'arXiv') return { venue: p.venue, year: p.year, kind: p.kind, volume: p.volume, pages: p.pages, source: 'Semantic Scholar' };
  } catch (e) { errs.push(e); }
  try {
    const m = await refs.arxivMeta(id.arxiv);
    asked++;
    const d = m && m.publishedDoi && refs.parseRef(m.publishedDoi);
    if (d && d.kind === 'doi') return { doi: d.id, source: 'arXiv' };
  } catch (e) { errs.push(e); }
  if (!asked) throw errs.find((e) => e.extra && e.extra.offline) || errs[0];
  return errs.length ? { missed: errs.map((e) => e.message).join(' ') } : null; // nothing found, but not everyone could be asked
}
// -> { found, kind: 'published' | 'refresh', source, message, changes: [{field, label, from, to}] }
async function checkMetadata(item) {
  const id = identOf(item);
  if (!id) throw fail(400, 'This entry has no DOI and no arXiv id, so there is nothing to look it up by. Add one in the DOI field first.');
  const cur = item.fields || {};
  let next = null, type = item.type, kind = 'refresh', source = 'doi.org', message = '';
  if (id.doi) {
    const e = await refs.doiMeta(id.doi);
    if (!e) return { found: false, kind, source, changes: [], message: `doi.org has no record of ${id.doi}. Check the DOI for typing mistakes.` };
    next = e.fields; type = e.type || type;
  } else {
    kind = 'published';
    const pub = await findPublished(id);
    if (!pub) return { found: false, kind, source: '', changes: [], message: 'No published version of this preprint is known to OpenAlex, Semantic Scholar or arXiv yet. It stays an arXiv entry.' };
    if (pub.missed) return { found: false, kind, source: '', changes: [], retry: true, message: 'No published version was found, but not every index could be asked: ' + pub.missed };
    source = pub.source;
    let e = null;
    if (pub.doi) { try { e = await refs.doiMeta(pub.doi); } catch (err) { if (!pub.venue) throw err; } }
    if (e && cur.title && !sameWork(cur.title, e.fields.title)) {
      return { found: false, kind, source, changes: [], message: `${pub.source} links this preprint to “${str(e.fields.title, 200)}” (${pub.doi}), which does not look like the same paper, so nothing is proposed.` };
    }
    if (e) { next = e.fields; type = e.type || 'article'; }
    else {
      type = pub.kind || 'inproceedings';
      next = { [type === 'article' ? 'journal' : 'booktitle']: pub.venue || '', year: pub.year ? String(pub.year) : '', volume: pub.volume || '', pages: pub.pages || '', doi: pub.doi || '' };
    }
    // the arXiv id stays with the entry, so the preprint is still one click away
    next = { ...next, eprint: cur.eprint || id.arxiv, archiveprefix: cur.archiveprefix || 'arXiv' };
    message = `Published version found through ${pub.source}${pub.venue ? ': ' + pub.venue + (pub.year ? ' ' + pub.year : '') : ''}.`;
  }
  if (!TYPES.includes(type)) type = item.type;
  const changes = [];
  if (type !== item.type) changes.push({ field: '@type', label: LABELS['@type'], from: item.type || '', to: type });
  for (const f of BIB_FIELDS) {
    const to = str(next[f], 5000), from = typeof cur[f] === 'string' ? cur[f].trim() : '';
    if (!to || loose(to) === loose(from)) continue;
    if (f === 'doi' && normDoi(to) === normDoi(from)) continue;
    if (f === 'url' && kind === 'refresh' && from) continue; // a link the user keeps is not replaced by the publisher's
    // only the spelling differs (capitals, formulas, "First Last" against "Last, First"): offered, but not ticked
    const minor = !!from && ((f === 'title' && normTitle(from) === normTitle(to)) || (f === 'author' && lastNames(from) === lastNames(to)) || f === 'url');
    changes.push({ field: f, label: LABELS[f] || f, from, to, minor });
  }
  // "publisher = arXiv" does not describe the published paper
  if (kind === 'published' && /^arxiv$/i.test(loose(cur.publisher)) && !str(next.publisher)) changes.push({ field: 'publisher', label: LABELS.publisher, from: cur.publisher, to: '' });
  if (!changes.length) message = kind === 'refresh' ? 'The entry already matches the record at doi.org.' : 'The entry already holds the published version.';
  return { found: changes.length > 0, kind, source, message, changes };
}
// the changes the user ticked -> the item (the cite key is never touched). values: { field: text, '@type': type }
function applyMetadata(itemId, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail(400, 'values must be an object of field: text');
  const set = {};
  for (const [k, v] of Object.entries(values)) {
    if (k !== '@type' && !BIB_FIELDS.includes(k)) throw fail(400, `Unknown field: ${String(k).slice(0, 40)}`);
    if (typeof v !== 'string' || v.length > 5000) throw fail(400, `The value of ${k} must be text`);
    if (k === '@type' && !TYPES.includes(v)) throw fail(400, 'Unknown entry type');
    set[k] = v.replace(/\s+/g, ' ').trim();
  }
  if (!Object.keys(set).length) throw fail(400, 'Nothing was chosen to change.');
  const lib = core.loadLib(); // fresh, and nothing is awaited before the save
  const item = lib.items.find((i) => i.id === itemId);
  if (!item) throw fail(404, 'No such item');
  item.fields = { ...(item.fields || {}) };
  for (const [k, v] of Object.entries(set)) {
    if (k === '@type') item.type = v;
    else if (v) item.fields[k] = v;
    else delete item.fields[k];
  }
  if ('title' in set || 'author' in set || 'doi' in set) item.metaSource = 'doi'; // no longer a guess read from the PDF
  core.saveLib(lib);
  return item;
}

// getJson / gate / oa / s2 / doiPath / venueName are shared with lib/venues.js (the venue check)
module.exports = { identOf, related, checkMetadata, applyMetadata, sameWork, entry, tidy, libraryIndex, BIB_FIELDS, getJson, gate, oa, s2, doiPath, venueName, str };
