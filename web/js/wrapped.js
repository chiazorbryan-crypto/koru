// Koru Wrapped: a look back at a month or a year of reading, saved as a picture if you like.
// Also "Surprise me" (a random series you don't have yet) and "Today's pick" (one suggestion a day).
// Smoothness: only transform/opacity animate (wrapped.css), entrances run once, nothing reads layout in a loop.
'use strict';
(function () {
  const { icon } = K;
  // K.el, plus `vars` for CSS custom properties (style['--x'] = … doesn't set them; setProperty does)
  const el = (spec, props, ...kids) => {
    if (!props || typeof props !== 'object' || !props.vars) return K.el(spec, props, ...kids);
    const { vars, ...rest } = props, n = K.el(spec, rest, ...kids);
    for (const [k, v] of Object.entries(vars)) n.style.setProperty(k, String(v));
    return n;
  };
  const P = id => K.providers?.[id];
  const DAY = 864e5;

  // ---------- small helpers ----------
  const fmt = ms => { const m = Math.round((ms || 0) / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  const hourMood = h => h < 5 ? 'Night owl' : h < 9 ? 'Early bird' : h < 12 ? 'Morning reader' : h < 17 ? 'Afternoon reader' : h < 21 ? 'Evening reader' : 'Late-night reader';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  };
  const inLib = (provider, slug) => !!K.data.library?.[K.key(provider, slug)];
  const blocked = (provider, slug) => { const f = K.flag(provider, slug); return !!(f.trash || f.hidden); };
  const seriesHref = (provider, slug) => `#/series/${provider}/${encodeURIComponent(slug)}`;
  // a small string hash, so the daily pick is the same all day
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const popular = (p, page) => K.cached(`l:${p.id}:popular:${page}`, 5 * 60e3, () => p.list({ sort: 'popular', page }));

  // ---------- the numbers for a period ----------
  function periodRange(kind) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    if (kind === 'year') {
      const start = new Date(now.getFullYear(), 0, 1), end = new Date(now.getFullYear(), 11, 31);
      return { start, end, name: String(now.getFullYear()), label: String(now.getFullYear()), file: String(now.getFullYear()) };
    }
    const back = kind === 'last' ? 1 : 0;
    const start = new Date(now.getFullYear(), now.getMonth() - back, 1), end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    return { start, end, name: start.toLocaleDateString(undefined, { month: 'long' }), label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      file: start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') };
  }

  function crunch(kind) {
    const r = periodRange(kind);
    const st = K.data.stats || {}, days = st.days || {}, meta = st.series || {};
    const from = K.dayKey(r.start), to = K.dayKey(r.end);
    const inRange = Object.entries(days).filter(([d]) => d >= from && d <= to);
    let total = 0, chapters = 0, daysRead = 0, busiest = null, hasHours = false;
    const per = {}, hours = new Array(24).fill(0);
    for (const [d, x] of inRange) {
      total += x.ms || 0; chapters += x.ch || 0;
      if ((x.ms || 0) >= 60000 || x.ch) daysRead++;
      if ((x.ms || 0) > 0 && (!busiest || x.ms > busiest.ms)) busiest = { day: d, ms: x.ms, ch: x.ch || 0 };
      for (const [k, ms] of Object.entries(x.s || {})) (per[k] ||= { ms: 0, ch: 0 }).ms += ms;
      for (const [k, n] of Object.entries(x.c || {})) (per[k] ||= { ms: 0, ch: 0 }).ch += n;
      if (x.h && typeof x.h === 'object') for (const [h, ms] of Object.entries(x.h)) { const i = Number(h); if (i >= 0 && i < 24 && ms > 0) { hours[i] += ms; hasHours = true; } }
    }
    const seriesList = Object.entries(per).filter(([, x]) => x.ms >= 60000 || x.ch).sort((a, b) => b[1].ms - a[1].ms || b[1].ch - a[1].ch)
      .map(([k, x]) => {
        const m = meta[k] || {}, [provider, ...rest] = k.split(':'), slug = m.slug || rest.join(':');
        return { key: k, provider, slug, title: m.title || K.data.library?.[k]?.title || K.data.history?.[k]?.title || slug,
          cover: m.cover || K.data.library?.[k]?.cover || K.data.history?.[k]?.cover || null, ms: x.ms, ch: x.ch };
      });
    // favourite source: the one you spent the most time in
    const bySrc = {};
    for (const s of seriesList) { const b = bySrc[s.provider] ||= { id: s.provider, ms: 0, n: 0 }; b.ms += s.ms; b.n++; }
    const fav = Object.values(bySrc).sort((a, b) => b.ms - a.ms)[0] || null;
    // best streak inside the period: days in a row with a minute or more
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const last = r.end > today ? today : r.end;
    let best = { n: 0 }, run = 0, runStart = null;
    for (let d = new Date(r.start); d <= last; d.setDate(d.getDate() + 1)) {
      if ((days[K.dayKey(d)]?.ms || 0) >= 60000) {
        if (!run) runStart = new Date(d);
        run++;
        if (run > best.n) best = { n: run, start: runStart, end: new Date(d) };
      } else run = 0;
    }
    const spanDays = Math.max(1, Math.round((last - r.start) / DAY) + 1);
    // badges earned in the period
    const endMs = r.end.getTime() + DAY;
    const defs = K.lively?.BADGES || [];
    const badges = Object.entries(st.badges || {})
      .map(([id, at]) => ({ id, at: typeof at === 'number' ? at : Date.parse(at) }))
      .filter(b => b.at >= r.start.getTime() && b.at < endMs)
      .sort((a, b) => a.at - b.at)
      .map(b => { const d = defs.find(x => x.id === b.id); return { id: b.id, at: b.at, e: d?.e || '🏅', name: d?.name || b.id, desc: d?.desc || '' }; });
    const peak = hasHours ? hours.indexOf(Math.max(...hours)) : -1;
    return { r, total, chapters, daysRead, busiest, seriesList, fav, best, spanDays, badges, hours, hasHours, peak,
      empty: total < 60000 && !chapters };
  }

  // ---------- the page ----------
  K.views = K.views || {};
  K.views.wrapped = async function (root, r, alive) {
    let kind = sessionStorage.getItem('koru-wrapp') || 'month';
    if (!['month', 'last', 'year'].includes(kind)) kind = 'month';
    let data = null;
    const save = el('button.btn', { title: 'Save this as a picture', onclick: () => saveImage(data, save) }, icon('download'), 'Save as image');
    root.append(el('div.head.wr-head',
      el('a.btn.icon', { href: '#/stats', title: 'Back to Stats', 'aria-label': 'Back to Stats' }, icon('back')),
      el('div', el('h1', { text: 'Koru Wrapped' }), el('div.sub', { text: 'Your reading, all wrapped up' })),
      el('div.sp'), save));
    const pick = (K.segmented || fallbackSeg)([['month', 'This month'], ['last', 'Last month'], ['year', 'This year']], kind, v => {
      kind = v; sessionStorage.setItem('koru-wrapp', v); draw();
    });
    const body = el('div.wr-body');
    root.append(el('div.row.wr-bar', pick), body);

    function draw() {
      data = crunch(kind);
      save.disabled = data.empty;
      if (data.empty) {
        body.replaceChildren(el('div.empty.wr-empty', K.fox(),
          el('h3', { text: kind === 'year' ? 'Nothing read this year yet' : `Nothing read in ${data.r.name} yet` }),
          el('p', { text: 'Open a chapter and read for a bit. Your Wrapped fills in as you go.' }),
          el('div.row', { style: { justifyContent: 'center' } }, el('a.btn.primary', { href: '#/explore' }, icon('explore'), 'Find something'))));
        return;
      }
      let i = 0;
      const card = (cls, ic, title, ...kids) => el('div.glass.wr-card' + (cls ? '.' + cls : ''), { vars: { '--i': ++i } },
        el('div.wr-c', el('h3', icon(ic), title), ...kids));
      const cards = [
        topCard(card), favCard(card), dayCard(card), streakCard(card), clockCard(card), badgeCard(card)
      ];
      body.replaceChildren(hero(), el('div.wr-grid', ...cards));
    }

    function hero() {
      const d = data;
      return el('div.wr-hero',
        K.fox('wr-fox'),
        el('div.wr-k', { text: 'Koru Wrapped · ' + d.r.label }),
        el('h2', { text: `Your ${d.r.name} in Koru` }),
        el('div.wr-big', { text: fmt(d.total) }),
        el('div.wr-cap', { text: `of reading, ${d.total / d.spanDays < 60000 ? "under a minute" : "about " + fmt(d.total / d.spanDays)} a day` }),
        el('div.wr-nums',
          num(d.chapters, d.chapters === 1 ? 'chapter' : 'chapters'),
          num(d.seriesList.length, d.seriesList.length === 1 ? 'series' : 'series'),
          num(d.daysRead, d.daysRead === 1 ? 'day read' : 'days read')));
    }
    const num = (n, label) => el('div.wr-num', el('b', { text: String(n) }), el('small', { text: label }));

    function topCard(card) {
      const top = data.seriesList.slice(0, 5);
      if (!top.length) return card('wr-wide', 'chart', 'Top series', el('p.wr-note', { text: 'Finish a chapter or read for a minute and your top series show up here.' }));
      const best = top[0].ms || 1;
      return card('wr-wide', 'chart', top.length > 1 ? `Your top ${top.length}` : 'Your top series',
        el('div.wr-top', ...top.map((s, j) => el('a.wr-row', { href: seriesHref(s.provider, s.slug), vars: { '--j': j } },
          el('span.wr-rank', { text: String(j + 1) }),
          el('div.wr-th', K.img(s.cover, '', '', 48)),
          el('div.wr-tinfo', el('b', { text: s.title }),
            el('small.muted', { text: (P(s.provider)?.name || s.provider) + (s.ch ? ' · ' + plural(s.ch, 'chapter') : '') }),
            el('div.wr-tbar', el('i', { vars: { '--w': Math.max(0.02, s.ms / best).toFixed(3) } }))),
          el('b.wr-time', { text: fmt(s.ms) })))));
    }
    function favCard(card) {
      const f = data.fav;
      if (!f) return card('', 'explore', 'Favourite source', el('p.wr-note', { text: 'Read a little more to find out.' }));
      const share = data.total ? Math.round(f.ms / data.total * 100) : 0;
      const p = P(f.id);
      return card('', 'explore', 'Favourite source',
        el('div.wr-val', el('i.wr-dot', { style: { background: p?.hue || 'var(--accent-solid)' } }), p?.name || f.id),
        el('p.wr-note', { text: `${fmt(f.ms)} there${share ? `, ${share}% of your reading` : ''} · ${plural(f.n, 'series', 'series')}` }));
    }
    function dayCard(card) {
      const b = data.busiest;
      if (!b) return card('', 'clock', 'Busiest day', el('p.wr-note', { text: 'No full reading day yet.' }));
      const d = new Date(b.day + 'T00:00');
      return card('', 'clock', 'Busiest day',
        el('div.wr-val', { text: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) }),
        el('p.wr-note', { text: fmt(b.ms) + ' of reading' + (b.ch ? ' · ' + plural(b.ch, 'chapter') : '') }));
    }
    function streakCard(card) {
      const s = data.best;
      const short = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return card('', 'sparkle', 'Best streak',
        el('div.wr-val', { text: s.n ? plural(s.n, 'day') + ' in a row' : 'No streak yet' }),
        el('p.wr-note', { text: s.n > 1 ? `${short(s.start)} – ${short(s.end)}, a minute or more each day` : s.n === 1 ? short(s.start) + '. Read two days running to start a streak.' : 'Read a minute or more on days in a row to build one.' }));
    }
    function clockCard(card) {
      if (!data.hasHours) return card('', 'clock', 'Reading clock', el('p.wr-note', { text: 'This fills in as you read. Koru now notes the time of day you read, so check back soon.' }));
      const max = Math.max(...data.hours) || 1;
      return card('', 'clock', 'Reading clock',
        el('div.wr-val', { text: hourMood(data.peak) }),
        el('p.wr-note', { text: 'You read the most around ' + hourLabel(data.peak) }),
        el('div.wr-clock', ...data.hours.map((ms, h) => el('div.wr-hb' + (h === data.peak ? '.peak' : ''), { title: hourLabel(h) + ': ' + (ms ? fmt(ms) : 'no reading'), vars: { '--j': h } },
          el('i', { vars: { '--h': ms ? Math.max(0.06, ms / max).toFixed(3) : '0.03' } })))),
        el('div.wr-ticks', ...[0, 6, 12, 18].map(h => el('span', { text: hourLabel(h) }))));
    }
    function badgeCard(card) {
      const b = data.badges;
      return card(b.length > 3 ? 'wr-wide' : '', 'check', b.length ? `Badges earned · ${b.length}` : 'Badges',
        b.length ? el('div.wr-badges', ...b.map(x => el('div.wr-badge', { title: x.desc },
          el('span.e', { text: x.e }), el('span', el('b', { text: x.name }), el('small.muted', { text: new Date(x.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })))))
          : el('p.wr-note', { text: 'No new badges this time. Keep reading and they turn up.' }));
    }

    draw();
  };

  // only used if views.js didn't provide K.segmented
  function fallbackSeg(options, value, onChange) {
    const seg = el('div.row');
    const paint = v => [...seg.children].forEach(b => b.classList.toggle('on', b.dataset.v === v));
    for (const [v, label] of options) seg.append(el('button.chip', { dataset: { v }, onclick: () => { paint(v); onChange(v); } }, label));
    paint(value);
    return seg;
  }

  // ---------- Save as image: a 1080×1350 card drawn on a canvas ----------
  const hexOk = c => typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim());
  function themeColors() {
    let c = {};
    try { c = K.theme?.current?.().colors || {}; } catch {}
    const sc = K.data.settings?.theme?.colors || {};
    const pick = (k, def) => { const v = (c[k] || sc[k])?.[0]; return hexOk(v) ? v.trim() : def; };
    return { a1: pick('accent', '#8f7dff'), a2: pick('accent2', '#38d6ff'), bg: pick('bg', '#07081a'), bg2: pick('bg2', null) };
  }
  function lum(hex) {
    let h = hex.replace('#', ''); if (h.length === 3) h = [...h].map(x => x + x).join('');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fit(ctx, text, maxW) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
    return text.slice(0, lo).trimEnd() + '…';
  }
  async function loadCover(src) {
    if (!src) return null;
    try {
      const res = await withTimeout(fetch(/^https:\/\//.test(src) ? K.viaKoru(src) : src), 10000);
      if (!res.ok) return null;
      return await createImageBitmap(await res.blob());
    } catch { return null; }
  }
  async function saveImage(d, btn) {
    if (!d || d.empty) return;
    const label = btn.lastChild;
    btn.disabled = true; btn.classList.add('wr-busy'); if (label) label.textContent = 'Drawing…';
    try {
      const W = 1080, H = 1350;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const col = themeColors(), light = lum(col.bg) > 0.5;
      const ink = light ? '#15162a' : '#ffffff', soft = light ? 'rgba(21,22,42,.66)' : 'rgba(255,255,255,.72)';
      const panel = light ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.08)';
      let font = 'Segoe UI Variable Display, Segoe UI, system-ui, sans-serif';
      try { const f = getComputedStyle(document.documentElement).getPropertyValue('--font').trim(); if (f && !/var\(/.test(f)) font = f; } catch {}
      const F = (w, s) => `${w} ${s}px ${font}`;
      const covers = await Promise.all(d.seriesList.slice(0, 3).map(s => loadCover(s.cover)));

      // background: theme colour, two soft glows, then a gentle accent wash
      ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
      if (col.bg2) { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, col.bg); g.addColorStop(1, col.bg2); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
      const glow = (x, y, rad, c, a) => { const g = ctx.createRadialGradient(x, y, 0, x, y, rad); ctx.globalAlpha = a; g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; };
      glow(W * 0.1, H * 0.05, 820, col.a1, light ? 0.45 : 0.6);
      glow(W * 0.95, H * 0.7, 760, col.a2, light ? 0.35 : 0.45);
      const wash = ctx.createLinearGradient(0, 0, W, H); wash.addColorStop(0, col.a1); wash.addColorStop(1, col.a2);
      ctx.globalAlpha = light ? 0.12 : 0.16; ctx.fillStyle = wash; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;

      const X = 84;
      ctx.textBaseline = 'alphabetic';
      // header pill
      ctx.font = F(700, 28);
      const tag = 'KORU WRAPPED · ' + d.r.label.toUpperCase(), tw = ctx.measureText(tag).width;
      rr(ctx, X, 84, tw + 48, 58, 29); ctx.fillStyle = wash; ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.fillText(tag, X + 24, 123);
      // title
      ctx.fillStyle = ink; ctx.font = F(800, 76);
      ctx.fillText(fit(ctx, `Your ${d.r.name}`, W - X * 2), X, 250);
      ctx.fillText('in Koru', X, 336);
      // the big number
      ctx.font = F(800, 150);
      const big = fmt(d.total);
      const bg = ctx.createLinearGradient(X, 0, X + ctx.measureText(big).width, 0); bg.addColorStop(0, col.a1); bg.addColorStop(1, col.a2);
      ctx.fillStyle = light ? ink : bg; ctx.fillText(big, X - 4, 500);
      ctx.fillStyle = soft; ctx.font = F(500, 34); ctx.fillText(`of reading, ${d.total / d.spanDays < 60000 ? "under a minute" : "about " + fmt(d.total / d.spanDays)} a day`, X, 556);
      // three numbers
      const nums = [[d.chapters, d.chapters === 1 ? 'chapter' : 'chapters'], [d.seriesList.length, 'series'], [d.daysRead, d.daysRead === 1 ? 'day read' : 'days read']];
      const nw = (W - X * 2 - 40) / 3;
      nums.forEach(([n, l], i) => {
        const x = X + i * (nw + 20);
        rr(ctx, x, 600, nw, 150, 28); ctx.fillStyle = panel; ctx.fill();
        ctx.fillStyle = ink; ctx.font = F(800, 60); ctx.fillText(fit(ctx, String(n), nw - 56), x + 28, 680);
        ctx.fillStyle = soft; ctx.font = F(500, 28); ctx.fillText(l, x + 28, 724);
      });
      // top 3 covers
      const top = d.seriesList.slice(0, 3);
      ctx.fillStyle = ink; ctx.font = F(700, 34); ctx.fillText(top.length > 1 ? `Top ${top.length} series` : 'Top series', X, 822);
      const cw = 220, ch = 308, gap = (W - X * 2 - cw * 3) / 2;
      top.forEach((s, i) => {
        const x = X + i * (cw + gap), y = 852, bmp = covers[i];
        ctx.save(); rr(ctx, x, y, cw, ch, 24); ctx.clip();
        if (bmp) {
          const sc = Math.max(cw / bmp.width, ch / bmp.height), w = bmp.width * sc, h = bmp.height * sc;
          ctx.drawImage(bmp, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
        } else {
          const g = ctx.createLinearGradient(x, y, x + cw, y + ch); g.addColorStop(0, col.a1); g.addColorStop(1, col.a2);
          ctx.fillStyle = g; ctx.fillRect(x, y, cw, ch);
          ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = F(800, 110); ctx.textAlign = 'center';
          ctx.fillText((s.title || '?').trim().charAt(0).toUpperCase(), x + cw / 2, y + ch / 2 + 38); ctx.textAlign = 'left';
        }
        ctx.restore();
        // rank chip
        rr(ctx, x + 14, y + 14, 52, 52, 26); ctx.fillStyle = wash; ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.font = F(800, 28); ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x + 40, y + 50); ctx.textAlign = 'left';
        ctx.fillStyle = ink; ctx.font = F(700, 27); ctx.fillText(fit(ctx, s.title, cw), x, y + ch + 40);
        ctx.fillStyle = soft; ctx.font = F(500, 24); ctx.fillText(fmt(s.ms), x, y + ch + 74);
      });
      bmpClose(covers);
      // footer
      ctx.fillStyle = soft; ctx.font = F(600, 28); ctx.textAlign = 'center';
      ctx.fillText('Koru · Made by B0nX', W / 2, H - 46); ctx.textAlign = 'left';

      const blob = await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('Couldn\'t make the picture.'))), 'image/png'));
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `koru-wrapped-${d.r.file}.png` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      K.toast('Saved your Wrapped picture', 'ok');
    } catch (e) {
      K.toast(e?.message || 'Couldn\'t save the picture.', 'error');
    } finally {
      btn.disabled = false; btn.classList.remove('wr-busy'); if (label) label.textContent = 'Save as image';
    }
  }
  const bmpClose = list => list.forEach(b => { try { b?.close?.(); } catch {} });

  // ---------- Surprise me + Today's pick ----------
  const pool = items => (items || []).filter(s => s && s.slug && s.provider && !inLib(s.provider, s.slug) && !blocked(s.provider, s.slug));

  function surpriseButton() {
    const label = el('span', { text: 'Surprise me' });
    const btn = el('button.btn.lv-surprise', { title: 'Open a random popular series you don\'t have yet', onclick: go }, icon('sparkle'), label);
    let busy = false;
    async function go() {
      if (busy) return;
      busy = true; btn.disabled = true; btn.classList.add('busy'); label.textContent = 'Looking…';
      try {
        const list = [...(K.providerList || [])];
        for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
        for (const p of list.slice(0, 4)) {
          try {
            const page = Math.random() < 0.5 ? 1 : 2;
            let res = await withTimeout(popular(p, page), 15000);
            let items = pool((res?.items || []).map(s => ({ ...s, provider: s.provider || p.id })));
            if (!items.length && page === 2) { res = await withTimeout(popular(p, 1), 15000); items = pool((res?.items || []).map(s => ({ ...s, provider: s.provider || p.id }))); }
            if (!items.length) continue;
            const s = items[Math.floor(Math.random() * items.length)];
            K.go(`/series/${s.provider}/${encodeURIComponent(s.slug)}`);
            return;
          } catch {}
        }
        K.toast('Couldn\'t reach the sources right now. Try again in a bit.', 'error');
      } finally {
        busy = false; btn.disabled = false; btn.classList.remove('busy'); label.textContent = 'Surprise me';
      }
    }
    return btn;
  }

  const DAILY = 'koru-daily', DAILY_HIDE = 'koru-daily-hide';
  async function findDaily(day) {
    try { const c = JSON.parse(store.get(DAILY) || 'null'); if (c?.day === day && c.item?.slug && K.providers?.[c.item.provider]) return c.item; } catch {}
    const list = K.providerList || [], n = list.length;
    if (!n) return null;
    const seed = hash(day);
    for (let t = 0; t < Math.min(3, n); t++) {
      const p = list[(seed + t) % n];
      try {
        const res = await withTimeout(popular(p, 1), 15000);
        const items = pool((res?.items || []).map(s => ({ ...s, provider: s.provider || p.id })));
        if (!items.length) continue;
        const s = items[hash(day + ':' + p.id) % items.length];
        const item = { provider: s.provider, slug: s.slug, title: s.title || s.slug, cover: s.cover || null };
        store.set(DAILY, JSON.stringify({ day, item }));
        return item;
      } catch {}
    }
    return null;
  }

  function dailyPick(container) {
    if (!container) return;
    const day = K.dayKey();
    if (store.get(DAILY_HIDE) === day) return;
    const idle = window.requestIdleCallback ? fn => requestIdleCallback(fn, { timeout: 2500 }) : fn => setTimeout(fn, 1200);
    idle(async () => {
      try {
        if (!container.isConnected || container.querySelector('.lv-daily')) return;
        const item = await findDaily(day);
        if (!item || !container.isConnected || container.querySelector('.lv-daily') || store.get(DAILY_HIDE) === day) return;
        const open = () => K.go(`/series/${item.provider}/${encodeURIComponent(item.slug)}`);
        const box = el('div.lv-daily',
          el('div.lv-cv', { onclick: open, title: 'Open ' + item.title }, K.img(item.cover, item.title, '', 60)),
          el('div.lv-info',
            el('div.lv-k', icon('sparkle'), 'Today\'s pick'),
            el('b.lv-t', { text: item.title, title: item.title }),
            el('small.muted', { text: (P(item.provider)?.name || item.provider) + (inLib(item.provider, item.slug) ? ' · in your favourites' : ' · popular right now') }),
            el('div.row.lv-act', el('button.btn.small.primary', { onclick: open }, icon('play'), 'Take a look'))),
          el('button.lv-x', { title: 'Hide for today', 'aria-label': 'Hide for today', onclick: e => {
            e.stopPropagation(); store.set(DAILY_HIDE, day);
            box.classList.add('lv-out'); setTimeout(() => box.remove(), 260);
          } }, icon('x')));
        container.append(box);
      } catch {}
    });
  }

  K.lively2 = { surpriseButton, dailyPick };
})();
