// Project-wide text search. Literal searches run in-process; regular-expression searches run this same file in a
// worker thread (see runRegexSearch) so a pattern with catastrophic backtracking can be stopped by terminating the
// worker instead of freezing the server's only thread.
const fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const CAP = 500;

// files: [{path (project-relative, for the result), abs (already resolved inside the project)}]
function searchFiles(files, q, { regex, cs }) {
  const re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
  const matches = [];
  let truncated = false;
  outer: for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].length > 10000 ? lines[i].slice(0, 10000) : lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m[0] === '') { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
        if (matches.length >= CAP) { truncated = true; break outer; }
        const start = line.length > 240 ? Math.max(0, m.index - 60) : 0;
        matches.push({ file: f.path, line: i + 1, col: m.index + 1, len: m[0].length, text: line.slice(start, start + 240), at: m.index - start });
      }
    }
  }
  return { matches, truncated };
}

// Resolves {matches, truncated}; rejects with Error (code 'TIMEOUT' when the pattern ran longer than `timeout` ms).
function runRegexSearch(files, q, opts, timeout = 2000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(__filename, { workerData: { files, q, opts } });
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('The pattern took too long to match - simplify the regular expression'), { code: 'TIMEOUT' })), timeout);
    worker.once('message', (m) => (m && m.error ? finish(reject, new Error(m.error)) : finish(resolve, m)));
    worker.once('error', (e) => finish(reject, e));
    worker.once('exit', () => finish(reject, new Error('The search stopped unexpectedly')));
  });
}

if (!isMainThread && workerData && Array.isArray(workerData.files)) {
  try { parentPort.postMessage(searchFiles(workerData.files, workerData.q, workerData.opts)); }
  catch (e) { parentPort.postMessage({ error: e.message || String(e) }); }
}

module.exports = { searchFiles, runRegexSearch };
