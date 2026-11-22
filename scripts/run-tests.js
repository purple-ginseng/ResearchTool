#!/usr/bin/env node
// Runs every scripts/test-*.js with this node (process.execPath), one after the other, and prints a summary.
// Exit code 1 when any of them fails. No shell, no globbing: the same on macOS, Linux and Windows.
//   node scripts/run-tests.js              all tests (the output of a failing one is printed in full)
//   node scripts/run-tests.js --verbose    print the output of every test
//   node scripts/run-tests.js lineage figures   only the tests whose name contains one of the words
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = __dirname;
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const only = argv.filter((a) => !a.startsWith('--'));
const files = fs.readdirSync(DIR).filter((f) => /^test-.+\.js$/.test(f)).sort()
  .filter((f) => !only.length || only.some((w) => f.includes(w)));
const TIMEOUT = 10 * 60 * 1000;

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const child = spawn(process.execPath, [path.join(DIR, file)], { cwd: path.join(DIR, '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { out += `\n[run-tests: killed after ${TIMEOUT / 1000} s]\n`; child.kill('SIGKILL'); }, TIMEOUT);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ file, code: -1, out: out + String(e), ms: Date.now() - t0 }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ file, code: code == null ? (signal || 'signal') : code, out, ms: Date.now() - t0 }); });
  });
}

(async () => {
  if (!files.length) { console.error('run-tests: no test files matched'); process.exit(1); }
  console.log(`node ${process.version} on ${process.platform}/${process.arch} - ${files.length} test file${files.length === 1 ? '' : 's'}\n`);
  const results = [];
  for (const f of files) {
    const r = await runOne(f);
    results.push(r);
    const last = r.out.trim().split(/\r?\n/).pop() || '';
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${f.padEnd(28)} ${(r.ms / 1000).toFixed(1).padStart(6)} s   ${last.slice(0, 100)}`);
    if (verbose || r.code !== 0) console.log(r.out.replace(/^/gm, '      | ') + '\n');
  }
  const bad = results.filter((r) => r.code !== 0);
  const total = results.reduce((s, r) => s + r.ms, 0);
  console.log(`\n${results.length - bad.length} of ${results.length} test files passed (${(total / 1000).toFixed(1)} s)` + (bad.length ? `; failed: ${bad.map((r) => r.file).join(', ')}` : ''));
  process.exit(bad.length ? 1 : 0);
})();
