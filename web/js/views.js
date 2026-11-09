// Koru pages: Library, Explore, Search, Series, Downloads. (Reader and Settings have their own files.)
'use strict';
(function () {
  const { el, icon, img } = K;
  K.views = {};
  const P = id => K.providers[id];

  // ---------- shared pieces ----------
  function card(s, i = 0, extra = {}) {
    const a = el('a.card', { href: extra.href || `#/series/${s.provider}/${encodeURIComponent(s.slug)}`, style: { '--i': i } });
    const cv = el('div.cv', img(s.cover, s.title));
    cv.append(el('span.src', { text: P(s.provider)?.short || s.provider, style: { color: P(s.provider)?.hue } }));
    if (extra.newCount) cv.append(el('span.newb', { text: extra.newCount > 99 ? '99+' : String(extra.newCount), title: 'New chapters' }));
    cv.append(el('div.cap', el('div.t', { text: s.title }), el('div.s', { text: extra.sub ?? s.latest ?? s.status ?? '' })));
    const f = K.flag(s.provider, s.slug);
    if (f.completed) cv.append(el('span.ribbon', { text: 'Completed' }));
    if (f.trash) cv.append(el('span.ribbon.trash', { text: 'Absolute trash' }));
    if (f.hidden) a.classList.add('is-hidden');
    if (extra.progress != null) cv.append(el('div.prog', el('i', { style: { width: Math.round((f.completed ? 1 : extra.progress) * 100) + '%' } })));
    a.append(cv);
    if (extra.menu) {
      const open = e => { e.preventDefault(); e.stopPropagation(); K.bookMenu(s, e, extra.onChange); };
      cv.append(el('button.more', { title: 'Options', 'aria-label': 'Options', onclick: open }, icon('more')));
      a.addEventListener('contextmenu', open);
    }
    return a;
  }

  // ---------- a small pop-up menu: items are [icon, label, action, 'danger'?] or '-' ----------
  K.popMenu = function (ev, title, items) {
    document.querySelector('.menu')?.remove();
    const menu = el('div.menu.glass', title ? el('div.menu-h', el('b', { text: title })) : null);
    for (const it of items.filter(Boolean)) {
      if (it === '-') { menu.append(el('hr')); continue; }
      const [ic, label, fn, cls] = it;
      menu.append(el('button.mi' + (cls ? '.' + cls : ''), { onclick: e => { e.stopPropagation(); close(); fn(); } }, icon(ic), label));
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    const x = ev.clientX || ev.currentTarget?.getBoundingClientRect().left || 100, y = ev.clientY || ev.currentTarget?.getBoundingClientRect().bottom || 100;
    menu.style.left = Math.max(10, Math.min(x, innerWidth - r.width - 10)) + 'px';
    menu.style.top = Math.max(10, Math.min(y, innerHeight - r.height - 10)) + 'px';
    function close() { menu.classList.add('out'); setTimeout(() => menu.remove(), 160); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc); }
    const outside = e => { if (!menu.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc); }, 0);
  };

  // ---------- the options menu under every book ----------
  K.bookMenu = function (s, ev, onChange) {
    document.querySelector('.menu')?.remove();
    const key = K.key(s.provider, s.slug);
    const f = K.data.flags[key] || {};
    const setFlag = (name, v) => { const n = { ...(K.data.flags[key] || {}), [name]: v }; if (!n.hidden && !n.completed && !n.trash) delete K.data.flags[key]; else K.data.flags[key] = n; K.save('flags'); };
    const meta = { provider: s.provider, slug: s.slug, title: s.title, cover: s.cover };
    const done = (msg, kind) => { if (msg) K.toast(msg, kind || 'ok'); close(); onChange?.(); document.dispatchEvent(new CustomEvent('koru-library')); };
    const items = [
      ['play', K.data.history[key] ? 'Continue reading' : 'Open', () => { close(); const h = K.data.history[key]; K.go(h ? `/read/${s.provider}/${encodeURIComponent(s.slug)}/${encodeURIComponent(h.chapterSlug)}` : `/series/${s.provider}/${encodeURIComponent(s.slug)}`); }],
      '-',
      K.data.library[key] ? ['heart', 'Remove from favourites', () => { delete K.data.library[key]; K.save('library'); done('Removed from favourites'); }]
        : ['heart', 'Add to favourites', () => { K.data.library[key] = { ...meta, addedAt: Date.now(), newCount: 0 }; K.save('library'); done('Added to favourites'); }],
      K.data.liked[key] ? ['like', 'Unlike', () => { delete K.data.liked[key]; K.save('liked'); done('Removed from Liked'); }]
        : ['like', 'Like', () => { K.data.liked[key] = { ...meta, at: Date.now() }; K.save('liked'); done('Added to Liked'); }],
      f.completed ? ['undo', 'Mark as not completed', () => { setFlag('completed', false); done('Marked as not completed'); }]
        : ['done', 'Mark as completed', async () => {
          setFlag('completed', true); done('Marked as completed');
          try { const chs = await K.getChapters(s.provider, s.slug); if (!K.incognito()) { const r = K.data.read[key] = K.data.read[key] || {}; chs.filter(c => !c.locked).forEach(c => { r[c.slug] = 1; }); K.save('read'); onChange?.(); } } catch {}
        }],
      f.hidden ? ['eye', 'Unhide', () => { setFlag('hidden', false); done('Visible again'); }]
        : ['eyeoff', 'Hide', () => { setFlag('hidden', true); done('Hidden. Use the Hidden filter to see it.'); }],
      '-',
      K.data.history[key] ? ['clock', 'Remove from history', () => { delete K.data.history[key]; K.save('history'); done('Removed from history'); }] : null,
      K.data.read[key] ? ['refresh', 'Reset reading progress', () => { delete K.data.read[key]; K.save('read'); done('Progress reset'); }] : null,
      ['download', 'Download all free chapters', async () => { close(); try { const ser = await K.getSeries(s.provider, s.slug); const chs = await K.getChapters(s.provider, s.slug); K.downloadChapters(ser, [...chs].reverse().filter(c => !c.locked)); } catch (e) { K.toast(e.message, 'error'); } }],
      ['external', 'Open on the site', async () => { close(); try { const ser = await K.getSeries(s.provider, s.slug); K.api.post('/k/open-external', { url: ser.url }); } catch {} }],
      '-',
      f.trash ? ['undo', 'Restore from trash', () => { setFlag('trash', false); done('Restored'); }]
        : ['trash', 'ABSOLUTE TRASH', () => {
          // Gone from everything: favourites, likes, history, continue reading, bookmarks, Explore and Search.
          setFlag('trash', true);
          K.data.flags[key].title = s.title; K.data.flags[key].cover = s.cover; K.save('flags');
          delete K.data.library[key]; delete K.data.liked[key]; delete K.data.history[key];
          for (const id of Object.keys(K.data.bookmarks)) if (id.startsWith(key + ':')) delete K.data.bookmarks[id];
          ['library', 'liked', 'history', 'bookmarks'].forEach(k => K.save(k));
          done('Absolute trash. It\'s gone from your feed for good.', 'info');
        }, 'danger']
    ].filter(Boolean);
    const menu = el('div.menu.glass', el('div.menu-h', el('b', { text: s.title }), el('small', { text: K.providers[s.provider]?.name || '' })));
    for (const it of items) {
      if (it === '-') { menu.append(el('hr')); continue; }
      const [ic, label, fn, cls] = it;
      menu.append(el('button.mi' + (cls ? '.' + cls : ''), { onclick: e => { e.stopPropagation(); fn(); } }, icon(ic), label));
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    const x = Math.min(ev.clientX, innerWidth - r.width - 10), y = Math.min(ev.clientY, innerHeight - r.height - 10);
    menu.style.left = Math.max(10, x) + 'px'; menu.style.top = Math.max(10, y) + 'px';
    function close() { menu.classList.add('out'); setTimeout(() => menu.remove(), 160); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc); }
    const outside = e => { if (!menu.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc); }, 0);
  };
  K.card = card;
  const skeletonGrid = n => el('div.grid', Array.from({ length: n }, () => el('div.skel.cover')));
  function segmented(options, value, onChange) {
    const seg = el('div.seg'), knob = el('i.knob');
    seg.append(knob);
    const place = () => { const on = seg.querySelector('button.on'); if (on) { knob.style.left = on.offsetLeft + 'px'; knob.style.width = on.offsetWidth + 'px'; } };
    for (const [v, label, ic] of options) {
      seg.append(el('button' + (v === value ? '.on' : ''), { onclick: e => {
        seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        e.currentTarget.classList.add('on'); place(); onChange(v);
      } }, ic ? icon(ic) : null, label));
    }
    requestAnimationFrame(() => requestAnimationFrame(place));
    new ResizeObserver(place).observe(seg);
    return seg;
  }
  K.segmented = segmented;

  // ---------- read state + history ----------
  K.isRead = (provider, slug, ch) => !!K.data.read[K.key(provider, slug)]?.[ch];
  K.readCount = (provider, slug) => Object.keys(K.data.read[K.key(provider, slug)] || {}).length;
  K.markRead = (provider, slug, ch, on = true) => {
    if (K.incognito()) return;
    const k = K.key(provider, slug);
    K.data.read[k] = K.data.read[k] || {};
    if (on) K.data.read[k][ch] = 1; else delete K.data.read[k][ch];
    K.save('read');
  };

  // ---------- downloads state (shared by Series, Reader and Downloads) ----------
  K.dl = { index: new Map(), jobs: [] }; // index: id -> { dir, files }
  K.refreshDownloads = async function () {
    try {
      const { series, disk } = await K.api.get('/k/dl/list');
      K.dl.series = series; K.dl.disk = disk || null;
      K.dl.index = new Map();
      for (const s of series) for (const c of s.chapters) K.dl.index.set(c.id, c);
    } catch {}
    document.dispatchEvent(new CustomEvent('koru-downloads'));
  };
  let polling = false;
  async function pollQueue() {
    if (polling) return;
    polling = true;
    let wasActive = false;
    try {
      while (true) {
        const { jobs } = await K.api.get('/k/dl/queue');
        const before = new Set(K.dl.jobs.filter(j => j.state === 'downloading' || j.state === 'queued').map(j => j.id));
        K.dl.jobs = jobs;
        const active = jobs.some(j => j.state === 'downloading' || j.state === 'queued');
        if (jobs.some(j => j.state === 'done' && before.has(j.id))) await K.refreshDownloads();
        for (const j of jobs) if (j.state === 'failed' && before.has(j.id)) K.toast(`${j.chapterName}: ${j.error || 'download failed'}`, 'error');
        document.dispatchEvent(new CustomEvent('koru-queue'));
        K.setNavBadge('downloads', active);
        if (!active) { if (wasActive) K.toast('Downloads finished', 'ok'); break; }
        wasActive = true;
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch {} finally { polling = false; }
  }
  K.pollQueue = pollQueue;
  K.downloadChapters = async function (series, chapters) {
    let queued = 0;
    for (const c of chapters) {
      if (c.locked || K.dl.index.has(`${series.provider}:${series.slug}:${c.slug}`)) continue;
      try {
        const pages = await P(series.provider).pages(series.slug, c.slug);
        await K.api.post('/k/dl/start', { provider: series.provider, seriesSlug: series.slug, seriesTitle: series.title, cover: series.cover,
          chapterSlug: c.slug, chapterName: c.name, number: c.number, pages: pages.map(p => p.url) });
        queued++;
        pollQueue();
      } catch (e) { K.toast(`${c.name}: ${e.message}`, 'error'); }
    }
    if (queued) K.toast(queued === 1 ? 'Download started' : `${queued} chapters queued`, 'ok');
  };
  K.localPages = id => {
    const c = K.dl.index.get(id);
    if (!c) return null;
    const [a, b] = c.dir.split('/');
    return c.files.map(f => ({ url: `/k/dl/file/${encodeURIComponent(a)}/${encodeURIComponent(b)}/${encodeURIComponent(f)}` }));
  };

  // ---------- new chapter checks for your library ----------
  let checking = false;
  K.checkUpdates = async function (force) {
    if (checking) return;
    checking = true;
    let found = 0;
    try {
      for (const [k, item] of Object.entries(K.data.library)) {
        if (!force && item.checkedAt && Date.now() - item.checkedAt < 30 * 60e3) continue;
        try {
          const chs = await K.getChapters(item.provider, item.slug, true);
          const latest = chs[0]?.slug;
          if (item.known && latest && latest !== item.known) {
            const idx = chs.findIndex(c => c.slug === item.known);
            const n = idx > 0 ? idx : 0;
            if (n) { item.newCount = (item.newCount || 0) + n; found += n; }
          }
          if (latest) item.known = latest;
          item.total = chs.length;
          item.checkedAt = Date.now();
        } catch {}
        await new Promise(r => setTimeout(r, 400));
      }
      K.save('library');
      if (found) { K.toast(`${found} new chapter${found > 1 ? 's' : ''} in your library`, 'ok'); K.setNavBadge('library', true); }
      document.dispatchEvent(new CustomEvent('koru-library'));
    } finally { checking = false; }
    return found;
  };

  // Which books a Library filter shows. Hidden and trashed books only show under their own filter.
  K.flagPass = (x, filter) => {
    const f = K.flag(x.provider, x.slug);
    if (filter === 'hidden') return !!f.hidden;
    if (filter === 'trash') return !!f.trash;
    if (f.hidden || f.trash) return false;
    if (filter === 'all') return true;
    if (filter === 'completed') return !!f.completed;
    if (filter === 'new') return !!K.data.library[K.key(x.provider, x.slug)]?.newCount;
    return x.provider === filter;
  };

  // ---------- Library ----------
  K.views.library = async function (root) {
    let filter = sessionStorage.getItem('koru-libfilter') || 'all';
    K.setNavBadge('library', false);
    const hour = new Date().getHours();
    const hello = hour < 5 ? 'Late night reading' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const refresh = el('button.btn', { title: 'Check for new chapters', onclick: async () => {
      refresh.disabled = true; refresh.querySelector('.ic').style.animation = 'spin 1s linear infinite';
      const n = await K.checkUpdates(true);
      if (!n) K.toast('No new chapters yet');
      refresh.disabled = false; refresh.querySelector('.ic').style.animation = '';
    } }, icon('refresh'), 'Check updates');
    root.append(el('div.head', el('div', el('h1', { text: 'Library' }), el('div.sub', { text: hello })), el('div.sp'), refresh));
    const body = el('div');
    root.append(body);

    function draw() {
      body.replaceChildren();
      const hist = Object.values(K.data.history).filter(h => { const f = K.flag(h.provider, h.slug); return !f.hidden && !f.trash && !f.completed; }).sort((a, b) => b.at - a.at).slice(0, 12);
      if (hist.length) {
        body.append(el('div.section', el('h2', { text: 'Continue reading' })));
        const rail = el('div.rail');
        hist.forEach((h, i) => {
          const pct = h.total ? Math.min(1, (h.page + 1) / h.total) : 0;
          rail.append(el('div.cont.glass.card', { style: { '--i': i }, onclick: () => K.go(`/read/${h.provider}/${encodeURIComponent(h.slug)}/${encodeURIComponent(h.chapterSlug)}`) },
            el('div.th', img(h.cover, h.title)),
            el('div.meta', el('div.t', { text: h.title }), el('div.s', { text: `${h.chapterName} · ${K.ago(h.at)}` }), el('div.bar', el('i', { style: { width: Math.round(pct * 100) + '%' } }))),
            el('div.play', icon('play'))));
        });
        body.append(rail);
      }
      let tab = sessionStorage.getItem('koru-libtab') || 'fav';
      const tabs = [['fav', 'Favourites', 'heart'], ['liked', 'Liked', 'like'], ['marks', 'Bookmarks', 'bookmark'], ['history', 'History', 'clock']];
      body.append(el('div.section', segmented(tabs, tab, v => { tab = v; sessionStorage.setItem('koru-libtab', v); drawGrid(); })));
      const chips = el('div.row', { style: { marginBottom: '14px' } });
      const sources = [['all', 'All'], ['new', 'New chapters'], ['completed', 'Completed'], ['hidden', 'Hidden'], ['trash', 'Trash'], ...K.providerList.map(p => [p.id, p.short])];
      const drawChips = () => chips.replaceChildren(...sources.map(([v, l]) => el('button.chip' + (filter === v ? '.on' : ''), { onclick: () => { filter = v; sessionStorage.setItem('koru-libfilter', v); drawChips(); drawGrid(); } }, l)));
      drawChips();
      body.append(chips);
      const items = Object.values(K.data.library);
      const gridBox = el('div');
      body.append(gridBox);
      const progressOf = x => { const total = x.total || K.data.library[K.key(x.provider, x.slug)]?.total; return total ? Math.min(1, K.readCount(x.provider, x.slug) / total) : null; };
      function drawGrid() {
        chips.style.display = tab === 'marks' ? 'none' : '';
        if (tab !== 'fav') return drawOther();
        let list = filter === 'trash' ? Object.keys(K.data.flags).filter(k => K.data.flags[k].trash).map(k => { const [provider, ...rest] = k.split(':'); const slug = rest.join(':'); const h = K.data.flags[k]; return { provider, slug, title: h.title || slug, cover: h.cover || null }; }) : items.slice();
        list = list.filter(x => K.flagPass(x, filter));
        list.sort((a, b) => (b.newCount || 0) - (a.newCount || 0) || (K.data.history[K.key(b.provider, b.slug)]?.at || b.addedAt) - (K.data.history[K.key(a.provider, a.slug)]?.at || a.addedAt));
        if (!list.length) {
          gridBox.replaceChildren(el('div.empty', K.fox(), el('h3', { text: items.length ? 'Nothing here' : 'Start your library' }),
            el('p', { text: items.length ? 'No series match this filter.' : 'Find a series in Explore or Search and tap the heart to keep it here.' }),
            items.length ? null : el('div.row', { style: { justifyContent: 'center' } }, el('a.btn.primary', { href: '#/explore' }, icon('explore'), 'Explore'), el('a.btn', { href: '#/search' }, icon('search'), 'Search'))));
          return;
        }
        gridBox.replaceChildren(el('div.grid', list.map((x, i) => {
          const h = K.data.history[K.key(x.provider, x.slug)];
          const read = K.readCount(x.provider, x.slug);
          return card(x, i, { menu: true, onChange: drawGrid, newCount: x.newCount, progress: progressOf(x), sub: x.total ? `${read} / ${x.total} read` : (h ? 'Read · ' + h.chapterName : P(x.provider)?.name) });
        })));
      }
      function drawOther() {
        const pass = x => K.flagPass(x, filter);
        if (tab === 'marks') {
          const marks = Object.values(K.data.bookmarks).sort((a, b) => b.at - a.at);
          if (!marks.length) { gridBox.replaceChildren(el('div.empty', K.fox(), el('h3', { text: 'No bookmarks yet' }), el('p', { text: 'While reading, tap the bookmark at the top to save the page you\'re on.' }))); return; }
          gridBox.replaceChildren(el('div.list', marks.map((m, i) => el('div.item', { style: { '--i': i }, onclick: () => K.go(`/read/${m.provider}/${encodeURIComponent(m.slug)}/${encodeURIComponent(m.chapterSlug)}?page=${m.page}`) },
            el('div.mthumb', img(m.cover, m.title)),
            el('div.n', el('b', { text: m.title }), el('small', { text: `${m.chapterName} · page ${m.page + 1} · ${K.ago(m.at)}` })),
            el('button.dlbtn', { title: 'Remove bookmark', onclick: e => { e.stopPropagation(); delete K.data.bookmarks[m.id]; K.save('bookmarks'); drawGrid(); } }, icon('x'))))));
          return;
        }
        const src = tab === 'liked' ? Object.values(K.data.liked) : Object.values(K.data.history);
        const list = src.filter(pass).sort((a, b) => (b.at || 0) - (a.at || 0));
        if (!list.length) {
          gridBox.replaceChildren(el('div.empty', K.fox(), el('h3', { text: tab === 'liked' ? 'Nothing liked yet' : 'No history yet' }),
            el('p', { text: tab === 'liked' ? 'Tap the thumbs-up on any series to keep it here.' : (K.incognito() ? 'Incognito is on, so nothing you read is saved.' : 'Series you read show up here.') })));
          return;
        }
        gridBox.replaceChildren(el('div.grid', list.map((x, i) => card(x, i, { menu: true, onChange: drawGrid, progress: progressOf(x), sub: tab === 'history' ? `${x.chapterName} · ${K.ago(x.at)}` : (P(x.provider)?.name || '') }))));
      }
      drawGrid();
    }
    draw();
    const onLib = () => draw();
    document.addEventListener('koru-library', onLib);
    root.closest('.view')?.addEventListener('animationstart', () => {}, { once: true });
    new MutationObserver((_, o) => { if (!root.isConnected) { document.removeEventListener('koru-library', onLib); o.disconnect(); } }).observe(document.getElementById('main'), { childList: true });
  };

  // ---------- Explore ----------
  K.views.explore = async function (root, r, alive) {
    let src = sessionStorage.getItem('koru-src') || 'omega';
    let sort = sessionStorage.getItem('koru-sort') || 'latest';
    root.append(el('div.head', el('div', el('h1', { text: 'Explore' }), el('div.sub', { text: 'Browse your sources' }))));
    if (!K.providers[src]) src = 'omega';
    const srcRow = el('div.srcs');
    const drawSrcs = () => srcRow.replaceChildren(...K.providerList.map(p => el('button.chip' + (src === p.id ? '.on' : ''), { onclick: () => { if (src === p.id) return; src = p.id; sessionStorage.setItem('koru-src', src); drawSrcs(); load(true); } }, el('i.dot', { style: { background: p.hue, boxShadow: '0 0 8px ' + p.hue } }), p.name)));
    drawSrcs();
    const bar = el('div.row', { style: { marginBottom: '18px', gap: '12px' } },
      segmented([['latest', 'Latest', 'clock'], ['popular', 'Popular', 'sparkle']], sort, v => { sort = v; sessionStorage.setItem('koru-sort', v); load(true); }));
    root.append(srcRow, bar);
    const grid = el('div.grid'), more = el('div', { style: { height: '60px' } });
    root.append(grid, more);
    let page = 1, hasMore = true, busy = false, gen = 0, dry = 0;
    const seen = new Set();
    async function load(reset) {
      if (reset) { gen++; page = 1; hasMore = true; seen.clear(); dry = 0; more.replaceChildren(); grid.replaceChildren(...Array.from({ length: 12 }, () => el('div.skel.cover'))); }
      if (busy && !reset) return;
      if (!hasMore) return;
      busy = true;
      const my = gen;
      let ok = false;
      try {
        const res = await K.cached(`l:${src}:${sort}:${page}`, 5 * 60e3, () => P(src).list({ sort, page }));
        if (my !== gen || !root.isConnected) return;
        if (page === 1) grid.replaceChildren();
        const start = grid.children.length;
        const fresh = res.items.filter(s => s.slug && !seen.has(s.slug) && K.notTrash(s));
        res.items.forEach(s => seen.add(s.slug));
        fresh.forEach((s, i) => grid.append(card(s, start + i < 24 ? i : i % 12)));
        dry = fresh.length ? 0 : dry + 1;
        hasMore = res.hasMore && dry < 2; page++;
        if (!grid.children.length) grid.replaceChildren(el('div.empty', { style: { gridColumn: '1/-1' } }, el('p', { text: 'Nothing to show.' })));
        ok = true;
      } catch (e) {
        if (my === gen) { if (page === 1) grid.replaceChildren(K.errorBox(e)); else more.replaceChildren(el('button.btn', { onclick: () => { more.replaceChildren(); load(); } }, icon('refresh'), 'Load more')); }
      } finally {
        busy = false;
        requestAnimationFrame(measure);
        if (ok && my === gen && hasMore) requestAnimationFrame(() => { if (near()) setTimeout(() => load(), 60); });
      }
    }
    const view = root.closest('.view');
    let fullH = 0;
    const measure = () => { fullH = view ? view.scrollHeight : 0; };
    const near = () => !!view && view.scrollTop + view.clientHeight > (fullH || view.scrollHeight) - 1600;
    view?.addEventListener('scroll', () => { if (page > 1 && near()) load(); }, { passive: true });
    load(true);
  };

  // ---------- Search ----------
  K.views.search = async function (root, r) {
    root.append(el('div.head', el('div', el('h1', { text: 'Search' }), el('div.sub', { text: 'Both sources at once' }))));
    const input = el('input', { type: 'search', placeholder: 'Search titles', value: r.query.get('q') || '', spellcheck: false, autocomplete: 'off' });
    root.append(el('div.searchbox.glass', icon('search'), input));
    const out = el('div', { style: { marginTop: '10px' } });
    root.append(out);
    let gen = 0;
    async function run(q) {
      const my = ++gen;
      history.replaceState(null, '', '#/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
      const v = root.closest('.view'); if (v) v._q = q;
      if (!q.trim()) { out.replaceChildren(el('div.empty', K.fox(), el('h3', { text: 'Find something to read' }), el('p', { text: 'Type a title. Koru searches all ' + K.providerList.length + ' sources together.' }))); return; }
      out.replaceChildren();
      for (const p of K.providerList) {
        const sec = el('div', el('div.section', el('h2', { text: p.name, style: { color: p.hue } }), el('span.count')), skeletonGrid(6));
        out.append(sec);
        p.list({ q, page: 1 }).then(res => {
          if (my !== gen) return;
          sec.querySelector('.count').textContent = res.items.length ? res.items.length + (res.hasMore ? '+' : '') + ' found' : '';
          const shown = res.items.filter(K.notTrash);
          sec.lastChild.replaceWith(shown.length ? el('div.grid', shown.map((s, i) => card(s, i))) : el('p.muted', { text: 'No matches.' }));
        }).catch(e => { if (my === gen) sec.lastChild.replaceWith(el('p.muted', { text: e.message })); });
      }
    }
    input.addEventListener('input', K.debounce(() => run(input.value), 420));
    run(input.value);
    setTimeout(() => input.focus(), 120);
  };

  // ---------- Series ----------
  K.views.series = async function (root, r, alive) {
    const [provider, slug] = r.parts;
    const key = K.key(provider, slug);
    root.append(el('div.spinner'));
    let s, chapters = [], offline = false;
    try {
      s = await K.getSeries(provider, slug);
      chapters = await K.getChapters(provider, slug);
    } catch (e) {
      // No connection: show what's downloaded.
      const d = K.dl.series?.find(x => x.provider === provider && x.seriesSlug === slug);
      if (!d) throw e;
      offline = true;
      s = { provider, slug, title: d.title, cover: d.cover, description: 'You\'re offline. Showing downloaded chapters.', tags: [], status: '' };
      chapters = d.chapters.map(c => ({ slug: c.chapterSlug, name: c.chapterName, number: c.number, date: c.savedAt, locked: false }))
        .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
    }
    if (!alive()) return;
    root.replaceChildren();
    const lib = K.data.library[key];
    if (lib) { lib.newCount = 0; if (chapters[0]) lib.known = chapters[0].slug; lib.total = chapters.length; lib.title = s.title; lib.cover = s.cover || lib.cover; K.save('library'); }
    const hist = K.data.history[key];

    // hero
    const heart = el('button.btn.heart' + (lib ? '.on' : ''), { title: 'Favourite' }, icon('heart'), el('span', { text: lib ? 'In library' : 'Add to library' }));
    heart.onclick = () => {
      if (K.data.library[key]) { delete K.data.library[key]; heart.classList.remove('on'); heart.lastChild.textContent = 'Add to library'; K.toast('Removed from library'); }
      else {
        K.data.library[key] = { provider, slug, title: s.title, cover: s.cover, addedAt: Date.now(), known: chapters[0]?.slug, total: chapters.length, newCount: 0, checkedAt: Date.now() };
        heart.classList.add('on'); heart.lastChild.textContent = 'In library'; K.toast('Added to library', 'ok');
      }
      K.save('library');
    };
    const liked = el('button.btn.icon.likeb' + (K.data.liked[key] ? '.on' : ''), { title: 'Like' }, icon('like'));
    liked.onclick = () => {
      if (K.data.liked[key]) { delete K.data.liked[key]; liked.classList.remove('on'); K.toast('Removed from Liked'); }
      else { K.data.liked[key] = { provider, slug, title: s.title, cover: s.cover, at: Date.now() }; liked.classList.add('on'); K.toast('Added to Liked', 'ok'); }
      K.save('liked');
    };
    const avail = chapters.filter(c => !c.locked).length;
    const readN = K.readCount(provider, slug);
    const prog = el('div.sprog', el('div.bar', el('i', { style: { width: (avail ? Math.min(100, Math.round(readN / avail * 100)) : 0) + '%' } })),
      el('small.muted', { text: `${Math.min(readN, avail)} of ${avail} available chapters read${chapters.length > avail ? ` · ${chapters.length - avail} locked` : ''}` }));
    const firstFree = [...chapters].reverse().find(c => !c.locked);
    const resume = hist && chapters.find(c => c.slug === hist.chapterSlug);
    const readBtn = el('button.btn.primary', { onclick: () => { const c = resume || firstFree; if (c) K.go(`/read/${provider}/${encodeURIComponent(slug)}/${encodeURIComponent(c.slug)}`); else K.toast('No free chapters to read yet.'); } },
      icon('play'), resume ? 'Continue ' + resume.name.replace(/ — .*/, '') : 'Start reading');
    const desc = el('div.desc', { text: s.description || 'No description.', onclick: () => desc.classList.toggle('open') });
    const hero = el('div.hero',
      el('div.bd', { style: s.cover ? { backgroundImage: `url("${s.cover.replace(/["\\]/g, '')}")` } : {} }),
      el('button.btn.backb', { title: 'Back (Alt+Left)', onclick: () => K.back() }, icon('back'), 'Back'),
      el('div.wrap',
        el('div.poster', img(s.cover, s.title, '', 320)),
        el('div.info',
          el('div.row', el('span.tag', { text: P(provider)?.name, style: { color: P(provider)?.hue } }), s.status ? el('span.tag', { text: s.status }) : null, offline ? el('span.tag', { text: 'Offline' }) : null),
          el('h1', { text: s.title }),
          s.author ? el('div.muted', { text: s.author }) : null,
          el('div.tags', (s.tags || []).slice(0, 10).map(t => el('span.tag', { text: t }))),
          prog,
          el('div.row', readBtn, heart, liked,
            offline ? null : el('button.btn.icon', { title: 'Open on the site', onclick: () => K.api.post('/k/open-external', { url: s.url }).catch(() => {}) }, icon('external'))))));
    if (K.flag(provider, slug).trash) root.append(el('div.glass', { style: { padding: '12px 16px', margin: '0 0 14px', display: 'flex', gap: '10px', alignItems: 'center' } },
      icon('trash'), el('span', { style: { flex: 1 }, text: 'You put this in Absolute trash, so it\'s hidden from your feed.' }),
      el('button.btn.small', { onclick: () => { const f = { ...K.data.flags[key] }; delete f.trash; if (f.hidden || f.completed) K.data.flags[key] = f; else delete K.data.flags[key]; K.save('flags'); K.toast('Restored', 'ok'); K.go('/series/' + provider + '/' + encodeURIComponent(slug), true); location.reload(); } }, icon('undo'), 'Restore')));
    root.append(hero, el('div', { style: { marginTop: '18px' } }, desc));

    // chapters — Kotatsu style: long-press or right-click a chapter to start selecting, Shift-click for a range
    let asc = false, selecting = false, view = 'all', anchor = null;
    const selected = new Set();
    const listBox = el('div.list');
    const countFree = chapters.filter(c => !c.locked).length;
    const isDl = c => K.dl.index.has(`${provider}:${slug}:${c.slug}`);
    const oldestFirst = list => [...list].sort((a, b) => chapters.indexOf(b) - chapters.indexOf(a)); // chapters arrive newest first
    const unreadFree = () => oldestFirst(chapters.filter(c => !c.locked && !K.isRead(provider, slug, c.slug) && !isDl(c)));
    const startSelect = c => { selecting = true; selected.clear(); if (c && !c.locked) selected.add(c.slug); anchor = c?.slug || null; draw(); };
    const stopSelect = () => { selecting = false; selected.clear(); anchor = null; draw(); };
    const dlMenu = e => K.popMenu(e, s.title, [
      ['download', 'Next chapter', () => { const n = unreadFree()[0]; n ? K.downloadChapters(s, [n]) : K.toast('No unread chapters left to download.'); }],
      ['download', 'Next 5 unread', () => K.downloadChapters(s, unreadFree().slice(0, 5))],
      ['download', 'Next 10 unread', () => K.downloadChapters(s, unreadFree().slice(0, 10))],
      ['download', 'All unread', () => K.downloadChapters(s, unreadFree())],
      ['download', 'All free chapters', () => K.downloadChapters(s, oldestFirst(chapters.filter(c => !c.locked)))],
      '-',
      ['select', 'Choose chapters…', () => startSelect(null)],
      chapters.some(isDl) ? ['trash', 'Delete all downloads', async () => {
        if (!confirm(`Delete every downloaded chapter of ${s.title}?`)) return;
        await K.api.post('/k/dl/delete', { series: `${provider}:${slug}` }); await K.refreshDownloads(); draw();
      }, 'danger'] : null
    ]);
    const filterChips = el('div.row.chfilter');
    const drawChips = () => filterChips.replaceChildren(...[['all', 'All'], ['unread', 'Unread'], ['downloaded', 'Downloaded']].map(([k, l]) =>
      el('button.chip' + (view === k ? '.on' : ''), { onclick: () => { view = k; drawChips(); draw(); } }, l)));
    drawChips();
    root.append(el('div.section', el('h2', { text: 'Chapters' }), el('span.count', { text: `${chapters.length}${countFree !== chapters.length ? ` · ${chapters.length - countFree} locked` : ''}` }), el('div', { style: { flex: 1 } }),
      el('button.btn.small', { title: 'Oldest or newest first', onclick: () => { asc = !asc; draw(); } }, icon('sort'), 'Sort'),
      offline ? null : el('button.btn.small', { title: 'Select chapters (or long-press one)', onclick: () => selecting ? stopSelect() : startSelect(null) }, icon('select'), 'Select'),
      offline ? null : el('button.btn.small.primary', { title: 'Download options', onclick: dlMenu }, icon('download'), 'Download')));
    root.append(filterChips, listBox);
    const selbar = el('div.selbar.glass');

    function dlButton(c) {
      const id = `${provider}:${slug}:${c.slug}`;
      const b = el('button.dlbtn', { title: 'Download' });
      const job = K.dl.jobs.find(j => j.id === id && (j.state === 'downloading' || j.state === 'queued'));
      b.dataset.sig = K.dl.index.has(id) ? 'done' : job ? 'job' + job.done : 'none';
      if (K.dl.index.has(id)) { b.classList.add('done'); b.title = 'Downloaded'; b.append(icon('check')); }
      else if (job) {
        const pct = job.total ? job.done / job.total : 0, C = 2 * Math.PI * 14;
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ring.setAttribute('viewBox', '0 0 34 34'); ring.setAttribute('class', 'ring');
        ring.innerHTML = `<circle class="tr" cx="17" cy="17" r="14"/><circle class="pr" cx="17" cy="17" r="14" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>`;
        b.append(ring, icon('x')); b.title = 'Cancel';
        b.onclick = e => { e.stopPropagation(); K.api.post('/k/dl/cancel', { id }).then(pollQueue); };
        return b;
      } else b.append(icon('download'));
      b.onclick = e => { e.stopPropagation(); if (!b.classList.contains('done')) K.downloadChapters(s, [c]); };
      return b;
    }
    let shown = [];
    function paintRow(row) {
      const c = row._ch, on = selected.has(c.slug);
      row.classList.toggle('picked', on);
      const box = row.querySelector('.sel');
      if (box) { box.classList.toggle('on', on); box.replaceChildren(on ? icon('check') : ''); }
    }
    function toggle(c, row, range) {
      if (c.locked) return;
      if (range && anchor) {
        const a = shown.findIndex(x => x.slug === anchor), b = shown.findIndex(x => x.slug === c.slug);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!shown[i].locked) selected.add(shown[i].slug); for (const r of listBox.children) if (r._ch) paintRow(r); drawBar(); return; }
      }
      selected.has(c.slug) ? selected.delete(c.slug) : selected.add(c.slug);
      anchor = c.slug;
      paintRow(row); drawBar();
    }
    function makeRow(c, i) {
      const read = K.isRead(provider, slug, c.slug);
      const row = el('div.item' + (read ? '.read' : '') + (c.locked ? '.locked' : '') + (hist?.chapterSlug === c.slug ? '.current' : ''), { style: { '--i': Math.min(i, 20) } });
      row._ch = c;
      if (selecting && !c.locked) row.append(el('span.sel'));
      row.append(el('div.n', el('b', { text: c.name }), el('small', { text: c.locked ? (c.freeAt ? 'Locked · free ' + K.ago(c.freeAt) : 'Locked on the site') : K.ago(c.date) + (read ? ' · read' : '') })));
      if (c.locked) row.append(icon('lock'));
      else if (!offline || isDl(c)) row.append(dlButton(c));
      let pressT = 0, pressed = false;
      row.onpointerdown = e => { if (e.button !== 0 || offline) return; pressed = false; pressT = setTimeout(() => { pressed = true; if (!selecting) startSelect(c); else toggle(c, row); }, 480); };
      row.onpointerup = row.onpointerleave = () => clearTimeout(pressT);
      row.onclick = e => {
        if (pressed) { pressed = false; return; }
        if (c.locked) return K.toast('This chapter is locked on the site.');
        if (selecting) return toggle(c, row, e.shiftKey);
        K.go(`/read/${provider}/${encodeURIComponent(slug)}/${encodeURIComponent(c.slug)}`);
      };
      row.oncontextmenu = e => { e.preventDefault(); if (c.locked || offline) return; if (!selecting) startSelect(c); else toggle(c, row, e.shiftKey); };
      if (selecting) paintRow(row);
      return row;
    }
    function drawBar() {
      if (!selecting) { selbar.remove(); return; }
      const sel = chapters.filter(c => selected.has(c.slug));
      const anyDl = sel.some(isDl);
      selbar.replaceChildren(...[
        el('button.btn.small.icon', { title: 'Stop selecting', onclick: stopSelect }, icon('x')),
        el('b', { text: `${selected.size} selected` }), el('div', { style: { flex: 1 } }),
        el('button.btn.small', { title: 'Select all', onclick: () => { shown.filter(c => !c.locked).forEach(c => selected.add(c.slug)); draw(); } }, 'All'),
        el('button.btn.small', { title: 'Invert selection', onclick: () => { shown.filter(c => !c.locked).forEach(c => selected.has(c.slug) ? selected.delete(c.slug) : selected.add(c.slug)); draw(); } }, 'Invert'),
        el('button.btn.small', { title: 'Fill everything between the first and last selected', onclick: () => {
          const idx = shown.map((c, i) => selected.has(c.slug) ? i : -1).filter(i => i >= 0);
          if (idx.length < 2) return K.toast('Select two chapters first, then fill the range.');
          for (let i = idx[0]; i <= idx[idx.length - 1]; i++) if (!shown[i].locked) selected.add(shown[i].slug);
          draw();
        } }, 'Range'),
        el('button.btn.small', { disabled: !selected.size, onclick: () => { sel.forEach(c => K.markRead(provider, slug, c.slug, true)); draw(); } }, icon('check'), 'Read'),
        el('button.btn.small', { disabled: !selected.size, onclick: () => { sel.forEach(c => K.markRead(provider, slug, c.slug, false)); draw(); } }, 'Unread'),
        anyDl ? el('button.btn.small', { onclick: async () => { for (const c of sel.filter(isDl)) await K.api.post('/k/dl/delete', { id: `${provider}:${slug}:${c.slug}` }); await K.refreshDownloads(); draw(); } }, icon('trash'), 'Delete downloads') : null,
        el('button.btn.small.primary', { disabled: !selected.size, onclick: () => { K.downloadChapters(s, oldestFirst(sel)); stopSelect(); } }, icon('download'), 'Download')].filter(Boolean));
      if (!selbar.isConnected) root.append(selbar);
    }
    function draw() {
      let list = asc ? [...chapters].reverse() : chapters;
      if (view === 'unread') list = list.filter(c => !c.locked && !K.isRead(provider, slug, c.slug));
      else if (view === 'downloaded') list = list.filter(isDl);
      shown = list.slice(0, 800);
      listBox.classList.toggle('selecting', selecting);
      listBox.replaceChildren(...shown.map(makeRow));
      if (!shown.length) listBox.append(el('p.muted', { text: view === 'downloaded' ? 'No downloaded chapters yet.' : 'Nothing here.' }));
      if (list.length > 800) listBox.append(el('p.muted', { text: `Showing 800 of ${list.length}. Use Sort to see the others.` }));
      drawBar();
    }
    draw();
    const refreshButtons = () => {
      if (!root.isConnected || document.querySelector('.reader')) return;
      for (const row of listBox.children) {
        const c = row._ch;
        if (!c || c.locked) continue;
        const old = row.querySelector('.dlbtn');
        if (!old) continue;
        const id = `${provider}:${slug}:${c.slug}`, job = K.dl.jobs.find(j => j.id === id && (j.state === 'downloading' || j.state === 'queued'));
        const sig = K.dl.index.has(id) ? 'done' : job ? 'job' + job.done : 'none';
        if (old.dataset.sig !== sig) old.replaceWith(dlButton(c));
      }
    };
    document.addEventListener('koru-queue', refreshButtons);
    document.addEventListener('koru-downloads', refreshButtons);
    new MutationObserver((_, o) => { if (!root.isConnected) { document.removeEventListener('koru-queue', refreshButtons); document.removeEventListener('koru-downloads', refreshButtons); o.disconnect(); } }).observe(document.getElementById('main'), { childList: true });
  };

  // ---------- Downloads ----------
  // ---------- Downloads: local storage (covers + titles) and the download queue, Kotatsu style ----------
  const dlKey = s => `${s.provider}:${s.seriesSlug}`;
  const coverOf = s => s.cover || K.data.library[dlKey(s)]?.cover || K.data.history[dlKey(s)]?.cover || null;
  const chapSort = (a, b) => (a.number ?? -1) - (b.number ?? -1) || String(a.chapterName).localeCompare(String(b.chapterName), undefined, { numeric: true });
  const savedAt = s => Math.max(0, ...s.chapters.map(c => Date.parse(c.savedAt) || 0));
  // what "Continue" opens for a downloaded series: the chapter you were in, else the next unread one, else the first
  K.localResume = s => {
    const chs = [...s.chapters].sort(chapSort), h = K.data.history[dlKey(s)];
    const cur = h && chs.find(c => c.chapterSlug === h.chapterSlug);
    if (cur && !h.done) return { c: cur, label: 'Continue ' + cur.chapterName.replace(/ — .*/, ''), page: h.page };
    const after = cur ? chs.slice(chs.indexOf(cur) + 1) : chs;
    const next = after.find(c => !K.isRead(s.provider, s.seriesSlug, c.chapterSlug)) || chs.find(c => !K.isRead(s.provider, s.seriesSlug, c.chapterSlug));
    if (next) return { c: next, label: (cur || chs.some(c => K.isRead(s.provider, s.seriesSlug, c.chapterSlug)) ? 'Continue ' : 'Read ') + next.chapterName.replace(/ — .*/, '') };
    return { c: chs[0], label: 'Read again from ' + chs[0].chapterName.replace(/ — .*/, '') };
  };
  const readLocal = (s, c) => K.go(`/read/${s.provider}/${encodeURIComponent(s.seriesSlug)}/${encodeURIComponent(c.chapterSlug)}`);

  K.views.downloads = async function (root) {
    let tab = sessionStorage.getItem('koru-dltab') || 'saved';
    let sort = localStorage.getItem('koru-dlsort') || 'recent', q = '';
    const sub = el('div.sub');
    root.append(el('div.head', el('div', el('h1', { text: 'Downloads' }), sub), el('div.sp'),
      K.info?.platform === 'desktop' ? el('button.btn', { onclick: () => K.api.post('/k/open-downloads') }, icon('folder'), 'Open folder') : null));
    const store = el('div.storage.glass');
    const tabsBox = el('div.section'), body = el('div');
    root.append(store, tabsBox, body);

    function drawStore() {
      const series = K.dl.series || [], used = series.reduce((a, s) => a + s.bytes, 0), d = K.dl.disk;
      const count = series.reduce((a, s) => a + s.chapters.length, 0);
      sub.textContent = count ? `${series.length} series · ${count} chapters · ${K.bytes(used)}` : 'Save chapters to read anywhere, even offline';
      const kids = [el('div.row', { style: { justifyContent: 'space-between' } }, el('b', { text: 'Local storage' }),
        el('span.muted', { text: d ? `${K.bytes(d.free)} free of ${K.bytes(d.total)}` : K.bytes(used) + ' used' }))];
      if (d?.total) {
        const other = Math.max(0, d.total - d.free - used);
        kids.push(el('div.sbar', el('i.koru', { style: { width: Math.max(used ? 0.6 : 0, used / d.total * 100) + '%' } }), el('i.other', { style: { width: other / d.total * 100 + '%' } })),
          el('div.legend', el('span', el('i.koru'), 'Koru ' + K.bytes(used)), el('span', el('i.other'), 'Other files ' + K.bytes(other)), el('span', el('i.free'), 'Free ' + K.bytes(d.free))));
      }
      store.replaceChildren(...kids);
    }
    function drawTabs() {
      const busy = K.dl.jobs.filter(j => j.state === 'downloading' || j.state === 'queued' || j.state === 'failed').length;
      tabsBox.replaceChildren(segmented([['saved', 'Saved', 'folder'], ['queue', busy ? `Queue (${busy})` : 'Queue', 'download']], tab,
        v => { tab = v; sessionStorage.setItem('koru-dltab', v); drawBody(); }));
    }
    function drawBody() { tab === 'queue' ? drawQueue() : drawSaved(); }

    function drawSaved() {
      const all = K.dl.series || [];
      if (!all.length) { body.replaceChildren(el('div.empty', K.fox(), el('h3', { text: 'Nothing saved yet' }), el('p', { text: 'Open a series and use the download button, or select chapters and tap Download.' }))); return; }
      const search = el('input', { type: 'search', placeholder: 'Filter saved series', value: q, oninput: () => { q = search.value; paint(); } });
      const sortSel = el('select.sel-in', [['recent', 'Recently saved'], ['title', 'Title A–Z'], ['chapters', 'Most chapters'], ['size', 'Biggest']].map(([v, l]) => el('option', { value: v, text: l, selected: v === sort })));
      sortSel.onchange = () => { sort = sortSel.value; localStorage.setItem('koru-dlsort', sort); paint(); };
      const grid = el('div.grid');
      body.replaceChildren(el('div.row.dltools', el('label.searchbox.glass.small', icon('search'), search), sortSel), grid);
      function paint() {
        const list = all.filter(s => !q || s.title.toLowerCase().includes(q.toLowerCase()));
        const by = { recent: (a, b) => savedAt(b) - savedAt(a), title: (a, b) => a.title.localeCompare(b.title), chapters: (a, b) => b.chapters.length - a.chapters.length, size: (a, b) => b.bytes - a.bytes }[sort];
        list.sort(by);
        grid.replaceChildren(...list.map((s, i) => {
          const read = s.chapters.filter(c => K.isRead(s.provider, s.seriesSlug, c.chapterSlug)).length;
          const a = card({ provider: s.provider, slug: s.seriesSlug, title: s.title, cover: coverOf(s) }, i,
            { sub: `${s.chapters.length} chapter${s.chapters.length > 1 ? 's' : ''} · ${K.bytes(s.bytes)}`, progress: read / s.chapters.length, href: `#/local/${s.provider}/${encodeURIComponent(s.seriesSlug)}` });
          a.querySelector('.cv').append(el('span.dlcount', { title: 'Downloaded chapters' }, icon('download'), String(s.chapters.length)));
          return a;
        }));
        if (!list.length) grid.replaceChildren(el('p.muted', { text: 'No saved series match.' }));
      }
      paint();
    }

    function drawQueue() {
      const jobs = K.dl.jobs.filter(j => j.state === 'downloading' || j.state === 'queued' || j.state === 'failed');
      if (!jobs.length) { body.replaceChildren(el('div.empty', K.fox(), el('h3', { text: 'Nothing downloading' }), el('p', { text: 'Chapters you download show up here with their progress.' }))); return; }
      const groups = new Map();
      for (const j of jobs) { const k = `${j.provider}:${j.seriesSlug}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
      body.replaceChildren(el('div.row', { style: { justifyContent: 'flex-end', marginBottom: '10px' } },
        el('button.btn.small', { onclick: () => K.api.post('/k/dl/cancel', { id: '*' }).then(pollQueue) }, icon('x'), 'Cancel all')),
        ...[...groups.values()].map(js => {
          const j0 = js[0], done = js.reduce((a, j) => a + (j.done || 0), 0), total = js.reduce((a, j) => a + (j.total || 0), 0);
          const cover = j0.cover || K.data.library[`${j0.provider}:${j0.seriesSlug}`]?.cover;
          return el('div.qgroup.glass',
            el('div.th', img(cover, j0.seriesTitle)),
            el('div.qbody',
              el('div.row', { style: { justifyContent: 'space-between' } }, el('b', { text: j0.seriesTitle }), el('span.muted', { text: `${js.length} chapter${js.length > 1 ? 's' : ''}` })),
              el('div.bar', el('i', { style: { width: (total ? Math.round(done / total * 100) : 0) + '%' } })),
              ...js.map(j => el('div.qrow',
                el('span', { text: j.chapterName.replace(/ — .*/, '') }),
                el('small.muted', { text: j.state === 'queued' ? 'Waiting' : j.state === 'failed' ? (j.error || 'Failed') : `${j.done} / ${j.total} pages` }),
                j.state === 'failed' ? null : el('button.btn.small.icon', { title: 'Cancel', onclick: () => K.api.post('/k/dl/cancel', { id: j.id }).then(pollQueue) }, icon('x'))))));
        }));
    }

    drawStore(); drawTabs(); drawBody();
    const onQ = () => { if (!root.isConnected || document.querySelector('.reader')) return; drawTabs(); if (tab === 'queue') drawQueue(); };
    const onD = () => { if (!root.isConnected || document.querySelector('.reader')) return; drawStore(); if (tab === 'saved') drawSaved(); };
    document.addEventListener('koru-queue', onQ); document.addEventListener('koru-downloads', onD);
    await K.refreshDownloads();
    pollQueue();
  };

  // ---------- one downloaded series: its saved chapters, Continue, delete, Kotatsu style ----------
  K.views.local = async function (root, r) {
    const [provider, slug] = r.parts;
    if (!K.dl.series) await K.refreshDownloads();
    const find = () => (K.dl.series || []).find(x => x.provider === provider && x.seriesSlug === slug);
    let s = find();
    if (!s) { root.append(el('div.empty', K.fox(), el('h3', { text: 'Not downloaded' }), el('p', { text: 'This series has no saved chapters on this PC.' }),
      el('a.btn', { href: '#/downloads' }, icon('back'), 'Back to downloads'))); return; }
    let newest = localStorage.getItem('koru-localsort') !== 'old', picking = false;
    const picked = new Set();
    const hero = el('div.hero'), tools = el('div.section'), list = el('div.list.chlist');
    root.append(hero, tools, list);

    function drawHero() {
      const cover = coverOf(s), res = K.localResume(s);
      const read = s.chapters.filter(c => K.isRead(provider, slug, c.chapterSlug)).length;
      hero.replaceChildren(
        el('div.bd', { style: cover ? { backgroundImage: `url("${cover.replace(/["\\]/g, '')}")` } : {} }),
        el('button.btn.backb', { title: 'Back (Alt+Left)', onclick: () => K.back() }, icon('back'), 'Back'),
        el('div.wrap',
          el('div.poster', img(cover, s.title, '', 320)),
          el('div.info',
            el('span.tag', { text: (P(provider)?.name || provider) + ' · saved on this PC' }),
            el('h1', { text: s.title }),
            el('div.muted', { text: `${s.chapters.length} chapters downloaded · ${K.bytes(s.bytes)} · ${read} read` }),
            el('div.sprog', el('i', { style: { width: Math.round(read / s.chapters.length * 100) + '%' } })),
            el('div.row', { style: { marginTop: '16px' } },
              el('button.btn.primary', { onclick: () => readLocal(s, res.c) }, icon('play'), res.label),
              el('a.btn', { href: `#/series/${provider}/${encodeURIComponent(slug)}` }, icon('explore'), 'Series page'),
              el('button.btn', { title: 'Delete every downloaded chapter of this series', onclick: async () => {
                if (!confirm(`Delete all ${s.chapters.length} downloaded chapters of ${s.title}? They can be downloaded again later.`)) return;
                await K.api.post('/k/dl/delete', { series: `${provider}:${slug}` }); await K.refreshDownloads(); K.toast('Downloads deleted'); K.go('/downloads', true);
              } }, icon('trash'), 'Delete all')))));
    }
    function drawTools() {
      tools.replaceChildren(el('h2', { text: 'Saved chapters' }), el('span.count', { text: String(s.chapters.length) }), el('div', { style: { flex: 1 } }),
        picking
          ? el('div.row', el('span.muted', { text: picked.size + ' selected' }),
            el('button.btn.small', { onclick: () => { s.chapters.forEach(c => picked.add(c.id)); drawList(); drawTools(); } }, 'All'),
            el('button.btn.small', { disabled: !picked.size, onclick: () => { for (const c of s.chapters) if (picked.has(c.id)) K.markRead(provider, slug, c.chapterSlug, true); done(); } }, icon('done'), 'Mark read'),
            el('button.btn.small', { disabled: !picked.size, onclick: () => { for (const c of s.chapters) if (picked.has(c.id)) K.markRead(provider, slug, c.chapterSlug, false); done(); } }, icon('undo'), 'Mark unread'),
            el('button.btn.small', { disabled: !picked.size, onclick: async () => {
              if (!confirm(`Delete ${picked.size} downloaded chapter${picked.size > 1 ? 's' : ''}?`)) return;
              for (const id of picked) await K.api.post('/k/dl/delete', { id });
              await K.refreshDownloads(); s = find(); if (!s) { K.go('/downloads', true); return; } done();
            } }, icon('trash'), 'Delete'),
            el('button.btn.small', { onclick: () => { picking = false; picked.clear(); drawTools(); drawList(); } }, icon('x'), 'Done'))
          : el('div.row',
            el('button.btn.small', { onclick: () => { newest = !newest; localStorage.setItem('koru-localsort', newest ? 'new' : 'old'); drawTools(); drawList(); } }, icon('refresh'), newest ? 'Newest first' : 'Oldest first'),
            el('button.btn.small', { onclick: () => { picking = true; drawTools(); drawList(); } }, icon('select'), 'Select')));
    }
    function done() { picking = false; picked.clear(); drawHero(); drawTools(); drawList(); }
    function drawList() {
      const h = K.data.history[`${provider}:${slug}`];
      const chs = [...s.chapters].sort(chapSort);
      if (newest) chs.reverse();
      list.replaceChildren(...chs.map((c, i) => {
        const read = K.isRead(provider, slug, c.chapterSlug), cur = h?.chapterSlug === c.chapterSlug && !h.done;
        const row = el('div.item' + (read ? '.read' : '') + (cur ? '.current' : '') + (picked.has(c.id) ? '.picked' : ''), { style: { '--i': Math.min(i, 20) } },
          picking ? el('span.check', picked.has(c.id) ? icon('done') : null) : null,
          el('div.n', el('b', { text: c.chapterName }),
            el('small', { text: [cur ? `Reading · page ${(h.page || 0) + 1} of ${c.files.length}` : read ? 'Read' : null, `${c.files.length} pages`, K.bytes(c.bytes || 0), c.savedAt ? 'saved ' + K.ago(c.savedAt) : null].filter(Boolean).join(' · ') })),
          picking ? null : el('button.btn.small.icon', { title: 'Delete this download', onclick: async e => {
            e.stopPropagation(); await K.api.post('/k/dl/delete', { id: c.id }); await K.refreshDownloads(); s = find();
            if (!s) { K.go('/downloads', true); return; } drawHero(); drawTools(); drawList();
          } }, icon('trash')));
        row.onclick = () => { if (picking) { picked.has(c.id) ? picked.delete(c.id) : picked.add(c.id); drawTools(); drawList(); } else readLocal(s, c); };
        row.addEventListener('contextmenu', e => { e.preventDefault(); if (!picking) { picking = true; picked.add(c.id); drawTools(); drawList(); } });
        return row;
      }));
    }
    drawHero(); drawTools(); drawList();
  };
})();
