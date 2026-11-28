# Troubleshooting

What to do when something does not work, and how to report a bug.

[Back to the README](../README.md)

## Reporting a bug

- **Reporting a bug:** Help (the question-mark button) › **Copy diagnostics**, or ⌘K / Ctrl+K and "Copy diagnostics",
  copies a plain-text block to paste into the report: the app version and commit, the OS, Node and browser, the
  display language, the AI provider with its CLI's version and whether it is installed and signed in, which helper
  programs were found (pdftotext, latexmk, git, unzip), the state of the updates (on or off, why this copy cannot
  update itself, the last check, whether a restart is waiting), and the last errors of the page and of the AI calls. It runs
  no AI call and reads no paper, note or library file. Before it is copied, the workspace path is written
  `<workspace>`, an external LaTeX project `<project>`, the backup folder `<backup>`, home folders `~` / `<home>`,
  drives and shares `<volume>` / `<share>`, e-mail addresses `<email>`, the user name in a proxy address `<user>`,
  API keys and tokens `<secret>`, and a quoted piece of a page error `"<text>"`. An error message can still name a
  paper or quote a few words, so please read the text before you post it. If the browser does not allow the
  clipboard, a window shows the text, selected, to copy by hand. Help › Copy diagnostics also belongs in the bug
  report form on GitHub.

## AI features

- **The Claude panel works, but drafts, quizzes, diagrams and other AI features fail:** an older Claude Code that does
  not know an option of the feature calls (`--effort`, `--setting-sources` ...). ResearchTool then repeats the call
  once with the options the panel uses and keeps doing so (the server log says so once) until the Claude Code
  version changes - after `claude update` the normal options come back by themselves within a minute, no restart
  needed. The allowed tools (`--tools`, `--allowedTools`) and `--strict-mcp-config` stay the same, but - as in the
  Claude panel - these calls then load your Claude Code settings: your and the workspace's hooks run on them (and see
  the prompt, which holds paper and note text), your permission rules apply, `~/.claude/CLAUDE.md` and the
  workspace's `CLAUDE.md` are read together with Claude Code's full system prompt (some thousand more input tokens
  per call), and each call is kept as a session (`claude --resume` lists them, in `~/.claude/projects`). A question
  about a picture is never asked that way (it relies on Claude's default permissions to read that one file only): it
  says to update instead. When even the compatible options are refused, the feature says 'Claude Code needs an
  update: run "claude update", then try again. Your version (X) does not support an option ResearchTool uses.' -
  run `claude update` in a terminal. A Claude Code that only refuses an `--effort` level (for example the one of
  your own Claude Code settings in "Best quality" mode) just gets the call without `--effort`.

## Reader and PDF tools

- **A click in the reader does nothing:** if the open paper is no longer in the list the Library holds (after a
  reload of the library elsewhere), the reader reloads the library once; if the paper is still missing it says
  "This paper is no longer in the library view - reopen it from the list". An unexpected error inside a click is
  shown as a message and kept for Copy diagnostics.
- **Windows: "pdftotext failed: it crashed (Windows status 0x...)":** the poppler program itself crashed or could not
  start, usually a broken install or a second, older poppler found first on PATH (`where pdftotext` lists them).
  Reinstall it (`scoop install poppler`, `choco install poppler` or conda) and remove the other copy from PATH.

## Updates

- **"This copy was not installed with git ... so it cannot update itself":** the folder came from a ZIP download, so
  there is no history to fast-forward. Install with `git clone https://github.com/purple-ginseng/ResearchTool`,
  stop the old copy, move your `workspace/` folder (and `backups/`, if you kept the default backup folder) into
  the new one and start it there. Until then "Check for updates now" can only say the same.
- **Updates say the copy is a fork, on another branch, changed, ahead or diverged:** ResearchTool only updates an
  untouched clone of the official repository on `main` ([Updating](install.md#updating) lists every reason). `git status` in the
  app folder shows what is different. To follow the official version again: `git switch main`, undo or commit your
  changes elsewhere, and `git pull --ff-only`. A fork is never updated by the app - pull from your own remote.
- **Updates say GitHub could not be reached:** no network, a sign-in page of a Wi-Fi network, a proxy or a
  certificate problem. Nothing was changed; with the box ticked the check is tried again within the hour. If
  `git pull` in the app folder works in a terminal but the app's check does not, the difference is usually an
  environment variable: the app's git ignores every `GIT_*` variable except the certificate ones
  (`GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`) and reads the proxy from your git settings or `https_proxy`.
- **"The update was interrupted, and the ResearchTool folder may be half updated":** the fast-forward stopped half
  way (the disk was full, a file was locked by another program, the computer went to sleep): some program files
  are already the new ones, others are not. Your workspace is not involved. To finish the update, stop
  ResearchTool, make room on the disk or close the program that held the file, and in the app folder:
  1. if the file `.git/index.lock` exists and no git is running, delete it;
  2. run `git reset --hard origin/main`. This sets the program files git tracks to the version the update was
     installing (the app downloaded it already, so this works offline); `workspace/`, `backups/` and every other
     file git does not track stay as they are. (`git merge --ff-only origin/main` or `git pull` do not work
     here: git refuses to write over the files it already wrote.) Do not run `git clean`;
  3. `git status` should now say "nothing to commit" (untracked files aside). Start ResearchTool again.
  To go back to the old version instead, run `git checkout -- .` in step 2 and delete the new files `git status`
  lists as untracked, if they are the app's. Until one of the two is done the app keeps saying "interrupted"
  and does not try again.
- **Updates say the git settings inside the ResearchTool folder hold something a plain clone does not have:** the
  word in brackets says what - `filter`, `include`, `http`, `remote`, `core.alternaterefscommand`,
  `core.attributesfile`, `extensions.partialclone`, `extensions.worktreeconfig`, `info/attributes` or
  `objects/info/alternates`. These are settings in `.git/config` (or files in `.git`) that make git run a program
  or fetch from somewhere else, so the app does not run git over them by itself. If you did not put them there,
  look at `.git/config` before running any git command in the folder. If they are yours (a partial clone, an
  `http` proxy for this folder only), either move them to your global git settings (`git config --global ...`)
  or keep updating with `git pull` yourself.
- **A new version does not start, or you want the previous one back:** start with `RT_NO_UPDATE=1 node server.js`
  (PowerShell: `$env:RT_NO_UPDATE=1; node server.js`) so that nothing is installed again, or untick the box in
  Preferences › General. `git reflog -3` in the app folder shows the commit the update came from; `git reset --hard
  HEAD@{1}` goes back to it (this only moves the program files git tracks - the workspace and backups are not
  tracked). Then please report what broke.
