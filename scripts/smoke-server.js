#!/usr/bin/env node
// Smoke test of the real server: starts server.js with a fresh temporary workspace, waits for it, calls the page and
// a few API endpoints, checks the security gate, creates a project and downloads it as a zip, then stops the server.
// Exit code 1 on any failure. Works on macOS, Linux and Windows.
//
// A fake `claude` (a sh script, on Windows an npm-style claude.cmd shim) is put first on the server's PATH, so the
// real CLI is never run; GET /api/status must then report claude as installed - on Windows that proves the .cmd shim
// is found and run without a shell.
//
//   node scripts/smoke-server.js                 a free port, a workspace in the system temp folder
//   node scripts/smoke-server.js --port 4881     a given port
//   node scripts/smoke-server.js --tmp <dir>     make the temporary workspace inside <dir>
//   node scripts/smoke-server.js --pdf           also import a small generated PDF (needs pdftotext; without --pdf
//                                                that step runs only when pdftotext is installed)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Z = require('./zipread');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const WANT_PDF = argv.includes('--pdf');
const IS_WIN = process.platform === 'win32';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function request(port, method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { Host: host || `localhost:${port}`, ...headers };
    if (data) { h['Content-Length'] = data.length; if (!h['Content-Type']) h['Content-Type'] = 'application/json'; }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (/json/.test(res.headers['content-type'] || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ } }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${p}: timed out`)));
    req.on('error', reject);
    if (data) req.end(data); else req.end();
  });
}

// a one-page PDF with a line of text (Helvetica), the xref offsets computed
function tinyPdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Smoke Test Paper) /Author (Ada Tester) >>'];
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET\nBT /F1 12 Tf 72 670 Td (This short paper only checks that the import works.) Tj ET`;
  objs[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// the fake claude: answers --version and `auth status`, refuses everything else, logs every call
function fakeClaude(bin, log) {
  const js = `const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === '--version') { console.log('9.9.9 (Claude Code, smoke-test fake)'); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(1); }
console.error('fake claude: not available in the smoke test'); process.exit(3);
`;
  if (IS_WIN) { // the file layout and shim text npm writes for a global install
    const pkg = path.join(bin, 'node_modules', 'fake-claude');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), js);
    fs.writeFileSync(path.join(bin, 'claude.cmd'), ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*', ''].join('\r\n'));
  } else {
    fs.writeFileSync(path.join(bin, 'fake-claude.js'), js);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.js')}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  }
}

const checks = [];
let failed = 0;
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok });
  if (ok) console.log('ok    ' + name);
  else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + String(detail).slice(0, 600).replace(/\n/g, '\n      ') : '')); }
}

(async () => {
  const port = Number(opt('--port')) || await freePort();
  const top = fs.mkdtempSync(path.join(opt('--tmp') || os.tmpdir(), 'rt-smoke-'));
  const ws = path.join(top, 'workspace'), bin = path.join(top, 'bin'), log = path.join(top, 'claude-calls.log');
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(ws, 'settings.json'), JSON.stringify({ autoCategorize: false, backupAuto: false }));
  fakeClaude(bin, log);
  const env = { ...process.env, PORT: String(port), RT_WORKSPACE: ws };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
  for (const k of Object.keys(env)) if (/^CLAUDE/.test(k)) delete env[k];

  console.log(`smoke test: node ${process.version} on ${process.platform}, port ${port}, workspace ${ws}\n`);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  const exited = new Promise((res) => server.on('close', (code) => res(code)));
  let stopped = false;

  try {
    // ---------- wait until it answers ----------
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      if (server.exitCode != null) break;
      try { up = (await request(port, 'GET', '/')).status === 200; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('the server starts and answers', up, serverOut);
    if (!up) throw new Error('server did not start');
    check('it prints its address and workspace', /running at http:\/\/localhost:\d+/.test(serverOut) && serverOut.includes(ws), serverOut);

    // ---------- the page ----------
    const page = await request(port, 'GET', '/');
    check('GET / -> the app page with its Content-Security-Policy', page.status === 200 && /text\/html/.test(page.headers['content-type']) && /script-src 'self'/.test(page.headers['content-security-policy'] || '') && /<html/i.test(page.text));
    const js = await request(port, 'GET', '/js/core.js');
    check('GET /js/core.js -> a static script', js.status === 200 && /javascript/.test(js.headers['content-type']));
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%5cserver.js', '/js/..%2f..%2fserver.js', '/.git/config']) {
      const r = await request(port, 'GET', p);
      check(`GET ${p} -> not served`, r.status !== 200 && !r.text.includes('createServer'), r.status + ' ' + r.text.slice(0, 100));
    }

    // ---------- read-only API ----------
    const lib = await request(port, 'GET', '/api/library');
    check('GET /api/library -> an empty library', lib.status === 200 && lib.json && Array.isArray(lib.json.items) && lib.json.items.length === 0, lib.text);
    const st = await request(port, 'GET', '/api/settings');
    check('GET /api/settings', st.status === 200 && st.json && typeof st.json === 'object', st.text);
    const pr = await request(port, 'GET', '/api/projects');
    check('GET /api/projects', pr.status === 200 && Array.isArray(pr.json && pr.json.projects), pr.text);
    const tools = await request(port, 'GET', '/api/fs/tools');
    check('GET /api/fs/tools -> which optional tools exist', tools.status === 200 && ['texcount', 'synctex', 'unzip', 'spell'].every((k) => typeof tools.json[k] === 'boolean'), tools.text);
    const status = await request(port, 'GET', '/api/status');
    check('GET /api/status -> the workspace, and the (fake) claude CLI found and run without a shell', status.status === 200 && status.json.workspace === ws && status.json.claude === true, status.text);
    const auth = await request(port, 'GET', '/api/claude/auth');
    check('GET /api/claude/auth -> installed, version read, signed out', auth.status === 200 && auth.json.installed === true && auth.json.version === '9.9.9' && auth.json.loggedIn === false, auth.text);
    for (const p of ['/api/trash', '/api/categories', '/api/backup', '/api/venues', '/api/notes/recent', '/api/memberships', '/api/library/backups']) {
      const r = await request(port, 'GET', p);
      check(`GET ${p}`, r.status === 200 && r.json, r.status + ' ' + r.text.slice(0, 200));
    }
    const fsl = await request(port, 'GET', '/api/fs/list?path=' + encodeURIComponent(top));
    check('GET /api/fs/list of a folder (native path)', fsl.status === 200 && fsl.json.dirs.some((d) => d.name === 'workspace'), fsl.text.slice(0, 300));
    const unknown = await request(port, 'GET', '/api/no-such-endpoint');
    check('an unknown endpoint -> 404', unknown.status === 404);

    // ---------- the security gate ----------
    const noHeader = await request(port, 'POST', '/api/projects', { body: { name: 'nope' } });
    check('POST without the X-RT header -> 403', noHeader.status === 403 && /X-RT/.test(noHeader.text), noHeader.status + ' ' + noHeader.text);
    const foreign = await request(port, 'POST', '/api/projects', { body: { name: 'nope' }, headers: { 'X-RT': '1', Origin: 'https://evil.example' } });
    check('POST from another origin -> 403', foreign.status === 403, foreign.status + ' ' + foreign.text);
    const rebind = await request(port, 'GET', '/api/library', { host: `evil.example:${port}` });
    check('a foreign Host header (DNS rebinding) -> 403', rebind.status === 403, rebind.status + ' ' + rebind.text);
    const cross = await request(port, 'GET', '/api/library', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    check('a cross-site API read -> 403', cross.status === 403);
    check('nothing was created by the refused requests', !fs.existsSync(path.join(ws, 'projects', 'nope')));

    // ---------- a project: create, read a file, path checks, download as zip ----------
    const X = { 'X-RT': '1' };
    const made = await request(port, 'POST', '/api/projects', { body: { name: 'smoke', template: 'blank' }, headers: X });
    check('POST /api/projects (with X-RT) creates a project', made.status === 200 && made.json.project && made.json.project.id === 'smoke', made.text);
    const main = await request(port, 'GET', '/api/projects/smoke/file?path=main.tex');
    check('GET a project file', main.status === 200 && /\\documentclass/.test(JSON.stringify(main.json)), main.text.slice(0, 200));
    for (const bad of ['../settings.json', '..\\settings.json', 'a/../../settings.json', '/etc/hosts', 'C:/Windows/win.ini', '.git/config']) {
      const r = await request(port, 'GET', '/api/projects/smoke/file?path=' + encodeURIComponent(bad));
      check(`GET file?path=${bad} -> 400`, r.status === 400, r.status + ' ' + r.text.slice(0, 200));
    }
    const dl = await request(port, 'GET', '/api/projects/smoke/download');
    let zipOk = false, zipList = [];
    if (dl.status === 200) {
      const zf = path.join(top, 'smoke.zip'); fs.writeFileSync(zf, dl.buf);
      try { zipList = Z.list(zf); zipOk = zipList.includes('main.tex') && /\\documentclass/.test(Z.read(zf, 'main.tex').toString()); } catch (e) { zipList = [String(e)]; }
    }
    check('GET /api/projects/smoke/download -> a zip with main.tex (zip program or the built-in writer)', zipOk, dl.status + ' ' + zipList.join(', ') + ' ' + (dl.status !== 200 ? dl.text : ''));

    // ---------- optional: import a PDF (needs pdftotext) ----------
    const havePdftotext = status.json.pdftotext === true;
    if (havePdftotext || WANT_PDF) {
      const imp = await request(port, 'POST', '/api/import/pdf?name=smoke.pdf', { body: tinyPdf('Smoke Test Paper Title'), headers: { ...X, 'Content-Type': 'application/pdf' } });
      const it = imp.json && imp.json.item;
      check('POST /api/import/pdf -> a library item with its text read by pdftotext', imp.status === 200 && it && it.pdf === true && it.pages === 1, imp.status + ' ' + imp.text.slice(0, 400));
      if (it) {
        const sen = await request(port, 'GET', `/api/items/${it.id}/sentences`);
        check('the sentences of the imported PDF', sen.status === 200 && /import works/.test(sen.text), sen.status + ' ' + sen.text.slice(0, 300));
        const one = await request(port, 'GET', '/api/library');
        check('the library now holds it', one.json.items.length === 1);
      }
    } else console.log('skip  PDF import: pdftotext is not installed (pass --pdf to require it)');

    // ---------- the real claude was never run ----------
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    check('only the fake claude was called, and only for --version / auth status', calls.length >= 1 && calls.every((a) => a[0] === '--version' || (a[0] === 'auth' && a[1] === 'status')), JSON.stringify(calls));
  } catch (e) {
    check('smoke test ran to the end', false, e.stack || e.message);
  } finally {
    if (server.exitCode == null) server.kill();
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
    if (code === 'timeout') { try { server.kill('SIGKILL'); } catch { /* gone */ } }
    stopped = true;
    if (failed) console.log('\n--- server output ---\n' + serverOut.slice(-4000));
    try { fs.rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log('note: could not remove ' + top + ': ' + e.message); }
  }
  console.log(`\n${checks.length - failed} of ${checks.length} smoke checks passed${stopped ? ', server stopped' : ''}`);
  process.exit(failed ? 1 : 0);
})();
