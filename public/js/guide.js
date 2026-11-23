/* Guide: Help › Guide in the header opens a short manual of the app, one page per area (a section list on the left
   from 900px, a row of tabs below). Many buttons show icons only, so every step names the button and shows its icon -
   the same icon names as the real buttons. RT.guide.open(page?, at?) - page 'keys' is the list of keys. */
(() => {
  const { $, $$, ls } = RT;
  RT.guide = RT.guide || {};
  const HELP = 'help', FLOW = 'graph-node', USER = 'user', UNDO = 'undo', CARDS = 'quiz', KEYBOARD = 'command', TIDY = 'grid';
  const PROJ = RT.projectPapers ? RT.projectPapers.ICON : 'bookmark'; // the bookmark: a paper of a project
  const PAPERS = 'library'; // the Papers button of the Write toolbar
  const LINEAGE = RT.lineage && RT.lineage.ICON ? RT.lineage.ICON : 'lineage'; // the Lineage button
  const GRAPH = RT.related ? RT.related.ICON : 'list', META = RT.related ? RT.related.META_ICON : 'check'; // the Related tab, Check metadata
  const i = (name) => `<span class="gd-ic">${name === 'crest' ? RT.crest(14) : RT.icon(name)}</span>`; // an icon inside a sentence ('crest': the brand mark)
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const ALT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt+';

  const PAGE_ICONS = { start: 'home', library: 'library', lineage: 'lineage', reading: 'book-open', diagram: 'graph-node', write: 'editor', claude: 'sparkle', files: 'folder' };
  // the top of the first page: the crest and a welcome picture
  const INTRO = () => `<div class="gd-intro"><div class="gd-intro-text">${RT.crest(48)}<div><div class="gd-intro-title">Welcome to ResearchTool</div><p class="muted">Your papers, reading notes and LaTeX writing in one place.</p></div></div>${RT.ill && RT.ill.onboardingWelcome ? `<div class="gd-intro-ill">${RT.ill.onboardingWelcome()}</div>` : ''}</div>`;
  // words that depend on the AI provider (Preferences › AI): both versions are in the page, show() shows the one that
  // fits - `has` when the provider has the capability (cap 'claude': is Claude Code), `lacks` when it does not.
  // The Claude Code version only ever shows with Claude Code chosen, so the display layer's renaming cannot turn its
  // sign-in steps into wrong instructions for another CLI.
  const AIV = (tag, cap, has, lacks) => `<${tag} data-ai-has="${cap}">${has}</${tag}><${tag} data-ai-lacks="${cap}" hidden>${lacks}</${tag}>`;
  const PAGES = [
    ['start', 'Start here', `
      <p>ResearchTool keeps your papers, your reading notes and your LaTeX writing in one place on this Mac, with Claude Code helping in each step. Nothing leaves this Mac except what Claude Code and Overleaf sync send themselves, and the lookups that fetch a paper's details and PDF when you import one (doi.org, arxiv.org, openreview.net, openalex.org - they receive only the paper's id, DOI or title). The Related tab and “Check metadata” ask openalex.org, semanticscholar.org, arxiv.org and doi.org about a paper only when you press their button, and send only that paper's DOI or arXiv id. Preferences › General › Updates asks github.com whether there is a newer version of ResearchTool only when you tick its box or press “Check for updates now” or “Update now”: an anonymous request that sends nothing about you or your library.</p>
      <ol>
        ${AIV('li', 'claude', `<b>Sign in to Claude Code</b> once: open the Claude panel ${i('sparkle')} (top right) and click the person ${i(USER)}. <button data-act="account">Check the sign-in now</button>`,
    `<b>Sign in to Claude Code</b> once in a terminal - the account window shows how. <button data-act="account">Check it now</button>`)}
        <li><b>Add papers</b>: drop PDF or <code>.bib</code> files anywhere on the Library tab ${i('books')}, or copy an arXiv link or a DOI and press ${MOD}V there.</li>
        <li><b>Open a paper</b>: click it in the list. The PDF is on the left, your notes on the right.</li>
        <li><b>Let Claude start the note</b>: in the Notes tab press ${i('sparkle')} “Generate first draft”, then edit it.</li>
        <li><b>Understand the method</b>: the Diagram tab ${i(FLOW)} draws the paper as a flow chart with an explanation for every box.</li>
        <li><b>Write</b>: the Editor ${i('editor')} is a LaTeX editor with a live PDF; <code>\\cite</code> picks from your library.</li>
      </ol>
      <h4>Across the top</h4>
      <ul>
        <li>The crest ${i('crest')} at the top left goes home: to the <b>Overview</b> ${i('dashboard')} when there is one, otherwise to the Library.</li>
        <li>The views: <b>Overview</b> ${i('dashboard')} (what to read next, your notes, lines and projects), <b>Library</b> ${i('library')} and the <b>Editor</b> ${i('editor')}. <kbd>G</kbd> then <kbd>O</kbd>, <kbd>L</kbd> or <kbd>W</kbd> switches between them.</li>
        <li>The search box ${i('search')} in the middle finds papers and actions (${MOD}K).</li>
        <li><b>Help</b> ${i(HELP)}: this Guide, the guided tour of the app and the keyboard shortcuts.</li>
        <li><b>More</b> ${i('more')}: <b>Export references…</b>, <b>Recently deleted…</b> and <b>Backups…</b>.</li>
        <li><b>Preferences</b> ${i('settings')} (${MOD},): language, theme, the view the app starts on, Claude, the export folder and the backup. <b>Claude</b> ${i('sparkle')} shows or hides the Claude panel.</li>
      </ul>
      <p class="gd-tip"><b>${MOD}K</b> (or the search box at the top) opens <b>Go to anything</b>: type a few letters of a paper's title, author or cite key to open it, or of an action - a tab, “Recompile”, “Group the papers with Claude” - to run it. The other keys are listed under “Files & keys”.</p>
      <p class="gd-tip">Almost every button is an icon. Rest the mouse on one for a second to read what it does. <b>Help</b> ${i(HELP)} › “Take the tour” starts a <b>guided tour</b> from the Overview to the Editor that lights up each control and says what it is for: <button data-act="tour">Take the tour</button></p>`],
    ['library', 'Library', `
      <h4>Adding papers</h4>
      <ul>
        <li>Drop PDFs, whole folders or <code>.bib</code> files on the tab, or use ${i('import')} Import.</li>
        <li>${i('paste')} adds papers without a file: type or paste arXiv ids or links, DOIs, doi.org links or publisher links that contain the DOI, OpenReview links (several, one per line) or BibTeX. Pressing ${MOD}V anywhere in the Library does the same with what you copied. An arXiv or OpenReview paper is downloaded with its PDF; a DOI gets a PDF when a free copy exists, otherwise the reference is added without one and the paper shows ${i('attach')} Attach PDF. Each one appears in the import queue with its progress.</li>
        <li>Title, authors and year are looked up by the paper's DOI or arXiv id (at doi.org) or, failing that, read from the PDF. Adding by id or link asks arxiv.org, doi.org, openreview.net and - to find a free PDF for a DOI - openalex.org, then arxiv.org with the paper's title; only the id, DOI or title is sent, never your notes. A paper you already have is reported, and you can still import it as a second copy.</li>
      </ul>
      <h4>Finding and grouping</h4>
      <ul>
        <li>The search box looks in titles, authors, cite keys, tags and categories; several words are found in any order. Click a tag to show only papers with it.</li>
        <li>To find a phrase you remember from a paper or from your notes, switch on ${i('audit')} beside the search box: it then also searches the text of every PDF, every note and every key point (Chinese works too; put <code>"words in quotes"</code> to find them together). The matching passages are listed under each paper with their page; click one to open the paper at that page, note line or key point.</li>
        <li>Claude files every new paper into a category with a few tags. Categories are <b>research lines</b>: a paper goes under the line of work it builds on (what its Preliminaries and Related Work start from), not its application words - a policy built on a VLA backbone is “VLA”, one that learns a world model is “World Models”. A line with 4 or more papers can have sub-lines, written “Line / Sub-line” (“Humanoid / Locomotion”); the list nests them under the line, and the ⋯ of a line renames, deletes or re-groups all of it. Preferences › AI › “Research lines Claude should prefer” lists the names Claude prefers. ${i('view')} chooses how the list is grouped and sorted.</li>
        <li>The same step writes a <b>brief</b>: a sentence or two on the problem, the idea and the main result, shown under the title so you can skim the list (rest the mouse on it to read all of it; the search box looks in it too). For papers that have none, ${i('view')} offers “Write the missing briefs with Claude” (the square beside the counter at the top of the list stops it; briefs already written stay), and a right-click on a paper writes its brief again. ${i('view')} can also hide the briefs.</li>
        <li>${i('sparkle')} “Group with Claude” proposes categories for the uncategorized papers or, if you choose, one category or the whole library; you review it before anything changes. Papers you filed by hand stay where they are unless you untick that option.</li>
        <li>Drag papers onto a category to move them; select several with ${MOD}click or Shift+click.</li>
        <li><b>Where it was published</b>: ${i('view')} groups the list by <b>Venue (verified)</b> - CoRL, ICRA, Science Robotics … with the most papers first, then <b>arXiv preprint</b>, then <b>Unverified / 未归类</b> for every paper whose venue could not be confirmed or was not checked yet. The venues come from a check you start yourself: “Check venues of N papers” in ${i('view')} or in the bar above the list (with its progress and ${i('stop')} to stop it), or “Check venue again” when you right-click a paper. It asks Crossref, PMLR (for CoRL, ICML … when arXiv or an index names the conference), DBLP, OpenAlex, Semantic Scholar and arXiv, one paper after the other, sending only the DOI, arXiv id or title. A venue counts only when the publisher's own record names it, or two of these indexes name the same venue and year, or DBLP lists the very paper; an “Accepted to …” comment on arXiv alone is shown as a claim, not trusted. Rest the pointer on a group or on the venue of a row to see the full name and which indexes confirmed it; Details shows the same, or why the venue is not verified, with <i>Check again</i>. Your BibTeX is never changed by it (“Check metadata” in Details does that, when you choose).</li>
        <li><b>By time</b>: ${i('view')} sorts by <b>Publication date</b>, newest or oldest first - the first public date found by the venue check (the arXiv v1 date, else the publication date), else the year and month of the BibTeX entry; papers with no date come last. Grouping by <b>Year</b> uses the same verified year when there is one.</li>
        <li>${i(RT.organize ? RT.organize.ICON : 'list')} <b>Organize from a file</b>: drop or pick a Markdown reading list or outline (or use “Add papers from a .md / .bib file…” in the Project menu above the list, or ${MOD}K). Its headings become the groups; it can name papers with <code>\cite{key}</code>, <code>[@key]</code>, <code>\`key\`</code>, DOIs, arXiv ids or titles. A <code>.bib</code> file works too: its comment headings (<code>% ---- World models ----</code>) or JabRef groups are the groups, and after importing a <code>.bib</code> whose papers you mostly have, the message offers this. You see every group with its papers ticked, papers that are under two groups, and what was not found, before you choose: the groups as categories or as tags, and the papers added to your project. The message afterwards has ${i('undo')} Undo.</li>
        <li>${i(RT.compare ? RT.compare.ICON : 'list')} <b>Ask across papers</b>: select up to 15 papers (or right-click a category) and press the table button of the selection bar. <b>Compare in a table</b> fills the columns you name - method, training data, results, one per line - with one row per paper; <b>Ask one question</b> asks every paper the same question and adds one overall answer. Claude reads each paper once, from its brief, your note and key points and the passages of the PDF that match, and the window shows about how many tokens that will take before you start. Every cell names its pages: click one to open that paper there. Double-click a cell to correct it, change the columns and fill only the new ones, ask again for one paper. Tables are saved - the same button without a selection lists them - and can be copied or downloaded as Markdown, CSV or a LaTeX table with <code>\\cite</code>, added to the note of the open paper, or inserted into the open <code>.tex</code> file from the Write toolbar.</li>
        <li><b>Without the mouse</b>: <kbd>/</kbd> puts the cursor in the search box and <kbd>↓</kbd> goes from there into the list. <kbd>↑</kbd> <kbd>↓</kbd> move over the rows, <kbd>Enter</kbd> opens a paper, <kbd>Shift+↑</kbd> <kbd>Shift+↓</kbd> or <kbd>Space</kbd> select several, <kbd>⌘</kbd>+<kbd>Delete</kbd> moves them to Recently deleted. <kbd>J</kbd> and <kbd>K</kbd> open the next and the previous paper from anywhere in the Library, and ${MOD}K finds a paper by a few letters of its title.</li>
      </ul>
      <h4>Keeping track of your reading</h4>
      <ul>
        <li>The dot before a title is the reading status: an empty ring is <b>To read</b>, a half-filled one <b>Reading</b>, a green one <b>Done</b>. A paper becomes “Reading” when you open it for the first time; click the dot (or right-click the paper) to change it. Point at a row and click the star ${i('star')} to mark a paper you want to find again.</li>
        <li>${i('view')} can group and sort the list by reading status or by when you last opened a paper, and show only the papers that are to read, being read, done or starred.</li>
        <li><b>Continue reading</b> at the top of the list holds the papers you opened last and have not marked Done, with the page you stopped at. The PDF reopens at that page and zoom, and the paper that was open is opened again when you start the app.</li>
        <li>When you reach the last page of a paper that has a note and is not Done yet, a message asks whether you finished it; <b>Mark as done</b> sets the status.</li>
      </ul>
      <h4>Papers of a project ${i(PROJ)}</h4>
      <ul>
        <li>Collect the papers you need for a piece of writing in its project (a LaTeX project of the Write tab). Point at a row and click the bookmark ${i(PROJ)} beside the star to add the paper to the <b>working project</b>; click it again to take it out. The message that follows has an Undo. Taking a paper out of a project never deletes it.</li>
        <li><b>The project chip</b> in the search row shows the working project: click it to switch to another one, or drop papers on it to add them. Opening a project in the Write tab also makes it the working project.</li>
        <li>Right-click a paper (or a selection) for <i>Add to “…”</i>, <i>Remove from “…”</i> and <i>Add to project…</i> for another project; the selection bar has ${i(PROJ)} too. In an open paper, ${i(PROJ)} beside the star does the same, and Details lists the projects the paper is in (× takes it out, “Add to…” adds it to another).</li>
        <li>The group <b>In “…”</b> at the top of the list holds the papers of the working project, each with how often the project cites it and whether it has a note. The line under its title counts what is left: to read, reading, done, cited, without a note, questions due; click it for the lists of papers not read yet, read without a note and not cited yet. Its ${i('more')} menu reviews the questions of these papers, compares them in a table, exports a reading pack or opens the project in Write.</li>
        <li><b>Reading pack</b>: a folder in the export folder with a reading list (each paper with its status, brief, key points and a link to its note), the BibTeX of the papers and their notes. Making it again replaces it. <b>Download reading pack (.zip, paper packages)</b> gives the pack as one .zip, with a paper package (note with pictures, PDF, BibTeX, links) for each paper.</li>
        <li>${i('view')} can group the list by project (a paper in two projects is in both groups) and show only the papers of the working project. In the Related tab, tick “also add to “…”” to put the papers you add from there into the working project as well.</li>
      </ul>
      <h4>Using the references elsewhere</h4>
      <ul>
        <li><b>More</b> ${i('more')} › ${i('export')} <b>Export references…</b> (top right) writes <code>references.bib</code>, <code>notes.md</code>, <code>library.csv</code> and one Markdown file per note. ${i('settings')} Preferences › Library & files sets the folder.</li>
      </ul>`],
    ['lineage', 'Lineage', `
      <p>${i(LINEAGE)} <b>Lineage</b> (Library toolbar; “Lineage of this line…” in the ⋯ of a line; “Lineage of this paper” in the Related tab) shows where a set of your papers comes from and where the work went, as Connected Papers does.</p>
      <h4>Which papers</h4>
      <ul>
        <li>Choose the set at the top: the whole library, a research line or sub-line, a project's papers, one paper, or <b>Custom set…</b> - tick several lines and sub-lines and / or type words a paper's title, tags or category must contain, and give the set a name; it is kept under “Your sets”.</li>
        <li>The papers of the set are listed on the left before anything is looked up. Untick one to leave it out, then <b>Look up the other N</b>.</li>
        <li>Nothing is asked until you press <b>Look up the lineage</b>; the window says beforehand how many papers are looked up already and about how many OpenAlex queries it takes (at most 10). A set that has no result of its own yet - the library with one new paper - shows the closest earlier result at once, marked “Computed for 112 papers · 1 new not included”, with <b>Update</b>. ${i('refresh')} computes again.</li>
      </ul>
      <h4>History line</h4>
      <ul>
        <li><b>Citations</b>: your papers on a time axis, one lane per line, an arrow from a paper to each later paper of yours that cites it; the most relevant prior works can be shown as nodes of their own (filled when you have them). Hover for the title, click for details, double-click to open, right-click or <kbd>Shift+F10</kbd> for a menu.</li>
        <li><b>Ancestry</b>: the 8 works the set builds on most, in a column on the left, with a bundle into each lane as wide as the number of its papers that cite it. Papers take the colour of their main ancestor. Click an ancestor or a lane name to see just its edges; a dashed ring marks an ancestor most of whose citers are from the last 12 months.</li>
        <li><b>SVG</b> saves the picture for slides or a proposal.</li>
      </ul>
      <h4>Prior, derivative and similar works</h4>
      <ul>
        <li><b>Prior works</b> are the works your papers cite most; <b>Derivative works</b> cite several of them, including the most cited of the last 18 months; <b>Similar</b> are works the papers citing yours also cite, or that share many of your references - related and concurrent work that does not cite you.</li>
        <li>“Most relevant” comes first: hub papers cited everywhere count less, and generic works (Adam, ResNet, a benchmark everyone uses) are hidden until you show them. Hover a row to read why it ranks where it does; the chips say who cites it, how many references it shares, and Seminal / Recent / Rising.</li>
        <li>For a prior work the details show how your papers cite it - “uses its method”, “influential” and the citing sentences from Semantic Scholar (asked when you select it, a few papers at a time). Above the table: the top foundations you don't have yet.</li>
        <li>A line so new that few works cite it says so; <b>Recent works citing your line's top ancestors</b> lists the newest work around it.</li>
        <li>Filter by years, missing from your library or project, surveys, venue type or open PDF; tick rows to act on just those.</li>
      </ul>
      <h4>Into your library and your project</h4>
      <ul>
        <li>${i('plus')} adds a work to your library. The bookmark ${i(PROJ)} adds it to the project shown on the project chip (the project of the set, the one you pick, or the working project - picking one here does not change your working project); works you don't have are imported first. <b>Add all to “P”</b> takes the first 25 rows as sorted unless you change the number. One message sums it up; its Undo takes them out of the project again and leaves them in your library.</li>
        <li>For a paper of yours, <b>Add its prior + derivative works to “P”…</b> chooses which of its neighbours to add.</li>
        <li>CSV and BibTeX export the rows as filtered or ticked; the BibTeX keeps acronyms such as {OpenVLA}, files arXiv preprints as @misc with their eprint and uses your own cite keys. <b>Grouped…</b> exports Foundational / Recent / Surveys as BibTeX, or copies them as a related-work bullet list.</li>
        <li><b>Open in reader</b> leaves a <b>Back to Lineage</b> button at the bottom left that brings the window back with the same tab, selection and scroll.</li>
      </ul>
      <p class="gd-tip">Only DOIs, arXiv ids and OpenAlex ids are sent - never a note, a title or a PDF. Answers are kept on this Mac (papers for 14 days, a computed set for 7).</p>`],
    ['reading', 'Reading & notes', `
      <h4>The PDF (left)</h4>
      <ul>
        <li>Zoom and page buttons are above the PDF. Drag the divider to resize; the pane buttons swap or maximise a side. While you are not typing, <kbd>Page Down</kbd> and <kbd>Page Up</kbd> move the PDF by a screen, <kbd>+</kbd> and <kbd>-</kbd> zoom, <kbd>0</kbd> fits the width, and <kbd>1</kbd> to <kbd>6</kbd> show the Notes, Diagram, Practice, Key points, Details and Related tabs (<kbd>${ALT}1</kbd> to <kbd>${ALT}6</kbd> also work while you type in the note).</li>
        <li><b>Find</b>: ${MOD}F while the PDF has the focus (click it once) puts the cursor in the Find box. Every match in the whole PDF is listed with its page and the words around it; click one to go there. Enter or ${MOD}G goes to the next match, Shift+Enter or Shift+${MOD}G to the previous one. A word that is split by a hyphen at the end of a line is still found.</li>
        <li><b>Contents, links and Back</b>: the contents button opens the table of contents of the PDF. Citations such as [23], "Fig. 4" or "Sec. 3.2" are links: rest the pointer on one to see a small picture of its target, click to go there. The Back button (${MOD}[) returns to where you were before a jump. Web addresses open in a new tab.</li>
        <li>Select text, then choose <b>Quote in notes</b> (inserts the quote with a link to its page) or <b>Add as key point</b>.</li>
        <li><b>Highlights</b>: select text and click a colour dot to mark it. The mark stays on the page (the PDF file itself is not changed), and a passage you quote or add as a key point is marked too. Click a highlight to change its colour, write a comment, go to its key point or remove it. The marker button above the PDF lists every highlight of the paper: click one to go there. The arrow in that list puts back the highlight you removed last, and the star shows or hides the underlines under the sentences of the key points.</li>
        <li>${i('camera')} Snapshot: drag a rectangle on a page to paste a figure or table into the note as an image, with a link to its page.</li>
        <li>${i('sparkle')} <b>Explain or translate in place</b>: select text and press the Claude button of the small bar to have Claude explain it, give its foundations, its meaning or an example, translate it (into 中文 or English), or answer your own question. The answer opens in a card over the PDF, so the note stays as it is; <b>Add to note</b> puts the passage (as a quote with its page) and the answer into the note.${AIV('span', 'readsImage', ' After a snapshot, a Claude button beside the region asks about that figure or table.', ' Questions about a snapshot need a provider that reads pictures (Preferences › AI); with this one, select the caption or the text around the figure instead.')}</li>
        <li><b>Page citations</b>: Claude ends what it takes from the paper with its page, such as (p. 4), and marks the rest as (general knowledge). In an answer card, a diagram card, a quiz explanation, the Claude panel and Claude's comments in the note, click the page to see it in the PDF.</li>
        <li><b>Page links</b>: click a page link in the note (written <code>[p. 7](#rt-page=7)</code>, so you can also type one yourself) and the PDF jumps to that page and lights up the quoted passage for a moment. The page chips of the key points and of the sentence list do the same.</li>
      </ul>
      <h4>Notes ${i('note')}</h4>
      <ul>
        <li>A Markdown editor with headings, callouts, tables and LaTeX formulas. It saves by itself.</li>
        <li><b>Pictures and videos</b>: paste or drop them into the note, or use the upload button of the toolbar (MP4, WebM and MOV videos, up to 300 MB). Point at one and drag the round grip at its corner to resize it; ↺ goes back to the original size.</li>
        <li><b>Right-click to ask Claude</b>${AIV('span', 'readsImage', ': select a phrase, or right-click a paragraph, a table or a picture, and choose', ': select a phrase, or right-click a paragraph or a table (a picture is asked about through its caption, as this provider cannot look at pictures), and choose')} <i>Explain this</i>, <i>Explain the foundations</i>, <i>What does it mean here?</i>, <i>Give an example</i> or your own question. The answer is added right below as a blue comment, the phrase is highlighted and the part it belongs to is tinted. Shift + right-click gives the browser's own menu.</li>
        <li>${i('sparkle')} <b>Generate first draft</b>${AIV('span', 'readsPdf', ': Claude reads the PDF and writes the note in your note format. Your previous note stays in the history. The figures and tables the draft refers to are cut out of the PDF and put into the note by the app itself; only a figure that could not be found stays as a 📷 placeholder for the snapshot tool.', ': Claude reads the text of the PDF and writes the note in your note format. Your previous note stays in the history. The figures and tables the draft refers to are cut out of the PDF and put into the note by the app itself; only a figure that could not be found stays as a 📷 placeholder for the snapshot tool.')}</li>
        <li>${i(RT.figures.ICON)} <b>Figures</b>: lists the figures and tables of the paper as small pictures (found from the layout of the PDF on your computer, without Claude). Click one to put it into the note at the cursor, with its page link. “Place the figures in this note” fills the 📷 placeholders of a note drafted earlier. A dashed frame means the crop is uncertain (it may be cut off or hold text): such a figure is never placed by itself, its 📷 placeholder stays - look at it and click it if it is right, or use the snapshot tool.</li>
        <li>${i('more')} More: history (compare and restore earlier versions), export and import, the note template, and the language Claude writes in.</li>
        <li><b>A paper package</b> (${i('more')} More): <b>Export paper package (.zip)</b> saves everything about the paper in one folder: the note as <code>.md</code> (with the title, authors, venue and a links line: PDF, BibTeX, arXiv, DOI, project page, code) and its pictures in <code>assets</code>, the <code>.bib</code> entry and the PDF. Open the .md in Obsidian, Typora, VS Code, or import the folder into Notion, Feishu, Yuque. <b>… without the PDF</b> leaves the PDF file out. Several papers: right-click papers in the Library (or the zip button of the selection bar) → <b>Export paper packages of N papers (.zip)</b>, one folder per paper with a <code>README.md</code> and <code>references.bib</code>; over 100 MB of PDFs it asks first whether to put them in.</li>
        <li><b>Links of a paper</b> (${i('info')} Details → Links): its project page, code, arXiv and DOI, as the authors gave them in the BibTeX, the paper itself, its arXiv comment, their project page or on Hugging Face (hover a link to see where it was found). <b>Find links</b> also asks arXiv and Hugging Face (only the arXiv id is sent), checks that each link answers and reads the project page once for the code it presents; a dead one is marked <i>unreachable</i>, and a repository only Hugging Face names (anyone can attach one there) is shown as <i>suggested by Hugging Face, unconfirmed</i> and left out of the package.</li>
        <li><b>A note for another app</b> (${i('more')} More): <b>Export note (.md, pictures inside)</b> is one file with the pictures inside it; <b>Copy note for another app</b> copies the note with its pictures, to paste into Feishu, Notion, Word, Typora. <b>Export note (.md, text only)</b> leaves the pictures behind.</li>
      </ul>
      <h4>Practice ${i(CARDS)}</h4>
      <ul>
        <li>Claude writes a multiple-choice quiz on the paper: choose 5, 10 or 15 questions, a level (core ideas, deep understanding, expert) and optionally a focus, then press ${i('sparkle')}.</li>
        <li>Pick an answer and press <b>Submit</b>. You then see the correct answer, why it is right, and why each other option is wrong. <b>Hint</b> helps without giving the answer away.</li>
        <li>The result page lists every question; <b>Practise the ones I missed</b> asks those again. <b>Cards</b> shows the same questions as flash cards.</li>
        <li><b>Review</b>: every question you answer comes back later, so that you do not forget it - one you got right after 1, 3, 7, 16 and 35 days (and so on), one you missed the same day. ${i(CARDS)} at the top of the Library list shows how many questions are due today across all papers and asks them as one session (20 at a time); with a working project, the switch at the top of the window asks only the questions of its papers. Each question names its paper: click the title to open it, or a page to see where the answer is discussed, and the review waits where you left it. After an answer, ${i('note')} adds the question and its explanation to the note of that paper, and the crossed circle leaves a question out of the review. No Claude call is needed.</li>
      </ul>
      <h4>Key points ${i('star')} and Details ${i('info')}</h4>
      <ul>
        <li>Key points are the sentences that matter, each with your own remark. “Extract with Claude” picks them for you.</li>
        <li>Details holds the bibliographic fields, reading status, star, category, tags, the brief (edit it, or let Claude write it again with ${i('sparkle')}), the PDF file and the BibTeX entry.</li>
        <li>${i(META)} <b>Check metadata</b> in Details compares the entry with the published record. For an arXiv preprint it looks for the published version (at OpenAlex, Semantic Scholar and arXiv) and shows, field by field, what would change: venue, year, pages, DOI. Tick what to take over; the cite key stays, so your documents keep compiling.</li>
      </ul>
      <h4>Related ${i(GRAPH)}</h4>
      <ul>
        <li>The Related tab lists the <b>References</b> of the open paper and the papers that <b>cite</b> it, each with authors, year, venue and how often it is cited. Filter the list or change its order above it.</li>
        <li>Nothing is asked until you press ${i('search')} (or tick “Look up by itself”). The lists come from OpenAlex, or Semantic Scholar when OpenAlex has none; only the paper's DOI or arXiv id is sent, never your notes or the PDF. The answer is kept on this Mac, so it also shows offline; ${i('refresh')} asks again.</li>
        <li>A paper you already have is marked <b>in library</b> and opens with a click. ${i('plus')} adds another one to your library with its details and, when a free one exists, its PDF; the progress shows in the import list on the left. A title that is not in your library opens its page at arxiv.org or doi.org.</li>
        <li>When the open paper is an arXiv entry that has since been published, a line above the list says where, and ${i(META)} offers to update the entry.</li>
      </ul>`],
    ['diagram', 'Diagrams', `
      <p>The Diagram tab ${i(FLOW)} turns a paper into a pipeline, workflow, flow chart or concept map.</p>
      <ol>
        <li>Choose a kind (or let Claude choose), optionally type what the diagram should focus on, and press ${i('sparkle')}. It takes a minute or two; you can keep working meanwhile.</li>
        <li><b>Point at a box or an arrow</b> to read what it is and why it is there. Click to keep the card open.</li>
        <li>Too abstract? In the card press <b>Example</b> for a worked example or <b>Simpler</b> for plainer words. The answers stay with the box.</li>
        <li>${i('note')} inserts the diagram and its descriptions into your note; ${i('copy')} copies it as Mermaid.</li>
      </ol>
      <h4>Editing by hand</h4>
      <ul>
        <li>Press ${i('pencil')} in the bar. Click a box or an arrow to change its text; the title, summary and groups become editable at the top.</li>
        <li><b>Drag a box</b> to move it. Boxes you moved stay where you put them; ${i(TIDY)} Tidy up lays everything out automatically again.</li>
        <li>“Arrow to…” then a click on another box joins two boxes; “Box below” adds a box under the one you are editing.</li>
        <li>${i(UNDO)} Undo and redo (${MOD}Z, Shift+${MOD}Z) step through your changes. The steps are kept until you reload the page.</li>
        <li>Everything is saved automatically.</li>
      </ul>`],
    ['write', 'Writing', `
      <h4>Projects</h4>
      <ul>
        <li>The Editor ${i('editor')} opens on your LaTeX projects, one card each: point at a card for <b>Open</b> and ${i('more')} (rename, download, delete). ${i('plus')} New project: blank, an example, a folder on this Mac, a <code>.zip</code>, or an import from Overleaf.</li>
      </ul>
      <h4>Editor and PDF</h4>
      <ul>
        <li>Files are on the left, the editor in the middle, the compiled PDF on the right. Recompile after changes; the log button shows errors you can click.</li>
        <li>The toolbar inserts styles, math, figures and tables. <code>\\cite</code> and <code>\\ref</code> offer your library entries and labels as you type.</li>
        <li>The arrow buttons jump between a place in the source and the same place in the PDF (or double-click the PDF).</li>
        <li>The compiled PDF has the same Find box, list of matches, table of contents, clickable links and Back button as the PDF of a paper. A search stays in place when you compile again.</li>
        <li>If the project loads <code>references.bib</code> (<code>\\bibliography{references}</code>) and you have not written that file yourself, it is rebuilt from your library before every compile. It holds only the papers the project cites, so co-authors and Overleaf do not get your whole library; “References…” in the project menu switches to the whole library or to the cited papers plus the papers of the project, and <code>\\nocite{*}</code> includes everything too. A <code>references.bib</code> of your own, or a .bib file with another name, is left untouched.</li>
        <li><b>Citation keys</b>: a <code>\\cite</code> key that has no entry is underlined in red as you type, with a red dot beside the line number; in a <code>.bib</code> file a key that is defined twice is marked the same way. Right-click the key (or click the dot) to change it to the closest key or to pick an entry from the library. “References…” in the project menu checks the whole project: keys without an entry, keys defined more than once, entries never cited, and cited entries without a year or venue or still only on arXiv. Click a row to go there. If the project loads a .bib file from outside its folder (or one of the TeX installation), its keys cannot be seen, so missing keys are not marked.</li>
        <li><b>Spelling and writing checks</b>: in a <code>.tex</code> file, misspelt words are underlined in red, and repeated words, a missing <code>~</code> before <code>\\ref</code> or <code>\\cite</code>, straight quotes <code>"</code>, braces or environments that do not match and TODO notes are marked. Right-click a mark to correct it or to add the word to the project dictionary; <kbd>F8</kbd> goes to the next mark. ${i('spell')} in the toolbar switches each check on or off for the project. Commands, math, cite keys and the names in your references are not checked.</li>
        <li>${i('sparkle')} <b>Ask Claude about a selection</b>: select text in the editor and right-click it (or press ${i('sparkle')} in the toolbar) to improve the wording, shorten it by about a fifth, translate it into academic English, or give an instruction of your own. The proposal appears under the passage: removed words in red, new ones in green. ${i('check')} accepts it, ${i('close')} keeps your text, ${i('refresh')} asks again. Nothing changes before you accept, and an accepted change is kept in the history as a version by Claude. “Find weak claims” answers in the Claude panel instead and changes nothing.</li>
        <li>${i(PAPERS)} <b>Papers of this project</b> (toolbar, or the project menu): the papers you added to the project in the Library, each with its reading status, how often it is cited and whether it has a note. Insert its <code>\\cite</code> at the cursor, open it in the Library, or take it out. Below are the papers the project cites but does not hold (add them with one click) and the cited papers you have not finished or have no note on. <b>Insert annotated bibliography</b> puts a LaTeX list of the papers with their briefs and key points at the cursor, without Claude (${MOD}Z takes it out again); <b>Export reading pack</b> is the same as in the Library. The <code>\\cite</code> picker and the completion list these papers first, marked cited, to read, reading or not cited; Draft related work and a new comparison table start with them when nothing is selected in the Library.</li>
        <li>${i('books')} <b>Library panel</b> (the books button in the icon rail on the left, or ${MOD === '⌘' ? '⇧⌘L' : 'Shift+Ctrl+L'}): your whole library beside the text, the papers of this project first, then one group per research line. Search by title, author, year or cite key. Click papers to select them, then <b>Cite</b> puts one <code>\\cite{a,b}</code> at the cursor; double-click a paper or drag it into the text to cite it there. Point at a paper to add it to the project, take it out, or open it in the Library.</li>
        <li>${i('quote')} <b>Draft related work</b>: tick papers of your library (filter by category, or select them in the Library list first), add one line on what the part should bring out, and Claude writes LaTeX that cites only those papers with <code>\\cite</code>. It works from your reading notes, key points and briefs, not from the PDFs, so papers you have notes on come out best; papers with nothing to go on are listed instead of described from memory. You see the draft before it is inserted at the cursor, between two comment lines.</li>
        <li><b>Word count and limits</b>: the outline shows the words of each section, counted again after every save, and the total above it. Click the total (or “Word count and limits…” in the project menu) to give the project a page limit and a word limit. The pages then appear against the limit above the PDF: amber at the limit, red over it. The reference list can be left out of the page count.</li>
        <li>${i('history')} History: every save is a version you can compare, name and restore.</li>
      </ul>
      <h4>Overleaf</h4>
      <ul>
        <li>Needs Overleaf's Git integration (a paid Overleaf feature). Import a project by its address, then use <b>Pull</b> and <b>Push</b> in the editor's top bar.</li>
        <li>The first import shows a command to run once in Terminal, where you give git your Overleaf Git token. The app never sees it.</li>
      </ul>`],
    ['claude', 'Claude Code', `
      <p>Every Claude feature here runs the Claude Code program installed on this Mac, under your own account.</p>
      <h4>Setting it up</h4>
      ${AIV('div', 'claude', `<ol>
        <li>Open the Claude panel ${i('sparkle')} and click the person ${i(USER)}, or: <button data-act="account">Open the Claude Code account</button></li>
        <li>If Claude Code is not installed, the window shows the one command that installs it.</li>
        <li>Press <b>Sign in with your Claude plan</b> (Pro, Max, Team, Enterprise) or <b>Sign in with API billing</b>. Your browser opens Anthropic's page; sign in and authorize there. If the page shows a code, paste it into the window.</li>
      </ol>
      <p class="gd-tip">You never type a password or an API key into ResearchTool. Claude Code keeps the login in the macOS Keychain, and the same login is used by <code>claude</code> in Terminal.</p>`, `<ol>
        <li>Open the Claude panel ${i('sparkle')} and click the person ${i(USER)}, or: <button data-act="account">Open the Claude Code account</button></li>
        <li>If Claude Code is not installed, the window shows the command that installs it.</li>
        <li>Sign in once in a terminal, with the command the window shows. ResearchTool has no sign-in of its own for this provider, and the window cannot sign you out.</li>
      </ol>
      <p class="gd-tip">You never type a password or an API key into ResearchTool: Claude Code keeps its own sign-in, the same one it uses in a terminal. Preferences › AI changes the provider at any time.</p>`)}
      <h4>Where Claude helps</h4>
      <ul>
        <li><b>Claude panel</b>${AIV('span', 'agentic', ': ask about the open paper or project. In a LaTeX project it can edit your files; each change is recorded in the history.', ': ask about the open paper or project. With this provider it only reads your files: it shows a change as text, for you to make.')}</li>
        <li>The answer appears while it is written; the send button turns into Stop ${i('stop')} (or press <kbd>Esc</kbd>). Claude is told the page you are on and the passage you selected in the PDF or in the editor - the selection is shown above the box and can be removed.</li>
        <li>Every paper and every project has its own conversation, kept on this browser and shown again when you come back. ${i('plus')} starts a fresh one.</li>
        <li><b>Library</b>: categories, tags, “Group with Claude”, and tables or one question across several papers.</li>
        <li><b>Reader</b>: “Generate first draft”, “Extract with Claude” for key points, and diagrams with examples.</li>
        <li><b>Write</b>: rewrite a selection with a comparison to accept or reject, and draft related work from papers of your library.</li>
        <li><b>Terminal</b>: the command at the bottom of the Claude panel opens Claude Code in the same data folder.</li>
        <li>${i('gear')} Preferences › AI shows what each Claude feature used in the last 7 days: calls, tokens and the average time of one call. “Claude usage” there sets how much those features may spend (Economy, Balanced, Best quality; the Claude panel is not affected), and “How Claude explains” is the instruction added to every explanation - edit it to change how Claude teaches.</li>
      </ul>
      <h4>If something does not work</h4>
      <ul>
        <li>“Not signed in” or an authentication error: open the account window and sign in again.</li>
        <li>You have reached a usage limit: wait for it to reset, or sign in with another account.</li>
      </ul>`],
    ['files', 'Files & keys', `
      <h4>Where your data is</h4>
      <ul>
        <li>Everything is in the <code>workspace</code> folder of the app: <code>library.json</code> (the list of references), <code>pdfs/</code>, <code>notes/</code>, <code>highlights/</code>, <code>diagrams/</code>, <code>quizzes/</code> (with the review dates), <code>compare/</code> (the tables of “Ask across papers”), <code>projects/</code>. The one exception: a project opened from a folder on this Mac stays in that folder.</li>
        <li>Removed papers, project files and replaced PDFs are not deleted for good: they go to <code>workspace/trash/</code>. A deleted diagram or quiz is gone for good.</li>
        <li>${i('trash')} at the top of the Library list opens <b>Recently deleted</b>: put a deleted paper back with its PDF, note, highlights, diagrams and quizzes, or empty the trash (only then are files removed for good). Right after deleting a paper, the arrow beside the message at the top undoes it.</li>
        <li><b>Backup</b>: ${i('gear')} Preferences › Library & files keeps a dated copy of the whole workspace once a day in the folder you choose there (best on another disk or in iCloud Drive); unchanged files take no extra space. “Show and restore backups…” lists the copies and puts one back - the workspace as it is now is kept as another backup first. Projects opened from a folder on this Mac are not part of the backup.</li>
        <li><b>The list of references</b> is copied before it changes, at most every 10 minutes, and right before each Codex run with “Let Codex edit files” (<code>workspace/backups/</code>). “List of references only” in the backups window puts a copy back and leaves the PDFs, notes and everything else as they are. If <code>library.json</code> cannot be read - after a broken edit by hand, say - nothing is loaded and nothing is overwritten: the window opens by itself so that you can put the last good copy back.</li>
        <li>To move to another Mac, copy the <code>workspace</code> folder (or the newest <code>snapshot-…</code> folder of the backup), plus the folder of each project you opened from disk.</li>
      </ul>
      <h4 data-at="keys">Keys</h4>
      <p>The single keys (<kbd>/</kbd>, <kbd>J</kbd>, <kbd>1</kbd> …) work while you are not typing: not in a text box, the note or the LaTeX editor.</p>
      <table class="gd-keys">
        <tr><td><kbd>${MOD}K</kbd></td><td>Go to anything: find a paper by its title, switch tabs, run an action of the screen you are on (in the note, with words selected, it makes a link instead)</td></tr>
        <tr><td><kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Enter</kbd>, <kbd>Esc</kbd> in Go to anything</td><td>move over the results, open or run one, close</td></tr>
        <tr><td><kbd>?</kbd></td><td>this list of keys</td></tr>
        <tr><td><kbd>/</kbd></td><td>put the cursor in the search box of the Library (or of the projects)</td></tr>
        <tr><td><kbd>↓</kbd> in the search box</td><td>go into the list</td></tr>
        <tr><td><kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Home</kbd> <kbd>End</kbd> in the list</td><td>move over the papers and the group headers</td></tr>
        <tr><td><kbd>Enter</kbd> in the list</td><td>open the paper; on a group header: open or close the group (also <kbd>→</kbd> <kbd>←</kbd>)</td></tr>
        <tr><td><kbd>Shift+↑</kbd> <kbd>Shift+↓</kbd>, <kbd>Space</kbd> in the list</td><td>select several papers</td></tr>
        <tr><td><kbd>⌘</kbd>+<kbd>Delete</kbd> in the list (or forward Delete)</td><td>move the paper, or the selected papers, to Recently deleted</td></tr>
        <tr><td><kbd>J</kbd> / <kbd>K</kbd> in the Library</td><td>open the next / previous paper of the list</td></tr>
        <tr><td><kbd>1</kbd>–<kbd>6</kbd> with a paper open</td><td>Notes, Diagram, Practice, Key points, Details, Related (<kbd>${ALT}1</kbd>–<kbd>${ALT}6</kbd> while typing or during a quiz)</td></tr>
        <tr><td><kbd>Page Down</kbd> / <kbd>Page Up</kbd></td><td>move the PDF of the open paper by a screen</td></tr>
        <tr><td><kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd></td><td>zoom the PDF in / out / fit its width</td></tr>
        <tr><td><kbd>${MOD}V</kbd> in the Library</td><td>add the copied arXiv ids, links, DOIs or BibTeX</td></tr>
        <tr><td><kbd>${MOD}Enter</kbd> in the “add papers” window</td><td>add what you typed or pasted</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>close the list, card or form that is open - one per press - then clear the selection</td></tr>
        <tr><td><kbd>Enter</kbd> in the Claude panel</td><td>send (Shift+Enter: new line)</td></tr>
        <tr><td><kbd>Esc</kbd> in the Claude panel</td><td>stop the answer that is being written</td></tr>
        <tr><td><kbd>${MOD}S</kbd> in the editor</td><td>save all files and add a version</td></tr>
        <tr><td><kbd>${MOD}Enter</kbd> in the editor</td><td>save and recompile the PDF</td></tr>
        <tr><td><kbd>${MOD}F</kbd> in the editor</td><td>search in the file</td></tr>
        <tr><td><kbd>${MOD}B</kbd> / <kbd>${MOD}I</kbd> / <kbd>${MOD}/</kbd> in the editor</td><td>bold / italic / comment the line in or out</td></tr>
        <tr><td><kbd>F8</kbd> / <kbd>Shift+F8</kbd> in the editor</td><td>next / previous spelling or writing problem</td></tr>
        <tr><td><kbd>${MOD}F</kbd> in a PDF</td><td>find in the whole PDF, with a list of matches</td></tr>
        <tr><td><kbd>${MOD}G</kbd> / <kbd>Shift+${MOD}G</kbd> in a PDF</td><td>next / previous match</td></tr>
        <tr><td><kbd>${MOD}[</kbd> or <kbd>${ALT}←</kbd> in a PDF</td><td>back to where you were before a jump</td></tr>
        <tr><td><kbd>${MOD}Z</kbd> / <kbd>Shift+${MOD}Z</kbd> in a diagram</td><td>undo / redo a hand edit</td></tr>
        <tr><td><kbd>1</kbd>–<kbd>4</kbd> or <kbd>A</kbd>–<kbd>D</kbd>, <kbd>Enter</kbd>, <kbd>H</kbd> in a quiz or the Review</td><td>choose an option, submit / next, hint</td></tr>
        <tr><td><kbd>←</kbd> <kbd>→</kbd> in a quiz or the Review</td><td>previous / next question (flash cards: <kbd>Space</kbd> turns the card)</td></tr>
        <tr><td><kbd>Enter</kbd> / <kbd>Esc</kbd> in a cell of a comparison table</td><td>keep / drop what you typed</td></tr>
        <tr><td><kbd>←</kbd> <kbd>→</kbd>, <kbd>Esc</kbd> in the tour</td><td>previous / next step, end the tour</td></tr>
      </table>`],
  ];

  document.body.insertAdjacentHTML('beforeend', `
<dialog id="dlg-guide" class="gd" aria-labelledby="gd-title">
  <div class="gd-head">${RT.crest(28)}<h3 id="gd-title">Guide</h3><span class="spacer"></span><button id="gd-close" class="ib ghost" title="Close (Esc)" aria-label="Close">${RT.icon('close')}</button></div>
  <div class="gd-main">
    <nav class="gd-tabs" role="tablist" aria-label="Guide sections" aria-orientation="vertical">${PAGES.map(([id, name]) => `<button role="tab" data-page="${id}">${RT.icon(PAGE_ICONS[id] || 'book-open')}<span>${name}</span></button>`).join('')}</nav>
    <div class="gd-body" id="gd-body" role="tabpanel"></div>
  </div>
</dialog>`);
  const dlg = $('#dlg-guide');

  function show(id) {
    const page = PAGES.find((p) => p[0] === id) || PAGES[0];
    $$('.gd-tabs button', dlg).forEach((b) => { const on = b.dataset.page === page[0]; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    const body = $('#gd-body'); body.innerHTML = (page[0] === 'start' ? INTRO() : '') + page[2]; body.scrollTop = 0;
    fitProvider();
    ls.set('rt.guide.page', page[0]);
  }
  // show the words that fit the chosen AI provider (see AIV)
  function fitProvider() {
    const has = (cap) => (!RT.ai ? true : cap === 'claude' ? RT.ai.isClaude() : RT.ai.caps()[cap] !== false);
    $$('#gd-body [data-ai-has]').forEach((el) => { el.hidden = !has(el.dataset.aiHas); });
    $$('#gd-body [data-ai-lacks]').forEach((el) => { el.hidden = has(el.dataset.aiLacks); });
  }
  if (RT.on) RT.on('ai:changed', fitProvider);
  // at: a heading of the page to start at (its data-at), e.g. open('files', 'keys')
  function open(id, at) {
    if (id === 'keys') { id = 'files'; at = at || 'keys'; } // RT.guide.open('keys'): the list of keys
    show(id || ls.get('rt.guide.page', 'start'));
    if (!dlg.open) dlg.showModal();
    const h = at ? $$('#gd-body [data-at]').find((el) => el.dataset.at === at) : null;
    if (h) h.scrollIntoView({ block: 'start' });
  }

  // arrow keys move between the sections
  $('.gd-tabs', dlg).addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = $$('.gd-tabs button', dlg), i = tabs.indexOf(document.activeElement);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (/Down|Right/.test(e.key) ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); tabs[j].focus(); show(tabs[j].dataset.page);
  });
  dlg.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.page) show(t.dataset.page);
    else if (t.id === 'gd-close') dlg.close();
    else if (t.dataset.act === 'account' && RT.account) { dlg.close(); RT.account.open(); }
    else if (t.dataset.act === 'tour' && RT.tour) { dlg.close(); RT.tour.start(); }
  });
  // #btn-help is the header's Help menu (core.js), which opens this with RT.guide.open()

  Object.assign(RT.guide, { open });
})();
