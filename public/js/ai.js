/* The AI provider of the app (lib/ai on the server): Claude Code by default, or OpenAI Codex, xAI Grok
   Build or Google Antigravity (agy) - each the user's own CLI, signed in with their own account. Chosen in Preferences › AI.
   RT.ai = { id(), name(), nameOf(id), provider(), providers(), caps(), isClaude(), refresh() -> Promise, status(id?, fresh?) -> Promise,
             preview(id | null), ready (Promise) }      emits 'ai:changed' with the provider when it is known or changes.
   The UI text of the code says "Claude"; with another provider chosen the display layer (i18n.js setBrand) shows its
   name instead, in English and Chinese alike. */
(() => {
  const RT = window.RT;
  const CLAUDE = { id: 'claude', name: 'Claude', label: 'Claude Code', cliName: 'Claude Code', bin: 'claude', caps: { readsPdf: true, readsImage: true, sessions: true, agentic: true, partial: true, inAppLogin: true } };
  let info = { current: 'claude', providers: [CLAUDE] };
  const provider = () => info.providers.find((p) => p.id === info.current) || CLAUDE;
  function brandOf(p) { return p.id === 'claude' ? null : { name: p.name, cliName: p.cliName, bin: p.bin }; }
  // preview(id): show that provider's name on the page for now (Preferences, before Save); preview(null): back
  function preview(id) {
    const p = id ? info.providers.find((x) => x.id === id) : null;
    const i18n = window.RTI18n || RT.i18n;
    if (i18n && i18n.setBrand) i18n.setBrand(brandOf(p || provider()));
  }
  function apply() {
    const p = provider();
    document.documentElement.dataset.ai = p.id;
    const i18n = window.RTI18n || RT.i18n;
    if (i18n && i18n.setBrand) i18n.setBrand(brandOf(p));
    RT.emit('ai:changed', p);
  }
  async function refresh() {
    try { const j = await RT.api('/api/ai/providers'); if (j && Array.isArray(j.providers)) info = j; } catch { /* an older server: Claude */ }
    apply();
    return info;
  }
  RT.ai = {
    id: () => provider().id,
    name: () => provider().name,
    // the name of provider `id` (a saved `by`): 'Claude' for none - what was saved before there were other providers
    nameOf: (id) => { const p = id && info.providers.find((x) => x.id === id); return p ? p.name : id === 'claude' || !id ? 'Claude' : String(id); },
    provider,
    providers: () => info.providers,
    caps: () => provider().caps || {},
    isClaude: () => provider().id === 'claude',
    refresh,
    preview,
    status: (id, fresh) => RT.api('/api/ai/status' + (id ? `?p=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}` : fresh ? '?fresh=1' : '')),
  };
  RT.ai.ready = refresh();
})();
