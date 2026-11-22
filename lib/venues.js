// Where a paper was published, VERIFIED against the scholarly indexes (the Library's "Venue" grouping and the
// publication-date sort). The record of each item lives in <workspace>/venues.json = { v: 1, items: { [id]: record } },
// never in library.json, and the BibTeX fields of an item are never changed here ("Check metadata" in the reader
// does that).
// Sent out: the paper's DOI / arXiv id (Crossref, OpenAlex, Semantic Scholar, arXiv), the published version's DOI the
// authors gave arXiv (Crossref), and its TITLE (DBLP, the Crossref title search with the first author's surname, and
// the OpenAlex / Semantic Scholar title search when an id gives no answer) - nothing else of the library. One request at
// a time per service, through the rate-limited helpers of lib/related.js and lib/refs.js; one paper after the other.
// PMLR (proceedings.mlr.press) is not asked anything about the paper: its public index and volume pages are fetched
// (cached in <workspace>/cache/pmlr/) and searched here.
// Everything that comes back is untrusted text: it is cut to plain short strings, links are built here.
//
// A record: { status 'published' | 'preprint' | 'unverified', venue, short, kind 'conference' | 'journal' | 'workshop'
// | 'preprint' | null, year, date ('YYYY-MM-DD' | 'YYYY-MM' | 'YYYY': the first public date - arXiv v1, else the
// publication date), publisher, sources [{name, venue, year, url}], claim, why, error?, missed?, lastError? + lastTry?
// (a later check that could not finish; the record itself is the earlier completed answer), checked, fieldsKey }
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core');
const refs = require('./refs');
const rel = require('./related');
const { normTitle } = require('./bibtex');

const FILE = path.join(core.WS, 'venues.json');
const FRESH_MS = 30 * 24 * 3600 * 1000;
const str = rel.str;

// ---------- venue names: canonical short names through a small alias table ----------
// [short, full name, kind, publisher, pattern on the normalised name]. Order matters: the first match wins (CVPR and
// WACV before ICCV, whose long name is part of theirs). A pattern only counts when the rest of the name is framing
// (see aliasOf): "International Conference on Machine Learning and Applications" is not ICML, "AAAI Spring
// Symposium" is not AAAI. ISO-4 abbreviations ("IEEE Robot. Autom. Lett.") are part of the patterns.
const ALIASES = [
  ['CoRL', 'Conference on Robot Learning', 'conference', 'PMLR', /\bcorl\b|conf(erence)? (on )?robot learn(ing)?\b/],
  ['RSS', 'Robotics: Science and Systems', 'conference', 'Robotics: Science and Systems Foundation', /\brss\b|robotics science and systems/],
  ['ICRA', 'IEEE International Conference on Robotics and Automation', 'conference', 'IEEE', /\bicra\b|international conference on robotics and automation/],
  ['IROS', 'IEEE/RSJ International Conference on Intelligent Robots and Systems', 'conference', 'IEEE', /\biros\b|intelligent robots and systems/],
  ['Humanoids', 'IEEE-RAS International Conference on Humanoid Robots', 'conference', 'IEEE', /\bhumanoids\b|conference on humanoid robots/],
  ['CVPR', 'IEEE/CVF Conference on Computer Vision and Pattern Recognition', 'conference', 'IEEE', /\bcvpr\b|computer vision and pattern recognition/],
  ['WACV', 'IEEE/CVF Winter Conference on Applications of Computer Vision', 'conference', 'IEEE', /\bwacv\b|winter conference on applications of computer vision/],
  ['ICCV', 'IEEE/CVF International Conference on Computer Vision', 'conference', 'IEEE', /\biccv\b|international conference on computer vision/],
  ['ECCV', 'European Conference on Computer Vision', 'conference', 'Springer', /(computer vision )?\beccv\b|european conference on computer vision/],
  ['3DV', 'International Conference on 3D Vision', 'conference', 'IEEE', /\b3dv\b|international conference on 3d vision/],
  ['NeurIPS', 'Conference on Neural Information Processing Systems', 'conference', 'NeurIPS', /\bneurips\b|\bnips\b|neural information processing systems|adv(ances)? (in )?neural inf(ormation)? process(ing)? syst(ems)?\b/],
  ['ICML', 'International Conference on Machine Learning', 'conference', 'PMLR', /\bicml\b|international conference on machine learning/],
  // more conferences PMLR publishes (see the PMLR check below)
  ['AISTATS', 'International Conference on Artificial Intelligence and Statistics', 'conference', 'PMLR', /\baistats\b|artificial intelligence and statistics/],
  ['COLT', 'Conference on Learning Theory', 'conference', 'PMLR', /\bcolt\b|conference on learning theory/],
  ['L4DC', 'Learning for Dynamics and Control Conference', 'conference', 'PMLR', /\bl4dc\b|learning for dynamics and control( conference)?/],
  ['UAI', 'Conference on Uncertainty in Artificial Intelligence', 'conference', 'PMLR', /\buai\b|uncertainty in artificial intelligence/],
  ['CLeaR', 'Conference on Causal Learning and Reasoning', 'conference', 'PMLR', /\bclear\b|causal learning and reasoning/],
  ['MIDL', 'Medical Imaging with Deep Learning', 'conference', 'PMLR', /\bmidl\b|medical imaging with deep learning/],
  ['ACML', 'Asian Conference on Machine Learning', 'conference', 'PMLR', /\bacml\b|asian conference on machine learning/],
  ['ICLR', 'International Conference on Learning Representations', 'conference', 'OpenReview.net', /\biclr\b|international conference on learning representations/],
  ['AAAI', 'AAAI Conference on Artificial Intelligence', 'conference', 'AAAI Press', /\baaai( conference on artificial intelligence)?\b/],
  ['IJCAI', 'International Joint Conference on Artificial Intelligence', 'conference', 'IJCAI', /\bijcai\b|international joint conference on artificial intelligence/],
  ['RA-L', 'IEEE Robotics and Automation Letters', 'journal', 'IEEE', /\bra l\b|\bral\b|robotics and automation letters|robot(ics)? autom(ation)? lett(ers)?\b/],
  ['T-RO', 'IEEE Transactions on Robotics', 'journal', 'IEEE', /\bt ro\b|\btrans(actions)? (on )?robot(ics)?\b/],
  ['T-ASE', 'IEEE Transactions on Automation Science and Engineering', 'journal', 'IEEE', /\bt ase\b|trans(actions)? (on )?autom(ation)? sci(ence)? (and )?eng(ineering)?\b/],
  ['IJRR', 'The International Journal of Robotics Research', 'journal', 'SAGE', /\bijrr\b|international journal of robotics research|int j robot(ics)? res(earch)?\b/],
  ['Science Robotics', 'Science Robotics', 'journal', 'AAAS', /\bsci(ence)? robot(ics)?\b/],
  // the journal only: SIGGRAPH's journal-track papers are listed under ACM TOG by the indexes; a name with "SIGGRAPH"
  // (conference papers, posters, talks, MIG, SCA ...) is a venue of its own and stays outside the table
  ['ACM TOG', 'ACM Transactions on Graphics', 'journal', 'ACM', /\btog\b|transactions on graphics|acm trans graph\b/],
  ['TPAMI', 'IEEE Transactions on Pattern Analysis and Machine Intelligence', 'journal', 'IEEE', /\btpami\b|pattern analysis and machine intelligence|trans pattern anal mach intell\b/],
  ['IJCV', 'International Journal of Computer Vision', 'journal', 'Springer', /\bijcv\b|international journal of computer vision|int j comput vis(ion)?\b/],
  ['TMLR', 'Transactions on Machine Learning Research', 'journal', 'TMLR', /\btmlr\b|transactions on machine learning research|trans mach learn res(earch)?\b/],
  ['JMLR', 'Journal of Machine Learning Research', 'journal', 'JMLR', /\bjmlr\b|journal of machine learning research|j mach learn res(earch)?\b/],
  ['Nature Machine Intelligence', 'Nature Machine Intelligence', 'journal', 'Springer Nature', /\bnat(ure)? mach(ine)? intell(igence)?\b/],
  ['Autonomous Robots', 'Autonomous Robots', 'journal', 'Springer', /^auton(omous)? robots$/],
  ['Science', 'Science', 'journal', 'AAAS', /^science$/],
  ['Nature', 'Nature', 'journal', 'Springer Nature', /^nature$/],
].map(([short, full, kind, publisher, re]) => ({ short, full, kind, publisher, re }));

// a book series or a hosting service is not a venue: "Proceedings of Machine Learning Research" holds CoRL, ICML and
// many more, "Lecture Notes in Computer Science" holds ECCV. Such a name is neither evidence nor a disagreement.
const SERIES = /^(proceedings of machine learning research|pmlr|lecture notes in computer science|lncs|ceur workshop proceedings|communications in computer and information science|advances in intelligent systems and computing|springer proceedings in advanced robotics|openreview( net)?)$/;
// repositories and preprint servers: they show that a paper is online, not where it was accepted
const REPOSITORY = /\b(arxiv|corr|ssrn|zenodo|researchgate|biorxiv|medrxiv|research square|preprints?|hal|figshare|osf|europe pmc|pubmed central|semantic scholar|dblp|papers with code|openreview|techrxiv|engrxiv|repository|eprints?)\b/;

const normVenue = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(19|20)\d{2}\b|\b\d+(st|nd|rd|th)\b|'\d{2}\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
// the alias of a normalised name: its pattern matches, and what is around the match is only framing - before it words
// like "proceedings of the", "IEEE/CVF", "international conference on"; after it a number (volume, edition) or the
// venue's own abbreviation ("... (ICRA)"). Anything else ("... and applications", "... posters") is another venue.
const FRAME = new Set(['proceedings', 'proc', 'of', 'the', 'in', 'ieee', 'cvf', 'rsj', 'ras', 'acm', 'annual', 'international', 'joint', 'conference', 'on', 'advances', 'transactions', 'trans']);
const filler = (w) => /^(\d+|[ivxlc]+)$/.test(w) || w === 'proceedings';
function aliasOf(n) {
  return ALIASES.find((x) => [...n.matchAll(new RegExp(x.re.source, 'g'))].some((m) => {
    const before = n.slice(0, m.index).split(' ').filter(Boolean);
    const after = n.slice(m.index + m[0].length).replace(/^[\p{L}\p{N}]+/u, '').split(' ').filter((w) => w && !filler(w));
    return before.every((w) => FRAME.has(w)) && (!after.length || new RegExp('^(?:' + x.re.source + ')$').test(after.join(' ')));
  }));
}
// -> { name (as given), short, full, kind, publisher, key, known, workshop } | null for no name / a series / a repository
function canon(raw) {
  const name = str(raw, 300);
  const n = normVenue(name);
  if (!n || SERIES.test(n) || REPOSITORY.test(n)) return null;
  // workshops are kept apart from their main conference ("CoRL Workshop" is not "CoRL"): the conference is the part
  // before "workshop" ("CVPR Workshops", "CoRL 2024 Workshop on ...")
  const shop = /\bworkshops?\b/.test(n);
  const a = aliasOf(shop ? n.split(/\bworkshops?\b/)[0].trim() || n : n);
  if (shop) {
    const short = a ? a.short + ' Workshop' : name.slice(0, 80);
    return { name, short, full: name, kind: 'workshop', publisher: null, key: 'w:' + (a ? a.short.toLowerCase() : n), known: !!a, workshop: true };
  }
  if (a) return { name, short: a.short, full: a.full, kind: a.kind, publisher: a.publisher, key: a.short.toLowerCase(), known: true, workshop: false };
  const kind = /\b(conference|proceedings|symposium|congress|meeting)\b/.test(n) ? 'conference' : /\b(journal|transactions|trans|letters|lett|magazine|review)\b/.test(n) ? 'journal' : null;
  return { name, short: name.slice(0, 80), full: name, kind, publisher: null, key: n, known: false, workshop: false };
}
// "IEEE Trans. Autom. Sci. Eng." against "IEEE Transactions on Automation Science and Engineering": every word of the
// abbreviation starts the matching word of the full name (small words left out)
const STOP = new Set(['on', 'of', 'and', 'the', 'for', 'in', 'a', 'an', 'proceedings', 'proc']);
const words = (s) => normVenue(s).split(' ').filter((w) => w && !STOP.has(w));
function abbrevOf(abbr, full) {
  const a = words(abbr), f = words(full);
  return a.length > 1 && a.length === f.length && a.every((w, i) => f[i].startsWith(w)) && a.some((w, i) => w !== f[i]);
}
// two canonical venues are the same venue: the same alias, or (both unknown) the same name / one abbreviates the other
function sameVenue(x, y) {
  if (!x || !y) return false;
  if (x.workshop !== y.workshop) return false;
  if (x.known && y.known) return x.key === y.key;
  // a spelling the table lacks may still abbreviate the known venue's full name
  if (x.known || y.known) { const [k, u] = x.known ? [x, y] : [y, x]; return abbrevOf(u.name, k.full); }
  return x.key === y.key || abbrevOf(x.name, y.name) || abbrevOf(y.name, x.name);
}

// ---------- the decision: evidence -> record (pure; scripts/test-venues.js tests it) ----------
// input: {
//   evidence: [{ source 'Crossref' | 'DBLP' | 'OpenAlex' | 'Semantic Scholar' | 'arXiv', role 'publication' | 'preprint',
//                venue, year, date?, publisher?, kind?, exact? (DBLP: same title AND same first author), url? }],
//   failed: [{ source, message }]   lookups that could not be made (offline, rate limited, broken answer)
//   arxiv: { found, date, comment, journalRef } | null   the arXiv API record of the id (null: no id / not asked)
//   hasDoi, hasArxiv: what the item can be looked up by
// }
// The rules (strict on purpose - the user asked for "everything checked"):
//  1. Crossref record of a real (non-arXiv) DOI = the publisher's own record of the paper: published, as it says.
//     The DOI is the entry's own, or the published version's DOI the authors gave arXiv (<arxiv:doi> / journal_ref)
//     when Crossref's record of it is the same paper by the same first author, or a Crossref title search hit with
//     the EQUAL title, the same first author, a journal / proceedings article and a year within one of arXiv v1
//     (gather / relatedDoiEvidence / titleSearchHits). Crossref records of two different venues: unverified (rule 4).
//     PMLR (CoRL, ICML, AISTATS, COLT ... have no Crossref DOIs) is the publisher's record too: its volume page lists
//     the paper with the EQUAL title and the same first author (whole word) - see pmlrMatch. Its record and Crossref's
//     naming two different venues: unverified.
//  2. Otherwise a venue is verified when at least TWO independent indexes (DBLP, OpenAlex, Semantic Scholar) name the
//     same venue (after the alias table) with years at most one apart (both years known) - OR when DBLP names it with
//     the same title and the same first author: DBLP is curated by hand (venue tables of contents), so one exact DBLP
//     hit is enough. When DBLP has an exact hit, its near-title hits (a journal extension, the other version) are left
//     out. A venue dated more than a year before the paper's first public date (arXiv v1) is another paper with the
//     same title and is not evidence at all.
//  3. One non-curated index alone (OpenAlex or Semantic Scholar), or only the authors' own arXiv comment / journal_ref
//     ("Accepted to CoRL 2025"), is NOT verified: the comment is kept as `claim`, shown but not trusted.
//  4. Indexes that name two different (non-workshop) venues: unverified (they disagree; nothing is guessed), also when
//     arXiv knows the paper.
//  5. A workshop is only used when no main venue is named at all, and is kept as kind 'workshop'.
//  6. Not published but the arXiv API (or DBLP's CoRR) knows the paper: 'preprint'.
//  7. A failed lookup that could have changed the outcome: 'unverified' with `error` (retried next time). A failure that
//     could not have (Semantic Scholar busy while DBLP and OpenAlex both answered "no venue") does not block the result,
//     and none does once the publisher's record verified the venue (rule 1 returns before this rule is looked at).
//     Crossref failing always matters: it is asked by the entry's DOI, the related DOI or the title. PMLR failing
//     matters too: it is only asked when the claim or an index names a PMLR conference and year (a hint which volume).
//  8. An index that refuses automated requests altogether (DBLP behind a browser check, `blocked`) is left out of the
//     decision instead: that only makes the check stricter (without DBLP a venue needs Crossref or two indexes). The
//     record names it in `missed` and is looked up again next time. A paper that is not verified without it is not
//     called a confirmed preprint either (the missing index might have named a venue): it stays 'unverified'.
const yearOf = (v) => { const y = Number(String(v ?? '').slice(0, 4)); return Number.isInteger(y) && y > 1900 && y < 2200 ? y : null; };
// a missing year confirms nothing: both must be known
const closeYears = (a, b) => a.year != null && b.year != null && Math.abs(a.year - b.year) <= 1;
const INDEXES = ['DBLP', 'OpenAlex', 'Semantic Scholar'];
const PUBLISHERS = ['Crossref', 'PMLR']; // the publisher's own record of the paper (rule 1)
const srcOut = (e) => ({ name: e.source, venue: str(e.venue, 200), year: e.year ?? null, url: e.url || '' });
const CLAIM = /\b(accept|appear|publish|present|proceedings|conference|journal|transactions|letters|workshop|camera[- ]ready)/i;

// -> { ok, how, members (the evidence that verifies it: the year and the sources of the record come from these only) }
function verifiedGroup(group) {
  const exact = group.find((e) => e.source === 'DBLP' && e.exact);
  if (exact) return { ok: true, how: 'DBLP (exact title and first author)', members: [exact] };
  const by = INDEXES.filter((s) => group.some((e) => e.source === s));
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j];
    if (a.source !== b.source && INDEXES.includes(a.source) && INDEXES.includes(b.source) && closeYears(a, b)) return { ok: true, how: a.source + ' + ' + b.source, members: [a, b] };
  }
  if (by.length >= 2) return { ok: false, why: `${by.join(' and ')} name ${group[0].c.short}, but not with known years at most one apart` };
  return { ok: false, why: `only ${by[0] || group[0].source} names a venue (${group[0].c.short}${group[0].year ? ' ' + group[0].year : ''}); a second index has to confirm it` };
}
function groupsOf(list) {
  const groups = [];
  for (const e of list) { const g = groups.find((x) => sameVenue(x[0].c, e.c)); if (g) g.push(e); else groups.push([e]); }
  return groups;
}

function decide(input = {}) {
  const failed = Array.isArray(input.failed) ? input.failed : [];
  const blocked = failed.filter((f) => f.blocked);
  const rec = decideCore({ ...input, failed: failed.filter((f) => !f.blocked) });
  if (!blocked.length) return rec;
  const out = { ...rec, missed: [...new Set(blocked.map((f) => f.source))], why: rec.why + ' (Not asked: ' + blocked.map((f) => f.message).join(' ') + ')' };
  // rule 8: a blocked index is named in `missed` and the paper is looked up again next time. A paper arXiv itself
  // confirms stays an arXiv preprint meanwhile (that is verified); the note says which index could not be asked,
  // because it might know a publication the others do not.
  return out;
}
function decideCore({ evidence = [], failed = [], arxiv = null, hasDoi = false, hasArxiv = false } = {}) {
  const ev = evidence.map((e) => ({ ...e, year: yearOf(e.year) }));
  const firstDate = arxiv && arxiv.found && arxiv.date ? arxiv.date : null;
  // a venue more than a year older than the first public date is a different paper with the same title
  const v1 = yearOf(firstDate);
  let pubs = ev.filter((e) => e.role === 'publication' && !(v1 && e.year != null && e.year < v1 - 1)).map((e) => ({ ...e, c: canon(e.venue) })).filter((e) => e.c);
  // an exact DBLP hit stands for DBLP: its near-title hits are left out; one DBLP hit per venue
  if (pubs.some((e) => e.source === 'DBLP' && e.exact)) pubs = pubs.filter((e) => e.source !== 'DBLP' || e.exact);
  pubs = pubs.filter((e, i) => e.source !== 'DBLP' || !pubs.slice(0, i).some((x) => x.source === 'DBLP' && sameVenue(x.c, e.c)));
  const failedNames = failed.map((f) => f.source);
  const claimText = arxiv ? [arxiv.journalRef, arxiv.comment].map((s) => str(s, 300)).find((s) => s && CLAIM.test(s)) || '' : '';

  // a verified venue stands, but without the arXiv answer the first public date is missing: `error` has it looked up again
  const arxivMissed = hasArxiv ? failed.find((f) => f.source === 'arXiv') : null;
  const published = (all, how, members) => {
    // the year is the verifying evidence's; other evidence of the venue is listed only when its year agrees
    const vy = (members.find((e) => e.year != null) || {}).year ?? null;
    const group = all.filter((e) => members.includes(e) || vy == null || e.year == null || Math.abs(e.year - vy) <= 1);
    const best = members.find((e) => e.source === 'Crossref') || members.find((e) => e.source === 'PMLR') || members.find((e) => e.source === 'DBLP') || members[0];
    const c = group.map((e) => e.c).find((x) => x.known) || best.c;
    const full = c.known ? c.full : (group.find((e) => e.source !== 'DBLP') || best).c.full;
    const short = c.known ? c.short : (group.find((e) => e.source === 'DBLP') || best).c.short;
    const year = best.year ?? vy;
    const pubDate = (group.find((e) => e.date) || {}).date || (year ? String(year) : null);
    return {
      status: 'published', venue: full, short, kind: c.kind || (group.find((e) => e.c.kind) || {}).c?.kind || best.kind || (group.find((e) => e.kind) || {}).kind || null, year,
      date: firstDate || pubDate, publisher: (group.find((e) => PUBLISHERS.includes(e.source) && e.publisher) || {}).publisher || c.publisher || (group.find((e) => e.publisher) || {}).publisher || null,
      sources: group.map(srcOut), claim: '', why: 'Verified by ' + how + '.',
      ...(arxivMissed ? { error: arxivMissed.message } : {}),
    };
  };

  // rule 1: the publisher's own record (Crossref, PMLR) - unless such records name two different venues
  let notVerified = '', disagree = false;
  const crGroups = groupsOf(pubs.filter((e) => PUBLISHERS.includes(e.source)));
  if (crGroups.length > 1) {
    const who = [...new Set(crGroups.flat().map((e) => e.source))];
    notVerified = (who.length === 1 ? who[0] + ' has records of this title in more than one venue - ' : 'The publishers\' records (' + who.join(', ') + ') of this title name more than one venue - ')
      + crGroups.map((g) => g[0].c.short + (g[0].year ? ' ' + g[0].year : '')).join('; ') + '.';
    disagree = true;
  } else if (crGroups.length) {
    const crossref = crGroups[0][0];
    const via = crossref.via === 'related' ? ', by the DOI the authors gave arXiv' : crossref.via === 'title' ? ', found by its exact title and first author'
      : crossref.via === 'title-only' ? ', found by its exact title and year; the entry names no author'
      : crossref.via === 'pmlr' ? ', the same title and first author in ' + (str(crossref.vol, 200) || 'its volume') : '';
    const agree = pubs.filter((e) => e !== crossref && sameVenue(e.c, crossref.c) && (crossref.year == null || e.year == null || Math.abs(e.year - crossref.year) <= 1));
    return published([crossref, ...agree], 'the publisher\'s record (' + crossref.source + via + ')' + (agree.length ? ' and ' + [...new Set(agree.map((e) => e.source))].join(', ') : ''), [crossref]);
  }
  // rules 2-5
  const main = pubs.filter((e) => !e.c.workshop), shops = pubs.filter((e) => e.c.workshop);
  if (!disagree) for (const list of [main, shops]) {
    if (!list.length) continue;
    const groups = groupsOf(list);
    if (groups.length > 1) {
      const names = groups.map((g) => `${[...new Set(g.map((e) => e.source))].join(' + ')}: ${g[0].c.short}${g[0].year ? ' ' + g[0].year : ''}`).join('; ');
      const one = new Set(list.map((e) => e.source)).size === 1;
      notVerified = (one ? `${list[0].source} lists this title under more than one venue - ` : 'The indexes disagree - ') + names + '.';
      disagree = true;
      break;
    }
    const v = verifiedGroup(groups[0]);
    if (v.ok) return published(groups[0], v.how, v.members);
    notVerified = v.why.charAt(0).toUpperCase() + v.why.slice(1) + '.';
    break; // a main venue that is not verified is not replaced by a workshop
  }

  // rule 7: would a lookup that failed have been able to verify a venue?
  const pubSources = new Set(pubs.map((e) => e.source));
  const material = failed.filter((f) =>
    f.source === 'Crossref' || f.source === 'DBLP' || f.source === 'PMLR' ||
    ((f.source === 'OpenAlex' || f.source === 'Semantic Scholar') && (pubSources.size > 0 || failedNames.includes(f.source === 'OpenAlex' ? 'Semantic Scholar' : 'OpenAlex'))) ||
    (f.source === 'arXiv' && hasArxiv && !ev.some((e) => e.role === 'preprint')));
  const base = { venue: null, short: null, kind: null, year: null, date: firstDate, publisher: null, sources: [], claim: claimText };
  if (material.length) {
    return { ...base, status: 'unverified', year: yearOf(firstDate), sources: pubs.map(srcOut), why: 'The check could not be finished: ' + material.map((f) => f.message).join(' '), error: material.map((f) => f.message).join(' ') };
  }
  // rule 6: a preprint the arXiv API or DBLP (CoRR) knows - not when the indexes disagree (rule 4), and not when one
  // index names a venue that could not be confirmed: such a paper may well be published, so it is "not verified"
  const pre = ev.filter((e) => e.role === 'preprint');
  if (pre.length && !disagree && !notVerified) {
    const ax = pre.find((e) => e.source === 'arXiv') || pre[0];
    return {
      ...base, status: 'preprint', venue: 'arXiv', short: 'arXiv', kind: 'preprint', year: yearOf(firstDate) ?? ax.year ?? null,
      date: firstDate || (ax.date || (ax.year ? String(ax.year) : null)), publisher: 'arXiv', sources: pre.map(srcOut),
      why: (notVerified ? notVerified + ' ' : 'No index names a venue. ') + 'Confirmed as an arXiv preprint by ' + [...new Set(pre.map((e) => e.source === 'DBLP' ? 'DBLP (CoRR)' : e.source))].join(' and ') + '.',
    };
  }
  return {
    ...base, status: 'unverified', year: yearOf(firstDate),
    sources: pubs.map(srcOut),
    why: notVerified || (hasArxiv && arxiv && !arxiv.found ? 'arXiv has no paper with this id, and no index knows the paper.' : 'No index (Crossref, DBLP, OpenAlex, Semantic Scholar, arXiv) knows this paper.'),
  };
}

// ---------- the lookups ----------
const UA = { 'User-Agent': 'ResearchTool-local/0.1', Accept: 'application/json' };
const turnDBLP = rel.gate(1100), turnCR = rel.gate(1000);
// DBLP answers JSON, or (when its bot wall is up) an HTML "making sure you're not a bot" page: that page is never
// answered or worked around - DBLP is then `blocked` (rule 8) and not asked again for an hour
let dblpBlocked = 0;
const BLOCKED_MSG = 'DBLP asks for a browser check and does not answer the app at the moment.';
async function dblp(q) {
  if (dblpBlocked > Date.now()) throw core.httpErr(503, BLOCKED_MSG, { blocked: true });
  for (let attempt = 0; ; attempt++) {
    await turnDBLP();
    let r;
    try { r = await fetch('https://dblp.org/search/publ/api?format=json&h=5&q=' + encodeURIComponent(q), { headers: UA, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw core.httpErr(502, 'DBLP ' + (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'did not answer in time.' : 'could not be reached (are you online?).'), { offline: true }); }
    const type = String(r.headers.get('content-type') || '');
    if (r.status === 429 && attempt < 1) { if (r.body) r.body.cancel().catch(() => {}); await new Promise((ok) => setTimeout(ok, 3000)); continue; }
    if (r.status === 429) { if (r.body) r.body.cancel().catch(() => {}); throw core.httpErr(503, 'DBLP is taking no more requests for the moment. Try again in a few minutes.', { busy: true }); }
    if (r.status === 404 || r.status === 400) { if (r.body) r.body.cancel().catch(() => {}); return null; }
    if (!r.ok) { if (r.body) r.body.cancel().catch(() => {}); throw core.httpErr(502, `DBLP answered with an error (${r.status}).`); }
    if (!/json/i.test(type)) { if (r.body) r.body.cancel().catch(() => {}); dblpBlocked = Date.now() + 3600 * 1000; throw core.httpErr(503, BLOCKED_MSG, { blocked: true }); }
    try { return await r.json(); } catch { throw core.httpErr(502, 'DBLP sent an answer that could not be read.'); }
  }
}
const crossrefWork = (doi) => rel.getJson('Crossref', turnCR, 'https://api.crossref.org/works/' + rel.doiPath(doi));
// a title (and the first author's surname when the entry has one) - nothing else; the same polite gate and mailto-free User-Agent
const crossrefSearch = (title, surname) => rel.getJson('Crossref', turnCR, 'https://api.crossref.org/works?rows=5&query.bibliographic=' + encodeURIComponent(title) + (surname ? '&query.author=' + encodeURIComponent(surname) : ''));
const letters = (s) => String(s || '').normalize('NFKD').replace(/[^\p{L}]+/gu, '').toLowerCase();
// family name of the first author of a BibTeX author field ("Last, First and ..." or "First Last and ...")
function firstSurname(author) {
  const a = String(author || '').replace(/[{}]/g, '').split(/\s+and\s+/i)[0].trim();
  if (!a) return '';
  return letters(a.includes(',') ? a.split(',')[0] : a.split(/\s+/).pop());
}
// the index's first author is the same person: the family name is the last word(s) of the name it gives ("Ashish
// Kumar 0001" - DBLP's number left out; "Jan van der Berg" for "van der Berg"), whole words, never a part of one
// ("Li" is not in "Oliver Kroemer")
const sameAuthor = (surname, name) => {
  if (!surname || surname.length < 2) return false;
  const w = String(name || '').replace(/\s+\d{4}$/, '').trim().split(/\s+/);
  return w.some((_, i) => letters(w.slice(i).join('')) === surname);
};
// the same paper, for venue evidence found by TITLE: rel.sameWork also accepts a title that contains ours, which lets
// a journal extension ("<our title>: Extended Experiments") pass. Here the titles must be equal, or nearly the same
// words with no subtitle that the other title lacks.
function samePaper(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const sub = (t) => normTitle(String(t).split(':').slice(1).join(' '));
  if ((sub(a) && !y.includes(sub(a))) || (sub(b) && !x.includes(sub(b)))) return false;
  const ws = (t) => new Set(String(t).normalize('NFKD').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((v) => v.length > 1));
  const A = ws(a), B = ws(b);
  let both = 0;
  for (const v of A) if (B.has(v)) both++;
  return both / Math.max(1, A.size + B.size - both) >= 0.6;
}
const datePart = (parts) => {
  const p = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0].map(Number).filter(Number.isFinite) : [];
  if (!p.length || !yearOf(p[0])) return null;
  return [String(p[0]), p[1] && String(p[1]).padStart(2, '0'), p[1] && p[2] && String(p[2]).padStart(2, '0')].filter(Boolean).join('-');
};
const isoDate = (s) => { const m = String(s || '').match(/^(\d{4})(-\d{2})?(-\d{2})?/); return m ? m[0] : null; };
const httpsOf = (u, host) => (typeof u === 'string' && new RegExp('^https://' + host.replace(/\./g, '\\.') + '/[\\w./:%?=&-]*$').test(u) ? u : '');

// one lookup, its failure recorded instead of thrown (a 404 is "not known", not a failure). A service that said "too
// many requests" is not asked again for a few minutes (for every paper of the job), nor one that could not be reached
// for a minute: the job does not keep knocking on a door that is shut.
const busyUntil = {}, busyMsg = {};
const BUSY_MS = 5 * 60 * 1000, OFFLINE_MS = 60 * 1000;
const STOPPED = 'stopped';
// `key`: what the back-off is kept for - a service, or one kind of request of it: OpenAlex's searches cost from a
// small daily allowance, its look-ups by DOI do not, so a spent search allowance must not stop the look-ups.
async function attempt(failed, source, fn, stopped, key = source) {
  if (stopped && stopped()) throw new Error(STOPPED);
  if (busyUntil[key] > Date.now()) { failed.push({ source, message: busyMsg[key] || `${source} was not asked: it asked to wait, or could not be reached, a moment ago.`, busy: true }); return undefined; }
  try { return await fn(); } catch (e) {
    const x = (e && e.extra) || {};
    const busy = !!x.busy || /\bbusy\b|asked to wait/.test(String(e && e.message));
    if (busy || x.offline) {
      busyUntil[key] = Date.now() + (busy ? Math.max(BUSY_MS, (Number(x.retryAfter) || 0) * 1000) : OFFLINE_MS);
      busyMsg[key] = busy && Number(x.retryAfter) >= 3600 ? str(e.message, 300) : null;
    }
    failed.push({ source, message: str((e && e.message) || String(e), 300), ...(x.blocked ? { blocked: true } : {}), ...(busy ? { busy: true } : {}), ...(x.offline ? { offline: true } : {}) });
    return undefined;
  }
}

// ---------- Crossref records -> publication evidence (pure; scripts/test-venues.js tests them) ----------
// a Crossref work (`message`) -> evidence | null. A book chapter lists its series first (["Lecture Notes in Computer
// Science", "Computer Vision – ECCV 2020"]): the first name that is a venue. posted-content = a preprint server's DOI:
// it is not a publication. An RSS proceedings DOI (10.15607/RSS.*) is RSS even when the record names no container.
function crossrefEvidence(m, doi, via) {
  if (!m || typeof m !== 'object') return null;
  const type = str(m.type, 40);
  if (type === 'posted-content') return null;
  const names = [...(Array.isArray(m['container-title']) ? m['container-title'] : []), m.event && m.event.name].map((v) => str(v, 300));
  const container = names.find((v) => v && canon(v)) || (/^10\.15607\/rss\./i.test(doi) ? 'Robotics: Science and Systems' : '');
  if (!container) return null;
  const issued = datePart((m.published && m.published['date-parts']) || (m.issued && m.issued['date-parts']));
  return {
    source: 'Crossref', role: 'publication', venue: container, year: issued, date: issued, publisher: str(m.publisher, 160) || null,
    kind: type === 'journal-article' ? 'journal' : /proceedings|conference/.test(type) ? 'conference' : null, url: 'https://doi.org/' + doi,
    ...(via ? { via } : {}),
  };
}
const crTitle = (m) => str((Array.isArray(m.title) && m.title[0]) || '', 400);
const crFirstAuthor = (m) => {
  const au = Array.isArray(m.author) ? m.author.filter((a) => a && typeof a === 'object') : [];
  const a = au.find((x) => x.sequence === 'first') || au[0];
  return a ? [str(a.given, 100), str(a.family || a.name, 100)].filter(Boolean).join(' ') : '';
};
// the Crossref record of the DOI the authors gave arXiv: it counts only as the same paper (samePaper) by the same
// first author - an author may well give the DOI of a related (other) paper
function relatedDoiEvidence(m, { title, surname, doi }) {
  if (!m || typeof m !== 'object' || !title || !surname) return null;
  if (!samePaper(title, crTitle(m)) || !sameAuthor(surname, crFirstAuthor(m))) return null;
  return crossrefEvidence(m, doi, 'related');
}
// Crossref title search hits -> the accepted evidence (one per venue; more than one = a disagreement, see decide).
// Strict on purpose, a title search finds many look-alikes: the normalised title EQUAL to ours (not just similar), the
// first author's surname as a whole word, a journal or proceedings article (not posted-content, a preprint, a dataset,
// a component, a peer review ...), and - when the paper's year (arXiv v1) is known - a year at most one apart.
// An entry that names no author at all (nothing to compare, which is not a mismatch) is matched only by a long title
// (40+ letters and digits) with its year known and within one: a short or undated title is never enough on its own.
const SEARCH_TYPES = new Set(['journal-article', 'proceedings-article']);
function titleSearchHits(items, { title, surname, year }) {
  const out = [];
  const want = normTitle(title);
  if (!want || !Array.isArray(items) || (!surname && !(want.length >= 40 && yearOf(year)))) return out;
  for (const m of items.slice(0, 5)) {
    if (!m || typeof m !== 'object' || !SEARCH_TYPES.has(str(m.type, 40))) continue;
    if (normTitle(crTitle(m)) !== want || (surname && !sameAuthor(surname, crFirstAuthor(m)))) continue;
    const doi = str(m.DOI, 200);
    if (!/^10\.\d{4,9}\/\S+$/.test(doi) || /^10\.48550\//i.test(doi)) continue;
    const e = crossrefEvidence(m, doi, surname ? 'title' : 'title-only');
    if (!e) continue;
    const y = yearOf(e.year);
    if (yearOf(year) && (y == null || Math.abs(y - yearOf(year)) > 1)) continue;
    if (!out.some((x) => sameVenue(canon(x.venue), canon(e.venue)))) out.push(e);
  }
  return out;
}

const OA_SELECT = 'id,doi,title,display_name,publication_year,publication_date,type,authorships,primary_location,locations';
// an OpenAlex work -> publication evidence (its journal / conference location that is not a repository) | null
// `match`: how close the title must be (rel.sameWork for the work of our own id, samePaper for a title search); `doi`:
// the real DOI asked for - OpenAlex merges versions into one work, so only the location of that DOI says its venue
function oaEvidence(w, title, surname, match, doi) {
  if (!w || typeof w !== 'object') return null;
  const t = str(w.title || w.display_name, 400);
  if (title && t && !match(title, t)) return null;
  const first = Array.isArray(w.authorships) && w.authorships[0];
  if (surname && first && !sameAuthor(surname, (first.author && first.author.display_name) || first.raw_author_name)) return null;
  let locs = [w.primary_location, ...(Array.isArray(w.locations) ? w.locations : [])].filter((l) => l && typeof l === 'object' && l.source && typeof l.source === 'object');
  const own = doi ? locs.filter((l) => typeof l.landing_page_url === 'string' && l.landing_page_url.toLowerCase().endsWith('/' + doi.toLowerCase())) : [];
  if (own.length) locs = own;
  const loc = locs.find((l) => ['journal', 'conference', 'book series'].includes(str(l.source.type, 30)) && canon(l.source.display_name));
  if (!loc) return null;
  const wid = (str(w.id, 80).match(/W\d+$/) || [''])[0];
  return {
    source: 'OpenAlex', role: 'publication', venue: rel.venueName(loc.source.display_name), year: w.publication_year, date: isoDate(w.publication_date),
    publisher: str(loc.source.host_organization_name, 120) || null, kind: str(loc.source.type, 30) === 'journal' ? 'journal' : 'conference',
    url: wid ? 'https://openalex.org/' + wid : '',
  };
}

// ---------- PMLR: the publisher of CoRL, ICML, AISTATS, COLT ... (no Crossref DOIs) ----------
// PMLR's own pages are the publisher's record: the index (https://proceedings.mlr.press/: "Volume 270 - Proceedings of
// CoRL 2024") and one page per volume listing its papers (title, authors, abs link). It is asked only when there is a
// hint WHICH volume: the authors' arXiv comment / journal_ref, or an index, names a PMLR conference and a year. Nothing
// of the paper is sent: the pages are public lists, fetched politely (one request every 1.5 s, the app's User-Agent, no
// email) and kept as small parsed JSON in <workspace>/cache/pmlr/ - the index for a day, a volume for 30 days.
// The conferences: short name (as in ALIASES and the index), the ordinal's base year ("the 39th International
// Conference on Machine Learning" = 1983 + 39 = 2022) and the pattern on the claim text. "CLeaR" is an English word:
// only that exact spelling (or the full name) counts.
const PMLR_CONFS = [
  ['CoRL', 2016, /\bcorl\b|conference on robot learning/i],
  ['ICML', 1983, /\bicml\b|international conference on machine learning(?! and applications)/i],
  ['AISTATS', 1997, /\baistats\b|artificial intelligence and statistics/i],
  ['COLT', 1987, /\bcolt\b|conference on learning theory/i],
  ['L4DC', 2018, /\bl4dc\b|learning for dynamics (and|&) control/i],
  ['UAI', 1984, /\buai\b|uncertainty in artificial intelligence/i],
  ['CLeaR', 2021, /\bCLeaR\b|[Cc]ausal [Ll]earning and [Rr]easoning/],
  ['MIDL', 2017, /\bmidl\b|medical imaging with deep learning/i],
  ['ACML', 2008, /\bacml\b|asian conference on machine learning/i],
].map(([short, base, re]) => ({ short, base, re }));
const PMLR_SKIP = /\b(workshops?|challenges?|competitions?)\b/i;
const PMLR_HOME = 'https://proceedings.mlr.press/';
const PMLR_DIR = path.join(core.WS, 'cache', 'pmlr');
const DAY_MS = 24 * 3600 * 1000;

// HTML text -> plain text: tags removed, entities decoded (&nbsp; becomes a space)
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const htmlText = (s) => String(s || '').replace(/<[^>]*>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (x, e) => {
    if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; }
    return NAMED[e.toLowerCase()] ?? x;
  }).replace(/[\s ]+/g, ' ').trim();

// the index page -> [{ vol, text }] (pure; scripts/test-venues.js tests it)
function parsePmlrIndex(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<li>\s*<a\s+href="(?:https?:\/\/proceedings\.mlr\.press\/)?v(\d{1,4})\/?"[^>]*>\s*<b>\s*Volume\s+\d+\s*<\/b>\s*<\/a>([\s\S]*?)<\/li>/gi)) {
    const vol = Number(m[1]), text = str(htmlText(m[2]), 300);
    if (vol > 0 && text && !out.some((x) => x.vol === vol)) out.push({ vol, text });
  }
  return out;
}
// a volume page -> [{ title, authors [], url (the abs link), pages }] (pure); a paper without a title is left out
function parsePmlrVolume(html, vol) {
  const out = [];
  const parts = String(html || '').split(/<div\s+class="paper"\s*>/i).slice(1);
  for (const p of parts) {
    const t = p.match(/<p\s+class="title"\s*>([\s\S]*?)<\/p>/i);
    const title = t ? str(htmlText(t[1]), 400) : '';
    if (!title) continue;
    const a = p.match(/<span\s+class="authors"\s*>([\s\S]*?)<\/span>/i);
    const authors = a ? htmlText(a[1]).split(/\s*,\s*/).map((x) => str(x, 100)).filter(Boolean).slice(0, 50) : [];
    const info = p.match(/<span\s+class="info"\s*>([\s\S]*?)<\/span>/i);
    const pg = info ? htmlText(info[1]).match(/PMLR\s+\d+\s*:\s*([\w.-]+)/) : null;
    const u = p.match(/href="(https:\/\/proceedings\.mlr\.press\/v(\d+)\/[\w.-]+\.html)"[^>]*>\s*abs\s*</i);
    out.push({ title, authors, url: u && (!vol || Number(u[2]) === Number(vol)) ? u[1] : '', pages: pg ? pg[1] : '' });
  }
  return out;
}
// a claim text (arXiv comment / journal_ref) -> [{ short, year }]: a PMLR conference and its year in the same sentence
// ("Accepted to 2024 Conference on Robot Learning (CoRL)", "CoRL 2024", "ICML'22", "Proceedings of the 39th
// International Conference on Machine Learning" - the ordinal gives the year). A sentence about a workshop, challenge
// or competition gives no hint (its paper is not in the main volume).
function pmlrHints(text) {
  const out = [];
  for (const seg of String(text || '').split(/[.;\n]+|\s[-–—|]\s/)) {
    if (!seg.trim() || PMLR_SKIP.test(seg)) continue;
    for (const c of PMLR_CONFS) {
      const m = seg.match(c.re);
      if (!m) continue;
      const near = (re, val) => [...seg.matchAll(re)].map((x) => ({ y: val(x), d: Math.abs(x.index - m.index) })).filter((x) => yearOf(x.y)).sort((p, q) => p.d - q.d)[0];
      const y = near(/\b(?:19|20)\d{2}\b/g, (x) => Number(x[0])) || near(/'(\d{2})\b/g, (x) => 2000 + Number(x[1]))
        || near(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, (x) => c.base + Number(x[1]));
      if (y && !out.some((h) => h.short === c.short && h.year === y.y)) out.push({ short: c.short, year: y.y });
    }
  }
  return out;
}
// publication evidence of an index -> a hint { short, year, index: true } when it names a PMLR conference (not a workshop)
function pmlrIndexHint(e) {
  const c = e && canon(e.venue);
  const y = e && yearOf(e.year);
  return c && !c.workshop && c.known && PMLR_CONFS.some((x) => x.short === c.short) && y ? { short: c.short, year: y, index: true } : null;
}
// the main volumes of the hints: index text "Proceedings of <short> <year>" (also "<short> <year>", "<short> <year>
// Proceedings"), the year as hinted or the next (a volume may carry the next year); an index's year may also be the
// publication year after the conference, so for it the year before too. Workshop / challenge / competition volumes
// never. -> [{ vol, text, short, year (of the volume text) }]
function pmlrVolumes(index, hints) {
  const out = [];
  for (const h of hints || []) {
    // the hinted year first
    const years = h.index ? [h.year, h.year - 1, h.year + 1] : [h.year, h.year + 1];
    for (const y of years) for (const v of Array.isArray(index) ? index : []) {
      if (!v || PMLR_SKIP.test(v.text) || out.some((x) => x.vol === v.vol)) continue;
      const n = String(v.text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const m = n.match(new RegExp('^(?:proceedings of (?:the )?)?' + h.short.toLowerCase() + ' ((?:19|20)\\d{2})(?: proceedings)?$'));
      if (m && Number(m[1]) === y) out.push({ vol: v.vol, text: v.text, short: h.short, year: y });
    }
  }
  return out;
}
// the paper on a volume page: the normalised title EQUAL to ours and the first author's surname as a whole word
// (sameAuthor) - a similar title, or the same title by another first author, is not this paper
function pmlrMatch(papers, { title, surname }) {
  const want = normTitle(title);
  if (!want || !surname || !Array.isArray(papers)) return null;
  return papers.find((p) => p && normTitle(p.title) === want && p.authors && p.authors[0] && sameAuthor(surname, p.authors[0])) || null;
}
function pmlrEvidence(paper, v) {
  const a = ALIASES.find((x) => x.short === v.short);
  return {
    source: 'PMLR', role: 'publication', venue: a ? a.full : v.short, year: v.year, publisher: 'PMLR', kind: 'conference',
    url: httpsOf(paper.url, 'proceedings.mlr.press') || PMLR_HOME + 'v' + v.vol + '/', via: 'pmlr', vol: `PMLR volume ${v.vol} (${str(v.text, 120)})`,
  };
}

// fetching: HTML pages, through their own gate; a 404 is "no such page" (null)
const turnPMLR = rel.gate(1500);
const PMLR_MAX = 30 * 1024 * 1024;
async function pmlrPage(url) {
  await turnPMLR();
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'], Accept: 'text/html' }, signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw core.httpErr(502, 'PMLR ' + (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'did not answer in time.' : 'could not be reached (are you online?).'), { offline: true }); }
  if (r.status === 404) { if (r.body) r.body.cancel().catch(() => {}); return null; }
  if (r.status === 429 || r.status === 403) { if (r.body) r.body.cancel().catch(() => {}); throw core.httpErr(503, 'PMLR is taking no more requests for the moment. Try again in a few minutes.', { busy: true }); }
  if (!r.ok) { if (r.body) r.body.cancel().catch(() => {}); throw core.httpErr(502, `PMLR answered with an error (${r.status}).`); }
  if (Number(r.headers.get('content-length')) > PMLR_MAX) { if (r.body) r.body.cancel().catch(() => {}); throw core.httpErr(502, 'PMLR sent a page that is too large.'); }
  const text = await r.text();
  if (text.length > PMLR_MAX) throw core.httpErr(502, 'PMLR sent a page that is too large.');
  return text;
}
// a cached list (fresh: younger than maxAge), else fetched and parsed; when the fetch fails, an older cached copy still
// serves. An empty parse is not cached (the page may have changed its layout).
async function pmlrCached(file, maxAge, url, parse) {
  const f = path.join(PMLR_DIR, file);
  let old = null, age = Infinity;
  try { age = Date.now() - fs.statSync(f).mtimeMs; const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j)) old = j; } catch { /* none */ }
  if (old && age < maxAge) return old;
  let html;
  try { html = await pmlrPage(url); } catch (e) { if (old) return old; throw e; }
  const list = html == null ? [] : parse(html);
  if (list.length) { fs.mkdirSync(PMLR_DIR, { recursive: true }); core.writeJSON(f, list); }
  return list;
}
const pmlrIndex = () => pmlrCached('index.json', DAY_MS, PMLR_HOME, parsePmlrIndex);
const pmlrVolume = (vol) => pmlrCached('v' + vol + '.json', FRESH_MS, PMLR_HOME + 'v' + vol + '/', (h) => parsePmlrVolume(h, vol));
// hints -> the PMLR evidence | null; `tried`: volumes looked at before for this paper (not looked at again)
async function pmlrLookup(hints, q, tried) {
  if (!hints.length || !q.surname || normTitle(q.title).length < 12) return null;
  const vols = pmlrVolumes(await pmlrIndex(), hints).filter((v) => !tried.has(v.vol));
  for (const v of vols) {
    tried.add(v.vol);
    const p = pmlrMatch(await pmlrVolume(v.vol), q);
    if (p) return pmlrEvidence(p, v);
  }
  return null;
}

// item -> the input of decide() (plus `ids` for the record)
// `stopped`: () => true when the job was stopped - checked before each service (throws 'stopped')
async function gather(item, stopped) {
  const f = item.fields || {};
  const id = rel.identOf(item) || { doi: '', arxiv: '' };
  const title = str(f.title, 400).replace(/[{}]/g, '');
  const surname = firstSurname(f.author);
  const evidence = [], failed = [];
  let arxiv = null;
  const canTitle = normTitle(title).length >= 12;

  // The publisher's record (rule 1) and arXiv come first: once Crossref verified the venue, Semantic Scholar (the
  // service that most often asks to wait) is not asked at all, and its failure could not matter anyway.
  // 1. Crossref: the publisher's own record of a real DOI (its title must be the same work)
  if (id.doi) {
    const j = await attempt(failed, 'Crossref', () => crossrefWork(id.doi), stopped);
    const m = j && j.message;
    const e = m && typeof m === 'object' && (!title || !crTitle(m) || rel.sameWork(title, crTitle(m))) ? crossrefEvidence(m, id.doi) : null;
    if (e) evidence.push(e);
  }
  // 2. arXiv by id: the v1 date, the authors' comment / journal_ref (a claim, never evidence alone) and the DOI they
  //    gave for the published version
  let relatedDoi = '', axSurname = '';
  if (id.arxiv) {
    const m = await attempt(failed, 'arXiv', () => refs.arxivMeta(id.arxiv), stopped);
    if (m === null) arxiv = { found: false };
    else if (m) {
      const same = !title || rel.sameWork(title, m.entry.fields.title);
      arxiv = { found: same, date: same ? m.published || null : null, comment: same ? m.comment : '', journalRef: same ? m.journalRef : '' };
      if (same) {
        evidence.push({ source: 'arXiv', role: 'preprint', venue: 'arXiv', year: (m.published || '').slice(0, 4), date: m.published || null, url: 'https://arxiv.org/abs/' + id.arxiv });
        const r = m.relatedDoi && refs.parseRef(m.relatedDoi);
        if (r && r.kind === 'doi' && !/^10\.48550\//i.test(r.id)) relatedDoi = r.id;
        axSurname = firstSurname(m.entry.fields.author);
      }
    }
  }
  const who = surname || axSurname;
  // 3. Crossref by the related DOI (an entry without a real DOI of its own): the same paper by the same first author
  if (!id.doi && relatedDoi && title) {
    const j = await attempt(failed, 'Crossref', () => crossrefWork(relatedDoi), stopped);
    const e = relatedDoiEvidence(j && j.message, { title, surname: who, doi: relatedDoi });
    if (e) evidence.push(e);
  }
  // 4. Crossref title search (no real DOI, nothing found by the related DOI): see titleSearchHits for what counts
  const hasCrossref = () => evidence.some((e) => e.source === 'Crossref');
  if (!id.doi && !hasCrossref() && canTitle) {
    const q = title.replace(/[$\\{}]/g, ' ').replace(/\s+/g, ' ').trim();
    const j = await attempt(failed, 'Crossref', () => crossrefSearch(q, who), stopped);
    const items = j && j.message && Array.isArray(j.message.items) ? j.message.items : [];
    evidence.push(...titleSearchHits(items, { title, surname: who, year: yearOf(arxiv && arxiv.found && arxiv.date) || yearOf(f.year) }));
  }
  // 4b. PMLR (the publisher of CoRL, ICML ... which have no Crossref DOIs): only with a hint which volume - first the
  //     authors' claim, later (6b, 7b) a PMLR conference an index names. Its failure is recorded only when it was asked.
  const pmlrTried = new Set();
  const hasPublisher = () => evidence.some((e) => PUBLISHERS.includes(e.source));
  const tryPmlr = async (hints) => {
    if (hasPublisher() || !hints.length) return;
    const e = await attempt(failed, 'PMLR', () => pmlrLookup(hints, { title, surname: who }, pmlrTried), stopped);
    if (e) evidence.push(e);
  };
  if (arxiv && arxiv.found) await tryPmlr([...pmlrHints(arxiv.journalRef), ...pmlrHints(arxiv.comment)]);
  const indexHints = () => evidence.filter((e) => e.role === 'publication' && INDEXES.includes(e.source)).map(pmlrIndexHint).filter(Boolean);
  // 5. DBLP by title: the same work AND the same first author; CoRR is arXiv (preprint evidence only)
  if (canTitle) {
    const j = await attempt(failed, 'DBLP', () => dblp(title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()), stopped);
    const hits = j && j.result && j.result.hits && Array.isArray(j.result.hits.hit) ? j.result.hits.hit : [];
    for (const h of hits.slice(0, 5)) {
      const info = h && h.info && typeof h.info === 'object' ? h.info : null;
      if (!info || !samePaper(title, str(info.title, 400))) continue;
      const au = info.authors && info.authors.author;
      const firstAu = Array.isArray(au) ? au[0] : au;
      const authorOk = sameAuthor(surname, firstAu && (firstAu.text || firstAu));
      if (surname && !authorOk) continue;
      const venue = str(Array.isArray(info.venue) ? info.venue[0] : info.venue, 200);
      const key = str(info.key, 120);
      const url = httpsOf(str(info.url, 300), 'dblp.org');
      if (/^corr$/i.test(venue) || /^journals\/corr\//.test(key)) evidence.push({ source: 'DBLP', role: 'preprint', venue: 'CoRR (arXiv)', year: info.year, url });
      else if (venue) {
        evidence.push({
          source: 'DBLP', role: 'publication', venue, year: info.year, url, exact: authorOk && normTitle(title) === normTitle(str(info.title, 400)),
          kind: /^journals\//.test(key) ? 'journal' : /^conf\//.test(key) ? 'conference' : null,
        });
      }
    }
  }
  // 6. OpenAlex by DOI / arXiv DOI; when that work shows no venue (the preprint and the published paper are often two
  //    works there), by title
  let oaFound = false;
  if (id.doi || id.arxiv) {
    const w = await attempt(failed, 'OpenAlex', () => rel.oa('works/https://doi.org/' + rel.doiPath(id.doi || refs.arxivDoi(id.arxiv)) + '?select=' + OA_SELECT), stopped);
    const e = oaEvidence(w, title, surname, rel.sameWork, id.doi);
    if (e) { evidence.push(e); oaFound = true; }
  }
  if (!oaFound && canTitle && !failed.some((x) => x.source === 'OpenAlex')) {
    const j = await attempt(failed, 'OpenAlex', () => rel.oa('works?per-page=5&select=' + OA_SELECT + '&search=' + encodeURIComponent(title.replace(/[,:|]/g, ' '))), stopped, 'OpenAlex search');
    const e = (j && Array.isArray(j.results) ? j.results : []).map((w) => oaEvidence(w, title, surname, samePaper)).find(Boolean);
    if (e) evidence.push(e);
  }
  // 6b. PMLR by a conference DBLP / OpenAlex name
  if (!failed.some((x) => x.source === 'PMLR')) await tryPmlr(indexHints());
  // 7. Semantic Scholar: publicationVenue / journal that is not arXiv - not asked when the publisher's record is in hand
  const S2F = 'fields=title,year,venue,publicationVenue,journal,publicationDate,externalIds,authors';
  const p = hasPublisher() ? null : id.arxiv || id.doi
    ? await attempt(failed, 'Semantic Scholar', () => rel.s2(`paper/${id.arxiv ? 'ARXIV:' + encodeURIComponent(id.arxiv) : 'DOI:' + rel.doiPath(id.doi)}?${S2F}`), stopped)
    : canTitle ? await attempt(failed, 'Semantic Scholar', async () => { const j = await rel.s2('paper/search/match?' + S2F + '&query=' + encodeURIComponent(title)); return j && Array.isArray(j.data) ? j.data[0] : null; }, stopped) : null;
  if (p && typeof p === 'object' && (!title || (id.arxiv || id.doi ? rel.sameWork : samePaper)(title, str(p.title, 400))) && (!surname || !Array.isArray(p.authors) || !p.authors[0] || sameAuthor(surname, p.authors[0].name))) {
    const pv = p.publicationVenue && typeof p.publicationVenue === 'object' ? p.publicationVenue : {};
    const jn = p.journal && typeof p.journal === 'object' ? p.journal : {};
    // S2 files a workshop paper under its parent conference (publicationVenue "Computer Vision and Pattern
    // Recognition", venue "... Workshops (CVPRW)"): a name that says workshop wins
    const names = [pv.name, jn.name, p.venue].map((v) => str(v, 200));
    const venue = names.find((v) => v && /\bworkshops?\b/i.test(v) && canon(v)) || names.find((v) => v && canon(v)) || '';
    if (venue) {
      const pid = str(p.paperId, 60).replace(/[^0-9a-f]/gi, '');
      evidence.push({
        source: 'Semantic Scholar', role: 'publication', venue, year: p.year, date: isoDate(p.publicationDate),
        kind: str(pv.type, 30).toLowerCase() === 'journal' ? 'journal' : str(pv.type, 30).toLowerCase() === 'conference' ? 'conference' : null,
        url: pid ? 'https://www.semanticscholar.org/paper/' + pid : '',
      });
    }
  }
  // 7b. PMLR by the conference Semantic Scholar names (volumes looked at before are not looked at again)
  if (!failed.some((x) => x.source === 'PMLR')) await tryPmlr(indexHints());
  return { evidence, failed, arxiv, hasDoi: !!id.doi, hasArxiv: !!id.arxiv };
}

// ---------- records ----------
// a hash of what identifies the paper: when the title, DOI or arXiv id of the entry changes, its record is "not checked".
// An entry whose only identifier is in `url` hashes that identifier too (so the hash of every other entry stays as it was).
const fieldsKey = (item) => {
  const f = (item && item.fields) || {};
  const parts = [normTitle(f.title), String(f.doi || '').trim().toLowerCase(), String(f.eprint || '').trim().toLowerCase()];
  if (!parts[1] && !parts[2]) { const id = rel.identOf(item); if (id) parts.push(id.key); }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
};
// a record as the page may trust it: fields of the right type (venues.json can be edited by hand), or null
const plain = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function clean(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const st = ['published', 'preprint', 'unverified'].includes(rec.status) ? rec.status : 'unverified';
  const out = { ...rec, status: st };
  for (const k of ['venue', 'short', 'publisher', 'kind', 'date']) out[k] = plain(rec[k], 300) || null;
  for (const k of ['why', 'claim', 'checked', 'fieldsKey']) out[k] = plain(rec[k], 1000);
  for (const k of ['error', 'lastError', 'lastTry']) if (k in rec) out[k] = plain(rec[k], 1000) || undefined;
  out.year = yearOf(rec.year);
  out.sources = (Array.isArray(rec.sources) ? rec.sources : []).filter((x) => x && typeof x === 'object')
    .map((x) => ({ name: plain(x.name, 40), venue: plain(x.venue, 200), year: yearOf(x.year), url: /^https:\/\//.test(x.url) ? plain(x.url, 300) : '' }));
  out.missed = Array.isArray(rec.missed) ? rec.missed.filter((x) => typeof x === 'string') : [];
  if (!out.missed.length) delete out.missed;
  return out;
}
// a missing file is an empty one; a file that is there but cannot be read is set aside (venues-damaged-<time>.json)
// before a new one is started, so a write of the job never replaces the records it holds
function load() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { v: 1, items: {} }; throw e; }
  let j = null;
  try { j = JSON.parse(text); } catch { /* damaged */ }
  if (!(j && j.v === 1 && j.items && typeof j.items === 'object' && !Array.isArray(j.items))) {
    const aside = path.join(core.WS, 'venues-damaged-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.renameSync(FILE, aside);
    console.error('venues.json could not be read; it was kept as ' + path.basename(aside) + ' and a new one is started');
    damaged = path.basename(aside);
    return { v: 1, items: {} };
  }
  for (const [k, rec] of Object.entries(j.items)) { const c = clean(rec); if (c) j.items[k] = c; else delete j.items[k]; }
  return j;
}
let damaged = ''; // the name a damaged venues.json was set aside under (reported by GET /api/venues)
// A record that only lacks an index behind a bot wall (`missed`, e.g. DBLP) is asked again after a week, not on every
// check: while DBLP stays blocked, "Check venues" would otherwise query every paper again and run into rate limits. A
// verified publication does not need the missing index at all.
const MISSED_RETRY_MS = 7 * 24 * 3600 * 1000;
const isFresh = (rec, item) => !!rec && rec.fieldsKey === fieldsKey(item) && !rec.error && !rec.lastError
  && (!(rec.missed && rec.missed.length) || rec.status === 'published' || Date.now() - Date.parse(rec.checked) < MISSED_RETRY_MS)
  && Date.now() - Date.parse(rec.checked) < FRESH_MS;

// -> the record (+ netDown: no service answered at all - offline, or all of them busy)
async function checkOne(item, stopped) {
  const f = item.fields || {};
  const id = rel.identOf(item);
  let rec, netDown = false;
  if (!id && normTitle(f.title).length < 12) rec = { ...decide({}), why: 'This entry has no DOI, no arXiv id and no usable title to look it up by.' };
  else {
    const g = await gather(item, stopped);
    netDown = !g.evidence.length && g.failed.length > 0 && g.failed.every((x) => x.busy || x.offline || x.blocked);
    rec = decide(g);
  }
  return { ...rec, checked: new Date().toISOString(), fieldsKey: fieldsKey(item), netDown };
}

// ---------- the background job: one at a time, one paper after the other ----------
let job = null; // { done, total, current, stop }
let last = null; // how the last job ended: { done, total, stopped, error? }
const RANK = { unverified: 0, preprint: 1, published: 2 };
const NET_DOWN_STOP = 3; // papers in a row for which no service answered: the job stops (offline / every service busy)
function status() {
  const lib = core.loadLib();
  const items = load().items;
  const byId = new Map(lib.items.map((i) => [i.id, i]));
  const out = {};
  // an entry whose title / DOI / arXiv id changed since the check is marked stale (the page shows it as not checked);
  // records of deleted papers stay in the file (a restore from the trash brings them back) but are not listed
  for (const [id, rec] of Object.entries(items)) { const it = byId.get(id); if (it) out[id] = { ...rec, stale: rec.fieldsKey !== fieldsKey(it) }; }
  return { items: out, running: job ? { done: job.done, total: job.total, current: job.current } : null, last, ...(damaged ? { damaged } : {}) };
}
function start({ ids, force } = {}) {
  if (job) throw core.httpErr(409, 'Venues are being checked already.', { running: { done: job.done, total: job.total } });
  const only = Array.isArray(ids) ? new Set(ids) : null;
  const recs = load().items;
  const todo = core.loadLib().items.filter((i) => (!only || only.has(i.id)) && (force === true || !isFresh(recs[i.id], i))).map((i) => i.id);
  if (!todo.length) return { started: false, total: 0 };
  job = { done: 0, total: todo.length, current: null, stop: false };
  last = null;
  const me = job;
  let down = 0;
  (async () => {
    for (const id of todo) {
      if (me.stop) break;
      try {
        const item = core.loadLib().items.find((i) => i.id === id); // fresh: the entry may have changed or gone meanwhile
        if (item) {
          me.current = { id, title: str(item.fields && item.fields.title, 200) };
          const { netDown, ...rec } = await checkOne(item, () => me.stop);
          const file = load(), old = file.items[id];
          // a check that could not finish (rate limit, offline) never replaces a completed answer for the same entry
          // that it does not improve on: the old record stays, with the failure noted in `lastError`, and the paper is
          // asked again next time. A better answer (a verified venue whose arXiv date is missing) is stored, `error`
          // and all, so the date is looked up again.
          if (rec.error && old && !old.error && old.fieldsKey === rec.fieldsKey && RANK[rec.status] <= (RANK[old.status] ?? 0)) file.items[id] = { ...old, lastError: rec.error, lastTry: rec.checked };
          else file.items[id] = rec;
          core.writeJSON(FILE, file);
          down = netDown ? down + 1 : 0;
          if (down >= NET_DOWN_STOP) { me.error = 'The check was stopped: for ' + NET_DOWN_STOP + ' papers in a row no service answered (offline, or every service asked to wait). Try again later.'; me.done++; break; }
        }
      } catch (e) {
        if (e && e.message === STOPPED) break; // stopped between two services: this paper keeps its old record
        console.error('venue check:', e && e.message ? e.message : e);
        // the library itself could not be read (or the record not written): the job ends and says why
        if (e && e.status) { me.error = 'The check was interrupted: ' + str(e.message, 300); break; }
      }
      me.done++;
    }
  })().catch((e) => { me.error = 'The check was interrupted: ' + str((e && e.message) || String(e), 300); })
    .finally(() => { last = { done: me.done, total: me.total, stopped: me.stop, ...(me.error ? { error: me.error } : {}) }; if (job === me) job = null; });
  return { started: true, total: todo.length };
}
function stop() { if (!job) return { stopped: false }; job.stop = true; return { stopped: true }; }

module.exports = { decide, isFresh, parsePmlrIndex, parsePmlrVolume, pmlrHints, pmlrIndexHint, pmlrVolumes, pmlrMatch, pmlrEvidence, pmlrLookup, crossrefEvidence, relatedDoiEvidence, titleSearchHits, canon, sameVenue, abbrevOf, firstSurname, sameAuthor, samePaper, clean, fieldsKey, gather, checkOne, status, start, stop, ALIASES, FILE };
