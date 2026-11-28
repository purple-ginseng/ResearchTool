# AI integration

How the optional AI features work: they run an AI command-line tool on your own computer, under your own account.

[Back to the README](../README.md)

## How it works

ResearchTool does not call any AI API itself, holds no API key and never asks for a password. Every AI feature runs
one AI command-line tool installed on your own computer as a child process, signed in with your own account:
Claude Code (`claude`, the default; `claude auth login`, started from the person button in the Claude panel), or -
chosen in Preferences › AI - OpenAI Codex (`codex`), xAI Grok Build (`grok`) or Google Antigravity (`agy`). What that
CLI sends to its provider (Anthropic, OpenAI, xAI or Google), and under which terms, is between you and that account;
ResearchTool sends nothing to any other AI service. Gemini CLI is not offered (see [AI providers](#ai-providers)).

- Feature calls (grouping, briefs, key points, note drafts, diagrams, quizzes, explanations, comparison tables,
  rewrites, related-work drafts) run the CLI non-interactively with no tools, or with reading only where a feature
  must read a PDF or a picture. Each prompt carries the material of that feature (for example the brief, note, key
  points and the matching PDF passages of each paper in a comparison table, not the whole PDF); a token estimate is
  shown before the larger jobs.
- The Claude panel runs a Claude Code session inside your workspace folder with file tools only. With Grok Build or
  Antigravity the panel is a read-only chat; so is Codex's, unless you tick "Let Codex edit files" (off by default):
  then it can change the open LaTeX project and your reading notes, and each project change is recorded in the history.
- Only Claude reads the pages of a PDF itself; the other CLIs get the text extracted from it, so formulas and figures
  in a draft can be weaker. Grok Build does not work with ResearchTool on Windows. How Codex, Grok Build and
  Antigravity are kept read-only and how their output is read follow their published docs and are not yet confirmed
  by real runs with every account type (details under AI providers).
- Apart from filing newly imported papers into categories with a short brief (on by default; switch it off in
  "Group with Claude"), the AI is called only when you use an AI feature.
- Settings shows the calls, tokens and time used per feature over the last 7 days, for every provider.
- What the AI writes is a draft: check it against the paper, as you would a colleague's notes.

Without an AI CLI the app works fully as a library, reader, note-taking tool and LaTeX editor. If something goes
wrong, Help › **Copy diagnostics** gives a redacted text block for a bug report (see [Troubleshooting](troubleshooting.md)).

## Using Claude Code

- **Signing in:** the person button in the Claude panel opens the Claude Code account window. It shows whether the
  `claude` CLI is installed and signed in, and signs in or out through `claude auth login` / `claude auth logout`.
  The sign-in happens on Anthropic's page in your browser; the app never sees a password or token.
- **What it used:** Settings lists, per feature, the calls, tokens and average seconds per call of the last 7 days.
  The text of a PDF is read once and cached, so a question about a paper does not wait for the extraction again.
- **In the app:** the Claude button opens a panel that runs your local `claude` CLI inside `workspace/`
  with file tools only (read/edit/write/search). Edits show up in the editor and preview when it finishes.
  The answer appears while it is written and the send button becomes Stop (Esc). Claude is told the page you are
  on, the passage you selected in the PDF or the editor, and where the open paper's note, text and PDF are.
- **In a terminal:** `cd workspace && claude`. `workspace/CLAUDE.md` explains the data layout to it.
  The app picks up changes when you switch back to the browser window.
- Grouping, key-point extraction and note drafts call `claude -p` with no tools (drafts: the Read tool only).
  Diagrams, quizzes, explanations, comparison tables, rewrites and related work do the same, with no tools ("Ask
  Claude" about a picture of a note may read that one picture). Settings -> "Claude usage" (Economy, Balanced, Best
  quality) sets the effort of these calls, and "How Claude explains" is the instruction added to every explanation.
- Figures are found and cut out of the PDF on this computer (poppler), not by Claude. A draft prompt only carries
  the list of captions (a few hundred tokens), and in the Balanced mode it tells Claude where the main body ends, so
  the pages of the reference list are not read. In the Balanced mode the extracted text of the paper is no longer
  sent along with the pages (it said the same thing twice; about a quarter of the cost of a draft) - only if the
  PDF cannot be read is the draft asked for once more from the text. A crop the app is not sure of (cut at an edge, text inside, two
  figures in one) is never put into a note by itself: its placeholder stays and the Figures list shows it with a
  dashed frame.

## Chat history

Each paper and each project has its own conversations, kept in the workspace (`chats/`) and continued after a reload.
"New chat" starts another conversation about the same paper and the earlier ones stay: the History button of
the panel lists them, and the conversations about your other papers and projects, to read again or go on with.

## AI providers

Every AI feature runs a command-line AI tool installed on your computer and signed in with **your own account**.
Claude Code is the default. Preferences › AI can switch all features to one of the others; the choice is saved in
the workspace (`settings.json` `aiProvider`). ResearchTool never asks for an API key and never stores one, and it never
signs you in or out of these tools - you do that once in a terminal.

| Provider | Command | Install (you run it) | Sign in (you run it) | What works |
| --- | --- | --- | --- | --- |
| Claude Code (default) | `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` | the person button in the panel (`claude auth login`) | everything: the panel can edit your files; drafts read the PDF pages; questions about a picture |
| OpenAI Codex | `codex` | `npm install -g @openai/codex` (or `brew install --cask codex`) | `codex login` (ChatGPT account) | every feature; the panel is read-only unless you tick "Let Codex edit files" (off by default); drafts use the extracted text; questions about a picture (`-i`) |
| xAI Grok Build | `grok` | `curl -fsSL https://x.ai/cli/install.sh \| bash` (Windows: `irm https://x.ai/cli/install.ps1 \| iex`; or `npm install -g @xai-official/grok`) | `grok login` (an xAI / X account; a free tier with usage limits, more with a paid plan) | every feature on macOS and Linux (kernel 5.13+); the panel is read-only; drafts use the extracted text; no questions about a picture; **not on Windows** (see below) |
| Antigravity (Google) | `agy` 1.5.13 or later | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (Windows: `irm https://antigravity.google/cli/install.ps1 \| iex`) | run `agy` once in a terminal and sign in with Google (a **personal Google account** works) | every feature; the panel is read-only; drafts use the extracted text; no questions about a picture. ResearchTool does not check whether you are signed in (that would mean starting agy): it shows at the first call. An older agy is not started - Preferences asks you to run `agy update`. Checked with a real agy 1.5.14 for its flags, its settings and one short turn; the read-only rules are tested only against a fake `agy` so far - see below |

Gemini CLI is not offered: Google ended its personal-account use on 2026-06-18 - with a Google account, use Antigravity.
A workspace that had chosen Gemini CLI opens on Claude Code.

- **Claude Code edits files; Codex can too, when you let it.** Preferences › AI › "Let Codex edit files in the AI
  panel" (Codex only, off by default) lets the Codex panel change files: it then runs in Codex's `workspace-write`
  sandbox, in an empty folder of its own, and the only folders it can write are the open LaTeX project's (inside the
  workspace or an external folder) and your reading notes (`workspace/notes/`). The rest of the workspace stays
  read-only for it - `library.json`, `settings.json`, `pdfs/`, the project history and the backups - so a run that
  goes wrong cannot damage the app's data or what would restore it. Before handing a project folder to the AI, the app
  checks it again (an external folder must still be the one you opened, and never your home folder, a disk or the
  workspace). Its commands get no network, not even `/tmp` or `$TMPDIR`, and approvals are set to never
  (`approval_policy="never"`, so that a refused write should fail at once instead of waiting - set from the help
  texts and docs, **not yet confirmed by a real run**, see [ARCHITECTURE.md](../ARCHITECTURE.md) "To verify with real accounts"). Agent
  files it creates or changes in those folders (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.mcp.json`), which
  later Claude Code or Codex runs would load as instructions or hooks, are put back after the run (a new one goes to
  `trash/ai-agent-files/`). It is told to change only the files you ask about; `library.json` is also copied right
  before each such run (Library › More › Backups… › "List of references only" puts a copy back). Each change to a
  LaTeX project is recorded in the project history as a version by Codex (with the file's earlier content as the
  baseline; a file it deleted keeps its last content there) and can be restored, as with Claude. The feature calls
  of Codex stay read-only either way. **Grok Build and Antigravity are read-only**: their panel is a read-only chat
  and is told it cannot change anything; ask for a change and it shows it as text - so does Codex's when the box is
  not ticked.
  "Find weak claims" works, it only reads. How each CLI is kept read-only:
  - **Codex:** `-s read-only` (its sandbox: no writes, no network for commands), `--ignore-user-config`,
    `--ignore-rules`, no web search, commands get only the core environment variables. Codex reads files only through
    shell commands, so in the panel it can *read* files outside the workspace (no writes, nothing sent anywhere by a
    command). Feature calls have the shell tool switched off. With "Let Codex edit files" the panel (only) runs with
    `-s workspace-write -C <an empty folder of its own>` instead (a resumed conversation:
    `-c sandbox_mode="workspace-write"`), plus `-c sandbox_workspace_write.network_access=false`,
    `exclude_slash_tmp=true`, `exclude_tmpdir_env_var=true` and `--add-dir <project> --add-dir <notes>` (a resume:
    `sandbox_workspace_write.writable_roots`).
  - **Grok Build:** a list of allowed tools (`read_file,grep,list_dir` in the panel, none that can act in feature
    calls), the shell, edit, web and subagent tools removed, `--permission-mode dontAsk`, `--sandbox read-only`, no web
    search, an empty folder of its own with the workspace added (`--add-dir`). Grok's sandbox exists only on macOS
    (Seatbelt) and Linux 5.13+ (Landlock): when Grok reports that the sandbox could not be applied (Windows, an older
    Linux kernel), or that it did not accept the tool list, ResearchTool stops the call and shows why - so **Grok does
    not work with ResearchTool on Windows**.
  - **Antigravity:** session-only settings (`--settings`, never saved) that deny every action of its permission
    system - `command(*)`, `write_file(*)`, `read_url(*)`, `execute_url(*)`, `mcp(*)`, and in feature calls also
    `read_file(*)` - with `toolPermission: "request-review"`; a deny wins over your own allow rules. Plus `--mode plan`,
    `--sandbox` (the OS terminal sandbox), `--disable-slash-commands` and a `--print-timeout`; in print mode agy refuses
    ("soft-denies") whatever would need an approval. Plan mode is **not** a read-only guarantee: agy's changelog says
    headless runs go through plan review automatically, so the deny rules are what is relied on. agy 1.5.14 refuses an
    unknown settings key, and a real agy 1.5.14 accepted these settings and then reported the permission mode
    `request-review`; that each deny rule really refuses its action is taken from the docs and **not yet confirmed by
    a real run**. It runs in an empty folder of its own; the panel adds the workspace with
    `--add-dir` and resumes with `--conversation <id>`. An agy older than 1.5.13 is never started (`agy --version` is
    checked first; before 1.1.18 a valueless `-p` swallowed the next flag and turned the sandbox off, and `-p` goes
    last anyway). ResearchTool also stops a call when agy does not first report a permission mode that asks for
    approval, when a tool step names a file outside the call's folders (your own "Non-Workspace Access" or allow
    rules, hooks or plugins cannot make the panel read `~/.ssh` unnoticed), or when agy says the sandbox, the mode or
    the settings were not applied; these checks follow the docs and changelog and are **not yet tested with a real
    agy** (see [ARCHITECTURE.md](../ARCHITECTURE.md)). Your own agy hooks, plugins and rules (`~/.gemini/config`) still load. Never
    `--dangerously-skip-permissions`, `--mode auto` (which reads outside the workspace without asking) or
    `accept-edits`.
- **PDFs:** only Claude reads the pages of a PDF itself. The others get the text ResearchTool extracts from the PDF
  (with its `[p. N]` page markers, the same size limits as the Economy mode of Claude), so formulas and figures in a
  draft can be weaker. Figures are still placed from the PDF on this computer.
- **Feature calls** (grouping, key points, drafts, diagrams, quizzes, explanations, tables, rewrites) run in a new
  empty folder outside the workspace that is removed afterwards, with the prompt on standard input (Grok: a private
  temporary file; Antigravity: one `{"event":"user",...}` line of `--input-format stream-json`) - never as a
  command-line argument. Codex, Grok and Antigravity also get a low or medium reasoning effort from
  Preferences › AI › usage mode; "Best quality" leaves it to the CLI.
- **Model:** empty means the CLI's own default. You can name a model (and a model for grouping) per provider. (Codex
  ignores `~/.codex/config.toml` here - its model, profiles and MCP servers do not apply; only where it keeps your
  sign-in is read from it.)
- **Environment:** the other CLIs get only what they need from the environment ResearchTool was started with (PATH,
  home and temporary folders, locale, proxy and certificate settings, their own `CODEX_HOME` /
  `GROK_HOME`, `GOOGLE_CLOUD_LOCATION` for Antigravity; and `FAKE_AI_*`, which only the test suite's fake CLIs read).
  Other variables - other tools' tokens, cloud credentials, other providers' keys - never reach them.
- **API keys (optional):** by default no API key from the environment reaches these CLIs, so a call uses the account
  you signed in with. The checkbox "Use an API key from the environment" (off by default, per provider) passes that
  provider's own variables on: `OPENAI_API_KEY` / `CODEX_API_KEY` (Codex), `XAI_API_KEY` / `GROK_CODE_XAI_API_KEY`
  (Grok), `GEMINI_API_KEY` (then with `modelProvider: "gemini"` for that session) / `AGY_ADC_AUTH` / `GOOGLE_APPLICATION_CREDENTIALS` /
  `GOOGLE_CLOUD_QUOTA_PROJECT` (Antigravity). Only that boolean is saved, never a key.
- **Status** (Preferences › AI, the person button in the panel) never calls a model:
  `codex login status` and Grok's stored sign-in (`~/.grok/auth.json`). Antigravity:
  only `agy --version` (whether that uses the network is not known) - ResearchTool does not check the sign-in (that
  would mean starting agy), so it shows as "could not be checked" until the first call (ResearchTool never reads
  `~/.gemini/antigravity*`; it only looks whether `~/.gemini/antigravity-cli` exists, to say whether agy was ever set
  up). A sign-in that has expired shows when a call is made.
- **Usage:** Preferences lists calls and tokens per feature for every provider; a cost is only recorded when the CLI
  reports one (Claude, Grok).
- **Not supported:** signing in from the app for Codex / Grok / Antigravity, file edits for Grok and Antigravity (and for
  Codex unless you tick "Let Codex edit files"), MCP servers for them, community
  "grok" CLIs (API key only), Grok on Windows, and a provider per feature.
- The output formats of Codex and Grok Build, and the sandbox and approval settings of Codex's write mode, were taken
  from their help texts, changelogs and published docs, not from real runs. Antigravity's also come from its docs, checked against one short real turn of agy 1.5.14 (no tool
  step). See [ARCHITECTURE.md](../ARCHITECTURE.md) ("To verify with real accounts") for what real runs must still confirm.
