// Koru liveliness: the fox's moods (sleeps when Koru sits idle, perks up at new chapters, cheers when you
// finish a chapter), reading streaks and badges with a small celebration. Settings → Motion turns it off.
// Smoothness: only transform/opacity animate (lively.css); nothing here reads layout or runs per frame.
'use strict';
(function () {
  const { el } = K;
  const on = () => K.data.settings.lively !== false;
  const lite = () => document.documentElement.classList.contains('lite') || document.documentElement.classList.contains('nogpu');
  const reading = () => document.documentElement.classList.contains('reading');
  const logo = () => document.querySelector('.side-logo');

  // ---------- the fox's moods ----------
  let moodT = 0, sleeping = false, lastInput = Date.now();
  function mood(name, ms = 1200) {
    const l = logo(); if (!l || !on()) return;
    if (name !== 'sleep') wake(true);
    l.classList.remove('wake', 'perk', 'cheer');
    void l.offsetWidth;   // restart the animation (one tiny element, only on a mood change)
    l.classList.add(name);
    clearTimeout(moodT); moodT = setTimeout(() => l.classList.remove(name), ms);
  }
  function sparks(n = 8) {
    const l = logo(); if (!l || lite() || !on()) return;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, s = el('i.spark');
      s.style.setProperty('--dx', Math.round(Math.cos(a) * 30) + 'px'); s.style.setProperty('--dy', Math.round(Math.sin(a) * 30) + 'px');
      l.append(s); setTimeout(() => s.remove(), 900);
    }
  }
  function sleep() { const l = logo(); if (!l || sleeping || !on()) return; sleeping = true; l.classList.add('sleep'); }
  function wake(quiet) {
    if (!sleeping) return; sleeping = false;
    const l = logo(); if (!l) return;
    l.classList.remove('sleep');
    if (!quiet) mood('wake', 800);
  }
  const poke = () => { lastInput = Date.now(); if (sleeping) wake(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove']) window.addEventListener(ev, poke, { passive: true, capture: true });
  setInterval(() => { if (!document.hidden && !reading() && Date.now() - lastInput > 120000) sleep(); }, 10000);
  document.addEventListener('koru-new-chapters', () => { mood('perk', 1200); sparks(); });

  // the little fox that pops up in the reader when you finish a chapter
  function foxPop(title, sub) {
    if (!on()) return;
    document.querySelector('.foxpop')?.remove();
    const p = el('div.foxpop', el('div.fx', K.fox()), el('span', el('b', { text: title }), sub ? el('small', { text: ' · ' + sub }) : null));
    document.body.append(p);
    setTimeout(() => { p.classList.add('out'); setTimeout(() => p.remove(), 400); }, 2300);
  }

  // ---------- streaks ----------
  const day = d => K.dayKey(d);
  const readDay = (days, d) => (days[day(d)]?.ms || 0) >= 60000 || (days[day(d)]?.ch || 0) > 0;
  // Keeping a streak: 5 restores a month fill in days you missed, and a pause freezes it (days while paused don't break it).
  // Saved with your stats: stats.keep = { restored: { day: true }, pauses: [[fromDay, toDay|null]], used: { 'YYYY-MM': n } }
  const RESTORES = 5;
  const keep = () => { const k = (K.data.stats.keep ||= {}); k.restored ||= {}; k.pauses ||= []; k.used ||= {}; return k; };
  const monthKey = (d = new Date()) => day(d).slice(0, 7);
  const isPaused = k => keep().pauses.some(([a, b]) => k >= a && (!b || k <= b));
  const kept = (days, d) => readDay(days, d) || !!keep().restored[day(d)];
  function streak() {
    const days = (K.statsAll?.() || K.data.stats)?.days || {};   // with GitHub sync: both PCs
    const d = new Date(); d.setHours(12, 0, 0, 0);
    const today = kept(days, d);
    if (!today) d.setDate(d.getDate() - 1);
    let n = 0;
    for (let guard = 0; guard < 5000; guard++) {
      if (kept(days, d)) n++;
      else if (!isPaused(day(d))) break;   // a paused day: skipped, the streak carries on past it
      d.setDate(d.getDate() - 1);
    }
    const pausedNow = keep().pauses.some(([, b]) => !b);
    // days missed since the streak (yesterday backwards), which restores can fill in
    const missed = [];
    const m = new Date(); m.setHours(12, 0, 0, 0); m.setDate(m.getDate() - 1);
    while (missed.length < 8 && !kept(days, m) && !isPaused(day(m))) { missed.push(day(m)); m.setDate(m.getDate() - 1); }
    let before = 0; { const b = new Date(m); while (before < 5000 && (kept(days, b) || isPaused(day(b)))) { if (kept(days, b)) before++; b.setDate(b.getDate() - 1); } }
    const left = Math.max(0, RESTORES - (keep().used[monthKey()] || 0));
    const canRestore = missed.length > 0 && missed.length <= 7 && before > 0 && missed.length <= left;
    return { n, today, paused: pausedNow, missed, lost: before, left, canRestore };
  }
  function restoreStreak() {
    const s = streak();
    if (!s.canRestore) { K.toast(s.missed.length > s.left ? `You'd need ${s.missed.length} restores, and you have ${s.left} left this month.` : 'Nothing to restore.', 'error'); return; }
    const k = keep();
    for (const d of s.missed) k.restored[d] = true;
    k.used[monthKey()] = (k.used[monthKey()] || 0) + s.missed.length;
    K.save('stats');
    const now = streak();
    K.toast(`Streak restored: ${now.n} ${now.n === 1 ? 'day' : 'days'} 🔥 (${now.left} ${now.left === 1 ? 'restore' : 'restores'} left this month)`, 'ok');
    document.dispatchEvent(new CustomEvent('koru-streak'));
  }
  function pauseStreak(on) {
    const k = keep(), t = day(new Date());
    if (on) { if (!k.pauses.some(([, b]) => !b)) k.pauses.push([t, null]); K.toast('Streak paused ⏸ Days you skip won\'t break it until you resume.', 'ok'); }
    else {
      const p = k.pauses.find(([, b]) => !b);
      if (p) { const y = new Date(); y.setDate(y.getDate() - 1); if (p[0] >= t) k.pauses.splice(k.pauses.indexOf(p), 1); else p[1] = day(y); }
      K.toast('Streak resumed. Read today to keep it going 🔥', 'ok');
    }
    K.save('stats');
    document.dispatchEvent(new CustomEvent('koru-streak'));
  }
  function streakMenu(ev) {
    const s = streak();
    K.popMenu(ev, s.n ? `${s.n}-day streak` : 'Streak', [
      s.canRestore ? ['refresh', `Restore streak (uses ${s.missed.length} of ${s.left} left this month)`, restoreStreak] : null,
      s.paused ? ['play', 'Resume streak', () => pauseStreak(false)] : ['pause', 'Pause streak', () => pauseStreak(true)],
      !s.canRestore ? ['refresh', `${s.left} of ${RESTORES} restores left this month`, () => {}, 'muted'] : null
    ]);
  }
  function bestStreak(days, from, to) {
    const keys = Object.keys(days).filter(k => (!from || k >= from) && (!to || k <= to) && readDay(days, new Date(k + 'T12:00'))).sort();
    let best = 0, run = 0, prev = null;
    for (const k of keys) {
      const t = new Date(k + 'T12:00').getTime();
      run = prev != null && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1;
      best = Math.max(best, run); prev = t;
    }
    return best;
  }
  function streakChip() {
    const box = el('span.streak-box');
    const paint = () => {
      const s = streak();
      const kids = [];
      if (s.n || s.paused) {
        const label = s.paused ? `${s.n}-day streak · paused` : s.today ? `${s.n}-day streak` : `${s.n}-day streak · read today to keep it`;
        kids.push(el('button.streak' + (s.today || s.paused ? '' : '.cold') + (s.paused ? '.paused' : ''), { title: 'Your streak: restore or pause it', onclick: streakMenu },
          el('span.fl', { text: s.paused ? '⏸' : '🔥' }), el('span', { text: label })));
      }
      if (s.canRestore) kids.push(el('button.streak.restore', { title: `Fill in the ${s.missed.length === 1 ? 'day' : s.missed.length + ' days'} you missed`, onclick: restoreStreak },
        el('span.fl', { text: '🩹' }), el('span', { text: `Restore your ${s.lost}-day streak (${s.left} left)` })));
      if (s.n || s.paused) kids.push(el('button.streak.pausebtn', { title: s.paused ? 'Resume your streak' : 'Pause your streak: days you skip won\'t break it', onclick: () => pauseStreak(!s.paused) },
        el('span', { text: s.paused ? '▶ Resume streak' : '⏸ Pause streak' })));
      box.replaceChildren(...kids);
    };
    paint();
    const on = () => { if (box.isConnected) paint(); else document.removeEventListener('koru-streak', on); };
    document.addEventListener('koru-streak', on);
    return box;
  }

  // ---------- badges ----------
  const BADGES = [
    { id: 'first', e: '📖', name: 'First chapter', desc: 'Finish your first chapter', v: c => c.ch, goal: 1 },
    { id: 'ch10', e: '📚', name: 'Bookworm', desc: 'Finish 10 chapters', v: c => c.ch, goal: 10 },
    { id: 'ch100', e: '🏅', name: 'Century', desc: 'Finish 100 chapters', v: c => c.ch, goal: 100 },
    { id: 'ch500', e: '🏆', name: 'Devourer', desc: 'Finish 500 chapters', v: c => c.ch, goal: 500 },
    { id: 'ch1000', e: '👑', name: 'Legend', desc: 'Finish 1,000 chapters', v: c => c.ch, goal: 1000 },
    { id: 'streak3', e: '🔥', name: 'On fire', desc: 'Read 3 days in a row', v: c => c.best, goal: 3 },
    { id: 'streak7', e: '⚡', name: 'Week warrior', desc: 'Read 7 days in a row', v: c => c.best, goal: 7 },
    { id: 'streak30', e: '🌋', name: 'Unstoppable', desc: 'Read 30 days in a row', v: c => c.best, goal: 30 },
    { id: 'binge', e: '🍿', name: 'Binge', desc: '20 chapters in one day', v: c => c.dayCh, goal: 20 },
    { id: 'marathon', e: '🏃', name: 'Marathon', desc: '3 hours of reading in one day', v: c => c.dayMs / 36e5, goal: 3 },
    { id: 'night', e: '🦉', name: 'Night owl', desc: 'Finish a chapter between midnight and 4 am', v: c => c.night, goal: 1 },
    { id: 'early', e: '🌅', name: 'Early bird', desc: 'Finish a chapter between 5 and 7 am', v: c => c.early, goal: 1 },
    { id: 'explorer', e: '🧭', name: 'Explorer', desc: 'Read from 5 different sources', v: c => c.sources, goal: 5 },
    { id: 'collector', e: '💜', name: 'Collector', desc: 'Have 25 favourites', v: c => c.favs, goal: 25 },
    { id: 'caught', e: '✅', name: 'All caught up', desc: 'Read the newest chapter of a series', v: c => c.caught, goal: 1 },
    { id: 'finisher', e: '🎉', name: 'The end', desc: 'Finish the last chapter of a completed series', v: c => c.done, goal: 1 }
  ];
  function counts() {
    const st = (K.statsAll?.() || K.data.stats) || {}, days = st.days || {}, marks = st.marks || {};
    let ch = 0, dayCh = 0, dayMs = 0;
    for (const d of Object.values(days)) { ch += d.ch || 0; dayCh = Math.max(dayCh, d.ch || 0); dayMs = Math.max(dayMs, d.ms || 0); }
    const sources = new Set(Object.values(st.series || {}).filter(x => (x.ms || 0) >= 60000 || x.ch).map(x => x.provider)).size;
    return { ch, dayCh, dayMs, best: bestStreak(days), sources, favs: Object.keys(K.data.library || {}).length,
      night: marks.night || 0, early: marks.early || 0, caught: marks.caught || 0, done: marks.done || 0 };
  }
  // celebrate: false on start-up, so badges you already earned are just marked, without a party
  function checkBadges(celebrate) {
    if (K.incognito?.()) return;
    const st = K.data.stats; if (!st) return;
    const own = st.badges ||= {}, got = (K.statsAll?.() || K.data.stats).badges || own, c = counts(), fresh = [];   // a badge your other PC earned isn't celebrated again
    for (const b of BADGES) if (!got[b.id] && b.v(c) >= b.goal) { own[b.id] = Date.now(); fresh.push(b); }
    if (!fresh.length) return;
    K.save('stats');
    if (celebrate) fresh.forEach(b => queue(b));
  }
  // one celebration at a time, a moment apart
  const waiting = []; let showing = false;
  function queue(b, label) { waiting.push([b, label]); if (!showing) next(); }
  function next() { const it = waiting.shift(); if (!it) { showing = false; return; } showing = true; setTimeout(() => { celebrateBadge(it[0], it[1]); setTimeout(next, 3200); }, 400); }
  function celebrateBadge(b, label = 'Badge unlocked') {
    if (!on()) { K.toast(label + ': ' + b.name, 'ok'); return; }
    document.querySelector('.cele')?.remove();
    const em = el('div.em', { text: b.e });
    const c = el('div.cele', em, el('div', el('small', { text: label }), el('b', { text: b.name }), el('span.d', { text: b.desc })));
    if (!lite()) {
      const cols = ['var(--accent, #8f7dff)', 'var(--accent2, #38d6ff)', '#ff4f9a', '#ffd166', '#7cf0a0'];
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 60, f = el('i.conf');
        f.style.setProperty('--dx', Math.round(Math.cos(a) * d) + 'px'); f.style.setProperty('--dy', Math.round(Math.sin(a) * d) + 'px');
        f.style.setProperty('--r', Math.round(Math.random() * 720 - 360) + 'deg'); f.style.background = cols[i % cols.length]; f.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
        em.append(f);
      }
    }
    document.body.append(c);
    mood('cheer', 1100);
    setTimeout(() => { c.classList.add('out'); setTimeout(() => c.remove(), 450); }, 3000);
  }
  function badgesCard() {
    const got = (K.statsAll?.() || K.data.stats)?.badges || {}, c = counts();
    const n = BADGES.filter(b => got[b.id]).length;
    return el('div.chartcard.glass',
      el('div.badgehead', el('b', { text: 'Badges' }), el('small.muted', { text: `${n} of ${BADGES.length}` })),
      el('div.badges', ...BADGES.map(b => {
        const has = !!got[b.id], v = Math.min(b.goal, Math.floor(b.v(c) * 10) / 10);
        return el('div.badge' + (has ? '.got' : ''), { title: has ? 'Earned ' + new Date(got[b.id]).toLocaleDateString() : b.desc },
          el('div.em', { text: b.e }),
          el('div', el('b', { text: b.name }), el('small', { text: b.desc }),
            !has && b.goal > 1 ? el('div.prog', el('i', { style: { transform: `scaleX(${(v / b.goal).toFixed(3)})` } })) : null));
      })));
  }

  // ---------- hooks into reading stats ----------
  // reading time per hour of the day (for Wrapped's reading clock)
  const add0 = K.stats.add.bind(K.stats), chapter0 = K.stats.chapter.bind(K.stats);
  let lastCheck = 0;
  K.stats.add = function (s, ms) {
    const days = K.data.stats.days || {}, k = day(), before = days[k]?.ms || 0;
    add0(s, ms);
    const d = (K.data.stats.days || {})[k];
    if (d && d.ms > before) { const h = new Date().getHours(); (d.h ||= {})[h] = (d.h[h] || 0) + (d.ms - before); }
    if (Date.now() - lastCheck > 60000) { lastCheck = Date.now(); checkBadges(true); }   // streaks, marathon
  };
  K.stats.chapter = function (s) {
    const before = K.data.stats.days?.[day()]?.ch || 0;
    chapter0(s);
    if ((K.data.stats.days?.[day()]?.ch || 0) <= before) return;   // incognito or not counted
    const m = K.data.stats.marks ||= {}, h = new Date().getHours();
    if (h < 4) m.night = (m.night || 0) + 1;
    if (h >= 5 && h < 7) m.early = (m.early || 0) + 1;
    const newest = s.chapters?.find(c => !c.locked);
    if (newest && s.chapter && newest.slug === s.chapter.slug) {
      m.caught = (m.caught || 0) + 1;
      if (/complete|finish|ended/i.test(s.series?.status || '')) m.done = (m.done || 0) + 1;
    }
    K.save('stats');
    const { n } = streak();
    setTimeout(() => foxPop('Chapter done', n > 1 ? `${n}-day streak 🔥` : ''), 250);
    mood('cheer', 1100);
    checkBadges(true);
    // the series' own badge (read marks are saved right after this, so look a moment later)
    setTimeout(() => {
      const r = K.seriesBadges?.check(s);
      if (r) queue({ e: r.b.e, name: r.b.name, desc: r.kind === 'gold' ? 'Gold · ' + r.b.title : r.b.title }, r.kind === 'gold' ? 'Series badge turned gold' : 'Series badge unlocked');
    }, 120);
  };

  const applyOn = () => document.documentElement.classList.toggle('no-lively', !on());
  K.lively = { BADGES, queue, mood, sleep, wake, streak, streakChip, restoreStreak, pauseStreak, streakMenu, bestStreak, badgesCard, checkBadges, celebrateBadge, foxPop, applyOn };

  // the fox needs its z's; added once the sidebar logo exists
  const start = () => {
    applyOn();
    const l = logo();
    if (l && !l.querySelector('.zz')) l.append(el('span.zz', el('i', { text: 'z' }), el('i', { text: 'z' }), el('i', { text: 'Z' })));
    checkBadges(false);
  };
  document.addEventListener('koru-ready', start);
  setTimeout(start, 4000);
})();
