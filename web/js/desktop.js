// Koru on the Windows desktop (desktop app only):
//  - Koru wallpaper: right-click a page in the reader → "Set as desktop wallpaper". The page is fitted to your screen
//    (fill, or fit with a blurred copy behind), saved as a PNG in Koru's data folder and set by the taskbar helper.
//  - Save picture: the page as it came from the site
//  - Desktop widget: Settings switch for the small Up next / new chapters window (web/widget.html)
'use strict';
(function () {
  const { el, icon } = K;
  const W = K.wallpaper = {};
  const desktop = () => K.info?.platform === 'desktop';

  // The page drawn at w×h. fill: covers the screen, cropped around focusY (the spot you right-clicked, 0 top … 1 bottom).
  // fit: the whole page, on a blurred and dimmed copy of itself.
  W.compose = async function (blob, w, h, mode, focusY = 0.5) {
    const bmp = await createImageBitmap(blob);
    try {
      const iw = bmp.width, ih = bmp.height;
      const c = new OffscreenCanvas(w, h), cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      const cover = Math.max(w / iw, h / ih);
      const sw = w / cover, sh = h / cover, sx = (iw - sw) / 2, sy = Math.max(0, Math.min(ih - sh, focusY * ih - sh / 2));
      if (mode === 'fit') {
        // the blur is done small (cheap and smooth), then stretched over the screen
        const bw = Math.max(16, Math.round(w / 12)), bh = Math.max(16, Math.round(h / 12));
        const b = new OffscreenCanvas(bw, bh), bx = b.getContext('2d');
        bx.filter = 'blur(6px) brightness(.55) saturate(1.25)';
        bx.drawImage(bmp, sx, sy, sw, sh, -bw * 0.1, -bh * 0.1, bw * 1.2, bh * 1.2);   // a bit larger, so the blurred edges stay off-screen
        cx.drawImage(b, 0, 0, w, h);
        const fit = Math.min(w / iw, h / ih), dw = iw * fit, dh = ih * fit;
        cx.shadowColor = 'rgba(0,0,0,.45)'; cx.shadowBlur = Math.round(Math.min(w, h) / 40);
        cx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      return await c.convertToBlob({ type: 'image/png' });
    } finally { bmp.close(); }
  };

  let screenSize = null;
  const screenOf = async () => screenSize || (screenSize = await K.api.get('/k/wallpaper').catch(() => ({ w: Math.round(screen.width * devicePixelRatio), h: Math.round(screen.height * devicePixelRatio) })));
  W.set = async function (blob, mode, focusY) {
    const { w, h } = await screenOf();
    const png = await W.compose(blob, w, h, mode, focusY);
    const r = await fetch('/k/wallpaper?mode=' + mode, { method: 'POST', body: png });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Couldn\'t set the wallpaper.');
    return j;
  };

  // A sheet with both looks side by side; pick one.
  W.open = async function (info) {
    let blob;
    try { blob = await info.file(); } catch { K.toast('That page didn\'t load. Try again once it shows.', 'error'); return; }
    const { w, h } = await screenOf();
    document.querySelector('.lx-sheetwrap')?.remove();
    const pw = 300, ph = Math.round(pw * h / w);
    const opts = el('div.wp-opts');
    const wrap = el('div.lx-sheetwrap', { onclick: e => { if (e.target === wrap) close(); } },
      el('div.lx-sheet.wp-sheet', { role: 'dialog', 'aria-label': 'Set as desktop wallpaper' },
        el('div.lx-shead', el('div', el('h2', { text: 'Set as desktop wallpaper' }),
          el('small.muted', { text: `Page ${info.page + 1} of ${String(info.chapterName || '').replace(/ — .*/, '')}, sized for your ${w}×${h} screen. Pick a look.` })),
          el('button.btn.small.icon', { title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
        el('div.lx-sbody', opts)));
    const urls = [];
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { document.removeEventListener('keydown', esc, true); wrap.classList.add('out'); setTimeout(() => { wrap.remove(); urls.forEach(u => URL.revokeObjectURL(u)); }, 200); }
    document.addEventListener('keydown', esc, true);
    document.body.append(wrap);
    for (const [mode, label, sub] of [['fill', 'Fill the screen', 'Cropped around the spot you right-clicked'], ['fit', 'Whole page', 'With a blurred copy behind it']]) {
      const pic = el('div.wp-pic', { style: { aspectRatio: `${w} / ${h}` } }, el('div.spinner'));
      const btn = el('button.wp-opt.glass', { onclick: async () => {
        opts.querySelectorAll('button').forEach(b => { b.disabled = true; });
        btn.querySelector('small').textContent = 'Setting…';
        try {
          const r = await W.set(blob, mode, info.focusY);
          K.toast(r.fake ? 'Wallpaper made (test run: your real wallpaper wasn\'t changed)' : 'Wallpaper set', 'ok');
          close();
        } catch (e) { K.toast(e.message, 'error'); opts.querySelectorAll('button').forEach(b => { b.disabled = false; }); btn.querySelector('small').textContent = sub; }
      } }, pic, el('b', { text: label }), el('small.muted', { text: sub }));
      opts.append(btn);
      W.compose(blob, pw * 2, ph * 2, mode, info.focusY).then(b => { const u = URL.createObjectURL(b); urls.push(u); pic.replaceChildren(el('img', { src: u, alt: label })); }, () => pic.replaceChildren(el('small.muted', { text: 'No preview' })));
    }
  };

  // The page as it came, with a name that says where it's from.
  W.save = async function (info) {
    let blob;
    try { blob = await info.file(); } catch { K.toast('That page didn\'t load. Try again once it shows.', 'error'); return; }
    const ext = ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[blob.type] || 'jpg';
    const name = `${info.title || 'Koru'} - ${String(info.chapterName || '').replace(/ — .*/, '')} - page ${info.page + 1}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const a = el('a', { href: URL.createObjectURL(blob), download: name + '.' + ext });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };

  (K.pageMenuItems ||= []).push(info => K.info?.platform === 'android' ? [] : [
    desktop() ? ['image', 'Set as desktop wallpaper…', () => W.open(info)] : null,
    ['download', 'Save picture', () => W.save(info)]
  ].filter(Boolean));

  // ---------- Settings: the desktop widget ----------
  (K.settingsExtras ||= []).push(() => {
    if (!desktop()) return null;
    const box = el('div', el('small.muted', { text: 'Checking…' }));
    K.api.get('/k/widget').then(st => {
      const t = el('button.toggle' + (st.on ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!st.on) });
      t.onclick = async () => {
        const v = !t.classList.contains('on');
        t.classList.toggle('on', v); t.setAttribute('aria-checked', String(v));
        try { await K.api.post('/k/widget', { on: v }); K.toast(v ? 'The widget is on your desktop. Drag it anywhere.' : 'Widget off', 'ok'); }
        catch (e) { K.toast(e.message, 'error'); }
      };
      box.replaceChildren(el('div.ctl', el('div.lab', 'Desktop widget', el('small', { text: 'A small glass window on your desktop with Up next and new chapters. Drag it anywhere; click one to open it. Koru remembers where you put it' })), t));
    }).catch(() => box.replaceChildren(el('small.muted', { text: 'The widget needs the desktop app.' })));
    return el('section.panel.glass', el('h3', icon('pages'), 'Desktop'), el('p', { text: 'Koru on your desktop. To make a page your wallpaper, right-click it in the reader.' }), box);
  });
})();
