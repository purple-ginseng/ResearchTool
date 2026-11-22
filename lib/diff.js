// Line diff (LCS) in plain JS. Ops: {t: 'eq'|'add'|'del', text}, one per line.
const MAX_CELLS = 4e6; // above this fall back to one del block + one add block

function splitLines(s) {
  if (!s) return [];
  const a = String(s).split(/\r?\n/);
  if (a[a.length - 1] === '') a.pop(); // trailing newline does not make an extra line
  return a;
}

function lineDiff(aText, bText) {
  const a = splitLines(aText), b = splitLines(bText);
  const ops = [];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  for (let i = 0; i < s; i++) ops.push({ t: 'eq', text: a[i] });

  const n = ea - s, m = eb - s;
  if (n && m && n * m <= MAX_CELLS) {
    // intern lines so the inner loop compares integers
    const ids = new Map();
    const intern = (l) => { let v = ids.get(l); if (v === undefined) { v = ids.size; ids.set(l, v); } return v; };
    const A = new Int32Array(n), B = new Int32Array(m);
    for (let i = 0; i < n; i++) A[i] = intern(a[s + i]);
    for (let j = 0; j < m; j++) B[j] = intern(b[s + j]);
    // L[i][j] = LCS length of A[i..] and B[j..]; n*m <= 4e6 so min(n,m) <= 2000 fits in 16 bits
    const w = m + 1, L = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      const row = i * w, below = row + w;
      for (let j = m - 1; j >= 0; j--) {
        L[row + j] = A[i] === B[j] ? L[below + j + 1] + 1 : (L[below + j] >= L[row + j + 1] ? L[below + j] : L[row + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: 'eq', text: a[s + i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push({ t: 'del', text: a[s + i] }); i++; }
      else { ops.push({ t: 'add', text: b[s + j] }); j++; }
    }
    for (; i < n; i++) ops.push({ t: 'del', text: a[s + i] });
    for (; j < m; j++) ops.push({ t: 'add', text: b[s + j] });
  } else {
    for (let i = s; i < ea; i++) ops.push({ t: 'del', text: a[i] });
    for (let j = s; j < eb; j++) ops.push({ t: 'add', text: b[j] });
  }
  for (let i = ea; i < a.length; i++) ops.push({ t: 'eq', text: a[i] });
  return ops;
}

function stats(aText, bText) {
  let added = 0, removed = 0;
  for (const o of lineDiff(aText, bText)) { if (o.t === 'add') added++; else if (o.t === 'del') removed++; }
  return { added, removed };
}

module.exports = { splitLines, lineDiff, stats };
