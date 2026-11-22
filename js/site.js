/* ResearchTool project page: language switch, hero loop, demo video + chapters, copy buttons, gallery lightbox, reveal. No cookies, no network calls. */
(function () {
  'use strict';
  var root = document.documentElement;
  var LS_KEY = 'rt-site-lang';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ demo data (real chapter marks of the two videos, ms) */
  var VIDEOS = {
    en: {
      src: 'media/researchtool-demo-en.mp4', poster: 'media/poster-en.jpg', label: 'ResearchTool · Product demo · 9:03',
      chapters: [
        [4500, 'Introduction', 'What ResearchTool is'],
        [30665, '1 · Overview', 'Start the guided tour'],
        [52927, '1 · Overview', 'What needs you today'],
        [77072, '1 · Overview', 'The whole tour, chapter by chapter'],
        [114203, '1 · Overview', 'Make the Overview your start page'],
        [127878, '2 · Header', '⌘K finds papers and actions'],
        [143149, '2 · Header', 'Help, More and the Claude button'],
        [159914, '3 · Library', 'Find a paper in the Library'],
        [183050, '3 · Library', 'Filters, groups and research lines'],
        [203303, '3 · Library', 'Bring papers in'],
        [219830, '4 · Reader', 'Open a paper'],
        [237660, '4 · Reader', 'Move around the PDF'],
        [256231, '4 · Reader', 'Highlight, snapshot, contents'],
        [280653, '5 · Notes', 'Your reading note'],
        [308161, '5 · Notes', 'Key points and details'],
        [325970, '6 · Claude panel', 'Claude, with your own account'],
        [346095, '7 · Explore', 'Diagram of the method'],
        [366453, '7 · Explore', 'Practice and daily review'],
        [383005, '7 · Explore', 'Related papers and lineage'],
        [404196, '7 · Explore', 'Compare papers'],
        [424408, '8 · Editor', 'The Editor: your projects'],
        [445378, '8 · Editor', 'Write and cite from your library'],
        [466229, '8 · Editor', 'Compile and preview'],
        [482592, '8 · Editor', 'History keeps every version'],
        [495462, '8 · Editor', 'Start from the example project'],
        [517037, 'Wrap-up', 'Where to go from here']
      ]
    },
    zh: {
      src: 'media/researchtool-demo-zh.mp4', poster: 'media/poster-zh.jpg', label: 'ResearchTool · 产品演示 · 11:00',
      chapters: [
        [4500, '简介', 'ResearchTool 是什么'],
        [40344, '第 1 章 · 概览', '开始导览'],
        [67030, '第 1 章 · 概览', '今天有什么要做'],
        [93823, '第 1 章 · 概览', '完整导览：逐章浏览'],
        [133235, '第 1 章 · 概览', '把概览设为启动页'],
        [151950, '第 2 章 · 顶栏', '⌘K 查找论文和操作'],
        [172698, '第 2 章 · 顶栏', '帮助、更多和 Claude 按钮'],
        [191903, '第 3 章 · 文献库', '在文献库里找论文'],
        [219555, '第 3 章 · 文献库', '筛选、分组与研究方向'],
        [245734, '第 3 章 · 文献库', '添加论文'],
        [269948, '第 4 章 · 阅读器', '打开论文'],
        [292170, '第 4 章 · 阅读器', '在 PDF 里定位'],
        [317919, '第 4 章 · 阅读器', '高亮、截图与目录'],
        [351613, '第 5 章 · 笔记', '阅读笔记'],
        [380730, '第 5 章 · 笔记', '要点与详情'],
        [400456, '第 6 章 · Claude 面板', 'Claude，用你自己的账号'],
        [424594, '第 7 章 · 探索', '方法图解'],
        [446978, '第 7 章 · 探索', '练习与每日复习'],
        [464497, '第 7 章 · 探索', '相关论文与发展脉络'],
        [489737, '第 7 章 · 探索', '对比论文'],
        [516047, '第 8 章 · 编辑器', '编辑器：你的项目'],
        [541060, '第 8 章 · 编辑器', '写作并引用文献库'],
        [568713, '第 8 章 · 编辑器', '编译与预览'],
        [588736, '第 8 章 · 编辑器', '历史保留每个版本'],
        [605612, '第 8 章 · 编辑器', '从示例项目开始'],
        [626623, '结语', '接下来']
      ]
    }
  };

  /* ------------------------------------------------------------ i18n */
  var ATTRS = ['alt', 'aria-label', 'content', 'title'];
  var translatable = Array.prototype.slice.call(document.querySelectorAll('[data-zh]'));
  translatable.forEach(function (el) { el._en = el.innerHTML; });
  var attrEls = [];
  ATTRS.forEach(function (a) {
    document.querySelectorAll('[data-zh-' + a + ']').forEach(function (el) {
      attrEls.push([el, a, el.getAttribute(a), el.getAttribute('data-zh-' + a)]);
    });
  });
  var titleEl = document.querySelector('title');

  var pageLang = root.getAttribute('data-lang') === 'zh' ? 'zh' : 'en';
  var videoLang = pageLang;

  function applyLang(lang, save) {
    pageLang = lang;
    root.setAttribute('data-lang', lang);
    root.lang = lang === 'zh' ? 'zh-CN' : 'en';
    translatable.forEach(function (el) {
      var html = lang === 'zh' ? el.getAttribute('data-zh') : el._en;
      if (el === titleEl) document.title = lang === 'zh' ? el.getAttribute('data-zh') : el._en;
      else if (el.innerHTML !== html) el.innerHTML = html;
    });
    attrEls.forEach(function (r) { r[0].setAttribute(r[1], lang === 'zh' ? r[3] : r[2]); });
    document.querySelectorAll('[data-set-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-set-lang') === lang)); });
    if (save) { try { localStorage.setItem(LS_KEY, lang); } catch (e) {} }
    setVideo(lang, false);
    if (dlg && dlg.open) showItem(current);
    syncHeroLabel();
  }
  document.querySelectorAll('[data-set-lang]').forEach(function (b) {
    b.addEventListener('click', function () { applyLang(b.getAttribute('data-set-lang'), true); });
  });

  /* ------------------------------------------------------------ video + chapters */
  var video = document.getElementById('demo-video');
  var chaptersBox = document.getElementById('chapters');
  var demoLabel = document.getElementById('demo-label');
  var chapterButtons = [];

  function fmt(ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function renderChapters() {
    var data = VIDEOS[videoLang];
    chaptersBox.innerHTML = '';
    chapterButtons = [];
    var groups = [], last = null;
    data.chapters.forEach(function (c, i) {
      if (!last || last.name !== c[1]) { last = { name: c[1], items: [] }; groups.push(last); }
      last.items.push({ t: c[0], title: c[2], i: i });
    });
    groups.forEach(function (g) {
      var wrap = document.createElement('div');
      wrap.className = 'chapter-group';
      var h = document.createElement('h4'); h.textContent = g.name; wrap.appendChild(h);
      var ol = document.createElement('ol');
      g.items.forEach(function (it) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'chapter'; b.setAttribute('data-t', it.t);
        var tm = document.createElement('time'); tm.textContent = fmt(it.t);
        tm.setAttribute('datetime', 'PT' + Math.floor(it.t / 1000) + 'S');
        var sp = document.createElement('span'); sp.textContent = it.title;
        b.appendChild(tm); b.appendChild(sp);
        b.setAttribute('aria-label', (videoLang === 'zh' ? '跳到 ' : 'Jump to ') + fmt(it.t) + ', ' + g.name + ' — ' + it.title);
        b.addEventListener('click', function () { seek(it.t / 1000); });
        li.appendChild(b); ol.appendChild(li);
        chapterButtons.push(b);
      });
      wrap.appendChild(ol);
      chaptersBox.appendChild(wrap);
    });
    chaptersBox.setAttribute('lang', videoLang === 'zh' ? 'zh-CN' : 'en');
    markChapter();
  }
  function seek(sec) {
    var go = function () {
      try { video.currentTime = sec; } catch (e) {}
      var p = video.play(); if (p && p.catch) p.catch(function () {});
    };
    if (video.readyState >= 1 && !pendingLoad) go();
    else {
      pendingLoad = false;
      video.preload = 'metadata';
      video.addEventListener('loadedmetadata', function once() { video.removeEventListener('loadedmetadata', once); go(); });
      video.load();
    }
    var top = video.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) video.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }
  function markChapter() {
    var t = (video.currentTime || 0) * 1000, cur = -1;
    chapterButtons.forEach(function (b, i) { if (+b.getAttribute('data-t') <= t + 250) cur = i; });
    if (!video.currentTime) cur = -1;
    chapterButtons.forEach(function (b, i) { if (i === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  }
  /* The <source> in the HTML is picked once by the browser; with preload="none" that downloads nothing.
     An explicit load() does start buffering in Chromium, so it is only called once the visitor has started
     the video (or picks a chapter). A switch before that is applied on the first play. */
  var pendingLoad = false;
  var fallback = document.getElementById('video-fallback');
  function started() { return video.readyState > 0 || !video.paused || video.currentTime > 0; }
  video.addEventListener('play', function () {
    if (!pendingLoad) return;
    pendingLoad = false;
    video.load();
    var p = video.play(); if (p && p.catch) p.catch(function () {});
  });
  function setFallback() {
    if (!fallback) return;
    var d = VIDEOS[videoLang];
    fallback.textContent = pageLang === 'zh' ? '你的浏览器无法播放这段视频。可以' : 'Your browser cannot play this video. You can ';
    var a = document.createElement('a'); a.href = d.src;
    a.textContent = pageLang === 'zh' ? '直接下载 MP4' : 'download the MP4';
    fallback.appendChild(a);
    fallback.appendChild(document.createTextNode(pageLang === 'zh' ? '。' : '.'));
  }
  function setVideo(lang, fromUser) {
    if (lang === videoLang && video.getAttribute('data-ready')) { if (!fromUser) { setFallback(); renderChapters(); } return; }
    videoLang = lang;
    var d = VIDEOS[lang];
    var src = video.querySelector('source');
    if (src.getAttribute('src') !== d.src) {
      var wasPlaying = !video.paused;
      src.setAttribute('src', d.src);
      video.setAttribute('poster', d.poster);
      if (started()) {
        video.pause();
        pendingLoad = false;
        video.load();
        if (wasPlaying && fromUser) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      } else {
        pendingLoad = true;
      }
    }
    video.setAttribute('data-ready', '1');
    video.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    video.setAttribute('aria-label', lang === 'zh' ? 'ResearchTool 产品演示（中文）' : 'ResearchTool product demo (English)');
    setFallback();
    demoLabel.textContent = d.label;
    document.querySelectorAll('[data-video-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-video-lang') === lang)); });
    renderChapters();
  }
  document.querySelectorAll('[data-video-lang]').forEach(function (b) {
    b.addEventListener('click', function () { setVideo(b.getAttribute('data-video-lang'), true); });
  });
  video.addEventListener('timeupdate', markChapter);
  video.addEventListener('seeked', markChapter);

  /* ------------------------------------------------------------ copy buttons */
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  /* Last resort: select the command so the visitor can copy it with the keyboard. */
  function failed(btn, codeEls) {
    var sel = window.getSelection && window.getSelection();
    if (sel && codeEls.length) {
      var r = document.createRange();
      r.setStartBefore(codeEls[0]); r.setEndAfter(codeEls[codeEls.length - 1]);
      sel.removeAllRanges(); sel.addRange(r);
    }
    live.textContent = pageLang === 'zh' ? '无法自动复制，已选中文字，请按 ⌘C 或 Ctrl+C 复制' : 'Could not copy automatically. The text is selected: press ⌘C or Ctrl+C';
    btn.setAttribute('title', live.textContent);
    setTimeout(function () { btn.removeAttribute('title'); }, 4000);
  }
  var live = document.createElement('div');
  live.className = 'visually-hidden'; live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  function done(btn) {
    btn.setAttribute('data-done', 'true');
    live.textContent = pageLang === 'zh' ? '已复制' : 'Copied';
    var use = btn.querySelector('use'); var prev = use && use.getAttribute('href');
    if (use) use.setAttribute('href', '#i-check');
    var label = btn.querySelector('[data-copy-label]'); var prevLabel = label && label.innerHTML;
    if (label) label.textContent = pageLang === 'zh' ? '已复制' : 'Copied';
    setTimeout(function () {
      btn.removeAttribute('data-done');
      if (use) use.setAttribute('href', prev);
      if (label) label.innerHTML = pageLang === 'zh' ? label.getAttribute('data-zh') : label._en;
      live.textContent = '';
    }, 1600);
  }
  document.querySelectorAll('.cmd .copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.parentNode.querySelector('code');
      copyText(code.textContent).then(function () { done(btn); }, function () { failed(btn, [code]); });
    });
  });
  document.querySelectorAll('[data-copy-all]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var codes = Array.prototype.slice.call(document.querySelectorAll('.cmd code'));
      var text = codes.map(function (c) { return c.textContent; }).join('\n');
      copyText(text).then(function () { done(btn); }, function () { failed(btn, codes); });
    });
  });

  /* ------------------------------------------------------------ hero loop: muted autoplay, never with reduced motion, pausable */
  var hero = document.getElementById('hero-video');
  var heroBtn = document.getElementById('hero-toggle');
  var heroPaused = false;   /* paused by the visitor */
  var heroVisible = true;
  var motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function heroAllowed() { return !(motionMQ && motionMQ.matches); }
  function syncHeroLabel() {
    if (!heroBtn) return;
    var playing = !hero.paused;
    heroBtn.setAttribute('aria-pressed', String(!playing));
    heroBtn.setAttribute('aria-label', pageLang === 'zh' ? (playing ? '暂停动画' : '播放动画') : (playing ? 'Pause the animation' : 'Play the animation'));
    heroBtn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play-s');
  }
  function heroUpdate() {
    if (!hero) return;
    var allowed = heroAllowed();
    heroBtn.hidden = !allowed;
    if (allowed && !heroPaused && heroVisible) {
      if (hero.preload !== 'auto') hero.preload = 'auto';
      var p = hero.play(); if (p && p.catch) p.catch(function () { syncHeroLabel(); });
    } else if (!hero.paused) {
      hero.pause();
    }
    if (!allowed && hero.currentTime) { hero.currentTime = 0; }
    syncHeroLabel();
  }
  if (hero && heroBtn) {
    hero.addEventListener('play', syncHeroLabel);
    hero.addEventListener('pause', syncHeroLabel);
    heroBtn.addEventListener('click', function () { heroPaused = !hero.paused; heroUpdate(); });
    if (motionMQ) { if (motionMQ.addEventListener) motionMQ.addEventListener('change', heroUpdate); else if (motionMQ.addListener) motionMQ.addListener(heroUpdate); }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { heroVisible = entries[0].isIntersecting; heroUpdate(); }, { threshold: 0.15 }).observe(hero);
    }
    document.addEventListener('visibilitychange', function () { heroVisible = !document.hidden; heroUpdate(); });
    heroUpdate();
  }

  /* ------------------------------------------------------------ CI badge: a plain text link when the badge cannot load */
  var badge = document.querySelector('.ci-badge img');
  function badgeFailed() {
    var t = document.createElement('span');
    t.className = 'ci-text'; t.textContent = 'CI';
    badge.parentNode.setAttribute('aria-label', pageLang === 'zh' ? 'CI 工作流' : 'CI workflow');
    badge.parentNode.replaceChild(t, badge);
  }
  if (badge) {
    if (badge.complete && badge.naturalWidth === 0 && badge.currentSrc) badgeFailed();
    else badge.addEventListener('error', badgeFailed);
  }

  /* ------------------------------------------------------------ lightbox (with paging through the screenshot gallery) */
  var dlg = document.getElementById('lightbox');
  var dlgImg = document.getElementById('lightbox-img');
  var dlgCap = document.getElementById('lightbox-cap');
  var prevBtn = dlg.querySelector('.lb-prev'), nextBtn = dlg.querySelector('.lb-next'), countEl = dlg.querySelector('.lb-count');
  var galleryItems = Array.prototype.slice.call(document.querySelectorAll('[data-gallery]'));
  var opener = null, current = null;
  function showItem(b) {
    current = b;
    var img = b.querySelector('img');
    var gi = galleryItems.indexOf(b);
    dlgImg.src = b.getAttribute('data-zoom');
    dlgImg.hidden = false;
    dlgImg.alt = img ? img.alt : '';
    dlgCap.textContent = '';
    if (gi >= 0) {
      var li = b.closest('li');
      var t = document.createElement('strong'); t.textContent = li.querySelector('.shot-title').textContent;
      dlgCap.appendChild(t);
      dlgCap.appendChild(document.createTextNode(li.querySelector('.shot-cap').textContent));
      countEl.textContent = (gi + 1) + ' / ' + galleryItems.length;
    } else {
      dlgCap.textContent = img ? img.alt : '';
    }
    prevBtn.hidden = nextBtn.hidden = countEl.hidden = gi < 0;
  }
  function step(d) {
    var gi = galleryItems.indexOf(current);
    if (gi < 0) return;
    showItem(galleryItems[(gi + d + galleryItems.length) % galleryItems.length]);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-zoom]');
    if (!b || !dlg.showModal) return;
    opener = b;
    showItem(b);
    dlg.showModal();
  });
  prevBtn.addEventListener('click', function () { step(-1); });
  nextBtn.addEventListener('click', function () { step(1); });
  dlg.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  dlg.querySelector('.close').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () {
    dlgImg.hidden = true;
    var back = galleryItems.indexOf(current) >= 0 ? current : opener;
    current = null;
    if (back) back.focus();
  });

  /* ------------------------------------------------------------ header: scrolled state, mobile menu, current section */
  var header = document.querySelector('.header');
  var onScroll = function () { header.classList.toggle('scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  var burger = document.querySelector('.burger');
  var mnav = document.getElementById('mobile-nav');
  function setMenu(open) {
    burger.setAttribute('aria-expanded', String(open));
    mnav.setAttribute('data-open', String(open));
    burger.querySelector('use').setAttribute('href', open ? '#i-x' : '#i-menu');
  }
  burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
  mnav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') { setMenu(false); burger.focus(); }
  });

  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav a'));
  if ('IntersectionObserver' in window) {
    var secIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = en.target.id === 'privacy' ? 'features' : en.target.id === 'faq' ? 'open-source' : en.target.id;
        navLinks.forEach(function (a) { if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['demo', 'features', 'screenshots', 'privacy', 'get-started', 'open-source', 'faq'].forEach(function (id) { var s = document.getElementById(id); if (s) secIO.observe(s); });
  }

  /* ------------------------------------------------------------ reveal on scroll (only below the fold; never with reduced motion) */
  if (!reduceMotion && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.setAttribute('data-reveal', 'shown'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      if (el.getBoundingClientRect().top > window.innerHeight) { el.setAttribute('data-reveal', 'hidden'); io.observe(el); }
    });
  }

  /* ------------------------------------------------------------ go */
  applyLang(pageLang, false);
})();
