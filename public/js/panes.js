/* Resizable side panes: drag the right edge of the Library list or the left edge of the Claude panel; double-click
   puts the default width back. The widths are CSS variables on <html> (--list-w, --claude-w) kept in localStorage.
   (The PDF / notes divider of the reader and the dividers of the Write tab belong to reader.js and write.js.) */
(() => {
  const { $, ls } = RT;
  const root = document.documentElement;

  // pane: { host (the handle is appended to it), name (CSS variable), key (localStorage), def, min, max(), sign }
  // sign: +1 when dragging right makes the pane wider (it sits on the left), -1 for a pane on the right
  function resizable(p) {
    if (!p.host) return;
    const h = document.createElement('div');
    h.className = 'pane-resize'; h.title = 'Drag to resize · double-click to reset';
    h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'vertical'); h.tabIndex = 0;
    p.host.append(h);
    const clamp = (w) => Math.round(Math.max(p.min, Math.min(p.max(), w)));
    const apply = (w) => { if (w == null) root.style.removeProperty(p.name); else root.style.setProperty(p.name, clamp(w) + 'px'); };
    const width = () => parseFloat(getComputedStyle(root).getPropertyValue(p.name)) || p.def;
    const store = (w) => { if (w == null) ls.set(p.key, ''); else ls.set(p.key, String(clamp(w))); RT.emit('layout:changed'); };
    const saved = Number(ls.get(p.key, ''));
    if (saved > 0) apply(saved);

    let drag = null;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, w: width(), now: null };
      try { h.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
      h.classList.add('on'); document.body.classList.add('pane-dragging');
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.now = clamp(drag.w + p.sign * (e.clientX - drag.x));
      apply(drag.now); // the PDF and the editors follow through their own size observers; layout:changed is sent once at the end
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      h.classList.remove('on'); document.body.classList.remove('pane-dragging');
      if (d.now != null) store(d.now);
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => { apply(null); store(null); });
    h.addEventListener('keydown', (e) => { // arrow keys for the keyboard
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const w = clamp(width() + p.sign * (e.key === 'ArrowRight' ? 24 : -24));
      apply(w); store(w);
    });
    // a window made narrower must not leave a pane wider than its limit
    window.addEventListener('resize', () => { const w = Number(ls.get(p.key, '')); if (w > 0) apply(w); });
  }

  // each pane leaves room for the other one and for the reader between them
  const READER = 360;
  const claudeW = () => { const c = $('#claude'); return c && !c.hidden ? c.getBoundingClientRect().width : 0; };
  const listW = () => { const v = $('#view-library'); return v && v.classList.contains('active') ? parseFloat(getComputedStyle(root).getPropertyValue('--list-w')) || 360 : 0; };
  resizable({ host: $('#view-library'), name: '--list-w', key: 'rt.list.w', def: 360, min: 220, max: () => Math.max(220, Math.min(640, window.innerWidth * 0.45, window.innerWidth - claudeW() - READER)), sign: 1 });
  resizable({ host: $('#claude'), name: '--claude-w', key: 'rt.claude.w', def: 380, min: 280, max: () => Math.max(280, Math.min(900, window.innerWidth * 0.6, window.innerWidth - listW() - READER)), sign: -1 });
})();
