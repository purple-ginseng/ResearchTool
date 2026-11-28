// The natural voice: reading aloud with a neural model that runs on this computer (lib/voice/; UI: Preferences ›
// General › Speech and public/js/speech.js). Optional: nothing is fetched until the user asks for it.
//   GET    /api/voice/status   { supported, reason, installed, partial, bytes, installing, done, total, problem, loaded, rate,
//                                voices: [{id, lang}], defaults: {'zh-CN', 'en-US'} } - no network, starts nothing
//   POST   /api/voice/install  starts the download in the background (about 800 MB; the status shows the progress)
//   POST   /api/voice/cancel   stops a running download (what is there is kept and continued next time)
//   DELETE /api/voice          removes the engine and the model again
//   POST   /api/voice/speak {text, lang: 'zh-CN' | 'en-US', voice?, stream?}  the audio: 16-bit mono samples (little
//                              endian) at 24 kHz, Content-Type audio/L16 - as it is made, or with {stream: false}
//                              all of it at the end, decoded in one go. Closing the request stops the work.
// `problem` and the error codes are words (offline, hash, disk, gpu, engine ...): the page holds the sentences.
// Text is only ever turned into sound: it never reaches a shell, a file name or the network.
const core = require('../core');
const voice = require('../voice');

const MAX_TEXT = 1200; // characters of one request (the page sends a sentence or two at a time)

const makeHandle = (v) => async function handle(ctx) {
  const { path: p, method: M, send, res } = ctx;
  if (!p.startsWith('/api/voice')) return false;
  if (p === '/api/voice/status' && M === 'GET') return send(200, v.status());
  if (p === '/api/voice/install' && M === 'POST') {
    try { return send(200, v.install()); } catch (e) { throw core.httpErr(409, 'The natural voice cannot be installed on this computer.', { code: e.code || 'failed' }); }
  }
  if (p === '/api/voice/cancel' && M === 'POST') return send(200, v.cancelInstall());
  if (p === '/api/voice' && M === 'DELETE') return send(200, await v.remove());
  if (p === '/api/voice/speak' && M === 'POST') {
    const b = await ctx.json(64 * 1024);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > MAX_TEXT) throw core.httpErr(400, 'text must be 1 to ' + MAX_TEXT + ' characters');
    if (!voice.LANGS.has(b.lang)) throw core.httpErr(400, 'lang must be zh-CN or en-US');
    if (b.voice != null && typeof b.voice !== 'string') throw core.httpErr(400, 'voice must be a name');
    if (b.stream != null && typeof b.stream !== 'boolean') throw core.httpErr(400, 'stream must be true or false');
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let begun = false;
    try {
      await v.speak({ text, lang: b.lang, voice: b.voice || '', stream: b.stream !== false }, (pcm) => {
        if (res.destroyed) return;
        if (!begun) { begun = true; res.writeHead(200, { 'Content-Type': 'audio/L16; rate=24000; channels=1', 'Cache-Control': 'no-store' }); }
        res.write(pcm);
      }, ac.signal);
    } catch (e) {
      if (begun || res.destroyed) { res.destroy(); return true; }
      const code = typeof e.code === 'string' ? e.code : 'failed';
      throw core.httpErr(code === 'missing' ? 409 : 500, 'The natural voice could not speak.', { code });
    }
    if (!begun) res.writeHead(200, { 'Content-Type': 'audio/L16; rate=24000; channels=1', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  return false;
};

const service = voice.create();
process.on('exit', () => service.stop());

module.exports = { handle: makeHandle(service), makeHandle, service };
