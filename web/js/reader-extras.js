// Koru reader extras: panel by panel, sharpen blurry pages, ambient sound, and the "Previously on…" card on
// series pages. reader.js hands each chapter over through K.rx.attach(); everything here sleeps until you use
// it: nothing runs while you scroll, no timers tick, and no sound is made (or even prepared) until you pick one.
'use strict';
(function () {
  const { el, icon } = K;
  const X = K.rx = {};
  const svg = paths => { const s = icon('dot'); s.innerHTML = paths; return s; };   // trusted constants only
  const IC = {
    panels: '<rect x="4" y="3.5" width="16" height="7.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="7" rx="1.6"/>',
    sharp: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 7.2l1.2 3.6 3.6 1.2-3.6 1.2L12 16.8l-1.2-3.6L7.2 12l3.6-1.2z"/>',
    sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.2 6.4a7.6 7.6 0 0 1 0 11.2"/>'
  };
  const RS = () => K.readerSettings();
  const setR = patch => { K.data.settings.reader = { ...K.readerSettings(), ...patch }; K.save('settings'); };
  const calmMotion = () => document.documentElement.classList.contains('lite') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const idle = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 1500 }) : setTimeout(r, 50)));
  const eat = e => { e.preventDefault(); e.stopPropagation(); };
  const short = n => String(n || '').replace(/ — .*/, '');
  let R = null;   // the chapter on screen (from reader.js), or null

  // a page's slices (long strip) or picture (page mode) are on screen; false if that takes too long
  const ready = async (a, i, ms = 9000) => {
    a.load(i);
    for (let t = 0; t < ms / 60; t++) { if (!a.on) return false; if (a.st[i] === 'ready') return true; if (!a.st[i]) a.load(i); await wait(60); }
    return false;
  };

  // ---------- hooks for reader.js ----------
  X.attach = a => {
    R = a; a.on = true;
    a.pcache = new Map();
    const old = a.s.cleanup;
    a.s.cleanup = () => { old?.(); detach(a); };
    addButtons(a);
    document.addEventListener('keydown', onKey, true);
    if (RS().sharpen) Sharp.start(a);
    const snd = RS().sound;
    if (snd && snd !== 'off') Sound.play(snd);   // the last sound you picked carries on (or comes back)
  };
  function detach(a) {
    a.on = false;
    if (Panels.a === a) Panels.stop(true);
    Sharp.stop(a, false);
    document.removeEventListener('keydown', onKey, true);
    closeSoundPop();
    if (R === a) R = null;
    // closing the reader (not just moving to the next chapter) ends the sound
    setTimeout(() => { if (!K.readingSeries()) Sound.stop(); }, 0);
  }
  // rows for the reader's keyboard shortcuts list
  X.keyRows = row => [row(['G'], 'Panel by panel (long strip): arrows, Space or click to move'), row(['E'], 'Sharpen blurry pages on or off')];
  // rows for the reader's settings pop-up
  X.settingsRows = () => {
    const a = R, o = RS();
    const tg = el('button.toggle' + (o.sharpen ? '.on' : ''), { role: 'switch', onclick: () => { Sharp.toggle(); tg.classList.toggle('on', !!RS().sharpen); } });
    return [
      a?.opt.mode === 'strip' ? el('div.ctl', el('div.lab', 'Panel by panel', el('small', { text: 'Zooms to one panel at a time. Key: G' })),
        el('button.btn.small', { onclick: () => { a.box.querySelector('.rset')?.remove(); Panels.toggle(); } }, svg(IC.panels), 'Start')) : null,
      el('div.ctl', el('div.lab', 'Sharpen blurry pages', el('small', { text: 'Small or soft pages get a cleaner copy. Key: E' })), tg),
      soundRow(), volRow()];
  };
  // rows for Settings → Reader (settings.js passes its own helpers)
  X.settingsPanel = ({ toggle, select, slider, ro, setR: set }) => [
    toggle('Sharpen blurry pages', !!ro.sharpen, v => set({ sharpen: v }), 'Pages that are smaller than the screen or look soft get a sharper copy, made once by the graphics card. Key: E while reading'),
    select('Ambient sound', SOUNDS, ro.sound || 'off', v => set({ sound: v })),
    slider('Ambient sound volume', ro.soundVol ?? 40, 0, 100, 1, '%', v => { set({ soundVol: v }); Sound.setVol(); }, 'Rain, wind, a café, a fire or calm chords while you read. Pick one from the speaker button in the reader')];

  function addButtons(a) {
    const top = a.box.querySelector('.rbar.top'), bottom = a.box.querySelector('.rbar.bottom');
    if (top) {
      const end = top.lastElementChild;   // the chapter list button stays last
      if (a.opt.mode === 'strip') top.insertBefore(el('button.btn.icon.rx-panelb', { title: 'Panel by panel (G)', onclick: () => Panels.toggle() }, svg(IC.panels)), end);
      top.insertBefore(el('button.btn.icon.rx-soundb', { title: 'Ambient sound', onclick: e => soundPop(e.currentTarget) }, svg(IC.sound)), end);
    }
    if (bottom) bottom.insertBefore(el('button.btn.icon.rx-sharpb', { title: 'Sharpen blurry pages (E)', onclick: () => Sharp.toggle() }, svg(IC.sharp)), bottom.lastElementChild);
    paintButtons();
  }
  function paintButtons() {
    const b = R?.box;
    if (!b) return;
    b.querySelector('.rx-panelb')?.classList.toggle('on', Panels.on);
    b.querySelector('.rx-sharpb')?.classList.toggle('on', !!RS().sharpen);
    b.querySelector('.rx-soundb')?.classList.toggle('on', Sound.cur !== 'off');
  }

  function onKey(e) {
    if (!R || e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input, select, textarea')) return;
    if (R.box.querySelector('.rkeys')) return;   // the shortcuts list handles its own keys
    const k = e.key;
    if (soundBox && k === 'Escape') { eat(e); closeSoundPop(); return; }
    if (Panels.on) {
      if (['ArrowRight', 'ArrowDown', 'PageDown', 'd'].includes(k) || (k === ' ' && !e.shiftKey)) { eat(e); Panels.step(1); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'a'].includes(k) || (k === ' ' && e.shiftKey)) { eat(e); Panels.step(-1); }
      else if (k === 'Escape' || k === 'g' || k === 'G') { eat(e); Panels.stop(); }
      else if (k === 's' || k === 'S') eat(e);   // no auto-scroll while going panel by panel
      return;
    }
    if (k === 'g' || k === 'G') { eat(e); Panels.toggle(); }
    else if (k === 'e' || k === 'E') { eat(e); Sharp.toggle(); }
  }

  // ---------- panel by panel ----------
  // Each page is shrunk to 120 px wide once, on a small canvas, and its rows are checked for gutters (rows of
  // nearly one colour). The parts between gutters are the panels; a panel cut by the end of a page joins the
  // one at the top of the next page. Going to a panel is one short glide of the reader's own zoom (scale +
  // shift) and scroll, so nothing is redrawn but the pages' ready-made slices.
  async function analyse(a, i) {
    if (a.pcache.has(i)) return a.pcache.get(i);
    const whole = [{ t: 0, b: 1, l: 0, r: 1, top: false, bot: false }];
    const p = (async () => {
      if (!(await ready(a, i))) return whole;
      try {
        const bm = await createImageBitmap(await a.fileOf(i), { resizeWidth: 120, resizeQuality: 'medium' });
        const w = bm.width, h = bm.height;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bm, 0, 0); bm.close();
        const out = findPanels(cx.getImageData(0, 0, w, h).data, w, h);
        c.width = c.height = 0;
        return out.length ? out : whole;
      } catch { return whole; }   // a page that can't be read is one panel
    })();
    a.pcache.set(i, p);
    return p;
  }
  function findPanels(d, w, h) {
    const T = 22, x0 = Math.floor(w * 0.02), x1 = Math.ceil(w * 0.98);
    const flat = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
      for (let x = x0, o = (y * w + x0) * 4; x < x1; x++, o += 4) {
        const r = d[o], g = d[o + 1], b = d[o + 2];
        if (r < r0) r0 = r; if (r > r1) r1 = r; if (g < g0) g0 = g; if (g > g1) g1 = g; if (b < b0) b0 = b; if (b > b1) b1 = b;
      }
      flat[y] = r1 - r0 <= T && g1 - g0 <= T && b1 - b0 <= T ? 1 : 0;
    }
    const minGap = Math.max(2, Math.round(w * 0.025)), minPanel = Math.round(w * 0.12);
    const gaps = [];
    for (let y = 0; y < h;) {
      if (!flat[y]) { y++; continue; }
      let e = y; while (e < h && flat[e]) e++;
      if (e - y >= minGap || y === 0 || e === h) gaps.push([y, e]);
      y = e;
    }
    const segs = []; let at = 0;
    for (const [a, b] of gaps) { if (a > at) segs.push([at, a]); at = b; }
    if (at < h) segs.push([at, h]);
    // slivers (a line of text, a thin border) join the closer neighbour
    for (let k = 0; k < segs.length && segs.length > 1;) {
      const [a, b] = segs[k];
      if (b - a >= minPanel) { k++; continue; }
      const gp = k > 0 ? a - segs[k - 1][1] : Infinity, gn = k < segs.length - 1 ? segs[k + 1][0] - b : Infinity;
      if (gp <= gn) segs[k - 1][1] = b; else segs[k + 1][0] = a;
      segs.splice(k, 1); k = Math.max(0, k - 1);
    }
    // left and right edges: trim plain margins so the panel itself fills the screen
    const colFlat = (x, a, b) => {
      let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
      for (let y = a, o = (a * w + x) * 4; y < b; y++, o += w * 4) {
        const r = d[o], g = d[o + 1], bb = d[o + 2];
        if (r < r0) r0 = r; if (r > r1) r1 = r; if (g < g0) g0 = g; if (g > g1) g1 = g; if (bb < b0) b0 = bb; if (bb > b1) b1 = bb;
        if (r1 - r0 > T || g1 - g0 > T || b1 - b0 > T) return false;
      }
      return true;
    };
    return segs.map(([a, b]) => {
      let l = 0, r = w - 1;
      while (l < r && colFlat(l, a, b)) l++;
      while (r > l && colFlat(r, a, b)) r--;
      let L = Math.max(0, (l - w * 0.015) / w), Rt = Math.min(1, (r + 1 + w * 0.015) / w);
      if (Rt - L < 0.3) { L = 0; Rt = 1; }
      return { t: a / h, b: b / h, l: L, r: Rt, top: a === 0, bot: b === h };
    });
  }
  // the stops (panels, and tall panels cut into screenfuls) around page i, in the pages area's own pixels
  async function stopsNear(a, i) {
    const from = Math.max(0, i - 1), to = Math.min(a.s.pages.length - 1, i + 3), list = [];
    for (let j = from; j <= to; j++) list.push(j);
    const found = await Promise.all(list.map(j => analyse(a, j)));
    if (!a.on) return [];
    const rects = [];
    list.forEach((j, n) => {
      const p = a.pg(j);
      if (!p) return;
      const pt = p.offsetTop, ph = p.offsetHeight, pl = p.offsetLeft, pw = p.offsetWidth;
      for (const q of found[n]) {
        const r = { y0: pt + q.t * ph, y1: pt + q.b * ph, x0: pl + q.l * pw, x1: pl + q.r * pw, top: q.top, bot: q.bot };
        const last = rects[rects.length - 1];
        if (last && last.bot && r.top && r.y0 - last.y1 <= 4) Object.assign(last, { y1: r.y1, x0: Math.min(last.x0, r.x0), x1: Math.max(last.x1, r.x1), bot: r.bot });
        else rects.push(r);
      }
    });
    const { w, h } = a.zSize(), out = [];
    for (const r of rects) {
      const zw = Math.min(4, Math.max(1, w * 0.96 / (r.x1 - r.x0))), vis = h * 0.94 / zw, rh = r.y1 - r.y0;
      if (rh <= vis * 1.15) { out.push(r); continue; }
      const n = Math.ceil((rh - vis) / (vis * 0.85)) + 1, st = (rh - vis) / (n - 1);
      for (let k = 0; k < n; k++) out.push({ ...r, y0: r.y0 + k * st, y1: r.y0 + k * st + vis });
    }
    return out;
  }
  const pageAt = (a, y) => {
    let lo = 0, hi = a.s.pages.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a.pg(m).offsetTop <= y) lo = m; else hi = m - 1; }
    return lo;
  };
  const Panels = {
    on: false, a: null, cur: null, busy: false, queued: 0, raf: 0, pill: null, wheelAt: 0, wheelSum: 0, down: null, swiped: false, resizeT: 0,
    toggle() { this.on ? this.stop() : this.start(); },
    start() {
      const a = R;
      if (!a || this.on) return;
      if (a.opt.mode !== 'strip') { K.toast('Panel by panel works in the long strip'); return; }
      this.on = true; this.a = a; this.cur = null; this.queued = 0;
      a.box.classList.add('rx-panels', 'hide-ui');
      const ap = a.box.querySelector('.autopop');
      if (ap && !ap.classList.contains('paused')) K.toggleAuto?.();   // pause auto-scroll
      a.box.addEventListener('pointerdown', this.onDown, true);
      a.box.addEventListener('pointerup', this.onUp, true);
      a.box.addEventListener('click', this.onClick, true);
      a.box.addEventListener('dblclick', this.onDbl, true);
      a.pagesBox.addEventListener('wheel', this.onWheel, { passive: false });
      window.addEventListener('resize', this.onResize);
      this.pill = el('div.rx-pill.glass', svg(IC.panels), el('span', { text: 'Panel by panel' }),
        el('button.btn.small.icon', { title: 'Back to the strip (G or Esc)', onclick: () => this.stop() }, icon('x')));
      a.box.append(this.pill);
      paintButtons();
      K.toast('Panel by panel · arrows, Space or a click to move · G or Esc to leave');
      this.step(0);
    },
    // quiet: the chapter is closing, so no glide back
    stop(quiet) {
      if (!this.on) return;
      const a = this.a;
      this.on = false; this.a = null; this.cur = null;
      cancelAnimationFrame(this.raf); this.raf = 0; clearTimeout(this.resizeT);
      a.box.removeEventListener('pointerdown', this.onDown, true);
      a.box.removeEventListener('pointerup', this.onUp, true);
      a.box.removeEventListener('click', this.onClick, true);
      a.box.removeEventListener('dblclick', this.onDbl, true);
      a.pagesBox.removeEventListener('wheel', this.onWheel, { passive: false });
      window.removeEventListener('resize', this.onResize);
      this.pill?.remove(); this.pill = null;
      a.box.classList.remove('rx-panels');
      paintButtons();
      if (quiet || !a.on) return;
      // back to the normal strip, with the same spot in the middle of the screen
      const v = view(a);
      fly(a, { z: 1, cx: v.cx, cy: v.cy }, () => { a.zm.z = 1; a.zm.x = a.zm.y = 0; a.zKick(); });
    },
    async step(d) {
      if (!this.on) return;
      if (this.busy) { this.queued = d; return; }
      this.busy = true;
      const a = this.a;
      try {
        const h = a.pagesBox.clientHeight;
        const i = this.cur ? this.cur.i : a.s.page;
        let stops = await stopsNear(a, i);
        if (!this.on || this.a !== a) return;
        if (!stops.length) { K.toast('No panels found here'); this.stop(); return; }
        let k;
        if (!this.cur) {
          const line = a.pagesBox.scrollTop + h * 0.4;
          k = stops.findIndex(r => r.y1 > line);
          if (k < 0) k = stops.length - 1;
        } else {
          const y = a.pg(this.cur.i).offsetTop + this.cur.f * a.pg(this.cur.i).offsetHeight;
          let k0 = 0;
          stops.forEach((r, n) => { if (Math.abs(r.y0 - y) < Math.abs(stops[k0].y0 - y)) k0 = n; });
          k = k0 + d;
          if (k >= stops.length) {
            // the end of the strip: the next chapter may still be joining underneath
            for (let t = 0; t < 30 && a.on && a.box.querySelector('.endcard .spinner'); t++) await wait(150);
            stops = await stopsNear(a, Math.min(a.s.pages.length - 1, pageAt(a, stops[stops.length - 1].y0) + 1));
            if (!this.on) return;
            k = stops.findIndex(r => r.y0 > y + 2);
            if (k < 0) { K.toast('End of the chapter'); this.stop(); return; }
          }
          if (k < 0) k = 0;
        }
        const r = stops[k], pi = pageAt(a, r.y0), p = a.pg(pi);
        this.cur = { i: pi, f: (r.y0 - p.offsetTop) / (p.offsetHeight || 1) };
        this.show(a, r);
      } finally {
        this.busy = false;
        if (this.queued && this.on) { const q = this.queued; this.queued = 0; this.step(q); }
      }
    },
    show(a, r, instant) {
      const { w, h } = a.zSize();
      const z = Math.min(4, Math.max(1, Math.min(w * 0.96 / (r.x1 - r.x0), h * 0.94 / (r.y1 - r.y0))));
      fly(a, { z, cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2 }, null, instant);
    },
    onDown: e => { const P = Panels; if (!P.a?.pagesBox.contains(e.target) || e.target.closest('.endcard')) return; e.stopPropagation(); P.down = { x: e.clientX, y: e.clientY }; },
    onUp: e => {
      const P = Panels, d = P.down; P.down = null;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) { P.swiped = true; P.step(dy < 0 ? 1 : -1); }
    },
    onClick: e => {
      const P = Panels;
      if (!P.a?.pagesBox.contains(e.target) || e.target.closest('.endcard')) return;
      e.stopPropagation();
      if (P.swiped) { P.swiped = false; return; }
      P.step(e.clientX / window.innerWidth < 0.3 ? -1 : 1);
    },
    onDbl: e => { if (Panels.a?.pagesBox.contains(e.target)) e.stopPropagation(); },
    onWheel: e => {
      const P = Panels;
      if (e.ctrlKey) return;
      e.preventDefault();
      const now = performance.now();
      if (now - P.wheelAt > 400) P.wheelSum = 0;
      P.wheelSum += e.deltaY;
      if (Math.abs(P.wheelSum) < 40 || now - P.wheelAt < 320) return;
      P.wheelAt = now; P.step(P.wheelSum > 0 ? 1 : -1); P.wheelSum = 0;
    },
    onResize: () => { const P = Panels; clearTimeout(P.resizeT); P.resizeT = setTimeout(() => { if (P.on && P.cur) { P.queued = 0; P.step(0); } }, 250); }
  };
  // the reader's zoom as a view: zoom level and the point (in the pages area's pixels) at the middle of the screen
  const view = a => { const { w, h } = a.zSize(), zm = a.zm; return { z: zm.z, cx: (w / 2 - zm.x) / zm.z, cy: a.pagesBox.scrollTop + (h / 2 - zm.y) / zm.z }; };
  function fly(a, to, done, instant) {
    cancelAnimationFrame(Panels.raf);
    const pb = a.pagesBox, { w, h } = a.zSize(), maxT = Math.max(0, pb.scrollHeight - pb.clientHeight), from = view(a);
    const put = (z, cx, cy) => {
      const T = Math.max(0, Math.min(maxT, cy - h / 2)), zm = a.zm;
      zm.z = z;
      zm.y = Math.min(0, Math.max(h * (1 - z), h / 2 - z * (cy - T)));
      zm.x = Math.min(0, Math.max(w * (1 - z), w / 2 - z * cx));
      zm.scrollTo = T; a.zKick();
    };
    const far = Math.abs(to.cy - from.cy) > h * 3;
    if (instant || calmMotion() || far) { put(to.z, to.cx, to.cy); done?.(); return; }
    const t0 = performance.now(), dur = 380, lz0 = Math.log(from.z), lz1 = Math.log(to.z);
    pb.style.willChange = 'transform';
    const tick = t => {
      if (!a.on) return;
      const p = Math.min(1, (t - t0) / dur), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      put(Math.exp(lz0 + (lz1 - lz0) * e), from.cx + (to.cx - from.cx) * e, from.cy + (to.cy - from.cy) * e);
      if (p < 1) Panels.raf = requestAnimationFrame(tick);
      else { Panels.raf = 0; setTimeout(() => { if (!Panels.raf) pb.style.willChange = ''; }, 300); done?.(); }
    };
    Panels.raf = requestAnimationFrame(tick);
  }

  // ---------- sharpen blurry pages ----------
  // Pages near the screen are looked at one at a time, while you aren't scrolling. A page smaller than the space
  // it's shown in is enlarged with bicubic (Catmull-Rom) sampling on the graphics card, then sharpened with a
  // contrast-adaptive pass (strong on soft edges, gentle where there's already contrast, so no halos). A page
  // at full size that looks soft just gets the sharpening. The result is saved once as a picture and used in
  // place of the page until the chapter closes. Without WebGL nothing happens.
  const SOFT = 0.4;
  const Sharp = {
    gl: null, failed: false,
    toggle() {
      const on = !RS().sharpen;
      setR({ sharpen: on });
      if (R) on ? this.start(R) : this.stop(R, true);
      paintButtons();
      K.toast(on ? 'Sharpen on · small or soft pages get a cleaner copy' : 'Sharpen off');
    },
    start(a) {
      if (a.sh || !a.on) return;
      const sh = a.sh = { queue: [], done: new Set(), orig: new Map(), url: new Map(), busy: false };
      sh.io = new IntersectionObserver(es => {
        for (const e of es) if (e.isIntersecting) { const i = Number(e.target.dataset.i); if (!sh.queue.includes(i)) sh.queue.push(i); }
        if (sh.queue.length) pump(a);
      }, { root: a.pagesBox, rootMargin: '50% 0px 100% 0px' });
      a.strip.querySelectorAll('.pg').forEach(p => sh.io.observe(p));
      // pages of the next chapter joining underneath
      sh.mo = new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('pg')) sh.io.observe(n); });
      sh.mo.observe(a.strip, { childList: true });
    },
    stop(a, restore) {
      const sh = a.sh;
      if (!sh) return;
      a.sh = null;
      sh.io.disconnect(); sh.mo.disconnect(); sh.queue.length = 0;
      if (restore && a.on) {
        for (const [i, blob] of sh.orig) {
          if (a.opt.mode === 'strip') a.swapFile(i, blob);
          else if (a.imgs[i]?.src.startsWith('blob:')) { const s = a.imgs[i].dataset.src; a.imgs[i].src = /^https:\/\//.test(s) ? K.viaKoru(s) : s; }
        }
      }
      const urls = [...sh.url.values()];
      setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), restore ? 3000 : 0);
      sh.orig.clear(); sh.url.clear();
    }
  };
  X.sharp = Sharp;   // for checking
  async function pump(a) {
    const sh = a.sh;
    if (!sh || sh.busy) return;
    sh.busy = true;
    try {
      while (a.sh === sh && a.on && sh.queue.length) {
        sh.queue.sort((x, y) => Math.abs(x - a.s.page) - Math.abs(y - a.s.page));   // nearest first
        const i = sh.queue.shift();
        if (Math.abs(i - a.s.page) > 3) continue;
        if (sh.url.has(i)) { reapply(a, i); continue; }   // page mode: a page shown again
        if (sh.done.has(i)) continue;
        sh.done.add(i);
        await idle(); await still(a);
        if (a.sh !== sh) break;
        try { await sharpenPage(a, sh, i); } catch { /* the page stays as it was */ }
      }
    } finally { sh.busy = false; }
  }
  // wait until the pages aren't moving (nothing is listened to while you scroll: two reads of the position)
  async function still(a) {
    for (let t = 0; t < 200 && a.on; t++) {
      const y = a.pagesBox.scrollTop; await wait(180);
      if (Math.abs(a.pagesBox.scrollTop - y) < 2 && !Panels.raf) return;
    }
  }
  async function reapply(a, i) {
    if (!(await ready(a, i, 6000)) || !a.sh) return;
    const u = a.sh.url.get(i);
    if (u && a.imgs[i].src !== u) a.imgs[i].src = u;
  }
  async function sharpenPage(a, sh, i) {
    if (!(await ready(a, i)) || a.sh !== sh) return;
    const blob = await a.fileOf(i);
    const bm = await createImageBitmap(blob);
    try {
      const nw = bm.width, nh = bm.height;
      const shown = (a.opt.mode === 'strip' ? a.pg(i).clientWidth : a.imgs[i].clientWidth) * (window.devicePixelRatio || 1);
      const cap = K.info?.platform === 'android' ? 6e6 : 12e6;   // most pixels a sharpened page may have
      let s = nw < shown * 0.92 ? Math.min(2, shown / nw) : 1;
      if (nw * nh * s * s > cap) s = Math.sqrt(cap / (nw * nh));
      if (s < 1.08) s = 1;
      if (s === 1 && (nw * nh > cap || !looksSoft(bm))) return;
      const out = await render(bm, s, s > 1 ? 0.6 : 0.5, () => a.sh === sh && a.on);
      if (!out || a.sh !== sh || !a.on) return;
      await still(a);   // swapped in while the pages are at rest
      if (a.sh !== sh || !a.on) return;
      sh.orig.set(i, blob);
      if (a.opt.mode === 'strip') a.swapFile(i, out);
      else { const u = URL.createObjectURL(out); sh.url.set(i, u); if (a.st[i] === 'ready') a.imgs[i].src = u; }
    } finally { bm.close(); }
  }
  // soft = little fine detail compared with the detail at half size (checked on three small crops)
  function looksSoft(bm) {
    const S = Math.min(256, bm.width, bm.height) & ~1;
    if (S < 64) return false;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const cx = c.getContext('2d', { willReadFrequently: true });
    const lap = (L, n) => { let s = 0; for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) { const o = y * n + x; s += Math.abs(4 * L[o] - L[o - 1] - L[o + 1] - L[o - n] - L[o + n]); } return s / ((n - 2) * (n - 2)); };
    let best = null;
    for (const fy of [0.3, 0.5, 0.7]) {
      cx.drawImage(bm, (bm.width - S) >> 1, Math.max(0, Math.min(bm.height - S, Math.round(bm.height * fy - S / 2))), S, S, 0, 0, S, S);
      const d = cx.getImageData(0, 0, S, S).data, L = new Float32Array(S * S), H = S >> 1, L2 = new Float32Array(H * H);
      for (let p = 0; p < S * S; p++) L[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
      for (let y = 0; y < H; y++) for (let x = 0; x < H; x++) { const o = 2 * y * S + 2 * x; L2[y * H + x] = (L[o] + L[o + 1] + L[o + S] + L[o + S + 1]) / 4; }
      const full = lap(L, S), half = lap(L2, H);
      if (!best || half > best.half) best = { full, half };
    }
    c.width = c.height = 0;
    return best.half >= 4 && best.full / best.half < SOFT;
  }
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  // bicubic (Catmull-Rom) in 9 taps, using the card's own linear filtering for the middle weights
  const FS_UP = `precision highp float;uniform sampler2D t;uniform vec2 ts,scl;uniform float py0,sy0;
vec4 tx(vec2 p){return texture2D(t,p/ts);}
void main(){vec2 sp=vec2(gl_FragCoord.x/scl.x,(py0+gl_FragCoord.y)/scl.y-sy0);vec2 tc=floor(sp-0.5)+0.5;vec2 f=sp-tc;
vec2 w0=f*(-0.5+f*(1.0-0.5*f)),w1=1.0+f*f*(-2.5+1.5*f),w2=f*(0.5+f*(2.0-1.5*f)),w3=f*f*(-0.5+0.5*f),w12=w1+w2;
vec2 c0=tc-1.0,c3=tc+2.0,c12=tc+w2/w12;
vec4 r=tx(vec2(c0.x,c0.y))*w0.x*w0.y+tx(vec2(c12.x,c0.y))*w12.x*w0.y+tx(vec2(c3.x,c0.y))*w3.x*w0.y
+tx(vec2(c0.x,c12.y))*w0.x*w12.y+tx(c12)*w12.x*w12.y+tx(vec2(c3.x,c12.y))*w3.x*w12.y
+tx(vec2(c0.x,c3.y))*w0.x*w3.y+tx(vec2(c12.x,c3.y))*w12.x*w3.y+tx(vec2(c3.x,c3.y))*w3.x*w3.y;
gl_FragColor=vec4(clamp(r.rgb,0.0,1.0),1.0);}`;
  // contrast-adaptive sharpening (after AMD's CAS); also flips the rows so the canvas reads top-down
  const FS_CAS = `precision highp float;uniform sampler2D t;uniform vec2 ts;uniform float H,rowOff,k;
vec3 tx(vec2 p){return texture2D(t,p/ts).rgb;}
void main(){vec2 p=vec2(gl_FragCoord.x,rowOff+H-gl_FragCoord.y);
vec3 a=tx(p+vec2(0.0,-1.0)),b=tx(p+vec2(-1.0,0.0)),c=tx(p),d=tx(p+vec2(1.0,0.0)),e=tx(p+vec2(0.0,1.0));
vec3 mn=min(min(min(a,b),min(d,e)),c),mx=max(max(max(a,b),max(d,e)),c);
vec3 amp=sqrt(clamp(min(mn,1.0-mx)/max(mx,vec3(0.0001)),0.0,1.0));
vec3 w=amp*(-1.0/mix(8.0,5.0,k));
gl_FragColor=vec4(clamp((c+(a+b+d+e)*w)/(1.0+4.0*w),0.0,1.0),1.0);}`;
  function glInit() {
    if (Sharp.gl || Sharp.failed) return Sharp.gl;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const gl = c.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('no webgl');
      const prog = fs => {
        const p = gl.createProgram();
        for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
          const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
          gl.attachShader(p, s);
        }
        gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {}; for (const n of ['t', 'ts', 'scl', 'py0', 'sy0', 'H', 'rowOff', 'k']) u[n] = gl.getUniformLocation(p, n);
        return { p, u };
      };
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
      c.addEventListener('webglcontextlost', e => { e.preventDefault(); Sharp.gl = null; Sharp.failed = true; });
      Sharp.gl = { c, gl, up: prog(FS_UP), cas: prog(FS_CAS), src: tex(), mid: tex(), fb: gl.createFramebuffer(), midSize: '', max: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192) };
    } catch { Sharp.failed = true; }
    return Sharp.gl;
  }
  // the page is done in bands (so huge pages fit the card), each in its own idle moment
  async function render(bm, s, k, alive) {
    const G = glInit();
    if (!G) return null;
    const { gl, c } = G, nw = bm.width, nh = bm.height, W = Math.round(nw * s), Hh = Math.round(nh * s);
    if (W > G.max) return null;
    const sx = W / nw, sy = Hh / nh, B = Math.min(1024, G.max - 16), P = 4;
    const out = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, Hh) : Object.assign(document.createElement('canvas'), { width: W, height: Hh });
    const ox = out.getContext('2d', { alpha: false });
    for (let oy = 0; oy < Hh; oy += B) {
      await idle();
      if (!alive() || gl.isContextLost()) return null;
      const py0 = Math.max(0, oy - P), py1 = Math.min(Hh, oy + B + P), Hp = py1 - py0;
      const sy0 = Math.max(0, Math.floor(py0 / sy) - 3), sy1 = Math.min(nh, Math.ceil(py1 / sy) + 3), sh = sy1 - sy0;
      const band = await createImageBitmap(bm, 0, sy0, nw, sh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, G.src);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, band);
      band.close();
      if (c.width !== W) c.width = W;
      if (c.height !== Hp) c.height = Hp;
      if (s > 1) {
        gl.bindTexture(gl.TEXTURE_2D, G.mid);
        if (G.midSize !== W + 'x' + Hp) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, Hp, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); G.midSize = W + 'x' + Hp; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, G.mid, 0);
        gl.viewport(0, 0, W, Hp);
        gl.bindTexture(gl.TEXTURE_2D, G.src);
        const u = G.up.u; gl.useProgram(G.up.p);
        gl.uniform1i(u.t, 0); gl.uniform2f(u.ts, nw, sh); gl.uniform2f(u.scl, sx, sy); gl.uniform1f(u.py0, py0); gl.uniform1f(u.sy0, sy0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, G.mid);
      }
      gl.viewport(0, 0, W, Hp);
      const u = G.cas.u; gl.useProgram(G.cas.p);
      gl.uniform1i(u.t, 0);
      if (s > 1) { gl.uniform2f(u.ts, W, Hp); gl.uniform1f(u.rowOff, 0); } else { gl.uniform2f(u.ts, nw, sh); gl.uniform1f(u.rowOff, py0 - sy0); }
      gl.uniform1f(u.H, Hp); gl.uniform1f(u.k, k);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const bh = Math.min(B, Hh - oy);
      ox.drawImage(c, 0, oy - py0, W, bh, 0, oy, W, bh);
    }
    // let the card's memory go between pages
    c.width = c.height = 1;
    gl.bindTexture(gl.TEXTURE_2D, G.mid); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); G.midSize = '';
    gl.bindTexture(gl.TEXTURE_2D, G.src); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    if (!alive()) return null;
    await idle();
    // saved as a picture on a background thread (reading back a big canvas here would hold up a frame)
    if (out.transferToImageBitmap) return encode(out.transferToImageBitmap(), W);
    const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.93));
    out.width = out.height = 0;
    return blob;
  }
  let enc = null, encSeq = 0;
  const encWaits = new Map();
  const encode = (bm, w) => new Promise((res, rej) => {
    if (!enc) {
      enc = new Worker('js/slicer.js');   // its 'thumb' job: draw a picture at a width and save it
      enc.onmessage = e => { const p = encWaits.get(e.data.id); if (!p) return; encWaits.delete(e.data.id); e.data.type === 'error' ? p.rej(new Error(e.data.error)) : p.res(e.data.blob); };
    }
    const id = 'x' + (++encSeq);
    encWaits.set(id, { res, rej });
    enc.postMessage({ type: 'thumb', id, blob: bm, w }, [bm]);
  });

  // ---------- ambient sound ----------
  // Every sound is made once with the Web Audio API (no audio files): noise, filters and short generated
  // clicks and notes are rendered ahead into a 14 to 24 second clip, whose end is blended into its start so it
  // loops without a seam. Playing it is then one looping clip and a volume, which costs almost nothing.
  const SOUNDS = [['off', 'Off'], ['rain', 'Rain'], ['wind', 'Night wind'], ['cafe', 'Café'], ['fire', 'Fireplace'], ['lofi', 'Lo-fi chords']];
  const SR = 32000;
  const Sound = {
    ctx: null, master: null, bufs: {}, cur: 'off', node: null, gen: 0, sleepT: 0,
    vol: () => { const v = Math.max(0, Math.min(100, Number(RS().soundVol ?? 40))) / 100; return v * v; },
    setVol() { if (this.master) this.master.gain.setTargetAtTime(this.vol(), this.ctx.currentTime, 0.05); },
    async play(name) {
      if (name === this.cur && this.node) return;
      this.fadeOut();
      this.cur = name || 'off'; paintButtons();
      if (this.cur === 'off') return;
      const my = ++this.gen;
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          this.ctx = new AC({ latencyHint: 'playback' });
          this.master = this.ctx.createGain(); this.master.gain.value = this.vol(); this.master.connect(this.ctx.destination);
        }
        clearTimeout(this.sleepT);
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        const buf = await (this.bufs[name] ||= make(name).catch(e => { delete this.bufs[name]; throw e; }));
        if (my !== this.gen || !this.ctx) return;
        const src = this.ctx.createBufferSource(), g = this.ctx.createGain(), t = this.ctx.currentTime;
        src.buffer = buf; src.loop = true;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 1.8);
        src.connect(g); g.connect(this.master); src.start();
        this.node = { src, g };
      } catch { if (my === this.gen) { this.cur = 'off'; paintButtons(); } }
    },
    fadeOut() {
      this.gen++;
      const n = this.node; this.node = null;
      if (!n) return;
      const t = this.ctx.currentTime;
      n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(n.g.gain.value, t); n.g.gain.linearRampToValueAtTime(0, t + 0.9);
      n.src.stop(t + 1);
    },
    stop() {
      this.fadeOut(); this.cur = 'off'; paintButtons();
      clearTimeout(this.sleepT);
      // the audio device rests once the fade is over
      this.sleepT = setTimeout(() => { if (!this.node && this.ctx?.state === 'running') this.ctx.suspend().catch(() => {}); }, 1500);
    },
    pick(name) { setR({ sound: name }); name === 'off' ? this.stop() : this.play(name); }
  };
  X.sound = Sound;   // for checking

  async function make(name) {
    const spec = RECIPES[name];
    const L = spec.len, tail = spec.tail, oc = new OfflineAudioContext(2, Math.ceil((L + tail) * SR), SR);
    oc.nz = {};
    for (const c of spec.uses) oc.nz[c] = await noise(oc, L + tail, c);   // made in small steps, between frames
    spec.build(oc, L);
    const r = await oc.startRendering(), n = Math.round(L * SR), x = Math.round(tail * SR);
    const out = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: SR });
    for (let ch = 0; ch < 2; ch++) {
      const d = r.getChannelData(ch), o = out.getChannelData(ch);
      o.set(d.subarray(0, n));
      if (spec.add) for (let i = 0; i < x; i++) o[i] += d[n + i];   // music: the last notes ring on into the start
      else for (let i = 0; i < x; i++) { const f = i / x; o[i] = d[i] * Math.sqrt(f) + d[n + i] * Math.sqrt(1 - f); }   // textures: blended seam
    }
    // every sound about as loud as the others, so the volume slider means the same for each
    let sum = 0, peak = 0;
    for (let ch = 0; ch < 2; ch++) { const o = out.getChannelData(ch); for (let i = 0; i < n; i += 4) { sum += o[i] * o[i]; peak = Math.max(peak, Math.abs(o[i])); } }
    const k = Math.min(0.09 / Math.max(1e-4, Math.sqrt(sum / (n / 2))), 0.95 / Math.max(1e-4, peak));
    for (let ch = 0; ch < 2; ch++) { const o = out.getChannelData(ch); for (let i = 0; i < n; i++) o[i] *= k; }
    return out;
  }
  // ---- building blocks (all written straight into buffers, once) ----
  const rnd = () => Math.random() * 2 - 1;
  async function noise(oc, secs, color) {
    const b = oc.createBuffer(2, Math.ceil(secs * SR), SR);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, last = 0;
      for (let i = 0; i < d.length; i++) {
        if (i % (SR * 3) === 0 && i) await idle();
        const w = rnd();
        if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
        else if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else d[i] = w * 0.5;
      }
    }
    return b;
  }
  const nz = (oc, color) => oc.nz[color];
  // off: start partway into the clip (and go round), so one noise clip can be several different-sounding sources
  const play = (oc, buf, at = 0, until, off) => { const s = oc.createBufferSource(); s.buffer = buf; if (off != null) { s.loop = true; s.start(at, off); } else s.start(at); if (until) s.stop(until); return s; };
  const filt = (oc, type, f, q = 0.7) => { const n = oc.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
  const gain = (oc, v) => { const g = oc.createGain(); g.gain.value = v; return g; };
  const chain = (...ns) => { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; };
  const lfo = (oc, hz, depth, param) => { const o = oc.createOscillator(), g = gain(oc, depth); o.frequency.value = hz; o.connect(g); g.connect(param); o.start(); return o; };
  // short events (drops, crackles, clinks, chirps) drawn into a stereo buffer by a function per event
  function events(oc, secs, list) {
    const b = oc.createBuffer(2, Math.ceil(secs * SR), SR);
    for (const ev of list) {
      const d = b.getChannelData(ev.ch ?? (Math.random() < 0.5 ? 0 : 1)), at = Math.floor(ev.t * SR), len = Math.floor(ev.len * SR);
      for (let i = 0; i < len && at + i < d.length; i++) d[at + i] += ev.f(i / SR, i / len);
    }
    return b;
  }
  const poisson = (rate, secs) => { const out = []; let t = 0; for (;;) { t += -Math.log(1 - Math.random()) / rate; if (t >= secs) return out; out.push(t); } };
  function reverb(oc, secs) {
    const b = oc.createBuffer(2, Math.ceil(secs * SR), SR);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = rnd() * Math.pow(1 - i / d.length, 3); }
    const c = oc.createConvolver(); c.buffer = b; return c;
  }
  const RECIPES = {
    rain: { len: 20, tail: 2, uses: ['pink', 'brown', 'white'], build(oc, L) {
      const T = L + 2, out = oc.destination;
      chain(play(oc, nz(oc, 'pink')), filt(oc, 'highpass', 450), filt(oc, 'lowpass', 7500), (() => { const g = gain(oc, 0.42); lfo(oc, 0.05, 0.08, g.gain); return g; })(), out);
      chain(play(oc, nz(oc, 'brown')), filt(oc, 'lowpass', 280), gain(oc, 0.35), out);
      chain(play(oc, nz(oc, 'white')), filt(oc, 'highpass', 5000), gain(oc, 0.05), out);
      const drops = poisson(30, T).map(t => { const amp = 0.05 + Math.pow(Math.random(), 3) * 0.5, k = 0.002 + Math.random() * 0.006; return { t, len: k * 5, f: (s) => rnd() * amp * Math.exp(-s / k) }; });
      chain(play(oc, events(oc, T, drops)), filt(oc, 'bandpass', 2600, 0.9), gain(oc, 0.9), out);
    } },
    wind: { len: 24, tail: 3, uses: ['pink', 'brown'], build(oc, L) {
      const T = L + 3, out = oc.destination;
      const bp = filt(oc, 'bandpass', 420, 0.8); lfo(oc, 0.055, 260, bp.frequency);
      const g = gain(oc, 0.75); lfo(oc, 0.042, 0.35, g.gain);
      chain(play(oc, nz(oc, 'brown')), bp, g, out);
      const wh = filt(oc, 'bandpass', 950, 9); lfo(oc, 0.083, 320, wh.frequency);
      const wg = gain(oc, 0.07); lfo(oc, 0.031, 0.06, wg.gain);
      chain(play(oc, nz(oc, 'pink')), wh, wg, out);
      // a few crickets far away
      const chirps = [];
      for (const ch of [0, 1]) for (let t = Math.random(); t < L - 1; t += 0.9 + Math.random() * 0.8) for (let p = 0; p < 3; p++) {
        const f = ch ? 4520 : 4380;
        chirps.push({ ch, t: t + p * 0.045, len: 0.022, f: (s, x) => Math.sin(2 * Math.PI * f * s) * Math.sin(Math.PI * x) * 0.022 });
      }
      chain(play(oc, events(oc, T, chirps)), gain(oc, 1), out);
    } },
    cafe: { len: 24, tail: 3, uses: ['pink', 'brown'], build(oc, L) {
      const T = L + 3, out = oc.destination, room = reverb(oc, 0.9), wet = gain(oc, 0.3), bus = gain(oc, 1);
      bus.connect(out); bus.connect(room); room.connect(wet); wet.connect(out);
      chain(play(oc, nz(oc, 'brown')), filt(oc, 'lowpass', 260), gain(oc, 0.22), out);
      // voices: noise shaped like speech (a formant band, syllables, phrases and pauses), each somewhere in the room
      for (let v = 0; v < 6; v++) {
        const ER = 4000, env = oc.createBuffer(1, Math.ceil(T * ER), ER), d = env.getChannelData(0);   // a slow shape: a low rate is plenty
        let t = Math.random() * 2;
        while (t < T) {
          const ph = 0.8 + Math.random() * 2.2, rate = 3.5 + Math.random() * 2.5, a = 0.5 + Math.random() * 0.5;
          for (let i = Math.floor(t * ER); i < Math.min(d.length, (t + ph) * ER); i++) { const s = i / ER - t; d[i] = a * Math.pow(Math.max(0, Math.sin(Math.PI * rate * s)), 2) * Math.min(1, s * 4, (ph - s) * 4); }
          t += ph + 0.4 + Math.random() * 2.5;
        }
        const g = gain(oc, 0), pan = oc.createStereoPanner(); pan.pan.value = rnd() * 0.8;
        play(oc, env).connect(g.gain);
        chain(play(oc, nz(oc, 'pink'), 0, 0, Math.random() * T), filt(oc, 'bandpass', 380 + Math.random() * 900, 1.3), filt(oc, 'lowpass', 2600), g, gain(oc, 0.5), pan, bus);
      }
      // cups and spoons
      const clinks = poisson(0.35, L - 1).map(t => { const f = 2100 + Math.random() * 1800, a = 0.025 + Math.random() * 0.04, k = 0.08 + Math.random() * 0.2;
        return { t, len: k * 5, f: s => (Math.sin(2 * Math.PI * f * s) + 0.5 * Math.sin(2 * Math.PI * f * 2.76 * s)) * a * Math.exp(-s / k) }; });
      chain(play(oc, events(oc, T, clinks)), bus);
    } },
    fire: { len: 20, tail: 2, uses: ['pink', 'brown'], build(oc, L) {
      const T = L + 2, out = oc.destination;
      const g = gain(oc, 0.6); lfo(oc, 0.23, 0.15, g.gain); lfo(oc, 0.07, 0.12, g.gain);
      chain(play(oc, nz(oc, 'brown')), filt(oc, 'lowpass', 520), g, out);
      chain(play(oc, nz(oc, 'pink')), filt(oc, 'bandpass', 1800, 0.6), gain(oc, 0.025), out);
      const crack = [];
      for (const t0 of poisson(2.2, T)) for (const t of poisson(28, 0.25)) { const a = 0.04 + Math.pow(Math.random(), 4) * 0.8, k = 0.0006 + Math.random() * 0.002; crack.push({ t: t0 + t, len: k * 6, f: s => rnd() * a * Math.exp(-s / k) }); }
      for (const t of poisson(5, T)) { const a = 0.02 + Math.random() * 0.06, k = 0.0008; crack.push({ t, len: k * 6, f: s => rnd() * a * Math.exp(-s / k) }); }
      chain(play(oc, events(oc, T, crack)), filt(oc, 'highpass', 900), gain(oc, 0.6), out);
      const pops = poisson(0.25, T).map(t => { const a = 0.2 + Math.random() * 0.3; return { t, len: 0.06, f: s => rnd() * a * Math.exp(-s / 0.012) }; });
      chain(play(oc, events(oc, T, pops)), filt(oc, 'lowpass', 900), gain(oc, 0.9), out);
    } },
    lofi: { len: 4 * 4 * 60 / 70, tail: 3, add: true, uses: ['pink'], build(oc, L) {
      const out = oc.destination, beat = 60 / 70, hz = m => 440 * Math.pow(2, (m - 69) / 12);
      const tone = filt(oc, 'lowpass', 2100, 0.5), room = reverb(oc, 2.2), wet = gain(oc, 0.22), dry = gain(oc, 0.8);
      tone.connect(dry); dry.connect(out); tone.connect(room); room.connect(wet); wet.connect(out);
      const wow = oc.createOscillator(); wow.frequency.value = 0.45; const wowG = gain(oc, 7); wow.connect(wowG); wow.start();   // tape wobble, in cents
      // Dm9, G13, Cmaj9, Am9: [bass, chord notes]
      const prog = [[38, [53, 57, 60, 64]], [43, [53, 57, 59, 64]], [36, [52, 55, 59, 62]], [45, [55, 59, 60, 64]]];
      const note = (m, at, dur, vel, bass) => {
        const g = gain(oc, 0); g.connect(tone);
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vel, at + (bass ? 0.03 : 0.012));
        g.gain.setTargetAtTime(vel * 0.35, at + 0.05, 0.6); g.gain.setTargetAtTime(0, at + dur, 0.35);
        const parts = bass ? [[1, 1, 'sine']] : [[1, 1, 'sine'], [2.002, 0.18, 'sine'], [1, 0.12, 'triangle']];
        for (const [mul, a, type] of parts) {
          const o = oc.createOscillator(), og = gain(oc, a); o.type = type; o.frequency.value = hz(m) * mul; wowG.connect(o.detune);
          o.connect(og); og.connect(g); o.start(at); o.stop(at + dur + 2.5);
        }
      };
      prog.forEach(([b, ch], bar) => {
        const t = bar * 4 * beat;
        ch.forEach((m, n) => { note(m, t + n * 0.028, 3.6 * beat, 0.06, false); note(m, t + 2.5 * beat + n * 0.02, 1.3 * beat, 0.03, false); });
        note(b, t, 2.4 * beat, 0.16, true); note(b + 12, t + 2.5 * beat, 1.3 * beat, 0.08, true);
      });
      // soft drums: kick on 1 and 3, a brushed snare on 2 and 4, quiet swung hats
      const kick = oc.createBuffer(1, Math.ceil(0.35 * SR), SR), kd = kick.getChannelData(0);
      for (let i = 0, ph = 0; i < kd.length; i++) { const s = i / SR; ph += 2 * Math.PI * (45 + 70 * Math.exp(-s / 0.03)) / SR; kd[i] = Math.sin(ph) * Math.exp(-s / 0.12) * 0.32; }
      const snare = oc.createBuffer(1, Math.ceil(0.25 * SR), SR), sd = snare.getChannelData(0);
      for (let i = 0; i < sd.length; i++) sd[i] = rnd() * Math.exp(-i / SR / 0.06) * 0.1;
      const hat = oc.createBuffer(1, Math.ceil(0.05 * SR), SR), hd = hat.getChannelData(0);
      for (let i = 0; i < hd.length; i++) hd[i] = rnd() * Math.exp(-i / SR / 0.012) * 0.05;
      const snF = filt(oc, 'bandpass', 1900, 0.7), hatF = filt(oc, 'highpass', 7000); snF.connect(dry); hatF.connect(dry);
      for (let b = 0; b < 16; b++) {
        const t = b * beat;
        if (b % 2 === 0) play(oc, kick, t).connect(dry); else play(oc, snare, t).connect(snF);
        play(oc, hat, t).connect(hatF); play(oc, hat, t + beat * 0.6).connect(hatF);
      }
      // vinyl: a little hiss and crackle, only inside the loop so the seam stays clean
      chain(play(oc, nz(oc, 'pink'), 0, L), filt(oc, 'lowpass', 5000), gain(oc, 0.014), out);
      const cr = poisson(4, L - 0.05).map(t => { const a = 0.01 + Math.pow(Math.random(), 3) * 0.08; return { t, len: 0.004, f: s => rnd() * a * Math.exp(-s / 0.0007) }; });
      chain(play(oc, events(oc, L, cr), 0, L), filt(oc, 'highpass', 1500), out);
    } }
  };

  let soundBox = null, soundOff = null;
  const soundRow = () => {
    const s = el('select.sel-in', { title: 'Ambient sound' }, ...SOUNDS.map(([v, l]) => el('option', { value: v, text: l })));
    s.value = Sound.cur !== 'off' ? Sound.cur : RS().sound || 'off';
    s.onchange = () => { Sound.pick(s.value); };
    return el('div.ctl', el('div.lab', 'Ambient sound', el('small', { text: 'Rain, wind, a café, a fire or calm chords' })), s);
  };
  const volRow = () => {
    const v = el('span.val'), r = el('input', { type: 'range', min: 0, max: 100, step: 1, value: RS().soundVol ?? 40 });
    const paint = () => { r.style.setProperty('--p', r.value + '%'); v.textContent = r.value + '%'; };
    paint();
    r.oninput = () => { paint(); K.data.settings.reader = { ...RS(), soundVol: Number(r.value) }; Sound.setVol(); };
    r.onchange = () => setR({ soundVol: Number(r.value) });
    return el('div.ctl', el('div.lab', { text: 'Volume' }), r, v);
  };
  function soundPop(btn) {
    if (soundBox) { closeSoundPop(); return; }
    const a = R;
    if (!a) return;
    const list = el('div.rx-slist');
    const paint = () => list.replaceChildren(...SOUNDS.map(([v, l]) => el('button.mi' + (Sound.cur === v ? '.on' : ''), { onclick: () => { Sound.pick(v); paint(); } },
      Sound.cur === v ? icon('check') : el('span.rx-sp'), l)));
    paint();
    soundBox = el('div.rx-sound.glass', el('div.rx-sh', el('b', { text: 'Ambient sound' }), el('small.muted', { text: 'Made on the spot, no files' })), list, volRow());
    const bar = btn.closest('.rbar') || btn, br = btn.getBoundingClientRect(), xr = a.box.getBoundingClientRect();
    soundBox.style.top = Math.round(bar.offsetTop + bar.offsetHeight + 8) + 'px';   // the bar's place without its slide
    soundBox.style.right = Math.max(8, Math.round(xr.right - br.right - 60)) + 'px';
    a.box.append(soundBox);
    soundOff = e => { if (!soundBox?.contains(e.target) && !btn.contains(e.target)) closeSoundPop(); };
    setTimeout(() => document.addEventListener('pointerdown', soundOff, true), 0);
  }
  function closeSoundPop() {
    if (!soundBox) return;
    const b = soundBox; soundBox = null; b.remove();
    document.removeEventListener('pointerdown', soundOff, true);
  }

  // ---------- "Previously on…" ----------
  // On a series page you haven't read for 3 days or more: the chapter you were on, the last few pages you'd
  // already read (cut off at your reading spot, so nothing new is shown), your rating and note, and a button
  // to carry on. No AI: it's all from your own history.
  X.recapCard = (s, chapters) => {
    const provider = s.provider, slug = s.slug, key = K.key(provider, slug), h = K.data.history[key];
    if (!h?.chapterSlug || !h.at || Date.now() - h.at < 3 * 864e5 || K.incognito()) return null;
    try { if (sessionStorage.getItem('koru-recap-x:' + key)) return null; } catch {}
    const idx = chapters.findIndex(c => c.slug === h.chapterSlug), ch = chapters[idx];
    const name = short(h.chapterName || ch?.name || h.chapterSlug.replace(/-/g, ' '));
    const next = h.done && idx > 0 ? chapters.slice(0, idx).reverse().find(c => !c.locked) : null;
    const days = Math.floor((Date.now() - h.at) / 864e5);
    const ago = days >= 60 ? 'a while ago' : days + ' days ago';
    const n = K.libx?.noteOf?.(provider, slug);
    const go = (chSlug, q = '') => K.go(`/read/${provider}/${encodeURIComponent(slug)}/${encodeURIComponent(chSlug)}${q}`);
    const thumbs = el('div.rx-rthumbs', ...Array.from({ length: 4 }, () => el('div.rx-rt.skel')));
    const card = el('div.rx-recap.glass',
      el('div.rx-rhead', el('small.rx-rk', { text: 'Previously on…' }),
        el('button.btn.small.icon', { title: 'Hide', onclick: () => { try { sessionStorage.setItem('koru-recap-x:' + key, '1'); } catch {} card.remove(); } }, icon('x'))),
      el('p.rx-rwhere', { text: h.done ? `You finished ${name}, ${ago}.` : `You stopped on page ${(h.page | 0) + 1}${h.total ? ' of ' + h.total : ''} of ${name}, ${ago}.` }),
      thumbs,
      n?.rating || n?.note ? el('div.rx-rnote', n.rating ? el('b.rx-rstars', { text: '★'.repeat(n.rating) + '☆'.repeat(5 - n.rating), title: `Your rating: ${n.rating} / 5` }) : null,
        n.note ? el('span.rx-rq', { text: n.note.length > 220 ? n.note.slice(0, 220).trim() + '…' : n.note }) : null) : null,
      el('div.row', h.done
        ? (next ? el('button.btn.primary', { onclick: () => go(next.slug) }, icon('play'), 'Read ' + short(next.name)) : el('span.muted', { text: 'No newer free chapter yet.' }))
        : el('button.btn.primary', { onclick: () => go(h.chapterSlug) }, icon('play'), 'Continue ' + name)));
    fillThumbs(thumbs, s, h, go).catch(() => thumbs.remove());
    return card;
  };
  async function fillThumbs(box, s, h, go) {
    const id = `${s.provider}:${s.slug}:${h.chapterSlug}`;
    await wait(0);   // the card is on the page by now
    const pages = K.localPages(id) || await K.providers[s.provider].pages(s.slug, h.chapterSlug);
    if (!pages?.length) throw new Error('no pages');
    const paged = RS().mode === 'paged';
    const last = h.done ? pages.length - 1 : Math.min(pages.length - 1, h.page | 0);
    // how much of each page you'd seen: all of it, except the page you stopped on (only down to your spot)
    const seen = j => (h.done || j < last || paged ? 1 : Math.max(0, Math.min(1, Number(h.off) || 0)));
    const list = [];
    for (let j = last; j >= 0 && list.length < 4; j--) if (seen(j) >= 0.08) list.unshift(j);
    if (!list.length) throw new Error('nothing read yet');
    box.replaceChildren(...list.map(() => el('div.rx-rt.skel')));
    for (let n = 0; n < list.length; n++) {
      const j = list[n], tile = box.children[n];
      if (!box.isConnected) return;
      try {
        const u = pages[j].url, r = await fetch(/^https:\/\//.test(u) ? K.viaKoru(u) : u);
        if (!r.ok) throw new Error();
        const full = await createImageBitmap(await r.blob());
        const nw = full.width, nh = full.height, vb = seen(j) * nh, cropH = Math.max(1, Math.min(vb, nw * 4 / 3)), sy = Math.max(0, vb - cropH);
        const bm = await createImageBitmap(full, 0, Math.round(sy), nw, Math.round(cropH), { resizeWidth: 240, resizeQuality: 'medium' });
        full.close();
        const c = el('canvas', { width: bm.width, height: bm.height });
        c.getContext('2d').drawImage(bm, 0, 0); bm.close();
        const t = el('button.rx-rt', { title: `Page ${j + 1}`, onclick: () => go(h.chapterSlug, `?page=${j}&off=${j === last && !h.done ? Number(h.off) || 0 : 0}`) }, c, el('small', { text: String(j + 1) }));
        tile.replaceWith(t);
      } catch { tile.remove(); }
    }
    if (!box.children.length) box.remove();
  }
})();
