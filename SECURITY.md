# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository page open **Security › Report a
vulnerability** (a private security advisory). Do not open a public issue for them. Include what you found, how to
reproduce it and which version or commit you used. This is a personal project, so there is no guaranteed response
time, but reports are taken seriously.

## Security model

ResearchTool is a single-user application meant to run on your own computer.

- The server binds to `127.0.0.1` only (`server.js`), so it is not reachable from other machines.
- Every request must carry a `Host` of `localhost`, `127.0.0.1` or `[::1]` with the configured port, and any
  `Origin` header must be one of those addresses; this blocks other web sites and DNS-rebinding attacks. (`[::1]`
  is only accepted as a name: the server listens on IPv4 and is not reachable at `http://[::1]:PORT`.)
  API requests from another site (`Sec-Fetch-Site`) are refused, and every state-changing API call must carry an
  `X-RT: 1` header, which a foreign page cannot send without a preflight the server does not grant.
- The app page is served with a Content-Security-Policy that allows scripts only from the app itself (no inline
  scripts or event-handler attributes), so markup that comes from notes, PDFs or rendered diagrams cannot run code.
- There is no login: anyone who can use your computer account can use the app and read the workspace folder.
- The app stores no passwords, tokens or API keys. Claude Code, the other AI CLIs and git keep their own credentials
  (on macOS, Claude Code and git in the Keychain).
- AI features run one local AI CLI (Claude Code by default, or Codex, Grok Build or Antigravity); see [docs/ai.md](docs/ai.md)
  ("How it works" and "AI providers") for what that involves and how the other CLIs are kept read-only.
  A way around those read-only settings (a provider CLI made to write, run a command or read outside the folders it
  is given) counts as a security problem.
- Help › Copy diagnostics redacts paths, e-mail addresses and keys before copying, but an error message can still
  quote a few words: read the text before posting it in a public issue.

Things that are out of scope: exposing the server on a network interface (for example through a reverse proxy or a
port forward) - the app has no authentication and is not designed for that.
