/* "Claude Code account" dialog: shows whether the local claude CLI is installed and signed in, and signs in / out
   with the CLI's own `claude auth` commands (lib/routes/account.js). The sign-in itself happens on Anthropic's page
   in the browser; this app never sees a password or a token.
   RT.account.open() - also behind the person button in the Claude panel and the "Claude Code" guide page. */
(() => {
  const { $, esc, api, toast } = RT;
  RT.account = RT.account || {};
  const I = { user: 'user' };
  const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
  const PLAN = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' };

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-account" class="acct">
  <h3>Claude Code account</h3>
  <div id="acct-body"><div class="acct-row"><span class="spin"></span> Checking…</div></div>
  <div class="dlg-actions"><button id="acct-refresh" class="ib" title="Check again" aria-label="Check again">${RT.icon('refresh')}</button><span class="spacer"></span><button id="acct-close">Close</button></div>
</dialog>`);
  const dlg = $('#dlg-account'), body = $('#acct-body');
  const head = $('.claude-head #claude-new');
  if (head) head.insertAdjacentHTML('beforebegin', `<button id="claude-account" class="ib" title="Claude Code account: check the sign-in, sign in or out" aria-label="Claude Code account">${RT.icon(I.user)}</button>`);

  // Another AI provider than Claude (Preferences › AI): this dialog shows its CLI's status instead - installed,
  // signed in - with the command that signs in, run by the user in a terminal (the app never signs in to it).
  let other = null; // {p, s} while it shows another provider
  const osKey = () => (/Win/i.test(navigator.platform) ? 'win' : /Mac/i.test(navigator.platform) ? 'mac' : 'linux');
  const cmdBox = (c) => `<div class="acct-cmd"><code>${esc(c)}</code><button class="ib" data-copy="${esc(c)}" title="Copy the command" aria-label="Copy the command">${RT.icon('copy')}</button></div>`;
  function paintOther() {
    const { p, s } = other;
    if (!s) { body.innerHTML = '<div class="acct-row"><span class="spin"></span> Checking…</div>'; return; }
    const ver = s.version ? `<span class="muted" data-i18n-skip>${esc(p.cliName)} ${esc(s.version)}</span>` : '';
    if (!s.installed) {
      const inst = (p.install && (p.install[osKey()] || p.install.mac)) || '';
      body.innerHTML = `<div class="acct-row" data-brand-keep><span class="acct-dot bad"></span><div><b>Command not found: <code>${esc(p.bin)}</code></b><br><span class="muted">The AI provider chosen in Preferences › AI is not installed on this computer.</span></div></div>
        <ol class="acct-steps" data-brand-keep><li>Open a terminal and run:${cmdBox(inst)}${p.install && p.install.alt ? `<span class="muted">or</span>${cmdBox(p.install.alt)}` : ''}</li><li>Quit ResearchTool and open it again, so it finds the new command.</li><li>Sign in (see below), then check again.</li></ol>
        ${s.problem ? `<p class="muted">${esc(s.problem)}</p>` : ''}`;
      return;
    }
    const dot = s.signedIn === true ? 'ok' : s.signedIn === false ? 'bad' : 'warn';
    const head = s.signedIn === true ? `<b>Signed in</b>${s.account ? ` <span data-i18n-skip>· ${esc(s.account)}</span>` : ''}` : s.signedIn === false ? '<b>Not signed in.</b>' : '<b>The sign-in could not be checked.</b>';
    const login = p.login ? `<p class="muted">To sign in with your own account, run this in a terminal (ResearchTool never asks for a password or a key):</p>${cmdBox(p.login)}${p.loginNote && p.loginNote !== s.warning ? `<p class="muted">${esc(p.loginNote)}</p>` : ''}` : '';
    body.innerHTML = `<div class="acct-row" data-brand-keep><span class="acct-dot ${dot}"></span><div>${head}<br>${ver}</div></div>
      ${s.warning ? `<p class="set-bad" data-brand-keep>${esc(s.warning)}</p>` : ''}${s.problem ? `<p class="muted" data-i18n-skip>${esc(s.problem)}</p>` : ''}
      <div data-brand-keep>${s.signedIn === true ? '' : login}
      <p class="muted">${p.caps && p.caps.agentic ? 'With this provider the AI panel edits files, because you let it in Preferences › AI. PDFs are sent as their extracted text.' : 'With this provider the AI panel is read-only: it reads your files but does not change them. PDFs are sent as their extracted text.'}</p></div>`;
  }
  let st = null;       // the last status from the server
  let flow = null;     // the running sign-in: { ctrl, url, waiting, lines, sending }

  const who = (s) => {
    if (s.authMethod === 'claude.ai') return `${s.email ? esc(s.email) : 'your Claude account'}${s.subscriptionType ? ` · ${esc(PLAN[s.subscriptionType] || s.subscriptionType)} plan` : ''}`;
    if (s.email) return `${esc(s.email)}${s.orgName ? ` · ${esc(s.orgName)}` : ''} · API billing`;
    return /key|token/i.test(s.authMethod || '') ? 'an API key or token from the environment of the server' : esc(s.authMethod || 'signed in');
  };
  // a login that `claude auth logout` cannot remove: a key or token in the environment the server was started with
  const envAuth = (s) => s.authMethod !== 'claude.ai' && !s.email && /key|token/i.test(s.authMethod || '');
  function paint() {
    if (flow) return paintFlow();
    if (!st) { body.innerHTML = '<div class="acct-row"><span class="spin"></span> Checking…</div>'; return; }
    if (st.error) { body.innerHTML = `<div class="acct-row"><span class="acct-dot bad"></span><div>Could not check: ${esc(st.error)}</div></div>`; return; }
    if (!st.installed) {
      body.innerHTML = `
        <div class="acct-row"><span class="acct-dot bad"></span><div><b>Command not found: <code>claude</code></b><br><span class="muted">The Claude panel, drafts, diagrams, key points and grouping all use Claude Code on this Mac.</span></div></div>
        <ol class="acct-steps">
          <li>Open Terminal and run:<div class="acct-cmd"><code>${esc(INSTALL)}</code><button class="ib" data-copy="${esc(INSTALL)}" title="Copy the command" aria-label="Copy the command">${RT.icon('copy')}</button></div></li>
          <li>Quit ResearchTool and open it again, so it finds the new command.</li>
          <li>Come back here and sign in.</li>
        </ol>
        <p class="muted">More ways to install: <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noopener noreferrer">code.claude.com/docs/en/setup</a></p>`;
      return;
    }
    const ver = st.version ? `<span class="muted">Claude Code ${esc(st.version)}</span>` : '';
    if (st.unknown) {
      body.innerHTML = `<div class="acct-row"><span class="acct-dot warn"></span><div><b>This version of Claude Code cannot report its sign-in.</b> ${ver}<br><span class="muted">Update it (run <code>claude update</code> in Terminal), then check again.</span></div></div>`;
      return;
    }
    if (st.loggedIn) {
      body.innerHTML = `
        <div class="acct-row"><span class="acct-dot ok"></span><div><b>Signed in</b> as ${who(st)}<br>${ver}</div></div>
        <p class="muted">Everything Claude does in this app runs under this account. To use another account, sign out and sign in again.</p>
        ${envAuth(st) ? '<p class="muted">This login comes from an API key or token in the environment ResearchTool was started with (<code>ANTHROPIC_API_KEY</code> or <code>ANTHROPIC_AUTH_TOKEN</code>). It cannot be signed out here: remove the variable and start ResearchTool again.</p>' : '<div class="acct-actions"><button id="acct-out">Sign out</button></div>'}`;
      return;
    }
    body.innerHTML = `
      <div class="acct-row"><span class="acct-dot bad"></span><div><b>Not signed in.</b> ${ver}<br><span class="muted">Claude features will not work until you sign in.</span></div></div>
      <div class="acct-actions">
        <button class="primary" data-login="claudeai" title="For a Claude Pro, Max, Team or Enterprise plan">Sign in with your Claude plan</button>
        <button data-login="console" title="Pay per use through an Anthropic Console (API) account">Sign in with API billing</button>
      </div>
      <p class="muted">Your browser opens Anthropic's sign-in page. You type your password there, never in this app; Claude Code keeps the login in the macOS Keychain.</p>`;
  }
  function paintFlow() {
    const f = flow;
    body.innerHTML = `
      <div class="acct-row"><span class="spin"></span><div><b>Signing in…</b><br><span class="muted">${f.url ? 'Finish the sign-in on the page that opened in your browser.' : 'Starting Claude Code…'}</span></div></div>
      <ol class="acct-steps">
        <li>${f.url ? `If no page opened: <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">open the sign-in page</a>.` : 'Your browser opens the sign-in page.'}</li>
        <li>Sign in and press <b>Authorize</b>.</li>
        <li>If the page then shows a code, paste it here:
          <form id="acct-code-form" class="acct-cmd"><input type="text" id="acct-code" autocomplete="off" spellcheck="false" placeholder="Code from the sign-in page" aria-label="Code from the sign-in page" ${f.waiting ? '' : 'disabled'}><button class="primary" ${f.waiting && !f.sending ? '' : 'disabled'}>${f.sending ? '<span class="spin"></span>' : 'Continue'}</button></form></li>
      </ol>
      ${f.lines.length ? `<p class="muted acct-log">${f.lines.slice(-3).map(esc).join('<br>')}</p>` : ''}
      <div class="acct-actions"><button id="acct-cancel">Cancel</button></div>`;
  }

  async function refresh() {
    if (flow) return;
    if (RT.ai && !RT.ai.isClaude()) { // another provider: its status, never a sign-in from here
      const p = RT.ai.provider();
      other = { p, s: null }; paintOther();
      let s; try { s = (await RT.ai.status(p.id, true)).status[p.id]; } catch (e) { s = { installed: true, signedIn: null, problem: e.message }; }
      if (other && other.p.id === p.id) { other.s = s; paintOther(); }
      const b = $('#claude-account'); if (b) b.classList.toggle('acct-warn', !s.installed || s.signedIn === false);
      return;
    }
    other = null;
    st = null; paint();
    try { st = await api('/api/claude/auth'); } catch (e) { st = { error: e.message }; }
    paint(); mark();
  }
  // the person button in the Claude panel shows a dot while Claude Code is not usable
  function mark() {
    const b = $('#claude-account'); if (!b || !st || st.error) return;
    b.classList.toggle('acct-warn', !st.installed || (!st.loggedIn && !st.unknown));
  }

  async function signIn(method) {
    if (flow) return;
    const f = flow = { ctrl: new AbortController(), url: '', waiting: false, lines: [], sending: false };
    paint();
    let done = null, error = '';
    try {
      const r = await fetch('/api/claude/auth/login', { method: 'POST', signal: f.ctrl.signal, headers: { 'X-RT': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ method }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Request failed (${r.status})`); }
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done: end, value } = await rd.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          const typed = ($('#acct-code') || {}).value || '', focused = document.activeElement && document.activeElement.id === 'acct-code';
          if (ev.type === 'url') f.url = ev.url;
          else if (ev.type === 'prompt') f.waiting = true;
          else if (ev.type === 'text') { f.sending = false; f.lines.push(ev.text); }
          else if (ev.type === 'done') done = ev;
          if (flow === f && ev.type !== 'done') { // repaint without losing what is being typed
            paint();
            const inp = $('#acct-code'); if (inp) { inp.value = typed; if (focused || ev.type === 'prompt') inp.focus(); }
          }
        }
      }
      if (!done) error = 'The connection closed before the sign-in finished.';
    } catch (e) { error = e.name === 'AbortError' ? '' : e.message; }
    if (flow === f) flow = null;
    if (done && done.status) { st = done.status; paint(); mark(); } else refresh();
    if (done && done.ok) { toast('Signed in to Claude Code', 'ok'); RT.emit('claude:auth', st); }
    else if (done || error) toast((done && done.text) || error || 'The sign-in did not finish.', 'bad');
  }

  body.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.login) signIn(t.dataset.login);
    else if (t.id === 'acct-cancel' && flow) flow.ctrl.abort();
    else if (t.dataset.copy) { try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied', 'ok'); } catch { toast('Could not copy to the clipboard', 'bad'); } }
    else if (t.id === 'acct-out') {
      if (!(await RT.confirm('Sign out of Claude Code on this Mac?\n\nClaude Code in the Terminal is signed out too. The Claude features of this app stop working until you sign in again.', { title: 'Sign out', okText: 'Sign out' }))) return;
      t.disabled = true;
      try { st = (await api('/api/claude/auth/logout', { method: 'POST', json: {} })).status; toast('Signed out of Claude Code', 'ok'); RT.emit('claude:auth', st); }
      catch (err) { toast(err.message, 'bad'); }
      paint(); mark();
    }
  });
  body.addEventListener('submit', async (e) => {
    if (e.target.id !== 'acct-code-form') return;
    e.preventDefault();
    const f = flow, inp = $('#acct-code'), code = inp ? inp.value.trim() : '';
    if (!f || !f.waiting || !code || f.sending) return;
    f.sending = true; paint();
    try { await api('/api/claude/auth/code', { method: 'POST', json: { code } }); }
    catch (err) { f.sending = false; if (flow === f) { paint(); const i = $('#acct-code'); if (i) i.value = code; } toast(err.message, 'bad'); }
  });
  $('#acct-refresh').addEventListener('click', refresh);
  $('#acct-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { if (flow) flow.ctrl.abort(); }); // leaving the dialog cancels a sign-in that is under way

  function open() { if (!dlg.open) dlg.showModal(); refresh(); }
  const btn = $('#claude-account'); if (btn) btn.addEventListener('click', open);

  // at start: say so once if Claude Code is there but signed out (a missing CLI is already reported by core.js)
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      if (RT.ai) await RT.ai.ready;
      if (RT.ai && !RT.ai.isClaude()) return; // another AI provider: its status is shown when the dialog opens
      st = await api('/api/claude/auth'); mark();
      const cur = $('#toast').textContent; // another start-up message may be showing
      if (st.installed && !st.loggedIn && !st.unknown) toast((cur ? cur + ' — ' : '') + 'Claude Code is not signed in — open the Claude panel and click the person icon to sign in.', 'bad');
    } catch { /* the dialog reports it when opened */ }
  });

  Object.assign(RT.account, { open, status: () => st });
})();
