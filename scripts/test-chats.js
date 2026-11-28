#!/usr/bin/env node
// Tests for the kept conversations of the AI panel (lib/routes/chats.js): several conversations per paper or
// project in <workspace>/chats/, the list (most recently used first, no message text), saving (only whole messages,
// bounded, an unchanged one does not move up), the addresses that are refused, deleting, and a file that was edited
// by hand. The workspace is a temporary folder; no AI tool is started.
// Run:  node scripts/test-chats.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-chats-'));
process.env.RT_WORKSPACE = WS;
process.env.RT_NO_UPDATE = '1';
const chats = require('../lib/routes/chats');

// one request to the route module, the way the router calls it
async function call(method, url, body) {
  let out = null;
  const seg = url.split('/').filter(Boolean).map(decodeURIComponent);
  const ctx = { method, path: '/' + seg.join('/'), segments: seg, json: async () => body || {}, send: (code, data) => { out = { code, data }; return true; } };
  try { const handled = await chats.handle(ctx); return handled ? out : { code: 404 }; }
  catch (e) { return { code: e.status || 500, error: e.message }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('several conversations per paper: saved, listed newest first, read back whole', async () => {
  assert.deepEqual((await call('GET', '/api/chats')).data, []);
  const a = await call('PUT', '/api/chats/item:p1/aaaaaaaaaaaa', { s: '0123abcd-0000', p: 'claude', log: [['user', '  What is\nthe idea? '], ['bot', 'X.'], ['weird', 'no'], ['bot', ''], 'junk'] });
  assert.equal(a.code, 200); assert.equal(a.data.title, 'What is the idea?'); assert.equal(a.data.n, 1);
  await sleep(5);
  await call('PUT', '/api/chats/item:p1/bbbbbbbbbbbb', { p: 'codex', log: [['user', 'Second'], ['bot', 'B'], ['user', 'Third']] });
  await sleep(5);
  await call('PUT', '/api/chats/project:w1/cccccccccccc', { log: [['user', 'About the draft']] });
  await call('PUT', '/api/chats/general/dddddddddddd', { log: [['tool', '▸ note'], ['user', 'General']] });
  const list = (await call('GET', '/api/chats')).data;
  assert.deepEqual(list.map((x) => x.key).sort(), ['general', 'item:p1', 'project:w1']);
  const p1 = list.find((x) => x.key === 'item:p1');
  assert.deepEqual(p1.threads.map((t) => [t.id, t.title, t.n, t.p]), [['bbbbbbbbbbbb', 'Second', 2, 'codex'], ['aaaaaaaaaaaa', 'What is the idea?', 1, 'claude']]);
  assert.ok(!JSON.stringify(list).includes('"log"'), 'the list carries no messages');
  const full = (await call('GET', '/api/chats/item:p1/aaaaaaaaaaaa')).data;
  assert.deepEqual(full.log, [['user', '  What is\nthe idea? '], ['bot', 'X.']]);
  assert.equal(full.s, '0123abcd-0000');
  assert.deepEqual(fs.readdirSync(path.join(WS, 'chats')).sort(), ['general.json', 'item-p1.json', 'project-w1.json']);
});

test('an unchanged conversation does not move up; a longer one does; an emptied one is gone', async () => {
  const before = (await call('GET', '/api/chats/item:p1/aaaaaaaaaaaa')).data;
  await sleep(5);
  await call('PUT', '/api/chats/item:p1/aaaaaaaaaaaa', { s: before.s, log: before.log });
  assert.equal((await call('GET', '/api/chats/item:p1/aaaaaaaaaaaa')).data.t, before.t);
  await call('PUT', '/api/chats/item:p1/aaaaaaaaaaaa', { s: before.s, log: [...before.log, ['user', 'More']] });
  const list = (await call('GET', '/api/chats')).data.find((x) => x.key === 'item:p1').threads;
  assert.equal(list[0].id, 'aaaaaaaaaaaa'); assert.equal(list[0].n, 2);
  assert.equal((await call('PUT', '/api/chats/item:p1/bbbbbbbbbbbb', { log: [] })).data.empty, true);
  assert.equal((await call('GET', '/api/chats/item:p1/bbbbbbbbbbbb')).code, 404);
});

test('limits: long messages are shortened, old messages and old conversations are dropped', async () => {
  const big = 'x'.repeat(30000);
  await call('PUT', '/api/chats/item:big/aaaaaaaaaaaa', { log: [['user', 'q'], ['bot', big], ...Array.from({ length: 400 }, (_, i) => ['user', 'm' + i])] });
  const t = (await call('GET', '/api/chats/item:big/aaaaaaaaaaaa')).data;
  assert.equal(t.log.length, 300); assert.equal(t.log[299][1], 'm399');
  await call('PUT', '/api/chats/item:big/bbbbbbbbbbbb', { log: [['bot', big]] });
  assert.ok((await call('GET', '/api/chats/item:big/bbbbbbbbbbbb')).data.log[0][1].length < 20100);
  for (let i = 0; i < chats.MAX_THREADS + 5; i++) await call('PUT', '/api/chats/item:many/' + ('t' + i).padEnd(12, 'x'), { log: [['user', 'q' + i]] });
  assert.equal((await call('GET', '/api/chats')).data.find((x) => x.key === 'item:many').threads.length, chats.MAX_THREADS);
});

test('addresses that are not a paper, a project or "general" are refused; nothing is written outside the folder', async () => {
  for (const key of ['item:../x', 'item:', 'other:abc', 'item:a/b', '..', 'general:x', 'item:' + 'a'.repeat(90)]) {
    const r = await call('PUT', '/api/chats/' + encodeURIComponent(key) + '/aaaaaaaaaaaa', { log: [['user', 'x']] });
    assert.equal(r.code, 400, key);
  }
  for (const id of ['AAAAAAAAAAAA', 'short', '../aaaaaaaa', 'a'.repeat(30)]) assert.equal((await call('PUT', '/api/chats/item:p1/' + encodeURIComponent(id), { log: [['user', 'x']] })).code, 400, id);
  assert.equal((await call('GET', '/api/chats/item:p1/aaaaaaaaaaaa/more')).code, 400);
  assert.ok(fs.readdirSync(WS).every((n) => n !== 'x.json'));
  assert.ok(fs.readdirSync(path.join(WS, 'chats')).every((n) => /^(general|item-[\w.-]+|project-[\w.-]+)\.json$/.test(n)));
});

test('deleting one conversation or all of a paper; a file edited by hand is read as far as it is whole', async () => {
  await call('DELETE', '/api/chats/item:p1/aaaaaaaaaaaa');
  assert.ok(!(await call('GET', '/api/chats')).data.some((x) => x.key === 'item:p1'), 'the last one gone: the paper is not listed');
  assert.ok(!fs.existsSync(path.join(WS, 'chats', 'item-p1.json')));
  await call('DELETE', '/api/chats/item:many');
  assert.ok(!(await call('GET', '/api/chats')).data.some((x) => x.key === 'item:many'));
  assert.equal((await call('DELETE', '/api/chats/item:never/aaaaaaaaaaaa')).code, 200);
  fs.writeFileSync(path.join(WS, 'chats', 'item-hand.json'), JSON.stringify({ threads: [{ id: 'aaaaaaaaaaaa', t: 5, log: [['user', 'ok']] }, { id: 'BAD', log: [['user', 'x']] }, { id: 'bbbbbbbbbbbb', log: 'nope' }, null] }));
  fs.writeFileSync(path.join(WS, 'chats', 'item-broken.json'), '{not json');
  fs.writeFileSync(path.join(WS, 'chats', 'notes.txt'), 'x');
  const list = (await call('GET', '/api/chats')).data;
  assert.deepEqual(list.find((x) => x.key === 'item:hand').threads.map((t) => t.id), ['aaaaaaaaaaaa']);
  assert.ok(!list.some((x) => x.key === 'item:broken'));
});

(async () => {
  for (const [name, fn] of tests) {
    n++;
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 10).join('\n     ')); }
  }
  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\n${n - failed} of ${n} passed`);
  process.exit(failed ? 1 : 0);
})();
