// AiChild: runs one call of a non-Claude CLI (codex / grok / agy) and looks to its caller exactly like a `claude -p`
// child process: it has stdin / stdout / stderr, pid, exitCode, kill() and the 'error' and 'close' events, and its
// stdout carries Claude's own output format - one JSON result envelope (--output-format json) or Claude's stream-json
// lines (system/init, stream_event text deltas, assistant messages, tool_use, result). That way the features keep the
// one parser they have and the Claude path stays exactly what it was; each provider module only maps its CLI's
// format to the few normalised events below.
//   normalised events (providers/*.js -> here): {type:'session', id} {type:'delta', text} {type:'message', text}
//     {type:'thinking'} {type:'tool', name, detail} {type:'final', isError, error, usage: {in, cached, out}, usd}
// The prompt is taken from what the caller writes to stdin and handed on as stdin, or for Grok as a private file -
// never as an argument. Feature calls run in a new empty folder <os temp>/researchtool-ai-*/run/run-* (lib/ai/index.js),
// removed afterwards. Never a shell: lib/platform.js spawnTool.
// A provider can name stderr lines that mean its safety settings are not in effect (provider.unsafe(stderr) -> a
// message): the run is stopped at once and reported as an error, never answered (Grok without its sandbox). The same
// when its line parser sets st.unsafe (Antigravity: no init with a permission mode that asks, a tool step outside the
// folders of the call). From then on nothing more of that run reaches the caller (no delta, no message, no result
// text). A provider with a minimum version (p.minVersion) is first checked by deps.gate (lib/ai/index.js: `<bin>
// --version`, cached); below it the CLI is never started.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

class AiChild extends EventEmitter {
  constructor(provider, opts, deps) {
    super();
    this.provider = provider; this.opts = opts; this.deps = deps; // deps: {spawnTool, killTree, env(), tmpRoot, onRetry}
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.pid = undefined; this.exitCode = null; this.signalCode = null; this.killed = false;
    this.real = null; this.started = false; this.t0 = Date.now();
    const chunks = [];
    this.stdin = new Writable({ write(c, enc, cb) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, enc)); cb(); } });
    this.stdin.on('finish', () => this._start(Buffer.concat(chunks).toString('utf8')));
  }

  kill(signal) {
    this.killed = true;
    if (this.real) { this.deps.killTree(this.real, { signal: signal || 'SIGKILL' }); return true; }
    if (!this.started) { this.started = true; process.nextTick(() => this._close(null, signal || 'SIGKILL')); }
    // (while the version check runs: closed when it returns, the CLI is never started)
    return true;
  }

  _start(input) {
    if (this.started) return;
    this.started = true;
    const o = this.opts, p = this.provider;
    const sys = o.system ? `<instructions>\n${o.system}\n</instructions>\n\n` : '';
    this.text = sys + input;
    try {
      fs.mkdirSync(this.deps.tmpRoot, { recursive: true });
      this.tmp = fs.mkdtempSync(path.join(this.deps.tmpRoot, 'run-'));
      try { fs.chmodSync(this.tmp, 0o700); } catch { /* Windows */ }
      if (p.promptFile) { this.promptFile = path.join(this.tmp, 'prompt.txt'); fs.writeFileSync(this.promptFile, this.text, { mode: 0o600 }); }
    } catch (e) { return this._fail(e); }
    if (!this.deps.gate || !p.minVersion) return this._launch();
    this.gating = true;
    Promise.resolve().then(() => this.deps.gate(p)).then((msg) => msg, (e) => `${p.name}: ${String(e && e.message || e).slice(0, 200)}`).then((msg) => {
      this.gating = false;
      if (this.killed) return this._close(null, 'SIGKILL');
      if (msg) return this._refuse(msg);
      this._launch();
    });
  }
  // the CLI is not started: an error result in Claude's format, as if it had failed
  _refuse(msg) {
    this.st = { errors: [], session: null, usage: null, final: null, blocks: [], block: null, sentInit: false };
    this.unsafe = msg;
    this._finish(1, null, '', '');
  }

  _launch() {
    const o = this.opts, p = this.provider;
    const cwd = o.mode === 'chat' ? o.cwd : this.tmp;
    this.st = { errors: [], session: null, usage: null, final: null, blocks: [], block: null, sentInit: false,
      // the folders this call may touch (Antigravity checks every path a tool step names against them)
      cwd, roots: o.mode === 'chat' ? [cwd, ...(o.addDirs || [])] : [this.tmp] };
    let child;
    try { child = this.deps.spawnTool(p.bin, p.args({ ...o, cwd, promptFile: this.promptFile, effort: this.noEffort ? '' : o.effort }), { cwd, env: this.deps.env() }); }
    catch (e) { return this._fail(e); }
    this.real = child; this.pid = child.pid;
    const fmt = p.format(!!o.stream || o.mode === 'chat');
    let buf = '', all = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (this.unsafe) return; // stopped: nothing more of this run is read
      if (fmt === 'json') { all += d; return; }
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { all += line + '\n'; continue; }
        p.line(ev, this.st, (e) => this._event(e));
        // the CLI's own output says the read-only setup is not in effect (Antigravity's init.permission_mode)
        if (this.st.unsafe && !this.unsafe) { this.unsafe = this.st.unsafe; this.deps.killTree(child, { signal: 'SIGKILL' }); return; }
      }
    });
    child.stderr.on('data', (d) => {
      if (err.length < 20000) err += d;
      const bad = !this.unsafe && p.unsafe ? p.unsafe(err) : null;
      if (bad) { this.unsafe = bad; this.deps.killTree(child, { signal: 'SIGKILL' }); }
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { this.errored = true; this.emit('error', e); });
    child.on('close', (code, signal) => {
      if (fmt !== 'json' && buf.trim() && !this.unsafe) {
        try { p.line(JSON.parse(buf), this.st, (e) => this._event(e)); } catch { all += buf; }
        if (this.st.unsafe && !this.unsafe) this.unsafe = this.st.unsafe; // (a bad last line without a newline)
      }
      if (fmt === 'json' && all.trim() && !this.unsafe) {
        let j = null;
        try { j = JSON.parse(all); } catch { const m = /\{[\s\S]*\}\s*$/.exec(all); if (m) { try { j = JSON.parse(m[0]); } catch { /* not JSON */ } } }
        if (j) p.json(j, this.st, (e) => this._event(e));
      }
      // an unknown config key for the effort: once more without it
      if (!this.killed && !this.errored && !this.unsafe && !this.st.final && !this.noEffort && o.effort && p.retryWithoutEffort && p.retryWithoutEffort(err)) {
        this.noEffort = true; if (this.deps.onRetry) this.deps.onRetry(p.id);
        return this._launch();
      }
      this._finish(code, signal, err, all);
    });
    const stdin = p.stdin(this.text);
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  }

  // ---- normalised events -> Claude's stream-json ----
  _out(o) { if (this.opts.stream || this.opts.mode === 'chat') this.stdout.write(JSON.stringify(o) + '\n'); }
  _event(e) {
    if (this.unsafe || (this.st && this.st.unsafe)) return; // (a stderr notice or the line parser stopped the run: nothing more is passed on)
    const st = this.st, partial = !!(this.opts.partial || this.opts.mode === 'chat');
    if (e.type === 'session') {
      st.session = e.id;
      if (!st.sentInit) { st.sentInit = true; this._out({ type: 'system', subtype: 'init', session_id: e.id }); }
    } else if (e.type === 'delta') {
      if (st.block == null) { st.block = ''; if (partial) this._out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }); }
      st.block += e.text;
      if (partial && e.text) this._out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: e.text } } });
    } else if (e.type === 'message') {
      this._flush();
      if (e.text) { st.blocks.push(e.text); this._out({ type: 'assistant', message: { content: [{ type: 'text', text: e.text }] } }); }
    } else if (e.type === 'thinking') {
      if (partial && st.block == null) this._out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } });
    } else if (e.type === 'tool') {
      this._flush();
      this._out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: e.name, input: { file_path: e.detail || '' } }] } });
    } else if (e.type === 'final') { this._flush(); st.final = e; }
  }
  _flush() {
    const st = this.st;
    if (st.block == null) return;
    const t = st.block; st.block = null;
    if (this.opts.partial || this.opts.mode === 'chat') this._out({ type: 'stream_event', event: { type: 'content_block_stop' } });
    if (t) { st.blocks.push(t); this._out({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }); }
  }

  _finish(code, signal, err, out) {
    const st = this.st, p = this.provider;
    this._flush();
    if (!this.killed && !this.errored) {
      let f = st.final, text = st.blocks.length ? st.blocks[st.blocks.length - 1] : '';
      let isError, error, lost = false;
      if (this.unsafe) { isError = true; error = this.unsafe; text = ''; st.blocks = []; }
      else if (f && !f.isError && text) { isError = false; }
      else if (f && f.isError) { const r = p.failure({ code, err: `${f.error || ''}\n${err}`, out, resumed: !!this.opts.session, st }); isError = true; error = f.error || r.text; lost = !!r.lost; }
      else if (f && !text) { isError = true; error = `${p.name} returned an empty answer.`; }
      else { const r = p.failure({ code, err, out, resumed: !!this.opts.session, st }); isError = true; error = r.text; lost = !!r.lost; if (code === 0 && !st.errors.length && !r.lost) error = `${p.name} returned no answer that ResearchTool could read (exit code ${code}). ${String(out || err).replace(/\s+/g, ' ').trim().slice(0, 200)}`.trim(); }
      const u = (f && f.usage) || st.usage || {};
      const env = { type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result: isError ? error : text, session_id: st.session || this.opts.session || null,
        usage: { input_tokens: u.in || 0, cache_read_input_tokens: u.cached || 0, output_tokens: u.out || 0 }, duration_ms: Date.now() - this.t0, _provider: p.id };
      if (f && Number.isFinite(Number(f.usd)) && f.usd != null) env.total_cost_usd = Number(f.usd);
      if (lost) env.lost = true;
      this.result = env;
      if (this.opts.stream || this.opts.mode === 'chat') this._out(env); else this.stdout.write(JSON.stringify(env));
      this.code = isError ? (code || 1) : 0;
    } else this.code = code;
    if (err) this.stderr.write(err);
    this._close(this.code, signal);
  }
  _fail(e) {
    this.errored = true;
    process.nextTick(() => { this.emit('error', e); this._close(-2, null); });
  }
  _close(code, signal) {
    if (this.closed) return;
    this.closed = true;
    if (this.tmp) { try { fs.rmSync(this.tmp, { recursive: true, force: true }); } catch { /* removed at the next start */ } }
    this.exitCode = code; this.signalCode = code == null ? (signal || 'SIGKILL') : null;
    this.stdout.end(); this.stderr.end();
    // after the stdout data has been read by the caller's 'data' handler
    setImmediate(() => this.emit('close', code, signal || null));
  }
}

module.exports = { AiChild };
