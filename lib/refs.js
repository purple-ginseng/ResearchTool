// Adding a paper by reference: recognise an arXiv id / arxiv.org URL, a DOI / doi.org URL or an OpenReview link,
// fetch its metadata (arXiv API, doi.org BibTeX, OpenAlex, OpenReview API) and download an open PDF.
// Only the id or DOI itself is ever sent out. Everything fetched here is untrusted: metadata is kept as plain BibTeX
// fields, and a download is accepted only when it is https, comes from a public host and starts with %PDF-.
const dns = require('node:dns').promises;
const net = require('node:net');
const core = require('./core');
const bib = require('./bibtex');

const UA = { 'User-Agent': 'ResearchTool-local/0.1' };
const MAX_PDF = 100 * 1024 * 1024;

// ---------- recognising a reference ----------
// new style 1706.03762, old style hep-th/9901001 or math.GT/0309136, each with an optional version
const ARXIV_ID = '(\\d{4}\\.\\d{4,5}|[a-z][a-z-]+(?:\\.[a-z]{2})?\\/\\d{7})(v\\d+)?';
const RE_ARXIV_URL = new RegExp('^(?:https?:\\/\\/)?(?:www\\.|export\\.)?(?:arxiv|alphaxiv)\\.org\\/(?:abs|pdf|html|format|ps)\\/' + ARXIV_ID + '(?:\\.pdf)?\\/?(?:[?#].*)?$', 'i');
const RE_ARXIV = new RegExp('^(?:arxiv:)?' + ARXIV_ID + '$', 'i');
const RE_OPENREVIEW = /^(?:https?:\/\/)?(?:www\.)?openreview\.net\/(?:forum|pdf|attachment)\?(?:[^#\s]*&)?id=([A-Za-z0-9_-]{6,40})(?:[&#].*)?$/i;
// a publisher page whose address holds the DOI: dl.acm.org/doi/10.1145/..., link.springer.com/content/pdf/10.1007/....pdf
const RE_DOI_URL = /^https?:\/\/[^\/\s]+\/\S*?\b(10\.\d{4,9}\/[^?#\s]+)/i;
const RE_DOI = /^(?:(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

// one pasted line -> { kind: 'arxiv' | 'doi' | 'openreview', id, version?, label } or null
function parseRef(raw) {
  // "arXiv:1706.03762v7 [cs.CL]" as printed on a PDF, <...> or quotes around a link, "doi: 10..." with a space
  const s = String(raw ?? '').trim().replace(/\s*\[[\w.-]+\]$/, '').replace(/^\((.*)\)[.,;]?$/, '$1').replace(/^[<(\["'\s]+|[>\]"',;.\s]+$/g, '').replace(/^(arxiv|doi):\s+/i, '$1:');
  if (!s || s.length > 500 || /\s/.test(s)) return null;
  let m;
  if ((m = s.match(RE_OPENREVIEW))) return { kind: 'openreview', id: m[1], label: 'OpenReview ' + m[1] };
  if ((m = s.match(RE_ARXIV_URL)) || (m = s.match(RE_ARXIV))) return arxivRef(m[1], m[2]);
  if ((m = s.match(RE_DOI))) {
    let doi = m[1].replace(/[.,;]+$/, '');
    if (/%[0-9a-f]{2}/i.test(doi)) { try { doi = decodeURIComponent(doi); } catch { /* keep it as typed */ } }
    const ax = doi.match(new RegExp('^10\\.48550\\/arxiv\\.' + ARXIV_ID + '$', 'i'));
    if (ax) return arxivRef(ax[1], ax[2]);
    return { kind: 'doi', id: doi, label: 'doi:' + doi };
  }
  if ((m = s.match(RE_DOI_URL))) {
    let doi = m[1];
    if (/%[0-9a-f]{2}/i.test(doi)) { try { doi = decodeURIComponent(doi); } catch { /* keep it as typed */ } }
    doi = doi.replace(/\.pdf$/i, '').replace(/\/(?:pdf|epdf|full|abstract|meta|html|fulltext|full\.pdf)\/?$/i, '').replace(/[.,;\/]+$/, '');
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) return { kind: 'doi', id: doi, label: 'doi:' + doi };
  }
  return null;
}
function arxivRef(id, version) {
  id = id.toLowerCase().replace(/\.([a-z]{2})\//, (x, c) => '.' + c.toUpperCase() + '/'); // math.gt/... -> math.GT/...
  return { kind: 'arxiv', id, version: version ? version.toLowerCase() : '', label: 'arXiv:' + id + (version ? version.toLowerCase() : '') };
}
const arxivDoi = (id) => '10.48550/arXiv.' + id;
// a DOI inside a URL path: '#', '?' and the like must not end the path
const doiPath = (doi) => String(doi).split('/').map(encodeURIComponent).join('/');

// ---------- small helpers ----------
const fail = (status, msg, extra) => core.httpErr(status, msg, extra);
const netMsg = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'it did not answer in time' : 'it could not be reached (are you online?)');
const xmlText = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (x, h) => String.fromCodePoint(parseInt(h, 16) || 32)).replace(/&#(\d+);/g, (x, d) => String.fromCodePoint(Number(d) || 32))
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// "Ashish Vaswani" -> "Vaswani, Ashish" (the form doi.org uses; names that already hold a comma are kept)
function bibName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n || n.includes(',')) return n;
  const parts = n.split(' ');
  if (parts.length < 2) return n;
  let k = parts.length - 1; // "van der Maaten", "de Freitas": the lower-case particles belong to the family name
  while (k > 1 && /^(van|von|der|den|de|del|della|di|da|dos|du|la|le|ter|ten|bin|al)$/.test(parts[k - 1])) k--;
  return parts.slice(k).join(' ') + ', ' + parts.slice(0, k).join(' ');
}
const cleanFields = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));

// ---------- arXiv ----------
// the arXiv API asks for one request every three seconds: calls wait in line here
let arxivGate = Promise.resolve();
function arxivTurn() {
  const turn = arxivGate;
  arxivGate = turn.then(() => new Promise((r) => setTimeout(r, 3000)));
  return turn;
}
function parseArxivAtom(xml, id) {
  const e = String(xml).match(/<entry>([\s\S]*?)<\/entry>/);
  if (!e) return null;
  const x = e[1];
  const tag = (t) => { const m = x.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>')); return m ? xmlText(m[1]) : ''; };
  const title = tag('title');
  if (!title || !/<id>[^<]*arxiv\.org\/abs\//i.test(x)) return null; // an error entry has no abs id
  const authors = [...x.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => bibName(xmlText(m[1]))).filter(Boolean);
  const prim = x.match(/<arxiv:primary_category[^>]*\bterm="([^"]+)"/);
  const published = tag('arxiv:doi');
  const fields = cleanFields({
    title, author: authors.join(' and '), year: (tag('published').match(/^\d{4}/) || [''])[0],
    doi: arxivDoi(id), url: 'https://arxiv.org/abs/' + id, eprint: id, archiveprefix: 'arXiv', primaryclass: prim ? xmlText(prim[1]) : '',
    publisher: 'arXiv', note: tag('arxiv:journal_ref'), abstract: tag('summary'),
  });
  // published = the date of version 1 (the first public date); comment / journalRef are the authors' own words
  // ("Accepted to CoRL 2025"): lib/venues.js shows them as a claim, never as a verified venue
  // relatedDoi: the DOI the authors gave for the published version (<arxiv:doi>, else a DOI written in journal_ref) -
  // lib/venues.js asks Crossref for it and uses it only when that record is the same paper by the same first author
  const jr = tag('arxiv:journal_ref');
  const jrDoi = (jr.match(/\b10\.\d{4,9}\/[^\s"<>,;]+/) || [''])[0].replace(/[.)\]]+$/, '');
  return { entry: { type: 'misc', key: '', fields }, publishedDoi: published, relatedDoi: published.split(/\s+/)[0] || jrDoi, published: (tag('published').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0], comment: tag('arxiv:comment'), journalRef: jr };
}
// -> { entry, publishedDoi, relatedDoi, published, comment, journalRef } | null when arXiv has no such paper; throws (502) when arXiv cannot be asked
async function arxivMeta(id) {
  await arxivTurn();
  let r;
  try {
    r = await fetch('https://export.arxiv.org/api/query?max_results=1&id_list=' + encodeURIComponent(id), { headers: UA, signal: AbortSignal.timeout(15000) });
  } catch (e) { throw fail(502, 'arXiv: ' + netMsg(e)); }
  if (!r.ok) throw fail(502, r.status === 429 ? 'arXiv is busy and asked to wait' : `arXiv answered with an error (${r.status})`);
  return parseArxivAtom(await r.text(), id);
}

// The arXiv copy of a published paper, found by its exact title (OpenAlex often does not link the two).
// -> arXiv id | '' ; only the title is sent. Never throws: without an answer there is simply no arXiv copy.
const sameTitle = (t) => String(t || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
async function arxivByTitle(title) {
  const words = String(title || '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (sameTitle(title).length < 12) return '';
  try {
    await arxivTurn();
    const r = await fetch('https://export.arxiv.org/api/query?max_results=5&search_query=' + encodeURIComponent('ti:"' + words + '"'), { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    for (const e of (await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const t = e[1].match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/);
      const id = e[1].match(new RegExp('<id>[^<]*arxiv\\.org\\/abs\\/' + ARXIV_ID + '<\\/id>', 'i'));
      if (t && id && sameTitle(xmlText(t[1])) === sameTitle(title)) return arxivRef(id[1], '').id;
    }
  } catch { /* no answer */ }
  return '';
}

// ---------- doi.org ----------
// -> the BibTeX entry of a DOI | null when doi.org does not know it; throws (502) when doi.org cannot be asked
async function doiMeta(doi) {
  let r;
  try {
    r = await fetch('https://doi.org/' + doiPath(doi), {
      headers: { ...UA, Accept: 'application/x-bibtex; charset=utf-8' }, signal: AbortSignal.timeout(10000), redirect: 'follow',
    });
  } catch (e) { throw fail(502, 'doi.org: ' + netMsg(e)); }
  if (r.status === 404) return null;
  if (!r.ok) throw fail(502, `doi.org answered with an error (${r.status})`);
  const entry = bib.parse(await r.text())[0];
  if (!entry || !entry.fields || !entry.fields.title) return null; // (a DOI whose registry has no BibTeX)
  if (!entry.fields.doi) entry.fields.doi = doi;
  return entry;
}

// ---------- OpenAlex: is there a free copy of this DOI? ----------
// -> { arxivId, pdfUrls: [https urls, best first], abstract } - empty when OpenAlex does not know the DOI; throws (502)
// when it cannot be asked
async function openAccess(doi) {
  let r;
  try {
    r = await fetch('https://api.openalex.org/works/https://doi.org/' + doiPath(doi) + '?select=id,best_oa_location,locations,abstract_inverted_index',
      { headers: UA, signal: AbortSignal.timeout(12000) });
  } catch (e) { throw fail(502, 'OpenAlex: ' + netMsg(e)); }
  if (r.status === 404) return { arxivId: '', pdfUrls: [], abstract: '' };
  if (!r.ok) throw fail(502, `OpenAlex answered with an error (${r.status})`);
  let j;
  try { j = await r.json(); } catch { throw fail(502, 'OpenAlex sent an answer that could not be read'); }
  return readOpenAlex(j);
}
function readOpenAlex(j) {
  const locs = [j && j.best_oa_location, ...(Array.isArray(j && j.locations) ? j.locations : [])].filter((l) => l && typeof l === 'object' && l.is_oa);
  let arxivId = '';
  const pdfUrls = [];
  for (const l of locs) {
    for (const u of [l.pdf_url, l.landing_page_url]) {
      const m = typeof u === 'string' && u.match(new RegExp('arxiv\\.org\\/(?:abs|pdf)\\/' + ARXIV_ID, 'i'));
      if (m && !arxivId) arxivId = arxivRef(m[1], '').id;
    }
    if (typeof l.pdf_url === 'string' && !/arxiv\.org\//i.test(l.pdf_url) && publicHttps(l.pdf_url) && !pdfUrls.includes(l.pdf_url)) pdfUrls.push(l.pdf_url);
  }
  // the abstract comes as word -> positions
  let abstract = '';
  const inv = j && j.abstract_inverted_index;
  if (inv && typeof inv === 'object') {
    const words = [];
    for (const [w, pos] of Object.entries(inv)) if (Array.isArray(pos)) for (const p of pos) if (Number.isInteger(p) && p >= 0 && p < 5000) words[p] = w;
    abstract = words.filter((w) => typeof w === 'string').join(' ').replace(/\s+/g, ' ').trim().replace(/^abstract[:.]?\s+/i, '');
  }
  return { arxivId, pdfUrls: pdfUrls.slice(0, 3), abstract };
}

// ---------- OpenReview ----------
// -> { entry } | null when the paper is not public or unknown (also when the API cannot be asked: the PDF then
// supplies title and authors)
async function openreviewMeta(id) {
  const val = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v); // API 2 wraps values
  for (const host of ['api2.openreview.net', 'api.openreview.net']) {
    try {
      const r = await fetch(`https://${host}/notes?id=${encodeURIComponent(id)}`, { headers: { ...UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const note = ((await r.json()).notes || [])[0];
      const c = note && note.content;
      const title = c && val(c.title);
      if (typeof title !== 'string' || !title.trim()) continue;
      const authors = val(c.authors);
      const venue = [val(c.venue), val(c.venueid)].find((v) => typeof v === 'string' && v.trim() && !/submitted|withdrawn|rejected/i.test(v)) || '';
      const when = [note.pdate, note.odate, note.cdate, note.tcdate].find((t) => typeof t === 'number' && t > 0);
      const yearInVenue = (String(val(c.venue) || '').match(/\b(19|20)\d{2}\b/) || [''])[0];
      const abs = val(c.abstract);
      const fields = cleanFields({
        title: title.replace(/\s+/g, ' '), author: Array.isArray(authors) ? authors.filter((a) => typeof a === 'string').map(bibName).join(' and ') : '',
        year: yearInVenue || (when ? String(new Date(when).getUTCFullYear()) : ''), booktitle: venue,
        url: 'https://openreview.net/forum?id=' + id, abstract: typeof abs === 'string' ? abs.replace(/\s+/g, ' ') : '',
      });
      return { entry: { type: venue ? 'inproceedings' : 'misc', key: '', fields } };
    } catch { /* try the older API, then go on without metadata */ }
  }
  return null;
}

// ---------- downloading a PDF ----------
// https only, a public host name (no IP address, nothing local): a URL that came out of a metadata service must not be
// able to reach this Mac or the local network
function publicHttps(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  const h = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (!h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h) || /^0x/i.test(h)) return false;
  return !/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example)$/.test(h);
}
// -> Buffer of a PDF. Throws an Error with .gone = true when there is no PDF at that address (so a retry is pointless),
// .gone = false when the download broke on the way.
// false when the host name resolves to this Mac or to an address of the local network
const LOCAL_NETS = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) LOCAL_NETS.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) LOCAL_NETS.addSubnet(a, n, 'ipv6');
function localAddress(addr) {
  const mapped = String(addr).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return LOCAL_NETS.check(mapped[1], 'ipv4');
  return LOCAL_NETS.check(addr, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
}
async function resolvesPublic(host, lookup = dns.lookup) {
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch { return true; } // unknown name: the download reports it
  return !addrs.some((a) => localAddress(a.address));
}
async function downloadPdf(url, { timeout = 120000, fetchFn = fetch, lookup = dns.lookup } = {}) {
  const err = (msg, gone) => Object.assign(new Error(msg), { gone });
  const signal = AbortSignal.timeout(timeout);
  let u = url;
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (!publicHttps(u) || !(await resolvesPublic(new URL(u).hostname, lookup))) throw err('the link does not point to a public https address', true);
      const r = await fetchFn(u, { headers: { ...UA, Accept: 'application/pdf,*/*;q=0.5' }, redirect: 'manual', signal });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        if (r.body) r.body.cancel().catch(() => {});
        u = new URL(r.headers.get('location'), u).href;
        continue;
      }
      if (!r.ok) {
        if (r.body) r.body.cancel().catch(() => {});
        throw err(r.status === 429 ? 'the site is busy and asked to wait' : `the site answered with an error (${r.status})`, r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429);
      }
      if (Number(r.headers.get('content-length')) > MAX_PDF) { if (r.body) r.body.cancel().catch(() => {}); throw err('the PDF is larger than 100 MB', true); }
      const chunks = [];
      let size = 0;
      for await (const c of r.body) {
        if (!size && c.length >= 5 && Buffer.from(c.subarray(0, 5)).toString('latin1') !== '%PDF-') throw err('the site sent a web page instead of a PDF', true);
        size += c.length;
        if (size > MAX_PDF) throw err('the PDF is larger than 100 MB', true);
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw err('the site sent something that is not a PDF', true);
      return buf;
    }
    throw err('the link redirects too many times', true);
  } catch (e) {
    if (typeof e.gone === 'boolean') throw e;
    throw err(netMsg(e), false);
  }
}

module.exports = { parseRef, arxivDoi, arxivMeta, arxivByTitle, parseArxivAtom, doiMeta, openAccess, readOpenAlex, openreviewMeta, downloadPdf, publicHttps, localAddress, bibName };
