#!/usr/bin/env node
// Tests for the venue check: lib/venues.js decide() (evidence list -> record), canon() / sameVenue() (the alias table).
// Pure: synthetic evidence only, no network (gather() is never called). The module loads lib/core.js, so a throw-away
// workspace in the temp folder is used.
// Run:  node scripts/test-venues.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RT_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-venues-test-'));
const V = require('../lib/venues');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const pub = (source, venue, year, extra = {}) => ({ source, role: 'publication', venue, year, ...extra });
const ax = (date = '2024-07-10', extra = {}) => ({ found: true, date, comment: '', journalRef: '', ...extra });
const axEv = (date = '2024-07-10') => ({ source: 'arXiv', role: 'preprint', venue: 'arXiv', year: date.slice(0, 4), date });

// ---------- alias normalisation ----------
t('aliases', () => {
  const s = (v) => V.canon(v) && V.canon(v).short;
  assert.equal(s('CoRL'), 'CoRL');
  assert.equal(s('Conference on Robot Learning'), 'CoRL');
  assert.equal(s('8th Annual Conference on Robot Learning'), 'CoRL');
  assert.equal(s('2024 IEEE International Conference on Robotics and Automation (ICRA)'), 'ICRA');
  assert.equal(s('IEEE/RSJ International Conference on Intelligent Robots and Systems'), 'IROS');
  assert.equal(s('Robotics: Science and Systems'), 'RSS');
  assert.equal(s('IEEE Robotics Autom. Lett.'), 'RA-L');
  assert.equal(s('IEEE Robotics and Automation Letters'), 'RA-L');
  assert.equal(s('IEEE Trans. Robotics'), 'T-RO');
  assert.equal(s('Sci. Robotics'), 'Science Robotics');
  assert.equal(s('Science Robotics'), 'Science Robotics');
  assert.equal(s('ACM Trans. Graph.'), 'ACM TOG');
  assert.equal(s('Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition'), 'CVPR');
  assert.equal(s('2023 IEEE/CVF International Conference on Computer Vision (ICCV)'), 'ICCV');
  assert.equal(s('Advances in Neural Information Processing Systems 36'), 'NeurIPS');
  assert.equal(s("ICLR '25"), 'ICLR');
  // a series or a repository is not a venue
  assert.equal(V.canon('Proceedings of Machine Learning Research'), null);
  assert.equal(V.canon('arXiv (Cornell University)'), null);
  assert.equal(V.canon('CoRR'), null);
  // workshops are their own kind
  const w = V.canon('CoRL 2024 Workshop on Whole-body Control and Bimanual Manipulation');
  assert.equal(w.short, 'CoRL Workshop'); assert.equal(w.kind, 'workshop');
  assert.ok(!V.sameVenue(w, V.canon('CoRL')));
  // unknown names: the same, or one abbreviates the other
  assert.ok(V.sameVenue(V.canon('IEEE Trans. Autom. Sci. Eng.'), V.canon('IEEE Transactions on Automation Science and Engineering')));
  assert.ok(V.abbrevOf('J. Field Robotics', 'Journal of Field Robotics'));
  assert.ok(!V.sameVenue(V.canon('Journal of Field Robotics'), V.canon('Journal of Fluid Mechanics')));
  assert.ok(!V.sameVenue(V.canon('ICRA'), V.canon('IROS')));
});

t('first author surname', () => {
  assert.equal(V.firstSurname('Kumar, Ashish and Fu, Zipeng'), 'kumar');
  assert.equal(V.firstSurname('Jean-Pierre Sleiman and Farbod Farshidian'), 'sleiman');
  assert.equal(V.firstSurname(''), '');
});

// ---------- decide ----------
t('two indexes agree -> published', () => {
  const r = V.decide({ evidence: [pub('OpenAlex', 'Conference on Robot Learning', 2024), pub('Semantic Scholar', 'CoRL', 2024), axEv()], arxiv: ax(), hasArxiv: true });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'CoRL'); assert.equal(r.venue, 'Conference on Robot Learning');
  assert.equal(r.kind, 'conference'); assert.equal(r.publisher, 'PMLR'); assert.equal(r.year, 2024);
  assert.equal(r.date, '2024-07-10'); // the first public date: arXiv v1
  assert.deepEqual(r.sources.map((s) => s.name), ['OpenAlex', 'Semantic Scholar']);
  assert.match(r.why, /OpenAlex \+ Semantic Scholar/);
});

t('one exact DBLP hit (curated) -> published', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'CoRL', '2024', { exact: true })], arxiv: ax(), hasArxiv: true });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'CoRL'); assert.match(r.why, /DBLP/);
});

t('DBLP not exact (title differs a little) alone -> not verified', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'CoRL', '2024', { exact: false }), axEv()], arxiv: ax(), hasArxiv: true });
  assert.equal(r.status, 'unverified'); assert.match(r.why, /only DBLP names a venue/i);
});

t('one non-curated index alone -> not verified', () => {
  const r = V.decide({ evidence: [pub('Semantic Scholar', 'ICRA', 2025), axEv()], arxiv: ax(), hasArxiv: true });
  assert.equal(r.status, 'unverified'); assert.equal(r.short, null); assert.match(r.why, /second index/);
  const u = V.decide({ evidence: [pub('OpenAlex', 'Science Robotics', 2022)], hasDoi: false });
  assert.equal(u.status, 'unverified'); assert.match(u.why, /only OpenAlex/i);
});

t('only an arXiv claim -> preprint with the claim, not trusted', () => {
  const r = V.decide({ evidence: [axEv('2025-03-02')], arxiv: ax('2025-03-02', { comment: 'Accepted to CoRL 2025. Project page: https://x.y' }), hasArxiv: true });
  assert.equal(r.status, 'preprint'); assert.equal(r.venue, 'arXiv'); assert.equal(r.kind, 'preprint');
  assert.match(r.claim, /Accepted to CoRL 2025/); assert.equal(r.date, '2025-03-02'); assert.equal(r.year, 2025);
  // a comment that claims nothing is not kept
  assert.equal(V.decide({ evidence: [axEv()], arxiv: ax('2024-01-01', { comment: '12 pages, 8 figures' }), hasArxiv: true }).claim, '');
});

t('indexes disagree -> unverified', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'ICRA', 2024, { exact: true }), pub('Semantic Scholar', 'IEEE Robotics and Automation Letters', 2024), axEv()], arxiv: ax(), hasArxiv: true });
  assert.equal(r.status, 'unverified'); assert.match(r.why, /disagree/); assert.match(r.why, /ICRA/); assert.match(r.why, /RA-L/);
});

t('workshop kept apart', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'CoRL Workshop on Learning Robot Dynamics', 2024, { exact: true })], arxiv: ax(), hasArxiv: true });
  assert.equal(r.status, 'published'); assert.equal(r.kind, 'workshop'); assert.equal(r.short, 'CoRL Workshop');
  // a workshop does not count against (or for) a main venue named by two indexes
  const m = V.decide({ evidence: [pub('OpenAlex', 'ICRA', 2024), pub('Semantic Scholar', 'ICRA', 2024), pub('DBLP', 'ICRA Workshop X', 2023, { exact: true })] });
  assert.equal(m.status, 'published'); assert.equal(m.short, 'ICRA');
});

t('DBLP CoRR only -> preprint', () => {
  const r = V.decide({ evidence: [{ source: 'DBLP', role: 'preprint', venue: 'CoRR (arXiv)', year: '2021' }], hasArxiv: false });
  assert.equal(r.status, 'preprint'); assert.match(r.why, /DBLP \(CoRR\)/); assert.equal(r.year, 2021);
});

t('Crossref journal record -> published', () => {
  const r = V.decide({ evidence: [pub('Crossref', 'Science Robotics', '2022-01-19', { date: '2022-01-19', publisher: 'American Association for the Advancement of Science (AAAS)', kind: 'journal' })], hasDoi: true });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'Science Robotics'); assert.equal(r.kind, 'journal');
  assert.equal(r.publisher, 'American Association for the Advancement of Science (AAAS)'); assert.equal(r.year, 2022); assert.equal(r.date, '2022-01-19');
  assert.match(r.why, /Crossref/);
  // the publisher's record stands even when an index names something else
  const c = V.decide({ evidence: [pub('Crossref', 'ACM Transactions on Graphics', 2023), pub('Semantic Scholar', 'ACM Trans. Graph.', 2023), pub('OpenAlex', 'Computer Graphics Forum', 2023)], hasDoi: true });
  assert.equal(c.status, 'published'); assert.equal(c.short, 'ACM TOG'); assert.deepEqual(c.sources.map((s) => s.name), ['Crossref', 'Semantic Scholar']);
});

t('year off by one agrees, off by two does not', () => {
  const r = V.decide({ evidence: [pub('OpenAlex', 'Robotics: Science and Systems', 2021), pub('Semantic Scholar', 'RSS', 2022)] });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'RSS');
  const x = V.decide({ evidence: [pub('OpenAlex', 'Robotics: Science and Systems', 2020), pub('Semantic Scholar', 'RSS', 2022)] });
  assert.equal(x.status, 'unverified'); assert.match(x.why, /years at most one apart/);
});

t('unknown venue names agree through the abbreviation', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'IEEE Trans. Autom. Sci. Eng.', 2026), pub('OpenAlex', 'IEEE Transactions on Automation Science and Engineering', 2026)] });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'T-ASE'); // in the table
  const u = V.decide({ evidence: [pub('DBLP', 'J. Field Robotics', 2023), pub('OpenAlex', 'Journal of Field Robotics', 2023, { publisher: 'Wiley' })] });
  assert.equal(u.status, 'published'); assert.equal(u.short, 'J. Field Robotics'); assert.equal(u.venue, 'Journal of Field Robotics');
  assert.equal(u.kind, 'journal'); assert.equal(u.publisher, 'Wiley');
});

t('nothing found -> unverified', () => {
  const r = V.decide({ evidence: [], hasArxiv: false });
  assert.equal(r.status, 'unverified'); assert.equal(r.venue, null); assert.ok(!r.error); assert.match(r.why, /No index/);
  const a = V.decide({ evidence: [], arxiv: { found: false }, hasArxiv: true });
  assert.equal(a.status, 'unverified'); assert.match(a.why, /arXiv has no paper/);
});

t('a failed lookup that matters -> unverified with error (retried)', () => {
  const r = V.decide({ evidence: [axEv()], arxiv: ax(), hasArxiv: true, failed: [{ source: 'DBLP', message: 'DBLP could not be reached (are you online?).' }] });
  assert.equal(r.status, 'unverified'); assert.match(r.error, /DBLP/); assert.match(r.why, /could not be finished/);
  // OpenAlex said a venue, Semantic Scholar (which could confirm it) was busy
  const s = V.decide({ evidence: [pub('OpenAlex', 'ICRA', 2024), axEv()], arxiv: ax(), hasArxiv: true, failed: [{ source: 'Semantic Scholar', message: 'busy' }] });
  assert.equal(s.status, 'unverified'); assert.equal(s.error, 'busy');
  // Crossref of a real DOI could not be asked
  assert.equal(V.decide({ evidence: [], hasDoi: true, failed: [{ source: 'Crossref', message: 'down' }] }).error, 'down');
});

t('a failed lookup that could not change the outcome is not an error', () => {
  const r = V.decide({ evidence: [axEv()], arxiv: ax(), hasArxiv: true, failed: [{ source: 'Semantic Scholar', message: 'busy' }] });
  assert.equal(r.status, 'preprint'); assert.ok(!r.error);
  // verified, but the arXiv date is missing: published, with error so it is looked up again
  const p = V.decide({ evidence: [pub('DBLP', 'CoRL', 2024, { exact: true })], hasArxiv: true, failed: [{ source: 'arXiv', message: 'arXiv is busy' }] });
  assert.equal(p.status, 'published'); assert.equal(p.error, 'arXiv is busy'); assert.equal(p.date, '2024');
});

t('an index behind a bot wall is left out (stricter), named in missed', () => {
  const blocked = [{ source: 'DBLP', message: 'DBLP asks for a browser check.', blocked: true }];
  const r = V.decide({ evidence: [axEv()], arxiv: ax(), hasArxiv: true, failed: blocked });
  // arXiv itself confirms the preprint: it stays one, and the note says DBLP could not be asked
  assert.equal(r.status, 'preprint'); assert.ok(!r.error); assert.deepEqual(r.missed, ['DBLP']); assert.match(r.why, /Not asked: DBLP/);
  assert.equal(r.date, '2024-07-10');
  // one index alone still is not enough
  const o = V.decide({ evidence: [pub('OpenAlex', 'CoRL', 2024), axEv()], arxiv: ax(), hasArxiv: true, failed: blocked });
  assert.equal(o.status, 'unverified'); assert.match(o.why, /second index/);
  const p = V.decide({ evidence: [pub('OpenAlex', 'CoRL', 2024), pub('Semantic Scholar', 'Conference on Robot Learning', 2024)], failed: blocked });
  assert.equal(p.status, 'published'); assert.deepEqual(p.missed, ['DBLP']);
});

t('series names are neither evidence nor disagreement', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'CoRL', 2023, { exact: true }), pub('OpenAlex', 'Proceedings of Machine Learning Research', 2023)] });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'CoRL'); assert.deepEqual(r.sources.map((s) => s.name), ['DBLP']);
});

t('fieldsKey follows title / doi / eprint only', () => {
  const a = { fields: { title: 'A Paper', doi: '10.1/x', eprint: '', note: 'x' } };
  assert.equal(V.fieldsKey(a), V.fieldsKey({ fields: { title: 'a paper', doi: '10.1/X', note: 'y' } }));
  assert.notEqual(V.fieldsKey(a), V.fieldsKey({ fields: { title: 'Another Paper', doi: '10.1/x' } }));
});

t('aliases only match with framing around them', () => {
  const s = (v) => V.canon(v) && V.canon(v).short;
  for (const v of ['2023 International Conference on Machine Learning and Applications (ICMLA)', 'Proceedings of the International AAAI Conference on Web and Social Media',
    'AAAI Spring Symposium', '2024 International Conference on Robotics and Automation Engineering (ICRAE)', 'International Conference on Computer Vision Systems',
    'SIGGRAPH Asia 2024 Posters', 'SIGGRAPH (Conference Paper Track)', 'IEEE Transactions on Robotics and Automation']) {
    assert.ok(!V.canon(v).known, v);
  }
  // ISO-4 forms and the Springer container of ECCV
  for (const [v, k] of [['IEEE Robot. Autom. Lett.', 'RA-L'], ['RAL', 'RA-L'], ['Int. J. Robot. Res.', 'IJRR'], ['IEEE Trans. Robot.', 'T-RO'], ['Proc. Conf. Robot Learn.', 'CoRL'],
    ['Adv. Neural Inf. Process. Syst.', 'NeurIPS'], ['Sci. Robot.', 'Science Robotics'], ['Computer Vision – ECCV 2020', 'ECCV'], ['ACM Transactions on Graphics (TOG)', 'ACM TOG']]) assert.equal(s(v), k, v);
  // a workshop paper that S2 names in full is a workshop of the conference
  assert.equal(s('2023 IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW)'), 'CVPR Workshop');
  // an unknown spelling may still abbreviate a known venue
  assert.ok(V.sameVenue(V.canon('IEEE Trans. Pattern Anal. Mach. Intell.'), V.canon('TPAMI')));
});

t('same first author and same paper are strict', () => {
  assert.ok(!V.sameAuthor('li', 'Oliver Kroemer'));
  assert.ok(V.sameAuthor('li', 'Wei Li 0001'));
  assert.ok(V.sameAuthor('vanderberg', 'Jan van der Berg'));
  assert.ok(V.samePaper('Learning to Walk in Minutes', 'Learning to walk in minutes.'));
  assert.ok(!V.samePaper('Robust Legged Locomotion over Deformable Terrain', 'Robust Legged Locomotion over Deformable Terrain: A Unified Framework with Extended Experiments'));
});

t('missing years confirm nothing; the year comes from the verifying evidence', () => {
  const r = V.decide({ evidence: [pub('OpenAlex', 'CoRL', 2024), pub('Semantic Scholar', 'Conference on Robot Learning', null)] });
  assert.equal(r.status, 'unverified');
  const y = V.decide({ evidence: [pub('DBLP', 'CoRL', 2019), pub('OpenAlex', 'CoRL', 2024), pub('Semantic Scholar', 'CoRL', 2024)] });
  assert.equal(y.status, 'published'); assert.equal(y.year, 2024); assert.deepEqual(y.sources.map((x) => x.name), ['OpenAlex', 'Semantic Scholar']);
});

t('an older paper with the same title is not evidence', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'ICRA', 2012, { exact: true }), axEv('2024-09-02')], arxiv: ax('2024-09-02'), hasArxiv: true });
  assert.equal(r.status, 'preprint');
});

t('an exact DBLP hit is not undone by its near-title hit elsewhere', () => {
  const r = V.decide({ evidence: [pub('DBLP', 'CoRL', 2023, { exact: true }), pub('DBLP', 'IEEE Trans. Robotics', 2025, { exact: false }), axEv('2023-05-01')], arxiv: ax('2023-05-01'), hasArxiv: true });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'CoRL'); assert.equal(r.year, 2023);
  const two = V.decide({ evidence: [pub('DBLP', 'CoRL', 2023, { exact: true }), pub('DBLP', 'IEEE Trans. Robotics', 2025, { exact: true })] });
  assert.equal(two.status, 'unverified'); assert.match(two.why, /DBLP lists this title under more than one venue/);
});

t('records read from venues.json are cleaned', () => {
  assert.equal(V.clean(null), null); assert.equal(V.clean('x'), null); assert.equal(V.clean([1]), null);
  const c = V.clean({ status: 'published', short: 5, sources: 'zz', year: '2024', fieldsKey: 'k' });
  assert.deepEqual(c.sources, []); assert.equal(c.short, null); assert.equal(c.year, 2024);
});

t('an identifier only in url is part of fieldsKey', () => {
  assert.notEqual(V.fieldsKey({ fields: { title: 'Some Paper Title Here', url: 'https://arxiv.org/abs/2401.00001' } }), V.fieldsKey({ fields: { title: 'Some Paper Title Here', url: 'https://arxiv.org/abs/2509.99999' } }));
});


// ---------- the publisher's record found without a DOI in the entry ----------
const crw = (extra = {}) => ({
  DOI: '10.1109/ICRA46639.2022.9916213', type: 'proceedings-article', title: ['Fast Object Inertial Parameter Identification for Collaborative Robots'],
  'container-title': ['2022 International Conference on Robotics and Automation (ICRA)'], publisher: 'IEEE', issued: { 'date-parts': [[2022, 5, 23]] },
  author: [{ given: 'Philippe', family: 'Nadeau', sequence: 'first' }, { given: 'Jonathan', family: 'Kelly', sequence: 'additional' }], ...extra,
});
t('arXiv related DOI (and a DOI in journal_ref) is parsed', () => {
  const refs = require('../lib/refs');
  const atom = (inner) => `<feed><entry><id>http://arxiv.org/abs/2203.00830v2</id><published>2022-03-02T00:00:00Z</published><title>Fast Object Inertial Parameter Identification for Collaborative Robots</title><author><name>Philippe Nadeau</name></author>${inner}</entry></feed>`;
  assert.equal(refs.parseArxivAtom(atom('<arxiv:doi>10.1109/ICRA46639.2022.9916213</arxiv:doi>'), '2203.00830').relatedDoi, '10.1109/ICRA46639.2022.9916213');
  assert.equal(refs.parseArxivAtom(atom('<arxiv:journal_ref>IFAC-PapersOnLine 54(6), 2021, doi:10.1016/j.ifacol.2021.08.563.</arxiv:journal_ref>'), '2102.11122').relatedDoi, '10.1016/j.ifacol.2021.08.563');
  assert.equal(refs.parseArxivAtom(atom(''), '2203.00830').relatedDoi, '');
});
t('related DOI: the same paper by the same first author -> the publisher\'s record', () => {
  const q = { title: 'Fast Object Inertial Parameter Identification for Collaborative Robots', surname: 'nadeau', doi: '10.1109/ICRA46639.2022.9916213' };
  const e = V.relatedDoiEvidence(crw(), q);
  assert.equal(e.source, 'Crossref'); assert.equal(e.via, 'related'); assert.equal(e.url, 'https://doi.org/10.1109/ICRA46639.2022.9916213');
  const r = V.decide({ evidence: [e, axEv('2022-03-02')], arxiv: ax('2022-03-02'), hasArxiv: true, failed: [{ source: 'Semantic Scholar', message: 'busy', busy: true }] });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'ICRA'); assert.equal(r.year, 2022); assert.equal(r.date, '2022-03-02');
  assert.ok(!r.error); assert.match(r.why, /Crossref, by the DOI the authors gave arXiv/); // a busy Semantic Scholar is immaterial
  // the DOI of another paper (other title, or other first author) is not used
  assert.equal(V.relatedDoiEvidence(crw({ title: ['Inertial Parameter Identification of Unknown Payloads'] }), q), null);
  assert.equal(V.relatedDoiEvidence(crw({ author: [{ given: 'A', family: 'Nadeaux', sequence: 'first' }] }), q), null);
  assert.equal(V.relatedDoiEvidence(crw({ type: 'posted-content' }), q), null);
  assert.equal(V.relatedDoiEvidence(crw(), { ...q, surname: '' }), null);
});
const hit = (extra = {}) => ({
  DOI: '10.1126/scirobotics.aec8218', type: 'journal-article', title: ['Fast feature field (F3): A general predictive representation of events for robot perception'],
  'container-title': ['Science Robotics'], publisher: 'American Association for the Advancement of Science (AAAS)', issued: { 'date-parts': [[2026, 1, 14]] },
  author: [{ given: 'Richeek', family: 'Das', sequence: 'first' }], ...extra,
});
const tq = { title: 'Fast Feature Field ({F3}): A general predictive representation of events for robot perception', surname: 'das', year: 2025 };
t('Crossref title search: an equal title, same first author, article, close year -> published', () => {
  const hits = V.titleSearchHits([hit()], tq);
  assert.equal(hits.length, 1); assert.equal(hits[0].via, 'title');
  const r = V.decide({ evidence: hits, hasDoi: false, failed: [{ source: 'DBLP', message: 'DBLP asks for a browser check.', blocked: true }] });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'Science Robotics'); assert.equal(r.kind, 'journal'); assert.equal(r.year, 2026);
  assert.match(r.why, /found by its exact title and first author/);
  // a proceedings DOI of RSS, with its container named in roman numerals - or not named at all
  const rss = { DOI: '10.15607/RSS.2025.XXI.010', type: 'proceedings-article', title: ['π₀: A Vision-Language-Action Flow Model for General Robot Control'], 'container-title': ['Robotics: Science and Systems XXI'], issued: { 'date-parts': [[2025, 6, 21]] }, author: [{ given: 'Kevin', family: 'Black', sequence: 'first' }] };
  const q = { title: '$π_0$: A Vision-Language-Action Flow Model for General Robot Control', surname: 'black', year: 2024 };
  assert.equal(V.titleSearchHits([rss], q)[0].venue, 'Robotics: Science and Systems XXI');
  assert.equal(V.canon(V.titleSearchHits([{ ...rss, 'container-title': [] }], q)[0].venue).short, 'RSS');
  assert.equal(V.decide({ evidence: V.titleSearchHits([rss], q) }).short, 'RSS');
  // no year known: the year is not checked
  assert.equal(V.titleSearchHits([hit()], { ...tq, year: null }).length, 1);
});
t('Crossref title search rejects look-alikes', () => {
  // similar but not equal title
  assert.equal(V.titleSearchHits([hit({ title: ['Fast Feature Fields (F3): A general predictive representation of events for robot perception'] })], tq).length, 0);
  assert.equal(V.titleSearchHits([hit({ title: ['Fast Feature Field (F3): A general predictive representation of events for robot perception and control'] })], tq).length, 0);
  // another first author (also: not a part of a word)
  assert.equal(V.titleSearchHits([hit({ author: [{ given: 'X', family: 'Daswani', sequence: 'first' }] })], tq).length, 0);
  assert.equal(V.titleSearchHits([hit({ author: [{ given: 'Das', family: 'Kumar', sequence: 'first' }, { given: 'R', family: 'Das' }] })], tq).length, 0);
  // not a journal / proceedings article
  for (const type of ['posted-content', 'dataset', 'component', 'peer-review', 'book-chapter']) assert.equal(V.titleSearchHits([hit({ type })], tq).length, 0, type);
  // year off by two
  assert.equal(V.titleSearchHits([hit({ issued: { 'date-parts': [[2027]] } })], { ...tq, year: 2025 }).length, 0);
  // an entry with no author: only a long, dated, equal title (the F3 entry of the library has no author field)
  const only = V.titleSearchHits([hit({ title: ['Fast Feature Field (F\n <sup>3</sup>\n ): A general predictive representation of events for robot perception'] })], { ...tq, surname: '', year: 2026 });
  assert.equal(only.length, 1); assert.equal(only[0].via, 'title-only');
  assert.match(V.decide({ evidence: only }).why, /exact title and year; the entry names no author/);
  assert.equal(V.titleSearchHits([hit()], { ...tq, surname: '', year: null }).length, 0);
  const short = { title: 'Learning to Walk', surname: '', year: 2026 };
  assert.equal(V.titleSearchHits([hit({ title: ['Learning to walk'] })], short).length, 0);
  assert.equal(V.titleSearchHits([hit({ DOI: '10.48550/arXiv.2509.0001' })], tq).length, 0);
});
t('Crossref title search: two hits in different venues disagree -> unverified', () => {
  const two = V.titleSearchHits([hit(), hit({ DOI: '10.1109/LRA.2026.1', 'container-title': ['IEEE Robotics and Automation Letters'] })], tq);
  assert.equal(two.length, 2);
  const r = V.decide({ evidence: [...two, pub('OpenAlex', 'Science Robotics', 2026), pub('Semantic Scholar', 'Science Robotics', 2026)] });
  assert.equal(r.status, 'unverified'); assert.match(r.why, /Crossref has records of this title in more than one venue/); assert.match(r.why, /RA-L/);
  // two records of the same venue are one
  assert.equal(V.titleSearchHits([hit(), hit({ DOI: '10.1126/scirobotics.aec8218.x' })], tq).length, 1);
});
t('a failed Crossref lookup matters also without a DOI in the entry', () => {
  const r = V.decide({ evidence: [axEv()], arxiv: ax(), hasArxiv: true, failed: [{ source: 'Crossref', message: 'Crossref is busy', busy: true }] });
  assert.equal(r.status, 'unverified'); assert.equal(r.error, 'Crossref is busy');
});

// ---------- PMLR: the publisher's record of CoRL, ICML ... (pure: the saved index page and small synthetic volume pages) ----------
// scripts/fixtures/pmlr-index.html: a small hand-written stand-in with the row markup of https://proceedings.mlr.press/ (the index page)
const PMLR_HTML = path.join(__dirname, 'fixtures', 'pmlr-index.html');
const pmlrIndexHtml = fs.existsSync(PMLR_HTML) ? fs.readFileSync(PMLR_HTML, 'utf8')
  : '<ul><li><a href="v270"><b>Volume 270</b></a> Proceedings of CoRL 2024</li><li><a href="v305"><b>Volume 305</b></a> Proceedings of CoRL 2025</li>'
    + '<li><a href="v162"><b>Volume 162</b></a> Proceedings of ICML 2022</li><li><a href="v184"><b>Volume 184</b></a> Proceedings of ICML 2022 Workshop on Healthcare AI and COVID-19</li>'
    + '<li><a href="v100"><b>Volume 100</b></a> CoRL 2019</li><li><a href="v84"><b>Volume 84</b></a> AISTATS 2018 Proceedings</li></ul>';
const paperHtml = (title, authors, url, vol = 270, pages = '885-915') => `<div class="paper"><p class="title">${title}</p><p class="details"><span class="authors">${authors.join(',&nbsp;')}</span>; <span class="info"><i>Proceedings of The 8th Conference on Robot Learning</i>, PMLR ${vol}:${pages}</span></p><p class="links">[<a href="${url}">abs</a>][<a href="${url.replace('.html', '/x.pdf')}" target="_blank">Download PDF</a>]</p></div>`;
const vol270 = '<html><body><h2>Volume 270</h2>'
  + paperHtml('Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning', ['Nikita Rudin', 'David Hoeller'], 'https://proceedings.mlr.press/v270/rudin25a.html', 270, '91-100')
  + paperHtml('Sim-to-Real Transfer of Legged Robots: A &quot;Robust&quot; Policy &amp; More', ['Rafael&nbsp;Higuera', 'Ana Li'], 'https://proceedings.mlr.press/v270/higuera25a.html')
  + '<div class="paper"><p class="details">no title here</p></div>'
  + '<div class="paper"><p class="title">A Paper Without Links</p></div></body></html>';
t('PMLR index parsing', () => {
  const idx = V.parsePmlrIndex(pmlrIndexHtml);
  assert.ok(idx.length >= 6);
  assert.deepEqual(idx.find((v) => v.vol === 270), { vol: 270, text: 'Proceedings of CoRL 2024' });
  assert.deepEqual(idx.find((v) => v.vol === 162), { vol: 162, text: 'Proceedings of ICML 2022' });
  assert.ok(idx.every((v) => Number.isInteger(v.vol) && v.text && !/</.test(v.text)));
  assert.deepEqual(V.parsePmlrIndex('<li><a href="https://proceedings.mlr.press/v7/"><b>Volume 7</b></a> Proceedings of &quot;X&quot; 2009</li><li><a href="v8">broken</a></li>'), [{ vol: 7, text: 'Proceedings of "X" 2009' }]);
  assert.deepEqual(V.parsePmlrIndex(''), []);
});
t('PMLR volume parsing', () => {
  const ps = V.parsePmlrVolume(vol270, 270);
  assert.equal(ps.length, 3);
  assert.deepEqual(ps[0], { title: 'Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning', authors: ['Nikita Rudin', 'David Hoeller'], url: 'https://proceedings.mlr.press/v270/rudin25a.html', pages: '91-100' });
  assert.equal(ps[1].title, 'Sim-to-Real Transfer of Legged Robots: A "Robust" Policy & More'); // entities decoded
  assert.deepEqual(ps[1].authors, ['Rafael Higuera', 'Ana Li']);
  assert.deepEqual(ps[2], { title: 'A Paper Without Links', authors: [], url: '', pages: '' }); // missing pieces
  // an abs link of another volume is not taken
  assert.equal(V.parsePmlrVolume(vol270, 271)[0].url, '');
});
t('PMLR hints: claim forms, ordinals, workshops skipped', () => {
  assert.deepEqual(V.pmlrHints('Accepted to 2024 Conference on Robot Learning (CoRL). Project page: https://x.y'), [{ short: 'CoRL', year: 2024 }]);
  assert.deepEqual(V.pmlrHints('CoRL 2024'), [{ short: 'CoRL', year: 2024 }]);
  assert.deepEqual(V.pmlrHints('ICML 2022'), [{ short: 'ICML', year: 2022 }]);
  assert.deepEqual(V.pmlrHints('Proceedings of the 39th International Conference on Machine Learning, Baltimore, Maryland, USA, PMLR 162, 2022'), [{ short: 'ICML', year: 2022 }]);
  assert.deepEqual(V.pmlrHints('Proceedings of the 39th International Conference on Machine Learning'), [{ short: 'ICML', year: 2022 }]);
  assert.deepEqual(V.pmlrHints("Published at ICML'23"), [{ short: 'ICML', year: 2023 }]);
  assert.deepEqual(V.pmlrHints('Accepted to the CoRL 2024 Workshop on Whole-body Control'), []);
  assert.deepEqual(V.pmlrHints('Accepted at the ICML 2022 Workshop on Healthcare AI'), []);
  assert.deepEqual(V.pmlrHints('Accepted to ICRA 2025'), []);
  assert.deepEqual(V.pmlrHints('CoRL'), []); // no year: no hint
  assert.deepEqual(V.pmlrHints('a clear improvement, 2024'), []); // "clear" is not CLeaR
  assert.deepEqual(V.pmlrHints('CLeaR 2023'), [{ short: 'CLeaR', year: 2023 }]);
  assert.deepEqual(V.pmlrHints(''), []);
  // an index naming a PMLR conference
  assert.deepEqual(V.pmlrIndexHint({ source: 'OpenAlex', venue: 'Conference on Robot Learning', year: 2025 }), { short: 'CoRL', year: 2025, index: true });
  assert.equal(V.pmlrIndexHint({ source: 'OpenAlex', venue: 'ICRA', year: 2025 }), null);
  assert.equal(V.pmlrIndexHint({ source: 'DBLP', venue: 'CoRL Workshop X', year: 2025 }), null);
});
t('PMLR volumes of a hint: main volumes only, the year or the next', () => {
  const idx = V.parsePmlrIndex(pmlrIndexHtml);
  assert.deepEqual(V.pmlrVolumes(idx, [{ short: 'CoRL', year: 2024 }]).map((v) => [v.vol, v.year]), [[270, 2024], [305, 2025]]);
  assert.deepEqual(V.pmlrVolumes(idx, [{ short: 'ICML', year: 2022 }]).map((v) => v.vol).filter((v) => v === 162 || v === 184), [162]); // the workshop volume 184 skipped
  assert.ok(V.pmlrVolumes(idx, [{ short: 'CoRL', year: 2019 }]).some((v) => v.vol === 100)); // "CoRL 2019"
  assert.ok(V.pmlrVolumes(idx, [{ short: 'AISTATS', year: 2018 }]).some((v) => v.vol === 84)); // "AISTATS 2018 Proceedings"
  assert.deepEqual(V.pmlrVolumes(idx, []), []);
  assert.deepEqual(V.pmlrVolumes([{ vol: 1, text: 'TerraBytes at ICML 2025' }, { vol: 2, text: 'Proceedings of the ICLR GRaM Workshop 2026' }], [{ short: 'ICML', year: 2025 }]), []);
});
t('PMLR: equal title + first author -> the publisher\'s record; look-alikes rejected', () => {
  const ps = V.parsePmlrVolume(vol270, 270);
  const v = { vol: 270, text: 'Proceedings of CoRL 2024', short: 'CoRL', year: 2024 };
  const p = V.pmlrMatch(ps, { title: 'Sim-to-Real Transfer of Legged Robots: A ``Robust\'\' Policy {\\&} More', surname: 'higuera' });
  assert.ok(p);
  const e = V.pmlrEvidence(p, v);
  assert.deepEqual([e.source, e.venue, e.year, e.publisher, e.url], ['PMLR', 'Conference on Robot Learning', 2024, 'PMLR', 'https://proceedings.mlr.press/v270/higuera25a.html']);
  const r = V.decide({ evidence: [e, axEv('2024-06-01')], arxiv: ax('2024-06-01', { comment: 'Accepted to CoRL 2024' }), hasArxiv: true, failed: [{ source: 'Semantic Scholar', message: 'busy', busy: true }] });
  assert.equal(r.status, 'published'); assert.equal(r.short, 'CoRL'); assert.equal(r.kind, 'conference'); assert.equal(r.publisher, 'PMLR');
  assert.equal(r.year, 2024); assert.equal(r.date, '2024-06-01'); assert.ok(!r.error);
  assert.deepEqual(r.sources, [{ name: 'PMLR', venue: 'Conference on Robot Learning', year: 2024, url: 'https://proceedings.mlr.press/v270/higuera25a.html' }]);
  assert.match(r.why, /publisher's record \(PMLR, the same title and first author in PMLR volume 270/);
  // similar title, other first author, no surname: not this paper
  assert.equal(V.pmlrMatch(ps, { title: 'Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning Extended', surname: 'rudin' }), null);
  assert.equal(V.pmlrMatch(ps, { title: 'Learning to Walk in Minutes Using Parallel Deep Reinforcement Learning', surname: 'rudin' }), null);
  assert.equal(V.pmlrMatch(ps, { title: 'Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning', surname: 'hoeller' }), null);
  assert.equal(V.pmlrMatch(ps, { title: 'Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning', surname: 'rud' }), null);
  assert.equal(V.pmlrMatch(ps, { title: 'Learning to Walk in Minutes Using Massively Parallel Deep Reinforcement Learning', surname: '' }), null);
  assert.ok(V.pmlrMatch(ps, { title: 'Learning to walk in minutes using massively parallel deep reinforcement learning', surname: 'rudin' }));
});
t('a record missing only a blocked index is fresh for a week, a verified one for 30 days', () => {
  const item = { id: 'x', fields: { title: 'A Paper', doi: '10.1/x' } };
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const rec = (o) => ({ fieldsKey: V.fieldsKey(item), checked: at(1), status: 'preprint', ...o });
  assert.equal(V.isFresh(rec({ missed: ['DBLP'] }), item), true);
  assert.equal(V.isFresh(rec({ missed: ['DBLP'], checked: at(8) }), item), false);
  assert.equal(V.isFresh(rec({ missed: ['DBLP'], checked: at(8), status: 'published' }), item), true);
  assert.equal(V.isFresh(rec({ missed: ['DBLP'], checked: at(31), status: 'published' }), item), false);
  assert.equal(V.isFresh(rec({ lastError: 'busy' }), item), false);
  assert.equal(V.isFresh(rec({ error: 'busy' }), item), false);
});

t('PMLR: no hint -> not asked; a failed fetch with a hint matters', () => {
  // no hint, nothing asked: the arXiv preprint stays a preprint
  assert.equal(V.decide({ evidence: [axEv()], arxiv: ax(), hasArxiv: true }).status, 'preprint');
  const r = V.decide({ evidence: [axEv()], arxiv: ax('2024-07-10', { comment: 'CoRL 2024' }), hasArxiv: true, failed: [{ source: 'PMLR', message: 'PMLR could not be reached (are you online?).', offline: true }] });
  assert.equal(r.status, 'unverified'); assert.match(r.error, /PMLR/);
  // the publisher's records of PMLR and Crossref naming two venues disagree
  const d = V.decide({ evidence: [pub('PMLR', 'Conference on Robot Learning', 2024, { via: 'pmlr' }), pub('Crossref', 'IEEE Robotics and Automation Letters', 2025)] });
  assert.equal(d.status, 'unverified'); assert.match(d.why, /publishers' records \(PMLR, Crossref\)/);
  // PMLR and an index agree: both listed
  const a = V.decide({ evidence: [pub('PMLR', 'Conference on Robot Learning', 2024, { via: 'pmlr', publisher: 'PMLR' }), pub('DBLP', 'CoRL', 2024, { exact: true })] });
  assert.equal(a.status, 'published'); assert.deepEqual(a.sources.map((s) => s.name), ['PMLR', 'DBLP']); assert.match(a.why, /and DBLP/);
  // the new aliases
  for (const [n, k] of [['International Conference on Artificial Intelligence and Statistics', 'AISTATS'], ['Conference on Learning Theory', 'COLT'], ['L4DC', 'L4DC'], ['Uncertainty in Artificial Intelligence', 'UAI'], ['CLeaR', 'CLeaR'], ['Asian Conference on Machine Learning', 'ACML']]) assert.equal(V.canon(n).short, k, n);
});

fs.rmSync(process.env.RT_WORKSPACE, { recursive: true, force: true });
console.log(`${n} venue tests passed`);
