// Koru Together: a mini Discord inside Koru for you and a couple of friends. Read together, chat, profiles.
// The crew lives on the Koru Together server (together-server/, a Cloudflare Worker).
//  - Sign in with GitHub (device sign-in: Koru shows a code, you enter it on github.com/login/device), then
//    type the name your crew sees. Your PC and phone are the same person.
//  - The person who makes a crew adds friends by their GitHub username; they show up once those friends sign in.
//  - Reader: "Read together" shares where you are; friends tap "Read with them" and their Koru follows your page
//    as you scroll, into the next chapter too. Touching the pages yourself pauses following; "Catch up" jumps back.
//  - Chat: replies, emoji reactions, edit/delete, pins, bookmarks, reminders, forward, search, emoji picker,
//    meme stickers, pictures and GIFs, voice messages. Messages travel over one live WebSocket: they show the
//    moment they're sent, a dead connection is noticed within seconds and re-opened, and anything missed while
//    away is fetched on reconnect.
//  - Profiles like Discord's: picture and banner (GIFs too), about me, pronouns, status, plus Koru's reading
//    info (streak, badges, chapters, top series, what they're reading now).
'use strict';
(function () {
  const { el, icon } = K;
  const DEFAULT_SERVER = 'https://koru-together.clippilot-api.workers.dev';
  const SEEN = 'koru-tg-seen', CACHE = 'koru-tg-cache', RECENT = 'koru-tg-recent', BM = 'koru-tg-bookmarks', REM = 'koru-tg-reminders';
  const cfg = () => K.data.settings.together || {};
  const setCfg = patch => { K.data.settings.together = { ...cfg(), ...patch }; K.save('settings'); };
  const ls = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

  const T = K.together = { ws: null, state: 'off', crews: null, crew: null, members: [], msgs: ls.get(CACHE, []), rt: {}, typing: {}, hosting: false, follow: null, paused: false, hasOlder: true, view: null, replyTo: null, editing: null, detached: false, profile: null };
  const server = () => String(cfg().server || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  const device = () => { let d = cfg().device; if (!d) { d = 'd' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Math.random()).slice(2) + Date.now()).slice(0, 22); setCfg({ device: d }); } return d; };
  const me = () => cfg().user || null;
  const meId = () => cfg().user?.id;
  const signedIn = () => !!(cfg().token && cfg().user);
  const inCrew = () => signedIn() && !!cfg().crew;
  const member = id => T.members.find(m => m.id === Number(id)) || (Number(id) === meId() ? { ...me(), presence: 'online' } : null);
  const nameOf = id => member(id)?.name || T.rt[id]?.name || 'Someone';
  const lastId = () => T.msgs.reduce((a, m) => Math.max(a, m.id || 0), 0);
  const seen = () => ls.get(SEEN, 0);
  const unread = () => T.msgs.filter(m => m.id > seen() && m.user !== meId() && !m.deleted).length;
  const chatOpen = () => !!T.view?.list?.isConnected && !document.hidden;
  const send = o => { if (T.ws?.readyState === 1) { T.ws.send(JSON.stringify(o)); return true; } return false; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const openLink = url => (K.native?.() ? K.api.post('/k/open-external', { url }).catch(() => window.open(url, '_blank')) : window.open(url, '_blank'));
  const nonce = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const copy = (t, msg = 'Copied') => navigator.clipboard?.writeText(t).then(() => K.toast(msg, 'ok'), () => K.toast('Couldn\'t copy', 'error'));
  const recent = () => ls.get(RECENT, ['😂', '🥹', '😭', '❤️', '🔥', '💀']);
  const useEmoji = e => ls.set(RECENT, [e, ...recent().filter(x => x !== e)].slice(0, 16));

  // ---------- talking to the server ----------
  async function api(path, { method = 'GET', body, raw, type } = {}) {
    let r;
    try { r = await fetch(server() + path, { method, headers: { 'Content-Type': type || 'application/json', ...(cfg().token ? { Authorization: 'Bearer ' + cfg().token } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) }); }
    catch { throw new Error('Couldn\'t reach the Koru Together server. Check your connection.'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && cfg().token && !path.startsWith('/auth/')) { signOutLocal(); K.toast('Sign in with GitHub again.', 'error'); route(); }
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong (' + r.status + ')'); e.status = r.status; throw e; }
    return j;
  }
  T.api = api;
  async function refresh() {
    if (!signedIn()) return null;
    const j = await api('/me');
    setCfg({ user: j.user });
    // a crew you weren't in before: someone added you
    const had = T.crews ? new Set(T.crews.map(x => x.id)) : null;
    const fresh = had ? j.crews.filter(x => !had.has(x.id)) : [];
    T.crews = j.crews; T.profile = j.profile;
    for (const c of fresh) if (c.owner !== meId()) {
      const by = c.members.find(x => x.id === c.owner)?.name || 'Someone';
      K.toast(by + ' added you to ' + c.name + '. Open it in Chat.', 'ok');
      K.setNavBadge?.('chat', true);
      try { if ((document.hidden || !document.hasFocus()) && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Koru', { body: by + ' added you to ' + c.name }).onclick = () => { window.focus?.(); setCfg({ crew: c.id }); K.go('/chat'); }; } catch {}
    }
    // added to a crew while you had none open: open it
    if (fresh.length && !cfg().crew) setCfg({ crew: fresh[0].id });
    const c = j.crews.find(x => x.id === cfg().crew) || j.crews[0] || null;
    if ((c?.id || null) !== (cfg().crew || null)) { setCfg({ crew: c?.id || null }); T.msgs = []; ls.set(CACHE, []); ls.set(SEEN, 0); }
    T.crew = c;
    if (c && T.state === 'off') connect();
    if (!c) disconnect();
    pushStats();
    return j;
  }
  T.refresh = refresh;
  function signOutLocal() {
    disconnect();
    const s = { ...cfg() }; delete s.token; delete s.user; delete s.crew; K.data.settings.together = s; K.save('settings');
    T.crews = null; T.crew = null; T.msgs = []; ls.set(CACHE, []); K.setNavBadge?.('chat', false);
  }

  // ---------- the live connection ----------
  // One WebSocket. A ping every 20 s; if no pong comes back within 8 s the connection is treated as dead and
  // re-opened at once (a half-dead socket never sits there silently). Re-opening is immediate the first time,
  // then backs off a little. Coming back to Koru or getting the network back re-opens it straight away.
  let pingT = 0, pongT = 0, retryT = 0, tries = 0;
  function disconnect() { clearTimeout(retryT); clearInterval(pingT); clearTimeout(pongT); const w = T.ws; T.ws = null; T.state = 'off'; try { w?.close(); } catch {} }
  function connect() {
    clearTimeout(retryT);
    if (!inCrew()) return;
    const old = T.ws; T.ws = null; try { old?.close(); } catch {}
    let ws;
    try { ws = new WebSocket(server().replace(/^http/, 'ws') + `/crews/${cfg().crew}/ws?` + new URLSearchParams({ token: cfg().token, device: device() })); }
    catch { T.state = 'off'; paint(); return; }
    let opened = false;
    T.ws = ws; T.state = 'connecting'; paint();
    ws.onopen = () => {
      if (T.ws !== ws) return;
      opened = true; tries = 0; T.state = 'on';
      clearInterval(pingT);
      pingT = setInterval(() => {
        if (ws.readyState !== 1) return;
        ws.send('ping');
        clearTimeout(pongT);
        pongT = setTimeout(() => { if (T.ws === ws) { try { ws.close(); } catch {} ws.onclose?.({ code: 1006 }); } }, 8000);
      }, 20000);
      if (idleNow) send({ t: 'idle', on: true });
      flushQueue();
      paint();
    };
    ws.onmessage = e => {
      if (T.ws !== ws) return;
      if (e.data === 'pong') { clearTimeout(pongT); return; }
      clearTimeout(pongT);
      let m; try { m = JSON.parse(e.data); } catch { return; } on(m);
    };
    ws.onclose = e => {
      if (T.ws !== ws) return;
      T.ws = null; clearInterval(pingT); clearTimeout(pongT); T.state = 'off'; paint();
      if (e?.code === 4003) { removed(); return; }
      if (!opened && tries >= 2) refresh().catch(() => {});
      if (inCrew()) retryT = setTimeout(connect, tries++ === 0 ? 300 : Math.min(15000, 1000 * 2 ** tries));
    };
  }
  T.connect = connect;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && inCrew() && T.state === 'off') { tries = 0; connect(); } if (!document.hidden) markSeen(); });
  window.addEventListener('online', () => { if (inCrew() && T.state !== 'on') { tries = 0; connect(); } });
  // messages typed while the connection is re-opening go out the moment it's back
  let queue = [];
  function sendOrQueue(o) { if (!send(o)) { queue.push(o); if (T.state === 'off') { tries = 0; connect(); } } }
  function flushQueue() { const q = queue; queue = []; for (const o of q) send(o); }
  function removed(deleted) {
    if (T.leaving) { T.leaving = false; return; }
    K.toast(deleted ? (T.crew?.name || 'The crew') + ' was deleted by its owner.' : 'You were removed from ' + (T.crew?.name || 'the crew') + '.', 'error');
    setCfg({ crew: null }); T.crew = null; T.msgs = []; ls.set(CACHE, []);
    if (T.follow) stopFollow(true);
    if (T.hosting) { T.hosting = false; clearInterval(posT); paintPill(); }
    refresh().catch(() => {}).finally(route);
  }

  // idle: no mouse/keys for 5 minutes, or Koru hidden for 5 minutes
  let idleNow = false, idleT = 0;
  const notIdle = () => { clearTimeout(idleT); if (idleNow) { idleNow = false; send({ t: 'idle', on: false }); } idleT = setTimeout(() => { idleNow = true; send({ t: 'idle', on: true }); }, 5 * 60e3); };
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, notIdle, { passive: true, capture: true });
  notIdle();

  // ---------- what the server sends ----------
  function upsert(x) {
    const i = T.msgs.findIndex(y => (y.id && y.id === x.id) || (x.nonce && y.nonce === x.nonce && !y.id));
    if (i >= 0) T.msgs[i] = x; else { T.msgs.push(x); T.msgs.sort((a, b) => (a.id || 1e15) - (b.id || 1e15)); }
    return i < 0;
  }
  function on(m) {
    if (m.t === 'init') {
      T.members = m.members || []; T.rt = m.rt || {};
      if (m.crew) T.crew = { ...T.crew, ...m.crew };
      if (m.me) setCfg({ user: { ...me(), ...m.me } });
      const have = T.detached ? 0 : lastId();
      if (have && have < m.lastId && (!m.msgs.length || m.msgs[0].id > have + 1)) {
        // missed more than a page while away: keep what we have and fetch the gap
        for (const x of m.msgs) upsert(x);
        send({ t: 'since', after: have });
      } else if (!have) { T.msgs = m.msgs; T.detached = false; }
      else for (const x of m.msgs) upsert(x);
      T.hasOlder = (T.msgs[0]?.id || 0) > 1;
      if (T.hosting) sharePos(true);
      cache(); paintAll(); badge();
    } else if (m.t === 'msg') {
      const x = m.m;
      if (T.detached) { if (x.user === meId()) jumpPresent(); return; }
      const isNew = upsert(x);
      delete T.typing[x.user];
      cache(); paintList(); badge();
      if (isNew && x.user !== meId()) notify(x);
    } else if (m.t === 'since') {
      for (const x of m.msgs) upsert(x);
      cache(); paintList(); badge();
    } else if (m.t === 'upd') {
      const i = T.msgs.findIndex(y => y.id === m.m.id);
      if (i >= 0) { T.msgs[i] = m.m; cache(); paintOne(m.m); }
      for (const p of [T.view?.panelList]) if (p) p.dispatchEvent(new CustomEvent('upd', { detail: m.m }));
    } else if (m.t === 'fail') {
      T.msgs = T.msgs.filter(y => y.nonce !== m.nonce || y.id); paintList(); K.toast(m.error, 'error');
    } else if (m.t === 'pinned') {
      if (m.by !== me()?.name) K.toast(m.by + ' pinned a message');
    } else if (m.t === 'older') {
      const ids = new Set(T.msgs.map(x => x.id));
      T.msgs = [...m.msgs.filter(x => !ids.has(x.id)), ...T.msgs];
      T.hasOlder = m.msgs.length >= 60 && (T.msgs[0]?.id || 0) > 1;
      paintList(true);
    } else if (m.t === 'around') {
      T.msgs = m.msgs; T.detached = m.msgs.length && m.msgs[m.msgs.length - 1].id < lastIdKnown;
      T.hasOlder = (T.msgs[0]?.id || 0) > 1;
      paintList(); flash(m.id);
    } else if (m.t === 'pins' || m.t === 'search') {
      showPanel(m.t === 'pins' ? 'Pinned messages' : 'Search: ' + m.q, m.msgs.slice().reverse(), m.t === 'pins' ? 'Nothing pinned yet. Pin a message from its menu.' : 'Nothing found.');
    } else if (m.t === 'presence') {
      T.members = m.members || []; if (T.crew) T.crew.members = T.members; paintHead(); paintPill();
    } else if (m.t === 'pos') {
      const key = String(m.user);
      if (m.user === meId()) return;   // your other device
      const was = !!T.rt[key];
      if (m.pos) T.rt[key] = { name: m.name, pos: m.pos, at: m.at }; else delete T.rt[key];
      if (T.follow === key) { if (m.pos) { if (!T.paused) K.readerGoto?.(m.pos); } else { K.toast(m.name + ' stopped reading together'); stopFollow(true); } }
      else if (m.pos && !was) invite(key);
      paintReading(); paintPill();
    } else if (m.t === 'typing') {
      T.typing[m.user] = Date.now(); paintTyping(); setTimeout(paintTyping, 4200);
    } else if (m.t === 'removed') removed(m.deleted);
    else if (m.t === 'crew') {
      if (!m.name || !T.crew) return;
      const ownerChanged = T.crew.owner !== m.owner;
      T.crew.name = m.name; T.crew.owner = m.owner;
      const c = (T.crews || []).find(x => x.id === T.crew.id); if (c) { c.name = m.name; c.owner = m.owner; }
      if (ownerChanged && m.owner === meId()) K.toast('You own ' + m.name + ' now.', 'ok');
      route();
    }
  }
  let lastIdKnown = 0;
  function cache() { if (!T.detached) { lastIdKnown = Math.max(lastIdKnown, lastId()); ls.set(CACHE, T.msgs.filter(x => x.id).slice(-200)); } }
  function markSeen() { if (chatOpen() && !T.detached && lastId() > seen()) { ls.set(SEEN, lastId()); K.setNavBadge?.('chat', false); } }
  function badge() { markSeen(); K.setNavBadge?.('chat', unread() > 0); }

  // a message while you're elsewhere: a toast in Koru, a Windows notification when Koru is in the background
  const preview = x => x.deleted ? 'deleted a message' : x.kind === 'share' ? 'shared ' + (x.data?.title || 'a series') : x.kind === 'together' ? 'is reading ' + (x.data?.title || '') + ' together'
    : x.kind === 'sticker' ? 'sent a sticker' : x.kind === 'image' ? 'sent a picture' : x.kind === 'voice' ? 'sent a voice message' : x.text;
  function notify(x) {
    if (chatOpen()) return;
    if (T.profile?.status === 'dnd') return;
    const text = preview(x);
    if (document.hidden || !document.hasFocus()) {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const n = new Notification(x.name, { body: String(text).slice(0, 140), silent: false });
          n.onclick = () => { window.focus?.(); K.go('/chat'); };
        }
      } catch {}
    } else if (!document.documentElement.classList.contains('reading')) K.toast(x.name + ': ' + String(text).slice(0, 80));
  }

  // someone started reading: a small card that lets you join
  function invite(key) {
    if (T.follow) return;
    const r = T.rt[key]; if (!r?.pos) return;
    document.querySelector('.tg-invite')?.remove();
    const card = el('div.tg-invite.glass',
      r.pos.cover ? el('img', { src: r.pos.cover, alt: '', loading: 'lazy' }) : null,
      el('div.tg-it', el('b', { text: r.name + ' is reading' }), el('span', { text: r.pos.title + ' · ' + r.pos.chapterName })),
      el('button.btn.small.primary', { onclick: () => { card.remove(); follow(key); } }, 'Read with them'),
      el('button.btn.small.icon', { title: 'Not now', onclick: () => card.remove() }, icon('x')));
    document.body.append(card);
    setTimeout(() => card.remove(), 20000);
  }

  // ---------- reading together ----------
  let posT = 0, lastSent = '';
  function sharePos(force) {
    if (!T.hosting) return;
    const p = K.readerPos?.();
    if (!p) return;   // a chapter is loading: keep sharing the last spot (stopping is only ever on purpose)
    const s = JSON.stringify(p);
    if (!force && s === lastSent) return;
    if (send({ t: 'pos', pos: p })) lastSent = s;
  }
  T.toggleHost = () => {
    if (!inCrew()) { K.toast('Sign in and make or join a crew in the Chat tab first.'); return; }
    T.hosting = !T.hosting;
    if (T.hosting) {
      stopFollow(true);
      lastSent = ''; sharePos(true);
      const p = K.readerPos?.();
      if (p) send({ t: 'send', kind: 'together', text: 'started reading together', data: p, nonce: nonce() });
      posT = setInterval(() => sharePos(), 500);
      K.toast('Reading together: your crew can follow along now', 'ok');
    } else { clearInterval(posT); send({ t: 'pos', pos: null }); lastSent = ''; K.toast('Stopped reading together'); }
    paintPill(); paintReaderBtn(); pushStats(true);
  };
  function follow(key) {
    key = String(key);
    const r = T.rt[key]; if (!r?.pos) { K.toast(nameOf(key) + ' isn\'t reading right now.'); return; }
    if (T.hosting) T.toggleHost();
    T.follow = key; T.paused = false;
    K.readerGoto?.(r.pos);
    paintPill();
  }
  T.followUser = follow;
  function stopFollow(quiet) { if (!T.follow) return; T.follow = null; T.paused = false; paintPill(); if (!quiet) K.toast('Stopped following'); }
  const pause = e => { if (T.follow && !T.paused && e.target?.closest?.('.reader .pages')) { T.paused = true; paintPill(); } };
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) document.addEventListener(ev, pause, { passive: true, capture: true });
  document.addEventListener('keydown', e => { if (T.follow && !T.paused && document.documentElement.classList.contains('reading') && /Arrow|Page|Space|^ $/.test(e.key + e.code)) { T.paused = true; paintPill(); } }, true);
  window.addEventListener('hashchange', () => setTimeout(() => {
    if (document.documentElement.classList.contains('reading')) return;
    if (T.hosting) T.toggleHost();
    if (T.follow) stopFollow(true);
  }, 300));
  function paintPill() {
    let pill = document.querySelector('.tg-pill');
    if (!T.hosting && !T.follow) { pill?.remove(); return; }
    if (!pill) { pill = el('div.tg-pill.glass'); document.body.append(pill); }
    const others = T.members.filter(m => m.online && m.id !== meId()).map(m => m.name);
    if (T.hosting) pill.replaceChildren(el('i.tg-live'), el('span', { text: 'Reading together' + (others.length ? ' · ' + others.join(', ') + ' online' : '') }),
      el('button.btn.small', { onclick: () => T.toggleHost() }, 'Stop'));
    else pill.replaceChildren(...[el('i.tg-live' + (T.paused ? '.off' : '')), el('span', { text: (T.paused ? 'Paused · ' : 'Following ') + nameOf(T.follow) }),
      T.paused ? el('button.btn.small.primary', { onclick: () => { T.paused = false; const r = T.rt[T.follow]; if (r?.pos) K.readerGoto?.(r.pos); paintPill(); } }, 'Catch up') : null,
      el('button.btn.small', { onclick: () => stopFollow() }, 'Stop')].filter(Boolean));
  }
  T.readerButton = () => inCrew() ? el('button.btn.icon.tg-rbtn' + (T.hosting ? '.on' : ''), { title: 'Read together: your crew can follow your page', onclick: () => T.toggleHost() }, icon('users')) : null;
  function paintReaderBtn() { document.querySelectorAll('.tg-rbtn').forEach(b => b.classList.toggle('on', T.hosting)); }

  // ---------- your Koru info on your profile (streak, badges, chapters, top series) ----------
  let statsSent = '';
  function pushStats(force) {
    if (!signedIn() || !K.data?.stats) return;
    try {
      const st = (K.statsAll?.() || K.data.stats) || {}, days = st.days || {};
      let ch = 0, ms = 0; for (const d of Object.values(days)) { ch += d.ch || 0; ms += d.ms || 0; }
      const got = st.badges || {};
      const badges = (K.lively?.BADGES || []).filter(b => got[b.id]).map(b => ({ e: b.e, name: b.name }));
      const top = Object.values(st.series || {}).filter(s => K.providers?.[s.provider]).sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 3)
        .map(s => ({ title: s.title, cover: typeof s.cover === 'string' && /^https:\/\//.test(s.cover) ? s.cover : null, provider: s.provider, slug: s.slug }));
      const p = T.hosting ? K.readerPos?.() : null;
      const stats = { streak: K.lively?.streak?.().n || 0, best: 0, chapters: ch, hours: Math.round(ms / 3600e3), series: Object.keys(st.series || {}).length, badges, top,
        reading: p ? { title: p.title, chapterName: p.chapterName } : null };
      const s = JSON.stringify(stats);
      if (!force && s === statsSent) return;
      statsSent = s;
      api('/me/profile', { method: 'POST', body: { stats } }).then(j => { T.profile = j.profile; }).catch(() => {});
    } catch {}
  }
  setInterval(() => pushStats(), 10 * 60e3);

  // ---------- small UI pieces ----------
  const timeOf = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayOf = at => { const d = new Date(at), t = new Date(); if (d.toDateString() === t.toDateString()) return 'Today'; t.setDate(t.getDate() - 1); if (d.toDateString() === t.toDateString()) return 'Yesterday'; return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
  const readLink = d => d?.provider && d.slug ? (d.chapterSlug ? `/read/${d.provider}/${encodeURIComponent(d.slug)}/${encodeURIComponent(d.chapterSlug)}${d.page ? '?page=' + d.page : ''}` : `/series/${d.provider}/${encodeURIComponent(d.slug)}`) : null;
  const hue = id => (Number(id) * 137.508) % 360;
  const PRESENCE = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline', invisible: 'Invisible' };
  function face(p, size = '', withDot) {
    const f = el('span.tg-face' + size, { style: { '--h': hue(p.id) }, title: p.name, onclick: e => { e.stopPropagation(); showProfile(p.id, e.currentTarget); } },
      p.avatar ? el('img', { src: p.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('b', { text: (p.name || '?').trim().charAt(0).toUpperCase() }));
    if (withDot) f.append(el('i.tg-dot.' + (p.presence || 'offline'), { title: PRESENCE[p.presence || 'offline'] }));
    return f;
  }
  function card(d, label) {
    const go = readLink(d);
    return el('div.tg-card', d.cover ? el('img', { src: d.cover, alt: '', loading: 'lazy' }) : el('div.tg-nocv', icon('book')),
      el('div.tg-it', el('b', { text: d.title || d.slug }), el('span', { text: [d.chapterName, d.page != null && d.total ? 'page ' + (d.page + 1) + ' of ' + d.total : null].filter(Boolean).join(' · ') })),
      go && K.providers[d.provider] ? el('button.btn.small', { onclick: () => K.go(go) }, icon('play'), label || 'Open') : null);
  }
  // text with links made clickable; emoji-only messages show big
  const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
  function richText(t) {
    const p = el('p');
    if (EMOJI_ONLY.test(t) && [...t.replace(/\s/g, '')].length <= 12) p.classList.add('tg-big');
    const re = /https?:\/\/[^\s<>"]+/g; let last = 0, m;
    while ((m = re.exec(t))) { p.append(t.slice(last, m.index)); const u = m[0]; p.append(el('a', { href: '#', text: u, onclick: e => { e.preventDefault(); openLink(u); } })); last = m.index + u.length; }
    p.append(t.slice(last));
    return p;
  }
  function voicePlayer(d) {
    const audio = new Audio(); audio.preload = 'none'; audio.src = d.url;
    const bar = el('i.tg-vfill'), time = el('small', { text: fmtDur(d.dur || 0) });
    const btn = el('button.btn.icon.small.tg-vplay', { title: 'Play', onclick: () => { if (audio.paused) { document.querySelectorAll('audio.tg-playing').forEach(a => a !== audio && a.pause()); audio.play().catch(() => K.toast('Couldn\'t play it', 'error')); } else audio.pause(); } }, icon('play'));
    audio.onplay = () => { audio.classList.add('tg-playing'); btn.replaceChildren(icon('pause')); };
    audio.onpause = audio.onended = () => { audio.classList.remove('tg-playing'); btn.replaceChildren(icon('play')); };
    audio.ontimeupdate = () => { const dur = audio.duration && isFinite(audio.duration) ? audio.duration : d.dur || 1; bar.style.transform = `scaleX(${Math.min(1, audio.currentTime / dur)})`; time.textContent = fmtDur(audio.currentTime) + ' / ' + fmtDur(dur); };
    const track = el('div.tg-vtrack', { onclick: e => { const r = e.currentTarget.getBoundingClientRect(), dur = audio.duration && isFinite(audio.duration) ? audio.duration : d.dur || 0; if (dur) { audio.currentTime = dur * (e.clientX - r.left) / r.width; if (audio.paused) btn.click(); } } }, bar);
    // a little wave drawn from the recording's levels
    const wave = el('div.tg-wave', ...(d.wave || []).slice(0, 48).map(v => el('i', { style: { height: Math.max(12, Math.min(100, v)) + '%' } })));
    return el('div.tg-voice', btn, el('div.tg-vbody', d.wave?.length ? wave : null, track), time);
  }
  const fmtDur = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function lightbox(src) {
    const box = el('div.tg-light', { onclick: () => box.remove() }, el('img', { src, alt: '' }));
    document.body.append(box);
    const esc = e => { if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', esc, true); } };
    document.addEventListener('keydown', esc, true);
  }

  // ---------- a message ----------
  function msgEl(m, prev) {
    const mine = m.user === meId();
    const who = member(m.user) || { id: m.user, name: m.name };
    const first = !prev || prev.user !== m.user || (m.at - prev.at) > 5 * 60e3 || !!m.reply || prev.deleted;
    let body;
    if (m.deleted) body = [el('p.tg-del', { text: 'Message deleted' })];
    else if (m.kind === 'share' && m.data) body = [m.text ? richText(m.text) : null, card(m.data, 'Read')];
    else if (m.kind === 'together' && m.data) body = [el('p.tg-sys', { text: 'Started reading together' }), card(m.data, 'Read'), T.rt[String(m.user)] && !mine ? el('button.btn.small.primary.tg-join', { onclick: () => follow(m.user) }, icon('users'), 'Read with them') : null];
    else if (m.kind === 'sticker' && m.data) body = [el('img.tg-sticker', { src: m.data.url, alt: m.data.name || 'sticker', title: m.data.name || '', loading: 'lazy' })];
    else if (m.kind === 'image' && m.data) body = [el('img.tg-img', { src: m.data.url, alt: '', loading: 'lazy', style: m.data.w && m.data.h ? { aspectRatio: m.data.w + ' / ' + m.data.h } : null, onclick: () => lightbox(m.data.url) }), m.text ? richText(m.text) : null];
    else if (m.kind === 'voice' && m.data) body = [voicePlayer(m.data)];
    else body = [richText(m.text || '')];
    const quote = m.reply ? el('div.tg-quote', { onclick: () => m.reply.id && jumpTo(m.reply.id) },
      icon('reply'), m.reply.gone ? el('i', { text: 'Original message was deleted' }) : [
        el('b', { style: { '--h': hue(m.reply.user) }, text: nameOf(m.reply.user) || m.reply.name }),
        el('span', { text: m.reply.deleted ? 'Message deleted' : m.reply.kind === 'text' ? m.reply.text : '[' + (m.reply.kind === 'sticker' ? 'sticker' : m.reply.kind === 'image' ? 'picture' : m.reply.kind === 'voice' ? 'voice message' : m.reply.kind) + ']' })]) : null;
    const reacts = m.reacts && !m.deleted ? el('div.tg-reacts', ...Object.entries(m.reacts).map(([e, users]) => el('button.tg-react' + (users.includes(meId()) ? '.mine' : ''), {
      title: users.map(nameOf).join(', ') + ' reacted with ' + e, onclick: () => react(m, e) }, el('span', { text: e }), el('b', { text: users.length }))),
      el('button.tg-react.add', { title: 'Add reaction', onclick: ev => emojiPicker(ev.currentTarget, e => react(m, e)) }, icon('smile'))) : null;
    const tools = m.id && !m.deleted ? el('div.tg-tools.glass',
      ...recent().slice(0, 3).map(e => el('button', { title: 'React ' + e, onclick: () => react(m, e) }, el('span', { text: e }))),
      el('button', { title: 'Add reaction', onclick: ev => emojiPicker(ev.currentTarget, e => react(m, e)) }, icon('smile')),
      mine && m.kind === 'text' ? el('button', { title: 'Edit', onclick: () => startEdit(m) }, icon('pencil')) : null,
      el('button', { title: 'Reply', onclick: () => startReply(m) }, icon('reply')),
      el('button', { title: 'More', onclick: ev => msgMenu(m, ev.currentTarget) }, icon('dots'))) : null;
    const node = el('div.tg-msg' + (mine ? '.mine' : '') + (m.id ? '' : '.pending') + (first ? '.first' : '') + (m.pinned ? '.pinned' : '') + (m.reply?.user === meId() && !mine ? '.mention' : ''),
      { dataset: { id: m.id || '' }, style: { '--h': hue(m.user) }, oncontextmenu: e => { if (!m.id || m.deleted) return; e.preventDefault(); msgMenu(m, null, e); } },
      first ? face(who, '.big') : el('time.tg-side', { text: timeOf(m.at || Date.now()) }),
      el('div.tg-col',
        quote,
        first ? el('div.tg-who', el('b', { text: who.name || m.name, onclick: e => showProfile(m.user, e.currentTarget) }), el('time', { text: (dayOf(m.at || Date.now()) === 'Today' ? '' : dayOf(m.at) + ' ') + timeOf(m.at || Date.now()) })) : null,
        m.fwd ? el('div.tg-fwd', icon('forward'), 'Forwarded from ' + m.fwd) : null,
        el('div.tg-body', ...body.filter(Boolean), m.edited && !m.deleted ? el('small.tg-edited', { text: '(edited)' }) : null, m.pinned ? el('small.tg-pintag', icon('pin'), 'pinned') : null),
        reacts),
      tools);
    return node;
  }
  function paintList(keepTop) {
    const v = T.view; if (!v?.list?.isConnected) return;
    const L = v.list, nearBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 160, prevH = L.scrollHeight, prevTop = L.scrollTop;
    const out = []; let day = '', prev = null;
    if (T.hasOlder && T.msgs.length) out.push(el('button.btn.small.tg-older', { onclick: () => send({ t: 'older', before: T.msgs[0].id }) }, 'Load earlier messages'));
    if (!T.msgs.length) out.push(el('div.tg-empty', T.state === 'on' ? [el('div.tg-wave-hi', { text: '👋' }), el('b', { text: 'Welcome to ' + (T.crew?.name || 'your crew') }), el('span', { text: 'Say hi, send a meme, or start reading together from any chapter.' })] : 'Connecting…'));
    for (const m of T.msgs) { const d = dayOf(m.at || Date.now()); if (d !== day) { day = d; prev = null; out.push(el('div.tg-day', el('span', { text: d }))); } out.push(msgEl(m, prev)); prev = m; }
    L.replaceChildren(...out);
    if (keepTop) L.scrollTop = prevTop + (L.scrollHeight - prevH);
    else if (nearBottom || !v.scrolled) { L.scrollTop = L.scrollHeight; v.scrolled = true; }
    v.present?.classList.toggle('show', !!T.detached);
    markSeen();
  }
  // one message changed (reaction, edit, pin, delete): swap just that one
  function paintOne(m) {
    const L = T.view?.list; if (!L?.isConnected) return;
    const old = L.querySelector(`.tg-msg[data-id="${m.id}"]`); if (!old) return;
    const i = T.msgs.findIndex(x => x.id === m.id);
    const n = msgEl(m, T.msgs[i - 1] && dayOf(T.msgs[i - 1].at) === dayOf(m.at) ? T.msgs[i - 1] : null);
    old.replaceWith(n);
  }
  function flash(id) { setTimeout(() => { const n = T.view?.list?.querySelector(`.tg-msg[data-id="${id}"]`); if (n) { n.scrollIntoView({ block: 'center' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1600); } }, 60); }
  function jumpTo(id) { if (T.msgs.some(x => x.id === id)) flash(id); else send({ t: 'around', id }); }
  function jumpPresent() { T.detached = false; T.msgs = []; disconnect(); connect(); }

  // ---------- actions on a message ----------
  function react(m, e) { useEmoji(e); sendOrQueue({ t: 'react', id: m.id, emoji: e }); }
  function startReply(m) { T.editing = null; T.replyTo = m; paintCompose(); T.view?.input?.focus(); }
  function startEdit(m) { T.replyTo = null; T.editing = m; const i = T.view?.input; if (i) { i.value = m.text; i.style.height = ''; i.style.height = Math.min(160, i.scrollHeight) + 'px'; i.focus(); } paintCompose(); }
  const bookmarks = () => ls.get(BM, []);
  function toggleBookmark(m) {
    const list = bookmarks(), i = list.findIndex(x => x.id === m.id && x.crew === cfg().crew);
    if (i >= 0) { list.splice(i, 1); K.toast('Bookmark removed'); } else { list.unshift({ ...m, crew: cfg().crew, savedAt: Date.now() }); K.toast('Bookmarked', 'ok'); }
    ls.set(BM, list.slice(0, 200));
  }
  function remind(m, ms, label) {
    const list = ls.get(REM, []); list.push({ at: Date.now() + ms, crew: cfg().crew, msg: { id: m.id, name: m.name, text: preview(m) } }); ls.set(REM, list);
    K.toast('I\'ll remind you ' + label, 'ok'); scheduleReminders();
  }
  let remT = 0;
  function scheduleReminders() {
    clearTimeout(remT);
    const list = ls.get(REM, []); if (!list.length) return;
    const now = Date.now(), due = list.filter(r => r.at <= now), rest = list.filter(r => r.at > now);
    for (const r of due) {
      K.toast('Reminder: ' + r.msg.name + ': ' + String(r.msg.text).slice(0, 60));
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Reminder', { body: r.msg.name + ': ' + String(r.msg.text).slice(0, 120) }).onclick = () => { window.focus?.(); K.go('/chat'); setTimeout(() => jumpTo(r.msg.id), 600); }; } catch {}
    }
    if (due.length) ls.set(REM, rest);
    if (rest.length) remT = setTimeout(scheduleReminders, Math.min(...rest.map(r => r.at)) - now + 200);
  }
  function msgMenu(m, anchor, ev) {
    const mine = m.user === meId(), owner = T.crew?.owner === meId();
    const marked = bookmarks().some(x => x.id === m.id && x.crew === cfg().crew);
    const others = (T.crews || []).filter(c => c.id !== cfg().crew);
    const item = (ic, label, fn, cls = '') => el('button.tg-mi' + cls, { onclick: () => { close(); fn(); } }, icon(ic), el('span', { text: label }));
    const sub = (ic, label, build) => el('button.tg-mi.sub', { onclick: e => { const r = e.currentTarget.getBoundingClientRect(); build(r); } }, icon(ic), el('span', { text: label }), icon('next', 'tg-chev'));
    const text = m.kind === 'text' ? m.text : m.data?.url || preview(m);
    const menu = el('div.menu.glass.tg-ctx',
      el('div.tg-qr', ...recent().slice(0, 4).map(e => el('button', { title: e, onclick: () => { close(); react(m, e); } }, el('span', { text: e })))),
      sub('smile', 'Add Reaction', r => { close(); emojiPicker({ getBoundingClientRect: () => r }, e => react(m, e)); }),
      el('hr'),
      mine && m.kind === 'text' ? item('pencil', 'Edit Message', () => startEdit(m)) : null,
      item('reply', 'Reply', () => startReply(m)),
      others.length ? sub('forward', 'Forward', r => {
        const fm = el('div.menu.glass.tg-ctx', el('small.muted', { text: 'Forward to' }), ...others.map(c => el('button.tg-mi', { onclick: async () => { fm.remove(); try { await api(`/crews/${c.id}/messages`, { method: 'POST', body: { kind: m.kind, text: m.text, data: m.data, fwd: T.crew?.name || 'a crew' } }); K.toast('Forwarded to ' + c.name, 'ok'); } catch (er) { K.toast(er.message, 'error'); } } }, icon('users'), el('span', { text: c.name }))));
        placeMenu(fm, r.right + 4, r.top); close(true);
      }) : null,
      el('hr'),
      item('copy', 'Copy Text', () => copy(text)),
      item('pin', m.pinned ? 'Unpin Message' : 'Pin Message', () => sendOrQueue({ t: 'pin', id: m.id })),
      item('bookmark', marked ? 'Remove Bookmark' : 'Bookmark Message', () => toggleBookmark(m)),
      sub('clock', 'Remind Me', r => {
        const opts = [['In 20 minutes', 20 * 60e3], ['In 1 hour', 3600e3], ['In 3 hours', 3 * 3600e3], ['Tomorrow', 24 * 3600e3]];
        const rm = el('div.menu.glass.tg-ctx', ...opts.map(([l, ms]) => el('button.tg-mi', { onclick: () => { rm.remove(); remind(m, ms, l.toLowerCase()); } }, icon('clock'), el('span', { text: l }))));
        placeMenu(rm, r.right + 4, r.top); close(true);
      }),
      item('unread', 'Mark Unread', () => { ls.set(SEEN, Math.max(0, m.id - 1)); K.setNavBadge?.('chat', true); K.toast('Marked unread'); }),
      mine || owner ? el('hr') : null,
      mine || owner ? item('trash', 'Delete Message', () => { if (confirm('Delete this message? It can\'t be undone.')) sendOrQueue({ t: 'del', id: m.id }); }, '.danger') : null);
    let gone = false;
    function close(keepOutsideClose) { if (gone) return; gone = true; menu.remove(); document.removeEventListener('pointerdown', out, true); document.removeEventListener('keydown', esc, true); void keepOutsideClose; }
    const out = e => { if (!menu.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const r = anchor ? anchor.getBoundingClientRect() : { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY };
    placeMenu(menu, anchor ? r.right - 230 : r.left, anchor ? r.bottom + 4 : r.top);
    setTimeout(() => { document.addEventListener('pointerdown', out, true); document.addEventListener('keydown', esc, true); }, 0);
  }
  function placeMenu(menu, x, y) {
    document.body.append(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
    if (!menu._auto) {
      menu._auto = true;
      const out = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', out, true); } };
      setTimeout(() => document.addEventListener('pointerdown', out, true), 0);
    }
  }

  // ---------- emoji picker ----------
  function emojiPicker(anchor, pick) {
    document.querySelector('.tg-emoji')?.remove();
    const cats = window.KORU_EMOJI || [];
    const q = el('input.txt', { type: 'text', placeholder: 'Find an emoji', spellcheck: false });
    const grid = el('div.tg-egrid'), tabs = el('div.tg-etabs');
    const box = el('div.menu.glass.tg-emoji', q, tabs, grid);
    const btn = e => el('button', { title: '', onclick: () => { useEmoji(e); pick(e); box.remove(); } }, e);
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      if (s) { const hits = []; for (const c of cats) for (const [e, n] of c.items) if (n.includes(s)) hits.push(e); grid.replaceChildren(...(hits.length ? hits.slice(0, 200).map(btn) : [el('small.muted', { text: 'No emoji found' })])); return; }
      grid.replaceChildren(el('small.tg-ecat', { text: 'Recent' }), ...recent().map(btn), ...cats.flatMap(c => [el('small.tg-ecat', { text: c.name, dataset: { cat: c.name } }), ...c.items.map(([e]) => btn(e))]));
    };
    tabs.replaceChildren(...cats.map(c => el('button', { title: c.name, onclick: () => { q.value = ''; draw(); grid.querySelector(`[data-cat="${c.name}"]`)?.scrollIntoView({ block: 'start' }); } }, c.items[0]?.[0] || '•')));
    q.addEventListener('input', draw);
    draw();
    const r = anchor.getBoundingClientRect();
    placeMenu(box, r.right - 340, r.top - 420 < 8 ? r.bottom + 6 : r.top - 420);
    setTimeout(() => q.focus(), 30);
  }

  // ---------- meme stickers ----------
  let memeCache = null;
  async function stickerPicker(anchor) {
    document.querySelector('.tg-stick')?.remove();
    const q = el('input.txt', { type: 'text', placeholder: 'Find a meme', spellcheck: false });
    const grid = el('div.tg-sgrid', el('div.spinner'));
    const box = el('div.menu.glass.tg-stick', el('div.tg-shead', el('b', { text: 'Meme stickers' }), q), grid);
    const r = anchor.getBoundingClientRect();
    placeMenu(box, r.right - 420, r.top - 470 < 8 ? r.bottom + 6 : r.top - 470);
    setTimeout(() => q.focus(), 30);
    try { memeCache ||= (await api('/memes')).memes; } catch (e) { grid.replaceChildren(el('small.muted', { text: e.message })); return; }
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      const list = memeCache.filter(x => !s || x.name.toLowerCase().includes(s));
      grid.replaceChildren(...(list.length ? list.map(x => el('button', { title: x.name, onclick: () => { box.remove(); sendMsg({ kind: 'sticker', data: { url: x.url, name: x.name, w: x.w, h: x.h } }); } },
        el('img', { src: x.url, alt: x.name, loading: 'lazy' }), el('span', { text: x.name }))) : [el('small.muted', { text: 'No memes found' })]));
    };
    q.addEventListener('input', draw);
    draw();
  }

  // ---------- sending ----------
  function sendMsg(o) {
    const n = nonce();
    const msg = { t: 'send', ...o, nonce: n, reply: T.replyTo?.id || undefined };
    // shown at once, greyed until the server confirms it (usually a few hundred ms)
    T.msgs.push({ nonce: n, at: Date.now(), user: meId(), name: me()?.name, kind: o.kind || 'text', text: o.text || '', data: o.data || null, reply: T.replyTo ? { id: T.replyTo.id, user: T.replyTo.user, name: T.replyTo.name, kind: T.replyTo.kind, text: T.replyTo.text } : null });
    T.replyTo = null; paintCompose();
    if (T.view) T.view.scrolled = false;
    paintList();
    sendOrQueue(msg);
  }
  async function shrink(file) {
    // big photos are shrunk before sending (GIFs and small pictures go as they are, so animations keep working)
    if (file.type === 'image/gif' || file.type === 'image/webp' || file.size < 900 * 1024) return { blob: file, ...(await dims(file)) };   // GIF and WebP can move: sent as they are
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.88));
    return { blob: blob || file, w: c.width, h: c.height };
  }
  const dims = f => new Promise(r => { const u = URL.createObjectURL(f), i = new Image(); i.onload = () => { r({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(u); }; i.onerror = () => { r({}); URL.revokeObjectURL(u); }; i.src = u; });
  async function upload(blob, type) {
    if (blob.size > 14 * 1024 * 1024) throw new Error('That file is too big (14 MB at most).');
    return api('/media', { method: 'POST', raw: blob, type: type || blob.type });
  }
  T.upload = upload;
  async function sendPictures(files) {
    for (const f of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { K.toast('Only pictures and GIFs can be sent.', 'error'); continue; }
      const tag = el('div.tg-uploading', icon('image'), 'Sending ' + (f.name || 'picture') + '…');
      T.view?.compose?.before(tag);
      try { const s = await shrink(f); const u = await upload(s.blob, s.blob.type || f.type); sendMsg({ kind: 'image', data: { url: u.url, w: s.w, h: s.h, name: String(f.name || '').slice(0, 80) } }); }
      catch (e) { K.toast(e.message, 'error'); }
      finally { tag.remove(); }
    }
  }
  // voice messages: tap the mic, talk, tap send (or cancel). Up to 5 minutes.
  let rec = null;
  async function startVoice() {
    if (rec) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { K.toast('Voice messages need a microphone.', 'error'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { K.toast('Koru couldn\'t use your microphone. Check Windows Settings → Privacy → Microphone.', 'error'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : {});
    const chunks = [], levels = [];
    const ac = new (window.AudioContext || window.webkitAudioContext)(), an = ac.createAnalyser(); an.fftSize = 256;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const t0 = Date.now();
    rec = { mr, stream, ac, cancel: false };
    mr.ondataavailable = e => e.data.size && chunks.push(e.data);
    const timeEl = el('b', { text: '0:00' }), meter = el('i.tg-rmeter');
    const bar = el('div.tg-rec', el('i.tg-rdot'), timeEl, meter,
      el('button.btn.small', { onclick: () => stopVoice(true) }, icon('x'), 'Cancel'),
      el('button.btn.small.primary', { onclick: () => stopVoice(false) }, icon('send'), 'Send'));
    T.view?.compose?.before(bar);
    const tick = setInterval(() => {
      an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const lvl = Math.min(100, peak / 128 * 180); levels.push(lvl); meter.style.transform = `scaleX(${lvl / 100})`;
      const s = (Date.now() - t0) / 1000; timeEl.textContent = fmtDur(s);
      if (s >= 300) stopVoice(false);
    }, 100);
    mr.onstop = async () => {
      clearInterval(tick); bar.remove(); stream.getTracks().forEach(t => t.stop()); ac.close().catch(() => {});
      const cancel = rec.cancel; rec = null; paintCompose();
      if (cancel) return;
      const dur = (Date.now() - t0) / 1000;
      if (dur < 0.6) { K.toast('Hold on a little longer to record'); return; }
      const blob = new Blob(chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] });
      // 48 bars for the wave
      const wave = []; const step = Math.max(1, levels.length / 48); for (let i = 0; i < levels.length && wave.length < 48; i += step) wave.push(Math.round(Math.max(...levels.slice(Math.floor(i), Math.floor(i + step)))));
      const tag = el('div.tg-uploading', icon('mic'), 'Sending voice message…'); T.view?.compose?.before(tag);
      try { const u = await upload(blob, blob.type); sendMsg({ kind: 'voice', data: { url: u.url, dur: Math.round(dur * 10) / 10, wave } }); }
      catch (e) { K.toast(e.message, 'error'); }
      finally { tag.remove(); }
    };
    mr.start(250);
    paintCompose();
  }
  function stopVoice(cancel) { if (!rec) return; rec.cancel = cancel; try { rec.mr.stop(); } catch {} }

  // ---------- the chat screen ----------
  function paintHead() {
    const v = T.view; if (!v?.head?.isConnected) return;
    const owner = T.crew?.owner === meId();
    const order = { online: 0, idle: 1, dnd: 2, offline: 3 };
    const list = [...T.members].sort((a, b) => (order[a.presence] ?? 3) - (order[b.presence] ?? 3));
    v.head.replaceChildren(el('small.tg-mhead', { text: 'Members — ' + T.members.length }), ...list.map(m => {
      const reading = T.rt[String(m.id)]?.pos;
      return el('div.tg-mem' + (m.online ? '.on' : ''), { onclick: e => showProfile(m.id, e.currentTarget) },
        face(m, '', true),
        el('div.tg-mtext', el('b', { text: m.name + (m.id === meId() ? ' (you)' : '') }),
          el('small', { text: reading ? '📖 ' + reading.title : m.custom || (m.online ? PRESENCE[m.presence] : m.last ? 'Last seen ' + K.ago(m.last) : 'Not here yet') })),
        owner && m.id !== meId() ? el('button.tg-x', { title: 'Remove ' + m.name, onclick: async e => {
          e.stopPropagation();
          if (!confirm('Remove ' + m.name + ' from ' + T.crew.name + '?')) return;
          try { await api(`/crews/${T.crew.id}/members/${m.id}`, { method: 'DELETE' }); K.toast(m.name + ' removed'); } catch (er) { K.toast(er.message, 'error'); }
        } }, icon('x')) : null);
    }));
    v.status.textContent = T.state === 'on' ? '' : T.state === 'connecting' ? 'Connecting…' : 'Offline, reconnecting…';
  }
  function paintReading() {
    const v = T.view; if (!v?.reading?.isConnected) return;
    const list = Object.entries(T.rt).filter(([k, r]) => k !== String(meId()) && r.pos);
    v.reading.replaceChildren(...list.map(([k, r]) => el('div.tg-now', el('div.tg-who2', { text: '📖 ' + r.name + ' is reading now' }), card(r.pos, 'Open'),
      el('button.btn.small.primary', { onclick: () => follow(k) }, icon('users'), 'Read with them'))));
  }
  function paintTyping() {
    const v = T.view; if (!v?.typing?.isConnected) return;
    const who = Object.entries(T.typing).filter(([k, at]) => Date.now() - at < 4000 && k !== String(meId())).map(([k]) => nameOf(k));
    v.typing.replaceChildren(...(who.length ? [el('i.tg-dots', el('i'), el('i'), el('i')), el('span', { text: who.join(', ') + (who.length > 1 ? ' are' : ' is') + ' typing…' })] : []));
  }
  function paintCompose() {
    const v = T.view; if (!v?.bar?.isConnected) return;
    const r = T.replyTo, e = T.editing;
    v.bar.replaceChildren(...(r ? [el('span', 'Replying to ', el('b', { text: nameOf(r.user) })), el('button.tg-x', { title: 'Cancel reply', onclick: () => { T.replyTo = null; paintCompose(); } }, icon('x'))]
      : e ? [el('span', { text: 'Editing message · Enter to save, Esc to cancel' }), el('button.tg-x', { title: 'Cancel edit', onclick: cancelEdit }, icon('x'))] : []));
    v.bar.classList.toggle('show', !!(r || e));
    v.compose.classList.toggle('rec', !!rec);
  }
  function cancelEdit() { T.editing = null; if (T.view?.input) { T.view.input.value = ''; T.view.input.style.height = ''; } paintCompose(); }
  function paint() { paintHead(); if (T.view?.list?.isConnected && !T.msgs.length) paintList(); }
  function paintAll() { paintHead(); paintReading(); paintList(); paintTyping(); paintCompose(); }
  function route() { if ((location.hash.slice(1) || '').startsWith('/chat')) window.dispatchEvent(new HashChangeEvent('hashchange')); }

  // side panel: pinned messages, search results, bookmarks
  function showPanel(title, msgs, empty) {
    const v = T.view; if (!v?.side?.isConnected) return;
    const list = el('div.tg-plist', ...(msgs.length ? msgs.map(m => el('div.tg-pitem', { onclick: () => { jumpTo(m.id); } },
      el('div.tg-who', el('b', { text: nameOf(m.user) || m.name }), el('time', { text: dayOf(m.at) + ' ' + timeOf(m.at) })),
      el('p', { text: m.deleted ? 'Message deleted' : m.kind === 'text' ? m.text : preview(m) }))) : [el('small.muted', { text: empty })]));
    v.side.replaceChildren(el('div.tg-phead', el('b', { text: title }), el('button.tg-x', { title: 'Close', onclick: () => { v.side.replaceChildren(); v.side.classList.remove('show'); } }, icon('x'))), list);
    v.side.classList.add('show');
    v.panelList = list;
  }

  // ---------- sign in, name, crew ----------
  function signInBox(root) {
    const status = el('div.tg-signin');
    const go = el('button.btn.primary', { onclick: async () => {
      go.disabled = true;
      try {
        const s = await api('/auth/start', { method: 'POST' });
        navigator.clipboard?.writeText(s.code).catch(() => {});
        status.replaceChildren(
          el('p', { text: 'On GitHub, enter this code and tap Authorize:' }),
          el('div.tg-bigcode', { text: s.code }),
          el('div.row', el('button.btn.primary', { onclick: () => openLink(s.url) }, icon('external'), 'Open GitHub'),
            el('button.btn', { onclick: () => copy(s.code, 'Code copied') }, icon('copy'), 'Copy code')),
          el('small.muted', { text: 'The code is copied already. Waiting for GitHub…' }));
        openLink(s.url);
        let every = (s.interval || 5) * 1000;
        const until = Date.now() + (s.expires || 900) * 1000;
        while (Date.now() < until && status.isConnected) {
          await wait(every);
          const p = await api('/auth/poll', { method: 'POST', body: { device: s.device } });
          if (p.wait) { if (p.interval) every = p.interval * 1000; continue; }
          setCfg({ token: p.token, user: p.user, crew: null });
          K.toast('Signed in as ' + p.user.login, 'ok');
          await refresh().catch(() => {});
          setCfg({ named: false });
          route(); return;
        }
        if (status.isConnected) throw new Error('The code ran out. Try again.');
      } catch (e) { K.toast(e.message, 'error'); status.replaceChildren(); go.disabled = false; }
    } }, icon('users'), 'Sign in with GitHub');
    root.append(el('div.tg-setup.glass',
      el('h3', { text: 'Read together with friends' }),
      el('p.muted', { text: 'A little Discord inside Koru: your friends\' Koru follows your page as you scroll, plus a chat with replies, reactions, memes, pictures and voice messages, and profiles.' }),
      el('p.muted', { text: 'Everyone signs in with GitHub (free), so nobody can pretend to be someone else. Koru never sees your password.' }),
      el('div.row', { style: { marginTop: '12px' } }, go, el('button.btn', { onclick: () => openLink('https://github.com/signup') }, icon('plus'), 'Make a GitHub account')),
      status,
      el('details', { style: { marginTop: '14px' } }, el('summary.muted', { text: 'Server' }), el('div.ctl', el('input.txt', { type: 'text', value: server(), spellcheck: false, onchange: e => setCfg({ server: e.target.value.trim() }) })))));
  }
  function nameBox(root, after) {
    const input = el('input.txt', { type: 'text', value: me()?.name || '', maxLength: 32, placeholder: 'Your name' });
    const save = el('button.btn.primary', { onclick: async () => {
      const n = input.value.trim(); if (!n) { input.focus(); return; }
      save.disabled = true;
      try { const j = await api('/me/name', { method: 'POST', body: { name: n } }); setCfg({ user: j.user, named: true }); T.crews = j.crews; K.toast('Hi, ' + n, 'ok'); after(); }
      catch (e) { K.toast(e.message, 'error'); save.disabled = false; }
    } }, icon('check'), 'Save');
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
    root.append(el('div.tg-setup.glass', el('h3', { text: 'What should your crew call you?' }),
      el('p.muted', { text: 'Signed in with GitHub as ' + me()?.login + '. Pick the name your friends see; you can change it any time, along with your picture, banner and the rest of your profile.' }),
      el('div.lookbar', input, save)));
    setTimeout(() => input.focus(), 50);
  }
  function crewBox(root) {
    const name = el('input.txt', { type: 'text', placeholder: 'Crew name, e.g. Night readers', maxLength: 40 });
    const make = el('button.btn.primary', { onclick: async () => {
      make.disabled = true;
      try { const c = await api('/crews', { method: 'POST', body: { name: name.value.trim() || 'Crew' } }); disconnect(); setCfg({ crew: c.id }); T.msgs = []; ls.set(CACHE, []); ls.set(SEEN, 0); await refresh(); K.toast('Crew made. Now add your friends by their GitHub username.', 'ok'); route(); }
      catch (e) { K.toast(e.message, 'error'); make.disabled = false; }
    } }, icon('plus'), 'Make a crew');
    root.append(el('div.tg-setup.glass',
      el('h3', { text: 'Make a crew, or get added to one' }),
      el('div.lookbar', name, make),
      el('div.tg-or', { text: 'or ask a friend to add you. Your GitHub username is:' }),
      el('div.row', { style: { alignItems: 'center' } }, el('code.tg-login', { text: me()?.login || '' }),
        el('button.btn.small', { onclick: () => copy(me()?.login || '') }, icon('copy'), 'Copy'),
        el('button.btn.small', { onclick: async () => { try { await refresh(); route(); if (!T.crew) K.toast('Not added to a crew yet.'); } catch (e) { K.toast(e.message, 'error'); } } }, icon('refresh'), 'Check again'))));
  }

  K.views.chat = async function (root, r, alive) {
    if (signedIn() && !T.crews) { root.append(el('div.spinner', { style: { margin: '20vh auto' } })); try { await refresh(); } catch (e) { root.replaceChildren(K.errorBox(e)); return; } if (!alive()) return; root.replaceChildren(); }
    else if (signedIn() && Date.now() - lastRefresh > 5000) { lastRefresh = Date.now(); refresh().then(j => { if (j && alive() && (j.crews.length !== (T.crewsShown ?? j.crews.length))) route(); }).catch(() => {}); }
    T.crewsShown = T.crews?.length;
    if (!signedIn()) { root.append(el('div.head', el('div', el('h1', { text: 'Read together' }), el('div.sub', { text: 'Koru Together' })))); signInBox(root); return; }
    if (cfg().named === false) { nameBox(root, route); return; }
    if (!inCrew() || !T.crew || T.makeNew) { T.makeNew = false; root.append(el('div.head', el('div', el('h1', { text: 'Read together' })), el('div.sp'), el('button.btn.icon', { title: 'You', onclick: e => youMenu(e) }, icon('settings')))); crewBox(root); return; }

    const owner = T.crew.owner === meId();
    const status = el('small.tg-status');
    const top = el('div.tg-top',
      el('div.tg-title', el('b', { text: '# ' + T.crew.name }), status),
      el('div.sp'),
      T.crews?.length > 1 ? el('select.tg-pick', { title: 'Switch crew', onchange: e => { setCfg({ crew: e.target.value }); disconnect(); T.msgs = []; ls.set(CACHE, []); ls.set(SEEN, 0); refresh().then(route); } },
        ...T.crews.map(c => el('option', { value: c.id, selected: c.id === cfg().crew, text: c.name }))) : null,
      el('button.btn.icon', { title: 'Pinned messages', onclick: () => send({ t: 'pins' }) || K.toast('Not connected', 'error') }, icon('pin')),
      el('button.btn.icon', { title: 'Bookmarks', onclick: () => showPanel('Bookmarks', bookmarks().filter(x => x.crew === cfg().crew), 'No bookmarks yet. Bookmark a message from its menu.') }, icon('bookmark')),
      el('div.tg-search', icon('search'), el('input', { type: 'text', placeholder: 'Search', onkeydown: e => { if (e.key === 'Enter' && e.target.value.trim().length >= 2) send({ t: 'search', q: e.target.value.trim() }); } })),
      owner ? el('button.btn.small', { onclick: () => addPerson(top) }, icon('plus'), 'Add person') : null,
      el('button.tg-me', { title: 'Your profile and status', onclick: e => youMenu(e) }, face({ ...me(), presence: T.profile?.status === 'invisible' ? 'offline' : T.profile?.status || 'online' }, '', true)));
    const head = el('div.tg-members'), reading = el('div.tg-reading'), list = el('div.tg-list'), typing = el('div.tg-typing'), side = el('div.tg-side.glass');
    const present = el('button.btn.small.primary.tg-present', { onclick: jumpPresent }, 'Jump to present');
    const input = el('textarea.tg-in', { rows: 1, placeholder: 'Message #' + T.crew.name, maxLength: 4000 });
    let typT = 0;
    const doSend = () => {
      const text = input.value.trim();
      if (T.editing) { if (text && text !== T.editing.text) sendOrQueue({ t: 'edit', id: T.editing.id, text }); cancelEdit(); return; }
      if (!text) return;
      input.value = ''; input.style.height = '';
      sendMsg({ kind: 'text', text });
      input.focus();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
      else if (e.key === 'Escape') { if (T.editing) cancelEdit(); else if (T.replyTo) { T.replyTo = null; paintCompose(); } }
      else if (e.key === 'ArrowUp' && !input.value) { const m = [...T.msgs].reverse().find(x => x.user === meId() && x.kind === 'text' && x.id && !x.deleted); if (m) { e.preventDefault(); startEdit(m); } }
    });
    input.addEventListener('input', () => {
      input.style.height = ''; input.style.height = Math.min(160, input.scrollHeight) + 'px';
      if (Date.now() - typT > 2500 && input.value.trim()) { typT = Date.now(); send({ t: 'typing' }); }
    });
    input.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); sendPictures(files); } });
    const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, style: { display: 'none' }, onchange: () => { sendPictures([...fileIn.files]); fileIn.value = ''; } });
    const shareLast = () => {
      const h = Object.values(K.data.history || {}).filter(x => x?.provider && K.providers[x.provider]).sort((a, b) => b.at - a.at)[0];
      if (!h) { K.toast('Read something first, then share it here.'); return; }
      sendMsg({ kind: 'share', text: '', data: { provider: h.provider, slug: h.slug, title: h.title, cover: h.cover || null, chapterSlug: h.chapterSlug, chapterName: h.chapterName || '' } });
    };
    const bar = el('div.tg-cbar');
    const compose = el('div.tg-compose.glass',
      el('button.btn.icon', { title: 'Send pictures or GIFs', onclick: () => fileIn.click() }, icon('image')), fileIn,
      el('button.btn.icon', { title: 'Share what you\'re reading', onclick: shareLast }, icon('book')),
      input,
      el('button.btn.icon', { title: 'Emoji', onclick: e => emojiPicker(e.currentTarget, em => { const s = input.selectionStart ?? input.value.length; input.value = input.value.slice(0, s) + em + input.value.slice(input.selectionEnd ?? s); input.focus(); input.selectionStart = input.selectionEnd = s + em.length; }) }, icon('smile')),
      el('button.btn.icon', { title: 'Meme stickers', onclick: e => stickerPicker(e.currentTarget) }, icon('sticker')),
      el('button.btn.icon.tg-mic', { title: 'Record a voice message', onclick: startVoice }, icon('mic')),
      el('button.btn.primary.icon', { title: 'Send', onclick: doSend }, icon('send')));
    const main = el('div.tg-main', reading, el('div.tg-listwrap', list, present), typing, bar, compose);
    const box = el('div.tg-chat', top, el('div.tg-cols', main, head, side));
    // drag pictures onto the chat to send them
    box.addEventListener('dragover', e => { if ([...(e.dataTransfer?.items || [])].some(i => i.type.startsWith('image/'))) { e.preventDefault(); box.classList.add('drop'); } });
    box.addEventListener('dragleave', e => { if (e.target === box) box.classList.remove('drop'); });
    box.addEventListener('drop', e => { box.classList.remove('drop'); const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); sendPictures(files); } });
    root.append(box);
    T.view = { head, reading, list, typing, input, bar, compose, side, status, present, scrolled: false };
    T.members = T.members.length ? T.members : (T.crew.members || []);
    list.addEventListener('scroll', () => { if (list.scrollTop < 60 && T.hasOlder && T.msgs[0]?.id && !list._asked) { list._asked = true; send({ t: 'older', before: T.msgs[0].id }); setTimeout(() => { list._asked = false; }, 1200); } }, { passive: true });
    if (T.state === 'off') connect();
    paintAll();
    setTimeout(() => input.focus(), 50);
  };
  function addPerson(top) {
    const v = T.view; const old = document.querySelector('.tg-add'); if (old) { old.remove(); return; }
    const login = el('input.txt', { type: 'text', placeholder: 'Their GitHub username', spellcheck: false, autocomplete: 'off' });
    const add = el('button.btn.primary', { onclick: async () => {
      const l = login.value.trim(); if (!l) { login.focus(); return; }
      add.disabled = true;
      try { const c = await api(`/crews/${T.crew.id}/members`, { method: 'POST', body: { login: l } }); T.crew = c; K.toast('Added. They\'ll see the crew once they sign in to Koru with GitHub.', 'ok'); login.value = ''; }
      catch (er) { K.toast(er.message, 'error'); }
      add.disabled = false;
    } }, icon('plus'), 'Add');
    login.addEventListener('keydown', ev => { if (ev.key === 'Enter') add.click(); });
    top.after(el('div.tg-add.glass', el('span.muted', { text: 'Add a friend by their GitHub username. They sign in to Koru with that GitHub account and the crew shows up.' }), el('div.lookbar', login, add)));
    setTimeout(() => login.focus(), 30); void v;
  }

  // ---------- you: status, profile, sign out ----------
  function youMenu(ev) {
    const st = T.profile?.status || 'online';
    const set = async s => { close(); try { const j = await api('/me/profile', { method: 'POST', body: { status: s } }); T.profile = j.profile; route(); } catch (e) { K.toast(e.message, 'error'); } };
    const owner = T.crew && T.crew.owner === meId();
    const item = (ic, label, fn, cls = '') => el('button.tg-mi' + cls, { onclick: () => { close(); fn(); } }, ic ? icon(ic) : null, el('span', { text: label }));
    const m = el('div.menu.glass.tg-ctx.tg-you',
      el('div.tg-youhead', face({ ...me(), presence: st === 'invisible' ? 'offline' : st }, '.big', true), el('div', el('b', { text: me()?.name || '' }), el('small.muted', { text: '@' + (me()?.login || '') }))),
      el('hr'),
      ...['online', 'idle', 'dnd', 'invisible'].map(s => el('button.tg-mi' + (s === st ? '.cur' : ''), { onclick: () => set(s) }, el('i.tg-dot.inline.' + (s === 'invisible' ? 'offline' : s)), el('span', { text: PRESENCE[s] }))),
      el('hr'),
      item('pencil', 'Edit Profile', editProfile),
      item('users', 'View Profile', () => showProfile(meId(), ev.currentTarget || document.body)),
      T.crew && owner ? item('pencil', 'Rename Crew', () => {
        const box = el('div.menu.glass.tg-ctx', el('small.muted', { text: 'Crew name' }));
        const inp = el('input.txt', { type: 'text', value: T.crew.name, maxLength: 40 });
        const save = async () => { const n = inp.value.trim(); if (!n) return; box.remove(); try { const c = await api(`/crews/${T.crew.id}`, { method: 'POST', body: { name: n } }); T.crew.name = c.name; K.toast('Renamed to ' + c.name, 'ok'); await refresh(); route(); } catch (e) { K.toast(e.message, 'error'); } };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') box.remove(); });
        box.append(el('div.tg-rename', inp, el('button.btn.small.primary', { onclick: save }, 'Save')));
        const r = ev.currentTarget?.getBoundingClientRect?.() || { right: innerWidth - 20, bottom: 80 };
        placeMenu(box, r.right - 260, r.bottom + 6); setTimeout(() => { inp.focus(); inp.select(); }, 30);
      }) : null,
      T.crew ? item('x', 'Leave Crew', async () => {
        const others = T.members.filter(x => x.id !== meId());
        const msg = !owner ? 'Leave ' + T.crew.name + '? Someone in it can add you again.'
          : others.length ? 'Leave ' + T.crew.name + '? ' + others[0].name + ' becomes its owner, and the chat stays with them.'
          : 'Leave ' + T.crew.name + "? You're the only one in it, so the crew and its chat will be deleted.";
        if (!confirm(msg)) return;
        T.leaving = true;
        try { await api(`/crews/${T.crew.id}/members/${meId()}`, { method: 'DELETE' }); } catch (e) { T.leaving = false; K.toast(e.message, 'error'); return; }
        K.toast('You left ' + T.crew.name);
        disconnect(); T.leaving = false; setCfg({ crew: null }); T.crew = null; T.crews = null; T.msgs = []; ls.set(CACHE, []); refresh().finally(route);
      }) : null,
      T.crew && owner ? item('trash', 'Delete Crew', async () => {
        if (!confirm('Delete ' + T.crew.name + " for everyone? The chat is deleted too. This can't be undone.")) return;
        T.leaving = true;
        try { await api(`/crews/${T.crew.id}`, { method: 'DELETE' }); } catch (e) { T.leaving = false; K.toast(e.message, 'error'); return; }
        K.toast(T.crew.name + ' deleted');
        disconnect(); T.leaving = false; setCfg({ crew: null }); T.crew = null; T.crews = null; T.msgs = []; ls.set(CACHE, []); refresh().finally(route);
      }, '.danger') : null,
      T.crew ? item('plus', 'Make Another Crew', () => { T.makeNew = true; route(); }) : null,
      el('hr'),
      item('back', 'Sign Out', async () => { try { await api('/auth/signout', { method: 'POST' }); } catch {} signOutLocal(); route(); }, '.danger'));
    const r = ev.currentTarget.getBoundingClientRect();
    placeMenu(m, r.right - 240, r.bottom + 6);
    function close() { m.remove(); }
  }

  // ---------- profile card ----------
  const profCache = new Map();
  async function showProfile(id, anchor) {
    document.querySelector('.tg-prof')?.remove();
    id = Number(id);
    const base = member(id) || { id, name: nameOf(id) };
    const box = el('div.tg-prof.glass', el('div.spinner', { style: { margin: '60px auto' } }));
    const r = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 170, right: innerWidth / 2 + 170, top: 100, bottom: 100 };
    placeMenu(box, r.right + 10 + 340 > innerWidth ? r.left - 350 : r.right + 10, r.top - 40);
    let p;
    try { p = id === meId() && T.profile ? T.profile : (profCache.get(id) && Date.now() - profCache.get(id).at < 60e3 ? profCache.get(id).p : (await api(`/users/${id}/profile`))); profCache.set(id, { p, at: Date.now() }); }
    catch (e) { box.replaceChildren(el('p.muted', { style: { padding: '20px' }, text: e.message })); return; }
    if (!box.isConnected) return;
    box.replaceChildren(...profileCard({ ...p, presence: base.presence || (id === meId() ? (p.status === 'invisible' ? 'offline' : p.status) : 'offline') }, id));
    placeMenu(box, parseFloat(box.style.left), parseFloat(box.style.top));
  }
  T.showProfile = showProfile;
  function profileCard(p, id, preview) {
    const s = p.stats || {};
    const reading = T.rt[String(id)]?.pos || (id === meId() && T.hosting ? K.readerPos?.() : null);
    const banner = el('div.tg-banner', { style: { background: p.color || `hsl(${hue(id)} 45% 35%)` } }, p.banner ? el('img', { src: p.banner, alt: '' }) : null);
    return [
      banner,
      el('div.tg-pav', face({ ...p, id }, '.huge', true)),
      el('div.tg-pbody',
        el('div.tg-pname', el('b', { text: p.name }), id === meId() && !preview ? el('button.btn.small', { onclick: () => { document.querySelector('.tg-prof')?.remove(); editProfile(); } }, icon('pencil'), 'Edit Profile') : null),
        el('div.tg-plogin', el('span', { text: p.login || '' }), p.pronouns ? el('span', { text: ' • ' + p.pronouns }) : null),
        p.custom ? el('div.tg-pcustom', { text: p.custom }) : null,
        s.badges?.length ? el('div.tg-pbadges', ...s.badges.slice(0, 12).map(b => el('span', { title: b.name, text: b.e })), s.badges.length > 12 ? el('small', { text: '+' + (s.badges.length - 12) }) : null) : null,
        el('div.tg-pstats',
          el('div', el('b', { text: '🔥 ' + (s.streak || 0) }), el('small', { text: 'day streak' })),
          el('div', el('b', { text: String(s.chapters || 0) }), el('small', { text: 'chapters' })),
          el('div', el('b', { text: (s.hours || 0) + 'h' }), el('small', { text: 'reading' }))),
        reading ? el('div.tg-psec', el('small', { text: 'READING NOW' }), card(reading, 'Open'), id !== meId() && T.rt[String(id)] ? el('button.btn.small.primary', { onclick: () => { document.querySelector('.tg-prof')?.remove(); follow(id); } }, icon('users'), 'Read with them') : null)
          : s.reading ? el('div.tg-psec', el('small', { text: 'LAST READ TOGETHER' }), el('span', { text: s.reading.title + ' · ' + s.reading.chapterName })) : null,
        p.bio ? el('div.tg-psec', el('small', { text: 'ABOUT ME' }), el('p', { text: p.bio })) : null,
        s.top?.length ? el('div.tg-psec', el('small', { text: 'TOP SERIES' }), el('div.tg-ptop', ...s.top.map(t => el('button', { title: t.title, onclick: () => { if (K.providers[t.provider]) { document.querySelector('.tg-prof')?.remove(); K.go(`/series/${t.provider}/${encodeURIComponent(t.slug)}`); } } },
          t.cover ? el('img', { src: t.cover, alt: '', loading: 'lazy' }) : el('div.tg-nocv', icon('book')), el('span', { text: t.title }))))) : null,
        p.joined ? el('div.tg-psec', el('small', { text: 'KORU MEMBER SINCE' }), el('span', { text: new Date(p.joined).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })) : null)];
  }

  // ---------- profile editor ----------
  async function editProfile() {
    document.querySelector('.tg-editp')?.remove();
    try { const j = await api('/me'); T.profile = j.profile; setCfg({ user: j.user }); } catch {}   // the latest, also from your other device
    const p = { ...me(), ...(T.profile || {}) };
    const draft = { name: p.name || '', pronouns: p.pronouns || '', bio: p.bio || '', custom: p.custom || '', status: p.status || 'online', color: p.color || '#5865f2', avatar: p.avatar || null, banner: p.banner || null };
    const preview = el('div.tg-prof.tg-preview.glass');
    const paint = () => preview.replaceChildren(...profileCard({ ...p, ...draft, presence: draft.status === 'invisible' ? 'offline' : draft.status }, meId(), true));
    const field = (label, node) => el('div.tg-field', el('small', { text: label }), node);
    const txt = (k, max, ph) => { const i = el('input.txt', { type: 'text', value: draft[k], maxLength: max, placeholder: ph || '', oninput: () => { draft[k] = i.value; paint(); } }); return i; };
    const bio = el('textarea.txt', { rows: 4, maxLength: 300, placeholder: 'Say something about yourself', oninput: () => { draft.bio = bio.value; paint(); } }); bio.value = draft.bio;
    const pickFile = (k, w) => {
      const fi = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: { display: 'none' }, onchange: async () => {
        const f = fi.files[0]; fi.value = ''; if (!f) return;
        btn.disabled = true; btn.textContent = 'Uploading…';
        try {
          let blob = f;
          // still pictures are resized; GIFs and WebPs stay as they are so animated ones keep moving
          if (f.type !== 'image/gif' && f.type !== 'image/webp') { const bmp = await createImageBitmap(f); const kk = Math.min(1, w / bmp.width); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * kk); c.height = Math.round(bmp.height * kk); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.9)) || f; }
          const u = await upload(blob, blob.type || f.type); draft[k] = u.url; paint();
        } catch (e) { K.toast(e.message, 'error'); }
        btn.disabled = false; btn.replaceChildren(icon('image'), 'Change');
      } });
      const btn = el('button.btn.small', { onclick: () => fi.click() }, icon('image'), 'Change');
      return el('div.row', btn, fi, el('button.btn.small', { onclick: () => { draft[k] = null; paint(); } }, icon('x'), 'Remove'), el('small.muted', { text: 'PNG, JPG, or animated GIF / WebP, 14 MB at most' }));
    };
    const color = el('input', { type: 'color', value: draft.color, oninput: () => { draft.color = color.value; paint(); } });
    const status = el('select.txt', { onchange: () => { draft.status = status.value; paint(); } }, ...['online', 'idle', 'dnd', 'invisible'].map(s => el('option', { value: s, selected: s === draft.status, text: PRESENCE[s] })));
    const save = el('button.btn.primary', { onclick: async () => {
      if (!draft.name.trim()) { K.toast('Type a name', 'error'); return; }
      save.disabled = true;
      try {
        const j = await api('/me/profile', { method: 'POST', body: { name: draft.name.trim(), pronouns: draft.pronouns, bio: draft.bio, custom: draft.custom, status: draft.status, color: draft.color, avatar: draft.avatar, banner: draft.banner } });
        T.profile = j.profile; setCfg({ user: j.user }); profCache.delete(meId()); K.toast('Profile saved', 'ok'); wrap.remove(); route();
      } catch (e) { K.toast(e.message, 'error'); save.disabled = false; }
    } }, icon('check'), 'Save Changes');
    const wrap = el('div.tg-editp', { onclick: e => { if (e.target === wrap) wrap.remove(); } },
      el('div.tg-editbox.glass',
        el('div.tg-edithead', el('h3', { text: 'Profile' }), el('button.tg-x', { title: 'Close', onclick: () => wrap.remove() }, icon('x'))),
        el('div.tg-editcols',
          el('div.tg-editform',
            field('DISPLAY NAME', txt('name', 32)),
            field('PRONOUNS', txt('pronouns', 30, 'e.g. she/her')),
            field('PROFILE PICTURE', pickFile('avatar', 512)),
            field('BANNER', pickFile('banner', 1200)),
            field('BANNER COLOUR (when there\'s no banner picture)', color),
            field('ABOUT ME', bio),
            field('CUSTOM STATUS', txt('custom', 80, 'e.g. binging Solo Leveling 📚')),
            field('STATUS', status),
            el('small.muted', { text: 'Your streak, badges, chapters and top series are added from Koru by itself.' }),
            el('div.row', { style: { marginTop: '12px' } }, save, el('button.btn', { onclick: () => wrap.remove() }, 'Cancel'))),
          el('div.tg-editprev', el('small', { text: 'PREVIEW' }), preview))));
    document.body.append(wrap);
    paint();
    const esc = e => { if (e.key === 'Escape' && wrap.isConnected) { wrap.remove(); document.removeEventListener('keydown', esc, true); } };
    document.addEventListener('keydown', esc, true);
  }
  T.editProfile = editProfile;

  window.addEventListener('hashchange', () => { if (!(location.hash.slice(1) || '').startsWith('/chat')) T.view = null; });
  document.addEventListener('koru-ready', () => { if (signedIn()) setTimeout(() => refresh().catch(() => {}), 600); badge(); scheduleReminders(); });
  // check for crews you've been added to: every minute while Koru is open (one small request)
  let lastRefresh = 0;
  setInterval(() => {
    if (!signedIn() || document.hidden) return;
    const before = T.crews?.length;
    lastRefresh = Date.now();
    refresh().then(j => { if (j && j.crews.length !== before && (location.hash.slice(1) || '').startsWith('/chat')) route(); }).catch(() => {});
  }, 60000);
})();
