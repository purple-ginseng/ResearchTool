/* Loaded in <head> before the first paint: the per-browser UI preferences of prefs.js that change how the page looks.
   <html data-theme="light|dark"> (absent: follow the system) and <html data-hints="fast|normal|off"> (tips.js). */
(() => {
  const d = document.documentElement;
  let theme = null, hints = null, lang = null;
  try { theme = localStorage.getItem('rt.ui.theme'); hints = localStorage.getItem('rt.ui.hints'); lang = localStorage.getItem('rt.ui.lang'); } catch { /* no storage */ }
  if (theme === 'light' || theme === 'dark') d.dataset.theme = theme;
  // the display language (i18n.js): <html lang> picks the CJK font fallbacks from the first paint
  if (lang === 'zh') { d.lang = 'zh-CN'; d.dataset.lang = 'zh'; }
  d.dataset.hints = hints === 'normal' || hints === 'off' ? hints : 'fast';
})();
