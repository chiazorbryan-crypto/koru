// Koru character tracker: tag a page with who's on it, then find every page a character shows up on.
//  - in the reader: right-click a page → "Tag a character…", or the tag button in the top bar (the page you're on)
//  - on the series page: a "Characters" section, each with the chapters and pages they're tagged on
// Saved per series in K.data.chars (and synced between PCs with the rest of your library):
//   { 'provider:slug': { provider, slug, title, at, list: { Name: [{ c: chapterSlug, n: chapterName, p: page, at }] } } }
// Also the reader's page right-click menu: other files add their items with (K.pageMenuItems ||= []).push(info => [...]).
'use strict';
(function () {
  const { el, icon } = K;
  K.data.chars ||= {};   // loaded and saved like the other K.data lists
  const C = K.chars = {};
  const all = () => (K.data.chars ||= {});
  const clean = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const short = n => String(n || '').replace(/ — .*/, '');
  // a little tag drawing (trusted constant)
  const tagIcon = () => { const s = icon('dot'); s.innerHTML = '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.2 6.2a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>'; return s; };
  C.icon = tagIcon;

  C.of = (provider, slug) => all()[K.key(provider, slug)]?.list || {};
  C.names = (provider, slug) => Object.keys(C.of(provider, slug)).sort((a, b) => a.localeCompare(b));
  const find = (list, name) => Object.keys(list).find(n => same(n, name));
  const onPage = (t, pos) => t.c === pos.chapterSlug && t.p === pos.page;
  C.onPage = pos => C.names(pos.provider, pos.slug).filter(n => C.of(pos.provider, pos.slug)[n].some(t => onPage(t, pos)));
  function entry(provider, slug, title) {
    const e = all()[K.key(provider, slug)] ||= { provider, slug, list: {} };
    if (title) e.title = title;
    e.list ||= {};
    e.at = Date.now();
    return e;
  }
  const done = (provider, slug) => {
    const k = K.key(provider, slug), e = all()[k];
    if (e && !Object.keys(e.list || {}).length) delete all()[k];
    K.save('chars');
    document.dispatchEvent(new CustomEvent('koru-chars', { detail: { key: k } }));
  };
  C.tag = (pos, name) => {
    name = clean(name);
    if (!name || !pos?.provider || !pos.chapterSlug) return null;
    const e = entry(pos.provider, pos.slug, pos.title), have = find(e.list, name) || name, l = e.list[have] ||= [];
    if (!l.some(t => onPage(t, pos))) l.push({ c: pos.chapterSlug, n: short(pos.chapterName), p: pos.page | 0, at: Date.now() });
    done(pos.provider, pos.slug);
    return have;
  };
  C.untag = (pos, name) => {
    const e = all()[K.key(pos.provider, pos.slug)], l = e?.list?.[name];
    if (!l) return;
    e.list[name] = l.filter(t => !onPage(t, pos));
    if (!e.list[name].length) delete e.list[name];
    e.at = Date.now();
    done(pos.provider, pos.slug);
  };
  C.rename = (provider, slug, from, to) => {
    to = clean(to);
    const e = all()[K.key(provider, slug)];
    if (!to || !e?.list?.[from] || to === from) return false;
    const other = Object.keys(e.list).find(n => n !== from && same(n, to)) || to;
    const merged = [...(e.list[other] || []), ...e.list[from]];   // renamed to someone you already have: they join up
    delete e.list[from];
    e.list[other] = merged.filter((t, i) => merged.findIndex(o => o.c === t.c && o.p === t.p) === i);
    e.at = Date.now();
    done(provider, slug);
    return true;
  };
  C.remove = (provider, slug, name) => {
    const e = all()[K.key(provider, slug)];
    if (!e?.list?.[name]) return;
    delete e.list[name]; e.at = Date.now();
    done(provider, slug);
  };

  // ---------- a small pop-over (the same look as the shelf picker) ----------
  function pop(ev, title, build) {
    document.querySelector('.menu')?.remove();
    const menu = el('div.menu.glass.lx-pop.chr-pop', el('div.menu-h', el('b', { text: title })));
    const close = () => { menu.classList.add('out'); setTimeout(() => menu.remove(), 160); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
    const outside = e => { if (!menu.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    build(menu, close);
    document.body.append(menu);
    const r = menu.getBoundingClientRect(), at = ev?.currentTarget?.getBoundingClientRect?.();
    const x = ev?.clientX || at?.left || innerWidth / 2, y = ev?.clientY || at?.bottom || 100;
    menu.style.left = Math.max(10, Math.min(x, innerWidth - r.width - 10)) + 'px';
    menu.style.top = Math.max(10, Math.min(y, innerHeight - r.height - 10)) + 'px';
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
    return close;
  }

  // "Who's on this page?": tick the characters already used in this series, or add a new name.
  C.picker = function (ev, pos) {
    if (!pos?.chapterSlug) return;
    pop(ev, `Who's on page ${(pos.page | 0) + 1}?`, (menu) => {
      const list = el('div.lx-plist'), shown = new Set();   // a name untagged from its last page stays here while the picker is open
      const draw = () => {
        const here = new Set(C.onPage(pos));
        C.names(pos.provider, pos.slug).forEach(n => shown.add(n));
        const names = [...shown].sort((a, b) => a.localeCompare(b));
        list.replaceChildren(...names.map(n => el('button.mi.lx-tick' + (here.has(n) ? '.on' : ''), {
          onclick: e => { e.stopPropagation(); here.has(n) ? C.untag(pos, n) : C.tag(pos, n); draw(); } },
        el('span.lx-box', here.has(n) ? icon('check') : null), el('span', { text: n }))));
        if (!names.length) list.append(el('p.muted.lx-pnote', { text: 'Type a name below. Names you use in this series show up here next time, ready to tick.' }));
      };
      const input = el('input.lx-in', { type: 'text', placeholder: 'Character name', maxLength: 40, spellcheck: false, autocomplete: 'off' });
      const add = () => {
        const n = C.tag(pos, input.value);
        if (!n) return input.focus();
        input.value = ''; draw();
        K.toast(`${n} tagged on page ${(pos.page | 0) + 1}`, 'ok');
      };
      input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') add(); });
      input.addEventListener('keyup', e => e.stopPropagation());
      draw();
      menu.append(list, el('hr'), el('div.lx-newrow', input, el('button.btn.small.primary', { onclick: add }, icon('plus'), 'Tag')));
      setTimeout(() => input.focus(), 50);
    });
  };

  // where you are in the reader, as a spot to tag
  const posOf = p => p && { provider: p.provider, slug: p.slug, title: p.title, chapterSlug: p.chapterSlug, chapterName: p.chapterName, page: p.page | 0 };
  // the top bar button: tags the page you're on
  C.readerButton = () => el('button.btn.icon.chrb', { title: 'Tag a character on this page', 'aria-label': 'Tag a character',
    onclick: e => { const p = posOf(K.readerPos?.()); if (p) C.picker(e, p); else K.toast('Wait for the pages to load first.'); } }, tagIcon());

  // ---------- the reader's page right-click menu ----------
  // info (K.readerPage): { provider, slug, title, chapterSlug, chapterName, page, total, url, file(), focusY }
  const items = K.pageMenuItems ||= [];
  items.unshift((info, ev) => {
    const here = C.onPage(info);
    return [['users', here.length ? `Characters: ${here.slice(0, 3).join(', ')}${here.length > 3 ? '…' : ''}` : 'Tag a character…', () => C.picker(ev, posOf(info))]];
  });
  document.addEventListener('contextmenu', e => {
    const pg = e.target.closest?.('.reader .pg');
    if (!pg || e.defaultPrevented) return;   // someone else's menu already took it
    const info = K.readerPage?.(Number(pg.dataset.i));
    if (!info) return;
    e.preventDefault();
    const r = pg.getBoundingClientRect();
    info.focusY = r.height ? Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) : 0.5;   // the spot you clicked, for the wallpaper crop
    const list = [];
    for (const f of K.pageMenuItems) { try { const got = f(info, e); if (got?.length) { if (list.length && got[0] !== '-') list.push('-'); list.push(...got); } } catch {} }
    if (list.length) K.popMenu(e, `${short(info.chapterName)} · page ${info.page + 1}`, list);
  });

  // ---------- the series page: Characters ----------
  C.section = function (s, chapters) {
    const box = el('div.chr-wrap');
    const order = new Map((chapters || []).map((c, i) => [c.slug, i]));   // chapters come newest first
    const label = t => { const c = (chapters || []).find(x => x.slug === t.c); return `${short(c?.name || t.n) || 'Chapter'} · p${t.p + 1}`; };
    const where = t => `/read/${s.provider}/${encodeURIComponent(s.slug)}/${encodeURIComponent(t.c)}?page=${t.p}&off=${t.p ? 0 : 0.001}`;
    function draw(editing) {
      const list = C.of(s.provider, s.slug), names = C.names(s.provider, s.slug);
      if (!names.length) { box.replaceChildren(); return; }
      const rows = names.map(n => {
        const tags = [...list[n]].sort((a, b) => (order.get(b.c) ?? -1) - (order.get(a.c) ?? -1) || a.p - b.p);
        const head = editing === n ? (() => {
          const inp = el('input.lx-in', { type: 'text', value: n, maxLength: 40, spellcheck: false });
          const ok = () => { if (!C.rename(s.provider, s.slug, n, inp.value)) draw(); };
          inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') draw(); });
          setTimeout(() => { inp.focus(); inp.select(); }, 30);
          return el('div.lx-newrow.chr-head', inp, el('button.btn.small.primary', { onclick: ok }, 'Save'), el('button.btn.small', { onclick: () => draw() }, 'Cancel'));
        })() : el('div.chr-head', el('b', { text: n }), el('small.muted', { text: `${tags.length} page${tags.length === 1 ? '' : 's'}` }), el('div', { style: { flex: 1 } }),
          el('button.btn.small.icon', { title: 'Rename', 'aria-label': 'Rename ' + n, onclick: () => draw(n) }, icon('pencil')),
          el('button.btn.small.icon.chr-del', { title: 'Delete', 'aria-label': 'Delete ' + n, onclick: () => { if (confirm(`Delete ${n} and their ${tags.length} tag${tags.length === 1 ? '' : 's'}?`)) C.remove(s.provider, s.slug, n); } }, icon('trash')));
        const chips = el('div.chr-chips');
        const paint = all => chips.replaceChildren(...[...(all ? tags : tags.slice(0, 24)).map(t => el('button.chip.chr-chip', { title: 'Open this page (right-click to untag)', onclick: () => K.go(where(t)),
          oncontextmenu: e => { e.preventDefault(); if (confirm(`Take ${n} off ${label(t)}?`)) C.untag({ provider: s.provider, slug: s.slug, chapterSlug: t.c, page: t.p }, n); } }, label(t))),
        !all && tags.length > 24 ? el('button.chip', { onclick: () => paint(true) }, `+${tags.length - 24} more`) : null].filter(Boolean));
        paint(false);
        return el('div.chr-row.glass', head, chips);
      });
      box.replaceChildren(el('div.section', el('h2', { text: 'Characters' }), el('span.count', { text: String(names.length) })), el('div.chr-list', rows));
    }
    draw();
    const onChange = e => { if (!box.isConnected) return document.removeEventListener('koru-chars', onChange); if (e.detail?.key === K.key(s.provider, s.slug)) draw(); };
    document.addEventListener('koru-chars', onChange);
    return box;
  };
})();
