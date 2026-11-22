# Preferences: display language (English / 中文)

This file documents the display-language layer of the Preferences feature (see also ARCHITECTURE.md).

## Files

```
public/js/i18n.js          the layer: a pure translator (createTranslator, also loads in Node) + the DOM part (RT.i18n)
public/js/i18n/zh.js       the Chinese dictionary: dict, keep, notUi, captureWords, rules
scripts/i18n-extract.js    finds the UI strings in public/js/*.js and public/index.html, reports what zh.js lacks
scripts/test-i18n.js       tests (pure: no browser, no server)
```

Load order in index.html: `js/core.js`, then `js/i18n/zh.js`, then `js/i18n.js` (it attaches `RT.i18n` when RT exists),
then the feature modules. The layer translates the page the moment it loads and watches every later change, so the
modules after it need nothing.

## How it works

English stays the source language of the code. The ~27 modules build their markup as HTML strings; instead of changing
every call site, one layer translates what ends up in the page:

- It walks the DOM (text nodes and the attributes `title`, `aria-label`, `placeholder`, `alt`, `data-tip`, `label`, and
  the `value` of `<input type=button|submit>`) and replaces a text whose trimmed form is in the dictionary, keeping the
  white space around it.
- A `MutationObserver` (childList, characterData, those attributes) applies the same to every added or changed node.
  The work runs inside the observer callback, which the browser batches per microtask before the next paint, so the
  English never flashes. The layer's own changes are dropped with `takeRecords()`; a record per node
  (`{src, out}` in a WeakMap) tells a translated value apart from new content, and switching back to English restores
  `src`.
- Matching, in order: `keep` (stays as it is: BibTeX, file names, commands), exact `dict` entry, a key with
  placeholders, the `rules`, then fallbacks: trailing `:` `…` `.` `!` `?` off ("Tags:" -> "标签："), `(…)` around a known
  text, a text of several lines line by line, and pieces joined by ` · ` one by one ("Dong et al. · 2026 · not cited" ->
  "Dong et al. · 2026 · 未引用").
- Keys with placeholders come from template literals: `` `Delete ${n} papers?` `` is the key `Delete {0} papers?`. The key
  becomes an anchored regex; the translation may reorder placeholders. What a placeholder captured is put back as it
  was (it is usually a title or a name), except a count ("3 papers" -> "3 篇论文" by the rules), a whole UI sentence of
  the dictionary, or one of `captureWords` (reading statuses, tab names). A key needs at least 3 letters of literal text
  (or 2 in 5 characters, "In “{0}”") to be used, and a capture never runs across a ` · ` the key does not have.
- A key with one placeholder at its start or end also answers for its words alone: `Hints on hover {0}` where `{0}`
  is a badge element gives the text node "Hints on hover".
- Never translated (the `SKIP` selector of i18n.js): `[data-i18n-skip]` and everything inside it, `<code>`, `<pre>`,
  `<kbd>`, `<textarea>` (its placeholder is), `<svg>`, contenteditable, the note editor (`.vditor`, `.vditor-reset`),
  CodeMirror, the pdf.js text and annotation layers, formulas, the Claude panel's user and bot messages (`.msg.user`,
  `.msg.bot`, `.md`), quiz / diagram / comparison-table text written by Claude, and paper data: titles, authors (`.au`),
  briefs, row tags, passages, highlight text, project and file names. Input values are never touched. When a new
  module shows user content in an element without one of these classes, add `data-i18n-skip` to it (library-list.js
  marks the row title and the brief this way).

## API

`RT.i18n` (also `window.RTI18n`):

| call | what it does |
|---|---|
| `lang()` | `'en'` or `'zh'` |
| `setLang(l)` | stores `rt.ui.lang`, sets `<html lang>` (`zh-CN` picks the CJK fallbacks of the font stacks) and `data-lang`, re-translates the page without a reload, calls `onChange` listeners and emits `i18n:changed` {lang} on RT |
| `languages` | `[{id: 'en', label: 'English'}, {id: 'zh', label: '中文'}]` for the Preferences select |
| `t(en, ...args)` | the translation of a string or a template (`t('Deleted {0}', '3 papers')`), for text the observer does not see: `window.confirm`, `document.title`, canvas, a value compared later |
| `translate(text)` | the translation or `null` |
| `apply(root)` | translate a subtree now (the observer does it anyway) |
| `onChange(fn)` | listener for language switches |
| `skip` | the selector of what is never translated |

Storage: `localStorage['rt.ui.lang']` (`'en'` when absent), per browser, read before the first module renders.

toast() and the RT.confirm / RT.ask dialogs are translated by the observer (they are DOM). `toast()` puts the English
message in the page and lets the observer translate it, so a later language switch can still re-translate it; its Undo
button tells "this toast is still up" by a sequence number, not by comparing the text. Only the `window.confirm` /
`window.prompt` fallbacks of `RT.confirm` / `RT.ask` call `RT.i18n.t()` (a native dialog is not DOM), and so does any
text handed to a third-party widget the observer skips (the note editor's placeholder in reader.js).

A placeholder at the very start or end of a key, touching a bare word (`{0} papers`, `{0} found`, `Show {0}`,
`New {0}`), has no delimiter, so there a capture of several words must look like a count the rules know, a UI
sentence, or a title / name: "Lineage of your papers" is not "Lineage of your 篇论文", "1 not found" is not "找到 1 not".
A key whose capture would be empty ("Add{0} to “{1}”" for "Add to “X”") is used only when no other key fits; the forms
without the optional count have their own entries.

Removing an attribute keeps its record (tips.js moves a `title` aside while its hint shows and puts it back), so
switching back to English restores the source text.

## The dictionary and its extraction

`node scripts/i18n-extract.js` reads every `public/js/*.js` (lineage.js is left out by default; `--with lineage.js`
takes it in) and `public/index.html` with a small JavaScript lexer (comments, strings, template literals with nested
`${…}`, regex literals). In HTML strings it takes the text between tags and the translatable attributes; an
interpolated icon / element (`icon(…)`, `…Html`, `.map(` …) counts as a tag boundary, any other `${…}` becomes `{0}`,
`{1}` …. Other literals count when they read like text (capitalised word or words with spaces, not a selector, class
list, URL, API path, event name, CSS or code). Strings listed in `zh.notUi` (headers, prompts sent to Claude) are not
counted.

```
node scripts/i18n-extract.js               coverage + the first untranslated strings
node scripts/i18n-extract.js --missing     every untranslated string with its file:line
node scripts/i18n-extract.js --json f.json the untranslated strings as {"English": ""} to fill in
node scripts/i18n-extract.js --with lineage.js
node scripts/test-i18n.js
```

To translate new strings: run `--missing` (or `--json`), add the entries at the end of `dict` in
`public/js/i18n/zh.js` (natural, concise Simplified Chinese; keep Claude, BibTeX, PDF, LaTeX, arXiv, DOI, Overleaf, VLA
… as they are; keep every placeholder of the key), put names that stay English in `keep` and non-UI strings in
`notUi`, then run the tests. A count with a new noun goes into `NOUNS` of zh.js.

Coverage when this was written: 2881 UI strings found outside lineage.js and 3232 with it (`--with lineage.js`), all
translated (100 %). The dictionary has 3448 entries (748 with placeholders), 50 keep, 95 notUi, 7 rules. The extractor
takes pieces of up to 2000 characters (the translator's own limit); a few texts it cannot see are in the dictionary by
hand: pieces with `{braces}`, and texts built from parts (`'Sort by ' + name`, the chips and button labels of
lineage.js).

Lineage (lineage.js) notes:
- A capture is put back as it was, so a template whose placeholder holds an English phrase (`Asking Semantic Scholar
  how ${'the citing paper cites' / 'the 3 citing papers cite'} it…`) has its compound forms as entries of their own,
  and toasts built from `" · "` pieces have an entry per piece (`{0} already in your library`).
- The history line is an `<svg>` (never translated by the observer): its tooltips and aria-labels go through
  `RT.i18n.translate` in lineage.js (`T()`), and the window is drawn again on `i18n:changed`.
- A row's reasons (`e.why`, written by the server: "Cited by 5 of these 12 papers and by … Relevance 4.2.") are
  translated sentence by sentence (`whyT()`); the server's sentences and the notes of a computation have entries.
- `RT.texPlain` (set by lineage.js) turns inline LaTeX of a title into text ("$π_{0.7}$" -> "π0.7") for the toasts of
  project-papers.js and safety.js.

Engine rules added with this pass: a count-noun key (`{0} papers`) takes only a count, never one of `captureWords`
("Reading papers" has its own entry, not "在读 篇论文"); a text of several lines is matched whole only by an entry
(dictionary, key or rule) - otherwise line by line, so a tooltip keeps its lines.

## Not covered yet

- Strings built in the server (error messages from `/api`) stay English.
- The note editor's own toolbar comes from Vditor; its language is Vditor's `lang` option (`zh_CN` exists in
  `/vendor/vditor/dist/js/i18n/`), and its placeholder ("Reading note…") is an option of reader.js - both are for
  reader.js to pass from `RT.i18n.lang()`.
- Dates from `toLocaleDateString()` follow the browser locale, not the display language.

# Preferences dialog, theme and hover hints

```
public/js/ui-boot.js   in <head>: <html data-theme>, data-hints and (for 中文) lang / data-lang before the first paint
public/js/prefs.js     the Preferences dialog (#dlg-settings, it replaces the Settings dialog of core.js): General,
                       Claude, Library & files, Write; RT.prefs = {open(pane), draftLanguage(), setDraftLanguage(l),
                       theme(), isDark()}; events 'theme:changed', 'prefs:draftLanguage', 'prefs:saved'
public/js/tips.js      fast hover / focus hints (RT.tips = {configure, hide}; data-no-tip turns one off)
public/css/prefs.css   the dialog and the data-theme light / dark overrides
public/css/tips.css    the hint
```

Load order: ui-boot.js in `<head>`; then core.js, i18n/zh.js, i18n.js, prefs.js, tips.js, then the modules.

Storage: per browser (localStorage) `rt.ui.lang` (en | zh), `rt.ui.hints` (fast | normal | off), `rt.ui.theme`
(system when absent | light | dark), `rt.ui.prefsPane`; the Write options keep `rt-auto-compile` / `rt-halt-on-error`.
In the workspace (settings.json, PUT /api/settings): `draftLanguage` ('zh' | 'en', 'zh' when absent; anything else is a
400). POST /api/items/:id/note/draft and /note/ask use it when the request gives no language (lib/notes.js
pickLanguage); the reader sends the cached value of RT.prefs.draftLanguage(), and its "Draft language" select edits the
same setting.

Not covered yet: the note editor (Vditor) keeps the language it was created with until the note is opened again; a
change of the Write compile options applies after a reload.
