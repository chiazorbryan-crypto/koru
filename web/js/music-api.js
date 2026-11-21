// Koru Music: YouTube Music's catalogue (search, home, albums, artists, playlists, radio and lyrics), read through
// its own web API (InnerTube, no key or sign-in) via Koru's background side. Nothing here runs until the Music page
// or the player asks. Every answer is turned into a few plain shapes:
//   song   { type: 'song' | 'video', id: videoId, t, a: artists, aid: artist id, al: album, alid: album id, d: seconds, th }
//   card   { type: 'album' | 'single' | 'artist' | 'playlist', bid: browseId, t, sub, th, aid? }
'use strict';
(function () {
  const BASE = 'https://music.youtube.com/youtubei/v1/';
  const CONTEXT = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20241106.01.00', hl: 'en', gl: 'US' } };
  const FILTER = { songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D', albums: 'EgWKAQIYAWoKEAkQBRAKEAMQBA%3D%3D', artists: 'EgWKAQIgAWoKEAkQBRAKEAMQBA%3D%3D',
    playlists: 'EgeKAQQoAEABagoQCRAFEAoQAxAE', videos: 'EgWKAQIQAWoKEAkQBRAKEAMQBA%3D%3D' };

  // ---------- talking to YouTube Music (answers kept for 10 minutes, so going back is instant) ----------
  const cache = new Map();
  function call(ep, body, qs = '') {
    const key = ep + qs + JSON.stringify(body);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 600000) return hit.p;
    const p = K.api.post('/k/fetch', { u: BASE + ep + '?prettyPrint=false' + qs, body: { context: CONTEXT, ...body } })
      .catch(e => { throw new Error(e.status === 403 ? 'Koru can\'t reach YouTube Music yet. Restart Koru once.' : 'Couldn\'t reach YouTube Music. Check your connection and try again.'); });
    cache.set(key, { at: Date.now(), p });
    p.catch(() => cache.delete(key));
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    return p;
  }

  // ---------- small readers for its JSON ----------
  const runs = x => x?.runs || [];
  const txt = x => (x?.simpleText != null ? x.simpleText : runs(x).map(r => r.text).join(''));
  const pageType = ne => ne?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
  const thumbs = o => o?.musicThumbnailRenderer?.thumbnail?.thumbnails || o?.thumbnail?.thumbnails || o?.thumbnails || (Array.isArray(o) ? o : null) || [];
  const thumbOf = (...os) => { for (const o of os) { const t = thumbs(o); if (t.length) return t[t.length - 1].url; } return ''; };
  const secs = s => { if (!/^\d+(:\d{1,2}){1,2}$/.test(s || '')) return 0; return s.split(':').reduce((a, b) => a * 60 + Number(b), 0); };
  const LABELS = /^(Song|Video|Album|Single|EP|Artist|Playlist|Episode|Podcast|Profile|Station)$/;
  const VIEWS = /\b(views?|plays?|subscribers?|monthly audience|listeners?|songs?|tracks?)\b/i;
  // A picture at the size it's shown (YouTube Music's own pictures can be asked for at any size)
  K.musicArt = (url, px = 120) => (typeof url === 'string' && /googleusercontent\.com|ggpht\.com/.test(url) ? url.replace(/=w\d+-h\d+[^/]*$/, `=w${px}-h${px}-l90-rj`) : url || '');

  // the "Artist • Album • 3:22" line under a title
  function byline(rs) {
    const out = { artists: [], aid: '', al: '', alid: '', d: 0, kind: '', rest: [] };
    for (const r of rs) {
      const t = (r.text || '').trim();
      if (!t || t === '•' || t === '&' || t === ',') continue;
      const pt = pageType(r.navigationEndpoint);
      if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') { out.artists.push(t); if (!out.aid) out.aid = r.navigationEndpoint.browseEndpoint.browseId; }
      else if (pt === 'MUSIC_PAGE_TYPE_ALBUM') { out.al = t; out.alid = r.navigationEndpoint.browseEndpoint.browseId; }
      else if (secs(t)) out.d = secs(t);
      else if (LABELS.test(t) && !out.kind && !out.artists.length) out.kind = t;
      else out.rest.push(t);
    }
    return out;
  }
  const videoKind = we => (we?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || '') === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : 'video';
  const cardType = (pt, kind) => pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL' ? 'artist' : pt === 'MUSIC_PAGE_TYPE_PLAYLIST' ? 'playlist'
    : pt === 'MUSIC_PAGE_TYPE_ALBUM' ? (/^(Single|EP)$/.test(kind) ? 'single' : 'album') : '';

  // one row of a list: a song, or an album / artist / playlist in search results
  function row(r) {
    const cols = (r.flexColumns || []).map(c => c.musicResponsiveListItemFlexColumnRenderer?.text);
    const fixed = (r.fixedColumns || []).map(c => txt(c.musicResponsiveListItemFixedColumnRenderer?.text));
    const title = txt(cols[0]);
    const th = thumbOf(r.thumbnail);
    const tne = runs(cols[0])[0]?.navigationEndpoint;
    const play = r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint;
    const we = tne?.watchEndpoint || play?.watchEndpoint;
    const vid = r.playlistItemData?.videoId || we?.videoId;
    const b = byline(cols.slice(1).flatMap(c => runs(c)));
    const be = r.navigationEndpoint?.browseEndpoint;
    if (vid && !be) {
      const d = b.d || fixed.map(secs).find(Boolean) || 0;
      const artists = b.artists.length ? b.artists : b.rest.filter(x => !VIEWS.test(x) && !/^\d{4}$/.test(x)).slice(0, 1);
      return { type: b.kind === 'Video' ? 'video' : b.kind === 'Song' ? 'song' : we ? videoKind(we) : 'song', id: vid, t: title, a: artists.join(', '), aid: b.aid, al: b.al, alid: b.alid, d, th };
    }
    if (be) {
      const type = cardType(pageType(r.navigationEndpoint), b.kind) || (play?.watchPlaylistEndpoint ? 'playlist' : '');
      if (!type) return null;
      return { type, bid: be.browseId, t: title, sub: [b.kind && type !== 'artist' ? b.kind : '', ...b.artists, ...b.rest].filter(Boolean).join(' • '), aid: b.aid, th };
    }
    const wpe = play?.watchPlaylistEndpoint;
    if (wpe?.playlistId) return { type: 'playlist', bid: 'VL' + wpe.playlistId, t: title, sub: [...b.artists, ...b.rest].join(' • '), th };
    return null;
  }
  // a square card in a row of cards
  function two(r) {
    const ne = r.navigationEndpoint || runs(r.title)[0]?.navigationEndpoint;
    const b = byline(runs(r.subtitle));
    const th = thumbOf(r.thumbnailRenderer);
    const t = txt(r.title);
    if (ne?.watchEndpoint?.videoId) return { type: videoKind(ne.watchEndpoint), id: ne.watchEndpoint.videoId, t, a: (b.artists.length ? b.artists : b.rest.filter(x => !VIEWS.test(x)).slice(0, 1)).join(', '), aid: b.aid, al: b.al, alid: b.alid, d: b.d, th };
    if (ne?.watchPlaylistEndpoint?.playlistId) return { type: 'playlist', bid: 'VL' + ne.watchPlaylistEndpoint.playlistId, t, sub: txt(r.subtitle), th };
    const be = ne?.browseEndpoint;
    if (!be) return null;
    const type = cardType(pageType(ne), b.kind) || (/^MPRE/.test(be.browseId) ? 'album' : /^VL|^PL|^RD/.test(be.browseId) ? 'playlist' : /^UC/.test(be.browseId) ? 'artist' : '');
    if (!type) return null;
    return { type, bid: be.browseId, t, sub: txt(r.subtitle), aid: b.aid, th };
  }
  function panel(v) {
    v = v?.playlistPanelVideoRenderer || v?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    if (!v?.videoId) return null;
    const b = byline(runs(v.longBylineText));
    return { type: videoKind(v.navigationEndpoint?.watchEndpoint), id: v.videoId, t: txt(v.title), a: (b.artists.length ? b.artists : runs(v.shortBylineText).map(r => r.text)).join(', '),
      aid: b.aid, al: b.al, alid: b.alid, d: secs(txt(v.lengthText)), th: thumbOf(v.thumbnail) };
  }
  const items = list => (list || []).map(x => x.musicResponsiveListItemRenderer ? row(x.musicResponsiveListItemRenderer) : x.musicTwoRowItemRenderer ? two(x.musicTwoRowItemRenderer) : null).filter(Boolean);
  const contToken = list => (list || []).map(x => x.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token).find(Boolean) || null;
  // a shelf: a list of songs or a row of cards, with an optional "See all" page
  function shelf(s) {
    if (s.musicCarouselShelfRenderer) {
      const c = s.musicCarouselShelfRenderer, h = c.header?.musicCarouselShelfBasicHeaderRenderer;
      const more = h?.moreContentButton?.buttonRenderer?.navigationEndpoint?.browseEndpoint;
      return { title: txt(h?.title), strap: txt(h?.strapline), items: items(c.contents), more: more ? { bid: more.browseId, params: more.params, pt: pageType({ browseEndpoint: more }) } : null };
    }
    const m = s.musicShelfRenderer || s.musicPlaylistShelfRenderer;
    if (m) {
      const more = m.bottomEndpoint?.browseEndpoint;
      return { title: txt(m.title), items: items(m.contents), list: true, cont: contToken(m.contents), more: more ? { bid: more.browseId, params: more.params, pt: pageType({ browseEndpoint: more }) } : null };
    }
    if (s.gridRenderer) return { title: txt(s.gridRenderer.header?.gridHeaderRenderer?.title), items: items(s.gridRenderer.items) };
    return null;
  }
  const shelves = list => (list || []).map(shelf).filter(s => s && s.items.length);

  // ---------- what the Music page asks for ----------
  const M = K.musicApi = {
    FILTER,
    async search(q, kind = 'songs') {
      const j = await call('search', { query: q, params: FILTER[kind] || FILTER.songs });
      const secs_ = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      return shelves(secs_).flatMap(s => s.items);
    },
    async home() {
      const j = await call('browse', { browseId: 'FEmusic_home' });
      return shelves(j?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents);
    },
    // an album, single, playlist or artist page
    async page(bid, params) {
      if (/^VL/.test(bid)) params = null;   // a playlist's "See all" link opens the whole playlist
      const j = await call('browse', params ? { browseId: bid, params } : { browseId: bid });
      const two_ = j?.contents?.twoColumnBrowseResultsRenderer;
      if (two_) {   // albums and playlists
        const top = two_.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        const h = top[0]?.musicResponsiveHeaderRenderer || top[0]?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicResponsiveHeaderRenderer || {};
        const strap = byline(runs(h.straplineTextOne));
        const sh = shelves(two_.secondaryContents?.sectionListRenderer?.contents);
        const list = sh.find(s => s.list) || { items: [] };
        const th = thumbOf(h.thumbnail, j.background);
        const album = /^MPRE/.test(bid);
        const tracks = list.items.filter(x => x.id).map(x => ({ ...x, a: x.a || strap.artists.join(', '), aid: x.aid || strap.aid, th: x.th || th, ...(album ? { al: txt(h.title), alid: bid } : {}) }));
        return { kind: album ? 'album' : 'playlist', bid, t: txt(h.title), sub: txt(h.subtitle), sub2: txt(h.secondSubtitle), artist: strap.artists.join(', ') || txt(h.straplineTextOne), aid: strap.aid,
          th, desc: txt(h.description?.musicDescriptionShelfRenderer?.description), tracks, cont: list.cont, shelves: sh.filter(s => s !== list) };
      }
      const one = j?.contents?.singleColumnBrowseResultsRenderer;
      const h = Object.values(j?.header || {})[0] || {};
      const sh = shelves(one?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || []);
      const grid = one?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.find(s => s.gridRenderer);
      return { kind: /^UC/.test(bid) ? 'artist' : 'more', bid, t: txt(h.title), sub: txt(h.monthlyListenerCount) || txt(h.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText),
        desc: txt(h.description), th: thumbOf(h.thumbnail, h.foregroundThumbnail), shelves: grid ? shelves([grid]) : sh,
        radio: h.startRadioButton?.buttonRenderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId || null };
    },
    // the rest of a long playlist
    async more(token) {
      const j = await call('browse', { continuation: token });
      const list = j?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
      return { tracks: items(list).filter(x => x.id), cont: contToken(list) };
    },
    // "Up next" for a song: YouTube Music's radio from it (endless play), plus where its lyrics are
    async next(videoId, playlistId) {
      const j = await call('next', { videoId, playlistId: playlistId || 'RDAMVM' + videoId, params: 'wAEB', isAudioOnly: true });
      const tabs = j?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
      const list = tabs[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];
      const lyr = tabs.map(t => t.tabRenderer?.endpoint?.browseEndpoint?.browseId).find(b => /^MPLY/.test(b || '')) || null;
      return { songs: list.map(panel).filter(Boolean), lyrics: lyr };
    },
    async lyrics(videoId) {
      const { lyrics } = await M.next(videoId);
      if (!lyrics) return null;
      const j = await call('browse', { browseId: lyrics });
      const find = o => { if (!o || typeof o !== 'object') return null; if (o.musicDescriptionShelfRenderer) return o.musicDescriptionShelfRenderer; for (const v of Object.values(o)) { const f = find(v); if (f) return f; } return null; };
      const d = find(j?.contents);
      const text = txt(d?.description);
      return text ? { text, source: txt(d.footer) } : null;
    },
    // find a song by name (Glasswave's "find it" tracks, or another copy of a song that won't play here)
    async resolve(q, d = 0, avoid = new Set()) {
      const list = (await M.search(q, 'songs')).filter(x => x.id && !avoid.has(x.id));
      if (!list.length) return null;
      if (!d) return list[0];
      const scored = list.slice(0, 8).map((x, i) => ({ x, s: Math.abs((x.d || d) - d) + i * 2 }));
      scored.sort((a, b) => a.s - b.s);
      return scored[0].x;
    }
  };
})();
