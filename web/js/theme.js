// Koru appearance: every colour (with its own transparency), glass, glow, motion, shape, text and sidebar.
// The theme lives in K.data.settings.theme and is applied as CSS variables on <html>.
'use strict';
(function () {
  // Each colour is [hex, opacity 0-100].
  const COLORS = [
    ['bg', 'App background', 'Base colour behind everything'],
    ['bg2', 'Background fade', 'Second colour the background fades into'],
    ['glow1', 'Glow orb 1', 'Big soft light behind the glass'],
    ['glow2', 'Glow orb 2', ''],
    ['glow3', 'Glow orb 3', ''],
    ['accent', 'Accent', 'Buttons, active items, progress'],
    ['accent2', 'Accent blend', 'Second accent colour for gradients'],
    ['text', 'Text', ''],
    ['muted', 'Soft text', 'Labels and secondary text'],
    ['glass', 'Glass panels', 'Tint and transparency of glass'],
    ['edge', 'Glass edges', 'Outline around glass'],
    ['shine', 'Glass shine', 'The light streak on glass'],
    ['side', 'Sidebar', 'Sidebar glass tint'],
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
    ['speed', 'Animation speed', 0.25, 3, 0.05, '×', 'motion'],
    ['orbMotion', 'Orb drift', 0, 100, 1, '%', 'motion'],
    ['lift', 'Hover lift', 0, 24, 1, 'px', 'motion'],
    ['hscale', 'Hover zoom', 100, 112, 1, '%', 'motion'],
    ['bounce', 'Bounciness', 0, 100, 1, '%', 'motion'],
    ['radius', 'Corner roundness', 0, 36, 1, 'px', 'shape'],
    ['coverW', 'Cover size', 110, 240, 2, 'px', 'shape'],
    ['fontScale', 'Text size', 85, 130, 1, '%', 'shape'],
    ['sideSize', 'Sidebar size', 80, 130, 1, '%', 'side']
  ];
  const TOGGLES = [
    ['anim', 'Animations', 'Turn all motion on or off', 'motion'],
    ['stagger', 'Cards fly in one by one', '', 'motion'],
    ['tilt', '3D tilt on covers', 'Covers lean toward the pointer', 'motion'],
    ['spot', 'Pointer light on glass', 'A soft light follows the pointer', 'motion'],
    ['shimmer', 'Shimmer while loading', '', 'motion'],
    ['noise', 'Frosted grain', 'Fine grain on glass, like real frost', 'glass'],
    ['sideLabels', 'Show labels', 'Names under the sidebar icons', 'side']
  ];
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
      bg: ['#07081a', 100], bg2: ['#140a2a', 100], glow1: ['#6a5cff', 70], glow2: ['#00c8ff', 55], glow3: ['#ff4f9a', 50],
      accent: ['#8f7dff', 100], accent2: ['#38d6ff', 100], text: ['#f3f4ff', 100], muted: ['#c4c7ee', 70],
      glass: ['#ffffff', 8], edge: ['#ffffff', 18], shine: ['#ffffff', 30], side: ['#ffffff', 7], card: ['#0a0b20', 55],
      shadow: ['#000000', 45], badge: ['#ff4f9a', 100], readerBg: ['#050509', 100]
    },
    blur: 24, sat: 170, sideBlur: 28, edgeW: 1, shineAmt: 60, orbSize: 60, orbBlur: 90, accentGlow: 22, coverGlow: 34, textGlow: 0,
    speed: 1, orbMotion: 45, lift: 6, hscale: 103, bounce: 55, radius: 18, coverW: 158, fontScale: 100, sideSize: 100,
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
    const o = (t.bounce / 100) * 0.9; // overshoot
    s.setProperty('--ease', `cubic-bezier(.2, ${(1 + o * 0.9).toFixed(2)}, .35, 1)`);
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

  K.theme = { COLORS, SLIDERS, TOGGLES, TRANSITIONS, FONTS, PRESETS, BASE, current, apply, set, rgba, hexRgb,
    // Looks only change colours and glows; layout, sidebar, style and everything else stay as you set them.
    reset: () => { const c = current(); set({ ...structuredClone(BASE), side: c.side, sideStyle: c.sideStyle, sideMin: c.sideMin, glassUi: c.glassUi }); },
    usePreset: p => { const t = p.theme; set({ colors: structuredClone(t.colors), accentGlow: t.accentGlow, coverGlow: t.coverGlow, textGlow: t.textGlow }); } };
})();
