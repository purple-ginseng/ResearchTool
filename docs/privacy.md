# Privacy and your data

What stays on your computer, what goes online and when, where your files are, and how the trash and the backups work.

[Back to the README](../README.md)

## Privacy

- The server listens on 127.0.0.1 only and refuses requests whose Host or Origin is not this local address, so other
  machines and other web sites cannot reach it.
- Your PDFs, notes, highlights and projects stay in the workspace folder. There is no account, no telemetry and no
  analytics; fonts and scripts are served from `public/vendor`, never from a CDN.
- Online lookups happen only when you use a feature that needs them, and send only the arXiv id, DOI, OpenReview
  id, link or title of a paper ("Check venues" also sends Crossref the first author's surname with a title search):
  arxiv.org / export.arxiv.org, doi.org, api.crossref.org, api.openalex.org, api.semanticscholar.org, dblp.org,
  openreview.net / api2.openreview.net / api.openreview.net, proceedings.mlr.press and huggingface.co (arXiv id only).
  Answers are cached in `workspace/cache`.
- Adding a paper by DOI downloads its PDF from arXiv or, when OpenAlex names an open-access copy elsewhere, from that
  publisher or repository site (public https addresses only), so that site sees a request from your computer.
- "Find links" checks that the project and code links a paper names still answer, and reads that project page
  once, so those sites see a request from your computer.
- Overleaf sync talks to git.overleaf.com through your own `git`; the token stays in git's credential helper.
- AI features: see [AI integration](ai.md).

## What goes online

The server listens on 127.0.0.1 only, and the app has no account, no telemetry and no analytics. A request leaves
this computer only in these cases:

| What | Where to | When | What is sent |
| --- | --- | --- | --- |
| AI features and the AI panel | the provider of the AI command-line tool you chose (Claude Code, Codex, Grok, Antigravity), by that tool, under your own account | when you use an AI feature | the prompt: the text of the paper, note or project file the feature works on |
| Importing a paper | doi.org, arxiv.org, openreview.net, openalex.org | when you import by DOI, arXiv id or link, or drop a PDF | only the paper's id, DOI or title |
| Related tab, "Check metadata", "Check venues", Lineage | the scholarly indexes: OpenAlex, Semantic Scholar, arXiv, Crossref, doi.org, DBLP, PMLR | only when you press their button | the paper's DOI or arXiv id; "Check venues" also its title |
| Overleaf sync | git.overleaf.com, by git, with the token your credential store keeps | when you import, pull or push a linked project | the files of that project |
| Updates of ResearchTool | github.com, by git over https | only when "Keep ResearchTool up to date automatically" is ticked (a little after the start, then about once a day), or when you press "Check for updates now" or "Update now" | an anonymous git request for the public repository: no account, no token, nothing about you, your library or your notes. GitHub sees your IP address and that a git client asked for this repository |
| Downloading the voice | registry.npmjs.org and huggingface.co | only when you press "Download the voice" in Preferences › General › Speech | a plain download request for public files: nothing about you, your library or your notes |
| Dictation | the speech service of your browser (Chrome: Google) | only while the microphone button is on, and only in a browser that cannot recognise speech on the computer | what the microphone hears |

The update check is off unless you tick its box in Preferences › General (see [Updating](install.md#updating)). Reading aloud itself
sends nothing anywhere: the text goes to the voice on this computer.

## Where things live

Everything you create is in `workspace/` (or `RT_WORKSPACE`):

| Path | What |
| --- | --- |
| `library.json` | references: metadata, key points, category, tags, reading status, star, last place in the PDF |
| `pdfs/`, `sentences/` | imported PDFs and their extracted sentences |
| `notes/<item id>.md` | the reading note of each reference (Markdown) |
| `notes/assets/<item id>/` | images pasted or snapshotted into a note, and the figures placed into it |
| `cache/figures/<item id>/` | the figures and tables found in a PDF and their crops (rebuilt when missing) |
| `highlights/<item id>.json` | the colour highlights drawn on the PDF of a reference (the last 100 removed ones are kept for "restore") |
| `diagrams/<item id>.json` | the explained diagrams of a reference |
| `quizzes/<item id>.json` | the quizzes of a reference, your answers and the review schedule of every answered question |
| `compare/<table id>.json` | the comparison tables and questions of "Ask across papers" |
| `venues.json` | the verified venue of each paper (status, venue, year, first public date, publisher, which indexes confirmed it, why not) from "Check venues" |
| `backups/` | copies of `library.json` alone (`library-<date>-<time>.json`), made before it changes and right before each Codex run with "Let Codex edit files" |
| `note-template.md` | the note format guide that "Generate first draft" follows (edit it from the note's "..." menu; it starts as a copy of `templates/literature-note-guide.md` in the app folder) |
| `projects/<name>/` | LaTeX projects (projects imported from Overleaf are Git clones) |
| `history/`, `history-notes/` | version history of project files; of the notes and the note template |
| `export/` | default target of "Export references", and of the reading packs (`<project> - reading pack/`) |
| `trash/` | everything deleted or replaced in the app - nothing is hard-deleted. A deleted paper is `trash/library/<id>-<time>/` (`item.json` + its files); the bin button of the Library ("Recently deleted") puts it back or empties the trash |
| `cache/` | preview PDFs, temporary files, the text read from each PDF (`text/<id>.json`, rebuilt when missing), the answers of the Related tab (`related/`, asked again after 30 days), the Lineage records (`lineage/`: `works.json` per paper and work, `contexts.json` the citing sentences, `sets/` per computed set with `index.json`), the log of AI calls (`ai-usage.jsonl`: tokens, cost, seconds) |
| `settings.json` | export folder, backup folder, "Claude usage" mode, the teaching style ("How Claude explains"), opened external folders, per-project settings (compiler, limits, checks, dictionary, references scope, the papers of the project), Overleaf links, grouping settings, `autoUpdate` (only when "Keep ResearchTool up to date automatically" is ticked) |
| `CLAUDE.md` | explains this layout to Claude Code |

Notes written with an older version (the `notes` text inside `library.json`) are moved into `notes/<id>.md` the
first time the reference is opened or the library is exported.

## Trash and backup

- **Recently deleted** (bin button at the top of the Library list): every deleted paper with what belonged to it;
  the arrow puts it back completely (reference, PDF, sentences, note and images, highlights, diagrams, quizzes).
  Deleting one paper asks nothing - the message that follows has an Undo button. "Empty items older than 30 days" /
  "Empty the trash" are the only places where files are removed for good, and they show how much first.
- **Copies of the list of references**: `library.json` is copied to `workspace/backups/` before it changes (at most
  every 10 minutes; the newest 30 are kept, plus one per day for 60 days), and right before each Codex run with "Let
  Codex edit files" (unless the newest copy is the same). A `library.json` that exists but cannot
  be read is never taken for an empty library: nothing is loaded, nothing is saved over it, and the Backups window
  opens by itself on "List of references only", where one click puts the last good copy back (the file it replaces
  is kept beside the copies). The app also refuses to replace a library of five or more references with an empty one.
- **Backup** (Settings): once a day while the app runs, and with "Back up now", the whole workspace except `cache/`
  is copied to `<backup folder>/snapshot-<date>_<time>/` - a plain folder you can browse. The default folder is
  `backups/` in the app folder (`<workspace>-backups` when `RT_WORKSPACE` is set); choose one on another disk or in
  iCloud Drive. A file that did not change is a hard link to the previous snapshot, so PDFs are stored once. Kept:
  everything from the last 48 hours, one per day for 14 days, one per week for 8 weeks. "Show and restore backups…"
  puts a snapshot back: the current workspace is first kept as another snapshot and moved to
  `trash/before-restore-<time>/` (later backups leave that folder out - it is the snapshot just taken). Projects opened from a folder on disk live outside the workspace and are not
  backed up. The header gear shows a dot when the last backup is 3 or more days old.
