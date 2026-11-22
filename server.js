// ResearchTool — local research workspace
// Zero npm dependencies. Needs: node >= 18, pdftotext (poppler), latexmk (TeX Live), claude CLI (optional).
// Runs on macOS, Linux and Windows (what differs is in lib/platform.js).
// This file: bootstrap, static files, the same-origin security gate and the router. Everything else lives in
// lib/core.js (shared helpers) and lib/routes/*.js (one module per feature). See ARCHITECTURE.md.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./lib/core');
const { PORT, PUBLIC, WS, send, sendFile, readBody, readJsonBody } = core;

core.writeWorkspaceGuide();
core.migrate();

// ---------- route modules: every lib/routes/*.js, in file-name order ----------
const ROUTES_DIR = path.join(__dirname, 'lib', 'routes');
const routes = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => {
  const mod = require(path.join(ROUTES_DIR, f));
  if (typeof mod.handle !== 'function') throw new Error(`lib/routes/${f} must export an async handle(ctx)`);
  return { name: f, handle: mod.handle };
});

// ---------- security gate ----------
// Only this app's own pages may talk to the server: other web sites (cross-site requests, DNS rebinding) are refused.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((h) => 'http://' + h));
function forbidden(req, isApi) {
  const h = req.headers;
  if (!LOCAL_HOSTS.has(String(h.host || '').toLowerCase())) return 'Forbidden: unexpected Host header';
  if (h.origin !== undefined && !LOCAL_ORIGINS.has(h.origin)) return 'Forbidden: request from another origin';
  if (!isApi) return null;
  const site = h['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'Forbidden: request from another site';
  // every state-changing call must carry this header, which a foreign page cannot send without a (refused) preflight
  if (req.method !== 'GET' && req.method !== 'HEAD' && h['x-rt'] !== '1') return 'Forbidden: missing X-RT header';
  return null;
}

// ---------- static files (public/, including nested vendor folders) ----------
// The app page runs scripts from this server only: no inline <script>, no inline event-handler attributes and no
// javascript: URLs, whatever a note, a PDF or a rendered diagram manages to put into the DOM. ('unsafe-eval' and
// blob: are needed by vendored renderers and workers; they do not let markup run script.)
const PAGE_CSP = "script-src 'self' 'unsafe-eval' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";
function serveStatic(res, p) {
  if (p.includes('\0') || p.includes('\\')) return send(res, 400, { error: 'Bad URL' });
  // Windows: no drive / alternate-stream ':' and no name it reads differently ("x.js." is "x.js", NUL is a device)
  if (process.platform === 'win32' && p.split('/').filter(Boolean).some(core.plat.winBadName)) return send(res, 400, { error: 'Bad URL' });
  const file = path.resolve(PUBLIC, '.' + path.posix.normalize('/' + p));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  if (path.relative(PUBLIC, file).split(path.sep).some((s) => s.startsWith('.'))) return send(res, 404, { error: 'Not found' }); // no dotfiles
  const target = file === PUBLIC ? path.join(PUBLIC, 'index.html') : file;
  return sendFile(res, target, undefined, /\.html?$/i.test(target) ? { 'Content-Security-Policy': PAGE_CSP } : {});
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad URL' }); }
  const seg = p.split('/').filter(Boolean);
  const deny = forbidden(req, seg[0] === 'api');
  if (deny) return send(res, 403, { error: deny });

  if (seg[0] !== 'api') return serveStatic(res, p);

  const ctx = {
    req, res, url, path: p, segments: seg, method: req.method, query: url.searchParams,
    json: (limit) => readJsonBody(req, limit),           // parsed JSON object body ({} when empty)
    body: (limit) => readBody(req, limit),               // raw Buffer body
    send: (code, data, type) => { send(res, code, data, type); return true; },
    sendFile: (file, type, headers, after) => { sendFile(res, file, type, headers, after); return true; },
    core,
  };
  for (const r of routes) if (await r.handle(ctx)) return;
  send(res, 404, { error: 'Unknown endpoint' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e), ...(e.extra || {}) }); else res.end();
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ResearchTool running at http://localhost:${PORT}`);
  console.log(`Workspace: ${WS}`);
});

// a background job that fails (for example while the library file is damaged) must not take the server down
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message ? e.message : e));
