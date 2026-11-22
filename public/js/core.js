/* ResearchTool front end — core: the RT namespace every module builds on. See ARCHITECTURE.md.
   Load order (index.html): vendor libs, core.js, claude.js, feature modules. */
window.RT = (() => {
  // ---------------- helpers ----------------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); return fn(...a); }; return d; };
  const enc = encodeURIComponent;

  async function api(url, opts = {}) {
    opts.headers = { ...(opts.headers || {}), 'X-RT': '1' }; // the server refuses state-changing calls without it
    if (opts.json !== undefined) { opts.body = JSON.stringify(opts.json); opts.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 503 && data.damaged) { window.RT_LIBRARY_DAMAGED = true; emit('library:damaged'); } // safety.js offers to restore a copy
      throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data });
    }
    return data;
  }
  // a download through fetch (also for a POST): saves the answer under the name of its Content-Disposition and returns
  // {name, size, headers}; errors throw like api()
  async function downloadFile(url, opts = {}) {
    opts.headers = { ...(opts.headers || {}), 'X-RT': '1' };
    if (opts.json !== undefined) { opts.body = JSON.stringify(opts.json); opts.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, opts);
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data }); }
    const cd = r.headers.get('Content-Disposition') || '';
    let name = 'download';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    const blob = await r.blob(), href = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = href; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    return { name, size: blob.size, headers: r.headers };
  }
  let toastTimer;
  // action: {label, icon = 'undo', run} adds one button after the message (the Undo of a delete); the message then
  // stays a little longer
  // the display language (i18n.js, loaded after core.js) translates the toast in the page, keeping the English source
  // so a later language switch can re-translate it; t() is only for what is not DOM (the native confirm / prompt)
  const tr = (s) => (s && RT.i18n && typeof RT.i18n.t === 'function' ? RT.i18n.t(s) : s);
  let toastSeq = 0;
  function toast(msg, kind = '', action = null) {
    const seq = ++toastSeq;
    const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + kind; t.title = msg;
    if (action && msg) {
      t.innerHTML = `<span class="toast-msg">${esc(msg)}</span><button class="ib toast-act" title="${esc(action.label)}" aria-label="${esc(action.label)}">${icon(action.icon || 'undo')}</button>`;
      t.classList.add('has-act');
      // the shown text may be the translation: "this toast is still up" is its sequence number
      t.lastChild.addEventListener('click', () => { if (seq === toastSeq) toast(''); action.run(); }, { once: true });
    }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.textContent = ''), action ? 20000 : 9000);
  }
  // In-page replacements for confirm() and prompt(): the styled dialogs of write.js (RT.write.ui), which loads later -
  // so these are for event time only. confirm(message, {title, okText, danger, icon}) -> Promise<boolean>;
  // ask({title, message, value, placeholder, okText, icon}) -> Promise<string | null>
  const confirmDlg = (message, opts) => (RT.write && RT.write.ui ? RT.write.ui.confirmDlg(message, opts) : Promise.resolve(window.confirm(tr(message))));
  const askDlg = (opts) => (RT.write && RT.write.ui ? RT.write.ui.ask(opts) : Promise.resolve(window.prompt(tr(opts.message || opts.title || ''), opts.value || '')));
  // localStorage that never throws
  const ls = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  };
  // "Smith & Jones", "Smith et al." from a BibTeX author field
  const authorsShort = (a) => { const p = String(a || '').split(/\s+and\s+/i).filter(Boolean); if (!p.length) return 'Unknown author'; const last = (n) => (n.includes(',') ? n.split(',')[0] : n.split(/\s+/).pop()); return p.length > 2 ? last(p[0]) + ' et al.' : p.map(last).join(' & '); };
  // a metadata line with the authors set in the author font: <span class="au">A &amp; B</span> · 2024 · venue (HTML; the rest is escaped)
  const byline = (authors, rest = []) => { const r = rest.filter((x) => x !== '' && x != null).map((x) => esc(String(x))).join(' · '); return (authors ? `<span class="au">${esc(authors)}</span>` + (r ? ' · ' : '') : '') + r; };

  // lazy loading of vendored libraries (everything under /vendor, never a CDN)
  const loaded = new Map();
  function loadScript(src) {
    if (!loaded.has(src)) loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src;
      s.onload = () => resolve(); s.onerror = () => { loaded.delete(src); s.remove(); reject(new Error('Could not load ' + src)); };
      document.head.append(s);
    }));
    return loaded.get(src);
  }
  function loadCss(href) {
    if (!loaded.has(href)) loaded.set(href, new Promise((resolve, reject) => {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
      l.onload = () => resolve(); l.onerror = () => { loaded.delete(href); l.remove(); reject(new Error('Could not load ' + href)); };
      // vendor styles go before the app's own style sheets so the app can override them
      const first = $('link[rel=stylesheet][href^="css/"], link[rel=stylesheet][href^="/css/"]');
      if (first) first.before(l); else document.head.append(l);
    }));
    return loaded.get(href);
  }
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  let vditorIcons = null;
  const vendor = {
    VDITOR_CDN: '/vendor/vditor', // pass as Vditor option  cdn
    // resolves to window.Vditor; create editors with  new Vditor(el, { cdn: RT.vendor.VDITOR_CDN, ... })
    async vditor() {
      await Promise.all([loadCss('/vendor/vditor/dist/index.css'), loadScript('/vendor/vditor/dist/index.min.js'), loadScript('/vendor/vditor/dist/js/icons/ant.js')]);
      // Vditor would fetch its icon set and run it as an INLINE script, which the page's Content-Security-Policy
      // forbids. It skips that when an element with this id exists, so the file loaded above (by src) stands in.
      // Vditor's destroy() removes that element again, so it is kept here and put back (already run, it does not run twice)
      if (!vditorIcons) vditorIcons = document.querySelector('script[src="/vendor/vditor/dist/js/icons/ant.js"]');
      if (vditorIcons) { if (!document.getElementById('vditorIconScript')) vditorIcons.id = 'vditorIconScript'; if (!vditorIcons.isConnected) document.head.append(vditorIcons); }
      return window.Vditor;
    },
  };

  // ---------------- event bus ----------------
  const listeners = new Map();
  function on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => off(ev, fn); }
  function off(ev, fn) { const s = listeners.get(ev); if (s) s.delete(fn); }
  // a listener that throws (or returns a rejected promise) never breaks the emitter or the other listeners
  function emit(ev, data) {
    for (const fn of [...(listeners.get(ev) || [])]) {
      try { const r = fn(data); if (r && typeof r.catch === 'function') r.catch((e) => console.error(`RT listener for '${ev}' failed:`, e)); }
      catch (e) { console.error(`RT listener for '${ev}' failed:`, e); }
    }
  }

  // ---------------- shared state ----------------
  const state = { view: null, sel: null, status: {} };

  // ---------------- views (tabs) ----------------
  const views = new Map(); // id -> { id, title, shortLabel, icon, order, hidden, el, tab, onShow, onHide, onDrop }
  // v.hidden: a view without a tab (reached through RT.nav / RT.setView); v.shortLabel: the tab's label when the
  // title is long (the title stays the hint and the accessible name)
  const TAB_ICONS = { library: 'library', write: 'editor', overview: 'dashboard' };
  function registerView(v) {
    if (!v || !v.id) throw new Error('registerView needs an id');
    let el = $('#view-' + v.id);
    if (!el) { el = document.createElement('section'); el.id = 'view-' + v.id; el.className = 'view'; $('#claude').before(el); }
    // the header's own icons for the known views (Write is "editor", not the pencil of an edit action)
    if (TAB_ICONS[v.id]) v = { ...v, icon: TAB_ICONS[v.id] };
    const tab = document.createElement('button');
    tab.className = 'tab ib'; tab.dataset.view = v.id; tab.title = v.title || v.id; tab.setAttribute('aria-label', v.title || v.id);
    // icon and label always; below 1100px the inactive tabs fold to the icon (base.css), the title is then the hint
    tab.innerHTML = v.icon ? `${icon(v.icon)}<span class="tab-label">${esc(v.shortLabel || v.title || v.id)}</span>` : esc(v.shortLabel || v.title || v.id);
    if (v.icon) tab.classList.add('has-label');
    if (v.hidden) tab.hidden = true;
    tab.addEventListener('click', () => setView(v.id));
    const view = { order: 100, ...v, el, tab };
    views.set(v.id, view);
    const nav = $('header nav');
    const sorted = [...views.values()].sort((a, b) => a.order - b.order);
    nav.replaceChildren(...sorted.map((x) => x.tab));
    if (state.view) for (const x of views.values()) x.tab.classList.toggle('active', x.id === state.view);
    return view;
  }
  function setView(id) {
    if (!views.has(id)) return;
    const prev = state.view;
    state.view = id;
    for (const v of views.values()) { v.tab.classList.toggle('active', v.id === id); v.el.classList.toggle('active', v.id === id); if (v.id === id) v.tab.setAttribute('aria-current', 'page'); else v.tab.removeAttribute('aria-current'); }
    const call = (fn) => { try { if (fn) fn(); } catch (e) { console.error(e); } };
    if (prev && prev !== id && views.has(prev)) call(views.get(prev).onHide);
    call(views.get(id).onShow);
    emit('view:changed', { view: id, previous: prev });
    claudeContext.refresh();
  }

  // ---------------- Claude context providers (one per view) ----------------
  const ctxProviders = new Map();
  const claudeContext = {
    // fn() -> { label, title, context }   label/title are shown in the Claude panel head, context is sent to /api/claude
    register(viewId, fn) { ctxProviders.set(viewId, fn); },
    current() {
      const fn = ctxProviders.get(state.view);
      let c = null;
      try { c = fn ? fn() : null; } catch (e) { console.error(e); }
      return { label: '', title: '', context: {}, ...(c || {}) };
    },
    refresh() { emit('claude:context', claudeContext.current()); },
  };

  // ---------------- flushers: "save what is pending" hooks ----------------
  const flushers = new Map(); // name -> async () => boolean | void   (false = something could not be saved)
  function addFlusher(name, fn) { flushers.set(name, fn); }
  // run the named flushers (all of them when no name is given), in registration order; false if any returned false
  async function flush(...names) {
    let ok = true;
    for (const [name, fn] of flushers) {
      if (names.length && !names.includes(name)) continue;
      if ((await fn()) === false) ok = false;
    }
    return ok;
  }

  // ---------------- drag & drop of files: the active view decides what a drop means ----------------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (!e.dataTransfer.files.length) return;
    const v = views.get(state.view);
    if (v && v.onDrop) v.onDrop(e);
  });

  // ---------------- icons: RT.icon(name, {size, duo, cls}) ----------------
  // The Ginseng line icons on a 24 grid (js/icons.js: RT_ICON_DEFS, loaded before this file). Old names of the former
  // 16-grid set keep working through ICON_ALIAS; a name that starts with "M" is a raw SVG path on the old 16 grid
  // (stroke 1.4), drawn as before, for an icon the set lacks.
  const ICON_ALIAS = {
    trash: 'delete', gear: 'settings', open: 'external-link', plus: 'add', pencil: 'edit', books: 'library', eyeOff: 'eye-off',
    pull: 'download', push: 'upload', arrowLeft: 'arrow-left', arrowRight: 'arrow-right', zip: 'archive', folderOpen: 'folder',
    label: 'tag', reset: 'refresh', cloud: 'overleaf-sync', camera: 'figure', view: 'filter', swap: 'swap-panes',
    max: 'maximize', newFile: 'new-file',
    // the names of the Editor (write.js), so it can hand its icons over
    chevDown: 'chevron-down', chevRight: 'chevron-right', up: 'chevron-up', files: 'paper', file: 'paper', oneFile: 'paper',
    allFiles: 'copy', tex: 'latex', bib: 'bibtex', papers: 'library', ref: 'citation', cite: 'citation', ul: 'list', ol: 'list-ordered',
    labelAdd: 'tag', layout: 'sidebar', panel: 'sidebar', newFolder: 'new-folder',
  };
  const ICON_DEFS = window.RT_ICON_DEFS || {}, ICON_GEN_ALIAS = window.RT_ICON_ALIASES || {};
  const resolveIcon = (name) => { let n = ICON_ALIAS[name] || name; n = ICON_GEN_ALIAS[n] || n; return ICON_DEFS[n] ? n : null; };
  const attrEsc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const iconEls = (list, cls) => list.map(([tag, at]) => `<${tag}${cls ? ` class="${cls}"` : ''}${Object.entries(at).map(([k, v]) => ` ${k}="${attrEsc(v)}"`).join('')}/>`).join('');
  const iconCache = new Map(), iconWarned = new Set();
  // stroke by size, as the design system does: 2 up to 17px, 1.75 up to 31px, 1.5 from 32px
  const strokeFor = (px) => (px <= 17 ? 2 : px < 32 ? 1.75 : 1.5);
  function icon(name, opts = {}) {
    if (typeof opts === 'string') opts = { cls: opts };
    const { size, duo = false, cls = '' } = opts || {};
    const key = `${name}|${size || ''}|${duo ? 1 : 0}|${cls}`;
    if (iconCache.has(key)) return iconCache.get(key);
    const dim = size ? ` width="${size}" height="${size}" style="width:${size}px;height:${size}px"` : '';
    const klass = 'ic' + (cls ? ' ' + cls : '');
    let out;
    if (/^M/.test(String(name || ''))) {
      out = `<svg class="${klass}" viewBox="0 0 16 16"${dim} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${attrEsc(name)}"/></svg>`;
    } else {
      const n = resolveIcon(name), d = n && ICON_DEFS[n];
      if (!d && name && !iconWarned.has(name)) { iconWarned.add(name); console.warn(`RT.icon: no icon named '${name}'`); }
      out = `<svg class="${klass}" viewBox="0 0 24 24"${dim} fill="none" stroke="currentColor" stroke-width="${strokeFor(size || 16)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d ? (duo && d.d ? iconEls(d.d, 'ic-duo') : '') + iconEls(d.o) : ''}</svg>`;
    }
    iconCache.set(key, out);
    return out;
  }
  icon.has = (name) => /^M/.test(String(name || '')) || !!resolveIcon(name);
  icon.names = () => Object.keys(ICON_DEFS);
  icon.aliases = () => ({ ...ICON_GEN_ALIAS, ...ICON_ALIAS });
  // every icon on one sheet (a check, not used by the app): RT.icon.sheet(el, {duo, size})
  icon.sheet = (el, { duo = false, size = 24 } = {}) => {
    const added = new Set(window.RT_ICON_ADDED || []);
    el.innerHTML = `<div class="ic-sheet">${icon.names().map((n) => `<figure class="${added.has(n) ? 'new' : ''}">${icon(n, { size, duo })}<figcaption>${esc(n)}</figcaption></figure>`).join('')}</div>`;
    return el;
  };

  // ---------------- the crest: RT.crest(size = 28, {variant: 'color' | 'inverse' | 'mono'}) ----------------
  // The brand mark (a shield with an open book and a quill; public/brand/crest-mark.svg). Decorative (aria-hidden);
  // each call has its own gradient id. In the dark theme the rim of the colour variant follows --crest-rim.
  const CREST = {
    outer: 'M3 2.5H29V13.5C29 22 23.2 27 16 30.2C8.8 27 3 22 3 13.5Z', inner: 'M4.4 3.9H27.6V13.5C27.6 21.1 22.4 25.6 16 28.6C9.6 25.6 4.4 21.1 4.4 13.5Z',
    pageL: 'M16 13.6C13.3 12 10.3 11.6 7.4 12.3V21.4C10.3 20.8 13.3 21.3 16 22.9Z', pageR: 'M16 13.6C18.7 12 21.7 11.6 24.6 12.3V21.4C21.7 20.8 18.7 21.3 16 22.9Z',
    quill: 'M16.6 12.6C18.4 8.6 21 6.2 24.4 5.1C23.8 8.6 21.4 11.3 17.4 13.1Z', nib: 'M15.2 15.8L23.6 5.8',
  };
  let crestSeq = 0;
  function crest(size = 28, { variant = 'color', cls = '' } = {}) {
    const id = `rt-crest-g${++crestSeq}`, k = 'crest' + (cls ? ' ' + cls : '');
    const head = `<svg class="${k}" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">`;
    if (variant === 'mono') {
      return `${head}<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><path d="${CREST.outer}" fill="#fff"/><path d="${CREST.inner}" fill="none" stroke="#000" stroke-width="1.1"/><path d="${CREST.pageL}" fill="#000"/><path d="${CREST.pageR}" fill="#000"/><path d="${CREST.quill}" fill="#000"/></mask></defs><path d="${CREST.outer}" fill="currentColor" mask="url(#${id})"/></svg>`;
    }
    return `${head}<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#f0d27a"/><stop offset="0.5" stop-color="#e2bd55"/><stop offset="1" stop-color="#c9971a"/></linearGradient></defs>`
      + `<path${variant === 'inverse' ? '' : ' class="rim"'} d="${CREST.outer}" fill="${variant === 'inverse' ? '#fbf7ee' : '#4a2a80'}"/><path d="${CREST.inner}" fill="#7b4cc2" stroke="url(#${id})" stroke-width="1.4"/>`
      + `<path d="${CREST.pageL}" fill="url(#${id})"/><path d="${CREST.pageR}" fill="url(#${id})"/><path d="${CREST.quill}" fill="#fbf7ee" stroke="#2e1a52" stroke-width="0.5"/><path d="${CREST.nib}" stroke="#2e1a52" stroke-width="0.9" stroke-linecap="round"/></svg>`;
  }

  // ---------------- keys: the modifier of this machine ----------------
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const modKey = MAC ? '⌘' : 'Ctrl';
  // key caps: kbd(['⌘', 'K']) or kbd('?') -> <kbd class="kc">…</kbd> (HTML)
  const kbd = (keys) => (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map((k) => `<kbd class="kc">${esc(k)}</kbd>`).join('');
  const typingIn = (t) => !!(t && t.closest && (t.isContentEditable || t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .CodeMirror, .vditor')));

  // ---------------- menus: RT.menu(anchor, items, {align}) ----------------
  // items: [{label, icon, kbd, onClick(e), id, title, danger, disabled, sub: [items]} | {sep: true} | {heading: 'Group'}]
  // Arrow keys, Home / End, Enter, Esc, type-ahead; a click outside or Esc closes it and the focus goes back to the
  // anchor. It sits in the top layer (popover), so it also shows over a modal dialog. Returns {el, close}.
  const canPop = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
  let rootMenu = null;
  function menu(anchor, items, opts = {}) {
    const { align = 'start', side = false, parent = null, onClose = null } = opts;
    if (!parent && rootMenu) rootMenu.close(false);
    const el = document.createElement('div');
    el.className = 'menu rt-menu'; el.setAttribute('role', 'menu');
    if (canPop) el.setAttribute('popover', 'manual');
    const entries = [];
    for (const it of items || []) {
      if (!it) continue;
      if (it.sep) { if (el.lastElementChild && el.lastElementChild.tagName !== 'HR') { const hr = document.createElement('hr'); hr.setAttribute('role', 'separator'); el.append(hr); } continue; }
      if (it.heading) { const h = document.createElement('div'); h.className = 'mi-head'; h.setAttribute('role', 'presentation'); h.textContent = it.heading; el.append(h); if (!it.label) continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'mi' + (it.danger ? ' danger' : ''); b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
      if (it.id) b.id = it.id;
      if (it.title) b.title = it.title;
      if (it.disabled) b.disabled = true;
      if (it.sub) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
      b.innerHTML = `${it.icon ? icon(it.icon) : ''}<span class="mi-label"></span>${it.kbd ? `<span class="mi-kbd">${kbd(it.kbd)}</span>` : ''}${it.sub ? `<span class="mi-sub">${icon('chevron-right')}</span>` : ''}`;
      b.querySelector('.mi-label').textContent = it.label;
      el.append(b); entries.push({ b, it });
    }
    if (el.lastElementChild && el.lastElementChild.tagName === 'HR') el.lastElementChild.remove();
    const host = !canPop && anchor && anchor.closest ? anchor.closest('dialog[open]') || document.body : document.body;
    host.append(el);
    if (canPop) { try { el.showPopover(); } catch { /* not in the document */ } }
    // place it by the anchor, inside the window
    const place = () => {
      const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 8, right: 8, top: 8, bottom: 8 };
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      let x, y;
      if (side) { x = a.right + 2; if (x + w > vw - 8) x = a.left - w - 2; y = a.top - 5; }
      else { x = align === 'end' ? a.right - w : a.left; y = a.bottom + 4; if (y + h > vh - 8 && a.top - h - 4 > 8) y = a.top - h - 4; }
      x = Math.max(8, Math.min(x, vw - w - 8)); y = Math.max(8, Math.min(y, vh - h - 8));
      el.style.left = x + 'px'; el.style.top = y + 'px';
    };
    place();
    let child = null, closed = false, hoverTimer = 0;
    const enabled = () => entries.filter((x) => !x.b.disabled).map((x) => x.b);
    const focusAt = (i) => { const list = enabled(); if (!list.length) return; list[(i + list.length) % list.length].focus(); };
    const outside = (e) => {
      if (el.contains(e.target) || (anchor && anchor.contains && anchor.contains(e.target))) return;
      for (let m = child; m; m = m.child) if (m.el.contains(e.target)) return;
      api.close(false);
    };
    const onScroll = (e) => { if (!el.contains(e.target)) api.close(false); };
    const onResize = () => api.close(false);
    const api = {
      el, anchor, get child() { return child; },
      close(refocus = true) {
        if (closed) return;
        closed = true;
        if (child) { child.close(false); child = null; }
        document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        clearTimeout(hoverTimer);
        try { if (canPop && el.matches(':popover-open')) el.hidePopover(); } catch { /* gone */ }
        el.remove();
        if (anchor && anchor.setAttribute && anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'false');
        if (rootMenu === api) rootMenu = null;
        if (refocus && anchor && anchor.focus && anchor.isConnected) anchor.focus();
        if (onClose) { try { onClose(); } catch (e) { console.error(e); } }
      },
    };
    const openSub = (x, focusFirst) => {
      if (child && child.anchor === x.b) { if (focusFirst) child.focusFirst(); return; }
      if (child) child.close(false);
      x.b.setAttribute('aria-expanded', 'true');
      child = menu(x.b, x.it.sub, { side: true, parent: api, onClose: () => { if (child && child.anchor === x.b) child = null; } });
      if (focusFirst) child.focusFirst(); else x.b.focus();
    };
    api.focusFirst = () => focusAt(0);
    const run = (x, e) => {
      if (x.b.disabled) return;
      if (x.it.sub) return openSub(x, e.detail === 0);
      let top = api; while (top.parentMenu) top = top.parentMenu;
      top.close(true);
      if (x.it.onClick) { try { const r = x.it.onClick(e); if (r && r.catch) r.catch((err) => toast(err.message || String(err), 'bad')); } catch (err) { console.error(err); toast(err.message || String(err), 'bad'); } }
    };
    api.parentMenu = parent;
    for (const x of entries) {
      x.b.addEventListener('click', (e) => run(x, e));
      x.b.addEventListener('pointerenter', () => {
        clearTimeout(hoverTimer);
        if (!x.b.disabled) x.b.focus({ preventScroll: true });
        hoverTimer = setTimeout(() => { if (closed) return; if (x.it.sub && !x.b.disabled) openSub(x, false); else if (child) { child.close(false); child = null; } }, 160);
      });
    }
    el.addEventListener('keydown', (e) => {
      const list = enabled(), at = list.indexOf(document.activeElement);
      const x = entries.find((y) => y.b === document.activeElement);
      if (e.key === 'ArrowDown') focusAt(at + 1);
      else if (e.key === 'ArrowUp') focusAt(at < 0 ? -1 : at - 1);
      else if (e.key === 'Home') focusAt(0);
      else if (e.key === 'End') focusAt(-1);
      else if (e.key === 'ArrowRight' && x && x.it.sub) openSub(x, true);
      else if ((e.key === 'ArrowLeft' && parent) || e.key === 'Escape') { api.close(true); }
      else if (e.key === 'Tab') { let top = api; while (top.parentMenu) top = top.parentMenu; top.close(true); return; }
      else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase(), from = Math.max(0, at);
        const hit = [...list.slice(from + 1), ...list.slice(0, from + 1)].find((b) => b.textContent.trim().toLowerCase().startsWith(k));
        if (hit) hit.focus();
      } else return;
      e.preventDefault(); e.stopPropagation();
    });
    if (!parent) {
      rootMenu = api;
      if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
      setTimeout(() => { if (!closed) { document.addEventListener('pointerdown', outside, true); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onResize); } }, 0);
      setTimeout(() => { if (!closed && !el.contains(document.activeElement)) focusAt(0); }, 0);
    }
    return api;
  }
  // a header button that opens a menu: a second click closes it
  function menuButton(btn, items, opts) {
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => { if (rootMenu && rootMenu.anchor === btn) rootMenu.close(true); else menu(btn, typeof items === 'function' ? items() : items, opts); });
  }

  // ---------------- banners: RT.banner.show({id, text, tone, action, dismissible}), RT.banner.hide(id) ----------------
  // A thin notice under the header (#banner-slot). A dismissed banner stays away for 7 days (per id, localStorage
  // rt.ui.banner.dismissed). Strings are English; the display language layer translates them.
  const BANNER_KEY = 'rt.ui.banner.dismissed', BANNER_DAYS = 7;
  const banner = {
    show({ id, text, tone = 'info', action = null, dismissible = true } = {}) {
      const slot = $('#banner-slot');
      if (!slot || !id || !text) return null;
      const gone = ls.json(BANNER_KEY, {}) || {};
      if (dismissible && gone[id] && Date.now() - gone[id] < BANNER_DAYS * 864e5) return null;
      let el = $$('.banner', slot).find((b) => b.dataset.banner === id);
      if (!el) { el = document.createElement('div'); el.dataset.banner = id; slot.append(el); }
      el.className = 'banner ' + tone; el.setAttribute('role', 'status');
      el.innerHTML = `${icon(tone === 'info' ? 'info' : 'warning')}<span class="bn-text"></span>`;
      $('.bn-text', el).textContent = text;
      if (action && action.label) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'bn-act'; b.textContent = action.label;
        b.addEventListener('click', () => { try { action.onClick && action.onClick(); } catch (e) { console.error(e); } });
        el.append(b);
      }
      if (dismissible) {
        const x = document.createElement('button'); x.type = 'button'; x.className = 'ib bn-x'; x.title = 'Dismiss for a week'; x.setAttribute('aria-label', 'Dismiss');
        x.innerHTML = icon('close');
        x.addEventListener('click', () => { const g = ls.json(BANNER_KEY, {}) || {}; g[id] = Date.now(); ls.set(BANNER_KEY, JSON.stringify(g)); banner.hide(id); });
        el.append(x);
      }
      emit('layout:changed');
      return el;
    },
    hide(id) { const slot = $('#banner-slot'); const el = slot && $$('.banner', slot).find((b) => b.dataset.banner === id); if (el) { el.remove(); emit('layout:changed'); } },
  };

  // ---------------- empty states: RT.emptyState({ill, title, text, actions, compact}) -> HTMLElement ----------------
  // ill: a name of RT.ill (illustrations.js) or an SVG string; actions: [{label, icon, primary, id, title, onClick}].
  // Pass English: the display language layer translates the element once it is in the page.
  function emptyState({ ill, title, text, actions = [], compact = false } = {}) {
    const el = document.createElement('div');
    el.className = 'empty-state' + (compact ? ' compact' : '');
    let art = '';
    if (typeof ill === 'string') art = RT.ill && typeof RT.ill[ill] === 'function' ? RT.ill[ill]() : /^\s*<svg/.test(ill) ? ill : '';
    if (art) { const d = document.createElement('div'); d.className = 'es-ill'; d.innerHTML = art; el.append(d); }
    if (title) { const t = document.createElement('p'); t.className = 'es-title'; t.textContent = title; el.append(t); }
    if (text) { const t = document.createElement('p'); t.className = 'es-text'; t.textContent = text; el.append(t); }
    const acts = (actions || []).filter(Boolean);
    if (acts.length) {
      const row = document.createElement('div'); row.className = 'es-actions';
      for (const a of acts) {
        const b = document.createElement('button'); b.type = 'button';
        if (a.primary) b.className = 'primary';
        if (a.id) b.id = a.id;
        if (a.title) b.title = a.title;
        b.innerHTML = `${a.icon ? icon(a.icon) : ''}<span></span>`; b.lastChild.textContent = a.label;
        if (a.onClick) b.addEventListener('click', (e) => { try { const r = a.onClick(e); if (r && r.catch) r.catch((err) => toast(err.message || String(err), 'bad')); } catch (err) { console.error(err); } });
        row.append(b);
      }
      el.append(row);
    }
    return el;
  }

  // ---------------- navigation helpers: RT.nav ----------------
  // Every call is guarded: a module that is missing (or an id another owner moved) only makes the helper do less.
  const clickEl = (...sels) => { for (const s of sels) { const b = $(s); if (b && !b.disabled) { b.click(); return true; } } return false; };
  const guard = (fn) => { try { const r = fn(); if (r && r.catch) r.catch((e) => console.error(e)); return r; } catch (e) { console.error(e); return undefined; } };
  const nav = {
    go(id) { if (views.has(id)) setView(id); else if (views.has('library')) setView('library'); },
    // page: open the PDF there; tab: show that tab of the reader ('notes', ...). Both wait for reader.js to say the
    // paper is on screen (item:shown), with a fallback in case it never says so
    openPaper(id, { page, tab } = {}) {
      setView('library');
      const was = RT.state.sel === id;
      let done = !(page || tab), off = () => {};
      const after = () => {
        if (done) return; done = true; off();
        if (RT.state.sel !== id || !RT.reader) return;
        if (tab && RT.reader.tab) guard(() => RT.reader.tab(tab));
        if (page && RT.reader.page) guard(() => RT.reader.page(Number(page)));
      };
      if (!done) { off = on('item:shown', (e) => { if (e && e.id === id) after(); }); setTimeout(after, was ? 0 : 2500); }
      guard(() => RT.library && RT.library.select && RT.library.select(id));
    },
    search(q) {
      if (!RT.palette || !RT.palette.open) return;
      guard(() => RT.palette.open(q));
      const input = $('#pal-q');
      if (q && input && !input.value) { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); }
    },
    importFiles() { setView('library'); clickEl('#btn-import-pdf'); },
    addById() { setView('library'); clickEl('#btn-add-ref', '#btn-paste-bib'); },
    newProject() { setView('write'); if (RT.projectsHome && RT.projectsHome.create) guard(() => RT.projectsHome.create()); else setTimeout(() => clickEl('#pj-new'), 0); },
    review() { if (RT.quiz && RT.quiz.openReview) guard(() => RT.quiz.openReview()); else clickEl('#btn-review'); },
    compare() { if (RT.compare && RT.compare.open) guard(() => RT.compare.open()); else clickEl('#btn-compare'); },
    preferences(section) { if (RT.prefs && RT.prefs.open) guard(() => RT.prefs.open(section)); else clickEl('#btn-settings'); },
    trash() { if (RT.safety && RT.safety.trash) guard(() => RT.safety.trash()); },
  };

  // ---------------- export of the references (More menu; the hidden #btn-export) ----------------
  // asks first (the folder and the files), then writes them as before
  async function exportReferences() {
    let dir = '';
    try { dir = (await api('/api/settings')).exportDir || ''; } catch { /* the folder is named in the toast afterwards */ }
    const ok = await confirmDlg(`Write references.bib, notes.md, library.csv and the reading notes (the notes/ folder) to ${dir || 'the export folder'}?\n\nFiles of an earlier export there are replaced. The folder is set in Preferences › Library & files.`, { title: 'Export references', okText: 'Export', icon: 'export' });
    if (!ok) return null;
    try {
      await flush('reader');
      const r = await api('/api/export', { method: 'POST' });
      toast(`Exported to the export folder: ${r.dir}`, 'ok');
      return r;
    } catch (e) { toast('Export failed: ' + e.message, 'bad'); return null; }
  }
  $('#btn-export').addEventListener('click', () => { exportReferences(); });

  // ---------------- the header: brand, search, Help, More, Preferences (prefs.js), Claude (claude.js) ----------------
  $('#brand-home').addEventListener('click', (e) => { e.preventDefault(); nav.go(views.has('overview') ? 'overview' : 'library'); });
  { const p = $('#btn-palette'); p.insertAdjacentHTML('afterbegin', icon('search')); $('.sp-keys', p).innerHTML = kbd([modKey, 'K']); }
  $('#btn-export').innerHTML = icon('export'); $('#btn-settings').innerHTML = icon('settings');
  $('#btn-help').innerHTML = icon('help'); $('#btn-app-menu').innerHTML = icon('more');
  $('#btn-claude').innerHTML = `${icon('sparkle')}<span class="ib-text">Claude</span>`;
  menuButton($('#btn-help'), () => [
    { label: 'Guide', icon: 'book-open', onClick: () => RT.guide && RT.guide.open && RT.guide.open() },
    { label: 'Take the tour', icon: 'compass', onClick: () => (RT.tour && RT.tour.start ? RT.tour.start() : clickEl('#btn-tour')) },
    { label: 'Tour of this screen', icon: 'compass', onClick: () => RT.tour && RT.tour.start && RT.tour.start({ chapter: RT.tour.forChapterOfView() }) },
    { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', onClick: () => RT.guide && RT.guide.open && RT.guide.open('files', 'keys') },
  ], { align: 'end' });
  menuButton($('#btn-app-menu'), () => [
    { label: 'Export references…', icon: 'export', onClick: () => exportReferences() },
    { label: 'Recently deleted…', icon: 'delete', onClick: () => nav.trash() },
    { sep: true },
    { label: 'Backups…', icon: 'archive', onClick: () => nav.preferences('library') },
  ], { align: 'end' });
  // the Claude button shows whether the panel is open
  { const panel = $('#claude'), b = $('#btn-claude'); const sync = () => b.setAttribute('aria-pressed', panel.hidden ? 'false' : 'true');
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] }); sync(); }

  // g o / g l / g w: go to the Overview, the Library, Write (outside text fields and dialogs)
  let gAt = 0;
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) { gAt = 0; return; }
    if (document.querySelector('dialog[open]') || (RT.tour && RT.tour.active && RT.tour.active())) return;
    const k = String(e.key).toLowerCase();
    if (gAt && Date.now() - gAt < 1200 && /^[olw]$/.test(k) && !e.shiftKey) {
      gAt = 0;
      const id = { o: 'overview', l: 'library', w: 'write' }[k];
      if (views.has(id)) { e.preventDefault(); setView(id); }
      return;
    }
    gAt = k === 'g' && !e.shiftKey && !e.repeat ? Date.now() : 0;
  });

  // ---------------- disk sync: modules re-read what may have changed outside the app ----------------
  window.addEventListener('focus', () => emit('disk:sync'));

  // ---------------- boot (after every module script has run) ----------------
  // the start view: Preferences > General "Start on" (rt.ui.startView: 'library' default, 'overview', 'last')
  on('view:changed', ({ view }) => ls.set('rt.ui.lastView', view));
  document.addEventListener('DOMContentLoaded', async () => {
    if (!state.view) {
      const pref = ls.get('rt.ui.startView', 'library');
      let want = pref === 'last' ? ls.get('rt.ui.lastView', 'library') : pref;
      if (!views.has(want)) want = views.has('library') ? 'library' : [...views.values()].sort((a, b) => a.order - b.order)[0]?.id;
      setView(want);
    }
    try {
      state.status = await api('/api/status');
      emit('status', state.status);
      const missing = [!state.status.pdftotext && 'pdftotext (PDF import)', !state.status.latexmk && 'latexmk (LaTeX preview)', !state.status.claude && 'claude CLI (Claude panel)'].filter(Boolean);
      if (missing.length) banner.show({ id: 'tools-missing', tone: 'info', text: 'Not found on this machine: ' + missing.join(', ') });
    } catch {}
  });

  // ---------------- page citations ----------------
  // Claude ends what it takes from the paper with its page: "(p. 4)", "(p. 4, 7)", "(Fig. 2, pp. 4-5)". Wherever an
  // explanation is shown, each page becomes a chip that shows that page of the open paper's PDF; "(general
  // knowledge)" is set apart. RT.cite(html) works on HTML that is already safe (text outside tags only),
  // RT.cite.dom(root) on rendered elements, RT.cite.md(text) writes the note's own page links, RT.cite.find(text)
  // only reports where the pages are (the note editor marks them without changing its content).
  const CITE_GROUP = /[（(][^()（）<>]{0,80}[)）]/g, CITE_PAGES = /(?<![\w\[])(pp?\.\s*)(\d{1,4})((?:\s*(?:[-–,，、]|and|和)\s*(?:pp?\.\s*)?\d{1,4})*)/g;
  const CITE_GEN = /[（(]\s*(?:general knowledge|通用知识|一般知识|常识)\s*[)）]/gi;
  // every page of `text` as {at, len, page, first}: the piece of text to mark ("p. 4", then "7") and its page
  function citeFind(text) {
    const out = [];
    for (const g of String(text).matchAll(CITE_GROUP)) for (const m of g[0].matchAll(CITE_PAGES)) {
      const at = g.index + m.index;
      out.push({ at, len: m[1].length + m[2].length, page: Number(m[2]), first: true });
      for (const n of m[3].matchAll(/\d{1,4}/g)) out.push({ at: at + m[1].length + m[2].length + n.index, len: n[0].length, page: Number(n[0]), first: false });
    }
    return out.filter((c) => c.page > 0);
  }
  const citeEach = (text, fn) => { let out = '', last = 0; for (const c of citeFind(text)) { out += text.slice(last, c.at) + fn(c, text.slice(c.at, c.at + c.len)); last = c.at + c.len; } return out + text.slice(last); };
  const citeChip = (c, shown) => `<span class="pcite" role="link" tabindex="0" data-pcite="${c.page}" title="Show page ${c.page} of the PDF">${shown}</span>`;
  const citeText = (t) => citeEach(t, citeChip).replace(CITE_GEN, (m) => `<span class="pcite-gen" title="Not from this paper: general knowledge">${m}</span>`);
  function cite(html) {
    let skip = null, depth = 0;
    return String(html).split(/(<[^>]*>)/).map((part, i) => {
      if (i % 2 === 0) return skip || !part ? part : citeText(part);
      const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(part);
      if (!m) return part;
      const tag = m[2].toLowerCase();
      if (skip) { if (tag === skip) { depth += m[1] ? -1 : 1; if (!depth) skip = null; } }
      else if (!m[1] && (/^(code|pre|a|textarea|script|style)$/.test(tag) || /class="[^"]*\b(dg-math|katex|pcite)/.test(part))) { skip = tag; depth = 1; }
      return part;
    }).join('');
  }
  cite.find = citeFind;
  cite.md = (text) => citeEach(String(text), (c) => `[p. ${c.page}](#rt-page=${c.page})`);
  cite.dom = (root) => {
    if (!root) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), hits = [];
    for (let n; (n = tw.nextNode());) {
      if ((!citeFind(n.data).length && !n.data.match(CITE_GEN)) || !n.parentElement || n.parentElement.closest('code, pre, a, textarea, .katex, .language-math, .dg-math, .pcite, .pcite-gen, [contenteditable="true"]')) continue;
      hits.push(n);
    }
    for (const n of hits) { const box = document.createElement('span'); box.innerHTML = citeText(esc(n.data)); n.replaceWith(...box.childNodes); }
  };
  // one handler for every chip, before the handlers of what it sits in (a quiz card is itself a button)
  const citeGo = (e) => {
    const c = e.target && e.target.closest ? e.target.closest('.pcite[data-pcite]') : null;
    if (!c || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); e.stopPropagation();
    if (window.RT && RT.reader && RT.reader.page) RT.reader.page(Number(c.dataset.pcite));
  };
  document.addEventListener('click', citeGo, true);
  document.addEventListener('keydown', citeGo, true);

  return { $, $$, esc, debounce, enc, api, downloadFile, toast, confirm: confirmDlg, ask: askDlg, ls, icon, crest, authorsShort, byline, loadScript, loadCss, vendor, cite,
    on, off, emit, state, views, registerView, setView, claudeContext, addFlusher, flush,
    menu, banner, emptyState, nav, modKey, isMac: MAC, kbd, exportReferences };
})();
