// Your Koru account (Settings → Library & sync): sign in with GitHub once, pick your name, and your library,
// history, read marks, ratings, notes, shelves and stats are saved to your account and come back on any PC or
// phone you sign in on. It's the same sign-in as Koru Together, so Chat works straight away too.
// Saving and merging is sync.js (each device keeps one file in your account); the server is together-server/.
'use strict';
(function () {
  const { el, icon } = K;
  const T = () => K.together;
  const signedIn = () => !!T()?.signedIn?.();
  const ago = t => { if (!t) return 'not yet'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString(); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const openLink = url => (K.native?.() ? K.api.post('/k/open-external', { url }).catch(() => window.open(url, '_blank')) : window.open(url, '_blank'));

  // GitHub's device sign-in (Koru shows a code, you type it on github.com/login/device)
  async function signIn(status) {
    const s = await T().api('/auth/start', { method: 'POST' });
    navigator.clipboard?.writeText(s.code).catch(() => {});
    status.replaceChildren(
      el('p', { text: 'On GitHub, enter this code and press Authorize:' }),
      el('div.tg-bigcode', { text: s.code }),
      el('div.row', el('button.btn.primary', { type: 'button', onclick: () => openLink(s.url) }, icon('external'), 'Open GitHub'),
        el('button.btn', { type: 'button', onclick: () => navigator.clipboard?.writeText(s.code).then(() => K.toast('Code copied', 'ok')) }, icon('copy'), 'Copy code')),
      el('small.muted', { text: 'The code is copied already. Waiting for GitHub…' }));
    openLink(s.url);
    let every = (s.interval || 5) * 1000;
    const until = Date.now() + (s.expires || 900) * 1000;
    while (Date.now() < until && status.isConnected) {
      await wait(every);
      const p = await T().api('/auth/poll', { method: 'POST', body: { device: s.device } });
      if (p.wait) { if (p.interval) every = p.interval * 1000; continue; }
      T().setCfg({ token: p.token, user: p.user, crew: null, named: false });
      await T().refresh().catch(() => {});
      return p.user;
    }
    throw new Error('The code ran out. Try again.');
  }

  function panel(mk) {
    const body = el('div.acct');
    const paint = () => {
      if (!signedIn()) return paintOut();
      if (T().cfg().named === false) return paintName();
      paintIn();
    };
    function paintOut() {
      const status = el('div.tg-signin');
      const go = el('button.btn.primary', { type: 'button', onclick: async () => {
        go.disabled = true;
        try { const u = await signIn(status); K.toast('Signed in as ' + u.login, 'ok'); paint(); }
        catch (e) { K.toast(e.message, 'error'); status.replaceChildren(); go.disabled = false; }
      } }, icon('users'), 'Sign in with GitHub');
      body.replaceChildren(
        el('p.muted', { text: 'Sign in once and your favourites, history, read marks, ratings, notes, shelves and stats are saved to your account. Sign in on another PC or your phone and it all comes back. Chat signs in with it too.' }),
        el('div.row', go, el('button.btn', { type: 'button', onclick: () => openLink('https://github.com/signup') }, icon('plus'), 'Make a GitHub account')),
        status,
        el('small.muted', { text: 'GitHub is free. Koru never sees your password.' }));
    }
    // the name people see in Chat, picked once (changeable any time in your profile)
    function paintName() {
      const me = T().me();
      const input = el('input.txt', { type: 'text', value: me?.name || me?.login || '', maxLength: 32, placeholder: 'Your name' });
      const save = el('button.btn.primary', { type: 'button', onclick: async () => {
        const n = input.value.trim(); if (!n) { input.focus(); return; }
        save.disabled = true;
        try {
          const j = await T().api('/me/name', { method: 'POST', body: { name: n } });
          T().setCfg({ user: j.user, named: true });
          K.toast('Hi, ' + n + '! Saving your library to your account…', 'ok');
          K.sync?.start(); await K.sync?.now(true).catch(() => {});
          paint();
        } catch (e) { K.toast(e.message, 'error'); save.disabled = false; }
      } }, icon('check'), 'Save');
      input.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
      body.replaceChildren(el('p', { text: `Signed in as @${me?.login}. Pick your name: it's what friends see in Chat.` }), el('div.lookbar', input, save));
      setTimeout(() => input.focus(), 50);
    }
    function paintIn() {
      const me = T().me() || {};
      const on = K.data.settings.acctSync !== false;
      const state = el('small.muted');
      const paintState = () => { const err = K.sync?.account?.error?.(); state.textContent = !on ? 'Not saving to your account on this device.' : err ? 'Couldn\'t save just now: ' + err : 'Saved to your account · ' + ago(K.sync?.account?.at?.()); };
      paintState();
      const saveNow = el('button.btn.small', { type: 'button', onclick: async () => {
        saveNow.disabled = true; state.textContent = 'Saving…';
        try { const r = await K.sync.now(true); paintState(); K.toast(r?.changed?.length ? 'Saved, and brought in changes from your other devices' : 'Saved to your account', 'ok'); }
        catch (e) { state.textContent = 'Couldn\'t save: ' + e.message; }
        saveNow.disabled = false;
      } }, icon('refresh'), 'Save now');
      const out = el('button.btn.small', { type: 'button', onclick: () => {
        if (!out.classList.contains('sure')) { out.classList.add('sure'); out.lastChild.textContent = 'Click again to sign out'; setTimeout(() => { if (out.isConnected) { out.classList.remove('sure'); out.lastChild.textContent = 'Sign out'; } }, 4000); return; }
        T().signOut(); K.toast('Signed out. Your library stays on this device.', 'ok'); paint();
      } }, icon('logout'), el('span', { text: 'Sign out' }));
      body.replaceChildren(
        el('div.acct-me', me.avatar ? el('img.acct-ava', { src: me.avatar, alt: '' }) : el('span.acct-ava'), el('div', el('b', { text: me.name || me.login || '' }), el('small.muted', { text: '@' + (me.login || '') + ' · GitHub' }))),
        state,
        el('label.acct-tgl', el('input', { type: 'checkbox', checked: on, onchange: e => { K.data.settings.acctSync = e.target.checked; K.save('settings'); if (e.target.checked) { K.sync?.start(); K.sync?.now(true).catch(() => {}); } paint(); } }),
          el('span', { text: 'Save my library and history to my account' })),
        el('div.row', saveNow, out));
      clearInterval(body._t); body._t = setInterval(() => { if (!body.isConnected) clearInterval(body._t); else paintState(); }, 30e3);
    }
    paint();
    return mk('users', 'Your Koru account', '', body);
  }

  K.account = { panel, signedIn };
})();
