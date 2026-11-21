// Koru series colours: every series page and the reader take on colours from that series' cover, so each
// series feels like its own world. The cover is read once (shrunk to 24×36 while it's decoded, through
// Koru's background side so the canvas can read it), a vivid accent, a second accent and a dark base are
// picked, and kept per series in this PC's storage (a few dozen bytes each). They're set as CSS variables
// on the series page and the reader only. Nothing runs per frame: the glow is a still gradient that fades
// in once. A cover that can't be read keeps your normal theme.
'use strict';
(function () {
  const { el } = K;
  const KEY = 'koru-sc1', MAX = 400, RETRY = 3 * 86400e3, W = 24, H = 36;
  const STRENGTH = [['subtle', 'Subtle'], ['normal', 'Normal'], ['strong', 'Strong']];
  const on = () => K.data.settings.seriesColors !== false;
  const amount = () => (STRENGTH.some(s => s[0] === K.data.settings.seriesColorsAmt) ? K.data.settings.seriesColorsAmt : 'normal');

  // ---------- the saved colours: { 'provider:slug': { u: cover hash, at, a: [h,s,l], b: [h,s,l], base: [h,s] } or { u, at, none: 1 } } ----------
  let store = null;
  const load = () => { if (store) return store; try { store = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { store = {}; } return store; };
  const persist = K.debounce(() => {
    const s = load(), keys = Object.keys(s);
    if (keys.length > MAX) keys.sort((a, b) => (s[a].at || 0) - (s[b].at || 0)).slice(0, keys.length - MAX).forEach(k => delete s[k]);
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  }, 800);
  const hash = str => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); };
  const cached = (key, cover) => {
    const e = load()[key];
    if (!e || e.u !== hash(cover)) return null;
    if (e.none && Date.now() - (e.at || 0) > RETRY) return null;   // try a "no colours" cover again now and then
    return e;
  };

  // ---------- colour maths ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hsl2rgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map(v => Math.round((v + m) * 255));
  }
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');

  // ---------- picking colours from the 24×36 cover ----------
  // Pixels are sorted into 24 hue bins (15° each). The accent is the bin with the most vivid, mid-bright
  // colour; the second accent is the next strong bin at least 45° away; the base is the cover's main hue.
  function pick(d) {
    const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0, n: 0 }));
    const hue = new Float32Array(24);
    let vivid = 0, total = 0, baseW = 0, baseS = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      total++;
      const r = d[i], g = d[i + 1], b = d[i + 2], [h, s, l] = rgb2hsl(r, g, b), bi = Math.floor(h / 15) % 24;
      if (s >= 0.15 && l > 0.1 && l < 0.9) { const w = s * (1 - Math.abs(l - 0.5)); hue[bi] += w; baseW += w; baseS += s * w; }
      if (s < 0.28 || l < 0.18 || l > 0.88) continue;
      const w = s ** 1.5 * Math.max(0.05, 1 - 1.6 * Math.abs(l - 0.55));
      const e = bins[bi]; e.w += w; e.r += r * w; e.g += g * w; e.b += b * w; e.n++; vivid++;
    }
    if (!total || vivid < total * 0.03) return null;   // a black-and-white cover: nothing to take on
    const order = bins.map((e, i) => [e, i]).filter(([e]) => e.w > 0).sort((x, y) => y[0].w - x[0].w);
    const avg = e => rgb2hsl(e.r / e.w, e.g / e.w, e.b / e.w);
    const [top, ti] = order[0];
    const a = avg(top);
    const far = order.find(([e, i]) => { const dd = Math.abs(i - ti); return Math.min(dd, 24 - dd) >= 3 && e.w >= top.w * 0.2; });
    const b = far ? avg(far[0]) : [(a[0] + 30) % 360, a[1], Math.min(0.8, a[2] + 0.06)];
    let bh = 0, bw = -1;
    for (let i = 0; i < 24; i++) if (hue[i] > bw) { bw = hue[i]; bh = i * 15 + 7.5; }
    const r3 = n => Math.round(n * 1000) / 1000;
    return { a: [Math.round(a[0]), r3(a[1]), r3(a[2])], b: [Math.round(b[0]), r3(b[1]), r3(b[2])], base: [Math.round(bh), r3(baseW ? baseS / baseW : 0)] };
  }

  // The cover through Koru's background side (same origin, so the canvas isn't tainted), decoded small.
  async function read(url) {
    const r = await fetch(/^https:\/\//.test(url) ? K.viaKoru(url) : url);
    if (!r.ok) throw Object.assign(new Error('cover ' + r.status), { soft: r.status >= 500 || r.status === 0 });
    let bmp;
    try { bmp = await createImageBitmap(await r.blob(), { resizeWidth: W, resizeHeight: H, resizeQuality: 'medium' }); }
    catch { return null; }   // not a picture we can read: keep the normal theme
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0); bmp.close?.();
    return pick(cx.getImageData(0, 0, W, H).data);
  }
  const busy = new Map();
  function colorsFor(s) {
    if (!s?.provider || !s.slug || !s.cover) return Promise.resolve(null);
    const key = K.key(s.provider, s.slug), hit = cached(key, s.cover);
    if (hit) return Promise.resolve(hit.none ? null : hit);
    if (busy.has(key)) return busy.get(key);
    const p = read(s.cover).then(c => {
      const e = c ? { u: hash(s.cover), at: Date.now(), ...c } : { u: hash(s.cover), at: Date.now(), none: 1 };
      load()[key] = e; persist();
      return c ? e : null;
    }, () => null)   // offline or the site is down: no colours this time, try again next visit
      .finally(() => busy.delete(key));
    busy.set(key, p);
    return p;
  }

  // ---------- applying them to a series page or the reader ----------
  const PROPS = ['--accent', '--accent2', '--accent-solid', '--on-accent', '--accent-grad', '--accent-line', '--sc-glow', '--sc-glow2', '--readerBg'];
  const GLOW = { subtle: 0.1, normal: 0.2, strong: 0.32 };
  function colours(e) {
    const t = K.theme.current(), col = k => K.theme.hexRgb(t.colors[k][0]);
    const bg = col('bg'), light = lum(bg) > 0.5, amt = amount();
    // keep the accent readable: bright enough on a dark theme, deep enough on a light one
    const fit = ([h, s, l]) => {
      s = clamp(s, 0.5, 0.92);
      l = light ? clamp(l, 0.3, 0.5) : clamp(l, 0.56, 0.74);
      let c = hsl2rgb(h, s, l);
      if (light) while (contrast(c, [255, 255, 255]) < 3.2 && l > 0.2) { l -= 0.02; c = hsl2rgb(h, s, l); }
      else while (contrast(c, bg) < 4.5 && l < 0.84) { l += 0.02; c = hsl2rgb(h, s, l); }
      return c;
    };
    let A = fit(e.a), B = fit(e.b);
    if (amt === 'subtle') { A = mix(col('accent'), A, 0.55); B = mix(col('accent2'), B, 0.55); }
    const rb = col('readerBg'), base = hsl2rgb(e.base[0], clamp(e.base[1] * 0.7 + 0.12, 0, 0.5), 0.075);
    return { A, B, light, amt, reader: amt === 'subtle' || lum(rb) > 0.3 ? null : mix(rb, base, amt === 'strong' ? 1 : 0.55), t };
  }
  function apply(scope, e) {
    const c = colours(e), st = scope.style, t = c.t;
    st.setProperty('--accent', css(c.A));
    st.setProperty('--accent2', css(c.B));
    st.setProperty('--accent-solid', hex(c.A));
    st.setProperty('--on-accent', lum(c.A) > 0.45 ? '#0b0b14' : '#ffffff');
    st.setProperty('--accent-grad', t.accentType === 'solid' ? css(c.A) : `linear-gradient(${t.accentAngle}deg, ${css(c.A)}, ${css(c.B)})`);
    st.setProperty('--accent-line', t.accentType === 'solid' ? css(c.A) : `linear-gradient(90deg, ${css(c.A)}, ${css(c.B)})`);
    const g = GLOW[c.amt] * (c.light ? 0.8 : 1);
    st.setProperty('--sc-glow', css(c.A, g.toFixed(3)));
    st.setProperty('--sc-glow2', css(c.B, (g * 0.75).toFixed(3)));
    if (scope.classList.contains('reader') && c.reader) st.setProperty('--readerBg', css(c.reader)); else st.removeProperty('--readerBg');
    scope.dataset.sc = c.amt;
    if (scope.matches('.view') && !scope.querySelector(':scope > .sc-glow')) scope.prepend(el('div.sc-glow', { 'aria-hidden': 'true' }));
  }
  function clear(scope) {
    for (const p of PROPS) scope.style.removeProperty(p);
    delete scope.dataset.sc;
    scope.querySelector(':scope > .sc-glow')?.remove();
  }
  // scope: the series page (anything inside its .view) or the reader box. s: { provider, slug, cover }
  function paint(scope, s) {
    if (!scope) return;
    if (!scope.matches('.reader')) scope = scope.closest('.view') || scope;
    const key = s?.provider && s.slug ? K.key(s.provider, s.slug) : '';
    if (scope.dataset.scKey !== key) clear(scope);
    scope.dataset.scKey = key;
    scope._sc = s;
    if (!key || !s.cover || !on()) { clear(scope); return; }
    const hit = cached(key, s.cover);
    if (hit) { hit.none ? clear(scope) : apply(scope, hit); return; }
    colorsFor(s).then(e => { if (scope.dataset.scKey === key && scope.isConnected && on()) e ? apply(scope, e) : clear(scope); });
  }
  const repaintAll = () => document.querySelectorAll('[data-sc-key]').forEach(n => paint(n, n._sc));

  // ---------- Settings → Appearance ----------
  (K.settingsExtras ||= []).push(() => {
    const t = el('button.toggle' + (on() ? '.on' : ''), { role: 'switch', 'aria-checked': String(on()) });
    const amt = el('div.ctl.sc-amt', { hidden: !on() }, el('div.lab', 'Strength', el('small', { text: 'Subtle only tints the buttons a little. Strong also gives the reader a background in the cover\'s colour' })),
      K.segmented(STRENGTH, amount(), v => { K.data.settings.seriesColorsAmt = v; K.save('settings'); repaintAll(); }));
    t.onclick = () => {
      const v = !t.classList.contains('on');
      t.classList.toggle('on', v); t.setAttribute('aria-checked', String(v)); amt.hidden = !v;
      K.data.settings.seriesColors = v; K.save('settings'); repaintAll();
    };
    return el('section.panel.glass', el('h3', K.icon('palette'), 'Series colours'),
      el('p', { text: 'Each series page and the reader take on colours from that series\' cover, so every series feels like its own world.' }),
      el('div.ctl', el('div.lab', 'Series colours', el('small', { text: 'Buttons, progress and a soft glow in the cover\'s colours. Worked out once per series' })), t),
      amt);
  });

  K.seriesColors = { paint, warm: s => { if (on()) colorsFor(s); }, colorsFor, repaintAll, clear, pick };
})();
