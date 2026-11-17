// Koru discover:
//  - Trending: every source's popular list merged into one ranked list (the same series from different sources is one card)
//  - Completed only: a filter for Explore and Search (each site words it differently: Completed, Complete, Finished, Ended…)
//  - More like this: picks from the genres of what you rate highly and read most, and a row on every series page
//  - Release days: which weekday each favourite usually gets its new chapter, worked out from its chapter dates
// Everything here keeps its own small caches (localStorage, this device only) so the sites aren't asked twice.
// views.js calls in through K.disc.* hooks, so everything here is optional for it.
'use strict';
(function () {
  const { el, icon, img } = K;
  const P = id => K.providers[id];
  const D = K.disc = {};
  const H = 3600e3, DAY = 864e5;
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const norm = t => (K.libx?.norm ? K.libx.norm(t) : String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  const keysOf = s => (K.libx?.keysOf ? K.libx.keysOf(s) : new Set([norm(s?.title)].filter(Boolean)));
  const best = items => (K.libx?.best ? K.libx.best(items) : items[0]);
  const splitKey = k => { const [provider, ...rest] = String(k).split(':'); return { provider, slug: rest.join(':') }; };
  const usable = p => !!p && !p.hidden;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  // fn over every item, n at a time; one failing doesn't stop the others
  async function pool(items, n, fn) {
    const q = items.slice();
    await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch {} } }));
  }
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const where = s => `/series/${s.provider}/${encodeURIComponent(s.slug)}`;
  const miniRail = n => el('div.dc-rail', Array.from({ length: n }, () => el('div.skel.cover')));

  // ---------- Completed only ----------
  // "Completed", "Complete", "Finished", "Ended", "Concluded" all count; "Not completed", "Ongoing", "Hiatus" don't.
  D.isDone = st => {
    const s = String(st || '').toLowerCase().trim();
    if (!s || /\b(not|ongoing|on ?going|hiatus|upcoming|yet|dropped|cancell?ed|discontinued)\b/.test(s)) return false;
    return /complete|finish|\bend(ed)?\b|conclu/.test(s);
  };
  D.doneOnly = () => sessionStorage.getItem('koru-doneonly') === '1';
  const setDoneOnly = on => sessionStorage.setItem('koru-doneonly', on ? '1' : '0');
  // the chip next to Explore's Latest / Popular / Trending
  D.doneChip = function (onChange) {
    const b = el('button.chip' + (D.doneOnly() ? '.on' : ''), { title: 'Only show series the site lists as completed', onclick: () => {
      setDoneOnly(!D.doneOnly()); b.classList.toggle('on', D.doneOnly()); onChange?.();
    } }, icon('done'), 'Completed only');
    return b;
  };
  // Search: the merged cards keep their results on node._g (library-extra.js); cards whose results never say
  // completed are hidden while the chip is on. Nothing is searched again.
  D.searchFilter = function (out) {
    const note = el('small.muted.dc-note');
    const tag = () => {
      let shown = 0, all = 0;
      for (const n of out.querySelectorAll('.card')) {
        const items = n._g?.items || [];
        const done = items.some(s => D.isDone(s.status));
        n.classList.toggle('dc-notdone', !done);
        all++; if (done) shown++;
      }
      out.classList.toggle('dc-doneonly', D.doneOnly());
      note.textContent = !D.doneOnly() || !all ? '' : shown ? `${shown} completed` : 'None of these say completed yet. Some sources don\'t list it in search.';
    };
    const mo = new MutationObserver(K.debounce(tag, 120));
    mo.observe(out, { childList: true, subtree: true });
    const b = el('button.chip' + (D.doneOnly() ? '.on' : ''), { title: 'Only show series the site lists as completed', onclick: () => {
      setDoneOnly(!D.doneOnly()); b.classList.toggle('on', D.doneOnly()); tag();
    } }, icon('done'), 'Completed only');
    tag();
    return el('div.row.dc-srow', b, note);
  };

  // ---------- Trending: every source's popular list, merged ----------
  // A series scores 1/√rank on each source that lists it (#1 → 1, #4 → .5, #9 → .33), added up across sources,
  // so something popular on several sites ranks above a single site's #1. Kept for 6 hours.
  const TREND_KEY = 'koru-disc-trend', TREND_TTL = 6 * H;
  const hasPopular = p => usable(p) && !p.noPopular && /popular/.test(String(p.list));
  function merge(lists) {
    const groups = [], byKey = new Map();
    for (const { items } of lists) {
      items.forEach((s, i) => {
        const keys = keysOf(s);
        const hits = [...new Set([...keys].map(k => byKey.get(k)).filter(Boolean))];
        let g = hits[0];
        if (!g) { g = { keys: new Set(), items: [], pts: new Map() }; groups.push(g); }
        for (const o of hits.slice(1)) {   // ties two groups together: fold the second into the first
          o.items.forEach(x => g.items.push(x)); o.keys.forEach(k => g.keys.add(k));
          o.pts.forEach((v, p) => g.pts.set(p, Math.max(v, g.pts.get(p) || 0)));
          groups.splice(groups.indexOf(o), 1);
        }
        if (!g.items.some(x => x.provider === s.provider && x.slug === s.slug)) g.items.push(s);
        g.pts.set(s.provider, Math.max(g.pts.get(s.provider) || 0, 1 / Math.sqrt(i + 1)));   // one score per source
        for (const k of keys) g.keys.add(k);
        for (const k of g.keys) byKey.set(k, g);
      });
    }
    return groups.map(g => {
      const b = best(g.items), score = [...g.pts.values()].reduce((a, v) => a + v, 0);
      const pick = x => ({ provider: x.provider, slug: x.slug, title: x.title, status: x.status || '', latest: x.latest || '' });
      return { ...pick(b), cover: b.cover || g.items.find(x => x.cover)?.cover || null, n: g.pts.size, score: Math.round(score * 1000) / 1000,
        also: g.items.filter(x => x !== b).map(pick) };
    }).sort((a, b) => b.score - a.score || b.n - a.n).slice(0, 150);
  }
  let trendRun = null;
  const trendWatch = new Set();
  D.trendingData = function (force) {
    const c = ls.get(TREND_KEY, null);
    if (!force && c?.items?.length && Date.now() - c.at < TREND_TTL) return Promise.resolve(c);
    if (trendRun) return trendRun;
    trendRun = (async () => {
      const srcs = K.providerList.filter(hasPopular), lists = [];
      let done = 0;
      await pool(srcs, 4, async p => {
        try {
          const res = await withTimeout(K.cached(`l:${p.id}:popular:1`, 5 * 60e3, () => p.list({ sort: 'popular', page: 1 })), 25000);
          const items = (res?.items || []).map(s => ({ ...s, provider: s.provider || p.id })).filter(s => s.slug && s.title).slice(0, 30);
          if (items.length) lists.push({ id: p.id, items });
        } finally {
          done++;
          const part = { at: Date.now(), total: srcs.length, ok: lists.length, items: merge(lists), busy: { done, total: srcs.length } };
          trendWatch.forEach(f => f(part));
        }
      });
      const out = { at: Date.now(), total: srcs.length, ok: lists.length, items: merge(lists) };
      if (out.items.length) ls.set(TREND_KEY, out);
      else if (c?.items?.length) return c;   // every source failed: keep showing the last good list
      return out;
    })();
    const clear = () => { trendRun = null; };
    trendRun.then(clear, clear);
    return trendRun;
  };
  // Explore's Trending tab, drawn into its grid
  D.trending = function (grid, alive) {
    let last = null, lastDraw = 0, timer = 0;
    const draw = data => {
      if (!alive()) return;
      last = data;
      const busy = data.busy;
      let items = (data.items || []).filter(g => K.notTrash(g));
      if (D.doneOnly()) items = items.filter(g => [g, ...(g.also || [])].some(x => D.isDone(x.status)));
      const head = el('div.row.dc-gridhead', { style: { gridColumn: '1/-1' } },
        el('span.muted', { text: busy ? `Asking every source what's popular… ${busy.done} of ${busy.total}`
          : `Popular on ${data.ok} of ${data.total} sources, merged · updated ${K.ago(data.at)}` }),
        el('div', { style: { flex: 1 } }),
        busy ? null : el('button.btn.small', { title: 'Ask every source again', onclick: () => run(true) }, icon('refresh'), 'Refresh'));
      const cards = items.slice(0, 120).map((g, i) => K.card(g, i < 24 ? i : i % 12, { sub: `#${i + 1}` + (g.n > 1 ? ` · on ${g.n} sources` : g.latest ? ' · ' + g.latest : '') }));
      grid.replaceChildren(head, ...cards);
      if (!cards.length && !busy) grid.append(el('div.empty', { style: { gridColumn: '1/-1' } }, el('p', { text: D.doneOnly() ? 'No completed series in the popular lists right now.' : 'The sources didn\'t answer. Try Refresh in a bit.' })));
      if (!cards.length && busy) grid.append(...Array.from({ length: 12 }, () => el('div.skel.cover')));
    };
    const onPart = part => {   // while sources answer: redraw at most twice a second
      if (!alive()) { trendWatch.delete(onPart); return; }
      if (last && !last.busy) return;   // an older list is showing; swap it once everything is in
      clearTimeout(timer);
      const wait = Math.max(0, 500 - (Date.now() - lastDraw));
      timer = setTimeout(() => { lastDraw = Date.now(); draw(part); }, wait);
    };
    async function run(force) {
      trendWatch.add(onPart);
      if (force) last = null;
      try { const data = await D.trendingData(force); clearTimeout(timer); draw(data); }
      catch (e) { if (alive()) grid.replaceChildren(K.errorBox(e)); }
      finally { trendWatch.delete(onPart); }
    }
    const c = ls.get(TREND_KEY, null);
    if (c?.items?.length) draw(c);   // show the saved list straight away; a stale one is refreshed behind it
    if (!c?.items?.length || Date.now() - c.at >= TREND_TTL) run(false);
  };

  // ---------- More like this ----------
  // Genres of a series, kept 14 days per series (the series pages are asked only once).
  const TAGS_KEY = 'koru-disc-tags', TAG_TTL = 14 * DAY;
  const NOISE = new Set(['manhwa', 'manhua', 'manga', 'webtoon', 'webtoons', 'longstrip', 'fullcolor', 'webcomic', 'officialcolored', 'comic', 'comics',
    'oneshot', 'adaptation', 'completed', 'ongoing', 'english', 'korean', 'chinese', 'japanese', 'hot', 'new', 'na', 'none', 'other', 'others']);
  const tagKey = t => String(t || '').toLowerCase().replace(/science[\s-]*fiction/, 'scifi').replace(/[^a-z0-9]+/g, '');
  const cleanTags = list => {
    const seen = new Set(), out = [];
    for (const t of list || []) { const k = tagKey(t); if (k.length < 2 || NOISE.has(k) || seen.has(k)) continue; seen.add(k); out.push(String(t).trim()); }
    return out;
  };
  let tagsDb = null;
  const tags = () => (tagsDb ||= ls.get(TAGS_KEY, {}));
  const saveTags = K.debounce(() => {
    const db = tags(), keys = Object.keys(db);
    if (keys.length > 700) keys.sort((a, b) => (db[a].at || 0) - (db[b].at || 0)).slice(0, keys.length - 600).forEach(k => delete db[k]);
    ls.set(TAGS_KEY, db);
  }, 1000);
  const keepTags = (s, list) => {
    const t = cleanTags(list);
    tags()[K.key(s.provider, s.slug)] = { t, at: Date.now(), title: s.title || '', cover: s.cover || null, status: s.status || '' };
    saveTags();
    return t;
  };
  async function tagsOf(provider, slug) {
    const hit = tags()[K.key(provider, slug)];
    if (hit && Date.now() - hit.at < TAG_TTL) return hit.t;
    const s = await withTimeout(K.getSeries(provider, slug), 20000);
    return keepTags({ ...s, provider, slug }, s?.tags);
  }

  // MangaDex can search by genre (the other sites only by title): its genre list is kept 14 days.
  const MD = 'https://api.mangadex.org';
  const MD_RATINGS = '&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica';
  const mdName = a => a?.title?.en || Object.values(a?.title || {})[0] || 'Untitled';
  const cap = s => String(s || '').toLowerCase().replace(/^\w/, c => c.toUpperCase());
  async function mdTagIds() {
    const c = ls.get('koru-disc-mdtags', null);
    if (c?.map && Date.now() - c.at < TAG_TTL) return c.map;
    const j = await K.api.site(`${MD}/manga/tag`);
    const map = {};
    for (const t of j?.data || []) { const n = t.attributes?.name?.en; if (n) map[tagKey(n)] = t.id; }
    if (Object.keys(map).length) ls.set('koru-disc-mdtags', { at: Date.now(), map });
    return map;
  }
  // the most-followed MangaDex series with these genres (all of the first two it knows); kept 12 hours
  async function mdByTags(names) {
    if (!usable(P('mangadex'))) return [];
    const map = await mdTagIds();
    const ids = [...new Set(names.map(n => map[tagKey(n)]).filter(Boolean))].slice(0, 2).sort();
    if (!ids.length) return [];
    const ck = 'koru-disc-md', all = ls.get(ck, {}), hit = all[ids.join(',')];
    if (hit && Date.now() - hit.at < 12 * H) return hit.items;
    const j = await K.api.site(`${MD}/manga?limit=32&order[followedCount]=desc&availableTranslatedLanguage[]=en&hasAvailableChapters=true&includes[]=cover_art${MD_RATINGS}&includedTagsMode=AND${ids.map(id => '&includedTags[]=' + id).join('')}`);
    const items = (j?.data || []).map(m => {
      const a = m.attributes || {}, f = m.relationships?.find(r => r.type === 'cover_art')?.attributes?.fileName;
      const s = { provider: 'mangadex', slug: m.id, title: mdName(a), cover: f ? `https://uploads.mangadex.org/covers/${m.id}/${f}.512.jpg` : null,
        status: cap(a.status), latest: a.lastChapter ? 'Chapter ' + a.lastChapter : '' };
      keepTags(s, (a.tags || []).map(t => t.attributes?.name?.en).filter(Boolean));
      return s;
    });
    all[ids.join(',')] = { at: Date.now(), items };
    for (const k of Object.keys(all)) if (Date.now() - all[k].at > 12 * H) delete all[k];
    ls.set(ck, all);
    return items;
  }

  // Series you already know (favourites, history, likes, read marks, ratings, stats): never suggested.
  function knownSets() {
    const d = K.data, st = K.statsAll?.() || d.stats || {};
    const keys = new Set(), titles = new Set();
    for (const store of [d.library, d.history, d.liked, d.read, d.notes, st.series, d.flags]) {
      for (const [k, v] of Object.entries(store || {})) {
        keys.add(k);
        if (v && typeof v === 'object' && v.title) for (const t of keysOf(v)) titles.add(t);
      }
    }
    return { keys, titles, has: s => keys.has(K.key(s.provider, s.slug)) || [...keysOf(s)].some(t => titles.has(t)) || !K.notTrash(s) };
  }
  // What you're into: time read (hours, up to 10), chapters finished, your star rating (4–5 up, 1–2 down), favourites a little.
  function seeds() {
    const st = K.statsAll?.() || K.data.stats || {}, w = new Map();
    const add = (k, v, meta) => { const e = w.get(k) || { k, v: 0 }; e.v += v; if (meta?.title && !e.title) e.title = meta.title; w.set(k, e); };
    for (const [k, m] of Object.entries(st.series || {})) if (m) add(k, Math.min(10, (m.ms || 0) / H) + Math.min(100, m.ch || 0) / 20, m);
    for (const [k, n] of Object.entries(K.data.notes || {})) if (n?.rating) add(k, (n.rating - 2.5) * 3, n);
    for (const [k, it] of Object.entries(K.data.library || {})) add(k, 0.5, it);
    return [...w.values()].map(e => ({ ...e, ...splitKey(e.k) }))
      .filter(e => e.v >= 0.5 && usable(P(e.provider)) && e.slug && K.notTrash(e))
      .sort((a, b) => b.v - a.v).slice(0, 6);
  }
  // how well a candidate's genres fit a weighted genre profile (Map tagKey -> weight)
  const fit = (profile, candTags) => {
    let s = 0, shared = [];
    for (const t of candTags) { const w = profile.get(tagKey(t)); if (w) { s += w; shared.push(t); } }
    return { s: candTags.length ? s / Math.sqrt(candTags.length) : 0, shared };
  };
  function rank(profile, cands, known, minShared, extra = () => 0) {
    const seen = new Set(), out = [];
    for (const c of cands) {
      if (!c?.slug || known.has(c)) continue;
      const k = K.key(c.provider, c.slug), t = tags()[k]?.t;
      if (!t?.length) continue;
      const title = norm(c.title);
      if (seen.has(k) || (title && seen.has(title))) continue;
      const f = fit(profile, t);
      if (f.shared.length < minShared) continue;
      seen.add(k); if (title) seen.add(title);
      out.push({ ...c, _s: f.s + extra(c), _why: f.shared.slice(0, 3) });
    }
    return out.sort((a, b) => b._s - a._s);
  }
  const RECS_KEY = 'koru-disc-recs', RECS_TTL = 12 * H;
  let recsRun = null;
  async function computeRecs(sd) {
    // 1. the genres of what you read and rate (6 series at most, asked once every 14 days)
    const profile = new Map(), names = new Map();
    await pool(sd, 3, async e => {
      const t = await tagsOf(e.provider, e.slug);
      for (const name of t) { const k = tagKey(name); profile.set(k, (profile.get(k) || 0) + e.v / Math.sqrt(t.length)); if (!names.has(k)) names.set(k, name); }
    });
    if (!profile.size) return { at: Date.now(), items: [], because: [], tags: [] };
    const top = [...profile.entries()].sort((a, b) => b[1] - a[1]);
    const topNames = top.slice(0, 4).map(([k]) => names.get(k));
    // 2. candidates: what's popular everywhere (the Trending list, shared with Explore) and MangaDex by genre
    const known = knownSets();
    const trend = await D.trendingData(false).catch(() => ({ items: [] }));
    const md = await mdByTags(topNames).catch(() => []);
    const pop = new Map(trend.items.map((g, i) => [K.key(g.provider, g.slug), 1 - i / Math.max(1, trend.items.length)]));
    // 3. genres for the top popular ones we don't know yet (30 at most, kept 14 days, so later runs ask little)
    const need = trend.items.filter(g => !known.has(g) && !tags()[K.key(g.provider, g.slug)]).slice(0, 30);
    await pool(need, 3, g => tagsOf(g.provider, g.slug));
    const items = rank(profile, [...trend.items, ...md], known, Math.min(2, profile.size), c => (pop.get(K.key(c.provider, c.slug)) || 0) * 0.15)
      .slice(0, 18).map(({ provider, slug, title, cover, status, latest, _why }) => ({ provider, slug, title, cover, status, latest, why: _why }));
    return { at: Date.now(), items, because: sd.slice(0, 3).map(e => e.title || tags()[e.k]?.title).filter(Boolean), tags: topNames.slice(0, 3) };
  }
  D.recs = function (force) {
    const sd = seeds();
    if (!sd.length) return Promise.resolve(null);
    const sig = sd.slice(0, 3).map(e => e.k).join('|');
    const c = ls.get(RECS_KEY, null);
    const fresh = c && Date.now() - c.at < RECS_TTL && (c.sig === sig || Date.now() - c.at < H);
    if (!force && fresh) return Promise.resolve(c);
    if (recsRun) return recsRun;
    recsRun = computeRecs(sd).then(r => { r.sig = sig; if (r.items.length || !c?.items?.length) ls.set(RECS_KEY, r); return r.items.length ? r : (c || r); });
    const clear = () => { recsRun = null; };
    recsRun.then(clear, clear);
    return recsRun;
  };
  const recCard = (s, i) => K.card(s, i, { sub: s.why?.length ? s.why.join(' · ') : (s.latest || s.status || '') });
  // Explore: a row of picks, above the sources
  D.recsRow = function () {
    if (!seeds().length) return null;
    const sub = el('span.count'), rail = miniRail(6);
    const again = el('button.btn.small', { title: 'Look again', onclick: () => load(true) }, icon('refresh'));
    const box = el('div.dc-recs', el('div.section', el('h2', { text: 'More like this' }), sub, el('div', { style: { flex: 1 } }), again), rail);
    const known = knownSets();
    async function load(force) {
      again.disabled = true;
      const c = ls.get(RECS_KEY, null);
      if (c?.items?.length) paint(c);
      if (!c?.items?.length || force) sub.textContent = 'Finding series like the ones you read…';
      try { paint(await D.recs(force)); }
      catch { if (!c?.items?.length) box.remove(); }
      finally { again.disabled = false; }
    }
    function paint(r) {
      const items = (r?.items || []).filter(s => !known.has(s));   // read or added since: drop it
      if (!items.length) { sub.textContent = 'Read or rate a few more series and picks show up here.'; rail.replaceChildren(); return; }
      sub.textContent = r.because?.length ? 'Because you read ' + r.because.slice(0, 2).join(' and ') : r.tags?.length ? 'For fans of ' + r.tags.join(', ') : '';
      rail.replaceChildren(...items.map(recCard));
    }
    load(false);
    return box;
  };
  // A series page: other series with the same genres (cached genres, popular lists, MangaDex by genre).
  D.similarRow = function (s) {
    const own = cleanTags(s?.tags);
    if (!own.length) return null;
    const rail = miniRail(6), box = el('div.dc-similar', el('div.section', el('h2', { text: 'More like this' }), el('span.count', { text: own.slice(0, 3).join(' · ') })), rail);
    const me = keysOf(s);
    const profile = new Map(own.map(t => [tagKey(t), 1]));
    K.cached(`sim:${s.provider}:${s.slug}`, 30 * 60e3, async () => {
      keepTags(s, s.tags);
      const md = await mdByTags(own).catch(() => []);
      const trend = ls.get(TREND_KEY, null)?.items || [];
      const fromDb = Object.entries(tags()).map(([k, v]) => ({ ...splitKey(k), title: v.title, cover: v.cover, status: v.status })).filter(x => x.title && usable(P(x.provider)));
      const base = knownSets();
      const known = { has: x => base.has(x) || [...keysOf(x)].some(t => me.has(t)) };
      return rank(profile, [...md, ...trend, ...fromDb], known, Math.min(2, own.length)).slice(0, 14)
        .map(({ provider, slug, title, cover, status, latest, _why }) => ({ provider, slug, title, cover, status, latest, why: _why }));
    }).then(items => {
      if (!items.length) { box.remove(); return; }
      rail.replaceChildren(...items.map(recCard));
    }, () => box.remove());
    return box;
  };

  // ---------- Release days ----------
  // Every time Koru gets a favourite's chapter list (the new-chapter check every 30 minutes, opening the series),
  // the release days of its latest chapters are kept here. The calendar reads only that, and asks a site itself
  // only for favourites it has never seen (or not in a week), two at a time.
  const REL_KEY = 'koru-disc-rel';
  let relDb = null;
  const rel = () => (relDb ||= ls.get(REL_KEY, {}));
  const saveRel = K.debounce(() => ls.set(REL_KEY, rel()), 800);
  const relWatch = new Set();
  // a chapter's date: ISO text, a timestamp (seconds or ms), or "3 days ago"
  const when = d => {
    if (d == null || d === '') return null;
    if (typeof d === 'number') return d > 0 ? (d < 1e12 ? d * 1000 : d) : null;
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim());   // a bare date is that day here, not midnight in London
    if (ymd) return new Date(+ymd[1], ymd[2] - 1, +ymd[3], 12).getTime();
    const t = Date.parse(d);
    if (t) return t;
    const s = String(d).toLowerCase();
    if (/just now|today|hour|min|sec/.test(s) && !/\d+\s*(day|week|month|year)/.test(s)) return Date.now();
    if (/yesterday/.test(s)) return Date.now() - DAY;
    const m = /(\d+)\s*(day|week|month|year)s?\s*ago/.exec(s);
    return m ? Date.now() - Number(m[1]) * { day: 1, week: 7, month: 30, year: 365 }[m[2]] * DAY : null;
  };
  const dayOf = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  D.noteChapters = function (provider, slug, chs) {
    const key = K.key(provider, slug);
    if (!K.data.library?.[key] || !Array.isArray(chs) || !chs.length) return;
    const now = Date.now(), days = new Set();
    for (const c of chs.slice(0, 400)) { const t = when(c?.date); if (t && t <= now + DAY && t > now - 730 * DAY) days.add(dayOf(t)); }
    rel()[key] = { at: now, d: [...days].sort((a, b) => b - a).slice(0, 16) };
    saveRel();
    relWatch.forEach(f => f(key));
  };
  // Whatever fetches chapters (the new-chapter checker, a series page) also feeds the calendar.
  const getChapters = K.getChapters;
  if (getChapters) K.getChapters = async function (provider, slug, fresh) {
    const chs = await getChapters.apply(this, arguments);
    try { D.noteChapters(provider, slug, chs); } catch {}
    return chs;
  };
  // weekly (on `day`), often (several a week), irregular, break (nothing new in a long while), nodates, unknown
  D.plan = function (r) {
    if (!r) return { kind: 'unknown' };
    const d = r.d || [], now = Date.now();
    if (!d.length) return { kind: 'nodates' };
    const last = d[0];
    if (d.length < 3) return { kind: now - last > 60 * DAY ? 'break' : 'irregular', last };
    const gaps = [];
    for (let i = 1; i < Math.min(d.length, 12); i++) gaps.push((d[i - 1] - d[i]) / DAY);
    const gap = median(gaps);
    if (now - last > Math.max(35, gap * 4) * DAY) return { kind: 'break', last, gap };
    if (gap < 4.5) return { kind: 'often', last, gap };
    const recent = d.filter(t => t > now - 120 * DAY);
    const wds = (recent.length >= 3 ? recent : d.slice(0, 8)).slice(0, 12).map(t => new Date(t).getDay());
    // the median weekday on a circle: the day closest to all release days (ties: the one hit most)
    const dist = (a, b) => Math.min((a - b + 7) % 7, (b - a + 7) % 7);
    let day = 0, cost = Infinity, hits = -1;
    for (let w = 0; w < 7; w++) {
      const c = wds.reduce((a, x) => a + dist(x, w), 0), n = wds.filter(x => x === w).length;
      if (c < cost || (c === cost && n > hits)) { day = w; cost = c; hits = n; }
    }
    // a day either side still counts half (time zones move a midnight release to the day before)
    const share = wds.reduce((a, x) => a + (x === day ? 1 : dist(x, day) === 1 ? 0.5 : 0), 0) / wds.length;
    return { kind: share >= 0.6 && gap <= 16 ? 'weekly' : 'irregular', day, gap, last, share };
  };
  const tried = new Set();
  let relRun = null;
  // the favourites the calendar hasn't seen yet (or not in a week): two at a time, each only once per run of Koru
  function fillMissing(favs) {
    const db = rel();
    const missing = favs.filter(([k]) => !tried.has(k) && (!db[k] || Date.now() - db[k].at > 7 * DAY));
    if (!missing.length) return relRun;
    missing.forEach(([k]) => tried.add(k));
    const run = pool(missing, 2, async ([, it]) => { await withTimeout(K.getChapters(it.provider, it.slug), 30000); await new Promise(r => setTimeout(r, 250)); });
    const me = relRun = (relRun || Promise.resolve()).then(() => run);
    const clear = () => { if (relRun === me) relRun = null; };
    me.then(clear, clear);
    return me;
  }
  // Library → Release days
  D.calendar = function (box, alive) {
    const favs = Object.entries(K.data.library || {}).filter(([, it]) => it && usable(P(it.provider)) && K.notTrash(it) && !K.flag(it.provider, it.slug).hidden);
    if (!favs.length) {
      box.replaceChildren(el('div.empty', K.fox(), el('h3', { text: 'No favourites yet' }), el('p', { text: 'Tap the heart on a series and Koru works out which day its new chapters usually come out.' })));
      return;
    }
    const db = rel();
    for (const k of Object.keys(db)) if (!K.data.library[k]) delete db[k];   // no longer a favourite
    const status = el('small.muted'), body = el('div');
    box.replaceChildren(el('div.row.dc-calhead', el('span.muted', { text: 'Worked out from when each favourite\'s recent chapters came out.' }), el('div', { style: { flex: 1 } }), status), body);
    const today = new Date().getDay();
    const dayName = w => new Date(2024, 0, 7 + w).toLocaleDateString(undefined, { weekday: 'long' });   // 7 Jan 2024 was a Sunday
    const weeksAgo = t => { const n = Math.round((Date.now() - t) / (7 * DAY)); return n <= 1 ? 'last week' : n + ' weeks ago'; };
    const entry = (it, line, hot) => el('a.dc-ent' + (hot ? '.hot' : ''), { href: '#' + where(it), title: it.title || it.slug },
      el('div.th', img(it.cover, it.title || '', '', 60)),
      el('div.n', el('b', { text: it.title || it.slug }), el('small', { text: line })));
    let tPaint = 0;
    function paint() {
      if (!alive() || !box.isConnected) { relWatch.delete(onRel); return; }
      const cols = Array.from({ length: 7 }, () => []), groups = { often: [], irregular: [], break: [], nodates: [], unknown: [] };
      for (const [k, it] of favs) {
        const p = D.plan(rel()[k]);
        if (p.kind === 'weekly') cols[p.day].push({ it, p }); else groups[p.kind].push({ it, p });
      }
      const sortT = a => a.sort((x, y) => String(x.it.title).localeCompare(String(y.it.title)));
      const grid = el('div.dc-cal');
      for (let i = 0; i < 7; i++) {
        const w = (today + i) % 7, list = sortT(cols[w]);
        grid.append(el('div.dc-day.glass' + (i === 0 ? '.today' : ''),
          el('h4', el('span', { text: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayName(w) }), i < 2 ? el('small.muted', { text: dayName(w) }) : null, list.length ? el('small.muted.dc-n', { text: String(list.length) }) : null),
          list.length ? list.map(({ it, p }) => {
            const ld = new Date(p.last).getDay(), near = Math.min((ld - w + 7) % 7, (w - ld + 7) % 7) <= 1;   // a day early or late still counts
            const outNow = Date.now() - p.last < 6.5 * DAY && near;   // already out this week
            const line = it.newCount ? `${it.newCount} new` : outNow ? (i === 0 ? 'Out today' : 'Out ' + K.ago(p.last)) : i === 0 ? 'Due today' : (p.gap > 10 ? 'Every 2 weeks' : 'Weekly');
            return entry(it, line, !!it.newCount || (outNow && i === 0));
          }) : el('small.muted.dc-none', { text: 'Nothing usually' })));
      }
      const other = (title, list, line) => list.length ? el('div.dc-other', el('div.section', el('h2', { text: title }), el('span.count', { text: String(list.length) })),
        el('div.dc-ents', sortT(list).map(({ it, p }) => entry(it, line(p, it), !!it.newCount)))) : null;
      body.replaceChildren(...[grid,
        other('Several times a week', groups.often, (p, it) => it.newCount ? `${it.newCount} new` : `Every ${Math.max(1, Math.round(p.gap))} day${Math.round(p.gap) > 1 ? 's' : ''} or so`),
        other('No set day', groups.irregular, (p, it) => it.newCount ? `${it.newCount} new` : p.last ? 'Last one ' + K.ago(p.last) : 'Not enough chapters yet'),
        other('On a break', groups.break, p => 'Last chapter ' + weeksAgo(p.last)),
        other('No dates on this source', groups.nodates, (p, it) => P(it.provider)?.name || ''),
        other('Not checked yet', groups.unknown, () => 'Waiting for its chapter list')].filter(Boolean));
    }
    const onRel = key => { if (!favs.some(([k]) => k === key)) return; clearTimeout(tPaint); tPaint = setTimeout(paint, 400); };
    relWatch.add(onRel);
    paint();
    const run = fillMissing(favs);
    if (run) {
      const left = () => favs.filter(([k]) => !rel()[k]).length;
      status.textContent = left() ? `Checking ${left()} favourite${left() > 1 ? 's' : ''}…` : '';
      const tick = setInterval(() => { if (!box.isConnected) return clearInterval(tick); const n = left(); status.textContent = n ? `Checking ${n} favourite${n > 1 ? 's' : ''}…` : ''; }, 1000);
      run.finally(() => { clearInterval(tick); if (box.isConnected) { status.textContent = ''; paint(); } });
    }
  };
})();
