/* Fast hover hints: a styled hint for every button, icon button, link, tab and menu item that has a title (or an
   aria-label and no visible text), shown 150 ms after the pointer rests on it (Preferences > General > Hints on hover:
   fast 150 ms, normal 500 ms, off = the browser's own tooltip) and when the keyboard focuses it (:focus-visible).
   - the element's title moves to data-rt-title while the hint shows (no second, native tooltip) and comes back after
   - the hint is a popover (top layer), so it shows above modal dialogs; without the popover API it is put inside the
     open dialog the element sits in
   - it never takes a click (pointer-events: none) and hides on mousedown, click, scroll, Esc, blur and when the
     element leaves the page
   - element[data-tip] gives a hint text of its own; data-tip="" or data-no-tip switches the hint off for an element
   RT.tips = { configure(), hide() } */
(() => {
  const SEL = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="radio"], [role="link"], summary, label.ib, [data-tip]';
  const DELAY = { fast: 150, normal: 500 };
  const mode = () => document.documentElement.dataset.hints || 'fast';
  const canPop = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

  const tip = document.createElement('div');
  tip.className = 'rt-tip'; tip.setAttribute('role', 'tooltip'); tip.id = 'rt-tip';
  if (canPop) tip.setAttribute('popover', 'manual');
  const body = document.createElement('span'); body.className = 'rt-tip-text';
  tip.append(body);
  document.body.append(tip);

  let cur = null, timer = 0, watch = 0, lastHide = 0;

  // the hint text of an element, or '' when it has none
  function textOf(el) {
    if (el.hasAttribute('data-no-tip')) return '';
    if (el.hasAttribute('data-tip')) return el.getAttribute('data-tip').trim();
    const t = (el.getAttribute('title') || el.getAttribute('data-rt-title') || '').trim();
    const seen = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t === seen ? '' : t; // a title that only repeats the label adds nothing
    const a = (el.getAttribute('aria-label') || '').trim();
    return a && !seen ? a : ''; // an icon-only button: its accessible name
  }
  const targetOf = (node) => {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && el !== document.body) {
      el = el.closest(SEL);
      if (!el) return null;
      if (textOf(el)) return el;
      el = el.parentElement;
    }
    return null;
  };
  const tr = (s) => { try { return window.RT && RT.i18n && typeof RT.i18n.t === 'function' ? RT.i18n.t(s) : s; } catch { return s; } };

  function place(el) {
    const r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    tip.style.left = '0px'; tip.style.top = '0px';
    const w = tip.offsetWidth, h = tip.offsetHeight, gap = 8, pad = 6;
    const above = r.top - h - gap >= pad || r.bottom + h + gap > vh - pad;
    const top = above ? Math.max(pad, r.top - h - gap) : r.bottom + gap;
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(pad, cx - w / 2), Math.max(pad, vw - w - pad));
    tip.style.left = Math.round(left) + 'px'; tip.style.top = Math.round(top) + 'px';
    tip.style.setProperty('--rt-tip-x', Math.round(Math.min(Math.max(10, cx - left), w - 10)) + 'px');
    tip.dataset.side = above ? 'top' : 'bottom';
  }
  function show(el) {
    const text = textOf(el);
    if (!text || !el.isConnected) return;
    if (cur && cur !== el) restore(cur);
    cur = el;
    if (el.hasAttribute('title')) { el.setAttribute('data-rt-title', el.getAttribute('title')); el.removeAttribute('title'); }
    body.textContent = tr(text);
    // inside a modal dialog without the popover API: render in that dialog (the top layer) so it is not behind it
    const host = canPop ? document.body : (el.closest('dialog[open]') || document.body);
    if (tip.parentNode !== host) host.append(tip);
    if (canPop) { try { if (tip.matches(':popover-open')) tip.hidePopover(); tip.showPopover(); } catch { /* not connected */ } }
    tip.classList.add('on');
    place(el);
    el.setAttribute('aria-describedby', ((el.getAttribute('aria-describedby') || '').replace(/\brt-tip\b/, '').trim() + ' rt-tip').trim());
    clearInterval(watch);
    watch = setInterval(() => { if (!cur || !cur.isConnected || cur.closest('[hidden], [inert]')) hide(); }, 400);
  }
  function restore(el) {
    if (el.hasAttribute('data-rt-title')) {
      if (!el.hasAttribute('title')) el.setAttribute('title', el.getAttribute('data-rt-title')); // a title set meanwhile wins
      el.removeAttribute('data-rt-title');
    }
    const d = (el.getAttribute('aria-describedby') || '').replace(/\brt-tip\b/, '').trim();
    if (d) el.setAttribute('aria-describedby', d); else el.removeAttribute('aria-describedby');
  }
  function hide() {
    clearTimeout(timer); clearInterval(watch); timer = 0;
    if (!cur) return;
    restore(cur); cur = null; lastHide = Date.now();
    tip.classList.remove('on');
    if (canPop) { try { if (tip.matches(':popover-open')) tip.hidePopover(); } catch { /* fine */ } }
  }
  function schedule(el) {
    clearTimeout(timer);
    const m = mode();
    if (m === 'off') return;
    // moving from one hint to the next (a toolbar): no wait
    const wait = cur || Date.now() - lastHide < 300 ? 0 : DELAY[m] || DELAY.fast;
    timer = setTimeout(() => show(el), wait);
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || mode() === 'off') return;
    const el = targetOf(e.target);
    if (el === cur) { clearTimeout(timer); return; }
    if (!el) { if (cur || timer) hide(); return; }
    schedule(el);
  }, true);
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget;
    const from = targetOf(e.target);
    if (!from) return;
    if (to && from.contains(to)) return;
    if (from === cur || !cur) { clearTimeout(timer); timer = 0; }
    if (!to || targetOf(to) !== cur) hide();
  }, true);
  document.addEventListener('focusin', (e) => {
    if (mode() === 'off') return;
    const el = targetOf(e.target);
    if (!el || el !== e.target) return;
    let fv = false; try { fv = el.matches(':focus-visible'); } catch { /* old browser */ }
    if (fv) schedule(el);
  });
  document.addEventListener('focusout', (e) => { if (cur && e.target === cur) hide(); });
  for (const ev of ['pointerdown', 'mousedown', 'click', 'wheel']) document.addEventListener(ev, () => { if (cur || timer) hide(); }, true);
  document.addEventListener('scroll', () => { if (cur || timer) hide(); }, true);
  document.addEventListener('keydown', (e) => {
    if (!(cur || timer) || ['Tab', 'Shift'].includes(e.key)) return;
    // the first Esc only dismisses a hint that shows (the WAI-ARIA tooltip pattern): it does not also close the
    // dialog or panel under it (Preferences would lose its unsaved changes)
    const shown = e.key === 'Escape' && cur && tip.classList.contains('on');
    hide();
    if (shown) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('visibilitychange', hide);
  // a dialog opening or closing changes the top layer: the hint goes away and comes back on the next hover
  document.addEventListener('close', hide, true);

  window.RT = window.RT || {};
  RT.tips = { configure() { if (mode() === 'off') hide(); }, hide };
})();
