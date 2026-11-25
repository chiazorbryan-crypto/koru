// Sources you add yourself: Settings → Performance → Add a source. Paste a site's address, Koru works out which
// kind of site it is (the WordPress manga themes "MangaThemesia" or "Madara", which most scan sites run on), checks
// that its list, a series, its chapters and a chapter's pictures all open, and then adds it like any built-in source.
// Saved in settings (so it syncs to your other PCs); the backend only fetches from sites you've added (/k/sources/hosts).
'use strict';
(function () {
  const { el, icon } = K;
  const list = () => (K.data.settings.customSources ||= []);
  const host = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  // "img.cdn.site.com" -> "site.com" (keeps "site.co.uk")
  const domainOf = h => { const p = h.split('.'); return p.length > 2 && !/^(co|com|net|org|ac|gov)$/.test(p[p.length - 2]) ? p.slice(-2).join('.') : p.length > 3 ? p.slice(-3).join('.') : h; };
  const pushHosts = (extra = []) => K.api.post('/k/sources/hosts', { hosts: [...new Set([...list().flatMap(c => c.hosts || []), ...extra])] }).catch(() => {});
  const KIND = { themesia: 'MangaThemesia', madara: 'Madara' };
  const HUES = ['#8b5cf6', '#ef476f', '#06d6a0', '#ffd166', '#118ab2', '#f78c6b', '#c77dff', '#4cc9f0'];

  function make(c) {
    const f = K.srcKinds?.[c.kind];
    if (!f) return null;
    const p = f({ id: c.id, name: c.name, short: c.short || c.name.slice(0, 12), site: c.site, hue: c.hue, listPath: c.listPath });
    p.custom = true; p.site = c.site;
    return p;
  }
  function register(c) { if (K.providers[c.id]) return; const p = make(c); if (p) K.addProvider(p); }
  function unregister(id) { delete K.providers[id]; const i = K.providerList.findIndex(p => p.id === id); if (i >= 0) K.providerList.splice(i, 1); }
  // built-in sources you removed: not searched or listed any more (series already in your library still open)
  const hiddenIds = () => (K.data.settings.hiddenSources ||= []);
  const builtIns = new Map();   // id -> provider, so a removed one can come back
  function hideBuiltIn(id) { const p = K.providers[id]; if (!p) return; builtIns.set(id, p); const i = K.providerList.indexOf(p); if (i >= 0) K.providerList.splice(i, 1); }
  async function start() {
    for (const p of K.providerList) if (!p.custom) builtIns.set(p.id, p);
    for (const id of hiddenIds()) hideBuiltIn(id);
    await pushHosts(); for (const c of list()) { try { register(c); } catch {} }
  }
  function removeBuiltIn(id) { if (!hiddenIds().includes(id)) hiddenIds().push(id); K.save('settings'); hideBuiltIn(id); }
  function restoreBuiltIn(id) { K.data.settings.hiddenSources = hiddenIds().filter(x => x !== id); K.save('settings'); const p = builtIns.get(id); if (p && !K.providerList.includes(p)) K.providerList.push(p); }

  function siteOf(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try { const u = new URL(s); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null; return 'https://' + u.host; } catch { return null; }
  }

  // works out the site, then opens its list, a series, its chapters and one chapter's pictures
  async function check(input, step = () => {}) {
    const site = siteOf(input);
    if (!site) throw new Error('That isn\'t a website address. Paste something like https://example-scans.com');
    const h = host(site);
    if (list().some(c => host(c.site) === h)) throw new Error('You\'ve already added that site.');
    step('Opening the site…');
    await pushHosts([h, domainOf(h)]);
    let html;
    try { html = await K.api.siteText(site + '/'); } catch (e) { throw new Error('Couldn\'t open that site: ' + e.message); }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fromHost = h.replace(/^www\./, '').split('.')[0].replace(/[-_]+/g, ' ').replace(/(^|\s)\w/g, c => c.toUpperCase());
    const og = (doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '').split(/\s[|–—-]\s/)[0].trim();
    const name = (og && !/^(home|read online|manga|manhwa|webtoon)s?$/i.test(og) ? og : fromHost).slice(0, 40);
    const looksThem = /ts_reader|themesia|class="listupd|class="bsx/i.test(html), looksMad = /wp-manga|madara|c-tabs-item|manga-title-badges/i.test(html);
    // the folder series live in: the most common /<folder>/<slug>/ among the page's links to itself
    const count = {};
    for (const a of doc.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.getAttribute('href'), site);
        if (host(u.href) !== h) continue;
        const m = u.pathname.match(/^\/([a-z-]+)\/[^/]+\/?$/i);
        if (m && /^(manga|comics?|series|webtoons?|manhwa|manhua|read|title|novel)$/i.test(m[1])) count[m[1]] = (count[m[1]] || 0) + 1;
      } catch {}
    }
    const paths = [...new Set([...Object.entries(count).sort((a, b) => b[1] - a[1]).map(x => '/' + x[0] + '/'), '/manga/', '/comics/', '/series/', '/webtoon/', '/manhwa/'])].slice(0, 4);
    const kinds = looksMad && !looksThem ? ['madara', 'themesia'] : ['themesia', 'madara'];
    const id = 'u-' + h.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    let found = null;
    for (const kind of kinds) {
      for (const listPath of paths) {
        step(`Reading it as a ${KIND[kind]} site (${listPath})…`);
        const c = { id, kind, name, short: name.slice(0, 12), site, listPath, hue: HUES[[...h].reduce((a, ch) => a + ch.charCodeAt(0), 0) % HUES.length], hosts: [h, domainOf(h)] };
        try { const p = make(c), r = await p.list({ sort: 'latest', page: 1 }); if (r?.items?.length) { found = { c, p, items: r.items }; break; } } catch {}
      }
      if (found) break;
    }
    if (!found) throw new Error('Koru couldn\'t find a series list there. It reads WordPress manga sites (Madara or MangaThemesia), which most scan sites use; sites built another way need their own source.');
    const extra = found.items.map(x => host(x.cover || '')).filter(Boolean);
    step('Opening a series…');
    try {
      const s = await found.p.series(found.items[0].slug);
      found.series = s;
      const chs = (await found.p.chapters(s)) || [];
      found.chapters = chs.length;
      const ch = chs.find(x => !x.locked && !String(x.slug).startsWith('locked-'));
      if (ch) {
        step('Opening a chapter…');
        try { const pages = await found.p.pages(s.slug, ch.slug); found.pages = pages.length; extra.push(...pages.map(x => host(x.url)).filter(Boolean)); }
        catch (e) { found.pageErr = e.message; }
      }
    } catch (e) { found.seriesErr = e.message; }
    found.c.hosts = [...new Set([...found.c.hosts, ...extra.map(domainOf)])].slice(0, 12);
    return found;
  }
  async function add(found) {
    if (list().some(c => c.id === found.c.id)) return;
    list().push(found.c); K.save('settings');
    await pushHosts();
    register(found.c);
    K.emit?.('sources');
  }
  function remove(id) { K.data.settings.customSources = list().filter(c => c.id !== id); K.save('settings'); unregister(id); pushHosts(); K.emit?.('sources'); }

  // Settings → Performance: the "Add a source" card
  function panel(mk) {
    const input = el('input.txt', { type: 'text', placeholder: 'Paste a site, like https://example-scans.com', spellcheck: false, autocomplete: 'off' });
    const go = el('button.btn.primary', { type: 'button' }, icon('search'), 'Check');
    const out = el('div.cs-out'), mine = el('div.cs-list');
    // every source: the ones you added, the built-in ones, and built-in ones you removed (with Restore)
    const sure = (b, fn) => { if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Click again to remove'; setTimeout(() => { if (b.isConnected && b.classList.contains('sure')) { b.classList.remove('sure'); b.textContent = 'Remove'; } }, 4000); return; } fn(); };
    const row = (name, sub, hue, btn, off) => el('div.cs-row' + (off ? '.off' : ''), el('span.cs-dot', { style: { background: hue || '#888' } }), el('div.cs-txt', el('b', { text: name }), el('small', { text: sub })), btn);
    const paintMine = () => mine.replaceChildren(
      el('h4.cs-h', { text: 'Your sources' }),
      ...list().map(c => row(c.name, `Added by you · ${c.site.replace(/^https:\/\//, '')} · ${KIND[c.kind] || c.kind} site`, c.hue,
        el('button.btn.small', { type: 'button', title: 'Remove this source', onclick: e => sure(e.currentTarget, () => { remove(c.id); paintMine(); K.toast(`${c.name} removed`, 'ok'); }) }, 'Remove'))),
      ...[...builtIns.values()].map(p => { const off = hiddenIds().includes(p.id), name = p.name || p.id;
        return row(name, off ? 'Removed · not searched. Series already in your library still open.' : 'Built in', p.hue || p.color,
          off ? el('button.btn.small', { type: 'button', title: 'Bring this source back', onclick: () => { restoreBuiltIn(p.id); paintMine(); K.toast(`${name} is back`, 'ok'); } }, 'Restore')
            : el('button.btn.small', { type: 'button', title: 'Remove this source', onclick: e => sure(e.currentTarget, () => { removeBuiltIn(p.id); paintMine(); K.toast(`${name} removed`, 'ok'); }) }, 'Remove'), off); }));
    let busy = false;
    const run = async () => {
      if (busy) return; busy = true; go.disabled = true;
      const st = el('small.muted', { text: 'Starting…' });
      out.replaceChildren(el('div.cs-step', el('span.spin'), st));
      try {
        const f = await check(input.value, t => { st.textContent = t; });
        const ok = f.pages && !f.pageErr && !f.seriesErr;
        out.replaceChildren(el('div.cs-found',
          el('div.cs-head', el('span.cs-dot', { style: { background: f.c.hue } }), el('div', el('b', { text: f.c.name }), el('small.muted', { text: `${KIND[f.c.kind]} site · series in ${f.c.listPath}` }))),
          el('div.cs-covers', f.items.slice(0, 6).map(x => el('div.cs-cover', { title: x.title }, x.cover ? K.img(x.cover, '', '', 90) : null, el('span', { text: x.title })))),
          el('ul.cs-checks',
            el('li.ok', { text: `Series list: ${f.items.length} on the first page` }),
            el('li' + (f.series ? '.ok' : '.bad'), { text: f.series ? `A series opens: ${f.series.title}` : `A series didn't open: ${f.seriesErr || 'no answer'}` }),
            f.series ? el('li' + (f.chapters ? '.ok' : '.bad'), { text: f.chapters ? `${f.chapters} chapters listed` : 'No chapters found' }) : null,
            f.chapters ? el('li' + (f.pages ? '.ok' : '.bad'), { text: f.pages ? `A chapter opens: ${f.pages} pages` : `A chapter didn't open: ${f.pageErr || 'it may be locked'}` }) : null),
          el('div.row', el('button.btn.primary', { type: 'button', onclick: async () => { await add(f); out.replaceChildren(el('p.cs-done', icon('check'), `${f.c.name} added. Its series now show in Search, Explore and Discover.`)); input.value = ''; paintMine(); K.toast(`${f.c.name} added`, 'ok'); } },
            icon('plus'), ok ? 'Add source' : 'Add anyway'),
            ok ? null : el('small.muted', { text: 'Some checks failed, so parts of it may not work.' }))));
      } catch (e) { out.replaceChildren(el('p.cs-err', { text: e.message })); }
      busy = false; go.disabled = false;
    };
    go.onclick = run;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    paintMine();
    return mk('plus', 'Add or remove sources', 'Paste the address of a manga or manhwa site. Koru checks its list, a series, its chapters and a chapter\'s pictures, then adds it with all its series. Works with WordPress manga sites (Madara and MangaThemesia), which most scan sites use.',
      el('div.row', input, go), out, mine);
  }

  K.customSources = { start, check, add, remove, list, panel, removeBuiltIn, restoreBuiltIn };
})();
