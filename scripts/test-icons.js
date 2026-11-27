#!/usr/bin/env node
// Tests for the two icon sets and their renderer: the hand-drawn set (public/js/icons-sketch.js, the default), the
// classic line icons (public/js/icons-classic.js), RT.icon in public/js/core.js (run here with a stand-in for the
// page) and the workspace setting iconStyle (PUT /api/settings, in-process against a temporary workspace).
// No browser, no server.   Run:  node scripts/test-icons.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-icons-'));
process.env.RT_WORKSPACE = WS;      // lib/core creates its folders there
process.env.RT_NO_EXTRA_PATH = '1'; // (no AI CLI is started by anything below)
process.env.RT_NO_UPDATE = '1';     // (and nothing here may make the checkout look for an update of itself)

let failed = 0, n = 0;
async function test(name, fn) {
  n++;
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 14).join('\n     ')); }
}

// ---------- the data files, loaded the way the page loads them ----------
const win = {};
for (const f of ['public/js/icons-classic.js', 'public/js/icons-sketch.js']) vm.runInNewContext(read(f), { window: win }, { filename: f });
const CLASSIC = win.RT_ICON_DEFS, SKETCH = win.RT_ICON_SKETCH, GEN_ALIAS = win.RT_ICON_ALIASES || {};

// ---------- the renderer: the icons section of core.js with a stand-in for the page ----------
function renderer(style) {
  const core = read('public/js/core.js');
  const a = core.indexOf('  // ---------------- icons: RT.icon('), b = core.indexOf('  // ---------------- the crest:');
  assert.ok(a > 0 && b > a, 'core.js: the icons section was not found between its two headings');
  const warned = [], emitted = [];
  const doc = { documentElement: { dataset: style ? { icons: style } : {} }, createElement: () => ({}) };
  const make = new Function('window', 'document', 'console', 'esc', 'emit', core.slice(a, b) + '\nreturn { icon, ICON_ALIAS };');
  const r = make(win, doc, { warn: (m) => warned.push(m) }, (s) => String(s), (ev, data) => emitted.push([ev, data]));
  return { ...r, warned, emitted, doc };
}

// one svg element with self-closed children (and an optional <title>): -> {attrs, children: [{tag, attrs}], title}
function parseSvg(html) {
  const attrsOf = (s) => {
    const out = {}; let rest = s;
    for (const m of s.matchAll(/\s+([A-Za-z_:][\w:.-]*)="([^"<>]*)"/g)) { assert.ok(!(m[1] in out), `attribute ${m[1]} twice in ${html.slice(0, 120)}`); out[m[1]] = m[2]; rest = rest.replace(m[0], ''); }
    assert.equal(rest.trim(), '', `not well-formed attributes: ${s.slice(0, 120)}`);
    return out;
  };
  const m = /^<svg((?:\s+[A-Za-z_:][\w:.-]*="[^"<>]*")*)>([\s\S]*)<\/svg>$/.exec(html);
  assert.ok(m, 'not one <svg> element: ' + html.slice(0, 160));
  let body = m[2], title = null;
  const t = /^<title>([^<>]*)<\/title>/.exec(body);
  if (t) { title = t[1]; body = body.slice(t[0].length); }
  const children = [];
  let last = 0;
  for (const c of body.matchAll(/<([a-z]+)((?:\s+[A-Za-z_:][\w:.-]*="[^"<>]*")*)\/>/g)) {
    assert.equal(c.index, last, 'text or an unclosed tag inside the svg: ' + body.slice(last, last + 80));
    children.push({ tag: c[1], attrs: attrsOf(c[2]) }); last = c.index + c[0].length;
  }
  assert.equal(last, body.length, 'text or an unclosed tag inside the svg: ' + body.slice(last, last + 80));
  return { attrs: attrsOf(m[1]), children, title };
}

// ---------- the names the app uses ----------
// Traced by hand through the modules (call sites, the name maps and constants: TAB_ICONS, PAGE_ICONS, STATUS_ICONS,
// the I = {...} maps, ICON constants, the Editor's own names). The scan below adds every name it finds at a call
// site, so a new use of an icon that the hand-drawn set does not draw fails here instead of showing a line icon
// among the pen drawings.
const USED = ['add', 'analytics', 'archive', 'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up', 'attach', 'audit', 'bibtex', 'book-open', 'bookmark',
  'bulb', 'calendar', 'callout', 'check', 'checkbox', 'checkbox-on', 'chevron-down', 'chevron-left', 'chevron-right', 'chevron-up', 'citation', 'clock',
  'close', 'collapse', 'command', 'comment', 'compass', 'config', 'copy', 'dashboard', 'delete', 'delta', 'device-laptop', 'doi', 'download', 'edit',
  'editor', 'expand', 'export', 'external-link', 'eye', 'eye-off', 'figure', 'filter', 'fit', 'fit-width', 'folder', 'formula', 'globe', 'graph-node',
  'grid', 'health', 'help', 'highlight', 'history', 'home', 'image', 'import', 'info', 'keyboard', 'latex', 'library', 'lineage', 'link', 'list',
  'list-ordered', 'logs', 'maximize', 'menu', 'minus', 'monitor', 'moon', 'more', 'new-file', 'new-folder', 'note', 'overleaf-sync', 'paper', 'paste',
  'pdf', 'play', 'plus-circle', 'projects', 'quiz', 'quote', 'redo', 'refresh', 'ruler', 'save', 'search', 'send', 'settings', 'sidebar', 'sign-out',
  'sort', 'sparkle', 'spell', 'split-view', 'star', 'stop', 'sun', 'swap-panes', 'table', 'tag', 'undo', 'unlink', 'upload', 'user', 'venue-verified',
  'warning', 'x-circle', 'zoom-in', 'zoom-out'];
// used names that are meant to stay line icons in the hand-drawn style too (none today)
const CLASSIC_ON_PURPOSE = [];
// literals at an icon call site that are not icon names there (a state compared, a key of a map)
const NOT_AN_ICON = { };

function scanUses(resolve) {
  const found = new Map(); // resolved name -> first place
  const dir = path.join(ROOT, 'public', 'js');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !/^icons-/.test(x)).sort()) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      const spans = [];
      // the arguments of a call that draws an icon ...
      for (const m of line.matchAll(/(?:\bRT\.icon|\bicon|\bI|\bic|\bTI|\.icon)\(/g)) {
        let depth = 1, j = m.index + m[0].length;
        for (; j < line.length && depth > 0; j++) { if (line[j] === '(') depth++; else if (line[j] === ')') depth--; }
        spans.push([m.index + m[0].length, j]);
      }
      // ... and the value of an  icon: / ic:  property
      for (const m of line.matchAll(/\b(?:icon|ic)\s*:\s*/g)) {
        let depth = 0, j = m.index + m[0].length;
        for (; j < line.length; j++) { const c = line[j]; if ('({['.includes(c)) depth++; else if (')}]'.includes(c)) { if (!depth) break; depth--; } else if (c === ',' && !depth) break; }
        spans.push([m.index + m[0].length, j]);
      }
      if (!spans.length) return;
      for (const m of line.matchAll(/(['"`])([A-Za-z][A-Za-z0-9-]*)\1/g)) {
        if (!spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
        const name = resolve(m[2]);
        if (!name || (NOT_AN_ICON[f] || []).includes(m[2])) continue;
        if (!found.has(name)) found.set(name, `${f}:${i + 1}`);
      }
    });
  }
  return found;
}

(async () => {
  const sk = renderer('sketch'), cl = renderer('classic');
  const resolve = (name) => { let x = sk.ICON_ALIAS[name] || name; x = GEN_ALIAS[x] || x; return CLASSIC[x] || SKETCH[x] ? x : null; };
  const scanned = scanUses(resolve);
  const used = [...new Set([...USED, ...scanned.keys()])].sort();

  await test('the two data files load: the classic set as it was, the hand-drawn set beside it', () => {
    assert.equal(Object.keys(CLASSIC).length, 182, 'the classic set keeps its 182 icons');
    assert.ok(Object.keys(SKETCH).length >= 115, 'the hand-drawn set draws at least the icons the app uses');
    assert.ok(Array.isArray(win.RT_ICON_ADDED) && win.RT_ICON_ADDED.length === 29);
    for (const [name, d] of Object.entries(CLASSIC)) { assert.ok(Array.isArray(d.o) && d.o.length, name); for (const [tag, at] of d.o) assert.ok(/^(path|rect|circle|ellipse|polyline)$/.test(tag) && at, name); }
  });

  await test(`every icon name the app uses is drawn in both sets (${used.length} names, ${scanned.size} of them found at call sites)`, () => {
    assert.ok(scanned.size >= 80, 'the scan of the call sites finds most of the used names: ' + scanned.size);
    const missingClassic = used.filter((x) => !CLASSIC[x]);
    assert.deepEqual(missingClassic, [], 'used, but not in the classic set (the Classic style would draw nothing)');
    const missingSketch = used.filter((x) => !SKETCH[x] && !CLASSIC_ON_PURPOSE.includes(x)).map((x) => `${x} (${scanned.get(x) || 'traced by hand'})`);
    assert.deepEqual(missingSketch, [], 'used, but not drawn by hand: draw it (app_icons_gen.py of the design sources makes icons-sketch.js) or list it in CLASSIC_ON_PURPOSE');
    for (const x of CLASSIC_ON_PURPOSE) assert.ok(!SKETCH[x], `${x} is listed as classic on purpose but the hand-drawn set draws it`);
    // every hand-drawn name is a name of the classic set too: switching the style never loses an icon
    assert.deepEqual(Object.keys(SKETCH).filter((x) => !CLASSIC[x]), []);
    // and both renderers give every used name a drawing, through the aliases as well
    for (const x of [...used, ...Object.keys(sk.ICON_ALIAS), 'help-circle']) for (const r of [sk, cl]) {
      assert.ok(r.icon.has(x), x); assert.ok(parseSvg(r.icon(x)).children.length > 0, `${x}: an empty icon`);
    }
    assert.deepEqual([...sk.warned, ...cl.warned], [], 'no "no icon named" warning');
  });

  await test('hand-drawn data: filled, closed pen outlines only - nothing the renderer would drop or leave unfilled', () => {
    const PATH = /^M-?[\d.]+[ -]?[\d.]*(?:[mlqaz][-\d. ]*)+$/;
    const checkPath = (name, key, d) => {
      assert.equal(typeof d, 'string', `${name}.${key}`);
      assert.ok(PATH.test(d), `${name}.${key}: not relative path data that starts with M: ${d.slice(0, 60)}`);
      const subs = (d.match(/[Mm]/g) || []).length, closed = (d.match(/z/g) || []).length;
      assert.equal(subs, closed, `${name}.${key}: ${subs} sub-paths but ${closed} closed (an open sub-path is a stroke, and a stroke is not drawn)`);
      assert.ok(/[qal]/.test(d), `${name}.${key}: no area`);
      assert.ok(d.endsWith('z'), `${name}.${key}`);
    };
    for (const [name, d] of Object.entries(SKETCH)) {
      const keys = Object.keys(d);
      assert.deepEqual(keys.filter((k) => !['k', 'w', 'au', 's', 'u', 'on', 'L'].includes(k)), [], `${name}: unknown keys`);
      checkPath(name, 'k', d.k);
      for (const k of ['w', 'au', 'u', 'on']) if (k in d) checkPath(name, k, d[k]);
      if ('s' in d) { assert.equal(d.s, 1, name); assert.ok(d.au, `${name}: s without a gold mark`); }
      if (d.L) { assert.ok(d.L.k, `${name}: a 48 master without ink`); for (const [k, v] of Object.entries(d.L)) { assert.ok(['w', 'w2', 'h', 'x', 'k', 'g', 'au'].includes(k), `${name}.L.${k}`); checkPath(name, 'L.' + k, v); } }
      // the drawing stays inside its box: 24 units (48 for the large master), nothing far outside
      const far = (s, max) => (s.match(/^M(-?[\d.]+)[ ]?(-?[\d.]+)/) || []).slice(1).some((v) => Number(v) < 0 || Number(v) > max);
      assert.ok(!far(d.k, 24), `${name}: starts outside the 24 grid`);
      if (d.L) assert.ok(!far(d.L.k, 48), `${name}: the 48 master starts outside its grid`);
    }
    // the markup never asks for a stroke, a filter, a gradient or an id (the string is cached and used many times)
    for (const name of Object.keys(SKETCH)) for (const opts of [{}, { duo: true }, { size: 34 }]) {
      const html = sk.icon(name, opts);
      assert.ok(!/\sstroke|<filter|gradient|<defs|\sid=|<style|<script|url\(/i.test(html), `${name}: ${html.slice(0, 200)}`);
    }
  });

  await test('the hand-drawn set is its own work: no drawing is a copy of a classic one, and no two are the same', () => {
    const classicPaths = new Set();
    for (const d of Object.values(CLASSIC)) for (const list of [d.o, d.d || []]) for (const [, at] of list) if (at.d) classicPaths.add(String(at.d).replace(/\s+/g, ''));
    const seen = new Map();
    for (const [name, d] of Object.entries(SKETCH)) {
      for (const k of ['k', 'w', 'au', 'u', 'on']) if (d[k]) assert.ok(!classicPaths.has(d[k].replace(/\s+/g, '')), `${name}.${k} is the path data of a classic icon`);
      assert.ok(!seen.has(d.k), `${name} and ${seen.get(d.k)} are the same drawing`); seen.set(d.k, name);
      const a = parseSvg(sk.icon(name)), b = parseSvg(cl.icon(name));
      assert.notEqual(JSON.stringify(a.children), JSON.stringify(b.children), `${name}: the same markup in both sets`);
      assert.notEqual(sk.icon(name), cl.icon(name), name);
    }
  });

  await test('RT.icon, hand-drawn: valid SVG, decorative by default, ink in currentColor, the options', () => {
    const { icon } = sk;
    assert.equal(icon.style(), 'sketch'); assert.deepEqual([...icon.styles], ['sketch', 'classic']);
    for (const name of ['check', 'close', 'library', 'star', 'sparkle', 'settings', 'trash', 'help-circle', 'chevDown']) {
      const s = parseSvg(icon(name));
      assert.equal(s.attrs.class, 'ic sk'); assert.equal(s.attrs.viewBox, '0 0 24 24'); assert.equal(s.attrs.fill, 'currentColor');
      assert.equal(s.attrs['aria-hidden'], 'true'); assert.equal(s.attrs.focusable, 'false'); assert.equal(s.attrs['data-i'], name);
      assert.ok(!('stroke' in s.attrs) && !('width' in s.attrs) && !('role' in s.attrs) && s.title === null, name);
      assert.ok(s.children.every((c) => c.tag === 'path' && c.attrs.d && !('stroke' in c.attrs) && !('fill' in c.attrs)), name);
    }
    // ink only at UI sizes: one path (plus the hidden "on" body of the star and the bookmark)
    assert.deepEqual(parseSvg(icon('library')).children.map((c) => c.attrs.class || 'ink'), ['ink']);
    assert.deepEqual(parseSvg(icon('star')).children.map((c) => c.attrs.class || 'ink'), ['ink', 'ic-on']);
    assert.deepEqual(parseSvg(icon('bookmark')).children.map((c) => c.attrs.class || 'ink'), ['ink', 'ic-on']);
    // a gold mark that carries meaning is inked at UI sizes (the lineage seed), one that decorates is left out
    assert.equal(parseSvg(icon('lineage')).children[0].attrs.d, SKETCH.lineage.k + SKETCH.lineage.au);
    assert.equal(parseSvg(icon('library')).children[0].attrs.d, SKETCH.library.k);
    // the second tone: asked for (duo), or from 20 px
    assert.deepEqual(parseSvg(icon('library', { duo: true })).children.map((c) => c.attrs.class || 'ink'), ['ic-w', 'ink', 'ic-au']);
    assert.deepEqual(parseSvg(icon('library', { duo: 'sketch' })).children.map((c) => c.attrs.class || 'ink'), ['ic-w', 'ink', 'ic-au']);
    assert.deepEqual(parseSvg(icon('library', { size: 20 })).children.map((c) => c.attrs.class || 'ink'), ['ic-w', 'ink', 'ic-au']);
    assert.deepEqual(parseSvg(icon('library', { size: 18 })).children.map((c) => c.attrs.class || 'ink'), ['ink']);
    assert.deepEqual(parseSvg(icon('close', { duo: true, size: 24 })).children.map((c) => c.attrs.class || 'ink'), ['ink'], 'a control has no second tone');
    assert.equal(parseSvg(icon('library', { duo: true })).attrs['data-duo'], '1'); assert.equal(parseSvg(icon('library', { duo: 'sketch' })).attrs['data-duo'], 'sketch');
    // size: width / height on the svg; from 32 px the 48 master when the icon has one
    const big = parseSvg(icon('lineage', { size: 34 }));
    assert.equal(big.attrs.viewBox, '0 0 48 48'); assert.equal(big.attrs.width, '34'); assert.equal(big.attrs.height, '34'); assert.equal(big.attrs.style, 'width:34px;height:34px');
    assert.ok(big.children.length >= 4 && big.children.some((c) => c.attrs.class === 'ic-au') && big.children.some((c) => !c.attrs.class));
    assert.equal(parseSvg(icon('check', { size: 34 })).attrs.viewBox, '0 0 24 24', 'no 48 master: the 24 master is used');
    // cls (also as a plain string), title
    assert.equal(parseSvg(icon('check', 'ic-spin')).attrs.class, 'ic sk ic-spin'); assert.equal(parseSvg(icon('check', { cls: 'a b' })).attrs.class, 'ic sk a b');
    const named = parseSvg(icon('warning', { title: 'Mind "this" <now>' }));
    assert.equal(named.attrs.role, 'img'); assert.equal(named.attrs['aria-label'], 'Mind &quot;this&quot; &lt;now&gt;'); assert.equal(named.title, 'Mind &quot;this&quot; &lt;now&gt;'); assert.ok(!('aria-hidden' in named.attrs));
    // the same call gives the same string (it is cached)
    assert.equal(icon('check'), icon('check'));
    // a name the hand-drawn set lacks comes from the classic set, as a stroked icon
    const lacking = Object.keys(CLASSIC).find((x) => !SKETCH[x]);
    const fallback = parseSvg(icon(lacking));
    assert.equal(fallback.attrs.class, 'ic'); assert.equal(fallback.attrs.fill, 'none'); assert.equal(fallback.attrs.stroke, 'currentColor'); assert.ok(fallback.children.length);
    assert.equal(icon.sketched(lacking), false); assert.equal(icon.sketched('check'), true); assert.equal(icon.sketched('trash'), true);
    // a raw path of the old 16 grid, and an unknown name
    assert.equal(parseSvg(icon('M3 8h10')).attrs.viewBox, '0 0 16 16');
    assert.equal(parseSvg(icon('no-such-icon')).children.length, 0); assert.equal(sk.warned.length, 1); assert.equal(icon.has('no-such-icon'), false);
    assert.ok(icon.names().length >= 180 && icon.names().includes('check'));
  });

  await test('RT.icon, classic: the line icons exactly as before', () => {
    const { icon } = cl;
    assert.equal(icon.style(), 'classic');
    const s = parseSvg(icon('check'));
    assert.deepEqual(s.attrs, { class: 'ic', 'data-i': 'check', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    assert.deepEqual(s.children, [{ tag: 'path', attrs: { d: 'M4.5 12.5l5 5L19.5 7' } }]);
    assert.equal(parseSvg(icon('check', { size: 18 })).attrs['stroke-width'], '1.75'); assert.equal(parseSvg(icon('check', { size: 34 })).attrs['stroke-width'], '1.5');
    assert.equal(parseSvg(icon('check', { size: 34 })).attrs.viewBox, '0 0 24 24');
    // the duotone layer: for duo: true only; duo: 'sketch' asks for the second tone of the hand-drawn set alone
    assert.deepEqual(parseSvg(icon('library', { duo: true })).children.map((c) => c.attrs.class || ''), ['ic-duo', '', '', '', '', '', '', '']);
    assert.ok(parseSvg(icon('library', { duo: 'sketch' })).children.every((c) => !c.attrs.class));
    assert.ok(parseSvg(icon('library', { size: 24 })).children.every((c) => !c.attrs.class));
    for (const name of Object.keys(CLASSIC)) assert.ok(parseSvg(icon(name)).children.length, name);
  });

  await test('the style: read from <html data-icons>, changed by RT.icon.setStyle, fixed per icon by {style}', () => {
    assert.equal(renderer('').icon.style(), 'sketch', 'hand-drawn unless the page says classic');
    assert.equal(renderer('nonsense').icon.style(), 'sketch');
    const r = renderer('sketch'), { icon } = r;
    const a = icon('search');
    assert.equal(icon.setStyle('classic'), 'classic'); assert.equal(icon.style(), 'classic'); assert.equal(r.doc.documentElement.dataset.icons, 'classic');
    assert.deepEqual(r.emitted, [['icons:style', 'classic']]);
    assert.equal(parseSvg(icon('search')).attrs.class, 'ic'); assert.notEqual(icon('search'), a);
    assert.equal(icon.setStyle('classic'), 'classic'); assert.equal(r.emitted.length, 1, 'no event when nothing changes');
    assert.equal(icon.setStyle('anything else'), 'sketch'); assert.equal(icon('search'), a);
    // one icon in a fixed set (the two samples in Preferences): no data-i, so a change of style leaves it alone
    const fixedC = parseSvg(icon('library', { style: 'classic' })), fixedS = parseSvg(icon('library', { style: 'sketch' }));
    assert.equal(fixedC.attrs.class, 'ic'); assert.equal(fixedS.attrs.class, 'ic sk'); assert.ok(!('data-i' in fixedC.attrs) && !('data-i' in fixedS.attrs));
    icon.setStyle('classic');
    assert.equal(parseSvg(icon('library', { style: 'sketch' })).attrs.class, 'ic sk'); assert.equal(parseSvg(icon('library')).attrs['data-i'], 'library');
  });

  await test('the page loads both sets before core.js, and ui-boot.js sets the style before the first paint', () => {
    const html = read('public/index.html');
    const at = (s) => { const i = html.indexOf(s); assert.ok(i > 0, s + ' is not in index.html'); return i; };
    assert.ok(at('<script src="js/ui-boot.js">') < at('<script src="js/icons-classic.js">'));
    assert.ok(at('<script src="js/icons-classic.js">') < at('<script src="js/core.js">') && at('<script src="js/icons-sketch.js">') < at('<script src="js/core.js">'));
    assert.ok(!html.includes('js/icons.js'), 'the old file name is gone from the page');
    assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/icons.js')));
    const boot = (stored) => { const d = { dataset: {} }; vm.runInNewContext(read('public/js/ui-boot.js'), { document: { documentElement: d }, localStorage: { getItem: (k) => (k === 'rt.ui.icons' ? stored : null) } }); return d.dataset.icons; };
    assert.equal(boot(null), 'sketch'); assert.equal(boot('classic'), 'classic'); assert.equal(boot('sketch'), 'sketch'); assert.equal(boot('x'), 'sketch');
    // the tokens of the second tone exist for the light theme and for both dark blocks
    const css = read('public/css/base.css');
    assert.equal((css.match(/--sk-wash:/g) || []).length, 3); assert.equal((css.match(/--sk-gold:/g) || []).length >= 3, true);
    for (const cls of ['.ic.sk', '.ic-w', '.ic-au', '.ic-on']) assert.ok(css.includes(cls + ' {'), cls + ' has no rule in base.css');
  });

  await test('settings: iconStyle is hand-drawn by default, checked by PUT /api/settings, kept in settings.json', async () => {
    const core = require('../lib/core');
    const routes = require('../lib/routes/library');
    const call = async (method, url, body) => {
      const u = new URL(url, 'http://localhost'), p = decodeURIComponent(u.pathname);
      let out = null;
      const ctx = { url: u, path: p, segments: p.split('/').filter(Boolean), method, query: u.searchParams, req: null, res: { on() {} }, json: async () => body || {}, send: (code, data) => { out = { code, data }; return true; } };
      try { if (!(await routes.handle(ctx))) return { code: 404, data: null }; } catch (e) { return { code: e.status || 500, data: { error: e.message } }; }
      return out;
    };
    let r = await call('GET', '/api/settings');
    assert.equal(r.code, 200); assert.equal(r.data.iconStyle, 'sketch');
    assert.ok(!('iconStyle' in core.loadSettings()), 'the default is not written');
    for (const bad of ['Classic', 'line', '', null, 1, true, ['classic'], { style: 'classic' }]) {
      r = await call('PUT', '/api/settings', { iconStyle: bad });
      assert.equal(r.code, 400, JSON.stringify(bad)); assert.match(r.data.error, /iconStyle must be 'sketch' or 'classic'/);
    }
    assert.equal((await call('GET', '/api/settings')).data.iconStyle, 'sketch', 'a refused value changes nothing');
    r = await call('PUT', '/api/settings', { iconStyle: 'classic' });
    assert.equal(r.code, 200); assert.equal(r.data.iconStyle, 'classic'); assert.equal(core.loadSettings().iconStyle, 'classic');
    r = await call('PUT', '/api/settings', { draftLanguage: 'en' });
    assert.equal(r.data.iconStyle, 'classic', 'another setting leaves it alone');
    r = await call('PUT', '/api/settings', { iconStyle: 'sketch' });
    assert.equal(r.code, 200); assert.equal(r.data.iconStyle, 'sketch');
    // a settings.json edited by hand: anything else reads as the default
    core.saveSettings({ ...core.loadSettings(), iconStyle: 'crayon' });
    assert.equal((await call('GET', '/api/settings')).data.iconStyle, 'sketch');
  });

  await test('Preferences offers the two styles, in English and in Chinese', () => {
    const prefs = read('public/js/prefs.js');
    for (const s of ['id="pref-icons"', 'data-icons-pick="sketch"', 'data-icons-pick="classic"', 'iconStyle: pickedIcons', 'withIcons(settingsBody())']) assert.ok(prefs.includes(s), s);
    const zh = require('../public/js/i18n/zh.js'), I = require('../public/js/i18n.js');
    const t = I.createTranslator(zh);
    for (const s of ['Icon style', 'Hand-drawn', 'Classic', "How the icons are drawn: by hand with a fountain pen (the app's own set), or as plain lines of one weight.",
      "Hand-drawn icons: the app's own drawings, as if made with a fountain pen", 'Classic icons: plain lines of one weight']) {
      const out = t.translate(s);
      assert.ok(out && out !== s && /[㐀-鿿]/.test(out), `no Chinese for: ${s}`);
    }
  });

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(failed ? `\n${failed} of ${n} failed` : `\nall ${n} icon tests passed`);
  process.exit(failed ? 1 : 0);
})();
