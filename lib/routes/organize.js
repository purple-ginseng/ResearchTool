// "Organize from a file" (lib/organize.js; UI: public/js/organize.js)
//   POST /api/organize/parse { text, name? (file name), kind?: 'md' | 'bib', level?: 0-6 }  (text: at most 2 MB, a .bib 8 MB)
//     -> { kind, groups: [{ name, entries: [entry] }], stats: { entries, matched, unmatched, groups, truncated? } }
//   The references of a .md / .bib file, matched against the library and grouped by the file's headings (.md), its
//   comment headings or JabRef `groups` field (.bib). Nothing is written: the dialog applies the grouping itself with
//   /api/categories/apply, the item routes and /api/projects/:id/papers.
const core = require('../core');
const organize = require('../organize');

async function handle(ctx) {
  if (ctx.path !== '/api/organize/parse') return false;
  if (ctx.method !== 'POST') throw core.httpErr(405, 'Use POST');
  const b = await ctx.json(organize.MAX_TEXT_BIB * 6 + 4096); // JSON escaping can make the text several times larger
  if (typeof b.text !== 'string') throw core.httpErr(400, 'text must be a string');
  if (b.name != null && typeof b.name !== 'string') throw core.httpErr(400, 'name must be a string');
  if (b.kind != null && b.kind !== 'md' && b.kind !== 'bib') throw core.httpErr(400, "kind must be 'md' or 'bib'");
  const bibFile = organize.detectKind(b.text.slice(0, 200000), b.name, b.kind || undefined) === 'bib'; // .bib: 8 MB, else 2 MB
  if (Buffer.byteLength(b.text, 'utf8') > (bibFile ? organize.MAX_TEXT_BIB : organize.MAX_TEXT)) throw core.httpErr(413, `The file is too large (at most ${bibFile ? 8 : 2} MB)`);
  const level = b.level == null ? 0 : b.level;
  if (!Number.isInteger(level) || level < 0 || level > 6) throw core.httpErr(400, 'level must be a whole number from 0 to 6');
  return ctx.send(200, organize.parse(b.text, { name: String(b.name || '').slice(0, 300), kind: b.kind || undefined, level, items: core.loadLib().items }));
}

module.exports = { handle };
