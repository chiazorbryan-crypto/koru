// Koru settings: Appearance (every colour, transparency, glass, glow, motion, shape, text, sidebar),
// Reader, Library and data, About.
'use strict';
(function () {
  const { el, icon } = K;
  const T = () => K.theme;

  function slider(label, value, min, max, step, unit, onInput, sub) {
    const v = el('span.val');
    const r = el('input', { type: 'range', min, max, step, value });
    const fmt = x => (unit === '×' ? Number(x).toFixed(2) : Number(x)) + unit;
    const paint = () => { r.style.setProperty('--p', ((r.value - min) / (max - min)) * 100 + '%'); v.textContent = fmt(r.value); };
    paint();
    r.oninput = () => { paint(); onInput(Number(r.value)); };
    return el('div.ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), r, v);
  }
  function toggle(label, on, onChange, sub) {
    const t = el('button.toggle' + (on ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!on) });
    t.onclick = () => { const v = !t.classList.contains('on'); t.classList.toggle('on', v); t.setAttribute('aria-checked', String(v)); onChange(v); };
    return el('div.ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), t);
  }
  function select(label, options, value, onChange) {
    const s = el('select.sel-in', options.map(([v, l]) => el('option', { value: v, text: l, selected: v === value })));
    s.onchange = () => onChange(s.value);
    return el('div.ctl', el('div.lab', { text: label }), s);
  }
  function colorRow(key, label, sub) {
    const [hex, a] = T().current().colors[key];
    const fill = el('i', { style: { background: T().rgba([hex, a]) } });
    const pick = el('input', { type: 'color', value: hex });
    const val = el('span.val', { text: a + '%' });
    const alpha = el('input.alpha', { type: 'range', min: 0, max: 100, step: 1, value: a, title: 'Transparency' });
    const paint = () => { alpha.style.setProperty('--p', alpha.value + '%'); val.textContent = alpha.value + '%'; fill.style.background = T().rgba([pick.value, Number(alpha.value)]); };
    paint();
    const commit = () => { paint(); T().set({ colors: { [key]: [pick.value, Number(alpha.value)] } }); };
    pick.oninput = commit; alpha.oninput = commit;
    return el('div.ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), el('label.swatch', { title: 'Pick a colour' }, fill, pick), alpha, val);
  }
  const panel = (ic, title, sub, ...kids) => el('section.panel.glass', el('h3', icon(ic), title), sub ? el('p', { text: sub }) : null, ...kids);

  K.views.settings = async function (root) {
    root.append(el('div.head', el('div', el('h1', { text: 'Settings' }), el('div.sub', { text: 'Make Koru yours. Every change shows up right away.' }))));
    const body = el('div');
    root.append(body);
    const draw = () => {
      const scroll = root.closest('.view')?.scrollTop;
      body.replaceChildren(build());
      if (scroll) root.closest('.view').scrollTop = scroll;
    };
    draw();

    function build() {
      const t = T().current();
      const set = patch => T().set(patch);
      const grid = el('div.set-grid');

      // presets
      const presetBox = el('div.presets', T().PRESETS.map(p => {
        const c = p.theme.colors;
        const same = JSON.stringify(c) === JSON.stringify(t.colors);
        return el('button.preset' + (same ? '.on' : ''), { onclick: () => { T().usePreset(p); draw(); setTimeout(K.movePill, 400); } },
          el('div.pv', { style: { background: `linear-gradient(135deg, ${c.bg[0]}, ${c.bg2[0]})` } },
            el('i', { style: { background: c.glow1[0], left: '-10px', top: '-14px' } }), el('i', { style: { background: c.glow2[0], right: '-12px', bottom: '-20px' } }),
            el('i', { style: { background: c.glow3[0], left: '40%', top: '20%', width: '36px', height: '36px' } }), el('b')),
          el('span', { text: p.name }));
      }));
      grid.append(panel('palette', 'Style', 'Liquid glass, or a plain, fast, normal app look. Your colours carry over.',
        el('div.ctl', el('div.lab', { text: 'App style' }),
          K.segmented([['glass', 'Liquid glass', 'sparkle'], ['plain', 'Normal', 'list']], t.glassUi === false ? 'plain' : 'glass', v => { set({ glassUi: v === 'glass' }); setTimeout(K.movePill, 300); }))));
      grid.append(panel('sparkle', 'Looks', 'Picking a look only changes colours and glows. Your layout and other settings stay.', presetBox,
        el('div.row', { style: { marginTop: '14px' } },
          el('button.btn.small', { onclick: () => { T().reset(); draw(); } }, icon('refresh'), 'Reset to Liquid glass'),
          el('button.btn.small', { onclick: async () => { try { await navigator.clipboard.writeText(JSON.stringify(T().current())); K.toast('Theme copied', 'ok'); } catch { K.toast('Couldn\'t copy', 'error'); } } }, icon('copy'), 'Copy theme'),
          el('button.btn.small', { onclick: async () => {
            try {
              const txt = await navigator.clipboard.readText();
              const j = JSON.parse(txt);
              if (!j || typeof j !== 'object' || !j.colors) throw new Error();
              T().set(j); draw(); K.toast('Theme pasted', 'ok');
            } catch { K.toast('Copy a Koru theme first, then paste.', 'error'); }
          } }, icon('upload'), 'Paste theme'))));

      // colours
      grid.append(panel('palette', 'Colours', 'Each colour has its own transparency slider.',
        ...T().COLORS.map(([k, label, sub]) => colorRow(k, label, sub))));

      const S = g => T().SLIDERS.filter(s => s[6] === g).map(([k, label, min, max, step, unit]) => slider(label, t[k], min, max, step, unit, v => set({ [k]: v })));
      const G = g => T().TOGGLES.filter(x => x[3] === g).map(([k, label, sub]) => toggle(label, t[k], v => set({ [k]: v }), sub));

      grid.append(panel('sparkle', 'Glass', 'How frosted, bright and outlined the glass is.', ...S('glass'), ...G('glass')));
      grid.append(panel('sparkle', 'Glow', 'The light orbs behind the glass, and glows on buttons, covers and titles.', ...S('glow')));
      grid.append(panel('refresh', 'Motion', 'Animations across the app.', ...G('motion').slice(0, 1),
        select('Page change', T().TRANSITIONS, t.transition, v => set({ transition: v })), ...S('motion'), ...G('motion').slice(1)));
      grid.append(panel('book', 'Shape and text', '',
        ...S('shape'),
        select('Font', T().FONTS, t.font, v => set({ font: v })),
        select('Title font', T().FONTS, t.titleFont, v => set({ titleFont: v }))));

      // sidebar
      const pos = el('div.sidepos', [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']].map(([v, l]) => {
        const bar = { left: { left: '3px', top: '3px', bottom: '3px', width: '9px' }, right: { right: '3px', top: '3px', bottom: '3px', width: '9px' },
          top: { left: '3px', right: '3px', top: '3px', height: '8px' }, bottom: { left: '3px', right: '3px', bottom: '3px', height: '8px' } }[v];
        return el('button' + (t.side === v ? '.on' : ''), { onclick: () => { set({ side: v }); draw(); setTimeout(K.movePill, 450); } }, el('span.mini', el('i', { style: bar })), l);
      }));
      grid.append(panel('list', 'Sidebar', 'Where it sits and how it looks. Use the arrow at its end to minimize it.',
        pos,
        el('div.ctl', { style: { marginTop: '8px' } }, el('div.lab', { text: 'Style' }),
          K.segmented([['island', 'Floating island'], ['attached', 'Attached to edge']], t.sideStyle, v => { set({ sideStyle: v }); setTimeout(K.movePill, 400); })),
        toggle('Start minimized', t.sideMin, v => { set({ sideMin: v }); setTimeout(K.movePill, 400); }),
        ...S('side').map(n => { n.querySelector('input').addEventListener('input', K.debounce(K.movePill, 60)); return n; }),
        ...G('side').map(n => { n.querySelector('button').addEventListener('click', () => setTimeout(K.movePill, 60)); return n; })));

      // reader
      const ro = K.readerSettings();
      const setR = patch => { K.data.settings.reader = { ...K.readerSettings(), ...patch }; K.save('settings'); };
      grid.append(panel('book', 'Reader', 'Defaults for every chapter. You can also change these while reading.',
        el('div.ctl', el('div.lab', { text: 'Layout' }), K.segmented([['strip', 'Long strip', 'scroll'], ['paged', 'Pages', 'pages']], ro.mode, v => setR({ mode: v }))),
        slider('Page width', ro.width, 400, 1600, 20, 'px', v => setR({ width: v })),
        slider('Gap between pages', ro.gap, 0, 40, 1, 'px', v => setR({ gap: v })),
        slider('Pages to load ahead', ro.preload, 1, 10, 1, '', v => setR({ preload: v })),
        toggle('Ambient light', ro.ambient, v => setR({ ambient: v }), 'A soft glow from the page you\'re on fills the space around it'),
        slider('Ambient strength', ro.ambStrength, 0, 100, 1, '%', v => setR({ ambStrength: v })),
        slider('Ambient softness', ro.ambBlur, 20, 220, 5, 'px', v => setR({ ambBlur: v })),
        toggle('Right to left', ro.rtl, v => setR({ rtl: v }), 'For manga in page mode'),
        toggle('Auto next chapter', ro.autoNext, v => setR({ autoNext: v })),
        toggle('Tap sides to turn', ro.tapZones, v => setR({ tapZones: v })),
        toggle('Zen mode', ro.zen, v => setR({ zen: v }), 'Chapters open full screen with just the pages. Press Z while reading to switch'),
        toggle('Show frame rate', ro.fps, v => setR({ fps: v }), 'A small meter while reading, to check for lag')));

      if (K.info?.platform === 'desktop') {
        const stat = el('div.gpustat', el('span', { text: 'Checking your graphics card…' }));
        const body = el('div');
        grid.append(panel('sparkle', 'Graphics', 'If reading lags on a PC, try these. Changes apply when Koru restarts.', stat, body));
        K.api.get('/k/gpu').then(g => {
          const soft = K.gpuSoftware(g);
          const real = g.devices.filter(d => !/Basic Render|software/i.test(d.name + d.vendor));
          const act = real.find(d => d.active) || real[0] || g.devices[0];
          const others = real.filter(d => d !== act);
          const hz = el('span');
          stat.classList.toggle('bad', soft);
          stat.replaceChildren(...[
            el('b', { text: !g.now.accel ? 'Hardware acceleration is off' : soft ? 'Drawing without the graphics card (slow)' : 'Drawing with ' + (act ? (act.name || act.vendor) : 'the graphics card') }),
            soft ? el('span', { text: 'Turn on "Use the card even if it\'s blocked" below and restart, or update your graphics driver.' }) : null,
            act?.driver ? el('span', { text: 'Driver ' + act.driver }) : null,
            others.length ? el('span', { text: 'Also in this PC: ' + others.map(d => d.name || d.vendor).join(', ') }) : null,
            el('span', { text: `Screen ${Math.round(screen.width * devicePixelRatio)}×${Math.round(screen.height * devicePixelRatio)}` }, hz)].filter(Boolean));
          // measure the screen's refresh rate (middle frame gap, once the page has settled)
          const gaps = []; let last = 0;
          const tick = t => { if (last) gaps.push(t - last); last = t; if (gaps.length < 90) requestAnimationFrame(tick); else { gaps.sort((x, y) => x - y); hz.textContent = ` at about ${Math.round(1000 / gaps[45])} Hz`; } };
          setTimeout(() => requestAnimationFrame(tick), 800);
          let saved = g.saved;
          const restart = el('button.btn.small' + (JSON.stringify(g.saved) !== JSON.stringify(g.now) ? '.primary' : ''), { onclick: () => K.api.post('/k/relaunch') }, icon('refresh'), 'Restart Koru');
          const put = patch => fetch('/k/gpu', { method: 'PUT', body: JSON.stringify(patch) }).then(r => r.json()).then(j => {
            saved = j.saved; restart.classList.toggle('primary', JSON.stringify(saved) !== JSON.stringify(g.now));
            K.toast('Saved. Restart Koru to use it.');
          });
          body.replaceChildren(
            select('Graphics card', [['high', 'Fastest card (NVIDIA / AMD)'], ['auto', 'Let Windows choose'], ['low', 'Power saving (built-in)']], saved.gpu, v => put({ gpu: v })),
            toggle('Hardware acceleration', saved.accel, v => put({ accel: v }), 'Draw with the graphics card. Only turn off if pages flicker or go black.'),
            select('Drawing mode', [['default', 'Default'], ['d3d11', 'DirectX 11'], ['d3d9', 'DirectX 9 (try this if NVIDIA stutters)'], ['gl', 'OpenGL'], ['vulkan', 'Vulkan']], saved.angle, v => put({ angle: v })),
            toggle('Use the card even if it\'s blocked', saved.blocklist, v => put({ blocklist: v }), 'Some drivers are on Chromium\'s blocklist, which makes everything slow'),
            el('div.row', { style: { marginTop: '8px' } }, restart));
        }).catch(() => stat.replaceChildren(el('span', { text: 'Couldn\'t check the graphics card.' })));
      }

      // data
      const fileIn = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
      fileIn.onchange = async () => {
        try {
          const j = JSON.parse(await fileIn.files[0].text());
          if (!j || j.app !== 'koru') throw new Error();
          for (const k of ['library', 'liked', 'bookmarks', 'flags', 'history', 'read']) if (j[k] && typeof j[k] === 'object') { K.data[k] = { ...K.data[k], ...j[k] }; K.save(k); }
          K.toast('Library imported', 'ok');
        } catch { K.toast('That isn\'t a Koru backup.', 'error'); }
        fileIn.value = '';
      };
      grid.append(panel('incognito', 'Privacy', '',
        toggle('Incognito', K.incognito(), v => { K.data.settings.incognito = v; K.save('settings'); K.paintInc?.(); }, 'Reading history, progress and read marks aren\'t saved. Also in the sidebar.')));
      grid.append(panel('folder', 'Library and data', 'Back up your library, likes, bookmarks, reading history and read marks.',
        el('div.row',
          el('button.btn.small', { onclick: () => {
            const blob = new Blob([JSON.stringify({ app: 'koru', at: new Date().toISOString(), library: K.data.library, liked: K.data.liked, bookmarks: K.data.bookmarks, flags: K.data.flags, history: K.data.history, read: K.data.read }, null, 1)], { type: 'application/json' });
            const a = el('a', { href: URL.createObjectURL(blob), download: `koru-backup-${new Date().toISOString().slice(0, 10)}.json` });
            document.body.append(a); a.click(); a.remove();
          } }, icon('download'), 'Export backup'),
          el('button.btn.small', { onclick: () => fileIn.click() }, icon('upload'), 'Import backup'), fileIn,
          el('button.btn.small', { onclick: () => { if (!confirm('Clear your reading history? Your library and downloads stay.')) return; K.data.history = {}; K.data.read = {}; K.save('history'); K.save('read'); K.toast('History cleared'); } }, icon('trash'), 'Clear history'))));

      grid.append(panel('sparkle', 'About', '',
        el('div.row', { style: { gap: '14px' } }, el('div.side-logo', { style: { margin: 0 } }, K.fox()),
          el('div', el('b', { text: 'Koru ' + (K.info?.version || '') }), el('div.muted', { text: 'A personal reader for Omega Scans and Vortex Scans.' }))),
        el('p.muted', { style: { fontSize: '.85em', marginTop: '12px' }, text: 'Koru reads each site\'s public pages. Paid or locked chapters stay locked. Please support the scan groups on their sites.' })));
      return grid;
    }
  };
})();
