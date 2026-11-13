// Koru sources: Qi Scans (its own JSON API), Nyx Scans and Magus Manga (the same JSON platform as
// Vortex Scans / Hive Toons), MangaPill (a big manga library, plain HTML pages) and the WordPress "Madara"
// libraries MangaRead and ManhuaPlus.
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
  // site HTML is only read, never run; inline handlers (onload=…) are dropped first so Chromium doesn't flag them
  const parse = html => new DOMParser().parseFromString(String(html || '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''), 'text/html');
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

  // ---- WordPress "Madara" sites whose series page lists every chapter in the plain HTML (no POST needed):
  // MangaRead (mangaread.org) and ManhuaPlus (manhuaplus.com). Lists: <listPath>page/N/?m_orderby=latest|views,
  // search /page/N/?s=..&post_type=wp-manga, series <listPath><slug>/, chapter <listPath><slug>/<chapter>/. ----
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mdDate = s => {
    s = String(s || '').trim();
    let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/); // 02.11.2026 (day first)
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).toISOString();
    m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{2}|\d{4})$/);
    if (m && MON[m[1].toLowerCase()] != null) { const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(y, MON[m[1].toLowerCase()], Number(m[2])).toISOString(); }
    m = s.match(/(\d+)\s*(sec|min|hour|day|week|month|year)[a-z]*\s*ago/i);
    if (m) return new Date(Date.now() - Number(m[1]) * { sec: 1e3, min: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()]).toISOString();
    return null;
  };
  function madara({ id, name, short, site, hue, listPath = '/manga/' }) {
    const base = site + listPath;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slugRe = new RegExp('^' + esc(base) + '([^/?#]+)/?$'), chRe = new RegExp('^' + esc(base) + '[^/?#]+/([^/?#]+)/?$');
    const abs = u => { u = String(u || '').trim(); if (!u) return null; try { return https(new URL(u, site).href); } catch { return null; } };
    const imgOf = el => {
      if (!el) return null;
      const set = el.getAttribute('data-srcset') || el.getAttribute('srcset');
      const big = set ? set.split(',').map(s => s.trim().split(/\s+/)).sort((a, b) => parseInt(b[1]) - parseInt(a[1]))[0]?.[0] : null;
      return abs(big || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('src'));
    };
    const titleOf = a => { if (!a) return ''; const c = a.cloneNode(true); c.querySelectorAll('span').forEach(s => s.remove()); return txt(c); };
    const cards = html => {
      const doc = parse(html), out = [], seen = new Set();
      for (const it of doc.querySelectorAll('.page-item-detail, .c-tabs-item__content')) {
        const a = it.querySelector('.post-title a') || it.querySelector('.item-thumb a, .tab-thumb a');
        const slug = (String(a?.getAttribute('href') || '').match(slugRe) || [])[1];
        if (!slug || seen.has(slug) || /novel/i.test(it.className)) continue;
        const title = titleOf(a) || a.getAttribute('title') || '';
        if (!title) continue;
        seen.add(slug);
        const status = txt(it.querySelector('.mg_status .summary-content')) || (/end|complete/i.test(txt(it.querySelector('.manga-title-badges'))) ? 'Completed' : '');
        out.push({ provider: id, slug, title, cover: imgOf(it.querySelector('.item-thumb img, .tab-thumb img')), status: cap(status),
          latest: txt(it.querySelector('.chapter-item .chapter a, .latest-chap .chapter a')) });
      }
      const more = !!doc.querySelector('a.nextpostslink, .nav-previous a, a.next.page-numbers, #navigation-ajax');
      return { items: out, hasMore: more && out.length > 0 };
    };
    return {
      id, name, short, site, hue,
      async list({ sort = 'latest', page = 1, q = '' } = {}) {
        const pg = page > 1 ? `page/${page}/` : '';
        if (q) return cards(await K.api.siteText(`${site}/${pg}?s=${enc(q)}&post_type=wp-manga`));
        return cards(await K.api.siteText(`${base}${pg}?m_orderby=${sort === 'popular' ? 'views' : 'latest'}`));
      },
      async series(slug) {
        const url = `${base}${enc(slug)}/`;
        const doc = parse(await K.api.siteText(url));
        const field = label => {
          for (const el of doc.querySelectorAll('.post-content_item, .post-status .post-content_item')) if (txt(el.querySelector('.summary-heading')).toLowerCase().startsWith(label)) return el.querySelector('.summary-content');
          return null;
        };
        const chapters = [...doc.querySelectorAll('li.wp-manga-chapter')].map(li => {
          const a = li.querySelector('a[href]');
          const ch = (String(a?.getAttribute('href') || '').match(chRe) || [])[1];
          const label = txt(a);
          const locked = /premium|coin|lock/i.test(li.className) || !!li.querySelector('.coin, .premium-block, .fa-lock, .ion-locked');
          if (!ch && !locked) return null;
          const dateEl = li.querySelector('.chapter-release-date');
          const rel = dateEl?.querySelector('a[title]')?.getAttribute('title');
          return { slug: ch && !locked ? ch : 'locked-' + (num(label) ?? label), name: /^chapter/i.test(label) ? label.replace(/^chapter/i, 'Chapter') : label,
            number: num(label), date: mdDate(rel || txt(dateEl)), locked, freeAt: null };
        }).filter(Boolean);
        if (!doc.querySelector('.post-title h1, .post-title h3') && !chapters.length) throw new Error(`${name} doesn't have this series.`);
        const people = [...doc.querySelectorAll('.author-content a, .artist-content a')].map(txt).filter(Boolean);
        return {
          provider: id, slug, id: slug, title: titleOf(doc.querySelector('.post-title h1, .post-title h3')) || slug,
          cover: imgOf(doc.querySelector('.summary_image img')) || abs(doc.querySelector('meta[property="og:image"]')?.getAttribute('content')),
          description: txt(doc.querySelector('.summary__content, .description-summary .summary__content, .manga-excerpt')),
          status: cap(txt(field('status'))), author: uniq(people).join(' · '),
          tags: uniq([...doc.querySelectorAll('.genres-content a')].map(txt)), alt: txt(field('alt')), url, _chapters: chapters
        };
      },
      async chapters(series) {
        return series._chapters || (await this.series(series.slug))._chapters; // the site lists newest first
      },
      async pages(slug, ch) {
        if (String(ch).startsWith('locked-')) throw lockedError();
        const doc = parse(await K.api.siteText(`${base}${enc(slug)}/${enc(ch)}/`));
        const box = doc.querySelector('.reading-content');
        if (!box) throw lockedError();
        const pages = [...box.querySelectorAll('img')].map(imgOf).filter(u => u && !/\/wp-content\/(assets|themes|plugins)\//.test(u))
          .map(url => ({ url, w: null, h: null }));
        if (!pages.length) throw lockedError();
        return pages;
      },
      chapterUrl: (slug, ch) => `${base}${slug}/${ch}/`
    };
  }
  const mangaread = madara({ id: 'mangaread', name: 'MangaRead', short: 'MangaRead', site: 'https://www.mangaread.org', hue: '#7d4cdb' });
  const manhuaplus = madara({ id: 'manhuaplus', name: 'ManhuaPlus', short: 'ManhuaPlus', site: 'https://manhuaplus.com', hue: '#9c6b30' });

  for (const p of [qiscans, nyx, magus, mangapill, mangaread, manhuaplus]) K.addProvider(p);
})();
