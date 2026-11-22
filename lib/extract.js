// PDF text -> sentences -> heuristic key sentences. Offline, instant; Claude can refine later.

const ABBR = /\b(et al|Fig|Figs|Eq|Eqs|Eqn|Sec|Sect|Ref|Refs|Tab|e\.g|i\.e|cf|vs|Dr|Prof|No|Nos|approx|resp|ca|al|pp|Vol|Ch|App|Thm|Def|Prop|Lem|Cor|St|Mr|Ms|Inc|Ltd|Co|w\.r\.t|a\.k\.a)\./g;

function splitSentences(par) {
  const t = par.replace(ABBR, '$1∯').replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1∯'); // initials
  return t.split(/(?<=[.!?]["”')\]]?)\s+(?=[A-Z0-9\[("“])/).map((s) => s.replace(/∯/g, '.').trim()).filter(Boolean);
}

function paragraphs(pageText) {
  const out = [];
  for (const block of pageText.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d{1,4}$/.test(l));
    if (!lines.length) continue;
    let text = '';
    const flush = () => { if (text) out.push(clean(text)); text = ''; };
    for (const l of lines) {
      if (l.length < 45 && HEADING_LINE.test(l)) { flush(); out.push(l); continue; } // heading glued to its paragraph
      if (text.endsWith('-') && /^[a-z]/.test(l)) {
        // de-hyphenate a line break, but keep the hyphen of compounds such as "state-of-\nthe-art"
        const lastWord = text.slice(text.lastIndexOf(' ') + 1, -1);
        text = (lastWord.includes('-') ? text : text.slice(0, -1)) + l;
      } else text += (text ? ' ' : '') + l;
    }
    flush();
  }
  return out;
}
const HEADING_LINE = /^(\d+(\.\d+)*\.?\s+|[IVX]+\.\s+)?(abstract|introduction|background|related work|methods?|methodology|experiments?|evaluation|results?|discussion|limitations?|conclusions?|summary|future work|acknowledge?ments?|references|bibliography)\s*[:.]?$/i;
const clean = (text) => text.replace(/\s+/g, ' ').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl');

const HEADING = /^(\d+(\.\d+)*\.?\s+|[IVX]+\.\s+)?(abstract|introduction|background|related work|preliminaries|methods?|methodology|approach|model|experiments?|evaluation|results?|discussion|limitations?|conclusions?|concluding remarks|summary|future work|acknowledge?ments?|references|bibliography|appendix)\b/i;

function okSentence(s) {
  if (s.length < 45 || s.length > 600) return false;
  if (!/[.!?]["”')\]]?$/.test(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters / s.length < 0.65) return false;
  if (s.split(/\s+/).length < 7) return false;
  if (/^(figure|fig\.|table|algorithm)\s*\d/i.test(s)) return false;
  if (/©|copyright|all rights reserved|permission to make|creative commons|correspondence to|e-?mail:/i.test(s)) return false;
  return true;
}

const CUES = [
  [/\b(we|this (paper|work|study|article)|our (work|paper|study|approach|method|model|framework)) (propose|present|introduce|develop|describe|contribute|investigate|study|address|design)s?\b/i, 1.0, 'contribution'],
  [/\b(main|key|primary) contributions?\b|\bour contributions?\b|\bin this (paper|work|study|article)\b/i, 0.9, 'contribution'],
  [/\b(we|our (results?|experiments?|findings?|analysis|evaluation)) (show|find|found|demonstrate|observe|report|reveal|confirm|indicate|suggest)s?\b/i, 0.9, 'result'],
  [/\b(outperform|state[- ]of[- ]the[- ]art|significant(ly)? (improve|better|higher|lower|reduc)|improves? (over|upon)|achieves?|surpass)/i, 0.7, 'result'],
  [/\b\d+(\.\d+)?\s?(%|percent|×|x faster|fold)/i, 0.35, 'result'],
  [/\b(in conclusion|to conclude|we conclude|in summary|to summari[sz]e|overall,)/i, 0.9, 'conclusion'],
  [/\b(limitation|drawback|shortcoming|fail(s|ed)? to|does not (generali[sz]e|scale)|future work|remains? (an )?open|we leave)\b/i, 0.7, 'limitation'],
  [/\b(however|despite|although|challenge|problem|lack of|gap|unclear|little is known|poorly understood)\b/i, 0.3, 'problem'],
  [/\b(novel|new (method|approach|framework|model|algorithm|dataset|benchmark)|for the first time|first to)\b/i, 0.5, 'contribution'],
  [/\b(we (use|employ|adopt|train|evaluate|compare|formulate|model|define|leverage)|our (method|approach|model|algorithm|framework) (is|uses|consists|relies))\b/i, 0.4, 'method'],
  [/\b(hypothes[ie]s|research question|we (ask|argue|hypothesi[sz]e))\b/i, 0.6, 'problem'],
];
const SECTION_BONUS = { abstract: 0.6, conclusion: 0.5, conclusions: 0.5, summary: 0.4, discussion: 0.25, introduction: 0.25, results: 0.2, result: 0.2, limitations: 0.3, limitation: 0.3 };
const STOPWORDS = new Set('about above after again against also among because been before being between both cannot could does doing down during each from further have having here into itself more most only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your using used based show shown results paper work study figure table'.split(' '));

function analyze(pages, opts = {}) {
  const sentences = [];
  let section = opts.fromAbstract ? 'abstract' : '';
  let stop = false;
  pages.forEach((pageText, pi) => {
    if (stop) return;
    for (const par of paragraphs(pageText)) {
      const hm = par.length < 70 ? HEADING.exec(par) : null;
      if (hm) {
        const name = hm[3].toLowerCase();
        if ((name === 'references' || name === 'bibliography') && pi > 0) { stop = true; return; }
        section = name;
        if (par.length < 40) continue;
      }
      let body = par;
      if (/^abstract[\s.:—-]/i.test(par)) { section = 'abstract'; body = par.replace(/^abstract[\s.:—-]+/i, ''); }
      for (const s of splitSentences(body)) {
        if (!opts.fromAbstract && !okSentence(s)) continue;
        if (opts.fromAbstract && s.length < 25) continue;
        sentences.push({ i: sentences.length, page: pi + 1, section, text: s });
      }
    }
  });

  // term frequency
  const tf = new Map();
  const words = (s) => (s.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
  for (const s of sentences) for (const w of new Set(words(s.text))) tf.set(w, (tf.get(w) || 0) + 1);
  const maxTf = Math.max(1, ...tf.values());

  for (const s of sentences) {
    const ws = words(s.text);
    let score = ws.length ? ws.reduce((a, w) => a + tf.get(w) / maxTf, 0) / ws.length : 0; // 0..1 topicality
    let cat = '', best = 0;
    for (const [re, w, c] of CUES) if (re.test(s.text)) { score += w; if (w > best) { best = w; cat = c; } }
    score += SECTION_BONUS[s.section] || 0;
    if (s.page === 1) score += 0.15;
    if (s.text.length > 380) score -= 0.25;
    if (/\[\d+(,\s*\d+)*\]|\(\w+ et al\.,? \d{4}\)/.test(s.text) && best < 0.6) score -= 0.2; // mostly citing others
    s.score = Math.round(score * 100) / 100;
    s.category = cat || (s.section === 'abstract' ? 'summary' : 'key');
  }

  const k = opts.fromAbstract ? Math.min(sentences.length, 6) : Math.max(8, Math.min(30, Math.round(sentences.length * 0.1)));
  const top = [...sentences].sort((a, b) => b.score - a.score).slice(0, k).sort((a, b) => a.i - b.i);
  const keypoints = top.map((s) => ({ text: s.text, page: s.page, category: s.category, s: s.i }));
  return { sentences: sentences.map(({ i, page, section, text, score }) => ({ i, page, section, text, score })), keypoints };
}

// "Alice Example", "A. B. Example*", "Alice Example1,2" - one person's name as printed under a title
const NAME = /^(?:\p{Lu}[\p{L}.'’-]*\s+){1,3}\p{Lu}[\p{L}'’-]+$/u;
const TITLE_WORD = /^(?:a|an|the|of|for|with|and|or|in|on|to|via|using|from|by|towards?|under|over|through|learning|networks?|models?|systems?|methods?|analysis|study|survey|approach|codes?|control|theory|data|university|institute|college|school|department|laboratory|labs?|research|center|centre|academy|inc|corp|ltd|google|brain|deepmind|microsoft|meta|openai|nvidia|technologies|technology)$/i;
// the people named on one line ("A B, C D and E F"), or null if the line is not a plain list of names
function authorLine(line) {
  const parts = String(line).split(/\s*[,;&]\s*|\s+and\s+|[\d*∗†‡§¶]+\s+(?=\p{Lu})/u).map((p) => p.replace(/[\d*∗†‡§¶]+$/g, '').replace(/^[\d*∗†‡§¶]+/, '').trim()).filter(Boolean);
  if (!parts.length || parts.length > 12) return null;
  for (const p of parts) if (!NAME.test(p) || p.split(/\s+/).some((w) => TITLE_WORD.test(w))) return null;
  return parts;
}
function guessMeta(firstPage, info, filename) {
  const fields = {};
  const bad = (t) => !t || t.length < 6 || /^(untitled|microsoft word|.*\.(docx?|pdf|tex|dvi))$/i.test(t) || /^arXiv:/i.test(t);
  const raw = firstPage.split('\n').map((l) => l.trim()).filter(Boolean);
  let after = -1; // index in `raw` of the last title line, when the title was read from the page
  if (!bad(info.Title)) fields.title = info.Title;
  else {
    const lines = raw.filter((l) => l.length > 12 && !/^(arxiv|preprint|published|proceedings|vol\.|journal|doi|https?:)/i.test(l));
    if (!lines[0]) fields.title = filename.replace(/\.pdf$/i, '');
    else {
      // a second line belongs to the title unless it is the author line (a short one-line title is followed by names)
      const open = /(?:[-:,]|\b(?:a|an|the|of|for|with|and|or|in|on|to|via|using|from|by))$/i.test(lines[0]); // the title clearly goes on
      const at = raw.indexOf(lines[0]);
      const next = raw[at + 1] || '';
      // a wrapped title can end in one short word ("... with Diffusion" / "Policies"), which `lines` leaves out
      const tail = next !== lines[1] && next.length <= 12 && /^\p{L}[\p{L}\p{N}\s'’-]*$/u.test(next) && !/^(abstract|summary|anonymous|draft|preprint|et al)$/i.test(next) && !authorLine(next);
      const join = lines[0].length < 50 && (tail || (lines[1] && next === lines[1] /* directly below, nothing (a short name line) in between */ && lines[1].length < 80 && !/[,@]/.test(lines[1]) && (open || !authorLine(lines[1]))));
      fields.title = join ? lines[0] + ' ' + next : lines[0];
      after = join ? at + 1 : at;
    }
  }
  if (info.Author && info.Author.length > 2) fields.author = info.Author.split(/\s*[;,]\s*|\s+and\s+/).filter(Boolean).join(' and ');
  else if (after >= 0) { // the name lines right under the title
    const names = [];
    for (let i = after + 1; i < raw.length && i <= after + 6; i++) {
      const got = authorLine(raw[i]);
      if (!got) break; // an affiliation / e-mail line ends the list
      names.push(...got);
    }
    if (names.length) fields.author = [...new Set(names)].join(' and ');
  }
  const date = info.CreationDate || '';
  const y = date.match(/\b(19|20)\d{2}\b/);
  if (y) fields.year = y[0];
  return fields;
}

module.exports = { analyze, guessMeta, splitSentences };
