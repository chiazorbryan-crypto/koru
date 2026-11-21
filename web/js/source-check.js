// Koru quiet source check: when a site one of your favourites is on stays down, Koru finds the same series on
// another source and moves your favourite and progress there (K.moveSeries in library-extra.js, so history,
// read marks, ratings, notes, shelves and stats follow), then says so calmly.
//  - "Down" means the site failed (network error, 5xx, blocked) on at least two tries 15+ minutes apart, with
//    nothing working in between, while other sites answered. A single hiccup never counts.
//  - Never while you're offline: navigator.onLine, and another source has to answer right before moving.
//  - Only a confident match: the same title, and a chapter count close to what you had.
//  - Gentle on the sites: one series at a time, a pause between requests, each source looked over at most
//    every 3 hours, each series tried at most twice a day.
//  - Every move is remembered, so the series page can offer "Move back" once the first site works again.
'use strict';
(function () {
  const { el, icon } = K;
  const P = id => K.providers[id];
  const HKEY = 'koru-srchealth';
  const ROUND = 5 * 60e3, DOWN_FOR = 15 * 60e3, STALE = 3 * 3600e3, SWEEP_EVERY = 3 * 3600e3, RETRY_SERIES = 12 * 3600e3;
  const PROBE_EVERY = 45 * 60e3, PAGE_PROBE = 10 * 60e3, PER_SWEEP = 12, MAX_SOURCES = 8, GAP = 1500;
  const on = () => K.data.settings.srcMove !== false;
  const fin = n => typeof n === 'number' && Number.isFinite(n);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const nameOf = id => P(id)?.short || P(id)?.name || id;
  const online = () => navigator.onLine !== false;

  // ---------- how each source is doing (this PC only) ----------
  // health[id] = { ok: last answer of any kind, series: { rounds: [failure times, 5+ min apart] }, chapters: {...}, swept, probed }
  // A success of a kind clears that kind's failures, so "down" always means "nothing worked since".
  let health = {};
  try { health = JSON.parse(localStorage.getItem(HKEY) || '{}') || {}; } catch {}
  const saveHealth = K.debounce(() => { try { localStorage.setItem(HKEY, JSON.stringify(health)); } catch {} }, 1000);
  const H = id => (health[id] ||= { ok: 0 });
  const KINDS = ['series', 'chapters'];
  // The kind of failure that means "the site is down or blocking", not "this chapter is locked" or "not found".
  function outage(e) {
    if (!e || e.locked) return false;
    const st = e.status;
    if (st) return st >= 500 || st === 401 || st === 403;
    const m = String(e.message || '');
    if (/not found|locked|isn'?t in koru/i.test(m)) return false;
    if (/down or busy|couldn'?t reach|failed to fetch|network|timed? ?out|answered (5\d\d|40[13])|blocked|cloudflare|busy/i.test(m)) return true;
    return e instanceof TypeError || e instanceof SyntaxError;   // the site answered with something that isn't its page (a block page)
  }
  function ok(id, kind) {
    const h = H(id);
    h.ok = Date.now();
    if (kind && h[kind]?.rounds?.length) h[kind].rounds = [];
    saveHealth();
    if (kind) cameBack(id);
  }
  function fail(id, kind, e) {
    if (!online() || !outage(e)) return;
    const h = H(id), k = h[kind] ||= { rounds: [] }, now = Date.now(), last = k.rounds[k.rounds.length - 1] || 0;
    if (now - last < ROUND) return;   // the same try (one check run, one page open)
    k.rounds.push(now); k.rounds = k.rounds.slice(-6);
    saveHealth();
    if (k.rounds.length >= 2) soon(id);
  }
  // Watch the real requests: each source's own series and chapters calls (cached answers never reach these).
  function watch(p) {
    if (!p || p._srcWatch) return;
    p._srcWatch = true;
    for (const kind of [...KINDS, 'list']) {
      const fn = p[kind];
      if (typeof fn !== 'function') continue;
      p[kind] = function (...a) {
        return Promise.resolve().then(() => fn.apply(this, a)).then(v => { if (v != null) ok(p.id, kind === 'list' ? null : kind); return v; },
          e => { if (kind !== 'list') fail(p.id, kind, e); throw e; });
      };
    }
  }
  Object.values(K.providers).forEach(watch);
  const addProvider = K.addProvider;
  K.addProvider = p => { addProvider(p); watch(K.providers[p?.id]); };

  const isDown = id => {
    const h = health[id], now = Date.now();
    return !!h && KINDS.some(k => { const r = h[k]?.rounds || []; return r.length >= 2 && r[r.length - 1] - r[0] >= DOWN_FOR && now - r[r.length - 1] < STALE; });
  };
  // another source answered lately (so the connection itself is fine)
  const othersFine = id => Object.entries(health).some(([o, h]) => o !== id && P(o) && Date.now() - (h.ok || 0) < 15 * 60e3);

  // ---------- the moves (kept in settings, so they survive restarts) ----------
  // moves['to-provider:slug'] = { from: { provider, slug, title, cover }, to: { provider, slug, title }, at, back: the first site works again }
  const moves = () => (K.data.settings.srcMoves ||= {});
  const saveMoves = () => {
    const m = moves(), keys = Object.keys(m);
    if (keys.length > 60) keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - 60).forEach(k => delete m[k]);
    K.save('settings');
  };
  const tried = {};   // 'provider:slug' -> last time Koru looked for it elsewhere (this run)
  const toldBack = {};
  function cameBack(id) {
    const list = Object.values(moves()).filter(m => m.from.provider === id && !m.back);
    if (!list.length) return;
    list.forEach(m => { m.back = Date.now(); });
    saveMoves();
    document.dispatchEvent(new CustomEvent('koru-srcmove'));
    if (toldBack[id] && Date.now() - toldBack[id] < 6 * 3600e3) return;
    toldBack[id] = Date.now();
    K.toast(list.length === 1 ? `${nameOf(id)} works again. You can move ${list[0].from.title} back from its page.` : `${nameOf(id)} works again. You can move ${list.length} series back from their pages.`);
  }

  // ---------- looking for a favourite on another source ----------
  const busyNow = () => document.documentElement.classList.contains('reading');   // never while you read
  const calm = async () => {
    while (busyNow()) await sleep(5000);
    await new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 4000 }) : setTimeout(r, 300)));
  };
  const chNum = s => { const m = String(s ?? '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  // the chapter count has to be close to what you had: the top chapter number first, else how many there are
  function similar(chs, fav) {
    if (!Array.isArray(chs) || !chs.length) return false;
    const nums = chs.map(c => c.number).filter(fin), top = nums.length ? Math.max(...nums) : null;
    const was = fin(fav.baseNum) ? fav.baseNum : null, total = fav.total || 0;
    if (fin(was) && was > 0 && fin(top)) { if (top < was * 0.85 - 3 || top > was * 1.35 + 10) return false; }
    else if (total) { if (chs.length < total * 0.7 - 3 || chs.length > total * 1.6 + 10) return false; }
    else return false;   // nothing to compare with: not sure enough to move anything
    if (total && (chs.length < total * 0.5 - 5 || chs.length > total * 2.5 + 20)) return false;
    const at = chNum(K.data.history[K.key(fav.provider, fav.slug)]?.chapterName);
    return !(fin(at) && fin(top) && top < at);   // where you are has to exist there
  }
  // sources to look on: the ones you already read other favourites on first, then Koru's usual order
  function sourcesFor(from) {
    const used = new Map();
    for (const it of Object.values(K.data.library)) if (it?.provider) used.set(it.provider, (used.get(it.provider) || 0) + 1);
    return K.providerList.filter(p => p.id !== from && !p.hidden && !isDown(p.id))
      .map((p, i) => [p, i]).sort((a, b) => (used.get(b[0].id) || 0) - (used.get(a[0].id) || 0) || a[1] - b[1]).map(x => x[0]).slice(0, MAX_SOURCES);
  }
  async function findMatch(fav) {
    const X = K.libx;
    const known = X.known(fav.provider, fav.slug), title = fav.title || known.title;
    const keys = X.keysOf({ title });
    if (!keys.size) return null;
    for (const p of sourcesFor(fav.provider)) {
      if (!on() || !online()) return null;
      await calm(); await sleep(GAP);
      let res;
      try { res = await withTimeout(Promise.resolve().then(() => p.list({ q: title, page: 1 })), 30000); } catch { continue; }
      const hits = (res?.items || []).map(s => ({ ...s, provider: s.provider || p.id })).filter(s => s.slug && K.notTrash(s) && X.likeness(keys, X.keysOf(s)) === 2).slice(0, 2);
      for (const s of hits) {
        await sleep(GAP);
        let chs;
        try { chs = await withTimeout(K.getChapters(s.provider, s.slug, true), 40000); } catch { continue; }
        if (similar(chs, fav)) return { provider: s.provider, slug: s.slug, title: s.title, cover: s.cover, chapters: chs };
      }
    }
    return null;
  }
  // right before moving: another source answers now (you're online), and this one still doesn't
  async function anotherAnswers(id) {
    const others = K.providerList.filter(p => p.id !== id && !p.hidden && !isDown(p.id))
      .sort((a, b) => (health[b.id]?.ok || 0) - (health[a.id]?.ok || 0)).slice(0, 2);
    for (const p of others) {
      try { const r = await withTimeout(Promise.resolve().then(() => p.list({ page: 1 })), 25000); if (r?.items) return true; } catch {}
    }
    return false;
  }
  async function stillDown(id, fav) {
    const kind = (health[id]?.chapters?.rounds?.length || 0) >= 2 ? 'chapters' : 'series';
    try { await withTimeout(kind === 'chapters' ? K.getChapters(id, fav.slug, true) : P(id).series(fav.slug), 30000); return false; }
    catch (e) { return outage(e) || /timeout/.test(e?.message || ''); }
  }

  let sweeping = false;
  const timers = {};
  function soon(id) { clearTimeout(timers[id]); timers[id] = setTimeout(() => sweep(id), 30e3); }
  async function sweep(id, force) {
    if (sweeping || !on() || !online() || !K.libx || !K.moveSeries || !P(id)) return { moved: 0, why: 'off' };
    if (!force && (!isDown(id) || !othersFine(id))) return { moved: 0, why: 'not down' };
    const h = H(id);
    if (!force && Date.now() - (h.swept || 0) < SWEEP_EVERY) return { moved: 0, why: 'recently' };
    const favs = () => Object.entries(K.data.library).filter(([k, it]) => it?.provider === id && K.notTrash(it) && K.readingSeries?.() !== k);
    if (!favs().length) return { moved: 0, why: 'no favourites' };
    sweeping = true;
    const done = [];
    try {
      await calm();
      if (!online() || !(await anotherAnswers(id))) return { moved: 0, why: 'offline' };
      if (!(await stillDown(id, favs()[0][1]))) { ok(id, 'series'); ok(id, 'chapters'); return { moved: 0, why: 'works again' }; }
      h.swept = Date.now(); saveHealth();
      let n = 0;
      for (const [key, fav] of favs()) {
        if (n >= PER_SWEEP || !on() || !online()) break;
        if (Date.now() - (tried[key] || 0) < RETRY_SERIES) continue;
        tried[key] = Date.now(); n++;
        let m = null;
        try { m = await findMatch(fav); } catch {}
        if (!m || K.data.library[key] !== fav) continue;   // nothing confident, or you changed it meanwhile
        try {
          const from = { provider: fav.provider, slug: fav.slug, title: fav.title || fav.slug, cover: fav.cover || null };
          const to = { provider: m.provider, slug: m.slug, title: m.title, cover: m.cover };
          const res = await K.moveSeries(from, to, m.chapters);
          if (!res?.moved) continue;
          moves()[K.key(to.provider, to.slug)] = { from, to: { provider: to.provider, slug: to.slug, title: to.title || from.title }, at: Date.now() };
          delete moves()[K.key(from.provider, from.slug)];
          saveMoves();
          done.push({ from, to });
        } catch {}
      }
      if (n < favs().length) h.swept = Date.now() - SWEEP_EVERY + 30 * 60e3;   // more to look at: carry on in half an hour
      saveHealth();
    } finally { sweeping = false; }
    if (done.length) {
      const one = done[0];
      K.toast(done.length === 1 ? `${nameOf(id)} was down, so Koru moved ${one.from.title} to ${nameOf(one.to.provider)}.` : `${nameOf(id)} was down, so Koru moved ${done.length} series to other sources.`);
      document.dispatchEvent(new CustomEvent('koru-srcmove'));
    }
    return { moved: done.length, done };
  }

  // ---------- noticing that a first site works again ----------
  async function probe(id, force) {
    const h = H(id), list = Object.values(moves()).filter(m => m.from.provider === id && !m.back);
    if (!list.length || !online() || (!force && Date.now() - (h.probed || 0) < PROBE_EVERY)) return !list.length;
    h.probed = Date.now(); saveHealth();
    try { const s = await withTimeout(P(id).series(list[0].from.slug), 30000); return !!s; }   // a success marks every move from it (see ok)
    catch { return false; }
  }
  setInterval(() => {
    if (!on() || busyNow()) return;
    const ids = new Set(Object.values(moves()).filter(m => !m.back && P(m.from.provider)).map(m => m.from.provider));
    ids.forEach(id => probe(id));
  }, 15 * 60e3);

  async function moveBack(key) {
    const m = moves()[key];
    if (!m) throw new Error('Nothing to move back.');
    const chs = await K.getChapters(m.from.provider, m.from.slug, true);
    const res = await K.moveSeries({ provider: m.to.provider, slug: m.to.slug, title: m.to.title || m.from.title }, { ...m.from }, chs);
    delete moves()[key]; saveMoves();
    ok(m.from.provider, 'series'); ok(m.from.provider, 'chapters');
    document.dispatchEvent(new CustomEvent('koru-srcmove'));
    return res;
  }

  // ---------- the line on the series page ----------
  function seriesNote(s) {
    const key = K.key(s.provider, s.slug), m = moves()[key];
    if (!m || !P(m.from.provider)) return null;
    const from = nameOf(m.from.provider), to = nameOf(s.provider);
    const hint = el('small.muted', { text: `You can move it back when ${from} works again.` });
    const back = el('button.btn.small', { hidden: !m.back, title: `Move your favourite and progress back to ${P(m.from.provider)?.name || from}`, onclick: async () => {
      back.disabled = true; back.lastChild.textContent = 'Moving back…';
      try { await moveBack(key); K.toast(`Moved back to ${from}`, 'ok'); K.go(`/series/${m.from.provider}/${encodeURIComponent(m.from.slug)}`, true); }
      catch (e) { K.toast('Couldn\'t move back: ' + (e?.message || `${from} didn't answer`), 'error'); back.disabled = false; back.lastChild.textContent = 'Move back'; }
    } }, icon('undo'), el('span', { text: 'Move back' }));
    const box = el('div.sx-note.glass', icon('refresh'), el('div.sx-t', el('span', { text: `${from} was down, so Koru moved this to ${to}.` }), m.back ? null : hint), back,
      el('button.btn.small.icon', { title: 'Keep it here (hide this note)', 'aria-label': 'Keep it here', onclick: () => { delete moves()[key]; saveMoves(); box.remove(); } }, icon('x')));
    if (!m.back) {
      const h = H(m.from.provider);
      if (Date.now() - (h.probed || 0) > PAGE_PROBE) probe(m.from.provider, true).then(works => { if (works && box.isConnected && moves()[key]?.back) { back.hidden = false; hint.remove(); } });
    }
    return box;
  }

  // ---------- Settings → Library & sync ----------
  (K.settingsExtras ||= []).push(() => {
    const t = el('button.toggle' + (on() ? '.on' : ''), { role: 'switch', 'aria-checked': String(on()) });
    t.onclick = () => { const v = !t.classList.contains('on'); t.classList.toggle('on', v); t.setAttribute('aria-checked', String(v)); K.data.settings.srcMove = v; K.save('settings'); };
    const list = Object.entries(moves()).sort((a, b) => b[1].at - a[1].at).slice(0, 6);
    return el('section.panel.glass', el('h3', icon('refresh'), 'When a source goes down'),
      el('p', { text: 'If a site stays down for a while, Koru quietly finds your favourites on another source and moves them there. It never moves anything while you\'re offline.' }),
      el('div.ctl', el('div.lab', 'Move series when a source goes down', el('small', { text: 'Only to the same title with about as many chapters. Your history, read chapters, ratings, notes and shelves move too' })), t),
      list.length ? el('div.sx-moves', list.map(([k, m]) => el('a.sx-mv', { href: `#/series/${m.to.provider}/${encodeURIComponent(m.to.slug)}` },
        el('b', { text: m.from.title || m.from.slug }), el('small.muted', { text: `${nameOf(m.from.provider)} → ${nameOf(m.to.provider)} · ${K.ago(m.at)}${m.back ? ' · can move back' : ''}` })))) : null);
  });

  K.srcCheck = { seriesNote, sweep, isDown, moveBack, probe, health: () => health, moves, outage, similar, findMatch,
    reset: id => { if (id) delete health[id]; else health = {}; saveHealth(); } };
})();
