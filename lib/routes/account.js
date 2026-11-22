// Claude Code account (the "Claude Code account" dialog, public/js/account.js): is the local `claude` CLI installed
// and signed in, and signing in / out through the CLI's own `claude auth` commands. The app never sees a password
// or a token: the CLI opens the sign-in page in the browser and stores the login itself (the macOS Keychain, or the
// CLI's own credentials file elsewhere).
//   GET   /api/claude/auth              { installed, version, loggedIn, authMethod, email, orgName, subscriptionType, apiProvider, signingIn }
//   POST  /api/claude/auth/login {method: 'claudeai' | 'console'}   -> NDJSON stream:
//           {type:'url', url} (the sign-in page) | {type:'prompt'} (the CLI waits for the code the page shows)
//           | {type:'text', text} | {type:'done', ok, status}       closing the response cancels the sign-in
//   POST  /api/claude/auth/code {code}  hand the code from the sign-in page to the waiting CLI
//   POST  /api/claude/auth/logout       { status }
const core = require('../core');
const { WS, run, claudeEnv, httpErr } = core;

const LOGIN_TIMEOUT = 10 * 60 * 1000;
let login = null; // the running `claude auth login`: { child, waiting }

async function status() {
  const v = await run('claude', ['--version'], { env: claudeEnv(), timeout: 15000 });
  // problem: a claude that exists but cannot be started without a shell (a non-npm .cmd on Windows), said in words
  if (v.code !== 0) return { installed: false, loggedIn: false, signingIn: false, ...(/EUNSAFECMD|command shell/.test(v.err) ? { problem: v.err.trim().slice(0, 400) } : {}) };
  const out = { installed: true, version: (v.out.match(/\d+\.\d+\.\d+/) || [''])[0], loggedIn: false, authMethod: 'none', signingIn: !!login };
  const r = await run('claude', ['auth', 'status', '--json'], { cwd: WS, env: claudeEnv(), timeout: 20000 }); // exits 1 when signed out
  try {
    const j = JSON.parse(r.out);
    const s = (x) => (typeof x === 'string' ? x.slice(0, 200) : '');
    Object.assign(out, { loggedIn: j.loggedIn === true, authMethod: s(j.authMethod) || 'none', email: s(j.email), orgName: s(j.orgName), subscriptionType: s(j.subscriptionType), apiProvider: s(j.apiProvider) });
  } catch { out.unknown = true; } // an older CLI without `auth status`
  return out;
}

function startLogin(res, method) {
  if (login) throw httpErr(409, 'A sign-in is already in progress');
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const emit = (o) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };
  let child;
  try { child = core.spawnTool('claude', ['auth', 'login', method === 'console' ? '--console' : '--claudeai'], { cwd: WS, env: claudeEnv() }); }
  catch (e) { emit({ type: 'done', ok: false, text: 'Could not start the claude CLI: ' + e.message }); return res.end(); }
  const me = login = { child, waiting: false };
  const timer = setTimeout(() => { if (child.exitCode == null) core.killTree(child, { signal: 'SIGTERM' }); }, LOGIN_TIMEOUT);
  child.stdin.on('error', () => {});
  let sentUrl = false, tail = '', lastErr = '';
  const textLine = (line, isErr) => {
    const l = line.trim();
    if (!l || /https?:\/\//.test(l) || /paste (the )?code/i.test(l)) return;
    if (isErr) lastErr = l.slice(0, 300);
    emit({ type: 'text', text: l.slice(0, 300) });
  };
  const reader = (isErr) => { let buf = ''; const r = (d) => onData(d, (text) => { // whole lines only: a line may arrive in two chunks
    buf += text;
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { textLine(buf.slice(0, nl), isErr); buf = buf.slice(nl + 1); }
    if (buf.length > 4000) buf = '';
  }); r.flush = () => { textLine(buf, isErr); buf = ''; }; return r; };
  const onData = (d, lines) => {
    const text = String(d).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // no colour codes
    tail = (tail + text).slice(-6000);
    const url = !sentUrl && (tail.match(/https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/) || [])[0];
    // the address may arrive in two chunks: wait for the white space that ends it
    if (url && /\s/.test(tail.slice(tail.indexOf(url) + url.length, tail.indexOf(url) + url.length + 1))) { sentUrl = true; emit({ type: 'url', url }); }
    if (!me.waiting && /paste (the )?code/i.test(tail)) { me.waiting = true; emit({ type: 'prompt' }); }
    lines(text);
  };
  const rOut = reader(false), rErr = reader(true);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); // whole characters, also when a chunk ends inside one
  child.stdout.on('data', rOut);
  child.stderr.on('data', rErr);
  const finish = async (ok, text) => {
    if (login !== me) return;
    login = null; clearTimeout(timer);
    let st = null;
    try { st = await status(); } catch { /* reported as not signed in */ }
    emit({ type: 'done', ok: !!(ok && st && st.loggedIn), status: st, text });
    if (!res.writableEnded) res.end();
  };
  child.on('error', (e) => finish(false, 'Could not start the claude CLI: ' + e.message));
  child.on('close', (code) => { rOut.flush(); rErr.flush(); finish(code === 0, code === 0 ? '' : lastErr || 'The sign-in did not finish.'); });
  res.on('close', () => { // the dialog was closed or the page reloaded: cancel
    if (login === me) { login = null; clearTimeout(timer); }
    if (child.exitCode == null) core.killTree(child, { signal: 'SIGTERM' });
  });
}

async function handle(ctx) {
  const { path: p, method: M, send, res } = ctx;
  if (!p.startsWith('/api/claude/auth')) return false;
  if (p === '/api/claude/auth' && M === 'GET') return send(200, await status());
  if (p === '/api/claude/auth/login' && M === 'POST') { const b = await ctx.json(); startLogin(res, b && b.method); return true; }
  if (p === '/api/claude/auth/code' && M === 'POST') {
    const code = String((await ctx.json()).code || '').trim();
    if (!login || login.child.exitCode != null) throw httpErr(409, 'No sign-in is waiting for a code - start again.');
    if (!code || code.length > 4000 || /[\r\n\0]/.test(code)) throw httpErr(400, 'That does not look like the code from the sign-in page.');
    login.child.stdin.write(code + '\n'); // never logged or stored
    return send(200, { ok: true });
  }
  if (p === '/api/claude/auth/logout' && M === 'POST') {
    if (login) throw httpErr(409, 'A sign-in is in progress');
    const r = await run('claude', ['auth', 'logout'], { cwd: WS, env: claudeEnv(), timeout: 30000 });
    if (r.code !== 0) throw httpErr(502, 'claude auth logout failed: ' + (r.err || r.out).slice(0, 300));
    return send(200, { status: await status() });
  }
  return false;
}

module.exports = { handle };
