/* Updates of the app itself (lib/update.js, /api/update; the switch is the autoUpdate setting, saved by prefs.js).
   - Preferences › General › Updates: the line under the checkbox (version, last check, why this copy cannot update
     itself) and the two buttons. "Check for updates now" asks GitHub once and installs nothing; "Update now" shows
     up when a newer version was found and installs it. Both work with the box unticked.
   - The restart notice: after an update the files on disk are new, but the server that is running still has the old
     code in memory. A banner under the header says so until ResearchTool is started again (it cannot be dismissed:
     the page and the server are of two versions until then). Looked at when the page loads, once an hour, when
     the tab is shown again, and every 20 seconds while a restart is awaited - GET /api/update/status, which asks
     nothing of the network and starts no program. Once the server runs the new version the notice goes; a page
     that was loaded from the older files is then told to reload (banner update-reload). A fast-forward that
     stopped half way gets the "interrupted" sentence there instead - never "was updated".
   The server answers with codes (reason: 'not-git', 'dirty', 'offline' ...); the sentences are here, so the display
   language layer translates them. Versions, commit ids and file names are data: [data-i18n-skip], set as text.
   RT.update = { status(local?) -> Promise, check(apply?) -> Promise, show() (Preferences opened), sentence(r) } */
(() => {
  const { $, api, esc } = RT;
  const z = (n) => String(n).padStart(2, '0');
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };

  // why this copy is not updated, or why the last check failed: what happened, and what to do
  const WHY = {
    disabled: 'Updates are switched off for this copy: it was started with RT_NO_UPDATE=1.',
    'not-git': 'This copy was not installed with git (for example it was unpacked from a ZIP file), so it cannot update itself. To get updates, install it with “git clone https://github.com/purple-ginseng/ResearchTool” and move your workspace folder into the new copy.',
    unusual: 'The ResearchTool folder is not an ordinary git clone (it is a linked work tree, or it lies inside another repository), so it is not updated automatically. Update it yourself with git.',
    'no-git': 'git is not installed, or could not be started, so updates cannot be checked. Install git (on a Mac: run “xcode-select --install” in a terminal; on Windows: Git for Windows), start ResearchTool again and check again.',
    unsafe: 'git refuses to work in the ResearchTool folder because the folder belongs to another user account (“dubious ownership”). Run “git status” there in a terminal: git says how to allow the folder.',
    locked: 'Another git command is running in the ResearchTool folder, or one was interrupted (the file .git/index.lock exists). Try again when it has finished.',
    'in-progress': 'A merge or rebase is in progress in the ResearchTool folder. Finish or abort it in a terminal, then check again.',
    config: 'The git settings inside the ResearchTool folder hold something that a plain clone does not have, so ResearchTool does not update itself. Run “git pull” in the ResearchTool folder yourself, or see docs/troubleshooting.md.',
    origin: 'This copy does not come from the official repository (github.com/purple-ginseng/ResearchTool) - it is a fork, for example - so it is never updated automatically. Update it yourself with git.',
    detached: 'The ResearchTool folder is not on a branch (a single commit is checked out). Run “git switch main” in it to get updates again.',
    branch: 'The ResearchTool folder is on another branch than main, so it is not updated automatically. Run “git switch main” in it to get updates again.',
    tracking: 'The branch main does not follow origin/main, so it is not updated automatically. Run “git branch --set-upstream-to=origin/main main” in the ResearchTool folder.',
    dirty: 'Program files of ResearchTool were changed on this computer, so it is not updated automatically: your changes would be in the way. Run “git status” in the ResearchTool folder to see them. Your workspace is not affected.',
    redirect: 'Your git settings send GitHub addresses somewhere else (url.….insteadOf), so ResearchTool does not update itself. Run “git pull” in the ResearchTool folder yourself.',
    offline: 'GitHub could not be reached. Check the internet connection and try again. Nothing was changed.',
    'fetch-failed': 'The new version could not be downloaded from GitHub. Nothing was changed.',
    compare: 'This copy could not be compared with the official repository. Nothing was changed. Run “git pull” in the ResearchTool folder yourself.',
    ahead: 'This copy has commits of its own that the official repository does not have, so it is not updated automatically.',
    diverged: 'This copy and the official repository have gone different ways, so it is not updated automatically. Nothing was changed. Update it yourself with git.',
    manual: 'The newest version cannot be installed automatically: it needs a step by hand. See “Updating” in docs/install.md on GitHub.',
    moved: 'The ResearchTool folder changed while the update was being prepared. Check again.',
    refused: 'git did not install the update. Nothing was changed. Run “git pull” in the ResearchTool folder to see why.',
    interrupted: 'The update was interrupted, and the ResearchTool folder may be half updated. Your workspace is not affected. To repair it, see “The update was interrupted” in docs/troubleshooting.md.',
    'git-failed': 'git reported an error in the ResearchTool folder. Run “git status” there in a terminal to see what is wrong.',
  };
  // reasons that are about the folder itself: a look at it (the status with ?local=1) answers them afresh, so one
  // that only the last check's record still holds says nothing about now
  const LOCAL = new Set(['disabled', 'not-git', 'unusual', 'no-git', 'unsafe', 'config', 'locked', 'in-progress', 'origin', 'detached', 'branch', 'tracking', 'dirty', 'redirect', 'moved', 'interrupted', 'git-failed']);
  // one sentence for an answer's reason (with what the server knows about it); '' when there is none
  function sentence(r) {
    const d = (r && r.detail) || {}, code = r && r.reason;
    if (!code) return '';
    if (code === 'needs-node') return `The newest version (v${d.version || '?'}) needs a newer Node.js (${d.needs || '?'}). Install it, start ResearchTool again and check again.`;
    if (code === 'blocked') {
      if (d.what === 'user-data') return `The newest version contains a file inside your workspace or backup folder (${d.path || '?'}). An update never writes there, so it was not installed.`;
      if (d.what === 'package') return 'The newest version cannot be installed automatically: its package.json could not be read. Nothing was changed.';
      return `The newest version cannot be installed automatically on this computer (${d.what || '?'}: ${d.path || '?'}). Nothing was changed.`;
    }
    if (code === 'config' && d.what) return `The git settings inside the ResearchTool folder hold something that a plain clone does not have (${d.what}), so ResearchTool does not update itself. Run “git pull” in the ResearchTool folder yourself, or see docs/troubleshooting.md.`;
    if (code === 'refused' && Array.isArray(d.files) && d.files.length) return `git did not install the update because a file in the ResearchTool folder is in the way: ${d.files.join(', ')}. Move it somewhere else and try again. Nothing was changed.`;
    return WHY[code] || `ResearchTool could not be updated (${code}).`;
  }
  // "was updated to" only when it was: this server installed it, or the commit on disk is another one than the
  // program runs. A newer version number alone (package.json was written, HEAD was not moved) is not that.
  const restartText = (r) => {
    if (r.reason === 'interrupted') return WHY.interrupted; // half updated: repair first - a restart would start a mix of two versions
    const run = r.running || {}, moved = !!r.updated || !!(r.commit && run.commit && r.commit !== run.commit);
    const v = (r.updated && r.updated.version) || r.version, c = (r.updated && r.updated.to) || r.commit;
    return moved && v && c ? `ResearchTool was updated to v${v} (${c}). Restart it to finish: stop it in the terminal (Ctrl+C) and run node server.js again.`
      : 'The ResearchTool files on this computer are newer than the program that is running. Restart it to finish: stop it in the terminal (Ctrl+C) and run node server.js again.';
  };

  // ---------------- the restart notice ----------------
  let lastSeen = 0, loaded = null, fast = null;
  function note(r) {
    lastSeen = Date.now();
    RT.state.update = r;
    if (!r) return r;
    // the files this page was loaded from (the first answer, a moment after the page itself)
    if (!loaded) loaded = { version: r.version || '', commit: r.commit || '' };
    if (r.restartNeeded) RT.banner.show({ id: 'update-restart', tone: r.reason === 'interrupted' ? 'warn' : 'info', text: restartText(r), dismissible: false });
    else {
      // the server was started again (or the folder was put back): the notice has done its work. But a page that
      // was loaded before the update still runs the old scripts against the new server - it needs a reload.
      RT.banner.hide('update-restart');
      const run = r.running || {};
      if ((run.commit && loaded.commit && run.commit !== loaded.commit) || (run.version && loaded.version && run.version !== loaded.version)) {
        RT.banner.show({ id: 'update-reload', tone: 'info', text: 'ResearchTool was restarted with another version. Reload this page to use it.', dismissible: false, action: { label: 'Reload now', onClick: () => location.reload() } });
      }
    }
    // while a restart is awaited, look often (the status starts nothing): the notice should go soon after the
    // restart, not at the next hourly look. A server that is down for the moment just fails the request.
    if (r.restartNeeded && !fast) fast = setInterval(quiet, 20000);
    else if (!r.restartNeeded && fast) { clearInterval(fast); fast = null; }
    return r;
  }
  const status = (local) => api('/api/update/status' + (local ? '?local=1' : '')).then(note);
  const check = (apply) => api('/api/update/check', { method: 'POST', json: apply ? { apply: true } : {} }).then(note);
  const quiet = () => status(false).catch(() => { /* the notice is a convenience (an older server has no such endpoint) */ });
  document.addEventListener('DOMContentLoaded', quiet);
  setInterval(quiet, 3600000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastSeen > 600000) quiet(); });
  // the box was just ticked and saved: the server checks at once, in the background - look at what came of it
  RT.on && RT.on('prefs:saved', () => { for (const ms of [5000, 20000, 60000]) setTimeout(quiet, ms); });

  // ---------------- Preferences › General › Updates ----------------
  const st = $('#update-state'), btnCheck = $('#update-check'), btnApply = $('#update-apply');
  // r: an answer of the status or of a check (a check also has r.result)
  function paint(r) {
    if (!st) return;
    const data = (t) => `<span data-i18n-skip>${esc(t)}</span>`, say = (t, cls) => `<span${cls ? ` class="${cls}"` : ''}>${esc(t)}</span>`;
    const l = r.lastCheck, parts = [];
    parts.push(r.version ? `<span>Version</span> ${data(r.version + (r.commit ? ` (${r.commit})` : ''))}` : '');
    parts.push(l ? `<span>Last check:</span> ${data(when(l.when))}` : say('Not checked yet.'));
    const lines = [parts.filter(Boolean).join(' · ')];
    if (r.restartNeeded && r.reason !== 'interrupted') lines.push(say(restartText(r)));
    if (r.result === 'busy') lines.push(say('A check for updates is already running. Try again in a moment.'));
    else if (r.available) lines.push(say(`A newer version is available: v${r.available.version} (${r.available.commit}).`));
    // (red when it stands in the way of what was asked: the box is ticked, or the button was just pressed)
    else if (r.reason) lines.push(say(sentence(r), r.auto || r.result ? 'set-bad' : ''));
    // Nothing is known from this run of the server (it was started after the last check): what that check found is
    // on record with its time only. Said as "at the last check", because it may have changed since - and a reason
    // about the folder itself is not repeated when the look just made found the folder in order.
    else if (!r.result && !r.restartNeeded && l && l.result === 'available') lines.push(say('A newer version was found at the last check. Press “Check for updates now” to see it.'));
    else if (!r.result && l && l.result === 'failed' && l.reason && !LOCAL.has(l.reason)) lines.push(say(WHY[l.reason] || 'The last check could not install the newest version. Press “Check for updates now” to see why.'));
    else if (!r.restartNeeded && (r.result === 'up-to-date' || (l && (l.result === 'up-to-date' || l.result === 'updated')))) lines.push(say('ResearchTool is up to date.'));
    st.className = 'muted';
    st.innerHTML = lines.join('<br>');
    if (btnApply) btnApply.hidden = !r.available;
  }
  async function act(apply) {
    if (!st) return;
    btnCheck.disabled = btnApply.disabled = true; st.className = 'muted';
    st.innerHTML = apply ? '<span class="spin"></span> Updating…' : '<span class="spin"></span> Checking…';
    try { paint(await check(apply)); }
    catch (e) { st.className = 'set-bad'; st.textContent = `The check for updates failed: ${e.message}`; }
    btnCheck.disabled = btnApply.disabled = false;
  }
  if (btnCheck) btnCheck.addEventListener('click', () => act(false));
  if (btnApply) btnApply.addEventListener('click', () => act(true));
  // Preferences was opened: what is known, and whether this copy can update itself (a few local git commands)
  async function show() {
    if (!st) return;
    st.className = 'muted'; st.textContent = ''; if (btnApply) btnApply.hidden = true;
    try { paint(await status(true)); }
    catch (e) { st.textContent = `The state of the updates could not be read: ${e.message}`; }
  }

  RT.update = { status, check, show, sentence };
})();
