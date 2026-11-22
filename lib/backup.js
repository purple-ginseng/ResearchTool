// Workspace backups: dated copies of the whole workspace (everything except cache/) in a folder the user chooses.
//
//   <backup folder>/snapshot-2026-11-17_093000/      one complete, browsable copy of the workspace
//       rt-backup.json                               {app, when, reason, workspace, files, bytes, copied, papers}
//       library.json  notes/  pdfs/  ...
//
// A file that did not change since the previous snapshot (same size and time) is a hard link to that snapshot's
// file, so a snapshot costs only the space of what changed (PDFs are stored once). Files are never linked to the
// live workspace, and a restore always copies, so a snapshot cannot be changed by the app afterwards.
// A snapshot is written under a ".partial-" name and renamed when it is complete; an interrupted one is removed by
// the next run. Kept: every snapshot of the last 48 hours, the newest of each of the last 14 days that have one,
// and the newest of each of the last 8 weeks. Only folders named snapshot-... that hold rt-backup.json are ever
// listed, pruned or restored - whatever else is in the backup folder is left alone.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const core = require('./core');
const { WS, ROOT, DIRS, readJSON, writeJSON, httpErr, expandHome } = core;

const MARK = 'rt-backup.json';
const NAME = /^snapshot-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/;
const SKIP_TOP = new Set(['cache']);                                   // rebuilt when missing
const skipName = (n) => n === '.DS_Store' || /\.\d+\.\d+\.tmp$/.test(n);  // Finder litter, half-written JSON files
const HOUR = 3600000, DAY = 24 * HOUR;
// a workspace of its own (RT_WORKSPACE: tests, a second library) gets a backup folder of its own beside it
const DEFAULT_DIR = process.env.RT_WORKSPACE ? WS + '-backups' : path.join(ROOT, 'backups');

const real = (p) => core.plat.realpathNear(p); // native on Windows (8.3 names expanded), also for a folder not made yet
function checkDir(dir) {
  const d = path.resolve(expandHome(String(dir || '').trim()));
  const example = process.platform === 'win32' ? 'D:\\Backups\\ResearchTool' : process.platform === 'darwin' ? '/Users/you/Backups/ResearchTool' : '/home/you/Backups/ResearchTool';
  if (!String(dir || '').trim() || !path.isAbsolute(expandHome(String(dir).trim()))) throw httpErr(400, 'The backup folder must be an absolute path, for example ' + example);
  // case-blind where the disk is (macOS, Windows): a refusal may match more, never less
  const within = core.plat.insideAnyCase;
  if (within(real(WS), real(d)) || within(WS, d)) throw httpErr(400, 'The backup folder cannot be inside the workspace folder: a backup has to live somewhere else.');
  return d;
}
function config() {
  const s = core.loadSettings();
  let dir = DEFAULT_DIR;
  if (typeof s.backupDir === 'string' && s.backupDir.trim()) { try { dir = checkDir(s.backupDir); } catch { /* a bad saved value: the default */ } }
  return { dir, auto: s.backupAuto !== false, isDefault: dir === DEFAULT_DIR };
}
// PUT /api/settings {backupDir?, backupAuto?}: validates and writes into the settings object `s` (saved by the caller)
function configure(s, b) {
  if ('backupAuto' in b) { if (typeof b.backupAuto !== 'boolean') throw httpErr(400, 'backupAuto must be true or false'); if (b.backupAuto) delete s.backupAuto; else s.backupAuto = false; }
  if ('backupDir' in b) {
    if (typeof b.backupDir !== 'string') throw httpErr(400, 'backupDir must be a path');
    if (!b.backupDir.trim()) delete s.backupDir;
    else { const d = checkDir(b.backupDir); if (d === DEFAULT_DIR) delete s.backupDir; else s.backupDir = d; }
  }
}

const z = (n) => String(n).padStart(2, '0');
const nameAt = (d) => `snapshot-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
const timeOf = (name) => { const m = NAME.exec(name); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };

// the snapshots in `dir`, newest first
function list(dir = config().dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const m = readJSON(path.join(dir, name, MARK), null);
    if (!m || m.app !== 'ResearchTool') continue;
    out.push({ name, time: timeOf(name), when: new Date(timeOf(name)).toISOString(), reason: String(m.reason || 'manual'), files: Number(m.files) || 0,
      bytes: Number(m.bytes) || 0, copied: Number(m.copied) || 0, papers: Number.isInteger(m.papers) ? m.papers : null,
      workspace: String(m.workspace || ''), other: !!m.workspace && m.workspace !== WS });
  }
  return out.sort((a, b) => b.time - a.time);
}

// ---------- copying ----------
const sameFile = (a, b) => a.size === b.size && (Math.abs(a.mtimeMs - b.mtimeMs) < 2 || (b.mtimeMs % 1000 === 0 && Math.abs(a.mtimeMs - b.mtimeMs) < 2000)); // a disk that keeps whole seconds only
// Copy the folder `src` to `dest`. `prev` = the same folder in the previous snapshot (unchanged files are linked to
// it) or null. `top` = names to leave out at this level; `top.sub(name)` may give the same kind of filter for the
// folder `name` one level down. Links and special files are not copied.
async function copyTree(src, dest, prev, tally, top = null) {
  await fsp.mkdir(dest, { recursive: true });
  let ents;
  try { ents = await fsp.readdir(src, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const d of ents) {
    if (skipName(d.name) || (top && top(d.name))) continue;
    const s = path.join(src, d.name), t = path.join(dest, d.name), p = prev ? path.join(prev, d.name) : null;
    if (d.isDirectory()) { await copyTree(s, t, p, tally, top && top.sub ? top.sub(d.name) : null); continue; }
    if (!d.isFile()) continue;
    let st;
    try { st = await fsp.stat(s); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } // removed while we were copying
    let linked = false;
    if (p) {
      try { const ps = await fsp.stat(p); if (ps.isFile() && sameFile(st, ps)) { await fsp.link(p, t); linked = true; } }
      catch { /* no such file before, or a disk without hard links: copy */ }
    }
    if (!linked) {
      try { await fsp.copyFile(s, t, fs.constants.COPYFILE_FICLONE); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      await fsp.utimes(t, st.atime, st.mtime).catch(() => {});
      tally.copied++; tally.copiedBytes += st.size;
    }
    tally.files++; tally.bytes += st.size;
  }
}

// ---------- taking a snapshot ----------
let running = null;   // {reason, started, files} while a backup or a restore is at work
let lastError = null; // {when, message} of the last backup that failed (cleared by a good one)

function prune(dir, keepNames = []) {
  const mine = list(dir).filter((s) => !s.other), now = Date.now();
  const keep = new Set(keepNames), days = new Set(), weeks = new Set();
  for (const s of mine) { // newest first
    const d = new Date(s.time), day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)), week = `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
    if (now - s.time < 2 * DAY) keep.add(s.name);
    if (!days.has(day) && days.size < 14) { days.add(day); keep.add(s.name); }
    if (!weeks.has(week) && weeks.size < 8) { weeks.add(week); keep.add(s.name); }
  }
  let removed = 0;
  for (const s of mine) if (!keep.has(s.name)) {
    try { fs.rmSync(path.join(dir, s.name), { recursive: true, force: true }); removed++; } catch (e) { console.error('backup prune:', e.message); }
  }
  return removed;
}

async function snapshot(reason, { keep = [] } = {}) {
  const { dir } = config();
  try { await fsp.mkdir(dir, { recursive: true }); await fsp.access(dir, fs.constants.W_OK); }
  catch (e) {
    const vol = /^\/Volumes\/[^/]+/.exec(dir); // an external disk that is not plugged in
    const why = vol && !fs.existsSync(vol[0]) ? `the disk ${vol[0].slice(9)} is not connected` : e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission to write there' : e.code === 'ENOENT' ? 'it does not exist' : e.code === 'EEXIST' || e.code === 'ENOTDIR' ? 'that path is a file, not a folder' : e.message;
    throw httpErr(409, `The backup folder cannot be used (${dir}): ${why}`);
  }
  // leftovers of a backup that was interrupted
  for (const n of fs.readdirSync(dir)) if (/^\.partial-snapshot-/.test(n)) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { /* next time */ } }
  const before = list(dir).filter((s) => !s.other);
  let when = new Date(), name = nameAt(when);
  while (fs.existsSync(path.join(dir, name))) { when = new Date(when.getTime() + 1000); name = nameAt(when); } // two within one second
  const tmp = path.join(dir, '.partial-' + name);
  const tally = running; Object.assign(tally, { files: 0, bytes: 0, copied: 0, copiedBytes: 0 });
  try {
    // trash/before-restore-<time>/ is a whole earlier workspace that a restore moved aside: it is already kept as the
    // 'before-restore' snapshot, and copying it again would double the size of every later backup
    const skipTop = (n) => SKIP_TOP.has(n) || n.startsWith('.restore-') || n === MARK;
    skipTop.sub = (n) => (n === 'trash' ? (m) => m.startsWith('before-restore-') : null);
    await copyTree(WS, tmp, before.length ? path.join(dir, before[0].name) : null, tally, skipTop);
    let papers = null;
    try { const j = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')); if (Array.isArray(j.items)) papers = j.items.length; } catch { /* no library yet, or a damaged one: still worth keeping */ }
    writeJSON(path.join(tmp, MARK), { app: 'ResearchTool', v: 1, when: when.toISOString(), reason, workspace: WS, files: tally.files, bytes: tally.bytes, copied: tally.copied, copiedBytes: tally.copiedBytes, papers });
    await fsp.rename(tmp, path.join(dir, name));
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* removed by the next run */ }
    throw e.status ? e : httpErr(500, 'The backup could not be written: ' + e.message);
  }
  prune(dir, [name, ...keep]);
  return list(dir).find((s) => s.name === name);
}

// one backup or restore at a time
async function exclusive(reason, fn) {
  if (running) throw Object.assign(httpErr(409, running.reason === 'restore' ? 'A backup is being restored - wait until it is finished.' : 'A backup is already being made - wait until it is finished.'), { busy: true });
  running = { reason, started: Date.now(), files: 0 };
  try { return await fn(); } finally { running = null; }
}
async function run(reason = 'manual') {
  try { const s = await exclusive(reason, () => snapshot(reason)); lastError = null; return s; }
  catch (e) { if (!e.busy) lastError = { when: new Date().toISOString(), message: e.message, dir: config().dir }; throw e; }
}

// ---------- restoring ----------
// The current state is kept twice: as a snapshot of its own ("before-restore") and, moved aside, in the trash.
// The snapshot is first copied into the workspace under a temporary name; only when that copy is complete are the
// folders swapped (renames on one disk), so a restore that fails half way leaves the workspace as it was.
async function restore(name) {
  const { dir } = config();
  if (!NAME.test(String(name))) throw httpErr(400, 'Bad backup name');
  const src = path.join(dir, name);
  const mark = readJSON(path.join(src, MARK), null);
  if (!mark || mark.app !== 'ResearchTool') throw httpErr(404, 'That backup is not in the backup folder any more');
  if (fs.existsSync(path.join(src, 'library.json'))) {
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(src, 'library.json'), 'utf8')); } catch { /* refused below */ }
    if (!j || !Array.isArray(j.items)) throw httpErr(409, 'The list of references in that backup cannot be read, so it was not restored.');
  }
  return exclusive('restore', async () => {
    const safety = await snapshot('before-restore', { keep: [name] });
    running.reason = 'restore';
    const stampNow = core.stamp(), stage = path.join(WS, '.restore-' + stampNow), hold = path.join(DIRS.trash, 'before-restore-' + stampNow);
    let trashEmpty = true; try { trashEmpty = fs.readdirSync(DIRS.trash).length === 0; } catch { /* no trash folder yet */ }
    const cur = core.loadSettings();
    const swapped = [];
    try {
      await copyTree(src, stage, null, { files: 0, bytes: 0, copied: 0, copiedBytes: 0 }, (n) => n === MARK || SKIP_TOP.has(n));
      const leave = (n) => SKIP_TOP.has(n) || n === 'trash' || n.startsWith('.restore-') || skipName(n);
      const names = new Set([...fs.readdirSync(WS), ...fs.readdirSync(stage)].filter((n) => !leave(n)));
      fs.mkdirSync(hold, { recursive: true });
      for (const n of names) {
        const live = path.join(WS, n), staged = path.join(stage, n), step = { n, held: false, placed: false };
        swapped.push(step);
        if (fs.existsSync(live)) { fs.renameSync(live, path.join(hold, n)); step.held = true; }
        if (fs.existsSync(staged)) { fs.renameSync(staged, live); step.placed = true; }
      }
      // the trash of the backup comes back only into an empty trash (the trash never loses anything by a restore)
      if (trashEmpty && fs.existsSync(path.join(stage, 'trash'))) for (const n of fs.readdirSync(path.join(stage, 'trash'))) fs.renameSync(path.join(stage, 'trash', n), path.join(DIRS.trash, n));
    } catch (e) {
      for (const step of swapped.reverse()) { // put everything back the way it was
        try {
          if (step.placed) fs.renameSync(path.join(WS, step.n), path.join(stage, step.n));
          if (step.held) fs.renameSync(path.join(hold, step.n), path.join(WS, step.n));
        } catch (e2) { console.error('backup restore, undo:', e2.message); }
      }
      try { fs.rmSync(stage, { recursive: true, force: true }); if (!fs.readdirSync(hold).length) fs.rmdirSync(hold); } catch { /* temporary copy */ }
      throw httpErr(500, 'The backup could not be restored, and the workspace is as it was: ' + e.message);
    }
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* an empty temporary folder */ }
    for (const d of [WS, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });
    // where backups go is a choice about this Mac, not part of what is restored
    try {
      const s = readJSON(core.SETTINGS_FILE, {});
      delete s.backupDir; delete s.backupAuto;
      if (typeof cur.backupDir === 'string') s.backupDir = cur.backupDir;
      if (cur.backupAuto === false) s.backupAuto = false;
      core.saveSettings(s);
    } catch (e) { console.error('backup restore, settings:', e.message); }
    try { core.writeWorkspaceGuide(); } catch { /* the guide is a convenience */ }
    return { restored: name, when: mark.when, papers: Number.isInteger(mark.papers) ? mark.papers : null, safety: safety.name, moved: core.plat.toSlash(path.relative(WS, hold)) };
  });
}

// ---------- what the Settings window shows ----------
// bytes the snapshots really take: a file shared by several snapshots counts once
function diskSize(dir, names) {
  const seen = new Set(); let n = 0;
  const walk = (p) => {
    let ents = []; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const f = path.join(p, d.name);
      if (d.isDirectory()) walk(f);
      else { try { const st = fs.statSync(f); const k = st.dev + ':' + st.ino; if (!seen.has(k)) { seen.add(k); n += st.size; } } catch { /* gone */ } }
    }
  };
  for (const name of names) walk(path.join(dir, name));
  return n;
}
function hasData() {
  try { if (core.loadLib().items.length) return true; } catch { return true; } // a damaged library is a reason to keep what there is
  try { return fs.readdirSync(DIRS.projects).length > 0; } catch { return false; }
}
function status({ sizes = true } = {}) {
  const c = config(), all = list(c.dir), mine = all.filter((s) => !s.other);
  const last = mine[0] || null, days = last ? Math.floor((Date.now() - last.time) / DAY) : null;
  return {
    dir: c.dir, auto: c.auto, isDefault: c.isDefault, defaultDir: DEFAULT_DIR, workspace: WS,
    running: running ? { reason: running.reason, files: running.files || 0 } : null,
    snapshots: all, last: last ? { name: last.name, when: last.when } : null,
    // worth telling the user: nothing for 3 days (or never) although there is something to lose
    stale: hasData() && (last ? days >= 3 : true), days,
    size: sizes ? diskSize(c.dir, all.map((s) => s.name)) : null,
    error: lastError && lastError.dir === c.dir ? { when: lastError.when, message: lastError.message } : null, // a failure in a folder that is no longer the one chosen says nothing
  };
}

// ---------- once a day, by itself ----------
// Checked a little after the start and then every hour: a snapshot is taken when the newest one is older than 20
// hours. A failure (the disk is not connected) is kept for the Settings window and tried again the next hour.
async function tick() {
  try {
    const c = config();
    if (!c.auto || running || !hasData()) return;
    const last = list(c.dir).find((s) => !s.other);
    if (last && Date.now() - last.time < 20 * HOUR) return;
    await run('daily');
  } catch (e) { if (!e.busy) console.error('automatic backup:', e.message); }
}
let timers = null;
function schedule() {
  if (timers) return;
  timers = [setTimeout(tick, Number(process.env.RT_BACKUP_FIRST_MS) || 90 * 1000), setInterval(tick, HOUR)];
  for (const t of timers) t.unref();
}

module.exports = { config, configure, list, run, restore, status, schedule, tick, DEFAULT_DIR, MARK };
