// Koru reader: Translate raw chapters. The Translate button in the reader's top bar reads the speech bubbles on the
// pages near the screen (OCR with Tesseract, on its own background thread), translates them with Google's free
// endpoint (through Koru's background side) and covers each bubble with a white box holding the translation.
// One page at a time, never on the scroll path. Tesseract (web/vendor/tesseract) is only loaded on first use; the
// language data is downloaded once by the background side (/k/tessdata) and kept, so it works offline afterwards.
// OCR results and translations are kept per page, so a page read before shows its translation straight away.
'use strict';
(function () {
  const { el, icon } = K;
  const SOURCES = [['auto', 'Auto-detect'], ['kor', 'Korean'], ['jpn', 'Japanese'], ['chi_sim', 'Chinese (Simplified)'], ['chi_tra', 'Chinese (Traditional)']];
  const TARGETS = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'],
    ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['id', 'Indonesian'], ['ms', 'Malay'],
    ['tl', 'Filipino'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['ko', 'Korean'], ['ja', 'Japanese'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)']];
  const NAMES = { kor: 'Korean', jpn: 'Japanese', chi_sim: 'Chinese', chi_tra: 'Chinese', auto: 'Korean, Japanese and Chinese' };
  const GOOGLE = { kor: 'ko', jpn: 'ja', chi_sim: 'zh-CN', chi_tra: 'zh-TW' };
  // Tesseract language sets. Japanese manga is often written in vertical columns, so the vertical model rides along.
  const TESS = { kor: 'kor', jpn: 'jpn+jpn_vert', chi_sim: 'chi_sim', chi_tra: 'chi_tra', auto: 'kor+jpn+chi_sim' };
  // page layout mode: 11 = sparse text (bubbles scattered over art)
  const PSM = { kor: '11', jpn: '11', chi_sim: '11', chi_tra: '11', auto: '11' };
  const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/g, KANA = /[ぁ-ヺヽ-ヿㇰ-ㇿｦ-ﾟ]/g, HAN = /[㐀-䶿一-鿿豈-﫿]/g;
  const TRAD = /[們這個說來時會對發還開關國學點應過與當進動門問間長見實氣頭樣邊無種體電話讓認從後經變現萬裡麼為嗎嗎聽覺讀寫買賣錢愛]/g;
  const SIMP = /[们这个说来时会对发还开关国学点应过与当进动门问间长见实气头样边无种体电话让认从后经变现万里么为吗听觉读写买卖钱爱]/g;
  const count = (s, re) => (s.match(re) || []).length;
  const scriptCount = (s, lang) => lang === 'kor' ? count(s, HANGUL) : lang === 'jpn' ? count(s, KANA) + count(s, HAN) : lang === 'auto' ? count(s, HANGUL) + count(s, KANA) + count(s, HAN) : count(s, HAN);

  const opts = () => ({ to: 'en', from: 'auto', ...(K.data.settings.translate || {}) });
  const setOpts = patch => { K.data.settings.translate = { ...opts(), ...patch }; K.save('settings'); };
  const android = () => K.info?.platform === 'android';   // the Android app has no OCR data route (yet)
  const abs = p => new URL(p, location.href).href;

  let on = false, busy = false, watchT = 0, idleT = 0;
  let io = null, ioRoot = null, rootStats = null;
  const near = new Set();

  // ---------- styles (kept here so the feature is one file) ----------
  const css = `
.ktr-layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2;container-type:inline-size}
html.ktr-hide .ktr-layer{display:none}
.ktr-b{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;contain:layout paint;
  background:#fff;color:#111;border-radius:.9em;box-shadow:0 0 0 1px rgba(0,0,0,.06);font:600 12px/1.13 "Segoe UI","Noto Sans",system-ui,sans-serif;text-align:center}
.ktr-b>span{display:block;width:92%;overflow-wrap:normal;word-break:normal;hyphens:manual;text-wrap:balance}
.ktr-chip{position:absolute;left:50%;top:calc(var(--titlebar, 0px) + 74px);transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:8px;
  padding:7px 14px;border-radius:99px;font-size:.86em;pointer-events:none;white-space:nowrap;max-width:calc(100% - 32px);overflow:hidden;text-overflow:ellipsis;transition:opacity .25s}
.ktr-chip.out{opacity:0}
.ktr-spin{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:ktr-spin .8s linear infinite}
@keyframes ktr-spin{to{transform:rotate(360deg)}}
.rbar .ktr-btn.on{color:var(--accent-solid);border-color:var(--accent)}`;
  document.head.append(el('style', { text: css }));

  // ---------- progress chip ----------
  let chipT = 0;
  function chip(text, spin, ms) {
    const r = document.querySelector('.reader');
    let c = r?.querySelector(':scope > .ktr-chip');
    clearTimeout(chipT);
    if (!text) { if (c) { c.classList.add('out'); chipT = setTimeout(() => c.remove(), 300); } return; }
    if (!r) return;
    if (!c) c = r.appendChild(el('div.ktr-chip.glass.out'));
    c.replaceChildren(...(spin ? [el('i.ktr-spin')] : []), el('span', { text }));
    c._timed = !!ms;
    requestAnimationFrame(() => c.classList.remove('out'));
    if (ms) chipT = setTimeout(() => chip(null), ms);
  }

  // ---------- saved results: per page url, the bubbles found and their translations ----------
  let cache = null, cacheP = null, saveT = 0;
  const loadCache = () => cacheP ||= K.api.load('translate-cache').then(c => { cache = c && c.pages ? c : { pages: {}, series: {} }; cache.series ||= {}; }, () => { cache = { pages: {}, series: {} }; });
  function put(url, e) {
    e.at = Date.now(); cache.pages[url] = e;
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const keys = Object.keys(cache.pages);
      if (keys.length > 400) keys.sort((a, b) => cache.pages[a].at - cache.pages[b].at).slice(0, keys.length - 400).forEach(k => delete cache.pages[k]);
      K.api.save('translate-cache', cache).catch(() => {});
    }, 1500);
  }

  // ---------- Tesseract (loaded on first use) ----------
  let libP = null, wk = null, wkLangs = '';
  const loadLib = () => libP ||= new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = el('script', { src: 'vendor/tesseract/tesseract.min.js' });
    s.onload = () => res();
    s.onerror = () => { libP = null; rej(new Error('Couldn\'t load the text reader.')); };
    document.head.append(s);
  });
  async function worker(lang) {
    const langs = TESS[lang];
    if (wk && wkLangs === langs) return wk;
    await loadLib();
    const slow = setTimeout(() => chip(`Getting ready to read ${NAMES[lang]} (the first time downloads a few MB)…`, true), 1200);
    try {
      if (!wk) {
        wk = await window.Tesseract.createWorker(langs, 1, {
          workerPath: abs('vendor/tesseract/worker.min.js'), workerBlobURL: false,
          corePath: abs('vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
          langPath: abs('/k/tessdata'), gzip: false, cacheMethod: 'none'
        });
      } else await wk.reinitialize(langs, 1);
      wkLangs = langs;
      await wk.setParameters({ tessedit_pageseg_mode: PSM[lang], preserve_interword_spaces: '1' });
      return wk;
    } catch (e) {
      try { await wk?.terminate(); } catch {}
      wk = null; wkLangs = '';
      throw new Error(`Couldn't get the ${NAMES[lang]} reading data. Check your connection and try again.`);
    } finally { clearTimeout(slow); }
  }
  const stopWorker = () => { clearTimeout(idleT); if (wk) { wk.terminate().catch(() => {}); wk = null; wkLangs = ''; } };

  // ---------- reading a page ----------
  const STOP = new Error('stopped');
  const clean = (s, lang) => {
    s = String(s || '').replace(/[|_~^`{}[\]<>\\]/g, ' ');
    return lang === 'kor' || (lang === 'auto' && count(s, HANGUL) > 0) ? s.replace(/\s+/g, ' ').trim() : s.replace(/\s+/g, '');
  };
  // Lines of text -> bubbles: lines close to each other (about a line apart) and of a similar size belong together.
  function group(lines, lang) {
    const n = lines.length, up = lines.map((_, i) => i);
    const find = i => (up[i] === i ? i : (up[i] = find(up[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = lines[i], b = lines[j];
      const ta = Math.min(a.w, a.h), tb = Math.min(b.w, b.h);
      if (Math.max(ta, tb) / Math.max(1, Math.min(ta, tb)) > 1.9) continue;
      const g = 0.75 * Math.min(ta, tb);
      if (a.x - g < b.x + b.w && b.x - g < a.x + a.w && a.y - g < b.y + b.h && b.y - g < a.y + a.h) up[find(i)] = find(j);
    }
    const sets = new Map();
    lines.forEach((l, i) => { const r = find(i); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(l); });
    const out = [];
    for (const ls of sets.values()) {
      const vertical = ls.filter(l => l.h > l.w * 1.6).length > ls.length / 2;
      ls.sort(vertical ? (a, b) => b.x - a.x : (a, b) => a.y - b.y);   // vertical columns read right to left
      const text = clean(ls.map(l => l.text).join(lang === 'kor' ? ' ' : ''), lang);
      const len = ls.reduce((s, l) => s + l.text.length, 0) || 1;
      const conf = ls.reduce((s, l) => s + l.conf * l.text.length, 0) / len;
      const cjk = scriptCount(text, lang);
      // a lone sound effect, or art and English lettering misread as CJK (those read with low confidence)
      if (cjk < 2 || conf < 70 || (cjk === 2 && conf < 80) || count(text, /[A-Za-z]/g) > cjk) continue;
      const x0 = Math.min(...ls.map(l => l.x)), y0 = Math.min(...ls.map(l => l.y));
      const x1 = Math.max(...ls.map(l => l.x + l.w)), y1 = Math.max(...ls.map(l => l.y + l.h));
      const t = ls.map(l => Math.min(l.w, l.h)).sort((a, b) => a - b)[ls.length >> 1];
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, t, s: text, conf: Math.round(conf) });
    }
    return out;
  }
  // The white box: the text's area plus a margin, at least about as wide as tall (vertical Japanese columns
  // would otherwise leave a sliver for horizontal English), kept inside the page.
  function boxes(blocks, W, H) {
    return blocks.map(b => {
      const pad = Math.max(4, b.t * 0.45);
      let x = b.x - pad, y = b.y - pad * 0.8, w = b.w + pad * 2, h = b.h + pad * 1.6;
      if (w < h * 0.8) { const nw = h * 0.8; x -= (nw - w) / 2; w = nw; }
      x = Math.max(0, x); y = Math.max(0, y); w = Math.min(W - x, w); h = Math.min(H - y, h);
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), s: b.s, c: b.conf };
    });
  }
  // OCR one page. Tall webtoon pages are read in overlapping pieces; a line counts in the piece where it sits
  // well inside (its middle in that piece's own part), so lines cut at a piece's edge are never used.
  async function ocr(blob, lang) {
    const w = await worker(lang);
    const bmp = await createImageBitmap(blob);
    try {
      const W = bmp.width, H = bmp.height;
      const scale = Math.max(1, Math.min(2, 1100 / W));   // small text reads better a little larger
      const CH = Math.round(2200 / scale), OV = Math.round(420 / scale);
      const starts = [];
      if (H <= CH * 1.15) starts.push(0); else for (let y = 0; ; y += CH - OV) { if (y + CH >= H) { starts.push(Math.max(0, H - CH)); break; } starts.push(y); }
      const lines = [];
      for (let k = 0; k < starts.length; k++) {
        if (!on) throw STOP;
        const y0 = starts[k], h = Math.min(CH, H - y0) || H;
        const cw = Math.round(W * scale), ch = Math.round(h * scale);
        const cv = new OffscreenCanvas(cw, ch), cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
        cx.drawImage(bmp, 0, y0, W, h, 0, 0, cw, ch);
        const png = await cv.convertToBlob({ type: 'image/png' });
        if (!on) throw STOP;
        const { data } = await w.recognize(png, {}, { text: false, blocks: true });
        // each piece owns the part up to the middle of its overlap with the next one
        const top = k === 0 ? 0 : (y0 + starts[k - 1] + CH) / 2, bot = k === starts.length - 1 ? H : (starts[k + 1] + y0 + h) / 2;
        for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
          const text = String(l.text || '').trim();
          if (!text || l.confidence < 40 || !scriptCount(text, lang)) continue;
          const bb = l.bbox, x = bb.x0 / scale, y = bb.y0 / scale + y0, lw = (bb.x1 - bb.x0) / scale, lh = (bb.y1 - bb.y0) / scale;
          const mid = y + lh / 2;
          if (mid < top || mid >= bot || lw < 3 || lh < 3) continue;
          lines.push({ x, y, w: lw, h: lh, text, conf: l.confidence });
        }
      }
      let blocks = group(lines, lang);
      if (lang === 'jpn') blocks = await vertical(w, bmp, blocks, scale);
      return { w: W, h: H, blocks: boxes(blocks, W, H) };
    } finally { bmp.close(); }
  }
  // Japanese bubbles are often vertical columns, which the sparse layout reads across. A bubble that's taller than
  // wide is read again on its own as one block of vertical text, and that reading is kept when it's at least as sure.
  async function vertical(w, bmp, blocks, scale) {
    const tall = blocks.filter(b => b.h > b.w * 1.1);
    if (!tall.length) return blocks;
    await w.setParameters({ tessedit_pageseg_mode: '5' });
    try {
      for (const b of tall) {
        if (!on) throw STOP;
        const m = Math.max(b.w, b.h);   // the across-reading often finds only the middle of the columns: look well around it
        const x0 = Math.max(0, b.x - m * 0.35), y0 = Math.max(0, b.y - m * 0.8), x1 = Math.min(bmp.width, b.x + b.w + m * 0.35), y1 = Math.min(bmp.height, b.y + b.h + m * 0.8);
        const cw = Math.round((x1 - x0) * scale), ch = Math.round((y1 - y0) * scale);
        if (cw < 8 || ch < 8) continue;
        const cv = new OffscreenCanvas(cw, ch), cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
        cx.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, cw, ch);
        const { data } = await w.recognize(await cv.convertToBlob({ type: 'image/png' }), {}, { text: false, blocks: true });
        const ls = [];
        for (const bl of data.blocks || []) for (const p of bl.paragraphs || []) for (const l of p.lines || []) {
          const text = String(l.text || '').trim();
          if (!text || l.confidence < 40 || !scriptCount(text, 'jpn')) continue;
          const bb = l.bbox;
          ls.push({ x: x0 + bb.x0 / scale, y: y0 + bb.y0 / scale, w: (bb.x1 - bb.x0) / scale, h: (bb.y1 - bb.y0) / scale, text, conf: l.confidence });
        }
        if (!ls.length) continue;
        ls.sort((a, c) => c.x - a.x);
        const text = clean(ls.map(l => l.text).join(''), 'jpn');
        const len = ls.reduce((s2, l) => s2 + l.text.length, 0) || 1, conf = ls.reduce((s2, l) => s2 + l.conf * l.text.length, 0) / len;
        if (scriptCount(text, 'jpn') < scriptCount(b.s, 'jpn') * 0.8 || conf < b.conf - 3) continue;
        const bx0 = Math.min(b.x, ...ls.map(l => l.x)), by0 = Math.min(b.y, ...ls.map(l => l.y));
        const bx1 = Math.max(b.x + b.w, ...ls.map(l => l.x + l.w)), by1 = Math.max(b.y + b.h, ...ls.map(l => l.y + l.h));
        Object.assign(b, { s: text, conf: Math.round(conf), x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0, t: ls.map(l => Math.min(l.w, l.h)).sort((a, c) => a - c)[ls.length >> 1] });
      }
    } finally { await w.setParameters({ tessedit_pageseg_mode: PSM.jpn }); }
    return blocks;
  }
  function detect(blocks) {
    // English pages give a few short, unsure "CJK" bits (art and lettering misread): ask for real sentences
    const cjk = s => count(s, HANGUL) + count(s, KANA) + count(s, HAN);
    const all = blocks.filter(b => b.c >= 80).map(b => b.s).join('');
    if (!blocks.some(b => b.c >= 85 && cjk(b.s) >= 5) && cjk(all) < 10) return null;
    const hg = count(all, HANGUL), kn = count(all, KANA), hn = count(all, HAN);
    if (hg >= 2 && hg >= (kn + hn) * 0.6) return 'kor';
    if (kn >= 2) return 'jpn';
    if (hn >= 2) return count(all, TRAD) > count(all, SIMP) ? 'chi_tra' : 'chi_sim';
    return null;
  }
  async function readPage(blob, want, seriesKey) {
    const lang = want || cache.series[seriesKey] || null;
    if (lang) return { ...(await ocr(blob, lang)), lang };
    // auto-detect: read once with all three, then again with the language it turned out to be (kept for the series)
    const first = await ocr(blob, 'auto');
    const found = detect(first.blocks);
    if (!found) return { ...first, blocks: [], lang: 'none' };
    if (seriesKey) cache.series[seriesKey] = found;
    return { ...(await ocr(blob, found)), lang: found };
  }

  // ---------- translating ----------
  async function google(q, sl, tl) {
    const j = await K.api.site(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(q)}`);
    return (Array.isArray(j?.[0]) ? j[0] : []).map(s => (Array.isArray(s) && typeof s[0] === 'string' ? s[0] : '')).join('');
  }
  // the page's bubbles go in one request, one per line; if the lines don't come back one for one, each goes alone
  async function translateAll(texts, sl, tl) {
    const out = [];
    for (let i = 0; i < texts.length;) {
      const batch = [];
      while (i < texts.length && (!batch.length || batch.join('\n').length + texts[i].length < 1400)) batch.push(texts[i++]);
      const parts = (await google(batch.join('\n'), sl, tl)).split('\n').map(s => s.trim());
      if (parts.length === batch.length) out.push(...parts);
      else for (const t of batch) out.push((await google(t, sl, tl)).replace(/\s*\n\s*/g, ' ').trim());
    }
    return out;
  }

  // ---------- painting the translations ----------
  const pct = (v, of) => (v / of * 100).toFixed(3) + '%';
  const ro = new ResizeObserver(es => { for (const e of es) { const pg = e.target.closest('.pg'), layer = pg?.querySelector(':scope > .ktr-layer'); if (layer) place(pg, layer); } });
  function place(pg, layer) {
    const im = pg.querySelector('img');
    // page mode: the picture is centred and fitted, so the layer sits exactly over it; long strip: the page is the picture
    if (pg.closest('.reader.paged') && im?.offsetWidth && im.classList.contains('ready')) Object.assign(layer.style, { left: im.offsetLeft + 'px', top: im.offsetTop + 'px', width: im.offsetWidth + 'px', height: im.offsetHeight + 'px' });
    else Object.assign(layer.style, { left: '0', top: '0', width: '100%', height: '100%' });
    if (!layer._fit && layer.offsetWidth > 40) requestAnimationFrame(() => fit(layer));
  }
  // Biggest font that fits each box. It's stored relative to the page width (cqw), so resizing keeps the same
  // fit without measuring again.
  function fit(layer) {
    const W = layer.offsetWidth;
    if (layer._fit || W < 40 || !layer.isConnected) return;
    layer._fit = true;
    for (const b of layer.children) {
      const sp = b.firstChild, bh = b.clientHeight, bw = sp.clientWidth || b.clientWidth;
      let lo = 5, hi = Math.max(6, Math.min(bh * 0.6, 40)), best = lo;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2;
        b.style.fontSize = mid + 'px';
        if (sp.offsetHeight <= bh * 0.94 && sp.scrollWidth <= bw + 1) { best = mid; lo = mid; } else hi = mid;
      }
      b.style.fontSize = (best / W * 100).toFixed(4) + 'cqw';
    }
  }
  function paint(pg, e, to) {
    pg.querySelector(':scope > .ktr-layer')?.remove();
    const tr = e.tr?.[to] || [];
    const layer = el('div.ktr-layer', { lang: to });
    e.blocks.forEach((b, n) => {
      if (!tr[n]) return;
      layer.append(el('div.ktr-b', { style: { left: pct(b.x, e.w), top: pct(b.y, e.h), width: pct(b.w, e.w), height: pct(b.h, e.h) } }, el('span', { text: tr[n] })));
    });
    pg.append(layer);
    ro.observe(pg);
    const im = pg.querySelector('img'); if (im) ro.observe(im);
    place(pg, layer);
  }

  // ---------- which pages, in what order ----------
  const urlOf = pg => pg.querySelector('img')?.dataset.src || '';
  const keyOf = pg => { const u = urlOf(pg), o = opts(); return u ? u + '|' + o.to + '|' + o.from : ''; };
  const needs = pg => { const k = keyOf(pg); if (!k || pg._ktrKey === k) return false; const f = pg._ktrFail; return !(f && f.k === k && (f.n >= 3 || Date.now() < f.until)); };
  const fetchPage = async url => { const r = await fetch(/^https:\/\//.test(url) ? K.viaKoru(url) : url).catch(() => { throw new Error('The page didn\'t load. Check your connection.'); }); if (!r.ok) throw new Error('The page didn\'t load (' + r.status + ').'); return r.blob(); };

  function watch() {
    const root = document.querySelector('.reader .pages');
    if (root !== ioRoot) {
      io?.disconnect(); io = null; near.clear(); ioRoot = root; rootStats = { found: 0, empty: 0, told: false };
      if (root) io = new IntersectionObserver(es => { for (const e of es) e.isIntersecting ? near.add(e.target) : near.delete(e.target); pump(); }, { root, rootMargin: '60% 0px' });
    }
    if (!io) return;
    for (const pg of root.querySelectorAll('.pg')) if (pg._ktrIO !== io) { pg._ktrIO = io; io.observe(pg); }
    pump();
  }
  async function pump() {
    if (busy || !on) return;
    const cands = [...near].filter(pg => pg.isConnected && needs(pg));
    if (!cands.length) { if (!document.querySelector('.reader > .ktr-chip')?._timed) chip(null); return; }   // a short message stays its time
    const mid = innerHeight / 2, dist = pg => { const r = pg.getBoundingClientRect(); return r.bottom < mid ? mid - r.bottom : r.top > mid ? r.top - mid : 0; };
    cands.sort((a, b) => dist(a) - dist(b));
    busy = true; clearTimeout(idleT);
    const pg = cands[0], k = keyOf(pg);
    try { await doPage(pg, k); }
    catch (e) {
      if (e !== STOP) {
        const f = pg._ktrFail?.k === k ? pg._ktrFail : { k, n: 0 };
        f.n++; f.until = Date.now() + 8000 * f.n; pg._ktrFail = f;
        chip(e.message || 'Couldn\'t translate this page.', false, 4000);
      }
    } finally {
      busy = false;
      idleT = setTimeout(stopWorker, 180000);   // nothing to read for a while: free Tesseract's memory
      if (on) setTimeout(pump, 40);
    }
  }
  async function doPage(pg, k) {
    const url = urlOf(pg), o = opts(), n = Number(pg.dataset.i) + 1, stats = rootStats;
    await loadCache();
    let e = cache.pages[url];
    const want = o.from === 'auto' ? null : o.from;
    if (e && want && e.lang !== want) e = null;   // read as another language before
    if (!e) {
      chip(`Translating page ${n}…`, true);
      e = await readPage(await fetchPage(url), want, K.readingSeries?.());
      put(url, e);
    }
    if (e.blocks.length && !e.tr?.[o.to]) {
      chip(`Translating page ${n}…`, true);
      const out = await translateAll(e.blocks.map(b => b.s), GOOGLE[e.lang] || 'auto', o.to);
      e.tr = { ...(e.tr || {}), [o.to]: out };
      put(url, e);
    }
    if (!on || keyOf(pg) !== k) return;
    pg._ktrKey = k;
    if (e.blocks.length) { paint(pg, e, o.to); stats.found++; return; }
    pg.querySelector(':scope > .ktr-layer')?.remove();
    stats.empty++;
    chip(`No raw text found on page ${n}`, false, 1800);
    if (!stats.found && stats.empty >= 2 && !stats.told) {
      stats.told = true;
      K.toast(o.from === 'auto' ? 'Koru didn\'t find any Korean, Japanese or Chinese text on these pages. They may already be translated.' : `Koru didn't find any ${NAMES[o.from]} text on these pages. They may already be translated.`);
    }
  }

  // ---------- on / off ----------
  function setOn(v) {
    on = v;
    document.documentElement.classList.toggle('ktr-hide', !on);
    document.querySelectorAll('.ktr-btn').forEach(b => b.classList.toggle('on', on));
    clearInterval(watchT);
    if (on) {
      if (!window.OffscreenCanvas) { on = false; K.toast('Translate needs a newer Koru.', 'error'); return; }
      watchT = setInterval(watch, 700); watch();
      loadLib().catch(e => { K.toast(e.message, 'error'); setOn(false); });
    } else { chip(null); io?.disconnect(); io = null; ioRoot = null; near.clear(); }
  }
  // a setting changed: what's shown no longer matches, so pages are read (or just translated) again
  function refresh() {
    document.querySelectorAll('.ktr-layer').forEach(l => l.remove());
    document.querySelectorAll('.reader .pg').forEach(pg => { pg._ktrKey = ''; pg._ktrFail = null; });
    if (on) pump();
  }

  const trIcon = () => { const s = icon('dot'); s.innerHTML = '<path d="M3 5h9M7.5 3v2M5 5c.6 3 2.6 5.4 5.5 6.5M10 5c-.6 3-2.6 5.4-5.5 6.5"/><path d="M12.5 21l4.25-9.5L21 21M14 17.5h5.5"/>'; return s; };
  K.translate = {
    // the reader's top bar button
    button() {
      if (android()) return null;
      return el('button.btn.icon.ktr-btn' + (on ? '.on' : ''), { title: 'Translate raw pages (Korean, Japanese, Chinese)', onclick: () => {
        setOn(!on);
        if (on) chip(`Translating into ${(TARGETS.find(t => t[0] === opts().to) || [0, opts().to])[1]}…`, true, 2500);
      } }, trIcon());
    },
    // rows for the reader settings panel
    settingsRows() {
      if (android()) return null;
      const o = opts();
      const sel = (items, v, onChange) => { const s = el('select.sel-in', ...items.map(([val, label]) => el('option', { value: val, text: label }))); s.value = v; s.onchange = () => onChange(s.value); return s; };
      return [
        el('div.ctl', el('div.lab', 'Translate to', el('small', { text: 'The Translate button covers raw speech bubbles with this language' })), sel(TARGETS, o.to, v => { setOpts({ to: v }); refresh(); })),
        el('div.ctl', el('div.lab', 'Raw pages are in', el('small', { text: 'Auto-detect works it out from the first page with text' })), sel(SOURCES, o.from, v => { setOpts({ from: v }); refresh(); }))
      ];
    },
    get on() { return on; },
    debug: { psm: (lang, v) => { PSM[lang] = v; wkLangs = ''; }, ocr: (blob, lang) => { const was = on; on = true; return ocr(blob, lang).finally(() => { on = was; }); }, detect },
    setOn,
    // for testing: OCR + translate an image (Blob) and return what was found
    async run(blob, from = opts().from, to = opts().to) {
      const was = on; on = true;
      try {
        await loadCache();
        const e = await readPage(blob, from === 'auto' ? null : from, null);
        const tr = e.blocks.length ? await translateAll(e.blocks.map(b => b.s), GOOGLE[e.lang] || 'auto', to) : [];
        return { ...e, tr };
      } finally { on = was; }
    }
  };
})();
