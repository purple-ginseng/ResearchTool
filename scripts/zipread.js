// A small .zip reader for the tests (no unzip program needed, so the tests run the same on macOS, Linux and
// Windows): list(file) -> entry names, read(file, name) -> Buffer, extract(file, dir). Stored and deflated entries,
// as written by zip(1) and by lib/zip.js. Not used by the server.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function entries(file) {
  const buf = fs.readFileSync(file);
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip: ' + file);
  const total = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    out.push({ name, method, csize, usize, at, crc: buf.readUInt32LE(p + 16) });
    p += 46 + nlen + elen + clen;
  }
  return { buf, list: out };
}
function dataOf(buf, en) {
  if (buf.readUInt32LE(en.at) !== 0x04034b50) throw new Error('bad local header: ' + en.name);
  const start = en.at + 30 + buf.readUInt16LE(en.at + 26) + buf.readUInt16LE(en.at + 28);
  const raw = buf.subarray(start, start + en.csize);
  const data = en.method === 0 ? Buffer.from(raw) : en.method === 8 ? zlib.inflateRawSync(raw) : null;
  if (!data) throw new Error('unsupported method ' + en.method);
  if (data.length !== en.usize) throw new Error('size mismatch: ' + en.name);
  return data;
}
const list = (file) => entries(file).list.map((e) => e.name);
function read(file, name) {
  const { buf, list: all } = entries(file);
  const en = all.find((e) => e.name === name);
  if (!en) throw new Error(name + ' is not in ' + file);
  return dataOf(buf, en);
}
function extract(file, dir) {
  const { buf, list: all } = entries(file);
  for (const en of all) {
    if (en.name.split('/').includes('..') || path.isAbsolute(en.name)) throw new Error('unsafe name ' + en.name);
    const dest = path.join(dir, ...en.name.split('/'));
    if (en.name.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, dataOf(buf, en));
  }
}
module.exports = { list, read, extract, entries };
