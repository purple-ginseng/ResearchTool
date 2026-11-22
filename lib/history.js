// Version history: <base>/<projectId>/index.json + content-addressed blobs in <base>/<projectId>/blobs/<sha1>.
// Never stored inside the project folder. All calls are synchronous, so read-modify-write is atomic per request.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const diff = require('./diff');
const plat = require('./platform');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const cleanLabel = (l) => (typeof l === 'string' && l.trim() ? l.trim().slice(0, 200) : null);
// the public shape of a version (internal fields: hash, burst)
const pub = (v) => ({ id: v.id, ts: v.ts, file: v.file, source: v.source, label: v.label ?? null, size: v.size, added: v.added, removed: v.removed });

module.exports = function createHistory(base, { burstMs = 5 * 60 * 1000 } = {}) {
  const dir = (pid) => path.join(base, pid);
  const blobFile = (pid, hash) => path.join(dir(pid), 'blobs', hash);

  function load(pid) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir(pid), 'index.json'), 'utf8'));
      if (j && Array.isArray(j.versions)) return { versions: j.versions.filter((v) => v && v.id && v.file && v.hash) };
    } catch { /* missing or corrupt: start empty */ }
    return { versions: [] };
  }
  function save(pid, idx) {
    fs.mkdirSync(dir(pid), { recursive: true });
    const f = path.join(dir(pid), 'index.json'), tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx));
    plat.renameSync(tmp, f);
  }
  function putBlob(pid, hash, buf) {
    const f = blobFile(pid, hash);
    if (fs.existsSync(f)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
  }
  const getBlob = (pid, hash) => { try { return fs.readFileSync(blobFile(pid, hash)); } catch { return Buffer.alloc(0); } };

  // A session over one project's index: read once, mutate, commit() once.
  function open(pid) {
    const idx = load(pid);
    const vs = idx.versions; // oldest first
    let dirty = false;
    const newest = (file) => { for (let i = vs.length - 1; i >= 0; i--) if (vs[i].file === file) return vs[i]; return null; };
    const prevOf = (v) => { for (let i = vs.indexOf(v) - 1; i >= 0; i--) if (vs[i].file === v.file) return vs[i]; return null; };
    const text = (v) => (v ? getBlob(pid, v.hash).toString('utf8') : '');
    const gc = (hash) => { if (!vs.some((v) => v.hash === hash)) fs.rmSync(blobFile(pid, hash), { force: true }); };

    // Returns the stored version that now holds this content, or null if nothing was recorded.
    function record(file, buf, source, { label } = {}) {
      label = cleanLabel(label);
      const hash = sha1(buf), now = Date.now(), last = newest(file);
      if (last && last.hash === hash) {
        // an explicit Save of text that autosave already stored: pin that version as a save point, so the next
        // autosave no longer replaces it in place
        const pin = source === 'manual' && last.source === 'auto';
        if (!label && !pin) return null;
        if (pin) last.source = 'manual';
        if (label) last.label = label;
        dirty = true;
        return last;
      }
      if (source === 'auto' && !label && last && last.source === 'auto' && !last.label && now - (last.burst || 0) < burstMs) {
        // same editing burst: replace in place, keep the id
        const prev = prevOf(last), old = last.hash;
        dirty = true;
        if (prev && prev.hash === hash) { vs.splice(vs.indexOf(last), 1); gc(old); return null; } // edits were undone
        putBlob(pid, hash, buf);
        Object.assign(last, { ts: new Date(now).toISOString(), hash, size: buf.length, ...diff.stats(text(prev), buf.toString('utf8')) });
        gc(old);
        return last;
      }
      putBlob(pid, hash, buf);
      const v = { id: crypto.randomBytes(5).toString('hex'), ts: new Date(now).toISOString(), file, source, label, size: buf.length,
        ...diff.stats(text(last), buf.toString('utf8')), hash, burst: now };
      vs.push(v); dirty = true;
      return v;
    }

    return {
      versions: vs, newest, prevOf, text, record,
      blob: (v) => { try { return fs.readFileSync(blobFile(pid, v.hash)); } catch { return null; } },
      find: (id) => vs.find((v) => v.id === id) || null,
      files: () => [...new Set(vs.map((v) => v.file))],
      touch: () => { dirty = true; },
      commit: () => { if (dirty) { save(pid, idx); dirty = false; } },
    };
  }

  function list(pid, file, limit) {
    let vs = load(pid).versions;
    if (file) vs = vs.filter((v) => v.file === file);
    return vs.map((v, i) => [v, i]).sort((a, b) => (a[0].ts < b[0].ts ? 1 : a[0].ts > b[0].ts ? -1 : b[1] - a[1]))
      .slice(0, limit).map(([v]) => pub(v));
  }

  // history entries follow a renamed file or folder
  function rename(pid, from, to) {
    const h = open(pid);
    for (const v of h.versions) {
      if (v.file === from) { v.file = to; h.touch(); }
      else if (v.file.startsWith(from + '/')) { v.file = to + v.file.slice(from.length); h.touch(); }
    }
    h.commit();
  }

  return { open, list, rename, pub, sha1, cleanLabel, dir };
};
