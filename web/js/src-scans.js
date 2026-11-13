// Koru sources: WordPress "MangaThemesia" scan sites (Thunder, Madara, King of Shojo, Violet, Rokari, Lagoon)
// plus Drake Scans and Elf Toon (the same Next.js platform with a small JSON API).
// Shapes are the same as providers.js. Locked (coin) chapters are shown as locked and never opened.
'use strict';
(function () {
  const enc = encodeURIComponent;
  const num = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const https = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  const cap = s => String(s || '').toLowerCase().replace(/^\w/, c => c.toUpperCase());
  const lockedError = () => Object.assign(new Error('This chapter is locked on the site.'), { locked: true });
  const parse = html => new DOMParser().parseFromString(html, 'text/html');
  const text = el => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const isoDate = s => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
  // WordPress slugs can already be percent-encoded (e.g. "%e2%98%85title"); encode exactly once.
  const seg = s => { try { return enc(decodeURIComponent(s)); } catch { return enc(s); } };

  // ---- MangaThemesia (WordPress theme): HTML pages + ts_reader.run({...}) for chapter images ----
  function themesia({ id, name, short, site, hue, listPath }) {
    const seriesBase = site + listPath; // e.g. https://site/comics/
    const slugOf = href => { try { const p = new URL(href, site).pathname.replace(/^\/+|\/+$/g, '').split('/'); return p[p.length - 1] || null; } catch { return null; } };
    const imgSrc = img => {
      if (!img) return null;
      const u = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
      return https(u.trim());
    };
    const isNovel = (bs, title) => !!bs.querySelector('.novelabel') || /\bnovel\b/i.test(bs.querySelector('.type')?.className || '') || /\[novel\]/i.test(title);

    function cards(doc) {
      const out = [], seen = new Set();
      for (const bs of doc.querySelectorAll('.listupd .bs, .listupd .bsx')) {
        const a = bs.querySelector('a[href]');
        if (!a) continue;
        const slug = slugOf(a.getAttribute('href'));
        const title = (a.getAttribute('title') || text(bs.querySelector('.tt'))).trim();
        if (!slug || seen.has(slug) || !title || isNovel(bs, title)) continue;
        seen.add(slug);
        out.push({ provider: id, slug, title, cover: imgSrc(bs.querySelector('img')), status: text(bs.querySelector('.status i')) || text(bs.querySelector('.status')),
          latest: text(bs.querySelector('.epxs')) });
      }
      return out;
    }

    // Info rows: new layout uses <div class="imptdt"><h1>Author</h1><i>..</i></div>,
    // the classic one uses <table class="infotable"><tr><td>Author</td><td>..</td></tr> or "Status <i>..</i>".
    function info(doc) {
      const m = {};
      for (const tr of doc.querySelectorAll('.infotable tr')) {
        const td = tr.querySelectorAll('td');
        if (td.length >= 2) m[text(td[0]).toLowerCase()] = text(td[1]);
      }
      for (const d of doc.querySelectorAll('.tsinfo .imptdt, .info-content .imptdt, .imptdt')) {
        const v = text(d.querySelector('i, a'));
        const label = (text(d.querySelector('h1, b')) || text(d).replace(v, '')).toLowerCase().trim();
        if (label && v && !(label in m)) m[label] = v;
      }
      return m;
    }

    function chapterList(doc) {
      const out = [];
      for (const li of doc.querySelectorAll('#chapterlist li')) {
        const a = li.querySelector('a');
        const href = a?.getAttribute('href') || '';
        const coin = Number(a?.getAttribute('data-coin') || 0);
        const locked = !/^https?:\/\//.test(href) || coin > 0 || /lockedChapterModal/i.test(a?.getAttribute('data-bs-target') || '');
        const label = text(li.querySelector('.chapternum')) || a?.getAttribute('data-title') || ('Chapter ' + (li.getAttribute('data-num') || ''));
        const number = num(li.getAttribute('data-num')) ?? num(label);
        let slug;
        if (locked) slug = 'locked-' + (a?.getAttribute('data-id') || number || out.length);
        else { try { slug = new URL(href).pathname.replace(/^\/+|\/+$/g, ''); } catch { slug = null; } }
        if (!slug) continue;
        out.push({ slug, name: label.replace(/\s+/g, ' ').trim(), number, date: isoDate(text(li.querySelector('.chapterdate'))), locked, freeAt: null });
      }
      return out; // the site lists newest first
    }

    function readerImages(html) {
      const tryRun = src => {
        const m = String(src).match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
        if (!m) return null;
        try { return JSON.parse(m[1]); } catch { return null; }
      };
      let data = tryRun(html);
      if (!data) { // some installs ship the reader script base64-encoded
        for (const m of String(html).matchAll(/src="data:text\/javascript;base64,([A-Za-z0-9+/=]+)"/g)) {
          try { data = tryRun(atob(m[1])); } catch { /* not it */ }
          if (data) break;
        }
      }
      if (data) {
        const src = (data.sources || []).find(s => s?.images?.length) || {};
        return (src.images || []).map(u => https(String(u).trim())).filter(Boolean);
      }
      const doc = parse(html); // last resort: plain <img> tags in the reader area
      return [...doc.querySelectorAll('#readerarea img')].map(imgSrc).filter(Boolean);
    }

    // A series that moved to a new slug (Thunder puts a renumberable id in front, e.g. "0086250808-title"):
    // search the site for the title part and take the one clear match. Only runs after the old page is gone.
    const bare = s => { let d = String(s || ''); try { d = decodeURIComponent(d); } catch { /* keep */ } return d.toLowerCase().replace(/^\d{8,}-(?=.)/, ''); };
    const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    async function findMoved(p, slug) {
      const b = bare(slug), q = words(b);
      if (!q) return null;
      const tries = [q];
      const short = q.split(' ').slice(0, 4).join(' ');
      if (short !== q) tries.push(short);
      for (const t of tries) {
        let items;
        try { items = (await p.list({ q: t })).items; } catch { continue; }
        const hits = items.filter(i => i.slug !== slug && (bare(i.slug) === b || words(i.title) === q));
        if (hits.length === 1) return hits[0].slug;
        if (hits.length > 1) return null; // not a clear match
      }
      return null;
    }
    const gone = doc => !doc.querySelector('h1.entry-title') && !doc.querySelector('#chapterlist li');
    const dec = s => { try { return decodeURIComponent(s).toLowerCase(); } catch { return String(s).toLowerCase(); } };
    // The series slug from <link rel="canonical"> (only a plain `${listPath}<slug>/` address on this site counts).
    const canonSlug = doc => {
      const href = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || doc.querySelector('meta[property="og:url"]')?.getAttribute('content');
      try {
        const u = new URL(href, site);
        if (u.hostname !== new URL(site).hostname) return null;
        const m = u.pathname.match(/^(\/[^/]+\/)([^/]+)\/?$/);
        return m && m[1] === listPath ? m[2] : null;
      } catch { return null; }
    };

    return {
      id, name, short, site, hue,
      async list({ sort = 'latest', page = 1, q = '' } = {}) {
        const url = q
          ? `${site}${page > 1 ? `/page/${page}` : ''}/?s=${enc(q)}`
          : `${seriesBase}?page=${page}&order=${sort === 'popular' ? 'popular' : 'update'}`;
        const doc = parse(await K.api.siteText(url));
        return { items: cards(doc), hasMore: !!doc.querySelector('.pagination .next, .hpage .r, a.next.page-numbers') };
      },
      // If the slug moved, the returned series has the new slug (K.getSeries then updates saved entries).
      async series(slug) {
        let doc = null, err = null;
        try { doc = parse(await K.api.siteText(`${seriesBase}${seg(slug)}/`)); } catch (e) { if (!/\b(404|410)\b/.test(e.message)) throw e; err = e; }
        if (!doc || gone(doc)) {
          const moved = await findMoved(this, slug);
          if (moved) { slug = moved; doc = parse(await K.api.siteText(`${seriesBase}${seg(slug)}/`)); }
          else if (err) throw Object.assign(new Error(`${name} doesn't have this series any more.`), { status: 404 });
        } else {
          // The old address can still answer (WordPress follows renamed slugs); the page's canonical link has the current one.
          const c = canonSlug(doc);
          if (c && dec(c) !== dec(slug)) slug = c;
        }
        const m = info(doc);
        const desc = doc.querySelector('.entry-content[itemprop="description"], [itemprop="description"]');
        const tags = [...doc.querySelectorAll('.mgen a, .seriestugenre a, .genxed a')].map(text).filter(Boolean);
        const status = m.status || text(doc.querySelector('.status i')) || '';
        return {
          provider: id, slug, id: slug, title: text(doc.querySelector('h1.entry-title')) || slug,
          cover: imgSrc(doc.querySelector('.thumb img, .thumbook img')), description: desc ? K.plainText(desc.innerHTML) : '',
          status: cap(status), author: [m.author, m.artist].filter(v => v && !/^(n\/a|-|_|updating)$/i.test(v)).filter((v, i, a) => a.indexOf(v) === i).join(' · '),
          tags: [...new Set(tags)], url: `${seriesBase}${slug}/`, _chapters: chapterList(doc)
        };
      },
      async chapters(series) {
        return series._chapters || (await this.series(series.slug))._chapters; // series() also follows a moved slug
      },
      async pages(slug, chapterSlug) {
        if (String(chapterSlug).startsWith('locked-')) throw lockedError();
        if (!/^[\w\-.%/]+$/.test(chapterSlug)) throw new Error('Chapter not found.');
        const html = await K.api.siteText(`${site}/${chapterSlug}/`);
        const imgs = readerImages(html);
        if (!imgs.length) {
          if (/lockedChapterModal|data-coin=/i.test(html) && !/ts_reader\.run/.test(html)) throw lockedError();
          throw new Error('No pages found for this chapter.');
        }
        return imgs.map(url => ({ url, w: null, h: null }));
      },
      chapterUrl: (slug, ch) => `${site}/${ch}/`
    };
  }

  const thunder = themesia({ id: 'thunder', name: 'Thunder Scans', short: 'Thunder', site: 'https://en-thunderscans.com', hue: '#ffd84d', listPath: '/comics/' });
  const madarascans = themesia({ id: 'madarascans', name: 'Madara Scans', short: 'Madara', site: 'https://madarascans.net', hue: '#ff3b4f', listPath: '/series/' });
  const kingofshojo = themesia({ id: 'kingofshojo', name: 'King of Shojo', short: 'KoShojo', site: 'https://kingofshojo.com', hue: '#2ec4b6', listPath: '/manga/' });
  const violet = themesia({ id: 'violet', name: 'Violet Scans', short: 'Violet', site: 'https://violetmanga.com', hue: '#e05cff', listPath: '/comics/' });
  const rokari = themesia({ id: 'rokari', name: 'Rokari Comics', short: 'Rokari', site: 'https://rokaricomics.com', hue: '#c7a46b', listPath: '/manga/' });
  const lagoon = themesia({ id: 'lagoon', name: 'Lagoon Scans', short: 'Lagoon', site: 'https://lagoonscans.com', hue: '#0f7bbf', listPath: '/manga/' });

  // ---- Drake Scans platform (Next.js): drakecomic.net, and Elf Toon (elftoon.net) which runs the same software.
  // List/search via /api/series, series + chapter list from the series page's embedded data,
  // pages via /api/chapters/next (plain GET JSON). ----
  // Next.js streams page data as self.__next_f.push([1,"..."]) string chunks; join them back up.
  const rscText = html => {
    let out = '';
    for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) { try { out += JSON.parse(m[1]); } catch { /* skip */ } }
    return out;
  };
  // Parse the JSON object/array that starts at s[i] ('{' or '[').
  const balanced = (s, i, name) => {
    let depth = 0, inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) return JSON.parse(s.slice(i, j + 1)); }
    }
    throw new Error(name + ' page data was cut short.');
  };
  const drakeName = c => {
    const n = Number(c.number), t = String(c.title || '').trim();
    return 'Chapter ' + n + (t && !/^(chapter\s*)?[\d.]+$/i.test(t) ? ' — ' + t : '');
  };
  const drakeChapter = c => {
    const early = c.earlyAccessUntil && Date.parse(c.earlyAccessUntil) > Date.now();
    const locked = !!c.isLocked || c.hasAccess === false || !!early || Number(c.coinPrice) > 0;
    return { slug: String(c.number), name: drakeName(c), number: Number(c.number), date: c.publishedAt || null, locked,
      freeAt: locked ? (c.freeAt || c.becomesFreeAt || (early ? c.earlyAccessUntil : null)) : null };
  };
  function drakePlatform({ id, name, short, site, hue }) {
    const abs = u => (typeof u === 'string' && u ? (u.startsWith('/') ? site + u : https(u)) : null);
    const ids = new Map(); // series slug -> internal id (needed for the pages call)
    const props = html => {
      const s = rscText(html);
      const i = s.indexOf('{"series":{"id"');
      if (i < 0) throw new Error(name + ' didn\'t return this series.');
      return balanced(s, i, name);
    };
    return {
      id, name, short, site, hue,
      async list({ sort = 'latest', page = 1, q = '' } = {}) {
        const j = await K.api.site(`${site}/api/series?page=${page}${q ? '&q=' + enc(q) : sort === 'popular' ? '&sort=popular' : ''}`);
        const items = (j?.data || []).filter(d => String(d.type).toUpperCase() !== 'NOVEL').map(d => {
          const slug = d.urlSlug || d.slug;
          if (d.id) ids.set(slug, d.id);
          return { provider: id, slug, title: d.title, cover: abs(d.coverImage), status: cap(d.status),
            latest: d.chapters?.[0]?.number != null ? 'Chapter ' + d.chapters[0].number : '' };
        });
        return { items, hasMore: !!j?.meta?.hasMore };
      },
      async series(slug) {
        const p = props(await K.api.siteText(`${site}/series/comic/${enc(slug)}?sort=desc`));
        const s = p.series || {};
        if (s.id) ids.set(slug, s.id);
        return {
          provider: id, slug, id: s.id, title: s.title, cover: abs(s.coverImage), description: K.plainText(s.description || ''),
          status: cap(s.status), author: s.team?.name || '', tags: [...(s.genres || []), ...(s.tags || [])].map(g => g?.name).filter(Boolean),
          alt: s.altTitle || '', url: `${site}/series/comic/${slug}`, nsfw: !!s.nsfw,
          _chapters: (p.chapters || []).map(drakeChapter), _pages: Number(p.totalPages) || 1, _desc: p.sortOrder === 'desc'
        };
      },
      async chapters(series) {
        let first = series._chapters, total = series._pages, desc = series._desc;
        if (!first) { const s = await this.series(series.slug); first = s._chapters; total = s._pages; desc = s._desc; }
        const out = [...first];
        for (let page = 2; page <= Math.min(total, 40); page++) {
          const p = props(await K.api.siteText(`${site}/series/comic/${enc(series.slug)}?sort=desc&page=${page}`));
          out.push(...(p.chapters || []).map(drakeChapter));
        }
        const seen = new Set();
        const list = out.filter(c => !seen.has(c.slug) && seen.add(c.slug));
        return desc ? list : list.sort((a, b) => b.number - a.number);
      },
      async pages(slug, chapterSlug) {
        const n = Number(chapterSlug);
        if (!Number.isFinite(n)) throw new Error('Chapter not found.');
        const sid = ids.get(slug) || (await this.series(slug)).id;
        const j = await K.api.site(`${site}/api/chapters/next?seriesId=${enc(sid)}&afterNumber=${(n - 0.001).toFixed(4)}&limit=1`);
        const c = j?.chapters?.[0];
        if (!c || Math.abs(Number(c.number) - n) > 1e-6) throw new Error('Chapter not found.');
        if (!c.hasAccess || c.earlyAccessLocked || (c.isLocked && Number(c.effectivePrice ?? c.coinPrice) > 0)) throw lockedError();
        const pages = (c.pages || []).filter(pg => pg.kind !== 'AD');
        if (pages.some(pg => pg.isRedacted)) throw lockedError();
        // Some free chapters are served as encrypted/scrambled tiles. Koru doesn't undo that protection.
        if (c.protection?.isProtected || pages.some(pg => pg.isEncrypted || pg.hasFragments || pg.hasStrips || (pg.tiles || []).length))
          throw new Error(`${name} protects this chapter's images (scrambled tiles), so Koru can't show it. Read it on ${new URL(site).hostname}.`);
        return pages.map(pg => ({ url: abs(pg.imageUrl), w: pg.width || null, h: pg.height || null })).filter(pg => pg.url);
      },
      chapterUrl: (slug, ch) => `${site}/series/comic/${slug}/chapter/${ch}`
    };
  }
  const drake = drakePlatform({ id: 'drake', name: 'Drake Scans', short: 'Drake', site: 'https://drakecomic.net', hue: '#8bd450' });
  const elftoon = drakePlatform({ id: 'elftoon', name: 'Elf Toon', short: 'Elf', site: 'https://elftoon.net', hue: '#d7f75b' });

  for (const p of [thunder, madarascans, kingofshojo, violet, rokari, lagoon, drake, elftoon]) K.addProvider(p);
})();
