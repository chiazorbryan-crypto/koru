// Quick jump (Ctrl+K): a search box that pops up anywhere. Type a series, a page or a setting and press Enter.
// Built only when opened, and nothing runs in the background.
'use strict';
(function () {
  const { el, icon } = K;
  let box = null;

  const PAGES = [
    ['Library', '/library', 'library'], ['Explore', '/explore', 'explore'], ['Search', '/search', 'search'],
    ['Downloads', '/downloads', 'download'], ['Stats', '/stats', 'chart'], ['Chat', '/chat', 'chat'], ['Settings', '/settings', 'settings'],
    ['Koru Wrapped', '/wrapped', 'sparkle']
  ];
  const readLink = h => `/read/${h.provider}/${encodeURIComponent(h.slug)}/${encodeURIComponent(h.chapterSlug)}${h.page ? '?page=' + h.page + '&off=' + (h.off || 0) : ''}`;

  function items() {
    const out = [];
    const hist = Object.values(K.data.history || {}).filter(h => h?.provider && h.slug && h.chapterSlug).sort((a, b) => (b.at || 0) - (a.at || 0));
    for (const h of hist.slice(0, 30)) out.push({ kind: 'Continue', title: h.title || h.slug, sub: h.chapterName || '', cover: h.cover, ic: 'play', go: () => K.go(readLink(h)) });
    for (const s of Object.values(K.data.library || {})) {
      if (!s?.provider || !s.slug) continue;
      out.push({ kind: 'Favourite', title: s.title || s.slug, sub: K.providers?.[s.provider]?.name || s.provider, cover: s.cover, ic: 'heart', go: () => K.go(`/series/${s.provider}/${encodeURIComponent(s.slug)}`) });
    }
    for (const [t, h, ic] of PAGES) out.push({ kind: 'Go to', title: t, ic, go: () => K.go(h) });
    out.push({ kind: 'Do', title: K.incognito?.() ? 'Turn incognito off' : 'Turn incognito on', ic: 'incognito', go: () => document.querySelector('.side-inc')?.click() });
    out.push({ kind: 'Do', title: 'Check for updates', ic: 'refresh', go: () => K.go('/settings') });
    return out;
  }

  // simple fuzzy score: every typed letter in order, bonus for word starts and closeness
  function score(text, q) {
    const t = text.toLowerCase();
    if (!q) return 1;
    const at = t.indexOf(q);
    if (at >= 0) return 1000 - at * 2 - (t.length - q.length) * 0.1 + (at === 0 || t[at - 1] === ' ' ? 200 : 0);
    let i = 0, s = 0, last = -1;
    for (const ch of q) {
      const j = t.indexOf(ch, i);
      if (j < 0) return 0;
      s += j === last + 1 ? 6 : 1; if (j === 0 || t[j - 1] === ' ') s += 4;
      last = j; i = j + 1;
    }
    return s;
  }

  function open() {
    if (box) { box.querySelector('input').focus(); return; }
    const all = items();
    const input = el('input.txt', { type: 'text', placeholder: 'Jump to a series, a page or a setting…', spellcheck: false, autocomplete: 'off' });
    const list = el('div.pal-list');
    box = el('div.pal-wrap', { onclick: e => { if (e.target === box) close(); } }, el('div.pal.glass', el('div.pal-in', icon('search'), input, el('kbd', { text: 'Esc' })), list));
    let shown = [], cur = 0;
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map(x => ({ x, s: score(x.title + ' ' + (x.sub || ''), q) })).filter(r => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map(r => r.x);
      if (q.length >= 2 && K.kitsu) shown.push({ kind: 'Kitsu', title: `Ask Kitsu: "${input.value.trim()}"`, ic: 'fox', go: () => K.kitsu.ask(input.value.trim()) });
      if (q.length >= 2) shown.push({ kind: 'Search', title: `Search every source for "${input.value.trim()}"`, ic: 'search', go: () => K.go('/search?q=' + encodeURIComponent(input.value.trim())) });
      cur = Math.min(cur, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((x, i) => el('button.pal-item' + (i === cur ? '.on' : ''), { onmouseenter: () => { cur = i; mark(); }, onclick: () => pick(i) },
        x.cover ? el('img', { src: x.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span.pal-ic', icon(x.ic || 'dot')),
        el('span.pal-t', el('b', { text: x.title }), x.sub ? el('small', { text: x.sub }) : null),
        el('small.pal-k', { text: x.kind }))));
      if (!shown.length) list.append(el('div.pal-none', { text: 'Nothing matches' }));
    };
    const mark = () => list.querySelectorAll('.pal-item').forEach((b, i) => b.classList.toggle('on', i === cur));
    const pick = i => { const x = shown[i]; if (!x) return; close(); x.go(); };
    input.addEventListener('input', () => { cur = 0; paint(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(shown.length - 1, cur + 1); mark(); list.children[cur]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); mark(); list.children[cur]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(cur); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.body.append(box);
    paint();
    setTimeout(() => input.focus(), 20);
  }
  function close() { box?.remove(); box = null; }
  K.quickJump = open;

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); box ? close() : open(); }
  }, true);
})();
