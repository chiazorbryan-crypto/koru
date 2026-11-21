// Koru Music: the player. One hidden YouTube embed plays the songs (it's made the first time you play something
// and lives outside the pages, so music keeps going in the Library and in the reader). It's driven with the embed's
// own message protocol: no polling, it tells Koru the time several times a second only while playing.
// Also here: the queue (shuffle, repeat, endless radio), your likes, playlists and history, Windows' media keys and
// volume flyout (navigator.mediaSession), the slim player bar, the compact player (sidebar and reader), the
// reveal spot in the reader, and Settings → Music. The pages themselves are in music-page.js.
'use strict';
(function () {
  const { el, icon } = K;
  // ---------- saved data: likes and playlists sync between PCs (sync.js), history stays on this PC ----------
  // mliked: { videoId: song + at }   mlists: { id: { name, at, songs: [song] } }   music: { recent: [song + at], gw: { query: song } }
  for (const k of ['mliked', 'mlists', 'music']) if (!(k in K.data)) K.data[k] = {};
  const DEF = { vol: 60, keep: true, mode: 'full', reveal: true, corner: 'bl', gw: true, radio: true, autoTrack: false };
  const S = () => ({ ...DEF, ...(K.data.settings.music || {}) });
  const setS = patch => { K.data.settings.music = { ...S(), ...patch }; K.save('settings'); };
  const available = () => K.info?.platform !== 'android' && !K.isMini?.();
  const testMute = () => { try { return localStorage.getItem('koru-music-mute') === '1'; } catch { return false; } };

  // ---------- icons (trusted constants) ----------
  const ICONS = {
    prev: '<path d="M7 6v12M18 6l-8 6 8 6z"/>', next: '<path d="M17 6v12M6 6l8 6-8 6z"/>',
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>', pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
    shuffle: '<path d="M4 7h3.5c2 0 3.2 1 4.3 2.7l1.4 2.6c1.1 1.7 2.3 2.7 4.3 2.7H20M4 17h3.5c1.4 0 2.4-.5 3.2-1.4M13.3 8.4c.8-.9 1.8-1.4 3.2-1.4H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5"/>',
    repeat: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
    repeat1: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/><path d="M11.5 10.5 13 9.5v5"/>',
    vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    queue: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 14.5v5l4-2.5z" fill="currentColor"/>',
    lyrics: '<path d="M5 5h14M5 9.5h10M5 14h12M5 18.5h7"/>',
    radio: '<circle cx="12" cy="12" r="2.2"/><path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6"/>',
    full: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>', up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>',
    addlist: '<path d="M4 6h12M4 11h12M4 16h7M17 14v6M14 17h6"/>', playnext: '<path d="M4 6h10M4 11h10M4 16h6"/><path d="M15 13.5v6l5-3z" fill="currentColor"/>'
  };
  const mi = (name, cls = '') => { if (!ICONS[name]) return icon(name, cls); const s = icon('dot', cls); s.innerHTML = ICONS[name]; return s; };
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const art = (url, px) => { const u = K.musicArt(url, px); return u && /^https:\/\//.test(u) ? u : ''; };
  const artImg = (url, px, cls = '') => { const u = art(url, px); return u ? el('img' + cls, { src: u, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer', draggable: false }) : el('span.mu-noart' + cls, mi('music')); };
  const skey = s => s.id || 'q:' + (s.q || s.t + ' ' + s.a);
  const plain = s => { const o = {}; for (const k of ['type', 'id', 'q', 't', 'a', 'aid', 'al', 'alid', 'd', 'th']) if (s[k]) o[k] = s[k]; return o; };

  // ---------- events: the pages, the bar and the compact players listen ----------
  const subs = new Set();
  const emit = what => { for (const f of [...subs]) { try { f(what); } catch {} } };
  const on = f => { subs.add(f); return () => subs.delete(f); };

  // ---------- the player ----------
  const P = { queue: [], idx: -1, st: 'idle', t: 0, d: 0, vol: null, muted: false, shuffle: false, repeat: 'off', src: null, orig: null };
  let host = null, frame = null, ready = false, hello = 0, helloN = 0, frameVid = '', loadT = 0, errRun = 0, played = '', lastTimeEmit = 0, wantStart = 0, loadAt = 0;
  const bad = new Set();
  const cur = () => P.queue[P.idx] || null;
  const ORIGIN = 'https://www.youtube-nocookie.com';
  const send = (func, args = []) => { if (frame?.contentWindow) frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), ORIGIN); };
  function makeFrame(vid, start) {
    killFrame();
    host ||= document.body.appendChild(el('div.mu-host', { 'aria-hidden': 'true' }));
    const q = new URLSearchParams({ enablejsapi: '1', autoplay: '1', playsinline: '1', controls: '0', disablekb: '1', fs: '0', rel: '0', iv_load_policy: '3' });
    if (testMute()) q.set('mute', '1');
    if (start) q.set('start', String(Math.floor(start)));
    frame = el('iframe', { src: `${ORIGIN}/embed/${vid}?${q}`, allow: 'autoplay; encrypted-media', title: 'Music player', tabIndex: -1 });
    frameVid = vid; ready = false; helloN = 0;
    host.append(frame);
    // say hello until the player answers (a few seconds at most, only while it starts)
    clearInterval(hello);
    hello = setInterval(() => {
      if (ready || !frame || ++helloN > 60) { clearInterval(hello); return; }
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), ORIGIN);
    }, 250);
  }
  function killFrame() { clearInterval(hello); frame?.remove(); frame = null; ready = false; frameVid = ''; }
  function onReady() {
    if (ready) return;
    ready = true; clearInterval(hello);
    send('addEventListener', ['onStateChange']); send('addEventListener', ['onError']);
    if (testMute()) send('mute');
    send('setVolume', [P.vol ?? S().vol]);
    if (P.st !== 'paused') send('playVideo');
  }
  window.addEventListener('message', e => {
    if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow) return;
    let m; try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.event === 'initialDelivery' || m.event === 'onReady') onReady();
    if (m.event === 'onError') return failed(m.info);
    if (m.event === 'onStateChange') return stateFrom(m.info);
    if (m.event === 'infoDelivery' && m.info) {
      const i = m.info;
      if (!ready) onReady();
      if (typeof i.playerState === 'number') stateFrom(i.playerState);
      if (typeof i.duration === 'number' && i.duration > 0) P.d = i.duration;
      if (typeof i.volume === 'number' && !testMute()) P.vol = Math.round(i.volume);
      if (typeof i.muted === 'boolean') P.muted = i.muted;
      if (typeof i.currentTime === 'number') {
        P.t = i.currentTime;
        const now = performance.now();
        if (now - lastTimeEmit > 250 && !document.hidden) { lastTimeEmit = now; emit('time'); }
      }
    }
  });
  function stateFrom(s) {
    const old = P.st;
    if (s === 1) {   // playing
      P.st = 'playing'; clearTimeout(loadT); errRun = 0;
      const c = cur();
      if (c && played !== skey(c) + P.idx) { played = skey(c) + P.idx; addRecent(c); recordTrack(); }
    }
    else if (s === 2) P.st = 'paused';
    else if (s === 3 && P.st !== 'paused') P.st = 'loading';
    else if (s === 0) {
      // the old song's "ended" can still arrive just after the next one was asked for: only a song that played ends
      const c = cur();
      if (P.st === 'ended' || performance.now() - loadAt < 2500 || !c || played !== skey(c) + P.idx) return;
      P.st = 'ended'; ended(); return;
    }
    if (old !== P.st) { emit('state'); session(); }
  }
  function ended() {
    if (P.repeat === 'one') { send('seekTo', [0, true]); send('playVideo'); return; }
    next(true);
  }
  // a song that won't play here (the owner turned off embedding, 101/150/153): try another copy of it once, then skip
  async function failed(code) {
    clearTimeout(loadT);
    const c = cur(); if (!c) return;
    if (c.id) bad.add(c.id);
    if (++errRun > 6) { stop(); K.toast('These songs won\'t play in Koru right now. Try others.', 'error'); return; }
    if (!c.retried && c.t) {
      c.retried = true;
      try {
        const alt = await K.musicApi.resolve(`${c.t} ${c.a || ''}`.trim(), c.d, bad);
        if (alt && cur() === c) { Object.assign(c, { id: alt.id, type: alt.type, th: c.th || alt.th }); load(P.idx); return; }
      } catch {}
    }
    if (cur() !== c) return;
    if (P.idx < P.queue.length - 1 || S().radio) { K.toast(`${c.t ? '"' + c.t + '"' : 'A song'} can't play here, skipping it`); next(true); }
    else { P.st = 'paused'; emit('state'); K.toast(`"${c.t}" can't play here`, 'error'); }
    void code;
  }
  // play queue[i]: Glasswave's "find it" songs are found on YouTube Music first
  async function load(i, start = 0) {
    const c = P.queue[i]; if (!c) return;
    P.idx = i; P.t = start; P.d = c.d || 0; P.st = 'loading'; wantStart = start; loadAt = performance.now();
    emit('track'); emit('state'); session(true);
    if (!c.id) {
      const q = c.q || `${c.t} ${c.a || ''}`.trim(), memo = K.data.music.gw?.[q];
      try {
        const r = memo || await K.musicApi.resolve(q, c.d, bad);
        if (cur() !== c) return;
        if (!r) { failed(0); return; }
        Object.assign(c, { id: r.id, type: r.type || 'song', th: c.th || r.th, al: c.al || r.al, alid: c.alid || r.alid, aid: c.aid || r.aid, d: c.d || r.d });
        if (!memo) { const g = K.data.music.gw ||= {}; g[q] = plain(r); const ks = Object.keys(g); if (ks.length > 3000) delete g[ks[0]]; K.save('music'); }
        emit('track');
      } catch (e) { if (cur() === c) { P.st = 'paused'; emit('state'); K.toast(e.message, 'error'); } return; }
    }
    if (bad.has(c.id) && !c.retried) { failed(150); return; }
    if (!frame) makeFrame(c.id, start);
    else if (ready) { send('loadVideoById', [c.id, Math.floor(start)]); if (testMute()) send('mute'); }
    else makeFrame(c.id, start);
    frameVid = c.id;
    // nothing after 20 s (stuck on a broken video): treat it like a song that can't play
    clearTimeout(loadT);
    loadT = setTimeout(() => { if (cur() === c && P.st === 'loading') failed(-1); }, 20000);
    radioSoon();
  }
  // endless: near the end of the queue, add YouTube Music's radio from the last song
  let radioBusy = false;
  async function radioSoon(force) {
    if (radioBusy || (!force && (!S().radio || P.repeat === 'all' || P.idx < P.queue.length - 2))) return;
    const seed = P.queue[P.queue.length - 1]; if (!seed?.id) return;
    radioBusy = true;
    try {
      const { songs } = await K.musicApi.next(seed.id);
      const have = new Set(P.queue.map(skey));
      const add = songs.filter(s => !have.has(skey(s)) && !bad.has(s.id)).slice(0, 25).map(s => ({ ...s, radio: true }));
      if (add.length) { P.queue.push(...add); emit('queue'); }
    } catch {}
    radioBusy = false;
  }

  // ---------- what the buttons do ----------
  function play(list, i = 0, src = null, start = 0) {
    list = (list || []).filter(s => s && (s.id || s.q || s.t)).map(s => ({ ...plain(s) }));
    if (!list.length) return;
    i = Math.max(0, Math.min(i, list.length - 1));
    P.queue = list; P.src = src; P.orig = null; played = '';
    if (P.shuffle) { const first = list[i]; const rest = list.filter((_, k) => k !== i); shuffleArr(rest); P.orig = list.slice(); P.queue = [first, ...rest]; i = 0; }
    emit('queue');
    load(i, start);
  }
  function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function toggle() {
    if (!cur()) return;
    if (P.st === 'playing' || P.st === 'loading') { send('pauseVideo'); P.st = 'paused'; }
    else if (!frame || P.st === 'ended') { load(P.idx, P.st === 'ended' ? 0 : P.t); return; }
    else { send('playVideo'); P.st = 'playing'; }
    emit('state'); session();
  }
  const pause = () => { if (P.st === 'playing' || P.st === 'loading') toggle(); };
  const resume = () => { if (P.st === 'paused' || P.st === 'ended') toggle(); };
  function next(auto) {
    if (P.idx < P.queue.length - 1) return load(P.idx + 1);
    if (P.repeat === 'all' && P.queue.length) return load(0);
    if (S().radio && !radioBusy) { radioSoon(true).then(() => { if (P.idx < P.queue.length - 1) load(P.idx + 1); else if (auto) { P.st = 'ended'; emit('state'); } }); return; }
    if (auto) { P.st = 'ended'; emit('state'); session(); }
  }
  function prev() {
    if (P.t > 4 || P.idx <= 0) { seek(0); return; }
    load(P.idx - 1);
  }
  function seek(t) { if (!cur()) return; P.t = Math.max(0, t); if (frame && ready) send('seekTo', [P.t, true]); else load(P.idx, P.t); emit('time'); session(); }
  let volSave = 0;
  function setVol(v) {
    P.vol = Math.max(0, Math.min(100, Math.round(v)));
    send('setVolume', [P.vol]);
    if (P.muted && P.vol > 0 && !testMute()) { send('unMute'); P.muted = false; }
    clearTimeout(volSave); volSave = setTimeout(() => setS({ vol: P.vol }), 600);
    emit('vol');
  }
  function toggleMute() { if (testMute()) return; P.muted = !P.muted; send(P.muted ? 'mute' : 'unMute'); emit('vol'); }
  function toggleShuffle() {
    P.shuffle = !P.shuffle;
    const c = cur();
    if (P.shuffle) { P.orig = P.queue.slice(); const rest = shuffleArr(P.queue.slice(P.idx + 1)); P.queue = [...P.queue.slice(0, P.idx + 1), ...rest]; }
    else if (P.orig) {
      const pos = new Map(P.orig.map((s, i) => [s, i]));
      const rest = P.queue.slice(P.idx + 1).sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
      P.queue = [...P.queue.slice(0, P.idx + 1), ...rest]; P.orig = null;
    }
    P.idx = P.queue.indexOf(c);
    emit('queue'); emit('state');
  }
  function cycleRepeat() { P.repeat = P.repeat === 'off' ? 'all' : P.repeat === 'all' ? 'one' : 'off'; emit('state'); }
  function jump(i) { if (P.queue[i]) load(i); }
  function remove(i) {
    if (!P.queue[i]) return;
    if (i === P.idx) { P.queue.splice(i, 1); if (!P.queue.length) return stop(); load(Math.min(i, P.queue.length - 1)); emit('queue'); return; }
    P.queue.splice(i, 1); if (i < P.idx) P.idx--;
    emit('queue');
  }
  function move(from, to) {
    if (from === to || !P.queue[from] || to < 0 || to >= P.queue.length) return;
    const c = cur(); const [s] = P.queue.splice(from, 1); P.queue.splice(to, 0, s); P.idx = P.queue.indexOf(c);
    emit('queue');
  }
  function clearUpNext() { P.queue = P.queue.slice(0, P.idx + 1); emit('queue'); }
  function stop() {
    clearTimeout(loadT); killFrame();
    P.queue = []; P.idx = -1; P.st = 'idle'; P.t = 0; P.d = 0; P.src = null; played = '';
    emit('queue'); emit('track'); emit('state'); session(true);
  }
  function playNext(s) { if (!cur()) return play([s]); P.queue.splice(P.idx + 1, 0, plain(s)); emit('queue'); K.toast(`"${s.t}" plays next`, 'ok'); }
  function addToQueue(s) { if (!cur()) return play([s]); P.queue.push(plain(s)); emit('queue'); K.toast(`Added "${s.t}" to the queue`, 'ok'); }
  async function startRadio(s) {
    play([s], 0, { kind: 'radio', t: s.t + ' radio' });
    if (!S().radio) radioSoon(true);
  }

  // ---------- likes, playlists, history ----------
  const liked = s => !!(s && K.data.mliked[skey(s)]);
  function like(s, v = !liked(s)) {
    const k = skey(s);
    if (v) K.data.mliked[k] = { ...plain(s), at: Date.now() }; else delete K.data.mliked[k];
    K.save('mliked'); emit('likes');
    K.toast(v ? 'Added to Liked songs' : 'Removed from Liked songs', v ? 'ok' : 'info');
  }
  const likedList = () => Object.values(K.data.mliked).sort((a, b) => (b.at || 0) - (a.at || 0));
  const lists = () => Object.entries(K.data.mlists).map(([id, p]) => ({ id, ...p })).sort((a, b) => (b.at || 0) - (a.at || 0));
  function newList(name, songs = []) {
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    K.data.mlists[id] = { name: String(name).slice(0, 80), at: Date.now(), songs: songs.map(plain) };
    K.save('mlists'); emit('lists'); return id;
  }
  function addToList(id, s) {
    const p = K.data.mlists[id]; if (!p) return;
    if (p.songs.some(x => skey(x) === skey(s))) { K.toast(`Already in ${p.name}`); return; }
    p.songs.push(plain(s)); p.at = Date.now(); K.save('mlists'); emit('lists');
    K.toast(`Added to ${p.name}`, 'ok');
  }
  function addRecent(s) {
    if (K.incognito()) return;
    const r = (K.data.music.recent ||= []).filter(x => skey(x) !== skey(s));
    r.unshift({ ...plain(s), at: Date.now() });
    K.data.music.recent = r.slice(0, 60);
    K.save('music');
  }

  // ---------- Windows: media keys, the volume flyout and the taskbar preview ----------
  // A silent sound in Koru's own page makes Windows show Koru's song, not the embed's (Chromium shows the
  // top-most page that plays something). It's a 1-second blank, looped, and it only plays while music does.
  let quiet = null;
  function quietSound(play_) {
    if (!quiet) {
      if (!play_) return;
      const n = 8000, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
      const w = (o, s) => [...s].forEach((c, i) => b[o + i] = c.charCodeAt(0));
      w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
      b.fill(128, 44);
      quiet = el('audio', { src: URL.createObjectURL(new Blob([b], { type: 'audio/wav' })), loop: true, preload: 'auto' });
    }
    if (play_) quiet.play().catch(() => {}); else quiet.pause();
  }
  let handlers = false;
  function session(meta) {
    const ms = navigator.mediaSession; if (!ms) return;
    const c = cur();
    if (!handlers) {
      handlers = true;
      const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
      set('play', resume); set('pause', pause); set('previoustrack', prev); set('nexttrack', () => next());
      set('seekto', d => seek(d.seekTime)); set('seekbackward', () => seek(P.t - 10)); set('seekforward', () => seek(P.t + 10)); set('stop', pause);
    }
    if (!c) { ms.metadata = null; ms.playbackState = 'none'; quietSound(false); return; }
    if (meta || !ms.metadata) {
      const a = art(c.th, 512);
      try { ms.metadata = new MediaMetadata({ title: c.t || 'Unknown song', artist: c.a || '', album: c.al || 'Koru', artwork: a ? [{ src: a, sizes: '512x512' }] : [] }); } catch {}
    }
    const playing = P.st === 'playing' || P.st === 'loading';
    ms.playbackState = playing ? 'playing' : 'paused';
    quietSound(playing);
    try { if (P.d > 0) ms.setPositionState({ duration: P.d, position: Math.min(P.t, P.d), playbackRate: 1 }); } catch {}
  }

  // ---------- keep playing while reading (Settings → Music) ----------
  let pausedForReading = false;
  window.addEventListener('hashchange', () => {
    const reading = /^#\/read\//.test(location.hash);
    if (reading && !S().keep && (P.st === 'playing' || P.st === 'loading')) { pausedForReading = true; pause(); }
    else if (!reading && pausedForReading) { pausedForReading = false; resume(); }
    if (!reading) { closeReveal(true); hideHint(); }
  });

  // ---------- mood music for a series, and each series' own soundtrack ----------
  // Mood: the series' genres pick a mood, and YouTube Music's playlists for it are suggested (never played by itself).
  // Soundtrack: what you played while reading a series is remembered, so next time it's one click away.
  const MOODS = [
    [/martial|murim|cultivation|wuxia|xianxia|action|regress|reincarn|system|dungeon|hunter|tower|revenge|villain|war\b|military/, 'Hype', 'epic hype phonk'],
    [/horror|thriller|psycholog|gore|zombie|survival|mystery|crime|apocalyp/, 'Dark', 'dark ambient'],
    [/romance|shoujo|shojo|josei|drama|harem|love/, 'Soft', 'soft r&b lofi love songs'],
    [/comedy|slice of life|school|cooking|daily/, 'Chill', 'chill pop'],
    [/fantasy|adventure|magic|isekai|historical|medieval/, 'Epic', 'epic fantasy orchestral'],
    [/sport/, 'Pumped', 'workout motivation'],
    [/sci.?fi|mecha|cyber|space/, 'Synth', 'synthwave'],
    [/tragedy|sad/, 'Melancholy', 'sad piano']
  ];
  function moodFor(tags) {
    const t = (tags || []).join(' | ').toLowerCase();
    const hits = MOODS.map(([re, label, q]) => ({ label, q, n: (t.match(new RegExp(re.source, 'g')) || []).length })).filter(m => m.n).sort((a, b) => b.n - a.n);
    if (!hits.length) return { key: 'reading', label: 'Reading', q: 'lofi beats for reading' };
    const two = hits.slice(0, 2);
    return { key: two.map(m => m.label).join('+'), label: two.map(m => m.label).join(' · '), q: two.map(m => m.q).join(' ') + ' playlist' };
  }
  // the mood's playlists, kept for a day per mood (so a series costs no request until you ask)
  async function moodPlaylists(m) {
    const k = 'koru-mood-' + m.key;
    try { const c = JSON.parse(localStorage.getItem(k) || 'null'); if (c && Date.now() - c.at < 864e5 && c.items?.length) return c.items; } catch {}
    const items = (await K.musicApi.search(m.q, 'playlists')).filter(x => x.bid).slice(0, 6);
    try { localStorage.setItem(k, JSON.stringify({ at: Date.now(), items })); } catch {}
    return items;
  }
  async function playMood(tags, btn) {
    const m = moodFor(tags);
    if (btn) btn.disabled = true;
    try {
      const found = await moodPlaylists(m);
      // one of the top few playlists each time, so it doesn't get old
      const pick = found[Math.floor(Math.random() * Math.min(3, found.length))];
      if (!pick) throw new Error('No mood music found right now.');
      const p = await K.musicApi.page(pick.bid);
      const songs = (p.tracks || []).slice();
      for (let i = songs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [songs[i], songs[j]] = [songs[j], songs[i]]; }
      if (!songs.length) throw new Error('That mood playlist is empty. Try again.');
      play(songs, 0, { kind: 'mood', t: m.label + ' mood: ' + p.t, href: '#/music/playlist/' + encodeURIComponent(pick.bid) });
    } catch (e) { K.toast(e.message, 'error'); }
    if (btn) btn.disabled = false;
  }
  // your own music to pick from: Liked songs, your playlists, Glasswave's
  async function choosePlaylist(ev) {
    const pos = { clientX: ev.clientX, clientY: ev.clientY, currentTarget: ev.currentTarget };
    const likes = likedList();
    const items = [
      likes.length ? ['heart', 'Liked songs', () => play(likes, 0, { kind: 'liked', t: 'Liked songs', href: '#/music/liked' })] : null,
      ...lists().filter(p => p.songs.length).map(p => ['list', p.name, () => play(p.songs, 0, { kind: 'mine', t: p.name, href: '#/music/mine/' + encodeURIComponent(p.id) })])
    ];
    const g = await K.musicGw?.info();
    if (g) {
      items.push('-');
      if (g.last) items.push(['music', 'Continue from Glasswave', () => gwPlay('last', 'Continue from Glasswave', true)]);
      for (const p of g.playlists) items.push(['music', K.musicGw.name(p) + ' (Glasswave)', () => gwPlay(p.id, K.musicGw.name(p))]);
    }
    if (!items.filter(x => x && x !== '-').length) { K.toast('Make a playlist or like a few songs first'); return; }
    menu(pos, 'Choose a playlist', items);
  }
  async function gwPlay(id, name, again) {
    try {
      const j = await K.musicGw.tracks(id);
      if (!j.songs.length) { K.toast('That Glasswave playlist is empty'); return; }
      play(j.songs, again ? Math.min(j.cur || 0, j.songs.length - 1) : 0, { kind: 'gw', t: name, href: '#/music/gw/' + encodeURIComponent(id) }, again ? j.pos || 0 : 0);
    } catch (e) { K.toast(e.message, 'error'); }
  }
  const readingKey = () => { const m = location.hash.match(/^#\/read\/([^/]+)\/([^/?]+)/); return m ? decodeURIComponent(m[1]) + ':' + decodeURIComponent(m[2]) : null; };
  const track = sk => (sk && K.data.music.series?.[sk]) || null;
  function recordTrack() {
    const sk = document.documentElement.classList.contains('reading') && (K.readingSeries?.() || readingKey());
    if (!sk || K.incognito() || !cur()) return;
    const all = K.data.music.series ||= {};
    all[sk] = { at: Date.now(), src: P.src ? { kind: P.src.kind, t: P.src.t, href: P.src.href } : null, songs: P.queue.slice(P.idx, P.idx + 40).map(plain) };
    const ks = Object.keys(all); if (ks.length > 200) delete all[ks.sort((a, b) => all[a].at - all[b].at)[0]];
    K.save('music');
  }
  function playTrack(sk) {
    const t = track(sk); if (!t?.songs?.length) return;
    play(t.songs, 0, t.src || { kind: 'soundtrack', t: 'Your soundtrack' });
  }
  // the row: your soundtrack first, then your own playlists, then the mood suggestion
  function moodRow(series, opts = {}) {
    const sk = series ? series.provider + ':' + series.slug : opts.key;
    const t = track(sk), m = moodFor(series?.tags);
    const own = likedList().length > 0 || lists().some(p => p.songs.length);
    const btn = (cls, name, label, fn, title) => el('button.btn.small' + cls, { title: title || label, onmousedown: e => e.preventDefault(), onclick: e => { e.stopPropagation(); fn(e, e.currentTarget); } }, mi(name), label);
    return el('div.mu-mood' + (opts.compact ? '.compact' : ''),
      t?.songs?.length ? btn('.primary', 'play', 'Your soundtrack for this series', () => playTrack(sk), t.src?.t ? 'Your soundtrack: ' + t.src.t : 'What you played last time') : null,
      btn(own && !t ? '.primary' : '', 'list', 'Choose a playlist', e => choosePlaylist(e)),
      btn(!own && !t ? '.primary' : '', 'sparkle', 'Play mood music', (e, b) => playMood(series?.tags, b), m.label + ' mood, from this series\' genres'),
      el('small.mu-moodtag', { text: m.label + ' mood' }));
  }
  // on the series page
  function seriesRow(series) {
    if (!available() || !series?.slug) return '';
    return el('div.mu-srow', el('span.mu-srow-l', mi('music'), 'Music for reading'), moodRow(series));
  }
  // when a chapter opens: play your soundtrack if you asked for that, otherwise offer music once (only if you use Music)
  const offered = new Set();
  let hint = null, hintT = 0;
  let lastSk = null;
  window.addEventListener('hashchange', () => {
    const sk = readingKey(), fresh = sk && sk !== lastSk;
    lastSk = sk;
    if (!fresh || !available()) return;   // a new series opened (not the next chapter of the same one)
    setTimeout(async () => {
      if (readingKey() !== sk || P.st === 'playing' || P.st === 'loading') return;
      if (S().autoTrack && track(sk)?.songs?.length) { playTrack(sk); return; }
      if (offered.has(sk) || !(K.data.music.recent || []).length || !S().reveal) return;
      offered.add(sk);
      const i = sk.indexOf(':');
      let series = null;
      try { series = await K.getSeries(sk.slice(0, i), sk.slice(i + 1)); } catch {}
      if (readingKey() !== sk || P.st === 'playing' || P.st === 'loading' || revealBox) return;
      showHint(series || { provider: sk.slice(0, i), slug: sk.slice(i + 1), tags: [] });
    }, 2500);
  });
  function showHint(series) {
    hideHint();
    hint = el('div.mu-hint-pop.glass', { dataset: { c: S().corner }, onmouseenter: () => clearTimeout(hintT), onmouseleave: () => { clearTimeout(hintT); hintT = setTimeout(hideHint, 1500); } },
      el('div.mu-hint-h', mi('music'), el('b', { text: 'Music while you read?' }), ib('x', 'Close', hideHint)), moodRow(series, { compact: true }));
    hint.addEventListener('click', e => { if (e.target.closest('.mu-mood button')) setTimeout(hideHint, 50); });
    document.body.append(hint);
    requestAnimationFrame(() => hint?.classList.add('in'));
    hintT = setTimeout(hideHint, 8000);
  }
  function hideHint() { clearTimeout(hintT); const h = hint; hint = null; if (!h) return; h.classList.remove('in'); setTimeout(() => h.remove(), 260); }

  // ---------- song menu (⋯ and right-click) ----------
  // K.popMenu with the music icons (it only knows Koru's own)
  function menu(pos, title, items) {
    items = items.filter(Boolean);
    K.popMenu(pos, title, items);
    const names = items.filter(x => x !== '-').map(x => x[0]);
    document.querySelectorAll('.menu .mi').forEach((b, i) => { if (ICONS[names[i]]) b.firstChild.replaceWith(mi(names[i])); });
  }
  function songMenu(ev, s, ctx = {}) {
    ev.preventDefault?.(); ev.stopPropagation?.();
    const pos = { clientX: ev.clientX, clientY: ev.clientY, currentTarget: ev.currentTarget };
    menu(pos, s.t, [
      ['play', 'Play', () => play([s], 0)],
      ['playnext', 'Play next', () => playNext(s)],
      ['queue', 'Add to queue', () => addToQueue(s)],
      s.id ? ['radio', 'Start radio', () => startRadio(s)] : null,
      '-',
      ['heart', liked(s) ? 'Remove from Liked songs' : 'Add to Liked songs', () => like(s)],
      ['addlist', 'Add to playlist…', () => listMenu(pos, s)],
      ctx.plId ? ['minus', 'Remove from this playlist', () => { const p = K.data.mlists[ctx.plId]; if (!p) return; p.songs = p.songs.filter(x => skey(x) !== skey(s)); p.at = Date.now(); K.save('mlists'); emit('lists'); ctx.onChange?.(); }] : null,
      ctx.queueIdx != null ? ['x', 'Remove from the queue', () => remove(ctx.queueIdx)] : null,
      (s.aid || s.alid) ? '-' : null,
      s.aid ? ['users', 'Go to artist', () => K.go('/music/artist/' + encodeURIComponent(s.aid))] : null,
      s.alid ? ['book', 'Go to album', () => K.go('/music/album/' + encodeURIComponent(s.alid))] : null
    ]);
  }
  function listMenu(pos, s) {
    menu(pos, 'Add to playlist', [
      ['plus', 'New playlist', async () => { const n = await ask('New playlist', '', 'Name'); if (n) { newList(n, [s]); K.toast(`Made "${n}"`, 'ok'); } }],
      lists().length ? '-' : null,
      ...lists().map(p => ['list', p.name, () => addToList(p.id, s)])
    ]);
  }
  // a small box asking for a name (or a yes) — no window prompts in Koru
  function ask(title, value = '', placeholder = '', okText = 'Save', danger = false) {
    return new Promise(res => {
      const input = placeholder != null ? el('input.txt', { type: 'text', value, placeholder, maxLength: 80, spellcheck: false }) : null;
      const done = v => { wrap.remove(); document.removeEventListener('keydown', key, true); res(v); };
      const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } if (e.key === 'Enter' && input) { e.preventDefault(); done(input.value.trim() || null); } };
      const wrap = el('div.mu-ask-wrap', { onpointerdown: e => { if (e.target === wrap) done(null); } },
        el('div.mu-ask.glass', el('b', { text: title }), input,
          el('div.row', { style: { justifyContent: 'flex-end' } }, el('button.btn.small', { onclick: () => done(null) }, 'Cancel'),
            el('button.btn.small' + (danger ? '.danger' : '.primary'), { onclick: () => done(input ? input.value.trim() || null : true) }, okText))));
      document.body.append(wrap);
      document.addEventListener('keydown', key, true);
      setTimeout(() => input?.focus(), 30);
    });
  }

  // ---------- the slim player bar (Full Music page mode) ----------
  let bar = null, barParts = null;
  const showBar = () => available() && S().mode === 'full' && !!cur() && !location.hash.startsWith('#/music/now');   // Now playing has its own controls
  function seekBar(cls = '') {
    const r = el('input.mu-seek' + cls, { type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek' });
    let dragging = false;
    r.addEventListener('pointerdown', () => { dragging = true; });
    r.addEventListener('input', () => { r.style.setProperty('--p', r.value / 10 + '%'); });
    r.addEventListener('change', () => { dragging = false; const d = P.d || cur()?.d || 0; if (d) seek(r.value / 1000 * d); if (document.documentElement.classList.contains('reading')) r.blur(); });   // the reader's arrow keys stay the reader's
    r.paint = () => { if (dragging) return; const d = P.d || cur()?.d || 0; const v = d ? Math.round(P.t / d * 1000) : 0; if (String(v) !== r.value) { r.value = v; r.style.setProperty('--p', v / 10 + '%'); } };
    return r;
  }
  function volBox() {
    const b = el('button.mu-ib', { title: 'Mute', onclick: toggleMute, onmousedown: e => e.preventDefault() });
    const r = el('input.mu-vol', { type: 'range', min: 0, max: 100, step: 1, value: P.vol ?? S().vol, 'aria-label': 'Volume' });
    const paint = () => { const v = P.vol ?? S().vol; if (document.activeElement !== r) r.value = v; r.style.setProperty('--p', r.value + '%'); b.replaceChildren(mi(P.muted || v == 0 ? 'mute' : 'vol')); };
    r.oninput = () => { setVol(Number(r.value)); r.style.setProperty('--p', r.value + '%'); };
    r.onchange = () => { if (document.documentElement.classList.contains('reading')) r.blur(); };
    paint();
    const box = el('div.mu-volbox', b, r); box.paint = paint; return box;
  }
  const ib = (name, title, fn, cls = '') => el('button.mu-ib' + cls, { title, 'aria-label': title, onclick: e => { e.stopPropagation(); fn(e); }, onmousedown: e => e.preventDefault() }, mi(name));
  function buildBar() {
    const p = {};
    p.art = el('a.mu-bart', { href: '#/music/now', title: 'Now playing' });
    p.t = el('a.mu-btitle', { href: '#/music/now' }); p.a = el('div.mu-bartist');
    p.play = ib('play', 'Play', toggle, '.big');
    p.shuf = ib('shuffle', 'Shuffle', toggleShuffle); p.rep = ib('repeat', 'Repeat', cycleRepeat);
    p.like = ib('heart', 'Like', () => cur() && like(cur()), '.mu-heart');
    p.seek = seekBar(); p.now = el('span.mu-time'); p.dur = el('span.mu-time');
    p.vol = volBox();
    bar = el('div.mu-bar.glass', { role: 'region', 'aria-label': 'Music player' },
      p.art, el('div.mu-binfo', p.t, p.a),
      el('div.mu-bmid', el('div.mu-bctl', p.shuf, ib('prev', 'Previous', prev), p.play, ib('next', 'Next', () => next()), p.rep), el('div.mu-bseek', p.now, p.seek, p.dur)),
      el('div.mu-bright', p.like, p.vol, ib('queue', 'Up next', () => K.go('/music/now?tab=queue')), ib('full', 'Now playing', () => K.go('/music/now'))));
    barParts = p;
  }
  function paintBar(what) {
    const show = showBar();
    document.documentElement.classList.toggle('mu-bar-on', show);
    if (!show) { bar?.remove(); return; }
    if (!bar) buildBar();
    const main = document.getElementById('main');
    if (main && bar.parentNode !== main) main.append(bar);
    const p = barParts, c = cur();
    if (what === 'time') { paintTime(p); return; }
    if (what !== 'vol') {
      if (p.art.dataset.k !== (c.th || '')) { p.art.dataset.k = c.th || ''; p.art.replaceChildren(artImg(c.th, 120)); }
      p.t.textContent = c.t || 'Unknown song'; p.t.title = c.t || '';
      p.a.replaceChildren(artistLink(c));
      p.play.replaceChildren(mi(P.st === 'playing' || P.st === 'loading' ? 'pause' : 'play'));
      p.play.title = P.st === 'playing' ? 'Pause' : 'Play';
      p.play.classList.toggle('wait', P.st === 'loading');
      p.shuf.classList.toggle('on', P.shuffle);
      p.rep.classList.toggle('on', P.repeat !== 'off'); p.rep.replaceChildren(mi(P.repeat === 'one' ? 'repeat1' : 'repeat'));
      p.rep.title = P.repeat === 'off' ? 'Repeat: off' : P.repeat === 'all' ? 'Repeat: all' : 'Repeat: this song';
      p.like.classList.toggle('on', liked(c)); p.like.title = liked(c) ? 'Unlike' : 'Like';
    }
    p.vol.paint();
    paintTime(p);
  }
  function paintTime(p, always) {
    if (!always && document.documentElement.classList.contains('reading')) return;   // the bar is put away while reading
    const d = P.d || cur()?.d || 0;
    p.seek.paint();
    const a = fmt(P.t), b = fmt(d);
    if (p.now.textContent !== a) p.now.textContent = a;
    if (p.dur.textContent !== b) p.dur.textContent = b;
  }
  function artistLink(c) {
    if (!c) return '';
    return c.aid ? el('a.mu-alink', { href: '#/music/artist/' + encodeURIComponent(c.aid), text: c.a || 'Unknown artist', onclick: e => e.stopPropagation() }) : el('span', { text: c.a || '' });
  }
  on(w => paintBar(w));
  window.addEventListener('hashchange', () => paintBar());
  document.addEventListener('koru-ready', () => paintBar());

  // ---------- the compact player: art, controls, seek, volume, Up next and search ----------
  // Used by the reader's reveal spot and by the sidebar's Now playing button in "Mini player only" mode.
  function compact(opts = {}) {
    const box = el('div.mu-mini' + (opts.cls || ''), { onclick: e => e.stopPropagation() });
    const p = {};
    p.art = el('div.mu-mart'); p.t = el('b.mu-mt'); p.a = el('div.mu-ma');
    p.like = ib('heart', 'Like', () => cur() && like(cur()), '.mu-heart');
    p.play = ib('play', 'Play', toggle, '.big');
    p.seek = seekBar(); p.now = el('span.mu-time'); p.dur = el('span.mu-time'); p.vol = volBox();
    let tab = cur() ? 'queue' : 'search';
    const list = el('div.mu-mlist');
    const input = el('input.txt.mu-msearch', { type: 'search', placeholder: 'Search songs', spellcheck: false, autocomplete: 'off' });
    let results = [], seq = 0;
    const runSearch = K.debounce(async () => {
      const q = input.value.trim(), my = ++seq;
      if (!q) { results = []; drawList(); return; }
      list.replaceChildren(el('div.spinner.small'));
      try { const r = await K.musicApi.search(q, 'songs'); if (my !== seq) return; results = r.filter(x => x.id); }
      catch (e) { if (my !== seq) return; list.replaceChildren(el('div.mu-empty', { text: e.message })); return; }
      drawList();
    }, 380);
    input.addEventListener('input', runSearch);
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { input.blur(); opts.onEsc?.(); } if (e.key === 'Enter') { e.preventDefault(); if (results[0]) { play(results, 0, { kind: 'search', t: input.value.trim() }); } } });
    const tabs = el('div.mu-mtabs',
      el('button', { dataset: { t: 'queue' }, onmousedown: e => e.preventDefault(), onclick: () => { tab = 'queue'; drawList(); } }, mi('queue'), 'Up next'),
      el('button', { dataset: { t: 'search' }, onmousedown: e => e.preventDefault(), onclick: () => { tab = 'search'; drawList(); setTimeout(() => input.focus(), 0); } }, mi('search'), 'Search'));
    const mini = (s, i, isQ) => el('div.mu-mrow' + (isQ && i === P.idx ? '.on' : ''), { onclick: () => isQ ? jump(i) : play(results, i, { kind: 'search', t: input.value.trim() }), oncontextmenu: e => songMenu(e, s, isQ ? { queueIdx: i } : {}) },
      artImg(s.th, 60), el('div.mu-mrt', el('b', { text: s.t }), el('small', { text: [s.a, s.d ? fmt(s.d) : ''].filter(Boolean).join(' • ') })),
      isQ && i !== P.idx ? ib('x', 'Remove', () => remove(i)) : null);
    function drawList() {
      tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
      input.hidden = tab !== 'search';
      if (tab === 'queue') {
        if (!P.queue.length) { list.replaceChildren(el('div.mu-empty', { text: 'Nothing queued. Search for a song to start.' })); return; }
        const from = Math.max(0, P.idx - 1);
        list.replaceChildren(...P.queue.slice(from, from + 60).map((s, k) => mini(s, from + k, true)));
        list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
      } else list.replaceChildren(...(results.length ? results.map((s, i) => mini(s, i, false)) : [el('div.mu-empty', { text: input.value.trim() ? 'No songs found.' : 'Find a song and it plays right away.' })]));
    }
    let attached = false;
    function paint(what) {
      if (!box.isConnected) { if (attached) off(); return; }
      attached = true; draw(what);
    }
    function draw(what) {
      if (what === 'time') return paintTime(p, true);
      const c = cur();
      box.classList.toggle('empty', !c);
      if (p.art.dataset.k !== (c?.th || '')) { p.art.dataset.k = c?.th || ''; p.art.replaceChildren(artImg(c?.th, 120)); }
      p.t.textContent = c ? c.t : 'Nothing playing'; p.a.replaceChildren(c ? artistLink(c) : 'Music from YouTube Music');
      p.play.replaceChildren(mi(P.st === 'playing' || P.st === 'loading' ? 'pause' : 'play')); p.play.classList.toggle('wait', P.st === 'loading');
      p.like.classList.toggle('on', liked(c));
      p.vol.paint(); paintTime(p, true);
      if (what === 'queue' || what === 'track') { if (tab === 'queue') drawList(); else list.querySelectorAll('.mu-mrow').forEach(r => r.classList.remove('on')); }
    }
    const off = on(paint);
    const moodBox = el('div');
    if (opts.seriesKey) {
      moodBox.append(moodRow(null, { key: opts.seriesKey, compact: true }));
      const i = opts.seriesKey.indexOf(':');
      K.getSeries?.(opts.seriesKey.slice(0, i), opts.seriesKey.slice(i + 1)).then(se => { if (se && box.isConnected) moodBox.replaceChildren(moodRow(se, { compact: true })); }).catch(() => {});
    }
    box.append(moodBox, el('div.mu-mtop', p.art, el('div.mu-minfo', p.t, p.a), p.like),
      el('div.mu-mctl', ib('prev', 'Previous', prev), p.play, ib('next', 'Next', () => next()), p.vol),
      el('div.mu-bseek', p.now, p.seek, p.dur),
      tabs, input, list,
      opts.open ? el('button.mu-mopen', { onmousedown: e => e.preventDefault(), onclick: () => { opts.onOpen?.(); K.go('/music/now'); } }, mi('full'), 'Open the Music page') : null);
    box.focusSearch = () => { tab = 'search'; drawList(); input.focus(); };
    drawList(); draw();
    return box;
  }

  // ---------- the reveal spot in the reader: hover a corner, the compact player slides out ----------
  let spot = null, revealBox = null, openT = 0, closeT = 0;
  const CORNERS = { bl: 'Bottom left', br: 'Bottom right', tl: 'Top left', tr: 'Top right' };
  function paintSpot() {
    const want = available() && S().reveal && (!!cur() || (K.data.music.recent || []).length > 0 || S().mode === 'mini');
    if (!want) { spot?.remove(); spot = null; closeReveal(true); return; }
    if (!spot) {
      spot = el('div.mu-spot', { title: 'Music', onclick: () => openReveal(),
        onmouseenter: () => { clearTimeout(openT); openT = setTimeout(openReveal, 250); }, onmouseleave: () => clearTimeout(openT) }, el('i.mu-spot-tab', mi('music')));
      document.body.append(spot);
    }
    spot.dataset.c = S().corner;
  }
  function openReveal() {
    clearTimeout(closeT);
    if (revealBox || !document.documentElement.classList.contains('reading')) return;
    hideHint();
    revealBox = compact({ cls: '.mu-reveal.glass', onEsc: () => closeReveal(), open: S().mode === 'full', onOpen: () => closeReveal(true), seriesKey: K.readingSeries?.() || readingKey() });
    revealBox.dataset.c = S().corner;
    revealBox.addEventListener('mouseenter', () => clearTimeout(closeT));
    revealBox.addEventListener('mouseleave', () => { clearTimeout(closeT); closeT = setTimeout(() => { if (!revealBox?.contains(document.activeElement)) closeReveal(); }, 600); });
    revealBox.addEventListener('focusout', () => { clearTimeout(closeT); closeT = setTimeout(() => { if (revealBox && !revealBox.matches(':hover') && !revealBox.contains(document.activeElement)) closeReveal(); }, 600); });
    document.body.append(revealBox);
    requestAnimationFrame(() => revealBox?.classList.add('in'));
    document.addEventListener('keydown', revealKey, true);
    document.addEventListener('pointerdown', revealOutside, true);
  }
  function closeReveal(now) {
    clearTimeout(closeT); clearTimeout(openT);
    const b = revealBox; if (!b) return;
    revealBox = null;
    document.removeEventListener('keydown', revealKey, true);
    document.removeEventListener('pointerdown', revealOutside, true);
    if (b.contains(document.activeElement)) document.activeElement.blur();
    if (now) { b.remove(); return; }
    b.classList.remove('in'); setTimeout(() => b.remove(), 260);
  }
  const revealKey = e => { if (e.key === 'Escape' && revealBox) { e.stopPropagation(); e.preventDefault(); closeReveal(); } };
  const revealOutside = e => { if (revealBox && !revealBox.contains(e.target) && !spot?.contains(e.target) && !e.target.closest?.('.menu, .mu-ask-wrap')) closeReveal(); };
  on(w => { if (w === 'queue' || w === 'track') paintSpot(); });
  document.addEventListener('koru-ready', paintSpot);

  // ---------- show/hide the Music page in the sidebar ----------
  const navShown = () => available() && S().mode === 'full';
  function paintNav() {
    const b = document.querySelector('.nav-btn[data-nav=music]');
    if (b) b.hidden = !navShown();
    K.movePill?.();
  }
  document.addEventListener('koru-ready', paintNav);
  function setMode(v) {
    setS({ mode: v === 'mini' ? 'mini' : 'full' });
    paintNav(); paintBar(); paintSpot(); K.nowPlaying?.refresh?.();
    if (v === 'mini' && /^#\/music/.test(location.hash)) K.go('/library');
  }

  // ---------- Settings → Music ----------
  (K.settingsExtras ||= []).push(() => {
    if (!available()) return null;
    const s = S();
    const tgl = (label, v, fn, sub) => {
      const t = el('button.toggle' + (v ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!v) });
      t.onclick = () => { const x = !t.classList.contains('on'); t.classList.toggle('on', x); t.setAttribute('aria-checked', String(x)); fn(x); };
      return el('div.ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), t);
    };
    const vol = el('input', { type: 'range', min: 0, max: 100, step: 1, value: s.vol });
    const vv = el('span.val', { text: s.vol + '%' });
    const pv = () => { vol.style.setProperty('--p', vol.value + '%'); vv.textContent = vol.value + '%'; };
    pv(); vol.oninput = () => { pv(); setS({ vol: Number(vol.value) }); if (cur()) setVol(Number(vol.value)); };
    const corner = el('select.sel-in', Object.entries(CORNERS).map(([v, l]) => el('option', { value: v, text: l, selected: v === s.corner })));
    corner.onchange = () => { setS({ corner: corner.value }); paintSpot(); };
    const gwRow = el('div');
    fetch('/k/glasswave?check=1').then(r => r.json()).then(j => {
      if (!j?.found) return;
      gwRow.replaceWith(tgl('Use my Glasswave library', S().gw, v => { setS({ gw: v }); emit('lists'); }, 'Your Glasswave playlists and liked songs show in Music → Library. Koru only reads them.'));
    }).catch(() => {});
    const clear = el('button.btn.small', { onclick: async () => {
      if (!(K.data.music.recent || []).length) { K.toast('Your music history is already empty'); return; }
      if (!await ask('Clear your music history?', '', null, 'Clear', true)) return;
      K.data.music.recent = []; K.save('music'); emit('lists'); paintSpot(); K.toast('Music history cleared', 'ok');
    } }, icon('trash'), 'Clear');
    return el('section.panel.glass', el('h3', icon('music'), 'Music'),
      el('p', { text: 'Songs from YouTube Music, played inside Koru. Likes and playlists sync with your other PCs.' }),
      el('div.ctl', el('div.lab', 'How music shows', el('small', { text: 'The Music page with a player bar, or just a small player from the sidebar' })),
        K.segmented([['full', 'Full Music page', 'music'], ['mini', 'Mini player only', 'play']], s.mode, setMode)),
      el('div.ctl', el('div.lab', 'Volume', el('small', { text: 'Where the volume starts. The player changes it too.' })), vol, vv),
      tgl('Keep playing while reading', s.keep, v => setS({ keep: v }), 'Off: music pauses when you open a chapter and carries on after'),
      tgl('Show the reveal spot in the reader', s.reveal, v => { setS({ reveal: v }); paintSpot(); }, 'Rest the mouse in a corner of a chapter to control the music'),
      el('div.ctl', el('div.lab', 'Reveal spot corner', el('small', { text: 'Where the music slides out while you read' })), corner),
      tgl('Play my soundtrack for a series automatically', s.autoTrack, v => setS({ autoTrack: v }), 'When a chapter opens, the music you played last time with that series starts by itself'),
      tgl('Play similar songs when the queue ends', s.radio, v => setS({ radio: v }), 'Keeps the music going with YouTube Music\'s radio'),
      gwRow,
      el('div.ctl', el('div.lab', 'Music history', el('small', { text: 'Songs you played lately, on this PC' })), clear));
  });

  // ---------- for the pages, the sidebar and the tests ----------
  K.music = {
    P, S, setS, on, emit, cur, menu, available, navShown, setMode, compact, songMenu, listMenu, ask, artImg, art, mi, ICONS, fmt, skey, plain, artistLink, seekBar, volBox, ib,
    play, toggle, pause, resume, next, prev, seek, setVol, toggleMute, toggleShuffle, cycleRepeat, jump, remove, move, clearUpNext, stop, playNext, addToQueue, startRadio,
    like, liked, likedList, lists, newList, addToList, addRecent,
    active: () => !!cur(), playing: () => P.st === 'playing' || P.st === 'loading',
    openReveal, closeReveal, paintSpot, frame: () => frame,
    moodFor, moodRow, seriesRow, playMood, playTrack, track, choosePlaylist, showHint
  };
})();
