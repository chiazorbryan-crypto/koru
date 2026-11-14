// Koru reader: long-strip (manhwa) or page-by-page (manga), with saved progress, offline pages,
// chapter drawer, auto next chapter and keyboard controls.
'use strict';
(function () {
  const { el, icon } = K;
  const DEFAULTS = { mode: 'strip', rtl: false, gap: 0, width: 760, autoNext: true, preload: 4, tapZones: true, ambient: true, ambStrength: 55, ambBlur: 90, ambMode: 'page', ambSat: 170, ambEase: 45, ambCalm: true, fps: false, zen: false, autoSpeed: 90, autoSecs: 8, autoStart: false, autoDl: 1, autoDlClean: true, countdown: true, clock: true,
    night: false, nightWarm: 50, nightDim: 80, nightAuto: false, nightFrom: 21, nightTo: 7, spread: 'auto', spreadCover: true };
  K.readerSettings = () => ({ ...DEFAULTS, ...(K.data.settings.reader || {}) });
  const setReader = patch => { K.data.settings.reader = { ...K.readerSettings(), ...patch }; K.save('settings'); };

  let box = null, state = null;
  let autoKeep = false;   // auto-scroll carries on into the next chapter while it's on
  // Night filter switched by hand against the schedule: holds until the schedule itself changes (evening/morning)
  let nightOverride = null;
  // a small keyboard drawing for the shortcuts button (trusted constant)
  const kbIcon = () => { const s = icon('dot'); s.innerHTML = '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>'; return s; };

  // Background worker that decodes pages and draws their slices (see slicer.js).
  let slicer = null, sliceSeq = 0;
  const waits = new Map();
  const ask = (msg, transfer) => {
    if (!slicer) {
      slicer = new Worker('js/slicer.js');
      slicer.onmessage = e => { const w = waits.get(e.data.id); if (!w) return; waits.delete(e.data.id); e.data.type === 'error' ? w.reject(new Error(e.data.error)) : w.resolve(e.data); };
    }
    return new Promise((resolve, reject) => { waits.set(msg.id, { resolve, reject }); slicer.postMessage(msg, transfer || []); });
  };
  const freeJob = id => { if (id && slicer) slicer.postMessage({ type: 'free', id }); };

  K.readingSeries = () => (box && state ? state.provider + ':' + state.slug : null);
  K.closeReader = function (fromRoute) {
    if (!box) return;
    setTimeout(() => K.cleanAutoDownloads?.(), 4000);
    saveProgress();
    state?.cleanup?.();
    const b = box; box = null; state = null;
    document.documentElement.classList.remove('reading');
    if (b.classList.contains('zen')) K.api.post('/k/fullscreen', { on: false }).catch(() => {});
    b.style.animation = 'fade-out var(--t-fast) both';
    setTimeout(() => b.remove(), 180);
    if (!fromRoute) K.back();
  };

  function saveProgress() {
    if (!state?.chapter || !state.pages?.length || K.incognito() || K.flag(state.provider, state.slug).trash) return;
    const { provider, slug, series } = state;
    const loc = state.local?.() || { chapter: state.chapter, page: state.page, total: state.pages.length };
    const chapter = loc.chapter;
    const k = K.key(provider, slug);
    K.data.history[k] = { provider, slug, title: series?.title || slug, cover: series?.cover || K.data.history[k]?.cover,
      chapterSlug: chapter.slug, chapterName: chapter.name.replace(/ — .*/, ''), page: loc.page, off: state.where?.() || 0,
      done: !!state.finished, total: loc.total, at: Date.now() };
    K.save('history');
    if (state.finished || loc.page >= loc.total - 1) K.finishChapter?.(chapter);
  }

  K.openReader = async function (provider, slug, chapterSlug) {
    if (K.data.settings.reader && !K.data.settings.reader.v3) setReader({ ambMode: 'page', v3: true });
    const opt = K.readerSettings();
    const first = !box;
    if (first) {
      box = el('div.reader');
      document.body.append(box);
      document.documentElement.classList.add('reading');
    } else { saveProgress(); state?.cleanup?.(); }
    const my = state = { provider, slug, chapterSlug, page: 0, pages: [] };
    box.className = 'reader' + (opt.mode === 'paged' ? ' paged' : '');
    box.replaceChildren(el('div.spinner', { style: { marginTop: '40vh' } }));

    // Series + chapter list (falls back to downloads when offline).
    let series = null, chapters = [];
    try {
      series = await K.getSeries(provider, slug);
      // the series moved to a new address on the site: read it there, so history is saved under the right key
      if (series?.slug && series.slug !== slug && my === state) { K.go(`/read/${provider}/${encodeURIComponent(series.slug)}/${encodeURIComponent(chapterSlug)}`, true); return; }
      chapters = await K.getChapters(provider, slug);
    }
    catch {
      const d = K.dl.series?.find(x => x.provider === provider && x.seriesSlug === slug);
      if (d) { series = { title: d.title, cover: d.cover }; chapters = d.chapters.map(c => ({ slug: c.chapterSlug, name: c.chapterName, number: c.number, locked: false })).sort((a, b) => (b.number ?? 0) - (a.number ?? 0)); }
    }
    if (my !== state) return;
    const idx = chapters.findIndex(c => c.slug === chapterSlug);
    const chapter = chapters[idx] || { slug: chapterSlug, name: chapterSlug.replace(/-/g, ' ') };
    const newer = idx > 0 ? chapters.slice(0, idx).reverse().find(c => !c.locked) : null;   // next chapter
    const older = idx >= 0 ? chapters.slice(idx + 1).find(c => !c.locked) : null;           // previous chapter
    Object.assign(state, { series, chapters, chapter, next: newer, prev: older });

    // Pages: downloaded copy first, then the site.
    const id = `${provider}:${slug}:${chapterSlug}`;
    let pages = K.localPages(id), offline = !!pages;
    if (!pages) {
      try { pages = await K.providers[provider].pages(slug, chapterSlug); }
      catch (e) {
        if (my !== state) return;
        box.replaceChildren(topBar(), el('div.empty', { style: { marginTop: '18vh' } }, K.fox(), el('h3', { text: e.locked ? 'This chapter is locked' : 'Couldn\'t open this chapter' }),
          el('p', { text: e.locked ? 'It\'s paid or early access on the site. Koru only reads free chapters.' : e.message }),
          el('div.row', { style: { justifyContent: 'center' } }, newer ? el('button.btn.primary', { onclick: () => goChapter(newer) }, 'Next chapter', icon('next')) : null,
            el('button.btn', { onclick: () => K.closeReader() }, icon('back'), 'Back'))));
        return;
      }
    }
    if (my !== state) return;
    state.pages = pages;
    const hist = K.data.history[K.key(provider, slug)];
    const askPage = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('page'));
    const resume = hist?.chapterSlug === chapterSlug && !hist.done && hist.page < pages.length && (hist.off > 0 || hist.page < pages.length - 1);
    const startPage = askPage > 0 && askPage < pages.length ? askPage : resume ? hist.page : 0;
    const startOff = !(askPage > 0) && resume ? Math.max(0, Math.min(0.999, hist.off || 0)) : 0;
    build(offline, startPage, startOff);
  };

  function goChapter(c) { K.go(`/read/${state.provider}/${encodeURIComponent(state.slug)}/${encodeURIComponent(c.slug)}`, true); }

  const localPage = () => state?.local ? state.local().page : state?.page;
  const markId = () => `${state.provider}:${state.slug}:${state.chapter?.slug}:${localPage()}`;
  function paintMark() {
    const b = box?.querySelector('.markb');
    if (b && state) b.classList.toggle('on', !!K.data.bookmarks[markId()]);
  }
  K.paintMark = paintMark;
  function topBar() {
    const s = state;
    const mark = el('button.btn.icon.markb', { title: 'Bookmark this page', onclick: () => {
      const id = markId();
      if (K.data.bookmarks[id]) { delete K.data.bookmarks[id]; K.toast('Bookmark removed'); }
      else {
        K.data.bookmarks[id] = { id, provider: s.provider, slug: s.slug, title: s.series?.title || s.slug, cover: s.series?.cover || null,
          chapterSlug: s.chapter.slug, chapterName: s.chapter.name.replace(/ — .*/, ''), page: localPage(), at: Date.now() };
        K.toast(`Page ${localPage() + 1} bookmarked`, 'ok');
      }
      K.save('bookmarks'); paintMark();
    } }, icon('bookmark'));
    return el('div.rbar.top.glass',
      el('button.btn.icon', { title: 'Back', onclick: () => K.closeReader() }, icon('back')),
      el('div.tt', el('b', { text: s.series?.title || s.slug }), el('small', { text: s.chapter?.name || '' })),
      K.incognito() ? el('span.tag', { title: 'Nothing is saved while incognito' }, 'Incognito') : null,
      K.readerSettings().clock ? el('span.rclock.inbar', { title: 'The time (Settings → Reader → Show the time)' }) : null,
      s.pages?.length ? mark : null,
      el('button.btn.icon.autob', { title: 'Auto-scroll (S)', onclick: () => K.toggleAuto?.() }, icon('auto')),
      el('button.btn.icon', { title: 'Zen mode (Z)', onclick: () => K.toggleZen?.() }, icon('zen')),
      el('button.btn.icon', { title: 'Chapters', onclick: () => box.querySelector('.drawer')?.classList.toggle('open') }, icon('list')));
  }

  function build(offline, startPage, startOff = 0) {
    const s = state, opt = K.readerSettings();
    // Ambient light. Each page gets a tiny colour strip (16 px wide) once, when it loads, made off the main
    // thread and kept as plain numbers. Each frame the light is worked out from the part of the pages on
    // screen: about 1,400 colour values are blended, softened and eased toward the new colours in plain
    // JavaScript, then shown on a 48×30 canvas stretched over the screen. No picture is drawn or blurred by
    // the graphics card, and it only runs while something changes (scrolling, a page arriving, a setting).
    const AW = 48, AH = 30, CW = 16, EDGE = 0.08, N = AW * AH;
    const amb = el('div.ambient', el('canvas', { width: AW, height: AH }));
    const ambCv = amb.firstChild, ambCx = ambCv.getContext('2d', { alpha: false, willReadFrequently: true });
    const ambImg = ambCx.createImageData(AW, AH);
    const tgtF = new Float32Array(N * 3), curF = new Float32Array(N * 3), tmpF = new Float32Array(N * 3);
    const ambCache = new Map();   // page -> { w, h, d } colour strip
    let ambO = opt, ambRaf = 0, ambUntil = 0, ambLast = 0, ambHas = false, calm = 1, ambFrozen = false;
    const ofs = []; let ofsDirty = true, viewH = 1;   // cached page tops/heights for the light
    const tau = () => 50 + ambO.ambEase * 9;   // how slowly the light follows: 50 to 950 ms
    // copy one row of a page's strip (r may fall between two rows) into target row y
    const putRow = (b, r, y) => {
      const r0 = Math.max(0, Math.min(b.h - 1, Math.floor(r))), r1 = Math.min(b.h - 1, r0 + 1), f1 = Math.max(0, Math.min(1, r - r0)), f0 = 1 - f1;
      for (let x = 0; x < AW; x++) {
        const sx = Math.min(b.w - 1, (x * b.w / AW) | 0), a = (r0 * b.w + sx) * 4, c = (r1 * b.w + sx) * 4, o = (y * AW + x) * 3;
        tgtF[o] = b.d[a] * f0 + b.d[c] * f1; tgtF[o + 1] = b.d[a + 1] * f0 + b.d[c + 1] * f1; tgtF[o + 2] = b.d[a + 2] * f0 + b.d[c + 2] * f1;
      }
    };
    const fillTarget = () => {
      if (ambO.ambMode === 'page' || opt.mode === 'paged') {
        const b = ambCache.get(s.page);
        if (!b) return false;
        for (let y = 0; y < AH; y++) putRow(b, (y + 0.5) / AH * b.h - 0.5, y);
        return true;
      }
      // page positions are measured only after a page changes size, never on every scroll frame
      if (ofsDirty) { ofsDirty = false; ofs.length = 0; viewH = pagesBox.clientHeight || 1; }
      const H = viewH, top = pagesBox.scrollTop, near = [];
      for (let i = Math.max(0, s.page - 2); i <= Math.min(s.pages.length - 1, s.page + 2); i++) {
        const b = ambCache.get(i), p = b && pg(i);
        if (!p) continue;
        const o = ofs[i] || (ofs[i] = [p.offsetTop, p.offsetHeight]);
        if (o[1]) near.push([b, o[0] - top, o[1]]);
      }
      let any = false;
      for (let y = 0; y < AH; y++) {
        const sy = ((y + 0.5) / AH * (1 + 2 * EDGE) - EDGE) * H;   // the screen height this row of light stands for
        for (const [b, y0, h] of near) if (sy >= y0 && sy < y0 + h) { putRow(b, (sy - y0) / h * b.h - 0.5, y); any = true; break; }
        // rows with no loaded page keep their last colour
      }
      return any;
    };
    // soften: two box-blur passes each way, edges repeat outward
    const blurPass = (src, dst, r, horiz) => {
      const len = horiz ? AW : AH, lines = horiz ? AH : AW, n = 2 * r + 1;
      for (let l = 0; l < lines; l++) for (let ch = 0; ch < 3; ch++) {
        const at = i => ((horiz ? l * AW + Math.max(0, Math.min(len - 1, i)) : Math.max(0, Math.min(len - 1, i)) * AW + l) * 3 + ch);
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[at(i)];
        for (let i = 0; i < len; i++) { dst[at(i)] = acc / n; acc += src[at(i + r + 1)] - src[at(i - r)]; }
      }
    };
    const ambFrame = now => {
      ambRaf = 0;
      if (state !== s || !ambO.ambient) return;
      if (ambFrozen) { ambLast = 0; return; }   // the smooth guard is checking whether the light is what's slow
      // the light is soft and slow, so 20 updates a second look the same as 60 and cost a third
      if (ambLast && now - ambLast < 48) { ambRaf = requestAnimationFrame(ambFrame); return; }
      const dt = ambLast ? Math.min(150, now - ambLast) : 16; ambLast = now;
      if (fillTarget()) {
        // the light is a 48×30 picture on its own layer (the graphics card, or the compositor, stretches it),
        // so it eases smoothly in light mode too
        const k = ambHas ? 1 - Math.exp(-dt / tau()) : 1;
        for (let i = 0; i < tgtF.length; i++) curF[i] += (tgtF[i] - curF[i]) * k;
        const r = Math.max(0, Math.round(ambO.ambBlur / 55));
        let src = curF;
        if (r) { blurPass(curF, tmpF, r, true); blurPass(tmpF, tgtF, r, false); blurPass(tgtF, tmpF, r, true); blurPass(tmpF, tgtF, r, false); src = tgtF; }
        const sat = ambO.ambSat / 100, d = ambImg.data;
        let lumSum = 0;
        for (let p = 0, o = 0; p < N; p++, o += 3) {
          const R = src[o], G = src[o + 1], B = src[o + 2], L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          lumSum += L;
          d[p * 4] = L + (R - L) * sat; d[p * 4 + 1] = L + (G - L) * sat; d[p * 4 + 2] = L + (B - L) * sat; d[p * 4 + 3] = 255;
        }
        ambCx.putImageData(ambImg, 0, 0);
        if (!ambHas) { ambHas = true; amb.classList.add('on'); }
        // Calm bright pages: a mostly white screen glows less, so it doesn't glare
        const lum = lumSum / N / 255;
        const calmT = ambO.ambCalm && lum > 0.5 ? Math.max(0.3, 1 - (lum - 0.5) * 1.5) : 1;
        calm += (calmT - calm) * (1 - Math.exp(-dt / Math.max(200, tau())));
        const op = (Math.round(calm * 25) / 25).toFixed(2);
        if (ambCv.style.opacity !== op) ambCv.style.opacity = op;
      }
      if (now < ambUntil) ambRaf = requestAnimationFrame(ambFrame);
      else ambLast = 0;
    };
    const kickAmb = () => {
      if (!ambO.ambient) return;
      ambUntil = performance.now() + tau() * 4 + 200;
      if (!ambRaf) ambRaf = requestAnimationFrame(ambFrame);
    };
    const applyAmb = o => { ambO = o; amb.style.display = o.ambient ? '' : 'none'; amb.style.setProperty('--amb-o', o.ambStrength / 100); kickAmb(); };
    applyAmb(opt);
    const follows = () => ambO.ambMode === 'scroll' && opt.mode === 'strip';
    const setAmb = i => { if (follows() ? Math.abs(i - s.page) <= 2 : i === s.page) kickAmb(); };
    const ambSize = (w, h) => [CW, Math.max(1, Math.min(1024, Math.round(CW * h / w)))];

    const pagesBox = el('div.pages', { tabIndex: 0 });
    const strip = el('div.strip', { style: { maxWidth: opt.mode === 'strip' ? opt.width + 'px' : 'none', gap: opt.gap + 'px' } });
    pagesBox.append(strip);
    // a page getting its real size (or the window resizing) moves the pages below it: measure again once
    const ofsWatch = new ResizeObserver(() => { ofsDirty = true; if (follows()) kickAmb(); });
    ofsWatch.observe(strip); ofsWatch.observe(pagesBox);

    // Long strip: each page is fetched as a file, decoded off the main thread and cut into short slices.
    // The graphics card then only moves ready-made pieces while you scroll, instead of re-decoding giant
    // pictures (some pages are 900×16000) over and over, which is what lagged on big screens.
    const SLICE = 1536, OV = 2;
    const dims = s.pages.map(p => (p.w && p.h ? [p.w, p.h] : null));   // page sizes once known (two-page view)
    const st = s.pages.map(() => '');   // '', 'loading', 'ready'
    const files = new Map();            // page -> downloaded file, kept for this chapter so scrolling back is instant
    const job = s.pages.map(() => '');  // current worker job per page
    const freeSlices = wrap => {
      const i = Number(wrap.dataset.i);
      freeJob(job[i]); job[i] = '';
      wrap.querySelector('.slices')?.remove(); wrap.classList.remove('sliced');
    };
    const fileOf = async i => {
      if (files.has(i)) return files.get(i);
      const url = s.pages[i].url;
      const u = /^(\/|koru:)/.test(url) ? url : '/k/fetch?u=' + encodeURIComponent(url) + '&accept=' + encodeURIComponent('image/avif,image/webp,image/*;q=0.8');
      const r = await fetch(u);
      if (!r.ok) throw new Error('Page answered ' + r.status);
      const b = await r.blob();
      files.set(i, b);
      return b;
    };
    const failed = i => { const ph = imgs[i].nextSibling; ph.textContent = 'Page didn\'t load · tap to retry'; ph.style.fontSize = '14px'; ph.style.cursor = 'pointer'; };
    const ambFrom = (i, src, w, h) => {
      if (ambCache.has(i) || !w) return;
      ambCache.set(i, null);
      const [rw, rh] = ambSize(w, h);
      createImageBitmap(src, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'medium' }).then(b => {
        if (state !== s) { b.close(); return; }
        const c = document.createElement('canvas'); c.width = rw; c.height = rh;
        const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(b, 0, 0); b.close();
        ambCache.set(i, { w: rw, h: rh, d: cx.getImageData(0, 0, rw, rh).data }); setAmb(i);
      }).catch(() => ambCache.delete(i));
    };
    async function loadStrip(i) {
      const wrap = imgs[i].parentElement;
      const id = 'p' + (++sliceSeq);
      job[i] = id;
      const live = () => st[i] === 'loading' && job[i] === id;
      try {
        const file = await fileOf(i);
        if (!live()) return;
        const r = await ask({ type: 'decode', id, blob: file, cw: CW });   // decoded on the worker
        if (!live()) { freeJob(id); return; }
        wrap.style.minHeight = ''; wrap.style.aspectRatio = `${r.w} / ${r.h}`;
        if (jump && i <= jump.i) requestAnimationFrame(doJump);
        if (!ambCache.get(i) && r.amb) { ambCache.set(i, { w: r.amb.w, h: r.amb.h, d: new Uint8ClampedArray(r.amb.d) }); setAmb(i); }
        const box = el('div.slices'), ocs = [];
        for (let y = 0; y < r.h; y += SLICE) {
          const c = el('canvas', { width: r.w, height: Math.min(SLICE + OV, r.h - y) });
          // slices overlap by a couple of pixels so no hairline shows between them
          if (y + SLICE < r.h) c.style.marginBottom = `-${(OV / r.w) * 100}%`;
          box.append(c);
          ocs.push(c.transferControlToOffscreen());
        }
        wrap.append(box); wrap.classList.add('sliced');
        await ask({ type: 'draw', id, canvases: ocs, slice: SLICE }, ocs);              // drawn by the worker, straight to the screen
        if (live()) st[i] = 'ready';
      } catch { if (live()) { st[i] = ''; freeSlices(wrap); failed(i); } }
    }
    const addPage = (p, i) => {
      const im = el('img', { alt: `Page ${i + 1}`, decoding: 'async', referrerPolicy: 'no-referrer', draggable: false });
      im.dataset.src = p.url;
      // page mode shows the picture directly
      im.addEventListener('load', () => {
        if (st[i] !== 'loading') return;
        wrap.style.minHeight = ''; wrap.style.aspectRatio = '';
        ambFrom(i, im, im.naturalWidth, im.naturalHeight);
        im.classList.add('ready'); st[i] = 'ready';
        dims[i] = [im.naturalWidth, im.naturalHeight]; onDims(i);
      });
      im.addEventListener('error', () => { if (!im.getAttribute('src') || st[i] !== 'loading') return; st[i] = ''; failed(i); });
      const ph = el('div.ph', { text: String(i + 1) });
      ph.onclick = () => { if (st[i]) return; ph.textContent = String(i + 1); ph.style.fontSize = ''; ph.style.cursor = ''; files.delete(i); load(i); };
      const wrap = el('div.pg', { dataset: { i } }, im, ph);
      if (p.w && p.h) wrap.style.aspectRatio = `${p.w} / ${p.h}`; else wrap.style.minHeight = '70vh';
      return im;
    };
    const imgs = s.pages.map((p, i) => { const im = addPage(p, i); strip.append(im.parentElement); return im; });
    const pg = i => imgs[i]?.parentElement;
    const load = i => {
      const im = imgs[i];
      if (!im || st[i]) return;
      st[i] = 'loading';
      // page mode loads through Koru too (like the strip), so the ambient light can read the page's colours
      if (opt.mode === 'strip') loadStrip(i); else im.src = im.dataset.src.startsWith('https://') ? K.viaKoru(im.dataset.src) : im.dataset.src;
    };
    // far-away pages are let go; their space stays so nothing jumps
    const unload = i => {
      const im = imgs[i];
      if (!im || !st[i] || i === s.page) return;
      st[i] = '';
      im.classList.remove('ready'); im.removeAttribute('src');
      freeSlices(im.parentElement);
    };

    // Chapters in this strip. With "Keep reading into the next chapter" on, the next free chapter is added
    // underneath as you near the end, so you just keep scrolling; the title, page count and history follow along.
    // With the next-chapter countdown on, a chapter ends on the "Up next" card (3, 2, 1, then the next chapter)
    // instead of the next one joining underneath.
    const seamless = opt.mode === 'strip' && opt.autoNext && !opt.countdown;
    const cdOn = () => !!opt.countdown;
    const segs = [{ chapter: s.chapter, start: 0, count: s.pages.length }];
    const segOf = i => { for (let k = segs.length - 1; k >= 0; k--) if (i >= segs[k].start) return segs[k]; return segs[0]; };
    const nextAfter = ch => { const i = s.chapters.findIndex(c => c.slug === ch.slug); return i > 0 ? s.chapters.slice(0, i).reverse().find(c => !c.locked) : null; };
    const prevBefore = ch => { const i = s.chapters.findIndex(c => c.slug === ch.slug); return i >= 0 ? s.chapters.slice(i + 1).find(c => !c.locked) : null; };
    // two pages on screen: the left-most page number is saved, or the last page once the last pair shows
    s.local = () => { const g = segOf(s.page), p = opt.mode === 'paged' && s.pageEnd === s.pages.length - 1 ? s.pageEnd : s.page; return { chapter: g.chapter, page: p - g.start, total: g.count }; };
    let appending = false, appendErr = null;
    const short = n => String(n || '').replace(/ — .*/, '');
    // the chapter you finished: read mark + Stats, once
    K.finishChapter = ch => {
      if (!ch || K.incognito() || K.flag(s.provider, s.slug).trash) return;
      if (!K.isRead(s.provider, s.slug, ch.slug)) { K.stats.chapter({ ...s, chapter: ch }); K.markRead(s.provider, s.slug, ch.slug, true); }
    };
    const end = el('div.endcard.glass');
    function paintEnd() {
      const last = segs[segs.length - 1].chapter, nx = nextAfter(last);
      const cd = cdOn() && nx && !appending && !appendErr;
      end.classList.toggle('upnext', !!cd);
      end.replaceChildren(...[
        cd && s.series?.cover ? el('div.endcover', K.img(s.series.cover, '', '', 150)) : null,
        cd ? el('small.upk', { text: 'Up next' }) : null,
        cd ? el('h3', { text: short(nx.name) }) : null,
        cd ? el('p.muted', { text: 'You finished ' + short(last.name) }) : null,
        cd ? el('div.cdbox', el('div.cdtext', 'Opening in ', el('b.cdnum', { text: '3' })), el('div.cdbar', el('i'))) : null,
        cd ? null : el('h3', { text: nx ? (appending ? 'Loading ' + short(nx.name) + '…' : 'End of ' + short(last.name)) : 'You\'re all caught up' }),
        cd ? null : el('p.muted', { text: appendErr ? appendErr.message : nx ? 'Up next: ' + nx.name : 'No newer free chapter yet.' }),
        appending ? el('div.spinner', { style: { margin: '6px auto' } }) : el('div.row', { style: { justifyContent: 'center' } },
          nx ? el('button.btn.primary', { onclick: () => (seamless ? appendNext() : goChapter(nx)) }, appendErr ? 'Try again' : 'Next chapter', icon('next')) : null,
          el('button.btn', { onclick: () => K.closeReader() }, 'Back to series'))].filter(Boolean));
    }
    // Next-chapter countdown: 3, 2, 1, then the next chapter. A click, a key or scrolling up stops it.
    // Only transform and opacity move, so it stays smooth on any PC.
    let cdT = 0, cdRun = false, cdStopped = false, cdVisible = false;
    const cdCancel = e => {
      if (e.type === 'wheel' && e.deltaY > 0) return;
      if (e.target?.closest?.('.endcard .btn')) return;
      if (e.key === 'Enter') { const nx = nextAfter(segs[segs.length - 1].chapter); stopCountdown(false); if (nx) { e.preventDefault(); e.stopPropagation(); goChapter(nx); } return; }   // Enter: open it now
      stopCountdown(true);
    };
    function startCountdown() {
      const nx = nextAfter(segs[segs.length - 1].chapter);
      if (!cdOn() || !nx || cdRun || cdStopped || appending || state !== s || document.hidden || !end.isConnected) return;
      if (opt.mode === 'strip' && pagesBox.scrollTop < 200) return;   // pages still loading in at the top: you haven't scrolled to the end
      cdRun = true; end.classList.add('counting');
      box.addEventListener('pointerdown', cdCancel, true); box.addEventListener('wheel', cdCancel, { passive: true }); document.addEventListener('keydown', cdCancel, true);
      let n = 3;
      const tick = () => {
        if (!cdRun || state !== s) return;
        if (n === 0) { stopCountdown(false); goChapter(nx); return; }
        end.querySelector('.cdnum')?.replaceWith(el('b.cdnum.pop', { text: String(n) }));
        n--; cdT = setTimeout(tick, 1000);
      };
      tick();
    }
    function stopCountdown(byYou) {
      if (byYou) { cdStopped = true; end.classList.add('stopped'); const t = end.querySelector('.cdtext'); if (t) t.textContent = "Stopped. Open it when you're ready."; }
      if (!cdRun) return;
      cdRun = false; clearTimeout(cdT); end.classList.remove('counting');
      box.removeEventListener('pointerdown', cdCancel, true); box.removeEventListener('wheel', cdCancel); document.removeEventListener('keydown', cdCancel, true);
    }
    s.stopCountdown = stopCountdown;
    let observe = () => {};
    async function appendNext() {
      const last = segs[segs.length - 1], nx = nextAfter(last.chapter);
      if (!nx || appending || state !== s) return;
      appending = true; appendErr = null; paintEnd();
      try {
        let pages = K.localPages(`${s.provider}:${s.slug}:${nx.slug}`);
        if (!pages) pages = await K.providers[s.provider].pages(s.slug, nx.slug);
        if (state !== s) return;
        if (!pages?.length) throw new Error(short(nx.name) + ' has no pages.');
        const start = s.pages.length;
        strip.insertBefore(el('div.chdiv', el('span', { text: 'End of ' + short(last.chapter.name) }), el('b', { text: nx.name })), end);
        pages.forEach((pp, k) => { s.pages.push(pp); st.push(''); job.push(''); const im = addPage(pp, start + k); imgs.push(im); strip.insertBefore(im.parentElement, end); observe(im.parentElement); });
        segs.push({ chapter: nx, start, count: pages.length });
      } catch (e) {
        if (e.locked) { nx.locked = true; appending = false; return appendNext(); }   // paid chapter: skip to the next free one
        appendErr = e;
      } finally { appending = false; if (state === s) paintEnd(); }
    }
    paintEnd();
    if (opt.mode === 'strip') strip.append(end);

    // bottom bar
    const goNext = () => { if (!s.next) return; const g = segs.find(x => x.chapter.slug === s.next.slug); if (g) pg(g.start)?.scrollIntoView({ block: 'start' }); else goChapter(s.next); };
    const goPrev = () => { if (!s.prev) return; const g = segs.find(x => x.chapter.slug === s.prev.slug); if (g) pg(g.start)?.scrollIntoView({ block: 'start' }); else goChapter(s.prev); };
    const prevBtn = el('button.btn.icon', { title: 'Previous chapter', disabled: !s.prev, onclick: goPrev }, icon('back'));
    const nextBtn = el('button.btn.icon', { title: 'Next chapter', disabled: !s.next, onclick: goNext }, icon('next'));
    const slider = el('input', { type: 'range', min: 1, max: s.pages.length, value: startPage + 1, step: 1 });
    const pc = el('span.pc');
    const modeBtn = el('button.btn.icon', { title: opt.mode === 'strip' ? 'Switch to pages' : 'Switch to long strip', onclick: () => { saveProgress(); setReader({ mode: opt.mode === 'strip' ? 'paged' : 'strip' }); K.openReader(s.provider, s.slug, s.chapter.slug); } },
      icon(opt.mode === 'strip' ? 'pages' : 'scroll'));
    const bottom = el('div.rbar.bottom.glass',
      prevBtn, slider, pc, nextBtn,
      modeBtn,
      el('button.btn.icon', { title: 'Reader settings', onclick: () => toggleSettings() }, icon('settings')));
    if (offline) bottom.prepend(el('span.tag', { text: 'Offline' }));

    // chapter drawer
    const drawer = el('div.drawer.glass', el('div.row', { style: { marginBottom: '12px' } }, el('h3', { text: 'Chapters', style: { margin: 0, flex: 1 } }),
      el('button.btn.small.icon', { onclick: () => drawer.classList.remove('open') }, icon('x'))));
    const dlist = el('div.list');
    for (const c of s.chapters) {
      const read = K.isRead(s.provider, s.slug, c.slug);
      const row = el('div.item' + (c.slug === s.chapter.slug ? '.current' : '') + (read ? '.read' : '') + (c.locked ? '.locked' : ''),
        el('div.n', el('b', { text: c.name }), el('small', { text: c.locked ? 'Locked' : K.dl.index.has(`${s.provider}:${s.slug}:${c.slug}`) ? 'Downloaded' : K.ago(c.date) })),
        c.locked ? icon('lock') : null);
      row.dataset.slug = c.slug;
      row.onclick = () => { if (!c.locked) goChapter(c); };
      dlist.append(row);
    }
    drawer.append(dlist);

    // Night filter: one plain layer over the pages (and the light around them) with a warm colour at some
    // opacity. Warmth and dimming are folded into that one colour, so the graphics card just blends a flat
    // colour: no filter on the pages, nothing redrawn as you scroll. It can switch on by itself in the evening.
    const night = el('div.rnight', { 'aria-hidden': 'true' });
    let nightT = 0, nightKey = '';
    const nightSched = o => {
      if (!o.nightAuto) return false;
      const h = new Date().getHours(), a = Number(o.nightFrom) || 0, b = Number(o.nightTo) || 0;
      return a === b ? false : a < b ? h >= a && h < b : h >= a || h < b;   // 21 → 7 runs past midnight
    };
    const nightOn = o => {
      const sc = nightSched(o);
      if (nightOverride && (nightOverride.sched !== sc || nightOverride.auto !== !!o.nightAuto)) nightOverride = null;
      return nightOverride ? nightOverride.on : !!o.night || sc;
    };
    const paintNight = (o = K.readerSettings()) => {
      const on = nightOn(o);
      const w = Math.max(0, Math.min(100, o.nightWarm)) / 100 * 0.34, d = 1 - Math.max(30, Math.min(100, o.nightDim)) / 100;
      const A = 1 - (1 - w) * (1 - d), f = A > 0 ? w * (1 - d) / A : 0;   // warm layer under a black layer = one layer of this colour
      const bg = `rgb(${Math.round(255 * f)},${Math.round(138 * f)},${Math.round(36 * f)})`, op = on ? A.toFixed(3) : '0';
      const key = bg + op;
      if (key === nightKey) return on;
      nightKey = key; night.style.background = bg; night.style.opacity = op;
      box?.classList.toggle('night', on);
      return on;
    };
    const nightTick = () => { nightT = setTimeout(() => { if (state !== s) return; paintNight(); nightTick(); }, 60000 - Date.now() % 60000 + 50); };
    const toggleNight = () => {
      const on = !nightOn(K.readerSettings());
      setReader({ night: on }); nightOverride = null;
      const o = K.readerSettings();
      if (nightOn(o) !== on) nightOverride = { on, sched: nightSched(o), auto: !!o.nightAuto };
      paintNight(o);
      K.toast(on ? 'Night filter on · Shift+N to switch' : 'Night filter off');
    };

    box.replaceChildren(amb, pagesBox, night, topBar(), bottom, drawer);
    paintNight(); nightTick();
    // Show the time: in the top bar, and in a small corner tag while the bars are hidden (scrolling, zen).
    // It changes once a minute, right on the minute.
    let clockT = 0;
    if (opt.clock) {
      box.append(el('div.rclock.float', { 'aria-hidden': 'true' }));
      const paint = () => { const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); box.querySelectorAll('.rclock').forEach(c => { if (c.textContent !== t) c.textContent = t; }); };
      const next = () => { clockT = setTimeout(() => { if (state !== s) return; paint(); next(); }, 60000 - Date.now() % 60000 + 30); };
      paint(); next();
    }
    let fpsRaf = 0;
    if (opt.fps) {
      const meter = el('div.fps', { text: '… fps' });
      box.append(meter);
      let n = 0, t0 = performance.now(), last = t0, worst = 0;
      const tick = now => {
        if (state !== s) return;
        n++; worst = Math.max(worst, now - last); last = now;
        if (now - t0 >= 1000) { meter.textContent = `${Math.round(n * 1000 / (now - t0))} fps · slowest ${Math.round(worst)} ms`; n = 0; t0 = now; worst = 0; }
        fpsRaf = requestAnimationFrame(tick);
      };
      fpsRaf = requestAnimationFrame(tick);
    }
    setTimeout(() => dlist.querySelector('.current')?.scrollIntoView({ block: 'center' }), 50);

    // show/hide bars
    let hideT;
    // Zen mode: full screen, just the pages. Bars stay away and the cursor hides when it stops moving.
    let idleT;
    const setZen = (on, quiet) => {
      box.classList.toggle('zen', on);
      if (on) { box.classList.add('hide-ui'); drawer.classList.remove('open'); box.querySelector('.rset')?.remove(); }
      else { box.classList.remove('idle'); showUi(); }
      if (K.info?.platform === 'desktop') K.api.post('/k/fullscreen', { on }).catch(() => {});
      if (!quiet) K.toast(on ? 'Zen mode · press Z or Esc to leave' : 'Zen mode off');
    };
    K.toggleZen = () => { const on = !box.classList.contains('zen'); setReader({ zen: on }); setZen(on); };
    const showUi = () => { if (box.classList.contains('zen')) return; box.classList.remove('hide-ui'); clearTimeout(hideT); hideT = setTimeout(() => { if (!box?.querySelector('.rset') && !drawer.classList.contains('open')) box?.classList.add('hide-ui'); }, 3500); };
    showUi();

    // crossing into another chapter of the strip: title, buttons, chapter list and address follow
    function switchTo(g) {
      const old = s.chapter;
      const oldSeg = segs.find(x => x.chapter === old);
      if (oldSeg && g.start > oldSeg.start) K.finishChapter(old);   // scrolled on past it
      saveProgress();
      Object.assign(s, { chapter: g.chapter, next: nextAfter(g.chapter), prev: prevBefore(g.chapter), finished: false });
      const tt = box.querySelector('.rbar.top .tt small'); if (tt) tt.textContent = g.chapter.name;
      prevBtn.disabled = !s.prev; nextBtn.disabled = !s.next;
      dlist.querySelectorAll('.item').forEach(r => r.classList.toggle('current', r.dataset.slug === g.chapter.slug));
      dlist.querySelector(`.item[data-slug="${CSS.escape(g.chapter.slug)}"]`)?.classList.add('read');
      history.replaceState(null, '', `#/read/${s.provider}/${encodeURIComponent(s.slug)}/${encodeURIComponent(g.chapter.slug)}`);
    }
    // Two-page view (page mode): pages are paired from the start of the chapter (the first page alone when
    // "first page alone" is on); a wide page (already a spread) stands alone and the pairing starts again after
    // it. Pages whose size isn't known yet count as tall until they load.
    let winW = window.innerWidth, winH = window.innerHeight;
    let starts = [], gOf = [], grouped = false;
    const wideAt = i => !!dims[i] && dims[i][0] > dims[i][1];
    const two = () => { if (opt.mode !== 'paged') return false; const v = K.readerSettings().spread; return v === 'on' || (v === 'auto' && winW > winH); };
    const regroup = () => {
      const n = s.pages.length, cover = K.readerSettings().spreadCover;
      starts = []; gOf = new Array(n);
      for (let i = 0; i < n;) {
        const g = starts.push(i) - 1; gOf[i] = g;
        if (i + 1 < n && !(cover && i === 0) && !wideAt(i) && !wideAt(i + 1)) { gOf[i + 1] = g; i += 2; } else i++;
      }
      grouped = true;
    };
    // first and last page shown when page i is on screen
    const viewOf = i => {
      if (!two()) return [i, i];
      if (!grouped) regroup();
      const g = gOf[i];
      return [starts[g], (starts[g + 1] ?? s.pages.length) - 1];
    };
    const reView = () => { if (opt.mode !== 'paged' || state !== s) return; const [a, b] = viewOf(s.page); if (a !== s.page || b !== s.pageEnd) setPage(s.page, false, true); };
    function onDims(i) { if (opt.mode === 'paged' && wideAt(i)) { grouped = false; reView(); } }
    function setPage(i, fromScroll, keepZoom) {
      i = Math.max(0, Math.min(s.pages.length - 1, i));
      let e = i;
      if (opt.mode === 'paged') [i, e] = viewOf(i);
      const turned = i !== s.page;
      s.page = i; s.pageEnd = e;
      const g = segOf(i);
      if (g.chapter !== s.chapter) switchTo(g);
      const li = i - g.start;
      if (li >= g.count / 2) autoDownload(g.chapter);
      slider.max = g.count;
      slider.value = li + 1;
      slider.style.setProperty('--p', (g.count > 1 ? (li / (g.count - 1)) * 100 : 100) + '%');
      pc.textContent = e > i ? `${li + 1}–${li + 1 + e - i} / ${g.count}` : `${li + 1} / ${g.count}`;
      paintMark();
      for (let k = i; k <= Math.max(e, i + opt.preload); k++) load(k);
      setAmb(i);
      if (i > 0) load(i - 1);
      if (opt.mode === 'paged') {
        if (turned && !keepZoom) zoomReset();
        strip.querySelectorAll('.pg.cur').forEach(p => p.classList.remove('cur', 'sl', 'sr'));
        strip.classList.toggle('two', e > i);
        for (let k = i; k <= e; k++) pg(k)?.classList.add('cur');
        // right to left: the first page of the pair is on the right
        if (e > i) { pg(opt.rtl ? e : i)?.classList.add('sl'); pg(opt.rtl ? i : e)?.classList.add('sr'); }
      } else if (!fromScroll) {
        pg(i)?.scrollIntoView({ block: 'start' });
      }
      saveSoon();
    }
    const saveSoon = K.debounce(saveProgress, 800);
    // Halfway through a chapter, the next free chapter(s) are saved quietly in the background, so they open
    // instantly and work offline. Koru removes these once you've read them (Settings → Reader).
    const autoDone = new Set();
    function autoDownload(ch) {
      const n = Math.max(0, Math.min(3, Number(K.readerSettings().autoDl) || 0));
      if (!n || autoDone.has(ch.slug) || K.info?.platform !== 'desktop' || !s.series) return;
      autoDone.add(ch.slug);
      const list = []; let c = ch;
      while (list.length < n && (c = nextAfter(c))) if (!K.dl.index.has(`${s.provider}:${s.slug}:${c.slug}`)) list.push(c);
      if (list.length) setTimeout(() => { if (state === s) K.downloadChapters({ ...s.series, provider: s.provider, slug: s.slug }, list, { auto: true }); }, 3000);
    }
    // Resume spot: page + how far down it. Pages get their real height as they load, so the jump is redone
    // until that page has its size, unless you start scrolling yourself first.
    let jump = opt.mode === 'strip' && (startPage > 0 || startOff > 0) ? { i: startPage, off: startOff } : null;
    const doJump = () => {
      const p = jump && pg(jump.i);
      if (!p) return;
      pagesBox.style.scrollBehavior = 'auto';
      pagesBox.scrollTop = p.offsetTop + jump.off * p.offsetHeight - pagesBox.clientHeight * 0.4;
    };
    const stopJump = () => { jump = null; };
    if (jump) {
      for (const ev of ['wheel', 'pointerdown', 'touchstart', 'keydown']) pagesBox.addEventListener(ev, stopJump, { passive: true, once: true });
      setTimeout(stopJump, 20000);
    }
    s.where = () => {
      if (opt.mode !== 'strip') return 0;
      if (jump && jump.i === s.page) return jump.off;
      const p = pg(s.page);
      if (!p || !p.offsetHeight) return 0;
      return Math.max(0, Math.min(0.999, (pagesBox.scrollTop + pagesBox.clientHeight * 0.4 - p.offsetTop) / p.offsetHeight));
    };

    if (opt.mode === 'strip') {
      // the page whose top passed the middle of the screen is the current page
      // Pages start loading well before you reach them.
      const io = new IntersectionObserver(entries => {
        for (const e of entries) if (e.isIntersecting) load(Number(e.target.dataset.i));
      }, { root: pagesBox, rootMargin: '3000px 0px' });
      // The current page is the one crossing a line 40% down the screen. The browser tracks this off the
      // main thread, so scrolling never stops to measure the page (that caused the stutter).
      const line = new IntersectionObserver(entries => {
        for (const e of entries) if (e.isIntersecting) { const i = Number(e.target.dataset.i); if (i !== s.page) setPage(i, true); }
        if (cdVisible && !cdRun && !jump) startCountdown();
      }, { root: pagesBox, rootMargin: '-40% 0px -59.5% 0px' });
      // far away (above or below): free the picture; its space stays so nothing jumps
      const far = new IntersectionObserver(entries => {
        for (const e of entries) if (!e.isIntersecting) unload(Number(e.target.dataset.i));
      }, { root: pagesBox, rootMargin: '9000px 0px' });
      const atEnd = new IntersectionObserver(es => {
        if (!es[0].isIntersecting || jump) return;
        if (seamless && nextAfter(segs[segs.length - 1].chapter)) return;   // the next chapter is joining underneath
        s.page = s.pages.length - 1; s.finished = true; saveProgress();
      }, { root: pagesBox });
      const nearEnd = new IntersectionObserver(es => { if (es[0].isIntersecting && seamless && !jump) appendNext(); }, { root: pagesBox, rootMargin: '0px 0px 2500px 0px' });
      // the countdown runs while most of the Up next card is on screen
      const cdSeen = new IntersectionObserver(es => { cdVisible = es[0].isIntersecting; if (cdVisible && !jump) startCountdown(); else stopCountdown(false); }, { root: pagesBox, threshold: 0.6 });
      observe = p => { io.observe(p); line.observe(p); far.observe(p); };
      [...strip.querySelectorAll('.pg')].forEach(observe);
      atEnd.observe(end); nearEnd.observe(end); if (cdOn()) cdSeen.observe(end);
      let lastY = 0, ticking = false;
      // Smooth guard: frame times are watched while you scroll. When scrolling stutters, the light is paused
      // for the next check to see whether it's really the cause (usually it's a big page being decoded).
      // Only if scrolling is smooth without it does the light step down to once per page. It never turns
      // the light off by itself. Stutter that isn't the light's fault leads to light mode, as before.
      const guard = { gaps: [], last: 0, raf: 0, until: 0, testing: false, cleared: false };
      const judge = () => {
        const g = guard.gaps.sort((a, b) => a - b); guard.gaps = [];
        if (K.perfChecking) return;   // Settings → Graphics → Check performance is measuring on purpose
        const bad = g.filter(x => x > 25).length / g.length > 0.2;   // a fifth of frames slower than 40 fps
        const o = K.readerSettings();
        if (guard.testing) {
          guard.testing = false; ambFrozen = false; kickAmb();
          if (bad) { guard.cleared = true; return; }   // still slow without the light: not the light's fault
          if (o.ambMode !== 'page') { setReader({ ambMode: 'page' }); applyAmb(K.readerSettings()); K.toast('Scrolling was smoother without the moving light, so it now changes once per page. Switch it back in reader settings.'); }
          return;
        }
        if (!bad) return;
        if (o.ambient && !guard.cleared && (o.ambMode !== 'page' || !sessionStorage.getItem('koru-amb-tested'))) {
          sessionStorage.setItem('koru-amb-tested', '1'); guard.testing = true; ambFrozen = true; return;
        }
        if (!document.documentElement.classList.contains('lite') && K.setLite && !sessionStorage.getItem('koru-lite-asked')) {
          sessionStorage.setItem('koru-lite-asked', '1');
          K.toast('Scrolling stutters on this PC. Light mode in Settings → Graphics can help (your ambient light stays on).');
        }
      };
      const guardTick = t => {
        guard.raf = 0;
        if (state !== s) return;
        if (guard.last && t - guard.last < 1000) guard.gaps.push(t - guard.last);
        guard.last = t;
        if (guard.gaps.length >= 150) judge();
        if (t < guard.until) guard.raf = requestAnimationFrame(guardTick); else guard.last = 0;
      };
      pagesBox.addEventListener('scroll', () => {
        if (follows()) kickAmb();
        guard.until = performance.now() + 250;
        if (!guard.raf) guard.raf = requestAnimationFrame(guardTick);
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { ticking = false; const y = pagesBox.scrollTop; if (Math.abs(y - lastY) > 80) { if (y > lastY && !box?.classList.contains('hide-ui')) box?.classList.add('hide-ui'); lastY = y; } });
      }, { passive: true });
      s.cleanup = () => { io.disconnect(); line.disconnect(); far.disconnect(); atEnd.disconnect(); nearEnd.disconnect(); cdSeen.disconnect(); stopCountdown(false); files.clear(); st.fill(''); strip.querySelectorAll('.pg').forEach(w => { if (job[Number(w.dataset.i)]) freeSlices(w); }); };
    }

    // Auto-scroll: the strip glides down by itself (in page mode, pages turn by themselves).
    // A small pop-up holds play/pause and the speed. Scrolling yourself just holds it for a moment.
    const SPEEDS = [15, 25, 40, 60, 90, 130, 180, 250, 350, 500, 700];
    const SECS = [3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60];
    let autoOn = false, autoShown = false, autoRaf = 0, autoLast = 0, autoHold = 0, autoAcc = 0, autoT = 0;
    const isStrip = opt.mode === 'strip';
    const autoVal = el('b.av');
    const autoPlay = el('button.btn.small.icon', { title: 'Pause or play (S)', onclick: () => setAuto(!autoOn) });
    const nudge = d => {
      const o = K.readerSettings(), list = isStrip ? SPEEDS : SECS, key = isStrip ? 'autoSpeed' : 'autoSecs';
      let i = list.findIndex(v => v >= o[key]); if (i < 0) i = list.length - 1;
      const dir = isStrip ? d : -d;   // "faster" means fewer seconds per page
      const v = list[Math.max(0, Math.min(list.length - 1, i + dir))];
      setReader({ [key]: v }); paintAuto();
    };
    const grip = el('span.grip', { title: 'Drag to move' }, icon('grip'));
    const pop = el('div.autopop.glass', grip, autoPlay,
      el('button.btn.small.icon', { title: 'Slower', onclick: () => nudge(-1) }, icon('minus')),
      el('div.avw', autoVal, el('small', { text: isStrip ? 'speed' : 'per page' })),
      el('button.btn.small.icon', { title: 'Faster', onclick: () => nudge(1) }, icon('plus')),
      el('button.btn.small.icon', { title: 'Turn auto-scroll off', onclick: () => { autoKeep = false; showAuto(false); } }, icon('x')));
    // Drag the grip to put the pop-up anywhere; the spot is remembered (as a share of the screen, so it fits any size).
    const POS_KEY = 'koru-autopop';
    const placePop = () => {
      let p = null; try { p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch {}
      if (!p || !box) { pop.style.left = pop.style.top = ''; pop.style.right = pop.style.bottom = ''; return; }
      const W = box.clientWidth, H = box.clientHeight, w = pop.offsetWidth || 240, h = pop.offsetHeight || 48;
      pop.style.right = pop.style.bottom = 'auto';
      pop.style.left = Math.max(6, Math.min(W - w - 6, p.x * W)) + 'px';
      pop.style.top = Math.max(6, Math.min(H - h - 6, p.y * H)) + 'px';
    };
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const r0 = pop.getBoundingClientRect(), b0 = box.getBoundingClientRect(), dx = e.clientX - r0.left, dy = e.clientY - r0.top;
      pop.classList.add('dragging');
      const move = ev => {
        const W = box.clientWidth, H = box.clientHeight;
        const x = Math.max(6, Math.min(W - r0.width - 6, ev.clientX - b0.left - dx)), y = Math.max(6, Math.min(H - r0.height - 6, ev.clientY - b0.top - dy));
        pop.style.right = pop.style.bottom = 'auto'; pop.style.left = x + 'px'; pop.style.top = y + 'px';
      };
      const up = () => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        pop.classList.remove('dragging');
        const W = box.clientWidth, H = box.clientHeight;
        try { localStorage.setItem(POS_KEY, JSON.stringify({ x: pop.offsetLeft / W, y: pop.offsetTop / H })); } catch {}
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => { try { localStorage.removeItem(POS_KEY); } catch {} placePop(); });   // double-click: back to the corner
    window.addEventListener('resize', placePop);

    function paintAuto() {
      const o = K.readerSettings();
      autoVal.textContent = isStrip ? `${Math.round(o.autoSpeed / 10) / 10}×` : `${o.autoSecs}s`;
      autoVal.title = isStrip ? o.autoSpeed + ' px per second' : o.autoSecs + ' seconds per page';
      autoPlay.replaceChildren(icon(autoOn ? 'pause' : 'play'));
      pop.classList.toggle('paused', !autoOn);
      box.querySelector('.autob')?.classList.toggle('on', autoShown);
    }
    function autoTick(t) {
      if (!autoOn || state !== s || !box) return;
      const dt = autoLast ? Math.min(64, t - autoLast) : 16; autoLast = t;
      if (t > autoHold) {
        const o = K.readerSettings();
        if (isStrip) {
          autoAcc += o.autoSpeed * dt / 1000 / zm.z;   // zoomed in: the same speed on screen
          if (autoAcc >= 1) {
            const px = Math.floor(autoAcc); autoAcc -= px;
            const before = pagesBox.scrollTop;
            pagesBox.scrollTop = before + px;
            if (pagesBox.scrollTop === before && before > 0) {   // reached the bottom
              if (appending || (seamless && nextAfter(segs[segs.length - 1].chapter) && !appendErr)) { autoHold = performance.now() + 600; appendNext(); }
              else { setAuto(false); K.toast('End of the chapter'); return; }
            }
          }
        } else if ((autoT += dt) >= o.autoSecs * 1000) {
          autoT = 0;
          if ((s.pageEnd ?? s.page) >= s.pages.length - 1) { setAuto(false); step(1); return; }
          step(1);
        }
      }
      autoRaf = requestAnimationFrame(autoTick);
    }
    function setAuto(on) {
      autoOn = on; autoLast = 0; autoAcc = 0; autoT = 0; cancelAnimationFrame(autoRaf);
      if (on) { stopJump?.(); autoRaf = requestAnimationFrame(autoTick); }
      paintAuto();
    }
    function showAuto(on) {
      autoShown = on;
      if (on) { autoKeep = true; if (!pop.isConnected) { box.append(pop); placePop(); } setAuto(true); K.toast('Auto-scroll on · S to pause', 'ok'); }
      else { setAuto(false); pop.remove(); }
      paintAuto();
    }
    K.toggleAuto = () => { if (!autoShown) showAuto(true); else setAuto(!autoOn); };
    // your own scrolling, dragging or keys hold it briefly instead of fighting you
    const hold = () => { autoHold = performance.now() + 1400; autoAcc = 0; };
    for (const ev of ['wheel', 'touchstart', 'pointerdown']) pagesBox.addEventListener(ev, hold, { passive: true });
    if (opt.autoStart || autoKeep) setTimeout(() => { if (state === s) showAuto(true); }, 900);

    // Reading time for Stats: only while you're actually reading (you scrolled, tapped or pressed a key in the
    // last minute, or auto-scroll is running) and Koru is on screen.
    let lastAct = performance.now();
    const act = () => { lastAct = performance.now(); };
    for (const ev of ['scroll', 'wheel', 'pointerdown', 'touchstart']) pagesBox.addEventListener(ev, act, { passive: true });
    document.addEventListener('keydown', act);
    const statT = setInterval(() => {
      if (state !== s || document.hidden) return;
      if (performance.now() - lastAct < 60000 || autoOn) K.stats.add(s, 5000);
    }, 5000);

    slider.oninput = () => setPage(segOf(s.page).start + Number(slider.value) - 1);
    const step = d => {
      if (opt.mode === 'paged') {
        const [a, b] = viewOf(s.page);   // two pages on screen: turn past both
        const n = d > 0 ? b + d : a + d;
        if (n >= s.pages.length) { s.page = s.pageEnd = s.pages.length - 1; s.finished = true; saveProgress(); if (s.next && cdOn()) { box.append(end); setTimeout(startCountdown, 60); } else if (s.next && opt.autoNext) goChapter(s.next); else box.append(end); return; }
        setPage(n);
      } else pagesBox.scrollBy({ top: d * pagesBox.clientHeight * 0.85 / zm.z, behavior: 'smooth' });   // zoomed: a screenful of what you see
    };
    // Zoom: Ctrl + wheel, Ctrl + = / - / 0, double-click, and drag to look around while zoomed. The pages area
    // is moved by one transform (scale + shift) set once per frame; sizes are read once per gesture, never per
    // mouse move. In the long strip the wheel still scrolls while zoomed; dragging up and down scrolls too.
    const zm = { z: 1, x: 0, y: 0, raf: 0, size: null, drag: null, eat: false, wc: false, settleT: 0, animT: 0, scrollTo: null, painted: '' };
    const zSize = () => zm.size || (zm.size = { l: pagesBox.offsetLeft, t: pagesBox.offsetTop, w: pagesBox.offsetWidth || 1, h: pagesBox.offsetHeight || 1 });
    const zClamp = () => {
      const { w, h } = zSize();
      zm.x = Math.min(0, Math.max(w * (1 - zm.z), zm.x)); zm.y = Math.min(0, Math.max(h * (1 - zm.z), zm.y));
    };
    const zPaint = () => {
      zm.raf = 0;
      if (state !== s) return;
      if (zm.scrollTo != null) { pagesBox.scrollTop = zm.scrollTo; zm.scrollTo = null; }
      const on = zm.z > 1;
      const t = on ? `translate3d(${zm.x.toFixed(1)}px, ${zm.y.toFixed(1)}px, 0) scale(${zm.z.toFixed(4)})` : '';
      if (t === zm.painted) return;
      zm.painted = t; pagesBox.style.transform = t;
      if (box.classList.contains('zoomed') !== on) box.classList.toggle('zoomed', on);
    };
    const zKick = () => { if (!zm.raf) zm.raf = requestAnimationFrame(zPaint); };
    // while the size is changing the pages area is kept as one ready-made picture (will-change); once it
    // settles that hint goes, so the pages are drawn sharp again at the new size
    const zScaling = () => {
      if (!zm.wc) { zm.wc = true; pagesBox.style.willChange = 'transform'; }
      clearTimeout(zm.settleT);
      zm.settleT = setTimeout(() => { zm.wc = false; pagesBox.style.willChange = ''; }, 320);
    };
    const lite = () => document.documentElement.classList.contains('lite');
    function zoomAt(z, cx, cy, anim) {
      const S = zSize();
      z = Math.max(1, Math.min(4, z));
      if (z < 1.02) z = 1;
      if (z === zm.z) return;
      const px = cx - S.l, py = cy - S.t;
      zm.x = px - (px - zm.x) * z / zm.z; zm.y = py - (py - zm.y) * z / zm.z; zm.z = z;
      if (z === 1) zm.x = zm.y = 0;
      zClamp(); zScaling();
      if (anim && !lite()) {
        pagesBox.classList.add('zanim'); clearTimeout(zm.animT);
        zm.animT = setTimeout(() => pagesBox.classList.remove('zanim'), 280);
      }
      zKick();
    }
    const zoomBy = f => { const S = zSize(); zoomAt(zm.z * f, S.l + S.w / 2, S.t + S.h / 2); };
    function zoomReset() { if (zm.z === 1 && !zm.x && !zm.y) return; zm.z = 1; zm.x = zm.y = 0; zm.drag = null; box.classList.remove('panning'); zKick(); }
    // The wheel listener stays passive so scrolling never waits for this page's code. Only while Ctrl is held
    // a second, blocking listener is added, so Ctrl + wheel zooms instead of also scrolling the strip.
    const wheelZoom = e => zoomAt(zm.z * Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.0022), e.clientX, e.clientY);
    const ctrlWheel = e => { if (e.cancelable) e.preventDefault(); wheelZoom(e); };
    let ctrlHeld = false;
    const ctrlOn = on => {
      if (on === ctrlHeld) return;
      ctrlHeld = on;
      if (on) pagesBox.addEventListener('wheel', ctrlWheel, { passive: false }); else pagesBox.removeEventListener('wheel', ctrlWheel, { passive: false });
    };
    const ctrlKeys = e => ctrlOn(e.type === 'keydown' ? e.ctrlKey || e.key === 'Control' : e.ctrlKey && e.key !== 'Control');
    const ctrlOff = () => ctrlOn(false);
    document.addEventListener('keydown', ctrlKeys, true); document.addEventListener('keyup', ctrlKeys, true); window.addEventListener('blur', ctrlOff);
    pagesBox.addEventListener('wheel', e => {
      if (e.ctrlKey) { if (!ctrlHeld) wheelZoom(e); return; }   // e.g. a touchpad pinch, with no Ctrl key press first
      ctrlOff();   // Ctrl was let go somewhere we didn't see
      if (zm.z === 1) return;
      if (opt.mode === 'paged') { zm.x -= e.shiftKey ? e.deltaY : e.deltaX; zm.y -= e.shiftKey ? 0 : e.deltaY; }   // page mode: the wheel looks around
      else if (e.deltaX || e.shiftKey) zm.x -= e.deltaX || e.deltaY;                                                   // strip: up/down still scrolls
      else return;
      zClamp(); zKick();
    }, { passive: true });
    pagesBox.addEventListener('pointerdown', e => {
      zm.eat = false;
      if (zm.z === 1 || e.button !== 0 || e.target.closest('.endcard, button')) return;
      e.preventDefault();   // no text selection or picture drag-out while looking around
      zm.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, tx: zm.x, ty: zm.y, st: opt.mode === 'strip' ? pagesBox.scrollTop : 0, moved: false };
      try { pagesBox.setPointerCapture(e.pointerId); } catch {}
    });
    pagesBox.addEventListener('dragstart', e => { if (zm.z > 1) e.preventDefault(); });
    pagesBox.addEventListener('pointermove', e => {
      const d = zm.drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.moved) { if (Math.abs(dx) + Math.abs(dy) < 6) return; d.moved = true; box.classList.add('panning'); }
      zm.x = d.tx + dx;
      if (opt.mode === 'strip') zm.scrollTo = Math.max(0, d.st - dy / zm.z); else zm.y = d.ty + dy;
      zClamp(); zKick();
    });
    const zUp = e => {
      const d = zm.drag;
      if (!d || e.pointerId !== d.id) return;
      zm.drag = null; zm.eat = d.moved; box.classList.remove('panning');
    };
    pagesBox.addEventListener('pointerup', zUp); pagesBox.addEventListener('pointercancel', zUp);
    pagesBox.addEventListener('dblclick', e => {
      if (e.target.closest('.endcard, .ph, button')) return;
      if (zm.z > 1) { zoomAt(1, e.clientX, e.clientY, true); return; }
      const x = e.clientX / window.innerWidth;
      if (opt.tapZones && (x < 0.3 || x > 0.7)) return;   // clicks there turn pages
      zoomAt(2.5, e.clientX, e.clientY, true);
    });

    // Keyboard shortcuts: ? shows them all
    let keysBox = null;
    const closeKeys = () => { if (!keysBox) return; const k = keysBox; keysBox = null; k.classList.add('out'); setTimeout(() => k.remove(), lite() ? 0 : 160); };
    const showKeys = () => {
      if (keysBox) { closeKeys(); return; }
      box.querySelector('.rset')?.remove();
      const paged = opt.mode === 'paged', flip = paged && opt.rtl;
      const fwd = paged ? 'Next page' : 'Scroll down', back = paged ? 'Previous page' : 'Scroll up';
      // keys: ['A', 'B'] = A or B; combo('Ctrl', '0') = Ctrl + 0
      const row = (keys, what) => el('div.rk', el('span.rkk', ...keys.map((k, n) => [n && k !== '+' && keys[n - 1] !== '+' ? el('i', { text: 'or' }) : null, k === '+' ? el('i', { text: '+' }) : el('kbd', { text: k })])), el('span.rkw', { text: what }));
      const combo = (...keys) => keys.flatMap((k, n) => (n ? ['+', k] : [k]));
      const sec = (title, ...rows) => el('div.rks', el('small', { text: title }), ...rows);
      keysBox = el('div.rkeys', { onclick: e => { if (e.target === keysBox) closeKeys(); } },
        el('div.rkcard.glass', { role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
          el('div.rkhead', kbIcon(), el('b', { text: 'Keyboard shortcuts' }), el('button.btn.small.icon', { title: 'Close (Esc)', onclick: closeKeys }, icon('x'))),
          el('div.rkgrid',
            sec('Reading',
              row(['→', 'D'], flip ? back : fwd),
              row(['←', 'A'], flip ? fwd : back),
              row(['Space', 'Page Down'], fwd),
              row(combo('Shift', 'Space'), back),
              paged ? null : row(['↑', '↓'], 'Scroll a little'),
              row(['N'], 'Next chapter'),
              row(['P'], 'Previous chapter'),
              row(['Enter'], 'Up next countdown: open it now')),
            sec('Modes',
              row(['S'], 'Auto-scroll on, pause, play'),
              row(['Z'], 'Zen mode (full screen)'),
              row(combo('Shift', 'N'), 'Night filter on or off'),
              row(['Esc'], 'Leave zen · close the chapter list · close the chapter'),
              row(['?'], 'Show or hide this list')),
            sec('Zoom',
              row(combo('Ctrl', 'Wheel'), 'Zoom at the mouse'),
              row(combo('Ctrl', '='), 'Zoom in'),
              row(combo('Ctrl', '-'), 'Zoom out'),
              row(combo('Ctrl', '0'), 'Back to normal size (Esc too)'),
              row(['Double-click'], 'Zoom in there, or back out'),
              row(['Drag'], paged ? 'Look around while zoomed (the wheel too)' : 'Look around while zoomed; the wheel still scrolls')))));
      box.append(keysBox);
    };

    pagesBox.addEventListener('click', e => {
      if (zm.eat) { zm.eat = false; return; }   // the end of a drag while zoomed, not a click
      if (e.target.closest('.endcard, .ph')) return;
      const x = e.clientX / window.innerWidth;
      if (zm.z > 1) { /* zoomed: the sides don't turn pages */ }
      else if (opt.tapZones && x < 0.3) { step(opt.rtl && opt.mode === 'paged' ? 1 : -1); return; }
      else if (opt.tapZones && x > 0.7) { step(opt.rtl && opt.mode === 'paged' ? -1 : 1); return; }
      if (box.classList.contains('zen')) return;
      box.classList.contains('hide-ui') ? showUi() : box.classList.add('hide-ui');
    });
    box.addEventListener('pointermove', e => {
      if (box.classList.contains('zen')) { box.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => box?.classList.add('idle'), 1500); return; }
      if (e.target.closest?.('.autopop')) return;   // using the auto-scroll pop-up doesn't bring the bars up
      if (e.clientY < 90 || e.clientY > window.innerHeight - 90) showUi();
    });
    const onKey = e => {
      if (!box || e.target.matches?.('input, select, textarea')) return;
      if (keysBox && (e.key === 'Escape' || e.key === '?')) { e.preventDefault(); closeKeys(); return; }
      if (e.ctrlKey && !e.altKey && ['=', '+', '-', '_', '0'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '0') zoomAt(1, 0, 0, true); else zoomBy(e.key === '=' || e.key === '+' ? 1.25 : 0.8);
        return;
      }
      if (e.key === '?') { e.preventDefault(); showKeys(); }
      else if ((e.key === 'N' || e.key === 'n') && e.shiftKey) toggleNight();
      else if (e.key === 'Escape' && zm.z > 1) zoomAt(1, 0, 0, true);
      else if (e.key === 'z' || e.key === 'Z') K.toggleZen();
      else if (e.key === 's' || e.key === 'S') K.toggleAuto();
      else if (e.key === 'Escape' && box.classList.contains('zen')) K.toggleZen();
      else if (e.key === 'Escape') { if (drawer.classList.contains('open')) drawer.classList.remove('open'); else K.closeReader(); }
      else if (e.key === 'ArrowRight' || e.key === 'd') step(opt.rtl && opt.mode === 'paged' ? -1 : 1);
      else if (e.key === 'ArrowLeft' || e.key === 'a') step(opt.rtl && opt.mode === 'paged' ? 1 : -1);
      else if (e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'n' && s.next) goNext();
      else if (e.key === 'p' && s.prev) goPrev();
      else return;
    };
    document.addEventListener('keydown', onKey);
    // window size: the two-page view (wider than tall) and the zoom's cached sizes follow it
    const onResize = () => {
      winW = window.innerWidth; winH = window.innerHeight; zm.size = null;
      if (zm.z > 1) { zm.z = 1; zm.x = zm.y = 0; zKick(); }
      reView();
    };
    window.addEventListener('resize', onResize);
    const oldCleanup = s.cleanup;
    s.cleanup = () => { oldCleanup?.(); ofsWatch.disconnect(); cancelAnimationFrame(ambRaf); ambRaf = 0; ambCache.clear(); document.removeEventListener('keydown', onKey); clearTimeout(hideT); clearTimeout(idleT); cancelAnimationFrame(fpsRaf); cancelAnimationFrame(autoRaf); clearInterval(statT); clearTimeout(clockT); window.removeEventListener('resize', placePop); document.removeEventListener('keydown', act);
      clearTimeout(nightT); cancelAnimationFrame(zm.raf); clearTimeout(zm.settleT); clearTimeout(zm.animT); window.removeEventListener('resize', onResize); keysBox?.remove(); keysBox = null;
      ctrlOff(); document.removeEventListener('keydown', ctrlKeys, true); document.removeEventListener('keyup', ctrlKeys, true); window.removeEventListener('blur', ctrlOff); };

    // reader settings popover
    function toggleSettings() {
      const open = box.querySelector('.rset');
      if (open) { open.remove(); return; }
      const o = K.readerSettings();
      const re = patch => { saveProgress(); setReader(patch); K.openReader(s.provider, s.slug, s.chapter.slug); };
      const range = (label, key, min, max, stepv, unit) => {
        const v = el('span.val', { text: o[key] + unit });
        const r = el('input', { type: 'range', min, max, step: stepv, value: o[key] });
        const paint = () => r.style.setProperty('--p', ((r.value - min) / (max - min)) * 100 + '%');
        paint();
        r.oninput = () => { v.textContent = r.value + unit; paint(); if (key === 'width') strip.style.maxWidth = r.value + 'px'; if (key === 'gap') strip.style.gap = r.value + 'px'; };
        r.onchange = () => setReader({ [key]: Number(r.value) });
        return el('div.ctl', el('div.lab', { text: label }), r, v);
      };
      const ambRange = (label, key, min, max, stepv, unit) => {
        const n = range(label, key, min, max, stepv, unit), r = n.querySelector('input');
        r.addEventListener('input', () => applyAmb({ ...K.readerSettings(), [key]: Number(r.value) }));
        return n;
      };
      const tog = (label, key, sub, reload) => {
        const t = el('button.toggle' + (o[key] ? '.on' : ''));
        t.onclick = () => { const v = !K.readerSettings()[key]; t.classList.toggle('on', v); if (reload) re({ [key]: v }); else setReader({ [key]: v }); };
        return el('div.ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), t);
      };
      // a toggle whose change shows at once (after the setting is saved)
      const live = (n, fn) => { n.querySelector('.toggle').addEventListener('click', () => setTimeout(fn)); return n; };
      const nightRange = (label, key, min, max, stepv, unit) => {
        const n = range(label, key, min, max, stepv, unit), r = n.querySelector('input');
        r.addEventListener('input', () => paintNight({ ...K.readerSettings(), [key]: Number(r.value) }));
        return n;
      };
      const hourName = h => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
      const hourSel = key => {
        const sel = el('select.sel-in', { title: key === 'nightFrom' ? 'From' : 'To' }, ...Array.from({ length: 24 }, (_, h) => el('option', { value: String(h), text: hourName(h) })));
        sel.value = String(o[key]);
        sel.onchange = () => { setReader({ [key]: Number(sel.value) }); nightOverride = null; paintNight(); };
        return sel;
      };
      box.append(el('div.rset.glass',
        el('div.ctl', el('div.lab', 'Keyboard shortcuts', el('small', { text: 'Every key the reader knows. Key: ?' })),
          el('button.btn.small', { onclick: () => showKeys() }, kbIcon(), 'Show')),
        el('div.ctl', el('div.lab', { text: 'Layout' }), K.segmented([['strip', 'Strip', 'scroll'], ['paged', 'Pages', 'pages']], o.mode, v => re({ mode: v }))),
        range('Page width', 'width', 400, 1600, 20, 'px'),
        range('Gap between pages', 'gap', 0, 40, 1, 'px'),
        range('Pages to load ahead', 'preload', 1, 10, 1, ''),
        el('div.ctl', el('div.lab', 'Auto-scroll', el('small', { text: 'Hands-free reading with a speed pop-up. Key: S' })),
          el('button.btn.small', { onclick: () => { box.querySelector('.rset')?.remove(); K.toggleAuto(); } }, icon('auto'), 'Start')),
        tog('Start auto-scroll on every chapter', 'autoStart', ''),
        tog('Ambient light', 'ambient', 'The colours on screen glow around the pages', true),
        opt.mode === 'strip' && o.ambient ? el('div.ctl', el('div.lab', { text: 'Follows' }),
          K.segmented([['scroll', 'On screen'], ['page', 'Whole page']], o.ambMode, v => { setReader({ ambMode: v }); applyAmb(K.readerSettings()); })) : null,
        ambRange('Ambient strength', 'ambStrength', 0, 100, 1, '%'),
        ambRange('Ambient softness', 'ambBlur', 20, 220, 5, 'px'),
        ambRange('Ambient colour', 'ambSat', 60, 250, 5, '%'),
        ambRange('Ambient smoothness', 'ambEase', 0, 100, 1, '%'),
        (() => { const n = tog('Calm bright pages', 'ambCalm', 'White pages glow less'); n.querySelector('.toggle').addEventListener('click', () => setTimeout(() => applyAmb(K.readerSettings()))); return n; })(),
        tog('Right to left', 'rtl', 'For manga in page mode', true),
        opt.mode === 'paged' ? el('div.ctl', el('div.lab', 'Two pages', el('small', { text: 'Side by side like a book. Auto: when the window is wider than tall' })),
          K.segmented([['off', 'Off'], ['auto', 'Auto'], ['on', 'On']], o.spread, v => { setReader({ spread: v }); grouped = false; reView(); })) : null,
        opt.mode === 'paged' ? live(tog('First page alone', 'spreadCover', 'The cover shows by itself, then pages pair up'), () => { grouped = false; reView(); }) : null,
        live(tog('Night filter', 'night', 'Warmer, dimmer pages for reading in the dark. Key: Shift+N'), () => { nightOverride = null; paintNight(); }),
        nightRange('Night warmth', 'nightWarm', 0, 100, 1, '%'),
        nightRange('Night brightness', 'nightDim', 30, 100, 1, '%'),
        live(tog('Turn on by itself at night', 'nightAuto', 'Between the hours below'), () => { nightOverride = null; paintNight(); }),
        el('div.ctl', el('div.lab', { text: 'Night hours' }), hourSel('nightFrom'), el('span.muted', { text: 'to' }), hourSel('nightTo')),
        tog('Next-chapter countdown', 'countdown', 'At the end: the next chapter with 3, 2, 1. Click to stay', true),
        tog('Keep reading into the next chapter', 'autoNext', 'Long strip: the next chapter joins underneath. Pages: goes on after the last page', true),
        tog('Tap sides to turn', 'tapZones', ''),
        el('div.ctl', el('div.lab', 'Zen mode', el('small', { text: 'Full screen, just the pages. Z or Esc to leave' })),
          el('button.btn.small', { onclick: () => K.toggleZen() }, icon('zen'), 'Enter')),
        tog('Show the time', 'clock', 'A small clock in the top bar, and in the corner when the bars hide', true),
        tog('Show frame rate', 'fps', 'A small meter in the corner, to check for lag', true)));
    }

    pagesBox.focus();
    // already full screen = moving to the next chapter, so no hint again
    if (opt.zen) setZen(true, window.innerHeight >= screen.height - 2);
    setPage(startPage);
    if (jump) { doJump(); setTimeout(doJump, 60); }
  }
})();
