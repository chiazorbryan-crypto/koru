// Koru appearance: every colour (with its own transparency), glass, glow, motion, shape, text and sidebar.
// The theme lives in K.data.settings.theme and is applied as CSS variables on <html>.
'use strict';
(function () {
  // Each colour is [hex, opacity 0-100].
  const COLORS = [
    ['bg', 'App background', 'Base colour behind everything'],
    ['bg2', 'Background fade', 'Second colour the background fades into'],
    ['bg3', 'Background third colour', 'Used when "Three-colour background" is on'],
    ['glow1', 'Glow orb 1', 'Big soft light behind the glass'],
    ['glow2', 'Glow orb 2', ''],
    ['glow3', 'Glow orb 3', ''],
    ['accent', 'Accent', 'Buttons, active items, progress'],
    ['accent2', 'Accent blend', 'Second accent colour for gradients'],
    ['text', 'Text', ''],
    ['muted', 'Soft text', 'Labels and secondary text'],
    ['glass', 'Glass panels', 'Tint and transparency of glass'],
    ['glass2', 'Glass fade', 'Glass fades into this when "Gradient glass" is on'],
    ['edge', 'Glass edges', 'Outline around glass'],
    ['shine', 'Glass shine', 'The light streak on glass'],
    ['side', 'Sidebar', 'Sidebar glass tint'],
    ['side2', 'Sidebar fade', 'Sidebar fades into this when "Gradient sidebar" is on'],
    ['card', 'Cards', 'Cover card caption glass'],
    ['shadow', 'Shadows', ''],
    ['badge', 'New chapter badge', ''],
    ['readerBg', 'Reader background', 'Behind the pages while reading']
  ];
  // Effects: [key, label, min, max, step, unit, group]
  const SLIDERS = [
    ['blur', 'Glass blur', 0, 60, 1, 'px', 'glass'],
    ['sat', 'Glass colour boost', 100, 260, 5, '%', 'glass'],
    ['sideBlur', 'Sidebar blur', 0, 60, 1, 'px', 'glass'],
    ['edgeW', 'Edge thickness', 0, 3, 0.5, 'px', 'glass'],
    ['shineAmt', 'Shine strength', 0, 100, 1, '%', 'glass'],
    ['orbSize', 'Orb size', 20, 110, 1, '', 'glow'],
    ['orbBlur', 'Orb softness', 0, 200, 2, 'px', 'glow'],
    ['accentGlow', 'Accent glow', 0, 60, 1, 'px', 'glow'],
    ['coverGlow', 'Cover glow on hover', 0, 70, 1, 'px', 'glow'],
    ['textGlow', 'Title glow', 0, 24, 1, 'px', 'glow'],
    ['bgAngle', 'Gradient direction', 0, 360, 5, '°', 'grad'],
    ['accentAngle', 'Accent direction', 0, 360, 5, '°', 'grad'],
    ['glassAngle', 'Glass and sidebar direction', 0, 360, 5, '°', 'grad'],
    ['bgSpeed', 'Background motion (one turn)', 20, 300, 5, 's', 'grad'],
    ['speed', 'Animation speed', 0.25, 3, 0.05, '×', 'motion'],
    ['orbMotion', 'Orb drift', 0, 100, 1, '%', 'motion'],
    ['lift', 'Hover lift', 0, 24, 1, 'px', 'motion'],
    ['hscale', 'Hover zoom', 100, 112, 1, '%', 'motion'],
    ['bounce', 'Bounciness', 0, 100, 1, '%', 'motion'],
    ['radius', 'Corner roundness', 0, 36, 1, 'px', 'shape'],
    ['coverW', 'Cover size', 110, 240, 2, 'px', 'shape'],
    ['fontScale', 'Text size', 85, 130, 1, '%', 'shape'],
    ['sideSize', 'Sidebar size', 80, 130, 1, '%', 'side'],
    ['wallDim', 'Wallpaper dim', 0, 90, 1, '%', 'wall'],
    ['wallBlur', 'Wallpaper blur', 0, 40, 1, 'px', 'wall'],
    ['wallOrbs', 'Glow orbs over wallpaper', 0, 100, 1, '%', 'wall']
  ];
  const TOGGLES = [
    ['anim', 'Animations', 'Turn all motion on or off', 'motion'],
    ['stagger', 'Cards fly in one by one', '', 'motion'],
    ['tilt', '3D tilt on covers', 'Covers lean toward the pointer', 'motion'],
    ['spot', 'Pointer light on glass', 'A soft light follows the pointer', 'motion'],
    ['shimmer', 'Shimmer while loading', '', 'motion'],
    ['noise', 'Frosted grain', 'Fine grain on glass, like real frost', 'glass'],
    ['sideLabels', 'Show labels', 'Names under the sidebar icons', 'side'],
    ['bg3On', 'Three-colour background', 'Adds the third background colour to the fade', 'grad'],
    ['bgMove', 'Moving background', 'The gradient turns very slowly. Pauses while you scroll or read', 'grad'],
    ['glassGrad', 'Gradient glass', 'Glass panels fade from Glass panels into Glass fade', 'grad'],
    ['sideGrad', 'Gradient sidebar', 'Sidebar fades from Sidebar into Sidebar fade', 'grad'],
    ['titleGrad', 'Gradient titles', 'Page titles are filled with the accent gradient', 'grad'],
    ['dynLight', 'Dynamic light', 'On a series page the glows take the colours of its cover', 'glow']
  ];
  const BG_TYPES = [['linear', 'Straight fade'], ['radial', 'Round glow'], ['conic', 'Swirl'], ['solid', 'Solid colour']];
  const ACCENT_TYPES = [['gradient', 'Gradient'], ['solid', 'Solid']];
  const FEELS = [['smooth', 'Smooth: glides, no bounce on big moves'], ['springy', 'Springy: bouncy'], ['snappy', 'Snappy: quick']];
  const TRANSITIONS = [['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom'], ['blur', 'Blur'], ['rise', 'Rise'], ['none', 'None']];
  const FONTS = [
    ['Segoe UI Variable Display, Segoe UI, system-ui, sans-serif', 'Segoe'],
    ['Bahnschrift, Segoe UI, sans-serif', 'Bahnschrift'],
    ['Trebuchet MS, Segoe UI, sans-serif', 'Trebuchet'],
    ['Verdana, Segoe UI, sans-serif', 'Verdana'],
    ['Georgia, Times New Roman, serif', 'Georgia'],
    ['Cascadia Code, Consolas, monospace', 'Cascadia'],
    ['Gabriola, Georgia, serif', 'Gabriola'],
    ['Ink Free, Segoe Print, cursive', 'Ink Free']
  ];

  const BASE = {
    colors: {
      bg: ['#07081a', 100], bg2: ['#140a2a', 100], bg3: ['#0a2140', 100], glass2: ['#ffffff', 3], side2: ['#ffffff', 3], glow1: ['#6a5cff', 70], glow2: ['#00c8ff', 55], glow3: ['#ff4f9a', 50],
      accent: ['#8f7dff', 100], accent2: ['#38d6ff', 100], text: ['#f3f4ff', 100], muted: ['#c4c7ee', 70],
      glass: ['#ffffff', 8], edge: ['#ffffff', 18], shine: ['#ffffff', 30], side: ['#ffffff', 7], card: ['#0a0b20', 55],
      shadow: ['#000000', 45], badge: ['#ff4f9a', 100], readerBg: ['#050509', 100]
    },
    blur: 24, sat: 170, sideBlur: 28, edgeW: 1, shineAmt: 60, orbSize: 60, orbBlur: 90, accentGlow: 22, coverGlow: 34, textGlow: 0,
    speed: 1, orbMotion: 45, lift: 6, hscale: 103, bounce: 55, radius: 18, coverW: 158, fontScale: 100, sideSize: 100,
    bgType: 'linear', bgAngle: 135, bg3On: false, bgMove: false, bgSpeed: 90, accentType: 'gradient', accentAngle: 135,
    glassGrad: false, sideGrad: false, glassAngle: 160, titleGrad: false, dynLight: true, feel: 'smooth',
    wallDim: 35, wallBlur: 0, wallOrbs: 40,
    anim: true, stagger: true, tilt: true, spot: true, shimmer: true, noise: false, sideLabels: true, glassUi: true,
    transition: 'zoom', font: FONTS[0][0], titleFont: FONTS[0][0],
    side: 'left', sideStyle: 'island', sideMin: false
  };
  const preset = (name, over) => ({ name, theme: { ...BASE, ...over, colors: { ...BASE.colors, ...(over.colors || {}) } } });
  const PRESETS = [
    preset('Liquid glass', {}),
    preset('Aurora', { colors: { bg: ['#03110f', 100], bg2: ['#071a26', 100], glow1: ['#00ffa3', 55], glow2: ['#00b3ff', 50], glow3: ['#9b5cff', 45], accent: ['#2cf5b0', 100], accent2: ['#41a8ff', 100], badge: ['#2cf5b0', 100] }, transition: 'blur' }),
    preset('Sakura', { colors: { bg: ['#1a0812', 100], bg2: ['#2a0f22', 100], glow1: ['#ff6fae', 60], glow2: ['#ffb37a', 45], glow3: ['#b06cff', 45], accent: ['#ff7fb6', 100], accent2: ['#ffc38a', 100], muted: ['#f3c6dc', 70], badge: ['#ffb37a', 100] }, transition: 'rise' }),
    preset('Ocean depth', { colors: { bg: ['#020a18', 100], bg2: ['#03203a', 100], glow1: ['#0077ff', 65], glow2: ['#00e0ff', 45], glow3: ['#3d4bff', 45], accent: ['#3fb6ff', 100], accent2: ['#7cf0ff', 100], badge: ['#00e0ff', 100] }, transition: 'slide' }),
    preset('Ember', { colors: { bg: ['#140603', 100], bg2: ['#200c05', 100], glow1: ['#ff5a1f', 60], glow2: ['#ffb000', 45], glow3: ['#ff2a55', 45], accent: ['#ff7a3d', 100], accent2: ['#ffc23d', 100], muted: ['#f2c9b0', 70], badge: ['#ffb000', 100] } }),
    preset('Mono frost', { colors: { bg: ['#0b0b0e', 100], bg2: ['#16161c', 100], glow1: ['#ffffff', 18], glow2: ['#9aa0b5', 20], glow3: ['#5c6070', 25], accent: ['#ffffff', 100], accent2: ['#b8bccb', 100], badge: ['#ffffff', 100] }, accentGlow: 10, coverGlow: 18 }),
    preset('Daylight glass', { colors: { bg: ['#eef0ff', 100], bg2: ['#fbeaf4', 100], glow1: ['#8f7dff', 45], glow2: ['#38d6ff', 40], glow3: ['#ff7fb6', 40], accent: ['#6a55ff', 100], accent2: ['#1aa8e0', 100], text: ['#15162a', 100], muted: ['#3a3c5c', 70], glass: ['#ffffff', 45], edge: ['#ffffff', 70], shine: ['#ffffff', 70], side: ['#ffffff', 50], card: ['#ffffff', 60], shadow: ['#3a3c7a', 18], readerBg: ['#f4f4f8', 100] } }),
    preset('Neon night', { colors: { bg: ['#05000c', 100], bg2: ['#0a0018', 100], glow1: ['#ff00d4', 55], glow2: ['#00f0ff', 50], glow3: ['#7a00ff', 50], accent: ['#00f0ff', 100], accent2: ['#ff2bd6', 100], badge: ['#ff2bd6', 100] }, accentGlow: 40, coverGlow: 55, textGlow: 10, transition: 'zoom' })
  ];

  const hexRgb = h => { const n = parseInt(String(h).replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const rgba = ([h, a]) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${(Math.max(0, Math.min(100, a)) / 100).toFixed(3)})`; };
  const luminance = h => { const [r, g, b] = hexRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  function current() {
    const t = K.data.settings.theme || {};
    return { ...BASE, ...t, colors: { ...BASE.colors, ...(t.colors || {}) } };
  }

  function apply(t = current()) {
    const s = document.documentElement.style;
    for (const [k] of COLORS) s.setProperty('--' + k, rgba(t.colors[k]));
    // gradients: background, accent, glass, sidebar
    const C = k => 'var(--' + k + ')';
    const stops = t.bg3On ? [C('bg'), C('bg3'), C('bg2')] : [C('bg'), C('bg2')];
    s.setProperty('--bg-fill', t.bgType === 'solid' ? C('bg')
      : t.bgType === 'radial' ? `radial-gradient(130% 130% at 22% 12%, ${[...stops].reverse().join(', ')})`
      : t.bgType === 'conic' ? `conic-gradient(from ${t.bgAngle}deg at 50% 50%, ${stops.join(', ')}, ${C('bg')})`
      : `linear-gradient(${t.bgAngle}deg, ${stops.join(', ')})`);
    s.setProperty('--bg-dur', t.bgSpeed + 's');
    s.setProperty('--accent-grad', t.accentType === 'solid' ? C('accent') : `linear-gradient(${t.accentAngle}deg, ${C('accent')}, ${C('accent2')})`);
    s.setProperty('--accent-line', t.accentType === 'solid' ? C('accent') : `linear-gradient(90deg, ${C('accent')}, ${C('accent2')})`);
    s.setProperty('--glass-fill', t.glassGrad ? `linear-gradient(${t.glassAngle}deg, ${C('glass')}, ${C('glass2')})` : C('glass'));
    s.setProperty('--side-fill', t.sideGrad ? `linear-gradient(${t.glassAngle}deg, ${C('side')}, ${C('side2')})` : C('side'));
    s.setProperty('--wall-dim', String(t.wallDim / 100));
    s.setProperty('--wall-blur', t.wallBlur + 'px');
    s.setProperty('--wall-orbs', String(t.wallOrbs / 100));
    // Solid versions for things that must not be see-through.
    s.setProperty('--accent-solid', t.colors.accent[0]);
    s.setProperty('--on-accent', luminance(t.colors.accent[0]) > 0.45 ? '#0b0b14' : '#ffffff');
    s.setProperty('--blur', t.blur + 'px');
    s.setProperty('--sat', t.sat + '%');
    s.setProperty('--side-blur', t.sideBlur + 'px');
    s.setProperty('--edge-w', t.edgeW + 'px');
    s.setProperty('--shine-amt', String(t.shineAmt / 100));
    s.setProperty('--orb-size', t.orbSize + 'vmax');
    s.setProperty('--orb-blur', t.orbBlur + 'px');
    s.setProperty('--orb-fall', Math.round(45 + t.orbBlur / 200 * 30) + '%');
    s.setProperty('--accent-glow', t.accentGlow + 'px');
    s.setProperty('--cover-glow', t.coverGlow + 'px');
    s.setProperty('--text-glow', t.textGlow + 'px');
    s.setProperty('--spd', String(t.anim ? t.speed : 1));
    s.setProperty('--orb-dur', t.orbMotion > 0 ? (60 - t.orbMotion * 0.52).toFixed(1) + 's' : '1s');
    s.setProperty('--orb-play', t.anim && t.orbMotion > 0 ? 'running' : 'paused');
    s.setProperty('--lift', t.lift + 'px');
    s.setProperty('--hscale', String(t.hscale / 100));
    // Motion feel. Smooth: big moves (pages, drawers, menus) glide in with no overshoot and small things
    // get only a light spring. Springy: the old bouncy feel. Snappy: quicker, with a small spring.
    const o = (t.bounce / 100) * 0.9; // overshoot
    const feel = FEELS.some(f => f[0] === t.feel) ? t.feel : 'smooth';
    const spring = { smooth: 0.3, springy: 0.9, snappy: 0.35 }[feel];
    s.setProperty('--ease', `cubic-bezier(${feel === 'snappy' ? '.3' : '.2'}, ${(1 + o * spring).toFixed(2)}, .35, 1)`);
    s.setProperty('--ease-move', feel === 'springy' ? 'var(--ease)' : 'cubic-bezier(.16, 1, .3, 1)');
    s.setProperty('--feel', feel === 'snappy' ? '1.35' : feel === 'smooth' ? '.9' : '1');
    s.setProperty('--radius', t.radius + 'px');
    s.setProperty('--cover-w', t.coverW + 'px');
    s.setProperty('--font-scale', String(t.fontScale / 100));
    s.setProperty('--font', t.font);
    s.setProperty('--title-font', t.titleFont);
    s.setProperty('--side-size', String(t.sideSize / 100));
    const root = document.documentElement;
    const plain = t.glassUi === false;
    root.classList.toggle('plain', plain);
    root.classList.toggle('no-anim', !t.anim);
    root.classList.toggle('stagger', !!t.stagger && t.anim && !plain);
    root.classList.toggle('tilt', !!t.tilt && t.anim && !plain);
    root.classList.toggle('spot', !!t.spot && !plain);
    root.classList.toggle('shimmer', !!t.shimmer && t.anim);
    root.classList.toggle('grain', !!t.noise);
    root.classList.toggle('bg-move', !!t.bgMove && t.anim && !plain && t.bgType !== 'solid');
    root.classList.toggle('title-grad', !!t.titleGrad);
    root.classList.toggle('dyn-light', !!t.dynLight && !plain);
    if (!t.dynLight || plain) dynLight(null);
    paintWall(t);
    root.classList.toggle('light', luminance(t.colors.bg[0]) > 0.5);
    root.dataset.transition = !t.anim ? 'none' : plain ? 'fade' : t.transition;
    root.dataset.side = t.side;
    root.dataset.sideStyle = t.sideStyle;
    root.classList.toggle('side-min', !!t.sideMin);
    root.classList.toggle('side-labels', !!t.sideLabels);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = t.colors.bg[0];
    iconSoon(t);
  }

  // The app icon in your theme's colours: the window/taskbar icon on desktop, and the page icon.
  function iconSvg(t) {
    const c = t.colors, hex = k => c[k][0], op = k => (Math.max(15, c[k][1]) / 100).toFixed(2);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex('bg2')}"/><stop offset="1" stop-color="${hex('bg')}"/></linearGradient>
<radialGradient id="g1" cx=".2" cy=".15" r=".7"><stop offset="0" stop-color="${hex('glow1')}" stop-opacity="${op('glow1')}"/><stop offset="1" stop-color="${hex('glow1')}" stop-opacity="0"/></radialGradient>
<radialGradient id="g2" cx=".9" cy=".95" r=".7"><stop offset="0" stop-color="${hex('glow2')}" stop-opacity="${op('glow2')}"/><stop offset="1" stop-color="${hex('glow2')}" stop-opacity="0"/></radialGradient>
<radialGradient id="g3" cx=".85" cy=".1" r=".5"><stop offset="0" stop-color="${hex('glow3')}" stop-opacity="${op('glow3')}"/><stop offset="1" stop-color="${hex('glow3')}" stop-opacity="0"/></radialGradient>
<linearGradient id="sh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${hex('accent2')}"/></linearGradient>
<pattern id="h" width="8.5" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(-22)"><rect width="3.6" height="40" fill="url(#ink)"/></pattern>
<mask id="m"><g transform="translate(28 30) scale(2)"><path d="M17 10 L40 33 L60 33 L83 10 L81 45 L93 57 L50 92 L7 57 L19 45 Z" fill="#fff"/>
<path d="M27 54 L42 57 L37 62 Z" fill="#000"/><path d="M73 54 L58 57 L63 62 Z" fill="#000"/><path d="M27 30 L36 39 L25 41 Z" fill="#000"/><path d="M73 30 L64 39 L75 41 Z" fill="#000"/></g></mask></defs>
<rect width="256" height="256" rx="58" fill="url(#bg)"/><rect width="256" height="256" rx="58" fill="url(#g1)"/><rect width="256" height="256" rx="58" fill="url(#g2)"/><rect width="256" height="256" rx="58" fill="url(#g3)"/>
<rect x="2" y="2" width="252" height="252" rx="56" fill="url(#sh)"/><rect x="2" y="2" width="252" height="252" rx="56" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="3"/>
<rect width="256" height="256" fill="url(#h)" mask="url(#m)"/><path d="M117 194 L139 194 L128 208 Z" fill="#fff"/></svg>`;
  }
  let iconTimer = 0, lastIcon = '';
  function iconSoon(t) {
    clearTimeout(iconTimer);
    iconTimer = setTimeout(() => {
      const svg = iconSvg(t);
      if (svg === lastIcon) return;
      lastIcon = svg;
      const url = 'data:image/svg+xml;base64,' + btoa(svg);
      const link = document.querySelector('link[rel=icon]');
      if (link) link.href = url;
      if (K.info?.platform !== 'desktop') return;
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 256;
        cv.getContext('2d').drawImage(im, 0, 0, 256, 256);
        K.api.post('/k/window-icon', { png: cv.toDataURL('image/png') }).catch(() => {});
      };
      im.src = url;
    }, 600);
  }

  function set(patch) {
    const t = current();
    const next = { ...t, ...patch, colors: { ...t.colors, ...(patch.colors || {}) } };
    delete next.name;
    K.data.settings.theme = next;
    apply(next);
    K.save('settings');
    return next;
  }

  // ---------- custom wallpaper ----------
  // Kept in this PC's app storage (not in the theme), shrunk to the screen size once when you pick it.
  const WALL_KEY = 'koru-wallpaper';
  let wallUrl = null;
  try { wallUrl = localStorage.getItem(WALL_KEY); } catch {}
  function paintWall(t = current()) {
    const fx = document.querySelector('.bgfx');
    let w = fx?.querySelector('.wall');
    const on = !!wallUrl && t.glassUi !== false;
    document.documentElement.classList.toggle('has-wall', on);
    if (!on) { w?.remove(); return; }
    if (!w) { w = document.createElement('div'); w.className = 'wall'; fx?.prepend(w); }
    const css = `url("${wallUrl}")`;
    if (w.style.backgroundImage !== css) w.style.backgroundImage = css;
  }
  async function setWallpaper(file) {
    if (!file) { wallUrl = null; try { localStorage.removeItem(WALL_KEY); } catch {} paintWall(); return true; }
    const bmp = await createImageBitmap(file);
    const max = Math.min(3840, Math.max(1920, Math.round(Math.max(screen.width, screen.height) * devicePixelRatio)));
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close();
    for (const q of [0.9, 0.8, 0.68, 0.55]) {
      const url = cv.toDataURL('image/webp', q);
      if (url.length > 4.2e6) continue;
      try { localStorage.setItem(WALL_KEY, url); } catch { continue; }
      wallUrl = url; paintWall(); return true;
    }
    return false;
  }

  // ---------- dynamic light: the glows take a series cover's colours ----------
  // Three colours are picked from the cover and the orbs fade to them. Only the background layer changes.
  let dynKey = '';
  async function coverColors(url) {
    const r = await fetch(/^https:/.test(url) && K.viaKoru ? K.viaKoru(url) : url);
    if (!r.ok) throw new Error('cover');
    const bmp = await createImageBitmap(await r.blob(), { resizeWidth: 24, resizeHeight: 32, resizeQuality: 'low' });
    const cv = document.createElement('canvas'); cv.width = 24; cv.height = 32;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0); bmp.close();
    const d = cx.getImageData(0, 0, 24, 32).data, bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0, val = mx / 255;
      if (val < 0.12) continue;
      const key = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
      const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, w: 0 };
      e.n++; e.r += r; e.g += g; e.b += b; e.w += 0.25 + sat * 1.5 - (val > 0.92 && sat < 0.1 ? 0.2 : 0); bins.set(key, e);
    }
    const picks = [];
    for (const e of [...bins.values()].sort((a, b) => b.w - a.w)) {
      const c = [e.r / e.n, e.g / e.n, e.b / e.n];
      if (picks.every(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 70)) picks.push(c);
      if (picks.length === 3) break;
    }
    while (picks.length && picks.length < 3) picks.push(picks[picks.length - 1]);
    // lift dark or dull colours a little so they glow
    return picks.map(([r, g, b]) => { const k = Math.max(1, 170 / Math.max(r, g, b, 1)); return [r, g, b].map(v => Math.min(255, Math.round(v * k))); });
  }
  async function dynLight(url) {
    const fx = document.querySelector('.bgfx');
    if (!fx) return;
    const t = current();
    const key = url && t.dynLight && t.glassUi !== false ? url : '';
    if (key === dynKey) return;
    dynKey = key;
    const sets = [...fx.querySelectorAll('.dl')];
    const off = () => { fx.classList.remove('dyn'); sets.forEach(d => d.classList.remove('on')); };
    if (!key) { off(); return; }
    try {
      const cols = await coverColors(url);
      if (dynKey !== key || !cols.length) return;
      // paint the new colours into the spare set while it's invisible, then crossfade (opacity only)
      const next = sets.find(d => !d.classList.contains('on')) || sets[0];
      cols.forEach(([r, g, b], i) => next.style.setProperty('--c' + (i + 1), `rgba(${r},${g},${b},${Math.min(1, t.colors['glow' + (i + 1)][1] / 100 * 1.1).toFixed(3)})`));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
      if (dynKey !== key) return;
      sets.forEach(d => d.classList.toggle('on', d === next));
      fx.classList.add('dyn');
    } catch { if (dynKey === key) off(); }
  }
  // every series page shows its cover in .hero .bd, so the light follows whatever page is open
  function watchHero() {
    const main = document.getElementById('main');
    if (!main) return;
    let tm = 0;
    new MutationObserver(() => {
      clearTimeout(tm);
      tm = setTimeout(() => {
        const bd = main.querySelector('.view:not(.leave) .hero .bd');
        const m = bd && /url\("?(.*?)"?\)$/.exec(bd.style.backgroundImage || '');
        dynLight(m ? m[1] : null);
      }, 150);
    }).observe(main, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchHero); else watchHero();

  // ---------- your own saved looks ----------
  const LAYOUT_KEYS = ['side', 'sideStyle', 'sideMin', 'glassUi', 'name'];
  const myLooks = () => Array.isArray(K.data.settings.looks) ? K.data.settings.looks : [];
  function saveLook(name) {
    const th = structuredClone(current());
    for (const k of LAYOUT_KEYS) delete th[k];
    const list = myLooks().filter(l => l.name !== name);
    list.unshift({ name: String(name).slice(0, 40), theme: th, at: Date.now() });
    K.data.settings.looks = list.slice(0, 30);
    K.save('settings');
  }
  function useLook(l) { const th = structuredClone(l.theme); for (const k of LAYOUT_KEYS) delete th[k]; set(th); }
  function deleteLook(name) { K.data.settings.looks = myLooks().filter(l => l.name !== name); K.save('settings'); }

  K.theme = { COLORS, SLIDERS, TOGGLES, TRANSITIONS, FONTS, PRESETS, BASE, BG_TYPES, ACCENT_TYPES, FEELS, current, apply, set, rgba, hexRgb,
    myLooks, saveLook, useLook, deleteLook, setWallpaper, hasWallpaper: () => !!wallUrl, dynLight,
    // Looks only change colours and glows; layout, sidebar, style and everything else stay as you set them.
    reset: () => { const c = current(); set({ ...structuredClone(BASE), side: c.side, sideStyle: c.sideStyle, sideMin: c.sideMin, glassUi: c.glassUi }); },
    usePreset: p => { const t = p.theme; set({ colors: structuredClone(t.colors), accentGlow: t.accentGlow, coverGlow: t.coverGlow, textGlow: t.textGlow }); } };
})();
