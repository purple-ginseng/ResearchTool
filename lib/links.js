// The links of a paper - its PDF, arXiv page, DOI / publisher page, project page, code repositories - for the paper
// package (lib/notes.js zipNotes) and the Links section of the reader. Every link is something the AUTHORS stated:
//   - the BibTeX fields of the item (url, doi, eprint, howpublished, note) - arXiv / DOI / publisher links;
//   - the paper's own text (pdftotext through lib/textcache.js): any link on pages 1-2, and links in sentences near
//     "code", "project page", "website", "available at", "github", "videos" further on - never in the reference
//     list (cut with notes.dropReferences). Line-broken URLs are joined (joinBroken), trailing punctuation stripped;
//   - the PDF's own hyperlinks on pages 1-2 (URI link annotations, `pdfinfo -url`): a link behind words such as
//     "project website" or "GitHub repository", and the whole address when the printed one is cut (pdftotext prints
//     ".../Action_Reasoning" as ".../Action Reasoning": a printed URL that an annotation of its page continues is
//     replaced by the annotation); a hyphen pdftotext dropped where it joined a line-broken URL is put back from
//     `pdftotext -raw` (restoreHyphens);
//   - the arXiv comment field ("Project page: ...", "Code: ...", lib/refs.js arxivMeta);
//   - the authors' project page, read once (fetchPage / pageAnchors / fromPage): the repository its "Code" / GitHub
//     button links, or one named like the paper - not the site template, the page's own source, related work;
//   - the Hugging Face papers API (githubRepo / projectPage; 404 "Paper not found" is no error). Anyone can attach a
//     repository there (a third-party re-implementation, a challenge built on the paper), so a githubRepo that no
//     author source names - and whose owner is not the account of the authors' <owner>.github.io page - is kept with
//     `unconfirmed: true`: only the reader's Details show it ("suggested by Hugging Face"), never the package;
//   - the publisher record lib/venues.js verified (its Crossref doi.org link).
// Nothing is guessed: no search, no URL made up from a title. Only the arXiv id is sent out (export.arxiv.org,
// huggingface.co), and - optional reachability check - a HEAD to each project / code link found (dead ones stay
// listed with `dead: true`; one whose host does not exist - ENOTFOUND while other hosts resolve - moves to `other`
// with `gone: true`). Review placeholders ("www.after-review.com/myCode" of an anonymized paper) are never links.
// links(item, {network}) -> { pdf, arxiv, doi, publisher, project: {url, source}|null, code: [{url, source}],
// other: [{url, source, kind}], checked, notes }. network false: fields + PDF text + cached answers (instant).
// Cache: <workspace>/cache/links/<id>.json = {v, key (PDF key + fields), paper (the scan of the text and the PDF's
// hyperlinks), net, reach, page (the project page's code-host links)}.
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const core = require('./core');
const refs = require('./refs');
const related = require('./related');
const textcache = require('./textcache');

const DIR = path.join(core.DIRS.cache, 'links');
const VERSION = 3; // 2: the PDF's hyperlinks, review placeholders; 3: hyphens of line-broken URLs (pdftotext -raw), the project page
const NET_FRESH_MS = 30 * 24 * 3600 * 1000, NET_RETRY_MS = 3600 * 1000, REACH_FRESH_MS = 7 * 24 * 3600 * 1000;
const UA = { 'User-Agent': 'ResearchTool-local/0.1' };
const turnHF = related.gate(1000);
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// ---------------------------------------------------------------- URLs in text (pure)
const UCH = String.raw`[\w\-.~:/?#@!$&()*+,;=%]`; // characters of a URL (ASCII only: "∗", "†" after a link are footnote marks)
const URL_RE = new RegExp(String.raw`(?:\bhttps?:\/\/|\bwww\.)${UCH}+|(?<![\w@./-])(?:[a-z0-9][a-z0-9-]*\.)+git(?:hub|lab)\.io(?:\/${UCH}*)?|(?<![\w@./-])(?:github\.com|gitlab\.com|huggingface\.co)\/${UCH}+`, 'gi');
// a URL as written -> a clean absolute https/http URL | null: trailing ".", ",", ")" ... stripped (a ")" only when it
// is not balanced inside the URL), "https://" added to a link written without it
function trimUrl(raw) {
  let s = String(raw || '').trim();
  for (;;) {
    const last = s.slice(-1);
    if (/[.,;:!?'"*]/.test(last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) { s = s.slice(0, -1); continue; }
    break;
  }
  return s;
}
function cleanUrl(raw) {
  let s = trimUrl(raw);
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /\.\./.test(h)) return null;
  return u.href.replace(/^(https?:\/\/[^/?#]+)\/$/, '$1'); // "https://x.github.io/" -> "https://x.github.io" (the bare host as written)
}

// pdftotext breaks a long URL over lines: join a URL that ends its line with the first word of the next line when
// that word continues it without a space - only for a line that reached the margin (a link alone on a short line is
// whole) and a next word that looks like the rest of a URL ("ca/fast-inertial/", "tactile-obj-dynamics", not
// "Keywords:"). "https:" + "//host" is always joined. A "-" at the end of the line is part of the URL and stays: LaTeX's
// \url breaks at a hyphen without adding one ("https://project-" + "instinct.github.io/...").
function joinBroken(text) {
  const lines = String(text || '').split('\n');
  const lens = lines.map((l) => l.trimEnd().length).filter((n) => n > 0).sort((a, b) => a - b);
  const p90 = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))] : 0;
  for (let i = 0; i < lines.length - 1; i++) {
    for (let guard = 0; guard < 6; guard++) {
      const line = lines[i].trimEnd(), next = lines[i + 1];
      if (next == null || /^\s/.test(next) || !next) break;
      const tok = /^\S+/.exec(next)[0];
      let join = false;
      if (/\bhttps?:\/{0,2}$/i.test(line) && /^\/{0,2}[a-z0-9]/i.test(tok)) join = true; // "https:" + "//github.com/..."
      else {
        let m = null, mm;
        URL_RE.lastIndex = 0;
        while ((mm = URL_RE.exec(line))) m = mm;
        if (!m || m.index + m[0].length !== line.length) break; // no URL at the end of this line
        const urlish = new RegExp(`^${UCH}+$`).test(tok) && !/:$/.test(tok);
        const bare = tok.replace(/[.,;:)]+$/, ''); // "Optimization" after ".../3d-gaussian-splatting/" is the next sentence
        const looks = /[/.\-_=?&#%]/.test(bare) || (/^[a-z0-9]+$/.test(bare) && /[/\-]$/.test(m[0]));
        const starts = /^[a-z0-9/]/.test(tok) || /\/$/.test(m[0]);
        const ends = /[/.\-_~=?&#%]$/.test(m[0]);
        const long = line.length >= Math.max(30, 0.7 * p90) || /[\w.]-$/.test(m[0]); // a URL never ends with "-": it goes on
        join = urlish && looks && starts && ends && long;
      }
      if (!join) break;
      lines[i] = line + tok;
      lines[i + 1] = next.slice(tok.length).replace(/^\s+/, '');
      if (!lines[i + 1]) { lines.splice(i + 1, 1); }
    }
  }
  return lines.join('\n');
}

// every URL of a text -> [{url, raw, index, end}]
function findUrls(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    const url = cleanUrl(m[0]);
    if (url) out.push({ url, raw: m[0], index: m.index, end: m.index + m[0].length });
  }
  return out;
}

// pdftotext (poppler, not in -raw mode) joins a word broken at a line-end hyphen and drops the hyphen - also in a URL:
// "https://project-" / "instinct.github.io" comes out as "https://projectinstinct.github.io" (a 404). The same page read
// with `pdftotext -raw` keeps the hyphen: a URL of `text` that differs from a URL of `raw` (the -raw text of the same
// page) only by hyphens, and that -raw does not print as it is, is replaced by the -raw spelling.
const dehy = (u) => String(u).toLowerCase().replace(/-/g, '');
function restoreHyphens(text, raw) {
  if (!raw || !/-/.test(raw)) return text;
  const alt = new Map(), exact = new Set();
  for (const u of findUrls(joinBroken(String(raw).replace(/\r/g, '')))) {
    exact.add(u.url.toLowerCase());
    if (u.url.includes('-') && !alt.has(dehy(u.url))) alt.set(dehy(u.url), trimUrl(u.raw));
  }
  if (!alt.size) return text;
  URL_RE.lastIndex = 0;
  return String(text).replace(URL_RE, (m) => {
    const core_ = trimUrl(m), c = cleanUrl(core_);
    if (!c || exact.has(c.toLowerCase())) return m;
    const a = alt.get(dehy(c));
    return a && a.replace(/-/g, '').toLowerCase() === core_.replace(/-/g, '').toLowerCase() ? a + m.slice(core_.length) : m;
  });
}

// hosts that are never a project page: publishers, indexes, licences (their links in a paper are the publisher's
// stamp - "Downloaded from https://www.science.org" - or citations)
const SKIP_HOSTS = /(^|\.)(doi\.org|science\.org|sciencemag\.org|ieee\.org|acm\.org|springer\.com|sciencedirect\.com|elsevier\.com|nature\.com|wiley\.com|mdpi\.com|tandfonline\.com|sagepub\.com|creativecommons\.org|mlr\.press|neurips\.cc|nips\.cc|aaai\.org|ijcai\.org|roboticsproceedings\.org|openreview\.net|semanticscholar\.org|scholar\.google\.com|orcid\.org|acl(anthology|web)\.org|cvf\.com|thecvf\.com|ecva\.net|iclr\.cc|icml\.cc|jmlr\.org|pmlr\.org|researchgate\.net|dblp\.org|crossref\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|w3\.org|apache\.org)$/;
// a placeholder of an anonymized submission ("Code available at: www.after-review.com/myCode") - not a real host
// (anonymous.4open.science, the service for anonymized repositories, is real and stays)
const PLACEHOLDER_HOSTS = /(^|[.-])(after-?review|under-?review|blind-?review|upon-?acceptance|after-?acceptance|anonymi[sz]ed-?(link|url|code)?|to-?be-?released|coming-?soon)([.-]|$)/;
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com)$/;
const PROJECT_HOSTS = /(\.github\.io|\.gitlab\.io|\.netlify\.app|\.vercel\.app|\.pages\.dev)$|^sites\.google\.com$/;
const CODE_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|huggingface\.co|codeberg\.org)$/;
const KW_CODE = /\b(code|codes|github|repo|repository|source|implementation)\b/i;
const KW_PROJECT = /\bproject\b|\bwebsite\b|\bweb ?page\b|\bhome ?page\b|\bsite\b|\bblog(post)?\b/i;
const KW_MORE = /\b(data|datasets?|videos?|demos?|models?|checkpoints?|weights|supplementary)\b/i; // more than code behind the link
const KW_VIDEO = /\bvideos?\b|\bdemos?\b|\bsupplementary\b/i;
const KW_DATA = /\bdata ?sets?\b|\bdata\b/i;
const KW_NEAR = /\bcode\b|project (page|website|site)|\bwebsite\b|\bhome ?page\b|\bavailable (at|on|from)\b|\bgithub\b|\bvideos?\b/i;
// after page 2 a link counts only where the authors announce it: "Code:", "Project page:", "our code is available at",
// "videos can be found at" (not a footnote to a library they used)
const ANNOUNCE = new RegExp([
  String.raw`\b(code|project page|project website|website|homepage|videos?|github)\s*:\s*$`,
  String.raw`\b(code|implementation|project page|website|homepage|videos?|models?|data(sets?)?|repository)\b[^.]{0,80}\b(is|are|will be|has been|have been|can be)\s+(publicly |freely |also |made )?(available|released|open[- ]?sourced|found|accessed|seen|viewed)\b`,
  String.raw`\b(our|we|this (paper|work|project))\b[^.]{0,80}\b(release|released|open[- ]?source[sd]?|publish|provide|share)\b[^.]{0,80}$`,
  String.raw`\bavailable\s+(at|on|from|under|via)\s*:?\s*$`,
  String.raw`\b(visit|see)\b[^.]{0,40}\b(project page|website|homepage)\b`,
].join('|'), 'i');

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const segsOf = (url) => { try { return new URL(url).pathname.split('/').filter(Boolean); } catch { return []; } };
// the same link written twice (www., a trailing "/", ".git", case of host and path)
const sameKey = (url) => hostOf(url) + '/' + segsOf(url).join('/').toLowerCase().replace(/\.git$/, '');
// the repository a link is in: github.com/<owner>/<repo>/blob/main/README.md -> github.com/<owner>/<repo>
const repoKey = (url) => (/^(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)$/.test(hostOf(url)) && segsOf(url).length > 2 ? hostOf(url) + '/' + segsOf(url).slice(0, 2).join('/').toLowerCase().replace(/\.git$/, '') : sameKey(url));

// what a link is, from its host and the words in front of it: 'code' | 'project' | 'video' | 'dataset' | 'arxiv' |
// 'doi' | 'link' (some other page) | 'skip'
function classify(url, ctx = '') {
  const h = hostOf(url), segs = segsOf(url);
  if (!h || PLACEHOLDER_HOSTS.test(h)) return 'skip';
  if (h === 'arxiv.org' || h === 'export.arxiv.org') return 'arxiv';
  if (h === 'doi.org' || h === 'dx.doi.org') return 'doi';
  if (VIDEO_HOSTS.test(h)) return 'video';
  if (CODE_HOSTS.test(h)) {
    if (h === 'huggingface.co') {
      if (segs[0] === 'papers' || segs[0] === 'docs' || segs[0] === 'blog') return 'skip';
      if (segs[0] === 'datasets') return segs.length >= 3 ? 'dataset' : 'link';
      return (segs[0] === 'spaces' ? segs.length >= 3 : segs.length >= 2) ? 'code' : 'link';
    }
    return segs.length >= 2 ? 'code' : 'link'; // github.com/<owner> alone is a profile, not a repository
  }
  if (SKIP_HOSTS.test(h)) return 'skip';
  const c = String(ctx);
  if (PROJECT_HOSTS.test(h)) return KW_DATA.test(c) && !KW_PROJECT.test(c) && !KW_CODE.test(c) && !KW_VIDEO.test(c) ? 'dataset' : 'project';
  if (KW_PROJECT.test(c)) return 'project';
  if (KW_CODE.test(c)) return KW_MORE.test(c) ? 'project' : 'code'; // "code, models and videos at <site>": a project page
  if (KW_DATA.test(c) && !KW_VIDEO.test(c)) return 'dataset';
  return 'project';
}

// the words in front of a link: from the end of the link before it (or 160 characters back), on its paragraph
function contextOf(text, list, k) {
  const from = Math.max(k > 0 ? list[k - 1].end : 0, list[k].index - 160);
  let ctx = text.slice(from, list[k].index);
  const para = ctx.lastIndexOf('\n\n');
  if (para >= 0) ctx = ctx.slice(para + 2);
  return ctx.replace(/\s+/g, ' ');
}

// The links of a paper's own text. pages: the text of each page (pdftotext). own: {arxiv, doi} of the item (a link to
// another arXiv paper or DOI in the text is a citation, not this paper). dropReferences: notes.dropReferences.
// annots: the PDF's hyperlinks [{page, url}] (pdfAnnots) - those of pages 1-2 count: a printed URL that one of its
// page continues ("github.com/x/Action" + "_Reasoning") becomes the annotation, the others are added after the text.
// raw: the `pdftotext -raw` text of each page (restoreHyphens).
// -> [{url, kind, source: 'paper p. N', page, keyword (a word such as "Code:" / "project page" stands near it)}]
function scanPages(pages, { own = {}, dropReferences = (t) => t, annots = [], raw = [] } = {}) {
  const joined = (pages || []).map((t, i) => `[p. ${i + 1}] ${restoreHyphens(joinBroken(String(t || '').replace(/\r/g, '')), raw && raw[i])}`).join('\n\n');
  const body = dropReferences(joined);
  const parts = [];
  const re = /\[p\. (\d+)\] ?/g;
  let m, last = null;
  while ((m = re.exec(body))) {
    if (last) parts.push({ page: last.page, text: body.slice(last.at, m.index) });
    last = { page: Number(m[1]), at: m.index + m[0].length };
  }
  if (last) parts.push({ page: last.page, text: body.slice(last.at) });
  const out = [], seen = new Set(), keys = new Set();
  const linked = new Map(); // page -> the clean URLs of its hyperlinks (pages 1-2)
  for (const a of annots || []) {
    const url = a && Number(a.page) >= 1 && Number(a.page) <= 2 ? cleanUrl(a.url) : null;
    if (url) (linked.get(Number(a.page)) || linked.set(Number(a.page), []).get(Number(a.page))).push(url);
  }
  const own_ = (url) => { const r = refs.parseRef(url); return !!(r && r.kind === 'arxiv' && own.arxiv && r.id.toLowerCase().replace(/v\d+$/, '') === String(own.arxiv).toLowerCase().replace(/v\d+$/, '')); };
  for (const { page, text } of parts) {
    const list = findUrls(text);
    for (const u of list) { // the printed URL was cut where the hyperlink goes on ("_Reasoning", "-page"): take the hyperlink
      const mine = linked.get(page) || [];
      const longer = mine.find((a) => a.length > u.url.length && a.toLowerCase().startsWith(u.url.toLowerCase()) && !/^[/?#]/.test(a.slice(u.url.length)))
        || mine.find((a) => a.length > u.url.length && dehy(a) === dehy(u.url)); // the hyphen pdftotext dropped ("projectinstinct")
      if (longer) u.url = longer;
    }
    list.forEach((u, k) => {
      const ctx = contextOf(text, list, k);
      let kind = classify(u.url, ctx);
      if (kind === 'skip' || kind === 'doi') return;
      if (kind === 'arxiv' && !own_(u.url)) return; // only this paper's own arXiv page
      const near = KW_NEAR.test(ctx) || KW_CODE.test(ctx) || KW_PROJECT.test(ctx);
      if (page > 2) { // the body after page 2: only a link the authors announce ("our code is available at ...")
        if (!ANNOUNCE.test(ctx)) return;
      } else if (page === 2 && kind === 'project' && !near && !PROJECT_HOSTS.test(hostOf(u.url))) kind = 'link'; // a footnote to a product page
      const key = kind + ' ' + sameKey(u.url);
      if (seen.has(key)) return;
      seen.add(key); keys.add(sameKey(u.url));
      out.push({ url: u.url, kind, source: `paper p. ${page}`, page, keyword: near });
    });
  }
  // the hyperlinks of pages 1-2 the text does not print ("available on the project website and GitHub repository")
  for (const page of [...linked.keys()].sort((a, b) => a - b)) {
    for (const url of linked.get(page)) {
      let kind = classify(url, '');
      if (kind === 'skip' || kind === 'doi' || (kind === 'arxiv' && !own_(url))) continue;
      if (page === 2 && kind === 'project' && !PROJECT_HOSTS.test(hostOf(url))) kind = 'link';
      if (keys.has(sameKey(url))) continue;
      keys.add(sameKey(url));
      out.push({ url, kind, source: `paper p. ${page} (link)`, page, keyword: false });
    }
  }
  return out;
}

// the PDF's hyperlinks (URI link annotations) of pages 1-2: `pdfinfo -url` (poppler, like pdftotext) -> [{page, url}];
// [] when pdfinfo is missing or fails (the text scan still runs)
async function pdfAnnots(file) {
  const r = await core.run('pdfinfo', ['-url', '-f', '1', '-l', '2', file], { timeout: 30000 });
  if (r.code !== 0) return [];
  const out = [];
  for (const line of core.plat.lines(r.out)) {
    const m = /^\s*(\d+)\s+\S+\s+(https?:\/\/\S+)\s*$/i.exec(line);
    if (m && out.length < 200) out.push({ page: Number(m[1]), url: m[2].slice(0, 400) });
  }
  return out;
}

// `pdftotext -raw` of a PDF -> the text of each page, with the hyphens of line-broken URLs (restoreHyphens); [] on failure
async function rawPages(file) {
  const r = await core.run('pdftotext', ['-raw', '-enc', 'UTF-8', file, '-'], { timeout: 120000 });
  return r.code === 0 ? core.plat.lf(r.out).split('\f') : [];
}

// links in the arXiv comment ("Project page: https://...", "Code and videos: github.com/x/y") -> [{url, kind, source}]
function scanComment(comment, source = 'arXiv comment') {
  const text = String(comment || ''), list = findUrls(text), out = [];
  list.forEach((u, k) => {
    const kind = classify(u.url, contextOf(text, list, k));
    if (kind === 'skip' || kind === 'arxiv' || kind === 'doi') return;
    out.push({ url: u.url, kind, source, keyword: true });
  });
  return out;
}

// the BibTeX fields -> {arxiv, doi, publisher, extra [{url, kind, source}]}
function fromFields(item) {
  const f = (item && item.fields) || {};
  const id = related.identOf(item) || {};
  const arxiv = id.arxiv || '';
  const out = { arxivId: arxiv, arxiv: arxiv ? 'https://arxiv.org/abs/' + arxiv : null, doi: id.doi ? 'https://doi.org/' + id.doi : null, publisher: null, extra: [] };
  for (const name of ['url', 'howpublished', 'note']) {
    if (typeof f[name] !== 'string') continue;
    for (const u of findUrls(f[name])) {
      const kind = classify(u.url, name === 'url' ? '' : f[name]);
      if (kind === 'arxiv' || kind === 'doi') continue; // identOf already read them
      if (kind === 'code' || kind === 'video' || kind === 'dataset') out.extra.push({ url: u.url, kind, source: 'BibTeX ' + name });
      else if (!out.publisher) out.publisher = { url: u.url, source: 'BibTeX ' + name };
    }
  }
  return out;
}

// Put the sources together: the paper first, then the arXiv comment, the project page, Hugging Face, the BibTeX
// fields. The project page: the paper's own (one it announces with "project page" / "website" first) among those that
// answer - a dead one only when no other answers; a different one of another source goes to `other`. Code: every
// repository, the ones the paper names first, the same repository of two sources once (with `also`); a repository
// only Hugging Face names gets `unconfirmed: true` (unless its owner is the account of the authors' own <owner>.github.io
// page) and goes after the confirmed ones - the package leaves it out. `page`: fromPage of the authors' project page
// (code it presents; its Hugging Face models / data go to `other`). `reach` {url: {dead, error}} marks dead links; a
// project page / repository whose host does not exist (ENOTFOUND) goes to `other` with `gone: true`.
function merge({ fields = {}, paper = [], comment = [], page = [], hf = [], reach = {} } = {}) {
  const all = [...paper, ...comment, ...page, ...hf, ...(fields.extra || [])];
  const isDead = (x) => !!(reach[x.url] && reach[x.url].dead);
  const mark = (x) => (isDead(x) ? { ...x, dead: true } : x);
  const gone = (x) => !!(reach[x.url] && reach[x.url].dead && reach[x.url].error === 'ENOTFOUND');
  const projects = all.filter((x) => x.kind === 'project' && !gone(x));
  const best = (list) => list.find((x) => x.keyword && /^paper/.test(x.source)) || list.find((x) => /^paper/.test(x.source)) || list[0] || null;
  const project = best(projects.filter((x) => !isDead(x))) || best(projects);
  const code = [], byKey = new Map();
  for (const x of all.filter((y) => y.kind === 'code' && !gone(y))) {
    const k = repoKey(x.url);
    if (byKey.has(k)) {
      const c = byKey.get(k);
      if (c.source !== x.source && !(c.also || []).includes(x.source)) (c.also = c.also || []).push(x.source);
      if (sameKey(x.url) === k && sameKey(c.url) !== k) c.url = x.url; // the repository itself rather than a file in it
      continue;
    }
    const c = { url: x.url, source: x.source };
    byKey.set(k, c); code.push(c);
  }
  // the GitHub accounts of the authors' own project pages: "aetherlabsai" of aetherlabsai.github.io/CausalWM
  const owners = new Set();
  for (const x of projects) if (x.source !== 'Hugging Face' && /\.github\.io$/.test(hostOf(x.url))) owners.add(hostOf(x.url).split('.')[0]);
  for (const c of code) if (c.source === 'Hugging Face' && !(c.also || []).length && !(hostOf(c.url) === 'github.com' && owners.has(String(segsOf(c.url)[0] || '').toLowerCase()))) c.unconfirmed = true;
  code.sort((a, b) => (a.unconfirmed ? 1 : 0) - (b.unconfirmed ? 1 : 0)); // stable: the paper's order otherwise
  const other = [], seen = new Set(project ? [sameKey(project.url)] : []);
  for (const x of all) {
    if ((x.kind === 'code' && !gone(x)) || x.kind === 'arxiv' || x === project) continue;
    const k = sameKey(x.url);
    if (seen.has(k) || byKey.has(k) || (x.kind === 'code' && byKey.has(repoKey(x.url)))) continue;
    seen.add(k);
    other.push(gone(x) ? { url: x.url, source: x.source, kind: x.kind, gone: true } : { url: x.url, source: x.source, kind: x.kind === 'project' ? 'link' : x.kind });
  }
  const proj = project ? { url: project.url, source: project.source } : null;
  if (proj) for (const x of projects) if (x !== project && sameKey(x.url) === sameKey(proj.url) && x.source !== proj.source && !(proj.also || []).includes(x.source)) (proj.also = proj.also || []).push(x.source);
  return { arxiv: fields.arxiv || null, doi: fields.doi || null, publisher: fields.publisher ? fields.publisher.url : null, publisherSource: fields.publisher ? fields.publisher.source : null,
    project: proj ? mark(proj) : null, code: code.map(mark), other: other.map(mark) };
}

// the Hugging Face papers API answer -> candidates (merge marks a repository no author source names `unconfirmed`)
function fromHF(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;
  for (const [k, kind] of [['githubRepo', 'code'], ['projectPage', 'project']]) {
    const url = typeof j[k] === 'string' ? cleanUrl(j[k]) : null;
    if (url) out.push({ url, kind: kind === 'code' && classify(url) !== 'code' ? classify(url, 'code') : kind, source: 'Hugging Face', keyword: true });
  }
  return out;
}

// ---------------------------------------------------------------- the authors' project page (pure)
// The code a project page presents as its own: the GitHub / GitLab / Hugging Face links of the page, each with what
// its anchor says. pageAnchors keeps (and the cache stores) only links to code hosts, outside the page's <footer>
// (the template credit) and outside sections such as "Related work", "Baselines", "BibTeX", "Acknowledgements".
const OFF_SECTION = /\b(related (works?|projects|links|papers)|concurrent works?|prior works?|previous works?|other works|more works|follow[- ]?up( works?)?|also check|check out|baselines?|acknowledge?ments?|bibtex|citations?|cite|references|news|updates)\b/i;
const CUE_CODE = /\b(code|codes|github|gitlab|repository|repo|source|implementation)\b/i;
const CUE_SAYS = /\b(code|codes|repository|repo)\b/i; // the anchor itself (its words, title, aria-label) says code
const CUE_HF = /\b(models?|weights|checkpoints?|data ?sets?|data|demo|space|spaces|hugging ?face|hf|collection)\b|\u{1F917}/iu;
const TEMPLATE_REPO = /^(nerfies\/nerfies\.github\.io|[^/]+\/(academic-)?project-?page-?template|[^/]+\/[^/]*\.github\.io)$/i; // a site template / a page's own source
const GH_RESERVED = /^(orgs|features|sponsors|topics|about|login|join|marketplace|apps|collections|settings|site|pricing|enterprise|explore|trending|search)$/i;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const unEnt = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => (ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : e[0] === '#' ? (() => { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); try { return String.fromCodePoint(n); } catch { return ' '; } })() : m));
const attrsOf = (tag) => {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) if (!(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = unEnt(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
};
// a link through a redirector (Google Sites: "https://www.google.com/url?q=https%3A%2F%2Fgithub.com%2F...") -> its target
function unwrap(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url') { const q = u.searchParams.get('q') || u.searchParams.get('url'); if (q && /^https?:\/\//i.test(q)) return cleanUrl(q); }
  } catch { /* as it is */ }
  return url;
}
// the HTML of a page -> [{url, text, cue (its words or an icon / class near it say code / github / ...), says (the
// anchor's own words say code / repository), hf (they say model / data / demo / Hugging Face)}]
function pageAnchors(html, base) {
  let h = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const b = /<base\b[^>]*>/i.exec(h);
  if (b && attrsOf(b[0]).href) { try { base = new URL(attrsOf(b[0]).href, base).href; } catch { /* keep */ } }
  const heads = [...h.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((m) => ({ at: m.index, off: OFF_SECTION.test(unEnt(m[2].replace(/<[^>]*>/g, ' '))) }));
  const feet = [...h.matchAll(/<footer\b[\s\S]*?(<\/footer\s*>|$)/gi)].map((m) => [m.index, m.index + m[0].length]);
  const out = [], seen = new Set();
  for (const m of h.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (out.length >= 300) break;
    if (feet.some(([a, z]) => m.index >= a && m.index < z)) continue;
    let head = null;
    for (const x of heads) { if (x.at < m.index) head = x; else break; }
    if (head && head.off) continue;
    const at = attrsOf(m[1]);
    let url = null;
    try { url = at.href && !/^\s*(javascript|mailto|data):/i.test(at.href) ? cleanUrl(new URL(at.href.trim(), base).href) : null; } catch { url = null; }
    if (url) url = unwrap(url);
    if (!url || !CODE_HOSTS.test(hostOf(url))) continue;
    const inner = m[2], text = unEnt(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const before = h.slice(Math.max(0, m.index - 160), m.index), near = before.slice(before.lastIndexOf('</a') + 1); // an icon just before the link
    const icons = [...(inner + ' ' + near).matchAll(/\b(?:class|alt|src|title|aria-label|data-icon)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((x) => x[1] ?? x[2]).join(' ');
    const own = [text, at.title || '', at['aria-label'] || ''].join(' ');
    const words = [own, at.class || '', icons].join(' ').replace(/[-_/.]/g, ' ');
    const key = url + '|' + own;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, text: text.slice(0, 120), cue: CUE_CODE.test(words), says: CUE_SAYS.test(own.replace(/[-_]/g, ' ')), hf: CUE_HF.test(words) });
  }
  return out;
}
// the short name and the words of a title: "FoAR: Force-Aware Reactive Policy ..." -> {names: ['foar'], words}
const normName = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
function titleNames(title) {
  const t = String(title || '').replace(/[{}\\$]/g, '');
  const names = new Set(), words = new Set();
  const head = /^\s*([^:—–]{2,40}?)\s*[:—–]\s/.exec(t);
  if (head && head[1].trim().split(/\s+/).length <= 3) names.add(normName(head[1]));
  for (const w of t.split(/[^\p{L}\p{N}*π-]+/u)) {
    if (!w) continue;
    const n = normName(w);
    if (n.length >= 3 && (/[A-Z].*[A-Z]/.test(w.slice(1)) || /^[A-Z]{2,}/.test(w) || /[a-z][A-Z]/.test(w))) names.add(n); // FoAR, CogACT, ObjSplat
    for (const p of w.split('-')) if (normName(p).length >= 3) words.add(normName(p));
  }
  return { names: [...names].filter((n) => n.length >= 3), words };
}
// a repository name that is the paper's short name or made of its title words ("gaussian-splatting")
function nameMatches(name, title) {
  const n = normName(name), { names, words } = titleNames(title);
  if (!n) return false;
  if (names.some((a) => n === a || (a.length >= 4 && n.includes(a)))) return true;
  const toks = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map(normName).filter((x) => x.length >= 3);
  return toks.length >= 2 && toks.every((x) => words.has(x));
}
// the anchors of the authors' project page (pageAnchors) -> [{url, kind: 'code' | 'model' | 'dataset' | 'demo', source:
// 'project page'}]: a GitHub / GitLab repository whose anchor says code / github / repository (or whose name is the
// paper's short name / title words); a Hugging Face model / dataset / Space the same way (kind model / dataset / demo:
// not code). Left out: a site template, a page's own source repository (<user>/<user>.github.io), and a repository
// named like the page's own path (<user>.github.io/<repo> is served from <user>/<repo>) unless its anchor says code.
// a link into a repository (a file, a folder, a branch) -> the repository itself: https://github.com/<owner>/<repo>
function repoRoot(url) {
  const h = hostOf(url), segs = segsOf(url);
  if ((h === 'github.com' || h === 'gitlab.com') && segs.length > 2) return `https://${h}/${segs[0]}/${segs[1].replace(/\.git$/i, '')}`;
  return url;
}
function fromPage(anchors, { project = '', title = '' } = {}) {
  const out = [], keys = new Set(), path0 = (segsOf(project)[0] || '').toLowerCase();
  const pageHost = PROJECT_HOSTS.test(hostOf(project));
  for (const a of anchors || []) {
    const h = hostOf(a.url), segs = segsOf(a.url);
    let kind, repo;
    if (h === 'huggingface.co') {
      if (segs[0] === 'datasets' && segs.length >= 3) { kind = 'dataset'; repo = segs.slice(1, 3); }
      else if (segs[0] === 'spaces' && segs.length >= 3) { kind = 'demo'; repo = segs.slice(1, 3); }
      else if (segs[0] === 'collections' && segs.length >= 3) { kind = 'model'; repo = segs.slice(1, 3); }
      else if (segs.length >= 2 && !/^(papers|docs|blog|datasets|spaces|collections|models|organizations|login|join|pricing)$/.test(segs[0])) { kind = 'model'; repo = segs.slice(0, 2); }
      else continue;
      if (!(a.cue || a.hf || nameMatches(repo[1].replace(/-[0-9a-f]{16,}$/, ''), title))) continue;
    } else {
      if (segs.length < 2 || GH_RESERVED.test(segs[0])) continue;
      repo = segs.slice(0, 2);
      const full = repo.join('/').replace(/\.git$/i, '');
      if (TEMPLATE_REPO.test(full)) continue;
      if (pageHost && path0 && repo[1].toLowerCase().replace(/\.git$/, '') === path0 && !a.says) continue; // perhaps only the page's source
      if (!(a.cue || nameMatches(repo[1], title))) continue;
      kind = 'code';
    }
    const k = sameKey(a.url);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push({ url: a.url, kind, source: 'project page', keyword: true, named: kind === 'code' && nameMatches(repo[1], title), repo: normName(repo[1]) });
    if (out.length >= 8) break;
  }
  // the repository named like the paper first; one named like it but for another version ("TWIST" on the page of
  // TWIST2, whose own "amazon-far/TWIST2" is there too) is the other paper's
  const { names } = titleNames(title), mine = new Set(out.filter((x) => x.named).map((x) => x.repo));
  const ver = (n) => n.replace(/(v?\d+(\.\d+)?)$/, '');
  const theirs = (x) => x.kind === 'code' && !x.named && names.some((a) => mine.has(a) && a !== x.repo && ver(a) === ver(x.repo));
  // when the page links a repository named like the paper, that is its code: the other repositories the page shows
  // (companion benchmarks, tools of the same lab - V-JEPA 2 lists IntPhys2, CausalVQA ...) stay out of the code
  // they are kept as related repositories (kind 'repo', listed with the other links)
  const anyNamed = out.some((x) => x.kind === 'code' && x.named);
  return out.filter((x) => !theirs(x)).map((x) => (anyNamed && x.kind === 'code' && !x.named ? { ...x, kind: 'repo' } : x))
    .sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0))
    .map(({ named, repo, ...x }) => (x.kind === 'code' || x.kind === 'repo' ? { ...x, url: repoRoot(x.url) } : x))
    .filter((x, i, all) => all.findIndex((y) => sameKey(y.url) === sameKey(x.url)) === i); // a deep link and its repo: once
}

// ---------------------------------------------------------------- the cache and the network
const cacheFile = (id) => path.join(DIR, id + '.json');
const fieldsSig = (item) => core.sha1(Buffer.from(JSON.stringify(['url', 'doi', 'eprint', 'howpublished', 'note', 'archiveprefix'].map((k) => (item.fields || {})[k] || '')))).slice(0, 16);
const keyOf = (item) => `${(item.pdf && textcache.keyOf(item.id)) || 'nopdf'}|${fieldsSig(item)}`;
function readCache(item) {
  const c = core.readJSON(cacheFile(item.id), null);
  if (c && typeof c === 'object' && c.v === 2) return { ...c, v: VERSION, key: null, paper: null }; // scan the text again, keep the answers
  return c && c.v === VERSION && typeof c === 'object' ? c : null;
}
function writeCache(item, c) {
  try { fs.mkdirSync(DIR, { recursive: true }); core.writeJSON(cacheFile(item.id), c); } catch (e) { console.error('links cache:', e.message); }
}

// the scan of the paper's text, cached with the PDF key
async function paperScan(item, own, cache) {
  const key = keyOf(item);
  if (cache && cache.key === key && Array.isArray(cache.paper)) return cache.paper;
  let pages = [], annots = [], raw = [];
  if (item.pdf) {
    const file = path.join(core.DIRS.pdfs, item.id + '.pdf');
    try { pages = await textcache.pages(item.id); } catch { pages = []; }
    try { annots = await pdfAnnots(file); } catch { annots = []; }
    try { raw = await rawPages(file); } catch { raw = []; }
  }
  return scanPages(pages, { own, annots, raw, dropReferences: require('./notes').dropReferences }); // lazy: notes.js requires this module
}

// the verified publisher record of lib/venues.js -> its doi.org link ({url, source}) | null
function venueLink(item) {
  try {
    const venues = require('./venues');
    const rec = venues.clean((core.readJSON(venues.FILE, { items: {} }).items || {})[item.id]);
    if (!rec || rec.status !== 'published' || rec.fieldsKey !== venues.fieldsKey(item)) return null;
    const s = rec.sources.find((x) => x.url && /^https:\/\/doi\.org\/10\./.test(x.url) && !/10\.48550\//i.test(x.url));
    return s ? { url: s.url, source: s.name + ' (venue check)' } : null;
  } catch { return null; }
}

// a public address only (a link in a PDF must not make the app knock on a device of the local network)
async function publicHost(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (!refs.publicHttps('https://' + u.host + '/')) return false;
  try { const a = await dns.lookup(u.hostname, { all: true }); return !a.some((x) => refs.localAddress(x.address)); } catch { return true; }
}
// HEAD (GET without reading the body when HEAD is refused), 8 s -> {dead, status?, error?, at}
async function reach(url) {
  const at = new Date().toISOString();
  if (!(await publicHost(url))) return { dead: false, error: 'not checked', at };
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(8000) });
    if ([400, 403, 405, 429, 501].includes(r.status)) {
      r = await fetch(url, { method: 'GET', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(8000) });
      if (r.body) r.body.cancel().catch(() => {});
    }
    return { dead: r.status === 404 || r.status === 410, status: r.status, at };
  } catch (e) { return failed(e, at); }
}
// a request that got no answer -> the reach record: an unknown host is dead, unless there is no DNS at all (offline:
// ask for a host the app talks to anyway)
async function failed(e, at) {
  const code = (e && e.cause && e.cause.code) || (e && e.name) || 'error';
  if (code === 'ENOTFOUND' && !(await dns.lookup('arxiv.org').then(() => true, () => false))) return { dead: false, error: 'offline', at };
  return { dead: code === 'ENOTFOUND', error: String(code).slice(0, 40), at };
}

// The authors' project page, read once: GET (8 s, at most 2 MB, HTML only, every redirect to a public host only) ->
// {reach (as reach() gives it - the GET also tells whether the page answers), page {for, at, status, anchors
// (pageAnchors), error}}. Only the page's code-host links are kept, never the page.
const PAGE_MAX = 2 * 1024 * 1024, PAGE_V = 1; // PAGE_V: what pageAnchors keeps (a page read by an older one is read again)
async function fetchPage(url) {
  const at = new Date().toISOString(), page = (x) => ({ v: PAGE_V, for: url, at, anchors: [], ...x });
  const signal = AbortSignal.timeout(8000);
  let u = url;
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (!/^https?:\/\//i.test(u) || !(await publicHost(u))) return { reach: { dead: false, error: 'not checked', at }, page: page({ error: 'not a public address' }) };
      const r = await fetch(u, { method: 'GET', redirect: 'manual', headers: { ...UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' }, signal });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        if (r.body) r.body.cancel().catch(() => {});
        u = new URL(r.headers.get('location'), u).href;
        continue;
      }
      const reachRec = { dead: r.status === 404 || r.status === 410, status: r.status, at };
      const type = String(r.headers.get('content-type') || '');
      if (!r.ok || !/text\/html|application\/xhtml/i.test(type)) {
        if (r.body) r.body.cancel().catch(() => {});
        return { reach: reachRec, page: page({ status: r.status, error: r.ok ? 'not HTML' : 'HTTP ' + r.status }) };
      }
      const chunks = [];
      let size = 0;
      for await (const c of r.body) {
        chunks.push(c); size += c.length;
        if (size >= PAGE_MAX) break; // the start of a large page (the links of a project page are near its top)
      }
      const html = Buffer.concat(chunks).subarray(0, PAGE_MAX).toString('utf8');
      const anchors = pageAnchors(html, u);
      // a page that only moved ("<meta http-equiv=refresh content='0; url=/projects/TWIST2/'>", GitHub Pages redirects)
      const meta = !anchors.length && /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/i.exec(html);
      const to = meta && /url\s*=\s*['"]?([^'">\s]+)/i.exec(attrsOf(meta[0]).content || '');
      if (to) { try { u = new URL(unEnt(to[1]), u).href; continue; } catch { /* no target */ } }
      return { reach: reachRec, page: page({ status: r.status, anchors }) };
    }
    return { reach: { dead: false, error: 'redirects', at }, page: page({ error: 'too many redirects' }) };
  } catch (e) {
    return { reach: await failed(e, at), page: page({ error: String((e && e.cause && e.cause.code) || (e && e.name) || 'error').slice(0, 40) }) };
  }
}

// arXiv comment + Hugging Face for an arXiv id -> {at, for, comment, hf, errors}
async function askNet(arxivId) {
  const out = { at: new Date().toISOString(), for: arxivId, comment: null, hf: null, errors: [] };
  await Promise.all([
    refs.arxivMeta(arxivId).then((m) => { out.comment = m ? String(m.comment || '') : ''; }).catch((e) => { out.errors.push('arXiv: ' + String(e.message).slice(0, 200)); }),
    related.getJson('Hugging Face', turnHF, 'https://huggingface.co/api/papers/' + encodeURIComponent(arxivId))
      .then((j) => { out.hf = j && typeof j === 'object' ? { githubRepo: typeof j.githubRepo === 'string' ? j.githubRepo.slice(0, 400) : '', projectPage: typeof j.projectPage === 'string' ? j.projectPage.slice(0, 400) : '' } : {}; })
      .catch((e) => { out.errors.push(String(e.message).slice(0, 200)); }),
  ]);
  return out;
}

const running = new Map(); // item id -> Promise of the network lookup still on its way (also after its budget ran out)

// The links of a library item. network: also ask arXiv / Hugging Face (once a month, an hour after a failure; force:
// now) and check that the project / code links answer, within `budget` ms - what arrives later is cached for the next
// call. -> the result described at the top of this file
async function links(item, { network = false, budget = 10000, force = false, check = true } = {}) {
  const fields = fromFields(item);
  const verified = venueLink(item); // the DOI of the published version, as the venue check verified it
  if (!fields.publisher && verified) fields.publisher = verified;
  if (!fields.doi && verified) fields.doi = verified.url;
  let cache = readCache(item);
  const key = keyOf(item);
  const paper = await paperScan(item, { arxiv: fields.arxivId }, cache);
  let changed = false;
  if (!cache || cache.key !== key) { cache = { v: VERSION, key, paper, net: cache && cache.net, reach: (cache && cache.reach) || {}, page: cache && cache.page }; changed = true; }
  if (cache.net && cache.net.for !== fields.arxivId) { cache.net = null; changed = true; } // another arXiv id now
  if (changed) writeCache(item, cache);
  const title = require('./notes').plainTex((item.fields || {}).title || '');
  // the authors' project page as merged without its own links: one an author source names (not Hugging Face alone)
  const pageFor = (m) => (m.project && !m.project.dead && [m.project.source, ...(m.project.also || [])].some((s) => s !== 'Hugging Face') ? m.project.url : null);
  const result = () => {
    const c = readCache(item) || cache, net = c.net && c.net.for === fields.arxivId ? c.net : null;
    const src = { fields, paper, comment: net ? scanComment(net.comment) : [], hf: net ? fromHF(net.hf) : [], reach: c.reach || {} };
    let m = merge(src);
    const pg = pageFor(m);
    if (pg && c.page && c.page.v === PAGE_V && c.page.for === pg && Array.isArray(c.page.anchors)) m = merge({ ...src, page: fromPage(c.page.anchors, { project: pg, title }) });
    return { pdf: !!(item.pdf && textcache.keyOf(item.id)), ...m, checked: net ? net.at : null, notes: net ? net.errors : [] };
  };
  // every project page candidate (a dead chosen one gives way to the next), the code, the hosts that seemed gone
  const toCheck = () => {
    const c = readCache(item) || cache, net = c.net && c.net.for === fields.arxivId ? c.net : null, now = result();
    const projects = [...paper, ...(net ? scanComment(net.comment) : []), ...(net ? fromHF(net.hf) : [])].filter((x) => x.kind === 'project').map((x) => x.url);
    return { now, urls: [...new Set([...projects.slice(0, 4), ...now.code.map((x) => x.url), ...now.other.filter((o) => o.gone).map((o) => o.url)])] };
  };
  // check the links known now (HEAD; the project page itself is read once with a GET, which also checks it); a
  // dead project page gives way to another, whose page is then read: a few rounds until nothing is left to do
  const checkNow = async () => {
    for (let round = 0; round < 3; round++) {
      const { now, urls } = toCheck(), c0 = readCache(item) || cache;
      const fresh = (r) => r && r.error !== 'offline' && Date.now() - Date.parse(r.at) <= REACH_FRESH_MS && !force;
      const pg = pageFor(now);
      const pageDue = pg && !(c0.page && c0.page.v === PAGE_V && c0.page.for === pg && !force && Date.now() - Date.parse(c0.page.at) <= (c0.page.error ? NET_RETRY_MS : NET_FRESH_MS))
        && !(fresh(c0.reach[pg]) && c0.reach[pg].dead);
      const todo = urls.filter((u) => !(pageDue && u === pg) && !fresh(c0.reach[u]));
      if (!todo.length && !pageDue) return;
      const [got, pageGot] = await Promise.all([Promise.all(todo.map((u) => reach(u).then((r) => [u, r]))), pageDue ? fetchPage(pg) : null]);
      const c = readCache(item) || cache;
      c.reach = { ...(c.reach || {}) };
      for (const [u, r] of got) c.reach[u] = r;
      if (pageGot) { c.reach[pg] = pageGot.reach; c.page = pageGot.page; }
      writeCache(item, c);
      if (force) force = false; // once per call
    }
  };
  if (network) {
    const stale = (n) => !n || force || Date.now() - Date.parse(n.at) > (n.errors && n.errors.length ? NET_RETRY_MS : NET_FRESH_MS);
    if (!running.has(item.id) && ((fields.arxivId && stale(cache.net)) || check)) {
      const job = (async () => {
        const ask = fields.arxivId && stale(cache.net);
        // the links of the paper are checked while arXiv / Hugging Face answer: their turns (one request every few
        // seconds for all the papers of an export) can take longer than the budget, and a dead link that was never
        // checked would go into the package as if it answered
        await Promise.all([
          ask ? askNet(fields.arxivId).then((net) => { const c = readCache(item) || cache; c.net = net; writeCache(item, c); }) : null,
          check ? checkNow() : null,
        ]);
        if (check) await checkNow(); // what the arXiv comment / Hugging Face / the project page added
      })().catch((e) => console.error('links:', e.message)).finally(() => running.delete(item.id));
      running.set(item.id, job);
    }
    if (running.has(item.id)) await Promise.race([running.get(item.id), sleep(budget)]);
  }
  return result();
}

module.exports = { links, cleanUrl, joinBroken, restoreHyphens, findUrls, classify, scanPages, pdfAnnots, scanComment, fromFields, fromHF, merge, sameKey, pageAnchors, fromPage, nameMatches, fetchPage, DIR };
