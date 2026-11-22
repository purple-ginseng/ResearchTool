/* Overleaf import + sync controls (Git integration). RT.overleaf.importDialog(), RT.overleaf.mountSync(el, project).
   The Overleaf Git token is never typed into this page: git's own credential helper (macOS Keychain) holds it. */
(() => {
  const { esc, api, toast, enc } = RT;
  RT.overleaf = RT.overleaf || {};
  const DEFAULT_MSG = 'Update from ResearchTool';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const I = RT.icon;
  const LAPTOP = 'device-laptop'; // "my copy on this Mac"
  // icon-only button: the name is the hover hint and the accessible label
  const ib = (icon, label, attrs = '', cls = '', hint = '') => `<button type="button" class="ib ${cls}" ${attrs} title="${esc(hint || label)}" aria-label="${esc(label)}">${I(icon)}</button>`;
  // change the face of an icon button (icon, or the spinner while busy) together with its hint
  const face = (b, icon, label, hint) => { b.innerHTML = icon === 'spin' ? '<span class="spin"></span>' : I(icon); b.title = hint || label; b.setAttribute('aria-label', label); };

  // ---------- small modal helper ----------
  // Opens <dialog class="ol-dlg"> with the given markup; resolves with the value passed to done() (null on Esc).
  function modal(html, setup) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'ol-dlg';
      dlg.innerHTML = html;
      document.body.appendChild(dlg);
      let result = null, busy = false;
      const done = (v) => { result = v; busy = false; dlg.close(); };
      dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
      try { setup(dlg, done, (b) => { busy = b; }); dlg.showModal(); }
      catch (e) { dlg.remove(); resolve(null); toast(e.message, 'bad'); }
    });
  }
  const loginSteps = (command) => `
    <div class="ol-login">
      <p><b>Overleaf needs a login.</b> ResearchTool never sees your password or token - git keeps it in the macOS Keychain. Do this once:</p>
      <ol>
        <li>On Overleaf open <b>Account Settings → Git integration</b> and create a Git token (copy it).</li>
        <li>Run this command in Terminal. When asked, type <code>git</code> as the username and paste the token as the password:
          <div class="ol-cmd"><code>${esc(command)}</code>${ib('copy', 'Copy the command', '', 'ol-copy')}</div></li>
        <li>Come back here and click ${I('refresh')} <b>Try again</b>.</li>
      </ol>
    </div>`;
  function wireCopy(root) {
    for (const b of root.querySelectorAll('.ol-copy')) {
      b.addEventListener('click', async () => {
        const text = b.parentElement.querySelector('code').textContent;
        try { await navigator.clipboard.writeText(text); face(b, 'check', 'Copied'); }
        catch { // clipboard API unavailable: select the text so Cmd-C works
          const r = document.createRange(); r.selectNodeContents(b.parentElement.querySelector('code'));
          const s = getSelection(); s.removeAllRanges(); s.addRange(r); face(b, 'copy', 'Press ⌘C to copy', 'The command is selected: press ⌘C to copy it'); toast('The command is selected - press ⌘C to copy it.');
        }
        setTimeout(() => { if (b.isConnected) face(b, 'copy', 'Copy the command'); }, 2500);
      });
    }
  }

  // ---------- import ----------
  RT.overleaf.importDialog = () => modal(`
    <h3>Import from Overleaf</h3>
    <form method="dialog" class="ol-form">
      <label>Overleaf project link
        <input type="text" name="url" placeholder="https://www.overleaf.com/project/…" autocomplete="off" spellcheck="false" required
          title="Open the project on Overleaf and copy the address from the browser. Overleaf has no way to list your projects here, so each one is added by its link."></label>
      <label>Local name <span class="muted">(optional)</span>
        <input type="text" name="name" placeholder="my-paper" autocomplete="off" spellcheck="false" maxlength="60" title="Name of the project on this Mac (defaults to the Overleaf name)"></label>
      <p class="muted ol-hint">Needs Overleaf's Git integration (Premium). The project stays linked for pull and push.</p>
      <div class="ol-msg" hidden></div>
      <div class="dlg-actions">${ib('close', 'Cancel', '', 'ol-cancel')}<button type="submit" class="primary ib ol-go" title="Import: clone the project from Overleaf" aria-label="Import">${I('cloud')}</button></div>
    </form>`, (dlg, done, setBusy) => {
    const form = dlg.querySelector('form'), msg = dlg.querySelector('.ol-msg'), go = dlg.querySelector('.ol-go');
    let retry = false; // after the login instructions were shown the button means "try again"
    dlg.querySelector('.ol-cancel').addEventListener('click', () => done(null));
    api('/api/overleaf/status').then((s) => {
      if (!s.git && dlg.isConnected) { msg.hidden = false; msg.className = 'ol-msg bad'; msg.textContent = 'git is not installed on this Mac. Run "xcode-select --install" in Terminal first.'; }
    }).catch(() => {});
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const url = form.url.value.trim(), name = form.name.value.trim();
      if (!url) { form.url.focus(); return; }
      go.disabled = true; setBusy(true);
      face(go, 'spin', 'Importing…');
      msg.hidden = false; msg.className = 'ol-msg muted'; msg.textContent = 'Cloning from Overleaf…';
      try {
        const r = await api('/api/overleaf/import', { method: 'POST', json: name ? { url, name } : { url } });
        RT.emit('projects:changed');
        toast(`Imported “${r.project.name}” from Overleaf`, 'ok');
        done(r.project);
      } catch (err) {
        setBusy(false); go.disabled = false;
        if (err.data && err.data.needsLogin) {
          msg.className = 'ol-msg'; msg.innerHTML = loginSteps(err.data.command || ''); wireCopy(msg);
          retry = true; face(go, 'refresh', 'Try again');
        } else {
          msg.className = 'ol-msg bad'; msg.textContent = err.message || 'Import failed';
          if (retry) face(go, 'refresh', 'Try again'); else face(go, 'cloud', 'Import', 'Import: clone the project from Overleaf');
        }
      }
    });
    setTimeout(() => form.url.focus(), 0);
  });

  // ---------- dialogs used by the sync control ----------
  const askMessage = () => modal(`
    <h3>Push to Overleaf</h3>
    <form method="dialog" class="ol-form">
      <label>Describe your changes <span class="muted">(optional)</span>
        <input type="text" name="message" placeholder="${esc(DEFAULT_MSG)}" autocomplete="off" maxlength="300"></label>
      <div class="dlg-actions">${ib('close', 'Cancel', '', 'ol-cancel')}<button type="submit" class="primary ib" title="Push: your local changes are committed, changes made on Overleaf are merged in first, then everything is sent to Overleaf (Enter)" aria-label="Push">${I('push')}</button></div>
    </form>`, (dlg, done) => {
    const form = dlg.querySelector('form');
    dlg.querySelector('.ol-cancel').addEventListener('click', () => done(null));
    form.addEventListener('submit', (e) => { e.preventDefault(); done({ message: form.message.value.trim() }); });
    setTimeout(() => form.message.focus(), 0);
  });
  const askConflict = (files) => modal(`
    <h3>Overleaf and your local copy disagree</h3>
    <p>Both sides changed ${files.length === 1 ? 'this file' : 'these files'} in a way that cannot be combined automatically. Nothing has been changed on disk yet.</p>
    <ul class="ol-files">${files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>
    <p class="muted ol-hint">Choose which version wins for the conflicting parts - ${I(LAPTOP)} yours or ${I('cloud')} Overleaf's; all other changes from both sides are kept.
      Before anything is replaced, your current local versions of these files are copied to the workspace trash
      (<code>trash/&lt;project&gt;/&lt;time&gt;/</code>), so nothing is lost.</p>
    <div class="dlg-actions">${ib('close', 'Cancel', 'data-v=""', '', 'Cancel: change nothing')}${ib('cloud', "Take Overleaf's version", 'data-v="theirs"', 'ol-choice', "Take Overleaf's version for the conflicting parts").replace('</button>', '<span>Overleaf</span></button>')}${ib(LAPTOP, 'Keep my version', 'data-v="mine"', 'primary ol-choice', 'Keep my version for the conflicting parts').replace('</button>', '<span>Mine</span></button>')}</div>`,
  (dlg, done) => {
    for (const b of dlg.querySelectorAll('[data-v]')) b.addEventListener('click', () => done(b.dataset.v || null));
  });
  const askLogin = (command) => modal(`
    <h3>Overleaf login needed</h3>
    ${loginSteps(command)}
    <div class="dlg-actions">${ib('close', 'Close', 'data-v=""')}${ib('refresh', 'Try again', 'data-v="retry"', 'primary')}</div>`,
  (dlg, done) => {
    wireCopy(dlg);
    for (const b of dlg.querySelectorAll('[data-v]')) b.addEventListener('click', () => done(b.dataset.v || null));
  });
  const askUnlink = (name) => modal(`
    <h3>Unlink from Overleaf?</h3>
    <p>“${esc(name)}” stays on this Mac with all its files; it just stops syncing with Overleaf. The project on Overleaf is not touched.</p>
    <div class="dlg-actions">${ib('close', 'Cancel', 'data-v=""')}${ib('unlink', 'Unlink', 'data-v="yes"', 'primary', 'Unlink from Overleaf')}</div>`,
  (dlg, done) => {
    for (const b of dlg.querySelectorAll('[data-v]')) b.addEventListener('click', () => done(b.dataset.v || null));
  });

  // ---------- sync control ----------
  const mounted = new Set(); // live controls: {el, project, refresh, lastFetch, lastLight}
  const FETCH_EVERY = 60000, LIGHT_EVERY = 4000;

  RT.overleaf.mountSync = (container, project) => {
    if (!container) return;
    for (const c of [...mounted]) if (c.container === container || !c.el.isConnected) { c.el.remove(); mounted.delete(c); }
    if (!project || !project.overleaf || !project.overleaf.projectId) return;

    const pid = project.id, base = '/api/projects/' + enc(pid) + '/overleaf';
    const el = document.createElement('div');
    el.className = 'ol-sync';
    el.innerHTML = `
      <button type="button" class="ol-status" title="Check Overleaf now" aria-label="Overleaf status: check now"><span class="ol-dot"></span><span class="ol-text">Overleaf…</span></button>
      <span class="ol-actions">
        <button type="button" class="ib ol-pull" title="Pull: get the changes made on Overleaf" aria-label="Pull from Overleaf">${I('pull')}</button>
        <button type="button" class="ib ol-push" title="Push: send your changes to Overleaf" aria-label="Push to Overleaf">${I('push')}</button>
        <span class="menu-wrap">
          <button type="button" class="ib ol-more" title="More Overleaf actions" aria-label="More Overleaf actions" aria-haspopup="true">${I('more')}</button>
          <div class="popover menu ol-menu" hidden>
            <button type="button" data-act="open">${I('open')}Open on Overleaf</button>
            <button type="button" data-act="unlink">${I('unlink')}Unlink</button>
          </div>
        </span>
      </span>`;
    container.appendChild(el);
    const $ = (s) => el.querySelector(s);
    const ctl = { container, el, project, lastFetch: 0, lastLight: 0, busy: false, st: null };
    mounted.add(ctl);
    const alive = () => el.isConnected && mounted.has(ctl);
    // the status wording is the face of the status button: keep its accessible name in step with it
    const setText = (t) => { $('.ol-text').textContent = t; $('.ol-status').setAttribute('aria-label', 'Overleaf: ' + t); };

    function show(st) {
      ctl.st = st;
      let text, cls = '', title = 'Click to check Overleaf now';
      if (!st.linked) { text = 'Not linked'; cls = 'warn'; }
      else if (st.broken) { text = 'Not a Git clone'; cls = 'bad'; title = st.error || ''; }
      else if (st.needsLogin) { text = 'Login needed'; cls = 'bad'; title = 'Click for instructions'; }
      else {
        const parts = [];
        if (st.dirty) parts.push(plural(st.dirty, 'local change'));
        else if (st.ahead) parts.push(plural(st.ahead, 'commit') + ' to push');
        if (st.behind) parts.push(st.behind + ' incoming');
        if (st.offline) { text = 'Offline' + (parts.length ? ' · ' + parts.join(' · ') : ''); cls = 'warn'; title = st.error || 'Overleaf could not be reached'; }
        else if (parts.length) { text = parts.join(' · '); cls = 'changes'; }
        else { text = 'Up to date'; cls = 'ok'; }
        if (st.lastSync) title += '\nLast sync: ' + new Date(st.lastSync).toLocaleString();
      }
      setText(text);
      $('.ol-status').className = 'ol-status ' + cls;
      $('.ol-status').title = title;
    }
    const setBusy = (b, text) => {
      ctl.busy = b;
      for (const x of [$('.ol-pull'), $('.ol-push'), $('.ol-more')]) x.disabled = b;
      el.classList.toggle('busy', b);
      if (b && text) setText(text);
    };

    async function refresh(withFetch) {
      if (!alive() || ctl.busy) return;
      const now = Date.now();
      ctl.lastLight = now;
      if (withFetch) ctl.lastFetch = now;
      try {
        const st = await api(base + (withFetch ? '?fetch=1' : ''));
        if (!alive() || ctl.busy) return;
        // a status without a fetch knows nothing about the network: keep the flags of the last fetch
        if (!withFetch && ctl.st) { for (const k of ['needsLogin', 'offline', 'command', 'error']) if (ctl.st[k] && !st.broken) st[k] = ctl.st[k]; }
        show(st);
      } catch (e) {
        if (alive() && !ctl.busy) { setText('error'); $('.ol-text').textContent = 'Overleaf: error'; $('.ol-status').className = 'ol-status bad'; $('.ol-status').title = e.message; }
      }
    }
    ctl.refresh = refresh;

    // run one operation (pull / push / resolve); handles login and conflict answers
    async function run(kind, body) {
      if (ctl.busy) return;
      if (RT.write && RT.write.flushAll) {
        let saved = false;
        try { saved = await RT.write.flushAll(); } catch (e) { toast('Could not save your open files: ' + e.message, 'bad'); return; }
        if (saved === false) { toast('Some open files could not be saved, so nothing was synced. Save them first.', 'bad'); return; }
      }
      setBusy(true, kind === 'push' ? 'Pushing…' : kind === 'pull' ? 'Pulling…' : 'Merging…');
      let again = null;
      try {
        const r = await api(base + '/' + kind, { method: 'POST', json: body || {} });
        const changed = r.updated && r.updated.length;
        if (changed || kind !== 'push') RT.emit('project:changed', { id: pid });
        if (kind === 'push') toast(r.pushed ? `Pushed ${plural(r.pushed, 'commit')} to Overleaf${changed ? ` (and merged ${plural(r.updated.length, 'file')} from Overleaf)` : ''}` : 'Nothing to push - Overleaf is up to date', 'ok');
        else if (kind === 'pull') toast(changed ? `Pulled ${plural(r.updated.length, 'changed file')} from Overleaf` : 'Already up to date with Overleaf', 'ok');
        else toast(`Merged, keeping ${r.strategy === 'mine' ? 'your version' : "Overleaf's version"}${r.trashed ? ` (previous local copies are in ${r.trashed})` : ''}. Press Push to send the result to Overleaf.`, 'ok');
        ctl.st = null;
      } catch (e) {
        const d = e.data || {};
        if (d.conflict && Array.isArray(d.files)) again = { conflict: d.files };
        else if (d.needsLogin) { again = { login: d.command || '' }; ctl.st = { ...(ctl.st || { linked: true }), needsLogin: true, command: d.command }; }
        else toast((kind === 'push' ? 'Push' : kind === 'pull' ? 'Pull' : 'Merge') + ' failed: ' + e.message, 'bad');
      } finally {
        if (alive()) { setBusy(false); await refresh(false); }
      }
      if (!again || !alive()) return;
      if (again.conflict) {
        const strategy = await askConflict(again.conflict);
        if (strategy) { await run('resolve', { strategy }); if (kind === 'push' && alive() && !ctl.busy) toast('Conflict resolved. Press Push to send the result to Overleaf.', 'ok'); }
        else toast('Nothing was changed. Pull again when you want to decide.', '');
      } else if (await askLogin(again.login)) await run(kind, body);
    }

    $('.ol-status').addEventListener('click', async () => {
      if (ctl.st && ctl.st.needsLogin) { if (await askLogin(ctl.st.command || '')) { ctl.st = null; refresh(true); } return; }
      setText('Checking…');
      refresh(true);
    });
    $('.ol-pull').addEventListener('click', () => run('pull').catch((e) => toast(e.message, 'bad')));
    $('.ol-push').addEventListener('click', async () => {
      try { const a = await askMessage(); if (a) await run('push', a.message ? { message: a.message } : {}); }
      catch (e) { toast(e.message, 'bad'); }
    });
    const menu = $('.ol-menu');
    $('.ol-more').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) menu.querySelector('button').focus(); });
    menu.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      menu.hidden = true;
      try {
        if (act === 'open') {
          const id = project.overleaf.projectId; // only ever a validated Overleaf id
          if (/^[0-9a-f]{24}$/.test(id)) window.open('https://www.overleaf.com/project/' + id, '_blank', 'noopener');
        } else if (act === 'unlink') {
          if (!(await askUnlink(project.name || pid))) return;
          await api(base + '/unlink', { method: 'POST' });
          el.remove(); mounted.delete(ctl);
          toast('Unlinked from Overleaf. The local project is unchanged.', 'ok');
          RT.emit('projects:changed');
        }
      } catch (err) { toast(err.message, 'bad'); }
    });

    refresh(true);
  };

  // close the menus on an outside click / Esc
  document.addEventListener('click', (e) => { for (const c of mounted) { const m = c.el.querySelector('.ol-menu'); if (m && !m.hidden && !e.target.closest('.ol-menu')) m.hidden = true; } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const c of mounted) { const m = c.el.querySelector('.ol-menu'); if (m) m.hidden = true; } });

  // Refresh when the window regains focus: local state at most every few seconds, a real fetch at most once a minute.
  function onFocus() {
    const now = Date.now();
    for (const c of [...mounted]) {
      if (!c.el.isConnected) { mounted.delete(c); continue; }
      if (c.el.offsetParent === null) continue; // not visible (other tab)
      if (now - c.lastFetch >= FETCH_EVERY) c.refresh(true);
      else if (now - c.lastLight >= LIGHT_EVERY) c.refresh(false);
    }
  }
  window.addEventListener('focus', onFocus);
  RT.on('view:changed', () => setTimeout(onFocus, 0));
})();
