// Koru sync between your PCs (Settings → Sync between PCs). Each PC writes its own file into a folder both
// can see and merges the others' files: favourites, likes, bookmarks and hidden/completed marks join up,
// history keeps the newest place, read marks add up, and something removed on one PC goes on the other.
// Settings (look, graphics) stay per PC on purpose: your two PCs may want different ones.
'use strict';
(function () {
  const TYPES = ['library', 'liked', 'bookmarks', 'history', 'read', 'flags'];
  const SNAP = 'koru-sync-snap', GONE = 'koru-sync-removed', LAST = 'koru-sync-last';
  const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const when = (t, it) => (t === 'library' ? it.addedAt || it.at : t === 'liked' || t === 'bookmarks' || t === 'history' ? it.at : 0) || 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  let info = null, busy = null, merging = false, timer = 0, lastRun = 0;

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
        } else if (t === 'history') {
          if ((v.at || 0) > (cur.at || 0)) { mine[k] = clone(v); changed.add(t); }
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
    if (!info?.dir) return { off: true };
    const removed = ls.get(GONE, {});
    noteRemovals(removed);
    const r = await fetch('/k/sync/read');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Sync failed');
    const changed = new Set();
    for (const o of j.files || []) if (o && o.v === 1) mergeFrom(o, removed, changed);
    if (changed.size) {
      merging = true;
      try { for (const t of changed) K.save(t); } finally { merging = false; }
      document.dispatchEvent(new CustomEvent('koru-library'));
    }
    const data = {}; for (const t of TYPES) data[t] = K.data[t] || {};
    const w = await fetch('/k/sync/write', { method: 'PUT', body: JSON.stringify({ v: 1, device: info.device, name: info.name, at: Date.now(), data, removed }) });
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
  const soon = () => { if (!info?.dir) return; clearTimeout(timer); timer = setTimeout(() => now(), 20000); };
  async function refreshInfo() { try { info = await K.api.get('/k/sync/info'); } catch { info = null; } return info; }

  // anything you change in a synced list is sent along about 20 seconds later
  const save0 = K.save;
  K.save = function (key) { const r = save0.apply(this, arguments); if (!merging && TYPES.includes(key)) soon(); return r; };

  K.sync = {
    info: refreshInfo, now, last: () => ls.get(LAST, 0),
    pick: async () => { const r = await K.api.post('/k/sync/pick'); await refreshInfo(); if (r.dir) { ls.set(SNAP, null); await now(true); } return r; },
    off: async () => { await K.api.post('/k/sync/off'); await refreshInfo(); },
    start: async () => {
      if (K.info?.platform !== 'desktop') return;
      await refreshInfo();
      if (!info?.dir) return;
      setTimeout(() => now(), 6000);
      setInterval(() => now(), 3 * 60e3);
      window.addEventListener('focus', () => { if (Date.now() - lastRun > 60e3) now(); });
    }
  };
})();
