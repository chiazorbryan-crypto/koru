// Koru desktop widget (web/widget.html, its own small window): Up next and new chapters from your library.
// It reads the same saved lists as the app (/k/store/...). It redraws only when something changed: Koru tells it
// when your library or history is saved (koruWidgetRefresh), and it looks again every 5 minutes. Nothing animates.
'use strict';
(function () {
  const box = document.getElementById('w');
  const top = box.firstElementChild;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const load = k => fetch('/k/store/' + k).then(r => r.json()).then(v => v || {}, () => ({}));
  // covers whose site wants its own Referer go through Koru, like in the app
  const cover = u => (/^https:\/\//.test(u || '') ? '/k/fetch?u=' + encodeURIComponent(u) + '&accept=' + encodeURIComponent('image/avif,image/webp,image/*;q=0.8') : u || '');
  const ago = t => { const s = (Date.now() - t) / 1000; return s < 3600 ? Math.max(1, Math.floor(s / 60)) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
  const open = to => fetch('/k/widget/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) }).catch(() => {});
  const enc = encodeURIComponent;
  const hex = v => (Array.isArray(v) && /^#[0-9a-f]{3,8}$/i.test(v[0]) ? v[0] : null);

  const openKoru = el('button', '', 'Open Koru');
  openKoru.onclick = () => open('/library');
  top.append(openKoru);
  let sig = '';

  function item(cov, title, sub, badge, to) {
    const b = el('button', 'it');
    const im = cov ? el('img') : el('span', 'ph');
    if (cov) { im.alt = ''; im.referrerPolicy = 'no-referrer'; im.decoding = 'async'; im.src = cover(cov); im.onerror = () => im.replaceWith(el('span', 'ph')); }
    const tx = el('span', 'tx'); tx.append(el('b', '', title), el('small', '', sub));
    b.append(im, tx);
    if (badge) b.append(el('span', 'nb', badge));
    b.title = title;
    b.onclick = () => open(to);
    return b;
  }

  async function draw(force) {
    const [history, library, flags, settings] = await Promise.all(['history', 'library', 'flags', 'settings'].map(load));
    const colors = settings.theme?.colors || {};
    const flag = x => flags[x.provider + ':' + x.slug] || {};
    const next = Object.values(history).filter(h => h?.provider && h.chapterSlug && !flag(h).hidden && !flag(h).trash && !flag(h).completed).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 3);
    const fresh = Object.values(library).filter(x => x?.provider && x.newCount > 0 && !flag(x).hidden && !flag(x).trash)
      .sort((a, b) => b.newCount - a.newCount || (history[b.provider + ':' + b.slug]?.at || 0) - (history[a.provider + ':' + a.slug]?.at || 0)).slice(0, 4);
    const s = JSON.stringify([next.map(h => [h.provider, h.slug, h.chapterSlug, h.page, h.title, h.cover]), fresh.map(x => [x.provider, x.slug, x.newCount, x.title, x.cover]), hex(colors.accent), hex(colors.accent2)]);
    if (s === sig && !force) return;   // nothing changed: nothing redrawn
    sig = s;
    const root = document.documentElement.style;
    if (hex(colors.accent)) root.setProperty('--accent', hex(colors.accent));
    if (hex(colors.accent2)) root.setProperty('--accent2', hex(colors.accent2));
    const parts = [];
    if (next.length) {
      parts.push(el('h4', '', 'Up next'));
      for (const h of next) parts.push(item(h.cover, h.title || h.slug, `${h.done ? 'Finished ' : ''}${h.chapterName || 'Chapter'}${h.total ? ' · page ' + ((h.page | 0) + 1) + ' of ' + h.total : ''} · ${ago(h.at || Date.now())}`,
        null, `/read/${h.provider}/${enc(h.slug)}/${enc(h.chapterSlug)}`));
    }
    if (fresh.length) {
      parts.push(el('h4', '', 'New chapters'));
      for (const x of fresh) parts.push(item(x.cover, x.title || x.slug, `${x.newCount} new chapter${x.newCount > 1 ? 's' : ''}`, x.newCount > 99 ? '99+' : String(x.newCount), `/series/${x.provider}/${enc(x.slug)}`));
    }
    if (!parts.length) parts.push(el('p', 'empty', 'Nothing to continue yet. Start a series in Koru and it shows up here.'));
    box.replaceChildren(top, ...parts);
    // the window fits what's in it
    fetch('/k/widget/size', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ h: Math.ceil(box.getBoundingClientRect().height) + 12 }) }).catch(() => {});
  }
  window.koruWidgetRefresh = () => draw(false).catch(() => {});
  draw(true).catch(() => {});
  setInterval(() => { if (!document.hidden) draw(true).catch(() => {}); }, 5 * 60e3);   // the "2 h ago" times stay right
})();
