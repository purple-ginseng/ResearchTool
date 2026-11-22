// Puts the fake AI CLIs (fake.js) into a folder that the tests put first on PATH: a sh wrapper per provider on
// macOS / Linux, and on Windows the file layout and shim text npm writes for a global install (<name>.cmd running
// node_modules/fake-<name>/cli.js), so the .cmd resolution of lib/platform.js is exercised for real. `agy` is the fake
// Antigravity CLI.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fake.js');
const NAMES = ['claude', 'codex', 'grok', 'agy'];
// every AI CLI the suites must never start for real - Gemini CLI included, though the app no longer runs it (no fake)
const AI_NAMES = [...NAMES, 'gemini'];

function npmShim(pkgDir) {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${pkgDir}\\cli.js" %*`, ''].join('\r\n');
}

function installFakes(bin, { names = NAMES, win = process.platform === 'win32' } = {}) {
  fs.mkdirSync(bin, { recursive: true });
  for (const n of names) {
    const js = `require(${JSON.stringify(FAKE)});\n`;
    if (win) {
      const pkg = path.join(bin, 'node_modules', 'fake-' + n);
      fs.mkdirSync(pkg, { recursive: true });
      // fake.js reads the provider from argv[2]: the cli.js puts it there
      fs.writeFileSync(path.join(pkg, 'cli.js'), `process.argv.splice(2, 0, ${JSON.stringify(n)});\n` + js);
      fs.writeFileSync(path.join(bin, n + '.cmd'), npmShim('fake-' + n));
    } else {
      fs.writeFileSync(path.join(bin, n), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${n} "$@"\n`);
      fs.chmodSync(path.join(bin, n), 0o755);
    }
  }
}

// Helper programs the features need (pdftotext ...), linked into `bin` by name from the given PATH, so the tests can run
// with a PATH that holds only `bin` and node. Never an AI CLI. Windows (a copied program would miss its DLLs): the
// folders holding them are returned instead, only those that hold no AI CLI, for the caller to put after `bin`.
const AI = new Set(AI_NAMES);
function linkHelpers(bin, pathValue, names, { win = process.platform === 'win32' } = {}) {
  fs.mkdirSync(bin, { recursive: true });
  const dirs = [];
  const hasAi = (d) => [...AI].some((n) => ['', '.exe', '.cmd', '.bat', '.ps1'].some((x) => fs.existsSync(path.join(d, n + x))));
  for (const n of names) {
    if (AI.has(n)) throw new Error('linkHelpers: never an AI CLI: ' + n);
    for (const d of String(pathValue || '').split(path.delimiter)) {
      const f = d && path.join(d, win ? n + '.exe' : n);
      try {
        if (!f || !fs.statSync(f).isFile()) continue;
        if (win) { if (!hasAi(d) && !dirs.includes(d)) dirs.push(d); }
        else { fs.rmSync(path.join(bin, n), { force: true }); fs.symlinkSync(fs.realpathSync(f), path.join(bin, n)); }
        break;
      } catch { /* next */ }
    }
  }
  return dirs;
}

// A folder holding only this node binary (a link to it; a copy where links are not allowed), for the suites' PATH:
// never the folder node itself lives in, which may hold a real CLI (Homebrew: /opt/homebrew/bin/codex, gemini ...).
// (Nothing needs node on PATH - the sh wrappers above name process.execPath - but a tool the features start might.)
function nodeOnlyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.rmSync(f, { force: true });
  try { fs.symlinkSync(process.execPath, f); } catch { fs.copyFileSync(process.execPath, f); fs.chmodSync(f, 0o755); }
  const extra = fs.readdirSync(dir).filter((n) => n !== path.basename(f));
  if (extra.length) throw new Error('nodeOnlyDir: ' + dir + ' holds more than node: ' + extra.join(', '));
  return dir;
}

module.exports = { installFakes, linkHelpers, nodeOnlyDir, npmShim, FAKE, NAMES, AI_NAMES };
