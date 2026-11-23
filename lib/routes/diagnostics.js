// Help › Copy diagnostics: GET /api/diagnostics -> what a bug report needs about this installation, and nothing of
// the user's own content. It runs no AI call (only `<cli> --version` and Claude Code's `auth status`, as the status
// checks do) and reads no paper, note or library file. Every string is redacted (lib/diagnostics.js): the workspace
// path is <workspace>, the home folder ~, e-mail addresses <email>; the account name of the AI provider is left out.
//   { app: {version, commit}, os: {platform, release, arch}, node, ai: {provider, name, bin, installed, version,
//     signedIn, compatibleOptions}, tools: {pdftotext, latexmk, git, unzip}, workspace: '<workspace>', aiErrors: [...] }
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../core');
const ai = require('../ai');
const diag = require('../diagnostics');

let commitP = null; // the app's git commit: the same for the whole server run
function commit() {
  if (!commitP) {
    commitP = fs.existsSync(path.join(core.ROOT, '.git'))
      ? core.run('git', ['rev-parse', '--short', 'HEAD'], { cwd: core.ROOT, timeout: 10000 }).then((r) => (r.code === 0 && /^[0-9a-f]{4,40}$/.test(r.out.trim()) ? r.out.trim() : ''), () => '')
      : Promise.resolve('');
  }
  return commitP;
}
const version = () => { try { return String(JSON.parse(fs.readFileSync(path.join(core.ROOT, 'package.json'), 'utf8')).version || ''); } catch { return ''; } };
// a helper program is there when it could be started at all (some print their version with a non-zero exit code)
const has = (cmd, args) => core.run(cmd, args, { cwd: os.tmpdir(), timeout: 10000 }).then((r) => r.code !== -1, () => false);

async function collect() {
  const id = ai.currentId(), p = ai.provider(id);
  const [c, st, pdftotext, latexmk, git, unzip] = await Promise.all([commit(), ai.status(id).catch(() => ({})),
    has('pdftotext', ['-v']), has('latexmk', ['-v']), has('git', ['--version']), has('unzip', ['-v'])]);
  const out = {
    app: { version: version(), commit: c },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    node: process.version,
    ai: { provider: id, name: p.cliName, bin: p.bin, installed: !!st.installed, version: st.version || '', signedIn: st.signedIn == null ? null : !!st.signedIn,
      ...(st.problem ? { problem: String(st.problem).slice(0, 300) } : {}), ...(id === 'claude' ? { compatibleOptions: ai.claudeCompat.needsCompat() } : {}) },
    tools: { pdftotext, latexmk, git, unzip },
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
