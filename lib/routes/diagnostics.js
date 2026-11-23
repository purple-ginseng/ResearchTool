// Help › Copy diagnostics: GET /api/diagnostics -> what a bug report needs about this installation, and nothing of
// the user's own content. It runs no AI call (only `<cli> --version` and Claude Code's `auth status`, as the status
// checks do) and reads no paper, note or library file. Every string is redacted (lib/diagnostics.js): the workspace
// path is <workspace>, the home folder ~, e-mail addresses <email>; the account name of the AI provider is left out.
//   { app: {version, commit, onDisk?: {version, commit}}, os: {platform, release, arch}, node, ai: {provider, name, bin,
//     installed, version, signedIn, compatibleOptions}, tools: {pdftotext, latexmk, git, unzip},
//     update: {auto, disabled, supported, reason, behind, lastCheck, restartNeeded}, workspace: '<workspace>', aiErrors: [...] }
// app.version / app.commit are what this server process loaded when it started; onDisk is there when the files in
// the app folder are newer than that (an update that waits for a restart). The update part comes from lib/update.js
// without a network request: codes and short commit ids only, no path and no git output.
const os = require('node:os');
const core = require('../core');
const ai = require('../ai');
const diag = require('../diagnostics');
const update = require('../update');

// a helper program is there when it could be started at all (some print their version with a non-zero exit code)
const has = (cmd, args) => core.run(cmd, args, { cwd: os.tmpdir(), timeout: 10000 }).then((r) => r.code !== -1, () => false);

async function collect() {
  const id = ai.currentId(), p = ai.provider(id);
  const [up, st, pdftotext, latexmk, git, unzip] = await Promise.all([update.real().status().catch(() => null), ai.status(id).catch(() => ({})),
    has('pdftotext', ['-v']), has('latexmk', ['-v']), has('git', ['--version']), has('unzip', ['-v'])]);
  const out = {
    app: { version: up ? up.running.version : '', commit: up ? up.running.commit : '', ...(up && up.restartNeeded ? { onDisk: { version: up.version, commit: up.commit } } : {}) },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    node: process.version,
    ai: { provider: id, name: p.cliName, bin: p.bin, installed: !!st.installed, version: st.version || '', signedIn: st.signedIn == null ? null : !!st.signedIn,
      ...(st.problem ? { problem: String(st.problem).slice(0, 300) } : {}), ...(id === 'claude' ? { compatibleOptions: ai.claudeCompat.needsCompat() } : {}) },
    tools: { pdftotext, latexmk, git, unzip },
    ...(up ? { update: { auto: up.auto, disabled: up.disabled, supported: up.supported, reason: up.reason, behind: up.behind, lastCheck: up.lastCheck, restartNeeded: up.restartNeeded } } : {}),
    workspace: '<workspace>',
    aiErrors: diag.recentAiErrors(),
  };
  return diag.redactDeep(out);
}

async function handle(ctx) {
  if (ctx.path === '/api/diagnostics' && ctx.method === 'GET') return ctx.send(200, await collect());
  return false;
}

module.exports = { handle, collect };
