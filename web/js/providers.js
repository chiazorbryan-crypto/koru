// Koru sources. Each one turns a site's own JSON feed into the same shapes:
//   card    { provider, slug, title, cover, status, latest }
//   series  { provider, slug, id, title, cover, description, status, author, tags, url }
//   chapter { slug, name, number, date, locked, freeAt }
//   page    { url, w, h }
// Locked (paid) chapters are only shown as locked; Koru never tries to open them.
'use strict';
(function () {
  const enc = encodeURIComponent;
  const num = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const https = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  const lockedError = () => Object.assign(new Error('This chapter is locked on the site.'), { locked: true });

  const OMEGA = 'https://api.omegascans.org';
  const omega = {
    id: 'omega', name: 'Omega Scans', short: 'Omega', site: 'https://omegascans.org', hue: '#ff5f8f',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      const orderBy = sort === 'popular' ? 'total_views' : 'updated_at';
      const j = await K.api.site(`${OMEGA}/query?page=${page}&perPage=24&series_type=Comic&query_string=${enc(q)}&order=desc&orderBy=${orderBy}&adult=true&status=All&tags_ids=[]`);
      const items = (j?.data || []).map(d => ({
        provider: 'omega', slug: d.series_slug, title: d.title, cover: https(d.thumbnail), status: d.status,
        latest: d.free_chapters?.[0]?.chapter_name || d.paid_chapters?.[0]?.chapter_name || ''
      }));
      return { items, hasMore: (j?.meta?.current_page || 1) < (j?.meta?.last_page || 1) };
    },
    async series(slug) {
      const d = await K.api.site(`${OMEGA}/series/${enc(slug)}`);
      return {
        provider: 'omega', slug, id: d.id, title: d.title, cover: https(d.thumbnail), description: K.plainText(d.description),
        status: d.status, author: [d.author, d.studio].filter(Boolean).join(' · '), tags: (d.tags || []).map(t => t.name).filter(Boolean),
        alt: d.alternative_names || '', url: `${this.site}/series/${slug}`
      };
    },
    async chapters(series) {
      const out = [];
      for (let page = 1; page < 40; page++) {
        const j = await K.api.site(`${OMEGA}/chapter/query?page=${page}&perPage=500&series_id=${series.id}`);
        for (const c of j?.data || []) {
          const freeAt = c.free_at || null;
          out.push({ slug: c.chapter_slug, name: c.chapter_name + (c.chapter_title ? ' — ' + c.chapter_title : ''), number: num(c.chapter_name),
            date: c.created_at, locked: Number(c.price) > 0 && (!freeAt || Date.parse(freeAt) > Date.now()), freeAt });
        }
        if (!j?.meta || j.meta.current_page >= j.meta.last_page) break;
      }
      return out; // newest first
    },
    async pages(slug, chapterSlug) {
      const j = await K.api.site(`${OMEGA}/chapter/${enc(slug)}/${enc(chapterSlug)}`);
      if (j?.paywall) throw lockedError();
      const imgs = j?.chapter?.chapter_data?.images || [];
      return imgs.map(u => ({ url: https(typeof u === 'string' ? u : u?.src || u?.url) })).filter(p => p.url);
    },
    chapterUrl: (slug, ch) => `https://omegascans.org/series/${slug}/${ch}`
  };

  const VORTEX = 'https://api.vortexscans.org/api';
  const notNovel = p => p && p.isNovel !== true && String(p.seriesType || '').toUpperCase() !== 'NOVEL';
  const vortexCard = p => ({
    provider: 'vortex', slug: p.slug, title: p.postTitle, cover: https(p.featuredImage),
    status: String(p.seriesStatus || '').toLowerCase().replace(/^\w/, c => c.toUpperCase()),
    latest: p.chapters?.[0]?.number != null ? 'Chapter ' + p.chapters[0].number : ''
  });
  const vortex = {
    id: 'vortex', name: 'Vortex Scans', short: 'Vortex', site: 'https://vortexscans.org', hue: '#5fb8ff',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      let j;
      if (q) j = await K.api.site(`${VORTEX}/query?page=${page}&perPage=24&searchTerm=${enc(q)}`);
      else if (sort === 'popular') j = await K.api.site(`${VORTEX}/query?page=${page}&perPage=24&orderBy=totalViews&orderDirection=desc`);
      else j = await K.api.site(`${VORTEX}/posts?page=${page}&perPage=24`);
      const items = (j?.posts || []).filter(notNovel).map(vortexCard);
      return { items, hasMore: page * 24 < (j?.totalCount || 0) };
    },
    async series(slug) {
      const j = await K.api.site(`${VORTEX}/post?postSlug=${enc(slug)}`);
      const p = j?.post || {};
      return {
        provider: 'vortex', slug, id: p.id, title: p.postTitle, cover: https(p.featuredImage), description: K.plainText(p.postContent),
        status: String(p.seriesStatus || '').toLowerCase().replace(/^\w/, c => c.toUpperCase()),
        author: [p.author, p.artist].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · '),
        tags: (p.genres || []).map(g => String(g.name || '').trim()).filter(Boolean), alt: (p.alternativeTitles || '').trim(),
        url: `${this.site}/series/${slug}`
      };
    },
    async chapters(series) {
      const out = [];
      for (let skip = 0; skip < 20000; skip += 500) {
        const j = await K.api.site(`${VORTEX}/chapters?postId=${series.id}&skip=${skip}&take=500&order=desc`);
        const list = j?.post?.chapters || [];
        for (const c of list) {
          out.push({ slug: c.slug, name: 'Chapter ' + c.number + (c.title ? ' — ' + c.title : ''), number: Number(c.number),
            date: c.createdAt, locked: !!(c.isLocked || c.isPermanentlyLocked || c.isAccessible === false), freeAt: c.unlockAt || null });
        }
        if (list.length < 500) break;
      }
      return out;
    },
    async pages(slug, chapterSlug) {
      const j = await K.api.site(`${VORTEX}/chapter?mangaslug=${enc(slug)}&chapterslug=${enc(chapterSlug)}`);
      const c = j?.chapter;
      if (!c) throw new Error('Chapter not found.');
      if ((c.isLocked || c.isPermanentlyLocked) && !c.isAccessible) throw lockedError();
      const imgs = [...(c.images || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (!imgs.length && c.isAccessible === false) throw lockedError();
      return imgs.map(i => ({ url: https(i.url), w: i.width || null, h: i.height || null })).filter(p => p.url);
    },
    chapterUrl: (slug, ch) => `https://vortexscans.org/series/${slug}/${ch}`
  };

  // ---- Asura Scans: api.asurascans.com ----
  const ASURA = 'https://api.asurascans.com/api';
  const cap = s => String(s || '').toLowerCase().replace(/^\w/, c => c.toUpperCase());
  const asura = {
    id: 'asura', name: 'Asura Scans', short: 'Asura', site: 'https://asurascans.com', hue: '#b57bff',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      const j = await K.api.site(`${ASURA}/series?offset=${(page - 1) * 20}&limit=20${q ? '&search=' + enc(q) : sort === 'popular' ? '&sort=popular' : ''}`);
      const items = (j?.data || []).map(d => ({ provider: 'asura', slug: d.slug, title: d.title, cover: https(d.cover), status: cap(d.status),
        latest: d.latest_chapters?.[0]?.number != null ? 'Chapter ' + d.latest_chapters[0].number : (d.chapter_count ? d.chapter_count + ' chapters' : '') }));
      return { items, hasMore: !!j?.meta?.has_more };
    },
    async series(slug) {
      const s = (await K.api.site(`${ASURA}/series/${enc(slug)}`))?.series || {};
      return { provider: 'asura', slug, id: s.id, title: s.title, cover: https(s.cover), description: K.plainText(s.description), status: cap(s.status),
        author: [s.author, s.artist].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · '),
        tags: (s.genres || []).map(g => g?.name || g).filter(x => typeof x === 'string'), url: s.public_url || `https://asurascans.com/comics/${slug}` };
    },
    async chapters(series) {
      const j = await K.api.site(`${ASURA}/series/${enc(series.slug)}/chapters`);
      return (j?.data || []).map(c => {
        const early = c.early_access_until && Date.parse(c.early_access_until) > Date.now();
        return { slug: String(c.number), name: 'Chapter ' + c.number + (c.title ? ' — ' + c.title : ''), number: Number(c.number), date: c.published_at || c.created_at,
          locked: !!c.is_premium || !!early, freeAt: early ? c.early_access_until : null };
      });
    },
    async pages(slug, ch) {
      const d = (await K.api.site(`${ASURA}/series/${enc(slug)}/chapters/${enc(ch)}`))?.data;
      if (!d?.chapter) throw new Error('Chapter not found.');
      if (d.is_locked) throw lockedError();
      return (d.chapter.pages || []).map(p => ({ url: https(p.url), w: p.width || null, h: p.height || null })).filter(p => p.url);
    }
  };

  // ---- Flame Comics: flamecomics.xyz (data embedded in its pages) ----
  const FLAME = 'https://flamecomics.xyz', FCDN = 'https://cdn.flamecomics.xyz/uploads/images/series';
  const nextData = html => { const m = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/); if (!m) throw new Error("Flame's site isn't showing comics right now (it only shows a Discord page). Try again later."); return JSON.parse(m[1]).props?.pageProps || {}; };
  const flameCover = (id, file) => (id && file ? `${FCDN}/${id}/${file}` : null);
  const flame = {
    id: 'flame', name: 'Flame Comics', short: 'Flame', site: FLAME, hue: '#ff8a3d',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      if (q || sort === 'all') {
        const all = await K.cached('flame:all', 30 * 60e3, () => K.api.site(`${FLAME}/api/series`));
        const ql = q.toLowerCase();
        const hits = all.filter(s => !q || String(s.label).toLowerCase().includes(ql));
        const items = hits.slice((page - 1) * 24, page * 24).map(s => ({ provider: 'flame', slug: String(s.id), title: s.label, cover: flameCover(s.id, s.image), status: s.status, latest: s.chapter_count ? s.chapter_count + ' chapters' : '' }));
        return { items, hasMore: page * 24 < hits.length };
      }
      if (page > 1) return this.list({ sort: 'all', page: page - 1 });
      const pp = await K.cached('flame:home', 5 * 60e3, async () => nextData(await K.api.siteText(FLAME + '/')));
      const block = (sort === 'popular' ? pp.popularEntries : pp.latestEntries)?.blocks?.[0]?.series || [];
      const items = block.filter(s => s.series_id).map(s => ({ provider: 'flame', slug: String(s.series_id), title: s.title, cover: flameCover(s.series_id, s.cover), status: s.status,
        latest: s.chapters?.[0]?.chapter ? 'Chapter ' + Number(s.chapters[0].chapter) : '' }));
      return { items, hasMore: true };
    },
    async series(slug) {
      const pp = await K.cached('flame:s:' + slug, 5 * 60e3, async () => nextData(await K.api.siteText(`${FLAME}/series/${enc(slug)}`)));
      const s = pp.series || {};
      return { provider: 'flame', slug, id: s.series_id, title: s.title, cover: flameCover(s.series_id, s.cover), description: K.plainText(s.description), status: s.status,
        author: [s.author, s.artist].flat().filter(Boolean).join(' · '), tags: Array.isArray(s.tags) ? s.tags : [], url: `${FLAME}/series/${slug}`, _chapters: pp.chapters || [] };
    },
    async chapters(series) {
      let list = series._chapters;
      if (!list) list = nextData(await K.api.siteText(`${FLAME}/series/${enc(series.slug)}`)).chapters || [];
      return list.map(c => ({ slug: c.token, name: 'Chapter ' + Number(c.chapter) + (c.title ? ' — ' + c.title : ''), number: Number(c.chapter), date: (c.release_date || 0) * 1000, locked: false }))
        .sort((a, b) => b.number - a.number);
    },
    async pages(slug, token) {
      const c = nextData(await K.api.siteText(`${FLAME}/series/${enc(slug)}/${enc(token)}`)).chapter;
      if (!c) throw new Error('Chapter not found.');
      return Object.values(c.images || {}).map(i => ({ url: `${FCDN}/${c.series_id}/${c.token}/${encodeURIComponent(i.name)}`, w: i.width || null, h: i.height || null }));
    }
  };

  // ---- MangaDex: the official public API ----
  const MD = 'https://api.mangadex.org';
  const RATINGS = '&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica';
  const mdTitle = a => a?.title?.en || Object.values(a?.title || {})[0] || 'Untitled';
  const mdCover = m => { const f = m.relationships?.find(r => r.type === 'cover_art')?.attributes?.fileName; return f ? `https://uploads.mangadex.org/covers/${m.id}/${f}.512.jpg` : null; };
  const mangadex = {
    id: 'mangadex', name: 'MangaDex', short: 'MangaDex', site: 'https://mangadex.org', hue: '#ff6740',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      const order = q ? 'order[relevance]=desc' : sort === 'popular' ? 'order[followedCount]=desc' : 'order[latestUploadedChapter]=desc';
      const j = await K.api.site(`${MD}/manga?limit=24&offset=${(page - 1) * 24}&${order}&availableTranslatedLanguage[]=en&hasAvailableChapters=true&includes[]=cover_art${RATINGS}${q ? '&title=' + enc(q) : ''}`);
      const items = (j?.data || []).map(m => ({ provider: 'mangadex', slug: m.id, title: mdTitle(m.attributes), cover: mdCover(m), status: cap(m.attributes?.status), latest: m.attributes?.lastChapter ? 'Chapter ' + m.attributes.lastChapter : '' }));
      return { items, hasMore: (j?.offset || 0) + items.length < (j?.total || 0) };
    },
    async series(id) {
      const m = (await K.api.site(`${MD}/manga/${enc(id)}?includes[]=cover_art&includes[]=author&includes[]=artist`))?.data || {};
      const a = m.attributes || {};
      return { provider: 'mangadex', slug: id, id, title: mdTitle(a), cover: mdCover(m), description: a.description?.en || Object.values(a.description || {})[0] || '', status: cap(a.status),
        author: [...new Set((m.relationships || []).filter(r => r.type === 'author' || r.type === 'artist').map(r => r.attributes?.name).filter(Boolean))].join(' · '),
        tags: (a.tags || []).map(t => t.attributes?.name?.en).filter(Boolean), url: `https://mangadex.org/title/${id}` };
    },
    async chapters(series) {
      const out = [], seen = new Set();
      for (let offset = 0; offset < 5000; offset += 500) {
        const j = await K.api.site(`${MD}/manga/${enc(series.id)}/feed?translatedLanguage[]=en&limit=500&offset=${offset}&order[chapter]=desc&order[publishAt]=desc&includeExternalUrl=0${RATINGS}`);
        for (const c of j?.data || []) {
          const a = c.attributes || {};
          const key = a.chapter ?? c.id;
          if (seen.has(key) || !a.pages) continue; // one copy per chapter number
          seen.add(key);
          out.push({ slug: c.id, name: (a.chapter ? 'Chapter ' + a.chapter : 'Oneshot') + (a.title ? ' — ' + a.title : ''), number: a.chapter ? Number(a.chapter) : 0, date: a.publishAt, locked: false });
        }
        if (!j || offset + 500 >= (j.total || 0)) break;
      }
      return out;
    },
    async pages(seriesId, chapterId) {
      const j = await K.api.site(`${MD}/at-home/server/${enc(chapterId)}`);
      if (!j?.baseUrl || !j.chapter) throw new Error('MangaDex couldn\'t find a server for this chapter. Try again.');
      return j.chapter.data.map(f => ({ url: `${j.baseUrl}/data/${j.chapter.hash}/${f}` }));
    }
  };

  K.providers = { omega, vortex, asura, flame, mangadex };
  K.providerList = [omega, vortex, asura, flame, mangadex];
  // More sources live in src-*.js and register themselves here.
  K.addProvider = p => { if (!p?.id || K.providers[p.id]) return; K.providers[p.id] = p; K.providerList.push(p); };

  // Short-lived memory cache so moving between pages doesn't refetch everything.
  const cache = new Map();
  K.cached = async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  K.forget = key => cache.delete(key);
  K.getSeries = (provider, slug) => K.cached(`s:${provider}:${slug}`, 10 * 60e3, () => K.providers[provider].series(slug));
  K.getChapters = async (provider, slug, fresh) => {
    const key = `c:${provider}:${slug}`;
    if (fresh) K.forget(key);
    const s = await K.getSeries(provider, slug);
    return K.cached(key, 5 * 60e3, () => K.providers[provider].chapters(s));
  };
})();
