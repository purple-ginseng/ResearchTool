// Writing a .zip without the zip(1) program (Windows has none; a minimal Linux may lack it). Used by notes.zipTree()
// and the project download (routes/projects.js zipProject) only when `zip` is not installed; with it, zip(1) is used
// as before.
// Plain PKZIP: deflate or store per file, UTF-8 names (flag bit 11), no zip64 - a file or an archive over 4 GB is
// refused with an error rather than written wrongly. Files are read one at a time; a stored file (PDFs, pictures,
// videos, which hardly compress) is streamed in one pass - its checksum is taken over exactly the bytes copied and
// written into its header afterwards - so its size does not matter.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const deflateRaw = promisify(zlib.deflateRaw);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX32 = 0xffffffff;
const IN_MEMORY = 64 * 1024 * 1024; // larger files are stored (streamed), not deflated in memory
function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
// Every regular file below the entries `names` of folder `cwd` -> [{name (zip path, '/'), abs, dir}], folders first
// as their own entries ("a/"), like zip -r. Links are followed (as zip(1) does by default) but only while they stay
// inside `cwd`, and a folder is never entered twice: a link (or Windows junction) back to "." cannot loop.
function collect(cwd, names) {
  const out = [], seen = new Set(), dirsSeen = new Set();
  let root; try { root = fs.realpathSync(cwd); } catch { root = path.resolve(cwd); }
  const within = (p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const add = (rel) => {
    const abs = path.join(cwd, ...rel.split('/'));
    let st, real; try { st = fs.statSync(abs); real = fs.realpathSync(abs); } catch { return; }
    if (!within(real)) return;
    if (st.isDirectory()) {
      if (dirsSeen.has(real) || (real === root && rel.includes('/'))) return; // entered before, or a link back to the top
      dirsSeen.add(real);
      if (!seen.has(rel + '/')) { seen.add(rel + '/'); out.push({ name: rel + '/', abs, dir: true, mtime: st.mtime }); }
      let ents = []; try { ents = fs.readdirSync(abs).sort(); } catch { /* unreadable */ }
      for (const n of ents) add(rel + '/' + n);
    } else if (st.isFile() && !seen.has(rel)) { seen.add(rel); out.push({ name: rel, abs, dir: false, mtime: st.mtime, size: st.size }); }
  };
  for (const n of names) {
    const rel = String(n).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error('zip: bad entry name ' + n);
    add(rel);
  }
  return out;
}

// Write `out` with the entries `names` of folder `cwd` (folders recursively). store: RegExp of names kept
// uncompressed. -> {files}
async function writeZip(out, cwd, names, { store = /\.(pdf|png|jpe?g|gif|webp|mp4|webm|mov|zip|gz)$/i } = {}) {
  const entries = collect(cwd, names);
  const fd = fs.openSync(out, 'w');
  let off = 0;
  const write = (buf) => { let at = 0; while (at < buf.length) at += fs.writeSync(fd, buf, at, buf.length - at, off + at); off += buf.length; };
  const central = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8'), { time, date } = dosTime(e.mtime);
      let method = 0, crc = 0, csize = 0, usize = 0, data = null, stream = false;
      if (!e.dir) {
        if (e.size > MAX32) throw new Error(`zip: ${e.name} is larger than 4 GB`);
        if (store.test(e.name) || e.size > IN_MEMORY) { stream = true; usize = csize = e.size; } // crc: while copying
        else {
          const raw = fs.readFileSync(e.abs);
          usize = raw.length; crc = crc32(raw) >>> 0;
          const def = await deflateRaw(raw, { level: 6 });
          if (def.length < raw.length) { method = 8; data = def; } else data = raw;
          csize = data.length;
        }
      }
      if (off > MAX32) throw new Error('zip: the archive would be larger than 4 GB');
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(method, 8);
      head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(csize, 18);
      head.writeUInt32LE(usize, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
      const at = off;
      write(head); write(name);
      if (data) write(data);
      else if (stream && e.size) {
        let left = e.size, c32 = 0;
        for await (const chunk of fs.createReadStream(e.abs, { highWaterMark: 1 << 20, end: e.size - 1 })) {
          const c = chunk.length > left ? chunk.subarray(0, left) : chunk;
          write(c); c32 = crc32(c, c32); left -= c.length;
        }
        if (left) throw new Error(`zip: ${e.name} changed while it was read`);
        crc = c32 >>> 0; // over exactly the bytes stored (a file that grew meanwhile is cut at the size in its header)
        const b = Buffer.alloc(4); b.writeUInt32LE(crc, 0); fs.writeSync(fd, b, 0, 4, at + 14);
      }
      central.push({ name, method, time, date, crc, csize, usize, at, dir: e.dir });
    }
    const cdAt = off;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE((3 << 8) | 20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24); h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(((c.dir ? 0o040755 : 0o100644) << 16 | (c.dir ? 0x10 : 0)) >>> 0, 38); // unix mode + the DOS folder bit
      h.writeUInt32LE(c.at, 42);
      write(h); write(c.name);
    }
    if (central.length > 0xffff || off > MAX32) throw new Error('zip: too many files or too large for a plain zip');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(off - cdAt, 12); end.writeUInt32LE(cdAt, 16);
    write(end);
  } catch (e) { fs.closeSync(fd); fs.rmSync(out, { force: true }); throw e; }
  fs.closeSync(fd);
  return { files: entries.filter((e) => !e.dir).length };
}

module.exports = { writeZip, crc32 };
