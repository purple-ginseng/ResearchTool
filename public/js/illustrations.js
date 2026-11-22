/* Illustrations for empty states, onboarding and small success moments, hand-ported from the Purple Ginseng design
   system (original artwork by purple-ginseng). Each one returns an SVG string, decorative (aria-hidden):
     RT.ill.emptyLibrary({size}) emptySearch emptyNotes emptyInbox (240x180), onboardingImport onboardingWelcome
     (320x240), successCelebration (160x160)
   size: the width in px (the height follows the drawing); without it the SVG fills its box (CSS sets the width).
   Colours come only from the --ill-* variables (css/illustrations.css, light and dark), each with its light value as
   the fallback; every gradient id is unique per call. RT.emptyState({ill: 'emptyLibrary', ...}) in core.js uses these. */
(() => {
  const c = {
    primary: 'var(--ill-primary, #7b4cc2)', primarySoft: 'var(--ill-primary-soft, #ece3fa)', primaryMid: 'var(--ill-primary-mid, #b89be6)',
    primaryDeep: 'var(--ill-primary-deep, #4a2a86)', pink: 'var(--ill-pink, #d1477f)', pinkSoft: 'var(--ill-pink-soft, #fbe1ec)',
    yellow: 'var(--ill-yellow, #c9971a)', yellowBright: 'var(--ill-yellow-bright, #f2c14e)', yellowSoft: 'var(--ill-yellow-soft, #fcefc7)',
    leaf: 'var(--ill-leaf, #4f9a72)', leafSoft: 'var(--ill-leaf-soft, #d9eee2)', paper: 'var(--ill-paper, #ffffff)', edge: 'var(--ill-edge, #e4def0)',
    line: 'var(--ill-line, #ddd6ea)', lineStrong: 'var(--ill-line-strong, #b9aed0)', ink: 'var(--ill-ink, #2b2340)', muted: 'var(--ill-muted, #8d84a3)',
    bg: 'var(--ill-bg, #f4effb)', bg2: 'var(--ill-bg-2, #fcf0f5)', shadow: 'var(--ill-shadow, #3a1f6b)', shadowOpacity: 'var(--ill-shadow-opacity, 0.08)',
    onAccent: 'var(--ill-on-accent, #ffffff)',
  };
  let seq = 0;
  const uid = () => `rt-ill${++seq}`;
  // colours are CSS variables: they go into style="" (an attribute value like fill="var(--x)" is not CSS)
  const f = (col, op) => `style="fill:${col}${op != null ? `;fill-opacity:${op}` : ''}"`;
  const svg = (w, h, size, body) => `<svg class="rt-ill" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${size ? ` width="${size}" height="${Math.round((size * h) / w)}"` : ''} aria-hidden="true" focusable="false">${body}</svg>`;
  const grad = (id, { x1 = 0, y1 = 0, x2 = 1, y2 = 1, yellow = true } = {}) => `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" style="stop-color:${c.primary}"/><stop offset="${yellow ? 0.6 : 1}" style="stop-color:${c.pink}"/>${yellow ? `<stop offset="1" style="stop-color:${c.yellowBright}"/>` : ''}</linearGradient>`;
  const card = (x, y, w, h, r = 12, lift = 6) => (lift > 0 ? `<rect x="${x + 2}" y="${y + lift}" width="${w - 4}" height="${h}" rx="${r}" style="fill:${c.shadow};fill-opacity:${c.shadowOpacity}"/>` : '')
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"/>`;
  const lines = (x, y, w, n, gap = 10, h = 4, col = c.line, last = 0.6) => Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * gap}" width="${i === n - 1 && n > 1 ? w * last : w}" height="${h}" rx="${h / 2}" ${f(col)}/>`).join('');
  const sparkle = (x, y, r, col = c.yellowBright) => { const k = r * 0.22; return `<path d="M${x} ${y - r}C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r}C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z" ${f(col)}/>`; };
  const leaf = (x, y, { s = 1, rot = 0, col = c.leaf, op, vein = true } = {}) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})"><path d="M0 0C-7 -6 -7 -18 0 -26C7 -18 7 -6 0 0Z" ${f(col, op)}/>${vein ? `<path d="M0 -2V-21" style="stroke:${c.paper}" stroke-opacity="0.55" stroke-width="1.2" stroke-linecap="round" fill="none"/>` : ''}</g>`;
  const sprig = (x, y, s = 1, col = c.leaf) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 0C0 -10 2 -18 6 -24" style="stroke:${col}" stroke-width="2.4" stroke-linecap="round" fill="none"/>${leaf(6, -24, { rot: -28, s: 0.7, col, vein: false })}${leaf(6, -24, { rot: 18, s: 0.78, col, vein: false })}${leaf(6, -24, { rot: 62, s: 0.6, col, vein: false })}<circle cx="6" cy="-24" r="2.4" ${f(c.pink)}/></g>`;
  const node = (x, y, r = 6, col = c.primary, ring = c.paper) => `<circle cx="${x}" cy="${y}" r="${r}" style="fill:${col};stroke:${ring}" stroke-width="2.5"/>`;
  const stroke = (col, w, extra = '') => `style="stroke:${col}" stroke-width="${w}" fill="none" stroke-linecap="round"${extra}`;

  const ill = {
    // an open tray waiting for its first papers
    emptyLibrary({ size } = {}) {
      const id = uid();
      return svg(240, 180, size, `<defs>${grad(id + '-g')}</defs><circle cx="120" cy="92" r="76" ${f(c.bg)}/>${sprig(36, 146, 1.15)}`
        + `<g transform="rotate(-9 104 92)"><rect x="76" y="44" width="62" height="80" rx="8" style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"/>${lines(86, 58, 40, 4, 9)}</g>`
        + `<g transform="rotate(7 138 90)"><rect x="110" y="36" width="62" height="86" rx="8" style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"/><rect x="120" y="48" width="42" height="7" rx="3.5" ${f(c.primaryMid)}/><rect x="120" y="62" width="42" height="14" rx="4" ${f(c.yellowSoft)}/>${lines(120, 65, 38, 4, 9)}</g>`
        + `<path d="M60 104h120l-8 44a8 8 0 0 1-8 6.6H76a8 8 0 0 1-8-6.6Z" ${f(c.primarySoft)}/><path d="M60 104h120l-2 10H62Z" ${f(c.primaryMid)}/><rect x="102" y="124" width="36" height="8" rx="4" ${f(c.paper, 0.9)}/>`
        + `<circle cx="182" cy="50" r="16" fill="url(#${id}-g)"/><path d="M182 43v14M175 50h14" ${stroke(c.onAccent, 3)}/>${sparkle(52, 52, 7)}${sparkle(200, 118, 5, c.pink)}`);
    },
    // a magnifier over blank papers
    emptySearch({ size } = {}) {
      return svg(240, 180, size, `<circle cx="116" cy="92" r="76" ${f(c.bg)}/><g transform="rotate(-8 92 96)"><rect x="56" y="48" width="70" height="92" rx="9" style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"/>${lines(68, 62, 46, 6, 11)}</g>`
        + `<rect x="104" y="40" width="70" height="92" rx="9" style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"/>${lines(116, 54, 46, 3, 11)}`
        + `<path d="M160 124l26 26" ${stroke(c.primaryDeep, 11)}/><path d="M160 124l26 26" ${stroke(c.primary, 7)}/>`
        + `<circle cx="138" cy="102" r="30" style="fill:${c.primarySoft};fill-opacity:0.85;stroke:${c.primary}" stroke-width="7"/>`
        + `<circle cx="126" cy="104" r="3.5" ${f(c.primary)}/><circle cx="138" cy="104" r="3.5" ${f(c.pink)}/><circle cx="150" cy="104" r="3.5" ${f(c.yellow)}/>`
        + `<path d="M124 86a18 18 0 0 1 12-6" ${stroke(c.paper, 3, ' opacity="0.8"')}/>${sparkle(52, 40, 7)}${sparkle(196, 60, 5, c.pink)}`);
    },
    // a blank notepad, a pencil and an AI sparkle ready to help
    emptyNotes({ size } = {}) {
      const id = uid();
      return svg(240, 180, size, `<defs>${grad(id + '-g')}</defs><circle cx="118" cy="92" r="76" ${f(c.bg)}/>${card(74, 34, 96, 122, 12)}`
        + `<rect x="74" y="34" width="96" height="22" rx="12" ${f(c.primarySoft)}/><rect x="74" y="46" width="96" height="10" ${f(c.primarySoft)}/>`
        + [92, 110, 128, 146].map((x) => `<rect x="${x - 2.5}" y="28" width="5" height="16" rx="2.5" ${f(c.primary)}/>`).join('')
        + `<path d="M88 76h68M88 94h68M88 112h68M88 130h40" ${stroke(c.line, 3, ' stroke-dasharray="1 8"')}/>`
        + `<g transform="rotate(38 176 112)"><rect x="168" y="70" width="16" height="64" rx="4" ${f(c.yellowBright)}/><rect x="168" y="70" width="16" height="10" rx="4" ${f(c.pink)}/><rect x="168" y="78" width="16" height="4" ${f(c.lineStrong)}/><path d="M168 134h16l-8 14Z" ${f(c.yellowSoft)}/><path d="M173.4 143.4h5.2L176 148Z" ${f(c.ink)}/></g>`
        + `<circle cx="64" cy="132" r="18" fill="url(#${id}-g)"/>${sparkle(64, 132, 10, c.onAccent)}${sparkle(196, 44, 7)}${sparkle(50, 56, 5, c.primaryMid)}`);
    },
    // a clear tray with a check, a leaf drifting by
    emptyInbox({ size } = {}) {
      const id = uid();
      return svg(240, 180, size, `<defs>${grad(id + '-g')}</defs><circle cx="120" cy="96" r="76" ${f(c.bg)}/>`
        + `<path d="M56 112l18-40a8 8 0 0 1 7.3-4.8h77.4a8 8 0 0 1 7.3 4.8l18 40v30a10 10 0 0 1-10 10H66a10 10 0 0 1-10-10Z" style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"/>`
        + `<path d="M56 112h40a6 6 0 0 1 6 6 8 8 0 0 0 8 8h20a8 8 0 0 0 8-8 6 6 0 0 1 6-6h40v30a10 10 0 0 1-10 10H66a10 10 0 0 1-10-10Z" ${f(c.primarySoft)}/>`
        + `<path d="M84 84h72M78 98h84" ${stroke(c.line, 4)}/><circle cx="120" cy="46" r="20" fill="url(#${id}-g)"/>`
        + `<path d="M111 46.5l6 6 12-12.5" ${stroke(c.onAccent, 4, ' stroke-linejoin="round"')}/>`
        + `${leaf(190, 78, { rot: 52, s: 0.9 })}${leaf(44, 70, { rot: -40, s: 0.62, op: 0.45, vein: false })}${sparkle(168, 30, 7)}${sparkle(70, 34, 5, c.pink)}`);
    },
    // bring papers in: files glide along an arc into the library
    onboardingImport({ size } = {}) {
      const id = uid();
      return svg(320, 240, size, `<defs>${grad(id + '-g', { x2: 1, y2: 0 })}</defs><circle cx="166" cy="124" r="100" ${f(c.bg)}/>`
        + `<path d="M78 84C120 26 206 30 238 108" stroke="url(#${id}-g)" stroke-width="3" stroke-dasharray="2 8" stroke-linecap="round" fill="none"/>`
        + `<path d="M230 102l8 8 4-11" ${stroke(c.yellow, 3, ' stroke-linejoin="round"')}/>`
        + `<g transform="rotate(-10 66 116)">${card(34, 80, 62, 80, 9, 4)}<rect x="44" y="92" width="24" height="12" rx="4" ${f(c.pink)}/>${lines(44, 114, 42, 4, 9)}</g>`
        + `<g transform="rotate(14 150 58)">${card(128, 34, 46, 58, 8, 3)}<rect x="136" y="43" width="18" height="9" rx="3" ${f(c.primary)}/>${lines(136, 58, 30, 3, 8)}</g>`
        + `<rect x="190" y="122" width="104" height="80" rx="14" ${f(c.primarySoft)}/><rect x="202" y="134" width="14" height="56" rx="4" ${f(c.primary)}/><rect x="220" y="140" width="14" height="50" rx="4" ${f(c.pink)}/><rect x="238" y="130" width="14" height="60" rx="4" ${f(c.primaryMid)}/>`
        + `<g transform="rotate(12 266 162)"><rect x="258" y="136" width="14" height="54" rx="4" ${f(c.yellowBright)}/></g><rect x="190" y="190" width="104" height="12" rx="6" ${f(c.primaryMid)}/>`
        + `${sparkle(290, 100, 8)}${sparkle(110, 186, 6, c.pink)}${sparkle(40, 48, 5, c.primaryMid)}`);
    },
    // an open book whose spine grows a ginseng sprig
    onboardingWelcome({ size } = {}) {
      const id = uid();
      const sh = `style="fill:${c.shadow};fill-opacity:${c.shadowOpacity}" transform="translate(0 6)"`, pg = `style="fill:${c.paper};stroke:${c.edge}" stroke-width="1.5"`;
      return svg(320, 240, size, `<defs>${grad(id + '-g')}</defs><circle cx="160" cy="124" r="100" ${f(c.bg)}/><circle cx="252" cy="58" r="28" ${f(c.bg2)}/>`
        + `${card(30, 60, 64, 44, 10, 4)}${lines(40, 72, 44, 3, 8)}<rect x="38" y="70" width="48" height="10" rx="4" ${f(c.yellowSoft)}/><rect x="40" y="72" width="44" height="4" rx="2" ${f(c.yellow, 0.5)}/>`
        + `${card(232, 130, 64, 48, 10, 4)}<path d="M248 166L264 146 282 160" ${stroke(c.lineStrong, 2)}/>${node(248, 166, 4, c.primaryMid)}${node(264, 146, 5, c.pink)}${node(282, 160, 4, c.yellowBright)}`
        + `<path d="M160 132c-20-14-44-18-72-12v80c28-6 52-2 72 12Z" ${sh}/><path d="M160 132c20-14 44-18 72-12v80c-28-6-52-2-72 12Z" ${sh}/>`
        + `<path d="M158 132c-20-14-44-18-70-12v80c26-6 50-2 70 12Z" ${pg}/><path d="M162 132c20-14 44-18 70-12v80c-26-6-50-2-70 12Z" ${pg}/>`
        + `<path d="M158 212c-20-14-44-17-70-12M162 212c20-14 44-17 70-12" ${stroke(c.primaryMid, 3)}/>`
        + `<path d="M100 138c16-3 31-1 44 6M100 152c16-3 31-1 44 6M100 166c16-3 31-1 44 6M100 180c10-2 20-1 28 2" ${stroke(c.line, 4)}/>`
        + `<path d="M176 144c13-7 28-9 44-6M176 158c13-7 28-9 44-6M176 172c13-7 28-9 44-6" ${stroke(c.line, 4)}/>`
        + `<path d="M160 134V78" ${stroke(c.leaf, 4)}/>${leaf(160, 100, { rot: -58, s: 1.35 })}${leaf(160, 100, { rot: 58, s: 1.35 })}${leaf(160, 80, { rot: -22, s: 1.5 })}${leaf(160, 80, { rot: 22, s: 1.5 })}`
        + `<circle cx="160" cy="76" r="7" fill="url(#${id}-g)" style="stroke:${c.paper}" stroke-width="2.5"/>${sparkle(112, 66, 9)}${sparkle(214, 84, 7, c.pink)}${sparkle(60, 168, 6, c.primaryMid)}`);
    },
    // a gradient check with soft confetti
    successCelebration({ size } = {}) {
      const id = uid();
      const confetti = [[30, 46, -20, 'pink'], [128, 38, 30, 'yellowBright'], [22, 108, 40, 'primaryMid'], [136, 112, -35, 'pink'], [62, 20, 10, 'primaryMid'], [104, 140, 15, 'yellowBright']];
      return svg(160, 160, size, `<defs>${grad(id + '-g')}</defs><circle cx="80" cy="80" r="50" ${f(c.bg)}/><circle cx="80" cy="80" r="34" fill="url(#${id}-g)"/>`
        + `<path d="M65 81l10 10 21-22" ${stroke(c.onAccent, 7, ' stroke-linejoin="round"')}/>`
        + confetti.map(([x, y, r, k]) => `<rect x="${x - 6}" y="${y - 2.5}" width="12" height="5" rx="2.5" ${f(c[k])} transform="rotate(${r} ${x} ${y})"/>`).join('')
        + `<circle cx="44" cy="136" r="3.5" ${f(c.primary)}/><circle cx="142" cy="72" r="3" ${f(c.yellow)}/><circle cx="16" cy="76" r="3" ${f(c.pink)}/>`
        + `${sparkle(122, 18, 7)}${sparkle(20, 20, 5, c.pink)}${sparkle(144, 146, 5, c.primaryMid)}`);
    },
  };
  RT.ill = ill;
})();
