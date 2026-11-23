// Claude Code (`claude`): the default provider and the only one that edits files (the Claude panel) and reads PDFs
// and pictures itself. Its calls are made exactly as before lib/ai existed - core.claudeArgs / core.claudeEnv and
// the call sites' own stream parsing - so nothing here builds an argv; lib/ai/index.js hands Claude calls straight
// to core.run / core.spawnTool. The status is the "Claude Code account" one (lib/routes/account.js).
module.exports = {
  id: 'claude',
  label: 'Claude Code',
  name: 'Claude',
  cliName: 'Claude Code',
  bin: 'claude',
  vendor: 'Anthropic',
  caps: { readsPdf: true, readsImage: true, sessions: true, agentic: true, partial: true, inAppLogin: true },
  keyVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  install: {
    mac: 'curl -fsSL https://claude.ai/install.sh | bash',
    linux: 'curl -fsSL https://claude.ai/install.sh | bash',
    win: 'irm https://claude.ai/install.ps1 | iex',
  },
  docs: 'https://code.claude.com/docs/en/setup',
  login: null, // signs in from the app (Claude Code account dialog)
};
