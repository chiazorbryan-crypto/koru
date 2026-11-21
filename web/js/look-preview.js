// Look preview (Settings → Appearance): a little Koru drawn in the colours you're making, so you can see a look
// while you build it. It follows every colour/glass/gradient change as you drag, and hovering a preset or one of
// your saved looks shows that look here first, before you pick it. When you scroll down to the colour controls it
// floats in the corner so it stays in sight. It only paints its own small box: nothing changes until you pick.
(() => {
  const { el } = K;
  const T = () => K.theme;
  let inst = null;   // one preview at a time (Settings redraws itself often)

  const hexLum = h => {
    const [r, g, b] = T().hexRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const full = t => ({ ...T().BASE, ...(t || {}), colors: { ...T().BASE.colors, ...((t && t.colors) || {}) } });

  // the same colour recipe theme.js uses, worked out for one box instead of the whole app
  function vars(t) {
    const c = k => T().rgba(t.colors[k]);
    const stops = t.bg3On ? [c('bg'), c('bg3'), c('bg2')] : [c('bg'), c('bg2')];
    const bg = t.bgType === 'solid' ? c('bg')
      : t.bgType === 'radial' ? `radial-gradient(130% 130% at 22% 12%, ${[...stops].reverse().join(', ')})`
      : t.bgType === 'conic' ? `conic-gradient(from ${t.bgAngle}deg at 50% 50%, ${stops.join(', ')}, ${c('bg')})`
      : `linear-gradient(${t.bgAngle}deg, ${stops.join(', ')})`;
    const grad = t.accentType === 'solid' ? c('accent') : `linear-gradient(${t.accentAngle}deg, ${c('accent')}, ${c('accent2')})`;
    return {
      '--lp-bg': bg, '--lp-g1': c('glow1'), '--lp-g2': c('glow2'), '--lp-g3': c('glow3'),
      '--lp-accent': c('accent'), '--lp-grad': grad,
      '--lp-line': t.accentType === 'solid' ? c('accent') : `linear-gradient(90deg, ${c('accent')}, ${c('accent2')})`,
      '--lp-on': hexLum(t.colors.accent[0]) > 0.45 ? '#0b0b14' : '#ffffff',
      '--lp-text': c('text'), '--lp-muted': c('muted'),
      '--lp-glass': t.glassGrad ? `linear-gradient(${t.glassAngle}deg, ${c('glass')}, ${c('glass2')})` : c('glass'),
      '--lp-edge': c('edge'), '--lp-shine': c('shine'), '--lp-shadow': c('shadow'),
      '--lp-side': t.sideGrad ? `linear-gradient(${t.glassAngle}deg, ${c('side')}, ${c('side2')})` : c('side'),
      '--lp-card': c('card'), '--lp-badge': c('badge'), '--lp-reader': c('readerBg'),
      '--lp-r': Math.round(Math.min(22, Math.max(2, (t.radius ?? 16) * 0.55))) + 'px',
      '--lp-font': t.font || 'inherit', '--lp-tfont': t.titleFont || t.font || 'inherit',
      '--lp-blur': (t.glassUi === false ? 0 : Math.min(14, Math.round((t.blur ?? 20) / 3))) + 'px',
      '--lp-glow': Math.min(14, Math.round((t.accentGlow ?? 0) / 2)) + 'px'
    };
  }

  // the made-up library shown inside (plain cover colours, so you judge the theme around them)
  const COVERS = ['linear-gradient(160deg,#3b4a6b,#151a2b)', 'linear-gradient(160deg,#7a3b3b,#2a1212)', 'linear-gradient(160deg,#3b6b55,#10241c)', 'linear-gradient(160deg,#6b5a3b,#261d0f)'];
  const NAMES = [['Solo Hunter', 'Ch. 182'], ['Crimson Sword', 'Ch. 64'], ['Green Tower', 'Ch. 310'], ['Desert King', 'Ch. 27']];

  function mock() {
    return el('div.lp-app',
      el('i.lp-orb.o1'), el('i.lp-orb.o2'), el('i.lp-orb.o3'),
      el('div.lp-side', el('b.lp-logo'), el('i.lp-ic.on'), el('i.lp-ic'), el('i.lp-ic'), el('i.lp-ic'), el('i.lp-ic')),
      el('div.lp-main',
        el('div.lp-head', el('span.lp-title', { text: 'Library' }), el('span.lp-sub', { text: '12 series · 3 new chapters' })),
        el('div.lp-covers', ...COVERS.map((bg, i) => el('div.lp-cover', { style: { background: bg } },
          i === 0 || i === 2 ? el('span.lp-badge', { text: 'NEW' }) : null,
          el('div.lp-cap', el('b', { text: NAMES[i][0] }), el('small', { text: NAMES[i][1] }))))),
        el('div.lp-panel',
          el('div.lp-ptext', el('b', { text: 'Continue reading' }), el('small', { text: 'Solo Hunter · page 14 of 40' })),
          el('div.lp-bar', el('i')),
          el('div.lp-btns', el('span.lp-btn', { text: 'Read' }), el('span.lp-btn2', { text: 'Details' })))),
      el('div.lp-reader', el('small', { text: 'Reader' }), el('i.lp-page'), el('i.lp-page.p2')));
  }

  function box() {
    inst?.destroy();
    const app = mock();
    const label = el('div.lp-label', el('b', { text: 'Preview' }), el('span', { text: 'Your look right now' }));
    const hide = el('button.lp-hide', { title: 'Hide the floating preview', onclick: () => { me.dismissed = true; dock(); } }, K.icon('x'));
    const card = el('div.lp-card', label, app, hide);
    const spot = el('div.lp-spot', card);
    let showing = null, raf = 0, floating = false;
    const me = { dismissed: false };

    const paint = () => {
      raf = 0;
      const now = T().current();   // a look laid over yours, the way picking it would
      const t = showing ? full({ ...now, ...showing.theme, colors: { ...now.colors, ...(showing.theme.colors || {}) } }) : full(now);
      for (const [k, v] of Object.entries(vars(t))) app.style.setProperty(k, v);
      card.classList.toggle('peek', !!showing);
      label.lastChild.textContent = showing ? showing.name + ' · click it to use' : 'Your look right now';
    };
    const soon = () => { if (!raf) raf = requestAnimationFrame(paint); };

    // follows the app's own theme as it changes (theme.js writes its colours on <html>)
    const mo = new MutationObserver(() => { if (!showing) soon(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    // floats in the corner once its spot scrolls out of sight (while you're still in Appearance)
    const dock = () => {
      if (!spot.isConnected) { destroy(); return; }
      const r = spot.getBoundingClientRect();
      const gone = r.height === 0 || r.bottom < 70;
      const want = gone && r.height > 0 && !me.dismissed && innerWidth >= 900;
      if (!gone) me.dismissed = false;   // back at the top: it can float again later
      if (want === floating) return;
      floating = want;
      spot.style.height = floating ? r.height + 'px' : '';
      if (floating) { document.body.append(card); card.classList.add('float'); }
      else { card.classList.remove('float'); spot.append(card); }
    };
    let sraf = 0;
    const onScroll = () => { if (!sraf) sraf = requestAnimationFrame(() => { sraf = 0; dock(); }); };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    const watch = setInterval(() => { if (!spot.isConnected) destroy(); }, 1000);   // Settings left or redrawn

    function destroy() {
      mo.disconnect(); clearInterval(watch);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
      card.remove();
      if (inst === api) inst = null;
    }
    const api = {
      el: spot, destroy,
      show(look) { showing = look && look.theme ? look : null; soon(); },   // a preset / saved look to peek at, or null for yours
      hoverable(node, look) {   // hovering (or tabbing to) a look shows it here first
        const on = () => api.show(look), off = () => api.show(null);
        node.addEventListener('pointerenter', on); node.addEventListener('pointerleave', off);
        node.addEventListener('focus', on); node.addEventListener('blur', off);
        node.addEventListener('click', off);
        return node;
      }
    };
    inst = api;
    paint();
    return api;
  }

  K.lookPreview = { box, vars };
})();
