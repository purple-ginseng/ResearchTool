/* Loaded in <head> before the first paint: the per-browser UI preferences of prefs.js that change how the page looks.
   <html data-theme="light|dark"> (absent: follow the system), <html data-hints="fast|normal|off"> (tips.js) and
   <html data-icons="sketch|classic"> (the icon set RT.icon draws: this browser's copy of the workspace setting
   iconStyle, so the icons are right from the first paint; prefs.js corrects it when settings.json says otherwise). */
(() => {
  const d = document.documentElement;
  let theme = null, hints = null, lang = null, icons = null;
  try { theme = localStorage.getItem('rt.ui.theme'); hints = localStorage.getItem('rt.ui.hints'); lang = localStorage.getItem('rt.ui.lang'); icons = localStorage.getItem('rt.ui.icons'); } catch { /* no storage */ }
  if (theme === 'light' || theme === 'dark') d.dataset.theme = theme;
  // the display language (i18n.js): <html lang> picks the CJK font fallbacks from the first paint
  if (lang === 'zh') { d.lang = 'zh-CN'; d.dataset.lang = 'zh'; }
  d.dataset.hints = hints === 'normal' || hints === 'off' ? hints : 'fast';
  d.dataset.icons = icons === 'classic' ? 'classic' : 'sketch';
})();
