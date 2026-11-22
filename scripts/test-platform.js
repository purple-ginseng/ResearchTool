#!/usr/bin/env node
// Tests for what differs between macOS, Linux and Windows (lib/platform.js and the places that use it): finding a
// tool without a shell (Windows simulated: PATH x PATHEXT, an npm .cmd shim, an .exe, a .bat that is refused), the
// PATH the server adds per platform, path containment with Windows paths (traversal attempts, drive letters, names
// Windows reads differently), the zip checks, safe file names, \r\n tool output, the zip writer, the unzip / tar
// fallback and killing a process tree. The simulations run on every OS; the real-process parts use fake tools in a
// temporary folder (a sh script here, an npm-style .cmd shim on Windows) - never the real claude CLI.
// Run:  node scripts/test-platform.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-platform-'));
process.env.RT_WORKSPACE = WS; // lib/core creates its folders there
const plat = require('../lib/platform');
const core = require('../lib/core');
const createProjects = require('../lib/projects');
const projRoutes = require('../lib/routes/projects');
const { writeZip } = require('../lib/zip');
const Z = require('./zipread');

const W = path.win32;
const IS_WIN = process.platform === 'win32';
let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 14).join('\n     ')); }
}

// ---------- a virtual Windows disk for the resolver ----------
function vdisk(files) {
  const m = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return { isFile: (f) => m.has(String(f).toLowerCase()), readFile: (f) => { const v = m.get(String(f).toLowerCase()); if (v == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v; } };
}
const SHIM_NPM7 = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', ''].join('\r\n');
const SHIM_OLD = ['@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*', ') ELSE (',
  '  @SETLOCAL', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*', ')'].join('\r\n');
const SHIM_EXE = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n';
const WIN_ENV = { Path: 'C:\\Users\\me\\AppData\\Roaming\\npm;"C:\\Program Files\\Tools";.;relative\\bin;C:\\texlive\\2025\\bin\\windows;C:\\bad',
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', SystemRoot: 'C:\\Windows' };
const DISK = vdisk({
  'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd': SHIM_NPM7,
  'C:\\Users\\me\\AppData\\Roaming\\npm\\claude': '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n', // npm's sh script: never picked
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '',
  'C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd': SHIM_OLD,
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js': '',
  'C:\\Users\\me\\AppData\\Roaming\\npm\\tool.cmd': SHIM_EXE,
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tool\\bin\\tool.exe': '',
  'C:\\Users\\me\\AppData\\Roaming\\npm\\broken.cmd': SHIM_NPM7.replace('claude-code', 'gone'), // shim whose script is missing
  'C:\\Program Files\\Tools\\pdftotext.exe': '',
  'C:\\texlive\\2025\\bin\\windows\\latexmk.exe': '',
  'C:\\bad\\latexmk.bat': '@echo off\r\nperl "%~dp0latexmk.pl" %*\r\n', // later in PATH than the .exe
  'C:\\bad\\synctex.bat': '@echo off\r\nperl "%~dp0synctex.pl" %*\r\n',
  'C:\\bad\\helper.ps1': '',
  'C:\\bad\\here.exe': '',
  'relative\\bin\\texcount.exe': '', // in a relative PATH entry: never searched
  'C:\\Windows\\System32\\tar.exe': '',
});
const winResolve = (cmd, extra = {}) => plat.resolveCmd(cmd, { platform: 'win32', env: WIN_ENV, ...DISK, execPath: 'C:\\Program Files\\nodejs\\node.exe', ...extra });

// ---------- fake tools on the real disk (for spawning real processes) ----------
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fakebin-'));
function fakeTool(name, js) {
  const script = path.join(BIN, name + '-impl.js');
  fs.writeFileSync(script, js);
  if (IS_WIN) { // exactly the form npm writes, so the real resolver path is the one taken
    fs.mkdirSync(path.join(BIN, 'node_modules', name), { recursive: true });
    fs.copyFileSync(script, path.join(BIN, 'node_modules', name, 'cli.js'));
    fs.writeFileSync(path.join(BIN, name + '.cmd'), SHIM_NPM7.replace('@anthropic-ai\\claude-code', name));
  } else {
    fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(BIN, name), 0o755);
  }
}
const withPath = async (dirs, fn) => {
  const old = process.env.PATH;
  process.env.PATH = dirs.join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = old; }
};

(async () => {
  // ================================================================ PATH
  await test('buildPath: macOS adds TeX, Homebrew, /usr/local/bin and ~/.local/bin with ":"', () => {
    const p = plat.buildPath('/usr/bin:/bin', { platform: 'darwin', home: '/Users/me' });
    assert.equal(p, '/usr/bin:/bin:/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin');
    assert.equal(plat.buildPath('/usr/local/bin:/Users/me/.local/bin/', { platform: 'darwin', home: '/Users/me' }).split(':').filter((d) => d.startsWith('/usr/local/bin')).length, 1, 'no folder twice');
  });
  await test('buildPath: Linux adds only ~/.local/bin', () => {
    assert.equal(plat.buildPath('/usr/bin', { platform: 'linux', home: '/home/me' }), '/usr/bin:/home/me/.local/bin');
    assert.ok(!plat.buildPath('/usr/bin', { platform: 'linux', home: '/home/me' }).includes('/Library/TeX'));
  });
  await test('buildPath: Windows uses ";", ~\\.local\\bin, and TeX Live / MiKTeX / npm folders only when they exist', () => {
    const dirs = new Set(['c:\\texlive\\2025\\bin\\windows', 'c:\\users\\me\\appdata\\local\\programs\\miktex\\miktex\\bin\\x64', 'c:\\users\\me\\appdata\\roaming\\npm']);
    const env = { SystemDrive: 'C:', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files' };
    const p = plat.buildPath('C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm\\', { platform: 'win32', env, home: 'C:\\Users\\me',
      isDir: (d) => dirs.has(d.toLowerCase()), list: (d) => (d.toLowerCase() === 'c:\\texlive' ? ['2024', '2025', 'tlpkg'] : []) });
    const parts = p.split(';');
    assert.deepEqual(parts, ['C:\\Windows\\system32', 'C:\\Users\\me\\AppData\\Roaming\\npm\\', 'C:\\Users\\me\\.local\\bin',
      'C:\\texlive\\2025\\bin\\windows', 'C:\\Users\\me\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64']);
    assert.ok(!p.includes('/Library/TeX') && !p.includes(':/'), p);
  });
  await test('the server PATH of this machine still holds the original folders, joined with path.delimiter', () => {
    const p = process.env.PATH.split(path.delimiter);
    assert.ok(p.includes(path.join(os.homedir(), '.local', 'bin')), process.env.PATH);
    if (process.platform === 'darwin') assert.ok(p.includes('/Library/TeX/texbin'));
    if (process.platform !== 'darwin') assert.ok(!p.includes('/Library/TeX/texbin'));
  });
  await test('envKey / getEnv: Windows names are case-blind (Path), others are not', () => {
    assert.equal(plat.getEnv({ Path: 'x' }, 'PATH', 'win32'), 'x');
    assert.equal(plat.getEnv({ Path: 'x' }, 'PATH', 'linux'), undefined);
  });

  // ================================================================ resolver (simulated Windows)
  await test('resolveCmd: not Windows -> the command unchanged (spawn searches PATH as before)', () => {
    assert.deepEqual(plat.resolveCmd('claude', { platform: 'darwin' }), { file: 'claude', args: [] });
    assert.deepEqual(plat.resolveCmd('latexmk', { platform: 'linux', env: {} }), { file: 'latexmk', args: [] });
  });
  await test('resolveCmd win32: an npm 7+ shim (claude.cmd) -> node + the script, never cmd.exe, never the sh script', () => {
    const r = winResolve('claude');
    assert.equal(r.file, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(r.args, ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js']);
    assert.equal(r.via, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    assert.ok(!/cmd\.exe/i.test(r.file));
  });
  await test('resolveCmd win32: the node.exe beside a shim is used when the shim prefers it', () => {
    const disk = vdisk({ 'C:\\n\\claude.cmd': SHIM_NPM7, 'C:\\n\\node.exe': '', 'C:\\n\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '' });
    const r = plat.resolveCmd('claude', { platform: 'win32', env: { PATH: 'C:\\n' }, ...disk, execPath: 'X:\\node.exe' });
    assert.equal(r.file, 'C:\\n\\node.exe');
  });
  await test('resolveCmd win32: the older shim form and a shim of a program (.exe target)', () => {
    assert.deepEqual(winResolve('npm').args, ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js']);
    const t = winResolve('tool');
    assert.equal(t.file, 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tool\\bin\\tool.exe'); assert.deepEqual(t.args, []);
  });
  await test('resolveCmd win32: an .exe on PATH (quoted entry with a space) is run directly', () => {
    assert.deepEqual(winResolve('pdftotext'), { file: 'C:\\Program Files\\Tools\\pdftotext.exe', args: [] });
    assert.deepEqual(winResolve('PDFTOTEXT.EXE'), { file: 'C:\\Program Files\\Tools\\PDFTOTEXT.EXE', args: [] });
  });
  await test('resolveCmd win32: an .exe earlier in PATH wins over a .bat later; a lone .bat is refused (EUNSAFECMD)', () => {
    assert.equal(winResolve('latexmk').file, 'C:\\texlive\\2025\\bin\\windows\\latexmk.exe');
    const s = winResolve('synctex');
    assert.equal(s.error.code, 'EUNSAFECMD');
    assert.match(s.error.message, /C:\\bad\\synctex\.bat/);
    assert.match(s.error.message, /native build of synctex/);
    assert.equal(winResolve('broken').error.code, 'EUNSAFECMD', 'a shim whose script is missing is not run');
    assert.equal(winResolve('helper').error.code, 'ENOENT', '.ps1 is not in PATHEXT');
  });
  await test('resolveCmd win32: not found -> ENOENT like spawn(); relative PATH entries and the current folder are never searched', () => {
    const r = winResolve('texcount');
    assert.equal(r.error.code, 'ENOENT'); assert.equal(r.error.message, 'spawn texcount ENOENT');
    assert.equal(winResolve('here').file, 'C:\\bad\\here.exe');
    assert.equal(winResolve('nothing').error.code, 'ENOENT');
    for (const bad of ['a"b', 'x|y', 'x\ny', '']) assert.equal(winResolve(bad).error.code, 'ENOENT', JSON.stringify(bad));
  });
  await test('resolveCmd win32: an absolute path is taken as it is (System32 tar.exe)', () => {
    assert.deepEqual(winResolve('C:\\Windows\\System32\\tar.exe'), { file: 'C:\\Windows\\System32\\tar.exe', args: [] });
    assert.equal(winResolve('C:\\Windows\\System32\\nope.exe').error.code, 'ENOENT');
  });
  await test('parseCmdShim: npm shims only', () => {
    assert.equal(plat.parseCmdShim(SHIM_NPM7).target, 'node_modules\\@anthropic-ai\\claude-code\\cli.js');
    assert.equal(plat.parseCmdShim(SHIM_NPM7).localNode, true);
    assert.equal(plat.parseCmdShim(SHIM_OLD).target, 'node_modules\\npm\\bin\\npm-cli.js');
    assert.equal(plat.parseCmdShim(SHIM_EXE).kind, 'exe');
    assert.equal(plat.parseCmdShim('@echo off\r\nperl "%~dp0latexmk.pl" %*\r\n'), null);
    assert.equal(plat.parseCmdShim('@echo off\r\n"%~dp0\\x.js" %*\r\n'), null, 'a .js not run by node');
    assert.equal(plat.parseCmdShim('"%dp0%\\C:\\evil.exe" %*'), null);
    assert.equal(plat.parseCmdShim(''), null);
  });
  await test('spawnTool win32 (stub spawn): file + [script, ...args], no shell, hidden window, never detached', () => {
    const calls = [];
    plat.spawnTool('claude', ['-p', 'a "title" & del *'], { cwd: 'C:\\ws', detached: true, env: WIN_ENV },
      { platform: 'win32', ...DISK, execPath: 'C:\\node.exe', spawn: (...a) => { calls.push(a); return {}; } });
    assert.equal(calls.length, 1);
    const [file, args, opts] = calls[0];
    assert.equal(file, 'C:\\node.exe');
    assert.deepEqual(args, ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '-p', 'a "title" & del *']);
    assert.equal(opts.shell, undefined); assert.equal(opts.detached, false); assert.equal(opts.windowsHide, true); assert.equal(opts.cwd, 'C:\\ws');
    assert.throws(() => plat.spawnTool('x', [], { shell: true }), /never uses a shell/);
  });
  await test('spawnTool: a tool that cannot be found or run fails like spawn() (error ENOENT / EUNSAFECMD, then close)', async () => {
    for (const [cmd, code] of [['texcount', 'ENOENT'], ['synctex', 'EUNSAFECMD']]) {
      const c = plat.spawnTool(cmd, ['x'], { env: WIN_ENV }, { platform: 'win32', ...DISK });
      const seen = [];
      c.stdout.setEncoding('utf8'); c.stdout.on('data', () => seen.push('data'));
      c.stdin.on('error', () => seen.push('stdin-error')); c.stdin.end('input');
      await new Promise((res) => { c.on('error', (e) => seen.push('error:' + e.code)); c.on('close', (k) => { seen.push('close:' + k); res(); }); });
      assert.deepEqual(seen, ['error:' + code, 'close:-2']);
      assert.equal(c.kill(), false);
    }
  });
  await test('core.run: a missing tool -> code -1 (the "not installed" answers keep working)', async () => {
    const r = await core.run('rt-no-such-tool-' + process.pid, ['-v'], { timeout: 5000 });
    assert.equal(r.code, -1); assert.match(r.err, /ENOENT/);
  });
  await test('core.run: a fake tool on PATH runs, with arguments passed as they are (no shell)', async () => {
    fakeTool('rt-echo', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const odd = ['a "b" c', '%PATH%', '& echo pwned', '$(id)', '`x`', 'C:\\x y\\z', "it's"];
    const r = await withPath([BIN, ...process.env.PATH.split(path.delimiter)], () => core.run('rt-echo', odd, { timeout: 20000 }));
    assert.equal(r.code, 0, r.err); assert.deepEqual(JSON.parse(r.out), odd);
  });

  // ================================================================ killing
  await test('killTree win32 (stub): taskkill.exe from System32 with /pid <pid> /T /F, no shell', () => {
    const calls = [];
    plat.killTree({ pid: 4242, kill() { calls.push('kill'); } }, { platform: 'win32', env: { SystemRoot: 'D:\\Win' },
      spawnFn: (...a) => { calls.push(a); return { on() {} }; } });
    assert.deepEqual(calls, [['D:\\Win\\System32\\taskkill.exe', ['/pid', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true }]]);
  });
  await test('killTree: a real child and what it started are stopped (process group / taskkill)', async () => {
    const js = `const {spawn}=require('child_process');const k=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(k.pid);setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', js], { detached: !IS_WIN, stdio: ['ignore', 'pipe', 'ignore'] });
    const grand = await new Promise((res) => { let b = ''; child.stdout.on('data', (d) => { b += d; if (b.includes('\n')) res(Number(b.trim())); }); });
    const closed = new Promise((res) => child.on('close', res));
    plat.killTree(child, { group: true });
    await closed;
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(grand); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(grand), false, 'the grandchild was left running');
  });

  // ================================================================ containment
  await test('inside (win32): drive letters case-blind, the rest exact, siblings / other drives / prefixes refused', () => {
    const t = (root, p) => plat.inside(root, p, 'win32');
    assert.ok(t('C:\\proj', 'C:\\proj')); assert.ok(t('C:\\proj', 'c:\\proj\\a\\b.tex')); assert.ok(t('c:\\proj', 'C:\\proj\\a'));
    assert.ok(!t('C:\\proj', 'C:\\proj2\\a')); assert.ok(!t('C:\\proj', 'C:\\pro')); assert.ok(!t('C:\\proj', 'D:\\proj\\a'));
    assert.ok(!t('C:\\proj', 'C:\\PROJ\\a'), 'a case difference fails closed');
    assert.ok(!t('C:\\proj', 'C:\\proj/../x'), 'not resolved here: callers pass realpaths');
    assert.ok(!t('C:\\proj', '\\\\server\\share\\proj\\a'));
    assert.ok(t('C:\\', 'C:\\x')); assert.ok(!t('C:\\', 'D:\\x'));
  });
  await test('inside (posix) is exactly the old check', () => {
    const t = (root, p) => plat.inside(root, p, 'linux');
    assert.ok(t('/a/b', '/a/b')); assert.ok(t('/a/b', '/a/b/c')); assert.ok(!t('/a/b', '/a/bc')); assert.ok(!t('/a/b', '/a/B/c'));
    if (process.platform !== 'win32') { // createProjects.inside follows the host platform
      assert.equal(createProjects.inside('/a/b', '/a/b/c'), true); assert.equal(createProjects.inside('/a/b', '/a/bc'), false);
    }
  });
  await test('insideAnyCase: case-blind on macOS / Windows (for refusals only), exact on Linux', () => {
    assert.ok(plat.insideAnyCase('C:\\Users\\Me\\ws', 'c:/users/me/WS/backups', 'win32'));
    assert.ok(plat.insideAnyCase('/Users/me/ws', '/users/ME/ws/x', 'darwin'));
    assert.ok(!plat.insideAnyCase('/home/me/ws', '/home/me/WS/x', 'linux'));
  });
  await test('normRel (win32): traversal and names Windows reads differently are refused', () => {
    const nr = (r) => createProjects.normRel(r, 'win32');
    for (const bad of ['..\\x', 'a\\..\\..\\x', 'a/../b', '../x', 'C:/Windows/x', 'C:x', 'c:', '/etc/x', '\\\\srv\\share', '~/x', 'a/.. /b', 'a/../../b',
      'a/... /b', 'x.', 'x ', 'main.tex:evil', 'main.tex::$DATA', 'NUL', 'nul.txt', 'a/CON/b', 'com1', 'LPT9.log', 'aux.tex', 'a/b?.tex', 'a*b', 'a<b', 'a|b', 'a"b', 'x\u0001y', 'a/\0b']) {
      assert.throws(() => nr(bad), (e) => e.status === 400, bad);
    }
    assert.equal(nr('sections/intro.tex'), 'sections/intro.tex');
    assert.equal(nr('./a//b/./c.tex'), 'a/b/c.tex');
    assert.equal(nr('auxiliary/console.tex'), 'auxiliary/console.tex');
    assert.equal(nr('.latexmkrc'), '.latexmkrc');
  });
  await test('normRel (macOS / Linux): unchanged - only the lexical checks', () => {
    const nr = (r) => createProjects.normRel(r, 'darwin');
    for (const bad of ['..\\x', '../x', 'a/../b', '/x', 'C:/x', '~/x', 'a\0b']) assert.throws(() => nr(bad), (e) => e.status === 400, bad);
    assert.equal(nr('notes: draft.tex'), 'notes: draft.tex'); assert.equal(nr('aux.tex'), 'aux.tex'); assert.equal(nr('x.'), 'x.');
  });
  await test('checkZip: zip-slip, absolute, drive and backslash names refused everywhere; Windows-only names on win32', () => {
    const { checkZip } = projRoutes._test;
    const e = (name, extra = {}) => [{ name, size: 1, symlink: false, special: false, ...extra }];
    for (const plt of ['darwin', 'linux', 'win32']) {
      for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'c:x', '..\\x', 'a\\b', 'a\0b']) assert.throws(() => checkZip(e(bad), plt), (x) => x.status === 400, plt + ' ' + bad);
      assert.throws(() => checkZip(e('link', { symlink: true }), plt), /symbolic link/);
      assert.doesNotThrow(() => checkZip([...e('proj/'), ...e('proj/main.tex')], plt));
    }
    for (const bad of ['a/.. /x', 'x/nul', 'CON.tex', 'main.tex:stream', 'a./b', 'd ']) {
      assert.throws(() => checkZip(e(bad), 'win32'), /Windows cannot use/, bad);
      assert.doesNotThrow(() => checkZip(e(bad), 'darwin'), bad);
    }
  });
  await test('expandHome: "~" and "~/x" everywhere, "~\\x" on Windows only', () => {
    assert.equal(plat.expandHome('~/x', '/h', 'linux'), '/h/x'); assert.equal(plat.expandHome('~', '/h', 'linux'), '/h');
    assert.equal(plat.expandHome('~\\x', '/h', 'linux'), '~\\x'); assert.equal(plat.expandHome('~x', '/h', 'linux'), '~x');
    assert.equal(plat.expandHome('~\\x', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\x');
    assert.equal(core.expandHome('~'), os.homedir());
  });
  await test('toSlash: API paths always use "/"', () => {
    assert.equal(plat.toSlash('trash\\p1\\2026-01-01T00-00-00-000Z'), 'trash/p1/2026-01-01T00-00-00-000Z');
    assert.equal(plat.toSlash(W.relative('C:\\ws', 'C:\\ws\\trash\\x')), 'trash/x');
  });

  // ================================================================ file names
  await test('names the app makes are valid on Windows: time stamps, library copies, trash bins', () => {
    for (const n of [core.stamp(), createProjects(/* not needed */ { ws: WS, readJSON: () => ({}), writeJSON() {}, template: '', loadLib: () => ({ items: [] }) }).stamp(),
      'library-20260101-120000.json', `CLAUDE-${core.stamp()}.md`]) {
      assert.ok(!plat.winBadName(n), n);
      assert.ok(!n.includes(':'), n);
    }
  });
  await test('safeFileName / winReserved', () => {
    assert.equal(plat.safeFileName('2026-01-01T10:20:30.000Z'), '2026-01-01T10-20-30.000Z');
    assert.equal(plat.safeFileName('CON'), 'CON_'); assert.equal(plat.safeFileName('nul.txt'), 'nul_.txt');
    assert.equal(plat.safeFileName('a<b>c?.'), 'a-b-c-'); assert.equal(plat.safeFileName('..'), 'file'); assert.equal(plat.safeFileName('x/y\\z'), 'x-y-z');
    for (const n of ['CON', 'prn', 'AUX', 'nul', 'COM1', 'lpt3', 'Con.txt']) assert.ok(plat.winReserved(n), n);
    for (const n of ['console', 'auxiliary', 'com', 'lpt', 'nul_']) assert.ok(!plat.winReserved(n), n);
  });

  // ================================================================ \r\n tool output
  await test('lines / lf: \\r\\n and \\n read the same', () => {
    assert.deepEqual(plat.lines('a\r\nb\nc\r\n'), ['a', 'b', 'c', '']);
    assert.equal(plat.lf('a\r\nb\rc'), 'a\nb\rc');
  });
  await test('parseLog: a LaTeX log with \\r\\n line ends (MiKTeX) gives the same errors and warnings', () => {
    const { parseLog } = projRoutes._test;
    const log = ['This is pdfTeX', './main.tex:12: Undefined control sequence.', '! Emergency stop.',
      "LaTeX Warning: Citation `smith2020' on page 1 undefined on input line 3.", 'Package hyperref Warning: Token not allowed.', ''];
    const root = IS_WIN ? 'C:\\p' : '/p';
    const lf = parseLog(log.join('\n'), root, root), crlf = parseLog(log.join('\r\n'), root, root);
    assert.deepEqual(crlf, lf);
    assert.deepEqual(lf.errors[0], { file: 'main.tex', line: 12, msg: 'Undefined control sequence.' });
    assert.equal(lf.errors[1].msg, 'Emergency stop.');
    assert.ok(lf.warnings.includes('Undefined citation: smith2020') && lf.warnings.includes('hyperref: Token not allowed.'), lf.warnings.join(' | '));
  });
  await test('parseLog: Windows paths in a log stay inside / outside the project correctly', () => {
    if (!IS_WIN) return; // path.resolve is the platform's own
    const { parseLog } = projRoutes._test;
    const r = parseLog('C:/p/sec/a.tex:3: Oops\r\nC:/texlive/2025/texmf-dist/tex/latex/x.sty:9: Bad\r\n', 'C:\\p', 'C:\\p');
    assert.deepEqual(r.errors[0], { file: 'sec/a.tex', line: 3, msg: 'Oops' });
    assert.equal(r.errors[1].file, null);
  });
  await test('synctexRecords: \\r\\n output', () => {
    const { synctexRecords } = projRoutes._test;
    const out = 'This is SyncTeX\r\nSyncTeX result begin\r\nOutput:main.pdf\r\nPage:2\r\nh:72.5\r\nv:100\r\nSyncTeX result end\r\n';
    assert.deepEqual(synctexRecords(out, 'Output'), [{ Output: 'main.pdf', Page: '2', h: '72.5', v: '100' }]);
  });
  await test('pdftotext output with \\r\\n (a fake pdftotext): pages without \\r', async () => {
    fakeTool('pdftotext', "process.stdout.write('Title line\\r\\nsecond line\\r\\n\\fPage two\\r\\n\\f');");
    const textcache = require('../lib/textcache');
    const pages = await withPath([BIN, ...process.env.PATH.split(path.delimiter)], () => textcache.pdfToPages(path.join(WS, 'x.pdf')));
    assert.deepEqual(pages, ['Title line\nsecond line\n', 'Page two\n']);
  });

  // ================================================================ zip writer (no zip program needed)
  await test('writeZip: folders, UTF-8 names, names starting with "-", stored and deflated files; read back intact', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-zsrc-')), out = path.join(WS, 'cache', 't.zip');
    const files = { '-T/a.md': 'x', 'k/k.md': '# 摘要\n' + 'text '.repeat(2000), 'k/k.pdf': '%PDF-1.4\n' + 'p'.repeat(5000), 'k/empty.txt': '', 'k/assets/i.png': Buffer.from([137, 80, 78, 71, 0, 1, 2]) };
    for (const [n, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true }); fs.writeFileSync(path.join(src, n), v); }
    const r = await writeZip(out, src, ['-T', 'k']);
    assert.equal(r.files, 5);
    const names = Z.list(out);
    for (const n of Object.keys(files)) assert.ok(names.includes(n), n + ' not in ' + names.join(', '));
    assert.ok(names.includes('k/') && names.includes('k/assets/'));
    for (const [n, v] of Object.entries(files)) assert.deepEqual(Z.read(out, n), Buffer.from(v), n);
    const ents = Z.entries(out).list;
    assert.equal(ents.find((e) => e.name === 'k/k.pdf').method, 0, 'a PDF is stored'); assert.equal(ents.find((e) => e.name === 'k/k.md').method, 8, 'text is deflated');
    // the zip(1) / bsdtar of this machine accept it too, when there is one
    const u = await core.run('unzip', ['-tq', out], { timeout: 20000 });
    if (u.code !== -1) assert.equal(u.code, 0, u.out + u.err);
    await assert.rejects(writeZip(out, src, ['../x']), /bad entry name/);
    fs.rmSync(src, { recursive: true, force: true });
  });
  await test('zipProject without a zip program: lib/zip.js writes the download', async () => {
    const pr = core.P.create('ZipMe', { template: 'blank' });
    fs.mkdirSync(path.join(pr.path, 'sec')); fs.writeFileSync(path.join(pr.path, 'sec', 'a.tex'), 'A');
    const out = await withPath([BIN], () => projRoutes._test.zipProject(core.P.get('ZipMe'))); // BIN has no zip
    assert.deepEqual(Z.list(out).sort(), ['main.tex', 'sec/a.tex']);
    assert.equal(Z.read(out, 'sec/a.tex').toString(), 'A');
  });

  // ================================================================ unzip -> tar fallback
  await test('import-zip without unzip: bsdtar (Windows System32 / macOS); GNU tar only -> "unzip not found"; checks as strict', async () => {
    const { importZip } = projRoutes._test;
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-zimp-')), zip = path.join(WS, 'cache', 'imp.zip');
    fs.mkdirSync(path.join(src, 'paper', 'fig'), { recursive: true });
    fs.writeFileSync(path.join(src, 'paper', 'main.tex'), '\\documentclass{article}\n'); fs.writeFileSync(path.join(src, 'paper', 'fig', 'a.txt'), 'fig');
    await writeZip(zip, src, ['paper']);
    // PATH = a folder with no unzip; on macOS / Linux a "tar" there that is the system's /usr/bin/tar
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-tarbin-'));
    if (!IS_WIN && fs.existsSync('/usr/bin/tar')) { fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexec /usr/bin/tar "$@"\n'); fs.chmodSync(path.join(bin, 'tar'), 0o755); }
    const ver = IS_WIN ? '' : (await core.run('/usr/bin/tar', ['--version'])).out;
    const bsd = IS_WIN || /bsdtar|libarchive/i.test(ver);
    await withPath([bin], async () => {
      const unp = await projRoutes._test.findUnpacker();
      if (!bsd) {
        assert.equal(unp, null);
        await assert.rejects(importZip(fs.readFileSync(zip), 'imp'), (e) => e.status === 501 && /unzip/.test(e.message));
        return;
      }
      assert.equal(unp.kind, 'tar');
      if (IS_WIN) assert.match(unp.cmd, /System32\\tar\.exe$/i);
      const p = await importZip(fs.readFileSync(zip), 'imp');
      assert.equal(fs.readFileSync(path.join(p.path, 'fig', 'a.txt'), 'utf8'), 'fig');
      assert.equal(p.mainFile, 'main.tex');
    });
    // a zip-slip entry never gets to the unpacker
    const evil = Buffer.from(fs.readFileSync(zip).toString('latin1').split('paper/fig/a.txt').join('../../../aa.txt') /* same length */, 'latin1');
    await assert.rejects(importZip(evil, 'evil'), (e) => e.status === 400 && /outside the project folder/.test(e.message));
    fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true });
  });

  // ================================================================ review fixes (Windows behaviour simulated)
  const hostReal = (p) => (process.platform === 'win32' ? fs.realpathSync.native(p) : fs.realpathSync(p));
  await test('realpath (win32): the native realpath, the JavaScript one where a volume makes it fail; a missing path still throws', () => {
    const calls = [];
    const mk = (nativeErr) => {
      const js = (p) => { calls.push('js'); return 'JS:' + p; };
      js.native = (p) => { calls.push('native'); if (nativeErr) throw Object.assign(new Error(nativeErr), { code: nativeErr }); return 'N:' + p; };
      return { realpathSync: js };
    };
    assert.equal(plat.realpath('G:\\My Drive\\p', { platform: 'win32', fsm: mk(null) }), 'N:G:\\My Drive\\p');
    for (const code of ['EISDIR', 'UNKNOWN', 'EPERM']) assert.equal(plat.realpath('G:\\p', { platform: 'win32', fsm: mk(code) }), 'JS:G:\\p', code);
    assert.throws(() => plat.realpath('G:\\gone', { platform: 'win32', fsm: mk('ENOENT') }), (e) => e.code === 'ENOENT');
    calls.length = 0;
    assert.equal(plat.realpath('/x', { platform: 'linux', fsm: mk('EISDIR') }), 'JS:/x'); assert.deepEqual(calls, ['js'], 'posix: as before');
    assert.equal(createProjects.realpath(WS), hostReal(WS)); // Windows: the native (long, not 8.3) form
  });
  await test('realpathNear: a folder not made yet is compared in the long form of its nearest existing parent (8.3 names)', () => {
    const long = { 'c:\\users\\runner~1\\appdata\\local\\temp': 'C:\\Users\\runneradmin\\AppData\\Local\\Temp' };
    const native = (p) => { const v = long[p.toLowerCase()]; if (!v) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v; };
    const fsm = { realpathSync: Object.assign((p) => native(p), { native }) };
    assert.equal(plat.realpathNear('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\exp\\pack', { platform: 'win32', fsm }), 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\exp\\pack');
    assert.equal(plat.realpathNear('Q:\\none\\x', { platform: 'win32', fsm }), 'Q:\\none\\x', 'nothing exists: the path as given');
    assert.ok(plat.insideAnyCase('C:\\Users\\runneradmin\\AppData\\Local\\Temp', plat.realpathNear('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\exp', { platform: 'win32', fsm }), 'win32'));
    assert.equal(plat.realpathNear(path.join(WS, 'no', 'such')), path.join(hostReal(WS), 'no', 'such'));
  });
  await test('isGitDir: .git everywhere, its 8.3 name GIT~1 on Windows too', () => {
    assert.ok(createProjects.isGitDir('.GIT', 'linux')); assert.ok(createProjects.isGitDir('GIT~1', 'win32')); assert.ok(createProjects.isGitDir('git~12', 'win32'));
    assert.ok(!createProjects.isGitDir('GIT~1', 'darwin')); assert.ok(!createProjects.isGitDir('git~x', 'win32')); assert.ok(!createProjects.isGitDir('digit~1', 'win32'));
  });
  await test('claudeRulePath: //<path> in POSIX form, //c/... on Windows (no backslashes, which are glob escapes)', () => {
    assert.equal(plat.claudeRulePath('/Users/me/ws/notes/assets/a/x.png', 'darwin'), '//Users/me/ws/notes/assets/a/x.png');
    assert.equal(plat.claudeRulePath('C:\\Users\\me\\ws\\notes\\assets\\a\\x.png', 'win32'), '//c/Users/me/ws/notes/assets/a/x.png');
    assert.equal(plat.claudeRulePath('d:/ws/x.png', 'win32'), '//d/ws/x.png');
    assert.equal(plat.claudeRulePath('\\\\server\\share\\x.png', 'win32'), null);
  });
  await test('renameSync (win32): a moment\'s EPERM / EACCES / EBUSY lock is waited out; other errors and other platforms at once', () => {
    const fsmOf = (errs) => { let n = 0; return { n: () => n, renameSync() { const e = errs[n++]; if (e) throw Object.assign(new Error(e), { code: e }); } }; };
    let slept = 0; const sleep = (ms) => { slept += ms; };
    let f = fsmOf(['EPERM', 'EBUSY', 'EACCES']); plat.renameSync('a', 'b', { platform: 'win32', fsm: f, sleep }); assert.equal(f.n(), 4); assert.ok(slept > 0);
    f = fsmOf(['ENOENT']); assert.throws(() => plat.renameSync('a', 'b', { platform: 'win32', fsm: f, sleep }), /ENOENT/); assert.equal(f.n(), 1);
    f = fsmOf(Array(1000).fill('EPERM')); assert.throws(() => plat.renameSync('a', 'b', { platform: 'win32', fsm: f, sleep, budget: 100 }), /EPERM/); assert.ok(f.n() < 20, 'gives up');
    f = fsmOf(['EPERM']); assert.throws(() => plat.renameSync('a', 'b', { platform: 'linux', fsm: f, sleep }), /EPERM/); assert.equal(f.n(), 1);
    const a = path.join(WS, 'ren-a'), b = path.join(WS, 'ren-b'); fs.writeFileSync(a, 'x'); plat.renameSync(a, b); assert.equal(fs.readFileSync(b, 'utf8'), 'x');
  });
  await test('killTree: a child that has already exited is never killed (its pid may be reused); the signal is the caller\'s', () => {
    const calls = [];
    const spawnFn = (...a) => { calls.push(a); return { on() {} }; };
    plat.killTree({ pid: 4242, exitCode: 0, signalCode: null, kill() { calls.push('kill'); } }, { platform: 'win32', spawnFn });
    plat.killTree({ pid: 4242, exitCode: null, signalCode: 'SIGTERM', kill() { calls.push('kill'); } }, { platform: 'win32', spawnFn });
    assert.deepEqual(calls, []);
    plat.killTree({ pid: 7, exitCode: null, signalCode: null, kill(sig) { calls.push(sig); } }, { platform: 'linux', signal: 'SIGTERM' });
    plat.killTree({ pid: 7, exitCode: null, signalCode: null, kill(sig) { calls.push(sig); } }, { platform: 'darwin' });
    assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']);
    plat.killTree({ pid: 9, exitCode: null, signalCode: null, kill() { calls.push('kill'); } }, { platform: 'win32', signal: 'SIGTERM', spawnFn, env: {} });
    assert.equal(calls[2][0], 'C:\\Windows\\System32\\taskkill.exe', 'Windows: always the whole tree');
  });
  await test('parseCmdShim / resolveCmd win32: a shim target with ".." or outside the shim folder, and relative paths, are never run', () => {
    assert.equal(plat.parseCmdShim('"%dp0%\\..\\..\\other\\x.exe" %*'), null);
    assert.equal(plat.parseCmdShim('"%_prog%" "%dp0%\\node_modules\\..\\..\\x.js" %*'), null);
    assert.equal(plat.parseCmdShim('"%dp0%\\node_modules\\a..b\\x.exe" %*').target, 'node_modules\\a..b\\x.exe', '".." inside a name is fine');
    assert.equal(winResolve('bin\\tool').error.code, 'ENOENT');
    assert.equal(winResolve('.\\here.exe').error.code, 'ENOENT');
    assert.equal(winResolve('C:here.exe').error.code, 'ENOENT');
    assert.equal(winResolve('C:\\bad\\here.exe').file, 'C:\\bad\\here.exe');
  });
  await test('checkZip: "./" entries (Windows tar) are fine on win32; one file twice is refused, case-blind on Windows / macOS', () => {
    const { checkZip } = projRoutes._test;
    const z = (...names) => names.map((name) => ({ name, size: 1, symlink: false, special: false }));
    for (const plt of ['win32', 'darwin', 'linux']) assert.doesNotThrow(() => checkZip(z('./', './main.tex', './sec/', './sec/a.tex'), plt), plt);
    for (const plt of ['win32', 'darwin']) assert.throws(() => checkZip(z('A.tex', 'a.tex'), plt), /same file twice/, plt);
    assert.doesNotThrow(() => checkZip(z('A.tex', 'a.tex'), 'linux'));
    for (const plt of ['win32', 'darwin', 'linux']) {
      assert.throws(() => checkZip(z('main.tex', './main.tex'), plt), /same file twice/, plt);
      assert.throws(() => checkZip(z('x/a.tex', 'x/a.tex'), plt), /same file twice/, plt);
      assert.doesNotThrow(() => checkZip(z('sec/', 'Sec/a.tex', 'sec/b.tex'), plt), 'folders may differ in case');
    }
  });
  await test('zipEntries: a zip whose local header names an entry differently from the central directory is refused', async () => {
    const { zipEntries } = projRoutes._test;
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-zname-')), zip = path.join(WS, 'cache', 'names.zip');
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
    await writeZip(zip, src, ['a.txt']);
    const buf = fs.readFileSync(zip);
    assert.deepEqual(zipEntries(buf).map((e) => e.name), ['a.txt']);
    const local = Buffer.from(buf), at = local.indexOf('a.txt'); local.write('NUL.x', at, 'latin1'); // local name only
    assert.throws(() => zipEntries(local), (e) => e.status === 400 && /two different names/.test(e.message));
    const cen = Buffer.from(buf), at2 = cen.lastIndexOf('a.txt'); cen.write('b.txt', at2, 'latin1'); // central name only
    assert.throws(() => zipEntries(cen), /two different names/);
    const off = Buffer.from(buf); off.writeUInt32LE(3, off.lastIndexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 42); // no local header there
    assert.throws(() => zipEntries(off), /not a valid \.zip/);
    fs.rmSync(src, { recursive: true, force: true });
  });
  await test('writeZip: a link (junction) back to "." does not loop, a link out of the folder is not followed', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-zloop-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-zout-')), out = path.join(WS, 'cache', 'loop.zip');
    fs.mkdirSync(path.join(src, 'd')); fs.writeFileSync(path.join(src, 'd', 'a.txt'), 'a'); fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    try { fs.symlinkSync(src, path.join(src, 'd', 'loop'), 'junction'); fs.symlinkSync(outside, path.join(src, 'd', 'out'), 'junction'); }
    catch (e) { console.log('     (links cannot be made here: ' + e.code + ')'); return; }
    const r = await writeZip(out, src, ['d']);
    assert.deepEqual(Z.list(out).sort(), ['d/', 'd/a.txt']);
    assert.equal(r.files, 1);
    fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  });
  await test('folder browser (win32 simulated): the parent of C:\\ is "This PC", which lists the drives', () => {
    const { fsListing } = projRoutes._test;
    const drives = new Set(['C:\\', 'D:\\']);
    const dirent = (name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
    const fsm = { statSync: (d) => { if (!drives.has(d)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isDirectory: () => true }; },
      readdirSync: (d) => (d === 'C:\\' ? [dirent('Users'), dirent('.hidden')] : []) };
    const top = fsListing('C:\\', { platform: 'win32', home: 'C:\\Users\\me', fsm });
    assert.deepEqual(top.body, { path: 'C:\\', parent: 'This PC', dirs: [{ name: 'Users', path: 'C:\\Users' }] });
    assert.deepEqual(fsListing('This PC', { platform: 'win32', fsm }).body, { path: 'This PC', parent: null, dirs: [{ name: 'C:\\', path: 'C:\\' }, { name: 'D:\\', path: 'D:\\' }] });
    assert.equal(fsListing('C:\\Users', { platform: 'win32', fsm }).body.parent, 'C:\\');
    assert.equal(fsListing('relative', { platform: 'win32', fsm }).status, 400);
    assert.equal(fsListing('This PC', { platform: 'linux', fsm }).status, 400, 'only on Windows');
    assert.equal(fsListing('/', { platform: 'linux', fsm: { readdirSync: () => [] } }).body.parent, null);
  });
  await test('Overleaf git: no CRLF conversion, long paths, hooks path per platform', () => {
    const ol = require('../lib/overleaf');
    const cfg = (plt) => { const a = ol.baseCfg(plt, 'C:\\node\\node.exe'); return a.filter((x, i) => a[i - 1] === '-c'); };
    for (const plt of ['win32', 'darwin', 'linux']) { assert.ok(cfg(plt).includes('core.autocrlf=false')); assert.ok(cfg(plt).includes('core.longpaths=true')); }
    assert.ok(cfg('win32').includes('core.hooksPath=C:\\node\\node.exe'));
    assert.ok(cfg('linux').includes('core.hooksPath=/dev/null'));
  });

  // ================================================================ wording
  await test('messages name the credential store and the git install of the platform', () => {
    assert.match(plat.credentialStore('darwin'), /Keychain/); assert.match(plat.credentialStore('win32'), /Credential Manager/); assert.match(plat.credentialStore('linux'), /credential helper/);
    assert.match(plat.installGitHint('darwin'), /xcode-select/); assert.match(plat.installGitHint('win32'), /Git for Windows/); assert.match(plat.installGitHint('linux'), /apt/);
    const ol = require('../lib/overleaf');
    assert.ok(!ol.loginCommand('0123456789abcdef01234567', 'win32').includes('\\'), 'Git Bash gets forward slashes');
  });

  for (const d of [BIN, WS]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp folder Windows still holds */ } }
  console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} platform tests passed`);
  process.exit(failed ? 1 : 0);
})();
