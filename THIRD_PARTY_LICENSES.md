# Third-party licences

ResearchTool's own code is MIT licensed (see [LICENSE](LICENSE)). Everything under `public/vendor/` is third-party
software, bundled so that the app works offline without a build step. The library code is copied unchanged from
the upstream distributions; only a selection of their files is included, and a few files were added or derived for
this repository (see "Changes to the bundled files" below). Each component keeps its own licence. Where upstream ships a licence file it is kept next to the code; the
others are collected in the files named in the "Licence text" column.

## Browser libraries

| Component | Version | Path | Licence | Copyright | Upstream | Licence text |
| --- | --- | --- | --- | --- | --- | --- |
| CodeMirror | 5.65.16 | `public/vendor/codemirror` | MIT | Marijn Haverbeke and others | https://codemirror.net/5/ | `codemirror/LICENSE` |
| PDF.js | 3.11.174 | `public/vendor/pdfjs` | Apache-2.0 | Mozilla Foundation | https://github.com/mozilla/pdf.js | `pdfjs/LICENSE` |
| Foxit PDFium fonts (in PDF.js) | - | `pdfjs/standard_fonts` | BSD-3-Clause | Foxit Software | https://pdfium.googlesource.com/pdfium/ | `pdfjs/standard_fonts/LICENSE_FOXIT` |
| Liberation Sans (in PDF.js) | - | `pdfjs/standard_fonts` | OFL-1.1 | Google, Red Hat | https://github.com/liberationfonts | `pdfjs/standard_fonts/LICENSE_LIBERATION` |
| Adobe CMaps (in PDF.js) | - | `pdfjs/cmaps` | BSD-3-Clause | Adobe Systems | https://github.com/adobe-type-tools/cmap-resources | `pdfjs/cmaps/LICENSE` |
| Vditor | 3.11.3 | `public/vendor/vditor` | MIT | B3log 开源 | https://github.com/Vanessa219/vditor | `vditor/LICENSE` |
| diff-match-patch (in Vditor) | - | `vditor/dist/index*.js` | Apache-2.0 | The diff-match-patch Authors | https://github.com/google/diff-match-patch | `vditor/THIRD_PARTY.txt` |
| Lute | 1.7.6 | `vditor/dist/js/lute` | MulanPSL-2.0 (Go runtime parts BSD-3-Clause) | b3log.org; The Go Authors | https://github.com/88250/lute | `vditor/dist/js/lute/LICENSE`, `vditor/THIRD_PARTY.txt` |
| KaTeX + mhchem | 0.16.9 | `vditor/dist/js/katex` | MIT | Khan Academy and other contributors | https://github.com/KaTeX/KaTeX | `vditor/THIRD_PARTY.txt` |
| highlight.js | 11.7.0 | `vditor/dist/js/highlight.js` | BSD-3-Clause | Ivan Sagalaev and contributors | https://github.com/highlightjs/highlight.js | `vditor/dist/js/highlight.js/LICENSE` |
| Mermaid | 11.16.1 | `vditor/dist/js/mermaid` | MIT | Knut Sveidqvist | https://github.com/mermaid-js/mermaid | `vditor/dist/js/mermaid/LICENSE` |
| DOMPurify (in Mermaid) | 3.4.0 | `vditor/dist/js/mermaid` | Apache-2.0 (dual Apache-2.0 / MPL-2.0; used under Apache-2.0) | Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53 (bundle header: Cure53 and other contributors) | https://github.com/cure53/DOMPurify | `vditor/dist/js/echarts/LICENSE` |
| lodash-es, js-yaml, cytoscape, dagre, khroma (in Mermaid) | - | `vditor/dist/js/mermaid` | MIT | their authors (see the bundle's licence comment) | see the bundle | `vditor/dist/js/mermaid/LICENSE` |
| d3 (in Mermaid) | - | `vditor/dist/js/mermaid` | ISC | Mike Bostock | https://github.com/d3/d3 | `vditor/THIRD_PARTY.txt` |
| Apache ECharts | 5.5.1 | `vditor/dist/js/echarts` | Apache-2.0 (includes ZRender) | The Apache Software Foundation | https://github.com/apache/echarts | `vditor/dist/js/echarts/LICENSE`, `vditor/dist/js/echarts/NOTICE` |
| Viz.js | 2.1.2 | `vditor/dist/js/graphviz` | MIT | Michael Daines | https://github.com/mdaines/viz.js | `vditor/dist/js/graphviz/LICENSE` |
| Graphviz (object code in Viz.js) | 2.40.1 | `vditor/dist/js/graphviz/full.render.js` | EPL-1.0 | Graphviz contributors | https://gitlab.com/graphviz/graphviz (source) | `vditor/dist/js/graphviz/LICENSE` |
| Expat, zlib (in Viz.js) | 2.2.5, - | `vditor/dist/js/graphviz` | MIT; zlib | Expat maintainers; Jean-loup Gailly and Mark Adler | https://libexpat.github.io, https://zlib.net | `vditor/dist/js/graphviz/LICENSE` |
| markmap | 0.14.x | `vditor/dist/js/markmap` | MIT | Gerald | https://github.com/markmap/markmap | `vditor/THIRD_PARTY.txt` |
| d3 6.7.0, d3-flextree, @gera2ld/jsx-dom, js-yaml 4.1.0, prism.css (in markmap) | - | `vditor/dist/js/markmap` | ISC; WTFPL; ISC; MIT; MIT | their authors | see `vditor/THIRD_PARTY.txt` | `vditor/THIRD_PARTY.txt` |
| abcjs | 5.10.3 | `vditor/dist/js/abcjs` | MIT | Paul Rosen and Gregory Dyke | https://github.com/paulrosen/abcjs | `vditor/THIRD_PARTY.txt` |
| flowchart.js + Raphael 2.3.0 | - | `vditor/dist/js/flowchart.js` | MIT | Adriano Raiano; Dmitry Baranovskiy, Sencha Labs | https://github.com/adrai/flowchart.js | `vditor/THIRD_PARTY.txt` |
| WaveDrom | 3.6.2 | `vditor/dist/js/wavedrom` | MIT | Aliaksei Chapyzhenka | https://github.com/wavedrom/wavedrom | `vditor/dist/js/wavedrom/LICENSE.WaveDrom` |
| plantuml-encoder (+ pako) | - | `vditor/dist/js/plantuml` | MIT (pako: MIT and zlib) | Markus Hedvall; Vitaly Puzrin, Andrei Tuputcyn | https://github.com/markushedvall/plantuml-encoder | `vditor/THIRD_PARTY.txt` |
| smiles-drawer (+ chroma.js, ColorBrewer) | - | `vditor/dist/js/smiles-drawer` | MIT (chroma.js: BSD-3-Clause; ColorBrewer: Apache-2.0) | GDB / Reymond Research Group; Gregor Aisch; Cynthia Brewer et al. | https://github.com/reymond-group/smilesDrawer | `vditor/THIRD_PARTY.txt` |
| Ant Design icons | - | `vditor/dist/js/icons/ant.js` | MIT | Ant UED | https://github.com/ant-design/ant-design-icons | `vditor/THIRD_PARTY.txt` |
| Material Design icons | - | `vditor/dist/js/icons/material.js` | Apache-2.0 | Google LLC | https://github.com/google/material-design-icons | `vditor/dist/js/echarts/LICENSE` |

Paths in the table without `public/vendor/` are relative to it.

## Fonts

All latin subsets from Fontsource 5.3.0, unmodified, in `public/vendor/fonts`; licence text and copyright lines in
`public/vendor/fonts/OFL.txt`.

| Font | Version | Licence | Copyright |
| --- | --- | --- | --- |
| Lato | 1.104 | OFL-1.1 (Reserved Font Name "Lato") | tyPoland Lukasz Dziedzic |
| Montserrat | 9.000 | OFL-1.1 | The Montserrat Project Authors |
| Roboto | 3.015 | OFL-1.1 | The Roboto Project Authors |
| Roboto Mono | 3.001 | OFL-1.1 | The Roboto Mono Project Authors |
| Share Tech | 1.100 | OFL-1.1 (Reserved Font Name "Share") | The Share Tech Project Authors (Carrois) |

## Changes to the bundled files

**The Vditor distribution** (`public/vendor/vditor`) is the `dist` folder of the npm package `vditor@3.11.3` (published
August 2026). The libraries inside it are the versions that package ships: Vditor's build copies them from its own
dependencies, which is why it contains Mermaid 11.16.1 and a WaveDrom 3.6.2 build dated 2026-7-8; they were not
upgraded for this repository, and their files are byte-identical to the package. To keep the repository small and
free of artwork that is not covered by Vditor's licence, these upstream files are not included: `dist/js/mathjax`
(unused: the app renders formulas with KaTeX), `dist/images/emoji` (custom emoji images, unused),
`dist/images/logo.png`, the TypeScript sources and type declarations (`dist/ts`, `dist/types`, `dist/*.d.ts`), and
every highlight.js style except `github` and `github-dark`.

**Files added or derived for this repository** (they hold licence information or are extracts; none of them changes
how a library works):

- `pdfjs/text-layer.css`: the `.textLayer` rules extracted from PDF.js 3.11.174 `web/pdf_viewer.css` (Apache-2.0), with a
  header line naming the source. The full `pdf_viewer.css` is bundled too.
- `vditor/THIRD_PARTY.txt`: written for this repository; lists the libraries inside the Vditor distribution that ship no
  licence file of their own, with their licence texts.
- `vditor/dist/js/graphviz/LICENSE`: written for this repository; Viz.js ships no licence file in the Vditor
  distribution, so this file collects the licences of Viz.js, Graphviz (EPL-1.0), Expat and zlib.
- `vditor/dist/js/mermaid/LICENSE`: Mermaid's MIT licence, with an added closing paragraph that points to the bundled
  packages listed in the "Bundled license information" comment of `mermaid.min.js`.
- `vditor/dist/js/lute/LICENSE`: the Mulan PSL v2 licence file of the Lute repository at tag v1.7.6, copied
  unchanged (the Lute build in the Vditor distribution ships without it).
- `vditor/dist/js/echarts/LICENSE` and `NOTICE`: the Apache-2.0 licence and the NOTICE of Apache ECharts 5.5.1, added
  next to the ECharts bundle (which ships without them in the Vditor distribution).
- `fonts/OFL.txt`: the SIL Open Font License 1.1, with a header written for this repository that lists the families,
  versions and copyright lines.

Line endings: one upstream file uses CRLF line endings (`vditor/dist/js/i18n/sv_SE.js`); `.gitattributes` marks
`public/vendor/` as binary for git, so it is stored byte for byte.

## Compatibility

Every component is under a permissive licence (MIT, ISC, BSD, Apache-2.0, Mulan PSL v2, zlib, WTFPL) or a file-level licence that
stays with its own files (OFL-1.1 for the fonts, EPL-1.0 for the Graphviz object code). None of them places
conditions on ResearchTool's own MIT-licensed code. Note for anyone relicensing a fork under the GPL: EPL-1.0 is not
GPL-compatible (remove `vditor/dist/js/graphviz`, used only for ```` ```graphviz ```` blocks), and the Apache-2.0
parts are incompatible with GPLv2-only.
