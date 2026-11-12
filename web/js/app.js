// Koru app shell: sidebar, routing, page transitions and the little interactive touches.
'use strict';
(function () {
  const { el, icon, $, $$ } = K;
  const NAV = [
    ['library', 'Library', 'library'],
    ['explore', 'Explore', 'explore'],
    ['search', 'Search', 'search'],
    ['downloads', 'Downloads', 'download'],
    ['stats', 'Stats', 'chart'],
    ['settings', 'Settings', 'settings']
  ];

  // ---------- sidebar ----------
  function buildSidebar() {
    $('.side-logo').append(K.fox());
    $('#tb-fox').append(K.fox());
    const nav = $('.nav');
    for (const [id, label, ic] of NAV) {
      nav.append(el('a.nav-btn', { href: '#/' + id, dataset: { nav: id }, title: label }, icon(ic), el('span', { text: label })));
    }
    const inc = el('button.side-inc', { title: 'Incognito: nothing you read is saved', 'aria-label': 'Incognito' }, icon('incognito'));
    const paintInc = () => { inc.classList.toggle('on', K.incognito()); document.documentElement.classList.toggle('incognito', K.incognito()); };
    inc.onclick = () => { K.data.settings.incognito = !K.incognito(); K.save('settings'); paintInc(); K.toast(K.incognito() ? 'Incognito on: history and progress won\'t be saved' : 'Incognito off', K.incognito() ? 'info' : 'ok'); document.dispatchEvent(new CustomEvent('koru-incognito')); };
    K.paintInc = paintInc;
    $('.side-min-btn').before(inc);
    paintInc();
    const minBtn = $('.side-min-btn');
    minBtn.append(icon('collapse'));
    minBtn.onclick = () => {
      const min = !K.theme.current().sideMin;
      K.theme.set({ sideMin: min });
      minBtn.title = min ? 'Expand sidebar' : 'Minimize sidebar';
      setTimeout(movePill, 380);
    };
    window.addEventListener('resize', K.debounce(movePill, 80));
  }
  function movePill() {
    const pill = $('.nav-pill'), on = $('.nav-btn.on');
    if (!pill) return;
    if (!on || K.theme.current().sideMin) { pill.style.opacity = 0; return; }
    pill.style.opacity = 1;
    pill.style.width = on.offsetWidth + 'px';
    pill.style.height = on.offsetHeight + 'px';
    pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  }
  K.movePill = movePill;
  K.setNavBadge = (id, show) => {
    const b = $(`.nav-btn[data-nav=${id}]`);
    if (!b) return;
    let d = b.querySelector('.dotb');
    if (show && !d) b.append(el('i.dotb'));
    if (!show && d) d.remove();
  };

  // ---------- routing ----------
  // #/library  #/explore  #/search?q=  #/series/<provider>/<slug>  #/read/<provider>/<slug>/<chapter>  #/downloads  #/settings
  let current = null, token = 0;
  const KEEP = ['explore', 'search'], kept = {};
  function parse() {
    const h = location.hash.replace(/^#\/?/, '') || 'library';
    const [path, qs] = h.split('?');
    const parts = path.split('/').map(decodeURIComponent);
    return { name: parts[0], parts: parts.slice(1), query: new URLSearchParams(qs || '') };
  }
  K.go = (hash, replace) => { if (replace) location.replace('#' + hash); else location.hash = hash; };
  K.back = () => { if (history.length > 1) history.back(); else K.go('/library'); };
  // Mouse back button and Alt+Left go back too (not while reading; the reader has its own keys)
  document.addEventListener('mouseup', e => { if (e.button === 3 && !document.querySelector('.reader')) { e.preventDefault(); K.back(); } });
  document.addEventListener('keydown', e => { if (e.altKey && e.key === 'ArrowLeft' && !document.querySelector('.reader')) { e.preventDefault(); K.back(); } });

  async function route() {
    const r = parse();
    if (r.name === 'read') { K.openReader(r.parts[0], r.parts[1], r.parts[2]); return; }
    K.closeReader?.(true);
    const render = K.views[r.name] || K.views.library;
    const navId = r.name === 'series' ? (sessionStorage.getItem('koru-from') || 'library') : r.name === 'local' ? 'downloads' : r.name;
    if (r.name !== 'series') sessionStorage.setItem('koru-from', r.name === 'local' ? 'downloads' : K.views[r.name] ? r.name : 'library');
    $$('.nav-btn').forEach(b => b.classList.toggle('on', b.dataset.nav === navId));
    movePill();

    const my = ++token;
    const main = $('#main');
    const old = current;
    if (old) {
      if (old._keep) {
        old._scroll = old.scrollTop;
        kept[old._keep] = old;
        old.classList.add('leave');
        setTimeout(() => { if (current !== old) { old.remove(); old.classList.remove('leave'); } }, 220);
      } else { old.classList.add('leave'); setTimeout(() => old.remove(), 220); }
    }
    const q = r.query.get('q') || '';
    const back = kept[r.name];
    if (back && (r.name !== 'search' || back._q === q)) {
      delete kept[r.name];
      back.classList.remove('leave');
      back.classList.add('enter');
      back.addEventListener('animationend', () => back.classList.remove('enter'), { once: true });
      main.append(back);
      back.style.scrollBehavior = 'auto';
      back.scrollTop = back._scroll || 0;
      back.style.scrollBehavior = '';
      current = back;
      return;
    }
    const view = el('section.view.enter', { tabIndex: -1 });
    const inner = el('div.inner');
    view.append(inner);
    view.addEventListener('animationend', () => view.classList.remove('enter'), { once: true });
    if (KEEP.includes(r.name)) { view._keep = r.name; view._q = q; }
    main.append(view);
    current = view;
    try { await render(inner, r, () => view.isConnected && current === view); }
    catch (e) { if (my === token) { inner.replaceChildren(errorBox(e)); } }
  }
  function errorBox(e) {
    return el('div.empty', K.fox(), el('h3', { text: 'That didn\'t load' }), el('p', { text: e?.message || 'Check your connection and try again.' }),
      el('button.btn', { onclick: () => route() }, icon('refresh'), 'Try again'));
  }
  K.errorBox = errorBox;

  // ---------- touches: ripples, pointer light, cover tilt ----------
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest('.btn, .chip');
    if (!b || document.documentElement.classList.contains('no-anim')) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
    const s = el('span.ripple', { style: { width: d + 'px', height: d + 'px', left: e.clientX - r.left - d / 2 + 'px', top: e.clientY - r.top - d / 2 + 'px' } });
    b.append(s);
    setTimeout(() => s.remove(), 700);
  });
  let lit = null, pmFrame = 0, pmEvent = null;
  document.addEventListener('pointermove', e => {
    pmEvent = e;
    if (pmFrame) return;
    pmFrame = requestAnimationFrame(() => { pmFrame = 0; onPointer(pmEvent); });
  }, { passive: true });
  function onPointer(e) {
    const root = document.documentElement;
    if (root.classList.contains('reading')) return;
    if (root.classList.contains('spot')) {
      const g = e.target.closest?.('.glass');
      if (lit && lit !== g) lit.classList.remove('lit');
      if (g) { const r = g.getBoundingClientRect(); g.style.setProperty('--mx', e.clientX - r.left + 'px'); g.style.setProperty('--my', e.clientY - r.top + 'px'); g.classList.add('lit'); }
      lit = g;
    }
    if (root.classList.contains('tilt')) {
      const c = e.target.closest?.('.card .cv');
      if (c) {
        const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        c.style.setProperty('--ry', ((x - 0.5) * 14).toFixed(1) + 'deg');
        c.style.setProperty('--rx', ((0.5 - y) * 14).toFixed(1) + 'deg');
        c.style.setProperty('--gx', (x * 100).toFixed(0) + '%');
        c.style.setProperty('--gy', (y * 100).toFixed(0) + '%');
      }
    }
  }
  document.addEventListener('pointerout', e => {
    const c = e.target.closest?.('.card .cv');
    if (c && !c.contains(e.relatedTarget)) { c.style.setProperty('--rx', '0deg'); c.style.setProperty('--ry', '0deg'); }
  });

  // ---------- start ----------
  // The glass re-blurs whatever moves behind it, so the orbs pause while you scroll, while a page changes,
  // and while Koru isn't the active window. They carry on from the same spot afterwards.
  const bgfx = document.querySelector('.bgfx');
  let stillT = 0, away = !document.hasFocus();
  const still = ms => { bgfx?.classList.add('still'); clearTimeout(stillT); stillT = setTimeout(() => { if (!away) bgfx?.classList.remove('still'); }, ms); };
  document.addEventListener('scroll', () => still(260), { capture: true, passive: true });
  window.addEventListener('hashchange', () => still(700));
  window.addEventListener('blur', () => { away = true; bgfx?.classList.add('still'); });
  window.addEventListener('focus', () => { away = false; still(150); });
  if (away) bgfx?.classList.add('still');

  async function start() {
    try { const info = await K.api.get('/k/info'); K.info = info; if (info.platform === 'desktop') document.documentElement.classList.add('desktop'); }
    catch { K.info = { platform: 'web' }; }
    await K.loadData();
    K.theme.apply(); K.applyLite();
    buildSidebar();
    window.addEventListener('hashchange', route);
    await route();
    K.refreshDownloads?.();
    setTimeout(() => K.checkUpdates?.(), 8000);
    if (K.info.platform === 'desktop') setTimeout(() => K.api.get('/k/gpu').then(g => {
      const mode = K.gpuMode(g); K.applyLite(mode);
      if (mode === 'soft' && K.liteSetting() !== 'off' && !sessionStorage.getItem('koru-lite-told')) { sessionStorage.setItem('koru-lite-told', '1'); K.toast('Koru is drawing without your graphics card, so light mode is on to keep it smooth. See Settings → Graphics.'); }
    }).catch(() => {}), 2500);
  }
  start();
})();
