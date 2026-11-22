/* Display language (Preferences > General > Display language): English / 中文. See docs/preferences.md.
   English is the source language of the code. Instead of changing the ~27 modules that build their markup as HTML
   strings, one layer translates what they put on the page: a dictionary {English: 中文} (public/js/i18n/zh.js, loaded
   before this file) is applied to the text nodes and to the attributes title / aria-label / placeholder / alt /
   data-tip / label of the page, and a MutationObserver applies it again to every node that is added or changed.
   - exact matches of the trimmed text (leading / trailing white space is kept); a trailing ":" or "…" is tried off;
   - keys with placeholders, "Delete {0} papers?" -> "删除 {0} 篇论文？", match the text of a template literal (what a
     placeholder captured is put back as it was; a capture that starts with a digit, "3 papers", is translated too);
   - a short list of regex rules for the rest (counts, dates ...).
   Never translated: the note editor (.vditor; only the aria-label hints of its toolbar buttons are), CodeMirror, the PDF text layer, Claude's answers, paper titles / authors
   / abstracts / notes / tags / category names, input values, <code>/<pre>, and anything inside [data-i18n-skip] (see
   SKIP below). The engine part (createTranslator) is pure and also loads in Node (scripts/test-i18n.js,
   scripts/i18n-extract.js).
   API (window.RTI18n, also RT.i18n): t(en, ...args), lang(), setLang('en'|'zh'), languages, apply(root),
   translate(text) -> translation | null, skip (the selector), onChange(fn).
   Storage: localStorage rt.ui.lang ('en' default), per browser, read before the first paint of the modules. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RTI18n = api.boot ? api.boot() : api;
    if (root.RT) root.RT.i18n = root.RTI18n;
  }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  // ---------------- the pure engine ----------------
  const PH = /\{(\d+)\}/g;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // placeholders must have literal text around them that makes the key specific: at least 3 letters / CJK, or 2
  // letters in 5 characters ("In “{0}”")
  const specific = (key) => { const lit = key.replace(PH, ''), n = (lit.match(/[A-Za-z\u3400-\u9fff]/g) || []).length; return n >= 3 || (n >= 2 && lit.trim().length >= 5); };

  function compilePattern(key, value) {
    const order = []; // placeholder numbers in the order they appear in the key
    const lit = key.split(PH);
    // a placeholder right before another one ("{1}{2}": a count, then an optional note) takes as much as it can
    const re = new RegExp('^' + lit.map((part, i) => (i % 2 ? (order.push(Number(part)), lit[i + 1] === '' && i + 2 < lit.length ? '(.*)' : '(.*?)') : reEsc(part))).join('') + '$', 's');
    return { key, value, re, order, prefix: lit[0], suffix: lit[lit.length - 1] };
  }
  function createTranslator(data = {}) {
    const dict = new Map(), keep = new Set(data.keep || []);
    // single words that are UI values when a placeholder captures them ("Reading - click to change ..."): translated
    const words = new Set(data.captureWords || []);
    // pattern index: the first 1-2 characters of the literal prefix, else the last 1-2 of the suffix, else "middle"
    const byHead = new Map(), byTail = new Map(), middle = [];
    const put = (m, k, p) => { if (!m.has(k)) m.set(k, []); m.get(k).push(p); };
    const rules = (data.rules || []).map((r) => (Array.isArray(r) ? { re: r[0], to: r[1] } : r));
    let patterns = 0;
    for (const [k, v] of Object.entries(data.dict || {})) {
      if (typeof v !== 'string' || !v) continue;
      if (/\{\d+\}/.test(k)) {
        if (!specific(k)) continue;
        const p = compilePattern(k, v); patterns++;
        if (p.prefix) put(byHead, p.prefix.slice(0, 2), p);
        else if (p.suffix) put(byTail, p.suffix.slice(-2), p);
        else middle.push(p);
      } else dict.set(k, v);
    }
    // "Hints on hover {0}" where {0} is an element (a badge, an icon): the text node is "Hints on hover" alone, so a
    // key with one placeholder at its start or end also answers for its words without it (unless they have their own)
    for (const [k, v] of Object.entries(data.dict || {})) {
      const m = /^(?:\{(\d+)\}\s*)?([^{}]*?)(?:\s*\{(\d+)\})?$/.exec(k);
      if (!m || (m[1] === undefined) === (m[3] === undefined) || !m[2] || dict.has(m[2]) || (m[2].match(/[A-Za-z]/g) || []).length < 3) continue;
      const ph = `{${m[1] ?? m[3]}}`, base = v.replace(ph, '').trim();
      if (base && !/\{\d+\}/.test(base)) dict.set(m[2], base);
    }
    for (const m of [byHead, byTail]) for (const list of m.values()) list.sort((a, b) => b.key.length - a.key.length);
    const cache = new Map();

    const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'via', 'vs', 'vs.', 'with', 'without', 'et', 'al.']);
    function edgeFragment(p, m, s) {
      const n = p.order.length, lit = p.key.split(PH);
      // a count is plain when the rules know it ("3 papers"), not "1 not" ("1 not found" by "{0} found")
      const plain = (c) => !c || c === s || !/\s/.test(c.trim()) || (/^\d/.test(c) ? !/[A-Za-z]{3}/.test(c) || core(c.trim(), 1) !== null : dict.has(c.trim()) || words.has(c.trim()));
      // only where a bare word touches the placeholder ("{0} papers", "Show {0}"); "Found in: {0}" is delimited
      if (p.prefix === '' && n && /^\s[A-Za-z]/.test(lit[2] || '')) {
        const c = m[1];
        // "{0} papers" is a count and a noun: only a count fills it ("Origin papers", a heading, is not "Origin 篇论文"),
        // not one of the captureWords either ("Reading papers" is not "在读 篇论文"; such a text has its own entry)
        if (c && c !== s && !/^\s*(\d|\{\d+\})/.test(c) && viaRules('2' + lit[2]) !== null) return true;
        if (!plain(c)) {
          const w = c.trim().split(/\s+/);
          if (SMALL.has(w[w.length - 1].toLowerCase()) || /^(your|my|our|their|all|this|these|those|its)$/i.test(w[w.length - 1])) return true;
          if (w.some((x) => /^[a-z]/.test(x) && !SMALL.has(x))) return true;
          if (/^\d[\d,.]*$/.test(w[w.length - 1])) return true; // "Delete 3" + " papers": a sentence around a count
        }
      }
      if (p.suffix === '' && n && /[A-Za-z]\s$/.test(lit[lit.length - 3] || '')) {
        const c = m[n];
        if (!plain(c) && /^[a-z]/.test(c.trim())) return true;
      }
      return false;
    }
    function viaPattern(s) {
      const lists = [byHead.get(s.slice(0, 2)), byHead.get(s.slice(0, 1)), byTail.get(s.slice(-2)), byTail.get(s.slice(-1)), middle];
      let fallback = null;
      for (const list of lists) if (list) for (const p of list) {
        if (!s.startsWith(p.prefix) || !s.endsWith(p.suffix) || s.length < p.prefix.length + p.suffix.length) continue;
        const m = p.re.exec(s);
        if (!m) continue;
        // a capture does not run across a " · " the key does not have ("Dong et al. · 2026 · not cited" is three pieces)
        if (!p.key.includes('·') && m.slice(1).some((c) => / [·•] /.test(c))) continue;
        // a placeholder at the very start or end of a key has no delimiter: "{0} papers" must not take "Lineage of your"
        // (-> "Lineage of your 篇论文") and "Show {0}" not "all papers". There a capture of several words that is not a
        // count or a UI sentence must read like a title or a name: no lowercase word in it (small words aside) when it
        // starts the text, and no lowercase first word when it ends it
        if (edgeFragment(p, m, s)) continue;
        // an empty capture ("Move{0} to category…" with no count) fits a key without that placeholder better ("Add to
        // “{0}”" before "Add{0} to “{1}”"): keep looking, use this one only when nothing else fits
        if (p.order.some((num, i) => m[i + 1] === '')) { if (!fallback) fallback = [p, m]; continue; }
        return fill(p, m, s);
      }
      return fallback ? fill(fallback[0], fallback[1], s) : null;
    }
    function fill(p, m, s) {
      const got = {};
      // a capture is put back as it was (a title, a name), except a count ("3 papers", also " 3 papers" with the space
      // the key leaves out), a whole UI sentence or one of the captureWords of the dictionary (a reading status)
      p.order.forEach((num, i) => {
        const c = m[i + 1], lead = /^\s*/.exec(c)[0], b = c.slice(lead.length);
        let t = null;
        if (c !== s && /^\d/.test(b)) t = core(b, 1);
        else if (c !== s && (/\s/.test(c) || words.has(c)) && dict.has(c)) t = dict.get(c);
        got[num] = t === null || t === undefined ? c : (/^\d/.test(b) ? lead : '') + t;
      });
      return p.value.replace(PH, (all, num) => (got[num] !== undefined ? got[num] : all));
    }
    function viaRules(s) {
      for (const r of rules) {
        r.re.lastIndex = 0;
        const m = r.re.exec(s);
        if (!m) continue;
        const out = typeof r.to === 'function' ? r.to(m, core) : s.replace(r.re, r.to);
        if (out !== null && out !== undefined) return out;
      }
      return null;
    }
    // put the line breaks of the English text back into its translation, at the same sentence ends: "A? B." with
    // "A?\n\nB." and the translation "甲？乙。" gives "甲？\n\n乙。" (no breaks when the sentence counts differ)
    const EN_END = /[.?!…:](?=["”’)]*(\s|$))/g, ZH_END = /[。？！…：]["”’）]*|[.?!:](?=["”’)]*(\s|$))/g;
    function rebreak(src, out) {
      const parts = src.trim().split(/([ \t]*\n\s*)/);
      if (parts.length < 3) return out;
      const cuts = []; // after how many sentence ends each break comes, and the break itself
      let ends = 0;
      for (let i = 0; i < parts.length; i += 2) {
        ends += (parts[i].trim().match(EN_END) || []).length;
        if (i + 1 < parts.length) cuts.push([ends, parts[i + 1].replace(/[ \t]+/g, '')]);
      }
      const zhEnds = [...out.matchAll(ZH_END)];
      if (zhEnds.length !== ends || cuts.some(([k]) => k < 1)) return out;
      let res = '', last = 0;
      for (const [k, br] of cuts) {
        const m = zhEnds[k - 1], at = m.index + m[0].length;
        if (at < last) return out;
        res += out.slice(last, at).trim() + br; last = at;
      }
      return res + out.slice(last).trim();
    }
    // the translation of a trimmed text, or null when there is none
    function core(s, depth = 0) {
      if (!s) return null;
      if (!depth && cache.has(s)) return cache.get(s);
      let out = null;
      if (keep.has(s)) out = s;
      else if (dict.has(s)) out = dict.get(s);
      else if (/[A-Za-z]/.test(s) && s.length <= 2000) {
        // "Replace the note?\n\nIt stays in History." while the key has one space between the sentences (the
        // extractor collapses white space): look it up collapsed, then put the line breaks back
        if (/\s\s|[\n\t]/.test(s)) {
          const flat = s.replace(/\s+/g, ' ').trim();
          // (a text of several lines only by a whole entry: its lines are translated one by one below, so a tooltip
          // "Title\nKim 2024 · cited 12" keeps its lines instead of being run together by the " · " fallback)
          const t = flat && flat !== s ? (/\n/.test(s) ? dict.get(flat) ?? viaPattern(flat) ?? viaRules(flat) : core(flat, depth)) : null;
          if (t !== null) out = rebreak(s, t);
        }
        if (out === null) out = viaPattern(s) ?? viaRules(s);
        if (out === null && depth < 2) {
          // "Name:" / "Search…" / "Saved." / "(Optional)" when only the bare words are in the dictionary
          const m = /^(.*?)(\s*(?::|：|…|\.\.\.|\.|!|\?))$/s.exec(s);
          if (m && m[1]) { const b = core(m[1], depth + 1); if (b !== null) out = b + ({ ':': '：', '…': '…', '...': '…', '.': '。', '!': '！', '?': '？' }[m[2].trim()] ?? m[2]); }
          const p = out === null && /^\((.+)\)$/s.exec(s);
          if (p) { const b = core(p[1], depth + 1); if (b !== null) out = '（' + b + '）'; }
          // a text of several lines (a tooltip "https://…\nFound in: arXiv id"): line by line
          if (/\n/.test(s)) {
            let any = false;
            const tr = s.split('\n').map((x) => { const t = x.trim() && core(x.trim(), depth + 1); if (!t) return x; any = true; return x.replace(x.trim(), t); });
            if (any) out = tr.join('\n');
          }
          // "· today", "3 papers · 3 reading · 0 cited": pieces joined by a middle dot, each translated on its own;
          // ("Dong et al. · 2026 · not cited": the names stay, the UI pieces are translated)
          if (out === null && !/\n/.test(s) && /(^|\s)[·•|](\s|$)/.test(s)) {
            const parts = s.split(/(\s*[·•|]\s*)/);
            let any = false;
            const tr = parts.map((x, i) => {
              if (i % 2 || !/[A-Za-z]/.test(x)) return x;
              const t = core(x.trim(), depth + 1);
              if (t === null) return x;
              any = true; return x.replace(x.trim(), t);
            });
            if (any) out = tr.join('');
          }
        }
      }
      if (!depth) { if (cache.size > 20000) cache.clear(); cache.set(s, out); }
      return out;
    }
    // a raw text node value: keeps the white space around it
    function translateText(raw) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
      if (!m[2]) return null;
      const t = core(m[2]);
      return t === null || t === m[2] ? null : m[1] + t + m[3];
    }
    // t('Delete {0} papers?', n): the translated template with its arguments, or the English one
    function format(lang, s, args) {
      const key = String(s ?? '');
      let out = lang === 'en' ? key : (dict.get(key) ?? null);
      const fill = (x) => x.replace(PH, (all, i) => (args[i] !== undefined ? String(args[i]) : all));
      if (out !== null) return fill(out);
      const filled = fill(key);
      return lang === 'en' ? filled : (translateText(filled) ?? filled);
    }
    return { translate: core, translateText, format, size: dict.size, patterns, keep };
  }

  // ---------------- the DOM layer (browser only) ----------------
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'data-tip', 'label'];
  // user content and third-party UI: never translated (the subtree is skipped)
  const SKIP = [
    '[data-i18n-skip]', 'script', 'style', 'code', 'pre', 'kbd', 'samp', 'textarea', 'svg', '[contenteditable=""]', '[contenteditable="true"]',
    // third-party editors and the PDF text: the note editor, CodeMirror, pdf.js layers, formulas
    '.vditor', '.vditor-reset', '.CodeMirror', '.textLayer', '.annotationLayer', '.katex', '.MathJax',
    // Claude's answers and the user's messages (the Claude panel, answer cards); quiz, diagram and table text by Claude
    '.msg.user', '.msg.bot', '.md', '.qz-q', '.qz-opt', '.qz-why', '.qz-hint', '.qz-cq', '.qz-cans', '.dg-label', '.dg-elabel',
    '.dg-card-g', '.dg-card-h b', '.cmp-paper-title', '.cmp-item-title', 'td[data-col]', '.fg-cap',
    // paper data: titles, authors, briefs, tags, passages, highlight text, project and file names
    '.au', '.item .t', '.brief:not(.wait)', '.item .tag', '.pn-snip', '.hl-pop-text', '.org-t', '.rw-title', '.tr-title', '.nm:not(.ui)',
].join(', ');
  const LANGS = [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }];
  const KEY = 'rt.ui.lang';

  function boot() {
    const doc = root.document;
    const store = { get() { try { return root.localStorage.getItem(KEY); } catch { return null; } }, set(v) { try { root.localStorage.setItem(KEY, v); } catch {} } };
    let current = LANGS.some((l) => l.id === store.get()) ? store.get() : 'en';
    const dicts = { zh: root.RT_I18N_ZH || { dict: {} } };
    const translators = {};
    const tr = (l) => translators[l] || (translators[l] = createTranslator(dicts[l] || { dict: {} }));
    const textRec = new WeakMap(); // text node -> {src, out}
    const attrRec = new WeakMap(); // element -> Map(attr -> {src, out})
    const listeners = new Set();

    const skipped = (el) => !!(el && el.closest && el.closest(SKIP));
    function doText(node) {
      const cur = node.data, rec = textRec.get(node);
      const src = rec && cur === rec.out ? rec.src : cur;
      const t = current === 'en' ? null : tr(current).translateText(src);
      const out = t === null ? src : t;
      if (out !== cur) node.data = out;
      if (out !== src) textRec.set(node, { src, out }); else if (rec) textRec.delete(node);
    }
    function doAttr(el, a) {
      const cur = el.getAttribute(a);
      let recs = attrRec.get(el);
      const rec = recs && recs.get(a);
      // removed (tips.js moves a title aside while its hint shows): the record stays, so the value put back is known
      if (cur === null) return;
      const src = rec && cur === rec.out ? rec.src : cur;
      const t = current === 'en' || !cur ? null : tr(current).translateText(src);
      const out = t === null ? src : t;
      if (out !== cur) el.setAttribute(a, out);
      if (out !== src) { if (!recs) attrRec.set(el, (recs = new Map())); recs.set(a, { src, out }); }
      else if (rec) recs.delete(a);
    }
    function doAttrs(el) {
      if (!el.hasAttribute) return;
      for (const a of ATTRS) if (el.hasAttribute(a) || (attrRec.get(el) && attrRec.get(el).has(a))) doAttr(el, a);
      // an <input type=button|submit> shows its value
      if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.hasAttribute('value')) doAttr(el, 'value');
    }
    const FORM = /^(TEXTAREA|INPUT|SELECT)$/;
    // translate a subtree (root itself included); assumes the caller checked the ancestors of root
    function walk(node) {
      if (node.nodeType === 3) { if (node.data.trim()) doText(node); return; }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      const el = node.nodeType === 1 ? node : null;
      if (el) {
        if (el.matches(SKIP)) { if (FORM.test(el.tagName)) doAttrs(el); return; } // a textarea's placeholder, not its text
        doAttrs(el);
      }
      const tw = doc.createTreeWalker(node, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
        acceptNode(n) {
          if (n.nodeType === 3) return 1;
          if (n.matches(SKIP)) { if (FORM.test(n.tagName)) doAttrs(n); return 2; /* REJECT the subtree */ }
          return 1;
        },
      });
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (n.nodeType === 3) { if (n.data.trim()) doText(n); }
        else doAttrs(n);
      }
    }

    // the tooltips of the note editor's toolbar: the tip: values of reader.js become aria-label of Vditor's buttons,
    // inside .vditor (skipped) - only that attribute of those buttons is translated, never the editor's text
    const TOOLBAR_TIPS = '.vditor-toolbar [aria-label]';
    function toolbarTips(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.matches(TOOLBAR_TIPS)) doAttr(node, 'aria-label');
      if (node.querySelectorAll) for (const el of node.querySelectorAll(TOOLBAR_TIPS)) doAttr(el, 'aria-label');
    }

    let observer = null, busy = false;
    function handle(records) {
      if (busy) return;
      busy = true;
      try {
        const roots = new Set();
        // the value attribute only of a button-like <input> (its label): never of an option, a text field or a textarea
        const btnValue = (el) => el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type);
        for (const r of records) {
          if (r.type === 'attributes' && r.attributeName === 'value' && !btnValue(r.target)) continue;
          if (r.type === 'childList') { for (const n of r.addedNodes) if (n.isConnected) roots.add(n); }
          else if (r.type === 'characterData') roots.add(r.target);
          else if (r.type === 'attributes' && r.target.isConnected && !skipped(r.target)) doAttr(r.target, r.attributeName);
          else if (r.type === 'attributes' && r.attributeName === 'aria-label' && r.target.isConnected && r.target.matches(TOOLBAR_TIPS)) doAttr(r.target, 'aria-label');
          else if (r.type === 'attributes' && r.target.isConnected && FORM.test(r.target.tagName) && !skipped(r.target.parentElement)) doAttr(r.target, r.attributeName);
        }
        for (const n of roots) {
          toolbarTips(n);
          const parent = n.nodeType === 3 ? n.parentElement : n.parentElement || null;
          if (parent && skipped(parent)) continue;
          walk(n);
        }
      } catch (e) { console.error('i18n:', e); }
      finally { if (observer) observer.takeRecords(); busy = false; } // our own changes are not new content
    }
    function observe() {
      if (observer || !root.MutationObserver) return;
      observer = new root.MutationObserver(handle);
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] });
    }
    function apply(r = doc.body) {
      if (!r) return;
      busy = true;
      try { toolbarTips(r); if (r !== doc.body && r.parentElement && skipped(r.parentElement)) return; walk(r); }
      finally { if (observer) observer.takeRecords(); busy = false; }
    }
    function setHtmlLang() { doc.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en'; doc.documentElement.dataset.lang = current; }

    const api = {
      languages: LANGS,
      skip: SKIP,
      lang: () => current,
      // t('Saved') / t('Delete {0} papers?', n): for code that puts text where the observer does not look
      // (window.confirm, canvas, document.title, a value compared later)
      t: (s, ...args) => tr(current).format(current, s, args),
      translate: (s) => (current === 'en' ? s : tr(current).translate(String(s ?? '').trim())),
      setLang(l) {
        if (!LANGS.some((x) => x.id === l) || l === current) return current;
        current = l; store.set(l); setHtmlLang(); apply(doc.body);
        for (const fn of listeners) { try { fn(l); } catch (e) { console.error(e); } }
        if (root.RT && root.RT.emit) root.RT.emit('i18n:changed', { lang: l });
        return current;
      },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      apply,
      addDictionary(l, data) { dicts[l] = data; delete translators[l]; if (l === current) apply(doc.body); },
      createTranslator,
    };
    // Chinese labels are short words that must not break inside a chip or badge (an English word never does)
    try { const st = doc.createElement('style'); st.textContent = ':root[data-lang="zh"] .badge, :root[data-lang="zh"] .tag { word-break: keep-all; } :root[data-lang="zh"] .badge { white-space: nowrap; }'; doc.head.append(st); } catch {}
    setHtmlLang();
    if (doc.body) { apply(doc.body); observe(); }
    else doc.addEventListener('DOMContentLoaded', () => { apply(doc.body); observe(); });
    return api;
  }

  return { createTranslator, compilePattern, ATTRS, SKIP, LANGS, boot: typeof window !== 'undefined' && root.document ? boot : null };
});
