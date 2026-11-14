// Performance check (Settings → Graphics → Check performance). Opens the chapter you read last, scrolls it
// by itself for a few seconds three times (your settings, without ambient light, in light mode) and times
// every frame. Then it says what, if anything, is slowing this PC down and offers to change that one thing.
// Nothing is saved while it runs; your settings are put back exactly as they were.
'use strict';
(function () {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const html = document.documentElement;

  function target() {
    const h = Object.values(K.data.history || {}).filter(x => x?.provider && x.chapterSlug && K.providers[x.provider]).sort((a, b) => b.at - a.at)[0];
    return h ? `/read/${h.provider}/${encodeURIComponent(h.slug)}/${encodeURIComponent(h.chapterSlug)}` : '/read/omega/the-wicked-shaman/chapter-1';
  }
  async function scrollTimed(ms) {
    let pb = null;
    for (let i = 0; i < 80 && !(pb = document.querySelector('.reader .pages')); i++) await wait(150);
    if (!pb) throw new Error('The chapter didn\'t open. Check your connection and try again.');
    // let the first pages arrive, then start a little way in
    for (let i = 0; i < 40 && pb.scrollHeight < pb.clientHeight * 3; i++) await wait(200);
    pb.scrollTop = Math.min(400, pb.scrollHeight / 10); await wait(600);
    const gaps = []; let last = 0; const t0 = performance.now();
    await new Promise(res => {
      const step = t => {
        if (last) gaps.push(t - last); last = t;
        pb.scrollTop += 7;
        if (pb.scrollTop + pb.clientHeight >= pb.scrollHeight - 4) pb.scrollTop = 0;   // short chapter: go round again
        if (t - t0 < ms) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
    gaps.sort((a, b) => a - b);
    const avg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
    return { fps: Math.min(60, Math.round(1000 / avg)), slow: Math.round(gaps.filter(g => g > 25).length / Math.max(1, gaps.length) * 100), worst: Math.round(gaps[gaps.length - 1] || 0) };
  }

  K.perfCheck = async function (progress = () => {}) {
    if (K.perfChecking) return null;
    K.perfChecking = true;   // the reader's smooth guard stays out of the way while this runs
    const back = location.hash.slice(1) || '/settings', go = target();
    const saved = K.data.settings.reader ? JSON.parse(JSON.stringify(K.data.settings.reader)) : undefined;
    const lite0 = html.classList.contains('lite');
    const save0 = K.save; K.save = () => {};   // nothing is written while testing
    const inc0 = K.data.settings.incognito; K.data.settings.incognito = true;   // and nothing counts as reading (stats, history)
    const base = K.readerSettings();
    const steps = [
      ['Your settings', {}, lite0],
      ['Without ambient light', { ambient: false }, lite0],
      [lite0 ? 'Without light mode' : 'In light mode', {}, !lite0]
    ];
    const out = [];
    try {
      for (let i = 0; i < steps.length; i++) {
        const [label, patch, lite] = steps[i];
        progress(i + 1, steps.length, label);
        K.data.settings.reader = { ...base, ...patch, autoStart: false, zen: false, fps: false, countdown: false, autoDl: 0 };
        html.classList.toggle('lite', lite);
        K.go('/stats', true); await wait(500);
        K.go(go, true); await wait(i ? 1500 : 2500);
        out.push({ label, lite, ...(await scrollTimed(3500)) });
      }
    } finally {
      // leave the test chapter first: closing it saves a reading spot, which must still be "not counted"
      K.go(back, true);
      for (let i = 0; i < 20 && document.querySelector('.reader'); i++) await wait(100);
      await wait(400);
      if (saved === undefined) delete K.data.settings.reader; else K.data.settings.reader = saved;
      html.classList.toggle('lite', lite0);
      if (inc0 === undefined) delete K.data.settings.incognito; else K.data.settings.incognito = inc0;
      K.save = save0;
      K.perfChecking = false;

    }
    // what to suggest
    const [mine, noAmb, other] = out, good = r => r.fps >= 57 && r.slow <= 3;
    let tip = null;
    if (good(mine)) tip = { text: 'Smooth. Nothing to change.' };
    else if (!lite0 && good(other) && other.fps - mine.fps >= 4) tip = { text: 'Light mode makes this PC smooth. Your ambient light stays on in light mode.', action: 'lite-on', label: 'Turn on light mode' };
    else if (noAmb.fps - mine.fps >= 5 && base.ambient && base.ambMode !== 'page') tip = { text: 'The ambient light following the screen costs this PC frames. Once per page is lighter and looks nearly the same.', action: 'amb-page', label: 'Ambient once per page' };
    else if (lite0 && good(other)) tip = { text: 'This PC is smooth without light mode too, so you could turn it off for the full glass look.', action: 'lite-off', label: 'Turn off light mode' };
    else tip = { text: 'Reading still drops some frames with every setting, so it isn\'t Koru\'s effects. Big pages or a busy PC (other apps, power saving) are the usual cause.' };
    return { runs: out, tip };
  };
  K.perfApply = action => {
    if (action === 'lite-on') K.setLite('on');
    else if (action === 'lite-off') K.setLite('off');
    else if (action === 'amb-page') { K.data.settings.reader = { ...K.readerSettings(), ambMode: 'page' }; K.save('settings'); }
  };
})();
