#!/usr/bin/env node
// Tests for the app's own updates (lib/update.js, lib/routes/update.js): the opt-in, fast-forward-only update from
// the official repository. Nothing here touches this repository (beyond one read-only `git ls-files` for the hygiene
// check) or the network: every "origin" is a bare repository in a temporary folder, reached through git's local-file
// transport, and the updater under test gets that folder as its app folder, the bare repository as the address to
// fetch and a matcher that accepts it - all parameters of createUpdater() that no setting, request or environment
// variable can reach. HOME is a temporary folder too, so the developer's own git settings play no part.
// Covered: every reason not to update (not a clone, inside another repository, a linked work tree, git missing, a
// fork, another branch, a detached HEAD, no upstream, a changed tracked file, a merge in progress, index.lock,
// redirected addresses, ahead, diverged, an origin that cannot be reached), the update itself (untracked and ignored
// files and a workspace with data are byte for byte the same afterwards), what must never run (hooks, fsmonitor,
// uploadpack, a stash, a filter, core.alternateRefsCommand, a refspec of a remote named like the address), the
// settings inside .git that stop an update (configProblem, gitDirProblem), that the request carries no header or
// cookie of the user's git settings and checks the certificate whatever they say, a fast-forward that stops half way
// (and the repair the README gives), git that hangs (a stand-in that sleeps), the page's notice and status line
// (public/js/update.js, run in a vm with a stand-in for RT), what a new version must never contain (a file in workspace/ or backups/, a symbolic link, a
// submodule, a name Windows cannot write, a case collision, a newer Node, a higher update epoch), one check at a
// time, the rate limit, the daily tick (and that it starts nothing with the box off), the kill switch, the setting's
// validation and the two endpoints.
// Run:  node scripts/test-update.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const http = require('node:http');

const TOP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-update-'));
const WS = path.join(TOP, 'ws');
fs.mkdirSync(WS);
process.env.RT_WORKSPACE = WS;   // lib/core creates its folders there
process.env.RT_NO_UPDATE = '1';  // the updater of the real app folder (update.real()) stays off in this process
const core = require('../lib/core');
const plat = require('../lib/platform');
const update = require('../lib/update');

const IS_WIN = process.platform === 'win32';
let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 14).join('\n     ')); }
}

// ---------- git for the fixtures: a HOME of its own (no global settings of this computer), no inherited GIT_* ----------
const HOME = path.join(TOP, 'home');
fs.mkdirSync(HOME);
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
Object.assign(ENV, { HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' });
const FIX = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false',
  '-c', 'core.autocrlf=false', '-c', 'protocol.file.allow=always', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'advice.detachedHead=false'];
function G(cwd, ...args) {
  const r = spawnSync('git', [...FIX, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} -> ${r.status}: ${(r.stderr || r.error || '').toString().slice(0, 400)}`);
  return r.stdout;
}
const HAS_GIT = spawnSync('git', ['--version'], { env: ENV, encoding: 'utf8', windowsHide: true }).status === 0;
const head = (dir, ref = 'HEAD') => G(dir, 'rev-parse', ref).trim();
const write = (dir, rel, data) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const same = (a, b) => { try { return plat.samePath(plat.realpath(path.resolve(a)), plat.realpath(path.resolve(b))); } catch { return false; } };
// sha-256 of every file below `dir` (not .git): {relative path: hash}
function hashes(dir, skip = (rel) => rel === '.git') {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name), rel = plat.toSlash(path.relative(dir, f));
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(f); else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const PKG = (version, more = {}) => JSON.stringify({ name: 'researchtool', version, engines: { node: '>=18' }, updateEpoch: 1, ...more }, null, 2) + '\n';

// One bare "origin", a "seed" clone that pushes new versions to it, and an "app" clone: the folder that updates itself.
let seq = 0;
function fixture({ ignore = false, shallow = false } = {}) {
  const dir = path.join(TOP, 'fx' + (++seq));
  fs.mkdirSync(dir);
  const bare = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed'), app = path.join(dir, 'app');
  G(dir, 'init', '-q', '--bare', 'origin.git');
  G(dir, 'init', '-q', 'seed');
  G(seed, 'remote', 'add', 'origin', bare);
  write(seed, 'package.json', PKG('1.0.0'));
  write(seed, 'server.js', "console.log('one');\n");
  write(seed, 'lib/a.js', 'module.exports = 1;\n');
  write(seed, 'public/js/x.js', '// page\n');
  write(seed, '.gitattributes', '* text=auto eol=lf\n'); // as the app has it: LF on every platform, whatever core.autocrlf says
  if (ignore) write(seed, '.gitignore', '/workspace/\n/backups/\n*.log\n');
  G(seed, 'add', '-A'); G(seed, 'commit', '-q', '-m', 'one');
  G(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  G(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  if (shallow) {
    write(seed, 'lib/b.js', 'module.exports = 2;\n'); G(seed, 'add', '-A'); G(seed, 'commit', '-q', '-m', 'two'); G(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    G(dir, 'clone', '-q', '--depth', '1', pathToFileURL(bare).href, 'app');
  } else G(dir, 'clone', '-q', bare, 'app');
  const fx = { dir, bare, seed, app, calls: [] };
  // a new version on origin: {path: text | null (deleted)}, committed in the seed and pushed
  fx.push = (files, { force = false } = {}) => {
    for (const [rel, data] of Object.entries(files)) { if (data === null) fs.rmSync(path.join(seed, ...rel.split('/'))); else write(seed, rel, data); }
    G(seed, 'add', ...(force ? ['-f'] : []), '-A'); G(seed, 'commit', '-q', '-m', 'next'); G(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return head(seed);
  };
  // an entry that needs no file on this disk: a symbolic link, a submodule, a second name in another case ...
  fx.pushEntry = (mode, rel, content = 'x\n') => {
    const blob = mode === '160000' ? head(seed) : spawnSync('git', [...FIX, 'hash-object', '-w', '--stdin'], { cwd: seed, env: ENV, input: content, encoding: 'utf8', windowsHide: true }).stdout.trim();
    G(seed, '-c', 'core.protectNTFS=false', '-c', 'core.protectHFS=false', 'update-index', '--add', '--cacheinfo', `${mode},${blob},${rel}`);
    G(seed, 'commit', '-q', '-m', 'entry'); G(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return head(seed);
  };
  fx.updater = (o = {}) => update.createUpdater({ root: app, allowOrigin: (u) => same(u, bare), fetchUrl: bare, protocols: ['file'], env: ENV,
    settings: () => ({}), minInterval: 0, lookInterval: 0, onGit: (a) => fx.calls.push(a), log: () => {}, ...o });
  fx.fetched = () => fx.calls.filter((a) => a[0] === 'fetch').length;
  return fx;
}
const ctxOf = (method, p, body) => {
  const url = new URL('http://localhost' + p); let sent = null;
  return { get sent() { return sent; }, ctx: { req: {}, url, path: url.pathname, segments: url.pathname.split('/').filter(Boolean), method, query: url.searchParams,
    json: async () => body || {}, send: (code, data) => { sent = { code, data }; return true; }, core } };
};
async function route(handle, method, p, body) {
  const c = ctxOf(method, p, body);
  try { if (!(await handle(c.ctx))) return { code: 404, data: { error: 'not handled' } }; } catch (e) { return { code: e.status || 500, data: { error: e.message } }; }
  return c.sent;
}
// a hook (a sh script) that leaves a marker file when git runs it
function plantHook(app, name, marker) {
  const f = path.join(app, '.git', 'hooks', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `#!/bin/sh\necho ran >> "${plat.toSlash(marker)}"\nexit 0\n`);
  fs.chmodSync(f, 0o755);
}

(async () => {
  // ================================================================= without git
  await test('the official repository: https and ssh forms of purple-ginseng/ResearchTool, nothing else', () => {
    for (const ok of ['https://github.com/purple-ginseng/ResearchTool', 'https://github.com/purple-ginseng/ResearchTool.git', 'https://github.com/Purple-Ginseng/researchtool.git/',
      'git@github.com:purple-ginseng/ResearchTool.git', 'git@github.com:purple-ginseng/ResearchTool', 'ssh://git@github.com/purple-ginseng/ResearchTool.git']) assert.equal(update.isOfficial(ok), true, ok);
    for (const bad of ['https://github.com/someone/ResearchTool.git', 'https://github.com/purple-ginseng/ResearchTool-fork', 'https://github.com/purple-ginseng/ResearchTool.git.evil',
      'http://github.com/purple-ginseng/ResearchTool.git', 'https://github.com@evil.example/purple-ginseng/ResearchTool.git', 'https://token@github.com/purple-ginseng/ResearchTool.git',
      'https://github.com.evil.example/purple-ginseng/ResearchTool.git', 'https://github.com:444/purple-ginseng/ResearchTool.git', 'https://github.com/purple-ginseng/ResearchTool.git?x=1',
      'https://github.com/purple-ginseng/ResearchTool.git#x', 'https://evil.example/https://github.com/purple-ginseng/ResearchTool.git', 'git@github.com:purple-ginseng/ResearchTool.git\nx',
      ' https://github.com/purple-ginseng/ResearchTool.git', 'file:///tmp/purple-ginseng/ResearchTool.git', '/tmp/ResearchTool.git', 'ext::sh -c x', '', null, undefined, 5,
      'https://github.com/purple-ginseng/ResearchTool/' + 'x'.repeat(300)]) assert.equal(update.isOfficial(bad), false, String(bad));
    assert.equal(update.isOfficial(update.OFFICIAL_URL), true);
    assert.match(update.OFFICIAL_URL, /^https:\/\//);
  });

  await test('settings: autoUpdate must be true or false; absent means off', () => {
    for (const bad of ['yes', 1, 0, null, 'true', {}, []]) assert.throws(() => update.configure({}, { autoUpdate: bad }), (e) => e.status === 400 && /autoUpdate must be true or false/.test(e.message), String(bad));
    const s = { other: 1 };
    update.configure(s, {}); assert.deepEqual(s, { other: 1 });
    update.configure(s, { autoUpdate: true }); assert.equal(s.autoUpdate, true);
    update.configure(s, { draftLanguage: 'en' }); assert.equal(s.autoUpdate, true, 'a PUT of other keys leaves it');
    update.configure(s, { autoUpdate: false }); assert.ok(!('autoUpdate' in s), 'off is the absent key');
  });

  await test('PUT /api/settings: a non-boolean autoUpdate is a 400; true / false are saved; the (switched-off) real updater starts nothing', async () => {
    const lib = require('../lib/routes/library');
    const real = update.real();
    let r = await route(lib.handle, 'PUT', '/api/settings', { autoUpdate: 'yes' });
    assert.equal(r.code, 400); assert.match(r.data.error, /autoUpdate must be true or false/);
    r = await route(lib.handle, 'GET', '/api/settings');
    assert.equal(r.data.autoUpdate, false, 'off by default');
    r = await route(lib.handle, 'PUT', '/api/settings', { autoUpdate: true });
    assert.equal(r.code, 200); assert.equal(r.data.autoUpdate, true);
    assert.equal(core.readJSON(core.SETTINGS_FILE, {}).autoUpdate, true);
    r = await route(lib.handle, 'PUT', '/api/settings', { draftLanguage: 'en' });
    assert.equal(r.data.autoUpdate, true, 'a partial PUT (the page sends one at load) keeps it');
    r = await route(lib.handle, 'PUT', '/api/settings', { autoUpdate: false });
    assert.equal(r.data.autoUpdate, false); assert.ok(!('autoUpdate' in core.readJSON(core.SETTINGS_FILE, {})));
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(real.stats.spawns, 0, 'RT_NO_UPDATE=1: not one git process');
  });

  await test('the kill switch RT_NO_UPDATE=1: the real updater reports "disabled" and never starts git, whatever is asked', async () => {
    const real = update.real();
    const up = require('../lib/routes/update');
    assert.equal(up.updater, real);
    let r = await route(up.handle, 'GET', '/api/update/status?local=1');
    assert.equal(r.code, 200); assert.equal(r.data.disabled, true); assert.equal(r.data.supported, false); assert.equal(r.data.reason, 'disabled');
    assert.equal(r.data.version, require('../package.json').version); assert.equal(r.data.running.version, r.data.version); assert.equal(r.data.restartNeeded, false);
    r = await route(up.handle, 'POST', '/api/update/check', { apply: true });
    assert.equal(r.code, 200); assert.equal(r.data.result, 'failed'); assert.equal(r.data.reason, 'disabled'); assert.equal(r.data.updated, null);
    assert.equal(await real.tick(), null);
    real.kick();
    assert.equal(real.stats.spawns, 0);
    assert.equal((await route(up.handle, 'POST', '/api/update/check', { apply: 'yes' })).code, 400);
    assert.equal((await route(up.handle, 'GET', '/api/update/check')).code, 404, 'a check is never a GET');
    assert.equal((await route(up.handle, 'POST', '/api/update/status')).code, 404);
  });

  await test('what a new version may contain: no file in the workspace or backups, no link, no submodule, no name Windows cannot write, no case collision', () => {
    const t = (...paths) => paths.map((p) => (typeof p === 'string' ? { mode: '100644', path: p } : p));
    assert.equal(update.treeProblem(t('server.js', 'lib/a.js', 'public/js/i18n/zh.js', 'docs/a b.md', 'public/vendor/x/LICENSE', { mode: '100755', path: 'scripts/x.sh' })), null);
    assert.deepEqual(update.treeProblem(t('server.js', 'workspace/library.json')), { what: 'user-data', path: 'workspace/library.json' });
    assert.equal(update.treeProblem(t('Workspace/x')).what, 'user-data', 'without case: the disk may not have one');
    assert.equal(update.treeProblem(t('BACKUPS/snapshot-1/x')).what, 'user-data');
    assert.equal(update.treeProblem(t('workspace')).what, 'user-data');
    assert.equal(update.treeProblem(t('workspace-notes.md', 'backups.md', 'docs/workspace/x.md')), null, 'only the folders themselves');
    assert.equal(update.treeProblem(t('data/ws/x.json'), ['workspace', 'backups', 'data/ws']).what, 'user-data', 'a workspace elsewhere inside the app folder');
    assert.equal(update.treeProblem(t({ mode: '120000', path: 'link' })).what, 'symlink');
    assert.equal(update.treeProblem(t({ mode: '160000', path: 'vendor/sub' })).what, 'submodule');
    assert.equal(update.treeProblem(t('.gitmodules')).what, 'submodule');
    assert.equal(update.treeProblem(t({ mode: '100664', path: 'x' })).what, 'mode');
    for (const bad of ['aux.txt', 'lib/con', 'a/b:c.js', 'x/trailing.', 'x/space ', 'a\\b', 'docs/NUL.md', 'x/.git/config', 'a/../b']) assert.equal(update.treeProblem(t(bad)).what, 'bad-name', bad);
    assert.deepEqual(update.treeProblem(t('README.md', 'lib/a.js', 'Readme.md')), { what: 'case', path: 'Readme.md' });
    assert.equal(update.treeProblem(t('lib/a.js', 'Lib/b.js')).what, 'case', 'folders too');
    assert.equal(update.treeProblem(t('lib/a.js', 'lib/b.js', 'lib/sub/a.js')), null);
    assert.deepEqual(update.parseTree('100644 blob ' + 'a'.repeat(40) + '\tserver.js\0' + '120000 blob ' + 'b'.repeat(40) + '\tdocs/a b.md\0'), [{ mode: '100644', path: 'server.js' }, { mode: '120000', path: 'docs/a b.md' }]);
  });

  await test('package.json of a new version: a sane version, a Node this computer has, an update epoch this updater knows', () => {
    assert.deepEqual(update.packageProblem(PKG('1.2.3'), '18.0.0'), { version: '1.2.3' });
    assert.deepEqual(update.packageProblem(JSON.stringify({ version: '0.1.2' }), '18.0.0'), { version: '0.1.2' }, 'no engines, no epoch: fine');
    assert.equal(update.packageProblem(PKG('1.2.3', { engines: { node: '>=20' } }), '18.19.0').reason, 'needs-node');
    assert.deepEqual(update.packageProblem(PKG('1.2.3', { engines: { node: '>=20.5' } }), '20.4.9').detail, { version: '1.2.3', needs: '>=20.5' });
    assert.deepEqual(update.packageProblem(PKG('1.2.3', { engines: { node: '>=20.5' } }), '20.5.0'), { version: '1.2.3' });
    assert.equal(update.packageProblem(PKG('1.2.3', { engines: { node: '^20 || <script>' } }), '20.5.0').reason, 'needs-node', 'a form that cannot be judged: no');
    assert.equal(update.packageProblem(PKG('1.2.3', { engines: { node: '<script>alert(1)</script>' } }), '20.5.0').detail.needs, 'script>alert1script>', 'what is shown of it can never be a tag');
    assert.equal(update.packageProblem(PKG('1.2.3', { updateEpoch: update.EPOCH + 1 }), '18.0.0').reason, 'manual');
    assert.equal(update.packageProblem(PKG('1.2.3', { updateEpoch: 'x' }), '18.0.0').reason, 'manual');
    for (const bad of ['{', '[]', 'null', JSON.stringify({ version: 5 }), JSON.stringify({ version: '<img src=x>' }), JSON.stringify({ version: '1.0' }), JSON.stringify({ version: '1.0.0' + 'x'.repeat(40) })]) {
      assert.deepEqual(update.packageProblem(bad, '18.0.0'), { reason: 'blocked', detail: { what: 'package' } }, bad);
    }
    assert.equal(update.nodeOk('>=18', '18.0.0'), true); assert.equal(update.nodeOk('>= 18.17.1', '18.17.0'), false); assert.equal(update.nodeOk('>=18', '24.1.0'), true);
    assert.equal(update.nodeOk(undefined, '12.0.0'), true); assert.equal(update.nodeOk('18.x', '18.0.0'), false);
  });

  await test('this app passes its own rules: package.json is one the updater installs, and no tracked file is one it refuses', () => {
    const ROOT = path.join(__dirname, '..');
    const pk = update.packageProblem(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), '18.0.0');
    assert.deepEqual(pk, { version: require('../package.json').version }, 'package.json: ' + JSON.stringify(pk));
    assert.ok(require('../package.json').updateEpoch <= update.EPOCH);
    let isClone = false; try { isClone = fs.lstatSync(path.join(ROOT, '.git')).isDirectory(); } catch { /* from a ZIP */ }
    if (!HAS_GIT || !isClone) return console.log('     (not a git clone, or no git: the tracked files were not checked)');
    // read-only: the index of this repository (the same record shape as ls-tree: mode, id, tab, path)
    const r = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-s', '-z'], { cwd: ROOT, env: { ...ENV, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', maxBuffer: 64e6, windowsHide: true });
    if (r.status !== 0) return console.log('     (git ls-files failed here: ' + String(r.stderr).trim().slice(0, 120) + ')');
    const entries = update.parseTree(r.stdout);
    assert.ok(entries.length > 100, 'the tracked files were read: ' + entries.length);
    assert.equal(update.treeProblem(entries), null, 'a tracked file that the updater would refuse on every computer');
  });

  await test('git is never asked the user\'s way: no inherited GIT_* variable, https only, no hooks, no prompts - and no variable widens it', () => {
    const env = update.gitEnv({ PATH: '/x', HOME: '/h', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', git_index_file: '/i', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/evil',
      GIT_SSL_NO_VERIFY: '1', GIT_ALLOW_PROTOCOL: 'file:ext', GIT_SSH_COMMAND: 'evil', GIT_ASKPASS: '/evil', GIT_CONFIG_GLOBAL: '/evil', GIT_SSL_CAINFO: '/ca.pem', GIT_EXEC_PATH: '/git-core',
      RT_UPDATE_URL: 'https://evil.example/x.git', RT_UPDATE_ORIGIN: '.*', https_proxy: 'http://proxy:8080' }, path.join(TOP, 'app'), ['https']);
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'git_index_file', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSL_NO_VERIFY', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL']) assert.ok(!(k in env), k);
    assert.equal(env.GIT_ALLOW_PROTOCOL, 'https'); assert.equal(env.GIT_ASKPASS, ''); assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(env.GCM_INTERACTIVE, 'never');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1'); assert.equal(env.GIT_CEILING_DIRECTORIES, TOP);
    assert.equal(env.GIT_SSL_CAINFO, '/ca.pem'); assert.equal(env.GIT_EXEC_PATH, '/git-core'); assert.equal(env.https_proxy, 'http://proxy:8080'); assert.equal(env.PATH, '/x');
    const cfg = update.gitCfg(['https'], 'linux', '/usr/bin/node'), has = (c) => cfg.some((x, i) => x === c && cfg[i - 1] === '-c');
    for (const c of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'credential.helper=', 'core.askPass=', 'protocol.allow=never', 'protocol.https.allow=always', 'protocol.ext.allow=never',
      'merge.autoStash=false', 'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'http.sslVerify=true', 'gc.auto=0',
      'branch.main.mergeOptions=', 'http.extraHeader=', 'http.cookieFile=', 'http.saveCookies=false',
      // the same again for exactly the address that is fetched: a key that names an address beats the plain one
      `http.${update.OFFICIAL_URL}.sslVerify=true`, `http.${update.OFFICIAL_URL}.extraHeader=`, `http.${update.OFFICIAL_URL}.cookieFile=`, `http.${update.OFFICIAL_URL}.saveCookies=false`]) assert.ok(has(c), c);
    assert.ok(cfg.lastIndexOf(`http.${update.OFFICIAL_URL}.sslVerify=true`) > cfg.lastIndexOf('http.sslVerify=true'), 'the one for the address comes last');
    assert.ok(!update.gitCfg(['file'], 'linux', '/usr/bin/node', '/tmp/x/origin.git').some((c) => /^http\.\//.test(c)), 'a local path (the tests): no such key');
    assert.ok(!update.gitCfg(['https'], 'linux', '/usr/bin/node', 'https://example.invalid/a=b.git').some((c) => /^http\.https/.test(c)), 'an address that cannot stand in a key is left out, not mangled');
    assert.ok(!cfg.some((c) => /^protocol\.(file|ssh|git|http)\.allow/.test(c)), 'https and nothing else');
    assert.ok(!cfg.some((c) => /^core\.(autocrlf|fileMode)=/i.test(c)), 'line ends and file modes are left as the repository has them');
    assert.ok(update.gitCfg(['https'], 'win32', 'C:\\node\\node.exe').includes('core.hooksPath=C:\\node\\node.exe'), 'Windows: a path below a file');
    // the real updater: the constants, whatever the environment says
    const u = update.createUpdater({ root: path.join(TOP, 'nowhere'), env: { PATH: '/x', GIT_ALLOW_PROTOCOL: 'file', RT_UPDATE_URL: 'x' } });
    assert.equal(u.env.GIT_ALLOW_PROTOCOL, 'https'); assert.ok(u.cfg.includes('protocol.https.allow=always') && !u.cfg.includes('protocol.file.allow=always'));
  });

  await test('why a download failed: offline (no network, a portal, a certificate, a timeout), git missing, or something else', () => {
    for (const err of ["fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com", 'fatal: unable to access: Failed to connect to github.com port 443 after 75000 ms: Operation timed out',
      'SSL certificate problem: unable to get local issuer certificate', 'error: RPC failed; curl 56 Recv failure: Connection reset by peer', 'fatal: the remote end hung up unexpectedly',
      'The requested URL returned error: 503']) assert.equal(update.fetchReason({ code: 128, err }), 'offline', err);
    assert.equal(update.fetchReason({ code: null, err: '', timedOut: true }), 'offline');
    assert.equal(update.fetchReason({ code: -1, err: 'spawn git ENOENT' }), 'no-git');
    assert.equal(update.fetchReason({ code: 128, err: "fatal: repository 'https://github.com/x/' not found" }), 'fetch-failed');
  });

  await test('a folder that is not a git clone (installed from a ZIP): "not-git", and git is not even started', async () => {
    const app = path.join(TOP, 'zip'); write(app, 'package.json', PKG('1.0.0'));
    const calls = [];
    const u = update.createUpdater({ root: app, env: ENV, settings: () => ({ autoUpdate: true }), onGit: (a) => calls.push(a) });
    let s = await u.status({ local: true });
    assert.equal(s.supported, false); assert.equal(s.reason, 'not-git'); assert.equal(s.version, '1.0.0'); assert.equal(s.commit, ''); assert.equal(s.restartNeeded, false);
    s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, 'not-git'); assert.equal(s.lastCheck.reason, 'not-git');
    await u.tick();
    assert.deepEqual(calls, []);
  });

  await test('the last check kept on disk is display only: garbage in it is never shown or trusted', async () => {
    const app = path.join(TOP, 'zip2'); write(app, 'package.json', PKG('1.0.0'));
    const stateFile = path.join(TOP, 'state-garbage.json');
    const u = update.createUpdater({ root: app, env: ENV, stateFile });
    assert.equal((await u.status()).lastCheck, null, 'no file: never checked');
    for (const bad of ['{', '[]', '"x"', JSON.stringify({ when: 'soon', result: 'updated' }), JSON.stringify({ result: 'updated' })]) { fs.writeFileSync(stateFile, bad); assert.equal((await u.status()).lastCheck, null, bad); }
    fs.writeFileSync(stateFile, JSON.stringify({ when: '2026-01-02T03:04:05.000Z', result: '<b>EVIL</b>', reason: '../../x', updated: { to: 'evil' }, restartNeeded: true }));
    const s = await u.status();
    assert.deepEqual(s.lastCheck, { when: '2026-01-02T03:04:05.000Z', result: 'failed', reason: null });
    assert.equal(s.updated, null); assert.equal(s.restartNeeded, false);
  });

  await test('the settings inside .git: what makes git run a program or go elsewhere is named; what a clone or an editor writes is not', () => {
    const P = update.configProblem;
    assert.equal(P(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.autocrlf', 'core.fsmonitor', 'core.hookspath', 'core.sshcommand',
      'remote.origin.url', 'remote.origin.fetch', 'remote.origin.tagopt', 'remote.origin.pushurl', 'remote.origin.gh-resolved', 'remote.origin.uploadpack', 'remote.fork.url', 'remote.fork.fetch', 'remote.my-fork_2.url', 'remote.pushdefault',
      'branch.main.remote', 'branch.main.merge', 'branch.main.mergeoptions', 'branch.main.vscode-merge-base', 'branch.feature/x.remote', 'user.name', 'user.email', 'credential.helper', 'gui.wmstate', 'url.x.insteadof', 'merge.autostash', '']), null);
    for (const [key, what] of [['filter.x.clean', 'filter'], ['filter.lfs.process', 'filter'], ['FILTER.x.smudge', 'filter'], ['include.path', 'include'], ['includeif.gitdir:/x/.path', 'includeif'],
      ['http.sslverify', 'http'], ['http.https://github.com/.sslverify', 'http'], ['http.https://github.com/.proxy', 'http'], ['http.extraheader', 'http'], ['http.sslcainfo', 'http'],
      ['core.alternaterefscommand', 'core.alternaterefscommand'], ['core.attributesfile', 'core.attributesfile'], ['extensions.partialclone', 'extensions.partialclone'], ['extensions.worktreeconfig', 'extensions.worktreeconfig'],
      ['remote.origin.promisor', 'remote'], ['remote.origin.partialclonefilter', 'remote'], ['remote.https://github.com/purple-ginseng/ResearchTool.git.fetch', 'remote'],
      ['remote.https://github.com/purple-ginseng/ResearchTool.git.uploadpack', 'remote'], ['remote.file:///tmp/x.git.proxy', 'remote'], ['remote.a b.url', 'remote'], ['remote.git@github.com:x/y.url', 'remote']]) {
      assert.equal(P(['core.bare', key, 'user.name']), what, key);
    }
    assert.ok(!/token|github/.test(P(['http.https://user:token@github.com/.extraheader'])), 'only the kind is said, never the key (it may hold an address with a token)');
    // the two files that do the same without a key
    const gd = path.join(TOP, 'gitdir-only'); fs.mkdirSync(path.join(gd, 'info'), { recursive: true }); fs.mkdirSync(path.join(gd, 'objects', 'info'), { recursive: true });
    assert.equal(update.gitDirProblem(gd), null);
    fs.writeFileSync(path.join(gd, 'info', 'attributes'), '# only a comment\n\n   \n# another\r\n');
    assert.equal(update.gitDirProblem(gd), null, 'what git init may leave there');
    fs.writeFileSync(path.join(gd, 'info', 'attributes'), '# x\n* filter=x\n');
    assert.equal(update.gitDirProblem(gd), 'info/attributes');
    fs.rmSync(path.join(gd, 'info', 'attributes')); fs.mkdirSync(path.join(gd, 'info', 'attributes'));
    assert.equal(update.gitDirProblem(gd), 'info/attributes', 'something that cannot be read is not passed over');
    fs.rmSync(path.join(gd, 'info', 'attributes'), { recursive: true });
    fs.writeFileSync(path.join(gd, 'objects', 'info', 'alternates'), '');
    assert.equal(update.gitDirProblem(gd), 'objects/info/alternates', 'even an empty one');
  });

  // ---------- the page: public/js/update.js in a vm, with a stand-in for RT and the two elements it paints ----------
  // answers: what GET /api/update/status and POST /api/update/check give, one after the other
  function page(answers) {
    const els = {}, banners = new Map(), timers = [], asked = [];
    const el = (id) => (els[id] = els[id] || { id, className: '', innerHTML: '', textContent: '', hidden: false, disabled: false, on: {}, addEventListener(t, fn) { this.on[t] = fn; } });
    const RT = { $: el, esc: (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), state: {}, on() {},
      api: async (url) => { asked.push(url); const a = answers.shift(); if (!a || a instanceof Error) throw a || new Error('no answer'); return a; },
      banner: { show: (o) => { banners.set(o.id, o); }, hide: (id) => { banners.delete(id); } } };
    const p = { RT, els, banners, timers, asked, reloaded: 0 };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'update.js'), 'utf8'), { RT, console, Date,
      document: { hidden: false, addEventListener() {} }, location: { reload() { p.reloaded++; } },
      setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: (id) => { if (timers[id - 1]) timers[id - 1] = null; }, setTimeout: () => 0 });
    p.fast = () => timers.filter((t) => t && t.ms < 60000).length;
    return p;
  }
  const ST = (o = {}) => ({ auto: false, disabled: false, supported: null, reason: null, version: '1.0.0', commit: 'aaaaaaa', running: { version: '1.0.0', commit: 'aaaaaaa' }, restartNeeded: false, checking: false,
    ahead: null, behind: null, available: null, lastCheck: null, updated: null, ...o });
  const text = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  await test('the page: the restart notice goes once the server runs the new version, and a page loaded from the older files is told to reload', async () => {
    const after = ST({ version: '1.1.0', commit: 'bbbbbbb', restartNeeded: true, updated: { from: 'aaaaaaa', to: 'bbbbbbb', version: '1.1.0', restartNeeded: true } });
    const p = page([ST(), after, new Error('the server is down'), ST({ version: '1.1.0', commit: 'bbbbbbb', running: { version: '1.1.0', commit: 'bbbbbbb' } })]);
    await p.RT.update.status(); // the page loads: nothing to say
    assert.equal(p.banners.size, 0); assert.equal(p.fast(), 0);
    await p.RT.update.status(); // the update was installed in the background
    const b = p.banners.get('update-restart');
    assert.ok(b && b.dismissible === false); assert.match(b.text, /^ResearchTool was updated to v1\.1\.0 \(bbbbbbb\)\. Restart it to finish/);
    assert.equal(p.fast(), 1, 'while a restart is awaited the status is looked at often, not once an hour');
    assert.equal(p.asked.every((u) => u === '/api/update/status'), true, 'the plain status: nothing of git, nothing of the network');
    await assert.rejects(p.RT.update.status()); // Ctrl+C: the notice stays
    assert.ok(p.banners.has('update-restart'));
    await p.RT.update.status(); // node server.js again
    assert.ok(!p.banners.has('update-restart'), 'the notice is still there after the restart');
    const r = p.banners.get('update-reload');
    assert.ok(r, 'a page loaded before the update is not told to reload'); assert.match(r.text, /Reload this page/); assert.equal(r.dismissible, false);
    r.action.onClick(); assert.equal(p.reloaded, 1);
    assert.equal(p.fast(), 0, 'the frequent look stops');
    // a page that was loaded after the update (from the new files) and before the restart has nothing to reload
    const q = page([after, ST({ version: '1.1.0', commit: 'bbbbbbb', running: { version: '1.1.0', commit: 'bbbbbbb' } })]);
    await q.RT.update.status(); assert.ok(q.banners.has('update-restart'));
    await q.RT.update.status(); assert.equal(q.banners.size, 0);
    // put back by hand without a restart (git reset to what runs): the notice goes, nothing to reload
    const u = page([ST(), ST({ version: '1.1.0', commit: 'bbbbbbb', restartNeeded: true }), ST()]);
    await u.RT.update.status(); await u.RT.update.status(); assert.match(u.banners.get('update-restart').text, /was updated to v1\.1\.0 \(bbbbbbb\)/, 'a git pull by hand');
    await u.RT.update.status(); assert.equal(u.banners.size, 0);
  });

  await test('the page: a fast-forward that stopped half way is never called "updated" - the notice and the line say how to repair it', async () => {
    // package.json is already the new one, HEAD is not: a newer version number alone is not an update
    const half = ST({ version: '1.1.0', restartNeeded: true, supported: false, reason: 'interrupted', lastCheck: { when: '2026-11-24T08:00:00.000Z', result: 'failed', reason: 'interrupted' } });
    const p = page([half, half]);
    await p.RT.update.status();
    const b = p.banners.get('update-restart');
    assert.ok(b); assert.equal(b.tone, 'warn'); assert.match(b.text, /^The update was interrupted/); assert.doesNotMatch(b.text, /was updated|Restart it to finish/);
    assert.equal(b.text, p.RT.update.sentence({ reason: 'interrupted' }));
    await p.RT.update.show();
    const line = text(p.els['#update-state'].innerHTML);
    assert.equal(line.split('may be half updated').length, 2, 'said once: ' + line); assert.doesNotMatch(line, /was updated|Restart it to finish|Program files/);
    assert.equal(p.asked[1], '/api/update/status?local=1');
    // the version differs and nothing says why (no check of this run): the neutral sentence, with no commit that was never installed
    const q = page([ST({ version: '1.1.0', restartNeeded: true })]);
    await q.RT.update.status();
    assert.match(q.banners.get('update-restart').text, /^The ResearchTool files on this computer are newer than the program that is running/);
    // the sentence for the settings inside .git names the kind
    assert.match(p.RT.update.sentence({ reason: 'config', detail: { what: 'filter' } }), /does not have \(filter\)/);
    assert.match(p.RT.update.sentence({ reason: 'config' }), /a plain clone does not have, so/);
  });

  await test('the page: after a restart the line says what the last check found; a reason about the folder that a fresh look no longer finds is not repeated', async () => {
    const at = '2026-11-24T08:00:00.000Z', shown = async (o) => { const p = page([ST(o)]); await p.RT.update.show(); return { line: text(p.els['#update-state'].innerHTML), cls: p.els['#update-state'].innerHTML, apply: p.els['#update-apply'].hidden }; };
    let r = await shown({ supported: true, lastCheck: { when: at, result: 'available', reason: null } });
    assert.match(r.line, /A newer version was found at the last check\. Press “Check for updates now” to see it\./); assert.equal(r.apply, true, '"Update now" needs a check of this run: the commit is not known any more');
    r = await shown({ supported: true, lastCheck: { when: at, result: 'failed', reason: 'offline' } });
    assert.match(r.line, /GitHub could not be reached/); assert.doesNotMatch(r.cls, /set-bad/, 'muted: it is about then, not about now');
    r = await shown({ supported: true, lastCheck: { when: at, result: 'failed', reason: 'blocked' } });
    assert.match(r.line, /The last check could not install the newest version/, 'a reason whose details were not kept');
    r = await shown({ supported: true, lastCheck: { when: at, result: 'updated', reason: null } });
    assert.match(r.line, /ResearchTool is up to date\./);
    r = await shown({ supported: true, lastCheck: { when: at, result: 'up-to-date', reason: null } });
    assert.match(r.line, /ResearchTool is up to date\./);
    for (const reason of ['dirty', 'branch', 'locked', 'tracking', 'redirect', 'origin', 'config', 'interrupted', 'in-progress', 'detached']) {
      r = await shown({ supported: true, reason: null, auto: true, lastCheck: { when: at, result: 'failed', reason } });
      assert.match(r.line, /^Version 1\.0\.0 \(aaaaaaa\) · Last check: \S+ \S+$/, reason + ': ' + r.line);
    }
    // what is true now is said as before: the look's own reason (red with the box ticked), an update of this run
    r = await shown({ supported: false, reason: 'dirty', auto: true, lastCheck: { when: at, result: 'failed', reason: 'dirty' } });
    assert.match(r.line, /Program files of ResearchTool were changed/); assert.match(r.cls, /set-bad/);
    r = await shown({ supported: true, available: { commit: 'bbbbbbb', version: '1.1.0' }, lastCheck: { when: at, result: 'available', reason: null } });
    assert.match(r.line, /A newer version is available: v1\.1\.0 \(bbbbbbb\)\./); assert.equal(r.apply, false);
  });

  if (!HAS_GIT) {
    console.log('     (git is not installed here: the tests that build repositories were skipped)');
    fs.rmSync(TOP, { recursive: true, force: true, maxRetries: 3 });
    console.log(`\n${passed} passed, ${failed} failed (without git)`);
    process.exit(failed ? 1 : 0);
  }

  // ================================================================= with repositories in the temporary folder
  await test('up to date: one fetch, nothing changes, nothing to restart', async () => {
    const fx = fixture(), u = fx.updater(), h = head(fx.app), before = hashes(fx.app);
    let s = await u.status();
    assert.equal(s.supported, null, 'not looked at yet'); assert.equal(s.lastCheck, null); assert.equal(s.commit, h.slice(0, 7)); assert.equal(s.running.commit, h.slice(0, 7)); assert.equal(s.version, '1.0.0');
    assert.deepEqual(fx.calls, [], 'the plain status starts no git at all');
    s = await u.status({ local: true });
    assert.equal(s.supported, true); assert.equal(s.reason, null);
    assert.equal(fx.fetched(), 0, 'looking at the local conditions is not a network request');
    assert.ok(!fs.existsSync(path.join(fx.app, '.git', 'FETCH_HEAD')));
    s = await u.check();
    assert.equal(s.result, 'up-to-date'); assert.equal(s.supported, true); assert.equal(s.reason, null); assert.equal(s.behind, 0); assert.equal(s.ahead, 0); assert.equal(s.available, null);
    assert.equal(s.restartNeeded, false); assert.equal(s.updated, null); assert.equal(s.lastCheck.result, 'up-to-date'); assert.ok(Date.parse(s.lastCheck.when) > 0);
    assert.equal(fx.fetched(), 1);
    s = await u.check({ apply: true });
    assert.equal(s.result, 'up-to-date');
    assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before);
    // every git call: fixed arguments, the address is the one given to the updater, never the remote's name
    const f = fx.calls.find((a) => a[0] === 'fetch');
    assert.deepEqual(f, ['fetch', '--no-tags', '--no-recurse-submodules', '--refmap=', '--quiet', fx.bare, '+refs/heads/main:refs/remotes/origin/main']);
    const verbs = new Set(fx.calls.map((a) => a[0]));
    for (const never of ['pull', 'reset', 'stash', 'clean', 'checkout', 'switch', 'rebase', 'submodule', 'commit', 'push', 'gc']) assert.ok(!verbs.has(never), never);
  });

  await test('behind: the check says so and changes nothing; "apply" fast-forwards to exactly origin\'s commit and asks for a restart', async () => {
    const fx = fixture(), u = fx.updater(), h = head(fx.app), before = hashes(fx.app);
    const next = fx.push({ 'package.json': PKG('1.1.0'), 'lib/a.js': 'module.exports = 2;\n', 'lib/new.js': 'new\n', 'public/js/x.js': null });
    let s = await u.check();
    assert.equal(s.result, 'available'); assert.equal(s.behind, 1); assert.equal(s.ahead, 0); assert.deepEqual(s.available, { commit: next.slice(0, 7), version: '1.1.0' });
    assert.equal(s.restartNeeded, false); assert.equal(s.updated, null); assert.equal(s.lastCheck.result, 'available');
    assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before, 'a check alone writes no file of the app');
    assert.equal((await u.status()).available.version, '1.1.0', 'the status remembers it');
    s = await u.check({ apply: true });
    assert.equal(s.result, 'updated');
    assert.deepEqual(s.updated, { from: h.slice(0, 7), to: next.slice(0, 7), version: '1.1.0', restartNeeded: true });
    assert.equal(s.restartNeeded, true); assert.equal(s.version, '1.1.0'); assert.equal(s.commit, next.slice(0, 7));
    assert.deepEqual(s.running, { version: '1.0.0', commit: h.slice(0, 7) }, 'what this process loaded');
    assert.equal(s.available, null); assert.equal(s.behind, 0);
    assert.equal(head(fx.app), next); assert.equal(head(fx.app), head(fx.bare, 'refs/heads/main'));
    assert.equal(read(fx.app, 'lib/a.js'), 'module.exports = 2;\n'); assert.equal(read(fx.app, 'lib/new.js'), 'new\n'); assert.ok(!fs.existsSync(path.join(fx.app, 'public', 'js', 'x.js')));
    assert.equal(G(fx.app, 'status', '--porcelain').trim(), ''); assert.equal(G(fx.app, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    assert.equal(G(fx.app, 'rev-list', '--merges', '--count', 'HEAD').trim(), '0', 'never a merge commit');
    const m = fx.calls.find((a) => a[0] === 'merge');
    assert.deepEqual(m, ['merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', '--quiet', next]);
    // it stays "restart needed" for this process; a server started now has nothing to restart for
    assert.equal((await u.status()).restartNeeded, true);
    s = await u.check({ apply: true });
    assert.equal(s.result, 'up-to-date'); assert.equal(s.restartNeeded, true); assert.ok(s.updated);
    const fresh = await fx.updater().status();
    assert.equal(fresh.restartNeeded, false); assert.equal(fresh.updated, null); assert.equal(fresh.running.version, '1.1.0');
  });

  for (const ignore of [false, true]) {
    await test(`untracked${ignore ? ' and ignored' : ''} files and a workspace with data: still updates, and they are byte for byte what they were`, async () => {
      const fx = fixture({ ignore }), u = fx.updater({ userDirs: () => [path.join(fx.app, 'workspace'), path.join(fx.app, 'backups')] });
      write(fx.app, 'workspace/library.json', JSON.stringify({ items: [{ id: 'a', title: 'Mine' }] }));
      write(fx.app, 'workspace/settings.json', '{"autoUpdate":true}');
      write(fx.app, 'workspace/pdfs/a.pdf', crypto.randomBytes(5000));
      write(fx.app, 'workspace/notes/a.md', '# note\r\nwith CRLF\r\n');
      write(fx.app, 'backups/snapshot-2026-01-01_000000/library.json', '{"items":[]}');
      write(fx.app, 'my notes.txt', 'untracked\n');
      write(fx.app, 'lib/local-only.js', '// untracked beside tracked files\n');
      if (ignore) write(fx.app, 'debug.log', 'ignored\n');
      const mine = (rel) => rel === '.git' || !(rel === 'workspace' || rel === 'backups' || rel.startsWith('workspace/') || rel.startsWith('backups/') || ['my notes.txt', 'lib', 'lib/local-only.js', 'debug.log'].includes(rel));
      const before = hashes(fx.app, mine);
      assert.ok(Object.keys(before).length >= (ignore ? 8 : 7), Object.keys(before).join());
      const next = fx.push({ 'package.json': PKG('2.0.0'), 'lib/a.js': 'module.exports = 3;\n', 'docs/new.md': 'doc\n' });
      const s = await u.check({ apply: true });
      assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(fx.app), next); assert.equal(s.restartNeeded, true);
      assert.deepEqual(hashes(fx.app, mine), before);
      assert.equal(read(fx.app, 'docs/new.md'), 'doc\n');
      assert.equal(G(fx.app, 'stash', 'list').trim(), '');
    });
  }

  await test('a shallow clone (git clone --depth 1) updates like any other', async () => {
    const fx = fixture({ shallow: true }), u = fx.updater({ allowOrigin: (url) => url === pathToFileURL(fx.bare).href });
    const next = fx.push({ 'package.json': PKG('1.0.1') });
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(fx.app), next);
  });

  // ---------- reasons to do nothing: all found before any request ----------
  const refuses = async (name, prepare, reason, opts) => test(name, async () => {
    const fx = fixture();
    const o = (await prepare(fx)) || {};
    fx.push({ 'package.json': PKG('1.1.0') }); // there IS something newer
    const h = head(fx.app), before = hashes(fx.app), u = fx.updater({ ...(opts ? opts(fx) : {}), ...(o.opts || {}) });
    let s = await u.status({ local: true });
    assert.equal(s.supported, false); assert.equal(s.reason, reason);
    s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, reason); assert.equal(s.supported, false); assert.equal(s.updated, null); assert.equal(s.restartNeeded, false);
    assert.equal(s.lastCheck.result, 'failed'); assert.equal(s.lastCheck.reason, reason);
    assert.equal(fx.fetched(), 0, 'no request to origin'); assert.ok(!fx.calls.some((a) => a[0] === 'merge'));
    assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before);
    assert.ok(!JSON.stringify(s).includes(TOP) && !JSON.stringify(s).includes(plat.toSlash(TOP)), 'no path in the answer');
    if (o.after) await o.after(fx, s);
  });
  await refuses('origin is not the official repository (the real matcher, a local path as origin): "origin"', () => {}, 'origin', () => ({ allowOrigin: update.isOfficial }));
  await refuses('a fork on GitHub is never updated: "origin"', (fx) => { G(fx.app, 'remote', 'set-url', 'origin', 'https://github.com/someone-else/ResearchTool.git'); }, 'origin', () => ({ allowOrigin: update.isOfficial }));
  await refuses('a fork whose address holds a token: "origin", and the address is not in the answer', (fx) => {
    G(fx.app, 'remote', 'set-url', 'origin', 'https://user:ghp_SECRETTOKEN123@github.com/someone-else/ResearchTool.git');
    return { after: (_fx, s) => assert.ok(!/SECRETTOKEN|someone-else/.test(JSON.stringify(s))) };
  }, 'origin', () => ({ allowOrigin: update.isOfficial }));
  await refuses('no origin at all: "origin"', (fx) => { G(fx.app, 'remote', 'remove', 'origin'); }, 'origin');
  await refuses('another branch is checked out: "branch"', (fx) => { G(fx.app, 'checkout', '-q', '-b', 'feature'); }, 'branch');
  await refuses('a branch named like the remote-tracking one does not pass for main: "branch"', (fx) => { G(fx.app, 'checkout', '-q', '-b', 'origin/main'); }, 'branch');
  await refuses('a detached HEAD: "detached"', (fx) => { G(fx.app, 'checkout', '-q', '--detach'); }, 'detached');
  await refuses('main does not follow origin/main: "tracking"', (fx) => { G(fx.app, 'branch', '--unset-upstream'); }, 'tracking');
  await refuses('a tracked file was changed: "dirty"', (fx) => { write(fx.app, 'lib/a.js', 'module.exports = "mine";\n'); }, 'dirty');
  await refuses('a tracked file was deleted: "dirty"', (fx) => { fs.rmSync(path.join(fx.app, 'server.js')); }, 'dirty');
  await refuses('a change is staged: "dirty"', (fx) => { write(fx.app, 'lib/staged.js', 'x\n'); G(fx.app, 'add', 'lib/staged.js'); }, 'dirty');
  await refuses('a merge is in progress: "in-progress"', (fx) => { fs.writeFileSync(path.join(fx.app, '.git', 'MERGE_HEAD'), head(fx.app) + '\n'); }, 'in-progress');
  await refuses('a rebase is in progress: "in-progress"', (fx) => { fs.mkdirSync(path.join(fx.app, '.git', 'rebase-merge')); }, 'in-progress');
  await refuses('.git/index.lock is there (another git is running, or one crashed): "locked"', (fx) => { fs.writeFileSync(path.join(fx.app, '.git', 'index.lock'), ''); }, 'locked');
  await refuses('the git settings redirect the address (url.*.insteadOf): "redirect"', (fx) => { G(fx.app, 'config', `url.${plat.toSlash(path.join(fx.dir, 'elsewhere.git'))}.insteadOf`, fx.bare); }, 'redirect');
  await refuses('the same redirect in the user\'s global settings: "redirect"', (fx) => {
    const home = path.join(fx.dir, 'home'); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[url "${plat.toSlash(path.join(fx.dir, 'elsewhere.git'))}"]\n\tinsteadOf = ${plat.toSlash(fx.bare)}\n`);
    // (the address is given with forward slashes here, as the settings file has it)
    return { opts: { env: { ...ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') }, fetchUrl: plat.toSlash(fx.bare) } };
  }, 'redirect');
  await refuses('git is not installed: "no-git"', (fx) => {
    const empty = path.join(fx.dir, 'empty-bin'); fs.mkdirSync(empty);
    const env = { ...ENV }; for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
    return { opts: { env: { ...env, PATH: empty } } };
  }, 'no-git');
  if (!IS_WIN) { // a stand-in named git (a sh script): what macOS has at /usr/bin/git until the developer tools are set up
    const fakeGit = (fx, text, code) => {
      const bin = path.join(fx.dir, 'fake-bin'); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "${text}" >&2\nexit ${code}\n`); fs.chmodSync(path.join(bin, 'git'), 0o755);
      const env = { ...ENV }; for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
      return { opts: { env: { ...env, PATH: bin + path.delimiter + '/usr/bin' + path.delimiter + '/bin' } } };
    };
    await refuses('a git that only says how to install or license it (macOS): "no-git", not "this is no repository"',
      (fx) => fakeGit(fx, "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window.", 69), 'no-git');
    await refuses('a git that fails in a way nobody planned for: "git-failed"', (fx) => fakeGit(fx, 'fatal: something unheard of', 3), 'git-failed');
    await refuses('a folder that belongs to another account (git says "dubious ownership"): "unsafe"',
      (fx) => fakeGit(fx, "fatal: detected dubious ownership in repository at '/somewhere'\nTo add an exception for this directory, call:\n\tgit config --global --add safe.directory /somewhere", 128), 'unsafe');
  }
  await refuses('a linked work tree (.git is a file, not a folder): "unusual", and git is not started', (fx) => {
    const wt = path.join(fx.dir, 'linked');
    G(fx.app, 'worktree', 'add', '-q', '-b', 'side', wt);
    assert.ok(fs.lstatSync(path.join(wt, '.git')).isFile());
    return { opts: { root: wt }, after: () => assert.deepEqual(fx.calls, []) };
  }, 'unusual');

  await test('unpacked inside another repository, without a .git of its own: "not-git", and the outer repository is never touched', async () => {
    const fx = fixture(), inner = path.join(fx.app, 'vendor', 'ResearchTool');
    write(inner, 'package.json', PKG('1.0.0')); write(inner, 'server.js', 'x\n');
    fx.push({ 'package.json': PKG('1.1.0') });
    const h = head(fx.app), calls = [];
    const u = update.createUpdater({ root: inner, allowOrigin: () => true, fetchUrl: fx.bare, protocols: ['file'], env: ENV, settings: () => ({ autoUpdate: true }), minInterval: 0, onGit: (a) => calls.push(a) });
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, 'not-git'); assert.deepEqual(calls, []);
    await u.tick();
    // with an empty .git folder of its own git would look further up: stopped at the app folder, or seen as "not the top"
    fs.mkdirSync(path.join(inner, '.git'));
    const s2 = await u.check({ apply: true });
    assert.equal(s2.result, 'failed'); assert.ok(['not-git', 'unusual'].includes(s2.reason), s2.reason);
    assert.ok(!calls.some((a) => a[0] === 'fetch' || a[0] === 'merge'));
    assert.equal(head(fx.app), h); assert.ok(!fs.existsSync(path.join(fx.app, '.git', 'FETCH_HEAD')));
  });

  await test('GIT_DIR / GIT_WORK_TREE of the shell the server was started from are ignored: the app folder is updated, the other repository is not', async () => {
    const fx = fixture(), other = fixture();
    const next = fx.push({ 'package.json': PKG('1.1.0') }); other.push({ 'package.json': PKG('9.9.9') });
    const oh = head(other.app);
    const u = fx.updater({ env: { ...ENV, GIT_DIR: path.join(other.app, '.git'), GIT_WORK_TREE: other.app, GIT_INDEX_FILE: path.join(other.app, '.git', 'index') } });
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(fx.app), next); assert.equal(s.version, '1.1.0');
    assert.equal(head(other.app), oh); assert.equal(G(other.app, 'status', '--porcelain').trim(), '');
  });

  await test('only https leaves this computer: GIT_ALLOW_PROTOCOL=file in the environment does not let the real settings fetch a local path', async () => {
    const fx = fixture(); fx.push({ 'package.json': PKG('1.1.0') });
    const h = head(fx.app);
    const u = fx.updater({ protocols: ['https'], env: { ...ENV, GIT_ALLOW_PROTOCOL: 'file' } });
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, 'fetch-failed'); assert.equal(s.supported, true);
    assert.equal(head(fx.app), h); assert.equal(fx.fetched(), 1);
  });

  await test('the fetch goes to the address given to the updater, not to whatever "origin" is set up to do (uploadpack, another fetch address)', async () => {
    const fx = fixture(), marker = path.join(fx.dir, 'uploadpack-ran');
    const next = fx.push({ 'package.json': PKG('1.1.0') });
    // the clone says it comes from the official address; its remote would run a program and fetch other refs
    G(fx.app, 'remote', 'set-url', 'origin', 'https://github.com/purple-ginseng/ResearchTool.git');
    const script = path.join(fx.dir, 'evil-upload-pack'); fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${plat.toSlash(marker)}"\nexit 1\n`); fs.chmodSync(script, 0o755);
    G(fx.app, 'config', 'remote.origin.uploadpack', plat.toSlash(script));
    G(fx.app, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
    G(fx.app, 'config', 'remote.origin.tagOpt', '--tags');
    const u = fx.updater({ allowOrigin: update.isOfficial });
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(fx.app), next);
    assert.ok(!fs.existsSync(marker), 'remote.origin.uploadpack was run');
  });

  await test('an origin that cannot be reached: a readable reason, and nothing changed', async () => {
    const fx = fixture(), h = head(fx.app), before = hashes(fx.app);
    const gone = path.join(fx.dir, 'gone.git');
    const u = fx.updater({ allowOrigin: () => true, fetchUrl: gone, minInterval: 60000, now: () => 1e12 });
    let s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.ok(['offline', 'fetch-failed'].includes(s.reason), s.reason); assert.equal(s.supported, true, 'the copy itself is fine');
    assert.equal(s.updated, null); assert.equal(s.restartNeeded, false); assert.equal(s.lastCheck.result, 'failed');
    assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before);
    assert.ok(!JSON.stringify(s).includes('gone.git'), 'no git output in the answer');
    // a failed try counts for the rate limit too
    const again = await u.check({ apply: true });
    assert.equal(again.throttled, true); assert.equal(again.reason, s.reason); assert.equal(fx.fetched(), 1);
  });

  await test('ahead of origin (own commits): "ahead", nothing changes', async () => {
    const fx = fixture(), u = fx.updater();
    write(fx.app, 'lib/mine.js', 'mine\n'); G(fx.app, 'add', '-A'); G(fx.app, 'commit', '-q', '-m', 'mine');
    const h = head(fx.app);
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, 'ahead'); assert.equal(s.ahead, 1); assert.equal(s.behind, 0); assert.equal(s.supported, true);
    assert.equal(head(fx.app), h); assert.ok(!fx.calls.some((a) => a[0] === 'merge'));
  });

  await test('diverged (own commits and new ones on origin, or origin was rewritten): "diverged", nothing changes - never a merge or a reset', async () => {
    const fx = fixture(), u = fx.updater();
    write(fx.app, 'lib/mine.js', 'mine\n'); G(fx.app, 'add', '-A'); G(fx.app, 'commit', '-q', '-m', 'mine');
    fx.push({ 'package.json': PKG('1.1.0') });
    const h = head(fx.app), before = hashes(fx.app);
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, 'diverged'); assert.equal(s.ahead, 1); assert.equal(s.behind, 1);
    assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before); assert.ok(!fx.calls.some((a) => a[0] === 'merge'));
    // origin rewritten (a force-push to an older or unrelated history): the same answer, never a step back
    const fx2 = fixture(), u2 = fx2.updater();
    fx2.push({ 'package.json': PKG('1.1.0') });
    assert.equal((await u2.check({ apply: true })).result, 'updated');
    const h2 = head(fx2.app);
    G(fx2.seed, 'reset', '-q', '--hard', 'HEAD~1'); write(fx2.seed, 'lib/other.js', 'other\n'); G(fx2.seed, 'add', '-A'); G(fx2.seed, 'commit', '-q', '-m', 'rewritten'); G(fx2.seed, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/main');
    const s2 = await u2.check({ apply: true });
    assert.equal(s2.reason, 'diverged'); assert.equal(head(fx2.app), h2);
    G(fx2.seed, 'reset', '-q', '--hard', 'HEAD~1'); G(fx2.seed, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/main'); // origin is now BEHIND this copy
    const s3 = await u2.check({ apply: true });
    assert.equal(s3.reason, 'ahead'); assert.equal(head(fx2.app), h2, 'never downgraded');
  });

  // ---------- what must never run ----------
  await test('hooks in .git/hooks, core.fsmonitor and a hooksPath in the repository settings are not run by a check or an update', async () => {
    const fx = fixture(), marker = path.join(fx.dir, 'hook-ran');
    for (const h of ['reference-transaction', 'post-merge', 'post-checkout', 'pre-merge-commit', 'post-rewrite', 'pre-auto-gc', 'post-index-change']) plantHook(fx.app, h, marker);
    const alt = path.join(fx.dir, 'alt-hooks'); fs.mkdirSync(alt);
    for (const h of ['reference-transaction', 'post-merge']) { fs.copyFileSync(path.join(fx.app, '.git', 'hooks', h), path.join(alt, h)); fs.chmodSync(path.join(alt, h), 0o755); }
    const mon = path.join(fx.dir, 'fsmonitor'); fs.writeFileSync(mon, `#!/bin/sh\necho ran >> "${plat.toSlash(marker)}"\nexit 1\n`); fs.chmodSync(mon, 0o755);
    if (!IS_WIN) { // the control: these hooks do run for an ordinary git command (so their absence below means something)
      G(fx.app, 'update-ref', 'refs/heads/control', 'HEAD');
      assert.ok(fs.existsSync(marker), 'the planted hook does not work');
      fs.rmSync(marker); G(fx.app, 'update-ref', '-d', 'refs/heads/control'); fs.rmSync(marker, { force: true });
    }
    G(fx.app, 'config', 'core.fsmonitor', plat.toSlash(mon));
    G(fx.app, 'config', 'core.hooksPath', plat.toSlash(alt));
    fs.rmSync(marker, { force: true });
    const next = fx.push({ 'package.json': PKG('1.1.0'), 'lib/a.js': 'two\n' });
    const u = fx.updater();
    assert.equal((await u.status({ local: true })).supported, true);
    assert.equal((await u.check()).result, 'available');
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(fx.app), next);
    assert.ok(!fs.existsSync(marker), 'a hook or the fsmonitor program was run: ' + (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''));
  });

  await test('merge.autoStash=true and a file edited after the last look: no stash, no conflict markers, the edit stays, nothing is updated', async () => {
    const fx = fixture();
    fs.writeFileSync(path.join(HOME, '.gitconfig'), '[merge]\n\tautoStash = true\n[rebase]\n\tautoStash = true\n[pull]\n\trebase = true\n');
    try {
      G(fx.app, 'config', 'merge.autoStash', 'true');
      fx.push({ 'package.json': PKG('1.1.0'), 'lib/a.js': 'module.exports = "theirs";\n' });
      const h = head(fx.app);
      const u = fx.updater({ onGit: (a) => { fx.calls.push(a); if (a[0] === 'merge') write(fx.app, 'lib/a.js', 'module.exports = "mine, typed this second";\n'); } });
      const s = await u.check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, 'dirty', JSON.stringify(s)); assert.equal(s.updated, null);
      assert.equal(read(fx.app, 'lib/a.js'), 'module.exports = "mine, typed this second";\n');
      assert.equal(head(fx.app), h); assert.equal(G(fx.app, 'stash', 'list').trim(), '');
      assert.equal(read(fx.app, 'package.json'), PKG('1.0.0'), 'nothing was half updated');
      // an edit to a file the update does not touch is simply kept
      const fx2 = fixture(); G(fx2.app, 'config', 'merge.autoStash', 'true');
      const next = fx2.push({ 'package.json': PKG('1.1.0') });
      const u2 = fx2.updater({ onGit: (a) => { if (a[0] === 'merge') write(fx2.app, 'lib/a.js', 'mine\n'); } });
      const s2 = await u2.check({ apply: true });
      assert.equal(s2.result, 'updated', JSON.stringify(s2)); assert.equal(head(fx2.app), next); assert.equal(read(fx2.app, 'lib/a.js'), 'mine\n'); assert.equal(G(fx2.app, 'stash', 'list').trim(), '');
    } finally { fs.rmSync(path.join(HOME, '.gitconfig'), { force: true }); }
  });

  await test('a change hidden from git status (assume-unchanged) is not overwritten', async () => {
    const fx = fixture();
    G(fx.app, 'update-index', '--assume-unchanged', 'lib/a.js'); write(fx.app, 'lib/a.js', 'hidden edit\n');
    fx.push({ 'lib/a.js': 'theirs\n' });
    const h = head(fx.app), s = await fx.updater().check({ apply: true });
    assert.equal(s.result, 'failed'); assert.ok(['dirty', 'refused'].includes(s.reason), s.reason);
    assert.equal(read(fx.app, 'lib/a.js'), 'hidden edit\n'); assert.equal(head(fx.app), h);
  });

  // ---------- what a new version must never bring ----------
  for (const [ignore, dir] of [[false, 'workspace'], [true, 'workspace'], [false, 'backups'], [true, 'backups']]) {
    await test(`a new version with a file in ${dir}/ (${ignore ? 'ignored' : 'not ignored'} here): refused before anything is written, the user's file is byte for byte the same`, async () => {
      const fx = fixture({ ignore }), rel = dir === 'workspace' ? 'workspace/library.json' : 'backups/snapshot-2026-01-01_000000/library.json';
      write(fx.app, rel, '{"items":[{"id":"mine"}]}'); write(fx.app, 'workspace/pdfs/a.pdf', crypto.randomBytes(3000));
      const mine = (r) => r === '.git' || !(r.startsWith('workspace') || r.startsWith('backups'));
      const before = hashes(fx.app, mine), h = head(fx.app);
      fx.push({ [rel]: '{"items":[]}', 'package.json': PKG('1.1.0') }, { force: true });
      const u = fx.updater();
      let s = await u.check();
      assert.equal(s.result, 'failed'); assert.equal(s.reason, 'blocked'); assert.deepEqual(s.detail, { what: 'user-data', path: rel }); assert.equal(s.available, null, '"Update now" is not offered');
      s = await u.check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, 'blocked'); assert.equal(s.updated, null);
      assert.ok(!fx.calls.some((a) => a[0] === 'merge'));
      assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app, mine), before);
    });
  }

  await test('a workspace elsewhere inside the app folder (RT_WORKSPACE) is protected the same way', async () => {
    const fx = fixture(), ws = path.join(fx.app, 'data', 'My Library');
    write(fx.app, 'data/My Library/library.json', 'mine');
    fx.push({ 'data/my library/library.json': 'theirs', 'package.json': PKG('1.1.0') });
    const s = await fx.updater({ userDirs: () => [ws, path.join(TOP, 'outside'), fx.app, path.dirname(fx.app)] }).check({ apply: true });
    assert.equal(s.reason, 'blocked'); assert.equal(s.detail.what, 'user-data'); assert.equal(read(fx.app, 'data/My Library/library.json'), 'mine');
  });

  await test('git itself is the second lock: a new tracked file where an ignored or untracked file of the user lies is not overwritten', async () => {
    for (const ignore of [true, false]) {
      const fx = fixture({ ignore }), name = ignore ? 'debug.log' : 'my notes.txt';
      write(fx.app, name, 'mine\n');
      fx.push({ [name]: 'theirs\n', 'package.json': PKG('1.1.0') }, { force: true });
      const h = head(fx.app), s = await fx.updater().check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, 'refused', JSON.stringify(s)); assert.deepEqual(s.detail, { files: [name] }); assert.equal(s.supported, true);
      assert.equal(read(fx.app, name), 'mine\n'); assert.equal(head(fx.app), h); assert.equal(read(fx.app, 'package.json'), PKG('1.0.0'));
      assert.equal(G(fx.app, 'status', '--porcelain', '--untracked-files=no').trim(), '');
      // moved away: the next try works
      fs.renameSync(path.join(fx.app, name), path.join(fx.dir, 'moved-away'));
      assert.equal((await fx.updater().check({ apply: true })).result, 'updated');
    }
  });

  for (const [what, make] of [
    ['symlink', (fx) => fx.pushEntry('120000', 'docs/link', '../server.js')],
    ['submodule', (fx) => fx.pushEntry('160000', 'vendor/sub')],
    ['submodule', (fx) => fx.push({ '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x.git\n' })],
    ['case', (fx) => fx.pushEntry('100644', 'LIB/A.js')],
    ['bad-name', (fx) => fx.pushEntry('100644', 'docs/aux.txt')],
    ['bad-name', (fx) => fx.pushEntry('100644', 'docs/what?.md')],
  ]) {
    await test(`a new version with a ${what === 'case' ? 'name that differs from another only in case' : what === 'bad-name' ? 'name Windows cannot write' : what}: "blocked", nothing is written`, async () => {
      const fx = fixture(); make(fx);
      const h = head(fx.app), before = hashes(fx.app), s = await fx.updater().check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, 'blocked', JSON.stringify(s)); assert.equal(s.detail.what, what);
      assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before); assert.ok(!fx.calls.some((a) => a[0] === 'merge'));
    });
  }

  await test('a new version that needs a newer Node, or a manual step (a higher update epoch), or has a broken package.json: not installed', async () => {
    for (const [pkg, reason, detail] of [
      [PKG('2.0.0', { engines: { node: '>=999' } }), 'needs-node', { version: '2.0.0', needs: '>=999' }],
      [PKG('2.0.0', { updateEpoch: update.EPOCH + 1 }), 'manual', { version: '2.0.0' }],
      [JSON.stringify({ version: '<img src=x onerror=alert(1)>' }), 'blocked', { what: 'package' }],
      ['not json', 'blocked', { what: 'package' }],
    ]) {
      const fx = fixture(); fx.push({ 'package.json': pkg, 'lib/a.js': 'new\n' });
      const h = head(fx.app), s = await fx.updater().check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, reason, JSON.stringify(s)); assert.deepEqual(s.detail, detail); assert.equal(s.available, null);
      assert.equal(head(fx.app), h); assert.equal(read(fx.app, 'lib/a.js'), 'module.exports = 1;\n');
    }
    // the Node that runs is what counts
    const fx = fixture(); fx.push({ 'package.json': PKG('2.0.0', { engines: { node: '>=20' } }) });
    assert.equal((await fx.updater({ nodeVersion: '18.20.0' }).check()).reason, 'needs-node');
    assert.equal((await fx.updater({ nodeVersion: '20.0.0' }).check()).result, 'available');
  });

  // ---------- one at a time, not too often ----------
  await test('two calls at once: one runs, the other is told "busy"; one fetch, one merge, HEAD is origin\'s', async () => {
    const fx = fixture(), u = fx.updater();
    const next = fx.push({ 'package.json': PKG('1.1.0') });
    const [a, b, c] = await Promise.all([u.check({ apply: true }), u.check({ apply: true }), u.check()]);
    assert.deepEqual([a.result, b.result, c.result], ['updated', 'busy', 'busy']);
    assert.equal(b.busy, true); assert.equal(b.checking, true);
    assert.equal(fx.fetched(), 1); assert.equal(fx.calls.filter((x) => x[0] === 'merge').length, 1); assert.equal(u.stats.fetches, 1); assert.equal(u.stats.merges, 1);
    assert.equal(head(fx.app), next);
    assert.equal((await u.status()).checking, false);
  });

  await test('at most one request a minute: a second check answers from the first, and "Update now" right after a check needs no second request', async () => {
    const fx = fixture(); let t = 1e12;
    const u = fx.updater({ minInterval: 60000, now: () => t });
    const next = fx.push({ 'package.json': PKG('1.1.0') });
    let s = await u.check();
    assert.equal(s.result, 'available'); assert.ok(!s.throttled); assert.equal(fx.fetched(), 1);
    t += 5000; s = await u.check();
    assert.equal(s.result, 'available'); assert.equal(s.throttled, true); assert.equal(fx.fetched(), 1);
    const later = fx.push({ 'package.json': PKG('1.2.0') }); // origin moves on within the minute: not seen yet
    t += 5000; s = await u.check({ apply: true });
    assert.equal(s.result, 'updated'); assert.equal(s.throttled, true); assert.equal(fx.fetched(), 1); assert.equal(head(fx.app), next, 'exactly the commit the check showed');
    t += 5000; s = await u.check({ apply: true });
    assert.equal(s.result, 'up-to-date'); assert.equal(s.throttled, true); assert.equal(fx.fetched(), 1);
    t += 60000; s = await u.check({ apply: true });
    assert.equal(s.result, 'updated'); assert.ok(!s.throttled); assert.equal(fx.fetched(), 2); assert.equal(head(fx.app), later);
  });

  // ---------- by itself ----------
  await test('the box is not ticked: the tick starts nothing - no fetch, not even a local git command', async () => {
    const fx = fixture(); fx.push({ 'package.json': PKG('1.1.0') });
    const h = head(fx.app);
    for (const st of [{}, { autoUpdate: false }, { autoUpdate: 'true' }, { autoUpdate: 1 }, { autoUpdate: null }]) {
      const u = fx.updater({ settings: () => st });
      assert.equal(await u.tick(), null); assert.equal(u.stats.spawns, 0, JSON.stringify(st));
      u.kick(); await new Promise((r) => setTimeout(r, 20)); assert.equal(u.stats.spawns, 0);
      assert.equal((await u.status()).auto, false);
    }
    assert.deepEqual(fx.calls, []); assert.equal(head(fx.app), h);
  });

  await test('the box is ticked: the tick updates by itself, then not again for 20 hours - also across a restart - and unticking stops it at once', async () => {
    const fx = fixture(), stateFile = path.join(fx.dir, 'update.json'); let t = Date.parse('2026-11-24T08:00:00Z'), auto = true;
    const mk = () => fx.updater({ settings: () => (auto ? { autoUpdate: true } : {}), now: () => t, stateFile, minInterval: 60000 });
    let u = mk();
    const v1 = fx.push({ 'package.json': PKG('1.1.0') });
    let s = await u.tick();
    assert.equal(s.result, 'updated'); assert.equal(s.auto, true); assert.equal(head(fx.app), v1); assert.equal(fx.fetched(), 1);
    assert.deepEqual(core.readJSON(stateFile, null), { when: '2026-11-24T08:00:00.000Z', result: 'updated', reason: null }, 'only the time and the outcome are kept');
    const v2 = fx.push({ 'package.json': PKG('1.2.0') });
    t += 3600000; assert.equal(await u.tick(), null); assert.equal(fx.fetched(), 1, 'an hour later: not yet');
    u = mk(); // the server was restarted (and again, and again): no new request because of that
    t += 3600000; assert.equal(await u.tick(), null); assert.equal(u.stats.spawns, 0);
    assert.deepEqual((await u.status()).lastCheck, { when: '2026-11-24T08:00:00.000Z', result: 'updated', reason: null });
    t += 19 * 3600000; s = await u.tick();
    assert.equal(s.result, 'updated'); assert.equal(head(fx.app), v2); assert.equal(fx.fetched(), 2);
    fx.push({ 'package.json': PKG('1.3.0') });
    auto = false; t += 30 * 3600000;
    assert.equal(await u.tick(), null); assert.equal(fx.fetched(), 2); assert.equal(head(fx.app), v2, 'unticked: nothing more');
    // a clock set back (or an edited file) does not stop the updates for good
    auto = true; fs.writeFileSync(stateFile, JSON.stringify({ when: '2999-01-01T00:00:00.000Z', result: 'up-to-date' }));
    u = mk(); s = await u.tick();
    assert.equal(s.result, 'updated'); assert.equal(fx.fetched(), 3);
  });

  await test('a check that failed (offline) is tried again the next hour, not every minute; an update a manual check found is installed at the next tick', async () => {
    const fx = fixture(); let t = 1e12, url = path.join(fx.dir, 'gone.git');
    const u = update.createUpdater({ root: fx.app, allowOrigin: () => true, get fetchUrl() { return url; }, protocols: ['file'], env: ENV, settings: () => ({ autoUpdate: true }), now: () => t, minInterval: 60000, onGit: (a) => fx.calls.push(a), log: () => {} });
    let s = await u.tick();
    assert.equal(s.result, 'failed'); assert.equal(fx.fetched(), 1);
    t += 10 * 60000; assert.equal(await u.tick(), null); assert.equal(fx.fetched(), 1);
    t += 45 * 60000; s = await u.tick(); assert.equal(s.result, 'failed'); assert.equal(fx.fetched(), 2);
    // an answer that waiting an hour cannot change (this copy has diverged) is asked for again a day later, not hourly
    const fx3 = fixture(), u3 = fx3.updater({ settings: () => ({ autoUpdate: true }), now: () => t, minInterval: 60000 });
    write(fx3.app, 'lib/mine.js', 'mine\n'); G(fx3.app, 'add', '-A'); G(fx3.app, 'commit', '-q', '-m', 'mine'); fx3.push({ 'package.json': PKG('1.1.0') });
    s = await u3.tick(); assert.equal(s.reason, 'diverged'); assert.equal(fx3.fetched(), 1);
    t += 2 * 3600000; assert.equal(await u3.tick(), null); assert.equal(fx3.fetched(), 1);
    t += 19 * 3600000; s = await u3.tick(); assert.equal(s.reason, 'diverged'); assert.equal(fx3.fetched(), 2);
    // found by hand, left for later
    const fx2 = fixture(); let auto = false;
    const u2 = fx2.updater({ settings: () => (auto ? { autoUpdate: true } : {}), now: () => t, minInterval: 60000 });
    const next = fx2.push({ 'package.json': PKG('1.1.0') });
    assert.equal((await u2.check()).result, 'available');
    auto = true; t += 1000; u2.kick(); // the box was ticked and saved a second later
    for (let i = 0; i < 200 && head(fx2.app) !== next; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(head(fx2.app), next); assert.equal(fx2.fetched(), 1, 'no second request within the minute');
  });

  await test('the kill switch (disabled): no check, no tick, no git process - also with the box ticked and an update waiting', async () => {
    const fx = fixture(); fx.push({ 'package.json': PKG('1.1.0') });
    const h = head(fx.app), u = fx.updater({ disabled: true, settings: () => ({ autoUpdate: true }) });
    assert.equal(await u.tick(), null); u.kick(); u.schedule();
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'failed'); assert.equal(s.reason, 'disabled'); assert.equal(s.disabled, true); assert.equal(s.supported, false);
    assert.equal((await u.status({ local: true })).reason, 'disabled');
    assert.equal(u.stats.spawns, 0); assert.deepEqual(fx.calls, []); assert.equal(head(fx.app), h);
  });

  // ---------- the settings inside .git: nothing they name is run, and such a clone is not updated ----------
  // a program (a sh line, run by git's own shell) that leaves a marker and passes its input on
  const marks = (marker) => `echo ran >> "${plat.toSlash(marker)}"; cat`;
  const homeWith = (fx, gitconfig) => {
    const home = path.join(fx.dir, 'home-' + (++seq)); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), gitconfig);
    return { ...ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  };
  const isConfig = (what, marker) => (_fx, s) => {
    assert.deepEqual(s.detail, { what });
    if (marker) assert.ok(!fs.existsSync(marker), 'a program named in .git was run: ' + (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''));
  };
  await refuses('a filter in .git/config (clean / smudge would run on every file git looks at): "config", and it is never run', (fx) => {
    const marker = path.join(fx.dir, 'filter-ran');
    G(fx.app, 'config', 'filter.x.clean', marks(marker)); G(fx.app, 'config', 'filter.x.smudge', marks(marker));
    write(fx.app, 'lib/.gitattributes', '* filter=x\n'); // untracked: the tree stays clean
    const old = new Date(Date.now() - 86400000); fs.utimesSync(path.join(fx.app, 'lib', 'a.js'), old, old); // git has to read the file again
    if (!IS_WIN) { // the control: an ordinary git status does run it
      G(fx.app, 'status', '--porcelain');
      assert.ok(fs.existsSync(marker), 'the planted filter does not work');
      fs.rmSync(marker); fs.utimesSync(path.join(fx.app, 'lib', 'a.js'), new Date(Date.now() - 2 * 86400000), old);
    }
    return { after: isConfig('filter', marker) };
  }, 'config');
  await refuses('.git/info/attributes switches a filter of the user\'s own settings on: "config", and it is never run', (fx) => {
    const marker = path.join(fx.dir, 'filter-ran');
    const quoted = '"' + marks(marker).replace(/"/g, '\\"') + '"'; // (in a settings file a bare ";" starts a comment)
    const env = homeWith(fx, `[filter "x"]\n\tclean = ${quoted}\n\tsmudge = ${quoted}\n`);
    if (!IS_WIN) { // the control: with this HOME an ordinary git status does run the filter once the attribute is set
      const r = spawnSync('git', ['config', '--get', 'filter.x.clean'], { cwd: fx.app, env, encoding: 'utf8' });
      assert.equal(r.stdout.trim(), marks(marker), 'the planted settings file is not read as meant');
    }
    fs.mkdirSync(path.join(fx.app, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(fx.app, '.git', 'info', 'attributes'), '* filter=x\n');
    const old = new Date(Date.now() - 86400000); fs.utimesSync(path.join(fx.app, 'lib', 'a.js'), old, old);
    return { opts: { env }, after: isConfig('info/attributes', marker) };
  }, 'config');
  await refuses('core.alternateRefsCommand with an alternates file (it would run during the fetch): "config", and it is never run', (fx) => {
    const marker = path.join(fx.dir, 'alt-ran');
    const script = path.join(fx.dir, 'alt-refs'); fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${plat.toSlash(marker)}"\nexit 0\n`); fs.chmodSync(script, 0o755);
    G(fx.app, 'config', 'core.alternateRefsCommand', plat.toSlash(script));
    fs.writeFileSync(path.join(fx.app, '.git', 'objects', 'info', 'alternates'), plat.toSlash(path.join(fx.seed, '.git', 'objects')) + '\n');
    return { after: isConfig('objects/info/alternates', marker) };
  }, 'config');
  await refuses('core.alternateRefsCommand alone: "config"', (fx) => { G(fx.app, 'config', 'core.alternateRefsCommand', 'echo'); return { after: isConfig('core.alternaterefscommand') }; }, 'config');
  await refuses('an include in .git/config (settings the list of keys does not show): "config"', (fx) => {
    fs.writeFileSync(path.join(fx.dir, 'more.cfg'), '[http]\n\tsslVerify = false\n');
    G(fx.app, 'config', 'include.path', plat.toSlash(path.join(fx.dir, 'more.cfg')));
    return { after: isConfig('include') };
  }, 'config');
  await refuses('http settings in .git/config (a proxy and no certificate check for github.com): "config"', (fx) => {
    G(fx.app, 'config', 'http.https://github.com/.sslVerify', 'false'); G(fx.app, 'config', 'http.https://github.com/.proxy', 'http://127.0.0.1:9');
    return { after: isConfig('http') };
  }, 'config');
  await refuses('a partial clone (missing files would be downloaded from the remote by its name): "config"', (fx) => {
    G(fx.app, 'config', 'remote.origin.promisor', 'true'); G(fx.app, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    return { after: isConfig('remote') };
  }, 'config');
  await refuses('a remote section named like the address that is fetched (its refspec would move another branch on a mere check): "config", the branch stays', (fx) => {
    const url = pathToFileURL(fx.bare).href;
    write(fx.app, 'lib/wip.js', 'unpushed\n'); G(fx.app, 'checkout', '-q', '-b', 'notes-wip'); G(fx.app, 'add', '-A'); G(fx.app, 'commit', '-q', '-m', 'wip'); G(fx.app, 'checkout', '-q', 'main');
    const wip = head(fx.app, 'refs/heads/notes-wip');
    G(fx.app, 'config', `remote.${url}.fetch`, '+refs/heads/main:refs/heads/notes-wip');
    return { opts: { fetchUrl: url, allowOrigin: () => true }, after: (f, s) => { isConfig('remote')(f, s); assert.equal(head(fx.app, 'refs/heads/notes-wip'), wip); } };
  }, 'config');
  await refuses('core.worktree in .git/config (the files git works on are somewhere else): "unusual"', (fx) => {
    fs.mkdirSync(path.join(fx.dir, 'elsewhere')); G(fx.app, 'config', 'core.worktree', plat.toSlash(path.join(fx.dir, 'elsewhere')));
  }, 'unusual');

  await test('branch.main.mergeOptions (--squash, --autostash) in .git/config does not turn the update into something else: a plain fast-forward', async () => {
    for (const opt of ['--squash', '--autostash', '--no-ff --no-commit']) {
      const fx = fixture(); G(fx.app, 'config', 'branch.main.mergeOptions', opt);
      const next = fx.push({ 'package.json': PKG('1.1.0'), 'lib/a.js': 'two\n' });
      const s = await fx.updater().check({ apply: true });
      assert.equal(s.result, 'updated', opt + ': ' + JSON.stringify(s)); assert.equal(head(fx.app), next, opt); assert.equal(s.restartNeeded, true);
      assert.equal(G(fx.app, 'status', '--porcelain').trim(), '', opt); assert.equal(G(fx.app, 'stash', 'list').trim(), '', opt);
      assert.equal(G(fx.app, 'rev-list', '--merges', '--count', 'HEAD').trim(), '0');
    }
  });

  await test('what a clone, an editor or a second remote leave in .git/config does not stop the updates', async () => {
    const fx = fixture();
    G(fx.app, 'remote', 'add', 'fork', 'https://github.com/someone/ResearchTool.git'); G(fx.app, 'config', 'remote.origin.gh-resolved', 'base');
    G(fx.app, 'config', 'branch.main.vscode-merge-base', 'origin/main'); G(fx.app, 'config', 'core.fsmonitor', 'true'); G(fx.app, 'config', 'user.name', 'Someone');
    G(fx.app, 'config', 'credential.helper', 'store'); G(fx.app, 'config', 'remote.origin.pushurl', 'git@github.com:someone/ResearchTool.git'); G(fx.app, 'config', 'remote.pushDefault', 'fork');
    fs.mkdirSync(path.join(fx.app, '.git', 'info'), { recursive: true }); fs.writeFileSync(path.join(fx.app, '.git', 'info', 'attributes'), '# nothing here\n');
    const next = fx.push({ 'package.json': PKG('1.1.0') });
    const u = fx.updater();
    assert.equal((await u.status({ local: true })).supported, true);
    const s = await u.check({ apply: true });
    assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(fx.app), next);
  });

  await test('the certificate check, headers and cookies of the request: a key that names github.com in the user\'s or the clone\'s settings does not win', () => {
    const fx = fixture();
    const env = update.gitEnv(homeWith(fx, '[http "https://github.com/"]\n\tsslVerify = false\n\textraHeader = Authorization: Basic Z2xvYmFsOnRlc3Q=\n\tcookieFile = /tmp/c\n\tsaveCookies = true\n'
      + `[http "${update.OFFICIAL_URL}"]\n\tsslVerify = false\n\textraHeader = X-Token: t\n[http]\n\tsslVerify = false\n\textraHeader = X-Plain: p\n`), fx.app, ['https']);
    G(fx.app, 'config', 'http.https://github.com/purple-ginseng/.sslVerify', 'false'); G(fx.app, 'config', `http.${update.OFFICIAL_URL}.sslVerify`, 'false');
    // git's own answer to "which value applies to this address" - asked of the settings, nothing is fetched
    const resolved = (cfg, key) => { const r = spawnSync('git', [...cfg, 'config', '--get-urlmatch', key, update.OFFICIAL_URL], { cwd: fx.app, env, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : `(exit ${r.status})`; };
    assert.equal(resolved([], 'http.sslVerify'), 'false', 'the control: without the options these settings do switch the check off');
    assert.equal(resolved(['-c', 'http.sslVerify=true'], 'http.sslVerify'), 'false', 'the control: the plain key alone loses against one that names the address');
    const cfg = update.gitCfg(['https']);
    assert.equal(resolved(cfg, 'http.sslVerify'), 'true');
    assert.equal(resolved(cfg, 'http.extraHeader'), '');
    assert.equal(resolved(cfg, 'http.cookieFile'), '');
    assert.equal(resolved(cfg, 'http.saveCookies'), 'false');
  });

  await test('the request is anonymous: a token header and a cookie kept in the user\'s git settings are not sent (a listener on 127.0.0.1, nothing leaves this computer)', async () => {
    const got = [];
    const srv = http.createServer((req, res) => { got.push(req.headers); res.statusCode = 404; res.end('not here\n'); });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    try {
      const fx = fixture(), url = `http://127.0.0.1:${srv.address().port}/purple-ginseng/ResearchTool.git`;
      const jar = path.join(fx.dir, 'cookies.txt'); fs.writeFileSync(jar, '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsid\tcookieval\n');
      const env = homeWith(fx, `[http]\n\textraHeader = Authorization: Basic Z2xvYmFsOnRlc3Q=\n\tcookieFile = ${plat.toSlash(jar)}\n[http "http://127.0.0.1:${srv.address().port}/"]\n\textraHeader = X-Token: scoped-secret\n`);
      for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k]; // the listener is asked directly, never through a proxy
      env.NO_PROXY = '*'; env.no_proxy = '*';
      // the control: an ordinary git with these settings does send them
      // (not spawnSync: the listener lives in this process and has to answer while git waits)
      await new Promise((res) => { const c = spawn('git', ['-c', 'protocol.http.allow=always', 'ls-remote', url], { cwd: fx.app, env, stdio: 'ignore', windowsHide: true }); c.on('error', res); c.on('close', res); setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 20000).unref(); });
      if (!got.length) return console.log('     (this git has no http transport: the headers were not checked)');
      assert.ok(got.some((h) => h.authorization) && got.some((h) => h['x-token']) && got.some((h) => /sid=cookieval/.test(h.cookie || '')), 'the planted settings do not work: ' + JSON.stringify(got));
      got.length = 0;
      const u = fx.updater({ allowOrigin: () => true, fetchUrl: url, protocols: ['http'], env });
      const s = await u.check({ apply: true });
      assert.equal(s.result, 'failed'); assert.ok(['fetch-failed', 'offline'].includes(s.reason), s.reason); assert.equal(fx.fetched(), 1);
      assert.ok(got.length >= 1, 'the request did not reach the listener');
      for (const h of got) { assert.equal(h.authorization, undefined); assert.equal(h['x-token'], undefined); assert.equal(h.cookie, undefined); }
    } finally { srv.closeAllConnections && srv.closeAllConnections(); await new Promise((res) => srv.close(res)); }
  });

  // ---------- the look at the folder for the status: one at a time, reused for a moment, and it forgets what was fixed ----------
  await test('GET /api/update/status?local=1 asked fifty times at once starts git once; the answer is reused for a few seconds', async () => {
    const fx = fixture(); let t = 1e12;
    const u = fx.updater({ lookInterval: 5000, now: () => t });
    const all = await Promise.all(Array.from({ length: 50 }, () => u.status({ local: true })));
    assert.ok(all.every((s) => s.supported === true));
    const one = u.stats.spawns;
    assert.equal(one, 8, 'one look: ' + fx.calls.map((a) => a[0]).join(' '));
    t += 3000; assert.equal((await u.status({ local: true })).supported, true); assert.equal(u.stats.spawns, one, 'asked again three seconds later: the same answer, no process');
    for (let i = 0; i < 5; i++) await u.status(); assert.equal(u.stats.spawns, one, 'the plain status never starts one');
    write(fx.app, 'lib/a.js', 'mine\n');
    t += 3000; assert.equal((await u.status({ local: true })).reason, 'dirty'); assert.equal(u.stats.spawns, 2 * one, 'six seconds later: a new look');
    assert.equal(fx.fetched(), 0);
  });

  await test('a reason about the folder (a changed file, another branch, a lock) is gone from the status once the user has fixed it', async () => {
    for (const [reason, breakIt, fixIt] of [
      ['dirty', (fx) => write(fx.app, 'lib/a.js', 'mine\n'), (fx) => G(fx.app, 'checkout', '--', 'lib/a.js')],
      ['branch', (fx) => G(fx.app, 'checkout', '-q', '-b', 'feature'), (fx) => G(fx.app, 'checkout', '-q', 'main')],
      ['locked', (fx) => fs.writeFileSync(path.join(fx.app, '.git', 'index.lock'), ''), (fx) => fs.rmSync(path.join(fx.app, '.git', 'index.lock'))],
      ['config', (fx) => G(fx.app, 'config', 'filter.x.clean', 'cat'), (fx) => G(fx.app, 'config', '--unset', 'filter.x.clean')],
    ]) {
      const fx = fixture(), u = fx.updater({ settings: () => ({ autoUpdate: true }) });
      breakIt(fx);
      let s = await u.check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, reason); assert.equal(s.supported, false);
      assert.equal((await u.status()).reason, reason, 'the plain status says what was last seen');
      fixIt(fx);
      s = await u.status({ local: true });
      assert.equal(s.supported, true, reason); assert.equal(s.reason, null, reason + ': "can update: yes" together with the old reason'); assert.equal(s.detail, undefined);
      assert.deepEqual([s.lastCheck.result, s.lastCheck.reason], ['failed', reason], 'what the last check found stays on record');
      assert.equal((await u.status()).reason, null);
    }
    // a reason that is not about the folder (GitHub was not reached) stays until the next check
    const fx = fixture(), u = fx.updater({ allowOrigin: () => true, fetchUrl: path.join(fx.dir, 'gone.git') });
    const r = (await u.check()).reason;
    assert.ok(['offline', 'fetch-failed'].includes(r), r);
    const s = await u.status({ local: true });
    assert.equal(s.supported, true); assert.equal(s.reason, r);
  });

  // ---------- a fast-forward that stops half way ----------
  if (!IS_WIN && !(process.getuid && process.getuid() === 0)) {
    await test('a fast-forward that stops half way (a folder that cannot be written): "interrupted" - not "updated", not "you changed program files" - also after a restart; the repair in the README works', async () => {
      const fx = fixture(), stateFile = path.join(fx.dir, 'update.json'), h = head(fx.app);
      write(fx.app, 'workspace/library.json', '{"items":[{"id":"mine"}]}');
      const next = fx.push({ 'package.json': PKG('1.1.0'), 'lib/a.js': 'module.exports = 2;\n', 'public/js/x.js': '// page two\n', 'public/js/new.js': 'new\n', 'zz-new.js': 'new\n' });
      const locked = path.join(fx.app, 'public', 'js');
      fs.chmodSync(locked, 0o555);
      let u = fx.updater({ stateFile, settings: () => ({ autoUpdate: true }) }), s;
      const first = u; // the server that ran the fast-forward
      try {
        s = await u.check({ apply: true });
        assert.equal(s.result, 'failed'); assert.equal(s.reason, 'interrupted', JSON.stringify(s)); assert.equal(s.supported, false); assert.equal(s.updated, null);
        // this is the state the test is about: some files new, HEAD old
        assert.equal(head(fx.app), h); assert.equal(read(fx.app, 'package.json'), PKG('1.1.0')); assert.equal(read(fx.app, 'public/js/x.js'), '// page\n');
        // what the page's notice is made from: files may be new (restart needed is true), but nothing says "updated to"
        assert.equal(s.restartNeeded, true); assert.equal(s.commit, s.running.commit); assert.equal(s.version, '1.1.0'); assert.equal(s.available, null);
        assert.deepEqual(core.readJSON(stateFile, null).interrupted, { head: h, sha: next });
        // Preferences is opened, the hourly tick comes, the button is pressed again: the same answer, never "dirty"
        s = await u.status({ local: true });
        assert.equal(s.reason, 'interrupted'); assert.equal(s.supported, false);
        assert.equal((await u.status()).reason, 'interrupted');
        s = await u.check({ apply: true });
        assert.equal(s.reason, 'interrupted'); assert.equal(s.lastCheck.reason, 'interrupted'); assert.equal(head(fx.app), h);
        assert.equal(fx.calls.filter((a) => a[0] === 'merge').length, 1, 'not tried again on top of a half-written folder');
        assert.equal(await u.tick(), null, 'nor every hour');
        // the server is started again (from the half-updated files): still "interrupted"
        u = fx.updater({ stateFile, settings: () => ({ autoUpdate: true }) });
        s = await u.status();
        assert.equal(s.reason, null); assert.equal(s.restartNeeded, false); assert.deepEqual([s.lastCheck.result, s.lastCheck.reason], ['failed', 'interrupted']);
        s = await u.status({ local: true });
        assert.equal(s.reason, 'interrupted'); assert.equal(s.supported, false);
      } finally { fs.chmodSync(locked, 0o755); }
      // what the README no longer says: git refuses to "finish" a fast-forward over files it already wrote
      assert.throws(() => G(fx.app, 'merge', '--ff-only', 'origin/main'), /would be overwritten/);
      // what it says now
      G(fx.app, 'reset', '-q', '--hard', 'origin/main');
      assert.equal(head(fx.app), next); assert.equal(G(fx.app, 'status', '--porcelain', '--untracked-files=no').trim(), '');
      assert.equal(read(fx.app, 'public/js/new.js'), 'new\n'); assert.equal(read(fx.app, 'workspace/library.json'), '{"items":[{"id":"mine"}]}');
      for (const x of [first, u]) { // (before any new look: HEAD has moved on, so the mark no longer holds - what the page's notice reads)
        s = await x.status();
        assert.equal(s.reason, null); assert.equal(s.supported, null); assert.equal(s.restartNeeded, true); assert.notEqual(s.commit, s.running.commit);
      }
      s = await u.status({ local: true });
      assert.equal(s.supported, true); assert.equal(s.reason, null); assert.equal(s.commit, next.slice(0, 7));
      assert.equal(core.readJSON(stateFile, null).interrupted, undefined, 'the mark is taken out');
      s = await u.check({ apply: true });
      assert.equal(s.result, 'up-to-date'); assert.equal(s.reason, null);
      // an edit of the user's own after that is "dirty" again, as it should be
      write(fx.app, 'lib/a.js', 'mine\n');
      assert.equal((await fx.updater({ stateFile }).status({ local: true })).reason, 'dirty');
    });

    await test('the same, put back instead of finished (git checkout of the old files): the mark goes, and a later edit is "dirty"', async () => {
      const fx = fixture(), stateFile = path.join(fx.dir, 'update.json'), h = head(fx.app);
      fx.push({ 'lib/a.js': 'module.exports = 2;\n', 'public/js/x.js': '// page two\n' }); // (the version number stays: package.json is not part of it)
      const locked = path.join(fx.app, 'public', 'js'); fs.chmodSync(locked, 0o555);
      const u = fx.updater({ stateFile });
      let s;
      try { s = await u.check({ apply: true }); } finally { fs.chmodSync(locked, 0o755); }
      assert.equal(s.reason, 'interrupted', JSON.stringify(s)); assert.equal(read(fx.app, 'lib/a.js'), 'module.exports = 2;\n');
      assert.deepEqual([s.version, s.commit], [s.running.version, s.running.commit], 'neither the version nor HEAD tells');
      assert.equal(s.restartNeeded, true, 'but files on disk are new');
      G(fx.app, 'checkout', '--', '.');
      s = await u.status({ local: true });
      assert.equal(s.supported, true); assert.equal(s.reason, null); assert.equal(s.restartNeeded, false, 'the folder is again what this process loaded'); assert.equal(head(fx.app), h);
      write(fx.app, 'lib/a.js', 'mine\n');
      assert.equal((await u.status({ local: true })).reason, 'dirty');
      assert.equal((await u.check({ apply: true })).reason, 'dirty');
      assert.equal(core.readJSON(stateFile, null).interrupted, undefined);
    });
  }

  await test('a state file that claims an interrupted update is display only: it can turn "dirty" into "interrupted" for the same HEAD, nothing more', async () => {
    const fx = fixture(), stateFile = path.join(fx.dir, 'update.json'), h = head(fx.app);
    for (const bad of [{ head: 'x', sha: 'y' }, 'yes', { head: h }, [h, h]]) {
      fs.writeFileSync(stateFile, JSON.stringify({ when: '2026-01-02T03:04:05.000Z', result: 'failed', reason: 'interrupted', interrupted: bad }));
      write(fx.app, 'lib/a.js', 'mine\n');
      assert.equal((await fx.updater({ stateFile }).status({ local: true })).reason, 'dirty', JSON.stringify(bad));
    }
    fs.writeFileSync(stateFile, JSON.stringify({ when: '2026-01-02T03:04:05.000Z', result: 'failed', reason: 'interrupted', interrupted: { head: 'a'.repeat(40), sha: 'b'.repeat(40) } }));
    assert.equal((await fx.updater({ stateFile }).status({ local: true })).reason, 'dirty', 'another HEAD: not this folder\'s story');
    G(fx.app, 'checkout', '--', 'lib/a.js');
    fs.writeFileSync(stateFile, JSON.stringify({ when: '2026-01-02T03:04:05.000Z', result: 'failed', reason: 'interrupted', interrupted: { head: h, sha: 'b'.repeat(40) } }));
    const u = fx.updater({ stateFile }), next = fx.push({ 'package.json': PKG('1.1.0') });
    assert.equal((await u.status()).restartNeeded, false);
    assert.equal((await u.check({ apply: true })).result, 'updated', 'a clean folder updates whatever the file says'); assert.equal(head(fx.app), next);
  });

  await test('the folder changes between the check and the fast-forward (a commit made in that moment): "moved", and nothing is merged', async () => {
    const fx = fixture(); let done = false;
    fx.push({ 'package.json': PKG('1.1.0') });
    const u = fx.updater({ onGit: (a) => { fx.calls.push(a); if (a[0] === 'ls-tree' && !done) { done = true; write(fx.app, 'lib/mine.js', 'mine\n'); G(fx.app, 'add', '-A'); G(fx.app, 'commit', '-q', '-m', 'mine'); } } });
    const s = await u.check({ apply: true });
    const mine = head(fx.app);
    assert.equal(done, true); assert.equal(s.result, 'failed'); assert.equal(s.reason, 'moved', JSON.stringify(s)); assert.equal(s.updated, null); assert.equal(s.restartNeeded, true, '(the user\'s own commit: the files did change)');
    assert.ok(!fx.calls.some((a) => a[0] === 'merge')); assert.equal(read(fx.app, 'package.json'), PKG('1.0.0'));
    assert.equal((await u.check({ apply: true })).reason, 'diverged'); assert.equal(head(fx.app), mine);
  });

  // ---------- git that hangs: stopped after the time allowed, nothing left running, the next check is not "busy" ----------
  if (!IS_WIN) {
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { env: ENV, encoding: 'utf8' }).stdout.trim();
    // a stand-in named git: sleeps for the one command named, is the real git for every other
    const hangsOn = (fx, verb) => {
      const bin = path.join(fx.dir, 'hang-bin'), pidFile = path.join(fx.dir, 'hang.pid'); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "${verb}" ]; then echo $$ > "${pidFile}"; exec sleep 60; fi\ndone\nexec "${realGit}" "$@"\n`); fs.chmodSync(path.join(bin, 'git'), 0o755);
      const env = { ...ENV }; for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
      return { env: { ...env, PATH: bin + path.delimiter + (ENV.PATH || '/usr/bin:/bin') }, pidFile };
    };
    const gone = async (pidFile) => {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 30)); }
      return false;
    };
    await test('a fetch, a git status or a merge that never ends is stopped: "offline" / "git-failed" / "refused", the process is gone, nothing was changed, and the next check runs', async () => {
      assert.ok(realGit, 'git was not found on the PATH');
      for (const [verb, opts, reason, supported] of [['fetch', { netTimeout: 700 }, 'offline', true], ['status', { localTimeout: 4000 }, 'git-failed', false], ['merge', { mergeTimeout: 700 }, 'refused', true]]) {
        const fx = fixture(), { env, pidFile } = hangsOn(fx, verb), h = head(fx.app), before = hashes(fx.app);
        fx.push({ 'package.json': PKG('1.1.0'), 'lib/a.js': 'two\n' });
        const u = fx.updater({ env, ...opts }), t0 = Date.now();
        const s = await u.check({ apply: true });
        assert.equal(s.result, 'failed', verb); assert.equal(s.reason, reason, verb + ': ' + JSON.stringify(s)); assert.equal(s.supported, supported, verb); assert.equal(s.updated, null); assert.equal(s.restartNeeded, false, verb);
        assert.ok(Date.now() - t0 < 20000, verb + ': it waited for the sleep');
        assert.equal(await gone(pidFile), true, verb + ': the stopped git is still running');
        assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before, verb + ': nothing was changed');
        assert.equal(s.checking, false);
        const again = await u.check(); // (within the same updater: not "busy", and it gets as far as the first time)
        assert.notEqual(again.result, 'busy', verb);
        // with a git that answers, the same folder updates
        assert.equal((await fx.updater().check({ apply: true })).result, 'updated', verb);
      }
    });
  }

  if (!IS_WIN) {
    await test('the two commits cannot be compared (git rev-list fails): "compare", nothing is merged, nothing changed', async () => {
      const fx = fixture(), bin = path.join(fx.dir, 'cmp-bin'), h = head(fx.app), before = hashes(fx.app);
      const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { env: ENV, encoding: 'utf8' }).stdout.trim();
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "rev-list" ]; then echo "fatal: bad object" >&2; exit 128; fi\ndone\nexec "${realGit}" "$@"\n`); fs.chmodSync(path.join(bin, 'git'), 0o755);
      const env = { ...ENV }; for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
      fx.push({ 'package.json': PKG('1.1.0') });
      const s = await fx.updater({ env: { ...env, PATH: bin + path.delimiter + (ENV.PATH || '/usr/bin:/bin') } }).check({ apply: true });
      assert.equal(s.result, 'failed'); assert.equal(s.reason, 'compare', JSON.stringify(s)); assert.equal(s.supported, true); assert.equal(s.available, null); assert.equal(s.restartNeeded, false);
      assert.ok(!fx.calls.some((a) => a[0] === 'merge')); assert.equal(head(fx.app), h); assert.deepEqual(hashes(fx.app), before);
      assert.ok(!JSON.stringify(s).includes('bad object'), 'no git output in the answer');
    });
  }

  // ---------- a clone whose refs are not files (reftable): nothing is asked of git until a check is ----------
  await test('a reftable clone: creating the updater and the plain status start no git process; a check updates it and asks for a restart', async () => {
    const fx = fixture(), app2 = path.join(fx.dir, 'app-reftable');
    const c = spawnSync('git', [...FIX, 'clone', '-q', '--ref-format=reftable', fx.bare, 'app-reftable'], { cwd: fx.dir, env: ENV, encoding: 'utf8', windowsHide: true });
    if (c.status !== 0) return console.log('     (this git cannot make a reftable clone: skipped)');
    assert.equal(update.headOnDisk(app2), null, 'the refs are not files here');
    const h = head(app2), calls = [];
    const mk = (o = {}) => fx.updater({ root: app2, onGit: (a) => calls.push(a), ...o });
    let u = mk();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(calls, [], 'git was started when the updater was created');
    let s = await u.status(); s = await u.status();
    assert.deepEqual(calls, [], 'git was started by the plain status');
    assert.equal(s.commit, ''); assert.equal(s.running.commit, ''); assert.equal(s.version, '1.0.0'); assert.equal(s.restartNeeded, false);
    assert.equal(await u.tick(), null); assert.deepEqual(calls, [], 'the box is off: nothing');
    s = await u.status({ local: true });
    assert.equal(s.supported, true); assert.equal(s.commit, h.slice(0, 7)); assert.equal(s.running.commit, h.slice(0, 7)); assert.equal(s.restartNeeded, false);
    const n = calls.length; await u.status(); assert.equal(calls.length, n);
    const next = fx.push({ 'package.json': PKG('1.1.0') });
    s = await u.check({ apply: true });
    assert.equal(s.result, 'updated', JSON.stringify(s)); assert.equal(head(app2), next);
    assert.equal(s.restartNeeded, true); assert.equal(s.commit, next.slice(0, 7)); assert.equal(s.running.commit, h.slice(0, 7)); assert.deepEqual(s.updated, { from: h.slice(0, 7), to: next.slice(0, 7), version: '1.1.0', restartNeeded: true });
    // a git pull by hand, seen without a commit to compare: the version tells
    u = mk(); const later = fx.push({ 'package.json': PKG('1.2.0') });
    G(app2, 'pull', '-q', '--ff-only', 'origin', 'main');
    calls.length = 0; s = await u.status();
    assert.equal(s.restartNeeded, true); assert.equal(s.version, '1.2.0'); assert.deepEqual(calls, []); assert.equal(head(app2), later);
  });

  await test('after a restart the status has the last check on record (what it found, and when) but no commit to install: the page says so', async () => {
    const fx = fixture(), stateFile = path.join(fx.dir, 'update.json');
    fx.push({ 'package.json': PKG('1.1.0') });
    let s = await fx.updater({ stateFile }).check();
    assert.equal(s.result, 'available'); assert.ok(s.available);
    s = await fx.updater({ stateFile }).status({ local: true }); // started again, box off
    assert.equal(s.available, null); assert.equal(s.reason, null); assert.equal(s.supported, true);
    assert.deepEqual([s.lastCheck.result, s.lastCheck.reason], ['available', null]);
  });

  // ---------- the endpoints ----------
  await test('GET /api/update/status and POST /api/update/check {apply}: the shape, a 400 for a non-boolean, nothing else of the body is read', async () => {
    const fx = fixture(), u = fx.updater(), handle = require('../lib/routes/update').makeHandle(u);
    const next = fx.push({ 'package.json': PKG('1.1.0') }), h = head(fx.app);
    let r = await route(handle, 'GET', '/api/update/status');
    assert.equal(r.code, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['ahead', 'auto', 'available', 'behind', 'checking', 'commit', 'disabled', 'lastCheck', 'reason', 'restartNeeded', 'running', 'supported', 'updated', 'version']);
    assert.deepEqual(fx.calls, [], 'the status: no git, no network, nothing written');
    r = await route(handle, 'GET', '/api/update/status?local=1');
    assert.equal(r.data.supported, true); assert.equal(fx.fetched(), 0); assert.ok(fx.calls.length > 0);
    assert.deepEqual(fx.calls.map((a) => a[0]), ['rev-parse', 'config', 'ls-remote', 'remote', 'symbolic-ref', 'config', 'status', 'rev-parse'], 'read-only commands');
    assert.deepEqual(fx.calls[1], ['config', '--local', '--list', '--name-only', '-z'], 'the settings inside .git are looked at before any command that reads a file of the work tree');
    assert.deepEqual(fx.calls[2], ['ls-remote', '--get-url', fx.bare], '(--get-url: git answers from its settings, without asking the remote)');
    assert.equal(head(fx.app, 'refs/remotes/origin/main'), h, 'the remote-tracking ref was not moved');
    for (const bad of ['yes', 1, null, 'true', {}]) { r = await route(handle, 'POST', '/api/update/check', { apply: bad }); assert.equal(r.code, 400, String(bad)); assert.match(r.data.error, /apply must be true or false/); }
    assert.equal(fx.fetched(), 0);
    fx.calls.length = 0;
    r = await route(handle, 'POST', '/api/update/check', { apply: false, sha: 'EVILSHA', url: 'https://evil.example/x.git', branch: 'EVILBRANCH', remote: 'EVILREMOTE', args: ['--upload-pack=EVIL'] });
    assert.equal(r.code, 200); assert.equal(r.data.result, 'available'); assert.equal(head(fx.app), h);
    assert.ok(!/EVIL|evil/.test(JSON.stringify(fx.calls)), 'nothing of the request reaches a git argument');
    r = await route(handle, 'POST', '/api/update/check', { apply: true });
    assert.equal(r.code, 200); assert.equal(r.data.result, 'updated'); assert.equal(r.data.updated.to, next.slice(0, 7)); assert.equal(r.data.restartNeeded, true);
    assert.equal(head(fx.app), next);
    for (const k of ['commit']) assert.match(r.data[k], /^[0-9a-f]{7}$/);
    assert.ok(!JSON.stringify(r.data).includes(TOP) && !JSON.stringify(r.data).includes(plat.toSlash(TOP)), 'no path in the answer');
    assert.equal((await route(handle, 'GET', '/api/update')).code, 404); assert.equal((await route(handle, 'PUT', '/api/update/check', {})).code, 404);
  });

  await test('files newer than the running program (a git pull by hand): the status asks for a restart; HEAD is read from the files, packed or not', async () => {
    const fx = fixture(), u = fx.updater(), h = head(fx.app);
    assert.equal(update.headOnDisk(fx.app), h);
    G(fx.app, 'pack-refs', '--all');
    assert.ok(!fs.existsSync(path.join(fx.app, '.git', 'refs', 'heads', 'main')));
    assert.equal(update.headOnDisk(fx.app), h, 'from packed-refs');
    G(fx.app, 'checkout', '-q', '--detach'); assert.equal(update.headOnDisk(fx.app), h, 'a detached HEAD'); G(fx.app, 'checkout', '-q', 'main');
    assert.equal(update.headOnDisk(path.join(fx.dir, 'nothing-here')), null); assert.equal(update.headOnDisk(TOP), null);
    assert.equal((await u.status()).restartNeeded, false);
    const next = fx.push({ 'package.json': PKG('1.1.0') });
    G(fx.app, 'pull', '-q', '--ff-only', 'origin', 'main'); // the user, in a terminal (a temporary clone, a local origin)
    const s = await u.status();
    assert.equal(s.restartNeeded, true); assert.equal(s.updated, null); assert.equal(s.commit, next.slice(0, 7)); assert.equal(s.running.commit, h.slice(0, 7)); assert.equal(s.version, '1.1.0'); assert.equal(s.running.version, '1.0.0');
    assert.deepEqual(fx.calls, [], 'read from the files: no git process for the plain status');
  });

  fs.rmSync(TOP, { recursive: true, force: true, maxRetries: 3 });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
