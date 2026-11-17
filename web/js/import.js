// Koru import (Settings → Library and data → Import from another app): bring your list over from
//  - Mihon / Tachiyomi: a backup file (.tachibk / .proto.gz: gzip + protobuf; read by the tiny decoder below)
//  - MyAnimeList: a public manga list (load.json, 300 at a time)
//  - AniList: a public manga list (GraphQL, sent through Koru's background side because it only answers POST)
//  - MangaDex: a public list (its link or id)
// Each title is looked up on Koru's sources with the same title matching as Search (K.libx.keysOf / likeness / best).
// Good matches go into your favourites and onto a shelf named after the app (Mihon categories become shelves too).
// It runs in the background, two titles at a time, and you can cancel it; Settings shows the progress and results.
'use strict';
(function () {
  const { el, icon } = K;
  const I = K.importer = {};
  const P = id => K.providers[id];
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const str = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

  // ---------- protobuf: just enough to read a Mihon backup ----------
  // Backup { 1: repeated BackupManga, 2: repeated BackupCategory }
  // BackupManga { 3: title, 17: categories (the categories' order numbers), 100: favorite }   BackupCategory { 1: name, 2: order }
  function* fields(u8) {
    let i = 0;
    const varint = () => { let v = 0, m = 1, b; do { if (i >= u8.length) throw new Error('cut short'); b = u8[i++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
    while (i < u8.length) {
      const key = varint(), f = Math.floor(key / 8), wt = key % 8;
      if (wt === 0) yield { f, v: varint() };
      else if (wt === 2) { const n = varint(); if (i + n > u8.length) throw new Error('cut short'); yield { f, v: u8.subarray(i, i + n) }; i += n; }
      else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else throw new Error('not a backup');
    }
  }
  const utf8 = u8 => new TextDecoder().decode(u8);
  I.parseMihon = async function (buf) {
    const nope = 'That file isn\'t a Mihon or Tachiyomi backup.';
    let u8 = new Uint8Array(buf);
    try { if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
    catch { throw new Error(nope); }
    const cats = new Map(), manga = [];
    try { read(); } catch { throw new Error(nope); }
    if (!manga.length && !cats.size) throw new Error(nope);
    return manga.filter(m => m.fav && str(m.title)).map(m => ({ title: str(m.title), alt: [], cats: [...new Set(m.cats.map(o => cats.get(o)).filter(Boolean))] }));
    function read() { for (const { f, v } of fields(u8)) {
      if (!(v instanceof Uint8Array)) continue;
      if (f === 2) { let name = '', order = 0; for (const g of fields(v)) { if (g.f === 1 && g.v instanceof Uint8Array) name = utf8(g.v); if (g.f === 2 && typeof g.v === 'number') order = g.v; } if (name) cats.set(order, name); }
      if (f === 1) {
        const m = { title: '', fav: true, cats: [] };
        for (const g of fields(v)) {
          if (g.f === 3 && g.v instanceof Uint8Array) m.title = utf8(g.v);
          else if (g.f === 100 && typeof g.v === 'number') m.fav = g.v !== 0;
          else if (g.f === 17) { if (typeof g.v === 'number') m.cats.push(g.v); else for (const x of fields(packed(g.v))) m.cats.push(x.v); }
        }
        manga.push(m);
      }
    } }
  };
  // packed repeated numbers: read them as a run of field-1 varints
  function packed(u8) { const out = []; let i = 0; while (i < u8.length) { out.push(8); do { out.push(u8[i]); } while (u8[i++] & 0x80 && i < u8.length); } return new Uint8Array(out); }

  // ---------- the lists ----------
  async function fromMal(user) {
    const out = [];
    for (let off = 0; off < 30000; off += 300) {
      let page;
      try { page = await K.api.site(`https://myanimelist.net/mangalist/${encodeURIComponent(user)}/load.json?status=7&offset=${off}`); }
      catch (e) { if (!off) throw new Error(`Couldn't read ${user}'s MyAnimeList. Check the username, and that the list is public.`); break; }
      if (!Array.isArray(page)) throw new Error(`Couldn't read ${user}'s MyAnimeList. Check the username, and that the list is public.`);
      for (const m of page) { const t = str(m.manga_english) || str(m.manga_title); if (t) out.push({ title: t, alt: [str(m.manga_title), str(m.manga_english)].filter(x => x && x !== t) }); }
      if (page.length < 300) break;
    }
    return out;
  }
  async function fromAniList(user) {
    const query = 'query($u:String){MediaListCollection(userName:$u,type:MANGA){lists{entries{media{id title{english romaji} synonyms}}}}}';
    const r = await fetch('/k/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: 'https://graphql.anilist.co', body: { query, variables: { u: user } } }) });
    const j = await r.json().catch(() => null);
    const err = j?.errors?.[0]?.message;
    if (!r.ok || !j?.data?.MediaListCollection) throw new Error(err === 'Private User' ? `${user}'s AniList is private. Make it public in AniList's settings, then try again.` : `Couldn't read ${user}'s AniList${err ? ' (' + err + ')' : ''}. Check the username.`);
    const out = [], seen = new Set();
    for (const l of j.data.MediaListCollection.lists || []) for (const e of l.entries || []) {
      const m = e.media; if (!m || seen.has(m.id)) continue; seen.add(m.id);
      const t = str(m.title?.english) || str(m.title?.romaji);
      if (t) out.push({ title: t, alt: [str(m.title?.romaji), str(m.title?.english), ...(m.synonyms || []).map(str)].filter(x => x && x !== t).slice(0, 6) });
    }
    return out;
  }
  async function fromMangaDex(text) {
    const id = String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (!id) throw new Error('Paste the link of a MangaDex list (mangadex.org/list/…) or its id.');
    let l;
    try { l = await K.api.site(`https://api.mangadex.org/list/${id}`); } catch { throw new Error('Couldn\'t open that MangaDex list. Check the link, and that the list is public.'); }
    const ids = (l?.data?.relationships || []).filter(x => x.type === 'manga').map(x => x.id);
    const out = [];
    const pick = o => o?.en || o?.['ja-ro'] || o?.['ko-ro'] || o?.['zh-ro'] || Object.values(o || {})[0] || '';
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const j = await K.api.site('https://api.mangadex.org/manga?limit=100&' + part.map(x => 'ids[]=' + x).join('&'));
      for (const m of j?.data || []) {
        // MangaDex's main title is often the romanized one; the English name (what scan sites use) is usually an alt title
        const a = m.attributes || {}, main = str(pick(a.title)), t = str((a.altTitles || []).map(o => o.en).find(Boolean)) || main;
        const alt = [main, ...(a.altTitles || []).map(o => str(o.en || o['ja-ro'] || o['ko-ro'] || ''))].filter((x, i, l) => x && x !== t && l.indexOf(x) === i).slice(0, 6);
        if (t) out.push({ title: t, alt, md: m.id });
      }
    }
    return { name: str(l?.data?.attributes?.name), items: out };
  }

  // ---------- matching against Koru's sources ----------
  // a few site searches at a time across everything; sources are asked in your list's order and the rest are
  // skipped as soon as one has the series under the same title
  let active = 0;
  const waiting = [];
  const limit = fn => new Promise((res, rej) => {
    const run = () => { active++; Promise.resolve().then(fn).then(res, rej).finally(() => { active--; waiting.shift()?.(); }); };
    active < 6 ? run() : waiting.push(run);
  });
  async function match(item, alive) {
    const X = K.libx, keys = X.keysOf({ title: item.title, alt: item.alt });
    for (const it of Object.values(K.data.library)) if (it && X.likeness(keys, X.keysOf(it)) === 2) return { how: 'have', s: it };
    // the title, then one other spelling the sites might use (different once tidied up, and in Latin letters)
    const asked = new Set();
    const queries = [item.title, ...item.alt].map(str).filter(q => { const n = X.norm(q); if (q.length < 2 || !n || asked.has(n) || (asked.size && !/[a-z]/i.test(q))) return false; asked.add(n); return true; }).slice(0, 2);
    let close = null;
    for (const q of queries) {
      const found = [];
      await Promise.all(K.providerList.filter(p => !p.hidden).map(p => limit(async () => {
        if (found.length || !alive()) return;
        try {
          const res = await withTimeout(Promise.resolve().then(() => p.list({ q, page: 1 })), 30000);
          for (const raw of res?.items || []) {
            const s = { ...raw, provider: raw.provider || p.id };
            if (!s.slug || !K.notTrash(s)) continue;
            const how = X.likeness(keys, X.keysOf(s));
            if (how === 2) found.push(s); else if (how === 1 && !close) close = s;
          }
        } catch { /* that source didn't answer: the others still count */ }
      })));
      if (!alive()) return { how: 'stopped' };
      if (found.length) return { how: 'added', s: X.best(found) };
    }
    if (item.md && P('mangadex')) return { how: 'added', s: { provider: 'mangadex', slug: item.md, title: item.title, cover: null } };
    return close ? { how: 'close', s: close } : { how: 'none' };
  }
  I.add = function (s, shelfNames) {
    const key = K.key(s.provider, s.slug), meta = { provider: s.provider, slug: s.slug, title: s.title, cover: s.cover || null };
    if (!K.data.library[key]) { K.data.library[key] = { ...meta, addedAt: Date.now(), newCount: 0, checkedAt: Date.now() }; K.save('library'); }   // the next check sets its new-chapter baseline
    for (const n of shelfNames) { const name = K.libx.addShelf(n); if (name && !K.libx.noteOf(s.provider, s.slug)?.shelves?.includes(name)) K.libx.toggleShelf(meta, name, true); }
  };

  // ---------- the job ----------
  let job = null;
  const views = new Set();
  const paint = () => views.forEach(f => { try { f(); } catch {} });
  I.job = () => job;
  I.start = async function (app, load) {
    if (job?.running) { K.toast('An import is already running. Cancel it first, or wait for it to finish.'); return; }
    if (!K.libx?.keysOf) { K.toast('Import needs the library extras, which didn\'t load.', 'error'); return; }
    job = { app, running: true, reading: true, items: [], done: 0, cancelled: false, error: null };
    paint();
    let list;
    try { list = await load(); }
    catch (e) { job.running = false; job.reading = false; job.error = e?.message || 'Couldn\'t read that list.'; paint(); return; }
    if (job.cancelled) return;
    const shelf = list.name ? `${app}: ${list.name}`.slice(0, 40) : app;
    const items = (list.items || list).filter((x, i, a) => a.findIndex(o => o.title.toLowerCase() === x.title.toLowerCase()) === i);
    Object.assign(job, { reading: false, shelf, items: items.map(x => ({ ...x, how: 'wait' })) });
    paint();
    if (!items.length) { job.running = false; job.error = 'That list is empty.'; paint(); return; }
    const my = job, alive = () => job === my && !my.cancelled;
    let next = 0;
    const worker = async () => {
      while (alive() && next < my.items.length) {
        const it = my.items[next++];
        it.how = 'busy'; paint();
        try {
          const r = await match(it, alive);
          if (!alive()) { it.how = 'wait'; break; }
          it.how = r.how; it.s = r.s;
          if (r.how === 'added' || r.how === 'have') I.add(r.s, [my.shelf, ...(it.cats || [])]);
        } catch { it.how = 'none'; }
        my.done++; paint();
      }
    };
    await Promise.all([worker(), worker()]);
    if (job !== my) return;
    my.running = false; paint();
    document.dispatchEvent(new CustomEvent('koru-library'));
    const n = c => my.items.filter(x => x.how === c).length;
    if (!my.cancelled) K.toast(`${app} import done: ${n('added') + n('have')} in your library${n('none') + n('close') ? `, ${n('none') + n('close')} to find by hand` : ''}`, 'ok');
  };
  I.cancel = () => { if (job?.running) { job.cancelled = true; job.running = false; job.reading = false; paint(); K.toast('Import stopped. What was found so far stays.'); } };

  // "Find them by hand": a small bar that walks you through the ones Koru couldn't find, one search at a time
  I.byHand = function (list) {
    document.querySelector('.imp-hand')?.remove();
    if (!list.length) return;
    let i = 0;
    const title = el('b'), count = el('small.muted'), nextB = el('button.btn.small.primary', { onclick: () => go(i + 1) });
    const bar = el('div.imp-hand.glass',
      el('div.imp-hand-t', count, title),
      el('button.btn.small', { title: 'Previous', onclick: () => go(i - 1) }, icon('back')),
      nextB,
      el('button.btn.small.icon', { title: 'Close', 'aria-label': 'Close', onclick: () => bar.remove() }, icon('x')));
    function go(n) {
      if (n >= list.length) { bar.remove(); return; }
      i = Math.max(0, n);
      title.textContent = list[i].title; count.textContent = `Find by hand · ${i + 1} of ${list.length}`;
      nextB.replaceChildren(...(i === list.length - 1 ? ['Done'] : ['Next', icon('next')]));
      K.go('/search?q=' + encodeURIComponent(list[i].title));
    }
    document.body.append(bar);
    go(0);
  };

  // ---------- Settings panel ----------
  I.panel = function () {
    const droid = K.info?.platform === 'android';
    const status = el('div.imp-status');
    const field = (label, sub, ph, run) => {
      const inp = el('input.txt', { type: 'text', placeholder: ph, spellcheck: false, autocomplete: 'off' });
      const go = () => { const v = inp.value.trim(); if (!v) return inp.focus(); run(v); };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });
      return el('div.imp-src', el('div.lab', label, el('small', { text: sub })), el('div.lookbar', inp, el('button.btn.small.primary', { onclick: go }, 'Import')));
    };
    const fileIn = el('input', { type: 'file', accept: '.tachibk,.gz,.proto,.bin,application/gzip,application/octet-stream', style: { display: 'none' } });
    fileIn.onchange = () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) I.start('Mihon', async () => I.parseMihon(await f.arrayBuffer())); };
    function draw() {
      if (!status.isConnected && status._drawn) { views.delete(draw); return; }
      status._drawn = true;
      const j = job;
      if (!j) { status.replaceChildren(); return; }
      if (j.error) { status.replaceChildren(el('p.imp-err', { text: j.error })); return; }
      const of = c => j.items.filter(x => x.how === c);
      const added = [...of('added'), ...of('have')], close = of('close'), none = of('none');
      const pct = j.items.length ? Math.round(j.done / j.items.length * 100) : 0;
      const head = el('div.imp-head',
        el('div.imp-line', el('b', { text: j.reading ? `Reading your ${j.app} list…` : j.running ? `Matching ${j.done} of ${j.items.length}` : j.cancelled ? `Stopped at ${j.done} of ${j.items.length}` : `${j.app}: ${j.items.length} titles checked` }),
          el('small.muted', { text: j.reading ? '' : `${added.length} in your library · ${close.length} close · ${none.length} not found` }),
          j.running ? el('button.btn.small', { onclick: I.cancel }, icon('x'), 'Cancel') : null),
        j.running ? el('div.bar.imp-bar', el('i', { style: { width: pct + '%' } })) : null);
      const row = (it, extra) => el('div.item.imp-row', el('div.n', el('b', { text: it.title }),
        it.s ? el('small', { text: `${it.how === 'have' ? 'Already in your library' : it.how === 'close' ? 'Similar: ' + it.s.title : it.s.title} · ${P(it.s.provider)?.name || it.s.provider}` }) : el('small', { text: 'No source has this title' })), extra);
      const group = (name, list, build, open) => list.length ? el('details.imp-group', { open }, el('summary', el('b', { text: name }), el('span.count', { text: String(list.length) })),
        el('div.list.imp-list', list.slice(0, 400).map(build))) : null;
      status.replaceChildren(...[head,
        group('Not found', none, it => row(it, el('button.btn.small', { onclick: () => K.go('/search?q=' + encodeURIComponent(it.title)) }, icon('search'), 'Search')), !j.running),
        none.length && !j.running ? el('button.btn.small.primary.imp-handb', { onclick: () => I.byHand(none) }, icon('search'), `Find the ${none.length} not found by hand`) : null,
        group('Close matches', close, it => row(it, el('button.btn.small', { onclick: e => { I.add(it.s, [j.shelf, ...(it.cats || [])]); it.how = 'added'; e.currentTarget.disabled = true; K.toast(`Added ${it.s.title}`, 'ok'); paint(); } }, icon('plus'), 'Add')), !j.running),
        group('In your library', added, it => row(it, it.s ? el('a.btn.small', { href: `#/series/${it.s.provider}/${encodeURIComponent(it.s.slug)}` }, 'Open') : null), false)].filter(Boolean));
    }
    views.add(draw);
    draw();
    return el('section.panel.glass.imp-panel', el('h3', icon('upload'), 'Import from another app'),
      el('p', { text: 'Bring your list over. Koru looks for each series on its sources, adds the ones it finds to your favourites and puts them on a shelf named after the app.' }),
      el('div.imp-src', el('div.lab', 'Mihon or Tachiyomi', el('small', { text: 'A backup file (.tachibk or .proto.gz): in Mihon, More → Backup and restore → Create backup' })),
        el('div.row', el('button.btn.small.primary', { onclick: () => fileIn.click() }, icon('folder'), 'Choose backup file'), fileIn)),
      field('MyAnimeList', 'Your username; the list has to be public', 'MyAnimeList username', v => I.start('MyAnimeList', () => fromMal(v))),
      droid ? null : field('AniList', 'Your username; the list has to be public', 'AniList username', v => I.start('AniList', () => fromAniList(v))),
      field('MangaDex list', 'The link of a public list, or its id', 'mangadex.org/list/…', v => I.start('MangaDex', () => fromMangaDex(v))),
      status);
  };
  (K.settingsExtras ||= []).push(() => K.native() || K.info?.platform === 'web' ? I.panel() : null);
  I._test = { fromMal, fromAniList, fromMangaDex, match };   // for checking from the console
})();
