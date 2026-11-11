// Koru sources: Qi Scans (its own JSON API), Nyx Scans and Magus Manga (the same JSON platform as
// Vortex Scans / Hive Toons) and MangaPill (a big manga library, plain HTML pages).
// Same shapes as providers.js:
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
  const cap = s => String(s || '').trim().toLowerCase().replace(/^\w/, c => c.toUpperCase());
  const txt = el => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const parse = html => new DOMParser().parseFromString(String(html || ''), 'text/html');
  const uniq = a => a.filter((v, i) => v && a.indexOf(v) === i);
  const lockedError = () => Object.assign(new Error('This chapter is locked on the site.'), { locked: true });
  const future = t => !!t && Date.parse(t) > Date.now();

  // ---- Qi Scans (qiscans.org -> qimanga.com): api.qimanga.com ----
  // Lists: /api/v1/series?sort=latest|popular, search /api/v1/series/search?q=, chapters /api/v2/.../chapters (cursor, 100 a page),
  // pages /api/v1/series/<slug>/chapters/<chapter> (images are empty and requiresPurchase is set for paid chapters).
  const QI = 'https://api.qimanga.com/api', QISITE = 'https://qimanga.com';
  const qiNotNovel = d => d && String(d.type || '').toUpperCase() !== 'NOVEL';
  const qiLocked = c => !!c.requiresPurchase || (Number(c.price) > 0 && !c.isFree);
  const qiCard = d => ({ provider: 'qiscans', slug: d.slug, title: d.title, cover: https(d.cover), status: cap(d.status),
    latest: d.chapters?.[0]?.number != null ? 'Chapter ' + d.chapters[0].number : '' });
  const qiscans = {
    id: 'qiscans', name: 'Qi Scans', short: 'Qi', site: QISITE, hue: '#f5a623',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      const j = q ? await K.api.site(`${QI}/v1/series/search?q=${enc(q)}&page=${page}&perPage=24`)
        : sort === 'popular' ? await K.api.site(`${QI}/v1/series?sort=popular&page=${page}&perPage=24`)
          : await K.api.site(`${QI}/v1/home/latest?page=${page}&perPage=24`);
      return { items: (j?.data || []).filter(qiNotNovel).filter(d => d.slug && !d.redirectUrl).map(qiCard), hasMore: (j?.current || page) < (j?.totalPages || 0) };
    },
    async series(slug) {
      const d = await K.api.site(`${QI}/v1/series/${enc(slug)}`);
      if (!d?.slug) throw new Error('Series not found.');
      return {
        provider: 'qiscans', slug, id: d.id, title: d.title, cover: https(d.cover), description: K.plainText(d.description || ''), status: cap(d.status),
        author: uniq([d.author, d.artist].map(s => String(s || '').trim())).join(' · '),
        tags: uniq([...(d.genres || []).map(g => g?.name), cap(d.type)]), alt: String(d.alternativeTitles || '').trim(), url: `${QISITE}/series/${slug}`
      };
    },
    async chapters(series) {
      const out = [];
      let cursor = '';
      for (let i = 0; i < 60; i++) {
        const j = await K.api.site(`${QI}/v2/series/${enc(series.slug)}/chapters?limit=100${cursor ? '&cursor=' + enc(cursor) : ''}`);
        for (const c of j?.data || []) {
          if (c.publishStatus && c.publishStatus !== 'PUBLIC') continue;
          out.push({ slug: c.slug, name: 'Chapter ' + c.number + (c.title ? ' — ' + c.title : ''), number: Number(c.number), date: c.createdAt || null,
            locked: qiLocked(c), freeAt: null });
        }
        cursor = j?.nextCursor;
        if (!j?.hasMore || !cursor) break;
      }
      return out; // newest first
    },
    async pages(slug, ch) {
      const c = await K.api.site(`${QI}/v1/series/${enc(slug)}/chapters/${enc(ch)}`);
      if (!c?.slug) throw new Error('Chapter not found.');
      if (qiLocked(c)) throw lockedError();
      const imgs = [...(c.images || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (!imgs.length) throw new Error('Qi Scans returned no pages for this chapter.');
      return imgs.map(i => ({ url: https(i.url), w: i.width || null, h: i.height || null })).filter(p => p.url);
    },
    chapterUrl: (slug, ch) => `${QISITE}/series/${slug}/${ch}`
  };

  // ---- Vortex / Hive platform: api.<site>/api/{posts,query,post,chapters,chapter} ----
  function iken({ id, name, short, site, api, hue }) {
    const notNovel = p => p && p.isNovel !== true && String(p.seriesType || '').toUpperCase() !== 'NOVEL';
    const locked = c => !!(c.isLocked || c.isPermanentlyLocked || c.isLockedByCoins || c.isShortLinkLocked || c.isAccessible === false);
    const card = p => ({ provider: id, slug: p.slug, title: p.postTitle, cover: https(p.featuredImage), status: cap(p.seriesStatus),
      latest: p.chapters?.[0]?.number != null ? 'Chapter ' + p.chapters[0].number : '' });
    return {
      id, name, short, site, hue,
      async list({ sort = 'latest', page = 1, q = '' } = {}) {
        let j;
        if (q) j = await K.api.site(`${api}/query?page=${page}&perPage=24&searchTerm=${enc(q)}`);
        else if (sort === 'popular') j = await K.api.site(`${api}/query?page=${page}&perPage=24&orderBy=totalViews&orderDirection=desc`);
        else j = await K.api.site(`${api}/posts?page=${page}&perPage=24`);
        return { items: (j?.posts || []).filter(notNovel).map(card), hasMore: page * 24 < (j?.totalCount || 0) };
      },
      async series(slug) {
        const p = (await K.api.site(`${api}/post?postSlug=${enc(slug)}`))?.post;
        if (!p) throw new Error('Series not found.');
        return {
          provider: id, slug, id: p.id, title: p.postTitle, cover: https(p.featuredImage), description: K.plainText(p.postContent || ''), status: cap(p.seriesStatus),
          author: uniq([p.author, p.artist, p.studio].map(s => String(s || '').trim())).join(' · '),
          tags: (p.genres || []).map(g => String(g.name || '').trim()).filter(Boolean), alt: String(p.alternativeTitles || '').trim(), url: `${site}/series/${slug}`
        };
      },
      async chapters(series) {
        const out = [];
        for (let skip = 0; skip < 20000; skip += 500) {
          const list = (await K.api.site(`${api}/chapters?postId=${series.id}&skip=${skip}&take=500&order=desc`))?.post?.chapters || [];
          for (const c of list) {
            out.push({ slug: c.slug, name: 'Chapter ' + c.number + (c.title ? ' — ' + c.title : ''), number: Number(c.number), date: c.createdAt,
              locked: locked(c), freeAt: future(c.unlockAt) ? c.unlockAt : null });
          }
          if (list.length < 500) break;
        }
        return out;
      },
      async pages(slug, ch) {
        const c = (await K.api.site(`${api}/chapter?mangaslug=${enc(slug)}&chapterslug=${enc(ch)}`))?.chapter;
        if (!c) throw new Error('Chapter not found.');
        if (locked(c)) throw lockedError();
        const imgs = [...(c.images || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (!imgs.length) throw lockedError();
        return imgs.map(i => ({ url: https(i.url), w: i.width || null, h: i.height || null })).filter(p => p.url);
      },
      chapterUrl: (slug, ch) => `${site}/series/${slug}/${ch}`
    };
  }
  const nyx = iken({ id: 'nyx', name: 'Nyx Scans', short: 'Nyx', site: 'https://nyxscans.com', api: 'https://api.nyxscans.com/api', hue: '#6c7bff' });
  const magus = iken({ id: 'magus', name: 'Magus Manga', short: 'Magus', site: 'https://magustoon.org', api: 'https://api.magustoon.org/api', hue: '#ff9e9e' });

  // ---- MangaPill (mangapill.com): plain HTML. Manga only (the site removed its manhwa). ----
  // Series slug "<id>~<name>" (e.g. "580~blue-lock"), chapter slug "<id>~<name>" (e.g. "580-10368000~blue-lock-chapter-368").
  // Its image server (readdetectiveconan.com) only answers with the mangapill.com Referer -> K.viaKoru / the backend's REFERERS.
  const MP = 'https://mangapill.com';
  const mpSlug = href => { const m = String(href || '').match(/\/manga\/(\d+)\/([^/?#"]+)/); return m ? `${m[1]}~${m[2]}` : null; };
  const mpPath = slug => { const [a, b = 'x'] = String(slug).split('~'); return `${enc(a)}/${enc(b)}`; };
  const mpImg = el => { const u = https(el?.getAttribute('data-src') || el?.getAttribute('src')); return u ? K.viaKoru(u) : null; };
  // Cards on the search and home pages: <a class="relative block" href="/manga/..."><img data-src></a> + a title block next to it.
  const mpCards = doc => {
    const out = [], seen = new Set();
    for (const a of doc.querySelectorAll('a.relative[href^="/manga/"]')) {
      const slug = mpSlug(a.getAttribute('href'));
      if (!slug || seen.has(slug)) continue;
      const box = a.parentElement;
      const title = txt(box?.querySelector('.font-black')) || txt(box?.querySelector('a[href^="/manga/"]:not(.relative)'));
      if (!title) continue;
      seen.add(slug);
      const tags = [...(box.querySelectorAll('.flex-wrap div') || [])].map(txt);
      const status = tags.find(t => /^(publishing|finished|on hiatus|discontinued|not yet published)$/i.test(t)) || '';
      out.push({ provider: 'mangapill', slug, title, cover: mpImg(a.querySelector('img')), status: cap(status), latest: '' });
    }
    return out;
  };
  const mangapill = {
    id: 'mangapill', name: 'MangaPill', short: 'MangaPill', site: MP, hue: '#7fb3d5',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      if (q) {
        const html = await K.api.siteText(`${MP}/search?q=${enc(q)}&type=&status=&page=${page}`);
        return { items: mpCards(parse(html)), hasMore: new RegExp(`[?&;]page=${page + 1}\\b`).test(html) };
      }
      if (page > 1) return { items: [], hasMore: false };
      if (sort === 'popular') return { items: mpCards(parse(await K.api.siteText(MP + '/'))), hasMore: false }; // the home page's "Trending"
      // latest: the 120 newest chapters, one card per series
      const doc = parse(await K.api.siteText(`${MP}/chapters`));
      const out = [], seen = new Set();
      for (const a of doc.querySelectorAll('a[href^="/manga/"]')) {
        const slug = mpSlug(a.getAttribute('href'));
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const box = a.closest('div')?.parentElement;
        const chap = box?.querySelector('a[href^="/chapters/"] .font-black');
        out.push({ provider: 'mangapill', slug, title: txt(a), cover: mpImg(box?.querySelector('img')), status: '',
          latest: chap ? 'Chapter ' + txt(chap).replace(/^#/, '') : '' });
      }
      return { items: out, hasMore: false };
    },
    async series(slug) {
      const url = `${MP}/manga/${mpPath(slug)}`;
      const doc = parse(await K.api.siteText(url));
      const field = label => { for (const l of doc.querySelectorAll('label')) if (txt(l).toLowerCase() === label) return l.parentElement; return null; };
      const chapters = [...doc.querySelectorAll('#chapters a[href^="/chapters/"]')].map(a => {
        const m = String(a.getAttribute('href')).match(/^\/chapters\/([^/]+)\/([^/?#]+)/);
        if (!m) return null;
        const name = txt(a);
        return { slug: `${m[1]}~${m[2]}`, name, number: num(name), date: null, locked: false, freeAt: null };
      }).filter(Boolean);
      const h1 = doc.querySelector('h1');
      return {
        provider: 'mangapill', slug, id: slug.split('~')[0], title: txt(h1) || slug,
        cover: mpImg(doc.querySelector('img[data-src*="/mangapill/i/"]')),
        description: txt(h1?.parentElement?.parentElement?.querySelector('p.text--secondary, p.text-sm')),
        status: cap(txt(field('status')?.querySelector('div'))),
        author: '', tags: uniq([...(field('genres')?.querySelectorAll('a') || [])].map(txt).concat(cap(txt(field('type')?.querySelector('div'))))),
        url, _chapters: chapters
      };
    },
    async chapters(series) {
      return series._chapters || (await this.series(series.slug))._chapters; // newest first, as the site lists them
    },
    async pages(slug, ch) {
      const [a, b = 'x'] = String(ch).split('~');
      const doc = parse(await K.api.siteText(`${MP}/chapters/${enc(a)}/${enc(b)}`));
      const pages = [...doc.querySelectorAll('img.js-page')].map(i => ({ url: https(i.getAttribute('data-src') || i.getAttribute('src')),
        w: Number(i.getAttribute('width')) || null, h: Number(i.getAttribute('height')) || null })).filter(p => p.url);
      if (!pages.length) throw new Error('MangaPill returned no pages for this chapter.');
      return pages;
    },
    chapterUrl: (slug, ch) => { const [a, b = 'x'] = String(ch).split('~'); return `${MP}/chapters/${a}/${b}`; }
  };

  for (const p of [qiscans, nyx, magus, mangapill]) K.addProvider(p);
})();
