#!/usr/bin/env node
// Tests for the guided tour's script (public/js/tour-steps.js), pure: no browser, no server.
// The step list: unique ids, every chapter known and non-empty, every step with English title and text and their
// Chinese entries (public/js/i18n/zh.js with its fragments, zh-tour.js), {mod} kept in the translation, plain text
// (no HTML), selectors that parse as CSS selectors, the chapters' palette names and empty cards translated too.
// Run:  node scripts/test-tour.js
'use strict';
const assert = require('node:assert/strict');
const { CHAPTERS, STEPS } = require('../public/js/tour-steps.js');
const zh = require('../public/js/i18n/zh.js');
const I = require('../public/js/i18n.js');

const tr = I.createTranslator(zh);
let failed = 0, n = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 12).join('\n     ')); }
}

// ---------- a small CSS selector checker (what the tour uses: compound selectors, combinators, lists) ----------
// type / * / #id / .class / [attr] / [attr op value] / :pseudo / :pseudo(arg) joined by space, >, +, ~ and commas
function validSelector(sel) {
  if (typeof sel !== 'string' || !sel.trim()) return false;
  const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*/;
  let i = 0;
  const s = sel.trim();
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function ident() { const m = IDENT.exec(s.slice(i)); if (!m) return false; i += m[0].length; return true; }
  function attr() { // after "["
    skipWs(); if (!ident()) return false; skipWs();
    if (s[i] === ']') { i++; return true; }
    const op = /^[~|^$*]?=/.exec(s.slice(i)); if (!op) return false; i += op[0].length; skipWs();
    if (s[i] === '"' || s[i] === "'") { const q = s[i]; const e = s.indexOf(q, i + 1); if (e < 0) return false; i = e + 1; }
    else if (!ident() && !/^\d/.test(s[i])) return false;
    else if (/^\d/.test(s[i - 1] || '') || /^\d/.test(s[i])) { while (/[\w-]/.test(s[i] || '')) i++; }
    skipWs(); if (s[i] !== ']') return false; i++; return true;
  }
  function pseudo() { // after ":"
    if (s[i] === ':') i++;
    if (!ident()) return false;
    if (s[i] === '(') {
      let depth = 1, j = i + 1;
      for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; }
      if (depth) return false;
      const arg = s.slice(i + 1, j - 1).trim();
      if (!arg) return false;
      if (/^(not|is|where|has)$/.test(s.slice(0, i).match(/[a-z-]+$/)[0]) && !validSelector(arg.replace(/^[>+~]\s*/, ''))) return false;
      i = j;
    }
    return true;
  }
  function compound() {
    let any = false;
    if (s[i] === '*') { i++; any = true; } else if (IDENT.test(s.slice(i))) { ident(); any = true; }
    for (;;) {
      const c = s[i];
      if (c === '#' || c === '.') { i++; if (!ident()) return false; any = true; }
      else if (c === '[') { i++; if (!attr()) return false; any = true; }
      else if (c === ':') { i++; if (!pseudo()) return false; any = true; }
      else break;
    }
    return any;
  }
  for (;;) { // a list of complex selectors
    skipWs();
    if (!compound()) return false;
    for (;;) {
      const before = i; skipWs();
      if (i >= s.length) return true;
      if (s[i] === ',') { i++; break; }
      if (/[>+~]/.test(s[i])) { i++; skipWs(); if (!compound()) return false; continue; }
      if (i > before) { if (!compound()) return false; continue; }
      return false;
    }
  }
}

const sels = (st) => (st.el == null ? [] : Array.isArray(st.el) ? st.el : [st.el]);
const zhOf = (en) => tr.translate(en);

test('the selector checker itself', () => {
  for (const ok of ['#a', '.b', 'header nav', '#x .y > .z', '#list .item.sel:not(.recent) .th', '[aria-labelledby="ov-h-cont"]', '.a:nth-child(2)', '#overleaf-slot > *', '[data-cmd=papers]', '#a, .b'])
    assert.ok(validSelector(ok), 'should parse: ' + ok);
  for (const bad of ['', '#', '.a..b', '[x="y]', '#a >', ':not()', 'a,,b', '.a:nth-child(2'])
    assert.ok(!validSelector(bad), 'should not parse: ' + bad);
});

test('8 chapters, unique ids, each with a title and a palette entry', () => {
  assert.equal(CHAPTERS.length, 8);
  const ids = CHAPTERS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate chapter id');
  assert.equal(ids[0], 'overview', 'the tour starts on the Overview');
  assert.equal(ids[ids.length - 1], 'editor', 'the tour ends in the Editor');
  for (const c of CHAPTERS) { assert.ok(c.title && c.palette, c.id); assert.ok(['overview', 'library', 'write', undefined].includes(c.view), c.id + ' view'); }
});

test('step ids are unique and every step belongs to a known chapter', () => {
  const ids = STEPS.map((s) => s.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dup, [], 'duplicate step ids');
  const known = new Set(CHAPTERS.map((c) => c.id));
  for (const s of STEPS) assert.ok(known.has(s.ch), `${s.id}: unknown chapter ${s.ch}`);
  // an empty card's id (<chapter>-empty) must not collide with a step
  for (const c of CHAPTERS) assert.ok(!ids.includes(c.id + '-empty'), c.id + '-empty is taken');
});

test('every chapter has steps, in chapter order', () => {
  for (const c of CHAPTERS) assert.ok(STEPS.some((s) => s.ch === c.id), `chapter ${c.id} has no steps`);
  const order = STEPS.map((s) => CHAPTERS.findIndex((c) => c.id === s.ch));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], `${STEPS[i].id} is out of chapter order`);
  for (const c of CHAPTERS) { const k = STEPS.filter((s) => s.ch === c.id).length; assert.ok(k >= 3, `chapter ${c.id} has only ${k} steps`); }
});

test('every step has an English title and text: plain, short enough', () => {
  for (const s of STEPS) {
    assert.ok(typeof s.title === 'string' && s.title.trim(), s.id + ' title');
    assert.ok(typeof s.text === 'string' && s.text.trim(), s.id + ' text');
    assert.ok(!/[<>]/.test(s.title + s.text), s.id + ': plain text only (no HTML)');
    assert.ok(s.title.length <= 60, s.id + ': title over 60 characters');
    assert.ok(s.text.split(/(?<=[.!?])\s+(?=[A-Z⌘{])/).length <= 4, s.id + ': more than 4 sentences');
    assert.ok(s.text.length <= 340, s.id + ': text over 340 characters');
  }
});

test('every step title and text has its Chinese translation (with {mod} kept)', () => {
  const missing = [];
  for (const s of STEPS) for (const k of ['title', 'text']) {
    const t = zhOf(s[k]);
    if (!t || t === s[k] && /[a-z]{3}/.test(s[k]) && k === 'text') { missing.push(`${s.id}.${k}: ${s[k]}`); continue; }
    if (s[k].includes('{mod}') && !t.includes('{mod}')) missing.push(`${s.id}.${k}: {mod} lost`);
    if (k === 'text' && !/[一-鿿]/.test(t)) missing.push(`${s.id}.${k}: not Chinese`);
  }
  assert.deepEqual(missing, []);
});

test('chapter titles, palette names and empty cards are translated', () => {
  const missing = [];
  for (const c of CHAPTERS) {
    for (const v of [c.title, c.palette, c.empty && c.empty.title, c.empty && c.empty.text].filter(Boolean)) if (!zhOf(v)) missing.push(`${c.id}: ${v}`);
  }
  assert.deepEqual(missing, []);
});

test('the card and the entry points are translated', () => {
  const ui = ['Chapter {0}/{1} · step {2}/{3}', '‹ Back', 'Next ›', 'Finish tour', 'Skip tour', 'Jump to a chapter', 'Take the tour', 'Tour of this screen',
    'This part is not on screen right now, so here is what it does.', 'Tour complete. Take it again any time from Help › Take the tour.', 'End the tour (Esc)'];
  assert.deepEqual(ui.filter((k) => !zh.dict[k]), []);
  assert.equal(tr.format('zh', 'Chapter {0}/{1} · step {2}/{3}', [3, 8, 2, 11]), '第 3/8 章 · 第 2/11 步');
});

test('every selector parses; every chapter that needs a paper says what to do without one', () => {
  const bad = [];
  for (const s of STEPS) {
    if (s.el === null) continue;
    const list = sels(s);
    if (!list.length) bad.push(s.id + ': no selector');
    for (const x of list) if (!validSelector(x)) bad.push(`${s.id}: ${x}`);
  }
  for (const c of CHAPTERS) if (c.empty && c.empty.el && !validSelector(c.empty.el)) bad.push(`${c.id} empty: ${c.empty.el}`);
  assert.deepEqual(bad, []);
  for (const c of CHAPTERS) {
    const needy = c.needs || STEPS.some((s) => s.ch === c.id && (s.needs || s.mode === 'project'));
    if (needy) assert.ok(c.empty && c.empty.title && c.empty.text, `${c.id} needs an empty card`);
  }
});

test('step options are known values', () => {
  const tabs = new Set(['notes', 'diagram', 'quiz', 'kp', 'details', 'related']);
  for (const s of STEPS) {
    const extra = Object.keys(s).filter((k) => !['id', 'ch', 'el', 'title', 'text', 'tab', 'claude', 'mode', 'needs', 'wait', 'side'].includes(k));
    assert.deepEqual(extra, [], s.id + ': unknown option');
    if (s.tab) assert.ok(tabs.has(s.tab), s.id + ': tab ' + s.tab);
    if (s.mode) assert.ok(['home', 'project'].includes(s.mode), s.id + ': mode ' + s.mode);
    if (s.needs) assert.ok(['paper', 'project'].includes(s.needs), s.id + ': needs ' + s.needs);
    if (s.side) assert.equal(s.side, 'pdf', s.id + ': side');
    if (s.side && s.tab) assert.fail(s.id + ': side pdf and a reader tab exclude each other in a narrow window');
    if (s.wait != null) assert.ok(Number.isFinite(s.wait) && s.wait >= 0 && s.wait <= 10000, s.id + ': wait');
    if (s.claude) assert.equal(s.ch, 'claude', s.id + ': the Claude panel is opened for its own chapter only');
  }
  assert.ok(STEPS.filter((s) => s.el === null).length <= 2, 'at most a couple of deliberately centred cards');
});

console.log(`\n${n - failed}/${n} passed`);
if (failed) process.exit(1);
