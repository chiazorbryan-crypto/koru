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

  // Koru's own music (music.js) comes first; then Windows' sessions, but not Koru's own one again
  const miniMode = () => !!K.music?.available() && K.music.S().mode === 'mini';
  const mine = () => !!K.music?.available() && (K.music.active() || (miniMode() && !(enabled() && now.on && (now.title || now.artist))));
  const isKoru = n => /koru|electron/i.test(String(n?.app || ''));
  async function poll() {
    clearTimeout(timer);
    if (mine() && K.music.active()) { paint(); return; }   // music.js tells us when its song changes
    if (!enabled()) { paint(); return; }
    if (!document.hidden && !busy) {
      busy = true;
      try { now = await K.api.get('/k/media'); if (isKoru(now)) now = { on: false }; } catch { now = { on: false }; }
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
    if (mine()) return paintMine();
    const show = enabled() && now.on && (now.title || now.artist);
    btn.hidden = !show;
    if (!show) { closePop(); return; }
    btn.classList.toggle('playing', !!now.playing);
    btn.title = (now.title || '') + (now.artist ? ' · ' + now.artist : '');
    const art = now.thumb ? el('img', { src: now.thumb, alt: '' }) : el('span.np-note', { text: '♪' });
    if (btn.dataset.key !== (now.thumb || '') + now.title) { btn.dataset.key = (now.thumb || '') + now.title; btn.replaceChildren(art, el('i.np-eq', el('b'), el('b'), el('b'))); }
    if (pop) fillPop();
  }
  // Koru's own music: full mode opens Music → Now playing; "Mini player only" opens the compact player here
  function paintMine() {
    const c = K.music.cur();
    btn.hidden = false;
    btn.classList.toggle('playing', K.music.playing());
    btn.classList.add('koru');
    btn.title = c ? (c.t || '') + (c.a ? ' · ' + c.a : '') : 'Music';
    const key = 'k' + (c?.th || '') + (c?.t || '');
    if (btn.dataset.key !== key) {
      btn.dataset.key = key;
      const u = c && K.music.art(c.th, 120);
      btn.replaceChildren(u ? el('img', { src: u, alt: '', referrerPolicy: 'no-referrer' }) : el('span.np-note', { text: '♪' }), el('i.np-eq', el('b'), el('b'), el('b')));
    }
  }
  function fillPop() {
    pop.replaceChildren(
      el('div.np-art', now.thumb ? el('img', { src: now.thumb, alt: '' }) : el('span.np-note', { text: '♪' })),
      el('div.np-info', el('b', { text: now.title || 'Unknown song' }), el('span', { text: now.artist || '' }), el('small', { text: appName(now.app) })),
      el('div.np-ctl',
        el('button.btn.icon', { title: 'Previous', disabled: now.canPrev === false, onclick: () => cmd('prev') }, svg(ICONS.prev)),
        el('button.btn.icon.np-main', { title: now.playing ? 'Pause' : 'Play', onclick: () => { now.playing = !now.playing; fillPop(); cmd('toggle'); } }, svg(now.playing ? ICONS.pause : ICONS.play)),
        el('button.btn.icon', { title: 'Next', disabled: now.canNext === false, onclick: () => cmd('next') }, svg(ICONS.next))),
      miniMode() ? el('button.btn.small.np-koru', { onclick: () => { closePop(); openPop(true); } }, K.icon('music'), 'Play music in Koru') : null);
  }
  function openPop(forceMine) {
    if (forceMine || mine()) {
      if (K.music.S().mode === 'full') { K.go('/music/now'); return; }
      pop = K.music.compact({ cls: '.np-music.glass', onEsc: closePop });
      document.body.append(pop);
      place();
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', escPop, true);
      if (!K.music.active()) setTimeout(() => pop?.focusSearch?.(), 30);
      return;
    }
    pop = el('div.np-pop.glass', { onclick: e => e.stopPropagation() });
    document.body.append(pop);
    fillPop();
    place();
    setTimeout(() => document.addEventListener('click', closePop, { once: true }), 0);
  }
  const outside = e => { if (pop && !pop.contains(e.target) && !btn.contains(e.target) && !e.target.closest?.('.menu, .mu-ask-wrap')) closePop(); };
  const escPop = e => { if (e.key === 'Escape' && pop) { e.stopPropagation(); closePop(); } };
  function place() {
    const r = btn.getBoundingClientRect(), side = document.querySelector('.sidebar')?.getBoundingClientRect() || r;
    const edge = document.documentElement.dataset.side || 'left';
    const x = edge === 'right' ? side.left - pop.offsetWidth - 10 : edge === 'left' ? Math.max(r.right, side.right) + 10 : r.left - 20;
    pop.style.left = Math.max(10, Math.min(innerWidth - pop.offsetWidth - 10, x)) + 'px';
    if (pop.classList.contains('np-music')) {   // grows away from the button as results come in
      if (edge === 'top') { pop.style.top = side.bottom + 10 + 'px'; pop.style.bottom = 'auto'; }
      else { pop.style.top = 'auto'; pop.style.bottom = Math.max(10, edge === 'bottom' ? innerHeight - side.top + 10 : innerHeight - r.bottom - 10) + 'px'; }
      return;
    }
    pop.style.top = Math.max(10, Math.min(innerHeight - pop.offsetHeight - 10, r.top - 60)) + 'px';
  }
  function closePop() {
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escPop, true);
    if (pop?.contains(document.activeElement)) document.activeElement.blur();
    pop?.remove(); pop = null;
  }

  // music.js: its song or play state changed (or the mode did)
  const refresh = () => { if (!btn) { paint(); return; } if (mine()) { paintMine(); return; } btn.classList.remove('koru'); btn.dataset.key = ''; closePop(); poll(); };
  document.addEventListener('koru-ready', () => K.music?.on(w => { if (w === 'track' || w === 'state' || w === 'queue') refresh(); }));
  K.nowPlaying = { poll, refresh, setOn(v) { K.data.settings.nowPlaying = !!v; K.save('settings'); poll(); } };
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
