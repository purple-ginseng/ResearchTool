// The conversations of the AI panel, kept per paper and per project (UI: public/js/claude.js, the History button).
// A paper or a project can have several conversations: "New chat" starts another one and the earlier ones stay,
// to be read or continued later. They live in <workspace>/chats/<kind>-<id>.json, so they are in the backups and
// are the same in every browser; the page keeps a copy of the open one in localStorage for a fast start.
//   GET    /api/chats                 [{key, t, threads: [{id, t, title, n, p}]}]  every key that has conversations,
//                                     the most recently used first (no message text)
//   GET    /api/chats/:key/:id        {id, t, s, p, title, log: [[kind, text], ...]}
//   PUT    /api/chats/:key/:id {s?, p?, log}   saves a conversation (replaces the one of that id) -> its entry of the list
//   DELETE /api/chats/:key/:id        removes one conversation;  DELETE /api/chats/:key  all of that paper or project
// key = "item:<id>", "project:<id>" or "general". kind = user | bot | tool | err. s = the session id of the AI
// command-line tool (to continue the conversation), p = the provider it was held with.
// Nothing here starts a program or reads anything but its own folder; the texts are data and are never run.
const fs = require('fs');
const path = require('path');
const core = require('../core');
const { WS, readJSON, writeJSON, httpErr } = core;

const DIR = path.join(WS, 'chats');
const MAX_THREADS = 40, MAX_MSGS = 300, MAX_MSG_CHARS = 20000, MAX_BODY = 4 * 1024 * 1024;
const KINDS = new Set(['user', 'bot', 'tool', 'err']);
const KEY = /^(?:general|(?:item|project):[A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/;
const ID = /^[a-z0-9]{6,24}$/;

const fileOf = (key) => path.join(DIR, key.replace(':', '-') + '.json');
const keyOfFile = (name) => { const m = /^(general|item|project)(?:-(.+))?\.json$/.exec(name); if (!m) return null; const k = m[1] === 'general' ? (m[2] ? null : 'general') : m[2] ? m[1] + ':' + m[2] : null; return k && KEY.test(k) ? k : null; };
const cleanLog = (log) => (Array.isArray(log) ? log : []).filter((e) => Array.isArray(e) && KINDS.has(e[0]) && typeof e[1] === 'string' && e[1])
  .slice(-MAX_MSGS).map((e) => [e[0], e[1].length > MAX_MSG_CHARS ? e[1].slice(0, MAX_MSG_CHARS) + '\n\n… (shortened)' : e[1]]);
// a conversation as it is kept: only what is whole (the file may have been edited by hand)
function whole(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id)) return null;
  const log = cleanLog(t.log);
  if (!log.length) return null;
  const first = (log.find((e) => e[0] === 'user') || log[0])[1].replace(/\s+/g, ' ').trim();
  return {
    id: t.id, t: Number.isFinite(t.t) ? t.t : 0,
    s: typeof t.s === 'string' && /^[0-9a-f-]{8,64}$/i.test(t.s) ? t.s : null,
    p: typeof t.p === 'string' && /^[a-z]{2,12}$/.test(t.p) ? t.p : 'claude',
    title: first.length > 90 ? first.slice(0, 89) + '…' : first, log,
  };
}
function read(key) {
  const d = readJSON(fileOf(key), null);
  const list = d && typeof d === 'object' && Array.isArray(d.threads) ? d.threads.map(whole).filter(Boolean) : [];
  return list.sort((a, b) => b.t - a.t);
}
function write(key, threads) {
  if (!threads.length) { fs.rmSync(fileOf(key), { force: true }); return; }
  fs.mkdirSync(DIR, { recursive: true });
  writeJSON(fileOf(key), { v: 1, key, threads });
}
const entry = (t) => ({ id: t.id, t: t.t, title: t.title, n: t.log.filter((e) => e[0] === 'user').length, p: t.p });

async function handle(ctx) {
  const { path: p, method: M, send, segments: seg } = ctx;
  if (seg[1] !== 'chats') return false;
  if (seg.length === 2 && M === 'GET') {
    let names = [];
    try { names = fs.readdirSync(DIR); } catch { /* no conversation was kept yet */ }
    const out = [];
    for (const name of names) {
      const key = keyOfFile(name); if (!key) continue;
      const threads = read(key); if (!threads.length) continue;
      out.push({ key, t: threads[0].t, threads: threads.map(entry) });
    }
    return send(200, out.sort((a, b) => b.t - a.t));
  }
  const key = seg[2];
  if (!key || !KEY.test(key) || seg.length > 4) throw httpErr(400, 'Bad conversation address');
  if (seg.length === 3) {
    if (M !== 'DELETE') return false;
    write(key, []);
    return send(200, { ok: true });
  }
  const id = seg[3];
  if (!ID.test(id)) throw httpErr(400, 'Bad conversation id');
  const threads = read(key), at = threads.findIndex((t) => t.id === id);
  if (M === 'GET') {
    if (at < 0) throw httpErr(404, 'That conversation is not kept any more');
    return send(200, threads[at]);
  }
  if (M === 'DELETE') {
    if (at >= 0) { threads.splice(at, 1); write(key, threads); }
    return send(200, { ok: true });
  }
  if (M === 'PUT') {
    const b = await ctx.json(MAX_BODY);
    const t = whole({ id, t: Date.now(), s: b.s, p: b.p, log: b.log });
    if (!t) { // nothing to keep: an empty conversation is not listed
      if (at >= 0) { threads.splice(at, 1); write(key, threads); }
      return send(200, { ok: true, empty: true });
    }
    // only a conversation that got longer or changed counts as used now (opening an old one does not move it up)
    if (at >= 0 && JSON.stringify(threads[at].log) === JSON.stringify(t.log)) t.t = threads[at].t;
    if (at >= 0) threads.splice(at, 1);
    threads.unshift(t);
    threads.sort((x, y) => y.t - x.t);
    write(key, threads.slice(0, MAX_THREADS));
    return send(200, entry(t));
  }
  return false;
}

module.exports = { handle, whole, KEY, ID, MAX_THREADS, DIR };
