# Installing and updating

How to install, start and update ResearchTool, what it needs, and the notes for macOS, Linux and Windows.

[Back to the README](../README.md)

## Quick start

You need [Node.js](https://nodejs.org/) 18 or newer and git. There is no `npm install` and no build step: the
server uses only Node's standard library, and the browser libraries (CodeMirror, pdf.js, Vditor and its renderers,
the fonts) are bundled in `public/vendor`, so the app works offline.

**macOS and Linux** (bash, zsh):

```bash
git clone https://github.com/purple-ginseng/ResearchTool.git
cd ResearchTool
node server.js
```

**Windows 10 / 11** (PowerShell):

```powershell
git clone https://github.com/purple-ginseng/ResearchTool.git
cd ResearchTool
node server.js
```

Then open http://localhost:4790. Your data goes to `./workspace` (created on the first start). To keep it elsewhere,
or to run a second copy on another port:

```bash
RT_WORKSPACE=~/ResearchTool-data PORT=4791 node server.js                 # macOS, Linux
```

```powershell
$env:RT_WORKSPACE="$HOME\ResearchTool-data"; $env:PORT=4791; node server.js   # Windows PowerShell
```

(In the Windows command prompt: `set RT_WORKSPACE=%USERPROFILE%\ResearchTool-data` and `set PORT=4791`, then
`node server.js`.) The tools below add PDF import, compiling and the other features; how to install them on each
system is in "macOS, Linux and Windows".

## Updating

ResearchTool is installed with `git clone https://github.com/purple-ginseng/ResearchTool`. A newer version is a
`git pull` in that folder, followed by a restart (`Ctrl+C` in the terminal, then `node server.js` again). Your data
- `workspace/` and the default backup folder `backups/` - is not part of the repository and an update never touches
it.

**Preferences › General › Updates** can do the pull for you:

- **Keep ResearchTool up to date automatically** - off unless you tick it. When ticked, the app asks GitHub a
  little after it starts, and then about once a day while it runs, whether there is a newer version; when there
  is, it downloads and installs the new program code by itself, without asking each time. That is the whole
  decision: with the box ticked, whatever is pushed to the `main` branch of the official repository runs on your
  computer within a day - the new pages at the next reload, the new server code after the next restart. Leave the
  box unticked if you would rather read what changed first.
- **Check for updates now** works with the box unticked too. It asks once and installs nothing; when there is a
  newer version it shows it and offers **Update now**, which downloads and installs it. Pressed within a minute
  of the check, "Update now" installs exactly the version that was shown without asking GitHub again; later it
  asks once more first.
- After an update a notice under the header says "ResearchTool was updated to vX (abc1234). Restart it to finish:
  stop it in the terminal (Ctrl+C) and run node server.js again." and stays until you do. Nothing restarts by
  itself. Until the restart the pages are already the new ones while the server still runs the old code, so
  restart soon. After the restart the notice goes by itself within half a minute; a tab that was open since
  before the update then asks to be reloaded ("ResearchTool was restarted with another version. Reload this
  page to use it.").

An update is only ever a fast-forward of an untouched clone of the official repository. It is not tried - and the
line under the checkbox says why, and what to do - when:

- the folder is not a git clone (it was unpacked from a ZIP file), is a linked work tree or lies inside another
  repository, or git is not installed;
- `origin` is not `github.com/purple-ginseng/ResearchTool` (a fork or any other remote is never updated);
- another branch than `main` is checked out, `main` does not follow `origin/main`, or no branch is (a detached HEAD);
- a tracked file was changed, or a merge, rebase or another git command is under way in the folder;
- the git settings inside the folder (`.git/config`) hold something a plain clone does not have and that would
  make git run a program or go somewhere else: a filter, an include, `http.*` settings, a remote section named
  like an address, a partial clone (`git clone --filter=...`); or `.git/info/attributes` or
  `.git/objects/info/alternates` is in use. A second remote with an ordinary name, your name and e-mail, and what
  editors write there are fine;
- the copy has commits of its own (it is ahead of, or has diverged from, the official `main`);
- your git settings send GitHub addresses somewhere else (`url.….insteadOf`);
- the new version would put a file inside `workspace/` or `backups/`, contains a symbolic link, a submodule or a
  file name that cannot exist on Windows or macOS, needs a newer Node.js (`engines` in its `package.json`), or is
  marked as needing a step by hand (`updateEpoch` in `package.json`).

It never merges, rebases, resets, stashes, cleans or deletes anything, never switches branches, runs no repository
hooks and sends no credentials: the request is an anonymous https `git fetch` of the one address written in
`lib/update.js`. No token header (`http.extraHeader`) or cookie from your git settings goes with it, and the
certificate of github.com is always checked, whatever your git settings say about it; your proxy and your
company's certificates are used as git uses them. Files that git does not track (your workspace, your backups, anything else you keep in the
folder) are left exactly as they are; if the new version has a file where one of yours lies, the update is refused
and names the file. The switch is saved per workspace (`settings.json`, `autoUpdate`), and a restored backup does
not change it. Starting the app with `RT_NO_UPDATE=1` switches every check off, whatever the setting says.

## Requirements

| Tool | Needed for |
| --- | --- |
| Node 18+ (CI runs Node 18, 20 and 24) | the server |
| `pdftotext`, `pdfinfo` (poppler) | PDF import, sentence extraction |
| `pdftotext`, `pdftoppm` (poppler) | finding the figures and tables of a PDF and cutting them out (optional: without them the Figures list says so and everything else works) |
| `latexmk` + a TeX distribution (MacTeX / TeX Live / MiKTeX) | compiling; `synctex` for jumping between source and PDF, `texcount` for the word counts |
| `unzip` (or the `tar` built into Windows 10+ and macOS) | importing a project from a .zip |
| `git` | Overleaf sync |
| one AI CLI: `claude` (default), or `codex`, `grok` or `agy` (Antigravity) - see [AI providers](ai.md#ai-providers) | the Claude panel, automatic grouping and briefs, "Extract with Claude", "Generate first draft", diagrams, quizzes, explanations and translations, comparison tables, rewriting a selection and drafting related work in LaTeX |
| A system word list (`/usr/share/dict/words` or similar) | spell check in the Editor (macOS ships one; on Debian / Ubuntu install `wamerican`; Windows has none, so there this check is off) |
| Internet access (optional) | adding a paper by arXiv id / DOI / link, the Related tab, Lineage, "Check metadata", "Check venues" and "Find links" (see [Privacy](privacy.md)) |

Anything missing only disables its own feature; the app tells you what was not found (the Overview's "Workspace
health" card lists the tools).

## macOS, Linux and Windows

ResearchTool runs on macOS, Linux (tested on Ubuntu) and Windows 10 / 11. The unit tests, a translation check and a
smoke test of the real server run on Ubuntu, macOS and Windows for every push to `main` and every pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)); the badge at the top of the README shows the latest result. The server
starts every tool directly, never through a shell.

- **macOS**: `brew install poppler`; MacTeX (or BasicTeX + `latexmk`); git comes with the Xcode command line tools
  (`xcode-select --install`). Spelling uses the system dictionary.
- **Ubuntu / Debian**: `sudo apt install poppler-utils latexmk texlive-latex-extra unzip git`; for spelling also a
  word list (`sudo apt install wamerican`, which gives `/usr/share/dict/words`). The native folder chooser of macOS is
  replaced by the in-page folder browser.
- **Windows**:
  - poppler: `scoop install poppler`, `choco install poppler` or `conda install -c conda-forge poppler`. The scoop
    and Chocolatey folders are added to the server's PATH by itself; otherwise put poppler's `bin` folder on PATH.
  - TeX: TeX Live (it brings its own Perl) or MiKTeX. MiKTeX's `latexmk.exe` and `texcount.exe` are Perl scripts and
    need a Perl installed separately (for example Strawberry Perl). Switch MiKTeX's "install missing packages on the
    fly" to *Yes* or *No*: when it is set to *Ask*, a compile waits for an answer nobody sees and stops after 180 s.
  - Git for Windows (https://git-scm.com/download/win), for Overleaf sync; its Git Bash runs the Overleaf login
    script. The native `claude` CLI on Windows also needs Git for Windows.
  - The `claude` CLI: the native installer (`claude.exe`) or `npm install -g @anthropic-ai/claude-code` both work.
    Of the `.cmd` files only a standard npm shim is used (its script is run with node); other `.cmd` / `.bat` files
    are never run, because only `cmd.exe` could run them.
  - Of the other AI CLIs, Codex and Antigravity can be used on Windows; Grok Build cannot, because its read-only
    sandbox exists only on macOS and Linux (see [AI providers](ai.md#ai-providers)).
  - A .zip is unpacked with the `tar.exe` built into Windows 10+ when there is no `unzip`.
  - The spelling check is off (Windows has no system word list); the other writing checks work.
  - The folder browser starts in your home folder; go up past `C:\` to "This PC" to reach other drives. The native
    macOS folder chooser is replaced by that browser.
