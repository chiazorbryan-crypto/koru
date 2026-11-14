// Koru library extras:
//  - your rating (1–5 stars), a private note and shelves for every series (K.data.notes, K.data.shelves)
//  - Search: every source at once, the same series from different sources merged into one card
//  - Find on another source: when a site is down or slow, find the series elsewhere and move your progress there (K.moveSeries)
//  - .cbz export of downloaded chapters and series (served by the background side at /k/dl/cbz)
// views.js calls in through K.libx.* hooks, so everything here is optional for it.
'use strict';
(function () {
  const { el, icon, img } = K;
  const P = id => K.providers[id];
  const X = K.libx = {};
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const fin = n => typeof n === 'number' && Number.isFinite(n);

  // ---------- titles: one key per series, whatever each site calls it ----------
  const NOISE = /[([](?:official|webtoon|manhwa|manga|manhua|comic|novel|uncensored|remastered|colou?red|hd|english|eng)[)\]]/gi;
  X.norm = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(NOISE, ' ').replace(/[’'`´]/g, '').replace(/&/g, ' and ')
    .replace(/\b(?:season|part|s)\s*\d+\b/g, ' ').replace(/\b(?:official|the|a|an)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const altList = a => (Array.isArray(a) ? a : String(a || '').split(/\s*[;\n|]\s*|\s*,\s+|\s+·\s+|\s+\/\s+/)).map(x => String(x || '').trim()).filter(Boolean);
  // the keys a series answers to: its title, plus any alternative titles the site gave (long enough to be telling)
  X.keysOf = s => {
    const keys = new Set(), t = X.norm(s?.title);
    if (t) keys.add(t);
    for (const a of altList(s?.alt || s?.altTitles)) { const k = X.norm(a); if (k.length >= 4) keys.add(k); }
    return keys;
  };
  // 2: the same title; 1: close (one title holds the other, e.g. a subtitle added); 0: something else
  X.likeness = (a, b) => {
    let best = 0;
    for (const x of a) for (const y of b) {
      if (x === y) return 2;
      const [s, l] = x.length < y.length ? [x, y] : [y, x];
      if (s.length >= 6 && l.includes(s) && s.length / l.length >= 0.6) best = 1;
    }
    return best;
  };
  const chNum = s => { const m = String(s ?? '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  // a chapter's number from its slug, only when the slug clearly is one ("12", "12.5", "chapter-12"); never from ids
  const slugNum = s => { s = String(s ?? ''); if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s); const m = s.match(/(?:^|[-_/])(?:chapter|ch|episode|ep)[-_ ]?(\d+(?:\.\d+)?)(?:$|[-_/])/i); return m ? Number(m[1]) : null; };

  // What Koru already knows about a series (title, cover) from your saved things, for when its site doesn't answer.
  X.known = (provider, slug) => {
    const k = K.key(provider, slug), d = K.data, st = d.stats || {};
    const dl = (K.dl?.series || []).find(x => x.provider === provider && x.seriesSlug === slug);
    const from = [d.library?.[k], d.history?.[k], d.liked?.[k], d.notes?.[k], st.series?.[k], st.sb?.[k], d.flags?.[k], dl && { title: dl.title, cover: dl.cover }]
      .filter(x => x && typeof x === 'object');
    const title = from.map(x => x.title).find(t => t && t !== slug)
      || String(slug).replace(/^[0-9a-f-]{20,}$/i, '').replace(/[-_]+[0-9a-f]{6,}$/i, '').replace(/[-_]+/g, ' ').trim() || slug;
    return { provider, slug, title, cover: from.map(x => x.cover).find(Boolean) || null };
  };

  // ---------- a small pop-over (same look as the options menu), with a close() ----------
  function pop(ev, build, title) {
    document.querySelector('.menu')?.remove();
    const menu = el('div.menu.glass.lx-pop', title ? el('div.menu-h', el('b', { text: title })) : null);
    const close = () => { menu.classList.add('out'); setTimeout(() => menu.remove(), 160); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc); };
    const outside = e => { if (!menu.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    build(menu, close);
    document.body.append(menu);
    const r = menu.getBoundingClientRect(), at = ev.currentTarget?.getBoundingClientRect?.();
    const x = ev.clientX || at?.left || 100, y = ev.clientY || at?.bottom || 100;
    menu.style.left = Math.max(10, Math.min(x, innerWidth - r.width - 10)) + 'px';
    menu.style.top = Math.max(10, Math.min(y, innerHeight - r.height - 10)) + 'px';
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc); }, 0);
    return close;
  }
  const starSvg = () => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic lx-st'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>';
    return s;
  };

  // ---------- ratings, notes and shelves ----------
  const notes = () => (K.data.notes ||= {});
  const shelves = () => (K.data.shelves ||= {});
  X.noteOf = (provider, slug) => notes()[K.key(provider, slug)] || null;
  // your shelves in their order, plus any a note names that the shelf list doesn't have yet (e.g. mid-sync)
  X.shelfNames = () => {
    const list = Object.entries(shelves()).sort((a, b) => (a[1]?.order ?? 0) - (b[1]?.order ?? 0) || (a[1]?.at || 0) - (b[1]?.at || 0)).map(([n]) => n);
    for (const n of Object.values(notes())) for (const s of n?.shelves || []) if (!list.includes(s)) list.push(s);
    return list;
  };
  function setNote(s, patch) {
    const key = K.key(s.provider, s.slug), all = notes(), old = all[key] || {};
    const n = { ...old, ...patch, provider: s.provider, slug: s.slug, title: s.title || old.title, cover: s.cover || old.cover || null, at: Date.now() };
    if (!n.rating) delete n.rating;
    if (!n.note) delete n.note;
    if (!n.shelves?.length) delete n.shelves;
    if (!n.rating && !n.note && !n.shelves) delete all[key]; else all[key] = n;
    K.save('notes');
  }
  X.setRating = (s, v) => setNote(s, { rating: Math.max(0, Math.min(5, Math.round(v) || 0)) });
  const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  X.addShelf = name => {
    name = cleanName(name);
    if (!name) return null;
    const have = X.shelfNames().find(n => sameName(n, name));
    if (have) { if (!own(shelves(), have)) { shelves()[have] = { at: Date.now(), order: Object.keys(shelves()).length }; K.save('shelves'); } return have; }
    const order = Math.max(-1, ...Object.values(shelves()).map(x => x?.order ?? 0)) + 1;
    shelves()[name] = { at: Date.now(), order };
    K.save('shelves');
    return name;
  };
  X.renameShelf = (from, to) => {
    to = cleanName(to);
    if (!to || to === from) return false;
    if (X.shelfNames().some(n => n !== from && sameName(n, to))) { K.toast('You already have a shelf called ' + to, 'error'); return false; }
    const sh = shelves();
    sh[to] = { ...(sh[from] || { order: Object.keys(sh).length }), at: sh[from]?.at || Date.now() };
    delete sh[from];
    for (const n of Object.values(notes())) if (n?.shelves?.includes(from)) n.shelves = [...new Set(n.shelves.map(x => (x === from ? to : x)))];
    if (sessionStorage.getItem('koru-libfilter') === 'shelf:' + from) sessionStorage.setItem('koru-libfilter', 'shelf:' + to);
    K.save('shelves'); K.save('notes');
    return true;
  };
  X.deleteShelf = name => {
    delete shelves()[name];
    const all = notes();
    for (const [k, n] of Object.entries(all)) {
      if (!n?.shelves?.includes(name)) continue;
      n.shelves = n.shelves.filter(x => x !== name);
      if (!n.shelves.length) delete n.shelves;
      if (!n.rating && !n.note && !n.shelves) delete all[k];
    }
    if (sessionStorage.getItem('koru-libfilter') === 'shelf:' + name) sessionStorage.setItem('koru-libfilter', 'all');
    K.save('shelves'); K.save('notes');
  };
  X.toggleShelf = (s, name, on) => {
    const n = X.noteOf(s.provider, s.slug), list = new Set(n?.shelves || []);
    on ? list.add(name) : list.delete(name);
    setNote(s, { shelves: [...list] });
  };

  function stars(value, onPick) {
    const box = el('div.lx-stars', { role: 'group', 'aria-label': 'Your rating' });
    const paint = v => { for (let i = 0; i < box.children.length; i++) box.children[i].classList.toggle('on', i < v); };
    for (let i = 1; i <= 5; i++) {
      box.append(el('button.lx-star', { type: 'button', title: i === value ? 'Clear your rating' : `${i} star${i > 1 ? 's' : ''}`, 'aria-label': `${i} star${i > 1 ? 's' : ''}`,
        onclick: () => { value = value === i ? 0 : i; paint(value); [...box.children].forEach((b, j) => { b.title = j + 1 === value ? 'Clear your rating' : `${j + 1} star${j ? 's' : ''}`; }); onPick(value); },
        onpointerenter: () => paint(i) }, starSvg()));
    }
    box.addEventListener('pointerleave', () => paint(value));
    paint(value);
    return box;
  }

  // "Add to shelf": tick the shelves this series is on, or make a new one.
  function shelfPicker(ev, s, after) {
    pop(ev, (menu, close) => {
      const list = el('div.lx-plist');
      const draw = () => {
        const on = new Set(X.noteOf(s.provider, s.slug)?.shelves || []);
        const names = X.shelfNames();
        list.replaceChildren(...names.map(n => el('button.mi.lx-tick' + (on.has(n) ? '.on' : ''), { onclick: e => { e.stopPropagation(); X.toggleShelf(s, n, !on.has(n)); draw(); after(); } },
          el('span.lx-box', on.has(n) ? icon('check') : null), el('span', { text: n }))));
        if (!names.length) list.append(el('p.muted.lx-pnote', { text: 'No shelves yet. Make your first one below, like "Weekend reads" or "Top tier".' }));
      };
      const input = el('input.lx-in', { type: 'text', placeholder: 'New shelf name', maxLength: 40, spellcheck: false });
      const add = () => { const n = X.addShelf(input.value); if (!n) return input.focus(); X.toggleShelf(s, n, true); input.value = ''; draw(); after(); K.toast(`Added to ${n}`, 'ok'); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); e.stopPropagation(); });
      draw();
      menu.append(list, el('hr'), el('div.lx-newrow', input, el('button.btn.small.primary', { onclick: add }, icon('plus'), 'Add')));
      setTimeout(() => (X.shelfNames().length ? null : input.focus()), 50);
    }, 'Shelves');
  }

  // The rating / shelves / note box on a series page.
  X.seriesPanel = function (s) {
    const meta = { provider: s.provider, slug: s.slug, title: s.title, cover: s.cover };
    const n = X.noteOf(s.provider, s.slug) || {};
    const shelfRow = el('div.lx-shelfrow');
    const drawShelves = () => {
      const on = X.noteOf(s.provider, s.slug)?.shelves || [];
      shelfRow.replaceChildren(...on.map(name => el('span.chip.lx-on', el('span', { text: name }),
        el('button.lx-x', { title: 'Take off this shelf', 'aria-label': 'Take off ' + name, onclick: () => { X.toggleShelf(meta, name, false); drawShelves(); } }, icon('x')))),
      el('button.chip.lx-add', { onclick: e => shelfPicker(e, meta, drawShelves) }, icon('plus'), on.length ? 'Shelf' : 'Add to shelf'));
    };
    drawShelves();
    const state = el('small.muted.lx-saved');
    const note = el('textarea.lx-note', { placeholder: 'A note for yourself: where you stopped, what you thought, who recommended it…', value: n.note || '', maxLength: 4000, spellcheck: true, rows: 2 });
    let last = n.note || '';
    const save = () => { const v = note.value.trim() ? note.value : ''; if (v === last) return; last = v; setNote(meta, { note: v }); state.textContent = 'Saved'; };
    const later = K.debounce(save, 700);
    note.addEventListener('input', () => { state.textContent = 'Saving…'; later(); });
    note.addEventListener('blur', save);
    note.addEventListener('keydown', e => e.stopPropagation());   // typing never triggers page shortcuts
    const rateTxt = el('small.muted', { text: n.rating ? `${n.rating} / 5` : 'Not rated' });
    return el('div.lx-panel.glass',
      el('div.lx-prow',
        el('div.lx-cell', el('b', { text: 'Your rating' }), el('div.row', stars(n.rating || 0, v => { X.setRating(meta, v); rateTxt.textContent = v ? `${v} / 5` : 'Not rated'; }), rateTxt)),
        el('div.lx-cell.grow', el('b', { text: 'Shelves' }), shelfRow)),
      el('div.lx-cell', el('div.row', el('b', { text: 'Notes' }), state), note));
  };

  // ---------- Library: Rated + your shelves as filter chips ----------
  const isOurs = f => f === 'rated' || String(f).startsWith('shelf:');
  X.filterOk = f => !String(f).startsWith('shelf:') || X.shelfNames().includes(String(f).slice(6));
  X.filterPass = (x, filter) => {
    if (!isOurs(filter)) return null;
    const f = K.flag(x.provider, x.slug);
    if (f.hidden || f.trash) return false;
    const n = notes()[K.key(x.provider, x.slug)];
    return filter === 'rated' ? !!n?.rating : !!n?.shelves?.includes(String(filter).slice(6));
  };
  // Shelves and ratings aren't only for favourites: those series show up here too.
  X.listFor = (filter, items) => {
    if (!isOurs(filter)) return null;
    const out = items.slice(), seen = new Set(items.map(x => K.key(x.provider, x.slug)));
    for (const [k, n] of Object.entries(notes())) {
      if (seen.has(k) || !n) continue;
      const i = k.indexOf(':'), provider = n.provider || k.slice(0, i), slug = n.slug || k.slice(i + 1);
      if (!P(provider)) continue;
      const h = K.data.history[k] || K.data.liked[k];
      out.push({ provider, slug, title: n.title || h?.title || slug, cover: n.cover || h?.cover || null });
    }
    return out;
  };
  X.sortFor = (filter, list) => {
    if (filter === 'rated') {
      const r = x => notes()[K.key(x.provider, x.slug)]?.rating || 0;
      list.sort((a, b) => r(b) - r(a) || String(a.title).localeCompare(String(b.title)));
    }
    return list;
  };
  X.cardBadge = (s, cv) => {
    const r = notes()[K.key(s.provider, s.slug)]?.rating;
    if (r) cv.append(el('span.lx-rb', { title: `Your rating: ${r} / 5` }, starSvg(), String(r)));
  };
  X.libraryChips = function (chips, filter, setFilter) {
    const names = X.shelfNames();
    const chip = (v, label, extra) => el('button.chip' + (filter === v ? '.on' : '') + (extra || ''), { onclick: () => setFilter(v) }, label);
    const rated = chip('rated', 'Rated');
    rated.prepend(starSvg());
    chips.append(el('i.lx-sep'), rated);
    for (const n of names) {
      const c = chip('shelf:' + n, n, '.lx-shelf');
      c.title = 'Right-click to rename or delete';
      c.addEventListener('contextmenu', e => { e.preventDefault(); manageShelves(e, filter, setFilter); });
      chips.append(c);
    }
    chips.append(el('button.chip.lx-manage', { title: 'Your shelves: make, rename or delete', onclick: e => manageShelves(e, filter, setFilter) }, icon(names.length ? 'list' : 'plus'), names.length ? 'Shelves' : 'New shelf'));
  };
  function manageShelves(ev, filter, setFilter) {
    pop(ev, (menu, close) => {
      const list = el('div.lx-plist');
      const count = n => Object.values(notes()).filter(x => x?.shelves?.includes(n)).length;
      const changed = () => { document.dispatchEvent(new CustomEvent('koru-library')); };
      const draw = (editing) => {
        list.replaceChildren(...X.shelfNames().map(n => {
          if (editing === n) {
            const inp = el('input.lx-in', { type: 'text', value: n, maxLength: 40, spellcheck: false });
            const ok = () => { if (X.renameShelf(n, inp.value)) { close(); changed(); } };
            inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') draw(); });
            setTimeout(() => { inp.focus(); inp.select(); }, 30);
            return el('div.lx-newrow', inp, el('button.btn.small.primary', { onclick: ok }, 'Save'));
          }
          return el('div.lx-srow',
            el('button.mi', { onclick: () => { close(); setFilter('shelf:' + n); } }, icon('book'), el('span', { text: n }), el('small.muted', { text: String(count(n)) })),
            el('button.btn.small', { title: 'Rename', onclick: e => { e.stopPropagation(); draw(n); } }, 'Rename'),
            el('button.btn.small.icon.lx-del', { title: 'Delete shelf', 'aria-label': 'Delete ' + n, onclick: e => {
              e.stopPropagation();
              const c = count(n);
              if (!confirm(`Delete the shelf "${n}"?${c ? ` The ${c} series on it stay in your library; only the shelf goes.` : ''}`)) return;
              X.deleteShelf(n); close(); changed();
            } }, icon('trash')));
        }));
        if (!X.shelfNames().length) list.append(el('p.muted.lx-pnote', { text: 'Shelves group series your way. Make one here, or from a series page with "Add to shelf".' }));
      };
      const input = el('input.lx-in', { type: 'text', placeholder: 'New shelf name', maxLength: 40, spellcheck: false });
      const add = () => { const n = X.addShelf(input.value); if (!n) return input.focus(); close(); changed(); K.toast(`Shelf "${n}" made. Add series to it from their page.`, 'ok'); };
      input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') add(); });
      draw();
      menu.append(list, el('hr'), el('div.lx-newrow', input, el('button.btn.small.primary', { onclick: add }, icon('plus'), 'Add')));
    }, 'Your shelves');
  }

  // ---------- Search: every source at once, one card per series ----------
  // Results appear as each source answers. Cards for the same series (same title, or a matching alternative title)
  // become one card with a chip per source. The card opens the source you've read it on, else the first one in your list.
  const where = s => `/series/${s.provider}/${encodeURIComponent(s.slug)}`;
  const rank = id => { const i = K.providerList.findIndex(p => p.id === id); return i < 0 ? 999 : i; };
  const usedAt = s => { const k = K.key(s.provider, s.slug), d = K.data; return Math.max(d.history[k]?.at || 0, d.library[k] ? 1 : 0, d.read[k] ? 1 : 0, d.liked[k] ? 1 : 0); };
  X.best = items => [...items].sort((a, b) => usedAt(b) - usedAt(a) || rank(a.provider) - rank(b.provider))[0];
  X.search = function (out, q, alive) {
    const qn = X.norm(q);
    const count = el('span.count'), status = el('div.lx-sstat'), grid = el('div.grid.lx-sgrid', Array.from({ length: 6 }, () => el('div.skel.cover')));
    out.replaceChildren(el('div.section', el('h2', { text: 'Results' }), count), status, grid);
    const groups = [], byKey = new Map();
    let left = K.providerList.length, answered = 0, skel = true;
    const paintCount = () => { count.textContent = `${groups.length} series` + (left ? ` · ${answered} of ${K.providerList.length} sources so far` : ''); };
    const score = g => { let s = 0; for (const k of g.keys) s = Math.max(s, k === qn ? 3 : qn && k.startsWith(qn) ? 2 : qn && k.includes(qn) ? 1 : 0); return s; };
    function paint(g) {
      const best = X.best(g.items);
      if (!g.node) {
        g.node = K.card(best, Math.min(groups.length, 12));
        g.node.querySelector('.src')?.remove();
        g.chips = el('div.lx-chips');
        g.node.querySelector('.cv').append(g.chips);
      }
      g.node.href = '#' + where(best);
      // the card's own source first, then the others (one chip per source); the rest behind "+N"
      const list = [best, ...[...g.items].filter(s => s !== best).sort((a, b) => rank(a.provider) - rank(b.provider))];
      const distinct = list.filter((s, i) => list.findIndex(o => o.provider === s.provider) === i);
      const shown = list.length === 2 && distinct.length === 2 ? distinct : [best];   // a third chip wouldn't fit a cover: the rest go behind "+N"
      const label = s => `${P(s.provider)?.name || s.provider}: ${s.title}${s.latest ? ' · ' + s.latest : ''}`;
      g.chips.replaceChildren(...shown.map(s => el('button.lx-c' + (s === best ? '.best' : ''), { title: label(s), style: { color: P(s.provider)?.hue },
        onclick: e => { e.preventDefault(); e.stopPropagation(); K.go(where(s)); } }, P(s.provider)?.short || s.provider)));
      if (list.length > shown.length) g.chips.append(el('button.lx-c.more', { title: 'All sources for this series', onclick: e => { e.preventDefault(); e.stopPropagation();
        K.popMenu(e, best.title, list.map(s => ['explore', (P(s.provider)?.name || s.provider) + (s.latest ? ' · ' + s.latest : ''), () => K.go(where(s))])); } }, '+' + (list.length - shown.length)));
      const sub = g.node.querySelector('.cap .s');
      if (sub) sub.textContent = g.items.length > 1 ? `${new Set(g.items.map(s => s.provider)).size} sources` : (best.latest || best.status || '');
    }
    function place(g) {
      // the grid stays ordered best match first; a new card goes in before the first weaker one
      g.score = score(g); g.node._g = g;
      let after = null;
      for (const n of grid.children) if (n._g && n._g !== g && n._g.score < g.score) { after = n; break; }
      if (after) grid.insertBefore(g.node, after); else grid.append(g.node);
    }
    function add(items) {
      if (skel) { grid.replaceChildren(); skel = false; }
      for (const s of items) {
        if (!s?.slug || !K.notTrash(s)) continue;
        const keys = X.keysOf(s);
        const hits = [...new Set([...keys].map(k => byKey.get(k)).filter(Boolean))];
        let g = hits[0];
        if (g?.items.some(x => x.provider === s.provider && x.slug === s.slug)) continue;
        if (!g) { g = { keys: new Set(), items: [] }; groups.push(g); }
        for (const o of hits.slice(1)) {   // this result ties two groups together: fold the second into the first
          o.items.forEach(x => g.items.push(x)); o.keys.forEach(k => g.keys.add(k)); o.node?.remove(); groups.splice(groups.indexOf(o), 1);
        }
        g.items.push(s);
        for (const k of keys) { g.keys.add(k); byKey.set(k, g); }
        for (const k of g.keys) byKey.set(k, g);
        const fresh = !g.node;
        paint(g);
        if (fresh) place(g);
      }
      paintCount();
    }
    const finish = () => {
      left--; paintCount();
      if (left) return;
      if (skel || !groups.length) grid.replaceChildren(el('div.empty', { style: { gridColumn: '1/-1' } }, K.fox(), el('h3', { text: 'No matches' }), el('p', { text: 'Try fewer words, or another spelling of the title.' })));
    };
    for (const p of K.providerList) {
      const n = el('small', { text: '…' });
      const chip = el('span.lx-schip.wait', { title: p.name }, el('i.dot', { style: { background: p.hue } }), el('span', { text: p.short || p.name }), n);
      status.append(chip);
      Promise.resolve().then(() => p.list({ q, page: 1 })).then(res => {
        if (!alive()) return;
        answered++;
        const items = (res?.items || []).map(s => ({ ...s, provider: s.provider || p.id }));
        chip.classList.remove('wait'); n.textContent = items.length + (res?.hasMore ? '+' : '');
        if (!items.length) chip.classList.add('none');
        add(items);
      }).catch(e => {
        if (!alive()) return;
        answered++;
        chip.classList.remove('wait'); chip.classList.add('bad'); chip.title = `${p.name}: ${e?.message || 'didn\'t answer'}`; n.textContent = '!';
      }).finally(() => { if (alive()) finish(); });
    }
    paintCount();
  };

  // ---------- Find on another source ----------
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  // A finder: search box + matches from every other source, each with "Move my progress here".
  X.finder = function (box, from, opts = {}) {
    const input = el('input', { type: 'search', value: from.title || '', placeholder: 'Title to look for', spellcheck: false, autocomplete: 'off' });
    input.addEventListener('keydown', e => e.stopPropagation());
    const status = el('div.lx-sstat'), hits = el('div.list.lx-hits'), more = el('div.lx-more');
    box.replaceChildren(el('label.searchbox.glass.small.lx-fsearch', icon('search'), input), status, hits, more);
    const fromKeys = X.keysOf(from);
    let gen = 0;
    const counts = []; let countBusy = 0;
    const pumpCounts = () => {
      while (countBusy < 3 && counts.length) {
        const job = counts.shift(); if (!job.row.isConnected) continue;
        countBusy++;
        withTimeout(K.getChapters(job.s.provider, job.s.slug), 40000).then(chs => {
          const free = chs.filter(c => !c.locked).length, top = Math.max(-Infinity, ...chs.map(c => c.number).filter(fin));
          job.sub.textContent = `${chs.length} chapter${chs.length === 1 ? '' : 's'}${free < chs.length ? ` · ${chs.length - free} locked` : ''}${fin(top) ? ' · up to ' + top : ''}`;
          job.row._chs = chs;
        }, () => { job.sub.textContent = 'Couldn\'t load its chapters right now'; }).finally(() => { countBusy--; pumpCounts(); });
      }
    };
    function row(s, how) {
      const sub = el('small', { text: 'Counting chapters…' });
      const p = P(s.provider);
      const r = el('div.item.lx-hit',
        el('div.lx-th', img(s.cover, s.title, '', 56)),
        el('div.n', el('b', { text: s.title }), el('div.lx-meta', el('span.lx-c', { text: p?.short || s.provider, style: { color: p?.hue } }), how === 2 ? null : el('span.lx-maybe', { text: 'similar title' }), sub)),
        el('a.btn.small', { href: '#' + where(s), title: 'Open this series on ' + (p?.name || s.provider), onclick: e => { e.stopPropagation(); opts.onClose?.(); } }, 'Open'),
        el('button.btn.small.primary', { title: 'Move favourites, history, read chapters, bookmarks, notes and stats to this source', onclick: async e => {
          e.stopPropagation();
          const b = e.currentTarget;
          const fromName = P(from.provider)?.name || from.provider, toName = p?.name || s.provider;
          if (!confirm(`Move everything you saved for "${from.title}" from ${fromName} to ${toName}?\n\nFavourite, history, read chapters, likes, bookmarks, notes, shelves and stats move over. Chapters are matched by number; any that can't be matched stay on ${fromName}, so nothing is lost.`)) return;
          b.disabled = true; b.textContent = 'Moving…';
          try {
            const chs = r._chs || await K.getChapters(s.provider, s.slug);
            const res = await K.moveSeries({ ...from, chapters: opts.chapters }, { provider: s.provider, slug: s.slug, title: s.title, cover: s.cover }, chs);
            K.toast(`Moved to ${toName}` + (res.keptRead ? ` · ${res.keptRead} read mark${res.keptRead > 1 ? 's' : ''} couldn't be matched and stay on ${fromName}` : ''), 'ok');
            opts.onClose?.();
            K.go(where(s));
          } catch (err) { K.toast('Couldn\'t move: ' + (err?.message || 'the new source didn\'t answer'), 'error'); b.disabled = false; b.textContent = 'Move my progress here'; }
        } }, 'Move my progress here'));
      r.onclick = () => { opts.onClose?.(); K.go(where(s)); };
      counts.push({ s, row: r, sub }); setTimeout(pumpCounts, 0);   // once the row is on the page
      return r;
    }
    function run() {
      const my = ++gen, q = input.value.trim();
      counts.length = 0; hits.replaceChildren(); more.replaceChildren(); status.replaceChildren();
      if (!q) return;
      const keys = new Set([...fromKeys, X.norm(q)].filter(Boolean));
      const others = [], seen = new Set();
      const sources = K.providerList.filter(p => p.id !== from.provider);
      let left = sources.length, found = 0;
      const waiting = el('p.muted.lx-pnote', { text: 'Looking on ' + sources.length + ' sources…' });
      hits.append(waiting);
      for (const p of sources) {
        const n = el('small', { text: '…' });
        const chip = el('span.lx-schip.wait', { title: p.name }, el('i.dot', { style: { background: p.hue } }), el('span', { text: p.short || p.name }), n);
        status.append(chip);
        withTimeout(Promise.resolve().then(() => p.list({ q, page: 1 })), 45000).then(res => {
          if (my !== gen) return;
          chip.classList.remove('wait');
          let mine = 0;
          for (const raw of res?.items || []) {
            const s = { ...raw, provider: raw.provider || p.id };
            if (!s.slug || seen.has(K.key(s.provider, s.slug)) || !K.notTrash(s)) continue;
            seen.add(K.key(s.provider, s.slug));
            const how = X.likeness(keys, X.keysOf(s));
            if (how) { waiting.remove(); hits.append(row(s, how)); mine++; found++; }
            else if (others.filter(o => o.provider === s.provider).length < 3) others.push(s);
          }
          n.textContent = String(mine);
          if (!mine) chip.classList.add('none');
        }).catch(e => { if (my !== gen) return; chip.classList.remove('wait'); chip.classList.add('bad'); chip.title = `${p.name}: ${e?.message || 'didn\'t answer'}`; n.textContent = '!'; })
          .finally(() => {
            if (my !== gen || --left) return;
            waiting.remove();
            if (!found) hits.append(el('p.muted.lx-pnote', { text: 'No source has a series with this exact title. Try another spelling above, or pick from the closest results below.' }));
            if (others.length) {
              const list = el('div.list.lx-hits');
              more.replaceChildren(el('button.btn.small', { onclick: () => { more.replaceChildren(el('div.section', el('h2', { text: 'Other results' })), list); others.forEach(s => list.append(row(s, 1))); } },
                icon('list'), `Not it? Show ${others.length} other result${others.length > 1 ? 's' : ''}`));
            }
          });
      }
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    input.addEventListener('input', K.debounce(run, 600));
    run();
    return { run, input };
  };
  // The finder in a sheet over the page.
  X.findOther = function (from, opts = {}) {
    document.querySelector('.lx-sheetwrap')?.remove();
    const body = el('div.lx-sbody');
    const wrap = el('div.lx-sheetwrap', { onclick: e => { if (e.target === wrap) close(); } },
      el('div.lx-sheet', { role: 'dialog', 'aria-label': 'Find on another source' },
        el('div.lx-shead', el('div', el('h2', { text: 'Find on another source' }),
          el('small.muted', { text: `"${from.title}" on ${P(from.provider)?.name || from.provider}. Pick the same series on another site; you can move your progress there.` })),
          el('button.btn.small.icon', { title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
        body));
    const esc = e => { if (e.key === 'Escape') close(); };
    function close() { document.removeEventListener('keydown', esc); window.removeEventListener('hashchange', close); wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200); }
    document.addEventListener('keydown', esc);
    window.addEventListener('hashchange', close);
    document.body.append(wrap);
    X.finder(body, from, { ...opts, onClose: close });
  };
  X.findButton = (s, chapters) => el('button.btn.icon.lx-findb', { title: 'Find on another source', 'aria-label': 'Find on another source',
    onclick: () => X.findOther({ provider: s.provider, slug: s.slug, title: s.title, alt: s.alt, cover: s.cover }, { chapters }) }, icon('search'));
  // A series page that didn't load (site down, series gone): say so, and look for it elsewhere right away.
  X.failBox = function (err, provider, slug) {
    const k = X.known(provider, slug), name = P(provider)?.name || provider;
    const box = el('div.lx-finder');
    const page = el('div.lx-fail',
      el('div.empty', K.fox(), el('h3', { text: `${name} didn't answer` }), el('p', { text: (err?.message || 'The series page didn\'t load.') + ' You can try again, or read it on another source.' }),
        el('div.row', { style: { justifyContent: 'center' } },
          el('button.btn', { onclick: () => { K.forget?.(`s:${provider}:${slug}`); K.forget?.(`c:${provider}:${slug}`); window.dispatchEvent(new HashChangeEvent('hashchange')); } }, icon('refresh'), 'Try again'),
          el('button.btn', { onclick: () => K.back() }, icon('back'), 'Back'))),
      el('div.section', el('h2', { text: `Find "${k.title}" on another source` })),
      box);
    X.finder(box, k);
    return page;
  };

  // ---------- moving a series to another source ----------
  // Moves everything saved under from (provider:slug) to to: favourite, history, read marks, likes, bookmarks, flags,
  // notes/shelves and stats (time, chapters, badge). Read marks, history and bookmarks are matched by chapter number;
  // whatever can't be matched stays under the old source so nothing is lost. Downloads stay where they are.
  async function oldNumbers(from) {
    const map = new Map(), k = K.key(from.provider, from.slug);
    const put = (slug, n) => { if (slug != null && fin(n) && !map.has(String(slug))) map.set(String(slug), n); };
    let chs = Array.isArray(from.chapters) ? from.chapters : null;
    if (!chs) { try { chs = await withTimeout(K.getChapters(from.provider, from.slug), 6000); } catch {} }
    for (const c of chs || []) put(c.slug, fin(c.number) ? c.number : chNum(c.name));
    for (const s of K.dl?.series || []) if (s.provider === from.provider && s.seriesSlug === from.slug) for (const c of s.chapters) put(c.chapterSlug, fin(c.number) ? c.number : chNum(c.chapterName));
    const h = K.data.history[k]; if (h) put(h.chapterSlug, chNum(h.chapterName));
    for (const b of Object.values(K.data.bookmarks || {})) if (b?.provider === from.provider && b.slug === from.slug) put(b.chapterSlug, chNum(b.chapterName));
    return slug => map.has(String(slug)) ? map.get(String(slug)) : slugNum(slug);
  }
  K.moveSeries = async function (from, to, newChapters) {
    if (!from?.provider || !from.slug || !to?.provider || !to.slug) throw new Error('Nothing to move.');
    const fk = K.key(from.provider, from.slug), tk = K.key(to.provider, to.slug);
    if (fk === tk) return { moved: false };
    const chs = Array.isArray(newChapters) ? newChapters : await K.getChapters(to.provider, to.slug);
    let meta = to;
    if (!to.title) { try { meta = { ...to, ...(await K.getSeries(to.provider, to.slug)) }; } catch {} }
    const T = { provider: to.provider, slug: to.slug, title: meta.title || to.slug, cover: meta.cover || null };
    const numOf = await oldNumbers(from);
    // one chapter per number on the new source, a free one if there's a choice (locked ones stay locked either way)
    const byNum = new Map();
    for (const c of chs) { if (!fin(c.number)) continue; const o = byNum.get(c.number); if (!o || (o.locked && !c.locked)) byNum.set(c.number, c); }
    const nearest = n => { let best = null; for (const c of chs) if (fin(c.number) && c.number <= n && !c.locked && (!best || c.number > best.number)) best = c; return best; };
    const d = K.data, touched = new Set(), res = { moved: true, movedRead: 0, keptRead: 0, keptMarks: 0, history: null };
    const touch = k => touched.add(k);
    const short = n => String(n || '').replace(/ — .*/, '');

    // favourite
    if (own(d.library, fk)) {
      const a = d.library[fk], b = d.library[tk];
      const e = { ...a, ...(b || {}), ...T, addedAt: Math.min(a.addedAt || Date.now(), b?.addedAt || Date.now()), newCount: 0, known: chs[0]?.slug, total: chs.length, checkedAt: Date.now() };
      delete e.baseNum; delete e.ackSlug; delete e.lastNew;   // the new source starts a fresh "new chapters" baseline
      d.library[tk] = e; delete d.library[fk]; touch('library');
    }
    if (own(d.liked, fk)) { d.liked[tk] = { ...d.liked[fk], ...(d.liked[tk] || {}), ...T }; delete d.liked[fk]; touch('liked'); }
    if (own(d.flags, fk)) {
      const f = { ...d.flags[fk], ...(d.flags[tk] || {}) };
      if (f.title) f.title = T.title; if (f.cover) f.cover = T.cover || f.cover;
      d.flags[tk] = f; delete d.flags[fk]; touch('flags');
    }
    // read marks: by chapter number; unmatched ones stay on the old source
    if (own(d.read, fk)) {
      const old = d.read[fk] || {}, now = { ...(d.read[tk] || {}) }, keep = {};
      for (const [slug, v] of Object.entries(old)) {
        const c = byNum.get(numOf(slug));
        if (c) { now[c.slug] = v || 1; res.movedRead++; } else { keep[slug] = v; res.keptRead++; }
      }
      if (Object.keys(now).length) d.read[tk] = now;
      if (Object.keys(keep).length) d.read[fk] = keep; else delete d.read[fk];
      touch('read');
    }
    // where you were: the same chapter number, else the closest free one before it
    if (own(d.history, fk)) {
      const h = d.history[fk], n = numOf(h.chapterSlug), exact = fin(n) ? byNum.get(n) : null, c = exact || (fin(n) ? nearest(n) : null);
      if (c) {
        const nh = { ...h, ...T, chapterSlug: c.slug, chapterName: short(c.name), page: exact ? h.page : 0, off: 0, done: exact ? h.done : false };
        if (!d.history[tk] || (d.history[tk].at || 0) < (h.at || 0)) d.history[tk] = nh;
        delete d.history[fk]; touch('history');
        res.history = exact ? 'same' : 'nearest';
      } else res.history = 'kept';
    }
    // bookmarks: by chapter number; unmatched ones stay
    let marksChanged = false;
    for (const id of Object.keys(d.bookmarks || {})) {
      const b = d.bookmarks[id];
      if (!id.startsWith(fk + ':') || !b || b.provider !== from.provider || b.slug !== from.slug) continue;
      const c = byNum.get(numOf(b.chapterSlug));
      if (!c) { res.keptMarks++; continue; }
      const nid = `${tk}:${c.slug}:${b.page}`;
      if (!d.bookmarks[nid]) d.bookmarks[nid] = { ...b, ...T, id: nid, chapterSlug: c.slug, chapterName: short(c.name) };
      delete d.bookmarks[id]; marksChanged = true;
    }
    if (marksChanged) touch('bookmarks');
    // rating, note, shelves
    if (own(d.notes, fk)) {
      const a = d.notes[fk] || {}, b = d.notes[tk] || {};
      const note = [b.note, a.note].filter(Boolean).filter((v, i, l) => l.indexOf(v) === i).join('\n\n');
      const sh = [...new Set([...(b.shelves || []), ...(a.shelves || [])])];
      const n = { ...a, ...b, ...T, at: Date.now() };
      if (b.rating || a.rating) n.rating = b.rating || a.rating;
      if (note) n.note = note; else delete n.note;
      if (sh.length) n.shelves = sh; else delete n.shelves;
      d.notes[tk] = n; delete d.notes[fk]; touch('notes');
    }
    // stats: time and chapters per series and per day, and the series badge
    const st = d.stats;
    if (st && typeof st === 'object') {
      if (st.series?.[fk]) {
        const a = st.series[fk], b = st.series[tk];
        st.series[tk] = b ? { ...a, ...b, ...T, ms: (a.ms || 0) + (b.ms || 0), ch: (a.ch || 0) + (b.ch || 0), last: Math.max(a.last || 0, b.last || 0) } : { ...a, ...T };
        delete st.series[fk]; touch('stats');
      }
      const moveNum = o => { if (!o || !own(o, fk)) return; o[tk] = (o[tk] || 0) + (o[fk] || 0); delete o[fk]; touch('stats'); };
      for (const day of Object.values(st.days || {})) { moveNum(day?.s); moveNum(day?.c); }
      if (st.sb?.[fk]) {
        const a = { ...st.sb[fk], provider: T.provider, slug: T.slug }, b = st.sb[tk];
        st.sb[tk] = b && (b.lvl || 0) >= (a.lvl || 0) ? b : a;
        delete st.sb[fk]; touch('stats');
      }
    }
    touched.forEach(k => K.save(k));
    res.saved = [...touched];
    document.dispatchEvent(new CustomEvent('koru-library'));
    return res;
  };

  // ---------- .cbz export of downloads ----------
  // A plain link with `download`: the background side streams the file and Koru shows the normal Save dialog.
  X.cbzLink = (q, name, label) => el('a.btn' + (label ? '' : '.small.icon') + '.lx-cbz', {
    href: '/k/dl/cbz?' + new URLSearchParams(q), download: String(name || 'Koru').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.cbz',
    title: label ? 'Save as a .cbz comic file (opens in most comic readers)' : 'Export this chapter as .cbz', 'aria-label': 'Export as .cbz',
    onclick: e => { e.stopPropagation(); }
  }, icon('upload'), label || null);
})();
