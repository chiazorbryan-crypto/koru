// Koru on Android. The same page runs inside the Android app's WebView, which gives it window.KoruNative.
// This file fills the few gaps between that WebView and the desktop app; on a PC it does nothing.
//  - Request bodies: the WebView can't pass a POST/PUT body to the app, so each one is handed over first and
//    the request carries its id (X-Koru-Body).
//  - The phone's back button: closes what's on top (a menu, a sheet, the reader), then goes back a page.
//  - Saving files (backups, Wrapped pictures, .cbz exports) into Downloads/Koru.
//  - Zen mode hides the status and navigation bars.
//  - Smooth on any phone: a quick check of the processor, memory and graphics on start picks light mode for
//    slower phones (the same light mode as on a PC without a graphics card). Settings → Graphics can override it.
//  - A phone-first frame (the second half of this file, with android.css): a bottom navigation bar with a More
//    sheet, a top app bar whose large title collapses as you scroll, bottom sheets for menus, long-press instead
//    of right-click, pull to refresh, Settings as pages, ripples, haptics, the share sheet and system bars in the
//    theme's colours.
'use strict';
(function () {
  const N = window.KoruNative;
  if (!N) return;
  const html = document.documentElement;
  html.classList.add('android');

  // ---------- requests to Koru's background side ----------
  const realFetch = window.fetch.bind(window);
  const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async function (input, init) {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let u; try { u = new URL(href, location.href); } catch { return realFetch(input, init); }
    if (u.host !== location.host || !u.pathname.startsWith('/k/')) return realFetch(input, init);
    if (u.pathname === '/k/fullscreen') {
      let on = false; try { on = !!JSON.parse(init?.body || '{}').on; } catch {}
      N.immersive(on);
      return json({ ok: true });
    }
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (init && init.body != null && method !== 'GET' && method !== 'HEAD') {
      const body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const headers = new Headers(init.headers || {});
      headers.set('X-Koru-Body', N.stash(body));
      init = { ...init, headers };
      delete init.body;
    }
    return realFetch(input, init);
  };

  // ---------- back button ----------
  const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  window.KoruBack = () => {
    const rset = document.querySelector('.reader .rset');
    if (rset) { rset.remove(); return true; }
    if (K.androidUI?.closeSheet()) return true;   // the More sheet (below)
    if (document.querySelector('.menu:not(.out), .lx-sheetwrap:not(.out), .lx-pop:not(.out), .reader')) { esc(); return true; }
    if (K.androidUI?.backInPage()) return true;   // chapter selection, a Settings page
    if (K.androidUI?.backToLibrary()) return true;
    const route = location.hash.slice(1) || '/library';
    if (route === '/library' || route === '/') return false;   // at home: leave the app
    if (history.length > 1) history.back(); else K.go('/library');
    return true;
  };

  // ---------- saving files ----------
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  document.addEventListener('click', async e => {
    const a = e.target?.closest?.('a[download]');
    if (!a || !a.href) return;
    e.preventDefault();
    const name = a.getAttribute('download') || 'Koru file';
    try {
      const u = new URL(a.href, location.href);
      if (u.protocol === 'blob:' || u.protocol === 'data:') {
        const blob = await (await realFetch(a.href)).blob();
        N.saveFile(name, blob.type || 'application/octet-stream', await b64(blob));
      } else if (u.host === location.host) {
        K.toast('Saving ' + name + '…');
        N.saveKoru(u.pathname + u.search, name);
      }
    } catch (err) { K.toast('Couldn\'t save the file: ' + err.message, 'error'); }
  }, true);

  // ---------- smooth on any phone ----------
  // 'soft' turns on light mode (when it's set to Auto) and keeps looping animations off, as on a PC without a
  // graphics card. Phones with a software-drawn screen, few cores, little memory or a slow processor get it.
  K.androidCheck = function () {
    const out = { cores: 0, memMb: 0, gpu: '', cpuMs: 0 };
    try { out.cores = N.cores(); out.memMb = N.memoryMb(); } catch {}
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '') : 'none';
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { out.gpu = 'none'; }
    // a fixed bit of work, the best of three (so a busy moment doesn't count)
    let best = 1e9;
    for (let r = 0; r < 3; r++) {
      const t = performance.now(); let x = 0;
      for (let i = 1; i < 400000; i++) x += Math.sqrt(i) * Math.sin(i);
      best = Math.min(best, performance.now() - t); if (x === 42) best++;
    }
    out.cpuMs = Math.round(best * 10) / 10;
    out.noGpu = out.gpu === 'none' || /swiftshader|llvmpipe|software|softpipe/i.test(out.gpu);
    out.weak = out.noGpu || (out.cores && out.cores <= 4) || (out.memMb && out.memMb < 3000) || out.cpuMs > 18;
    out.mode = out.weak ? 'soft' : 'gpu';
    try { localStorage.setItem('koru-android-check', JSON.stringify({ ...out, at: Date.now() })); } catch {}
    return out;
  };
  // the stored result is used right away (core.js reads it), and the check runs again a little after start
  try { const c = JSON.parse(localStorage.getItem('koru-android-check') || 'null'); if (c?.mode) K.applyLite(c.mode); } catch {}
  document.addEventListener('koru-ready', () => setTimeout(() => {
    const c = K.androidCheck();
    K.applyLite(c.mode);
  }, 1500));
})();

// ---------- a phone-first frame ----------
// Everything here only touches the page on Android (the WebView gives window.KoruNative). A PC never runs it.
// (localStorage 'koru-android-ui' = '1' turns it on in a desktop test window, to try the phone layout there.)
(function () {
  let preview = false; try { preview = !window.KoruNative && localStorage.getItem('koru-android-ui') === '1'; } catch {}
  if (!window.KoruNative && !preview) return;
  const N = window.KoruNative || {};
  const html = document.documentElement;
  const { el, icon } = K;
  html.classList.add('android');
  html.dataset.platform = 'android';
  document.head.append(el('link', { rel: 'stylesheet', href: 'android.css' }));
  const buzz = kind => { try { N.haptic?.(kind); } catch {} };
  const main = document.getElementById('main');
  // Covers are about 112px wide in a phone's three columns (the PC's cards are 160–220px), so their thumbnails are
  // made that size: a third of the pixels to decode, upload and keep in memory. The series page poster stays sharp.
  const img = K.img;
  K.img = (src, alt, cls, cssW = 220) => img(src, alt, cls, cssW >= 300 ? 170 : Math.min(cssW, 124));
  const PRIMARY = ['library', 'explore', 'search', 'downloads'];
  const HIDDEN = ['music'];   // not on Android
  const routeName = (h = location.hash) => (String(h).replace(/^#\/?/, '').split(/[/?]/)[0] || 'library');
  const navIds = () => [...document.querySelectorAll('.sidebar .nav-btn')].map(b => b.dataset.nav);
  const isTop = name => name === 'library' || navIds().includes(name);
  const curView = () => { const v = main.querySelectorAll(':scope > .view:not(.leave)'); return v[v.length - 1] || null; };

  // ---------- motion: on unless Koru's animations are off, transitions are "none" or the phone asks for less ----------
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const noGpu = () => { try { return !!JSON.parse(localStorage.getItem('koru-android-check') || 'null')?.noGpu; } catch { return false; } };
  function paintMotion() {
    const on = !html.classList.contains('no-anim') && html.dataset.transition !== 'none' && (!reduce.matches || html.classList.contains('force-motion')) && !noGpu();
    html.classList.toggle('an-motion', on);
  }
  reduce.addEventListener?.('change', paintMotion);

  // ---------- the system bars take the colours of the bars under them ----------
  const probe = el('i', { style: { position: 'fixed', width: '0', height: '0', visibility: 'hidden', pointerEvents: 'none' } });
  function rgb(expr, host) {
    (host || document.body).append(probe);
    probe.style.backgroundColor = ''; probe.style.backgroundColor = expr;
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    let m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
    m = c.match(/color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+))?/);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] == null ? 1 : +m[4]];
    return null;
  }
  const over = (a, b) => a && b ? [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1) : (a || b);
  const dim = (c, k) => c && c.map((x, i) => i < 3 ? x * (1 - k) : x);
  const hex = c => '#' + c.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  let barsT = 0, lastBars = '';
  // Reading a colour back makes the page work out its styles, so the theme's few colours are read once per theme
  // (and a series page's tint once per page), never while scrolling.
  let pal = null, palKey = '';
  function palette() {
    const key = (html.getAttribute('style') || '') + '|' + html.classList.contains('light') + html.classList.contains('plain');
    if (pal && key === palKey) return pal;
    palKey = key;
    const bg = rgb('var(--bg)') || [7, 8, 26, 1];
    pal = { bg, bar: over(rgb('var(--an-bar)'), bg), c1: over(rgb('var(--an-c1)'), bg), reader: over(rgb('var(--readerBg)'), bg) };
    saveTheme(bg);
    return pal;
  }
  // The app keeps the theme's key colours, so its splash (shown before this page loads) draws in them next time.
  // Sent a moment after the theme settles, so a look being tried out isn't saved.
  let themeT = 0;
  function saveTheme(bg) {
    if (!N.setTheme) return;
    const solid = c => c ? hex(c) : null;   // see-through colours count as solid: the splash wants plain ones
    const t = { bg: hex(bg), bg2: solid(over(rgb('var(--bg2)'), bg)), accent: solid(rgb('var(--accent-solid)')), text: solid(rgb('var(--text)')), light: html.classList.contains('light') };
    clearTimeout(themeT);
    themeT = setTimeout(() => { try { N.setTheme(JSON.stringify(t)); } catch {} }, 1500);
  }
  function heroTint(v, hero) {
    if (v._anTint && v._anTintKey === palKey) return v._anTint;
    v._anTintKey = palKey;
    return (v._anTint = over(rgb('color-mix(in srgb, var(--accent-solid) 22%, var(--bg))', hero), pal.bg));
  }
  function paintBars() {
    barsT = 0;
    if (!N.setBars) return;
    const p = palette();
    let topC, botC;
    if (html.classList.contains('reading')) topC = botC = p.reader;
    else {
      const v = curView(), hero = v?.querySelector('.hero');
      topC = top.classList.contains('an-lifted') ? p.bar : hero ? heroTint(v, hero) : p.bg;
      botC = html.classList.contains('an-nonav') || html.classList.contains('an-kb') ? p.bg : p.bar;
      if (document.querySelector('.an-scrim:not(.an-out), .lx-sheetwrap:not(.out)')) {
        topC = dim(topC, .42);
        botC = p.c1;   // the sheet reaches the bottom edge
      }
    }
    const key = hex(topC) + hex(botC);
    if (key === lastBars) return;
    lastBars = key;
    try { N.setBars(hex(topC), hex(botC)); } catch {}
  }
  const bars = () => { if (!barsT) barsT = requestAnimationFrame(paintBars); };

  // ---------- top app bar ----------
  const backBtn = el('button.an-ib.an-back', { 'aria-label': 'Back', title: 'Back', onclick: () => goBack() }, icon('back'));
  const title = el('div.an-title');
  const shareIc = icon('dot'); shareIc.innerHTML = '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/>';   // Android's share glyph
  const shareBtn = el('button.an-ib', { 'aria-label': 'Share', title: 'Share', hidden: true, onclick: () => shareSeries() }, shareIc);
  const top = el('header.an-top.an-ui', backBtn, title, el('div.an-acts', shareBtn));
  // ---------- bottom navigation bar ----------
  const pill = el('i.an-pill.an-none');
  const nav = el('nav.an-nav.an-ui', { 'aria-label': 'Main' }, pill);
  const ptr = el('div.an-ptr.an-ui', icon('refresh'));

  let built = '';
  function buildNav() {
    const btns = [...document.querySelectorAll('.sidebar .nav-btn')];
    if (!btns.length) return;
    const sig = btns.map(b => b.dataset.nav + (b.hidden ? '-' : '')).join();
    if (sig !== built) {
      built = sig;
      const items = PRIMARY.map(id => btns.find(b => b.dataset.nav === id)).filter(Boolean).map(b =>
        el('a', { href: b.getAttribute('href'), dataset: { nav: b.dataset.nav } }, el('span.an-ico', b.querySelector('svg')?.cloneNode(true) || icon('dot')), el('span', { text: b.textContent.trim() })));
      items.push(el('a', { href: '#more', dataset: { nav: 'more' }, role: 'button' }, el('span.an-ico', icon('more')), el('span', { text: 'More' })));
      nav.replaceChildren(pill, ...items);
      requestAnimationFrame(() => paintNav(true));
    }
    paintNav();
  }
  const moreItems = () => [...document.querySelectorAll('.sidebar .nav-btn')].filter(b => !PRIMARY.includes(b.dataset.nav) && !HIDDEN.includes(b.dataset.nav) && !b.hidden);
  function paintNav(jump) {
    const on = document.querySelector('.sidebar .nav-btn.on')?.dataset.nav;
    const id = !on ? null : PRIMARY.includes(on) ? on : 'more';
    let active = null;
    for (const a of nav.querySelectorAll('a')) {
      const is = a.dataset.nav === id;
      a.classList.toggle('on', is); if (is) active = a;
      const dot = a.dataset.nav === 'more' ? moreItems().some(b => b.querySelector('.dotb')) : !!document.querySelector(`.sidebar .nav-btn[data-nav="${a.dataset.nav}"] .dotb`);
      const d = a.querySelector('.an-dot');
      if (dot && !d) a.querySelector('.an-ico').append(el('i.an-dot')); else if (!dot && d) d.remove();
    }
    pill.classList.toggle('an-none', !active);
    if (active && active.offsetWidth) {
      if (jump) pill.style.transition = 'none';
      pill.style.setProperty('--an-px', active.offsetLeft + (active.offsetWidth - 56) / 2 + 'px');
      if (jump) { void pill.offsetWidth; pill.style.transition = ''; }
    }
  }
  nav.addEventListener('click', e => {
    const a = e.target.closest('a'); if (!a) return;
    e.preventDefault();
    buzz('tick');
    if (a.dataset.nav === 'more') return openMore();
    if (routeName() === a.dataset.nav) { curView()?.scrollTo({ top: 0, behavior: html.classList.contains('an-motion') ? 'smooth' : 'auto' }); return; }
    K.go('/' + a.dataset.nav);
  });
  window.addEventListener('resize', K.debounce(() => paintNav(true), 120));

  // ---------- bottom sheets ----------
  let sheet = null;
  function openSheet(kids) {
    closeSheet(true);
    const scrim = el('div.an-scrim');
    const box = el('div.an-sheet', { role: 'dialog' }, el('i.an-handle'), kids);
    const close = () => {
      if (box.classList.contains('an-out')) return;
      box.classList.add('an-out'); scrim.classList.add('an-out');
      setTimeout(() => { box.remove(); scrim.remove(); }, 180);
      if (sheet?.box === box) sheet = null;
      bars();
    };
    scrim.addEventListener('click', close);
    document.body.append(scrim, box);
    dragToClose(box, close);
    sheet = { box, close };
    bars();
    return close;
  }
  function closeSheet(quiet) { if (!sheet) return false; sheet.close(); if (!quiet) buzz('tick'); return true; }

  // Pull a sheet down to put it away. It follows the finger; a quick flick or a third of its height closes it.
  function dragToClose(box, close, handle) {
    let y0 = 0, dy = 0, on = false, live = false, lastY = 0, lastT = 0, v = 0;
    box.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { on = false; return; }
      const t = e.target;
      if (t.closest('input, textarea, select')) { on = false; return; }
      const head = handle ? t.closest(handle) : null;
      if (box.scrollTop > 0 && !head && !t.closest('.an-handle')) { on = false; return; }
      on = true; live = false; y0 = lastY = e.touches[0].clientY; lastT = e.timeStamp; dy = 0; v = 0;
    }, { passive: true });
    box.addEventListener('touchmove', e => {
      if (!on) return;
      const y = e.touches[0].clientY, d = y - y0;
      if (!live) {
        if (d > 6) { live = true; box.classList.add('an-dragging'); }
        else if (d < -6) { on = false; return; }
        else return;
      }
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, d);
      v = (y - lastY) / Math.max(1, e.timeStamp - lastT); lastY = y; lastT = e.timeStamp;
      box.style.transform = `translateY(${dy}px)`;
    }, { passive: false });
    const end = () => {
      if (!on) return; on = false;
      if (!live) return;
      box.classList.remove('an-dragging');
      if (dy > box.offsetHeight * .33 || v > .5) { buzz('tick'); close(); }
      else {
        box.style.transition = 'transform calc(320ms / var(--spd, 1)) var(--an-spring)';
        box.style.transform = '';
        setTimeout(() => { box.style.transition = ''; }, 340);
      }
      // a drag isn't a tap
      const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
      box.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => box.removeEventListener('click', stop, { capture: true }), 400);
    };
    box.addEventListener('touchend', end);
    box.addEventListener('touchcancel', end);
  }
  const escape = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));

  // Koru's pop-up menus and dialogs become bottom sheets: a scrim behind, a handle on top, pull down to close.
  const scrims = new WeakMap();
  function adopt(node) {
    if (node.nodeType !== 1) return;
    if (node.classList.contains('menu')) {
      if (node.querySelector(':scope > .an-handle')) return;
      node.prepend(el('i.an-handle'));
      const scrim = el('div.an-scrim');
      node.before(scrim);
      scrims.set(node, scrim);
      new MutationObserver((_, o) => { if (node.classList.contains('out')) { scrim.classList.add('an-out'); bars(); o.disconnect(); } }).observe(node, { attributes: true, attributeFilter: ['class'] });
      dragToClose(node, () => {
        escape();
        // a menu that doesn't listen for Escape: a tap outside closes it, and failing that it just goes
        setTimeout(() => {
          if (node.isConnected && !node.classList.contains('out')) scrim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          setTimeout(() => { if (node.isConnected && !node.classList.contains('out')) node.remove(); }, 60);
        }, 30);
      }, '.menu-h');
      bars();
    } else if (node.classList.contains('lx-sheetwrap')) {
      const s = node.querySelector('.lx-sheet');
      if (!s || s.querySelector(':scope > .an-handle')) return;
      s.prepend(el('i.an-handle'));
      dragToClose(s, () => escape(), '.lx-shead');
      new MutationObserver((_, o) => { if (node.classList.contains('out')) { bars(); o.disconnect(); } }).observe(node, { attributes: true, attributeFilter: ['class'] });
      bars();
    }
  }
  new MutationObserver(recs => {
    for (const r of recs) {
      r.addedNodes.forEach(adopt);
      r.removedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (scrims.has(n)) { scrims.get(n).remove(); scrims.delete(n); bars(); }
        else if (n.classList.contains('lx-sheetwrap')) bars();
      });
    }
  }).observe(document.body, { childList: true });

  // ---------- the More sheet: every page that isn't in the bottom bar (new ones show up by themselves) ----------
  function openMore() {
    const on = document.querySelector('.sidebar .nav-btn.on')?.dataset.nav;
    const rows = moreItems().map(b => el('a.an-row' + (b.dataset.nav === on ? '.on' : ''), { href: b.getAttribute('href'), onclick: e => { e.preventDefault(); closeSheet(true); K.go('/' + b.dataset.nav); } },
      b.querySelector('svg')?.cloneNode(true) || icon('dot'), el('span', { text: b.textContent.trim() }), b.querySelector('.dotb') ? el('i.an-dot') : null));
    const inc = document.querySelector('.side-inc');
    const incT = el('i.toggle' + (K.incognito() ? '.on' : ''));
    const incRow = inc ? el('button.an-row', { onclick: () => { inc.click(); incT.classList.toggle('on', K.incognito()); } },
      icon('incognito'), el('span', 'Incognito', el('small.muted', { style: { display: 'block', fontSize: '.8em' }, text: 'Nothing you read is saved' })), incT) : null;
    openSheet([
      el('div.an-sh-h', K.fox(), el('div', el('b', { text: 'Koru' }), el('small', { text: K.info?.version ? 'Version ' + K.info.version : '' }))),
      ...rows, incRow ? el('hr') : null, incRow
    ]);
  }

  // ---------- the top bar follows the page ----------
  let barView = null, io = null, ioTarget = null, setPage = false;
  function refreshBar() {
    refreshT = 0;
    const v = curView(), r = routeName();
    const deep = !isTop(r) || setPage;
    html.classList.toggle('an-nonav', r !== 'read' && !isTop(r));
    backBtn.hidden = !deep;
    shareBtn.hidden = r !== 'series' || !(N.shareText || navigator.share);
    if (!v) return;
    settingsState(v);
    const target = v.querySelector(setPage ? '.set-layout.an-page .set-h' : ':scope > .inner > .head h1, .hero h1');
    const name = target ? target.textContent.trim() : (document.querySelector(`.sidebar .nav-btn[data-nav="${r}"]`)?.textContent.trim() || '');
    if (title.textContent !== name) title.textContent = name;
    top.classList.toggle('an-over', !!v.querySelector('.hero'));
    if (v !== barView) { barView = v; onScroll(); }
    if (target !== ioTarget) {
      io?.disconnect(); ioTarget = target;
      if (target) {
        top.classList.remove('an-collapsed');
        io = new IntersectionObserver(es => { for (const e of es) top.classList.toggle('an-collapsed', !e.isIntersecting && e.boundingClientRect.top < 80); }, { root: v, rootMargin: '-64px 0px 0px 0px' });
        io.observe(target);
      } else top.classList.toggle('an-collapsed', top.classList.contains('an-lifted'));   // a page with its own header: the name shows once it scrolls
    }
    bars();
  }
  let refreshT = 0;
  const refresh = () => { if (!refreshT) refreshT = requestAnimationFrame(refreshBar); };
  let scrollT = 0;
  function onScroll() {
    scrollT = 0;
    const v = curView();
    const lifted = !!v && v.scrollTop > 2;
    if (lifted !== top.classList.contains('an-lifted')) { top.classList.toggle('an-lifted', lifted); if (!ioTarget) top.classList.toggle('an-collapsed', lifted); bars(); }
  }
  main.addEventListener('scroll', e => { if (e.target === barView && !scrollT) scrollT = requestAnimationFrame(onScroll); }, { capture: true, passive: true });
  // A grid's covers rise in one after another the first time it fills (new pages of results, a source
  // answering late or covers moving about don't replay it). Marked here, before the covers are first drawn.
  function stagger() {
    for (const g of main.querySelectorAll('.grid:not(.an-seen), .rail:not(.an-seen), .dc-rail:not(.an-seen)')) {
      if (!g.querySelector(':scope > .card')) continue;
      g.classList.add('an-seen');
      if (!html.classList.contains('an-motion') || !g.closest('.view:not(.leave)')) continue;
      g.classList.add('an-stagger');
      setTimeout(() => g.classList.remove('an-stagger'), 900);
    }
  }
  new MutationObserver(() => { stagger(); refresh(); }).observe(main, { childList: true, subtree: true });

  function goBack() {
    buzz('tick');
    if (backInPage()) return;
    K.back();
  }

  // ---------- Settings: a list of sections; each opens as its own page ----------
  function settingsState(v) {
    const lay = v?.querySelector('.set-layout');
    if (!lay) return;
    lay.classList.toggle('an-page', setPage);
    v.classList.toggle('an-setpage', setPage);
    const q = lay.querySelector('.set-search');
    lay.classList.toggle('an-searching', !setPage && !!q?.value.trim());
    if (q && !q._an) { q._an = true; q.addEventListener('input', () => lay.classList.toggle('an-searching', !!q.value.trim())); }
  }
  function enterAnim(node, name) {
    if (!html.classList.contains('an-motion') || !node) return;
    node.style.animation = `${name} calc(300ms / var(--spd, 1)) var(--an-ease) both`;
    node.addEventListener('animationend', () => { node.style.animation = ''; }, { once: true });
  }
  document.addEventListener('click', e => {
    if (!e.target.closest?.('.set-nav-btn')) return;
    setPage = true;
    const v = curView();
    refreshBar();
    if (v) v.scrollTop = 0;
    enterAnim(v?.querySelector('.set-main'), 'an-axis-in');
  });
  function backInPage() {
    const stop = document.querySelector('.selbar .btn.icon');
    if (stop) { stop.click(); return true; }
    if (setPage) {
      setPage = false;
      const v = curView();
      refreshBar();
      if (v) v.scrollTop = 0;
      enterAnim(v?.querySelector('.set-nav'), 'an-axis-back-in');
      return true;
    }
    return false;
  }

  // ---------- page transitions: fade-through between tabs, shared axis into and out of pages ----------
  const trail = [location.hash];
  window.addEventListener('hashchange', () => {
    const was = routeName(trail[trail.length - 1] || ''), now = routeName();
    if (now !== 'settings') setPage = false;
    let dir = 'fade';
    if (trail.length > 1 && trail[trail.length - 2] === location.hash) { trail.pop(); if (!(isTop(now) && isTop(was))) dir = 'back'; }
    else { trail.push(location.hash); if (trail.length > 40) trail.shift(); if (!(isTop(now) && isTop(was))) dir = isTop(now) ? 'back' : 'fwd'; }
    html.dataset.anNav = dir;
    sheet?.close();
    refresh();
  });

  // ---------- touch: ripples, a pressed look, and long-press for what a right-click gives on a PC ----------
  const RIPPLE = '.item, .mi, .set-nav-btn, .an-row, .an-ib, .an-nav a, .dc-ent, .lx-hit, .seg button, .pal-item';
  function ripple(host, x, y) {
    if (!html.classList.contains('an-motion')) return;
    const into = host.matches('.an-nav a') ? host.querySelector('.an-ico') : host;
    if (!into) return;
    const r = into.getBoundingClientRect(), d = Math.hypot(r.width, r.height) * 2;
    const s = el('span.an-ripple', { style: { width: d + 'px', height: d + 'px', left: x - r.left - d / 2 + 'px', top: y - r.top - d / 2 + 'px' } });
    into.append(s);
    setTimeout(() => s.remove(), 520);
  }
  let press = null, suppressUntil = 0;
  const endPress = () => {
    if (!press) return;
    clearTimeout(press.lp); clearTimeout(press.rt);
    const c = press.card; if (c) setTimeout(() => c.classList.remove('an-press'), 90);
    press = null;
  };
  document.addEventListener('touchstart', e => {
    endPress();
    if (e.touches.length !== 1) return;
    const t = e.target, x = e.touches[0].clientX, y = e.touches[0].clientY;
    if (!t.closest || t.closest('.reader')) return;
    const p = press = { x, y, t };
    const card = t.closest('.card, .cont');
    const host = t.closest(RIPPLE);
    p.rt = setTimeout(() => { if (card) { card.classList.add('an-press'); p.card = card; } if (host) ripple(host, x, y); }, 60);
    if (t.closest('input, textarea, select, [contenteditable], .selbar, .an-nav, .an-top, .an-sheet')) return;
    const row = t.closest('.item');
    if (row && row.onpointerdown) return;   // chapter rows have their own long-press (start selecting)
    p.lp = setTimeout(() => {
      if (press !== p) return;
      buzz('long');
      suppressUntil = performance.now() + 900;
      if (p.card) p.card.classList.remove('an-press');
      press = null;
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, view: window }));
    }, 450);
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', e => { if (press && Math.hypot(e.touches[0].clientX - press.x, e.touches[0].clientY - press.y) > 10) endPress(); }, { passive: true, capture: true });
  document.addEventListener('touchend', endPress, { passive: true, capture: true });
  document.addEventListener('touchcancel', endPress, { passive: true, capture: true });
  main.addEventListener('scroll', endPress, { capture: true, passive: true });
  // the tap that ends a long-press doesn't also open the cover
  document.addEventListener('click', e => { if (performance.now() < suppressUntil) { suppressUntil = 0; e.preventDefault(); e.stopPropagation(); } }, true);
  // the WebView's own long-press menu event is replaced by the one above (the reader keeps its own)
  document.addEventListener('contextmenu', e => { if (e.isTrusted && !e.target.closest?.('.reader, input, textarea')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('dragstart', e => { if (!e.target.closest?.('.reader, input, textarea, [draggable=true]')) e.preventDefault(); }, true);
  // a little buzz on the things you'd want to feel
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.heart, .likeb, .toggle, .dlbtn, .seg button, .chip, .an-row, .set-nav-btn');
    if (b) buzz(b.matches('.heart, .likeb') ? 'confirm' : 'tick');
  });

  // ---------- pull to refresh: the Library checks for new chapters ----------
  let pull = null;
  const PULL = 72;
  main.addEventListener('touchstart', e => {
    const v = curView();
    if (routeName() !== 'library' || !v || e.touches.length !== 1 || v.scrollTop > 0 || ptr.classList.contains('an-spin') || sheet) { pull = null; return; }
    pull = { y0: e.touches[0].clientY, d: 0, armed: false };
  }, { passive: true });
  main.addEventListener('touchmove', e => {
    if (!pull) return;
    const d = e.touches[0].clientY - pull.y0;
    if (d <= 0 || curView()?.scrollTop > 0) { if (pull.d) hidePtr(); pull = null; return; }
    pull.d = Math.min(d * .5, 120);
    ptr.classList.remove('an-back');
    ptr.classList.add('an-on');
    ptr.style.setProperty('--an-py', pull.d + 'px');
    ptr.style.setProperty('--an-pr', d * 1.4 + 'deg');
    ptr.style.opacity = Math.min(1, pull.d / PULL);
    const armed = pull.d >= PULL;
    if (armed && !pull.armed) buzz('tick');
    pull.armed = armed;
  }, { passive: true });
  main.addEventListener('touchend', async () => {
    if (!pull) return;
    const p = pull; pull = null;
    if (!p.armed) { hidePtr(); return; }
    buzz('confirm');
    ptr.classList.add('an-back', 'an-spin');
    ptr.style.setProperty('--an-py', PULL + 'px');
    try { await K.checkUpdates?.(true); } catch {} finally { ptr.classList.remove('an-spin'); hidePtr(); }
  });
  function hidePtr() { ptr.classList.add('an-back'); ptr.style.setProperty('--an-py', '0px'); ptr.style.opacity = ''; ptr.classList.remove('an-on'); }

  // ---------- sharing goes through Android's share sheet ----------
  if (N.shareText) {
    const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
    navigator.share = async (d = {}) => {
      const f = d.files?.[0];
      if (f && N.shareFile) { N.shareFile(f.name || 'Koru', f.type || 'application/octet-stream', await b64(f)); return; }
      N.shareText(d.title || '', [d.text, d.url].filter(Boolean).join('\n'));
    };
    navigator.canShare = () => true;
  }
  async function shareSeries() {
    const [, provider, slug] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map(decodeURIComponent);
    try {
      const s = await K.getSeries(provider, slug);
      await navigator.share({ title: s.title, text: s.title + (K.providers[provider] ? ' on ' + K.providers[provider].name : ''), url: s.url });
    } catch (e) { K.toast('Couldn\'t share it: ' + e.message, 'error'); }
  }

  // ---------- the keyboard: the bottom bar steps aside while it's up ----------
  window.KoruIme = on => { html.classList.toggle('an-kb', !!on); bars(); };

  // ---------- start ----------
  // The sidebar's buttons (app.js builds them from its list, so new pages show up here too) drive the bottom bar.
  function watchSidebar() {
    const sb = document.querySelector('.sidebar .nav');
    if (!sb) return;
    new MutationObserver(() => { buildNav(); refresh(); }).observe(sb, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    buildNav();
  }
  new MutationObserver(() => { paintMotion(); bars(); }).observe(html, { attributes: true, attributeFilter: ['class', 'style', 'data-transition'] });
  paintMotion();
  const mount = () => { if (top.isConnected) return; document.body.append(top, ptr, nav); watchSidebar(); refresh(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  document.addEventListener('koru-ready', () => {
    buildNav(); refresh(); bars();
    requestAnimationFrame(() => requestAnimationFrame(() => { try { N.ready?.(); } catch {} }));
    setTimeout(() => { try { N.ready?.(); } catch {} }, 400);   // in case frames are held back until the splash goes
    // the first time: how to reach a cover's options
    try {
      if (!localStorage.getItem('koru-an-lp-told') && Object.keys(K.data.library || {}).length) {
        localStorage.setItem('koru-an-lp-told', '1');
        setTimeout(() => K.toast('Tip: long-press a cover for its options.'), 2500);
      }
    } catch {}
  });

  K.androidUI = {
    closeSheet: () => closeSheet(),
    backInPage,
    backToLibrary() {
      const r = routeName();
      if (r === 'library' || !isTop(r)) return false;
      K.go('/library');
      return true;
    },
    openSheet
  };
})();
