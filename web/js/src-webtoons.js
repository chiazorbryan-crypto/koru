// Koru sources: Webtoons (official, English) and Toonily. Same shapes as providers.js.
'use strict';
(function () {
  const enc = encodeURIComponent;
  const num = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const lockedError = () => Object.assign(new Error('This chapter is locked on the site.'), { locked: true });
  const parse = html => new DOMParser().parseFromString(String(html || ''), 'text/html');
  const txt = el => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const httpsAbs = u => { if (!u || typeof u !== 'string') return null; u = u.trim(); if (u.startsWith('//')) u = 'https:' + u; if (!/^https:\/\//.test(u)) return null; try { return encodeURI(decodeURI(u)); } catch { return u; } };
  const img = u => { const h = httpsAbs(u); return h ? K.viaKoru(h) : null; };

  // ---- Webtoons (www.webtoons.com, English). Free episodes only. ----
  // Series slug: "<title_no>~<genre path>~<name path>", e.g. "2154~action~omniscient-reader" (genre "canvas" = Canvas title).
  // Chapter slug: "<episode_no>~<episode path>", e.g. "309~episode-308".
  // The web (no account) only lists and serves free episodes: Daily Pass / Fast Pass episodes are not in the list at all
  // and their viewer page is a 404, which pages() reports as locked.
  const WT = 'https://www.webtoons.com/en';
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wtSlugFromHref = href => { const m = String(href || '').match(/webtoons\.com\/en\/([a-z0-9-]+)\/([^/?#]+)\/list\?title_no=(\d+)/i); return m ? `${m[3]}~${m[1]}~${m[2]}` : null; };
  const wtSplit = slug => { const [no, genre = 'x', name = 'x'] = String(slug).split('~'); return { no, genre, name, canvas: genre === 'canvas' }; };
  const wtCards = (html, status = '') => {
    const doc = parse(html), out = [], seen = new Set();
    for (const a of doc.querySelectorAll('a[href*="/list?title_no="]')) {
      const slug = wtSlugFromHref(a.getAttribute('href'));
      const title = txt(a.querySelector('.title, .subj'));
      if (!slug || !title || seen.has(slug)) continue;
      seen.add(slug);
      out.push({ provider: 'webtoons', slug, title, cover: img(a.querySelector('img')?.getAttribute('src')), status,
        latest: '' }); // list pages don't show the latest episode
    }
    return out;
  };
  const wtPage = (sort, day) => K.cached(`wt:${sort}:${day}`, 10 * 60e3, async () => wtCards(await K.api.siteText(`${WT}/originals/${day}?sortOrder=${sort}`), 'Ongoing'));
  const hasNextPage = (html, page) => new RegExp(`[?&]page=${page + 1}\\b`).test(html);
  const webtoons = {
    id: 'webtoons', name: 'WEBTOON', short: 'Webtoons', site: 'https://www.webtoons.com/en/', hue: '#00dc64',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      if (q) {
        const get = kind => K.api.siteText(`${WT}/search/${kind}?keyword=${enc(q)}&page=${page}`).catch(() => '');
        const [o, c] = await Promise.all([get('originals'), get('canvas')]);
        const seen = new Set();
        const items = [...wtCards(o), ...wtCards(c)].filter(i => !seen.has(i.slug) && seen.add(i.slug));
        return { items, hasMore: hasNextPage(o, page) || hasNextPage(c, page) };
      }
      const today = new Date().getDay();
      if (sort === 'popular') {
        // page 1: the site's cross-genre popularity ranking; then each weekday's originals by views, today first.
        const top = await K.cached('wt:rank', 10 * 60e3, async () => wtCards(await K.api.siteText(`${WT}/ranking/popular`)));
        if (page === 1) return { items: top, hasMore: true };
        const skip = new Set(top.map(i => i.slug));
        const items = (await wtPage('MANA', DAYS[(today - (page - 2) + 7) % 7])).filter(i => !skip.has(i.slug));
        return { items, hasMore: page < 8 };
      }
      // latest: pages 1-7 are the weekday schedules by last update (today, yesterday, ...); then completed originals, 60 a page.
      if (page <= 7) return { items: await wtPage('UPDATE', DAYS[(today - (page - 1) + 7) % 7]), hasMore: true };
      const done = await K.cached('wt:complete', 30 * 60e3, async () => wtCards(await K.api.siteText(`${WT}/originals/complete?sortOrder=UPDATE`), 'Completed'));
      const from = (page - 8) * 60;
      return { items: done.slice(from, from + 60), hasMore: from + 60 < done.length };
    },
    async series(slug) {
      const s = wtSplit(slug);
      const url = `${WT}/${s.genre}/${s.name}/list?title_no=${s.no}`;
      const doc = parse(await K.api.siteText(url));
      const meta = p => doc.querySelector(`meta[property="${p}"]`)?.getAttribute('content') || '';
      const info = doc.querySelector('.detail_header .info') || doc;
      const authorEl = info.querySelector('.author_area');
      if (authorEl) authorEl.querySelectorAll('button').forEach(b => b.remove());
      const day = txt(doc.querySelector('.day_info'));
      return {
        provider: 'webtoons', slug, id: s.no, title: txt(info.querySelector('.subj')) || meta('og:title'),
        cover: img(meta('og:image')), description: txt(doc.querySelector('p.summary')) || meta('og:description'),
        status: /complete/i.test(day) ? 'Completed' : 'Ongoing',
        author: txt(authorEl).replace(/\s*,\s*/g, ', ').replace(/\s*\.\.\.$/, ''),
        tags: [...info.querySelectorAll('.genre')].map(txt).filter(Boolean), url
      };
    },
    async chapters(series) {
      const s = wtSplit(series.slug);
      const out = [];
      let cursor = 0;
      for (let i = 0; i < 20; i++) {
        const j = await K.api.site(`https://m.webtoons.com/api/v1/${s.canvas ? 'canvas' : 'webtoon'}/${s.no}/episodes?pageSize=99999${cursor ? '&cursor=' + cursor : ''}`);
        const list = j?.result?.episodeList || [];
        for (const e of list) {
          const path = (String(e.viewerLink || '').match(/\/([^/]+)\/viewer\?/) || [])[1] || 'x';
          out.push({ slug: `${e.episodeNo}~${path}`, name: String(e.episodeTitle || 'Episode ' + e.episodeNo).trim(), number: Number(e.episodeNo),
            date: e.exposureDateMillis || null, locked: false, freeAt: null });
        }
        cursor = j?.result?.nextCursor;
        if (!cursor || !list.length) break;
      }
      return out.sort((a, b) => b.number - a.number);
    },
    async pages(slug, chapterSlug) {
      const s = wtSplit(slug);
      const [ep, path = 'x'] = String(chapterSlug).split('~');
      let html;
      try { html = await K.api.siteText(`${WT}/${s.genre}/${s.name}/${path}/viewer?title_no=${s.no}&episode_no=${enc(ep)}`); }
      catch (e) { if (/\b404\b/.test(e.message)) throw lockedError(); throw e; }
      const imgs = [...parse(html).querySelectorAll('#_imageList img._images, img._images')];
      const pages = imgs.map(i => ({ url: img(i.getAttribute('data-url')), w: Number(i.getAttribute('width')) || null, h: Math.round(Number(i.getAttribute('height'))) || null })).filter(p => p.url);
      if (!pages.length) throw lockedError();
      return pages;
    },
    chapterUrl: (slug, ch) => { const s = wtSplit(slug); const [ep, path = 'x'] = String(ch).split('~'); return `${WT}/${s.genre}/${s.name}/${path}/viewer?title_no=${s.no}&episode_no=${ep}`; }
  };

  // ---- Toonily (toonily.com, WordPress "Madara"). Chapter list and pages are in the plain HTML; no POST needed. ----
  // Without the site's "mature" cookie (Koru sends none) the site hides its adult-only titles from lists and search.
  const TL = 'https://toonily.com';
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const tlDate = s => {
    s = String(s || '').trim();
    let m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{2}|\d{4})$/);
    if (m && MON[m[1].toLowerCase()] != null) { const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]); return new Date(y, MON[m[1].toLowerCase()], Number(m[2])).toISOString(); }
    m = s.match(/(\d+)\s*(sec|min|hour|day|week|month|year)s?\s*ago/i);
    if (m) { const unit = { sec: 1e3, min: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()]; return Date.now() - Number(m[1]) * unit; }
    return null;
  };
  const tlSlug = href => (String(href || '').match(/toonily\.com\/serie\/([^/?#]+)\/?$/) || [])[1] || null;
  const tlCover = el => { if (!el) return null; const src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('src'); return img(src); };
  const tlTitle = el => { if (!el) return ''; const c = el.cloneNode(true); c.querySelectorAll('span').forEach(s => s.remove()); return txt(c); };
  const tlCards = html => {
    const doc = parse(html), out = [], seen = new Set();
    for (const it of doc.querySelectorAll('.page-item-detail')) {
      const a = it.querySelector('.post-title a') || it.querySelector('.item-thumb a');
      const slug = tlSlug(a?.getAttribute('href'));
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const badge = txt(it.querySelector('.manga-title-badges'));
      out.push({ provider: 'toonily', slug, title: txt(a) || a.getAttribute('title') || slug, cover: tlCover(it.querySelector('.item-thumb img')),
        status: /end|complete/i.test(badge) ? 'Completed' : '', latest: txt(it.querySelector('.chapter-item .chapter a')) });
    }
    return { items: out, hasMore: !!doc.querySelector('a.nextpostslink') };
  };
  const toonily = {
    id: 'toonily', name: 'Toonily', short: 'Toonily', site: TL, hue: '#2fd1c5',
    async list({ sort = 'latest', page = 1, q = '' } = {}) {
      const pg = page > 1 ? `page/${page}/` : '';
      if (q) return tlCards(await K.api.siteText(`${TL}/search/${q.trim().split(/\s+/).map(enc).join('-')}/${pg}`)); // the site joins words with "-"
      return tlCards(await K.api.siteText(`${TL}/webtoons/${pg}?m_orderby=${sort === 'popular' ? 'views' : 'latest'}`));
    },
    async series(slug) {
      const url = `${TL}/serie/${enc(slug)}/`;
      const doc = parse(await K.api.siteText(url));
      const field = name => {
        for (const el of doc.querySelectorAll('.post-content_item')) if (txt(el.querySelector('.summary-heading')).toLowerCase().startsWith(name)) return el.querySelector('.summary-content');
        return null;
      };
      const people = [...doc.querySelectorAll('.author-content a, .artist-content a')].map(txt).filter(Boolean);
      const chapters = [...doc.querySelectorAll('li.wp-manga-chapter')].map(li => {
        const a = li.querySelector('a');
        const ch = (String(a?.getAttribute('href') || '').match(/\/serie\/[^/]+\/([^/?#]+)\/?$/) || [])[1];
        if (!ch) return null;
        const name = txt(a);
        const dateEl = li.querySelector('.chapter-release-date');
        const rel = dateEl?.querySelector('a[title]')?.getAttribute('title');
        const locked = /premium|coin|lock/i.test(li.className);
        return { slug: ch, name: /^chapter/i.test(name) ? name.replace(/^chapter/i, 'Chapter') : name, number: num(name), date: tlDate(rel || txt(dateEl)), locked, freeAt: null };
      }).filter(Boolean);
      return {
        provider: 'toonily', slug, id: slug, title: tlTitle(doc.querySelector('.post-title h1')) || txt(doc.querySelector('title')),
        cover: tlCover(doc.querySelector('.summary_image img')) || img(doc.querySelector('meta[property="og:image"]')?.getAttribute('content')),
        description: txt(doc.querySelector('.summary__content, .description-summary')),
        status: txt(field('status')).replace(/^ongoing$/i, 'Ongoing').replace(/^completed?$/i, 'Completed'),
        author: [...new Set(people)].join(' · '),
        tags: [...doc.querySelectorAll('.genres-content a')].map(txt).filter(Boolean),
        alt: txt(field('alt')), url, _chapters: chapters
      };
    },
    async chapters(series) {
      return series._chapters || (await this.series(series.slug))._chapters; // the site lists newest first
    },
    async pages(slug, chapterSlug) {
      const doc = parse(await K.api.siteText(`${TL}/serie/${enc(slug)}/${enc(chapterSlug)}/`));
      const box = doc.querySelector('.reading-content');
      if (!box) throw lockedError();
      const pages = [...box.querySelectorAll('img')]
        .map(i => httpsAbs(i.getAttribute('data-src') || i.getAttribute('data-lazy-src') || i.getAttribute('src')))
        .filter(u => u && !/\/wp-content\/assets\//.test(u))
        .map(u => ({ url: K.viaKoru(u), w: null, h: null }));
      if (!pages.length) throw lockedError();
      return pages;
    },
    chapterUrl: (slug, ch) => `${TL}/serie/${slug}/${ch}/`
  };

  K.addProvider(webtoons);
  K.addProvider(toonily);
})();
