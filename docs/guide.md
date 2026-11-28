# User guide

What each part of the app does: the keys, the Overview, the Library with its reader and notes, Explore, the Editor and Overleaf sync.

[Back to the README](../README.md)

**Contents**

- [Keyboard](#keyboard)
- [Overview tab](#overview-tab)
- [Library tab](#library-tab)
- [Editor tab](#editor-tab)
- [Connecting Overleaf](#connecting-overleaf)
- [Language](#language)
- [Guided tour](#guided-tour)

## Keyboard

Cmd/Ctrl+K opens "Go to anything" - type a few letters to open a paper by its title, switch tabs or
run an action of the screen you are on. `G` then `O`, `G` then `L` and `G` then `W` go to the Overview, the Library
and the Write tab; `?` opens the guide at "Files & keys". In the Library, `/` goes to the search box, the arrow keys
walk the list (Enter opens, Shift+arrows or Space select, Delete or Cmd/Ctrl+Backspace removes), `J` / `K` open the
next / previous paper, `1`-`6` switch the tabs of the open paper (Alt+`1`-`6` while typing), and Page Down / Page Up,
`+`, `-`, `0` page and zoom its PDF. The single keys never fire while you type; the guide lists all keys under
"Files & keys".

## Overview tab

The first tab (keys `G` then `O`; Preferences › General › "Start on" can open the app on it) sums up the workspace:
a greeting with counts, quick actions (Import papers, Add by DOI or arXiv, Search ⌘K, New project), notices for
questions due and missing briefs (Claude starts only after a confirm), and cards for Continue reading, Reading stats,
Recently added, Recent notes, Research lines and top tags, Projects in the Editor, and Workspace health (backup,
Recently deleted, tools). Every row leads to its place in the Library, the reader or the Editor. It only reads.

The look follows the Purple Ginseng design, in plain CSS / SVG: the crest in the header and the favicons
(`public/brand/`, `public/favicon*`, `public/apple-touch-icon.png`), the icons (drawn by `RT.icon`),
empty-state illustrations (`public/js/illustrations.js`) and the theme tokens in `public/css/base.css`. Fonts are
vendored; nothing is fetched online.

There are two icon sets, and Preferences › General › "Icon style" chooses between them (for the whole workspace -
it is kept in `settings.json` - at once, without a reload):

- **Hand-drawn** (the default, `public/js/icons-sketch.js`): original drawings made for this app, in the same hand as
  the project page - each stroke a fountain-pen line that swells and tapers, in the colour of the text around it. At
  the small sizes of buttons and menus they are ink only; a lavender wash and one gold mark appear on the few large
  ones (the Overview cards, the project cards, the empty states).
- **Classic** (`public/js/icons-classic.js`): the Ginseng line icons the app had before, plain lines of one weight.
  They also draw any icon the hand-drawn set does not have.

## Library tab

### Importing and organizing

- **Import**: drop PDFs, folders or `.bib` files anywhere on the tab, use "Import PDF", or paste BibTeX. A queue shows
  each file's progress. The paste button (or Cmd+V in the Library) also takes arXiv ids and links, DOIs and OpenReview
  links, several per paste: metadata comes from the arXiv API / doi.org, the PDF from arXiv or OpenReview, and for a
  DOI (or a publisher link that holds it) from the free copy OpenAlex knows of or the arXiv paper with the same title - without one the reference is added with an "Attach PDF" prompt. Duplicates (same file, DOI or title) are reported and can be imported anyway.
- **Organize from a file**: a Markdown reading list or outline, or a `.bib` file, regroups the library and fills a
  project. Pick or drop a `.md` file in the Library, use "Add papers from a .md / .bib file…" in the Project chip menu,
  "Organize from a .md / .bib file…" in Cmd+K, or the offer in the message after importing a `.bib` file whose entries
  were mostly in the library already. The groups are the headings of the `.md` file (choose which heading level) or the
  comment headings / JabRef groups of the `.bib` file; references are `\cite{key}`, `[@key]`, `` `key` ``, DOIs,
  arXiv ids or links and titles. The preview shows each group (rename it; empty = Ungrouped), the papers found with a
  tick box, papers that are under several groups, and the entries not found and why. Apply makes the groups categories
  (filed by hand) or tags, or leaves the grouping alone, and adds the ticked papers to the working project (or another
  one); the `.bib` entries that are not in the library can be imported first. Nothing changes before Apply, the
  project's own files are only read, and the message has an Undo (papers imported by it stay). "Look up and import"
  hands the DOIs / arXiv ids of a `.md` file that are not in the library to the import queue, which asks arxiv.org /
  doi.org.
- **Categories and tags**: each new paper is filed into a category with a few tags by Claude, in the background.
  Categories are research lines: a paper goes where the line of work it builds on is (a method that starts from a VLA
  backbone is "VLA", one that learns a world model is "World Models"), judged from its title, tags and a few lines of
  its own text (the methods it says it builds on, the first sentence of its Preliminaries, the topics of its Related
  Work; read locally from the PDF text, at most 350 characters per paper). A line can have sub-lines, written
  "Line / Sub-line" (e.g. "Humanoid / Locomotion"), only when it has 4 or more papers; the list nests them under the
  line (both headers fold, both show counts, sub-lines take shades of the line's colour). Settings > "Research lines
  Claude should prefer" holds the vocabulary Claude prefers (VLA, World Models, Humanoid / Locomotion, MoCap & Human
  Motion, ...). The list can be grouped by category or year, filtered by tag, multi-selected, and papers can be
  dragged onto a category or sub-line. "Group with Claude" proposes a regrouping that you review before anything
  changes; it also holds the auto-grouping switch and the category language. The ⋯ of a line renames, deletes or
  re-groups the whole line. A category you set by hand is never overridden.
- **Venue and publication date**: View -> Group by "Venue (verified)" lists the papers under the venue they were
  published at (short names such as CoRL, ICRA, RA-L, Science Robotics; the most papers first; workshops apart), then
  "arXiv preprint", then "Unverified / 未归类" for papers that were not checked, not found, changed since the check, or
  whose indexes disagree. The venue comes only from a check you start: "Check venues of N papers" (View menu, or the
  bar above the list while grouped by venue, with progress and Stop) or "Check venue again" in a paper's right-click
  menu and in Details. It asks Crossref (real DOIs, the published DOI the authors gave arXiv, or an exact title search),
  the arXiv API, PMLR (the publisher of CoRL, ICML, AISTATS, COLT ...: its public volume pages, read only when the arXiv
  comment or an index names such a conference and year; cached in `workspace/cache/pmlr`), DBLP, OpenAlex and Semantic
  Scholar one paper after the other, sending only the DOI, arXiv id or title (and, to Crossref's title search, the
  first author's surname), and keeps the answer in `workspace/venues.json` (checked again
  after 30 days, when the entry's title / DOI / arXiv id changed, or when a lookup failed or a service did not answer).
  Strict rule: a venue is verified by the publisher's own record (Crossref, or the PMLR volume listing the equal title by the same first author), or by two indexes naming the same venue and
  year (±1), or by one exact DBLP entry; an arXiv comment such as "Accepted to CoRL 2025" alone is shown as a claim
  "(not confirmed)". Details shows the line (`CoRL 2025 · verified (DBLP, OpenAlex)`, `arXiv preprint · v1 2025-03-02`
  or `Not verified: <why>`). Sort by "Publication date" (newest or oldest first) uses the first public date found (arXiv
  v1, else the publication date), else the BibTeX year / month; Group by "Year" uses the verified year when there is
  one. The BibTeX entry itself is never changed by this.
- **Search**: the search box filters the list by title, author, cite key, tag, category and brief (several words,
  any order). With the switch beside it on, it also searches the text of every PDF, every note and every key point -
  Chinese included, `"words in quotes"` stay together - and lists the matching passages under each paper; a click
  opens the paper at that page, note line or key point. The text is held in memory by the server and read again
  when a file changes, so it stays quick with hundreds of papers.
- **Briefs**: the grouping call also writes a brief of each paper (problem, idea, headline result in a sentence or
  two, in the category language), shown under the title in the list and editable in the Details tab. The list's
  view menu writes the briefs that are missing (several papers per Claude call) and can hide them.
- **Reading status and "Continue reading"**: every paper has a status dot (to read, reading, done) and can be
  starred; a paper becomes "reading" when you first open it. The list can be grouped, sorted and filtered by status,
  and the papers you opened last (and have not marked done) are listed at the top. The PDF reopens at the page,
  offset and zoom where you left it, and the paper that was open is opened again when the app starts.
- **Papers of a project**: a paper can be added to one or more of your LaTeX projects (the Write tab's projects).
  The bookmark beside a row's star adds it to the **working project** or takes it out again (the message has an
  Undo); the "Project" chip in the search row switches the working project (opening a project in the Write tab
  makes it the working one) and takes rows dropped on it. The right-click menu, the selection bar, the open paper
  (a bookmark beside the star and a Projects line in Details) and Cmd/Ctrl+K do the same; "Add to project…" picks
  another project. Removing a paper from a project never deletes it. The group `In “P”` at the top of the list
  holds the project's papers with "cited N×" / "not cited" and "no note", a progress line (papers, to read, reading,
  done, cited, without a note, questions due) that opens a checklist of what is not read, not noted or not cited
  yet, and a ⋯ menu: Review this project, Compare these papers, Export reading pack, Open in Write. The view menu
  can group the list by project and show only the papers of the working project. The Related tab can add the
  papers it imports to the working project too ("also add to “P”"). When you reach the last page of a paper that
  has a note and is not Done, a message offers to mark it as done.
- **Reading pack** (⋯ of the project group, or the Papers window of the Write tab): writes
  `<export folder>/<project> - reading pack/` with `reading-list.md` (each paper with its authors, cite key, status,
  whether it is cited, brief, up to 5 key points with their pages and a link to its note), `references.bib` (the
  project's papers) and `notes/` (their notes and images). A new pack replaces the files of the previous one; the
  notes of the previous one go to the trash. Nothing is written into the project folder. "Download reading pack
  (.zip, paper packages)" (same menus) downloads the pack as one .zip instead: `reading-list.md` (the index, with
  each paper's venue and links), `references.bib` and one paper package per paper (see below), with the same
  question about PDFs over 100 MB.
- **Export references** (header): writes `references.bib`, `notes.md` (grouped by category), `library.csv` and one
  file per reading note (`notes/<citekey>.md`, images in `notes/assets/<citekey>/`) to the export folder (gear button).

### Reader

- **Reader**: opening a paper shows the PDF on the left and the workspace on the right (drag the divider; swap or
  maximise either side). The PDF has zoom, a selectable text layer ("Quote in notes", "Add as key point")
  and a snapshot tool that pastes a region into the note as an image. Colour highlights: select text and click a
  colour dot, and the passage stays marked on the page (the PDF file is not changed); a passage that is quoted or
  added as a key point is marked too, and the sentences of the key points are underlined. Click a highlight to
  recolour it, comment on it, go to its key point or remove it; the marker button lists all highlights of the paper. Quotes and snapshots carry a page link
  (`[p. 7](#rt-page=7)`): clicking it in the note, or the page chip of a key point, jumps the PDF to that page and
  lights the passage up. Cmd/Ctrl+F in the PDF pane searches the whole PDF and lists every match with its page and
  context (Cmd/Ctrl+G and Shift+Cmd/Ctrl+G step through them; words hyphenated at a line end are found). The PDF's
  table of contents opens in a side panel, its internal links ("[23]", "Fig. 4", "Sec. 3.2") are clickable and show
  a picture of their target on hover, and Back (Cmd/Ctrl+[) returns to where a jump started.
- **Key points** and **Details** tabs: sentence-level key points with your own glosses, metadata, category and
  tags, BibTeX.
- **The links of a paper** (Details tab, "Links"): project page, code repositories, arXiv, DOI / publisher page and
  videos or datasets, each with an Open button; the hover hint says where the link was found (the BibTeX fields, the
  paper's own text on its first pages or a sentence such as "Code is available at", never its reference list; the
  PDF's own hyperlinks on its first two pages, also behind words such as "project website"; the arXiv comment;
  the authors' project page; Hugging Face; the venue check). "Find links" also asks arXiv and Hugging Face (only the
  arXiv id is sent), checks that each project / code link answers - one that does not (404, 410) is marked
  "unreachable" and stays listed, and another project page the paper names that answers takes its place; one whose
  host does not exist moves to the other links - and reads the project page once (8 s, at most 2 MB, HTML only) for
  the repository it presents as its code (a "Code" / GitHub button, or a repository named like the paper; not the
  site template, the page's own source or the repositories of related work; its Hugging Face models and datasets
  are listed as such, not as code). A repository only Hugging Face names (anyone can attach one there) and no author
  source confirms is shown in Details as "suggested by Hugging Face, unconfirmed" and is no part of the package; an
  unreachable link is left out of the front matter (listed under `unreachable:`). A URL that pdftotext printed
  without the hyphen of a line break ("projectinstinct" for "project-" / "instinct") is read again from
  `pdftotext -raw` and the PDF's hyperlinks. Placeholders of anonymized papers ("after-review") are skipped. Nothing is guessed: no search, no link made up from a title. The packages use the
  same links (looked up again at most once a month).
- **Figures** (the picture button of the Notes tab): the figures and tables of the paper, found on your computer from
  the layout of the PDF - no Claude call, no tokens. Click one to put it into the note at the cursor (the picture, a
  line with its label and a link to its page); "Place the figures in this note" replaces the `> 📷 待截图：Figure 3 (…)`
  placeholders of a note with the pictures. Crops are kept in `cache/figures/` and stored with the note like a
  snapshot. The finder is a heuristic: a crop with a dashed frame is uncertain, and a figure it does not find is
  still taken with the snapshot tool.
- **Explain / translate in place** (the Claude button of a PDF selection, and beside a region right after a snapshot): the
  same questions plus "Translate to 中文 / English", answered in a card over the PDF without touching the note;
  "Add to note" inserts the passage as a quote with its page link, marks it on the page, and adds the answer as a
  `> [!ai]` comment.
- **Page citations**: every explanation ends what it takes from the paper with its page, "(p. 4)", and marks the rest
  "(general knowledge)". The page is a button that jumps the PDF - in the answer card, diagram cards, quiz
  explanations, the Claude panel and Claude's comments in the note (new comments write it as a page link).

### Notes

- **Notes**: a Markdown editor (instant-rendering or WYSIWYG, plus a split preview) with callouts, LaTeX formulas,
  quantity tables and highlights. Notes autosave, keep a version history (diff and restore) and can be exported
  or imported as Markdown or as a JSON draft format (the note as a list of typed blocks).
- **Pictures and videos** in a note: paste, drop or upload (videos: MP4, WebM, MOV up to 300 MB); drag the corner grip to
  resize. A picture's width is kept in its address (`![alt](url#w=320)`), a video is a `<video>` tag.
- **Ask Claude** (right-click in the note): explain a selected phrase, a paragraph, a table or a picture, its
  foundations, its meaning, an example, or your own question. The answer is appended below as a `> [!ai]` comment.
- **Generate first draft**: Claude reads the PDF and writes the note in the format of the note template. The
  previous note stays in the history.
- **A paper package** (the note's ⋯ menu): "Export paper package (.zip)" saves everything about the paper in one
  folder `<citekey>/`: `<citekey>.md` (YAML front matter with title, authors, year, venue, cite key, DOI, arXiv,
  project, code; then the title, an "authors · venue year" line and a links line `PDF · BibTeX · arXiv · DOI ·
  Project page · Code`; then the note, or "No note yet"), its pictures in `assets/`, `<citekey>.bib` and
  `<citekey>.pdf`. Open the .md in Obsidian, Typora or VS Code, or import the folder into Notion, Feishu, Yuque.
  "… without the PDF" is the same without the PDF file (the PDF link then points to arXiv when there is one).
  Several papers: "Export paper packages of N papers (.zip)" in the Library's right-click menu (also "… without the
  PDFs") or the zip button of the selection bar: one folder per paper plus `README.md` (one line per paper with its
  venue and links) and `references.bib`. When the PDFs are over 100 MB in all, it asks first: with the PDFs (the size
  is shown), without them, or cancel.
- **A note for another app** (the note's ⋯ menu): the pictures of a note only show in this app, so a note that leaves
  it takes them along: the paper package above, or "Export note (.md, pictures inside)", one .md with every picture
  as a base64 `data:` URI (larger; the message warns above 5 MB); "Copy note for another app" puts the same on the
  clipboard, as Markdown and as formatted text (pastes with pictures into Feishu, Notion, Word; refused above 8 MB -
  use the .zip). Both start with the title, authors and links line. In all of them a picture's `#w=` width is
  dropped, page links `[p. 5]` become plain text and a picture missing on disk becomes `[missing image: …]`.
  "Export note (.md, text only)" is the bare text, whose pictures do not travel.
- **Export note as PDF** (the note's ⋯ menu): the note laid out for a page (A4, or Letter where that is the usual
  paper, with the one-inch margins of a report) with the paper's title, authors and year on top. What would not fit is made to fit: a wide table or formula
  is scaled down (a long formula first breaks at its operators), pictures and diagrams stay inside the page, code
  lines wrap, and headings, table rows, pictures and formulas are not split across pages. It opens the browser's
  print window - choose "Save as PDF" there; the text of the PDF can be searched and copied.

### Read aloud and dictation

- **Read aloud** (the speaker buttons of the PDF toolbar, the selection menu and the note editor): the selected
  text, the PDF from the page you are on, or the note is read by a neural voice (Qwen3-TTS 0.6B) that runs on this
  computer. The voice is not part of the app: Preferences › General › Speech fetches it once (about 805 MB: the
  onnxruntime engine from the npm registry and the model from Hugging Face, every file checked against a pinned
  checksum) into a folder of your user account, and can remove it again. It reads Chinese and English, with a choice
  of speakers per language. It needs a graphics processor the engine can use (WebGPU: Apple Silicon Macs, most
  Windows and Linux computers with a current graphics driver; there is no build for Intel Macs), uses about 1 GB of
  memory while it reads, and makes sound about as fast as it is heard on an M2 Pro - on a slower computer it pauses
  between sentences. Tried on macOS (Apple Silicon) only.
- **Dictation** (the microphone button of the note editor): speech to text with the browser's speech recognition;
  the note is saved when you stop. Where the browser cannot recognise speech on the computer itself (Chrome), it
  sends the audio to its own service, which the app says and asks before the first use.

### Explore

- **Related papers**: the Related tab of an open paper lists its references and the papers that cite it (OpenAlex,
  Semantic Scholar as a fallback), marks the ones already in the library and adds any other with one click. It asks
  only when you press Look up, sends only the paper's DOI or arXiv id, and keeps the answer in `workspace/cache/related`.
  "Check metadata" in Details finds the published version of an arXiv preprint and updates the entry field by field;
  the cite key stays.
- **Lineage** (the branching button in the Library toolbar, "Lineage of this line" in the ⋯ of a line, "Lineage of
  this paper" in the Related tab): where a set of your papers comes from and where the work went, as in Connected
  Papers - for the whole library, one research line (with its sub-lines), a project's papers, one paper with its
  neighbours, or a **set of your own** ("Custom set…": several lines and sub-lines and / or the papers matching some
  words, remembered under a name). The papers of the set are listed on the left before anything is computed, each
  with a box to leave it out ("Look up the other N"), and the window says what a computation would ask ("12 of 12
  papers already looked up; about 9 list queries"). A set without a result of its own (the library one paper
  bigger) shows the newest result that shares 90 % of its papers at once, with "Computed for 112 papers; 1 new not
  included - Update".
  - **History line**: the papers on a time axis, one lane per line / sub-line, an arrow from each paper to the later
    papers of yours that cite it ("Order" spreads crowded months, "Time" is the true scale, "Last 12 months"; the most
    relevant prior works as nodes of their own, filled when they are in your library). **Ancestry** shows instead
    the 8 works the set builds on most in a column on the left, with a bundle into each lane as wide as the number of
    its papers that cite it; papers take the colour of their main ancestor; click an ancestor or a lane name to see
    its edges; a dashed ring marks an ancestor most of whose citers are from the last 12 months. **SVG** saves the
    picture. One paper: three bands (prior works, the paper, the papers of yours that cite it).
  - **Prior works** (the works your papers cite most), **Derivative works** (works citing several of them) and
    **Similar** (works co-cited with them by the works that cite them, or sharing many of their references -
    related and concurrent work that does not cite them; no extra request). "Most relevant" first: cited by these
    papers and by the rest of your library, widely cited hub papers damped, "generic" works (Adam, ResNet, a
    benchmark everyone cites) hidden unless asked; every row says why in its tooltip and chips ("cited by RT-2,
    Octo, +2", "shares 12 refs", Seminal / Recent / Rising). Prior works also show how your papers cite them
    (Semantic Scholar: "method ×3", "influential ×1", and in the details the citing sentences, asked lazily) and
    "Top foundations you don't have". Derivative works include the most cited of the last 18 months; a line so new
    that few works cite it says so and offers "Recent works citing your line's top ancestors" (one query).
    Filters (years, missing from your library / project, surveys, venue type, open PDF), sorts (Most relevant, Most
    cited by these, Builds on most, Most cited overall, Recent first), row checkboxes with a selection bar.
  - **Add to a project**: Lineage adds to a project of its own choosing (the scope's project, else the one picked
    with the project chip, else the working project - it never changes the working project): the bookmark of a row,
    "Add all to “P”" (the first 25 rows as sorted unless changed), the details pane, the menu of a history-line node
    (right click or Shift+F10), "Add its prior + derivative works to “P”…". Works not in your library are imported
    first; one toast sums it up and its Undo takes them out of the project again (the library keeps them).
  - **Exports**: CSV and BibTeX of the rows as filtered or checked (BibTeX keeps acronyms such as {OpenVLA}, files
    arXiv-only works as @misc with eprint, and uses your own cite key for papers you have), "Grouped…"
    (Foundational / Recent / Surveys as BibTeX, or copied as a related-work bullet list). "Open in reader" leaves a
    "Back to Lineage" chip that brings the window back as it was.
  Each paper is looked up once by its DOI / arXiv id at OpenAlex (free) and at Semantic Scholar for its references
  (with their intents and citing sentences); a computation takes at most 10 OpenAlex list queries (OpenAlex allows
  about 1000 a day per network). Records are kept in `workspace/cache/lineage` (papers 14 days, a computed set 7
  days).
- **Diagram** tab: Claude draws the paper as a pipeline, workflow, flow chart or concept map with an explanation for
  every box and arrow (and examples on request). Diagrams can be edited by hand: change the text, add and join boxes,
  drag boxes, undo and redo.
- **Practice** tab: Claude writes a multiple-choice quiz on the paper (5, 10 or 15 questions; core ideas, deep
  understanding or expert). After each answer you see why it is right and why every other option is wrong. Answers
  are kept, missed questions can be practised again, and the same questions can be used as flash cards.
- **Review** (the cards button at the top of the Library list, with the number due today): every answered quiz
  question comes back on a schedule - right after 1, 3, 7, 16, 35 ... days, missed the same day - and the questions
  that are due are asked as one session across all papers (20 at a time), each with its paper's title, a jump to the
  paper and its page, "Add to note" and "do not ask again". With a working project, a switch in the window limits
  the session to the papers of that project (the button's number still counts all papers). It needs no AI call.
- **Ask across papers / comparison tables** (the table button of the Library list and of the selection bar, or
  right-click a category): pick up to 15 papers and either name the columns of a table (method, action
  representation, training data, results ...) or ask one question. Claude is asked once per paper, three at a time,
  with the brief, your note and key points and the passages of the PDF that match the columns - never the whole
  PDF - and a token estimate is shown before you start. Every cell carries the pages it rests on (a click opens
  that paper at the page); a question also gets one overall answer cited as `[citekey, p. N]`. Tables are saved in
  `workspace/compare/`, fill while the window is closed, can be edited by hand, extended with new columns and filled
  again, and exported as Markdown, CSV or a booktabs table with `\cite` keys - into the note of the open paper or
  the open `.tex` file.

## Editor tab

- **Projects home**: all projects with source (Local / Folder on disk / Overleaf), last-modified time, search,
  filters and sorting. New blank or example project, upload a .zip, open an existing folder, import from Overleaf.
- **Editor**: file tree (create, rename, move by drag, upload, delete to trash), file outline, tabs, autosave + Save,
  a toolbar (styles, math, symbols, links, `\ref` / `\cite` pickers, figure and table helpers), autocomplete,
  search in the file (Cmd+F) and across the project.
- **Spelling and writing checks** in `.tex` files: misspelt words are underlined (English; the word list is built
  from the system word list, `/usr/share/dict/words` or similar - macOS has it, on Ubuntu install `wamerican`;
  Windows has none, so there this check is off - plus a project dictionary and the names and title words of
  your references), and repeated words, a missing `~` before `\ref` / `\cite`, straight quotes, braces or
  environments that do not match and TODO notes are marked. Commands, math and cite / ref keys are skipped.
  Right-click a mark for corrections, F8 goes to the next one, the toolbar button switches each check off per project.
- **Ask Claude about a selection**: right-click selected text in the editor (or the Claude button of the toolbar) to
  improve the wording, shorten it by about 20%, translate it into academic English or follow an instruction of your
  own. The proposal is shown under the passage as a word-by-word comparison; Accept puts it in place and records a
  "Claude" version in the history, Reject leaves the text alone. "Find weak claims" answers in the Claude panel.
  The right-click menu on a selection also has Copy, Cut and Paste, because it replaces the browser's own menu there.
- **Draft related work from the library**: the books button of the toolbar lists your papers (filter, category,
  what there is on each: note, key points, brief). Claude writes LaTeX from the notes, key points and briefs of the
  ticked papers - never the PDFs - and may cite only their keys; any other key is removed and reported, and papers
  with nothing to write from are listed instead of described from memory. The draft is shown first, then inserted
  at the cursor between two comment lines as a "Claude" version.
- **Papers of this project** (toolbar button, or the project menu): the papers added to the open project, each with
  its status, cite key, "cited N×" / "not cited", note and highlights, and buttons to insert its `\cite` at the
  cursor, open it in the Library or take it out of the project. Below: the papers the project cites that are not in
  it (Add, Add all) and the cited papers that are not marked done or have no note. "Insert annotated bibliography" puts a
  `description` list at the cursor - `\item[\cite{key}]` with the brief and up to 3 key points of each paper - without
  an AI call (Cmd/Ctrl+Z takes it out); "Export reading pack" is the one of the Library. The `\cite` picker and
  `\cite{` completion list the project's papers first ("In this project", marked cited / to read / reading / not
  cited). Draft related work and a new comparison table start with the project's papers when nothing is selected
  in the Library (a table takes the first 15), the projects home shows a Papers column, and the Review can be
  limited to the project.
- **Word count and limits**: the outline shows the words of each section (texcount, counted again after every save)
  and the total; a project can have a page limit and a word limit ("Word count and limits..." in the project menu),
  shown against the compiled page count above the PDF - amber at the limit, red over it, optionally without the
  reference list.
- **PDF**: Recompile (pdfLaTeX / XeLaTeX / LuaLaTeX, "from scratch", stop on first error), page navigation, zoom,
  log panel with clickable errors, and SyncTeX in both directions (arrow buttons; double-click the PDF). The preview
  shares the reader's Find box with its list of matches, the table of contents, clickable links and Back; a search
  and the scroll position survive a recompile.
- **History**: every save is a version; compare, label and restore. Changes made by Claude or outside the app are
  recorded as such.
- **Layout** menu: editor and PDF, editor only, PDF only. Download the project as .zip or the PDF.
- `references.bib` next to the main file is regenerated from the library before every compile as long as its first
  line is the "Generated by ResearchTool" marker; a `references.bib` you wrote yourself is left alone. It holds only
  the entries the project cites (every `\cite` variant in the .tex files, plus what the last LaTeX run recorded, so
  a citation made through your own macro is in from the second compile; `\nocite{*}` means everything). Project menu
  → **References…** switches a project to the whole library, or to the cited entries plus the project's papers.
- **Citation keys** are checked as you type: a `\cite` key that has no entry is underlined in red with a dot beside
  the line number, and so is a key that a .bib file defines twice. Right-click the key (or click the dot) for the
  closest keys and "Pick an entry from the library…". **References…** lists the same for the whole project, plus
  entries of your own .bib files that are never cited and cited entries without a year or venue or that are still
  an arXiv preprint. A project that loads a .bib file from outside its folder gets no "no entry" marks, because the
  keys of that file cannot be seen.

## Connecting Overleaf

Sync uses Overleaf's own **Git integration** (an Overleaf Premium feature). ResearchTool never sees your Overleaf
password or token: git keeps the token in its credential store - the macOS Keychain, the Windows Credential Manager
(Git for Windows) or a Linux credential helper such as libsecret.

1. On Overleaf open **Account Settings -> Git integration** and create a Git token; copy it.
2. In ResearchTool: **Write -> New project -> Import from Overleaf...**, paste the project's address
   (`https://www.overleaf.com/project/...`) and press Import.
3. The first time, the dialog shows a command like

   ```bash
   bash '/path/to/ResearchTool/scripts/overleaf-login.sh' <project id>
   ```

   Run it in Terminal (on Windows: in Git Bash). When git asks, type `git` as the username and paste the token as
   the password. The script only makes git contact Overleaf once so that git stores the token. If you have no
   credential helper yet it says so and sets `osxkeychain` on macOS or `manager` on Windows (both keep the token
   in the system's credential store); on Linux it uses libsecret when that is installed, and otherwise stops and tells you
   how to configure a helper. It never sets up git's plain-text `store` helper, and leaves a helper you already
   have as it is.
4. Back in the app press **Try again**.

An imported project shows a sync control in the editor's top bar: the status (up to date, local changes, incoming
changes), **Pull**, **Push** and a menu with "Open on Overleaf" and "Unlink". Open files are saved before every
pull or push. If both sides changed the same lines you are asked which version wins; nothing is changed before
you choose, and your local copies of those files are first moved to `workspace/trash/`. LaTeX build files and the
compiled PDF are never pushed. Overleaf cannot list your projects through Git, so each project is added by its link.

For testing without Overleaf, `RT_OVERLEAF_GIT_BASE=file:///some/dir` makes the app (and the login script) use
local bare repositories named by a 24-character hex id.

## Language

The interface is available in English and Chinese: Preferences › General › Display language (English / 中文).
Your papers, notes and Claude's answers are never translated by this switch. The language of Claude's first drafts
and of category names has its own settings.

## Guided tour

Help (the **?** button) › "Take the tour" walks through the whole app in 8 chapters (Overview, Header, Library,
Reader, Notes, Claude panel, Explore, Editor), switching views by itself; → / ← move, Esc leaves. "Tour of this
screen" starts at the chapter of the current view. The **?** button also opens a written guide to the app.
