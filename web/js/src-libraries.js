// Koru sources: big library sites (Weeb Central, MangaBuddy/Comizy, Manganato, Hive Toons).
// Same shapes as providers.js:
//   card    { provider, slug, title, cover, status, latest }
//   series  { provider, slug, id, title, cover, description, status, author, tags, url }
//   chapter { slug, name, number, date, locked, freeAt }
//   page    { url, w, h }
'use strict';
(function () {
  const enc = encodeURIComponent;
  const num = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const https = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  const cap = s => String(s || '').trim().toLowerCase().replace(/^\w/, c => c.toUpperCase());
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const doc = html => new DOMParser().parseFromString(html, 'text/html');
  const uniq = a => a.filter((v, i) => v && a.indexOf(v) === i);
  const lockedError = () => Object.assign(new Error('This chapter is locked on the site.'), { locked: true });

  // ---- Weeb Central (weebcentral.com): htmx HTML fragments. Series and chapters are ULIDs. ----
  const WC = 'https://weebcentral.com', WCOVER = 'https://temp.compsci88.com/cover';
  const wcId = href => (String(href || '').match(/\/series\/([0-9A-Z]{26})/) || [])[1] || null;
  const wcCover = (id, size = 'small') => (id ? `${WCOVER}/${size}/${id}.webp` : null);
  const weebcentral = {
    id: 'weebcentral', name: 'Weeb Central', short: 'WeebCentral', site: WC, hue: '#2ec4d6',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      if (!q && sort !== 'popular') {
        const d = doc(await K.api.siteText(`${WC}/latest-updates/${page}`));
        const seen = new Set(), items = [];
        for (const art of d.querySelectorAll('article')) {
          const id = wcId(art.querySelector('a[href*="/series/"]')?.getAttribute('href'));
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const icon = [...art.querySelectorAll('img[src*="/icon-"]')].map(i => (i.getAttribute('src').match(/icon-([a-z]+)\.svg/) || [])[1]).find(n => n === 'ongoing' || n === 'completed' || n === 'complete' || n === 'hiatus' || n === 'canceled');
          items.push({ provider: 'weebcentral', slug: id, title: art.getAttribute('data-tip') || txt(art.querySelector('.font-semibold')), cover: wcCover(id),
            status: icon ? cap(icon === 'completed' ? 'complete' : icon) : '', latest: txt(art.querySelector('a[href*="/chapters/"] span')) });
        }
        return { items, hasMore: !!d.querySelector(`[hx-get$="/latest-updates/${page + 1}"]`) };
      }
      const per = 32; // the site always returns 32 per call, whatever limit says
      const d = doc(await K.api.siteText(`${WC}/search/data?limit=${per}&offset=${(page - 1) * per}&sort=${q ? 'Best+Match' : 'Popularity'}&order=Descending&official=Any&anime=Any&adult=Any&display_mode=Minimal+Display${q ? '&text=' + enc(q) : ''}`));
      const items = [...d.querySelectorAll('article')].map(art => {
        const a = art.querySelector('a[href*="/series/"]'), id = wcId(a?.getAttribute('href'));
        const meta = [...art.querySelectorAll('section')][0];
        const bits = meta ? [...meta.querySelectorAll('div')].map(txt) : [];
        return id && { provider: 'weebcentral', slug: id, title: txt(art.querySelector('h2')) || a.getAttribute('data-tip'), cover: wcCover(id), status: bits[2] || '', latest: '' };
      }).filter(Boolean);
      return { items, hasMore: !!d.querySelector('button[hx-get*="/search/data"]') };
    },
    async series(slug) {
      const d = doc(await K.api.siteText(`${WC}/series/${enc(slug)}`));
      const field = label => [...d.querySelectorAll('li')].find(li => txt(li.querySelector('strong')).toLowerCase().startsWith(label));
      const links = li => (li ? [...li.querySelectorAll('a')].map(txt).filter(Boolean) : []);
      const type = txt(field('type')?.querySelector('a'));
      return {
        provider: 'weebcentral', slug, id: slug, title: txt(d.querySelector('h1')), cover: wcCover(slug, 'normal'),
        description: txt(d.querySelector('p.whitespace-pre-wrap')), status: txt(field('status')?.querySelector('a')),
        author: links(field('author')).join(' · '), tags: uniq([...links(field('tag')), type]),
        alt: field('associated') ? [...field('associated').querySelectorAll('li')].map(txt).join(', ') : '', url: `${WC}/series/${slug}`
      };
    },
    async chapters(series) {
      const d = doc(await K.api.siteText(`${WC}/series/${enc(series.slug)}/full-chapter-list`));
      return [...d.querySelectorAll('a[href*="/chapters/"]')].map(a => {
        const slug = (a.getAttribute('href').match(/\/chapters\/([0-9A-Z]+)/) || [])[1];
        const name = txt(a.querySelector('span.grow > span')) || txt(a.querySelector('span.grow'));
        return slug && { slug, name, number: num(name), date: a.querySelector('time')?.getAttribute('datetime') || null, locked: false };
      }).filter(Boolean); // newest first, as the site lists them
    },
    async pages(slug, ch) {
      const d = doc(await K.api.siteText(`${WC}/chapters/${enc(ch)}/images?is_prev=False&current_page=1&reading_style=long_strip`));
      const pages = [...d.querySelectorAll('img')].map(i => https(i.getAttribute('src'))).filter(u => u && !/broken_image/.test(u)).map(url => ({ url, w: null, h: null }));
      if (!pages.length) throw new Error('Weeb Central returned no pages for this chapter.');
      return pages;
    },
    chapterUrl: (slug, ch) => `${WC}/chapters/${ch}`
  };

  // ---- MangaBuddy: mangabuddy.com now redirects to comizy.io, which has a JSON API. ----
  // Page images (cmzcdn.org) refuse requests without the comizy.io Referer -> K.viaKoru.
  const CMZ = 'https://api.comizy.io', CMZSITE = 'https://comizy.io';
  const mbCard = t => ({ provider: 'mangabuddy', slug: t.slug, title: t.name, cover: https(t.cover), status: cap(t.status), latest: t.latest_chapters?.[0]?.name || '' });
  const mangabuddy = {
    id: 'mangabuddy', name: 'MangaBuddy (Comizy)', short: 'MangaBuddy', site: CMZSITE, hue: '#9be15d',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      const j = await K.api.site(`${CMZ}/titles/search?page=${page}&limit=24${q ? '&q=' + enc(q) : '&sort=' + (sort === 'popular' ? 'views' : 'latest')}`);
      const d = j?.data || {};
      return { items: (d.items || []).filter(t => t?.slug).map(mbCard), hasMore: !!d.pagination?.has_next };
    },
    async series(slug) {
      const t = (await K.api.site(`${CMZ}/titles/by-slug/${enc(slug)}?include=details`))?.data?.title;
      if (!t) throw new Error('Series not found.');
      return {
        provider: 'mangabuddy', slug, id: t.id, title: t.name, cover: https(t.cover), description: K.plainText(t.summary || ''), status: cap(t.status),
        author: uniq([...(t.authors || []), ...(t.artists || [])].map(a => a?.name)).join(' · '),
        tags: uniq([...(t.genres || []), ...(t.demographics || [])].map(g => g?.name)), alt: t.alt_name || '', url: `${CMZSITE}/${slug}`
      };
    },
    async chapters(series) {
      const j = await K.api.site(`${CMZ}/titles/${enc(series.id)}/chapters`);
      // c.number is the site's ordinal, not the chapter number, so parse the name.
      return (j?.data?.chapters || []).map(c => ({ slug: c.slug, name: c.name, number: num(c.name), date: c.updated_at || c.created_at || null, locked: false }));
    },
    async pages(slug, ch) {
      const c = (await K.api.site(`${CMZ}/titles/by-slug/${enc(slug)}/chapters/${enc(ch)}?include=details`))?.data?.chapter;
      if (!c) throw new Error('Chapter not found.');
      const list = c.pages?.length ? c.pages : (c.images || []).map(url => ({ url }));
      return list.map(p => ({ url: https(p.url) && K.viaKoru(p.url), w: p.width || null, h: p.height || null })).filter(p => p.url);
    },
    chapterUrl: (slug, ch) => `${CMZSITE}/${slug}/${ch}`
  };

  // ---- Manganato (Mangakakalot family). natomanga.com now redirects to manganami.com, whose
  // series/chapter pages sit behind a Cloudflare challenge; the sister mirror manganato.gg
  // serves them openly. Its search page is challenged too, so search uses the family's
  // kakamanga.com search endpoint (same catalogue and slugs). Images (2xstorage.com) need the
  // site Referer -> K.viaKoru for covers and pages.
  const NATO = 'https://www.manganato.gg', KAKA = 'https://www.kakamanga.com';
  const natoSlug = href => (String(href || '').match(/\/manga\/([^/?#"]+)/) || [])[1] || null;
  const via = u => (https(u) ? K.viaKoru(u) : null);
  const natomanga = {
    id: 'natomanga', name: 'Manganato', short: 'Nato', site: NATO, hue: '#ffcf4a',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      if (q) {
        if (page > 1) return { items: [], hasMore: false };
        const raw = await K.api.siteText(`${KAKA}/home/search/json?searchword=${enc(q)}`);
        let items;
        try {
          items = JSON.parse(raw).map(r => ({ provider: 'natomanga', slug: natoSlug(r.url), title: K.plainText(r.name), cover: via(r.thumb), status: '', latest: r.chapterLatest || '' }));
        } catch { // sometimes the endpoint answers with the full search-results page instead
          items = [...doc(raw).querySelectorAll('.story_item')].map(el => {
            const a = el.querySelector('.story_name a');
            return { provider: 'natomanga', slug: natoSlug(a?.getAttribute('href')), title: txt(a), cover: via(el.querySelector('img')?.getAttribute('src')), status: '', latest: txt(el.querySelector('.story_chapter a')) };
          });
        }
        return { items: items.filter(i => i.slug), hasMore: false };
      }
      const d = doc(await K.api.siteText(`${NATO}/manga-list/${sort === 'popular' ? 'hot-manga' : 'latest-manga'}?page=${page}`));
      const items = [...d.querySelectorAll('.list-comic-item-wrap')].map(el => {
        const a = el.querySelector('a.list-story-item') || el.querySelector('h3 a'), img = el.querySelector('img');
        return { provider: 'natomanga', slug: natoSlug(a?.getAttribute('href')), title: a?.getAttribute('title') || txt(el.querySelector('h3')),
          cover: via(img?.getAttribute('data-src') || img?.getAttribute('src')), status: '', latest: txt(el.querySelector('.list-story-item-wrap-chapter')) };
      }).filter(i => i.slug);
      const last = num(txt(d.querySelector('.page_last'))) || page;
      return { items, hasMore: page < last };
    },
    async series(slug) {
      const d = doc(await K.api.siteText(`${NATO}/manga/${enc(slug)}`));
      const info = [...d.querySelectorAll('.manga-info-text li')];
      const field = label => { const li = info.find(l => txt(l).toLowerCase().startsWith(label)); return li ? txt(li).replace(/^[^:]*:\s*/, '') : ''; };
      const box = d.querySelector('#contentBox');
      if (box) box.querySelectorAll('h2').forEach(h => h.remove());
      return {
        provider: 'natomanga', slug, id: slug, title: txt(d.querySelector('.manga-info-text h1')), cover: via(d.querySelector('.manga-info-pic img')?.getAttribute('src')),
        description: txt(box), status: field('status'), author: field('author').split(/\s*,\s*/).filter(Boolean).join(' · '),
        tags: [...d.querySelectorAll('.manga-info-text li.genres a')].map(txt).filter(Boolean), url: `${NATO}/manga/${slug}`
      };
    },
    async chapters(series) {
      const j = await K.api.site(`${NATO}/api/manga/${enc(series.slug)}/chapters?limit=-1`);
      return (j?.data?.chapters || []).map(c => ({ slug: c.chapter_slug, name: c.chapter_name, number: c.chapter_num != null ? Number(c.chapter_num) : num(c.chapter_name),
        date: c.updated_at || null, locked: false }));
    },
    async pages(slug, ch) {
      const html = await K.api.siteText(`${NATO}/manga/${enc(slug)}/${enc(ch)}`);
      const arr = name => { const m = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[^\\]]*\\])')); try { return m ? JSON.parse(m[1]) : []; } catch { return []; } };
      const cdn = String(arr('cdns')[0] || 'https://img-r1.2xstorage.com/').replace(/\/?$/, '/');
      const imgs = arr('chapterImages');
      if (!imgs.length) throw new Error('Manganato returned no pages for this chapter.');
      return imgs.map(p => ({ url: via(/^https:\/\//.test(p) ? p : cdn + String(p).replace(/^\//, '')), w: null, h: null })).filter(p => p.url);
    },
    chapterUrl: (slug, ch) => `${NATO}/manga/${slug}/${ch}`
  };

  // ---- Hive Toons (hivetoon.com -> hivetoons.org): same JSON platform as Vortex Scans. ----
  const HIVE = 'https://api.hivetoons.org/api', HIVESITE = 'https://hivetoons.org';
  const hiveNotNovel = p => p && p.isNovel !== true && String(p.seriesType || '').toUpperCase() !== 'NOVEL';
  const hiveCard = p => ({ provider: 'hivetoon', slug: p.slug, title: p.postTitle, cover: https(p.featuredImage), status: cap(p.seriesStatus),
    latest: p.chapters?.[0]?.number != null ? 'Chapter ' + p.chapters[0].number : '' });
  const hiveLocked = c => !!(c.isLocked || c.isPermanentlyLocked || c.isLockedByCoins || c.isShortLinkLocked || c.isAccessible === false);
  const hivetoon = {
    id: 'hivetoon', name: 'Hive Toons', short: 'Hive', site: HIVESITE, hue: '#e85cd9',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      let j;
      if (q) j = await K.api.site(`${HIVE}/query?page=${page}&perPage=24&searchTerm=${enc(q)}`);
      else if (sort === 'popular') j = await K.api.site(`${HIVE}/query?page=${page}&perPage=24&orderBy=totalViews&orderDirection=desc`);
      else j = await K.api.site(`${HIVE}/posts?page=${page}&perPage=24`);
      return { items: (j?.posts || []).filter(hiveNotNovel).map(hiveCard), hasMore: page * 24 < (j?.totalCount || 0) };
    },
    async series(slug) {
      const p = (await K.api.site(`${HIVE}/post?postSlug=${enc(slug)}`))?.post;
      if (!p) throw new Error('Series not found.');
      return {
        provider: 'hivetoon', slug, id: p.id, title: p.postTitle, cover: https(p.featuredImage), description: K.plainText(p.postContent || ''), status: cap(p.seriesStatus),
        author: uniq([p.author, p.artist, p.studio].map(s => String(s || '').trim())).join(' · '),
        tags: (p.genres || []).map(g => String(g.name || '').trim()).filter(Boolean), alt: String(p.alternativeTitles || '').trim(), url: `${HIVESITE}/series/${slug}`
      };
    },
    async chapters(series) {
      const out = [];
      for (let skip = 0; skip < 20000; skip += 500) {
        const list = (await K.api.site(`${HIVE}/chapters?postId=${series.id}&skip=${skip}&take=500&order=desc`))?.post?.chapters || [];
        for (const c of list) {
          out.push({ slug: c.slug, name: 'Chapter ' + c.number + (c.title ? ' — ' + c.title : ''), number: Number(c.number), date: c.createdAt,
            locked: hiveLocked(c), freeAt: c.unlockAt || null });
        }
        if (list.length < 500) break;
      }
      return out;
    },
    async pages(slug, ch) {
      const c = (await K.api.site(`${HIVE}/chapter?mangaslug=${enc(slug)}&chapterslug=${enc(ch)}`))?.chapter;
      if (!c) throw new Error('Chapter not found.');
      if (hiveLocked(c)) throw lockedError();
      const imgs = [...(c.images || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return imgs.map(i => ({ url: https(i.url), w: i.width || null, h: i.height || null })).filter(p => p.url);
    },
    chapterUrl: (slug, ch) => `${HIVESITE}/series/${slug}/${ch}`
  };

  for (const p of [weebcentral, mangabuddy, natomanga, hivetoon]) K.addProvider(p);
})();
