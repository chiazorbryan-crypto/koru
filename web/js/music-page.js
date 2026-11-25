// Koru Music: the Music page (sidebar → Music). Home, Search (songs, albums, artists, playlists), Library
// (liked songs, your playlists, history, Glasswave), album / playlist / artist pages and the Now playing view.
// #/music  #/music/search?q=&k=  #/music/library  #/music/liked  #/music/recent  #/music/mine/<id>
// #/music/album/<id>  #/music/playlist/<id>  #/music/artist/<id>  #/music/more/<id>?p=  #/music/gw/<id>  #/music/now?tab=
'use strict';
(function () {
  const { el, icon } = K;
  const M = () => K.music, A = () => K.musicApi;
  const enc = encodeURIComponent;

  // ---------- Glasswave (read only, and only when these pages open) ----------
  // Koru reads your Glasswave: this PC's, or another Glasswave folder you link (Settings → Music, or paste its
  // folder in the Music search box). Downloaded songs play from Glasswave's own files.
  let gwInfo = null, gwAt = 0;
  const gwRoot = () => M().S().gwRoot || '';
  const withRoot = u => gwRoot() ? u + (u.includes('?') ? '&' : '?') + 'root=' + enc(gwRoot()) : u;
  const gwSong = t => {
    const th = /^https:\/\//.test(t.i || '') ? t.i : '';
    const f = t.f ? { f: t.f } : {};
    const m = (t.u || '').match(/[?&]v=([\w-]{11})/) || (t.u || '').match(/youtu\.be\/([\w-]{11})/);
    if (m) return { type: 'song', id: m[1], t: t.t || 'Unknown song', a: t.a, d: t.s, th, ...f };
    const g = (t.u || '').match(/^gwmatch:\/\/t\?(.*)$/);
    if (g) { const p = new URLSearchParams(g[1]); return { type: 'song', q: p.get('q') || `${t.t} ${t.a}`.trim(), d: Number(p.get('d')) || t.s || 0, t: t.t || p.get('q'), a: t.a, th, ...f }; }
    return t.t ? { type: 'song', q: `${t.t} ${t.a || ''}`.trim(), d: t.s || 0, t: t.t, a: t.a, th, ...f } : null;
  };
  const names = () => (K.data.music.gwNames ||= {});
  K.musicGw = {
    async info(fresh) {
      if (K.info?.platform !== 'desktop' || !M().S().gw) return null;
      if (!fresh && gwInfo && Date.now() - gwAt < 30000) return gwInfo;
      try { gwInfo = await K.api.get(withRoot('/k/glasswave')); gwAt = Date.now(); } catch { gwInfo = null; }
      return gwInfo?.found ? gwInfo : null;
    },
    async tracks(id) {
      const j = await K.api.get(withRoot('/k/glasswave/playlist/' + enc(id)));
      return { ...j, songs: (j.tracks || []).map(gwSong).filter(Boolean) };
    },
    // a song Glasswave downloaded plays from its file (known once its library was read)
    fileFor: id => gwInfo?.found && M().S().gw ? gwInfo.files?.[id] || null : null,
    audioUrl: f => withRoot('/k/glasswave/audio/' + enc(f)),
    async check(root) { try { return await K.api.get('/k/glasswave?check=1' + (root ? '&root=' + enc(root) : '')); } catch { return { found: false }; } },
    // link another Glasswave folder ('' goes back to this PC's)
    async link(root) {
      root = String(root || '').trim().replace(/^"|"$/g, '');
      const j = await K.musicGw.check(root);
      if (root && !j.found) return false;
      M().setS({ gwRoot: root, gw: true }); gwInfo = null; M().emit('lists');
      return true;
    },
    name: p => p.id === 'local_liked' ? 'Liked songs' : p.id === 'yt_VLLM' ? 'Liked Music' : p.name || names()[p.id] || (p.source === 'SAVED' ? 'Saved album' : 'YouTube Music playlist'),
    // your YouTube Music account's playlists that Glasswave keeps have no names in its files: ask YouTube Music once
    async nameOf(p) {
      if (p.name || names()[p.id] || p.id === 'yt_VLLM') return K.musicGw.name(p);
      const bid = p.id.replace(/^yt_/, '').replace(/^saved_/, '');
      try { const pg = await A().page(bid); if (pg?.t) { names()[p.id] = pg.t; K.save('music'); } } catch {}
      return K.musicGw.name(p);
    }
  };
  // a link pasted in the Music search box: a YouTube / YouTube Music song, playlist or album, or a Glasswave folder
  async function openLink(text) {
    const t = String(text || '').trim();
    if (/^[a-z]:\\|^\\\\/i.test(t)) {
      if (await K.musicGw.link(t)) { K.toast('Glasswave linked', 'ok'); K.go('/music'); } else K.toast('That folder isn\'t a Glasswave folder', 'error');
      return true;
    }
    let u; try { u = new URL(/^https?:\/\//.test(t) ? t : 'https://' + t); } catch { return false; }
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return false;
    const list = u.searchParams.get('list'), v = u.searchParams.get('v') || (u.hostname === 'youtu.be' ? u.pathname.slice(1, 12) : '');
    const browse = (u.pathname.match(/^\/browse\/([\w-]+)/) || [])[1];
    if (browse) { K.go('/music/' + (/^MPRE/.test(browse) ? 'album/' : /^UC/.test(browse) ? 'artist/' : 'playlist/') + enc(browse)); return true; }
    const ch = (u.pathname.match(/^\/channel\/(UC[\w-]+)/) || [])[1];
    if (ch) { K.go('/music/artist/' + enc(ch)); return true; }
    if (list && !/^RD/.test(list)) { K.go('/music/playlist/' + enc('VL' + list)); return true; }
    if (/^[\w-]{11}$/.test(v)) { M().play([{ type: 'song', id: v, t: 'Loading…' }], 0, { kind: 'link', t: 'From a link' }); K.toast('Playing the song from your link'); return true; }
    return false;
  }
  K.musicGw.openLink = openLink;

  // ---------- shared pieces ----------
  const fmt = s => M().fmt(s);
  const durTotal = list => { const s = list.reduce((a, x) => a + (x.d || 0), 0); return s ? (s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min' : Math.round(s / 60) + ' min') : ''; };
  const hrefOf = c => c.type === 'artist' ? '#/music/artist/' + enc(c.bid) : c.type === 'playlist' ? '#/music/playlist/' + enc(c.bid) : (c.type === 'album' || c.type === 'single') ? '#/music/album/' + enc(c.bid) : c.href || null;
  // follow the current song in any list on screen
  function follow(node) {
    const paint = () => { const c = M().cur(), k = c ? M().skey(c) : ''; node.querySelectorAll('[data-k]').forEach(r => r.classList.toggle('on', r.dataset.k === k)); node.querySelectorAll('[data-k].on').forEach(r => r.classList.toggle('playing', M().playing())); };
    let attached = false;
    const off = M().on(w => { if (!node.isConnected) { if (attached) off(); return; } attached = true; if (w === 'track' || w === 'state') paint(); if (w === 'likes') node.querySelectorAll('.mu-like').forEach(b => b.paint?.()); });
    requestAnimationFrame(paint);
    return node;
  }
  function likeBtn(s) {
    const b = el('button.mu-ib.mu-like.mu-heart', { title: 'Like', 'aria-label': 'Like', onclick: e => { e.stopPropagation(); M().like(s); } }, M().mi('heart'));
    b.paint = () => { const v = M().liked(s); b.classList.toggle('on', v); b.title = v ? 'Unlike' : 'Like'; };
    b.paint();
    return b;
  }
  function songRow(s, i, ctx) {
    const play = () => M().play(ctx.list, i, ctx.src);
    return el('div.mu-row', { dataset: { k: M().skey(s) }, onclick: play, oncontextmenu: e => M().songMenu(e, s, ctx), title: s.t },
      el('span.mu-rn', ctx.num ? el('span', { text: String(i + 1) }) : M().artImg(s.th, 60), el('i.mu-eq', el('b'), el('b'), el('b'))),
      el('div.mu-rt', el('b', { text: s.t }), el('small', s.aid ? el('a.mu-alink', { href: '#/music/artist/' + enc(s.aid), text: s.a || '', onclick: e => e.stopPropagation() }) : (s.a || ''),
        s.type === 'video' ? el('span.mu-tag', { text: 'Video' }) : null)),
      el('span.mu-ral', s.alid ? el('a.mu-alink', { href: '#/music/album/' + enc(s.alid), text: s.al || '', onclick: e => e.stopPropagation() }) : (s.al || '')),
      likeBtn(s),
      el('span.mu-rd', { text: s.d ? fmt(s.d) : '' }),
      el('button.mu-ib', { title: 'More', 'aria-label': 'More', onclick: e => M().songMenu(e, s, ctx) }, icon('more')));
  }
  const songList = (list, ctx = {}) => follow(el('div.mu-list', list.map((s, i) => songRow(s, i, { list, ...ctx }))));
  function card(c, onPlay) {
    const href = hrefOf(c);
    const playIt = async e => {
      e.preventDefault(); e.stopPropagation();
      if (c.id) return M().startRadio(c);
      if (onPlay) return onPlay();
      try { const p = await A().page(c.bid); if (p.tracks?.length) M().play(p.tracks, 0, { kind: c.type, t: p.t, href }); else if (href) K.go(href.slice(1)); }
      catch (err) { K.toast(err.message, 'error'); }
    };
    const box = el(href ? 'a.mu-card' : 'div.mu-card', { href: href || undefined, title: c.t, onclick: href ? null : playIt, oncontextmenu: c.id ? e => M().songMenu(e, c) : null, dataset: c.id ? { k: M().skey(c) } : {} },
      el('div.mu-cv' + (c.type === 'artist' ? '.round' : ''), M().artImg(c.th, 300), c.type !== 'artist' ? el('button.mu-cplay', { title: 'Play', 'aria-label': 'Play', onclick: playIt }, M().mi('play')) : null),
      el('b', { text: c.t }), el('small', { text: c.sub || [c.type === 'video' ? 'Video' : c.type === 'song' ? 'Song' : '', c.a].filter(Boolean).join(' • ') }));
    return box;
  }
  const cardRow = (items, onPlayFor) => follow(el('div.mu-cards', items.map(c => card(c, onPlayFor?.(c)))));
  function quickPicks(list, src) {
    return follow(el('div.mu-qp', list.map((s, i) => el('div.mu-qrow', { dataset: { k: M().skey(s) }, onclick: () => M().play(list, i, src), oncontextmenu: e => M().songMenu(e, s), title: s.t },
      el('span.mu-rn', M().artImg(s.th, 60), el('i.mu-eq', el('b'), el('b'), el('b'))), el('div.mu-rt', el('b', { text: s.t }), el('small', { text: s.a || '' }))))));
  }
  function shelfEl(sh) {
    const songs = sh.items.filter(x => x.id), more = sh.more ? (sh.more.pt === 'MUSIC_PAGE_TYPE_PLAYLIST' || /^VL/.test(sh.more.bid) ? '#/music/playlist/' + enc(sh.more.bid) : '#/music/more/' + enc(sh.more.bid) + (sh.more.params ? '?p=' + enc(sh.more.params) : '')) : null;
    const head = el('div.section', el('h2', { text: sh.title || '' }), sh.strap ? el('span.count', { text: sh.strap }) : null, el('div.sp', { style: { flex: 1 } }), more ? el('a.chip', { href: more }, 'See all') : null);
    let body;
    if (sh.list && songs.length) body = songList(songs, { src: { kind: 'shelf', t: sh.title } });
    else if (songs.length === sh.items.length && songs.length > 6) body = quickPicks(songs, { kind: 'shelf', t: sh.title });
    else body = cardRow(sh.items);
    return el('section.mu-shelf', head, body);
  }
  function hero({ th, round, kind, t, sub, artist, aid, tracks, src, extra = [] }) {
    const playable = (tracks || []).length > 0;
    return el('div.mu-hero', el('div.mu-hart' + (round ? '.round' : ''), M().artImg(th, 544)),
      el('div.mu-hinfo', kind ? el('small.mu-kind', { text: kind }) : null, el('h1', { text: t || '' }),
        artist ? el('div.mu-hartist', aid ? el('a.mu-alink', { href: '#/music/artist/' + enc(aid), text: artist }) : artist) : null,
        sub ? el('div.mu-hsub', { text: sub }) : null,
        el('div.row.mu-hbtns',
          playable ? el('button.btn.primary', { onclick: () => M().play(tracks, 0, src) }, M().mi('play'), 'Play') : null,
          playable && tracks.length > 1 ? el('button.btn', { onclick: () => { const l = tracks.slice(); for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } M().play(l, 0, src); } }, M().mi('shuffle'), 'Shuffle') : null,
          ...extra)));
  }
  const loading = () => el('div.spinner');
  const empty = (title, text, btn) => el('div.empty', K.fox(), el('h3', { text: title }), text ? el('p', { text }) : null, btn || null);
  const fail = (e, retry) => el('div.empty', K.fox(), el('h3', { text: 'That didn\'t load' }), el('p', { text: e?.message || 'Check your connection and try again.' }), retry ? el('button.btn', { onclick: retry }, icon('refresh'), 'Try again') : null);
  async function confirmDelete(name) { return M().ask(`Delete "${name}"?`, '', null, 'Delete', true); }

  // ---------- the page ----------
  K.views.music = async function (root, r, alive) {
    const sub = r.parts[0] || 'home';
    root.classList.add('mu-page');
    if (!M().available()) { root.append(empty('Music isn\'t here yet', 'Music plays on the Windows app.')); return; }
    const q = r.query.get('q') || '';
    const input = el('input.txt.mu-search', { type: 'search', placeholder: 'Search, or paste a link', value: sub === 'search' ? q : '', spellcheck: false, autocomplete: 'off' });
    const tab = (id, label, ic, href) => el('a.chip' + (sub === id || (id === 'library' && ['liked', 'recent', 'mine', 'gw'].includes(sub)) ? '.on' : ''), { href }, M().mi(ic), label);
    root.append(el('div.head.mu-head', el('div', el('h1', { text: 'Music' }), el('div.sub', { text: 'Your Glasswave and YouTube Music, right inside Koru.' })), el('div.sp'),
      el('div.mu-searchbox', M().mi('search'), input)),
      el('div.row.mu-tabs', tab('home', 'Home', 'music', '#/music'), tab('library', 'Library', 'library', '#/music/library'), M().cur() ? tab('now', 'Now playing', 'play', '#/music/now') : null));
    const body = el('div.mu-body');
    root.append(body);
    if (sub !== 'search') input.addEventListener('keydown', async e => { if (e.key === 'Enter' && input.value.trim() && !await openLink(input.value)) K.go('/music/search?q=' + enc(input.value.trim())); });
    input.addEventListener('paste', () => setTimeout(async () => { if (/^(https?:\/\/|[a-z]:\\|\\\\)/i.test(input.value.trim()) && await openLink(input.value)) input.value = ''; }, 0));
    const V = { home, search, library, liked, recent, mine, album: page, playlist: page, artist, more, now, gw }[sub] || home;
    try { await V(body, r, alive, input); }
    catch (e) { if (alive()) body.replaceChildren(fail(e, () => K.views.music(root.replaceChildren() || root, r, alive))); }
  };

  // Home: your music first, then YouTube Music's own shelves
  async function home(body, r, alive) {
    const gwBox = el('div'), mine = el('div'), yt = el('div', loading());
    body.append(gwBox, mine, yt);
    gwHome(gwBox, alive);
    const recent = (K.data.music.recent || []).slice(0, 20);
    if (recent.length) mine.append(el('section.mu-shelf', el('div.section', el('h2', { text: 'Jump back in' }), el('div.sp', { style: { flex: 1 } }), el('a.chip', { href: '#/music/recent' }, 'See all')), cardRow(recent)));
    const yours = yourCards();
    mine.append(el('section.mu-shelf', el('div.section', el('h2', { text: 'Your music' }), el('div.sp', { style: { flex: 1 } }), el('a.chip', { href: '#/music/library' }, 'Library')), yours));
    try {
      const shelves = await A().home();
      if (!alive()) return;
      yt.replaceChildren(...shelves.map(shelfEl));
      if (!shelves.length) yt.replaceChildren(empty('Nothing to show right now', 'Search for a song to start.'));
    } catch (e) { if (alive()) yt.replaceChildren(fail(e, () => home(body.replaceChildren() || body, r, alive))); }
  }
  function yourCards() {
    const likes = M().likedList();
    return el('div.mu-cards',
      el('a.mu-card', { href: '#/music/liked' }, el('div.mu-cv.mu-likedcv', M().mi('heart')), el('b', { text: 'Liked songs' }), el('small', { text: likes.length + (likes.length === 1 ? ' song' : ' songs') })),
      ...M().lists().map(p => el('a.mu-card', { href: '#/music/mine/' + enc(p.id) }, el('div.mu-cv', M().artImg(p.songs[0]?.th, 300)), el('b', { text: p.name }), el('small', { text: p.songs.length + (p.songs.length === 1 ? ' song' : ' songs') }))),
      el('button.mu-card.mu-newcard', { onclick: newPlaylist }, el('div.mu-cv', icon('plus')), el('b', { text: 'New playlist' }), el('small', { text: 'Add songs from any ⋯ menu' })));
  }
  const gwCard = (href, cover, title, small, i = 0) => el('a.mu-card.gw', { href, style: { '--i': i } }, cover, el('b', { text: title }), el('small', { text: small }));
  const songs_ = n => n + (n === 1 ? ' song' : ' songs');
  function gwCards(g) {
    const cards = [];
    let i = 0;
    if (g.history) cards.push(gwCard('#/music/gw/history', el('div.mu-cv.mu-gwcv', M().mi('radio')), 'Recently played', 'Glasswave • ' + songs_(g.history), i++));
    for (const p of g.playlists) cards.push(gwCard('#/music/gw/' + enc(p.id), el('div.mu-cv' + (p.id === 'local_liked' ? '.mu-likedcv' : ''), p.id === 'local_liked' ? M().mi('heart') : M().artImg(p.thumb, 300)),
      K.musicGw.name(p), 'Glasswave • ' + songs_(p.count), i++));
    if (g.downloads) cards.push(gwCard('#/music/gw/downloads', el('div.mu-cv.mu-gwcv', icon('download')), 'Downloads', songs_(g.downloads) + ' • play offline', i++));
    for (const p of g.more || []) {
      const c = gwCard('#/music/gw/' + enc(p.id), el('div.mu-cv' + (p.id === 'yt_VLLM' ? '.mu-likedcv' : ''), p.id === 'yt_VLLM' ? M().mi('heart') : M().artImg(p.thumb, 300)), K.musicGw.name(p),
        (p.source === 'SAVED' ? 'Saved album' : 'YouTube Music') + ' • ' + songs_(p.count), i++);
      if (!p.name && p.id !== 'yt_VLLM') K.musicGw.nameOf(p).then(n => { const b = c.querySelector('b'); if (b && n) b.textContent = n; });
      cards.push(c);
    }
    return cards;
  }
  // the Glasswave shelf at the top of Home, or a card to link it
  async function gwHome(box, alive) {
    if (K.info?.platform !== 'desktop') return;
    const g = await K.musicGw.info();
    if (!alive()) return;
    if (g) {
      box.replaceChildren(el('section.mu-shelf.mu-gwshelf', el('div.section', el('h2', el('span.mu-gwdot'), 'Your Glasswave'), el('span.count', { text: 'read only' }), el('div.sp', { style: { flex: 1 } }),
        el('a.chip', { href: '#/music/library' }, 'Library')), el('div.mu-cards', gwCards(g))));
      return;
    }
    box.replaceChildren(gwLinkCard());
  }
  function gwLinkCard() {
    const inp = el('input.txt', { type: 'text', placeholder: 'Paste your Glasswave folder, e.g. C:\\Users\\you\\AppData\\Roaming\\Glasswave', spellcheck: false });
    const go = async () => {
      const v = inp.value.trim();
      if (!v) { if (await K.musicGw.link('')) K.go('/music'); else K.toast('Glasswave isn\'t on this PC. Paste the folder of another one.', 'error'); return; }
      if (await openLink(v)) return;
      K.toast('Paste a Glasswave folder, or a YouTube Music link', 'error');
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return el('section.panel.glass.mu-gwlink', el('div.mu-gwlink-art', el('span.mu-gwdot.big')),
      el('div', el('h3', { text: 'Link your Glasswave' }),
        el('p', { text: 'Your Glasswave playlists, liked songs, history and downloads, inside Koru. Paste the Glasswave folder from this PC or another one (a copy on OneDrive works too). Koru only reads it.' }),
        el('div.row', inp, el('button.btn.primary', { onclick: go }, M().mi('link'), 'Link'))));
  }
  async function newPlaylist() {
    const n = await M().ask('New playlist', '', 'Name');
    if (!n) return;
    const id = M().newList(n);
    K.go('/music/mine/' + enc(id));
  }

  // Search: songs, albums, artists and playlists, as you type
  async function search(body, r, alive, input) {
    let kind = r.query.get('k') || 'songs', seq = 0;
    const out = el('div');
    const chips = el('div.row.mu-kinds', [['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']].map(([k, l]) =>
      el('button.chip' + (k === kind ? '.on' : ''), { dataset: { k }, onclick: () => { kind = k; chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.k === k)); run(); } }, l)));
    body.append(chips, out);
    async function run() {
      const q = input.value.trim(), my = ++seq;
      history.replaceState(null, '', '#/music/search?q=' + enc(q) + (kind !== 'songs' ? '&k=' + kind : ''));
      if (!q) { out.replaceChildren(empty('Find something to play', 'Search for a song, an album, an artist or a playlist.')); return; }
      out.replaceChildren(loading());
      try {
        const res = await A().search(q, kind);
        if (my !== seq || !alive()) return;
        if (!res.length) { out.replaceChildren(empty('Nothing found', `No ${kind} for "${q}".`)); return; }
        out.replaceChildren(kind === 'songs' ? songList(res.filter(x => x.id), { src: { kind: 'search', t: q } }) : el('div.mu-grid', res.map(c => card(c))));
      } catch (e) { if (my === seq) out.replaceChildren(fail(e, run)); }
    }
    input.addEventListener('input', K.debounce(run, 420));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
    await run();
  }

  // Library: liked songs, your playlists, history, Glasswave
  async function library(body, r, alive) {
    const draw = () => {
      const likes = M().likedList(), recent = K.data.music.recent || [];
      body.replaceChildren(
        el('section.mu-shelf', el('div.section', el('h2', { text: 'Your playlists' }), el('span.count', { text: String(M().lists().length + 1) })), yourCards()),
        el('section.mu-shelf', el('div.section', el('h2', { text: 'Liked songs' }), el('span.count', { text: String(likes.length) }), el('div.sp', { style: { flex: 1 } }), likes.length ? el('a.chip', { href: '#/music/liked' }, 'See all') : null),
          likes.length ? songList(likes.slice(0, 6), { src: { kind: 'liked', t: 'Liked songs', href: '#/music/liked' }, list: likes }) : el('p.mu-hint', { text: 'Tap the heart on any song to keep it here.' })),
        el('section.mu-shelf', el('div.section', el('h2', { text: 'Recently played' }), el('div.sp', { style: { flex: 1 } }), recent.length ? el('a.chip', { href: '#/music/recent' }, 'See all') : null),
          recent.length ? songList(recent.slice(0, 6), { src: { kind: 'recent', t: 'Recently played' }, list: recent }) : el('p.mu-hint', { text: 'Songs you play show up here.' })),
        gwBox);
    };
    const gwBox = el('div');
    draw();
    const off = M().on(w => { if (!body.isConnected) { off(); return; } if (w === 'lists') draw(); });
    const g = await K.musicGw.info(true);
    if (!alive()) return;
    gwBox.replaceChildren(g ? el('section.mu-shelf.mu-gwshelf', el('div.section', el('h2', el('span.mu-gwdot'), 'From Glasswave'), el('span.count', { text: 'read only' })), el('div.mu-cards', gwCards(g))) : gwLinkCard());
  }
  // songRow's list comes from ctx.list, so a preview of 6 still plays the whole list
  async function liked(body) {
    const draw = () => {
      const likes = M().likedList();
      body.replaceChildren(hero({ kind: 'Playlist', t: 'Liked songs', sub: likes.length + ' songs' + (durTotal(likes) ? ' • ' + durTotal(likes) : ''), tracks: likes, src: { kind: 'liked', t: 'Liked songs', href: '#/music/liked' } }),
        likes.length ? songList(likes, { src: { kind: 'liked', t: 'Liked songs', href: '#/music/liked' } }) : empty('No liked songs yet', 'Tap the heart on any song and it lands here.'));
      body.querySelector('.mu-hart').replaceChildren(el('div.mu-likedcv.big', M().mi('heart')));
    };
    draw();
    const off = M().on(w => { if (!body.isConnected) { off(); return; } if (w === 'likes') draw(); });
  }
  async function recent(body) {
    const list = K.data.music.recent || [];
    body.append(hero({ kind: 'History', t: 'Recently played', sub: list.length + ' songs', tracks: list, src: { kind: 'recent', t: 'Recently played' }, th: list[0]?.th }),
      list.length ? songList(list, { src: { kind: 'recent', t: 'Recently played' } }) : empty('Nothing played yet', 'Songs you play show up here.'));
  }
  async function mine(body, r) {
    const id = r.parts[1];
    const draw = () => {
      const p = K.data.mlists[id];
      if (!p) { body.replaceChildren(empty('That playlist is gone', 'It may have been deleted on another PC.', el('a.btn', { href: '#/music/library' }, 'Library'))); return; }
      const src = { kind: 'mine', t: p.name, href: '#/music/mine/' + enc(id) };
      body.replaceChildren(hero({ kind: 'Your playlist', t: p.name, th: p.songs[0]?.th, sub: p.songs.length + ' songs' + (durTotal(p.songs) ? ' • ' + durTotal(p.songs) : ''), tracks: p.songs, src,
        extra: [el('button.btn', { onclick: async () => { const n = await M().ask('Rename playlist', p.name, 'Name'); if (n) { p.name = n.slice(0, 80); p.at = Date.now(); K.save('mlists'); M().emit('lists'); } } }, icon('pencil'), 'Rename'),
          el('button.btn', { onclick: async () => { if (await confirmDelete(p.name)) { delete K.data.mlists[id]; K.save('mlists'); M().emit('lists'); K.toast('Playlist deleted'); K.go('/music/library', true); } } }, icon('trash'), 'Delete')] }),
        p.songs.length ? songList(p.songs, { src, plId: id }) : empty('No songs yet', 'Open the ⋯ menu on any song and pick "Add to playlist".'));
    };
    draw();
    const off = M().on(w => { if (!body.isConnected) { off(); return; } if (w === 'lists') draw(); });
  }
  // an album or a YouTube Music playlist
  async function page(body, r, alive) {
    const bid = r.parts[1];
    body.append(loading());
    const p = await A().page(bid);
    if (!alive()) return;
    const href = '#/music/' + (p.kind === 'album' ? 'album/' : 'playlist/') + enc(bid);
    const src = { kind: p.kind, t: p.t, href };
    const list = el('div');
    const save = el('button.btn', { title: 'Copy these songs into a playlist of your own', onclick: () => { const id = M().newList(p.t, p.tracks); K.toast(`Saved to your playlists as "${p.t}"`, 'ok'); void id; } }, M().mi('addlist'), 'Save');
    body.replaceChildren(hero({ kind: p.kind === 'album' ? (p.sub || 'Album') : 'Playlist', t: p.t, th: p.th, artist: p.artist, aid: p.aid, sub: [p.kind === 'album' ? '' : p.sub, p.sub2].filter(Boolean).join(' • '), tracks: p.tracks, src, extra: [save] }),
      p.desc ? el('p.mu-desc', { text: p.desc }) : null, list, ...p.shelves.map(shelfEl));
    const paintList = () => list.replaceChildren(p.tracks.length ? songList(p.tracks, { src, num: p.kind === 'album' }) : empty('No songs here', 'This one may be private or empty.'));
    paintList();
    // long playlists: the rest comes in pages, a few at a time
    let cont = p.cont;
    for (let n = 0; cont && n < 5 && alive(); n++) {
      try { const m = await A().more(cont); cont = m.cont; if (!m.tracks.length) break; p.tracks.push(...m.tracks); } catch { break; }
      if (!alive()) return;
      paintList();
    }
  }
  async function artist(body, r, alive) {
    const bid = r.parts[1];
    body.append(loading());
    const p = await A().page(bid);
    if (!alive()) return;
    const top = p.shelves.find(s => s.list)?.items.filter(x => x.id) || [];
    const src = { kind: 'artist', t: p.t, href: '#/music/artist/' + enc(bid) };
    body.replaceChildren(hero({ kind: 'Artist', t: p.t, th: p.th, round: true, sub: p.sub, tracks: top, src,
      extra: top[0] ? [el('button.btn', { onclick: () => M().startRadio(top[0]) }, M().mi('radio'), 'Radio')] : [] }),
    ...p.shelves.map(shelfEl), p.desc ? el('section.mu-shelf', el('div.section', el('h2', { text: 'About' })), el('p.mu-desc', { text: p.desc })) : null);
  }
  async function more(body, r, alive) {
    body.append(loading());
    const p = await A().page(r.parts[1], r.query.get('p') || undefined);
    if (!alive()) return;
    const items = p.shelves.flatMap(s => s.items);
    body.replaceChildren(el('div.section', el('h2', { text: p.t || 'More' })), items.length ? el('div.mu-grid', items.map(c => card(c))) : empty('Nothing here', ''));
  }
  async function gw(body, r, alive) {
    const id = r.parts[1];
    body.append(loading());
    const g = await K.musicGw.info();
    if (!alive()) return;
    if (!g) { body.replaceChildren(gwLinkCard()); return; }
    const j = await K.musicGw.tracks(id);
    if (!alive()) return;
    const info = g.playlists.find(p => p.id === id) || (g.more || []).find(p => p.id === id);
    const name = id === 'last' ? 'Continue from Glasswave' : id === 'downloads' ? 'Downloads' : id === 'history' ? 'Recently played' : info ? await K.musicGw.nameOf(info) : 'Glasswave';
    const src = { kind: 'gw', t: name, href: '#/music/gw/' + enc(id) };
    const songs = j.songs;
    const extra = id === 'last' && songs.length ? [el('button.btn.primary', { onclick: () => M().play(songs, Math.min(j.cur || 0, songs.length - 1), src, j.pos || 0) }, M().mi('play'), 'Continue')] : [];
    const h = hero({ kind: 'Glasswave' + (id === 'last' ? ' queue' : id === 'history' ? ' history' : id === 'downloads' ? ' downloads' : ' playlist'), t: name, th: info?.thumb || songs[0]?.th, sub: songs.length + ' songs' + (durTotal(songs) ? ' • ' + durTotal(songs) : ''), tracks: songs, src, extra });
    if (id === 'local_liked' || id === 'yt_VLLM') h.querySelector('.mu-hart').replaceChildren(el('div.mu-likedcv.big', M().mi('heart')));
    const local = songs.filter(x => x.f || (x.id && K.musicGw.fileFor(x.id))).length;
    body.replaceChildren(h, el('p.mu-hint', { text: 'From your Glasswave. ' + (local ? `${local === songs.length ? 'Every song' : local + ' of these songs'} play${local === 1 && local !== songs.length ? 's' : ''} from your Glasswave downloads, offline and without ads. ` : '') + 'The rest play through YouTube Music.' }),
      songs.length ? songList(songs, { src }) : empty('No songs here', ''));
  }

  // ---------- Now playing ----------
  const lyricsCache = new Map();
  async function now(body, r) {
    let tab = r.query.get('tab') === 'lyrics' ? 'lyrics' : 'queue';
    const L = {};
    L.art = el('div.mu-nart'); L.t = el('h2.mu-nt'); L.a = el('div.mu-na'); L.src = el('a.mu-nsrc');
    L.seek = M().seekBar('.big'); L.now = el('span.mu-time'); L.dur = el('span.mu-time');
    L.play = M().ib('play', 'Play', M().toggle, '.huge'); L.shuf = M().ib('shuffle', 'Shuffle', M().toggleShuffle); L.rep = M().ib('repeat', 'Repeat', M().cycleRepeat);
    L.like = M().ib('heart', 'Like', () => M().cur() && M().like(M().cur()), '.mu-heart');
    L.vol = M().volBox();
    L.side = el('div.mu-nside');
    const seg = K.segmented([['queue', 'Up next', 'list'], ['lyrics', 'Lyrics', 'book']], tab, v => { tab = v; history.replaceState(null, '', '#/music/now?tab=' + v); drawSide(); });
    const left = el('div.mu-nleft', L.art, el('div.mu-ninfo', L.src, L.t, L.a),
      el('div.mu-bseek.mu-nseek', L.now, L.seek, L.dur),
      el('div.mu-nctl', L.shuf, M().ib('prev', 'Previous', M().prev, '.big'), L.play, M().ib('next', 'Next', () => M().next(), '.big'), L.rep),
      el('div.mu-nmore', L.like, L.vol, M().ib('more', 'More', e => M().cur() && M().songMenu(e, M().cur()))));
    const wrap = el('div.mu-now', left, el('div.mu-nright.glass', el('div.mu-nseg', seg), L.side));
    body.append(wrap);
    let lyrFor = '';
    function drawSide() {
      const c = M().cur();
      if (tab === 'lyrics') {
        if (!c?.id) { L.side.replaceChildren(el('p.mu-hint', { text: c ? 'Lyrics show once the song starts.' : 'Play a song to see its lyrics.' })); lyrFor = ''; return; }
        if (lyrFor === c.id) return;
        lyrFor = c.id;
        const show = l => { if (lyrFor !== c.id) return; L.side.replaceChildren(l ? el('div.mu-lyrics', el('p', { text: l.text }), l.source ? el('small', { text: l.source }) : null) : el('p.mu-hint', { text: 'No lyrics for this song.' })); };
        if (lyricsCache.has(c.id)) return show(lyricsCache.get(c.id));
        L.side.replaceChildren(loading());
        A().lyrics(c.id).then(l => { lyricsCache.set(c.id, l); show(l); }, e => { if (lyrFor === c.id) { lyrFor = ''; L.side.replaceChildren(fail(e, drawSide)); } });
        return;
      }
      lyrFor = '';
      const P = M().P, S = M().S();
      const radio = el('button.toggle' + (S.radio ? '.on' : ''), { role: 'switch', 'aria-checked': String(S.radio), title: 'Play similar songs when the queue ends' });
      radio.onclick = () => { const v = !radio.classList.contains('on'); radio.classList.toggle('on', v); radio.setAttribute('aria-checked', String(v)); M().setS({ radio: v }); };
      const head = el('div.mu-qhead', el('div', el('b', { text: 'Up next' }), P.src?.t ? el('small', { text: 'Playing from ' + P.src.t }) : null), el('div.sp', { style: { flex: 1 } }),
        el('label.mu-auto', el('span', { text: 'Autoplay' }), radio),
        P.queue.length > P.idx + 1 ? el('button.btn.small', { onclick: () => M().clearUpNext() }, 'Clear') : null);
      if (!P.queue.length) { L.side.replaceChildren(head, el('p.mu-hint', { text: 'Nothing queued.' })); return; }
      const rows = P.queue.map((s, i) => queueRow(s, i));
      const list = el('div.mu-queue', rows);
      L.side.replaceChildren(head, list);
      requestAnimationFrame(() => list.querySelector('.on')?.scrollIntoView({ block: 'center' }));
    }
    let dragFrom = -1;
    function queueRow(s, i) {
      const P = M().P;
      const row = el('div.mu-qrow2' + (i === P.idx ? '.on' : '') + (i < P.idx ? '.past' : ''), { draggable: true, onclick: () => M().jump(i), oncontextmenu: e => M().songMenu(e, s, { queueIdx: i }) },
        el('span.mu-grip', icon('grip')), el('span.mu-rn', M().artImg(s.th, 60), el('i.mu-eq', el('b'), el('b'), el('b'))),
        el('div.mu-rt', el('b', { text: s.t }), el('small', { text: [s.a, s.radio ? 'radio' : ''].filter(Boolean).join(' • ') })),
        el('span.mu-rd', { text: s.d ? fmt(s.d) : '' }),
        M().ib('up', 'Move up', () => M().move(i, i - 1)), M().ib('down', 'Move down', () => M().move(i, i + 1)),
        i !== P.idx ? M().ib('x', 'Remove', () => M().remove(i)) : el('span.mu-ibx'));
      if (i === P.idx) row.classList.toggle('playing', M().playing());
      row.addEventListener('dragstart', e => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); row.classList.add('drag'); });
      row.addEventListener('dragend', () => row.classList.remove('drag'));
      row.addEventListener('dragover', e => { if (dragFrom < 0) return; e.preventDefault(); row.classList.add('over'); });
      row.addEventListener('dragleave', () => row.classList.remove('over'));
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('over'); if (dragFrom >= 0) M().move(dragFrom, i); dragFrom = -1; });
      return row;
    }
    function paint(w) {
      if (!wrap.isConnected) { off(); return; }
      const c = M().cur(), P = M().P;
      if (w === 'time') return paintT();
      wrap.classList.toggle('none', !c);
      if (L.art.dataset.k !== (c?.th || '')) { L.art.dataset.k = c?.th || ''; L.art.replaceChildren(M().artImg(c?.th, 544)); }
      L.t.textContent = c ? c.t : 'Nothing playing';
      L.a.replaceChildren(...(c ? [M().artistLink(c), c.al ? el('span', { text: ' • ' }) : null, c.alid ? el('a.mu-alink', { href: '#/music/album/' + enc(c.alid), text: c.al }) : c.al ? el('span', { text: c.al }) : null] : [el('a.mu-alink', { href: '#/music', text: 'Find something to play' })]));
      L.src.textContent = P.src?.t ? 'Playing from ' + P.src.t : ''; L.src.href = P.src?.href || '#/music/now';
      L.play.replaceChildren(M().mi(M().playing() ? 'pause' : 'play')); L.play.classList.toggle('wait', P.st === 'loading');
      L.shuf.classList.toggle('on', P.shuffle); L.rep.classList.toggle('on', P.repeat !== 'off'); L.rep.replaceChildren(M().mi(P.repeat === 'one' ? 'repeat1' : 'repeat'));
      L.like.classList.toggle('on', M().liked(c));
      L.vol.paint(); paintT();
      if (w === 'queue' || w === 'track' || w == null) drawSide();
      else if (w === 'state') L.side.querySelectorAll('.mu-qrow2.on').forEach(x => x.classList.toggle('playing', M().playing()));
    }
    function paintT() { const P = M().P, d = P.d || M().cur()?.d || 0; L.seek.paint(); L.now.textContent = fmt(P.t); L.dur.textContent = fmt(d); }
    const off = M().on(paint);
    paint();
  }
})();
