// Diagnostics for bug reports (Help › Copy diagnostics, GET /api/diagnostics - lib/routes/diagnostics.js).
// Two parts:
//   - a small ring buffer of the last AI call failures on the server (the first line of what the CLI said), filled by
//     lib/ai (feature calls) and lib/routes/claude.js (the panel). In memory only, gone when the server stops.
//   - redact(text): what may leave the machine in a pasted report - the workspace path becomes <workspace>, the home
//     folder ~, the temporary folder <tmp>, an external LaTeX project <project>, the backup folder <backup>, any other
//     user's home (/Users/x, /home/x, C:\Users\x - also with a space in the name) <home>, a drive or share
//     (/Volumes/x, /media/x/y, \\server\share) <volume> / <share>, the user name of a URL (a proxy) <user>, an e-mail
//     address <email>, an API key or token (sk-..., ghp_..., xai-..., AIza..., "Bearer x", long hex / base64 runs)
//     <secret>. The report never runs an AI call and never reads a paper, a note or the library; error messages can
//     still quote a few words (see public/js/diagnostics.js), so the user is asked to read it before posting it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX = 20;
const aiErrors = []; // {t, provider, text}

let WS = '';
try { WS = require('./core').WS; } catch { /* (loaded on its own by a test) */ }
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// the longest first, so that the workspace inside the home folder becomes <workspace> and not ~/...
const expandHome = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
// a path in all the spellings an error message may use: as given, its real path, with / for \, and on macOS with and
// without /private (/tmp = /private/tmp, /var = /private/var)
function spellings(p) {
  const out = new Set();
  for (const v of [p, real(p)]) {
    if (!v) continue;
    out.add(v); out.add(v.replace(/\\/g, '/'));
    if (/^\/private\/(?:tmp|var|etc)(?=\/|$)/.test(v)) out.add(v.slice(8));
    else if (/^\/(?:tmp|var|etc)(?=\/|$)/.test(v)) out.add('/private' + v);
  }
  return out;
}
function pathRules() {
  const rules = [];
  const add = (p, to) => {
    p = typeof p === 'string' ? expandHome(p.trim()) : '';
    if (!p || p.length < 2 || p === path.sep || p === '/') return;
    for (const v of spellings(p)) if (v.length > 1) rules.push([v, to]);
  };
  add(WS, '<workspace>');
  try {
    const s = require('./core').loadSettings();
    for (const e of Array.isArray(s.externalProjects) ? s.externalProjects : []) if (e && typeof e.path === 'string') add(e.path, '<project>');
    if (typeof s.backupDir === 'string') add(s.backupDir, '<backup>');
  } catch { /* no settings (a test, or the workspace is not there yet) */ }
  add(os.tmpdir(), '<tmp>');
  add(os.homedir(), '~');
  return rules.sort((a, b) => b[0].length - a[0].length);
}
// the patterns that need no knowledge of this machine: shared with the page (public/js/diagnostics.js)
const common = require('../public/js/redact.js');
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const [from, to] of pathRules()) s = s.split(from).join(to);
  return common.redact(s);
}
// a value of any shape, every string in it redacted
function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

// one failed AI call: its provider and the first line of its error (stderr, or the error result of the CLI)
function noteAiError(provider, text) {
  const line = redact(firstLine(text)).slice(0, 300);
  if (!line) return;
  aiErrors.push({ t: new Date().toISOString(), provider: String(provider || 'claude').slice(0, 20), text: line });
  while (aiErrors.length > MAX) aiErrors.shift();
}
const recentAiErrors = () => aiErrors.slice();

module.exports = { redact, redactDeep, noteAiError, recentAiErrors, firstLine, MAX };
