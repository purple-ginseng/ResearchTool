# ResearchTool - architecture

No build step, no frameworks, no npm runtime dependencies. Node `http` server (Node 18+, tested on Node 24) + vanilla browser JS.
User data lives in the workspace (`workspace/`, or `RT_WORKSPACE`). The display-language layer (English / 中文) is
described in [docs/preferences.md](docs/preferences.md).

## Module map

```
server.js                 bootstrap, static files (public/), same-origin security gate, router
lib/core.js               shared backend helpers (paths, JSON storage, run(), send(), P/H instances ...)
lib/platform.js           what differs between macOS, Linux and Windows (pure, platform injectable for the tests): buildPath()
                          (the PATH the server adds), resolveCmd() / spawnTool() (every tool is started through it, never a
                          shell: on Windows PATH x PATHEXT, an .exe directly, an npm .cmd shim as node + its script, any
                          other .cmd / .bat refused with EUNSAFECMD), killTree() (taskkill /T /F on Windows), inside() /
                          insideAnyCase(), winBadName() (names Windows reads differently: refused by normRel and the zip
                          import there), lines() / lf() for \r\n tool output, wording (credential store, git install)
lib/zip.js                writeZip(): a plain zip without the zip program (used when `zip` is missing, e.g. on Windows)
lib/routes/*.js           one route module per feature; ALL are auto-loaded in file-name order:
  backup.js               /api/backup[/restore]  dated copies of the whole workspace (lib/backup.js; it also starts the daily
                          backup); the folder and the switch are saved with PUT /api/settings {backupDir, backupAuto}
  categories.js           /api/categories[/rename|delete|regroup|apply|lines] (rename / delete {line: true} = a whole research
                          line with its sub-lines; GET|PUT lines = Settings "Research lines Claude should prefer", settings.json
                          researchLines, absent = the built-in list, '' = none; PUT {reset:true}), POST /api/items/:id/categorize,
                          POST /api/items/:id/brief, POST /api/briefs {ids?} (write missing briefs), POST /api/briefs/stop          LIBRARY
  account.js              /api/claude/auth[/login|code|logout]  is the claude CLI installed and signed in; sign in / out
                          through `claude auth` (UI: public/js/account.js; the app never sees a password or token)
  claude.js               POST /api/claude (NDJSON stream)
  drafting.js             GET /api/writing/material (ids of the papers that have a note), POST /api/projects/:id/rewrite
                          {mode, instruction?, text, section?, before?, after?} -> {text, same, newKeys}, POST
                          /api/projects/:id/related-work {ids, angle?, heading?} -> {latex, papers, cited, uncited, thin,
                          skipped, dropped, words}. Neither writes a file (lib/writing.js; UI: public/js/write-ai.js)
  highlights.js           /api/items/:id/highlights[/:hid|restore]  colour highlights on the PDF of an item (data in
                          <workspace>/highlights/<id>.json, removed ones kept in the same file; UI: public/js/highlights.js)
  library.js              /api/library /api/library/backups (GET: {damaged, backups}, POST: keep a copy now) /api/library/restore
                          {name} (the copies of library.json; they answer while the file is damaged)
                          /api/status /api/import/pdf|bibtex|progress, POST /api/import/ref {ref, force,
                          job} (one arXiv id / arxiv.org URL / DOI / doi.org URL / OpenReview link -> {item, pdf, why})
                          /api/items/:id[/pdf|sentences|bibtex|extract|opened] /api/settings /api/export        LIBRARY
  lineage.js              POST /api/lineage {scope 'library'|'category'|'project'|'paper'|'ids', category?, pid?, id?, ids?,
                          label?, mode 'cached'|'auto'|'refresh'} -> {key, state 'done'|'running'|'none'|'error', result?,
                          stale?, staleInfo? {key, computedFor, added, removed, computed} (cached mode: the closest stored
                          set), estimate? {papers, known, lookups, noId, list, budget, today}, scope {.., ids} (state
                          'none'), progress {phase 'papers'|'prior'|'derivative'|'similar', done, total, current, usage}?,
                          error?, busy?}; GET /api/lineage/job?key= (poll), GET /api/lineage/work/<W id> (one work +
                          abstract, a free single look-up), GET /api/lineage/usage (requests asked today), POST
                          /api/lineage/contexts {ids, work {key, w, doi, arxiv, title}} (how the citing set papers cite
                          a work: Semantic Scholar intents / influence / citing sentences, lazily, <= 6 requests a call),
                          POST /api/lineage/recent {key} (the newest works citing the top 3 prior works of a stored
                          set: 1 list query, kept with the set) (lib/lineage.js; UI: public/js/lineage.js)      LIBRARY
  quiz.js                 /api/items/:id/quizzes[/:qid[/progress]]  practice quizzes written by Claude (lib/quiz.js,
                          data in <workspace>/quizzes/<id>.json; UI: public/js/quiz.js, the reader's Practice tab)
                          /api/review[?cards=1][&project=<pid>] /api/review/answer|off  spaced review of the answered
                          questions of all papers (or only of a project's papers: 404 for an unknown pid): a Leitner
                          schedule {step, interval, due} per question in the "review" map of each quiz, written by every
                          answer; no AI call (UI: the Review dialog at the end of quiz.js). answer / off still answer
                          the global due count; the project scope asks GET /api/review?project= again
  compare.js              /api/compare[/estimate|/:id[/fill|stop|export]]  questions and comparison tables across papers
                          (lib/compare.js, data in <workspace>/compare/<id>.json; UI: public/js/compare.js)
  diagrams.js             /api/items/:id/diagrams[/:did[/explain]]  explained diagrams drawn by Claude (lib/diagrams.js,
                          data in <workspace>/diagrams/<id>.json; UI: public/js/diagram.js, the reader's Diagram tab)
  notes.js                /api/note-template /api/notes/export GET /api/notes/recent?limit=N (1-50, default 10; read-only:
                          {notes: [{id, mtime, size}]} newest first, the non-empty note files) /api/items/:id/note[/history[/:vid[/diff|restore]]
                          |assets[/<file>]|export|import|draft|ask], POST /api/items/:id/pdf (attach/replace),
                          GET|POST /api/items/:id/links (the paper's links; POST also asks the network)   READER
  organize.js             POST /api/organize/parse {text (<= 2 MB, .bib 8 MB), name?, kind? 'md'|'bib', level? 0-6} -> {kind, groups [{name,
                          entries [{line, raw, key?, doi?, arxiv?, title?, match {id, citekey, title, how} | null, why?,
                          bibtex?}]}], stats {entries, matched, unmatched, groups, truncated?}}: the references of a .md /
                          .bib file found in the library and grouped by its headings; writes nothing (lib/organize.js;
                          UI: public/js/organize.js)                                                           LIBRARY
  overleaf.js             /api/overleaf/status|import, /api/projects/:id/overleaf[/pull|push|resolve|unlink]    OVERLEAF
  projects.js             /api/fs/pick|list|tools /api/projects[?lite=1|/open|import-zip] /api/projects/:id[/file|raw|files|
                          upload|rename|rename-project|compile|synctex|search|labels|refs|wordcount|spelling|download|pdf|
                          settings|papers|reading-pack|annotated|history[/:vid[/diff|restore]]], GET /api/spell/words,
                          GET /api/memberships                                                                WRITE-UI
                          wordcount = texcount -merge -sub=subsection (-ch / -ja / -kr for CJK text) -> totals +
                          sections[{kind 'top'|'part'|'chapter'|'section'|'subsection', title, words, total (with what is
                          under it)}]; spelling GET -> {words (project dictionary), known (words of the project's .bib files
                          and of the library)}, POST {add?, remove?}; settings PUT also takes budget {pages, words,
                          skipRefs}, checksOff [rule ids] and bibScope 'cited' (default) | 'all' | 'project' (other
                          values 400): what writeReferences puts into a generated references.bib before a compile - the
                          library entries the project cites (.tex scan + \citation of the last .aux / .bcf; \nocite{*} =
                          all), every entry, or the cited ones plus the project's papers (header "% Cited entries plus
                          the papers of this project: N."); refs GET -> the references check of lib/refcheck.js
                          {library (the library supplies entries), generated, defs [{key, file, line}], undefined,
                          duplicates, unused (with 'project' the members are not unused), incomplete, counts, citedKeys,
                          outside [.bib files that are loaded but are not project files: then no key is called
                          undefined, on the server or in the editor]}
                          Papers of a project (projectSettings[pid].papers, see "Papers of a project" below):
                          ?lite=1 -> {projects: listLite()}; GET /api/memberships -> {projects: listLite(), byItem:
                          {itemId: [pid]}}; GET papers -> {project {id, name}, papers [row], citedNotMember [{id,
                          citekey, title}] (max 500), counts {total, toRead, reading, done, cited, noNote, due},
                          nociteAll}; POST papers {add?, remove?} -> {papers [ids], ignored [unknown ids]} (remove
                          first; 400 over 1000 papers); POST reading-pack -> {dir, files, markdown}; POST annotated
                          {ids?} -> {latex, keys}. These four answer for an external project whose folder is missing
  related.js              GET /api/items/:id/related[?mode=cached|refresh]  references and citing papers of an item (lib/related.js;
                          UI: public/js/related.js, the reader's Related tab), GET /api/items/:id/metadata-check (what the
                          published record would change), POST the same path {values: {field: text, '@type'?}} applies it
  search.js               GET /api/search?q=[&id=]  full-text search of the library (lib/fulltext.js); UI: the switch in the
                          Library search box (library-list.js), a passage is shown with RT.reader.reveal(id, hit)
  trash.js                /api/trash[/:bin[/restore]]  deleted papers: list, put back, delete for good, empty (lib/trash.js)
  venues.js               GET /api/venues -> {items {id: record + stale}, running {done, total, current {id, title}} | null,
                          last {done, total, stopped, error?} | null (how the last check ended), damaged? (venues.json set aside)},
                          POST /api/venues/check {ids?, force?} -> {started, total} (409 while a check runs), POST
                          /api/venues/stop -> {stopped}: the verified venue of each paper (lib/venues.js; UI: the Venue
                          grouping, publication-date sorts and venue bar of library-list.js, the "Verified venue" line of
                          the reader's Details)                                                                 LIBRARY
lib/trash.js              the trash: summary() (deleted papers = trash/library/<id>-<time>/ with item.json, sizes, what is older
                          than 30 days), restore(bin) (files back first, each only where nothing is in its place, then the item
                          through saveLib; undone when the save fails), empty({days | bin}) - the only hard delete of user files
lib/backup.js             workspace snapshots <backup dir>/snapshot-YYYY-MM-DD_HHMMSS/ (rt-backup.json marks a complete one):
                          run(reason), list(), status(), restore(name), configure(settings, body), schedule() (hourly check, a
                          snapshot when the newest is older than 20 h). Unchanged files (size + mtime) are hard links to the
                          previous snapshot; never to the live workspace. restore() takes a 'before-restore' snapshot, copies the
                          chosen one into <ws>/.restore-<time>/, then swaps top-level entries by rename (the old ones go to
                          trash/before-restore-<time>/; cache/ and trash/ stay) and undoes the swap when a step fails
lib/bibtex.js extract.js  BibTeX parse/serialize/makeKey, normDoi/normTitle (duplicates and matching); sentence + key point extraction
lib/organize.js           "Organize from a file", pure: parse(text, {name, kind, level, items}) reads a .bib (group = JabRef
                          `groups` field, else the nearest comment heading `% ---- X ----` / `%% Section: X` / `@comment{X}`)
                          or a .md (group = nearest heading, or of level <= `level`; entries = \cite / [@key] / @key and
                          `key` of library keys, DOIs, arXiv ids / links, title lines; code fences skipped; a heading that is
                          a library title is an entry) and matches each entry: cite key -> DOI -> arXiv id -> title (>= 12
                          characters). At most 3000 entries. Tests: node scripts/test-organize.js
lib/projects.js           createProjects(): list/listLite/get/create/freeName/renameProject/openFolder/remove/setSettings/
                          words/editWords/papers/editPapers/live/resolveIn/listFiles/trashFile/move; merges updatedAt and
                          overleaf into project objects; exports MAX_PAPERS (1000) and BIB_SCOPES
lib/refcheck.js           bibliography hygiene, no file access: citedKeys(texts, aux) -> {keys, all, uses (Map key -> \cite
                          count in the .tex files)}, pickCited(items, want) (case-blind,
                          follows crossref), check({files, generated, library, items, scope}), gaps(type, fields)
lib/spell.js              wordList(): the English word list of the spelling check, built once per run from the system
                          dictionary (/usr/share/dict/words, lower-cased) plus the modern, technical and irregular words
                          in the file (web2 is from 1934 and has base forms only) -> {plain, gzip, etag}; wordsOf(texts),
                          cleanWord(w)
lib/history.js diff.js    version history store; line diff
lib/fulltext.js           full-text index of sentences/<id>.json (else the paragraphs of cache/text/<id>.json), notes/<id>.md
                          and the key points, held in one long-lived worker thread; before every search the worker stats the
                          files and reads again only those whose size or mtime changed. A passage matches when it holds every
                          word of the query (lower-cased substrings, so CJK works; "quoted words" are one word). Answers
                          {papers: {id: {n, hits[{kind 'note'|'kp'|'pdf', text, page?, line?, kp?, pass?}], more}}, total}
lib/search-worker.js      project text search; regex searches run in a worker thread that is terminated after 2 s
lib/notejson.js           note JSON <-> Markdown (toMarkdown, fromMarkdown, CALLOUTS); tests: scripts/test-notejson.js
lib/notes.js              note files, history, assets, PDF attach, export/import (exportNotes(dir, {ids?}) -> names {id: file}),
                          template, draft generation (claude). A note for another app: portableNote(md, {resolve,
                          htmlWidths}) (pure) rewrites every /api/items/<id>/note/assets/<file> link through resolve()
                          to a relative path or a data: URI, drops #w= (htmlWidths: <img width>), turns [p. 5](#rt-page=5)
                          into "p. 5", writes "[missing image: alt]" for a file not on disk, leaves code alone;
                          notePackage(item, md, {mode: 'files'|'embed', dir}) applies it to the workspace files,
                          writePackage / zipNotes(items) (one <key>/<key>.md + <key>/assets/ per note, zip(1) like
                          zipProject; names passed as ./<name>) / zipTree / scratchDir (cache/note-export/). exportNotes
                          and the reading pack use notePackage too; both give a repeated key (case-blind) "-2". fileKey
                          is a disk-safe name (no leading . or -, no trailing ., CON/LPT1... get "_"). Paper packages:
                          writePackages(dir, items, {pdf, links, index}) / zipNotes(items, opts) write one <key>/ per
                          paper - <key>.md (frontMatter: quoted YAML; paperHeader: "# Title" unless the note starts with
                          it, authors · venue year, [PDF] · [BibTeX] · [arXiv] · [DOI] · [Project page] · [Code]; the note
                          or "No note yet"), <key>.bib, <key>.pdf, assets/ - and with index README.md + references.bib.
                          Links of many papers: 10 s each, 90 s in all, 4 at a time (linksFor). packageEstimate(items)
                          -> {papers, notes, pdfs, pdfBytes}. Tests: node scripts/test-note-export.js
lib/writing.js            Claude in the LaTeX editor, no tools: rewrite() = a selected passage (at most 6,000 characters, with
                          700 / 400 characters around it as context) -> the replacement, usage 'rewrite', light;
                          relatedWork() = up to 30 library papers -> LaTeX, usage 'related-work', heavy. Per paper the prompt
                          holds the brief, noteExcerpt() of the note (its [!abstract] / [!key] callouts and closing section)
                          and a few key points - the abstract only when there is no note. keepKeys() removes every cite
                          key that is not one of the chosen papers; papers with nothing to go on are not sent (`skipped`).
                          No AI: annotatedBibliography(items) -> {latex, keys} (a description list, `\item[\cite{key}]`
                          + the brief, else the start of the abstract, else the title, + up to 3 key points "(p.~N)"),
                          topKeyPoints(item, max), texEsc (compare.js takes it from here)
lib/compare.js            tables across papers: create({ids (at most 15), kind 'compare' | 'ask', columns | question, language},
                          res) / refill(id, {rows?, all?}, res) stream NDJSON (table, row ..., status, done | error) and
                          work on when the response is closed; one job at a time, three papers in parallel, the file
                          saved after every paper; stop(id). One light call per paper, no tools: brief, a few key
                          points, noteExcerpt() of the note and paperExcerpt(item, columns + question) within a budget
                          set by the "Claude usage" mode (7,000 / 11,000 / 16,000 characters) -> {cells: {<column id>:
                          {text ('' = not stated), pages}}}; a question gets one more call that writes the overall
                          answer from the per-paper answers (the only prompt here with the teaching style). estimate(),
                          update() (title, columns - a column keeps its id and cells while its name stays -, one
                          cell, remove a row), remove() (to trash/compare), exportAs(id, 'md' | 'csv' | 'tex'); usage 'compare'
lib/categorize.js         classification prompt (category, tags, reason, brief) + background queue, briefs for papers
                          without one (several per call), regroup proposal, category summary (claude). Categories are
                          research lines, "Line / Sub-line" at most (SEP ' / ', lineOf, subOf, joinLevels; a sub-line only
                          for a line of >= 4 papers: settleLines); both prompts share lineRules() (the preferred lines of
                          Settings) and get paperEvidence() of each paper - the methods it builds on, the first sentence of
                          its Preliminaries, its Related Work topics - from the cached pdftotext text, <= 350 characters,
                          cached in cache/line-evidence.json (stop list of datasets / tools / robots, own-name variants
                          left out; sentences that are math, tables, captions or MDP boilerplate skipped). colorMap(names):
                          a line with sub-lines gets a palette colour no other line uses, each sub-line a distinct shade of
                          it by its place among the line's sub-lines (same code in public/js/categories.js). Names typed by
                          the user (cleanCategory(v, items)) take the library's spelling of the line part. summary() also gives lines [{name, count, direct?,
                          sublines}]. Tests: node scripts/test-categorize.js
lib/refs.js               import by reference: parseRef (arXiv id / DOI / OpenReview link), metadata from the arXiv API,
                          doi.org BibTeX and the OpenReview API, free PDF of a DOI through OpenAlex or arxivByTitle (exact title),
                          downloadPdf (https, public hosts that do not resolve to a local address, must start with %PDF-, 100 MB). importRef in routes/library.js checks for
                          duplicates, then hands the PDF to importPdf, or adds a reference without a PDF
lib/links.js              the links of a paper for its package and the reader: links(item, {network, budget, force}) ->
                          {pdf, arxiv, doi, publisher, project {url, source, also?, dead?} | null, code [..], other
                          [{url, source, kind}], checked, notes}. Only the authors' statements: BibTeX fields, the PDF
                          text (pages 1-2, and announced links further on - "Code:", "is available at" - never in the
                          reference list: notes.dropReferences; line-broken URLs joined by joinBroken - a line-end "-"
                          stays - and the hyphen poppler drops when it joins a broken word put back from `pdftotext
                          -raw` / the annotations: restoreHyphens), the PDF's URI
                          link annotations of pages 1-2 (pdfAnnots: `pdfinfo -url`; a printed URL that an annotation of
                          its page continues becomes the annotation), the arXiv comment, the authors' project page
                          (fetchPage: GET once, 8 s, 2 MB, HTML, public hosts, every redirect checked; pageAnchors keeps
                          its code-host links outside the footer and related-work / baseline / BibTeX sections, fromPage
                          takes those whose anchor says code / github / repository or whose name is the paper's short
                          name - not a template or the page's own source repo; Hugging Face models / data -> other), the
                          Hugging Face papers API (githubRepo / projectPage; a repository no author source names:
                          `unconfirmed: true` - Details only, never in the package), the DOI
                          the venue check verified. Review placeholder hosts ("after-review") are skipped; a link whose
                          host does not exist (ENOTFOUND while arxiv.org resolves; offline is not dead) goes to other
                          with `gone: true`.
                          Network (arXiv id only; once a month, an hour after a failure) and a HEAD check of project /
                          code links (8 s, dead: 404 / 410 / unknown host; started together with the arXiv / HF requests,
                          whose shared turns can outlast the budget; a dead project page gives way to another candidate
                          that answers) run within `budget`; what arrives later is
                          cached in <workspace>/cache/links/<id>.json (key: PDF key + fields). Tests: scripts/test-links.js
lib/related.js            references / cited-by of an item and its published version. identOf(item) -> {doi (never an arXiv DOI),
                          arxiv, key}; related(item, 'auto' | 'cached' | 'refresh') asks OpenAlex (work by DOI, then
                          filter=cited_by:W / cites:W) and Semantic Scholar when OpenAlex has no work or no reference list - one
                          request at a time per service, 429 = "asked to wait" - and keeps the answer in
                          <workspace>/cache/related/<sha1 of the id>.json (30 days; 1 hour when a service could not be asked;
                          when offline the old answer is returned with `warning`). Only the DOI / arXiv id is sent. Every
                          answer is re-marked against the library (`inLibrary` by DOI, arXiv id or title; `ref` = what "Add"
                          imports). checkMetadata(item) -> {found, kind 'published' | 'refresh', changes[{field, label, from,
                          to, minor}]} (published DOI from OpenAlex, Semantic Scholar or arXiv -> doi.org BibTeX, title must
                          match); applyMetadata(id, values) writes the chosen fields through saveLib, never the cite key
lib/lineage.js            prior works / derivative works / similar works / history line of a SET of library papers
                          (Connected Papers' ideas: prior = the works most referenced by the set's papers, count = how
                          many set papers cite it; derivative = works citing >= 2 set papers (>= 1 for one paper), count =
                          how many set papers it references; similar = works co-cited with the set by its citers or
                          coupled to it; the set itself left out by OpenAlex id, alias, DOI, arXiv id or title). Per
                          library paper (key = identOf().key) a free single look-up works/https://doi.org/<DOI | arXiv
                          DOI> (both when the entry has both: the preprint is an alias id) with referenced_works; for
                          arXiv papers and OpenAlex lists under 40 also Semantic Scholar paper/ARXIV:<id>/references
                          (fields externalIds,title,year,isInfluential,intents,contexts - parseS2Refs), the two joined
                          (kept as [doi, arxiv, title, year], keyed doi:<doi> / t:<normTitle>, DOIs that >= 2 set papers
                          share mapped to OpenAlex ids by filter=doi:a|b). LIST queries are counted: at most LIST_BUDGET
                          = 10 per computation - prior <= 5 (filter=doi:, filter=openalex:W|W metadata of the 120
                          strongest candidates), derivative the rest but SIMILAR_BUDGET = 1 (filter=cites:W|W
                          sort=cited_by_count per-page=200 round-robin over chunks of 50, a set paper cited > 3000 times
                          in a one-page chunk of its own; one paper also sort=publication_date; several papers also
                          one page per chunk (<= 2) with from_publication_date = 18 months ago, asked in the first
                          round - the research front), similar 1 (metadata of the most co-cited works). Selects
                          include primary_topic, open_access and counts_by_year at no extra cost (workOf: field, vtype,
                          oa, c2 = citations this year and last). A work whose DOI / arXiv id / title is a library
                          paper's (the published copy of a preprint) is that paper (learnAliases, again after each
                          fetch; the history-line arrows are rebuilt from the cached records on every read). A spent
                          daily allowance (429, Retry-After of hours) is kept as works.json busyUntil: no list query
                          until then, and a partial set result stands until then (retryUntil).
                          Relevance (present(), pure, no request - stored sets are re-ranked on every read): prior =
                          hubDamp(cited) x (count + 0.8 ln(1 + library papers outside the set citing it)), x 0.6 outside
                          the set's top 3 fields (mainFields); generic (isGeneric) = cited > 30k, or a backbone /
                          optimizer / framework / benchmark title cited by >= 60 % of a set of >= 5; derivative = count
                          + min(0.9, 30 Salton coupling) + a small citation term; similar (similarRelevance) = co-citation
                          share cocited / sqrt(cited x citers) and Salton coupling, both capped, + log terms. Every row
                          gets relevance, generic and a `why` in words; prior rows also libCount and, from the cached
                          contexts, methods / influential / known / weighted (intentSummary: 1 + influential + 0.5 x
                          method per citer). rankRows keeps the non-generic TOP 40 + up to 25 generic ones.
                          Cache <workspace>/cache/lineage/works.json {papers {identKey: {w, aliases, dates, refs, s2,
                          refSource, problem?}} (14 days; 1 hour after a problem; a failed look-up never replaces a good
                          record), works {W: meta} (14 days), dois {doi: {w}}, usage {YYYY-MM-DD: {list, single, s2}}};
                          contexts.json {papers {identKey: {t, refs [[key, titleKey, influential, intents, ctx<=2]]}}}
                          (14 days; written by a computation's Semantic Scholar answer or lazily by contexts());
                          sets/<key>.json (the result, 7 days, 1 hour when partial; recentAnc added on demand) and
                          sets/index.json {key: {kind, label, ids, computed}} (rebuilt from the files when missing).
                          Mode 'cached' with no result of the set's own: closestSet() - the newest stored set of the same
                          kind and label (any label for 'ids') sharing >= 90 % of the ids, answered stale with
                          staleInfo; estimate() says from the cached records what a computation would ask. One
                          background job per set (start / status); present() re-marks inLibrary and the categories at
                          every answer. Result: {key, scope, papers [{id, title, date, approx, category, origin, refs,
                          refSource, cited, problem}], edges [[citing id, cited id]] (between the shown library papers),
                          prior / derivative / similar [{key, w, title, authors, last, year, date, venue, type, field,
                          vtype, oa, c2, doi, arxiv, cited, count, citers | cites | via, coupling?, shared?, cocited?,
                          relevance, generic, why, inLibrary, ref}], similar null for a set computed before it existed,
                          recent {since, anc, rows}?, simStats, notes, stats, usage, today}. One paper: its library
                          neighbours (it cites them / they cite it) join the history line. Pure parts tested by node
                          scripts/test-lineage.js
lib/venues.js             where a paper was published, VERIFIED. decide(evidence) is pure (the rules are in its comments; tests:
                          node scripts/test-venues.js): 'published' needs the publisher's own record (Crossref of a real
                          DOI: the entry's, the published version's DOI the authors gave arXiv when Crossref's record is
                          the same paper by the same first author, or a Crossref title search hit with an equal title,
                          the same first author, a journal / proceedings article and a year within one; or PMLR's volume page
                          listing the equal title by the same first author - asked only when the arXiv claim or an index
                          names a PMLR conference + year: pmlrHints / pmlrVolumes / pmlrMatch, pages cached as parsed JSON
                          in <workspace>/cache/pmlr/ - index.json a day, v<N>.json 30 days, one request per 1.5 s), or two indexes (DBLP, OpenAlex, Semantic Scholar) naming the same venue (alias table ALIASES +
                          abbreviation match) with years at most one apart, or one exact DBLP hit (same title and first
                          author; DBLP is curated); an arXiv comment / journal_ref is only `claim`; two different venues =
                          'unverified'; workshops are kind 'workshop'; known to arXiv / DBLP CoRR only = 'preprint'; a
                          failed lookup that could change the outcome = 'unverified' + `error` (asked again next time).
                          gather(item) asks Crossref (entry DOI), the arXiv API, Crossref (related DOI, else title
                          search), PMLR (with a hint; again after DBLP / OpenAlex and after Semantic Scholar with their venue as the
                          hint), DBLP (title search; an HTML bot check = `blocked`, left out for an hour and named in
                          `missed`), OpenAlex, Semantic Scholar (skipped once Crossref or PMLR has the record) in that order through the
                          rate-limited helpers of lib/related.js; this module sends the TITLE too (lib/related.js sends
                          ids only). status() / start({ids, force}) / stop(): one sequential background job, the library
                          re-read before each paper; a paper is skipped while its record is fresh (same fieldsKey = hash of
                          title + doi + eprint, no error / lastError / missed, < 30 days). A check that could not finish
                          never replaces a completed record of the same entry: the old one stays with `lastError`
lib/textcache.js          text of each PDF page from pdftotext, cached in <workspace>/cache/text/<id>.json and in memory
                          (key = size + mtime of the PDF); pages(id), put(id, pages), drop(id), memo / setMemo
lib/figures.js            the figures and tables of a PDF, found LOCALLY (no AI call): list(id) -> [{key 'fig-3' | 'tab-2',
                          kind, number, label, page, caption, box {x, y, w, h} in points from the top left, pageW, pageH,
                          confidence, why? (the checks the crop failed)}] (opts: cachedOnly, force),
                          image(id, key, {dpi}) -> {file, buf} PNG crop, asset(id, key) (the crop as a note asset),
                          place(id, markdown, {language, keys}) -> {markdown, placed, missed} (fills the 📷 placeholders
                          of a note; never a crop under MIN_PLACE), promptList(id, {maxPage}) / captionFor(id, text) ->
                          {caption, page} (cheap text for prompts, the latter from the cache only),
                          countPlaceholders(markdown), drop(id). Cache: <workspace>/cache/figures/<id>/ (index.json + crops), keyed like textcache.
                          Needs poppler (pdftotext -bbox-layout, pdftoppm); without it list() rejects 501 {unavailable}.
                          See "Figures" below. Routes: lib/routes/figures.js. Tests: node scripts/test-figures.js
lib/overleaf.js           git plumbing for Overleaf sync, link storage (settings.json "overleafLinks")
scripts/i18n-extract.js   finds the UI strings in public/js/*.js and public/index.html and reports those without a
                          Chinese translation (must stay at 100 %; see docs/preferences.md)
scripts/test-*.js         the tests: plain Node scripts, each with a temporary workspace (scripts/fixtures: their input files)
scripts/overleaf-login.sh one-time helper that lets git store the Overleaf Git token with its credential helper (macOS
                          Keychain, Windows Credential Manager - run it in Git Bash - or libsecret on Linux)
scripts/run-tests.js      runs every scripts/test-*.js (summary, exit code); scripts/smoke-server.js starts the real server
                          on a free port with a temporary workspace and a fake claude, and checks the page, read-only API
                          endpoints, the security gate and a project download (--pdf: a PDF import too); both run in CI
                          (.github/workflows/ci.yml: ubuntu / macos / windows x Node 20 / 24, Node 18 on ubuntu).
                          scripts/test-platform.js simulates Windows; scripts/zipread.js reads zips for the tests
templates/literature-note-guide.md   seed of <workspace>/note-template.md

public/index.html         shell: header, empty view containers, Claude aside, fixed list of css/js files
public/js/ui-boot.js      loaded in <head> before the first paint: applies the per-browser preferences of prefs.js that change
                          the look (<html data-theme>, data-hints, lang / data-lang for Chinese)
public/js/i18n.js         display language (English / 中文) -> RT.i18n: a pure translator (createTranslator, also loads in
                          Node) applied to the page's text and attributes by a MutationObserver. See docs/preferences.md
public/js/i18n/zh.js      the Chinese dictionary (dict, keep, notUi, captureWords, rules); it merges the fragments
public/js/i18n/zh-*.js    dictionary fragments per area (brand = shared chrome, overview, library, reader, dialogs, tour),
                          loaded before zh.js. Tests: node scripts/test-i18n.js
public/js/prefs.js        Preferences dialog (gear in the header, Cmd/Ctrl+,) -> RT.prefs; replaces the old Settings dialog
                          of core.js and keeps its element ids. Per-browser values in localStorage (rt.ui.lang, rt.ui.hints,
                          rt.ui.theme, rt.ui.startView ...), the rest in the workspace's settings
public/js/tips.js         fast hover hints for every titled button, link, tab and menu item -> RT.tips {configure(), hide()}
                          (Preferences > General > Hints on hover: fast / normal / off)
public/js/overview.js     Overview tab (order 5, icon dashboard; `rt.ui.startView = 'overview'` opens on it): greeting with the
                          crest, quick actions, notices (questions due, missing briefs - confirmed first), cards (Continue
                          reading, Reading stats, Recently added, Recent notes, Research lines, Projects in the Editor,
                          Workspace health). Renders lazily, re-renders (debounced) on library / project / backup events while
                          shown; its own GETs are cached 60 s -> RT.overview: render(), show(). CSS: css/overview.css, all under
                          #view-overview, container query `ov` (12 / 6 / 1 columns)
public/js/icons.js        the Ginseng icon set (Purple Ginseng design system) (plain data: RT_ICON_DEFS, RT_ICON_ALIASES, plus the
                          icons drawn for this app in RT_ICON_ADDED). core.js renders it: RT.icon(name, cls | {size, duo, cls})
                          -> inline SVG `svg.ic` (stroke = currentColor; old names go through core's alias table); an unknown
                          name draws nothing, so check pages for an empty `svg.ic`
public/js/illustrations.js empty-state art -> RT.ill.emptyLibrary / emptySearch / emptyNotes / emptyInbox / onboardingImport /
                          onboardingWelcome / successCelebration ({size}); colours from --ill-* (css/illustrations.css).
                          RT.emptyState({ill, title, text, actions, compact}) in core.js wraps them
public/brand/             the crest (crest-shield.svg, crest-mark*.svg); favicon.svg / favicon-32.png / favicon.ico /
                          apple-touch-icon.png / app-icon-512.png in public/. The header crest is inline in index.html (its
                          rim follows --crest-rim); the wordmark stays "ResearchTool". Fonts are vendored (public/vendor/fonts,
                          css/fonts.css), nothing is fetched from the network
public/js/core.js         window.RT: helpers, event bus, view registry, Claude context, flushers, export + settings
                          (registerView: a view with an icon gets a .tab-label span beside it in its header button;
                          base.css unfolds it on hover / :focus-visible and keeps it out for the active view. The
                          Write view's header label is "Editor", and so are the Overview card and the Preferences pane; the
                          view id stays `write`)
public/js/project-papers.js which papers belong to which project and the working project -> RT.projectPapers (no UI of its
                          own but the project picker; see "Papers of a project" below). notesZip(ids, {pdf}) / readingPackZip(pid):
                          the paper-package downloads; askPdfs(ids) asks (POST export-zip estimate) when the PDFs are over
                          100 MB: with them / without them / cancel (#pk-dlg through RT.write.ui.openDialog)
public/js/claude.js       Claude panel
public/js/account.js      "Claude Code account" dialog (person button in the Claude panel): status, sign in, sign out
public/js/diagram.js      reader's Diagram tab: generate, hover cards, hand editing, layout -> RT.diagram
public/js/quiz.js         reader's Practice tab (quiz, flash cards) and the Review dialog of the Library list (#btn-review,
                          #dlg-review) -> RT.quiz: show(host, item), forget(id), review(pid | {project, name}?) (the
                          dialog's #rv-scope switch "All papers | “P”", remembered in localStorage rt.rv.scope)
public/js/guide.js        Guide dialog ("?" in the header): a short manual, one page per area; update it when the UI changes
public/js/safety.js       Backups window (Settings; workspace snapshots and the copies of library.json - it opens by itself when
                          library.json is damaged; server: lib/backup.js, and loadLib / saveLib / keepCopy / restoreLibBackup in
                          lib/core.js with copies in <workspace>/backups) and "Recently deleted" (bin button of the Library)
                          -> RT.safety: open(), trash(), deleted(bins, label) (delete message with Undo), putBack(bins)
public/js/figures.js      RT.figures: list(id), url(id, key, thumb), insertMarkdown(id, key, {language, desc}), place(id,
                          {baseHash, language, keys}), match(id, page, region), markdown(f, url, opts),
                          countPlaceholders(md), open(pop, opts) / close(pop) = the Figures picker of the reader's
                          notes toolbar (#btn-figures, #fig-pop; CSS public/css/figures.css), invalidate(id)
public/js/related.js      reader's Related tab + the "Check metadata" dialog (#dlg-meta) -> RT.related: show(host, item),
                          checkMetadata(item). Opt-in: a service is asked only after the Look up button (or with
                          localStorage rt.related.auto = 1); "Add" goes through the import queue (RT.library.addRef)
                          and, with "also add to “P”" (#rl-proj, localStorage rt.related.toProject = 1), into the
                          working project
public/js/lineage.js      the Lineage window (#dlg-lineage) -> RT.lineage: open({scope, category?, pid?, id?, ids?, label?}),
                          reopen() (B8), and the pure functions (also require()d by scripts/test-lineage.js): lanes and
                          layout (shortName, nodeLabel, laneOrder, timeScale, layout), titles and authors as text
                          (texPlain, authorName, isOrg, surname, authorList, authorsShort), table filters (venueType,
                          isSurvey, filterRows), add to project (splitForProject, projectTarget), badgesOf (Seminal /
                          Recent / Rising), ancestry (top 8 non-generic prior works cited by >= 2, citers per lane,
                          dominant ancestor, burst), customIds (a set of lines + words), BibTeX (protectTitle, bibEntry,
                          citeKey) and the grouped export (groupedRows, bulletList).
                          Scope select: the library, lines / sub-lines, projects, one paper, "Your sets" (custom sets in
                          localStorage rt.lineage.custom [{name, ids, lines, q}], the one-off 'adhoc' set) and "Custom
                          set…" (the .lg-pop popover; Esc closes only it). Left: the origin papers - before a
                          computation too (the ids of the 'none' answer) - with include boxes (.lg-incl; "Look up the
                          other N" = scope 'ids'). Centre: History line (SVG, sticky lane labels and axis, zoom / fit /
                          Cmd-wheel / Last 12 months; Citations: arrows between library papers, prior works as nodes;
                          Ancestry (rt.lineage.hmode): an ancestor column with bundles per lane, click an ancestor /
                          lane name to filter; SVG export with computed styles inlined) | Prior works | Derivative works
                          | Similar (tables: relevance sorts, chips with reasons, intents, badges, filters per tab in
                          rt.lineage.filters, row checkboxes and a selection bar, CSV / BibTeX / Grouped…; prior: "Top
                          foundations you don't have"; derivative: the young-line note and the recent works citing the
                          top ancestors). Right: details (GET /api/lineage/work for the abstract; prior works: POST
                          /api/lineage/contexts, further batches on "Ask about N more"; Add = RT.library.addRef). Add to
                          project: the target is projectTarget({picked, scope's pid, rt.lineage.toProject, working});
                          addToProject imports first when needed, one toast with Undo (RT.projectPapers.toggle); the
                          app's working project is never changed. Open in reader keeps {scope, tab, zoom, sel, scroll}
                          and shows #lg-back ("Back to Lineage"). Polls the job every second while it runs. Entry
                          points: #btn-lineage injected after #btn-regroup in the Library toolbar, the event
                          'lineage:open' (payload = the open() object; the Related tab's #rl-lineage, the category
                          header menu via RT.categories.headerExtras), RT.lineage.check(ids) ("Check lineage": the
                          Library row menu, the reader's #btn-rd-lineage beside the star / project bookmark, ⌘K "Check
                          lineage of this paper" / "Check lineage of…" via RT.palette.pickPaper; one id -> scope
                          'paper', several -> scope 'ids' "Selected papers"). A one-paper set starts its computation at
                          once when the cached answer's estimate is cheap (list <= budget, today + list <= 900). The
                          origin list is filled from the library at once (localIds(scope)); a filter that matches nothing
                          in the set lists the matching library papers outside it ("Check its lineage", "Add to “P”" for a
                          project's set). localStorage rt.lineage.tab / .scale / .prior /
                          .hmode / .labelW / .filters / .toProject / .custom
public/js/compare.js      "Ask across papers" dialog (#dlg-compare): saved tables, setup (columns or a question, papers, token
                          estimate), the table (page chips `.cmp-pg` open that paper at the page through RT.reader.reveal,
                          cell edit on double-click, columns, fill, export menu) -> RT.compare: open(), start(ids), show(id),
                          ICON. Entry points: #btn-compare and the selection bar of the Library list, the menus of a paper
                          and of a category, the Write toolbar ([data-cmd=cmptable]; "Insert" goes through
                          RT.write.ed.applyClaude and adds \usepackage{booktabs} to a preamble that lacks it). "New"
                          without a selection starts with the papers of the open Write project, else of the working
                          project (the first 15), and the category select offers them too
public/js/panes.js        drag handles that resize the Library list and the Claude panel (widths kept in localStorage)
public/js/palette.js      keyboard: "Go to anything" (Cmd/Ctrl+K, RT.palette.open(): papers by fuzzy title + the actions of the
                          screen - the buttons RT.tour.actions() names, and commands() in the file, the tour and its chapters among them) and the
                          single-key shortcuts ("/", J/K, 1-6 and Alt+1-6, PageUp/Down, + - 0, "?"), which never fire while typing, during
                          IME composition or under a dialog; the keys of the Library rows are in library-list.js
public/js/tour.js         Guided tour (Help › Take the tour / Tour of this screen, the palette's "Tour: …" entries, the
                          Overview's "Take the tour" notice): 8 chapters from the Overview to the Editor (Overview, Header,
                          Library, Reader, Notes, Claude panel, Explore, Editor). It switches views itself (RT.nav), opens
                          the paper read last / the latest project, shows the reader tab or the Claude panel a step is
                          about, waits for each control and lights it up; a control that is not on screen gets a centred
                          card, an empty library / no project one card per chapter. Card: "Chapter n/8 · step k/N", Back /
                          Next / chapter list / Skip, → ← Enter Esc. Changes no data: no reading position or "opened"
                          while it runs (body.touring), the projects home over an open project (RT.write.peekHome), a
                          project it opens is not compiled; puts the Claude panel, the reader tab and the Editor back. localStorage rt.tour.done / rt.tour.dismissed. DOM events tour:step {chapter,
                          chapterIndex, step, steps, id, index, total, found} and tour:end {completed, id}
public/js/tour-steps.js   the tour's script, data only (window.RT_TOUR {CHAPTERS, STEPS}; selectors, English text with
                          {mod}; Chinese in public/js/i18n/zh-tour.js) - update it when the UI changes. Tests: node
                          scripts/test-tour.js (ids, chapters, translations, selectors)
public/js/library-list.js Library tab, left pane          -> RT.library
                          Venues: a cache of GET /api/venues (fetched with every refresh, polled every 1.5 s while a check
                          runs; emits 'venues:changed'). Group by 'venue' (published by short name, most papers first, then
                          "arXiv preprint", then "Unverified / 未归类" = unverified, never checked or stale), sorts 'pubNew' /
                          'pubOld' (record date of a published / preprint record, else BibTeX year + month, undated last),
                          'year' grouping and sort use the verified year; #venue-bar (progress + Stop, or the counts and
                          "Check venues of N papers" while grouped by venue); row menu "Check venue again" (force).
                          RT.library.venue(id), venuesRunning(), checkVenues(ids | null, force) (used by the reader)
public/js/categories.js   category dialogs, menus, regroup -> RT.categories. RT.categories.headerExtras: other modules push
                          fn(name, {line, ids}) -> menu entries for the ⋯ of a category / line header. library-list.js
                          nests "Line / Sub-line" categories (.line-wrap[data-line] > .grp.grp-line, .sub-wrap[data-cat]
                          > .grp.grp-sub; keys 'line:<Line>' and 'category:<full name>')
public/js/organize.js     "Organize from a file" dialog (#dlg-organize) -> RT.organize: open({file?, text?, name?, pid?}).
                          Source: a file, pasted text or a .bib / .md file of the working project (GET only). Preview of
                          POST /api/organize/parse: one section per group (name editable, empty = no category change),
                          the papers found (ticked; current category; "N groups" when a paper is under several - the
                          first ticked named group wins as category) and the entries not found (with why). Apply: the
                          groups as categories (POST /api/categories/apply manual) or as tags (PUT /api/items/:id, max
                          12) or neither; the ticked papers to the project (RT.projectPapers.toggle); optionally first
                          POST /api/import/bibtex of the .bib entries not in the library. One toast with Undo (old
                          categories with their status / reason via /api/categories/apply restore, unless moved since;
                          the tags it added taken off; the papers it added to the project; imported papers stay, the
                          toast offers the Trash). A preview closed with edits comes back on open(). Choices in localStorage
                          rt-organize. Entry points: a picked or dropped .md in the Library (library-list.js enqueue),
                          the toast after a .bib import whose entries were at least half known already, the "Add papers
                          from a .md / .bib file…" entry of the project menus (projActions), the palette
public/js/pdfnav.js       PDF search + list of matches, link layer, table of contents, Back -> RT.pdfnav
                          (used by the reader's createPdfView and by the Write preview)
public/js/highlights.js   colour highlights on the reader's PDF: layer of marks, card, list -> RT.highlights
public/js/reader.js       Library tab, detail pane        -> RT.reader. The Details tab's "Links" (#rd-links, fillLinks: GET
                          /api/items/:id/links, no network; #btn-find-links: POST, network) lists project / code / arXiv /
                          DOI / publisher / other links with their source as hover hint, dead ones marked
public/js/texlint.js      spelling and writing checks for LaTeX source, no UI -> RT.texlint: scan(text, {off, known}) ->
                          problems [{type 'spell'|'repeat'|'tie'|'quotes'|'pairs'|'todo', from, to, msg, word?, fix?}]
                          (CodeMirror positions; comments, commands, math, verbatim and key arguments are not prose),
                          load() (the word list, once), checker([Set...]) -> {known(word), suggest(word)} (strips endings
                          and prefixes, accepts British spellings), RULES. Tests: node scripts/test-texlint.js
public/js/refscan.js      citation keys in LaTeX / BibTeX source, no UI, also required by lib/refcheck.js -> RT.refscan:
                          cites(tex) -> {uses [{key, line, ch, len}], all}, bibKeys(bib), bibitems(tex), near(key, keys)
                          (comments and verbatim text do not count). Tests: node scripts/test-refscan.js
public/js/write.js        Write tab: editor, PDF, history  -> RT.write (+ RT.write.ui dialogs/menus)
                          Citation keys: W.refs (GET /refs, reloaded after saves and compiles) + a live scan of the
                          open file -> marks of type 'cite' (undefined key in .tex, duplicate key in .bib) and a dot in
                          the 'ck-gutter' gutter; citeMenu (closest keys, pick an entry), refsDialog (References…)
                          It marks the problems of the open .tex file with markText 0.6 s after a change (right-click a
                          mark: corrections; F8: next), shows the words per section in the outline (GET wordcount after
                          each save) and the page / word limit of the project (#wc-total, #pdf-budget).
                          Papers of the open project: PP (GET /papers, reloaded after each refs load and on a
                          projects:changed that carries ids), the Papers dialog (.pp-dlg; [data-cmd=papers], "Papers of
                          this project…" in the project menu, RT.write.papers()), the project's papers first in the
                          cite picker (pickList items take group and mark) and in \cite{ completion
                          Library panel (#side-lib, W.ui.panel 'library'; rail button #rail-library, Shift+Cmd/Ctrl+L):
                          renderLib() lists RT.library.items() - the project's papers first (.wl-row.in-proj, marked),
                          then one group per line / sub-line - with search (#wl-q), multi-select (#wl-bar "Cite" ->
                          one \cite{a,b}), per row cite / add or remove (editMembers) / open in the Library; a row
                          drags as application/x-rt-cite + text/plain into the CodeMirror wrapper. citeKeys(keys, at?)
                          refuses an unplaced() cursor and any position on or before the \documentclass line
public/js/write-ai.js     Write tab: Claude in the editor -> RT.writeAi: menu(anchor), start(mode, instruction),
                          relatedWork(), wordDiff(a, b). One proposal at a time: the passage is a markText ('ai-old'), the
                          proposal a line widget (.ai-prop) under it with the word diff and Accept / Reject / Ask again;
                          the document is not touched before Accept. Accept and "Insert" go through
                          RT.write.ed.applyClaude(buf, edit): save what is there, make the change, save it with source
                          'claude' (PUT .../file accepts source 'auto' | 'claude', anything else is 'manual'). forget(buf)
                          is called by write.js when a file is closed, loaded again from disk or the project is left:
                          it stops the request and removes the proposal. The related-work dialog closes only after
                          the draft is saved in the file. A CLI result with is_error is always an error, never text.
                          With no Library selection the related-work dialog ticks the project's papers that have
                          something to write from and filters on "This project (N)" (#rw-cat value @project)
public/js/projects-home.js Write tab: projects home       -> RT.projectsHome (Papers column from GET /api/projects?lite=1)
public/js/overleaf.js     import dialog + sync control    -> RT.overleaf
public/css/*.css          fonts.css (@font-face only, linked before everything, the vendor sheets included), then base
                          (variables) and one file per module, in the order of index.html: illustrations, claude,
                          library-list, categories, pdfnav, highlights, reader, figures, diagram, quiz, compare, related,
                          lineage, write, write-ai, projects-home, overleaf, guide (also the tour and the Backups / Recently
                          deleted windows), palette, organize, prefs (also the theme override), tips, overview, and last
                          type (the element -> font role map)
public/vendor/            third-party libraries (never a CDN at runtime)
```

Scripts load in this order: `ui-boot` (in `<head>`), vendor, `icons`, `core`, `illustrations`, `i18n/zh-*`, `i18n/zh`,
`i18n`, `prefs`, `tips`, `project-papers`, `claude`, `library-list`, `categories`, `organize`, `diagram`, `quiz`, `compare`,
`related`, `lineage`, `pdfnav`, `highlights`, `figures`, `reader`, `texlint`, `refscan`, `write`, `write-ai`, `projects-home`,
`overleaf`, `account`, `guide`, `tour-steps`, `tour`, `palette`, `overview`, `panes`, `safety` (the CSS order is in the
module map; index.html is the authority). Each module is an IIFE that builds its markup inside its container **when the script
runs** and attaches its API to an `RT.<name>` object created with `RT.x = RT.x || {}`. A module that loads earlier
must only call a later module at event time, guarded: `if (RT.overleaf && RT.overleaf.mountSync) ...`.

## Backend

### Router and `ctx`

`server.js` applies the security gate, serves non-`/api` paths from `public/`, then calls
`await mod.handle(ctx)` for every `lib/routes/*.js` (sorted by file name: account, backup, categories, claude,
compare, diagrams, drafting, figures, highlights, library, lineage, notes, overleaf, projects, quiz, related, search, trash, venues) until one
returns `true`. Nothing handled -> `404 {"error":"Unknown endpoint"}`.
A thrown error becomes `{error: e.message, ...e.extra}` with status `e.status || 500`.

```
ctx.req, ctx.res         node request / response
ctx.url                  URL object            ctx.query = url.searchParams
ctx.path                 decoded pathname, e.g. '/api/items/ab12/notes'
ctx.segments             ['api','items','ab12','notes']
ctx.method               'GET' | 'POST' | 'PUT' | 'DELETE' ...
await ctx.json()         parsed JSON object body ({} if empty; 415 unless Content-Type: application/json; 400 if invalid)
await ctx.body(limit?)   raw Buffer body (default limit 200 MB; 413 beyond)
ctx.send(code, data, type='application/json')   -> true   (so: return ctx.send(200, {...}))
ctx.sendFile(file, type?, headers?, afterClose?) -> true   (404 JSON if missing)
ctx.core                 require('./lib/core')
```

Add a route (in your own file under `lib/routes/`; restart the server to load it):

```js
const core = require('../core');
async function handle(ctx) {
  const { path: p, segments: seg, method: M } = ctx;
  if (p === '/api/categories' && M === 'GET') return ctx.send(200, { categories: [] });
  if (seg[1] === 'items' && seg[2] && seg[3] === 'notes' && M === 'PUT') {
    const body = await ctx.json();
    if (typeof body.markdown !== 'string') throw core.httpErr(400, 'markdown must be a string');
    return ctx.send(200, { ok: true });
  }
  return false;            // not mine: let the next module try
}
module.exports = { handle };
```

Order matters only for overlapping paths: `library.js` answers `404 No such item` for any `/api/items/<unknown id>/...`
and returns `false` for sub-paths it does not know when the item exists (so `notes.js` can own `/api/items/:id/notes`);
`projects.js` answers `404 No such project` for unknown ids and handles paths up to 6 segments; `overleaf.js` runs
before `projects.js`, so it can own e.g. `/api/projects/:id/overleaf/...` or `/api/overleaf/...`.

Rules: never a shell (`core.run(cmd, [args])` / `spawn(cmd, [args])` only); never hard-delete user files (move to
`<workspace>/trash` with `core.moveToTrash` / `P.trashFile`); every project file path from a request goes through
`P.resolveIn(project, rel)`; ids used in file names must be validated (look the item / project up first).

Paper text for prompts: `notes.paperText(item)` / `notes.paperExcerpt(item, query)` read the PDF text through
`lib/textcache.js`, so pdftotext runs once per PDF file (import and attach store the text, `POST /api/items/:id/opened`
warms it, replacing the PDF or deleting the item drops it); never call pdftotext for a library PDF directly.
`core.recordUsage(feature, resultJson)` logs tokens, cost and the call's `duration_ms` (as `ms`) to
`cache/ai-usage.jsonl`; `core.usageSummary()` sums them per feature for the Settings window (calls, tokens, time per call).

### `lib/core.js` exports

| Export | What |
| --- | --- |
| `PORT, ROOT, PUBLIC, WS` | port, repo root, `public/`, workspace dir |
| `DIRS` | `{pdfs, sentences, projects, export, history, cache, trash}` absolute paths (created at start). Other folders (e.g. `notes/`): `path.join(WS, 'notes')` + `fs.mkdirSync(..., {recursive:true})` |
| `LIB_FILE, SETTINGS_FILE` | `library.json`, `settings.json` |
| `readJSON(file, fallback)`, `writeJSON(file, data)` | tolerant read; atomic write (tmp + rename) |
| `loadLib()` -> `{items:[...]}`, `saveLib(lib)` | library.json (re-read on every request). A missing file is an empty library; a file that exists but is not a library is "damaged": both throw 503 `{damaged: true}` and nothing is written. `saveLib` also refuses an empty library over one of 5 or more items, and calls `keepCopy()` first. Always use these two, never write the file yourself |
| `keepCopy(force?)`, `listLibBackups()`, `restoreLibBackup(name)`, `libState()` | copies of library.json in `<workspace>/backups/library-<date>-<time>.json` (at most one per 10 minutes; newest 30 + one per day for 60 days), the list of them, putting one back (the replaced file is kept as `library-replaced-<time>.json`), `{damaged}` |
| `claudeArgs('light' \| 'heavy', {tools, allowed, stream, partial})` | the flags of every `claude -p` call: no tools unless named, no MCP, no session, effort and model from the "Claude usage" mode. `aiMode()` -> `'economy' \| 'balanced' \| 'quality'` (`AI_MODES`) |
| `teachStyle()`, `TEACH_DEFAULT`, `citeRule(language)` | the user's "How Claude explains" text (settings `teachStyle`, else the built-in one) - put it into every prompt that explains something; the fixed page-citation rule |
| `recordUsage(feature, resultJson)`, `usageSummary()` | one line per AI call in `cache/ai-usage.jsonl`; sums for the Settings window. Features today: `chat`, `grouping`, `brief`, `key-points`, `draft`, `ask`, `translate`, `diagram`, `diagram-explain`, `quiz`, `compare`, `rewrite`, `related-work` |
| `loadSettings()`, `saveSettings(obj)` | whole settings.json object (`exportDir` defaulted). Other keys live in the same file (`externalProjects`, `projectSettings`, `projectsV2`, `overleafLinks`, `aiMode`, `teachStyle`, `backupDir`, `backupAuto`): always read-modify-write the whole object |
| `newId()` | 10 hex chars |
| `safeName(s)` | `[A-Za-z0-9_-]`, max 60 |
| `stamp()` | file-name-safe ISO timestamp |
| `allBibtex(lib)` | whole library as BibTeX |
| `moveToTrash(src, ...parts)` | move a file/folder to `<ws>/trash/<parts>`; returns the new path |
| `run(cmd, args, {cwd, input, timeout=60000, env})` -> `{code, out, err}` | never rejects; `code -1` = could not start |
| `claudeEnv()` | env for a child `claude` process |
| `readBody(req, limit)`, `readJsonBody(req)` | as `ctx.body` / `ctx.json` |
| `send(res, code, data, type)`, `sendFile(res, file, type, headers, after)`, `attachment(name)` | HTTP helpers; `attachment` returns a Content-Disposition header object |
| `MIME` | extension -> content type used for static files |
| `httpErr(status, msg, extra)` | error the router turns into a JSON response |
| `normRel(rel)`, `kindOf(abs)`, `mimeOf(abs)`, `expandHome(p)`, `inside(root, p)`, `MAX_TEXT` | path / file helpers from lib/projects.js |
| `P` | the projects instance (`P.list() listLite() get(id) create(name) openFolder(path) remove(project) setSettings(project, patch) papers(project) editPapers(project, {add, remove}) live(list, items?) resolveIn(project, rel) listFiles(project, cap) trashFile(project, r) move(src, dest) stamp()`) |
| `H` | the history instance (`H.open(pid)` -> `{record, commit, newest, find, files, blob, text, prevOf, touch}`, `H.list(pid, file, limit)`, `H.rename`, `H.pub`, `H.dir`) |
| `sha1(buf)`, `claudeActive`, `diskSource(project)`, `snapshotProject(project)`, `recordClaudeChanges(project, snap)` | history plumbing shared with the Claude route |
| `BIB_MARKER`, `TEMPLATE` | first line of a generated references.bib; new-project main.tex |
| `writeWorkspaceGuide()`, `migrate()` | called once by server.js |

Data shapes: item = `{id, citekey, type, fields{}, pdf, pdfName?, pages?, metaSource, keypoints[{id,text,page,category,note,s?}],
keypointSource, added, textFound?, fileHash?, category ("Uncategorized" by default), tags[], categoryStatus?
('pending'|'done'|'failed'|'manual'), categoryReason?, categoryError?, brief? (a sentence or two shown in the list),
briefStatus? ('pending'|'failed'), briefError?, briefBy? ('user' = typed by hand, never replaced by a grouping call), status? ('unread'|'reading'|'done'; absent =
to read), starred?, lastOpened? (ISO), reading? {page, frac, zoom}}`. `status`, `starred` and `reading` are set with
`PUT /api/items/:id`; `POST /api/items/:id/opened` (sent by the reader when the user opens a paper) stamps
`lastOpened` and gives a paper that has no status yet the status `reading`. `reading` is where the PDF was left: the page shown
in the page box, the part of its height scrolled past (may be negative), and the zoom (`null` = fit width); the reader saves it a
moment after the PDF moved and when the paper is left, and `createPdfView(host, item, hooks, start)` restores it.
The id of the open paper is kept in localStorage `rt.reader.last` and opened again at start. A page reference in a
note is the Markdown link `[p. 7](#rt-page=7)`; the note editor (Vditor `link.click`, and a click handler on the split
preview) and the page chips of key points / sentences call `showPage(n, text)` in reader.js, which jumps the PDF and
lights the passage up (`pdfView.flash`).
`RT.pdfnav.create(adapter)` (pdfnav.js) is the navigation both PDF viewers share: each viewer still draws its own pages
and calls `nav.decorate(n, page)` after a page is drawn (link anchors from `page.getAnnotations()`, marks of the running
search), `nav.changed()` when another document is loaded into the same view (a recompile) and `nav.destroy()`. The
adapter tells it `doc() pages() pageEl(n) top(n) scale() ready(n) active()`; the toolbar markup comes from
`RT.pdfnav.controls(prefix, buttonClass)` (ids `<prefix>-search`, `-hits`, `-hit-prev`, `-hit-next`, `-hit-list`,
`-outline`, `-back`). Search works on one string per page built by `model()` (white space collapsed, a line-end
hyphen kept as an optional joiner) from the pdf.js text items, and the same function over the spans of a drawn text
layer places the `<mark class="pn-hit">` elements. Jumps (link, contents, match list, page link of a note) push the
place they start from on a back stack. There is no `notes` field any more: the note
is `<workspace>/notes/<id>.md` (images in `notes/assets/<id>/`); a legacy `notes` string is moved into that file by
`notes.readNote(id)` (first open, or "Export references") and removed from the item.
project = `{id, name, path, external, mainFile, compiler, missing, updatedAt (ISO, newest file mtime),
overleaf: {projectId, url, lastSync} | null, budget: {pages, words, skipRefs}, checksOff: [rule ids], bibScope: 'cited' |
'all' | 'project'}` (the project dictionary and the papers are not part of it: `P.words(project)`,
`P.editWords(project, {add, remove})`, `P.papers(project)`, `P.editPapers(project, {add, remove})`); `overleaf` is `settings.json` `overleafLinks[id]` passed through as is
(never store a secret there). Renaming a project moves its link, removing a project drops it.

`RT.highlights.create(adapter)` (highlights.js) keeps the colour highlights of the reader's PDF. A highlight is
`{id, page, text, color ('yellow'|'green'|'blue'|'pink'), comment, kind ('mark'|'quote'|'kp'), kp?, rects}`; a rect is
`[page, x, y, w, h]` in parts (0..1) of the page's width and height, taken from the client rects of the selected text
nodes (the pieces of one line merged), so the marks fit at every zoom. `createPdfView` calls `hl.draw(n)` when page
`n` has been drawn; the marks go into a `.hl-layer` between the canvas and the text layer (`pointer-events: none`,
so selecting text still works - a click on a page is hit-tested against the rects). "Quote in notes" and "Add as key
point" call `hl.add()` with `kind` and, for a key point, its id in `kp`. Key points that have no highlight are found
in the text layer (`passages(n, texts)` of the viewer, the matcher `flash()` uses) and underlined; `renderKps()`
calls `pdfView.highlights.redraw()`. The file moves to the trash with its item, and when the PDF is replaced. Changes are sent one
after the other (`serial()`), and the route reads the request body before the file, so a late answer never undoes a
newer change; a highlights file that cannot be parsed is put aside in the trash instead of being overwritten.

"Ask Claude" is `POST /api/items/:id/note/ask` `{mode, question?, kind, text, asset?, page?, language?}` -> `{text}`
(`notes.askAbout`). `mode` is `explain | foundations | meaning | example | ask | translate`; `kind` says where the part
comes from: `text | block | table | image` (the note's right-click menu) or `pdf` (a selection on page `page` of the
PDF: the note is not sent, and the passages of that page go first in the excerpt). `translate` sends the passage alone -
no paper text, no teaching style. The PDF side lives in `createPdfView` (reader.js): the sparkle of `.rd-selpop`
(and `.rd-snappop`, shown beside a region for a few seconds after a snapshot) opens the menu `.rd-aimenu`; the answer
is shown in the card `.rd-aipop`, and "Add to note" goes through the hooks `quote()` and `note(markdown)`.
Page citations: `core.citeRule(language)` is a fixed prompt rule (not part of the editable teaching style) used by
`askAbout`, `diagrams.explain`, the "explain" fields of generated diagrams and quizzes, and the Claude panel when a
paper with a PDF is open: paper-based claims end with `(p. N)`, the rest with `(general knowledge)`. On the page,
`RT.cite(html)` (already-safe HTML, text outside tags only), `RT.cite.dom(root)` and `RT.cite.md(text)` (-> the note's
`[p. N](#rt-page=N)` links) turn them into `.pcite` chips; one capturing click / key handler in core.js calls
`RT.reader.page(n)`. Inside the note editor the content is not changed: plain "(p. N)" in an `[!ai]` callout is
painted with the CSS Custom Highlight API (`::highlight(rt-pcite)`) and hit-tested on click.

Workspace folders (all under `core.WS`; the README table "Where things live" describes them for the user):
`library.json`, `settings.json`, `venues.json` (`{v: 1, items: {itemId: venue record}}`, lib/venues.js; records of deleted
papers stay for a restore), `pdfs/`, `sentences/`, `notes/` (+ `notes/assets/<id>/`), `highlights/`, `diagrams/`,
`quizzes/` (quizzes, answers and the `review` map), `compare/`, `projects/`, `history/`, `history-notes/`, `export/`,
`backups/` (copies of library.json), `trash/` (`library/<id>-<time>/` = a deleted paper, `compare/`,
`before-restore-<time>/`), `cache/` (`text/`, `figures/`, `related/`, `lineage/`, `pmlr/`, `ai-usage.jsonl`, preview PDFs - never backed up, safe to
delete). The full-text index is in memory only.

Cross-module backend hooks: `lib/routes/library.js` calls `notes.exportNotes(dir)` / `notes.fileKey(item)` /
`notes.readNote(id)` in "Export references" and moves `notes/<id>.md` + `notes/assets/<id>/` to the trash when an item
is deleted. Environment: `RT_WORKSPACE`, `PORT`, `RT_BURST_MS`, `RT_OVERLEAF_GIT_BASE`, `RT_OVERLEAF_NET_TIMEOUT_MS`,
`RT_OVERLEAF_CLONE_TIMEOUT_MS`, `RT_CATEGORIZE_TIMEOUT_MS`, `RT_REGROUP_TIMEOUT_MS`, `RT_REGROUP_CHUNK`, `RT_BRIEF_BATCH` (papers per brief call), `RT_BACKUP_FIRST_MS` (delay of the first automatic backup check, default 90 s).
`DELETE /api/items/:id` answers `{ok, bin}`; `POST /api/trash/<bin>/restore` is its Undo.

### Papers of a project

Membership is `settings.json` `projectSettings[pid].papers = [{id, added (ISO)}]` - item ids, in the order they were
added. `P.editPapers` is one read-modify-write per call: ids are de-duplicated, added ids are checked against
`loadLib().items` (unknown ones are ignored and reported), at most 1000 papers. Ids of papers in the trash stay
stored (putting the paper back reconnects it) and are left out of what the routes return (`P.live`). Renaming a
project re-keys the entry; removing an external project keeps only its `papers` (the folder gets the same id when it
is opened again), removing an internal one drops the whole entry. A row of GET papers is `{id, citekey, title,
author ('Nadeau et al.'), year, status ('unread' | 'reading' | 'done'), starred, added, cited, citedCount, hasNote,
highlights, quiz {answered, correct, due}, pages, readingPage}`; `cited` is an explicit cite (case-blind, .tex + the
last .aux / .bcf, `projectCited(project, files)` shared with projectRefs; `\nocite{*}` only sets `nociteAll`),
`citedCount` counts the `\cite` uses in the .tex files, `quiz` comes from `quiz.stats(id)`, `highlights` from
`count(id)` of lib/routes/highlights.js (read-only). The reading pack is written to `<exportDir>/<name> - reading
pack/` (400 when that is inside the project folder): `reading-list.md`, `references.bib`, `notes/` through
`notes.exportNotes(dir, {ids})`; the `notes/` of an earlier pack goes to `trash/reading-pack/<pid>-<stamp>/`.
`POST /api/projects/:id/reading-pack?format=zip` writes the same pack into a scratch folder of `cache/note-export/`
(packages with `index: false`: reading-list.md is the one index, with notes.indexLine per paper; references.bib once)
(`readingPack(project, {into})`: no overlap check, nothing trashed, an ASCII top folder `<name> - reading pack` since
zip(1) does not flag UTF-8 names; the download keeps the real name) and sends it as a .zip, removed after sending -
also when the client left while it was being built (core.sendFile runs `after` for a response already closed), and
leftovers older than an hour are swept at start. PDFs go into the scratch folder as hard links (copy when the disk
refuses) and zip stores them with `-n` (no deflate). The front matter leaves dead links out and an unconfirmed Hugging Face repo out of the whole package
(`unreachable:` lists the dead ones); `<key>.bib` is the library entry as it is, with a `%` comment above it naming
the published version when the venue check verified one the entry does not name (notes.bibOf).
Note export routes (lib/routes/notes.js): `GET /api/items/:id/note/export?format=md|md-embedded|zip|json[&widths=html][&pdf=0|1][&links=0|1]`
and `POST /api/notes/export-zip {ids, widths?, pdf?, links?, estimate?}` (paper packages; bulk adds README.md +
references.bib; `estimate: true` -> packageEstimate); `POST /api/projects/:id/reading-pack?format=zip[&pdf=0][&links=0]`
puts one package per paper in the pack (reading-list.md links them) instead of notes/. md-embedded starts with the
header (no front matter, the arXiv PDF link, links found so far - no network). The zips answer `X-RT-Papers` /
`X-RT-Notes` / `X-RT-Pdfs` / `X-RT-Missing` (pictures missing on disk) / `X-RT-Assets` (files in assets/), md-embedded (400 for an empty note) `X-RT-Images` / `X-RT-Missing` / `X-RT-Omitted` (videos). The client saves them through
`RT.downloadFile(url, opts)` (public/js/core.js: fetch, also POST, -> {name, size, headers}). Menus: the note menu's
"Export paper package (.zip)" and "… without the PDF" (pdf=0), the Library's right-click "Export paper packages of N
papers (.zip)" / "… without the PDFs" and the selection bar's zip button (RT.projectPapers.notesZip), the project menus'
"Download reading pack (.zip, paper packages)" (readingPackZip); the bulk ones ask first over 100 MB of PDFs. "Copy note for another
app" fetches md-embedded and writes a ClipboardItem of text/plain + text/html (Lute's Md2HTML of the note editor),
or text only without ClipboardItem.
Tests: `node scripts/test-project-papers.js` (a temporary workspace).

`RT.projectPapers` (public/js/project-papers.js) caches GET /api/memberships, fetched again on `projects:changed`
(unless it sent it), `library:changed` and window focus (at most every 10 s):
- `load()`, `refresh()`, `loaded()`; `projects()` (the lite list), `project(pid)`; `has(itemId, pid = working)`,
  `of(itemId)` -> [pid], `members(pid)` -> Set.
- `working()` -> `{id, name} | null`: localStorage `rt-working-project` (`{id, name}`), else `rt-project`, else the only
  project; null before the first load and when the id is gone. `setWorking(pid)`.
- `toggle(ids, {pid?, on?, quiet?})` -> `{pid, ids (the ones that changed), on} | null`: adds unless all are members
  already, toast with Undo, then `projects:changed {pid, ids, on}` and `memberships:changed`. With no project at all it
  says `NO_PROJECT` ("Create or open a project in the Write tab first"). Never deletes a paper.
- `pick({title, x?, y?, current = true})` -> pid | null (a `RT.categories.menu`); `papers(pid, {fresh})` (cached GET
  papers), `papersNow(pid)`; `readingPack(pid)` (flushes the reader first, toast); `openInWrite(pid)`; `ICON` (bookmark).

Other localStorage keys: `rt.lib.show` (the Library filter chip: status, starred or noPdf), `rt.ui.startView` (`library` |
`overview` | `last`, set in Preferences › General), `rt.lib.group` may be `project`, the collapsed-group key `project`, `rt.related.toProject`,
`rt.rv.scope` (`all` | `project`). The reader keeps one "Finished reading?" toast per paper per session (last page,
a note of more than 40 characters, status not done); `pdfView.pages()` is internal to reader.js.

### Figures (lib/figures.js)

A heuristic, measured on the papers of a real library (see the test script and the commit message), in four steps:

1. `pdftotext -bbox-layout` -> pages / blocks / lines with boxes (`parseLayout`). Two columns that pdftotext read as
   one line per row are cut at the gutter (`splitGutter`); two captions standing side by side that it read as one
   block are cut apart (`splitSideCaptions`).
2. Captions (`captionOf`, `findCaptions`): a block that opens with "Figure 3:", "Fig. 3.", "TABLE II", "图 3" ...; a
   line inside a block only when the wording is certain and the line starts something new. Sentences such as
   "Figure 3 shows ..." are not captions. Caption lines read as separate blocks are joined to it. A bare label
   ("TABLE I", "Table 2") counts only alone on its row with a title below it ("Table2" as a column head does not), and
   a weaker wording loses against a certain caption of the same number on the page before any region is made.
2a. Tables by their rules (`findRules`, `findFrames`, `frameFor`, raster): two or more thin horizontal rules of the
   same extent are a frame. A table caption with a frame right above or below it takes that frame as its table (the
   side the paper's unambiguous captions use, each frame once), grown towards rows that follow without a wide white
   band (a table with shaded rows instead of a bottom rule). This is exact where the layout is not: wrapped cells that
   look like a text column, several tables on a page, a heading right below, a table wider than its column. Frames
   (and "Algorithm N" floats) are obstacles for every other region, and their cells are never body text.
3. Region (`xRange`, `sideRegion`): above the caption for a figure, below it for a table (the other side when only
   that one holds something; where both do, the side the unambiguous captions of the paper use), in the caption's
   column or across the page, up to the nearest body text (`classifyPage`: justified paragraphs, headings), other
   caption or running header / footer. Small text blocks (axis labels, sub-figure labels, table cells) are not body.
4. Raster (`pdftoppm -gray -r 60`, PGM, a summed-area table of the ink): the ends of the region are moved off the
   letters (`inkEdge` - some fonts report wrong heights), strips of plain body text at the far end are cut (`refine`),
   a table shared with a figure is divided at the widest white band, and the box is trimmed to the ink plus 3 pt.
   A narrow caption of several lines with nothing above or below has its picture beside it (`besideRegion`).
   Where the ink reaches the limit of the look-aside the nearest white column is the border (floats side by side, a
   neighbour reaching into the gutter); a region is widened across the gutter only when the picture goes on in the
   neighbouring column.
5. Confidence says how sure the CROP is, not how the caption is worded. `quality()` drops empty or text-only regions;
   the final box is then checked: ink running on across its left / right edge (`edgeCut`), lines of running text
   inside a figure, another caption inside, overlap with another crop of the page, the unusual side of the caption
   without a clear lead from the paper, a table / figure pair that could not be divided, no raster. Any failed check
   caps the confidence at 0.4 and is named in `why`; softer doubts (divided pair, widened, beside the caption, a
   table grown beyond its rules) cap it at 0.7. Below `MIN_PLACE` (0.5) a crop is offered in the picker (dashed
   frame, the reason in the tooltip) but never placed into a note unasked: a wrong picture in a note is worse than a
   placeholder left in place. Tiny final boxes are dropped.
   Memory: at most 120 pages are rasterised (about 1.4 MB each while the analysis runs), a poster-size page at a
   lower resolution; a PDF that cannot be read is cached as an empty list (`failed`) until the file changes or the
   picker's "Look again" asks for a new analysis.

The crop never contains the caption (the note line under the picture carries the description). In a note a figure is
`![Figure 3](/api/items/<id>/note/assets/<sha1>.png#w=680)` + newline + `Figure 3：<description> [p. 5](#rt-page=5)`
(`figureMarkdown`; the same shape as a snapshot). The asset is content-addressed, so the same crop is stored once.
`notes.generateDraft` gives Claude `promptList()` ("FIGURES AND TABLES FOUND IN THE PDF"), runs `place()` on the
cleaned draft before it is saved (a failure keeps the draft as written; once Claude has finished the draft is saved
even if the page went away meanwhile) and reports `figures: {placed, missed}` in the `done` event. A placeholder is
filled only when it OPENS with one figure or table ("Figure 3（…）"; not "Algorithm 1, beside Table 3", not
"Figure 3-5") and stands outside code fences, HTML comments and `$$` blocks. In the Balanced mode the draft prompt
also says where the main body ends (`notes.bodyPages`), so the pages of the reference list are not read; it is
"lean" (`draftPrompt({lean})`): the extracted text is not sent with the pages, and when Claude answers `READ_FAILED`
(or nothing usable) `generateDraft` runs once more with the text (Economy: text only; Best quality: pages and text). In
Balanced and Economy the list names only the figures of the main body. `notes.askAbout` adds the paper's caption
(`captionFor`, cache only - a question never waits for an analysis) and looks for passages on the figure's page when
the part in question names a figure. The snapshot tool labels a region that matches a known figure like a placed one
(`RT.figures.match`). Deleting an item or replacing its PDF calls `figures.drop(id)`.
`POST /api/items/:id/note/figures {baseHash?, keys?, language?}` fills the placeholders of the saved note and writes
it with `baseHash` = the note it read (409 `{conflict, content, hash}` like `PUT .../note`); the page saves first and
adopts the answer.

### Static files and the security gate

`*.html` is served with `Content-Security-Policy: script-src 'self' 'unsafe-eval' blob:; ...`: no inline `<script>`, no inline
event-handler attributes, no `javascript:` URLs. Write handlers with `addEventListener`; load vendor scripts by `src`
(`RT.vendor.vditor()` preloads Vditor's icon script for that reason). Note HTML is additionally scrubbed in `reader.js`.
Note versions live in their own history store `<workspace>/history-notes/notes` (not under `history/<projectId>`).
Project file paths with a `.git` segment are refused by `P.resolveIn`; `lib/overleaf.js` checks `.git/config` against an
allowlist before every git command (409 `unsafeConfig` otherwise). `RT.library.importDrop(event)` imports a file drop
that another module caught.

Anything under `public/` is served at its path (nested folders fine, dotfiles refused, `..` cannot escape), always with
`Cache-Control: no-store`. Known types: html js mjs css json map txt md svg png jpg gif webp ico woff woff2 ttf otf eot
wasm pdf (others: `application/octet-stream`).

Gate (keep intact): `Host` must be `localhost|127.0.0.1|[::1]:PORT`; an `Origin` header must be the app's own;
`/api` requests with `Sec-Fetch-Site` other than `same-origin`/`none` are refused; every non-GET/HEAD `/api` request
needs header `X-RT: 1`. `RT.api()` adds it; raw `fetch` / curl must add it themselves.

## Front end

### `RT` helpers (public/js/core.js)

| Helper | Signature / behaviour |
| --- | --- |
| `RT.$(sel, el=document)` / `RT.$$(sel, el=document)` | querySelector / querySelectorAll as array |
| `RT.esc(s)` | HTML-escape; use on everything interpolated into `innerHTML` |
| `RT.api(url, opts)` -> Promise<json> | fetch with `X-RT: 1`; `opts.json` = JSON body; raw bodies via `opts.body` + own `Content-Type`; rejects with `Error{message, status, data}` on non-2xx |
| `RT.toast(msg, kind='', action?)` | header message; kind `'ok'` or `'bad'`; clears after 9 s. `action` = `{label, icon='undo', run}` adds one icon button after the message (Undo; 20 s) |
| `RT.confirm(message, {title, okText, danger, icon})` -> Promise<boolean>, `RT.ask({title, message, value, okText, icon})` -> Promise<string or null> | the styled in-page dialogs of write.js (`RT.write.ui`), for every module, at event time; use them instead of `confirm()` / `prompt()` |
| `RT.debounce(fn, ms)` -> `d` | `d(...)` delays, `d.flush(...)` runs now and returns fn's result |
| `RT.enc` | `encodeURIComponent` |
| `RT.ls.get(k, default)`, `RT.ls.set(k, v)`, `RT.ls.json(k, default)` | localStorage that never throws |
| `RT.authorsShort(authorField)` | "Smith & Doe", "Smith et al." |
| `RT.cite(html)`, `RT.cite.dom(root)`, `RT.cite.md(text)`, `RT.cite.find(text)` | page citations "(p. 4)" of an explanation -> clickable page chips / note page links; see "Page citations" |
| `RT.loadScript(src)`, `RT.loadCss(href)` -> Promise | load once (CSS is inserted before the app's style sheets) |
| `RT.vendor.vditor()` -> Promise<Vditor>, `RT.vendor.VDITOR_CDN` | lazy-load Vditor; see "Vendored libraries" |
| `RT.on(ev, fn)` -> unsubscribe fn, `RT.off(ev, fn)`, `RT.emit(ev, data)` | event bus; a failing listener is logged and never breaks the emitter |
| `RT.state` | `{ view: 'library'|'write'|..., sel: <open item id or null>, status: {pdftotext, latexmk, claude, workspace} }` |
| `RT.registerView({id, title, order=100, onShow, onHide, onDrop})` -> view | adds a header tab; see below |
| `RT.setView(id)`, `RT.views` (Map) | switch tab |
| `RT.claudeContext.register(viewId, fn)`, `.current()`, `.refresh()` | see below |
| `RT.addFlusher(name, fn)`, `RT.flush(...names)` -> Promise<boolean> | "save what is pending" hooks; `flush()` runs all (used before a Claude prompt), `flush('reader')` before export. A flusher returns `false` if something could not be saved. Registered: `'reader'`, `'write'` |

Module APIs:
- `RT.library`: `items()` -> current array (the objects are edited in place by the reader; `refresh()` merges into the
  same objects), `refresh()` -> Promise, `select(id)` (highlight + emit `item:open`), `render()`, `importPdfs(File[])`,
  `importBibtex(text)`, `importRefs(text)` -> false when the text holds no arXiv id / DOI / link, `addRef(ref)` -> Promise<{state: 'imported' | 'dup' | 'failed', itemId, dup, error}> (one reference through the import queue), `selection()`, `moveTo(ids, category)`, `categorize(ids)`.
- `RT.categories`: `UNCAT`, `color(name)`, `names()`, `ask(opts)`, `menu(x, y, entries)`, `headerMenu`, `rename`,
  `remove`, `regroupDialog()`.
- `RT.reader`: `open(id)`, `close()`, `current()`, `dirty()`, `render()`, `insert(markdown)`, `editor()`, `saveNote()`.
- `RT.write`: `openProject(id, {compile, remember})` (false: no compile on open / not the working project - the tour),
  `peekHome(on)` / `peeking()` (the projects home over the open project, which stays open), `flushAll()` -> Promise<boolean>, `currentProject()`, `sync()` (reload tree + clean
  buffers from disk), `compile()`, `showHome()`, `mode()` ('home' | 'project'), `ui` (`ic, menu, popover, pickList, ask,
  confirmDlg, openDialog, download, closeMenus`: in-page dialogs and menus, also used by projects-home), `ed` (`cm, ok(),
  activeBuf(), applyClaude(buf, edit), insertBlock(lines)`: the editor, for write-ai.js).
- `RT.reader` also has `reveal(id, hit)` (open a paper at a full-text hit, a page or a key point - used by the search
  results, the comparison tables and the Review), `page(n)` (jump the PDF of the open paper), and for the keyboard
  `tab(name)`, `tabNow()`, `pdfScroll(dir)`, `pdfZoom(dir)`, `hasPdf()`. `RT.library` also has `setStatus(ids, patch)`,
  `STATUS`, `statusOf(item)`, `writeBriefs(ids?)`, `step(dir)`, `focusList()`, `focusSearch()`.
- `RT.quiz`: `show(host, item)`, `forget(id)`, `review()` (the Review dialog). `RT.diagram`: `show(host, item)`, `forget(id)`,
  `rich(text)` / `renderMath(el)` (text with `$formulas$`, shared with the quiz).
- `RT.related`: `show(host, item)`, `checkMetadata(item)`. `RT.lineage`: `open({scope: 'library' | 'category' | 'project' |
  'paper' | 'ids', category?, pid?, id?, ids?, label?})`, `reopen()` (the window as "Open in reader" left it), `ICON`,
  and the pure functions listed under public/js/lineage.js. `RT.pdfnav`: `create(adapter)`, `controls(prefix, cls)`.
  `RT.highlights`: `create(adapter)`, `control(prefix)`.
- `RT.safety`: `open()` (Backups window), `trash()` (Recently deleted), `deleted(bins, label)`, `putBack(bins)`,
  `backupState(el)`. `RT.palette`: `open()`, `close()`, `pickPaper({placeholder, icon, run(item)})` (the box for a paper only). `RT.tour`: `start({chapter (id or 1-8), step (id)})`, `end()`, `next()`, `back()`, `goTo(stepId)`, `active()`, `current()`, `steps()` (the whole script, for the demo recorder), `chapters()`, `seen()`, `dismiss()`, `forChapterOfView()`, `actions()` (the buttons the palette runs by name).
  `RT.guide`: `open(page?, at?)`. `RT.account`: `open()`, `status()`.
- `RT.compare`: `open()` (the saved tables), `start(ids)` (set up a table or a question for these papers), `show(id)`.
- `RT.projectPapers`: see "Papers of a project" below. `RT.write` also has `papers()` (the Papers dialog) and
  `rekeyProject(oldId, {id, name} | null)` (re-keys or clears localStorage `rt-project` and `rt-working-project`
  after a rename / remove; projects-home calls it too).
- `RT.writeAi`: `menu(anchor)` (the "Ask Claude about the selection" menu), `start(mode, instruction?)`, `relatedWork()`.
- `RT.projectsHome`: `show()`, `refresh()`, `onDrop(e)`, `browseFolder()`.
- `RT.overleaf`: `importDialog()` -> Promise<project|null>, `mountSync(el, project)` (renders the sync control for a
  linked project, removes it otherwise). write.js mounts it into `#overleaf-slot` when a project opens or its
  `overleaf.projectId` changes (not on every `lastSync` change, so a pull/push never remounts the control).
- `RT.claude`: `toggle(show?)`, `isOpen()`.
- Brand refresh hooks: `RT.overview` (`render()`, `show()`); `RT.library.filter({status, starred, noPdf})`,
  `focusCategory(name)`, `search(q)` (`'#tag'` filters by that tag), `toolbarSlot('explore')` (`#ll-slot-explore`: compare,
  lineage, Review put their buttons there, Group with Claude stays last; the row icons are one hidden sprite
  `#ll-i-star`, `#ll-i-bookmark`, `#ll-i-highlight`); `RT.nav.openPaper(id, {page, tab})` (waits for `item:shown`);
  `RT.projectsHome.open(id)`, `create()`; `RT.palette.open(q?)`; `RT.guide.open('keys')`; `RT.pdfnav.controls.nav(p, cls)`
  and `controls.find(p, cls)`; `RT.menu(anchor, items, {align})` (menus with headings, ticks, sub-menus, arrow keys).
  The reader's PDF bar folds Navigate and Window into `#rd-pdf-more` below a 760px pane and Annotate below 480px
  (at the default layout Highlights stays visible; in a narrow pane - a 1024px window with the notes beside the PDF -
  it is folded too, and the tour then lights the ⋯ button with a note that the tool is in that menu).

### Event bus - existing events

| Event | Payload | Emitted by | Listeners today |
| --- | --- | --- | --- |
| `view:changed` | `{view, previous}` | core `setView` | - |
| `status` | `/api/status` result | core at boot | claude (terminal hint) |
| `disk:sync` | - | core on window focus; claude after a run | library-list (refetch unless `RT.reader.dirty()`, then emits `library:synced`), write (`sync`) |
| `layout:changed` | - | claude when the panel opens/closes | write (refresh CodeMirror) |
| `claude:context` | `{label, title, context}` | `RT.claudeContext.refresh()` | claude |
| `library:changed` | - | anyone after changing items on the server | library-list refetches |
| `library:damaged` | - | core `RT.api` when a request answers 503 `{damaged: true}` | safety opens the Backups window on the copies of library.json |
| `claude:auth` | the account status | account after a sign-in or a sign-out | - |
| `library:refreshed` | - | library-list after every refetch | reader (category / tags fields) |
| `item:categorized` | `{id}` | library-list when a pending item got Claude's grouping result | reader (category / tags fields) |
| `library:synced` | - | library-list after a `disk:sync` refetch | reader re-renders unless focus is inside `#detail` |
| `item:open` | `{id}` | library-list (`select`) | reader opens it |
| `item:shown` | `{id}` | reader `open` | library-list re-renders the highlight |
| `item:closed` | - | reader `close` / after delete | library-list |
| `item:updated` | `{id}` or `{ids}` | reader after saving / extracting / opening, library-list after a status or star change (object edited in place) | library-list re-renders without refetch; reader refreshes Status and the star in Details |
| `project:changed` | `{id}` | overleaf after pull / push-with-merge / resolve | write: `sync()` if that project is open |
| `projects:changed` | - or `{pid, ids, on}` | projects-home, write (rename, Papers dialog without RT.projectPapers), overleaf (import, unlink); RT.projectPapers after adding / removing papers (with the payload) | projects-home refreshes the table; write refetches the open project (so `project.overleaf` is current) - with `ids` only the papers of the open project; RT.projectPapers refetches the memberships (unless it sent it) |
| `project:opened` | `{id, name}` | write when a project is opened | RT.projectPapers makes it the working project (write.js also sets `rt-working-project` itself) |
| `lineage:open` | `{scope, category?, pid?, id?, ids?, label?}` | related (#rl-lineage), the category header menu | lineage opens its window on that set |
| `memberships:changed` | - | RT.projectPapers when its cache or the working project changed | library-list re-renders; reader refreshes `#btn-proj` and the Projects line |

### Registering a view (tab)

```js
RT.registerView({
  id: 'write', title: 'Write', order: 20,      // Library is order 10
  onShow() {...}, onHide() {...},              // tab switched to / away from
  onDrop(e) {...},                             // files dropped anywhere while this tab shows (core already called preventDefault)
});
```

The view's container is `<section id="view-<id>" class="view">` (created before `#claude` if index.html has none);
core toggles class `active` (`.view.active { display: grid }`) and creates the header tab. The first view shown is
`library`. Core also sets `body.dragging` while files are dragged over the window.

### Claude context provider (one per view)

```js
RT.claudeContext.register('library', () => ({
  label: '· smith2020',                  // shown next to "Claude Code" in the panel head
  title: '',                             // tooltip
  context: { itemId: 'ab12cd34ef' },     // sent to /api/claude: {itemId, page?, selection?} or {projectId, file, selection?}
  dropSelection() {},                    // optional: give up the selection (the x of the panel's chip, and after sending)
}));
RT.claudeContext.refresh();              // call whenever what you would return changed
```

Registered today: `library` (reader.js), `write` (write.js). `selection` is `{kind: 'pdf', text, page}` (the passage
last selected in the PDF, remembered by `createPdfView` after the click into the panel took the browser's selection
away) or `{kind: 'editor', text, line}`; the panel shows it as the chip `#claude-sel`.

`POST /api/claude` `{prompt, sessionId?, context}` answers with NDJSON: `session`, `delta` (a piece of text as it is
written, from `--include-partial-messages`), `text` (the finished block, which replaces the deltas), `status`, `tool`,
`error`, `done` (`lost: true` when the CLI no longer has the session to resume - the panel then starts a fresh one).
The system prompt names the open paper's files (`sentences/<id>.json`, `pdfs/<id>.pdf`, `notes/<id>.md`); page and
selection change with every question and are put in front of the question instead, marked as data. Aborting the
request stops the run. The panel keeps one conversation per `item:<id>` / `project:<id>` (else `general`) in
localStorage `rt.claude.chats` (`{chats: {key: {s: sessionId, t, log: [[class, text]]}}}`; at most 40 conversations,
60 messages each, 1.5 MB in all, oldest dropped first); usage is recorded as `chat`.

### Containers (ids / classes each module renders into)

| Module | Container | Ids / classes it creates inside |
| --- | --- | --- |
| core | header (`#toast`, `#btn-export`, `#btn-settings`, `header nav` tabs `.tab[data-view]`), `<dialog id="dlg-settings">` appended to body | `#export-dir #backup-dir #backup-pick #backup-auto #backup-state #backup-now #set-backups #set-ok #set-cancel` |
| safety | `<dialog id="dlg-backups">`, `<dialog id="dlg-trash">` appended to body | `#bk-seg #bk-info #bk-list .bk-row #bk-now #bk-close`, `#tr-list .tr-row[data-bin] #tr-sum #tr-old #tr-all #tr-close` |
| claude | `<aside id="claude">` (toggled by header `#btn-claude`) | `.claude-head #claude-ctx #claude-new #claude-log .msg(.user/.bot(.live)/.tool/.err/.hint/.wait) #claude-sel #claude-form #claude-input #claude-send #claude-cmd` |
| library-list (+ categories) | `#library-list.list-pane` (left column of `#view-library`) | `.list-actions #btn-import-pdf #btn-paste-bib #file-pdf .search-row #search #search-scope #proj-chip.proj-chip .list-opts #btn-view #btn-expand-all #btn-collapse-all #btn-regroup #btn-review #btn-compare #tag-filter #btn-trash #bulk #jobs .job #list .grp .item(.sel/.picked)[data-id] .cat-dot .drop-hint`; project: row button `.pj[data-proj]`, pinned group `.proj-wrap[data-pid]` (`[data-pmenu]`, `button.proj-stats[data-pstats]`, rows `.item.recent.proj`), group by project `.grp-wrap[data-pid]` `.grp-pj`, bulk `[data-bulk=project]`; dialogs `#dlg-bib #dlg-ask #dlg-regroup` (`rg-*`), `.ctx-menu` |
| reader | **`#detail.detail-pane`** (right column of `#view-library`) - the Library tab's detail container | `.rd-body (.rd-pdf: .rd-pdfbar #rd-pdf-prev #rd-pdf-page #rd-pdf-total #rd-pdf-next #rd-pdf-zoom-out #rd-pdf-zoom-in #pdf-outline #pdf-back #pdf-search #pdf-hits #pdf-hit-prev #pdf-hit-next #pdf-hit-list, .pn-panel .pn-row .pn-links .pn-link .pn-peek (pdfnav), .rd-pdfscroll .rd-page; #rd-divider; .rd-work: .rd-tabs, #note-editor (Vditor), #rd-kp (#kps .kp #sents), #rd-details (.meta [data-field] #citekey #type #rd-category #rd-tags #rd-projects .rd-pj [data-unproj] #btn-proj-add #rd-links .rd-lk #btn-find-links #bib #btn-check-meta), #btn-proj beside the star, #rd-related (related.js: `.rl-intro #rl-lookup #rl-auto`, `.rl-bar #rl-seg #rl-q #rl-sort #rl-refresh`, `.rl-up #rl-check`, `#rl-list .rl-row`, `#rl-foot`, `#rl-proj`))`; dialogs `.rd-dlg`, `#dlg-meta` (`#mc-body .mc-table #mc-apply #mc-cancel`) |
| write | `#view-write` > `#wr` | `.wr-top (#btn-home #btn-save #save-state .wr-title #proj-name #overleaf-slot ...)`, `.wr-body (.wr-rail, #side: #side-files #tree .tr[data-path] / #side-search #ps-q #ps-results, #outline-pane #wc-total #outline .ol-row .ol-wc, .editor-pane: #tabs .ftab .toolbar #btn-checks #ck-badge #conflict #edit-area #editor #file-view #diff-view .statusbar #compile-status #file-path, #div-pdf, .preview-pane: .pdf-bar #btn-compile #btn-log #log-badge #pdf-prev #pdf-next #pdf-page #pdf-total #pdf-budget #pdf-zoom-out #pdf-zoom-in #pv-outline #pv-back #pv-search #pv-hits #pv-hit-prev #pv-hit-next #pv-hit-list, #preview .pg, #log-panel .issue, #history .hist-side #hist-list .hv)`, `#ctx`, `#wr-pop`, dialogs `.wr-dlg` (the Papers dialog `.wr-dlg.pp-dlg`, buttons `[data-pp]`), toolbar `[data-cmd=papers]` |
| quiz | the reader's Practice tab `#rd-quiz`; `<dialog id="dlg-review">` appended to body; `#btn-review` in the Library list options | `#qz-form #qz-body #qz-pick`; the Review uses the quiz layout with `[data-rv-*]` buttons and `#rv-scope` |
| diagram | the reader's Diagram tab | `#dg-form #dg-scroll #dg-edit #dg-insert` |
| palette | `<dialog id="dlg-palette" class="pal">` appended to body; header `#btn-palette` | `#pal-q #pal-list #pal-count` |
| guide, tour, account | `<dialog id="dlg-guide" class="gd">` (`.gd-tabs #gd-body`), `#tour` (`.tour-hole .tour-card #tour-chapters #tour-chlist #tour-count #tour-title #tour-text #tour-missing #tour-skip #tour-back #tour-next`), `.ov-tour` on the Overview, the account dialog; header `#btn-help #btn-tour`, `#claude-account` in the Claude panel | - |
| lineage | `<dialog id="dlg-lineage" class="lg">` appended to body; `#btn-lineage` in the Library list options; `#lg-back` (body, after Open in reader) | `.lg-head #lg-scope #lg-status #lg-refresh #lg-close`, `.lg-pop` (custom set: `[data-cline] [data-cq] [data-cname] [data-cgo]`), `.lg-origin #lg-oq #lg-olist (.lg-exbar, .lg-orow-w > input.lg-incl[data-incl] + .lg-orow[data-paper])`, `#lg-tabs [data-tab=history|prior|derivative|similar] #lg-tools (#lg-hmode [data-hmode], [data-svg], [data-grouped], .lg-pchip)`, `#lg-view (.lg-stale [data-update], .lg-tl .lg-lanes .lg-lname[data-lane] .lg-svg g.lg-node[data-node] (anc:j / prior:k / an item id) path.lg-e[data-from][data-to] path.lg-bundle[data-anc], .lg-miss, .lg-fbar, .lg-selbar, .lg-table tr[data-row=which:i], .lg-young [data-recentanc], .lg-recent)`, `#lg-foot`, `#lg-detail (.lg-ctx .lg-quote, [data-ctxmore])` |
| compare | `<dialog id="dlg-compare" class="cmp">` appended to body; `#btn-compare` in the Library list options | `.cmp-head #cmp-title #cmp-tools #cmp-body`; `.cmp-list .cmp-item[data-id]`; `.cmp-setup #cmp-kind #cmp-cols #cmp-q #cmp-lang #cmp-cat #cmp-papers .cmp-paper #cmp-count #cmp-est`; `.cmp-view .cmp-status .cmp-summary .cmp-coledit #cmp-cols2 .cmp-scroll .cmp-table .cmp-pg .cmp-key .cmp-edit .cmp-menu`; buttons `[data-act]` |
| write-ai | inside the CodeMirror editor; `<dialog class="wr-dlg rw-dlg">` while it is open | `.ai-old` (the marked passage), `.ai-prop (.ai-head .ai-diff .ai-msg .ai-note, buttons [data-ai=accept|reject|retry])`; `#rw-angle #rw-q #rw-cat #rw-all #rw-none #rw-list .rw-row #rw-head #rw-count #rw-notes #rw-latex`, buttons `[data-rw=cancel|stop|back|copy|draft|insert]`; toolbar buttons `[data-cmd=askai]`, `[data-cmd=related]` |
| projects-home | `#view-write` > `#pj-home` | `.pj-side #pj-filters, .pj-main #pj-new .pj-search .pj-table #pj-rows .pj-foot`; `<dialog id="dlg-folder">` (`#fs-up #fs-path #fs-go #fs-list #fs-cancel #fs-open`) |
| overleaf | wherever `mountSync` is called (`#overleaf-slot`) | `.ol-sync (.ol-status .ol-dot .ol-text .ol-actions .ol-pull .ol-push .ol-more .ol-menu)`; dialogs `.ol-dlg` |

Naming rules that keep the modules apart: ids are unique across the whole page (the reader's PDF toolbar uses
`rd-pdf-*`, the Write preview `pdf-*`); `.ol-row` / `.ol-kind` are the Write **outline**, every other `.ol-*` class is
Overleaf; generic class names (`.pg`, `.dot`, `.item`, `.kp` ...) must be scoped under the module's container in CSS
(`#preview .pg`, `#wr .dot`).

Shortcuts and global events: Cmd/Ctrl+S saves the open project while the Write tab shows a project (document-level,
write.js) and saves item + note while focus is inside `#detail` (reader.js). Cmd/Ctrl+F belongs to CodeMirror inside
the LaTeX editor; while the focus is inside a PDF pane (the reader's `#rd-pdf` or the Write `#preview-pane`), or on
nothing at all while that pane shows, pdfnav.js takes Cmd/Ctrl+F (Find box), Cmd/Ctrl+G / Shift+Cmd/Ctrl+G (next /
previous match) and Cmd/Ctrl+[ or Alt+Left (Back). Pasting BibTeX - or text that consists only of arXiv ids / links, DOIs or OpenReview links - outside a text field imports it only while the Library tab shows and no dialog is open. Esc closes one thing at a time: the
match / contents list of a PDF pane takes the key (`preventDefault`) before the highlights panel, the answer card and - last,
and only while the focus is in the list or on nothing - the selection of the Library list. In a narrow PDF pane the match /
contents list lies along the bottom, so it and the highlights panel close each other (DOM event `rt:pdf-panel` on the pane,
`detail {from: 'nav' | 'hl', bottom?}`). File drops go
to the active view's `onDrop`; the reader swallows drops on its attach area and images dropped on the note.

`#view-library` is a 2-column grid (`320px 1fr`, set in library-list.css); `#view-write` holds `#pj-home` (projects
home) and `#wr` (editor), one of them hidden.

### Vendored libraries (`public/vendor`, served as `/vendor/...`)

| Library | Files | How to use |
| --- | --- | --- |
| CodeMirror 5.65.16 | `codemirror/lib/codemirror.{js,css}`, `mode/{stex,markdown,xml,gfm}`, `mode/meta.js`, all of `addon/` | Loaded by index.html: lib, modes stex + xml + markdown, addons dialog, searchcursor, search, jump-to-line, matchbrackets, closebrackets, show-hint, active-line (+ dialog.css, show-hint.css). Global `CodeMirror`. Options `matchBrackets`, `autoCloseBrackets`, `styleActiveLine`, `showHint` are off until you set them. write.js enables the search dialog (Cmd/Ctrl-F), bracket matching, auto-close and hints. Other addons / modes: `await RT.loadScript('/vendor/codemirror/addon/...')` |
| pdf.js 3.11.174 | `pdfjs/pdf.min.js`, `pdf.worker.min.js`, `text-layer.css` (the `.textLayer` rules from pdf_viewer.css), full `pdf_viewer.css` + `images/`, `cmaps/`, `standard_fonts/` | `pdf.min.js` and `text-layer.css` are loaded by index.html; global `pdfjsLib`, worker already set to `/vendor/pdfjs/pdf.worker.min.js`. For CJK / standard fonts: `pdfjsLib.getDocument({url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/'})`. Text layer: `pdfjsLib.renderTextLayer({textContentSource, container, viewport})` into a `div.textLayer` (set `--scale-factor` on it) |
| Fonts (OFL, Fontsource 5.3.0) | `fonts/{roboto,montserrat,lato,share-tech}-latin-*.woff2` (latin subsets only) | Declared in `css/fonts.css` with the latin `unicode-range`, so CJK falls through to the system Chinese font. Roles in `css/type.css`. |
| Vditor 3.11.3 | `vditor/dist/**` (index.min.js, index.css, method.min.js, js/{lute,katex,highlight.js,i18n,icons,mermaid,...}, css/content-theme) | Not loaded at start. `const Vditor = await RT.vendor.vditor(); new Vditor(el, { cdn: RT.vendor.VDITOR_CDN /* '/vendor/vditor' */, lang: 'en_US', cache: { enable: false }, ... })`. Works offline (KaTeX, highlight.js, lute verified). Set `theme: 'dark'` / `preview.theme.current: 'dark'` for dark mode |

Never reference a CDN. To add a library: `npm pack <name>@<version>` in a temp dir, copy the dist files into
`public/vendor/<name>/` together with the library's licence file, and add a row to THIRD_PARTY_LICENSES.md (see
CONTRIBUTING.md).

### CSS

Use the variables from `css/base.css` (light values; a `prefers-color-scheme: dark` block redefines all of them):

`--bg` page, `--panel` cards/inputs, `--ink` text, `--muted` secondary text, `--line` borders, `--accent` /
`--accent-ink` primary buttons and highlights, `--soft` subtle fill (hover, badges, code), `--sel` selected row,
`--ok`, `--bad`, `--warn` (status text), `--on-status` (text on an `--ok` / `--bad` / `--warn` fill). The "Purple Ginseng" theme: white / faint lilac base, deep purple `--accent`, `--pink` / `--pink-soft`
(hover borders, the selected row's bar, `--focus` rings), `--yellow` / `--yellow-soft` / `--yellow-ink` (search marks,
"due" badges), `--star` (stars), `--shadow` (popovers, dialogs). Text pairs meet WCAG AA in both themes.

Generic classes in base.css: `button.primary`, `button.accent`, `button.ghost`, `button.on`, `.muted`, `.spacer`,
`.badge`, `.empty`, `.seg` (segmented buttons, `.on` = active), `.menu-wrap` + `.popover` (+ `.menu` for a button
list; note `.popover` comes after `.menu` and wins on `width`/`left`), `dialog` + `.dlg-actions`, `h4` section
headings, `[hidden]`. Breakpoint for narrow layouts: `@media (max-width: 900px)`.
Put new rules in your module's CSS file and scope them under your container or a module prefix.

Fonts, by role (tokens in base.css; every stack names PingFang SC / Hiragino Sans GB / Microsoft YaHei for Chinese):
`--font-body` Roboto (body text, controls, note content in Vditor, Claude's answers, dialog text), `--font-title`
Montserrat (paper titles, h1-h3, the brand, project names, Lineage titles and lane labels; 600, headings 700, lane
labels / node labels / palette paper rows 500),
`--font-author` Lato (author lines), `--font-meta` Share Tech (year, venue, cite keys, tags, counts, status lines, badges,
toasts, timestamps; never below 11px, letter-spacing .02em; it has one face, so meta text is always 400 with
`font-synthesis: none` and shows emphasis by colour; a button inside a meta row keeps `--font-body`), `--mono` (CodeMirror, code in notes, BibTeX, file paths).
Which element gets which role is in `css/type.css`, linked last: add a new title / meta class to its list there rather
than setting `font-family` in a module sheet. An author name inside a meta line is `<span class="au">`;
`RT.byline(authors, [year, venue, ...])` (core.js) builds such a line as HTML. The PDF pages and KaTeX keep their own fonts.

## Testing recipe

Use a separate `PORT` and `RT_WORKSPACE` for testing, so your own workspace on the default port is left untouched.

All tests: `node scripts/run-tests.js`; the server end to end: `node scripts/smoke-server.js [--port N] [--tmp dir]`;
translations complete: `node scripts/i18n-extract.js --check` (exit code 1 otherwise).

```bash
mkdir -p /tmp/rt-test && RT_WORKSPACE=/tmp/rt-test PORT=4841 node server.js &     # own port + fresh workspace
curl -s localhost:4841/api/library
curl -s -X POST localhost:4841/api/import/bibtex -H 'X-RT: 1' -H 'Content-Type: application/json' \
     -d '{"text":"@article{k, title={T}, author={A, B}, year={2024}}"}'
curl -s -X POST localhost:4841/api/projects -H 'X-RT: 1' -H 'Content-Type: application/json' -d '{"name":"demo"}'
curl -s -X PUT 'localhost:4841/api/projects/demo/file?path=main.tex' -H 'X-RT: 1' -H 'Content-Type: application/json' \
     -d '{"content":"...","source":"manual"}'
curl -s -X POST localhost:4841/api/projects/demo/compile -H 'X-RT: 1'
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4841/api/export     # 403: missing X-RT
kill %1; rm -rf /tmp/rt-test
```

`RT_BURST_MS=0` makes every autosave its own history version. For features that call Claude put a fake `claude`
executable first on `PATH`; for Overleaf set `RT_OVERLEAF_GIT_BASE=file:///tmp/x/remotes` and create a bare repository
named by a 24-hex id there (branch `master`). Questions are asked with `RT.confirm` / `RT.ask` (in-page dialogs), never the native
`confirm()` / `prompt()`. A test workspace gets its own backup folder (`<RT_WORKSPACE>-backups`). Run `node --check` on every JS file you touch
(`for f in server.js lib/*.js lib/routes/*.js public/js/*.js; do node --check $f; done`). In the browser: open
`http://localhost:<PORT>/`, exercise both tabs, and check that the console is empty.
