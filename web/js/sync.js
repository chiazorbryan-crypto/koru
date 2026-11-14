// Koru sync between your PCs (Settings → Sync between PCs). Each PC writes its own file, into a folder both
// can see or into your own private GitHub repo, and merges the others' files: favourites, likes, bookmarks,
// hidden/completed marks, ratings, notes and shelves join up, history keeps the newest place, read marks add
// up, and something removed on one PC goes on the other.
// With GitHub sync, reading stats travel too: each PC sends the stats it counted itself, and Stats, streaks,
// badges and Wrapped show both PCs added together (K.statsAll()).
// Settings (look, graphics) stay per PC on purpose: your two PCs may want different ones.
'use strict';
(function () {
  const TYPES = ['library', 'liked', 'bookmarks', 'history', 'read', 'flags', 'notes', 'shelves'];
  const SNAP = 'koru-sync-snap', GONE = 'koru-sync-removed', LAST = 'koru-sync-last';
  const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const when = (t, it) => (t === 'library' ? it.addedAt || it.at : t === 'liked' || t === 'bookmarks' || t === 'history' || t === 'notes' || t === 'shelves' ? it.at : 0) || 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  let info = null, busy = null, merging = false, timer = 0, lastRun = 0;

  // ---------- stats from your other PCs ----------
  let others = {};   // device -> the stats that PC counted itself
  const othersReady = K.api.load('stats-others').then(v => { if (v && typeof v === 'object') others = v; }).catch(() => {});
  function mergeStats(list) {
    const out = { days: {}, series: {}, badges: {}, marks: {}, sb: {} };
    const addMap = (to, from) => { for (const k in from || {}) to[k] = (to[k] || 0) + (from[k] || 0); };
    for (const st of list) {
      if (!st) continue;
      for (const [d, v] of Object.entries(st.days || {})) {
        const o = out.days[d] ||= { ms: 0, ch: 0, s: {}, c: {}, h: {} };
        o.ms += v.ms || 0; o.ch += v.ch || 0; addMap(o.s, v.s); addMap(o.c, v.c); addMap(o.h, v.h);
      }
      for (const [k, v] of Object.entries(st.series || {})) {
        const o = out.series[k] ||= { ...v, ms: 0, ch: 0 };
        o.ms += v.ms || 0; o.ch += v.ch || 0;
        if ((v.last || 0) > (o.last || 0)) Object.assign(o, { title: v.title || o.title, cover: v.cover || o.cover, last: v.last });
      }
      for (const [k, at] of Object.entries(st.badges || {})) if (!out.badges[k] || at < out.badges[k]) out.badges[k] = at;
      addMap(out.marks, st.marks);
      for (const [k, b] of Object.entries(st.sb || {})) if (b && (!out.sb[k] || (b.lvl || 0) > (out.sb[k].lvl || 0))) out.sb[k] = b;
    }
    return out;
  }
  // everything you read, on this PC and the others (only differs from K.data.stats with GitHub sync)
  K.statsAll = () => { const list = Object.values(others); return list.length ? mergeStats([K.data.stats, ...list]) : K.data.stats; };

  // keys that were here at the last sync and aren't now were removed on this PC
  function noteRemovals(removed) {
    const snap = ls.get(SNAP, null), now = Date.now();
    if (snap) for (const t of TYPES) for (const k of snap[t] || []) if (!K.data[t]?.[k]) (removed[t] ||= {})[k] ||= now;
    const cutoff = now - 120 * 864e5;   // forget removals after four months
    for (const t of TYPES) for (const [k, at] of Object.entries(removed[t] || {})) if (at < cutoff || K.data[t]?.[k]) delete removed[t][k];
  }
  function mergeFrom(o, removed, changed) {
    for (const t of TYPES) {
      const mine = K.data[t] || (K.data[t] = {}), theirs = o.data?.[t] || {}, mineGone = removed[t] || (removed[t] = {});
      for (const [k, v] of Object.entries(theirs)) {
        if (!v || typeof v !== 'object') continue;
        const cur = mine[k];
        if (!cur) {
          const gone = mineGone[k];
          if (gone && gone >= when(t, v)) continue;   // removed here after it was added there
          mine[k] = clone(v); delete mineGone[k]; changed.add(t);
        } else if (t === 'history' || t === 'notes') {
          if ((v.at || 0) > (cur.at || 0)) { mine[k] = clone(v); changed.add(t); }   // the newest wins
        } else if (t === 'read') {
          for (const ch of Object.keys(v)) if (!cur[ch]) { cur[ch] = v[ch]; changed.add(t); }
        }
      }
      for (const [k, at] of Object.entries(o.removed?.[t] || {})) {
        const cur = mine[k];
        if (cur && when(t, cur) <= at) { delete mine[k]; changed.add(t); }
      }
    }
  }

  async function run() {
    if (!info?.mode) return { off: true };
    await othersReady;
    const removed = ls.get(GONE, {});
    noteRemovals(removed);
    const r = await fetch('/k/sync/read');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Sync failed');
    const changed = new Set();
    let statsIn = false;
    for (const o of j.files || []) {
      if (!o || o.v !== 1) continue;
      mergeFrom(o, removed, changed);
      if (info.mode === 'github' && o.device && o.stats && o.device !== info.device) { others[o.device] = o.stats; statsIn = true; }
    }
    if (statsIn) { K.api.save('stats-others', others).catch(() => {}); changed.add('stats'); }
    if (changed.size) {
      merging = true;
      try { for (const t of changed) if (t !== 'stats') K.save(t); } finally { merging = false; }
      document.dispatchEvent(new CustomEvent('koru-library'));
    }
    const data = {}; for (const t of TYPES) data[t] = K.data[t] || {};
    const payload = { v: 1, device: info.device, name: info.name, at: Date.now(), data, removed, ...(info.mode === 'github' ? { stats: K.data.stats } : {}) };
    const w = await fetch('/k/sync/write', { method: 'PUT', body: JSON.stringify(payload) });
    if (!w.ok) throw new Error((await w.json().catch(() => ({}))).error || 'Couldn\'t write the sync file');
    const snap = {}; for (const t of TYPES) snap[t] = Object.keys(K.data[t] || {});
    ls.set(SNAP, snap); ls.set(GONE, removed); ls.set(LAST, Date.now());
    lastRun = Date.now();
    return { changed: [...changed], others: (j.files || []).length };
  }
  // one sync at a time, in an idle moment, never while you're reading
  async function now(manual) {
    if (busy) return busy;
    busy = (async () => {
      if (!manual) {
        while (document.documentElement.classList.contains('reading')) await new Promise(r => setTimeout(r, 5000));
        await new Promise(r => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 4000 }) : setTimeout(r, 200)));
      }
      try { return await run(); }
      catch (e) { if (manual) throw e; return { error: e.message }; }
    })().finally(() => { busy = null; });
    return busy;
  }
  // GitHub: a little less often, it's a website (still far under its limits)
  const soon = () => { if (!info?.mode) return; clearTimeout(timer); timer = setTimeout(() => now(), info.mode === 'github' ? 45000 : 20000); };
  async function refreshInfo(withOthers) { try { info = await K.api.get('/k/sync/info' + (withOthers ? '?others=1' : '')); } catch { info = null; } return info; }

  // anything you change in a synced list is sent along a little later
  const save0 = K.save;
  K.save = function (key) { const r = save0.apply(this, arguments); if (!merging && (TYPES.includes(key) || (key === 'stats' && info?.mode === 'github'))) soon(); return r; };

  let started = false;
  K.sync = {
    info: refreshInfo, now, last: () => ls.get(LAST, 0),
    pick: async () => { const r = await K.api.post('/k/sync/pick'); await refreshInfo(); if (r.dir) { ls.set(SNAP, null); await now(true); K.sync.start(); } return r; },
    github: async (repo, key) => { const r = await K.api.post('/k/sync/github', { repo, key }); await refreshInfo(); ls.set(SNAP, null); await now(true); K.sync.start(); return r; },
    off: async () => { await K.api.post('/k/sync/off'); await refreshInfo(); },
    start: async () => {
      if (K.info?.platform !== 'desktop') return;
      await refreshInfo();
      if (!info?.mode || started) return;
      started = true;
      setTimeout(() => now(), 6000);
      setInterval(() => now(), (info.mode === 'github' ? 5 : 3) * 60e3);
      window.addEventListener('focus', () => { if (Date.now() - lastRun > 60e3) now(); });
    }
  };
})();
