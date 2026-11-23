// The AI provider (lib/ai): which local CLI the AI features use, and whether each is installed and signed in.
//   GET /api/ai/providers          {current, providers: [{id, label, name, cliName, bin, caps, install, login, docs,
//                                   keyVars, useEnvKey, model, categoryModel}]}
//   GET /api/ai/status[?p=<id>][&fresh=1]   {current, status: {<id>: {installed, version, signedIn: true|false|null,
//                                   account, warning, problem}}} - never a model call; Grok's check is cached 60 s
// The choice itself is saved with PUT /api/settings {aiProvider, aiProviders, aiUseEnvKey} (lib/routes/library.js).
const ai = require('../ai');

async function handle(ctx) {
  const { path: p, method: M, send, query } = ctx;
  if (!p.startsWith('/api/ai/')) return false;
  if (p === '/api/ai/providers' && M === 'GET') return send(200, ai.info());
  if (p === '/api/ai/status' && M === 'GET') {
    const one = query.get('p'), fresh = query.get('fresh') === '1';
    if (one && !ai.IDS.includes(one)) return send(400, { error: 'Unknown AI provider' });
    const status = one ? { [one]: await ai.status(one, { fresh }) } : await ai.statusAll({ fresh });
    return send(200, { current: ai.currentId(), status });
  }
  return false;
}

module.exports = { handle };
