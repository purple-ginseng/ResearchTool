/* Help › Copy diagnostics (also in the ⌘K palette): a plain-text block for a bug report, copied to the clipboard.
   App version and commit, OS, Node, AI provider and its CLI's version / installed / signed-in state, the helper
   programs, the state of the updates (GET /api/diagnostics - lib/routes/diagnostics.js: no AI call, no user content, redacted on the server),
   plus what only the page knows: the browser, the display language and the last client errors (RT.errors, core.js).
   Redacted here too (public/js/redact.js): the workspace path is <workspace>, a home folder <home>, an e-mail address
   <email>, a key or token <secret>, and a quoted piece of a page error "<text>". When the
   clipboard refuses, a dialog shows the text, selected, to copy by hand. The report itself stays English (it is read
   by whoever fixes the bug); the toast and the dialog follow the display language. */
(() => {
  const { $, esc, api, toast, icon } = RT;
  const yes = (v) => (v == null ? 'unknown' : v ? 'yes' : 'no');
  // (the patterns are shared with the server: public/js/redact.js; here the workspace path the page knows comes first)
  function redact(s) {
    let t = String(s == null ? '' : s);
    const ws = RT.state && RT.state.status && RT.state.status.workspace;
    if (ws && ws.length > 1) t = t.split(ws).join('<workspace>').split(ws.replace(/\\/g, '/')).join('<workspace>');
    return window.RTRedact ? window.RTRedact.redact(t) : t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>');
  }
  // an error message of the page may quote what was typed or read: quoted pieces become "<text>"
  const quoted = (s) => (window.RTRedact ? window.RTRedact.quoted(s) : String(s == null ? '' : s));

  async function text() {
    let d = null, failed = '';
    try { d = await api('/api/diagnostics'); } catch (e) { failed = e && e.message ? e.message : String(e); }
    const L = ['ResearchTool diagnostics (' + new Date().toISOString() + ')'];
    if (d) {
      L.push(`App version: ${d.app.version || 'unknown'}${d.app.commit ? ` (commit ${d.app.commit})` : ''}`);
      // (what the server loaded when it started; after an update that waits for a restart the files on disk are newer)
      if (d.app.onDisk) L.push(`App files on disk: ${d.app.onDisk.version || 'unknown'}${d.app.onDisk.commit ? ` (commit ${d.app.onDisk.commit})` : ''} - restart needed`);
      L.push(`OS: ${d.os.platform} ${d.os.release} (${d.os.arch})`);
      L.push(`Node: ${d.node}`);
    } else L.push(`Server details: not available (${quoted(failed)})`);
    L.push(`Browser: ${navigator.userAgent}`);
    L.push(`UI language: ${RT.i18n && RT.i18n.lang ? RT.i18n.lang() : document.documentElement.lang || 'en'}`);
    if (d) {
      const a = d.ai;
      L.push(`AI provider: ${a.name} (${a.bin}) - installed: ${yes(a.installed)}, version: ${a.version || 'unknown'}, signed in: ${yes(a.signedIn)}`
        + (a.compatibleOptions ? ', using the compatible option set (an older Claude Code)' : '') + (a.problem ? `, problem: ${a.problem}` : ''));
      L.push('Tools: ' + Object.entries(d.tools).map(([k, v]) => `${k} ${yes(v)}`).join(', '));
      const u = d.update; // (an older server has none)
      if (u) L.push(`Updates: automatic ${u.auto ? 'on' : 'off'}${u.disabled ? ', switched off by RT_NO_UPDATE' : ''}, can update: ${yes(u.supported)}${u.reason ? ` (${u.reason})` : ''}, behind: ${u.behind == null ? 'unknown' : u.behind}`
        + `, last check: ${u.lastCheck ? `${u.lastCheck.when} ${u.lastCheck.result}` : 'never'}, restart needed: ${yes(u.restartNeeded)}`);
      L.push(`Workspace: ${d.workspace}`);
    }
    const ce = RT.errors ? RT.errors.list().slice(-20) : [];
    L.push('', `Recent errors in the page (${ce.length}):`);
    for (const e of ce) L.push(`  ${e.t}  ${e.where ? e.where + ': ' : ''}${quoted(e.message)}${e.status ? ` [HTTP ${e.status}]` : ''}${e.stack ? `  @ ${e.stack}` : ''}`);
    const se = d ? d.aiErrors.slice(-20) : [];
    L.push('', `Recent AI errors on the server (${se.length}):`);
    for (const e of se) L.push(`  ${e.t}  ${e.provider}: ${e.text}`);
    return redact(L.join('\n')) + '\n';
  }

  // the clipboard refused (no permission, not a secure context): the text in a dialog, selected
  function showText(t) {
    const dlg = document.createElement('dialog');
    dlg.className = 'rd-dlg diag-dlg';
    dlg.innerHTML = `<h3>Diagnostics</h3><p class="muted">The clipboard could not be used. The text below is selected: copy it (${esc(RT.modKey === 'Ctrl' ? 'Ctrl+C' : '⌘C')}) and paste it into your bug report.</p>
      <textarea class="diag-text" readonly spellcheck="false" data-i18n-skip></textarea>
      <div class="dlg-actions"><span class="spacer"></span><button class="ib has-text primary" data-close title="Close">${icon('close')}<span class="ib-text">Close</span></button></div>`;
    document.body.append(dlg);
    const ta = $('.diag-text', dlg);
    ta.value = t;
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    ta.focus(); ta.select();
  }

  async function copy() {
    let t;
    try { t = await text(); } catch (e) { return RT.reportError(e, 'diagnostics'); }
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(t);
      toast('Diagnostics copied - paste them into your bug report', 'ok');
    } catch { showText(t); }
  }

  RT.diagnostics = { copy, text, redact };
})();
