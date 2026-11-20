// Now playing: a little player in the sidebar for whatever's playing on the PC (Glasswave, Spotify, a browser…),
// through Windows' own media controls. Shows only while something plays; asks Koru's background for the song
// every 2 seconds, and only while Koru is on screen. Settings → Now playing turns it off. Windows app only.
'use strict';
(function () {
  const { el, icon } = K;
  let btn = null, pop = null, now = { on: false }, timer = 0, busy = false;
  const enabled = () => K.info?.platform === 'desktop' && K.data.settings.nowPlaying !== false;
  // Windows names apps like "SpotifyAB.SpotifyMusic_x!Spotify", "chrome.exe" or "com.maker.glasswave": make it readable
  const KNOWN = { glasswave: 'Glasswave', spotify: 'Spotify', chrome: 'Browser', msedge: 'Browser', firefox: 'Browser', opera: 'Browser', brave: 'Browser', vlc: 'VLC', zunemusic: 'Media Player', koru: 'Koru', applemusic: 'Apple Music', youtube: 'YouTube Music' };
  const appName = id => {
    const raw = String(id || '').split(/[!\/]/).pop().replace(/\.exe$/i, '');
    const low = String(id || '').toLowerCase();
    for (const k of Object.keys(KNOWN)) if (low.includes(k)) return KNOWN[k];
    const parts = raw.split(/[._]/).filter(x => x && !/^(app|com|org|net|io|window|desktop|reader|player|music|exe|[a-z0-9]{13})$/i.test(x));
    const n = parts[parts.length - 1] || raw;
    return n.charAt(0).toUpperCase() + n.slice(1);
  };
  const svg = d => { const s = icon('dot'); s.innerHTML = d; return s; };
  const ICONS = { prev: '<path d="M7 6v12M18 6l-8 6 8 6z"/>', next: '<path d="M17 6v12M6 6l8 6-8 6z"/>', play: '<path d="M8 5.5v13l11-6.5z"/>', pause: '<path d="M8.5 5v14M15.5 5v14"/>' };

  async function poll() {
    clearTimeout(timer);
    if (!enabled()) { paint(); return; }
    if (!document.hidden && !busy) {
      busy = true;
      try { now = await K.api.get('/k/media'); } catch { now = { on: false }; }
      busy = false;
      paint();
    }
    timer = setTimeout(poll, 2000);
  }
  async function cmd(c) {
    try { await K.api.post('/k/media', { cmd: c }); } catch {}
    setTimeout(poll, 350);
  }
  function paint() {
    if (!btn) {
      const side = document.querySelector('.sidebar'); if (!side) return;
      btn = el('button.np-btn', { title: 'Now playing', onclick: e => { e.stopPropagation(); pop ? closePop() : openPop(); } });
      (side.querySelector('.side-inc') || side.querySelector('.side-min-btn'))?.before(btn);
    }
    const show = enabled() && now.on && (now.title || now.artist);
    btn.hidden = !show;
    if (!show) { closePop(); return; }
    btn.classList.toggle('playing', !!now.playing);
    btn.title = (now.title || '') + (now.artist ? ' · ' + now.artist : '');
    const art = now.thumb ? el('img', { src: now.thumb, alt: '' }) : el('span.np-note', { text: '♪' });
    if (btn.dataset.key !== (now.thumb || '') + now.title) { btn.dataset.key = (now.thumb || '') + now.title; btn.replaceChildren(art, el('i.np-eq', el('b'), el('b'), el('b'))); }
    if (pop) fillPop();
  }
  function fillPop() {
    pop.replaceChildren(
      el('div.np-art', now.thumb ? el('img', { src: now.thumb, alt: '' }) : el('span.np-note', { text: '♪' })),
      el('div.np-info', el('b', { text: now.title || 'Unknown song' }), el('span', { text: now.artist || '' }), el('small', { text: appName(now.app) })),
      el('div.np-ctl',
        el('button.btn.icon', { title: 'Previous', disabled: now.canPrev === false, onclick: () => cmd('prev') }, svg(ICONS.prev)),
        el('button.btn.icon.np-main', { title: now.playing ? 'Pause' : 'Play', onclick: () => { now.playing = !now.playing; fillPop(); cmd('toggle'); } }, svg(now.playing ? ICONS.pause : ICONS.play)),
        el('button.btn.icon', { title: 'Next', disabled: now.canNext === false, onclick: () => cmd('next') }, svg(ICONS.next))));
  }
  function openPop() {
    pop = el('div.np-pop.glass', { onclick: e => e.stopPropagation() });
    document.body.append(pop);
    fillPop();
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - 300, r.right + 10) + 'px';
    pop.style.top = Math.max(10, Math.min(innerHeight - pop.offsetHeight - 10, r.top - 60)) + 'px';
    setTimeout(() => document.addEventListener('click', closePop, { once: true }), 0);
  }
  function closePop() { pop?.remove(); pop = null; }

  K.nowPlaying = { poll, setOn(v) { K.data.settings.nowPlaying = !!v; K.save('settings'); poll(); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  // the app's info (platform) arrives a moment after start
  setTimeout(poll, 2500);
  // Settings → a switch to turn it off
  (K.settingsExtras ||= []).push(() => {
    if (K.info?.platform !== 'desktop') return null;
    const on = K.data.settings.nowPlaying !== false;
    const t = el('button.toggle' + (on ? '.on' : ''), { role: 'switch', 'aria-checked': String(on) });
    t.onclick = () => { const v = !t.classList.contains('on'); t.classList.toggle('on', v); t.setAttribute('aria-checked', String(v)); K.nowPlaying.setOn(v); };
    return el('section.panel.glass', el('h3', icon('play'), 'Now playing'),
      el('p', { text: 'A small player in the sidebar for music playing on your PC: Glasswave, Spotify, a browser and more. It only shows while something plays.' }),
      el('div.ctl', el('div.lab', 'Show the Now playing player', el('small', { text: 'Play, pause, next and previous without leaving Koru' })), t));
  });
})();
