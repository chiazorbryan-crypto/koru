// Koru voice reader: reads the speech bubbles on screen aloud with free voices that run on this PC,
// including your own cloned voice. The voice engine (voice/server.py) finds the bubbles (OCR) and speaks
// them; this file picks what's on screen, highlights each bubble as it's read and scrolls along.
'use strict';
(function () {
  const { el, icon } = K;
  const DEF = { voice: '', speed: 1 };
  K.voiceSettings = () => ({ ...DEF, ...(K.data.settings.voice || {}) });
  const setV = patch => { K.data.settings.voice = { ...K.voiceSettings(), ...patch }; K.save('settings'); };
  let voicesCache = null;
  K.voiceList = async (fresh) => {
    if (voicesCache && !fresh) return voicesCache;
    const r = await fetch('/k/voice/voices');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Voice engine error');
    return (voicesCache = j.voices || []);
  };
  K.voiceStatus = () => fetch('/k/voice/status').then(r => r.json());
  const tts = async (text, voice, speed) => {
    const r = await fetch('/k/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, speed }) });
    if (!r.ok) { let m = 'Couldn\'t speak'; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
    return URL.createObjectURL(await r.blob());
  };
  K.voicePreview = async (voice, speed) => { const u = await tts('Hi! This is how I sound reading your manhwa.', voice, speed); const a = new Audio(u); a.onended = () => URL.revokeObjectURL(u); await a.play(); };

  // ctx comes from the reader: { s, box, pagesBox, pg(i), fileOf(i), size(i), paged, rtl, step(d) }
  K.voiceReader = function (ctx) {
    const { s, pagesBox } = ctx;
    let on = false, paused = false, busy = false, audio = null, mark = null, cur = null;
    const queue = [], doneUntil = {};   // page -> how far down (in the page's own pixels) has been read
    let next = null;                    // the next bubble's audio, made while the current one plays
    let ahead = null, wantAhead = false; // the next screen's bubbles, found while this screen is read
    const vs = K.voiceSettings;

    const sel = el('select.sel-in', { title: 'Voice' });
    const fillVoices = async () => {
      try {
        const list = await K.voiceList();
        sel.replaceChildren(...list.map(v => el('option', { value: v.id, text: v.name + (v.kind === 'clone' ? ' (you)' : ''), selected: v.id === vs().voice })));
        if (!vs().voice && list[0]) setV({ voice: list[0].id });
      } catch (e) { sel.replaceChildren(el('option', { text: 'No voices' })); }
    };
    sel.onchange = () => { setV({ voice: sel.value }); next = null; };
    const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
    const spd = el('select.sel-in', { title: 'Speed' }, SPEEDS.map(v => el('option', { value: v, text: v + '×', selected: v === vs().speed })));
    spd.onchange = () => { setV({ speed: Number(spd.value) }); next = null; };
    const playB = el('button.btn.small.icon', { title: 'Pause or play (V)', onclick: () => toggle() });
    const stat = el('small.vstat', { text: 'Ready' });
    const pop = el('div.voicepop.glass', icon('voice'), el('div.vcol', el('b', { text: 'Read aloud' }), stat), sel, spd, playB,
      el('button.btn.small.icon', { title: 'Stop reading', onclick: () => stop() }, icon('x')));
    const paint = () => { playB.replaceChildren(icon(on && !paused ? 'pause' : 'play')); ctx.box.querySelector('.voiceb')?.classList.toggle('on', on); };
    const say = t => { stat.textContent = t; };

    // the part of each page that's on screen (or, with off > 0, the screen below it), cropped from the page
    // file and sent to the engine to find the bubbles
    async function scan(off = 0) {
      const H = pagesBox.clientHeight, top = pagesBox.scrollTop + off * H, found = [];
      const range = ctx.paged ? [s.page] : [s.page - 1, s.page, s.page + 1, s.page + 2];
      for (const i of range) {
        const w = ctx.pg(i), nat = ctx.size(i);
        if (!w || !nat) continue;
        let a = 0, b = nat[1];
        if (!ctx.paged) {
          const y0 = w.offsetTop - top, h = w.offsetHeight;
          if (!h || y0 >= H || y0 + h <= 0) continue;
          const k = nat[1] / h;
          a = Math.max(0, -y0) * k; b = Math.min(h, H - y0) * k;
        }
        a = Math.max(a, (doneUntil[i] || 0) - 4);
        if (b - a < 40) continue;
        const file = await ctx.fileOf(i);
        const scale = Math.min(1, 1100 / nat[0]);
        const bmp = await createImageBitmap(file, 0, Math.round(a), nat[0], Math.round(b - a), { resizeWidth: Math.round(nat[0] * scale), resizeHeight: Math.max(1, Math.round((b - a) * scale)) });
        const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
        const png = await new Promise(r => cv.toBlob(r, 'image/png'));
        const r = await fetch('/k/voice/ocr' + (ctx.rtl ? '?rtl=1' : ''), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Couldn\'t read the page');
        const cutAt = b < nat[1] - 4 ? cv.height - 6 : Infinity;   // a bubble cut off at the bottom waits for the next screen
        for (const bb of j.bubbles || []) {
          const [x, y, bw, bh] = bb.box;
          if (y + bh >= cutAt && y > 10) continue;
          const text = String(bb.text || '').trim();
          if (text.length < 2) continue;
          found.push({ i, text, x0: x / scale, x1: (x + bw) / scale, y0: a + y / scale, y1: a + (y + bh) / scale, nw: nat[0], nh: nat[1] });
        }
        if (!found.some(f => f.i === i)) doneUntil[i] = Math.max(doneUntil[i] || 0, b - 60);
      }
      return found;
    }
    function highlight(q) {
      mark?.remove();
      const w = ctx.pg(q.i);
      if (!w) return;
      mark = el('div.vmark', { style: { left: (q.x0 / q.nw * 100) + '%', top: (q.y0 / q.nh * 100) + '%', width: ((q.x1 - q.x0) / q.nw * 100) + '%', height: ((q.y1 - q.y0) / q.nh * 100) + '%' } });
      w.append(mark);
      if (!ctx.paged) {
        const H = pagesBox.clientHeight, y = w.offsetTop + q.y0 / q.nh * w.offsetHeight - pagesBox.scrollTop;
        if (y < H * 0.12 || y > H * 0.7) pagesBox.scrollTo({ top: pagesBox.scrollTop + y - H * 0.3, behavior: 'smooth' });
      }
    }
    const speak = q => tts(q.text, vs().voice, vs().speed);
    async function loop() {
      if (busy) return;
      busy = true;
      try {
        while (on && state() === s) {
          if (paused) { busy = false; return; }
          if (!queue.length) {
            say('Finding speech bubbles…');
            let f = ahead ? await ahead : null; ahead = null;
            f = (f || []).filter(q => (q.y0 + q.y1) / 2 > (doneUntil[q.i] || 0));
            if (!f.length) f = await scan();
            if (!on) break;
            if (f.length) { queue.push(...f); wantAhead = !ctx.paged; continue; }
            // nothing new on this screen: move on
            if (ctx.paged) { if (s.page >= s.pages.length - 1) { say('End of chapter'); stop(true); break; } ctx.step(1); await wait(700); continue; }
            const before = pagesBox.scrollTop;
            pagesBox.scrollTo({ top: before + pagesBox.clientHeight * 0.75, behavior: 'smooth' });
            await wait(900);
            if (Math.abs(pagesBox.scrollTop - before) < 4) { say('End of chapter'); stop(true); break; }
            continue;
          }
          cur = queue.shift();
          highlight(cur);
          say(cur.text.length > 60 ? cur.text.slice(0, 58) + '…' : cur.text);
          const url = await (next && next.q === cur ? next.p : speak(cur));
          next = queue[0] ? { q: queue[0], p: speak(queue[0]).catch(() => null) } : null;
          // once this screen is under way, look for the next screen's bubbles (after the next line's audio, so speech never waits)
          if (wantAhead) { wantAhead = false; ahead = scan(0.9).catch(() => null); }
          if (!on) { URL.revokeObjectURL(url); break; }
          if (url) {
            audio = new Audio(url);
            await new Promise(res => { audio.onended = res; audio.onerror = res; audio.onpause = () => { if (!paused) res(); }; audio.play().catch(res); });
            URL.revokeObjectURL(url);
            while (paused && on) await wait(150);
          }
          doneUntil[cur.i] = Math.max(doneUntil[cur.i] || 0, (cur.y0 + cur.y1) / 2);
        }
      } catch (e) { say(e.message); K.toast(e.message, 'error'); on = false; paint(); }
      finally { busy = false; }
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const state = () => ctx.state();
    function start() {
      if (!pop.isConnected) { ctx.box.append(pop); fillVoices(); }
      on = true; paused = false; paint(); loop();
    }
    function toggle() {
      if (!on) return start();
      paused = !paused;
      if (paused) { audio?.pause(); say('Paused'); } else { if (audio && !audio.ended && audio.currentTime > 0) audio.play(); loop(); }
      paint();
    }
    function stop(keepPop) {
      on = false; paused = false; queue.length = 0; next = null; ahead = null; wantAhead = false;
      try { audio?.pause(); } catch {}
      mark?.remove(); mark = null;
      if (!keepPop) pop.remove();
      paint();
    }
    // scrolling yourself skips ahead: anything above the new spot counts as read
    pagesBox.addEventListener('wheel', () => { if (on && !ctx.paged) { queue.length = 0; next = null; ahead = null; } }, { passive: true });
    return { toggle, stop, start };
  };
})();
